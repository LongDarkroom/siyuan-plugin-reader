<!--
  模板定制 · 二级页（2026-10-10 新建）
  ==================================================================
  ## 职责
  补上「模板引擎早已存在、但没有编辑入口」的缺口：
    · 卡片 1 · 划词发送：发送位置（剪贴板/指定文档，2026-10-10 收敛删除「当前文档」「笔记本」两条假成功去向）
      + 发送模板预设 + 模板正文（note.insertPosition / note.templatePreset / note.linkFormat）；
    · 卡片 2 · 摘录导出：导出模板预设 + 模板正文（exportTemplate / exportTemplatePreset），
      供标注面板「导出」按钮的模板引擎（export/template-engine.ts）使用。

  ## 数据流
  全部经 on:change 冒泡给宿主 setByPath 落盘（与 RowControl 同一通道），
  本组件不直接写 store。textarea 用 on:change（失焦提交）避免逐键写盘。

  ## 复用
  样式复用 settings-dialog.less 全局类（.rwd-card / .rw-row / .rw-label /
  .rw-select / .rw-segmented），自有类一律 rwt-tpl-* 前缀（已查无撞名）。
-->
<script lang="ts">
  import { createEventDispatcher, onMount } from "svelte";
  import { t } from "../../i18n/index.ts";
  import {
    NOTE_TEMPLATE_PRESETS,
    NOTE_INSERT_POSITION_PRESETS,
    type NoteInsertPosition,
    type NoteTemplatePreset,
  } from "../reader-settings.ts";
  import { TEMPLATE_PRESETS, presetById } from "../export/template-presets.ts";

  export let settings: any = {};

  const dispatch = createEventDispatcher();

  // ---- 本地编辑态（挂载时从 settings 取一次；本页 fresh-mount，无需跟踪外部变更） ----
  let sendPos: NoteInsertPosition = "clipboard";
  let sendPreset: NoteTemplatePreset = "simple";
  let sendTpl = "";
  let exportPreset = ""; // TEMPLATE_PRESETS 的 id；"" = 手改自定义
  let exportTpl = "";

  onMount(() => {
    const note = settings?.note ?? {};
    sendPos = (note.insertPosition as NoteInsertPosition) || "clipboard";
    sendPreset = (note.templatePreset as NoteTemplatePreset) || "simple";
    sendTpl = String(note.linkFormat ?? "");
    exportPreset = String(settings?.exportTemplatePreset ?? "");
    exportTpl = String(settings?.exportTemplate ?? "");
  });

  function change(path: string, value: any) {
    dispatch("change", { path, value });
  }

  const SEND_POSITIONS: NoteInsertPosition[] = ["clipboard", "doc"];

  /** Svelte 模板表达式不支持 TS 断言，预设条目在 script 侧铺平 */
  const SEND_PRESET_ENTRIES = (Object.keys(NOTE_TEMPLATE_PRESETS) as NoteTemplatePreset[]).map(
    (k) => ({ id: k, label: NOTE_TEMPLATE_PRESETS[k].label }),
  );

  function pickSendPos(v: NoteInsertPosition) {
    sendPos = v;
    change("note.insertPosition", v);
  }

  /** 选发送模板预设：非 custom 预设同时把正文替换为预设模板（可再手改） */
  function pickSendPreset(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value as NoteTemplatePreset;
    sendPreset = v;
    change("note.templatePreset", v);
    if (v !== "custom") {
      const tpl = NOTE_TEMPLATE_PRESETS[v]?.template ?? "";
      sendTpl = tpl;
      change("note.linkFormat", tpl);
    }
  }

  /** 手改发送模板正文：与某预设逐字相同则回挂该预设，否则记为 custom */
  function sendTplChanged() {
    change("note.linkFormat", sendTpl);
    const matched = (Object.keys(NOTE_TEMPLATE_PRESETS) as NoteTemplatePreset[]).find(
      (k) => k !== "custom" && NOTE_TEMPLATE_PRESETS[k].template === sendTpl,
    );
    const next: NoteTemplatePreset = matched ?? "custom";
    if (next !== sendPreset) {
      sendPreset = next;
      change("note.templatePreset", next);
    }
  }

  function pickExportPreset(e: Event) {
    const id = (e.currentTarget as HTMLSelectElement).value;
    exportPreset = id;
    const p = presetById(id);
    if (p) {
      exportTpl = p.template;
      change("exportTemplate", p.template);
    }
    change("exportTemplatePreset", id);
  }

  /** 手改导出模板：与某预设逐字相同则回挂其 id，否则清空（"" = 自定义） */
  function exportTplChanged() {
    change("exportTemplate", exportTpl);
    const matched = TEMPLATE_PRESETS.find((p) => p.template === exportTpl);
    const next = matched?.id ?? "";
    if (next !== exportPreset) {
      exportPreset = next;
      change("exportTemplatePreset", next);
    }
  }
</script>

<div class="rwt-tpl">
  <!-- ===== 卡片 1 · 划词发送 ===== -->
  <section class="rwd-card rwt-tpl-zone">
    <div class="rw-row">
      <div class="rw-label">
        <span class="rw-label-text">{t("发送位置")}</span>
        <span class="rw-hint">{t("划词工具栏「发送」按钮把选中文本写到哪去")}</span>
      </div>
      <div class="rwt-tpl-seg-wrap">
        <div class="rw-segmented">
          {#each SEND_POSITIONS as p (p)}
            <button
              type="button"
              class:on={sendPos === p}
              on:click={() => pickSendPos(p)}
            >{NOTE_INSERT_POSITION_PRESETS[p].label}</button>
          {/each}
        </div>
      </div>
    </div>

    <div class="rw-row rwt-tpl-row">
      <div class="rw-label">
        <span class="rw-label-text">{t("发送模板预设")}</span>
        <span class="rw-hint">{NOTE_INSERT_POSITION_PRESETS[sendPos]?.hint ?? ""}</span>
      </div>
      <div class="rw-control">
        <select class="rw-select" value={sendPreset} on:change={pickSendPreset}>
          {#each SEND_PRESET_ENTRIES as p (p.id)}
            <option value={p.id}>{p.label}</option>
          {/each}
        </select>
      </div>
    </div>

    <div class="rwt-tpl-row">
      <div class="rw-label">
        <span class="rw-label-text">{t("发送模板正文")}</span>
        <span class="rw-hint">{t("变量：{text} {bookTitle} {author} {chapter} {note} {date} {link}（link=回跳原书的深链）", { })}</span>
      </div>
      <textarea
        class="rwt-tpl-area"
        rows="5"
        spellcheck="false"
        bind:value={sendTpl}
        on:change={sendTplChanged}
      ></textarea>
    </div>
  </section>

  <!-- ===== 卡片 2 · 摘录导出模板 ===== -->
  <section class="rwd-card rwt-tpl-zone">
    <div class="rw-row rwt-tpl-row">
      <div class="rw-label">
        <span class="rw-label-text">{t("导出模板预设")}</span>
        <span class="rw-hint">{t("标注面板「导出」按钮按此模板生成 Markdown")}</span>
      </div>
      <div class="rw-control">
        <select class="rw-select" value={exportPreset} on:change={pickExportPreset}>
          <option value="">{t("自定义（手改）")}</option>
          {#each TEMPLATE_PRESETS as p (p.id)}
            <option value={p.id}>{p.label}</option>
          {/each}
        </select>
      </div>
    </div>

    <div class="rwt-tpl-row">
      <div class="rw-label">
        <span class="rw-label-text">{t("导出模板正文")}</span>
        <span class="rw-hint">{t("受限 Jinja 语法：{for} 循环、{if} 判断；过滤器如 {mark}")}</span>
      </div>
      <textarea
        class="rwt-tpl-area rwt-tpl-area-tall"
        rows="12"
        spellcheck="false"
        bind:value={exportTpl}
        on:change={exportTplChanged}
      ></textarea>
      <div class="rwt-tpl-vars">
        <span>{t("常用变量")}</span>
        <code>{"{{ book.title }}"} · {"{{ book.author }}"}</code>
        <code>{"{{ meta.count }}"} · {"{{ meta.exportDateText }}"}</code>
        <code>{"{% for c in chapters %}"} → {"{{ c.title }}"}</code>
        <code>{"{% for a in c.annotations %}"} → {"{{ a.text | blockquote }}"} · {"{{ a.note }}"}</code>
        <code>{"{{ a | mark }}"}（块属性占位，导出到文档时供 SQL 查询）</code>
      </div>
    </div>
  </section>
</div>

<style>
  .rwt-tpl { display: flex; flex-direction: column; gap: 12px; }
  .rwt-tpl-zone { padding: 4px 0; }
  .rwt-tpl-row { flex-direction: column; align-items: stretch; gap: 8px; padding: 10px 14px; }

  /* 发送位置：四个选项，窄面板允许换行 */
  .rwt-tpl-seg-wrap { padding: 0 14px 10px; }
  .rwt-tpl-seg-wrap .rw-segmented { flex-wrap: wrap; width: 100%; }

  /* 模板正文 textarea：等宽字体 + 主题变量配色 */
  .rwt-tpl-area {
    margin: 0 14px 12px; padding: 8px 10px;
    width: calc(100% - 28px);
    box-sizing: border-box;
    resize: vertical;
    border: 1px solid var(--b3-border-color, rgba(127, 127, 127, 0.2));
    border-radius: 8px;
    background: var(--b3-theme-surface, rgba(127, 127, 127, 0.06));
    color: var(--b3-theme-on-background, #e8e8ea);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px; line-height: 1.55;
    min-height: 0;
  }
  .rwt-tpl-area:focus { outline: none; border-color: var(--b3-theme-primary, #5b7cfa); }
  .rwt-tpl-area-tall { min-height: 220px; }

  /* 变量速查 */
  .rwt-tpl-vars {
    display: flex; flex-direction: column; gap: 3px;
    margin: 0 14px 12px;
    font-size: 11px; color: var(--b3-theme-on-surface-light, #8a8a90);
  }
  .rwt-tpl-vars code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 10.5px;
    color: var(--b3-theme-on-surface-light, #8a8a90);
    overflow-wrap: anywhere;
  }
</style>
