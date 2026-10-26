<script lang="ts">
  import { logSwallow } from "../core/safe.ts";
import { getLogger } from "../core/logger.ts";
  import { t } from "../i18n/index";
  /**
   * 阅读器 - 阅读面板（P0 + P1 打磨）
   * ---------------------------------------------------------------
   * - 渲染：foliate-js <foliate-view>（EPUB/MOBI/AZW3/FB2/CBZ 原生；TXT/MD 自研适配器）
   * - 翻页：iframe 内 点击分区 / 键盘 / 触摸滑动（foliate 内核不带翻页交互）
   * - 底部工具栏：☰目录 ◀ 进度条+百分比 ▶ 🔍搜索 ⚙设置；顶栏：返回 + 书名 + 章节名
   * - 全文搜索：foliate view.search() 高亮 + 计数 + 上/下条跳转
   * - 阅读模式（分页/滚动 flow）、翻页动画（turn-style）、8 主题 + 自定义色
   */
  import { onMount, onDestroy, tick } from "svelte";
  // 移动端适配 Phase 0/1：统一环境判定入口（禁止再手写 getFrontend().endsWith("mobile")）
  import { isTouchDevice } from "../core/env.ts";
  // 2026-10-26：移动端压制浏览器原生选词菜单（长按浮条压在自绘划词工具栏上）
  import { shouldSuppressNativeMenu, nativeMenuGuardHandler, applyTouchCalloutNone } from "../core/native-menu.ts";
  // [REword patch 2026-08-29] 移动端 PDF 适配 Phase 1
  import { getDeviceClass, isSmallMobile, isLargeMobile, isMobile } from "../core/env.ts";
  // 2026-10-24 移动端适配 Phase 1：响应式视口状态（断点 / 软键盘），根节点状态类 + 紧凑顶栏开关
  import { viewport, isPhoneBreakpoint, type ViewportBreakpoint } from "../core/viewport-store.ts";
  // [REword 2026-09-02] 界面分流：按书籍格式自动切换「图书界面 / PDF 界面」。
  // 此前 PDF 与 EPUB 共用同一套模板、靠散落的 isPdfBook() 拼装控件，两类格式互相干扰。
  // 现在 PDF 专属控件收进 PdfToolbar / PdfSettings / PdfOverlay，图书专属控件收进 BookToolbar，
  // 本文件只负责按 readerMode 决定挂载哪一套。
  import { resolveReaderMode, isPdfFormat, type ReaderMode, bookTypeFromFormat, matchBookType, type BookType } from "./reader-mode.ts";
  import BookToolbar from "./BookToolbar.svelte";
  import PdfToolbar from "./PdfToolbar.svelte";
  import PdfSettings from "./PdfSettings.svelte";
  import PdfOverlay from "./PdfOverlay.svelte";
  // 2026-09-04 P1：PDF 文本标注自建覆盖层（高亮/下划线/波浪线单一视觉真源）
  import PdfTextHlLayer from "./PdfTextHlLayer.svelte";
  // [REword 2026-09-01] 笔记导出绑定拖拽框（阅读摘录 / 书图谱目标文档绑定）
  import BindDropzone from "./BindDropzone.svelte";
  import {
    inkState,
    // inkStrokes：擦除时直接 update 笔触列表（onInkPointerDown L1686）
    inkStrokes,
    // currentPageStrokes：橡皮取当前页最后一个笔触（onInkPointerDown L1684）
    // 注意：$store 由 Svelte 编译器在组件实例化时注入 component_subscribe，
    // 漏 import 会在挂载阶段抛 ReferenceError → 整棵组件白屏（tsc 查不到，只有 vite warn）
    currentPageStrokes,
    activeStroke,
    inkContext,
    isInkMode,
    addStroke,
    // 2026-09-04 P0-3：墨迹删除（侧栏合并后允许通过统一入口删墨迹，触发 inkSaver 自动落盘）
    removeStroke,
    setInkContext,
    setInkMode,
  } from "./ink/store";
  import {
    catmullRomToBezierPath,
    getCoalescedPoints,
    shouldUseHighlighter,
  } from "./ink/utils";
  import type { InkStroke, InkPoint } from "./ink/types";
  // @ts-ignore - foliate-js 为纯 ES 模块 vendor（副作用：注册 reword-foliate-view / reword-foliate-paginator / reword-foliate-fxl / reword-foliate-quoteimage）
  import "../reader/vendor/foliate-js/view-light.js";
  import { DocumentLoader } from "./document-loader.ts";
  // 2026-10-14 地基重构：内容能力（text/selection/reflow）单一真源，UI 侧据此做功能门控，
  // 取代此前散落的「readerMode !== "pdf"」这类把「能力」与「渲染管线」混为一谈的判断。
  import { resolveCapabilities, type ReaderCapabilities } from "./content-adapter.ts";
  // 2026-10-15 目录折叠：扁平 tocItems 仍是真源，树结构与可见行只在此派生。
  import { buildTocTree, visibleRows, ancestorIdsOf, tocIndexByHref } from "./toc-tree.ts";
  // 脚注检测 + 抽取（scoped 模块，不依赖 foliate vendor 内核）
  import { isFootnoteRef, extractFootnote } from "./footnote";
  // 2026-10-09：文档选择页的思源 API 加载器（最小接口 + 失败原因留存）。
  // 替代原先直接 `import("../siyuan/api.ts")` 的做法，理由见该文件头注释。
  import { loadDocPickerApi, probeDoc } from "./settings/doc-picker-api.ts";
  // 2026-10-09：导出目标解析（per-book 优先，全局兜底）。
  // 收敛到单独函数的原因见该文件头注释 —— 散落在多处判断迟早出「设置与实际不一致」。
  import { resolveExportTarget, resolveExportTargetAsync, describeTarget } from "./export/resolve-target.ts";
  // 2026-10-10：按书名自动建档（方案 B）。与 resolve-target 同源，都收敛到 export/。
  import { autoBindByTitle } from "./export/auto-bind.ts";
  import { renderTemplate, validateTemplate } from "./export/template-engine.ts";
  import {
    buildExportTemplateData,
    sampleTemplateData,
    type ExportTemplateData,
  } from "./export/template-data.ts";
  import { defaultTemplate } from "./export/template-presets.ts";
  import { applyBlockAttrs, buildAttrPairs } from "./export/attr-writer.ts";
  // v1.3.0：本书前提上下文编辑器（思源原生 lite Protyle）+ token 估算
  import { AnnEditor } from "../annotation/ann-editor.ts";
  import { estimateTokens, PRIMER_WARN_CHARS } from "./book-primer.ts";
  import type { BookshelfStore, BookMeta, BookMark } from "../reader/bookshelf-store";
  // [REword patch 2026-08-29] PDF 缩放：复用 ReadingProgress.zoom 字段
  import type { ZoomState } from "../reader/bookshelf-store";
  import { ZOOM_PRESETS } from "../reader/bookshelf-store";
  // [2026-09-01] Phase 1:PDF 大纲 / 页码提取(对齐 Obsidian PDF++ outline)
  import { extractPdfCurrentPage } from "../reader/pdf-outline";
  // 2026-10-24 滚轮翻页：手势判定（纯函数，无 DOM 依赖，可单测）。
  // 阈值/抑制窗口对齐 Readest 0.12.12 的 wheelGesture.ts，理由见该文件头注释。
  import { createWheelGestureDetector, type WheelGestureDetector } from "./wheel-gesture.ts";
  // 2026-10-24 统一翻页入口：逻辑方向（滚轮用）/ 物理方向（方向键用）单一真源，
  // 避免 RTL 书里各处方向判断分叉。详见 page-turn.ts 头注释。
  import { turnPage } from "./page-turn.ts";
  // 2026-10-24 跨页选区续接：可见区求交（工具栏/手柄锚点）+ 页边带判定（拖手柄自动翻页）。
  import { visibleRect, visibleRects, inPageMarginBand, type Rect4 } from "./sel-continuation.ts";
  // 2026-10-25 角落自动翻页（Readest useAutoPageTurn 复刻）：椭圆角检测 + 驻留状态机。
  import { CornerTurnMachine, type CornerSide } from "./corner-turn.ts";
  import {
    READER_DEFAULT_SETTINGS,
    READER_FONT_SIZE_MIN,
    READER_FONT_SIZE_MAX,
    THEME_PRESETS,
    LINE_WIDTH_PRESETS,
    FLOW_PRESETS,
    FONT_MODE_PRESETS,
    DEFAULT_FONT_FAMILY_PRESETS,
    SERIF_FONT_PRESETS,
    SANS_SERIF_FONT_PRESETS,
    MONOSPACE_FONT_PRESETS,
    CJK_FONT_PRESETS,
    NOTE_INSERT_POSITION_PRESETS,
    NOTE_TEMPLATE_PRESETS,
    PROGRESS_STYLE_PRESETS,
    LAYOUT_PRESETS,
    detectLayoutPreset,
    type ReaderSettings,
    type ReaderSettingsLike,
    type ReaderLayoutPreset,
    type ReaderTheme,
    type ReaderFontMode,
    type NoteInsertPosition,
    type NoteTemplatePreset,
    type ReaderProgressStyle,
    type ReaderBottomBarMode,
    type ReaderTypographyPreset,
    BOTTOM_BAR_MODE_PRESETS,
    READER_TYPO_PRESETS,
  } from "../reader/reader-settings";
  import {
    FontStore,
    collectHostFontFaces,
    collectHostFontUrls,
    getHostFontStack,
    customFontFaceCss,
    type CustomFont,
  } from "../reader/reader-fonts";
  import {
    buildReaderStyles,
    // 2026-10-07：applyContainerBg 需要它做明暗适配（否则容器与书页颜色分叉）。
    // 此前容器直接用 themeOf().bg = 原始配色，深色模式下书页深、容器白，对撞刺眼。
    deriveStyleOutput,
    getDefaultCjkFontStack,
    buildFontFamilyLists,
    captureSiyuanThemeVars,
    neutralizeBadFontFaces,
  } from "../reader/reader-style";
  // 2026-10-06 竖排标点替换（仅竖排开启时生效，见 openBook 里的 transformTarget 钩子）
  import {
    transformVerticalPunctuation,
    shouldUseHant,
  } from "../reader/vertical-punctuation";
  // 2026-09-01 接口化第一阶段（L0/L3）：思源令牌注入 + 全局主题同步总线
  import { subscribeThemeChange, registerIframe, unregisterIframe } from "../ui/theme-bridge.ts";
  // 2026-09-02 性能修复：跨 frame console 钩子改为「阅读器打开时才观察本容器」，
  // 不再由插件在 document.body 上常驻全局 MutationObserver。
  import { setConsoleFilterRoot } from "../core/console-filter.ts";
  // 2026-08-28 分类字体：EPUB 内联 serif/sans-serif/monospace 关键词 → CSS 变量（Readest 同款）
  import {
    rewriteFontKeywordsInAllContents,
    rewriteFontKeywordsInDocument,
  } from "../reader/reader-font-classify";
  // 2026-08-27 重设计：双语段落注入（顶栏「双语」开关）
  // 2026-08-31：v1（bilingual.ts）已删除，统一走 v2 兄弟节点渲染
  import { type BilingualHandle } from "./bilingual-types";
  import { createBilingualV2 } from "./bilingual-v2/bilingual-v2";
  // 2026-09-05 R5：双语四层架构 —— L2 英文书籍识别（双语前置门槛，纯逻辑可单测）
  import { detectBookLanguage, collectSampleTexts } from "./bilingual/runtime/detector.ts";
  // 2026-09-05 设置统一：目标语言选项与设置弹窗同源（共享常量）
  import { TARGET_LANG_OPTIONS } from "./bilingual-langs";
  import {
    type AiSettings,
  } from "../ai/ai-settings";
  // 2026-08-28：连续朗读控制器（参考 Readest：多引擎 system/youdao/edge + 句子高亮 + 控制条）
  import { ReaderTtsController, DEFAULT_REWORD_TTS, type RewordTtsSettings, type TtsState } from "./reader-tts";
  import { getFileBlob, putFile, removeFile } from "../siyuan/api";
  // 2026-09-09 P1：矩形框选标注默认色
  import { DEFAULT_ANNOTATION_COLOR } from "../annotation/annotation-store.ts";
  // 2026-09-08 启动卡死修复：onMount 自动开书前等空闲窗口（与 restoreSession 同一套闸门）
  import { waitForLaunchIdle } from "./reader-launch.ts";
  // Phase 1：划词即时词典——复用现有离线词典引擎与卡片渲染（与「查词典」Tab 同源）
  import { lookupSmart, searchCandidates } from "../dict/dict-engine";
  import {
    parseDictEntry,
    renderDictCardSimple,
    renderDictSuggestions,
    renderLoading,
  } from "../dict/dict-renderer";
  // 2026-09-07 查词典功能：弹窗双源（🌐 切在线词海）
  import { fetchOnlineDict, renderOnlineDictCardSimple } from "../dict/online-dict";
  import { togglePosCollapsed } from "../dict/pos-toggle";
  // Phase 2：划词高亮 + 批注（阅读器 / foliate 集成）
  // @ts-ignore - foliate-js 为纯 JS vendor（无类型声明）
  import { Overlayer } from "../reader/vendor/foliate-js/overlayer.js";
  import { getAnnotationStore } from "../annotation/store-singleton";
  // 2026-09-04 P1：PDF 自建覆盖层归一化矩形类型
  import type { PdfRect, AnnotationStore } from "../annotation/annotation-store.ts";
  // 2026-09-09 P1.3：矩形框选纯函数（页命中/归一化/markdown 构造），单测直连
  import { collectPageHits, normalizeSelToRect, buildRectMarkdown, dedupeNestedRects, RECT_MIN_PX, type SelRect, type RectMdEntry } from "./pdf-rect-util.ts";
  // 2026-10-06 设置改造：Readest 式弹窗（schema 驱动）
  import SettingsDialog from "./settings/SettingsDialog.svelte";
  import { setByPath } from "./settings/settings-schema.ts";
  import "./settings/settings-dialog.less";
  // 2026-10-08 划词工具栏图标：思源自带 Tabler Icons（MIT）的构建期内联产物。
  //   源与生成方式见 scripts/gen-sel-icons.mjs，头注释解释了为何不能运行时读目录。
  import { SEL_ICONS } from "./sel-icons.generated.ts";
  // 标注/批注区分：isEmptyNoteContent(rec) → 无笔记=纯标注（进编辑工具栏），有笔记=批注（进查看卡片）
  import { classifyAnnotation } from "../annotation/whale-renderer";
  import {
    WHALE_COLORS,
    ANNOTATION_STYLES,
    ANNOTATION_PANEL_STYLES,
    normalizeAnnotationStyle,
    normalizeAnnotationColor,
    isPureHighlight,
    annotationCfis,
    type AnnotationStyle,
    type AnnotationType,
  } from "../annotation/annotation-store.ts";
  import {
    getDefaultAnnotationColor,
    getDefaultAnnotationStyle,
    // 2026-08-30：上次使用样式（微信读书式一键高亮）——点「标注」直接用，跨会话记忆
    getLastAnnotationColor,
    getLastAnnotationStyle,
    setLastAnnotationStyle,
  } from "../annotation/annotation-config.ts";
  // 2026-08-24 根治：视觉层确定性同步（不信任 foliate 删除 API 的"静默失败"，
  // 改为按 key 遍历 overlay 强制移除 + 全量 reconcile）
  import {
    eraseOverlayKey,
    hasOverlayKey,
    missingDrawItems,
    syncVisualWithStore,
    nukeAndRedrawOverlays,
    subscribeAnnotationsChanged,
  } from "./annotation-visual";

  // 2026-10-10：快捷键提示面板。注册表此前只用于「冲突检测」，没有展示入口，
  // 用户无从知道有哪些键可用。getHintGroups 负责按语义分组 + 标注未接线项。
  // 2026-10-10：键盘共用层（matchShortcut + 顶层 hint toggle + 翻页语义分发）
  // 把 onGlobalKey 里的硬编码 if-else 换成「matchShortcut → 分发」单一真源。
  import {
    matchShortcut,
    defaultPageTurn,
    bindGlobalShortcutHint,
    isPageTurnAction,
    getHintPayload,
    getBoundHintToggle,
  } from "./keyboard-shared.ts";
  // 2026-10-10 改造：把内联的 hint 面板 + 配套 CSS 抽到 ./ReaderHint.svelte 复用。
  // BookshelfView 同样用它，避免在两个 .svelte 里维护两套。
  import ReaderHint from "./ReaderHint.svelte";

  // ============================================================
  // [DEBUG] REword 阅读器调试日志模块（Bug 排查专用）
  // ------------------------------------------------------------
  // 用法：DEBUG_READER=true 时输出 [REword-DBG] 前缀的结构化日志；
  //      false 时所有 dbg.* 调用为 no-op（编译期 tree-shake / 运行时零开销）。
  //      在 DevTools Console 用 filter "[REword-DBG]" 即可只看调试流。
  // 设计：Proxy 空函数，DEBUG_READER=false 时任意 dbg.xxx(...) 调用直接跳过，
  //      不触发任何字符串拼接或序列化（避免性能损耗）。
  // ============================================================
  const DEBUG_READER = false;  // 调试开关：true=开启控制台日志+HUD面板；false=静默（dbgHud 数据仍持续收集）
  const dbg = (() => {
    if (!DEBUG_READER) {
      const noop = () => {};
      return new Proxy(noop, { get: () => noop }) as any;
    }
    const ts = () => {
      const d = new Date();
      const p = (n: number, l = 2) => String(n).padStart(l, "0");
      return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
    };
    const fmt = (v: any): string => {
      try {
        if (v === null) return "null";
        if (v === undefined) return "undefined";
        if (typeof v === "object" && v instanceof Element) return `<${v.tagName.toLowerCase()} class="${(v as Element).className}">`;
        if (typeof v === "object") return JSON.stringify(v, null, 0).slice(0, 240);
        if (typeof v === "string") return v.length > 100 ? v.slice(0, 100) + "…" : v;
        return String(v);
      } catch { return "[unserializable]"; }
    };
    const head = (sym: string, tag: string) => `[REword-DBG] ${ts()} ${sym} ${tag}`;
    return {
      event: (tag: string, msg: string, data?: any) => console.log(head("•", tag), msg, data !== undefined ? "→ " + fmt(data) : ""),
      step: (tag: string, msg: string, data?: any) => console.log(head("│", tag), msg, data !== undefined ? "→ " + fmt(data) : ""),
      snapshot: (tag: string, obj: any) => console.log(head("⊞", tag), "snapshot →", fmt(obj)),
      warn: (tag: string, msg: string, data?: any) => console.warn(head("⚠", tag), msg, data !== undefined ? "→ " + fmt(data) : ""),
    };
  })();

  // 2026-10-06 竖排标点：把 HTML 变换挂到 foliate 的书内资源钩子（CSS 那支是 @font-face 中和）。
  // 竖排字形是 BMP 单码位、替换前后文本长度不变 ⇒ 不破坏 CFI 定位与已有标注（详见 vertical-punctuation.ts）。
  // 只做正向替换（多对多映射无法反推原字符）；关闭竖排时不挂本分支即天然保持原样。
  function attachBookTransform(bt: any, punctOn: boolean, punctHant: boolean) {
    if (!bt || bt === lastTransformTarget) return;
    lastTransformTarget = bt;
    bt.addEventListener("data", (ev: any) => {
      const t = ev?.detail?.type;
      if (punctOn && HTML_TYPES.has(t)) {
        ev.detail.data = Promise.resolve(ev.detail.data).then((h: string) =>
          transformVerticalPunctuation(h, punctHant));
        return;
      }
      if (t !== "text/css") return;
      ev.detail.data = Promise.resolve(ev.detail.data).then((css: string) =>
        neutralizeBadFontFaces(css));
    });
  }

  /**
   * 把 foliate 视图挂进 reader 容器（2026-10-06 抽出为模块级，理由见下）。
   *
   * ⚠️ 真机 console 实证的 bug：`container` 是 Svelte 的 `bind:this`，在
   * **「重启后恢复阅读 Tab」路径**下 openBook 可能早于模板绑定完成 ⇒ 为 `undefined`，
   * 而 `container.innerHTML = ""` 会抛
   * `TypeError: Cannot set properties of undefined (setting 'innerHTML')`。
   * 后果远比"少一个图标"重：**该行之后 openBook 全被中断**，包括后面的
   * `applyStyles()` ⇒ **书内样式（字号/行距/图片尺寸…）根本没注入**
   * ⇒ 表现为「排版全都不对」，日志里还缺少 `[开书细步] applyStyles 前` 可自证。
   *
   * ⚠️ 这里**不能 early-return**（会跳过挂载 foliate 视图），只静默降级，
   * 让后续 applyStyles 的 `view?.renderer` 可选链自行兜底。
   *
   * ⚠️ 为什么抽成模块级函数：`openBook` 体量已顶到
   * test/reader-book-excerpts-refresh 的 10000 字符扫描窗口上限（基线 9902），
   * 往里堆代码会让那个断言**假失败**（本轮已踩过一次）。见该测试注释。
   */
  function mountReaderContainer(box: HTMLDivElement | undefined, el: any): void {
    try {
      if (!box) throw new Error("container undefined");
      box.innerHTML = "";
      box.append(el);
      console.log("[REword] openBook reword-foliate-view 已挂载", {
        containerH: box.clientHeight,
        containerW: box.clientWidth,
        viewTag: el.tagName,
      });
    } catch {
      logSwallow(new Error("reader container 尚未绑定（bind:this 时序）"),
        "ReaderView.svelte · mountReaderContainer", "debug");
    }
  }

  export let bookId: string;
  export let store: BookshelfStore;
  // 2026-09-09 P0 设置双分家：reader-tab 按书类型传入 scopeView（book/pdf 各一份设置），接口不变
  export let settingsStore: ReaderSettingsLike;
  export let fontStore: FontStore;
  /** 2026-09-08 启动卡死修复：上次启动未完成初始化时为 true，禁止 onMount 自动开书（断自锁，改手动打开） */
  export let launchCrashed: boolean = false;
  /** 返回书架（未提供时 ‹ 不可用） */
  export let onBack: (() => void) | undefined = undefined;
  /** 独立 Tab 模式：关闭当前 Tab（未提供时 ‹ 退化为 onBack） */
  export let onCloseTab: (() => void) | undefined = undefined;
  /** 2026-10-26 路线 A：移动端全屏浮层模式。
   *  true 时 ‹ 按钮的语义是「返回书架」（关掉阅读层、露出下层书架层），
   *  文案也不再是桌面 Tab 的「关闭阅读（书架在侧边栏）」。 */
  export let mobileOverlay: boolean = false;
  /** 独立 Tab 模式：标题联动（书名 · 章节） */
  export let onTitleChange: ((title: string) => void) | undefined = undefined;
  /** 翻译选中文本并直接发送到 AI 精读面板（委托 plugin.translateToAi） */
  export let onTranslateToAi: ((text: string) => void) | undefined = undefined;
  /** 双语段落批量翻译（委托 plugin.translateBatch，按书缓存 + 引擎链兜底）；
   *  2026-08-30 增加 extra（model/overwrite/signal）以支持整书预翻译细化选项
   *  2026-08-30 修复：ctxBefore（前文参考）+ meta（书籍元数据）透传，供 AI 语境理解与
   *    v1.3.0 专有名词一致性生效；bridge 端 reader-tab.ts 会兜底补 meta（plugin.getBookMeta） */
  export let onTranslateBatch:
    | ((
        texts: string[],
        from: string,
        to: string,
        ctxBefore?: (string | null)[],
        meta?: { title?: string; author?: string; language?: string; toc?: string } | null,
        extra?: any
      ) => Promise<string[]>)
    | undefined = undefined;
  /** 批量查询缓存命中（委托 plugin.checkTranslationCacheHits），供预翻译弹窗精确计算待译数 */
  export let onCheckCache: ((texts: string[]) => Promise<boolean[]>) | undefined = undefined;
  /** 2026-08-30 详细翻译（回传 provider/fromCache），供成本与引擎统计；未提供时回落 onTranslateBatch
   *  2026-08-30 修复：ctxBefore/meta 透传（语义同 onTranslateBatch） */
  export let onTranslateBatchDetailed:
    | ((
        texts: string[],
        from: string,
        to: string,
        ctxBefore?: (string | null)[],
        meta?: { title?: string; author?: string; language?: string; toc?: string } | null,
        extra?: any
      ) => Promise<{ texts: string[]; providers: (string | null)[]; fromCache: boolean[] }>)
    | undefined = undefined;
  /** 是否已配置任一翻译引擎（用于双语开关前置提示） */
  export let isTranslationConfigured: (() => boolean) | undefined = undefined;
  /** 获取当前 AI 设置快照（用于预翻译弹窗判断可用引擎/模型） */
  export let getAiSettings: (() => AiSettings | null) | undefined = undefined;
  /** 保存腾讯翻译用量锁（单位：字符） */
  export let onSaveTencentLock: ((chars: number) => Promise<void> | void) | undefined = undefined;
  /** 2026-08-31：双语设置独立弹窗增量保存 AI 设置（翻译风格/提示词/引擎/参数） */
  export let onSaveAiSettings: ((partial: Partial<AiSettings>) => Promise<void> | void) | undefined = undefined;
  /** 加入词库（委托 plugin vocabStore.addWord） */
  export let onAddToVocab: ((word: string) => Promise<void> | void) | undefined = undefined;
  /** 在 REword 侧边栏查词（委托 plugin.openWordInSidebar → 跨插件调 REword：切到查词 Tab、自动填词查询；mode 同步小窗当前词典源） */
  export let onOpenInSidebar: ((word: string, mode?: "offline" | "online") => void) | undefined = undefined;
  /** 移出词库（委托 plugin vocabStore.removeWord） */
  export let onRemoveFromVocab: ((word: string) => Promise<void> | void) | undefined = undefined;
  /** 判断单词是否在词库（委托 plugin vocabStore.hasWord） */
  export let isInVocab: ((word: string) => boolean) | undefined = undefined;
  /**
   * 钉住阅读 Tab（调用 `tab.pin()`）。
   *
   * ⚠️ 2026-10-08 起**已无调用方** —— 原先在 `onNoteSave` 的两个分支里调用，
   * 导致用户每保存一条批注，正在读的书页签就缩成图标且关不掉（真机报障「莫名其妙的固定住了」）。
   * 完整原因见 `onNoteSave` 内的注释。
   *
   * prop 与实现（`reader-tab.ts` 的 onProtectTab）**特意保留**：
   * 万一将来真需要「确保阅读 Tab 不被回收」，重新接上即可，不必重新查思源的 API 语义。
   */
  export let onProtectTab: (() => void) | undefined = undefined;
  /** 标签解析（委托插件 LabelStore）：用于阅读批注查看气泡展示标签名/色 */
  export let getLabel: ((id: string) => { name: string; color: string } | null) | undefined = undefined;
  /** 本书前提上下文存储（v1.3.0：plugin.bookPrimer，BookPrimerStore 实例；缺省隐藏编辑区） */
  export let primerStore: any = undefined;
  /** 本书累计 token 用量读取（v1.3.0：委托 plugin.getBookTokenUsage） */
  export let getTokenUsage: ((bid: string) => { total: number; prompt: number; completion: number }) | undefined = undefined;
  /** 重置本书累计 token（v1.3.0：委托 plugin.resetBookTokenUsage） */
  export let resetTokenUsage: ((bid: string) => Promise<void> | void) | undefined = undefined;
  /** 最近一次翻译 token 用量（v1.3.0：委托 plugin.lastTranslationUsage；修复原裸 plugin 引用未定义的 bug） */
  export let getLastUsage: (() => { promptTokens: number; completionTokens: number; totalTokens: number } | null) | undefined = undefined;
  // 2026-08-28：翻译缓存统计 / 清空（按书；由 reader-tab 透传 plugin 能力）
  export let getTranslationCacheStats: ((bid: string) => Promise<{ count: number; cachedPages: number; pageRangeText: string; title: string }>) | undefined = undefined;
  export let clearTranslationCache: ((bid: string) => Promise<void> | void) | undefined = undefined;
  // 2026-08-28：翻译成功入缓存后回传「节」序号（1-based）+ 书名，供 UI「第 X-Y 页缓存成功」+「选择书籍」
  export let recordCachedSections: ((bid: string, sections: number[], title?: string) => void) | undefined = undefined;
  // 2026-08-28：列出所有有翻译缓存的书籍（bookId + 书名），供「选择书籍」下拉
  export let listCachedBooks: (() => Promise<Array<{ bookId: string; title: string }>>) | undefined = undefined;
  // 2026-08-30：清理「孤儿」翻译缓存（书架已删除书籍对应的缓存文件），返回清理数量
  export let cleanOrphanCaches: (() => Promise<number>) | undefined = undefined;
  // 2026-08-28：连续朗读设置（get 读 / save 写，结构 = RewordTtsSettings）
  export let getTtsSettings: (() => RewordTtsSettings | null) | undefined = undefined;
  export let saveTtsSettings: ((s: RewordTtsSettings) => Promise<void> | void) | undefined = undefined;

  // 划词工具栏图标（readest 风格线性 SVG）。
  //
  // 2026-10-08：已从「手绘内联path」换成**思源自带 Tabler Icons**（MIT 许可），
  // 由 `scripts/gen-sel-icons.mjs` 构建期抽取内联 —— 见 sel-icons.generated.ts 的头注释。
  //
  // ## 为什么内联而不是运行时读思源的 icons 目录
  // ① 插件跑在 iframe/renderer 进程，**读不到文件系统**（本项目源码内 `fs` 引用为 0处）；
  // ② 插件会**打包分发到别的机器**，不能依赖思源工作空间的私有目录。
  //
  // ## key 名不可改
  // 模板里按 `SEL_ICONS.copy` / `.highlight` / `.annotate` / `.dict` /
  //   `.search` / `.translate` / `.tts` / `.send` / `.trash` 引用。
  //
  // 🔖 其中 `dict` 刻意用**书本**（book-open）而非放大镜：
  //   Tabler 的 `search.svg` 也是纯放大镜，而「词典=查解释 / 搜索=找全书出现处」
  //   这组区分在 16px 下靠「只差一点」根本分不出来
  //   （2026-10-08 已踩过一次：现有代码特意把 dict/search 做成两个样子）。

  let container: HTMLDivElement;  // foliate-view 容器（line 1485）
  let readerViewEl: HTMLDivElement;  // 2026-08-23 新增：.reader-view 容器 ref（用于浮层 offset 与全局 mousedown 监听）
  let readerStageEl: HTMLDivElement;  // 2026-08-25 新增：.reader-stage 内容区 ref（浮层上下避让判定改用内容区坐标系，避免工具栏贴顶导航栏/越界）
  let view: any = null;
  // 2026-09-02：记录已挂接过 @font-face 中和监听的 transformTarget，避免重复注册
  let lastTransformTarget: any = null;
  // 2026-10-06 竖排标点替换：钩子闭包里直接读这两项，故用响应式派生保持实时性。
  // 开关口径：竖排开启 且 用户允许替换标点（verticalPunctuation 默认 true）。
  $: verticalPunctActive = settings.verticalWriting === true && settings.verticalPunctuation !== false;
  // 繁体映射判定：书籍语言（OPF dc:language）优先，其次界面语言；
  // 都取不到时按简体处理（简体映射覆盖面更广，误判代价更小）。
  $: verticalPunctHant = shouldUseHant(
    (store as any)?.get?.(bookId)?.language,
    typeof window !== "undefined" ? (window as any).siyuan?.config?.lang : undefined,
  );
  // 2026-08-28：连续朗读控制器状态
  let ttsController: ReaderTtsController | null = null;
  let ttsState: TtsState = "idle";
  let ttsProgress = { index: 0, total: 0 };
  let ttsCurrentText = "";
  let ttsRate = DEFAULT_REWORD_TTS.rate;
  let showTtsBar = false;
  // 选区朗读时记录起始 range，供 playFrom 使用
  let ttsSelRange: Range | null = null;
  // 句子高亮开关（与设置同步，控制条按钮高亮态）
  let ttsHighlightOn = DEFAULT_REWORD_TTS.enableHighlight;
  // 朗读设置本地副本（打开设置面板时从 getTtsSettings 同步，修改即写回）
  let ttsCfg: RewordTtsSettings = { ...DEFAULT_REWORD_TTS };
  // 本机可用嗓音列表（供「中文/英文嗓音」下拉选择）；打开设置面板时刷新
  let ttsVoices: { uri: string; name: string; lang: string }[] = [];
  let ttsVoiceListenerBound = false;
  // 控制条语速滑块防抖持久化定时器（拖动时实时生效，停止后落盘）
  let rateSaveTimer: ReturnType<typeof setTimeout> | null = null;
  function loadTtsVoices() {
    try {
      const synth =
        typeof window !== "undefined" && "speechSynthesis" in window
          ? window.speechSynthesis
          : null;
      if (!synth) return;
      const map = () => {
        ttsVoices = (synth.getVoices?.() || []).map((v: SpeechSynthesisVoice) => ({
          uri: v.voiceURI, name: v.name, lang: v.lang,
        }));
      };
      map();
      // 用 addEventListener 而非 onvoiceschanged，避免覆盖 SystemBackend 的预热监听
      if (!ttsVoiceListenerBound) {
        ttsVoiceListenerBound = true;
        try { synth.addEventListener("voiceschanged", map); } catch { /* 忽略 */ }
      }
    } catch { /* 忽略 */ }
  }
  // 2026-08-27 重设计：双语对照状态与注入句柄
  let bilingualOn = false;
  let bilingualHandle: BilingualHandle | null = null;
  /** 2026-08-31：已隐藏译文段落的指纹集合（segHash），按本书维护，关闭/重开双语后保持隐藏 */
  let bilingualHidden = new Set<string>();
  let bilingualProgress = { done: 0, total: 0, active: false };
  let bilingualInitDone = false; // 设置恢复只执行一次
  // 2026-09-05 F3：持久化 bilingual=true 的恢复挂起标记——等书籍内容加载后再跑语言判定，
  // 堵住「onMount 时 view 未就绪 → 判定 unknown → 绕过英语门槛」的绕行路径
  let bilingualPendingRestore = false;
  // 2026-08-28：最近一次双语翻译的 AI token 用量（null = 无数据 / 未走 AI）
  let bilingualTokenUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | null = null;
  // ========== 2026-08-26 调试 HUD：高亮渲染链路诊断（foliate 原生管线） ==========
  // 退回 foliate 原生：view.addAnnotation + draw-annotation 事件 + Overlayer 静态方法。
  // 不再自建 SVG 层（rewordOverlays / rewordHighlights 已移除）。
  const dbgHud = {
    // v3 上游链路
    setupCalled: false,    // setupAnnotationLayer 是否被调用
    annStoreReady: false,  // setup 时 annStore 是否可用
    bookIdAtSetup: "",     // setup 时 bookId 值
    annotCountInStore: 0,  // 该书存储中的批注数量
    totalInStore: -1,      // store 总批注数
    storeBookIds: "",      // store 中所有 bookId 列表
    bookIdMatch: false,    // 当前 bookId 是否在 store 中存在
    // foliate 原生管线计数
    createOverlayCalls: 0, // onCreateOverlay（create-overlay 事件）被调用次数
    addAnnotationTries: 0, // addReaderAnnotation 调用次数
    addAnnotationErrors: 0,// addReaderAnnotation 失败次数
    drawnCount: 0,         // onDrawAnnotation 实际绘制次数
    relocateCalls: 0,      // onRelocate 被调用次数
    ovr_evtIndex: -1,      // create-overlay 事件的 detail.index
    lastDraw: "",          // 最近一次绘制详情
  };

  let meta: BookMeta | undefined;
  /** [REword 2026-09-02] 当前界面模式：随 meta.format 自动切换，图书与 PDF 各用一套控件 */
  $: readerMode = resolveReaderMode(meta?.format) as ReaderMode;
  // 当前书籍能力（text/selection/reflow）；meta 未就绪时按未知格式回落（全能力，等书打开再收敛）。
  $: caps = resolveCapabilities(meta?.format || "");
  let title = "";
  let chapterLabel = "";
  let bookAuthor = "";
  let progressText = "";
  let progress = 0;
  let totalSections = 0;
  let opened = false;
  let errorMsg = "";
  let showToc = false;
  let showSettings = false;
  // 2026-09-02 目录抽屉打开时自动滚到当前章节（对齐微信读书）。
  // 只在「关闭→打开」跳变时触发一次，避免抽屉常开时反复打断用户手动滚动。
  // ⚠️ 2026-10-15：这条此前是**死代码** —— `tocListEl` 从未 `bind:this`，
  // `if (!list) return` 恒早退，打开目录从不滚动（滚动容器是 popover 本体，
  // 不是 `.reader-toc-list`，见下方 CSS 的 overflow）。现在 bind 到 .reader-popover.reader-toc。
  // 打开前先展开当前章的祖先链（折叠态可能把当前章藏在收起的子树里）。
  let tocListEl: HTMLDivElement | null = null;
  let tocWasOpen = false;
  $: if (showToc && !tocWasOpen) {
    tocWasOpen = true;
    expandTocAncestors();
    void tick().then(scrollTocToActive);
  } else if (!showToc && tocWasOpen) {
    tocWasOpen = false;
  }
  function scrollTocToActive(): void {
    const list = tocListEl;
    if (!list) return;
    const active = list.querySelector<HTMLElement>(".reader-toc-active");
    if (!active) return;
    const target =
      active.getBoundingClientRect().top -
        list.getBoundingClientRect().top +
        list.scrollTop -
        (list.clientHeight / 2 - active.offsetHeight / 2);
    list.scrollTo({ top: target, behavior: "smooth" });
  }

  /* ================= 图片查看器（lightbox，2026-10-15 P0） =================
   * 方案：docs/目录折叠虚拟化与图片查看器-设计方案.md §2.3。三条硬约束决定了实现形状：
   *  ① EPUB 图片 URL 是**宿主**造的 blob（`vendor/foliate-js/epub.js:886 createURL`），
   *    内容 iframe 的 sandbox 带 allow-same-origin ⇒ 直接拿 `img.src` 复用，不搬字节；
   *  ② foliate 引用计数归零即 `URL.revokeObjectURL`（`epub.js:930-938`）⇒ 换 section 后
   *    旧 src 会失效，所以 relocate 必须**关掉**灯箱（不是隐藏）。灯箱是模态的
   *    （fixed inset 0 盖满视口），正常路径开着它翻不了页，这条是兜底；
   *  ③ 图片的 transform 承担 pan/zoom ⇒ 容器动画只能做 opacity（与本仓浮层约定一致）。
   * 门控走能力真源 `caps.reflow`：PDF/漫画是 pre-paginated，已有整页缩放，不点亮灯箱。
   */
  const IMGV_MIN_SCALE = 0.25;
  const IMGV_MAX_SCALE = 8;
  const IMGV_STEP = 1.2; // 按钮档：×1.2 / ÷1.2（对齐 Readest）
  // 行内装饰图（1em 项目符号那类，2026-10-06 实测过的写法）不该被点开，按显示尺寸卡一道
  const IMGV_MIN_PX = 48;
  let imgView: { open: boolean; src: string } = { open: false, src: "" };
  let imgViewScale = 1;
  let imgViewPanX = 0;
  let imgViewPanY = 0;
  let imgViewImgEl: HTMLImageElement | null = null;
  let imgViewCloseEl: HTMLButtonElement | null = null;
  let imgViewDrag: { id: number; startX: number; startY: number; baseX: number; baseY: number } | null = null;

  function openImageViewer(src: string): void {
    if (!src) return;
    imgViewScale = 1;
    imgViewPanX = 0;
    imgViewPanY = 0;
    imgViewDrag = null;
    imgView = { open: true, src };
    // a11y：焦点落到「关闭」钮（Esc 本就有全局监听，这一步只是把焦点从 iframe 里那张图移出来）。
    // 关闭后不做焦点归还：打开前焦点在内容 iframe 内，宿主无从恢复，留在 body 不影响翻页快捷键。
    void tick().then(() => imgViewCloseEl?.focus?.());
  }

  function closeImageViewer(): void {
    if (!imgView.open) return;
    imgViewDrag = null;
    imgViewScale = 1;
    imgViewPanX = 0;
    imgViewPanY = 0;
    imgView = { open: false, src: "" };
  }

  function resetImageViewer(): void {
    imgViewScale = 1;
    imgViewPanX = 0;
    imgViewPanY = 0;
  }

  /**
   * 以视口坐标点 (px,py) 为原点缩放到 nextScale。
   * 关系式（transform 为 `translate(t) scale(s)`，缩放原点是图片自身中心 C）：
   *   视口点 V = C + t + s·u（u = 图内偏移）⇒ 保持 (px,py) 处的 u 不动，得
   *   t' = (P - C)(1 - k) + t·k，k = s'/s。
   * 不传 (px,py) = 围绕图片自身中心，t 不变（按钮档走这条）。
   * C 从**变换后**的 rect 反推：rect 中心 = C + t ⇒ C = rectCenter - t。
   */
  function zoomImageViewer(nextScale: number, px?: number, py?: number): void {
    const s = clamp(nextScale, IMGV_MIN_SCALE, IMGV_MAX_SCALE);
    if (s === imgViewScale) return;
    const el = imgViewImgEl;
    if (el && px != null && py != null) {
      const k = s / imgViewScale;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2 - imgViewPanX;
      const cy = r.top + r.height / 2 - imgViewPanY;
      imgViewPanX = (px - cx) * (1 - k) + imgViewPanX * k;
      imgViewPanY = (py - cy) * (1 - k) + imgViewPanY * k;
    }
    imgViewScale = s;
    clampImageViewerPan();
  }

  /**
   * 轻夹紧（拍板点③）：某一轴上图没超过视口 ⇒ 该轴归位（回到居中），
   * 超过了 ⇒ 允许拖到边界再留 32px 余量，既防「把图拖丢了」又不生硬。
   * offsetWidth/Height 是**未变换**的布局尺寸（不受 transform 影响），正好是 fit 盒。
   */
  function clampImageViewerPan(): void {
    const el = imgViewImgEl;
    if (!el) return;
    const slack = 32;
    const ex = el.offsetWidth * imgViewScale - window.innerWidth;
    const ey = el.offsetHeight * imgViewScale - window.innerHeight;
    imgViewPanX = ex <= 0 ? 0 : clamp(imgViewPanX, -(ex / 2 + slack), ex / 2 + slack);
    imgViewPanY = ey <= 0 ? 0 : clamp(imgViewPanY, -(ey / 2 + slack), ey / 2 + slack);
  }

  /** Ctrl/⌘ + 滚轮 = 围绕指针缩放（触控板双指捏合在 Chromium 就是这个事件）。 */
  function onImageViewerWheel(e: WheelEvent): void {
    // 灯箱盖满视口，背后不该跟着滚
    e.preventDefault();
    if (!e.ctrlKey && !e.metaKey) return; // P0 不做无修饰滚轮平移
    zoomImageViewer(imgViewScale * Math.exp(-e.deltaY * 0.002), e.clientX, e.clientY);
  }

  /** 双击 = 适应 ↔ 原始像素（Readest 的 pixelPerfectScale 口径：1:1 倍率 = naturalWidth / fit 宽）。 */
  function onImageViewerDblClick(e: MouseEvent): void {
    const el = imgViewImgEl;
    if (!el) return;
    const atFit = Math.abs(imgViewScale - 1) < 0.001;
    const one = clamp((el.naturalWidth || el.offsetWidth) / (el.offsetWidth || 1), IMGV_MIN_SCALE, IMGV_MAX_SCALE);
    zoomImageViewer(atFit ? one : 1, e.clientX, e.clientY);
  }

  function onImageViewerPointerDown(e: PointerEvent): void {
    if (e.button !== 0 || imgViewScale <= 1) return; // 只有放大后才需要平移
    imgViewDrag = { id: e.pointerId, startX: e.clientX, startY: e.clientY, baseX: imgViewPanX, baseY: imgViewPanY };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch (__swallowErr) {
      logSwallow(__swallowErr, "ReaderView.svelte · imgv setPointerCapture", "debug");
    }
  }

  function onImageViewerPointerMove(e: PointerEvent): void {
    const d = imgViewDrag;
    if (!d || d.id !== e.pointerId) return;
    imgViewPanX = d.baseX + (e.clientX - d.startX);
    imgViewPanY = d.baseY + (e.clientY - d.startY);
    clampImageViewerPan();
  }

  function onImageViewerPointerUp(e: PointerEvent): void {
    if (!imgViewDrag || imgViewDrag.id !== e.pointerId) return;
    imgViewDrag = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch (__swallowErr) {
      logSwallow(__swallowErr, "ReaderView.svelte · imgv releasePointerCapture", "debug");
    }
  }

  /** 只有点到遮罩本体才关闭：点图/拖图收尾的 click target 是 img ⇒ 不误关。 */
  function onImageViewerRootClick(e: MouseEvent): void {
    if (e.target !== e.currentTarget) return;
    closeImageViewer();
  }

  /**
   * 内容文档里的点击 → 判断是否「可放大的正文图」，是则开灯箱。
   * 五个条件缺一不可（方案 §2.3）：能力门控 / 命中 img / 不被 <a> 包（脚注与内链语义优先，
   * foliate 的 link 事件要拿到 <a>）/ 选区已折叠（拖选收尾的 click 不弹灯箱）/ 尺寸阈值。
   */
  function onContentImageClick(e: Event): void {
    if (!caps.reflow || imgView.open) return;
    const target = e.target as Element | null;
    if (!target || typeof target.closest !== "function") return;
    const img = target.closest("img") as HTMLImageElement | null;
    if (!img) return;
    if (target.closest("a")) return;
    const sel = (img.ownerDocument ?? document).getSelection?.();
    if (sel && !sel.isCollapsed) return;
    if (img.offsetWidth < IMGV_MIN_PX || img.offsetHeight < IMGV_MIN_PX) return;
    openImageViewer(img.src);
  }
  // 2026-10-14 双语重设计：设置弹窗打开时聚焦的目标 Tab（null=沿用上次/默认）。
  // 顶栏「双语设置」入口用它直达新的「双语翻译」Tab，取代已下线的独立双语设置弹窗。
  let settingsInitialTab: string | null = null;
  /**
   * 词典管理器实例（由插件入口挂在 window 上，此处读取并注入设置弹窗）。
   * ⚠️ 模板里不能写 TS 类型断言（`(window as any).x` 会 ParseError），
   *    故用 script 里的派生变量承接，再以 `{dictManagerRef}` 简写传入。
   * 2026-10-07 第 3 批：词典管理改为设置弹窗内二级页后，这里不再需要
   *    额外的 showDictManager 状态（旧方案要另开一个弹窗）。
   */
  $: dictManagerRef = (window as any)?.__rewordDictManager ?? null;
  /**
   * 翻译宿主实例（由插件入口挂在 window 上，此处读取并注入设置弹窗）。
   * 2026-10-07：接通翻译链路时新增——「翻译引擎配置」二级页要经它
   * 读设置 / 存设置 / 测连通性。与词典同一套路。
   */
  $: translateHostRef = (window as any)?.__rewordTranslateHost ?? null;
  /**
   * 思源 API（2026-10-08 新增，供「选择导出文档」二级页用）。
   *
   * ## 为什么动态 import 而不读 window 上的实例
   * window 上只挂了 `__rewordBridge`（批注数据桥）、`__rewordDictManager`、
   * `__rewordTranslateHost` —— **没有挂思源 API 本身**。
   * 而 `src/siyuan/api.ts` 是我们自己的封装（内部走 fetchSyncPost），
   * 直接 import 即可，不需要额外在 window 上开一个口子。
   *
   * 用响应式 + 惰性 import：只有真正打开文档选择页时才加载，
   * 避免为「可能永远不用的功能」在阅读器启动路径上增加开销。
   */
  let siyuanApiForPicker: any = null;
  let siyuanApiLoadTried = false;
  $: if (!siyuanApiLoadTried) {
    siyuanApiLoadTried = true;
    // 2026-10-09 改用 loadDocPickerApi()（见 settings/doc-picker-api.ts 的注释）。
    // 改造前这里是 `import("../siyuan/api.ts").catch(debug 日志)`，有两个叠加缺陷：
    //  ① 整个 api.ts（60+ 函数、顶层依赖思源运行时模块）都被拖进来，耦合面过大；
    //  ② **失败原因被 debug 日志吞掉** ⇒ UI 只能显示「未接入思源 API」，
    //     而那句提示是误导的（不是"没写"，是"没加载出来"）。
    // 新 loader 只挂 4~7 个函数，并把失败原因交给 UI 展示。
    loadDocPickerApi().then((m) => (siyuanApiForPicker = m));
  }
  let showSearch = false;
  /** 快捷键提示面板（2026-10-10 新增，按 `?` 唤出/ 再次按下收起） */
  let showShortcutHint = false;
  /**
   * 面板数据（分组 + 平台化键位）。
   *
   * 平台判定用 `navigator.platform` 的老写法而非 userAgentData：
   * 后者在 Electron 里不一定存在，且本项目只需区分「要不要显示 ⌘」。
   * 判定失败一律按 Windows 显示 Ctrl（更通用，不会显示按不出来的 ⌘）。
   */
  $: shortcutHintGroups = getHintPayload(null, isMacPlatform());
  $: shortcutMac = isMacPlatform();

  function isMacPlatform(): boolean {
    try {
      const p = (typeof navigator !== "undefined" ? navigator.platform : "") || "";
      return /mac|iphone|ipad|ipod/i.test(p);
    } catch (__e) {
      return false;
    }
  }
  // 脚注气泡（点击脚注直接展示内容，不跳转）
  let showFootnote = false;
  // 2026-08-29 Phase 1：工具栏可见性（移动端中心点击切换，Readest 式沉浸阅读）
  // ⚠️ 2026-10-08 起**仅在「顶栏悬浮」关闭时**才有意义（topBarFloating=false 的旧行为）。
  //   悬浮模式下顶栏的显隐改由下面三个 topBar* 变量控制。
  let toolbarVisible = true;
  /* 2026-10-08 顶栏浮层化（对标底栏的「纯浮层 + 圆点 + 纯点击」范式）
   *  ·顶栏脱离文档流（position:absolute），浮在正文上方，**不参与分页器几何**
   *    ⇒ 收起/展开是纯 transform/opacity，**正文一个字都不动、不重排、不跳页**。
   *    （这是相对 Readest 双档边距方案的关键取舍 —— 那套会让每次点圆点都重排，
   *      正是 2026-10-07 底栏那轮用户亲自否决的「动态占位」。）
   *  · 收起态在顶部中央留一个小圆点（`.reader-top-handle`），点一下浮起、再点收回。
   *  · **纯点击，无 hover 触发区** —— 同底栏：用户明确否决过「鼠标靠近就自动弹出」。
   *  · 显隐不落盘：每次打开书默认收起。
   */
  let topBarPinned = false;       // 点击圆点 → 浮起 / 收回（唯一的主动作）
  let topBarBarHover = false;     // 鼠标位于已展开的栏内（维持显示，否则栏内按钮点不到）
  let topBarRevealed = false;     // 派生：当前是否显现
  /** 顶栏 DOM（浮层模式下用于算底沿，供划词工具栏避让） */
  let topBarEl: HTMLElement | null = null;
  let footnoteHTML = "";
  let footnoteType = t("脚注");
  let footnoteEl: HTMLElement;
  // 2026-08-27 晚（P2.1）：脚注「悬停预览」——在点击之外补充 hover 触发
  let footnoteHoverTimer: any = null;
  let footnoteHoverAnchor: any = null; // 当前 hover 触发锚点（<a>），用于去重/收起判定
  let footnotePinned = false;          // 点击锁定的气泡（hover 移开不自动收起，点空白才关）
  let footnoteLoading = false;         // 抽取中占位（点击/悬停后给即时反馈，避免以为无反应）
  let footnoteReqToken = 0;            // 异步竞态守卫：快速划过多个脚注时丢弃过期请求
  /**
   * 当前气泡对应脚注的导航目标（2026-10-09 新增，支撑「↗ 跳转」按钮）。
   *
   * 🔴 之前 `extractFootnote` 内部已经通过 `book.resolveHref(href)` 拿到了
   *   章节索引，但没有往外传 ⇒ 气泡只能显示内容，无法带用户去脚注原文那页。
   *   数据一直是现成的，只是没暴露出来。
   *
   * null = 当前气泡没有有效目标（同章内联脚注 / 抽取失败）⇒ 按钮不渲染，
   * 不用 disabled 灰按钮占位（灰按钮会让人以为功能坏了）。
   */
  let footnoteTarget: { index: number; anchor?: any } | null = null;
  /**
   * 2026-10-26：抽取成功时的完整解析 href（见 FootnoteResult.resolvedHref）。
   * 「↗ 跳转」改走 view.goTo(字符串)——目录同一条正路；null = 走旧 {index,anchor} 兜底。
   */
  let footnoteResolvedHref: string | null = null;

  /**
   * 2026-10-26 缺陷 A 修复：裸 `#hash` 对所在章节解析成全径。
   * 悬停路径此前传 `el.getAttribute("href")`（形如 `#footnote-6-177`），
   * epub.js 的 resolveHref 按 `#` 切完取到空路径 → getItemByHref("") → null
   * → 同章内联脚注的书（《打造第二大脑》全书皆此形态）悬停弹气泡必然失败。
   * 点击路径的 href 已由 view-light 解析过，startsWith("#") 守卫保证幂等。
   */
  function resolveFootnoteHref(a: any, href: string): string {
    if (!href || !href.startsWith("#")) return href;
    try {
      const contents: any[] = view?.renderer?.getContents?.() ?? [];
      const hit = contents.find((c) => c.doc === a.ownerDocument);
      if (hit?.index != null) {
        const full = view?.book?.sections?.[hit.index]?.resolveHref?.(href);
        if (typeof full === "string") return full;
      }
    } catch (e) {
      logSwallow(e, "ReaderView.svelte · resolveFootnoteHref", "debug");
    }
    return href;
  }
  // 思源主题跟随（auto 模式）
  let siyuanThemeMode: "light" | "dark" = "light";
  let themeChangeUnsub: (() => void) | null = null;
  let visibilityObserver: IntersectionObserver | null = null; // 页签可见性观察器：隐藏→显示时触发高亮重绘
  let annotationsDirty = true; // 标记「需要补绘批注高亮」；由 relocate（内容就绪）或兜底定时器清掉
  let tocItems: { title: string; href: string; level: number }[] = [];
  // [2026-09-01] Phase 1:PDF 专用(目录同样形态,工具栏「第 N/T 页」用)
  let pdfTotalPages = 0;
  let pdfCurrentPage = 0;
  let activeHref = "";
  /**
   * 目录折叠状态（2026-10-15，方案见 docs/目录折叠虚拟化与图片查看器-设计方案.md）
   *
   * 存的是**已收起的父节点 id**（id = 平坦数组下标），默认空集 = 全展开 =
   * 与改造前观感逐帧一致，零迁移。生命周期 = 组件（换书时重置，见 openBook）。
   *
   * `tocItems`（平坦）仍是唯一真源：进度刻度、页眉章节名、已读统计、导出、
   * 双语 prompt、goToc 六个消费方一律照旧，树只服务于这块渲染。
   */
  let tocCollapsed = new Set<number>();
  $: tocTree = buildTocTree(tocItems);
  $: tocVisibleRows = visibleRows(tocTree, tocCollapsed);

  /** 点 caret：切换该节点子树的展开态。必须 stopPropagation，否则同时触发跳转。 */
  function toggleTocNode(id: number): void {
    // Svelte 不跟踪 Set 的 add/delete ⇒ 必须整体重建才生效（本仓既有做法，见 visitedHrefs）
    const next = new Set(tocCollapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    tocCollapsed = next;
  }

  /**
   * 打开目录时把当前章的祖先链全部展开 ⇒「打开即见当前章」不会因为
   * 上层被收起而失效（配合 scrollTocToActive）。
   * 这里重建树而不是复用 `$: tocTree`：派生语句在本响应式语句**之后**才计算，
   * 同一轮更新里读到的是上一轮的值；重建一次 O(n) 成本可忽略，换来确定性。
   */
  function expandTocAncestors(): void {
    const id = tocIndexByHref(tocItems, activeHref);
    if (id < 0 || tocCollapsed.size === 0) return;
    const ids = ancestorIdsOf(buildTocTree(tocItems), id);
    if (!ids.some((a) => tocCollapsed.has(a))) return;
    const next = new Set(tocCollapsed);
    for (const a of ids) next.delete(a);
    tocCollapsed = next;
  }
  /**
   * 目录「已读 N/M」的访问集（2026-10-09 起**持久化**）
   *
   * ## 为什么之前是假的
   *
   * 此前 `visitedHrefs` 只累加在内存里，`savePayload` 只存 cfi/fraction/zoom/page
   * ⇒ 关掉标签页就归零，重开永远是 0/N。
   * 而同一抽屉里书签、摘录都走 store 持久化，只有这个计数是假的
   * —— 一个「看起来像阅读进度统计」的数字，实际毫无价值，比没有更糟。
   *
   * ## 存储形态
   *
   * 落盘用 `string[]`（JSON 友好），运行时用 `Set` 还原去重查询。
   * 见 `ReadingProgress.visitedHrefs`。
   */
  let visitedHrefs = new Set<string>();
  /**
   * 落盘条数上限。
   *
   * 🔴 为什么需要上限：EPUB 的 href 可能很长（如 `OEBPS/Part03/chapter12.xhtml#p42`），
   * 大书数百章全量落盘会让 `progress` 体积膨胀，而它每次 relocate 都随
   * `saveProgress` 整体写盘（600ms 防抖），过大会拖慢写盘。
   *
   * 取 2000：足够覆盖绝大多数书（单章平均 40 字符 ≈ 80KB 封顶），
   * 超出的部分**丢弃最旧的**（FIFO）—— 已读的旧章节对「当前进度」参考价值最低。
   */
  const VISITED_MAX = 2000;
  let tocReadCount = 0;

  /**
   * 把访问集序列化为落盘数组（2026-10-09）
   *
   * 超`VISITED_MAX` 时丢**最旧的**（Set 保持插入序 ⇒ 直接取前 N个即最旧）。
   * 依据：已读的旧章节对「当前阅读位置」的参考价值最低，而新章节才刚开始读。
   */
  function serializeVisited(): string[] {
    const arr = Array.from(visitedHrefs);
    return arr.length > VISITED_MAX ? arr.slice(arr.length - VISITED_MAX) : arr;
  }

  /**
   * 从落盘数据恢复访问集（2026-10-09）
   *
   *⚠️ 三道防御，缺一个都可能让整个阅读器白屏：
   *  ① `Array.isArray` —— 老数据没有这个字段（undefined），不是数组就当空；
   *  ② 逐项 `typeof === "string"` —— 手改过的设置档可能塞进非字符串；
   *  ③ try/catch 包裹 —— 这是恢复路径，抛错会中断 openBook后续流程。
   */
  function restoreVisited(list: unknown): void {
    try {
      if (!Array.isArray(list)) return;
      const set = new Set<string>();
      for (const h of list) if (typeof h === "string" && h) set.add(h);
      visitedHrefs = set;
      tocReadCount = set.size;
    } catch (__swallowErr) {
      logSwallow(__swallowErr, "ReaderView.svelte · restoreVisited", "debug");
    }
  }
  /* 2026-08-30 底部进度条 · 默认完全隐藏（不占阅读高度、不挡文字）
   2026-10-07 改造为**纯点击**：去掉底部 38px 鼠标热区自动弹出。
     · pinned   —— 点击把手后「浮起」，再点一次收回（唯一的主动作）
     · barHover —— 鼠标在**已展开的栏内**（维持显示，否则栏内按钮无法点击）
   hover 靠近即弹的机制已移除：阅读时频繁误触发，且用户对「何时出现」没有预期感。*/
  let bottomBarPinned = false;       // 点击把手 → 浮起 / 收回
  let bottomBarBarHover = false;     // 鼠标位于已展开的进度条自身上（维持显现）
  let bottomBarRevealed = false;     // 派生：当前是否显现
  /* 2026-08-29 UI 全面优化 · 读者外框：进度条章节标记 */
  let chapterMarks: { left: number; title: string }[] = []; // 章节起始位置（0–100）
  /* ---- 2026-08-29 新增：书签 + 摘录汇总抽屉（对齐 Obsidian weave 的摘录沉淀链） ---- */
  /**
   * 2026-09-03「半分半合」改造：目录单列（☰），书签 + 摘录合并为「我的标记」抽屉（📝）。
   * 两个子列表（书签 / 摘录）共用一个抽屉，渲染时各自按 bookType 双重保险过滤。
   */
  let showMarks = false; // 「我的标记」抽屉（书签 + 摘录合并）
  let bookmarks: BookMark[] = [];
  let annotsList: any[] = [];

  /**
   * 2026-09-03 改造：抽屉简化为两个互斥状态（目录 / 我的标记）。
   * - 一次只能开一个（防止视口拥挤）
   * - 同图标再点 = 关
   * - 不同图标 = 自动切到新的
   * - 关联底层 `showToc` / `showMarks` 两态
   */
  type DrawerKind = "toc" | "marks";
  let activeDrawer: DrawerKind | null = null;
  // 抽屉角标（小尾巴）横向位置，由 JS 按对应锚点图标中心动态计算
  let tailLeft = 30;
  const fallbackTailLeft: Record<DrawerKind, number> = { toc: 30, marks: 64 };

  function computeDrawerTail(kind: DrawerKind) {
    if (!readerViewEl) {
      tailLeft = fallbackTailLeft[kind];
      return;
    }
    const anchor = readerViewEl.querySelector(`[data-drawer-anchor="${kind}"]`) as HTMLElement | null;
    if (!anchor) {
      tailLeft = fallbackTailLeft[kind];
      return;
    }
    const anchorRect = anchor.getBoundingClientRect();
    const viewRect = readerViewEl.getBoundingClientRect();
    tailLeft = anchorRect.left - viewRect.left + anchorRect.width / 2;
  }

  /* ================= 2026-10-25 P0-1：常驻侧边栏（停靠模式） =================
   * 对标 Readest sidebar / 微信读书目录栏。与"抽屉"的本质区别是**正文让位不遮挡**：
   * 停靠时 .reader-stage 加 margin-left 压缩宽度，foliate 的 ResizeObserver 走
   * 窗口缩放同一条路径自动重排版（scheduleReaderRelayout 收尾回锚）。
   * 实现取"CSS 停靠"路线：TOC/标记/搜索面板本体零搬移，停靠 = 覆写为全高左栏；
   * 可拖宽（200-480px、8px 步进降低重排版频率）、可固定/取消，偏好 localStorage 持久化。 */
  const SIDEBAR_STORE_KEY = "reword-reader-sidebar";
  let sidebarPinned = false; // 停靠模式开
  let sidebarWidth = 280;    // 停靠栏宽（px）
  let sideResizing = false;

  function loadSidebarPrefs() {
    try {
      const raw = localStorage.getItem(SIDEBAR_STORE_KEY);
      if (!raw) return;
      const o = JSON.parse(raw);
      if (typeof o.pinned === "boolean") sidebarPinned = o.pinned;
      if (typeof o.width === "number") sidebarWidth = Math.min(480, Math.max(200, Math.round(o.width)));
    } catch { /* 坏数据忽略，用默认 */ }
  }
  function persistSidebar() {
    try { localStorage.setItem(SIDEBAR_STORE_KEY, JSON.stringify({ pinned: sidebarPinned, width: sidebarWidth })); }
    catch { /* 隐私模式等场景静默 */ }
  }

  /** 停靠栏是否在场（有面板 + 停靠模式）：驱动根节点 sidebar-docked 类与拖宽把手 */
  function anyDockPanel(): boolean {
    return sidebarPinned && (showToc || showMarks || showSearch);
  }

  function toggleSidebarPin() {
    // 手机窄屏：停靠栏会吃掉大半屏，暂不开放（移动端已有底部 sheet 形态）
    if (isPhoneBreakpoint(viewportBp)) { toast(t("手机端暂不支持停靠侧栏")); return; }
    sidebarPinned = !sidebarPinned;
    persistSidebar();
    if (sidebarPinned) {
      // 停靠时保证有一个面板在场（默认目录），否则只有让位空白没有内容
      if (!showToc && !showMarks && !showSearch) void toggleDrawer("toc");
    }
  }

  /** 停靠栏拖宽：8px 步进 + rAF 节流（每步都是一次 foliate 完整重排版，不能逐帧） */
  function onSidebarResizeStart(e: PointerEvent) {
    e.preventDefault();
    sideResizing = true;
    let raf = 0;
    const move = (ev: PointerEvent) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const hostRect = readerViewEl?.getBoundingClientRect();
        if (!hostRect) return;
        const stepped = Math.round(Math.min(480, Math.max(200, ev.clientX - hostRect.left)) / 8) * 8;
        if (stepped !== sidebarWidth) sidebarWidth = stepped;
      });
    };
    const up = () => {
      if (raf) cancelAnimationFrame(raf);
      sideResizing = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      persistSidebar();
      scheduleReaderRelayout();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  const toggleDrawer = async (kind: DrawerKind) => {
    activeDrawer = activeDrawer === kind ? null : kind;
    // 同步到抽屉 flag（功能模块还引用这些字段名）
    showToc = activeDrawer === "toc";
    showMarks = activeDrawer === "marks";
    // 打开任意抽屉时收起搜索 / 设置浮层（保持原 toggleToc 互斥行为，避免浮层叠放拥挤）
    if (activeDrawer) {
      showSearch = false;
      showSettings = false;
    }
    // 打开「我的标记」时同时刷新书签 + 摘录两份数据（2026-09-03 半分半合：两者合并到同一抽屉）
    if (activeDrawer === "marks") {
      refreshBookmarks();
      refreshAnnotsList();
    }
    // 2026-10-08 顶栏浮层化：抽屉的锚点（☰ / 📝）在顶栏里，
    // 顶栏收起时抽屉会挂在一个不可见锚点下方（角标指向空气、点它也不响应）。
    // ⇒ 打开抽屉时保持顶栏可见；关闭时解除（pinned 不动）。
    if (activeDrawer) {
      ensureTopBarForPopover();
    } else {
      releaseTopBarForPopover();
    }
    // 等 DOM 渲染出抽屉后再算尾巴位置，保证指向对应图标中心
    if (activeDrawer) {
      await tick();
      computeDrawerTail(activeDrawer);
    }
    // 2026-10-25 停靠联动：停靠模式下关掉最后一个面板 → 连带退出停靠（不留空栏占正文宽度）
    if (sidebarPinned && !activeDrawer && !showSearch) {
      sidebarPinned = false;
      persistSidebar();
    }
  };

  /* ============================================================
   * 底栏：纯浮层（2026-10-07 最终形态，对标微信读书 / Readest 滚动模式）
   * ------------------------------------------------------------
   * ## 形态
   * `position: absolute` 浮在正文**上层**，浮起时盖住最后若干行。
   * **完全不参与分页器几何** —— 正文不重排、不跳行、翻页位置不变。
   *
   * ## 为什么不做「动态占位」
   * 第一版曾实现过「底栏浮起时把下边距抬高 `base + 底栏高`，让正文上移让位」。
   * 用户明确否决：要的就是「浮在上面、文字不动，被盖住没关系」。
   * 撤销后连带删掉了 `measureBottomBarHeight` / `bottomBarHeight` /
   * `BOTTOM_BAR_ESTIMATED_HX` / `lastReservedPx` 与那段显式 `Paginator.render()`
   * —— 净收益是代码变少，且顺带消掉了「改 CSS 变量不触发 ResizeObserver
   * → 触发 macOS overlay 滚动条白线」那个隐患的根因。
   */

  /**
   * 下边距写进分页器：**恒等于用户设定值**，永不被底栏影响。
   *
   * 调用点：applyStylesInner（设置变更）、updateBottomBarReveal（显隐变化）。
   * 保留这次显式写入是为了**复位** —— 若同一页面会话内曾经写过旧版的
   * `base + reserve` 历史值，需要在此写回纯 `base`，否则改过底栏后回不去。
   */
  function applyBottomBarReserve() {
    if (isDestroyed) return;
    if (!view?.renderer?.style) return;
    // ⚠️ 底栏是**纯浮层**（对标微信读书）：浮在文字上层、盖住部分正文，
    // 但**完全不参与分页器几何** —— 正文一个字都不动、不重排、不跳行。
    // 此前（2026-10-07 第一版）这里会写 `base + 底栏高度` 让正文上移给底栏让位，
    // 那套「动态占位」已按用户要求撤销。
    //
    // 现在只做一件事：把下边距**恒等于用户设定值**。
    // 之所以还要显式写一次（而不是删掉整个函数）：设置变更时若上一轮曾写过
    // `base + reserve` 的历史值，需要在此复位，否则同一页面会话内改过底栏就回不去。
    const base = Math.max(0, Number(settings.layout.marginBottomPx) || 0);
    try {
      view.renderer.style.setProperty("--_reword-margin-bottom", `${base}px`);
    } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · applyBottomBarReserve", "debug"); }
  }

  /**
   * 底部进度条显隐控制（2026-10-07 改造：去掉 hover 自动弹出，改为纯点击）。
   *
   * ## 用户反馈（真机）
   * 「等鼠标往这边移动的时候它就很灵敏的往上走，我不太喜欢，我想那种点击的情况，
   *   这样会更有掌握感」——
   *   hover 热区（底部 38px）自动弹出的机制在阅读时频繁误触发（想翻页结果栏弹出来），
   *   且用户对「它什么时候出现」没有预期感。
   *
   * ## 现在的规则
   * · **点击把手 → 切换**（浮起 / 收回），这是唯一的主动作；
   * · 鼠标在**已展开的栏内**时维持显示 —— 必须保留，
   *   否则用户想点进度条上的「上一页/下一页」时，一移开鼠标栏就消失、根本点不到；
   * · 移出栏外后若非 pinned（未点开）则收回。
   *
   * ⇒ 去掉 `bottomBarEdgeHover`（底部热区自动触发），它已被 click 取代。
   *
   * ## 副作用：无
   * 底栏已是纯浮层、不参与分页器几何（见上方说明），
   * 显隐变化**不需要**再刷新任何边距。仅在此保留一次调用，
   * 用于复位可能残留的旧版 `base + reserve` 边距值。
   */
  function updateBottomBarReveal() {
    bottomBarRevealed = bottomBarPinned || bottomBarBarHover;
    applyBottomBarReserve();
  }

  /**
   * 鼠标在阅读区内移动。
   *
   * 2026-10-07：原逻辑用它判定「是否进入底部 38px 热区」以自动弹出。
   * 现 hover 自动弹出已去掉，本函数**不再改显隐**，
   * 只保留一个用途：把鼠标移出栏外时收起未固定的栏。
   */
  function onReaderMouseMove(_e: MouseEvent) {
    // 刻意留空：热区自动弹出已移除（见 updateBottomBarReveal 注释）。
    // 保留空函数是因为模板仍绑定它，避免连带改模板。
    // 收起逻辑放在 onReaderLeave 与底栏自身的 mouseleave 里。
  }

  /** 鼠标离开阅读区：退出进度条自身，未固定则自动隐藏 */
  function onReaderLeave() {
    bottomBarBarHover = false;
    updateBottomBarReveal();
    // 2026-10-08：顶栏同理 —— 移出阅读区后，若不是用户点开的（pinned），
    // 且栏内此刻没有 hover，就收回。pinned 的不动（用户显式点开的）。
    if (isTopBarFloating()) {
      topBarBarHover = false;
      updateTopBarReveal();
    }
  }

  /**
   * 点击把手（中央圆点）：切换进度条浮起 / 收回。
   * 2026-10-07：由 `toggleBottomBarPin` 改名 —— 它现在的语义就是「切换」，
   * 不再是「点右下角唤出按钮那种固定」。
   */
  function toggleBottomBarPin() {
    bottomBarPinned = !bottomBarPinned;
    updateBottomBarReveal();
  }

  /**
   * 点击栏内「⌄」：立即完全收起（含 pinned）。
   * 与把手「切换」的区别：这是无条件收起，不做「若已收起则展开」的分支。
   */
  function collapseBottomBar() {
    bottomBarPinned = false;
    bottomBarBarHover = false;
    updateBottomBarReveal();
  }

  /**
 * 写入顶栏把手的命中区尺寸（`--reword-top-hit-h` / `-w`）。
 *
 * ## 为什么必须按上边距夹，而不是写死
 * Readest `getHeaderTriggerHeight()` 的注释写明了它踩过的坑（#4977/#5427）：
 * 触发区是个「盖子」—— **盖住的部分不能被选中、长按、点击**。
 * 它曾按 44px 写死，而 44 只是恰好等于默认上边距；一旦上边距被调小
 * （页眉关闭 / 用户手动收紧），触发区就悬在第一行文字上方、吞掉那里的划词。
 * ⇒ Readest 改成 `min(44, 内容顶边)`。
 *
 * 我们的默认上边距是 24（顶栏浮层化后），所以：
 * `h = clamp(16, min(28, marginTopPx - 4), 28)` —— 上边距 ≥32px 时恒为 28px，
 * 与底栏把手同尺寸，手感一致；上边距很小时退化到 16px 最小值。
 *
 * ⚠️ 诚实标注边界：上边距 < 20px 时命中区仍会压住一点字。
 *   这是刻意的 —— 再压更小就点不中圆点了，等于把功能整个废掉。
 *   20px 上边距本身已在正文字号的可读边缘，不建议再往下调。
 */
function applyTopHandleHitHeight() {
  if (!topBarEl) return;
  const mt = Math.max(0, Number(settings.layout.marginTopPx) || 0);
  const h = Math.min(28, Math.max(16, mt - 4));
  topBarEl.style.setProperty("--reword-top-hit-h", `${h}px`);
  // 宽度固定 28：宽度不受边距约束（左右方向没有「内容顶边」这种概念），
  // 但跟随高度做成正圆手感更好。
  topBarEl.style.setProperty("--reword-top-hit-w", `${Math.max(24, h)}px`);
}

  /* ==================== 顶栏浮层（2026-10-08） ==================== */

  /** 是否走「顶栏浮层」模式（关闭时是 2026-10-08 之前的常驻占位行为） */
  function isTopBarFloating(): boolean {
    return settings.layout.topBarFloating !== false;
  }

  /**
   * 顶栏显隐。
   *
   * ## 副作用：**刻意不做任何几何写入**
   * 与底栏的 `applyBottomBarReserve()` 不同，这里**不碰分页器边距**：
   * 顶栏是 `position: absolute`，收起/展开只改 opacity + transform，
   * 而这**不改变任何元素的盒子尺寸** ⇒ 内容文档的分页/滚动几何完全不变。
   *
   * ⚠️ 若这里加「展开时给 top 加一段占位」，就会踩 2026-10-07 底栏那轮
   * 用户亲自否决掉的「动态占位」：每次点圆点都重排正文、甚至跳页。
   * 用户明确要的就是「浮在上面、文字不动、被盖住没关系」。
   */
  function updateTopBarReveal() {
    topBarRevealed = isTopBarFloating() && (topBarPinned || topBarBarHover);
  }

  /* ================= 2026-10-25 移动端适配 B1：浮层栏自动收起 =================
   * 用户真机反馈：顶/底栏弹出后一直挡着正文（移动端可视高度小，遮挡感强）。
   * 只动 revealed/pinned 状态位（opacity/transform 过渡，零重排——
   * 符合本文件"显隐不写几何"的铁律），触屏 3.5s 无交互自动收回。
   * 触发：revealed 状态变化的响应式块 + 翻页（onRelocate，B2）。 */

  const BAR_AUTO_HIDE_MS = 3500;
  let barAutoHideTimer: any = null;

  /** 完全收回顶/底浮层栏（含 pinned——自动收起本就是"替用户收"） */
  function retractFloatingBars() {
    if (!isTouchDevice()) return; // 桌面 hover/pinned 语义不动
    let changed = false;
    if (bottomBarRevealed || bottomBarPinned) {
      bottomBarPinned = false;
      bottomBarBarHover = false;
      updateBottomBarReveal();
      changed = true;
    }
    if (isTopBarFloating() && (topBarRevealed || topBarPinned)) {
      // 顶栏收起联动收抽屉（与 toggleTopBarPin 收起分支同语义，防孤儿抽屉）
      closeAllPopovers();
      topBarPinned = false;
      topBarBarHover = false;
      updateTopBarReveal();
      changed = true;
    }
    if (changed && barAutoHideTimer) {
      clearTimeout(barAutoHideTimer);
      barAutoHideTimer = null;
    }
  }

  /** revealed 变化驱动：浮起 → 排 3.5s 收回；全收 → 清计时器 */
  function pokeBarAutoHide(revealed: boolean) {
    if (!isTouchDevice()) return;
    if (revealed) {
      if (barAutoHideTimer) clearTimeout(barAutoHideTimer);
      barAutoHideTimer = setTimeout(() => {
        barAutoHideTimer = null;
        retractFloatingBars();
      }, BAR_AUTO_HIDE_MS);
    } else if (barAutoHideTimer) {
      clearTimeout(barAutoHideTimer);
      barAutoHideTimer = null;
    }
  }
  $: pokeBarAutoHide(topBarRevealed || bottomBarRevealed);

  /** 点击顶部圆点：切换顶栏浮起 / 收回 */
  function toggleTopBarPin() {
    const willReveal = !topBarRevealed;
    // 2026-10-13 修复（孤儿抽屉）：收起与展开两个方向都要联动收抽屉。
    //   - 展开：清残留抽屉，避免「锚点栏刚出现、抽屉挂在半空」；
    //   - 收起：抽屉全部挂在顶栏锚点下，顶栏缩回圆点后锚点消失，
    //     若不联动收起，抽屉会悬空成孤儿（真机截图：书签/标注面板悬在左上）。
    // 直接走 closeAllPopovers()（含 showToc/showMarks/showSearch/设置/搜索/词典/
    // 编辑态工具栏等全套），与「点空白收起」同一入口，语义一致；
    // 它内部 releaseTopBarForPopover 只清 hover 保持态、不动 topBarPinned，
    // 随后我们再覆写 topBarPinned，顺序安全。
    closeAllPopovers();
    topBarPinned = willReveal;
    updateTopBarReveal();
  }

  /**
   * 顶栏展开时，若某个浮层（目录/书签/搜索/设置）被打开，顶栏必须保持可见。
   * 否则抽屉会挂在一个已收起的锚点下方 —— 角标指向空气、点它也不响应。
   *
   * 只置 `topBarBarHover`（临时维持），不动 `topBarPinned`（显式意图）。
   */
  function ensureTopBarForPopover() {
    if (!isTopBarFloating()) return;
    topBarBarHover = true;
    updateTopBarReveal();
  }

  /**
   * 关闭全部抽屉类浮层后，解除「为浮层而保持顶栏可见」的临时状态。
   *（`topBarPinned` 不动 —— 用户点了圆点就是要它浮着，那是显式意图。）
   */
  function releaseTopBarForPopover() {
    if (!isTopBarFloating()) return;
    topBarBarHover = false;
    updateTopBarReveal();
  }

  /**
   * 由 foliate 的 sections 体积累加推算每章起始进度（0–100）。
   * toc href 与 section.id 可能带 #fragment，统一去片段后匹配；匹配不到则跳过该章。
   * 全本都匹配不到时 marks 为空 → 不渲染刻度（安全降级，不改变现有外观）。
   */
  function computeChapterMarks() {
    try {
      const sections = view?.book?.sections;
      if (!Array.isArray(sections) || sections.length < 2 || !tocItems.length) {
        chapterMarks = [];
        return;
      }
      const total = sections.reduce(
        (s: number, x: any) => s + (Number(x?.size) || 0),
        0
      );
      if (!total) {
        chapterMarks = [];
        return;
      }
      const cum: number[] = [];
      let acc = 0;
      for (const sec of sections) {
        cum.push(acc);
        acc += Number(sec?.size) || 0;
      }
      const seen = new Set<number>();
      const marks: { left: number; title: string }[] = [];
      for (const item of tocItems) {
        const path = String(item?.href || "").split("#")[0];
        if (!path) continue;
        const idx = sections.findIndex(
          (s: any) => s?.id === path || String(s?.id || "").split("#")[0] === path
        );
        if (idx <= 0) continue; // 第 0 章起点就是 0%，无需刻度
        const left = Math.round((cum[idx] / total) * 1000) / 10;
        if (left <= 0.2 || left >= 99.8) continue;
        if (seen.has(left)) continue;
        seen.add(left);
        marks.push({ left, title: item?.title || "" });
      }
      // 章节过多时抽稀，避免刻度糊成一片
      const MAX_MARKS = 60;
      chapterMarks =
        marks.length > MAX_MARKS
          ? marks.filter(
              (_, i) => i % Math.ceil(marks.length / MAX_MARKS) === 0
            )
          : marks;
    } catch {
      chapterMarks = [];
    }
  }

  onDestroy(() => {
    if (hoverHideTimer) clearTimeout(hoverHideTimer);
    // 2026-10-25 角落自动翻页：销毁即取消（含计时器与 L 动画态）
    cornerMachine.cancel();
  });

  let settings: ReaderSettings = { ...READER_DEFAULT_SETTINGS };

  // 阅读统计（时长 / 剩余时间估算）
  let totalChars = 0;
  /** 本次会话「有效阅读」累计，从不清零 —— 服务 ETA 的实测速度。
   *  ⚠️ 与旧的 sessionReadMs 语义不同：后者实为「30s 待落盘滚动桶」，
   *  每 30s 被清零 → updateEta 里 minsRead ≤ 0.5 → `minsRead > 1` 恒 false
   *  → speed 恒回落 400 字/分，「按当前阅读速度估算」那个 tooltip 是假的（代码级必然，非概率）。 */
  let activeMs = 0;
  /** 待落盘累计：满 TIMER_FLUSH_MS 清零并写进 readingLog */
  let flushAcc = 0;
  let etaText = "";
  let timeTimer: any = null;
  let lastTickAt = 0;
  /** 最后一次活跃时刻（闸门 3「空闲转停」用） */
  let lastActivityAt = 0;
  /** 当前累加量所属的本地日期（闸门 4「跨零点归属」用） */
  let curDayKey = "";
  let searchInput: HTMLInputElement;

  // 字体状态
  let customFonts: CustomFont[] = [];
  let fontBlobUrl = "";
  let fontImporting = false;
  let fontInput: HTMLInputElement;
  // 问题 2（跟随思源）：宿主字体文件 blob 化缓存（fetch → blob → iframe 可加载的 @font-face）
  let hostFontBlobs: { family: string; blobUrl: string }[] = [];
  let hostFontBlobsReady = false;
  /** 把宿主已加载的网页字体（霞鹜文楷等）blob 化，注入 iframe 后真正生效 */
  async function prepareHostFontBlobs(): Promise<void> {
    // 2026-08-30 修复：自定义档（分类字体链）同样需要宿主网页字体 blob，
    // 否则「衬线/无衬线/等宽/中文」字体设置只能走 local() fallback，网页字体（霞鹜文楷等）
    // 未安装到系统时完全不生效。
    if (hostFontBlobsReady) return;
    if (settings.fontMode !== "follow-siyuan" && settings.fontMode !== "custom"
      && settings.fontMode !== "classified") return;
    hostFontBlobsReady = true;
    try {
      const items = collectHostFontUrls();
      if (!items.length) return;
      const blobs: { family: string; blobUrl: string }[] = [];
      for (const it of items) {
        try {
          const res = await fetch(it.url);
          if (!res.ok) continue;
          const blob = await res.blob();
          blobs.push({ family: it.family, blobUrl: URL.createObjectURL(blob) });
        } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · prepareHostFontBlobs", "debug"); }
      }
      if (blobs.length) {
        hostFontBlobs = blobs;
        applyStyles(); // blob 就绪后立即重刷 iframe 样式
      }
    } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · prepareHostFontBlobs", "debug"); }
  }
  const FONT_ACCEPT = ".ttf,.otf,.woff,.woff2";

  // 搜索状态
  let searchQuery = "";
  let searching = false;
  /** 单条搜索结果（含章节标签与进度，用于结果列表展示与跳转） */
  interface SearchHit {
    cfi: string;
    cfis: string[];
    excerpt: string;
    chapterLabel: string;
    progressPercent: number;
  }
  let searchResults: SearchHit[] = [];
  let searchIndex = -1;
  /** 搜索范围：全书 / 当前章（2026-08-29） */
  let searchScope: "book" | "chapter" = "book";
  let searchCaseSensitive = false;
  let searchWholeWord = false;
  /** 搜索模式（2026-10-25 搜索增强）：普通 contains / 正则 regex / 附近词 nearby-words。
   *  foliate matcher 原生支持三种（search.js:281，正则为 Calibre-parity #4560），
   *  view.search(opts) 透传 mode 即通 —— 这里只做 UI 暴露与联动。 */
  let searchMode: "contains" | "regex" | "nearby-words" = "contains";
  /** 正则即时校验错误（null = 未启用或合法；doSearch 据此拦截 + UI 红框） */
  let regexError: string | null = null;
  /** 搜索历史（仅普通模式记录；localStorage 持久化，上限 12 条） */
  let searchHistory: string[] = [];
  /** 当前章节索引（relocate 事件驱动，用于「当前章」范围搜索） */
  let currentSectionIndex = -1;
  let searchDebounce: any = null;

  // 进度条拖动
  let dragging = false;

  let saveTimer: any = null;
  // 2026-09-09 修复：待落盘进度改为合并式。缩放路径（applyZoom / scheduleZoomPersist）
  // 只传 { zoom }，此前 saveProgress 是整体替换（meta.progress = progress），缩放一次
  // 就把已存的 cfi/fraction 抹掉（存储实锤出现 progress 只剩 zoom 的记录）→ 恢复丢位。
  let pendingSave: any = null;
  // 开书后延迟重绑内容文档的定时器（须在 onDestroy 取消，避免组件销毁后仍重绑到已死的 doc）
  let attachTimer1: any = null;
  let attachTimer2: any = null;
  function scheduleProgressSave(p: any) {
    pendingSave = { ...(pendingSave || {}), ...p };
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const payload = pendingSave;
      pendingSave = null;
      if (bookId && payload) store.saveProgress(bookId, payload).catch(() => {});
    }, 600);
  }
  /** 2026-09-09 修复：关闭/销毁时立即落盘挂起的进度。
   *  此前 onDestroy 只 clearTimeout 丢弃 pending——连续快速翻页后立即关闭，
   *  最后 600ms 内的位置（往往就是用户实际停的页）从未写盘 → 恢复落后几页。 */
  async function flushProgressSave(): Promise<void> {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    const payload = pendingSave;
    pendingSave = null;
    // [REword patch 2026-10-13] 兜底：fraction=0 无意义，不落盘避免覆盖历史进度
    if (bookId && payload && payload.fraction !== 0) {
      try { await store.saveProgress(bookId, payload); }
      catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · flushProgressSave", "debug"); }
    }
  }

  /** 读取思源笔记实际 CSS 变量（用于「跟随思源」主题的背景/文字色同步） */
  function getSiyuanVar(name: string, fallback: string): string {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch {
      return fallback;
    }
  }

  /**
   * 读思源笔记当前的**编辑器字号**（px）——「字号跟随思源」的数据源。
   *
   * ## 变量名从哪来的（2026-10-07 实测定位，勿再猜）
   * 思源前端产物 stage/build/app/common.*.js 里有这么一段运行时注入：
   *
   *     :root {
   *       --b3-font-size-editor: ${window.siyuan.config.editor.fontSize}px;
   *       --b3-font-family-editor: ...;
   *     }
   *
   * 也就是**思源「编辑器字号」设置（设置 → 外观 → 编辑器字号）就是这个变量**。
   * 实测常量：EDITOR_FONT_SIZE_MIN=9 / MAX=72 / DEFAULT=16（同一产物里）。
   *
   * ## ⚠️ 千万别读 --b3-font-size
   * 那是**思源 UI 的字号**，硬编码在思源内置主题的 theme.css 里 = 14px，
   * 不随「编辑器字号」设置变。此前误读它，导致用户把编辑器字号设成 18、
   * 阅读器却稳定显示 14（= 思源 UI 字号），反馈「不对」。
   *
   * 注意：本注释块内不要写含「星号紧跟斜杠」的通配路径字样，
   * 那会提前闭合 JSDoc、把后面的中文当代码解析，构建期才报语法错（本次踩过）。
   *
   * ## 降级链（任何一环读不到就往下一环）
   * ① --b3-font-size-editor：真·编辑器字号，最准；
   * ② .protyle-wysiwyg 的**计算后** font-size：变量不存在时的兜底
   *    （其 CSS 规则本身就是 font-size: var(--b3-font-size-editor)，
   *      见思源 base.*.css；不能读 documentElement —— 那是 UI 字号，同①的坑）；
   * ③ .b3-typography / [data-node-id]；
   * ④ 全部读不到 → 返回 0，调用方保持原值不动（**绝不回落 14 或默认值**）。
   *
   * @returns px 值；读不到时返回 0
   */
  function readSiyuanFontSizePx(): number {
    /** 读一个 <length> 值（"18px" / "18"），非正数/NaN 一律当 0 */
    const len = (raw: string | null | undefined): number => {
      if (!raw) return 0;
      const v = parseFloat(raw);
      return Number.isFinite(v) && v > 0 ? v : 0;
    };
    /**
     * 读元素计算后的 font-size（仅作兜底）。
     * ⚠️ 必须过滤**未被解析的 var() 引用**：某些环境（jsdom、部分 WebView）
     * 不解析 `var()`，getComputedStyle 会原样返回 `"var(--b3-font-size-editor)"`，
     * parseFloat 得NaN → 0，尚能兜住；但若字符串里带数字前缀
     * （如 `"var(--x, 18)"`）会误得18。这里统一只接受**纯长度值**。
     */
    const csOf = (el: Element | null): number => {
      if (!el) return 0;
      try {
        const raw = getComputedStyle(el).fontSize || "";
        if (raw.includes("var(")) return 0;
        return len(raw);
      } catch {
        return 0;
      }
    };
    try {
      // ① 首选：思源编辑器字号变量（真值，随「编辑器字号」设置实时变化）
      const editorVar = len(getSiyuanVar("--b3-font-size-editor", ""));
      if (editorVar > 0) return editorVar;

      // ②~④ 兜底：读正文容器的计算值。注意**不读 documentElement**
      //（那是 UI 字号 = 14px，正是本函数此前一直返回 14 的原因）。
      for (const sel of [
        ".protyle-wysiwyg",
        ".b3-typography",
        "[data-node-id]",
      ]) {
        const v = csOf(document.querySelector(sel));
        if (v > 0) return v;
      }
      return 0;
    } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · readSiyuanFontSizePx", "debug"); return 0; }
  }

  /** 正文字号区间：直接用 reader-settings 的单一真源，避免与 schema 各写一份 */
  const FONT_SIZE_MIN = READER_FONT_SIZE_MIN;
  const FONT_SIZE_MAX = READER_FONT_SIZE_MAX;

  /**
   * 「字号跟随思源」：把思源正文字号同步进 `settings.fontSize`。
   *
   * ## 语义（方案A，用户拍板）
   * · `fontSizeSync === true` → 每次开书 / 打开设置面板时读一次并覆盖 `fontSize`
   * · 用户一旦**手动改字号**（拖滑块/点±），面板会先把 `fontSizeSync` 改成 false
   *   （见 onSettingsDialogChange），此后**永不被覆盖** ——
   *   否则「我明明调到了 20px，下次开书又变回 14px」是另一种「设了不生效」。
   *
   * @returns 实际写入的 px 值（0=读不到思源字号，本次不动任何设置）
   */
  function syncFontSizeFromSiyuan(): number {
    // 非跟随态、或组件已销毁 → 不碰
    if (isDestroyed) return 0;
    if (settings.fontSizeSync !== true) return 0;
    const px = readSiyuanFontSizePx();
    // 读不到 / 超区间 → 保持原值不动。
    // ⚠️ 这里**不能**回落默认值：宁可不同步，也不能把用户已调好的字号打回出厂值。
    if (!px || px < FONT_SIZE_MIN || px > FONT_SIZE_MAX) return 0;
    // 四舍五入到整数，避免 14.4 这类值在面板上显示成两位小数
    const next = Math.round(px);
    if (settings.fontSize === next) return next;
    settings = settingsStore.update({ fontSize: next });
    return next;
  }

  /**
   * 阅读器**配色**解析（2026-10-07 从 themeOf 重写）。
   *
   * ⚠️ 本函数**只管配色，不管明暗**。
   * 此前它兼任两职：`theme === "auto"` 时返回思源的实际背景色 ——
   * 于是「主题模式 = 跟随」实际上是把**配色也换成了思源配色**，
   * 用户点一下「跟随」，下面选中的配色就被顶掉了（2026-10-07 用户反馈）。
   *
   * 现在的分工：
   *   · 本函数 → 配色（选哪份色板 / 自定义取色）
   *   · 明暗   → `settings.themeMode`（跟随 / 亮 / 暗），由 deriveStyleOutput 合成
   *   · 配色与目标明暗冲突时（杏仁黄 + 深色）→ deriveStyleOutput 做明暗适配，
   *     **保留色相**，不换成另一份配色。
   *
   * `followSiyuanPalette` 仅用于「配色也要跟思源走」的场合：
   * themeMode=auto 且用户从未主动选过配色时（theme 是默认值）。
   */
  function themeOf(): { bg: string; fg: string; fg2: string } {
    if (settings.theme === "custom") {
      return {
        bg: settings.customBg || "#ffffff",
        fg: settings.customFg || "#222222",
        fg2: "inherit",
      };
    }
    return THEME_PRESETS[settings.theme] ?? THEME_PRESETS.light;
  }

  /**
   * 是否让**配色**也跟随思源（2026-10-07）。
   *
   * 判定：明暗模式为「跟随」**且**配色仍是出厂默认（用户没主动选过）。
   * 只要用户动过配色（选色板或用取色器），就不再跟随思源配色 ——
   * 否则「我选的杏仁黄」会在切系统主题时被冲掉。
   */
  function followsSiyuanPalette(): boolean {
    if ((settings.themeMode ?? "auto") !== "auto") return false;
    const isDefaultColor = !settings.theme || settings.theme === "light";
    const noCustomPick = !settings.customBg && !settings.customFg;
    return isDefaultColor && noCustomPick;
  }

  /** 旧的「跟随思源配色」取值（供 followsSiyuanPalette 命中时使用） */
  function siyuanPaletteOf(): { bg: string; fg: string; fg2: string } {
    const dark = siyuanThemeMode === "dark";
    if (dark) {
      return {
        bg: getSiyuanVar("--b3-theme-background", "#000000"),
        fg: getSiyuanVar("--b3-theme-on-background", "#e0e0e0"),
        fg2: getSiyuanVar("--b3-theme-on-surface", "#9aa0a6"),
      };
    }
    return {
      bg: getSiyuanVar("--b3-theme-background", "#ffffff"),
      fg: getSiyuanVar("--b3-theme-on-background", "#222222"),
      fg2: getSiyuanVar("--b3-theme-on-surface", "#888888"),
    };
  }

  /** 检测思源当前主题模式（读取 <html data-theme-mode>） */
  function detectSiyuanTheme(): "light" | "dark" {
    try {
      const mode = document.documentElement.getAttribute("data-theme-mode");
      return mode === "dark" ? "dark" : "light";
    } catch {
      return "light";
    }
  }

  /** 已同步进 theme-bridge iframe 注册表的内容 iframe 集合（差量同步用） */
  let contentIframes: Set<HTMLIFrameElement> = new Set();

  /**
   * 把当前阅读器内容 iframe 同步进 theme-bridge 的 iframe 注册表（L0 令牌包 + L3 主题总线）。
   * 取内容 iframe 的正路：view.renderer.getContents() 每项含 doc，
   * doc.defaultView.frameElement 即 iframe 元素（foliate 无 view.frames API，见本文件 5361 行说明）。
   * - 新 iframe：registerIframe 注册（注册时立即注入令牌）
   * - 消失的 iframe：unregisterIframe 注销
   * - 主题切换时由 theme-bridge.refreshAllIframeTokens 统一重注，无需阅读器各自处理。
   * 由 onMount 的 subscribeThemeChange 回调在「主题切换 / 开书 / 翻页」时经 applyStyles 调用。
   */
  function syncContentIframes() {
    if (!view?.renderer?.getContents) return;
    const current = new Set<HTMLIFrameElement>();
    try {
      const contents = (view.renderer.getContents() || []) as Array<{ doc?: Document }>;
      for (const c of contents) {
        const frame = c?.doc?.defaultView?.frameElement as HTMLIFrameElement | null | undefined;
        if (frame) current.add(frame);
      }
    } catch {
      /* 内容文档尚未就绪时静默忽略 */
    }
    // 注销已消失的 iframe
    for (const f of contentIframes) {
      if (!current.has(f)) {
        unregisterIframe(f);
        contentIframes.delete(f);
      }
    }
    // 注册新增的 iframe（registerIframe 内部立即注入令牌）
    for (const f of current) {
      if (!contentIframes.has(f)) {
        registerIframe(f);
        contentIframes.add(f);
      }
    }
  }

  /**
   * 字体注入：返回 { @font-face CSS, body font-family 栈 }
   * 单一职责：让 buildReaderStyles 输出**只有一处** body font-family 声明。
   *
   * 模式：
   * - system  ：仅 CJK fallback（让 epub 默认字体走跨平台栈）
   * - custom  ：用户自定义字体 + CJK fallback
   * - follow-siyuan：宿主 @font-face（@霞鹜文楷 等）+ 宿主字体栈 + CJK fallback
   *
   * 2026-08-23 修复（乱码根治 + 跟随思源字体，方案 A/C 合并）：
   * - 原实现在 follow-siyuan 把宿主栈放最前（`${hostStack}, ${cjkFallback}`）。
   *   若宿主栈含无效字体（跨域/CDN 加载失败、local() 不命中的主题字体名），
   *   阅读器 iframe 会整链崩坏 → 汉字无字形 → 方块/残缺/乱码。
   * - 方案 A：跨平台 CJK 本机栈前置兜底。但此方案把宿主字体（霞鹜文楷）压到后面，
   *   导致正文字体无法跟随思源「霞鹜文楷」设置。
   * - 方案 C（本实现采用）：宿主字体栈（含霞鹜文楷）前置，CJK 本机栈做兜底，
   *   sans-serif 永远最后。宿主字体可用时即被选中（跟随思源设置）；不可用时浏览器
   *   自动回退到 CJK 本机栈（PingFang SC / 微软雅黑 等装机必有），不会乱码。
   * - 配套改动：inlineOverrideStyles 同步温和化（不再用 font-family: inherit 压制 epub
   *   内联字体），见 reader-style.ts。
   */
  function buildFontInjection(): { fontFaceCss: string; fontFamilyStack: string } {
    const cjkFallback = getDefaultCjkFontStack();
    // 2026-10-07：原先此处有 system / classified / custom 三个并列分支，
    // 但它们其实只回答两个问题，砍档后合并如下：
    //   ① 「自定义」档下，是否选了一本**导入的**字体？选了就用那本，否则用下面的三条链。
    //   ② 三条字体链（衬线/无衬线/等宽/中文）—— custom 档一律构建，
    //      注入宿主 blob 让「霞鹜文楷」等思源插件的网页字体在 iframe 内真正可用
    //      （未装到系统时只命中 local() 会失败）。
    if (settings.fontMode === "custom" || settings.fontMode === "classified") {
      // ① 导入的单本字体优先（用户在字体管理页显式选中，意图最明确）
      if (settings.customFontId && fontBlobUrl) {
        const f = fontStore.get(settings.customFontId);
        if (f) {
          const faceCss = customFontFaceCss(f, fontBlobUrl);
          return { fontFaceCss: faceCss, fontFamilyStack: `"${f.name}", ${cjkFallback}, sans-serif` };
        }
      }
      // ② 三条链（Readest 同款）：此处返回的栈仅作兜底（正文链，供双语译文等同源消费），
      //    真正的三条链由 buildReaderStyles 内部构建并输出为 CSS 变量。
      const blobFaces = hostFontBlobs
        .map(
          (b) =>
            `@font-face{font-family:"${b.family}";src:url("${b.blobUrl}");font-display:swap;}`
        )
        .join("\n");
      const lists = buildFontFamilyLists(
        settings.serifFont ?? "",
        settings.sansSerifFont ?? "",
        settings.monospaceFont ?? "",
        settings.defaultCJKFont ?? ""
      );
      const stack =
        settings.defaultFontFamily === "sans-serif" ? lists.sansSerif : lists.serif;
      return { fontFaceCss: blobFaces, fontFamilyStack: stack };
    }
    // follow-siyuan：宿主 @font-face（blob 真实字体文件 + local() fallback）注入，
    // 字体栈把宿主栈（含霞鹜文楷）前置，CJK 本机栈兜底 —— 跟随思源字体设置且不会乱码。
    const faces = collectHostFontFaces();
    const hostStack = getHostFontStack();
    // 问题 2：blob 化的宿主字体 @font-face（真实字体文件，iframe 可加载）优先，
    // 未 blob 化的 local() fallback 兜底（命中本机已装字体）。
    const blobFaces = hostFontBlobs
      .map(
        (b) =>
          `@font-face{font-family:"${b.family}";src:url("${b.blobUrl}");font-display:swap;}`
      )
      .join("\n");
    const fontFaceCss =
      (blobFaces ? blobFaces + "\n" : "") + (faces.length ? faces.join("\n") + "\n" : "");
    // 关键改动：宿主字体栈（含霞鹜文楷）前置，CJK 本机栈做兜底，sans-serif 永远最后。
    // 这样正文字体跟随思源「霞鹜文楷」设置；若宿主字体不可用，浏览器自动回退到
    // CJK 本机栈（PingFang SC / 微软雅黑 等装机必有），不会无字形/乱码。
    const hostHead = hostStack
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .join(", ");
    const stack = `${hostHead}${cjkFallback ? ", " + cjkFallback : ""}, sans-serif`;
    return { fontFaceCss, fontFamilyStack: stack };
  }

  /**
   * 本次刷新的配色与派生输出（**唯一真源**）。
   *
   * 2026-10-07 为修「深浅色闪烁」引入：此前 `buildStyles()` 与 `applyContainerBg()`
   * 各自独立跑一遍「取色 → 明暗适配」，两条路径不在同一帧生效 ——
   * 思源切主题时 `--b3-*` 是**逐条更新**的，中间态会读到两套不同的值，
   * 于是容器已换色、书页还是旧色 ⇒ 看到一闪。
   *
   * 现在**算一次、两处共用**，从根上消除分叉。
   *
   * @returns palette 给 buildReaderStyles；output 给 applyContainerBg（取其 bg）
   */
  function resolvePalette(): {
    palette: { bg: string; fg: string; fg2: string };
    output: ReturnType<typeof deriveStyleOutput>;
  } {
    const palette = followsSiyuanPalette() ? siyuanPaletteOf() : themeOf();
    const output = deriveStyleOutput(
      settings,
      palette,
      LINE_WIDTH_PRESETS.normal,
      siyuanThemeMode === "dark",
    );
    return { palette, output };
  }

  function buildStyles() {
    // 2026-10-07：配色与明暗解耦（详见 resolvePalette）。
    //   · 配色 = 用户选的那份（themeOf）
    //   · 明暗 = settings.themeMode；auto 时看思源实际深浅
    //   · 仅当「配色也是出厂默认且明暗跟随」时，才整体沿用思源配色（保持旧开箱体验）
    const { palette: t } = resolvePalette();
    // 2026-09-29 设置整合：lineWidth 三档已删（与「页宽模式」重叠）。书页左右留白统一由
    // layoutMarginStyles（widthPct/widthMode）管理；此处恒用标准正文 padding（签名不变）。
    const lw = LINE_WIDTH_PRESETS.normal;
    // 委托给 reader-style.ts 纯函数，便于单测与维护
    // 字号（含 overrideBookFontSize 压平书籍字号）由 fontSizeOverrideStyles 段统一输出（2026-08-27 修复字号无效）
    const { fontFaceCss, fontFamilyStack } = buildFontInjection();
    // 2026-08-30 思源化：在父文档抓取思源调色板，经 :root 桥接注入阅读器 iframe，
    // 使 link/code/quote/译文块等样式能跟随思源外观（CSS 变量不跨 iframe 继承，必须显式抓取+注入）。
    const siyuanVars = captureSiyuanThemeVars(getSiyuanVar);
    return buildReaderStyles(
      // 2026-10-07：把「跟随思源边距」的运行时缓存挂上去。
      // buildReaderStyles 第一参数就是 settings（形参名沿用 settings），
      // 它只会读 sideMarginPx 这一个新字段，不参与任何持久化。
      // 开关关闭时传 null —— layoutMarginStyles 随即回落到 widthPct 换算的百分比，
      // 用户自己的左右边距设定值原样生效（不再被旧实现写进设置档后无法还原）。
      { ...settings, sideMarginPx: settings.layout.followSiyuanMargin ? siyuanSideMarginPx : null },
      t,
      lw,
      fontFaceCss,
      fontFamilyStack,
      siyuanVars,
      // themeMode=auto 时 deriveStyleOutput 用它判定深浅（2026-10-07 新增末位参数）
      siyuanThemeMode === "dark"
    );
  }

  // 2026-09-08 冻结根治：applyStyles 同步重入守卫。
  // applySiyuanDocMargin → settingsStore.update → _store.set（同步）→ 订阅回调
  // （本文件 7337）→ if (view) applyStyles() 会形成同步递归环；启动恢复期宿主
  // protyle 的 computed padding 持续变化时递归达数千层，且每层 setStyles 都
  // 排队一个 fontsReady→expand 微任务（paginator.js），栈清空后 expand 风暴
  // 把主线程占死 = 「重启后阅读 Tab 自动开书即冻结」的真凶。
  // 手动开书时 padding 稳定，环转 1-2 轮自停，故此前只在重启恢复时复现。
  let applyingStyles = false;
  /**
   * 组件是否已销毁（onDestroy 起置 true，永不复位）。
   * 2026-10-06 设置弹窗崩溃修复：settingsStore 的订阅在组件销毁后仍可能被
   * 触发（写设置是同步 store.set → 立即回调），此时 DOM 已卸载，
   * applyStyles 读 DOM 会抛 undefined 错并沿 Svelte update 栈冒泡，
   * **销毁整棵组件树**（用户表现为「设置面板一点就关闭」）。
   */
  let isDestroyed = false;
  function applyStyles() {
    if (applyingStyles) return; // 拒绝同步重入（异步调用不受影响：同步段结束即释放）
    // 2026-10-06 设置弹窗崩溃修复：applyStyles 由 settingsStore 订阅回调同步触发。
    // 若此刻组件正在销毁（组件已销毁 / DOM 已卸载），applySiyuanDocMargin、
    // buildStyles 等会读 undefined 的 DOM 并抛错；异常沿 Svelte update 栈冒泡
    // 会**销毁整棵组件树** —— 用户看到的就是「设置面板一点就消失」。
    // 故此处三重守卫：已销毁 / DOM 未挂载 / 异常全兜。
    if (isDestroyed) return;
    if (typeof document === "undefined" || !readerViewEl?.isConnected) return;
    applyingStyles = true;
    try {
      applyStylesInner();
    } catch (e) {
      // 排版刷新失败不应拖垮阅读器；记录后可由下一次 settings 变更重试。
      logSwallow(e, "ReaderView.svelte · applyStyles", "warn");
    } finally {
      applyingStyles = false;
    }
  }
  function applyStylesInner() {
    // 跟随思源文档边距：开时把宿主 .protyle-wysiwyg 的水平 padding 同步为阅读器左右边距
    applySiyuanDocMargin();
    // 2026-09-25 页面宽度：widthPct（铺满95/正常80/宽松70）与上下边距 relay 给 foliate
    // 分页器 —— 分页器几何由自身 CSS 变量驱动（--_max-inline-size / --_margin-*），
    // 注入 iframe 的 body padding 会被其内联样式覆盖（旧「点击没反应」的真根因），
    // 换算见 paginator.js #beforeRender 的 reword 段；随后 forceRelayout 重排生效。
    if (view?.renderer?.style) {
      const pct = Math.min(100, Math.max(50, settings.layout.widthPct ?? 80));
      /* ============================================================
       * 页宽模式（2026-10-08 语义修正，对标 Readest `getMaxInlineSize`）
       * ------------------------------------------------------------
       *## 旧实现为什么让「固定书页」几乎不可用
       * 旧代码把 `fixedWidthPx`（注释写「内容总宽」）写进 `--_reword-content-fixed`，
       * 而 paginator 的 reword 段换算是：
       *   totalWidth = min(fixed, hostSize)
       *   perColumn  = totalWidth / divisor
       *   --_max-inline-size = perColumn       ← 输出的是**每列**宽
       * ⇒ 「书页总宽 720」被**除以栏数 2** 变成「每列 360px」。
       * 实测（书区 1030px）：用户把滑块从 560 拖到 1200，
       * 每列始终撑不到 600px（280→360→440→568），**拖到底也不变宽**。
       *
       *## Readest 的做法（utils/config.ts `getMaxInlineSize`）
       *   maxInlineSize 语义就是**每列的舒适宽度**，
       *   栏数由 foliate 依 `ceil(hostWidth / maxInlineSize)` 自己推，
       *   宿主**不插手瓜分**。
       *
       *## 现在的规则
       *  fixed：只写 `--_max-inline-size`（每列宽），**不碰栏数**；
       *        同时清空 pct/fixed 两个自有变量，避免两套机制并存再次错位。
       *  pct  ：走原有 reword 通路（它自己会算 perColumn），
       *        但必须**清掉** `--_max-inline-size`，否则 fixed→pct 切换会沿用旧的每列宽。
       * ============================================================ */
      if (settings.layout.widthMode === "fixed") {
        // 每列舒适宽度（不是书页总宽！）。区间与 schema 的 stepper 对齐。
        const col = Math.min(1000, Math.max(480, settings.layout.fixedWidthPx ?? 720));
        view.renderer.style.setProperty("--_max-inline-size", `${col}px`);
        // ⚠️ 必须清空 —— 否则 pct 通路仍会生效并覆写 --_max-inline-size，
        // 回到「总宽被瓜分」的错位状态（用户反馈的正是这个）。
        view.renderer.style.setProperty("--_reword-content-fixed", "");
        view.renderer.style.setProperty("--_reword-content-pct", "");
      } else {
        view.renderer.style.setProperty("--_reword-content-fixed", "");
        view.renderer.style.setProperty("--_reword-content-pct", String(pct));
        // pct 模式下每列宽由 paginator 的 reword 段覆写；
        // 但 fixed → pct 切换时必须清掉 fixed 留下的值，否则沿用旧的窄列宽。
        view.renderer.style.removeProperty("--_max-inline-size");
      }
      // 栏数上限：foliate 的 #top 默认样式里硬编码 `--_max-column-count: 2`
      // （我们没有覆盖它时，无论书页多窄都最多只有 2 栏 —— 这正是用户截图只有 2 栏的原因）。
      // 暴露成设置项后，「窄列 + 多栏」这种报纸式排版才表达得出来。
      // 默认 2 = foliate 原生值，不改变现有观感。
      const maxCols = Math.min(4, Math.max(1, Math.round(Number(settings.layout.maxColumnCount) || 2)));
      view.renderer.style.setProperty("--_max-column-count", String(maxCols));
      view.renderer.style.setProperty("--_reword-margin-top", `${settings.layout.marginTopPx}px`);
      // 下边距经applyBottomBarReserve() 计算（底栏展开时要额外补一段占位）。
      applyBottomBarReserve();
    }
    // 2026-10-08 顶栏浮层：把手命中区高度随上边距联动（见applyTopHandleHitHeight 注释）。
    // ⚠️ 必须放在 if (view?.renderer) **之外** —— 它写的是宿主 DOM 的 CSS 变量，
    // 与内容文档的 renderer 无关；PDF 模式下这段if 不执行，但圆点仍需正确尺寸。
    applyTopHandleHitHeight();
    if (view?.renderer?.setStyles) {
      try {
        view.renderer.setStyles(buildStyles());
      } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · applyStyles", "debug"); }
    }
    // 2026-09-02 修复：注入样式后主动触发一次重排，确保首次打开即按我们的 CSS 对齐。
    // foliate 的 setStyles 依赖 fontsReady().then(expand) 重排；若书籍内嵌字体用了
    // 思源/electron 无法加载的 scheme（如 tt001a.ttf → ERR_UNKNOWN_URL_SCHEME），
    // document.fonts.ready 可能迟迟不触发，导致首次排版仍按书内原样式（段落左缘不齐），
    // 直到窗口缩放 / 打开 DevTools 触发 ResizeObserver→expand 才对齐。
    // 这里直接调用公开的 Paginator.render() 强制重排，不依赖字体就绪。render() 内部
    // 自带 #views 空值守卫，open 过早时安全空转；用 rAF 等 style 标签文本被解析后再重排。
    // ⚠️ 注释里别写原始的 style/script 标签字面量：svelte-check 的 HTML 预扫描会把它们
    //    当成真标签，误吞脚本结束标签，报「script must have a closing tag」。
    const forceRelayout = () => {
      try {
        const r = view?.renderer as any;
        if (r?.render) r.render();
      } catch (__e) { logSwallow(__e, "ReaderView.svelte · applyStyles forceRelayout", "debug"); }
    };
    // 2026-09-05 调整：原为 rAF + setTimeout(120) 各一次 = 开书后全量重排 2 次，
    // 大书上这是启动卡死的放大器之一。改为**只在空闲窗口重排一次**：
    // 仍保留上面 09-02 的首次对齐修复，但不再紧跟启动密集布局期，也不重复排第二次。
    const idleCb = (globalThis as any)?.requestIdleCallback;
    if (typeof idleCb === "function") {
      try { idleCb.call(globalThis, forceRelayout, { timeout: 600 }); }
      catch (__e) { logSwallow(__e, "ReaderView.svelte · applyStyles idle", "debug"); }
    } else {
      requestAnimationFrame(forceRelayout);
    }
    // 同步容器兜底背景（深色模式切换时避免透出旧色/黑底闪屏）
    applyContainerBg();
    // 字体关键词重写（接管书内 serif/sans-serif/monospace 关键词，覆盖 div/span 布局的正文）：
    // 开启「强制覆盖书籍字体」时执行 —— 2026-10-07 删掉 `fontMode !== "system"` 判断
    //（「系统默认」档已砍；老设置档残留的 "system" 走的就是 follow-siyuan 那条栈，
    //  与其它档同权注入 --reword-*，行为一致且少一个不可达分支）。
    // 需等 --reword-* 变量真正落到内容文档，故推迟到下一帧（applyStyles 已把变量写入 :root）。
    if (settings.overridePublisherFont !== false) {
      requestAnimationFrame(() => applyFontKeywordRewrite());
    }
    // 2026-09-01 L0+L3：把内容 iframe 同步进 theme-bridge 注册表，
    // 新 iframe 注册时立即注入令牌；主题切换由 theme-bridge 统一重注（开书/翻页/主题切换全覆盖）。
    syncContentIframes();
  }

  /**
   * 给阅读容器设置与主题一致的兜底背景，避免 iframe 渲染前/透明时透出黑底（黑底闪屏根因之一）
   *
   * 2026-10-07 修复（真机反馈：「深色与浅色背景有时候会莫名闪烁不稳定」）：
   *
   * ## 闪烁的根因
   * 容器背景与书页背景原本是**两条各自独立的推导路径**：
   *   · 容器 `applyContainerBg()` → 自己算一遍 deriveStyleOutput → 设 container.background
   *   · 书页 `buildStyles()`          → 另算一遍 →交给 setStyles 注入 iframe
   * 思源切主题时，这两条**不在同一帧生效**（容器是同步 DOM 属性、书页要等
   * setStyles → iframe 重新渲染），中间那一两帧容器已换色、书页还是旧色
   * ⇒ 看到「闪一下」。
   * 上一轮我只把容器改成「也过deriveStyleOutput」，治了白底对撞，
   * 但**两条路径仍然各算一遍** —— 只要两次计算之间宿主变量被读到不同值
   * （思源切主题过程中 `--b3-*` 是逐条更新的，中间态就是两套值）就会闪。
   *
   * ## 修法：算一次、两处用
   * 本次 `resolvePalette()` 产出 `{ palette, output }`，
   * `applyContainerBg` 与 `buildStyles` **共用同一份结果**，从根上消除分叉。
   */
  function applyContainerBg() {
    if (!container) return;
    container.style.background = resolvePalette().output.bg;
  }

  /**
   * 主题切换期间给容器加一个**短暂的过渡色**，压住「容器已换、书页未换」的空档。
   *
   * ## 为什么需要（真机反馈「深色与浅色背景有时候会莫名闪烁不稳定」）
   * `view.renderer.setStyles()` 不是同步生效的 —— 它要等foliate 把样式注入
   * iframe 并重新渲染，跨**一到数帧**。而容器背景是同步 DOM 属性、立刻变色。
   * 于是切主题时会出现：
   *     第 1 帧：容器 = 新色，书页 = 旧色   ← 看到这一帧就是「闪一下」
   * resolvePalette() 消除了「两次计算读到不同值」的分叉，但**消不掉这个时间差**。
   *
   * ## 做法
   * 切主题那一刻先给容器上一个过渡色（由**旧主题**加深/提亮得到），
   * 等书页真正拿到新样式后再撤掉 —— 视觉上是「平滑过渡」而不是「闪」。
   */
  function bridgeThemeTransition() {
    if (!container || isDestroyed) return;
    // 只在「配色跟随思源」时才需要桥接：用户手动选了配色时，
    // 切思源主题不影响书页（明暗由 settings.themeMode 决定），不会闪。
    if (!followsSiyuanPalette()) return;
    try {
      const old = deriveStyleOutput(
        settings,
        themeOf(),
        LINE_WIDTH_PRESETS.normal,
        !isSiyuanDark(),
      ).bg;
      container.style.transition = "none";
      container.style.background = old;
      // 两帧后交还给 resolvePalette 的新色（此时 setStyles 已生效）
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (isDestroyed || !container) return;
          container.style.transition = "background 160ms linear";
          container.style.background = resolvePalette().output.bg;
          // 过渡结束后移除 transition，避免后续任何背景变更都带 160ms 过渡
          setTimeout(() => {
            if (container && isDestroyed === false) container.style.transition = "";
          }, 200);
        });
      });
    } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · bridgeThemeTransition", "debug"); }
  }

  /** 宿主当前是否深色（用于推导「旧主题」的对比方向） */
  function isSiyuanDark(): boolean {
    return siyuanThemeMode === "dark";
  }

  // 2026-08-27 晚（P2.2 专注模式）：滚动时高亮视口中心段落、其余淡出
  let focusScrollRaf: any = null;
  function onFocusScroll(doc: Document) {
    if (!(settings.focusMode && settings.flow === "scrolled")) return;
    if (focusScrollRaf) return;
    focusScrollRaf = requestAnimationFrame(() => {
      focusScrollRaf = null;
      highlightCenterParagraph(doc);
    });
  }
  /** 找视口垂直中心附近的 <p>/<li>/<blockquote>，给它加 .in-center（其余移除） */
  function highlightCenterParagraph(doc: Document) {
    const win = doc.defaultView;
    if (!win) return;
    const midY = win.innerHeight / 2;
    const paras = doc.querySelectorAll("p, li, blockquote");
    let best: Element | null = null;
    let bestDist = Infinity;
    for (const p of Array.from(paras)) {
      const r = (p as Element).getBoundingClientRect();
      if (r.bottom < 0 || r.top > win.innerHeight) continue; // 视口外跳过
      const c = r.top + r.height / 2;
      const d = Math.abs(c - midY);
      if (d < bestDist) { bestDist = d; best = p; }
    }
    for (const p of Array.from(paras)) p.classList.remove("in-center");
    if (best) best.classList.add("in-center");
  }
  /** 应用专注模式：给已挂载内容文档的 body 加/去 .reword-focus，并立即高亮一次 */
  function applyFocusMode() {
    if (!view?.renderer?.getContents) return;
    let contents: any[] = [];
    try { contents = view.renderer.getContents() || []; } catch { return; }
    const on = settings.focusMode && settings.flow === "scrolled";
    for (const c of contents) {
      const doc: Document | undefined = c?.doc;
      if (!doc?.body) continue;
      if (on) {
        doc.body.classList.add("reword-focus");
        highlightCenterParagraph(doc);
      } else {
        doc.body.classList.remove("reword-focus");
        doc.querySelectorAll(".in-center").forEach((el: Element) => el.classList.remove("in-center"));
      }
    }
  }

  /**
   * 分类字体关键词重写（2026-08-28，Readest 同款）：
   * 把 EPUB 作者样式表里的 serif / sans-serif / monospace 关键词替换成
   * --reword-* CSS 变量，让标题、各类 class 段落也走用户选的字体链。
   *
   * 2026-10-07：删掉 `fontMode === "system"` 早退（「系统默认」档已砍）。
   * 全部异常已被下游 try-catch 吞掉，最坏情况退化为「字体部分生效」，不影响阅读。
   *
   * 注意：foliate 翻页会重建内容文档 → 需在 relocate 后重复调用（见 handleRelocate 侧）。
   * @returns 被改写的规则条数（调试用）
   */
  function applyFontKeywordRewrite(): number {
    if (settings.overridePublisherFont === false) return 0;
    if (!view?.renderer?.getContents) return 0;
    try {
      return rewriteFontKeywordsInAllContents(() => view.renderer.getContents());
    } catch {
      return 0;
    }
  }

  function applyFlow() {
    if (view?.renderer?.setAttribute) {
      try {
        view.renderer.setAttribute("flow", settings.flow);
        // 模式切换后回到当前进度（foliate 重排可能复位到开头）
        if (progress > 0) {
          setTimeout(() => {
            try {
              view.goToFraction(progress);
            } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · applyFlow", "debug"); }
          }, 60);
        }
      } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · applyFlow", "debug"); }
    }
    // 2026-10-24：滚轮翻页只在分页模式挂监听 ⇒ 模式切换后要重新同步。
    syncWheelTurnMount();
  }

  /**
   * 翻页动画：**只**同步 `animated` 属性（2026-10-09 起不再有其它动画维度）。
   *
   * 🔴🔴 `animated` 是 foliate **所有**动画分支的总 gate：
   *   paginator.js:2323 / 2352 / 2529 / 3102 / 3902 全是 `hasAttribute('animated')`。
   *   漏设它 ⇒ 连 foliate 自带的朴素推移都没有（真机表现：翻页生硬跳转）。
   *   但删掉不会有任何编译错误，只在真机翻一页时才发现动画不见了。
   *
   * 第二个参数必须是**空字符串** —— 这是布尔式属性，`hasAttribute` 才认；
   * 传 `true` 会被当成字符串值，语义不对。
   *
   * ## 为什么不再设 `turn-style` 的具体值（2026-10-09）
   *
   * 原本支持 `default` / `slide` / `curl` 三档，后两者走 View Transitions API 的
   * **分层翻页**。真机实测两条都不好用，已连UI 一起整组删除：
   *  ① 阅读器是插件 iframe 套在思源宿主里，宿主之上还可能盖着别的插件的装饰层
   *     （如 Neo-Plus 纹理：`position:fixed; z-index:99; mix-blend-mode:multiply`）。
   *     VT 的快照与合成上下文不受我们控制 —— 实测只能做到「CSS 变量正确」，
   *     无法保证像素级与静态画面一致（见 docs/纹理闪烁-实测报告与方案.md）。
   *  ② 主力场景是纯文本书，卷页在纯文字上本质是「整页平移 + 阴影」，观感就是拖沓。
   *
   * 现在固定 `turn-style=""` = foliate 朴素推移：不依赖 VT、稳定、跟手。
   * 显式写空串而不是不设：renderer 可能被复用/重置，不设会残留上一次的 turn-style 值。
   */
  function applyTurnStyle() {
    if (view?.renderer?.setAttribute) {
      try {
        view.renderer.setAttribute("animated", "");
        view.renderer.setAttribute("turn-style", "");
      } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · applyTurnStyle", "debug"); }
    }
  }

  // [REword patch 2026-08-29] PDF 显示设置（spread / scroll-direction / 反色）
  // 仅 PDF 生效；对比「渲染器当前属性」判断是否需应用，避免无关设置变更时重建展开 / 重渲染。
  function applyPdfViewMode() {
    if (!isPdfBook() || !view?.renderer?.setAttribute) return
    const mode = settings.pdfViewMode ?? "single"
    const spread = mode === "double" ? "both" : mode === "book" ? "portrait" : "none"
    if (view.renderer.getAttribute("spread") === spread) return
    try { view.renderer.setAttribute("spread", spread) } catch (__e) { logSwallow(__e, "applyPdfViewMode", "debug") }
  }

  function applyPdfScrollDir() {
    if (!isPdfBook() || !view?.renderer?.setAttribute) return
    if (settings.flow !== "scrolled") return
    const dir = settings.pdfScrollDir ?? "vertical"
    if (view.renderer.getAttribute("scroll-direction") === dir) return
    try { view.renderer.setAttribute("scroll-direction", dir) } catch (__e) { logSwallow(__e, "applyPdfScrollDir", "debug") }
  }

  // 触发 foliate 重渲染当前页：pageColors 在 onZoom 时读取，setter 本身不重渲染。
  // 重设 zoom 属性可触发 attributeChangedCallback 无条件 #render()（见 fixed-layout.js:429）。
  function rerenderPdfPages() {
    if (!isPdfBook() || !view?.renderer) return
    try {
      const r = view.renderer as any
      const cur = r.getAttribute("zoom")
      if (cur != null) r.setAttribute("zoom", cur)
    } catch (__e) { logSwallow(__e, "rerenderPdfPages", "debug") }
  }

  function applyPdfInvert() {
    if (!isPdfBook() || !view?.renderer) return
    const want = !!settings.pdfInvert
    const r = view.renderer as any
    const prev = r._rewordPdfInvert ?? false
    if (prev === want) return
    r._rewordPdfInvert = want
    try {
      r.pageColors = want ? { background: "#000000", foreground: "#ffffff" } : {}
    } catch (__e) { logSwallow(__e, "applyPdfInvert set", "debug") }
    rerenderPdfPages()
  }

  function fmtPct(frac: number): string {
    if (!isFinite(frac)) return "";
    const p = Math.round(frac * 100);
    return p > 100 ? "100%" : `${p}%`;
  }

  /* ================= 翻页交互（注入 iframe 内 doc） ================= */

  // 2026-10-09：`setupZoneClick`（点击左右三分之一区域翻页）随clickToTurn UI 一并删除。
  // 理由：默认就是关的（防误触），且触屏设备完全不走这条路径（开头 isTouchDevice 就return），
  // 桌面端留着只是多一个「开了容易误触、关了没人用」的开关。
  // 翻页交互仍在：键盘方向键 / 工具栏翻页按钮 / 触屏手势 / 鼠标滚轮都未受影响。
  function injectPageTurn(doc: Document, s?: ReaderSettings) {
    if (!view) return;
    // 2026-08-27：Option+悬浮取词（英文）注入（与快捷键同文档挂载，统一由 trackDocListener 登记移除）
    setupHoverLookup(doc);

    const onKeyDown = (e: KeyboardEvent) => {
      const k = e.key;
      // 2026-08-27（revised）：⌘E / Ctrl+E 不再自研浮层，改为转发给父窗口，
      // 让思源原生「最近打开文档」切换器接管（焦点在 iframe 正文时父文档收不到按键）。
      if ((e.metaKey || e.ctrlKey) && k.toLowerCase() === "e") {
        e.preventDefault();
        forwardKeyToParent(e);
        return;
      }
      // 2026-08-28：Ctrl/Cmd+T 触发连续朗读（从选区或当前位置）
      if ((e.metaKey || e.ctrlKey) && k.toLowerCase() === "t") {
        e.preventDefault();
        ttsTogglePlay();
        return;
      }
      // F3 / Cmd+F：iframe 内按键不冒泡出主文档，需在 iframe 内自行响应
      if (k === "F3" || ((e.metaKey || e.ctrlKey) && k.toLowerCase() === "f")) {
        e.preventDefault();
        showSearch = true;
        showSettings = false;
        showMoreMenu = false;
        showToc = false;
        setTimeout(() => {
          try {
            searchInput?.focus();
          } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · onKeyDown", "debug"); }
        }, 30);
        return;
      }
      // 2026-10-10：? / Shift+/ 唤出快捷键面板。
      // 焦点在 iframe 正文时按键不冒泡出主文档，main document 的 onGlobalKey 收不到，
      // 必须在 iframe 内自行响应（与 F3 / Cmd+F 同因）。
      if (k === "?" || (k === "/" && e.shiftKey)) {
        e.preventDefault();
        e.stopPropagation();
        getBoundHintToggle()?.();
        return;
      }
      // 2026-08-29 修复：方向键翻页失效
      // 原方向键处理只在 iframe doc 内（focus 在 iframe 时才响应），
      // 焦点漂移到工具栏 / 批注 / 搜索框后失效。在 main document 也挂一份
      // onGlobalKey（capture 阶段）覆盖后，正常焦点位置都能翻页。
      //
      // 2026-10-10 二次修复：**保留** iframe 内直接调 view.goXxx。
      // ⚠️ 不同 document 的 keydown 事件**完全独立**，不会互相触发——
      //   焦点在 iframe 内时，main document 的 onGlobalKey 收不到事件；
      //   焦点在 main document 内时，iframe doc onKeyDown 收不到事件。
      //   两层 listener 不会双触发。所以 iframe 内必须**亲自**调 view.goXxx。
      // view=null 守卫：与 main document onGlobalKey 一致（defaultPageTurn 的 if (!view) return），
      //   即便 foliate 异步加载期间按方向键也不抛错。
      // 唯一的真正双翻风险：同一 document 内的两个 listener 都消费同一事件。
      //   现在 main document onGlobalKey 在 capture、iframe doc onKeyDown 在 bubble（target 阶段），
      //   它们在**不同 document**——stopPropagation 已经足够保险。
      if (k === "PageDown") {
        e.preventDefault();
        e.stopPropagation();
        view?.goRight?.();
      } else if (k === "PageUp") {
        e.preventDefault();
        e.stopPropagation();
        view?.goLeft?.();
      } else if (k === "ArrowRight") {
        // 2026-10-10：直接调 view.goRight()（不再按 flow 分流，分流交给 main doc onGlobalKey 的 defaultPageTurn）
        e.preventDefault();
        e.stopPropagation();
        view?.goRight?.();
      } else if (k === "ArrowLeft") {
        e.preventDefault();
        e.stopPropagation();
        view?.goLeft?.();
      } else if (k === "ArrowUp" || k === "ArrowDown") {
        // 2026-10-10：↑↓ 同样直接调 view（不依赖 main doc 转发）
        // 滚动模式：foliate 内 view.next/prev 接受 distance，按视口高度滚一段
        // 分页模式：与 ←→ 等价
        e.preventDefault();
        e.stopPropagation();
        const scrolled = (view as any)?.renderer?.scrolled;
        const forward = k === "ArrowDown";
        if (scrolled) {
          const size = Math.max(120, Number((view as any)?.renderer?.size) || 0);
          void (forward ? view?.next?.(size) : view?.prev?.(size));
        } else {
          void (forward ? view?.goRight?.() : view?.goLeft?.());
        }
      } else if (k === " ") {
        // 2026-08-28：TTS 播放中 Space = 暂停/继续（与 Readest 一致）；停止时 Space = 翻页
        if (ttsState === "playing" || ttsState === "paused") {
          e.preventDefault();
          ttsTogglePlay();
          return;
        }
        // Space 翻页：与 main doc onGlobalKey 走 defaultPageTurn 行为一致
        e.preventDefault();
        e.stopPropagation();
        const scrolled = (view as any)?.renderer?.scrolled;
        if (scrolled) {
          // 滚动模式：按视口滚一屏（与 ↑↓ 一致）
          const size = Math.max(120, Number((view as any)?.renderer?.size) || 0);
          void view?.next?.(size);
        } else {
          view?.goRight?.();
        }
      } else if (k === "Home") {
        e.preventDefault();
        e.stopPropagation();
        view?.goToTextStart?.();
      } else if (k === "End") {
        e.preventDefault();
        e.stopPropagation();
        const last = (view as any)?.book?.sections?.length
          ? (view as any).book.sections.length - 1
          : 0;
        view?.goTo?.(last);
      }
    };
    trackDocListener(doc, "keydown", onKeyDown);

    // 2026-08-29 Phase 1：触摸手势导航（仅触屏设备生效；桌面走键盘/点击分区）
    if (!isTouchDevice()) return;
    let touchX = 0;
    let touchY = 0;
    let touchT = 0;
    // 双指捏合缩放状态
    let pinchDist0 = 0;
    let pinchFont0 = 0;
    const PINCH_FONT_MIN = 12;
    const PINCH_FONT_MAX = 40;

    // [REword patch 2026-08-29] Phase 2 触屏手势增强
    // double-tap 检测（iOS Safari iframe dblclick 不稳定，手动 touchstart 检测）
    let lastTapT = 0;
    let lastTapX = 0;
    let lastTapY = 0;
    const DOUBLE_TAP_INTERVAL = 300;  // ms
    const DOUBLE_TAP_DIST = 24;       // px

    // 长按 500ms 弹菜单（查词/批注/翻译）
    let longPressTimer: any = null;
    let longPressStartX = 0;
    let longPressStartY = 0;
    const LONG_PRESS_MS = 500;
    const LONG_PRESS_MOVE_THRESHOLD = 12;  // px

    const touchDist = (e: TouchEvent): number => {
      if (e.touches.length < 2) return 0;
      const a = e.touches[0];
      const b = e.touches[1];
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        const t = e.touches[0];
        touchX = t.clientX;
        touchY = t.clientY;
        touchT = Date.now();
        // [REword patch 2026-08-29] Phase 2 长按检测启动
        // 500ms 静止触发长按弹菜单（仅单指）
        longPressStartX = t.clientX;
        longPressStartY = t.clientY;
        if (longPressTimer) clearTimeout(longPressTimer);
        longPressTimer = setTimeout(() => {
          longPressTimer = null;
          // [REword patch 2026-08-29] Phase 2 长按 500ms
          // 已有选区 → 触发划词流程（mouseup 走 onContentMouseUp → selToolbar 弹出）
          // 无选区 → 让系统默认长按选词菜单处理（iOS Safari / Android Chrome 自带）
          try {
            const sel = doc.getSelection?.();
            const text = sel && typeof sel.toString === "function" ? sel.toString().trim() : "";
            if (text && sel && !sel.isCollapsed) {
              // 模拟 mouseup 事件触发 selToolbar
              // 实际上 foliate 触屏的 mouseup 会被合成，这里直接用 selectionchange 已有路径
              // 触发条件：选区非折叠且有内容
              // selToolbar 通过 selectionchange 自动显示（已有逻辑）
              // 长按此处的作用是"延长选区停留时间"让 selectionchange 完成
              // 不需要额外动作
            }
            // 无选区：让浏览器原生长按选词菜单弹出
            // iOS Safari: long-press 触发 system selection toolbar
            // Android Chrome: long-press 触发 text selection magnifier
          } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · longPress", "debug"); }
        }, LONG_PRESS_MS);
      } else if (e.touches.length === 2) {
        // 记录捏合初值（仅记录，不在 start 改变字号）
        pinchDist0 = touchDist(e);
        pinchFont0 = settings.fontSize;
        // 多指触摸取消长按
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      } else {
        // 3+ 指：取消长按
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      }
    };
    trackDocListener(doc, "touchstart", onTouchStart, { passive: true });

    const onTouchMove = (e: TouchEvent) => {
      // 双指捏合：实时缩放字号，并阻止系统缩放/滚动
      if (e.touches.length === 2 && pinchDist0 > 0) {
        e.preventDefault();
        const d = touchDist(e);
        if (d > 0) {
          const ratio = d / pinchDist0;
          setFontSizeLive(Math.min(PINCH_FONT_MAX, Math.max(PINCH_FONT_MIN, pinchFont0 * ratio)));
        }
        // 移动超过阈值取消长按
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
        return;
      }
      // 单指移动超过阈值取消长按
      if (longPressTimer && e.touches.length === 1) {
        const t = e.touches[0];
        const dx = t.clientX - longPressStartX;
        const dy = t.clientY - longPressStartY;
        if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_THRESHOLD) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        }
      }
    };
    trackDocListener(doc, "touchmove", onTouchMove, { passive: false });

    const onTouchEnd = (e: TouchEvent) => {
      // 仍有手指按着（如捏合收尾过渡）不处理
      if (e.touches.length > 0) return;
      // 取消长按定时器（松手 = 不再触发）
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      // 捏合结束：复位，字号已由 move 实时写入（store 落盘）
      if (pinchDist0 > 0) {
        pinchDist0 = 0;
        return;
      }
      // 2026-10-25 移动端适配 A1：触屏选词接通划词工具栏。
      // 桌面靠 iframe mouseup（onContentMouseUp）→ scheduleReadSelection；
      // 触屏选词（长按选词/系统手柄）**不合成 mouseup**，桌面链路整条断死。
      // 松手时选区非折叠 → 直接走同一条读取链（复用全部定位/避让/重试逻辑）。
      try {
        const sel = doc.getSelection?.();
        if (sel && !sel.isCollapsed && typeof sel.toString === "function" && sel.toString().trim()) {
          scheduleReadSelection();
          return; // 有选区：不参与翻页/点按判定
        }
      } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · touchend selection", "debug"); }
      const c = e.changedTouches[0];
      if (!c) return;
      const dx = c.clientX - touchX;
      const dy = c.clientY - touchY;
      const dt = Date.now() - touchT;
      // [REword patch 2026-08-29] Phase 2 double-tap 检测
      // iOS Safari 的 dblclick 在 foliate iframe 内不稳定（容易和 mousedown 冲突），
      // 这里手动用 touchstart + 时间/距离判定模拟 dblclick。
      if (dt < DOUBLE_TAP_INTERVAL && Math.abs(dx) < DOUBLE_TAP_DIST && Math.abs(dy) < DOUBLE_TAP_DIST) {
        // 是 double-tap？
        const now = Date.now();
        if (now - lastTapT < DOUBLE_TAP_INTERVAL &&
            Math.abs(c.clientX - lastTapX) < DOUBLE_TAP_DIST &&
            Math.abs(c.clientY - lastTapY) < DOUBLE_TAP_DIST) {
          // double-tap 确认 → 触发缩放 toggle（仅 PDF）
          if (isPdfBook()) {
            try { onDblClickToggleZoom(); } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · double-tap", "debug"); }
          }
          lastTapT = 0;  // 重置（避免三连击触发两次）
          return;
        }
        // 第一次 tap：记录
        lastTapT = now;
        lastTapX = c.clientX;
        lastTapY = c.clientY;
        // delay 一下返回（让第二次 tap 有机会进 if 块）
      } else {
        lastTapT = 0;  // 距离/时间超 → 重置
      }
      // 横滑翻页（横向位移为主且超过阈值）
      if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy)) {
        if (dx < 0) void view.goRight();
        else void view.goLeft();
        return;
      }
      // 点按：短时长 + 几乎无位移 → 分区判定
      if (dt < 350 && Math.abs(dx) < 12 && Math.abs(dy) < 12) {
        // 排除文本选区（用户可能在选词，不应翻页/切工具栏）
        const sel = doc.getSelection();
        if (sel && !sel.isCollapsed) return;
        if (typeof sel?.toString === "function" && sel.toString().trim()) return;
        const w = doc.documentElement.clientWidth;
        if (w <= 0) return;
        const x = c.clientX;
        if (x < w * 0.33) void view.goLeft();
        else if (x > w * 0.67) void view.goRight();
        else toggleToolbar(); // 中心点击：唤起/隐藏工具栏（Readest 式沉浸阅读）
      }
    };
    trackDocListener(doc, "touchend", onTouchEnd, { passive: true });
  }

  /* ================= Option+悬浮取词（英文，2026-08-27） ================= */
  // 仅在 foliate 正文 iframe 内、按住 Option(altKey) 时，用 caretRangeFromPoint 取光标所在英文单词，
  // 复用现有离线词典引擎 + 富词卡弹窗。松开 Option / 光标离开单词（未落在弹窗上）→ 收起。

  /** 判断视口坐标是否落在当前词典弹窗内（让用户能把鼠标移进弹窗点 ★ / 候选词） */
  function isOverDictPopup(x: number, y: number): boolean {
    if (!dictPopupEl) return false;
    const r = dictPopupEl.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  function clearHoverHide() {
    if (hoverHideTimer) { clearTimeout(hoverHideTimer); hoverHideTimer = null; }
  }

  /** 延迟收起悬浮弹窗（给光标移到弹窗留缓冲；2026-08-27 放宽至 450ms，2026-08-30 增强容差） */
  function scheduleHoverHide(delay = 450) {
    clearHoverHide();
    hoverHideTimer = setTimeout(() => {
      hoverHideTimer = null;
      if (dictPopupSource === "hover") {
        dictPopup = { ...dictPopup, visible: false };
        dictPopupSource = null;
        hoverWord = null;
        hoverAnchorRect = null;
      }
    }, delay);
  }

  /** 显示悬浮词典弹窗（英文单词） */
  function showHoverDict(word: string, x: number, y: number) {
    clearHoverHide();
    hoverWord = word;
    dictPopupSource = "hover";
    dictPopup = { visible: true, x, y, html: renderLoading(), word, source: "hover" };
    setTimeout(async () => {
      // 期间来源/单词已切换则丢弃旧结果
      if (dictPopupSource !== "hover" || hoverWord !== word) return;
      let html: string;
      if (dictPopupMode === "online") {
        const r = await fetchOnlineDict(word);
        html = r
          ? renderOnlineDictCardSimple(r, { inVocab: isInVocab?.(word) ?? false })
          : renderDictSuggestions(word, searchCandidates(word, 3));
      } else {
        const entry = lookupSmart(word);
        if (entry) {
          html = renderDictCardSimple(parseDictEntry(entry), { showStar: true, inVocab: isInVocab?.(word) ?? false, onlineSwitchEnabled: dictCanSwitch });
        } else {
          html = renderDictSuggestions(word, searchCandidates(word, 3));
        }
      }
      dictPopup = { ...dictPopup, html };
    }, 30);
  }

  function setupHoverLookup(doc: Document) {
    if (!view) return;
    const WORD_RE = /^[A-Za-z][A-Za-z'’-]*$/;
    const getWordAt = (cx: number, cy: number): { word: string; rect: DOMRect } | null => {
      let range: Range | null = null;
      try {
        const anyDoc = doc as any;
        if (typeof anyDoc.caretRangeFromPoint === "function") {
          range = anyDoc.caretRangeFromPoint(cx, cy) as Range;
        } else if (typeof anyDoc.caretPositionFromPoint === "function") {
          const pos = anyDoc.caretPositionFromPoint(cx, cy) as any;
          if (pos && pos.offsetNode) {
            range = doc.createRange();
            range.setStart(pos.offsetNode, pos.offset);
            range.collapse(true);
          }
        }
      } catch {
        return null;
      }
      if (!range || range.startContainer.nodeType !== 3) return null;
      const node = range.startContainer as Text;
      const text = node.data;
      let start = range.startOffset;
      let end = range.startOffset;
      while (start > 0 && /[A-Za-z'’-]/.test(text[start - 1])) start--;
      while (end < text.length && /[A-Za-z'’-]/.test(text[end])) end++;
      if (start >= end) return null;
      const word = text.slice(start, end);
      if (!WORD_RE.test(word)) return null;
      const r = doc.createRange();
      r.setStart(node, start);
      r.setEnd(node, end);
      const rect = r.getBoundingClientRect() as DOMRect;
      if (!rect || (rect.width === 0 && rect.height === 0)) return null;
      return { word, rect };
    };

    const HOVER_TOLERANCE = 16; // px：悬浮取词容差带，轻微移动不消失（2026-08-30）
    const onMove = (e: MouseEvent) => {
      // iframe 内部 clientX/Y 是相对 iframe 视口的坐标，需加 frame 偏移换算成视口坐标，
      // 才能与父窗口弹窗 rect（getBoundingClientRect 返回视口坐标）正确比对 —— 否则
      // 移到弹窗途中 isOverDictPopup 恒为 false，弹窗被误判「未悬停」而提前收起。
      const frameEl = (doc.defaultView as any)?.frameElement as HTMLElement | null;
      const fr0 = frameEl?.getBoundingClientRect();
      const vx = e.clientX + (fr0?.left ?? 0);
      const vy = e.clientY + (fr0?.top ?? 0);
      if (!e.altKey) {
        // Option 释放：光标没落在弹窗上才宽限收起（落在弹窗上由 mouseenter 取消）
        if (dictPopupSource === "hover" && !isOverDictPopup(vx, vy)) {
          scheduleHoverHide();
        }
        return;
      }

      // —— Option 按住中：保持弹窗稳定，不轻易消失（2026-08-30 稳定性增强）——
      // 1) 已显示且光标仍在当前词「容差带」内（含轻微抖动/字形间隙）→ 保持，取消待收起
      if (dictPopupSource === "hover" && hoverAnchorRect && dictPopup.visible) {
        const a = hoverAnchorRect;
        const within =
          e.clientX >= a.left - HOVER_TOLERANCE && e.clientX <= a.right + HOVER_TOLERANCE &&
          e.clientY >= a.top - HOVER_TOLERANCE && e.clientY <= a.bottom + HOVER_TOLERANCE;
        if (within) {
          clearHoverHide();
          return;
        }
      }

      const found = getWordAt(e.clientX, e.clientY);
      // 2) Option 按住但没命中词（移到词间隙/标点/行尾）：保持现有弹窗，让用户继续阅读，
      //    绝不因轻微移动而消失（只有 alt 释放 / 离开 iframe / 离开弹窗 才收起）。
      if (!found) {
        clearHoverHide();
        return;
      }
      // 3) 同一单词且弹窗已显示：保持
      if (found.word === hoverWord && dictPopup.visible) {
        clearHoverHide();
        return;
      }
      // 4) 不同单词 → 仅当确实离开原词容差带才更新（容差带内不重复触发，避免抖动/闪烁）
      hoverAnchorRect = found.rect;
      // 计算弹窗定位（词下方居中）
      const frame = (doc.defaultView as any)?.frameElement as HTMLElement | null;
      let wx = found.rect.left + found.rect.width / 2;
      let wy = found.rect.bottom;
      if (frame) {
        const fr = frame.getBoundingClientRect();
        wx += fr.left;
        wy += fr.top;
      }
      const c = toContainerCoords(wx, wy + 4);
      let cx = c.x;
      let cy = c.y;
      // 左右防溢出（弹窗宽约 360，transform translateX(-50%) 以 cx 为中点）
      const stageW = readerStageEl?.clientWidth ?? readerViewEl?.clientWidth ?? 800;
      const half = Math.min(180, Math.max(20, stageW / 2 - 8));
      cx = Math.max(half, Math.min(stageW - half, cx));
      // 底部空间不足则翻到词上方（估计弹窗高度 ~320）
      const stageH = readerStageEl?.clientHeight ?? readerViewEl?.clientHeight ?? 600;
      if (cy + 320 > stageH) {
        let topVy = found.rect.top;
        if (frame) topVy += frame.getBoundingClientRect().top;
        const topC = toContainerCoords(found.rect.left + found.rect.width / 2, topVy - 8);
        cy = topC.y - 320;
        if (cy < 8) cy = 8;
      }
      showHoverDict(found.word, cx, cy);
    };

    trackDocListener(doc, "mousemove", onMove as EventListener);
    // 松开 Option：宽限收起（光标已在弹窗上则保留，由弹窗 mouseenter 取消收起）
    trackDocListener(doc, "keyup", ((e: KeyboardEvent) => {
      if (e.key === "Alt" && dictPopupSource === "hover") {
        // 2026-08-30 修复：iframe 内 clientX/Y 需加 frame 偏移才与父窗口弹窗坐标同基准，
        // 否则光标正好落在弹窗上时也被误判「未悬停」而提前收起。
        const frameEl = (doc.defaultView as any)?.frameElement as HTMLElement | null;
        const fr0 = frameEl?.getBoundingClientRect();
        const vx = e.clientX + (fr0?.left ?? 0);
        const vy = e.clientY + (fr0?.top ?? 0);
        if (!isOverDictPopup(vx, vy)) scheduleHoverHide();
      }
    }) as EventListener);
    // 光标离开正文 iframe：若正落在弹窗上则保留（由 popup mouseenter 接管），否则宽限收起
    trackDocListener(doc, "mouseleave", ((ev: MouseEvent) => {
      if (dictPopupSource !== "hover") return;
      const frameEl = (doc.defaultView as any)?.frameElement as HTMLElement | null;
      const fr0 = frameEl?.getBoundingClientRect();
      const vx = ev.clientX + (fr0?.left ?? 0);
      const vy = ev.clientY + (fr0?.top ?? 0);
      if (!isOverDictPopup(vx, vy)) scheduleHoverHide();
    }) as EventListener);
  }

  /* ================= 打开书籍 ================= */

  // 2026-09-08 启动卡死修复：上次启动卡死 → 暂停自动开书，等用户手动点「重新打开」。
  // 自愈标记（lastLaunchCrashed）只拦 restoreSession，拦不住思源直接重建 Tab 走本组件，
  // 不禁止会形成「恢复 → 卡死 → 再恢复」自锁循环。
  let pausedByCrash = false;
  async function manualReopen() {
    pausedByCrash = false;
    await openBook();
  }

  /**
   * 2026-09-05 诊断：开书看门狗。
   * 打开大书时若主线程被独占，logger 的 1 秒心跳会断流、排查不到卡在哪一步。
   * 这里每 300ms 打一条「当前停留在哪个阶段」，卡死后**最后一条日志**即指示卡死区间。
   * 只在开书期间运行（start/stop 成对），不会平时刷日志。
   */
  let openStage = "";
  let openWatchdog: any = null;
  let openT0 = 0;
  function markStage(s: string) {
    openStage = s;
    // 2026-09-08 冻结诊断：同步落盘——logger 默认异步缓冲，主线程冻结瞬间
    // 缓冲里的日志会丢；开书打点仅几条，同步写的开销可忽略（诊断期专用）。
    getLogger().info(`[REword] 开书阶段 → ${s}（累计 ${Date.now() - openT0}ms）`);
    getLogger().flushSync();
  }
  function startOpenWatchdog() {
    stopOpenWatchdog();
    openT0 = Date.now();
    openWatchdog = setInterval(() => {
      getLogger().info(`[REword] 开书看门狗：仍停留在「${openStage}」，已 ${Date.now() - openT0}ms`);
    }, 300);
  }
  function stopOpenWatchdog() {
    if (openWatchdog) {
      clearInterval(openWatchdog);
      openWatchdog = null;
    }
  }
  /** [开书细步] 2026-09-08 冻结诊断：应用样式/排版 区间内逐函数同步打点（落盘即消失风险零）。
   *  上轮证明冻结发生在此区间（「应用样式/排版」已打、「附加内容文档」未打、finally 未达），
   *  但区间内有 8 个调用无法定位是哪个。诊断结束后整体删除。 */
  function diagMark(step: string) {
    try {
      getLogger().info(`[REword] [开书细步] ${step}（累计 ${Date.now() - openT0}ms）`);
      getLogger().flushSync();
    } catch { /* ignore */ }
  }

  async function openBook() {
    errorMsg = "";
    console.log("[REword] openBook 开始", { bookId });
    // 2026-10-09 新增：切书时清空上一本文档的访问集。
    //
    // 🔴 为什么必须在这里清（而不是靠 restoreVisited 自然覆盖）：
    // `bookId` 是 Svelte prop，组件是**复用**的 —— 从 A 书切到 B 书时组件不重建。
    // 若不清，A 书的 href 会留在集合里 ⇒ B 书的目录里**凭空多出已读标记**，
    // 且随后 restoreVisited(B 的空集) 只会在 init 前跑，那时尚未落盘任何新值，
    // 串书的数据就真的写进了 B 的存储。
    //
    // 清成空集后由 restoreVisited(saved?.visitedHrefs) 在 init 前填回正确值。
    visitedHrefs = new Set<string>();
    tocReadCount = 0;
    startOpenWatchdog();
    markStage("取书籍文件");
    try {
      const blob = await store.getBlob(bookId);
      meta = store.get(bookId);
      if (!blob || !meta) throw new Error(t("书籍不存在或文件丢失"));
      console.log("[REword] openBook blob 就绪", { size: blob.size, format: meta.format });
      title = meta.title;
      // 2026-09-04 P0-3：开书立即设置 ink 上下文，让 currentPageStrokes 派生
      // 在用户首次 pointerdown 之前就能正确过滤出当前 bookId 的笔触，
      // 否则翻页后看到的是全部墨迹（其他书的也混进来）。
      if (bookId) setInkContext(bookId, 0);
      const name = `${meta.id}.${meta.format === "md" ? "md" : meta.format}`;
      const file = new File([blob], name, {
        type: /epub$/i.test(name) ? "application/epub+zip" : "",
      });
      const el = document.createElement("reword-foliate-view") as any;
      mountReaderContainer(container, el);
      view = el;
      setupAnnotationLayer();

      view.addEventListener("relocate", (e: any) => {
        const d = e.detail;
        const frac = typeof d?.fraction === "number" ? d.fraction : 0;
        progress = frac;
        if (!dragging) progressText = fmtPct(frac);
        totalSections = view.book?.sections?.length ?? 0;
        // [2026-09-01] Phase 1:PDF 当前页反推 + 标题联动「第 N/T 页」
        if (isPdfBook()) {
          const page = extractPdfCurrentPage(view, d);
          if (page > 0 && page !== pdfCurrentPage) {
            pdfCurrentPage = page;
            // 目录高亮跟随:找最近 ≤ 当前页 的 outline 节点
            const matchedHref = findNearestPdfOutlineHref(page);
            if (matchedHref && matchedHref !== activeHref) {
              activeHref = matchedHref;
            }
          }
          chapterLabel = pdfTotalPages > 0 ? t("第 {page}/{pages} 页", { page, pages: pdfTotalPages }) : "";
        } else {
          chapterLabel = d?.tocItem?.label ?? (totalSections ? t("第 {n}/{total} 节", { n: (d?.index ?? 0) + 1, total: totalSections }) : "");
        }
        currentSectionIndex = typeof d?.index === "number" ? d.index : currentSectionIndex;
        // 独立 Tab 模式：标题联动「书名 · 章节」
        if (onTitleChange) {
          onTitleChange(chapterLabel ? `${title} · ${chapterLabel}` : title);
        }
        // [2026-09-01] Phase 1:EPUB 走 tocItem.href;PDF 走 findNearestPdfOutlineHref(上面已算)
        // ⚠️ visitedChanged 只在**集合真的变大了**时置位（下面两处 add 成功后），
        //   它决定要不要把 visitedHrefs 带进本次落盘 —— 避免每次 relocate 都全量写数组。
        let visitedChanged = false;
        if (!isPdfBook()) {
          const href = d?.tocItem?.href;
          if (typeof href === "string" && href) {
            activeHref = href;
            if (!visitedHrefs.has(href)) {
              visitedHrefs = new Set(visitedHrefs);
              visitedHrefs.add(href);
              visitedChanged = true;
            }
            tocReadCount = visitedHrefs.size;
          }
        } else {
          // PDF 也累加访问过的目录(用于「已读 N/M」统计)
          const href = activeHref;
          if (href && !visitedHrefs.has(href)) {
            visitedHrefs = new Set(visitedHrefs);
            visitedHrefs.add(href);
            visitedChanged = true;
            tocReadCount = visitedHrefs.size;
          }
        }
        updateEta(frac);
        // 闸门 3 的活跃信号：翻页 / 滚动一定产生 relocate。
        // 这条最关键 —— 用键盘翻页、或长时间盯着同一页看时鼠标完全不动，
        // 若不把它算作活跃，静止阅读会被判空闲而停表（从「多计」翻成「少计」）。
        markReaderActivity();
        // [REword patch 2026-08-29] PDF 缩放状态一并保存
        const savePayload: any = { cfi: d?.cfi, fraction: frac };
        if (isPdfBook()) {
          savePayload.zoom = currentZoom;
          // 2026-09-09 修复：显式页码（1-based）。fraction 在 fixed-layout 下是页尾
          // 边界语义，恢复端反解会 +1 页；恢复改按页码精确换算（见 openBook 恢复分支）。
          savePayload.page = pdfCurrentPage;
        }
        // 2026-10-09 新增：「已读 N/M」落盘。
        //
        // ⚠️ 为什么不能只依赖 pendingSave 合并：`scheduleProgressSave` 是合并式
        // （`{...pendingSave, ...p}`），缩放路径只传 { zoom } 时会保留旧字段，
        // 所以这里显式带上当前集合 —— 但**每次 relocate 都全量写一遍**是浪费
        // （同一个数组序列化 600ms 内可能提交多次）。
        // ⇒ 只在「集合真的变了」时才带这个字段。
        if (visitedChanged) savePayload.visitedHrefs = serializeVisited();
        // [REword patch 2026-10-13] 跳过 fraction=0 的初始 relocate，避免覆盖已保存进度
        // `view.init` 会触发首次 relocate（fraction=0），若此时落盘会抹掉上次保存的 fraction，
        // 导致下次打开从第 1 页开始。只有用户真正翻页（fraction>0）才保存。
        if (frac > 0) {
          scheduleProgressSave(savePayload);
        }
        attachAllContentDocs();
        // 2026-08-28：滚动 / 跳转（relocate）也触发双语按需补译（内部 300ms 防抖）
        bilingualHandle?.onViewLoad();
      });

      view.addEventListener("load", (e: any) => {
        const doc = e.detail?.doc;
        if (doc) {
          // 用最新设置（用户可能在书架改过 flow）
          attachAllContentDocs();
        }
        // 2026-09-05 F3：持久化恢复的双语在此复核语言门槛（与 toggleBilingual 同一判定）
        if (bilingualPendingRestore) {
          bilingualPendingRestore = false;
          try {
            const detection = detectBookLanguage({
              metaLanguage: meta?.language || undefined,
              sampleTexts: collectSampleTexts(getContentDocs(), { maxChars: 2000 }),
            });
            if (detection.verdict === "other") {
              settingsStore.update({ bilingual: false });
              toast(t("本书未识别为英文书籍，已自动关闭双语对照"), 2800, "info" as any);
              getLogger().info(
                `[REword][双语] 恢复复核拦截非英文书：bookId=${bookId} source=${detection.source} conf=${detection.confidence}`,
              );
            } else {
              enableBilingual();
            }
          } catch (err) {
            // 判定异常时保守放行（unknown 语义），避免恢复流程卡死
            console.warn("[REword] 双语恢复语言判定异常（已放行）:", err);
            enableBilingual();
          }
        }
        // 2026-08-27 重设计：翻页 / 加载新内容后，双语译文按需补注入
        bilingualHandle?.onViewLoad();
      });

      markStage("foliate view.open（解析书籍文件）");
      // R1 收敛：按格式打开统一走 DocumentLoader → 适配器（行为等价于旧 view.open 分支）
      await DocumentLoader.openView(view, { bookId, name, file, title: meta.title });
      // 2026-09-02 中和书内 @font-face 的非法 scheme src；2026-10-06 兼做竖排标点替换。
      // 逻辑见 attachBookTransform（模块级）—— 勿往 openBook 里堆代码，见该函数上方说明。
      try {
        attachBookTransform((view.book as any)?.transformTarget, verticalPunctActive, verticalPunctHant);
      } catch (__e) { logSwallow(__e, "openBook fontFaceNeutralize", "debug"); }
      console.log("[REword] openBook view.open 完成");
      markStage("view.init（定位+首次渲染）");
      const saved = store.getProgress(bookId);
      // 2026-10-09 新增：在 view.init **之前**恢复「已读 N/M」的访问集。
      //
      // 🔴 时机是关键 —— 早一行就会丢数据：
      // `view.init` 会触发首次 relocate，而 relocate 里有
      // `if (visitedChanged) savePayload.visitedHrefs = serializeVisited()`。
      // 若在 init 之后恢复，首次 relocate 写回的是**空集**（或只剩 1 项），
      // 刚恢复的历史立刻被自己覆盖掉 ⇒ 表现为「第一次读完就只剩 1，重新打开又清零」。
      restoreVisited(saved?.visitedHrefs);
      // 2026-09-09 修复 PDF 进度恢复偏移（实锤机制）：fixed-layout 每次 relocate 固定
      // 上报 { fraction: 0, size: 1 } → SectionProgress.getProgress 把 fraction 算成
      // 「当前页的结尾边界」((index+1)/N)；恢复端 getSection 反解恰好落到下一页。
      // 每次开合会话 +1 页，多次累积即用户看到的「往后跳几页」。
      // PDF 改用显式页码恢复：fraction = (page-1)/N（PDF 每页 section.size=1000 均一），
      // getSection 精确回到该页起点。无 page 字段的旧数据回落 fraction（仍偏差 1 页内）。
      const pdfTotalSections = isPdfBook() ? (view.book?.sections?.length ?? 0) : 0;
      if (isPdfBook() && saved?.page && saved.page > 0 && pdfTotalSections > 0) {
        const frac = Math.min((saved.page - 1) / pdfTotalSections, 0.999);
        await view.init({ lastLocation: { fraction: frac }, showTextStart: false });
      } else if (saved?.fraction) {
        await view.init({ lastLocation: { fraction: saved.fraction }, showTextStart: false });
      } else {
        await view.init({ showTextStart: true });
      }
      console.log("[REword] openBook view.init 完成", {
        sections: view.book?.sections?.length ?? 0,
      });
      markStage("构建目录/章节标记");
      try {
        // [2026-09-01] Phase 1:PDF 与 EPUB 走不同数据源,但 tocItems 形态一致
        // R1 收敛：目录 / 分节 / PDF 大纲抽取统一走适配器（行为等价于旧分支）
        const loadedModel = await DocumentLoader.buildBookDoc(
          { bookId, name, file, title: meta.title },
          view
        );
        pdfTotalPages = loadedModel.book.pdfTotalPages ?? 0;
        tocItems = loadedModel.book.toc as any;
        // 折叠状态用平坦下标做 id ⇒ 换书必须重置，否则旧书的收起 id 会套在新书目录上
        tocCollapsed = new Set();
        // 上一本书的图是宿主 blob URL，section 卸载后引用计数归零即被 revoke
        // （vendor/foliate-js/epub.js:930-938）⇒ 灯箱留着只会显示破图，换书时一并关掉。
        closeImageViewer();
        totalChars = Array.isArray(view.book?.sections)
          ? view.book.sections.reduce((s: number, x: any) => s + (x.size || 0), 0)
          : 0;
        computeChapterMarks();
      } catch {
        tocItems = [];
        chapterMarks = [];
        pdfTotalPages = 0;
      }
      markStage("应用样式/排版");
      settings = settingsStore.get();
      diagMark("applyStyles 前");
      applyStyles();
      diagMark("applyStyles 后 / applyFlow 前");
      applyFlow();
      diagMark("applyFlow 后 / applyTurnStyle 前");
      applyTurnStyle();
      diagMark("applyTurnStyle 后 / applyPdfViewMode 前");
      applyPdfViewMode();
      applyPdfScrollDir();
      applyPdfInvert();
      diagMark("PDF 视图属性后 / 恢复缩放前");
      // [REword patch 2026-08-29] PDF 显示设置（spread / scroll-direction / 反色）
      // applyPdfViewMode/applyPdfScrollDir/applyPdfInvert 已上移至 PDF 视图属性细步
      // saved.zoom 是 per-file 持久化（ReadingProgress.zoom）
      if (isPdfBook()) {
        const savedZoom = store.getProgress(bookId)?.zoom;
        // [REword patch 2026-08-29] 移动端 PDF 适配 Phase 1
        // iPhone / Android Phone 降级模式：强制 fit-width（小屏 custom 缩放过小不可读）
        const initialZoom: ZoomState = isIphoneMode
          ? { kind: "fit-width" }
          : (savedZoom ?? { kind: "fit-page" });
        // 用 setTimeout 0 让 foliate-js 先完成初始渲染再 applyZoom，避免被首次 render 覆盖
        setTimeout(() => {
          applyZoom(initialZoom, { silent: true });
        }, 0);
      }
      diagMark("恢复缩放排程后 / prepareHostFontBlobs 前");
      // 2026-10-07：开书时同步一次思源正文字号（仅 fontSizeSync=true 时生效）。
      // 放在 applyZoom 之后、prepareHostFontBlobs 之前 —— 必须早于首次 applyStyles，
      // 否则首屏会先按旧字号渲染再跳一下（用户表现为「打开时字号闪一下」）。
      syncFontSizeFromSiyuan();
      // 问题 2：异步预热宿主字体 blob（完成后自动重刷 iframe 样式）
      prepareHostFontBlobs();
      try {
        view.renderer?.focusView?.();
      } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · try { view.renderer?.focusView?.(); }", "debug"); }
      opened = true;
      // [REword patch 2026-08-29] 确认是 PDF → 给页面四周留白区补上滚轮缩放监听
      if (isPdfBook()) bindStageWheel();
      diagMark("bindStageWheel 后 / 附加内容前");
      markStage("附加内容文档/刷新列表");
      attachAllContentDocs();
      attachTimer1 = setTimeout(attachAllContentDocs, 400);
      attachTimer2 = setTimeout(attachAllContentDocs, 1200);
      // 2026-10-24：滚轮翻页监听（分页模式才挂；连续滚动模式保持原生滚动的合成器优化）
      syncWheelTurnMount();
      // 2026-09-01 修复：开书时主动拉一次「本书摘录」数据,这样首点抽屉就有内容
      // 之前完全依赖「删除时刷新」,导致新建/编辑的标注永远不进列表
      refreshAnnotsList();
      refreshBookmarks();
    } catch (e: any) {
      console.error("[REword] openBook 失败:", e);
      // 错误分类 + 友好中文提示（2026-08-25 增强）
      const msg = String(e?.message || e || "").toLowerCase();
      if (msg.includes("unsupported") || msg.includes("format") || msg.includes("mobi") || msg.includes("azw")) {
        errorMsg = t("该文件格式暂不支持，建议转换为 EPUB 格式后重试。");
      } else if (msg.includes("parse") || msg.includes("xml") || msg.includes("opf") || msg.includes("container")) {
        errorMsg = t("书籍结构解析失败，文件可能已损坏或非标准 EPUB。");
      } else if (msg.includes("not found") || msg.includes("missing") || msg.includes("ENOENT")) {
        errorMsg = t("文件未找到，可能已被移动或删除。请重新导入。");
      } else {
        errorMsg = e?.message || t("打开失败，请检查文件格式是否正确。");
      }
    } finally {
      stopOpenWatchdog();
      getLogger().info(`[REword] 开书流程结束（末阶段=${openStage}，总耗时 ${Date.now() - openT0}ms，opened=${opened}）`);
    }
  }

  /**
   * [2026-10-24] 目录落点重定向。calibre 等书把 TOC 锚点钉在章节插图页 <body> 上，
   * 正文标题在下一节，导致点目录落到章节「上方几页」。跳转前把落点改到该章节首个带 id 的标题。
   * - 书本身锚点已精确指向标题（正常 EPUB）→ 原样返回，零回归；
   * - 锚点指向 <body>/缺失（calibre 类）→ 从锚点所在节向前扫描，命中首个带 id 的 h1–h6 并跳转。
   * 任何异常都退化回原 href，绝不阻断跳转。
   */
  async function refineTocLandingHref(v: any, href: string): Promise<string> {
    if (!v || !v.book || typeof href !== "string" || !href.includes("#")) return href;
    try {
      const book = v.book;
      const resolved = book.resolveHref?.(href);
      if (!resolved || typeof resolved.index !== "number") return href;
      const sections: any[] = book.sections || [];
      const baseIndex = resolved.index;
      const hash = href.split("#")[1] || "";
      const MAX_SCAN = 12;
      for (let i = baseIndex; i < Math.min(sections.length, baseIndex + MAX_SCAN); i++) {
        const sec = sections[i];
        if (!sec || typeof sec.loadText !== "function") continue;
        const txt = await sec.loadText();
        if (!txt) continue;
        const doc = new DOMParser().parseFromString(txt, "text/html");
        // 锚点本来就是具体元素（正常 EPUB，无论是否标题）→ 书本身精确，保持原行为，零回归
        if (i === baseIndex && hash) {
          const anchorEl = doc.getElementById(hash);
          if (anchorEl && anchorEl !== doc.body) return href;
        }
        const heading = doc.querySelector("h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]");
        if (heading && heading.id) {
          if (i === baseIndex && heading.id === hash) return href;
          if (i !== baseIndex) {
            console.log("[REword] TOC 落点重定向:", { from: href, to: `${sec.id}#${heading.id}` });
          }
          return `${sec.id}#${heading.id}`;
        }
      }
      return href;
    } catch (__e) {
      return href;
    }
  }

  async function goToc(href: string) {
    if (!view) return;
    try {
      // [2026-09-01] Phase 1:PDF 专用 href 格式 "pdf-page-N" → 走 foliate 的 page jump
      if (isPdfBook() && href.startsWith("pdf-page-")) {
        const page = parseInt(href.slice("pdf-page-".length), 10);
        if (page > 0) {
          await goPdfPage(page);
          showToc = false;
          return;
        }
      }
      const target = await refineTocLandingHref(view, href);
      await view.goTo(target);
      showToc = false;
    } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · goToc", "debug"); }
  }

  /**
   * [2026-09-01] Phase 1:PDF 跳到指定页(工具栏「第 N/T 页」+ 大纲点击都用这个)
   * - foliate 公开了 `view.goToFraction(frac)` 但没有 `goToPage` 直接接口
   * - 兜底:用 iframe 内的 pdfjs viewer 派发 page 变更(优先)
   * - 再兜底:fraction = (page - 1) / totalPages
   */
  async function goPdfPage(page: number): Promise<void> {
    if (!view || !page || page < 1) return;
    const targetPage = Math.min(page, pdfTotalPages || page);
    // 方案 A:fraction 反推(对单/双页 spread 模式可能略不准,但能跳到大致位置)
    if (pdfTotalPages > 0 && view.goToFraction) {
      const frac = (targetPage - 1) / pdfTotalPages;
      try {
        await view.goToFraction(frac);
        // 同步本地状态(下次 relocate 会校正)
        pdfCurrentPage = targetPage;
        const matchHref = `pdf-page-${targetPage}`;
        if (activeHref !== matchHref) activeHref = matchHref;
        return;
      } catch { /* fallthrough */ }
    }
    // 方案 B:直接用 foliate-js 内部的 page jump(如果暴露)
    if ((view as any).goToPage) {
      try {
        await (view as any).goToPage(targetPage);
        pdfCurrentPage = targetPage;
        return;
      } catch { /* fallthrough */ }
    }
    // 方案 C:lastLocation 注入
    if (view.lastLocation) {
      view.lastLocation = { ...view.lastLocation, index: targetPage - 1 };
    }
  }

  /* ========= 2026-09-09 P1：矩形框选标注（图表/排版块 → 跳转链接 + 图片快照） =========
   * 参照思源内置 PDF 矩形标注：框选 → 落库(kind:"rect"，复用 pdfRects 归一化管线)
   * → 复制 markdown（链接行 + 图片行）→ 文档内点击链接深链回跳 → 矩形闪烁强调。
   * 框选交互在 stage 上的捕获层完成（覆盖 iframe，规避跨 iframe 事件不通）。 */

  let pdfRectMode = false;
  let pdfRectBusy = false;
  /** 拖拽中的预览矩形（stage 相对坐标） */
  let pdfRectDrag: { x0: number; y0: number; x1: number; y1: number } | null = null;
  /** PdfTextHlLayer 组件引用（跳转后闪烁强调用） */
  let pdfHlLayerComp: { flashRect(annId: string): Promise<void> } | null = null;

  function togglePdfRectMode(): void {
    pdfRectMode = !pdfRectMode;
    if (!pdfRectMode) pdfRectDrag = null;
  }

  function stagePoint(e: MouseEvent): { x: number; y: number } {
    const r = readerStageEl.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function onRectCaptureMouseDown(e: MouseEvent): void {
    if (e.button !== 0 || !pdfRectDrag || pdfRectBusy) return;
    e.preventDefault();
    const move = (ev: MouseEvent) => {
      const q = stagePoint(ev);
      pdfRectDrag = { ...pdfRectDrag!, x1: q.x, y1: q.y };
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      const q = stagePoint(ev);
      void finishPdfRect({ x0: pdfRectDrag!.x0, y0: pdfRectDrag!.y0, x1: q.x, y1: q.y });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  function onRectCaptureMouseDownStart(e: MouseEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    const p = stagePoint(e);
    pdfRectDrag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    onRectCaptureMouseDown(e);
  }

  $: pdfRectPreviewCss = pdfRectDrag
    ? `left:${Math.min(pdfRectDrag.x0, pdfRectDrag.x1)}px;top:${Math.min(pdfRectDrag.y0, pdfRectDrag.y1)}px;width:${Math.abs(pdfRectDrag.x1 - pdfRectDrag.x0)}px;height:${Math.abs(pdfRectDrag.y1 - pdfRectDrag.y0)}px;`
    : "";

  /** 2026-09-09 P1.3 高清快照：用 pdfjs 按「显示尺寸 × dpr × 2」重渲整页后按归一化矩形裁剪。
   *  依赖 vendored pdf.js 暴露的 view.book.rewordPdf；不可用或渲染失败返回 null，
   *  调用方回落原生 canvas 裁剪。面积上限 16M px，避免一次性占爆内存。 */
  async function renderHiResRectSnapshot(pageNo: number, r: { x: number; y: number; w: number; h: number }, tlCssW: number): Promise<Blob | null> {
    try {
      const pdfDoc = (view as any)?.book?.rewordPdf;
      if (!pdfDoc || typeof pdfDoc.getPage !== "function" || !(tlCssW > 0)) return null;
      const page = await pdfDoc.getPage(pageNo);
      if (!page || typeof page.render !== "function") return null;
      const vp1 = page.getViewport({ scale: 1 });
      if (!vp1 || !(vp1.width > 0)) return null;
      let scale = (tlCssW / vp1.width) * (window.devicePixelRatio || 1) * 2;
      const area = vp1.width * vp1.height * scale * scale;
      const MAX_PX = 16000000;
      if (area > MAX_PX) scale *= Math.sqrt(MAX_PX / area);
      const vp = page.getViewport({ scale });
      const cv = document.createElement("canvas");
      cv.width = Math.max(1, Math.floor(vp.width));
      cv.height = Math.max(1, Math.floor(vp.height));
      const ctx = cv.getContext("2d");
      if (!ctx) return null;
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const sx = Math.round(r.x * cv.width), sy = Math.round(r.y * cv.height);
      const sw = Math.max(1, Math.round(r.w * cv.width)), sh = Math.max(1, Math.round(r.h * cv.height));
      const out = document.createElement("canvas");
      out.width = sw; out.height = sh;
      const octx = out.getContext("2d");
      if (!octx) return null;
      octx.drawImage(cv, sx, sy, sw, sh, 0, 0, sw, sh);
      cv.width = 0; cv.height = 0; // 释放重渲画布位图内存
      return await new Promise<Blob | null>((res) => out.toBlob(res, "image/png"));
    } catch (e) {
      console.warn("[REword] 高清快照渲染失败，回落原生裁剪:", e);
      return null;
    }
  }

  /** 原生 canvas 裁剪（回落路径）：框选矩形（主文档坐标）∩ 页面 canvas（经 frame 偏移换算）→ PNG。
   *  2026-09-09 坐标系混用修复的换算保留在此；拿不到 canvas 或区域过小返回 null。 */
  async function cropCanvasRectSnapshot(doc: Document, fr: DOMRect, sel: SelRect): Promise<Blob | null> {
    try {
      const canvas = doc.querySelector("#canvas canvas") as HTMLCanvasElement | null;
      const cRect = canvas?.getBoundingClientRect();
      if (!canvas || !cRect || cRect.width <= 0) return null;
      const cTop = {
        left: fr.left + cRect.left, top: fr.top + cRect.top,
        right: fr.left + cRect.left + cRect.width, bottom: fr.top + cRect.top + cRect.height,
      };
      const ix = {
        left: Math.max(sel.left, cTop.left), top: Math.max(sel.top, cTop.top),
        right: Math.min(sel.right, cTop.right), bottom: Math.min(sel.bottom, cTop.bottom),
      };
      const sx = Math.round((ix.left - cTop.left) * (canvas.width / cTop.width));
      const sy = Math.round((ix.top - cTop.top) * (canvas.height / cTop.height));
      const sw = Math.round((ix.right - ix.left) * (canvas.width / cTop.width));
      const sh = Math.round((ix.bottom - ix.top) * (canvas.height / cTop.height));
      if (sw <= 2 || sh <= 2) return null;
      const out = document.createElement("canvas");
      out.width = sw; out.height = sh;
      const ctx = out.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
      return await new Promise<Blob | null>((res) => out.toBlob(res, "image/png"));
    } catch (e) {
      console.warn("[REword] 矩形快照失败（跳过图片行）:", e);
      return null;
    }
  }

  /** 2026-09-09 P1.3：右键菜单「复制链接」——按当前标注重建 markdown（链接行 + 图片行） */
  async function copyRectLink(annId: string): Promise<void> {
    if (!annId || !annStore || !bookId) return;
    const it = annStore.get(annId);
    if (!it || it.kind !== "rect") return;
    const page = it.pdfRects?.[0]?.page ?? it.page ?? 0;
    if (!page) return;
    const md = buildRectMarkdown(bookId, title, [{ page, id: it.id, assetPath: it.snapshotPath || "" }]);
    try {
      await navigator.clipboard.writeText(md);
      toast(t("链接已复制，粘贴到文档即可"));
    } catch {
      toast(t("剪贴板复制失败"));
    }
  }

  /** 框选完成：收集命中页 → 每页归一化（与高亮/重绘同基准）+ 快照 + 落库 → 汇总复制 markdown。
   *  2026-09-09 P1.3：支持跨页框选（每页各存一段标注 + 快照 + 链接行）；
   *  快照优先 pdfjs 2x 重渲（清晰度），失败回落原生 canvas 裁剪。 */
  async function finishPdfRect(d: { x0: number; y0: number; x1: number; y1: number }): Promise<void> {
    pdfRectDrag = null;
    const left = Math.min(d.x0, d.x1), top = Math.min(d.y0, d.y1);
    const width = Math.abs(d.x1 - d.x0), height = Math.abs(d.y1 - d.y0);
    if (width < RECT_MIN_PX || height < RECT_MIN_PX) return; // 误触
    if (!view || !bookId || pdfRectBusy) return;
    const stageRect = readerStageEl.getBoundingClientRect();
    const sel: SelRect = {
      left: stageRect.left + left, top: stageRect.top + top,
      right: stageRect.left + left + width, bottom: stageRect.top + top + height,
    };
    let contents: any[] = [];
    try { contents = (view as any)?.renderer?.getContents?.() || []; } catch { contents = []; }
    if (!contents.length) { toast(t("PDF 未就绪")); return; }

    // 收集页信息 + 命中页（重叠两个方向都 > 8px 才算）
    const frames: Array<{ index: number; c: any; fr: DOMRect; rect: SelRect }> = [];
    for (const c of contents) {
      const frame = c.doc?.defaultView?.frameElement as HTMLElement | null;
      if (!frame) continue;
      const fr = frame.getBoundingClientRect();
      frames.push({ index: c.index ?? 0, c, fr, rect: { left: fr.left, top: fr.top, right: fr.right, bottom: fr.bottom } });
    }
    const hits = collectPageHits(sel, frames);
    if (!hits.length) { toast(t("框选区域不在页面上")); return; }

    if (!annStore) { try { annStore = getAnnotationStore(); } catch { annStore = null; } }
    if (!annStore) { toast(t("批注存储不可用")); return; }

    const hitIndexSet = new Set(hits.map((h) => h.index));
    const entries: RectMdEntry[] = [];
    pdfRectBusy = true;
    try {
      for (const f of frames) {
        if (!hitIndexSet.has(f.index)) continue;
        const doc: Document = f.c.doc;
        // 归一化基准与高亮/重绘两端统一：相对 iframe 内 .textLayer（取不到回落 frame 框）
        let tl: DOMRect | null = null;
        try { tl = (doc.querySelector(".textLayer") as HTMLElement | null)?.getBoundingClientRect() ?? null; } catch { tl = null; }
        const baseLeft = f.fr.left + (tl ? tl.left : 0);
        const baseTop = f.fr.top + (tl ? tl.top : 0);
        const bw = (tl && tl.width > 0 ? tl.width : f.fr.width) || 1;
        const bh = (tl && tl.height > 0 ? tl.height : f.fr.height) || 1;
        const norm = normalizeSelToRect(sel, baseLeft, baseTop, bw, bh);
        if (!norm) continue;
        const page = f.index + 1;
        const pdfRect: PdfRect = { ...norm, page };

        // 1. 快照：优先 pdfjs 2x 重渲（清晰度），失败回落原生 canvas 裁剪
        let assetPath = "";
        let blob = await renderHiResRectSnapshot(page, pdfRect, tl ? tl.width : 0);
        if (!blob) blob = await cropCanvasRectSnapshot(doc, f.fr, sel);
        if (blob) {
          // putFile 路径必须带 /data 前缀；失败返回 null（不抛异常），此时跳过图片行
          const fname = `reword-rect-${Date.now()}-${page}.png`;
          const putOk = await putFile(`/data/assets/${fname}`, false, blob);
          if (putOk != null) assetPath = `assets/${fname}`;
          else console.warn("[REword] 矩形快照写入 assets 失败（跳过图片行）: putFile 返回空");
        }

        // 2. 落库（kind:"rect"，复用 pdfRects 存储与重绘管线；snapshotPath 供删除时连带清图）
        const created = await annStore.upsert({
          blockId: `book:${bookId}`,
          docId: bookId,
          bookId,
          cfi: "",
          sentence: t("矩形框选 · P{page}", { page }),
          selectedText: "",
          note: "",
          origin: "manual",
          color: DEFAULT_ANNOTATION_COLOR,
          style: "highlight",
          type: "highlight",
          kind: "rect",
          group: "未分组",
          scope: "sentence",
          bookType: currentBookType(),
          page,
          pdfRects: [pdfRect],
          snapshotPath: assetPath || undefined,
        });
        entries.push({ page, id: created.id, assetPath });
      }

      if (!entries.length) { toast(t("框选区域不在页面上")); return; }

      // 3. 复制 markdown：每页一节（链接行 + 图片行），标题「书名 · 第 N 页」不带 id
      const md = buildRectMarkdown(bookId, title, entries);
      try {
        await navigator.clipboard.writeText(md);
        const hasImg = entries.some((e) => e.assetPath);
        const tail = hasImg ? t("（链接 + 截图）") : t("（链接）");
        toast(entries.length > 1
          ? t("跨 {n} 页框选已复制{tail}，粘贴到文档即可", { n: entries.length, tail })
          : t("矩形标注已复制{tail}，粘贴到文档即可", { tail }));
      } catch {
        toast(t("标注已保存，但剪贴板复制失败"));
      }
    } finally {
      pdfRectBusy = false;
    }
  }

  /**
   * [2026-09-01] Phase 1:从 foliate relocate 事件反推 PDF 当前页 + 目录高亮跟随
   * - PDF:用 extractPdfCurrentPage 拿页码 → 找到最近的目录节点 → 更新 activeHref
   * - EPUB:维持原 tocItem.href 逻辑
   */
  function findNearestPdfOutlineHref(page: number): string {
    if (!page || !tocItems.length) return "";
    // 找最后一个 page ≤ 当前页的 outline 节点
    let nearest = "";
    for (const it of tocItems) {
      const m = (it.href ?? "").match(/^pdf-page-(\d+)$/);
      if (!m) continue;
      const p = parseInt(m[1], 10);
      if (p && p <= page) nearest = it.href;
      else break;
    }
    return nearest;
  }

  // [2026-09-01] 修复：模板事件处理器里禁用 TS `as` 断言（Svelte 模板不允许），
  // 故把带 `as HTMLInputElement` 的逻辑收进脚本函数，模板仅引用。
  function onPageInputKeydown(e: KeyboardEvent) {
    if (e.key !== "Enter") return;
    const el = e.target as HTMLInputElement;
    const v = parseInt(el.value, 10);
    if (v > 0) goPdfPage(v);
  }
  function onPageInputChange(e: Event) {
    const el = e.target as HTMLInputElement;
    const v = parseInt(el.value, 10);
    if (v > 0) goPdfPage(v);
    // 失焦后回填(避免输入 999 但总页 500 时显示错误)
    el.value = String(pdfCurrentPage || "");
  }

  /* ================= TOC 展开 / 阅读统计 ================= */

  /** foliate toc 展开已收进适配器层（flattenFoliateToc），此处不再保留本地副本 */

  /** 剩余阅读时间估算（全书字符 × 进度 → 剩余字符 ÷ 实测/默认速度） */
  function updateEta(frac: number) {
    if (!totalChars || !isFinite(frac)) {
      etaText = "";
      return;
    }
    const readChars = Math.min(totalChars, totalChars * Math.max(0, frac));
    const remain = totalChars - readChars;
    if (remain <= 0) {
      etaText = t("已读完");
      return;
    }
    // 实测速度必须用「会话累计」activeMs —— 旧代码用 sessionReadMs（30s 滚动桶，
    // 每 30s 清零 → minsRead 恒 ≤ 0.5 → 下面的判断恒 false → 恒用 400 字/分默认值）
    const minsRead = activeMs / 60000;
    let speed = minsRead > 1 ? readChars / minsRead : 0; // chars/min 实测
    if (speed < 60) speed = 400; // 无实测数据时用默认速度
    const remainMin = remain / speed;
    if (remainMin < 1) {
      etaText = t("即将读完");
    } else if (remainMin < 60) {
      etaText = t("还剩 ~{n} 分钟", { n: Math.round(remainMin) });
    } else {
      const h = Math.floor(remainMin / 60);
      const m = Math.round(remainMin % 60);
      etaText = m ? t("还剩 ~{h} 小时 {m} 分钟", { h, m }) : t("还剩 ~{h} 小时", { h });
    }
  }

  /* ================= 阅读计时（四道闸门）=================
   * 原实现只有一个暂停条件 `!document.hidden`，实测三类越界（2026-09-12 污染 12 个有记录日
   * 中的 5 个 >6h、合计占全部日志 77%，峰值 9/1 = 20h16m；一本儿童分级读物累计 36h01m
   * 却只走了 8.3% 进度）：
   *   ① 切到别的页签照计 —— 非激活页签只是 display:none，组件不销毁、interval 照跑；
   *   ② 睡眠 / 挂起一次性补记 —— delta 无上限，合盖 8h 唤醒后整段写进当天；
   *   ③ 无空闲门槛 —— 开着书走人照计。
   * 历史虚高值无法回溯（readingLog 里没有活跃/空闲标记位），修后只保证今后准确。
   */
  const TIMER_TICK_MS = 1000;
  /** 待落盘阈值：满即写盘并清零 */
  const TIMER_FLUSH_MS = 30_000;
  /**
   * 闸门 2 · 单 tick 间隔上限。超此值判为挂起（睡眠 / 窗口最小化 / 主线程长任务），
   * **丢弃该段而不是截断** —— 截断会把「睡了 8 小时」记成 5 秒，从虚高翻成虚低，同样是错值。
   * 取 5000ms 而非 1–2s：Electron 主线程长任务（导入书 / 批量重排）会让定时器延迟 2–3s，
   * 设太小会把正常卡顿误判为挂起。
   */
  const TIMER_GAP_MAX_MS = 5_000;
  /**
   * 闸门 3 · 空闲上限（ms）。⚠️ 宁松勿紧：读书时几分钟不动鼠标是常态（盯着同一页思考），
   * 阈值定太紧会从「多计」翻转成「少计」——后者更伤信任（用户会以为掉数据）。
   * 无交互时**停止累加而不是归零**（保住已累计的部分）。0 = 关闭该闸门。
   */
  const TIMER_IDLE_MAX_MS = 180_000;
  /** 计入活跃的容器事件（capture + passive：回调只写时间戳，不干预默认行为） */
  const TIMER_ACTIVITY_EVENTS = ["pointerdown", "pointermove", "wheel", "keydown", "touchstart"] as const;

  /**
   * 闸门 1 · 容器是否真的可见。
   * 用 `offsetWidth > 0` 而非组件里既有的 `offsetParent === null` —— 后者在祖先为
   * position:fixed 时会返回 null 而**误判为不可见**；display:none 时 offsetWidth 恒为 0，
   * 语义精确，且是纯布局读取（每 tick 一次，成本可忽略）。
   */
  function timerContainerVisible(): boolean {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return false;
    return !!readerViewEl?.isConnected && readerViewEl.offsetWidth > 0;
  }

  /** 刷新活跃时刻（节流 1s：pointermove 是高频事件，这里只写时间戳、不读 DOM） */
  function markReaderActivity(): void {
    const n = Date.now();
    if (n - lastActivityAt < 1000) return;
    lastActivityAt = n;
  }

  /** 本地日期 key（YYYY-MM-DD），与 bookshelf-store 的 localDateKey 同口径 */
  function timerDayKey(ts: number): string {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  /** 落盘待累加量，并归入「累加所属日期」桶（闸门 4：不用落盘时刻取日期） */
  function flushReadingTime(): void {
    if (flushAcc <= 0) return;
    const n = flushAcc;
    flushAcc = 0;
    void store.addReadingTime(bookId, n, curDayKey || undefined);
  }

  /** 挂活跃信号（**容器级**，不挂 document 全局监听：避免干扰思源原生 UI） */
  function bindTimerActivity(): void {
    if (!readerViewEl) return;
    for (const ev of TIMER_ACTIVITY_EVENTS) {
      readerViewEl.addEventListener(ev, markReaderActivity, { capture: true, passive: true });
    }
  }
  function unbindTimerActivity(): void {
    if (!readerViewEl) return;
    for (const ev of TIMER_ACTIVITY_EVENTS) {
      readerViewEl.removeEventListener(ev, markReaderActivity, { capture: true });
    }
  }

  /** 窗口最小化 / 切回：重置基准，避免「回来第一 tick」被闸门 2 当成挂起、丢掉那 1s 真实阅读 */
  function onTimerVisibilityChange(): void {
    lastTickAt = Date.now();
    if (typeof document !== "undefined" && document.visibilityState === "visible") {
      lastActivityAt = Date.now();
    }
  }

  /** 阅读时长计时：每秒推进一次，四道闸门见上方常量注释 */
  function startTimer() {
    lastTickAt = Date.now();
    lastActivityAt = Date.now();
    curDayKey = timerDayKey(lastTickAt);
    timeTimer = setInterval(() => {
      const now = Date.now();
      const gap = now - lastTickAt;
      lastTickAt = now; // 无条件推进：否则切页签期间 gap 会累积成巨值
      if (!timerContainerVisible()) return;                                           // 闸门 1
      if (gap < 0 || gap > TIMER_GAP_MAX_MS) return;                                  // 闸门 2（丢弃，不截断）
      if (TIMER_IDLE_MAX_MS > 0 && now - lastActivityAt > TIMER_IDLE_MAX_MS) return;   // 闸门 3
      const day = timerDayKey(now);
      if (day !== curDayKey) { flushReadingTime(); curDayKey = day; }                 // 闸门 4（跨零点）
      flushAcc += gap;
      activeMs += gap;
      if (flushAcc >= TIMER_FLUSH_MS) flushReadingTime();
    }, TIMER_TICK_MS);
  }

  /** 组件键盘快捷键：F3/Cmd+F 搜索（挂在组件容器上；多 Tab 时非激活 Tab 隐藏不响应）。
   *  ⌘E「最近打开文档」不再自研：焦点在父容器时由思源原生 handler 直接接管，
   *  焦点在 foliate iframe 正文时由 iframe 内 keydown 转发给父窗口（见 forwardKeyToParent）。 */
  function onGlobalKey(e: KeyboardEvent) {
    // 非激活 Tab 容器 display:none → offsetParent 为 null，不响应
    if (container?.offsetParent === null) return;
    // 跳过输入控件（保留 input / textarea / contenteditable 原生行为）
    const t = e.target as HTMLElement | null;
    if (t && t !== document.body && (
      t.tagName === "INPUT" ||
      t.tagName === "TEXTAREA" ||
      t.isContentEditable
    )) return;
    // 矩形框选模式下 Esc 先退出（独立分支）
    if (e.key === "Escape" && pdfRectMode) {
      e.preventDefault();
      togglePdfRectMode();
      return;
    }
    // Esc 关闭全部浮层（开了目录/搜索/设置/快捷键面板只能用此键关）
    if (e.key === "Escape") {
      e.preventDefault();
      closeAllPopovers();
      return;
    }
    // 2026-10-10：? 与 Mac 的 Shift+/ 唤出/收起快捷键面板。
    // 顶层 bindGlobalShortcutHint 注册，BookshelfView 也可注册同一个 toggle。
    // ⚠️ boundHintToggle 模块级变量并不存在于本组件作用域，必须用 getBoundHintToggle()
    //   取顶层单例（否则按 `?` 抛 ReferenceError）。
    if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
      e.preventDefault();
      getBoundHintToggle()?.();
      return;
    }
    // 2026-09-09 C：Cmd/Ctrl + Z 撤销最近一次标注删除（不在注册表里，独立分支）
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "z" && pendingDelete) {
      e.preventDefault();
      void undoDelete();
      return;
    }
    // 2026-10-10 改造：单一真源 matchShortcut 替代硬编码 if-else
    // ↑↓/Space/Home/End/PageUp/PageDown 在注册表里映射为 prevPage/nextPage/prevSection/nextSection/goStart/goEnd。
    const action = matchShortcut(e, isMacPlatform());
    if (!action) return;
    // 翻页类 → defaultPageTurn（按 view 模式自动分流：滚动一屏 vs 整页翻）
    if (isPageTurnAction(action)) {
      e.preventDefault();
      defaultPageTurn(action, view);
      return;
    }
    // PDF 缩放与字号 ↑↓共用 "=" / "-"，注册表里都注册了；fontIncrease/Decrease 走 matchShortcut
    // 会先命中 fontIncrease/Decrease，故此处分流：PDF 时改走 zoomIn/Out。
    e.preventDefault();
    switch (action) {
      case "prevChapter":
        goPrevChapter();
        return;
      case "nextChapter":
        goNextChapter();
        return;
      case "openSearch":
        showSearch = true;
        showSettings = false;
        showMoreMenu = false;
        showToc = false;
        setTimeout(() => {
          try { searchInput?.focus(); } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · onGlobalKey", "debug"); }
        }, 30);
        return;
      case "toggleBookmark":
        void toggleCurrentBookmark();
        return;
      case "toggleTheme":
        toggleTheme();
        return;
      case "toggleFullscreen":
        toggleFullscreen();
        return;
      case "fontIncrease":
        if (isPdfBook()) { zoomIn(); } else { changeFont(1); }
        return;
      case "fontDecrease":
        if (isPdfBook()) { zoomOut(); } else { changeFont(-1); }
        return;
      // zoomReset/fitWidth/fitPage/cycleZoomPreset 走「Cmd/Ctrl+0/1/2/3」，
      // 与字号快捷键不撞键（不同主键），直接走注册表 action。
      case "zoomReset":
        if (isPdfBook()) zoomReset();
        return;
      case "fitWidth":
        if (isPdfBook()) fitWidth();
        return;
      case "fitPage":
        if (isPdfBook()) fitPage();
        return;
      case "cycleZoomPreset":
        if (isPdfBook()) cycleZoomPreset();
        return;
      // openTTS / openSettings 故意不接（与思源/浏览器冲突，wired: false）
      case "openTTS":
      case "openSettings":
        return;
      default:
        return;
    }
  }

  // 顶层提示面板 toggle：onMount 注册，onDestroy 注销。
  // 任何视图（ReaderView / BookshelfView / 未来的 Notebook）调一次即可，
  // 后续按 `?` 都会触发该 toggle。
  let disposeHintBind: (() => void) | null = null;

  /* ================= ⌘E 转发给思源原生「最近打开文档」 =================
   * 不自研浮层：焦点在 foliate iframe 正文时，keydown 不会冒泡到思源主窗口，
   * 故在此把 ⌘E/Ctrl+E 原样转发给父窗口（思源主文档），由思源原生快捷键接管。
   * 选中文档后思源自行为其新开 Tab，阅读 Tab 天然不被顶掉。 */

  function forwardKeyToParent(e: KeyboardEvent) {
    const pw = (window as any).parent;
    if (!pw || pw === window) return;
    const ne = new KeyboardEvent("keydown", {
      key: e.key,
      code: e.code,
      location: e.location,
      repeat: e.repeat,
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      bubbles: true,
      cancelable: true,
    } as KeyboardEventInit);
    try { pw.document.dispatchEvent(ne); } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · forwardKeyToParent", "debug"); }
  }


  /* ================= 搜索 ================= */

  /** 把书摘片段里命中词高亮成 <mark>（先转义再包裹，防 XSS） */
  function escapeHtml(s: string): string {
    return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  /** 结果摘录高亮（2026-10-25 搜索增强：按模式适配）。
   *  - contains：字面量转义匹配（原实现不变）
   *  - regex：foliate 的 excerpt 即命中文本本身 → 整段标出（query≠字面量，逐词反查会漏）
   *  - nearby-words：excerpt 含多个邻近词 → 按 query 分词逐词标（近似词无法精确映射，
   *    用哨兵字符两段替换避免嵌套 <mark>）
   */
  function highlightExcerpt(text: string, q: string, caseSensitive: boolean, mode: string = "contains"): string {
    const safe = escapeHtml(text || "");
    const q2 = (q || "").trim();
    if (!q2) return safe;
    if (mode === "regex") return `<mark>${safe}</mark>`;
    if (mode === "nearby-words") {
      const words = Array.from(new Set(q2.split(/[^\p{L}\p{N}]+/u).filter(Boolean)));
      let out = safe;
      for (const w of words) {
        const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        try {
          out = out.replace(new RegExp(esc, caseSensitive ? "g" : "gi"), (m) => `\u0001${m}\u0002`);
        } catch { /* 分词异常时退化为不高亮 */ }
      }
      return out.replace(/\u0001/g, "<mark>").replace(/\u0002/g, "</mark>");
    }
    const esc = q2.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(esc, caseSensitive ? "g" : "gi");
    return safe.replace(re, (m) => `<mark>${m}</mark>`);
  }

  /** 章节起始百分比（用于结果列表展示位置） */
  function sectionPercent(sectionIndex: number): number {
    const total = view?.book?.sections?.length ?? 0;
    if (!total) return 0;
    return Math.round((sectionIndex / total) * 100);
  }

  /* ============================================================
   * 底栏「页眉页脚」信息（2026-10-07 接通 showHeaderFooter）
   * ------------------------------------------------------------
   * ## 背景：这是一个存在已久的死设置
   * 设置里的「显示页眉页脚」此前把值拆成 `showHeader` / `showFooter` 写进 settings，
   * 但**这两个字段在执行层零命中**，且阅读器里**压根没有页眉/页脚 UI 组件**
   * ⇒ 开关能点、能存、什么都不会发生。
   *
   * ## 为什么接到底栏而不是新造页眉/页脚
   * ① 底栏已是既定交互（纯浮层 + 点击展开，见 applyBottomBarReserve）。
   *    新造常驻页眉/页脚会与「底栏浮层盖文字」的决策冲突，且要改分页器几何。
   * ② Readest 的 showHeader/showFooter 也是**浮在内容上方的带状 UI**，
   *    语义上与底栏同源，不是新东西。
   * ③ 底栏已有 progressText / etaText，加两行文本是纯增量、零几何改动。
   * ============================================================ */

  /**
   * 当前章节名。
   *
   * 取`tocItems` 中**起点不晚于当前 section** 的最后一项——
   * 这是Foliate 目录的标准语义（目录项指向 section 起点）。
   * 无目录（纯文本书）或索引异常时返回空串，调用方按「不显示」处理。
   */
  $: currentChapterTitle = (() => {
    if (!settings.layout.showHeader) return "";
    const idx = currentSectionIndex;
    if (idx < 0 || !Array.isArray(tocItems) || !tocItems.length) return "";
    let best = "";
    for (const item of tocItems) {
      const at = sectionIndexOfTocItem(item);
      if (at >= 0 && at <= idx) best = item.title;
      else if (at > idx) break;
    }
    return best.trim();
  })();

  /**
   * 剩余页数 / 总页数（Readest 的 showRemainingPages）。
   *
   * Foliate 的 `sections` 是 EPUB 的 section 数组（≈ 章节），
   * **不是页**——真实页数由 paginator 内部按版面折算，宿主侧拿不到。
   * 这里给的是「剩余章节 / 总章节」，文案上标注为章节，避免谎报页数。
   */
  $: remainingText = (() => {
    if (!settings.layout.showFooter) return "";
    const total = view?.book?.sections?.length ?? 0;
    if (!total) return "";
    const left = Math.max(0, total - (currentSectionIndex + 1));
    return t("剩余 {n} / {total} 章", { n: left, total });
  })();

  /** 目录项 → 它指向的 section 索引；解析不出返回 -1 */
  function sectionIndexOfTocItem(item: { href: string }): number {
    const href = String(item?.href ?? "");
    // 形如 "chapter1.xhtml#frag" 或 "text/part1.html"
    const file = href.split("#")[0];
    const list = view?.book?.sections ?? [];
    for (let i = 0; i < list.length; i++) {
      const s: any = list[i];
      const id = String(s?.id ?? s?.url ?? "");
      if (id && (id === file || id.endsWith("/" + file) || file.endsWith("/" + id))) return i;
    }
    return -1;
  }

  /* ================= 2026-10-25 搜索增强：模式 / 校验 / 历史 ================= */

  /** 正则长度上限：Calibre-parity 实现无 ReDoS 超时保护，长度闸 + 即时校验兜大部分风险 */
  const SEARCH_REGEX_MAX = 128;
  /** 历史上限（微信读书同量级；超出裁尾） */
  const SEARCH_HISTORY_MAX = 12;
  const SEARCH_UI_KEY = "reword-reader-search-ui";

  /** 正则即时校验（响应式）：合法性与长度。foliate 先试 'u' flag 再回落无 'u'，
   *  所以裸 new RegExp(q) 通过即保证 foliate 侧不抛 INVALID_REGEX。 */
  $: {
    regexError = null;
    if (searchMode === "regex") {
      const q = searchQuery.trim();
      if (q.length > SEARCH_REGEX_MAX) {
        regexError = t("正则过长（≤{n} 字符）", { n: SEARCH_REGEX_MAX });
      } else if (q) {
        try { new RegExp(q); }
        catch (e: any) { regexError = String(e?.message ?? e); }
      }
    }
  }

  /** 附近词仅对拉丁词形书有意义（Intl.Segmenter 词粒度 + 拼写近似语义）；
   *  以 EPUB dc:language 判定中日文书置灰（无语言元数据时不置灰，宁开放勿误锁）。 */
  function isNearbyWordsDisallowed(): boolean {
    const lang = (meta?.language || "").toLowerCase();
    return lang.startsWith("zh") || lang.startsWith("ja");
  }

  function loadSearchUiPrefs() {
    try {
      const raw = localStorage.getItem(SEARCH_UI_KEY);
      if (!raw) return;
      const o = JSON.parse(raw);
      if (o.mode === "regex" || o.mode === "nearby-words" || o.mode === "contains") {
        searchMode = o.mode;
      }
      if (Array.isArray(o.history)) {
        searchHistory = o.history.filter((x: unknown) => typeof x === "string" && x).slice(0, SEARCH_HISTORY_MAX);
      }
    } catch { /* 坏数据用默认 */ }
  }
  function persistSearchUi() {
    try {
      localStorage.setItem(SEARCH_UI_KEY, JSON.stringify({ mode: searchMode, history: searchHistory }));
    } catch { /* 隐私模式静默 */ }
  }

  function setSearchMode(m: typeof searchMode) {
    if (m === searchMode) return;
    searchMode = m;
    persistSearchUi();
    // 模式切换即重搜（同大小写/全字 change={startSearch} 的既有交互）
    if (searchQuery.trim() && !(m === "regex" && regexError)) void doSearch();
  }

  function pickSearchHistory(q: string) {
    searchQuery = q;
    void doSearch();
  }
  function clearSearchHistory() {
    searchHistory = [];
    persistSearchUi();
  }
  /** 搜索成功完成后记录历史：去重置顶、裁尾；仅普通模式（正则式子复用价值低且长） */
  function pushSearchHistory(q: string) {
    const list = [q, ...searchHistory.filter((x) => x !== q)].slice(0, SEARCH_HISTORY_MAX);
    if (list.length === searchHistory.length && list[0] === searchHistory[0]) return;
    searchHistory = list;
    persistSearchUi();
  }

  async function doSearch() {
    if (!view || !searchQuery.trim()) return;
    // 正则档：即时校验拦截（Enter / 防抖 / 按钮三入口都汇到这里）
    if (searchMode === "regex" && regexError) {
      toast(t("正则无效：{e}", { e: regexError }));
      return;
    }
    searching = true;
    searchResults = [];
    searchIndex = -1;
    try {
      const opts: any = {
        query: searchQuery.trim(),
        matchCase: searchCaseSensitive,
        matchWholeWords: searchWholeWord,
      };
      // 2026-10-25 搜索增强：模式透传（contains 走原路径不动；matcher 见 search.js:281）。
      // 边界：英文书上记住的 nearby-words 带到中日文书时回退普通（分词近似对 CJK 无意义）
      let effMode = searchMode;
      if (effMode === "nearby-words" && isNearbyWordsDisallowed()) effMode = "contains";
      if (effMode === "regex") opts.mode = "regex";
      else if (effMode === "nearby-words") opts.mode = "nearby-words";
      // 「当前章」范围：foliate 的 view.search({ index }) 只搜该 section
      if (searchScope === "chapter" && currentSectionIndex >= 0) {
        opts.index = currentSectionIndex;
      }
      const iter = view.search(opts);
      const flat: SearchHit[] = [];
      for await (const r of iter) {
        if (r === "done") break;
        if (r?.cfi) {
          // 单章搜索：结果直接是顶层 {cfi, excerpt}
          flat.push({
            cfi: r.cfi,
            cfis: r.cfis ?? [r.cfi],
            excerpt: r.excerpt ?? "",
            chapterLabel: chapterLabel,
            progressPercent: sectionPercent(currentSectionIndex),
          });
        } else if (r?.subitems) {
          // 全书搜索：结果嵌套在 subitems，且携带章节 label
          const label = r.label ?? "";
          const idx = typeof r.index === "number" ? r.index : -1;
          const pct = sectionPercent(idx);
          for (const sub of r.subitems) {
            if (!sub?.cfi) continue;
            flat.push({
              cfi: sub.cfi,
              cfis: sub.cfis ?? [sub.cfi],
              excerpt: sub.excerpt ?? "",
              chapterLabel: label,
              progressPercent: pct,
            });
          }
        }
      }
      searchResults = flat;
      searchIndex = flat.length ? 0 : -1;
      if (flat.length) await goSearchResultAt(0);
      // 2026-10-25 搜索增强：成功完成即记历史（仅普通模式）
      if (searchMode === "contains") pushSearchHistory(searchQuery.trim());
    } catch (e: any) {
      console.warn("[REword] 搜索失败:", e);
      // 2026-10-25：给用户可读反馈（此前静默清列表；正则非法等在此现形）
      toast(t("搜索失败：{e}", { e: String(e?.message ?? e).slice(0, 120) }));
    } finally {
      searching = false;
    }
  }

  async function goSearchResultAt(i: number) {
    if (!searchResults.length) return;
    const idx = Math.max(0, Math.min(i, searchResults.length - 1));
    searchIndex = idx;
    try {
      await view.goTo(searchResults[idx].cfi);
    } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · goSearchResultAt", "debug"); }
  }

  async function goSearchResult(delta: number) {
    if (!searchResults.length) return;
    const i = ((searchIndex + delta) % searchResults.length + searchResults.length) % searchResults.length;
    await goSearchResultAt(i);
  }

  /** 输入即搜（防抖 300ms），空查询清空结果 */
  function onSearchInput() {
    if (!searchQuery.trim()) {
      searchResults = [];
      searchIndex = -1;
      if (searchDebounce) clearTimeout(searchDebounce);
      return;
    }
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => void doSearch(), 300);
  }

  function onSearchKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (searchDebounce) clearTimeout(searchDebounce);
      void doSearch();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      void goSearchResult(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      void goSearchResult(-1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeSearch();
    }
  }

  function startSearch() {
    void doSearch();
  }

  function closeSearch() {
    showSearch = false;
    clearSearch();
    // 2026-10-08 顶栏浮层化：与 toggleSearch 的关闭分支对称
    releaseTopBarForPopover();
  }

  // 左右翻页箭头「按住连翻」状态
  let turnPressed: "" | "prev" | "next" = "";
  let turnTimer: any = null;
  let turnInterval: any = null;

  function turnPrev() {
    void view?.goLeft?.();
  }

  function turnNext() {
    void view?.goRight?.();
  }

  /* ================= 2026-10-25 P0-2：上/下一章跳转 =================
   * foliate 的 renderer.prevSection()/nextSection()（paginator.js:3917 与
   * fixed-layout.js:1804 双实现，EPUB 分页与 PDF 通吃）按 section index 跳，
   * 天然符合"逻辑顺序"，RTL 书也不反向。长章节（网文类 TXT 一章几十页）
   * 从此不用一页页翻。快捷键 Alt+←/→（reader-shortcuts.ts 注册），底栏 ⏪/⏩ 同入口。 */
  function goPrevChapter() {
    if (!view) return;
    if (selToolbar.visible) closeSelToolbar();
    try { void (view.renderer as any)?.prevSection?.(); }
    catch (__e) { logSwallow(__e, "goPrevChapter", "debug"); }
  }

  function goNextChapter() {
    if (!view) return;
    if (selToolbar.visible) closeSelToolbar();
    try { void (view.renderer as any)?.nextSection?.(); }
    catch (__e) { logSwallow(__e, "goNextChapter", "debug"); }
  }

  // [REword patch 2026-08-29] 首尾页直达（对齐 PDF++ 「转到第一页 / 最后」）
  function goFirstPage() {
    if (!view) return
    try { view.goTo(0) } catch (__e) { logSwallow(__e, "goFirstPage", "debug") }
  }

  function goLastPage() {
    if (!view) return
    try {
      const last = view.book?.sections?.length
        ? view.book.sections.length - 1
        : 0
      view.goTo(last)
    } catch (__e) { logSwallow(__e, "goLastPage", "debug") }
  }

  /** 箭头按下：立即翻一页 + 长按 450ms 后每 260ms 连翻 */
  function arrowDown(dir: "prev" | "next") {
    if (turnPressed && turnPressed !== dir) {
      // 已在连翻另一方向 → 切换方向时先停旧定时器
      stopArrowRepeat();
    }
    turnPressed = dir;
    if (dir === "prev") turnPrev();
    else turnNext();
    if (turnTimer) clearTimeout(turnTimer);
    turnTimer = setTimeout(() => {
      turnTimer = null;
      turnInterval = setInterval(() => {
        if (dir === "prev") turnPrev();
        else turnNext();
      }, 260);
    }, 450);
  }

  function stopArrowRepeat() {
    if (turnTimer) clearTimeout(turnTimer);
    turnTimer = null;
    if (turnInterval) clearInterval(turnInterval);
    turnInterval = null;
    turnPressed = "";
  }

  function toggleSettings() {
    showSettings = !showSettings;
    settingsInitialTab = null;
    showSearch = false;
    showToc = false;
    // v1.3.0：打开设置时刷新本书 Token 累计显示
    if (showSettings) refreshBookTokenUsage();
    // 2026-08-28：打开设置时同步最新朗读设置（从持久化读入）
    if (showSettings) syncTtsCfg();
    // 2026-10-07：打开设置时同步一次思源正文字号。
    // 为什么除开书外还要再读一次：用户可能在「思源设置 → 外观」里改过字号，
    // 而阅读器 Tab 已经开着（没重新开书），只靠开书那一次会一直显示旧值。
    // 仍然只在 fontSizeSync===true 时生效，用户手动调过就不动。
    if (showSettings) syncFontSizeFromSiyuan();
    // 2026-10-08 顶栏浮层化：设置面板的锚点（⚙ 按钮）在顶栏里，
    // 顶栏若此刻是收起的，面板就会挂在一个不可见的锚点下方 ⇒ 保持顶栏可见。
    if (showSettings) ensureTopBarForPopover();
  }

  /**
   * 2026-10-14 双语重设计：顶栏「双语设置」入口 → 直接打开主设置弹窗并聚焦「双语翻译」Tab。
   * 取代此前委托给 plugin.openBilingualSettingsTab（ReaderPlugin 从未实现，实为空操作）的独立弹窗。
   */
  function openBilingualSettingsPanel() {
    showSettings = true;
    settingsInitialTab = "translate";
    showSearch = false;
    showToc = false;
    ensureTopBarForPopover();
  }

  /* ================= 2026-10-24 移动端适配 Phase 2.1：紧凑顶栏 ⋯ 溢出菜单 =================
   * 旧实现：{#if !isIphoneMode} 把顶栏右组（双语/设置/搜索）整组隐藏 → 手机上无入口（功能断头）。
   * 新实现：isCompactToolbar 时右组只留「进度 + ⋯」，以上功能收进溢出菜单。
   * 菜单模板见 more-menu 块（复用 .reader-popover：点空白收起 + 统一质感免维护）。 */
  function toggleMoreMenu() {
    showMoreMenu = !showMoreMenu;
    if (showMoreMenu) closeOtherPanels("more");
  }
  function onMoreToggleBilingual() {
    showMoreMenu = false;
    void toggleBilingual();
  }
  function onMoreBilingualSettings() {
    showMoreMenu = false;
    openBilingualSettingsPanel();
  }
  function onMoreSettings() {
    showMoreMenu = false;
    if (!showSettings) toggleSettings();
  }
  function onMoreSearch() {
    showMoreMenu = false;
    if (!showSearch) toggleSearch();
  }

  function clearSearch() {
    try {
      view?.clearSearch?.();
    } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · clearSearch", "debug"); }
    searchResults = [];
    searchIndex = -1;
    searchQuery = "";
  }

  function toggleSearch() {
    showSearch = !showSearch;
    if (showSearch) {
      showSettings = false;
      showToc = false;
      // 2026-10-08 顶栏浮层化：🔍 按钮在顶栏里，顶栏收起时搜索面板会挂在不可见锚点下。
      ensureTopBarForPopover();
    } else {
      clearSearch();
      // 关闭时解除「为浮层而保持顶栏可见」的临时状态（pinned 不动）
      releaseTopBarForPopover();
      // 2026-10-25 停靠联动：停靠模式下搜索是最后一个面板时，关闭 = 连带退出停靠
      if (sidebarPinned && !activeDrawer) {
        sidebarPinned = false;
        persistSidebar();
      }
    }
  }

  /* ================= 书签 / 摘录汇总（2026-08-29 新增） =================
   * 对齐 Obsidian weave 的「书签 + 摘录笔记汇总」沉淀链，补上 REword 缺的中间一段：
   *  - 书签：按当前页 CFI 记录位置，可跳转 / 删除，存进书架索引随书持久化
   *  - 摘录：把 annStore 里本书的高亮 / 批注汇总成列表，可跳转原文 / 删除 / 批量导出 Markdown
   */

  /** 当前位置 CFI：foliate 每次 relocate 都会把 cfi 写进 view.lastLocation */
  function currentCfi(): string {
    return String(view?.lastLocation?.cfi ?? "");
  }

  function refreshBookmarks() {
    const all = store?.getBookmarks?.(bookId) ?? [];
    // 2026-09-03 双保险：只显示与当前书籍 bookType 一致的书签（旧数据无字段则放行）
    const cur = currentBookType();
    bookmarks = all.filter((b: BookMark) => matchBookType(b.bookType, cur));
  }

  /**
   * 从 annStore 拉一次本书摘录(按 createdAt 倒序,已软删过滤)。
   * 2026-09-01 重构:不再每处写路径手动调本函数,改用 annStore.subscribe() 响应式;
   *   保留函数本体作为「立即同步」入口(开书 / 打开抽屉时用)。
   *
   * 过滤放宽:不再要求 it.cfi 必须有值——txt/md/fb2/pdf 等 foliate-js 不生成 cfi
   *   的格式,只要有 selectedText/sentence 就能在面板里展示。
   */
  function refreshAnnotsList() {
    if (!annStore) { try { annStore = getAnnotationStore(); } catch { annStore = null; } }
    if (!bookId) { annotsList = []; return; }
    const cur = currentBookType();
    // 文本摘录（现有 annStore）
    const anns: any[] = annStore
      ? (annStore.getByBook(bookId) || []).filter((it: any) => !it.deletedAt && matchBookType(it.bookType, cur))
      : [];
    // 2026-09-04 P0-3 改造：把墨迹笔触合并进同侧栏，统一按 createdAt 倒序。
    // 墨迹没有文本，title 用"墨迹 · p{N}"替代，跳转靠 pageIndex。
    // 标记 kind 字段供模板区分渲染（墨迹展示路径预览/笔刷，文本展示文字）。
    const inkItems: any[] = ($inkStrokes || [])
      .filter((s) => s.bookId === bookId)
      .map((s) => ({
        kind: "ink" as const,
        id: s.id,
        page: s.pageIndex,
        color: s.color,
        brush: s.brush,
        style: s.style,
        createdAt: s.createdAt,
        selectedText: "",
        sentence: t("墨迹 · p{n}", { n: s.pageIndex + 1 }),
        note: "",
        // 墨迹不可导出为文本 markdown，但 exportAnnots 走 selectedText 路径，
        // 留空串即可被 filter 过滤掉
      }));
    const combined = [...anns, ...inkItems];
    combined.sort((a: any, b: any) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0));
    annotsList = combined;
  }

  function closeOtherPanels(except: string) {
    if (except !== "marks") showMarks = false;
    if (except !== "toc") showToc = false;
    if (except !== "search") showSearch = false;
    if (except !== "settings") showSettings = false;
    // 2026-10-24 移动端适配 Phase 2.1：⋯ 溢出菜单纳入互斥体系
    if (except !== "more") showMoreMenu = false;
  }

  /** 在当前页加/删书签（同位置再点一次即移除） */
  async function toggleCurrentBookmark() {
    const cfi = currentCfi();
    if (!cfi) {
      toast(t("还拿不到当前位置，翻一页再试"));
      return;
    }
    const res = await store.toggleBookmark(bookId, {
      cfi,
      label: chapterLabel || "",
      excerpt: (progressText || "").trim(),
      bookType: currentBookType(),
    });
    bookmarks = res.list;
    toast(res.added ? t("已添加书签") : t("已移除书签"));
  }

  async function jumpBookmark(bm: BookMark) {
    showMarks = false;
    try {
      await (view as any)?.goTo(bm.cfi);
    } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · jumpBookmark", "warn"); }
  }

  async function removeBookmark(bm: BookMark) {
    bookmarks = await store.removeBookmark(bookId, bm.id);
  }

  async function jumpAnnot(it: any) {
    showMarks = false;
    // 2026-09-03 修复：PDF 标注可能无 CFI，回落到 page 页码跳转（goPdfPage 仅 PDF 有效）
    // 2026-09-09 B：PDF 的 CFI 语义是整页 section，goTo(cfi) 只能到页且不带页内定位，
    // 故 PDF 一律走下方「页码跳转 + flashRect」路径（文本标注也获得闪烁定位）；
    // EPUB 仍走 goTo(cfi)。
    if (it?.cfi && !isPdfBook()) {
      try {
        await (view as any)?.goTo(it.cfi);
        return;
      } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · jumpAnnot(cfi)", "warn"); }
    }
    // 墨迹的 page 是 0-based pageIndex（第 1 页 = 0），文本标注的 page 是 1-based，
    // 两者的「有效下限」不同：原先一律用 `it.page > 0` 会把**第 1 页的墨迹**挡在门外。
    // 2026-09-12：工作台「阅读标注」并入墨迹后，这条守卫必须按类型区分。
    const hasTargetPage = typeof it?.page === "number" && (it.kind === "ink" ? it.page >= 0 : it.page > 0);
    if (isPdfBook() && hasTargetPage) {
      try {
        // 2026-09-04 P0-3：墨迹 kind 时 page 是 0-based pageIndex，需 +1 转为 1-based 页码
        // （文本标注 page 已是 1-based，goPdfPage 期望 1-based）
        const targetPage = it.kind === "ink" ? it.page + 1 : it.page;
        await goPdfPage(targetPage);
        // 2026-09-09 P1.3：矩形标注跳页后闪烁定位（与深链回跳行为一致）
        // 2026-09-09 B：扩展到文本标注——覆盖层矩形都带 data-ann-id，
        // flashRect 对高亮/直线/波浪/批注同样生效（墨迹无矩形元素，跳过）。
        if (it.kind !== "ink") void pdfHlLayerComp?.flashRect(it.id);
      } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · jumpAnnot(page)", "warn"); }
    }
  }

  async function removeAnnot(it: any) {
    // 2026-09-09 C：删除进统一撤销窗口（矩形快照延迟到窗口结束才清理，撤销则保留）。
    // 记录先取快照（软删后仍需读到 snapshotPath），再交给 armUndoFor。
    if (!annStore) { try { annStore = getAnnotationStore(); } catch { annStore = null; } }
    const rec = annStore?.get?.(it?.id) ? { ...annStore.get(it?.id) } : null;
    // 2026-09-01 修复：removeAnnotationById 内部已调 refreshAnnotsList,这里去重
    await removeAnnotationById(it?.id ?? null, it?.cfi ?? "");
    armUndoFor(rec);
  }

  /**
   * 2026-09-09 B：「标注与摘录」条目类型标识。
   * 墨迹 ✎ / 矩形 ▭ / 批注 💬 / 文本按样式 ▮ 高亮 ━ 直线 ﹏ 波浪。
   * 此前混在「本书摘录」里一律只显示文字，高亮与批注分辨不出。
   */
  function annotGlyph(it: any): string {
    if (it?.kind === "ink") return "✎";
    if (it?.kind === "rect") return "▭";
    if (String(it?.type || "") === "annotate") return "💬";
    return ANNOTATION_STYLES[normalizeAnnotationStyle(it?.style)]?.icon || "▮";
  }

  /** 2026-09-09 B：条目类型文案（tooltip 用，说明这是什么标注） */
  function annotKindLabel(it: any): string {
    if (it?.kind === "ink") return t("墨迹");
    if (it?.kind === "rect") return t("矩形框选");
    if (String(it?.type || "") === "annotate") return t("批注");
    return t(ANNOTATION_STYLES[normalizeAnnotationStyle(it?.style)]?.label || "高亮");
  }

  /** 2026-09-04 P0-3：墨迹删除入口。直接调 store 的 removeStroke 触发 inkSaver 订阅自动落盘 */
  function removeInkStroke(it: any) {
    if (!it?.id) return;
    removeStroke(it.id);
    // inkStrokes 订阅会自动调 refreshAnnotsList，无需手动
  }

  /**
   * 把摘录 Markdown 写入指定的思源文档末尾（2026-10-08 新增）。
   *
   * ## 为什么只做「追加」不做「覆盖」
   * 覆盖会销毁用户文档已有内容，属**破坏性操作**。
   * 本项目既定原则是不给破坏性操作留无确认入口
   *（底栏改纯浮层、四边距不做覆盖，都是守这条）。
   * 想要独立快照的用户可以每次导出后自行移动/重命名。
   *
   * ## 为什么不新建文档而是追加
   * 「我的摘录」这类文档天然是长期累积的，追加语义更符合预期；
   * 新建文档会让用户每次导出多一个文件，反而更乱。
   */
  async function exportAnnotsToDoc(
    md: string,
    tplData?: ExportTemplateData,
    rawAnnotations?: any[],
  ): Promise<boolean> {
    // 2026-10-10：目标解析收敛到 resolveExportTargetAsync（per-book → 全局 → 导出时自动建档兜底）。
    // 改造前这里直接读 settings.exportDocId（全局单值），与per-book 设置会打架。
    const resolved = await resolveExportTargetAsync(bookId, store.get(bookId), settings, store);
    const target = resolved.target;
    if (!target) {
      toast(t("请先设置本书的笔记发送目标：书架上右键这本书，或到「设置 → 笔记与摘录」"));
      return false;
    }
    if (resolved.autoCreated) {
      toast(
        t("已自动建立《{doc}》并绑定为本书目标", {
          doc: String(store.get(bookId)?.title ?? "").trim() || target.docTitle || target.docId,
        }),
      );
    }
    const api = siyuanApiForPicker;
    if (!api?.appendBlock) {
      toast(t("思源接口未就绪，请稍后重试"));
      return false;
    }
    // 🔴 写入前**探活**：改造前 catch 一律 toast「目标文档可能已被删除」——
    // 但**网络失败、权限不足**也会走这句 ⇒ 误导。
    // 现在先区分「文档没了」与「写不进去」；
    // 且**文档没了也不清除绑定** —— 清了用户会以为自己的设置丢了。
    const alive = await probeDoc(api, target.docId);
    if (alive === false) {
      toast(t("目标文档《{doc}》已被删除，请重新设置发送目标", { doc: describeTarget(target) }));
      return false;
    }
    try {
      // appendBlock(parentId, dataType, data)：dataType 用 "markdown"
      // 直接写入 Markdown 源，渲染由思源负责（不自己拼 DOM）。
      await api.appendBlock(target.docId, "markdown", md);
      // 块属性补挂（2026-10-09，用户拍板「预设加块属性」）。
      // ⚠️ 必须在 appendBlock **之后** —— 块 ID 是写入后才存在的。
      //   失败只记日志：属性是增强功能，不该让整个导出失败。
      if (tplData) {
        try {
          const pairs = buildAttrPairs(
            tplData.annotations,
            tplData.book.title,
            tplData.book.id,
          );
          const r = await applyBlockAttrs(api, target.docId, pairs, md);
          if (r.tagged > 0) {
            getLogger().debug?.(
              `[RE 阅读器] 导出：已为 ${r.tagged}/${pairs.length} 条摘录挂上块属性`,
            );
          }
        } catch (__e) {
          logSwallow(__e, "ReaderView.svelte · exportAnnotsToDoc·attrs", "warn");
        }
      }
      // toast 带书名/文档名：多书场景下用户分不清发到哪了
      toast(
        t("已追加 {n} 条摘录到《{doc}》", { n: annotsList.length, doc: describeTarget(target) }),
      );
      return true;
    } catch (__e) {
      // 探活已排除「文档不存在」，走到这里多半是网络/权限/内核错误 —— 如实说
      logSwallow(__e, "ReaderView.svelte · exportAnnotsToDoc", "warn");
      const why = __e instanceof Error ? __e.message : String(__e);
      toast(t("写入文档失败（{why}）", { why }));
      return false;
    }
  }

  /**
   * 导出本书全部摘录（写入剪贴板，或追加到指定思源文档）。
   *
   * 2026-10-09：改走**模板引擎**。
   *
   * ## 为什么要模板化（改造前的三个问题）
   *
   * ① 不做章节分组 —— 所有摘录平铺，长书完全看不出层次；
   * ② 不做块属性 —— 写进思源后无法用 SQL 查（这是相对 Readest 的唯一差异化）；
   * ③ 间隔靠 `\n\n` 硬拼 —— 分不了组就控制不了间隔。
   *
   * ## 🔴 顺序不能变：校验 → 渲染 → 写入
   *
   * 任何一步失败都必须在**写入之前**中止。
   * Readest 的做法是把 `[Template Error: ...]` 写进导出结果（`utils/note.ts`），
   * 下载文件场景勉强可接受；我们是**往用户的思源文档里追加**，
   * 错误文本要用户手删，非常糟糕。
   */
  function exportAnnots() {
    if (!annotsList.length) {
      toast(t("本书还没有摘录"));
      return;
    }
    // 2026-09-04 P0-3：跳过墨迹（无文本，导出无意义）—— 只导文本摘录
    const textOnly = annotsList.filter((it: any) => it.kind !== "ink");
    if (!textOnly.length) {
      toast(t("没有可导出的文本摘录（墨迹不导出）"));
      return;
    }

    // ① 组装模板数据（章节分组 + mark 序号）
    const target = resolveExportTarget(bookId, store.get(bookId), settings);
    const tplData = buildExportTemplateData({
      book: {
        id: String(bookId || ""),
        title: title || t("阅读"),
        author: (meta as any)?.author || undefined,
        format: (meta as any)?.format || "epub",
      },
      annotations: textOnly,
      tocItems: (tocItems || []).map((t: any) => ({
        href: t?.href,
        label: t?.label ?? t?.title,
        level: t?.level,
      })),
      targetDocId: target?.docId,
    });

    // ② 校验（失败则中止，绝不写入错误文本）
    const tpl = String(settings.exportTemplate || "").trim() || defaultTemplate();
    const v = validateTemplate(tpl, sampleTemplateData());
    if (!v.ok) {
      toast(t("导出模板有错：{msg}", { msg: v.message }));
      return;
    }

    // ③ 渲染（引擎异常同样中止）
    let md: string;
    try {
      md = renderTemplate(tpl, tplData);
    } catch (__e) {
      logSwallow(__e, "ReaderView.svelte · exportAnnots·render", "warn");
      toast(t("导出模板渲染失败，已取消写入"));
      return;
    }

    // 2026-10-08：按 settings.exportTarget 分流到「剪贴板」或「思源文档」。
    // 默认 clipboard —— 与本函数改造前的行为完全一致，升级无感。
    if (settings.exportTarget === "doc") {
      // 块属性走两阶段补挂（`::xxx` 文本写法实测无效，见 attr-writer.ts）
      void exportAnnotsToDoc(md, tplData, textOnly);
      return;
    }
    try {
      navigator.clipboard?.writeText(md);
      toast(t("已导出 {n} 条摘录到剪贴板", { n: textOnly.length }));
    } catch (__swallowErr) {
      logSwallow(__swallowErr, "ReaderView.svelte · exportAnnots", "warn");
      toast(t("导出失败，请检查剪贴板权限"));
    }
  }

  /* ================= 设置操作 ================= */

  function changeFont(delta: number) {
    settings = settingsStore.update({ fontSize: Math.min(36, Math.max(10, settings.fontSize + delta)) });
    applyStyles();
  }

  /* ================= PDF 缩放（Phase 1） =================
   * foliate-js fixed-layout 已经原生支持 zoom + scale-factor attribute
   * （vendor/foliate-js/fixed-layout.js:204, 429-437），这里只是把状态管理 +
   * 快捷键 + 工具栏 + 持久化补齐。
   *
   * 缩放步进：按 ZOOM_PRESETS [0.5, 0.75, 1, 1.25, 1.5, 2] 找下一个/上一个档。
   * 默认 fit-page（foliate-js 原生默认）。
   */

  // 当前缩放状态（PDF only；EPUB 不会触发）
  let currentZoom: ZoomState = { kind: "fit-page" };
  // 上次 fit-width 之前的缩放（双击缩放切回用）
  let lastNonFitWidthZoom: ZoomState = { kind: "fit-page" };

  // [REword patch 2026-08-29] 移动端 PDF 适配 Phase 1
  // 设备分级（iPad / iPhone / Android Tablet / Android Phone / Desktop）
  let deviceClass: ReturnType<typeof getDeviceClass> = "desktop";
  // iPhone / Android Phone 降级模式（强制 fit-width + 工具栏底部 sheet）
  let isIphoneMode = false;
  // 2026-10-24 移动端适配 Phase 1/2.1：
  //  - viewportBp —— $viewport.breakpoint 的本地镜像（模板 class: 指令用）
  //  - isCompactToolbar —— 紧凑顶栏开关：手机（deviceClass 判定，含横屏）或窄视口（≤600px）。
  //    开启时右组收纳为「进度 + ⋯ 溢出菜单」（双语/设置/搜索进菜单，见模板 more-menu 块）。
  //    旧实现按 isIphoneMode 整组隐藏且无替代入口，手机上进不了设置/搜索 —— 已废弃。
  let viewportBp: ViewportBreakpoint = "desktop";
  $: viewportBp = $viewport.breakpoint;
  $: isCompactToolbar = isIphoneMode || isPhoneBreakpoint(viewportBp);
  // ⋯ 溢出菜单（紧凑顶栏专属）
  let showMoreMenu = false;

  /**
   * 是否 PDF 书籍。
   * [REword 2026-09-02] 改从 reader-mode 的唯一真源取值，避免这里与各处再散写
   * `meta?.format === "pdf"`（此前新增格式分流时极易漏改某一处）。
   */
  function isPdfBook(): boolean {
    return isPdfFormat(meta?.format);
  }

  /** 2026-09-03：当前书籍的 bookType（pdf/epub/other），用于「我的标记」抽屉双重保险过滤 */
  function currentBookType(): BookType {
    return bookTypeFromFormat(meta?.format);
  }

  /** 2026-09-04 P2：PDF 文本标注类型开关判定（EPUB 恒开；PDF 按设置过滤）。
   *  highlight=背景高亮；underline=直线段/波浪线；annotate=带批注内容气泡。 */
  function pdfAnnotEnabled(kind: "highlight" | "underline" | "annotate"): boolean {
    if (!isPdfBook()) return true;
    if (kind === "highlight") return settings.pdfAnnotHighlight !== false;
    if (kind === "underline") return settings.pdfAnnotUnderline !== false;
    return settings.pdfAnnotAnnotate !== false;
  }

  // [REword patch 2026-08-29] 移动端 PDF 适配 Phase 1
  // 设备类 resize 监听（onMount 注册，onDestroy 注销）
  /** 2026-08-30：非全屏模式 resize 适配——窗口尺寸变化后 foliate 偶发不重排，
   *  导致文本被裁 / 布局错乱。这里防抖触发一次重排：强制 reader-stage reflow
   *  + 向 foliate 内部 iframe 派发 resize（ResizeObserver 的补充保险）。
   *  全屏模式保持原样不动（用户要求全屏排版体验不变）。 */
  let readerRelayoutTimer: any = null;
  // [REword patch 2026-10-23] 拉伸 / 缩放窗口后阅读位置保位（方案 A · CFI 回锚）。
  // 根因：foliate 拉伸重排后靠 #anchor（可见 Range / 百分比）回锚——
  //   Range 在重渲染后失效→回退章节起点、百分比在重排后总页数变→映射错位，
  //   于是「拉伸后看到的位置不是拉伸前的位置、甚至更靠前」。
  // 修复：在 resize 手势开始时（foliate 尚未重排，lastLocation.cfi 仍是用户真实阅读位）
  //   抓取一次 CFI；手势落定（200ms 静默）后先让 foliate 重排（可能跳位），
  //   再按该 CFI 调 view.goTo 回锚——CFI 是内容坐标，任意重排都落同一段文字。
  //   PDF 不生成 cfi，自动跳过。
  let resizeGestureCfi: string | null = null;
  function scheduleReaderRelayout() {
    // 手势起始：抓取当前 CFI（仅抓一次，避免 foliate 重排期间的 relocate 污染）
    if (resizeGestureCfi === null) {
      const c = currentCfi();
      if (c) resizeGestureCfi = c;
    }
    if (readerRelayoutTimer) clearTimeout(readerRelayoutTimer);
    readerRelayoutTimer = setTimeout(() => {
      readerRelayoutTimer = null;
      if (!readerViewEl || !readerStageEl) { resizeGestureCfi = null; return; }
      // 1) 强制浏览器重排，确保 flex 高度已更新到最新窗口尺寸
      void readerStageEl.getBoundingClientRect();
      // 2) 向 foliate 内部 iframe 派发 resize，触发其列宽 / 分页重算
      try {
        const ifr = (view?.renderer as any)?.iframe as HTMLIFrameElement | null;
        ifr?.contentWindow?.dispatchEvent(new Event("resize"));
      } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · scheduleReaderRelayout", "debug"); }
      // 3) foliate 重排（可能跳位）落定后，按抓取的 CFI 回锚到真实阅读位。
      //    延后一小段：foliate 的 ResizeObserver 重锚是异步（render→scrollToAnchor），
      //    必须等它先完成，否则会被它的跳位覆盖。
      const anchor = resizeGestureCfi;
      resizeGestureCfi = null;
      if (anchor && !isPdfBook()) {
        setTimeout(() => {
          try { void view?.goTo(anchor); }
          catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · scheduleReaderRelayout goTo", "debug"); }
        }, 80);
      }
    }, 200);
  }

  function onDeviceClassResize() {
    const newCls = getDeviceClass();
    if (newCls !== deviceClass) {
      deviceClass = newCls;
      isIphoneMode = isSmallMobile();
      // iPhone 模式切换时强制 fit-width（避免小屏上 custom 缩放过小）
      if (isIphoneMode && isPdfBook() && currentZoom.kind === "custom") {
        applyZoom({ kind: "fit-width" });
      }
    }
    // 2026-08-30 改造：窗口尺寸变化时重算抽屉小尾巴，保证仍指向对应图标中心
    if (activeDrawer) computeDrawerTail(activeDrawer);
    // 2026-08-30：非全屏下窗口尺寸变化后强制 foliate 重排，避免文本被裁 / 遮挡。
    //            全屏模式保持原样（用户要求全屏排版体验不变）。
    if (!document.fullscreenElement) scheduleReaderRelayout();
  }

  /* ================= Apple Pencil 墨迹批注（Phase 3） =================
   * PointerEvent 监听（绑到 readerViewEl 容器，main 文档级）
   * 仅在 PDF + ink 模式（draw / erase）下拦截 pen / touch pointer events
   * 普通 click / 划词 / 翻页不被影响
   */
  function getInkPointerContext(e: PointerEvent): { x: number; y: number; pressure: number; tiltX: number; tiltY: number } | null {
    // pointerType 限制：pen（Apple Pencil）/ touch（手指）才处理
    if (e.pointerType !== "pen" && e.pointerType !== "touch") return null;
    // 转换为 reader-stage 容器相对坐标（ink 渲染层坐标系）
    const stageEl = readerStageEl;
    if (!stageEl) return null;
    const rect = stageEl.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      pressure: e.pressure || 0.5,
      tiltX: (e as any).tiltX || 0,
      tiltY: (e as any).tiltY || 0,
    };
  }

  function onInkPointerDown(e: PointerEvent) {
    // 仅 PDF + ink 模式（非 off）
    if (!isPdfBook() || $inkState.mode === "off") return;
    const ctx = getInkPointerContext(e);
    if (!ctx) return;
    // 拦截（不让 foliate iframe 收到这个事件）
    e.preventDefault();
    e.stopPropagation();
    // 设置 ink 上下文（bookId + pageIndex）
    if (bookId) setInkContext(bookId, 0); // 简化：pageIndex 暂用 0，后续按 foliate 当前页
    // 橡皮模式：删最近的笔触
    if ($inkState.mode === "erase") {
      // 简化：删除最后一个笔触（实际可改成 hitTest 删命中的）
      // 这里先简单实现，后续 Phase 改进
      const lastStroke = $currentPageStrokes[$currentPageStrokes.length - 1];
      if (lastStroke) {
        inkStrokes.update((arr) => arr.filter((s) => s.id !== lastStroke.id));
      }
      return;
    }
    // 画模式：开始新笔触
    const points: InkPoint[] = [{
      x: ctx.x, y: ctx.y, pressure: ctx.pressure,
      t: e.timeStamp, tiltX: ctx.tiltX, tiltY: ctx.tiltY,
    }];
    // 倾斜 > 45° 自动变荧光笔
    const effectiveBrush = shouldUseHighlighter(ctx.tiltX, ctx.tiltY)
      ? "highlighter"
      : $inkState.brush;
    const newStroke: InkStroke = {
      id: `ink-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      brush: effectiveBrush,
      color: $inkState.color,
      style: $inkState.style,
      baseWidth: $inkState.baseWidth,
      opacity: $inkState.opacity,
      points,
      path: catmullRomToBezierPath(points),
      createdAt: Date.now(),
      bookId: bookId || "",
      pageIndex: 0,
    };
    activeStroke.set(newStroke);
  }

  function onInkPointerMove(e: PointerEvent) {
    // 必须在 activeStroke 存在时（即 pointerdown 已触发）
    if (!isPdfBook() || $inkState.mode !== "draw") return;
    const cur = $activeStroke;
    if (!cur) return;
    const ctx = getInkPointerContext(e);
    if (!ctx) return;
    // getCoalescedEvents 拿所有原始点（避免 rAF 合并丢点）
    const coalesced = getCoalescedPoints(e as any);
    if (coalesced.length === 0) return;
    // 转为 stage 相对坐标：clientX/Y 减 readerStageEl 偏移
    // 简化：用 clientX/Y 减 readerStageEl 偏移（pointer 已经在 stage 内时）
    // 因 getInkPointerContext 已经返回了 stage 相对坐标，这里取最后一个 coalesced 点的偏移
    const stageEl = readerStageEl;
    if (!stageEl) return;
    const rect = stageEl.getBoundingClientRect();
    // offsetX/Y 是相对 target 元素（readerViewEl），需要补偿
    // 简化：用 ctx 的相对值近似
    const newPoints: InkPoint[] = coalesced.map((p) => ({
      x: p.x - e.offsetX + (e.clientX - rect.left),
      y: p.y - e.offsetY + (e.clientY - rect.top),
      pressure: p.pressure,
      t: p.t,
      tiltX: p.tiltX,
      tiltY: p.tiltY,
    }));
    // 合并到 activeStroke.points
    const mergedPoints = [...cur.points, ...newPoints];
    const updated: InkStroke = {
      ...cur,
      points: mergedPoints,
      path: catmullRomToBezierPath(mergedPoints),
    };
    activeStroke.set(updated);
  }

  function onInkPointerUp(_e: PointerEvent) {
    if (!isPdfBook() || $inkState.mode === "off") return;
    const cur = $activeStroke;
    if (!cur) return;
    // 完成笔触：加入列表
    addStroke(cur);
    activeStroke.set(null);
  }

  /* ================= PDF 缩放边界与工具（2026-08-29） =================
   * ZoomState.custom.scale 的合法区间（与 bookshelf-store.ts 的类型注释一致：0.25 - 4.0）
   */
  const MIN_PDF_ZOOM = 0.25;
  const MAX_PDF_ZOOM = 4.0;
  /**
   * 滚轮连续缩放灵敏度：factor = exp(-deltaY * k)。
   * 0.0018（原 0.0025 偏跳）→ 鼠标一格（截断后 deltaY≈60）约 ±10%，
   * 触控板捏合（deltaY≈10）约 ±1.8%，连续滚动更细腻。
   * 2026-09-08 四调：实测手感 OK 但每格步进偏小，0.0018 → 0.0026（约 ±14%/格）。
   */
  const WHEEL_ZOOM_SENSITIVITY = 0.0026;
  /** 单个 wheel 事件的 delta 上限：不同鼠标/驱动的 deltaY 差异极大（几十到几百都有），
   *  不截断的话一格滚轮能直接跳 30%+，手感很突兀。截断后靠连续滚动累积达到目标倍率。 */
  const WHEEL_MAX_DELTA = 60;
  /** 滚动模式：滚轮停止多久后才提交真实渲染（ms）。
   *  连续缩放期间靠 CSS transform 预览，停手才真正重绘页面 canvas。 */
  const SCROLL_ZOOM_COMMIT_DELAY = 180;
  /** 2026-09-08 缩放丝滑度修复：预览倍数指数平滑系数——每帧向目标靠近的比例。
   *  Mac Mouse Fix 等工具注入的 wheel delta 高频且不均匀，直接逐帧应用会导致
   *  预览倍数锯齿状跳变（画面抖动）。0.35 ≈ 每帧收敛 35%，6~8 帧（约 120ms）
   *  内贴合目标，肉眼呈连续曲线。纯 CSS transform，零重绘开销。 */
  // 2026-09-08 三调（借鉴 Mac Mouse Fix 动量手感）：固定 ease 无法兼顾「跟手」与「停手滑行」。
  // 输入期（距上次 wheel <120ms）用大 ease 快追目标 → 跟手；
  // 停手后切小 ease → 指数衰减长尾滑行，模拟触控板/浏览器 pinch 的动量收尾。
  const WHEEL_PINCH_EASE_ACTIVE = 0.30;
  const WHEEL_PINCH_EASE_GLIDE = 0.12;
  /** 最近一次 wheel 输入时间戳（performance.now），用于区分输入期 / 滑行期 */
  let lastWheelInputAt = 0;
  /** 提交推迟次数（预览未贴合时等贴合再提交，限 8 次防呆，约 +480ms 上限） */
  let wheelCommitDeferrals = 0;

  function clampPdfZoom(n: number): number {
    if (!isFinite(n) || n <= 0) return 1;
    return Math.min(MAX_PDF_ZOOM, Math.max(MIN_PDF_ZOOM, n));
  }

  /** 当前是否「滚动模式」：flow="scrolled" → foliate 内部 #scrollMode=true */
  function isScrollFlow(): boolean {
    try {
      return view?.renderer?.getAttribute?.("flow") === "scrolled";
    } catch (__swallowErr) {
      logSwallow(__swallowErr, "ReaderView.svelte · isScrollFlow", "debug");
      return false;
    }
  }

  /** 读 foliate 当前的 scale-factor 属性（百分数 → 倍数；未设置视为 1.0） */
  function readScaleFactorAttr(): number {
    try {
      const raw = view?.renderer?.getAttribute?.("scale-factor");
      if (raw == null || raw === "") return 1;
      const n = parseFloat(raw) / 100;
      return isFinite(n) && n > 0 ? n : 1;
    } catch (__swallowErr) {
      logSwallow(__swallowErr, "ReaderView.svelte · readScaleFactorAttr", "debug");
      return 1;
    }
  }

  /** 把 ZoomState 应用到 foliate view（实际调用 setAttribute） */
  function applyZoom(input: ZoomState, opts: { silent?: boolean } = {}) {
    if (!view?.renderer?.setAttribute) return;
    // custom 先 clamp 到合法区间，再统一用 zoom 这个局部变量走下面的分支
    // （注意：下面必须用 zoom.scale，test/pdf-zoom-apply.test.mjs 按源码文本断言这条）
    const zoom: ZoomState = input.kind === "custom"
      ? { kind: "custom", scale: clampPdfZoom(input.scale) }
      : input;
    currentZoom = zoom;
    const r = view.renderer;

    // [2026-08-29 修复] foliate 的两种布局用【完全不同】的缩放公式，写错属性就等于没缩放：
    //   分页模式  #render()          → scale = zoom × scaleFactor
    //                                  （fixed-layout.js:544-561）
    //   滚动模式  #renderScrollMode() → scale = (容器宽/页宽) × scaleFactor
    //                                  【zoom 属性完全不参与！】(fixed-layout.js:1130-1132)
    // 所以：分页模式用 zoom 承载、scale-factor 钉 100（否则 scale²）；
    //       滚动模式只能用 scale-factor 承载，zoom 保持 fit-width 作为基准。
    if (isScrollFlow()) {
      let sf = 1;
      if (zoom.kind === "custom") {
        // 滚动模式的基准是「适应宽度」，先把目标「实际缩放」换算成相对基准的倍数：
        //   当前实际缩放 = 基准 × 当前scaleFactor  →  基准 = 实际 / 当前scaleFactor
        const cur = readCurrentPdfScale();
        const curSf = readScaleFactorAttr();
        const fitBase = curSf > 0 ? cur / curSf : cur;
        sf = fitBase > 0 ? clampPdfZoom(zoom.scale) / fitBase : 1;
        sf = Math.min(MAX_PDF_ZOOM, Math.max(MIN_PDF_ZOOM, sf));
      }
      const pct = String(Math.max(25, Math.round(sf * 100)));
      if (r.getAttribute?.("scale-factor") !== pct) r.setAttribute("scale-factor", pct);
      // 基准由 foliate 自己按容器宽算，zoom 固定 fit-width
      if (r.getAttribute?.("zoom") !== "fit-width") r.setAttribute("zoom", "fit-width");
    } else {
      if (zoom.kind === "fit-width") {
        r.setAttribute("zoom", "fit-width");
      } else if (zoom.kind === "fit-page") {
        r.setAttribute("zoom", "fit-page");
      } else {
        // custom：zoom 属性本身就是「目标缩放倍数」（foliate 会 parseFloat）
        r.setAttribute("zoom", String(zoom.scale));
      }
      if (r.getAttribute?.("scale-factor") !== "100") {
        r.setAttribute("scale-factor", "100");
      }
    }
    if (!opts.silent) {
      // 持久化（relocate 事件也会保存；这里立即保存避免等待 relocate）
      scheduleProgressSave({ zoom });
    }
  }

  /**
   * 读取 PDF 当前「真实」缩放倍数。
   * fit-width / fit-page 的实际倍数是 foliate 按视口算出来的，我们手里没有；
   * 但 pdf.js 的 render() 会把本次生效的 scale 写进内容文档的
   * `--total-scale-factor`（vendor/foliate-js/pdf.js:255），直接读它最准。
   * 读不到时退化为 custom 值 / 1.0（与旧的 zoomIn/zoomOut 口径一致）。
   */
  function readCurrentPdfScale(): number {
    try {
      for (const c of (view?.renderer?.getContents?.() ?? []) as any[]) {
        const d: Document | undefined = c?.doc;
        const v = d?.documentElement?.style?.getPropertyValue("--total-scale-factor");
        if (v) {
          const n = parseFloat(v);
          if (isFinite(n) && n > 0) return n;
        }
      }
    } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · readCurrentPdfScale", "debug"); }
    return currentZoom.kind === "custom" ? currentZoom.scale : 1.0;
  }

  /** 缩放到下一档（Zoom in） */
  function zoomIn() {
    if (!isPdfBook()) {
      // EPUB 退化为字号 +
      changeFont(1);
      return;
    }
    // 2026-08-29：基准改用「真实缩放」而非写死的 1.0，
    // 否则 fit-page 实际 0.42 时点一次「+」会直接跳到 1.25（画面暴涨 3 倍）。
    const cur = isPdfBook() ? readCurrentPdfScale() : (currentZoom.kind === "custom" ? currentZoom.scale : 1.0);
    const next = ZOOM_PRESETS.find((p) => p > cur + 0.001) ?? clampPdfZoom(cur * 1.25);
    applyZoom({ kind: "custom", scale: next });
  }

  /** 缩放到上一档（Zoom out） */
  function zoomOut() {
    if (!isPdfBook()) {
      changeFont(-1);
      return;
    }
    const cur = isPdfBook() ? readCurrentPdfScale() : (currentZoom.kind === "custom" ? currentZoom.scale : 1.0);
    const candidates = ZOOM_PRESETS.filter((p) => p < cur - 0.001);
    const next = candidates.length ? candidates[candidates.length - 1] : clampPdfZoom(cur / 1.25);
    applyZoom({ kind: "custom", scale: next });
  }

  /** 重置到 fit-page（Cmd+0） */
  function zoomReset() {
    if (!isPdfBook()) return;
    applyZoom({ kind: "fit-page" });
  }

  /** 适应宽度（Cmd+1） */
  function fitWidth() {
    if (!isPdfBook()) return;
    // 记录切换前的非 fit-width 状态，双击缩放切回用
    if (currentZoom.kind !== "fit-width") {
      lastNonFitWidthZoom = currentZoom;
    }
    applyZoom({ kind: "fit-width" });
  }

  /** 适应整页（Cmd+2） */
  function fitPage() {
    if (!isPdfBook()) return;
    if (currentZoom.kind !== "fit-page") {
      lastNonFitWidthZoom = currentZoom;
    }
    applyZoom({ kind: "fit-page" });
  }

  /** 循环切换预设档位（Cmd+3） */
  function cycleZoomPreset() {
    if (!isPdfBook()) return;
    const cur = currentZoom.kind === "custom" ? currentZoom.scale : 1.0;
    const idx = ZOOM_PRESETS.findIndex((p) => Math.abs(p - cur) < 0.001);
    const nextIdx = idx >= 0 ? (idx + 1) % ZOOM_PRESETS.length : 0;
    applyZoom({ kind: "custom", scale: ZOOM_PRESETS[nextIdx] });
  }

  /** 缩放百分比显示（工具栏用） */
  function zoomPercentLabel(): string {
    if (!isPdfBook()) return "";
    if (currentZoom.kind === "fit-width") return t("↔ 适应宽度");
    if (currentZoom.kind === "fit-page") return t("⊡ 适应整页");
    return `${Math.round(currentZoom.scale * 100)}%`;
  }

  /** [REword patch 2026-08-29] 双击切换 fit-width ↔ 上次缩放（参考 iBooks / Readest） */
  function onDblClickToggleZoom() {
    if (!isPdfBook()) return;
    if (currentZoom.kind === "fit-width") {
      // 当前是 fit-width → 切回上次非 fit-width 状态
      applyZoom(lastNonFitWidthZoom);
    } else {
      // 当前是 fit-page / custom → 切到 fit-width
      lastNonFitWidthZoom = currentZoom;
      applyZoom({ kind: "fit-width" });
    }
  }

  /* ================= PDF 滚轮 / 触控板捏合缩放（2026-08-29） =================
   * 对齐 macOS 原生语义（Preview / Chrome / Acrobat 一致）：
   *   - ⌘ 或 Ctrl + 滚轮 → 连续缩放（鼠标滚轮）
   *   - 触控板双指捏合    → macOS 会把它合成为 ctrlKey=true 的 wheel 事件，走同一条路径
   *   - 无修饰键滚轮      → 保持原生行为（页面放大后可平移；未放大时本就无可滚动内容）
   *
   * 事件必须挂两处，缺一不可：
   *   ① 内容 iframe 内部 doc（PDF 页面本体）——wheel 不跨 iframe 边界冒泡，
   *      只挂父容器时鼠标在页面上滚动完全收不到事件（这是最容易踩的坑）；
   *   ② .reader-stage 容器——页面四周灰色留白区。
   * 两处都必须 passive:false，否则 preventDefault 无效，
   * Electron/Chrome 会把 Ctrl+滚轮 吃掉去做整页缩放。
   */

  // 滚轮缩放的落盘防抖（滚动过程中不重复写盘）
  let zoomSaveTimer: any = null;
  function scheduleZoomPersist() {
    if (zoomSaveTimer) clearTimeout(zoomSaveTimer);
    zoomSaveTimer = setTimeout(() => {
      zoomSaveTimer = null;
      scheduleProgressSave({ zoom: currentZoom });
    }, 400);
  }

  /** 取 foliate fixed-layout 宿主元素（:host{overflow:auto}，负责平移滚动） */
  function getZoomHost(): HTMLElement | null {
    const h = view?.renderer as HTMLElement | null | undefined;
    return h && typeof (h as HTMLElement).getBoundingClientRect === "function" ? h : null;
  }

  /** 量当前页面渲染宽度（算缩放前后真实倍数 k 用；fixed-layout 用 open shadow DOM，可直接查） */
  function measurePageWidth(host: HTMLElement): number {
    try {
      const iframes = (host as any).shadowRoot?.querySelectorAll?.("iframe");
      if (iframes && iframes.length) {
        let best = 0;
        for (const f of Array.from(iframes) as HTMLIFrameElement[]) {
          const w = f.getBoundingClientRect?.().width || 0;
          if (w > best) best = w;
        }
        if (best > 0) return best;
      }
      return host.scrollWidth || 0;
    } catch (__swallowErr) {
      logSwallow(__swallowErr, "ReaderView.svelte · measurePageWidth", "debug");
      return 0;
    }
  }

  /**
   * 以光标为锚点做连续缩放：缩放前后，光标压着的那个内容点保持不动
   * （不做锚点的话，放大后 foliate 会重新居中/回到顶部，画面"跳走"）。
   * @param clientX/clientY 必须是主窗口（最外层）坐标
   */
  function zoomAtPoint(nextScale: number, clientX: number, clientY: number) {
    const target = clampPdfZoom(nextScale);
    const host = getZoomHost();
    if (!host) {
      applyZoom({ kind: "custom", scale: target }, { silent: true });
      scheduleZoomPersist();
      return;
    }
    // [2026-08-29] 滚动模式不做光标锚点：
    // foliate 的 #renderScrollMode 自己用 captureScrollModeAnchor / restoreScrollModeAnchor
    // 维持「视口顶部的页面 + 页内偏移比例」（fixed-layout.js:1128/1143）。
    // 我们再去改 scrollTop 会和它打架、来回拉扯导致画面跳动。交给它即可，
    // 且它锚定的是视口顶部，连续缩放时比光标锚点更稳（不会随光标位置漂移）。
    if (isScrollFlow()) {
      applyZoom({ kind: "custom", scale: target }, { silent: true });
      scheduleZoomPersist();
      return;
    }
    const rect = host.getBoundingClientRect();
    const cursorX = clientX - rect.left;
    const cursorY = clientY - rect.top;
    const w0 = measurePageWidth(host);
    // 光标下的内容坐标（宿主滚动空间内）
    const contentX = host.scrollLeft + cursorX;
    const contentY = host.scrollTop + cursorY;

    applyZoom({ kind: "custom", scale: target }, { silent: true });

    const restore = () => {
      const w1 = measurePageWidth(host);
      if (!w0 || !w1) return;
      const k = w1 / w0;
      host.scrollLeft = contentX * k - cursorX;
      host.scrollTop = contentY * k - cursorY;
    };
    // setAttribute → attributeChangedCallback → #render() 是同步改尺寸的，这里立刻校正一次
    restore();
    // PDF 每页 canvas 重绘是异步的，等一帧再校正，避免渲染完成后尺寸回弹
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(restore);
    scheduleZoomPersist();
  }

  /**
   * PDF 滚轮缩放诊断开关。
   * 排查「按了修饰键但没反应」时改成 true，控制台会打印每一条 wheel 的
   * ctrlKey/metaKey/deltaY 以及最终算出的缩放值；确认修复后请改回 false 再发布。
   */
  const DEBUG_PDF_WHEEL = false;
  function logPdfWheel(...args: any[]) {
    if (DEBUG_PDF_WHEEL) console.log("[REword][pdf-wheel]", ...args);
  }

  // ---- 滚轮缩放的 rAF 累积状态 ----
  // PDF 每次 applyZoom 都会触发整页 canvas 重绘（很重）。触控板捏合每秒能发 60+ 个
  // wheel 事件，逐条响应会明显卡顿。这里把同一帧内的 delta 累积起来，
  // 每帧只真正缩放一次，视觉上仍然跟手。
  let wheelAccumDy = 0;
  let wheelRafId: number | null = null;
  let wheelAnchorX = 0;
  let wheelAnchorY = 0;

  // 滚动模式专用：pinch 预览状态（机制见 commitScrollWheelZoom 注释）
  let wheelPinchBase = 1;        // 本轮连续缩放开始时的缩放基准
  let wheelPinchRatio = 1;       // 累积预览倍数（相对基准）＝目标值
  let wheelPinchActive = false;  // 是否处于「已预览、未提交」状态
  let wheelCommitTimer: any = null;
  // 2026-09-08 丝滑度修复：预览显示值（平滑后）与它的 rAF 缓动循环
  let wheelPinchShown = 1;       // 当前实际应用到 transform 的倍数（向目标缓动）
  let wheelEaseRafId: number | null = null;

  /** 预览倍数指数平滑循环：每帧把 wheelPinchShown 向目标（wheelPinchRatio）推进
   *  动态 ease 比例（输入期 ACTIVE / 滑行期 GLIDE），直到贴合。期间目标可被后续
   *  wheel 事件继续更新，循环始终追最新目标。只改 CSS transform，零重绘。 */
  function easeWheelPinchLoop() {
    if (wheelEaseRafId != null) return; // 已有循环在追，不必重启
    const step = () => {
      wheelEaseRafId = null;
      const r = view?.renderer as any;
      if (!wheelPinchActive || !r || typeof r.pinchZoom !== "function") return;
      const diff = wheelPinchRatio - wheelPinchShown;
      try {
        if (Math.abs(diff) < 0.0008) {
          wheelPinchShown = wheelPinchRatio;
          r.pinchZoom(wheelPinchShown);
          return; // 已贴合，停循环（目标再变会重新启动）
        }
        // MMF 式动态缓动：输入期快追（跟手），停手后小步长长尾滑行（动量收尾）
        const ease = (performance.now() - lastWheelInputAt) < 120
          ? WHEEL_PINCH_EASE_ACTIVE
          : WHEEL_PINCH_EASE_GLIDE;
        wheelPinchShown += diff * ease;
        r.pinchZoom(wheelPinchShown);
      } catch (__swallowErr) {
        logSwallow(__swallowErr, "ReaderView.svelte · pinchZoom", "debug");
        return;
      }
      wheelEaseRafId = requestAnimationFrame(step);
    };
    wheelEaseRafId = requestAnimationFrame(step);
  }

  /**
   * 滚动模式：把本轮缩放预览提交为真实渲染 —— 每轮连续缩放只重绘【一次】。
   * 这是滚动模式流畅度的关键：连续缩放期间不改任何页面，停手才画。
   */
  function commitScrollWheelZoom() {
    const r = view?.renderer as any;
    if (!wheelPinchActive) { wheelCommitTimer = null; return; }
    // 2026-09-08 配套滑行缓动：预览尚未贴合目标时推迟提交（贴合后提交只剩
    // canvas 清晰度切换、没有位移跳变）；限 8 次防呆，最迟约 +480ms 必提交。
    if (Math.abs(wheelPinchShown - wheelPinchRatio) > 0.002 && wheelCommitDeferrals < 8) {
      wheelCommitDeferrals++;
      wheelCommitTimer = setTimeout(commitScrollWheelZoom, 60);
      return;
    }
    wheelCommitDeferrals = 0;
    wheelCommitTimer = null;
    wheelPinchActive = false;
    // 2026-09-08 丝滑度修复：提交前先把预览贴合到目标倍数（仍纯 transform，零重绘），
    // 保证 pinchEnd 快照的锚点矩形与即将提交的真实渲染（target 倍数）一致，
    // 消除「平滑还没追完就提交」造成的最后一跳。
    if (wheelEaseRafId != null) {
      cancelAnimationFrame(wheelEaseRafId);
      wheelEaseRafId = null;
    }
    if (r && typeof r.pinchZoom === "function" && wheelPinchShown !== wheelPinchRatio) {
      wheelPinchShown = wheelPinchRatio;
      try {
        r.pinchZoom(wheelPinchShown);
      } catch (__swallowErr) {
        logSwallow(__swallowErr, "ReaderView.svelte · pinchZoom", "debug");
      }
    }
    const finalScale = clampPdfZoom(wheelPinchBase * wheelPinchRatio);
    wheelPinchRatio = 1;
    wheelPinchShown = 1;
    if (r) {
      try {
        // pinchEnd 快照视口中心页的矩形存进 #pinchAnchor 并清掉 transform；
        // 紧接着的 applyZoom 触发 #render → #renderScrollMode 用该锚点把页面滚回原位，不跳。
        if (typeof r.pinchEnd === "function") r.pinchEnd();
      } catch (__swallowErr) {
        logSwallow(__swallowErr, "ReaderView.svelte · pinchEnd", "debug");
      }
    }
    applyZoom({ kind: "custom", scale: finalScale }, { silent: true });
    scheduleZoomPersist();
  }

  /** 真正执行缩放（由 rAF 调用，每帧至多一次） */
  function flushWheelZoom() {
    wheelRafId = null;
    const dy = wheelAccumDy;
    wheelAccumDy = 0;
    if (!dy) return;

    // 滚动模式走 foliate 的 pinch 预览：连续缩放期间【零重绘】。
    // 滚动模式最多保持 12 页 loaded（#scrollMaxLoaded=12），逐帧提交意味着每帧重绘
    // 12 页 canvas（每页约 400ms）→ 必然卡顿。预览只改 scrollContainer 的 CSS transform，
    // 交给 GPU 合成；停手后才由 commitScrollWheelZoom 提交一次真实渲染。
    if (isScrollFlow()) {
      const r = view?.renderer as any;
      if (r && typeof r.pinchZoom === "function") {
        if (!wheelPinchActive) {
          wheelPinchBase = readCurrentPdfScale();
          wheelPinchRatio = 1;
          wheelPinchShown = 1;
          wheelPinchActive = true;
        }
        const target = clampPdfZoom(
          wheelPinchBase * wheelPinchRatio * Math.exp(-dy * WHEEL_ZOOM_SENSITIVITY)
        );
        wheelPinchRatio = wheelPinchBase > 0 ? target / wheelPinchBase : 1;
        lastWheelInputAt = performance.now();
        if (Math.abs(wheelPinchRatio - 1) < 0.0005) return;   // 已到边界
        // 2026-09-08 丝滑度修复：不再直接把目标倍数砸到 transform 上（MMF 注入的
        // delta 不均匀 → 逐帧锯齿），改走指数平滑缓动循环。
        easeWheelPinchLoop();
        if (wheelCommitTimer) clearTimeout(wheelCommitTimer);
        wheelCommitDeferrals = 0;
        wheelCommitTimer = setTimeout(commitScrollWheelZoom, SCROLL_ZOOM_COMMIT_DELAY);
        return;
      }
    }

    // 分页模式：只渲染当前 1-2 页，逐帧提交即可，且需要光标锚点
    const base = readCurrentPdfScale();
    const next = clampPdfZoom(base * Math.exp(-dy * WHEEL_ZOOM_SENSITIVITY));
    logPdfWheel("zoom", { base, next, dy, flow: "paginated" });
    if (Math.abs(next - base) < 0.0005) return;      // 已到边界
    zoomAtPoint(next, wheelAnchorX, wheelAnchorY);
  }

  /** 滚轮缩放统一入口 */
  function handlePdfWheel(e: WheelEvent, clientX: number, clientY: number) {
    logPdfWheel("wheel", {
      ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey,
      deltaY: e.deltaY, deltaMode: e.deltaMode, isPdf: isPdfBook(),
    });
    if (!isPdfBook()) return;                       // EPUB 保留原生滚动
    if (!e.ctrlKey && !e.metaKey) return;           // 仅 ⌘/Ctrl + 滚轮（含触控板捏合）
    // 两个都要：
    //   preventDefault            → 阻止 Electron/Chromium 拿它去做整页缩放
    //   stopImmediatePropagation  → 连 foliate 自己挂在同文档上的 wheel 一起挡掉，
    //                               避免缩放被它后续再处理一次（冒泡阶段会晚于我们的捕获阶段）
    e.preventDefault();
    e.stopImmediatePropagation();
    // deltaMode 归一化：0=像素 / 1=行 / 2=页
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
    let dy = (e.deltaY || 0) * unit;
    if (!dy) return;
    // 单条事件幅度截断：不同鼠标 deltaY 从几十到几百都有，不截断一格能跳 30%+，
    // 非常突兀。截到 ±60 后靠连续滚动累积到目标倍率，手感细腻且不失控。
    dy = Math.max(-WHEEL_MAX_DELTA, Math.min(WHEEL_MAX_DELTA, dy));
    // 累积到 rAF，一帧合并成一次缩放（锚点取本帧最后一次事件的位置）
    wheelAccumDy += dy;
    wheelAnchorX = clientX;
    wheelAnchorY = clientY;
    if (wheelRafId != null) return;
    if (typeof requestAnimationFrame === "function") {
      wheelRafId = requestAnimationFrame(flushWheelZoom);
    } else {
      flushWheelZoom();
    }
  }

  /** 2026-10-25 修复「设置面板滚动连动正文翻页」：
   * 滚轮翻页 / PDF 缩放监听绑在整个 .reader-view 容器上，而设置弹窗等浮层是
   * 它的 DOM 子孙——浮层内的 wheel 冒泡到容器会被当成翻页/缩放。此处按浮层
   * 容器统一豁免（等价于各 popover 已有的 on:wheel|stopPropagation，但收口
   * 一处、覆盖全部浮层；新增浮层往选择器里加类名即可）。 */
  function isWheelOverOverlay(e: WheelEvent): boolean {
    const t = e.target as Element | null;
    if (!t || typeof (t as any).closest !== "function") return false;
    return !!t.closest(
      ".rwd-backdrop, .reader-popover, .reader-dict-popup, .reader-footnote, " +
      ".reader-more-menu, .reader-sel-toolbar, .reader-note-editor, .reader-imgv, " +
      ".reader-hint-panel, .reader-side-resizer"
    );
  }

  /** ① 挂在 .reader-stage（页面四周留白）：坐标本就是主窗口坐标 */
  function onStageWheel(e: WheelEvent) {
    if (isWheelOverOverlay(e)) return;
    handlePdfWheel(e, e.clientX, e.clientY);
  }

  /** ② 挂在内容 iframe 内的 doc（页面本体）：坐标要换算回主窗口 */
  function onContentWheel(e: WheelEvent) {
    if (!isPdfBook()) return;
    if (!e.ctrlKey && !e.metaKey) return;
    let left = 0;
    let top = 0;
    try {
      const doc = ((e.target as Node)?.ownerDocument ?? e.currentTarget) as Document | null;
      const fr = (doc?.defaultView as any)?.frameElement?.getBoundingClientRect?.() as DOMRect | undefined;
      if (fr) { left = fr.left; top = fr.top; }
    } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · onContentWheel", "debug"); }
    handlePdfWheel(e, e.clientX + left, e.clientY + top);
  }

  // 最外层 wheel 监听是否已绑定（capture 阶段；只在确认是 PDF 之后才绑，
  // 避免 passive:false 的 capture 监听拖累 EPUB 滚动性能）。
  // 函数名沿用 bindStageWheel —— test/pdf-zoom-apply.test.mjs 按源码文本断言这个名字，不要改。
  let stageWheelBound = false;
  function bindStageWheel() {
    if (stageWheelBound || !readerViewEl) return;
    // 挂【最外层 .reader-view】+【capture 阶段】：页面四周留白区的滚轮
    // 在进入任何子元素之前就被拦下，比原先挂在 .reader-stage 的冒泡阶段更早，
    // 也不会被 foliate 内部的处理抢先。
    // 注意：iframe 内的滚轮不会传播到父文档，页面本体仍靠 onContentWheel（挂 iframe 内的 doc）。
    readerViewEl.addEventListener("wheel", onStageWheel as EventListener, { capture: true, passive: false });
    stageWheelBound = true;
  }

  /* ------------------------------------------------------------------ *
   * 滚轮翻页（2026-10-24）
   * ------------------------------------------------------------------ *
   * 口径（对齐微信读书 / Readest）：
   *  - 只在**分页模式**生效；连续滚动模式正文本来就能滚，滚轮归原生滚动管。
   *  - 方向用**逻辑方向**（下一段），与书写方向无关 —— RTL 书里滚轮向下仍是"下一页"。
   *  - 阈值 30px + 200ms 空闲重置：一次滑动只翻一页，惯性尾巴不连翻。
   *
   * 为什么要单独一套挂载逻辑（而不是直接在 onStageWheel 里判）：
   *  ① passive:false 的 wheel 监听会让浏览器放弃滚轮滚动的合成器优化
   *     （滚动必须等主线程），是实打实的卡顿源。所以**只在真的要用时才挂**，
   *     连续滚动模式一律不挂 —— 与 PDF 缩放监听同一条纪律。
   *  ② wheel 事件不跨 iframe 边界 —— 页面本体（iframe 内）必须单独往内容文档挂一份。
   */
  const WHEEL_TURN_OPTS: AddEventListenerOptions = { capture: true, passive: false };
  /** 已挂滚轮翻页监听的内容文档 */
  const wheelTurnDocs = new Set<Document>();
  /** 阶段（页面四周留白）监听是否已挂 */
  let wheelTurnStageBound = false;

  function getWheelDetector(): WheelGestureDetector {
    if (!wheelDetector) wheelDetector = createWheelGestureDetector();
    return wheelDetector;
  }

  /** 滚轮翻页当前是否可用 */
  function wheelTurnEnabled(): boolean {
    if (!view) return false;
    if (isPdfBook()) return false;                  // PDF 有自己的 ⌘+滚轮缩放，不抢
    if (settings.flow !== "paginated") return false; // 连续滚动模式交给原生滚动
    if (settings.wheelPageTurn === false) return false;
    return true;
  }

  /** 滚轮翻页统一入口（阶段留白 + 页面本体都走这里） */
  function onReaderWheel(e: WheelEvent): void {
    if (!wheelTurnEnabled()) return;
    // 2026-10-25：浮层（设置弹窗/词典/脚注/hint/停靠侧栏面板等）内的滚轮
    // 不属于正文翻页意图，直接放行给浮层自己滚动（详见 isWheelOverOverlay 注释）
    if (isWheelOverOverlay(e)) return;
    const dir = getWheelDetector().feed({
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      timeStamp: e.timeStamp,
      deltaMode: e.deltaMode,
    });
    if (!dir) return;
    // 自己接管 ⇒ 阻止原生滚动/缩放，并止住冒泡（冒到思源宿主会被宿主的滚轮逻辑二次响应）。
    e.preventDefault();
    e.stopPropagation();
    turnPage(view, dir === "next" ? "next" : "prev");
  }

  function bindWheelTurnOnDoc(doc: Document) {
    if (wheelTurnDocs.has(doc)) return;
    wheelTurnDocs.add(doc);
    doc.addEventListener("wheel", onReaderWheel as EventListener, WHEEL_TURN_OPTS);
  }

  function unbindWheelTurnOnDoc(doc: Document) {
    if (!wheelTurnDocs.has(doc)) return;
    wheelTurnDocs.delete(doc);
    doc.removeEventListener("wheel", onReaderWheel as EventListener, WHEEL_TURN_OPTS);
  }

  function unbindWheelTurnDocs() {
    for (const doc of Array.from(wheelTurnDocs)) unbindWheelTurnOnDoc(doc);
  }

  function bindWheelTurnStage() {
    if (wheelTurnStageBound || !readerViewEl) return;
    readerViewEl.addEventListener("wheel", onReaderWheel as EventListener, WHEEL_TURN_OPTS);
    wheelTurnStageBound = true;
  }

  function unbindWheelTurnStage() {
    if (!wheelTurnStageBound || !readerViewEl) return;
    readerViewEl.removeEventListener("wheel", onReaderWheel as EventListener, WHEEL_TURN_OPTS);
    wheelTurnStageBound = false;
  }

  /**
   * 按当前模式挂/卸滚轮翻页监听。
   * 开关条件：分页模式 + 非 PDF + 用户没关。
   */
  function syncWheelTurnMount(): void {
    if (wheelTurnEnabled()) {
      bindWheelTurnStage();
      for (const doc of attachedDocs) bindWheelTurnOnDoc(doc);
    } else {
      unbindWheelTurnStage();
      unbindWheelTurnDocs();
      // 关掉时清零累积量：否则重新打开时残留的 delta 会立刻翻一页。
      wheelDetector?.reset();
    }
  }

  // 2026-08-29 Phase 1：双指捏合缩放——实时改字号（不立即持久化，松手即落盘由 store 自行处理）
  function setFontSizeLive(n: number) {
    const clamped = Math.min(36, Math.max(10, Math.round(n)));
    if (clamped === settings.fontSize) return;
    settings = settingsStore.update({ fontSize: clamped });
    applyStyles();
  }

  /** 字号连续滑块（step 0.5，不取整，对齐 Readest 细粒度） */
  function onFontSizeInput(e: Event) {
    const v = clamp(+(e.currentTarget as HTMLInputElement).value, 10, 36);
    settings = settingsStore.update({ fontSize: v });
    applyStyles();
  }

  // 2026-08-29 Phase 1：工具栏显隐切换（移动端中心点击）。面板打开时不隐藏，避免失去锚点感。
  function toggleToolbar() {
    // [REword patch 2026-08-29] Phase 2 触屏：单击空白处关闭所有浮层
    // 触屏场景：用户点中心区时如果有浮层（搜索/设置/目录）打开，
    // 应优先关闭浮层而不是 toggle 工具栏可见性（避免被遮挡的工具栏闪一下）
    if (showSettings || showSearch || showMoreMenu) {
      showSettings = false;
      showSearch = false;
      showMoreMenu = false;
      releaseTopBarForPopover();
      return;
    }
    if (showToc) {
      showToc = false;
      releaseTopBarForPopover();
      return;
    }
    // 2026-10-08 顶栏浮层化：中心点击切的是「浮起/收回」，不是 `toolbarVisible`
    //（后者在悬浮模式下已不再驱动顶栏的显示，只服务于 topBarFloating=false 的旧行为）。
    if (isTopBarFloating()) {
      toggleTopBarPin();
      return;
    }
    toolbarVisible = !toolbarVisible;
  }

  function onSetTheme(key: string) {
    settings = settingsStore.update({ theme: key as ReaderTheme });
    applyStyles();
  }

  // [2026-09-25] 页面宽度三档预设：铺满 95% / 正常 80% / 宽松 70%（内容宽度随窗口伸缩）。
  // ⚠️ 点击时显式关掉「跟随思源页边」——否则 applyStyles 后 applySiyuanDocMargin 会把
  // 左右边距覆盖回宿主 padding，预设点了等于白点（用户报障「点击没有用」的根因）。
  function onSetLayoutPreset(p: string) {
    const preset = LAYOUT_PRESETS[p as ReaderLayoutPreset];
    settings = settingsStore.update({
      layout: {
        ...settings.layout,
        widthPct: preset.widthPct,
        marginTopPx: preset.margins.top,
        marginBottomPx: preset.margins.bottom,
        followSiyuanMargin: false,
      },
    });
    applyStyles();
  }
  /** 跟随思源文档边距：读取宿主 .protyle-wysiwyg 的水平 padding，作为阅读器左右边距 */
  function applySiyuanDocMargin() {
    if (!settings.layout.followSiyuanMargin) {
      // 关闭时**清空缓存**，让 layoutMarginStyles 立刻回落到用户自己的设定值。
      // 旧实现把读到的值写进了 settings.layout.marginLeft/RightPx，
      // 关掉开关后这些值**留在设置档里不会还原** ⇒ 用户再也回不去自己设的边距。
      // （2026-10-07 改为运行时缓存，不再落盘。）
      siyuanSideMarginPx = null;
      return;
    }
    try {
      const doc = (typeof window !== "undefined" && (window.top?.document ?? window.document)) || null;
      if (!doc) return;
      const host: Element | null =
        doc.querySelector(".protyle-wysiwyg") || doc.querySelector(".protyle-content");
      if (!host) return;
      const cs = getComputedStyle(host);
      const pl = Math.round(parseFloat(cs.paddingLeft) || 0);
      const pr = Math.round(parseFloat(cs.paddingRight) || 0);
      if (!pl && !pr) return;
      // 2026-10-07：改为**只写运行时缓存**，不再 settingsStore.update。
      // 附带解决两个老问题：
      //  ① 关掉开关后能恢复用户自己的边距（旧实现的值留在设置档里不还原）；
      //  ② 宿主后续改边距能实时跟随（旧实现读一次就固化在 settings 里）。
      // 值未变化时**不重写**——避免「订阅回调 → applyStyles → 本函数」形成递归环
      // （沿用 2026-09-08 冻结根治的思路，只是守卫对象从 settings 换成局部变量）。
      if (!siyuanSideMarginPx || siyuanSideMarginPx.left !== pl || siyuanSideMarginPx.right !== pr) {
        siyuanSideMarginPx = { left: pl, right: pr };
      }
    } catch (__e) { logSwallow(__e, "ReaderView.svelte · applySiyuanDocMargin", "debug"); }
  }

  /**
   * 宿主文档左右内边距的**运行时缓存**（2026-10-07）。
   *
   * ## 为什么不再写进 settings
   * 旧实现（`applySiyuanDocMargin`）把读到的值 `update` 进
   * `settings.layout.marginLeftPx / marginRightPx`，产生两个用户可见的缺陷：
   *  ① **关掉开关不还原** —— 被写入的值留在设置档里，用户自己的边距被永久覆盖；
   *  ② **不再跟随** —— 读一次就固化，宿主之后改文档边距，阅读器不跟了。
   *
   * 改为局部变量后：开关一关即刻回落用户设定值，且每次开启动/窗口变化都能重读。
   * 本值**不持久化**（刻意不落盘），它是「当前这次阅读」的宿主对齐结果。
   */
  let siyuanSideMarginPx: { left: number; right: number } | null = null;
  function setFollowSiyuanMargin(e: Event) {
    settings = settingsStore.update({
      layout: { ...settings.layout, followSiyuanMargin: (e.target as HTMLInputElement).checked },
    });
    applyStyles();
  }

  function onSetFlow(key: string) {
    settings = settingsStore.update({ flow: key as ReaderSettings["flow"] });
    applyFlow();
  }

  // 2026-10-09：onSetTurnStyle / setClickToTurn 随对应 UI 一并删除。
  // 翻页观感固定为朴素推移，由开书流程与 applyFlow 后的 applyTurnStyle 一次性设好，
  // 不再需要「用户改设置 → 重新应用」这条通路。

  // [REword patch 2026-08-29] PDF 显示设置：更新后由 settingsStore 订阅回调统一 apply（见上方 subscription）
  function onSetPdfViewMode(key: string) {
    settings = settingsStore.update({ pdfViewMode: key as ReaderSettings["pdfViewMode"] });
  }

  function onSetPdfScrollDir(key: string) {
    settings = settingsStore.update({ pdfScrollDir: key as ReaderSettings["pdfScrollDir"] });
  }

  function setPdfInvert(e: Event) {
    settings = settingsStore.update({ pdfInvert: (e.target as HTMLInputElement).checked });
  }

  // 2026-09-04 P2：PDF 文本标注类型开关
  function setPdfAnnotHighlight(e: Event) {
    settings = settingsStore.update({ pdfAnnotHighlight: (e.target as HTMLInputElement).checked });
  }
  function setPdfAnnotUnderline(e: Event) {
    settings = settingsStore.update({ pdfAnnotUnderline: (e.target as HTMLInputElement).checked });
  }
  function setPdfAnnotAnnotate(e: Event) {
    settings = settingsStore.update({ pdfAnnotAnnotate: (e.target as HTMLInputElement).checked });
  }

  function setLineHeight(lh: number) {
    settings = settingsStore.update({ lineHeight: lh });
    applyStyles();
  }

  /** 专注模式开关（2026-08-27 晚 P2.2）：重新注入样式 + 给当前文档加/去 .reword-focus */
  function setFocusMode(e: Event) {
    const v = (e.target as HTMLInputElement).checked;
    settings = settingsStore.update({ focusMode: v });
    applyStyles();
    applyFocusMode();
  }

  function setOverridePublisherFont(e: Event) {
    settings = settingsStore.update({
      overridePublisherFont: (e.target as HTMLInputElement).checked,
    });
    applyStyles();
  }

  /** 统一正文字号开关（2026-08-27）：压平书籍写死字号，让 A+/A- 全局生效 */
  function setOverrideBookFontSize(e: Event) {
    settings = settingsStore.update({
      overrideBookFontSize: (e.target as HTMLInputElement).checked,
    });
    applyStyles();
  }

  /**
   * 排版让位开关（2026-10-06，Readest 同思路）：
   * 开 = 清洗出版方脏排版值 + 用户设置以 !important 施加到段落级选择器；
   * 关 = 使用书籍原版排版（行距/缩进/对齐/断词交给书自己）。
   */
  function setOverrideBookLayout(e: Event) {
    settings = settingsStore.update({
      overrideBookLayout: (e.target as HTMLInputElement).checked,
    });
    applyStyles();
  }

  /**
   * 竖排开关（2026-10-06）：
   * 引擎（vendored foliate paginator）只看 CSS `writing-mode`，
   * 这里改设置后由 buildReaderStyles 注入 writing-mode + 竖排专属排版适配。
   */
  function setVerticalWriting(e: Event) {
    settings = settingsStore.update({
      verticalWriting: (e.target as HTMLInputElement).checked,
    });
    applyStyles();
  }

  /**
   * 竖排标点开关（2026-10-06）：
   * 需重开书籍才生效 —— 标点替换挂在 foliate 的书内 HTML 转换钩子上，
   * 属于「加载时一次性变换」，不是运行期可改的样式。
   */
  function setVerticalPunctuation(e: Event) {
    settings = settingsStore.update({
      verticalPunctuation: (e.target as HTMLInputElement).checked,
    });
  }

  /* ================= 2026-08-28 双语 + 阅读增强 handler ================= */

  /** 译文字号（em 倍数，0.6–1.0，步长 0.02） */
  function setTranslationFontSize(v: number) {
    settings = settingsStore.update({
      translationFontSize: clamp(Math.round(v * 100) / 100, 0.6, 1.0),
    });
    applyStyles();
  }

  /** 预取分节数（0–4 整数，默认 2；渐进窗口与注入闸门共用；值越大越省翻页等待但越费 token） */
  function setBilingualPrefetchPages(v: number) {
    settings = settingsStore.update({
      bilingualPrefetchPages: clamp(Math.round(v), 0, 4),
    });
    // 预取窗口变化后，下一轮 injectAll（relocate/load）会自动按新值补译；
    // 若已开启双语，立即触发一次增量刷新让后面新范围入缓存。
    if (bilingualOn) ensureBilingualHandle().refresh();
  }

  // 2026-08-30 透明化：双语调试信息开关已移至「双语翻译」设置 Tab；
  // 此处原 setBilingualDebug 处理器为死代码，2026-09-29 设置整合时删除。

  /**
   * 2026-08-31 Phase 2：归档译文到思源 SQLite（可搜索 / 可 SQL 查询 / 随同步）。
   * 首次启用才会在笔记本里建「REword 译文归档」文档——在用户思源里建文档是
   * 写入操作，所以只有用户主动打开这个开关时才做。
   */
  async function setTranslationArchive(e: Event) {
    const v = (e.target as HTMLInputElement).checked;
    settings = settingsStore.update({ translationArchiveEnabled: v });
    if (!v) return;

    try {
      const { ensureTranslationArchiveDoc } = await import("../translate/sqlite-cache.ts");
      const docId = await ensureTranslationArchiveDoc(
        () => settings.translationArchiveDocId || "",
        async (id: string) => {
          settings = settingsStore.update({ translationArchiveDocId: id });
        }
      );
      toast(docId ? t("已启用译文归档，新建译文会同步写进思源") : t("启用失败：无法创建归档文档，请检查思源笔记本"), 2600);
    } catch (err) {
      console.warn("[REword] 启用译文归档失败:", err);
      toast(t("启用译文归档失败，请重试"), 2600, "error" as any);
    }
  }

  /* ================= 本书前提上下文（v1.3.0：lite Protyle 富文本编辑） ================= */

  let primerOpen = false;
  let primerEditorEl: HTMLElement | null = null;
  let primerEditor: AnnEditor | null = null;
  let primerChars = 0;
  let primerTokens = 0;
  let primerSaveTimer: any = null;

  /** 本书累计 token（打开设置面板 / 翻译完成后刷新） */
  let bookTokenTotal = 0;
  function refreshBookTokenUsage() {
    const u = getTokenUsage?.(bookId);
    bookTokenTotal = u?.total || 0;
  }
  async function onResetBookTokens() {
    await resetTokenUsage?.(bookId);
    refreshBookTokenUsage();
    toast(t("本书 Token 统计已重置"));
  }

  function fmtTok(n: number): string {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return String(n);
  }

  /* ================= 2026-08-28 翻译缓存统计（按书） ================= */
  /** 当前查看书籍的已缓存译文条数（设置面板展示「已缓存 N 段」） */
  let bilingualCacheCount = 0;
  /** 当前查看书籍已缓存的「节」总数（用于「共缓存 N 页」） */
  let bilingualCachedPages = 0;
  /** 当前查看书籍已缓存连续区间文本（如「第 1-4 页」） */
  let bilingualPageRange = "0 页";
  /** 清空缓存进行中（防重复点击） */
  let clearingCache = false;
  /** 清理无效（孤儿）缓存进行中（防重复点击） */
  let clearingOrphans = false;
  /** 有翻译缓存的书籍列表（bookId + 书名），供「选择书籍」下拉 */
  let cacheBookList: Array<{ bookId: string; title: string }> = [];
  /** 当前下拉选中的书籍（默认本书；可切到其他有缓存的书查看） */
  let selectedCacheBookId = bookId || "";

  /** 拉取有缓存的书籍列表（书名 + bookId） */
  async function refreshCacheBookList() {
    if (!listCachedBooks) return;
    try {
      const list = await listCachedBooks();
      cacheBookList = Array.isArray(list) ? list : [];
    } catch {
      cacheBookList = [];
    }
  }

  /** 拉取某书翻译缓存统计（条数 + 页数 + 区间），写入面板状态。默认本书 */
  async function refreshCacheStats(bid?: string) {
    const target = bid || bookId;
    selectedCacheBookId = target;
    if (!target || !getTranslationCacheStats) {
      bilingualCacheCount = 0;
      bilingualCachedPages = 0;
      bilingualPageRange = "0 页";
      return;
    }
    try {
      const r = await getTranslationCacheStats(target);
      bilingualCacheCount = r?.count || 0;
      bilingualCachedPages = r?.cachedPages || 0;
      bilingualPageRange = r?.pageRangeText || "0 页";
    } catch {
      bilingualCacheCount = 0;
      bilingualCachedPages = 0;
      bilingualPageRange = "0 页";
    }
  }

  /** 下拉切换查看的书籍：刷新该书统计 */
  async function onSelectCacheBook(e: Event) {
    const bid = (e.target as HTMLSelectElement).value;
    await refreshCacheStats(bid);
  }

  /** 清空当前选中书籍的翻译缓存（用户主动点「清空缓存」；正常关闭双语不清） */
  async function onClearBilingualCache() {
    const target = selectedCacheBookId || bookId;
    if (!target || !clearTranslationCache || clearingCache) return;
    // 2026-08-31 v1.4.4 P2：清空缓存是不可逆操作，强制二次确认
    //   避免用户误触导致所有译文丢失（下次翻页会全量重译，费 token）
    const isCurrentBook = target === bookId;
    const msg = isCurrentBook
      ? t("清空本书「{title}」全部翻译缓存？\n\n将删除 {n} 段译文（{p} 页）。\n之后翻页会重新翻译，会消耗 AI token。\n\n确定继续？", { title: meta?.title || title || t("当前书籍"), n: bilingualCacheCount, p: bilingualCachedPages })
      : t("清空所选书籍 {title} 的翻译缓存？\n\n确定继续？", { title: cacheBookList.find((b) => b.bookId === target)?.title || target });
    if (!confirm(msg)) return;
    clearingCache = true;
    try {
      await clearTranslationCache(target);
      await refreshCacheStats(target);
      await refreshCacheBookList();
      // 2026-08-31 v1.4.4 P2：清空后立即 refresh 眼前屏（避免残留旧译文）
      if (bilingualOn) ensureBilingualHandle()?.refresh();
      toast(isCurrentBook ? t("本书翻译缓存已清空，下次翻页会重新翻译") : t("已清空所选书籍翻译缓存"));
    } catch (e) {
      console.warn("[REword] 清空翻译缓存失败:", e);
      toast(t("清空缓存失败，请重试"), 2600, "error" as any);
    } finally {
      clearingCache = false;
    }
  }

  /** 清理「孤儿」翻译缓存：回收书架中已不存在书籍对应的缓存文件
   * （同一本实体书在历史随机 bookId / 删书未清缓存时可能遗留多份）。 */
  async function onCleanOrphanCaches() {
    if (!cleanOrphanCaches || clearingOrphans) return;
    // 2026-08-31 v1.4.4 P2：清理无效缓存也加二次确认（不可逆）
    if (!confirm(t("清理无效（孤儿）翻译缓存？\n\n仅清书架中已不存在书籍对应的缓存文件，\n当前在读书籍的缓存不受影响。\n\n确定继续？"))) return;
    clearingOrphans = true;
    try {
      const n = await cleanOrphanCaches();
      await refreshCacheBookList();
      await refreshCacheStats(selectedCacheBookId || bookId);
      toast(n > 0 ? t("已清理 {count} 份无效缓存", { count: n }) : t("没有需要清理的无效缓存"));
    } catch (e) {
      console.warn("[REword] 清理无效缓存失败:", e);
      toast(t("清理无效缓存失败，请重试"), 2600, "error" as any);
    } finally {
      clearingOrphans = false;
    }
  }


  function togglePrimerEditor() {
    primerOpen = !primerOpen;
    if (primerOpen) {
      // 等 {#if} 渲染出容器且有尺寸后挂载（AnnEditor 内部有 rAF 重试兜底）
      setTimeout(() => mountPrimerEditor(), 60);
    } else {
      flushPrimerSave();
      destroyPrimerEditor();
    }
  }

  function mountPrimerEditor() {
    if (!primerEditorEl || primerEditor || !primerStore) return;
    const app = (window as any).siyuan?.ws?.app;
    primerEditor = new AnnEditor(primerEditorEl, {
      app,
      initial: primerStore.get(bookId) || "",
    });
    primerEditor.mount();
    updatePrimerStats();
    // input 冒泡监听：实时更新字数/token + 防抖保存（Kramdown 落盘）
    primerEditorEl.addEventListener("input", () => {
      updatePrimerStats();
      if (primerSaveTimer) clearTimeout(primerSaveTimer);
      primerSaveTimer = setTimeout(() => {
        primerSaveTimer = null;
        savePrimer();
      }, 600);
    });
  }

  function updatePrimerStats() {
    if (!primerEditor) return;
    try {
      const md = primerEditor.read() || "";
      primerChars = md.length;
      primerTokens = estimateTokens(md);
    } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · updatePrimerStats", "debug"); }
  }

  function savePrimer() {
    if (!primerEditor || !primerStore) return;
    try {
      const md = (primerEditor.read() || "").trim();
      primerStore.set(bookId, md, meta?.title).catch(() => {});
    } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · savePrimer", "error"); }
  }

  function flushPrimerSave() {
    if (primerSaveTimer) {
      clearTimeout(primerSaveTimer);
      primerSaveTimer = null;
    }
    savePrimer();
  }

  async function clearPrimer() {
    if (!primerStore) return;
    destroyPrimerEditor();
    await primerStore.remove(bookId);
    primerChars = 0;
    primerTokens = 0;
    primerOpen = false;
    toast(t("已清除本书上下文"));
  }

  function destroyPrimerEditor() {
    try {
      primerEditor?.destroy?.();
    } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · destroyPrimerEditor", "debug"); }
    primerEditor = null;
    primerEditorEl = null;
  }

  /* ================= 生词本导出（v1.3.0：Markdown 表格 → 剪贴板） ================= */

  /**
   * 导出当前书中已显示的双语对照为 Markdown 表格（原文 | 译文 | 章节），
   * 复制到剪贴板后可直接粘贴进思源笔记做成复习文档。
   * 数据源：当前已加载内容文档里带 data-reword-translated 标记的段落（即已注入译文的）。
   */
  async function exportBilingualNotes() {
    try {
      // 直接取 foliate 内容文档（铁律：真 Document 在 .doc 字段）
      const raw = (view?.renderer?.getContents?.() as any[]) || [];
      const docs = raw.map((c) => c?.doc).filter(Boolean) as Document[];
      if (!docs.length) {
        toast(t("未找到已翻译内容"));
        return;
      }
      const rows: Array<{ src: string; dst: string; ch: string }> = [];
      const seen = new Set<string>();
      for (const doc of docs) {
        const chapter = (doc as any).title || "";
        const translated = doc.querySelectorAll("[data-reword-translated]");
        translated.forEach((el) => {
          const dstEl = el.querySelector(":scope > .reword-bilingual");
          if (!dstEl) return;
          // 原文 = 父元素文本去掉译文子节点后的内容
          const clone = el.cloneNode(true) as Element;
          clone.querySelectorAll(":scope > .reword-bilingual").forEach((n) => n.remove());
          const src = (clone.textContent || "").replace(/\s+/g, " ").trim();
          const dst = (dstEl.textContent || "").replace(/\s+/g, " ").trim();
          if (!src || !dst) return;
          const key = src.slice(0, 120);
          if (seen.has(key)) return; // foliate 多列布局下同段可能出现在多个文档，去重
          seen.add(key);
          rows.push({ src, dst, ch: chapter });
        });
      }
      if (!rows.length) {
        toast(t("当前章节暂无已翻译段落（请先开启双语并滚动加载）"));
        return;
      }
      const title = meta?.title || t("本书");
      const lines = [
        t("# {title} · 双语生词本", { title }),
        "",
        t("> 导出于 {date} · 共 {n} 段", { date: new Date().toLocaleString(), n: rows.length }),
        "",
        t("| 原文 | 译文 |"),
        "| --- | --- |",
        ...rows.map((r) => `| ${r.src.replace(/\|/g, "\\|").slice(0, 300)} | ${r.dst.replace(/\|/g, "\\|")} |`),
      ];
      const md = lines.join("\n");
      await navigator.clipboard.writeText(md);
      toast(t("已复制 {n} 段生词 Markdown，可粘贴进思源笔记", { n: rows.length }));
    } catch (e: any) {
      console.warn("[REword] 生词本导出失败:", e);
      toast(t("导出失败：") + String(e?.message || e));
    }
  }

  /* ================= 2026-08-28 分类字体（Readest 同款）handler ================= */

  /** 正文默认走哪条链：衬线 / 无衬线 */
  function setDefaultFontFamily(key: string) {
    settings = settingsStore.update({
      defaultFontFamily: (key === "sans-serif" ? "sans-serif" : "serif") as
        | "serif"
        | "sans-serif",
    });
    applyStyles();
  }

  /**
   * 设置某条链的首选字体。
   * defaultCJKFont 传空串 = 不插入（仅用跨平台 CJK 兜底栈）。
   * applyStyles() 内部已带 rAF → applyFontKeywordRewrite()，无需重复调用。
   */
  function setFontFace(
    field: "serifFont" | "sansSerifFont" | "monospaceFont" | "defaultCJKFont",
    v: string
  ) {
    settings = settingsStore.update({ [field]: v } as Partial<ReaderSettings>);
    applyStyles();
  }

  /* ================= 2026-08-24 新增 4 大设置组 handler ================= */

  /** 通用：clamp + 应用样式 */
  function clamp(v: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, v));
  }

  /* 文本设置 */
  function setTextWeight(v: number) {
    settings = settingsStore.update({ text: { ...settings.text, fontWeight: clamp(Math.round(v / 10) * 10, 100, 900) } });
    applyStyles();
  }
  function setLetterSpacing(v: number) {
    settings = settingsStore.update({ text: { ...settings.text, letterSpacing: clamp(v, -2, 8) } });
    applyStyles();
  }

  /* 段落设置 */
  function setParagraphSpacing(v: number) {
    settings = settingsStore.update({ paragraph: { ...settings.paragraph, paragraphSpacing: clamp(v, 0, 2) } });
    applyStyles();
  }
  function setTextIndent(v: number) {
    settings = settingsStore.update({ paragraph: { ...settings.paragraph, textIndent: clamp(v, 0, 4) } });
    applyStyles();
  }

  /* 页面布局：4 边距 + 分栏间距 + 开关 + 进度样式 + 参考页数 + 时间 + 24h */
  function setMarginPx(side: "marginTopPx" | "marginBottomPx" | "marginLeftPx" | "marginRightPx", v: number) {
    settings = settingsStore.update({ layout: { ...settings.layout, [side]: clamp(v, 0, 100) } });
    applyStyles();
  }
  function setColumnGapPx(v: number) {
    settings = settingsStore.update({ layout: { ...settings.layout, columnGapPx: clamp(v, 0, 40) } });
    applyStyles();
  }
  /* 页面宽度（2026-09-25）：内容宽度占视口百分比，左右 padding = (100-pct)/2 %；拖动即离开三档预设（custom） */
  function setWidthPct(v: number) {
    settings = settingsStore.update({ layout: { ...settings.layout, widthPct: clamp(v, 50, 100) } });
    applyStyles();
  }
  /* 页宽模式（2026-09-29）：pct = 随窗口百分比；fixed = 固定书页宽（Readst 式居中） */
  function setFixedWidthPx(v: number) {
    settings = settingsStore.update({ layout: { ...settings.layout, fixedWidthPx: clamp(v, 560, 1440) } });
    applyStyles();
  }
  function setShowHeader(e: Event) {
    settings = settingsStore.update({ layout: { ...settings.layout, showHeader: (e.target as HTMLInputElement).checked } });
  }
  function setShowFooter(e: Event) {
    settings = settingsStore.update({ layout: { ...settings.layout, showFooter: (e.target as HTMLInputElement).checked } });
  }
  function setShowProgress(e: Event) {
    settings = settingsStore.update({ layout: { ...settings.layout, showProgress: (e.target as HTMLInputElement).checked } });
  }
  function setProgressStyle(key: string) {
    settings = settingsStore.update({ layout: { ...settings.layout, progressStyle: key as ReaderProgressStyle } });
  }
  function setBottomBarMode(key: string) {
    settings = settingsStore.update({ layout: { ...settings.layout, bottomBarMode: key as ReaderBottomBarMode } });
    // 2026-10-07：底部热区态（bottomBarEdgeHover）已随「纯点击改造」删除，
    // 原先在此清理热区态的分支随之移除。
  }
  /** 排版预设（紧凑/舒适/宽松/绘本）：一键套用边距 + 行距 + 段距 + 字距组合 */
  function applyLayoutPreset(key: string) {
    const p = READER_TYPO_PRESETS[key as ReaderTypographyPreset];
    if (!p) return;
    settings = settingsStore.update({
      lineHeight: p.lineHeight,
      text: { ...settings.text, letterSpacing: p.letterSpacing },
      layout: {
        ...settings.layout,
        marginTopPx: p.marginTopPx,
        marginBottomPx: p.marginBottomPx,
        marginLeftPx: p.marginLeftPx,
        marginRightPx: p.marginRightPx,
        paragraphSpacing: p.paragraphSpacing,
      },
    });
    applyStyles();
  }
  function setReferencePageCount(v: number) {
    settings = settingsStore.update({ layout: { ...settings.layout, referencePageCount: clamp(Math.round(v), 0, 2000) } });
  }
  function setShowCurrentTime(e: Event) {
    settings = settingsStore.update({ layout: { ...settings.layout, showCurrentTime: (e.target as HTMLInputElement).checked } });
  }

  /* ============================================================
   * 2026-10-06 设置弹窗事件处理（Readest 式改造）
   * ------------------------------------------------------------
   * schema 里每行的 path 可��两类：
   *  - `settings.*`（如 fontSize / layout.marginTopPx）→ 写 settingsStore（book/pdf 分片）
   *  - `tts.*`（如 tts.engine / tts.rate）          → 写 ttsCfg + 调 saveTtsSettings 持久化
   * 这里按前缀分流，避免 schema 组件里耦合两套存储。
   * ============================================================ */

  function onSettingsDialogChange(e: CustomEvent) {
    const { path, value } = e.detail ?? {};
    if (!path) return;
    // 2026-10-06：组件销毁后不再处理变更（store 写会同步触发订阅 → applyStyles 读已卸载 DOM）
    if (isDestroyed) return;

    /* ---- TTS：独立配置，走 saveTtsSettings ---- */
    if (path.startsWith("tts.")) {
      const key = path.slice(4) as keyof RewordTtsSettings;
      ttsCfg = { ...ttsCfg, [key]: value } as RewordTtsSettings;
      // 同步派生本地态，避免播放条/高亮按钮与面板显示不一致
      if (key === "rate") ttsRate = Number(value) || ttsRate;
      if (key === "enableHighlight") ttsHighlightOn = value !== false;
      void saveTtsSettings?.({ ...ttsCfg });
      // 2026-10-14 接线修复：把新配置热推给在跑的控制器。
      // 此前此分支只落盘、不 setSettings → 朗读进行中改语速/音高/音量/句间停顿/
      // 高亮/嗓音都不生效（要到下次播放才读新值），正是「设了不生效」。
      // rate/pitch/volume/interval/enableHighlight/颜色/嗓音 由 loop 逐句读取 → 即时生效；
      // engine 需下次播放重建后端才换（不中途打断当前朗读），属预期。
      ttsController?.setSettings({ ...ttsCfg });
      return;
    }

    /* ---- 特殊动作型行（不落 settings）----
       `__dict` 走的是 ctrl:"action"，由SettingsDialog 自己切二级页，
       不会冒泡 change；这里保留兜底，防止将来 schema 改回entry 形态时
       误把一个字符串写进 settings（settings 里并没有 __dict 字段）。 */
    if (path === "__dict") {
      return;
    }

    /* ---- 2026-10-07 移除：原先把「layout.showHeaderFooter」拆成 showHeader/showFooter。
       该虚拟 path 已从 schema 删除（拆成两个独立开关），若继续保留这段，
       用户将来若有别处写到同名 path 会被静默改写两个字段。
       现在 showHeader / showFooter 是**真实字段**，由通用点号路径写入即可。 */

    /* ---- 主题明暗模式（2026-10-07 重写）：**只改 themeMode，绝不动 theme（配色）** ----
       旧实现（错在字段设计，不是逻辑写错）：theme 一个字段同时管明暗与配色，
       于是「主题模式」只能靠改写 theme 来表达 —— 选暗就把配色改成 night/dark，
       用户看到的就是「点一下主题模式，下面配色也跟着变了」。
       拆分后两个字段各管一维，改明暗对配色零影响。 */
    /* ---- 行为 Tab（2026-10-08 新增）：已实现功能的入口 ----
     *
     * 这些字段的执行链**早就完整**，只是此前面板上没有任何入口
     * （审计发现 flow 在本文件有 66 处引用，却没有一行 UI 能改它）。
     * 现在补上入口，故必须调用与旧 UI 相同的 apply* 函数 ——
     * 只 update settings 是不够的：
     *   flow 要重排（否则看到的还是旧版式），
     *   focusMode 要重新注入 .reword-focus class。
     *
     * ⚠️ 2026-10-09：原turnStyle / turnAnimated / clickToTurn 三条分支随UI 一并删除
     *   （翻页观感固定为朴素推移，点击分区翻页整块下线）。
     */
    if (path === "flow") {
      onSetFlow(value);
      return;
    }
    if (path === "focusMode") {
      settings = settingsStore.update({ focusMode: value !== false });
      applyStyles();
      applyFocusMode();
      return;
    }
    if (path === "selToolbarEnabled" || path === "selSearchEnabled") {
      settings = settingsStore.update({ [path]: value !== false } as any);
      // 划词工具栏按钮集是响应式的（模板直接读 settings.selSearchEnabled），
      // 无需额外 apply；关闭工具栏时若正开着，顺手收起。
      if (path === "selToolbarEnabled" && value === false) selToolbar.visible = false;
      return;
    }
    if (path === "wheelPageTurn") {
      settings = settingsStore.update({ wheelPageTurn: value !== false });
      // 开关直接决定 passive:false 的 wheel 监听挂不挂 ⇒ 必须重新同步。
      syncWheelTurnMount();
      return;
    }
    if (path === "exportTarget") {
      settings = settingsStore.update({ exportTarget: value === "doc" ? "doc" : "clipboard" });
      return;
    }

    if (path === "themeMode") {
      settings = settingsStore.update({ themeMode: value } as any);
      applyStyles();
      return;
    }

    /* ---- 排版预设：一次性套用 widthPct + 上下边距 ---- */
    if (path === "__preset") {
      const key = value as ReaderLayoutPreset;
      // ⚠️ 2026-10-08「自定义」档改为**不覆写任何字段**。
      //它的语义是「退出预设接管，由面板上的滑块决定」，
      // 而 `LAYOUT_PRESETS.custom.margins` 全是 0 —— 若照旧覆写，
      // 正文会上下左右全部贴框线（`padding: 0px 10% 0px 10%`），
      // 正是用户反复投诉过的观感。
      // 保留 early-return：点了「自定义」就什么也不做，这才是它的语义。
      if (key === "custom") return;
      const preset = LAYOUT_PRESETS[key];
      if (preset) {
        settings = settingsStore.update({
          layout: {
            ...settings.layout,
            widthPct: preset.widthPct,
            marginTopPx: preset.margins.top,
            marginBottomPx: preset.margins.bottom,
            followSiyuanMargin: false,
          },
        } as any);
        applyStyles();
      }
      return;
    }

    /* ---- 字号来源 / 字号值（2026-10-07 双态，方案 A）----
     fontSizeSync 是布尔（true=跟随思源 / false=自定义），
     而面板上的分段按钮用 "sync"/"custom" 两个人话值 —— RowControl 已做转换，
     这里收到的是布尔。

     ① 用户切档：切到「跟随」立刻读一次思源字号（有值才写，避免把已调好的值打回）；
        切到「自定义」只改标志位，字号沿用当前显示值。
     ② 用户拖字号滑块 / 点 ±：若当前处于跟随态，**自动转为自定义** ——
        否则这次改动会在下次开书被思源值覆盖（用户会觉得「我调了但没生效」）。 */
    if (path === "fontSizeSync") {
      if (value === true) {
        settings = settingsStore.update({ fontSizeSync: true } as any);
        // 先落 flag 再读：syncFontSizeFromSiyuan 内部以 flag 为门槛
        const px = syncFontSizeFromSiyuan();
        if (!px) {
          // 读不到思源字号（无 .protyle-wysiwyg / 越界）→ **静默保持当前值**。
          // 刻意不弹提示：思源里没有文档时本来就没有「正文字号」可言，
          // 弹窗反而会让用户以为设置坏了。记日志便于真机排查。
          getLogger().debug?.("[RE 阅读器] 未能读取思源正文字号，跟随模式保持当前值", {
            fontSize: settings.fontSize,
          });
        }
      } else {
        settings = settingsStore.update({ fontSizeSync: false } as any);
      }
      applyStyles();
      return;
    }

    if (path === "fontSize") {
      const next = clamp(Number(value) || FONT_SIZE_MIN, FONT_SIZE_MIN, FONT_SIZE_MAX);
      const patch: any = { fontSize: next };
      // 手动改字号 = 表达明确意图 → 脱离跟随（方案 A）
      if (settings.fontSizeSync === true) patch.fontSizeSync = false;
      settings = settingsStore.update(patch);
      applyStyles();
      return;
    }

    /* ---- 字体来源切换（2026-10-07 接通字体 Tab）----
       切fontMode 不只是写一个字段：
         · follow-siyuan / classified → 需要宿主网页字体的 blob（霞鹜文楷等
           未安装到系统时，只有 blob 化注入进 iframe 才真正生效），
           不预热就会出现「分类模式选了霞鹜文楷、正文仍是原字体」；
         · custom → 需要先把选中字体的文件取成 blob，否则
           buildFontInjection 拿不到 fontBlobUrl 会静默回落到跟随思源。
       这两件事都是异步的，故走已有的 onSetFontMode（它内部已处理预热 + applyStyles）。 */
    if (path === "fontMode") {
      void onSetFontMode(String(value));
      return;
    }

    /* ---- 选中自定义字体（字体管理二级页上报，2026-10-07）----
       空串 = 用户删掉了正在用的那本 → 回落跟随思源，否则正文会继续引用已删文件。 */
    if (path === "customFontId") {
      const id = String(value || "");
      if (!id) {
        settings = settingsStore.update({ customFontId: undefined, fontMode: "follow-siyuan" } as any);
        applyStyles();
        return;
      }
      void onSelectCustomFont(id);
      return;
    }

    /* ---- 顶栏悬浮（2026-10-08）：切换模式会改变 stage 高度，必须显式重排 ----
     *
     * ## 为什么不能只靠通用的 setByPath + applyStyles
     * 开关切的是**顶栏的定位方式**：
     *   · 悬浮开：`position: absolute` → 顶栏不占流，`.reader-stage`（flex:1）**变高 36px**
     *   · 悬浮关：回到文档流 → stage 矮 36px
     * stage 高度变了 ⇒ 分页器的可用栏高变了 ⇒ 必须重排一次，
     * 否则用户会看到「模式已切、内容却还是旧版式」。
     *
     * ⚠️ 与「收起/展开」刻意区分：那两个只改 transform/opacity，
     *   **不碰任何盒子尺寸** ⇒ 零重排。这是本方案最大的好处，不能破坏。
     */
    if (path === "layout.topBarFloating") {
      settings = settingsStore.update({
        layout: { ...settings.layout, topBarFloating: value !== false },
      });
      // 切到「常驻顶部」时必须让顶栏可见，否则用户会看到一个空白的顶部区域
      // （旧行为由 toolbarVisible 驱动，这里显式对齐）。
      if (value === false) toolbarVisible = true;
      updateTopBarReveal();
      applyStyles();
      // stage 盒子尺寸真的变了，ResizeObserver 会兜底；这里主动派发一次 resize
      // + 强制 reflow，保证切档立刻生效（与 onDeviceClassResize 同一套路）。
      scheduleReaderRelayout();
      return;
    }

    /* ---- 其余：按点号路径写入（fontWeight → text.fontWeight 等嵌套路径）---- */
    const next = setByPath(settings, path, value);
    settings = settingsStore.update(next);
    applyStyles();
  }

  /** 重置为默认（按当前 Tab 所属的 scope 重置整份设置） */
  function onSettingsDialogReset() {
    if (isDestroyed) return;
    // ⚠️ resetAll() 返回 void（内部自行 update 两个 scope），不能拿它的返回值赋给 settings
    // —— 曾因此把 settings 置为 undefined，导致渲染时抛 innerHTML 错误、整个阅读界面崩溃。
    settingsStore.resetAll();
    // 从 store 重新取当前 scope 的值（update 是同步的，这里立刻能拿到）
    settings = settingsStore.get();
    applyStyles();
  }

  /** 特殊动作（目前只有「管理词典」，已由设置弹窗内部处理为二级页） */
  function onSettingsDialogAction(e: CustomEvent) {
    // 2026-10-07 第 3 批：词典管理改为弹窗内二级页后，SettingsDialog 自己
    // 切页（onAction 里判dictManager），**不再向外冒泡**。
    // 这里保留兜底：若将来有新动作从弹窗抛出，仍能在此集中处理。
    if (e?.detail === "dictManager") {
      getLogger().debug?.("[RE 阅读器] 词典管理已由设置弹窗内二级页接管");
    }
  }

  /**
   * 设置弹窗里选好了「本书的发送目标」（2026-10-09）。
   *
   * 由 `DocumentPickerPage`（`mode="book"`）派发 —— 页面拿不到 store，
   * 所以只把选中的三字段冒泡上来，由这里写 `BookMeta.notebookTarget`。
   */
  async function onBookTargetPicked(e: CustomEvent) {
    const picked = e?.detail;
    const targetBookId = picked?.bookId || bookId;
    if (!targetBookId) return;
    if (!picked?.docId) {
      // 清除绑定（总览页点「清除绑定」或文档树点「清除」）
      const ok = await store.setNotebookTarget(targetBookId, null);
      if (ok) toast(t("已清除本书的发送目标"));
      return;
    }
    const ok = await store.setNotebookTarget(targetBookId, {
      docId: picked.docId,
      docTitle: picked.docTitle,
      notebookName: picked.notebookName,
    });
    if (!ok) {
      toast(t("设置发送目标失败：未找到该书"));
      return;
    }
    toast(
      t("本书的笔记将发送到《{doc}》", {
        doc: picked.docTitle || picked.docId,
      }),
    );
  }

  /**
   * 设置弹窗里点「⚡ 按书名自动建档」（2026-10-10，方案 B）。
   *
   * 由 `DocumentPickerPage`（`mode="book"`）派发，宿主这里跑真正的建档流程：
   * 校验位置 → 查重 → 建/复用 → 回填 BookMeta，全部在 `autoBindByTitle` 内完成。
   */
  async function onAutoBind(e: CustomEvent) {
    if (isDestroyed || !bookId) return;
    const bookTitle = String(e?.detail?.bookTitle || store.get(bookId)?.title || "");
    if (!bookTitle) {
      toast(t("书名缺失，无法按书名建档"));
      return;
    }
    try {
      const r = await autoBindByTitle(
        store,
        bookId,
        bookTitle,
        settings.autoNotebookId,
        settings.autoNotebookName,
        settings.autoArchivePath,
      );
      toast(
        t(r.created ? "已创建并绑定《{doc}》" : "已绑定已有文档《{doc}》", { doc: bookTitle }),
      );
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      toast(t("自动建档失败：{why}", { why }));
    }
  }

  /**
   * 词典二级页内容变化（导入/启停/删除/改偏好）。
   *
   * 词典是**全局**资源（跨书籍、跨格式），清单与引擎都已由 DictManager 落盘，
   * 这里不需要再写任何 store；留这个回调是为了两点：
   *   1. 把事件接出来，将来若要做「重启后是否需要重载引擎」的提示，有地方挂；
   *   2. 避免 SettingsDialog 派发一个没人监听的事件（静默失败最难查）。
   */
  function onDictManagerChanged(e: CustomEvent) {
    if (isDestroyed) return;
    getLogger().debug?.("[RE 阅读器] 词典清单已变更", { detail: e?.detail });
  }

  /**
   * 字体管理二级页变化（导入 / 删除，2026-10-07）。
   *
   * FontStore 自己已把清单持久化（hiword-reader-fonts.json），这里只做两件事：
   *   1. 刷新本组件缓存的 customFonts（供后续切换字体时用）；
   *   2. 导入/删除后重刷样式 —— 删除的正可能是当前使用的那本，
   *      customFontId 的清理由页面经 change 事件上报，这里只管样式与缓存。
   */
  async function onFontManagerChanged(e: CustomEvent) {
    if (isDestroyed) return;
    await refreshFonts();
    applyStyles();
    getLogger().debug?.("[RE 阅读器] 字体清单已变更", { detail: e?.detail });
  }


  /* 笔记插入相关函数已移除（2026-08-25） */

  function setCustomColor(kind: "customFg" | "customBg", value: string) {
    settings = settingsStore.update({ [kind]: value } as any);
    if (settings.theme !== "custom") {
      settings = settingsStore.update({ theme: "custom" });
    }
    applyStyles();
  }

  function swatchStyle(bg: string): string {
    return `background:${bg}`;
  }

  function onCustomColor(kind: "customFg" | "customBg", e: Event) {
    setCustomColor(kind, (e.target as HTMLInputElement).value);
  }

  // 2026-08-27 晚（P2.3 自定义背景图）：URL 输入实时预览
  function onCustomBgImage(e: Event) {
    const url = (e.target as HTMLInputElement).value.trim();
    settings = settingsStore.update({ theme: "custom", customBgImage: url || undefined } as any);
    applyStyles();
  }

  function clearCustomBgImage() {
    const input = document.querySelector<HTMLInputElement>(".reader-text-input");
    if (input) input.value = "";
    settings = settingsStore.update({ customBgImage: undefined } as any);
    applyStyles();
  }

  /* ================= 字体 ================= */

  async function refreshFonts() {
    customFonts = fontStore.list;
  }

  async function loadFontBlob(f: CustomFont) {
    try {
      const blob = await getFileBlob(f.path);
      if (blob) {
        if (fontBlobUrl) URL.revokeObjectURL(fontBlobUrl);
        fontBlobUrl = URL.createObjectURL(blob);
      }
    } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · loadFontBlob", "debug"); }
  }

  async function onSetFontMode(key: string) {
    settings = settingsStore.update({ fontMode: key as ReaderFontMode });
    if (key === "custom" && settings.customFontId) {
      const f = fontStore.get(settings.customFontId);
      if (f) await loadFontBlob(f);
    }
    // 切到需要宿主字体 blob 的模式时，确保先异步预热（否则网页字体在 iframe 内不生效）
    // 2026-10-07：custom 也需要 —— 该档下四条字体链靠 blob 才生效（霞鹜文楷等网页字体）。
    if (key === "follow-siyuan" || key === "custom" || key === "classified") {
      await prepareHostFontBlobs();
    }
    applyStyles();
  }

  async function onSelectCustomFont(id: string) {
    settings = settingsStore.update({ fontMode: "custom", customFontId: id });
    const f = fontStore.get(id);
    if (f) await loadFontBlob(f);
    applyStyles();
  }

  async function onRemoveFont(id: string) {
    const wasSelected = settings.customFontId === id;
    await fontStore.removeFont(id);
    await refreshFonts();
    if (wasSelected) {
      settings = settingsStore.update({ customFontId: undefined, fontMode: "follow-siyuan" });
    }
    applyStyles();
  }

  async function onFontImport(e: Event) {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    if (!f) return;
    fontImporting = true;
    try {
      const font = await fontStore.importFont(f);
      await refreshFonts();
      settings = settingsStore.update({ fontMode: "custom", customFontId: font.id });
      await loadFontBlob(font);
      applyStyles();
    } catch (err: any) {
      alert(t("导入字体失败：{err}", { err: err?.message || err }));
    } finally {
      fontImporting = false;
      input.value = "";
    }
  }

  function pickFontMode(key: string) {
    void onSetFontMode(key);
  }

  function pickCustomFont(id: string) {
    void onSelectCustomFont(id);
  }

  function delFont(id: string) {
    void onRemoveFont(id);
  }

  function fmtFontSize(n: number): string {
    const kb = n / 1024;
    return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`;
  }

  /* ================= 进度条 ================= */

  function onProgressInput(e: Event) {
    dragging = true;
    const v = Number((e.target as HTMLInputElement).value) / 1000;
    progress = v;
    progressText = fmtPct(v);
  }

  function onProgressChange(e: Event) {
    const v = Number((e.target as HTMLInputElement).value) / 1000;
    dragging = false;
    progress = v;
    progressText = fmtPct(v);
    if (view) {
      try {
        view.goToFraction(v);
      } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · onProgressChange", "debug"); }
    }
  }

  /**
   * 2026-08-23 起：点击浮层「外部」自动收起（之前只能点按钮收起，体验差）。
   * 2026-08-25 补：覆盖三类瞬时浮层 —— 划词工具栏(selToolbar)、批注窗口(noteEditor)、脚注气泡(showFootnote)。
   *   设计依据（心理模型）：用户潜意识认为弹出的浮层是「临时」的，点击背景 = 放弃操作 / 回到主界面。
   *   因此任何落在浮层之外的点击都应将其收起；浮层自身及按钮内的点击保持不变。
   * 实现：mousedown 监听绑到 reader-view 容器（不是 document），避免影响思源原生 UI：
   *   - target 在任一 popover / 工具栏 / 批注卡片内（含子元素）→ 不动（让其自身 click 处理）
   *   - target 在 toolbar 按钮上 → 不动（让 click 触发 toggle，避免先关再开抵消）
   *   - foliate 阅读区内点击 → 工具栏/批注窗口按 A/B 场景处理；脚注（独立浮层）一律收起
   *   - 其他 → 关闭所有 popover + 工具栏 + 批注窗口 + 脚注
   * 用 mousedown 而非 click：保证在按钮 mousedown 时不会先关掉（click toggle 还没触发）
   * 用 reader-view 容器监听（不是 document）的好处：思源顶栏/侧栏/命令面板/dock 的点击
   *   完全不触发本 listener → 不干扰思源原生 UI（如"管理"按钮）的点击时序。
   *
   * 【2026-10-13 · 浮层收起交互语义表】（与《流程设计方案-浮层统一收起.md》对应）
   *   · 点正文空白   → 收：划词工具栏 / 批注卡 / 抽屉(目录·书签·标注) / 脚注 / 词典；
   *                    不收：圆点点开的顶栏（topBarPinned = 显式意图，显式操作显式收）
   *   · 点浮层内部   → 不动（豁免：data-dismiss-ignore 根元素，见下方守卫）
   *   · 点顶/底栏按钮 → 不动（click 自己 toggle）
   *   · 点顶栏圆点收顶栏 → 联动收所有抽屉（toggleTopBarPin 两分支都走 closeAllPopovers）
  *   · Esc / 点 .reader-backdrop → 等价点空白
  */

  /* 2026-10-14 合成事件防御（修复「批注卡输入中按 Shift 被误关」）：
   * 思源全局 Shift 机制——按下 Shift 时 siyuan.shiftIsPressed=true + body--shift-pressed +
   * 强制刷新悬停浮窗——会向内容区派发合成 mousedown（isTrusted=false），并引起书页布局
   * 抖动产生无滚动的伪 relocate，二者都会命中「点空白 / 滚动=收起浮层」误关批注卡。
   * 防御（onContentMouseDown / onContainerMouseDown / onRelocate 三入口）：
   * isTrusted=false、思源 Shift 模式、无毫秒级紧邻 pointerdown/scroll 的 mousedown/relocate
   * 一律不收起浮层；真用户操作（trusted + 毫秒级紧邻 pointer/scroll）完全不受影响。 */
  let lastPointerDownMs = -1e9;
  window.addEventListener("pointerdown", () => { lastPointerDownMs = performance.now(); }, true);
  /** iframe 口径最近 pointerdown / scroll 时间戳（attachContentDoc 内 capture 记录） */
  let contentPointerDownMs = -1e9;
  let lastContentScrollMs = -1e9;

  function closeAllPopovers() {
    // 2026-10-25 停靠模式：停靠面板是"常驻"语义，点空白/Esc 不收（关闭走各面板
    // 自己的开关按钮或取消固定）；其余浮层照旧全部收起。
    if (!sidebarPinned) {
      showToc = false;
      showMarks = false;
      activeDrawer = null;
      showSearch = false;
    }
    showSettings = false;
    // 2026-10-24 移动端适配 Phase 2.1：⋯ 溢出菜单随统一收起链路关闭
    showMoreMenu = false;
    showFootnote = false;
    // 2026-10-10：快捷键面板一并收起（Esc / 点空白都走这里）。
    showShortcutHint = false;
    dictPopup = { ...dictPopup, visible: false };
    // 2026-10-15 图片灯箱一并纳入统一收起链路（Esc / 点空白 / 打开其它浮层）
    closeImageViewer();
    // 编辑态划词工具栏一并收起（重置为 create 态，避免残留 editingId）
    if (selToolbar.visible) closeSelToolbar();
    // 2026-10-08 顶栏浮层化：抽屉全关了 ⇒ 解除「为浮层而保持顶栏可见」的临时状态。
    // ⚠️ 只清 topBarBarHover，**不动 topBarPinned** ——
    //   用户点圆点显式点开的顶栏是显式意图，点空白不该把它也收掉
    //   （与底栏「移出栏外若非 pinned 则收回」的规则一致）。
    releaseTopBarForPopover();
    // 2026-10-08 批注卡片改版：折叠气泡（样式/色板）一并收起。
    // ⚠️ 必须挂在这里而不是另起 Esc 监听 —— 全局 `:3191` 的 Escape 已经走 closeAllPopovers，
    //   挂进去才能保证「Esc / 点空白 / 打开其它浮层」三条路径都会收起它。
    closeNoteFolds();
  }

  function onContainerMouseDown(_e: MouseEvent) {
    // 2026-10-14 合成点击防御（主文档口径）：同 onContentMouseDown，合成 mousedown 一律忽略
    const pdtP = performance.now() - lastPointerDownMs;
    const siyuanShiftModeP = (window as any)?.siyuan?.shiftIsPressed === true;
    if ((_e as any).isTrusted === false || siyuanShiftModeP || !(pdtP >= 0 && pdtP < 600)) return;
    // 每次点击重置抑制标志（每个点击独立判断）
    suppressNextCreateToolbar = false;
    // 2026-08-27：悬浮（hover）词典弹窗无遮罩，普通点击（如开始划选）应直接收起，避免遮挡。
    //   必须同时检查 dictPopup.visible：scheduleHoverHide 有 220ms 延迟关闭，
    //   在此窗口内 dictPopupSource 仍为 "hover" 但弹窗已不可见，
    //   若不检查 visible 会误拦截工具栏/标注等正常点击（#toolbar-unresponsive）。
    if (dictPopupSource === "hover" && dictPopup.visible) {
      // 点弹窗内部（★/候选词）交给 onDictBodyClick 处理，不在此收起
      const tg = _e.target as Element | null;
      if (tg && tg.closest?.(".reader-dict-popup")) return;
      closeDictPopup();
      return;
    }
    // 2026-08-30 修复：守卫必须覆盖三个抽屉（此前只查 showToc，导致书签/摘录抽屉
    // 开着时点空白不会收起）；activeDrawer 也纳入，避免状态残留时漏关
    if (!showToc && !showMarks && !showSettings && !showSearch && !showMoreMenu && !showFootnote && !selToolbar.visible && !noteEditor.visible && !activeDrawer) return;
    const t = _e.target as Element | null;
    if (!t) return;
    dbg.event("onContainerMouseDown", "▶ 入口", { target: t.tagName + "." + (typeof t.className === "string" ? t.className : ""), selVisible: selToolbar.visible, mode: selToolbar.mode });
    // 在 popover 内（含子元素）：不关
    if (t.closest?.(".reader-popover")) return;
    // 2026-10-06：阅读设置弹窗（Readest 式）内部的所有点击一律不关。
    // 缺这条时，点 Tab 会被判为「点空白」→ closeAllPopovers() → 弹窗瞬间关闭。
    if (t.closest?.(".rwd-backdrop")) return;
    // 2026-08-30 改造：3 抽屉已统一为 .reader-drawer（继承自 .reader-popover），但额外排除
    // 抽屉角标图标本身（点击 = toggle，由 on:click 处理，不走 mousedown 收起）
    if (t.closest?.("[data-drawer-anchor]")) return;
    // 2026-10-13 守卫集中化：豁免对象统一挂 data-dismiss-ignore 属性
    //（现挂载：.reader-toolbar / .reader-sel-toolbar / .reader-note-editor / .reader-top-handle），
    // 一条 closest 守卫替代旧 5 条类名列举 —— 以后新增浮层只要挂属性即可，不会再漏。
    // 等价迁移说明：
    //   · 旧 .reader-ann-editor 守卫是死代码（全库无任何运行时 DOM 挂该类），已删；
    //   · .reader-toolbar / .reader-top-handle / 划词工具栏 / 批注卡 → 全部改挂属性。
    if (t.closest?.("[data-dismiss-ignore]")) return;
    // 2026-08-25 修复（回归）：foliate 内容区的点击需区分两种场景：
    //   A) 点了标注/高亮/SVG 绘制层 → 延迟一帧关闭（让 show-annotation / 选区事件先触发，避免竞争）；
    //   B) 点了空白/普通文本 → **立即**关闭工具栏（无需等待，没有 show-annotation 会触发）。
    //   此前 bug：A/B 都走 RAF 延迟，但 B 路径的 RAF 可能被后续事件链意外取消或竞态吞掉，
    //   导致用户感知"点空白不关闭"。现在 B 路径走同步 closeSelToolbar，可靠即时响应。
    const isFoliateArea = !!(
      t.closest?.("reword-foliate-view") || (t as any).tagName === "reword-foliate-view"
    );
    const isAnnotationTarget = !!(
      t.closest?.("foliate-highlight") || (t as any).closest?.("[data-annotation]") ||
      (t as any).namespaceURI === "http://www.w3.org/2000/svg"
    );
    if (isFoliateArea) {
      dbg.step("onContainerMouseDown", "foliate 区域命中", { isAnnotationTarget, tag: t.tagName, cls: typeof t.className === "string" ? t.className : "" });
      if (isAnnotationTarget) {
        // 场景 A：点了标注/SVG → 抑制创建工具栏（show-annotation 会接管，弹 edit 工具栏或批注弹窗）
        suppressNextCreateToolbar = true;
        // 只关工具栏（让 show-annotation 随后处理批注弹窗）。
        // 不关 noteEditor：onShowAnnotation → showViewerForRec 会打开/切换批注弹窗，
        // 若这里用 RAF 关掉会产生竞态（RAF 在 show-annotation 之后执行 → 刚打开的弹窗被关掉）。
        cancelPendingClose();
        pendingCloseRaf = requestAnimationFrame(() => {
          pendingCloseRaf = null;
          if (selToolbar.visible) closeSelToolbar();
          // 注意：不关 noteEditor，由 onShowAnnotation / showViewerForRec 全权控制
        });
      } else {
        // 场景 B：点空白/普通文本 → 立即关闭工具栏 + 收起目录/书签/摘录抽屉
        // 2026-08-30 修复：此前这里只关了划词工具栏，没关抽屉，
        // 导致书签/摘录抽屉在正文区点空白关不掉；正文任意空白视为「终止操作」应一并收起
        closeAllPopovers();
        if (noteEditor.visible) noteEditor = { ...noteEditor, visible: false, mode: "create", id: null };
      }
      // 脚注是独立瞬时浮层，与标注/工具栏无耦合：在 foliate 阅读区任意点击都视为「点击外部」，
      // 立即收起（符合「点背景 = 放弃操作 / 回到主界面」的心理模型）。
      // 脚注气泡自身（.reader-popover）的点击已在上方提前 return，不会走到这里，故不会误关。
      if (showFootnote) closeFootnote();
      return;
    }
    // 其他区域（空白等）：关闭所有浮层 + 划词工具栏 + 统一批注浮层
    closeAllPopovers();
    if (selToolbar.visible) closeSelToolbar();
    if (noteEditor.visible) noteEditor = { ...noteEditor, visible: false, mode: "create", id: null };
  }

  // ============ 划词悬浮工具栏 + 即时词典（Phase 1） ============
  // 复用 dict-engine / dict-renderer：监听 foliate 内容选区，弹出微信读书 / Readest 式悬浮工具栏。
  // 选区可能落在 foliate 渲染进 iframe 的内容文档里，因此需扫描 view.renderer.getContents()
  // （每项含 { index, doc }），并对 iframe 偏移做坐标换算。
  interface SelRect { left: number; top: number; right: number; bottom: number; }
  interface ReaderSel { text: string; rect: SelRect; index: number; cfi: string | null; range: Range | null; pdfRects?: PdfRect[] | null; }
  // 2026-08-29 四向避让：工具栏可置于选区的 上/下/左/右 四个方向，
  // 优先上下（视线不跳变），上下均无空间时退到右/左（垂直居中于选区），彻底避开选中文本。
  type ToolbarPlace = "above" | "below" | "left" | "right";
  interface SelToolbarState {
    visible: boolean;
    x: number;
    y: number;
    text: string;
    mode: "create" | "edit";
    editingId: string | null;
    // 工具栏朝向：四向避让结果。'above'/ 'below' 视线不跳变优先；'left'/'right' 上下无空间时退避。
    place: ToolbarPlace;
    // ⚠️ 2026-10-11 微信读书化：原 `stripVisible` 字段已删除。
    // 新行为（用户拍板 D3）：create 态点「标注」= 一键高亮 + **原地转 edit 态**（样式行随 edit 态滑入），
    // 因此样式行只由 `mode === "edit"` 决定，不再需要独立的展开开关。
    // edit 态当前标注（删除 / 即时改样式 / 即时改颜色 用）
    annId: string | null;
    annCfi: string | null;
    // edit 态样式条的「当前样式/颜色」高亮（以 annStore 为唯一真源，进入时快照，改后同步）
    annStyle: AnnotationStyle | null;
    annColor: string | null;
    // 2026-08-24 死锁解除：数据层已无活跃记录、但视觉仍有残留高亮时，
    // 兜底分支置此字段，edit 工具栏显示「清除残留高亮」按钮（onClearGhostHighlight）。
    ghostCfi?: string | null;
    // 2026-10-12 P1-D8 退出动画：正在播收起动画。
    // true 时 `visible` 仍为 true（DOM 必须还在才看得见动画），到点由 SEL_TOOLBAR_OUT_MS 计时器
    // 调 hardCloseSelToolbar() 真正卸载；期间整条不吃点击（CSS .closing）。
    // ⚠️ 定义成 optional：所有「打开工具栏」的状态字面量都不写这个字段 ⇒ 天然被清零，
    //    旧计时器再触发也会被 `if (!selToolbar.closing) return` 挡掉，不会误关新开的工具栏。
    closing?: boolean;
    // 2026-10-12 P1-§6.4 窄屏兜底：可读区放不下主栏的留白预留时置 true，
    // CSS 按内容排布。与 closing 一样是 optional —— 打开工具栏的字面量不写它即为 false。
    narrow?: boolean;
  }

  let selToolbar: SelToolbarState = { visible: false, x: 0, y: 0, text: "", mode: "create", editingId: null, place: "above", annId: null, annCfi: null, annStyle: null, annColor: null };
  // 工具栏 DOM 引用（用于实测高度，替代写死的 44px）+ 实测高度缓存。
  // 首帧用默认 TOOLBAR_BAR_ONLY_H 兜底，渲染后实测并缓存，后续翻面判断用真实高度，避免高处选区被裁切。
  let selToolbarEl: HTMLElement | null = null;
  // 2026-08-30：样式行 DOM 引用（实测真实高度，替代写死的 TOOLBAR_WITH_STRIP_H 常量）。
  // 2026-10-11：样式行现在只在 edit 态渲染（微信读书化后 create 态无展开开关），故 edit 取值为实测、create 恒为 null。
  // 所有读取处都要判空回退。
  let selStripEl: HTMLElement | null = null;
  // 预估高度常量：仅主栏（create 态默认）vs 含样式行（edit 态）。
  // 2026-10-11 微信读书化重算：
  //   主栏 = CSS 固定 height 54px（44px 按钮 + 上下各 5px，按钮内是图标 16 + 间距 3 + 10px 标签）；
  //   样式行 = 药丸 padding 12 + 字形 15 / 色点 24 + 上下 2 边框 ≈ 39，加两行间距 8
  //   ⇒ 54 + 8 + 39 = 101。
  // 这两个数只在首帧（无实测值）兜底，渲染后立刻被 offsetHeight 实测值覆盖。
  const TOOLBAR_BAR_ONLY_H = 54;
  const TOOLBAR_WITH_STRIP_H = 101;
  // 2026-10-12 P1-D8 退出动画时长（必须与 CSS 的 selToolbarFadeOut / selToolbarShrinkOut 一致）。
  // ⚠️ 真正卸载由这个计时器驱动，**不挂 animationend**：reduced-motion 或标签页被节流时
  //    事件可能永远不来，那样工具栏会卡在屏上下不去（方案 §5.2 记过的坑，Demo 里实测复现过）。
  const SEL_TOOLBAR_OUT_MS = 140;
  let selToolbarOutTimer: any = null;
  // 2026-10-12 P1-§6.4 窄屏兜底阈值：可读区比「主栏 min-width 300 + 两侧各 8px」还窄时，
  // 放弃留白预留、按内容宽度排布（见 CSS 的 .reader-sel-toolbar.narrow）。
  const TOOLBAR_NARROW_BELOW = 316;
  // 运行时实测高度缓存（渲染后实测，避免硬估值误差）。
  let toolbarH = TOOLBAR_BAR_ONLY_H;
  // 2026-08-25 延迟关闭：foliate 区域点击不立即关工具栏（避免与 show-annotation 竞争），
  // 而是预约一帧后关闭；若随后触发了选区/批注事件则取消。
  let pendingCloseRaf: number | null = null;
  // 2026-08-25 修复竞态：点批注/高亮时，onShowAnnotation 会打开编辑工具栏或批注弹窗，
  // 但同一次点击的 mouseup 也会触发 scheduleReadSelection → 创建模式工具栏。
  // 此标志告诉选区路径"本次点击已由 show-annotation 接管，不要弹创建工具栏"。
  let suppressNextCreateToolbar = false;
  // 当前选区的锚点信息（Phase 2 高亮 / 批注 / 导出思源将复用）
  // segments：跨 section 续接时的分段（每段一个 CFI）；同 section 跨页时为空（一个 CFI 即可覆盖）
  let selInfo: {
    index: number; cfi: string | null; range: Range | null;
    pdfRects?: PdfRect[] | null; segments?: { index: number; cfi: string }[];
  } | null = null;
  // 当前选区矩形（已换算到主文档坐标），供批注编辑器/查看气泡定位使用
  let lastSelRect: SelRect | null = null;
  // ===== 2026-10-14 P1：选区两端「定位标识」手柄 =====
  // create 态选区出现，起点=首行左上、终点=末行右下；拖拽实时改选区 base/extent 并重锚工具栏。
  // 坐标为 .reader-floating-layer 相对坐标（与 selToolbar.x/y 同基准，absolute 定位）。
  // h = 该端所在行的行高（容器 px），驱动手柄竖条高度，随字号缩放（仿微信读书 caret 手柄）。
  let selHandles: { visible: boolean; start: { x: number; y: number; h: number }; end: { x: number; y: number; h: number } } =
    { visible: false, start: { x: 0, y: 0, h: 0 }, end: { x: 0, y: 0, h: 0 } };
  // 拖拽中标志：抑制 iframe/父文档选区路径（scheduleReadSelection）干扰，并驱动手柄 active 样式。
  let selHandleDragging: null | "start" | "end" = null;
  // ===== 2026-10-24 跨页标注续接 =====
  // 拖手柄时指针越过可见页边 ⇒ 自动翻到下一页并把选区续过去（对齐 Word / 微信读书）。
  //
  // ## 为什么选区能"续"
  // foliate 分页是**一个 section 一个 iframe + CSS 多列**：iframe 元素被撑成整个 section 的
  // 宽度（paginator.js expand() 的 expandedSize），列在 iframe 内部横向流动。
  // ⇒ 同一个 section 内，跨页的文本在 DOM 上是**连续的一段**，
  //   一个 DOM Range 就能跨过列断 ⇒ 一个 CFI 覆盖整段跨页选区。
  //
  // ## 跨 section 不行
  // 不同 section 是不同 iframe / 不同 Document，Range 无法跨文档 ⇒ 只能按段存
  // （AnnotationItem.segments），逐段画。
  //
  // ## 续接有效期（时间戳）
  // 翻页是异步的（foliate 内部有动画 + 100ms 等待），relocate 事件会**晚于**翻页请求到达。
  // 故用「有效期」而非布尔量：翻页后一段时间内 relocate 走「重锚」分支而不是「收起」分支。
  let selContinuationUntil = 0;
  /** 探不到「文字列边界」时的兜底内缩（px）：从窗口边往里让这么多当页边带内沿 */
  const EDGE_TURN_ZONE = 36;
  /** 页边带容差（px）：手柄本就画在文字末端上，不给容差会「看得见却进不去」 */
  const EDGE_TURN_TOL = 4;
  /** 方向性位移门槛（px）：往目标方向**累计**拖过这么多才算「用户想跨页」，
   *  用累计极值而不是净位移 —— 原地小幅抖动不算，拖出去再抖回来仍算。 */
  const EDGE_TURN_MIN_MOVE = 12;
  /** 带内驻留（ms）：Readest 同款防误翻（armDwell）。掠过页边不停 ⇒ 不翻页。 */
  const EDGE_TURN_DWELL_MS = 350;
  /** 重进带的最小间隔（ms）：配合 engagement 锁存，防止离开带又立刻擦回来连翻 */
  const EDGE_TURN_REARM_MS = 200;
  // ★ 连翻不再用「冷却时间」控制：engagement 锁存（一次按住只翻一页，
  //   必须把手柄**拉出页边带再拖回来**才允许翻下一页）。锁存位是拖拽闭包内的局部量。
  //   2026-10-24 定稿依据：Readest 0.12.12 useReader.ts 的 didAutoTurnThisGesture 锁存。
  /** 页边驻留提示（拖手柄进带后、翻页前出现的方向提示，Readest turnHint 同款） */
  let selEdgeHint: { visible: boolean; x: number; y: number; dir: "prev" | "next" } = { visible: false, x: 0, y: 0, dir: "next" };
  /** 翻页后要把按住的指针点回放一次（选区自动延伸进新页）；由 onRelocate 消费一次，松手即作废 */
  let selDragReplay: (() => void) | null = null;

  /* ================= 2026-10-25 角落自动翻页（Readest useAutoPageTurn/PageTurnHint 复刻） =================
   * 与"页边带"（上方 EDGE_TURN_*，服务手柄贴边续拖）共存：**角优先** —— 指针落入
   * stage 角落的四分之一椭圆（min(轴×15%, 50px)）时角落机接管（apply() 里 isActive 让带子让位），
   * 驻留 500ms 翻一页，一次驻留只翻一页（离开角再进才解锁）。L 形双条动画见模板 corner-hint 块。 */
  let cornerHint: {
    corner: CornerSide;
    turned: boolean;
    left: number; top: number; width: number; height: number;
  } | null = null;
  /** 进入角后下一帧置 true 触发 CSS 生长动画（Readest 用 rAF 打破首帧同帧渲染，同款） */
  let cornerHintGrown = false;
  /** 手柄拖拽闭包把自己的 turnAtEdge 挂到这里（角优先时直接复用闭包的锁存/回放/翻页链） */
  let handleEdgeTurn: ((logical: "prev" | "next") => void) | null = null;

  function isRtlContent(): boolean {
    const rtl = (view as any)?.renderer?.rtl;
    if (typeof rtl === "boolean") return rtl;
    return (view as any)?.book?.dir === "rtl";
  }

  // 先声明后赋值：宿主回调引用 cornerMachine 自身，直连初始化会形成循环类型推断
  let cornerMachine: CornerTurnMachine;
  cornerMachine = new CornerTurnMachine({
    rect: () => {
      if (!readerStageEl) return null;
      const r = readerStageEl.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null;
    },
    rtl: () => isRtlContent(),
    onArmed: (corner, rect) => {
      cornerHintGrown = false;
      // ⚠️ rect 是视口口径（stage.getBoundingClientRect），而 corner-hint 是
      // .reader-view 的绝对定位子元素 —— 必须减容器自身偏移换算成容器坐标，
      // 否则条被画到容器外（阅读器 Tab 在思源窗口里不在视口原点）。同 toContainerCoords。
      const host0 = readerViewEl?.getBoundingClientRect();
      const ox = host0?.left ?? 0;
      const oy = host0?.top ?? 0;
      cornerHint = {
        corner, turned: false,
        left: rect.left - ox, top: rect.top - oy,
        width: rect.right - rect.left, height: rect.bottom - rect.top,
      };
      requestAnimationFrame(() => { cornerHintGrown = true; });
    },
    onDismiss: () => { cornerHint = null; cornerHintGrown = false; },
    onTurn: (corner, dir) => {
      if (cornerHint) cornerHint = { ...cornerHint, turned: true };
      turnAtCorner(dir);
    },
    stillInCorner: (c) => cornerMachine.checkLiveness(c),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as number),
  });

  /** 角落翻页动作：手柄路径复用闭包 turnAtEdge（锁存 + 自带 replay=apply）；
   *  原生拖选路径：续接窗口 + 锚点快照回放（翻页后在新页把选区延伸到指针落点）。 */
  function turnAtCorner(dir: "prev" | "next") {
    if (handleEdgeTurn) { handleEdgeTurn(dir); return; }
    selContinuationUntil = performance.now() + 1500;
    selDragReplay = () => replayNativeCornerSelection();
    turnPage(view, dir);
  }

  /** 原生拖选翻页后的回放：锚点（拖选前进方向时 anchor=固定起点）在新页扩展到指针落点。
   *  与手柄闭包的 apply() 等价，但锚点取自实时 selection 而非拖拽快照。 */
  function replayNativeCornerSelection(): void {
    try {
      const pt = cornerMachine.getPoint();
      if (!pt) return;
      const contents = (view?.renderer as any)?.getContents?.() ?? [];
      for (const c of contents) {
        const win = c?.doc?.defaultView;
        if (!win) continue;
        const sel = win.getSelection?.();
        if (!sel || sel.isCollapsed || !sel.anchorNode) continue;
        const frame = (win as any).frameElement as HTMLElement | null;
        const fr = frame?.getBoundingClientRect?.();
        if (!fr) continue;
        const lx = pt.x - fr.left, ly = pt.y - fr.top;
        const doc: any = c.doc;
        let caret: Range | null = null;
        if (typeof doc.caretRangeFromPoint === "function") caret = doc.caretRangeFromPoint(lx, ly);
        else if (typeof doc.caretPositionFromPoint === "function") {
          const cp = doc.caretPositionFromPoint(lx, ly);
          // 局部变量：doc 是 any，直接 caret = doc.createRange() 后 TS 仍视为可空
          if (cp) { const r = doc.createRange() as Range; r.setStart(cp.offsetNode, cp.offset); r.collapse(true); caret = r; }
        }
        if (!caret) continue;
        sel.setBaseAndExtent(sel.anchorNode, sel.anchorOffset, caret.startContainer, caret.startOffset);
        return;
      }
    } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · replayNativeCornerSelection", "debug"); }
  }

  // 2026-10-24 滚轮翻页：手势判定器（懒建，切书/换模式时 reset）
  let wheelDetector: WheelGestureDetector | null = null;
  // 实时手柄刷新的 rAF 节流句柄（selectionchange 高频触发，一帧最多算一次）。
  let selHandleLiveRaf = 0;
  // 2026-10-25 移动端适配 A2：selectionchange → 弹划词工具栏的防抖定时器（见 onContentSelectionChange）
  let selTouchDebounceTimer: any = null;
  // 鼠标/触控正在按住拖选中（pointerdown→up 之间）。滚动收起手柄时据此避让：
  // 拖选到视口边缘会触发自动滚动，此时不能因 scroll 就把正在扩展的手柄/选区收起。
  let contentPointerHeld = false;
  let dictPopup: { visible: boolean; x: number; y: number; html: string; word?: string; source?: "sel" | "hover" | null } = { visible: false, x: 0, y: 0, html: "", word: "", source: null };
  // 2026-08-27：Option+悬浮取词（英文）相关状态
  let dictPopupEl: HTMLElement | null = null;       // 弹窗 DOM 引用（用于命中检测）
  let dictPopupSource: "sel" | "hover" | null = null; // 当前弹窗来源（sel=划词工具栏, hover=悬浮）

  let hoverHideTimer: any = null;                   // 悬浮弹窗延迟收起计时器
  let hoverWord: string | null = null;             // 当前悬浮命中的单词（去重用）
  let hoverAnchorRect: DOMRect | null = null;       // 当前悬浮词在 iframe 坐标系下的矩形（容差带判定用）
  let toastMsg = "";
  let toastTimer: any = null;

  // ===== Phase 2：书籍批注（高亮 + 批注）状态 =====
  // 批注数据层单例（index.ts 初始化后注入；懒取，容错）
  // R3 类型收口：any → AnnotationStore | null（upsert 签名已放宽为 Partial，局部更新无需 as any）
  let annStore: AnnotationStore | null = null;
  // cfi → 渲染记录（show-annotation 时反查 note / id）
  // annByValue 只存 {id, cfi, color}：note/style 一律以 annStore 为唯一真源。
  // 避免三处 note 拷贝不一致（2026-08-24 重构）。
  const annByValue = new Map<string, { id: string; cfi: string; color: string }>();
  // cfi → 章节索引 懒缓存：避免每次翻页（create-overlay）都对全书批注做 O(N) 的 resolveNavigation 重解析。
  // 章节 overlay 创建时只重加属于该章节的批注，根除翻页闪烁与性能悬崖。
  const annIndexCache = new Map<string, number>();
  // 上次选用的样式/颜色/分组（高亮/批注复用，贴近微信读书「一键高亮」体验）
  // 2026-08-30 升级：初值优先读「上次实际用过」的样式（持久化在 annotation-config），
  // 无历史才回退用户配置的默认样式 —— 这样重启思源后点「标注」仍是上次的紫色高亮。
  let lastStyle: AnnotationStyle = getLastAnnotationStyle();
  let lastColor: string = getLastAnnotationColor();
  let lastGroup: string = "未分组";
  /**
   * 记住本次实际使用的样式，供下次「标注」一键复用（防抖落盘）。
   * 参数显式传入而非常规读取闭包变量：Svelte 的 `$:` 只跟踪**语句里出现过的**变量，
   * 写成函数无参版本（内部读 lastStyle）不会建立依赖、记忆永不触发。
   */
  function persistLastStyle(style: AnnotationStyle, color: string) {
    setLastAnnotationStyle(style, color);
  }
  // 统一持久化：任何一处改了 lastStyle/lastColor 都会记住（覆盖高亮创建、编辑改样式/改色、
  // 批注保存、查看卡改色等全部入口），无需在每个函数里手写一遍，也不会漏。
  // 因 setLastAnnotationStyle 内部有 300ms 防抖，连续点颜色只会落盘一次。
  $: persistLastStyle(lastStyle, lastColor);
  // 「标注」按钮上的样式预览文案（Svelte4 模板表达式不支持 ?. / ??，故在 script 里算好再给模板用）
  $: lastStyleLabel = t(ANNOTATION_STYLES[lastStyle]?.label || "高亮");
  $: lastColorName =
    t((WHALE_COLORS as readonly { name: string; value: string }[]).find((c) => c.value === lastColor)?.name || "自定义色");
  // 2026-08-24 根治：当前编辑/待删除标注的独立缓存，不随 selToolbar 状态重置而丢失。
  // 修复「删除按钮点击时 selToolbar.editingId 已被选区检测(ws)/关闭逻辑重置为 undefined/null，
  // 导致 onAnnDeleteById 第一行 return 的死锁」。删除时优先读这两个变量。
  let activeAnnId: string | null = null;
  let activeAnnCfi: string | null = null;
  // 统一批注浮层（readest 重设计：创建 / 查看 / 编辑 三态合一，均锚定在选区下方）。
  // - mode='create'：阅读工具栏「批注」按钮打开，新建批注（预填默认色，焦点落在输入框）。
  // - mode='edit'：查看态点「编辑」就地切到编辑态（同一张卡片，位置不跳变）。
  // styleLabel 预计算，以避开 Svelte4 模板表达式不支持的 ?./?? 运算符。
  //
  // 2026-10-08 删除了 `'view'` 这个mode 值。
  //   查证：`showViewerForRec()` 只是 `return showPreviewViewer(...)` 的转发，
  //   **代码里从未给 mode 赋过 "view"**，但模板里一直占着一段 `{#if mode === "view"}` 分支
  //   —— 典型的「死分支」：代码不会走到，却让模板多出近20 行重复 DOM。
  let noteEditor: {
    visible: boolean; x: number; y: number;
    mode: "create" | "edit" | "highlight";
    id: string | null; cfi: string; text: string;
    style: AnnotationStyle; color: string; note: string; group: string;
    time: string; // 格式化时间（查看态展示，updatedAt / createdAt）
    // ⚠️ labels 当前**恒为空数组**（三处赋值里两处直接写 []，一处 resolveLabels()
    //   在无标签数据时也返回 []）⇒ 模板里的标签渲染**从不显示任何东西**。
    //   保留字段与渲染是为将来接入标签功能留位，不要当死代码删（删了要动 resolveLabels 调用链）。
    labels: { id: string; name: string; color: string }[];
    styleLabel: string; // 样式中文名（如「直线」）—— 折叠触发器上显示
    place: ToolbarPlace; // 2026-08-29 四向避让（above|below|left|right），绝不压住选中文本
  } = {
    visible: false, x: 0, y: 0, mode: "create",
    id: null, cfi: "", text: "",
    style: getDefaultAnnotationStyle(), color: getDefaultAnnotationColor(), note: "", group: "未分组",
    time: "", labels: [], styleLabel: t("直线"),
    place: "below",
  };
  let noteEditorEl: HTMLElement | null = null;

  /**
   * 批注卡片宽度（2026-10-08 改版：268 → 400，横向长方形）。
   *
   *🔴 **CSS 与 JS 必须共用这一个值**
   * `positionPopupNear(rect, popupW, popupH)` 用它算四向避让与水平夹紧；
   * 若 CSS 改了而 JS 没改（或反过来），弹窗会按旧宽度算夹紧范围 ⇒ 卡片右边被裁 / 溢出。
   * 改动时务必两边一起动（测试 `smoke-note-card.test.mjs` 有断言守这条）。
   */
  const NOTE_CARD_W = 400;

  /** 折叠气泡的展开状态：2026-10-08 起样式条/ 色板收成单个触发器，点击才展开。
   *  同时只允许一个展开（点另一个会收起前一个）。 */
  let noteFold: { style: boolean; color: boolean } = { style: false, color: false };
  function toggleNoteFold(which: "style" | "color") {
    const willOpen = !noteFold[which];
    noteFold = { style: false, color: false };
    if (willOpen) noteFold = { ...noteFold, [which]: true } as any;
  }
  function closeNoteFolds() {
    if (noteFold.style || noteFold.color) noteFold = { style: false, color: false };
  }

  /**
   * 卡片内点击：点在「折叠区之外」时收起气泡。
   *
   * 🔴 2026-10-08 修一个真bug（真机报障「直线和颜色点击没反应」）：
   *初版只排除了 `.reader-note-pop`，**漏了触发器自己**。
   * 事件冒泡顺序是：触发器 on:click 先跑 `toggleNoteFold` 打开气泡，
   * 同一事件继续冒泡到卡片根元素 → `onNoteCardClick` → `closeNoteFolds()`
   * **同一次点击里开又关** ⇒ 视觉上完全没反应。
   *
   * ⇒ 排除条件必须用**白名单**：只有落在折叠气泡里或折叠触发器上时才不收起。
   * 触发器自己用 `stopPropagation` 也能解决，但那样每个触发器都要写一遍，
   * 漏一个就复发；白名单一处收口，更稳。
   */
  function onNoteCardClick(e: MouseEvent) {
    const t = e.target as Element | null;
    if (!t) return;
    if (t.closest?.(".reader-note-pop") || t.closest?.(".reader-note-fold")) return;
    closeNoteFolds();
  }

  /**
   * 当前是「查看态」吗（点已有批注打开）—— 决定要不要显示取消/保存按钮。
   *
   * 2026-10-08：`preview` 与 `highlight` 都归入查看态。
   * 前者有笔记正文但**改完自动保存**（无保存按钮）；
   * 后者纯标注无笔记，只有样式/色板 + 删除。
   */
  $: isNoteViewer = noteEditor.mode === "preview" || noteEditor.mode === "highlight";

  /* ⚠️ 2026-10-08 删除 `isMac`（快捷键提示里的 ⌘ / Ctrl 判定）。
     它唯一的消费点是行 4 的「⌘+↵ 保存 · esc 关闭」提示，该行已按用户要求整行删除。
     `onNoteKeydown` 两个键都支持，不需要平台判定 —— 若将来要恢复提示，从这里重建即可。 */

  /**
   * 折叠气泡里选样式。
   *
   * 🔴 这里**必须分两条路**，不能像旧代码那样一律只改noteEditor：
   * · 查看态（已有 id）→ 走 `applyViewerStyle`（即时擦旧画新 + 落库），否则改了样式不生效
   * · 编辑态（新建/刚打开）→ 只改本地 state，等点保存时才写
   * 旧模板把这两件事拆在两个分支里各写一遍，现在合并了，必须在这里分流。
   */
  function onPickPanelStyle(s: AnnotationStyle) {
    closeNoteFolds();
    lastStyle = s;
    if (noteEditor.id) applyViewerStyle(s);
    else noteEditor = { ...noteEditor, style: s };
  }

  /** 折叠气泡里选颜色 —— 与onPickPanelStyle 同理 */
  function onPickPanelColor(c: string) {
    closeNoteFolds();
    lastColor = c;
    if (noteEditor.id) applyViewerColor(c);
    else noteEditor = { ...noteEditor, color: c };
  }

  /**
   * 查看态：笔记正文 blur 时**自动保存**（用户拍板「保留自动保存」）。
   *
   * 为什么不做「每次按键都存」：那会在中文输入法打字过程中
   * （拼音组合串还没上屏）就落库，既浪费又会把拼音串存进去。
   * blur 时机最稳：此时输入法已上屏、用户注意力也离开这块。
   *
   * ⚠️ 仅在「有 id 且内容真的变了」时才写 —— 否则点一下输入框再点走
   *   也会触发一次无谓的擦除重绘（视觉会闪一下）。
   */
  async function onNoteAutoSave() {
    if (!isNoteViewer || !noteEditor.id) return;
    const noteVal = noteEditor.note || "";
    const stored = annStore?.get(noteEditor.id);
    if (stored && (stored.note || "") === noteVal) return;
    await onNoteSave();
  }

  /** textarea 键盘：⌘/Ctrl+↵ 保存；Esc 交给全局处理（它会调 closeAllPopovers） */
  function onNoteKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (!isNoteViewer) void onNoteSave();
      return;
    }
    if (e.key === "Escape") {
      // 全局 `:3191` 的 Escape → closeAllPopovers() 已会关卡片；
      // 这里只需把折叠气泡也收掉，并把事件**冒泡上去**（不要拦）。
      closeNoteFolds();
      e.stopPropagation();
      closeAllPopovers();
    }
  }

  /** 取消延迟关闭（选区/批注事件触发时调用，防止工具栏被误关） */
  function cancelPendingClose() {
    if (pendingCloseRaf != null) {
      cancelAnimationFrame(pendingCloseRaf);
      pendingCloseRaf = null;
    }
  }

  /** 系统「减少动态效果」偏好；matchMedia 不可用时按「不减少」处理（宁可多播一段动画）。 */
  function prefersReducedMotion(): boolean {
    try {
      return !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  }

  /** 取消正在播的收起动画（要立刻真正卸载、或新工具栏即将打开时调用）。 */
  function cancelSelToolbarOut() {
    if (selToolbarOutTimer != null) {
      clearTimeout(selToolbarOutTimer);
      selToolbarOutTimer = null;
    }
  }

  /** 真正的卸载：状态清回初值。收起动画播完（或不需要动画）时由 closeSelToolbar 走到这里。 */
  function hardCloseSelToolbar() {
    cancelSelToolbarOut();
    selToolbar = { visible: false, x: 0, y: 0, text: "", mode: "create", editingId: null, place: "above", annId: null, annCfi: null, annStyle: null, annColor: null };
    selInfo = null;
    selHandles = { visible: false, start: { x: 0, y: 0, h: 0 }, end: { x: 0, y: 0, h: 0 } };
    activeAnnId = null;
    activeAnnCfi = null;
  }

  /**
   * 统一关闭划词工具栏 + 清除选区锚点（P0 R1）。
   * 所有 onSel* 出口、删除、取消、空白处 mousedown 都应走这里。
   * 注意：不重置 lastStyle/lastColor（保留用户上次偏好，贴近微信读书一键高亮体验）。
   *
   * 2026-10-12 P1-D8：可见时先播 140ms 收起动画再卸载（原来直接清状态 = 瞬断，真机体感"啪一下没了"）。
   * 三条边界：① 已在收起中不重启动画（计时器会收尾）；② reduced-motion 走即时卸载；
   * ③ 动画期间若已开出新工具栏，`closing` 被新状态清掉 ⇒ 计时器回调判空即返回，不会误关新的。
   */
  function closeSelToolbar() {
    cancelPendingClose(); // 关闭时顺带取消延迟关闭（防重复）
    if (selToolbar.visible && !selToolbar.closing && !prefersReducedMotion()) {
      selToolbar = { ...selToolbar, closing: true };
      cancelSelToolbarOut();
      selToolbarOutTimer = setTimeout(() => {
        selToolbarOutTimer = null;
        if (selToolbar.closing) hardCloseSelToolbar();
      }, SEL_TOOLBAR_OUT_MS);
      return;
    }
    hardCloseSelToolbar();
  }

  // 已挂监听的内容文档（用 Set 而非 WeakSet，便于 onDestroy 时遍历移除，避免泄漏）
  // 2026-08-23 修复：foliate-view 使用 shadow DOM，container.querySelectorAll('iframe')
  // 无法找到内容 iframe；改为通过 view.renderer.getContents() 取 doc 直接挂监听。
  const attachedDocs = new Set<Document>();
  // 每个内容文档上注入的全部监听登记在此，便于统一移除（injectPageTurn 直接绑到 doc 的监听）
  const docCleanups = new Map<Document, Array<{ type: string; fn: EventListenerOrEventListenerObject; opts?: boolean | AddEventListenerOptions }>>();

  /** 给内容文档加监听并登记，确保 detachAllContentDocs 能统一移除（根治重复绑定/翻两页） */
  function trackDocListener(doc: Document, type: string, fn: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions) {
    doc.addEventListener(type, fn, opts);
    let arr = docCleanups.get(doc);
    if (!arr) { arr = []; docCleanups.set(doc, arr); }
    arr.push({ type, fn, opts });
  }

  function attachContentDoc(doc: Document | null | undefined) {
    if (!doc || attachedDocs.has(doc)) return;
    attachedDocs.add(doc);
    // mouseup 用 capture 阶段，先于 bubble 阶段的正文监听处理
    trackDocListener(doc, "mouseup", onContentMouseUp, true);
    // 🔍 2026-10-14 合成点击判别（iframe 口径）：记录最近 pointerdown 时间戳，
    // 供 onContentMouseDown 区分「真用户点击」与「代码派发的合成 mousedown」。
    // 同时置 contentPointerHeld=true：标记「正在按住拖选」，供滚动收起避让（见 hideSelOnScroll）。
    trackDocListener(doc, "pointerdown", (() => { contentPointerDownMs = performance.now(); contentPointerHeld = true; }) as EventListener, true);
    // 2026-10-25 角落自动翻页：原生拖选喂点（Readest 复刻；iframe 局部坐标 → 主文档 client）。
    // 仅指针信号（touch 拖系统手柄拿不到坐标，Readest 同样只做指针）。
    trackDocListener(doc, "pointermove", ((e: PointerEvent) => {
      if (!contentPointerHeld || e.pointerType === "touch") return;
      const fr = (doc.defaultView as any)?.frameElement?.getBoundingClientRect?.();
      if (!fr) return;
      cornerMachine.note(e.clientX + fr.left, e.clientY + fr.top);
    }) as EventListener, true);
    // 🔍 2026-10-14 relocate 判别：记录最近真实滚动时间戳，供 onRelocate 区分
    // 「真滚动/翻页」与「思源 Shift 浮窗机制引起的布局抖动（无滚动的伪 relocate）」。
    // 2026-10-14 P2：滚动即收起工具栏+手柄（对齐微信读书），拖选按住时避让不误收。
    trackDocListener(doc, "scroll", (() => { lastContentScrollMs = performance.now(); hideSelOnScroll(); }) as EventListener, true);
    // 2026-08-27：iframe 内 mousedown 补盲区（父容器监听收不到 iframe 点击）→ 点空白立即收工具栏
    trackDocListener(doc, "mousedown", onContentMouseDown, true);
    // selectionchange 在 document 上触发，不会冒泡到 window，必须挂在 doc 上
    trackDocListener(doc, "selectionchange", onContentSelectionChange, true);
    // 2026-08-27 晚（P2.1）：脚注悬停预览——mouseover 委托，命中脚注引用防抖弹气泡
    trackDocListener(doc, "mouseover", onFootnoteHover as EventListener);
    // 2026-10-15 图片灯箱：正文图片单击放大（冒泡阶段委托，判定见 onContentImageClick）。
    // 挂这里而不是 relocate —— foliate 翻页会重建内容文档，只有这里能保证每个 section 都被覆盖。
    trackDocListener(doc, "click", onContentImageClick as EventListener);
    // 2026-08-29：点击脚注气泡外部（内容区）关闭；捕获阶段先于 onBookLink 的 link 事件
    trackDocListener(doc, "pointerdown", onFootnoteOutsidePointerDown as EventListener, true);
    // 2026-08-27 晚（P2.2）：专注模式滚动高亮（capture 捕获内部滚动容器）
    trackDocListener(doc, "scroll", ((_e: Event) => onFocusScroll(doc)) as EventListener, true);
    // 2026-10-26：移动端压制浏览器原生选词菜单。
    // 真机截图实证：长按选词后 Chrome 的原生浮选菜单（询问Copilot/大声朗读/复制/全选）
    // 压在插件自己的划词工具栏上，两层混在一起。原生菜单属浏览器 UI 层，CSS/z-index
    // 盖不住，唯一办法是不让它弹出（对标思阅 SiReader 的 contextmenu → preventDefault）。
    // · 只在移动端前端生效：桌面右键菜单有实际用途（复制粘贴 / PDF 标注 / 链接右键）。
    // · 只 preventDefault、**不** stopPropagation ⇒ 同文档上 PDF 矩形标注的右键菜单
    //   （PdfTextHlLayer 自绘的 JS 菜单）照常可用。
    // · iOS 的长按「复制/查找/共享」是系统 callout 菜单，不派发 DOM contextmenu，
    //   只能靠 CSS 属性关 ⇒ 同时给内容文档 html 加 -webkit-touch-callout:none。
    if (shouldSuppressNativeMenu({ mobile: isMobile() })) {
      trackDocListener(doc, "contextmenu", nativeMenuGuardHandler as EventListener, true);
      applyTouchCalloutNone(doc);
    }
    // [REword patch 2026-08-29] PDF ⌘/Ctrl+滚轮缩放：
    // wheel 事件不跨 iframe 边界，必须挂到内容文档里才能收到页面上的滚轮。
    // 仅 PDF 挂载——EPUB 滚动模式下挂 passive:false 的 wheel 监听会让
    // 浏览器放弃滚轮滚动的合成器优化（滚动要等主线程），是实打实的卡顿源。
    // 必须 capture:true —— foliate 在同一个 doc 上挂了【冒泡阶段】的 wheel
    // （vendor/foliate-js/fixed-layout.js:1082，横向滚动模式转纵向滚轮用）。
    // 捕获阶段先于冒泡阶段执行，我们才能在 foliate 之前拿到事件，
    // 命中后用 stopImmediatePropagation 连它一起挡掉，避免两边各处理一次。
    if (isPdfBook()) {
      trackDocListener(doc, "wheel", onContentWheel as EventListener, { capture: true, passive: false });
    }
    // 2026-10-24：滚轮翻页（仅分页模式）。wheel 事件不跨 iframe 边界，
    // 页面本体必须在内容文档上单独挂一份；连续滚动模式不挂（保住合成器滚动优化）。
    if (wheelTurnEnabled()) bindWheelTurnOnDoc(doc);
    // 翻页/分区点击等交互监听（仅注入一次，guard 由 attachedDocs 保证，避免重复绑定导致翻两页）
    injectPageTurn(doc);
    // 2026-08-27 晚（P2.2）：新文档就绪时按当前专注模式状态应用高亮 class
    if (settings.focusMode) applyFocusMode();
    // 2026-08-28 分类字体：新文档就绪时重写 EPUB 内联字体族关键词。
    // 挂在 attachContentDoc 而非 relocate——foliate 翻页会重建内容文档，
    // 只有这里能保证每个新 section 都被处理到（CSS 变量运行时解析，不依赖先后顺序）。
    // 2026-10-07：custom 档同样要跑（原判断只有 classified）。
    if (settings.fontMode === "custom" || settings.fontMode === "classified") {
      try {
        rewriteFontKeywordsInDocument(doc);
      } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · try { rewriteFontKeywordsInDocument(doc); }", "debug"); }
    }
  }

  /** 卸载所有内容文档上的监听（与 attachContentDoc 对称），反复进出阅读 Tab 不泄漏 */
  function detachAllContentDocs() {
    // 2026-10-24：滚轮翻页监听不走 docCleanups（挂/卸时机与模式相关），单独回收。
    unbindWheelTurnDocs();
    for (const doc of attachedDocs) {
      const arr = docCleanups.get(doc);
      if (arr) {
        for (const h of arr) {
          try { doc.removeEventListener(h.type, h.fn, h.opts); } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · detachAllContentDocs", "debug"); }
        }
      }
      docCleanups.delete(doc);
    }
    attachedDocs.clear();
  }

  function attachAllContentDocs() {
    if (!view || !view.renderer || typeof view.renderer.getContents !== "function") return;
    let contents: any[] = [];
    try { contents = view.renderer.getContents() || []; } catch { return; }
    contents.forEach((c: any) => {
      try { attachContentDoc(c.doc); } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · attachAllContentDocs", "debug"); }
    });
  }

  /**
   * 取 foliate 的可见容器元素（分页模式下它是 overflow:hidden 的裁剪窗口）。
   *
   * 层级：view-light.js 里 `reword-foliate-view` 持有自己的 shadow root，
   * 渲染器 `reword-foliate-paginator` 挂在其 shadow root 里，**再**有自己的 shadow root，
   * `#container` 在最里层（paginator.js:1527 `this.#root.getElementById('container')`）。
   */
  function getFoliateContainerEl(): HTMLElement | null {
    const renderer: any = (view as any)?.renderer;
    if (!renderer) return null;
    try {
      const root = renderer.shadowRoot ?? renderer;
      return (root?.querySelector?.("#container") as HTMLElement | null) ?? null;
    } catch (__swallowErr) {
      logSwallow(__swallowErr, "ReaderView.svelte · getFoliateContainerEl", "debug");
      return null;
    }
  }

  /**
   * 当前可见窗口（**iframe 局部坐标**）。
   *
   * ## 为什么需要它
   * 分页模式下 iframe 元素被撑成**整个 section 的宽度**（多列横向排布），
   * 真正可见的只有被 `#container`（overflow:hidden）裁出来的那一「页」。
   * ⇒ 选区矩形、指针位置都必须换算到「可见窗口」这个坐标系里比较，
   *   否则会出现「工具栏飘到右页、选区却在左页」这类错位。
   *
   * @param frame 内容 iframe 元素；缺省时用可见容器本身（无 iframe 语境时的兜底）
   * @returns 局部坐标下的可见窗口；取不到时返回 null（调用方须回退到旧行为）
   */
  function getVisibleWindowLocal(frame?: HTMLElement | null): Rect4 | null {
    const containerEl = getFoliateContainerEl();
    let fr: DOMRect | null = null;
    try { fr = frame?.getBoundingClientRect?.() ?? null; } catch { fr = null; }
    // 基准矩形：优先 foliate 的可见容器（分页模式的裁剪窗口），退到 .reader-stage
    let base: DOMRect | null = null;
    try {
      base = containerEl?.getBoundingClientRect?.() ?? null;
    } catch (__swallowErr) {
      logSwallow(__swallowErr, "ReaderView.svelte · getVisibleWindowLocal container", "debug");
      base = null;
    }
    if (!base) {
      try { base = readerStageEl?.getBoundingClientRect?.() ?? null; } catch { base = null; }
    }
    if (!base) return null;
    // 与内容 iframe 求交：iframe 在分页模式下被撑成整个 section 的宽度，
    // 不裁的话「可见窗口」会等于整节，判定全部失真。
    const left = fr ? Math.max(base.left, fr.left) : base.left;
    const right = fr ? Math.min(base.right, fr.right) : base.right;
    const top = fr ? Math.max(base.top, fr.top) : base.top;
    const bottom = fr ? Math.min(base.bottom, fr.bottom) : base.bottom;
    if (right <= left || bottom <= top) return null;
    // 视口坐标 → iframe 局部坐标
    const ox = fr ? fr.left : 0;
    const oy = fr ? fr.top : 0;
    return { left: left - ox, top: top - oy, right: right - ox, bottom: bottom - oy };
  }

  /**
   * 找某个内容文档对应的 foliate 分节索引（跨页续接翻到下一节时要用）。
   * 找不到返回 -1。
   */
  function findContentIndex(doc: Document | null | undefined): number {
    if (!doc || !view?.renderer || typeof view.renderer.getContents !== "function") return -1;
    let contents: any[] = [];
    try { contents = view.renderer.getContents() || []; } catch { return -1; }
    for (const c of contents) {
      if (c?.doc === doc) return typeof c.index === "number" ? c.index : -1;
    }
    return -1;
  }

  /**
   * 找指针当前落在哪个内容文档上（跨 section 续接的交接判定）。
   *
   * ## 为什么不能用 elementFromPoint
   * 内容 iframe 埋在**两层 shadow DOM** 里（view-light 的 #root → paginator 的 #root），
   * 主文档的 elementFromPoint 只会命中最外层的宿主元素，拿不到内层 iframe。
   *
   * ## 为什么要额外判「可见窗口」
   * 分页模式下 iframe 元素被撑成**整个 section 的宽度**，它的 rect 覆盖了很宽的范围，
   * 但真正可见的只有被 #container 裁出来的那一页。
   * 直接用 rect 判会误判成"指针在 section 2 上"，实际它可能在 section 1 的第 3 页。
   */
  function findDocUnderPointer(clientX: number, clientY: number): { doc: Document; index: number; frame: HTMLElement } | null {
    if (!view?.renderer || typeof view.renderer.getContents !== "function") return null;
    let contents: any[] = [];
    try { contents = view.renderer.getContents() || []; } catch { return null; }
    for (const c of contents) {
      const d: Document | undefined = c?.doc;
      if (!d) continue;
      const f = (d.defaultView as any)?.frameElement as HTMLElement | null;
      if (!f) continue;
      let r: DOMRect | null = null;
      try { r = f.getBoundingClientRect(); } catch { r = null; }
      if (!r || r.width <= 0 || r.height <= 0) continue;
      if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) continue;
      const vis = getVisibleWindowLocal(f);
      if (vis) {
        const lx = clientX - r.left, ly = clientY - r.top;
        if (lx < vis.left || lx > vis.right || ly < vis.top || ly > vis.bottom) continue;
      }
      return { doc: d, index: typeof c.index === "number" ? c.index : -1, frame: f };
    }
    return null;
  }

  // 从 foliate 内容文档中读取当前选区；返回 null 表示无有效选区
  function readReaderSelection(): ReaderSel | null {
    if (!view || !view.renderer || typeof view.renderer.getContents !== "function") return null;
    let contents: any[] = [];
    try { contents = view.renderer.getContents() || []; } catch { return null; }
    for (const c of contents) {
      const doc = c.doc;
      const win = doc?.defaultView;
      if (!win || typeof win.getSelection !== "function") continue;
      const sel = win.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) continue;
      const range = sel.getRangeAt(0);
      const text = (sel.toString() || "").trim();
      if (!text) continue;
      const r = range.getBoundingClientRect();
      // 2026-10-14 P0：锚定回选区「整体包围盒」——上沿=首行顶部，避让框=整段选区。
      // 此前（2026-08-25）锚到末端 last client rect 是为了"跟手"，但多行选区时工具栏会
      // 跑到选区底部、且只避让最后一行（压住上面几行）。改回包围盒后：工具栏稳定停在选区
      // 首行上方（对齐微信读书），避让覆盖整段、绝不压字。单行选区包围盒≈该行，行为不变。
      const rects = range.getClientRects();
      // 内容可能在 iframe 内：把 iframe 在视口中的位置换算进主文档坐标
      let left = r.left, top = r.top, right = r.right, bottom = r.bottom;
      const frame = (win as any).frameElement as HTMLElement | null;
      let fr: DOMRect | null = null;
      if (frame) {
        fr = frame.getBoundingClientRect();
        left += fr.left; top += fr.top; right += fr.left; bottom += fr.top;
      }
      // ===== 2026-10-24 D1：可见性判定 + 锚点改用「可见部分」 =====
      //
      // 根因（用户截图「工具栏翻页之后定位不准」）：翻页后选区已经不在可视区里，
      // 但划词工具栏的坐标是**创建时一次性写死**的（absolute 定位于 .reader-floating-layer），
      // 于是它「留在原地」——看上去像飘到了右页，实际是**过期锚点**，不是坐标公式算错。
      //
      // 修法两条：
      //  ① 选区完全不可见 ⇒ 本 doc 不算有效选区（continue 下一个 doc；
      //     都没有则返回 null）⇒ 工具栏按「无有效选区」收起，不再留残影；
      //  ② 选区跨页（横跨两列）⇒ 锚点改用**可见部分**的并集。
      //     否则包围盒横跨两页中间的空白，工具栏会落在空白里（跨页续接的新场景）。
      //
      // ⚠️ PDF 不走这条路径：PDF 走 fixed-layout + 自建覆盖层，坐标系另成一套，
      //    贸然按 foliate 容器裁剪会把 PDF 的划词工具栏一起弄坏。
      let anchorLeft = left, anchorTop = top, anchorRight = right, anchorBottom = bottom;
      if (!isPdfBook()) {
        const visLocal = getVisibleWindowLocal(frame);
        if (visLocal) {
          const vis = visibleRect(rects as unknown as ArrayLike<Rect4>, visLocal);
          if (!vis) continue; // 选区已滚出可视区
          anchorLeft = vis.left + (fr?.left ?? 0);
          anchorRight = vis.right + (fr?.left ?? 0);
          anchorTop = vis.top + (fr?.top ?? 0);
          anchorBottom = vis.bottom + (fr?.top ?? 0);
        }
      }
      // 2026-09-04 P1：PDF 文本标注归一化矩形（相对当前页 textLayer，0-1），供自建覆盖层重绘
      // 2026-09-08 修复基准：此前用 frame（iframe 框）做基准，但选区 rect 与重绘端参照系
      // 不一致导致高亮整体错位、滚动/缩放后"跑丢"。改为与重绘端（PdfTextHlLayer）统一
      // 以 iframe 内 .textLayer 的 rect 为原点——两端参照同一元素，几何天然对齐。
      let pdfRects: PdfRect[] | null = null;
      if (isPdfBook() && frame && fr) {
        let tl: DOMRect | null = null;
        try { tl = (doc.querySelector(".textLayer") as HTMLElement | null)?.getBoundingClientRect() ?? null; } catch { tl = null; }
        const bw = (tl && tl.width > 0 ? tl.width : fr.width) || 1;
        const bh = (tl && tl.height > 0 ? tl.height : fr.height) || 1;
        const ox = tl ? tl.left : 0;
        const oy = tl ? tl.top : 0;
        const norm: PdfRect[] = [];
        for (const rc of rects) {
          const x = (rc.left - ox) / bw, y = (rc.top - oy) / bh, w = rc.width / bw, h = rc.height / bh;
          if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
            norm.push({ x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)), w: Math.min(1, Math.max(0, w)), h: Math.min(1, Math.max(0, h)), page: (c.index ?? 0) + 1 });
          }
        }
        // 2026-09-09 双绘根治②：getClientRects 实测会对同一行返回两套嵌套矩形
        // （ parade 实录 34 矩形/13 行），保存前去嵌套，数据层不再存冗余矩形。
        pdfRects = norm.length ? dedupeNestedRects(norm) : null;
      }
      let cfi: string | null = null;
      try {
        if (typeof c.index === "number" && typeof view.getCFI === "function") {
          cfi = view.getCFI(c.index, range);
        }
      } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · try { if (typeof c.index === \"number\" && typeof view.getCFI ===…", "debug"); }
      return { text, rect: { left: anchorLeft, top: anchorTop, right: anchorRight, bottom: anchorBottom }, index: c.index, cfi, range, pdfRects };
    }
    return null;
  }

  /** 将划词工具栏定位到指定视口矩形上方/下方（微信读书风格）。
   *  - 坐标契约：rect 为视口坐标（create 路径来自 readReaderSelection，edit 路径来自
   *    onShowAnnotation 已加 iframe 帧偏移），统一经 toContainerCoords 转换为 .reader-view
   *    相对坐标（工具栏绝对定位于 .reader-floating-layer，原点即 reader-view 左上角）。
   *  - 朝向判断用「实测工具栏高度」toolbarH（首帧兜底 44，渲染后实测缓存），替代写死的 44px，
   *    解决顶部选区因高度估计偏差而被裁切的问题（Task #5）。
   *  - transform: translate(-50%,-100%)（上方）/ translate(-50%,0)（下方）由 CSS 按 placeAbove 处理，
   *    故锚点 y 直接取选区上沿-gap（上方）或下沿+gap（下方），无需手算整体高度。
   *  - 2026-08-25 优化：动态获取导航栏/底栏实际高度，确保工具栏不与两者重叠；
   *    上方空间不足时自动翻到下方，反之亦然。 */
  /**
   * 2026-08-29 四向避让核心：给定选区矩形与工具栏尺寸，返回最佳放置方向与锚点（视口坐标）。
   * 避让目标 = 选中文本自身（绝不压住选区），并受导航栏/底栏/视口约束。
   *   优先级：优先上下（视线不跳变，按选区在可读区中部上下偏好），
   *           上下均无空间 → 退到右/左（垂直居中于选区，仅当整条工具栏能容纳于视口内）。
   *   四方向皆无空间（极端小窗口）→ 选溢出最小者，交由 refineToolbarPlacement 兜底夹紧。
   * 返回的 anchor 即 selToolbar.(x,y) 对应的视口锚点：
   *   above → 选区上沿 - gap（工具栏底部贴此，CSS translate(-50%,-100%)）
   *   below → 选区下沿 + gap（工具栏顶部贴此，CSS translate(-50%,0)）
   *   left  → 选区左沿 - gap、垂直居中（CSS translate(-100%,-50%)）
   *   right → 选区右沿 + gap、垂直居中（CSS translate(0,-50%)）
   */
  /**
   * 2026-10-12 P1-§6.4 窄屏兜底：可读区放不下主栏的留白预留（300 + 两侧 8）时返回 true。
   * 只由 CSS 消费（.reader-sel-toolbar.narrow 压掉 min-width 与 padding 的余量），
   * 不改按钮顺序、不改避让算法本体。
   */
  function selToolbarNarrow(bounds: { left: number; right: number }): boolean {
    return bounds.right - bounds.left < TOOLBAR_NARROW_BELOW;
  }

  function toolbarPlacement(
    rect: SelRect, h: number, w: number,
    navBottom: number, bottomTop: number, contentLeft: number, contentRight: number, gap: number,
    preferPlace?: ToolbarPlace
  ): { place: ToolbarPlace; anchorX: number; anchorY: number } {
    const midX = (rect.left + rect.right) / 2;
    const selCenterY = (rect.top + rect.bottom) / 2;
    const PAD = 8;
    /* ---- 2026-08-30 大修：从「放得下就选它」改为「四个方向统一打分」 ----
     * 旧逻辑用 roomAbove/roomBelow/roomLeft/roomRight 的布尔判断，一旦选区很高
     * （整段 / 跨多行——最常见的划词场景）上下左右全都「放不下」，
     * 就退化到「溢出最小」分支，而那个分支会把工具栏直接丢在选区上面压住文字。
     * 现在对每个候选位算出真实占位矩形，用「压字面积 × 大权重 + 越界面积」打分取最小：
     * 只要存在任何一个不压字的位置就一定选它；全都压字时选压得最少的。
     */
    const OVERLAP_WEIGHT = 10000; // 压住选中文字是首要禁忌，权重远高于越界

    /** 工具栏矩形与选区矩形的重叠面积（0 = 完全不压字） */
    const overlapOf = (l: number, t: number, r: number, b: number): number => {
      const ow = Math.min(r, rect.right) - Math.max(l, rect.left);
      const oh = Math.min(b, rect.bottom) - Math.max(t, rect.top);
      return ow > 0 && oh > 0 ? ow * oh : 0;
    };
    /** 越界面积：超出内容区左右 / 导航栏下沿 / 底栏上沿 的部分（越大越差，refine 会再夹紧） */
    const outsideOf = (l: number, t: number, r: number, b: number): number => {
      const dx = Math.max(0, contentLeft + PAD - l) + Math.max(0, r - (contentRight - PAD));
      const dy = Math.max(0, navBottom - t) + Math.max(0, b - bottomTop);
      return dx * h + dy * w;
    };
    /** 由 (方向, 锚点) 推出占位矩形 —— 必须与 CSS 的 transform 语义严格一致：
     *  above → translate(-50%,-100%)；below → translate(-50%,0)
     *  left  → translate(-100%,-50%)；right → translate(0,-50%) */
    const boxOf = (place: ToolbarPlace, ax: number, ay: number) => {
      let l = 0, t = 0;
      if (place === "above") { l = ax - w / 2; t = ay - h; }
      else if (place === "below") { l = ax - w / 2; t = ay; }
      else if (place === "left") { l = ax - w; t = ay - h / 2; }
      else { l = ax; t = ay - h / 2; } // right
      return { l, t, r: l + w, b: t + h };
    };
    const scoreOf = (place: ToolbarPlace, ax: number, ay: number): number => {
      const bx = boxOf(place, ax, ay);
      return overlapOf(bx.l, bx.t, bx.r, bx.b) * OVERLAP_WEIGHT + outsideOf(bx.l, bx.t, bx.r, bx.b);
    };
    /** 上下方向：先把锚点水平夹进内容区，避免工具栏被裁到屏幕外或被 Dock 遮挡（夹完再算分，分数才真实） */
    const clampX = (ax: number): number => {
      const half = w / 2 + PAD;
      const minAx = contentLeft + half;
      const maxAx = Math.max(minAx, contentRight - half);
      return Math.min(Math.max(ax, minAx), maxAx);
    };
    /** 侧放方向：把锚点垂直夹在导航栏与底栏之间 */
    const clampY = (ay: number): number => {
      const lo = navBottom + h / 2 + PAD;
      const hi = bottomTop - h / 2 - PAD;
      // 工具栏比可读区还高（极端小窗口）→ 夹不动，退化为可读区垂直中点
      return lo >= hi ? (navBottom + bottomTop) / 2 : Math.min(Math.max(ay, lo), hi);
    };
    const readableCenter = (navBottom + bottomTop) / 2;
    const preferBelow = selCenterY < readableCenter; // 选区在上半部 → 优先下方
    const cands: { place: ToolbarPlace; ax: number; ay: number }[] = [];
    // 上下两个方向按「选区在可读区哪一半」排序：平局时（都不压字、都不越界）取靠前那个，
    // 保持用户视线附近的稳定性，避免工具栏在上下之间来回跳。
    const vertOrder: ToolbarPlace[] = preferBelow ? ["below", "above"] : ["above", "below"];
    for (const place of vertOrder) {
      // ① 自然位：紧贴选区上/下沿
      cands.push({ place, ax: clampX(midX), ay: place === "above" ? rect.top - gap : rect.bottom + gap });
      // ② 安全位：贴导航栏下沿 / 底栏上沿。上下都放不下时（选区很高）用这个兜底，
      //    宁可压到选区边缘，也别让工具栏被裁切、或浮在正文中部挡住正在读的那一行。
      cands.push({ place, ax: clampX(midX), ay: place === "above" ? navBottom + h : bottomTop - h });
    }
    // ③ 侧放：垂直居中于选区（已夹在导航/底栏之间），水平贴选区左/右沿并夹在内容区内。
    cands.push({ place: "left", ax: Math.max(rect.left - gap, contentLeft + PAD + w), ay: clampY(selCenterY) });
    cands.push({ place: "right", ax: Math.min(rect.right + gap, contentRight - PAD - w), ay: clampY(selCenterY) });

    // 2026-10-12 P1-§6.3「转场保持朝向」：调用方给出 preferPlace（当前朝向）时，
    // 只要它在新尺寸下**完全不压字且不越界**（score 0）就钉住它，别让整条工具栏换边瞬移；
    // 一旦它越界或压字，就照原打分逻辑重选 —— 压住用户选中的文字永远是首要禁忌。
    if (preferPlace) {
      let kept: { place: ToolbarPlace; ax: number; ay: number } | null = null;
      let keptScore = Infinity;
      for (const cd of cands) {
        if (cd.place !== preferPlace) continue;
        const s = scoreOf(cd.place, cd.ax, cd.ay);
        if (s < keptScore) { keptScore = s; kept = cd; }
      }
      if (kept && keptScore === 0) {
        return { place: kept.place, anchorX: kept.ax, anchorY: kept.ay };
      }
    }
    // 打分取最小：压字权重远高于越界 —— 宁可让工具栏稍微出界（refine 会夹紧），
    // 也绝不允许它盖住用户刚选中的文字。严格小于才替换 → 平局保持候选数组靠前者。
    let best = cands[0];
    let bestScore = Infinity;
    for (const cd of cands) {
      const s = scoreOf(cd.place, cd.ax, cd.ay);
      if (s < bestScore) { bestScore = s; best = cd; }
    }
    return { place: best.place, anchorX: best.ax, anchorY: best.ay };
  }

  function positionToolbarAbove(rect: SelRect, text: string, mode: "create" | "edit", editingId: string | null) {
    // 2026-10-08 「启用划词工具栏」总开关。
    //
    // ## 为什么加这个 gate
    // 此前划词工具栏是**强制开启、无法关闭**的。两个实际问题：
    //  ① 点书内链接时若恰好有选区，工具栏会误弹，遮挡刚点开的链接内容；
    //  ② 批注/划线重度用户可能更想走摘录面板，而不是每次选中都弹。
    //
    // ## 为什么只 gate 这一个函数
    // 它是**所有**显示路径的唯一收口（create 态划词、edit 态点已有高亮、
    // 恢复时重定位全部经过这里），改一处即覆盖全部。
    // ⚠️ 但**不 gate edit 态**：点已有高亮仍需能改样式/颜色/删除，
    //   否则用户打开开关后连已有标注都改不了，那是更严重的退化。
    if (settings.selToolbarEnabled === false && mode !== "edit") {
      if (selToolbar.visible) closeSelToolbar();
      return;
    }
    cancelPendingClose(); // 选区触发 → 取消延迟关闭
    lastSelRect = rect; // 保存选区矩形，供批注编辑器定位使用
    const gap = 12;
    const bounds = getContentBounds();
    // 导航栏/底栏取其在视口中的真实下沿/上沿，与 rect（视口坐标）同基准比较。
    const navBottom = bounds.top;
    const bottomTop = bounds.bottom;
    // 预估有效高度：edit 态含样式行（主栏+样式行），否则仅主栏。
    const stripShown = mode === "edit";
    // 2026-08-30：优先用实测到的样式行真实高度，替代写死的 TOOLBAR_WITH_STRIP_H。
    // 写死值与实际渲染高度一旦不符，避让计算就会错位 —— 这正是工具栏压字的原因之一。
    // ⚠️ 2026-10-11 必须用 offsetHeight：样式行入场动画（selStripIn 的 scale 0.94→1）播放期间
    // getBoundingClientRect 返回的是**缩放后**的中间值（Demo 实测 265 vs offsetWidth 294），
    // 拿它做避让判定会偏小；offsetHeight 是布局尺寸，不受 transform 影响。
    const measuredStripH = selStripEl?.offsetHeight || 0;
    const stripExtraH = measuredStripH > 0 ? measuredStripH : (TOOLBAR_WITH_STRIP_H - TOOLBAR_BAR_ONLY_H);
    const effH = stripShown ? TOOLBAR_BAR_ONLY_H + stripExtraH : TOOLBAR_BAR_ONLY_H;
    // 工具栏宽度首帧无实测值 → 用上次实测/兜底估计，refine 会用真实宽度校正。
    // 同样走 offsetWidth：动画期间不被 scale 污染。
    const effW = selToolbarEl?.offsetWidth || 300; // 2026-10-23：兜底宽同步主栏 min-width 300（两态等宽，不再预留 slot2）
    // ★ 2026-08-29 四向避让：算最佳方向 + 锚点，绝不压住选中文本。
    const { place, anchorX, anchorY } = toolbarPlacement(rect, effH, effW, navBottom, bottomTop, bounds.left, bounds.right, gap);
    const c = toContainerCoords(anchorX, anchorY);
    // 新工具栏要开 → 收起动画作废（字面量本身也清掉 closing，这里连计时器一起摘）。
    cancelSelToolbarOut();
    selToolbar = { visible: true, x: c.x, y: c.y, text, mode, editingId, place, narrow: selToolbarNarrow(bounds) };
    if (DEBUG_READER) {
      console.log("[REword][pos] positionToolbarAbove", {
        mode, editingId,
        rect: { top: Math.round(rect.top), bottom: Math.round(rect.bottom), left: Math.round(rect.left), right: Math.round(rect.right) },
        gap, effH, effW, place,
        anchor: { x: Math.round(anchorX), y: Math.round(anchorY) },
        navBottom: Math.round(navBottom), bottomTop: Math.round(bottomTop),
        toContainer: { x: Math.round(c.x), y: Math.round(c.y) },
        final: { x: Math.round(selToolbar.x), y: Math.round(selToolbar.y), place: selToolbar.place },
      });
    }
    void fixToolbarPlacement(rect, gap);
    // 2026-10-14 P1：手柄跟随选区（与工具栏朝向无关，只依赖选区两端矩形），故放在此处统一刷新。
    updateSelHandles();
  }

  /**
   * 2026-10-14 P1：刷新选区两端「定位标识」手柄位置。
   * 起点 = 首行矩形左上、终点 = 末行矩形右下（与 readReaderSelection 同口径：iframe 帧偏移
   * 换算进主文档视口，再经 toContainerCoords 减容器原点）。仅 EPUB create 态、有有效选区时显示。
   * PDF 暂不启用（textLayer 归一化坐标另成一套，caretRangeFromPoint 命中需单独适配，留后续）。
   */
  /** 由选区 range 算两端手柄点（起点=首行矩形左上、终点=末行矩形右下，含行高）。失败返回 null。
   *  纯几何、无副作用，供工具栏态(updateSelHandles)与拖拽实时态(updateSelHandlesLive)共用。 */
  function computeHandlePoints(range: Range): { start: { x: number; y: number; h: number }; end: { x: number; y: number; h: number } } | null {
    let rects: DOMRect[];
    try { rects = Array.from(range.getClientRects()); } catch { return null; }
    if (!rects.length) return null;
    let fx = 0, fy = 0;
    let frame: HTMLElement | null = null;
    try {
      const win = range.startContainer?.ownerDocument?.defaultView as (Window & { frameElement?: HTMLElement | null }) | null;
      frame = win?.frameElement ?? null;
      if (frame) { const fr = frame.getBoundingClientRect(); fx = fr.left; fy = fr.top; }
    } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · computeHandlePoints frameOffset", "debug"); }
    // ★ 2026-10-24 B1 返工（一）：只用**当前可见页上的片段**的首/末。
    //   跨页选区在 DOM 上是连续一段，rects[0] / rects[n-1] 可能落在已被推走的那一列，
    //   Y 跟着对不上文字 ⇒ 「手柄飘在页边、高度不在行上」。
    //   选区整段都不在可见页 ⇒ 不画手柄（夹 Y 会把窗口外的行拉回边框，制造假手柄）。
    const vis = getVisibleWindowLocal(frame);
    const visRects = vis ? visibleRects(rects, vis) : rects;
    if (!visRects.length) return null;
    const first = visRects[0];
    const last = visRects[visRects.length - 1];
    // ★ 2026-10-24 B1 返工（二）：夹取基准从「裁剪窗口」改成「文字列」。
    //   foliate 在 #container 里自带页边距，窗口右缘比文字右缘再往外 70~90px。
    //   按窗口夹 ⇒ 手柄画在空白里；且页边带按窗口往里量 ⇒ 手柄贴着文字末端也进不了带。
    let sx = first.left, ex = last.right;
    if (vis) {
      const eStart = textColumnEdges(range, vis, false, visRects);
      const eEnd = textColumnEdges(range, vis, true, visRects);
      const lo = Math.min(eStart ? eStart.left : vis.left + EDGE_TURN_ZONE, eEnd ? eEnd.right : vis.right - EDGE_TURN_ZONE);
      const hi = Math.max(eStart ? eStart.left : vis.left + EDGE_TURN_ZONE, eEnd ? eEnd.right : vis.right - EDGE_TURN_ZONE);
      if (sx < lo) sx = lo;
      if (sx > hi) sx = hi;
      if (ex < lo) ex = lo;
      if (ex > hi) ex = hi;
      if (ex < sx) ex = sx;
    }
    const s = toContainerCoords(sx + fx, first.top + fy);
    const en = toContainerCoords(ex + fx, last.bottom + fy);
    return { start: { x: s.x, y: s.y, h: Math.max(14, first.height) }, end: { x: en.x, y: en.y, h: Math.max(14, last.height) } };
  }

  /** 是否块级盒：内联类（inline/inline-block/inline-flex/inline-table）的片段宽度就是文字本身，
   *  会被末行长短带偏，不能拿来当「文字列边界」。 */
  function isBlockLevelBox(display: string): boolean {
    if (!display || display === "none" || display === "contents" || display === "run-in") return false;
    if (display.startsWith("inline")) return false;
    return true;
  }

  /** 取元素在 rowY 这一行上的**分栏片段**（Element.getClientRects() 对跨列块盒逐列返回，
   *  getBoundingClientRect 只给并集）。同行多片段时取离 hintX 更近的那个，避免拿到隔壁列。 */
  function blockFragmentOnRow(el: HTMLElement, rowY: number, hintX: number, side: "left" | "right"): Rect4 | null {
    let rs: DOMRect[];
    try { rs = Array.from(el.getClientRects()); } catch { return null; }
    let best: Rect4 | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (const r of rs) {
      if (r.right <= r.left || r.bottom <= r.top) continue;
      if (r.top >= rowY || r.bottom <= rowY) continue;
      const d = Math.abs(r[side] - hintX);
      if (d < bestD) { bestD = d; best = { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; }
    }
    return best;
  }

  /**
   * 当前可见页上「文字真正排到哪儿为止」（iframe 局部坐标）。
   *
   * 从选区端点所在节点往上走祖先链，只看块级元素，取它在端点所在可见行上那一段分栏
   * 片段的左右边；对所有块取**最紧**的一组（左边取最大、右边取最小）。缩进的
   * blockquote/figure 也算数 —— 它的盒边就是用户眼中的「文字边缘」。
   *
   * 为什么不用公式算列边界：foliate 的 --_gap 是百分比，要乘 divisor，再和页边距耦合
   * （paginator.js 里那段 f(x)=x/(1+x) 的收敛推导）。算错一次就是现在这种「差 90px」；
   * 量 DOM 得到的是排版结果本身。
   *
   * @param atEnd 探末端所在行（true）还是起点所在行（false）
   * @param rowsIn 已算好的可见片段（拖拽时每帧都调，别让 getClientRects 重复跑）
   * @returns null 表示探不到，调用方回退到「窗口边往里让 EDGE_TURN_ZONE」
   */
  function textColumnEdges(range: Range, vis: Rect4, atEnd: boolean, rowsIn?: DOMRect[]): { left: number; right: number } | null {
    let rows: DOMRect[];
    if (rowsIn && rowsIn.length) rows = rowsIn;
    else { try { rows = visibleRects(Array.from(range.getClientRects()), vis); } catch { return null; } }
    if (!rows.length) return null;
    const row = atEnd ? rows[rows.length - 1] : rows[0];
    const rowY = row.top + row.height / 2;
    const side: "left" | "right" = atEnd ? "right" : "left";
    let node: Node | null = atEnd ? range.endContainer : range.startContainer;
    let left = Number.NEGATIVE_INFINITY;
    let right = Number.POSITIVE_INFINITY;
    let found = false;
    let guard = 0;
    while (node && guard++ < 40) {
      if (node.nodeType === 1) {
        const el = node as HTMLElement;
        try {
          const disp = el.ownerDocument?.defaultView?.getComputedStyle?.(el)?.display ?? "";
          if (isBlockLevelBox(disp)) {
            const frag = blockFragmentOnRow(el, rowY, row[side], side);
            if (frag) {
              found = true;
              if (frag.left > left) left = frag.left;
              if (frag.right < right) right = frag.right;
            }
          }
        } catch (__swallowErr) {
          logSwallow(__swallowErr, "ReaderView.svelte · textColumnEdges walk", "debug");
        }
        if (el === el.ownerDocument?.body || el === el.ownerDocument?.documentElement) break;
      }
      node = node.parentNode;
    }
    if (!found) return null;
    // 片段可能只与窗口挨了 1px 而超出窗口；夹回窗口内，保证页边带不退化成空
    const safeRight = Math.min(right, vis.right - 6);
    const safeLeft = Math.max(left, vis.left + 6);
    if (!(safeRight > safeLeft)) return null;
    return { left: safeLeft, right: safeRight };
  }

  /** 工具栏驱动的手柄刷新（create 态收口）：依赖 selInfo.range + 工具栏可见。拖拽实时刷新走 updateSelHandlesLive。 */
  function updateSelHandles(): void {
    const range = selInfo?.range ?? null;
    if (!range || isPdfBook() || !selToolbar.visible || selToolbar.mode !== "create") {
      if (selHandles.visible) selHandles = { ...selHandles, visible: false };
      return;
    }
    const pts = computeHandlePoints(range);
    if (!pts) { if (selHandles.visible) selHandles = { ...selHandles, visible: false }; return; }
    selHandles = { visible: true, start: pts.start, end: pts.end };
  }

  /** 2026-10-14 P1：拖拽选区实时刷新手柄（微信读书式「选中即出现、随长度扩展」）。
   *  仅读当前选区几何、不重算 cfi、不弹工具栏（工具栏仍由 mouseup 收口），故可高频调用。 */
  function updateSelHandlesLive(): void {
    if (isPdfBook() || selHandleDragging) return;
    if (settings.selToolbarEnabled === false) return;
    const range = getLiveSelRange();
    if (!range) { if (selHandles.visible) selHandles = { ...selHandles, visible: false }; return; }
    const pts = computeHandlePoints(range);
    if (!pts) { if (selHandles.visible) selHandles = { ...selHandles, visible: false }; return; }
    selHandles = { visible: true, start: pts.start, end: pts.end };
  }

  /** 轻量读取当前 iframe 选区的 Range（无 cfi/无 pdfRects），供实时手柄用。无有效选区返回 null。 */
  function getLiveSelRange(): Range | null {
    if (!view || !view.renderer || typeof view.renderer.getContents !== "function") return null;
    let contents: any[] = [];
    try { contents = view.renderer.getContents() || []; } catch { return null; }
    for (const c of contents) {
      const win = c.doc?.defaultView;
      if (!win || typeof win.getSelection !== "function") continue;
      const s = win.getSelection();
      if (!s || s.isCollapsed || s.rangeCount === 0) continue;
      if (!(s.toString() || "").trim()) continue;
      return s.getRangeAt(0);
    }
    return null;
  }

  /**
   * 2026-10-14 P1：拖拽选区端点手柄实时改选区（微信读书式「定位标识」）。
   * - 固定端 = 未被拖的那端：拖 start → 固定 extent=当前 end；拖 end → 固定 base=当前 start。
   *   快照 (node, offset) 在整段拖拽期间不变（只改选区不改 DOM，文本节点持续有效）。
   * - 命中：主文档 client 坐标 → 减 iframe 帧偏移得局部坐标 → caretRangeFromPoint
   *   （Firefox 走 caretPositionFromPoint）取落点 → setBaseAndExtent 更新选区。
   * - 落点在正文外 → caret 为 null，保持上一次选区不动（不抖动、不误收）。
   * - 每次更新后重读 range、重算 cfi、重锚工具栏（positionToolbarAbove 内会再刷 updateSelHandles）。
   * - rAF 合并同帧多次 move；拖拽期间 selHandleDragging 抑制 scheduleReadSelection 干扰。
   *
   * 2026-10-24 A：跨页续接 —— 指针越过可见页边时**自动翻页**并把选区接到下一页。
   *   - 同 section 跨页：iframe 内是连续 DOM ⇒ 一个 Range 跨过列断 ⇒ 一个 CFI 覆盖整段。
   *   - 跨 section：不同 Document，Range 跨不过 ⇒ 分段记录（selInfo.segments），
   *     每段一个 CFI，落库后逐段绘制。
   *   - 边缘方向按**书写方向**换算：RTL 书里"右边缘"其实是上一页。
   */
  function onSelHandlePointerDown(e: PointerEvent, which: "start" | "end"): void {
    const range0 = selInfo?.range ?? null;
    if (!range0) return;
    e.preventDefault();
    e.stopPropagation();
    const doc0 = range0.startContainer?.ownerDocument ?? null;
    const win0 = doc0?.defaultView as (Window & { frameElement?: HTMLElement | null }) | null;
    const frame0 = win0?.frameElement ?? null;
    const sel0 = win0?.getSelection?.() ?? null;
    if (!doc0 || !sel0) return;
    const fixedNode = which === "start" ? range0.endContainer : range0.startContainer;
    const fixedOffset = which === "start" ? range0.endOffset : range0.startOffset;
    // ===== 拖拽期间的可变状态（跨 section 续接时会切换 doc / sel / index）=====
    let curDoc: Document = doc0;
    let curSel: Selection = sel0;
    let curFrame: HTMLElement | null = frame0;
    let curIndex: number = selInfo?.index ?? 0;
    let curCfi: string | null = selInfo?.cfi ?? null;
    /** 已完成的分段（跨 section 时累积；同 section 跨页时为空） */
    const segs: { index: number; cfi: string }[] = [];
    /** 跨 section 时累积的选中文本（各段文本之和） */
    let accText = "";
    selHandleDragging = which;
    const el = e.currentTarget as HTMLElement | null;
    try { el?.setPointerCapture?.(e.pointerId); } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · handle setPointerCapture", "debug"); }
    let lastX = e.clientX, lastY = e.clientY;
    const startClientX = e.clientX;
    let raf = 0;
    /** 本次拖拽是否翻过页（决定松手后是否保留工具栏） */
    let turned = false;
    // ===== 页边带触发状态（2026-10-24 定稿：方向性位移 + 带内驻留 + engagement 锁存）=====
    /** 拖拽过程中朝目标方向到达过的**极值**（不是净位移：抖出去再抖回来仍算） */
    let maxRight = e.clientX, minLeft = e.clientX;
    /** 进入页边带的时刻（0 = 不在带内）；进带即起计时，离开带就取消 */
    let bandEnterMs = 0;
    let bandTimer = 0;
    /** engagement 锁存：一次按住只翻一页，必须**拉出带子再拖回来**才允许翻下一页 */
    let latched = false;
    /** 离开页边带的起始时刻（0 = 还没离开过）；满 EDGE_TURN_REARM_MS 才解锁 */
    let bandLeftMs = 0;

    /** 书写方向：RTL 书里"右边缘"其实是上一页 */
    const isRtlBook = (): boolean => {
      const rtl = (view as any)?.renderer?.rtl;
      if (typeof rtl === "boolean") return rtl;
      return (view as any)?.book?.dir === "rtl";
    };

    /** 页边翻页：开续接窗口 + 记下回放钩子（翻页落地后把选区自动接进新页） */
    const turnAtEdge = (logical: "prev" | "next") => {
      const now = performance.now();
      turned = true;
      latched = true;
      if (bandTimer) { clearTimeout(bandTimer); bandTimer = 0; }
      bandEnterMs = 0;
      bandLeftMs = 0; // 翻页后「离开过带子」重新计：指针往往还停在带里
      hideEdgeHint();
      // 续接窗口：翻页是异步的（foliate 内部有动画 + 100ms 等待），relocate 会**晚于**翻页请求到达
      // ⇒ 这段时间内 relocate 走「重锚」分支而不是「收起」分支
      selContinuationUntil = now + 1500;
      // 翻页后把**同一个指针点**再算一次落点：iframe 元素整体平移了一个列宽，
      // 这个点相对新页仍停在页边 ⇒ caret 落在新页该行行尾 ⇒ 选区自动延伸进新页，
      // 用户不用继续动鼠标（对齐 Readest 的 onAutoTurn(() => updateFromDraggedPoint(point))）。
      selDragReplay = () => { if (!raf) raf = requestAnimationFrame(apply); };
      turnPage(view, logical);
    };

    /** 带内驻留提示：翻页前那 350ms 里给用户「再停一下就翻页」的确定感（Readest turnHint 同款） */
    const showEdgeHint = (dir: "prev" | "next") => {
      const c = toContainerCoords(lastX, lastY);
      selEdgeHint = { visible: true, x: c.x, y: c.y, dir };
    };
    const hideEdgeHint = () => {
      if (selEdgeHint.visible) selEdgeHint = { ...selEdgeHint, visible: false };
    };

    /** 在目标文档上取落点（iframe 局部坐标）；取不到返回 null */
    const caretAt = (d: Document, x: number, y: number): Range | null => {
      try {
        const anyDoc = d as Document & {
          caretRangeFromPoint?: (x: number, y: number) => Range | null;
          caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
        };
        if (typeof anyDoc.caretRangeFromPoint === "function") return anyDoc.caretRangeFromPoint(x, y);
        if (typeof anyDoc.caretPositionFromPoint === "function") {
          const cp = anyDoc.caretPositionFromPoint(x, y);
          if (cp) { const r = d.createRange(); r.setStart(cp.offsetNode, cp.offset); r.collapse(true); return r; }
        }
      } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · handle caretFromPoint", "debug"); }
      return null;
    };

    /** 当前选区 Range：页边带探测要按「正在拖的这一端」所在行找文字列边界 */
    const selRange = (): Range | null => {
      const r = selInfo?.range ?? null;
      if (r) return r;
      try { return curSel?.rangeCount ? curSel.getRangeAt(0) : null; } catch { return null; }
    };

    const apply = () => {
      raf = 0;
      // ① 指针当前落在哪个内容文档上（跨 section 续接的交接判定）
      const target = findDocUnderPointer(lastX, lastY);
      const tDoc = target?.doc ?? curDoc;
      const tFrame = target?.frame ?? curFrame;
      const tFr = tFrame?.getBoundingClientRect?.() ?? null;
      const tlx = lastX - (tFr?.left ?? 0);
      const tly = lastY - (tFr?.top ?? 0);
      const vis = getVisibleWindowLocal(tFrame);
      // ② 页边带判定 → 逻辑方向翻页（2026-10-24 定稿四条，缺一不翻）：
      //    ① 朝目标方向的**累计**位移 ≥ EDGE_TURN_MIN_MOVE
      //    ② 指针进入「文字列边缘 ~ 窗口边缘」这段页边带（不是从窗口往里量的带）
      //    ③ 在带内**驻留** ≥ EDGE_TURN_DWELL_MS（掠过不翻）
      //    ④ 本次 engagement 还没翻过（锁存；拉出带子再拖回来才解锁 ⇒ 防连翻）
      //    滚动模式（flow=scrolled）没有页边概念 ⇒ 整段跳过。
      if (vis && tFr && !isScrollFlow() && !cornerMachine.isActive()) {
        // 2026-10-25 共存规则：角落机活跃时边带让位（角优先）；离角后仍贴边则回落带流程
        const side: "left" | "right" = which === "end" ? "right" : "left";
        const logical: "prev" | "next" = side === "right"
          ? (isRtlBook() ? "prev" : "next")
          : (isRtlBook() ? "next" : "prev");
        if (lastX > maxRight) maxRight = lastX;
        if (lastX < minLeft) minLeft = lastX;
        const excursion = side === "right" ? maxRight - startClientX : startClientX - minLeft;
        // 页边带内沿 = 当前拖动端所在行的文字列边界；探不到就退回「窗口边往里让 EDGE_TURN_ZONE」
        const probe = selRange();
        const edges = probe ? textColumnEdges(probe, vis, which === "end") : null;
        const textEdge = edges ? (side === "right" ? edges.right : edges.left)
          : (side === "right" ? vis.right - EDGE_TURN_ZONE : vis.left + EDGE_TURN_ZONE);
        const winEdge = side === "right" ? vis.right : vis.left;
        const lx = lastX - tFr.left;
        const inBand = excursion >= EDGE_TURN_MIN_MOVE
          && inPageMarginBand(lx, textEdge, winEdge, side, EDGE_TURN_TOL);
        const now = performance.now();
        if (inBand) {
          // 锁存期间**什么都不做**：停在带里不会连翻，必须先把指针拉出带子。
          if (!latched) {
            if (bandEnterMs === 0) {
              bandEnterMs = now;
              showEdgeHint(logical);
              // 驻留必须靠计时器：apply() 是 pointermove 的 rAF 回调，用户「停住不动」就没有下一帧
              bandTimer = window.setTimeout(() => { bandTimer = 0; turnAtEdge(logical); }, EDGE_TURN_DWELL_MS);
            } else if (now - bandEnterMs >= EDGE_TURN_DWELL_MS) {
              turnAtEdge(logical); // 计时器被 rAF 抢在前面的兜底路径
            }
          }
        } else {
          if (bandEnterMs !== 0) {
            if (bandTimer) { clearTimeout(bandTimer); bandTimer = 0; }
            bandEnterMs = 0;
            hideEdgeHint();
          }
          if (bandLeftMs === 0) bandLeftMs = now;
          // 解锁只发生在「确实离开过带子」之后：翻完页时指针往往还停在带里，
          // 若按「离开时刻的默认值」判定会立刻解锁 ⇒ 停在原地连翻好几页。
          else if (latched && now - bandLeftMs >= EDGE_TURN_REARM_MS) {
            latched = false;
            bandLeftMs = 0;
          }
        }
      }
      // ③ 取落点
      const caret = caretAt(tDoc, tlx, tly);
      if (!caret) return; // 指针在正文外：保持上一次选区不动（不抖动、不误收）
      const cn = caret.startContainer, co = caret.startOffset;
      let tSel = (tDoc.defaultView as any)?.getSelection?.() ?? null;
      if (!tSel) return;
      if (tDoc !== curDoc) {
        // ④ 跨 section 交接：结段上一段，在新文档另起一段
        if (curCfi) segs.push({ index: curIndex, cfi: curCfi });
        accText += (curSel?.toString?.() ?? "");
        curDoc = tDoc; curSel = tSel; curFrame = tFrame;
        curIndex = typeof target?.index === "number" && target.index >= 0 ? target.index : curIndex;
        curCfi = null;
        try {
          const body = tDoc.body;
          if (which === "end") tSel.setBaseAndExtent(body, 0, cn, co);
          else tSel.setBaseAndExtent(cn, co, body, body.childNodes.length);
        } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · handle setBaseAndExtent(cross)", "debug"); return; }
      } else {
        try {
          if (which === "start") tSel.setBaseAndExtent(cn, co, fixedNode, fixedOffset);
          else tSel.setBaseAndExtent(fixedNode, fixedOffset, cn, co);
        } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · handle setBaseAndExtent", "debug"); return; }
      }
      const nr = tSel.rangeCount ? tSel.getRangeAt(0) : null;
      if (!nr) return;
      const text = (tSel.toString() || "").trim();
      let cfi: string | null = curCfi;
      try { if (typeof view?.getCFI === "function") cfi = view.getCFI(curIndex, nr); } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · handle getCFI", "debug"); }
      curCfi = cfi;
      const fullText = (accText + text).trim();
      const allSegs = cfi ? [...segs, { index: curIndex, cfi }] : segs.slice();
      selInfo = {
        index: curIndex, cfi, range: nr, pdfRects: null,
        segments: allSegs.length > 1 ? allSegs : undefined,
      };
      if (!fullText) return; // 拖成空选区：保留工具栏上一次状态，只让 updateSelHandles 收起手柄
      // ⑤ 锚点：跨页时用「可见部分」（D1），否则会落在两页中间的空白里
      let rect: SelRect;
      const fr = tFrame?.getBoundingClientRect?.() ?? null;
      if (vis) {
        const vr = visibleRect(
          Array.from(nr.getClientRects()) as unknown as ArrayLike<Rect4>,
          vis,
        );
        if (vr) {
          rect = {
            left: vr.left + (fr?.left ?? 0), top: vr.top + (fr?.top ?? 0),
            right: vr.right + (fr?.left ?? 0), bottom: vr.bottom + (fr?.top ?? 0),
          };
        } else {
          const r = nr.getBoundingClientRect();
          rect = {
            left: r.left + (fr?.left ?? 0), top: r.top + (fr?.top ?? 0),
            right: r.right + (fr?.left ?? 0), bottom: r.bottom + (fr?.top ?? 0),
          };
        }
      } else {
        const r = nr.getBoundingClientRect();
        rect = {
          left: r.left + (fr?.left ?? 0), top: r.top + (fr?.top ?? 0),
          right: r.right + (fr?.left ?? 0), bottom: r.bottom + (fr?.top ?? 0),
        };
      }
      positionToolbarAbove(rect, fullText, "create", null);
    };
    const onMove = (ev: PointerEvent) => {
      lastX = ev.clientX; lastY = ev.clientY;
      // 2026-10-25 角落自动翻页：手柄拖拽喂点（父窗口路径）
      cornerMachine.note(lastX, lastY);
      if (!raf) raf = requestAnimationFrame(apply);
    };
    /** 内容文档里的 pointermove（iframe 自己会吃掉指针事件）：
     *  坐标是 iframe 视口口径，要加回帧偏移才是主文档 client 坐标。
     *  setPointerCapture 正常时父窗口已经收得到事件，这里是捕获失败的兜底。 */
    const onMoveContent = (ev: PointerEvent) => {
      const fr = curFrame?.getBoundingClientRect?.() ?? null;
      lastX = ev.clientX + (fr?.left ?? 0); lastY = ev.clientY + (fr?.top ?? 0);
      // 2026-10-25 角落自动翻页：手柄拖拽喂点（与 onMove 同一坐标口径）
      cornerMachine.note(lastX, lastY);
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const onUp = (ev: PointerEvent) => {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      apply();
      // 松手收尾：驻留计时/提示/回放钩子一律作废（不能在松手之后才翻出下一页、或延伸选区）
      if (bandTimer) { clearTimeout(bandTimer); bandTimer = 0; }
      bandEnterMs = 0;
      hideEdgeHint();
      // 2026-10-25 角落自动翻页：松手即取消角驻留（含 L 动画收回）+ 摘除角优先回调
      cornerMachine.cancel();
      handleEdgeTurn = null;
      selDragReplay = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      const cw = doc0.defaultView;
      cw?.removeEventListener?.("pointermove", onMoveContent as EventListener);
      cw?.removeEventListener?.("pointerup", onUp as EventListener);
      cw?.removeEventListener?.("pointercancel", onUp as EventListener);
      try { el?.releasePointerCapture?.(ev.pointerId); } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · handle releasePointerCapture", "debug"); }
      selHandleDragging = null;
      // 续接窗口：翻过页的拖拽松手后仍保留一小段，让随后的 relocate 走「重锚」；
      // 没翻页则清零 —— 之后的普通翻页应当照常收起工具栏。
      selContinuationUntil = turned ? Math.max(selContinuationUntil, performance.now() + 600) : 0;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    // 2026-10-25 角落自动翻页：角优先时直接复用本闭包的翻页链（锁存 + replay=apply + turnPage）
    handleEdgeTurn = turnAtEdge;
    // 兜底绑定：指针进入内容 iframe 后若事件被 iframe 吃掉，父窗口收不到 ⇒ 拖拽会「断流」，
    // 表现为手柄停在原地、页边驻留永远不触发。
    {
      const cw = doc0.defaultView;
      cw?.addEventListener?.("pointermove", onMoveContent as EventListener);
      cw?.addEventListener?.("pointerup", onUp as EventListener);
      cw?.addEventListener?.("pointercancel", onUp as EventListener);
    }
  }

  /**
   * 2026-08-26 重写（v3 锚点坐标系版）：渲染后实测校正工具栏位置。
   *
   * ★ 核心修复：CSS transform 已处理 Y 偏移（上方 -100% 让底部对齐锚点，
   *   下方 place-below 的 0% 让顶部对齐锚点），故所有校正路径
   *   必须计算「锚点 Y」而非「绝对位置 Y」，否则与 CSS transform 叠加导致双重偏移。
   *
   * 锚点定义：
   *   - 上方模式：锚点 = 工具栏底部应在的视口 Y（CSS -100% 后底部恰好在此）
   *   - 下方模式：锚点 = 工具栏顶部应在的视口 Y（CSS 0% 后顶部恰好在此）
   */
  async function fixToolbarPlacement(rect: SelRect, gap: number) {
    try {
      await tick();
      const el = selToolbarEl;
      if (!el) return;
      const box = el.getBoundingClientRect(); // 视口坐标，与 rect 同基准
      // ⚠️ 2026-10-11：尺寸取 offsetHeight/offsetWidth（布局尺寸），不用 box.height/width。
      // 入场动画正在播时 box 是**缩放后**的尺寸（Demo 实测 scale .9 下 265 vs 布局 294），
      // 拿它做避让/翻面判定会系统性偏小；水平中心不随缩放漂移，可继续从 box 取。
      const h = el.offsetHeight || box.height;
      const w = el.offsetWidth || box.width;
      const cx = (box.left + box.right) / 2;
      if (h > 0) toolbarH = h;
      if (DEBUG_READER) {
        console.log("[REword][fix] 实测", {
          place: selToolbar.place,
          box: { t: Math.round(box.top), b: Math.round(box.bottom), l: Math.round(box.left), r: Math.round(box.right), h: Math.round(box.height), w: Math.round(box.width) },
          layout: { h, w, cx: Math.round(cx) },
          rect: { t: Math.round(rect.top), b: Math.round(rect.bottom), l: Math.round(rect.left), r: Math.round(rect.right) },
        });
      }
      const bounds = getContentBounds();
      const navBottom = bounds.top;
      const bottomTop = bounds.bottom;
      const midX = (rect.left + rect.right) / 2;
      const selCenterY = (rect.top + rect.bottom) / 2;
      const MIN_GAP = 10;
      const PAD = 8;
      const place = selToolbar.place;
      // 依据当前方向重算锚点（视口坐标）
      let anchorX = midX, anchorY = selCenterY;
      if (place === "above") anchorY = rect.top - gap;
      else if (place === "below") anchorY = rect.bottom + gap;
      else if (place === "left") anchorX = rect.left - gap;
      else anchorX = rect.right + gap; // right
      // 未缩放几何：锚点→容器边缘是 CSS transform 的固定关系（above=底边贴锚、below=顶边贴锚、
      // 左右=垂直居中），高度用布局值 h 推出来的上下沿不受动画缩放污染。
      const boxTop = place === "below" ? anchorY : (place === "above" ? anchorY - h : anchorY - h / 2);
      const boxBottom = boxTop + h;

      let newPlace = place;
      if (place === "above" || place === "below") {
        // 水平夹紧（按中心）
        if (w > 0) {
          const half = w / 2 + PAD;
          const minX = bounds.left + half;
          const maxX = Math.max(minX, bounds.right - half);
          const clampedX = Math.min(Math.max(anchorX, minX), maxX);
          if (clampedX !== anchorX) anchorX = clampedX;
        }
        const spacing = place === "above" ? (rect.top - boxBottom) : (boxTop - rect.bottom);
        const withinBars = place === "above" ? (boxTop >= navBottom) : (boxBottom <= bottomTop);
        if (spacing >= MIN_GAP && withinBars) {
          // 位置正确，无需校正
        } else {
          const other = place === "above" ? "below" : "above";
          const roomOther = other === "above"
            ? (rect.top - gap - h) >= navBottom
            : (rect.bottom + gap + h) <= bottomTop;
          if (roomOther) {
            newPlace = other;
            anchorY = other === "above" ? (rect.top - gap) : (rect.bottom + gap);
          } else if (place === "above" && boxTop < navBottom) {
            anchorY = navBottom + h; newPlace = "above"; // 贴导航栏下沿
          } else if (place === "below" && boxBottom > bottomTop) {
            anchorY = bottomTop - h; newPlace = "below"; // 贴底栏上沿
          } else {
            anchorY = place === "above" ? (rect.top - MIN_GAP) : (rect.bottom + MIN_GAP);
            newPlace = place;
          }
        }
      } else {
        // 左/右：垂直居中并夹在导航栏/底栏之间；水平夹在视口内
        const halfH = h / 2 + PAD;
        if (anchorY - halfH < navBottom) anchorY = navBottom + halfH;
        else if (anchorY + halfH > bottomTop) anchorY = bottomTop - halfH;
        if (place === "left") {
          const minAnchorX = bounds.left + PAD + w; // 工具栏右沿(=anchorX)须 >= 内容区左边界+PAD+w
          if (anchorX < minAnchorX) anchorX = minAnchorX;
        } else {
          const maxAnchorX = bounds.right - PAD; // 工具栏左沿(=anchorX)须 <= 内容区右边界-PAD
          if (anchorX > maxAnchorX) anchorX = maxAnchorX;
        }
        newPlace = place;
      }
      const c = toContainerCoords(anchorX, anchorY);
      // 2026-10-13 P2-7：位置/朝向/宽度态都没变就跳过重赋值——每次赋值都触发 Svelte
      // 更新与样式重算，转场连拍（create→edit + 本函数实测校正）时属无谓重排。
      // 同一套确定性输入（rect/place/bounds）算出的容器坐标逐位相等，不会误跳过。
      const narrowNext = selToolbarNarrow(bounds);
      if (c.x !== selToolbar.x || c.y !== selToolbar.y || newPlace !== selToolbar.place || narrowNext !== selToolbar.narrow) {
        selToolbar = { ...selToolbar, x: c.x, y: c.y, place: newPlace, narrow: narrowNext };
      }
      if (DEBUG_READER) {
        void tick().then(() => {
          const a = el?.getBoundingClientRect();
          console.log("[REword][fix] 校正后", {
            newPlace, anchorX: Math.round(anchorX), anchorY: Math.round(anchorY), cx: Math.round(c.x), cy: Math.round(c.y),
            actual: a ? { t: Math.round(a.top), b: Math.round(a.bottom), l: Math.round(a.left), r: Math.round(a.right) } : null,
          });
        });
      }
    } catch (e) {
      console.warn("[REword][fix] 异常:", e);
    }
  }

  /** 把 ISO 时间格式化为「YYYY-MM-DD HH:mm」便于查看气泡展示 */
  function fmtTime(iso?: string): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /** 把标签 id 列表解析为 {id, name, color}（委托插件 LabelStore）
   *  [labels-off] getLabel 未提供或返回 null（标签系统关闭 / 标签已删）→ 跳过该标签，
   *  不再降级显示灰 #id 文本（气泡无标签时整块不渲染） */
  function resolveLabels(ids: string[] | undefined): { id: string; name: string; color: string }[] {
    if (!ids || !ids.length) return [];
    return ids.map((id) => {
      const info = getLabel ? getLabel(id) : null;
      return info ? { id, name: info.name, color: info.color } : null;
    }).filter((x): x is { id: string; name: string; color: string } => x !== null);
  }

  /**
   * 统一浮层（批注编辑器 / 查看卡）定位：锚定选区 + 四向避让 + 边界夹紧。
   * 替代此前分散在 editorPosition / openNoteEditor / showViewerForRec 的三套重复逻辑。
   * 机制（参考 readest / Weave 的 popover 思路）：
   *   - 复用工具栏同款 toolbarPlacement 纯函数决策 上/下/左/右 四向，绝不压住选中文本，
   *     同时避让导航栏 / 底栏 / 视口边界。
   *   - 锚点：above=选区上沿-gap（CSS translate(-50%,-100%)）、below=下沿+gap、
   *     left=左沿-gap 垂直居中（translate(-100%,-50%)）、right=右沿+gap 垂直居中（translate(0,-50%)）。
   *   - 上下两向额外做水平夹紧；左右两向额外做垂直夹紧，确保弹窗完整可见。
   * @param rect 选区/高亮矩形（视口坐标，已含 iframe 帧偏移）
   * @param popupW 弹窗宽度 px（必须与 CSS .reader-note-editor width 一致，含 padding）
   * @param popupH 弹窗预估高度 px（用于左右空间判定）
   */
  function positionPopupNear(rect: SelRect | null | undefined, popupW: number, popupH: number): { x: number; y: number; place: ToolbarPlace } {
    if (!rect) {
      // 无矩形（C 跳转后）：在内容区顶部居中（下方展开，不被顶栏遮挡）
      const bounds = getContentBounds();
      return { x: (bounds.left + bounds.right) / 2, y: bounds.top + 40, place: "below" };
    }
    const gap = 8;
    const padding = 8;
    const bounds = getContentBounds();
    // 导航栏/底栏取其在视口中的真实下沿/上沿，与 rect（视口坐标）同基准比较。
    const navBottom = bounds.top;
    const bottomTop = bounds.bottom;
    // 2026-08-29 四向避让：复用工具栏同款决策（绝不压住选中文本 + 避让导航/底栏 + 避让左右 Dock）。
    const { place, anchorX, anchorY } = toolbarPlacement(rect, popupH, popupW, navBottom, bottomTop, bounds.left, bounds.right, gap);
    let c = toContainerCoords(anchorX, anchorY);
    if (place === "above" || place === "below") {
      // 水平夹紧：弹窗以 x 为中心（CSS translate(-50%,...)），保证不溢出/不压侧栏
      const half = popupW / 2 + padding;
      const minX = bounds.left + half;
      const maxX = Math.max(minX, bounds.right - half);
      c.x = Math.min(Math.max(c.x, minX), maxX);
    } else {
      // 左右：垂直居中于选区，夹紧 y 使弹窗不越导航/底栏
      const half = popupH / 2 + padding;
      const minY = navBottom + half;                 // 视口坐标
      const maxY = Math.max(minY, bottomTop - half); // 视口坐标
      const clampedAnchorY = Math.min(Math.max(anchorY, minY), maxY);
      c = toContainerCoords(anchorX, clampedAnchorY);
    }
    return { x: c.x, y: c.y, place };
  }

  /** 根据标注记录填充并弹「简易预览卡」（preview 态）。
   *  2026-08-26 用户设计：有笔记批注 → 先弹只读预览（时间+笔记+标签+复制/编辑/删除图标），
   *  点「✏️ 笔记」才展开完整编辑器 (mode="edit")。 */
  function showPreviewViewer(rec: { id: string; cfi: string; color: string }, rect?: SelRect | null) {
    if (!annStore) { try { annStore = getAnnotationStore(); } catch { annStore = null; } }
    const stored = annStore?.get(rec.id);
    dbg.event("showPreviewViewer", "▶ 批注预览卡路径", { id: rec?.id, cfi: rec?.cfi, classify: stored ? classifyAnnotation(stored) : "?" });
    closeSelToolbar();
    const style = (stored?.style as AnnotationStyle) || "highlight";
    const color = stored?.color || rec.color;
    lastStyle = style; lastColor = color; // 同步偏好，供「编辑」复用
    const text = stored?.selectedText ?? stored?.note ?? "";
    const note = stored?.note ?? "";
    const group = stored?.group ?? "未分组";
    const time = fmtTime(stored?.updatedAt || stored?.createdAt);
    const labels = resolveLabels(stored?.labels);
    // 统一用 positionPopupNear（锚定 + 四向避让 + 水平/垂直夹紧）。
    // ⚠️ 高度值2026-10-08 从 200 下调到 170：取消/保存并入工具条、快捷键提示行删除，
    //    卡片矮了约 30px。positionPopupNear 拿这个数做四向避让判定 ——
    //    不跟着改的话，它以为下方还塞不下，会把卡片放到错误方位。
    const pos = rect
      ? positionPopupNear(rect, NOTE_CARD_W, 170)
      : { x: (readerViewEl?.clientWidth ?? window.innerWidth) / 2, y: 80, place: "below" as ToolbarPlace };
    const annStyle = ANNOTATION_STYLES[style] || { label: t("直线") };
    noteEditor = {
      visible: true, x: pos.x, y: pos.y, mode: "preview",
      id: rec.id, cfi: rec.cfi,
      text, note, style, color, group, time, labels,
      styleLabel: t(annStyle.label),
      place: pos.place,
    };
  }

  /** 根据标注记录填充并弹「查看浮层」（view 态，保留兼容 C 跳转兜底） */
  function showViewerForRec(rec: { id: string; cfi: string; color: string }, rect?: SelRect | null) {
    showPreviewViewer(rec, rect);
  }

  /**
   * 进入「标注编辑态」（复用 selToolbar，不弹独立浮层）。两个入口共用：
   *   ① 点已有纯高亮（onShowAnnotation / onPdfAnnotClick）；
   *   ② create 态点「标注」一键高亮后原地转 edit（2026-10-11 微信读书化，用户拍板 D3）。
   * 设计：
   *   - 槽位 2 由「标注」换成「🗑️ 删除划线」（样式行常显，点样式/颜色即时切换）
   *   - 样式行由 `mode === "edit"` 决定渲染，带 selStripIn 滑入动画
   * 定位：四向避让（含样式行高度），渲染后 fixToolbarPlacement 实测校正。
   * 2026-10-13 P0-2：create→edit 转场时钉住主栏——above/below 靠 CSS 让样式行从主栏
   *   背离选区一侧折出（容器贴锚点的正是主栏那一侧，主栏零位移）；left/right 容器垂直
   *   居中，样式行在主栏下方会把主栏顶上半行，故锚点同步下移 stripH/2 补偿。
   */
  function openHighlightEditToolbar(rec: { id: string; cfi: string; color: string }, rect?: SelRect | null) {
    if (!annStore) { try { annStore = getAnnotationStore(); } catch { annStore = null; } }
    const stored = annStore?.get(rec.id);
    const style = (stored?.style as AnnotationStyle) || "highlight";
    const color = stored?.color || rec.color;
    lastStyle = style; lastColor = color; // 同步偏好，供样式/颜色切换复用
    const bounds = getContentBounds();
    const midX = rect ? (rect.left + rect.right) / 2 : (bounds.left + bounds.right) / 2;
    const navBottom = bounds.top;
    const bottomTop = bounds.bottom;
    // 2026-08-29 四向避让：edit 态含样式行（更高更宽），用 toolbarPlacement 统一决策上/下/左/右。
    const gap = 12;
    const effH = TOOLBAR_WITH_STRIP_H;
    // offsetWidth：若上一次入场动画还没跑完，getBoundingClientRect 会给缩水值（见常量处注释）。
    const effW = selToolbarEl?.offsetWidth || 300;
    const fallbackRect: SelRect = rect ?? { left: midX, top: 80, right: midX, bottom: 80 };
    // 2026-10-12 P1-§6.3：create 态点「标注」原地转 edit 时，样式行让高度 +47px，
    // 重新打分可能把 above 翻成 below ⇒ 整条工具栏在用户眼前瞬移。
    // 只在「同一次选区的转场」上钉住当前朝向（且它在新高度下必须不压字、不越界，见 toolbarPlacement）。
    const preferPlace = selToolbar.visible && selToolbar.mode === "create" ? selToolbar.place : undefined;
    let { place, anchorX, anchorY } = toolbarPlacement(fallbackRect, effH, effW, navBottom, bottomTop, bounds.left, bounds.right, gap, preferPlace);
    // 2026-10-13 P0-2：转场锚点补偿（仅 left/right 需要）。
    // above/below：样式行由 CSS 长在主栏「背离选区」那一侧（above=column-reverse 翻到上方、
    //   below=原生下方），容器贴锚点的正是主栏那一侧 ⇒ 主栏零位移；
    // left/right：容器按锚点垂直居中，样式行在主栏下方会把主栏顶上 stripH/2
    //   ⇒ 锚点下移半行，主栏中心保持原位。非转场（直接点已有标注）无需补偿。
    if (preferPlace && (place === "left" || place === "right")) {
      const stripH = selStripEl?.offsetHeight || (TOOLBAR_WITH_STRIP_H - TOOLBAR_BAR_ONLY_H);
      anchorY = anchorY + stripH / 2;
    }
    const c = toContainerCoords(anchorX, anchorY);
    cancelSelToolbarOut(); // 转场/直接开 edit 态 → 收起动画作废
    selToolbar = {
      visible: true, x: c.x, y: c.y,
      text: stored?.selectedText ?? "", mode: "edit",
      editingId: rec.id, place,
      annId: rec.id, annCfi: rec.cfi, annStyle: style, annColor: color,
      narrow: selToolbarNarrow(bounds),
    };
    // 渲染后实测校正，确保不压选区
    void fixToolbarPlacement(fallbackRect, gap);
  }

  /**
   * 2026-09-09：PDF 点击命中文本标注（PdfTextHlLayer 的 iframe click 命中回调）。
   * EPUB 下等价路径是 foliate 原生 overlayer 派发 show-annotation → openHighlightEditToolbar；
   * PDF 原生层已停画，由自建覆盖层补命中。rect 为视口坐标，直接供 toolbarPlacement 避让。
   */
  function onPdfAnnotClick(payload: { annId: string; x: number; y: number; rect: { left: number; top: number; right: number; bottom: number } }) {
    if (!payload?.annId || !isPdfBook()) return;
    if (!annStore) { try { annStore = getAnnotationStore(); } catch { annStore = null; } }
    const stored = annStore?.get(payload.annId);
    if (!stored || stored.deletedAt) return;
    // 工具栏已在编辑同一条标注 → 不再重复定位（避免点击抖动）
    if (selToolbar.visible && selToolbar.mode === "edit" && selToolbar.editingId === payload.annId) return;
    openHighlightEditToolbar(
      { id: stored.id, cfi: stored.cfi || "", color: stored.color || "" },
      payload.rect
    );
  }

  /**
   * 纯高亮（标注）样式面板：仅提供「样式切换 + 颜色切换 + 删除」，不含时间/笔记/复制/编辑，
   * 与批注查看卡 (mode:"view") 完全隔离。用于 onShowAnnotation 判定 isPureHighlight 时的入口。
   * 复用 positionPopupNear 定位；预估高度 120（两行 + 删除按钮，比 view 卡矮）。
   * （2026-08-26 已废弃：纯标注改走 openHighlightEditToolbar，保留函数供 C 跳转兜底）
   */
  function showHighlightViewer(rec: { id: string; cfi: string; color: string }, rect?: SelRect | null) {    if (!annStore) { try { annStore = getAnnotationStore(); } catch { annStore = null; } }
    const stored = annStore?.get(rec.id);
    closeSelToolbar();
    const style = (stored?.style as AnnotationStyle) || "highlight";
    const color = stored?.color || rec.color;
    lastStyle = style; lastColor = color; // 同步偏好，供「高亮」复用
    // ⚠️ 高度值 2026-10-08 从 170 下调到 140（卡片矮了约 30px，理由同 preview 态）
    const pos = rect
      ? positionPopupNear(rect, NOTE_CARD_W, 140)
      : { x: (readerViewEl?.clientWidth ?? window.innerWidth) / 2, y: 80, place: "below" as ToolbarPlace };
    const annStyle = ANNOTATION_STYLES[style] || { label: t("直线") };
    noteEditor = {
      visible: true, x: pos.x, y: pos.y, mode: "highlight",
      id: rec.id, cfi: rec.cfi,
      text: "", note: "", style, color, group: stored?.group ?? "未分组", time: "",
      labels: [], styleLabel: t(annStyle.label),
      place: pos.place,
    };
  }

  /** C 跳转：按 cfi 反查标注记录并弹查看浮层（无矩形则顶部居中） */
  function showViewerForCfi(cfi: string) {
    if (!cfi) return;
    if (!annStore) { try { annStore = getAnnotationStore(); } catch { annStore = null; } }
    let rec: { id: string; cfi: string; color: string } | null = annByValue.get(cfi) ?? null;
    if (!rec && annStore && bookId) {
      const nc = (s: string) => String(s || "").replace(/^epubcfi\(/i, "").replace(/\)+$/, "");
      const target = nc(cfi);
      const hit = annStore.getByBook(bookId).find((it: any) => {
        const a = nc(it.cfi);
        return a === target || (a && (a.startsWith(target) || target.startsWith(a)));
      });
      if (hit) rec = { id: hit.id, cfi: hit.cfi, color: hit.color };
    }
    if (!rec) { toast(t("未找到该阅读批注")); return; }
    showViewerForRec(rec, null);
  }

  /** 关闭统一批注浮层 */
  function closeNoteEditor() {
    noteEditor = { ...noteEditor, visible: false, mode: "create", id: null, place: "below" };
  }

  /** 通知侧边栏：阅读器内标注数据已变更（新增/更新/删除），需重新渲染 */
  function dispatchAnnotationChanged() {
    try {
      window.dispatchEvent(new CustomEvent("reword:annotation-store-changed"));
    } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · dispatchAnnotationChanged", "debug"); }
  }

  // 自动聚焦批注输入框（create/edit 态 textarea 渲染后聚焦，readest 批注即打字）
  function focusNoteInput(node: HTMLTextAreaElement) {
    node.focus();
  }

  /** C 跳转定位（由 ReaderTabController.focusAnnotation 调用）：等待 foliate view 就绪 → goTo 跳转 → 弹查看气泡 */
  export async function focusAnnotation(cfi: string) {
    if (!cfi) return;
    // 2026-09-09 P1：矩形标注深链（cfi 字段携带 `pdf-rect:<标注id>` 标记）
    // → 按页码跳页 → 矩形闪烁强调。不进 foliate goTo（矩形标注无 CFI）。
    if (cfi.startsWith("pdf-rect:")) {
      const annId = cfi.slice("pdf-rect:".length);
      if (!annStore) { try { annStore = getAnnotationStore(); } catch { annStore = null; } }
      const rec = (annStore?.getByBook?.(bookId) || []).find((a: any) => a.id === annId);
      const pg = rec?.pdfRects?.[0]?.page || rec?.page;
      if (pg) await goPdfPage(pg);
      await pdfHlLayerComp?.flashRect(annId);
      return;
    }
    // 等待 foliate view 就绪（书籍异步加载，openBookTab 返回时未必已挂载完成）
    let tries = 0;
    while (tries < 25) {
      if (view && typeof (view as any).goTo === "function") break;
      await new Promise((r) => setTimeout(r, 120));
      tries++;
    }
    try {
      await (view as any)?.goTo(cfi);
    } catch (e) {
      console.warn("[REword] focusAnnotation goTo 失败:", e);
    }
    // 跳转后高亮应已在视口；按 cfi 反查记录并弹查看气泡（无矩形 → 顶部居中）
    showViewerForCfi(cfi);
  }

  /**
   * 统一标注跳转入口（由 ReaderTabController.focusAnnotationRecord 调用）：
   * 接收**整条标注记录**，复用内部 jumpAnnot 自行分支 ——
   *   EPUB 文本 → goTo(cfi)；PDF（文本/矩形）→ goPdfPage(page) + flashRect 闪烁定位。
   * 为什么要有它：旧 focusAnnotation(cfi) 只认 cfi，而 PDF 文本标注只有 page，
   * 从工作台 / 微阅批注列表点进去会静默失败。
   */
  export async function focusAnnotationRecord(ann: any) {
    if (!ann) return;
    // 与 focusAnnotation 同款：等待 foliate view 就绪（书籍异步加载，openBookTab 返回时未必挂载完）
    let tries = 0;
    while (tries < 25) {
      if (view && typeof (view as any).goTo === "function") break;
      await new Promise((r) => setTimeout(r, 120));
      tries++;
    }
    await jumpAnnot(ann);
    // EPUB：jumpAnnot 的 cfi 分支只 goTo 不弹气泡，这里补上（与 focusAnnotation 体验一致）
    if (!isPdfBook() && typeof ann.cfi === "string" && ann.cfi) showViewerForCfi(ann.cfi);
  }

  function showToolbarFor(sel: ReaderSel) {
    // 2026-08-25 竞态防护：若 onContainerMouseDown 已检测到点了标注（suppressNextCreateToolbar=true），
    // 说明 show-annotation 会接管本次点击（弹 edit 工具栏或批注弹窗），跳过创建工具栏。
    if (suppressNextCreateToolbar) {
      console.log("[REword] showToolbarFor: suppressNextCreateToolbar=true，跳过创建工具栏（已由 show-annotation 接管）");
      suppressNextCreateToolbar = false; // 消费后立即重置
      return;
    }
    positionToolbarAbove(sel.rect, sel.text, "create", null);
  }

  function setSelFrom(sel: ReaderSel | null) {
    if (sel) {
      // 2026-10-24：跨 section 续接的分段信息要保住 ——
      // 选区路径重新读取时 cfi 不变（还是同一段），此时不该把 segments 抹掉。
      const keepSegs = (selInfo?.segments && selInfo.cfi && selInfo.cfi === sel.cfi) ? selInfo.segments : undefined;
      selInfo = { index: sel.index, cfi: sel.cfi, range: sel.range, pdfRects: sel.pdfRects, segments: keepSegs };
      showToolbarFor(sel);
    } else {
      closeSelToolbar();
    }
  }

  /**
   * 2026-10-24 D2/D4：翻页后**重锚**划词工具栏与手柄（跨页续接用）。
   *
   * ## 为什么不能沿用「翻页即收起」
   * 跨页续接时，拖手柄翻页**不是**放弃选区，而是要把选区接到下一页继续标。
   * 若翻页就收起工具栏，用户每翻一页都要重新点一次「标注」，续接就断了。
   *
   * ## 重锚 vs 收起
   *  - 选区仍可见（哪怕只剩续上去的那一段）⇒ 按**可见部分**重新定位工具栏 + 手柄；
   *  - 选区已完全不可见 ⇒ 收起（避免留残影）。
   */
  function reanchorSelToolbar(): void {
    const sel = readReaderSelection();
    if (!sel) {
      if (selToolbar.visible) closeSelToolbar();
      if (selHandles.visible) selHandles = { ...selHandles, visible: false };
      return;
    }
    // 分段要保住：跨 section 续接时，relocate 重锚不能把已累积的 segments 抹掉，
    // 否则松手保存时只剩最后一段，前面的段全丢（同 setSelFrom 的保留口径）。
    const keepSegs = (selInfo?.segments && selInfo.cfi && selInfo.cfi === sel.cfi) ? selInfo.segments : undefined;
    selInfo = { index: sel.index, cfi: sel.cfi, range: sel.range, pdfRects: sel.pdfRects, segments: keepSegs };
    if (!selToolbar.visible || selToolbar.mode !== "create") return;
    positionToolbarAbove(sel.rect, sel.text, "create", null);
  }

  /**
   * 2026-10-24：跨页续接是否仍在有效期内。
   * 翻页是异步的（foliate 内部动画 + 100ms 等待），relocate 事件会**晚于**翻页请求到达，
   * 所以不能用「刚刚发起过翻页」的布尔量，要用时间窗。
   */
  function isSelContinuationActive(): boolean {
    return performance.now() < selContinuationUntil;
  }

  // 2026-08-24 修复（问题1）：拖动选词过程中**不弹工具栏**（工具栏交由 mouseup 后的 onContentMouseUp）。
  // 但 2026-10-14 P1：手柄要「选中即出现、随选区长度实时扩展」（微信读书式），故这里 rAF 节流地只刷手柄，
  // 不碰工具栏/cfi。键盘选区（无 mouseup）同样靠这里实时出手柄。
  function onContentSelectionChange() {
    if (selHandleLiveRaf) return;
    selHandleLiveRaf = requestAnimationFrame(() => {
      selHandleLiveRaf = 0;
      updateSelHandlesLive();
    });
    // 2026-10-25 移动端适配 A2：selectionchange 防抖兜底弹划词工具栏。
    // A1 主路径（touchend）覆盖"长按选词"；本兜底覆盖"拖系统选区手柄改选区"——
    // iOS/Android 的选区手柄是系统 UI，拖动/松手不产生页面 touchend，只能靠 selectionchange 感知。
    // gate：仅触屏（桌面靠 mouseup 精确触发，这里直弹会拖选抖动）+ 非自绘手柄拖拽中
    // （selHandleDragging 自管）+ 只有读到**有效选区**才弹（折叠时绝不收，避免拖动中误关）。
    if (!isTouchDevice() || selHandleDragging) return;
    if (selTouchDebounceTimer) clearTimeout(selTouchDebounceTimer);
    selTouchDebounceTimer = setTimeout(() => {
      selTouchDebounceTimer = null;
      if (selHandleDragging) return;
      if (readReaderSelection()) scheduleReadSelection();
    }, 320);
  }
  function onContentMouseUp(_e: MouseEvent) {
    contentPointerHeld = false; // 松手：解除「拖选中」避让，此后滚动可正常收起
    // 2026-10-25 角落自动翻页：原生拖选松手即取消角驻留（L 动画收回、dwell 作废）
    cornerMachine.cancel();
    // 等选区稳定后再读取；foliate 内容 doc 可能在该刻尚未就绪，加有限重试兜底
    scheduleReadSelection();
  }

  /** 2026-10-14 P2：滚动即收起划词工具栏 + 两端手柄（对齐微信读书——滚动/翻页时选区浮层消失）。
   *  用即时 hardClose（不走 140ms 收起动画）：工具栏/手柄在主文档浮层里位置固定，正文在 iframe 内滚动，
   *  动画期间会「钉在原地与文字脱节」，瞬收更干净。避让：拖手柄中、或正按住鼠标拖选（边缘自动滚动）时不收。 */
  function hideSelOnScroll(): void {
    if (selHandleDragging || contentPointerHeld) return;
    if (selToolbar.visible || selHandles.visible) hardCloseSelToolbar();
  }

  /**
   * 2026-08-27 修复（工具栏点空白不收起）：
   * onContainerMouseDown 绑在父文档 .reader-view 容器上，但 iframe 内 mousedown 不冒泡到
   * 父文档 —— 阅读区（iframe 正文）点空白永远触发不到它。叠加 scheduleReadSelection 对
   * edit 态空选区直接 return、create 态要等 ~600ms 重试梯子才收起，表现为
   * 「点空白工具栏不消失 / 严重滞后」。这里在 iframe doc 上补 mousedown 监听：
   * - 点空白/普通文本 → 同步立即收起工具栏与批注浮层（无 RAF、无重试延迟，流畅灵敏）
   * - 点标注/高亮/SVG 绘制层 → 不在此关（show-annotation 接管，与父文档场景 A 行为一致）
   * capture 阶段触发，先于 foliate 内部 click 处理；随后的拖选/双击选词仍由
   * onContentMouseUp → scheduleReadSelection 正常弹出新工具栏，互不干扰。
   *
   * 2026-10-15 补：同一条「iframe 内 mousedown 到不了父文档」的根因，也解释了
   * **抽屉（书签/目录/搜索/灯箱）在正文里点空白关不掉** —— 正文几乎铺满可视区，
   * 父文档那条路径只剩页边距能命中，用户感知就是「点了没反应」。故场景 B 现在
   * 与父文档同语义：统一走 closeAllPopovers()，不再只管工具栏。
   */
  function onContentMouseDown(e: MouseEvent) {
    // 2026-10-14 合成点击防御：isTrusted=false = 代码派发（思源 Shift 浮窗机制会向内容区
    // 派发合成 mousedown），或无毫秒级紧邻 pointerdown → 一律忽略，不关浮层。
    const pdt = performance.now() - contentPointerDownMs;
    const siyuanShiftMode = (window as any)?.siyuan?.shiftIsPressed === true;
    if (e.isTrusted === false || siyuanShiftMode || !(pdt >= 0 && pdt < 600)) return;
    if (e.button !== 0) return;
    // 每次点击重置抑制标志（与父文档 onContainerMouseDown 一致，独立判断每次点击）
    suppressNextCreateToolbar = false;
    // 早退 gate 必须把「瞬时浮层」也算进来：只查工具栏/批注卡的话，
    // 抽屉单独开着时这条路径根本走不到下面的判定（正是上面那个 bug 的一半）。
    const anyTransient =
      showToc || showMarks || showSearch || showFootnote || !!activeDrawer ||
      dictPopup.visible || imgView.open;
    if (!selToolbar.visible && !noteEditor.visible && !anyTransient) return;
    const t = e.target as HTMLElement | null;
    const isAnnotationTarget = !!(
      t?.closest?.("foliate-highlight") || (t as any)?.closest?.("[data-annotation]") ||
      (t as any)?.namespaceURI === "http://www.w3.org/2000/svg"
    );
    if (isAnnotationTarget) {
      // 场景 A：标注点击由 show-annotation 接管（弹 edit 工具栏/查看卡），
      // 抑制随后 mouseup → scheduleReadSelection 的创建工具栏；旧工具栏延迟一帧关闭。
      // ⚠️ 这里**不收抽屉** —— 与父文档场景 A 一致：点标注是「继续操作」不是「终止」。
      suppressNextCreateToolbar = true;
      cancelPendingClose();
      pendingCloseRaf = requestAnimationFrame(() => {
        pendingCloseRaf = null;
        if (selToolbar.visible) closeSelToolbar();
      });
      return;
    }
    // 场景 B：点空白/普通文本 → 立即收起（同步，无延迟）
    closeAllPopovers();
    if (selToolbar.visible) closeSelToolbar();
    if (noteEditor.visible) noteEditor = { ...noteEditor, visible: false, mode: "create", id: null };
  }
  // 2026-09-05（性能）：selectionchange 在拖动/输入光标移动时会高频触发，
  // 而 readReaderSelection() 要跨 iframe 遍历所有内容 doc 并取 getBoundingClientRect
  // （跨 iframe 强制 layout，重的）。这里用 rAF 合并同一帧内的重复触发，每帧最多读一次。
  // 注：mouseup 路径（onContentMouseUp）不走这里，仍保留其重试梯子，行为不变。
  let selReadRaf: number | null = null;
  function onMainSelectionChange() {
    if (selReadRaf != null) return;
    selReadRaf = requestAnimationFrame(() => {
      selReadRaf = null;
      scheduleReadSelection();
    });
  }

  /**
   * 2026-08-24 修复（P0 #3）：首次选中文本时，foliate 的 overlay/内容 doc 可能尚未
   * 完成挂载，单次 readReaderSelection() 会返回 null → 工具栏不弹。这里做有限重试
   * （最多 ~300ms，阶梯延时），任一帧读到有效选区即弹出，避免"首次选词呼不出工具栏"。
   * 重试全部失败（确实无选区）才隐藏工具栏。
   */
  let selReadTimer: any = null;
  function scheduleReadSelection(attempt = 0) {
    // 2026-10-14 地基重构：无可选区能力的正文（漫画 CBZ 图片页）直接跳过划词读取。
    // EPUB / PDF(textLayer) 的 caps.selection=true，行为不变；此前漫画靠「读不到文本」隐式兜底。
    if (!caps.selection) return;
    // 2026-10-14 P1：正在拖拽选区手柄 → 选区由手柄路径自管，忽略 iframe/父文档的选区读取，
    // 否则拖拽中的 selectionchange/mouseup 会用旧锚点重弹工具栏、与手柄抢更新导致抖动。
    if (selHandleDragging) return;
    // 批注窗口编辑/新建模式打开时，忽略选区变化：
    // 否则在 textarea 输入时光标移动触发主 document 的 selectionchange，
    // 残留的 foliate 选区会被 readReaderSelection 读到 → 误弹划词工具栏。
    // 注意：仅屏蔽 edit/create（有 textarea 输入），不屏蔽 view（只读查看卡无输入）。
    if (selReadTimer) { clearTimeout(selReadTimer); selReadTimer = null; }
    if (noteEditor.visible && (noteEditor.mode === "edit" || noteEditor.mode === "create")) {
      // 本状态忽略选区（textarea 输入保护），直接早退
      return;
    }
    const sel = readReaderSelection();
    if (sel) { setSelFrom(sel); return; }
    if (attempt >= 6) {
      // 重试耗尽仍无选区：说明用户确实没选中（或点空白处）。
      // 2026-08-24 修复：edit 模式（点已有高亮弹出的工具栏）下，**不能**因空选区
      // 就关掉工具栏——否则用户在正文轻微移动/点击会让工具栏瞬间消失（"移动鼠标就消失"）。
      // edit 工具栏的关闭只交给显式入口：点空白 onContainerMouseDown / 删除 /
      // 点其他高亮（show-annotation 重设）/ 点样式。create 模式才由选区驱动显隐。
      if (selToolbar.mode === "edit") return;
      setSelFrom(null);
      return;
    }
    // 阶梯延时：10/30/60/100/160/240ms（累计 ≤ 300ms）
    const delays = [10, 30, 60, 100, 160, 240];
    selReadTimer = setTimeout(() => scheduleReadSelection(attempt + 1), delays[attempt] ?? 240);
  }

  /**
   * 2026-08-23 修复：reader-view 内的浮层（划词/词典/批注）原本用 position:fixed
   *   定位，覆盖整个视口会拦截思源顶栏"管理"等原生 UI 点击。改为 absolute
   *   后，left/top 相对容器左上角，需要减去 reader-view 视口偏移。
   *   此函数返回 .reader-view 容器（readerViewEl）的视口位置，浮层出现时统一减掉即可。
   *   注意：之前错误用 container（foliate-view 容器）作为偏移基，导致坐标偏差；
   *   现改用 readerViewEl (.reader-view 容器) 作为正确偏移基。
   */
  type ReaderViewOffset = { left: number; top: number };
  function getReaderViewOffset(): ReaderViewOffset {
    if (!readerViewEl) return { left: 0, top: 0 };
    const rect = readerViewEl.getBoundingClientRect();
    return { left: rect.left, top: rect.top };
  }

  /** 把视口坐标转换为容器相对坐标（absolute 定位用） */
  function toContainerCoords(vx: number, vy: number): { x: number; y: number } {
    const off = getReaderViewOffset();
    return { x: vx - off.left, y: vy - off.top };
  }

  /** 返回内容区（.reader-stage）视口位置。
   *  2026-08-25 修复：浮层"上方/下方"避让判定必须以内容区为原点，而非整个 .reader-view
   *  （后者含上方导航栏 ~40px）。否则选区贴内容顶部时，rel.top≈导航栏高度，"上方"判定误以为
   *  有空间，工具栏被算到 y≈0 区域、body 反向上探进导航栏，表现为"工具栏在阅读边框外/不可用"。
   *  stage 不可用时回退到 reader-view 基准，保证降级可用。 */
  function getStageOffset(): ReaderViewOffset {
    if (!readerStageEl) return getReaderViewOffset();
    const rect = readerStageEl.getBoundingClientRect();
    return { left: rect.left, top: rect.top };
  }

  /** 返回阅读器内容区在视口中的真实边界（排除思源左右 Dock 占用区域）。
   *  2026-08-30 修复：工具栏/弹窗若按 readerViewEl.clientWidth 夹紧，会误以为 [0, viewW] 就是可见区，
   *  当左侧/右侧 Dock 展开时，readerViewEl 实际向右/左偏移，按 0 夹紧会算进 Dock 下方，导致浮层被 Dock 遮挡。
   *
   *  ⚠️ 2026-10-08 顶栏浮层化：`top` 不再是「stage 顶」而是**浮起态顶栏的底沿**。
   *
   *  ## 为什么这是本次改造里最隐蔽、也最必须改的一处
   *  `positionToolbarAbove()` 用 `bounds.top` 当`navBottom`（浮层"往上方放"的禁区下界）。
   *  顶栏在文档流里时，stage 顶 = 顶栏底沿，两者重合 ⇒ 用 stage 顶是对的。
   *  顶栏浮层化后 stage 顶 = .reader-view 顶（顶栏已不占流），
   *  **若仍返回 stage.top，禁区下界就比实际禁区小了一整条顶栏的高度（≈36px）**
   *  ⇒ 顶部选区会被误判为「上方有空间」⇒ 划词工具栏被放到顶栏背后，
   *  表现为「选中第一行的字，工具栏不见了 / 灰出一条」。
   *
   *  ⇒ 必须取两者较大值：**顶栏浮起时用顶栏底沿，否则用 stage 顶**。 */
  function getContentBounds(): { left: number; right: number; top: number; bottom: number } {
    if (readerStageEl) {
      const r = readerStageEl.getBoundingClientRect();
      // 顶栏浮起且在视口内时，它的底沿才是真正的禁区下界。
      // getBoundingClientRect() 已含transform —— 收起态顶栏被 translateY(-140%)
      // 移出视口，rect.bottom 会是负数/极小值，故必须同时检查 topBarRevealed。
      let top = r.top;
      if (isTopBarFloating() && topBarRevealed && topBarEl) {
        const tb = topBarEl.getBoundingClientRect();
        // 兜底：只接受「在 stage 上方、且高度合理」的底沿。
        // 万一DOM 尚未布局（rect 全 0），宁可退回 stage 顶也不能把禁区算成 0。
        if (tb.bottom > top && tb.bottom - top < 200) top = tb.bottom;
      }
      return { left: r.left, right: r.right, top, bottom: r.bottom };
    }
    const viewW = readerViewEl?.clientWidth ?? window.innerWidth;
    const navBarEl = readerViewEl?.querySelector<HTMLElement>(".reader-toolbar");
    const viewRect = readerViewEl?.getBoundingClientRect();
    return {
      left: viewRect?.left ?? 0,
      right: viewRect?.right ?? viewW,
      top: navBarEl ? navBarEl.getBoundingClientRect().bottom : 40,
      // 2026-08-30：进度条已默认移出文档流（隐藏/离屏），不再用其 top 当内容底边，
      // 否则隐藏态会算出离屏坐标导致浮层可越界至正文底部外。
      bottom: (viewRect?.bottom ?? window.innerHeight) - 6,
    };
  }

  /** 把选区视口矩形转换为「内容区相对矩形」。
   *  浮层"上方/下方"判断必须用内容区相对坐标（原点 = .reader-stage 左上角，即正文区域顶边）：
   *  - 选区贴正文顶部时 rel.top≈0，roomAbove 判定直接为 false → 落在下方，工具栏不再反探进导航栏；
   *  - 与 toContainerCoords（仍以 reader-view 为基准、用于绝对定位）分工：
   *    rectToViewRel 只服务"上下空间判定"，toContainerCoords 只服务"浮层绝对定位"，互不串味。
   *  说明：此前用 reader-view 基准，内容顶部被算成 y≈40，导致上方有"伪空间"而误放。 */
  function rectToViewRel(rect: SelRect): SelRect {
    const off = getStageOffset();
    return {
      left: rect.left - off.left,
      top: rect.top - off.top,
      right: rect.right - off.left,
      bottom: rect.bottom - off.top,
    };
  }

  function toast(msg: string) {
    toastMsg = msg;
    toastUndo = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastMsg = ""; toastUndo = false; }, 1800);
  }

  /** 带「撤销」按钮的提示（用于删除标注，3 秒内可恢复） */
  let toastUndo = false;
  let pendingDelete: {
    id: string; cfi: string; style: AnnotationStyle; color: string;
    note: string; selectedText: string; group: string;
  } | null = null;
  let undoTimer: any = null;
  function toastWithUndo(msg: string) {
    toastMsg = msg;
    toastUndo = true;
    if (toastTimer) clearTimeout(toastTimer);
    // 撤销窗口比普通 toast 长一点（3s），与 pendingDelete 超时一致
    toastTimer = setTimeout(() => { toastMsg = ""; toastUndo = false; }, 3000);
  }

  // 查词 → 弹窗渲染卡片（同源简化版小窗卡）
  // opts.x/opts.y 指定弹窗容器相对坐标；opts.source 标记来源（sel=划词工具栏, hover=Option 悬浮）
  // 2026-09-07 双源：dictPopupMode 决定离线/在线词海，🌐 按钮切换
  //
  // 🔴 2026-10-08：不再是纯内存的固定值 —— 初值取自设置 `dictDefaultSource`，
  //   且每次打开弹窗时重新对齐（见 runDictLookup 开头）。
  //   原先硬编码 "offline"，用户点了 🌐 切到在线，**刷新页面就悄悄变回离线** ——
  //   「我明明选了海词」的困惑就是这么来的。
  let dictPopupMode: "offline" | "online" = "offline";
  /** 在线词典总闸；关掉后 🌐 不可用且不发起任何网络请求 */
  $: onlineDictOn = settings.onlineDictEnabled !== false;
  /** 🌐 按钮是否可用（在线被关 ⇒ 强制离线） */
  $: dictCanSwitch = onlineDictOn;
  /** 切换到指定源；在线被关时强制回落离线。返回是否真的切了（用于 toast）。 */
  function setDictMode(mode: "offline" | "online"): boolean {
    const next = mode === "online" && !onlineDictOn ? "offline" : mode;
    const changed = next !== dictPopupMode;
    dictPopupMode = next;
    return changed;
  }
  /**
   * 查词 → 弹窗渲染卡片（同源简化版小窗卡）
   *
   * @param opts.keepMode 切换数据源后就地重查时传 true ——
   *   否则会被上面那句「对齐设置默认源」立刻覆盖回去，
   *   表现为「点 🌐 没反应」（这是加持久化时最容易踩的一个坑）。
   */
  function runDictLookup(
    word: string,
    opts?: { x?: number; y?: number; source?: "sel" | "hover"; keepMode?: boolean },
  ) {
    const x = opts?.x ?? selToolbar.x;
    const y = opts?.y ?? (selToolbar.y + toolbarH);
    const source = opts?.source ?? "sel";
    // 每次开弹窗都对齐设置的「默认数据源」——
    // 这样刷新页面后不会莫名回到离线（原先 dictPopupMode 是硬编码的内存变量）。
    // setDictMode 自带在线总闸检查：在线被关时会回落离线。
    if (!opts?.keepMode) setDictMode(settings.dictDefaultSource === "online" ? "online" : "offline");
    dictPopupSource = source;
    dictPopup = { visible: true, x, y, html: renderLoading(), word, source };
    setTimeout(async () => {
      let html: string;
      /** 命中词条时的词头（自动发音用）；落到候选建议列表时保持空串 */
      let headword = "";
      if (dictPopupMode === "online") {
        const r = await fetchOnlineDict(word);
        if (r) {
          html = renderOnlineDictCardSimple(r, { inVocab: isInVocab?.(word) ?? false });
          headword = r.word || word;
        } else {
          html = renderDictSuggestions(word, searchCandidates(word, 3));
        }
      } else {
        const entry = lookupSmart(word);
        if (entry) {
          const parsed = parseDictEntry(entry);
          html = renderDictCardSimple(parsed, { showStar: true, inVocab: isInVocab?.(word) ?? false, onlineSwitchEnabled: dictCanSwitch });
          headword = parsed.word || word;
        } else {
          const cands = searchCandidates(word, 3);
          html = renderDictSuggestions(word, cands);
        }
      }
      // 仅当来源未切换时更新（避免悬浮→划词切换时旧异步请求覆盖新弹窗）
      if (dictPopupSource === source) {
        dictPopup = { ...dictPopup, html };
        if (headword) maybeAutoSpeakDictWord(headword);
      }
    }, 30);
  }

  function onSelDict() {
    const text = selToolbar.text?.trim();
    if (!text) return;
    runDictLookup(text);
    closeSelToolbar();
  }

  /**
   * 划词工具栏「搜索」（2026-10-08 新增）。
   *
   * 补的是 Readest 有、我们唯一**真正缺**的划词工具项：
   *  · copylink（复制链接）—— EPUB 里是书内锚点不是可分享 URL，抄了也没用
   *  · proofread（校对）—— 英文语法检查，中文书用不上
   * 「搜索」是真需求：选中即查这个词在全书的其他用法。
   *
   * 复用现有的 `doSearch` / `searchQuery` 面板，不新造搜索逻辑。
   */
  function onSelSearch() {
    const text = selToolbar.text?.trim();
    if (!text) return;
    // 2026-10-23 修复：改用 hardCloseSelToolbar() 立即卸载选区工具栏。
    // 原 closeSelToolbar() 会播 140ms 收起动画，期间选区工具栏（.reader-sel-main，
    // z-index:2 且 DOM 在 .reader-search 之后）仍挂在 .reader-floating-layer 上，
    // 盖住刚弹出的搜索面板 ✕，导致点击被吞 = "关不掉/卡死"。立即卸载可消除残影。
    hardCloseSelToolbar();
    searchQuery = text;
    // 复用面板的「按章节/全书」范围与大小写开关，不另设一套
    searchScope = "chapter";
    openSearch();
  }
  // ============ Phase 2：划词高亮 + 批注（阅读器 / foliate 集成） ============

  /** foliate annotation 事件接入：draw-annotation 画高亮、show-annotation 弹查看、create-overlay 重绘该书批注 */
  function setupAnnotationLayer() {
    if (!view) return;
    // 懒取单例（index.ts 初始化后注入）；失败不阻塞阅读
    if (!annStore) {
      try { annStore = getAnnotationStore(); } catch { annStore = null; }
    }
    // --- v3 诊断 ---
    dbgHud.setupCalled = true;
    dbgHud.annStoreReady = !!annStore;
    dbgHud.bookIdAtSetup = bookId || "(empty)";
    if (annStore && bookId) {
      try { dbgHud.annotCountInStore = annStore.getByBook(bookId).length; } catch { dbgHud.annotCountInStore = -1; }
      // v5 深度诊断：store 总数 + 所有 bookId + 是否包含当前 bookId
      try {
        const all = annStore.getAll();
        dbgHud.totalInStore = all.length;
        const bookIds = [...new Set(all.map((a: any) => a.bookId).filter(Boolean))];
        dbgHud.storeBookIds = bookIds.join(", ") || "(none)";
        dbgHud.bookIdMatch = bookIds.includes(bookId);
      } catch(e: any) { dbgHud.totalInStore = -1; dbgHud.storeBookIds = e.message; }
    }
    // --- /v3 ---
    annByValue.clear();
    annIndexCache.clear();
    // 重绘该书已有批注（每节 overlay 创建时触发）
    view.addEventListener("create-overlay", onCreateOverlay);
    // 绘制高亮（参照 foliate 官方 demo reader.js）：按 style 选择线型
    // 现精简为 3 类：highlight（背景高亮）/ wavy（波浪线）/ solid（直线段/下划线）
    view.addEventListener("draw-annotation", onDrawAnnotation);
    // 点击已有高亮/直线/波浪线 → 弹查看卡
    view.addEventListener("show-annotation", onShowAnnotation);
    // 脚注：监听可取消的 link 事件，命中脚注引用则阻止 foliate 跳转并弹气泡展示
    view.addEventListener("link", onBookLink);
    // 2026-08-25 滚动/翻页跟随：foliate 内容在 iframe 内滚动时选区矩形随之变化，
    // 而工具栏/批注卡坐标是创建时一次性写死的 → 视觉「脱钩」。监听 relocate（滚动/翻页即触发），
    // 统一收起所有瞬时浮层，符合「滚动=放弃临时浮层」心智模型，并消除错位。
    view.addEventListener("relocate", onRelocate);
    // 2026-08-26 退回 foliate 原生管线：高亮由 foliate 的 create-overlay 事件 +
    // view.addAnnotation 内部 overlayer 管理，无需我们自建 SVG 层，也无需初始全量自绘。
    // 页签重新可见时：foliate 的 overlayer 随 iframe 持久存在；若 iframe 被销毁重建，
    // foliate 会重新触发 create-overlay → onCreateOverlay 自动重绘。此处仅作安全兜底：
    // 回到可见区时标记 annotationsDirty，借 relocate 信号用 foliate 原生管线补绘
    // （addReaderAnnotation 内部幂等：foliate 的 addAnnotation 会先 remove 再 add）。
    if (typeof IntersectionObserver !== "undefined" && readerStageEl) {
      visibilityObserver = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            annotationsDirty = true;
            // 兜底：若 foliate 未在重显时触发 relocate，延迟补绘一次
            setTimeout(() => {
              if (annotationsDirty) { redrawBookAnnotations(); annotationsDirty = false; }
            }, 450);
          }
          // 离开可见区：保留 annotationsDirty，下次回到页签再补绘
        }
      }, { threshold: 0 });
      visibilityObserver.observe(readerStageEl);
    }
  }

  /** 卸载 foliate view 上的 annotation 事件监听，避免反复进出阅读 Tab 造成泄漏/悬空回调 */
  function teardownAnnotationLayer() {
    if (!view) return;
    view.removeEventListener("create-overlay", onCreateOverlay);
    view.removeEventListener("draw-annotation", onDrawAnnotation);
    view.removeEventListener("show-annotation", onShowAnnotation);
    view.removeEventListener("link", onBookLink);
    view.removeEventListener("relocate", onRelocate);
    if (visibilityObserver) {
      visibilityObserver.disconnect();
      visibilityObserver = null;
    }
  }

  /** 滚动/翻页时收起所有瞬时浮层：划词工具栏、批注卡、脚注、词典。
   *  根因：这些浮层坐标是创建时一次性写死（absolute 定位于容器），foliate 内容在 iframe 内
   *  滚动后选区矩形已变，浮层仍停在旧坐标 → 视觉「脱钩」错位。收起比错位更可接受，
   *  也契合「滚动=放弃临时浮层」的心理模型。注：此事不含 TOC/设置/搜索等常驻面板。 */
  function onRelocate() {
    // 2026-10-14 伪 relocate 防御：思源按 Shift 时（shiftIsPressed + body--shift-pressed +
    // 强制刷新浮窗）会引起书页布局抖动 → foliate 发 relocate → 误走「滚动=收起全部浮层」，
    // 批注卡在输入中被关。判别：Shift 模式期间，或「无真实滚动(>800ms) 且焦点在批注输入框」
    // → 视为伪 relocate，跳过收起（标注脏重绘照常）。真滚动/翻页（有 scroll 事件）不受影响。
    const siyuanShiftMode = (window as any)?.siyuan?.shiftIsPressed === true;
    const scrollDt = performance.now() - lastContentScrollMs;
    const typingInNote = !!(document.activeElement as HTMLElement | null)?.classList?.contains("reader-note-input");
    if (siyuanShiftMode || (scrollDt > 800 && typingInNote)) {
      if (annotationsDirty) {
        redrawBookAnnotations();
        if (annStore && bookId && view) annotationsDirty = false;
      }
      return;
    }
    dbgHud.relocateCalls++;
    // 2026-10-25 移动端适配 B2：翻页即收顶/底浮层栏（真机反馈遮挡正文；
    // relocate 也会在初始加载/改字号时触发，栏未浮起时是 no-op）。触屏 only。
    retractFloatingBars();
    // 2026-10-24 D2：跨页续接进行中 ⇒ **不收起**划词浮层，改为按新位置重锚。
    // （续接窗口内用户正在把选区往下一页接，收起会打断"选到一半"的连续动作。）
    if (isSelContinuationActive() && (selToolbar.visible || selHandles.visible)) {
      reanchorSelToolbar();
      // 2026-10-24 批 D：拖手柄翻页落地后，把**按住的指针点**在新页上再算一次落点 ⇒
      // 选区自动延伸进新页，用户不用继续动鼠标（Readest onAutoTurn→updateFromDraggedPoint 同款）。
      // 钩子只在按住期间存在：松手时 onUp 会清掉，所以不会在拖拽结束后偷改选区。
      const replay = selDragReplay;
      if (replay) {
        selDragReplay = null;
        replay();
      }
      if (noteEditor.visible) noteEditor = { ...noteEditor, visible: false, mode: "create", id: null, place: "below" };
      if (showFootnote) closeFootnote();
      if (dictPopup.visible) dictPopup = { ...dictPopup, visible: false };
      closeImageViewer();
      if (annotationsDirty) {
        redrawBookAnnotations();
        if (annStore && bookId && view) annotationsDirty = false;
      }
      return;
    }
    if (selToolbar.visible) closeSelToolbar();
    // 2026-10-14 P2：翻页/位置变化时手柄立即消失（工具栏走 140ms 收起动画，手柄钉在旧坐标会脱节）。
    if (selHandles.visible) selHandles = { ...selHandles, visible: false };
    if (noteEditor.visible) noteEditor = { ...noteEditor, visible: false, mode: "create", id: null, place: "below" };
    if (showFootnote) closeFootnote();
    if (dictPopup.visible) dictPopup = { ...dictPopup, visible: false };
    // 2026-10-15 图片灯箱：换 section 后 foliate 会把旧图的 blob URL 引用计数减到 0 并
    // revoke（vendor/foliate-js/epub.js:930-938）⇒ 灯箱里的 src 会变成死链，必须关而不是藏。
    closeImageViewer();
    // 2026-08-26 退回 foliate 原生：高亮归 foliate 的 overlayer 管理，随 iframe 持久存在，
    // 重渲后 foliate 自动 redraw()。仅作安全兜底：若 annotationsDirty（由页签可见性置位），
    // 用 foliate 原生管线幂等重绘该书批注。
    if (annotationsDirty) {
      redrawBookAnnotations();
      if (annStore && bookId && view) annotationsDirty = false;
    }
  }

  /* ================= 脚注气泡（点击脚注引用 → 弹气泡展示内容，不跳转） ================= */

  /** link 事件处理器：foliate-view 点击 <a> 时触发（cancelable）。
   *  命中脚注 → preventDefault 阻止跳转 + 弹气泡；非脚注 → 放行 goTo（目录/普通内链不受影响）。 */
  async function onBookLink(e: any) {
    const a = e.detail?.a;
    const href = e.detail?.href;
    if (!a || !href) return;
    if (!isFootnoteRef(a)) return; // 非脚注：不拦截，foliate 默认 goTo
    // 是脚注：阻止跳转
    e.preventDefault();
    clearTimeout(footnoteHoverTimer);
    footnoteHoverAnchor = a;
    await showFootnoteFor(a, href, { pin: true });
  }

  /** 抽取脚注内容并弹气泡（点击 / 悬停共用）。
   *  - opts.pin：点击触发时锁定气泡（hover 移开不自动收起，点空白才关）；
   *  - 已显示同一锚点时仅更新锁定态、不重抽（避免抖动与重复 IO）；
   *  - footnoteReqToken 防竞态：快速划过多个脚注时，过期请求的异步结果被丢弃。 */
  async function showFootnoteFor(a: any, href: string, opts?: { pin?: boolean }) {
    if (!a || !href) return;
    if (!isFootnoteRef(a)) return; // 非脚注：不拦截，foliate 默认 goTo
    href = resolveFootnoteHref(a, href); // 缺陷 A：裸 #hash → 全径（点击路径已是全径，幂等）
    // 点击已显示的同一脚注：仅更新锁定态，不重抽（避免抖动/重复 IO）
    if (showFootnote && footnoteHoverAnchor === a) {
      footnotePinned = opts?.pin ?? footnotePinned;
      return;
    }
    const myToken = ++footnoteReqToken; // 作废任何在途旧请求
    footnoteHoverAnchor = a;
    footnotePinned = opts?.pin ?? false;
    footnoteLoading = true;
    showFootnote = true; // 立即显示 loading 占位气泡（抽取可能异步），给即时反馈
    await tick();
    // ===== 坐标转换（完全对齐工具栏已验证管线）=====
    // a 在 iframe 内容文档内，getBoundingClientRect() 返回 iframe 视口坐标
    // 需加 frameElement 偏移 → 主文档视口坐标 → toContainerCoords → 容器绝对定位坐标
    const r = a.getBoundingClientRect();
    let vx = r.left, vy = r.top, vr = r.right, vb = r.bottom;
    const win = a.ownerDocument?.defaultView;
    if (win) {
      const frame = (win as any).frameElement as HTMLElement | null;
      if (frame) {
        const fr = frame.getBoundingClientRect();
        vx += fr.left; vy += fr.top; vr += fr.left; vb += fr.top;
      }
    }
    // 用脚注号**水平中心**作为锚点（比左上角更自然）
    const anchorX = (vx + vr) / 2;
    const anchorY = vy; // 气泡默认在脚注号下方弹出
    positionFootnoteBubble(anchorX, anchorY, r.width, r.height); // 估算高度先定位（loading 占位较小）
    try {
      const result = await extractFootnote(view?.book, href);
      if (myToken !== footnoteReqToken) return; // 已有更新的请求，丢弃本条过期结果
      if (!result.html) {
        // 抽取失败：降级跳转。2026-10-26 缺陷 B 修复：preventDefault 早已执行，
        // foliate 默认跳转不会发生——toast 说「将跳转」就必须真跳，否则就是没反应。
        toast(t("脚注内容获取失败，将跳转到原位置"));
        closeFootnote();
        try {
          const t = await view?.book?.resolveHref?.(href);
          if (t) await view?.goTo?.(href);
        } catch (e) {
          logSwallow(e, "ReaderView.svelte · showFootnoteFor 降级跳转", "debug");
        }
        return;
      }
      footnoteHTML = result.html;
      footnoteType = result.type;
      footnoteTarget = result.target ?? null;
      footnoteResolvedHref = result.resolvedHref ?? null;
      footnoteLoading = false;
      // 内容到达后校正定位（按真实高度避免溢出）
      requestAnimationFrame(() => refineFootnotePosition(anchorX, anchorY, r.height));
    } catch (err) {
      if (myToken !== footnoteReqToken) return;
      footnoteLoading = false;
      console.warn("[REword] 脚注展示失败:", err);
      toast(t("脚注展示异常"));
    }
  }

  /** 悬停脚注引用 → 防抖 350ms 弹气泡；移出 → 延迟收起（除非点击锁定） */
  function onFootnoteHover(e: MouseEvent) {
    // 划词工具栏 / 批注编辑可见时不弹 hover 脚注，避免干扰
    if (selToolbar.visible || noteEditor.visible) {
      clearTimeout(footnoteHoverTimer);
      return;
    }
    const a = (e.target as Element | null)?.closest?.("a");
    if (!a || !isFootnoteRef(a)) {
      scheduleFootnoteHoverHide();
      return;
    }
    // 同一引用已在显示：忽略
    if (showFootnote && footnoteHoverAnchor === a) return;
    clearTimeout(footnoteHoverTimer);
    const el = a as any;
    footnoteHoverTimer = setTimeout(() => {
      footnotePinned = false; // hover 触发不锁定
      footnoteHoverAnchor = el;
      showFootnoteFor(el, el.getAttribute("href") || "");
    }, 350);
  }

  /** 鼠标移出脚注引用：延迟收起（点击锁定的气泡不收起） */
  function scheduleFootnoteHoverHide() {
    clearTimeout(footnoteHoverTimer);
    setTimeout(() => {
      if (showFootnote && !footnotePinned && footnoteHoverAnchor) {
        closeFootnote();
      }
    }, 220);
  }


  /** 定位脚注气泡：基于主文档视口坐标的锚点，智能四向避让
   *  anchorX/Y 已是主文档视口坐标（iframe 偏移已加），内部用 toContainerCoords 转容器相对坐标
   */
  function positionFootnoteBubble(anchorX: number, anchorY: number, anchorW: number, anchorH: number) {
    const el = document.querySelector(".reader-footnote") as HTMLElement | null;
    if (!el) return;
    const viewW = readerStageEl?.clientWidth ?? 800;
    const viewH = readerStageEl?.clientHeight ?? 600;
    const bubbleW = Math.min(360, viewW * 0.8);
    const bubbleHEstimate = 220;
    const gap = 6; // 气泡与脚注号的间距
    const padding = 12; // 与内容区边缘的最小间距

    // 锚点转内容区相对坐标（用于上下左右空间判定）
    const stageOff = getStageOffset();
    const relAnchorX = anchorX - stageOff.left;
    const relAnchorY = anchorY - stageOff.top;

    // 默认：脚注号下方弹出
    let relX = relAnchorX + gap;
    let relY = relAnchorY + anchorH + gap;
    let placeAbove = false;

    // ── 智能四向避让（全部使用内容区相对坐标）──

    // 1. 右边界夹紧
    if (relX + bubbleW > viewW - padding) {
      relX = viewW - bubbleW - padding;
    }
    if (relX < padding) relX = padding;

    // 2. 下边界：空间不足 → 翻到上方
    if (relY + bubbleHEstimate > viewH - padding) {
      relY = relAnchorY - bubbleHEstimate - gap;
      placeAbove = true;
    }
    if (relY < padding && !placeAbove) {
      relY = relAnchorY + anchorH + gap;
      placeAbove = false;
    } else if (relY < padding && placeAbove) {
      relY = padding;
    }

    // 3. 水平优化：优先居中于脚注号，靠右时左对齐
    const centeredX = relAnchorX - bubbleW / 2;
    if (centeredX >= padding && centeredX + bubbleW <= viewW - padding) {
      relX = centeredX;
    } else if (relAnchorX > viewW * 0.6 && relAnchorX - bubbleW > padding) {
      relX = relAnchorX - bubbleW - gap;
    }

    // 内容区相对坐标 → 容器绝对定位坐标（toContainerCoords 同款）
    const c = toContainerCoords(relX + stageOff.left, relY + stageOff.top);
    el.style.left = `${c.x}px`;
    el.style.top = `${c.y}px`;
    el.dataset.placeAbove = String(placeAbove);
  }

  /** 首次渲染后实测气泡高度，校正是否溢出内容区 */
  async function refineFootnotePosition(anchorX: number, anchorY: number, anchorH: number) {
    const el = document.querySelector(".reader-footnote") as HTMLElement | null;
    if (!el) return;
    const viewH = readerStageEl?.clientHeight ?? 600;
    const padding = 12;
    const gap = 6;
    const actualH = el.offsetHeight;
    const stageOff = getStageOffset();
    // 直接用容器的 getBoundingClientRect 反算内容区相对坐标做判定
    const elRect = el.getBoundingClientRect();
    const relY = elRect.top - stageOff.top;
    const placeAbove = el.dataset.placeAbove === "true";
    const relAnchorY = anchorY - stageOff.top;

    if (placeAbove) {
      if (relY < padding) {
        const c = toContainerCoords(stageOff.left + padding, anchorY);
        el.style.top = `${c.y}px`;
      }
    } else {
      if (relY + actualH > viewH - padding) {
        // 尝试翻到上方
        const aboveRelY = relAnchorY - actualH - gap;
        if (aboveRelY >= padding) {
          const c = toContainerCoords(stageOff.left + 12, anchorY - actualH - gap);
          el.style.top = `${c.y}px`;
          el.dataset.placeAbove = "true";
        } else {
          // 上下都不够：限制最大高度
          const c = toContainerCoords(stageOff.left + padding, stageOff.top + padding);
          el.style.top = `${c.y}px`;
          el.style.maxHeight = `${viewH - 2 * padding}px`;
        }
      }
    }
  }

  function closeFootnote() {
    footnoteReqToken++; // 作废在途抽取请求，避免关闭后旧结果回填气泡
    showFootnote = false;
    footnoteHTML = "";
    footnoteType = t("脚注");
    footnoteLoading = false;
    footnoteHoverAnchor = null;
    footnotePinned = false;
    footnoteTarget = null;
    footnoteResolvedHref = null;
    if (footnoteHoverTimer) clearTimeout(footnoteHoverTimer);
  }

  /**
   * 「↗ 跳转」：把用户送到脚注原文所在的那一页（2026-10-09 新增）。
   *
   * 为什么需要：气泡默认显示在脚注号**下方**，而脚注正文在书末/章末那一页。
   * 用户看到内容后想核对原文时，得自己拖进度条找 —— 而跳转所需的数据
   * （`resolveHref` 的 `target`）在抽取时就已经拿到了，只是没往外传。
   *
   * ## 为什么走 `renderer.goTo`而不是 `view.goTo`
   *
   * `view.goTo(target)`（view-light.js:539）会 `history.pushState(target)`，
   * 把 `{index, anchor}` 这个**对象**塞进历史栈 —— 之后浏览器前进/后退拿到的是
   * 一个普通对象而非字符串，行为不可预期。
   * foliate 自己的锚点跳转（view-light.js:254、paginator.js:3834）都走 renderer，
   * 走同一条路径才能保证与「点目录跳章节」完全一致（含分页/滚动两种模式）。
   *
   * ## 为什么不做「成功/失败」toast
   *
   * `paginator.#goTo` **成功时也返回 undefined**（:3728 起全程无 return 值），
   * `goTo`（:3834）只在 `#canGoToIndex` 为false 时静默返回。
   * ⇒ 返回值无法区分成败，任何基于它的判断都是错的。
   * 跳转成功与否用户自己看得见（页面会滚过去），不打扰；
   * 只在**明确可预知**的越界情况下提示一次。
   */
  async function jumpToFootnotePage() {
    // 2026-10-26 重做：改走 view.goTo(解析href)——与目录跳转同一条正路。
    //
    // ## 历史与现状
    //
    // 2026-10-09 版走 `renderer.goTo({index, anchor})`（避开 view.goTo 的 history.pushState）；
    // 但 anchor 是**函数**（`doc => getHTMLFragment(doc, hash)`），实测（台架，同书同参）
    // vendor 路径本身没问题——无反应的根因在插件侧状态竞态与 href 形态（见调研报告
    // docs/脚注跳转与气泡样式-调研-2026-10-26.md 缺陷 A/B）。
    // 现在：
    // ① 首选 `view.goTo(resolvedHref)`（字符串）——history.pushState 存字符串安全
    //   （「对象进历史栈」只发生在传对象时），且与目录跳转完全同路，行为可预期；
    // ② resolvedHref 缺失（旧缓存/异常路径）时保留 {index, anchor} 兜底；
    // ③ 插桩日志：仍有无反应时 console.debug 可直接定位到哪一层。
    const target = footnoteTarget;
    const resolvedHref = footnoteResolvedHref;
    closeFootnote(); // 先关：它会把 footnoteTarget/footnoteResolvedHref 清掉，所以提前取出
    console.debug("[REword] 脚注跳转", { resolvedHref, target });
    if (resolvedHref) {
      try {
        await view?.goTo?.(resolvedHref);
        return;
      } catch (e) {
        logSwallow(e, "ReaderView.svelte · jumpToFootnotePage(view.goTo)", "debug");
      }
    }
    if (!target || target.index == null) return;
    // 越界 = 章节已被移除/索引失效，属唯一能预判的失败
    const total = view?.book?.sections?.length ?? 0;
    if (total > 0 && (target.index < 0 || target.index >= total)) {
      toast(t("未能定位到脚注所在页"));
      return;
    }
    try {
      await view?.renderer?.goTo?.(target);
    } catch (e) {
      logSwallow(e, "ReaderView.svelte · jumpToFootnotePage", "debug");
      toast(t("跳转到脚注页失败"));
    }
  }

  /** 点击脚注气泡外部关闭：注册在 main document + 每个内容文档 capture 阶段。
   *  命中脚注引用锚点时忽略（让 onBookLink 打开新脚注，避免先关后闪）；
   *  命中气泡内部忽略。 */
  function onFootnoteOutsidePointerDown(e: PointerEvent) {
    if (!showFootnote) return;
    const target = e.target as Element | null;
    if (!target) return;
    // 点击气泡内部：不关闭
    if (footnoteEl && footnoteEl.contains(target)) return;
    // 点击脚注引用锚点：不关闭（让 onBookLink / onFootnoteHover 处理）
    const a = target.closest?.("a");
    if (a && isFootnoteRef(a)) return;
    closeFootnote();
  }

  /** R3 类型收口：绘制 overlay 所需的最小入参（真源是 annStore，此处只取画图相关字段） */
  type AnnDrawInput = { id?: string; cfi?: string; segments?: { index: number; cfi: string }[]; color?: string; style?: unknown; note?: string; deletedAt?: string };

  /**
   * 把单条批注绘制进 foliate（异步；用返回 index 回填 cfi→章节缓存）。
   *
   * 2026-10-24 跨页续接：一条批注可能是**多段**（每段一个 CFI，跨 section 时尤其如此），
   * 逐段调用 foliate 的 addAnnotation —— foliate 以 CFI 为单位建 overlayer 记录，
   * 多段必须分别登记，否则第二段不会画出来。
   * 单段批注走同一条路径（只有一个元素），行为与旧版完全一致。
   */
  async function addReaderAnnotation(it: AnnDrawInput, onlyCfis?: Set<string>): Promise<void> {
    dbgHud.addAnnotationTries++;
    if (!it.cfi || !it.color || !view) return;
    if (it.deletedAt) return; // 软删除项不重绘（最终一致保障：翻页后已删高亮彻底消失）
    // 2026-09-09 双绘根治：PDF 文本标注视觉单一真源是自建覆盖层 PdfTextHlLayer。
    // 此处是 foliate 原生管线的唯一入口，PDF 下必须拒绘——fixed-layout 每页也建
    // overlayer 并派发 create-overlay，恢复/改色/撤销等路径会把标注喂进来，
    // 原生 SVG 层与 PDF 文本层的缩放 transform 坐标系不匹配 → 叠一层漂移高亮。
    if (isPdfBook()) return;
    const color = it.color;
    const style = normalizeAnnotationStyle(it.style) as AnnotationStyle;
    let cfis = annotationCfis(it);
    if (onlyCfis) cfis = cfis.filter((c) => onlyCfis.has(c));
    if (!cfis.length) return;
    for (const cfi of cfis) {
      await drawAnnotationCfi(cfi, color, style, it);
    }
  }

  /** 绘制单段（单 CFI）批注 */
  async function drawAnnotationCfi(cfi: string, color: string, style: AnnotationStyle, it: AnnDrawInput): Promise<void> {
    // 2026-10-13 P0-3：绘制前抢占标记（覆盖 await 在途窗口）——60ms 后的 reconcile
    // 见到窗口内的 cfi 直接跳过补绘，不重复喂同一条 CFI 给 foliate
    // （其 addAnnotation 内部是 remove 再 add，双轨命中就是「画了→删→再画」的闪烁）。
    markDirectDrawn(cfi);
    try {
      const res: any = await view.addAnnotation({ value: cfi, color, style, note: it.note || "" });
      if (res && typeof res.index === "number") annIndexCache.set(cfi, res.index);
      // annByValue 只存 {id, cfi, color}：note/style 一律以 annStore 为唯一真源，
      // 避免三处 note 拷贝不一致（2026-08-24 重构）。
      // 2026-10-13 P1-5：it.id 可能尚未落库（saveHighlight 改为视觉先行、upsert 并行），
      // 此处不得把已登记的真实 id 覆盖成 undefined。
      const prev = annByValue.get(cfi);
      annByValue.set(cfi, { id: it.id ?? prev?.id, cfi, color });
    } catch (err) {
      recentDirectDraws.delete(cfi); // 绘制失败 ⇒ 收回标记，reconcile 兜底补绘
      dbgHud.addAnnotationErrors++;
      // 2026-08-25 可靠性：原空 catch 静默吞错，无法排查 CFI 无效/overlay 未就绪等问题。
      console.warn("[REword] addReaderAnnotation 失败（id=" + it?.id + ", cfi=" + cfi + "）:", err);
    }
  }

  /**
   * 用 foliate 原生管线重绘该书所有批注（幂等）。
   * 逐条调用 addReaderAnnotation → view.addAnnotation，foliate 内部会
   *   resolveNavigation(cfi) → 找该分节 overlayer → emit draw-annotation → 我们 onDrawAnnotation 画。
   * 不依赖自建 SVG 层。供 onCreateOverlay / 页签可见性兜底 / relocate 兜底复用。
   */
  function redrawBookAnnotations() {
    if (!annStore || !bookId || !view) return;
    // 2026-09-09 双绘根治：PDF 标注视觉单一真源是 PdfTextHlLayer，
    // 页签可见性兜底 / relocate 兜底不得再把 PDF 标注喂进 foliate 原生管线。
    if (isPdfBook()) return;
    const annots = annStore.getByBook(bookId);
    dbgHud.annotCountInStore = annots.length;
    for (const it of annots) {
      if (!it.cfi || it.deletedAt) continue;
      void addReaderAnnotation(it);
    }
  }

  /**
   * 章节 overlay 创建回调（foliate 原生管线）。
   * - create-overlay 事件携带 detail.index（章节索引），此时该分节的 Overlayer 已就绪，
   *   调用 view.addAnnotation 必能命中 #getOverlayer → emit draw-annotation → 绘制。
   * - 性能优化：annIndexCache 缓存 cfi→章节索引。若已缓存且 ≠ 当前章节则跳过
   *   （等该章节 overlay 创建时再画）；未缓存或匹配当前章节则交给 addReaderAnnotation
   *   （内部 resolveNavigation 解析并回填缓存，且幂等：重复 add 只重绘不重复）。
   */
  function onCreateOverlay(e?: any) {
    dbgHud.createOverlayCalls++;
    // 2026-09-09 双绘根治：PDF 每页 frame 也会建 overlayer → 此事件每页触发，
    // PDF 标注视觉全交 PdfTextHlLayer（annStore.subscribe 重绘），原生管线直接跳过。
    if (isPdfBook()) return;
    if (!annStore || !bookId || !view) return;
    const idx = e?.detail?.index;
    dbgHud.ovr_evtIndex = (typeof idx === "number") ? idx : -1;

    const annots = annStore.getByBook(bookId);
    dbgHud.annotCountInStore = annots.length;

    for (const it of annots) {
      if (!it.cfi || it.deletedAt) continue;
      // 章节索引缓存命中且不匹配当前章节 → 跳过（等该章节 overlay 创建时再画）
      // 2026-10-24 跨页续接：一条批注可能有多段（分属不同 section），
      // 必须**逐段**判断 —— 只看首段的缓存会把后一段误判成"别的章节"而永远不画。
      const cfis = annotationCfis(it);
      const pending = cfis.filter((c) => {
        const cached = annIndexCache.get(c);
        return !(typeof cached === "number" && typeof idx === "number" && cached !== idx);
      });
      if (!pending.length) continue;
      // 否则（未缓存或匹配当前章节）交给 foliate 原生 addAnnotation，
      // 内部解析 CFI、缓存章节索引、emit draw-annotation。
      void addReaderAnnotation(it, new Set(pending));
    }
  }

  // 2026-08-26 退回 foliate 原生：自建 SVG 高亮层（getOrCreateRewordOverlay /
  // drawAnnotationDirect / resolveAndDrawAnnotation / rewordOverlays / rewordHighlights）
  // 已全部移除，统一由 foliate 的 Overlayer + view.addAnnotation + draw-annotation 事件承担。

  /**
   * foliate 的 draw-annotation 事件处理器：由 view.addAnnotation 内部 emit，
   * 携带 { draw, annotation, doc, range }。我们用 foliate 自带的 Overlayer 静态方法绘制，
   * 支持 highlight（背景）/ solid（直线段=underline）/ wavy（波浪线=squiggly）三类。
   */
  function onDrawAnnotation(e: any) {
    const detail = e?.detail;
    const draw = detail?.draw;
    const annotation = detail?.annotation;
    const doc = detail?.doc;
    const range = detail?.range;
    if (!draw || !annotation || !range) return;

    // 2026-10-14 防御：绘制路径统一走调色板归一化，杜绝漏网旧色值（历轮校准存量）
    const color = normalizeAnnotationColor(annotation.color) || "#f5d567";
    const style = normalizeAnnotationStyle(annotation.style) as AnnotationStyle;
    dbgHud.drawnCount++;
    dbgHud.lastDraw = `draw style=${style} color=${color} cf=${String(annotation.value || "").slice(0, 20)}`;

    if (style === "solid") {
      // 直线段：foliate Overlayer.underline（一条横线下沿）
      // 2026-10-13：调色板切微信读书淡彩系，实线加粗到 2.6 保可见性
      const wm = getWritingMode(doc, range);
      draw(Overlayer.underline, { color, width: 2.6, ...wm });
    } else if (style === "wavy") {
      // 波浪线：foliate Overlayer.squiggly
      const wm = getWritingMode(doc, range);
      draw(Overlayer.squiggly, { color, width: 2.6, ...wm });
    } else {
      // 高亮背景：微信读书同款「手绘马克笔」三段式笔触（REword 2026-10-13）。
      // seed=标注 CFI → 形状确定性（redraw/翻页返回后不变）；
      // 竖排文字暂不支持横向笔触，回退经典圆角矩形。
      const wm = getWritingMode(doc, range);
      if (wm.writingMode === "vertical-rl" || wm.writingMode === "vertical-lr") {
        // 防御：确保 iframe 文档的 --overlayer-highlight-opacity 非 0（否则高亮透明不可见）
        if (doc?.documentElement) {
          const cur = doc.defaultView?.getComputedStyle(doc.documentElement).getPropertyValue("--overlayer-highlight-opacity");
          if (!cur || cur.trim() === "0" || cur.trim() === "0px") {
            doc.documentElement.style.setProperty("--overlayer-highlight-opacity", "0.3");
          }
        }
        draw(Overlayer.highlight, { color });
      } else {
        // 2026-10-14 复刻微信机制：marker 以 0.38 透明度把饱和原色叠成淡彩；
        // 批注图标：带笔记内容的批注在末行右端画线性气泡，与纯划线区分。
        // （此处仅按 note 字段判定——foliate annotation 对象不含 selectedText，
        //   note===选中文本的情况由落库端 isPureHighlight 口径兜底。）
        const hasNote = String(annotation?.note || "").trim().length > 0;
        draw(Overlayer.marker, {
          color,
          seed: String(annotation.value || ""),
          noteIcon: hasNote,
          frameWidth: doc?.documentElement?.clientWidth || 0,
        });
      }
    }
  }

  /** 取 Range 所在节点的 writing-mode（竖排时需传给 Overlayer 的线型绘制） */
  function getWritingMode(doc: any, range: Range): { writingMode?: string } {
    try {
      const node = range.startContainer;
      const el = node && node.nodeType === 1 ? node : node?.parentElement;
      const wm = doc?.defaultView?.getComputedStyle(el)?.writingMode;
      return wm ? { writingMode: wm } : {};
    } catch {
      return {};
    }
  }

  function onShowAnnotation(e: any) {
    cancelPendingClose(); // 点高亮/批注 → 取消延迟关闭
    // 2026-08-25 机制级修复：点批注/高亮时，立即关闭「创建工具栏」+ 抑制重建。
    // 根因：关闭后 selectionchange 仍触发 scheduleReadSelection → showToolbarFor 重建工具栏。
    // 三路统一：onShowAnnotation / openNoteEditor / onEditAnnotate 均设此标志。
    if (selToolbar.visible) {
      selToolbar = { ...selToolbar, visible: false };
    }
    suppressNextCreateToolbar = true; // 阻止后续 showToolbarFor 重建
    const { value, rect: evRect } = e.detail;
    if (!value) { console.warn("[REword] onShowAnnotation: 无 value，提前返回", e.detail); return; }
    dbg.event("onShowAnnotation", "▶ 入口", { value: value, index: e.detail?.index });
    // 反查标注记录：优先 annByValue（cfi → 记录），未命中时用 annStore 兜底。
    // 2026-08-24 修复：cfi 比较做宽松匹配（去 epubcfi() 包装、互为前缀），
    // 避免 foliate 内部存储的 cfi 与 annStore 存的 cfi 因 wrap/normalize 差异而
    // 精确匹配失败，导致"高亮在但点不出工具栏"的静默失败。
    let rec = annByValue.get(value);
    const normCfi = (s: string) => String(s || "").replace(/^epubcfi\(/i, "").replace(/\)+$/, "");
    dbg.step("onShowAnnotation", "annByValue 快路径命中?", { hit: !!rec, id: rec?.id, cfi: rec?.cfi });
    if (!rec && annStore && bookId) {
      const target = normCfi(value);
      const byBook = annStore.getByBook(bookId);
      const hit =
        byBook.find((it: any) => normCfi(it.cfi) === target) ||
        byBook.find((it: any) => {
          const a = normCfi(it.cfi);
          return a && (a.startsWith(target) || target.startsWith(a));
        });
      if (hit) {
        rec = { id: hit.id, cfi: hit.cfi, color: hit.color };
        // 同步回 annByValue，后续点击走快路径
        annByValue.set(value, rec);
      }
    }
    // ★★ 关键诊断：rec 确定后立即记录路径与内容（用于排查 id=undefined 根因）
    const recPath = (function() {
      const fast = annByValue.get(value);
      if (fast && fast === rec) return "FAST";
      if (rec) return "SLOW(getByBook)";
      return "GHOST";
    })();
    if (!rec) {
      // 兜底：foliate 知道这是高亮但我们没找到活跃记录（数据已软删/损坏）。
      // 2026-08-24 死锁解除：弹 edit 工具栏 +「清除残留高亮」按钮，不再弹 toast（按钮自明）。
      // 居中兜底：工具栏坐标即 .reader-view 相对坐标（.reader-floating-layer 原点=reader-view 左上角），
      // 直接取容器半宽 / 固定 y，不要再经 toContainerCoords（那会多减一次 reader-view 视口偏移）。
      dbg.warn("onShowAnnotation", "★★ GHOST 分支命中！annByValue/annStore 均查不到记录 → annId 将为 null", { value });
      suppressNextCreateToolbar = true;  // ghost 也弹 edit 工具栏，抑制创建工具栏
      const cx = (readerViewEl?.clientWidth ?? window.innerWidth) / 2;
      // 2026-08-25 修复：ghost 分支也必须带上 cfi，否则 applyEditStyle/Color 拿不到定位键 → 样式改不了。
      // foliate 以 CFI 标识标注，无需数据库 id 即可重绘。
      selToolbar = { visible: true, x: cx, y: 80, text: "", mode: "edit", editingId: null, place: "above", ghostCfi: value, annCfi: value, narrow: selToolbarNarrow(getContentBounds()) };
      selInfo = { index: -1, cfi: value, range: null };
      // 2026-08-24 根治：残留高亮只有视觉、无数据记录，缓存 cfi 供 onClearGhostHighlight 使用
      activeAnnId = null;
      activeAnnCfi = value;
      console.log("[REword] onShowAnnotation ghost 分支: ghostCfi=", value, ", editingId=", selToolbar.editingId);
      return;
    }
    // 2026-08-26 根因修复：annByValue 缓存可能存入 id=undefined 的脏记录（历史代码路径
    // 用 noteEditor.id=null 写入，或旧版代码未校验 id）。此处做防御性补全：
    // 若 rec.id 为空，用 CFI 在 store 中反查真实 id，修复缓存，然后继续正常流程。
    if (!rec.id && annStore && bookId) {
      console.warn("[REword] onShowAnnotation: rec.id 为空！尝试用 CFI 反查 store 补全...", { cfi: rec.cfi, value });
      const byBook = annStore.getByBook(bookId);
      const normCfi = (s: string) => String(s || "").replace(/^epubcfi\(/i, "").replace(/\)+$/, "");
      const target = normCfi(rec.cfi || value);
      const hit =
        byBook.find((it: any) => normCfi(it.cfi) === target) ||
        byBook.find((it: any) => {
          const a = normCfi(it.cfi);
          return a && (a.startsWith(target) || target.startsWith(a));
        });
      if (hit?.id) {
        console.log("[REword] onShowAnnotation: id 补全成功", { oldId: rec.id, newId: hit.id, cfi: target });
        rec = { id: hit.id, cfi: rec.cfi || hit.cfi, color: rec.color || hit.color };
        annByValue.set(value, rec);  // 修复缓存，后续走快路径不再命中脏数据
      } else {
        console.warn("[REword] onShowAnnotation: id 补全失败！store 中也找不到该 CFI 的记录，降级为 ghost", { target, byBookCount: byBook.length });
      }
    }
    const stored = annStore?.get(rec.id);
    const style = (stored?.style as AnnotationStyle) || "highlight";
    const color = stored?.color || rec.color;
    lastStyle = style;
    lastColor = color;
    // 2026-08-24 修复：foliate 返回的 rect 是 iframe 内部 viewport 坐标，
    // 必须加上 iframe 在父文档中的偏移，才能与 positionToolbarAbove 预期的坐标系一致
    // （readReaderSelection 已做同样修正）。否则当 iframe 自身在父文档里有较大负偏移
    // （如多栏分页布局下 x ≈ -50000）时，工具栏 left 会被算成数万像素、飞出视口看不见。
    // 注意：foliate 没有 view.frames API，正确来源是 view.renderer.getContents()，
    // 每个 content 含 doc（iframe document），doc.defaultView.frameElement 即 iframe 元素。
    // 用事件携带的 index 匹配对应 content，取其 frame 偏移。
    let rect = evRect as SelRect | null;
    if (rect) {
      const evIndex = (e.detail?.index as number) ?? undefined;
      let frame: HTMLElement | null = null;
      try {
        for (const c of view?.renderer?.getContents?.() ?? []) {
          if (evIndex !== undefined && c.index !== evIndex) continue;
          const f = (c?.doc?.defaultView as any)?.frameElement as HTMLElement | null;
          if (f) { frame = f; if (evIndex !== undefined) break; }
        }
      } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · try { for (const c of view?.renderer?.getContents?.() ?? []) { …", "debug"); }
      if (!frame) {
        // 没拿到 index 或匹配失败：退而求其次，取第一个可见 content 的 frame
        try {
          const first = (view?.renderer?.getContents?.() ?? [])[0];
          frame = (first?.doc?.defaultView as any)?.frameElement as HTMLElement | null;
        } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · try { const first = (view?.renderer?.getContents?.() ?? [])[0];…", "debug"); }
      }
      if (frame) {
        const fr = frame.getBoundingClientRect();
        rect = {
          left: rect.left + fr.left,
          top: rect.top + fr.top,
          right: rect.right + fr.left,
          bottom: rect.bottom + fr.top,
        };
      }
    }
    // 2026-08-26 标注与批注隔离 v2：
    //   - 纯高亮（无 note）→ 复用 selToolbar 进入 edit 模式（高亮按钮变删除 + 样式条展开）
    //   - 有笔记批注 → 弹「简易预览卡」(mode:"preview")：只读 + 编辑入口
    suppressNextCreateToolbar = true;  // 抑制选区路径的创建工具栏
    // ★ 诊断日志：排查"纯高亮仍弹预览卡"问题 — 打印判定依据的原始数据
    const pure = stored ? isPureHighlight(stored) : false;
    if (DEBUG_READER) {
      console.log("[REword][onShowAnnotation] 判定依据:", {
        hasStored: !!stored,
        recId: rec?.id,
        note: stored?.note,
        noteType: typeof stored?.note,
        noteLength: stored?.note?.length,
        noteTrimmed: (stored?.note || "").trim(),
        selectedText: stored?.selectedText,
        selectedTextTrimmed: (stored?.selectedText || "").trim(),
        isPureHighlight: pure,
        classify: stored ? classifyAnnotation(stored) : "?",
      });
    }
    if (stored && pure) {
      openHighlightEditToolbar(rec, rect);
      console.log("[REword] onShowAnnotation 分支(纯高亮→selToolbar edit): rec.id=", rec.id, ", rec.cfi=", rec.cfi);
    } else {
      showPreviewViewer(rec, rect);
      console.log("[REword] onShowAnnotation 分支(批注→预览卡): rec.id=", rec.id, ", rec.cfi=", rec.cfi, ", hasNote=", !!(stored && classifyAnnotation(stored) === "annotation"), ", reason=", !stored ? "!stored" : "!pure");
    }
  }

  /** 持久化一条书籍批注 + 在 foliate 中渲染高亮（直接接收 style/color/type） */
  async function saveHighlight(cfi: string, selectedText: string, style: AnnotationStyle, color: string, note: string, group?: string, type?: AnnotationType) {
    if (!annStore) {
      try { annStore = getAnnotationStore(); } catch { annStore = null; }
    }
    if (!annStore || !bookId) { toast(t("批注存储不可用")); return; }
    // 2026-10-24 跨页续接：选区跨到下一 section 时，selInfo.segments 里有**多段** CFI。
    // 只在首段与当前 cfi 一致时带上（防止旧选区残留的 segments 误挂到别的标注上）。
    const segs = (selInfo?.segments && selInfo.cfi === cfi) ? selInfo.segments : undefined;
    const allCfis = segs && segs.length ? segs.map((s) => s.cfi).filter(Boolean) : [cfi];
    const input: any = {
      blockId: `book:${bookId}`,   // 派生虚拟块 ID，复用现有去重/聚合逻辑
      docId: bookId,
      bookId,
      cfi,
      segments: segs,
      sentence: selectedText,       // 书籍场景：上下文即选中文本
      selectedText,
      note,
      origin: "manual",
      color,
      style,
      type: type || (note && note.trim() ? "annotate" : "highlight"), // 缺省按有无 note 推断
      group: group || "未分组",
      scope: style === "highlight" ? "word" : "sentence",
      // 2026-09-03 双保险：记录媒体类型 + PDF 页码兜底（无 CFI 时跳转用）
      // 2026-09-04 P1：PDF 用 selInfo.index+1（= foliate 分节号）而非 pdfCurrentPage，
      // 与自建覆盖层 getContents() 遍历用的页码一致；并携带归一化矩形供覆盖层重绘。
      bookType: currentBookType(),
      page: isPdfBook() ? ((selInfo?.index ?? 0) + 1) : undefined,
      pdfRects: isPdfBook() ? (selInfo?.pdfRects ?? undefined) : undefined,
    };
    // 2026-09-05 R3 修复：upsert 是 async，此前漏 await 导致 created 是 Promise、
    // created.id 恒为 undefined（annByValue 存进假 id，靠 getByBook 宽松匹配兜底掩盖）。
    // 2026-10-13 P1-5：视觉先行——先启动 foliate 绘制（按 CFI 绘，不依赖落库 id），
    // upsert 并行落库。旧写法先 await 磁盘写完才画，保存 IO 的时延直接拖累
    // 「点标注 → 高亮出现」的反馈。函数返回前仍 await 落库完成：调用方
    //（onQuickAnnotate）依赖 annByValue 里已登记的真实 id 转 edit 态。
    const upsertP = annStore.upsert(input).then((created: any) => {
      // 2026-10-24：多段批注的**每一段**都要登记（点哪一段都能查到这条标注）。
      for (const c of allCfis) annByValue.set(c, { id: created.id, cfi: c, color });
      return created;
    });
    // 预先挂只读观察者：绘制 await 在途时若落库已失败，先抑制 Uncaught (in promise)
    // 噪音；失败本身仍在下方 await 处原样抛给调用方（保持「保存失败不弹成功 toast」语义）。
    upsertP.catch(() => { /* noop：见上方说明 */ });
    if (isPdfBook()) {
      // PDF 文本标注视觉全交自建覆盖层 PdfTextHlLayer（foliate 原生 addAnnotation 在 PDF 下不可靠，
      // 且会与覆盖层重叠画两次）。数据已落库，覆盖层经 annStore.subscribe 自动重绘。
      // R3：列表刷新/侧边栏广播也由 annStore.subscribe 单通道统一触发，此处不再手动调用。
      await upsertP;
      return;
    }
    // foliate 原生绘制：addAnnotation 内部 resolveNavigation + 找 overlayer + emit draw-annotation。
    // 若当前章节 overlay 已就绪立即画出；否则等 create-overlay 事件补绘（数据已落库，不回滚）。
    // id 取 annByValue 现值：upsert 若已抢先完成即为真实 id，否则 undefined
    //（addReaderAnnotation 内部不会把已登记的真实 id 覆盖成 undefined，见该函数 P1-5 注释）。
    try {
      await addReaderAnnotation({ ...input, id: annByValue.get(cfi)?.id });
    } catch (err) {
      console.warn("[REword] 绘制失败（批注数据已保存，高亮稍后由 create-overlay 补绘）:", err);
    }
    // 等落库完成（annByValue 登记真实 id）后再返回，保持调用方「保存完成」语义。
    await upsertP;
    // R3：列表刷新 + 侧边栏广播已由 annStore.subscribe 单通道触发，不再手动调用。
  }

  // 复制选中文本到剪贴板
  // 2026-10-08：改走 writeClipboard —— 旧写法在剪贴板不可用时
  // 可选链静默短路却仍弹「已复制」（用户以为成功、粘贴是空的）。
  async function onSelCopy() {
    const text = selToolbar.text?.trim();
    if (!text) return;
    closeSelToolbar();
    if (await writeClipboard(text)) toast(t("已复制"));
  }

  // 2026-08-30 微信读书式「一键标注」：点「标注」直接用上次用过的样式+颜色创建高亮。
  // 2026-10-11 微信读书行为（用户拍板 D3）：创建后**原地转 edit 态** ——
  //   样式行滑入、槽位 2 变「删除划线」，用户可顺手改样式/颜色或撤销，不必再点一次。
  //   反馈由「高亮本身 + 当前色 ✓ 徽章」承担，故去掉原「已高亮」toast。
  // 样式记忆（lastStyle/lastColor）由顶部 `$: persistLastStyle(...)` 统一防抖落盘。
  async function onQuickAnnotate() {
    if (selToolbar.mode === "edit") return;
    const cfi = selInfo?.cfi;
    const text = selToolbar.text?.trim();
    if (!cfi || !text) { toast(t("请先选中文本")); return; }
    await saveHighlight(cfi, text, lastStyle, lastColor, "");
    // saveHighlight 内部已把记录登记进 annByValue（草稿 id 也有效），故这里能直接取回 rec。
    // 取不到（存储不可用 / 无 bookId，saveHighlight 内已 toast）时退回关闭，不留一个死工具栏。
    const rec = annByValue.get(cfi);
    if (rec) openHighlightEditToolbar(rec, lastSelRect);
    else closeSelToolbar();
  }

  // edit 态「批注」按钮：打开该标注的查看气泡（时间 + 原文 + 批注 + 标签 + 即时改色/样式 + 复制/编辑/删除）。
  function onEditAnnotate() {
    if (selToolbar.mode !== "edit" || !selToolbar.annId) return;
    // 2026-08-25 机制级修复：关闭工具栏 + 抑制 selectionchange 重建
    selToolbar = { ...selToolbar, visible: false };
    suppressNextCreateToolbar = true;
    showViewerForRec({ id: selToolbar.annId, cfi: selToolbar.annCfi || "", color: selToolbar.annColor || "" }, lastSelRect);
  }

  // 「批注」按钮（create 模式）：打开统一批注浮层（mode='create'），文本预览 + 样式/颜色 + note 输入 + 取消/保存。
  // 浮层定位在选中文本**下方**（参考思阅插件），预填默认色、焦点落在输入框。
  function openNoteEditor() {
    cancelPendingClose(); // 打开批注窗 → 取消延迟关闭
    if (selToolbar.mode === "edit") return; // edit 模式由 ghost/删除处理
    // 2026-08-25 修复（机制级）：点创建工具栏「批注」→ 关闭工具栏 + 抑制重建。
    // 根因：click 关闭后，selectionchange 事件仍会触发 scheduleReadSelection → showToolbarFor
    //   重新创建工具栏（因为选区文本仍在）。必须同时设 suppressNextCreateToolbar
    //   阻止后续 showToolbarFor 执行，彻底切断重建链路。
    selToolbar = { ...selToolbar, visible: false };
    suppressNextCreateToolbar = true; // 阻止 selectionchange → showToolbarFor 重建
    const text = selToolbar.text?.trim();
    const cfi = selInfo?.cfi;
    if (!text || !cfi) { toast(t("请先选中文本")); return }
    // 定位：统一用 positionPopupNear（锚定选区末端 + 四向避让 + 边界夹紧）。
    // 优先用已保存的选区矩形（lastSelRect 已是选区末端 clientRect，跟手）；
    // 极端情况无 rect 时兜底用工具栏当前位置，保证弹窗一定出现。
    let ex = selToolbar.x, ey = selToolbar.y, place: ToolbarPlace = "below";
    if (lastSelRect) {
      // ⚠️ 高度值 2026-10-08 从 220 下调到 190（取消/保存并入工具条 + 删提示行，卡片矮约 30px）
      const pos = positionPopupNear(lastSelRect, NOTE_CARD_W, 190);
      ex = pos.x; ey = pos.y; place = pos.place;
    }
    noteEditor = {
      visible: true,
      x: ex,
      y: ey,
      mode: "create",
      id: null,
      cfi,
      text,
      style: lastStyle,
      color: lastColor,
      note: "",
      group: lastGroup,
      time: "",
      labels: [],
      styleLabel: t("直线"),
      place,
    };
  }

  // ⚠️ 2026-10-08 删除了 `onViewerEdit()`。
  // 原用途：查看态点「编辑」把 mode 从 view/preview 翻成 edit，切出「保存/取消」按钮。
  // 改版后**笔记正文在查看态就直接是可编辑的 textarea**，改完 blur 自动保存
  //（见 onNoteAutoSave），不再需要「先切态、再保存」这两步 ⇒ 该函数失去唯一调用方。
  // 原实现还有个隐藏 bug：条件里写着 `mode !== "view"`，而 "view" 从来不会被赋值
  //（见 noteEditor 声明处的死分支说明）。

  /**
   * 写剪贴板 + **如实反馈结果**（2026-10-08）。
   *
   *## 为什么不能直接 `navigator.clipboard?.writeText(x)`
   * 可选链 `?.` 在 `clipboard` 为 `undefined` 时**静默短路**：
   * 非安全上下文（`file://` / Electron 未授权）下 `navigator.clipboard` 就是 undefined
   * ⇒ 不抛错、不写盘，但旧代码仍然弹「已复制」。
   * 用户以为复制成功，粘贴出来是空的 —— 这是审计发现的「复制假成功」。
   *
   * ## 与 `onSelSend` 的口径对齐
   * `onSelSend` 早就有失败提示（「复制失败，请检查剪贴板权限」），
   * 但划词复制与批注复制/导出没有 ⇒ 同一个失败，两种表现。
   * 现在统一走这里。
   *
   * @returns 是否真的写成功（调用方据此决定弹什么 toast）
   */
  async function writeClipboard(text: string): Promise<boolean> {
    if (!text) return false;
    try {
      if (!navigator.clipboard?.writeText) {
        toast(t("复制失败，请检查浏览器剪贴板权限"));
        return false;
      }
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      logSwallow(e, "ReaderView.svelte · writeClipboard", "warn");
      toast(t("复制失败，请检查浏览器剪贴板权限"));
      return false;
    }
  }

  // 查看气泡「复制」：复制原文摘录
  async function onViewerCopy() {
    const text = (noteEditor.text || "").trim();
    if (!text) return;
    closeNoteEditor();
    if (await writeClipboard(text)) toast(t("已复制"));
  }

  // 查看气泡「导出」：将「原文 + 笔记」组合为 Markdown 复制到剪贴板（轻量导出，后续可接思源文档）
  async function onViewerExport() {
    const text = (noteEditor.text || "").trim();
    const note = (noteEditor.note || "").trim();
    const md = [text ? `> ${text}` : "", note ? note : ""].filter(Boolean).join("\n\n");
    if (!md) { toast(t("无内容可导出")); return; }
    if (await writeClipboard(md)) toast(t("已导出批注到剪贴板"));
  }

  /** 共享：软删除一条标注（视觉擦除 + 数据软删 + reconcile），供查看气泡与划词工具栏复用 */
  async function removeAnnotationById(id: string | null, cfi: string): Promise<void> {
    if (!annStore) { try { annStore = getAnnotationStore(); } catch { annStore = null; } }
    let delCfi = cfi ?? "";
    let delId = id ?? null;
    if (!delId && annStore && delCfi) {
      const byBook = annStore.getByBook(bookId || "");
      const nc = (s: string) => String(s || "").replace(/^epubcfi\(/i, "").replace(/\)+$/, "");
      const target = nc(delCfi);
      const found = byBook.find((it: any) => {
        const a = nc(it.cfi);
        return a === target || (a && (a.startsWith(target) || target.startsWith(a)));
      });
      if (found?.id) delId = found.id;
    }
    if (!delId) {
      if (delCfi) { await eraseAnnotationVisual(delCfi); annByValue.delete(delCfi); }
      // 2026-09-01：即使用户没拿到 id（视觉擦除后跳过数据软删），也要刷新摘录列表
      refreshAnnotsList();
      return;
    }
    const stored = annStore?.get(delId);
    if (stored) delCfi = stored.cfi ?? delCfi;
    if (annStore) await annStore.remove(delId);
    if (delCfi) { await eraseAnnotationVisual(delCfi); annByValue.delete(delCfi); }
    // R3：删除后的残留 reconcile + 列表刷新 + 侧边栏广播均由 annStore.subscribe 单通道触发；
    // 上面的 eraseAnnotationVisual 仅负责本条即时擦除（不等防抖窗口）。
    try {
      const contents = view?.renderer?.getContents?.() || [];
      for (const c of contents) {
        const win = c.doc?.defaultView;
        if (win) { const sel = win.getSelection(); if (sel) sel.removeAllRanges(); }
      }
    } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · nc", "debug"); }
  }

  // 查看态「删除」
  async function onViewerDelete() {
    const id = noteEditor.id;
    const cfi = noteEditor.cfi;
    closeNoteEditor();
    await removeAnnotationById(id, cfi);
    toast(t("已删除"));
  }

  // 统一批注浮层保存（create 新增 type='annotate'；edit 更新已有记录 id 存在）
  async function onNoteSave() {
    const { cfi, text, style, color, note, group, id } = noteEditor;
    if (!cfi || !text) { toast(t("请先选中文本")); return; }
    lastStyle = style; lastColor = color; lastGroup = group; // 同步偏好，供「高亮」复用
    const noteVal = note?.trim() || "";
    if (id) {
      // 更新已有标注：upsert(id) 就地更新 note/样式/颜色/类型
      if (!annStore) { try { annStore = getAnnotationStore(); } catch { annStore = null; } }
      if (!annStore) { toast(t("批注存储不可用")); return; }
      annStore.upsert({
        id,
        style,
        color,
        note: noteVal,
        group,
        type: noteVal ? "annotate" : "highlight",
      });
      // 重绘视觉：擦旧 → 画新（样式/颜色/笔记变化）
      if (!isPdfBook()) {
        // PDF 文本标注走自建覆盖层（PdfTextHlLayer），不调 foliate 原生管线，避免双重绘制
        await eraseAnnotationVisual(cfi);
        await addReaderAnnotation({ id, cfi, color, style, note: noteVal });
        annByValue.set(cfi, { id, cfi, color });
      }
      noteEditor = { ...noteEditor, visible: false, mode: "create", id: null };
      closeSelToolbar();
      toast(t("已更新批注"));
      // R3：列表刷新 + 侧边栏广播由 annStore.subscribe 单通道触发，不再手动调用
      //
      // 2026-10-08 **移除了这里的 onProtectTab?.()**（原注释写「固定阅读 Tab，避免被数量超限回收顶掉」）。
      // ## 为什么删
      // `tab.pin()` 的语义是「钉住」，思源对钉住页签的默认呈现是
      // **只显示图标、不显示标题，且不可关闭**（官方用户指南「页签(代码片段)」：
      // 「默认情况下，当页面设置图标后，钉住的页签只显示图标」；`Tab.pin()` 的类型定义
      // 写的就是"Pins the tab to prevent closing"）。
      // ⇒ 用户每保存一条批注，正在读的书页签就会**当场缩成一个图标并且关不掉**。
      //   这是**用户完全不知情、也没有任何开关可关**的副作用 —— 真机报障「莫名其妙的固定住了」。
      //
      // ## 为什么不需要它（防回收另有更温和的手段）
      // 「防思源把页签当无名空白 Tab 回收」这件事，`reader-tab.ts` 已经在开 Tab 时
      // 用 `custom.tab.updateTitle(书名)` 解决了（见该文件「2026-08-24 修复（问题3）」）。
      // 阅读Tab 是自定义 Tab，思源对它的回收判定本就不同于文档 Tab。
      // 为一个低概率风险换一个「每次批注后界面不可用」的代价，不成比例。
      //
      // `onProtectTab` 的 prop 与实现**保留在 reader-tab.ts**，将来若确有需要可重新接上。
    } else {
      await saveHighlight(cfi, text, style, color, noteVal, group, "annotate");
      noteEditor = { ...noteEditor, visible: false, mode: "create", id: null };
      closeSelToolbar();
      toast(t("已保存批注"));
      // 同上：此处原有的 onProtectTab?.() 已移除，理由见上方分支的注释。
    }
  }

  // 批注浮层：取消
  function onNoteCancel() {
    noteEditor = { ...noteEditor, visible: false, mode: "create", id: null };
    closeSelToolbar();
  }

  // 查看态：点色板颜色 → 即时改色（readest「颜色即分类」：不改笔记、不关卡片）
  async function applyViewerColor(color: string) {
    // 2026-08-26 放宽守卫：view 态与 highlight 态共用此即时改色逻辑（highlight 面板复用，避免重复代码）
    if (!noteEditor.id) return;
    lastColor = color;
    if (!annStore) { try { annStore = getAnnotationStore(); } catch { annStore = null; } }
    const cfi = noteEditor.cfi;
    if (annStore) annStore.upsert({ id: noteEditor.id, color });
    if (cfi) {
      // 2026-10-13 P0-1：与 applyEditColor 对齐——foliate addAnnotation 即「原子替换」
      // （resolveNavigation → overlayer.remove → 按新值重绘），单次调用即完成换色。
      // 旧写法先 eraseAnnotationVisual（两次全 overlay 遍历 + 可能触发核选项）再 add，
      // 两步之间必有一帧高亮消失——用户看到的就是「点完颜色，标注段闪一下」。
      await addReaderAnnotation({ id: noteEditor.id, cfi, color, style: noteEditor.style, note: noteEditor.note || "" });
      annByValue.set(cfi, { id: noteEditor.id, cfi, color });
    }
    noteEditor = { ...noteEditor, color };
    // R3：列表刷新 + 侧边栏广播由 annStore.subscribe 单通道触发
  }

  // 查看态/高亮态：点样式 → 即时改样式（与改色同理；highlight 面板复用）
  async function applyViewerStyle(style: AnnotationStyle) {
    if (!noteEditor.id) return;
    lastStyle = style;
    if (!annStore) { try { annStore = getAnnotationStore(); } catch { annStore = null; } }
    const cfi = noteEditor.cfi;
    if (annStore) annStore.upsert({ id: noteEditor.id, style });
    if (cfi) {
      // 2026-10-13 P0-1：同 applyViewerColor——单次 addAnnotation 原子替换，不先擦后画。
      await addReaderAnnotation({ id: noteEditor.id, cfi, color: noteEditor.color, style, note: noteEditor.note || "" });
      annByValue.set(cfi, { id: noteEditor.id, cfi, color: noteEditor.color });
    }
    noteEditor = { ...noteEditor, style };
    // R3：列表刷新 + 侧边栏广播由 annStore.subscribe 单通道触发
  }

  // edit 态样式条：点样式 → 即时改已有标注的样式（readest 编辑态：样式条常显在工具栏下方）。
  async function applyEditStyle(style: AnnotationStyle) {
    // 2026-08-25 根因修复：旧逻辑首行 `if (!annId) return`，但 onShowAnnotation 查不到记录
    // （CFI 与 annByValue/annStore 不匹配）时 annId 为 null → 整函数第二行就退出，
    // 样式永远改不了（用户反馈"线段/颜色样式一个都点不了"）。
    // foliate 以 CFI 标识标注，无需数据库 id 即可重绘，故改用 CFI 作为主定位键。
    const cfi = selToolbar.annCfi || selToolbar.ghostCfi || activeAnnCfi || "";
    dbg.snapshot("applyEditStyle", { visible: selToolbar.visible, mode: selToolbar.mode, annId: selToolbar.annId, annCfi: selToolbar.annCfi, ghostCfi: selToolbar.ghostCfi, resolvedCfi: cfi });
    if (!cfi) { console.warn("[REword] applyEditStyle: CFI 为空，无法定位标注"); toast("无法定位标注，请重试"); return; }
    const normCfi = (s: string) => String(s || "").replace(/^epubcfi\(/i, "").replace(/\)+$/, "");
    lastStyle = style;
    if (!annStore) { try { annStore = getAnnotationStore(); } catch { annStore = null; } }
    const color = selToolbar.annColor || lastColor;
    // 解析有效 id（用于持久化）：优先 annId；缺失时按 CFI 在 annStore 反查（兼容 annByValue 未命中场景）。
    let effId = selToolbar.annId || "";
    if (!effId && annStore && bookId) {
      const target = normCfi(cfi);
      const hit = (annStore.getByBook?.(bookId) ?? []).find((it: any) =>
        normCfi(it.cfi) === target ||
        (normCfi(it.cfi) && (normCfi(it.cfi).startsWith(target) || target.startsWith(normCfi(it.cfi))))
      );
      if (hit) effId = hit.id;
    }
    const note = (effId && annStore?.get(effId)?.note) || "";
    // 数据层：有 id 则 upsert 最新样式（无 id 的纯 ghost 仅改视觉，不持久化）。
    if (effId && annStore) {
      try {
        const existing = annStore.get(effId);
        if (existing) await annStore.upsert({ ...existing, style });
        else await annStore.upsert({ id: effId, cfi, style, color, bookId, bookType: currentBookType() });
      } catch (e) {
        console.error("[REword] applyEditStyle upsert 失败:", e);
      }
    }
    // 视觉更新：foliate addAnnotation 即「原子替换」——解析 CFI → overlayer.remove → 按新样式重绘。
    // 无需先 deleteAnnotation：单个 addAnnotation 调用即可完成替换（对标 readest / foliate 官方 view.js:427）。
    if (view) {
      try {
        await addReaderAnnotation({ id: effId, cfi, color, style, note });
        if (effId) annByValue.set(cfi, { id: effId, cfi, color });
        toast(t("样式已改为 {style}", { style: t(ANNOTATION_STYLES[style]?.label || style) }));
        dbg.step("applyEditStyle", "✅ 视觉更新成功（直接绘制）", { cfi, style, effId });
      } catch (e) {
        console.error("[REword] applyEditStyle 视觉更新失败:", e);
        toast(t("样式切换失败，请重试"));
        dbg.warn("applyEditStyle", "❌ 视觉更新失败", { cfi, style, err: String(e) });
      }
    } else {
      console.warn("[REword] applyEditStyle: view 不可用，仅更新数据层");
      if (effId) annByValue.set(cfi, { id: effId, cfi, color });
    }
    selToolbar = { ...selToolbar, annStyle: style, annId: effId || selToolbar.annId, annCfi: cfi };
    // R3：列表刷新 + 侧边栏广播由 annStore.subscribe 单通道触发
  }

  // edit 态样式条：点颜色 → 即时改已有标注的颜色。
  async function applyEditColor(color: string) {
    // 2026-08-25 同 applyEditStyle：CFI 为主定位键，不再依赖 annId（避免查不到记录时整函数 return）。
    const cfi = selToolbar.annCfi || selToolbar.ghostCfi || activeAnnCfi || "";
    dbg.snapshot("applyEditColor", { visible: selToolbar.visible, mode: selToolbar.mode, annId: selToolbar.annId, annCfi: selToolbar.annCfi, ghostCfi: selToolbar.ghostCfi, resolvedCfi: cfi });
    if (!cfi) { console.warn("[REword] applyEditColor: CFI 为空，无法定位标注"); toast("无法定位标注，请重试"); return; }
    const normCfi = (s: string) => String(s || "").replace(/^epubcfi\(/i, "").replace(/\)+$/, "");
    lastColor = color;
    if (!annStore) { try { annStore = getAnnotationStore(); } catch { annStore = null; } }
    const style = selToolbar.annStyle || lastStyle;
    let effId = selToolbar.annId || "";
    if (!effId && annStore && bookId) {
      const target = normCfi(cfi);
      const hit = (annStore.getByBook?.(bookId) ?? []).find((it: any) =>
        normCfi(it.cfi) === target ||
        (normCfi(it.cfi) && (normCfi(it.cfi).startsWith(target) || target.startsWith(normCfi(it.cfi))))
      );
      if (hit) effId = hit.id;
    }
    const note = (effId && annStore?.get(effId)?.note) || "";
    if (effId && annStore) {
      try {
        const existing = annStore.get(effId);
        if (existing) await annStore.upsert({ ...existing, color });
        else await annStore.upsert({ id: effId, cfi, style, color, bookId, bookType: currentBookType() });
      } catch (e) {
        console.error("[REword] applyEditColor upsert 失败:", e);
      }
    }
    // 视觉更新：单次 addAnnotation = foliate 原子替换（读 est/readest 一致做法）。
    if (view) {
      try {
        await addReaderAnnotation({ id: effId, cfi, color, style, note });
        if (effId) annByValue.set(cfi, { id: effId, cfi, color });
        toast(t("颜色已更改"));
        dbg.step("applyEditColor", "✅ 视觉更新成功（直接绘制）", { cfi, color, effId });
      } catch (e) {
        console.error("[REword] applyEditColor 视觉更新失败:", e);
        toast(t("颜色切换失败，请重试"));
        dbg.warn("applyEditColor", "❌ 视觉更新失败", { cfi, color, err: String(e) });
      }
    } else {
      console.warn("[REword] applyEditColor: view 不可用，仅更新数据层");
      if (effId) annByValue.set(cfi, { id: effId, cfi, color });
    }
    selToolbar = { ...selToolbar, annColor: color, annId: effId || selToolbar.annId, annCfi: cfi };
    // R3：列表刷新 + 侧边栏广播由 annStore.subscribe 单通道触发
  }

  // ============================================================
  // 2026-08-28：连续朗读（参考 Readest 朗读体验）
  // ============================================================

  /** 取当前已加载的内容文档（多节可见时拼接） */
  function getTtsDocs(): Document[] {
    try {
      const raw = (view?.renderer?.getContents?.() as any[]) || [];
      const mapped = raw.map((c) => c?.doc).filter(Boolean) as Document[];
      return mapped;
    } catch {
      return [];
    }
  }

  /** 从 iframe 文档取当前选区 Range（划词「朗读」用） */
  function getCurrentSelectionRange(): Range | null {
    for (const doc of getTtsDocs()) {
      const sel = (doc as any).getSelection?.();
      if (sel && sel.rangeCount > 0 && sel.toString().trim()) return sel.getRangeAt(0) as Range;
    }
    // 回退：主文档选区
    const sel = (typeof window !== "undefined" && window.getSelection?.());
    if (sel && sel.rangeCount > 0 && sel.toString().trim()) return sel.getRangeAt(0);
    return null;
  }

  /** 合并实时语速后的当前设置对象 */
  function ttsSettingsNow(): RewordTtsSettings {
    // Plugin 端的 TtsSettings 只是 RewordTtsSettings 的子集（缺 volume/granularity/scope/
    // enableHighlight/highlightStyle/highlightColor/autoPage/sleepTimerMin）。
    // 用 DEFAULT_REWORD_TTS 兜底合并，保证 Controller 拿到完整字段，
    // 否则 enableHighlight / autoPage / 睡眠定时等会全部失效。
    const raw = (getTtsSettings?.() as Partial<RewordTtsSettings> | null) || null;
    const s: RewordTtsSettings = { ...DEFAULT_REWORD_TTS, ...(raw || {}) };
    s.rate = ttsRate;
    return s;
  }

  /** 懒创建朗读控制器（挂载一次） */
  function ensureTtsController() {
    if (ttsController) { ttsController.setSettings(ttsSettingsNow()); return; }
    const settings = ttsSettingsNow();
    ttsRate = settings.rate;
    ttsController = new ReaderTtsController(getTtsDocs, settings, {
      onState: (st) => { ttsState = st; showTtsBar = st !== "idle"; },
      onProgress: (i, t) => { ttsProgress = { index: i, total: t }; },
      onSentence: (txt) => { ttsCurrentText = txt; },
      onNeedVisible: (range) => { try { view?.renderer?.scrollToAnchor?.(range, true); } catch { /* 忽略 */ } },
      onAutoPage: async () => {
        try { view?.goRight?.(); } catch { return false; }
        await new Promise((r) => setTimeout(r, 350));
        return true;
      },
      onError: (msg) => { try { toast(msg); } catch { /* 忽略 */ } },
      // 2026-10-14：主引擎不可用、回退到系统语音时提示，避免用户以为「换了引擎声音没变」。
      onFallback: (from, to) => {
        try { toast(`${from}暂时不可用，已改用${to}继续朗读`); } catch { /* 忽略 */ }
      },
    });
  }

  /** 划词工具栏「朗读」：从选区（或当前可视位置）开始连续朗读 */
  function onSelSpeak() {
    ensureTtsController();
    const range = getCurrentSelectionRange();
    if (ttsState !== "idle") ttsController?.stop();
    ttsController?.setSettings(ttsSettingsNow());
    void ttsController?.playFrom(range || undefined);
    closeSelToolbar();
  }

  /**
   * 词典卡片 🔊 /「朗读」按钮：一次性朗读。
   * 在播连续朗读时先停（保证听清目标词），不进连续朗读状态机、不显示控制条。
   */
  function speakDictOneShot(text: string) {
    const t = (text || "").trim();
    if (!t) return;
    ensureTtsController();
    if (ttsState !== "idle") ttsController?.stop();
    void ttsController?.speakOneShot(t);
  }

  /** 查词命中后的自动发音（词典管理页「自动发音」开关）；连续朗读中不打断 */
  function maybeAutoSpeakDictWord(headword: string) {
    if (!headword) return;
    let on = false;
    try { on = dictManagerRef?.prefs?.()?.autoSpeak === true; } catch { on = false; }
    if (!on) return;
    if (ttsController && ttsController.getState() !== "idle") return;
    speakDictOneShot(headword);
  }

  /** 控制条：播放/暂停切换（无选区则从当前位置开始） */
  function ttsTogglePlay() {
    ensureTtsController();
    ttsController?.setSettings(ttsSettingsNow());
    if (ttsState === "playing") ttsController?.pause();
    else if (ttsState === "paused") ttsController?.resume();
    else void ttsController?.playFrom(getCurrentSelectionRange() || undefined);
  }
  function ttsStop() { ttsController?.stop(); }
  function ttsNext() { ttsController?.next(); }
  function ttsPrev() { ttsController?.prev(); }
  function onTtsRateInput(e: Event) {
    const v = parseFloat((e.target as HTMLInputElement).value);
    if (isNaN(v)) return;
    ttsRate = v;
    ttsController?.setRate(v); // 即时生效，不打断当前朗读
    // 防抖持久化：直接写回设置（不调用 setSettings，避免重启朗读进度）
    ttsCfg = { ...ttsCfg, rate: v };
    if (rateSaveTimer) clearTimeout(rateSaveTimer);
    rateSaveTimer = setTimeout(() => {
      rateSaveTimer = null;
      void saveTtsSettings?.({ ...ttsCfg });
    }, 400);
  }
  function ttsToggleHighlight() {
    ensureTtsController();
    const s = ttsSettingsNow();
    s.enableHighlight = !s.enableHighlight;
    ttsHighlightOn = s.enableHighlight;
    ttsController?.setSettings(s);
    void saveTtsSettings?.(s);
  }
  /** 一键收词：提取当前句英文单词，去重后加入生词本（跳过已存在项） */
  function ttsCollectWords() {
    const txt = ttsCurrentText || "";
    const words = Array.from(
      new Set(
        (txt.match(/[A-Za-z][A-Za-z'-]*/g) || [])
          .map((w) => w.toLowerCase())
          .filter((w) => w.length >= 2)
      )
    );
    if (!words.length) { try { toast(t("当前句无可收藏的单词")); } catch { /* 忽略 */ } return; }
    let added = 0;
    let skipped = 0;
    for (const w of words) {
      try {
        if (isInVocab?.(w)) { skipped++; continue; }
        onAddToVocab?.(w);
        added++;
      } catch { /* 忽略单项失败 */ }
    }
    try {
      toast(t("已加入生词本 {n} 个{extra}", { n: added, extra: skipped ? t("（已存在 {n} 个跳过）", { n: skipped }) : "" }));
    } catch { /* 忽略 */ }
  }

  // ============================================================
  // 2026-08-28：朗读设置面板（14 项）处理函数
  // ============================================================
  function syncTtsCfg() {
    // 与 ttsSettingsNow 保持同样的缺字段合并策略（Plugin 端只存子集）
    const raw = (getTtsSettings?.() as Partial<RewordTtsSettings> | null) || null;
    const s: RewordTtsSettings = { ...DEFAULT_REWORD_TTS, ...(raw || {}) };
    ttsCfg = { ...s };
    ttsRate = s.rate;
    ttsHighlightOn = s.enableHighlight;
    loadTtsVoices(); // 打开设置面板时刷新本机可用嗓音列表
  }
  function saveTtsCfg() {
    ttsCfg = { ...ttsCfg };
    void saveTtsSettings?.({ ...ttsCfg });
    ttsController?.setSettings({ ...ttsCfg });
  }
  function setTtsField<K extends keyof RewordTtsSettings>(k: K, v: RewordTtsSettings[K]) {
    ttsCfg = { ...ttsCfg, [k]: v };
    saveTtsCfg();
  }
  function onTtsRateSetting(e: Event) {
    const v = parseFloat((e.currentTarget as HTMLInputElement).value);
    if (isNaN(v)) return;
    ttsRate = v;
    ttsController?.setRate(v); // 即时生效
    // 持久化（独立落盘，不经由 setTtsField 的 setSettings，避免打断朗读）
    ttsCfg = { ...ttsCfg, rate: v };
    if (rateSaveTimer) clearTimeout(rateSaveTimer);
    rateSaveTimer = setTimeout(() => {
      rateSaveTimer = null;
      void saveTtsSettings?.({ ...ttsCfg });
    }, 400);
  }
  function onTtsPitch(e: Event) { setTtsField("pitch", parseFloat((e.currentTarget as HTMLInputElement).value)); }
  function onTtsVolume(e: Event) { setTtsField("volume", parseFloat((e.currentTarget as HTMLInputElement).value)); }
  function onTtsInterval(e: Event) { setTtsField("interval", parseInt((e.currentTarget as HTMLInputElement).value, 10)); }
  function onTtsEngine(e: Event) { setTtsField("engine", (e.currentTarget as HTMLSelectElement).value as RewordTtsSettings["engine"]); }
  function onTtsAccent(e: Event) { setTtsField("accent", (e.currentTarget as HTMLSelectElement).value as "uk" | "us"); }
  function onTtsVoiceZh(e: Event) { setTtsField("preferVoiceURIZh", (e.currentTarget as HTMLSelectElement).value || undefined); }
  function onTtsVoiceEn(e: Event) { setTtsField("preferVoiceURIEn", (e.currentTarget as HTMLSelectElement).value || undefined); }
  function onTtsIflytekAppId(e: Event) { setTtsField("iflytekAppId", (e.currentTarget as HTMLInputElement).value.trim() || undefined); }
  function onTtsIflytekApiKey(e: Event) { setTtsField("iflytekApiKey", (e.currentTarget as HTMLInputElement).value.trim() || undefined); }
  function onTtsIflytekApiSecret(e: Event) { setTtsField("iflytekApiSecret", (e.currentTarget as HTMLInputElement).value.trim() || undefined); }
  function onTtsIflytekVoice(e: Event) { setTtsField("iflytekVoice", (e.currentTarget as HTMLSelectElement).value || "xiaoyan"); }
  function onTtsGranularity(e: Event) { setTtsField("granularity", (e.currentTarget as HTMLSelectElement).value as "sentence" | "word"); }
  function onTtsScope(e: Event) { setTtsField("scope", (e.currentTarget as HTMLSelectElement).value as "selection" | "section" | "book"); }
  function onTtsHighlightStyle(e: Event) { setTtsField("highlightStyle", (e.currentTarget as HTMLSelectElement).value as RewordTtsSettings["highlightStyle"]); }
  function onTtsHighlightColor(e: Event) { setTtsField("highlightColor", (e.currentTarget as HTMLInputElement).value); }
  function onTtsAutoPage(e: Event) { setTtsField("autoPage", (e.currentTarget as HTMLInputElement).checked); }
  function onTtsHighlightEnabled(e: Event) {
    const v = (e.currentTarget as HTMLInputElement).checked;
    ttsHighlightOn = v;
    setTtsField("enableHighlight", v);
  }
  function onTtsSleep(e: Event) { setTtsField("sleepTimerMin", parseInt((e.currentTarget as HTMLSelectElement).value, 10)); }

  // 翻译选中文本（2026-08-27 原行为：仅发 AI 精读面板；
  // 2026-08-27 晚 改：弹内联即译气泡，展示原文/译文，并保留「发 AI 精读」入口）
  /**
   * 划词工具栏「翻译」按钮（2026-08-27 重设计）：
   * 直接把选中文本拼上 AI 设置里的「翻译预置提示词」，发送并聚焦 AI 精读面板。
   * 不再弹内联即译卡片（内联卡片已移除，译文改为顶栏「双语」开关逐段注入）。
   */
  function onSelTranslate() {
    const text = selToolbar.text?.trim();
    closeSelToolbar();
    if (!text) return;
    if (onTranslateToAi) onTranslateToAi(text);
    else toast(t("翻译未配置：请先在 AI 设置中开启并填写 API"));
  }

  // ========== 2026-08-27 重设计：双语对照开关 ==========
  /** 双语整批失败 toast 冷却时间戳：避免滚动补译时反复弹 */
  let bilingualFailToastAt = 0;

  /**
   * 2026-08-31 Phase 3：段落级「用 AI 重译」。
   *
   * 走 `engine:"ai"` + `overwrite:true`：强制用 AI 重译这一段并覆盖缓存，
   * 于是下次翻到该段读到的就是重译后的译文（translateBatch 内部会写回缓存）。
   *
   * 与「前文上下文」的关系：单段重译也带 ctxBefore，保证与前后文译法一致。
   */
  async function redoWithAI(wrapEl: Element, sourceText: string): Promise<void> {
    if (!onTranslateBatch || !sourceText) return;
    const btn = wrapEl.querySelector(".reword-bilingual-ai-redo") as HTMLButtonElement | null;
    const textSpan = wrapEl.querySelector(".reword-bilingual-text");
    const prevLabel = btn ? btn.textContent : "";
    if (btn) {
      btn.disabled = true;
      btn.textContent = t("重译中…");
    }
    try {
      // 前文参考：取原文段落的前两个兄弟段落文本，保持译法一致
      const srcEl = wrapEl.previousElementSibling;
      const ctxParts: string[] = [];
      let cur = srcEl?.previousElementSibling ?? null;
      while (cur && ctxParts.length < 2) {
        const t = (cur.textContent || "").trim();
        if (t) ctxParts.unshift(t.length > 160 ? t.slice(0, 160) : t);
        cur = cur.previousElementSibling;
      }
      const ctx = ctxParts.length ? ctxParts.join("\n") : null;

      const res = await onTranslateBatch(
        [sourceText],
        "auto",
        settingsStore.get().bilingualTarget || "zh",
        [ctx],
        {
          title: meta?.title || title || undefined,
          author: meta?.author || undefined,
          language: meta?.language || undefined,
        },
        { engine: "ai", overwrite: true }
      );
      const tr = (res?.[0] || "").trim();
      if (!tr) {
        toast(t("AI 未返回译文，请稍后重试"), 2400, "error" as any);
        return;
      }

      // 更新译文 DOM（与 buildTranslationEl 同一套富文本规则）
      if (textSpan) {
        const { mdToHtml } = await import("../annotation/lute.ts");
        const looksLikeMarkdown =
          /^\s{0,3}[-*+]\s+\S/m.test(tr) ||
          /^\s{0,3}\d+\.\s+\S/m.test(tr) ||
          /\*\*[^*\n]+\*\*/.test(tr) ||
          /\n[ \t]*\n/.test(tr);
        if (looksLikeMarkdown) textSpan.innerHTML = mdToHtml(tr);
        else textSpan.textContent = tr;
      }

    } catch (e) {
      console.warn("[REword] 段落 AI 重译失败:", e);
      toast(t("AI 重译失败，请检查 AI 配置或稍后重试"), 2600, "error" as any);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = prevLabel || t("✨ AI 重译");
      }
    }
  }

  /** 懒创建双语注入句柄（仅一次） */
  /** 2026-08-31：把本书隐藏译文集合持久化到设置（bilingualHidden: bookId → 指纹数组） */
  function persistHidden(bid: string): void {
    const map = { ...(settingsStore.get().bilingualHidden || {}) } as Record<string, string[]>;
    map[bid] = [...bilingualHidden];
    settingsStore.update({ bilingualHidden: map });
  }

  /**
   * 取 foliate 当前已加载的内容文档数组（L1：内容适配）。
   *
   * 2026-08-28 致命修复：foliate 的 getContents() 返回的是
   * [{index, overlayer, doc}, ...]，真正的 Document 在 .doc 字段
   * （见 vendor/foliate-js/view.js:288/544/688 均以 { doc } 解构）。
   * 原代码直接把数组元素当 Document 用 → doc.querySelectorAll 抛
   * TypeError → injectAll 在收集段落阶段崩溃 → 译文全空、按钮却绿。
   *
   * 2026-09-05 R5：抽成组件级函数，供双语 handle 与「英文书籍识别」共用；
   * 这份映射写错会让整条双语链路静默失效，只能有一份实现。
   */
  function getContentDocs(): Document[] {
    try {
      const raw = (view?.renderer?.getContents?.() as any[]) || [];
      const mapped = raw.map((c) => c?.doc).filter(Boolean) as Document[];
      if (mapped.length === 0) {
        console.warn("[REword] 双语 getContents: 返回空文档数组", {
          hasView: !!view,
          hasRenderer: !!(view?.renderer),
          rawLength: raw.length,
          rawKeys: raw[0] ? Object.keys(raw[0]) : [],
        });
      } else {
        console.log(`[REword] 双语 getContents: ${raw.length} 个分节 → ${mapped.length} 个有效文档`);
      }
      return mapped;
    } catch (e) {
      console.error("[REword] 双语 getContents 异常:", e);
      return [];
    }
  }

  function ensureBilingualHandle(): BilingualHandle {
    if (bilingualHandle) return bilingualHandle;
    // 2026-08-31：载入本书已隐藏译文集合（关闭/重开双语后保持隐藏）
    bilingualHidden = new Set(settingsStore.get().bilingualHidden?.[bookId] || []);
    const target = settingsStore.get().bilingualTarget || "zh";
    bilingualHandle = createBilingualV2({
      bookId,
      // 2026-09-05 R5：映射逻辑已抽到 getContentDocs()，与「英文书籍识别」共用同一份实现
      getContents: getContentDocs,
      translateBatch: (texts, from, to, _bookId, ctx, meta, extra) =>
        onTranslateBatch ? onTranslateBatch(texts, from, to, ctx, meta, extra) : Promise.resolve([]),
      // 2026-08-30 详细翻译（回传 provider / fromCache）供成本与引擎统计；未提供时回落 translateBatch
      // 2026-08-30 修复：ctxBefore / meta 透传（之前被丢弃，AI 拿不到前文语境 + 专有名词一致性失效）
      translateBatchDetailed: (texts, from, to, _bookId, ctx, meta, extra) =>
        onTranslateBatchDetailed
          ? onTranslateBatchDetailed(texts, from, to, ctx, meta, extra)
          : (onTranslateBatch ? onTranslateBatch(texts, from, to, ctx, meta, extra).then((t) => ({
              texts: t,
              providers: t.map(() => null as string | null),
              fromCache: t.map(() => false),
            })) : Promise.resolve({ texts: [], providers: [], fromCache: [] })),
      // 2026-08-30 调试开关（读设置，即时生效；默认关闭以精简界面）
      debug: () => settingsStore.get().bilingualDebug ?? false,
      // 2026-08-30：整书预翻译弹窗精确计算待译数（查缓存命中）
      checkCached: (texts) =>
        onCheckCache ? onCheckCache(texts) : Promise.resolve(new Array(texts.length).fill(false)),
      to: target,
      // 2026-08-31 重新启用简洁版：译文风格（直译/简洁）实时读设置，下一轮注入即生效
      getMode: () => (settingsStore.get().bilingualStyle || "default") as "default" | "concise",
      // 2026-10-14 双语重设计：引擎收口为**腾讯机器翻译**单入口。
      // 原「翻译服务」下拉（bilingualEngine，含 auto/AI 兜底/五免费引擎）已随设置简化下架，
      // 这里固定透传 "tencent"，engine.ts 的 buildProviders 也只装配腾讯。
      getEngine: () => "tencent" as string,
      // 2026-08-30：书籍元数据（书名/作者/语言/目录）注入翻译 system prompt，
      // 提升专有名词与语境一致性；仅 Prompt 文本，零额外 AI 推理成本。
      bookMeta: () => ({
        title: meta?.title || title || undefined,
        author: meta?.author || undefined,
        language: meta?.language || undefined,
        // 目录可能很长，先截断到 1500 字符（buildTranslatePrompt 再截到 1200）
        toc: tocItems.length
          ? tocItems.map((t, i) => `${i + 1}. ${t.title}`).join("\n").slice(0, 1500)
          : undefined,
      }),
      // 2026-09-05 复活：预取分节数动态读设置（0–4 整数；渐进窗口 + 注入闸门共用）
      getPrefetchPages: () => settingsStore.get().bilingualPrefetchPages ?? 2,
      // 2026-09-05 新增：失败自动重试开关（关闭 = 失败段不进入退避重试）
      getRetryEnabled: () => settingsStore.get().bilingualRetry !== false,
      // R6：全书分节（full 预翻译做真全书枚举用）。foliate 的 book.sections
      // 每项自带 createDocument()，正好符合运行时要求的形状。
      getSections: () => {
        const secs = (view as any)?.book?.sections as any[] | undefined;
        if (!Array.isArray(secs)) return [];
        return secs.map((s, i) => ({
          index: typeof s?.index === "number" ? s.index : i,
          createDocument: () => s.createDocument(),
        }));
      },
      // R6：当前所在分节。foliate getContents() 的原始元素带 index 字段
      // （getContentDocs 已把它剥成纯 doc 数组，这里另取一次原始数组）。
      getCurrentSection: () => {
        const raw = (view as any)?.renderer?.getContents?.() as any[] | undefined;
        const idx = raw?.[0]?.index;
        return typeof idx === "number" && Number.isFinite(idx) ? idx : 0;
      },
      // 2026-10-14 双语重设计：段落级「✨ 用 AI 重译」入口下线——机翻单引擎下无 AI 可重译，
      // 按钮留着只会「点了没反应」。redoWithAI 等实现暂留（无害），仅关掉渲染入口。
      showAiRedo: false,
      onAiRedo: (wrapEl: Element, sourceText: string) => {
        void redoWithAI(wrapEl, sourceText);
      },
      // 2026-10-14：段落级「删除此段译文」入口随多模式一并下架（低频、且与专注对照的定位重叠）。
      showHideSegment: false,
      isSegmentHidden: (h: string) => bilingualHidden.has(h),
      onHideSegment: (bid: string, h: string) => {
        bilingualHidden.add(h);
        persistHidden(bid);
      },
      // 2026-08-28：每批翻译成功入缓存后，回传「节」序号（1-based）+ 书名，刷新「第 X-Y 页」统计
      onSectionsCached: (bid: string, sections: number[]) => {
        recordCachedSections?.(bid, sections, meta?.title || title || "");
        // 若当前查看的正是该书，立即刷新计数与书名列表
        if (!selectedCacheBookId || selectedCacheBookId === bid) {
          refreshCacheStats(bid);
        }
        refreshCacheBookList();
      },
      onProgress: (done, total) => {
        bilingualProgress = { done, total, active: done < total };
        // 2026-08-28 修复：整批翻译失败（total>0 且 done===0）明确告知用户，
        // 否则 AI 配置错误/网络/限流被静默吞掉、用户无感知。8 秒冷却防刷屏。
        if (total > 0 && done === 0 && Date.now() - bilingualFailToastAt > 8000) {
          bilingualFailToastAt = Date.now();
          toast(t("双语翻译失败：请检查「双语翻译 → 腾讯翻译凭据」的密钥与网络"), 3200, "error" as any);
        }
        if (done >= total) {
          setTimeout(() => {
            bilingualProgress = { ...bilingualProgress, active: false };
            // 翻译完成后读取累计 token 用量（由 index.ts 的 aiTranslateBatch 填充）
            const usage = getLastUsage?.() ?? null;
            if (usage && usage.totalTokens > 0) {
              bilingualTokenUsage = { ...usage };
            }
            // v1.3.0：同步刷新「本书 Token」累计显示
            refreshBookTokenUsage();
            // 2026-08-28：刷新「已缓存 N 段」统计（翻译后缓存条数会变）
            refreshCacheStats(selectedCacheBookId || bookId);
          }, 800);
        }
      },
      onTokenUsage: (usage) => {
        bilingualTokenUsage = { ...usage };
      },
    });
    return bilingualHandle;
  }

  /** 开启双语（前置检查引擎是否已配置） */
  function enableBilingual(): void {
    if (!isTranslationConfigured || isTranslationConfigured()) {
      ensureBilingualHandle().setEnabled(true);
      bilingualOn = true;
      refreshCacheStats(bookId);
      refreshCacheBookList();
    } else {
      toast(t("请先在「双语翻译 → 腾讯翻译凭据」中配置密钥"), 3200, "info" as any);
    }
  }

  /** 关闭双语（移除全部注入节点） */
  function disableBilingual(): void {
    // 2026-08-28 修复：先把 UI 状态置回 false，再调 handle。
    // 原顺序下若 setEnabled(false) 内部 removeAll() 抛异常（foliate 分节文档
    // 被部分销毁时可能抛 DOMException），会导致 bilingualOn 永远停在 true，
    // 按钮「关不掉」。现在即使 handle 失败，状态也已正确复位。
    bilingualOn = false;
    bilingualProgress = { done: 0, total: 0, active: false };
    bilingualTokenUsage = null;
    try {
      bilingualHandle?.setEnabled(false);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[REword] 关闭双语时移除注入失败（已忽略）:", e);
    }
  }

  /** 顶栏「双语」按钮：切换并持久化到阅读设置 */
  async function toggleBilingual(): Promise<void> {
    console.log("[REword] 双语按钮点击, 当前状态:", bilingualOn);
    getLogger().info(`[REword][双语] 按钮点击，当前 bilingualOn=${bilingualOn}，bookId=${bookId}`);
    try {
      if (bilingualOn) {
        disableBilingual();
        settingsStore.update({ bilingual: false });
        return;
      }
      // 2026-09-05 R5：双语只对英文书开放 —— 非英文书不进入切分 / 送译 / 注入链路，
      // 避免中文书白跑一遍翻译、白烧 token。判定顺序：元数据 dc:language 优先，
      // 缺失（TXT/MD/PDF 常没有）时采样正文；两者都无结论（unknown）则放行，
      // 宁可让用户自己试，也不误杀一本真英文书。
      const detection = detectBookLanguage({
        metaLanguage: meta?.language || undefined,
        sampleTexts: collectSampleTexts(getContentDocs(), { maxChars: 2000 }),
      });
      if (detection.verdict === "other") {
        getLogger().info(
          `[REword][双语] 非英文书籍，不开启双语：bookId=${bookId} source=${detection.source} conf=${detection.confidence}`,
        );
        toast(t("未识别为英文书籍，双语对照暂不可用"), 2600, "info" as any);
        return;
      }
      getLogger().info(
        `[REword][双语] 语言判定通过：bookId=${bookId} verdict=${detection.verdict} source=${detection.source} conf=${detection.confidence}`,
      );

      const configured = !isTranslationConfigured || isTranslationConfigured();
      console.log("[REword] 双语: 开启检查, isTranslationConfigured=", configured);
      if (!configured) {
        toast(t("请先在「双语翻译 → 腾讯翻译凭据」中配置密钥"), 3200, "info" as any);
        return;
      }
      // 2026-10-14 双语重设计：运行时收敛为**渐进式单模式**——边读边按需翻译、命中即本地缓存。
      // 原「整书预翻译 / 首次询问弹窗 / 按书记忆选法」随多模式一并下线（whole-book 后台整书译
      // 会一次性烧额度，与「只用免费腾讯机翻、轻量随读」的定位不符）。
      enableBilingual();
    } catch (e) {
      // 2026-08-28 防御：任何异常都不应锁死按钮状态
      console.warn("[REword] 双语切换异常:", e);
      bilingualOn = false;
      bilingualProgress = { done: 0, total: 0, active: false };
      settingsStore.update({ bilingual: false });
      toast(t("双语功能异常，请重试或重启插件"), 2500, "error" as any);
    }
  }



  /**
   * F11 全屏：整块阅读区进入浏览器全屏（Esc 由浏览器原生退出）。
   * reader-shortcuts.ts 的注册表里早就有 toggleFullscreen 这一项，
   * 但此前没有任何地方接它，键位等于空头支票。
   */
  function toggleFullscreen() {
    try {
      if (document.fullscreenElement) {
        void document.exitFullscreen?.();
      } else {
        void (readerViewEl as any)?.requestFullscreen?.();
      }
    } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · toggleFullscreen", "warn"); }
  }

  /**
   * 构造「回跳原书」深链（2026-08-29 新增，对齐 Obsidian weave 的双向溯源）。
   * 形如 siyuan://plugins/siyuan-plugin-reader?data={"bookId":"…","cfi":"…"}（2026-10-13 迁移到独立插件）
   *  - 思源点击该链接 → 派发 open-siyuan-url-plugin 事件（见 index.ts onOpenBookUrl）
   *    → 打开 / 聚焦该书阅读 Tab → goTo 到 CFI，精确定位回原文。
   *  - 同时符合思源自定义协议约定（<插件名><Tab 类型>），即使思源内核先按内置逻辑
   *    开了一次 Tab，也能带上 bookId 命中同一本书，不会产生空白页签。
   * @returns Markdown 链接；cfi/bookId 缺失时返回空串（模板里自然留空，不留死链）
   */
  /**
   * 深链纯 URL（不含 markdown 包装）。buildBookDeepLink 与矩形标注链接共用。
   * 2026-09-09 修复：矩形标注曾把 buildBookDeepLink 的 markdown 再包一层
   * `[标题]([回原文](siyuan://…))`，思源解析 href 截断成非法 URL → 点击报 Invalid URL。
   * 2026-09-09 修复（Tab 复用）：host 必须用**插件名**（siyuan-plugin-reader，2026-10-13 迁移）。
   * 此前用 Tab id（…-rewordreader）：思源 processSiYuanUri 找不到同名插件 →
   * 落到 models 分支 openFile **直接开新 Tab**（绕过 openBookTab 去重，cfi 被忽略
   * 不跳转）→ 表现为「不复用已有 Tab + 不定位」。改用插件名后思源只派发
   * open-siyuan-url-plugin 事件，由 index.ts onOpenBookUrl 接手（去重 + 跳转）。
   */
  function buildBookDeepLinkUrl(cfi: string): string {
    if (!cfi || !bookId) return "";
    try {
      const data = encodeURIComponent(JSON.stringify({ bookId, cfi }));
      return `siyuan://plugins/siyuan-plugin-reader?data=${data}`;
    } catch (__swallowErr) {
      logSwallow(__swallowErr, "ReaderView.svelte · buildBookDeepLinkUrl", "warn");
      return "";
    }
  }

  function buildBookDeepLink(cfi: string): string {
    const url = buildBookDeepLinkUrl(cfi);
    return url ? t("[回原文]({url})", { url }) : "";
  }

  /**
   * 笔记模板渲染（纯函数，2026-08-24 新增）
   * 把 linkFormat 模板里的 {{var}} 变量替换为实际值。
   * 未知变量保留原样（不抛错），便于模板编辑时即时预览。
   */
  function renderNoteTemplate(
    template: string,
    vars: {
      bookTitle?: string;
      author?: string;
      chapter?: string;
      cfi?: string;
      link?: string;
      text?: string;
      note?: string;
      image?: string;
      date?: string;
    }
  ): string {
    if (!template) return vars.text || "";
    return template.replace(/\{\{(\w+)\}\}/g, (m, name) => {
      const v = (vars as any)[name];
      return v === undefined || v === null ? m : String(v);
    });
  }

  // 发送选中文本（2026-08-24 增强：按 linkFormat 模板渲染 + 按 insertPosition 分发）
  // 2026-10-10 新增 doc 分支：发送到本书绑定的「笔记发送目标」文档（与摘录导出同一目标解析链）
  async function onSelSend() {
    const text = selToolbar.text?.trim();
    if (!text) return;
    // 2026-10-12 P1-A：锚点必须在关闭**之前**取。closeSelToolbar 现在会先播 140ms 收起动画
    // 才清 selInfo/activeAnn*，若照旧在关闭后读 selInfo?.cfi，模板里的 {{cfi}}/{{link}}
    // 就成了「靠动画时序才有值」的隐式依赖（动画一去掉就又变回空串）。
    const cfi = selInfo?.cfi || "";
    closeSelToolbar();
    const noteSettings = settings.note;
    const now = new Date();
    const ts = t("{m}月{d}日 {hh}:{mm}", { m: now.getMonth() + 1, d: now.getDate(), hh: String(now.getHours()).padStart(2, "0"), mm: String(now.getMinutes()).padStart(2, "0") });
    // 1. 渲染 markdown（按 linkFormat 模板，缺省时用 simple）
    const template = noteSettings.linkFormat || NOTE_TEMPLATE_PRESETS.simple.template;
    const md = renderNoteTemplate(template, {
      bookTitle: title || t("阅读"),
      author: bookAuthor || "",
      chapter: chapterLabel || "",
      cfi,
      // 2026-08-29：回跳原书的深链（此前恒为空串，模板里 {{link}} 永远渲染不出东西）
      link: buildBookDeepLink(cfi),
      text,
      note: "",
      image: "",
      date: now.toISOString().slice(0, 10),
    });
    // 2. 按 insertPosition 分发
    const pos = noteSettings.insertPosition;
    if (pos === "clipboard") {
      try {
        navigator.clipboard?.writeText(md);
        toast(t("已复制到剪贴板"));
      } catch {
        toast(t("复制失败，请检查浏览器剪贴板权限"));
      }
      return;
    }
    if (pos === "doc") {
      // 指定文档：per-book → 全局默认 → 导出时自动建档兜底（复用 exportAnnotsToDoc 同一条解析链）
      const resolved = await resolveExportTargetAsync(bookId, store.get(bookId), settings, store);
      const target = resolved.target;
      if (!target) {
        toast(t("请先设置本书的笔记发送目标：书架上右键这本书，或到「设置 → 笔记与摘录」"));
        return;
      }
      if (resolved.autoCreated) {
        toast(
          t("已自动建立《{doc}》并绑定为本书目标", {
            doc: String(store.get(bookId)?.title ?? "").trim() || target.docTitle || target.docId,
          }),
        );
      }
      const api = siyuanApiForPicker;
      if (!api?.appendBlock) {
        toast(t("思源接口未就绪，请稍后重试"));
        return;
      }
      // 写入前探活：区分「文档没了」与「写不进去」（同 exportAnnotsToDoc 的理由）
      const alive = await probeDoc(api, target.docId);
      if (alive === false) {
        toast(t("目标文档《{doc}》已被删除，请重新设置发送目标", { doc: describeTarget(target) }));
        return;
      }
      try {
        await api.appendBlock(target.docId, "markdown", md);
        toast(t("已发送到《{doc}》", { doc: describeTarget(target) }));
      } catch (__e) {
        logSwallow(__e, "ReaderView.svelte · onSelSend·doc", "warn");
        const why = __e instanceof Error ? __e.message : String(__e);
        toast(t("写入文档失败（{why}）", { why }));
      }
      return;
    }
    // 2026-10-10 收敛：发送位置仅剩「剪贴板」「指定文档」两档，其余分支已删除。
  }

  // 2026-08-24 重构（对标 Readest 删除模型）：删除 = 视觉擦除 + 数据软删除，两步独立。

  // 2026-08-24 重构（对标 Readest 删除模型）：
  // 删除 = 视觉擦除 + 数据软删除，两步独立、互不阻塞。
  //   - 视觉：view.addAnnotation(cfi, true) —— foliate 官方"擦除"语义（true 即删除），
  //           与 readest 的 `view.addAnnotation(existing, true)` 完全一致。
  //   - 数据：annStore.remove(id) —— 软删除（置 deletedAt），所有读取路径已过滤，
  //           翻页重绘（onCreateOverlay）时再过滤一次，残余高亮自动消失。
  // 不再做"是否真的删到"的自验证与多轨暴力兜底——那是 v5 反复失败的根源：
  // foliate 内部静默失败时误判成功会让兜底永远不跑；而 readest 的软删除 + 重绘过滤
  // 天然保证"最终一致"，无需验证。

  // 2026-08-26 退回 foliate 原生：删除即 foliate 的 deleteAnnotation（= addAnnotation(ann, true)），
  // 内部 resolveNavigation(cfi) → 找该分节 overlayer → overlayer.remove(value)。
  // 兜底：若 foliate 静默失败（fixed-layout 页码错位等），用 eraseOverlayKey 遍历所有
  // 已渲染 overlay（foliate 原生 overlayer）按宽松 CFI 匹配强制移除，确保视觉消失。
  async function eraseAnnotationVisual(cfi: string): Promise<boolean> {
    if (!view || !cfi) return false;
    console.log("[REword] eraseAnnotationVisual 开始, cfi=", cfi);
    // 1) foliate 原生删除
    try {
      await view.deleteAnnotation({ value: cfi, color: "", style: "highlight", note: "" });
    } catch (e) {
      console.warn("[REword] foliate deleteAnnotation 抛错:", e);
    }
    // 2) 兜底：按 key 遍历所有已渲染 overlay（foliate 原生）强制移除（宽松 CFI 匹配）
    const removed = eraseOverlayKey(view, cfi);
    const still = hasOverlayKey(view, cfi);
    console.log("[REword] eraseOverlayKey 移除数=", removed, ", 残留=", still);
    if (removed > 0 || !still) {
      console.log("[REword] 删除成功（步骤2）");
      return true;
    }
    // 3) 核选项：清空全部 overlay SVG + 触发重绘（完全不依赖 CFI 匹配）
    console.log("[REword] 步骤2失败，启动核选项 nukeAndRedrawOverlays");
    const nuked = nukeAndRedrawOverlays(view);
    console.log("[REword] 核选项清除 overlay 数=", nuked);
    return nuked > 0;
  }

  /** 清除「残留高亮」（数据层已无记录，仅剩视觉）。兜底分支（onShowAnnotation !rec）的删除出口。 */
  async function onClearGhostHighlight() {
    // 2026-08-24 根治：优先用独立缓存 activeAnnCfi（onShowAnnotation ghost 分支已缓存）
    const cfi = activeAnnCfi ?? selToolbar.ghostCfi ?? "";
    if (!cfi) {
      closeSelToolbar();
      return;
    }
    await eraseAnnotationVisual(cfi);
    // 全量 reconcile 兜底：数据中已无该 cfi，残留必然被清
    if (annStore && bookId) syncVisualWithStore(view, annStore, bookId);
    annByValue.delete(cfi);
    closeSelToolbar();
    toast(t("已清除残留高亮"));
  }

  // 划词工具栏 edit 模式：点击「删除」按钮立即移除该标注并重置界面（P0 B2：删除时清 selInfo，
  // 避免带着已删标注的锚点；统一走 closeSelToolbar 关样式条）。另提供 3 秒内「撤销」（见 P2 O4）。
  async function onAnnDeleteById() {
    // 2026-08-24 根治：优先用独立缓存 activeAnnId（不受 selToolbar.editingId 被重置影响）
    let id = activeAnnId ?? selToolbar?.editingId ?? null;
    console.log("[REword] onAnnDeleteById 开始, id=", id, ", editingId=", selToolbar?.editingId, ", activeAnnId=", activeAnnId, ", activeAnnCfi=", activeAnnCfi);

    // 2026-08-24 兜底：若 id 仍为空但有 CFI，按 CFI 在 annStore 中反查记录取真实 id
    if ((!id || id === "undefined") && annStore && activeAnnCfi) {
      const byBook = annStore.getByBook(bookId || "");
      const nc = (s: string) => String(s || "").replace(/^epubcfi\(/i, "").replace(/\)+$/, "");
      const target = nc(activeAnnCfi);
      const found = byBook.find((it: any) => {
        const a = nc(it.cfi);
        return a === target || (a && (a.startsWith(target) || target.startsWith(a)));
      });
      if (found?.id) {
        id = found.id;
        console.log("[REword] onAnnDeleteById CFI反查成功: id=", id, ", cfi=", activeAnnCfi);
      }
    }

    if (!id || !annStore) {
      // 即使没有 store id，只要有 cfi 就尝试清除视觉高亮（纯视觉残留场景）
      const fallbackCfi = activeAnnCfi ?? selInfo?.cfi ?? "";
      if (fallbackCfi) {
        console.log("[REword] onAnnDeleteById 无store id，尝试纯视觉清除: cfi=", fallbackCfi);
        await eraseAnnotationVisual(fallbackCfi);
        syncVisualWithStore(view, annStore, bookId || "");
        annByValue.delete(fallbackCfi);
        closeSelToolbar();
        toast(t("已删除"));  // 纯视觉清除成功，高亮已消失
        return;
      }
      // 既无 id 也无 cfi：真正无法定位目标
      closeSelToolbar();
      toast(t("未找到标注记录"));
      return;
    }
    // 取目标记录：优先 annStore.get(id)；缺失时经 edit 工具栏锚点（selInfo.cfi）
    // 与 annByValue 兜底反查，确保删除一定命中正确记录。
    let stored = annStore.get(id);
    let cfi = stored?.cfi ?? activeAnnCfi ?? "";
    if (!stored || !cfi) {
      const fallbackCfi = selInfo?.cfi ?? "";
      if (fallbackCfi) {
        const hit = annStore.getByBook(bookId).find((it: any) => it.cfi === fallbackCfi);
        if (hit) { stored = annStore.get(hit.id); cfi = hit.cfi; }
      }
      if ((!stored || !cfi) && fallbackCfi && annByValue.has(fallbackCfi)) {
        const rec = annByValue.get(fallbackCfi)!;
        cfi = rec.cfi;
        if (rec.id) stored = annStore.get(rec.id) ?? stored;
      }
    }
    if (!stored) {
      console.log("[REword] 删除: stored 未找到, id=", id, ", 兜底 cfi=", cfi);
      // 记录层面已缺失：至少清掉 foliate 高亮与映射，避免"数据无但看得见"
      if (cfi) {
        await eraseAnnotationVisual(cfi);
        annByValue.delete(cfi);
      }
      closeSelToolbar();
      toast(t("标注记录已不存在，已清理高亮"));
      return;
    }
    // 缓存用于撤销（软删除后数据仍在，撤销只清 deletedAt）
    const removed = {
      id: stored.id,
      cfi,
      style: (stored?.style as AnnotationStyle) || "highlight",
      color: stored?.color || WHALE_COLORS[2].value,
      note: stored?.note ?? "",
      selectedText: stored?.selectedText ?? "",
      group: stored?.group ?? "未分组",
    };
    // 数据软删除（对标 Readest：置 deletedAt，读取路径自动过滤）
    console.log("[REword] 删除: 找到记录, id=", stored.id, ", cfi=", cfi);
    await annStore.remove(stored.id);
    // 视觉擦除：foliate 官方"擦除"语义（true = 删除）+ 按 key 强制移除兜底。
    // 2026-08-24 根治：不再依赖 foliate 返回值，eraseAnnotationVisual 内部会
    // 用 eraseOverlayKey 遍历所有已渲染 overlay 移除；再全量 reconcile 一次，
    // 保证"数据已软删的 cfi 在当前页视觉上一定消失"（覆盖 key 写法差异/多 view/fixed-layout）。
    if (cfi) {
      await eraseAnnotationVisual(cfi);
      annByValue.delete(cfi);
    }
    if (annStore) syncVisualWithStore(view, annStore, bookId);
    // 清除选区，让界面恢复到未选中、无标注的常规状态
    try {
      const contents = view?.renderer?.getContents?.() || [];
      for (const c of contents) {
        const doc = c.doc;
        const win = doc?.defaultView;
        if (win) {
          const sel = win.getSelection();
          if (sel) sel.removeAllRanges();
        }
      }
    } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · try { const contents = view?.renderer?.getContents?.() || []; f…", "debug"); }
    closeSelToolbar();
    armUndoFor(removed);
  }

  /**
   * 2026-09-09 C：删除撤销统一窗口（矩形 / 文本标注 / 摘录共用）。
   * 软删后的记录进 pendingDelete，3 秒内可撤销（Cmd/Ctrl+Z 或右键「撤销删除」）。
   * 矩形快照图片延迟到窗口结束才真正清理——撤销成功则图片保留，
   * 避免此前「撤销了但 assets 里的图已被删」的不可逆问题。
   */
  function armUndoFor(rec: any) {
    // 无记录（数据层已缺失）时仍需给用户删除反馈，只是没有可撤销对象
    if (!rec?.id) { toast(t("已删除")); return; }
    pendingDelete = rec;
    if (undoTimer) clearTimeout(undoTimer);
    undoTimer = setTimeout(() => {
      const p: any = pendingDelete;
      pendingDelete = null;
      if (p?.snapshotPath) {
        try { void removeFile(`/data/${p.snapshotPath}`); }
        catch (e) { console.warn("[REword] 清理矩形快照失败:", e); }
      }
    }, 3000);
    toastWithUndo(t("已删除"));
  }

  /** 2026-09-09 C：覆盖层删除矩形后的回调（数据已软删，此处只登记撤销窗口） */
  function onRectDeleted(annId: string) {
    if (!annId) return;
    if (!annStore) { try { annStore = getAnnotationStore(); } catch { annStore = null; } }
    const rec = annStore?.get?.(annId) ? { ...annStore.get(annId) } : { id: annId };
    armUndoFor(rec);
  }

  /** 撤销刚删除的标注（清掉软删除时间戳，数据重新生效并重建高亮） */
  async function undoDelete() {
    if (!pendingDelete || !annStore) return;
    const r = pendingDelete;
    pendingDelete = null;
    if (undoTimer) clearTimeout(undoTimer);
    try {
      // 1) 清软删除标记，恢复数据活跃
      annStore.restore(r.id);
      // 2) 重建视觉高亮（foliate 原生：addAnnotation 解析 CFI 并重绘）
      if (r.cfi) {
        await addReaderAnnotation({ id: r.id, cfi: r.cfi, color: r.color, style: r.style, note: r.note || "" });
        annByValue.set(r.cfi, { id: r.id, cfi: r.cfi, color: r.color });
      }
      toast(t("已撤销"));
    } catch (err) {
      console.warn("[REword] 撤销删除失败:", err);
      toast(t("撤销失败"));
    }
  }


  // 卡片内「相似词候选」可点击二次查词
  function onDictBodyClick(e: MouseEvent) {
    const rawTarget = e.target as HTMLElement;
    // 用 closest 向上查找带 data-action 的祖先（点到按钮内部 span/文字时仍能命中）
    const target = (rawTarget.closest("[data-action]") as HTMLElement) || rawTarget;
    const action = target.dataset.action;
    const word = target.dataset.text || target.dataset.word;

    // ── 朗读（例句行 🔊 / 词头「朗读」按钮）：走阅读器自己的 TTS 控制器 ──
    if (action === "tts" && word) {
      speakDictOneShot(word);
      return;
    }

    // ── 加入/移出词库 ★ ──
    if (action === "vocab-star") {
      const w = (target.getAttribute("data-word") || "").trim();
      if (w) {
        const on = target.classList.contains("star-on");
        if (on) {
          onRemoveFromVocab?.(w);
          target.classList.remove("star-on");
          target.textContent = "☆";
          target.title = t("加入词库");
        } else {
          onAddToVocab?.(w);
          target.classList.add("star-on");
          target.textContent = "★";
          target.title = t("移出词库");
        }
      }
      return;
    }

    // ── 候选词再查 / 变形还原·相关词跳转（同一路径：就地重查该词） ──
    if ((action === "lookup-candidate" || action === "dict-jump") && word) {
      runDictLookup(word, { x: dictPopup.x, y: dictPopup.y, source: (dictPopupSource as any) ?? "hover" });
      return;
    }

    // ── 2026-09-07 双源：🌐 切换在线词海 / 离线，就地重查当前词 ──
    if (action === "dict-switch-online" || action === "dict-switch-offline") {
      const want = action === "dict-switch-online" ? "online" : "offline";
      // setDictMode 自带在线总闸：被关时回落到离线 ⇒ 这里返回 false
      const changed = setDictMode(want);
      if (!changed && want === "online") {
        toast(t("在线词典已关闭，可在设置 → 语言 → 词典里开启"));
        return;
      }
      // keepMode：切换后重查**不能**被「对齐设置默认源」覆盖回去
      const w = dictPopup.word;
      if (w) runDictLookup(w, { x: dictPopup.x, y: dictPopup.y, source: (dictPopupSource as any) ?? "hover", keepMode: true });
      return;
    }

    // ── 2026-09-07 简化小窗卡：🔍 送侧边栏查词典（详细释义） ──
    if (action === "lookup-in-sidebar") {
      sendToSidebar();
      return;
    }

    // ── 词性区块折叠/展开 ──
    if (action === "toggle-pos") {
      const block = target.closest(".hiword-vb-pos-block") as HTMLElement | null;
      if (block) togglePosCollapsed(block);
      return;
    }

    // ── 释义/词组 section 折叠/展开 ──
    if (action === "toggle-section") {
      const sec = target.closest(".hiword-detail-section") as HTMLElement | null;
      if (sec) sec.classList.toggle("hiword-detail-sec-collapsed");
      return;
    }

    // ──「查看全部 N 个义项」展开/收起 ──
    if (action === "toggle-senses") {
      const full = target.nextElementSibling as HTMLElement | null;
      if (full && full.classList.contains("hiword-dict-senses-full")) {
        const willShow = full.hidden;
        full.hidden = !willShow;
        target.classList.toggle("hiword-dict-senses-open", willShow);
        const arrow = target.querySelector(".hiword-dict-senses-toggle-arrow");
        if (arrow) arrow.textContent = willShow ? "▴" : "▾";
        // 展开全量时隐藏初始 4 条，收起时恢复
        const initial = target.parentElement?.querySelector(".hiword-dict-senses-initial") as HTMLElement | null;
        if (initial) initial.hidden = willShow;
      }
      return;
    }

    // ── 义项内例句展开/收起 ──
    if (action === "toggle-examples") {
      const moreContainer = target.closest(".hiword-dict-sense-ex-more");
      const rest = moreContainer?.querySelector(".hiword-dict-sense-ex-rest") as HTMLElement | null;
      if (moreContainer && rest) {
        const willShow = rest.hidden;
        rest.hidden = !willShow;
        const exCount = moreContainer.querySelectorAll(".hiword-dict-sense-ex-row").length;
        target.innerHTML = `<span class="hiword-dict-sense-toggle-arrow">${willShow ? "▴" : "▾"}</span> ${willShow ? t("收起例句") : t("展开 {n} 条例句", { n: Math.max(0, exCount - 1) })}`;
      }
      return;
    }
  }

  function closeDictPopup() {
    dictPopupSource = null;
    dictPopup = { ...dictPopup, visible: false };
  }

  /** 将当前弹窗单词发送到 REword 侧边栏查词（自动填入输入框并查询，不关闭阅读弹窗）；
   *  带上小窗当前源（online/offline），侧边栏面板跟随，避免「小窗在线、面板离线」不一致 */
  function sendToSidebar() {
    const w = (dictPopup.word || hoverWord || "").trim();
    if (w && onOpenInSidebar) onOpenInSidebar(w, dictPopupMode);
  }

  // 2026-08-27：悬浮弹窗——光标进入/离开时的收起控制
  function onDictPopupEnter() {
    clearHoverHide();
  }
  function onDictPopupLeave() {
    if (dictPopupSource === "hover") scheduleHoverHide();
  }

  // 订阅阅读设置：设置变更（含其它已开 Tab）即自动重刷样式，
  // 根除"设置不生效 / 多 Tab 样式漂移 / 启动异步竞态用默认设置打开"
  let unsubSettings: (() => void) | undefined;
  // 2026-08-24：dock 批注面板等"旁路删除"广播 → 本 ReaderView 全量 reconcile，
  // 保证当前页被删高亮立即消失（不依赖翻页重绘）
  let unsubAnnChanged: (() => void) | undefined;
  // 2026-09-01：annStore 数据订阅(任何 upsert/remove/load 都自动刷新「本书摘录」面板)
  let unsubAnnStore: (() => void) | undefined;
  /** 标记是否已订阅 annStore(避免重复订阅) */
  let annStoreSubscribed = false;
  // 2026-09-04 P0-3：inkStrokes 订阅——笔触新增/删除时同步刷新合并列表
  // （inkStrokes 是全局 Svelte store，多个 ReaderView Tab 共享同一份数据）
  let unsubInkStrokes: (() => void) | undefined;
  // R3 刷新单通道：数据变更后的 EPUB 视觉 reconcile 定时器（防抖合并连续写操作）
  let annReconcileTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 2026-10-13 P0-3：刚由交互路径直接绘制的 cfi 抢占标记（带时间戳）。
   * 背景：saveHighlight / applyEdit* 直接调 addReaderAnnotation 画一条，同时 upsert 的
   * subscribe 会在 60ms 后跑 scheduleAnnVisualReconcile 全量扫描 + 补绘。两条路径前后脚
   * 命中同一条 CFI 时，foliate 的 addAnnotation 内部是 remove 再 add，视觉上就是
   * 「画了→删→再画」的闪烁——尤其直接绘制还在 await 在途、hasOverlayKey 尚探测不到时，
   * reconcile 会立刻补第二刀。解法：直接绘制前先标记，reconcile 的补绘探测对窗口内的
   * cfi 直接跳过（它确实刚被画过；真画失败时 addReaderAnnotation 的 catch 会收回标记，
   * 兜底补绘逻辑不变）。
   */
  const RECENT_DRAW_GRACE_MS = 1000;
  const recentDirectDraws = new Map<string, number>();
  function markDirectDrawn(cfi: string): void {
    // 防御性体积上限：正常规模远小于此，超限时顺手清掉已过期的旧条目
    if (recentDirectDraws.size > 200) {
      const now = Date.now();
      for (const [k, t] of recentDirectDraws) if (now - t > RECENT_DRAW_GRACE_MS) recentDirectDraws.delete(k);
    }
    recentDirectDraws.set(cfi, Date.now());
  }
  function isRecentDirectDrawn(cfi: string): boolean {
    const t = recentDirectDraws.get(cfi);
    if (t == null) return false;
    if (Date.now() - t > RECENT_DRAW_GRACE_MS) { recentDirectDraws.delete(cfi); return false; }
    return true;
  }

  /**
   * R3 刷新单通道（数据 → 视觉唯一入口）：由 annStore.subscribe 触发（防抖）。
   *  - 残留清理：syncVisualWithStore 强制移除「数据中已不存在/已软删」的 overlay；
   *  - 缺失补绘：活跃但未绘制（hasOverlayKey=false）的条目 → addReaderAnnotation；
   *  - PDF 不走此路径：PdfTextHlLayer 自带 annStore.subscribe 自绘，避免双重绘制；
   *  - 编辑态的样式/颜色原子替换仍由各编辑函数就地完成（foliate addAnnotation 语义），
   *    reconcile 只兜底创建/删除/旁路变更三类场景；
   *  - 2026-10-13 P0-3：补绘探测对「刚被交互路径直接绘制」的 cfi 跳过（宽限 1s），
   *    消除直接绘制与 reconcile 补绘的双轨竞态。
   */
  function scheduleAnnVisualReconcile() {
    if (isPdfBook()) return;
    if (annReconcileTimer != null) clearTimeout(annReconcileTimer);
    annReconcileTimer = setTimeout(() => {
      annReconcileTimer = null;
      if (!annStore || !bookId || !view) return;
      try {
        syncVisualWithStore(view, annStore, bookId);
        const active = (annStore.getByBook(bookId) || []).filter((it: any) => it.cfi && !it.deletedAt);
        for (const it of missingDrawItems(active, (cfi) => isRecentDirectDrawn(cfi) || hasOverlayKey(view, cfi))) {
          void addReaderAnnotation(it);
        }
      } catch (err) {
        console.warn("[REword] 批注视觉 reconcile 失败:", err);
      }
    }, 60);
  }
  /**
   * 2026-10-13 P1-4：annotsList 刷新的 rAF 合并队列。
   * 背景：annStore.subscribe 回调跑在 upsert 的**同一同步栈**里，其中 refreshAnnotsList
   * 要 getByBook 全量 + 过滤 + 排序 + 墨迹合并——同步跑完才轮到 saveHighlight 继续绘制，
   * 「点标注」的视觉反馈被拖卡。改到下一帧：数据真源是 annStore，晚一帧拉取不影响正确性；
   * 同帧内的多次写操作合并为一次刷新（连续创建/删除时不重复重渲染）。
   */
  let annotsListRefreshQueued = false;
  function queueAnnotsListRefresh() {
    if (annotsListRefreshQueued) return;
    annotsListRefreshQueued = true;
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        annotsListRefreshQueued = false;
        if (!isDestroyed) refreshAnnotsList();
      });
    } else {
      // 无 rAF 的环境（单测/Node）退化同步执行，仅放弃合并
      annotsListRefreshQueued = false;
      refreshAnnotsList();
    }
  }

  /** annStore 单例可能晚于 onMount 才注入(插件初始化时序),需要延迟订阅 */
  function ensureAnnStoreSubscription() {
    if (annStoreSubscribed) return;
    let store: any = null;
    try { store = getAnnotationStore(); } catch { store = null; }
    if (!store) return;
    annStore = store; // 顺手捕获(让 refreshAnnotsList 后续调用不必再 try/catch)
    annStoreSubscribed = true;
    unsubAnnStore = store.subscribe(() => {
      // R3 刷新单通道：任何写操作 → 列表刷新 + 侧边栏广播 + EPUB 视觉 reconcile。
      // 此前各 mutation 路径手动重复调用前两者（双通道易漂移），现统一收口到这里。
      // 2026-10-13 P1-4：列表刷新移出写操作同步栈（rAF 合并），治「点标注先卡一下」。
      queueAnnotsListRefresh();
      dispatchAnnotationChanged();
      scheduleAnnVisualReconcile();
    });
    // 订阅成功后立即拉一次(此时 store 已就绪,annStore 变量也同步了)
    refreshAnnotsList();
    refreshBookmarks();
  }
  onMount(() => {
    unsubSettings = settingsStore.subscribe((s) => {
      // 2026-10-06：组件销毁后 DOM 已卸载，此处任何 DOM 读取都可能抛 undefined 错，
      // 而订阅回调是**同步**被 store.set 触发的 —— 抛出的异常会冒泡进 Svelte 的
      // update 栈，把整棵组件树销毁（用户表现为「点设置 Tab 面板瞬间关闭」）。
      // 双重保险：isDestroyed 提前返回 + applyStyles 自身已有 catch。
      if (isDestroyed) return;
      try {
        settings = s;
        applyContainerBg();
        if (view) applyStyles();
      } catch (e) {
        logSwallow(e, "ReaderView.svelte · unsubSettings", "warn");
      }
      // 2026-08-27：双语状态从设置一次性恢复（仅首次订阅时）。
      // 2026-09-05 F3：不再直接 enableBilingual —— onMount 时 view/meta 尚未就绪，
      // 语言判定必然 unknown 而放行，非英文书重启后会绕过门槛直接进双语。
      // 改为挂起标记，等书籍内容加载完（load 事件）再跑 detectBookLanguage 复核。
      if (!bilingualInitDone) {
        bilingualInitDone = true;
        if (s.bilingual) bilingualPendingRestore = true;
      }
    });
    unsubAnnChanged = subscribeAnnotationsChanged((bid) => {
      if (bid === bookId && view) syncVisualWithStore(view, annStore, bookId);
    });
    // 2026-09-04 P0-3：订阅 inkStrokes，笔触变化时立即刷新合并列表
    // （inkStrokes 是全局 store，加订阅时已含盘上数据，无需额外 load 等待）
    unsubInkStrokes = inkStrokes.subscribe(() => {
      refreshAnnotsList();
    });
    // 2026-09-01：先尝试订阅(可能 annStore 已就绪);否则起一个轮询兜底
    ensureAnnStoreSubscription();
    if (!annStoreSubscribed) {
      const t = setInterval(() => {
        if (annStoreSubscribed) { clearInterval(t); return; }
        ensureAnnStoreSubscription();
      }, 200);
      // 5 秒后放弃(避免无限轮询)
      setTimeout(() => clearInterval(t), 5000);
    }
    // load() 解析后推送最新设置，订阅回调自动 applyStyles（view 就绪时）
    startTimer();
    // 计时器配套：容器级活跃信号 + 窗口可见性（四道闸门见 startTimer 上方注释）
    bindTimerActivity();
    document.addEventListener("visibilitychange", onTimerVisibilityChange);
    // 先等待设置/字体加载完成再开书：用用户真实主题打开，避免打开瞬间用默认主题、iframe 透明导致的黑底/错主题闪屏
    void (async () => {
      await Promise.all([settingsStore.load(), fontStore.load()]);
      refreshFonts();
      applyContainerBg();
      // 2026-08-31 Phase 2：恢复译文归档配置。
      // SQLite 层持有模块级 docId，插件重启后需据此重新装配，否则归档不生效。
      void (async () => {
        try {
          const { ensureTranslationArchiveDoc } = await import("../translate/sqlite-cache.ts");
          const s = settingsStore.get();
          if (s?.translationArchiveEnabled) {
            await ensureTranslationArchiveDoc(
              () => s.translationArchiveDocId || "",
              async (id: string) => {
                settings = settingsStore.update({ translationArchiveDocId: id });
              }
            );
          }
        } catch (__swallowErr) {
          console.warn("[REword] 恢复译文归档配置失败:", __swallowErr);
        }
      })();
      // 2026-09-08 启动卡死修复（启动闸门）：
      // 思源布局恢复会直接重建阅读 Tab（早于 restoreSession 的空闲保护），
      // onMount 自动开书必须自己等空闲窗口，否则 25MB 级大书会在启动最密集期
      // （布局恢复 + 词典解析 + 文档 protyle 渲染并发）冻结主线程（2026-09-08 15:06 实录）。
      // 上次启动卡死（launchCrashed）时禁止自动开书：断「恢复→卡死→再恢复」自锁。
      if (launchCrashed) {
        pausedByCrash = true;
      } else {
        await waitForLaunchIdle();
        await openBook();
      }
      // 2026-08-28：打开书后刷新翻译缓存统计 + 有缓存的书籍列表（默认查看本书）
      refreshCacheStats(bookId);
      refreshCacheBookList();
    })();
    // 2026-08-23 修复：mousedown 监听绑到 readerViewEl 容器（不是 document），
    //   避免影响思源顶栏"管理"等原生 UI 的点击时序（用户在阅读 Tab 时点不动"管理"）。
    //   监听范围严格限定在 .reader-view 内部（toolbar / popover / foliate 内容），
    //   reader-view 外部的点击（思源命令面板、dock、顶栏 Tab 切换）完全不触发。
    if (readerViewEl) {
      readerViewEl.addEventListener("mousedown", onContainerMouseDown);
      // [REword patch 2026-08-29] Phase 3 Apple Pencil 墨迹批注
      // pointer 监听绑到 readerViewEl（不在 iframe doc 内，main 文档级）
      // 拦截 pen / touch pointer 用于墨迹绘制（仅 PDF + ink 模式）
      readerViewEl.addEventListener("pointerdown", onInkPointerDown);
      readerViewEl.addEventListener("pointermove", onInkPointerMove);
      readerViewEl.addEventListener("pointerup", onInkPointerUp);
      readerViewEl.addEventListener("pointercancel", onInkPointerUp);
    }
    // [REword patch 2026-08-29] PDF ⌘/Ctrl+滚轮缩放（页面四周留白区）延迟到 openBook 里、
    // 确认是 PDF 之后再绑（bindStageWheel）：非 PDF 不挂 passive:false 的 wheel，
    // 避免拖累 EPUB 的滚轮滚动性能。页面本体的监听在 attachContentDoc。
    // [REword patch 2026-08-29] 移动端 PDF 适配 Phase 1
    // 设备分级检测 + resize 监听（横竖屏切换时更新设备类）
    deviceClass = getDeviceClass();
    isIphoneMode = isSmallMobile();
    // 2026-10-25 P0-1：常驻侧边栏偏好（停靠开关 + 宽度）
    loadSidebarPrefs();
    // 2026-10-25 搜索增强：模式 + 历史（localStorage）
    loadSearchUiPrefs();
    if (typeof window !== "undefined") {
      window.addEventListener("resize", onDeviceClassResize);
      window.addEventListener("orientationchange", onDeviceClassResize);
    }
    if (typeof document !== "undefined") {
      document.addEventListener("selectionchange", onMainSelectionChange);
      // 2026-08-29 修复：方向键翻页失效
      // 在 main document 上 capture 阶段注册 keydown，
      // 不管焦点在 reader-view / iframe / 工具栏 / 批注 / 搜索框，方向键都能稳定翻页。
      // onGlobalKey 内部跳过 input/textarea/contenteditable 保留原生行为。
      document.addEventListener("keydown", onGlobalKey, true);
      // 2026-10-10：把本组件的 showShortcutHint toggle 注册到顶层。
      // BookshelfView 注册时会被覆盖（同 keydown 上同 toggle 互斥）；
      // 视图销毁时 unbindHint 会让 BookshelfView 接管。
      disposeHintBind = bindGlobalShortcutHint((force) => {
        showShortcutHint = force ?? !showShortcutHint;
      });
      // 2026-08-29 双击缩放：PDF 上双击切换 fit-width ↔ 上次缩放
    // 也注册到 main document capture 阶段（iframe 内的 dblclick 也会冒泡）
    document.addEventListener("dblclick", onDblClickToggleZoom, true);
      // 2026-08-29：点击脚注气泡外部（reader UI 空白区）关闭
      document.addEventListener("pointerdown", onFootnoteOutsidePointerDown as EventListener, true);
      // 2026-10-26：主文档也压制浏览器原生 contextmenu 菜单。
      // 场景：长按**插件自己的**划词工具栏按钮时，Android Chrome 同样会弹出
      // 原生「复制/粘贴」浮条，压在工具栏上。内容文档（iframe）那条见 attachContentDoc。
      // 只在移动端前端生效；桌面右键菜单保留。
      if (shouldSuppressNativeMenu({ mobile: isMobile() })) {
        document.addEventListener("contextmenu", nativeMenuGuardHandler as EventListener, true);
      }
    }
    // 2026-10-07 修「深色模式重载后不跟随」（用户实测：重载后不跟随，
    //   需手动 深色→浅色→再切深色 才生效）。
    //   根因：`siyuanThemeMode` 初值写死 "light"，而此前 subscribeThemeChange
    //   **只加订阅、不立即回调** ⇒ 挂载时永远读到初值。
    //   这里是双保险：即使 theme-bridge 将来改动，这里也保证初值正确。
    siyuanThemeMode = detectSiyuanTheme();
    // 跟随思源主题（2026-08-25 新增）
    // 2026-09-01：接入全局主题同步总线（L3 theme-bridge），替代本地 MutationObserver。
    // 思源切换主题时：applyStyles 重刷 --b3-* 桥接块（bg/fg/链接/代码/译文色），
    // applyStyles 末尾的 syncContentIframes 把内容 iframe 同步进 theme-bridge 注册表，
    // 由 theme-bridge 统一重注 --hw-* 令牌，使译文/批注 UI 跟随外观。
    themeChangeUnsub = subscribeThemeChange(() => {
      // 2026-10-07：切换瞬间容器已换色、书页还没换（setStyles 跨帧生效）→ 闪一下。
      // 先用「旧明暗」上过桥接色，等新样式落地再平滑过渡（见 bridgeThemeTransition）。
      bridgeThemeTransition();
      siyuanThemeMode = detectSiyuanTheme();
      applyStyles();
    });
    // 2026-08-28：初始化连续朗读控制器
    ensureTtsController();
    // 2026-09-02 性能修复：跨 frame console 钩子改为按需作用域观察。
    // 只在阅读器挂载期间观察本组件容器，卸载即释放；避免插件在 document.body
    // 上常驻 subtree MutationObserver 拖累整个思源的 DOM 性能。
    setConsoleFilterRoot(readerViewEl ?? null);
  });

  /**
   * 2026-09-01：bookId 变化(切到另一本书)时,重新拉取摘录 + 书签 + 标注视觉。
   * 用 reactive `$:` 触发,Svelte 静态分析可追踪 bookId 变化。
   */
  $: if (bookId && annStore) {
    refreshAnnotsList();
    refreshBookmarks();
    if (view) syncVisualWithStore(view, annStore, bookId);
  }

  onDestroy(() => {
    isDestroyed = true; // 2026-10-06：阻断销毁后的 settings 订阅回调
    if (unsubSettings) unsubSettings();
    if (unsubAnnChanged) unsubAnnChanged();
    // 2026-09-01：注销 annStore 订阅(避免组件销毁后回调仍被触发)
    if (unsubAnnStore) unsubAnnStore();
    // 2026-09-04 P0-3：注销 inkStrokes 订阅（避免组件销毁后回调仍被触发）
    if (unsubInkStrokes) unsubInkStrokes();
    // R3：注销后取消挂起的视觉 reconcile（防抖窗口内的定时器不能再触发已销毁组件）
    if (annReconcileTimer != null) { clearTimeout(annReconcileTimer); annReconcileTimer = null; }
    // 2026-09-09 修复：关闭时立即落盘挂起的进度（此前只 clearTimeout 直接丢弃，
    // 连续快速翻页后立即关闭 → 最后位置从未写盘 → 恢复落后几页）
    void flushProgressSave();
    if (selReadTimer) clearTimeout(selReadTimer);
    // 2026-10-14 P1：取消挂起的实时手柄刷新帧（组件销毁后不能再写状态）。
    if (selHandleLiveRaf) { cancelAnimationFrame(selHandleLiveRaf); selHandleLiveRaf = 0; }
    // 2026-10-12 P1-A：收起动画的到点卸载定时器，组件销毁后不能再跑（回调会写已卸载组件的状态）
    cancelSelToolbarOut();
    if (timeTimer) clearInterval(timeTimer);
    if (attachTimer1) clearTimeout(attachTimer1);
    if (attachTimer2) clearTimeout(attachTimer2);
    if (turnTimer) clearTimeout(turnTimer);
    if (turnInterval) clearInterval(turnInterval);
    if (toastTimer) clearTimeout(toastTimer);
    if (undoTimer) clearTimeout(undoTimer);
    if (hoverHideTimer) clearTimeout(hoverHideTimer);
    // v1.3.0：本书上下文编辑器销毁 + 落盘未保存内容
    flushPrimerSave();
    destroyPrimerEditor();
    // 2026-08-27：双语注入句柄销毁（移除全部译文节点，零残留）
    try { bilingualHandle?.destroy(); } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · try { bilingualHandle?.destroy(); }", "debug"); }
    bilingualHandle = null;
    // 2026-09-12 计时器四闸门：落盘余量 + 注销活跃/可见性监听（flushReadingTime 用
    // curDayKey 归桶，跨零点时已按旧日期结算过，口径一致）
    flushReadingTime();
    unbindTimerActivity();
    document.removeEventListener("visibilitychange", onTimerVisibilityChange);
    // 2026-08-23 修复：listener 绑在 readerViewEl（不是 document）
    if (readerViewEl) {
      readerViewEl.removeEventListener("mousedown", onContainerMouseDown);
      // [REword patch 2026-08-29] Phase 3 注销 ink pointer 监听
      readerViewEl.removeEventListener("pointerdown", onInkPointerDown);
      readerViewEl.removeEventListener("pointermove", onInkPointerMove);
      readerViewEl.removeEventListener("pointerup", onInkPointerUp);
      readerViewEl.removeEventListener("pointercancel", onInkPointerUp);
    }
    // [REword patch 2026-08-29] 移动端 PDF 适配 Phase 1
    if (typeof window !== "undefined") {
      window.removeEventListener("resize", onDeviceClassResize);
      window.removeEventListener("orientationchange", onDeviceClassResize);
    }
    // 2026-08-30：清理 resize 重排防抖定时器
    if (readerRelayoutTimer) clearTimeout(readerRelayoutTimer);
    if (typeof document !== "undefined") {
      document.removeEventListener("selectionchange", onMainSelectionChange);
      // 2026-09-05：清掉选区读取的 rAF 节流句柄（组件销毁后回调不该再跑）
      if (selReadRaf != null) {
        if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(selReadRaf);
        selReadRaf = null;
      }
      // 2026-08-29 修复：注销 main document capture 阶段 keydown 监听
      document.removeEventListener("keydown", onGlobalKey, true);
      // 2026-10-10：注销顶层提示面板 toggle 绑定（让 BookshelfView 接管）
      try { disposeHintBind?.(); } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · onDestroy · disposeHintBind", "debug"); }
      disposeHintBind = null;
      // 注销双击缩放
      document.removeEventListener("dblclick", onDblClickToggleZoom, true);
      // 注销脚注气泡外部点击关闭
      document.removeEventListener("pointerdown", onFootnoteOutsidePointerDown as EventListener, true);
      // 2026-10-26：注销主文档原生菜单压制（与 onMount 的注册对称）
      document.removeEventListener("contextmenu", nativeMenuGuardHandler as EventListener, true);
    }
    // [REword patch 2026-08-29] 注销 PDF 滚轮缩放（页面四周留白）+ 清掉落盘防抖定时器
    if (stageWheelBound && readerViewEl) {
      // 第三个参数必须传 capture:true 才能移除捕获阶段的监听（与 bindStageWheel 对称）
      readerViewEl.removeEventListener("wheel", onStageWheel as EventListener, true);
      stageWheelBound = false;
    }
    if (zoomSaveTimer) { clearTimeout(zoomSaveTimer); zoomSaveTimer = null; }
    // 注销 PDF 滚轮缩放累积的 rAF（组件销毁后回调不该再跑）
    if (wheelRafId != null) {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(wheelRafId);
      wheelRafId = null;
    }
    wheelAccumDy = 0;
    // 滚动模式缩放预览：清提交定时器；若仍停在预览态，必须复位 foliate 的 #pinching，
    // 否则 #scheduleScrollPages 会永久 return，页面加载/回收全部停摆。
    if (wheelCommitTimer) { clearTimeout(wheelCommitTimer); wheelCommitTimer = null; }
    if (wheelPinchActive) {
      wheelPinchActive = false;
      wheelPinchRatio = 1;
      try {
        (view?.renderer as any)?.pinchEnd?.();
      } catch (__swallowErr) {
        logSwallow(__swallowErr, "ReaderView.svelte · pinchEnd cleanup", "debug");
      }
    }
    // 停止思源主题跟随（2026-08-25 新增）并注销内容 iframe 注册表（避免悬空引用）
    themeChangeUnsub?.();
    themeChangeUnsub = null;
    for (const f of contentIframes) unregisterIframe(f);
    contentIframes.clear();
    // 2026-08-24 修复：卸载 foliate view 事件 + 内容文档监听 + 清除搜索高亮，
    // 避免反复进出阅读 Tab 造成的事件泄漏/悬空回调（P0 #1/#2）与残留搜索高亮干扰 hitTest（P1 #7）。
    teardownAnnotationLayer();
    detachAllContentDocs();
    try { view?.clearSearch?.(); } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · try { view?.clearSearch?.(); }", "debug"); }
    // 2026-09-05：PDF 必须显式销毁。foliate 的 view.close() 只销毁 renderer，
    // **不会**调用 book.destroy()，导致 pdf.js 的 loadingTask / worker 线程 / 每页 blob URL
    // 全部泄漏（每开关一次 PDF 泄漏一份）。必须在 close() 之前调用（close 后 book 已不可用）。
    try {
      (view?.book as any)?.destroy?.();
    } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · book.destroy", "debug"); }
    try {
      view?.close?.();
    } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · try { view?.close?.(); }", "debug"); }
    // 2026-08-28：朗读控制器清理（停止朗读 + 移除临时高亮，零残留）
    try { ttsController?.dispose(); } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · ttsController.dispose", "debug"); }
    ttsController = null;
    // 2026-09-02：释放跨 frame console 钩子的观察器（与 onMount 的 setConsoleFilterRoot 对称）
    try { setConsoleFilterRoot(null); } catch (__swallowErr) { logSwallow(__swallowErr, "ReaderView.svelte · setConsoleFilterRoot(null)", "debug"); }
    view = null;
  });
</script>

<!--
  🔴 `data-view-transition-root` 是给 foliate 的分层翻页（滑动 / 卷页）用的，
  别当成无用属性删掉。

  foliate 在开始分层翻页时会找这个标记来决定「动画的快照边界」
  （`paginator.js:2587`）：
  ```js
  namedHost = namedHost.closest('[data-view-transition-root]') ?? namedHost
  namedHost.style.viewTransitionName = 'foliate-turn'
  ```
  标在哪个元素上，**那个元素及其子树**会一起被拍成快照、参与动画。
  标在最外层 shadow host 上时，页眉页脚（`.reader-stage` 的兄弟节点）
  不会跟着动；标在 `.reader-view` 上，整块阅读区一起翻 —— 视觉上更连贯。

  对齐 Readest `BooksGrid.tsx:195`（它标在 grid cell 上，
  HeaderBar / FooterBar 作为兄弟节点一起进快照）。

  注意：`.reader-view` 内还有浮层（顶栏 / 底栏 / 划词工具栏 / 弹窗），
  它们是 position:absolute 的定位层，翻页时被拍进快照。
  这是 Readest 的既定行为（它的工具栏同样在 grid cell 内），
  故不做特殊处理。
-->
<div
  class="reader-view"
  bind:this={readerViewEl}
  on:mousemove={onReaderMouseMove}
  on:mouseleave={onReaderLeave}
  data-view-transition-root=""
  class:re-phone={viewportBp === "phone"}
  class:re-large-phone={viewportBp === "largePhone"}
  class:re-tablet={viewportBp === "tablet"}
  class:sidebar-docked={anyDockPanel()}
  style="--re-sidebar-w:{sidebarWidth}px"
>
  <!-- 2026-10-08 顶栏浮层化：脱离文档流、浮在正文上方。
       · class:reader-toolbar-floating —— 悬浮模式（topBarFloating，默认开）
       · class:reader-toolbar-revealed —— 浮起态（收起态见 CSS的 translateY + opacity）
       · class:reader-toolbar-hidden —— **仅** topBarFloating=false 的旧行为（display:none）
       · bind:this —— 供 getContentBounds() 取真实底沿做划词工具栏避让
       · mouseenter/leave —— 维持已浮起的栏（否则移开鼠标栏就消失、按钮点不到） -->
  <div
    class="reader-toolbar"
    data-dismiss-ignore
    class:reader-toolbar-floating={isTopBarFloating()}
    class:reader-toolbar-revealed={isTopBarFloating() && topBarRevealed}
    class:reader-toolbar-hidden={!isTopBarFloating() && !toolbarVisible}
    class:reader-toolbar-iphone={isIphoneMode}
    bind:this={topBarEl}
    on:mouseenter={() => { if (isTopBarFloating()) { topBarBarHover = true; updateTopBarReveal(); } }}
    on:mouseleave={() => { if (isTopBarFloating()) { topBarBarHover = false; updateTopBarReveal(); } }}
  >
    <!-- 左：3 个抽屉触发器（目录 / 书签 / 摘录） + 返回键 -->
    <div class="reader-toolbar-left">
      <button
        class="reader-btn"
        title={mobileOverlay ? t("返回书架") : (onCloseTab ? t("关闭阅读（书架在侧边栏）") : t("返回书架"))}
        on:click={() => (mobileOverlay ? onBack?.() : (onCloseTab ? onCloseTab() : onBack?.()))}
      >‹</button>
      <button
        class="reader-btn reader-drawer-anchor"
        data-drawer-anchor="toc"
        title={t("目录（点空白收起，再点收起）")}
        class:reader-btn-active={showToc}
        on:click={() => toggleDrawer("toc")}
      >☰</button>
      <button
        class="reader-btn reader-drawer-anchor"
        data-drawer-anchor="marks"
        title={t("我的标记（书签 + 摘录，点空白收起）")}
        class:reader-btn-active={showMarks}
        on:click={() => toggleDrawer("marks")}
      >📝</button>
      {#if readerMode === "pdf"}
        <!-- 2026-09-09 P1：矩形框选（图表/排版块 → 跳转链接 + 图片快照） -->
        <button
          class="reader-btn"
          title={t("矩形框选：框选图表区域，自动复制跳转链接 + 截图，粘贴到文档即可；右键点矩形可换色/删除；Esc 退出")}
          class:reader-btn-active={pdfRectMode}
          on:click={togglePdfRectMode}
        >⬚</button>
      {/if}
    </div>
    <!-- 中：书名 + 章节（真正居中）。
         2026-08-30 改造：① 移除死按钮 .reader-back-inline（display:none 且无任何引用）
         ② 章节名与书名相同时不再重复渲染（此前会出现「人间词话 人间词话」）
         ③ 进度百分比移到右侧工具组，避免挤占居中区 -->
    <div class="reader-toolbar-title">
      <span class="reader-title" title={title} style="user-select:text;cursor:text">{title}</span>
      {#if chapterLabel && chapterLabel !== title}
        <span class="reader-title-sep">·</span>
        <span class="reader-chapter" title={chapterLabel} style="user-select:text;cursor:text">{chapterLabel}</span>
      {/if}
    </div>
    <!-- 右：进度 + 双语 / 设置 / 搜索 / PDF 缩放。
         2026-10-24 移动端适配 Phase 2.1：isCompactToolbar（手机 / ≤600px 窄视口）时
         收敛为「进度 + ⋯」，双语/设置/搜索进溢出菜单（more-menu 块）。
         旧实现按 isIphoneMode 整组隐藏且无替代入口 → 手机上进不了设置/搜索（已修）。
         PDF 缩放/页码组两种模式都保留（缩放/翻页是刚需，见 PdfToolbar）。 -->
    <div class="reader-toolbar-right">
      <span class="reader-progress" title={t("阅读进度")}>{progressText}</span>
      {#if !isCompactToolbar}
        <!-- 2026-10-14 地基重构：双语对照依赖向可重排 DOM 注入译文，仅 reflow 内容适用。
             由能力表 caps.reflow 门控（PDF 位图=false、漫画图片=false 均隐藏；EPUB/TXT=true）。
             此前用 readerMode !== "pdf" 判定，会误对漫画(CBZ)也显示双语入口。 -->
        {#if caps.reflow}
          <BookToolbar
            bilingualOn={bilingualOn}
            bilingualActive={bilingualProgress.active}
            bilingualDone={bilingualProgress.done}
            bilingualTotal={bilingualProgress.total}
            promptTokens={bilingualTokenUsage?.promptTokens ?? null}
            completionTokens={bilingualTokenUsage?.completionTokens ?? null}
            totalTokens={bilingualTokenUsage?.totalTokens ?? null}
            onToggleBilingual={toggleBilingual}
            onOpenBilingualSettings={openBilingualSettingsPanel}
          />
        {/if}
        <!-- 图书与 PDF 共用：设置 + 搜索 -->
        <button
          class="reader-btn reader-settings-btn"
          title={t("设置")}
          class:reader-btn-active={showSettings}
          on:click={toggleSettings}
        >⚙</button>
        <button
          class="reader-btn"
          title={t("搜索全书（F3 / ⌘F）")}
          class:reader-btn-active={showSearch}
          on:click={toggleSearch}
        >🔍</button>
      {:else}
        <!-- 紧凑顶栏：双语/设置/搜索收进 ⋯（按钮 44×44 命中区由 .reader-toolbar-iphone /
             (pointer:coarse) 规则放大） -->
        <button
          class="reader-btn reader-more-btn"
          title={t("更多")}
          aria-label={t("更多")}
          aria-expanded={showMoreMenu}
          class:reader-btn-active={showMoreMenu}
          on:click={toggleMoreMenu}
        >⋯</button>
      {/if}
      <!-- [REword 2026-09-02] PDF 界面专属：缩放 + 页码。iPhone 模式下也保留（缩放/翻页是刚需） -->
      {#if readerMode === "pdf"}
        <PdfToolbar
          zoomLabel={zoomPercentLabel()}
          pdfCurrentPage={pdfCurrentPage}
          pdfTotalPages={pdfTotalPages}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
          onFitWidth={fitWidth}
          onFitPage={fitPage}
          onGoPage={goPdfPage}
          onPageInputKeydown={onPageInputKeydown}
          onPageInputChange={onPageInputChange}
        />
      {/if}
    </div>
  </div>

  <!-- 2026-10-08 · 顶栏「把手」：常驻顶部中央的小圆点（对标底栏 .reader-bottom-handle）。
       收起态贴顶显示圆点；展开态被顶栏顶到下方中央，再次点击收起。
       ⚠️ 命中区高度由 CSS 的 --reword-top-hit-h 夹到「不越过正文顶边」
       （Readest #4977/#5427：触发区压过第一行会吞掉那里的划词与点击）。 -->
  {#if isTopBarFloating()}
  <button
    class="reader-top-handle"
    class:reader-top-handle-revealed={topBarRevealed}
    title={topBarRevealed ? t("点击收起顶栏") : t("点击展开顶栏")}
    on:click={toggleTopBarPin}
    data-dismiss-ignore
  >
    <span class="reader-top-handle-dot"></span>
  </button>
  {/if}

  {#if cornerHint}
    <!-- 2026-10-25 角落自动翻页 L 形进度条（Readest PageTurnHint 复刻）：
         两条 3px 圆角条沿武装角的两侧边缘，随 500ms 驻留线性长满（grown 下一帧触发），
         翻页瞬 turned 态 120ms 提亮一闪；pointer-events:none 不挡交互。 -->
    <div
      class="reader-corner-hint"
      style="left:{cornerHint.left}px;top:{cornerHint.top}px;width:{cornerHint.width}px;height:{cornerHint.height}px"
      aria-hidden="true"
    >
      <div
        class="reader-corner-bar-v"
        class:at-right={cornerHint.corner === "br"}
        class:grown={cornerHintGrown}
        class:turned={cornerHint.turned}
      ></div>
      <div
        class="reader-corner-bar-h"
        class:at-bottom={cornerHint.corner === "br"}
        class:grown={cornerHintGrown}
        class:turned={cornerHint.turned}
      ></div>
    </div>
  {/if}

  {#if showToc}
    <div class="reader-popover reader-toc" bind:this={tocListEl} style="--tail-left:{tailLeft}px" on:wheel|stopPropagation>
      <div class="reader-popover-title">
        {t("目录")}
        <button
          class="reader-pin-btn"
          class:on={sidebarPinned}
          title={sidebarPinned ? t("取消固定（恢复浮层）") : t("固定为侧边栏（正文让位，可拖宽）")}
          on:click={toggleSidebarPin}
        >{sidebarPinned ? "⇤" : "⇥"}</button>
        {#if tocItems.length}
          <span class="reader-toc-count">{t("已读 {n}/{m}", { n: tocReadCount, m: tocItems.length })}</span>
        {/if}
      </div>
      <div class="reader-toc-list">
        {#each tocVisibleRows as row (row.node.id)}
          <button
            class="reader-toc-item"
            class:reader-toc-active={row.node.href !== "" && row.node.href === activeHref}
            style="padding-left:{row.depth * 12 + 4}px"
            on:click={() => goToc(row.node.href)}
          >
            <!-- caret 槽**所有行恒定渲染**（叶子也占空位）：折叠/展开不移动任何一行的文本左沿。
                 行内不嵌 button（非法 HTML），故 caret 用 span + stopPropagation；
                 键盘折叠（←/→）为 P1，此处 aria-hidden 不让读屏报出无意义的控件。 -->
            <span class="reader-toc-caret-slot">
              {#if row.node.children.length}
                <span
                  class="reader-toc-caret"
                  class:closed={tocCollapsed.has(row.node.id)}
                  aria-hidden="true"
                  title={t("折叠/展开")}
                  on:click|stopPropagation={() => toggleTocNode(row.node.id)}
                ><span class="reader-toc-caret-ico">{@html SEL_ICONS.chevronDown}</span></span>
              {/if}
            </span>
            {#if visitedHrefs.has(row.node.href)}
              <span class="reader-toc-check">✓</span>
            {/if}
            <span class="reader-toc-label">{row.node.title}</span>
          </button>
        {:else}
          <div class="reader-toc-empty">{t("本书没有目录")}</div>
        {/each}
      </div>
    </div>
  {/if}

  {#if imgView.open}
    <!-- 图片查看器（lightbox，2026-10-15 P0，方案 docs/…-设计方案.md §2.3）。
         刻意渲染在 .reader-floating-layer **之外**：那层是 aria-hidden="true"，
         role=dialog 的模态层放进去等于对读屏整个消失，且焦点落进 aria-hidden 子树属 a11y 违规。
         fixed inset 0 + z-index 60 对齐 .reword-pt-overlay 全屏遮罩先例。 -->
    <div
      class="reader-imgv"
      data-dismiss-ignore
      role="dialog"
      aria-modal="true"
      aria-label={t("图片查看")}
      on:click={onImageViewerRootClick}
      on:wheel={onImageViewerWheel}
    >
      <img
        class="reader-imgv-img"
        class:zoomed={imgViewScale > 1}
        bind:this={imgViewImgEl}
        src={imgView.src}
        alt=""
        draggable="false"
        style="transform: translate({imgViewPanX}px, {imgViewPanY}px) scale({imgViewScale})"
        on:dblclick={onImageViewerDblClick}
        on:pointerdown={onImageViewerPointerDown}
        on:pointermove={onImageViewerPointerMove}
        on:pointerup={onImageViewerPointerUp}
        on:pointercancel={onImageViewerPointerUp}
      />
      <div class="reader-imgv-bar">
        <button
          class="reader-imgv-btn"
          title={t("缩小")}
          aria-label={t("缩小")}
          on:click={() => zoomImageViewer(imgViewScale / IMGV_STEP)}
        >−</button>
        <!-- 宽度按最长态（800%）预留：缩放时工具条不左右抖动 -->
        <span class="reader-imgv-pct">{Math.round(imgViewScale * 100)}%</span>
        <button
          class="reader-imgv-btn"
          title={t("放大")}
          aria-label={t("放大")}
          on:click={() => zoomImageViewer(imgViewScale * IMGV_STEP)}
        >+</button>
        <button class="reader-imgv-btn reader-imgv-word" on:click={resetImageViewer}>{t("重置")}</button>
        <button
          class="reader-imgv-btn reader-imgv-word"
          bind:this={imgViewCloseEl}
          aria-label={t("关闭查看")}
          on:click={closeImageViewer}
        >{t("关闭查看")}</button>
      </div>
    </div>
  {/if}

  {#if showSearch}
    <div class="reader-popover reader-search">
      <div class="reader-search-row">
        <input
          class="reader-search-input"
          class:reader-search-input-invalid={searchMode === "regex" && !!regexError}
          type="text"
          placeholder={t("搜索…（↑/↓ 切换，Enter 搜，Esc 关）")}
          bind:value={searchQuery}
          bind:this={searchInput}
          on:input={onSearchInput}
          on:keydown={onSearchKeydown}
        />
        <button class="reader-mini-btn" disabled={searchMode === "regex" && !!regexError} on:click={startSearch}>{t("搜")}</button>
        <button
          class="reader-mini-btn reader-pin-mini"
          class:on={sidebarPinned}
          title={sidebarPinned ? t("取消固定（恢复浮层）") : t("固定为侧边栏（正文让位，可拖宽）")}
          on:click={toggleSidebarPin}
        >{sidebarPinned ? "⇤" : "⇥"}</button>
        <button class="reader-mini-btn" on:click={closeSearch} title={t("关闭")}>✕</button>
      </div>

      <div class="reader-search-options">
        <div class="reader-search-scope">
          <button class="reader-seg reader-seg-sm" class:reader-seg-active={searchScope === "book"} on:click={() => (searchScope = "book")}>{t("全书")}</button>
          <button class="reader-seg reader-seg-sm" class:reader-seg-active={searchScope === "chapter"} on:click={() => (searchScope = "chapter")}>{t("当前章")}</button>
        </div>
        <label class="reader-search-opt"><input type="checkbox" bind:checked={searchCaseSensitive} on:change={startSearch} />{t("大小写")}</label>
        <!-- 正则档全字无意义（词边界由 \b 自管）→ 置灰防误解 -->
        <label class="reader-search-opt" class:reader-search-opt-disabled={searchMode === "regex"}><input type="checkbox" bind:checked={searchWholeWord} disabled={searchMode === "regex"} on:change={startSearch} />{t("全字")}</label>
      </div>

      <!-- 2026-10-25 搜索增强：模式行（普通/正则/附近词，foliate matcher 原生三模式透传） -->
      <div class="reader-search-options reader-search-modes">
        <span class="reader-search-modes-label">{t("模式")}</span>
        <div class="reader-search-scope">
          <button class="reader-seg reader-seg-sm" class:reader-seg-active={searchMode === "contains"} on:click={() => setSearchMode("contains")}>{t("普通")}</button>
          <button class="reader-seg reader-seg-sm" class:reader-seg-active={searchMode === "regex"} on:click={() => setSearchMode("regex")}>{t("正则")}</button>
          <button
            class="reader-seg reader-seg-sm"
            class:reader-seg-active={searchMode === "nearby-words"}
            disabled={isNearbyWordsDisallowed()}
            title={isNearbyWordsDisallowed() ? t("附近词仅适用于英文书") : t("匹配拼写近似的词")}
            on:click={() => setSearchMode("nearby-words")}
          >{t("附近词")}</button>
        </div>
      </div>
      {#if searchMode === "regex" && regexError}
        <div class="reader-search-regex-error" title={regexError}>{t("正则无效：{e}", { e: regexError })}</div>
      {/if}

      <!-- 2026-10-25 搜索增强：历史 chips（普通模式 + 查询为空时展示） -->
      {#if searchMode === "contains" && searchHistory.length && !searchQuery.trim()}
        <div class="reader-search-history">
          <div class="reader-search-history-head">
            <span>{t("搜索历史")}</span>
            <button class="reader-mini-btn" on:click={clearSearchHistory}>{t("清空")}</button>
          </div>
          <div class="reader-search-chips">
            {#each searchHistory as h (h)}
              <button class="reader-search-chip" on:click={() => pickSearchHistory(h)}>{h}</button>
            {/each}
          </div>
        </div>
      {/if}

      {#if searching}
        <div class="reader-search-status">{t("搜索中…")}</div>
      {:else if searchResults.length}
        <div class="reader-search-status">
          <span class="reader-search-count">{searchIndex + 1} / {searchResults.length}</span>
          <span class="reader-search-nav">
            <button class="reader-mini-btn" on:click={() => void goSearchResult(-1)}>↑</button>
            <button class="reader-mini-btn" on:click={() => void goSearchResult(1)}>↓</button>
          </span>
        </div>
        <div class="reader-search-list">
          {#each searchResults as hit, i (hit.cfi + "-" + i)}
            <button
              class="reader-search-item"
              class:reader-search-item-active={i === searchIndex}
              on:click={() => void goSearchResultAt(i)}
            >
              <div class="reader-search-item-head">
                <span class="reader-search-item-chapter">{hit.chapterLabel || t("正文")}</span>
                <span class="reader-search-item-pct">{hit.progressPercent}%</span>
              </div>
              <div class="reader-search-item-excerpt">{@html highlightExcerpt(hit.excerpt, searchQuery, searchCaseSensitive, searchMode)}</div>
            </button>
          {/each}
        </div>
      {:else if searchQuery.trim()}
        <div class="reader-search-status">{t("未找到「{q}」", { q: searchQuery.trim() })}</div>
      {/if}
    </div>
  {/if}

  {#if showMoreMenu}
    <!-- 2026-10-24 移动端适配 Phase 2.1：紧凑顶栏 ⋯ 溢出菜单。
         复用 .reader-popover（点空白收起走 onContainerMouseDown 的 .reader-popover 豁免 +
         closeAllPopovers 链路，统一质感）。锚点在顶栏右组，故定位 top:44px; right:8px。 -->
    <div class="reader-popover reader-more-menu" role="menu" aria-label={t("更多")} on:wheel|stopPropagation>
      <div class="reader-popover-title">{t("更多")}</div>
      {#if caps.reflow}
        <button class="reader-more-item" role="menuitem" class:reader-more-item-active={bilingualOn}
          on:click={onMoreToggleBilingual}>
          <span>{t("双语对照")}</span>
          <span class="reader-more-item-state">
            {bilingualProgress.active ? `${bilingualProgress.done}/${bilingualProgress.total}` : bilingualOn ? t("开") : t("关")}
          </span>
        </button>
        <button class="reader-more-item" role="menuitem" on:click={onMoreBilingualSettings}>
          <span>{t("双语翻译设置")}</span>
        </button>
      {/if}
      <button class="reader-more-item" role="menuitem" on:click={onMoreSettings}>
        <span>⚙ {t("设置")}</span>
      </button>
      <button class="reader-more-item" role="menuitem" on:click={onMoreSearch}>
        <span>🔍 {t("搜索全书（F3 / ⌘F）")}</span>
      </button>
    </div>
  {/if}

  {#if showMarks}
    <div class="reader-popover reader-marks" style="--tail-left:{tailLeft}px" on:wheel|stopPropagation>
      <!-- 子区 1：书签 -->
      <div class="reader-marks-section">
        <div class="reader-popover-title">
          {t("书签")}
          <button
            class="reader-pin-btn"
            class:on={sidebarPinned}
            title={sidebarPinned ? t("取消固定（恢复浮层）") : t("固定为侧边栏（正文让位，可拖宽）")}
            on:click={toggleSidebarPin}
          >{sidebarPinned ? "⇤" : "⇥"}</button>
          {#if bookmarks.length}
            <span class="reader-toc-count">{t("{n} 条", { n: bookmarks.length })}</span>
          {/if}
        </div>
        <div class="reader-bm-list">
          <button class="reader-bm-add" on:click={toggleCurrentBookmark}>＋ {t("在当前页加书签")}</button>
          {#each bookmarks as bm (bm.id)}
            <div class="reader-bm-item">
              <button class="reader-bm-main" title={t("跳转到书签")} on:click={() => jumpBookmark(bm)}>
                <span class="reader-bm-label">{bm.label || t("书签")}</span>
                {#if bm.excerpt}
                  <span class="reader-bm-excerpt">{bm.excerpt}</span>
                {/if}
              </button>
              <button class="reader-mini-btn" title={t("删除书签")} on:click={() => removeBookmark(bm)}>✕</button>
            </div>
          {:else}
            <div class="reader-toc-empty">{t("还没有书签，点上面按钮在当前页加一个")}</div>
          {/each}
        </div>
      </div>

      <!-- 子区 2：标注与摘录（含墨迹） -->
      <!-- 2026-09-04 P0-3：墨迹笔触与文本摘录合并展示，按 createdAt 倒序。
           kind === "ink" 的项展示笔触色点 + 笔刷信息 + 跳页；其他走文本路径。
           2026-09-09 B：更名「标注与摘录」+ 每条加类型标识（高亮/直线/波浪/批注/矩形/墨迹），
           此前一律只显示文字，高亮与批注分辨不出。 -->
      <div class="reader-marks-section">
        <div class="reader-popover-title">
          {t("标注与摘录")}
          {#if annotsList.length}
            <span class="reader-toc-count">{t("{n} 条", { n: annotsList.length })}</span>
            <button class="reader-mini-btn" title={t("导出文本摘录为 Markdown（按设置的导出方式写入剪贴板或指定文档；墨迹不导出）")} on:click={exportAnnots}>{t("导出")}</button>
          {/if}
        </div>
        <div class="reader-annots-list">
          {#each annotsList as it (it.id)}
            <div class="reader-annot-item" class:reader-annot-item-ink={it.kind === "ink"}>
              <span class="reader-annot-dot" style="background:{it.color || '#62a2ff'}"></span>
              <span class="reader-annot-kind" title={annotKindLabel(it)}>{annotGlyph(it)}</span>
              <button class="reader-annot-main" title={t("跳转到{kind}所在位置", { kind: annotKindLabel(it) })} on:click={() => jumpAnnot(it)}>
                <span class="reader-annot-text">
                  {#if it.kind === "ink"}
                    <span class="reader-annot-ink-tag">✎ {it.sentence}</span>
                    <span class="reader-annot-ink-meta">{it.brush} · {it.style}</span>
                  {:else}
                    {String(it.selectedText || it.sentence || "").trim() || t("（无文本）")}
                  {/if}
                </span>
                {#if it.kind !== "ink" && String(it.note || "").trim()}
                  <span class="reader-annot-note">{String(it.note || "").trim()}</span>
                {/if}
              </button>
              <button
                class="reader-mini-btn"
                title={it.kind === "ink" ? t("删除这条墨迹") : t("删除这条摘录")}
                on:click={() => it.kind === "ink" ? removeInkStroke(it) : removeAnnot(it)}
              >✕</button>
            </div>
          {:else}
            <div class="reader-toc-empty">{t("本书还没有标注，划选文本后点「标注」或「批注」")}</div>
          {/each}
        </div>
      </div>
    </div>
  {/if}

    <!-- 2026-10-06 设置改造：Readest 式弹窗（settings/settings-schema.ts 为唯一真源）。
         旧的 776 行内联 <details> 折叠面板已整体迁出，改为 5 个 Tab（字体/布局/主题/语言/朗读）。
         变更统一经 on:change 冒泡，由本组件写回 settingsStore（book/pdf 分片）并触发重排。
         2026-10-07 第 3 批：词典管理改为**弹窗内二级页**（DictManagerPage 由 SettingsDialog 渲染），
         DictManager 实例经 window.__rewordDictManager 注入弹窗 prop —— 二级页不再另开遮罩。 -->
    <!--
      extra 传的是设置面板的宿主上下文：tts 配置 / 阅读模式 /
      本书的发送目标（2026-10-09）。

      ⚠️ 本说明必须放在标签**外面** ——
      Svelte 不允许在组件标签的属性之间夹 HTML 注释，
      会报 Expected &gt;。且这错只有 build 才暴露，tsc 与 npm test 都查不出。
    -->
    <SettingsDialog
      open={showSettings}
      initialTab={settingsInitialTab}
      {settings}
      extra={{ tts: ttsCfg, readerMode, getBookMeta: () => (bookId ? store.get(bookId) : undefined) }}
      {readerMode}
      dictManager={dictManagerRef}
      translateHost={translateHostRef}
      siyuanApi={siyuanApiForPicker}
      fontStore={fontStore}
      store={store}
      on:change={onSettingsDialogChange}
      on:reset={onSettingsDialogReset}
      on:action={onSettingsDialogAction}
      on:bookTargetPicked={onBookTargetPicked}
      on:autoBind={onAutoBind}
      on:dictChanged={onDictManagerChanged}
      on:fontChanged={onFontManagerChanged}
      on:close={() => (showSettings = false)}
    />

    <!-- 2026-10-07 第 3 批：词典管理不再有独立弹窗（原 <DictManagerDialog> 已删）。
       它现在是设置弹窗内的二级页，外壳（遮罩/返回条/底部条）由 SettingsDialog 提供。 -->


  <div class="reader-stage" bind:this={readerStageEl}>
    <div class="reader-container" bind:this={container}></div>
    <!-- [REword 2026-09-02] PDF 界面专属浮层：Apple Pencil 墨迹批注（SVG 层 + 工具栏） -->
    {#if readerMode === "pdf"}
      <PdfOverlay opened={opened} />
      <!-- 2026-09-04 P1：PDF 文本标注覆盖层（与 PdfOverlay 同处 PDF 分支） -->
      <PdfTextHlLayer
        bookId={bookId}
        {view}
        {opened}
        {pdfCurrentPage}
        onRectCopyLink={copyRectLink}
        onRectDeleted={onRectDeleted}
        pendingUndo={!!pendingDelete}
        onUndoDelete={undoDelete}
        onAnnotClick={onPdfAnnotClick}
        bind:this={pdfHlLayerComp}
      />
      {#if pdfRectMode}
        <!-- 2026-09-09 P1：矩形框选捕获层（盖住 iframe 收事件）+ 拖拽预览矩形 -->
        <div
          class="pdf-rect-capture"
          role="application"
          aria-label={t("矩形框选模式")}
          on:mousedown={onRectCaptureMouseDownStart}
        >
          {#if pdfRectDrag}
            <div class="pdf-rect-preview" style={pdfRectPreviewCss}></div>
          {/if}
          <span class="pdf-rect-hint">{t("框选图表 / 排版区域，松手自动复制链接 + 截图（Esc 退出）")}</span>
        </div>
      {/if}
    {/if}
    {#if opened && !errorMsg}
      <div class="reader-side-tap" aria-hidden="false">
        <button
          class="reader-side-arrow reader-side-left reader-ui-transition"
          title={t("上一页（←/PageUp）")}
          aria-label={t("上一页")}
          on:pointerdown={() => arrowDown("prev")}
          on:pointerup={stopArrowRepeat}
          on:pointerleave={stopArrowRepeat}
          on:pointercancel={stopArrowRepeat}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <button
          class="reader-side-arrow reader-side-right reader-ui-transition"
          title={t("下一页（→/PageDown/空格）")}
          aria-label={t("下一页")}
          on:pointerdown={() => arrowDown("next")}
          on:pointerup={stopArrowRepeat}
          on:pointerleave={stopArrowRepeat}
          on:pointercancel={stopArrowRepeat}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
        </button>
      </div>
    {/if}
  </div>

  <!-- 2026-08-26 调试 HUD：foliate 原生标注管线诊断（DEBUG_READER=true 时显示） -->
  {#if DEBUG_READER}
  <div class="reader-debug-hud">
    <div class="reader-debug-hud-title">🔍 {t("REword 高亮诊断（foliate 原生）")}</div>
    <div class="reader-debug-hud-row"><b>setup:</b> {dbgHud.setupCalled} <b>annStore:</b> {dbgHud.annStoreReady} <b>bookId:</b> {dbgHud.bookIdAtSetup}</div>
    <div class="reader-debug-hud-row"><b>storeAnnots:</b> {dbgHud.annotCountInStore} <b>totalInStore:</b> {dbgHud.totalInStore} <b>bookIdMatch:</b> {dbgHud.bookIdMatch}</div>
    <div class="reader-debug-hud-row"><b>createOverlay:</b> {dbgHud.createOverlayCalls} <b>relocate:</b> {dbgHud.relocateCalls} <b>evtIdx:</b> {dbgHud.ovr_evtIndex}</div>
    <div class="reader-debug-hud-row"><b>{t("addAnnotation 调用:")}</b> {dbgHud.addAnnotationTries} <b>{t("失败:")}</b> {dbgHud.addAnnotationErrors} <b>{t("绘制:")}</b> {dbgHud.drawnCount}</div>
    <div class="reader-debug-hud-row"><b>lastDraw:</b> {dbgHud.lastDraw}</div>
  </div>
  {/if}

  <!-- 底部控制栏：翻页 + 进度条。独立在 .reader-stage 之外（2026-08-25 修复：
       此前误置于 stage 内，被 position:absolute 的 .reader-container 遮挡 + overflow:hidden 裁切导致不可见）。
       2026-08-30 改造：① 目录 / 书签 / 摘录三个入口已统一上移到顶栏左侧，底栏不再重复摆放；
       ② 进度条默认完全隐藏（macOS 程序坞机制）：仅鼠标悬浮底部边框热区 或 点击右下角唤出按钮（固定）时平滑显现，
          移开即自动隐藏；隐藏态移出文档流，绝不遮挡正文文字。 -->
  <div
    class="reader-bottom-bar"
    class:bottom-bar-revealed={bottomBarRevealed}
    on:mouseenter={() => { bottomBarBarHover = true; updateBottomBarReveal(); }}
    on:mouseleave={() => { bottomBarBarHover = false; updateBottomBarReveal(); }}
  >
    <button class="reader-btn reader-bottom-collapse" title={t("收起进度条")} on:click={collapseBottomBar}>⌄</button>
    <button class="reader-btn" title={t("第一页（Home）")} on:click={goFirstPage}>⏮</button>
    <!-- 2026-10-25 P0-2：章节跳转（⏮◀⏪|进度|⏩▶⏭，对标微信读书底栏） -->
    <button class="reader-btn" title={t("上一章（Alt+←）")} on:click={goPrevChapter}>⏪</button>
    <button class="reader-btn" title={t("上一页")} on:click={turnPrev}>◀</button>
    <div class="reader-progress-wrap">
      {#if chapterMarks.length}
        {#each chapterMarks as m (m.left)}
          <span
            class="reader-chapter-tick"
            style="left:{m.left}%"
            title={m.title}
          ></span>
        {/each}
      {/if}
      <input
        class="reader-progress-bar"
        type="range"
        min="0"
        max="1000"
        value={Math.round(progress * 1000)}
        style="--progress: {progress * 100}%"
        on:input={onProgressInput}
        on:change={onProgressChange}
      />
    </div>
    <!-- 2026-10-07 接通「显示页眉页脚」：章节名（页眉位） -->
    {#if currentChapterTitle}
      <span class="reader-chapter-name" title={currentChapterTitle}>{currentChapterTitle}</span>
    {/if}
    <span class="reader-progress-text">{progressText}</span>
    {#if etaText}
      <span class="reader-eta" title={t("按当前阅读速度估算")}>{etaText}</span>
    {/if}
    <!-- 2026-10-07 接通「显示页眉页脚」：剩余章节（页脚位） -->
    {#if remainingText}
      <span class="reader-remaining">{remainingText}</span>
    {/if}
    <button class="reader-btn" title={t("下一页")} on:click={turnNext}>▶</button>
    <button class="reader-btn" title={t("下一章（Alt+→）")} on:click={goNextChapter}>⏩</button>
    <button class="reader-btn" title={t("最后一页（End）")} on:click={goLastPage}>⏭</button>
  </div>

  <!-- 2026-08-30 · 底部进度条「把手」：常驻（dot / both 模式）。
       收起态在底部中央显示小圆点，点击固定展开；展开态圆点被进度条顶到上方中央，
       再次点击即可收起（无需去左侧找向下箭头）。hover 模式由底部热区临时唤出，无圆点。 -->
  {#if settings.layout.bottomBarMode !== "hover"}
  <button
    class="reader-bottom-handle"
    class:reader-bottom-handle-revealed={bottomBarRevealed}
    title={bottomBarRevealed ? t("点击收起进度条") : t("点击展开进度条")}
    on:click={toggleBottomBarPin}
  >
    <span class="reader-bottom-handle-dot"></span>
  </button>
  {/if}

  <!-- 2026-08-28：连续朗读控制条（参考 Readest 朗读体验） -->
  {#if showTtsBar}
  <div class="reader-tts-bar">
    <button class="reader-btn reader-tts-btn" title={t("上一句")} on:click={ttsPrev}>⏮</button>
    <button class="reader-btn reader-tts-btn reader-tts-play" title={t("播放/暂停（Space）")} on:click={ttsTogglePlay}>
      {ttsState === "playing" ? "⏸" : "▶"}
    </button>
    <button class="reader-btn reader-tts-btn" title={t("下一句")} on:click={ttsNext}>⏭</button>
    <button class="reader-btn reader-tts-btn" title={t("停止")} on:click={ttsStop}>⏹</button>
    <div class="reader-tts-meta">
      <span class="reader-tts-progress">{ttsProgress.total ? ttsProgress.index + 1 : 0}/{ttsProgress.total}</span>
      <span class="reader-tts-current" title={ttsCurrentText}>{ttsCurrentText}</span>
    </div>
    <div class="reader-tts-rate">
      <span class="reader-tts-rate-label">{t("语速")}</span>
      <input type="range" min="0.5" max="3" step="0.1" value={ttsRate} on:input={onTtsRateInput} />
      <span class="reader-tts-rate-val">{ttsRate.toFixed(1)}×</span>
    </div>
    <button class="reader-btn reader-tts-btn" class:reader-btn-active={ttsHighlightOn} title={t("句子高亮跟随")} on:click={ttsToggleHighlight}>{t("高亮")}</button>
    <button class="reader-btn reader-tts-btn" title={t("收藏本句生词到生词本")} on:click={ttsCollectWords}>{t("收词")}</button>
  </div>
  {/if}

  {#if pausedByCrash}
    <!-- 2026-09-08 启动卡死修复：卡死后不自动开书，显示手动打开入口 -->
    <div class="reader-error">
      {t("上次启动异常，已暂停自动打开本书")}
      <button class="reader-btn" style="margin-left:8px;" on:click={manualReopen}>{t("重新打开")}</button>
    </div>
  {:else if errorMsg}
    <div class="reader-error">{t("打开失败：")}{errorMsg}</div>
  {/if}

  <!--
    2026-10-06 关键修复：设置面板点 Tab 即关的真凶。
    本遮罩是 `position:absolute; z-index:1` 的全屏层，且在模板里**排在
    SettingsDialog 之后**（9049 行 vs 8690 行）。SettingsDialog 的遮罩
    虽然写了 z-index:40，但组件根元素没有独立层叠上下文，两者是不同的
    stacking context → z-index 不可比 → **后出现的本遮罩盖在设置弹窗之上**。
    于是「点 Tab」实际命中的是本遮罩 → closeAllPopovers() → showSettings=false
    → 弹窗瞬间关闭（用户表现为「点哪都关」）。

    修法：设置弹窗打开时**不渲染本遮罩**。设置面板自带遮罩与关闭入口，
    不需要「点空白收起」；而目录/搜索仍保留该行为。
  -->
  {#if (showToc || showSearch) && !showSettings && !sidebarPinned}
    <div class="reader-backdrop" on:click={closeAllPopovers} aria-hidden="true"></div>
  {/if}

  <!-- 2026-10-25 P0-1：停靠侧栏的拖宽把手（仅在停靠面板在场时渲染） -->
  {#if anyDockPanel()}
    <div class="reader-side-resizer" data-dismiss-ignore on:pointerdown={onSidebarResizeStart}></div>
  {/if}

  <!-- 2026-08-23 修复：所有浮层（划词/词典/批注/toast）统一放入 .reader-floating-layer
       容器内，避免 position:fixed 覆盖整个视口拦截思源顶栏"管理"等原生 UI 点击。
       容器 pointer-events:none 默认不拦截事件，子元素显式 pointer-events:auto 启用交互。 -->
  <div class="reader-floating-layer" aria-hidden="true">
  <!-- 划词悬浮工具栏（微信读书式恒深色胶囊，2026-10-11 重做）
       create 态：选中正文 → 主栏（图标 + 标签：复制/标注/批注/词典/[搜索]/翻译/朗读/发送）。
                 点「标注」= 一键高亮（上次样式+颜色）并**原地转 edit 态** —— 样式行随之滑入，
                 用户可顺手改样式/颜色或撤销（用户拍板 D3，微信读书行为）。
       edit 态（点已有标注 / 点「标注」后）：槽位 2 由「标注」换成「删除划线」，
                 样式行常显，点样式/颜色即时改该标注。
       布局：DOM 顺序恒为 [主栏, 样式行]；默认（place=above）经 CSS column-reverse
             把样式行翻到主栏【上方】——2026-10-13 P0-2：above 的锚定语义是
             「容器底边贴锚点」，样式行若在主栏下方（向下探出），create→edit 转场时
             总高 +47px 会把主栏整条上推 47px（用户看到「工具栏闪一下」）。
             翻到上方后容器底边=主栏底边，主栏零位移，样式行从主栏上沿折出。
             place=below/left/right 保持样式行在下方（那些方位锚点钉的是主栏近选区那一侧）。
       bind:this={selStripEl} 供实测样式行真实高度（定位避让用）；样式行只在 edit 态渲染，
       create 态为 null，读取处一律判空回退。 -->
  {#if selToolbar.visible}
    <div class="reader-sel-toolbar" data-dismiss-ignore bind:this={selToolbarEl} class:place-above={selToolbar.place==='above'} class:place-below={selToolbar.place==='below'} class:place-left={selToolbar.place==='left'} class:place-right={selToolbar.place==='right'} class:closing={selToolbar.closing} class:narrow={selToolbar.narrow} style="left:{selToolbar.x}px;top:{selToolbar.y}px">
      <!-- 主栏：图标 + 标签，恒深色，始终显示 -->
      <div class="reader-sel-main">
        {#if selToolbar.mode === "edit"}
          {#if selToolbar.ghostCfi}
            <!-- 2026-08-24 死锁解除：数据已无活跃记录但视觉残留时，只给「清除残留高亮」入口 -->
            <button class="reader-sel-item reader-sel-item-danger" title={t("清除残留高亮")} on:click={onClearGhostHighlight}>
              <span class="reader-sel-ico">{@html SEL_ICONS.trash}</span>
              <span class="reader-sel-txt">{t("清除残留高亮")}</span>
            </button>
          {:else}
          <!-- 2026-10-11 槽位对齐素材①：复制在首、「删除划线」在次（替代 create 态的「标注」槽位）。 -->
          <button class="reader-sel-item" title={t("复制")} on:click={onSelCopy}>
            <span class="reader-sel-ico">{@html SEL_ICONS.copy}</span>
            <span class="reader-sel-txt">{t("复制")}</span>
          </button>
          <button class="reader-sel-item reader-sel-item-danger" title={t("删除划线")} on:click={onAnnDeleteById}>
            <span class="reader-sel-ico">{@html SEL_ICONS.trash}</span>
            <span class="reader-sel-txt">{t("删除")}</span>
          </button>
          {#if pdfAnnotEnabled("annotate")}
          <button class="reader-sel-item" title={t("批注：升级为带笔记标注")} on:click={onEditAnnotate}>
            <span class="reader-sel-ico">{@html SEL_ICONS.annotate}</span>
            <span class="reader-sel-txt">{t("批注")}</span>
          </button>
          {/if}
          <button class="reader-sel-item" title={t("词典")} on:click={onSelDict}>
            <span class="reader-sel-ico">{@html SEL_ICONS.dict}</span>
            <span class="reader-sel-txt">{t("词典")}</span>
          </button>
          <!-- 2026-10-08「划词后搜索」开关：默认关，加一项按钮会让横向工具栏变挤 -->
          {#if settings.selSearchEnabled}
          <button class="reader-sel-item" title={t("搜索：查找这个词在书中的其他用法")} on:click={onSelSearch}>
            <span class="reader-sel-ico">{@html SEL_ICONS.search}</span>
            <span class="reader-sel-txt">{t("搜索")}</span>
          </button>
          {/if}
          <button class="reader-sel-item" title={t("翻译")} on:click={onSelTranslate}>
            <span class="reader-sel-ico">{@html SEL_ICONS.translate}</span>
            <span class="reader-sel-txt">{t("翻译")}</span>
          </button>
          <button class="reader-sel-item" title={t("朗读")} on:click={onSelSpeak}>
            <span class="reader-sel-ico">{@html SEL_ICONS.tts}</span>
            <span class="reader-sel-txt">{t("朗读")}</span>
          </button>
          <button class="reader-sel-item" title={t("发送")} on:click={onSelSend}>
            <span class="reader-sel-ico">{@html SEL_ICONS.send}</span>
            <span class="reader-sel-txt">{t("发送")}</span>
          </button>
          {/if}
        {:else}
          <button class="reader-sel-item" title={t("复制")} on:click={onSelCopy}>
            <span class="reader-sel-ico">{@html SEL_ICONS.copy}</span>
            <span class="reader-sel-txt">{t("复制")}</span>
          </button>
          <!-- 「标注」= 一键高亮（上次样式 + 颜色），图标右上角小角标预览将用的样式/颜色。
               2026-10-11：原来的「▼ 展开样式条」右段已删除（用户拍板）—— 点「标注」后
               原地转 edit 态，样式行随动画滑入，改样式/颜色都在那一步完成。 -->
          {#if pdfAnnotEnabled("highlight")}
          <button
            class="reader-sel-item reader-sel-item-accent"
            title={t("标注：使用上次样式（{style} + {color}）", { style: lastStyleLabel, color: lastColorName })}
            on:click={onQuickAnnotate}>
            <span class="reader-sel-ico">{@html SEL_ICONS.highlight}</span>
            <span class="reader-sel-txt">{t("标注")}</span>
            <span class="reader-sel-style-preview style-{lastStyle}" style="--spc:{lastColor}"></span>
          </button>
          {/if}
          {#if pdfAnnotEnabled("annotate")}
          <button
            class="reader-sel-item reader-sel-item-accent"
            title={t("批注：打开批注编辑气泡（样式+颜色+笔记）")}
            on:click={openNoteEditor}>
            <span class="reader-sel-ico">{@html SEL_ICONS.annotate}</span>
            <span class="reader-sel-txt">{t("批注")}</span>
          </button>
          {/if}
          <button class="reader-sel-item" title={t("词典")} on:click={onSelDict}>
            <span class="reader-sel-ico">{@html SEL_ICONS.dict}</span>
            <span class="reader-sel-txt">{t("词典")}</span>
          </button>
          <!-- 2026-10-08「划词后搜索」开关：默认关，加一项按钮会让横向工具栏变挤 -->
          {#if settings.selSearchEnabled}
          <button class="reader-sel-item" title={t("搜索：查找这个词在书中的其他用法")} on:click={onSelSearch}>
            <span class="reader-sel-ico">{@html SEL_ICONS.search}</span>
            <span class="reader-sel-txt">{t("搜索")}</span>
          </button>
          {/if}
          <button class="reader-sel-item" title={t("翻译")} on:click={onSelTranslate}>
            <span class="reader-sel-ico">{@html SEL_ICONS.translate}</span>
            <span class="reader-sel-txt">{t("翻译")}</span>
          </button>
          <button class="reader-sel-item" title={t("朗读")} on:click={onSelSpeak}>
            <span class="reader-sel-ico">{@html SEL_ICONS.tts}</span>
            <span class="reader-sel-txt">{t("朗读")}</span>
          </button>
          <button class="reader-sel-item" title={t("发送")} on:click={onSelSend}>
            <span class="reader-sel-ico">{@html SEL_ICONS.send}</span>
            <span class="reader-sel-txt">{t("发送")}</span>
          </button>
        {/if}
      </div>
      <!-- 样式行：**只在 edit 态**渲染（create 态没有展开开关，见文件头注释）。
           两枚药丸：左 = 3 线型，右 = 5 色点（当前色带 ✓ 徽章）；两端对齐、行宽随容器。
           bind:this 供 positionToolbarAbove 实测真实高度（offsetHeight 口径）。 -->
      {#if selToolbar.mode === "edit"}
        <div class="reader-sel-strip-row" bind:this={selStripEl}>
          <div class="reader-sel-pill reader-sel-pill-styles">
            {#each ANNOTATION_PANEL_STYLES as s}
              {#if pdfAnnotEnabled(s === "highlight" ? "highlight" : "underline")}
              <button
                class="reader-sel-style-btn"
                class:active={selToolbar.annStyle === s}
                title={t(ANNOTATION_STYLES[s].label)}
                on:click={() => applyEditStyle(s)}>
                <!-- P2（2026-10-12）：字形 = 微信读书的「A + 装饰线」。装饰线由 .reader-style-glyph.style-*
                     的 text-decoration / 背景带承担（CSS 早已备好，此前多塞了旧字形 ▮/━/﹏）。
                     ANNOTATION_STYLES[].icon 保留给批注列表的类型徽标 annotGlyph()（与 ✎/▭/💬 同族）。 -->
                <span class="reader-style-glyph style-{s}" style="--sc:{selToolbar.annColor || lastColor}">A</span>
              </button>
              {/if}
            {/each}
          </div>
          <div class="reader-sel-pill reader-sel-pill-colors">
            {#each WHALE_COLORS as c}
              <button
                class="reader-sel-color-dot"
                class:active={(selToolbar.annColor || lastColor) === c.value}
                style="background:{c.value}"
                title={t(c.name)}
                on:click={() => applyEditColor(c.value)}>
                {#if (selToolbar.annColor || lastColor) === c.value}
                  <span class="reader-sel-color-check">{@html SEL_ICONS.confirm}</span>
                {/if}
              </button>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  {/if}

  <!-- 2026-10-14 P1：选区两端「定位标识」手柄（微信读书式）。
       create 态选区出现，拖拽实时改选区 base/extent 并重锚工具栏（见 onSelHandlePointerDown）。
       data-dismiss-ignore：点/拖手柄不被 onContainerMouseDown 的「点空白收起」误伤。 -->
  {#if selHandles.visible}
    <div
      class="reader-sel-handle reader-sel-handle--start"
      class:active={selHandleDragging === "start"}
      data-dismiss-ignore
      style="left:{selHandles.start.x}px;top:{selHandles.start.y}px;--sh:{selHandles.start.h}px"
      on:pointerdown={(e) => onSelHandlePointerDown(e, "start")}
    ></div>
    <div
      class="reader-sel-handle reader-sel-handle--end"
      class:active={selHandleDragging === "end"}
      data-dismiss-ignore
      style="left:{selHandles.end.x}px;top:{selHandles.end.y}px;--sh:{selHandles.end.h}px"
      on:pointerdown={(e) => onSelHandlePointerDown(e, "end")}
    ></div>
  {/if}

  <!-- 2026-10-24 批 C：页边驻留提示。拖末端手柄进页边带、还没到翻页时间时出现，
       告诉用户「再停一下就走」；pointer-events:none，不参与拖拽命中。 -->
  {#if selEdgeHint.visible && selHandles.visible}
    <div
      class="reader-edge-hint"
      class:reader-edge-hint--prev={selEdgeHint.dir === "prev"}
      style="left:{selEdgeHint.x}px;top:{selEdgeHint.y}px"
    >{selEdgeHint.dir === "next" ? "›" : "‹"}</div>
  {/if}

  <!-- 2026-10-08 重写：紧凑横向卡片 + 样式/色板折叠悬浮
       · 宽度 268 → 400（NOTE_CARD_W，与 positionPopupNear 共用）
       · **三行**横排：原文 / 工具条（含取消·保存）/ 输入区
         （原为四行，取消·保存与快捷键提示独占一行 —— 「间隔过大」的根因，
           2026-10-08 已把它们并入工具条并删掉快捷键提示行）
       · 样式条（3 个）与色板（5 色）**各折叠成一个触发器**，点击才悬浮展开
       · 删掉了 `mode === "view"` 死分支（代码从不设这个值，见noteEditor 声明处注释）
       · 复制/导出/取消/保存/删除从 emoji 或文字按钮换成内联 SVG
         （emoji 在深色下不跟随主题；文字按钮占横向空间）
       · `preview`（点已有批注）与 `highlight`（纯标注查看）**共用同一套骨架**，
         只在「有无笔记 / 有无原文」上有差别 —— 原先是两段几乎重复的 DOM。 -->
  {#if noteEditor.visible}
    <div
      class="reader-note-editor"
      data-dismiss-ignore
      class:place-above={noteEditor.place==='above'}
      class:place-below={noteEditor.place==='below'}
      class:place-left={noteEditor.place==='left'}
      class:place-right={noteEditor.place==='right'}
      bind:this={noteEditorEl}
      style="left:{noteEditor.x}px;top:{noteEditor.y}px"
      on:click={onNoteCardClick}
    >
      <!-- 行 1 · 原文引用 + 时间（单行省略，不撑高卡片） -->
      <div class="reader-note-row-top">
        <div class="reader-note-excerpt" title={noteEditor.text}>
          {noteEditor.text || t("（无原文）")}
        </div>
        {#if noteEditor.time}
          <span class="reader-note-time" title={noteEditor.time}>{noteEditor.time}</span>
        {/if}
      </div>

      <!-- 行 2 · 工具条：左边折叠触发器，右边图标操作 -->
      <div class="reader-note-tools">
        <!-- 折叠 · 样式选择（3 项） -->
        <div class="reader-note-fold-wrap">
          <button
            class="reader-note-fold"
            class:open={noteFold.style}
            title={t("修改标注样式")}
            on:click={() => toggleNoteFold("style")}
          >
            <span class="reader-style-glyph style-{noteEditor.style}" style="--sc:{noteEditor.color}">A</span>
            <span class="reader-note-fold-label">{noteEditor.styleLabel}</span>
            <span class="reader-note-caret">{@html SEL_ICONS.chevronDown}</span>
          </button>
          {#if noteFold.style}
            <div class="reader-note-pop">
              {#each ANNOTATION_PANEL_STYLES as s}
                <button
                  class="reader-note-opt"
                  class:on={s === noteEditor.style}
                  title={ANNOTATION_STYLES[s].label + '：' + ANNOTATION_STYLES[s].hint}
                  on:click={() => onPickPanelStyle(s)}
                >
                  <span class="reader-style-glyph style-{s}" style="--sc:{noteEditor.color}">A</span>
                </button>
              {/each}
            </div>
          {/if}
        </div>

        <!-- 折叠 · 色板（5 色） -->
        <div class="reader-note-fold-wrap">
          <button
            class="reader-note-fold"
            class:open={noteFold.color}
            title={t("修改颜色")}
            on:click={() => toggleNoteFold("color")}
          >
            <span class="reader-note-swatch" style="background:{noteEditor.color}"></span>
            <span class="reader-note-caret">{@html SEL_ICONS.chevronDown}</span>
          </button>
          {#if noteFold.color}
            <div class="reader-note-pop">
              {#each WHALE_COLORS as c}
                <button
                  class="reader-note-opt"
                  class:on={c.value === noteEditor.color}
                  title={t(c.name)}
                  on:click={() => onPickPanelColor(c.value)}
                >
                  <span class="reader-note-opt-dot" style="background:{c.value}"></span>
                </button>
              {/each}
            </div>
          {/if}
        </div>

        <span class="reader-note-spacer"></span>

        <!-- ⚠️ 图标必须**包一层带 class 的 span**（与 .reader-sel-ico 同款做法）。
             `{@html}` 注入的 SVG 不带 Svelte 的 scoped hash 类，
             直接放在 button 里时 `.reader-note-icon :global(svg)` 这类后代选择器
             虽能命中，但**按钮自身的 padding/border 与 svg 的尺寸没有约束关系**，
             实测表现为图标变成一块黑色方块（截图里可见）。
             包一层后由 .reader-note-ico 明确控制 display/size，颜色继承 color。 -->
        <button class="reader-note-icon" title={t("复制")} on:click={onViewerCopy}>
          <span class="reader-note-ico">{@html SEL_ICONS.copy}</span>
        </button>
        <button class="reader-note-icon" title={t("导出")} on:click={onViewerExport}>
          <span class="reader-note-ico">{@html SEL_ICONS.download}</span>
        </button>

        <!-- 🔴 分隔线只在「它后面确实还有按钮」时才画。
             否则会留下一条悬空的一竖线（查看态既无取消/保存、也可能无删除）。 -->
        {#if !isNoteViewer || noteEditor.id}
          <span class="reader-note-sep" aria-hidden="true"></span>
        {/if}

        <!-- 2026-10-08：取消 / 保存从原来的「行 4 文字按钮」并入此处。
             语义上它们与复制/导出/删除同属「这张卡片的操作」，拆两行是历史遗留
             （那两个按钮最早写，图标组是后来改版加的）—— 并过来后
             `justify-content: space-between` 那行整块删掉，「间隔过大」自然消失。 -->
        {#if !isNoteViewer}
          <button class="reader-note-icon" title={t("取消")} on:click={onNoteCancel}>
            <span class="reader-note-ico">{@html SEL_ICONS.cancel}</span>
          </button>
          <button class="reader-note-icon primary" title={t("保存")} on:click={onNoteSave}>
            <span class="reader-note-ico">{@html SEL_ICONS.confirm}</span>
          </button>
        {/if}

        {#if noteEditor.id}
          <button class="reader-note-icon danger" title={t("删除")} on:click={onViewerDelete}>
            <span class="reader-note-ico">{@html SEL_ICONS.trash}</span>
          </button>
        {/if}
      </div>

      <!-- 行 3 · 笔记正文（有笔记才显示；纯高亮态没有笔记 => 这一行不出现） -->
      {#if noteEditor.mode !== "highlight"}
        <textarea
          class="reader-note-input"
          class:viewer={isNoteViewer}
          placeholder={t("写点批注…")}
          bind:value={noteEditor.note}
          on:blur={onNoteAutoSave}
          on:keydown={onNoteKeydown}
          use:focusNoteInput></textarea>
      {/if}
    </div>
  {/if}

  <!-- 脚注气泡（点击脚注引用 → 展示内容，不跳转；2026-08-25 新增） -->
  {#if showFootnote}
    <div class="reader-popover reader-footnote" bind:this={footnoteEl}>
      <div class="reader-footnote-head">
        <span class="reader-footnote-icon">💡</span>
        <span class="reader-footnote-title">{footnoteType}</span>
        <!-- 跳转到脚注原文所在页。target 为空（同章内联脚注 / 抽取失败）时
             整个按钮不渲染 —— 灰按钮会让人以为功能坏了，不如不出现。 -->
        {#if footnoteTarget}
          <button
            class="reader-footnote-jump"
            on:click={jumpToFootnotePage}
            title={t("跳转到脚注所在页")}
          >↗</button>
        {/if}
        <button class="reader-footnote-close" on:click={closeFootnote} title={t("关闭")}>✕</button>
      </div>
      <div class="reader-footnote-body">
        {#if footnoteLoading && !footnoteHTML}
          <div class="reader-footnote-loading">⌛ {t("脚注加载中…")}</div>
        {:else}
          {@html footnoteHTML}
        {/if}
      </div>
    </div>
  {/if}

  <!--快捷键提示面板（2026-10-10 抽到 ./ReaderHint.svelte 共用组件） -->
  <ReaderHint visible={showShortcutHint} groups={shortcutHintGroups} onClose={() => (showShortcutHint = false)} />

  <!-- 即时词典弹窗（复用 .hiword-dict-* 全局样式） -->
  {#if dictPopup.visible}
    <!-- 仅划词工具栏来源（sel）渲染遮罩：悬浮（hover）来源不能遮罩，否则会拦截 iframe 的 mousemove 取词 -->
    {#if dictPopupSource === "sel"}
      <div class="reader-dict-backdrop" on:click={closeDictPopup} aria-hidden="true"></div>
    {/if}
    <div class="reader-dict-popup" bind:this={dictPopupEl} style="left:{dictPopup.x}px; top:{dictPopup.y}px"
         on:mouseenter={onDictPopupEnter} on:mouseleave={onDictPopupLeave}>
      <div class="reader-dict-head">
        <span>{t("词典")}</span>
        <div class="reader-dict-head-actions">
          <button class="reader-dict-send" on:click={sendToSidebar} title={t("在 REword 侧边栏查词（自动填入，无需手动输入）")}>{t("侧边栏")}</button>
          <button class="reader-dict-close" on:click={closeDictPopup} title={t("关闭")}>✕</button>
        </div>
      </div>
      <div class="reader-dict-body" on:click={onDictBodyClick}>{@html dictPopup.html}</div>
    </div>
  {/if}

  <!-- 批注编辑 / 查看浮层已废弃（2026-08-24 重构后点击高亮改弹底部工具栏，annEditor 无调用方），整段移除 -->
      <!-- annEditor 卡片内容已移除（无调用方） -->

  {#if toastMsg}
    <div class="reader-toast">
      <span>{toastMsg}</span>
      {#if toastUndo}
        <button class="reader-toast-undo" on:click={undoDelete}>{t("撤销")}</button>
      {/if}
    </div>
  {/if}
  </div><!-- /.reader-floating-layer -->
</div>

<style>
  /* ================= 快捷键提示面板 CSS 已迁出到 ./ReaderHint.svelte =================
   * 2026-10-10：BookshelfView 也用同一个面板时，把 CSS 抽到独立组件，
   * 不在两份 .svelte 里维护两套（容易漂移）。
   */

  .reader-view {
    display: flex;
    flex-direction: column;
    /* 2026-08-24 修复（方案 B）：改为相对 flex 子项撑满 holder，
       不再使用 absolute inset:0，避免成为覆盖 Tab 的命中拦截层，
       从而解决思源顶栏"管理"菜单在阅读 Tab 下无法 hover/点击的问题。 */
    position: relative;
    flex: 1;
    min-height: 0;
    /* [REword patch 2026-08-29] Phase 2 触屏优化
     * touch-action: manipulation 避免 iOS Safari 350ms 双击延迟 */
    touch-action: manipulation;
    /* 2026-08-25 修复：原 overflow:hidden 用于裁剪浮层，但会连带裁掉划词工具栏
       （工具栏按 reader-view 相对坐标定位，选区靠顶部时会被算到负 Y 区、被裁掉点不到）。
       正文裁剪已由 .reader-container 的 overflow:hidden 负责，故此处改回 visible；
       浮层的上下/左右避让改由定位逻辑（rectToViewRel + 碰撞检测 + 水平夹紧）约束。 */
    overflow: visible;
    background: var(--b3-theme-background, #fff);
    /* 思源主题字体 + 全平台 CJK + emoji 兜底，
       避免 TOC/章节名里的 emoji/罕字因思源字体无字形而显示 □。
       注意：以下字体只影响本组件 DOM（TOC/搜索/设置/底栏），
       不影响 iframe 内正文——iframe 内的字体由 buildStyles() 独立控制。 */
    font-family: var(--b3-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI",
        "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "WenQuanYi Micro Hei",
        "Source Han Sans CN", "Noto Sans CJK SC", "Noto Sans", sans-serif),
      "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Symbola", sans-serif;
  }
  .reader-toolbar {
    display: grid;
    /* 2026-08-30 改造：3 段 grid（左：抽屉触发器 / 中：标题 / 右：工具）
       用 1fr | minmax(0,auto) | 1fr —— 左右两列等分剩余空间，中间标题列
       宽度由内容决定，因此标题始终居中于整条工具栏。
       （旧的 auto|1fr|auto 会被左右不等宽的工具组挤偏，视觉上不居中。） */
    grid-template-columns: 1fr minmax(0, auto) 1fr;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    /* 2026-08-29 Phase 1：顶部安全区（刘海 / 灵动岛） */
    padding-top: calc(6px + env(safe-area-inset-top, 0px));
    padding-left: calc(8px + env(safe-area-inset-left, 0px));
    padding-right: calc(8px + env(safe-area-inset-right, 0px));
    /* 2026-08-28 B2：柔和底 + 细边 + 轻投影，提升原生感（仍低于思源原生 UI） */
    background: var(--b3-theme-surface, var(--b3-theme-background, #fff));
    border-bottom: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.08));
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.05);
    flex-shrink: 0;
    /* 2026-08-24 修复：position:relative 仍需保留（确保 toolbar 绘制在 stage 之上），
       但 z-index 从 50 降到 1——阅读器内所有层都不应高于思源原生 UI
       （顶栏"管理"菜单等），否则会把菜单压在下层（边框穿过菜单、无法点击）。 */
    position: relative;
    z-index: 1;
  }
  /* ================================================================
   * 2026-10-08 · 顶栏浮层化（默认开启，class:reader-toolbar-floating）
   * ================================================================
   * 对标底栏的「纯浮层 + 半透明毛玻璃 + 圆点把手 + 纯点击切换」范式。
   *
   * ## 为什么脱离文档流
   * 现状顶栏是 flex 子项（flex-shrink:0），**实打实占掉36px 阅读高度**，
   * 首行距顶 = 36 + marginTopPx。改为 absolute 后 .reader-stage（flex:1）
   * 立刻占满，首行距顶只剩 marginTopPx —— 这就是用户要的「文字更靠近上边框」。
   *
   * ## 为什么显隐**不写任何几何**
   * 收起/展开只改 opacity + transform，**不改变任何元素的盒子尺寸**
   * ⇒ 内容文档的分页/滚动几何完全不变：正文不重排、不跳页。
   * ⚠️ 绝不能在这里加「展开时给 margin-top 加一段占位」—— 那是 2026-10-07
   * 底栏那轮用户亲自否决的「动态占位」，且会让每次点圆点都重排正文。
   */
  .reader-toolbar-floating {
    position: absolute;
    top: 6px;
    left: 6px;
    right: 6px;
    /* z-index 高于 stage(0) / backdrop(1) / floating-layer(2)，与底栏(5)同级；
       圆点把手(7)在其之上。仍远低于思源原生 UI（同底栏的取值口径）。
       2026-10-24 Phase 1：z 值 token 化（--rz-*，见 reader-ui.less 分层表），下同。 */
    z-index: var(--rz-toolbar);
    /* 悬浮药丸条质感（与底栏对称）：思源 surface 底 + 圆角 + 半透明毛玻璃。
       不透明实色会「糊掉一块」，半透明能隐约看见底下的字，更像浮在上面。 */
    border-radius: var(--b3-border-radius, 8px);
    background: color-mix(in srgb, var(--b3-theme-surface, var(--b3-theme-background, #fff)) 82%, transparent);
    -webkit-backdrop-filter: blur(12px) saturate(1.2);
    backdrop-filter: blur(12px) saturate(1.2);
    box-shadow: var(--b3-point-shadow, 0 2px 10px rgba(0, 0, 0, 0.12));
    /* 顶部一道极淡的分隔线：与正文有边界但不突兀（与底栏 border-top 对称） */
    border-bottom: 1px solid color-mix(in srgb,
      var(--b3-border-color, rgba(255, 255, 255, 0.1)) 55%, transparent);
    /* 收起态：向上滑出 + 缩小，层次感与底栏对称 */
    opacity: 0;
    pointer-events: none;
    transform: translateY(-140%) scale(0.98);
    transition: opacity var(--reword-dur-base) var(--reword-ease),
      transform var(--reword-dur-base) var(--reword-ease);
  }
  /* 浮起态：滑入 + 回到原尺寸。pointer-events:auto 必须显式恢复
     （收起态设了 none，否则浮起后点不到栏内按钮）。 */
  .reader-toolbar-floating.reader-toolbar-revealed {
    opacity: 1;
    pointer-events: auto;
    transform: translateY(0) scale(1);
  }
  /* ⚠️ color-mix 兜底（与底栏同源教训）：上面那条 background 用的是
     `color-mix(...)`。若宿主环境不支持该函数，**整条声明会失效**，
     background 退为 transparent ⇒ 顶栏下方文字直接透出、控件不可见。
     故必须显式兜一个不透明底色。 */
  @supports not (color: color-mix(in srgb, red, blue)) {
    .reader-toolbar-floating {
      background: var(--b3-theme-surface, var(--b3-theme-background, #fff));
      border-bottom: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.1));
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .reader-toolbar-floating {
      transition: none;
    }
  }
  /* ================================================================
   * 顶栏「把手」：常驻顶部中央的小圆点（对标 .reader-bottom-handle）
   * ================================================================
   * ⚠️ 命中区高度必须夹到「不越过正文顶边」——
   * Readest `getHeaderTriggerHeight()` 的注释写明了踩过的坑（#4977/#5427）：
   * 触发区是个「盖子」，盖住的部分不能被选中/长按/点击；
   * 曾因写死 44px 而在页眉关闭、上边距变小后**盖住第一行、吞掉那里的划词**。
   * ⇒ 高度 = min(28, marginTopPx - 4)，由 applyTopHandleHitHeight() 写入
   *   `--reword-top-hit-h`；上边距过小时退化到 16px 最小值。
   */
  .reader-top-handle {
    position: absolute;
    left: 50%;
    top: 4px;
    /* 高于顶栏浮层(5)，与底栏把手(7)同一层 */
    z-index: var(--rz-handle);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--reword-top-hit-w, 28px);
    height: var(--reword-top-hit-h, 24px);
    padding: 0;
    border: none;
    border-radius: 50%;
    background: transparent;
    cursor: pointer;
    opacity: 0.5;
    transform: translateX(-50%);
    transition: top var(--reword-dur-base) var(--reword-ease),
      opacity var(--reword-dur-fast, 120ms) var(--reword-ease);
    pointer-events: auto;
  }
  .reader-top-handle:hover {
    opacity: 1;
  }
  /* 浮起态：从顶部 4px 上移到顶栏下方中央（顶栏高约 30 + 6px 顶距 + 8px 间隔）。
     与底栏把手的 .reader-bottom-handle-revealed{bottom:56px} 对称。 */
  .reader-top-handle.reader-top-handle-revealed {
    top: 44px;
  }
  .reader-top-handle-dot {
    display: block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--b3-theme-on-surface, #666);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
    transition: transform var(--reword-dur-fast, 120ms) var(--reword-ease),
      background-color var(--reword-dur-fast, 120ms) var(--reword-ease);
  }
  .reader-top-handle:hover .reader-top-handle-dot {
    transform: scale(1.35);
    background: var(--b3-theme-primary, #378add);
  }
  /* ===== 2026-10-25 角落自动翻页：L 形双条进度（Readest PageTurnHint 复刻） =====
     物理边定位（非 logical，RTL 下角检测已镜像、条仍在物理角上）；
     grown = 驻留进度（线性 500ms，从角点生长）；turned = 翻页瞬间（120ms 满长提亮一闪）。 */
  .reader-corner-hint {
    position: absolute;
    z-index: 4;
    pointer-events: none;
    overflow: hidden;
  }
  .reader-corner-bar-v,
  .reader-corner-bar-h {
    position: absolute;
    background: var(--b3-theme-on-surface, #333);
    border-radius: 999px;
    /* Readest armed=0.35；白底 3px 深灰 35% 偏淡，提到 0.5 保证「看得到进度」的承诺感 */
    opacity: 0.5;
    transition-property: transform, opacity;
    transition-timing-function: linear;
    transition-duration: 500ms;
  }
  /* tl 角：竖条沿左缘自顶向下、横条沿顶缘自左向右；at-*（br 角）镜像到右/底缘反向生长 */
  .reader-corner-bar-v {
    width: 3px;
    top: 0;
    bottom: 0;
    left: 0;
    transform: scaleY(0);
    transform-origin: top;
  }
  .reader-corner-bar-v.at-right {
    left: auto;
    right: 0;
    transform-origin: bottom;
  }
  .reader-corner-bar-h {
    height: 3px;
    left: 0;
    right: 0;
    top: 0;
    transform: scaleX(0);
    transform-origin: left;
  }
  .reader-corner-bar-h.at-bottom {
    top: auto;
    bottom: 0;
    transform-origin: right;
  }
  .reader-corner-bar-v.grown { transform: scaleY(1); }
  .reader-corner-bar-h.grown { transform: scaleX(1); }
  .reader-corner-bar-v.turned,
  .reader-corner-bar-h.turned {
    transition-duration: 120ms;
    opacity: 0.75;
    transform: scale(1);
  }
  @media (prefers-reduced-motion: reduce) {
    .reader-corner-bar-v,
    .reader-corner-bar-h {
      transition-duration: 0.01s;
    }
  }
  /* 2026-08-30 改造：3 段 grid 的子容器（替代旧 .reader-spacer 居中） */
  .reader-toolbar-left,
  .reader-toolbar-right {
    display: flex;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
  }
  /* 左组靠左、右组靠右：配合等宽 1fr 轨道，使中间标题真正居中 */
  .reader-toolbar-left {
    justify-content: flex-start;
  }
  .reader-toolbar-right {
    justify-content: flex-end;
  }
  .reader-toolbar-title {
    display: flex;
    align-items: baseline;
    justify-content: center;
    /* 关键：让书名/章节挤在中央，长标题 ellipsis（min-width:0 允许列收缩） */
    min-width: 0;
    gap: 6px;
    padding: 0 8px;
  }
  /* 书名与章节之间的分隔点（章节名与书名相同时整组不渲染） */
  .reader-title-sep {
    color: var(--b3-theme-on-surface-light, #888);
    font-size: 12px;
    flex-shrink: 0;
  }
  /* ⚠️ 2026-10-08：这条**只服务「顶栏悬浮」关闭时的旧行为**（topBarFloating=false，
     即 2026-10-08 之前顶栏常驻文档流、中心点击切换显隐）。
     悬浮模式下顶栏的收起态由 .reader-toolbar-floating 的
     opacity/transform 承担 —— 绝不能用 display:none，
     那会让整个元素从渲染树消失、过渡动画无从播放。 */
  .reader-toolbar-hidden {
    display: none;
  }
  /* 2026-08-29 Phase 1：触屏设备放大点按目标，避免误触（仅 coarse 指针生效） */
  @media (pointer: coarse) {
    .reader-btn { min-height: 36px; padding: 8px 10px; }
    .reader-mini-btn { min-height: 32px; min-width: 32px; }
  }
  .reader-btn {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 13px;
    line-height: 1;
    padding: 5px 7px;
    border-radius: var(--b3-border-radius-s, 6px);
    color: var(--b3-theme-on-background, #333);
    transition: background 150ms ease, color 150ms ease;
  }
  .reader-btn:hover {
    background: var(--b3-theme-background-light, rgba(0, 0, 0, 0.06));
  }
  .reader-btn-active {
    background: var(--b3-theme-primary-light, rgba(55, 138, 221, 0.18));
    color: var(--b3-theme-primary, #378add);
  }
  /* 双语按钮开启态、翻译忙碌态、PDF 缩放组 / 页码组样式已随界面分流迁至
     全局 src/reader/reader-controls.less（2026-09-02）——这些 DOM 现在由
     BookToolbar / PdfToolbar 渲染，Svelte scoped 样式命中不到子组件内部元素。 */
  .reader-title {
    font-size: 13px;
    font-weight: 500;
    /* 2026-08-30 改造：grid 居中布局，去掉 34% 硬上限，让 ellipsis 由父容器 .reader-toolbar-title 的 min-width:0 控制 */
    max-width: 100%;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--b3-theme-on-background, #333);
    user-select: auto;
    cursor: text;
  }
  /* [REword patch 2026-08-29] 移动端 PDF 适配 Phase 1 · iPhone / Android Phone 降级模式
   * 工具栏改底部 sheet + 触摸区 ≥44px */
  .reader-toolbar-iphone {
    /* ⚠️ 2026-10-08 修正一处**从未生效过**的既有缺陷。
     *
     * 原来的写法是 `top: auto; bottom: 0`，意图把顶栏变成底部 sheet。
     * 但基类 `.reader-toolbar` 只有 `position: relative`——
     * **`position: relative` + `bottom: 0` = 位移 0**，所以这段一直是死代码，
     * iPhone 模式下顶栏实际仍在顶部。
     *
     * 顶栏浮层化后基类变成 `position: absolute`，这段会**突然开始生效**
     * ⇒ iPhone 上顶栏掉到底部、与底栏（也是 bottom 浮层）**直接重叠**。
     * 两种可能的结果都更糟：要么控件互相盖住点不到，要么画面的底边糊成两条。
     *
     * ⇒ 显式钉回顶部。顶部悬浮在本项目里是被验证过的形态，
     *    而「底部 sheet」需要连带重做底栏的移动端布局，超出本次范围。
     *    若将来真要做移动端底部 sheet，应作为一次独立改造（同时重做底栏）。 */
    top: 6px;
    bottom: auto;
    border-top: none;
    border-bottom: 1px solid color-mix(in srgb,
      var(--b3-border-color, rgba(255, 255, 255, 0.1)) 55%, transparent);
    padding: 6px 8px;
    gap: 4px;
    justify-content: space-between;
  }
  .reader-toolbar-iphone .reader-btn {
    min-width: 44px;
    min-height: 44px;
    padding: 10px 12px;
    font-size: 16px;
  }
  /* iPhone 模式下 .reader-zoom-btn / .reader-zoom-label 的放大规则见
     全局 src/reader/reader-controls.less（2026-09-02 界面分流后这两个元素
     由 PdfToolbar 渲染，scoped 后代选择器命中不到）。 */
  /* iPhone 模式：标题简化（只保留标题，省略章节） */
  .reader-toolbar-iphone .reader-title {
    max-width: 40%;
  }
  .reader-chapter {
    font-size: 12px;
    color: var(--b3-theme-on-surface-light, #888);
    /* 2026-10-10：原为 max-width:36% —— 章节名被硬限在很窄的宽度，
       「4. 越笨...」这类稍长的章节名必然被截断（真机反馈）。
       改为不限死宽、随父容器分配：正常长度完整显示，
       极长时仍由父级 .reader-toolbar-title 的 min-width:0 + ellipsis 兜底。 */
    max-width: 100%;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    user-select: auto;
    cursor: text;
  }
  .reader-spacer {
    flex: 1;
  }
  .reader-progress {
    font-size: 12px;
    color: var(--b3-theme-on-surface-light, #888);
    min-width: 36px;
    text-align: right;
  }
  /* 设置按钮移到顶部右侧：与进度百分比 2% 之间留出 2px 间距 */
  .reader-settings-btn {
    margin-left: 2px;
  }
  /* 点击空白收起遮罩：popover 打开时覆盖正文区，把「iframe 内点击」转为「主文档点击」。
     同时 onContainerMouseDown 绑在 .reader-view 容器上（不再监听 document），
     避免影响思源顶栏"管理"等原生 UI 的点击时序。
     transparent 而非无背景，确保可接收点击（pointer-events 默认 auto）。 */
  .reader-backdrop {
    position: absolute;
    /* ⚠️ 2026-10-08 顶栏浮层化：34 → 44。
     * 旧值 34 是「顶栏在文档流里占 34px」的硬编码锚点。
     * 顶栏浮起时它是 `top: 6px + 高约 30px = 底沿约 36px` 的**浮层**，
     * backdrop 若还从 34 开始，就会**盖住顶栏最下方的 2~10px**
     * —— 那段区域点空白会命中 backdrop（关抽屉）而不是顶栏按钮，
     * 顶栏下沿会变成一条「点不动的死带」。
     * 44 = 浮起态顶栏底沿(≈36) + 8px 余量，稳定覆盖不到交互元素。 */
    top: 44px;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: var(--rz-backdrop);
    background: transparent;
  }

  /* 2026-08-23 修复：浮层容器（划词/词典/批注/toast 全部纳入）
     - position: absolute（相对 .reader-view 容器，不脱离视口）
     - inset: 0（占满容器）
     - pointer-events: none（默认不拦截，让背后 foliate-view / 正文可点）
     - 子元素显式 pointer-events: auto（需要交互时启用）
     - z-index: 2（浮在 foliate-view 之上，但远低于思源原生 UI，不压菜单） */
  .reader-floating-layer {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: var(--rz-floating);
  }

  .reader-floating-layer > * {
    pointer-events: auto;
  }

  /* 2026-10-14 P1：选区两端「定位标识」手柄（对齐微信读书：小圆点 + 细竖 caret，竖条高度=行高）。
     圆点落在选区首行左上 / 末行右下；竖条沿行方向探入正文，拖拽实时改选区（见 onSelHandlePointerDown）。
     margin 负半尺寸让 left/top 命中圆点中心；竖条高度用 --sh（由 updateSelHandles 按行高注入），随字号缩放。 */
  .reader-sel-handle {
    position: absolute;
    width: 11px;
    height: 11px;
    margin: -5.5px 0 0 -5.5px;
    border-radius: 50%;
    background: var(--b3-theme-primary, #3b82f6);
    border: 1.5px solid #fff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.28);
    pointer-events: auto;
    touch-action: none; /* 拖拽优先于滚动/系统选区 */
    cursor: ew-resize;
    z-index: var(--rz-sel-handle);
  }
  .reader-sel-handle::before {
    content: "";
    position: absolute;
    left: 50%;
    width: 2px;
    height: var(--sh, 20px);
    margin-left: -1px;
    border-radius: 1px;
    background: var(--b3-theme-primary, #3b82f6);
  }
  .reader-sel-handle--start::before { top: 50%; }  /* 起点：竖条从圆心向下探入首行 */
  .reader-sel-handle--end::before { bottom: 50%; }  /* 终点：竖条从圆心向上探入末行 */
  .reader-sel-handle.active { transform: scale(1.25); }

  /* 2026-10-24 批 C：页边驻留提示 —— 手柄拖进页边带、还没到翻页时长时出现的方向提示。
     只锚在指针旁、不占布局、pointer-events:none（挡住手柄自身命中就麻烦了）；
     动效只用透明度，不做位移（抖动会干扰正在拖拽的手柄）。 */
  .reader-edge-hint {
    position: absolute;
    width: 26px;
    height: 26px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: rgba(28, 28, 30, 0.78);
    color: #fff;
    font-size: 17px;
    line-height: 1;
    transform: translate(10px, -50%);
    pointer-events: none;
    z-index: 5;
    animation: reader-edge-hint-pulse 320ms ease-out infinite alternate;
  }
  .reader-edge-hint--prev { transform: translate(-10px, -50%) translateX(-100%); }
  @keyframes reader-edge-hint-pulse {
    from { opacity: 0.5; }
    to { opacity: 1; }
  }

  /* 划词工具栏（微信读书式恒深色）：定位到锚点，主栏在上、样式行在**下方**。
     2026-10-11 微信读书化：
       · 恒深色（用户拍板 D1）：两套主题下都是深色 —— 这是微信读书的品牌识别，
         也是「浮在任意版面上都保证白字对比度」的工程选择。全部收敛到 --rwd-sel-* 局部变量。
       · DOM 顺序 [主栏, 样式行]；place=above（默认）经 column-reverse 把样式行翻到主栏
         **上方**（2026-10-13 P0-2 转场钉住主栏，见 .place-above 规则处说明），
         place=below/left/right 为原生 column（样式行在下方）。align-items: stretch 让两行等宽，药丸两端对齐。
       · 小三角挂在**容器**上（旧版挂 .reader-sel-main）：贴锚点的始终是主栏那一侧
         （above 由 column-reverse 保证），样式行展开时三角仍指着选区、不会指着样式行。 */
  .reader-sel-toolbar {
    position: absolute;
    left: 0;
    top: 0;
    transform: translate(-50%, -100%);
    z-index: var(--rz-sel-toolbar);
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
    pointer-events: none; /* 容器不拦截，子元素自动开启 */
    /* 2026-10-26：工具栏自身不可被选中。
       否则长按工具栏上的按钮会选中按钮文字，iOS 弹「复制/查找」callout、
       Android 弹原生菜单 —— 都会压在工具栏上（用户反馈的「两层混在一起」）。 */
    -webkit-user-select: none;
    -moz-user-select: none;
    -ms-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
    /* 恒深色令牌：主栏 / 药丸 / 三角共用（改动只改这一处） */
    --rwd-sel-bg: rgba(28, 29, 31, 0.94);
    --rwd-sel-fg: #ffffff;
    --rwd-sel-dim: rgba(255, 255, 255, 0.62);
    --rwd-sel-hover: rgba(255, 255, 255, 0.12);
    --rwd-sel-active: rgba(255, 255, 255, 0.2);
  }
  .reader-sel-toolbar > * { pointer-events: auto; }
  /* 顶部空间不足翻到选区下方时：锚点改取选区下沿，工具栏向下延伸（而非向上覆盖选区） */
  .reader-sel-toolbar.place-below { transform: translate(-50%, 0); }
  /* 2026-08-29 四向避让：上下均无空间时退到选区左/右（垂直居中于选区），彻底避开选中文本 */
  .reader-sel-toolbar.place-left { transform: translate(-100%, -50%); }
  .reader-sel-toolbar.place-right { transform: translate(0, -50%); }
  /* 2026-10-13 P0-2：place=above 时把样式行翻到主栏【上方】（column-reverse）。
     治「点标注后工具栏闪一下」：create→edit 转场时样式行让总高 +47px，而 above 的
     锚定语义是「容器底边贴锚点」——样式行若照旧长在主栏下方（向下探出），主栏会被
     整条上推 47px；翻到上方后容器底边=主栏底边，主栏零位移，样式行从主栏上沿折出
     （transform-origin 同步换到底边，见 .reader-sel-strip-row 规则）。
     ⚠️ 只翻 above：below 的锚点是容器顶边（贴的正是主栏顶边，本就零位移）；
     left/right 容器垂直居中，由 openHighlightEditToolbar 的锚点补偿（+stripH/2）处理。 */
  .reader-sel-toolbar.place-above { flex-direction: column-reverse; }
  .reader-sel-toolbar.place-left .reader-sel-main,
  .reader-sel-toolbar.place-right .reader-sel-main {
    transform-origin: center center;
  }
  /* 小三角：指向选区。默认（above）= 容器底边朝下；place-below 翻到顶边朝上。 */
  .reader-sel-toolbar::after {
    content: "";
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    width: 0; height: 0;
    border-left: 7px solid transparent;
    border-right: 7px solid transparent;
    border-top: 7px solid var(--rwd-sel-bg);
    bottom: -8px;
    pointer-events: none;
  }
  .reader-sel-toolbar.place-below::after {
    top: -7px; bottom: auto;
    border-top: none;
    border-bottom: 7px solid var(--rwd-sel-bg);
  }
  /* 左置：小三角在右边缘、朝右指向选区 */
  .reader-sel-toolbar.place-left::after {
    left: auto; right: -7px; top: 50%; bottom: auto;
    transform: translateY(-50%);
    border-top: 7px solid transparent;
    border-bottom: 7px solid transparent;
    border-left: 7px solid var(--rwd-sel-bg);
    border-right: none;
  }
  /* 右置：小三角在左边缘、朝左指向选区 */
  .reader-sel-toolbar.place-right::after {
    left: -7px; right: auto; top: 50%; bottom: auto;
    transform: translateY(-50%);
    border-top: 7px solid transparent;
    border-bottom: 7px solid transparent;
    border-right: 7px solid var(--rwd-sel-bg);
    border-left: none;
  }

  /* 主栏：微信读书式「图标 + 标签」恒深色横条（2026-10-11）
     ------------------------------------------------------------------
     规格（对齐素材①）：
       · 高 54px、按钮 44px 高（图标 16 + 间距 3 + 10px 标签 = 29 居中）——
         44px 高度是为触屏留的可点面积（移动端手测清单要求）
       · min-width 300px（2026-10-23）：
         两态标签统一为 2 字（标注 / 删除），按钮天然等宽 36px、共 7×36=252 + 6×2 最小 gap
         + 12 padding = 276，300 给同样留 24px 自由 → 视觉间隙都 ≈6px，且「标注 ⇄ 删除」
         切换时零位移（无需 slot2：两态都是 7×36）。8 项（搜索开启）自然宽 314 > 300，无副作用。
       · 圆角 10px、无毛玻璃（恒深色不透明底，避免透出下方选中文字）
       · space-between：按钮等距撑开，两端贴 padding 边 */
  .reader-sel-main {
    display: flex;
    align-items: center;
    justify-content: space-between;
    /* 标签已提供呼吸感，gap 只需把按钮分开 2px（微信读书等距、偏松） */
    gap: 2px;
    height: 54px;
    min-width: 300px;                 /* 两态 7×36 等宽 + 零位移，见上方规格注释 */
    padding: 0 6px;
    box-sizing: border-box;
    background: var(--rwd-sel-bg);
    border: 1px solid rgba(255, 255, 255, 0.10);
    border-radius: 10px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28);
    color: var(--rwd-sel-fg);
    transform-origin: center bottom;
    animation: readerToolbarIn 0.16s cubic-bezier(0.22, 1, 0.36, 1) both;
    position: relative;
  }
  /* ⚠️ 小三角已移到 .reader-sel-toolbar::after（见该规则处的说明），
     因为样式行在主栏**下方**：挂在主栏上时会指向样式行而不是选区。 */
  /* place-below 时主栏位于选区下方，入场动画从顶边「探出」 */
  .reader-sel-toolbar.place-below .reader-sel-main {
    transform-origin: center top;
  }
  @keyframes readerToolbarIn {
    from { opacity: 0; transform: scale(0.9) translateY(4px); }
    to { opacity: 1; transform: scale(1) translateY(0); }
  }
  .reader-sel-item {
    border: none;
    background: transparent;
    color: inherit;                /* 跟随容器 --rwd-sel-fg */
    /* 微信读书式：竖向「图标 + 标签」，min-width 36 保证标签不挤。
       两态标签统一为 2 字（标注 / 删除），所有按钮等宽 36px，无需 slot2 预留。 */
    min-width: 36px;
    height: 44px;                  /* 触屏可点面积（图标 16 + 间距 3 + 标签 10 = 29，居中） */
    padding: 0 6px;
    box-sizing: border-box;
    border-radius: 7px;
    cursor: pointer;
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    position: relative;           /* 供「标注」样式角标定位 */
    transition: background 0.12s ease, transform 0.1s ease;
  }
  .reader-sel-item:hover {
    /* 深底上用固定白 alpha，不用主题 --b3-list-hover（浅色主题的值会变得几乎不可见） */
    background: var(--rwd-sel-hover);
  }
  .reader-sel-item:active { transform: scale(0.94); }
  /* ⚠️ 必须用 CSS 强制 fill/stroke，不能只靠 SVG 属性。
     原因（2026-10-07 实测）：SVG 的 presentation attribute（fill="none"）
     优先级**最低**，任何 CSS 规则都能覆盖它。思源全局样式给 `svg` 设了
     `fill: currentColor`，于是工具栏里所有线性图标被**实心填充**成黑块
     （截图表现：图标全是厚重黑块，完全不是线条图）。
     → CSS 规则优先级高于 attribute，必须在这里显式声明。
     stroke-width 同理：写死 1.8，不让宿主改粗细。1.8 不是随手取的 ——
     stroke-width 按 24 单位 viewBox 缩放，16px 下约 1.2px 厚。
     与 src/reader/bookshelf-icons.less 那张换算表同源，改一处要改三处。 */
  .reader-sel-item :global(svg),
  .reader-sel-ico :global(svg) {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  /* 宿主可能对 `svg` **或** `path`/`rect`/`circle` 直接设 fill，
     后者无法靠继承对抗 —— 逐个子元素声明一遍。
     用 :global 是因为 path 等由 {@html} 注入，Svelte 不给它们加 scope 类。 */
  .reader-sel-item :global(svg path),
  .reader-sel-item :global(svg rect),
  .reader-sel-item :global(svg circle),
  .reader-sel-item :global(svg line),
  .reader-sel-item :global(svg polyline),
  .reader-sel-item :global(svg polygon) {
    fill: none;
  }
  /* 角标是实心圆点，必须显式覆盖 fill: none 与 stroke */
  .reader-sel-style-preview {
    stroke: none;
  }
  .reader-sel-ico {
    display: inline-flex;
    line-height: 0;
  }
  /* 按钮下方的 10px 标签（微信读书式）。用暗一档的白（--rwd-sel-dim），
     图标保持纯白 —— 层级靠明度差，不靠字号（字号在 10px 已到底）。 */
  .reader-sel-txt {
    font-size: 10px;
    line-height: 1;
    color: var(--rwd-sel-dim);
    white-space: nowrap;
  }
  /* 主操作（标注/批注）：底色与其他按钮一致（微信读书八项同色），只在 hover 时给反馈。
     P2（2026-10-12）删掉 `.active` 三态规则：两枚 accent 按钮都没有 class:active 绑定
     （工具栏的激活态在药丸行 .reader-sel-style-btn / .reader-sel-color-dot 上）⇒ 纯死样式。 */
  .reader-sel-item-accent {
    color: inherit;
    background: transparent;
  }
  .reader-sel-item-accent:hover {
    background: var(--rwd-sel-hover);
  }
  .reader-sel-item-danger .reader-sel-ico :global(svg),
  .reader-sel-item-danger .reader-sel-txt { color: #e5646e; }
  .reader-sel-item-danger:hover { background: rgba(229, 100, 110, 0.16); }
  /* 标注 / 删除 等宽（2026-10-23）：
     旧版用 .reader-sel-item-slot2 给「删除划线」(4 字) 预留 56px，保证编辑态不把格子撑宽；
     现编辑态标签缩为「删除」(2 字)，两态都是 36px，等宽由结构保证，slot2 已废弃删除。 */

  /* ---- 「标注」按钮的样式预览角标（图标右上角） ----
     2026-10-11 改为「图标 + 标签」竖排后，角标不能再按 32×32 纯图标按钮的
     `top/right: 6px` 定位（按钮变宽变高，角标会飘到空白处）。
     改用「水平居中 + 右移 4px」：16px 图标以按钮中心对齐 ⇒ 中心 +4px 即图标右上角，
     与按钮实际宽度无关。 */
  .reader-sel-style-preview {
    position: absolute;
    top: 5px;
    left: 50%;
    margin-left: 4px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--spc, var(--b3-theme-primary, #378add));
    /* 描一圈容器底色，角标压在图标上时仍能看清 */
    box-shadow: 0 0 0 1.5px var(--rwd-sel-bg);
    pointer-events: none;
  }
  /**
   * 三种线型的区分（2026-10-07 由「横条」改为「圆点角标」后的新做法）。
   *
   * 横条时代靠「不同厚度」区分（3px/2px/3px）；圆点只有 7px，厚度差异
   * 在这个尺寸下看不出来。故改为**形状**区分：
   *   高亮（荧光笔）= 实心方块
   *   实线= 实心圆
   *   波浪= 空心圆环
   * 7px 的尺度下形状差异比厚度差异更容易辨认。
   */
  .reader-sel-style-preview.style-highlight {
    border-radius: 2px;
    opacity: 0.95;
  }
  .reader-sel-style-preview.style-solid {
    border-radius: 50%;
  }
  .reader-sel-style-preview.style-wavy {
    /* 空心环 = 波浪线 */
    background: transparent;
    border: 2px solid var(--spc, var(--b3-theme-primary, #378add));
  }

  /* ---- 样式行（微信读书式，2026-10-11 重做） ----
     一行两枚深色药丸：左 = 3 线型，右 = 5 色点；行宽撑满主栏、两端对齐。
     ⚠️ 渲染方位随 place 变化（2026-10-13 P0-2）：
        above          → column-reverse 翻到主栏上方，从主栏上沿向上折出（origin: bottom center）
        below/left/right → 原生在主栏下方，从主栏下沿向下探出（origin: top center）
     两种方位都「长在主栏背离选区的那一侧」⇒ create→edit 转场时主栏零位移。 */
  .reader-sel-strip-row {
    display: flex;
    align-items: stretch;
    justify-content: space-between;
    gap: 12px;
    white-space: nowrap;
    transform-origin: top center;
    animation: selStripIn 0.16s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  /* above：样式行在主栏上方 ⇒ 改从贴主栏的那一边（底边）折出 */
  .reader-sel-toolbar.place-above .reader-sel-strip-row { transform-origin: bottom center; }
  /* 2026-10-13 P2-6：时长 0.22s→0.16s、去掉 translateY 位移——位移是「弹一下」
     观感的来源；只留淡入 + 轻缩放（0.96），方向感交由 transform-origin 分档承担。 */
  @keyframes selStripIn {
    from { opacity: 0; transform: scale(0.96); }
    to { opacity: 1; transform: scale(1); }
  }
  /* ⚠️ 不要用 `animation: none` 关动画：这些规则都带 fill-mode both，
     置空后「入场中间态」会直接消失、首帧测量与视觉一起错位（Demo 已实测复现）。
     用近零时长：视觉即时、动画仍在。
     退出动画同理不依赖 animationend —— 卸载由 JS 的 SEL_TOOLBAR_OUT_MS 计时器驱动，
     见 closeSelToolbar()，reduced-motion 时 JS 直接跳过动画硬关。 */
  @media (prefers-reduced-motion: reduce) {
    .reader-sel-main { animation-duration: 0.01s; }
    .reader-sel-strip-row { animation-duration: 0.01s; }
  }

  /* ---- 退出动画（2026-10-12 P1-D8，方案 §5.2） ----
     closing 态：DOM 还在（visible 仍为 true），JS 到 SEL_TOOLBAR_OUT_MS 后才真正卸载。
     🔴 缩放不能挂在容器上：.reader-sel-toolbar 的 transform 是**定位锚点**
        （translate(-50%,-100%) 及 place-* 的四个变体），动画覆盖它 = 工具栏瞬移。
        ⇒ 容器只做 opacity，scale 挂在主栏/样式行上（它们的 transform-origin 已按 place 分档）。 */
  .reader-sel-toolbar.closing {
    animation: selToolbarFadeOut 0.14s ease both;
    /* 淡出期间不能再吃点击：否则误点空白处会吞掉用户下一次划词 */
    pointer-events: none;
  }
  .reader-sel-toolbar.closing > * { pointer-events: none; }
  .reader-sel-toolbar.closing .reader-sel-main,
  .reader-sel-toolbar.closing .reader-sel-strip-row {
    animation: selToolbarShrinkOut 0.14s ease both;
  }
  @keyframes selToolbarFadeOut {
    from { opacity: 1; }
    to { opacity: 0; }
  }
  @keyframes selToolbarShrinkOut {
    from { opacity: 1; transform: scale(1); }
    to { opacity: 0; transform: scale(0.94); }
  }
  .reader-sel-pill {
    display: inline-flex;
    align-items: center;
    padding: 6px 8px;
    box-sizing: border-box;
    background: var(--rwd-sel-bg);
    border: 1px solid rgba(255, 255, 255, 0.10);
    border-radius: 10px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28);
  }
  .reader-sel-pill-styles { gap: 2px; }
  .reader-sel-pill-colors { gap: 8px; }
  .reader-sel-style-btn {
    border: none;
    background: transparent;
    padding: 5px 7px;
    border-radius: 6px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    /* 字号/行高必须钉住：药丸高度（= 常量 TOOLBAR_WITH_STRIP_H 的推导依据）靠它算准，
       且 .reader-style-glyph 是 inline-block（高度 = 行盒 = line-height=1 → 15px）。 */
    font-size: 15px;
    line-height: 1;
    transition: background 0.12s ease;
  }
  .reader-sel-style-btn:hover { background: var(--rwd-sel-hover); }
  .reader-sel-style-btn.active { background: var(--rwd-sel-active); }
  .reader-sel-color-dot {
    position: relative;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    border: none;
    cursor: pointer;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: transform 0.12s ease, box-shadow 0.12s ease;
  }
  .reader-sel-color-dot:hover { transform: scale(1.12); }
  /* 当前色：白色 ✓ 徽章 + 白色描边环（对齐素材①；深底上比"光环"更好认） */
  .reader-sel-color-dot.active { box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.92); }
  .reader-sel-color-check {
    display: inline-flex;
    line-height: 0;
    /* 深色 ✓：五个色（含明黄）上都能看清；白色在黄色/青色上对比不足 */
    color: rgba(0, 0, 0, 0.76);
    pointer-events: none;
  }
  .reader-sel-color-check :global(svg) {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* ---- 窄屏兜底（2026-10-12 P1-§6.4） ----
     JS 侧 selToolbarNarrow() 判定「可读区 < TOOLBAR_NARROW_BELOW(316) px」后挂 .narrow。
     思路是**压掉留白，不动字号与图标尺寸**：主栏 min-width 300 是「两态等宽 + 视觉呼吸」
     的预留，窄屏下它是第一块该让路的成本；按钮 padding、行间距、药丸内边距同理会呼吸变紧。
     ⚠️ 硬约束：
       · 不用方案 §6.4 原写的 `max-width + overflow-x: auto`：overflow 会把主栏和药丸的
         box-shadow 裁掉一圈，还会在深色卡片内部冒出滚动条。压留白是不牺牲视觉的替代解。
     压完的自然宽 ≈251px（样式行两枚药丸为上限），479px 屏侧栏展开后仍放得下。 */
  .reader-sel-toolbar.narrow .reader-sel-main {
    min-width: 0;
    gap: 0;
    padding: 0 2px;
  }
  .reader-sel-toolbar.narrow .reader-sel-item {
    min-width: 0;
    padding: 0 4px;
  }
  .reader-sel-toolbar.narrow .reader-sel-strip-row { gap: 6px; }
  .reader-sel-toolbar.narrow .reader-sel-pill { padding: 6px 6px; }
  .reader-sel-toolbar.narrow .reader-sel-pill-colors { gap: 6px; }
  .reader-sel-toolbar.narrow .reader-sel-style-btn { padding: 5px 4px; }

  /* 样式字形（A 字符 + 装饰线，用于批注卡片的样式按钮预览）
     2026-10-13 重做装饰线：原先用 text-decoration 画线，但其绘制基线由浏览器
     内核决定——Chrome 对 wavy 的下划线位置比 solid 更靠下，小尺寸 A 字下
     三按钮不在同一水平线（真机截图确认）。改为 ::after 伪元素画线：
     bottom 统一定死，solid=色条、wavy=mask 波浪（data URI，色随 --sc），
     基线写死 → 三按钮永久水平对齐、跨浏览器一致。 */
  .reader-style-glyph {
    display: inline-block;
    font-family: serif;
    font-weight: 600;
    color: var(--sc, #62a2ff);
    position: relative;
  }
  .reader-style-glyph.style-highlight {
    background: color-mix(in srgb, var(--sc, #62a2ff) 35%, transparent);
    border-radius: 3px;
    padding: 0 2px;
  }
  .reader-style-glyph.style-solid::after,
  .reader-style-glyph.style-wavy::after {
    content: "";
    position: absolute;
    left: 1px;
    right: 1px;
    bottom: 1px;
    height: 3px;
  }
  .reader-style-glyph.style-solid::after {
    height: 2px;
    background: var(--sc, #62a2ff);
    border-radius: 1px;
  }
  .reader-style-glyph.style-wavy::after {
    background-color: var(--sc, #62a2ff);
    -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='3'%3E%3Cpath d='M0 2 Q2 0.2 4 2 T8 2' fill='none' stroke='black' stroke-width='1.1' stroke-linecap='round'/%3E%3C/svg%3E") repeat-x left bottom / 8px 3px;
    mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='3'%3E%3Cpath d='M0 2 Q2 0.2 4 2 T8 2' fill='none' stroke='black' stroke-width='1.1' stroke-linecap='round'/%3E%3C/svg%3E") repeat-x left bottom / 8px 3px;
  }

  /* 批注卡片（2026-10-08 重写）：紧凑横向卡片
     原文 / 工具条 / 笔记正文 / 动作 四行横排，宽 400px。
     ⚠️ width 必须与 JS 的 NOTE_CARD_W（400）一致 —— positionPopupNear 用它算夹紧范围，
        两边不同步会导致卡片右边被裁（测试 smoke-note-card.test.mjs 守着这条）。 */
  .reader-note-editor {
    position: absolute;
    left: 0;
    top: 0;
    transform: translate(-50%, 0);
    z-index: 4; /* 高于底部工具栏 */
    --note-card-w: 400px;
    width: var(--note-card-w);
    box-sizing: border-box;
    max-width: calc(100% - 16px); /* 相对容器（reader-view）而非视口，避免侧栏展开时溢出 */
    margin-top: 10px; /* 与选区拉开间距 */
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 9px;
    /* 🔴 深色关键改动（2026-10-08）：旧版用 --reword-glass-bg，
       玻璃拟态在深色主题下压到近黑、噪点全靠 backdrop-filter 的模糊噪声撑着。
       改为「surface 底 94% 混合透明」——深色下 surface ≈ #2b2f38，
       卡片抬到约 rgba(43,47,56,.94)，不再是黑洞。 */
    background: color-mix(in srgb, var(--b3-theme-surface, var(--b3-theme-background, #fff)) 94%, transparent);
    -webkit-backdrop-filter: blur(20px) saturate(1.3);
    backdrop-filter: blur(20px) saturate(1.3);
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.1));
    border-radius: 14px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.10), 0 1px 3px rgba(0, 0, 0, 0.06);
    color: var(--b3-theme-on-background, #222);
    pointer-events: auto;
  }
  /* ⚠️ color-mix 兜底（同顶栏/底栏的既有教训）：宿主不支持该函数时
     **整条 background 声明失效**，卡片变全透明、正文叠在书页上不可读。 */
  @supports not (color: color-mix(in srgb, red, blue)) {
    .reader-note-editor {
      background: var(--b3-theme-surface, var(--b3-theme-background, #fff));
    }
  }
  /* 深色主题下阴影需加重，否则卡片与深色背景糊在一起看不出层次 */
  :global(.b3-theme-dark) .reader-note-editor {
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.34), 0 1px 3px rgba(0, 0, 0, 0.24);
  }
  /* 2026-08-25 底部空间不足时翻转到选区上方：transform 翻转 Y 轴 + 间距改到底部 */
  .reader-note-editor.place-above {
    transform: translate(-50%, -100%);
    margin-top: 0;
    margin-bottom: 10px;
  }
  /* 2026-08-29 四向避让：below=默认（translate(-50%,0)）；left/right=垂直居中于选区 */
  .reader-note-editor.place-below {
    transform: translate(-50%, 0);
    margin-top: 10px;
  }
  .reader-note-editor.place-left {
    transform: translate(-100%, -50%);
    margin-top: 0;
  }
  .reader-note-editor.place-right {
    transform: translate(0, -50%);
    margin-top: 0;
  }
  /* 小三角指向选中文本。
     ⚠️ 2026-10-08：颜色从 --reword-glass-bg 改为 --note-card-bg ——
     卡片底色换成了「surface 94% 混合透明」，小三角若还用旧变量会出现
     「三角颜色与卡片底色不一致」的错位。 */
  .reader-note-editor::after {
    content: "";
    position: absolute;
    width: 0;
    height: 0;
    border: 7px solid transparent;
    pointer-events: none;
  }
  .reader-note-editor.place-above::after {
    left: 50%;
    bottom: -13px;
    transform: translateX(-50%);
    border-top-color: var(--b3-theme-surface, var(--b3-theme-background, #fff));
  }
  .reader-note-editor.place-below::after {
    left: 50%;
    top: -13px;
    transform: translateX(-50%);
    border-bottom-color: var(--b3-theme-surface, var(--b3-theme-background, #fff));
  }
  .reader-note-editor.place-left::after {
    right: -13px;
    top: 50%;
    transform: translateY(-50%);
    border-left-color: var(--b3-theme-surface, var(--b3-theme-background, #fff));
  }
  .reader-note-editor.place-right::after {
    left: -13px;
    top: 50%;
    transform: translateY(-50%);
    border-right-color: var(--b3-theme-surface, var(--b3-theme-background, #fff));
  }
  /* ================================================================
   * 2026-10-08 · 批注卡片内部（四行横排 + 折叠悬浮）
   * ================================================================ */

  /* 行 1 · 原文引用 + 时间。单行省略 —— 长文不撑高卡片 */
  .reader-note-row-top {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .reader-note-excerpt {
    flex: 1;
    min-width: 0; /* 关键：没有它 flex 子项不会收缩，长文会把时间挤出去 */
    box-sizing: border-box; /* 同 input：padding + border 不得撑出容器 */
    padding: 5px 9px;
    background: var(--b3-theme-background-light, rgba(0, 0, 0, 0.03));
    border-radius: 7px;
    font-size: 12.5px;
    color: var(--b3-theme-on-background, #222);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .reader-note-time {
    flex-shrink: 0;
    font-size: 11px;
    color: var(--b3-theme-on-surface-light, #888);
    font-variant-numeric: tabular-nums; /* 等宽数字，避免时间跳动时宽度抖动 */
  }

  /* 行 2 · 工具条：左折叠触发器 + 空隙 + 右图标组
     2026-10-08：取消/保存并入后，右侧最多 6 个图标 ⇒ gap 6→5 收紧一档。 */
  .reader-note-tools {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .reader-note-spacer { flex: 1; }
  /* 竖分隔线：把「内容操作（复制/导出）」与「这张卡的操作（取消/保存/删除）」分开。
     纯装饰，故aria-hidden；flex: none 防止被 flex 压扁。 */
  .reader-note-sep {
    width: 1px;
    height: 16px;
    flex: none;
    margin: 0 2px;
    background: var(--b3-border-color, rgba(0, 0, 0, 0.1));
  }

  /* 折叠触发器：把一整组选项收成一个，显示当前值 */
  .reader-note-fold-wrap {
    position: relative;
    display: inline-flex;
  }
  .reader-note-fold {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 27px;
    padding: 0 9px;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.1));
    border-radius: 7px;
    background: var(--b3-theme-background-light, rgba(0, 0, 0, 0.03));
    color: inherit;
    font-size: 12.5px;
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.15s cubic-bezier(0.32, 0.72, 0.29, 1),
      border-color 0.15s cubic-bezier(0.32, 0.72, 0.29, 1);
  }
  .reader-note-fold:hover,
  .reader-note-fold.open {
    background: var(--b3-theme-primary-light, rgba(55, 138, 221, 0.16));
    border-color: var(--b3-primary, #378add);
  }
  .reader-note-fold-label { font-size: 12.5px; }
  .reader-note-caret {
    display: inline-flex;
    width: 9px;
    height: 9px;
    opacity: 0.5;
    transition: transform 0.18s cubic-bezier(0.32, 0.72, 0.29, 1);
  }
  .reader-note-caret :global(svg), .reader-note-caret :global(svg path) {
    width: 100%;
    height: 100%;
    display: block;
    /* 同上：箭头也是 {@html} 注入，必须显式压住 fill，否则被实心化成黑块 */
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .reader-note-fold.open .reader-note-caret { transform: rotate(180deg); }
  .reader-note-swatch {
    width: 13px;
    height: 13px;
    border-radius: 50%;
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.14);
    flex-shrink: 0;
  }

  /* 悬浮气泡：点触发器才出现 */
  .reader-note-pop {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 20; /* 高于卡片自身，保证不被裁切 */
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 5px;
    border-radius: 10px;
    background: var(--b3-theme-background, #fff);
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.1));
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.14), 0 1px 4px rgba(0, 0, 0, 0.08);
    animation: readerNotePopIn 0.14s cubic-bezier(0.32, 0.72, 0.29, 1);
  }
  @keyframes readerNotePopIn {
    from { opacity: 0; transform: translateY(-3px) scale(0.97); }
    to   { opacity: 1; transform: none; }
  }
  .reader-note-opt {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 26px;
    padding: 0;
    border: none;
    border-radius: 7px;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  .reader-note-opt:hover { background: var(--b3-theme-primary-light, rgba(55, 138, 221, 0.16)); }
  .reader-note-opt.on {
    background: var(--b3-theme-primary-light, rgba(55, 138, 221, 0.16));
    box-shadow: inset 0 0 0 1.5px var(--b3-primary, #378add);
  }
  .reader-note-opt-dot {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.14);
  }

  /* 工具条右侧的图标按钮（纯图标，省横向空间）。
     2026-10-08：取消/保存并入后最多 6 个并排，27→26 / svg 15→14 更紧凑。 */
  .reader-note-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    padding: 0;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.1));
    border-radius: 7px;
    background: var(--b3-theme-background-light, rgba(0, 0, 0, 0.03));
    color: inherit;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }
  /* 🔴🔴 必须显式声明 fill/stroke，不能只写尺寸！
 *
 * 根因（项目里已踩过一次，`.reader-sel-ico` 处有完整记录）：
 * **SVG 的 presentation attribute（`fill="none"`）优先级最低**，
 * 任何 CSS 规则都能覆盖它 —— 而**思源全局样式给 `svg` 设了 `fill: currentColor`**。
 * 于是我生成的线条图标被**实心填充**成黑块（真机截图：复制/导出/删除全是黑方块）。
 *
 *我第一版只给了 `width/height`，漏了 fill/stroke ⇒ 复现了同一个坑。
 * ⇒ 这段规则必须与 `.reader-sel-ico` 那份**同等完整**，不能图省事只写尺寸。
 * stroke-width 同理：这一档是 14px，配 2.0 才落到 ~1.17px 厚（换算见 bookshelf-icons.less）。 */
  .reader-note-icon :global(svg),
  .reader-note-ico :global(svg) {
    width: 14px;
    height: 14px;
    display: block;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  /* 宿主可能对 `svg` **或**直接对 `path`/`rect`/`circle` 设 fill，
     后者无法靠继承对抗 —— 逐个子元素声明一遍。
     用 :global 是因为 path 等由 {@html} 注入，Svelte 不给它们加 scope 类。 */
  .reader-note-icon :global(svg path),
  .reader-note-icon :global(svg rect),
  .reader-note-icon :global(svg circle),
  .reader-note-icon :global(svg line),
  .reader-note-icon :global(svg polyline),
  .reader-note-icon :global(svg polygon) {
    fill: none;
  }
  /* 折叠触发器里的箭头：完整 fill/stroke 规则在下方与图标按钮合并声明
     （同样是 {@html} 注入的 SVG，同样会被宿主 fill:currentColor 实心化） */
  /* 图标包裹层：明确 display + 尺寸 + 颜色继承（与 .reader-sel-ico 同款） */
  .reader-note-ico {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    line-height: 0; /* 消除 inline 基线下的下方空隙 */
    color: inherit; /* 跟随按钮的 color，深色下自动反色 */
  }
  .reader-note-icon:hover {
    background: var(--b3-theme-primary-light, rgba(55, 138, 221, 0.16));
    border-color: var(--b3-primary, #378add);
  }
  /* 主操作（保存）：6 个等宽方块里唯一的「提交」动作，
     全素色会失去焦点⇒ 主色实心。
     hover 用 brightness 而不是换背景色 —— 换色会与 .reader-note-icon:hover 打架。 */
  .reader-note-icon.primary {
    color: #fff;
    background: var(--b3-primary, #378add);
    border-color: var(--b3-primary, #378add);
  }
  .reader-note-icon.primary:hover {
    background: var(--b3-primary, #378add);
    border-color: var(--b3-primary, #378add);
    filter: brightness(1.08);
  }
  .reader-note-icon.danger:hover {
    background: rgba(229, 72, 74, 0.14);
    border-color: #e5484d;
    color: #e5484d;
  }

  /* 行 3 · 笔记正文 */
  .reader-note-input {
    /* 🔴 box-sizing 必须显式写 —— 旧定义里有这行，重写时漏了。
       缺失的后果：`width:100%` + padding 8/10 + border 1 各左右共 +22px
       ⇒ textarea 比容器宽，右边缘**戳出卡片外**（真机报障「输入框超出弹窗」）。 */
    box-sizing: border-box;
    width: 100%;
    min-height: 62px;
    max-height: 130px;
    resize: vertical;
    padding: 8px 10px;
    border-radius: 10px;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.1));
    background: var(--b3-theme-background-light, rgba(0, 0, 0, 0.03));
    color: inherit;
    font: inherit;
    font-size: 13px;
    line-height: 1.65;
    display: block; /* textarea 默认 inline-block，父级 flex 下会带 baseline 间隙 */
  }
  .reader-note-input::placeholder { color: var(--b3-theme-on-surface-light, #888); }
  .reader-note-input:focus {
    outline: none;
    border-color: var(--b3-primary, #378add);
    background: var(--b3-theme-background, #fff);
  }
  /* 查看态的正文区：也是 textarea（可编辑），但去掉聚焦高亮 ——
     用户不该觉得「进入了编辑模式」，改完自动保存就生效 */
  .reader-note-input.viewer:focus {
    border-color: var(--b3-border-color, rgba(0, 0, 0, 0.1));
    background: var(--b3-theme-background-light, rgba(0, 0, 0, 0.03));
  }

  /*⚠️ 2026-10-08 删除了原「行 4 · 动作区」的全部样式：
     `.reader-note-actions` / `.reader-note-kbd` / `.reader-note-kbd-cap`
     / `.reader-note-btn` / `.reader-note-btn-primary`。
     原因：取消/保存已并入行 2 的图标组、快捷键提示按用户要求整行删除，
     这五项**全部失去唯一调用方**（已 grep 确认全项目无其它引用）。
     其中 `.reader-note-actions` 用的是 `justify-content: space-between` ——
     它正是「提示靠左、按钮靠右、中间拉出大片空白」的根因。 */

  .reader-note-preview {
    font-size: 12px;
    line-height: 1.4;
    color: #b9c0c7;
    max-height: 48px;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  /* ⚠️ 2026-10-08 删除了旧的两条重复定义（此前这里有第二份
   `.reader-note-input` 与 `.reader-note-actions`，会**覆盖**上面新写的那些）：
   -旧 input 是深色硬编码（`color:#f2f2f2` / `background: rgba(255,255,255,.08)`）
     ⇒ 卡片在**浅色**主题下也是深灰的，这是「批注输入框一直是深色」的真凶；
   - 旧 actions 用 `justify-content: flex-end`，与「快捷键提示靠左」冲突。
   现已统一到上面那一组，全部走 --b3-* 主题变量。

   同日再删：`.reader-note-btn` / `.reader-note-btn-primary` ——
   取消/保存改成图标后，这两个文字按钮样式也失去唯一调用方，
   保存的主色实心已由 `.reader-note-icon.primary` 承担。

   2026-10-11 再删：`.reader-note-editor .reader-style-row/-color-row` 与
   `.reader-viewer-style-row` —— 批注卡片早已改用 `reader-note-fold/-pop/-opt`
   自己的折叠结构（markup 里已无对应 class），划词工具栏的样式行也改名成
   `reader-sel-strip-row/-pill`，这几条成死规则。 */
  .reader-viewer-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 11px; color: #9aa3ab; }
  .reader-viewer-time { opacity: 0.85; }

  /* 2026-08-26 简易预览卡（preview 态）样式 */
  .reader-preview-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 11px; color: #9aa3ab; }
  .reader-preview-actions { display: flex; gap: 2px; }
  .reader-icon-btn {
    width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center;
    border: none; background: transparent; border-radius: 6px; cursor: pointer; font-size: 13px; color: #cdd5dd;
    padding: 0;
  }
  .reader-icon-btn:hover { background: rgba(255, 255, 255, 0.12); }
  .reader-icon-btn-danger:hover { background: rgba(255, 80, 80, 0.18); color: #ffb4b4; }
  .reader-preview-note { max-height: 140px; overflow: auto; }
  .reader-preview-empty { font-size: 12px; color: #7a838c; font-style: italic; padding: 4px 0; }
  .reader-preview-foot { display: flex; justify-content: flex-end; margin-top: 4px; }
  .reader-viewer-btn-primary { background: rgba(90, 160, 255, 0.18); border-color: rgba(90, 160, 255, 0.4); color: #aaccff; }
  .reader-viewer-btn-primary:hover { background: rgba(90, 160, 255, 0.3); }
  .reader-viewer-excerpt {
    font-size: 13px;
    line-height: 1.5;
    color: #f2f2f2;
    max-height: 4.5em;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
  }
  .reader-viewer-note {
    font-size: 13px;
    line-height: 1.55;
    color: #cfe8ef;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 8px;
    padding: 6px 8px;
    max-height: 120px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .reader-viewer-labels { display: flex; flex-wrap: wrap; gap: 6px; }
  .reader-viewer-label {
    font-size: 11px;
    padding: 1px 7px;
    border-radius: 999px;
    color: var(--lc, #9ca3af);
    background: color-mix(in srgb, var(--lc, #9ca3af) 18%, transparent);
    border: 1px solid color-mix(in srgb, var(--lc, #9ca3af) 40%, transparent);
  }
  .reader-viewer-actions { display: flex; justify-content: flex-end; gap: 6px; }
  .reader-viewer-btn {
    padding: 4px 12px;
    font-size: 12px;
    color: #e8e8e8;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 8px;
    cursor: pointer;
  }
  .reader-viewer-btn:hover { background: rgba(255, 255, 255, 0.18); }
  .reader-viewer-btn-danger { color: #ffb4b4; border-color: rgba(255, 120, 120, 0.4); }
  .reader-viewer-btn-danger:hover { background: rgba(255, 80, 80, 0.18); }

  /* 即时词典弹窗：复用全局 .hiword-dict-* 卡片样式 */
  .reader-dict-backdrop {
    /* 2026-08-23 修复：position:fixed → absolute（限定在 .reader-floating-layer 内） */
    position: absolute;
    inset: 0;
    /* 2026-08-24 修复：z-index 降到 3（floating-layer 内部相对顺序，不突破外部） */
    z-index: 3;
    background: transparent;
  }
  .reader-dict-popup {
    /* 2026-08-23 修复：position:fixed → absolute */
    position: absolute;
    /* 2026-08-24 修复：z-index 降到 3 */
    z-index: 3;
    width: 360px;
    max-width: 88vw;
    max-height: 62vh;
    overflow: auto;
    background: var(--b3-theme-background, #fff);
    color: var(--b3-theme-on-background, #333);
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.12));
    border-radius: 10px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.3);
    transform: translateX(-50%);
  }
  .reader-dict-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    font-size: 13px;
    font-weight: 600;
    border-bottom: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.08));
    position: sticky;
    top: 0;
    background: var(--b3-theme-background, #fff);
  }
  .reader-dict-head-actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .reader-dict-send {
    border: 1px solid var(--b3-theme-primary, #4f6ef7);
    background: var(--b3-theme-primary, #4f6ef7);
    color: #fff;
    cursor: pointer;
    font-size: 12px;
    line-height: 1;
    padding: 4px 8px;
    border-radius: 6px;
    transition: opacity 0.12s ease;
  }
  .reader-dict-send:hover {
    opacity: 0.85;
  }
  .reader-dict-close {
    border: none;
    background: transparent;
    cursor: pointer;
    font-size: 14px;
    color: var(--b3-theme-on-background, #666);
  }
  .reader-dict-body {
    padding: 10px 12px;
  }

  .reader-toast {
    /* 2026-08-23 修复：position:fixed → absolute（限定在 .reader-floating-layer 内） */
    position: absolute;
    left: 50%;
    /* 16px 适配 reader-view 容器底部（不再贴视口底部 64px） */
    bottom: 16px;
    transform: translateX(-50%);
    /* 2026-08-24 修复：z-index 降到 3 */
    z-index: 3;
    background: rgba(0, 0, 0, 0.82);
    color: #fff;
    font-size: 13px;
    padding: 8px 14px;
    border-radius: 8px;
    pointer-events: none;
    display: inline-flex;
    align-items: center;
    gap: 10px;
  }
  .reader-toast-undo {
    pointer-events: auto;
    border: none;
    background: rgba(255, 255, 255, 0.18);
    color: #fff;
    font-size: 12px;
    padding: 3px 10px;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.15s ease;
  }
  .reader-toast-undo:hover { background: rgba(255, 255, 255, 0.3); }

  /* Phase 2 批注编辑 / 查看浮层 */
  .reader-ann-backdrop {
    /* 2026-08-23 修复：position:fixed → absolute */
    position: absolute;
    inset: 0;
    /* 2026-08-24 修复：z-index 降到 3 */
    z-index: 3;
    background: transparent;
  }
  .reader-ann-editor {
    /* 2026-08-23 修复：position:fixed → absolute */
    position: absolute;
    transform: translateX(-50%);
    /* 2026-08-24 修复：z-index 降到 3 */
    z-index: 3;
    width: 320px;
    max-width: 90vw;
    background: var(--b3-theme-background, #fff);
    color: var(--b3-theme-on-background, #333);
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.12));
    border-radius: 10px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.3);
    padding: 12px;
  }
  .reader-ann-date {
    font-size: 11px;
    color: var(--b3-theme-on-surface-light, #999);
    margin-bottom: 8px;
  }
  .reader-ann-section {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  .reader-ann-section-title {
    font-size: 12px;
    color: var(--b3-theme-on-surface-light, #888);
    flex-shrink: 0;
    width: 28px;
  }
  .reader-ann-groups {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .reader-ann-group {
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.15));
    background: transparent;
    border-radius: 14px;
    padding: 3px 10px;
    font-size: 12px;
    cursor: pointer;
    color: var(--b3-theme-on-background, #333);
  }
  .reader-ann-group.active {
    border-color: var(--b3-theme-primary, #06b6d4);
    background: color-mix(in srgb, var(--b3-theme-primary, #06b6d4) 16%, transparent);
    font-weight: 600;
  }
  .reader-ann-colors {
    display: flex;
    gap: 6px;
  }
  .reader-ann-color {
    border: 2px solid transparent;
    border-radius: 50%;
    width: 20px;
    height: 20px;
    cursor: pointer;
    padding: 0;
  }
  .reader-ann-color.active {
    border-color: var(--b3-theme-on-background, #333);
    box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.15);
  }
  .reader-ann-styles {
    display: flex;
    gap: 6px;
  }
  .reader-ann-style {
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.15));
    background: transparent;
    border-radius: 8px;
    width: 36px;
    height: 32px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .reader-ann-style.active {
    border-color: var(--b3-theme-primary, #06b6d4);
    background: color-mix(in srgb, var(--b3-theme-primary, #06b6d4) 16%, transparent);
  }
  .reader-ann-quote {
    font-size: 13px;
    color: var(--b3-theme-on-background, #555);
    background: var(--b3-theme-surface, rgba(0, 0, 0, 0.04));
    border-left: 3px solid var(--b3-theme-primary, #06b6d4);
    padding: 6px 8px;
    border-radius: 4px;
    margin-bottom: 10px;
    max-height: 60px;
    overflow: auto;
    word-break: break-word;
  }
  .reader-ann-note {
    width: 100%;
    box-sizing: border-box;
    min-height: 64px;
    resize: vertical;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.15));
    border-radius: 6px;
    padding: 8px;
    font-size: 13px;
    font-family: inherit;
    background: var(--b3-theme-background, #fff);
    color: var(--b3-theme-on-background, #333);
  }
  .reader-ann-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 10px;
  }
  .reader-ann-spacer { flex: 1; }
  .reader-ann-btn {
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.15));
    background: transparent;
    border-radius: 6px;
    padding: 6px 14px;
    font-size: 13px;
    cursor: pointer;
    color: var(--b3-theme-on-background, #333);
  }
  .reader-ann-btn.primary {
    background: var(--b3-theme-primary, #06b6d4);
    border-color: var(--b3-theme-primary, #06b6d4);
    color: #fff;
  }
  .reader-ann-btn.danger {
    color: #e5484d;
    border-color: #e5484d;
  }
  /* 阅读舞台：包住 container + 左右悬浮箭头；绝对定位撑满，容器与箭头同层 */
  .reader-stage {
    flex: 1;
    position: relative;
    overflow: hidden;
    min-height: 240px;
  }
  .reader-container {
    position: absolute;
    inset: 0;
    overflow: hidden;
    /* 兜底背景：iframe 渲染前/透明时透出此色而非思源暗色黑底（黑底闪屏根因之一）。
       实际主题色由 applyContainerBg() 通过 JS 动态覆盖到该元素 background。 */
    background: #ffffff;
  }
  .reader-container reword-foliate-view {
    display: block;
    width: 100%;
    height: 100%;
    /* 兜底：reword-foliate-view 高度依赖容器，给最小可视高度 */
    min-height: 240px;
  }
  /* 批注指示器小圆点（onDrawAnnotation 中有笔记时绘制） */
  .xh-note-indicator {
    pointer-events: none;
    opacity: 0.85;
    transition: opacity 0.15s, r 0.15s;
  }
  .xh-note-indicator:hover {
    opacity: 1;
    r: 3.5;
  }
  /* 左右悬浮翻页箭头：半透明默认态，hover/focus 提升；按住连翻 */
  .reader-side-tap {
    position: absolute;
    inset: 0;
    pointer-events: none;
    /* 2026-08-24 修复：z-index 从 35 降到 1，避免压住思源原生 UI */
    z-index: 1;
  }
  .reader-side-arrow {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    width: 34px;
    height: 52px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid transparent;
    border-radius: 10px;
    background: var(--b3-theme-background, rgba(255, 255, 255, 0.9));
    color: var(--b3-theme-on-surface-light, #888);
    opacity: 0.3;
    cursor: pointer;
    pointer-events: auto;
    box-shadow: 0 1px 6px rgba(0, 0, 0, 0.12);
  }
  .reader-side-left {
    left: 6px;
  }
  .reader-side-right {
    right: 6px;
  }
  .reader-side-arrow:hover,
  .reader-side-arrow:focus-visible {
    opacity: 0.95;
    color: var(--b3-theme-primary, #378add);
    border-color: var(--b3-theme-primary, #378add);
    background: var(--b3-theme-background, #fff);
  }
  .reader-side-arrow:active {
    transform: translateY(-50%) scale(0.92);
  }
  .reader-side-arrow:focus {
    outline: none;
  }
  .reader-side-arrow:focus-visible {
    outline: 2px solid var(--b3-theme-primary, #378add);
    outline-offset: 2px;
  }
  /* 窄屏隐藏箭头（触屏靠滑动翻页） */
  @media (max-width: 479px) {
    .reader-side-tap {
      display: none;
    }
  }
  /* 设置面板：开关行 + 开关 */
  .reader-setting-toggle-row {
    justify-content: space-between;
  }
  .reader-switch {
    position: relative;
    display: inline-flex;
    align-items: center;
    cursor: pointer;
    flex-shrink: 0;
  }
  .reader-switch input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
  }
  .reader-switch-track {
    width: 36px;
    height: 20px;
    border-radius: 10px;
    background: var(--b3-theme-background-light, rgba(0, 0, 0, 0.12));
    transition: background 200ms ease-out;
    position: relative;
  }
  .reader-switch-track::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
    transition: transform 200ms ease-out;
  }
  .reader-switch input:checked + .reader-switch-track {
    background: var(--b3-theme-primary, #378add);
  }
  .reader-switch input:checked + .reader-switch-track::after {
    transform: translateX(16px);
  }

  .reader-popover {
    position: absolute;
    /* 2026-08-24 修复：z-index 从 40 降到 2，保持高于 stage(0)/backdrop(1)，
       但远低于思源原生 UI，避免压住顶栏"管理"菜单 */
    z-index: var(--rz-popover);
    background: var(--b3-theme-background, #fff);
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.15));
    border-radius: 10px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.14);
  }
  .reader-popover-title {
    font-size: 13px;
    font-weight: 500;
    color: var(--b3-theme-on-background, #333);
    padding-bottom: 6px;
    border-bottom: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.08));
    /* 2026-08-23 修复：标题 sticky 钉在弹层滚动视口顶部，
       滚动时不再随章节内容移动（Readt/思阅 同款固定表头做法） */
    position: sticky;
    top: 0;
    z-index: 2;
    flex: 0 0 auto;
    background: var(--b3-theme-background, #fff);
  }
  /* 2026-08-30 改造：3 个抽屉（.reader-toc / .reader-bookmarks / .reader-annots）
     位置保持原样（相对 .reader-view 顶部、左 8px），但加统一角标 + 入场动效
     抽屉在 top-level 渲染（不是 toolbar 子元素），所以仍用 .reader-view 作定位上下文
     ⚠️ 2026-10-08 顶栏浮层化：top 36 → 44。
     * 旧值是「顶栏在文档流里占位」的锚点；浮层化后顶栏是 `top: 6px` 的浮层，
     * 底沿在 36px 附近。原值会让抽屉**压到顶栏下方、角标插进栏身里**，
     * 看起来像抽屉从栏里长出来（其实是被盖住一截）。 */
  .reader-toc,
  .reader-bookmarks,
  .reader-annots,
  .reader-marks {
    top: 44px;         /* 略大于浮起态顶栏底沿（top 6 + 高约 30 = 36），留 8px 呼吸 + 角标 */
    left: 8px;
    max-height: 70vh;
    display: flex;
    flex-direction: column;
    padding: 8px;
    width: 280px;
    min-width: 240px;
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
    /* 入场动效（角标从锚点图标"长出来"） */
    transform-origin: top left;
    animation: reader-drawer-in 180ms ease-out;
  }
  /* 2026-10-24 移动端适配 Phase 2.1：紧凑顶栏 ⋯ 溢出菜单（isCompactToolbar 时右组收敛）。
     锚定顶栏右组（top:44px 与各抽屉一致；right:8px 对齐 ⋯ 按钮列）。
     触屏命中区 ≥44px（同 (pointer:coarse) 基线，菜单项无条件放大——菜单本就是手机入口）。 */
  .reader-more-menu {
    top: 44px;
    right: 8px;
    left: auto;
    width: 216px;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    transform-origin: top right;
    animation: reader-drawer-in 180ms ease-out;
  }
  .reader-more-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
    box-sizing: border-box;
    border: none;
    background: none;
    cursor: pointer;
    text-align: left;
    padding: 10px;
    border-radius: 6px;
    font-size: 14px;
    min-height: 44px;
    color: var(--b3-theme-on-background, #333);
  }
  .reader-more-item:hover {
    background: var(--b3-theme-background-light, rgba(0, 0, 0, 0.06));
  }
  .reader-more-item-active {
    color: var(--b3-theme-primary, #378add);
  }
  .reader-more-item-state {
    font-size: 12px;
    color: var(--b3-theme-on-surface-light, #888);
  }

  /* ================================================================
   * 2026-10-24 移动端适配 Phase 2.2/2.4：手机（re-phone/re-large-phone）
   * ================================================================
   * ① 侧栏 popover（目录/书签摘录/搜索）→ 底部 sheet：
   *    280px 窄 popover 在手机上又窄又矮还遮正文；改为贴底全宽 sheet，
   *    底部让出 44px 给圆点把手/进度条区。角标小三角一并隐藏（锚点语义不再成立）。
   * ② TTS 朗读条：横向一长条在窄屏溢出 → 允许横向滚动（改动最小的方案）。 */
  .reader-view.re-phone .reader-toc,
  .reader-view.re-phone .reader-bookmarks,
  .reader-view.re-phone .reader-annots,
  .reader-view.re-phone .reader-marks,
  .reader-view.re-phone .reader-search {
    top: auto;
    bottom: 44px;
    left: 0;
    right: 0;
    width: auto;
    min-width: 0;
    max-height: min(78vh, calc(100% - 104px));
    border-radius: 16px 16px 0 0;
    border-bottom: none;
    transform-origin: bottom center;
    animation: reader-sheet-in 180ms ease-out;
  }
  .reader-view.re-phone .reader-toc::before,
  .reader-view.re-phone .reader-bookmarks::before,
  .reader-view.re-phone .reader-annots::before,
  .reader-view.re-phone .reader-marks::before {
    display: none;
  }
  .reader-view.re-large-phone .reader-toc,
  .reader-view.re-large-phone .reader-bookmarks,
  .reader-view.re-large-phone .reader-annots,
  .reader-view.re-large-phone .reader-marks {
    /* 大手机（480-600px）保持锚定 popover 形态，但放宽到 320px 并提高高度上限 */
    width: 320px;
    max-height: 78vh;
  }
  @keyframes reader-sheet-in {
    from { opacity: 0; transform: translateY(12px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .reader-view.re-phone .reader-tts-bar {
    overflow-x: auto;
    overscroll-behavior-x: contain;
    scrollbar-width: none;
  }
  .reader-view.re-phone .reader-tts-bar::-webkit-scrollbar {
    display: none;
  }
  /* 2026-10-25 移动端适配 B3：圆点把手命中区让位首/末行。
     手机上把手是次要入口（中心点按 toggle + 翻页自动收起已是主路径）：
     顶把手贴顶 22px、底把手贴底 24px、圆点缩小。桌面/平板不变。 */
  .reader-view.re-phone .reader-top-handle {
    top: 0;
    height: 22px;
  }
  .reader-view.re-phone .reader-top-handle-dot {
    width: 5px;
    height: 5px;
  }
  .reader-view.re-phone .reader-bottom-handle:not(.reader-bottom-handle-revealed) {
    bottom: 0;
    height: 24px;
  }
  .reader-view.re-phone .reader-bottom-handle-dot {
    width: 5px;
    height: 5px;
  }
  /* ================================================================
   * 2026-10-26 路线 A · 极小屏档（对标「思阅」SiReader 的 420/380 断点）
   * ----------------------------------------------------------------
   * re-phone 已覆盖 ≤480px；这里补两档更窄的（折叠机半屏 / iPhone SE 竖屏）：
   * 顶栏控件更紧凑、底部 sheet 让出更多正文高度。
   * 注意 .reader-toolbar-iphone .reader-btn 的 44×44 命中区**不缩**
   * （只调 padding/字号，min-width 仍兜底触摸命中）。 */
  @media (max-width: 420px) {
    .reader-view.re-phone .reader-toolbar {
      padding-left: calc(4px + env(safe-area-inset-left, 0px));
      padding-right: calc(4px + env(safe-area-inset-right, 0px));
      gap: 2px;
    }
    .reader-view.re-phone .reader-btn {
      padding: 4px 5px;
    }
    .reader-view.re-phone .reader-toc,
    .reader-view.re-phone .reader-bookmarks,
    .reader-view.re-phone .reader-annots,
    .reader-view.re-phone .reader-marks,
    .reader-view.re-phone .reader-search {
      bottom: 36px;
      max-height: min(84vh, calc(100% - 84px));
    }
  }
  @media (max-width: 380px) {
    .reader-view.re-phone .reader-toolbar {
      padding-top: calc(4px + env(safe-area-inset-top, 0px));
    }
    .reader-view.re-phone .reader-btn {
      padding: 3px 4px;
      font-size: 12px;
    }
    .reader-view.re-phone .reader-title {
      font-size: 12px;
    }
  }
  /* ================================================================
   * 2026-10-25 P0-1：常驻侧边栏（停靠模式，根节点 .sidebar-docked）
   * 与抽屉的本质区别：**正文让位**——stage 在 column flex 的 stretch 下加
   * margin-left 即压缩宽度，foliate ResizeObserver 走窗口缩放同一条路径重排版，
   * 面板不再遮挡正文（对齐 Readest sidebar）。面板本体复用 .reader-popover，
   * 停靠 = CSS 覆写为全高左栏（模板零搬移，抽屉形态完全保留）。 */
  .reader-view.sidebar-docked .reader-toc,
  .reader-view.sidebar-docked .reader-bookmarks,
  .reader-view.sidebar-docked .reader-annots,
  .reader-view.sidebar-docked .reader-marks,
  .reader-view.sidebar-docked .reader-search {
    top: 0;
    left: 0;
    right: auto;
    bottom: 0;
    width: var(--re-sidebar-w, 280px);
    min-width: 0;
    max-height: none;
    border-radius: 0;
    border: none;
    border-right: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.12));
    box-shadow: none;
    animation: none;
  }
  .reader-view.sidebar-docked .reader-toc::before,
  .reader-view.sidebar-docked .reader-bookmarks::before,
  .reader-view.sidebar-docked .reader-annots::before,
  .reader-view.sidebar-docked .reader-marks::before {
    display: none; /* 锚点角标在停靠形态无意义 */
  }
  /* 正文让位 */
  .reader-view.sidebar-docked .reader-stage {
    margin-left: var(--re-sidebar-w, 280px);
  }
  /* 浮层顶/底栏起点随侧栏右移 */
  .reader-view.sidebar-docked .reader-toolbar-floating {
    left: calc(var(--re-sidebar-w, 280px) + 6px);
  }
  .reader-view.sidebar-docked .reader-bottom-bar {
    left: calc(var(--re-sidebar-w, 280px) + 6px);
  }
  /* 拖宽把手（停靠栏右缘） */
  .reader-side-resizer {
    position: absolute;
    top: 0;
    bottom: 0;
    left: calc(var(--re-sidebar-w, 280px) - 4px);
    width: 8px;
    z-index: 6;
    cursor: col-resize;
    touch-action: none;
  }
  .reader-side-resizer::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 3px;
    width: 2px;
    border-radius: 1px;
    background: transparent;
    transition: background 0.15s ease;
  }
  .reader-side-resizer:hover::after,
  .reader-side-resizer:active::after {
    background: var(--b3-theme-primary, #378add);
  }
  /* 面板标题行/搜索行的固定·取消固定按钮 */
  .reader-pin-btn {
    float: right;
    border: none;
    background: none;
    color: var(--b3-theme-on-surface-light, #888);
    font-size: 13px;
    line-height: 1;
    padding: 2px 4px;
    cursor: pointer;
    border-radius: 4px;
  }
  .reader-pin-btn:hover {
    color: var(--b3-theme-primary, #378add);
    background: var(--b3-list-hover, rgba(0, 0, 0, 0.05));
  }
  .reader-pin-btn.on {
    color: var(--b3-theme-primary, #378add);
  }
  .reader-pin-mini.on {
    color: var(--b3-theme-primary, #378add);
  }
  @keyframes reader-drawer-in {
    from { opacity: 0; transform: translateY(-6px) scale(0.96); }
    to   { opacity: 1; transform: translateY(0)    scale(1); }
  }
  /* 角标：CSS 三角形 ::before 指向 toolbar 图标。
     2026-08-30 改造：横向位置不再硬编码，由 JS 按锚点图标中心写入 --tail-left，
     并通过 translateX(-50%) 让三角中心对准变量，按钮宽度/间距变化也不偏移。 */
  .reader-toc::before,
  .reader-bookmarks::before,
  .reader-annots::before,
  .reader-marks::before {
    content: "";
    position: absolute;
    top: -7px;
    left: var(--tail-left, 30px);
    width: 12px;
    height: 12px;
    background: var(--b3-theme-background, #fff);
    border-left: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.15));
    border-top: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.15));
    transform: translateX(-50%) rotate(45deg);
    z-index: 1;
  }
  .reader-toc-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 6px;
    /* 列表不再独立滚动，交由 popover 滚动；标题由 sticky 固定 */
  }
  .reader-toc-item {
    display: flex;
    align-items: center;
    width: 100%;
    box-sizing: border-box;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    padding: 8px 10px;
    border-radius: 6px;
    font-size: 13px;
    line-height: 1.7;
    min-height: 34px;
    color: var(--b3-theme-on-background, #333);
    /* 2026-10-15 目录长列表「档 A」：浏览器原生虚拟渲染（方案 §1.3.5）。
     * 屏外行跳过布局与绘制，滚动条总高靠 contain-intrinsic-size 占位。
     * 本列表天然**单行定高**（34px 下限从不生效，实测行高 38.1px = 13px×1.7 + 8×2 + 取整），
     * 所以占位尺寸没有测量误差 ⇒ 滚动条不抖、scrollTocToActive 的 rect 计算仍精确。
     * 旧内核（Chromium < 85）不识别 ⇒ 自动退回全量渲染，功能不破。
     * ⚠️ 退路（真机若见滚动条跳位/掉行）：给行外面再包一层 block `.reader-toc-row`
     *    把 content-visibility 挪过去（flex 子项上的尺寸包含在个别版本有抖动先例）。 */
    content-visibility: auto;
    contain-intrinsic-size: auto 38px;
  }
  /* caret 槽：**所有行恒定占位**（叶子行也占这 18px）——这是零位移的关键，
     任何一行的展开/收起都不会移动其它行的文本左沿。 */
  .reader-toc-caret-slot {
    flex: 0 0 18px;
    width: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .reader-toc-caret {
    /* 命中区 = 整个 18px 槽（图标本身只有 10px，直接点 10px 太瘦） */
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    opacity: 0.5;
    /* 即时切换、不做 height 折叠动画（几百行逐帧布局必掉帧，且与 content-visibility 语义冲突），
       反馈全靠 caret 自身旋转；旋转过渡沿用车架侧栏 / 笔记折叠的既有节奏。 */
    transition: transform 0.15s ease, opacity 0.15s ease;
  }
  .reader-toc-caret-ico {
    display: inline-flex;
    width: 10px;
    height: 10px;
  }
  .reader-toc-caret.closed {
    transform: rotate(-90deg);
  }
  /* 悬停提亮 caret：挂在**列表**上而不是行自身的 hover 选择器，两个原因：
     ① 鼠标在目录里移动时整体显出可折叠的暗示，比逐行才亮更连贯（微信读书同款）；
     ② 既有 hover 底色契约测试按「行自身的 hover 选择器」这段文本定位规则，
        本文件里再出现同样的文本会让它命中到注释上（真机红过一次）。 */
  .reader-toc-list:hover .reader-toc-caret {
    opacity: 0.85;
  }
  .reader-toc-caret:hover {
    opacity: 1;
  }
  .reader-toc-caret :global(svg) {
    width: 100%;
    height: 100%;
    display: block;
  }
  .reader-toc-label {
    flex: 1 1 auto;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* ================= 图片查看器（lightbox），2026-10-15 P0 =================
     层级/遮罩对齐 .reword-pt-overlay 全屏先例（fixed inset 0 + z-index 60）：
     高于本组件一切浮层，仍不越过思源原生 UI（口径见 .reader-popover 注释）。 */
  .reader-imgv {
    position: fixed;
    inset: 0;
    z-index: var(--rz-imgv);
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.86);
    /* 🔴 入场只做 opacity：img 的 transform 是 pan/zoom 的定位锚点，
       容器再叠 transform 会把缩放原点整体带偏（与划词工具栏同款硬约束）。 */
    animation: reader-imgv-in 140ms ease-out;
  }
  @keyframes reader-imgv-in {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
  .reader-imgv-img {
    max-width: 92vw;
    max-height: 86vh;
    object-fit: contain;
    cursor: zoom-in;
    user-select: none;
    -webkit-user-drag: none;
    /* 灯箱内禁掉浏览器默认手势（双击原生放大 / 滚动链），捏合与平移由 JS 接管 */
    touch-action: none;
  }
  .reader-imgv-img.zoomed {
    cursor: grab;
  }
  .reader-imgv-bar {
    position: absolute;
    left: 50%;
    bottom: 22px;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.12);
    color: #fff;
  }
  .reader-imgv-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 26px;
    height: 26px;
    padding: 0 8px;
    border: none;
    border-radius: 999px;
    background: transparent;
    color: #fff;
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
  }
  .reader-imgv-btn:hover {
    background: rgba(255, 255, 255, 0.18);
  }
  .reader-imgv-word {
    font-size: 12px;
  }
  .reader-imgv-pct {
    font-size: 12px;
    min-width: 44px;
    text-align: center;
    color: rgba(255, 255, 255, 0.82);
  }
  @media (prefers-reduced-motion: reduce) {
    .reader-imgv { animation-duration: 0.01s; }
  }
  /* 目录项悬停底色（2026-10-09 修「hover 高亮等于没有」+「与当前章节同色」）
   *
   * 🔴 根因 1：原用`var(--b3-theme-background-light, …)`，那是**中性灰**，
   * 多数主题下叠到白底上**等于没变**（实测观感差 ΔRGB）：
   *   内置 daylight #dfe0e1→ 叠白底 rgb(223,224,225)ΔRGB 53.7 可见
   *   内置 midnight rgba(255,255,255,.1) → 叠白底 rgb(255,255,255) ΔRGB 0    ❌
   *   Neo        oklch(... / 0.1)      → 叠白底 rgb(255,255,255) ΔRGB 0    ❌
   * 最后一列是用户实际在用的主题 ⇒「鼠标移上去没反应」的真实原因。
   *
   * 🔴 根因 2：改用 `-lightest` 之后仍不够 —— **与当前章节高亮同色**。
   * 主题的 `-lightest` 只有固定几档（daylight .12 / midnight .24 / Neo .2），
   * hover 与 active 都用它 ⇒ 实测 ΔRGB **= 0**（五套主题全部分不出），
   * 用户悬停普通行时**分辨不出「我当前在哪」**。
   *
   * 修法：hover 用`color-mix` 把主色**再降一档**（约为 lightest 的一半 alpha），
   * 与当前章节拉开层次：hover ≈「可点」淡蓝，当前章节 ≈「我在这」深一档的蓝。
   *
   * `color-mix(… N%, transparent)` 的结果 alpha = N、RGB 不变（premultiplied），
   * 所以 6% 就是 6% —— 与 skill 里那条实测一致。
   *
   * ⚠️ 兜底必须给**非零 alpha**：QYL-theme / Tsundoku 两套用户主题未定义
   * `--b3-theme-primary`，color-mix 的参数会变空 ⇒ 整条声明按 unset 处理
   * （不是「回退到默认值」）⇒ 必须同时给 `var()` 兜底。
   */
  .reader-toc-item:hover {
    background: color-mix(in srgb, var(--b3-theme-primary, #3575f0) 7%, transparent);
  }
  /* 当前章节高亮（2026-10-09 修「底色太实」+「hover 时消失」）
   *
   * 🔴 根因 1（底色太实）：原写法 `var(--b3-theme-primary-light, …)` **语义用错了**。
   *
   * `--b3-theme-primary-light` 在思源里是**「主色的浅色变体」**，不是「浅色底」：
   *   内置 daylight  = rgba(53, 117, 240, .54)   ← alpha 0.54，当背景就是一块实蓝
   *   内置 midnight  = rgba(53, 117, 240, .72)   ← 更实
   *   Neo 主题       = oklch(from primary l c h / 0.56)
   * 三套主题**无一例外**都在 0.5 以上 ⇒ 目录里那一行永远是"高亮块"而不是"淡底"。
   *
   * 而思源自己的 primary-light 语义（见其 theme.css）：
   *   -light   0.56   ← 用来做**实心前景**（图标/文字/边框），不是底色
   *   -lighter 0.38
   *   -lightest 0.2  ← 这一档才是当底色用的
   *
   * 🔴 根因 2（hover 时高亮消失）：**特异性算错了**。
   *   .reader-toc-item:hover  → 类1 + 伪类1 = (0,2,0)
   *   .reader-toc-active      → 类1           = (0,1,0)
   * hover 更高 ⇒ 鼠标一进入当前章节那一行，hover 灰底**整块盖掉**蓝底，
   * 用户看到「高亮消失了」（实测三套主题全部复现）。
   *
   * 修法：把选择器写成 `.reader-toc-active:hover`，与 hover **同特异性 (0,2,0)**，
   * 靠「后写者赢」取胜 —— **不用 !important**，也不改变 hover 本身的语义。
   * 顺带表达了一个真实语义：**当前章节行即使被悬停，也保持当前章节的底色**
   * （位置指示不该被 hover 干扰；这是与 Readest 一致的选择）。
   */
  .reader-toc-active,
  .reader-toc-active:hover {
    background: var(--b3-theme-primary-lightest, rgba(53, 117, 240, 0.16));
    color: var(--b3-theme-primary, #378add);
  }
  .reader-toc-check {
    color: var(--b3-theme-primary, #378add);
    margin-right: 5px;
    font-size: 11px;
    flex-shrink: 0;
  }
  .reader-toc-count {
    font-size: 11px;
    color: var(--b3-theme-on-surface-light, #888);
    margin-left: 6px;
  }
  .reader-toc-empty {
    font-size: 12px;
    color: var(--b3-theme-on-surface-light, #888);
    padding: 10px 4px;
  }
  /* 2026-08-29 新增：书签 / 摘录汇总抽屉
   * 2026-08-30 改造：.reader-toc/.reader-bookmarks/.reader-annots 已合并为一套定位规则
   * （见上 8762 行附近），这里只覆盖宽度差异。 */
  .reader-bookmarks,
  .reader-annots,
  .reader-marks {
    width: 320px;
    min-width: 280px;
    max-width: 360px;
  }
  /* 2026-09-03 半分半合：书签 + 摘录合并到同一抽屉，用分隔线区分两个子区 */
  .reader-marks-section + .reader-marks-section {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.12));
  }
  .reader-bm-list,
  .reader-annots-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 6px;
  }
  .reader-bm-add {
    background: none;
    border: 1px dashed var(--b3-border-color, rgba(0, 0, 0, 0.2));
    border-radius: var(--reword-radius-sm, 6px);
    color: var(--b3-theme-primary, #378add);
    font-size: 12px;
    padding: 7px 10px;
    cursor: pointer;
    text-align: left;
  }
  .reader-bm-add:hover {
    background: var(--b3-theme-primary-light, rgba(55, 138, 221, 0.1));
  }
  .reader-bm-item,
  .reader-annot-item {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    border-radius: var(--reword-radius-sm, 6px);
    padding: 2px 4px;
  }
  .reader-bm-item:hover,
  .reader-annot-item:hover {
    background: var(--b3-theme-background-light, rgba(0, 0, 0, 0.05));
  }
  .reader-bm-main,
  .reader-annot-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    padding: 6px 4px;
    color: var(--b3-theme-on-background, #333);
  }
  .reader-bm-label {
    font-size: 13px;
    line-height: 1.5;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .reader-bm-excerpt {
    font-size: 11px;
    color: var(--b3-theme-on-surface-light, #888);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .reader-annot-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-top: 10px;
    flex-shrink: 0;
  }
  /* 2026-09-09 B：条目类型标识（▮ 高亮 / ━ 直线 / ﹏ 波浪 / 💬 批注 / ▭ 矩形 / ✎ 墨迹） */
  .reader-annot-kind {
    font-size: 11px;
    line-height: 1;
    margin-top: 8px;
    opacity: 0.75;
    flex-shrink: 0;
    min-width: 12px;
    text-align: center;
  }
  .reader-annot-text {
    font-size: 13px;
    line-height: 1.5;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .reader-annot-note {
    font-size: 11px;
    color: var(--b3-theme-on-surface-light, #888);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .reader-eta {
    font-size: 11px;
    color: var(--b3-theme-on-surface-light, #888);
    flex-shrink: 0;
  }

  .reader-search {
    /* 2026-10-23 修复：搜索面板原本硬编码在左下角（bottom/left），
       但 2026-10-08 顶栏浮层化把 🔍 按钮移到了顶栏右上角，导致
       「按钮右上、面板左下」对角错位。这里对齐 🔍 改为 top/right。
       width 用 min() 适配窄屏，避免溢出视口。 */
    top: 44px;
    right: 8px;
    width: min(300px, 92vw);
    /* z-index 从 .reader-popover 继承的 2 提到 3：划词工具栏容器
       .reader-floating-layer 同为 z-index:2 且 DOM 更靠后，会盖在面板
       之上吞掉 ✕ 点击（"关不掉/卡死"根因之一）。3 仍远低于思源原生 UI，安全。 */
    z-index: 3;
    max-height: 62vh;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .reader-search-row {
    display: flex;
    gap: 4px;
  }
  .reader-search-input {
    flex: 1;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.2));
    border-radius: 6px;
    padding: 5px 8px;
    font-size: 12px;
    background: var(--b3-theme-background, #fff);
    color: var(--b3-theme-on-background, #333);
    min-width: 0;
  }
  .reader-search-options {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--b3-theme-on-surface-light, #888);
  }
  .reader-search-scope { display: inline-flex; gap: 2px; }
  .reader-seg-sm {
    padding: 2px 8px;
    font-size: 11px;
    border-radius: 6px;
  }
  .reader-search-opt {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    cursor: pointer;
    user-select: none;
  }
  .reader-search-opt-disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  /* ===== 2026-10-25 搜索增强：模式行 / 正则错误 / 历史 chips ===== */
  .reader-search-modes {
    gap: 6px;
  }
  .reader-search-modes-label {
    font-size: 12px;
    color: var(--b3-theme-on-surface-light, #888);
    flex-shrink: 0;
  }
  .reader-search-regex-error {
    font-size: 12px;
    color: var(--b3-theme-error, #e24b4a);
    background: var(--b3-theme-error-light, rgba(226, 75, 74, 0.08));
    border-radius: 4px;
    padding: 4px 6px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .reader-search-input.reader-search-input-invalid {
    border-color: var(--b3-theme-error, #e24b4a) !important;
  }
  .reader-search-history {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .reader-search-history-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 12px;
    color: var(--b3-theme-on-surface-light, #888);
  }
  .reader-search-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .reader-search-chip {
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.12));
    border-radius: 999px;
    background: none;
    color: var(--b3-theme-on-background, #333);
    font-size: 12px;
    padding: 3px 10px;
    cursor: pointer;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .reader-search-chip:hover {
    background: var(--b3-list-hover, rgba(0, 0, 0, 0.05));
  }
  .reader-search-status {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
    font-size: 12px;
    color: var(--b3-theme-on-surface-light, #888);
  }
  .reader-search-nav { display: inline-flex; gap: 2px; }
  .reader-search-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    overflow-y: auto;
    max-height: 40vh;
    margin: 0 -2px;
    padding: 2px;
  }
  .reader-search-item {
    text-align: left;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.12));
    border-radius: 8px;
    background: var(--b3-theme-background, #fff);
    padding: 6px 8px;
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease;
  }
  .reader-search-item:hover { background: var(--b3-theme-surface, #f3f3f3); }
  .reader-search-item-active {
    border-color: var(--b3-theme-primary, #4a7bd0);
    background: color-mix(in srgb, var(--b3-theme-primary, #4a7bd0) 12%, var(--b3-theme-background, #fff));
  }
  .reader-search-item-head {
    display: flex;
    justify-content: space-between;
    gap: 6px;
    font-size: 11px;
    color: var(--b3-theme-on-surface-light, #888);
    margin-bottom: 2px;
  }
  .reader-search-item-pct { flex-shrink: 0; opacity: 0.8; }
  .reader-search-item-excerpt {
    font-size: 12px;
    line-height: 1.5;
    color: var(--b3-theme-on-background, #333);
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .reader-search-item-excerpt mark {
    background: #ffe08a;
    color: inherit;
    border-radius: 2px;
    padding: 0 1px;
  }
  .reader-search-item-active .reader-search-item-excerpt mark {
    background: #ffb020;
  }

  /* ===== 脚注气泡（2026-08-25 新增，对齐截图设计） ===== */
  .reader-footnote {
    position: absolute;
    width: min(360px, 80%);
    max-height: 60vh;
    background: var(--b3-theme-background, #fff);
    border-radius: 10px;
    border-left: 3px solid #e5484d; /* 红色左边框（截图特征） */
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15), 0 2px 8px rgba(0, 0, 0, 0.08);
    overflow: hidden;
    z-index: 100;
    display: flex;
    flex-direction: column;
    animation: fn-fade-in 0.15s ease-out;
  }
  @keyframes fn-fade-in {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .reader-footnote-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border-bottom: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.08));
    flex-shrink: 0;
  }
  .reader-footnote-icon {
    font-size: 12px;
    flex-shrink: 0;
  }
  .reader-footnote-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--b3-theme-on-background, #333);
    flex: 1;
  }
  .reader-footnote-close {
    background: none;
    border: none;
    font-size: 14px;
    color: var(--b3-theme-on-surface-light, #999);
    cursor: pointer;
    padding: 2px 4px;
    border-radius: 4px;
    line-height: 1;
    flex-shrink: 0;
  }
  .reader-footnote-close:hover {
    background: rgba(0, 0, 0, 0.06);
    color: var(--b3-theme-on-background, #333);
  }
  /* 「↗ 跳转到脚注所在页」（2026-10-09 新增）
   *
   * 与「✕ 关闭」视觉上要区分开：✕ 是纯文字灰、↗ 给主色，
   * 否则两个小按钮并排会让人分不清哪个是「去原文」哪个是「关掉」。
   * hover 底色也用主色档，避免与 ✕ 的中性灰 hover 混在一起。 */
  .reader-footnote-jump {
    background: none;
    border: 1px solid var(--b3-theme-primary-lightest, rgba(53, 117, 240, 0.16));
    border-radius: 5px;
    color: var(--b3-theme-primary, #378add);
    cursor: pointer;
    padding: 1px 7px;
    font-size: 12px;
    line-height: 1.5;
    flex-shrink: 0;
  }
  .reader-footnote-jump:hover {
    background: var(--b3-theme-primary-lightest, rgba(53, 117, 240, 0.16));
  }
  .reader-footnote-body {
    padding: 12px 14px;
    font-size: 15px;
    line-height: 1.75;
    color: var(--b3-theme-on-background, #333);
    overflow-y: auto;
    /* 样式隔离：强制显示隐藏脚注块 */
  }
  .reader-footnote-body :global(aside),
  .reader-footnote-body :global([style*="display:none"]),
  .reader-footnote-body :global([style*="display: none"]),
  .reader-footnote-body :global([hidden]) {
    display: block !important;
  }
  .reader-footnote-body :global(img) {
    max-width: 100%;
    height: auto;
    border-radius: 4px;
    margin: 4px 0;
  }
  .reader-footnote-body :global(a) {
    color: var(--b3-theme-primary, #0f6bff);
    text-decoration: none;
    /* 气泡内链接（如脚注里的「返回正文 ↩」锚点）在容器层无目标上下文，点击会触发
       思源页面异常导航；气泡仅为展示，禁用其点击（文字仍可读/可复制）。 */
    pointer-events: none;
    cursor: default;
  }
  .reader-footnote-body :global(a:hover) {
    text-decoration: underline;
  }
  .reader-footnote-loading {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 2px;
    color: var(--b3-theme-on-surface-light, #999);
    font-size: 12px;
  }

  .reader-settings {
    /* 2026-08-25 紧凑化：4 大分组 26+ setting-row 弹窗高度溢出，max-height 提到 80vh、宽度 300px、
       padding/gap 减小 40% 左右，保证 4 大分组一屏可览 70% 内容 */
    /* ⚠️ 2026-10-08 顶栏浮层化：34 → 44。旧值是「顶栏占位」的锚点；
       浮层化后顶栏底沿在 36px 附近，原值会把设置面板顶栏压住一截。 */
    top: 44px;
    right: 8px;
    width: 300px;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 80vh;
    overflow-y: auto;
  }
  .reader-setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 12px;
  }
  .reader-setting-hint {
    margin: -6px 0 8px;
    font-size: 11px;
    line-height: 1.5;
    color: var(--b3-theme-on-background, #555);
    opacity: 0.72;
  }
  /* 2026-08-24：4 大分组（details/summary 折叠） */
  .reader-setting-section {
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.1));
    border-radius: 6px;
    padding: 0;
    margin: 2px 0;
  }
  .reader-setting-section[open] {
    background: var(--b3-theme-background-light, rgba(0, 0, 0, 0.02));
  }
  .reader-setting-section-title {
    cursor: pointer;
    padding: 5px 8px;
    font-weight: 600;
    font-size: 12.5px;
    user-select: none;
    list-style: none;
    display: block;
  }
  .reader-setting-section-title::-webkit-details-marker { display: none; }
  .reader-setting-section > .reader-setting-row {
    padding: 2px 8px;
    min-height: 26px;
  }
  /* 2026-08-25：2x2 网格（4 边距等成对属性紧凑布局） */
  .reader-setting-grid-2col {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2px 8px;
    padding: 2px 8px;
  }
  .reader-setting-grid-2col > .reader-setting-row {
    padding: 0;
    min-height: 24px;
  }
  /* 2026-08-25：2 列网格（label + control） */
  .reader-setting-grid-2col > .reader-setting-row {
    display: grid;
    grid-template-columns: minmax(0, auto) 1fr;
    align-items: center;
    gap: 4px;
  }
  /* slider（input[type=range]） */
  .reader-slider {
    flex: 1;
    min-width: 0;
    accent-color: var(--b3-theme-primary, #3573f0);
    height: 4px;
  }
  .reader-setting-subblock {
    margin: 4px 0 6px;
    padding: 10px 10px 4px;
    border: 1px dashed var(--b3-border-color, rgba(0, 0, 0, 0.15));
    border-radius: 8px;
    background: var(--b3-theme-background-light, rgba(0, 0, 0, 0.03));
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .reader-setting-subtitle {
    font-size: 12px;
    font-weight: 600;
    color: var(--b3-theme-primary, #3573f0);
  }
  .reader-input {
    flex: 1;
    min-width: 0;
    padding: 5px 8px;
    font-size: 12px;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.12));
    border-radius: 5px;
    background: var(--b3-theme-background, #fff);
    color: var(--b3-theme-on-background, #333);
    box-sizing: border-box;
  }
  /* textarea */
  .reader-setting-textarea {
    flex: 1;
    min-width: 0;
    width: 100%;
    min-height: 32px;
    padding: 4px 6px;
    font-family: var(--b3-font-family, sans-serif);
    font-size: 12px;
    line-height: 1.4;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.12));
    border-radius: 4px;
    background: var(--b3-theme-background, #fff);
    color: var(--b3-theme-on-background, #333);
    resize: vertical;
    box-sizing: border-box;
  }
  .reader-setting-textarea:focus {
    outline: none;
    border-color: var(--b3-theme-primary, #3573f0);
  }
  .reader-font-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 2px 0 4px;
  }
  .reader-font-item {
    display: flex;
    align-items: center;
    gap: 6px;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.12));
    border-radius: 6px;
    padding: 3px 6px;
  }
  .reader-font-item-active {
    border-color: var(--b3-theme-primary, #378add);
    background: var(--b3-theme-primary-light, rgba(55, 138, 221, 0.08));
  }
  .reader-font-pick {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    background: none;
    border: none;
    cursor: pointer;
    padding: 2px;
    text-align: left;
    min-width: 0;
  }
  .reader-font-name {
    font-size: 12px;
    color: var(--b3-theme-on-background, #333);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .reader-font-size {
    font-size: 11px;
    color: var(--b3-theme-on-surface-light, #888);
    flex-shrink: 0;
  }
  .reader-font-del {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--b3-theme-error, #e24b4a);
    font-size: 11px;
    padding: 2px 4px;
    flex-shrink: 0;
  }
  .reader-font-empty {
    font-size: 12px;
    color: var(--b3-theme-on-surface-light, #888);
    padding: 2px;
  }
  .reader-font-import {
    border: 1px dashed var(--b3-border-color, rgba(0, 0, 0, 0.25));
    background: none;
    border-radius: 6px;
    padding: 5px;
    font-size: 12px;
    cursor: pointer;
    color: var(--b3-theme-primary, #378add);
  }
  .reader-font-import:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .reader-setting-label {
    font-size: 12px;
    color: var(--b3-theme-on-surface, #666);
    flex-shrink: 0;
  }
  .reader-setting-col {
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
  }
  .reader-text-input {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.15));
    border-radius: 6px;
    padding: 5px 8px;
    font-size: 12px;
    color: var(--b3-theme-on-background, #333);
    background: var(--b3-theme-background, #fff);
    font-family: var(--b3-font-family, inherit);
  }
  .reader-text-clear {
    align-self: flex-end;
    background: none;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.15));
    border-radius: 6px;
    padding: 3px 10px;
    font-size: 12px;
    cursor: pointer;
    color: var(--b3-theme-on-background, #333);
  }
  .reader-text-clear:hover {
    background: var(--b3-theme-background-light, rgba(0, 0, 0, 0.06));
  }

  /* ---- 2026-08-28 分类字体设置（衬线/无衬线/等宽/中文）---- */
  /* 下拉行：标签在上、选择器在下——长字体名不会挤压标签 */
  .reader-setting-row-stack {
    flex-direction: column;
    align-items: stretch;
    gap: 4px;
  }
  .reader-font-select {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.15));
    border-radius: 6px;
    padding: 5px 8px;
    font-size: 12px;
    cursor: pointer;
    color: var(--b3-theme-on-background, #333);
    background: var(--b3-theme-background, #fff);
    font-family: var(--b3-font-family, inherit);
  }
  .reader-font-hint {
    font-size: 11px;
    line-height: 1.5;
    opacity: 0.6;
    padding: 2px 0 4px;
  }

  /* v1.3.0 本书上下文（lite Protyle 编辑区） */
  .reader-primer-box {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 6px;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.12));
    border-radius: 8px;
    margin: 2px 0 6px;
  }
  .reader-primer-tip {
    font-size: 11px;
    line-height: 1.5;
    opacity: 0.6;
  }
  .reader-primer-editor {
    /* 容器必须有高度才能挂载 lite Protyle（AnnEditor 内部有 rAF 重试兜底） */
    height: 180px;
    overflow-y: auto;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.1));
    border-radius: 6px;
    background: var(--b3-theme-background, #fff);
  }
  .reader-primer-editor :global(.protyle) {
    height: 100%;
  }
  .reader-primer-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
  }
  .reader-primer-stats {
    font-size: 11px;
    opacity: 0.6;
  }
  .reader-primer-warn {
    color: var(--b3-theme-warning, #d97706);
    opacity: 1;
  }
  /* 2026-08-31 v1.4.4 P2：小卡状态行（运行状态 + 6 个 chip） */
  .reader-bl-status {
    background: var(--b3-theme-surface, rgba(0, 0, 0, 0.02));
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.1));
    border-radius: 8px;
    padding: 8px 10px;
    margin-bottom: 10px;
  }
  .reader-bl-status-line {
    display: flex; align-items: center; gap: 8px; margin-bottom: 6px;
  }
  .reader-bl-status-dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--b3-theme-on-surface, #999);
    flex-shrink: 0;
  }
  .reader-bl-status-dot.reader-bl-on {
    background: var(--b3-theme-primary, #4285f4);
    box-shadow: 0 0 0 3px rgba(66, 133, 244, 0.15);
    animation: reader-bl-pulse 1.6s ease-in-out infinite;
  }
  @keyframes reader-bl-pulse {
    0%, 100% { box-shadow: 0 0 0 3px rgba(66, 133, 244, 0.15); }
    50%      { box-shadow: 0 0 0 6px rgba(66, 133, 244, 0.05); }
  }
  .reader-bl-status-text {
    flex: 1; font-size: 12px; opacity: 0.85;
  }
  .reader-bl-detail-btn {
    font-size: 11px; padding: 2px 8px;
  }
  .reader-bl-chips {
    display: flex; flex-wrap: wrap; gap: 4px;
  }
  .reader-bl-chip {
    font-size: 10.5px; padding: 1px 6px;
    background: var(--b3-theme-surface, rgba(0, 0, 0, 0.03));
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.12));
    border-radius: 999px;
    opacity: 0.7;
  }
  .reader-bl-chip-on {
    opacity: 1;
    background: rgba(66, 133, 244, 0.1);
    border-color: rgba(66, 133, 244, 0.3);
    color: var(--b3-theme-primary, #4285f4);
  }
  .reader-mini-btn-warn {
    color: var(--b3-theme-error, #d44c47);
  }
  .reader-mini-btn-warn:hover { background: rgba(212, 76, 71, 0.1); }

  .reader-setting-control {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .reader-mini-btn {
    background: none;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.15));
    border-radius: 6px;
    padding: 3px 8px;
    font-size: 12px;
    cursor: pointer;
    color: var(--b3-theme-on-background, #333);
  }
  .reader-mini-btn:hover {
    background: var(--b3-theme-background-light, rgba(0, 0, 0, 0.06));
  }
  .reader-setting-value {
    font-size: 12px;
    min-width: 34px;
    text-align: center;
    color: var(--b3-theme-on-background, #333);
  }
  /* 2026-08-28：设置面板内说明文案（token 警告 / 缓存说明） */
  .reader-setting-tip {
    font-size: 11px;
    line-height: 1.5;
    opacity: 0.62;
    margin: 1px 0 4px;
    padding-left: 2px;
  }
  .reader-setting-tip-warn {
    color: var(--b3-theme-warning, #d97706);
    opacity: 1;
  }
  /* 2026-08-28：翻译缓存块（书名 + 选择器 + 页数统计） */
  .reader-cache-block {
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.12));
    border-radius: 8px;
    padding: 8px 10px;
    margin: 4px 0 6px;
    background: var(--b3-list-hover, rgba(127, 127, 127, 0.06));
  }
  .reader-cache-book {
    font-size: 12px;
    font-weight: 600;
    color: var(--b3-theme-on-background, #333);
    margin: 2px 0 6px;
    padding-left: 2px;
    word-break: break-all;
  }
  .reader-select {
    max-width: 160px;
    font-size: 12px;
    padding: 2px 4px;
    border-radius: 6px;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.18));
    background: var(--b3-theme-background, #fff);
    color: var(--b3-theme-on-background, #333);
    cursor: pointer;
  }
  .reader-mini-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  /* 2026-08-30：整书预翻译细化弹窗样式（overlay 遮罩 / 毛玻璃 modal / 统计卡片 / 进度条 / 按钮）。
     复用 reader-ui.less 的 --reword-glass-* 毛玻璃令牌，与 .reader-sel-main / .reader-toc-panel 等浮层观感统一。 */
  .reword-pt-overlay {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.42);
    -webkit-backdrop-filter: blur(2px);
    backdrop-filter: blur(2px);
    animation: reword-pt-fade var(--reword-dur-base) var(--reword-ease);
  }
  @keyframes reword-pt-fade {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  .reword-pt-modal {
    width: min(440px, calc(100vw - 32px));
    max-height: calc(100vh - 48px);
    overflow-y: auto;
    padding: var(--reword-space-4);
    border-radius: var(--reword-radius-lg);
    color: var(--reword-glass-fg, #fff);
    animation: reword-pt-pop var(--reword-dur-base) var(--reword-ease);
  }
  @keyframes reword-pt-pop {
    from { opacity: 0; transform: translateY(8px) scale(0.98); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  .reword-pt-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--reword-space-3);
  }
  .reword-pt-title {
    font-size: 15px;
    font-weight: 600;
  }
  .reword-pt-close {
    background: none;
    border: none;
    color: inherit;
    font-size: 20px;
    line-height: 1;
    cursor: pointer;
    opacity: 0.7;
    padding: 2px 6px;
    border-radius: var(--reword-radius-sm);
    transition: opacity var(--reword-dur-fast) var(--reword-ease),
      background var(--reword-dur-fast) var(--reword-ease);
  }
  .reword-pt-close:hover {
    opacity: 1;
    background: var(--reword-glass-fill-hover, rgba(255, 255, 255, 0.18));
  }
  .reword-pt-book {
    display: flex;
    align-items: center;
    gap: var(--reword-space-3);
    padding: var(--reword-space-3);
    border-radius: var(--reword-radius-md);
    background: var(--reword-glass-fill, rgba(255, 255, 255, 0.1));
    margin-bottom: var(--reword-space-3);
  }
  .reword-pt-cover {
    flex: 0 0 auto;
    width: 40px;
    height: 52px;
    border-radius: var(--reword-radius-sm);
    background: linear-gradient(135deg, var(--b3-theme-primary, #378add), #6aa6e6);
    color: #fff;
    font-size: 10px;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    letter-spacing: 1px;
  }
  .reword-pt-book-title {
    font-size: 13px;
    font-weight: 600;
    word-break: break-all;
  }
  .reword-pt-book-sub {
    font-size: 11px;
    opacity: 0.7;
    margin-top: 2px;
  }
  .reword-pt-stats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: var(--reword-space-2);
    margin-bottom: var(--reword-space-3);
  }
  .reword-pt-stat {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: var(--reword-space-2) 4px;
    border-radius: var(--reword-radius-sm);
    background: var(--reword-glass-fill, rgba(255, 255, 255, 0.1));
  }
  .reword-pt-stat-label {
    font-size: 10px;
    opacity: 0.65;
  }
  .reword-pt-stat-num {
    font-size: 15px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .reword-pt-ok { color: var(--b3-theme-success, #4caf50); }
  .reword-pt-warn { color: var(--b3-theme-warning, #f59e0b); }
  .reword-pt-options {
    display: flex;
    flex-direction: column;
    gap: var(--reword-space-2);
    margin-bottom: var(--reword-space-3);
    transition: opacity var(--reword-dur-fast) var(--reword-ease);
  }
  .reword-pt-disabled {
    opacity: 0.55;
    pointer-events: none;
  }
  .reword-pt-field {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--reword-space-3);
  }
  .reword-pt-field label {
    font-size: 12px;
    opacity: 0.85;
    flex: 0 0 auto;
  }
  .reword-pt-field select,
  .reword-pt-field input {
    flex: 1 1 auto;
    max-width: 220px;
    font-size: 12px;
    padding: 4px 6px;
    border-radius: var(--reword-radius-sm);
    border: 1px solid var(--reword-glass-border-strong, rgba(255, 255, 255, 0.24));
    background: var(--reword-glass-fill, rgba(255, 255, 255, 0.1));
    color: inherit;
  }
  .reword-pt-field input[type="number"] {
    max-width: 90px;
    text-align: center;
  }
  .reword-pt-field select option:disabled {
    opacity: 0.5;
    font-style: italic;
  }
  .reword-pt-tencent-lock {
    flex-wrap: wrap;
    row-gap: 4px;
  }
  .reword-pt-tencent-lock label {
    align-self: center;
  }
  .reword-pt-lock-input {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 1 1 auto;
    justify-content: flex-end;
  }
  .reword-pt-lock-input input {
    max-width: 80px;
    text-align: right;
  }
  .reword-pt-lock-input span {
    font-size: 11px;
    opacity: 0.75;
    white-space: nowrap;
  }
  .reword-pt-lock-used {
    width: 100%;
    text-align: right;
    font-size: 11px;
    opacity: 0.7;
    margin-top: -2px;
  }
  .reword-pt-pipeline-flow {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1 1 auto;
    justify-content: flex-end;
  }
  .reword-pt-pill {
    font-size: 11px;
    font-weight: 500;
    padding: 3px 10px;
    border-radius: var(--reword-radius-sm);
    background: var(--reword-glass-fill, rgba(255, 255, 255, 0.1));
    border: 1px solid var(--reword-glass-border-strong, rgba(255, 255, 255, 0.24));
    white-space: nowrap;
  }
  .reword-pt-pill-ai {
    background: rgba(255, 255, 255, 0.18);
    border-color: var(--b3-theme-primary, rgba(255, 255, 255, 0.45));
  }
  .reword-pt-arrow {
    font-size: 13px;
    opacity: 0.8;
    line-height: 1;
  }
  .reword-pt-overwrite {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    opacity: 0.85;
    cursor: pointer;
  }
  .reword-pt-overwrite input {
    flex: 0 0 auto;
  }
  .reword-pt-progress {
    margin-bottom: var(--reword-space-3);
  }
  .reword-pt-telemetry {
    margin-bottom: var(--reword-space-3);
    padding: 10px 12px;
    border-radius: var(--reword-radius-md);
    background: var(--reword-glass-fill, rgba(255, 255, 255, 0.06));
    border: 1px solid var(--reword-glass-border, rgba(255, 255, 255, 0.12));
  }
  .reword-pt-telemetry-title {
    font-size: 12px;
    font-weight: 600;
    margin-bottom: 8px;
    opacity: 0.85;
  }
  .reword-pt-telemetry-grid {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
  }
  .reword-pt-tel-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .reword-pt-tel-label {
    font-size: 11px;
    opacity: 0.6;
  }
  .reword-pt-tel-num {
    font-size: 14px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .reword-pt-tel-engines {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 8px;
  }
  .reword-pt-tel-engine {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: var(--reword-radius-pill);
    background: var(--reword-glass-fill-strong, rgba(255, 255, 255, 0.12));
    opacity: 0.9;
  }
  .reword-pt-progress-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 12px;
    margin-bottom: 6px;
  }
  .reword-pt-eta {
    opacity: 0.7;
    font-variant-numeric: tabular-nums;
  }
  .reword-pt-bar {
    height: 8px;
    border-radius: var(--reword-radius-pill);
    background: var(--reword-glass-fill, rgba(255, 255, 255, 0.1));
    overflow: hidden;
  }
  .reword-pt-bar-fill {
    height: 100%;
    border-radius: var(--reword-radius-pill);
    background: linear-gradient(90deg, var(--b3-theme-primary, #378add), #6aa6e6);
    transition: width var(--reword-dur-base) var(--reword-ease);
  }
  /* 2026-08-31：后台运行悬浮提示（点击重开弹窗看进度） */
  .reword-pt-floating {
    position: fixed;
    z-index: 61;
    right: 20px;
    bottom: 20px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    border-radius: var(--reword-radius-pill);
    color: var(--reword-glass-fg, #fff);
    cursor: pointer;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.28);
    animation: reword-pt-fade var(--reword-dur-base) var(--reword-ease);
    user-select: none;
  }
  .reword-pt-floating:hover { filter: brightness(1.08); }
  .reword-pt-floating-spinner {
    width: 12px;
    height: 12px;
    border: 2px solid rgba(255, 255, 255, 0.35);
    border-top-color: #fff;
    border-radius: 50%;
    animation: reword-pt-spin 0.8s linear infinite;
  }
  @keyframes reword-pt-spin { to { transform: rotate(360deg); } }
  .reword-pt-floating-text { font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .reword-pt-floating-hint { font-size: 11px; opacity: 0.65; }
  .reword-pt-footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--reword-space-2);
    margin-top: var(--reword-space-2);
  }
  .reword-pt-btn {
    font-size: 12px;
    padding: 6px 14px;
    border-radius: var(--reword-radius-sm);
    cursor: pointer;
    border: 1px solid transparent;
    transition: background var(--reword-dur-fast) var(--reword-ease),
      opacity var(--reword-dur-fast) var(--reword-ease),
      filter var(--reword-dur-fast) var(--reword-ease);
  }
  .reword-pt-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .reword-pt-btn-ghost {
    background: transparent;
    border-color: var(--reword-glass-border-strong, rgba(255, 255, 255, 0.24));
    color: inherit;
  }
  .reword-pt-btn-ghost:hover:not(:disabled) {
    background: var(--reword-glass-fill, rgba(255, 255, 255, 0.1));
  }
  .reword-pt-btn-primary {
    background: var(--b3-theme-primary, #378add);
    color: #fff;
  }
  .reword-pt-btn-primary:hover:not(:disabled) {
    filter: brightness(1.08);
  }
  .reword-pt-btn-warn {
    background: var(--b3-theme-error, #d9534f);
    color: #fff;
  }
  .reword-pt-btn-warn:hover:not(:disabled) {
    filter: brightness(1.08);
  }
  .reader-seg {
    background: none;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.15));
    border-radius: 6px;
    padding: 3px 9px;
    font-size: 12px;
    cursor: pointer;
    color: var(--b3-theme-on-background, #333);
  }
  .reader-seg:hover {
    /* 2026-10-25 交互态修复：background-light 在 Neo/Asri/midnight 三主题下与底色
       ΔRGB=0（hover 无反馈）；--b3-list-hover 是七套主题都有定义的中性填充（审计 R1） */
    background: var(--b3-list-hover, rgba(0, 0, 0, 0.06));
  }
  .reader-seg-active {
    background: var(--b3-theme-primary, #378add);
    border-color: transparent;
    color: #fff;
  }
  .reader-theme-grid {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 4px;
  }
  .reader-theme-swatch {
    background: none;
    border: 1px solid var(--b3-border-color, rgba(0, 0, 0, 0.15));
    border-radius: 6px;
    padding: 3px 2px;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }
  .reader-swatch-dot {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 1px solid rgba(0, 0, 0, 0.12);
    display: inline-block;
  }
  .reader-swatch-label {
    font-size: 10px;
    color: var(--b3-theme-on-background, #333);
    line-height: 1;
  }

  .reader-bottom-bar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 5px 8px;
    /* 2026-08-29 Phase 1：底部安全区（Home Indicator） */
    padding-bottom: calc(5px + env(safe-area-inset-bottom, 0px));
    /* 2026-08-28 B2：悬浮药丸条质感——思源 surface 底 + 圆角 + 柔和投影，
       替代原 border-top 直条，更贴合思源原生工具栏观感。
       2026-10-07：底栏改为**纯浮层**（浮在文字上层、盖住部分正文，正文不动），
       视觉上改半透明毛玻璃 —— 不透明实色会「糊掉一块」，
       半透明能隐约看见底下的字，更像「浮在上面」。 */
    border-radius: var(--b3-border-radius, 8px);
    background: color-mix(in srgb, var(--b3-theme-surface, var(--b3-theme-background, #fff)) 82%, transparent);
    -webkit-backdrop-filter: blur(12px) saturate(1.2);
    backdrop-filter: blur(12px) saturate(1.2);
    /* 顶部一道极淡的分隔线：与正文有边界但不突兀 */
    border-top: 1px solid color-mix(in srgb,
      var(--b3-border-color, rgba(255, 255, 255, 0.1)) 55%, transparent);
    box-shadow: var(--b3-point-shadow, 0 2px 10px rgba(0, 0, 0, 0.12));
    /* 2026-08-30 改造：默认完全隐藏（macOS 程序坞机制）。
       移出文档流（absolute + translateY(140%)）以免占据/遮挡阅读高度；
       显现时从底部平滑滑入、覆盖底部，隐藏态不拦截任何事件、不挡正文。 */
    position: absolute;
    left: 6px;
    right: 6px;
    bottom: 6px;
    z-index: var(--rz-toolbar);
    opacity: 0;
    pointer-events: none;
    /* 2026-10-07：收起态带一点缩小，浮起时「浮上来」的层次感更强 */
    transform: translateY(140%) scale(0.98);
    transition: opacity var(--reword-dur-base) var(--reword-ease),
      transform var(--reword-dur-base) var(--reword-ease);
  }
  /* 显现态：点击把手浮起 → 平滑滑入 + 回到原尺寸 */
  .reader-bottom-bar.bottom-bar-revealed {
    opacity: 1;
    pointer-events: auto;
    transform: translateY(0) scale(1);
  }
  /* ⚠️ color-mix 兜底（2026-10-07）：上面那条 background 用的是
     `color-mix(...)`。若宿主环境不支持该函数，**整条声明会失效**，
     background 退为 transparent ⇒ 底栏下方文字直接透出、控件不可见。
     故必须显式兜一个不透明底色。 */
  @supports not (color: color-mix(in srgb, red, blue)) {
    .reader-bottom-bar {
      background: var(--b3-theme-surface, var(--b3-theme-background, #fff));
      border-top: 1px solid var(--b3-border-color, rgba(255, 255, 255, 0.1));
    }
  }
  /* 收起按钮：进度条左上角，点击即收起（解除固定） */
  .reader-bottom-collapse {
    font-size: 14px;
    line-height: 1;
    padding: 0 7px;
    color: var(--b3-theme-on-surface-light, #888);
  }
  @media (prefers-reduced-motion: reduce) {
    .reader-bottom-bar {
      transition: none;
    }
  }
  /* 2026-08-30 · 底部进度条「把手」：常驻的中央圆点，收起 / 展开都可见、可点。
     收起态贴底显示圆点；展开态被进度条顶到其上方中央，再次点击收起。 */
  .reader-bottom-handle {
    position: absolute;
    left: 50%;
    bottom: 8px;
    z-index: var(--rz-handle); /* 高于进度条（--rz-toolbar），展开时把手位于进度条上方仍可见可点 */
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: transparent;
    cursor: pointer;
    opacity: 0.5;
    transform: translateX(-50%);
    transition: bottom var(--reword-dur-base) var(--reword-ease),
      opacity var(--reword-dur-fast, 120ms) var(--reword-ease);
    pointer-events: auto;
  }
  .reader-bottom-handle:hover {
    opacity: 1;
  }
  /* 展开态：从底部 8px 上移到进度条上方中央（进度条高约 40px + 6px 底距） */
  .reader-bottom-handle.reader-bottom-handle-revealed {
    bottom: 56px;
  }
  .reader-bottom-handle-dot {
    display: block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--b3-theme-on-surface, #666);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
    transition: transform var(--reword-dur-fast, 120ms) var(--reword-ease),
      background-color var(--reword-dur-fast, 120ms) var(--reword-ease);
  }
  .reader-bottom-handle:hover .reader-bottom-handle-dot {
    transform: scale(1.35);
    background: var(--b3-theme-primary, #378add);
  }
  /* 2026-08-28：连续朗读控制条（参考 Readest 朗读体验） */
  .reader-tts-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    /* 2026-08-29 Phase 1：底部安全区（Home Indicator） */
    padding-bottom: calc(6px + env(safe-area-inset-bottom, 0px));
    margin: 0 6px 6px;
    border-radius: var(--b3-border-radius, 8px);
    background: var(--b3-theme-surface, var(--b3-theme-background, #fff));
    box-shadow: var(--b3-point-shadow, 0 2px 10px rgba(0, 0, 0, 0.12));
    flex-shrink: 0;
    position: relative;
    z-index: 1;
    font-size: 13px;
  }
  .reader-tts-btn {
    min-width: 30px;
    height: 30px;
    padding: 0 8px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 15px;
  }
  .reader-tts-play {
    font-size: 17px;
    color: var(--b3-theme-primary, #378add);
  }
  .reader-tts-meta {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    overflow: hidden;
  }
  .reader-tts-progress {
    flex-shrink: 0;
    color: var(--b3-theme-on-surface, #666);
    font-variant-numeric: tabular-nums;
  }
  .reader-tts-current {
    flex: 1;
    min-width: 0;
    color: var(--b3-theme-on-surface, #333);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .reader-tts-rate {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
  .reader-tts-rate-label,
  .reader-tts-rate-val {
    color: var(--b3-theme-on-surface, #666);
    font-size: 12px;
    white-space: nowrap;
  }
  .reader-tts-rate input[type="range"] {
    width: 84px;
  }
  .reader-progress-wrap {
    flex: 1;
    display: flex;
    align-items: center;
    padding: 0 4px;
    position: relative; /* 章节刻度定位基准 */
  }
  /* 章节起始刻度（Foliate 风格）：位置由 JS 按 section 体积累加算出 */
  .reader-chapter-tick {
    position: absolute;
    top: 50%;
    width: 2px;
    height: 9px;
    margin-left: -1px;
    background: var(--b3-theme-on-surface-light, rgba(128, 128, 128, 0.6));
    border-radius: 1px;
    transform: translateY(-50%);
    pointer-events: none;
    opacity: 0.7;
  }
  .reader-progress-bar {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 5px;
    border-radius: 999px;
    background: linear-gradient(to right,
      var(--b3-theme-primary, #378add) 0%,
      var(--b3-theme-primary, #378add) var(--progress, 0%),
      var(--b3-theme-background-light, rgba(0, 0, 0, 0.12)) var(--progress, 0%),
      var(--b3-theme-background-light, rgba(0, 0, 0, 0.12)) 100%
    );
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.04);
    cursor: pointer;
    outline: none;
  }
  /* 跨浏览器：细滑块圆点 + 主色填充（webkit / firefox） */
  .reader-progress-bar::-webkit-slider-runnable-track {
    height: 5px;
    border-radius: 999px;
    background: linear-gradient(to right,
      var(--b3-theme-primary, #378add) 0%,
      var(--b3-theme-primary, #378add) var(--progress, 0%),
      var(--b3-theme-background-light, rgba(0, 0, 0, 0.12)) var(--progress, 0%),
      var(--b3-theme-background-light, rgba(0, 0, 0, 0.12)) 100%
    );
  }
  .reader-progress-bar::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 13px;
    height: 13px;
    margin-top: -4px;
    border-radius: 50%;
    background: var(--b3-theme-primary, #378add);
    border: 2px solid var(--b3-theme-background, #fff);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.28);
  }
  .reader-progress-bar::-moz-range-track {
    height: 5px;
    border-radius: 999px;
    background: linear-gradient(to right,
      var(--b3-theme-primary, #378add) 0%,
      var(--b3-theme-primary, #378add) var(--progress, 0%),
      var(--b3-theme-background-light, rgba(0, 0, 0, 0.12)) var(--progress, 0%),
      var(--b3-theme-background-light, rgba(0, 0, 0, 0.12)) 100%
    );
  }
  .reader-progress-bar::-moz-range-thumb {
    width: 13px;
    height: 13px;
    border-radius: 50%;
    background: var(--b3-theme-primary, #378add);
    border: 2px solid var(--b3-theme-background, #fff);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.28);
  }
  .reader-progress-text {
    font-size: 11px;
    color: var(--b3-theme-on-surface-light, #888);
    min-width: 34px;
    text-align: right;
  }

  /* 2026-10-07 · 底栏页眉/页脚位（接通 showHeaderFooter，此前是完全死设置）。
     章节名与剩余章节各占一段，宽度用 flex:1 分摊，避免把翻页按钮挤出可视区。 */
  .reader-chapter-name,
  .reader-remaining {
    font-size: 11px;
    color: var(--b3-theme-on-surface-light, #888);
    /* 章节名可能很长；单行截断 + 完整名挂 title（避免底栏被长标题撑变形） */
    max-width: 30%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .reader-chapter-name { flex: 0 1 auto; }
  .reader-remaining { flex: 0 0 auto; white-space: nowrap; }

  .reader-error {
    position: absolute;
    inset: 40px 0 0 0;
    /* 2026-08-24 修复：z-index 从 100 降到 3，避免压住思源原生 UI */
    z-index: 3;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--b3-theme-error, #e24b4a);
    font-size: 13px;
  }

  /* 2026-08-26 调试 HUD：高亮渲染链路诊断 */
  .reader-debug-hud {
    position: fixed;
    bottom: 60px;
    right: 8px;
    z-index: 2147483647;
    background: rgba(0, 0, 0, 0.88);
    color: #00ff88;
    font-family: "SF Mono", Menlo, Consolas, monospace;
    font-size: 11px;
    line-height: 1.5;
    padding: 8px 10px;
    border-radius: 6px;
    max-width: 380px;
    word-break: break-all;
    pointer-events: auto;
    box-shadow: 0 2px 12px rgba(0,0,0,0.5);
    user-select: text;
  }
  .reader-debug-hud-title {
    color: #ffcc00;
    font-weight: 700;
    margin-bottom: 4px;
    border-bottom: 1px solid rgba(255,255,255,0.15);
    padding-bottom: 3px;
  }
  .reader-debug-hud-row {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .reader-debug-hud-row b { color: #66ccff; }

  /* ========= 2026-09-09 P1：矩形框选捕获层 ========= */
  .pdf-rect-capture {
    position: absolute;
    inset: 0;
    z-index: 7;
    cursor: crosshair;
    background: transparent;
    user-select: none;
  }
  .pdf-rect-preview {
    position: absolute;
    border: 1.5px dashed var(--b3-theme-primary, #3583e0);
    background: rgba(53, 131, 224, 0.12);
    border-radius: 2px;
    box-sizing: border-box;
    pointer-events: none;
  }
  .pdf-rect-hint {
    position: absolute;
    top: 10px;
    left: 50%;
    transform: translateX(-50%);
    padding: 4px 12px;
    border-radius: 12px;
    font-size: 12px;
    color: var(--b3-theme-on-surface, #555);
    background: var(--b3-theme-surface, #fff);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    pointer-events: none;
    white-space: nowrap;
  }
</style>
