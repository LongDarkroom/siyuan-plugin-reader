<!--
  翻译缓存管理（「双语翻译」设置 Tab 的二级页，2026-10-14 从独立双语弹窗迁入）
  ==================================================================
  列出所有已缓存译文的书，显示段数与最后更新时间，可按书清空。
  缓存本身（TranslationCache）一直在正常工作 —— 本页只是把「看 / 清」的入口
  放回设置里（此前那个入口在已下线的独立双语弹窗内，且该弹窗从未被接活）。

  读写经 host（TranslateHost）：listCachedBooks / cacheSize / clearCacheBook。
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "../../i18n/index.ts";
  import { getLogger } from "../../core/logger.ts";

  export let host: any = null;

  interface Row { bookId: string; title: string; updated?: number; size: number }
  let rows: Row[] = [];
  let loading = false;
  let tip = "";

  function fmtDate(sec?: number): string {
    if (!sec) return "—";
    try {
      return new Date(sec * 1000).toLocaleDateString();
    } catch {
      return "—";
    }
  }

  async function refresh() {
    loading = true;
    try {
      const books = await (host?.listCachedBooks?.() ?? Promise.resolve([]));
      const withSize = await Promise.all(
        (books as Array<{ bookId: string; title: string; updated?: number }>).map(async (b) => ({
          bookId: b.bookId,
          title: b.title || b.bookId,
          updated: b.updated,
          size: await (host?.cacheSize?.(b.bookId) ?? Promise.resolve(0)),
        })),
      );
      rows = withSize.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
    } catch (e) {
      getLogger().warn("[RE 阅读器] 读翻译缓存列表失败", { error: e });
      rows = [];
    }
    loading = false;
  }
  onMount(refresh);

  async function clearBook(r: Row) {
    try {
      await host?.clearCacheBook?.(r.bookId);
      tip = t("已清空《{a}》的译文缓存", { a: r.title });
      await refresh();
    } catch (e) {
      getLogger().warn("[RE 阅读器] 清空缓存失败", { error: e });
      tip = t("清空失败，请查看日志");
    }
  }
</script>

<div class="cc-page">
  <p class="cc-intro">
    {t("已缓存的译文按书存放，重复读到同一段不再消耗额度。清空某书后，其译文会在下次阅读时重新翻译。")}
  </p>

  <div class="cc-toolbar">
    <button type="button" class="rwd-tr-btn" on:click={refresh} disabled={loading}>
      {loading ? t("刷新中…") : t("刷新列表")}
    </button>
    <span class="cc-count">{t("共 {n} 本", { n: rows.length })}</span>
  </div>

  {#if loading && rows.length === 0}
    <div class="cc-empty">{t("载入中…")}</div>
  {:else if rows.length === 0}
    <div class="cc-empty">{t("暂无翻译缓存。开启双语并阅读后会自动生成。")}</div>
  {:else}
    <div class="cc-head">
      <span>{t("书名")}</span>
      <span>{t("已缓存")}</span>
      <span>{t("更新于")}</span>
      <span>{t("操作")}</span>
    </div>
    {#each rows as r (r.bookId)}
      <div class="cc-row">
        <span class="cc-title" title={r.title}>{r.title}</span>
        <span class="cc-size">{t("{n} 段", { n: r.size })}</span>
        <span class="cc-date">{fmtDate(r.updated)}</span>
        <button type="button" class="rwd-tr-btn ghost" on:click={() => clearBook(r)}>{t("清空")}</button>
      </div>
    {/each}
  {/if}

  {#if tip}<div class="cc-tip">{tip}</div>{/if}
</div>

<style>
  .cc-page { display: flex; flex-direction: column; gap: 12px; padding: 4px 2px; }
  .cc-intro { margin: 0; font-size: 12px; line-height: 1.6; color: var(--b3-theme-on-surface, #777); }
  .cc-toolbar { display: flex; align-items: center; gap: 8px; }
  .cc-count { margin-left: auto; font-size: 12px; color: var(--b3-theme-on-surface, #999); }
  .cc-empty { padding: 18px 0; text-align: center; font-size: 12px; color: var(--b3-theme-on-surface, #999); }
  .cc-head, .cc-row { display: grid; grid-template-columns: 1fr 72px 96px 64px; gap: 8px; align-items: center; }
  .cc-head { font-size: 11px; color: var(--b3-theme-on-surface, #999); padding: 0 2px; }
  .cc-row { padding: 6px 0; border-top: 1px solid var(--b3-border-color, #eee); }
  .cc-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; color: var(--b3-theme-on-surface, #222); }
  .cc-size, .cc-date { font-size: 12px; color: var(--b3-theme-on-surface, #777); }
  .cc-tip { font-size: 11px; color: var(--b3-theme-primary, #3b82f6); }
</style>
