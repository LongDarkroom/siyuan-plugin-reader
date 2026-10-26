<script lang="ts">
  /**
   * 阅读器 - 书架面板
   * 封面（EPUB 真实封面 / 占位）、导入（多选 + 拖拽 + 批量进度 + 去重 + 失败汇总重试）、
   * 续读、删除、编辑信息（书名/作者）。
   */
  import { onMount, onDestroy, tick } from "svelte";
  // 2026-10-24 移动端适配 Phase 1/3：响应式视口状态（根节点状态类 + 手机端交互分支）
  import { viewport, isPhoneBreakpoint } from "../core/viewport-store.ts";
  import type {
    BookshelfStore,
    BookMeta,
    BookGroup,
    BookStatus,
    BookColor,
    BookSortKey,
    SortDir,
  } from "../reader/bookshelf-store";
  import { BOOK_COLORS, isValidBookColor } from "../reader/bookshelf-store";
  import { isSupportedBookFile } from "../reader/book-adapters";
  import ReadingStatsPanel from "./ReadingStatsPanel.svelte";
  import OpdsSearchPanel from "./OpdsSearchPanel.svelte";
  import GraphPanel from "./GraphPanel.svelte";
  import BookshelfContextMenu, { type MenuItem } from "./bookshelf-context-menu.svelte";
  // 2026-09-11 多语言：中文原文即 key；t 被局部变量遮蔽的作用域改用别名 T
  import { t, t as T } from "../i18n/index";
  // 2026-10-10：键盘共用层 + 提示面板共用组件（与 ReaderView 共用）
  import { getHintPayload, bindGlobalShortcutHint } from "./keyboard-shared.ts";
  import ReaderHint from "./ReaderHint.svelte";
  // 2026-10-11 美化 P1：书架图标改用与划词工具栏同一张生成表（构建期内联的 Tabler SVG）。
  // emoji 的三个问题：跨平台形状不同、彩色 emoji 不跟主题、笔画粗细不可控。
  import { SEL_ICONS } from "./sel-icons.generated.ts";

  export let store: BookshelfStore;
  export let onOpen: (bookId: string) => void;
  /**
   * 打开「选择笔记发送目标」弹窗（2026-10-09 新增）。
   *
   * 由宿主（`reader-dock.ts`）注入 —— 书架本身不加载思源 API，
   * 也不该知道 settings 从哪来。**依赖倒置**：宿主注入能力，
   * 组件只负责在右键菜单里加一项并把选中的 docId 传回去。
   *
   * ⚠️ 传null 时菜单项显示为不可用（而不是隐藏）——
   *   隐藏会让用户以为"这个功能不存在"。
   */
  export let onPickNotebookTarget:
    | ((bookId: string, done: (t: { docId: string; docTitle?: string; notebookName?: string } | null) => void) => void)
    | null = null;
  /**
   * 按书名自动建档（2026-10-10 新增，方案 B）。
   *
   * 同样**依赖倒置**：由宿主（`reader-dock.ts`）注入，书架只负责在右键菜单
   * 加一项并把 bookId 传回去；建档/落盘由宿主完成。
   * `done(ok)` 在流程结束后回调（宿主据此可刷新/提示）。
   */
  export let onAutoBind: ((bookId: string, done: (ok: boolean) => void) => void) | null = null;

  let books: BookMeta[] = [];
  let fileInput: HTMLInputElement;
  let importing = false;
  let importError = "";
  let coverUrls: Record<string, string> = {};
  // [2026-08-29] P2:续读最近一本的 id + 标题(顶栏 ⏵ 按钮用)
  let continueReadId = "";
  let continueReadTitle = "";

  // [2026-08-29] P2:右键菜单(x/y/items;null = 关闭)
  let ctxMenu: { x: number; y: number; items: MenuItem[] } | null = null;
  function openCtxMenu(e: MouseEvent, items: MenuItem[]) {
    e.preventDefault();
    e.stopPropagation();
    ctxMenu = { x: e.clientX, y: e.clientY, items };
  }
  function closeCtxMenu() {
    ctxMenu = null;
  }

  /* ================================================================
   * 2026-10-24 移动端适配 Phase 3：书卡触屏化
   * 2026-10-25 防误触改造（C3，真机反馈"滑动不流畅且误触"）：
   *  - **任何位移都取消长按**（旧实现 10px 内的慢速滑动起步会被累计成
   *    "静止 500ms" 弹菜单——误触主源之一）；长按语义收敛为"按住不动"。
   *  - 计时 500→550ms；弹出时轻震反馈（Android；iOS 无 API，静默降级）。
   * ================================================================ */
  $: isPhoneBp = isPhoneBreakpoint($viewport.breakpoint);
  let lpTimer: ReturnType<typeof setTimeout> | null = null;
  let lpFired = false;
  function onCardTouchStart(e: TouchEvent, items: MenuItem[]) {
    if (!isPhoneBp) return;
    if (lpTimer) clearTimeout(lpTimer);
    lpFired = false;
    const x = e.touches[0]?.clientX ?? 0;
    const y = e.touches[0]?.clientY ?? 0;
    lpTimer = setTimeout(() => {
      lpTimer = null;
      lpFired = true;
      try { navigator.vibrate?.(10); } catch { /* iOS 无此 API */ }
      ctxMenu = { x, y, items };
    }, 550);
  }
  function onCardTouchMove() {
    // 2026-10-25 C3：任何位移立即取消——不再有 10px 容差（慢滑不再误弹菜单）
    if (lpTimer) {
      clearTimeout(lpTimer);
      lpTimer = null;
    }
  }
  function onCardTouchEnd(e: TouchEvent) {
    if (lpTimer) {
      clearTimeout(lpTimer);
      lpTimer = null;
    }
    // 长按已弹出菜单：吞掉随后的合成 click，避免封面按钮把书打开
    if (lpFired) {
      e.preventDefault();
      lpFired = false;
    }
  }

  /* ================================================================
   * 2026-08-29 书架 P0/P1：搜索 / 排序 / 视图 / 分组 / 标签 / 批量
   * ================================================================ */

  /** UI 偏好持久化（localStorage，与书架数据解耦，坏数据不影响书架） */
  const UI_KEY = "reword-bookshelf-ui";

  let viewMode: "grid" | "list" = "grid";
  let sortKey: BookSortKey = "lastRead";
  let sortDir: SortDir = "desc";
  let sidebarOpen = true;

  /**
   * 侧栏宽度（可拖拽）。上限不是常量：拖到主区放不下卡片没有意义，
   * clampSideWidth() 会按 .bookshelf-body 实际宽度再收一道。
   */
  const SIDE_W_MIN = 160;
  const SIDE_W_MAX = 360;
  const SIDE_W_DEFAULT = 200;
  /** 拖动时给右侧内容区保留的最小宽度 */
  const SHELF_MAIN_MIN = 240;

  let sideWidth = SIDE_W_DEFAULT;
  let sideResizing = false;
  let shelfBodyEl: HTMLDivElement | undefined;
  let dragStart = { x: 0, w: SIDE_W_DEFAULT };

  let keyword = "";
  let filterStatus: BookStatus | "all" = "all";
  let filterFormat = "all";
  let filterTag = "";
  /** "all" | "ungrouped" | 具体 groupId */
  let filterGroup = "all";
  let favoriteOnly = false;
  /** 2026-08-29 P2:颜色筛选("" = 不限) */
  let filterColor: BookColor | "" = "";
  /** 2026-08-29 P2:丛书筛选("" = 不限) */
  let filterSeries = "";

  /** 侧栏分组折叠状态（仅视觉收起，不影响筛选逻辑） */
  let collapsed: Record<string, boolean> = {};
  function toggleBlock(key: string) {
    collapsed[key] = !collapsed[key];
    collapsed = collapsed;
  }

  /** 阅读统计面板开关（A · 阅读统计可视化） */
  let showStats = false;
  /** OPDS 在线书源面板开关（B · 在线书源 / OPDS 搜书） */
  let showOpds = false;
  /** 阅读知识图谱面板开关（C · 图谱 / 画布联动） */
  let showGraph = false;

  // 批量选择模式
  let selectMode = false;
  let selectedIds: string[] = [];

  // 拖书入组的高亮目标
  let dropGroupId = "";

  const STATUS_LABEL: Record<BookStatus, string> = {
    unread: t("想读"),
    reading: t("在读"),
    finished: t("读完"),
  };

  /** 状态文本，坏数据兜底防止标签空白 */
  function statusLabel(s: BookStatus | undefined): string {
    return STATUS_LABEL[s ?? "unread"] ?? t("想读");
  }

  /** 状态循环顺序（卡片角标点击 + 侧栏智能分组共用） */
  const STATUS_ORDER: BookStatus[] = ["unread", "reading", "finished"];

  const SORT_OPTIONS: { key: BookSortKey; label: string }[] = [
    { key: "lastRead", label: t("最近阅读") },
    { key: "addedAt", label: t("添加时间") },
    { key: "title", label: t("书名") },
    { key: "author", label: t("作者") },
    { key: "progress", label: t("阅读进度") },
    { key: "readingTime", label: t("阅读时长") },
    { key: "rating", label: t("评分") },
    { key: "size", label: t("文件大小") },
    // [2026-08-29] P2:按颜色排序(色相 HSL 顺序:红→橙→黄→绿→蓝→紫→灰)
    { key: "color", label: t("颜色") },
  ];

  /** 颜色 token → 已本地化色名（BOOK_COLORS.label 是中文显示名，命中不到回退空串） */
  function colorLabel(token: BookColor | undefined): string {
    const hit = BOOK_COLORS.find((x) => x.token === token);
    return hit ? t(hit.label) : "";
  }

  /** 侧栏分面数据：依赖 books 变化重算（单一 helper，避免多个 $: 各自失效） */
  function computeFacets(_b: BookMeta[]) {
    void _b;
    return {
      // 分组计数在此一次算好：模板里直接调 store API 不会被 Svelte 追踪，会显示过期数字
      groups: store.groups.map((g) => ({ ...g, count: store.groupCount(g.id) })),
      tags: store.tagCounts(),
      formats: store.formatCounts(),
      status: store.statusCounts(),
      favorites: store.favoriteCount(),
      ungrouped: store.ungroupedCount(),
      // [2026-08-29] P2:颜色 / 丛书 facets
      colors: store.colorCounts(),
      series: store.seriesCounts(),
    };
  }
  $: facets = computeFacets(books);

  /**
   * 可见书籍：搜索 + 筛选 + 排序
   * 依赖全部以形参显式传入，确保 Svelte 静态分析能追踪到每个依赖
   */
  function computeVisible(
    _b: BookMeta[],
    kw: string,
    st: BookStatus | "all",
    fmt: string,
    tag: string,
    grp: string,
    fav: boolean,
    col: BookColor | "",
    ser: string,
    sk: BookSortKey,
    sd: SortDir
  ): BookMeta[] {
    void _b;
    // [2026-08-29] P2:丛书筛选在 store.query 不支持(避免对 store 内部改),在 UI 层过滤
    let list = store.query(
      {
        keyword: kw,
        status: st,
        format: fmt,
        tag: tag || undefined,
        groupId: grp,
        favoriteOnly: fav,
        color: col || undefined,
      },
      sk,
      sd
    );
    if (ser) list = list.filter((b) => (b.series ?? "").trim() === ser);
    return list;
  }
  $: visible = computeVisible(
    books,
    keyword,
    filterStatus,
    filterFormat,
    filterTag,
    filterGroup,
    favoriteOnly,
    filterColor,
    filterSeries,
    sortKey,
    sortDir
  );

  /** 是否存在任何生效的筛选（用于显示「清除筛选」） */
  $: hasFilter =
    !!keyword.trim() ||
    filterStatus !== "all" ||
    filterFormat !== "all" ||
    !!filterTag ||
    filterGroup !== "all" ||
    !!filterColor ||
    !!filterSeries ||
    favoriteOnly;

  function loadUiPrefs() {
    try {
      const raw = localStorage.getItem(UI_KEY);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (p.viewMode === "grid" || p.viewMode === "list") viewMode = p.viewMode;
      if (typeof p.sortKey === "string" && SORT_OPTIONS.some((o) => o.key === p.sortKey)) sortKey = p.sortKey;
      if (p.sortDir === "asc" || p.sortDir === "desc") sortDir = p.sortDir;
      if (typeof p.sidebarOpen === "boolean") sidebarOpen = p.sidebarOpen;
      if (typeof p.sideWidth === "number" && isFinite(p.sideWidth)) sideWidth = clampSideWidth(p.sideWidth);
      if (typeof p.sideWidth === "number" && isFinite(p.sideWidth)) {
        sideWidth = clampSideWidth(p.sideWidth);
      }
    } catch {
      // 坏数据忽略，用默认值
    }
  }

  function saveUiPrefs() {
    try {
      localStorage.setItem(UI_KEY, JSON.stringify({ viewMode, sortKey, sortDir, sidebarOpen, sideWidth }));
    } catch {
      // 存储不可用（隐私模式等）不影响功能
    }
  }

  function setViewMode(m: "grid" | "list") {
    viewMode = m;
    saveUiPrefs();
  }

  function toggleSortDir() {
    sortDir = sortDir === "desc" ? "asc" : "desc";
    saveUiPrefs();
  }

  function onSortKeyChange(e: Event) {
    sortKey = (e.target as HTMLSelectElement).value as BookSortKey;
    saveUiPrefs();
  }

  function toggleSidebar() {
    sidebarOpen = !sidebarOpen;
    saveUiPrefs();
  }

  /* ---- 侧栏宽度拖拽（2026-10-11）---- */

  function clampSideWidth(w: number) {
    const avail = shelfBodyEl?.clientWidth ?? 0;
    // avail=0（侧栏收起 / 还没挂载）时只按常量夹
    const max = avail > 0 ? Math.min(SIDE_W_MAX, avail - SHELF_MAIN_MIN) : SIDE_W_MAX;
    return Math.round(Math.min(Math.max(w, SIDE_W_MIN), Math.max(SIDE_W_MIN, max)));
  }

  function sideResizeStart(e: PointerEvent) {
    dragStart = { x: e.clientX, w: sideWidth };
    sideResizing = true;
    const el = e.currentTarget as HTMLElement;
    // 捕获后 move/up 都回到这个把手上，指针滑出 dock 边界也不丢事件
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // 捕获失败就退化成普通拖动
    }
  }

  function sideResizeMove(e: PointerEvent) {
    if (!sideResizing) return;
    sideWidth = clampSideWidth(dragStart.w + (e.clientX - dragStart.x));
  }

  function sideResizeEnd() {
    if (!sideResizing) return;
    sideResizing = false;
    saveUiPrefs();
  }

  function sideResizeKey(e: KeyboardEvent) {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      sideWidth = clampSideWidth(sideWidth + (e.key === "ArrowRight" ? 16 : -16));
      saveUiPrefs();
    } else if (e.key === "Home") {
      e.preventDefault();
      sideWidth = SIDE_W_DEFAULT;
      saveUiPrefs();
    }
  }

  function sideResizeReset() {
    sideWidth = SIDE_W_DEFAULT;
    saveUiPrefs();
  }

  function clearFilters() {
    keyword = "";
    filterStatus = "all";
    filterFormat = "all";
    filterTag = "";
    filterGroup = "all";
    favoriteOnly = false;
    // [2026-08-29] P2:颜色 / 丛书筛选也清
    filterColor = "";
    filterSeries = "";
  }

  interface FilterChip {
    key: string;
    /** 直接存 SVG 源码（同右键菜单的 MenuItem.icon），模板里 {@html} 一次到位 */
    icon: string;
    label: string;
    clear: () => void;
  }

  /** 生效中的筛选 → chip 行数据（key 稳定，clear 只清这一项）。
      [2026-10-11 B2] 八处散落的筛选 let 收成一个派生数组 ——
      否则胶囊上 ✕ 的「清掉单个」要把八个 setter 各写一遍。 */
  $: activeFilters = buildActiveFilters();

  function buildActiveFilters(): FilterChip[] {
    const out: FilterChip[] = [];
    if (keyword.trim()) {
      out.push({ key: "kw", icon: SEL_ICONS.search, label: t("搜索：{v}", { v: keyword.trim() }), clear: () => (keyword = "") });
    }
    if (favoriteOnly) {
      out.push({ key: "fav", icon: SEL_ICONS.fav, label: t("收藏"), clear: () => (favoriteOnly = false) });
    }
    if (filterStatus !== "all") {
      out.push({ key: "status", icon: SEL_ICONS.status, label: statusLabel(filterStatus), clear: () => (filterStatus = "all") });
    }
    if (filterGroup !== "all") {
      const g = facets.groups.find((x) => x.id === filterGroup);
      out.push({
        key: "group",
        icon: filterGroup === "ungrouped" ? SEL_ICONS.ungrouped : SEL_ICONS.group,
        label: filterGroup === "ungrouped" ? t("未分组") : g?.name ?? t("我的分组"),
        clear: () => (filterGroup = "all"),
      });
    }
    if (filterTag) {
      out.push({ key: "tag", icon: SEL_ICONS.tags, label: `#${filterTag}`, clear: () => (filterTag = "") });
    }
    if (filterSeries) {
      out.push({
        key: "series",
        icon: SEL_ICONS.allBooks,
        label: t("丛书：{v}", { v: filterSeries }),
        clear: () => (filterSeries = ""),
      });
    }
    if (filterColor) {
      out.push({ key: "color", icon: SEL_ICONS.palette, label: colorLabel(filterColor), clear: () => (filterColor = "") });
    }
    if (filterFormat !== "all") {
      out.push({ key: "format", icon: SEL_ICONS.bookFallback, label: filterFormat.toUpperCase(), clear: () => (filterFormat = "all") });
    }
    return out;
  }

  /** 2026-10-13 书架改版（拍板）：hero 续读卡下线 —— 整架书（含最近在读那本）
      统一进网格，不再占一条横贯全宽的横条；继续读入口留在顶栏 ⏵ 与封面悬停层。 */

  /** 侧栏：选中某个「视图」（互斥切换，避免多条件叠加后一本书都不剩） */
  function pickScope(scope: "all" | "favorite" | "ungrouped") {
    filterGroup = scope === "ungrouped" ? "ungrouped" : "all";
    favoriteOnly = scope === "favorite";
    filterStatus = "all";
    filterTag = "";
  }

  function pickStatus(s: BookStatus) {
    filterStatus = filterStatus === s ? "all" : s;
  }

  function pickGroup(id: string) {
    filterGroup = filterGroup === id ? "all" : id;
    favoriteOnly = false;
  }

  /** [2026-08-29] P2:颜色筛选(互斥切换) */
  function pickColor(c: BookColor) {
    filterColor = filterColor === c ? "" : c;
  }

  /** [2026-08-29] P2:丛书筛选(互斥切换) */
  function pickSeries(s: string) {
    filterSeries = filterSeries === s ? "" : s;
  }

  function pickTag(t: string) {
    filterTag = filterTag === t ? "" : t;
  }

  function pickFormat(f: string) {
    filterFormat = filterFormat === f ? "all" : f;
  }

  // 批量导入状态
  let importDone = 0;
  let importTotal = 0;
  let currentName = "";
  let importSkipped = 0;
  let toast = "";

  // 拖拽状态
  let dragCounter = 0;
  let dragging = false;

  // 失败汇总（file 供重试）
  interface ImportFail {
    name: string;
    reason: string;
    file: File;
  }
  let fails: ImportFail[] = [];

  // 编辑信息弹窗
  let editTarget: BookMeta | null = null;
  let editTitle = "";
  let editAuthor = "";
  // [2026-08-29] 扩展字段
  let editSeries = "";
  let editStatus: BookStatus = "unread";
  let editRating = 0;
  let editFavorite = false;
  let editTags: string[] = [];
  let editTagInput = "";
  let editGroupId = "";
  // [2026-08-29] P2:颜色(BookColor | undefined;undefined = 无色)
  let editColor: BookColor | undefined = undefined;
  let coverInput: HTMLInputElement;
  let coverBusy = false;

  // 删除确认弹窗（默认保留源文件）
  let removeTarget: BookMeta | null = null;
  let removeWithFile = false;
  /** 批量删除确认（与单本共用样式，target 为 null 时看这个） */
  let batchRemoveOpen = false;

  // 分组管理弹窗
  let groupDialogOpen = false;
  let newGroupName = "";
  let renamingGroupId = "";
  let renamingGroupName = "";
  let renamingInput: HTMLInputElement;
  /** 取消按钮 mousedown 时阻止 blur 提交；click 后再恢复 */
  let renameBlurCommit = true;
  // [2026-08-29] P2:分组色点 popover 状态(id = 当前展开的分组)
  let groupColorPickerId = "";
  function toggleGroupColorPicker(id: string) {
    groupColorPickerId = groupColorPickerId === id ? "" : id;
  }

  // 批量加标签弹窗
  let batchTagOpen = false;
  let batchTagName = "";

  const ACCEPT = ".epub,.mobi,.azw3,.fb2,.cbz,.pdf,.txt,.md,.markdown";
  const MB = 1024 * 1024;

  function fmtSize(n: number): string {
    return n >= MB ? `${(n / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
  }

  /**
   * 已加载封面对应的 cover 路径快照
   * 用途：替换封面后路径变化（带时间戳）→ 自动重取，避免显示旧图
   */
  let coverPaths: Record<string, string> = {};

  function loadCovers(list: BookMeta[]) {
    for (const b of list) {
      if (!b.cover) continue;
      if (coverPaths[b.id] === b.cover) continue;
      // 路径变了：先回收旧 URL 防泄漏
      const old = coverUrls[b.id];
      if (old) {
        try {
          URL.revokeObjectURL(old);
        } catch {
          // ignore
        }
      }
      coverPaths = { ...coverPaths, [b.id]: b.cover };
      store
        .getCoverBlob(b.id)
        .then((blob) => {
          if (blob) {
            coverUrls = { ...coverUrls, [b.id]: URL.createObjectURL(blob) };
          }
        })
        .catch(() => {});
    }
  }

  async function refresh() {
    await store.load();
    books = store.list;
    // 加载真实封面（EPUB/PDF 提取或用户替换；TXT/MD 无封面保持首字占位）
    loadCovers(books);
    // [2026-08-29] P2:同步续读最近一本(顶栏 ⏵ 按钮)
    const cid = store.getContinueReadId();
    continueReadId = cid ?? "";
    continueReadTitle = cid ? store.get(cid)?.title ?? "" : "";
  }

  function fmtDate(ms: number | undefined): string {
    if (!ms) return "";
    const d = new Date(ms);
    return t("{m}月{d}日", { m: d.getMonth() + 1, d: d.getDate() });
  }

  function fmtPct(frac: number | undefined): string {
    if (typeof frac !== "number" || !isFinite(frac)) return t("未读");
    return `${Math.min(100, Math.round(frac * 100))}%`;
  }

  function showToast(msg: string, ms = 3200) {
    toast = msg;
    setTimeout(() => {
      if (toast === msg) toast = "";
    }, ms);
  }

  /** 批量导入核心（文件列表 → 逐本导入，推进进度） */
  async function runImport(files: File[]) {
    const list = Array.from(files);
    if (!list.length) return;
    importing = true;
    importError = "";
    importDone = 0;
    importTotal = list.length;
    importSkipped = 0;
    fails = [];
    for (const f of list) {
      currentName = f.name;
      if (!isSupportedBookFile(f.name)) {
        fails.push({ name: f.name, reason: t("不支持的文件类型"), file: f });
        importDone++;
        continue;
      }
      try {
        const meta = await store.importBook(f);
        if (!meta) {
          importSkipped++;
        }
      } catch (e: any) {
        fails.push({ name: f.name, reason: e?.message || String(e), file: f });
      }
      importDone++;
    }
    importing = false;
    currentName = "";
    fileInput.value = "";
    await refresh();
    const ok = importTotal - importSkipped - fails.length;
    const parts: string[] = [];
    const sep = t("，");
    if (ok > 0) parts.push(t("导入 {n} 本", { n: ok }));
    if (importSkipped > 0) parts.push(t("跳过重复 {n} 本", { n: importSkipped }));
    if (fails.length) {
      showToast(parts.join(sep) + t("，失败 {n} 本", { n: fails.length }));
    } else if (parts.length) {
      showToast(parts.join(sep));
    }
  }

  function onFileChosen() {
    const files = fileInput?.files;
    if (!files || !files.length) return;
    void runImport(Array.from(files));
  }

  /** 失败项重试 */
  function retryFails() {
    const retryFiles = fails.map((f) => f.file);
    fails = [];
    void runImport(retryFiles);
  }

  /* ================= 拖拽导入 ================= */

  function onDragEnter(e: DragEvent) {
    if (e.dataTransfer?.types?.includes("Files")) {
      dragCounter++;
      dragging = true;
    }
  }

  function onDragOver(e: DragEvent) {
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }

  function onDragLeave(e: DragEvent) {
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0) dragging = false;
    void e;
  }

  function onDrop(e: DragEvent) {
    dragCounter = 0;
    dragging = false;
    const files = e.dataTransfer?.files;
    if (files && files.length) {
      e.preventDefault();
      void runImport(Array.from(files));
    }
  }

  /* ================= 编辑信息 ================= */

  function openEdit(b: BookMeta) {
    editTarget = b;
    editTitle = b.title;
    editAuthor = b.author || "";
    editSeries = b.series || "";
    editStatus = b.status ?? "unread";
    editRating = b.rating ?? 0;
    editFavorite = !!b.favorite;
    editTags = [...(b.tags ?? [])];
    editTagInput = "";
    editGroupId = b.groupId || "";
    // [2026-08-29] P2:颜色
    editColor = b.color;
    coverBusy = false;
  }

  async function saveEdit() {
    if (!editTarget) return;
    const id = editTarget.id;
    const ok = await store.updateMeta(id, {
      title: editTitle,
      author: editAuthor,
      series: editSeries,
      status: editStatus,
      rating: editRating,
      favorite: editFavorite,
      tags: editTags,
      groupId: editGroupId,
      // [2026-08-29] P2:颜色(只有变化才落盘,updateMeta 已走 isValidBookColor 校验)
      color: editColor,
    });
    editTarget = null;
    if (ok) {
      showToast(t("已保存"));
      await refresh();
    } else {
      showToast(t("保存失败"));
    }
  }

  /* ---- 编辑弹窗：标签 chip ---- */

  function addEditTag() {
    const t = editTagInput.trim();
    if (!t) return;
    if (!editTags.includes(t)) editTags = [...editTags, t];
    editTagInput = "";
  }

  function onEditTagKey(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addEditTag();
    } else if (e.key === "Backspace" && !editTagInput && editTags.length) {
      editTags = editTags.slice(0, -1);
    }
  }

  function dropEditTag(t: string) {
    editTags = editTags.filter((x) => x !== t);
  }

  /* ---- 编辑弹窗：封面替换 ---- */

  async function onCoverChosen() {
    const f = coverInput?.files?.[0];
    if (!f || !editTarget) return;
    if (!/^image\//.test(f.type)) {
      showToast(t("请选择图片文件"));
      coverInput.value = "";
      return;
    }
    coverBusy = true;
    const ext = (f.name.match(/\.([a-z0-9]+)$/i)?.[1] ?? "jpg").toLowerCase();
    try {
      const path = await store.replaceCover(editTarget.id, f, ext);
      if (path) {
        showToast(t("封面已替换"));
        await refresh();
        // 弹窗内立即看到新封面
        const fresh = store.get(editTarget.id);
        if (fresh) editTarget = fresh;
      } else {
        showToast(t("封面替换失败"));
      }
    } catch {
      showToast(t("封面替换失败"));
    }
    coverBusy = false;
    coverInput.value = "";
  }

  /* ---- 单本快捷操作 ---- */

  async function toggleFav(b: BookMeta) {
    await store.toggleFavorite(b.id);
    await refresh();
  }

  async function cycleStatus(b: BookMeta) {
    const cur = b.status ?? "unread";
    const next = STATUS_ORDER[(STATUS_ORDER.indexOf(cur) + 1) % STATUS_ORDER.length];
    await store.setStatus(b.id, next);
    await refresh();
    showToast(t("已标记为「{s}」", { s: STATUS_LABEL[next] }));
  }

  /* ---- 分组管理 ---- */

  async function createGroup() {
    const n = newGroupName.trim();
    if (!n) return;
    const g = await store.createGroup(n);
    newGroupName = "";
    await refresh();
    if (g) showToast(t("已创建分组「{name}」", { name: g.name }));
  }

  async function startRenameGroup(g: BookGroup) {
    renamingGroupId = g.id;
    renamingGroupName = g.name;
    groupColorPickerId = "";
    await tick();
    renamingInput?.focus();
    renamingInput?.select();
  }

  /**
   * [2026-08-29] P2:从侧边栏点分组色点 → 打开分组管理弹窗并展开该组的颜色 popover
   * (避免在侧边栏小空间里塞 popover 触发遮挡)
   */
  async function openGroupColorDialog(id: string) {
    groupDialogOpen = true;
    groupColorPickerId = id;
    await refresh();
  }

  /* ============== [2026-08-29] P2:右键菜单构造 ============== */

  /** 书籍右键菜单(高效操作总入口) */
  function buildBookMenu(b: BookMeta): MenuItem[] {
    return [
      {
        icon: b.progress?.fraction ? SEL_ICONS.bookFallback : SEL_ICONS.play,
        label: b.progress?.fraction ? t("续读") : t("开始阅读"),
        onClick: () => onOpen(b.id),
      },
      { divider: true },
      // 2026-10-09：本书的笔记发送目标（per-book 绑定的主入口）。
      // 已绑定时把文档名带在标签里，用户右键就能看到"发到哪"，
      // 不用进设置才知道。子菜单里提供「解除绑定」。
      {
        icon: SEL_ICONS.noteBound,
        label: b.notebookTarget?.docId
          ? t("笔记发送目标：{doc}", { doc: b.notebookTarget.docTitle || t("（无标题文档）") })
          : t("笔记发送目标（未设置）"),
        disabled: !onPickNotebookTarget,
        children: [
          {
            label: b.notebookTarget?.docId ? t("换一篇…") : t("选择目标文档…"),
            onClick: () => {
              onPickNotebookTarget?.(b.id, async (picked) => {
                if (!picked) return; // 用户取消
                await store.setNotebookTarget(b.id, picked);
              });
            },
          },
          // 已绑定才给「解除绑定」；没绑定时给一个说明项，避免菜单空荡荡
          b.notebookTarget?.docId
            ? {
                label: t("解除绑定"),
                onClick: () => {
                  void store.setNotebookTarget(b.id, "");
                },
              }
            : { label: t("（未设置时导出摘录会提示去设置）"), disabled: true },
        ],
      },
      // 2026-10-10：按书名自动建档（方案 B）。未绑定时最有用——
      // 一键在固定的「自动建档位置」下建一篇《书名》并绑定，免去逐本手选。
      {
        icon: SEL_ICONS.autoBind,
        label: t("按书名自动建档"),
        disabled: !onAutoBind,
        onClick: () => onAutoBind?.(b.id, () => {}),
      },
      { icon: SEL_ICONS.edit, label: t("编辑信息"), onClick: () => openEdit(b) },
      {
        icon: SEL_ICONS.tags,
        label: t("设置标签…"),
        children: facets.tags.length
          ? [
              ...facets.tags.map((t) => ({
                label: t.tag,
                active: (b.tags ?? []).includes(t.tag),
                onClick: () => {
                  if ((b.tags ?? []).includes(t.tag)) removeTag(b.id, t.tag);
                  else addTag(b.id, t.tag);
                },
              })),
              { divider: true },
              {
                label: t("打开标签管理…"),
                onClick: () => {
                  editTarget = b;
                  editTags = [...(b.tags ?? [])];
                  editTagInput = "";
                },
              },
            ]
          : [{ label: t("(打开编辑弹窗管理标签)"), onClick: () => openEdit(b) }],
      },
      {
        icon: SEL_ICONS.group,
        label: t("移到分组…"),
        children: [
          ...facets.groups.map((g) => ({
            label: g.name,
            active: b.groupId === g.id,
            onClick: () => setGroup(b.id, g.id),
          })),
          { divider: true },
          {
            label: t("(移出分组)"),
            active: !b.groupId,
            onClick: () => setGroup(b.id, undefined),
          },
          { divider: true },
          {
            label: t("管理分组…"),
            onClick: () => (groupDialogOpen = true),
          },
        ],
      },
      {
        icon: SEL_ICONS.fav,
        label: b.favorite ? t("取消收藏") : t("收藏"),
        onClick: () => toggleFav(b),
      },
      {
        icon: SEL_ICONS.status,
        label: t("状态"),
        children: (["unread", "reading", "finished"] as BookStatus[]).map((s) => ({
          label: STATUS_LABEL[s],
          active: (b.status ?? "unread") === s,
          onClick: () => setStatus(b.id, s),
        })),
      },
      {
        icon: SEL_ICONS.fav,
        label: t("评分"),
        children: [
          ...[1, 2, 3, 4, 5].map((n) => ({
            label: `${"★".repeat(n)}${"☆".repeat(5 - n)}`,
            active: b.rating === n,
            onClick: () => setRating(b.id, n),
          })),
          { divider: true },
          { label: t("清除评分"), active: !b.rating, onClick: () => setRating(b.id, 0) },
        ],
      },
      {
        icon: SEL_ICONS.palette,
        label: t("颜色"),
        children: [
          ...BOOK_COLORS.map((c) => ({
            label: t(c.label),
            active: b.color === c.token,
            onClick: () => setBookColor(b.id, c.token === b.color ? undefined : c.token),
          })),
          { divider: true },
          { label: t("移除颜色"), active: !b.color, onClick: () => setBookColor(b.id, undefined) },
        ],
      },
      { divider: true },
      {
        icon: SEL_ICONS.cover,
        label: t("替换封面…"),
        onClick: () => {
          editTarget = b;
          coverInput?.click();
        },
      },
      {
        icon: SEL_ICONS.copy,
        label: t("复制书名"),
        onClick: () => {
          try {
            navigator.clipboard?.writeText(b.title);
            showToast(t("已复制书名"));
          } catch {
            showToast(t("复制失败"));
          }
        },
      },
      { divider: true },
      { icon: SEL_ICONS.trash, label: t("从书架移除…"), danger: true, onClick: () => openRemove(b) },
    ];
  }

  /** 分组右键菜单 */
  function buildGroupMenu(g: BookGroup): MenuItem[] {
    const count = store.groupCount(g.id);
    return [
      { icon: SEL_ICONS.edit, label: t("重命名"), onClick: () => startRenameGroup(g) },
      {
        icon: SEL_ICONS.palette,
        label: t("颜色"),
        children: [
          ...BOOK_COLORS.map((c) => ({
            label: t(c.label),
            active: g.color === c.token,
            onClick: () => setGroupColor(g.id, c.token === g.color ? undefined : c.token),
          })),
          { divider: true },
          { label: t("移除颜色"), active: !g.color, onClick: () => setGroupColor(g.id, undefined) },
        ],
      },
      { divider: true },
      {
        icon: SEL_ICONS.ungrouped,
        label: t("在主区域打开"),
        onClick: () => {
          filterGroup = g.id;
          favoriteOnly = false;
        },
      },
      {
        icon: SEL_ICONS.copy,
        label: t("复制组名"),
        onClick: () => {
          try {
            navigator.clipboard?.writeText(g.name);
            showToast(t("已复制组名"));
          } catch {
            showToast(t("复制失败"));
          }
        },
      },
      { divider: true },
      {
        icon: SEL_ICONS.trash,
        label: t("删除分组"),
        danger: true,
        onClick: () => {
          if (confirm(t("确定删除分组「{name}」?\n组内 {n} 本书将回到「未分组」", { name: g.name, n: count }))) {
            deleteGroup(g);
          }
        },
      },
    ];
  }

  /* ---- 右键菜单触发的 store 动作 wrapper(带 refresh + toast) ---- */
  async function setBookColor(id: string, color: BookColor | undefined) {
    await store.setColor(id, color);
    await refresh();
    showToast(color ? t("已设为{color}", { color: colorLabel(color) }) : t("已移除颜色"));
  }
  async function setGroupColor(id: string, color: BookColor | undefined) {
    await store.setGroupColor(id, color);
    await refresh();
    showToast(color ? t("分组已设为{color}", { color: colorLabel(color) }) : t("分组颜色已移除"));
  }
  async function setStatus(id: string, s: BookStatus) {
    await store.setStatus(id, s);
    await refresh();
    showToast(t("已标记为「{s}」", { s: STATUS_LABEL[s] }));
  }
  async function setRating(id: string, n: number) {
    await store.setRating(id, n);
    await refresh();
    showToast(n > 0 ? t("已评 {n} 星", { n }) : t("已清除评分"));
  }
  async function setGroup(id: string, gid: string | undefined) {
    await store.setGroup(id, gid);
    await refresh();
    showToast(gid ? t("已移入分组") : t("已移出分组"));
  }
  async function addTag(id: string, t: string) {
    await store.addTag(id, t);
    await refresh();
    showToast(T("已添加标签「{tag}」", { tag: t }));
  }
  async function removeTag(id: string, t: string) {
    await store.removeTag(id, t);
    await refresh();
    showToast(T("已移除标签「{tag}」", { tag: t }));
  }

  async function commitRenameGroup() {
    if (!renamingGroupId) return;
    const name = renamingGroupName.trim();
    if (!name) {
      renamingGroupId = "";
      renamingGroupName = "";
      return;
    }
    const ok = await store.renameGroup(renamingGroupId, name);
    renamingGroupId = "";
    renamingGroupName = "";
    if (ok) {
      showToast(t("已重命名为「{name}」", { name }));
      await refresh();
    } else {
      showToast(t("重命名失败"));
    }
  }

  async function deleteGroup(g: BookGroup) {
    await store.deleteGroup(g.id);
    if (filterGroup === g.id) filterGroup = "all";
    await refresh();
    showToast(t("已删除分组「{name}」（书籍保留）", { name: g.name }));
  }

  /* ---- 批量选择 ---- */

  function toggleSelectMode() {
    selectMode = !selectMode;
    if (!selectMode) selectedIds = [];
  }

  function toggleSelect(id: string) {
    selectedIds = selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id];
  }

  function selectAllVisible() {
    selectedIds = visible.map((b) => b.id);
  }

  function clearSelection() {
    selectedIds = [];
  }

  async function batchStatus(e: Event) {
    const v = (e.target as HTMLSelectElement).value as BookStatus | "";
    if (!v || !selectedIds.length) return;
    const n = await store.batchSetStatus(selectedIds, v);
    (e.target as HTMLSelectElement).value = "";
    await refresh();
    showToast(t("已将 {n} 本标记为「{s}」", { n, s: STATUS_LABEL[v] }));
  }

  async function batchGroup(e: Event) {
    const v = (e.target as HTMLSelectElement).value;
    if (!v || !selectedIds.length) return;
    const n = await store.batchSetGroup(selectedIds, v === "__none__" ? undefined : v);
    (e.target as HTMLSelectElement).value = "";
    await refresh();
    showToast(v === "__none__" ? t("已将 {n} 本移出分组", { n }) : t("已将 {n} 本移入分组", { n }));
  }

  /** [2026-08-29] P2:批量设色 */
  async function batchColor(e: Event) {
    const v = (e.target as HTMLSelectElement).value;
    if (!v || !selectedIds.length) return;
    const color = v === "__none__" ? undefined : (v as BookColor);
    if (color && !isValidBookColor(color)) return;
    const n = await store.batchSetColor(selectedIds, color);
    (e.target as HTMLSelectElement).value = "";
    await refresh();
    if (n === 0) showToast(t("所选书已是该颜色"));
    else showToast(color ? t("已将 {n} 本设为{color}", { n, color: colorLabel(color) }) : t("已移除 {n} 本颜色", { n }));
  }

  /** [2026-08-29] P2:批量评分 */
  async function batchRating(e: Event) {
    const raw = (e.target as HTMLSelectElement).value;
    if (raw === "" || !selectedIds.length) return;
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    const n = await store.batchSetRating(selectedIds, v);
    (e.target as HTMLSelectElement).value = "";
    await refresh();
    showToast(v > 0 ? t("已将 {n} 本评为 {v} 星", { n, v }) : t("已清除 {n} 本评分", { n }));
  }

  /** [2026-08-29] P2:批量收藏 */
  async function batchFavorite(e: Event) {
    const v = (e.target as HTMLSelectElement).value;
    if (v === "" || !selectedIds.length) return;
    const n = await store.batchSetFavorite(selectedIds, v === "1");
    (e.target as HTMLSelectElement).value = "";
    await refresh();
    showToast(v === "1" ? t("已收藏 {n} 本", { n }) : t("已取消收藏 {n} 本", { n }));
  }

  async function commitBatchTag() {
    const t = batchTagName.trim();
    if (!t || !selectedIds.length) return;
    const n = await store.batchAddTag(selectedIds, t);
    batchTagOpen = false;
    batchTagName = "";
    await refresh();
    showToast(T("已为 {n} 本添加标签「{tag}」", { n, tag: t }));
  }

  async function confirmBatchRemove() {
    const ids = [...selectedIds];
    batchRemoveOpen = false;
    try {
      const n = await store.batchRemove(ids, { deleteFile: removeWithFile });
      selectedIds = [];
      selectMode = false;
      await refresh();
      showToast(removeWithFile ? t("已删除 {n} 本及源文件", { n }) : t("已移除 {n} 本（源文件保留）", { n }));
    } catch {
      showToast(t("批量删除失败"));
    }
    removeWithFile = false;
  }

  /* ---- 拖书入组（内部拖拽，与文件拖拽导入用不同 dataTransfer 类型区分） ---- */

  const DRAG_TYPE = "application/x-reword-book";

  function onBookDragStart(e: DragEvent, id: string) {
    if (!e.dataTransfer) return;
    // 选中多本时拖任意一本 = 拖整批
    const ids = selectMode && selectedIds.includes(id) ? selectedIds : [id];
    e.dataTransfer.setData(DRAG_TYPE, ids.join(","));
    e.dataTransfer.effectAllowed = "move";
  }

  function onGroupDragOver(e: DragEvent, gid: string) {
    if (!e.dataTransfer?.types?.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    dropGroupId = gid;
  }

  function onGroupDragLeave(gid: string) {
    if (dropGroupId === gid) dropGroupId = "";
  }

  async function onGroupDrop(e: DragEvent, gid: string) {
    dropGroupId = "";
    const raw = e.dataTransfer?.getData(DRAG_TYPE);
    if (!raw) return;
    e.preventDefault();
    e.stopPropagation();
    const ids = raw.split(",").filter(Boolean);
    if (!ids.length) return;
    const n = await store.batchSetGroup(ids, gid === "__none__" ? undefined : gid);
    await refresh();
    showToast(gid === "__none__" ? t("已移出分组 {n} 本", { n }) : t("已移入分组 {n} 本", { n }));
  }

  function openRemove(b: BookMeta) {
    removeTarget = b;
    removeWithFile = false;
  }

  async function confirmRemove() {
    if (!removeTarget) return;
    const b = removeTarget;
    removeTarget = null;
    try {
      await store.removeBook(b.id, { deleteFile: removeWithFile });
      showToast(removeWithFile ? t("已删除《{title}》及源文件", { title: b.title }) : t("已从书架移除《{title}》（源文件保留）", { title: b.title }));
      await refresh();
    } catch {
      showToast(t("删除失败"));
    }
  }

  function fmtTime(ms: number | undefined): string {
    if (!ms || ms < 60000) return "";
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h}h${m}m` : `${h}h`;
  }

  /** 书架 store 订阅句柄（阅读器保存进度/时长后书架自动同步） */
  let unsubStore: (() => void) | null = null;
  /** 2026-10-10：快捷键提示面板（与 ReaderView 共享，按 ? 唤出） */
  let showHint = false;
  let disposeHintBind: (() => void) | null = null;
  $: hintGroups = getHintPayload(null, isMacPlatformBookshelf());
  function isMacPlatformBookshelf(): boolean {
    try {
      const p = (typeof navigator !== "undefined" ? navigator.platform : "") || "";
      return /mac|iphone|ipad|ipod/i.test(p);
    } catch (__e) {
      return false;
    }
  }

  onMount(() => {
    loadUiPrefs();
    // 2026-10-24 移动端适配 Phase 3：手机端分组侧栏是 overlay 抽屉，默认收起（桌面保持记忆值）
    if (isPhoneBreakpoint($viewport.breakpoint)) sidebarOpen = false;
    void refresh();
    unsubStore = store.subscribe((list) => {
      if (!Array.isArray(list)) return;
      books = [...list];
      loadCovers(books);
    });
    // [2026-08-29] P2 抛光:全局 Esc 关闭任意弹窗/菜单(N1)
    window.addEventListener("keydown", onGlobalKeydown);
    // 2026-10-10：注册 ? 提示面板 toggle 到顶层。
    // 与 ReaderView 互斥：两个视图都活着时，**最后调 bindGlobalShortcutHint 的获胜**。
    // 销毁时调 disposeHintBind 把控制权交还给另一个视图。
    disposeHintBind = bindGlobalShortcutHint((force) => {
      showHint = force ?? !showHint;
    });
  });

  onDestroy(() => {
    try {
      unsubStore?.();
    } catch {
      // ignore
    }
    unsubStore = null;
    // 回收封面 objectURL，防内存泄漏
    for (const url of Object.values(coverUrls)) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
    }
    coverUrls = {};
    coverPaths = {};
    window.removeEventListener("keydown", onGlobalKeydown);
    // 2026-10-10：注销顶层 hint 绑定
    try { disposeHintBind?.(); } catch { /* ignore */ }
    disposeHintBind = null;
  });

  /** [2026-08-29] P2 N1:Esc 关闭任意打开的弹窗(优先级:右键菜单 → 编辑 → 重命名 → 移除/批量 → 弹窗栈) */
  function onGlobalKeydown(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    if (e.defaultPrevented) return; // 让上下文菜单组件自己处理
    if (ctxMenu) {
      ctxMenu = null;
      e.preventDefault();
      return;
    }
    if (editTarget) {
      editTarget = null;
      e.preventDefault();
      return;
    }
    if (removeTarget) {
      removeTarget = null;
      e.preventDefault();
      return;
    }
    if (batchRemoveOpen) {
      batchRemoveOpen = false;
      e.preventDefault();
      return;
    }
    if (batchTagOpen) {
      batchTagOpen = false;
      e.preventDefault();
      return;
    }
    if (groupDialogOpen) {
      // 重命名中优先
      if (renamingGroupId) {
        renamingGroupId = "";
        renamingGroupName = "";
      } else {
        groupDialogOpen = false;
      }
      e.preventDefault();
      return;
    }
    if (fails.length) {
      fails = [];
      e.preventDefault();
      return;
    }
  }

  /** [2026-08-29] P2 N2:列表视图 J/K 上下移动焦点 + Enter 打开 */
  let rowFocusIdx = -1;
  function onListKeydown(e: KeyboardEvent) {
    // 只在列表视图 + 无输入焦点时生效
    if (viewMode !== "list") return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.target instanceof HTMLSelectElement) return;
    if (e.target instanceof HTMLButtonElement && (e.target as HTMLButtonElement).getAttribute("role") === "menuitem") return;
    if (ctxMenu || editTarget || groupDialogOpen || batchRemoveOpen || batchTagOpen) return;
    if (!visible.length) return;

    if (e.key === "j" || e.key === "ArrowDown") {
      e.preventDefault();
      rowFocusIdx = Math.min(visible.length - 1, rowFocusIdx + 1);
      scrollRowIntoView(rowFocusIdx);
    } else if (e.key === "k" || e.key === "ArrowUp") {
      e.preventDefault();
      rowFocusIdx = Math.max(0, rowFocusIdx - 1);
      scrollRowIntoView(rowFocusIdx);
    } else if (e.key === "Enter" && rowFocusIdx >= 0 && rowFocusIdx < visible.length) {
      e.preventDefault();
      onOpen(visible[rowFocusIdx].id);
    }
  }

  function scrollRowIntoView(idx: number) {
    // 用 setTimeout 等 DOM 更新
    setTimeout(() => {
      const el = document.querySelector(`.shelf-row[data-idx="${idx}"]`) as HTMLElement | null;
      el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, 0);
  }
</script>

<div
  class="bookshelf-view"
  class:dragging
  class:re-phone={$viewport.breakpoint === "phone"}
  class:re-large-phone={$viewport.breakpoint === "largePhone"}
  class:re-tablet={$viewport.breakpoint === "tablet"}
  on:dragenter={onDragEnter}
  on:dragover={onDragOver}
  on:dragleave={onDragLeave}
  on:keydown={onListKeydown}
  on:drop={onDrop}
>
  <div class="bookshelf-header">
    <button
      class="shelf-icon-btn"
      class:active={sidebarOpen}
      title={sidebarOpen ? t("收起分组栏") : t("展开分组栏")}
      on:click={toggleSidebar}
    ><span class="reword-shelf-ico reword-shelf-ico--btn">{@html SEL_ICONS.menu}</span></button>
    <span class="bookshelf-title">{t("书架")}</span>
    <span class="bookshelf-count">
      {#if hasFilter}{t("{a} / {b} 本", { a: visible.length, b: books.length })}{:else}{t("{n} 本", { n: books.length })}{/if}
    </span>
    <span class="bookshelf-spacer"></span>
    <!-- [2026-08-29] P2:续读最近一本(顶栏总入口) -->
    {#if continueReadId}
      <button
        class="shelf-icon-btn shelf-continue"
        title={t("继续读 · {title}", { title: continueReadTitle })}
        on:click={() => continueReadId && onOpen(continueReadId)}
      ><span class="reword-shelf-ico reword-shelf-ico--btn reword-shelf-ico--t">{@html SEL_ICONS.play}</span>{t("续读")}</button>
    {/if}
    <button
      class="shelf-icon-btn"
      class:active={selectMode}
      title={selectMode ? t("退出多选") : t("多选")}
      on:click={toggleSelectMode}
    ><span class="reword-shelf-ico reword-shelf-ico--btn">{@html SEL_ICONS.checklist}</span></button>
    <button
      class="shelf-icon-btn"
      title={t("阅读统计")}
      on:click={() => (showStats = true)}
    ><span class="reword-shelf-ico reword-shelf-ico--btn">{@html SEL_ICONS.stats}</span></button>
    <button
      class="shelf-icon-btn"
      title={t("在线书源（OPDS）")}
      on:click={() => (showOpds = true)}
    ><span class="reword-shelf-ico reword-shelf-ico--btn">{@html SEL_ICONS.globe}</span></button>
    <button
      class="shelf-icon-btn"
      title={t("阅读知识图谱")}
      on:click={() => (showGraph = true)}
    ><span class="reword-shelf-ico reword-shelf-ico--btn">{@html SEL_ICONS.graph}</span></button>
    <button
      class="bookshelf-import-btn"
      disabled={importing}
      on:click={() => fileInput?.click()}
    >
      {#if !importing}<span class="reword-shelf-ico reword-shelf-ico--btn reword-shelf-ico--t">{@html SEL_ICONS.add}</span>{/if}
      {importing ? t("导入中…") : t("导入")}
    </button>
    <input
      bind:this={fileInput}
      type="file"
      accept={ACCEPT}
      multiple
      style="display:none"
      on:change={onFileChosen}
    />
  </div>

  <!-- [2026-08-29] P0 工具栏：搜索 + 排序 + 视图切换 -->
  <div class="shelf-toolbar">
    <div class="shelf-search">
      <span class="shelf-search-icon reword-shelf-ico reword-shelf-ico--sm">{@html SEL_ICONS.search}</span>
      <input
        class="shelf-search-input"
        type="text"
        placeholder={t("搜索书名 / 作者 / 标签 / 丛书")}
        bind:value={keyword}
      />
      {#if keyword}
        <button class="shelf-search-clear" title={t("清空")} on:click={() => (keyword = "")}><span class="reword-shelf-ico reword-shelf-ico--xs">{@html SEL_ICONS.cancel}</span></button>
      {/if}
    </div>
    <select class="shelf-select" title={t("排序方式")} value={sortKey} on:change={onSortKeyChange}>
      {#each SORT_OPTIONS as o}
        <option value={o.key}>{o.label}</option>
      {/each}
    </select>
    <button
      class="shelf-icon-btn"
      title={sortDir === "desc" ? t("当前：降序（点击切升序）") : t("当前：升序（点击切降序）")}
      on:click={toggleSortDir}
    ><span class="reword-shelf-ico reword-shelf-ico--btn">{@html sortDir === "desc" ? SEL_ICONS.sortDesc : SEL_ICONS.sortAsc}</span></button>
    <div class="shelf-view-toggle">
      <button
        class="shelf-icon-btn"
        class:active={viewMode === "grid"}
        title={t("封面网格")}
        on:click={() => setViewMode("grid")}
      ><span class="reword-shelf-ico reword-shelf-ico--btn">{@html SEL_ICONS.gridView}</span></button>
      <button
        class="shelf-icon-btn"
        class:active={viewMode === "list"}
        title={t("列表")}
        on:click={() => setViewMode("list")}
      ><span class="reword-shelf-ico reword-shelf-ico--btn">{@html SEL_ICONS.listView}</span></button>
    </div>
  </div>

  {#if selectMode}
    <div class="shelf-batch-bar">
      <span class="shelf-batch-count">{t("已选 {n} 本", { n: selectedIds.length })}</span>
      <button class="shelf-batch-btn" on:click={selectAllVisible}>{t("全选当前")}</button>
      <button class="shelf-batch-btn" on:click={clearSelection}>{t("清空")}</button>
      <span class="bookshelf-spacer"></span>
      <select class="shelf-select" disabled={!selectedIds.length} on:change={batchStatus}>
        <option value="">{t("设为状态…")}</option>
        <option value="unread">{t("想读")}</option>
        <option value="reading">{t("在读")}</option>
        <option value="finished">{t("读完")}</option>
      </select>
      <select class="shelf-select" disabled={!selectedIds.length} on:change={batchGroup}>
        <option value="">{t("移入分组…")}</option>
        {#each facets.groups as g}
          <option value={g.id}>{g.name}</option>
        {/each}
        <option value="__none__">{t("（移出分组）")}</option>
      </select>
      <!-- [2026-08-29] P2:批量设色(7 色 token) -->
      <select class="shelf-select" disabled={!selectedIds.length} on:change={batchColor}>
        <option value="">{t("设颜色…")}</option>
        {#each BOOK_COLORS as c}
          <option value={c.token}>{t(c.label)}</option>
        {/each}
        <option value="__none__">{t("（移除颜色）")}</option>
      </select>
      <!-- [2026-08-29] P2:批量评分 -->
      <select class="shelf-select" disabled={!selectedIds.length} on:change={batchRating}>
        <option value="">{t("设评分…")}</option>
        {#each [1, 2, 3, 4, 5] as n}
          <option value={n}>{t("{n} 星", { n })}</option>
        {/each}
        <option value={0}>{t("（清除）")}</option>
      </select>
      <!-- [2026-08-29] P2:批量收藏 -->
      <select class="shelf-select" disabled={!selectedIds.length} on:change={batchFavorite}>
        <option value="">{t("收藏…")}</option>
        <option value="1">{t("收藏")}</option>
        <option value="0">{t("（取消）")}</option>
      </select>
      <button
        class="shelf-batch-btn"
        disabled={!selectedIds.length}
        on:click={() => {
          batchTagName = "";
          batchTagOpen = true;
        }}>{t("加标签")}</button
      >
      <button
        class="shelf-batch-btn danger"
        disabled={!selectedIds.length}
        on:click={() => {
          removeWithFile = false;
          batchRemoveOpen = true;
        }}>{t("删除")}</button
      >
    </div>
  {/if}

  {#if importError}
    <div class="bookshelf-error">{importError}</div>
  {/if}

  {#if dragging}
    <div class="bookshelf-dropzone">
      <div class="bookshelf-dropzone-inner">
        <div class="bookshelf-dropzone-icon reword-shelf-ico reword-shelf-ico--xl">{@html SEL_ICONS.dropImport}</div>
        <div>{t("松开导入书籍")}</div>
        <div class="bookshelf-dropzone-hint">{t("支持 EPUB / MOBI / AZW3 / FB2 / CBZ / PDF / TXT / Markdown")}</div>
      </div>
    </div>
  {/if}

  {#if importing}
    <div class="import-progress">
      <div class="import-progress-text">
        <span>{t("导入中 {a}/{b}", { a: importDone, b: importTotal })}</span>
        <span class="import-progress-name">{currentName}</span>
      </div>
      <div class="import-progress-track">
        <div
          class="import-progress-bar"
          style="width:{importTotal ? (importDone / importTotal) * 100 : 0}%"
        ></div>
      </div>
    </div>
  {/if}

  {#if toast}
    <div class="import-toast">{toast}</div>
  {/if}

  <div
    class="bookshelf-body"
    class:side-resizing={sideResizing}
    class:sidebar-open={sidebarOpen}
    bind:this={shelfBodyEl}
  >
    <!-- 2026-10-24 移动端适配 Phase 3：手机端分组侧栏是 overlay 抽屉，补一块可点击的遮罩 -->
    {#if sidebarOpen && isPhoneBp}
      <div class="shelf-sb-backdrop" on:click={() => (sidebarOpen = false)}></div>
    {/if}
    {#if sidebarOpen}
      <!-- [2026-08-29] P1 分组侧栏：用户分组 + 智能分组（状态/标签/格式） -->
      <aside class="shelf-sidebar" style="width:{sideWidth}px">
        <div class="shelf-sb-block">
          <button
            class="shelf-sb-item"
            class:active={filterGroup === "all" && !favoriteOnly && filterStatus === "all" && !filterTag}
            on:click={() => pickScope("all")}
          >
            <span class="shelf-sb-label"><span class="reword-shelf-ico reword-shelf-ico--sm reword-shelf-ico--t">{@html SEL_ICONS.allBooks}</span>{t("全部")}</span>
            <span class="shelf-sb-num">{books.length}</span>
          </button>
          <button class="shelf-sb-item" class:active={favoriteOnly} on:click={() => pickScope("favorite")}>
            <span class="shelf-sb-label"><span class="reword-shelf-ico reword-shelf-ico--sm reword-shelf-ico--t">{@html SEL_ICONS.fav}</span>{t("收藏")}</span>
            <span class="shelf-sb-num">{facets.favorites}</span>
          </button>
          <button
            class="shelf-sb-item"
            class:active={filterGroup === "ungrouped"}
            class:dropping={dropGroupId === "__none__"}
            on:click={() => pickScope("ungrouped")}
            on:dragover={(e) => onGroupDragOver(e, "__none__")}
            on:dragleave={() => onGroupDragLeave("__none__")}
            on:drop={(e) => onGroupDrop(e, "__none__")}
          >
            <span class="shelf-sb-label"><span class="reword-shelf-ico reword-shelf-ico--sm reword-shelf-ico--t">{@html SEL_ICONS.ungrouped}</span>{t("未分组")}</span>
            <span class="shelf-sb-num">{facets.ungrouped}</span>
          </button>
        </div>

        <div class="shelf-sb-block">
          <button class="shelf-sb-title toggle" on:click={() => toggleBlock("status")}>
            <span class="shelf-sb-caret" class:closed={collapsed.status}><span class="reword-shelf-ico reword-shelf-ico--xs">{@html SEL_ICONS.chevronDown}</span></span>
            <span class="shelf-sb-title-text">{t("阅读状态")}</span>
          </button>
          {#if !collapsed.status}
            {#each STATUS_ORDER as s}
              <button
                class="shelf-sb-item"
                class:active={filterStatus === s}
                on:click={() => pickStatus(s)}
              >
                <span class="shelf-sb-label">{STATUS_LABEL[s]}</span>
                <span class="shelf-sb-num">{facets.status[s]}</span>
              </button>
            {/each}
          {/if}
        </div>

        <div class="shelf-sb-block">
          <div class="shelf-sb-title">
            <button class="shelf-sb-toggle" on:click={() => toggleBlock("groups")} title={t("折叠/展开")}>
              <span class="shelf-sb-caret" class:closed={collapsed.groups}><span class="reword-shelf-ico reword-shelf-ico--xs">{@html SEL_ICONS.chevronDown}</span></span>
            </button>
            <span class="shelf-sb-title-text" on:click={() => toggleBlock("groups")}>{t("我的分组")}</span>
            <button class="shelf-sb-add" title={t("管理分组")} on:click|stopPropagation={() => (groupDialogOpen = true)}><span class="reword-shelf-ico reword-shelf-ico--xs">{@html SEL_ICONS.add}</span></button>
          </div>
          {#if !collapsed.groups}
            {#each facets.groups as g (g.id)}
              <div
                class="shelf-sb-item shelf-sb-group"
                class:active={filterGroup === g.id}
                class:dropping={dropGroupId === g.id}
                role="button"
                tabindex="0"
                title={t("点击筛选 · 双击重命名 · 拖书归组 · 右键更多")}
                on:click={() => {
                  if (renamingGroupId !== g.id) pickGroup(g.id);
                }}
                on:dblclick={() => startRenameGroup(g)}
                on:keydown={(e) => (e.key === "Enter" || e.key === " ") && renamingGroupId !== g.id && pickGroup(g.id)}
                on:contextmenu={(e) => openCtxMenu(e, buildGroupMenu(g))}
                on:dragover={(e) => onGroupDragOver(e, g.id)}
                on:dragleave={() => onGroupDragLeave(g.id)}
                on:drop={(e) => onGroupDrop(e, g.id)}
              >
                {#if renamingGroupId === g.id && !groupDialogOpen}
                  <input
                    class="group-rename shelf-sb-rename"
                    bind:value={renamingGroupName}
                    bind:this={renamingInput}
                    on:click|stopPropagation
                    on:keydown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitRenameGroup();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        renamingGroupId = "";
                        renamingGroupName = "";
                      }
                    }}
                    on:blur={() => {
                      if (renameBlurCommit) commitRenameGroup();
                      renameBlurCommit = true;
                    }}
                  />
                  <button
                    type="button"
                    class="group-op"
                    on:click|stopPropagation={() => commitRenameGroup()}
                    on:mousedown|preventDefault={() => (renameBlurCommit = true)}
                  >{t("确定")}</button>
                  <button
                    type="button"
                    class="group-op"
                    on:click|stopPropagation={() => { renamingGroupId = ""; renamingGroupName = ""; }}
                    on:mousedown|preventDefault={() => (renameBlurCommit = false)}
                  >{t("取消")}</button>
                {:else}
                  <!-- [2026-08-29] P2:分组色点(无色时透明占位) -->
                  <span
                    class="shelf-sb-color"
                    class:has={!!g.color}
                    style="--swatch-color: {g.color ? BOOK_COLORS.find((c) => c.token === g.color)?.hex : 'transparent'}"
                  ></span>
                  <span class="shelf-sb-label"><span class="reword-shelf-ico reword-shelf-ico--sm reword-shelf-ico--t">{@html SEL_ICONS.group}</span>{g.name}</span>
                  <span class="shelf-sb-num">{g.count}</span>
                  <!-- [2026-08-29] P2:悬停显示重命名 + 颜色 popover 入口 -->
                  <button
                    type="button"
                    class="shelf-sb-edit"
                    title={t("重命名(双击组名也行)")}
                    on:click|stopPropagation={() => startRenameGroup(g)}
                  >
                    <span class="reword-shelf-ico reword-shelf-ico--xs">{@html SEL_ICONS.edit}</span>
                  </button>
                  <button
                    type="button"
                    class="shelf-sb-colorbtn"
                    title={t("分组颜色")}
                    on:click|stopPropagation={() => openGroupColorDialog(g.id)}
                  >
                    <span class="reword-shelf-ico reword-shelf-ico--xs">{@html SEL_ICONS.palette}</span>
                  </button>
                {/if}
              </div>
            {:else}
              <div class="shelf-sb-hint">{t("还没有分组，点 ＋ 新建")}</div>
            {/each}
          {/if}
        </div>

        {#if facets.tags.length}
          <div class="shelf-sb-block">
            <button class="shelf-sb-title toggle" on:click={() => toggleBlock("tags")}>
              <span class="shelf-sb-caret" class:closed={collapsed.tags}><span class="reword-shelf-ico reword-shelf-ico--xs">{@html SEL_ICONS.chevronDown}</span></span>
              <span class="shelf-sb-title-text">{t("标签")}</span>
            </button>
            {#if !collapsed.tags}
              <div class="shelf-sb-tags">
                {#each facets.tags as t (t.tag)}
                  <button class="shelf-tag-chip" class:active={filterTag === t.tag} on:click={() => pickTag(t.tag)}>
                    {t.tag}<span class="shelf-tag-num">{t.count}</span>
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {/if}

        <!-- [2026-08-29] P2:颜色筛选区块(7 色 swatch + 计数) -->
        {#if facets.colors.length}
          <div class="shelf-sb-block">
            <button class="shelf-sb-title toggle" on:click={() => toggleBlock("colors")}>
              <span class="shelf-sb-caret" class:closed={collapsed.colors}><span class="reword-shelf-ico reword-shelf-ico--xs">{@html SEL_ICONS.chevronDown}</span></span>
              <span class="shelf-sb-title-text">{t("颜色")}</span>
            </button>
            {#if !collapsed.colors}
              <div class="shelf-sb-swatches">
                {#each facets.colors as c (c.color)}
                  <button
                    type="button"
                    class="shelf-sb-swatch"
                    class:on={filterColor === c.color}
                    style="--swatch-color: {BOOK_COLORS.find((x) => x.token === c.color)?.hex}"
                    title={`${colorLabel(c.color)} · ${t("{n} 本", { n: c.count })}`}
                    on:click={() => pickColor(c.color)}
                  >
                    <span class="shelf-sb-swatch-num">{c.count}</span>
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {/if}

        <!-- [2026-08-29] P2:丛书筛选区块(≥ 2 本才显示) -->
        {#if facets.series.length}
          <div class="shelf-sb-block">
            <button class="shelf-sb-title toggle" on:click={() => toggleBlock("series")}>
              <span class="shelf-sb-caret" class:closed={collapsed.series}><span class="reword-shelf-ico reword-shelf-ico--xs">{@html SEL_ICONS.chevronDown}</span></span>
              <span class="shelf-sb-title-text">{t("丛书")}</span>
            </button>
            {#if !collapsed.series}
              <div class="shelf-sb-tags">
                {#each facets.series as s (s.series)}
                  <button class="shelf-tag-chip" class:active={filterSeries === s.series} on:click={() => pickSeries(s.series)}>
                    {s.series}<span class="shelf-tag-num">{s.count}</span>
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {/if}

        {#if facets.formats.length > 1}
          <div class="shelf-sb-block">
            <button class="shelf-sb-title toggle" on:click={() => toggleBlock("formats")}>
              <span class="shelf-sb-caret" class:closed={collapsed.formats}><span class="reword-shelf-ico reword-shelf-ico--xs">{@html SEL_ICONS.chevronDown}</span></span>
              <span class="shelf-sb-title-text">{t("格式")}</span>
            </button>
            {#if !collapsed.formats}
              <div class="shelf-sb-tags">
                {#each facets.formats as f (f.format)}
                  <button
                    class="shelf-tag-chip"
                    class:active={filterFormat === f.format}
                    on:click={() => pickFormat(f.format)}
                  >
                    {f.format.toUpperCase()}<span class="shelf-tag-num">{f.count}</span>
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </aside>
      <!-- 侧栏右边那条线就是把手：横拖改宽度，双击恢复默认 -->
      <!-- svelte-ignore a11y-no-noninteractive-element-interactions a11y-no-noninteractive-tabindex
           ARIA 1.2 里「可聚焦的分隔条」就是 role=separator + aria-valuenow + 方向键，
           svelte-check 的角色表还不认这一条，所以两条 a11y 警告是误报。 -->
      <div
        class="shelf-side-resizer"
        class:resizing={sideResizing}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("侧栏宽度")}
        aria-valuenow={sideWidth}
        aria-valuemin={SIDE_W_MIN}
        aria-valuemax={SIDE_W_MAX}
        tabindex="0"
        title={t("拖动调整侧栏宽度，双击恢复默认")}
        on:pointerdown={sideResizeStart}
        on:pointermove={sideResizeMove}
        on:pointerup={sideResizeEnd}
        on:pointercancel={sideResizeEnd}
        on:keydown={sideResizeKey}
        on:dblclick={sideResizeReset}
      ></div>
    {/if}

    <div class="shelf-main">
      <!-- [2026-10-11 B2] 生效筛选摘要：每颗胶囊一个 ✕ 只清自己，右侧「清除全部」。
           数据来自 activeFilters 派生数组，这里不做任何状态判断 —— 加筛选条件时只改那一处。 -->
      {#if hasFilter && books.length > 0}
        <div class="shelf-chips">
          {#each activeFilters as f (f.key)}
            <span class="shelf-chip">
              <span class="reword-shelf-ico reword-shelf-ico--xs reword-shelf-ico--t">{@html f.icon}</span>
              <span class="shelf-chip-label" title={f.label}>{f.label}</span>
              <button class="shelf-chip-x" title={t("清除")} on:click={f.clear}
                ><span class="reword-shelf-ico reword-shelf-ico--xs">{@html SEL_ICONS.cancel}</span></button>
            </span>
          {/each}
          <button class="shelf-chips-clear" title={t("清除全部筛选")} on:click={clearFilters}>{t("清除全部")}</button>
        </div>
      {/if}

      {#if books.length === 0}
        <div class="bookshelf-empty">
          <!-- 2026-10-11 B3：空态不再是纯文字 —— 32px 图形（与拖拽遮罩同一枚）先把视线接住 -->
          <div class="bookshelf-empty-icon reword-shelf-ico reword-shelf-ico--xl">{@html SEL_ICONS.dropImport}</div>
          <div class="bookshelf-empty-title">{t("书架是空的")}</div>
          <div class="bookshelf-empty-hint">{t("支持 EPUB / MOBI / AZW3 / FB2 / CBZ / PDF / TXT / Markdown")}</div>
          <div class="bookshelf-empty-hint">{t("直接拖拽文件到这里，或点击下方按钮")}</div>
          <button class="bookshelf-import-btn" on:click={() => fileInput?.click()}>{t("导入第一本书")}</button>
        </div>
      {:else if visible.length === 0}
        <div class="bookshelf-empty">
          <div class="bookshelf-empty-title">{t("没有匹配的书籍")}</div>
          <div class="bookshelf-empty-hint">{t("试着换个关键词，或清除筛选条件")}</div>
          <button class="bookshelf-import-btn" on:click={clearFilters}>{t("清除筛选")}</button>
        </div>
      {:else if viewMode === "grid"}
        <div class="bookshelf-grid">
          {#each visible as book (book.id)}
            <div
              class="book-card"
              class:selected={selectedIds.includes(book.id)}
              draggable={true}
              on:dragstart={(e) => onBookDragStart(e, book.id)}
              on:contextmenu={(e) => openCtxMenu(e, buildBookMenu(book))}
              on:touchstart={(e) => onCardTouchStart(e, buildBookMenu(book))}
              on:touchmove={onCardTouchMove}
              on:touchend={onCardTouchEnd}
              on:touchcancel={onCardTouchEnd}
            >
              <div class="book-cover-wrap">
                <button
                  class="book-cover"
                  on:click={() => (selectMode ? toggleSelect(book.id) : onOpen(book.id))}
                >
                  {#if coverUrls[book.id]}
                    <img class="book-cover-img" src={coverUrls[book.id]} alt={book.title} />
                  {:else}
                    <span class="book-cover-text">{book.title.slice(0, 2)}</span>
                  {/if}
                </button>
                {#if selectMode}
                  <button
                    class="book-sel"
                    class:on={selectedIds.includes(book.id)}
                    title={t("选择")}
                    on:click|stopPropagation={() => toggleSelect(book.id)}
                  >{#if selectedIds.includes(book.id)}<span class="reword-shelf-ico reword-shelf-ico--xs">{@html SEL_ICONS.confirm}</span>{/if}</button>
                {/if}
                <!-- [2026-08-29] P2:封面右上色点(hover 显示色名 tooltip)
                     2026-10-11 B1：右上角整块让给收藏星，色点移左下 -->
                {#if book.color}
                  <span
                    class="book-color-dot"
                    style="--swatch-color: {BOOK_COLORS.find((c) => c.token === book.color)?.hex}"
                    title={t("颜色: {c}", { c: colorLabel(book.color) })}
                  ></span>
                {/if}
                <button
                  class="book-fav"
                  class:on={book.favorite}
                  title={book.favorite ? t("取消收藏") : t("收藏")}
                  on:click|stopPropagation={() => toggleFav(book)}
                ><span class="reword-shelf-ico reword-shelf-ico--sm{book.favorite ? ' reword-shelf-ico--fill' : ''}">{@html SEL_ICONS.fav}</span></button>
                <!-- 2026-10-24 移动端适配 Phase 3：触屏操作入口（hover 浮层/右键在手机不可达）。
                     仅 re-phone 显示（默认 display:none），弹出与右键同一份菜单。 -->
                <button
                  class="book-more-btn"
                  title={t("更多操作")}
                  on:click|stopPropagation={(e) => openCtxMenu(e, buildBookMenu(book))}
                >⋯</button>
                <!-- 2026-08-29 优化：操作按钮收纳到封面悬停层，卡片信息更简洁 -->
                <div
                  class="book-cover-overlay"
                  aria-hidden="true"
                  on:click={() => onOpen(book.id)}
                >
                  <button
                    class="book-overlay-primary"
                    title={book.progress?.fraction ? t("继续阅读") : t("开始阅读")}
                    on:click|stopPropagation={() => onOpen(book.id)}
                  >
                    {book.progress?.fraction ? t("续读") : t("开始")}
                  </button>
                  <div class="book-overlay-tools">
                    <button
                      class="book-icon-btn"
                      title={t("编辑书籍信息")}
                      on:click|stopPropagation={() => openEdit(book)}
                    ><span class="reword-shelf-ico">{@html SEL_ICONS.edit}</span></button>
                    <button
                      class="book-icon-btn danger"
                      title={t("从书架删除")}
                      on:click|stopPropagation={() => openRemove(book)}
                    ><span class="reword-shelf-ico">{@html SEL_ICONS.trash}</span></button>
                  </div>
                </div>
              </div>
              <div class="book-info">
                <div class="book-name" title={book.title}>{book.title}</div>
                <!-- 2026-10-13 改版：文字区收成两行（对齐参考网格）—— 书名一行 + 状态行：
                     读完 = 绿钉，其余只显示进度（未读 / xx%）。作者、格式、状态胶囊不再是
                     卡片常驻文字；状态改档走列表视图的胶囊与编辑弹窗，笔记目标重绑仍在右键菜单。 -->
                <div class="book-sub">
                  {#if book.status === "finished"}
                    <span class="book-done">{t("读完")}</span>
                  {:else}
                    <span class="book-progress">{fmtPct(book.progress?.fraction)}</span>
                  {/if}
                  <!-- 2026-10-09：已绑定笔记发送目标的角标。
                       **只显示已绑定** —— 未绑定不做灰色警告，
                       否则整架书都是灰标，等于在报"你还没配置"，压迫感很强。
                       刻意不可点：它只是状态标识，点它去设置反而要再写一套弹窗。
                       2026-10-13 改版：从 meta 行收进 sub 行、右对齐（meta 行已下线）。 -->
                  {#if book.notebookTarget?.docId}
                    <span
                      class="book-note-target"
                      title={t("笔记发送到：{doc}", { doc: book.notebookTarget.docTitle || book.notebookTarget.docId })}
                    ><span class="reword-shelf-ico reword-shelf-ico--xs">{@html SEL_ICONS.noteBound}</span></span>
                  {/if}
                </div>
              </div>
            </div>
          {/each}
        </div>
      {:else}
        <!-- [2026-08-29] P0 列表视图：一行看全信息 -->
        <!-- 2026-10-11 B3：改固定列栅格（demo 的八列模板）。
             表头把列义讲清楚 —— 之前每行都是「·」串起来的散句，列与列对不齐，
             同一屏里找「阅读时长」得逐行扫。 -->
        <div class="shelf-list">
          <div class="shelf-lhead" aria-hidden="true">
            <span></span>
            <span class="lh-title">{t("书名")}</span>
            <span class="lh-author">{t("作者")}</span>
            <span class="lh-format">{t("格式")}</span>
            <span class="lh-progress">{t("进度")}</span>
            <span class="lh-time">{t("阅读时长")}</span>
            <span class="lh-lastread">{t("最近阅读")}</span>
            <span></span>
          </div>
          {#each visible as book, idx (book.id)}
            <div
              class="shelf-row"
              class:focused={rowFocusIdx === idx}
              data-idx={idx}
              class:selected={selectedIds.includes(book.id)}
              draggable={true}
              on:dragstart={(e) => onBookDragStart(e, book.id)}
              on:contextmenu={(e) => openCtxMenu(e, buildBookMenu(book))}
              on:touchstart={(e) => onCardTouchStart(e, buildBookMenu(book))}
              on:touchmove={onCardTouchMove}
              on:touchend={onCardTouchEnd}
              on:touchcancel={onCardTouchEnd}
            >
              <!-- 第 1 列：多选时是勾选框，否则是色点（同一格，列数不随模式变） -->
              <div class="row-lead">
                {#if selectMode}
                  <button
                    class="row-sel"
                    class:on={selectedIds.includes(book.id)}
                    title={t("选择")}
                    on:click={() => toggleSelect(book.id)}
                  >{#if selectedIds.includes(book.id)}<span class="reword-shelf-ico reword-shelf-ico--xs">{@html SEL_ICONS.confirm}</span>{/if}</button>
                {:else if book.color}
                  <span
                    class="row-color-dot"
                    style="--swatch-color: {BOOK_COLORS.find((c) => c.token === book.color)?.hex}"
                    title={t("颜色: {c}", { c: colorLabel(book.color) })}
                  ></span>
                {/if}
              </div>
              <!-- 第 2 列「书名」：小封面 + 标题行 + 副行（分组/大小/标签） -->
              <div class="row-title-line">
                <button class="row-cover" title={book.title} on:click={() => onOpen(book.id)}>
                  {#if coverUrls[book.id]}
                    <img class="book-cover-img" src={coverUrls[book.id]} alt={book.title} />
                  {:else}
                    <span class="row-cover-text">{book.title.slice(0, 1)}</span>
                  {/if}
                </button>
                <div class="row-titlecol">
                  <div class="row-title-row">
                    <span class="row-title" title={book.title}>{book.title}</span>
                    <button
                      class="row-status-chip"
                      class:reading={(book.status ?? "unread") === "reading"}
                      class:done={book.status === "finished"}
                      title={t("点击切换阅读状态")}
                      on:click={() => cycleStatus(book)}
                    >{statusLabel(book.status)}</button>
                    {#if book.favorite}<span class="row-fav" title={t("收藏")}><span class="reword-shelf-ico reword-shelf-ico--xs reword-shelf-ico--fill">{@html SEL_ICONS.fav}</span></span>{/if}
                  </div>
                  <div class="row-sub">
                    <!-- [2026-08-29] P2:组 chip(放最前) -->
                    {#if book.groupId}
                      {@const g = facets.groups.find((x) => x.id === book.groupId)}
                      {#if g}
                        <span class="row-group-chip" title={t("分组")}>
                          {#if g.color}<span
                            class="row-group-dot"
                            style="--swatch-color: {BOOK_COLORS.find((c) => c.token === g.color)?.hex}"
                          ></span>{/if}<span class="reword-shelf-ico reword-shelf-ico--xs">{@html SEL_ICONS.group}</span>{g.name}
                        </span>
                        <span class="row-dot">·</span>
                      {/if}
                    {/if}
                    <span>{fmtSize(book.size)}</span>
                    {#if book.tags?.length}
                      <span class="row-tag-chips">
                        {#each book.tags.slice(0, 2) as t}
                          <span class="row-tag">{t}</span>
                        {/each}
                        {#if book.tags.length > 2}
                          <span class="row-tag more">+{book.tags.length - 2}</span>
                        {/if}
                      </span>
                    {/if}
                  </div>
                </div>
              </div>
              <span class="row-author" title={book.author || ""}>{book.author || t("未知作者")}</span>
              <span class="row-formatcell">{book.format.toUpperCase()}</span>
              <!-- 进度列只放条：62px 里再塞百分比会两边都读不清，精确值挂 title -->
              <span class="row-pbar" title={fmtPct(book.progress?.fraction)}
                ><i style="width: {Math.round((book.progress?.fraction ?? 0) * 100)}%"></i></span
              >
              <span class="row-time">{fmtTime(book.readingTimeMs) || "—"}</span>
              <!-- 缺「最近阅读」显示 —，不退化成「添加时间」也不显示 0 -->
              <span class="row-lastread">{fmtDate(book.lastReadAt) || "—"}</span>
              <div class="row-actions">
                <button class="row-btn primary" on:click={() => onOpen(book.id)}>
                  {book.progress?.fraction ? t("续读") : t("开始")}
                </button>
                <div class="row-actions-extra" aria-hidden="true">
                  <button class="row-icon-btn" title={t("编辑")} on:click={() => openEdit(book)}><span class="reword-shelf-ico">{@html SEL_ICONS.edit}</span></button>
                  <button class="row-icon-btn danger" title={t("删除")} on:click={() => openRemove(book)}><span class="reword-shelf-ico">{@html SEL_ICONS.trash}</span></button>
                </div>
                <!-- 2026-10-24 移动端适配 Phase 3：触屏菜单入口（row-actions-extra 是 hover 显示） -->
                <button
                  class="book-more-btn row-more-btn"
                  title={t("更多操作")}
                  on:click|stopPropagation={(e) => openCtxMenu(e, buildBookMenu(book))}
                >⋯</button>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>

  {#if fails.length}
    <div class="import-fail-mask">
      <div class="import-fail-panel">
        <div class="import-fail-title">{t("导入失败 {n} 本", { n: fails.length })}</div>
        <div class="import-fail-list">
          {#each fails as f}
            <div class="import-fail-item">
              <span class="import-fail-name" title={f.name}>{f.name}</span>
              <span class="import-fail-reason">{f.reason}</span>
            </div>
          {/each}
        </div>
        <div class="import-fail-actions">
          <button class="bookshelf-import-btn" on:click={retryFails}>{t("重试失败项")}</button>
          <button class="import-fail-close" on:click={() => (fails = [])}>{t("关闭")}</button>
        </div>
      </div>
    </div>
  {/if}

  {#if removeTarget}
    <div class="edit-mask" on:click|self={() => (removeTarget = null)}>
      <div class="edit-panel">
        <div class="edit-title">{t("从书架移除")}</div>
        <div class="remove-desc">{t("确定将《{title}》从书架移除？", { title: removeTarget.title })}</div>
        <label class="remove-check">
          <input type="checkbox" bind:checked={removeWithFile} />
          <span>{t("同时删除插件目录中的源文件（不可恢复）")}</span>
        </label>
        <div class="edit-actions">
          <button class="bookshelf-import-btn remove-danger" on:click={confirmRemove}>{t("移除")}</button>
          <button class="import-fail-close" on:click={() => (removeTarget = null)}>{t("取消")}</button>
        </div>
      </div>
    </div>
  {/if}

  {#if batchRemoveOpen}
    <div class="edit-mask" on:click|self={() => (batchRemoveOpen = false)}>
      <div class="edit-panel">
        <div class="edit-title">{t("批量移除")}</div>
        <div class="remove-desc">{t("确定将选中的 {n} 本从书架移除？", { n: selectedIds.length })}</div>
        <label class="remove-check">
          <input type="checkbox" bind:checked={removeWithFile} />
          <span>{t("同时删除插件目录中的源文件（不可恢复）")}</span>
        </label>
        <div class="edit-actions">
          <button class="bookshelf-import-btn remove-danger" on:click={confirmBatchRemove}>{t("移除")}</button>
          <button class="import-fail-close" on:click={() => (batchRemoveOpen = false)}>{t("取消")}</button>
        </div>
      </div>
    </div>
  {/if}

  {#if batchTagOpen}
    <div class="edit-mask" on:click|self={() => (batchTagOpen = false)}>
      <div class="edit-panel">
        <div class="edit-title">{t("为 {n} 本添加标签", { n: selectedIds.length })}</div>
        <label class="edit-field">
          <span>{t("标签名")}</span>
          <input bind:value={batchTagName} placeholder={t("如：精读 / 待复习")} />
        </label>
        {#if facets.tags.length}
          <div class="edit-field">
            <span>{t("已有标签（点击填入）")}</span>
            <div class="shelf-sb-tags">
              {#each facets.tags as t (t.tag)}
                <button class="shelf-tag-chip" on:click={() => (batchTagName = t.tag)}>{t.tag}</button>
              {/each}
            </div>
          </div>
        {/if}
        <div class="edit-actions">
          <button class="bookshelf-import-btn" on:click={commitBatchTag}>{t("添加")}</button>
          <button class="import-fail-close" on:click={() => (batchTagOpen = false)}>{t("取消")}</button>
        </div>
      </div>
    </div>
  {/if}

  {#if groupDialogOpen}
    <div class="edit-mask" on:click|self={() => (groupDialogOpen = false)}>
      <div class="edit-panel">
        <div class="edit-title">{t("管理分组")}</div>
        <div class="group-new">
          <input bind:value={newGroupName} placeholder={t("新分组名称")} on:keydown={(e) => e.key === "Enter" && createGroup()} />
          <button class="bookshelf-import-btn" on:click={createGroup}>{t("新建")}</button>
        </div>
        <div class="group-list">
          {#each facets.groups as g (g.id)}
            <div class="group-item">
              {#if renamingGroupId === g.id}
                <input
                  class="group-rename"
                  bind:value={renamingGroupName}
                  on:keydown={(e) => e.key === "Enter" && commitRenameGroup()}
                />
                <button class="group-op" on:click={commitRenameGroup}>{t("确定")}</button>
                <button class="group-op" on:click={() => (renamingGroupId = "")}>{t("取消")}</button>
              {:else}
                <!-- [2026-08-29] P2:分组色点(点击展开 7 色 swatch) -->
                <button
                  type="button"
                  class="group-color-dot"
                  class:has={!!g.color}
                  style="--swatch-color: {g.color ? BOOK_COLORS.find((c) => c.token === g.color)?.hex : 'transparent'}"
                  title={t("分组颜色")}
                  on:click={() => toggleGroupColorPicker(g.id)}
                ></button>
                <span class="group-name"><span class="reword-shelf-ico reword-shelf-ico--sm reword-shelf-ico--t">{@html SEL_ICONS.group}</span>{g.name}</span>
                <span class="group-count">{t("{n} 本", { n: g.count })}</span>
                <button class="group-op" on:click={() => startRenameGroup(g)}>{t("重命名")}</button>
                <button class="group-op danger" on:click={() => deleteGroup(g)}>{t("删除")}</button>
                {#if groupColorPickerId === g.id}
                  <div class="group-color-pop">
                    {#each BOOK_COLORS as c}
                      <button
                        type="button"
                        class="shelf-swatch"
                        class:on={g.color === c.token}
                        style="--swatch-color: {c.hex}"
                        title={t(c.label)}
                        on:click={async () => {
                          await store.setGroupColor(g.id, c.token === g.color ? undefined : c.token);
                          groupColorPickerId = "";
                          await refresh();
                        }}
                      ></button>
                    {/each}
                    <button
                      type="button"
                      class="shelf-swatch-clear"
                      on:click={async () => {
                        await store.setGroupColor(g.id, undefined);
                        groupColorPickerId = "";
                        await refresh();
                      }}
                    ><span class="reword-shelf-ico reword-shelf-ico--xs">{@html SEL_ICONS.cancel}</span></button>
                  </div>
                {/if}
              {/if}
            </div>
          {:else}
            <div class="shelf-sb-hint">{t("还没有分组")}</div>
          {/each}
        </div>
        <div class="edit-actions">
          <button class="import-fail-close" on:click={() => (groupDialogOpen = false)}>{t("关闭")}</button>
        </div>
      </div>
    </div>
  {/if}

  {#if editTarget}
    <div class="edit-mask" on:click|self={() => (editTarget = null)}>
      <div class="edit-panel wide">
        <div class="edit-title">{t("编辑书籍信息")}</div>
        <div class="edit-scroll">
          <div class="edit-cover-row">
            <div class="edit-cover-preview">
              {#if coverUrls[editTarget.id]}
                <img class="book-cover-img" src={coverUrls[editTarget.id]} alt={editTarget.title} />
              {:else}
                <span class="book-cover-text">{editTitle.slice(0, 2)}</span>
              {/if}
            </div>
            <div class="edit-cover-ops">
              <button class="book-btn" disabled={coverBusy} on:click={() => coverInput?.click()}>
                {coverBusy ? t("上传中…") : t("替换封面")}
              </button>
              <div class="edit-hint">{t("支持 JPG / PNG / WebP，建议 3:4 竖版")}</div>
              <label class="edit-inline-check">
                <input type="checkbox" bind:checked={editFavorite} />
                <span><span class="reword-shelf-ico reword-shelf-ico--sm reword-shelf-ico--t">{@html SEL_ICONS.fav}</span>{t("收藏")}</span>
              </label>
            </div>
          </div>

          <label class="edit-field">
            <span>{t("书名")}</span>
            <input bind:value={editTitle} placeholder={t("书名")} />
          </label>
          <label class="edit-field">
            <span>{t("作者")}</span>
            <input bind:value={editAuthor} placeholder={t("作者")} />
          </label>
          <label class="edit-field">
            <span>{t("丛书 / 系列")}</span>
            <input bind:value={editSeries} placeholder={t("如：哈利·波特")} />
          </label>

          <div class="edit-field">
            <span>{t("阅读状态")}</span>
            <div class="edit-seg">
              {#each STATUS_ORDER as s}
                <button class="edit-seg-btn" class:on={editStatus === s} on:click={() => (editStatus = s)}>
                  {STATUS_LABEL[s]}
                </button>
              {/each}
            </div>
          </div>

          <div class="edit-field">
            <span>{t("评分")}</span>
            <div class="edit-stars">
              {#each [1, 2, 3, 4, 5] as n}
                <button
                  class="edit-star"
                  class:on={editRating >= n}
                  title={t("{n} 星", { n })}
                  on:click={() => (editRating = editRating === n ? 0 : n)}
                ><span class="reword-shelf-ico reword-shelf-ico--sm{editRating >= n ? ' reword-shelf-ico--fill' : ''}">{@html SEL_ICONS.fav}</span></button>
              {/each}
              {#if editRating}
                <button class="edit-star-clear" on:click={() => (editRating = 0)}>{t("清除")}</button>
              {/if}
            </div>
          </div>

          <div class="edit-field">
            <span>{t("分组")}</span>
            <select class="shelf-select" bind:value={editGroupId}>
              <option value="">{t("（未分组）")}</option>
              {#each facets.groups as g (g.id)}
                <option value={g.id}>{g.name}</option>
              {/each}
            </select>
          </div>

          <div class="edit-field">
            <span>{t("标签（回车或逗号添加）")}</span>
            <div class="edit-tag-box">
              {#each editTags as t}
                <span class="edit-tag-chip">
                  {t}
                  <button class="edit-tag-del" title={T("移除")} on:click={() => dropEditTag(t)}><span class="reword-shelf-ico reword-shelf-ico--xs">{@html SEL_ICONS.cancel}</span></button>
                </span>
              {/each}
              <input
                class="edit-tag-input"
                bind:value={editTagInput}
                placeholder={editTags.length ? "" : t("输入标签…")}
                on:keydown={onEditTagKey}
                on:blur={addEditTag}
              />
            </div>
            {#if facets.tags.length}
              <div class="shelf-sb-tags">
                {#each facets.tags as t (t.tag)}
                  <button
                    class="shelf-tag-chip"
                    on:click={() => {
                      if (!editTags.includes(t.tag)) editTags = [...editTags, t.tag];
                    }}>{t.tag}</button
                  >
                {/each}
              </div>
            {/if}
          </div>

          <!-- [2026-08-29] P2:macOS 风格 7 色 swatch -->
          <div class="edit-field">
            <span>{t("颜色")}</span>
            <div class="shelf-swatch-row">
              {#each BOOK_COLORS as c}
                <button
                  type="button"
                  class="shelf-swatch"
                  class:on={editColor === c.token}
                  style="--swatch-color: {c.hex}"
                  title={t(c.label)}
                  aria-label={t(c.label)}
                  on:click={() => (editColor = editColor === c.token ? undefined : c.token)}
                ></button>
              {/each}
            </div>
            {#if editColor}
              <button
                type="button"
                class="shelf-swatch-clear"
                on:click={() => (editColor = undefined)}
              ><span class="reword-shelf-ico reword-shelf-ico--xs reword-shelf-ico--t">{@html SEL_ICONS.cancel}</span>{t("移除颜色")}</button>
            {/if}
          </div>
        </div>

        <div class="edit-actions">
          <button class="bookshelf-import-btn" on:click={saveEdit}>{t("保存")}</button>
          <button class="import-fail-close" on:click={() => (editTarget = null)}>{t("取消")}</button>
        </div>
      </div>
    </div>
  {/if}

  <!-- A · 阅读统计可视化：模态面板（自身已含 edit-mask 遮罩） -->
  {#if showStats}
    <ReadingStatsPanel {store} on:close={() => (showStats = false)} />
  {/if}

  <!-- B · 在线书源（OPDS）：模态面板（自身已含 edit-mask 遮罩） -->
  {#if showOpds}
    <OpdsSearchPanel {store} onOpenBook={onOpen} on:close={() => (showOpds = false)} />
  {/if}

  <!-- C · 阅读知识图谱 / 画布联动：模态面板（自身已含 edit-mask 遮罩） -->
  {#if showGraph}
    <GraphPanel {store} {onOpen} on:close={() => (showGraph = false)} />
  {/if}

  <!-- 封面替换用的隐藏 input：必须位于主导入 input 之后（源码顺序） -->
  <input
    bind:this={coverInput}
    type="file"
    accept="image/*"
    style="display:none"
    on:change={onCoverChosen}
  />

  <!-- [2026-08-29] P2:右键菜单(单例,按需打开) -->
  {#if ctxMenu}
    <BookshelfContextMenu
      items={ctxMenu.items}
      x={ctxMenu.x}
      y={ctxMenu.y}
      on:close={closeCtxMenu}
    />
  {/if}

  <!-- 2026-10-10：快捷键提示面板（与 ReaderView 共用同一个 ReaderHint.svelte 组件） -->
  <ReaderHint visible={showHint} groups={hintGroups} onClose={() => (showHint = false)} />
</div>

<style>
  .bookshelf-view {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }
  .bookshelf-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.1));
    flex-shrink: 0;
  }
  .bookshelf-title {
    font-size: 14px;
    font-weight: 500;
    color: var(--b3-theme-on-background, #333);
  }
  .bookshelf-count {
    font-size: 12px;
    color: var(--b3-theme-on-surface-light, #888);
  }
  .bookshelf-spacer {
    flex: 1;
  }
  .bookshelf-import-btn {
    /* 2026-10-11 P1：按钮里多了内联 SVG，不再是纯文字 —— 必须自己声明居中，
       否则 svg 按基线排，比「导入」两个字矮 2~3px 且贴在一起 */
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: var(--b3-theme-primary, #378add);
    color: var(--b3-theme-on-primary, #fff);
    border: none;
    border-radius: 6px;
    padding: 5px 12px;
    font-size: 13px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .bookshelf-import-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .bookshelf-error {
    padding: 6px 12px;
    font-size: 12px;
    color: var(--b3-theme-error, #e24b4a);
    white-space: pre-wrap;
    background: var(--b3-theme-error-light, rgba(226, 75, 74, 0.08));
    border-bottom: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.1));
  }
  /* 拖拽高亮遮罩 */
  .bookshelf-view.dragging .bookshelf-dropzone {
    position: absolute;
    inset: 6px;
    z-index: 30;
    border: 2px dashed var(--b3-theme-primary, #378add);
    border-radius: 12px;
    background: rgba(55, 138, 221, 0.08);
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
  }
  .bookshelf-dropzone-inner {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    font-size: 15px;
    font-weight: 500;
    color: var(--b3-theme-primary, #378add);
  }
  /* 尺寸由全局 .reword-shelf-ico--xl（32px）负责，这里只管存在感 */
  .bookshelf-dropzone-icon {
    opacity: 0.55;
  }
  .bookshelf-dropzone-hint {
    font-size: 12px;
    font-weight: 400;
    color: var(--b3-theme-on-surface-light, #888);
  }
  /* 批量进度条 */
  .import-progress {
    padding: 8px 12px;
    border-bottom: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.08));
    flex-shrink: 0;
  }
  .import-progress-text {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    font-size: 12px;
    color: var(--b3-theme-on-background, #333);
    margin-bottom: 6px;
  }
  .import-progress-name {
    color: var(--b3-theme-on-surface-light, #888);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .import-progress-track {
    height: 5px;
    border-radius: 3px;
    background: var(--b3-theme-background-light, rgba(0, 0, 0, 0.08));
    overflow: hidden;
  }
  .import-progress-bar {
    height: 100%;
    border-radius: 3px;
    background: var(--b3-theme-primary, #378add);
    transition: width 0.2s;
  }
  /* toast */
  .import-toast {
    position: absolute;
    left: 50%;
    bottom: 14px;
    transform: translateX(-50%);
    /* 原 `rgba(30,30,30,.92)` + `#fff` 是**写死的深色**：浅色主题下它是一块突兀的
       黑胶囊，深色主题下又和界面底色糊在一起。改成主题面漆 + 描边，随主题走。 */
    background: var(--b3-theme-surface, #333);
    color: var(--b3-theme-on-background, #333);
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.15));
    font-size: 12px;
    padding: 6px 14px;
    border-radius: 8px;
    z-index: 40;
    white-space: nowrap;
    box-shadow: var(--reword-elev-2, 0 2px 10px rgba(0, 0, 0, 0.18));
  }
  /* ---- [2026-10-11 B2] 生效筛选 chip 行 ---- */
  /* 替代工具栏原来那颗「清除筛选」：这里能看见**清了什么**，✕ 逐项清、右侧一键全清。
     静态胶囊走中性灰底（同 .row-group-chip 的既定决策）—— 语义色由侧栏承载，
     胶囊再染主色会和「选中态」抢语言。
     ⚠️ 这段必须排在下面的 @container 之前：容器查询与基础规则同权重，同权重按顺序后者胜，
     写在后面会让窄容器里的 padding 覆盖失效（.shelf-continue 踩过同一个坑）。 */
  .shelf-chips {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    padding: 10px 18px 0;
  }
  .shelf-chip {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    max-width: 220px;
    padding: 2px 4px 2px 7px;
    font-size: 11px;
    color: var(--b3-theme-on-surface, #333);
    background: var(--b3-list-hover, rgba(0, 0, 0, 0.05));
    border-radius: 999px;
  }
  .shelf-chip-label {
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .shelf-chip-x {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: none;
    padding: 0 2px;
    cursor: pointer;
    color: inherit;
    opacity: 0.6;
  }
  .shelf-chip-x:hover {
    opacity: 1;
  }
  .shelf-chips-clear {
    margin-left: auto;
    border: none;
    background: none;
    padding: 2px 4px;
    font-size: 11px;
    cursor: pointer;
    color: var(--b3-theme-primary, #378add);
  }
  .shelf-chips-clear:hover {
    text-decoration: underline;
  }

  .bookshelf-grid {
    display: grid;
    /* 2026-10-13 改版：对齐参考书架的密集网格（宽窗 ~8 列观感）。
       158 → 200：文字区收成两行后信息变少，158 档卡片显碎；间距同步拉大。
       窄容器仍有 88/112 两档覆盖（见下面 @container）。 */
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 36px 30px;
    padding: 16px 18px 28px;
    align-content: start;
  }
  /* 容器查询：右侧主区域变窄时自动缩小封面，避免 1–2 列被拉得很大 */
  @container shelf-main (max-width: 360px) {
    .bookshelf-grid {
      grid-template-columns: repeat(auto-fill, minmax(88px, 1fr));
      gap: 12px;
      padding: 12px;
    }
    .shelf-chips {
      padding: 8px 12px 0;
    }
    .book-cover {
      border-radius: 8px;
    }
  }
  @container shelf-main (min-width: 361px) and (max-width: 520px) {
    .bookshelf-grid {
      grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));
      gap: 14px;
      padding: 14px;
    }
    .shelf-chips {
      padding: 8px 14px 0;
    }
  }
  .book-card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
    transition: transform 0.15s ease;
  }
  .book-card:hover {
    /* 2026-10-11 B3：-2px → -3px。2px 在密集网格里会被相邻卡片的阴影吃掉，
       看起来像「抖了一下」；3px + L3 阴影才读得出是被抬起来了。 */
    transform: translateY(-3px);
  }
  .book-cover {
    position: relative;
    aspect-ratio: 3 / 4;
    border-radius: 10px;
    border: none;
    cursor: pointer;
    background: var(--reword-cover-grad, linear-gradient(160deg, #185fa5, #0c447c));
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    /* L2 悬浮物（见 bookshelf-tokens.less）。原来 `0 2px 8px rgba(0,0,0,.12)`
       是这屏唯一的阴影层，四周界面都没有对应层 —— 一张纸浮在桌上看不出来，
       这就是「扁平、没层次」的实测主因之一。 */
    box-shadow: var(--reword-elev-2, 0 2px 8px rgba(0, 0, 0, 0.12));
    transition: box-shadow 0.2s ease;
  }
  .book-card:hover .book-cover {
    /* L3，和 translateY(-2px) 一起抬 */
    box-shadow: var(--reword-elev-3, 0 8px 20px rgba(0, 0, 0, 0.18));
  }
  .book-cover-text {
    font-size: 22px;
    font-weight: 500;
    color: rgba(255, 255, 255, 0.92);
  }
  .book-cover-img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .book-info {
    min-width: 0;
  }
  .book-name {
    font-size: 13px;
    font-weight: 600;
    line-height: 1.35;
    color: var(--b3-theme-on-background, #333);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* 2026-10-13 改版：文字区第二行 —— 状态/进度。固定一行高（18px）：
     「未读 / xx% / 读完钉」三种形态互换时卡片高度零位移。 */
  .book-sub {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
    min-height: 18px;
  }
  .book-progress {
    font-size: 12px;
    color: var(--b3-theme-on-surface-light, #888);
  }
  /* 读完 = 绿钉（对齐参考书架的「已读」形态；底色是同一支绿的淡色） */
  .book-done {
    font-size: 11px;
    line-height: 1.5;
    padding: 0 6px;
    border-radius: 4px;
    background: rgba(58, 166, 117, 0.14);
    color: #3aa675;
  }
  /* 2026-08-29 网格视图：操作按钮收纳到封面悬停层 */
  .book-cover-overlay {
    position: absolute;
    inset: 0;
    border-radius: 10px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    padding: 10px;
    background: var(--reword-cover-scrim, linear-gradient(to top, rgba(0, 0, 0, 0.55) 0%, rgba(0, 0, 0, 0.22) 45%, transparent 80%));
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.18s ease;
  }
  .book-card:hover .book-cover-overlay,
  .book-cover-overlay:focus-within {
    opacity: 1;
    pointer-events: auto;
  }
  .book-overlay-primary {
    width: 100%;
    border: none;
    border-radius: 8px;
    padding: 7px 0;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    background: var(--b3-theme-surface, #fff);
    color: var(--b3-theme-on-surface, #222);
    box-shadow: var(--reword-elev-2, 0 2px 6px rgba(0, 0, 0, 0.18));
    transition: transform 0.1s ease, background 0.15s ease;
  }
  .book-overlay-primary:hover {
    background: var(--b3-theme-primary, #378add);
    color: var(--b3-theme-on-primary, #fff);
  }
  .book-overlay-primary:active {
    transform: scale(0.98);
  }
  .book-overlay-tools {
    display: flex;
    gap: 8px;
    justify-content: center;
  }
  .book-icon-btn {
    width: 28px;
    height: 28px;
    border: none;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    font-size: 13px;
    line-height: 1;
    background: var(--b3-theme-surface, rgba(255, 255, 255, 0.92));
    color: var(--b3-theme-on-surface, #333);
    box-shadow: var(--reword-elev-2, 0 1px 4px rgba(0, 0, 0, 0.18));
    transition: background 0.15s ease, transform 0.1s ease;
  }
  .book-icon-btn:hover {
    background: var(--b3-theme-surface, #fff);
    transform: translateY(-1px);
  }
  .book-icon-btn.danger:hover {
    background: var(--b3-theme-error, #e24b4a);
    color: #fff;
  }
  .book-btn {
    flex: 1;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.15));
    background: none;
    border-radius: 6px;
    padding: 4px 0;
    font-size: 12px;
    cursor: pointer;
    color: var(--b3-theme-on-background, #333);
  }
  .book-btn:hover {
    filter: brightness(0.94);
  }
  .bookshelf-empty {
    grid-column: 1 / -1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 48px 0;
  }
  /* 2026-10-11 B3：空态图形（32px 由 --xl 档负责），与拖拽遮罩同一枚 icon
     同一套「主色 + 0.55 透明」语言 —— 两处出现同一个空书架，样式要说得通。 */
  .bookshelf-empty-icon {
    opacity: 0.55;
    color: var(--b3-theme-primary, #378add);
    margin-bottom: 2px;
  }
  .bookshelf-empty-title {
    font-size: 14px;
    font-weight: 500;
    color: var(--b3-theme-on-background, #333);
  }
  .bookshelf-empty-hint {
    font-size: 12px;
    color: var(--b3-theme-on-surface-light, #888);
    text-align: center;
  }
  /* 失败汇总 */
  .import-fail-mask,
  :global(.edit-mask) {
    position: fixed;
    inset: 0;
    z-index: 50;
    background: rgba(0, 0, 0, 0.35);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .import-fail-panel,
  :global(.edit-panel) {
    width: min(320px, 88%);
    max-height: 80%;
    background: var(--b3-theme-background, #fff);
    border-radius: 12px;
    padding: 16px;
    box-shadow: var(--reword-elev-3, 0 8px 32px rgba(0, 0, 0, 0.22));
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .import-fail-title,
  :global(.edit-title) {
    font-size: 14px;
    font-weight: 500;
    color: var(--b3-theme-on-background, #333);
  }
  .import-fail-list {
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 240px;
  }
  .import-fail-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
    background: var(--b3-theme-background-light, rgba(0, 0, 0, 0.04));
    border-radius: 6px;
    padding: 6px 8px;
  }
  .import-fail-name {
    font-size: 12px;
    color: var(--b3-theme-on-background, #333);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .import-fail-reason {
    font-size: 11px;
    color: var(--b3-theme-error, #e24b4a);
  }
  .import-fail-actions,
  .edit-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
  .import-fail-close {
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.15));
    background: none;
    border-radius: 6px;
    padding: 5px 12px;
    font-size: 13px;
    cursor: pointer;
    color: var(--b3-theme-on-background, #333);
  }
  .remove-desc {
    font-size: 13px;
    color: var(--b3-theme-on-background, #333);
  }
  .remove-check {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--b3-theme-on-surface-light, #888);
    cursor: pointer;
    user-select: none;
  }
  .remove-check input {
    accent-color: var(--b3-theme-error, #e24b4a);
  }
  .remove-danger {
    background: var(--b3-theme-error, #e24b4a);
  }
  .edit-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--b3-theme-on-surface-light, #888);
  }
  .edit-field input {
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.15));
    border-radius: 6px;
    padding: 6px 8px;
    font-size: 13px;
    background: var(--b3-theme-background, #fff);
    color: var(--b3-theme-on-background, #333);
    outline: none;
  }
  .edit-field input:focus {
    border-color: var(--b3-theme-primary, #378add);
  }

  /* ================================================================
   * 2026-08-29 书架 P2：macOS 风格 7 色 swatch / 色点 / 组 chip
   * ================================================================ */

  /* ---- 编辑弹窗 / 分组管理弹窗 swatch 容器 ---- */
  .shelf-swatch-row {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .shelf-swatch {
    width: 28px;
    height: 28px;
    border-radius: 4px;
    border: 2px solid transparent;
    background: var(--swatch-color, #888);
    cursor: pointer;
    padding: 0;
    transition: transform 0.1s ease, box-shadow 0.1s ease;
  }
  .shelf-swatch:hover {
    transform: scale(1.08);
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);
  }
  .shelf-swatch.on {
    border-color: var(--b3-theme-primary, #378add);
    box-shadow: 0 0 0 1px #fff inset, 0 2px 6px rgba(0, 0, 0, 0.2);
  }
  .shelf-swatch-clear {
    font-size: 12px;
    color: var(--b3-theme-on-surface-light, #888);
    background: none;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.15));
    border-radius: 4px;
    padding: 3px 8px;
    cursor: pointer;
  }
  .shelf-swatch-clear:hover {
    background: var(--b3-list-hover, rgba(0, 0, 0, 0.05));
  }

  /* ---- 网格卡片色点(左下) ---- */
  /* 2026-10-11 B1：右上整块让给收藏星，色点移到左下；下沿 8px 保持呼吸
     （封面进度条 2026-10-13 已下线，进度只留在文字行）。 */
  .book-color-dot {
    position: absolute;
    bottom: 8px;
    left: 8px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--swatch-color, #888);
    box-shadow: 0 0 0 1px var(--b3-border-color, rgba(0, 0, 0, 0.15)), 0 1px 2px rgba(0, 0, 0, 0.2);
    z-index: 2;
    pointer-events: auto;
    transition: opacity 0.15s ease;
  }
  /* hover 时封面要腾给悬停层（scrim + 续读按钮）：色点淡出，
     否则就是 §2.3 那类叠字事故。进度条 2026-10-13 已下线（进度只留在文字行）。 */
  .book-cover-wrap:hover .book-color-dot {
    opacity: 0;
  }
  /* 列表行色点(标题后) */
  .row-color-dot {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--swatch-color, #888);
    box-shadow: 0 0 0 1px var(--b3-border-color, rgba(0, 0, 0, 0.12));
    flex-shrink: 0;
  }

  /* ---- 列表行组 chip ---- */
  /* 静态胶囊走中性灰底：分组/标签的语义色已经由色点承载，胶囊本身再叠主色
     会与「选中态」的主色淡底打架（见 docs/书架美化-设计方案.md §五 #1）。 */
  .row-group-chip {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 11px;
    color: var(--b3-theme-on-surface-light, #888);
    background: var(--b3-list-hover, rgba(0, 0, 0, 0.05));
    padding: 1px 6px;
    border-radius: 3px;
    flex-shrink: 0;
  }
  .row-group-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--swatch-color, #888);
  }

  /* ---- 侧边栏分组色点 + 编辑入口 ---- */
  .shelf-sb-item.shelf-sb-group {
    display: flex;
    align-items: center;
    gap: 0;
    width: 100%;
    cursor: pointer;
  }
  .shelf-sb-color {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--swatch-color, transparent);
    margin-left: 4px;
    margin-right: 2px;
    flex-shrink: 0;
    box-shadow: 0 0 0 1px var(--b3-border-color, rgba(0, 0, 0, 0.1));
  }
  .shelf-sb-color.has {
    box-shadow: none;
  }
  .shelf-sb-edit,
  .shelf-sb-colorbtn {
    font-size: 11px;
    line-height: 1;
    width: 18px;
    height: 18px;
    border: none;
    background: none;
    color: var(--b3-theme-on-surface-light, #888);
    cursor: pointer;
    padding: 0;
    border-radius: 3px;
    flex-shrink: 0;
    margin-left: 2px;
    opacity: 0;
    transition: opacity 0.15s ease;
  }
  .shelf-sb-item.shelf-sb-group:hover .shelf-sb-edit,
  .shelf-sb-item.shelf-sb-group:hover .shelf-sb-colorbtn {
    opacity: 1;
  }
  .shelf-sb-edit:hover,
  .shelf-sb-colorbtn:hover {
    background: var(--b3-theme-primary-lightest, rgba(55, 138, 221, 0.18));
    color: var(--b3-theme-on-background, #333);
  }
  .shelf-sb-item.shelf-sb-group:hover .shelf-sb-label {
    text-decoration: underline dashed;
    text-underline-offset: 2px;
    cursor: text;
  }
  .shelf-sb-item.shelf-sb-group .shelf-sb-rename {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    padding: 3px 6px;
    margin: -2px 0;
    pointer-events: auto;
  }
  .shelf-sb-item.shelf-sb-group .shelf-sb-rename + .group-op {
    margin-left: 4px;
    padding: 2px 4px;
    font-size: 11px;
    flex-shrink: 0;
  }

  /* ---- 侧边栏 swatch 区块(颜色筛选) ---- */
  .shelf-sb-swatches {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 4px 4px 0;
    flex-wrap: wrap;
  }
  .shelf-sb-swatch {
    position: relative;
    width: 22px;
    height: 22px;
    border-radius: 4px;
    border: 2px solid transparent;
    background: var(--swatch-color, #888);
    cursor: pointer;
    padding: 0;
    transition: transform 0.1s ease;
  }
  .shelf-sb-swatch:hover {
    transform: scale(1.1);
  }
  .shelf-sb-swatch.on {
    border-color: var(--b3-theme-primary, #378add);
    box-shadow: 0 0 0 1px #fff inset;
  }
  .shelf-sb-swatch-num {
    position: absolute;
    bottom: -14px;
    left: 50%;
    transform: translateX(-50%);
    font-size: 9px;
    color: var(--b3-theme-on-surface-light, #888);
    line-height: 1;
    pointer-events: none;
  }

  /* ---- 分组管理弹窗色点 + popover ---- */
  .group-color-dot {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--swatch-color, transparent);
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.2));
    cursor: pointer;
    padding: 0;
    flex-shrink: 0;
  }
  .group-color-dot.has {
    border-color: transparent;
  }
  .group-color-pop {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 8px;
    background: var(--b3-theme-background, #fff);
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.12));
    border-radius: 6px;
    margin-top: 4px;
    width: 100%;
    flex-wrap: wrap;
  }

  /* ---- 列表行 J/K 焦点高亮 ---- */
  .shelf-row.focused {
    outline: 2px solid var(--b3-theme-primary, #378add);
    outline-offset: -2px;
  }

  /* ================================================================
   * 2026-08-29 书架 P0/P1：工具栏 / 侧栏 / 列表视图 / 批量 / 编辑扩展
   * 全部走 --b3-* 变量，自动跟随思源浅色/深色主题
   * ================================================================ */

  /* ---- 通用小按钮 ---- */
  .shelf-icon-btn {
    border: 1px solid transparent;
    background: none;
    border-radius: 6px;
    /* 26 → 28：里面那枚图标从 16px 提到 18px（--btn 档），
       26px 的盒子只剩 4px 内边距，图标会顶着边框反而显得小 */
    width: 28px;
    height: 28px;
    line-height: 1;
    font-size: 13px;
    cursor: pointer;
    /* 原来是 on-surface-light（≈#888）：1.35px 笔画的线条图标配次要文本色，
       真机上就是「若有若无」——这是那声「还是纤细」的另一半原因，
       前一半在尺寸档。图标按非文本对比度 3:1 走，on-surface 七套主题都远超。 */
    color: var(--b3-theme-on-surface, #333);
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .shelf-icon-btn:hover {
    background: var(--b3-list-hover, rgba(0, 0, 0, 0.05));
    color: var(--b3-theme-on-background, #333);
  }
  .shelf-icon-btn.active {
    background: var(--b3-theme-primary-lightest, rgba(55, 138, 221, 0.14));
    border-color: var(--b3-theme-primary, #378add);
    color: var(--b3-theme-on-background, #333);
  }

  /* ---- 顶栏「续读」：与「导入」同一套实心主色 ----
     2026-10-11 用户两连反馈定稿：先修好「顺序被简写重置」的边框 bug，真机上
     「描边 + 灰底 + 深色字」仍是三色混搭，明确要求「做成跟导入一样」。
     原方案「两块实心主色互相抵消」的顾虑在这里不成立 —— 两个 CTA 分居顶栏两端，
     中间隔着四枚图标按钮，不构成并排竞争。
     ⚠️ 这段必须排在 .shelf-icon-btn 之后：那条基础规则里的 `border` / `background`
     是简写，同权重下按文件顺序后者胜，写前面会被重置成 transparent / none
     （2026-10-11 真机：续读显示成一颗「没有边框的蓝图标文字」就是踩了这个）。
     ⚠️ height 与 line-height 必须一起覆盖：基础类是 `height:28px; line-height:1`，
     而导入没有定高，靠继承行高撑出高度（SiYuan 的 body line-height:1.5 ⇒ 13px × 1.5
     + 上下 padding = 约 29.5px）。漏掉 `line-height:inherit` 只改高度，看起来就是
     两颗按钮差半个边——`inherit` 让它们**同源同高**，主题换字号也一起变。
     ⚠️ hover 必须自己写：`.shelf-icon-btn:hover` 会把底换成 --b3-list-hover（灰），
     实心蓝 hover 变灰是明显的错帧。用 filter —— 与 .row-btn 同款，
     也避开审计 R2（--b3-theme-primary-light 不许当交互态底色）。
     ⚠️ margin-right 6px：与右侧那撮纯图标按钮多拉开一点（header 的 gap 是 10px，
     加上去 16px）。 */
  .shelf-continue {
    width: auto;
    height: auto;
    line-height: inherit;
    padding: 5px 12px;
    gap: 4px;
    margin-right: 6px;
    white-space: nowrap;
    border: none;
    background: var(--b3-theme-primary, #378add);
    color: var(--b3-theme-on-primary, #fff);
  }
  .shelf-continue:hover {
    background: var(--b3-theme-primary, #378add);
    color: var(--b3-theme-on-primary, #fff);
    filter: brightness(0.94);
  }

  /* ---- 工具栏 ---- */
  .shelf-toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.08));
    flex-shrink: 0;
    flex-wrap: wrap;
  }
  .shelf-search {
    position: relative;
    display: flex;
    align-items: center;
    /* 原来是 flex:1 —— 在窄 dock 里搜索框会顶满整行，把排序、视图切换挤到第二行，
       工具栏就成了「一大条 + 一小撮」。给它一个有上限的弹性：够打字，不抢整行。 */
    flex: 1 1 220px;
    min-width: 140px;
    max-width: 300px;
  }
  .shelf-search-icon {
    position: absolute;
    left: 7px;
    /* 内联 SVG 不吃 font-size，绝对定位又没有行盒可对齐 —— 只能自己居中，
       否则图标会贴着搜索框上沿 */
    top: 50%;
    transform: translateY(-50%);
    opacity: 0.55;
    pointer-events: none;
  }
  .shelf-search-input {
    width: 100%;
    /* 「白底 + 边框」让搜索框看起来和它旁边的按钮同一权重，反而不像输入区；
       中性灰底无边框 = 形状自己说明自己是输入区，focus 才恢复底色和描边。
       （--b3-list-hover 是七套主题都有定义的 sanctioned 中性填充，ΔRGB 29.6） */
    border: 1px solid transparent;
    border-radius: 6px;
    padding: 5px 24px 5px 24px;
    font-size: 12px;
    background: var(--b3-list-hover, rgba(0, 0, 0, 0.05));
    color: var(--b3-theme-on-background, #333);
    outline: none;
  }
  .shelf-search-input:focus {
    background: var(--b3-theme-background, #fff);
    border-color: var(--b3-theme-primary, #378add);
  }
  .shelf-search-clear {
    position: absolute;
    right: 4px;
    top: 50%;
    transform: translateY(-50%);
    display: inline-flex;
    align-items: center;
    border: none;
    background: none;
    cursor: pointer;
    font-size: 11px;
    color: var(--b3-theme-on-surface-light, #888);
    padding: 2px 4px;
  }
  /* 2026-10-11 B1：与搜索框同一套「无边框 + 中性灰底」语言 ——
     工具栏上不该并存三种控件样式（搜索 / 排序 / 批量）。focus 恢复底色与描边。 */
  .shelf-select {
    border: 1px solid transparent;
    border-radius: 6px;
    padding: 4px 6px;
    font-size: 12px;
    background: var(--b3-list-hover, rgba(0, 0, 0, 0.05));
    color: var(--b3-theme-on-background, #333);
    cursor: pointer;
    max-width: 110px;
    outline: none;
  }
  .shelf-select:focus {
    background: var(--b3-theme-background, #fff);
    border-color: var(--b3-theme-primary, #378add);
  }
  .shelf-select:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .shelf-view-toggle {
    display: flex;
    gap: 2px;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.12));
    border-radius: 7px;
    padding: 1px;
  }
  /* 2026-10-11 B1：视图切换的选中格 = 实心主色单元格。
     原来复用的 .shelf-icon-btn.active（淡主色底 + 主色描边）在 Asri/Neo 下
     和 hover 灰底区分度不够（B0 §8.4 遗留项）；这两颗是**分段的单选**，
     比「一排图标里高亮一颗」更需要一眼看出选中哪格。
     权重 (0,3,0) 高于 .shelf-icon-btn:hover (0,2,0)，hover 也要自己写。 */
  .shelf-view-toggle .shelf-icon-btn.active {
    background: var(--b3-theme-primary, #378add);
    border-color: var(--b3-theme-primary, #378add);
    color: var(--b3-theme-on-primary, #fff);
  }
  .shelf-view-toggle .shelf-icon-btn.active:hover {
    background: var(--b3-theme-primary, #378add);
    color: var(--b3-theme-on-primary, #fff);
    filter: brightness(0.94);
  }

  /* ---- 批量操作条 ---- */
  /* 只有「选中态」这一层用主色淡底（lightest，ΔRGB 26~38），
     原来的 primary-light 在 Neo/Asri 下是实心蓝带，按钮全糊进去。 */
  .shelf-batch-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background: var(--b3-theme-primary-lightest, rgba(55, 138, 221, 0.1));
    border-bottom: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.08));
    flex-shrink: 0;
    flex-wrap: wrap;
  }
  .shelf-batch-count {
    font-size: 12px;
    font-weight: 600;
    color: var(--b3-theme-on-background, #333);
  }
  .shelf-batch-btn {
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.15));
    background: var(--b3-theme-background, #fff);
    border-radius: 6px;
    padding: 4px 8px;
    font-size: 12px;
    cursor: pointer;
    color: var(--b3-theme-on-background, #333);
  }
  .shelf-batch-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .shelf-batch-btn.danger {
    color: var(--b3-theme-error, #e24b4a);
    border-color: var(--b3-theme-error, #e24b4a);
  }

  /* ---- 主体：侧栏 + 内容 ---- */
  .bookshelf-body {
    flex: 1;
    display: flex;
    min-height: 0;
    overflow: hidden;
  }

  /* ================================================================
   * 2026-10-24 移动端适配 Phase 3：书架手机端（re-phone）
   * ================================================================
   * ① 分组侧栏 → overlay 左抽屉（inline 宽度需 !important 压过）+ 遮罩；
   * ② resizer / 拖拽是桌面交互，隐藏；
   * ③ header 一行 9 组控件必然溢出 → 横向滚动（隐藏滚动条，视觉仍是单行）；
   * ④ 卡片 ⋯ 菜单按钮：桌面隐藏、手机常显（触屏操作入口）。 */
  .bookshelf-view.re-phone .bookshelf-body {
    position: relative;
  }
  .bookshelf-view.re-phone .shelf-sidebar {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: min(78vw, 320px) !important;
    max-width: 85%;
    z-index: 30;
    background: var(--b3-theme-background, #fff);
    box-shadow: 0 0 24px rgba(0, 0, 0, 0.2);
    animation: shelf-drawer-in 180ms ease-out;
  }
  .bookshelf-view.re-phone .shelf-side-resizer {
    display: none;
  }
  .shelf-sb-backdrop {
    position: absolute;
    inset: 0;
    z-index: 29;
    background: rgba(0, 0, 0, 0.35);
  }
  @keyframes shelf-drawer-in {
    from { transform: translateX(-30%); opacity: 0; }
    to   { transform: translateX(0);    opacity: 1; }
  }
  .bookshelf-view.re-phone .bookshelf-header {
    overflow-x: auto;
    scrollbar-width: none;
  }
  .bookshelf-view.re-phone .bookshelf-header::-webkit-scrollbar {
    display: none;
  }
  .bookshelf-view.re-phone .bookshelf-header > * {
    flex-shrink: 0;
  }
  .book-more-btn {
    display: none;
    align-items: center;
    justify-content: center;
    min-width: 32px;
    min-height: 32px;
    border: none;
    border-radius: 50%;
    background: none;
    color: var(--b3-theme-on-background, #333);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
  }
  .bookshelf-view.re-phone .book-more-btn {
    display: inline-flex;
  }
  /* 2026-10-25 移动端适配 C4：视觉降权——封面右下半透明毛玻璃小圆钮。
     旧版是封面左上 45% 黑底方块（真机截图突兀、且 32px 命中区压在滑动路径上）。 */
  .book-cover-wrap .book-more-btn {
    position: absolute;
    right: 6px;
    bottom: 6px;
    z-index: 3;
    background: color-mix(in srgb, var(--b3-theme-surface, #fff) 72%, transparent);
    -webkit-backdrop-filter: blur(8px);
    backdrop-filter: blur(8px);
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.12));
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.18);
    color: var(--b3-theme-on-surface, #555);
  }
  @supports not (color: color-mix(in srgb, red, blue)) {
    .book-cover-wrap .book-more-btn {
      background: var(--b3-theme-surface, #fff);
    }
  }
  .bookshelf-view.re-phone .row-more-btn {
    min-width: 36px;
    min-height: 36px;
    background: none;
    color: var(--b3-theme-on-surface, #555);
    font-size: 18px;
  }
  /* 拖动中：整块区域显示 col-resize，顺手禁掉选字 */
  .bookshelf-body.side-resizing {
    cursor: col-resize;
    user-select: none;
  }
  .bookshelf-body.side-resizing .shelf-sidebar {
    transition: none;
  }
  .shelf-sidebar {
    /* 宽度是响应式 inline style（可拖，见 sideWidth / SIDE_W_*），这里只管行为 */
    flex-shrink: 0;
    /* 再宽也得给主区留位置；与脚本里的 SHELF_MAIN_MIN 同值 */
    max-width: calc(100% - 240px);
    overflow-y: auto;
    padding: 12px 10px;
    border-right: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.08));
    display: flex;
    flex-direction: column;
    gap: 14px;
    transition: width 120ms ease;
  }
  /* 压在 border-right 上的细长把手：默认完全透明，看起来仍只是那条线 */
  .shelf-side-resizer {
    position: relative;
    z-index: 2;
    flex: 0 0 7px;
    width: 7px;
    margin-left: -4px;
    cursor: col-resize;
    touch-action: none;
    background: none;
    border: none;
    padding: 0;
  }
  .shelf-side-resizer::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 2px;
    width: 4px;
    border-radius: 2px;
    background: transparent;
  }
  .shelf-side-resizer:hover::after,
  .shelf-side-resizer:focus-visible::after,
  .shelf-side-resizer.resizing::after {
    background: var(--b3-theme-primary-lightest, rgba(55, 138, 221, 0.22));
  }
  .shelf-side-resizer:focus-visible {
    outline: none;
  }
  .shelf-main {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    /* 2026-10-25 移动端适配 C2/C5：滚动收敛 + 滚动声明。
       contain：滚到头/底不把滚动链传给宿主 Dialog（手机滑动"生涩/串动"体感来源之一）；
       pan-y：纵向滚动明确交给浏览器合成器（更跟手），横向手势不被卡片拦截。 */
    overscroll-behavior: contain;
    touch-action: pan-y;
    container-type: inline-size;
    container-name: shelf-main;
  }
  .shelf-sb-block {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  /* 块与块之间补一道极淡的分隔：侧栏原来是「一串等距的行」，
     范围 / 状态 / 分组 / 标签几块之间看不出边界，gap 只给了距离没给出结构。
     线上留 14px（就是 flex gap）、线下只 2px —— 分隔线要贴着它引入的那个小标题，
     居中就把「线」变成了「另一行的开头」。 */
  .shelf-sb-block + .shelf-sb-block {
    padding-top: 2px;
    border-top: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.06));
  }
  .shelf-sb-title {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--b3-theme-on-surface-light, #999);
    padding: 7px 4px 4px;
    margin-top: 2px;
  }
  .shelf-sb-title.toggle {
    border: none;
    background: none;
    width: 100%;
    text-align: left;
    cursor: pointer;
    color: inherit;
  }
  .shelf-sb-title.toggle:hover {
    color: var(--b3-theme-on-background, #333);
  }
  .shelf-sb-toggle {
    border: none;
    background: none;
    cursor: pointer;
    padding: 0;
    width: 14px;
    height: 14px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--b3-theme-on-surface-light, #999);
    flex-shrink: 0;
  }
  .shelf-sb-caret {
    font-size: 9px;
    line-height: 1;
    transition: transform 0.15s ease;
    display: inline-block;
  }
  .shelf-sb-caret.closed {
    transform: rotate(-90deg);
  }
  .shelf-sb-title-text {
    cursor: pointer;
    user-select: none;
    flex: 1;
  }
  .shelf-sb-add {
    border: none;
    background: none;
    cursor: pointer;
    font-size: 13px;
    line-height: 1;
    color: var(--b3-theme-primary, #378add);
    padding: 0 2px;
  }
  .shelf-sb-item {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    width: 100%;
    border: 1px solid transparent;
    background: none;
    border-radius: 6px;
    padding: 7px 10px;
    font-size: 12px;
    cursor: pointer;
    color: var(--b3-theme-on-background, #333);
    text-align: left;
  }
  .shelf-sb-item:hover {
    background: var(--b3-list-hover, rgba(0, 0, 0, 0.05));
  }
  /* 选中态：淡底 + 字重 + 左侧主色竖条。
   * 文字**不**染主色 —— `--b3-theme-primary` 压 `primary-lightest` 实测 CR 2.97~3.65，
   * 低于正文的 AA 门槛 4.5；「选中」这件事交给 600 字重和竖条表达，
   * 竖条是图形元素，只受非文本对比度 3:1 约束，主色足够。 */
  .shelf-sb-item.active {
    background: var(--b3-theme-primary-lightest, rgba(55, 138, 221, 0.14));
    color: var(--b3-theme-on-background, #333);
    font-weight: 600;
  }
  .shelf-sb-item.active::before {
    content: "";
    position: absolute;
    left: 0;
    top: 5px;
    bottom: 5px;
    width: 3px;
    border-radius: 0 2px 2px 0;
    background: var(--b3-theme-primary, #378add);
  }
  .shelf-sb-item.dropping {
    border-color: var(--b3-theme-primary, #378add);
    border-style: dashed;
    background: var(--b3-theme-primary-lightest, rgba(55, 138, 221, 0.18));
  }
  .shelf-sb-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .shelf-sb-num {
    min-width: 20px;
    padding: 1px 6px;
    border-radius: 10px;
    text-align: center;
    font-size: 10px;
    font-variant-numeric: tabular-nums;
    color: var(--b3-theme-on-surface-light, #888);
    background: var(--b3-list-hover, rgba(0, 0, 0, 0.05));
    flex-shrink: 0;
  }
  .shelf-sb-item.active .shelf-sb-num {
    /* 原 `rgba(255,255,255,.28)` 只在实心主色底上成立；底色改成淡底后白 pill
       在浅色主题下直接消失，改回跟随行内文字色。 */
    background: transparent;
    color: inherit;
  }
  .shelf-sb-hint {
    font-size: 11px;
    color: var(--b3-theme-on-surface-light, #999);
    padding: 3px 6px;
  }
  .shelf-sb-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 2px 4px;
  }
  .shelf-tag-chip {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.14));
    background: none;
    border-radius: 10px;
    padding: 2px 7px;
    font-size: 11px;
    cursor: pointer;
    color: var(--b3-theme-on-background, #333);
  }
  .shelf-tag-chip:hover {
    background: var(--b3-list-hover, rgba(0, 0, 0, 0.05));
  }
  .shelf-tag-chip.active {
    background: var(--b3-theme-primary-lightest, rgba(55, 138, 221, 0.16));
    border-color: var(--b3-theme-primary, #378add);
    color: var(--b3-theme-on-background, #333);
    font-weight: 600;
  }
  .shelf-tag-num {
    font-size: 9px;
    opacity: 0.65;
  }

  /* ---- 卡片增强 ---- */
  .book-card.selected {
    outline: 2px solid var(--b3-theme-primary, #378add);
    outline-offset: 2px;
    border-radius: 10px;
  }
  .book-cover-wrap {
    position: relative;
    display: flex;
    /* 2026-10-25 防御：封面 img 必须被裁在卡内（真机出现过封面图撑爆布局） */
    overflow: hidden;
    border-radius: 10px;
  }
  .book-cover-wrap .book-cover {
    width: 100%;
  }
  .book-sel,
  .book-fav {
    position: absolute;
    top: 4px;
    border: none;
    border-radius: 50%;
    width: 19px;
    height: 19px;
    line-height: 1;
    font-size: 11px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    /* 2026-10-11 B1：悬停时 .book-cover-overlay 铺满整张封面并指针接管
       （它排在 DOM 更后，z-index auto 下按顺序盖住这两颗按钮）——星标点不到，
       点击落到 overlay 上变成「打开书」。提到悬停层之上让按钮自己接点击。 */
    z-index: 3;
  }
  .book-sel {
    left: 4px;
    background: rgba(255, 255, 255, 0.9);
    color: var(--b3-theme-primary, #378add);
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.15);
  }
  .book-sel.on {
    background: var(--b3-theme-primary, #378add);
    color: var(--b3-theme-on-primary, #fff);
  }
  /* 2026-10-11 B1（对齐 demo 的 .a-fav 策略）：19px 圆 → 24px 圆角方。
     未收藏时只在封面 hover / 键盘聚焦时出现，已收藏常驻 ——
     「收藏态」本身要一眼看得见，而不是每本书都挂一颗灰星把状态淹掉。
     opacity:0 时同时断掉指针，避免隐形按钮截走封面的点击。 */
  .book-fav {
    right: 4px;
    width: 24px;
    height: 24px;
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.35);
    color: rgba(255, 255, 255, 0.85);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.15s ease;
  }
  .book-cover-wrap:hover .book-fav,
  .book-fav:focus-visible,
  .book-fav.on {
    opacity: 1;
    pointer-events: auto;
  }
  .book-fav.on {
    color: #ffc94d;
  }
  /* 笔记发送目标角标（2026-10-09；2026-10-13 从 .book-meta 收进 .book-sub、右对齐）
     —— 纯展示，不响应点击。只显示已绑定，未绑定不做灰色警告。 */
  .book-note-target {
    display: inline-flex;
    align-items: center;
    margin-left: auto;
    color: var(--b3-theme-on-surface-light, #888);
    pointer-events: none; /* 不可点：只作状态标识 */
  }
  /* 2026-10-13 改版：.book-status 三态胶囊随 meta 行下线（网格卡片只留「读完」绿钉
     .book-done）；状态改档走列表视图的 .row-status-chip 与编辑弹窗。 */

  /* ---- 列表视图 ---- */
  .shelf-list {
    display: flex;
    flex-direction: column;
    padding: 6px 12px;
  }
  /* 2026-10-11 B3：固定列栅格（照 demo 的八列模板）。
     列＝选择/色点 · 书名（内含小封面）· 作者 · 格式 · 进度条 · 时长 · 最近阅读 · 操作。
     表头与数据行**共用同一条模板** —— 分两处写的话，改一列要记得改两遍。 */
  .shelf-lhead,
  .shelf-row {
    display: grid;
    grid-template-columns: 26px minmax(200px, 2.4fr) minmax(90px, 1.1fr) 58px 62px minmax(96px, 1fr) 92px auto;
    align-items: center;
    gap: 12px;
  }
  /* 表头自己不承担信息，只把八列讲清楚（demo .a-lhead 的 10.5px / 大字距语言） */
  .shelf-lhead {
    padding: 0 10px 8px;
    font-size: 10.5px;
    font-weight: 650;
    letter-spacing: 0.05em;
    color: var(--b3-theme-on-surface-light, #888);
    border-bottom: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.1));
  }
  .shelf-row {
    position: relative;
    padding: 9px 10px;
    border-bottom: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.06));
    border-radius: 8px;
    min-width: 0;
    transition: background 0.15s ease;
  }
  .shelf-row:hover {
    background: var(--b3-list-hover, rgba(0, 0, 0, 0.04));
  }
  .shelf-row.selected {
    background: var(--b3-theme-primary-lightest, rgba(55, 138, 221, 0.1));
  }
  .shelf-row.selected::before {
    content: "";
    position: absolute;
    left: 0;
    top: 6px;
    bottom: 6px;
    width: 3px;
    border-radius: 0 2px 2px 0;
    background: var(--b3-theme-primary, #378add);
  }
  /* 第 1 列：勾选框 / 色点共用一格，列数不随多选模式变化 */
  .row-lead {
    display: flex;
    align-items: center;
    min-width: 0;
  }
  .row-sel {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.2));
    background: var(--b3-theme-background, #fff);
    border-radius: 4px;
    width: 17px;
    height: 17px;
    font-size: 11px;
    line-height: 1;
    cursor: pointer;
    flex-shrink: 0;
    color: var(--b3-theme-primary, #378add);
    padding: 0;
  }
  .row-sel.on {
    background: var(--b3-theme-primary, #378add);
    border-color: var(--b3-theme-primary, #378add);
    color: var(--b3-theme-on-primary, #fff);
  }
  /* 第 2 列：小封面 + 标题行 + 副行 */
  .row-title-line {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .row-cover {
    position: relative;
    width: 30px;
    aspect-ratio: 3 / 4;
    flex-shrink: 0;
    border: none;
    border-radius: 4px;
    overflow: hidden;
    cursor: pointer;
    background: var(--reword-cover-grad, linear-gradient(160deg, #185fa5, #0c447c));
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
  }
  .row-cover-text {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.92);
  }
  .row-titlecol {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .row-title-row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .row-title {
    min-width: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--b3-theme-on-background, #333);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .row-status-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.14));
    background: none;
    border-radius: 10px;
    padding: 1px 7px 1px 5px;
    font-size: 10px;
    cursor: pointer;
    flex-shrink: 0;
    color: var(--b3-theme-on-surface-light, #888);
    line-height: 1.4;
  }
  .row-status-chip::before {
    content: "";
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--b3-theme-primary, #378add);
    flex-shrink: 0;
  }
  .row-status-chip.reading {
    border-color: var(--b3-theme-primary, #378add);
    color: var(--b3-theme-on-background, #333);
    font-weight: 500;
    background: var(--b3-list-hover, rgba(0, 0, 0, 0.05));
  }
  .row-status-chip.done {
    border-color: #3aa675;
    color: #3aa675;
    background: rgba(58, 166, 117, 0.1);
  }
  .row-status-chip.done::before {
    background: #3aa675;
  }
  .row-fav {
    color: #ffc94d;
    font-size: 11px;
    flex-shrink: 0;
  }
  .row-sub {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    color: var(--b3-theme-on-surface-light, #888);
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
  }
  .row-sub > * {
    flex-shrink: 0;
  }
  .row-dot {
    opacity: 0.45;
  }
  /* 第 3~7 列：作者 / 格式 / 时长 / 最近阅读（进度条另有 .row-pbar） */
  .row-author,
  .row-formatcell,
  .row-time,
  .row-lastread {
    min-width: 0;
    font-size: 11.5px;
    color: var(--b3-theme-on-surface-light, #888);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-formatcell {
    font-size: 10.5px;
    letter-spacing: 0.03em;
  }
  /* 进度列只放条：62px 里再塞百分比两边都读不清，精确值挂 title */
  .row-pbar {
    height: 3px;
    border-radius: 2px;
    background: var(--b3-border-color, rgba(0, 0, 0, 0.12));
    overflow: hidden;
  }
  .row-pbar > i {
    display: block;
    height: 100%;
    border-radius: 2px;
    background: var(--b3-theme-primary, #378add);
  }
  .row-tag-chips {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-left: 6px;
  }
  .row-tag {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 4px;
    background: var(--b3-theme-background-light, rgba(0, 0, 0, 0.06));
    color: var(--b3-theme-on-surface-light, #888);
    white-space: nowrap;
  }
  .row-tag.more {
    background: transparent;
    padding-left: 0;
  }
  .row-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
    flex-shrink: 0;
  }
  .row-btn {
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.15));
    background: var(--b3-theme-background, #fff);
    border-radius: 6px;
    padding: 5px 12px;
    font-size: 12px;
    cursor: pointer;
    color: var(--b3-theme-on-background, #333);
    transition: background 0.15s;
  }
  .row-btn.primary {
    background: var(--b3-theme-primary, #378add);
    border-color: transparent;
    color: var(--b3-theme-on-primary, #fff);
  }
  .row-btn:hover {
    filter: brightness(0.94);
  }
  .row-actions-extra {
    display: flex;
    align-items: center;
    gap: 4px;
    opacity: 0;
    transform: translateX(6px);
    transition: opacity 0.2s ease, transform 0.2s ease;
    pointer-events: none;
  }
  .shelf-row:hover .row-actions-extra {
    opacity: 1;
    transform: translateX(0);
    pointer-events: auto;
  }
  .row-icon-btn {
    width: 26px;
    height: 26px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.15));
    background: var(--b3-theme-background, #fff);
    border-radius: 50%;
    font-size: 12px;
    cursor: pointer;
    color: var(--b3-theme-on-surface-light, #666);
    padding: 0;
    transition: background 0.15s, color 0.15s;
  }
  .row-icon-btn:hover {
    background: var(--b3-list-hover, rgba(0, 0, 0, 0.06));
    color: var(--b3-theme-on-background, #333);
  }
  .row-icon-btn.danger {
    color: var(--b3-theme-error, #e24b4a);
  }
  .row-icon-btn.danger:hover {
    background: rgba(226, 75, 74, 0.08);
  }
  /* 窄面板（思源 dock 侧栏）退化成「书名 + 进度条」：次要列整列下线，
     而不是让七列各自被压到读不出来。
     用容器查询而不是 @media —— dock 里视口可以很宽，窄的是 .shelf-main 自己。 */
  @container shelf-main (max-width: 620px) {
    .shelf-lhead,
    .shelf-row {
      grid-template-columns: 26px minmax(140px, 1fr) 62px auto;
    }
    .lh-author,
    .lh-format,
    .lh-time,
    .lh-lastread,
    .row-author,
    .row-formatcell,
    .row-time,
    .row-lastread,
    .row-tag-chips,
    .row-actions-extra {
      display: none;
    }
  }
  @container shelf-main (max-width: 480px) {
    .shelf-list {
      padding: 6px 8px;
    }
    .shelf-row {
      padding: 7px 8px;
    }
    .row-cover {
      width: 26px;
    }
    /* 副行（分组 / 大小 / 标签）整条下线：这一档只保「书名 + 进度条」 */
    .row-sub {
      display: none;
    }
  }
  /* 2026-10-26 路线 A · 极小屏档（对标「思阅」SiReader 的 380 断点）：
     折叠机半屏 / iPhone SE 竖屏下再收一档内边距与封面宽度。 */
  @container shelf-main (max-width: 400px) {
    .shelf-list {
      padding: 4px 6px;
    }
    .shelf-row {
      padding: 6px 6px;
    }
    .row-cover {
      width: 22px;
    }
  }

  /* ---- 分组管理弹窗 ---- */
  .group-new {
    display: flex;
    gap: 6px;
  }
  .group-new input,
  .group-rename {
    flex: 1;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.15));
    border-radius: 6px;
    padding: 5px 8px;
    font-size: 12px;
    background: var(--b3-theme-background, #fff);
    color: var(--b3-theme-on-background, #333);
    outline: none;
  }
  .group-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 200px;
    overflow-y: auto;
  }
  .group-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 6px;
    border-radius: 6px;
    background: var(--b3-theme-background-light, rgba(0, 0, 0, 0.04));
  }
  .group-name {
    flex: 1;
    font-size: 12px;
    color: var(--b3-theme-on-background, #333);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .group-count {
    font-size: 10px;
    color: var(--b3-theme-on-surface-light, #999);
    flex-shrink: 0;
  }
  .group-op {
    border: none;
    background: none;
    font-size: 11px;
    cursor: pointer;
    color: var(--b3-theme-primary, #378add);
    padding: 2px 4px;
    flex-shrink: 0;
  }
  .group-op.danger {
    color: var(--b3-theme-error, #e24b4a);
  }

  /* ---- 编辑弹窗扩展 ---- */
  .edit-panel.wide {
    width: min(360px, 92%);
  }
  .edit-scroll {
    display: flex;
    flex-direction: column;
    gap: 10px;
    overflow-y: auto;
    max-height: 62vh;
    padding-right: 2px;
  }
  .edit-cover-row {
    display: flex;
    gap: 10px;
    align-items: flex-start;
  }
  .edit-cover-preview {
    position: relative;
    width: 62px;
    aspect-ratio: 3 / 4;
    border-radius: 6px;
    overflow: hidden;
    flex-shrink: 0;
    background: var(--reword-cover-grad, linear-gradient(160deg, #185fa5, #0c447c));
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .edit-cover-ops {
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: flex-start;
  }
  .edit-cover-ops .book-btn {
    flex: initial;
    padding: 4px 10px;
  }
  .edit-hint {
    font-size: 10.5px;
    color: var(--b3-theme-on-surface-light, #999);
  }
  .edit-inline-check {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    color: var(--b3-theme-on-background, #333);
    cursor: pointer;
    user-select: none;
  }
  .edit-seg {
    display: flex;
    gap: 3px;
  }
  .edit-seg-btn {
    flex: 1;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.15));
    background: none;
    border-radius: 6px;
    padding: 4px 0;
    font-size: 12px;
    cursor: pointer;
    color: var(--b3-theme-on-background, #333);
  }
  .edit-seg-btn.on {
    background: var(--b3-theme-primary-lightest, rgba(55, 138, 221, 0.16));
    border-color: var(--b3-theme-primary, #378add);
    color: var(--b3-theme-on-background, #333);
    font-weight: 600;
  }
  .edit-stars {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .edit-star {
    border: none;
    background: none;
    cursor: pointer;
    font-size: 17px;
    line-height: 1;
    padding: 0 1px;
    color: var(--b3-border-color, rgba(0, 0, 0, 0.2));
  }
  .edit-star.on {
    color: #f0a93a;
  }
  .edit-star-clear {
    border: none;
    background: none;
    cursor: pointer;
    font-size: 11px;
    color: var(--b3-theme-on-surface-light, #999);
    margin-left: 4px;
  }
  .edit-tag-box {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.15));
    border-radius: 6px;
    padding: 4px 6px;
    background: var(--b3-theme-background, #fff);
  }
  .edit-tag-chip {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 11px;
    padding: 2px 4px 2px 7px;
    border-radius: 10px;
    background: var(--b3-list-hover, rgba(0, 0, 0, 0.05));
    color: var(--b3-theme-on-surface-light, #888);
  }
  .edit-tag-del {
    border: none;
    background: none;
    cursor: pointer;
    font-size: 9px;
    color: inherit;
    padding: 0 2px;
    line-height: 1;
  }
  .edit-tag-input {
    flex: 1;
    min-width: 60px;
    border: none !important;
    outline: none;
    font-size: 12px;
    background: transparent;
    color: var(--b3-theme-on-background, #333);
    padding: 2px 0 !important;
  }

  /* ================================================================
   * 深色适配（2026-10-11 B0：这里原来是一个 @media (prefers-color-scheme: dark) 块）
   * ----------------------------------------------------------------
   * 删掉它有两个原因，第二个是 bug：
   *  1. 阴影/渐变/scrim 的深浅值现在成对写在 src/reader/bookshelf-tokens.less
   *     的 :root 和 :root[data-theme-mode="dark"] 里，组件只写 var()，
   *     再在组件里补一份深色分支迟早和令牌分叉（规则 3：一个元素只属于一层）。
   *  2. `prefers-color-scheme` 问的是 **macOS 外观**，不是思源主题。
   *     思源的主题深色与否挂在 <html> 的 data-theme-mode 上（由 appearance.mode 决定）。
   *     「系统浅色 + 思源深色主题」这个常见组合下，原来那一整块**一条都不生效**：
   *     深色书架拿到的是 .12 alpha 的浅主题阴影，几乎看不见。
   *  toast 的深色底 `rgba(20,20,20,.95)` 一并删掉：P0 已把它改成 --b3-theme-surface，
   *  主题自己就是深的，再压一层是重复。
   * ================================================================ */
</style>
