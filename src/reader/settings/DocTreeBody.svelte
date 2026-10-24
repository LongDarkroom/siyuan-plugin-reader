<!--
  文档树选择器 · 展示组件（2026-10-10）
  纯展示：笔记本筛选 + 搜索 + 树 + 粘贴 ID 兜底。
  所有状态与逻辑由 DocTreePickerPage 持有，本组件只接收 props 与事件回调。
-->
<script lang="ts">
  import { t } from "../../i18n/index.ts";
  import DocTreeNode from "./DocTreeNode.svelte";

  export let tree: any[] = [];
  export let loading = false;
  export let loadError = "";
  export let keyword = "";
  export let expanded: Set<string> = new Set();
  export let highlightId = "";
  /** 待确认选中的文档 id（打勾态） */
  export let pickedId = "";
  export let mode: "default" | "book" = "default";
  export let selectedNotebook = "";
  export let notebooks: { id: string; name: string }[] = [];
  export let manualId = "";
  export let showManual = false;

  export let matchSet: () => Set<string> | null = () => null;
  export let filteredRoots: () => any[] = () => tree;

  export let onReload: () => void = () => {};
  export let onPick: (n: any) => void = () => {};
  export let onToggle: (n: any) => void = () => {};
  export let onClear: () => void = () => {};
  export let onUseManual: () => void = () => {};
  export let onKeyword: (v: string) => void = () => {};
  export let onNotebook: (v: string) => void = () => {};
  export let onManual: (v: string) => void = () => {};
  export let onToggleManual: (v: boolean) => void = () => {};
</script>

<div class="rwt-body">
  {#if loadError}
    <div class="rwt-err">
      <span>{loadError}</span>
      <button type="button" class="rwt-retry" on:click={onReload}>{t("重试")}</button>
    </div>
  {/if}

  {#if !loadError}
    <div class="rwt-toolbar">
      {#if notebooks.length}
        <select class="rwt-nb" value={selectedNotebook} on:change={(e) => onNotebook(e.currentTarget.value)}>
          <option value="">{t("全部笔记本")}</option>
          {#each notebooks as n (n.id)}<option value={n.id}>{n.name}</option>{/each}
        </select>
      {/if}
      <input
        class="rwt-search"
        type="search"
        placeholder={t("搜索文档名（自动展开路径）")}
        value={keyword}
        on:input={(e) => onKeyword(e.currentTarget.value)}
      />
    </div>
  {/if}

  {#if mode === "book" && highlightId}
    <div class="rwt-clear-row">
      <span class="rwt-clear-tip">{t("已绑定本文档")}</span>
      <button type="button" class="rwt-clear-btn" on:click={onClear}>{t("清除绑定")}</button>
    </div>
  {/if}

  <div class="rwt-tree">
    {#if loading}
      <div class="rwt-loading">{t("正在读取文档…")}</div>
    {:else if !loadError && filteredRoots().length === 0}
      <div class="rwt-empty">{t("没有可用文档")}</div>
    {:else if !loadError}
      {#each filteredRoots() as n (n.hpath)}
        <DocTreeNode
          node={n} depth={0} {expanded} matchSet={matchSet()} {highlightId} {mode} {pickedId}
          onPick={onPick} onToggle={onToggle}
        />
      {/each}
    {/if}
  </div>

  <div class="rwt-foot">
    <button type="button" class="rwt-foot-toggle" on:click={() => onToggleManual(!showManual)}>
      {t("找不到文档？直接粘贴文档 ID")}
    </button>
    {#if showManual}
      <div class="rwt-manual">
        <input
          class="rwt-manual-in"
          type="text"
          placeholder="20200812220555-lj3enxa"
          value={manualId}
          on:input={(e) => onManual(e.currentTarget.value)}
          on:keydown={(e) => e.key === "Enter" && onUseManual()}
        />
        <button type="button" class="rwt-manual-btn" on:click={onUseManual}>{t("使用该 ID")}</button>
      </div>
    {/if}
    <div class="rwt-hint">{t("缩进 = 层级 · 点箭头折叠 · 点文档名打勾选中，再点底部「确定选择」生效")}</div>
  </div>
</div>

<style>
  .rwt-body { display: flex; flex-direction: column; min-height: 0; height: 100%; }
  .rwt-err {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 8px 10px; border-radius: 6px; font-size: 12px;
    color: var(--b3-theme-error, #e24b4a);
    background: color-mix(in srgb, var(--b3-theme-error, #e24b4a) 12%, transparent);
  }
  .rwt-retry {
    border: 0.5px solid var(--b3-border-color, rgba(127, 127, 127, 0.25)); background: transparent;
    color: var(--b3-theme-on-background, #222); border-radius: 6px; padding: 3px 10px; font-size: 12px; cursor: pointer;
  }
  .rwt-toolbar { display: flex; gap: 8px; padding: 8px 0; }
  .rwt-nb, .rwt-search {
    padding: 7px 10px; border: 0.5px solid var(--b3-border-color, rgba(127, 127, 127, 0.25));
    border-radius: 6px; background: var(--b3-theme-background, #fff); color: var(--b3-theme-on-background, #222); font-size: 13px;
  }
  .rwt-nb { flex: none; max-width: 45%; }
  .rwt-search { flex: 1; min-width: 0; }
  .rwt-clear-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 6px 10px; margin-bottom: 6px; border-radius: 6px;
    background: var(--b3-theme-surface, #f3f4f6);
  }
  .rwt-clear-tip { font-size: 12px; color: var(--b3-theme-on-surface-light, #888); }
  .rwt-clear-btn {
    border: 0.5px solid var(--b3-border-color, rgba(127, 127, 127, 0.25)); background: transparent;
    color: var(--b3-theme-error, #e24b4a); border-radius: 6px; padding: 3px 10px; font-size: 12px; cursor: pointer;
  }
  .rwt-tree { flex: 1; min-height: 0; overflow: auto; }
  .rwt-loading, .rwt-empty { padding: 16px; text-align: center; font-size: 13px; color: var(--b3-theme-on-surface-light, #aaa); }
  .rwt-foot { border-top: 0.5px solid var(--b3-border-color, rgba(127, 127, 127, 0.18)); padding-top: 8px; margin-top: 4px; }
  .rwt-foot-toggle {
    border: none; background: transparent; cursor: pointer; font-size: 12px;
    color: var(--b3-theme-primary, #3370ff); padding: 0;
  }
  .rwt-manual { display: flex; gap: 6px; margin-top: 6px; }
  .rwt-manual-in {
    flex: 1; min-width: 0; padding: 7px 10px; border: 0.5px solid var(--b3-border-color, rgba(127, 127, 127, 0.25));
    border-radius: 6px; background: var(--b3-theme-background, #fff); color: var(--b3-theme-on-background, #222); font-size: 13px;
  }
  .rwt-manual-btn {
    border: 0.5px solid var(--b3-border-color, rgba(127, 127, 127, 0.25)); background: transparent;
    color: var(--b3-theme-on-background, #222); border-radius: 6px; padding: 3px 11px; font-size: 12px; cursor: pointer;
  }
  .rwt-hint { font-size: 11px; color: var(--b3-theme-on-surface-light, #aaa); margin-top: 6px; }
</style>
