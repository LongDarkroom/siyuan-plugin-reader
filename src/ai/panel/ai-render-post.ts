import { logSwallow } from "../../core/safe.ts";
/**
 * AI 面板渲染后处理（S0-5/6）
 * ------------------------------------------------------------------
 * Lute 输出的 HTML 里公式和代码块还是「源状态」：
 *  - 公式：<span|div class="language-math">TeX</span|div>
 *  - 代码：<pre><code class="language-xxx">…</code></pre>
 * 这里在挂载后补齐与思源正文一致的观感：
 *  - 公式：优先用宿主 window.katex（否则从 /stage/protyle 懒加载）渲染；
 *    data-content 固化 TeX 原文（选区复制靠它还原 $…$ / $$…$$）。
 *  - 代码：优先用宿主 window.hljs（否则懒加载 + 宿主的代码主题样式），
 *    highlight 后补语言标签 .ai-code-lang（悬停显隐，不占位）。
 * 流式期间 {@html} 会整体重渲染，故用 MutationObserver 增量补挂；
 * 已处理的节点带 class .hljs / data-rendered 会被跳过，不会重复处理。
 */

let katexReady: Promise<boolean> | null = null;
let hljsReady: Promise<boolean> | null = null;

function win(): any {
  return typeof window !== "undefined" ? window : (globalThis as any);
}

function cdnBase(): string {
  return "/stage/protyle";
}

function ensureStyle(id: string, href: string): void {
  if (typeof document === "undefined" || document.getElementById(id)) return;
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}

function loadScript(url: string, id: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") {
      resolve(false);
      return;
    }
    const existing = document.getElementById(id) as HTMLScriptElement | null;
    if (existing) {
      // 宿主可能还在加载：有 load 事件就等它
      if (existing.dataset.loaded === "1") resolve(true);
      else existing.addEventListener("load", () => resolve(true), { once: true });
      return;
    }
    const s = document.createElement("script");
    s.id = id;
    s.src = url;
    s.async = true;
    s.onload = () => {
      s.dataset.loaded = "1";
      resolve(true);
    };
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}

function ensureKatex(): Promise<boolean> {
  if (win().katex?.renderToString) return Promise.resolve(true);
  if (!katexReady) {
    const p: Promise<boolean> = (async () => {
      ensureStyle("protyleKatexStyle", `${cdnBase()}/js/katex/katex.min.css`);
      const ok = await loadScript(`${cdnBase()}/js/katex/katex.min.js`, "protyleKatexScript");
      return ok && !!win().katex?.renderToString;
    })().then((ok) => {
      // 加载失败不永久缓存，下次渲染再试
      if (!ok) katexReady = null;
      return ok;
    });
    katexReady = p;
  }
  return katexReady;
}

/** 与宿主一致的代码主题：跟思源外观模式走，找不到配置就落到 default / github-dark */
function hljsTheme(): string {
  const ap = win().siyuan?.config?.appearance;
  if (Number(ap?.mode) === 1) return String(ap?.codeBlockThemeDark || "github-dark");
  return String(ap?.codeBlockThemeLight || "default");
}

function ensureHljs(): Promise<boolean> {
  if (win().hljs?.highlight) return Promise.resolve(true);
  if (!hljsReady) {
    const p: Promise<boolean> = (async () => {
      ensureStyle("protyleHljsStyle", `${cdnBase()}/js/highlight.js/styles/${hljsTheme()}.min.css`);
      const ok = await loadScript(`${cdnBase()}/js/highlight.js/highlight.min.js`, "protyleHljsScript");
      if (!ok) return false;
      await loadScript(`${cdnBase()}/js/highlight.js/third-languages.js`, "protyleHljsThirdScript");
      return !!win().hljs?.highlight;
    })().then((ok) => {
      if (!ok) hljsReady = null;
      return ok;
    });
    hljsReady = p;
  }
  return hljsReady;
}

function unescapeTex(raw: string): string {
  try {
    const lute = win().Lute;
    if (lute && typeof lute.UnEscapeHTMLStr === "function") return lute.UnEscapeHTMLStr(raw);
  } catch (__swallowErr) {
    logSwallow(__swallowErr, "ai-render-post.ts · unescapeTex", "debug");
  }
  return raw;
}

/** 代码块声明语言：class="language-js" → js */
export function langTagOf(className: string): string {
  const m = /(?:^|\s)language-([\w+#.-]+)/.exec(className || "");
  return m ? m[1] : "";
}

function applyMath(root: HTMLElement): void {
  const items = Array.from(
    root.querySelectorAll<HTMLElement>(".language-math, [data-subtype='math']"),
  ).filter((el) => !el.hasAttribute("data-rendered") && !el.querySelector(".katex"));
  if (!items.length) return;
  void ensureKatex().then((ok) => {
    if (!ok) return;
    const katex = win().katex;
    for (const el of items) {
      if (!root.contains(el) || el.querySelector(".katex")) continue;
      const tex = el.getAttribute("data-content") || el.textContent || "";
      if (!tex.trim()) continue;
      const display = el.tagName === "DIV";
      try {
        // 先固化 TeX 原文：渲染后 textContent 是 KaTeX 的产物，复制要靠 data-content
        el.setAttribute("data-content", tex);
        if (display) el.setAttribute("data-subtype", "math");
        // katex 默认 trust:false（不认 \href/\html*），输出只含自身结构与转义文本
        el.innerHTML = katex.renderToString(unescapeTex(tex), {
          displayMode: display,
          output: "html",
          throwOnError: false,
          strict: (code: string) => (code === "unicodeTextInMathMode" ? "ignore" : "warn"),
        });
        el.setAttribute("data-rendered", "1");
      } catch (__swallowErr) {
        logSwallow(__swallowErr, "ai-render-post.ts · applyMath", "debug");
      }
    }
  });
}

function applyCode(root: HTMLElement): void {
  const codes = Array.from(root.querySelectorAll<HTMLElement>("pre > code:not(.hljs)"));
  if (!codes.length) return;
  void ensureHljs().then((ok) => {
    if (!ok) return;
    const hljs = win().hljs;
    for (const code of codes) {
      if (!root.contains(code) || code.classList.contains("hljs")) continue;
      const declared = langTagOf(code.className);
      const text = code.textContent || "";
      let used = declared;
      try {
        // hljs 输出会转义源码文本，只包 span，不回灌原始 HTML
        if (declared && hljs.getLanguage?.(declared)) {
          code.innerHTML = hljs.highlight(text, { language: declared, ignoreIllegals: true }).value;
        } else {
          const auto = hljs.highlightAuto(text);
          code.innerHTML = auto.value;
          used = declared || auto.language || "";
        }
        code.classList.add("hljs");
      } catch (__swallowErr) {
        logSwallow(__swallowErr, "ai-render-post.ts · applyCode", "debug");
        continue;
      }
      const pre = code.parentElement;
      if (!used || !pre || pre.querySelector(":scope > .ai-code-lang")) continue;
      const label = document.createElement("span");
      label.className = "ai-code-lang";
      label.textContent = used;
      label.setAttribute("aria-hidden", "true");
      pre.appendChild(label);
    }
  });
}

/** Svelte action：挂到 .ai-md，首次 + 每次重渲染后补公式与高亮 */
export function renderPost(node: HTMLElement): { destroy(): void } {
  const run = (): void => {
    applyMath(node);
    applyCode(node);
  };
  run();
  const mo = new MutationObserver(run);
  mo.observe(node, { childList: true, subtree: true });
  return {
    destroy(): void {
      mo.disconnect();
    },
  };
}