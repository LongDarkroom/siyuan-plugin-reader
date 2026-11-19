/**
 * 双语运行时 · 切分器（L2 runtime）
 * ==================================================================
 * 从 bilingual-v2.ts 的 getSegments（旧 :93-118）抽出的独立模块。
 *
 * 相对旧实现的两点变化：
 *  1. **memo**：旧代码在 injectAll / segmentStats / segmentTexts / pretranslateAll
 *     四个调用点各自全量扫描 DOM（同一批段落在一轮里被扫 4 次）。本模块按
 *     Document 做 WeakMap 缓存，四处共用一份结果，翻页或重排时 invalidate。
 *  2. **产出 Segment 而非匿名结构**：带 locatorKey（= 文本指纹 + 节内稳定序号），
 *     成为注入去重 / 失败重试 / 隐藏集合的统一锚点。
 *     2026-11-19：键里必须带序号 —— 旧键只由文本决定，书里重复出现的同句
 *     （对白、分隔符）会被去重逻辑当成「同一段」，第二处起永远不出译文。
 *     序号只统计「结构合格的候选块」，与是否已注入/隐藏无关，因此临时解析的
 *     分节文档与已挂载文档能算出同一个键（full 预翻译靠它映射回真实节点）。
 */
import type { Segment, SegmenterLike } from "../core/types.ts";
import { segHash, isTranslatedPeer } from "../../bilingual-v2/render.ts";

/**
 * 真实正文块（首选段落级）。
 * 2026-11-19 补 h1–h6 / figcaption / dt / dd：标题与图注此前完全不翻。
 * caption 刻意不收：<table> 内插 div 兄弟是非法结构，浏览器会把译文提出表格。
 */
const BLOCK = "p, li, blockquote, h1, h2, h3, h4, h5, h6, figcaption, dt, dd";
/** div 仅作叶子文本块兜底：部分 EPUB 用 div 而非 p 做段落 */
const LEAF_DIV = "div";
/**
 * 表格单元格（2026-11-13 新增）：只切「叶子单元格」——
 * 单元格里若有 p/div 等块级子节点，正文由那些块承担，单元格整体再切会重复翻译。
 */
const CELL = "td, th";
/** 至少含一个文字字符（表格里大量纯数字/符号单元格，翻译它们纯属浪费额度） */
const HAS_LETTER = /\p{L}/u;
/** 不应翻译的节点 */
const EXCLUDED = "pre, code, math, style, script";
/**
 * 作为整体翻译的容器：其内 p 跳过，改译容器整体。
 * 2026-11-19 移出 blockquote：引文常含多个段落，整体切会把多段合成一段
 * （丢段落结构、单条过长易被引擎截断）；改为 blockquote 有块级子节点时
 * 自身让位、由内部 p 各自承载译文。
 */
const CONTAINER = "li";

export function cleanText(s: string): string {
  return (s || "").replace(/\s+/g, " ").trim();
}

/**
 * 切一个分节文档。
 *
 * 已成功注入的段落（原文带 data-reword-translated 或已有译文兄弟节点）会被跳过；
 * 失败段在新语义下**不打标**，因此下一轮仍会被切出并重试。
 */
export function segmentDocument(
  doc: Document,
  sectionIndex: number,
  isSegmentHidden?: (hash: string) => boolean,
): Segment[] {
  if (!doc || typeof doc.querySelectorAll !== "function") return [];
  const all = Array.from(doc.querySelectorAll(`${BLOCK}, ${LEAF_DIV}, ${CELL}`)) as Element[];
  const out: Segment[] = [];
  let recent: string[] = [];
  /**
   * 稳定序号：对每个「结构合格」的候选块递增，**在跳过已注入/隐藏之前占号**。
   * 这样同一节点在临时文档（未注入）与已挂载文档（部分已注入）里拿到同一个序号，
   * 定位键才能跨文档对齐；同时重复文本靠序号区分，互不吞掉。
   */
  let ordinal = 0;
  for (const el of all) {
    if (el.closest(EXCLUDED)) continue;
    if ((el as HTMLElement).classList?.contains("reword-bilingual")) continue;
    if (el.hasAttribute("data-translation-mark")) continue;
    // 叶子判定：div / 单元格 / blockquote 只在「没有块级后代」时整体翻译；
    // 含 table 的同样跳过（嵌套表格由内层单元格各自承担）。
    if (
      (el.tagName === "DIV" || el.tagName === "TD" || el.tagName === "TH" || el.tagName === "BLOCKQUOTE") &&
      el.querySelector("p, li, blockquote, div, table")
    ) continue;
    if (el.parentElement?.closest(CONTAINER)) continue;
    const text = cleanText(el.textContent || "");
    if (!text) continue;
    if ((el.tagName === "TD" || el.tagName === "TH") && !HAS_LETTER.test(text)) continue;
    const index = ordinal++;
    if (el.hasAttribute("data-reword-translated") || isTranslatedPeer(el)) continue;
    if (isSegmentHidden && isSegmentHidden(segHash(text))) continue;
    out.push({
      locatorKey: `${segHash(text)}#${sectionIndex}.${index}`,
      text,
      sectionIndex,
      indexInSection: index,
      node: el,
      prev: recent.slice(-2).join("\n"),
    });
    const short = text.length > 160 ? text.slice(0, 160) : text;
    recent.push(short);
    if (recent.length > 4) recent.shift();
  }
  return out;
}

export interface SegmenterOptions {
  /** 判定段落指纹是否被用户隐藏（隐藏集合沿用 segHash，兼容已持久化数据） */
  isSegmentHidden?: (hash: string) => boolean;
}

/**
 * 带 memo 的切分器。缓存键是 Document 本身（WeakMap，随文档回收自动释放）。
 */
export function createSegmenter(opts: SegmenterOptions = {}): SegmenterLike {
  // WeakMap 没有 clear()，全清只能换一个新实例
  let cache = new WeakMap<Document, Map<number, Segment[]>>();

  function segmentsOf(doc: Document, sectionIndex: number): Segment[] {
    if (!doc) return [];
    let bySection = cache.get(doc);
    if (!bySection) {
      bySection = new Map();
      cache.set(doc, bySection);
    }
    const hit = bySection.get(sectionIndex);
    if (hit) return hit;
    const segs = segmentDocument(doc, sectionIndex, opts.isSegmentHidden);
    bySection.set(sectionIndex, segs);
    return segs;
  }

  return {
    segmentsOf,
    segmentsOfDocs(docs: Document[], firstSectionIndex = 0): Segment[] {
      const out: Segment[] = [];
      docs.forEach((doc, i) => {
        out.push(...segmentsOf(doc, firstSectionIndex + i));
      });
      return out;
    },
    invalidate(doc?: Document): void {
      if (doc) cache.delete(doc);
      else cache = new WeakMap();
    },
  };
}
