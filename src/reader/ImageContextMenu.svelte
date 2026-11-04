<!--
  图片右键菜单（2026-11-04，对标 Readest 的 ImageContextMenu）

  Readest 的形态：右键正文图片 → 圆角卡片，两个纯文字项「复制图片 / 保存图片」。
  不复用书架菜单的原因：
   · 书架菜单按 4px 行高 + 分隔线设计，这套是「两行大按钮、无图标、无分隔线」；
   · 书架菜单依赖 window mousedown 关闭，而正文在 iframe 里，点击正文不会
     派发到宿主 window —— 这里必须用全屏透明背板来接管「点空白关闭」。

  坐标是宿主窗口的 client 坐标（调用方已把 iframe 局部坐标换算好）。
-->
<script lang="ts">
  import { tick, createEventDispatcher } from "svelte";
  import { t } from "../i18n/index.ts";

  export let x = 0;
  export let y = 0;
  export let onCopy: () => void = () => {};
  export let onSave: () => void = () => {};

  const dispatch = createEventDispatcher<{ close: void }>();

  let menuEl: HTMLDivElement | null = null;
  let left = x;
  let top = y;

  /** 贴边翻转：右侧/下方放不下就翻到指针另一侧（同原生菜单）。 */
  async function place(): Promise<void> {
    await tick();
    if (!menuEl) return;
    const r = menuEl.getBoundingClientRect();
    const pad = 8;
    left = x + r.width > window.innerWidth - pad ? Math.max(pad, x - r.width) : x;
    top = y + r.height > window.innerHeight - pad ? Math.max(pad, y - r.height) : y;
  }

  // x/y 变化（已在打开状态下再次右键）也要重新落位；menuEl 绑定后跑第一次。
  $: if (menuEl) {
    left = x;
    top = y;
    void place();
  }

  function close(): void {
    dispatch("close");
  }

  /** 先跑动作再关闭：父组件在 close 里同步清空 imgCtx.src，
   *  反序会让复制/保存读到空 src 而静默失败。 */
  function run(action: () => void): void {
    action();
    close();
  }
</script>

<!-- 背板必须盖住正文 iframe：否则点正文那一下既关不掉菜单，还会误触翻页/划词。 -->
<div
  class="img-ctx-backdrop"
  role="presentation"
  on:mousedown|preventDefault={close}
  on:contextmenu|preventDefault={close}
  on:wheel|preventDefault={close}
></div>

<div
  class="img-ctx-menu"
  bind:this={menuEl}
  style="left:{left}px; top:{top}px"
  role="menu"
  aria-label={t("图片操作")}
  data-dismiss-ignore
>
  <button type="button" class="img-ctx-item" role="menuitem" on:click={() => run(onCopy)}>
    {t("复制图片")}
  </button>
  <button type="button" class="img-ctx-item" role="menuitem" on:click={() => run(onSave)}>
    {t("保存图片")}
  </button>
</div>

<style>
  .img-ctx-backdrop {
    position: fixed;
    inset: 0;
    z-index: 10000;
    background: transparent;
  }
  .img-ctx-menu {
    position: fixed;
    z-index: 10001;
    min-width: 156px;
    padding: 6px;
    border-radius: 14px;
    background: var(--b3-theme-background, #fff);
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.1));
    box-shadow:
      0 10px 30px rgba(0, 0, 0, 0.18),
      0 1px 3px rgba(0, 0, 0, 0.12);
    color: var(--b3-theme-on-background, #333);
    user-select: none;
    animation: img-ctx-in 120ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .img-ctx-item {
    display: block;
    width: 100%;
    padding: 9px 14px;
    border: 0;
    border-radius: 9px;
    background: none;
    color: inherit;
    font: inherit;
    font-size: 14px;
    line-height: 1.35;
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
  }
  .img-ctx-item:hover,
  .img-ctx-item:focus-visible {
    background: var(--b3-list-hover, rgba(55, 138, 221, 0.14));
    outline: none;
  }
  @keyframes img-ctx-in {
    from { opacity: 0; transform: scale(0.98); }
    to { opacity: 1; transform: none; }
  }
</style>
