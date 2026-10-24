<!--
  笔记发送目标 · 总览页（2026-10-10 列表化收敛新建）
  ==================================================================
  ## 职责
  把「本书发送目标 / 全局默认目标 / 自动建档位置 / 归档子路径」四件事收敛到
  一个可滚动的总览页：
    · 顶部灰区：默认目标行 + 自动建档行（笔记本下拉 + 子路径 + 开关）
    · 统计 + 搜索
    · 书目列表：逐本显示绑定状态（使用中 / 跟随默认 / 未设置）+ 选择 / 清除

  ## 数据流（与旧链路完全一致）
    · 自动建档三件套（autoNotebookId / autoNotebookName / autoArchivePath /
      autoArchiveEnabled）经 on:change 冒泡给宿主落盘；
    · 默认目标 / 每本书的文档选择 → 派发 openTree{mode,bookId} 让宿主切到
      docTree 子页，由 docTree 的 pick 写回对应字段；
    · 清除某本书的绑定 → 派发 clearBook{bookId}。

  ## 复用
    样式复用 settings-dialog.less 的全局类（.rwd-card / .rw-row / .rw-label /
    .rw-control / .rw-switch / .rw-select / .rw-action-current /
    .rwd-docpick-input），保证与设置面板其它二级页视觉一致。
-->
<script lang="ts">
  import { createEventDispatcher, onMount, onDestroy } from "svelte";
  import { t } from "../../i18n/index.ts";
  import { loadDocPickerApi } from "./doc-picker-api.ts";

  /** 书架 store（BookshelfStore 实例；含 list / get / setNotebookTarget / subscribe） */
  export let store: any = null;
  /** 当前设置（读 exportDocId / autoArchive* 等） */
  export let settings: any = {};
  /** 宿主注入的思源 API（列笔记本用；缺省时自加载兜底） */
  export let api: any = null;

  const dispatch = createEventDispatcher();

  /** 书架书籍列表（由 store 订阅驱动，实时刷新） */
  let books: any[] = [];
  let unsub: () => void = () => {};

  /** 笔记本列表（自动建档下拉用） */
  let notebooks: { id: string; name: string }[] = [];
  let nbLoading = false;
  let nbError = "";

  /** 搜索书名关键字 */
  let keyword = "";

  onMount(async () => {
    // 订阅书架：导入/删除/改绑定都会刷新本页列表
    if (store && typeof store.subscribe === "function") {
      unsub = store.subscribe((list: any[]) => {
        books = Array.isArray(list) ? list.slice() : [];
      });
    }
    // 拉笔记本列表（自动建档锚点下拉）
    nbLoading = true;
    try {
      const a = api?.listNotebooks ? api : await loadDocPickerApi();
      if (a?.listNotebooks) {
        notebooks = (await a.listNotebooks()) || [];
      } else {
        nbError = t("思源接口未就绪，无法列出笔记本");
      }
    } catch (__e) {
      nbError = __e instanceof Error ? __e.message : t("读取笔记本列表失败");
    } finally {
      nbLoading = false;
    }
  });

  onDestroy(() => unsub());

  /** 是否绑定了本书目标 */
  function isBookBound(b: any): boolean {
    return !!(store?.getNotebookTarget && store.getNotebookTarget(b.id)?.docId);
  }
  /** 全局默认是否已设 */
  $: globalSet = !!String(settings?.exportDocId ?? "").trim();
  /** 默认目标当前标题 */
  $: defaultTitle = String(settings?.exportDocTitle ?? "").trim();
  $: defaultSet = globalSet;

  /** 已绑定书数量（含 per-book 绑定；以书架实时状态计） */
  $: boundCount = books.filter((b) => isBookBound(b)).length;

  /** 排序：最近阅读倒序 */
  $: sortedBooks = [...books].sort(
    (a, b) => (b.lastReadAt ?? b.addedAt ?? 0) - (a.lastReadAt ?? a.addedAt ?? 0),
  );
  /** 搜索过滤 */
  $: kw = keyword.trim().toLowerCase();
  $: filteredBooks = kw
    ? sortedBooks.filter((b) => String(b.title ?? "").toLowerCase().includes(kw))
    : sortedBooks;

  /** 书的发送目标状态文字 */
  function statusText(b: any): string {
    if (isBookBound(b)) {
      const tgt = store.getNotebookTarget(b.id);
      return tgt?.docTitle?.trim() ? `《${tgt.docTitle.trim()}》` : tgt?.docId ?? "";
    }
    if (globalSet) return t("跟随默认");
    return t("未设置");
  }

  function openTree(mode: "default" | "book", bookId = "") {
    dispatch("openTree", { mode, bookId });
  }
  function clearBook(bookId: string) {
    dispatch("clearBook", { bookId });
  }
  function toggleAuto(e: Event) {
    const v = (e.currentTarget as HTMLInputElement).checked;
    dispatch("change", { path: "autoArchiveEnabled", value: v });
  }
  function pickNotebook(e: Event) {
    const id = (e.currentTarget as HTMLSelectElement).value;
    const name = notebooks.find((n) => n.id === id)?.name ?? "";
    dispatch("change", { path: "autoNotebookId", value: id });
    dispatch("change", { path: "autoNotebookName", value: name });
  }
  function setSubpath(e: Event) {
    dispatch("change", { path: "autoArchivePath", value: (e.currentTarget as HTMLInputElement).value });
  }
</script>

<div class="rwt-mgr">
  <!-- ===== 顶部灰区：默认目标 + 自动建档 ===== -->
  <section class="rwd-card rwt-mgr-zone">
    <!-- 默认目标行 -->
    <div class="rw-row">
      <div class="rw-label">
        <span class="rw-label-text">{t("默认目标")}</span>
        <span class="rw-hint">{t("所有未单独设置的书，导出时落到这里")}</span>
      </div>
      <div class="rw-control">
        {#if defaultSet}
          <span class="rw-action-current">{defaultTitle ? `《${defaultTitle}》` : settings.exportDocId}</span>
        {:else}
          <span class="rw-action-current empty">{t("未设置")}</span>
        {/if}
        <button type="button" class="rwt-mgr-go" on:click={() => openTree("default")}>
          {t("选择")}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>
    </div>

    <!-- 自动建档行（2026-10-10 收敛：笔记本下拉 + 子路径 + 开关） -->
    <div class="rw-row rwt-mgr-auto">
      <div class="rw-label">
        <span class="rw-label-text">{t("自动建档")}</span>
        <span class="rw-hint">
          {settings?.autoNotebookId
            ? t("锚点已设 · 未绑定的书自动建《书名》")
            : t("未设锚点则不生效")}
        </span>
      </div>
      <div class="rwt-mgr-auto-ctrl">
        <select class="rw-select" value={settings?.autoNotebookId ?? ""} on:change={pickNotebook}>
          <option value="">{t("未选择")}</option>
          {#each notebooks as n (n.id)}<option value={n.id}>{n.name}</option>{/each}
        </select>
        <label class="rw-switch">
          <input
            type="checkbox"
            checked={settings?.autoArchiveEnabled !== false}
            on:change={toggleAuto}
          />
          <span class="rw-switch-track"><span class="rw-switch-thumb"></span></span>
        </label>
      </div>
    </div>

    <!-- 归档子路径（独立一行，避免与开关挤在一起） -->
    <div class="rw-row rwt-mgr-auto">
      <div class="rw-label">
        <span class="rw-label-text">{t("归档子路径")}</span>
        <span class="rw-hint">{t("建在归档笔记本根目录下的子目录，可留空")}</span>
      </div>
      <div class="rwt-mgr-auto-ctrl">
        <input
          class="rwd-docpick-input rwt-mgr-subpath"
          type="text"
          placeholder="/RE阅读器"
          value={settings?.autoArchivePath ?? ""}
          on:input={setSubpath}
        />
      </div>
    </div>
  </section>

  <!-- ===== 统计 + 搜索 ===== -->
  <div class="rwt-mgr-stat">
    <span class="rwt-mgr-count">
      {t("共 {n} 本 · 已绑定 {m}", { n: books.length, m: boundCount })}
    </span>
    <input
      class="rwd-docpick-input rwt-mgr-search"
      type="search"
      placeholder={t("搜索书名")}
      bind:value={keyword}
    />
  </div>

  <!-- ===== 书目列表 ===== -->
  {#if !filteredBooks.length}
    <div class="rwt-mgr-empty">
      {keyword ? t("没有匹配的书") : t("书架空空如也")}
    </div>
  {:else}
    <div class="rwt-mgr-list">
      {#each filteredBooks as b (b.id)}
        {@const bound = isBookBound(b)}
        <div class="rwt-mgr-book">
          <div class="rwt-mgr-book-main">
            <span class="rwt-mgr-book-title">{b.title || t("（无标题）")}</span>
            <span class="rwt-mgr-book-sub" class:dim={!bound && !globalSet}>
              {statusText(b)}
            </span>
          </div>
          <div class="rwt-mgr-book-actions">
            {#if bound}
              <span class="rwt-mgr-badge ok">{t("使用中")}</span>
              <button type="button" class="rwt-mgr-ghost" on:click={() => clearBook(b.id)}>
                {t("清除绑定")}
              </button>
            {:else if globalSet}
              <span class="rwt-mgr-badge info">{t("跟随默认")}</span>
            {/if}
            <button type="button" class="rwt-mgr-go" on:click={() => openTree("book", b.id)}>
              {t("选择")}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                   stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .rwt-mgr { display: flex; flex-direction: column; gap: 12px; }
  .rwt-mgr-zone { padding: 4px 0; }

  /* 自动建档行：标签在上、控件在下，避免单行挤爆 */
  .rwt-mgr-auto { flex-direction: column; align-items: stretch; gap: 8px; padding: 10px 14px; }
  .rwt-mgr-auto-ctrl { display: flex; align-items: center; gap: 10px; }
  .rwt-mgr-subpath { flex: 1; min-width: 0; }
  .rwt-mgr-auto .rw-hint { max-width: 100%; }

  /* 统计 + 搜索 */
  .rwt-mgr-stat {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    padding: 0 2px;
  }
  .rwt-mgr-count { font-size: 12.5px; color: var(--b3-theme-on-surface-light, #8a8a90); white-space: nowrap; }
  .rwt-mgr-search { flex: 0 1 200px; min-width: 0; }

  /* 书目列表 */
  .rwt-mgr-empty {
    padding: 28px 0; text-align: center; font-size: 13px;
    color: var(--b3-theme-on-surface-light, #8a8a90);
  }
  .rwt-mgr-list {
    display: flex; flex-direction: column; gap: 2px;
    max-height: 46vh; overflow-y: auto;
    border: 1px solid var(--b3-border-color, rgba(127, 127, 127, 0.08));
    border-radius: 10px; padding: 4px;
  }
  .rwt-mgr-book {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    padding: 9px 10px; border-radius: 7px; cursor: default;
  }
  .rwt-mgr-book:hover { background: var(--b3-list-hover, rgba(127, 127, 127, 0.08)); }
  .rwt-mgr-book-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .rwt-mgr-book-title {
    font-size: 13.5px; color: var(--b3-theme-on-background, #e8e8ea);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .rwt-mgr-book-sub { font-size: 11.5px; color: var(--b3-theme-primary, #5b7cfa); }
  .rwt-mgr-book-sub.dim { color: var(--b3-theme-on-surface-light, #8a8a90); }
  .rwt-mgr-book-actions { display: flex; align-items: center; gap: 8px; flex: none; }

  .rwt-mgr-badge {
    padding: 1px 7px; border-radius: 4px; font-size: 10.5px;
  }
  .rwt-mgr-badge.ok { background: color-mix(in srgb, var(--b3-theme-success, #2ea121) 16%, transparent); color: var(--b3-theme-success, #2ea121); }
  .rwt-mgr-badge.info { background: color-mix(in srgb, var(--b3-theme-primary, #5b7cfa) 16%, transparent); color: var(--b3-theme-primary, #5b7cfa); }

  /* 同排「选择 / 清除绑定」按钮：沿用 action 行按钮观感 */
  .rwt-mgr-go {
    display: inline-flex; align-items: center; gap: 2px;
    border: 1px solid var(--b3-border-color, rgba(127, 127, 127, 0.2));
    background: transparent; color: var(--b3-theme-on-background, #e8e8ea);
    border-radius: 6px; padding: 4px 9px; font-size: 12.5px; cursor: pointer; font-family: inherit;
  }
  .rwt-mgr-go:hover { border-color: var(--b3-theme-primary, #5b7cfa); color: var(--b3-theme-primary, #5b7cfa); }
  .rwt-mgr-go svg { width: 13px; height: 13px; }
  .rwt-mgr-ghost {
    border: 1px solid var(--b3-border-color, rgba(127, 127, 127, 0.2));
    background: transparent; color: var(--b3-theme-error, #e24b4a);
    border-radius: 6px; padding: 4px 9px; font-size: 12.5px; cursor: pointer; font-family: inherit;
  }
  .rwt-mgr-ghost:hover { background: color-mix(in srgb, var(--b3-theme-error, #e24b4a) 12%, transparent); }
</style>
