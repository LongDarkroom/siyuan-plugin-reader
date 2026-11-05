import { logSwallow } from "../../core/safe.ts";
/**
 * 笔记方案（P2-A NotePlan）
 * ------------------------------------------------------------------
 * 「把助手的一段回答整理成读书笔记并写入思源」走**预览优先**：
 *  1. 模型输出结构化方案 { title, markdown }（JSON，无代码围栏）；
 *  2. 面板解析成 NotePlan 渲染预览，用户确认后才落库；
 *  3. 写入复用本书的笔记发送目标（per-book → 全局 → 自动建档），追加到文末。
 *
 * 本文件只做纯逻辑：解析 / 提示词 / 最终 Markdown 合成，不碰思源 API。
 * 解析刻意宽松（围栏、前后缀说明、尾逗号都能吃下），但**不接受空正文**——
 * 宁可报「解析失败」也不把一句道歉写成笔记。
 */

export interface NotePlan {
  title: string;
  markdown: string;
}

export interface NotePlanMeta {
  bookTitle?: string;
  author?: string;
  chapterTitle?: string;
  /** 记录时间（ms）；缺省用当前时间 */
  createdAt?: number;
  /** 回跳原书的深链（siyuan://plugins/…）；空串则不加 */
  deepLink?: string;
}

export interface NotePlanRequestInput {
  answer: string;
  bookTitle?: string;
  author?: string;
  chapterTitle?: string;
  question?: string;
  quote?: string;
}

export const NOTE_PLAN_MAX_TITLE = 120;
export const NOTE_PLAN_MAX_MARKDOWN = 30000;
/** 喂给笔记整理请求的回答上限（回答本身已经落盘，这里只为控制成本） */
export const NOTE_PLAN_INPUT_CHARS = 16000;

export const NOTE_PLAN_SYSTEM_PROMPT = [
  "你是读书笔记整理助手。把用户给出的一段阅读助手回答，整理成一篇可直接存入思源的读书笔记。",
  "只输出一个 JSON 对象，不要代码围栏、不要任何解释：",
  '{"title":"笔记标题（不超过 30 字）","markdown":"笔记正文（思源 Markdown）"}',
  "要求：",
  "1. markdown 用 2~5 个 `## ` 小节组织，不要重复大标题；",
  "2. 保留关键结论与原文引句，引句用 `> ` 引用；不要编造回答里没有的内容；",
  "3. 可用列表、表格、`==高亮==`、`$公式$`；不要输出 YAML front matter；",
  "4. 回答里的 `((块id \"文本\"))` 块引用原样保留，不要改写 ID；",
  "5. 不要写“以下是笔记”“希望对你有帮助”这类客套话。",
].join("\n");

/** 整理请求的回答输入：去掉围栏噪音并限长（保留尾部，结论通常在后面） */
export function clipNotePlanInput(text: string): string {
  const s = String(text || "").trim();
  if (s.length <= NOTE_PLAN_INPUT_CHARS) return s;
  return "（前略）…\n" + s.slice(s.length - NOTE_PLAN_INPUT_CHARS);
}

/** 组装「把回答整理成笔记」的一次性请求（与主对话历史无关） */
export function buildNotePlanRequest(input: NotePlanRequestInput): { system: string; user: string } {
  const meta: string[] = [];
  if (input.bookTitle) meta.push(`书名：${input.bookTitle}`);
  if (input.author) meta.push(`作者：${input.author}`);
  if (input.chapterTitle) meta.push(`章节：${input.chapterTitle}`);
  const parts: string[] = [];
  if (meta.length) parts.push(`【本书信息】\n${meta.join("\n")}`);
  if (String(input.question || "").trim()) parts.push(`【用户的问题】\n${String(input.question).trim()}`);
  if (String(input.quote || "").trim()) parts.push(`【用户选中的原文】\n> ${String(input.quote).trim()}`);
  parts.push(`【需要整理的助手回答】\n${clipNotePlanInput(input.answer)}`);
  return { system: NOTE_PLAN_SYSTEM_PROMPT, user: parts.join("\n\n") };
}

/** 去掉模型偶尔加的 ```json / ```notes 围栏，返回最可能的 JSON 片段 */
function extractJsonRegion(raw: string): string {
  const text = String(raw || "").replace(/^\uFEFF/, "").trim();
  for (const m of text.matchAll(/```[a-zA-Z0-9_-]*\s*\r?\n([\s\S]*?)```/g)) {
    const inner = (m[1] || "").trim();
    if (inner.startsWith("{")) return inner;
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return "";
}

/** 宽松修复常见 JSON 小毛病：尾逗号 */
function repairJson(s: string): string {
  return s.replace(/,\s*([}\]])/g, "$1");
}

function pickPlanObject(obj: any, fallbackTitle: string): NotePlan | null {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const title = String(obj.title ?? obj.name ?? "").trim() || String(fallbackTitle || "").trim() || "读书笔记";
  const markdown = String(obj.markdown ?? obj.content ?? obj.body ?? "").trim();
  if (!markdown) return null;
  return {
    title: title.slice(0, NOTE_PLAN_MAX_TITLE),
    markdown: markdown.slice(0, NOTE_PLAN_MAX_MARKDOWN),
  };
}

/** 模型没按 JSON 输出时的兜底：有标题/列表的 Markdown 才收，客套话一律拒绝 */
function planFromPlainMarkdown(raw: string, fallbackTitle: string): NotePlan | null {
  const text = String(raw || "").trim();
  if (text.length < 80) return null;
  if (!/(^|\n)\s*(#{1,3}\s+\S|[-*]\s+\S|>\s+\S)/.test(text)) return null;
  const first = text.split(/\r?\n/, 1)[0].trim();
  const m = first.match(/^#{1,6}\s+(.+)$/);
  const title = (m?.[1] || fallbackTitle || "读书笔记").trim().slice(0, NOTE_PLAN_MAX_TITLE);
  const body = m ? text.slice(first.length).trim() : text;
  if (!body) return null;
  return { title, markdown: body.slice(0, NOTE_PLAN_MAX_MARKDOWN) };
}

/**
 * 解析模型输出为笔记方案。
 * 依次尝试：JSON（围栏内 / 首尾大括号）→ 纯 Markdown 兜底。
 * 失败返回 null，由面板提示重试（绝不把解析残片写进思源）。
 */
export function parseNotePlan(raw: string, opts: { fallbackTitle?: string } = {}): NotePlan | null {
  const fallbackTitle = String(opts.fallbackTitle || "").trim();
  const json = extractJsonRegion(raw);
  if (json) {
    try {
      const plan = pickPlanObject(JSON.parse(json), fallbackTitle);
      if (plan) return plan;
    } catch (__swallowErr) {
      logSwallow(__swallowErr, "ai-note-plan.ts · parseNotePlan · json", "debug");
    }
    try {
      const plan = pickPlanObject(JSON.parse(repairJson(json)), fallbackTitle);
      if (plan) return plan;
    } catch (__swallowErr) {
      logSwallow(__swallowErr, "ai-note-plan.ts · parseNotePlan · repair", "debug");
    }
  }
  return planFromPlainMarkdown(raw, fallbackTitle);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 本地日期（YYYY-MM-DD），写入笔记来源行用 */
export function formatNoteDate(ts: number): string {
  const d = new Date(Number.isFinite(ts) ? ts : Date.now());
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 标题是否已在正文首行（避免「# 标题 + ## 标题」重复） */
function bodyStartsWithTitle(markdown: string, title: string): boolean {
  const first = String(markdown || "").trimStart().split(/\r?\n/, 1)[0].trim();
  const m = first.match(/^#{1,6}\s+(.*)$/);
  return !!m && m[1].trim() === title.trim();
}

/**
 * 合成最终写入思源的 Markdown。
 *
 * 结构：`## 标题` + 正文 + `---` + 来源行（书/作者/章节/日期）+（可选）回原文深链。
 * ⚠️ 只追加不覆盖：调用方负责 `appendBlock`，本函数不产生破坏性内容。
 */
export function composeNoteMarkdown(plan: NotePlan, meta: NotePlanMeta = {}): string {
  const title = String(plan?.title || "").trim() || "读书笔记";
  const body = String(plan?.markdown || "").trim();
  if (!body) return "";
  const lines: string[] = [];
  if (!bodyStartsWithTitle(body, title)) lines.push(`## ${title}`, "");
  lines.push(body, "", "---");

  const src: string[] = [];
  if (meta.bookTitle) src.push(`《${meta.bookTitle}》`);
  if (meta.author) src.push(meta.author);
  if (meta.chapterTitle) src.push(meta.chapterTitle);
  const date = formatNoteDate(meta.createdAt ?? Date.now());
  if (date) src.push(date);
  if (src.length) lines.push(`> 来源：${src.join(" · ")}`);
  const link = String(meta.deepLink || "").trim();
  if (link) lines.push(`> [回原文](${link})`);
  return lines.join("\n").trim() + "\n";
}
