<script lang="ts">
  /**
   * AI 页签（2026-11-05）
   * ----------------------------------------------------------------
   * 把「阅读助手」从右侧停靠提升为思源原生页签：
   *  - 默认跟随**活动阅读器**，换书/切窗口自动接上；
   *  - 页签头的「锁定本书」把绑定钉在某一本（由 AiTabController 注入 head 按钮）；
   *  - 锁定的书被关掉时**不关本页签**，这里展示空状态，会话按 bookId
   *    存在 localStorage，重开同一本书即恢复历史。
   *
   * 与右侧停靠共用同一个 AiPanel；宿主能力全部来自 ReaderView 的
   * `getAiPanelHost()`，本组件不碰 foliate，也不复制面板逻辑。
   */
  import { onMount, onDestroy } from "svelte";
  import AiPanel from "./panel/AiPanel.svelte";
  import { t } from "../i18n/index.ts";
  import { logSwallow } from "../core/safe.ts";
  import {
    loadAiTabPin,
    saveAiTabPin,
    resolveAiTabTarget,
    type AiTabPin,
    type AiTabTarget,
  } from "./ai-tab-follow.ts";
  import type { AiChatQuote } from "./panel/ai-panel-logic.ts";

  interface PinState {
    locked: boolean;
    disabled: boolean;
    label: string;
    title: string;
  }

  /** ReaderTabController 的最小子集（便于单测/桩件） */
  export let readerTabs: any = null;
  export let getAiSettings: (() => any) | undefined = undefined;
  export let saveAiSettings: ((patch: any) => Promise<void> | void) | undefined = undefined;
  export let openShelf: (() => void) | undefined = undefined;
  /** 把锁定状态同步到页签头按钮（按钮 DOM 归控制器所有） */
  export let onPinState: ((state: PinState) => void) | undefined = undefined;
  /** 同一个壳承载两种形态：思源原生页签 / 右侧停靠栏 */
  export let surface: "tab" | "dock" = "tab";
  /** 停靠形态：收起按钮与「在新页签打开」由控制器注入 */
  export let onClose: (() => void) | undefined = undefined;
  export let onOpenTab: (() => void) | undefined = undefined;

  let target: AiTabTarget = resolveAiTabTarget();
  let pinned: AiTabPin = { bookId: "", title: "" };
  let host: any = null;
  let general = false;
  let lastComp: any = null;
  let lastSig = "";
  let lastGeneral = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let panelComp: any = null;

  /** 没有活动阅读器时的通用对话宿主：不读正文，只保留对话本身 */
  const GENERAL_HOST = {
    bookId: "",
    bookTitle: "",
    bookAuthor: "",
    chapterLabel: "",
  };

  function storage(): Storage | null {
    try {
      return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
      return null;
    }
  }

  function readOpenBooks(): { bookId: string; title: string }[] {
    try {
      return readerTabs?.listOpenBooks?.() ?? [];
    } catch {
      return [];
    }
  }

  function readActiveBookId(): string {
    try {
      return String(readerTabs?.getActiveReader?.()?.bookId || "");
    } catch {
      return "";
    }
  }

  function compOf(bookId: string): any {
    try {
      return bookId ? readerTabs?.getReaderComp?.(bookId) ?? null : null;
    } catch {
      return null;
    }
  }

  function syncPinState(): void {
    const bookTitle = host?.bookTitle || pinned.title || target.title || "";
    onPinState?.({
      locked: !!pinned.bookId,
      disabled: !pinned.bookId && !target.bookId,
      label: pinned.bookId ? t("已锁定") : t("锁定本书"),
      title: pinned.bookId
        ? t("已锁定《{title}》· 点击恢复跟随活动阅读器", { title: bookTitle || t("这本书") })
        : target.bookId
          ? t("锁定《{title}》· 关掉阅读器后仍保留本页签", { title: bookTitle || t("这本书") })
          : t("打开一本书后即可锁定"),
    });
  }

  function refresh(): void {
    const openBooks = readOpenBooks();
    target = resolveAiTabTarget({
      pinnedBookId: pinned.bookId,
      pinnedTitle: pinned.title,
      activeBookId: readActiveBookId(),
      openBooks,
    });
    // 锁定时书名可能还没加载完：阅读列表里有就补上，便于「重新打开」显示
    if (pinned.bookId && !pinned.title) {
      const hit = openBooks.find((b) => b.bookId === pinned.bookId);
      if (hit?.title) {
        pinned = { bookId: pinned.bookId, title: hit.title };
        saveAiTabPin(storage(), pinned);
      }
    }

    const comp = compOf(target.bookId);
    let nextHost: any = null;
    if (comp && typeof comp.getAiPanelHost === "function") {
      try {
        nextHost = comp.getAiPanelHost();
      } catch (e) {
        logSwallow(e, "AiTabView.svelte · getAiPanelHost", "warn");
      }
    }
    // 右栏是常驻入口：没有书时也必须是可对话的面板，而不是「请先开书」空态。
    // 页签保持不变——页签本来就是围绕一本书打开的，空态更有信息量。
    const nextGeneral = !nextHost && surface === "dock";
    if (nextGeneral) nextHost = GENERAL_HOST;
    const sig = nextHost
      ? nextGeneral
        ? "general"
        : `${nextHost.bookId}|${nextHost.bookTitle}|${nextHost.bookAuthor}|${nextHost.chapterLabel}`
      : "";
    // 只在「换了实例 / 书名章节变了」时更新，避免每 800ms 触发子组件无意义刷新
    if (comp !== lastComp || sig !== lastSig || nextGeneral !== lastGeneral) {
      lastComp = comp;
      lastSig = sig;
      lastGeneral = nextGeneral;
      host = nextHost;
      general = nextGeneral;
    }
    syncPinState();
  }

  /**
   * 把选段直接投进页签内的面板。
   * 只有页签正绑定同一本书、且面板已挂载时才成功；锁定在别的书或宿主
   * 未就绪一律返回 false，由调用方回落到阅读器右侧停靠栏。
   */
  export function deliverQuote(bookId: string, quote: AiChatQuote): boolean {
    const id = String(bookId || "");
    if (!id || !host || host.bookId !== id || !panelComp) return false;
    panelComp.addQuote?.(quote);
    return true;
  }

  /** 让停在右栏的输入框拿到焦点（点 dock 图标再次打开时用） */
  export function focusComposer(): void {
    panelComp?.focusComposer?.();
  }

  /** 页签头按钮：跟随态 → 锁定当前书；锁定态 → 恢复跟随 */
  export function togglePin(): void {
    if (surface === "dock") return;
    if (pinned.bookId) {
      pinned = { bookId: "", title: "" };
    } else {
      const bookId = target.bookId;
      if (!bookId) return;
      pinned = { bookId, title: host?.bookTitle || "" };
    }
    saveAiTabPin(storage(), pinned);
    refresh();
  }

  /** 锁定书已关闭时的「重新打开」 */
  export function reopenPinned(): void {
    const bookId = pinned.bookId;
    if (!bookId) return;
    try {
      void readerTabs?.openBookTab?.(bookId, pinned.title || undefined);
    } catch (e) {
      logSwallow(e, "AiTabView.svelte · reopenPinned", "warn");
    }
  }

  export function unlockPin(): void {
    if (!pinned.bookId) return;
    pinned = { bookId: "", title: "" };
    saveAiTabPin(storage(), pinned);
    refresh();
  }

  $: emptyKind = host ? "" : target.pinnedClosed ? "closed" : target.bookId ? "opening" : "none";
  onMount(() => {
    // 锁定只属于页签：右栏是常驻入口，不该被上一次的页签锁定带入某本书
    if (surface !== "dock") pinned = loadAiTabPin(storage());
    refresh();
    // 活动阅读器由「窗口焦点 / 页签切换」驱动，没有统一事件；
    // 轻量轮询（800ms）比在每个 ReaderView 里埋监听更稳，也覆盖浏览器失焦。
    timer = setInterval(refresh, 800);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      if (timer) clearInterval(timer);
      timer = null;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  });
</script>

<div class="re-ai-tab">
  {#if host}
    <AiPanel
      bind:this={panelComp}
      bookId={host.bookId}
      bookTitle={host.bookTitle}
      bookAuthor={host.bookAuthor}
      chapterLabel={host.chapterLabel}
      general={general}
      resizable={false}
      overlay={false}
      onClose={surface === "dock" ? onClose : undefined}
      onOpenTab={surface === "dock" ? onOpenTab : undefined}
      getAiSettings={getAiSettings}
      saveAiSettings={saveAiSettings}
      getChapter={host.getChapter}
      getPage={host.getPage}
      getRange={host.getRange}
      getToc={host.getToc}
      getReaderToolHost={host.getReaderToolHost}
      readKnowledge={host.readKnowledge}
      resolveNoteTarget={host.resolveNoteTarget}
      writeNotePlan={host.writeNotePlan}
      getPrimer={host.getPrimer}
      onLocate={host.onLocate}
    />
  {:else}
    <div class="re-ai-empty">
      <div class="re-ai-empty-mark" aria-hidden="true">
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none">
          <path d="M12 3.2l1.9 4.7 4.7 1.9-4.7 1.9L12 16.4l-1.9-4.7L5.4 9.8l4.7-1.9z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
          <path d="M18.6 15.2l.9 2.2 2.2.9-2.2.9-.9 2.2-.9-2.2-2.2-.9 2.2-.9z" fill="currentColor" opacity=".45" />
        </svg>
      </div>

      {#if emptyKind === "closed"}
        <div class="re-ai-empty-title">{t("《{title}》的阅读器已关闭", { title: pinned.title || t("这本书") })}</div>
        <div class="re-ai-empty-desc">
          {t("AI 页签不会自动关闭；这本书的对话历史已保留，重新打开阅读器后可以接着聊。")}
        </div>
        <div class="re-ai-empty-actions">
          <button class="re-ai-btn is-primary" on:click={reopenPinned}>{t("重新打开阅读器")}</button>
          <button class="re-ai-btn" on:click={unlockPin}>
            {target.hasActiveReader ? t("改为跟随当前阅读器") : t("恢复跟随活动阅读器")}
          </button>
        </div>
      {:else if emptyKind === "opening"}
        <div class="re-ai-empty-title">{t("正在打开阅读器…")}</div>
        <div class="re-ai-empty-desc">{t("页面就绪后会自动接上，对话历史会保留。")}</div>
      {:else}
        <div class="re-ai-empty-title">{t("还没有打开的阅读器")}</div>
        <div class="re-ai-empty-desc">
          {t("打开一本书后，这里会自动跟随当前阅读器；也可以在页签头锁定本书。")}
        </div>
        <div class="re-ai-empty-actions">
          <button class="re-ai-btn is-primary" on:click={() => openShelf?.()}>{t("打开书架")}</button>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .re-ai-tab {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    min-height: 0;
    height: 100%;
    background: var(--b3-theme-background, #fff);
    /* 同 AiPanel：.layout-tab-container 默认 user-select:none，空态文案也要能选 */
    -webkit-user-select: text;
    user-select: text;
  }
  .re-ai-tab :global(.ai-panel) {
    border-left: none;
  }

  .re-ai-empty {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 32px 24px;
    text-align: center;
    color: var(--b3-theme-on-background, #1f2329);
  }
  .re-ai-empty-mark {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 64px;
    height: 64px;
    margin-bottom: 4px;
    border-radius: 18px;
    color: var(--b3-theme-primary, #378add);
    background: var(--b3-theme-primary-lightest, rgba(55, 138, 221, 0.08));
  }
  .re-ai-empty-title {
    font-size: 15px;
    font-weight: 600;
    line-height: 1.4;
  }
  .re-ai-empty-desc {
    max-width: 360px;
    font-size: 12.5px;
    line-height: 1.7;
    color: var(--b3-theme-on-surface, #6b7280);
  }
  .re-ai-empty-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
    margin-top: 6px;
  }
  .re-ai-btn {
    height: 30px;
    padding: 0 14px;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.12));
    border-radius: 7px;
    background: var(--b3-theme-surface, #f8f8f7);
    color: var(--b3-theme-on-background, #1f2329);
    font-size: 12.5px;
    cursor: pointer;
  }
  .re-ai-btn:hover {
    background: var(--b3-list-hover, rgba(0, 0, 0, 0.05));
  }
  .re-ai-btn.is-primary {
    border-color: transparent;
    background: var(--b3-theme-primary, #378add);
    color: #fff;
  }
  .re-ai-btn.is-primary:hover {
    filter: brightness(0.96);
  }
</style>
