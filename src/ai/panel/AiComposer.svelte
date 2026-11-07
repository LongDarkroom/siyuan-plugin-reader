<script lang="ts">
  import { tick } from "svelte";

  /** 占位提示 */
  export let placeholder = "";
  /** 发送中禁用（输入仍可读，避免光标跳走） */
  export let disabled = false;
  /** 是否有内容（双向绑定给父组件控制发送按钮） */
  export let hasText = false;
  /** 发送键：enter = Enter 发送（Shift+Enter 换行）；mod+enter = ⌘/Ctrl+Enter 发送 */
  export let sendShortcut: "enter" | "mod+enter" = "enter";
  /** Enter 提交（Shift+Enter 换行） */
  export let onSubmit: (() => void) | undefined = undefined;

  let el: HTMLDivElement;
  let composing = false;

  const MAX_HEIGHT = 168;

  function textOf(): string {
    // textContent 会把零宽占位符也带出来，统一剥掉
    return (el?.textContent || "").replace(/[\u200b\ufeff]/g, "").trim();
  }

  function syncState(): void {
    const text = textOf();
    hasText = !!text;
    if (el) {
      el.classList.toggle("is-empty", !el.textContent || !el.textContent.replace(/[\u200b\ufeff]/g, "").trim());
      autoGrow();
    }
  }

  function autoGrow(): void {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(40, Math.min(MAX_HEIGHT, el.scrollHeight))}px`;
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
  }

  function onInput(): void {
    syncState();
  }

  function onKeydown(e: KeyboardEvent): void {
    // 中文输入法组合期：Enter 是选词，不是发送
    if (composing || e.isComposing || (e as any).keyCode === 229) return;
    if (e.key !== "Enter") return;
    const mod = e.metaKey || e.ctrlKey;
    const wantsSend =
      sendShortcut === "mod+enter"
        ? mod && !e.shiftKey && !e.altKey
        : !mod && !e.shiftKey && !e.altKey;
    if (!wantsSend) return;
    e.preventDefault();
    if (!disabled) onSubmit?.();
  }

  function onPaste(e: ClipboardEvent): void {
    // 聊天输入只收纯文本：粘贴网页/文档时不带样式与块结构
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (!text) return;
    e.preventDefault();
    insertText(text);
  }

  function insertText(text: string): void {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !el.contains(sel.anchorNode)) {
      el.textContent = (el.textContent || "") + text;
    } else {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const node = document.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    syncState();
  }

  /** 读取纯文本（父组件发送前调用） */
  export function getText(): string {
    return textOf();
  }

  /** 清空（发送成功后调用） */
  export function clear(): void {
    if (!el) return;
    el.textContent = "";
    hasText = false;
    syncState();
  }

  /** 填入文本（建议问题 / 外部注入） */
  export function setText(text: string): void {
    if (!el) return;
    el.textContent = text || "";
    syncState();
    void tick().then(() => {
      el.focus();
      const sel = window.getSelection();
      if (!sel) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    });
  }

  export function focus(): void {
    try { el?.focus(); } catch { /* 容器离屏时忽略 */ }
  }
</script>

<!-- svelte-ignore a11y-no-noninteractive-tabindex -->
<div
  class="ai-composer-input"
  class:is-disabled={disabled}
  bind:this={el}
  role="textbox"
  aria-multiline="true"
  aria-label={placeholder}
  tabindex="0"
  contenteditable={!disabled}
  data-placeholder={placeholder}
  on:input={onInput}
  on:keydown={onKeydown}
  on:paste={onPaste}
  on:compositionstart={() => (composing = true)}
  on:compositionend={() => { composing = false; syncState(); }}
  on:click={() => { if (!disabled) focus(); }}
></div>

<style>
  .ai-composer-input {
    width: 100%;
    min-height: 40px;
    max-height: 168px;
    overflow-y: hidden;
    padding: 2px 2px 0;
    border: none;
    outline: none;
    background: transparent;
    color: var(--b3-theme-on-background, #1f2329);
    font-size: var(--re-ai-input-font-size, 13px);
    line-height: 1.65;
    white-space: pre-wrap;
    word-break: break-word;
    cursor: text;
    user-select: text;
  }
  .ai-composer-input:empty::before {
    content: attr(data-placeholder);
    color: var(--b3-theme-on-surface-light, #9aa0a6);
    pointer-events: none;
  }
  .ai-composer-input.is-disabled {
    opacity: 0.72;
    cursor: default;
  }
</style>
