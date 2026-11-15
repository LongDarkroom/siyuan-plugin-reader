<!--
  翻译缓存管理（「双语翻译」设置 Tab 的二级页，2026-10-14 从独立双语弹窗迁入）
  ==================================================================
  列出所有已缓存译文的书，展示条目数 / 体积 / 按引擎分布，可单本清空；
  顶部汇总 + 批量清理（孤儿 / 90 天未更新 / 全部）。
  缓存本身（TranslationCache）一直在正常工作 —— 本页只是把「看 / 清」的入口
  放回设置里（此前那个入口在已下线的独立双语弹窗内，且该弹窗从未被接活）。

  读写经 host（TranslateHost）：
    listCachedBooks / cacheStats / clearCacheBook / cleanOrphanCaches
    cleanOldCaches / clearAllCaches
  数据形状见 cache.ts 的 CacheStats（_ns 索引按引擎归类，旧数据算腾讯）。
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "../../i18n/index.ts";
  import { getLogger } from "../../core/logger.ts";

  export let host: any = null;

  interface EngineStat { engine: string; count: number; chars: number }
  interface Row {
    bookId: string;
    title: string;
    updated?: number;
    size: number;
    chars: number;
    engines: EngineStat[];
  }

  let rows: Row[] = [];
  let loading = false;
  /** 批量清理进行中（禁用所有按钮，避免并发清空同一本书） */
  let busy = false;
  let tip = "";

  const ENGINE_LABELS: Record<string, string> = {
    "qwen-mt": t("千问"),
    "openai-compat": t("大模型"),
    tencent: t("腾讯"),
    ai: "AI",
  };

  function fmtDate(sec?: number): string {
    if (!sec) return "—";
    try {
      return new Date(sec * 1000).toLocaleDateString();
    } catch {
      return "—";
    }
  }

  /** 体积显示：过万按 k 字，避免长串数字撑破列宽 */
  function fmtChars(n: number): string {
    if (!n) return "0 字";
    if (n >= 10000) return `${(n / 1000).toFixed(1)}k 字`;
    return `${n} 字`;
  }

  function engineLabel(id: string): string {
    return ENGINE_LABELS[id] || id;
  }

  /** 汇总（顶部）：条目 / 体积 / 引擎种类 */
  $: totalCount = rows.reduce((s, r) => s + r.size, 0);
  $: totalChars = rows.reduce((s, r) => s + r.chars, 0);
  $: engineCount = (() => {
    const set = new Set<string>();
    for (const r of rows) for (const e of r.engines) if (e.count) set.add(e.engine);
    return set.size;
  })();

  async function refresh() {
    loading = true;
    try {
      const books = await (host?.listCachedBooks?.() ?? Promise.resolve([]));
      const withStats = await Promise.all(
        (books as Array<{ bookId: string; title: string; updated?: number }>).map(async (b) => {
          const st = await (host?.cacheStats?.(b.bookId) ?? Promise.resolve(null));
          return {
            bookId: b.bookId,
            title: b.title || b.bookId,
            updated: b.updated,
            size: Number(st?.total) || 0,
            chars: Number(st?.chars) || 0,
            engines: Array.isArray(st?.engines) ? st.engines : [],
          } as Row;
        }),
      );
      rows = withStats.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
    } catch (e) {
      getLogger().warn("[RE 阅读器] 读翻译缓存列表失败", { error: e });
      rows = [];
    }
    loading = false;
  }
  onMount(refresh);

  /** 危险操作确认：没有 confirm 的环境一律当作「不确认」，绝不静默批量删除 */
  function ask(msg: string): boolean {
    try {
      return typeof window !== "undefined" && typeof window.confirm === "function"
        ? window.confirm(msg)
        : false;
    } catch {
      return false;
    }
  }

  async function clearBook(r: Row) {
    if (busy) return;
    try {
      await host?.clearCacheBook?.(r.bookId);
      tip = t("已清空《{a}》的译文缓存", { a: r.title });
      await refresh();
    } catch (e) {
      getLogger().warn("[RE 阅读器] 清空缓存失败", { error: e });
      tip = t("清空失败，请查看日志");
    }
  }

  /** 批量清理统一壳：确认 → 执行 → 回读列表 → 提示条数 */
  async function batch(op: "orphan" | "old" | "all") {
    if (busy) return;
    const msg =
      op === "orphan"
        ? t("将清理书架中已不存在的书籍的译文缓存，继续？")
        : op === "old"
          ? t("将清理 90 天未更新的译文缓存，继续？")
          : t("将清空全部翻译缓存（所有书），继续？");
    if (!ask(msg)) return;
    busy = true;
    tip = t("正在清理…");
    try {
      const n =
        op === "orphan"
          ? Number(await host?.cleanOrphanCaches?.()) || 0
          : op === "old"
            ? Number(await host?.cleanOldCaches?.(90)) || 0
            : Number(await host?.clearAllCaches?.()) || 0;
      tip =
        op === "orphan"
          ? t("已清理 {n} 本孤儿缓存", { n })
          : op === "old"
            ? t("已清理 {n} 本 90 天未更新的缓存", { n })
            : t("已清空全部缓存（{n} 本）", { n });
      await refresh();
    } catch (e) {
      getLogger().warn("[RE 阅读器] 批量清理缓存失败", { error: e });
      tip = t("清理失败，请查看日志");
    } finally {
      busy = false;
    }
  }
</script>

<div class="cc-page">
  <p class="cc-intro">
    {t("已缓存的译文按书存放，重复读到同一段不再消耗额度。清空某书后，其译文会在下次阅读时重新翻译。")}
  </p>

  <!-- 汇总条：固定行高，refresh 前后不位移 -->
  <div class="cc-sum">
    <span>{t("共 {n} 本", { n: rows.length })}</span>
    <span class="cc-sum-dot">·</span>
    <span>{t("{n} 条译文", { n: totalCount })}</span>
    <span class="cc-sum-dot">·</span>
    <span>{fmtChars(totalChars)}</span>
    {#if engineCount}
      <span class="cc-sum-dot">·</span>
      <span>{t("{n} 个引擎", { n: engineCount })}</span>
    {/if}
  </div>

  <div class="cc-toolbar">
    <button type="button" class="rwd-tr-btn" on:click={refresh} disabled={loading || busy}>
      {loading ? t("刷新中…") : t("刷新列表")}
    </button>
    <span class="cc-spacer" />
    <button type="button" class="rwd-tr-btn ghost" on:click={() => batch("orphan")} disabled={busy || !rows.length}>
      {t("清理孤儿")}
    </button>
    <button type="button" class="rwd-tr-btn ghost" on:click={() => batch("old")} disabled={busy || !rows.length}>
      {t("清理 90 天前")}
    </button>
    <button type="button" class="rwd-tr-btn danger" on:click={() => batch("all")} disabled={busy || !rows.length}>
      {t("清空全部")}
    </button>
  </div>

  {#if loading && rows.length === 0}
    <div class="cc-empty">{t("载入中…")}</div>
  {:else if rows.length === 0}
    <div class="cc-empty">{t("暂无翻译缓存。开启双语并阅读后会自动生成。")}</div>
  {:else}
    <div class="cc-head">
      <span>{t("书名 / 引擎")}</span>
      <span>{t("已缓存")}</span>
      <span>{t("更新于")}</span>
      <span>{t("操作")}</span>
    </div>
    {#each rows as r (r.bookId)}
      <div class="cc-row">
        <span class="cc-title">
          <span class="cc-title-name" title={r.title}>{r.title}</span>
          <span class="cc-title-meta">
            {#if r.engines.length}
              {#each r.engines as e (e.engine)}
                <span class="cc-chip" class:legacy={!ENGINE_LABELS[e.engine]} title={e.engine}>
                  {engineLabel(e.engine)} {e.count}
                </span>
              {/each}
            {:else}
              <span class="cc-chip legacy">{t("未记录引擎")}</span>
            {/if}
          </span>
        </span>
        <span class="cc-size">
          <span>{t("{n} 段", { n: r.size })}</span>
          <span class="cc-size-sub">{fmtChars(r.chars)}</span>
        </span>
        <span class="cc-date">{fmtDate(r.updated)}</span>
        <button
          type="button"
          class="rwd-tr-btn ghost"
          on:click={() => clearBook(r)}
          disabled={busy}
        >{t("清空")}</button>
      </div>
    {/each}
  {/if}

  {#if tip}<div class="cc-tip">{tip}</div>{/if}
</div>

<style>
  .cc-page { display: flex; flex-direction: column; gap: 12px; padding: 4px 2px; }
  .cc-intro { margin: 0; font-size: 12px; line-height: 1.6; color: var(--b3-theme-on-surface, #777); }
  .cc-sum {
    display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
    /* 固定行高：数字刷新不改变容器高度，避免列表整体跳动 */
    min-height: 18px; font-size: 12px; color: var(--b3-theme-on-surface, #777);
  }
  .cc-sum-dot { color: var(--b3-theme-on-surface, #bbb); }
  .cc-toolbar { display: flex; align-items: center; gap: 8px; }
  .cc-spacer { flex: 1; }
  .cc-empty { padding: 18px 0; text-align: center; font-size: 12px; color: var(--b3-theme-on-surface, #999); }
  .cc-head, .cc-row { display: grid; grid-template-columns: 1fr 96px 88px 60px; gap: 8px; align-items: center; }
  .cc-head { font-size: 11px; color: var(--b3-theme-on-surface, #999); padding: 0 2px; }
  .cc-row { padding: 6px 0; border-top: 1px solid var(--b3-border-color, #eee); }
  .cc-title { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .cc-title-name {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-size: 13px; color: var(--b3-theme-on-surface, #222);
  }
  .cc-title-meta {
    display: flex; gap: 4px; flex-wrap: nowrap; overflow: hidden;
    /* 固定行高：引擎 chip 有无都不改变行高 */
    height: 16px; align-items: center;
  }
  .cc-chip {
    flex: 0 0 auto; padding: 0 5px; border-radius: 8px;
    font-size: 10px; line-height: 16px; white-space: nowrap;
    background: var(--b3-theme-surface, #f2f2f2);
    color: var(--b3-theme-on-surface, #666);
  }
  .cc-chip.legacy { opacity: 0.7; }
  .cc-size { display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: var(--b3-theme-on-surface, #777); }
  .cc-size-sub { font-size: 10px; color: var(--b3-theme-on-surface, #999); }
  .cc-date { font-size: 12px; color: var(--b3-theme-on-surface, #777); }
  .cc-tip { font-size: 11px; color: var(--b3-theme-primary, #3b82f6); }
  /* 危险按钮：仅文字变红，内边距/边框与 ghost 一致 —— 切换态不引起位移 */
  .cc-toolbar :global(.rwd-tr-btn.danger) {
    color: var(--b3-theme-error, #d32f2f);
    border-color: color-mix(in srgb, var(--b3-theme-error, #d32f2f) 40%, transparent);
  }
  .cc-toolbar :global(.rwd-tr-btn.danger:disabled) { opacity: 0.45; }
</style>
