<script lang="ts">
  import { t } from "../i18n/index.ts";
  /**
   * OPDS 在线书源面板（B · 在线书源 / OPDS 搜书）
   * 使用 portal 挂载到 body，逃离 dock 裁剪，获得更宽的书目展示空间。
   */
  import { onMount, createEventDispatcher } from "svelte";
  import { portal } from "../utils/portal";
  import type { BookshelfStore } from "./bookshelf-store";
  import {
    BUILTIN_CATALOGS,
    fetchOpdsFeed,
    fetchOpdsDetail,
    searchOpds,
    fetchImageDataUrl,
    downloadAsFileWithProgress,
    validateOpdsCatalog,
    type OpdsCatalog,
    type OpdsEntry,
    type OpdsFeed,
    type OpdsDetail,
  } from "./opds-client";
  import { startOpdsAutoDownload, getAutoDlRunState, OPDS_AUTODL_KEY, type OpdsAutoDlRunState } from "./opds-auto";
  // 2026-10-11 美化 P1：目录卡片的 📁 与无封面兜底的 📖 换成书架那张生成表里的线性图标。
  // 彩色 emoji 不跟主题、在深色目录卡上会发灰，是这次要统一消灭的那一类。
  import { SEL_ICONS } from "./sel-icons.generated.ts";

  export let store: BookshelfStore;
  /** 打开书架中的书（由 BookshelfView 传入 onOpen；详情页「打开」按钮用） */
  export let onOpenBook: ((bookId: string) => void) | null = null;
  const dispatch = createEventDispatcher();

  const CAT_KEY = "reword-opds-catalogs";
  const ORDER_KEY = "reword-opds-order";

  let catalogs: OpdsCatalog[] = [];
  let activeId = "";
  let activeCatalog: OpdsCatalog | null = null;

  let stack: { url: string; title: string }[] = [];
  let feed: OpdsFeed | null = null;
  let loading = false;
  let error = "";

  let query = "";
  let coverMap: Record<string, string> = {};
  let importingId = "";
  let importingPct: number | null = null;
  let toast = "";

  let showManage = false;
  let fName = "";
  let fUrl = "";
  let fAuth = "";
  let fSearch = "";
  let fDesc = "";
  let fHeaders = "";
  /* 2026-10-15 阶段 2：书源连通性验证（参照 readest validateOPDSCatalog） */
  let validating = false;
  let validateMsg = "";
  let validateOk = false;
  /* 2026-10-15 阶段 3：排序 / 订阅自动下载 */
  let autoDl: Record<string, boolean> = {};
  let autoDlState: Record<string, OpdsAutoDlRunState> = {};

  async function testConnection() {
    const url = fUrl.trim();
    if (!url) {
      showToast(t("请先填写 OPDS 地址"));
      return;
    }
    validating = true;
    validateMsg = "";
    try {
      const r = await validateOpdsCatalog(url, fAuth.trim() || undefined);
      validateOk = r.valid;
      validateMsg = r.valid
        ? t("连接成功") + (r.title ? `：${r.title}` : "")
        : t("连接失败：") + (r.error || "");
    } finally {
      validating = false;
    }
  }

  /* ===== 2026-10-15 详情视图 + 防重复标识（参照 readest）===== */
  interface DetailState {
    entry: OpdsEntry;
    loading: boolean;
    error: string;
    downloads: { href: string; type?: string; label: string }[];
    meta: OpdsDetail | null;
    selIdx: number;
    busy: boolean;
    cover: string;
    /** 下载进度（0-100；null = 未知总量/未开始） */
    progress: number | null;
  }
  let detail: DetailState | null = null;
  let ownedTitles = new Set<string>();
  const normTitle = (s?: string) => (s || "").trim().toLowerCase();

  /** 列表渲染后异步比对书库 → 「✓已在书库」徽标（不阻塞首屏） */
  async function refreshOwned() {
    try {
      await store.load();
      ownedTitles = new Set(store.list.map((b) => normTitle(b.title)));
    } catch {
      ownedTitles = new Set();
    }
  }
  function isOwned(e: OpdsEntry): boolean {
    return ownedTitles.has(normTitle(e.title));
  }
  /** 打开书架中已入库的书（复用书架 onOpen 回调） */
  function openOwnedBook(title?: string) {
    const hit = store.list.find((b) => normTitle(b.title) === normTitle(title));
    if (!hit) {
      showToast(t("未在书架找到这本书"));
      return;
    }
    if (onOpenBook) {
      onOpenBook(hit.id);
      dispatch("close");
    } else {
      showToast(t("已在书架"));
    }
  }
  /** 点卡片 → 详情子视图：先展示列表内联数据，rel="self" 详情文档异步补全（readest #4749） */
  async function openDetail(e: OpdsEntry) {
    if (e.kind !== "publication") return;
    const fallback = e.downloads?.length
      ? e.downloads
      : e.download
        ? [{ href: e.download.href, type: e.download.type, label: "EPUB" }]
        : [];
    detail = { entry: e, loading: !!e.selfHref, error: "", downloads: fallback, meta: null, selIdx: 0, busy: false, cover: "", progress: null };
    if (!e.selfHref) return;
    try {
      const pub = await fetchOpdsDetail(e.selfHref, activeCatalog?.auth, activeCatalog?.customHeaders);
      let cover = pub.cover || "";
      if (cover && !coverMap[cover] && activeCatalog) {
        const d = await fetchImageDataUrl(cover, activeCatalog.auth);
        if (d) coverMap = { ...coverMap, [cover]: d };
      }
      if (detail && detail.entry === e) {
        detail = {
          ...detail,
          loading: false,
          meta: pub,
          downloads: pub.downloads.length ? pub.downloads : fallback,
          cover,
        };
      }
    } catch (err: any) {
      if (detail && detail.entry === e) {
        detail = { ...detail, loading: false, error: err?.message || String(err) };
      }
    }
  }
  function closeDetail() {
    detail = null;
  }
  /** 详情页「下载所选格式」：与 importEntry 同链路，成功后刷新防重复徽标并停留 */
  async function downloadDetail() {
    if (!detail || detail.busy) return;
    const d = detail.downloads[detail.selIdx] || detail.downloads[0];
    if (!d) return;
    if (/text\/html/i.test(d.type || "")) {
      try { window.open(d.href, "_blank"); } catch { /* 忽略 */ }
      return;
    }
    detail = { ...detail, busy: true, progress: null };
    try {
      const file = await downloadAsFileWithProgress(
        d.href,
        activeCatalog?.auth,
        detail.entry.title,
        (pct) => {
          if (detail) detail = { ...detail, progress: pct };
        },
        activeCatalog?.customHeaders
      );
      const meta = await store.importBook(file);
      if (meta) {
        showToast(t("已导入《{title}》", { title: detail.entry.title ?? "" }));
        await enrichImported(meta, detail.entry, detail.meta);
      } else {
        showToast(t("《{title}》已存在，跳过", { title: detail.entry.title ?? "" }));
      }
      await refreshOwned();
    } catch (err: any) {
      showToast(t("导入失败：") + (err?.message || err));
    } finally {
      if (detail) detail = { ...detail, busy: false };
    }
  }

  onMount(() => {
    loadCatalogs();
    // 2026-10-15 阶段 3：订阅自动下载调度器（模块级单例，面板关闭不影响）
    startOpdsAutoDownload(store);
  });

  function loadCatalogs() {
    let custom: OpdsCatalog[] = [];
    let order: string[] = [];
    let autoDlMap: Record<string, boolean> = {};
    try {
      const raw = localStorage.getItem(CAT_KEY);
      if (raw) custom = JSON.parse(raw);
    } catch {
      // ignore
    }
    try {
      const raw = localStorage.getItem(ORDER_KEY);
      if (raw) order = JSON.parse(raw);
    } catch {
      // ignore
    }
    try {
      const raw = localStorage.getItem(OPDS_AUTODL_KEY);
      if (raw) autoDlMap = JSON.parse(raw);
    } catch {
      // ignore
    }
    const all = [...BUILTIN_CATALOGS, ...custom];
    const idx = new Map(order.map((id, i) => [id, i] as const));
    catalogs = all.slice().sort(
      (a, b) => (idx.has(a.id) ? idx.get(a.id)! : Number.MAX_SAFE_INTEGER) - (idx.has(b.id) ? idx.get(b.id)! : Number.MAX_SAFE_INTEGER)
    );
    autoDl = autoDlMap;
    if (!activeId && catalogs.length) {
      activeId = catalogs[0].id;
      activeCatalog = catalogs[0];
    }
  }

  function persistOrder() {
    try {
      localStorage.setItem(ORDER_KEY, JSON.stringify(catalogs.map((c) => c.id)));
    } catch {
      // ignore
    }
  }

  /** 阶段 3：管理列表 ↑/↓ 排序（全部书源可排，顺序持久化） */
  function moveCatalog(id: string, dir: -1 | 1) {
    const i = catalogs.findIndex((c) => c.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= catalogs.length) return;
    const next = [...catalogs];
    [next[i], next[j]] = [next[j], next[i]];
    catalogs = next;
    persistOrder();
  }

  /** 阶段 3：订阅自动下载开关（持久化到 localStorage，调度器每轮读取） */
  function setAutoDl(id: string, on: boolean) {
    autoDl = { ...autoDl, [id]: on };
    try {
      localStorage.setItem(OPDS_AUTODL_KEY, JSON.stringify(autoDl));
    } catch {
      // ignore
    }
    autoDlState = getAutoDlRunState();
  }

  function autoDlText(id: string): string {
    const st = autoDlState[id];
    if (!st) return "";
    const d = new Date(st.ts);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${t("上次自动下载")}:${hh}:${mm} +${st.added}${st.failed ? ` / ${t("失败")}${st.failed}` : ""}`;
  }

  /** 阶段 3：自定义 Headers 文本（每行 Key: Value）→ 对象；空行/格式错误行忽略 */
  function parseHeadersText(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of (text || "").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.+)\s*$/);
      if (m) out[m[1]] = m[2].trim();
    }
    return out;
  }

  function saveCustom() {
    const custom = catalogs.filter((c) => !BUILTIN_CATALOGS.some((b) => b.id === c.id));
    try {
      localStorage.setItem(CAT_KEY, JSON.stringify(custom));
    } catch {
      // ignore
    }
  }

  function close() {
    dispatch("close");
  }

  function showToast(msg: string, ms = 3200) {
    toast = msg;
    setTimeout(() => {
      if (toast === msg) toast = "";
    }, ms);
  }

  async function openCatalog(c: OpdsCatalog) {
    activeCatalog = c;
    activeId = c.id;
    stack = [{ url: c.url, title: c.name }];
    await loadFeed(c.url, c.name);
  }

  async function loadFeed(url: string, title: string) {
    loading = true;
    error = "";
    try {
      const f = await fetchOpdsFeed(url, activeCatalog?.auth, activeCatalog?.customHeaders);
      feed = f;
      loadCovers(f);
      void refreshOwned();
    } catch (e: any) {
      error = e?.message || String(e);
      feed = null;
    } finally {
      loading = false;
    }
  }

  async function drillNav(e: OpdsEntry) {
    if (!e.href) return;
    stack = [...stack, { url: e.href, title: e.title || t("目录") }];
    await loadFeed(e.href, e.title || t("目录"));
  }

  function goBack(idx: number) {
    stack = stack.slice(0, idx + 1);
    const top = stack[stack.length - 1];
    void loadFeed(top.url, top.title);
  }

  async function doSearch() {
    if (!activeCatalog) return;
    const q = query.trim();
    if (!q) return;
    loading = true;
    error = "";
    try {
      const f = await searchOpds(activeCatalog, q, feed?.links);
      feed = f;
      stack = [{ url: activeCatalog.url, title: activeCatalog.name }, { url: "", title: `${t("搜索：")}${q}` }];
      loadCovers(f);
      void refreshOwned();
    } catch (e: any) {
      error = e?.message || String(e);
    } finally {
      loading = false;
    }
  }

  async function loadCovers(f: OpdsFeed) {
    for (const e of f.entries) {
      if (e.kind === "publication" && e.cover && !coverMap[e.cover]) {
        const url = e.cover;
        const auth = activeCatalog?.auth;
        fetchImageDataUrl(url, auth).then((d) => {
          if (d) coverMap = { ...coverMap, [url]: d };
        });
      }
    }
  }

  async function importEntry(e: OpdsEntry) {
    if (!e.download || !activeCatalog) return;
    importingId = e.id || e.title || "book";
    importingPct = null;
    try {
      const file = await downloadAsFileWithProgress(
        e.download.href,
        activeCatalog.auth,
        e.title,
        (pct) => (importingPct = pct),
        activeCatalog.customHeaders
      );
      const meta = await store.importBook(file);
      if (meta) {
        showToast(t("已导入《{title}》", { title: e.title ?? "" }));
        await enrichImported(meta, e);
      } else {
        showToast(t("《{title}》已存在，跳过", { title: e.title ?? "" }));
      }
    } catch (err: any) {
      showToast(t("导入失败：") + (err?.message || err));
    } finally {
      importingId = "";
      importingPct = null;
      void refreshOwned();
    }
  }

  async function addCatalog() {
    const name = fName.trim();
    const url = fUrl.trim();
    if (!name || !url) {
      showToast(t("请填写书源名称与地址"));
      return;
    }
    /* 2026-10-15 阶段 2：添加前自动连通性验证，失败不加入（readest 同语义） */
    validating = true;
    let check: Awaited<ReturnType<typeof validateOpdsCatalog>>;
    try {
      check = await validateOpdsCatalog(url, fAuth.trim() || undefined);
    } catch (err: any) {
      check = { valid: false, error: err?.message || String(err) };
    } finally {
      validating = false;
    }
    if (!check.valid) {
      validateOk = false;
      validateMsg = t("书源不可用：") + (check.error || "");
      showToast(t("书源不可用：") + (check.error || ""));
      return;
    }
    const id = "u_" + Date.now().toString(36);
    const customHeaders = parseHeadersText(fHeaders);
    catalogs = [
      ...catalogs,
      {
        id,
        name,
        url,
        auth: fAuth.trim() || undefined,
        searchTemplate: fSearch.trim() || undefined,
        description: fDesc.trim() || undefined,
        customHeaders: Object.keys(customHeaders).length ? customHeaders : undefined,
        autoDownload: false,
      },
    ];
    saveCustom();
    fName = fUrl = fAuth = fSearch = fDesc = fHeaders = "";
    validateMsg = "";
    showManage = false;
    showToast(t("已添加书源「{name}」", { name }));
  }

  /** 2026-10-15 阶段 2：导入成功后用书源元数据/封面补全书架条目（readest #5270：目录源优先），best-effort */
  async function enrichImported(
    bookMeta: { id: string },
    e: OpdsEntry,
    pub?: OpdsDetail | null
  ) {
    try {
      const coverHref = pub?.cover || e.cover || "";
      await store.enrichFromOpds(bookMeta.id, {
        title: pub?.title || e.title,
        author: pub?.author || e.author,
        coverDataUrl: coverHref ? coverMap[coverHref] : undefined,
      });
    } catch {
      // best-effort：补全失败不影响导入结果
    }
  }

  function removeCatalog(c: OpdsCatalog) {
    if (BUILTIN_CATALOGS.some((b) => b.id === c.id)) {
      showToast(t("内置书源不可删除"));
      return;
    }
    catalogs = catalogs.filter((x) => x.id !== c.id);
    saveCustom();
    // 阶段 3：同步清理订阅开关与排序
    if (autoDl[c.id] !== undefined) {
      const m = { ...autoDl };
      delete m[c.id];
      autoDl = m;
      try {
        localStorage.setItem(OPDS_AUTODL_KEY, JSON.stringify(autoDl));
      } catch {
        // ignore
      }
    }
    persistOrder();
  }

  function onCatalogChange(e: Event) {
    const c = catalogs.find((x) => x.id === (e.target as HTMLSelectElement).value);
    if (c) void openCatalog(c);
  }

  function truncate(s: string, n = 80): string {
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }
</script>

<div class="edit-mask" use:portal on:click|self={close}>
  <div class="edit-panel opds-panel">
    <header class="panel-header">
      <h2 class="panel-title">{t("在线书源")}</h2>
      <button class="panel-close" on:click={close} aria-label={t("关闭")}>×</button>
    </header>

    <!-- 工具栏 -->
    <div class="opds-toolbar">
      <select class="opds-select" bind:value={activeId} on:change={onCatalogChange}>
        {#each catalogs as c (c.id)}
          <option value={c.id}>{c.name}</option>
        {/each}
      </select>
      <input
        class="opds-search"
        placeholder={t("搜索书名 / 作者…")}
        bind:value={query}
        on:keydown={(e) => e.key === "Enter" && doSearch()}
      />
      <button class="opds-btn primary" on:click={doSearch}>{t("搜索")}</button>
      <button class="opds-btn" on:click={() => { showManage = !showManage; if (showManage) autoDlState = getAutoDlRunState(); }}>{t("管理")}</button>
    </div>

    {#if showManage}
      <div class="opds-manage">
        <div class="opds-cat-list">
          {#each catalogs as c (c.id)}
            <div class="opds-cat-row" title={c.description ? `${c.url} · ${c.description}` : c.url}>
              <span class="opds-move">
                <button class="opds-move-btn" title={t("上移")} on:click={() => moveCatalog(c.id, -1)}>↑</button>
                <button class="opds-move-btn" title={t("下移")} on:click={() => moveCatalog(c.id, 1)}>↓</button>
              </span>
              <span class="opds-cat-name">{c.name}</span>
              {#if c.description}<span class="opds-cat-desc">{c.description}</span>{/if}
              <label class="opds-autodl" title={t("书源有新书时自动下载入库（每次每源最多 3 本，每 6 小时检查一次）")}>
                <input type="checkbox" checked={autoDl[c.id] === true} on:change={(ev) => setAutoDl(c.id, ev.currentTarget.checked)} />
                {t("自动")}
              </label>
              {#if !BUILTIN_CATALOGS.some((b) => b.id === c.id)}
                <button class="opds-cat-del" title={t("删除")} on:click={() => removeCatalog(c)}>{t("删除")}</button>
              {:else}
                <span class="opds-cat-badge">{t("内置")}</span>
              {/if}
              {#if autoDl[c.id] === true && autoDlState[c.id]}
                <span class="opds-cat-lastrun">{autoDlText(c.id)}</span>
              {/if}
            </div>
          {/each}
        </div>
        <div class="opds-add">
          <input class="opds-in" placeholder={t("书源名称")} bind:value={fName} />
          <input class="opds-in" placeholder={t("OPDS 地址（含 http）")} bind:value={fUrl} />
          <input class="opds-in" placeholder={t("Basic Auth（可选）user:pass")} bind:value={fAuth} />
          <input class="opds-in" placeholder={t("搜索模板（可选，{q} 占位）")} bind:value={fSearch} />
          <input class="opds-in" placeholder={t("描述（可选）")} bind:value={fDesc} />
          <textarea
            class="opds-in opds-headers"
            rows="2"
            placeholder={t("自定义 Headers（可选，每行 Key: Value）")}
            bind:value={fHeaders}
          ></textarea>
          <div class="opds-add-actions">
            <button class="opds-btn" disabled={validating} on:click={testConnection}>
              {validating ? t("测试中…") : t("测试连接")}
            </button>
            <button class="opds-btn primary" disabled={validating} on:click={addCatalog}>
              {validating ? t("验证中…") : t("添加书源")}
            </button>
          </div>
          {#if validateMsg}
            <div class="opds-validate-msg" class:ok={validateOk}>{validateMsg}</div>
          {/if}
        </div>
      </div>
    {/if}

    {#if stack.length > 1}
      <nav class="opds-crumbs">
        {#each stack as crumb, i (i)}
          <button class="opds-crumb" class:active={i === stack.length - 1} on:click={() => goBack(i)}>
            {crumb.title || t("目录")}
          </button>
          {#if i < stack.length - 1}<span class="opds-crumb-sep">›</span>{/if}
        {/each}
      </nav>
    {/if}

    <!-- 内容 -->
    <div class="opds-body">
      {#if detail}
        <!-- 2026-10-15 书籍详情子视图（参照 readest PublicationView）：封面+元数据+格式选择 -->
        <div class="opds-detail">
          <div class="opds-detail-head">
            <button class="opds-btn" on:click={closeDetail}>← {t("返回")}</button>
            <span class="opds-detail-heading">{t("书籍详情")}</span>
            {#if isOwned(detail.entry)}
              <span class="opds-owned-badge">✓ {t("已在书库")}</span>
            {/if}
          </div>
          {#if detail.loading}
            <div class="opds-state">
              <div class="opds-spinner"></div>
              <div>{t("正在加载详情…")}</div>
            </div>
          {:else if detail.error}
            <div class="opds-state error">
              <div>{detail.error}</div>
            </div>
          {:else}
            <div class="opds-detail-main">
              <div class="opds-detail-cover">
                {#if detail.cover && coverMap[detail.cover]}
                  <img src={coverMap[detail.cover]} alt={detail.entry.title} />
                {:else if detail.entry.cover && coverMap[detail.entry.cover]}
                  <img src={coverMap[detail.entry.cover]} alt={detail.entry.title} />
                {:else}
                  <span class="opds-cover-text">{(detail.meta?.title || detail.entry.title || "").slice(0, 2)}</span>
                {/if}
              </div>
              <div class="opds-detail-meta">
                <div class="opds-card-title">{detail.meta?.title || detail.entry.title || t("（无标题）")}</div>
                {#if detail.meta?.author || detail.entry.author}
                  <div class="opds-card-author">{detail.meta?.author || detail.entry.author}</div>
                {/if}
                {#if detail.meta?.publisher}<div class="opds-meta-row">{t("出版：")}{detail.meta.publisher}</div>{/if}
                {#if detail.meta?.language}<div class="opds-meta-row">{t("语言：")}{detail.meta.language}</div>{/if}
                {#if detail.meta?.issued}<div class="opds-meta-row">{t("年份：")}{detail.meta.issued}</div>{/if}
                {#if detail.meta?.summary || detail.entry.summary}
                  <div class="opds-detail-sum">{truncate(detail.meta?.summary || detail.entry.summary, 260)}</div>
                {/if}
              </div>
            </div>
            {#if detail.downloads.length}
              <p class="opds-detail-label">{t("选择格式：")}</p>
              <div class="opds-fmt-row">
                {#each detail.downloads as d, i (d.href)}
                  <button
                    class="opds-fmt-chip"
                    class:active={i === detail.selIdx}
                    on:click={() => (detail = { ...detail, selIdx: i })}
                  >{d.label}</button>
                {/each}
              </div>
              <div class="opds-detail-actions">
                <button class="opds-btn primary" disabled={detail.busy} on:click={downloadDetail}>
                  {detail.busy
                    ? detail.progress != null
                      ? `${t("下载中")} ${detail.progress}%`
                      : t("导入中…")
                    : t("下载所选格式")}
                </button>
                {#if isOwned(detail.entry)}
                  <button class="opds-btn" on:click={() => openOwnedBook(detail.entry.title)}>
                    {t("打开书架中的书")}
                  </button>
                {/if}
              </div>
            {:else}
              <div class="opds-state">{t("该条目未提供可下载文件")}</div>
            {/if}
            <p class="opds-detail-note">{t("导入时自动用书源元数据/封面补全书架条目")}</p>
          {/if}
        </div>
      {:else if loading}
        <div class="opds-state">
          <div class="opds-spinner"></div>
          <div>{t("正在加载书源…")}</div>
        </div>
      {:else if error}
        <div class="opds-state error">
          <div>{error}</div>
          <button class="opds-btn" on:click={() => (error = "")}>{t("知道了")}</button>
        </div>
      {:else if feed}
        {#if !feed.entries.length}
          <div class="opds-state">{t("这个目录没有条目，返回上一级或换本书源")}</div>
        {:else}
          <div class="opds-grid">
            {#each feed.entries as e, i (e.kind + (e.href || e.id || e.title || i))}
              {#if e.kind === "navigation"}
                <button class="opds-card folder" on:click={() => drillNav(e)}>
                  <span class="opds-folder-icon reword-shelf-ico reword-shelf-ico--lg">{@html SEL_ICONS.group}</span>
                  <span class="opds-card-title">{e.title || t("（无标题）")}</span>
                  <span class="opds-card-arrow">›</span>
                </button>
              {:else}
                <div class="opds-card book" role="button" tabindex="0" on:click={() => openDetail(e)} on:keydown={(ev) => ev.key === "Enter" && openDetail(e)}>
                  {#if isOwned(e)}
                    <span class="opds-owned-badge">✓ {t("已在书库")}</span>
                  {/if}
                  <div class="opds-cover">
                    {#if e.cover && coverMap[e.cover]}
                      <img src={coverMap[e.cover]} alt={e.title} />
                    {:else}
                      <span class="opds-cover-text">{e.title?.slice(0, 2) || ""}</span>
                      {#if !e.title}
                        <span class="opds-cover-fallback reword-shelf-ico">{@html SEL_ICONS.bookFallback}</span>
                      {/if}
                    {/if}
                  </div>
                  <div class="opds-card-body">
                    <div class="opds-card-title" title={e.title}>{e.title || t("（无标题）")}</div>
                    {#if e.author}<div class="opds-card-author">{e.author}</div>{/if}
                    {#if e.summary}<div class="opds-card-sum">{truncate(e.summary, 120)}</div>{/if}
                    <div class="opds-card-actions">
                      {#if e.download}
                        {#if isOwned(e)}
                          <button
                            class="opds-btn"
                            title={t("已在书库，点击打开")}
                            on:click|stopPropagation={() => openOwnedBook(e.title)}
                          >{t("打开")}</button>
                        {:else}
                          <button
                            class="opds-btn primary"
                            disabled={!!importingId}
                            title={e.downloads?.length ? e.downloads.map((d) => d.label).join(" / ") : undefined}
                            on:click|stopPropagation={() => importEntry(e)}
                          >
                            {importingId === (e.id || e.title || "book")
                              ? importingPct != null
                                ? `${t("导入中")} ${importingPct}%`
                                : t("导入中…")
                              : t("导入书架")}
                          </button>
                        {/if}
                        {#if e.downloads && e.downloads.length > 1}
                          <span class="opds-fmt">{e.downloads.map((d) => d.label).slice(0, 3).join(" / ")}</span>
                        {/if}
                      {:else}
                        <span class="opds-no-dl">{t("不可下载")}</span>
                      {/if}
                    </div>
                  </div>
                </div>
              {/if}
            {/each}
          </div>
        {/if}
      {:else}
        <div class="opds-state">{t("选择上方书源开始浏览；或输入关键词搜索")}</div>
      {/if}
    </div>

    {#if toast}
      <div class="opds-toast">{toast}</div>
    {/if}
  </div>
</div>

<style>
  .opds-panel {
    width: min(720px, 92vw);
    max-height: 88vh;
  }
  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
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
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: var(--b3-theme-background-light, rgba(0, 0, 0, 0.04));
    border-radius: 50%;
    font-size: 18px;
    line-height: 1;
    color: var(--b3-theme-on-surface-light, #666);
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }
  .panel-close:hover {
    background: var(--b3-list-hover, rgba(0, 0, 0, 0.08));
    color: var(--b3-theme-on-background, #333);
  }
  .opds-toolbar {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .opds-select {
    max-width: 170px;
    flex-shrink: 0;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.15));
    border-radius: 8px;
    padding: 7px 10px;
    font-size: 12px;
    background: var(--b3-theme-background, #fff);
    color: var(--b3-theme-on-background, #333);
    outline: none;
  }
  .opds-select:focus {
    border-color: var(--b3-theme-primary, #534ab7);
  }
  .opds-search {
    flex: 1;
    min-width: 0;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.15));
    border-radius: 8px;
    padding: 7px 10px;
    font-size: 13px;
    background: var(--b3-theme-background, #fff);
    color: var(--b3-theme-on-background, #333);
    outline: none;
  }
  .opds-search:focus {
    border-color: var(--b3-theme-primary, #534ab7);
  }
  .opds-btn {
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.15));
    background: var(--b3-theme-background, #fff);
    border-radius: 8px;
    padding: 7px 14px;
    font-size: 12px;
    cursor: pointer;
    color: var(--b3-theme-on-background, #333);
    transition: background 0.15s, border-color 0.15s;
    flex-shrink: 0;
  }
  .opds-btn:hover {
    background: var(--b3-list-hover, rgba(0, 0, 0, 0.04));
  }
  .opds-btn.primary {
    background: var(--b3-theme-primary, #534ab7);
    border-color: transparent;
    color: var(--b3-theme-on-primary, #fff);
  }
  .opds-btn.primary:hover {
    filter: brightness(1.05);
  }
  .opds-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .opds-manage {
    display: flex;
    flex-direction: column;
    gap: 12px;
    background: var(--b3-theme-background-light, rgba(0, 0, 0, 0.03));
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.08));
    border-radius: 12px;
    padding: 12px;
  }
  .opds-cat-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 140px;
    overflow-y: auto;
  }
  .opds-cat-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 8px;
    border-radius: 6px;
    font-size: 12px;
  }
  .opds-cat-row:hover {
    background: var(--b3-theme-background, rgba(255, 255, 255, 0.6));
  }
  .opds-cat-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--b3-theme-on-background, #333);
  }
  .opds-cat-del {
    border: none;
    background: none;
    color: var(--b3-theme-error, #e24b4a);
    cursor: pointer;
    font-size: 11px;
    padding: 2px 6px;
  }
  .opds-cat-badge {
    font-size: 10px;
    color: var(--b3-theme-on-surface-light, #999);
    background: var(--b3-theme-background, rgba(255, 255, 255, 0.7));
    padding: 1px 6px;
    border-radius: 4px;
  }
  .opds-add {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .opds-add .opds-btn {
    grid-column: 1 / -1;
    justify-self: start;
  }
  .opds-in {
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.15));
    border-radius: 8px;
    padding: 7px 10px;
    font-size: 12px;
    background: var(--b3-theme-background, #fff);
    color: var(--b3-theme-on-background, #333);
    outline: none;
  }
  .opds-in:focus {
    border-color: var(--b3-theme-primary, #534ab7);
  }
  .opds-crumbs {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px;
    font-size: 12px;
  }
  .opds-crumb {
    border: none;
    background: none;
    cursor: pointer;
    color: var(--b3-theme-primary, #534ab7);
    padding: 3px 6px;
    border-radius: 5px;
    font-size: 12px;
  }
  .opds-crumb:hover {
    background: var(--b3-theme-primary-lightest, rgba(83, 74, 183, 0.08));
  }
  .opds-crumb.active {
    color: var(--b3-theme-on-background, #333);
    font-weight: 600;
    cursor: default;
    background: var(--b3-list-hover, rgba(0, 0, 0, 0.05));
  }
  .opds-crumb-sep {
    color: var(--b3-theme-on-surface-light, #bbb);
  }
  .opds-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding-right: 2px;
  }
  .opds-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 48px 0;
    text-align: center;
    font-size: 13px;
    color: var(--b3-theme-on-surface-light, #888);
  }
  .opds-state.error {
    color: var(--b3-theme-error, #e24b4a);
  }
  .opds-spinner {
    width: 22px;
    height: 22px;
    border: 2px solid var(--b3-border-color, rgba(0, 0, 0, 0.1));
    border-top-color: var(--b3-theme-primary, #534ab7);
    border-radius: 50%;
    animation: opds-spin 0.8s linear infinite;
  }
  @keyframes opds-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .opds-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 12px;
  }
  .opds-card {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    background: var(--b3-theme-background-light, rgba(0, 0, 0, 0.03));
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.06));
    border-radius: 12px;
    padding: 12px;
    text-align: left;
    transition: transform 0.1s, box-shadow 0.15s;
  }
  .opds-card:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.08);
  }
  .opds-card.folder {
    cursor: pointer;
    align-items: center;
  }
  /* 2026-10-11 图标换内联 SVG 后，尺寸归 .reword-shelf-ico--lg 管（全局样式），
     这里只负责它「比卡片文字更突出」的颜色——目录卡片是浅底，用主题次级色而不是写死灰 */
  .opds-folder-icon {
    color: var(--b3-theme-on-surface-light, #999);
  }
  .opds-card-arrow {
    margin-left: auto;
    font-size: 16px;
    color: var(--b3-theme-on-surface-light, #bbb);
  }
  .opds-cover {
    width: 52px;
    height: 74px;
    flex-shrink: 0;
    border-radius: 6px;
    overflow: hidden;
    background: linear-gradient(160deg, #3d6ea8, #1a3c66);
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.12);
  }
  .opds-cover img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .opds-cover-text {
    font-size: 12px;
    font-weight: 500;
    color: rgba(255, 255, 255, 0.95);
    text-align: center;
    padding: 0 4px;
    line-height: 1.2;
  }
  /* 无书名的条目用一本线描书本兜底。底色是上面那条**不随主题**的深蓝渐变占位封面，
     所以这里跟随同组的固定白，而不是 --b3-theme-on-primary；
     svg 拿不到 scoped 类名，靠 color 经 currentColor 传进去。 */
  .opds-cover-fallback {
    color: rgba(255, 255, 255, 0.95);
    opacity: 0.9;
  }
  .opds-card-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .opds-card-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--b3-theme-on-background, #333);
    line-height: 1.3;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .opds-card-author {
    font-size: 11px;
    color: var(--b3-theme-on-surface-light, #888);
  }
  .opds-card-sum {
    font-size: 11px;
    color: var(--b3-theme-on-surface-light, #999);
    line-height: 1.45;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .opds-card-actions {
    margin-top: 4px;
  }
  .opds-no-dl {
    font-size: 11px;
    color: var(--b3-theme-on-surface-light, #999);
  }
  .opds-toast {
    position: absolute;
    left: 50%;
    bottom: 16px;
    transform: translateX(-50%);
    background: rgba(30, 30, 30, 0.92);
    color: #fff;
    font-size: 12px;
    padding: 8px 16px;
    border-radius: 10px;
    z-index: 40;
    white-space: nowrap;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
  }

  /* ===== 2026-10-15 详情视图 + 防重复标识（参照 readest） ===== */
  .opds-card.book {
    cursor: pointer;
    position: relative;
  }
  .opds-owned-badge {
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 1;
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 10px;
    background: var(--b3-theme-success-lightest, rgba(59, 109, 17, 0.12));
    color: var(--b3-theme-success, #3b6d11);
  }
  .opds-fmt {
    font-size: 11px;
    color: var(--b3-theme-on-surface-light, #888);
  }
  .opds-detail-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
  }
  .opds-detail-heading {
    font-size: 14px;
    font-weight: 600;
    color: var(--b3-theme-on-background, #333);
  }
  .opds-detail-main {
    display: flex;
    gap: 14px;
  }
  .opds-detail-cover {
    width: 96px;
    height: 134px;
    flex-shrink: 0;
    border-radius: 6px;
    overflow: hidden;
    background: var(--b3-theme-background-light, rgba(0, 0, 0, 0.04));
  }
  .opds-detail-cover img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .opds-detail-cover .opds-cover-text {
    font-size: 22px;
  }
  .opds-detail-meta {
    min-width: 0;
    flex: 1;
  }
  .opds-meta-row {
    font-size: 12px;
    color: var(--b3-theme-on-surface-light, #888);
    margin-top: 2px;
  }
  .opds-detail-sum {
    font-size: 12px;
    color: var(--b3-theme-on-surface, #444);
    margin-top: 6px;
    line-height: 1.6;
  }
  .opds-detail-label {
    font-size: 12px;
    color: var(--b3-theme-on-surface-light, #888);
    margin: 12px 0 6px;
  }
  .opds-fmt-row {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .opds-fmt-chip {
    font-size: 12px;
    padding: 4px 14px;
    border-radius: 14px;
    border: 0.5px solid var(--b3-border-color, rgba(0, 0, 0, 0.1));
    background: transparent;
    color: var(--b3-theme-on-surface, #444);
    cursor: pointer;
  }
  .opds-fmt-chip.active {
    background: var(--b3-theme-primary-lightest, rgba(53, 117, 240, 0.1));
    color: var(--b3-theme-primary, #3575f0);
    border-color: var(--b3-theme-primary-light, #85b7eb);
  }
  .opds-detail-actions {
    display: flex;
    gap: 8px;
    margin-top: 12px;
  }
  .opds-detail-note {
    font-size: 11px;
    color: var(--b3-theme-on-surface-light, #999);
    margin: 10px 0 0;
  }
  /* 阶段 3：排序 / 订阅自动下载 / 自定义 Headers */
  .opds-move {
    display: inline-flex;
    flex-direction: column;
    gap: 0;
    flex-shrink: 0;
  }
  .opds-move-btn {
    border: none;
    background: transparent;
    color: var(--b3-theme-on-surface-light, #999);
    font-size: 10px;
    line-height: 1;
    padding: 0 2px;
    cursor: pointer;
  }
  .opds-move-btn:hover {
    color: var(--b3-theme-primary, #3575f0);
  }
  .opds-autodl {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 11px;
    color: var(--b3-theme-on-surface-light, #888);
    cursor: pointer;
    flex-shrink: 0;
  }
  .opds-cat-lastrun {
    font-size: 11px;
    color: var(--b3-theme-on-surface-light, #999);
    margin-left: auto;
  }
  .opds-headers {
    resize: vertical;
    font-family: var(--b3-font-family-mono, monospace);
    font-size: 11px;
  }
  /* 阶段 2：书源验证 + 描述 */
  .opds-add-actions {
    display: flex;
    gap: 8px;
  }
  .opds-validate-msg {
    font-size: 12px;
    color: var(--b3-theme-error, #d23b3b);
    word-break: break-all;
  }
  .opds-validate-msg.ok {
    color: var(--b3-theme-success, #3b6d11);
  }
  .opds-cat-desc {
    font-size: 11px;
    color: var(--b3-theme-on-surface-light, #999);
    margin-left: 8px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }
</style>
