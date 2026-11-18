/**
 * PDF 整本翻译 → 双语对照 PDF 的完整流程（2026-11-17）
 * ==================================================================
 *
 * 把「打开 PDF → 点按钮 → 拿到双语 PDF 文件」这条链路的**执行部分**收在一处，
 * ReaderView 只负责触发、显示进度、落盘。
 *
 * ## 流程
 *   ① 抽取全文（pdf.js 逐页 getTextContent → 清洗 → 段落）
 *   ② 翻译（qwen-mt 通道；带缓存 + TPM 限流）
 *   ③ 生成双语 PDF（pdf-lib：原页左 + 译文右）
 *
 * ## 三条硬约束（都是实测踩出来的）
 *  - **扫描版 PDF 抽不出文字**（纯图片页 ⇒ 0 字）。这种 PDF 走不通，
 *    必须报错提示用户，而不是「翻译出 0 页」让人以为成功。
 *  - **qwen-mt-flash 的 TPM 是 35,000**（华北2）：不节流必然 429。
 *  - **字体必须是 TrueType(glyf)**：pdf-lib 遇到 CFF 轮廓会嵌成
 *    CIDFontType0，Chrome 画不出来（文本能提取但页面空白）。
 */

import {
  itemsToLinesWithGaps,
  isTranslatableParagraph,
  paragraphsFromLines,
} from "./pdf-extract.ts";
import {
  translatePdfSegments,
  type PdfSegment,
  type PdfTranslateDeps,
} from "./pdf-translate-orchestrator.ts";
import { buildBilingualPdf } from "./pdf-bilingual-runtime.ts";
import type { BilingualLayout } from "./pdf-bilingual.ts";

/** 流程的输入 */
export interface PdfTranslateInput {
  /** 原 PDF 字节 */
  originalBytes: Uint8Array;
  /** 书籍 id（缓存键的一部分） */
  bookId: string;
  /** 源语言（auto = 自动判定） */
  from?: string;
  /** 目标语言 */
  to?: string;
  /** 排版参数 */
  layout?: BilingualLayout;
  /** 页数上限（安全阀；0 = 不限） */
  maxPages?: number;
}

/** 流程的结果 */
export interface PdfTranslateOutput {
  /** 生成的双语 PDF 字节 */
  bytes: Uint8Array;
  /** 处理的页数 */
  pages: number;
  /** 抽取到的段落总数 */
  segments: number;
  /** 实际送去翻译的段数 */
  translated: number;
  /** 命中缓存的段数 */
  cached: number;
  /** 有译文的页数 */
  translatedPages: number;
  /** 建议文件名（不含扩展名） */
  suggestedName: string;
}

/** 流程中抛出的、带可读信息的错误 */
export class PdfTranslateError extends Error {
  /** 失败原因分类（UI 据此给不同提示） */
  readonly reason:
    | "no-text"
    | "no-font"
    | "pdf-parse"
    | "translate-failed"
    | "build-failed";

  constructor(
    message: string,
    reason:
      | "no-text"
      | "no-font"
      | "pdf-parse"
      | "translate-failed"
      | "build-failed",
  ) {
    super(message);
    this.name = "PdfTranslateError";
    // ⚠️ 不能用「构造函数参数属性」（readonly reason: …）——
    //    node 的 --experimental-strip-types 不支持它（只擦类型不转语法），
    //    会直接抛 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
    this.reason = reason;
  }
}

/** pdf.js 文本项（只取我们用到的字段） */
export interface PdfTextItemLike {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
}

/** pdf.js 的 PDFDocumentProxy（只取我们用到的部分，便于测试注入假实现） */
export interface PdfDocumentLike {
  numPages: number;
  getPage: (n: number) => Promise<{
    getTextContent: () => Promise<{ items: PdfTextItemLike[] }>;
    cleanup?: () => void;
  }>;
}

/**
 * 抽取 PDF 全文（逐页 → 行 → 段）。
 *
 * @param doc pdf.js 的 PDFDocumentProxy
 */
export async function extractPdfSegments(
  doc: PdfDocumentLike,
  maxPages = 0,
): Promise<{ segments: PdfSegment[]; pageCount: number; emptyPages: number[] }> {
  const total = doc.numPages;
  const limit = maxPages > 0 ? Math.min(maxPages, total) : total;
  const segments: PdfSegment[] = [];
  const emptyPages: number[] = [];
  for (let i = 1; i <= limit; i++) {
    const page = await doc.getPage(i);
    try {
      const tc = await page.getTextContent();
      const lines = itemsToLinesWithGaps(tc.items as never);
      const paras = paragraphsFromLines(i, lines);
      let pageSegCount = 0;
      for (const p of paras) {
        if (p.empty || !isTranslatableParagraph(p.text)) continue;
        segments.push({ page: i, index: pageSegCount, text: p.text });
        pageSegCount++;
      }
      if (pageSegCount === 0) emptyPages.push(i);
    } finally {
      page.cleanup?.();
    }
  }
  return { segments, pageCount: limit, emptyPages };
}

/**
 * 完整流程：抽取 → 翻译 → 生成双语 PDF。
 *
 * @param deps    翻译与 pdf.js 相关的依赖（宿主注入）
 * @param fontBytes 中文字体（TrueType/glyf）
 */
export async function runPdfBilingualTranslate(
  input: PdfTranslateInput,
  deps: PdfTranslateDeps & {
    /** 打开 PDF（返回 pdf.js 的 document proxy） */
    openPdf: (bytes: Uint8Array) => Promise<PdfDocumentLike>;
    /** 建议文件名 */
    suggestName?: (title: string) => string;
  },
  fontBytes: Uint8Array,
): Promise<PdfTranslateOutput> {
  const { originalBytes, bookId } = input;

  // ① 抽取
  //    ⚠️ 必须给 pdf.js **一份字节副本**：pdf.js 的 getDocument({data}) 会接管
  //    传入的 ArrayBuffer（transfer），之后 pdf-lib 读到的是空 buffer，
  //    报「No PDF header found」。实测踩过。
  let extracted: { segments: PdfSegment[]; pageCount: number; emptyPages: number[] };
  try {
    const doc = await deps.openPdf(originalBytes.slice());
    extracted = await extractPdfSegments(doc, input.maxPages ?? 0);
  } catch (e) {
    throw new PdfTranslateError(
      `PDF 解析失败：${e instanceof Error ? e.message : String(e)}`,
      "pdf-parse",
    );
  }

  if (extracted.segments.length === 0) {
    throw new PdfTranslateError(
      "这份 PDF 里没有可提取的文字（可能是扫描版/图片版），无法翻译。",
      "no-text",
    );
  }

  // ② 翻译
  const pages: number[] = [];
  for (let i = 1; i <= extracted.pageCount; i++) pages.push(i);
  const res = await translatePdfSegments(extracted.segments, pages, deps, {
    from: input.from ?? "auto",
    to: input.to ?? "zh",
    bookId,
  });

  // ③ 生成
  const translations = [...res.translations.entries()].map(([page, translation]) => ({
    page,
    translation,
  }));
  let built: { bytes: Uint8Array; pageCount: number };
  try {
    // 同样给 pdf-lib 一份副本（pdf.js 可能还持有原 buffer 的引用）
    // maxPages 与抽取保持一致：只译 20 页却生成 394 页 ⇒ 374 页右栏是空的
    built = await buildBilingualPdf(
      originalBytes.slice(),
      translations,
      fontBytes,
      input.layout,
      input.maxPages ?? 0,
    );
  } catch (e) {
    throw new PdfTranslateError(
      `生成双语 PDF 失败：${e instanceof Error ? e.message : String(e)}`,
      "build-failed",
    );
  }

  const translatedPages = translations.filter((t) => t.translation !== "").length;
  return {
    bytes: built.bytes,
    pages: extracted.pageCount,
    segments: extracted.segments.length,
    translated: res.translated,
    cached: res.cached,
    translatedPages,
    suggestedName: deps.suggestName?.(bookId) ?? bookId,
  };
}
