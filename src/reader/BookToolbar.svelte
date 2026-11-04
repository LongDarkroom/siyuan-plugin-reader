<!--
  图书界面专属工具栏（2026-09-02 从 ReaderView.svelte 拆出）

  只含「双语对照」按钮组——它依赖向正文 DOM 注入译文节点，只在 EPUB / TXT 这类
  可重排文本上成立，对 PDF 画布无效，因此不进 PDF 界面。

  props 刻意摊平成基础类型：bilingualProgress / bilingualTokenUsage 是 ReaderView 里
  的可变对象，直接整体传对象会带来 Svelte 更新时机问题（对象引用未变则不触发重渲染），
  摊平后每个字段都是独立 prop，父组件一改就同步。
-->
<script lang="ts">
  import { t } from "../i18n/index.ts";
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
</script>

<button
  class="reader-btn reader-bilingual-btn"
  class:reader-btn-active={bilingualOn}
  class:reader-btn-busy={bilingualActive}
  title={totalTokens != null
    ? `${t("双语对照 · AI Token")}: ${totalTokens}（${t("输入")} ${promptTokens} + ${t("输出")} ${completionTokens}）`
    : t("双语对照：在每段正文后注入译文（AI 翻译）")}
  on:click={onToggleBilingual}
>{t("双语")}{bilingualActive ? ` ${bilingualDone}/${bilingualTotal}` : ""}{totalTokens != null && !bilingualActive ? ` · ${totalTokens}T` : ""}</button>
