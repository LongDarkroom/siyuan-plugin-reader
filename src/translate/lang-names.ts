/**
 * 语言码 → 千问 MT 的英文全名
 * ------------------------------------------------------------------
 * Qwen-MT 的 `translation_options.source_lang / target_lang` 只认
 * **英文语言全名**（"Chinese" / "English"…），不认 ISO 代码（"zh" / "en"）。
 * 源语言额外接受 "auto"（由模型自动检测）。
 *
 * 目标语言全集与本插件 bilingual-langs.ts 的 TARGET_LANG_OPTIONS 对齐；
 * 多出的几种用于将来扩展，映射不到时返回空串，由适配器给出可读错误
 * （而不是把 "xx" 原样发给服务端换一个看不懂的 400）。
 */

const QWEN_LANG_NAMES: Record<string, string> = {
  auto: "auto",
  zh: "Chinese",
  "zh-CN": "Chinese",
  "zh-Hans": "Chinese",
  "zh-Hant": "Traditional Chinese",
  "zh-TW": "Traditional Chinese",
  en: "English",
  ja: "Japanese",
  ko: "Korean",
  fr: "French",
  de: "German",
  es: "Spanish",
  ru: "Russian",
  pt: "Portuguese",
  it: "Italian",
  ar: "Arabic",
  th: "Thai",
  vi: "Vietnamese",
  id: "Indonesian",
  ms: "Malay",
  nl: "Dutch",
  tr: "Turkish",
  hi: "Hindi",
};

/** 千问支持的语言码（UI 下拉用；含 auto 表示自动检测） */
export function toQwenLang(code: string | undefined): string {
  const key = (code || "").trim();
  if (!key) return "";
  return QWEN_LANG_NAMES[key] || QWEN_LANG_NAMES[key.toLowerCase()] || "";
}
