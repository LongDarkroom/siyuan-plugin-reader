<!--
  图书界面专属工具栏（2026-09-02 从 ReaderView.svelte 拆出）

  只含「双语对照」按钮组——它依赖向正文 DOM 注入译文节点，只在 EPUB / TXT 这类
  可重排文本上成立，对 PDF 画布无效，因此不进 PDF 界面。

  props 刻意摊平成基础类型：bilingualProgress / bilingualTokenUsage 是 ReaderView 里
  的可变对象，直接整体传对象会带来 Svelte 更新时机问题（对象引用未变则不触发重渲染），
  摊平后每个字段都是独立 prop，父组件一改就同步。

  2026-11-14 P1-2：拆成「主键 + ▾」双段 —— 主键保持一键开关的高频路径，
  ▾ 里放低频的整本预翻译 / 翻译设置。菜单自管点击外部与 Esc（父组件的
  closeAllPopovers 不认识它，不能依赖那条链路）。
-->
<script lang="ts">
  import { onDestroy } from "svelte";
  import { t } from "../i18n/index.ts";
  import { ICONS } from "./icons.ts";
  export let bilingualOn = false;
  /** 预翻译进行中 */
  export let bilingualActive = false;
  export let bilingualDone = 0;
  export let bilingualTotal = 0;
  /** AI token 用量；为空表示本次尚未产生消耗 */
  export let promptTokens: number | null = null;
  export let completionTokens: number | null = null;
  export let totalTokens: number | null = null;
  export let onToggleBilingual: () => void = () => {};
  export let onPretranslate: () => void = () => {};
  export let onOpenSettings: () => void = () => {};

  let wrapEl: HTMLDivElement;
  let menuOpen = false;

  function toggleMenu(): void {
    menuOpen = !menuOpen;
  }

  function closeMenu(): void {
    menuOpen = false;
  }

  function pick(fn: () => void): void {
    menuOpen = false;
    fn();
  }

  /** 点击外部收起。只挂 window 一层，菜单关闭时立刻 return，零额外开销。 */
  function onDocPointerDown(e: PointerEvent): void {
    if (!menuOpen) return;
    const target = e.target as Node | null;
    if (target && wrapEl?.contains(target)) return;
    menuOpen = false;
  }

  /** Esc 收起菜单。捕获阶段截断，避免同时触发阅读器「收两栏」的全局 Esc。 */
  function onDocKeyDown(e: KeyboardEvent): void {
    if (!menuOpen || e.key !== "Escape") return;
    e.stopPropagation();
    menuOpen = false;
  }

  window.addEventListener("pointerdown", onDocPointerDown, true);
  window.addEventListener("keydown", onDocKeyDown, true);
  onDestroy(() => {
    window.removeEventListener("pointerdown", onDocPointerDown, true);
    window.removeEventListener("keydown", onDocKeyDown, true);
  });
</script>

<div class="rb-wrap" bind:this={wrapEl}>
  <button
    class="reader-btn reader-bilingual-btn reader-chrome-text"
    class:reader-btn-active={bilingualOn}
    class:reader-btn-busy={bilingualActive}
    title={totalTokens != null
      ? `${t("双语对照 · AI Token")}: ${totalTokens}（${t("输入")} ${promptTokens} + ${t("输出")} ${completionTokens}）`
      : t("双语对照：在每段正文后注入译文（AI 翻译）")}
    on:click={() => {
      menuOpen = false;
      onToggleBilingual();
    }}
  ><svg class="reader-ic" viewBox="0 0 24 24" aria-hidden="true">{@html ICONS.translate}</svg><span class="rb-label">{t("双语")}{bilingualActive ? ` ${bilingualDone}/${bilingualTotal}` : ""}{totalTokens != null && !bilingualActive ? ` · ${totalTokens}T` : ""}</span></button>
  <button
    class="reader-btn rb-caret"
    class:rb-caret-open={menuOpen}
    aria-haspopup="menu"
    aria-expanded={menuOpen}
    title={t("更多双语操作")}
    on:click={toggleMenu}
  ><svg class="reader-ic" viewBox="0 0 24 24" aria-hidden="true">{@html ICONS.chevronDown}</svg></button>

  {#if menuOpen}
    <div class="rb-menu" role="menu" aria-label={t("双语")}>
      <button class="rb-item" role="menuitem" on:click={() => pick(onPretranslate)}>
        <svg class="rb-item-ic" viewBox="0 0 24 24" aria-hidden="true">{@html ICONS.sparkles}</svg>
        <span class="rb-item-body">
          <span class="rb-item-label">{t("整本预翻译…")}</span>
          <span class="rb-item-hint">{t("后台译完，边读边命中")}</span>
        </span>
      </button>
      <button class="rb-item" role="menuitem" on:click={() => pick(onToggleBilingual)}>
        <svg class="rb-item-ic" viewBox="0 0 24 24" aria-hidden="true">{@html ICONS.translate}</svg>
        <span class="rb-item-body">
          <span class="rb-item-label">{bilingualOn ? t("关闭双语对照") : t("开启双语对照")}</span>
          <span class="rb-item-hint">{t("在每段原文下注入译文")}</span>
        </span>
        {#if bilingualOn}
          <svg class="rb-item-check" viewBox="0 0 24 24" aria-hidden="true">{@html ICONS.check}</svg>
        {/if}
      </button>
      <div class="rb-sep" aria-hidden="true"></div>
      <button class="rb-item" role="menuitem" on:click={() => pick(onOpenSettings)}>
        <svg class="rb-item-ic" viewBox="0 0 24 24" aria-hidden="true">{@html ICONS.settings}</svg>
        <span class="rb-item-body">
          <span class="rb-item-label">{t("双语翻译设置")}</span>
          <span class="rb-item-hint">{t("引擎、密钥与术语表")}</span>
        </span>
      </button>
    </div>
  {/if}
</div>

<style>
  .rb-wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
    flex: none;
  }

  /* 主键与 ▾ 共用一颗胶囊的观感：▾ 用负外边距贴住主键右侧，
     悬停时只亮 ▾ 自己的区域，避免整颗胶囊看起来有两个热区。 */
  .rb-caret {
    width: 18px;
    height: 34px;
    padding: 0;
    margin-left: -6px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 9px;
    color: inherit;
    opacity: 0.72;
  }
  .rb-caret .reader-ic {
    width: 14px;
    height: 14px;
  }
  .rb-caret:hover,
  .rb-caret-open {
    opacity: 1;
    background: var(--b3-list-hover, rgba(0, 0, 0, 0.06));
  }
  .reader-bilingual-btn.reader-btn-active + .rb-caret {
    color: #2f9e44;
    opacity: 0.9;
  }

  .rb-menu {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 10;
    width: 236px;
    padding: 5px;
    display: flex;
    flex-direction: column;
    gap: 1px;
    border-radius: 12px;
    background: var(--b3-menu-background, var(--b3-theme-surface, #fff));
    border: 0.5px solid var(--b3-border-color, rgba(0, 0, 0, 0.1));
    box-shadow:
      0 12px 32px rgba(0, 0, 0, 0.14),
      0 2px 6px rgba(0, 0, 0, 0.06);
    transform-origin: top right;
    animation: rb-menu-in 140ms ease-out;
  }
  @keyframes rb-menu-in {
    from { opacity: 0; transform: translateY(-4px) scale(0.98); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  .rb-item {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    width: 100%;
    min-height: 0;
    padding: 7px 9px;
    border: none;
    border-radius: 8px;
    background: none;
    cursor: pointer;
    text-align: left;
    font-family: inherit;
    color: var(--b3-theme-on-background, #333);
  }
  .rb-item:hover {
    background: var(--b3-list-hover, rgba(0, 0, 0, 0.06));
  }
  .rb-item-ic {
    flex: none;
    width: 16px;
    height: 16px;
    margin-top: 1px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.75;
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0.68;
  }
  .rb-item-check {
    flex: none;
    width: 15px;
    height: 15px;
    margin: 2px 0 0 auto;
    fill: none;
    stroke: #2f9e44;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .rb-item-body {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .rb-item-label {
    font-size: 13px;
    line-height: 1.35;
    white-space: nowrap;
  }
  .rb-item-hint {
    font-size: 11px;
    line-height: 1.4;
    opacity: 0.55;
    white-space: normal;
  }
  .rb-sep {
    height: 1px;
    margin: 4px 6px;
    background: var(--b3-border-color, rgba(128, 128, 128, 0.2));
  }

  /* 触屏：点按目标放大，▾ 不能再是 18px 的细条 */
  @media (pointer: coarse) {
    .rb-caret {
      width: 30px;
      height: 40px;
      margin-left: 0;
    }
    .rb-caret .reader-ic {
      width: 16px;
      height: 16px;
    }
    .rb-item {
      min-height: 40px;
      padding: 8px 9px;
    }
  }

  /* 宽屏：与 reader-controls.less 的 24px 单胶囊同档 */
  @media (min-width: 900px) and (pointer: fine) {
    .rb-caret {
      width: 16px;
      height: 24px;
      margin-left: -5px;
      border-radius: 7px;
    }
    .rb-caret .reader-ic {
      width: 12px;
      height: 12px;
    }
    .rb-item-label {
      font-size: 12.5px;
    }
  }
</style>
