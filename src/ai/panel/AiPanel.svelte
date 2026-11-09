<script lang="ts">
  /**
   * AI 阅读面板（P0）
   * ------------------------------------------------------------------
   * 右侧停靠的阅读助手：读当前章节 → 回答 → 原文引用可回跳。
   *
   * 职责边界：
   *  - 本组件负责对话状态、流式渲染、输入与凭据表单；
   *  - 章节正文 / 原文定位 / 打开块都经宿主（ReaderView）注入的函数完成，
   *    组件本身不碰 foliate view，也不直接读写插件设置文件。
   *
   * 刻意不做的事（P1/P2）：
   *  - 不把笔记写入思源（P2 的 NotePlan 管线）；
   *  - 不调用内核工具循环（P1 的 tool_calls）。
   */
  import { onMount, onDestroy, tick } from "svelte";
  import { t } from "../../i18n/index.ts";
  import { getLogger } from "../../core/logger.ts";
  import { logSwallow } from "../../core/safe.ts";
  import {
    requestAIStream,
    requestAIGenerate,
    type AiMessage,
  } from "../ai-client.ts";
  import AiComposer from "./AiComposer.svelte";
  import AiMindmap from "./AiMindmap.svelte";
  import AiSettingsDialog from "../settings/AiSettingsDialog.svelte";
  import { fontSizesOf } from "../settings/ai-settings-dialog-logic.ts";
  import { renderAssistantMarkdown, blockIdFromTarget } from "./ai-markdown.ts";
  import { copyAsMarkdown } from "./ai-clipboard.ts";
  import { renderPost } from "./ai-render-post.ts";
  import {
    MINDMAP_QUICK_ASK,
    outlineFromMarkdown,
    splitMindmapSegments,
    type MindmapNode,
  } from "./ai-mindmap.ts";
  import DocTreePickerPage from "../../reader/settings/DocTreePickerPage.svelte";
  import {
    loadKnowledgeSource,
    saveKnowledgeSource,
    buildKnowledgePrompt,
    type KnowledgeSource,
  } from "./ai-knowledge.ts";
  import {
    buildNotePlanRequest,
    parseNotePlan,
    type NotePlan,
  } from "./ai-note-plan.ts";
  import {
    READER_TOOLS_PROMPT,
    buildReaderToolDefs,
    executeReaderTool,
    stringifyToolResult,
    toTrace,
    type ReaderToolHost,
  } from "./ai-reader-tools.ts";
  import {
    MAX_RANGE_CHAPTERS,
    buildTocPrompt,
    isSectionInRange,
    normalizeReadRange,
    normalizeTocItems,
    pickRangeSection,
    rangeSpan,
    rangeLabel,
    type AiReadRange,
    type AiTocItem,
  } from "./ai-toc.ts";
  import {
    DEFAULT_AI_PANEL_PREFS,
    MIN_PANEL_WIDTH,
    MAX_PANEL_WIDTH,
    MIN_STAGE_WIDTH,
    normalizeAiPanelPrefs,
    loadAiPanelPrefs,
    saveAiPanelPrefs,
    newMessageId,
    buildChapterContext,
    buildGeneralSystemPrompt,
    buildReaderSystemPrompt,
    buildUserTurnContent,
    buildChatRequestMessages,
    pickHistory,
    toAiCredentialView,
    mergeAiCredentials,
    isAiReady,
    quoteChipLabel,
    contextReceipt,
    normalizeContextScope,
    normalizeTurnScope,
    chatDayMarker,
    sameChatDay,
    formatUsage,
    classifyAiError,
    maskApiKeyInText,
    editResendDraft,
    editRemovedCount,
    wantsSendOnEnter,
    CONTINUE_HINT,
    type AiContextScope,
    type AiTurnScope,
    type AiChatMessage,
    type AiChatQuote,
    type AiChatContextNote,
    type AiChatToolTrace,
    type AiChatNoteReceipt,
    type AiUsageSnapshot,
    type AiPanelPrefs,
    type AiCredentialView,
    type ChapterContext,
  } from "./ai-panel-logic.ts";
  import {
    emptySessionState,
    loadSessionState,
    saveSessionState,
    createSession,
    touchSession,
    removeSession,
    pruneSessionsByAge,
    upsertSession,
    withActiveSession,
    collectSessionNotes,
    sessionPreview,
    sessionDayBucket,
    sessionClock,
    titleFromMessages,
    renameSession,
    applyAiSessionTitle,
    setSessionPinned,
    sortSessionsForHistory,
    MAX_TOTAL_SESSIONS,
    type AiChatSession,
    type AiSessionState,
  } from "./ai-session-store.ts";
  import type { AiSessionIO, SessionLoadSource } from "./ai-session-io.ts";
  import {
    buildSessionMarkdown,
    buildSessionJson,
    sessionExportFileName,
  } from "./ai-session-export.ts";
  import {
    buildAutoRenamePrompt,
    cleanAutoTitle,
    resolveAutoRenameTarget,
    shouldApplyAutoTitle,
  } from "../auto-title.ts";

  /** 笔记落点解析 / 写入结果（与 ReaderView 注入实现同形） */
  type NoteTargetInfo =
    | {
        ok: true;
        docId: string;
        docTitle: string;
        notebookName: string;
        autoCreated: boolean;
        /** 预览阶段尚未建档（确认写入时才创建） */
        willCreate?: boolean;
      }
    | { ok: false; error: string };
  type NoteWriteResult = NoteTargetInfo;

  /* ============================ 宿主注入 ============================ */

  /** 面板是否展开（收起时仍保留状态，便于再次打开不丢草稿） */
  export let open = true;
  export let bookId = "";
  export let bookTitle = "";
  export let bookAuthor = "";
  /** 当前章节标题（宿主派生，含目录名；空则显示「本章」） */
  export let chapterLabel = "";
  /** 面板宽度（bind，宿主负责布局；手机断点走全屏） */
  export let width = DEFAULT_AI_PANEL_PREFS.width;
  /** 是否允许拖拽改宽：手机全屏覆盖时没有可拖的边，宿主传 false */
  export let resizable = true;
  /** 手机全屏覆盖层：加大触控目标、避让安全区、输入字号防 iOS 放大 */
  export let overlay = false;
  /** 右栏没有活动阅读器时的通用对话：不读正文、不显示阅读上下文 */
  export let general = false;

  /* ==================== 会话来源 / 是否读正文（2026-11-08 拆分） ====================
   * 原先 `general` 一个布尔量同时表示两件事：「没有书」和「不读正文」。要支持
   * 「不开阅读器也能回顾某本书的对话」，必须把它们拆开：
   *
   *   general=true                → 纯通用对话（无书、不读正文、落到 unknown 会话空间）
   *   viewBookId=xxx, readContext=false → 查看某本书的历史（有书、但不读正文）
   *   阅读器内                    → bookId=xxx, readContext=true（默认）
   */
  /** 面板要查看哪本书的会话（不传则用 bookId）；用于「不开阅读器回顾历史」 */
  export let viewBookId = "";
  /** 是否附加正文/章节/工具上下文；查看历史时为 false，避免读到另一本书的正文 */
  export let readContext = true;

  /** 读翻译/AI 设置（宿主 → plugin.getAiSettings） */
  export let getAiSettings: (() => any) | undefined = undefined;
  /** 存设置增量（宿主 → plugin.updateAiSettings） */
  export let saveAiSettings: ((patch: any) => Promise<void> | void) | undefined = undefined;
  /** 读当前章节快照（宿主 → ReaderView.getChapterSnapshot） */
  export let getChapter: ((opts: { maxChars?: number }) => Promise<any>) | undefined = undefined;
  /** 读当前可见页快照（宿主 → ReaderView.getPageSnapshot）；缺省时「本页」回退本章 */
  export let getPage: ((opts: { maxChars?: number }) => Promise<any>) | undefined = undefined;
  /** 读连续几章（宿主 → ReaderView.getChapterRangeSnapshot）；缺省时目录范围回退本章 */
  export let getRange:
    | ((opts: { fromSection?: number; toSection?: number; maxChars?: number }) => Promise<any>)
    | undefined = undefined;
  /** 读本书目录（宿主 → ReaderView.getBookToc）；缺省则不显示「目录」入口 */
  export let getToc: (() => Promise<any> | any) | undefined = undefined;
  /** 读本书前提（人物/译名备忘，可空） */
  export let getPrimer: (() => string) | undefined = undefined;
  /** 定位原文（宿主 → locateAiQuote + 滚动定位） */
  export let onLocate: ((quote: string, sectionIndex?: number) => Promise<any> | void) | undefined = undefined;
  /** 阅读器只读工具宿主；缺省则不启用工具循环（只靠预注入的当前章上下文） */
  export let getReaderToolHost: (() => ReaderToolHost | null) | undefined = undefined;
  /** 读知识区文档 Markdown（宿主 → exportMdContent；缺省则知识区功能不可用） */
  export let readKnowledge:
    | ((src: KnowledgeSource) => Promise<{ ok: boolean; markdown?: string; error?: string }>)
    | undefined = undefined;
  /** 解析本书的笔记落点（宿主 → resolveExportTargetAsync）；只读不写 */
  export let resolveNoteTarget: (() => Promise<NoteTargetInfo>) | undefined = undefined;
  /** 把确认过的笔记方案追加到思源（宿主 → probeDoc + appendBlock） */
  export let writeNotePlan: ((plan: NotePlan) => Promise<NoteWriteResult>) | undefined = undefined;
  /** 收起面板（宿主自己决定卸载/隐藏） */
  export let onClose: (() => void) | undefined = undefined;
  /** 在思源页签中打开（仅右侧停靠时提供；页签内不传） */
  export let onOpenTab: (() => void) | undefined = undefined;
  /**
   * 会话持久化 IO（2026-11-08 · P0）。
   *
   * 宿主注入后，会话真源变为 petal 文件；缺省（旧行为）仍只写 localStorage。
   * 存在该对象时：
   *  - 首屏用 `loadCache` 同步渲染 → 再 `loadBook` 异步对账；
   *  - 所有写点走 `saveBook`（未对账前不会覆盖磁盘）；
   *  - 卸载 / pagehide 立即 `flush`。
   */
  export let sessionIO: AiSessionIO | undefined = undefined;

  /* ======================= 通用对话：最近对话入口 ======================= */
  /**
   * 右栏在没有活动阅读器时会落到独立的 `unknown` 会话空间，看不到任何书的
   * 历史，用户会以为「历史丢了」。这里给它一份跨书会话摘要，用于空态列出
   * 「最近聊过的书」。
   *
   * 只在 general 模式下有意义；有书时面板本来就绑在那本书上。
   */
  export let recentBooks: Array<{ bookId: string; sessions: number; updatedAt: number; title?: string }> = [];
  /** 点「最近对话」里的某本书：打开它的阅读器（宿主注入） */
  export let onOpenBook: ((bookId: string, title?: string) => void) | undefined = undefined;
  /** 退出「查看历史」回到通用对话（宿主注入；仅在查看形态有意义） */
  export let onExitView: (() => void) | undefined = undefined;

  /* ============================ 工具循环上限 ============================ */

  /** 一次提问最多几轮「模型 → 工具 → 模型」（含首次调用后的一轮） */
  const MAX_TOOL_ROUNDS = 4;
  /** 一次提问最多执行几次工具调用（并行返回的也算） */
  const MAX_TOOL_CALLS = 8;
  /** 看起来像「模型/网关不支持 tools 字段」的错误：关掉工具重试一次 */
  const TOOL_FALLBACK_RE = /(^|\D)(400|422)(\D|$)|tool|function|not support|不支持/i;

  /* ============================ 面板状态 ============================ */

  let tab: "chat" | "notes" = "chat";
  /** 设置改为浮窗：不占 tab，也不挤压对话区 */
  let settingsOpen = false;
  let prefs: AiPanelPrefs = { ...DEFAULT_AI_PANEL_PREFS };
  /** 设置窗口负责的显示参数；打开/保存后由 syncCred 一并刷新 */
  let fontSizes = { message: 14, input: 13 };
  let sendShortcut: "enter" | "mod+enter" = "enter";
  let streamThrottleMs = 100;
  let messages: AiChatMessage[] = [];
  let loadedBookId = "";
  /**
   * 会话代次：AI 页签跟随活动阅读器时，bookId 可能在一次回答**流式途中**变化。
   * 换书会 abort 旧请求；旧轮次收尾时若发现代次已变，只清理自己的流状态，
   * 绝不把旧书的半截消息写进新书（反之亦然）。
   */
  let chatGen = 0;
  /** 多会话状态：sessions 内是已落盘快照，messages 是当前会话的工作副本 */
  let sessionState: AiSessionState = emptySessionState();
  /** P0：本次会话态的加载来源（诊断用）；disk/backup 表示已与 petal 真源对账 */
  let loadSource: SessionLoadSource = "empty";
  /** P0：磁盘档损坏且读不出 → 本次不落盘，避免覆盖原始档 */
  let storageReadOnly = false;
  /**
   * 会话真源的书 id（2026-11-08 拆分）。
   *
   * 与 `bookId` 的区别：`bookId` 是「当前打开在阅读器里的书」，会随活动阅读器变；
   * 这个值是「面板此刻在读哪个会话空间」。查看历史（viewBookId）时二者不同，
   * 所有读写会话的地方都必须用它，否则会把 A 书的会话写进 B 书。
   */
  $: sessionBookId = general ? "" : String(viewBookId || bookId || "");
  /** 有书（含「查看历史」这种有书但不读正文的状态） */
  $: hasBook = !general && !!sessionBookId;
  /** 是否真的附加正文/章节上下文：有书 + 未关闭读上下文 */
  $: readCtx = hasBook && readContext;
  /** 历史浮卡：全部/置顶筛选 + 标题/正文搜索 */
  let showHistory = false;
  let historyQuery = "";
  let historyFilter: "all" | "pinned" = "all";
  let historyToolsOpen = false;
  let historyTop = 58;
  let historyMaxH = 480;
  let panelEl: HTMLElement | undefined = undefined;
  let headerEl: HTMLElement | undefined = undefined;
  let historyEl: HTMLDivElement | undefined = undefined;
  let historyBtnEl: HTMLButtonElement | undefined = undefined;
  /** P1：会话操作菜单 / 内联重命名 */
  let historyMenu = "";
  let renamingId = "";
  let renameText = "";
  let renameEl: HTMLInputElement | undefined = undefined;
  let pendingQuote: AiChatQuote | null = null;
  let notice = "";
  let copiedId = "";
  /** P1：正在编辑重发的用户消息 id 与草稿 */
  let editingId = "";
  let editText = "";
  let editEl: HTMLTextAreaElement | undefined = undefined;
  /** P1：错误详情/错误文案的复制反馈 */
  let copiedErrorId = "";
  /** P4-C：底栏模型快切气泡 */
  let modelMenu = false;

  let composer: any = undefined;
  let composerHasText = false;
  let threadEl: HTMLDivElement | undefined = undefined;
  let stickBottom = true;

  let streaming = false;
  let streamMsgId = "";
  let streamText = "";
  let streamReasoning = "";
  let streamTools: AiChatToolTrace[] = [];
  let tokenBuf = "";
  let reasonBuf = "";
  let flushTimer: any = null;
  let abortCtrl: AbortController | null = null;

  let cred: AiCredentialView = toAiCredentialView(null);

  /* ---------- P2：知识区 / 笔记方案 ---------- */
  let knowledge: KnowledgeSource | null = null;
  /** P4：本轮是否附带知识区（会话内临时开关，不写存储） */
  let knowledgeOn = true;
  /** P4：上下文范围（本页/本章），默认跟随面板偏好 */
  let contextScope: AiContextScope = "chapter";
  /** P0：用户从目录里选的章节范围（一次性，不写偏好；为空则用 contextScope） */
  let readRange: AiReadRange | null = null;
  let tocItems: AiTocItem[] = [];
  /** 当前阅读进度所在 section（-1 = 未知）：用于提示范围会读到后面 */
  let tocCurrent = -1;
  let tocBusy = false;
  let tocError = "";
  let tocLoadedFor = "";
  /** 目录请求代次：换书/换会话后丢弃上一本迟到的结果 */
  let tocGen = 0;
  let showToc = false;
  let showKnowledgePicker = false;
  let notePlan: { messageId: string; plan: NotePlan; target: NoteTargetInfo } | null = null;
  let notePlanBusyId = "";
  let notePlanError = "";
  let noteWriteBusy = false;

  /* ---------- P3：思维导图 / 悬浮预览 ---------- */
  type RenderSegment = { kind: "html"; html: string } | { kind: "mindmap"; root: MindmapNode };
  const segmentCache = new Map<string, { text: string; segs: RenderSegment[] }>();
  const outlineCache = new Map<string, { text: string; root: MindmapNode | null }>();
  let mindmapView: { messageId: string; root: MindmapNode } | null = null;

  interface BlockPreviewState { id: string; html: string; error?: string }
  let preview: BlockPreviewState | null = null;
  let previewEl: HTMLDivElement | undefined = undefined;
  let previewStyle = "";
  let previewFor = "";
  let previewShowTimer: any = null;
  let previewHideTimer: any = null;
  const previewCache = new Map<string, BlockPreviewState>();

  function storage(): Storage | null {
    try {
      return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
      return null;
    }
  }

  function syncCred(): void {
    try {
      const s = getAiSettings?.() || null;
      cred = toAiCredentialView(s);
      fontSizes = fontSizesOf(s);
      sendShortcut = s?.sendShortcut === "mod+enter" ? "mod+enter" : "enter";
      streamThrottleMs = Math.min(500, Math.max(0, Math.round(Number(s?.streamThrottleMs ?? 100))));
    } catch (e) {
      logSwallow(e, "AiPanel.svelte · syncCred", "warn");
    }
  }

  /** 发给模型的设置：激活平台的镜像覆盖顶层，其余字段沿用原设置（transportMode 等） */
  function engineSettings(): any {
    const base: any = getAiSettings?.() || {};
    return {
      ...base,
      baseUrl: cred.baseUrl,
      apiKey: cred.apiKey,
      model: cred.model,
      temperature: cred.temperature,
      maxTokens: cred.maxTokens,
    };
  }

  function activeSessionOf(state: AiSessionState): AiChatSession | undefined {
    return state.sessions.find((s) => s.id === state.activeId) || state.sessions[0];
  }

  function ensureSessionState(state: AiSessionState): AiSessionState {
    if (state.sessions.length) return state;
    const s = createSession([]);
    return { version: 1, activeId: s.id, sessions: [s] };
  }

  /** 清掉只属于「上一本书/上一条会话」的浮层状态，避免串书 */
  function resetTransientUi(): void {
    pendingQuote = null;
    notice = "";
    cancelEdit();
    notePlan = null;
    notePlanError = "";
    mindmapView = null;
    hidePreview();
    readRange = null;
    showToc = false;
    tocItems = [];
    tocCurrent = -1;
    tocError = "";
    tocLoadedFor = "";
    tocGen++;
    tocBusy = false;
    segmentCache.clear();
    outlineCache.clear();
    previewCache.clear();
  }

  function loadSessionsFor(id: string): void {
    chatGen++;
    loadedBookId = id;
    const days = Math.round(Number(getAiSettings?.()?.sessionRetentionDays) || 0);

    if (!sessionIO) {
      // 旧路径（无 IO 注入）：只走 localStorage，行为与历史版本一致
      const loaded = loadSessionState(storage(), id);
      const pruned = pruneSessionsByAge(loaded, days);
      sessionState = ensureSessionState(pruned === loaded ? loaded : saveSessionState(storage(), id, pruned));
      applyLoadedState(id);
      return;
    }

    /**
     * P0 路径：先同步用热缓存出首屏（<5ms，不闪空），再异步读盘对账。
     * 注意必须**先渲染再对账**：否则等 petal 的几十毫秒会让面板空白。
     */
    const cached = sessionIO.loadCache(id);
    sessionState = ensureSessionState(pruneSessionsByAge(cached, days));
    applyLoadedState(id);

    const gen = chatGen;
    void sessionIO
      .loadBook(id, { pruneRetentionDays: days })
      .then((res) => {
        // 期间换了书/换了会话：丢弃这次结果，避免串书
        if (gen !== chatGen || loadedBookId !== id) return;
        sessionState = ensureSessionState(res.state);
        const active = activeSessionOf(sessionState);
        // 只在用户尚未发言时替换消息，避免冲掉正在输入/正在流式的内容
        if (!streaming && !messages.some((m) => m.role === "user")) {
          messages = active ? active.messages.slice() : [];
        }
        loadSource = res.source;
        if (res.readOnly) {
          storageReadOnly = true;
          notice = t("会话档读取失败，本次修改不会落盘（已保留原始档）");
        }
        void tick().then(() => autoScroll(true));
      })
      .catch((e) => {
        logSwallow(e, "AiPanel.svelte · loadSessionsFor · io", "debug");
      });
  }

  /** 载入后统一重置视图态（两条路径共用） */
  function applyLoadedState(id: string): void {
    const active = activeSessionOf(sessionState);
    messages = active ? active.messages.slice() : [];
    knowledge = loadKnowledgeSource(storage(), id);
    knowledgeOn = !!knowledge;
    showHistory = false;
    historyQuery = "";
    historyToolsOpen = false;
    resetTransientUi();
    composer?.clear?.();
  }

  /**
   * 生成中落盘投影：流式正文只存在 tokenBuf 里，messages 中的助手消息仍是空串。
   * 刷新 / 切页 / 切会话直接 persistChat() 会把空消息过滤掉，半截回答就此丢失。
   * 只在「保存」这一刻投影出带片段的副本，不改动 messages，避免每帧重渲染。
   */
  function messagesForSave(list: AiChatMessage[]): AiChatMessage[] {
    if (!streaming || !streamMsgId) return list;
    const partial = String(tokenBuf || "");
    if (!partial.trim()) return list;
    const reasoning = String(reasonBuf || "").trim();
    return list.map((m) =>
      m.id === streamMsgId && m.role === "assistant"
        ? { ...m, content: partial, ...(reasoning ? { reasoning } : {}), aborted: true }
        : m,
    );
  }

  /** 当前工作副本落回会话；切书/切会话/卸载前都要先调用 */
  function persistChat(targetBookId = sessionBookId): void {
    const id = sessionState.activeId;
    if (!id) return;
    const active = sessionState.sessions.find((s) => s.id === id);
    if (!active) return;
    const touched = touchSession(active, messagesForSave(messages));
    sessionState = saveStateFor(targetBookId, upsertSession({ ...sessionState, activeId: id }, touched));
  }

  /**
   * 统一落盘入口：注入了 IO 就走「热缓存 + petal 防抖」，否则退回旧 localStorage。
   * `opts.explicit` 用于删除/清空（跳过缩水守卫并写墓碑）。
   */
  function saveStateFor(
    targetBookId: string,
    next: AiSessionState,
    opts: { explicit?: boolean; immediate?: boolean; removedIds?: string[] } = {},
  ): AiSessionState {
    if (sessionIO && !storageReadOnly) {
      return sessionIO.saveBook(targetBookId, next, opts);
    }
    return saveSessionState(storage(), targetBookId, next);
  }

  function persistPrefs(): void {
    saveAiPanelPrefs(storage(), prefs);
  }

  onMount(() => {
    prefs = loadAiPanelPrefs(storage());
    width = clampWidth(normalizeAiPanelPrefs({ ...prefs, width }).width);
    contextScope = normalizeContextScope(prefs.contextScope);
    loadSessionsFor(bookId);
    syncCred();
    const onWinResize = () => {
      if (resizable) width = clampWidth(width);
    };
    window.addEventListener("resize", onWinResize);
    // P0：离开页面前强制落盘。bfcache / 刷新 / 关闭标签页都不走 Svelte 卸载，
    // 只靠 onMount 的清理函数会漏掉最后一批消息，这里补两道。
    const onPageHide = () => {
      try {
        persistChat(loadedBookId || sessionBookId);
      } catch (e) {
        logSwallow(e, "AiPanel.svelte · pagehide · persistChat", "debug");
      }
      void sessionIO?.flush();
    };
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibilityHidden);
    return () => {
      window.removeEventListener("resize", onWinResize);
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibilityHidden);
      // 组件卸载时中断请求并落盘（页面切换不应丢对话）
      try { abortCtrl?.abort(); } catch { /* already aborted */ }
      persistChat(loadedBookId || sessionBookId);
      persistPrefs();
      // 立即落盘，不等 800ms 防抖 —— 卸载后定时器可能不再触发
      void sessionIO?.flush();
    };
  });

  /** 页面转入后台时落盘：移动端/切窗口都可能被系统回收内存 */
  function onVisibilityHidden(): void {
    if (typeof document === "undefined" || document.visibilityState !== "hidden") return;
    try {
      persistChat(loadedBookId || sessionBookId);
    } catch (e) {
      logSwallow(e, "AiPanel.svelte · visibilitychange · persistChat", "debug");
    }
    void sessionIO?.flush();
  }

  onDestroy(() => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    clearPreviewTimers();
  });

  // 切换会话源（换书 / 进入或退出「查看历史」）时跟着换会话。
  // 2026-11-05 AI 页签：跟随活动阅读器时本组件会跨书复用，换书前先把上一本
  // 的工作副本落回它自己的存储，并丢弃「已发出但还没答完」的空占位，
  // 避免空助手气泡留在历史里。
  // 2026-11-08：改用 sessionBookId —— viewBookId 与 bookId 不同（查看历史）时
  // 也必须正确切换，否则会把 A 书的会话写进 B 书。
  $: if (sessionBookId !== loadedBookId) {
    discardActiveTurn();
    if (loadedBookId) persistChat(loadedBookId);
    loadSessionsFor(sessionBookId);
  }

  // 展开面板时刷新凭据：设置可能在双语翻译页被改过
  let wasOpen = false;
  $: if (open && !wasOpen) {
    wasOpen = true;
    syncCred();
  } else if (!open && wasOpen) {
    wasOpen = false;
  }

  /* ============================ 对外方法 ============================ */

  /** 划词工具栏「问 AI」注入选段 */
  export function addQuote(q: AiChatQuote): void {
    const text = String(q?.text || "").trim();
    if (!text) return;
    pendingQuote = {
      text: text.slice(0, 4000),
      chapterTitle: String(q?.chapterTitle || chapterLabel || "").trim() || undefined,
      sectionIndex: Number.isFinite(Number(q?.sectionIndex)) ? Number(q.sectionIndex) : undefined,
    };
    tab = "chat";
    notice = "";
    void tick().then(() => {
      composer?.focus?.();
      autoScroll(true);
    });
  }

  /** 外部打开面板时聚焦输入框 */
  export function focusComposer(): void {
    void tick().then(() => composer?.focus?.());
  }

  /* ============================ 滚动 ============================ */

  function onThreadScroll(): void {
    if (preview) hidePreview();
    if (!threadEl) return;
    stickBottom = threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight < 90;
  }

  async function autoScroll(force = false): Promise<void> {
    if (!force && !stickBottom) return;
    await tick();
    if (threadEl) threadEl.scrollTop = threadEl.scrollHeight;
  }

  /* ============================ 流式 ============================ */

  function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      streamText = tokenBuf;
      streamReasoning = reasonBuf;
      void autoScroll();
    }, Math.max(0, streamThrottleMs));
  }

  function flushNow(): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    streamText = tokenBuf;
    streamReasoning = reasonBuf;
  }

  function stop(): void {
    try { abortCtrl?.abort(); } catch { /* noop */ }
    hidePreview();
  }

  /**
   * 中断当前流式回答并**丢弃**其结果：换书 / 换会话 / 新对话 / 清空时调用。
   *
   * 只调 stop() 不够：请求 abort 后的收尾是异步的，晚到时会往「新会话」
   * 的 messages 里写答案（AI 页签跟随换书时尤其明显）。代次 +1 让旧轮次
   * 收尾直接退出；空占位顺手移除，避免历史里留白气泡。
   */
  function discardActiveTurn(): void {
    if (!streaming) return;
    stop();
    if (String(tokenBuf || "").trim() && streamMsgId) {
      // 已流出的片段留在原会话：切回来仍看得到「已停止 / 继续」，不会被当成空气泡丢掉
      messages = messagesForSave(messages);
    } else {
      const last = messages[messages.length - 1];
      if (last?.role === "assistant" && !last.content.trim() && !last.error && !last.aborted) {
        messages = messages.slice(0, -1);
      }
    }
    streaming = false;
    streamMsgId = "";
    streamText = "";
    streamReasoning = "";
    streamTools = [];
    abortCtrl = null;
    chatGen++;
  }

  function shownContent(m: AiChatMessage): string {
    return streaming && m.id === streamMsgId ? streamText : m.content;
  }

  function shownReasoning(m: AiChatMessage): string {
    if (streaming && m.id === streamMsgId) return streamReasoning;
    return m.reasoning || "";
  }

  function toolsOf(m: AiChatMessage): AiChatToolTrace[] {
    if (streaming && m.id === streamMsgId) return streamTools;
    return m.tools || [];
  }

  function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /** Markdown + ```mindmap 围栏 → 顺序渲染片段（缓存保证导图节点对象稳定） */
  function segmentsOf(m: AiChatMessage): RenderSegment[] {
    const text = shownContent(m);
    if (!text.trim()) return [];
    const hit = segmentCache.get(m.id);
    if (hit && hit.text === text) return hit.segs;
    let segs: RenderSegment[];
    try {
      segs = splitMindmapSegments(text).map((seg) =>
        seg.kind === "mindmap"
          ? { kind: "mindmap", root: seg.root }
          : { kind: "html", html: renderAssistantMarkdown(seg.markdown) },
      );
    } catch (e) {
      logSwallow(e, "AiPanel.svelte · segmentsOf", "warn");
      segs = [{ kind: "html", html: `<p>${escapeHtml(text)}</p>` }];
    }
    segmentCache.set(m.id, { text, segs });
    return segs;
  }

  /** 回答大纲 → 导图（没有足够结构时返回 null，不显示入口） */
  function outlineOf(m: AiChatMessage): MindmapNode | null {
    if (!m.content.trim()) return null;
    if (streaming && m.id === streamMsgId) return null;
    const hit = outlineCache.get(m.id);
    if (hit && hit.text === m.content) return hit.root;
    let root: MindmapNode | null = null;
    try {
      root = outlineFromMarkdown(m.content);
    } catch (e) {
      logSwallow(e, "AiPanel.svelte · outlineOf", "debug");
    }
    outlineCache.set(m.id, { text: m.content, root });
    return root;
  }

  /* ============================ 对话动作 ============================ */

  async function send(): Promise<void> {
    if (streaming) return;
    if (editingId) {
      notice = t("请先完成或取消正在编辑的消息");
      return;
    }
    const question = String(composer?.getText?.() || "").trim();
    if (!question) return;
    syncCred();
    if (!isAiReady(cred)) {
      openSettings();
      notice = t("请先在设置里填写接口地址与模型");
      return;
    }

    notice = "";
    notePlan = null;
    notePlanError = "";
    mindmapView = null;
    showToc = false;
    hidePreview();
    const quote = pendingQuote;
    pendingQuote = null;
    composer?.clear?.();

    // 本轮的上下文范围与知识区开关先落在用户消息上：即便读取失败/回退，
    // 重新生成时也能按用户当时的意图重放。
    const requestedScope: AiTurnScope = activeTurnScope();
    const requestedRange = readRange ? { ...readRange } : null;
    const effectiveKnowledge = knowledgeOn ? knowledge : null;
    const userMsg: AiChatMessage = {
      id: newMessageId(),
      role: "user",
      content: question,
      createdAt: Date.now(),
      scope: requestedScope,
      useKnowledge: !!effectiveKnowledge,
    };
    if (requestedRange) userMsg.range = requestedRange;
    if (quote) userMsg.quote = quote;

    const firstTurn = messages.length === 0;
    const history = pickHistory(messages, prefs.historyTurns);
    const assistant: AiChatMessage = {
      id: newMessageId(),
      role: "assistant",
      content: "",
      createdAt: Date.now(),
    };
    messages = [...messages, userMsg, assistant];
    if (firstTurn) {
      // 先落本地标题，保证列表立刻有名字；AI 标题随后异步替换
      persistChat();
      const sessionId = sessionState.activeId;
      const baseTitle = sessionState.sessions.find((s) => s.id === sessionId)?.title || "";
      if (baseTitle) void autoNameSession(sessionId, baseTitle, question, chatGen);
    }
    await runTurn(userMsg, assistant, history);
  }

  /**
   * 首条消息后的异步命名。
   * 只发一次低 token 请求，失败静默；落盘前四道守卫：
   *  ① 书本代次没变 ② 会话还在 ③ 标题仍是本地生成 ④ 内容仍是发起时那份
   * 用户手改过的标题（titleSource=user）永远不覆盖。
   */
  async function autoNameSession(
    sessionId: string,
    baseTitle: string,
    message: string,
    gen: number,
  ): Promise<void> {
    let settings: any = null;
    try {
      settings = getAiSettings?.() || null;
    } catch (e) {
      logSwallow(e, "AiPanel.svelte · autoNameSession · settings", "debug");
      return;
    }
    if (!settings?.autoRenameSession) return;
    const target = resolveAutoRenameTarget(settings, {
      baseUrl: cred.baseUrl,
      apiKey: cred.apiKey,
      model: cred.model,
    });
    if (!target) return;
    try {
      const res = await requestAIGenerate({
        messages: [{ role: "user", content: buildAutoRenamePrompt(settings.autoRenamePrompt, message) }],
        settings: {
          ...engineSettings(),
          baseUrl: target.baseUrl,
          apiKey: target.apiKey,
          model: target.model,
          temperature: 0.2,
          maxTokens: 256,
          modelParams: {},
        },
        jsonMode: false,
        timeout: 20000,
      });
      const title = cleanAutoTitle(res?.content || "");
      if (!title || gen !== chatGen) return;
      const session = sessionState.sessions.find((s) => s.id === sessionId);
      if (!session || !shouldApplyAutoTitle(session, baseTitle)) return;
      sessionState = saveStateFor(sessionBookId, {
        ...sessionState,
        sessions: sessionState.sessions.map((s) => (s.id === sessionId ? applyAiSessionTitle(s, title) : s)),
      });
    } catch (e) {
      logSwallow(e, "AiPanel.svelte · autoNameSession", "debug");
    }
  }

  /** 重新生成：回退到对应的提问，按当时的范围/知识区开关重放同一轮 */
  async function regenerate(m: AiChatMessage): Promise<void> {
    if (streaming) return;
    const idx = messages.findIndex((x) => x.id === m.id);
    if (idx < 1) return;
    const prev = messages[idx - 1];
    if (!prev || prev.role !== "user") return;
    if (messages.length > idx + 1 && !confirm(t("重新生成会移除这条之后的消息，继续？"))) return;
    syncCred();
    if (!isAiReady(cred)) {
      openSettings();
      notice = t("请先在设置里填写接口地址与模型");
      return;
    }
    notice = "";
    notePlan = null;
    notePlanError = "";
    mindmapView = null;
    hidePreview();
    messages = messages.slice(0, idx - 1);
    const history = pickHistory(messages, prefs.historyTurns);
    const userMsg: AiChatMessage = {
      id: newMessageId(),
      role: "user",
      content: prev.content,
      createdAt: prev.createdAt,
    };
    if (prev.quote) userMsg.quote = prev.quote;
    if (prev.scope) userMsg.scope = prev.scope;
    if (prev.range) userMsg.range = { ...prev.range };
    if (typeof prev.useKnowledge === "boolean") userMsg.useKnowledge = prev.useKnowledge;
    const assistant: AiChatMessage = {
      id: newMessageId(),
      role: "assistant",
      content: "",
      createdAt: Date.now(),
    };
    messages = [...messages, userMsg, assistant];
    await runTurn(userMsg, assistant, history);
  }

  /* ---------- P1：编辑重发 / 失败重试 / 停止继续 ---------- */

  async function startEdit(m: AiChatMessage): Promise<void> {
    if (streaming || m.role !== "user") return;
    editingId = m.id;
    editText = m.content;
    await tick();
    editEl?.focus();
    const end = editEl?.value.length ?? 0;
    editEl?.setSelectionRange?.(end, end);
  }

  function cancelEdit(): void {
    editingId = "";
    editText = "";
  }

  /** 切会话/新建前先处理未发送的编辑草稿 */
  function leaveEditGuard(): boolean {
    if (!editingId) return true;
    const original = messages.find((m) => m.id === editingId)?.content || "";
    if (editText.trim() === original.trim()) {
      cancelEdit();
      return true;
    }
    if (!confirm(t("编辑中的内容尚未发送，切换会丢弃，继续？"))) return false;
    cancelEdit();
    return true;
  }

  function onEditKeydown(e: KeyboardEvent): void {
    if (e.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
      return;
    }
    if (!wantsSendOnEnter(e, sendShortcut)) return;
    e.preventDefault();
    const m = messages.find((x) => x.id === editingId);
    if (m) void resendEdited(m);
  }

  /** 开始一轮前的统一检查与瞬态清理；返回 false 表示已提示、不要发请求 */
  function beginTurn(): boolean {
    syncCred();
    if (!isAiReady(cred)) {
      openSettings();
      notice = t("请先在设置里填写接口地址与模型");
      return false;
    }
    notice = "";
    notePlan = null;
    notePlanError = "";
    mindmapView = null;
    hidePreview();
    return true;
  }

  function freshAssistant(): AiChatMessage {
    return { id: newMessageId(), role: "assistant", content: "", createdAt: Date.now() };
  }

  /** 编辑重发：截断该消息之后的所有内容，按原引用/范围/知识区开关重放 */
  async function resendEdited(m: AiChatMessage): Promise<void> {
    if (streaming) return;
    const idx = messages.findIndex((x) => x.id === m.id);
    if (idx < 0) return;
    const question = editText.trim();
    if (!question) return;
    const removed = editRemovedCount(messages, m.id);
    if (removed > 0 && !confirm(t("重新发送会移除这条之后的 {n} 条消息，继续？", { n: removed }))) return;
    if (!beginTurn()) return;

    const draft = editResendDraft(m);
    const userMsg: AiChatMessage = {
      id: newMessageId(),
      role: "user",
      content: question,
      createdAt: Date.now(),
    };
    if (draft.quote) userMsg.quote = draft.quote;
    if (draft.scope) userMsg.scope = draft.scope;
    if (draft.range) userMsg.range = draft.range;
    if (typeof draft.useKnowledge === "boolean") userMsg.useKnowledge = draft.useKnowledge;

    cancelEdit();
    segmentCache.delete(m.id);
    messages = messages.slice(0, idx);
    const history = pickHistory(messages, prefs.historyTurns);
    const assistant = freshAssistant();
    messages = [...messages, userMsg, assistant];
    await runTurn(userMsg, assistant, history);
  }

  /** 失败卡：四类错误只给行动建议，原文收进「详情」 */
  function errorInfoOf(m: AiChatMessage): { title: string; hint: string } {
    const info = classifyAiError(m.errorText || m.content);
    switch (info.kind) {
      case "auth":
        return { title: t("鉴权失败"), hint: t("请检查 API Key 与平台权限后重试") };
      case "rate":
        return { title: t("请求过于频繁"), hint: t("请稍后重试，或换用更小的模型") };
      case "server":
        return { title: t("服务端异常"), hint: t("请稍后重试；若持续出现请检查接口地址") };
      case "network":
        return { title: t("网络或超时"), hint: t("请检查网络与代理设置后重试") };
      default:
        return { title: t("请求失败"), hint: t("可以重试；仍失败时请查看错误详情") };
    }
  }

  function maskedError(m: AiChatMessage): string {
    const raw = String(m.errorText || (m.error ? m.content : "") || "");
    return maskApiKeyInText(raw, cred.apiKey).trim() || t("无错误详情");
  }

  async function copyError(m: AiChatMessage): Promise<void> {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(maskedError(m));
      copiedErrorId = m.id;
      setTimeout(() => {
        if (copiedErrorId === m.id) copiedErrorId = "";
      }, 1600);
    } catch (e) {
      logSwallow(e, "AiPanel.svelte · copyError", "warn");
      notice = t("复制失败，请检查剪贴板权限");
    }
  }

  async function retryMessage(m: AiChatMessage): Promise<void> {
    await regenerate(m);
  }

  /** 停止后继续：保留半截回答作为历史，重新提问并追加继续提示（只进请求，不改气泡） */
  async function continueMessage(m: AiChatMessage): Promise<void> {
    if (streaming) return;
    const idx = messages.findIndex((x) => x.id === m.id);
    if (idx < 1) return;
    let prev: AiChatMessage | undefined;
    for (let i = idx - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        prev = messages[i];
        break;
      }
    }
    if (!prev) return;
    if (!beginTurn()) return;

    const base = messages.slice(0, idx + 1);
    const history = pickHistory(base, prefs.historyTurns, { includeAborted: true });
    // 复用原提问，只在请求里附「继续」提示：不再插入一条内容一模一样的用户气泡
    const userMsg: AiChatMessage = { ...prev, continuation: true };
    const assistant = freshAssistant();
    messages = [...base, assistant];
    await runTurn(userMsg, assistant, history);
  }

  /** 代码块复制按钮：Lute 输出会被 {@html} 整体替换，用观察器在每次重渲染后补挂 */
  function codeCopy(node: HTMLElement) {
    const attach = (): void => {
      node.querySelectorAll("pre").forEach((pre) => {
        if (pre.querySelector(":scope > .ai-code-copy")) return;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ai-code-copy";
        btn.textContent = t("复制");
        btn.setAttribute("aria-label", t("复制代码"));
        btn.addEventListener("click", async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const code = pre.querySelector("code");
          const text = code?.textContent || pre.textContent || "";
          try {
            if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
            await navigator.clipboard.writeText(text);
            btn.textContent = t("已复制");
          } catch (e) {
            logSwallow(e, "AiPanel.svelte · codeCopy", "warn");
            btn.textContent = t("复制失败");
          }
          setTimeout(() => {
            btn.textContent = t("复制");
          }, 1600);
        });
        pre.appendChild(btn);
      });
    };
    attach();
    const mo = new MutationObserver(attach);
    mo.observe(node, { childList: true, subtree: true });
    return { destroy: () => mo.disconnect() };
  }

  /** 发送/重新生成共用的一轮：取上下文 → 组装提示词 → 流式 + 工具循环 → 落盘 */
  async function runTurn(
    userMsg: AiChatMessage,
    assistant: AiChatMessage,
    history: ReturnType<typeof pickHistory>,
  ): Promise<void> {
    // 换书会 abort 本次请求；用代次判断收尾是否还属于当前会话（AI 页签跟随模式）
    const turnGen = chatGen;
    const question = userMsg.content;
    const quote = userMsg.quote || null;
    const requestedScope = normalizeTurnScope(userMsg.scope);
    const effectiveKnowledge = userMsg.useKnowledge === false ? null : knowledge;

    streamMsgId = assistant.id;
    streamText = "";
    streamReasoning = "";
    streamTools = [];
    tokenBuf = "";
    reasonBuf = "";
    streaming = true;
    void autoScroll(true);

    // 1) 阅读上下文（失败不阻断：至少还能做通用阅读问答）
    //    「本页」读不到文字（纯图页 / 宿主未接线）时明确回退本章，避免用户以为答的是本页。
    //    「目录范围」同理：宿主读不到就回退本章，但消息上仍保留用户原来的选择。
    let snapshot: any = null;
    let ctx: ChapterContext | null = null;
    let scopeUsed: AiTurnScope = requestedScope;
    let rangeUsed: AiReadRange | null = requestedScope === "range" ? normalizeReadRange(userMsg.range) : null;
    let rangeSelected = rangeSpan(rangeUsed);
    let rangeChapters = 0;

    const readChapter = async (): Promise<void> => {
      if (!getChapter) return;
      try {
        snapshot = await getChapter({ maxChars: prefs.contextChars });
      } catch (e) {
        logSwallow(e, "AiPanel.svelte · send · getChapter", "warn");
        snapshot = { ok: false };
      }
      if (snapshot?.ok) ctx = buildChapterContext(snapshot, prefs.contextChars);
      else notice = t("未能读取本章正文，本次回答不含章节上下文");
    };

    if (!readCtx) {
      // 无正文上下文：通用对话没有书；查看历史时虽然知道是哪本书，
      // 但没有它的阅读器实例，读不到正文，也不该提示「未读到本章」。
      scopeUsed = requestedScope;
    } else if (requestedScope === "range") {
      if (getRange && rangeUsed) {
        try {
          snapshot = await getRange({
            fromSection: rangeUsed.from,
            toSection: rangeUsed.to,
            maxChars: prefs.contextChars,
          });
        } catch (e) {
          logSwallow(e, "AiPanel.svelte · send · getRange", "warn");
          snapshot = { ok: false };
        }
        if (snapshot?.ok && snapshot.text) {
          ctx = {
            text: String(snapshot.text),
            chars: Number(snapshot.chars) || String(snapshot.text).length,
            paragraphs: Number(snapshot.paragraphs) || 0,
            truncated: !!snapshot.truncated,
          };
          rangeUsed = normalizeReadRange({ from: snapshot.fromSection, to: snapshot.toSection }) || rangeUsed;
          rangeSelected = Math.max(1, Number(snapshot.selectedChapters) || rangeSpan(rangeUsed));
          rangeChapters = Math.max(0, Number(snapshot.chaptersRead) || 0);
        } else {
          notice = t("未能读取所选章节范围，已改用本章");
        }
      } else {
        notice = t("当前阅读器不支持按目录范围读取，已改用本章");
      }
      if (!ctx) {
        scopeUsed = "chapter";
        snapshot = null;
        await readChapter();
      }
    } else {
      const pageWanted = requestedScope === "page";
      if (pageWanted && !getPage) {
        scopeUsed = "chapter";
        notice = t("当前阅读器不支持按页读取，已改用本章");
      }
      const readFn = pageWanted && getPage ? getPage : getChapter;
      if (readFn) {
        try {
          snapshot = await readFn({ maxChars: prefs.contextChars });
        } catch (e) {
          logSwallow(e, "AiPanel.svelte · send · getContext", "warn");
          snapshot = { ok: false };
        }
        if (pageWanted && getPage && (!snapshot?.ok || !Array.isArray(snapshot?.paragraphs) || !snapshot.paragraphs.length)) {
          let chapterSnap: any = null;
          if (getChapter) {
            try {
              chapterSnap = await getChapter({ maxChars: prefs.contextChars });
            } catch (e) {
              logSwallow(e, "AiPanel.svelte · send · getChapter fallback", "warn");
            }
          }
          if (chapterSnap?.ok) {
            snapshot = chapterSnap;
            scopeUsed = "chapter";
            notice = t("本页没有可读文字，已改用本章");
          } else {
            notice = t("未能读取本页正文，本次回答不含阅读上下文");
          }
        }
        if (snapshot?.ok) {
          ctx = buildChapterContext(snapshot, prefs.contextChars);
        } else if (scopeUsed === "chapter" && !pageWanted) {
          notice = t("未能读取本章正文，本次回答不含章节上下文");
        }
      }
    }
    // 注意：不要用 scopeUsed 覆盖 userMsg.scope —— 消息上保留「用户当时选的」
    // 范围（本页/本章/目录范围），重新生成才能按原意图重放；实际回退只体现在回执上。
    const chapterTitle = String(
      snapshot?.chapterTitle || (scopeUsed === "range" && rangeUsed ? rangeLabel(rangeUsed) : "") || chapterLabel || "",
    ).trim();
    let knowledgeChars = 0;
    let knowledgeTruncated = false;

    // 2) 组装请求（宿主可用时追加工具说明，让模型知道能自己翻书）
    // 工具依赖阅读器实例：查看历史时没有实例，不能给工具，否则模型会调空
    const host = readCtx
      ? (() => {
          try {
            return getReaderToolHost?.() || null;
          } catch (e) {
            logSwallow(e, "AiPanel.svelte · send · getReaderToolHost", "warn");
            return null;
          }
        })()
      : null;
    const toolDefs = host ? buildReaderToolDefs() : [];
    let systemPrompt = !hasBook
      ? buildGeneralSystemPrompt()
      : buildReaderSystemPrompt({
      bookTitle,
      author: bookAuthor,
      chapterTitle,
      sectionIndex: snapshot?.sectionIndex,
      totalSections: snapshot?.totalSections,
      primer: getPrimer?.() || "",
      scope: scopeUsed,
      page: snapshot?.page,
      totalPages: snapshot?.totalPages,
      range: scopeUsed === "range" ? rangeUsed || undefined : undefined,
      rangeChapters: scopeUsed === "range" ? rangeChapters : undefined,
    });
    // 2.1) 目录：压成编号清单，让模型知道全书结构（读单章/范围时不必靠猜）
    if (readCtx && getToc) {
      await ensureToc();
      if (tocItems.length >= 2) {
        const tocPrompt = buildTocPrompt(tocItems);
        if (tocPrompt.text) systemPrompt += "\n\n" + tocPrompt.text;
      }
    }
    if (toolDefs.length) systemPrompt += "\n\n" + READER_TOOLS_PROMPT;

    // 2.5) 知识区：用户选定的思源笔记作为背景资料（读取失败不阻断问答）
    if (effectiveKnowledge) {
      let why = "";
      try {
        const kr = readKnowledge ? await readKnowledge(effectiveKnowledge) : { ok: false, error: t("知识区读取未就绪") };
        if (kr?.ok && kr.markdown) {
          const payload = buildKnowledgePrompt(effectiveKnowledge, kr.markdown, prefs.knowledgeChars);
          if (payload.text) {
            systemPrompt += "\n\n" + payload.text;
            knowledgeChars = payload.chars;
            knowledgeTruncated = payload.truncated;
          } else {
            why = t("文档内容为空");
          }
        } else {
          why = kr?.error || t("读取失败");
        }
      } catch (e: any) {
        logSwallow(e, "AiPanel.svelte · send · readKnowledge", "warn");
        why = e?.message || String(e);
      }
      if (why && !knowledgeChars) {
        const msg = t("未能读取知识区（{why}），本次回答不含知识区", { why });
        notice = notice ? `${notice}；${msg}` : msg;
      }
    }
    let userContent = buildUserTurnContent({
      question,
      quote,
      chapter: ctx,
      chapterTitle,
      sectionIndex: snapshot?.sectionIndex,
      totalSections: snapshot?.totalSections,
      scope: scopeUsed,
      page: snapshot?.page,
      totalPages: snapshot?.totalPages,
      range: scopeUsed === "range" ? rangeUsed || undefined : undefined,
      rangeChapters: scopeUsed === "range" ? rangeChapters : undefined,
    });
    if (userMsg.continuation) userContent += "\n\n" + CONTINUE_HINT;
    const reqMessages: AiMessage[] = buildChatRequestMessages({
      systemPrompt,
      history,
      userContent,
    });

    // 3) 流式请求 + 工具循环
    //    每一轮：模型 →（可能）tool_calls → 本地执行 → 结果回灌 → 再来一轮，
    //    直到模型给出最终回答、用户中断或触达上限。
    const requestMessages: AiMessage[] = [...reqMessages];
    let useTools = toolDefs.length > 0;
    const trace: AiChatToolTrace[] = [];
    streamTools = trace;
    let toolRounds = 0;
    let toolCallCount = 0;
    let toolNotice = "";
    /** 工具循环可能多轮，用量按轮累加；服务商不返回时保持 undefined */
    let usageTotal: AiUsageSnapshot | undefined;
    const mergeUsage = (u: any): void => {
      if (!u) return;
      const prompt = Number(u.promptTokens) || 0;
      const completion = Number(u.completionTokens) || 0;
      const total = Number(u.totalTokens) || prompt + completion;
      if (!prompt && !completion && !total) return;
      const prev = usageTotal;
      usageTotal = {
        promptTokens: (prev?.promptTokens || 0) + prompt || undefined,
        completionTokens: (prev?.completionTokens || 0) + completion || undefined,
        totalTokens: (prev?.totalTokens || 0) + total,
      };
    };

    abortCtrl = new AbortController();
    const signal = abortCtrl.signal;
    let res: any = null;
    const askOnce = () =>
      requestAIStream({
        messages: requestMessages,
        settings: engineSettings(),
        jsonMode: false,
        timeout: 120000,
        signal,
        tools: useTools ? toolDefs : undefined,
        toolChoice: useTools ? "auto" : undefined,
        onToken: (chunk: string) => {
          tokenBuf += chunk;
          scheduleFlush();
        },
        onReasoning: (chunk: string) => {
          reasonBuf += chunk;
          scheduleFlush();
        },
      });

    while (true) {
      try {
        res = await askOnce();
      } catch (e: any) {
        logSwallow(e, "AiPanel.svelte · send · requestAIStream", "warn");
        res = { ok: false, content: "", error: e?.message || String(e) };
      }
      flushNow();
      mergeUsage(res?.usage);
      if (
        useTools &&
        res?.ok === false &&
        !tokenBuf &&
        toolRounds === 0 &&
        TOOL_FALLBACK_RE.test(String(res?.error || ""))
      ) {
        useTools = false;
        toolNotice = t("当前模型不支持阅读工具，已改为直接回答");
        continue;
      }

      const calls = useTools && Array.isArray(res?.toolCalls) ? res.toolCalls : [];
      if (!res?.ok || res?.aborted || !calls.length) break;

      if (toolRounds >= MAX_TOOL_ROUNDS || toolCallCount + calls.length > MAX_TOOL_CALLS) {
        toolNotice = t("已达到阅读工具调用上限，回答可能不完整");
        break;
      }

      // 回传 assistant 的 tool_calls（OpenAI 要求与 tool 消息成对）
      requestMessages.push({
        role: "assistant",
        content: String(res.content || ""),
        toolCalls: calls,
        reasoning: typeof res.reasoning === "string" ? res.reasoning : undefined,
      });

      let userAborted = false;
      for (const call of calls) {
        if (signal.aborted) {
          userAborted = true;
          break;
        }
        const exec = await executeReaderTool(call?.function?.name || "", call?.function?.arguments, host);
        trace.push(toTrace(exec));
        streamTools = trace.slice();
        requestMessages.push({
          role: "tool",
          toolCallId: call?.id || "",
          content: stringifyToolResult(exec),
        });
        void autoScroll();
      }
      toolRounds++;
      toolCallCount += calls.length;
      if (userAborted) {
        res = { ok: true, aborted: true, content: "" };
        break;
      }
      // 跨轮拼接留段落间隔，避免「我先查一下」和最终回答黏成一句
      if (tokenBuf && !tokenBuf.endsWith("\n")) tokenBuf += "\n\n";
      if (reasonBuf && !reasonBuf.endsWith("\n")) reasonBuf += "\n\n";
    }
    flushNow();

    // 4) 收尾：保留已生成的部分内容，错误也落进消息里（可复制/重试）
    const finalText = String(tokenBuf || res?.content || "");
    const done: AiChatMessage = { ...assistant, content: finalText };
    if (usageTotal) done.usage = usageTotal;
    const reasoning = String(reasonBuf || res?.reasoning || "");
    if (reasoning.trim()) done.reasoning = reasoning;
    if (trace.length) done.tools = trace.slice();
    const note: AiChatContextNote = {};
    if (ctx) {
      note.scope = scopeUsed;
      if (snapshot?.page) note.page = snapshot.page;
      if (snapshot?.totalPages) note.totalPages = snapshot.totalPages;
      note.chapterTitle = chapterTitle || undefined;
      note.sectionIndex = snapshot?.sectionIndex;
      note.totalSections = snapshot?.totalSections;
      if (scopeUsed === "range" && rangeUsed) {
        note.rangeFrom = rangeUsed.from;
        note.rangeTo = rangeUsed.to;
        note.rangeChapters = rangeChapters;
        note.rangeSelected = rangeSelected;
        note.sectionIndex = rangeUsed.from;
      }
      note.chars = ctx.chars;
      note.paragraphs = ctx.paragraphs;
      note.truncated = ctx.truncated;
    }
    if (knowledgeChars) {
      note.knowledgeChars = knowledgeChars;
      note.knowledgeTitle = effectiveKnowledge?.docTitle || undefined;
      note.knowledgeTruncated = knowledgeTruncated;
    }
    if (Object.keys(note).length) done.context = note;
    if (res?.aborted) done.aborted = true;
    if (!res?.ok) {
      done.error = true;
      // 已生成的部分保留在气泡里；错误原文先脱敏再落盘，避免凭据随导出/存储外泄
      done.errorText = maskApiKeyInText(String(res?.error || ""), cred.apiKey).trim()
        || t("请求失败，请稍后重试");
    }
    if (toolNotice) notice = notice ? `${notice}；${toolNotice}` : toolNotice;

    if (turnGen !== chatGen) {
      if (streamMsgId === assistant.id) {
        streaming = false;
        streamMsgId = "";
        streamTools = [];
      }
      return;
    }

    messages = messages.map((m) => (m.id === assistant.id ? done : m));
    streaming = false;
    streamMsgId = "";
    streamTools = [];
    abortCtrl = null;
    persistChat();
    void autoScroll();

    if (!res?.ok) {
      getLogger().warn("[阅读助手] 请求失败", { error: res?.error, tools: useTools });
    }
  }

  function newChat(): void {
    if (!leaveEditGuard()) return;
    discardActiveTurn();
    persistChat();
    const active = activeSessionOf(sessionState);
    showHistory = false;
    historyQuery = "";
    historyMenu = "";
    historyToolsOpen = false;
    cancelRename();
    // 当前就是空会话：别再叠一条「新对话」，只清输入
    if (active && !active.messages.length) {
      composer?.clear?.();
      resetTransientUi();
      return;
    }
    // 顺手收掉其它空会话，避免连点「新对话」堆一串
    const rest = sessionState.sessions.filter((s) => s.messages.length > 0 || s.id === sessionState.activeId);
    const fresh = createSession([]);
    sessionState = saveStateFor(sessionBookId, {
      version: 1,
      activeId: fresh.id,
      sessions: [fresh, ...rest],
    });
    messages = [];
    composer?.clear?.();
    resetTransientUi();
  }

  function switchSession(id: string): void {
    if (!leaveEditGuard()) return;
    discardActiveTurn();
    if (id === sessionState.activeId) {
      showHistory = false;
      return;
    }
    persistChat();
    sessionState = saveStateFor(sessionBookId, withActiveSession(sessionState, id));
    const active = activeSessionOf(sessionState);
    messages = active ? active.messages.slice() : [];
    showHistory = false;
    historyQuery = "";
    historyMenu = "";
    historyToolsOpen = false;
    cancelRename();
    composer?.clear?.();
    resetTransientUi();
    void tick().then(() => autoScroll(true));
  }

  function deleteSession(id: string): void {
    const target = sessionState.sessions.find((s) => s.id === id);
    if (!target) return;
    if (!confirm(t("删除这条会话？只删除本机记录，不影响已写入的思源笔记。"))) return;
    discardActiveTurn();
    const wasActive = id === sessionState.activeId;
    let next = removeSession(sessionState, id);
    if (!next.sessions.length) {
      const fresh = createSession([]);
      next = { version: 1, activeId: fresh.id, sessions: [fresh] };
    }
    // 显式删除：跳过缩水守卫，并写入墓碑防止另一实例把已删会话写回来
    sessionState = saveStateFor(sessionBookId, next, { explicit: true, removedIds: [id] });
    if (wasActive) {
      const active = activeSessionOf(sessionState);
      messages = active ? active.messages.slice() : [];
      composer?.clear?.();
      resetTransientUi();
    }
  }

  function clearAllSessions(): void {
    if (!confirm(t("清空全部历史会话？只删除本机记录，不影响已写入的思源笔记。"))) return;
    discardActiveTurn();
    // 清空是显式动作：跳过缩水守卫，并把当前所有会话写进墓碑
    const removedIds = sessionState.sessions.map((s) => s.id);
    const fresh = createSession([]);
    sessionState = saveStateFor(
      sessionBookId,
      { version: 1, activeId: fresh.id, sessions: [fresh] },
      { explicit: true, removedIds },
    );
    messages = [];
    showHistory = false;
    historyQuery = "";
    historyMenu = "";
    historyToolsOpen = false;
    cancelRename();
    composer?.clear?.();
    resetTransientUi();
  }

  /** 平铺列表：置顶优先 + 最近更新；搜索覆盖标题、预览与全部消息正文 */
  function historyList(): AiChatSession[] {
    const q = historyQuery.trim().toLowerCase();
    return sortSessionsForHistory(
      sessionState.sessions.filter((s) => {
        if (historyFilter === "pinned" && !s.pinned) return false;
        if (!q) return true;
        const hay = [s.title, sessionPreview(s, 200), ...s.messages.map((m) => m.content)].join("\n").toLowerCase();
        return hay.includes(q);
      }),
    );
  }

  /** 行内时间：今天/昨天带时分，更早只给月日（列表本身已按时间倒序） */
  function historyTimeLabel(at: number): string {
    const bucket = sessionDayBucket(at);
    const clock = sessionClock(at);
    if (bucket === "today") return `${t("今天")} ${clock}`;
    if (bucket === "yesterday") return `${t("昨天")} ${clock}`;
    try {
      return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(at));
    } catch {
      return clock;
    }
  }

  function measureHistory(): void {
    if (!showHistory || !panelEl || !headerEl) return;
    const pr = panelEl.getBoundingClientRect();
    const hr = headerEl.getBoundingClientRect();
    historyTop = Math.max(0, Math.round(hr.bottom - pr.top + 6));
    historyMaxH = Math.max(200, Math.round(pr.height - historyTop - 8));
  }

  async function toggleHistory(): Promise<void> {
    if (showHistory) {
      closeHistory();
      return;
    }
    tab = "chat";
    showHistory = true;
    historyMenu = "";
    historyToolsOpen = false;
    await tick();
    measureHistory();
    historyEl?.focus();
  }

  function closeHistory(restoreFocus = true): void {
    if (!showHistory) return;
    const hadFocus = !!historyEl && typeof document !== "undefined" && historyEl.contains(document.activeElement);
    showHistory = false;
    historyMenu = "";
    historyToolsOpen = false;
    cancelRename();
    if (restoreFocus && hadFocus) void tick().then(() => historyBtnEl?.focus());
  }

  function setHistoryFilter(next: "all" | "pinned"): void {
    if (historyFilter === next) return;
    historyFilter = next;
    historyMenu = "";
    cancelRename();
  }

  function onHistoryKey(e: KeyboardEvent): void {
    if (!showHistory || e.key !== "Escape") return;
    if (renamingId) {
      e.preventDefault();
      cancelRename();
      return;
    }
    if (historyMenu) {
      e.preventDefault();
      historyMenu = "";
      return;
    }
    if (historyToolsOpen) {
      e.preventDefault();
      historyToolsOpen = false;
      return;
    }
    e.preventDefault();
    closeHistory();
  }

  function sessionTitleOf(s: AiChatSession): string {
    return s.title || titleFromMessages(s.messages) || t("新对话");
  }

  async function startRename(s: AiChatSession): Promise<void> {
    historyMenu = "";
    renamingId = s.id;
    renameText = sessionTitleOf(s);
    await tick();
    renameEl?.focus();
    renameEl?.select();
  }

  function cancelRename(): void {
    renamingId = "";
    renameText = "";
  }

  function commitRename(): void {
    const id = renamingId;
    const nextTitle = renameText.trim();
    renamingId = "";
    renameText = "";
    if (!id || !nextTitle) return;
    const target = sessionState.sessions.find((s) => s.id === id);
    if (!target || target.title === nextTitle) return;
    sessionState = saveStateFor(sessionBookId, {
      ...sessionState,
      sessions: sessionState.sessions.map((s) => (s.id === id ? renameSession(s, nextTitle) : s)),
    });
  }

  function onRenameKey(e: KeyboardEvent): void {
    e.stopPropagation();
    if (e.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      commitRename();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelRename();
    }
  }

  function togglePin(s: AiChatSession): void {
    if (!s.pinned && sessionState.sessions.filter((x) => x.pinned).length >= MAX_TOTAL_SESSIONS) {
      notice = t("置顶会话已达 {n} 条上限", { n: MAX_TOTAL_SESSIONS });
      return;
    }
    historyMenu = "";
    sessionState = saveStateFor(sessionBookId, setSessionPinned(sessionState, s.id, !s.pinned));
  }

  function downloadText(name: string, text: string, mime: string): void {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportSession(s: AiChatSession, format: "md" | "json"): void {
    historyMenu = "";
    if (!s.messages.length) {
      notice = t("这条会话还没有消息，没什么可导出的");
      return;
    }
    persistChat();
    const current = sessionState.sessions.find((x) => x.id === s.id) || s;
    const meta = { bookTitle, bookId };
    try {
      const name = sessionExportFileName(current, format, meta);
      if (format === "json") {
        downloadText(name, buildSessionJson(current, meta), "application/json;charset=utf-8");
      } else {
        downloadText(name, buildSessionMarkdown(current, meta), "text/markdown;charset=utf-8");
      }
      notice = t("已导出 {name}", { name });
    } catch (e) {
      logSwallow(e, "AiPanel.svelte · exportSession", "warn");
      notice = t("导出失败，请重试");
    }
  }

  /* ============================ 对话效率（P4-C） ============================ */

  function chatDayLabel(at: number): string {
    const mk = chatDayMarker(at);
    if (!mk) return "";
    if (mk.kind === "today") return t("今天");
    if (mk.kind === "yesterday") return t("昨天");
    return t("{month} 月 {day} 日", { month: mk.month, day: mk.day });
  }

  /** 首条或跨天时在消息上方插一条日期分隔 */
  function showDayBefore(idx: number): boolean {
    if (idx === 0) return true;
    return !sameChatDay(messages[idx - 1].createdAt, messages[idx].createdAt);
  }

  function modelOptions(): string[] {
    const list = [cred.model, ...cred.models].map((x) => String(x || "").trim()).filter(Boolean);
    return Array.from(new Set(list));
  }

  function onModelPill(): void {
    if (!isAiReady(cred) || modelOptions().length < 1) {
      openSettings();
      return;
    }
    modelMenu = !modelMenu;
  }

  async function pickModel(name: string): Promise<void> {
    modelMenu = false;
    const model = String(name || "").trim();
    if (!model || model === cred.model) return;
    try {
      await saveAiSettings?.(mergeAiCredentials(getAiSettings?.() || null, { model }));
      syncCred();
    } catch (e: any) {
      notice = e?.message || t("切换模型失败");
    }
  }

  function onWindowClick(e: MouseEvent): void {
    const el = e.target as HTMLElement | null;
    if (showToc && !el?.closest?.(".ai-ctx-wrap")) showToc = false;
    if (showHistory && !el?.closest?.(".ai-history, .ai-history-btn")) closeHistory();
    if (historyToolsOpen && !el?.closest?.(".ai-history-tools")) historyToolsOpen = false;
    if (historyMenu && !el?.closest?.(".ai-history-menu, .ai-history-more")) historyMenu = "";
    if (!modelMenu) return;
    if (el?.closest?.(".ai-model-pop, .ai-model-pill")) return;
    modelMenu = false;
  }

  async function copyMessage(m: AiChatMessage): Promise<void> {
    const text = String(m.content || "").trim();
    if (!text) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
      copiedId = m.id;
      setTimeout(() => {
        if (copiedId === m.id) copiedId = "";
      }, 1600);
    } catch (e) {
      logSwallow(e, "AiPanel.svelte · copyMessage", "warn");
      notice = t("复制失败，请检查剪贴板权限");
    }
  }

  async function locateQuote(q: AiChatQuote | null | undefined): Promise<void> {
    if (!q?.text) return;
    if (!onLocate) {
      notice = t("当前格式暂不支持原文定位");
      return;
    }
    try {
      const r = await onLocate(q.text, q.sectionIndex);
      if (r && r.ok === false) notice = t("未能在当前章节定位到这段原文");
    } catch (e) {
      logSwallow(e, "AiPanel.svelte · locateQuote", "warn");
      notice = t("定位失败");
    }
  }

  /** 助手消息对应的用户引用（用于「定位原文」） */
  function quoteOfAssistant(index: number): AiChatQuote | null {
    for (let i = index - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "user" && m.quote?.text) return m.quote;
    }
    return null;
  }

  /* ============================ 悬浮预览（块引用） ============================ */

  async function openBlockById(id: string): Promise<void> {
    if (!id) return;
    try {
      const api: any = await import("../../siyuan/api.ts");
      await api.openBlock(id);
    } catch (e) {
      logSwallow(e, "AiPanel.svelte · openBlockById", "warn");
      notice = t("打开引用失败（块可能已被删除）");
    }
  }

  /** 笔记 Tab：打开已写入的文档（文档 ID 也是块 ID） */
  function openNote(note: AiChatNoteReceipt | undefined): void {
    if (!note?.docId) return;
    void openBlockById(note.docId);
  }

  function noteDate(at: number): string {
    const d = new Date(Number(at) || 0);
    if (!Number.isFinite(d.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function canHover(): boolean {
    try {
      return typeof matchMedia !== "function" || matchMedia("(hover: hover) and (pointer: fine)").matches;
    } catch {
      return true;
    }
  }

  function clearPreviewTimers(): void {
    if (previewShowTimer) {
      clearTimeout(previewShowTimer);
      previewShowTimer = null;
    }
    if (previewHideTimer) {
      clearTimeout(previewHideTimer);
      previewHideTimer = null;
    }
  }

  function cancelPreviewHide(): void {
    if (previewHideTimer) {
      clearTimeout(previewHideTimer);
      previewHideTimer = null;
    }
  }

  function hidePreview(): void {
    clearPreviewTimers();
    previewFor = "";
    preview = null;
  }

  function schedulePreviewHide(): void {
    cancelPreviewHide();
    previewHideTimer = setTimeout(() => {
      previewHideTimer = null;
      previewFor = "";
      preview = null;
    }, 180);
  }

  function onRefOver(e: MouseEvent): void {
    if (!canHover() || streaming) return;
    const id = blockIdFromTarget(e.target as Element);
    if (!id || id === previewFor) return;
    cancelPreviewHide();
    previewFor = id;
    if (previewShowTimer) clearTimeout(previewShowTimer);
    const rect = (e.target as Element).getBoundingClientRect?.() || null;
    if (!rect) return;
    previewShowTimer = setTimeout(() => {
      previewShowTimer = null;
      void showBlockPreview(id, rect);
    }, 260);
  }

  function onRefOut(e: MouseEvent): void {
    const id = blockIdFromTarget(e.target as Element);
    if (!id || id !== previewFor) return;
    const next = e.relatedTarget as Element | null;
    if (next?.closest?.(".ai-block-preview")) return;
    if (previewShowTimer) {
      clearTimeout(previewShowTimer);
      previewShowTimer = null;
    }
    schedulePreviewHide();
  }

  async function showBlockPreview(id: string, rect: DOMRect): Promise<void> {
    if (previewFor !== id) return;
    let item = previewCache.get(id);
    if (!item) {
      try {
        const api: any = await import("../../siyuan/api.ts");
        const r = await api.getBlockKramdown(id, "md");
        const md = String(r?.kramdown || "").trim();
        if (!md) throw new Error(t("块内容为空"));
        item = { id, html: renderAssistantMarkdown(md) };
      } catch (e: any) {
        logSwallow(e, "AiPanel.svelte · showBlockPreview", "debug");
        item = { id, html: "", error: e?.message || t("预览加载失败") };
      }
      previewCache.set(id, item);
      if (previewCache.size > 40) {
        const oldest = previewCache.keys().next().value;
        if (oldest) previewCache.delete(oldest);
      }
    }
    if (previewFor !== id) return;
    preview = item;
    await positionPreview(rect);
  }

  async function positionPreview(rect: DOMRect): Promise<void> {
    await tick();
    if (!preview) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(360, Math.max(220, vw - 16));
    const h = Math.min(previewEl?.offsetHeight || 160, Math.max(140, vh * 0.5));
    const left = Math.min(Math.max(8, rect.left), vw - w - 8);
    const above = rect.top - h - 10;
    const top = above >= 8 ? above : Math.min(rect.bottom + 10, vh - h - 8);
    previewStyle = `left:${Math.round(left)}px;top:${Math.round(Math.max(8, top))}px;width:${Math.round(w)}px;max-height:${Math.round(h)}px`;
  }

  /* ============================ 知识区 ============================ */

  function onKnowledgePicked(p: { docId: string; docTitle?: string; notebookName?: string } | null): void {
    showKnowledgePicker = false;
    if (!p?.docId) return;
    knowledge = { docId: p.docId, docTitle: p.docTitle, notebookName: p.notebookName };
    knowledgeOn = true;
    saveKnowledgeSource(storage(), sessionBookId, knowledge);
  }

  function clearKnowledge(): void {
    knowledge = null;
    knowledgeOn = false;
    saveKnowledgeSource(storage(), sessionBookId, null);
  }

  /** 快捷上下文：本页 / 本章（偏好持久化，跨书沿用；显式点选会清掉目录范围） */
  function setContextScope(scope: AiContextScope): void {
    readRange = null;
    showToc = false;
    const next = normalizeContextScope(scope);
    if (next === contextScope) return;
    contextScope = next;
    prefs = { ...prefs, contextScope: next };
    persistPrefs();
  }

  /** 本轮实际范围：目录范围优先（一次性），否则用偏好里的本页/本章 */
  function activeTurnScope(): AiTurnScope {
    return readRange ? "range" : normalizeContextScope(contextScope);
  }

  /** 范围摘要：底部提示条与目录 chip 的 title 共用（按界面语言翻译） */
  function scopeSummary(): string {
    if (readRange) {
      return readRange.from === readRange.to
        ? t("第 {n} 章", { n: readRange.from + 1 })
        : t("第 {a}–{b} 章", { a: readRange.from + 1, b: readRange.to + 1 });
    }
    return contextScope === "page" ? t("本页") : (chapterLabel || t("本章"));
  }

  /** 目录只在需要时读一次；换书由 resetTransientUi 清缓存 */
  async function ensureToc(force = false): Promise<void> {
    if (!getToc) return;
    if (tocBusy) return;
    if (!force && tocLoadedFor === bookId && tocItems.length) return;
    const gen = ++tocGen;
    tocBusy = true;
    tocError = "";
    try {
      const raw = await getToc();
      if (gen !== tocGen) return;
      if (raw?.ok === false) {
        tocItems = [];
        tocError = t("目录读取失败");
        return;
      }
      tocItems = normalizeTocItems(raw?.items);
      tocCurrent = Number.isFinite(Number(raw?.currentSection)) ? Number(raw.currentSection) : -1;
      tocLoadedFor = bookId;
    } catch (e: any) {
      if (gen !== tocGen) return;
      logSwallow(e, "AiPanel.svelte · ensureToc", "warn");
      tocItems = [];
      tocError = e?.message ? String(e.message).slice(0, 120) : t("目录读取失败");
    } finally {
      if (gen === tocGen) tocBusy = false;
    }
  }

  async function toggleToc(): Promise<void> {
    if (showToc) {
      showToc = false;
      return;
    }
    showToc = true;
    // 每次打开都重取：阅读进度可能已经前进，「未读」标记与剧透提示要跟着更新
    await ensureToc(true);
  }

  /** 第一次点选起点，第二次点另一章成范围；第三次重新起头 */
  function pickTocSection(section: number): void {
    readRange = pickRangeSection(readRange, section);
  }

  function clearReadRange(): void {
    readRange = null;
  }

  /** @笔记 chip：没选文档时先选；已选则切换本轮是否附带 */
  function onKnowledgeChip(): void {
    if (!knowledge) {
      showKnowledgePicker = true;
      return;
    }
    knowledgeOn = !knowledgeOn;
  }

  /* ============================ 笔记方案（预览优先） ============================ */

  /** 这条助手回答对应的用户问题与选段（笔记来源行用） */
  function nearestQuestion(index: number): { question: string; quote?: string } {
    for (let i = index - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "user") return { question: m.content, quote: m.quote?.text };
    }
    return { question: "" };
  }

  /**
   * 让模型把某条回答整理成笔记方案。
   * 只生成 + 预览，不写入；写入必须用户点「写入思源」。
   */
  async function proposeNote(m: AiChatMessage): Promise<void> {
    if (streaming || notePlanBusyId) return;
    const answer = String(m.content || "").trim();
    if (!answer) return;
    syncCred();
    if (!isAiReady(cred)) {
      openSettings();
      notice = t("请先在设置里填写接口地址与模型");
      return;
    }
    notePlanError = "";
    notePlanBusyId = m.id;
    notePlan = null;
    mindmapView = null;
    hidePreview();
    try {
      const idx = messages.findIndex((x) => x.id === m.id);
      const qa = nearestQuestion(idx);
      const req = buildNotePlanRequest({
        answer,
        bookTitle,
        author: bookAuthor,
        chapterTitle: chapterLabel,
        question: qa.question,
        quote: qa.quote,
      });
      const requestMessages: AiMessage[] = [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ];
      let content = "";
      try {
        const res = await requestAIGenerate({
          messages: requestMessages,
          settings: engineSettings(),
          jsonMode: true,
          timeout: 90000,
        });
        content = String(res?.content || "");
      } catch (e: any) {
        const why = e?.message || String(e);
        // 部分模型/网关不认 response_format：去掉 jsonMode 重试一次
        if (!/json|response_format|400|422/i.test(why)) throw e;
        const res = await requestAIGenerate({
          messages: requestMessages,
          settings: engineSettings(),
          jsonMode: false,
          timeout: 90000,
        });
        content = String(res?.content || "");
      }
      const plan = parseNotePlan(content, { fallbackTitle: chapterLabel || bookTitle });
      if (!plan) throw new Error(t("未能解析笔记方案，请重试"));
      const target: NoteTargetInfo = resolveNoteTarget
        ? await resolveNoteTarget()
        : { ok: false, error: t("笔记写入未就绪") };
      notePlan = { messageId: m.id, plan, target };
    } catch (e: any) {
      notePlanError = e?.message || String(e);
      notice = notePlanError;
    } finally {
      notePlanBusyId = "";
    }
  }

  async function commitNote(): Promise<void> {
    const plan = notePlan;
    if (!plan || noteWriteBusy) return;
    if (!plan.target.ok) {
      notice = plan.target.error;
      return;
    }
    if (!writeNotePlan) {
      notice = t("笔记写入未就绪");
      return;
    }
    noteWriteBusy = true;
    notePlanError = "";
    try {
      const r = await writeNotePlan(plan.plan);
      if (!r.ok) throw new Error(r.error);
      const receipt: AiChatNoteReceipt = {
        title: plan.plan.title,
        docId: r.docId,
        docTitle: r.docTitle || undefined,
        at: Date.now(),
      };
      messages = messages.map((m) => (m.id === plan.messageId ? { ...m, note: receipt } : m));
      persistChat();
      notice = r.autoCreated
        ? t("已自动建立《{doc}》并写入笔记", { doc: r.docTitle || r.docId })
        : t("已写入《{doc}》", { doc: r.docTitle || r.docId });
      notePlan = null;
    } catch (e: any) {
      notePlanError = e?.message || String(e);
    } finally {
      noteWriteBusy = false;
    }
  }

  /** Markdown 内点击：块引用 → 打开思源块；外链 → 新窗口 */
  async function onMdClick(e: MouseEvent): Promise<void> {
    const target = e.target as Element | null;
    const blockId = blockIdFromTarget(target);
    if (blockId) {
      e.preventDefault();
      e.stopPropagation();
      hidePreview();
      await openBlockById(blockId);
      return;
    }
    const a = target?.closest?.("a") as HTMLAnchorElement | null;
    if (!a) return;
    const href = a.getAttribute("href") || "";
    if (/^https?:\/\//i.test(href)) {
      e.preventDefault();
      window.open(href, "_blank", "noopener,noreferrer");
    } else if (href.startsWith("siyuan://")) {
      e.preventDefault();
    }
  }

  /* ============================ 思维导图（回答大纲） ============================ */

  function toggleMindmap(m: AiChatMessage): void {
    if (mindmapView?.messageId === m.id) {
      mindmapView = null;
      return;
    }
    const root = outlineOf(m);
    if (!root) return;
    notePlan = null;
    mindmapView = { messageId: m.id, root };
  }

  /* ============================ 设置窗口 ============================ */

  function openSettings(): void {
    syncCred();
    settingsOpen = true;
  }

  /** 窗口保存偏好后回填面板：宽度、范围、字号与发送键都即时生效 */
  function applyPrefsFromDialog(next: AiPanelPrefs): void {
    prefs = normalizeAiPanelPrefs(next);
    width = clampWidth(prefs.width);
    contextScope = normalizeContextScope(prefs.contextScope);
    persistPrefs();
    syncCred();
  }

  // 模板表达式走 acorn（纯 JS），不能写 `as HTMLInputElement` 这类 TS 断言，故取值收进脚本。
  function textOf(e: Event): string {
    return (e.currentTarget as HTMLInputElement).value;
  }

  /* ============================ 拖动改宽 ============================ */

  let dragStartX = 0;
  let dragStartW = 0;
  let dragging = false;

  /** 当前视口允许的最大宽度：正文至少留 MIN_STAGE_WIDTH */
  function clampWidth(next: number): number {
    const vw = typeof window === "undefined" ? MAX_PANEL_WIDTH : window.innerWidth;
    const fit = vw > 0 ? vw - MIN_STAGE_WIDTH : MAX_PANEL_WIDTH;
    return Math.round(Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, Math.min(fit, next))));
  }

  function onResizeDown(e: PointerEvent): void {
    dragging = true;
    dragStartX = e.clientX;
    dragStartW = width;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }

  function onResizeMove(e: PointerEvent): void {
    if (!dragging) return;
    width = clampWidth(dragStartW + (dragStartX - e.clientX));
  }

  function onResizeUp(e: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    prefs = normalizeAiPanelPrefs({ ...prefs, width });
    persistPrefs();
  }

  /** 双击分屏条：回到默认宽度（拖歪了不用一点点找回来） */
  function resetWidth(): void {
    width = clampWidth(DEFAULT_AI_PANEL_PREFS.width);
    prefs = normalizeAiPanelPrefs({ ...prefs, width });
    persistPrefs();
  }

  /** 键盘微调：分屏条获得焦点后 ←/→ 每次 24px，Shift 加速到 96px */
  function onResizeKey(e: KeyboardEvent): void {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = e.shiftKey ? 96 : 24;
    width = clampWidth(width + (e.key === "ArrowLeft" ? step : -step));
    prefs = normalizeAiPanelPrefs({ ...prefs, width });
    persistPrefs();
  }

  /* ============================ 展示辅助 ============================ */

  let title = "";
  $: title = !hasBook ? t("AI 助手") : String(bookTitle || "").trim() || t("这本书");
  $: subline = !hasBook
    ? t("通用对话")
    : readCtx
      ? [String(bookAuthor || "").trim(), String(chapterLabel || "").trim()].filter(Boolean).join(" · ")
      : t("查看历史 · 未接入正文");
  /** 头部封面块：取书名首字，没有书名就用助手图标位 */
  $: coverChar = title && hasBook ? title.slice(0, 1) : "✦";
  /** 对话里助手的自称：通用模式不再叫「阅读助手」 */
  $: assistantLabel = hasBook ? t("阅读助手") : t("AI 助手");
  /** 已存笔记（跨会话汇总；新→旧） */
  $: savedNotes = collectSessionNotes(sessionState);

  const QUICK_ASKS: Array<{ label: string; text: string; sub: string; icon: string }> = [
    { label: t("本章速读"), text: t("用三句话概括本章的核心论证。"), sub: t("约 30 秒"), icon: "读" },
    { label: t("章节导图"), text: t(MINDMAP_QUICK_ASK), sub: t("自动读章"), icon: "图" },
    { label: t("提炼观点"), text: t("提炼本章的关键观点，并标注对应段落。"), sub: t("自动读章"), icon: "摘" },
    { label: t("解释这段"), text: t("解释我选中的这段话，结合上下文说明它的作用。"), sub: t("需先划词"), icon: "解" },
  ];

  const GENERAL_QUICK_ASKS: Array<{ label: string; text: string; sub: string; icon: string }> = [
    { label: t("总结要点"), text: t("帮我把这段话的要点总结成三条。"), sub: t("随手可用"), icon: "摘" },
    { label: t("解释概念"), text: t("用一个通俗的例子解释这个概念。"), sub: t("随口问"), icon: "解" },
    { label: t("列个提纲"), text: t("帮我列一份清晰的提纲。"), sub: t("通用"), icon: "纲" },
    { label: t("画成导图"), text: t(MINDMAP_QUICK_ASK), sub: t("结构输出"), icon: "图" },
  ];

  $: quickAsks = readCtx ? QUICK_ASKS : GENERAL_QUICK_ASKS;
  // 没有正文（通用对话 / 查看历史）时笔记落点无意义；停留在笔记页会看到空壳
  $: if (!readCtx && tab === "notes") tab = "chat";

  function quickAsk(item: { text: string; label: string }): void {
    if (item.label === t("解释这段") && !pendingQuote) {
      notice = t("请先在正文里划词，再点「问 AI」把选段带进来");
      return;
    }
    composer?.setText?.(item.text);
  }
</script>

<svelte:window on:click={onWindowClick} on:keydown={onHistoryKey} on:resize={measureHistory} />

<aside
  class="ai-panel"
  bind:this={panelEl}
  use:copyAsMarkdown
  class:paper={prefs.aiSkin === "paper"}
  class:is-overlay={overlay}
  style={`--re-ai-font-size:${fontSizes.message}px;--re-ai-input-font-size:${fontSizes.input}px`}
  aria-label={t("阅读助手")}
>
  {#if resizable}
    <div
      class="ai-resizer"
      class:is-dragging={dragging}
      role="separator"
      aria-orientation="vertical"
      aria-label={t("拖动调整宽度")}
      aria-valuemin={MIN_PANEL_WIDTH}
      aria-valuemax={MAX_PANEL_WIDTH}
      aria-valuenow={Math.round(width)}
      tabindex="0"
      title={t("拖动调整宽度（双击复位）")}
      on:pointerdown={onResizeDown}
      on:pointermove={onResizeMove}
      on:pointerup={onResizeUp}
      on:pointercancel={onResizeUp}
      on:dblclick={resetWidth}
      on:keydown={onResizeKey}
    ><span class="ai-resizer-grip" aria-hidden="true"></span></div>
  {/if}

  <header class="ai-hd" bind:this={headerEl}>
    <div class="ai-cover" aria-hidden="true">{coverChar}</div>
    <div class="ai-hd-main">
      <div class="ai-hd-title" title={title || t("阅读助手")}>{title || t("阅读助手")}</div>
      <div class="ai-hd-sub" title={`${title}${subline ? " · " + subline : ""}`}>
        {#if subline}<span>{subline}</span><span class="ai-hd-dot">·</span>{/if}
        <span>{assistantLabel}</span>
      </div>
    </div>
    {#if hasBook && !readCtx && onExitView}
      <button
        class="ai-view-back"
        title={t("回到通用对话")}
        on:click={() => onExitView?.()}
      >{t("返回")}</button>
    {/if}
    <div class="ai-hd-actions">
      <button
        bind:this={historyBtnEl}
        class="ai-icon-btn ai-history-btn"
        class:on={showHistory}
        title={t("历史会话")}
        aria-label={t("历史会话")}
        aria-haspopup="dialog"
        aria-expanded={showHistory}
        on:click={() => void toggleHistory()}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M3 3v5h5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M12 7v5l4 2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <button class="ai-icon-btn" title={t("新对话")} aria-label={t("新对话")} on:click={newChat}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 5.4v13.2M5.4 12h13.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
      </button>
      <button
        class="ai-icon-btn"
        class:on={settingsOpen}
        title={isAiReady(cred) ? t("设置") : t("尚未配置 AI 模型")}
        aria-label={t("设置")}
        on:click={openSettings}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M4 6h6.4M14.4 6H20M4 12h3.4M11.4 12H20M4 18h7.4M15.4 18H20" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
          <path d="M12.6 4v4M9.6 10v4M13.6 16v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
        {#if !isAiReady(cred)}<span class="ai-icon-dot" aria-hidden="true"></span>{/if}
      </button>
      {#if onOpenTab}
        <button
          class="ai-icon-btn"
          title={t("在新页签打开")}
          aria-label={t("在新页签打开")}
          on:click={() => onOpenTab?.()}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M18.5 13.5V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V6.5A1.5 1.5 0 0 1 5 5h5.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M14 4h6v6M19.7 4.3 12.6 11.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      {/if}
      {#if onClose}
        <button class="ai-icon-btn" title={t("收起面板")} aria-label={t("收起面板")} on:click={() => onClose?.()}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
          </svg>
        </button>
      {/if}
    </div>
  </header>

  {#if showHistory}
    <div
      class="ai-history"
      role="dialog"
      aria-label={t("历史会话")}
      tabindex="-1"
      bind:this={historyEl}
      style={`top:${historyTop}px;max-height:${historyMaxH}px`}
    >
      <div class="ai-history-hd">
        <div class="ai-history-tabs" role="tablist" aria-label={t("会话筛选")}>
          <button
            class="ai-history-tab"
            class:on={historyFilter === "all"}
            role="tab"
            aria-selected={historyFilter === "all"}
            on:click={() => setHistoryFilter("all")}
          >{t("全部")}</button>
          <button
            class="ai-history-tab"
            class:on={historyFilter === "pinned"}
            role="tab"
            aria-selected={historyFilter === "pinned"}
            on:click={() => setHistoryFilter("pinned")}
          >{t("置顶")}</button>
        </div>
        <div class="ai-history-tools">
          <button
            class="ai-history-tools-btn"
            title={t("清空全部")}
            aria-label={t("清空全部")}
            aria-haspopup="menu"
            aria-expanded={historyToolsOpen}
            on:click={() => (historyToolsOpen = !historyToolsOpen)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            </svg>
          </button>
          {#if historyToolsOpen}
            <div class="ai-history-tools-menu" role="menu">
              <button role="menuitem" class="danger" on:click={clearAllSessions}>{t("清空全部")}</button>
            </div>
          {/if}
        </div>
        <button class="ai-history-new" on:click={newChat}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
          <span>{t("新建会话")}</span>
        </button>
      </div>
      <label class="ai-history-search">
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="7" cy="7" r="4.2" stroke="currentColor" stroke-width="1.4" />
          <path d="M10.2 10.2L13.5 13.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
        <input
          type="text"
          spellcheck="false"
          aria-label={t("搜索会话标题或对话内容")}
          placeholder={t("搜索会话标题或对话内容")}
          value={historyQuery}
          on:input={(e) => {
            historyQuery = textOf(e);
            historyMenu = "";
          }}
        />
      </label>
      <div class="ai-history-list">
        {#each historyList() as s (s.id)}
          <div class="ai-history-item" class:on={s.id === sessionState.activeId}>
            {#if renamingId === s.id}
              <div class="ai-history-rename">
                <input
                  class="ai-history-rename-input"
                  bind:this={renameEl}
                  bind:value={renameText}
                  maxlength="60"
                  aria-label={t("会话标题")}
                  on:keydown={onRenameKey}
                />
                <button class="ai-history-rename-ok" aria-label={t("保存")} title={t("保存")} on:click={commitRename}>
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M3.4 8.3l3 3 6.2-6.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </button>
                <button class="ai-history-rename-cancel" aria-label={t("取消")} title={t("取消")} on:click={cancelRename}>×</button>
              </div>
            {:else}
              <button class="ai-history-main" on:click={() => switchSession(s.id)}>
                <span class="ai-history-item-title">
                  {#if s.pinned}<span class="ai-history-pinned" title={t("已置顶")} aria-label={t("已置顶")}>
                    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M9.3 2.6l4.1 4.1-1.6 1.6-.5-.5-2.5 2.5.2 2.9-1.1 1.1-3-3-2.4 2.4-.2-1.4 2.4-2.4-3-3 1.1-1.1 2.9.2 2.5-2.5-.5-.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
                    </svg>
                  </span>{/if}
                  <span class="ai-history-item-text">{sessionTitleOf(s)}</span>
                  {#if s.titleSource === "ai"}
                    <span class="ai-history-ai" title={t("AI 自动命名")} aria-label={t("AI 自动命名")}>✦ AI</span>
                  {/if}
                </span>
                <span class="ai-history-item-meta">
                  <span>{historyTimeLabel(s.updatedAt)}</span>
                  {#if s.messages.length}
                    <span class="ai-history-meta-dot" aria-hidden="true">·</span>
                    <span>{s.messages.length} {t("条消息")}</span>
                  {/if}
                </span>
              </button>
              <div class="ai-history-actions">
                <button
                  class="ai-history-more"
                  title={t("会话操作")}
                  aria-label={t("会话操作")}
                  aria-haspopup="menu"
                  aria-expanded={historyMenu === s.id}
                  on:click={() => (historyMenu = historyMenu === s.id ? "" : s.id)}
                >⋯</button>
                <button
                  class="ai-history-del"
                  title={t("删除会话")}
                  aria-label={t("删除会话")}
                  on:click={() => deleteSession(s.id)}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M3.5 4.5h9M6.5 4.5V3.4h3v1.1M5 4.5l.5 8h5l.5-8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </button>
              </div>
              {#if historyMenu === s.id}
                <div class="ai-history-menu" role="menu">
                  <button role="menuitem" on:click={() => startRename(s)}>{t("重命名")}</button>
                  <button role="menuitem" on:click={() => togglePin(s)}>
                    {s.pinned ? t("取消置顶") : t("置顶")}
                  </button>
                  <button
                    role="menuitem"
                    disabled={!s.messages.length}
                    on:click={() => exportSession(s, "md")}
                  >{t("导出 Markdown")}</button>
                  <button
                    role="menuitem"
                    disabled={!s.messages.length}
                    on:click={() => exportSession(s, "json")}
                  >{t("导出 JSON")}</button>
                  <button role="menuitem" class="danger" on:click={() => deleteSession(s.id)}>{t("删除会话")}</button>
                </div>
              {/if}
            {/if}
          </div>
        {/each}
        {#if !historyList().length}
          <div class="ai-history-empty">
            {historyQuery ? t("没有匹配的会话") : historyFilter === "pinned" ? t("还没有置顶会话") : t("还没有历史会话")}
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <div class="ai-tabs" role="tablist">
    <button
      class="ai-tab"
      class:on={tab === "chat"}
      role="tab"
      aria-selected={tab === "chat"}
      on:click={() => (tab = "chat")}
    >{t("对话")}</button>
    {#if readCtx}
      <button
        class="ai-tab"
        class:on={tab === "notes"}
        role="tab"
        aria-selected={tab === "notes"}
        on:click={() => (tab = "notes")}
      >
        {t("笔记")}
        {#if savedNotes.length}<span class="ai-tab-badge">{savedNotes.length}</span>{/if}
      </button>
    {/if}
  </div>

  {#if tab === "chat"}
    <div class="ai-thread" bind:this={threadEl} on:scroll={onThreadScroll}>
      {#if notice}
        <div class="ai-notice" role="status">
          <span>{notice}</span>
          <button class="ai-notice-x" on:click={() => (notice = "")} aria-label={t("关闭提示")}>×</button>
        </div>
      {/if}

      {#if !messages.length}
        <div class="ai-empty">
          <div class="ai-empty-title">
            {!hasBook ? t("有什么可以帮你？") : readCtx ? t("就这本书提问") : t("《{title}》的历史对话", { title })}
          </div>
          <div class="ai-empty-sub">
            {!hasBook
              ? t("可以问任何问题；打开一本书后会自动接上当前章节。")
              : readCtx
                ? t("回答只依据当前章节与你的选段；原文引用可点回正文。")
                : t("这里可以查看与继续之前的对话，但不会读取正文。需要引用原文时再打开这本书。")}
          </div>

          {#if !hasBook && recentBooks.length}
            <div class="ai-recent">
              <div class="ai-recent-head">
                <span>{t("最近聊过的书")}</span>
                <span class="ai-recent-hint">{t("点开即接上那本书的对话")}</span>
              </div>
              {#each recentBooks.slice(0, 6) as b (b.bookId)}
                <button
                  class="ai-recent-row"
                  title={b.title || b.bookId}
                  on:click={() => onOpenBook?.(b.bookId, b.title)}
                >
                  <span class="ai-recent-name">{b.title || b.bookId}</span>
                  <span class="ai-recent-meta">
                    {t("{n} 条对话", { n: b.sessions })}{#if b.updatedAt}<span class="ai-recent-dot">·</span>{historyTimeLabel(b.updatedAt)}{/if}
                  </span>
                </button>
              {/each}
            </div>
          {:else if hasBook && sessionState.sessions.length > 1}
            <div class="ai-recent">
              <div class="ai-recent-head">
                <span>{t("这本书的对话")}</span>
                <span class="ai-recent-hint">{t("点一条接着聊")}</span>
              </div>
              {#each historyList().slice(0, 6) as s (s.id)}
                <button
                  class="ai-recent-row"
                  class:is-on={s.id === sessionState.activeId}
                  title={sessionTitleOf(s)}
                  on:click={() => switchSession(s.id)}
                >
                  <span class="ai-recent-name">{sessionTitleOf(s)}</span>
                  <span class="ai-recent-meta">
                    {t("{n} 条消息", { n: s.messages.length })}{#if s.updatedAt}<span class="ai-recent-dot">·</span>{historyTimeLabel(s.updatedAt)}{/if}
                    {#if s.id === sessionState.activeId}<span class="ai-recent-now">{t("当前")}</span>{/if}
                  </span>
                </button>
              {/each}
            </div>
          {/if}

          <div class="ai-hints">
            {#each quickAsks as item (item.label)}
              <button class="ai-hint" on:click={() => quickAsk(item)}>
                <span class="ai-hint-ico" aria-hidden="true">{item.icon}</span>
                <span class="ai-hint-label">{item.label}</span>
                <span class="ai-hint-sub">{item.sub}</span>
              </button>
            {/each}
          </div>
        </div>
      {/if}

      {#each messages as m, idx (m.id)}
        {#if showDayBefore(idx)}
          <div class="ai-day" role="separator">{chatDayLabel(m.createdAt)}</div>
        {/if}
        {#if m.role === "user"}
          <div class="ai-msg user">
            {#if m.quote}
              <button class="ai-qchip" title={m.quote.text} on:click={() => locateQuote(m.quote)}>
                <span class="ai-qchip-ico" aria-hidden="true">❝</span>
                <span class="ai-qchip-text">{quoteChipLabel(m.quote)}</span>
              </button>
            {/if}
            {#if editingId === m.id}
              <div class="ai-edit">
                <textarea
                  class="ai-edit-input"
                  bind:this={editEl}
                  bind:value={editText}
                  on:keydown={onEditKeydown}
                  rows="3"
                  aria-label={t("编辑问题")}
                ></textarea>
                <div class="ai-edit-foot">
                  <span class="ai-edit-hint">
                    {sendShortcut === "mod+enter"
                      ? t("⌘/Ctrl + Enter 发送 · Esc 取消")
                      : t("Enter 发送 · Shift + Enter 换行 · Esc 取消")}
                  </span>
                  <button class="ai-link" on:click={cancelEdit}>{t("取消")}</button>
                  <button
                    class="ai-btn primary"
                    disabled={!editText.trim() || streaming}
                    on:click={() => resendEdited(m)}
                  >{t("重新发送")}</button>
                </div>
              </div>
            {:else}
              <div class="ai-bubble">{m.content}</div>
              <div class="ai-user-foot">
                <span class="ai-msg-time" title={new Date(m.createdAt).toLocaleString()}>{sessionClock(m.createdAt)}</span>
                <button class="ai-link" disabled={streaming} on:click={() => startEdit(m)}>{t("编辑")}</button>
              </div>
            {/if}
          </div>
        {:else}
          {@const segs = segmentsOf(m)}
          {@const receipt = contextReceipt(m.context)}
          <div class="ai-msg assistant">
            <div class="ai-role">
              <span class="ai-spark small" aria-hidden="true">✦</span>
              <span>{assistantLabel}</span>
              {#if streaming && m.id === streamMsgId && !shownContent(m)}
                <span class="ai-typing">{toolsOf(m).length ? t("正在翻阅原文…") : t("正在思考…")}</span>
              {/if}
            </div>

            {#if shownReasoning(m)}
              <details class="ai-reason" open={prefs.showReasoning}>
                <summary>{t("思考过程")}</summary>
                <div class="ai-reason-body">{shownReasoning(m)}</div>
              </details>
            {/if}

            {#if toolsOf(m).length}
              <div class="ai-tools">
                {#each toolsOf(m) as tool, ti (ti)}
                  <div class="ai-tool" class:err={!tool.ok} title={tool.error || ""}>
                    <span class="ai-tool-dot" aria-hidden="true"></span>
                    <span class="ai-tool-label">{tool.label}</span>
                    <span class="ai-tool-meta">{tool.ok ? t("完成") : t("失败")}</span>
                  </div>
                {/each}
              </div>
            {/if}

            {#if segs.length}
              {#each segs as seg, si (si)}
                {#if seg.kind === "mindmap"}
                  <AiMindmap root={seg.root} onOpenBlock={openBlockById} />
                {:else if seg.html}
                  <div
                    class="ai-md"
                    class:is-error={m.error}
                    use:codeCopy
                    use:renderPost
                    on:click={onMdClick}
                    on:mouseover={onRefOver}
                    on:mouseout={onRefOut}
                  >
                    {@html seg.html}
                  </div>
                {/if}
              {/each}
            {/if}

            {#if m.error && (!streaming || m.id !== streamMsgId)}
              {@const err = errorInfoOf(m)}
              <div class="ai-error-card" role="alert">
                <div class="ai-error-row">
                  <span class="ai-error-ico" aria-hidden="true">!</span>
                  <span class="ai-error-main">
                    <strong>{err.title}</strong>
                    <span class="ai-error-hint">{err.hint}</span>
                  </span>
                  <span class="ai-error-actions">
                    <button class="ai-btn primary" disabled={streaming} on:click={() => retryMessage(m)}>
                      {t("重试")}
                    </button>
                    <button class="ai-btn" disabled={streaming} on:click={() => copyError(m)}>
                      {copiedErrorId === m.id ? t("已复制") : t("复制错误")}
                    </button>
                  </span>
                </div>
                <details class="ai-error-detail">
                  <summary>{t("查看错误详情")}</summary>
                  <pre>{maskedError(m)}</pre>
                </details>
              </div>
            {/if}

            {#if !streaming || m.id !== streamMsgId}
              <div class="ai-foot">
                {#if receipt}
                  <span class="ai-receipt" title={t("本轮随提问附带的章节上下文")}>{receipt}</span>
                {/if}
                {#if prefs.showUsage && m.usage}
                  <span class="ai-usage" title={t("本轮 token 用量")}>{formatUsage(m.usage)}</span>
                {/if}
                <span class="ai-msg-time" title={new Date(m.createdAt).toLocaleString()}>{sessionClock(m.createdAt)}</span>
                {#if m.aborted}<span class="ai-flag">{t("已停止")}</span>{/if}
                {#if m.error}<span class="ai-flag err">{t("失败")}</span>{/if}
                <span class="ai-foot-spacer"></span>
                {#if m.aborted}
                  <button
                    class="ai-link on"
                    disabled={streaming}
                    title={t("沿用同一提问，接着上次的回答继续")}
                    on:click={() => continueMessage(m)}
                  >{t("继续")}</button>
                {/if}
                {#if onLocate && quoteOfAssistant(idx)}
                  <button class="ai-link" on:click={() => locateQuote(quoteOfAssistant(idx))}>{t("定位原文")}</button>
                {/if}
                {#if m.content}
                  <button class="ai-link" on:click={() => copyMessage(m)}>
                    {copiedId === m.id ? t("已复制") : t("复制")}
                  </button>
                {/if}
                {#if m.content || m.error || m.aborted}
                  <button
                    class="ai-link"
                    disabled={streaming || !!notePlanBusyId}
                    title={t("按同一提问与上下文重新回答")}
                    on:click={() => regenerate(m)}
                  >{t("重新生成")}</button>
                {/if}
                {#if outlineOf(m)}
                  <button
                    class="ai-link"
                    class:on={mindmapView?.messageId === m.id}
                    title={t("用本轮回答的大纲生成思维导图")}
                    on:click={() => toggleMindmap(m)}
                  >{t("导图")}</button>
                {/if}
                {#if m.content && !m.error}
                  {#if m.note}
                    <span class="ai-note-badge" title={`${m.note.docTitle || m.note.docId} · ${m.note.title}`}>
                      {t("已存为笔记")}
                    </span>
                  {:else}
                    <button class="ai-link" disabled={!!notePlanBusyId} on:click={() => proposeNote(m)}>
                      {notePlanBusyId === m.id ? t("整理中…") : t("存为笔记")}
                    </button>
                  {/if}
                {/if}
              </div>
            {/if}
          </div>
        {/if}
      {/each}
      <div class="ai-thread-tail"></div>
    </div>

    {#if mindmapView}
      <div class="ai-note-card ai-map-card" role="dialog" aria-label={t("思维导图")}>
        <div class="ai-note-hd">
          <span class="ai-note-hd-title">{t("思维导图")}</span>
          <span class="ai-note-hd-target">{t("由本轮回答的大纲生成")}</span>
          <button class="ai-note-x" aria-label={t("关闭预览")} on:click={() => (mindmapView = null)}>×</button>
        </div>
        <AiMindmap root={mindmapView.root} onOpenBlock={openBlockById} />
      </div>
    {/if}

    {#if notePlan}
      <div class="ai-note-card" role="dialog" aria-label={t("笔记预览")}>
        <div class="ai-note-hd">
          <span class="ai-note-hd-title">{t("笔记预览")}</span>
          <span class="ai-note-hd-target">
            {#if notePlan.target.ok}
              {#if notePlan.target.willCreate}
                {t("将新建《{doc}》并写入", { doc: notePlan.target.docTitle || bookTitle })}
              {:else}
                {t("将追加到《{doc}》末尾", { doc: notePlan.target.docTitle || notePlan.target.docId })}
              {/if}
            {:else}
              <span class="err">{notePlan.target.error}</span>
            {/if}
          </span>
          <button class="ai-note-x" aria-label={t("关闭预览")} on:click={() => (notePlan = null)}>×</button>
        </div>
        <div class="ai-note-plan-title">{notePlan.plan.title}</div>
        <div class="ai-md ai-note-preview" use:renderPost>{@html renderAssistantMarkdown(notePlan.plan.markdown)}</div>
        {#if notePlanError}<div class="ai-field-hint err">{notePlanError}</div>{/if}
        <div class="ai-note-foot">
          <span class="ai-field-hint">{t("只追加内容，不会覆盖文档已有内容。")}</span>
          <span class="ai-bar-spacer"></span>
          <button class="ai-btn" disabled={noteWriteBusy} on:click={() => (notePlan = null)}>{t("放弃")}</button>
          <button
            class="ai-btn primary"
            disabled={!notePlan.target.ok || noteWriteBusy}
            on:click={commitNote}
          >
            {noteWriteBusy ? t("写入中…") : t("写入思源")}
          </button>
        </div>
      </div>
    {/if}

    <div class="ai-composer">
      {#if !stickBottom}
        <div class="ai-jump-wrap">
          <button class="ai-jump" on:click={() => autoScroll(true)} title={t("跳到最新消息")}>
            {t("回到底部")}
            <span aria-hidden="true">↓</span>
          </button>
        </div>
      {/if}
      {#if pendingQuote}
        <div class="ai-pending">
          <button class="ai-pending-main" title={pendingQuote.text} on:click={() => locateQuote(pendingQuote)}>
            <span class="ai-pending-ico" aria-hidden="true">❝</span>
            <span class="ai-pending-text">{quoteChipLabel(pendingQuote)}</span>
          </button>
          <button class="ai-pending-x" title={t("移除引用")} aria-label={t("移除引用")} on:click={() => (pendingQuote = null)}>×</button>
        </div>
      {/if}

      {#if readCtx}
      <div class="ai-ctx-wrap">
        {#if showToc}
          <div class="ai-toc-pop" role="dialog" aria-label={t("选择章节范围")}>
            <div class="ai-toc-hd">
              <span class="ai-toc-hd-title">{t("选择章节范围")}</span>
              <span class="ai-toc-now">{readRange ? scopeSummary() : t("未选")}</span>
            </div>
            <div class="ai-toc-tip">
              {readRange ? t("再点一章可扩展或重选；点「完成」应用") : t("先点起点，再点终点即可选一段")}
            </div>
            {#if tocBusy}
              <div class="ai-toc-empty">{t("正在读取目录…")}</div>
            {:else if tocError}
              <div class="ai-toc-empty">{tocError}</div>
            {:else if !getToc}
              <div class="ai-toc-empty">{t("当前阅读器不支持目录")}</div>
            {:else if !tocItems.length}
              <div class="ai-toc-empty">{t("这本书没有可用目录")}</div>
            {:else}
              <div class="ai-toc-list">
                {#each tocItems as item (item.section)}
                  {@const picked = isSectionInRange(readRange, item.section)}
                  {@const isEnd = !!readRange && (readRange.from === item.section || readRange.to === item.section)}
                  {@const beyondProgress = tocCurrent >= 0 && item.section > tocCurrent}
                  <button
                    class="ai-toc-item"
                    class:on={picked}
                    class:end={isEnd}
                    style={`padding-left:${8 + Math.min(3, Math.max(0, item.level - 1)) * 12}px`}
                    on:click={() => pickTocSection(item.section)}
                  >
                    <span class="ai-toc-no">{item.section + 1}</span>
                    <span class="ai-toc-title">{item.title}</span>
                    {#if beyondProgress}
                      <span class="ai-toc-badge" title={t("在当前阅读进度之后，可能含剧透")}>{t("未读")}</span>
                    {/if}
                  </button>
                {/each}
              </div>
              {#if readRange && rangeSpan(readRange) > MAX_RANGE_CHAPTERS}
                <div class="ai-toc-warn">{t("一次最多自动读 {n} 章，其余由助手按需续读", { n: MAX_RANGE_CHAPTERS })}</div>
              {/if}
              {#if readRange && tocCurrent >= 0 && readRange.to > tocCurrent}
                <div class="ai-toc-warn">{t("范围超出当前进度，助手会读到后面的剧情（剧透）")}</div>
              {/if}
            {/if}
            <div class="ai-toc-ft">
              <button class="ai-toc-btn" disabled={!readRange} on:click={clearReadRange}>{t("清除")}</button>
              <span class="ai-toc-ft-gap"></span>
              <button class="ai-toc-btn is-primary" on:click={() => (showToc = false)}>{t("完成")}</button>
            </div>
          </div>
        {/if}
        <div class="ai-ctx-row" role="group" aria-label={hasBook ? t("阅读上下文") : t("附加资料")}>
          {#if readCtx}
            <button
              class="ai-ctx-chip"
              class:on={!readRange && contextScope === "page"}
              aria-pressed={!readRange && contextScope === "page"}
              title={t("只发送当前可见页，省 token、更聚焦")}
              on:click={() => setContextScope("page")}
            >{t("本页")}</button>
            <button
              class="ai-ctx-chip"
              class:on={!readRange && contextScope === "chapter"}
              aria-pressed={!readRange && contextScope === "chapter"}
              title={t("发送当前整章正文")}
              on:click={() => setContextScope("chapter")}
            >{t("本章")}</button>
            {#if getToc}
              <button
                class="ai-ctx-chip"
                class:on={!!readRange}
                aria-pressed={!!readRange}
                aria-expanded={showToc}
                title={readRange
                  ? t("本轮读取 {range}，点击调整", { range: scopeSummary() })
                  : t("从目录选择一段章节，让助手先读再答")}
                on:click={toggleToc}
              >{t("目录")}</button>
            {/if}
          {/if}
          <button
            class="ai-ctx-chip ai-ctx-note"
            class:on={!!knowledge && knowledgeOn}
            class:empty={!knowledge}
            aria-pressed={!!knowledge && knowledgeOn}
            title={!knowledge
              ? t("选择一篇思源笔记作为背景资料")
              : knowledgeOn
                ? t("本轮附带知识区《{title}》，点击关闭", { title: knowledge.docTitle || knowledge.docId })
                : t("知识区已关闭，点击重新附带")}
            on:click={onKnowledgeChip}
          >
            <span class="ai-ctx-at" aria-hidden="true">@</span>
            <span class="ai-ctx-note-title">{knowledge?.docTitle || t("笔记")}</span>
            {#if knowledge}<span class="ai-ctx-dot" class:on={knowledgeOn} aria-hidden="true"></span>{/if}
          </button>
        </div>
      </div>
      {/if}

      <AiComposer
        bind:this={composer}
        bind:hasText={composerHasText}
        {sendShortcut}
        placeholder={!isAiReady(cred)
          ? t("请先在设置里配置 AI 模型")
          : readCtx
            ? t("就这本书提问…")
            : hasBook
              ? t("接着这本书的历史聊…")
              : t("输入问题…")}
        onSubmit={send}
      />

      <div class="ai-composer-bar">
        {#if modelMenu}
          <div class="ai-model-pop" role="menu" aria-label={t("切换模型")}>
            <div class="ai-model-pop-hd">{t("切换模型")}</div>
            {#each modelOptions() as name (name)}
              <button
                class="ai-model-opt"
                class:on={name === cred.model}
                role="menuitemradio"
                aria-checked={name === cred.model}
                title={name}
                on:click={() => pickModel(name)}
              >
                <span class="ai-model-check" aria-hidden="true">{name === cred.model ? "✓" : ""}</span>
                <span class="ai-model-opt-name">{name}</span>
              </button>
            {/each}
            <button class="ai-model-more" on:click={() => { modelMenu = false; openSettings(); }}>
              {t("模型设置…")}
            </button>
          </div>
        {/if}
        <button
          class="ai-model-pill"
          class:open={modelMenu}
          on:click={onModelPill}
          title={isAiReady(cred) ? t("切换模型") : t("模型与上下文设置")}
        >
          <span class="ai-model-dot" class:ok={isAiReady(cred)}></span>
          <span class="ai-model-name">{cred.model || t("未配置模型")}</span>
          <span class="ai-caret" aria-hidden="true">›</span>
        </button>
        {#if readCtx}
          <span class="ai-ctx-hint" title={t("每次提问附带所选范围正文，超出上限自动截断")}>
            {scopeSummary()} · {prefs.contextChars.toLocaleString()}{t(" 字")}{#if knowledge && knowledgeOn} · {t("知识区")}{/if}
          </span>
        {:else if hasBook}
          <span class="ai-ctx-hint" title={t("查看历史模式不读取正文，回答只依据对话本身")}>{t("未接入正文")}{#if knowledge && knowledgeOn} · {t("知识区")}{/if}</span>
        {:else if knowledge && knowledgeOn}
          <span class="ai-ctx-hint">{t("知识区")}</span>
        {/if}
        <span class="ai-bar-spacer"></span>
        {#if streaming}
          <button class="ai-stop" on:click={stop}>{t("停止")}</button>
        {/if}
        <button
          class="ai-send"
          disabled={!composerHasText || streaming}
          title={t("发送")}
          aria-label={t("发送")}
          on:click={send}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 13V3M8 3L3.5 7.5M8 3l4.5 4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  {:else}
    <div class="ai-settings ai-notes">
      {#if !savedNotes.length}
        <div class="ai-notes-empty">
          <div class="ai-empty-title">{t("还没有存过笔记")}</div>
          <div class="ai-empty-sub">{t("回答下方的「存为笔记」写入思源后，会出现在这里。")}</div>
        </div>
      {:else}
        {#each savedNotes as n (n.messageId)}
          <button class="ai-note-item" on:click={() => openNote(n.note)}>
            <span class="ai-note-item-main">
              <span class="ai-note-item-title">{n.note.title || t("笔记")}</span>
              <span class="ai-note-item-sub">
                {n.sessionTitle || t("新对话")} · {n.note.docTitle || n.note.docId || ""}
              </span>
            </span>
            <span class="ai-note-item-date">{noteDate(n.note.at || 0)}</span>
          </button>
        {/each}
      {/if}
    </div>
  {/if}

  {#if preview}
    {@const p = preview}
    <div
      class="ai-block-preview"
      bind:this={previewEl}
      style={previewStyle}
      role="dialog"
      aria-label={t("块预览")}
      on:mouseenter={cancelPreviewHide}
      on:mouseleave={schedulePreviewHide}
    >
      <div class="ai-bp-hd">
        <span class="ai-bp-title">{t("块预览")}</span>
        <span class="ai-bp-id">{p.id.slice(-7)}</span>
        <span class="ai-bar-spacer"></span>
        <button class="ai-bp-x" aria-label={t("关闭")} on:click={hidePreview}>×</button>
      </div>
      {#if p.error}
        <div class="ai-bp-err">{p.error}</div>
      {:else}
        <div class="ai-md ai-bp-body" use:renderPost on:click={onMdClick}>{@html p.html}</div>
      {/if}
      <div class="ai-bp-foot">
        <button class="ai-link" on:click={() => { void openBlockById(p.id); hidePreview(); }}>{t("打开块")}</button>
      </div>
    </div>
  {/if}

  {#if showKnowledgePicker}
    <DocTreePickerPage
      standalone
      title={t("选择知识区文档")}
      mode="default"
      activeId={knowledge?.docId || ""}
      onPick={onKnowledgePicked}
      onClose={() => (showKnowledgePicker = false)}
    />
  {/if}

  {#if settingsOpen}
    <AiSettingsDialog
      getSettings={getAiSettings}
      {prefs}
      general={!readCtx}
      {knowledge}
      saveSettings={saveAiSettings}
      savePrefs={applyPrefsFromDialog}
      onClose={() => (settingsOpen = false)}
      onPickKnowledge={() => (showKnowledgePicker = true)}
      onClearKnowledge={clearKnowledge}
    />
  {/if}
</aside>

<style>
  .ai-panel {
    position: relative;
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-height: 0;
    background: var(--b3-theme-background, #fff);
    color: var(--b3-theme-on-background, #1f2329);
    border-left: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.1));
    box-sizing: border-box;
    font-size: var(--re-ai-font-size, 14px);
    /* 思源给 .layout-tab-container 设了 user-select:none（正文在 iframe 里所以阅读区不受影响），
       自定义页签里的面板会继承成不可选 ⇒ 回答无法划选复制。面板根显式放开，停靠态一并受益。 */
    -webkit-user-select: text;
    user-select: text;
  }

  /* ---------- 拖动改宽（14px 命中区 + 可见抓握条） ---------- */
  .ai-resizer {
    position: absolute;
    top: 0;
    bottom: 0;
    left: -7px;
    width: 14px;
    z-index: 20;
    cursor: col-resize;
    touch-action: none;
    outline: none;
  }
  .ai-resizer::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 6px;
    width: 2px;
    background: transparent;
    transition: background 0.15s ease;
  }
  .ai-resizer-grip {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 4px;
    height: 34px;
    transform: translate(-50%, -50%);
    border-radius: 99px;
    background: var(--b3-border-color, rgba(0, 0, 0, 0.18));
    opacity: 0.7;
    transition: background 0.15s ease, opacity 0.15s ease, height 0.15s ease;
  }
  .ai-resizer:hover .ai-resizer-grip,
  .ai-resizer.is-dragging .ai-resizer-grip,
  .ai-resizer:focus-visible .ai-resizer-grip {
    height: 52px;
    opacity: 1;
    background: var(--b3-theme-primary, #378add);
  }
  .ai-resizer:hover::after,
  .ai-resizer.is-dragging::after,
  .ai-resizer:focus-visible::after {
    background: var(--b3-theme-primary, #378add);
    opacity: 0.28;
  }

  /* ---------- 头部 ---------- */
  .ai-hd {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px 8px;
    flex: none;
  }
  .ai-hd-main {
    min-width: 0;
    flex: 1;
  }
  .ai-hd-title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 14px;
    font-weight: 600;
    line-height: 1.3;
  }
  .ai-spark {
    color: var(--b3-theme-primary, #378add);
    font-size: 13px;
  }
  .ai-spark.small {
    font-size: 11px;
  }
  .ai-hd-sub {
    margin-top: 2px;
    font-size: 11.5px;
    color: var(--b3-theme-on-surface, #6b7280);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ai-hd-dot {
    margin: 0 4px;
    opacity: 0.5;
  }
  .ai-hd-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: none;
  }
  /* 查看历史形态的「返回」：回到通用对话，退出无正文绑定 */
  .ai-view-back {
    flex: none;
    height: 24px;
    padding: 0 9px;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.12));
    border-radius: 6px;
    background: transparent;
    color: var(--b3-theme-on-surface, #6b7280);
    font-size: 11.5px;
    cursor: pointer;
  }
  .ai-view-back:hover {
    background: var(--b3-list-hover, rgba(0, 0, 0, 0.05));
    color: var(--b3-theme-on-background, #1f2329);
  }
  .ai-icon-btn {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--b3-theme-on-surface, #6b7280);
    cursor: pointer;
    padding: 0;
  }
  .ai-icon-btn.on {
    background: var(--re-ai-accent-soft);
    color: var(--re-ai-accent);
  }
  .ai-icon-dot {
    position: absolute;
    top: 3px;
    right: 3px;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--b3-theme-error, #d23f31);
  }
  .ai-icon-btn:hover {
    background: var(--b3-list-hover, rgba(0, 0, 0, 0.05));
    color: var(--b3-theme-on-background, #1f2329);
  }
  /* 24 网格细描边 + 轻微透明度，避免小尺寸下显得厚重 */
  .ai-icon-btn svg {
    opacity: 0.82;
  }
  .ai-icon-btn:hover svg,
  .ai-icon-btn.on svg {
    opacity: 1;
  }
  /* 思源主题给 svg 设了 fill: currentColor，优先级高于 presentation attribute
     fill="none"，线性图标会被填成实心块；面板内统一兜底。 */
  .ai-panel :global(svg[fill="none"]),
  .ai-panel :global(svg[fill="none"] path),
  .ai-panel :global(svg[fill="none"] circle),
  .ai-panel :global(svg[fill="none"] rect),
  .ai-panel :global(svg[fill="none"] line),
  .ai-panel :global(svg[fill="none"] polyline),
  .ai-panel :global(svg[fill="none"] polygon) {
    fill: none;
  }

  /* ---------- Tab ---------- */
  .ai-tabs {
    display: flex;
    gap: 2px;
    padding: 0 12px;
    flex: none;
    border-bottom: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.08));
  }
  .ai-tab {
    position: relative;
    border: none;
    background: none;
    padding: 7px 6px 8px;
    margin-right: 8px;
    font-size: 12.5px;
    color: var(--b3-theme-on-surface, #6b7280);
    cursor: pointer;
  }
  .ai-tab:hover {
    color: var(--b3-theme-on-background, #1f2329);
  }
  .ai-tab.on {
    color: var(--b3-theme-on-background, #1f2329);
    font-weight: 600;
  }
  .ai-tab.on::after {
    content: "";
    position: absolute;
    left: 2px;
    right: 2px;
    bottom: -1px;
    height: 2px;
    border-radius: 1px;
    background: var(--b3-theme-primary, #378add);
  }

  /* ---------- 消息流 ---------- */
  .ai-thread {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 12px 12px 4px;
    overscroll-behavior: contain;
  }
  .ai-thread-tail {
    height: 4px;
  }

  .ai-notice {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    margin-bottom: 10px;
    padding: 7px 9px;
    border-radius: 8px;
    background: var(--b3-card-warning-background, rgba(255, 193, 7, 0.12));
    color: var(--b3-theme-on-background, #1f2329);
    font-size: 12px;
    line-height: 1.5;
  }
  .ai-notice span {
    flex: 1;
    min-width: 0;
  }
  .ai-notice-x {
    flex: none;
    border: none;
    background: none;
    color: inherit;
    opacity: 0.6;
    cursor: pointer;
    padding: 0 2px;
    font-size: 14px;
    line-height: 1;
  }

  .ai-empty {
    padding: 18px 4px 8px;
  }
  .ai-empty-title {
    font-size: 14px;
    font-weight: 600;
  }
  .ai-empty-sub {
    margin-top: 5px;
    font-size: 12px;
    line-height: 1.6;
    color: var(--b3-theme-on-surface, #6b7280);
  }
  /* 通用对话空态 · 最近聊过的书（2026-11-08）
     右栏没绑书时落到 unknown 空间，这里给出「历史去哪了」的入口 */
  .ai-recent {
    width: 100%;
    margin-top: 14px;
    padding: 8px 4px 0;
    border-top: 1px dashed var(--b3-border-color, rgba(0, 0, 0, 0.1));
    text-align: left;
  }
  .ai-recent-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    padding: 0 4px 6px;
    font-size: 11.5px;
    font-weight: 600;
    color: var(--b3-theme-on-surface, #6b7280);
  }
  .ai-recent-hint {
    font-weight: 400;
    font-size: 10.5px;
    opacity: 0.72;
  }
  .ai-recent-row {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    width: 100%;
    padding: 7px 9px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--b3-theme-on-background, #1f2329);
    text-align: left;
    cursor: pointer;
  }
  .ai-recent-row:hover {
    background: var(--b3-list-hover, rgba(0, 0, 0, 0.05));
  }
  .ai-recent-name {
    max-width: 100%;
    overflow: hidden;
    font-size: 12.5px;
    line-height: 1.45;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ai-recent-meta {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 10.5px;
    color: var(--b3-theme-on-surface, #6b7280);
  }
  .ai-recent-dot {
    opacity: 0.6;
  }
  /* 当前会话：整行轻底色 + 尾部「当前」标记，避免和普通行混淆 */
  .ai-recent-row.is-on {
    background: var(--b3-theme-primary-lightest, rgba(55, 138, 221, 0.08));
  }
  .ai-recent-now {
    padding: 0 4px;
    border-radius: 3px;
    background: var(--b3-theme-primary, #378add);
    color: #fff;
    font-size: 9.5px;
    line-height: 1.6;
  }
  .ai-hints {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 14px;
  }
  .ai-hint {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 9px 11px;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.1));
    border-radius: 9px;
    background: var(--b3-theme-surface, rgba(0, 0, 0, 0.02));
    color: var(--b3-theme-on-background, #1f2329);
    font-size: 12.5px;
    text-align: left;
    cursor: pointer;
  }
  .ai-hint:hover {
    border-color: var(--b3-theme-primary, #378add);
  }
  .ai-hint-label {
    flex: none;
    font-weight: 600;
  }
  .ai-hint-sub {
    margin-left: auto;
    flex: none;
    font-size: 11px;
    color: var(--b3-theme-on-surface-light, #9aa0a6);
  }

  .ai-msg {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 16px;
    min-width: 0;
  }
  .ai-msg.user {
    align-items: flex-end;
  }
  .ai-bubble {
    max-width: 92%;
    padding: 8px 11px;
    border-radius: 11px;
    background: var(--b3-theme-surface, #f2f3f5);
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.65;
  }
  /* P1：用户消息的操作行只在悬停/聚焦时出现，避免常驻占位 */
  .ai-user-foot {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-right: 2px;
    font-size: 11px;
    color: var(--b3-theme-on-surface-light, #9aa0a6);
    opacity: 0;
    transition: opacity 0.15s;
  }
  .ai-msg.user:hover .ai-user-foot,
  .ai-msg.user:focus-within .ai-user-foot {
    opacity: 1;
  }
  @media (hover: none) {
    .ai-user-foot {
      opacity: 1;
    }
  }
  /* P1：编辑重发 */
  .ai-edit {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
    padding: 8px 9px;
    border: 1px solid var(--b3-theme-primary, #378add);
    border-radius: 11px;
    background: var(--b3-theme-surface, #f2f3f5);
  }
  .ai-edit-input {
    width: 100%;
    min-height: 64px;
    max-height: 220px;
    padding: 0;
    border: none;
    outline: none;
    background: transparent;
    color: inherit;
    font: inherit;
    line-height: 1.65;
    resize: vertical;
  }
  .ai-edit-foot {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .ai-edit-hint {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 10.5px;
    color: var(--b3-theme-on-surface-light, #9aa0a6);
  }
  .ai-qchip,
  .ai-pending-main {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    max-width: 92%;
    padding: 5px 9px;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.1));
    border-radius: 8px;
    background: transparent;
    color: var(--b3-theme-on-surface, #6b7280);
    font-size: 11.5px;
    line-height: 1.45;
    text-align: left;
    cursor: pointer;
    min-width: 0;
  }
  .ai-qchip:hover,
  .ai-pending-main:hover {
    border-color: var(--b3-theme-primary, #378add);
    color: var(--b3-theme-on-background, #1f2329);
  }
  .ai-qchip-ico,
  .ai-pending-ico {
    flex: none;
    color: var(--b3-theme-primary, #378add);
    font-size: 11px;
    line-height: 1.5;
  }
  .ai-qchip-text,
  .ai-pending-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ai-msg.assistant {
    align-items: stretch;
  }
  .ai-role {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 11.5px;
    font-weight: 600;
    color: var(--b3-theme-on-surface, #6b7280);
  }
  .ai-typing {
    margin-left: 4px;
    font-weight: 400;
    color: var(--b3-theme-on-surface-light, #9aa0a6);
  }
  .ai-typing::after {
    content: "…";
    animation: ai-blink 1.2s steps(3, end) infinite;
  }
  @keyframes ai-blink {
    0% { opacity: 0.2; }
    50% { opacity: 1; }
    100% { opacity: 0.2; }
  }

  .ai-reason {
    border-left: 2px solid var(--b3-border-color, rgba(0, 0, 0, 0.12));
    padding-left: 8px;
    font-size: 12px;
    color: var(--b3-theme-on-surface, #6b7280);
  }
  .ai-reason summary {
    cursor: pointer;
    font-size: 11.5px;
    user-select: none;
    opacity: 0.85;
  }
  .ai-reason-body {
    margin-top: 4px;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.6;
    max-height: 240px;
    overflow-y: auto;
  }

  .ai-tools {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }
  .ai-tool {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
    color: var(--b3-theme-on-surface-light, #9aa0a6);
  }
  .ai-tool-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ai-md {
    min-width: 0;
    line-height: 1.68;
    word-break: break-word;
    overflow-wrap: anywhere;
  }
  /* S0：与思源正文同排版基线。选择器两级类压过 base.css 的 .b3-typography{font-size:16px}，
     消息字号设置才能生效；标题/代码/表格在基线里都是 em，随容器缩放。 */
  .ai-md :global(.b3-typography) {
    font-size: var(--re-ai-font-size, 14px);
  }
  .ai-md.is-error {
    color: var(--b3-theme-error, #d23f31);
  }
  .ai-md :global(p) {
    margin: 0 0 8px;
  }
  .ai-md :global(p:last-child) {
    margin-bottom: 0;
  }
  .ai-md :global(h1),
  .ai-md :global(h2),
  .ai-md :global(h3),
  .ai-md :global(h4) {
    margin: 12px 0 6px;
    /* 字号不写死：走 b3-typography 的 1.75/1.55/1.38/1.25em，随消息字号缩放 */
    font-weight: 600;
    line-height: 1.4;
  }
  .ai-md :global(ul),
  .ai-md :global(ol) {
    margin: 4px 0 8px;
    padding-left: 20px;
  }
  .ai-md :global(li) {
    margin: 2px 0;
  }
  .ai-md :global(blockquote) {
    margin: 8px 0;
    padding: 2px 0 2px 10px;
    border-left: 3px solid var(--b3-border-color, rgba(0, 0, 0, 0.16));
    color: var(--b3-theme-on-surface, #6b7280);
  }
  .ai-md :global(table) {
    border-collapse: collapse;
    margin: 8px 0;
    display: block;
    overflow-x: auto;
  }
  .ai-md :global(th),
  .ai-md :global(td) {
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.12));
    padding: 4px 8px;
    text-align: left;
  }
  /* 行内 code 的字号/底色/内边距交给 b3-typography 基线（85% + 思源代码底色），
     这里不再写死 px，保证随消息字号缩放且与文档观感一致 */
  .ai-md :global(pre) {
    position: relative;
    margin: 8px 0;
    padding: 9px 11px;
    border-radius: 8px;
    background: var(--b3-theme-surface, rgba(0, 0, 0, 0.04));
    overflow-x: auto;
    font-size: 0.85em;
    /* code 带上 .hljs 后不再命中基线的 code:not(.hljs)（那条里有等宽字体），这里补回 */
    font-family: var(--b3-font-family-code, monospace);
  }
  /* P1：代码块复制按钮由 JS 注入，不能进 Lute 输出 */
  .ai-md :global(.ai-code-copy) {
    position: absolute;
    top: 6px;
    right: 6px;
    padding: 2px 7px;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.12));
    border-radius: 5px;
    background: var(--b3-theme-background, #fff);
    color: var(--b3-theme-on-surface, #6b7280);
    font-size: 10.5px;
    line-height: 1.5;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.15s;
  }
  .ai-md :global(pre:hover .ai-code-copy),
  .ai-md :global(.ai-code-copy:focus-visible) {
    opacity: 1;
  }
  @media (hover: none) {
    .ai-md :global(.ai-code-copy) {
      opacity: 1;
    }
  }
  /* S0：语言标签（JS 注入）左上角悬停显隐，不占代码版面；移动端常显 */
  .ai-md :global(.ai-code-lang) {
    position: absolute;
    top: 6px;
    left: 10px;
    font-size: 10.5px;
    line-height: 1.5;
    color: var(--b3-theme-on-surface-light, #9aa0a6);
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.15s;
  }
  .ai-md :global(pre:hover .ai-code-lang) {
    opacity: 1;
  }
  @media (hover: none) {
    .ai-md :global(.ai-code-lang) {
      opacity: 1;
    }
  }
  /* 两级类 + 元素，压过基线的 .b3-typography code:not(.hljs)（85%/底色/内边距），
     代码块内部不再叠一层行内 code 皮肤 */
  .ai-md :global(.b3-typography pre code) {
    padding: 0;
    background: none;
    font-size: 100%;
  }
  .ai-md :global(a) {
    color: var(--b3-theme-primary, #378add);
    text-decoration: none;
  }
  .ai-md :global(a:hover) {
    text-decoration: underline;
  }
  .ai-md :global([data-type="block-ref"]) {
    color: var(--b3-theme-primary, #378add);
    cursor: pointer;
    border-bottom: 1px dashed var(--b3-theme-primary, #378add);
  }
  /* S0：公式与图片。块级公式在窄面板里允许横向滚动，不让 KaTeX 撑破气泡 */
  .ai-md :global(div.language-math) {
    margin: 8px 0;
    overflow-x: auto;
    overflow-y: hidden;
  }
  .ai-md :global(img) {
    max-width: 100%;
    height: auto;
    border-radius: 6px;
    margin: 6px 0;
  }

  .ai-foot {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    font-size: 11px;
    color: var(--b3-theme-on-surface-light, #9aa0a6);
  }
  .ai-receipt {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ai-msg-time {
    flex: none;
    font-variant-numeric: tabular-nums;
    opacity: 0.8;
  }
  .ai-usage {
    flex: none;
    font-variant-numeric: tabular-nums;
    opacity: 0.75;
  }
  /* P4-C：跨天分隔线（首条也显示，便于确认会话从哪天开始） */
  .ai-day {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 8px 12px 0;
    font-size: 10.5px;
    color: var(--b3-theme-on-surface-light, #9aa0a6);
    white-space: nowrap;
  }
  .ai-day::before,
  .ai-day::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--b3-border-color, rgba(0, 0, 0, 0.08));
  }
  .ai-flag {
    padding: 0 5px;
    border-radius: 4px;
    background: var(--b3-theme-surface, rgba(0, 0, 0, 0.05));
  }
  .ai-flag.err {
    color: var(--b3-theme-error, #d23f31);
  }
  .ai-foot-spacer {
    flex: 1;
  }
  .ai-link {
    border: none;
    background: none;
    padding: 0 2px;
    font-size: 11px;
    color: var(--b3-theme-on-surface-light, #9aa0a6);
    cursor: pointer;
  }
  .ai-link:hover {
    color: var(--b3-theme-primary, #378add);
  }
  .ai-link.on {
    color: var(--b3-theme-primary, #378add);
  }
  .ai-link:disabled {
    opacity: 0.55;
    cursor: default;
  }
  /* P1：失败卡 —— 只给行动建议，原始错误收进详情 */
  .ai-error-card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 9px 10px;
    border: 1px solid rgba(210, 63, 49, 0.28);
    border-radius: 9px;
    background: rgba(210, 63, 49, 0.055);
  }
  .ai-error-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    flex-wrap: wrap;
  }
  .ai-error-ico {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--b3-theme-error, #d23f31);
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    line-height: 1;
  }
  .ai-error-main {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 150px;
  }
  .ai-error-main strong {
    font-size: 12.5px;
    color: var(--b3-theme-on-background, #1f2329);
  }
  .ai-error-hint {
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--b3-theme-on-surface, #6b7280);
  }
  .ai-error-actions {
    display: flex;
    flex: none;
    gap: 6px;
  }
  .ai-error-detail summary {
    font-size: 11px;
    color: var(--b3-theme-on-surface-light, #9aa0a6);
    cursor: pointer;
  }
  .ai-error-detail pre {
    margin: 6px 0 0;
    padding: 7px 8px;
    max-height: 160px;
    overflow: auto;
    border-radius: 6px;
    background: var(--b3-theme-surface, rgba(0, 0, 0, 0.05));
    font-size: 11px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .ai-note-badge {
    padding: 0 5px;
    border-radius: 4px;
    white-space: nowrap;
    background: var(--b3-theme-primary-lightest, rgba(55, 138, 221, 0.12));
    color: var(--b3-theme-primary, #378add);
  }

  /* ---------- 笔记方案预览 ---------- */
  .ai-note-card {
    flex: none;
    display: flex;
    flex-direction: column;
    min-height: 0;
    max-height: 46%;
    margin: 0 10px 8px;
    padding: 8px 10px;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.1));
    border-radius: 8px;
    background: var(--b3-theme-surface, #f7f8fa);
  }
  .ai-note-hd {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  }
  .ai-note-hd-title {
    flex: none;
    font-weight: 600;
  }
  .ai-note-hd-target {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--b3-theme-on-surface-light, #9aa0a6);
  }
  .ai-note-hd-target .err {
    color: var(--b3-theme-error, #d23f31);
  }
  .ai-note-x {
    flex: none;
    border: none;
    background: none;
    padding: 0 2px;
    font-size: 14px;
    line-height: 1;
    color: var(--b3-theme-on-surface-light, #9aa0a6);
    cursor: pointer;
  }
  .ai-note-plan-title {
    margin: 6px 0 2px;
    font-size: 13px;
    font-weight: 600;
  }
  .ai-note-preview {
    min-height: 0;
    max-height: 26vh;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .ai-note-foot {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px dashed var(--b3-border-color, rgba(0, 0, 0, 0.1));
  }

  /* ---------- 输入区 ---------- */
  .ai-composer {
    position: relative;
    flex: none;
    padding: 8px 12px 10px;
    border-top: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.08));
  }
  /* P4-C：滚上去后浮在输入区上方的「回到底部」 */
  .ai-jump-wrap {
    position: absolute;
    top: -42px;
    left: 0;
    right: 0;
    display: flex;
    justify-content: center;
    pointer-events: none;
    z-index: 5;
  }
  .ai-jump {
    pointer-events: auto;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 26px;
    padding: 0 11px;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.1));
    border-radius: 999px;
    background: var(--b3-theme-background, #fff);
    color: var(--b3-theme-on-surface, #6b7280);
    font-size: 11px;
    cursor: pointer;
    box-shadow: 0 2px 10px rgba(20, 26, 36, 0.12);
  }
  .ai-jump:hover {
    border-color: var(--b3-theme-primary, #378add);
    color: var(--b3-theme-on-background, #1f2329);
  }
  .ai-pending {
    display: flex;
    align-items: flex-start;
    gap: 4px;
    margin-bottom: 6px;
  }
  .ai-pending-main {
    flex: 1;
  }
  .ai-pending-x {
    flex: none;
    width: 22px;
    height: 22px;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--b3-theme-on-surface-light, #9aa0a6);
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
  }
  .ai-pending-x:hover {
    background: var(--b3-list-hover, rgba(0, 0, 0, 0.05));
  }
  /* P4 快捷上下文：本页 / 本章 / 目录 / @笔记（常驻一行，不因状态变化位移） */
  .ai-ctx-wrap {
    position: relative;
  }
  /* P0 目录浮层：向上展开、不占位，避免消息区跳动 */
  .ai-toc-pop {
    position: absolute;
    left: 0;
    right: 0;
    bottom: calc(100% + 6px);
    z-index: 45;
    display: flex;
    flex-direction: column;
    max-height: min(56vh, 420px);
    padding: 8px;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.1));
    border-radius: 10px;
    background: var(--b3-theme-background, #fff);
    box-shadow: 0 10px 28px rgba(20, 26, 36, 0.16);
  }
  .ai-toc-hd {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 0 2px 4px;
  }
  .ai-toc-hd-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--re-ai-ink);
  }
  .ai-toc-now {
    margin-left: auto;
    overflow: hidden;
    color: var(--re-ai-accent);
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ai-toc-tip {
    padding: 0 2px 6px;
    color: var(--re-ai-muted);
    font-size: 10.5px;
    line-height: 1.5;
  }
  .ai-toc-list {
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .ai-toc-item {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 5px 8px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--re-ai-ink);
    font-size: 12px;
    line-height: 1.45;
    text-align: left;
    cursor: pointer;
  }
  .ai-toc-item:hover {
    background: var(--b3-list-hover, rgba(0, 0, 0, 0.05));
  }
  .ai-toc-item.on {
    background: var(--re-ai-accent-soft);
    color: var(--re-ai-accent);
  }
  .ai-toc-item.end {
    font-weight: 600;
  }
  .ai-toc-no {
    flex: none;
    min-width: 18px;
    color: var(--re-ai-muted);
    font-size: 10.5px;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }
  .ai-toc-item.on .ai-toc-no {
    color: var(--re-ai-accent);
  }
  .ai-toc-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ai-toc-badge {
    flex: none;
    margin-left: auto;
    padding: 0 5px;
    border-radius: 999px;
    background: var(--b3-list-hover, rgba(0, 0, 0, 0.05));
    color: var(--re-ai-muted);
    font-size: 9.5px;
    line-height: 15px;
  }
  .ai-toc-warn {
    margin-top: 6px;
    padding: 5px 8px;
    border-radius: 6px;
    background: rgba(178, 106, 0, 0.1);
    color: #b26a00;
    font-size: 10.5px;
    line-height: 1.5;
  }
  .ai-toc-empty {
    padding: 14px 8px;
    color: var(--re-ai-muted);
    font-size: 11.5px;
    text-align: center;
  }
  .ai-toc-ft {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--re-ai-line);
  }
  .ai-toc-ft-gap {
    flex: 1;
  }
  .ai-toc-btn {
    height: 24px;
    padding: 0 12px;
    border: 1px solid var(--re-ai-line);
    border-radius: 999px;
    background: var(--re-ai-card);
    color: var(--re-ai-muted);
    font-size: 11.5px;
    cursor: pointer;
  }
  .ai-toc-btn:hover:not(:disabled) {
    border-color: var(--re-ai-accent);
    color: var(--re-ai-ink);
  }
  .ai-toc-btn:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .ai-toc-btn.is-primary {
    border-color: transparent;
    background: var(--re-ai-accent);
    color: #fff;
  }
  .ai-toc-btn.is-primary:hover {
    color: #fff;
  }
  .ai-ctx-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    margin-bottom: 6px;
  }
  .ai-ctx-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    max-width: 100%;
    height: 24px;
    padding: 0 8px;
    border: 1px solid var(--re-ai-line);
    border-radius: 999px;
    background: var(--re-ai-card);
    color: var(--re-ai-muted);
    font-size: 11px;
    line-height: 1;
    cursor: pointer;
  }
  .ai-ctx-chip:hover {
    border-color: var(--re-ai-accent);
    color: var(--re-ai-ink);
  }
  .ai-ctx-chip.on {
    border-color: transparent;
    background: var(--re-ai-accent-soft);
    color: var(--re-ai-accent);
    font-weight: 600;
  }
  .ai-ctx-note {
    max-width: 56%;
  }
  .ai-ctx-note.empty {
    border-style: dashed;
  }
  .ai-ctx-at {
    flex: none;
    font-weight: 700;
    opacity: 0.85;
  }
  .ai-ctx-note-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ai-ctx-dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--re-ai-faint);
  }
  .ai-ctx-dot.on {
    background: var(--re-ai-accent);
  }
  .ai-composer-bar {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 6px;
    min-width: 0;
  }
  /* P4-C：模型快切气泡（向上展开，贴底栏不占位） */
  .ai-model-pop {
    position: absolute;
    left: 0;
    bottom: calc(100% + 8px);
    z-index: 40;
    width: min(260px, 86%);
    max-height: 260px;
    overflow-y: auto;
    padding: 5px;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.1));
    border-radius: 10px;
    background: var(--b3-theme-background, #fff);
    box-shadow: 0 8px 24px rgba(20, 26, 36, 0.14);
  }
  .ai-model-pop-hd {
    padding: 4px 8px 6px;
    font-size: 10.5px;
    color: var(--b3-theme-on-surface-light, #9aa0a6);
  }
  .ai-model-opt {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 8px;
    border: none;
    border-radius: 7px;
    background: transparent;
    color: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  .ai-model-opt:hover {
    background: var(--b3-list-hover, rgba(0, 0, 0, 0.05));
  }
  .ai-model-opt.on {
    color: var(--b3-theme-primary, #378add);
  }
  .ai-model-check {
    flex: none;
    width: 12px;
    font-size: 11px;
    text-align: center;
  }
  .ai-model-opt-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ai-model-more {
    display: block;
    width: 100%;
    margin-top: 4px;
    padding: 7px 8px 5px;
    border: none;
    border-top: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.08));
    background: transparent;
    color: var(--b3-theme-on-surface-light, #9aa0a6);
    font-size: 11px;
    text-align: left;
    cursor: pointer;
  }
  .ai-model-more:hover {
    color: var(--b3-theme-on-background, #1f2329);
  }
  .ai-model-pill.open {
    border-color: var(--b3-theme-primary, #378add);
    color: var(--b3-theme-on-background, #1f2329);
  }
  .ai-model-pill.open .ai-caret {
    transform: rotate(-90deg);
  }
  .ai-model-pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    max-width: 46%;
    padding: 3px 7px;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.1));
    border-radius: 999px;
    background: transparent;
    color: var(--b3-theme-on-surface, #6b7280);
    font-size: 11px;
    cursor: pointer;
    min-width: 0;
  }
  .ai-model-pill:hover {
    border-color: var(--b3-theme-primary, #378add);
    color: var(--b3-theme-on-background, #1f2329);
  }
  .ai-model-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ai-model-dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--b3-theme-on-surface-light, #c0c4cc);
  }
  .ai-model-dot.ok {
    background: var(--b3-theme-success, #4caf50);
  }
  .ai-caret {
    flex: none;
    opacity: 0.6;
  }
  .ai-ctx-hint {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 10.5px;
    color: var(--b3-theme-on-surface-light, #9aa0a6);
  }
  .ai-bar-spacer {
    flex: 1;
  }
  .ai-stop {
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.14));
    border-radius: 999px;
    background: transparent;
    color: var(--b3-theme-on-surface, #6b7280);
    font-size: 11px;
    padding: 3px 9px;
    cursor: pointer;
  }
  .ai-stop:hover {
    color: var(--b3-theme-error, #d23f31);
    border-color: var(--b3-theme-error, #d23f31);
  }
  .ai-send {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: none;
    border-radius: 50%;
    background: var(--b3-theme-primary, #378add);
    color: #fff;
    cursor: pointer;
  }
  .ai-send:disabled {
    opacity: 0.35;
    cursor: default;
  }

  /* ---------- 设置 ---------- */
  .ai-settings {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 12px 12px 20px;
    overscroll-behavior: contain;
  }
  .ai-field-hint {
    font-size: 11px;
    line-height: 1.5;
    color: var(--b3-theme-on-surface-light, #9aa0a6);
  }
  .ai-field-hint.err {
    color: var(--b3-theme-error, #d23f31);
    word-break: break-word;
  }
  .ai-btn {
    padding: 6px 14px;
    border-radius: 6px;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.14));
    background: transparent;
    color: var(--b3-theme-on-background, #1f2329);
    font-size: 12px;
    cursor: pointer;
  }
  .ai-btn.primary {
    border-color: var(--b3-theme-primary, #378add);
    background: var(--b3-theme-primary, #378add);
    color: #fff;
  }
  .ai-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }

  /* ---------- P3：思维导图卡片 ---------- */
  .ai-map-card {
    max-height: 52%;
  }
  .ai-map-card :global(.mm-card) {
    margin: 6px 0 0;
    border: none;
    background: transparent;
  }
  .ai-map-card :global(.mm-scroll) {
    max-height: 32vh;
  }

  /* ---------- P3：块引用悬浮预览 ---------- */
  .ai-block-preview {
    position: fixed;
    z-index: 30;
    display: flex;
    flex-direction: column;
    min-width: 220px;
    padding: 7px 9px;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.12));
    border-radius: 9px;
    background: var(--b3-theme-background, #fff);
    color: var(--b3-theme-on-background, #1f2329);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.16);
    box-sizing: border-box;
    overflow: hidden;
  }
  .ai-bp-hd {
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--b3-theme-on-surface-light, #9aa0a6);
  }
  .ai-bp-title {
    font-weight: 600;
    color: var(--b3-theme-on-background, #1f2329);
  }
  .ai-bp-id {
    font-variant-numeric: tabular-nums;
    opacity: 0.65;
  }
  .ai-bp-x {
    flex: none;
    border: none;
    background: none;
    padding: 0 2px;
    font-size: 14px;
    line-height: 1;
    color: var(--b3-theme-on-surface-light, #9aa0a6);
    cursor: pointer;
  }
  .ai-bp-body {
    flex: 1;
    min-height: 0;
    margin-top: 4px;
    overflow-y: auto;
    overscroll-behavior: contain;
    font-size: 12.5px;
  }
  .ai-bp-err {
    padding: 6px 0;
    font-size: 12px;
    color: var(--b3-theme-error, #d23f31);
  }
  .ai-bp-foot {
    flex: none;
    display: flex;
    justify-content: flex-end;
    margin-top: 4px;
    padding-top: 4px;
    border-top: 1px dashed var(--b3-border-color, rgba(0, 0, 0, 0.1));
  }

  /* ================= 2026-11-05 C 轮：视觉对标 demo =================
   * 目标：右侧是「另一个产品」而不是正文的延续——浅色面板底 + 白色卡片 +
   * 明显分界线；对话按聊天产品排版（右蓝气泡 / 左白卡 / 工具行 / 输入框）。
   * 全部走主题令牌，深色主题自动跟随。 */
  .ai-panel {
    --re-ai-line: var(--b3-border-color, #e4e6e9);
    /* 注意：--b3-theme-background-light 在 Neo 主题里是 oklch(... / 0.1)，
       直接用会让整个面板半透明；surface 是实色，缺失时再退到主背景。 */
    --re-ai-panel: var(--b3-theme-surface, var(--b3-theme-background, #f8f8f7));
    --re-ai-card: var(--b3-theme-background, #fff);
    --re-ai-ink: var(--b3-theme-on-background, #1e2228);
    --re-ai-muted: var(--b3-theme-on-surface, #7a828c);
    --re-ai-faint: var(--b3-theme-on-surface-light, #9aa3ae);
    --re-ai-accent: var(--b3-theme-primary, #3b6ef5);
    --re-ai-accent-soft: var(--b3-theme-primary-lightest, #eaf0ff);
    background: var(--re-ai-panel);
    box-shadow: -10px 0 30px rgba(20, 26, 36, 0.05);
  }

  /* ---------- 纸感皮肤：暖黄强调 + 细线 + 极淡网点 ---------- */
  .ai-panel.paper {
    --re-ai-line: #e6e0d2;
    --re-ai-panel: #f7f4ec;
    --re-ai-card: #fffdf8;
    --re-ai-ink: #211f1a;
    --re-ai-muted: #6f6a5f;
    --re-ai-faint: #9a9488;
    --re-ai-accent: #a97b00;
    --re-ai-accent-soft: #f7e7ae;
    background-image: radial-gradient(circle at 1px 1px, rgba(80, 70, 40, 0.045) 1px, transparent 0);
    background-size: 12px 12px;
  }

  :global(html[data-theme-mode="dark"]) .ai-panel.paper {
    --re-ai-line: #35302a;
    --re-ai-panel: #17150f;
    --re-ai-card: #201d16;
    --re-ai-ink: #ece7db;
    --re-ai-muted: #a9a293;
    --re-ai-faint: #7f786a;
    --re-ai-accent: #d9b23c;
    --re-ai-accent-soft: #3a3115;
  }

  .ai-thread::-webkit-scrollbar,
  .ai-settings::-webkit-scrollbar,
  .ai-note-preview::-webkit-scrollbar {
    width: 8px;
    height: 8px;
  }
  .ai-thread::-webkit-scrollbar-thumb,
  .ai-settings::-webkit-scrollbar-thumb,
  .ai-note-preview::-webkit-scrollbar-thumb {
    background: var(--re-ai-line);
    border-radius: 99px;
  }

  /* ---------- 头部：封面块 + 书名 ---------- */
  .ai-hd {
    gap: 10px;
    padding: 10px 12px 9px 14px;
    border-bottom: 1px solid var(--re-ai-line);
  }
  .ai-cover {
    flex: 0 0 32px;
    width: 32px;
    height: 38px;
    border-radius: 4px;
    background: linear-gradient(155deg, #2c3b58, #4c628c);
    color: #fff;
    font-family: var(--b3-font-family, serif);
    font-size: 15px;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.18), 0 2px 6px rgba(30, 40, 60, 0.18);
  }
  .ai-hd-title {
    display: block;
    font-size: 13px;
    font-weight: 620;
    line-height: 1.3;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ai-hd-sub {
    font-size: 11px;
  }
  .ai-hd-actions {
    gap: 1px;
  }
  .ai-icon-btn {
    width: 28px;
    height: 28px;
    border-radius: 7px;
  }

  /* ---------- Tab：下划线 + 数量徽标 ---------- */
  .ai-tabs {
    gap: 2px;
    padding: 0 12px;
    border-bottom: 1px solid var(--re-ai-line);
  }
  .ai-tab {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 40px;
    margin-right: 0;
    padding: 0 10px;
    font-size: 12.5px;
    color: var(--re-ai-muted);
  }
  .ai-tab.on {
    color: var(--re-ai-ink);
    font-weight: 600;
  }
  .ai-tab.on::after {
    left: 8px;
    right: 8px;
    bottom: -1px;
    height: 2px;
    border-radius: 2px 2px 0 0;
    background: var(--re-ai-ink);
  }
  .ai-tab-badge {
    min-width: 16px;
    height: 16px;
    padding: 0 5px;
    border-radius: 99px;
    background: var(--re-ai-accent-soft);
    color: var(--re-ai-accent);
    font-size: 10px;
    font-weight: 650;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .ai-icon-btn.on {
    color: var(--re-ai-accent);
    background: var(--re-ai-accent-soft);
  }

  /* ---------- 历史会话：Copilot 式浮卡（不遮对话，无蒙层） ---------- */
  .ai-history {
    position: absolute;
    left: 8px;
    right: 8px;
    z-index: 30;
    display: flex;
    flex-direction: column;
    width: auto;
    max-width: 420px;
    margin: 0 auto;
    min-height: 0;
    /* 必须实底：Neo 等主题的 background-light 带 alpha，半透明会让对话内容透出来 */
    background: var(--b3-theme-background, #fff);
    color: var(--re-ai-ink);
    border: 1px solid var(--re-ai-line);
    border-radius: 16px;
    box-shadow: 0 18px 48px rgba(20, 26, 36, 0.2), 0 2px 8px rgba(20, 26, 36, 0.08);
    outline: none;
    animation: ai-history-in 0.16s ease-out;
  }
  @keyframes ai-history-in {
    from {
      opacity: 0;
      transform: translateY(-6px) scale(0.985);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  .ai-history-hd {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
  }
  .ai-history-tabs {
    display: flex;
    align-items: center;
    gap: 2px;
    min-width: 0;
  }
  .ai-history-tab {
    height: 28px;
    padding: 0 10px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--re-ai-muted);
    font-size: 12.5px;
    font-weight: 600;
    white-space: nowrap;
    cursor: pointer;
  }
  .ai-history-tab:hover {
    background: var(--b3-list-hover, rgba(0, 0, 0, 0.05));
    color: var(--re-ai-ink);
  }
  .ai-history-tab.on {
    background: var(--re-ai-accent-soft);
    color: var(--re-ai-accent);
  }
  .ai-history-tools {
    position: relative;
    justify-self: center;
  }
  .ai-history-tools-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--re-ai-muted);
    cursor: pointer;
  }
  .ai-history-tools-btn:hover,
  .ai-history-tools-btn[aria-expanded="true"] {
    background: var(--b3-list-hover, rgba(0, 0, 0, 0.05));
    color: var(--re-ai-ink);
  }
  .ai-history-tools-menu {
    position: absolute;
    top: 34px;
    left: 50%;
    z-index: 40;
    min-width: 132px;
    padding: 4px;
    border: 1px solid var(--re-ai-line);
    border-radius: 10px;
    background: var(--b3-theme-background, #fff);
    box-shadow: 0 10px 30px rgba(20, 26, 36, 0.18);
    transform: translateX(-50%);
  }
  .ai-history-tools-menu button {
    display: block;
    width: 100%;
    padding: 7px 9px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--re-ai-ink);
    font-size: 12px;
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
  }
  .ai-history-tools-menu button:hover {
    background: var(--b3-list-hover, rgba(0, 0, 0, 0.05));
  }
  .ai-history-tools-menu button.danger {
    color: var(--b3-theme-error, #d23f31);
  }
  .ai-history-new {
    justify-self: end;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    height: 30px;
    padding: 0 11px;
    border: 0;
    border-radius: 9px;
    background: var(--re-ai-accent);
    color: #fff;
    font-size: 12.5px;
    font-weight: 600;
    white-space: nowrap;
    cursor: pointer;
  }
  .ai-history-new:hover {
    filter: brightness(1.06);
  }
  .ai-history-search {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 40px;
    padding: 0 14px;
    border-bottom: 1px solid var(--re-ai-line);
    background: transparent;
    color: var(--re-ai-faint);
  }
  .ai-history-search svg {
    flex: none;
    opacity: 0.8;
  }
  .ai-history-search input {
    flex: 1;
    min-width: 0;
    height: 100%;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--re-ai-ink);
    font-size: 12.5px;
  }
  .ai-history-search input::placeholder {
    color: var(--re-ai-faint);
  }
  .ai-history-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 8px 8px 10px;
  }
  .ai-history-item {
    position: relative;
    display: flex;
    align-items: center;
    margin-bottom: 4px;
    border-radius: 10px;
    background: transparent;
    box-shadow: inset 0 0 0 0 transparent;
    transition: background 0.12s ease;
  }
  .ai-history-item:hover {
    background: var(--b3-list-hover, rgba(0, 0, 0, 0.04));
  }
  .ai-history-item.on {
    background: var(--re-ai-accent-soft);
    background: color-mix(in srgb, var(--re-ai-accent) 14%, var(--b3-theme-background, #fff));
    box-shadow: inset 0 0 0 1.5px var(--re-ai-accent);
  }
  .ai-history-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 11px 4px 11px 12px;
    border: 0;
    background: transparent;
    text-align: left;
    color: inherit;
    cursor: pointer;
  }
  .ai-history-item-title {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 13px;
    font-weight: 600;
    color: var(--re-ai-ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ai-history-item.on .ai-history-item-text {
    color: var(--re-ai-accent);
  }
  .ai-history-item-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
    color: var(--re-ai-faint);
  }
  .ai-history-meta-dot {
    opacity: 0.6;
  }
  .ai-history-actions {
    flex: none;
    display: flex;
    align-items: center;
    padding-right: 6px;
  }
  .ai-history-more,
  .ai-history-del {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--re-ai-faint);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.12s ease, background 0.12s ease, color 0.12s ease;
  }
  .ai-history-more {
    font-size: 15px;
    line-height: 1;
  }
  .ai-history-item:hover .ai-history-more,
  .ai-history-item:hover .ai-history-del {
    opacity: 1;
  }
  .ai-history-item.on .ai-history-del {
    opacity: 1;
  }
  .ai-history-more[aria-expanded="true"] {
    opacity: 1;
    background: var(--b3-list-hover, rgba(0, 0, 0, 0.05));
    color: var(--re-ai-ink);
  }
  .ai-history-more:hover {
    background: var(--b3-list-hover, rgba(0, 0, 0, 0.05));
    color: var(--re-ai-ink);
  }
  .ai-history-del:hover {
    color: var(--b3-theme-error, #d23f31);
    background: var(--b3-theme-error-light, rgba(210, 63, 49, 0.08));
  }
  /* P1：置顶标记 / 更多菜单 / 内联重命名 */
  .ai-history-pinned {
    flex: none;
    display: inline-flex;
    color: var(--re-ai-accent);
  }
  .ai-history-item-text {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* AI 命名标记：只给确实由模型改过标题的会话 */
  .ai-history-ai {
    flex: none;
    display: inline-flex;
    align-items: center;
    padding: 1px 4px;
    border-radius: 4px;
    font-size: 9.5px;
    font-weight: 600;
    line-height: 1.2;
    letter-spacing: 0.02em;
    color: var(--re-ai-accent);
    background: color-mix(in srgb, var(--re-ai-accent) 10%, transparent);
  }
  .ai-history-menu {
    position: absolute;
    top: 40px;
    right: 8px;
    z-index: 20;
    min-width: 152px;
    padding: 4px;
    border: 1px solid var(--re-ai-line);
    border-radius: 9px;
    background: var(--b3-theme-background, #fff);
    box-shadow: 0 8px 24px rgba(20, 26, 36, 0.16);
  }
  .ai-history-menu button {
    display: block;
    width: 100%;
    padding: 7px 9px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--re-ai-ink);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  .ai-history-menu button:hover {
    background: var(--b3-list-hover, rgba(0, 0, 0, 0.05));
  }
  .ai-history-menu button.danger {
    color: var(--b3-theme-error, #d23f31);
  }
  .ai-history-menu button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .ai-history-rename {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
    padding: 6px 8px;
  }
  .ai-history-rename-input {
    flex: 1;
    min-width: 0;
    height: 28px;
    padding: 0 7px;
    border: 1px solid var(--re-ai-accent);
    border-radius: 6px;
    outline: none;
    background: var(--b3-theme-background, #fff);
    color: var(--re-ai-ink);
    font-size: 12px;
  }
  .ai-history-rename-ok,
  .ai-history-rename-cancel {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border: 1px solid var(--re-ai-line);
    border-radius: 6px;
    background: transparent;
    color: var(--re-ai-muted);
    cursor: pointer;
  }
  .ai-history-rename-ok:hover {
    color: var(--re-ai-accent);
    border-color: var(--re-ai-accent);
  }
  .ai-history-rename-cancel:hover {
    color: var(--b3-theme-error, #d23f31);
  }
  @media (hover: none) {
    .ai-history-more,
    .ai-history-del {
      opacity: 1;
    }
  }
  .ai-history-empty {
    padding: 36px 16px;
    text-align: center;
    color: var(--re-ai-faint);
    font-size: 12px;
  }

  /* ---------- 消息流：两端对齐，宽面板下也保持可读行宽 ---------- */
  .ai-thread {
    padding: 16px 14px 18px;
    scroll-behavior: smooth;
  }
  .ai-thread > * {
    max-width: 880px;
    margin-left: auto;
    margin-right: auto;
  }
  .ai-msg {
    gap: 7px;
    margin-bottom: 14px;
  }
  .ai-msg.user {
    align-items: flex-end;
  }
  .ai-bubble {
    max-width: 88%;
    padding: 9px 12px;
    border: 1px solid var(--re-ai-accent-soft);
    border-radius: 14px 14px 4px 14px;
    background: var(--re-ai-accent-soft);
    color: var(--re-ai-ink);
    font-size: var(--re-ai-font-size, 14px);
    line-height: 1.65;
  }
  .ai-qchip,
  .ai-pending-main {
    max-width: 88%;
    padding: 6px 9px;
    border-color: var(--re-ai-line);
    border-radius: 8px;
    background: var(--re-ai-card);
    color: var(--re-ai-muted);
  }
  .ai-qchip:hover,
  .ai-pending-main:hover {
    border-color: var(--re-ai-accent);
  }
  .ai-msg.assistant {
    padding: 11px 12px 12px;
    border: 1px solid var(--re-ai-line);
    border-radius: 14px;
    background: var(--re-ai-card);
    box-shadow: 0 1px 2px rgba(20, 26, 36, 0.03);
  }
  .ai-role {
    gap: 6px;
    font-size: 10.5px;
    font-weight: 500;
    letter-spacing: 0.04em;
    color: var(--re-ai-faint);
  }
  .ai-role .ai-spark.small {
    width: 15px;
    height: 15px;
    border-radius: 5px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(140deg, var(--re-ai-accent), #8f6cf0);
    color: #fff;
    font-size: 9px;
    line-height: 1;
  }
  .ai-typing {
    font-size: 11px;
    letter-spacing: 0;
  }

  /* ---------- 工具轨迹：一行一张小卡 ---------- */
  .ai-tools {
    gap: 6px;
    margin: 2px 0;
  }
  .ai-tool {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 7px 9px;
    border: 1px solid var(--re-ai-line);
    border-radius: 9px;
    background: var(--re-ai-panel);
    font-size: 11.5px;
  }
  .ai-tool-dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--b3-theme-success, #2f9e6e);
    box-shadow: 0 0 0 3px rgba(47, 158, 110, 0.13);
  }
  .ai-tool.err .ai-tool-dot {
    background: var(--b3-theme-error, #c74848);
    box-shadow: 0 0 0 3px rgba(199, 72, 72, 0.13);
  }
  .ai-tool-label {
    flex: 1;
    min-width: 0;
    color: var(--re-ai-ink);
  }
  .ai-tool-meta {
    flex: none;
    font-size: 10.5px;
    color: var(--re-ai-faint);
  }

  /* ---------- 思考过程：虚线小卡 ---------- */
  .ai-reason {
    padding: 0 10px;
    border: 1px dashed var(--re-ai-line);
    border-radius: 8px;
    background: var(--re-ai-panel);
    font-size: 11.5px;
    color: var(--re-ai-muted);
  }
  .ai-reason summary {
    padding: 7px 0;
    font-size: 11.5px;
    opacity: 1;
  }
  .ai-reason-body {
    padding-bottom: 8px;
  }

  /* ---------- 空状态：快捷问句卡 ---------- */
  .ai-empty {
    padding: 22px 4px 8px;
  }
  .ai-empty-title {
    font-size: 15px;
    font-weight: 650;
    letter-spacing: 0.01em;
  }
  .ai-empty-sub {
    margin-top: 6px;
    font-size: 12px;
    color: var(--re-ai-muted);
  }
  .ai-hints {
    gap: 6px;
    margin-top: 16px;
  }
  .ai-hint {
    padding: 9px 10px;
    border-color: var(--re-ai-line);
    border-radius: 10px;
    background: var(--re-ai-card);
    box-shadow: 0 1px 2px rgba(20, 26, 36, 0.03);
    font-size: 12px;
    color: var(--re-ai-ink);
    transition: border-color 0.15s ease, background 0.15s ease;
  }
  .ai-hint:hover {
    border-color: var(--re-ai-accent);
  }
  .ai-hint-ico {
    flex: 0 0 22px;
    width: 22px;
    height: 22px;
    border-radius: 6px;
    background: var(--re-ai-accent-soft);
    color: var(--re-ai-accent);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 10.5px;
    font-weight: 600;
  }
  .ai-hint-sub {
    font-size: 10.5px;
    color: var(--re-ai-faint);
  }

  /* ---------- 底部动作行 ---------- */
  .ai-foot {
    gap: 8px;
    padding-top: 2px;
    font-size: 10.5px;
  }
  .ai-link {
    padding: 3px 6px;
    border-radius: 6px;
    font-size: 10.5px;
  }
  .ai-link:hover {
    background: var(--re-ai-accent-soft);
  }
  .ai-note-badge {
    padding: 2px 7px;
    border-radius: 99px;
  }

  /* ---------- 导图 / 笔记预览卡 ---------- */
  .ai-note-card {
    margin: 0 12px 10px;
    border-color: var(--re-ai-line);
    border-radius: 12px;
    background: var(--re-ai-card);
    box-shadow: 0 2px 10px rgba(20, 26, 36, 0.06);
  }

  /* ---------- 输入区：白色输入框 + 轻底栏 ---------- */
  .ai-composer {
    padding: 10px 12px 12px;
    border-top: 1px solid var(--re-ai-line);
    background: var(--re-ai-panel);
  }
  .ai-composer :global(.ai-composer-input) {
    box-sizing: border-box;
    min-height: 44px;
    padding: 9px 11px;
    border: 1px solid var(--re-ai-line);
    border-radius: 10px;
    background: var(--re-ai-card);
    font-size: 13px;
    transition: border-color 0.16s ease, box-shadow 0.16s ease;
  }
  .ai-composer :global(.ai-composer-input:focus) {
    border-color: var(--re-ai-accent);
    box-shadow: 0 0 0 3px var(--re-ai-accent-soft);
  }
  .ai-composer-bar {
    margin-top: 8px;
  }
  .ai-model-pill {
    padding: 4px 7px;
    border-color: transparent;
    border-radius: 6px;
    font-size: 10.5px;
  }
  .ai-model-pill:hover {
    border-color: transparent;
    background: var(--b3-list-hover, rgba(0, 0, 0, 0.05));
  }
  .ai-model-pill.open {
    border-color: transparent;
    background: var(--re-ai-accent-soft);
    color: var(--re-ai-accent);
  }
  .ai-day {
    margin: 10px 2px 0;
    color: var(--re-ai-faint);
  }
  .ai-day::before,
  .ai-day::after {
    background: var(--re-ai-line);
  }
  .ai-jump {
    height: 28px;
    border-color: var(--re-ai-line);
    background: var(--re-ai-card);
    color: var(--re-ai-muted);
    box-shadow: 0 4px 14px rgba(20, 26, 36, 0.1);
  }
  .ai-jump:hover {
    border-color: var(--re-ai-accent);
    color: var(--re-ai-ink);
  }
  .ai-model-pop {
    border-color: var(--re-ai-line);
    background: var(--re-ai-card);
  }
  .ai-model-pop-hd,
  .ai-model-more {
    color: var(--re-ai-faint);
  }
  .ai-model-more {
    border-top-color: var(--re-ai-line);
  }
  .ai-model-more:hover {
    color: var(--re-ai-ink);
  }
  .ai-model-opt.on {
    color: var(--re-ai-accent);
  }
  .ai-send {
    width: 30px;
    height: 30px;
    border-radius: 9px;
    box-shadow: 0 2px 8px rgba(59, 110, 245, 0.26);
  }
  .ai-send:hover:not(:disabled) {
    filter: brightness(0.94);
  }
  .ai-stop {
    height: 30px;
    padding: 0 10px;
    border-radius: 8px;
    background: var(--re-ai-card);
  }

  /* ---------- 笔记 Tab ---------- */
  .ai-notes {
    padding: 14px;
  }
  .ai-notes-empty {
    padding: 18px 4px;
  }
  .ai-note-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    margin-bottom: 8px;
    padding: 11px 12px;
    border: 1px solid var(--re-ai-line);
    border-radius: 10px;
    background: var(--re-ai-card);
    color: var(--re-ai-ink);
    text-align: left;
    cursor: pointer;
    transition: border-color 0.15s ease;
  }
  .ai-note-item:hover {
    border-color: var(--re-ai-accent);
  }
  .ai-note-item-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .ai-note-item-title {
    font-size: 12.5px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ai-note-item-sub {
    font-size: 11px;
    color: var(--re-ai-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ai-note-item-date {
    flex: none;
    font-size: 10.5px;
    color: var(--re-ai-faint);
    font-variant-numeric: tabular-nums;
  }

  /* ---------- P3：手机全屏覆盖层 ---------- */
  .ai-panel.is-overlay {
    border-left: none;
  }
  .ai-panel.is-overlay .ai-hd {
    padding-top: calc(10px + env(safe-area-inset-top, 0px));
  }
  .ai-panel.is-overlay .ai-icon-btn {
    width: 34px;
    height: 34px;
  }
  .ai-panel.is-overlay .ai-ctx-chip {
    height: 30px;
    padding: 0 11px;
    font-size: 12px;
  }
  .ai-panel.is-overlay .ai-tabs {
    padding: 0 12px;
  }
  .ai-panel.is-overlay .ai-tab {
    padding: 10px 8px 11px;
    font-size: 13px;
  }
  .ai-panel.is-overlay .ai-hint {
    padding: 11px 12px;
    min-height: 44px;
  }
  .ai-panel.is-overlay .ai-link {
    display: inline-flex;
    align-items: center;
    min-height: 28px;
    padding: 0 6px;
    font-size: 12px;
  }
  .ai-panel.is-overlay .ai-composer {
    padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px));
  }
  .ai-panel.is-overlay .ai-send {
    width: 34px;
    height: 34px;
  }
  .ai-panel.is-overlay .ai-stop {
    padding: 6px 12px;
    font-size: 12px;
  }
  .ai-panel.is-overlay .ai-ctx-hint {
    display: none;
  }
  .ai-panel.is-overlay .ai-jump {
    height: 32px;
    padding: 0 14px;
    font-size: 12px;
  }
  .ai-panel.is-overlay .ai-model-pop {
    width: min(300px, 92%);
    max-height: 44vh;
  }
  .ai-panel.is-overlay .ai-model-opt {
    min-height: 38px;
    font-size: 13px;
  }
  .ai-panel.is-overlay :global(.ai-composer-input) {
    font-size: 16px;
    line-height: 1.55;
  }
  .ai-panel.is-overlay .ai-note-card {
    max-height: 44%;
    margin-left: 8px;
    margin-right: 8px;
  }
  .ai-panel.is-overlay .ai-map-card :global(.mm-scroll) {
    max-height: 36vh;
  }
</style>
