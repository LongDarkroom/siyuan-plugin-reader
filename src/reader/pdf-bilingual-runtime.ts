/**
 * 双语对照 PDF 的 runtime（2026-11-17）
 * ==================================================================
 *
 * 真正调 pdf-lib 生成文件的部分。与 `pdf-bilingual.ts`（纯排版计算）分开：
 * 那边可在 node 里直接断言，这边依赖 pdf-lib 与字体字节。
 *
 * 三个必须记住的坑（2026-11-17 实测）：
 *  ① 字体必须是 **TrueType(glyf)**：pdf-lib 对 CFF 轮廓（CFF2/OTF）会嵌成
 *     CIDFontType0，**Chrome 画不出来**（文本能提取但页面空白）；
 * ② 必须 `subset: true`：5.27MB 字体不 subset 会让每个 PDF 涨几 MB；
 * ③ 原页搬移要用 `copyPages` + **`embedPage`**：`copyPages` 返回的是
 *     `PDFPage`，`drawPage` 要的是 `PDFEmbeddedPage`，直接传会报
 *     「embeddedPage must be of type PDFEmbeddedPage」。
 */

import { PDFDocument, rgb, type PDFFont, type PDFEmbeddedPage, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import {
  DEFAULT_LAYOUT,
  bilingualPageSize,
  splitTranslationIntoPages,
  type BilingualLayout,
  type TranslatedPage,
} from "./pdf-bilingual.ts";

/** 生成结果 */
export interface BilingualBuildResult {
  /** 生成的 PDF 字节 */
  bytes: Uint8Array;
  /** 实际产出的页数（译文过长时会多出「续页」） */
  pageCount: number;
  /** 每页译文的行数（调试用） */
  linesPerPage: number[];
}

/** 字体字节的提供者（测试可注入假字体，生产用真 TTF） */
export type FontBytesProvider = () => Promise<Uint8Array>;

/**
 * 生成双语对照 PDF。
 *
 * @param originalBytes 原 PDF 字节
 * @param translations  各页译文（按页码索引；缺页视为空）
 * @param fontBytes     中文字体字节（TrueType/glyf）
 * @param layout        排版参数
 */
export async function buildBilingualPdf(
  originalBytes: Uint8Array,
  translations: ReadonlyArray<TranslatedPage>,
  fontBytes: Uint8Array,
  layout: BilingualLayout = DEFAULT_LAYOUT,
  /** 只生成前 N 页（0 = 全部）。与抽取的 maxPages 必须一致，否则页数会对不上。 */
  maxPages = 0,
): Promise<BilingualBuildResult> {
  const src = await PDFDocument.load(originalBytes, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  out.registerFontkit(fontkit);
  // ② 必须 subset
  const font: PDFFont = await out.embedFont(fontBytes, { subset: true });

  const byPage = new Map<number, string>();
  for (const t of translations) byPage.set(t.page, t.translation ?? "");

  const srcPages = src.getPages();
  const linesPerPage: number[] = [];
  // 页数上限：与抽取一致（否则「只译了 20 页」却生成 394 页 ⇒ 374 页右栏空白）
  const limit = maxPages > 0 ? Math.min(maxPages, srcPages.length) : srcPages.length;

  for (let i = 0; i < limit; i++) {
    const pageNo = i + 1;
    const srcPage = srcPages[i] as never as { getSize(): { width: number; height: number } };
    const { width, height } = srcPage.getSize();

    // ③ copyPages → embedPage
    const [copied] = await out.copyPages(src, [i]);
    const embedded: PDFEmbeddedPage = await out.embedPage(copied as never);

    const translation = byPage.get(pageNo) ?? "";
    const chunks = splitTranslationIntoPages(translation, width, height, layout);

    if (chunks.length === 0 || (chunks.length === 1 && chunks[0]?.length === 0)) {
      // 没有译文 ⇒ 只放原页（仍是双语页尺寸，右栏留白）
      const size = bilingualPageSize(width, height);
      const page = out.addPage([size.width, size.height]);
      page.drawPage(embedded, { x: 0, y: 0, width, height });
      drawColumnSeparator(page, width, height);
      linesPerPage.push(0);
      continue;
    }

    // 译文可能需要多页：第一页放原页 + 译文第一块，后续页是「原页缩略 + 译文续」
    for (let c = 0; c < chunks.length; c++) {
      const chunk = chunks[c] as Array<{ text: string; y: number }>;
      const size = bilingualPageSize(width, height);
      const page = out.addPage([size.width, size.height]);
      page.drawPage(embedded, { x: 0, y: 0, width, height });
      drawColumnSeparator(page, width, height);
      for (const line of chunk) {
        page.drawText(line.text, {
          x: width + layout.margin,
          y: line.y,
          size: layout.fontSize,
          font,
          color: rgb(0.12, 0.12, 0.14),
        });
      }
      if (layout.showPageHeader) {
        page.drawText(`第 ${pageNo} 页`, {
          x: width + layout.margin,
          y: height - layout.margin + layout.fontSize * 0.6,
          size: layout.fontSize * 0.95,
          font,
          color: rgb(0.45, 0.45, 0.5),
        });
      }
      linesPerPage.push(chunk.length);
    }
  }

  const bytes = await out.save();
  return { bytes, pageCount: out.getPageCount(), linesPerPage };
}

/** 原文与译文之间的分隔线（细灰竖线） */
function drawColumnSeparator(page: PDFPage, x: number, height: number): void {
  page.drawLine({
    start: { x, y: 0 },
    end: { x, y: height },
    thickness: 0.5,
    color: rgb(0.8, 0.8, 0.84),
    opacity: 0.6,
  });
}
