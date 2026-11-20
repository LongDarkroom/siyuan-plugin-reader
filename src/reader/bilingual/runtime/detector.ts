/**
 * 双语运行时 · 英文书籍识别（L2 runtime）
 * ==================================================================
 * 2026-09-05 立。双语对照只对英文书开放：点击「双语」时先过这道门槛，
 * 非英文书不进入双语流程（不切分、不送译、不注入），避免中文书白跑一遍
 * 翻译链路、白白烧 token。
 *
 * 判定顺序（2026-09-05 立「元数据优先」，2026-11-20 改成「元数据优先 + 正文复核」）：
 *   1) 读 EPUB 的 dc:language（BookMeta.language）：en* → 英文直接放行，零采样开销。
 *   2) 元数据是已知非英文语种（zh/ja/ko/...）→ **不是一票否决**，再用正文采样复核：
 *      正文拉丁主导、且 CJK 占比 ≤ 10% → 判英文（站点把英文书误标 zh-CN 的常见情形，
 *      如《怦然心动 Flipped》：英文正文 + 中文简介/人物介绍页）；否则按元数据拦下。
 *   3) 元数据缺失 / 不在已知表内（TXT/MD/PDF 常没有 dc:language）→ 采样正文：
 *      统计拉丁字母 vs CJK 字符占比 + 英文停用词命中数。
 *   4) 采样也无结论（样本太短或语种混杂）→ unknown，**放行**不拦（宁可让用户
 *      自己试，也不要误杀一本真英文书）。
 *
 * 本文件是纯函数：不 import 任何 DOM / foliate / 思源 API，
 * 因此可被 test/ 直接 import 做单元测试。
 */

import { countScripts } from "../core/scripts.ts";
import type { LanguageDetection, LanguageSource, LanguageVerdict } from "../core/types.ts";

/* ================================================================
 * 常量
 * ================================================================ */

/**
 * 已知**非英文**语种（ISO-639-1 主标签）。命中即拦。
 * 只列常见语种；表外的走采样。
 */
const NON_EN_LANGS: ReadonlySet<string> = new Set([
  "zh", "ja", "ko", "fr", "de", "es", "ru", "it", "pt", "nl",
  "pl", "tr", "ar", "hi", "th", "vi", "id", "ms", "sv", "no",
  "da", "fi", "cs", "sk", "el", "he", "uk", "ro", "hu", "fa",
]);

/** 英文高频停用词（小写）。命中数越多越像英文。 */
const EN_STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "of", "to", "a", "in", "is", "it", "that", "for",
  "with", "as", "was", "on", "be", "at", "by", "this", "have", "from",
  "or", "an", "they", "which", "one", "you", "were", "his", "her", "but",
  "not", "what", "all", "we", "when", "your", "can", "said", "there",
  "she", "him", "had", "has", "would", "could", "their", "them", "then",
  "into", "about", "over", "after", "before", "because", "been", "more",
]);

/** 采样文本拼接后的最大长度（超出即截断，够统计用即可） */
const SAMPLE_MAX_CHARS = 4000;

/** 拉丁字母占比达到该值 + 停用词达标 → 判英文 */
const EN_LATIN_RATIO = 0.6;

/** CJK 占比达到该值 → 直接判非英文（中日韩主导） */
const CJK_RATIO_BLOCK = 0.25;

/** 停用词命中门槛（不同词计数） */
const STOPWORD_HITS_EN = 3;

/** 拉丁占绝对主导时的兜底门槛（诗歌/对话体停用词天然偏少） */
const EN_LATIN_RATIO_STRONG = 0.8;
const STRONG_SAMPLE_MIN_CHARS = 200;

/**
 * 元数据与正文冲突时，正文要「干净到什么程度」才允许推翻元数据。
 * 2026-11-20 加：WeLib / Epubor 一类站点的英文书常把 dc:language 误标成 zh-CN
 * （书是英文正文，只多了中文简介 / 人物介绍页），旧逻辑元数据一票否决 → 真英文书开不了双语。
 * 0.1 的口径：正文里 CJK 只允许当点缀；中英对照书 CJK 占比远高于此，仍然拦（双语对它没意义）。
 */
const META_OVERRIDE_MAX_CJK = 0.1;

/** 采样时跳过的过短文本（页码、章节号、图片说明碎片） */
const MIN_BLOCK_CHARS = 20;

/* ================================================================
 * 对外 API
 * ================================================================ */

export interface DetectBookLanguageInput {
  /** 书籍元数据语种（EPUB dc:language，如 "en" / "en-US" / "zh-CN"） */
  metaLanguage?: string | null;
  /** 正文采样文本数组（由 collectSampleTexts 产出） */
  sampleTexts?: readonly string[] | null;
}

/**
 * 判定书籍是否为英文。
 * 返回 verdict + 依据 + 置信度，便于 UI 提示与日志排查。
 */
export function detectBookLanguage(input: DetectBookLanguageInput = {}): LanguageDetection {
  // 1) 元数据优先：dc:language 是 en 直接放行
  const meta = normalizeLang(input.metaLanguage);
  if (meta === "en") return { verdict: "en", source: "meta", confidence: 1 };
  // 元数据说是已知非英文语种 —— 但**不再一票否决**（见 META_OVERRIDE_MAX_CJK 注释），
  // 要再用正文采样复核一次；复核不过才拦。
  const metaOther = !!meta && NON_EN_LANGS.has(meta);

  // 2) 正文采样
  const texts = (input.sampleTexts ?? []).filter(
    (t): t is string => typeof t === "string" && t.trim().length > 0,
  );
  const sample = texts.join("\n").slice(0, SAMPLE_MAX_CHARS);
  if (sample.trim().length === 0) {
    // 没正文可采：元数据说是非英文就照它拦，否则维持「无结论 → 放行」
    if (metaOther) return { verdict: "other", source: "meta", confidence: 1 };
    return { verdict: "unknown", source: "none", confidence: 0 };
  }

  const { latin, cjk } = countScripts(sample);
  const denom = latin + cjk;
  if (denom === 0) {
    if (metaOther) return { verdict: "other", source: "meta", confidence: 1 };
    return { verdict: "unknown", source: "sample", confidence: 0 };
  }

  const cjkRatio = cjk / denom;
  const latinRatio = latin / denom;
  const hits = countStopwordHits(sample);
  // 正文的英文证据：拉丁主导 + 停用词达标，或拉丁压倒性主导且样本够长（诗歌/对话体）
  const enBySample =
    (latinRatio >= EN_LATIN_RATIO && hits >= STOPWORD_HITS_EN) ||
    (latinRatio >= EN_LATIN_RATIO_STRONG && sample.length >= STRONG_SAMPLE_MIN_CHARS);

  // 3) 元数据与正文冲突：以正文为准，但要求正文几乎不含 CJK
  if (metaOther) {
    // 正文里连一个汉字都没有 → 元数据明显不可信（目录页 / 版权页也算），放行
    if (cjk === 0 && latin > 0) return { verdict: "en", source: "sample", confidence: round2(latinRatio) };
    if (enBySample && cjkRatio <= META_OVERRIDE_MAX_CJK) {
      return { verdict: "en", source: "sample", confidence: round2(latinRatio) };
    }
    return { verdict: "other", source: "meta", confidence: 1 };
  }

  // 中日韩文字主导 → 明确非英文
  if (cjkRatio >= CJK_RATIO_BLOCK) {
    return { verdict: "other", source: "sample", confidence: round2(cjkRatio) };
  }

  // 拉丁主导 + 停用词命中 → 英文
  if (enBySample) {
    return { verdict: "en", source: "sample", confidence: round2(Math.min(1, latinRatio)) };
  }

  return { verdict: "unknown", source: "sample", confidence: 0 };
}

/** 是否为英文书（unknown 视作「不是英文」，调用方需自行决定是否放行） */
export function isEnglishBook(input: DetectBookLanguageInput = {}): boolean {
  return detectBookLanguage(input).verdict === "en";
}

/** 是否**明确**非英文书（unknown 不算，避免误杀） */
export function isNonEnglishBook(input: DetectBookLanguageInput = {}): boolean {
  return detectBookLanguage(input).verdict === "other";
}

/* ================================================================
 * 采样收集
 * ================================================================ */

export interface CollectSampleOptions {
  /** 拼接总字符上限（默认 2000） */
  maxChars?: number;
  /** 最多收集多少块（默认 40） */
  maxBlocks?: number;
}

/**
 * 从内容文档里收集正文采样。
 *
 * 参数是 duck-typed 的「文档」数组（真实环境传 foliate 的 Document[]，
 * 测试里传 mock 对象即可），因此本函数不依赖 DOM 类型、可直接单测。
 * 采样点覆盖段落/标题/列表/引用，跳过过短碎片（页码、图注）。
 */
export function collectSampleTexts(
  docs: readonly unknown[] | null | undefined,
  opts: CollectSampleOptions = {},
): string[] {
  const maxChars = opts.maxChars ?? 2000;
  const maxBlocks = opts.maxBlocks ?? 40;
  const out: string[] = [];
  if (!docs || docs.length === 0) return out;

  let chars = 0;
  for (const doc of docs) {
    const nodes = queryAll(doc, "p, h1, h2, h3, h4, li, blockquote, dd");
    for (const n of nodes) {
      const text = (typeof n === "object" && n !== null ? String((n as { textContent?: unknown }).textContent ?? "") : "")
        .trim();
      if (text.length < MIN_BLOCK_CHARS) continue;
      out.push(text);
      chars += text.length;
      if (out.length >= maxBlocks || chars >= maxChars) return out;
    }
  }
  return out;
}

/* ================================================================
 * 内部实现
 * ================================================================ */

/** 归一语种标签：取 ISO-639-1 主标签（"en-US" → "en"） */
function normalizeLang(raw?: string | null): string | null {
  if (!raw) return null;
  const m = String(raw).trim().toLowerCase().match(/^([a-z]{2,3})/);
  return m ? m[1] : null;
}

/**
 * 拉丁 / CJK 字符统计见 core/scripts.ts：整书闸门与块级闸门共用同一把尺子。
 */

/** 统计英文停用词命中数（不同词计数，达到门槛即早停） */
function countStopwordHits(sample: string): number {
  const words = sample.toLowerCase().match(/[a-z']+/g);
  if (!words) return 0;
  const hits = new Set<string>();
  for (const w of words) {
    if (EN_STOPWORDS.has(w)) {
      hits.add(w);
      if (hits.size >= STOPWORD_HITS_EN) break;
    }
  }
  return hits.size;
}

/** duck-typed querySelectorAll（失败/不支持一律返回空数组，不让识别链路抛错） */
function queryAll(doc: unknown, selector: string): unknown[] {
  const anyDoc = doc as { querySelectorAll?: (s: string) => unknown } | null;
  if (!anyDoc || typeof anyDoc.querySelectorAll !== "function") return [];
  try {
    const list = anyDoc.querySelectorAll(selector) as
      | { length?: number; [i: number]: unknown }
      | null
      | undefined;
    if (!list || typeof list.length !== "number") return [];
    const out: unknown[] = [];
    for (let i = 0; i < list.length; i++) out.push((list as { [i: number]: unknown })[i]);
    return out;
  } catch {
    return [];
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
