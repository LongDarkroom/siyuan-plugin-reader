import { formatUsage, type AiChatMessage } from "./ai-panel-logic.ts";
import { MAX_SESSION_TITLE, titleFromMessages, type AiChatSession } from "./ai-session-store.ts";

/**
 * 阅读助手 · 单会话导出（纯逻辑）
 * ------------------------------------------------------------------
 * JSON 只含会话本身（消息里没有凭据），Markdown 按「标题 + 书信息 +
 * 逐条消息」组织。文件名统一走 sessionExportFileName，非法字符替换为 `_`。
 */

export interface SessionExportMeta {
  bookTitle?: string;
  bookId?: string;
  now?: number;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function dateStamp(at: number): string {
  const d = new Date(at);
  if (!Number.isFinite(d.getTime())) return "19700101";
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function clockStamp(at: number): string {
  const d = new Date(at);
  if (!Number.isFinite(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 文件名里的非法字符（Windows/macOS 通用）替换为 `_` */
export function sanitizeFilePart(text: string, max = MAX_SESSION_TITLE): string {
  const cleaned = String(text || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .replace(/[. ]+$/, "");
  return cleaned || "未命名";
}

export function sessionTitleOf(session: AiChatSession): string {
  return String(session.title || titleFromMessages(session.messages) || "新对话").trim();
}

/** `书名-会话标题-YYYYMMDD.md` */
export function sessionExportFileName(
  session: AiChatSession,
  ext: "md" | "json",
  meta: SessionExportMeta = {},
): string {
  const now = Number.isFinite(Number(meta.now)) ? Number(meta.now) : Date.now();
  const book = sanitizeFilePart(meta.bookTitle || meta.bookId || "阅读助手");
  return `${book}-${sanitizeFilePart(sessionTitleOf(session))}-${dateStamp(now)}.${ext}`;
}

function quoteBlock(m: AiChatMessage): string[] {
  const q = m.quote;
  if (!q?.text) return [];
  const head = q.chapterTitle ? `引用（${q.chapterTitle}）` : "引用";
  const lines = q.text.split(/\r?\n/).map((line) => `> ${line}`);
  return [`> **${head}**`, ...lines, ""];
}

/** 会话 → Markdown（供下载）；不包含 system prompt 与任何凭据 */
export function buildSessionMarkdown(session: AiChatSession, meta: SessionExportMeta = {}): string {
  const title = sessionTitleOf(session);
  const book = String(meta.bookTitle || "").trim();
  const out: string[] = [`# ${title}`, ""];
  if (book) out.push(`- 书籍：${book}`);
  if (meta.bookId) out.push(`- 书籍 id：${meta.bookId}`);
  out.push(`- 创建：${clockStamp(session.createdAt)}`);
  out.push(`- 更新：${clockStamp(session.updatedAt)}`);
  out.push(`- 消息：${session.messages.length} 条`);
  out.push("", "---", "");

  for (const m of session.messages) {
    const who = m.role === "user" ? "用户" : "助手";
    out.push(`## ${who} · ${clockStamp(m.createdAt)}`, "");
    out.push(...quoteBlock(m));
    const content = String(m.content || "").trim();
    if (content) out.push(content, "");
    if (m.error) out.push(m.errorText ? `> 请求失败：${m.errorText}` : "> 请求失败", "");
    if (m.aborted) out.push("> 生成已停止", "");
    if (m.tools?.length) {
      out.push("工具调用：");
      for (const t of m.tools) out.push(`- ${t.ok ? "✓" : "✗"} ${t.label}${t.error ? `（${t.error}）` : ""}`);
      out.push("");
    }
    const usage = formatUsage(m.usage);
    if (usage) out.push(`> 用量：${usage}`, "");
    if (m.note) out.push(`> 已存为笔记：《${m.note.title}》${m.note.docId ? `（${m.note.docId}）` : ""}`, "");
    out.push("---", "");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** 会话 → JSON 文本：`{ version, bookId, exportedAt, session }` */
export function buildSessionJson(session: AiChatSession, meta: SessionExportMeta = {}): string {
  const now = Number.isFinite(Number(meta.now)) ? Number(meta.now) : Date.now();
  return JSON.stringify(
    {
      version: 1,
      bookId: meta.bookId || "",
      exportedAt: new Date(now).toISOString(),
      session,
    },
    null,
    2,
  );
}
