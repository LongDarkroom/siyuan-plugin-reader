import { logSwallow } from "../../core/safe.ts";
/**
 * AI 面板 Markdown 渲染
 * ------------------------------------------------------------------
 * 助手输出统一走思源 Lute（与批注/翻译同一引擎），保证以下思源原生语法
 * 在对话里原样成立：
 *  - 有序/无序列表、任务列表、表格、代码块、公式（$…$ / $$…$$）
 *  - 块引用 ((id "anchor"))、行内标签 #tag、高亮 ==text==、上下标 ^ ^ / ~ ~
 *
 * 采用「Md2BlockDOM → BlockDOM2Md → Md2HTML」双转换（与 whale-renderer 一致）：
 * 直接 Md2HTML 会丢掉块引用/行内属性等思源扩展；双转换把它们固化成 BlockDOM
 * 再序列化回来，才能得到正确的 <span data-type="block-ref"> 等节点。
 *
 * 输出统一包一层 <div class="b3-typography">：与思源正文共用同一套排版基线
 * （标题/代码/表格按 em 缩放），容器字号由 .ai-md .b3-typography 压过
 * base.css 的 16px 定值，消息字号设置才能真正生效；复制进文档时版式同源。
 *
 * 安全：
 *  - getLute() 后显式 SetSanitize(true)（configureKramdownLute 内）；
 *  - 输出再过一道白名单式后处理（去 script/iframe、on* 事件、javascript: URL），
 *    不依赖 Lute 各版本 Sanitize 行为完全一致。
 */
import { getLute, configureKramdownLute } from "../../annotation/lute.ts";
import { ensureBlockSeparators } from "../../annotation/annotation-render.ts";
import { renderMarkdown } from "../../core/markdown.ts";

/** 只保留版面结构，去掉任何可执行载体（纵深防御，Lute Sanitize 之后再跑一遍） */
export function sanitizeRenderedHtml(html: string): string {
  return (html || "")
    .replace(/<(script|iframe|object|embed|form|style)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<(script|iframe|object|embed|form|style)\b[^>]*\/?>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*(["'])\s*(javascript|vbscript|data):[^"']*\2/gi, '$1="#"')
    .replace(/(href|src)\s*=\s*(javascript|vbscript):[^\s>]+/gi, '$1="#"');
}

/** 统一 b3-typography 外壳（renderMarkdown 的 Lute 分支已带壳，避免双层嵌套） */
function wrapTypography(html: string): string {
  if (!html) return "";
  if (/^<div class="b3-typography"/.test(html)) return html;
  return `<div class="b3-typography">${html}</div>`;
}

/**
 * 助手 Markdown → HTML。
 * 无 Lute 环境（单测 / 极旧内核）退回 core/markdown 的正则渲染，
 * 至少保证列表/引用/代码块可见且链接协议受白名单约束。
 */
export function renderAssistantMarkdown(md: string): string {
  const text = md || "";
  if (!text.trim()) return "";
  const lute = getLute();
  if (lute) {
    try {
      configureKramdownLute(lute);
      const kd = ensureBlockSeparators(text);
      const blockDOM = lute.Md2BlockDOM(kd);
      const html = lute.Md2HTML(lute.BlockDOM2Md(blockDOM));
      if (html && html.trim()) return wrapTypography(sanitizeRenderedHtml(html));
    } catch (__swallowErr) {
      logSwallow(__swallowErr, "ai-markdown.ts · renderAssistantMarkdown", "debug");
    }
    try {
      // 双转换失败时的单层兜底（仍开 GFM/表格）
      const html = lute.Md2HTML(ensureBlockSeparators(text));
      if (html && html.trim()) return wrapTypography(sanitizeRenderedHtml(html));
    } catch (__swallowErr) {
      logSwallow(__swallowErr, "ai-markdown.ts · renderAssistantMarkdown · fallback", "debug");
    }
  }
  // renderMarkdown 自带 URL 白名单；Lute 分支已带 b3-typography 壳，正则分支在这里补上
  return wrapTypography(renderMarkdown(text));
}

/**
 * 从点击目标里解析思源块引用 ID。
 * 兼容 Lute 的两种输出：
 *  - <span data-type="block-ref" data-id="202…">
 *  - <a href="siyuan://blocks/202…">
 * 以及块引用卡片内嵌的 data-node-id。
 */
export function blockIdFromTarget(target: Element | null): string {
  if (!target) return "";
  const el = target.closest?.('[data-type="block-ref"], a[href^="siyuan://blocks/"], a[href^="siyuan://block/"]') as HTMLElement | null;
  if (!el) return "";
  const dataId = el.getAttribute("data-id") || el.getAttribute("data-node-id") || "";
  if (dataId) return dataId;
  const href = el.getAttribute("href") || "";
  const m = href.match(/^siyuan:\/\/blocks?\/([\w-]+)/);
  return m ? m[1] : "";
}
