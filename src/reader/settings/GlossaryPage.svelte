<!--
  术语表（「双语翻译」设置 Tab 的二级页，2026-10-14 从独立双语弹窗迁入）
  ==================================================================
  GlossaryStore（translate/glossary.ts）此前从未被实例化 —— 术语「设了不生效」。
  现已接进 TranslateHost：译后按词条硬性替换 + 版本并入缓存 salt。
  本页只负责「编辑词条」，读写都经 host（TranslateHost）的
  glossaryTerms / glossaryReplaceAll，存储落在 reader-glossary.json。

  腾讯是机翻、不吃 prompt，所以术语表走「译后替换」这一条路。
  改术语 = glossaryReplaceAll 内部 version++ → salt 变 → 旧译文自动失效重译。
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "../../i18n/index.ts";
  import { getLogger } from "../../core/logger.ts";

  /** 翻译宿主（TranslateHost 实例，由 SettingsDialog 传入） */
  export let host: any = null;

  interface Term { src: string; dst: string; caseSensitive?: boolean; note?: string }
  let terms: Term[] = [];
  let tip = "";
  let loaded = false;

  function load() {
    try {
      terms = (host?.glossaryTerms?.() ?? []).map((x: Term) => ({ ...x }));
    } catch (e) {
      getLogger().warn("[RE 阅读器] 读术语表失败", { error: e });
      terms = [];
    }
    loaded = true;
  }
  onMount(load);

  function addRow() {
    terms = [...terms, { src: "", dst: "", caseSensitive: false }];
  }
  function delRow(i: number) {
    terms = terms.filter((_, idx) => idx !== i);
  }
  function clearAll() {
    terms = [];
  }

  async function save() {
    const clean = terms
      .filter((x) => x.src?.trim())
      .map((x) => ({
        src: x.src.trim(),
        dst: (x.dst ?? "").trim(),
        ...(x.caseSensitive ? { caseSensitive: true } : {}),
        ...(x.note?.trim() ? { note: x.note.trim() } : {}),
      }));
    try {
      host?.glossaryReplaceAll?.(clean);
      terms = clean.map((c) => ({ ...c }));
      tip = t("已保存 {n} 条术语；相关段落旧译文将失效、下次读到自动按新术语重译", { n: clean.length });
    } catch (e) {
      getLogger().warn("[RE 阅读器] 保存术语表失败", { error: e });
      tip = t("保存失败，请查看日志");
    }
  }
</script>

<div class="gl-page">
  <p class="gl-intro">
    {t("专有名词的硬性约束：译文里出现的「原文术语」会被替换成「指定译法」。改术语会让相关段落的旧译文失效并自动重译。")}
  </p>

  <div class="gl-toolbar">
    <button type="button" class="rwd-tr-btn" on:click={addRow}>{t("+ 添加术语")}</button>
    {#if terms.length > 0}
      <button type="button" class="rwd-tr-btn ghost" on:click={clearAll}>{t("清空")}</button>
    {/if}
    <span class="gl-count">{t("共 {n} 条", { n: terms.filter((x) => x.src?.trim()).length })}</span>
  </div>

  {#if !loaded}
    <div class="gl-empty">{t("载入中…")}</div>
  {:else if terms.length === 0}
    <div class="gl-empty">{t("暂无术语。点「+ 添加术语」新建一条。")}</div>
  {:else}
    <div class="gl-head">
      <span>{t("原文术语")}</span>
      <span>{t("指定译法")}</span>
      <span>{t("区分大小写")}</span>
      <span>{t("操作")}</span>
    </div>
    {#each terms as term, i (i)}
      <div class="gl-row">
        <input type="text" bind:value={term.src} placeholder={t("如 Transformer")} />
        <input type="text" bind:value={term.dst} placeholder={t("如 变换器（留空=保留原文）")} />
        <input type="checkbox" class="gl-case" bind:checked={term.caseSensitive} />
        <button type="button" class="rwd-tr-btn ghost" on:click={() => delRow(i)}>×</button>
      </div>
    {/each}
  {/if}

  <div class="gl-footer">
    <button type="button" class="rwd-tr-btn primary" on:click={save} disabled={!loaded}>{t("保存术语表")}</button>
    {#if tip}<span class="gl-tip">{tip}</span>{/if}
  </div>
</div>

<style>
  .gl-page { display: flex; flex-direction: column; gap: 12px; padding: 4px 2px; }
  .gl-intro { margin: 0; font-size: 12px; line-height: 1.6; color: var(--b3-theme-on-surface, #777); }
  .gl-toolbar { display: flex; align-items: center; gap: 8px; }
  .gl-count { margin-left: auto; font-size: 12px; color: var(--b3-theme-on-surface, #999); }
  .gl-empty { padding: 18px 0; text-align: center; font-size: 12px; color: var(--b3-theme-on-surface, #999); }
  .gl-head, .gl-row { display: grid; grid-template-columns: 1fr 1fr 56px 34px; gap: 8px; align-items: center; }
  .gl-head { font-size: 11px; color: var(--b3-theme-on-surface, #999); padding: 0 2px; }
  .gl-row { margin-bottom: 6px; }
  .gl-row input[type="text"] {
    width: 100%; box-sizing: border-box; padding: 6px 8px; font-size: 13px;
    border: 1px solid var(--b3-border-color, #ddd); border-radius: 6px;
    background: var(--b3-theme-background, #fff); color: var(--b3-theme-on-surface, #222);
  }
  .gl-case { justify-self: center; }
  .gl-footer { display: flex; align-items: center; gap: 10px; margin-top: 6px; }
  .gl-tip { font-size: 11px; color: var(--b3-theme-primary, #3b82f6); line-height: 1.5; }
</style>
