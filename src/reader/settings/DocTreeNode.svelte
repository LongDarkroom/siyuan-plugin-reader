<!--
  文档树 · 单节点（2026-10-10）
  递归渲染：文件夹 ▸/▾ 折叠、文档名可选（高亮「使用中/默认目标」）。
  搜索态下由 matchSet 控制显隐与展开（命中项祖先路径自动展开）。
-->
<script lang="ts">
  import { t } from "../../i18n/index.ts";

  export let node: any;
  export let depth = 0;
  export let expanded: Set<string> = new Set();
  export let matchSet: Set<string> | null = null;
  export let highlightId = "";
  export let mode: "default" | "book" = "default";
  /** 本次待确认选中的文档 id（打勾态；≠ highlightId 的「已绑定」徽标） */
  export let pickedId = "";
  export let onPick: (n: any) => void = () => {};
  export let onToggle: (n: any) => void = () => {};
</script>

{#if !matchSet || matchSet.has(node.hpath)}
  <div class="rwt-node" class:rowsel={!node.isFolder && pickedId === node.docId} style="padding-left: {8 + depth * 20}px">
    <span
      class="rwt-arrow"
      class:leaf={!node.isFolder}
      class:open={node.isFolder && expanded.has(node.hpath)}
      on:click|stopPropagation={() => onToggle(node)}
    ></span>
    {#if node.isFolder}
      <span class="rwt-name rwt-folder" class:nbnode={node.isNotebook} on:click={() => onToggle(node)}>{node.name}</span>
    {:else}
      <span
        class="rwt-name"
        class:sel={highlightId === node.docId}
        on:click={() => onPick(node)}
      >{node.name}
        {#if pickedId === node.docId}
          <span class="rwt-check" aria-label={t("已选中")}>✓</span>
        {/if}
        {#if highlightId === node.docId}
          <span class="rwt-badge" class:info={mode === "default"} class:ok={mode === "book"}>
            {mode === "default" ? t("默认目标") : t("使用中")}
          </span>
        {/if}
      </span>
    {/if}
  </div>

  {#if node.children.length && (matchSet ? matchSet.has(node.hpath) : expanded.has(node.hpath))}
    {#each node.children as c (c.hpath)}
      <svelte:self
        node={c} depth={depth + 1} {expanded} matchSet={matchSet} {highlightId} {mode} {pickedId} {onPick} {onToggle}
      />
    {/each}
  {/if}
{/if}

<style>
  .rwt-node {
    display: flex; align-items: center; gap: 4px; padding: 6px 12px;
    cursor: pointer; font-size: 13px; color: var(--b3-theme-on-background, #222);
  }
  .rwt-node:hover { background: var(--b3-list-hover, rgba(127, 127, 127, 0.08)); }
  /* 待确认选中行：整行浅主色底 + 左侧主色条（区别于 hover，静态可见） */
  .rwt-node.rowsel {
    background: color-mix(in srgb, var(--b3-theme-primary, #3370ff) 12%, transparent);
    box-shadow: inset 2px 0 0 var(--b3-theme-primary, #3370ff);
  }
  /* 折叠箭头：CSS 三角替代字形字符（旧版 10px 浅灰 ▸ 几乎看不清），16px 热区 + hover 反馈 */
  .rwt-arrow {
    width: 16px; height: 16px; flex: none; border-radius: 4px;
    display: inline-flex; align-items: center; justify-content: center;
    color: color-mix(in srgb, var(--b3-theme-on-background, #222) 62%, transparent);
  }
  .rwt-arrow.leaf { pointer-events: none; }
  .rwt-arrow:not(.leaf)::before {
    content: "";
    display: block;
    width: 0; height: 0;
    border-left: 5px solid currentColor;
    border-top: 4px solid transparent;
    border-bottom: 4px solid transparent;
    transform: rotate(90deg); /* 展开 = 尖朝下 */
    transition: transform 0.12s ease;
  }
  .rwt-arrow:not(.leaf):not(.open)::before { transform: rotate(0deg); /* 折叠 = 尖朝右 */ }
  .rwt-arrow:not(.leaf):hover {
    background: var(--b3-list-hover, rgba(127, 127, 127, 0.18));
    color: var(--b3-theme-primary, #3370ff);
  }
  .rwt-name {
    flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .rwt-name.sel { color: var(--b3-theme-primary, #3370ff); font-weight: 500; }
  .rwt-folder { font-weight: 500; color: var(--b3-theme-on-surface-light, #888); }
  /* 顶层笔记本分组节点：主色加粗，与普通文件夹一眼区分 */
  .rwt-folder.nbnode { color: var(--b3-theme-primary, #3370ff); font-weight: 600; }
  .rwt-badge {
    display: inline-block; margin-left: 6px; border-radius: 6px;
    padding: 0 7px; font-size: 11px; font-weight: 400; vertical-align: middle;
  }
  .rwt-badge.info { background: color-mix(in srgb, var(--b3-theme-primary, #3370ff) 16%, transparent); color: var(--b3-theme-primary, #3370ff); }
  .rwt-badge.ok { background: color-mix(in srgb, var(--b3-theme-success, #2ea121) 16%, transparent); color: var(--b3-theme-success, #2ea121); }
  /* 选中勾：主色实心圆 + 白勾 */
  .rwt-check {
    display: inline-flex; align-items: center; justify-content: center;
    width: 15px; height: 15px; margin-left: 6px; border-radius: 50%;
    background: var(--b3-theme-primary, #3370ff); color: #fff;
    font-size: 10px; line-height: 1; vertical-align: middle;
  }
</style>
