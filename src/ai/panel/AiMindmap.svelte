<script lang="ts">
  /**
   * 思维导图渲染（P3-B）
   * ------------------------------------------------------------------
   * 只做「画」：解析与坐标都在 ai-mindmap.ts（纯逻辑可单测）。
   * 节点交互：
   *  - 有子节点 → 点击折叠/展开；
   *  - 带思源块引用（ref）的叶子 → 点击打开对应块；
   *  - 有子节点又有 ref → 单击折叠，双击打开引用。
   * 导图可能比面板宽，容器横向滚动；高度封顶，不把对话顶走。
   */
  import { t } from "../../i18n/index.ts";
  import {
    layoutMindmap,
    type MindmapLayoutNode,
    type MindmapNode,
  } from "./ai-mindmap.ts";

  export let root: MindmapNode;
  export let onOpenBlock: ((id: string) => void) | undefined = undefined;

  let collapsed: Record<string, true> = {};
  let lastRoot: MindmapNode | null = null;

  $: if (root !== lastRoot) {
    lastRoot = root;
    collapsed = {};
  }
  $: collapsedIds = Object.keys(collapsed);
  $: layout = layoutMindmap(root, { collapsed: collapsedIds });
  $: hasCollapsed = collapsedIds.length > 0;

  function toggle(node: MindmapLayoutNode): void {
    if (!node.hasChildren) return;
    const next: Record<string, true> = { ...collapsed };
    if (next[node.id]) delete next[node.id];
    else next[node.id] = true;
    collapsed = next;
  }

  function nodeClick(node: MindmapLayoutNode): void {
    if (node.hasChildren) toggle(node);
    else if (node.ref) onOpenBlock?.(node.ref);
  }

  function nodeDblClick(node: MindmapLayoutNode): void {
    if (node.ref) onOpenBlock?.(node.ref);
  }

  function nodeKey(e: KeyboardEvent, node: MindmapLayoutNode): void {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    nodeClick(node);
  }

  function expandAll(): void {
    collapsed = {};
  }

  function nodeTitle(node: MindmapLayoutNode): string {
    const base = node.text || "";
    if (node.hasChildren) return `${base}\n${t("点击折叠或展开")}`;
    if (node.ref) return `${base}\n${t("点击打开引用的块")}`;
    return base;
  }
</script>

<div class="mm-card">
  <div class="mm-hd">
    <span class="mm-title">{t("思维导图")}</span>
    <span class="mm-count">{t("{n} 个节点", { n: layout.nodes.length })}</span>
    <span class="mm-spacer"></span>
    {#if hasCollapsed}
      <button class="mm-mini" on:click={expandAll}>{t("展开全部")}</button>
    {/if}
  </div>
  <div class="mm-scroll">
    <svg
      class="mm-svg"
      width={layout.width}
      height={layout.height}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      role="img"
      aria-label={t("思维导图")}
    >
      {#each layout.edges as edge (edge.from + ">" + edge.to)}
        <path class="mm-edge" d={edge.d}></path>
      {/each}

      {#each layout.nodes as node (node.id)}
        <g
          class="mm-node"
          class:root={node.depth === 0}
          class:collapsed={node.collapsed}
          class:has-ref={!!node.ref}
          transform={`translate(${node.x},${node.y})`}
          role="button"
          tabindex="0"
          aria-label={nodeTitle(node)}
          on:click={() => nodeClick(node)}
          on:dblclick={() => nodeDblClick(node)}
          on:keydown={(e) => nodeKey(e, node)}
        >
          <title>{nodeTitle(node)}</title>
          <rect width={node.w} height={node.h} rx="8"></rect>
          {#each node.lines as line, li (li)}
            <text class="mm-label" x="10" y={node.lines.length > 1 ? (li === 0 ? 18 : 34) : node.h / 2 + 4}>
              {line}
            </text>
          {/each}
          {#if node.hasChildren}
            <circle class="mm-toggle-hit" cx={node.w - 13} cy={node.h / 2} r="8"></circle>
            <text class="mm-toggle" x={node.w - 13} y={node.h / 2 + 4} text-anchor="middle">
              {node.collapsed ? "+" : "−"}
            </text>
          {:else if node.ref}
            <text class="mm-open" x={node.w - 13} y={node.h / 2 + 4} text-anchor="middle">↗</text>
          {/if}
        </g>
      {/each}
    </svg>
  </div>
</div>

<style>
  .mm-card {
    margin: 8px 0;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.1));
    border-radius: 9px;
    background: var(--b3-theme-background, #fff);
    overflow: hidden;
    min-width: 0;
  }
  .mm-hd {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    border-bottom: 1px dashed var(--b3-border-color, rgba(0, 0, 0, 0.1));
    font-size: 11px;
    color: var(--b3-theme-on-surface-light, #9aa0a6);
  }
  .mm-title {
    color: var(--b3-theme-on-background, #1f2329);
    font-weight: 600;
  }
  .mm-count {
    font-variant-numeric: tabular-nums;
  }
  .mm-spacer {
    flex: 1;
  }
  .mm-mini {
    flex: none;
    padding: 2px 7px;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.14));
    border-radius: 999px;
    background: transparent;
    color: var(--b3-theme-on-surface, #6b7280);
    font-size: 10.5px;
    cursor: pointer;
  }
  .mm-mini:hover {
    border-color: var(--b3-theme-primary, #378add);
    color: var(--b3-theme-primary, #378add);
  }
  .mm-scroll {
    overflow: auto;
    max-height: 340px;
    overscroll-behavior: contain;
    scrollbar-width: thin;
  }
  .mm-svg {
    display: block;
    max-width: none;
  }
  .mm-edge {
    fill: none;
    stroke: var(--b3-border-color, rgba(0, 0, 0, 0.2));
    stroke-width: 1.4;
  }
  .mm-node {
    cursor: pointer;
    outline: none;
  }
  .mm-node rect {
    fill: var(--b3-theme-background, #fff);
    stroke: var(--b3-border-color, rgba(0, 0, 0, 0.16));
    stroke-width: 1;
    transition: stroke 0.12s ease;
  }
  .mm-node:hover rect,
  .mm-node:focus-visible rect {
    stroke: var(--b3-theme-primary, #378add);
  }
  .mm-node.root rect {
    fill: var(--b3-theme-primary-lightest, rgba(55, 138, 221, 0.1));
    stroke: var(--b3-theme-primary, #378add);
  }
  .mm-node.collapsed rect {
    stroke-dasharray: 3 2;
  }
  .mm-label {
    fill: var(--b3-theme-on-background, #1f2329);
    font-size: 12px;
    font-family: var(--b3-font-family, inherit);
    pointer-events: none;
    user-select: none;
  }
  .mm-node.has-ref .mm-label {
    fill: var(--b3-theme-primary, #378add);
  }
  .mm-toggle-hit {
    fill: transparent;
  }
  .mm-toggle,
  .mm-open {
    fill: var(--b3-theme-on-surface, #6b7280);
    font-size: 12px;
    pointer-events: none;
    user-select: none;
  }
  .mm-node.root .mm-toggle {
    fill: var(--b3-theme-primary, #378add);
  }
  .mm-node:hover .mm-toggle,
  .mm-node:hover .mm-open {
    fill: var(--b3-theme-primary, #378add);
  }
</style>
