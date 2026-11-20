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
 *
 * 2026-11-20 再加两条（都在此文件内，序号口径保持向后兼容）：
 *  3. **块级语种闸门**：英文书里夹的中文页（站点塞的简介 / 人物介绍 / 推广页）
 *     不该送译 —— 源语言按 auto 发给引擎，中文进去就是中文出来，界面上是一模一样
 *     的重复行，还白烧额度。目标语言用 CJK 书写（zh/ja/ko）时，CJK 主导的块直接不切。
 *     ⚠️ 判定放在 `ordinal++` **之后**：跳过不该改动其它块的定位键，
 *     否则已译书籍的后续段落整体漂移一位、全部重译。
 *  4. **裸文本块（方案 A）**：大量 EPUB 把章节首段写成**直接挂在 div 下的文本节点**
 *     （《怦然心动》14 个正文章节全中），而「含块级子节点的容器让位给内部块」的规则
 *     会把它整块跳过 → 全书首段永远不出译文。这类块不改动原 DOM（不包 <p>，
 *     那会让 CFI/批注锚点与段落序号整体漂移），而是记录插入锚点交给注入器，
 *     序号走独立的 `L< n >` 命名空间。
 */
import type { Segment, SegmenterLike } from "../core/types.ts";
import { isCjkDominant, isCjkWrittenLang } from "../core/scripts.ts";
import { segHash, isTranslatedPeer, isLooseTextTranslated } from "../../bilingual-v2/render.ts";

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
/** 至少含一个文字字符（表格里大量纯数字/符号单元格、正文里的裸页码，翻译它们纯属浪费额度） */
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

/**
 * 裸文本扫描的宿主容器（2026-11-20 方案 A）。
 * 只收「元素切分那边会让位」的容器：div / td / th / blockquote 含块级子节点时自身不译，
 * 其直属文本节点没人管；再加 body（正文直接铺在 body 下的书）。
 * li / p / h* / dt / dd 不收 —— 元素切分按整体 textContent 翻译，已经覆盖其内文本。
 */
const LOOSE_HOST = "div, td, th, blockquote";

export function cleanText(s: string): string {
  return (s || "").replace(/\s+/g, " ").trim();
}

/** 节点是否为元素（nodeType=1）/ 文本（nodeType=3）；duck-typed 兼容 mock 节点 */
function isElem(n: unknown): n is Element {
  return !!n && (n as Node).nodeType === 1;
}
function isText(n: unknown): n is Text {
  return !!n && (n as Node).nodeType === 3;
}

/** 一个待译的裸文本块（连续文本节点合并成一段） */
interface LooseRun {
  /** 该文本节点的父容器：读对齐样式 + 承载译文 */
  container: Element;
  /** 运行段的第一个文本节点：幂等判定从这里往后看兄弟 */
  run: Text;
  /** 译文插入锚点：容器内紧随该文本块的第一个元素；null = 追加到容器末尾 */
  before: Element | null;
  text: string;
}

/**
 * 收集容器直属的裸文本块。
 *
 * 只处理「元素切分那边接不住」的文本：宿主必须含块级子节点（否则整块已由
 * div/td 路径翻译，再切一遍就是重复）。mock 文档（只有 querySelectorAll、无 body）直接返回空。
 */
function collectLooseRuns(doc: Document): LooseRun[] {
  const body = (doc as Document & { body?: Element | null }).body;
  if (!body || typeof body.querySelectorAll !== "function") return [];
  const hosts: Element[] = [body];
  try {
    hosts.push(...(Array.from(body.querySelectorAll(LOOSE_HOST)) as Element[]));
  } catch {
    // mock / 老内核：没有可用的 querySelectorAll 就只扫 body
  }
  const out: LooseRun[] = [];
  for (const host of hosts) {
    if (!host) continue;
    if (host.classList?.contains("reword-bilingual")) continue;
    if (host.hasAttribute?.("data-translation-mark")) continue;
    if (host !== body) {
      if (host.closest?.(EXCLUDED)) continue;
      // 无块级子节点的容器整体已由元素切分承担，这里再切就是重复翻译
      if (!host.querySelector?.("p, li, blockquote, div, table")) continue;
      // li 内：li 已按整体 textContent 翻译
      if (host.parentElement?.closest(CONTAINER)) continue;
    }
    const kids = Array.from(host.childNodes || ([] as unknown as Node[]));
    for (let i = 0; i < kids.length; i++) {
      if (!isText(kids[i])) continue;
      const first = kids[i] as Text;
      let last = first;
      // 相邻文本节点（中间没有元素）在语义上是同一段，合并处理
      while (i + 1 < kids.length && isText(kids[i + 1])) last = kids[++i] as Text;
      let raw = "";
      for (let n: Node | null = first; n; n = n === last ? null : n.nextSibling) {
        if (isText(n)) raw += n.data ?? n.textContent ?? "";
      }
      const text = cleanText(raw);
      if (!text || !HAS_LETTER.test(text)) continue;
      let before: Element | null = null;
      for (let n: Node | null = last.nextSibling; n; n = n.nextSibling) {
        if (isElem(n)) {
          before = n as Element;
          break;
        }
      }
      out.push({ container: host, run: first, before, text });
    }
  }
  return out;
}

/**
 * 切一个分节文档。
 *
 * 已成功注入的段落（原文带 data-reword-translated 或已有译文兄弟节点）会被跳过；
 * 失败段在新语义下**不打标**，因此下一轮仍会被切出并重试。
 *
 * @param targetLang 译文目标语言（如 "zh" / "en"）；用 CJK 书写时启用块级语种闸门，
 *                   中文主导的块不送译（英文书里夹的中文简介页 / 推广页）
 */
export function segmentDocument(
  doc: Document,
  sectionIndex: number,
  isSegmentHidden?: (hash: string) => boolean,
  targetLang?: string,
): Segment[] {
  if (!doc || typeof doc.querySelectorAll !== "function") return [];
  const skipCjk = isCjkWrittenLang(targetLang);
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
    // 已是目标语言（中英混排书里的纯中文块）：不送译，但序号已占，其它块的键不受影响
    if (skipCjk && isCjkDominant(text)) continue;
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
  looseSegments(doc, sectionIndex, out, isSegmentHidden, skipCjk);
  return out;
}

/**
 * 裸文本块 → Segment（方案 A）。
 *
 * 序号走独立的 `L< n >` 命名空间：元素切分已经跑完，若让这些文本块插进元素序号队列，
 * 其后所有块的定位键整体漂移一位，已译书籍会全部重算重译。
 * 产出按文档顺序**插回** out 的正确位置（译文顺序 = 阅读顺序，chunkTexts 分片才合理）。
 */
function looseSegments(
  doc: Document,
  sectionIndex: number,
  out: Segment[],
  isSegmentHidden?: (hash: string) => boolean,
  skipCjk = false,
): void {
  const runs = collectLooseRuns(doc);
  if (!runs.length) return;
  let looseOrdinal = 0;
  for (const r of runs) {
    const index = looseOrdinal++;
    if (isLooseTextTranslated(r.run)) continue;
    if (skipCjk && isCjkDominant(r.text)) continue;
    if (isSegmentHidden && isSegmentHidden(segHash(r.text))) continue;
    // 插回文档顺序：第一个「位于该文本块之后」的已切块之前
    let at = out.length;
    for (let i = 0; i < out.length; i++) {
      const n = out[i].node as Element | undefined;
      if (n && typeof n.compareDocumentPosition === "function" && follows(r.run, n)) {
        at = i;
        break;
      }
    }
    const beforeSeg = at > 0 ? out[at - 1] : undefined;
    out.splice(at, 0, {
      locatorKey: `${segHash(r.text)}#${sectionIndex}.L${index}`,
      text: r.text,
      sectionIndex,
      indexInSection: index,
      // node = 父容器：注入器只用它读对齐样式，打标与清理走 loose 专用分支
      node: r.container,
      prev: beforeSeg ? beforeSeg.text.slice(0, 160) : "",
      loose: { run: r.run, before: r.before },
    });
  }
}

/** b 在文档顺序上位于 a 之后 */
function follows(a: Node, b: Element): boolean {
  const pos = a.compareDocumentPosition(b);
  return (pos & 4) === 4; // DOCUMENT_POSITION_FOLLOWING
}

export interface SegmenterOptions {
  /** 判定段落指纹是否被用户隐藏（隐藏集合沿用 segHash，兼容已持久化数据） */
  isSegmentHidden?: (hash: string) => boolean;
  /**
   * 译文目标语言。用 CJK 书写（zh / ja / ko）时启用块级语种闸门，
   * 中文主导的块不切分、不送译。缺省不启用（保守：宁可多译也不漏）。
   */
  targetLang?: string;
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
    const segs = segmentDocument(doc, sectionIndex, opts.isSegmentHidden, opts.targetLang);
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
