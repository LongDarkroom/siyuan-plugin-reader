import { logSwallow } from "../../core/safe.ts";
import {
  chatStorageKey,
  normalizeChatMessages,
  type AiChatMessage,
  type AiChatNoteReceipt,
} from "./ai-panel-logic.ts";
/**
 * 阅读助手 · 会话存储（P4-A）
 * ------------------------------------------------------------------
 * 从「每本书一个线程」升级为「每本书多会话」：
 *  - 新建对话不再清空历史，而是新建一条会话；
 *  - 标题取首条用户问题，本地生成，不额外请求模型；
 *  - 旧版单线程键（reword-reader-ai-chat:*）首次读取时迁移成一条会话，
 *    旧键保留不删，方便回滚；
 *  - 每本书最多 20 条会话、单会话最多 40 条消息；落盘前按字符预算
 *    淘汰最旧的非当前会话，避免 localStorage 撑爆。
 *
 * 只做纯数据逻辑，不碰 DOM / Svelte / 思源 API。
 */

export const AI_SESSIONS_KEY_PREFIX = "reword-reader-ai-sessions:";
export const MAX_SESSIONS = 20;
export const MAX_SESSION_TITLE = 60;
/** 单本书会话落盘预算（JSON 字符数）；超出时从最旧的非当前会话开始淘汰 */
export const MAX_SESSION_STORAGE_CHARS = 800_000;

export interface AiChatSession {
  id: string;
  /** 空串表示尚未命名，UI 显示「新对话」 */
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: AiChatMessage[];
}

export interface AiSessionState {
  version: 1;
  activeId: string;
  sessions: AiChatSession[];
}

export interface AiSessionNote {
  note: AiChatNoteReceipt;
  sessionId: string;
  sessionTitle: string;
  /** 助手消息 id，便于 UI 定位 */
  messageId: string;
}

export type SessionDayBucket = "today" | "yesterday" | "earlier";

let sessionSeq = 0;
export function newSessionId(): string {
  sessionSeq = (sessionSeq + 1) % 1_000_000;
  return `s${Date.now().toString(36)}${sessionSeq.toString(36)}`;
}

export function sessionStorageKey(bookId: string | null | undefined): string {
  const b = String(bookId ?? "").trim();
  return AI_SESSIONS_KEY_PREFIX + (b || "unknown");
}

function asTime(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 把用户问题压成标题：折叠空白、截断、去掉纯标点尾巴 */
export function titleFromMessages(messages: AiChatMessage[], max = 28): string {
  const first = (messages || []).find((m) => m.role === "user" && String(m.content || "").trim());
  const text = String(first?.content || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const limit = Math.max(8, Math.min(MAX_SESSION_TITLE, Math.round(Number(max) || 28)));
  if (text.length <= limit) return text;
  return text.slice(0, limit).replace(/[，。！？、,.!?；;：:…\s]+$/, "") + "…";
}

export function createSession(messages: AiChatMessage[] = [], now = Date.now(), title = ""): AiChatSession {
  const list = normalizeChatMessages(messages);
  const created = list.length ? asTime(list[0]?.createdAt, now) : now;
  const updated = list.length ? asTime(list[list.length - 1]?.createdAt, now) : now;
  return {
    id: newSessionId(),
    title: String(title || titleFromMessages(list)).trim().slice(0, MAX_SESSION_TITLE),
    createdAt: created,
    updatedAt: Math.max(created, updated),
    messages: list,
  };
}

/** 追加/更新消息后刷新会话：标题只在空的时候自动生成，用户改过的标题不覆盖 */
export function touchSession(
  session: AiChatSession,
  messages: AiChatMessage[],
  now = Date.now(),
): AiChatSession {
  const list = normalizeChatMessages(messages);
  return {
    ...session,
    title: session.title || titleFromMessages(list),
    updatedAt: Math.max(session.updatedAt, now),
    messages: list,
  };
}

export function renameSession(session: AiChatSession, title: string): AiChatSession {
  const next = String(title || "").replace(/\s+/g, " ").trim().slice(0, MAX_SESSION_TITLE);
  return { ...session, title: next || session.title };
}

function normalizeSession(raw: any, now: number): AiChatSession | null {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim().slice(0, 64) : newSessionId();
  const messages = normalizeChatMessages(raw.messages);
  const created = asTime(raw.createdAt, messages[0]?.createdAt || now);
  const updated = Math.max(created, asTime(raw.updatedAt, messages[messages.length - 1]?.createdAt || now));
  const title = String(raw.title || "").replace(/\s+/g, " ").trim().slice(0, MAX_SESSION_TITLE);
  return {
    id,
    title: title || titleFromMessages(messages),
    createdAt: created,
    updatedAt: updated,
    messages,
  };
}

export function emptySessionState(): AiSessionState {
  return { version: 1, activeId: "", sessions: [] };
}

/** 容错归一：坏数据丢弃、id 去重、按最近更新排序、限制会话数 */
export function normalizeSessionState(raw: any, now = Date.now()): AiSessionState {
  const src = raw && typeof raw === "object" ? raw : {};
  const out: AiChatSession[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(src.sessions) ? src.sessions : []) {
    const s = normalizeSession(item, now);
    if (!s || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  const sessions = out.slice(0, MAX_SESSIONS);
  const wanted = typeof src.activeId === "string" ? src.activeId : "";
  const activeId = sessions.some((s) => s.id === wanted) ? wanted : (sessions[0]?.id || "");
  return { version: 1, activeId, sessions };
}

function stateChars(state: AiSessionState): number {
  try {
    return JSON.stringify(state).length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** 超出预算时淘汰最旧的非当前会话；当前会话永远保留 */
export function trimSessionState(state: AiSessionState): AiSessionState {
  const next: AiSessionState = {
    version: 1,
    activeId: state.activeId,
    sessions: state.sessions.map((s) => ({ ...s, messages: s.messages.slice() })),
  };
  let chars = stateChars(next);
  while (chars > MAX_SESSION_STORAGE_CHARS) {
    const candidates = next.sessions.filter((s) => s.id !== next.activeId);
    if (!candidates.length) break;
    candidates.sort((a, b) => a.updatedAt - b.updatedAt);
    const dropId = candidates[0].id;
    next.sessions = next.sessions.filter((s) => s.id !== dropId);
    chars = stateChars(next);
  }
  if (!next.sessions.some((s) => s.id === next.activeId)) {
    next.activeId = next.sessions[0]?.id || "";
  }
  return next;
}

export function loadSessionState(
  storage: Storage | null | undefined,
  bookId: string | null | undefined,
): AiSessionState {
  try {
    const raw = storage?.getItem(sessionStorageKey(bookId));
    if (raw) return normalizeSessionState(JSON.parse(raw));
  } catch (__swallowErr) {
    logSwallow(__swallowErr, "ai-session-store.ts · loadSessionState", "debug");
  }
  // 新键不存在（或损坏）→ 尝试把旧版单线程迁移成一条会话
  try {
    const legacyRaw = storage?.getItem(chatStorageKey(String(bookId || "")));
    if (legacyRaw) {
      const legacy = normalizeChatMessages(JSON.parse(legacyRaw));
      if (legacy.length) {
        const session = createSession(legacy);
        const state: AiSessionState = { version: 1, activeId: session.id, sessions: [session] };
        saveSessionState(storage, bookId, state);
        return state;
      }
    }
  } catch (__swallowErr) {
    logSwallow(__swallowErr, "ai-session-store.ts · loadSessionState · migrate", "debug");
  }
  return emptySessionState();
}

export function saveSessionState(
  storage: Storage | null | undefined,
  bookId: string | null | undefined,
  state: AiSessionState,
): AiSessionState {
  const clean = trimSessionState(normalizeSessionState(state));
  try {
    storage?.setItem(sessionStorageKey(bookId), JSON.stringify(clean));
  } catch (__swallowErr) {
    logSwallow(__swallowErr, "ai-session-store.ts · saveSessionState", "debug");
  }
  return clean;
}

/** 切换/新建/删除后统一收口 activeId */
export function withActiveSession(state: AiSessionState, id: string): AiSessionState {
  const activeId = state.sessions.some((s) => s.id === id) ? id : (state.sessions[0]?.id || "");
  return { ...state, activeId };
}

/** 删除会话；删的是当前会话时落到下一条（最近更新优先），没有就留空 */
export function removeSession(state: AiSessionState, id: string): AiSessionState {
  const sessions = state.sessions.filter((s) => s.id !== id);
  const activeId = state.activeId === id ? (sessions[0]?.id || "") : state.activeId;
  return { version: 1, activeId, sessions };
}

export function upsertSession(state: AiSessionState, session: AiChatSession): AiSessionState {
  const rest = state.sessions.filter((s) => s.id !== session.id);
  return normalizeSessionState({ ...state, sessions: [session, ...rest] });
}

/** 笔记 Tab 用：跨会话汇总所有「已存为笔记」回执，新→旧 */
export function collectSessionNotes(state: AiSessionState | null | undefined): AiSessionNote[] {
  const out: AiSessionNote[] = [];
  for (const s of state?.sessions || []) {
    const title = s.title || titleFromMessages(s.messages);
    for (const m of s.messages) {
      if (!m.note) continue;
      out.push({ note: m.note, sessionId: s.id, sessionTitle: title, messageId: m.id });
    }
  }
  out.sort((a, b) => b.note.at - a.note.at);
  return out;
}

/** 会话列表的预览行：优先最后一条助手回答，没有就用最后一条消息 */
export function sessionPreview(session: AiChatSession, max = 72): string {
  const list = session.messages || [];
  let text = "";
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (String(m.content || "").trim()) {
      text = String(m.content).replace(/\s+/g, " ").trim();
      break;
    }
  }
  if (!text && list.length) text = list[list.length - 1].content || "";
  const limit = Math.max(12, Math.round(Number(max) || 72));
  return text.length > limit ? text.slice(0, limit) + "…" : text;
}

/** 列表分组：今天 / 昨天 / 更早（纯逻辑，文案由 UI 翻译） */
export function sessionDayBucket(at: number, now = Date.now()): SessionDayBucket {
  const d = new Date(at);
  const n = new Date(now);
  if (!Number.isFinite(d.getTime())) return "earlier";
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.floor((startOfDay(n) - startOfDay(d)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return "earlier";
}

/** 会话列表里的时钟：HH:MM */
export function sessionClock(at: number): string {
  const d = new Date(at);
  if (!Number.isFinite(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
