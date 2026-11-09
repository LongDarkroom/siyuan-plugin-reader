<script lang="ts">
  /**
   * 思维导图画布（P3-C）
   * ------------------------------------------------------------------
   * 「看」的手感都在这层：按住拖动平移、⌘/Ctrl+滚轮跟着指针缩放、双击适应画布，
   * 加一条视口工具条（适应画布/适应宽度/缩放/1:1/展开到第 N 级/滚轮平移/锁定视图/⤢ 放大）。
   * 容器 `overflow:hidden` + 单个 `<g transform="translate() scale()">`，
   * 不再是「定高盒子 + 裸滚动条」——6 层图约 1200px 宽时不必拖着滚动条爬。
   * 缩放/平移公式全在 ai-mindmap.ts（纯逻辑可单测），这里只接线。
   */
  import { onMount } from "svelte";
  import { t } from "../../i18n/index.ts";
  import {
    boundedMindmapPan,
    clampMindmapScale,
    fitMindmapViewport,
    fitMindmapWidth,
    heuristicMindmapWidth,
    layoutMindmap,
    mindmapWheelScale,
    MINDMAP_MAX_SCALE,
    MINDMAP_MIN_SCALE,
    resetMindmapViewport,
    zoomMindmapAt,
    type MindmapLayoutNode,
    type MindmapMeasurer,
    type MindmapNode,
    type MindmapViewBox,
    type MindmapViewport,
  } from "./ai-mindmap.ts";

  export let root: MindmapNode;
  /** 已折叠节点 id（状态归父组件：卡片与放大弹层共用同一份） */
  export let collapsed: string[] = [];
  export let onOpenBlock: ((id: string) => void) | undefined = undefined;
  export let onToggle: ((id: string) => void) | undefined = undefined;
  export let onFoldDepth: ((depth: number) => void) | undefined = undefined;
  /** 放大弹层里不再重复提供「⤢ 放大」入口 */
  export let wide = false;
  export let onExpand: (() => void) | undefined = undefined;

  let host: HTMLDivElement;
  let measureEl: SVGTextElement;
  /** 挂载后才有真实字体度量；第一帧先用估算，随后重排一次 */
  let ready = false;
  let viewW = 0;
  let viewH = 0;
  let vp: MindmapViewport = { s: 1, ox: 8, oy: 8 };
  let locked = false;
  let wheelPan = false;
  let depthChoice = 0;
  let lastRoot: MindmapNode | null = null;
  let drag: { id: number; x: number; y: number; ox: number; oy: number; moved: boolean } | null = null;
  let swallowClick = false;

  $: if (root !== lastRoot) {
    lastRoot = root;
    depthChoice = 0;
  }

  /**
   * 真实宽度：量一个隐形 <text>。逐字量会疯狂触发强制重算，所以按串缓存
   * （单字与整行同一张表）——同一字体下宽度稳定，一次重排实际只量几十次。
   */
  const widthCache = new Map<string, number>();
  const domWidth = (text: string): number => {
    if (!text) return 0;
    const hit = widthCache.get(text);
    if (hit !== undefined) return hit;
    if (!measureEl) return NaN;
    measureEl.textContent = text;
    const w = measureEl.getComputedTextLength();
    if (!(w > 0)) return NaN;
    if (widthCache.size > 4000) widthCache.clear();
    widthCache.set(text, w);
    return w;
  };
  const measure: MindmapMeasurer = (text: string): number => {
    if (!ready) return heuristicMindmapWidth(text);
    const whole = domWidth(text);
    if (whole === whole) return whole;
    let total = 0;
    for (const ch of Array.from(String(text || ""))) {
      const w = domWidth(ch);
      if (w !== w) return heuristicMindmapWidth(text);
      total += w;
    }
    return total;
  };

  $: layout = layoutMindmap(root, { collapsed, measure: ready ? measure : undefined });

  const box = (): MindmapViewBox => ({
    viewW,
    viewH,
    contentW: layout.width,
    contentH: layout.height,
  });

  const apply = (next: MindmapViewport): void => {
    vp = boundedMindmapPan(next, box());
  };

  // 视野/内容尺寸变了（缩放、折叠、面板改宽）就把视口夹回可看范围
  $: reclamp(viewW, viewH, layout);
  function reclamp(w: number, h: number, l: { width: number; height: number }): void {
    if (!w || !h) return;
    const next = boundedMindmapPan(vp, { viewW: w, viewH: h, contentW: l.width, contentH: l.height });
    if (next.s !== vp.s || next.ox !== vp.ox || next.oy !== vp.oy) vp = next;
  }

  onMount(() => {
    ready = true;
    if (viewW && viewH) vp = resetMindmapViewport(box());
  });

  function onPointerDown(e: PointerEvent): void {
    if (locked || e.button !== 0) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, ox: vp.ox, oy: vp.oy, moved: false };
    host.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent): void {
    if (!drag || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    drag.moved = true;
    apply({ s: vp.s, ox: drag.ox + dx, oy: drag.oy + dy });
  }

  function endDrag(e: PointerEvent): void {
    if (!drag || drag.id !== e.pointerId) return;
    const moved = drag.moved;
    drag = null;
    if (moved) {
      // pointerup 之后浏览器还会补一个 click，别让它误触节点折叠
      swallowClick = true;
      setTimeout(() => (swallowClick = false), 0);
    }
  }

  function onWheel(e: WheelEvent): void {
    if (locked) return;
    const rect = host.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      apply(zoomMindmapAt(vp, mindmapWheelScale(vp.s, e.deltaY), e.clientX - rect.left, e.clientY - rect.top));
      return;
    }
    if (!wheelPan) return;
    e.preventDefault();
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewH : 1;
    const dx = -e.deltaX * k;
    const dy = -e.deltaY * k;
    apply(e.shiftKey ? { s: vp.s, ox: vp.ox - dy, oy: vp.oy - dx } : { s: vp.s, ox: vp.ox + dx, oy: vp.oy + dy });
  }

  /** 缩放锚点：滚轮跟着指针，按钮跟着视野中心 */
  function zoomTo(next: number): void {
    apply(zoomMindmapAt(vp, next, viewW / 2, viewH / 2));
  }

  function onSlider(e: Event): void {
    zoomTo(clampMindmapScale(Number((e.target as HTMLInputElement).value) / 100));
  }

  function nodeClick(node: MindmapLayoutNode): void {
    if (swallowClick || drag?.moved) return;
    if (node.hasChildren) onToggle?.(node.id);
    else if (node.ref) onOpenBlock?.(node.ref);
  }

  function nodeKey(e: KeyboardEvent, node: MindmapLayoutNode): void {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    nodeClick(node);
  }

  function nodeTitle(node: MindmapLayoutNode): string {
    const base = node.text || "";
    if (node.hasChildren) return `${base}\n${t("点击折叠或展开")}`;
    if (node.ref) return `${base}\n${t("点击打开引用的块")}`;
    return base;
  }

  function pickDepth(e: Event): void {
    const depth = Number((e.target as HTMLSelectElement).value) || 0;
    depthChoice = depth;
    onFoldDepth?.(depth);
  }

  $: zoomPct = Math.round(vp.s * 100);
  $: depthOptions = Math.max(2, Math.min(6, maxDepthOf(root)));
  function maxDepthOf(node: MindmapNode): number {
    if (!node) return 2;
    let best = 1;
    const walk = (n: MindmapNode, d: number) => {
      best = Math.max(best, d);
      for (const c of n.children) walk(c, d + 1);
    };
    walk(node, 1);
    return best;
  }
</script>

<div
  class="mmv"
  class:wide
  class:locked
  class:grabbing={!!drag && drag.moved}
  bind:this={host}
  bind:clientWidth={viewW}
  bind:clientHeight={viewH}
  on:pointerdown={onPointerDown}
  on:pointermove={onPointerMove}
  on:pointerup={endDrag}
  on:pointercancel={endDrag}
  on:wheel={onWheel}
  on:dblclick={() => !locked && apply(fitMindmapViewport(box()))}
  role="group"
  aria-label={t("思维导图画布")}
>
  <svg class="mm-svg" width="100%" height="100%" role="img" aria-label={t("思维导图")}>
    <g transform={`translate(${vp.ox},${vp.oy}) scale(${vp.s})`}>
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
          on:dblclick={() => node.ref && onOpenBlock?.(node.ref)}
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
    </g>
  </svg>
  <!-- 度量用的隐形文字：与 .mm-label 同字号同字族，量出来的就是画出来的 -->
  <svg class="mm-measure" aria-hidden="true" width="8" height="8">
    <text class="mm-measure-text" bind:this={measureEl}></text>
  </svg>
</div>

<div class="mm-bar" role="toolbar" aria-label={t("思维导图视图")}>
  <button class="mm-btn" on:click={() => apply(fitMindmapViewport(box()))}>{t("适应画布")}</button>
  <button class="mm-btn" on:click={() => apply(fitMindmapWidth(box()))}>{t("适应宽度")}</button>
  <span class="mm-sep"></span>
  <button class="mm-btn tight" title={t("缩小")} aria-label={t("缩小")} on:click={() => zoomTo(vp.s - 0.15)}>−</button>
  <input
    class="mm-slider"
    type="range"
    min={MINDMAP_MIN_SCALE * 100}
    max={MINDMAP_MAX_SCALE * 100}
    step={5}
    value={zoomPct}
    aria-label={t("缩放比例")}
    on:input={onSlider}
  />
  <button class="mm-btn tight" title={t("放大")} aria-label={t("放大")} on:click={() => zoomTo(vp.s + 0.15)}>＋</button>
  <span class="mm-pct">{zoomPct}%</span>
  <button class="mm-btn" title={t("恢复 1:1")} on:click={() => apply(resetMindmapViewport(box()))}>1:1</button>
  <span class="mm-sep"></span>
  <label class="mm-lab">
    {t("展开到")}
    <select class="mm-select" value={depthChoice} on:change={pickDepth}>
      <option value="0">{t("全部")}</option>
      {#each Array(depthOptions) as _, i (i)}
        <option value={i + 1}>{i + 1}</option>
      {/each}
    </select>
    {t("级")}
  </label>
  <button
    class="mm-btn"
    aria-pressed={wheelPan}
    title={t("开启后普通滚轮上下滚动即平移画布")}
    on:click={() => (wheelPan = !wheelPan)}>{t("滚轮平移")}</button>
  <button
    class="mm-btn"
    aria-pressed={locked}
    title={t("锁定后不响应拖拽与滚轮，便于选中文字")}
    on:click={() => (locked = !locked)}>{t("锁定视图")}</button>
  {#if !wide && onExpand}
    <span class="mm-sep"></span>
    <button class="mm-btn" title={t("在大窗里查看")} on:click={() => onExpand?.()}>⤢ {t("放大")}</button>
  {/if}
</div>

<style>
  .mmv {
    position: relative;
    overflow: hidden;
    height: clamp(200px, 38vh, 420px);
    background: var(--b3-theme-background, #fff);
    cursor: grab;
    /* 卡片里纵向留给对话滚动，横向拖动才是平移；放大弹层两向都归画布 */
    touch-action: pan-y;
  }
  .mmv.wide {
    /* 放大弹层里由父容器（flex column）决定高度，画布吃掉除工具条以外的空间 */
    flex: 1 1 auto;
    height: auto;
    min-height: 0;
    touch-action: none;
  }
  .mmv.locked {
    cursor: default;
  }
  .mmv.grabbing {
    cursor: grabbing;
  }
  .mm-svg {
    display: block;
  }
  .mm-measure {
    position: absolute;
    left: -9999px;
    top: 0;
    visibility: hidden;
  }
  .mm-measure-text {
    font-size: 12px;
    font-family: var(--b3-font-family, inherit);
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
  .mm-bar {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
    padding: 4px 6px;
    border-top: 1px dashed var(--b3-border-color, rgba(0, 0, 0, 0.1));
    font-size: 10.5px;
    color: var(--b3-theme-on-surface-light, #9aa0a6);
  }
  .mm-btn {
    flex: none;
    padding: 2px 6px;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.14));
    border-radius: 999px;
    background: transparent;
    color: var(--b3-theme-on-surface, #6b7280);
    font-size: 10.5px;
    line-height: 1.5;
    cursor: pointer;
  }
  .mm-btn.tight {
    min-width: 20px;
    padding: 2px 0;
    text-align: center;
  }
  .mm-btn:hover,
  .mm-btn[aria-pressed="true"] {
    border-color: var(--b3-theme-primary, #378add);
    color: var(--b3-theme-primary, #378add);
  }
  .mm-btn[aria-pressed="true"] {
    background: var(--b3-theme-primary-lightest, rgba(55, 138, 221, 0.1));
  }
  .mm-slider {
    flex: 1 1 60px;
    min-width: 48px;
    max-width: 110px;
    margin: 0 2px;
  }
  .mm-pct {
    flex: none;
    min-width: 34px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .mm-sep {
    flex: none;
    width: 1px;
    height: 12px;
    background: var(--b3-border-color, rgba(0, 0, 0, 0.12));
  }
  .mm-lab {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
  .mm-select {
    height: 20px;
    padding: 0 2px;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.14));
    border-radius: 4px;
    background: var(--b3-theme-background, #fff);
    color: var(--b3-theme-on-surface, #6b7280);
    font-size: 10.5px;
  }
</style>
