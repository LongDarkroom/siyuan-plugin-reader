import { logSwallow } from "../../core/safe.ts";
import {
  KNOWLEDGE_MIN_CHARS as MIN_KNOWLEDGE_CHARS,
  KNOWLEDGE_MAX_CHARS as MAX_KNOWLEDGE_CHARS,
} from "./ai-knowledge.ts";
import { MINDMAP_SYNTAX_HINT } from "./ai-mindmap.ts";
import { normalizeReadRange, rangeLabel, rangeSpan, type AiReadRange } from "./ai-toc.ts";
/**
 * AI 阅读面板 · 纯逻辑层（P0）
 * ------------------------------------------------------------------
 * 只放「不碰 DOM、不碰网络」的可单测逻辑：
 *  - 面板偏好（宽度 / 上下文预算 / 历史轮数 / 思考区）归一与持久化键；
 *  - AI 凭据合并：顶层 baseUrl/apiKey 是激活平台的镜像，改一处必须同步两边，
 *    否则 normalizeAiSettings 会用旧平台值把新值盖掉（见 ai-settings.ts 注释）；
 *  - 阅读上下文与系统提示词组装（章节段落 → 带编号的纯文本块）；
 *  - 聊天记录归一 / 截断（localStorage 恢复与落盘共用）。
 *
 * 刻意不 import Svelte / siyuan：本文件要能在 node 测试里直接跑。
 */

/** 面板偏好持久化键（localStorage；不属于插件数据，卸载插件即清） */
export const AI_PANEL_PREFS_KEY = "reword-reader-ai-prefs";

export interface AiPanelPrefs {
  /** 右侧停靠宽度（px）。手机断点走全屏覆盖，不读此值 */
  width: number;
  /** 单次注入的章节正文字符上限（越小越省钱、越容易丢上下文） */
  contextChars: number;
  /** 知识区单次注入的字符上限（P2） */
  knowledgeChars: number;
  /** 随请求携带的历史轮数（user+assistant 各算一条） */
  historyTurns: number;
  /** 是否展开模型思考过程（reasoning_content） */
  showReasoning: boolean;
  /** 默认上下文范围：本页 / 本章（P4，发送时可临时切换） */
  contextScope: AiContextScope;
}

export const AI_CONTEXT_SCOPES = ["page", "chapter", "range"] as const;
/** 单轮实际使用的范围：本页 / 本章 / 用户从目录里选的章节范围 */
export type AiTurnScope = (typeof AI_CONTEXT_SCOPES)[number];
/** 偏好里只允许本页/本章（范围是一次性选择，不该被记住） */
export type AiContextScope = "page" | "chapter";

/** 脏数据/旧版本缺字段时回落到本章 */
export function normalizeContextScope(v: unknown, fallback: AiContextScope = "chapter"): AiContextScope {
  return v === "page" || v === "chapter" ? v : fallback;
}

export function normalizeTurnScope(v: unknown, fallback: AiTurnScope = "chapter"): AiTurnScope {
  return v === "page" || v === "chapter" || v === "range" ? v : fallback;
}

export function contextScopeLabel(scope: AiTurnScope | null | undefined): string {
  if (scope === "page") return "本页";
  return scope === "range" ? "目录范围" : "本章";
}

export const DEFAULT_AI_PANEL_PREFS: AiPanelPrefs = {
  width: 420,
  contextChars: 12000,
  knowledgeChars: 6000,
  historyTurns: 6,
  showReasoning: true,
  contextScope: "chapter",
};

/** 宽度下限：再窄输入框与正文都没法看；上限给到正文仍保留 ~420px 的最大值 */
export const MIN_PANEL_WIDTH = 340;
/**
 * 持久化上限。实际拖拽还会按视口夹紧（`window.innerWidth - MIN_STAGE_WIDTH`）：
 * 大屏可以拉到半屏以上，小屏不会被挤到正文完全看不见。
 */
export const MAX_PANEL_WIDTH = 1000;
/** 分屏时正文至少保留的宽度（拖拽时用） */
export const MIN_STAGE_WIDTH = 420;
export const MIN_CONTEXT_CHARS = 2000;
export const MAX_CONTEXT_CHARS = 40000;
export const MAX_HISTORY_TURNS = 12;
/** 单条消息落盘上限（避免 localStorage 撑爆） */
export const MAX_PERSISTED_MESSAGES = 40;
export const MAX_MESSAGE_CHARS = 60000;

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** 容错归一化面板偏好（脏数据不抛错，缺字段用默认） */
export function normalizeAiPanelPrefs(raw: any): AiPanelPrefs {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    width: clampInt(r.width, MIN_PANEL_WIDTH, MAX_PANEL_WIDTH, DEFAULT_AI_PANEL_PREFS.width),
    contextChars: clampInt(r.contextChars, MIN_CONTEXT_CHARS, MAX_CONTEXT_CHARS, DEFAULT_AI_PANEL_PREFS.contextChars),
    knowledgeChars: clampInt(r.knowledgeChars, MIN_KNOWLEDGE_CHARS, MAX_KNOWLEDGE_CHARS, DEFAULT_AI_PANEL_PREFS.knowledgeChars),
    historyTurns: clampInt(r.historyTurns, 0, MAX_HISTORY_TURNS, DEFAULT_AI_PANEL_PREFS.historyTurns),
    showReasoning: typeof r.showReasoning === "boolean" ? r.showReasoning : DEFAULT_AI_PANEL_PREFS.showReasoning,
    contextScope: normalizeContextScope(r.contextScope),
  };
}

export function loadAiPanelPrefs(storage: Storage | null | undefined): AiPanelPrefs {
  try {
    const raw = storage?.getItem(AI_PANEL_PREFS_KEY);
    return normalizeAiPanelPrefs(raw ? JSON.parse(raw) : null);
  } catch (__swallowErr) { logSwallow(__swallowErr, "ai-panel-logic.ts · loadAiPanelPrefs", "debug"); }
  return { ...DEFAULT_AI_PANEL_PREFS };
}

export function saveAiPanelPrefs(storage: Storage | null | undefined, prefs: AiPanelPrefs): void {
  try {
    storage?.setItem(AI_PANEL_PREFS_KEY, JSON.stringify(normalizeAiPanelPrefs(prefs)));
  } catch (__swallowErr) { logSwallow(__swallowErr, "ai-panel-logic.ts · saveAiPanelPrefs", "debug"); }
}

/* ============================ 对话消息 ============================ */

export interface AiChatQuote {
  text: string;
  sectionIndex?: number;
  chapterTitle?: string;
}

export interface AiChatContextNote {
  /** 本轮上下文范围：本页 / 本章 / 目录范围 */
  scope?: AiTurnScope;
  /** PDF 页码（1 起）；文字版书籍的「本页」没有页码 */
  page?: number;
  totalPages?: number;
  chapterTitle?: string;
  sectionIndex?: number;
  totalSections?: number;
  /** 目录范围（0 起，闭区间）+ 实际读入章数 / 用户选择章数 */
  rangeFrom?: number;
  rangeTo?: number;
  rangeChapters?: number;
  rangeSelected?: number;
  chars?: number;
  paragraphs?: number;
  truncated?: boolean;
  /** 本轮实际注入的知识区字数（P2） */
  knowledgeChars?: number;
  knowledgeTitle?: string;
  knowledgeTruncated?: boolean;
}

/** 助手消息写入思源后的回执（P2：笔记方案） */
export interface AiChatNoteReceipt {
  title: string;
  docId: string;
  docTitle?: string;
  at: number;
}

export interface AiChatToolTrace {
  /** 已本地化的一句话，如「读取第 3 章」 */
  label: string;
  ok: boolean;
  error?: string;
}

export interface AiChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  /** 用户消息附带的原文选段 */
  quote?: AiChatQuote;
  /** 本轮上下文范围（用户消息；重新生成时复用） */
  scope?: AiTurnScope;
  /** 目录范围（scope=range 时有效；重新生成时复用） */
  range?: AiReadRange;
  /** 本轮是否注入知识区（用户消息；重新生成时复用） */
  useKnowledge?: boolean;
  /** 本轮实际喂给模型的章节上下文摘要（助手消息展示一行凭据） */
  context?: AiChatContextNote;
  /** 助手本轮调用过的阅读工具（只读，按执行顺序） */
  tools?: AiChatToolTrace[];
  /** 已写入思源的笔记回执（写入成功后置位，重开面板仍显示） */
  note?: AiChatNoteReceipt;
  reasoning?: string;
  error?: boolean;
  aborted?: boolean;
}

let msgSeq = 0;
export function newMessageId(): string {
  msgSeq = (msgSeq + 1) % 1_000_000;
  return `m${Date.now().toString(36)}${msgSeq.toString(36)}`;
}

function str(v: unknown, max = MAX_MESSAGE_CHARS): string {
  if (typeof v !== "string") return "";
  return v.length > max ? v.slice(0, max) : v;
}

function normalizeQuote(raw: any): AiChatQuote | undefined {
  const text = str(raw?.text, 4000).trim();
  if (!text) return undefined;
  const out: AiChatQuote = { text };
  if (typeof raw?.chapterTitle === "string" && raw.chapterTitle.trim()) out.chapterTitle = raw.chapterTitle.trim();
  const idx = Number(raw?.sectionIndex);
  if (Number.isFinite(idx)) out.sectionIndex = idx;
  return out;
}

function normalizeContextNote(raw: any): AiChatContextNote | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: AiChatContextNote = {};
  if (raw.scope === "page" || raw.scope === "chapter" || raw.scope === "range") out.scope = raw.scope;
  if (typeof raw.chapterTitle === "string" && raw.chapterTitle.trim()) out.chapterTitle = raw.chapterTitle.trim();
  for (const k of [
    "page",
    "totalPages",
    "sectionIndex",
    "totalSections",
    "chars",
    "paragraphs",
    "knowledgeChars",
    "rangeFrom",
    "rangeTo",
    "rangeChapters",
    "rangeSelected",
  ] as const) {
    const n = Number(raw[k]);
    if (Number.isFinite(n)) out[k] = n;
  }
  // 范围的 from/to 必须是合法闭区间，否则整段丢弃（避免回执出现「第 5–3 章」）
  if (out.rangeFrom !== undefined && out.rangeTo !== undefined) {
    const r = normalizeReadRange({ from: out.rangeFrom, to: out.rangeTo });
    if (r) {
      out.rangeFrom = r.from;
      out.rangeTo = r.to;
    } else {
      delete out.rangeFrom;
      delete out.rangeTo;
    }
  }
  if (typeof raw.knowledgeTitle === "string" && raw.knowledgeTitle.trim()) {
    out.knowledgeTitle = raw.knowledgeTitle.trim().slice(0, 200);
  }
  if (typeof raw.truncated === "boolean") out.truncated = raw.truncated;
  if (typeof raw.knowledgeTruncated === "boolean") out.knowledgeTruncated = raw.knowledgeTruncated;
  return Object.keys(out).length ? out : undefined;
}

function normalizeNoteReceipt(raw: any): AiChatNoteReceipt | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const title = str(raw.title, 200).trim();
  const docId = str(raw.docId, 64).trim();
  if (!title || !docId) return undefined;
  const out: AiChatNoteReceipt = {
    title,
    docId,
    at: Number.isFinite(Number(raw.at)) ? Number(raw.at) : Date.now(),
  };
  const docTitle = str(raw.docTitle, 200).trim();
  if (docTitle) out.docTitle = docTitle;
  return out;
}

function normalizeToolTraces(raw: any): AiChatToolTrace[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: AiChatToolTrace[] = [];
  for (const t of raw.slice(0, 20)) {
    const label = str(t?.label, 120).trim();
    if (!label) continue;
    const item: AiChatToolTrace = { label, ok: t?.ok !== false };
    if (!item.ok) item.error = str(t?.error, 200).trim() || undefined;
    out.push(item);
  }
  return out.length ? out : undefined;
}

/** 恢复/落盘前的消息归一：丢坏数据、限长、去空消息、保序 */
export function normalizeChatMessages(raw: any, limit = MAX_PERSISTED_MESSAGES): AiChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: AiChatMessage[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    if (m.role !== "user" && m.role !== "assistant") continue;
    const content = str(m.content);
    const quote = normalizeQuote(m.quote);
    const tools = normalizeToolTraces(m.tools);
    if (!content.trim() && !quote && !tools) continue;
    const msg: AiChatMessage = {
      id: typeof m.id === "string" && m.id ? m.id : newMessageId(),
      role: m.role,
      content,
      createdAt: Number.isFinite(Number(m.createdAt)) ? Number(m.createdAt) : Date.now(),
    };
    if (quote) msg.quote = quote;
    if (m.scope === "page" || m.scope === "chapter" || m.scope === "range") msg.scope = m.scope;
    const range = normalizeReadRange(m.range);
    if (range) msg.range = range;
    if (typeof m.useKnowledge === "boolean") msg.useKnowledge = m.useKnowledge;
    const ctx = normalizeContextNote(m.context);
    if (ctx) msg.context = ctx;
    if (tools) msg.tools = tools;
    const note = normalizeNoteReceipt(m.note);
    if (note) msg.note = note;
    if (typeof m.reasoning === "string" && m.reasoning.trim()) msg.reasoning = str(m.reasoning, 20000);
    if (m.error === true) msg.error = true;
    if (m.aborted === true) msg.aborted = true;
    out.push(msg);
  }
  return out.slice(-Math.max(1, limit));
}

export function chatStorageKey(bookId: string): string {
  return `reword-reader-ai-chat:${bookId || "unknown"}`;
}

export function loadChatMessages(storage: Storage | null | undefined, bookId: string): AiChatMessage[] {
  try {
    const raw = storage?.getItem(chatStorageKey(bookId));
    return raw ? normalizeChatMessages(JSON.parse(raw)) : [];
  } catch (__swallowErr) { logSwallow(__swallowErr, "ai-panel-logic.ts · loadChatMessages", "debug"); }
  return [];
}

export function saveChatMessages(storage: Storage | null | undefined, bookId: string, messages: AiChatMessage[]): void {
  try {
    const clean = normalizeChatMessages(messages).map((m) => {
      // 思考过程体积大且只对当场有价值，落盘时丢弃
      const { reasoning, ...rest } = m;
      return rest;
    });
    storage?.setItem(chatStorageKey(bookId), JSON.stringify(clean));
  } catch (__swallowErr) { logSwallow(__swallowErr, "ai-panel-logic.ts · saveChatMessages", "debug"); }
}

/* ============================ 提示词与上下文 ============================ */

export interface ChapterSnapshotLike {
  ok?: boolean;
  /** 快照范围：本页 / 本章 / 目录范围（宿主明确告知，面板据此展示回执） */
  scope?: AiTurnScope;
  page?: number;
  totalPages?: number;
  title?: string;
  chapterTitle?: string;
  sectionIndex?: number;
  totalSections?: number;
  totalParagraphs?: number;
  paragraphs?: Array<{ i: number; text: string }>;
  truncated?: boolean;
}

export interface ChapterContext {
  text: string;
  chars: number;
  paragraphs: number;
  truncated: boolean;
}

/**
 * 把章节快照拼成带段落编号的纯文本块。
 * 编号用 `[i]`（快照里的原段落下标 +1），便于模型引用「第 N 段」，
 * 也便于后续 P1 把引用映射回 CFI。
 */
export function buildChapterContext(snap: ChapterSnapshotLike | null | undefined, maxChars: number): ChapterContext {
  const paras = Array.isArray(snap?.paragraphs) ? snap!.paragraphs! : [];
  const budget = Math.max(500, Number(maxChars) || DEFAULT_AI_PANEL_PREFS.contextChars);
  const lines: string[] = [];
  let used = 0;
  let kept = 0;
  for (const p of paras) {
    const text = String(p?.text || "").trim();
    if (!text) continue;
    const line = `[${(Number(p.i) || 0) + 1}] ${text}`;
    if (kept > 0 && used + line.length > budget) break;
    const clipped = line.length > budget && kept === 0 ? line.slice(0, budget) + "…" : line;
    lines.push(clipped);
    used += clipped.length;
    kept++;
    if (used >= budget) break;
  }
  const total = Math.max(paras.length, Number(snap?.totalParagraphs) || 0);
  const truncated = !!snap?.truncated || kept < total;
  return { text: lines.join("\n"), chars: used, paragraphs: kept, truncated };
}

/** 本书前提上下文（book-primer）注入上限：它是「译法/人物」备忘，不是正文 */
export const MAX_PRIMER_CHARS = 2000;

export interface ReaderPromptInput {
  bookTitle?: string;
  author?: string;
  chapterTitle?: string;
  sectionIndex?: number;
  totalSections?: number;
  primer?: string;
  /** 本轮上下文范围（默认本章） */
  scope?: AiTurnScope;
  page?: number;
  totalPages?: number;
  /** scope=range：用户选择的闭区间 + 实际读入章数 */
  range?: AiReadRange;
  rangeChapters?: number;
}

const READER_SYSTEM_PROMPT = `你是嵌入在「RE 阅读器」里的阅读助手，只讨论用户正在读的这本书与阅读方法。

【工作方式】
- 用户消息里的 <book> 是当前范围原文（[n] 为段号）；<quote> 是用户选中的原文。
- <book scope="page"> 只包含用户当前可见的一页：不要假装读过整章，也不要引用本页之外的内容；信息不足时明确说明，并建议用户切到「本章」。
- <book scope="chapter"> 是当前整章原文，可以按段号引用章内任意位置。
- <book scope="range"> 是用户从目录里主动选的连续几章（可能跨过未读章节）。多章按【第 n 章 · 标题】分隔，段号在各章内重新计数；只引用 <book> 里实际出现的正文，范围外或标注「仅显示前 n 段」的后续内容不要编造，需要时调用阅读工具续读。
- 只根据给定原文与通用常识回答；原文没写的内容不要编造。需要推断时明确写「推断」。
- 引用原文必须逐字来自 <book>/<quote>，用 Markdown 引用块（>），并在段尾标注「（第 n 段）」。
- 回答保持精炼：先给结论，再给必要的解释；除非用户要求，不要长篇复述原文。
- 用户用中文提问就用中文回答，用其他语言提问就用对应语言回答。
- 输出 Markdown：可用有序/无序列表、表格、行内代码、公式、加粗。不要输出 HTML。

${MINDMAP_SYNTAX_HINT}`;

/** 组装系统提示词（阅读器身份 + 书/章元信息 + 本书前提） */
export function buildReaderSystemPrompt(input: ReaderPromptInput = {}): string {
  const lines = [READER_SYSTEM_PROMPT];
  const scope = normalizeTurnScope(input.scope);
  const meta: string[] = [];
  if (input.bookTitle) meta.push(`书名：${input.bookTitle}`);
  if (input.author) meta.push(`作者：${input.author}`);
  if (input.chapterTitle) meta.push(`当前章节：${input.chapterTitle}`);
  if (Number.isFinite(input.sectionIndex) && Number.isFinite(input.totalSections)) {
    meta.push(`章节位置：第 ${(Number(input.sectionIndex) || 0) + 1} / ${input.totalSections} 章`);
  }
  if (scope === "page") {
    meta.push(
      Number.isFinite(input.page)
        ? `当前范围：本页（第 ${input.page}${Number.isFinite(input.totalPages) ? ` / ${input.totalPages}` : ""} 页）`
        : "当前范围：本页（只含当前可见内容）",
    );
  } else if (scope === "range" && input.range) {
    const picked = rangeSpan(input.range);
    const read = Number.isFinite(input.rangeChapters) ? Math.max(0, Math.floor(Number(input.rangeChapters))) : picked;
    const tail = read > 0 && read < picked ? `；本次只含前 ${read} 章，其余可用 reader_get_range 续读` : "";
    meta.push(`当前范围：${rangeLabel(input.range)}（用户主动选定的目录范围，共 ${picked} 章${tail}）`);
  } else {
    meta.push("当前范围：本章");
  }
  if (meta.length) lines.push(`【本书信息】\n${meta.join("\n")}`);
  const primer = String(input.primer || "").trim();
  if (primer) {
    const clipped = primer.length > MAX_PRIMER_CHARS ? primer.slice(0, MAX_PRIMER_CHARS) + "…" : primer;
    lines.push(`【用户为本书写的前提（人物/译名/背景，回答时以此为准）】\n${clipped}`);
  }
  return lines.join("\n\n");
}

export interface BuildUserTurnInput {
  question: string;
  quote?: AiChatQuote | null;
  chapter?: ChapterContext | null;
  chapterTitle?: string;
  sectionIndex?: number;
  totalSections?: number;
  /** 上下文范围（默认本章） */
  scope?: AiTurnScope;
  page?: number;
  totalPages?: number;
  /** scope=range：用户选择的闭区间 + 实际读入章数 */
  range?: AiReadRange;
  rangeChapters?: number;
}

/** 组装单轮 user 消息：上下文 + 选段 + 问题（标签化，降低提示注入成功率） */
export function buildUserTurnContent(input: BuildUserTurnInput): string {
  const parts: string[] = [];
  const ctx = input.chapter;
  if (ctx && ctx.text) {
    const scope = normalizeTurnScope(input.scope);
    const attrs = [
      `scope="${scope}"`,
      scope === "page" && Number.isFinite(input.page) ? `page="${input.page}"` : "",
      scope === "page" && Number.isFinite(input.totalPages) ? `pages="${input.totalPages}"` : "",
      scope === "range" && input.range ? `from="${input.range.from + 1}"` : "",
      scope === "range" && input.range ? `to="${input.range.to + 1}"` : "",
      scope === "range" && Number.isFinite(input.rangeChapters) ? `chapters="${input.rangeChapters}"` : "",
      input.chapterTitle ? `chapter="${escapeAttr(input.chapterTitle)}"` : "",
      Number.isFinite(input.sectionIndex) ? `section="${(Number(input.sectionIndex) || 0) + 1}"` : "",
      Number.isFinite(input.totalSections) ? `total="${input.totalSections}"` : "",
      ctx.truncated ? `truncated="true"` : "",
    ].filter(Boolean).join(" ");
    parts.push(`<book ${attrs}>\n${ctx.text}\n</book>`);
  }
  const q = String(input.quote?.text || "").trim();
  if (q) parts.push(`<quote>\n${q}\n</quote>`);
  parts.push(String(input.question || "").trim());
  return parts.join("\n\n");
}

function escapeAttr(s: string): string {
  return String(s || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface EngineChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** 取最近 N 条成功的对话（错误/中断回复不进上下文，避免模型学坏） */
export function pickHistory(messages: AiChatMessage[], turns: number): EngineChatMessage[] {
  const max = Math.max(0, Math.round(Number(turns) || 0));
  if (!max) return [];
  const usable = messages.filter((m) => !m.error && !m.aborted && m.content.trim());
  return usable.slice(-max).map((m) => ({ role: m.role, content: m.content }));
}

/** 组装发给模型的完整 messages（system + 历史 + 本轮） */
export function buildChatRequestMessages(opts: {
  systemPrompt: string;
  history: EngineChatMessage[];
  userContent: string;
}): EngineChatMessage[] {
  const out: EngineChatMessage[] = [];
  if (opts.systemPrompt) out.push({ role: "system", content: opts.systemPrompt });
  for (const m of opts.history || []) out.push(m);
  out.push({ role: "user", content: opts.userContent });
  return out;
}

/* ============================ AI 凭据 ============================ */

export interface AiCredentialView {
  baseUrl: string;
  apiKey: string;
  model: string;
  models: string[];
  temperature: number;
  maxTokens: number;
  platforms?: any[];
  activePlatformId?: string;
}

export function pickActivePlatform(settings: any): any {
  const list: any[] = Array.isArray(settings?.platforms) ? settings.platforms : [];
  if (!list.length) return undefined;
  return list.find((p) => p?.id === settings?.activePlatformId) || list[0];
}

/** 面板展示/请求用的窄化视图：激活平台的镜像优先 */
export function toAiCredentialView(settings: any): AiCredentialView {
  const plat = pickActivePlatform(settings);
  const models = Array.isArray(plat?.models) && plat.models.length
    ? plat.models
    : Array.isArray(settings?.models)
      ? settings.models
      : [];
  const model = String(settings?.model || models[0] || "").trim();
  return {
    baseUrl: String(plat?.baseUrl || settings?.baseUrl || "").trim(),
    apiKey: String(plat?.apiKey || settings?.apiKey || "").trim(),
    model,
    models: models.map((m: any) => String(m)).filter(Boolean),
    temperature: Number.isFinite(Number(settings?.temperature)) ? Number(settings.temperature) : 0.3,
    maxTokens: Number.isFinite(Number(settings?.maxTokens)) ? Number(settings.maxTokens) : 2048,
    platforms: Array.isArray(settings?.platforms) ? settings.platforms : undefined,
    activePlatformId: settings?.activePlatformId,
  };
}

/** 是否具备发起请求的最低配置（本地 LLM 常不校验 Key，故 apiKey 不作硬门槛） */
export function isAiReady(s: AiCredentialView): boolean {
  return !!(s.baseUrl && s.model);
}

export interface AiCredentialPatch {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  models?: string[];
  temperature?: number;
  maxTokens?: number;
}

/**
 * 合并凭据修改。
 * 关键点：顶层 baseUrl/apiKey 与激活平台必须**同时**写 ——
 * normalizeAiSettings 会用 platforms 覆盖顶层镜像，只改顶层会在下一次保存时丢失。
 * 返回可直接交给 plugin.updateAiSettings 的 patch。
 */
export function mergeAiCredentials(settings: any, patch: AiCredentialPatch): Record<string, any> {
  const current = toAiCredentialView(settings);
  const baseUrl = patch.baseUrl !== undefined ? String(patch.baseUrl).trim().replace(/\/+$/, "") : current.baseUrl;
  const apiKey = patch.apiKey !== undefined ? String(patch.apiKey).trim() : current.apiKey;
  const model = patch.model !== undefined ? String(patch.model).trim() : current.model;
  let models = patch.models !== undefined ? patch.models.map((m) => String(m).trim()).filter(Boolean) : current.models.slice();
  models = Array.from(new Set(models));
  if (model && !models.includes(model)) models = [model, ...models];
  const temperature = patch.temperature !== undefined
    ? Math.min(2, Math.max(0, Number(patch.temperature) || 0))
    : current.temperature;
  const maxTokens = patch.maxTokens !== undefined
    ? Math.min(32768, Math.max(16, Math.round(Number(patch.maxTokens) || 2048)))
    : current.maxTokens;

  const platforms: any[] = (current.platforms || []).map((p) => ({ ...p }));
  let activePlatformId = current.activePlatformId || "";
  if (!platforms.length) {
    platforms.push({
      id: "reader-ai",
      name: "阅读 AI",
      baseUrl,
      apiKey,
      models,
      modelParams: {},
    });
    activePlatformId = "reader-ai";
  } else {
    const at = platforms.findIndex((p) => p.id === activePlatformId);
    const target = at >= 0 ? platforms[at] : platforms[0];
    target.baseUrl = baseUrl;
    target.apiKey = apiKey;
    target.models = models;
    if (!activePlatformId) activePlatformId = target.id;
  }

  return {
    baseUrl,
    apiKey,
    model,
    models,
    temperature,
    maxTokens,
    platforms,
    activePlatformId,
  };
}

/* ============================ 展示辅助 ============================ */

/** 引用 chip 文案：章节 + 选段前 24 字 */
export function quoteChipLabel(q: AiChatQuote | null | undefined): string {
  const text = String(q?.text || "").replace(/\s+/g, " ").trim();
  const head = text.length > 24 ? text.slice(0, 24) + "…" : text;
  const chapter = String(q?.chapterTitle || "").trim();
  return chapter ? `${chapter} · ${head}` : head;
}

/* ============================ 对话时间轴 ============================ */

export type ChatDayMarker =
  | { kind: "today" }
  | { kind: "yesterday" }
  | { kind: "date"; year: number; month: number; day: number };

/** 消息日分隔：今天 / 昨天 / 具体日期。文案由面板翻译。 */
export function chatDayMarker(at: number, now = Date.now()): ChatDayMarker | null {
  const d = new Date(at);
  const n = new Date(now);
  if (!Number.isFinite(d.getTime())) return null;
  const dayStart = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((dayStart(n) - dayStart(d)) / 86_400_000);
  if (days <= 0) return { kind: "today" };
  if (days === 1) return { kind: "yesterday" };
  return { kind: "date", year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}

/** 两条消息是否同一天；任一时间无效时返回 false（宁可多插一条分隔） */
export function sameChatDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  if (!Number.isFinite(x.getTime()) || !Number.isFinite(y.getTime())) return false;
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/** 上下文凭据行：「本页 · 1,200 字」/「第 3 章 · 12,480 字（已截断）」/「第 3–5 章 · 3 章 · …」 */
export function contextReceipt(note: AiChatContextNote | null | undefined): string {
  if (!note) return "";
  const parts: string[] = [];
  if (note.scope === "page") {
    parts.push("本页");
    if (note.page) parts.push(`第 ${note.page} 页`);
    if (note.chapterTitle) parts.push(note.chapterTitle);
  } else if (note.scope === "range" && note.rangeFrom !== undefined && note.rangeTo !== undefined) {
    parts.push(rangeLabel({ from: note.rangeFrom, to: note.rangeTo }));
    if (note.rangeChapters && note.rangeSelected && note.rangeChapters < note.rangeSelected) {
      parts.push(`只读前 ${note.rangeChapters} / ${note.rangeSelected} 章`);
    } else if (note.rangeChapters && note.rangeChapters > 1) {
      parts.push(`${note.rangeChapters} 章`);
    }
  } else if (note.chapterTitle) {
    parts.push(note.chapterTitle);
  }
  if (note.chars) parts.push(`${note.chars.toLocaleString()} 字`);
  if (note.truncated) parts.push("已截断");
  if (note.knowledgeChars) parts.push(`知识区 ${note.knowledgeChars.toLocaleString()} 字`);
  if (note.knowledgeTruncated) parts.push("知识区已截断");
  return parts.join(" · ");
}
