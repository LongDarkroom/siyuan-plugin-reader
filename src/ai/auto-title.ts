/**
 * 阅读助手 · 会话自动命名（纯逻辑）
 * ------------------------------------------------------------------
 * 首条消息发出后，让模型用一句话概括会话主题。这里只做无副作用的计算：
 * 提示词拼装、模型输出清洗、命名目标解析、覆盖前守卫。
 *
 * 不碰 DOM / Svelte / 思源 API，也不发请求；请求与落盘在 AiPanel。
 */

/** AI 标题上限（码点）。超出时截断，并去掉尾部标点 */
export const AUTO_TITLE_MAX_CHARS = 16;
/** 自定义提示词上限（字符） */
export const AUTO_RENAME_PROMPT_MAX = 500;
/** 塞进提示词的用户原话上限，避免把整段长文再发一遍 */
export const AUTO_RENAME_INPUT_MAX = 1200;

/**
 * 默认命名提示词。{message} 会被替换成用户的第一句话。
 * 明确要求「只输出标题」——不同模型对「不要解释」的执行率差异很大，
 * 清洗层还会再兜一层，但提示词先降低跑偏概率。
 */
export const DEFAULT_AUTO_RENAME_PROMPT =
  "请用不超过 12 个字符概括这条对话的主题，与用户语言一致。只输出标题本身，不要引号、标点、表情或解释。\n\n用户的第一句话：{message}";

/** 拼装命名请求的用户消息：替换全部 {message}，模板忘了占位符时把原话追加在后面 */
export function buildAutoRenamePrompt(
  template: unknown,
  message: unknown,
  inputMax = AUTO_RENAME_INPUT_MAX,
): string {
  const tpl = String(template ?? "").trim() || DEFAULT_AUTO_RENAME_PROMPT;
  const raw = String(message ?? "").replace(/\s+/g, " ").trim();
  const limit = Math.max(1, Math.round(Number(inputMax) || AUTO_RENAME_INPUT_MAX));
  const text = Array.from(raw).slice(0, limit).join("");
  if (!text) return tpl.replace(/\{message\}/g, "");
  if (tpl.includes("{message}")) return tpl.replace(/\{message\}/g, text);
  return `${tpl}\n\n${text}`;
}

const QUOTE_WRAP_RE = /^[\s"'“”‘’「」『』《》〈〉`]+|[\s"'“”‘’「」『』《》〈〉`]+$/g;
const TRAILING_PUNCT_RE = /[。．.，,！!？?；;：:、…·\-—–~～\s]+$/;

/**
 * 清洗模型输出：
 *  - 只取第一行有效文本，去掉代码围栏、Markdown 标题/列表/加粗标记；
 *  - 去掉「标题：」之类的前缀与成对引号；
 *  - 去掉尾部标点，再按 AUTO_TITLE_MAX_CHARS 截断并二次去尾。
 * 清洗后为空返回空串——调用方据此保持本地标题，不写空标题。
 */
export function cleanAutoTitle(raw: unknown): string {
  const text = String(raw ?? "").replace(/\r\n?/g, "\n").replace(/```[a-z0-9_-]*/gi, " ");
  const line = text
    .split("\n")
    .map((s) => s.trim())
    .find(Boolean) || "";
  let s = line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*•·]\s+/, "")
    .replace(/^\d+[.、)]\s+/, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  s = s.replace(/^(标题|题目|会话标题|title|name)\s*[:：]\s*/i, "").trim();
  let prev = "";
  while (s && s !== prev) {
    prev = s;
    s = s.replace(QUOTE_WRAP_RE, "").trim();
  }
  s = s.replace(TRAILING_PUNCT_RE, "").trim();
  const chars = Array.from(s);
  if (chars.length > AUTO_TITLE_MAX_CHARS) {
    s = chars.slice(0, AUTO_TITLE_MAX_CHARS).join("").replace(TRAILING_PUNCT_RE, "").trim();
  }
  return s;
}

export interface AutoRenameTarget {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 实际使用的平台 id；空串表示跟随当前对话 */
  platformId: string;
}

/**
 * 解析命名请求该用哪套凭据：
 *  - autoRenamePlatformId 为空 → 跟随当前对话（用 fallback 里的当前凭据）；
 *  - 指定平台 → 只用该平台的 baseUrl/apiKey，模型优先 autoRenameModel，
 *    不在列表里就回落该平台第一个模型；平台无效时回到「跟随当前」，
 *    绝不把请求错发到另一个平台。
 * 返回 null 表示凭据不足，调用方静默放弃。
 */
export function resolveAutoRenameTarget(
  settings: any,
  fallback?: { baseUrl?: string; apiKey?: string; model?: string },
): AutoRenameTarget | null {
  const list: any[] = Array.isArray(settings?.platforms) ? settings.platforms : [];
  const currentId = String(settings?.activePlatformId || "");
  const current = list.find((p) => p && p.id === currentId) || list[0] || null;
  const wantedId = String(settings?.autoRenamePlatformId || "").trim();
  const explicit = wantedId ? list.find((p) => p && p.id === wantedId) || null : null;

  if (!explicit) {
    const baseUrl = String(fallback?.baseUrl ?? settings?.baseUrl ?? current?.baseUrl ?? "").trim();
    const apiKey = String(fallback?.apiKey ?? settings?.apiKey ?? current?.apiKey ?? "");
    const model = String(fallback?.model ?? settings?.model ?? current?.models?.[0] ?? "").trim();
    if (!baseUrl || !model) return null;
    return { baseUrl, apiKey, model, platformId: "" };
  }

  const models: string[] = Array.isArray(explicit.models)
    ? explicit.models.map((m: unknown) => String(m || "").trim()).filter(Boolean)
    : [];
  const wantedModel = String(settings?.autoRenameModel || "").trim();
  const model = models.includes(wantedModel) ? wantedModel : (models[0] || "");
  const baseUrl = String(explicit.baseUrl || "").trim();
  if (!baseUrl || !model) return null;
  return { baseUrl, apiKey: String(explicit.apiKey || ""), model, platformId: explicit.id };
}

/**
 * 覆盖守卫：只有「标题仍是本地生成、且内容没被改过」才允许写入 AI 标题。
 * 旧版本会话没有 titleSource（undefined）→ 一律不动；用户手动改过 → user；
 * 已经命名过 → ai。三者都返回 false。
 */
export function shouldApplyAutoTitle(
  session: { title?: unknown; titleSource?: unknown } | null | undefined,
  baseTitle: unknown,
): boolean {
  if (!session) return false;
  const base = String(baseTitle ?? "").trim();
  if (!base) return false;
  return session.titleSource === "local" && String(session.title ?? "").trim() === base;
}
