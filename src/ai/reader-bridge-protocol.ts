/**
 * Reader × Copilot AI 桥协议（纯逻辑）
 * ----------------------------------------------------------------
 * 链路：内核 MCP 工具（kernel.js）→ siyuan.rpc.broadcast →
 *       前端 reader-bridge.ts → 活动 ReaderView 的导出方法 → 回传内核。
 *
 * 本文件只放无副作用、可单测的常量与校验：
 *   · 通道名是两端（kernel.js / reader-bridge.ts）的单一真源；
 *   · 格式白名单决定「AI 能不能读这本书」——PDF / 漫画暂不支持；
 *   · quote 规范化与上限定死写入口径，避免 AI 用长段落做模糊定位。
 */

/** 内核 → 前端：请求（JSON-RPC notification） */
export const BRIDGE_REQUEST_EVENT = "reader-bridge:request";
/** 前端 → 内核：回传结果（JSON-RPC 方法名） */
export const BRIDGE_RESPONSE_METHOD = "reader-bridge:response";

/** 单次 get_chapter 默认字符数（中文约 1 字 ≈ 1 token，避免一口气塞爆上下文） */
export const DEFAULT_MAX_CHARS = 12000;
/** 单次 get_chapter 硬上限 */
export const HARD_MAX_CHARS = 40000;
/** 原文片段上限：既限制 token，也避免 AI 拿整段做「模糊定位」 */
export const MAX_QUOTE_CHARS = 300;
/** 单次 annotate 条数上限（写操作要可审阅，不允许一次刷几百条） */
export const MAX_ANNOTATE_ITEMS = 30;
/** locate 最多回传的候选数 */
export const MAX_LOCATE_CANDIDATES = 5;

/** 有文字层、可被 AI 读取的格式（PDF / 漫画 CBZ 不在内；PDF 待二期） */
const AI_TEXT_FORMATS = new Set(["epub", "mobi", "azw3", "fb2", "txt", "md", "markdown"]);

export function isAiTextFormat(format?: string | null): boolean {
  return AI_TEXT_FORMATS.has(String(format || "").toLowerCase());
}

export const AI_ANNOTATION_STYLES = ["highlight", "solid", "wavy"] as const;
export type AiAnnotationStyle = (typeof AI_ANNOTATION_STYLES)[number];

export type AiBridgeError =
  | "unsupported_format"
  | "no_reader_open"
  | "no_chapter"
  | "chapter_load_failed"
  | "section_not_active"
  | "invalid_args"
  | "quote_too_long"
  | "quote_not_found"
  | "search_failed"
  | "write_failed"
  | "unknown_method"
  | "bridge_unavailable"
  | "timeout"
  | "empty_result"
  | "internal";

/** 给 AI 看的错误说明：AI 会把这些话转述给用户 */
export const AI_BRIDGE_ERROR_TEXT: Record<AiBridgeError, string> = {
  unsupported_format: "当前书籍格式暂不支持 AI 读取（目前支持 EPUB/MOBI/AZW3/FB2/TXT/MD）",
  no_reader_open: "没有打开的阅读器，请先在 RE 阅读器中打开一本书",
  no_chapter: "尚未定位到章节，请等书籍加载完成",
  chapter_load_failed: "章节内容加载失败",
  section_not_active: "只能给当前正在阅读的章节划线，请先翻到该章节",
  invalid_args: "参数无效",
  quote_too_long: `原文片段过长（上限 ${MAX_QUOTE_CHARS} 字）`,
  quote_not_found: "在当前章节里找不到这段原文",
  search_failed: "阅读器内搜索失败",
  write_failed: "批注写入失败",
  unknown_method: "未知的桥方法",
  bridge_unavailable: "内核桥不可用",
  timeout: "阅读器未响应（请确认书籍已打开且窗口未休眠）",
  empty_result: "阅读器返回了空结果",
  internal: "阅读器内部错误",
};

export function clampMaxChars(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_MAX_CHARS;
  if (n < 500) return 500;
  return Math.min(HARD_MAX_CHARS, n);
}

/** quote 规范化：去零宽字符、NBSP → 空格、连续空白压成一个空格、首尾裁剪 */
export function normalizeQuote(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

export interface AiAnnotationItem {
  quote: string;
  note: string;
  color?: string;
  style: AiAnnotationStyle;
}

/** 校验单条 AI 批注：quote 必填；style 非法回落 highlight；color 非 hex 丢弃 */
export function validateAnnotationItem(
  raw: any,
): { ok: true; item: AiAnnotationItem } | { ok: false; error: AiBridgeError } {
  const quote = normalizeQuote(raw?.quote);
  if (!quote) return { ok: false, error: "invalid_args" };
  if (quote.length > MAX_QUOTE_CHARS) return { ok: false, error: "quote_too_long" };
  const styleRaw = String(raw?.style || "highlight").toLowerCase();
  const style = (AI_ANNOTATION_STYLES as readonly string[]).includes(styleRaw)
    ? (styleRaw as AiAnnotationStyle)
    : "highlight";
  const colorRaw = String(raw?.color || "");
  const color = COLOR_RE.test(colorRaw) ? colorRaw : undefined;
  const note = String(raw?.note ?? "").trim();
  return { ok: true, item: { quote, note, color, style } };
}

/** sectionIndex 参数规范化：非整数 / 越界 → null（由调用方回落当前章） */
export function normalizeSectionIndex(value: unknown, total: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const n = Math.floor(value);
  return n >= 0 && n < total ? n : null;
}

export interface QuoteHit {
  start: number;
  length: number;
}

/**
 * 在归一化后的章节正文里找 quote 的全部命中位置。
 * 精确匹配优先；大小写不一致时用正则兜底（下标仍映射原串，长度取真实匹配长度）。
 * 索引可直接用于「归一化字符 → DOM 位置」映射，因此这里不做任何会改变长度的变换。
 */
export function findQuoteMatches(hay: string, needle: string): QuoteHit[] {
  const hits: QuoteHit[] = [];
  if (!hay || !needle) return hits;
  let at = hay.indexOf(needle);
  while (at >= 0) {
    hits.push({ start: at, length: needle.length });
    at = hay.indexOf(needle, at + 1);
  }
  if (hits.length) return hits;
  try {
    const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
    let m: RegExpExecArray | null;
    while ((m = re.exec(hay)) !== null) {
      hits.push({ start: m.index, length: m[0].length });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  } catch {
    /* 正则失败视为未命中 */
  }
  return hits;
}
