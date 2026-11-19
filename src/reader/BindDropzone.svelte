<script lang="ts">
  import { t } from "../i18n/index.ts";
  import { createEventDispatcher } from "svelte";
  import { getDocInfo, lsNotebooks, listDocsByPath } from "../siyuan/filetree.ts";
  import type { SiyuanNotebook, SiyuanDocNode } from "../siyuan/types.ts";

  /** 当前绑定的文档信息（用于展示，由父组件传入） */
  export let label = t("目标文档");
  export let docId = "";
  export let docTitle = "";
  export let notebookId = "";

  const dispatch = createEventDispatcher<{
    bind: { docId: string; title: string; notebookId: string };
    clear: void;
  }>();

  let dragOver = false;
  let pasteId = "";
  let resolving = false;
  let errMsg = "";

  /** 触屏环境（决定提示文案：触屏没有拖拽，别让用户对着「拖入」发呆） */
  const touchUI =
    typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)")?.matches;

  // 思源笔记文档树拖拽写入 dataTransfer 的 MIME 类型（常量名 Constants.SIYUAN_DROP_FILE）
  const SIYUAN_DROP_FILE = "application/siyuan-file";

  /** 从任意文本中解析出标准思源文档 ID（支持直接粘贴 ID 或 siyuan://blocks/xxxx 链接） */
  function extractDocId(raw: string): string {
    const s = (raw || "").trim();
    const m = s.match(/[0-9]{14}-[a-zA-Z0-9]{7}/);
    return m ? m[0] : s;
  }

  async function resolveAndBind(rawId: string) {
    const id = extractDocId(rawId);
    if (!id) return;
    errMsg = "";
    resolving = true;
    try {
      const info: any = await getDocInfo(id);
      // 校验返回确实对应一个存在的文档（id + 笔记本 box 必须存在）
      if (!info || !info.id || !info.box) {
        errMsg = t("无法解析该文档 ID，请确认文档存在且为文档 ID。");
        return;
      }
      const title = info.name || info.title || info.hPath?.split("/").pop() || id;
      dispatch("bind", { docId: info.id, title, notebookId: info.box });
    } catch (e) {
      console.warn("[REword] 绑定文档解析失败:", e);
      errMsg = t("无法解析该文档 ID，请确认文档存在。");
    } finally {
      resolving = false;
    }
  }

  function onDragOver(e: DragEvent) {
    // 仅当携带思源文档时接管拖放，避免影响其它拖拽
    if (e.dataTransfer && Array.from(e.dataTransfer.types).includes(SIYUAN_DROP_FILE)) {
      e.preventDefault();
      e.stopPropagation();
      dragOver = true;
    }
  }
  function onDragLeave(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
  }
  async function onDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragOver = false;
    const raw = e.dataTransfer?.getData(SIYUAN_DROP_FILE) || "";
    if (!raw) {
      errMsg = t("拖入的不是思源笔记文档，请从左侧文档树拖入。");
      return;
    }
    // 思源拖拽 payload：逗号分隔的文档 data-node-id 列表，取第一个
    const firstId = raw.split(",")[0]?.trim();
    await resolveAndBind(firstId);
  }

  function onBindClick() {
    if (pasteId.trim()) resolveAndBind(pasteId);
  }

  function onClear() {
    pasteId = "";
    errMsg = "";
    dispatch("clear");
  }

  /* ================= 2026-11-19 P2-19：触屏的文档选择器 =================
   * 病根：本组件只有「从文档树拖入」+「粘贴 ID」两条路径。
   * 手机上没有拖拽，用户也不可能知道文档 ID ⇒ 功能在触屏上等于不存在。
   * 「选文件」给不出思源文档 ID（文档不在文件系统里），所以补的是**本地面板**：
   * 笔记本 → 逐级进入文档树 → 点一行即绑定（复用 resolveAndBind，不新开绑定逻辑）。
   * 只读，不写思源任何数据；出错只在本组件内提示。 */
  let pickerOpen = false;
  let pickerLoading = false;
  let notebooks: SiyuanNotebook[] = [];
  let curNb: SiyuanNotebook | null = null;
  /** 当前层级路径（内核路径，进入文档时是父文档的 path） */
  let curPath = "";
  /** 面包屑（人类可读，最后一项是当前层） */
  let crumbs: { name: string; path: string }[] = [];
  let nodes: SiyuanDocNode[] = [];

  async function togglePicker() {
    pickerOpen = !pickerOpen;
    if (!pickerOpen) return;
    errMsg = "";
    if (notebooks.length === 0) {
      pickerLoading = true;
      try {
        notebooks = (await lsNotebooks()).filter((n) => !n.closed);
      } catch {
        errMsg = t("读取笔记本失败，请稍后重试。");
      } finally {
        pickerLoading = false;
      }
    }
  }

  async function enterNotebook(nb: SiyuanNotebook) {
    curNb = nb;
    curPath = "";
    crumbs = [{ name: nb.name, path: "" }];
    await loadNodes();
  }

  async function enterDoc(node: SiyuanDocNode) {
    if (!curNb || !node.path) return;
    curPath = node.path;
    crumbs = [...crumbs, { name: node.name || node.id, path: node.path }];
    await loadNodes();
  }

  async function goCrumb(index: number) {
    if (!curNb) return;
    crumbs = crumbs.slice(0, index + 1);
    curPath = crumbs[crumbs.length - 1]?.path ?? "";
    await loadNodes();
  }

  async function loadNodes() {
    if (!curNb) return;
    pickerLoading = true;
    errMsg = "";
    try {
      nodes = await listDocsByPath(curNb.id, curPath);
    } catch {
      nodes = [];
      errMsg = t("读取文档列表失败，请稍后重试。");
    } finally {
      pickerLoading = false;
    }
  }

  async function pickNode(node: SiyuanDocNode) {
    pickerOpen = false;
    await resolveAndBind(node.id);
  }
</script>

<div class="bind-dropzone" class:drag-over={dragOver}>
  <div class="bind-head">
    <span class="bind-label">{label}</span>
    {#if docId}
      <span class="bind-status ok">{t("已绑定")}：{docTitle || docId}</span>
    {:else}
      <span class="bind-status none">{t("未绑定")}</span>
    {/if}
  </div>

  <div
    class="bind-target"
    on:dragover={onDragOver}
    on:dragleave={onDragLeave}
    on:drop={onDrop}
    role="region"
    aria-label={t("拖入思源笔记文档完成绑定")}
  >
    {#if dragOver}
      <div class="bind-hint">{t("松开以绑定到此文档")}</div>
    {:else if touchUI}
      <!-- 触屏没有拖拽：直接指向唯一的可用入口，别让用户对着「拖入」发呆 -->
      <div class="bind-hint">{t("触屏设备：点下方「浏览文档」选择")}</div>
    {:else}
      <div class="bind-hint">{t("从左侧思源文档树拖入文档到这里")}</div>
    {/if}
  </div>

  <div class="bind-actions">
    <input
      class="bind-input"
      type="text"
      placeholder={t("粘贴文档 ID…")}
      bind:value={pasteId}
      on:keydown={(e) => {
        if (e.key === "Enter") onBindClick();
      }}
    />
    <button class="bind-btn" on:click={onBindClick} disabled={resolving || !pasteId.trim()}>{t("绑定")}</button>
    <button class="bind-btn bind-btn-browse" on:click={togglePicker} disabled={pickerLoading}>
      {pickerOpen ? t("收起") : t("浏览文档")}
    </button>
    {#if docId}
      <button class="bind-btn bind-btn-clear" on:click={onClear}>{t("清除")}</button>
    {/if}
  </div>

  {#if pickerOpen}
    <div class="bind-picker">
      {#if !curNb}
        {#if notebooks.length === 0 && !pickerLoading}
          <div class="bind-err">{t("没有可用的笔记本")}</div>
        {/if}
        {#each notebooks as nb (nb.id)}
          <button class="bind-pick-row" on:click={() => enterNotebook(nb)}>
            <span class="bind-pick-name">{nb.icon ? nb.icon + " " : ""}{nb.name}</span>
            <span class="bind-pick-in">›</span>
          </button>
        {/each}
      {:else}
        <div class="bind-crumbs">
          {#each crumbs as c, i (c.path + "#" + i)}
            <button class="bind-crumb" on:click={() => goCrumb(i)}>{c.name}</button>
            {#if i < crumbs.length - 1}<span class="bind-sep">/</span>{/if}
          {/each}
        </div>
        {#if nodes.length === 0 && !pickerLoading}
          <div class="bind-err">{t("这里没有文档")}</div>
        {/if}
        {#each nodes as n (n.id)}
          <div class="bind-pick-item">
            <button class="bind-pick-name" on:click={() => pickNode(n)} title={n.hPath || n.name}>
              {n.name || n.id}
            </button>
            {#if (n.subFileCount ?? 0) > 0 || (n.children?.length ?? 0) > 0}
              <button class="bind-pick-in" on:click={() => enterDoc(n)} aria-label={t("进入子文档")}>›</button>
            {/if}
          </div>
        {/each}
      {/if}
      {#if pickerLoading}
        <div class="bind-err">{t("加载中…")}</div>
      {/if}
    </div>
  {/if}

  {#if errMsg}
    <div class="bind-err">{errMsg}</div>
  {/if}
  {#if resolving}
    <div class="bind-err" style="color:var(--b3-theme-on-surface,#999);">{t("解析中…")}</div>
  {/if}
</div>

<style>
  .bind-dropzone {
    margin: 10px 0;
    padding: 10px 12px;
    border: 1px solid var(--b3-theme-surface-lighter, #e5e5e5);
    border-radius: 8px;
    background: var(--b3-theme-background, #fafafa);
  }
  .bind-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
  }
  .bind-label {
    font-weight: 600;
    font-size: 13px;
  }
  .bind-status {
    font-size: 12px;
    max-width: 60%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bind-status.ok {
    color: #16a34a;
  }
  .bind-status.none {
    color: var(--b3-theme-on-surface, #999);
  }
  .bind-target {
    border: 1.5px dashed var(--b3-border-color, #c9c9c9);
    border-radius: 8px;
    padding: 14px 10px;
    text-align: center;
    color: var(--b3-theme-on-surface, #888);
    font-size: 12.5px;
    transition: background 0.15s, border-color 0.15s;
    cursor: default;
  }
  .bind-target.drag-over {
    border-color: var(--b3-theme-primary, #3b82f6);
    background: rgba(59, 130, 246, 0.08);
    color: var(--b3-theme-primary, #3b82f6);
  }
  .bind-actions {
    display: flex;
    gap: 8px;
    margin-top: 8px;
    align-items: center;
  }
  .bind-input {
    flex: 1 1 auto;
    min-width: 0;
    padding: 5px 8px;
    border: 1px solid var(--b3-border-color, #ddd);
    border-radius: 6px;
    font-size: 12.5px;
    background: var(--b3-theme-surface, #fff);
    color: var(--b3-theme-on-surface, #333);
  }
  .bind-btn {
    flex: 0 0 auto;
    padding: 5px 12px;
    border: 1px solid var(--b3-border-color, #d3d3d3);
    background: var(--b3-theme-surface, #f5f5f5);
    color: var(--b3-theme-on-surface, #333);
    border-radius: 6px;
    cursor: pointer;
    font-size: 12.5px;
  }
  .bind-btn:hover {
    background: var(--b3-theme-surface-hover, #eaeaea);
  }
  .bind-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .bind-btn-clear {
    color: #d97706;
    border-color: rgba(217, 119, 6, 0.4);
  }
  .bind-err {
    margin-top: 6px;
    font-size: 12px;
    color: #dc2626;
  }
  /* ---- 2026-11-19 P2-19：文档选择器（触屏的拖放等价物） ---- */
  .bind-picker {
    margin-top: 8px;
    max-height: 220px;
    overflow-y: auto;
    overscroll-behavior: contain;
    border: 1px solid var(--b3-theme-surface-lighter, #e5e5e5);
    border-radius: 8px;
    padding: 4px;
    background: var(--b3-theme-background, #fff);
  }
  .bind-crumbs {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 2px;
    padding: 2px 2px 6px;
    border-bottom: 1px solid var(--b3-theme-surface-lighter, #eee);
    margin-bottom: 4px;
  }
  .bind-crumb {
    border: none;
    background: none;
    padding: 2px 4px;
    font-size: 12px;
    color: var(--b3-theme-primary, #3b82f6);
    cursor: pointer;
    border-radius: 4px;
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bind-crumb:hover {
    background: var(--b3-theme-surface-hover, #f0f0f0);
  }
  .bind-sep {
    color: var(--b3-theme-on-surface-light, #aaa);
    font-size: 12px;
  }
  /* 行列高 ≥44px：触屏是唯一入口，不能按桌面密度排 */
  .bind-pick-row,
  .bind-pick-item {
    display: flex;
    align-items: stretch;
    gap: 2px;
    width: 100%;
  }
  .bind-pick-row {
    border: none;
    background: none;
    padding: 0 4px;
    min-height: 44px;
    align-items: center;
    justify-content: space-between;
    border-radius: 6px;
    cursor: pointer;
    color: var(--b3-theme-on-surface, #333);
    font-size: 13px;
    text-align: left;
  }
  .bind-pick-row:hover,
  .bind-pick-item:hover {
    background: var(--b3-theme-surface-hover, #f2f2f2);
  }
  .bind-pick-name {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 44px;
    border: none;
    background: none;
    padding: 0 4px;
    text-align: left;
    font-size: 13px;
    color: inherit;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bind-pick-in {
    flex: 0 0 auto;
    width: 44px;
    border: none;
    background: none;
    color: var(--b3-theme-on-surface-light, #999);
    font-size: 18px;
    cursor: pointer;
    border-radius: 6px;
  }
  .bind-pick-in:hover {
    background: var(--b3-theme-surface-hover, #eaeaea);
    color: var(--b3-theme-primary, #3b82f6);
  }
</style>
