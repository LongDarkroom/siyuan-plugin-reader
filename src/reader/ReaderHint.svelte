<!--
  阅读器 - 快捷键提示面板共用组件（2026-10-10）
  ----------------------------------------------------------------
  抽自 ReaderView.svelte 原生模板：可被 ReaderView、BookshelfView、未来的 Notebook 复用。
  - 居中 modal，无遮罩（保持 closeAllPopovers「点空白关闭」的既有约定）
  - 4 个分组（nav / view / tts / other）
  - 未接线项（wired: false）整行压暗 + 右侧标注「暂不可用」
  - 主题色全部走 --b3-* 思源原生变量（深 / 浅色都正确）
  - 关闭：右上 × 按钮 / Esc 键 / 调用方传 visible=false
-->
<script lang="ts">
  import { t } from "../i18n/index.ts";

  /** 是否显示 */
  export let visible: boolean = false;
  /** 提示数据（来自 getHintGroups()，必传） */
  export let groups: Array<{ key: string; label: string; items: Array<{ keys: string; label: string; wired: boolean; group: string }> }> = [];
  /** 关闭回调（必传：父组件用这个回写 visible=false） */
  export let onClose: () => void = () => {};
</script>

{#if visible}
  <div class="reader-hint-panel" role="dialog" aria-label={t("快捷键")}>
    <div class="reader-hint-head">
      <span class="reader-hint-title">{t("键盘快捷键")}</span>
      <button
        type="button"
        class="reader-hint-close"
        aria-label={t("关闭")}
        on:click={onClose}
      >×</button>
    </div>
    <div class="reader-hint-body">
      {#each groups as g (g.key)}
        {#if g.items.length}
          <div class="reader-hint-group">
            <div class="reader-hint-group-title">{g.label}</div>
            {#each g.items as it (it.keys + it.label)}
              <div class="reader-hint-row" class:off={!it.wired}>
                <kbd class="reader-hint-key">{it.keys}</kbd>
                <span class="reader-hint-label">{it.label}</span>
                {#if !it.wired}
                  <span class="reader-hint-off">{t("暂不可用")}</span>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      {/each}
    </div>
    <div class="reader-hint-foot">{t("按 ? 或 Esc 关闭")}</div>
  </div>
{/if}

<style>
  /*
   * 设计取舍：
   * · 居中 modal：快捷键是「临时查阅」性质，用户视线在正文中央，
   *   放角落容易被忽略；居中一屏可见、Esc/? 随手关。
   * · 不用遮罩：同 closeAllPopovers 的既有约定（点空白 = 关闭），
   *   但不铺一层灰，避免像设置弹窗那样把阅读内容压暗 —— 查阅完要立刻回到书。
   * · 配色全部走 --b3-* 主题变量：面板在深/浅色下都要正确。
   * · 提示面板 z-index: 60，高于阅读器内浮层（z-index 50），低于思源顶栏（无明确但通常默认）。
   */
  .reader-hint-panel {
    position: absolute;
    left: 50%; top: 50%;
    transform: translate(-50%, -50%);
    z-index: 60;
    pointer-events: auto;
    width: min(420px, calc(100% - 48px));
    max-height: min(560px, 80%);
    display: flex;
    flex-direction: column;
    border-radius: 12px;
    background: var(--b3-theme-background, #fff);
    color: var(--b3-theme-on-background, #222);
    border: 0.5px solid var(--b3-border-color, rgba(127, 127, 127, 0.2));
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.22);
    overflow: hidden;
    /* 2026-10-10 阶段 3a：淡入动画 */
    animation: rhp-fade-in 160ms ease-out;
  }
  @keyframes rhp-fade-in {
    from { opacity: 0; transform: translate(-50%, -46%); }
    to   { opacity: 1; transform: translate(-50%, -50%); }
  }
  .reader-hint-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 12px;
    border-bottom: 0.5px solid var(--b3-border-color, rgba(127, 127, 127, 0.18));
    flex: none;
  }
  .reader-hint-title { font-size: 13.5px; font-weight: 500; }
  .reader-hint-close {
    border: none; background: transparent; cursor: pointer;
    font-size: 18px; line-height: 1; padding: 0 4px;
    color: var(--b3-theme-on-surface-light, #888);
  }
  .reader-hint-close:hover { color: var(--b3-theme-on-background, #222); }
  .reader-hint-body {
    flex: 1; min-height: 0; overflow-y: auto;
    padding: 10px 12px 4px;
  }
  .reader-hint-group + .reader-hint-group { margin-top: 12px; }
  .reader-hint-group-title {
    font-size: 11.5px; color: var(--b3-theme-on-surface-light, #888);
    margin-bottom: 5px;
  }
  .reader-hint-row {
    display: flex; align-items: center; gap: 10px;
    padding: 3.5px 0;
  }
  .reader-hint-key {
    flex: none;
    min-width: 76px; max-width: 132px;
    padding: 2px 7px;
    border-radius: 5px;
    background: var(--b3-theme-surface, rgba(127, 127, 127, 0.08));
    border: 0.5px solid var(--b3-border-color, rgba(127, 127, 127, 0.16));
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px; line-height: 1.5;
    color: var(--b3-theme-on-background, #222);
    text-align: center;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .reader-hint-label {
    flex: 1; min-width: 0;
    font-size: 12.5px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  /* 未接线项：整行压暗 + 右侧标注，避免用户以为按了没反应是 bug */
  .reader-hint-row.off { opacity: 0.5; }
  .reader-hint-off {
    flex: none;
    font-size: 10.5px; color: var(--b3-theme-on-surface-light, #999);
  }
  .reader-hint-foot {
    flex: none;
    padding: 8px 12px;
    border-top: 0.5px solid var(--b3-border-color, rgba(127, 127, 127, 0.18));
    font-size: 11px; color: var(--b3-theme-on-surface-light, #888);
    text-align: center;
  }
</style>
