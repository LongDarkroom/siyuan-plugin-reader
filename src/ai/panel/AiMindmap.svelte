<script lang="ts">
  /**
   * 思维导图卡片（P3-B）
   * ------------------------------------------------------------------
   * 只做「卡片外壳 + 状态」：折叠集合、节点计数、复制成思源导图块、放大弹层。
   * 画布与视口手感在 MindmapCanvas.svelte，解析与坐标在 ai-mindmap.ts。
   * 放大用思源 Dialog（大窗里看整图比在窄栏里拖来拖去舒服），
   * 弹层里挂的是同一个画布组件、共用同一份折叠状态。
   */
  import { onDestroy } from "svelte";
  import { Dialog } from "siyuan";
  import { t } from "../../i18n/index.ts";
  import {
    countVisibleMindmapNodes,
    foldMindmapByDepth,
    mindmapToKramdown,
    type MindmapNode,
  } from "./ai-mindmap.ts";
  import MindmapCanvas from "./MindmapCanvas.svelte";

  export let root: MindmapNode;
  export let onOpenBlock: ((id: string) => void) | undefined = undefined;

  let collapsed = new Set<string>();
  let lastRoot: MindmapNode | null = null;
  let copyState: "" | "ok" | "fail" = "";
  let copyTimer: any = null;
  let zoom: { dlg: Dialog; canvas: any } | null = null;

  $: if (root !== lastRoot) {
    lastRoot = root;
    collapsed = new Set();
  }
  $: collapsedIds = Array.from(collapsed);
  $: visibleCount = countVisibleMindmapNodes(root, collapsedIds);
  $: hasCollapsed = collapsedIds.length > 0;
  // 折叠状态改了要同步进放大弹层（那边是同一个组件的第二个实例）
  $: if (zoom) zoom.canvas.$set({ root, collapsed: collapsedIds });

  function toggle(id: string): void {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    collapsed = next;
  }

  function foldDepth(depth: number): void {
    collapsed = new Set(depth > 0 ? foldMindmapByDepth(root, depth) : []);
  }

  function expandAll(): void {
    collapsed = new Set();
  }

  /** 旧浏览器 / 非安全上下文（局域网 http 访问思源）没有 clipboard API，退回 execCommand */
  function legacyCopy(text: string): boolean {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  async function copyMap(): Promise<void> {
    const text = mindmapToKramdown(root);
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      } else {
        ok = legacyCopy(text);
      }
    } catch {
      ok = legacyCopy(text);
    }
    copyState = ok ? "ok" : "fail";
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => (copyState = ""), ok ? 1600 : 3000);
  }

  function closeZoom(): void {
    if (!zoom) return;
    const canvas = zoom.canvas;
    zoom = null;
    try {
      canvas?.$destroy();
    } catch {
      /* 组件已随弹层一起销毁 */
    }
  }

  function openZoom(): void {
    if (zoom) return;
    const dlg = new Dialog({
      title: `${t("思维导图")} · ${t("放大查看")}`,
      width: "min(1160px, calc(100vw - 48px))",
      height: "min(76vh, 760px)",
      content: `<div class="rw-mm-zoom"></div>`,
      destroyCallback: () => closeZoom(),
    });
    dlg.element.classList.add("re-mm-dialog");
    const target = dlg.element.querySelector(".rw-mm-zoom") as HTMLElement | null;
    if (!target) {
      dlg.destroy();
      return;
    }
    const canvas = new MindmapCanvas({
      target,
      props: {
        root,
        collapsed: collapsedIds,
        wide: true,
        onOpenBlock,
        onToggle: toggle,
        onFoldDepth: foldDepth,
      },
    });
    zoom = { dlg, canvas };
  }

  onDestroy(() => {
    if (copyTimer) clearTimeout(copyTimer);
    const dlg = zoom ? zoom.dlg : null;
    closeZoom();
    if (dlg) {
      try {
        dlg.destroy();
      } catch {
        /* 已经关了 */
      }
    }
  });
</script>

<div class="mm-card">
  <div class="mm-hd">
    <span class="mm-title">{t("思维导图")}</span>
    <span class="mm-count">{t("{n} 个节点", { n: visibleCount })}</span>
    <span class="mm-spacer"></span>
    {#if hasCollapsed}
      <button class="mm-mini" on:click={expandAll}>{t("展开全部")}</button>
    {/if}
    <button
      class="mm-mini copy"
      class:ok={copyState === "ok"}
      class:fail={copyState === "fail"}
      title={t("复制为 Markdown 列表；粘贴进思源文档即成思维导图块")}
      on:click={copyMap}
    >{copyState === "ok" ? t("已复制") : copyState === "fail" ? t("复制失败") : t("复制导图")}</button>
  </div>
  <MindmapCanvas
    {root}
    collapsed={collapsedIds}
    {onOpenBlock}
    onToggle={toggle}
    onFoldDepth={foldDepth}
    onExpand={openZoom}
  />
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
  /* 复制按钮三个状态字数不同（复制导图 / 已复制 / 复制失败），按最长的预留才不会跳 */
  .mm-mini.copy {
    min-width: 62px;
    text-align: center;
  }
  .mm-mini.copy.ok {
    border-color: var(--b3-theme-success, #67c23a);
    color: var(--b3-theme-success, #67c23a);
  }
  .mm-mini.copy.fail {
    border-color: var(--b3-theme-error, #e03131);
    color: var(--b3-theme-error, #e03131);
  }
</style>
