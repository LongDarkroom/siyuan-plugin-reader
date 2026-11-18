<!--
  PDF 界面专属工具栏（2026-09-02 从 ReaderView.svelte 拆出）

  只负责「缩放档位 + 页码跳转」两组控件，不含图书模式的双语按钮。
  所有交互通过回调 prop 交给 ReaderView 处理，组件自身不持有 foliate 视图状态，
  便于 ReaderView 按 readerMode 在两套界面之间自由切换。

  注意：本组件在 iPhone 模式下也会渲染（缩放/翻页是 PDF 的刚需），
  而图书工具栏 BookToolbar 则受 isIphoneMode 门控。
-->
<script lang="ts">
  import { t } from "../i18n/index.ts";
  import { ICONS } from "./icons.ts";
  export let zoomLabel = "";
  export let pdfCurrentPage = 0;
  export let pdfTotalPages = 0;
  export let onZoomIn: () => void = () => {};
  export let onZoomOut: () => void = () => {};
  export let onFitWidth: () => void = () => {};
  export let onFitPage: () => void = () => {};
  export let onGoPage: (page: number) => void = () => {};
  export let onPageInputKeydown: (e: KeyboardEvent) => void = () => {};
  export let onPageInputChange: (e: Event) => void = () => {};
  /** 2026-11-17：翻译整本 PDF 并导出双语对照 PDF */
  export let onTranslateBilingual: () => void = () => {};
  /** 2026-11-17：翻译进行中（按钮禁用 + 文案变化） */
  export let translating = false;
</script>

<!-- PDF 缩放工具栏 -->
<span class="reader-zoom-group" title={t("PDF 缩放：⌘/Ctrl + 滚轮（或触控板捏合）连续缩放；⌘/Ctrl + 1 / 2 / = / - 快捷档位；页面内双击切换适应宽度")}>
  <button
    class="reader-btn reader-zoom-btn"
    title={t("缩小（⌘/Ctrl + -）")}
    on:click={onZoomOut}
  ><svg class="reader-ic" viewBox="0 0 24 24" aria-hidden="true">{@html ICONS.zoomOut}</svg></button>
  <span class="reader-zoom-label">{zoomLabel}</span>
  <button
    class="reader-btn reader-zoom-btn"
    title={t("放大（⌘/Ctrl + =）")}
    on:click={onZoomIn}
  ><svg class="reader-ic" viewBox="0 0 24 24" aria-hidden="true">{@html ICONS.zoomIn}</svg></button>
  <button
    class="reader-btn reader-zoom-btn"
    title={t("适应宽度（⌘/Ctrl + 1）")}
    on:click={onFitWidth}
  ><svg class="reader-ic" viewBox="0 0 24 24" aria-hidden="true">{@html ICONS.fitWidth}</svg></button>
  <button
    class="reader-btn reader-zoom-btn"
    title={t("适应整页（⌘/Ctrl + 2）")}
    on:click={onFitPage}
  ><svg class="reader-ic" viewBox="0 0 24 24" aria-hidden="true">{@html ICONS.fitPage}</svg></button>
</span>

<!-- PDF「第 N/T 页」+ 跳转输入框（对齐 Obsidian PDF++ Go to page） -->
<span class="reader-page-group" title={t("PDF 页码跳转：←/→ 翻页，数字框内回车跳转")}>
  <button
    class="reader-btn reader-page-btn"
    title={t("上一页（←）")}
    disabled={!pdfTotalPages}
    on:click={() => onGoPage(Math.max(1, pdfCurrentPage - 1))}
  ><svg class="reader-ic" viewBox="0 0 24 24" aria-hidden="true">{@html ICONS.chevronLeft}</svg></button>
  <span class="reader-page-label">
    <input
      class="reader-page-input"
      type="number"
      min="1"
      max={pdfTotalPages || undefined}
      placeholder="?"
      value={pdfCurrentPage || ""}
      disabled={!pdfTotalPages}
      on:keydown={onPageInputKeydown}
      on:change={onPageInputChange}
    />
    <span class="reader-page-sep">/</span>
    <span class="reader-page-total">{pdfTotalPages || "?"}</span>
  </span>
  <button
    class="reader-btn reader-page-btn"
    title={t("下一页（→）")}
    disabled={!pdfTotalPages}
    on:click={() => onGoPage(Math.min(pdfTotalPages, pdfCurrentPage + 1))}
  ><svg class="reader-ic" viewBox="0 0 24 24" aria-hidden="true">{@html ICONS.chevronRight}</svg></button>
</span>

<!--
  2026-11-17：翻译整本 PDF → 双语对照 PDF。
  放在页码组之后：它是「整本级」动作（要跑几分钟、几分钱），不该挤在缩放组里。
  文案随状态变（进行中显示进度），按钮在此期间禁用，避免重复触发。
-->
<span class="reader-page-group">
  <button
    class="reader-btn reader-zoom-btn"
    title={t("翻译整本 PDF 并导出「原文 + 中文」对照 PDF")}
    disabled={translating}
    on:click={onTranslateBilingual}
  ><svg class="reader-ic" viewBox="0 0 24 24" aria-hidden="true">{@html ICONS.translate}</svg></button>
  <span class="reader-page-label">{translating ? t("翻译中…") : t("双语 PDF")}</span>
</span>
