/**
 * AI 面板 · 本轮工具（v1）
 * ------------------------------------------------------------------
 * 用户在输入框上方勾选「本轮想让助手做什么」，面板把它翻译成两种东西：
 *  - 提示词型（mindmap / annotate）：往系统提示尾部追加一段格式要求，
 *    模型照常回答，面板在回答末尾解析围栏；
 *  - 后处理型（note）：回答落库后自动触发已有的 NotePlan 管线，先预览再写入。
 *
 * 这里只有纯逻辑（不含 Svelte / DOM / localStorage 全局），便于 node 测试。
 */

export type AiToolId = "mindmap" | "annotate" | "note";

export interface AiToolDef {
  id: AiToolId;
  label: string;
  desc: string;
  /** 必须有阅读器实例（当前章正文）才能生效 */
  needsReader: boolean;
}

export const AI_TOOLS: AiToolDef[] = [
  {
    id: "mindmap",
    label: "思维导图",
    desc: "回答末尾附一张可交互导图",
    needsReader: false,
  },
  {
    id: "annotate",
    label: "批注草稿",
    desc: "挑出原文划线，确认后写入当前章",
    needsReader: true,
  },
  {
    id: "note",
    label: "笔记草稿",
    desc: "回答后整理成笔记方案，确认后写入思源",
    needsReader: false,
  },
];

const TOOL_IDS: AiToolId[] = AI_TOOLS.map((d) => d.id);

export function isAiToolId(v: unknown): v is AiToolId {
  return typeof v === "string" && (TOOL_IDS as string[]).includes(v);
}

/** 去重并归一到定义顺序，保证同一组勾选渲染稳定 */
export function normalizeToolIds(v: unknown): AiToolId[] {
  const raw = Array.isArray(v) ? v : [];
  const set = new Set(raw.filter(isAiToolId));
  return TOOL_IDS.filter((id) => set.has(id));
}

export function toggleToolId(list: AiToolId[], id: AiToolId, on?: boolean): AiToolId[] {
  if (!isAiToolId(id)) return normalizeToolIds(list);
  const set = new Set(list);
  const want = typeof on === "boolean" ? on : !set.has(id);
  if (want) set.add(id);
  else set.delete(id);
  return TOOL_IDS.filter((x) => set.has(x));
}

/** 勾选但当前环境用不了的工具（例如没开阅读器时的批注） */
export function effectiveToolIds(list: AiToolId[], readCtx: boolean): AiToolId[] {
  const ids = normalizeToolIds(list);
  if (readCtx) return ids;
  return ids.filter((id) => !AI_TOOLS.find((d) => d.id === id)?.needsReader);
}

/* ============================ 会话内持久化 ============================ */

const TOOLS_STORE_KEY = "re-ai-tools-v1";
/** 只留最近 40 个会话，防止 localStorage 无界增长 */
const MAX_STORED_SESSIONS = 40;

interface ToolsStore {
  v: 1;
  /** sessionId → 勾选顺序；insertion order 即最近使用顺序 */
  sessions: Record<string, AiToolId[]>;
}

function readStore(store: Storage | null): ToolsStore {
  const empty: ToolsStore = { v: 1, sessions: {} };
  if (!store) return empty;
  try {
    const raw = store.getItem(TOOLS_STORE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.sessions || typeof parsed.sessions !== "object") {
      return empty;
    }
    const sessions: Record<string, AiToolId[]> = {};
    for (const [k, v] of Object.entries(parsed.sessions)) {
      if (!k) continue;
      sessions[k] = normalizeToolIds(v);
    }
    return { v: 1, sessions };
  } catch {
    return empty;
  }
}

function writeStore(store: Storage | null, data: ToolsStore): void {
  if (!store) return;
  try {
    const entries = Object.entries(data.sessions);
    const kept = entries.slice(-MAX_STORED_SESSIONS);
    store.setItem(TOOLS_STORE_KEY, JSON.stringify({ v: 1, sessions: Object.fromEntries(kept) }));
  } catch {
    /* 配额/隐私模式：工具勾选只是便利，写不进去不影响本轮 */
  }
}

export function loadSessionTools(store: Storage | null, sessionId: string): AiToolId[] {
  const id = String(sessionId || "").trim();
  if (!id) return [];
  return readStore(store).sessions[id] || [];
}

export function saveSessionTools(store: Storage | null, sessionId: string, ids: AiToolId[]): void {
  const id = String(sessionId || "").trim();
  if (!id) return;
  const data = readStore(store);
  const next = normalizeToolIds(ids);
  // 重新插入到末尾：下次裁剪时保留最近用过的会话
  delete data.sessions[id];
  if (next.length) data.sessions[id] = next;
  writeStore(store, data);
}

/* ============================ 提示词 ============================ */

export const MAX_ANNOTATE_DRAFT = 12;
export const MAX_ANNOTATE_QUOTE_CHARS = 300;

const MINDMAP_TOOL_PROMPT = `【本轮工具：思维导图】
回答末尾必须附一张思维导图（用户可直接在面板里打开）。用一个 \`\`\`mindmap 围栏：第一行写中心主题，其余用 Markdown 列表表示层级；最多 3 层、12 个节点，每个节点不超过 20 字。正文仍先给结论，导图放在最后，不要用导图重复整段正文。`;

const ANNOTATE_TOOL_PROMPT = `【本轮工具：批注草稿】
回答最后输出一个 \`\`\`re-annotations 围栏，内容为 JSON 数组，元素形如 {"quote":"原文","note":"可选备注"}。要求：
- quote 必须从 <book> 的**当前章节**正文里逐字复制，是连续的一段文字，不超过 ${MAX_ANNOTATE_QUOTE_CHARS} 字；本轮若读了多章，也只能从当前章挑，不能跨章；
- 最多 ${MAX_ANNOTATE_DRAFT} 条，优先挑真正值得划线或写备注的句子；
- note 写一句自己的理解（可选，不超过 200 字）；
- 这些只是草稿，用户确认后才会写入，不要声称已经写好了；
- 没有合适的原文时不要输出这个围栏。`;

const NOTE_TOOL_PROMPT = `【本轮工具：笔记草稿】
用户已开启「笔记草稿」。回答按便于整理成笔记的结构输出：先给结论，再用小标题/列表分层，保留关键原句；回答结束后面板会自动生成笔记方案，等待用户确认写入，不要自行声称已写入思源。`;

/** 系统提示尾部追加的本轮工具要求；没有勾选时返回空串 */
export function buildToolPrompt(ids: AiToolId[]): string {
  const set = new Set(normalizeToolIds(ids));
  const parts: string[] = [];
  if (set.has("mindmap")) parts.push(MINDMAP_TOOL_PROMPT);
  if (set.has("annotate")) parts.push(ANNOTATE_TOOL_PROMPT);
  if (set.has("note")) parts.push(NOTE_TOOL_PROMPT);
  return parts.join("\n\n");
}

/* ============================ 批注草稿围栏 ============================ */

export const ANNOTATE_FENCE = "re-annotations";

const ANNOTATE_FENCE_RE = /```re-annotations[^\n]*\n([\s\S]*?)(?:```|$)/i;

export interface AnnotationDraftItem {
  quote: string;
  note?: string;
  style?: "highlight" | "solid" | "wavy";
  color?: string;
}

export interface AnnotationDraftParse {
  found: boolean;
  items: AnnotationDraftItem[];
  error?: string;
}

function draftItemOf(raw: any): AnnotationDraftItem | null {
  if (typeof raw === "string") raw = { quote: raw };
  if (!raw || typeof raw !== "object") return null;
  const quote = String(raw.quote ?? raw.text ?? "").replace(/\s+/g, " ").trim();
  if (!quote || quote.length > MAX_ANNOTATE_QUOTE_CHARS) return null;
  const item: AnnotationDraftItem = { quote };
  const note = String(raw.note ?? "").trim();
  if (note) item.note = note.slice(0, 500);
  const style = String(raw.style ?? "").toLowerCase();
  if (style === "highlight" || style === "solid" || style === "wavy") item.style = style;
  if (/^#[0-9a-f]{6}$/i.test(String(raw.color || ""))) item.color = String(raw.color);
  return item;
}

/** 解析回答里的批注草稿围栏；围栏缺失返回 found=false，格式坏了返回 error */
export function parseAnnotationDraft(text: string): AnnotationDraftParse {
  const m = String(text || "").match(ANNOTATE_FENCE_RE);
  if (!m) return { found: false, items: [] };
  let parsed: any;
  try {
    parsed = JSON.parse(String(m[1] || "").trim());
  } catch {
    return { found: true, items: [], error: "invalid_json" };
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.items)
      ? parsed.items
      : Array.isArray(parsed?.annotations)
        ? parsed.annotations
        : null;
  if (!arr) return { found: true, items: [], error: "invalid_shape" };
  const items = arr
    .map(draftItemOf)
    .filter((x: AnnotationDraftItem | null): x is AnnotationDraftItem => !!x)
    .slice(0, MAX_ANNOTATE_DRAFT);
  return { found: true, items };
}

/** 展示/落库前去掉机器围栏，只留人读的正文（未闭合也一并去掉） */
export function stripAnnotationFence(text: string): string {
  return String(text || "")
    .replace(/```re-annotations[^\n]*\n?[\s\S]*?(?:```|$)/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 流式展示用：连未闭合的围栏一起藏掉。
 * 模型可能先吐 ```re-annotations 再慢慢写 JSON，不能让用户看到这半截机器码。
 */
export function hideAnnotationFence(text: string): string {
  return String(text || "")
    .replace(/```re-annotations[^\n]*\n?[\s\S]*?(?:```|$)/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+$/, "");
}
