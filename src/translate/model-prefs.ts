/**
 * 翻译模型识别与排序（2026-11-19）
 * ------------------------------------------------------------------
 * 「获取模型」拉回来的列表动辄几十上百条（千问约 100+、硅基流动上千），
 * 用户要的 qwen-mt-flash 这类翻译专用模型很容易被通用对话模型淹没。
 * 这里按「翻译专用 → 其余」分档，档内按字母序，保证每次打开下拉顺序稳定。
 *
 * 判定口径（宁宽勿漏，但避开 bge-m3 这类误伤）：
 *   · qwen-mt-family：qwen-mt-flash / qwen-mt-plus / qwen-mt-lite / qwen-mt-turbo
 *   · 通用 -mt- 段：opus-mt-en-zh、nllb-mt 等
 *   · translate / translation 字样
 * 注意 `m3` / `mt5`（阿里巴巴的 mT5 除外）不算：`bge-m3` 是向量模型，
 * 混进翻译候选会让默认选项指向一个根本不能翻译的模型。
 */

/** 段边界：以 - / _ . / 或字符串首尾分隔，避免 bge-m3 里的 m3 误判 */
const MT_SEGMENT = /(^|[/_.-])mt($|[/_.-])/i;
const TRANSLATE_WORD = /translat(e|ion|or)/i;

/** 是否是翻译类模型 */
export function isTranslationModel(id: string): boolean {
  const s = String(id || "");
  return MT_SEGMENT.test(s) || TRANSLATE_WORD.test(s);
}

/**
 * 翻译模型置顶排序：翻译类在前（档内按字母序），其余在后（同样按字母序）。
 * 不改变集合内容，只改变顺序 —— 用户仍能选到全部模型。
 */
export function preferTranslationModels(models: readonly string[]): string[] {
  const tier = (m: string) => (isTranslationModel(m) ? 0 : 1);
  return [...models].sort((a, b) => tier(a) - tier(b) || a.localeCompare(b));
}
