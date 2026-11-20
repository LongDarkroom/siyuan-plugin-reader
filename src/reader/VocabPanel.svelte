<script lang="ts">
  /**
   * 「我的标记 → 生词」页签。
   *
   * 视觉语言对齐 2026-11-20 的生词本 demo：搜索框、全部/本书筛选、
   * 最近加入/A–Z 排序、可点词条、删除撤销。数据真源仍是 ReaderVocabStore，
   * 这里只做展示与轻交互，不引入复习队列/SRS。
   */
  import { onMount } from "svelte";
  import type { ReaderVocabStore, VocabEntry } from "./vocab-store.ts";

  type GroupKey = "today" | "yesterday" | "earlier";
  interface VocabGroup {
    key: string;
    label: string;
    items: VocabEntry[];
  }

  export let store: ReaderVocabStore | null = null;
  export let bookId = "";
  export let bookTitle = "";
  export let t: (key: string, params?: Record<string, any>) => string = (k) => k;
  /** anchor = 被点条目在视口里的矩形，供阅读器把词典卡贴着这条排 */
  export let onOpenWord:
    ((word: string, entry: VocabEntry, anchor?: { left: number; top: number; right: number; bottom: number }) => void)
    | undefined = undefined;

  const BOOK_COLORS = ["#d69a2b", "#62a2ff", "#d66b6b", "#58b78b", "#8e7cc3", "#4fa3a5"];
  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
  const dateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

  let entries: VocabEntry[] = [];
  let filtered: VocabEntry[] = [];
  let groups: VocabGroup[] = [];
  let query = "";
  let scope: "all" | "book" = "all";
  let sort: "recent" | "alpha" = "recent";
  let bookCount = 0;
  let removed: VocabEntry | null = null;
  let removedTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe: (() => void) | null = null;

  function refresh(): void {
    entries = store?.list?.() ?? [];
  }

  onMount(() => {
    refresh();
    unsubscribe = store?.subscribe?.(refresh) ?? null;
    return () => {
      unsubscribe?.();
      if (removedTimer) clearTimeout(removedTimer);
    };
  });

  function startOfDay(value: number): number {
    const d = new Date(value);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function dateGroup(value: number): GroupKey {
    const today = startOfDay(Date.now());
    const day = startOfDay(value);
    if (day === today) return "today";
    if (day === today - 24 * 60 * 60 * 1000) return "yesterday";
    return "earlier";
  }

  function groupLabel(key: GroupKey): string {
    return key === "today" ? t("今天") : key === "yesterday" ? t("昨天") : t("更早");
  }

  function rowDate(entry: VocabEntry, groupKey: string): string {
    if (groupKey === "today" || groupKey === "yesterday") return timeFmt.format(entry.addedAt);
    if (groupKey === "earlier") return dateFmt.format(entry.addedAt);
    const key = dateGroup(entry.addedAt);
    if (key === "earlier") return dateFmt.format(entry.addedAt);
    return `${groupLabel(key)} ${timeFmt.format(entry.addedAt)}`;
  }

  function buildGroups(list: VocabEntry[], mode: "recent" | "alpha"): VocabGroup[] {
    if (mode === "alpha") return list.length ? [{ key: "all", label: "", items: list }] : [];
    const out: VocabGroup[] = [];
    for (const entry of list) {
      const key = dateGroup(entry.addedAt);
      let group = out[out.length - 1];
      if (!group || group.key !== key) {
        group = { key, label: groupLabel(key), items: [] };
        out.push(group);
      }
      group.items.push(entry);
    }
    return out;
  }

  $: bookCount = entries.filter((it) => !!bookId && it.bookId === bookId).length;
  $: {
    const q = query.trim().toLowerCase();
    let list = scope === "book" ? entries.filter((it) => !!bookId && it.bookId === bookId) : entries;
    if (q) {
      list = list.filter((it) =>
        [it.word, it.meaning, it.sentence, it.bookTitle, it.chapter]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q)),
      );
    }
    filtered = [...list].sort((a, b) =>
      sort === "alpha" ? a.word.localeCompare(b.word, "en") : b.addedAt - a.addedAt,
    );
  }
  $: groups = buildGroups(filtered, sort);

  function bookColor(key: string): string {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return BOOK_COLORS[h % BOOK_COLORS.length];
  }

  function openWord(entry: VocabEntry, rowEl?: unknown): void {
    const r = (rowEl as HTMLElement | null | undefined)?.getBoundingClientRect?.();
    const anchor = r && r.width > 0
      ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
      : undefined;
    onOpenWord?.(entry.word, entry, anchor);
  }

  function onRowKey(e: KeyboardEvent, entry: VocabEntry): void {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openWord(entry, e.currentTarget);
    }
  }

  function remove(entry: VocabEntry): void {
    if (!store) return;
    store.removeWord(entry.word);
    removed = { ...entry };
    if (removedTimer) clearTimeout(removedTimer);
    removedTimer = setTimeout(() => {
      removedTimer = null;
      removed = null;
    }, 6000);
  }

  function undoRemove(): void {
    if (!removed || !store) return;
    store.addWord(removed);
    removed = null;
    if (removedTimer) {
      clearTimeout(removedTimer);
      removedTimer = null;
    }
  }

  function dismissUndo(): void {
    removed = null;
    if (removedTimer) {
      clearTimeout(removedTimer);
      removedTimer = null;
    }
  }
</script>

<section class="vocab-panel" aria-label={t("生词本")}>
  <div class="vocab-summary">
    <span class="vocab-stat"><strong>{entries.length}</strong> {t("个生词")}</span>
    <span class="vocab-sep">·</span>
    <span class="vocab-stat">{t("本书 {n} 个", { n: bookCount })}</span>
  </div>

  <div class="vocab-search">
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
    <input
      type="search"
      bind:value={query}
      placeholder={t("搜索单词、释义或原句")}
      autocomplete="off"
      spellcheck="false"
      aria-label={t("搜索生词")}
    />
    {#if query}
      <button class="vocab-search-clear" title={t("清除搜索")} aria-label={t("清除搜索")} on:click={() => (query = "")}>×</button>
    {/if}
  </div>

  <div class="vocab-filters">
    <button class="vocab-chip" class:active={scope === "all"} on:click={() => (scope = "all")}>
      {t("全部")} <span>{entries.length}</span>
    </button>
    <button
      class="vocab-chip"
      class:active={scope === "book"}
      title={bookTitle || t("本书")}
      on:click={() => (scope = "book")}
    >
      {t("本书")} <span>{bookCount}</span>
    </button>
    <select class="vocab-sort" bind:value={sort} aria-label={t("排序")}>
      <option value="recent">{t("最近加入")}</option>
      <option value="alpha">A–Z</option>
    </select>
  </div>

  <div class="vocab-list">
    {#each groups as group (group.key)}
      {#if group.label}<div class="vocab-group-label">{group.label}</div>{/if}
      {#each group.items as entry (entry.word)}
        <div class="vocab-row">
          <div
            class="vocab-row-main"
            role="button"
            tabindex="0"
            title={t("查看释义")}
            on:click={(e) => openWord(entry, e.currentTarget)}
            on:keydown={(e) => onRowKey(e, entry)}
          >
            <div class="vocab-word-line">
              <span class="vocab-star" aria-hidden="true">★</span>
              <span class="vocab-word">{entry.word}</span>
              {#if entry.phonetic}<span class="vocab-phonetic">{entry.phonetic}</span>{/if}
              {#if entry.pos}<span class="vocab-pos">{entry.pos}</span>{/if}
            </div>
            {#if entry.meaning}<div class="vocab-meaning">{entry.meaning}</div>{/if}
            {#if entry.sentence}
              <div class="vocab-sentence" title={entry.sentence}>“{entry.sentence}”</div>
            {/if}
            <div class="vocab-meta">
              {#if entry.bookTitle}
                <span class="vocab-book-dot" style="background:{bookColor(entry.bookId || entry.bookTitle)}"></span>
                <span>{entry.bookTitle}</span>
              {/if}
              {#if entry.chapter}
                {#if entry.bookTitle}<span class="vocab-meta-sep">·</span>{/if}
                <span>{entry.chapter}</span>
              {/if}
              {#if entry.bookTitle || entry.chapter}<span class="vocab-meta-sep">·</span>{/if}
              <span>{rowDate(entry, group.key)}</span>
            </div>
          </div>
          <button
            class="vocab-del"
            title={t("移出生词本")}
            aria-label={t("移出生词本")}
            on:click={() => remove(entry)}
          >×</button>
        </div>
      {/each}
    {:else}
      <div class="vocab-empty">
        <div class="vocab-empty-icon">{entries.length === 0 ? "★" : "⌕"}</div>
        {#if entries.length === 0}
          <div class="vocab-empty-title">{t("生词本还是空的")}</div>
          <div class="vocab-empty-sub">{t("阅读时点词典卡上的 ☆，或朗读时一键收词。")}</div>
        {:else}
          <div class="vocab-empty-title">{t("没有匹配的生词")}</div>
          <div class="vocab-empty-sub">{t("换个关键词，或切到「全部」。")}</div>
        {/if}
      </div>
    {/each}
  </div>

  {#if removed}
    <div class="vocab-undo" role="status" aria-live="polite">
      <span>{t("已移出「{word}」", { word: removed.word })}</span>
      <button class="vocab-undo-btn" on:click={undoRemove}>{t("撤销")}</button>
      <button class="vocab-undo-close" title={t("关闭")} aria-label={t("关闭")} on:click={dismissUndo}>×</button>
    </div>
  {/if}

  <div class="vocab-note">{t("生词本不内置复习队列；需要复习时导出到 Anki / 思源")}</div>
</section>

<style>
  .vocab-panel {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: 12px 14px 10px;
    overflow: hidden;
    color: var(--b3-theme-on-background, #333);
  }

  /* 整行走普通行内排版：大号数字和 11.5px 说明共享同一条基线。
     原来用 flex + align-items:center，17px 数字被垂直居中，和汉字不在一条线上。 */
  .vocab-summary {
    flex: 0 0 auto;
    padding: 1px 2px 9px;
    color: var(--b3-theme-on-surface-light, #888);
    font-size: 11.5px;
    line-height: 1.2;
  }
  .vocab-stat {
    display: inline;
  }
  .vocab-stat strong {
    margin-right: 2px;
    color: var(--b3-theme-on-background, #333);
    font-size: 17px;
    font-weight: 650;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }
  .vocab-sep {
    color: var(--b3-border-color, rgba(0, 0, 0, 0.18));
    margin: 0 3px;
  }

  .vocab-search {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 6px;
    height: 34px;
    padding: 0 9px;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.15));
    border-radius: 8px;
    background: var(--b3-theme-background-light, rgba(0, 0, 0, 0.03));
    transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
  }
  .vocab-search:focus-within {
    border-color: var(--b3-theme-primary, #378add);
    background: var(--b3-theme-background, #fff);
    box-shadow: 0 0 0 3px var(--b3-theme-primary-light, rgba(55, 138, 221, 0.1));
  }
  .vocab-search svg {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    color: var(--b3-theme-on-surface-light, #999);
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .vocab-search input {
    flex: 1;
    min-width: 0;
    border: none;
    outline: none;
    background: transparent;
    color: var(--b3-theme-on-background, #333);
    font-size: 12px;
  }
  .vocab-search input::placeholder {
    color: var(--b3-theme-on-surface-light, #999);
  }
  .vocab-search input::-webkit-search-cancel-button {
    display: none;
  }
  .vocab-search-clear {
    flex-shrink: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--b3-theme-on-surface-light, #999);
    font-size: 14px;
    line-height: 1;
    padding: 2px;
  }
  .vocab-search-clear:hover {
    color: var(--b3-theme-on-background, #333);
    background: var(--b3-list-hover, rgba(0, 0, 0, 0.05));
  }

  .vocab-filters {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 8px 0 4px;
  }
  .vocab-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 9px;
    border: 1px solid transparent;
    border-radius: 999px;
    background: var(--b3-theme-background-light, rgba(0, 0, 0, 0.05));
    color: var(--b3-theme-on-surface, #666);
    font-size: 11px;
    line-height: 1.4;
    white-space: nowrap;
    cursor: pointer;
  }
  .vocab-chip span {
    color: var(--b3-theme-on-surface-light, #999);
    font-size: 9.5px;
    font-variant-numeric: tabular-nums;
  }
  .vocab-chip:hover {
    background: var(--b3-theme-surface, rgba(0, 0, 0, 0.08));
  }
  .vocab-chip.active {
    background: var(--b3-theme-on-background, #333);
    color: var(--b3-theme-background, #fff);
  }
  .vocab-chip.active span {
    color: var(--b3-theme-background, #fff);
    opacity: 0.7;
  }
  .vocab-sort {
    max-width: 100px;
    margin-left: auto;
    border: none;
    outline: none;
    background: transparent;
    color: var(--b3-theme-on-surface-light, #888);
    font-size: 11px;
    cursor: pointer;
  }
  .vocab-sort option {
    background: var(--b3-theme-background, #fff);
    color: var(--b3-theme-on-background, #333);
  }

  .vocab-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    margin: 2px -4px 0;
    padding: 0 4px 6px;
    overscroll-behavior: contain;
    scrollbar-width: thin;
  }
  .vocab-list::-webkit-scrollbar {
    width: 6px;
  }
  .vocab-list::-webkit-scrollbar-thumb {
    background: var(--b3-border-color, rgba(0, 0, 0, 0.18));
    border-radius: 999px;
  }

  .vocab-group-label {
    padding: 8px 5px 4px;
    color: var(--b3-theme-on-surface-light, #a79d90);
    font-size: 10px;
    letter-spacing: 0.08em;
  }
  .vocab-row {
    display: flex;
    gap: 8px;
    padding: 8px 7px;
    border: 1px solid transparent;
    border-radius: 8px;
    transition: background 0.15s ease, border-color 0.15s ease;
  }
  .vocab-row:hover,
  .vocab-row:focus-within {
    background: var(--b3-list-hover, rgba(0, 0, 0, 0.05));
    border-color: var(--b3-border-color, rgba(0, 0, 0, 0.08));
  }
  .vocab-row-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
    border: none;
    background: none;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .vocab-row-main:focus-visible {
    outline: 2px solid var(--b3-theme-primary, #378add);
    outline-offset: -2px;
    border-radius: 4px;
  }
  .vocab-word-line {
    display: flex;
    align-items: baseline;
    gap: 6px;
    flex-wrap: wrap;
  }
  .vocab-star {
    color: #d69a2b;
    font-size: 9px;
    line-height: 1;
    transform: translateY(-1px);
  }
  .vocab-word {
    font-family: Georgia, "Iowan Old Style", "Times New Roman", var(--b3-font-family, serif);
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.01em;
    color: var(--b3-theme-on-background, #2f2a25);
  }
  .vocab-phonetic {
    color: var(--b3-theme-on-surface-light, #999);
    font-size: 10.5px;
  }
  .vocab-pos {
    padding: 1px 4px;
    border-radius: 4px;
    background: var(--b3-theme-background-light, rgba(0, 0, 0, 0.05));
    color: var(--b3-theme-on-surface, #777);
    font-size: 9.5px;
  }
  .vocab-meaning {
    color: var(--b3-theme-on-background, #444);
    font-size: 12.5px;
    line-height: 1.45;
  }
  .vocab-sentence {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    overflow: hidden;
    color: var(--b3-theme-on-surface-light, #888);
    font-family: Georgia, "Iowan Old Style", "Times New Roman", var(--b3-font-family, serif);
    font-size: 11.5px;
    line-height: 1.45;
  }
  .vocab-meta {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
    color: var(--b3-theme-on-surface-light, #999);
    font-size: 10px;
    line-height: 1.4;
  }
  .vocab-book-dot {
    width: 6px;
    height: 6px;
    flex-shrink: 0;
    border-radius: 50%;
  }
  .vocab-meta-sep {
    opacity: 0.6;
  }
  .vocab-del {
    align-self: flex-start;
    width: 24px;
    height: 24px;
    flex-shrink: 0;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--b3-theme-on-surface-light, #999);
    font-size: 15px;
    line-height: 1;
    opacity: 0;
    transition: opacity 0.15s ease, background 0.15s ease, color 0.15s ease;
  }
  .vocab-row:hover .vocab-del,
  .vocab-row:focus-within .vocab-del {
    opacity: 1;
  }
  .vocab-del:hover {
    background: var(--b3-theme-error-light, rgba(226, 75, 74, 0.08));
    color: var(--b3-theme-error, #b54b45);
  }
  @media (hover: none) {
    .vocab-del { opacity: 1; }
  }

  .vocab-empty {
    padding: 34px 12px 24px;
    text-align: center;
    color: var(--b3-theme-on-surface-light, #888);
  }
  .vocab-empty-icon {
    width: 40px;
    height: 40px;
    display: grid;
    place-items: center;
    margin: 0 auto 10px;
    border-radius: 50%;
    background: var(--b3-theme-background-light, rgba(0, 0, 0, 0.04));
    color: var(--b3-theme-on-surface-light, #aaa);
    font-size: 17px;
  }
  .vocab-empty-title {
    margin-bottom: 4px;
    color: var(--b3-theme-on-surface, #555);
    font-size: 13px;
    font-weight: 600;
  }
  .vocab-empty-sub {
    max-width: 230px;
    margin: 0 auto;
    font-size: 11.5px;
    line-height: 1.5;
  }

  .vocab-undo {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
    padding: 6px 8px;
    border-radius: 7px;
    background: var(--b3-theme-background-light, rgba(0, 0, 0, 0.04));
    color: var(--b3-theme-on-surface, #666);
    font-size: 11px;
  }
  .vocab-undo-btn {
    margin-left: auto;
    border: none;
    background: transparent;
    color: var(--b3-theme-primary, #378add);
    font-size: 11px;
    font-weight: 600;
    padding: 2px 4px;
  }
  .vocab-undo-close {
    border: none;
    background: transparent;
    color: var(--b3-theme-on-surface-light, #999);
    font-size: 14px;
    line-height: 1;
    padding: 1px 3px;
  }

  .vocab-note {
    flex: 0 0 auto;
    margin-top: 4px;
    padding: 7px 2px 0;
    border-top: 1px dashed var(--b3-border-color, rgba(0, 0, 0, 0.1));
    color: var(--b3-theme-on-surface-light, #aaa);
    font-size: 10px;
    line-height: 1.4;
    text-align: center;
  }
</style>