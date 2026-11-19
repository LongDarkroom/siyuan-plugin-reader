<script lang="ts">
  /**
   * 云端书库面板（WebDAV / S3）
   * ----------------------------------------------------------------
   * 定位：把「用户自己放进网盘/对象存储的书」读进思源书架。
   * 远端**只读**，下载产物直接交给 `BookshelfStore.importBook`，
   * 所以去重、封面、进度、批注全部沿用本地书架那套，不另开阅读通路。
   *
   * 外壳沿用 OpdsSearchPanel 的 `edit-mask` + `portal`：portal 挂到 body 是为了
   * 逃离 dock 裁剪拿到宽度，这点和 OPDS 面板同一个理由。
   */
  import { t } from "../i18n/index.ts";
  import { onMount, createEventDispatcher } from "svelte";
  import { portal } from "../utils/portal";
  import type { BookshelfStore } from "./bookshelf-store";
  import { SEL_ICONS } from "./sel-icons.generated.ts";
  import {
    loadCloudAccounts, saveCloudAccounts, loadActiveCloudId, saveActiveCloudId, newCloudId,
    formatBytes, isBookName, normalizeBaseUrl, normalizeS3Endpoint, normalizeDirPath, normalizeS3Prefix,
    type CloudAccount, type CloudKind, type RemoteEntry,
  } from "./cloud/cloud-types";
  import { listCloud, downloadCloud, testCloud } from "./cloud/cloud-shelf";

  export let store: BookshelfStore;
  export let onOpenBook: ((bookId: string) => void) | null = null;
  const dispatch = createEventDispatcher();

  interface Draft {
    id: string;
    name: string;
    kind: CloudKind;
    baseUrl: string;
    username: string;
    password: string;
    rootPath: string;
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    prefix: string;
    pathStyle: boolean;
  }

  function blankDraft(): Draft {
    return {
      id: "", name: "", kind: "webdav",
      baseUrl: "", username: "", password: "", rootPath: "",
      endpoint: "", region: "us-east-1", bucket: "", accessKeyId: "", secretAccessKey: "",
      prefix: "books/", pathStyle: false,
    };
  }

  let accounts: CloudAccount[] = [];
  let activeId = "";
  let mode: "browse" | "edit" = "browse";
  let draft: Draft = blankDraft();

  let entries: RemoteEntry[] = [];
  let dirStack: string[] = [];
  let loading = false;
  let error = "";
  let notice = "";
  let owned = new Set<string>();
  let progress: { name: string; loaded: number; total: number } | null = null;
  let cancelFlag = false;
  let lastImportedId = "";
  let testing = false;
  let testResult: { ok: boolean; message: string } | null = null;
  /** 密码/SecretKey 是否明文显示；两格共用一个开关，切协议时不残留 */
  let showSecret = false;

  $: active = accounts.find((a) => a.id === activeId) || accounts[0] || null;

  function normTitle(s: string): string {
    return (s || "").replace(/\.[a-z0-9]+$/i, "").trim().toLowerCase();
  }

  function refreshOwned(): void {
    owned = new Set(store.list.map((b) => normTitle(b.title)));
  }

  function close(): void {
    dispatch("close");
  }

  /**
   * Esc 关窗。下载进行中不放行 —— 窗口一关进度条就没了，导入成功与否用户无从确认。
   * 先问 defaultPrevented：书架的全局 Esc 链（右键菜单 → 各类弹窗）比本面板先注册，
   * 它消费过的事件不能再动，否则一次 Esc 关两层。
   */
  function onWindowKeydown(e: KeyboardEvent): void {
    if (e.key !== "Escape" || e.defaultPrevented || progress) return;
    e.preventDefault();
    close();
  }

  function relPath(): string {
    return dirStack.join("/");
  }

  /** 草稿 → 账号对象（只取当前 kind 用得上的字段，避免脏数据留在 localStorage） */
  function draftToAccount(d: Draft): CloudAccount {
    if (d.kind === "webdav") {
      return {
        id: d.id || newCloudId(), kind: "webdav", name: d.name.trim() || t("WebDAV"),
        baseUrl: normalizeBaseUrl(d.baseUrl),
        username: d.username.trim(), password: d.password,
        rootPath: normalizeDirPath(d.rootPath),
      };
    }
    return {
      id: d.id || newCloudId(), kind: "s3", name: d.name.trim() || t("S3"),
      endpoint: normalizeS3Endpoint(d.endpoint),
      region: d.region.trim() || "us-east-1",
      bucket: d.bucket.trim(),
      accessKeyId: d.accessKeyId.trim(), secretAccessKey: d.secretAccessKey,
      prefix: normalizeS3Prefix(d.prefix),
      pathStyle: d.pathStyle,
    };
  }

  function accountToDraft(a: CloudAccount): Draft {
    const base = blankDraft();
    base.id = a.id;
    base.name = a.name;
    base.kind = a.kind;
    if (a.kind === "webdav") {
      base.baseUrl = a.baseUrl; base.username = a.username; base.password = a.password; base.rootPath = a.rootPath;
    } else {
      base.endpoint = a.endpoint; base.region = a.region; base.bucket = a.bucket;
      base.accessKeyId = a.accessKeyId; base.secretAccessKey = a.secretAccessKey;
      base.prefix = a.prefix; base.pathStyle = a.pathStyle;
    }
    return base;
  }

  /** 必填校验：缺什么直接说在哪一格，别等请求失败再猜 */
  function validateDraft(d: Draft): string {
    if (d.kind === "webdav") {
      if (!normalizeBaseUrl(d.baseUrl)) return t("请填写服务器地址");
      return "";
    }
    if (!normalizeS3Endpoint(d.endpoint)) return t("请填写端点");
    if (!d.bucket.trim()) return t("请填写 Bucket");
    if (!d.accessKeyId.trim()) return t("请填写 AccessKeyId");
    if (!d.secretAccessKey.trim()) return t("请填写 SecretAccessKey");
    if (!d.region.trim()) return t("请填写 Region");
    return "";
  }

  /**
   * 列目录。账号在这里**就地取**，不读响应式的 `active`：
   * onMount 里 `activeId = …` 之后同步调用 browse()，那会儿 `$: active` 还没重算，
   * 读到的仍是 null —— 于是有已存账号时首屏直接显示「这个目录下没有内容」，
   * 要点一下刷新才出结果（2026-11-15 浏览器 harness 复现并修掉）。
   */
  async function browse(): Promise<void> {
    const acct = accounts.find((a) => a.id === activeId) || accounts[0] || null;
    if (!acct) return;
    loading = true;
    error = "";
    try {
      entries = await listCloud(acct, relPath());
    } catch (e: any) {
      entries = [];
      error = e?.message || String(e);
    } finally {
      loading = false;
    }
  }

  function enter(dir: RemoteEntry): void {
    // 用 path 而不是 name：displayname 由服务器给，可能和 URL 段不一致（Nextcloud 会返回美化过的名字）
    const seg = dir.path.replace(/\/+$/, "");
    if (!seg) return;
    dirStack = [...dirStack, seg];
    void browse();
  }

  function up(): void {
    if (!dirStack.length) return;
    dirStack = dirStack.slice(0, -1);
    void browse();
  }

  function gotoCrumb(i: number): void {
    dirStack = i < 0 ? [] : dirStack.slice(0, i + 1);
    void browse();
  }

  async function pull(entry: RemoteEntry): Promise<void> {
    if (!active || progress) return;
    error = "";
    notice = "";
    cancelFlag = false;
    lastImportedId = "";
    progress = { name: entry.name, loaded: 0, total: entry.size || 0 };
    try {
      const file = await downloadCloud(active, entry, {
        onProgress: (loaded, total) => {
          if (progress) progress = { ...progress, loaded, total: total || progress.total };
        },
        shouldAbort: () => cancelFlag,
      });
      const meta = await store.importBook(file);
      refreshOwned();
      if (meta) {
        lastImportedId = meta.id;
        notice = meta.cover ? t("已加入书架") : t("已加入书架（未取到封面）");
      } else {
        // importBook 返回 null 只有两种情况：同名同大小重复，或内容指纹已存在
        notice = t("这本书已在书架里");
      }
    } catch (e: any) {
      error = e?.message || String(e);
    } finally {
      progress = null;
      cancelFlag = false;
    }
  }

  function cancelPull(): void {
    cancelFlag = true;
  }

  function openNew(): void {
    if (lastImportedId && onOpenBook) onOpenBook(lastImportedId);
  }

  function startAdd(): void {
    draft = blankDraft();
    testResult = null;
    error = "";
    mode = "edit";
  }

  function startEdit(): void {
    if (!active) return startAdd();
    draft = accountToDraft(active);
    testResult = null;
    error = "";
    mode = "edit";
  }

  async function runTest(): Promise<void> {
    const bad = validateDraft(draft);
    if (bad) { error = bad; return; }
    error = "";
    testing = true;
    try {
      const r = await testCloud(draftToAccount(draft));
      // testCloud 的成功文案已经自带「连接成功，…」前缀，别再拼一次
      testResult = { ok: r.ok, message: r.message };
    } finally {
      testing = false;
    }
  }

  function saveDraft(): void {
    const bad = validateDraft(draft);
    if (bad) { error = bad; return; }
    const acct = draftToAccount(draft);
    const idx = accounts.findIndex((a) => a.id === acct.id);
    if (idx >= 0) accounts[idx] = acct;
    else accounts = [...accounts, acct];
    accounts = accounts;
    saveCloudAccounts(accounts);
    activeId = acct.id;
    saveActiveCloudId(activeId);
    mode = "browse";
    dirStack = [];
    testResult = null;
    void browse();
  }

  function removeAccount(): void {
    if (!active) return;
    if (!confirm(t("删除这个云端账号的配置？远端文件不会被删除。"))) return;
    accounts = accounts.filter((a) => a.id !== active.id);
    saveCloudAccounts(accounts);
    activeId = accounts[0]?.id || "";
    saveActiveCloudId(activeId);
    entries = [];
    mode = accounts.length ? "browse" : "edit";
    if (accounts.length) void browse();
  }

  function onAccountChange(e: Event): void {
    activeId = (e.target as HTMLSelectElement).value;
    saveActiveCloudId(activeId);
    dirStack = [];
    entries = [];
    error = "";
    void browse();
  }

  function pct(p: { loaded: number; total: number } | null): number {
    if (!p || !p.total) return 0;
    return Math.min(99, Math.round((p.loaded / p.total) * 100));
  }

  // 模板里不能写 `as` 断言（svelte 的 TS 解析不吃），所以在这里把类型定好。
  // 不做响应式：语言切换本来就要求重载插件生效，与其余组件同一口径。
  const kindOptions: Array<{ value: CloudKind; label: string; hint: string }> = [
    { value: "webdav", label: "WebDAV", hint: t("坚果云 / Nextcloud / 群晖") },
    { value: "s3", label: "S3", hint: t("AWS / R2 / MinIO / OSS") },
  ];

  // 分段控件收成一行后，说明文字没地方塞进按钮里了，改放到控件下面跟着当前选择走
  $: kindHint = (kindOptions.find((o) => o.value === draft.kind) || kindOptions[0]).hint;

  function pickKind(v: CloudKind): void {
    draft.kind = v;
    testResult = null;
    error = "";
  }

  onMount(async () => {
    await store.load();
    refreshOwned();
    accounts = loadCloudAccounts();
    activeId = loadActiveCloudId() && accounts.some((a) => a.id === loadActiveCloudId())
      ? loadActiveCloudId()
      : accounts[0]?.id || "";
    if (accounts.length) void browse();
    else mode = "edit";
  });
</script>

<svelte:window on:keydown={onWindowKeydown} />

<div class="edit-mask" use:portal on:click|self={close}>
  <div class="edit-panel cloud-panel" role="dialog" aria-modal="true" aria-label={t("云端书库")}>
    <header class="panel-header">
      <h2 class="panel-title">{t("云端书库")}</h2>
      <button class="panel-close" on:click={close} aria-label={t("关闭")}>×</button>
    </header>

    {#if mode === "edit"}
      <!-- ============ 配置 ============ -->
      <div class="cloud-form">
        <section class="cloud-group">
          <h3 class="cloud-group-title">{t("连接方式")}</h3>
          <!-- 分段控件：两种协议是同级选项，用不着两张大卡片占掉半屏（demo 验收后定的） -->
          <div class="cloud-kind" role="radiogroup" aria-label={t("同步方式")}>
            {#each kindOptions as opt (opt.value)}
              <button
                class="cloud-kind-btn"
                class:on={draft.kind === opt.value}
                role="radio"
                aria-checked={draft.kind === opt.value}
                on:click={() => pickKind(opt.value)}
              >{opt.label}</button>
            {/each}
          </div>
          <p class="cloud-kind-hint">{kindHint}</p>
        </section>

        <section class="cloud-group">
          <h3 class="cloud-group-title">{t("连接")}</h3>
          <div class="cloud-field">
            <span class="cloud-field-label">{t("显示名")}</span>
            <input class="cloud-input" bind:value={draft.name} placeholder={t("例如：坚果云")} />
          </div>

          {#if draft.kind === "webdav"}
            <div class="cloud-field">
              <span class="cloud-field-label">{t("服务器地址")}</span>
              <input class="cloud-input" bind:value={draft.baseUrl} placeholder="https://dav.jianguoyun.com/dav" />
            </div>
          {:else}
            <div class="cloud-field">
              <span class="cloud-field-label">{t("端点")}</span>
              <input class="cloud-input" bind:value={draft.endpoint} placeholder="https://s3.us-west-2.amazonaws.com" />
            </div>
            <div class="cloud-field">
              <span class="cloud-field-label">{t("Region")}</span>
              <input class="cloud-input" bind:value={draft.region} placeholder="us-east-1" />
            </div>
          {/if}
        </section>

        <section class="cloud-group">
          <h3 class="cloud-group-title">{t("凭据")}</h3>
          {#if draft.kind === "webdav"}
            <div class="cloud-field">
              <span class="cloud-field-label">{t("用户名")}</span>
              <input class="cloud-input" bind:value={draft.username} autocomplete="off" />
            </div>
            <div class="cloud-field">
              <span class="cloud-field-label">{t("密码")}</span>
              <div class="cloud-field-box">
                <!-- svelte 4 不让 bind:value 配动态 type，只能两格切换；
                     代价是点「显示/隐藏」后输入框重建、光标回到开头，鼠标操作感知不到 -->
                {#if showSecret}
                  <input class="cloud-input with-btn" type="text" bind:value={draft.password} autocomplete="off" />
                {:else}
                  <input class="cloud-input with-btn" type="password" bind:value={draft.password} autocomplete="off" />
                {/if}
                <button class="cloud-eye" on:click={() => (showSecret = !showSecret)}>
                  {showSecret ? t("隐藏") : t("显示")}
                </button>
              </div>
            </div>
            <p class="cloud-note">{t("坚果云请用「应用密码」，不是登录密码。")}</p>
          {:else}
            <div class="cloud-field">
              <span class="cloud-field-label">{t("AccessKeyId")}</span>
              <input class="cloud-input" bind:value={draft.accessKeyId} autocomplete="off" />
            </div>
            <div class="cloud-field">
              <span class="cloud-field-label">{t("SecretAccessKey")}</span>
              <div class="cloud-field-box">
                {#if showSecret}
                  <input class="cloud-input with-btn" type="text" bind:value={draft.secretAccessKey} autocomplete="off" />
                {:else}
                  <input class="cloud-input with-btn" type="password" bind:value={draft.secretAccessKey} autocomplete="off" />
                {/if}
                <button class="cloud-eye" on:click={() => (showSecret = !showSecret)}>
                  {showSecret ? t("隐藏") : t("显示")}
                </button>
              </div>
            </div>
          {/if}
        </section>

        <section class="cloud-group">
          <h3 class="cloud-group-title">{t("书库位置")}</h3>
          {#if draft.kind === "webdav"}
            <div class="cloud-field">
              <span class="cloud-field-label">{t("书库目录")}</span>
              <input class="cloud-input" bind:value={draft.rootPath} placeholder="Books" />
            </div>
          {:else}
            <div class="cloud-field">
              <span class="cloud-field-label">{t("Bucket")}</span>
              <input class="cloud-input" bind:value={draft.bucket} />
            </div>
            <div class="cloud-field">
              <span class="cloud-field-label">{t("前缀")}</span>
              <input class="cloud-input" bind:value={draft.prefix} placeholder="books/" />
            </div>
            <div class="cloud-field">
              <span class="cloud-field-label">{t("访问风格")}</span>
              <label class="cloud-check">
                <input type="checkbox" bind:checked={draft.pathStyle} />
                <span>{t("使用 path-style（bucket 写在路径里）")}</span>
              </label>
            </div>
            <p class="cloud-note">
              {t("MinIO / rclone / 群晖通常需要勾选；amazonaws.com 会自动用 virtual-hosted。")}
            </p>
          {/if}
        </section>

        {#if testResult}
          <p class="cloud-msg" class:bad={!testResult.ok}>{testResult.message}</p>
        {/if}
        {#if error}
          <p class="cloud-msg bad" role="alert">{error}</p>
        {/if}
      </div>

      <footer class="cloud-actions">
        {#if draft.id}
          <button class="cloud-btn danger" on:click={removeAccount}>{t("删除账号")}</button>
        {/if}
        {#if accounts.length}
          <button class="cloud-btn" on:click={() => { mode = "browse"; error = ""; }}>{t("取消")}</button>
        {/if}
        <button class="cloud-btn test" disabled={testing} on:click={runTest}>
          {testing ? t("测试中…") : t("测试连接")}
        </button>
        <button class="cloud-btn primary" on:click={saveDraft}>{t("保存")}</button>
      </footer>
    {:else}
      <!-- ============ 浏览 ============ -->
      <div class="cloud-body">
        <div class="cloud-toolbar">
          <select class="cloud-input cloud-select" value={activeId} on:change={onAccountChange} aria-label={t("云端账号")}>
            {#each accounts as a (a.id)}
              <option value={a.id}>{a.name}（{a.kind === "webdav" ? "WebDAV" : "S3"}）</option>
            {/each}
          </select>
          <button class="cloud-btn" on:click={startEdit}>{t("配置")}</button>
          <button
            class="cloud-btn icon"
            title={t("刷新")}
            aria-label={t("刷新")}
            disabled={loading || !active}
            on:click={browse}
          >{@html SEL_ICONS.refresh}</button>
        </div>

        <nav class="cloud-crumb" aria-label={t("路径")}>
          <button class="cloud-crumb-btn" class:on={!dirStack.length} on:click={() => gotoCrumb(-1)}>{t("书库根")}</button>
          {#each dirStack as seg, i (i)}
            <span class="cloud-crumb-sep">›</span>
            <button class="cloud-crumb-btn" class:on={i === dirStack.length - 1} on:click={() => gotoCrumb(i)}>{seg}</button>
          {/each}
          {#if dirStack.length}
            <button class="cloud-crumb-btn up" on:click={up}>{t("返回上级")}</button>
          {/if}
        </nav>

        {#if error}
          <p class="cloud-msg bad" role="alert">{error}</p>
        {/if}
        {#if notice}
          <p class="cloud-msg">
            {notice}
            {#if lastImportedId && onOpenBook}
              <button class="cloud-btn primary mini" on:click={openNew}>{t("立即打开")}</button>
            {/if}
          </p>
        {/if}

        {#if progress}
          <div class="cloud-progress">
            <div class="cloud-progress-head">
              <span class="cloud-progress-name">{progress.name}</span>
              <span class="cloud-progress-num">{formatBytes(progress.loaded)} / {progress.total ? formatBytes(progress.total) : "?"}</span>
            </div>
            <div class="cloud-bar"><div class="cloud-bar-fill" style="width:{pct(progress)}%"></div></div>
            <button class="cloud-btn mini" on:click={cancelPull}>{t("取消")}</button>
          </div>
        {/if}

        <div class="cloud-list" aria-live="polite">
          {#if loading && !entries.length}
            <p class="cloud-empty">{t("读取中…")}</p>
          {:else if !entries.length && !error}
            <p class="cloud-empty">{t("这个目录下没有内容。云端放书的方式就是把文件拷进这个目录——插件只读，不会改动也不会删除。")}</p>
          {:else}
            {#each entries as e (e.path)}
              {@const inShelf = !e.isDir && owned.has(normTitle(e.name))}
              <div class="cloud-row">
                <span class="cloud-ico reword-shelf-ico">{@html e.isDir ? SEL_ICONS.group : (isBookName(e.name) ? SEL_ICONS.bookFallback : SEL_ICONS.cloudFile)}</span>
                {#if e.isDir}
                  <button class="cloud-name dir" on:click={() => enter(e)}>{e.name}</button>
                {:else}
                  <span class="cloud-name">{e.name}</span>
                {/if}
                <span class="cloud-size">{e.isDir ? "" : formatBytes(e.size)}</span>
                {#if !e.isDir}
                  {#if inShelf}
                    <span class="cloud-owned">{t("已在书架")}</span>
                  {:else}
                    <button
                      class="cloud-btn mini"
                      disabled={!!progress}
                      title={t("下载到本地书架")}
                      on:click={() => pull(e)}
                    ><span class="reword-shelf-ico">{@html SEL_ICONS.cloudFetch}</span>{t("下载")}</button>
                  {/if}
                {/if}
              </div>
            {/each}
          {/if}
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  /*
   * ===================== 面板观感（2026-11-15 重做） =====================
   *
   * 上一版「像线框稿」的根因：markup 用了 `panel-header / panel-title / panel-close`
   * 三个类名，但本组件的 `<style>` 里**一条规则都没写** —— 于是标题走浏览器默认 h2
   * （又大又粗、还带默认 margin），关闭按钮走默认描边方块。现在按 OpdsSearchPanel
   * 的同名规则补齐（那一套是本插件弹层的既有语法，不是新发明的）。
   *
   * 字号一律引用 `--rwd-fs-*` 令牌（定义在 settings-dialog.less 的共享选择器里，
   * 和阅读设置面板同一档），不再各处写 11/12/13 字面量：
   * 11px 的灰字既过不了可读性检查，也撑不起「精致」——说明文字统一走 hint 档 12px
   * 配 `--rwd-hint`（浅色 6:1、深色 8:1）。
   *
   * 圆角只有两档：控件 9px、方式卡片 10px；面板外壳的 12px 由 `.edit-panel` 给。
   */

  .cloud-panel {
    box-sizing: border-box;
    /* 680：字段收成「标签左栏 + 控件右栏」后不需要 720 那么宽，窄一点整屏更聚气 */
    width: min(680px, 92vw);
    max-height: 88vh;
    /* 面板自身不滚：头部固定，滚动交给 .cloud-form / .cloud-body */
    overflow: hidden;
    /*
     * 危险色不直接用 `--b3-theme-error`：思源浅色主题里它是 #e1717c，
     * 压在 12% 同色底上只有 2.7:1（harness 的对比度体检实测）。
     * 往正文色混 40% 后到 ~5:1，深色主题同理往浅色文字方向偏，两个主题都不糊。
     */
    --cloud-danger: color-mix(in srgb, var(--b3-theme-error, #e24b4a) 60%, var(--rwd-ink, #333));
  }

  /* ---- 头部（与 OpdsSearchPanel / StatsPanel 同一条语法） ---- */
  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.1));
  }
  .panel-title {
    font-size: 16px;
    font-weight: 600;
    color: var(--b3-theme-on-background, #333);
    margin: 0;
  }
  .panel-close {
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: var(--rwd-hover, rgba(0, 0, 0, 0.04));
    border-radius: 50%;
    font-size: 18px;
    line-height: 1;
    color: var(--b3-theme-on-surface-light, #666);
    cursor: pointer;
    transition: background 0.14s ease, color 0.14s ease;
  }
  .panel-close:hover {
    background: var(--rwd-hover2, rgba(0, 0, 0, 0.08));
    color: var(--rwd-ink, #333);
  }

  /* ---- 配置：组内紧（8px）、组间松（20px） ---- */
  .cloud-form {
    display: flex;
    flex-direction: column;
    gap: 20px;
    overflow-y: auto;
    min-height: 0;
    overscroll-behavior: contain;
  }
  .cloud-group {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .cloud-group-title {
    margin: 0;
    font-size: var(--rwd-fs-group, 12px);
    font-weight: 600;
    letter-spacing: 0.05em;
    color: var(--rwd-hint, #5f6368);
  }

  /* ---- 同步方式：分段控件 ---- */
  .cloud-kind {
    display: flex;
    gap: 3px;
    padding: 3px;
    border-radius: 10px;
    /* 底槽用凹槽色，选中块用面板底色浮起来 —— 不再靠边框区分选中 */
    background: var(--rwd-field, rgba(0, 0, 0, 0.05));
  }
  .cloud-kind-btn {
    flex: 1;
    min-width: 0;
    height: 32px;
    border: none;
    border-radius: 8px;
    background: none;
    cursor: pointer;
    font-family: inherit;
    font-size: var(--rwd-fs-ctrl, 13.5px);
    color: var(--rwd-ink2, #5f646d);
    transition: background 0.14s ease, color 0.14s ease;
  }
  .cloud-kind-btn:hover {
    color: var(--rwd-ink, #333);
  }
  .cloud-kind-btn.on {
    background: var(--b3-theme-background, #fff);
    color: var(--rwd-ink, #333);
    font-weight: 550;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
  }
  .cloud-kind-btn:focus-visible {
    outline: 2px solid var(--b3-theme-primary, #534ab7);
    outline-offset: 1px;
  }
  .cloud-kind-hint {
    margin: 0;
    font-size: var(--rwd-fs-hint, 12px);
    line-height: 1.5;
    color: var(--rwd-hint, #5f6368);
  }

  /* ---- 字段：标签左栏 + 控件右栏（和阅读设置面板的 RowControl 同一读法） ---- */
  .cloud-field {
    display: grid;
    grid-template-columns: 78px minmax(0, 1fr);
    align-items: center;
    gap: 12px;
    min-height: 38px;
    min-width: 0;
  }
  .cloud-field-label {
    font-size: var(--rwd-fs-value, 13px);
    color: var(--rwd-ink2, #5f646d);
  }
  /* 密码格：按钮压在字段内右侧，点击区域不额外挤动布局 */
  .cloud-field-box {
    position: relative;
    display: flex;
    min-width: 0;
  }
  .cloud-input {
    height: 34px;
    box-sizing: border-box;
    /* 100%：字段现在可能包在 .cloud-field-box（flex 行）里，不给宽度就会缩成默认长度 */
    width: 100%;
    min-width: 0;
    padding: 0 10px;
    border-radius: 9px;
    border: 1px solid transparent;
    /* 凹槽底：浅主题 5% 黑、深主题 7% 白，比「白底 + 1px 灰边」更贴合面板底色 */
    background: var(--rwd-field, rgba(0, 0, 0, 0.05));
    color: var(--rwd-ink, #333);
    font-size: var(--rwd-fs-ctrl, 13.5px);
    font-family: inherit;
    outline: none;
    transition: border-color 0.14s ease, background 0.14s ease;
  }
  .cloud-input::placeholder {
    color: var(--rwd-hint, #5f6368);
    opacity: 0.75;
  }
  .cloud-input:focus {
    border-color: var(--rwd-focus, var(--b3-theme-primary, #534ab7));
    background: var(--b3-theme-background, #fff);
  }
  .cloud-input.with-btn {
    padding-right: 56px;
  }
  .cloud-eye {
    position: absolute;
    right: 4px;
    height: 26px;
    padding: 0 8px;
    border: none;
    border-radius: 7px;
    background: none;
    cursor: pointer;
    font-family: inherit;
    font-size: var(--rwd-fs-seg, 12.5px);
    color: var(--rwd-ink2, #5f646d);
    white-space: nowrap;
  }
  .cloud-eye:hover {
    background: var(--rwd-hover, rgba(0, 0, 0, 0.04));
    color: var(--rwd-ink, #333);
  }
  .cloud-check {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--rwd-fs-ctrl, 13.5px);
    color: var(--rwd-ink2, #5f646d);
    cursor: pointer;
  }
  .cloud-check input {
    width: 15px;
    height: 15px;
    accent-color: var(--b3-theme-primary, #534ab7);
    cursor: pointer;
  }
  .cloud-note {
    margin: 0;
    display: flex;
    align-items: flex-start;
    gap: 7px;
    font-size: var(--rwd-fs-hint, 12px);
    line-height: 1.55;
    color: var(--rwd-hint, #5f6368);
  }
  /* 说明行前面那颗 i：和正文同色系，比一个 emoji 或图标更不打扰 */
  .cloud-note::before {
    content: "i";
    flex-shrink: 0;
    width: 14px;
    height: 14px;
    margin-top: 2px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: var(--rwd-field2, rgba(0, 0, 0, 0.14));
    color: var(--rwd-ink2, #5f646d);
    font-size: 9.5px;
    font-style: italic;
    font-weight: 600;
  }

  /* ---- 结果条 ---- */
  .cloud-msg {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding: 8px 10px;
    border-radius: 9px;
    font-size: var(--rwd-fs-value, 13px);
    line-height: 1.5;
    background: var(--rwd-field, rgba(0, 0, 0, 0.05));
    color: var(--rwd-ink, #333);
    word-break: break-word;
  }
  .cloud-msg.bad {
    background: color-mix(in srgb, var(--b3-theme-error, #e24b4a) 12%, transparent);
    color: var(--cloud-danger);
  }

  /* ---- 底部操作条：一条发丝线，主动作靠右，危险操作靠最左 ---- */
  .cloud-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    padding-top: 12px;
    border-top: 1px solid var(--rwd-line, rgba(0, 0, 0, 0.08));
  }
  .cloud-actions .danger {
    margin-right: auto;
  }

  /* ---- 按钮：ghost 是默认档，整屏只有「保存」是实心 ---- */
  .cloud-btn {
    height: 32px;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    padding: 0 14px;
    border: none;
    border-radius: 9px;
    background: none;
    color: var(--rwd-ink2, #5f646d);
    font-size: var(--rwd-fs-ctrl, 13.5px);
    font-family: inherit;
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.14s ease, color 0.14s ease;
  }
  .cloud-btn:hover {
    background: var(--rwd-hover, rgba(0, 0, 0, 0.04));
    color: var(--rwd-ink, #333);
  }
  .cloud-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .cloud-btn:disabled:hover {
    background: none;
    color: var(--rwd-ink2, #5f646d);
  }
  .cloud-btn.primary {
    background: var(--b3-theme-primary, #534ab7);
    color: var(--b3-theme-on-primary, #fff);
    font-weight: 550;
  }
  .cloud-btn.primary:hover {
    background: var(--b3-theme-primary-dark, #4a43a5);
    color: var(--b3-theme-on-primary, #fff);
  }
  .cloud-btn.danger {
    color: var(--cloud-danger);
  }
  .cloud-btn.danger:hover {
    background: color-mix(in srgb, var(--b3-theme-error, #e24b4a) 12%, transparent);
    color: var(--cloud-danger);
  }
  .cloud-btn.icon {
    width: 32px;
    padding: 0;
  }
  .cloud-btn.mini {
    height: 26px;
    padding: 0 10px;
    font-size: var(--rwd-fs-seg, 12.5px);
  }
  /* 「测试连接」→「测试中…」文案变长，预留宽度整条操作栏才不会横移 */
  .cloud-btn.test {
    min-width: 92px;
  }

  /* ---- 浏览 ---- */
  .cloud-body {
    display: flex;
    flex-direction: column;
    gap: 10px;
    overflow-y: auto;
    min-height: 0;
    overscroll-behavior: contain;
  }
  .cloud-toolbar {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .cloud-select {
    flex: 0 1 260px;
    min-width: 0;
  }
  .cloud-crumb {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px;
    font-size: var(--rwd-fs-hint, 12px);
    color: var(--rwd-hint, #5f6368);
  }
  .cloud-crumb-btn {
    border: none;
    background: none;
    padding: 3px 8px;
    border-radius: 7px;
    font-size: var(--rwd-fs-hint, 12px);
    font-family: inherit;
    color: var(--rwd-ink2, #5f646d);
    cursor: pointer;
    transition: background 0.14s ease, color 0.14s ease;
  }
  .cloud-crumb-btn:hover {
    background: var(--rwd-hover, rgba(0, 0, 0, 0.04));
    color: var(--rwd-ink, #333);
  }
  /* 当前层级：加粗 + 本色，不再给底色（列表行已有 hover 底，两层灰会糊） */
  .cloud-crumb-btn.on {
    color: var(--rwd-ink, #333);
    font-weight: 600;
  }
  .cloud-crumb-btn.up {
    margin-left: auto;
  }
  .cloud-crumb-sep {
    color: var(--rwd-hint, #5f6368);
    opacity: 0.7;
  }

  .cloud-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .cloud-row {
    display: grid;
    grid-template-columns: 16px minmax(0, 1fr) 64px auto;
    align-items: center;
    gap: 10px;
    min-height: 36px;
    padding: 0 6px;
    border-radius: 8px;
    font-size: var(--rwd-fs-value, 13px);
  }
  .cloud-row:hover {
    background: var(--rwd-hover, rgba(0, 0, 0, 0.04));
  }
  .cloud-ico {
    color: var(--rwd-hint, #5f6368);
  }
  .cloud-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--rwd-ink, #333);
    text-align: left;
    border: none;
    background: none;
    padding: 0;
    font-size: inherit;
    font-family: inherit;
    cursor: default;
  }
  .cloud-name.dir {
    cursor: pointer;
    font-weight: 600;
  }
  .cloud-name.dir:hover {
    color: var(--b3-theme-primary, #534ab7);
  }
  .cloud-size {
    text-align: right;
    color: var(--rwd-hint, #5f6368);
    font-size: var(--rwd-fs-hint, 12px);
    font-variant-numeric: tabular-nums;
  }
  .cloud-owned {
    font-size: var(--rwd-fs-hint, 12px);
    color: var(--b3-theme-success, #4caf7d);
    white-space: nowrap;
  }
  .cloud-empty {
    margin: 0;
    padding: 28px 8px;
    text-align: center;
    font-size: var(--rwd-fs-value, 13px);
    line-height: 1.7;
    color: var(--rwd-hint, #5f6368);
  }

  /* ---- 下载进度 ---- */
  .cloud-progress {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    border-radius: 10px;
    background: var(--rwd-field, rgba(0, 0, 0, 0.05));
    font-size: var(--rwd-fs-value, 13px);
  }
  .cloud-progress-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 12px;
    color: var(--rwd-ink, #333);
  }
  .cloud-progress-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .cloud-progress-num {
    flex-shrink: 0;
    font-size: var(--rwd-fs-hint, 12px);
    font-variant-numeric: tabular-nums;
    color: var(--rwd-hint, #5f6368);
  }
  .cloud-bar {
    height: 5px;
    border-radius: 999px;
    background: var(--rwd-field2, rgba(0, 0, 0, 0.1));
    overflow: hidden;
  }
  .cloud-bar-fill {
    height: 100%;
    border-radius: 999px;
    background: var(--b3-theme-primary, #534ab7);
    transition: width 0.2s ease;
  }
  .cloud-progress .cloud-btn {
    align-self: flex-end;
  }

  /* ---- 手机（≤600px）转底部 sheet，与 OpdsSearchPanel 同一档 ---- */
  /* 2026-11-19 P2-3：原 `@media (max-width:600px)`。
     本面板 use:portal 挂到 document.body，**不在** .reader-view/.bookshelf-view 子树里，
     拿不到 .re-phone，所以用 responsive.ts 投射到 body 的档位类 re-w600
     （语义等价 max-width:600px，唯一真源是 BREAKPOINTS.largePhone）。 */
  :global(body.re-w600) .cloud-panel {
    align-self: flex-end;
    width: 100vw;
    max-height: calc(100dvh - 24px);
    border-radius: 16px 16px 0 0;
  }
  /* 分段控件在窄屏仍排一行：两个标签都短，竖排白占高度 */
  /* 标签左栏在 390 宽里会挤掉控件宽度，折成上下排 */
  :global(body.re-w600) .cloud-field {
    grid-template-columns: minmax(0, 1fr);
    gap: 6px;
    min-height: 0;
  }
  :global(body.re-w600) .cloud-row {
    grid-template-columns: 16px minmax(0, 1fr) 56px auto;
    gap: 8px;
  }
  /* 操作栏在窄屏会挤成两行，危险操作换行后仍留在最左 */
  :global(body.re-w600) .cloud-actions {
    flex-wrap: wrap;
  }
</style>
