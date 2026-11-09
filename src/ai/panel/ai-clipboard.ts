import { logSwallow } from "../../core/safe.ts";
/**
 * AI 面板选区复制 → Markdown 剪贴板（S0-4）
 * ------------------------------------------------------------------
 * 目标：从对话里划选复制，粘贴进思源文档后版式与原文一模一样。
 * 管线（结构对标 Copilot，独立实现）：
 *  1. 只接管「单条消息正文 .ai-md 内」的选区；输入框/历史列表/跨消息选区不干预。
 *  2. 克隆选区 → 去掉注入的 UI（代码复制按钮、语言标签）。
 *  3. 公式（span/div.language-math、[data-subtype=math]）先换成纯字母数字占位符，
 *     避免 Lute.HTML2Md 把 TeX 里的 $/反斜杠转义坏；转换后再还原成 $…$ / $$…$$。
 *     TeX 取数顺序：data-content（KaTeX 渲染后）→ katex annotation → textContent（渲染前）。
 *  4. 两端都在 pre/code 里且不含公式 → 原样纯文本（代码不包栅栏）。
 *  5. 其余走 Lute.HTML2Md → text/plain。思源粘贴 text/plain 会按 Markdown 原生解析，
 *     标题/列表/表格/公式/块引用全部落成思源块。
 * 无 Lute / 出错时不 preventDefault，回落系统默认复制。
 */
import { getLute, configureKramdownLute } from "../../annotation/lute.ts";

/** 渲染后注入的交互 UI，复制时必须剔除 */
const UI_NOISE = ".ai-code-copy, .ai-code-lang";
/** Lute Md2HTML 的公式容器（渲染 KaTeX 后仍保留语言类名/子类型） */
const MATH_SEL = ".language-math, [data-subtype='math']";

function elementOf(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === 1 ? (node as Element) : node.parentElement;
}

/** 选区是否落在面板内单条消息正文里（跨消息/输入框/历史列表 → false） */
export function shouldIntercept(range: Range, panel: HTMLElement): boolean {
  const anc = elementOf(range.commonAncestorContainer);
  const md = anc?.closest(".ai-md");
  return !!md && panel.contains(md);
}

/** 两端都在代码块/行内代码里（且不含公式）→ 按原始代码文本复制 */
export function isCodeSelection(range: Range, hasMath: boolean): boolean {
  if (hasMath) return false;
  const a = elementOf(range.startContainer)?.closest("pre, code");
  const b = elementOf(range.endContainer)?.closest("pre, code");
  return !!a && !!b;
}

/** 公式源文本：优先 data-content，其次 KaTeX 的 tex annotation，最后原始文本 */
export function mathTexOf(el: Element): string {
  const dc = el.getAttribute("data-content");
  if (dc && dc.trim()) return dc;
  const ann = el.querySelector('annotation[encoding="application/x-tex"]');
  if (ann?.textContent?.trim()) return ann.textContent.trim();
  return (el.textContent || "").trim();
}

/** 占位符 → $…$ / $$…$$（块级公式前后留换行，保证 kramdown 识别为公式块） */
export function restoreMathTokens(md: string, tokens: Map<string, string>): string {
  let out = md;
  for (const [token, tex] of tokens) out = out.split(token).join(tex);
  return out;
}

/** kramdown 要求列表前有空行：HTML2Md 的选区片段可能缺，这里补上 */
export function insertListBlanks(md: string): string {
  const isItem = (l: string) => /^[-+*]\s|^\d+\.\s/.test(l);
  const out: string[] = [];
  for (const line of md.split("\n")) {
    const prev = out.length ? out[out.length - 1] : "";
    if (isItem(line) && prev !== "" && !isItem(prev)) out.push("");
    out.push(line);
  }
  return out.join("\n");
}

/**
 * 选区克隆片段 → Markdown。box 会被就地修改（去 UI、公式换占位符再还原）。
 * lute 需已配置（configureKramdownLute）；HTML2Md 失败时抛出，由调用方回落。
 */
export function fragmentToMarkdown(box: HTMLElement, lute: any): string {
  box.querySelectorAll(UI_NOISE).forEach((n) => n.remove());
  const tokens = new Map<string, string>();
  let i = 0;
  box.querySelectorAll(MATH_SEL).forEach((el) => {
    if (!box.contains(el)) return; // 外层容器已整体替换时跳过内层
    const tex = mathTexOf(el);
    if (!tex) {
      el.remove();
      return;
    }
    const token = `REAIMATH${i}ENDREAIMATH`;
    i += 1;
    const block = el.tagName === "DIV";
    tokens.set(token, block ? `\n$$\n${tex}\n$$\n` : `$${tex}$`);
    el.replaceWith(document.createTextNode(token));
  });
  const md = String(lute.HTML2Md(box.innerHTML) || "");
  return insertListBlanks(restoreMathTokens(md, tokens)).trim();
}

/** Svelte action：挂面板根，接管正文选区的 copy 事件 */
export function copyAsMarkdown(panel: HTMLElement): { destroy(): void } {
  const onCopy = (ev: ClipboardEvent): void => {
    try {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !ev.clipboardData) return;
      const range = sel.getRangeAt(0);
      if (!shouldIntercept(range, panel)) return;
      const lute = getLute();
      if (!lute || typeof lute.HTML2Md !== "function") return;
      configureKramdownLute(lute);
      const box = document.createElement("div");
      box.appendChild(range.cloneContents());
      const hasMath = !!box.querySelector(MATH_SEL);
      let text: string;
      if (isCodeSelection(range, hasMath)) {
        box.querySelectorAll(UI_NOISE).forEach((n) => n.remove());
        text = box.textContent || "";
      } else {
        text = fragmentToMarkdown(box, lute);
      }
      if (!text.trim()) return;
      ev.preventDefault();
      ev.clipboardData.setData("text/plain", text);
    } catch (__swallowErr) {
      // 不 preventDefault → 系统默认复制兜底
      logSwallow(__swallowErr, "ai-clipboard.ts · copyAsMarkdown", "debug");
    }
  };
  panel.addEventListener("copy", onCopy);
  return {
    destroy(): void {
      panel.removeEventListener("copy", onCopy);
    },
  };
}