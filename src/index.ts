/**
 * RE 阅读器 · 插件入口（独立插件）
 * ==================================================================
 * 从 `siyuan-plugin-reword` 拆出（原为主插件 dock 里的一个 feature）。
 *
 * 与主插件的差异（切分带来的三处适配）：
 *  1. 挂载方式：原为 `DockManager` 的一个 feature（组合栏 Tab），现为
 *     **独立主区页签 + 顶栏图标 + 命令**，不再依赖主插件 dock 框架。
 *  2. 容器结构：`ReaderDockController.render()` 原先找 `#hiword-dock-content`
 *     （主插件 dock 的内容容器），本插件没有该容器 → `mountShelf` 走
 *     `target` 自身，并在下方 `shelfHost()` 里造一个等价容器。
 *  3. 批注：（2026-10-13 迁移）数据留在本插件 `hiword-annotations.json`，
 *     不再依赖主插件 bridge。主插件缺席时批注完全不受影响。
 *
 * 生命周期铁律（沿用 re-todo 的经验）：
 *  · addTab / addTopBar / addCommand **必须在任何 await 之前同步注册**；
 *  · 页签 init 闭包捕获 plugin 引用；
 *  · window/document 级监听器保留引用，onunload 摘除。
 */
import { Plugin, openTab, showMessage, Dialog } from "siyuan";
import { t, initI18n, saveLang } from "./i18n/index.ts";
import { ReaderDockController } from "./reader/reader-dock.ts";
import { getAnnotationStore, initAnnotationStore, flushAnnotationStore } from "./annotation/store-singleton.ts";
import { installConsoleFilter } from "./core/console-filter.ts";
import { logSwallow } from "./core/safe.ts";
import { getLogger } from "./core/logger.ts";
import { DictManager } from "./dict/dict-manager.ts";
import { TranslateHost } from "./translate/host.ts";
import { DEFAULT_REWORD_TTS, type RewordTtsSettings } from "./reader/reader-tts.ts";
// 2026-10-26 版本更新弹窗（对标 Excali Studio）：升级后弹一次「本次更新了什么」。
// 纯逻辑在 core/changelog.ts（不 import 思源 SDK，node 侧可直接跑单测），
// 这里只负责取版本号 / 存版本号 / 开弹窗三件事。
import {
  PLUGIN_VERSION,
  VERSION_SLOT,
  changelogDecision,
  changelogPath,
  fetchPluginFile,
  renderChangelogHtml,
  sliceVersionSection,
} from "./core/changelog.ts";
// 2026-10-24 移动端适配：思源移动端 openTab 是官方空实现（app/src/plugin/API.ts
// `/// #if MOBILE` → `openTab = () => {} // TODO: Mobile`），页签入口整条不可用。
// 2026-10-26 路线 A：移动端承载从思源 Dialog 换成**全屏浮层**（对标「思阅」SiReader
// v2.5.7）—— 思源 Dialog 的 height 只写在 container、body 无确定高度，我们得靠
// hardenDialogBody 硬修；且 Dialog 自带标题栏 chrome、书架/阅读两层叠加。
// 调研与证据：docs/手机端适配对标思阅-调研与方案-2026-10-26.md
import { isMobile } from "./core/env.ts";
import { mobileOverlay } from "./core/mobile-overlay-host.ts";
import "./index.less";

/** 书架入口页签类型（本插件的入口壳） */
const SHELF_TAB_TYPE = "re-reader-shelf";

/** 阅读页签类型（与 reader 内部注册值一致，点书后打开） */
const READER_TAB_TYPE = "reader";

/** 朗读设置持久化文件名（本插件独立存储，命名空间 siyuan-plugin-reader） */
const TTS_SETTINGS_KEY = "reword-tts.json";

export class ReaderPlugin extends Plugin {
  /** 阅读器控制器（书架 + 设置 + 字体 + 页签） */
  private readerDock!: ReaderDockController;
  /** 词典管理（含导入接口） */
  private dictManager!: DictManager;
  /** 翻译宿主（引擎链装配 + 按书缓存 + AI 末端） */
  private translateHost: TranslateHost | null = null;
  /** 朗读设置（本插件独立持久化，onload 载入，阅读器面板读写此副本） */
  private ttsSettings: RewordTtsSettings = { ...DEFAULT_REWORD_TTS };
  /** 已挂载的书架宿主 */
  private shelfMounted = false;
  /**
   * 词库跨插件桥「未就绪」toast 的一次性闸门（2026-10-15 P0 断链接链）。
   * hasWord 每次渲染词典卡都会调，写侧也可能被 AI 自动收词批量触发；
   * 缺席时只在第一次写操作可见提示，其余静默降级为"未加词"，避免刷屏。
   */
  private vocabBridgeWarned = false;

  async onload(): Promise<void> {
    const plugin = this;

    /* ============ 0. 注册自定义图标（必须在 addTopBar / addTab 之前）===========
     * 漏了这步会导致：顶栏图标与页签图标都找不到 → 思源抛
     * "Icon must be svg id or svg tag"，进而「进入」按钮出现但点不开/显示空白。
     * 主插件踩过同样的坑（2026-08-17：多 symbol 拼成一条传给 addIcons，
     * 其中一个带 xmlns 导致整串解析失败、全部图标未注册）。
     * 故：每个 symbol 单独 addIcons，且一律用纯 viewBox 写法（不带 xmlns）。*/
    const readerIcons = [
      // 主图标 / 顶栏 / 页签：展开的书页（与主插件「合拢的书」区分，这是阅读器）
      `<symbol id="iconREReader" viewBox="0 0 1024 1024"><g fill="none" stroke="currentColor" stroke-width="56" stroke-linecap="round" stroke-linejoin="round"><path d="M192 256c128-64 256-80 384-48v560c-128-32-256-16-384 48z"/><path d="M832 256c-128-64-256-80-384-48v560c128-32 256-16 384 48z"/><path d="M512 208v560"/></g></symbol>`,
    ];
    let iconsOk = 0;
    for (const sym of readerIcons) {
      try {
        this.addIcons(sym);
        iconsOk++;
      } catch (e) {
        getLogger().warn("[RE 阅读器] 图标注册失败", { error: e });
      }
    }
    getLogger().info(`[RE 阅读器] 自定义图标注册完成 ${iconsOk}/${readerIcons.length}`);

    /* ============ 1. 同步注册（必须在任何 await 之前） ============ */

    /* 书架入口页签：同步注册，数据异步加载。
       思源插件列表里的「进入」按钮正是由 addTab 注册的页签派生的，
       所以这一段必须在 onload 同步阶段完成，不能挪到 await 之后。*/
    this.addTab({
      type: SHELF_TAB_TYPE,
      init(this: any) {
        const el = this.element as HTMLElement;
        plugin.mountShelf(el);
      },
      destroy(this: any) {
        plugin.shelfMounted = false;
      },
    });

    /* 阅读页签：ReaderTabController 在其构造函数内自行 addTab（同步） */

    /* 顶栏图标：点击打开书架 */
    this.addTopBar({
      id: "re-reader-open",
      icon: "iconREReader",
      title: t("打开 RE 阅读器"),
      callback: () => plugin.openShelfTab(),
    });

    /* 命令面板入口 */
    this.addCommand({
      langKey: "openShelf",
      hotkey: "",
      callback: () => plugin.openShelfTab(),
    });

    /* Console 过滤（降级 iframe sandbox / ResizeObserver loop 噪音） */
    try {
      installConsoleFilter();
    } catch (e) {
      getLogger().warn("[RE 阅读器] Console 过滤安装失败", { error: e });
    }

    /* ============ 2. 异步初始化（注册已完成，可安全 await） ============ */

    /* 界面语言（必须在任何 UI 渲染之前）。沿用主插件口径：插件内独立切换、
       首次启动弹窗选中文 / English；任何异常都兜住，绝不把 onload 挂住。
       ⚠️ 2026-10-14 修复：此前用思源 `Plugin#i18nIO()`，但部分思源版本并未提供该方法
       ⇒ `(this as any).i18nIO()` 抛 "this.i18nIO is not a function"，语言初始化恒失败、
       每次启动刷一条红色告警。本插件 i18n 本就独立（EN_TABLE + setLang），只需一个持久化
       槽位，故改用 PersistentLoader 的 loadData/saveData 自建 IO，跨版本可用。 */
    try {
      const io = {
        load: (file: string) => this.loadData(file),
        save: async (file: string, data: unknown) => { await this.saveData(file, data); },
      };
      const savedLang = await initI18n(io);
      if (!savedLang) {
        // 2026-10-14：按用户要求去掉首次启动的「选择语言」弹窗——无记录时静默默认中文并落盘，
        // 不再调 pickInitialLang()。语言仍可在设置里手动切换（saveLang 通道保留）。
        await saveLang(io, "zh_CN");
      }
    } catch (e) {
      getLogger().warn("[RE 阅读器] 语言初始化失败，回退中文", { error: e });
    }

    /* 批注 store：初始化本地持久化层（2026-10-13 迁移：不再依赖主插件 bridge） */
    try {
      initAnnotationStore(this);
    } catch (e) {
      getLogger().warn("[RE 阅读器] 批注 store 初始化失败", { error: e });
    }

    /* 朗读设置：本插件独立持久化（2026-10-14）。
     * 阅读器面板的 getTtsSettings/saveTtsSettings 透传到 self.plugin，
     * 而 ReaderPlugin 此前**并未实现这两个方法** → 透传恒返回 null、保存恒 no-op，
     * 表现为「选了讯飞/改了参数，重开面板全回默认」。这里补齐存储层。 */
    try {
      this.ttsSettings = await this.loadTtsSettings();
    } catch (e) {
      getLogger().warn("[RE 阅读器] 朗读设置载入失败，用默认", { error: e });
    }

    /* 阅读器控制器（内部会注册阅读页签 + 加载书架/设置/字体） */
    try {
      this.readerDock = new ReaderDockController(this);
      await this.readerDock.init();
    } catch (e) {
      getLogger().error("[RE 阅读器] 阅读器初始化失败（阅读面板将不可用）", { error: e });
    }
    /* 翻译宿主（引擎链 + AI 末端 + 按书缓存）。
     * 2026-10-07 接通：此前 src/translate/ 下引擎链与全部 provider 都已迁移，
     * 但驱动它们的宿主能力（AI 翻译回调）没跟着过来，导致
     * reader-tab.ts:166 的 `plugin?.translateBatch?.()` 恒走空兜底
     *（`?? Promise.resolve([])`）→ 双语翻译完全不工作。*/
    try {
      this.translateHost = new TranslateHost(this);
      await this.translateHost.load();
    } catch (e) {
      getLogger().error("[RE 阅读器] 翻译宿主初始化失败（双语翻译不可用）", { error: e });
    }

    /* 词典引擎（划词查词/ 双语取词）+ 词典导入接口（决策 G） */
    try {
      this.dictManager = new DictManager(this);
      await this.dictManager.init();
    } catch (e) {
      getLogger().error("[RE 阅读器] 词典初始化失败（划词查词不可用）", { error: e });
    }

    /* 2026-10-13 深链接：监听 open-siyuan-url-plugin 事件，处理「回跳原书」URL。
     * 思源点击 siyuan://plugins/siyuan-plugin-reader?data=... 时会派发此事件，
     * 解析出 bookId + cfi → 打开/聚焦该书阅读 Tab → goTo 定位到原文。
     * 与主插件 onOpenBookUrl 逻辑一致，但宿主改为本插件。
     * ⚠️ 2026-10-14 修复：此前写成 this.disposables.add(...)，但本插件从未定义
     *   disposables 集合 ⇒ this.disposables 为 undefined ⇒ onload 在此抛
     *   "Cannot read properties of undefined (reading 'add')"，把 onload 后半段
     *   （含 window.__rewordTranslateHost / __rewordDictManager 挂载）整段跳过。
     *   onOpenBookUrl 是绑定的箭头属性，引用稳定，直接 on/off 即可（off 见 onunload）。 */
    this.eventBus.on("open-siyuan-url-plugin", this.onOpenBookUrl as any);

    /* 2026-10-07：把词典管理器挂到 window，供 ReaderView 里的「词典管理」弹窗使用。
     * 为什么要走 window：DictManager 由插件入口（index.ts）持有实例，而使用它的
     *  UI（ReaderView → SettingsDialog → DictManagerDialog）在 reader 模块内，
     * 两棵组件树之间没有 props 通道（re-todo 的 setApp 是同样的处理方式）。
     * onunload 时会摘除，避免热重载后残留旧实例。 */
    (window as any).__rewordDictManager = this.dictManager ?? null;
    // 2026-10-07：翻译宿主同样挂到 window，供 ReaderView 里的
    //「翻译引擎配置」二级页读写设置。与词典同一套路（两棵组件树间无 props 通道）。
    (window as any).__rewordTranslateHost = this.getTranslate();

    /* 2026-10-26：升级后的一次性更新日志。
     * 不 await：弹窗不该挡启动，失败也不该挡任何人进阅读器。 */
    void this.maybeShowChangelog();
  }

  /**
   * 版本更新弹窗。四条口径（对标 Excali Studio，用户拍板）：
   *   ① 首装不弹，只静默记版本号（用户装插件时不需要被弹窗迎接）；
   *   ② 只弹当前版本那一段（CHANGELOG.md 里 `## v<当前版本>`）；
   *   ③ 不设「不再提示」——版本号已经先记进独立槽，× 掉就不会重启再弹；
   *   ④ 读不到日志 / 该版本没写日志 / 渲染器缺失，一律静默。
   */
  private async maybeShowChangelog(): Promise<void> {
    try {
      const action = changelogDecision(await this.loadData(VERSION_SLOT), PLUGIN_VERSION);
      if (action === "unknown-version" || action === "up-to-date") return;
      // 先回写再弹：弹窗被用户划掉、或者这一段的日志其实是空的，
      // 都不该下次重启再来一遍
      await this.saveData(VERSION_SLOT, PLUGIN_VERSION);
      if (action !== "show") return;
      const section = sliceVersionSection(await fetchPluginFile(changelogPath(this.name)), PLUGIN_VERSION);
      if (!section) return;
      const dialog = new Dialog({
        title: `${t("更新日志")} v${PLUGIN_VERSION}`,
        width: "min(640px, 92vw)",
        content: `<div class="re-changelog b3-typography">${renderChangelogHtml(section)}</div>`,
      });
      dialog.element.classList.add("re-changelog-dialog");
    } catch (e) {
      getLogger().warn("[RE 阅读器] 更新日志读取失败", { error: e });
    }
  }

  /**
   * 读取当前朗读设置（供阅读器朗读控制器透传，reader-tab.ts:141）。
   * 返回浅拷贝，避免调用方原地改动画像内部状态。
   */
  public getTtsSettings(): RewordTtsSettings {
    return { ...this.ttsSettings };
  }

  /** 保存朗读设置并落盘（供阅读器透传，reader-tab.ts:142）。 */
  public async saveTtsSettings(s: RewordTtsSettings): Promise<void> {
    this.ttsSettings = { ...s };
    try {
      await this.saveData(TTS_SETTINGS_KEY, this.ttsSettings);
    } catch (e) {
      getLogger().error("[RE 阅读器] 朗读设置保存失败", { error: e });
    }
  }

  /** 从磁盘载入朗读设置，与默认合并（缺字段回退默认，engine 原样保留含 iflytek）。 */
  private async loadTtsSettings(): Promise<RewordTtsSettings> {
    try {
      const s = await this.loadData(TTS_SETTINGS_KEY);
      if (s && typeof s === "object") {
        return { ...DEFAULT_REWORD_TTS, ...(s as Partial<RewordTtsSettings>) };
      }
    } catch (e) {
      logSwallow(e, "index.ts · loadTtsSettings", "debug");
    }
    return { ...DEFAULT_REWORD_TTS };
  }

  /**
   * 挂载书架视图。
   *
   * 切分适配：`ReaderDockController.render()` 内找 `#hiword-dock-content`，
   * 那是**主插件 dock 的内容容器**；本插件没有 dock，故直接传宿主元素，
   * 由 `shelfHost()` 提供等价容器。
   */
  private mountShelf(host: HTMLElement): void {
    try {
      host.innerHTML = "";
      host.style.display = "flex";
      host.style.flexDirection = "column";
      host.style.minHeight = "0";
      host.style.position = "relative";

      // 无 controller（如初始化失败）→ 给出可读的降级提示，而非白屏
      if (!this.readerDock) {
        host.innerHTML =
          '<div style="padding:24px;font:13px/1.6 var(--b3-font-ui)">' +
          `${t("阅读器初始化失败，请查看插件日志")}</div>`;
        return;
      }
      this.readerDock.render(host);
      this.shelfMounted = true;
    } catch (e) {
      getLogger().error("[RE 阅读器] 挂载书架失败", { error: e });
    }
  }

  /**
   * 打开 / 聚焦书架页签。
   *
   * 契约（已查证 `node_modules/siyuan/siyuan.d.ts` 的 openTab 声明）：
   *   custom 只有 4 个字段 —— `id` / `icon` / `title` / `data`，
   *   其中 `id` 的注释写明「插件名称+页签类型：plugin.name + tab.type」。
   *   ⚠️ **不要多传 `type`** —— 类型声明里没有它，传了思源会按未知字段处理。
   *   去重靠 `id`：重复点击时 id 相同 → 聚焦已有页签，而不是开一堆重复页签。
   */
  openShelfTab(): void {
    try {
      // 2026-10-26 路线 A：移动端 openTab 无实现 → 全屏浮层承载书架（幂等：已开即聚焦）
      if (isMobile()) {
        this.openShelfOverlay();
        return;
      }
      void openTab({
        app: this.app,
        custom: {
          id: this.name + SHELF_TAB_TYPE,
          icon: "iconREReader",
          title: t("RE 阅读器"),
          data: {},
        },
      });
    } catch (e) {
      getLogger().warn("[RE 阅读器] 打开书架页签失败", { error: e });
    }
  }

  /**
   * 移动端书架浮层（2026-10-26 路线 A）。
   *
   * 承载方式：全屏浮层（core/mobile-overlay-host.ts）—— 不进思源 Dialog 的
   * `.b3-dialog__body` 高度链，也就没有 v0.2.0 那套「三层 flex + 实测 px 写死 +
   * ResizeObserver」的补丁债；且无标题栏 chrome，正文/书卡可铺满整屏。
   * 组件与桌面页签完全同源（同一 mountShelf → readerDock.render）。
   * 点书 → reader-tab.ts 的移动端分支在**同一浮层**上叠一层阅读层（思阅同款：
   * 一次一本，关书回书架）。
   */
  private openShelfOverlay(): void {
    const plugin = this;
    try {
      mobileOverlay.open("shelf", {
        key: "shelf",
        mount: (el) => {
          plugin.mountShelf(el);
          return {
            destroy: () => {
              try {
                plugin.readerDock?.disposeShelf();
              } catch (e) {
                getLogger().warn("[RE 阅读器] 销毁书架浮层组件失败", { error: e });
              }
            },
          };
        },
      });
    } catch (e) {
      getLogger().warn("[RE 阅读器] 打开书架浮层失败", { error: e });
    }
  }

  /** 打开指定书籍（供深链 / 命令面板 / 外部调用） */
  openBook(bookId: string, title?: string): void {
    try {
      // 2026-10-26 路线 A：移动端 openTab 是空实现 → 走浮层（与书架点书同一条路，
      // 否则深链/外部调用在手机上会静默无反应）
      if (isMobile()) {
        void this.readerDock?.tabController?.openBookTab(bookId, title);
        return;
      }
      void openTab({
        app: this.app,
        custom: {
          id: this.name + READER_TAB_TYPE,
          icon: "iconREReader",
          title: title || t("阅读"),
          data: { bookId, title },
        },
      });
    } catch (e) {
      getLogger().warn("[RE 阅读器] 打开书籍页签失败", { error: e });
    }
  }

  /**
   * 词典管理入口（决策 G 的导入接口）。
   * 设置面板「词典」分区由此拉起：列出已装词典 / 导入新包 / 启用停用 / 删除。
   */
  getDictManager(): DictManager {
    if (!this.dictManager) this.dictManager = new DictManager(this);
    return this.dictManager;
  }

  /** 词典是否就绪（划词查词入口据此决定是否提示用户导入词典） */
  get dictReady(): boolean {
    return this.dictManager?.isReady ?? false;
  }

  /* ================================================================
   * 翻译接口（2026-10-07 接通）
   *
   * 契约来自 `reader-tab.ts:150-190` 的调用侧：
   *   onTranslateBatch        → plugin.translateBatch(texts, from, to, bookId, ctx, meta, extra)
   *   onTranslateBatchDetailed→ plugin.translateBatchDetailed(...同参...)
   *   onCheckCache            → plugin.checkTranslationCacheHits(bookId, texts)
   *   isTranslationConfigured → plugin.isTranslationConfigured()
   *   getAiSettings           → plugin.getAiSettings()
   *   onSaveAiSettings        → plugin.updateAiSettings(partial)
   * 双语模块（bilingual-v2）拿到这些后才真正能翻。
   * ================================================================ */

  /** 翻译宿主（懒建：onload 失败时不拖垮整个插件） */
  private getTranslate(): TranslateHost | null {
    if (!this.translateHost) {
      try {
        this.translateHost = new TranslateHost(this);
      } catch (e) {
        getLogger().error("[RE 阅读器] 翻译宿主创建失败", { error: e });
        return null;
      }
    }
    return this.translateHost;
  }

  /** 批量翻译（双语注入主路径） */
  public async translateBatch(
    texts: string[],
    from: string,
    to: string,
    bookId: string,
    ctxBefore?: (string | null)[],
    meta?: { title?: string; author?: string; language?: string; toc?: string } | null,
    opts?: { model?: string; overwrite?: boolean; signal?: AbortSignal; mode?: "default" | "concise"; engine?: string },
  ): Promise<string[]> {
    const h = this.getTranslate();
    if (!h) return [];
    return h.translateBatch(texts, from, to, bookId, ctxBefore, meta, opts);
  }

  /** 批量翻译（回传每段来源，供成本与引擎统计） */
  public async translateBatchDetailed(
    texts: string[],
    from: string,
    to: string,
    bookId: string,
    ctxBefore?: (string | null)[],
    meta?: { title?: string; author?: string; language?: string; toc?: string } | null,
    opts?: { model?: string; overwrite?: boolean; signal?: AbortSignal; mode?: "default" | "concise"; engine?: string },
  ): Promise<{ texts: string[]; providers: (string | null)[]; fromCache: boolean[] }> {
    const h = this.getTranslate();
    if (!h) return { texts: [], providers: [], fromCache: [] };
    return h.translateBatchDetailed(texts, from, to, bookId, ctxBefore, meta, opts);
  }

  /** 整书预翻译弹窗用：查某批原文的缓存命中 */
  public async checkTranslationCacheHits(bookId: string, texts: string[]): Promise<boolean[]> {
    const h = this.getTranslate();
    if (!h) return texts.map(() => false);
    return h.checkCacheHits(bookId, texts);
  }

  /** 是否有可用翻译引擎（设置界面「未配置」提示依据） */
  public isTranslationConfigured(): boolean {
    return this.getTranslate()?.isConfigured() ?? false;
  }

  /** 读翻译设置（设置面板渲染引擎配置区用） */
  public getTranslateSettings(): any {
    return this.getTranslate()?.getSettings() ?? null;
  }

  /**
   * 各引擎状态（设置页高亮「可用 / 缺凭据 / 未启用」）。
   * 与 `getTranslateSettings` 拆成两个接口：前者是配置值（可编辑），
   * 后者是**派生判定**（配置 + 凭据 + 用量锁→ 能否真正参与翻译），
   * 混在一个返回值里会让设置页把「判定结果」误当配置写回去。
   */
  public getTranslateStatus(): any[] {
    return this.getTranslate()?.engineStatus() ?? [];
  }

  /** 翻译宿主实例（设置弹窗的二级页经它读写配置） */
  public getTranslateHost(): any {
    return this.getTranslate();
  }

  /* ================================================================
   * 兼容别名
   *
   * `reader-tab.ts:189-190` 沿用主插件的旧接口名（getAiSettings /
   * updateAiSettings），而新插件的设置是独立的「翻译设置」
   * （reader-translate.json，含 6 个引擎的凭据 + 用量计数）。
   *
   * 保留别名而不是改 reader-tab：那边是主插件迁移过来的代码，
   * 保持签名一致能减少切分遗留的认知负担。
   * ================================================================ */
  public getAiSettings(): any {
    return this.getTranslateSettings();
  }

  public async updateAiSettings(patch: any): Promise<void> {
    return this.updateTranslateSettings(patch);
  }

  /**
   * 词典弹窗 🔍/「侧边栏」按钮 → REword 侧边栏「查词典」面板（2026-10-12 接链）。
   * 阅读器自身 Dock 只有书架、无查词面板；简化小窗的完整释义由 REword 承载（同源分叉）。
   * 走思源前端插件注册表拿 REword 实例调其 openWordInSidebar(w, mode)；
   * 未安装/未启用/签名变更时 toast 兜底，不再静默失败。
   */
  public openWordInSidebar(w: string, mode?: "offline" | "online") {
    const reword: any = (window as any).siyuan?.plugins?.["siyuan-plugin-reword"];
    if (reword && typeof reword.openWordInSidebar === "function") {
      try {
        reword.openWordInSidebar(w, mode);
        return;
      } catch (e) {
        getLogger().warn("[RE 阅读器] 调用 REword 侧边栏查词失败", { error: e });
      }
    }
    showMessage(t("未能呼出 REword 侧边栏查词（主插件未启用或版本过旧）"), 3000, "error");
  }

  /**
   * 词典「加入词库/移出词库/是否已加」跨插件桥（2026-10-15 P0 断链接链）。
   * 阅读器无本地词库；真源在 RE word：`src/vocab/vocab-store.ts` 单例 +
   * `hiword-vocab.json` 持久化。同 openWordInSidebar 走思源前端插件注册表。
   *
   * 返**门面**（facade）而不是 store 实例本身：
   *  - `hasWord`：缺席时静默 false。它是**渲染期调用**（每张词典卡打 ☆/★），
   *    为它 toast 会每帧刷屏；☆ 就是"未加"态、语义可接受。
   *  - `addWord / removeWord`：缺席、同步抛错或 async reject 时可见兜底；配合
   *    `vocabBridgeWarned` 一次性闸门（AI 批量收词循环会连打多次，只提示第一次）。
   *    REword 侧这两个写方法内部 `await persist()` ⇒ 是 Promise，同步 try/catch
   *    抓不到 reject；而 ReaderView 的 ☆ 是**乐观翻转**（点击即改 ★，不 await），
   *    所以不挂 `.catch` 的话写失败会留下一个假 ★。
   */
  public getVocabStore(): {
    hasWord: (w: string) => boolean;
    addWord: (w: string) => void;
    removeWord: (w: string) => void;
  } {
    const resolve = (): any => {
      const reword: any = (window as any).siyuan?.plugins?.["siyuan-plugin-reword"];
      if (reword && typeof reword.getVocabStore === "function") {
        try { return reword.getVocabStore(); } catch (e) {
          getLogger().warn("[RE 阅读器] 调用 REword 词库失败", { error: e });
        }
      }
      return null;
    };
    const warnOnce = () => {
      if (this.vocabBridgeWarned) return;
      this.vocabBridgeWarned = true;
      showMessage(t("未能连接 REword 词库（主插件未启用或版本过旧）"), 3000, "error");
    };
    return {
      hasWord(w: string) {
        const s = resolve();
        return s && typeof s.hasWord === "function" ? !!s.hasWord(w) : false;
      },
      addWord(w: string) {
        const s = resolve();
        if (!s || typeof s.addWord !== "function") { warnOnce(); return; }
        // REword 侧 addWord/removeWord 是 async（内部 await persist()），
        // 同步 try/catch 抓不到 reject ⇒ 必须挂 .catch，否则写失败时 ☆ 已乐观变成 ★ 会骗人。
        try {
          const r = s.addWord(w);
          if (r && typeof r.catch === "function") {
            r.catch((e: any) => {
              getLogger().warn("[RE 阅读器] REword addWord 失败", { error: e });
              warnOnce();
            });
          }
        } catch (e) {
          getLogger().warn("[RE 阅读器] REword addWord 抛错", { error: e });
          warnOnce();
        }
      },
      removeWord(w: string) {
        const s = resolve();
        if (!s || typeof s.removeWord !== "function") { warnOnce(); return; }
        try {
          const r = s.removeWord(w);
          if (r && typeof r.catch === "function") {
            r.catch((e: any) => {
              getLogger().warn("[RE 阅读器] REword removeWord 失败", { error: e });
              warnOnce();
            });
          }
        } catch (e) {
          getLogger().warn("[RE 阅读器] REword removeWord 抛错", { error: e });
          warnOnce();
        }
      },
    };
  }

  /**
   * 划词工具栏「AI 精读」跨插件桥（2026-10-15 P0 断链接链）。
   * 阅读器只带 AI 传输层与设置项，**没有**「拼 prompt→开面板→自动发送」这条；
   * REword 的 `translateToAi` 内部已自带「未配置→提示用户去 AI 设置」的分支。
   * 与 openWordInSidebar 同：缺席/抛错一律可见 toast，不再静默 no-op。
   */
  public translateToAi(text: string): void {
    if (!text || !text.trim()) return;
    const reword: any = (window as any).siyuan?.plugins?.["siyuan-plugin-reword"];
    if (reword && typeof reword.translateToAi === "function") {
      try {
        reword.translateToAi(text);
        return;
      } catch (e) {
        getLogger().warn("[RE 阅读器] 调用 REword AI 精读失败", { error: e });
      }
    }
    showMessage(t("未能呼出 REword AI 精读（主插件未启用或版本过旧）"), 3000, "error");
  }

  /** 更新翻译设置（设置面板改动即时落盘） */
  public async updateTranslateSettings(patch: any): Promise<void> {
    const h = this.getTranslate();
    if (!h) return;
    await h.update(patch ?? {});
  }

  /**
   * 拉取服务端模型列表（设置页「获取模型」）。
   *
   * 参数由设置页**直接传当前输入框的值**，而不是这里读已存配置 ——
   * 用户常常刚填完地址就点按钮，此刻还没失焦落盘。
   */
  public async fetchTranslateModels(baseUrl?: string, apiKey?: string): Promise<{ ok: boolean; models: string[]; error?: string }> {
    const h = this.getTranslate();
    if (!h) return { ok: false, models: [], error: t("翻译宿主未就绪") };
    return h.fetchModels(baseUrl, apiKey);
  }

  /** 引擎连通性测试（设置面板「测试连接」按钮） */
  public async testTranslationEngine(engineId: string): Promise<{ ok: boolean; provider?: string; error?: string }> {
    const h = this.getTranslate();
    if (!h) return { ok: false, error: t("翻译宿主未就绪") };
    return h.testEngine(engineId);
  }

  /**
   * 深链接处理：解析 `siyuan://plugins/siyuan-plugin-reader?data=...` 中的 bookId + cfi，
   * 打开/聚焦该书阅读 Tab 并跳转到对应位置（2026-10-13 迁移：原主插件逻辑搬至此）。
   */
  private onOpenBookUrl = (e: { url?: string }): void => {
    const url = String(e?.url ?? "");
    if (!url) return;
    let bookId = "";
    let cfi = "";
    try {
      const qIdx = url.indexOf("?");
      const params = new URLSearchParams(qIdx >= 0 ? url.slice(qIdx + 1) : "");
      const raw = params.get("data");
      if (raw) {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        bookId = String(parsed?.bookId ?? "");
        cfi = String(parsed?.cfi ?? "");
      }
      if (!bookId) bookId = String(params.get("bookId") ?? "");
      if (!cfi) cfi = String(params.get("cfi") ?? "");
    } catch (err) {
      logSwallow(err, "index.ts · onOpenBookUrl", "warn");
      return;
    }
    if (!bookId) return;
    void this.jumpToReading(bookId, cfi);
  };

  /** 跳转到阅读批注位置 */
  private async jumpToReading(bookId: string, cfi: string): Promise<void> {
    try {
      await this.readerDock?.tabController?.focusAnnotation(bookId, cfi);
    } catch (e) {
      getLogger().warn("[RE 阅读器] 跳转到阅读批注失败", { data: { bookId, cfi }, error: e });
    }
  }

  onunload(): void {
    try {
      this.readerDock?.dispose();
    } catch (e) {
      getLogger().warn("[RE 阅读器] 卸载时清理阅读器失败", { error: e });
    }
    // 2026-10-26 路线 A：卸载时关闭移动端浮层（容器保留在 body 上无碍，
    // 但层里的 Svelte 组件必须销毁，否则监听器泄漏）
    try {
      mobileOverlay.closeAll();
    } catch (e) {
      getLogger().warn("[RE 阅读器] 卸载时关闭移动浮层失败", { error: e });
    }
    // 2026-10-13：批注落盘（防抖窗口内可能挂起的批注变更）
    void flushAnnotationStore();
    // 2026-10-14：摘除深链接监听（与 onload 里 eventBus.on 配对）
    try {
      this.eventBus.off("open-siyuan-url-plugin", this.onOpenBookUrl as any);
    } catch {
      /* 忽略：eventBus 不可用时本就没挂上 */
    }
    // 2026-10-07：摘除 window 上的词典管理器（见 onload 里挂上去的说明）
    try {
      (window as any).__rewordDictManager = null;
      (window as any).__rewordTranslateHost = null;
    } catch {
      /* 忽略：window 不可用时本就没挂上 */
    }
  }
}

/**
 * SiYuan 加载约定：**default export = 插件类**。
 *
 * 这一行是「插件列表里的『进入』按钮」的**前置条件**，不能省。
 * 少了它，思源拿不到插件类 → `onload` 根本不会执行 → `addTab` / `addTopBar`
 * 都没注册 → 页签不存在 → 按钮不出现（且插件看起来"已启用"却什么也不做）。
 *
 * 对照：`siyuan-plugin-re-todo`（独立插件，有此行）正常；
 * 主插件 `siyuan-plugin-reword`（走 dock feature、不需要独立入口）没有这一行也能用。
 */
export default ReaderPlugin;
