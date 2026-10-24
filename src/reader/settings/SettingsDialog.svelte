<!--
  阅读设置弹窗（Readest 式）
  ----------------------------------------------------------------
  形态：居中弹窗 + 顶部图标 Tab 条 + 内容卡片分组 + 底部操作条。
  全面对标 Readest 设置面板（2026-06 截图逐屏比对）。

  职责边界：
  - 本组件只管「外壳」：Tab 切换 / 焦点管理 / 键盘 / 移动端抽屉。
  - 行渲染交给 RowControl，Tab 组成交给 settings-schema。
  - **不直接改设置**：所有变更经 onSettingsChange 冒泡给宿主（ReaderView），
    由宿主决定写哪个 store（book/pdf 分片）与是否触发 applyStyles。
-->
<script lang="ts">
  import { createEventDispatcher, onMount, onDestroy } from "svelte";
  import { t } from "../../i18n/index.ts";
  import { getLogger } from "../../core/logger.ts";
  import { TABS, type TabDef, getByPath, setByPath, searchSettings, type SearchHit } from "./settings-schema.ts";
  import RowControl from "./RowControl.svelte";
  import DictManagerPage from "./DictManagerPage.svelte";
  import TranslateEnginePage from "./TranslateEnginePage.svelte";
  import GlossaryPage from "./GlossaryPage.svelte";
  import CachePage from "./CachePage.svelte";
  import { refreshFontOptions } from "../reader-settings.ts";
  import FontManagerPage from "./FontManagerPage.svelte";
  import TargetManagerPage from "./TargetManagerPage.svelte";
  import DocTreePickerPage from "./DocTreePickerPage.svelte";
  import TemplatePage from "./TemplatePage.svelte";

  /** 是否打开 */
  export let open = false;
  /** 打开时聚焦的 Tab key（null=沿用上次/默认第一个）。双语设置入口用它直达「双语翻译」Tab */
  export let initialTab: string | null = null;
  /** 当前设置对象（顶层 ReaderSettings） */
  export let settings: any = {};
  /** 外部数据（TTS 配置、readerMode） */
  export let extra: any = {};
  /** PDF 模式：隐藏仅对可重排文本生效的 Tab */
  export let readerMode: "book" | "pdf" = "book";
  /** DictManager 实例（二级页用；宿主注入，缺失时二级页降级为只读提示） */
  export let dictManager: any = null;
  /**
   * 翻译宿主（插件实例的翻译服务）。
   * 二级页要经它读设置 / 存设置 / 测连通性——沿用 dictManager 同样的
   * 「两棵组件树间经宿主对象通信」做法（DictManager 也是这样传的）。
   */
  export let translateHost: any = null;
  /**
   * 思源 API（2026-10-08 新增，供「选择导出文档」二级页列文档用）。
   *
   * 可缺省：缺省时该页降级为「粘贴文档 ID」输入，功能受限但不崩
   * （与 dictManager / fontStore 的容错约定一致）。
   */
  export let siyuanApi: any = null;
  /**
   * FontStore 实例（字体管理二级页用，2026-10-07）。
   * 与 dictManager / translateHost 同样的「两棵组件树经宿主对象通信」做法。
   */
  export let fontStore: any = null;
  /**
   * 书架 store（2026-10-10 列表化收敛）。
   * 总览页（TargetManagerPage）读书架列出所有书、显示绑定状态；
   * docTree 二级页回填每本书的绑定。可缺省（dock 用不到总览页）。
   */
  export let store: any = null;

  const dispatch = createEventDispatcher();

  /** 当前 Tab（记忆上次停留，跨开关闭保持） */
  let activeKey = "font";
  /**
   * 2026-10-07：二级页栈（Readest 风格「同一弹窗内二级页」）。
   *
   * null = 一级页（Tab + 设置行）；"dict" = 词典管理页。
   * 此前词典管理是**独立叠加弹窗**，两个全屏遮罩同屏 → 用户点任意空白
   * 会「关掉一层」、且视觉上只剩最上面那个，体验断裂。改为二级页后
   * 遮罩与外壳只有一份，点空白直接关整个设置弹窗，语义唯一。
   */
  /**
   * 当前二级页。
   * "dict"= 词典管理；"translate" = 翻译引擎配置（2026-10-07 新增）；
   * "fonts" = 字体导入 / 删除管理（2026-10-07 新增）。
   * "glossary"/"cache" = 双语翻译的术语表与缓存管理（2026-10-14 从独立弹窗迁入本 Tab）。
   * 各页形态一致（都是「能配能管」的配置页），故共用返回条与滚动手势。
   */
  let subPage: null | "dict" | "translate" | "glossary" | "cache" | "fonts" | "targetManager" | "docTree" | "templates" = null;
  /** docTree 子页的服务目标（default=全局默认 / book=某本书） */
  let pendingTreeMode: "default" | "book" = "default";
  let pendingTreeBookId = "";
  /**
   * docTree 子页组件引用（2026-10-10）。
   * 底部「确定选择」按钮要调它的 confirmPick()——点文档只打勾，
   * 写回由这个按钮统一触发（否则点了没反应、也无法反悔）。
   */
  let treePicker: any = null;
  /** docTree 当前是否有勾选（决定「确定选择」按钮是否可用） */
  let treePickerHasPick = false;
  /** 搜索关键词（空串 = 不搜索，显示当前 Tab 全部设置行） */
  let query = "";
  /** 弹窗 DOM（焦点管理用） */
  let panelEl: HTMLElement | null = null;
  /** 搜索框 DOM（跳转后回焦用） */
  let searchEl: HTMLInputElement | null = null;
  /** 打开前的焦点，关闭后归还 */
  let lastFocus: HTMLElement | null = null;
  /** 2026-10-14：document.fonts loadingdone 事件 handler 引用（供 onDestroy 清理） */
  let fontLoadingDoneHandler: (() => void) | null = null;

  /** PDF 下可见的 Tab */
  $: visibleTabs = TABS.filter((tab) => !(readerMode === "pdf" && tab.hideInPdf));

  /** 当前 Tab 定义 */
  $: activeTab = visibleTabs.find((x) => x.key === activeKey) ?? visibleTabs[0];

  /**
   * 当前 Tab 的分组列表。
   * 提到派生变量是必要的：Svelte 4 的 `{#each}` 不支持 `??` 与可选链
   * （写 `{#each activeTab?.groups ?? []}` 会报 ParseError: Expected as）。
   */
  $: groups = activeTab && activeTab.groups ? activeTab.groups : [];

  /**
   * 搜索结果（2026-10-07）。
   * 由 schema 的 searchSettings 统一产出（索引不另维护，避免加行漏搜）。
   * 非空时正文区切换为「结果列表」，点击某条跳到对应 Tab。
   *
   * ⚠️ 必须传visibleTabs 的 key：PDF 模式下「朗读」Tab 是隐藏的，
   *   若把隐藏 Tab 的项也列出来，点结果会跳到一个不存在的 Tab（面板纹丝不动，
   *   用户以为搜索坏了）。搜不到比跳到空处友好。
   */
  $: hits = query.trim()
    ? searchSettings(query, settings, visibleTabs.map((x) => x.key))
    : [];
  $: searching = query.trim().length > 0;

  /** 搜索结果按 Tab 分组（保持 Tab 原有顺序，避免结果顺序跳动） */
  $: hitGroups = (() => {
    const map = new Map<string, { tabKey: string; tabLabel: string; rows: SearchHit[] }>();
    for (const h of hits) {
      if (!map.has(h.tabKey)) {
        map.set(h.tabKey, { tabKey: h.tabKey, tabLabel: h.tabLabel, rows: [] });
      }
      map.get(h.tabKey)!.rows.push(h);
    }
    return [...map.values()];
  })();

  /**
   * 打开时聚焦面板 + 保证 Tab 合法。
   *
   * ⚠️ **必须只在 open 由 false→true 的那一刻执行**。
   * 若写成 `$: if (open) { activeKey = ... }`，Svelte 的依赖分析会把
   * `activeKey` 也算进去 → 点 Tab 改 activeKey → 本块重跑 → 再写 activeKey
   * → 无限循环 → Svelte 渲染器崩溃（表现为控制台一堆
   * `render:svelte-client-*.js` 的 undefined 报错 + 面板瞬间关闭）。
   * 故用 prevOpen 做边沿检测，只在「刚打开」时跑。
   */
  let prevOpen = false;
  $: if (open !== prevOpen) {
    prevOpen = open;
    if (open) {
      try {
        lastFocus = document.activeElement as HTMLElement;
      } catch {
        lastFocus = null;
      }
      if (!visibleTabs.some((x) => x.key === activeKey)) {
        activeKey = visibleTabs.length ? visibleTabs[0].key : "font";
      }
      // 每次打开都回到一级页并清空搜索：
      // 上次停在「词典管理」二级页时关掉，下次打开若还停在二级页，
      // 用户会以为设置弹窗被别的浮层顶开了。
      subPage = null;
      query = "";
      // 2026-10-14：宿主指定聚焦 Tab（如「双语设置」直达 translate）；非法 key 落到下面的合法性兜底。
      if (initialTab && visibleTabs.some((x) => x.key === initialTab)) {
        activeKey = initialTab;
      }
      // 等 DOM 出现后再聚焦（弹窗内容在 {#if open} 里，此时还没渲染）
      void Promise.resolve().then(() => {
        try {
          panelEl?.focus?.();
        } catch {
          /* 聚焦失败不影响使用 */
        }
      });
    }
  }

  onMount(() => {
    window.addEventListener("keydown", onKeydown, true);
    // 2026-10-14 方案 A：设置面板打开时枚举 document.fonts，合并预设数组更新下拉选项。
    // 三步确保覆盖：① 立即读（微任务）→ ② 等 document.fonts.ready → ③ 监听后续 loadingdone。
    // RowControl 已用 try/catch 保护 optionsFrom 读取，这里只需保护 document.fonts 调用。
    void Promise.resolve().then(() => {
      try { refreshFontOptions(); } catch { /* document.fonts 不可用时保留预设，不影响面板 */ }
    });
    // 等所有 @font-face 字体加载完成后重新枚举（比 setTimeout(500) 可靠）
    if (document.fonts?.ready?.then) {
      document.fonts.ready.then(() => {
        try { refreshFontOptions(); } catch { /* 忽略 */ }
      }).catch(() => { /* 忽略 */ });
    }
    // 监听后续字体加载完成（标准 FontFaceSet 事件名是 "loadingdone"，不是 "fontsloaded"）
    fontLoadingDoneHandler = () => {
      try { refreshFontOptions(); } catch { /* 忽略 */ }
    };
    if (document.fonts?.addEventListener) {
      document.fonts.addEventListener("loadingdone", fontLoadingDoneHandler);
    }
  });

  onDestroy(() => {
    window.removeEventListener("keydown", onKeydown, true);
    if (fontLoadingDoneHandler && document.fonts?.removeEventListener) {
      document.fonts.removeEventListener("loadingdone", fontLoadingDoneHandler);
      fontLoadingDoneHandler = null;
    }
  });

  function onKeydown(e: KeyboardEvent) {
    if (!open) return;
    // Esc：在二级页先返回一级页 → 有搜索词先清空 → 都没有才关闭弹窗。
    // 这是 Readest 的行为：Esc 是「往上一层退」，不是「直接全关」。
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (subPage) {
        subPage = null;
        return;
      }
      if (searching) {
        query = "";
        return;
      }
      close();
      return;
    }
    // ⌘/Ctrl + F 或直接按 /：聚焦搜索框（Readest 的键盘习惯）
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      e.stopPropagation();
      focusSearch();
    }
  }

  function close() {
    dispatch("close");
  }

  /** 聚焦搜索框（若当前在二级页，先退回一级页） */
  function focusSearch() {
    subPage = null;
    void Promise.resolve().then(() => {
      try {
        searchEl?.focus?.();
        searchEl?.select?.();
      } catch {
        /* 忽略 */
      }
    });
  }

  /**
   * 各Tab 的「更多」折叠组展开状态（2026-10-07）。
   *
   * 为什么要存状态而不是只靠 `<details open>` 属性：搜索结果里躺着一堆折叠项
   * （如「睡眠定时」在朗读 Tab 的「更多」里）。点搜索结果跳过去时若不展开，
   * 用户落在朗读 Tab首屏却**看不到自己找的那一行** —— 搜索等于白搜。
   * 故跳转时按Tab 记住展开态，并双向同步（用户手点开/收起也要写回）。
   */
  let collapsedOpen: Record<string, boolean> = {};

  /**
   * 跳到某个设置项所在 Tab（点搜索结果时用）。
   * 同时清空搜索，让用户直接落在那一行上，而不是停在结果列表里。
   *
   * 顺带展开该 Tab 的「更多」折叠组 —— 见 collapsedOpen 的注释。
   */
  function jumpTo(tabKey: string) {
    if (!visibleTabs.some((x) => x.key === tabKey)) return;
    activeKey = tabKey;
    subPage = null;
    query = "";
    collapsedOpen = { ...collapsedOpen, [tabKey]: true };
    void Promise.resolve().then(() => {
      try {
        panelEl?.focus?.();
      } catch {
        /* 忽略 */
      }
    });
  }

  /**
   * Tab 切换（2026-10-06 加诊断日志）。
   *
   * 此前用户反馈「点任何 Tab 面板都关掉」，但 jsdom 里挂载 + 逐个点击全部正常，
   * 说明崩溃只发生在思源真实环境里。逐次记录切换前后的关键状态，
   * 真机复现时直接看插件日志即可定位到是哪一步炸的，不必再靠猜。
   */
  function switchTab(key: string, label: string) {
    try {
      if (typeof getLogger === "function") {
        getLogger().debug?.(
          `[设置] 切 Tab「${label}」→ ${key}（面板已挂载=${!!panelEl?.isConnected}，可见 Tab=${visibleTabs.length}）`,
        );
      }
    } catch {
      /* 日志失败不影响交互 */
    }
    activeKey = key;
  }

  /** 遮罩点击（面板内部点击不冒泡到遮罩） */
  function onBackdrop(e: MouseEvent) {
    if (e.target === e.currentTarget) close();
  }

  /** 值变更：只向上冒泡，由宿主决定写入哪个 store */
  function onRowChange(path: string, value: any) {
    dispatch("change", { path, value });
  }

  function onAction(kind: string) {
    // 2026-10-07：「管理词典」改为**弹窗内二级页**（不再向外抛给宿主开新弹窗）。
    // 词典管理天然是设置的一部分（Readest 即如此），同窗内进二级页：
    // 用户能明确感知「还在设置里」，返回也不会丢上下文。
    if (kind === "dictManager") {
      subPage = "dict";
      return;
    }
    // 2026-10-07：翻译引擎配置也走二级页。理由是「翻译服务」那个下拉
    // 只管选引擎，用户没地方填密钥 —— 选了腾讯却什么都没发生，
    // 会被当成功能坏了。凭据页要给开关 + 输入框 + 连通性测试。
    if (kind === "translateEngine") {
      subPage = "translate";
      return;
    }
    // 2026-10-14 双语重设计：术语表 / 缓存管理从独立弹窗迁入本 Tab 的二级页。
    if (kind === "glossary") {
      subPage = "glossary";
      return;
    }
    if (kind === "cache") {
      subPage = "cache";
      return;
    }
    // 字体管理同构：字体导入是低频操作、列表长度不可控，塞在字体 Tab 会占满首屏。
    if (kind === "fontManager") {
      subPage = "fonts";
      return;
    }
    // 2026-10-10 列表化收敛：笔记发送目标总览页。
    // 默认目标 / 自动建档 / 书目列表全在这一个二级页里。
    if (kind === "targetManager") {
      subPage = "targetManager";
      return;
    }
    // 2026-10-10：模板定制二级页（划词发送模板 + 摘录导出模板的编辑入口）。
    if (kind === "templates") {
      subPage = "templates";
      return;
    }
    dispatch("action", kind);
  }

  /**
   * 给 action 行注入「当前值」（2026-10-10 列表化收敛）。
   *
   * 为什么要运行时注入而不是写在 schema 里：schema 是**纯静态声明**，
   * 拿不到宿主的书架 store。总览页要显示「共 N 本 · 已绑定 M」这种聚合统计，
   * 只有运行时从 `store` 才能算出来。
   */
  function decorateRow(row: any): any {
    if (row?.ctrl !== "action") return row;
    if (row.path === "__targetManager") {
      const list: any[] = store?.list ?? [];
      const total = list.length;
      const bound = total
        ? list.filter((b: any) => store.getNotebookTarget?.(b.id)?.docId).length
        : 0;
      return {
        ...row,
        displayValue: t("共 {n} 本 · 已绑定 {m}", { n: total, m: bound }),
        displayValueSet: true,
      };
    }
    return row;
  }

  /**
   * 统计分组内「当前条件下有 N 项生效」。
   * 用于「更多」折叠区的标题计数（2026-10-07）。
   * 逻辑与 RowControl 的 `visible` 判定保持一致：showIf 为空即显示。
   * 异常按「不显示」处理（与 RowControl 相同），避免统计本身抛错带崩弹窗。
   */
  function countActiveRows(group: any, settings: any, extra: any): number {
    let n = 0;
    for (const row of group.rows ?? []) {
      try {
        if (!row.showIf || row.showIf(settings ?? {}, extra ?? {})) n++;
      } catch {
        /* 与 RowControl 一致：条件判定失败按不显示计 */
      }
    }
    return n;
  }
</script>

{#if open}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="rwd-backdrop" on:click={onBackdrop}>
    <div
      class="rwd-panel"
      bind:this={panelEl}
      role="dialog"
      aria-modal="true"
      aria-label={t("阅读设置")}
    >
      <!-- ===== 顶部：Tab 条（二级页时替换为返回条） ===== -->
      {#if subPage}
        <!-- 二级页头部：返回 + 标题（Readest 的「‹ 返回」形态） -->
        <header class="rwd-subhead">
          <button type="button" class="rwd-back" on:click={() => (subPage = null)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M15 5l-7 7 7 7" />
            </svg>
            <span>{t("返回")}</span>
          </button>
          <h3 class="rwd-subhead-title">
            {subPage === "translate"
              ? t("翻译引擎配置")
              : subPage === "glossary"
                ? t("术语表")
                : subPage === "cache"
                  ? t("翻译缓存")
                  : subPage === "fonts"
                ? t("管理字体")
                : subPage === "targetManager"
                  ? t("笔记发送目标")
                  : subPage === "docTree"
                    ? (pendingTreeMode === "book"
                        ? t("选择本书的发送目标")
                        : t("选择默认目标"))
                    : subPage === "templates"
                      ? t("模板定制")
                      : t("词典管理")}
          </h3>
          <button type="button" class="rwd-close" aria-label={t("关闭")} on:click={close}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                 stroke-linecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>
      {:else}
        <nav class="rwd-tabs" role="tablist">
          {#each visibleTabs as tab (tab.key)}
            <button
              type="button"
              role="tab"
              class="rwd-tab"
              class:on={tab.key === activeTab?.key}
              aria-selected={tab.key === activeTab?.key}
              on:click={() => switchTab(tab.key, tab.label)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
                   stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d={tab.icon} />
              </svg>
              <span class="rwd-tab-label">{tab.label}</span>
            </button>
          {/each}
          <button type="button" class="rwd-close" aria-label={t("关闭")} on:click={close}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                 stroke-linecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </nav>

        <!-- ===== 搜索条（2026-10-07 第 3 批，对标 Readest 顶部搜索） ===== -->
        <div class="rwd-searchbar">
          <svg class="rwd-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <!-- svelte-ignore a11y-autofocus -->
          <input
            class="rwd-search"
            bind:this={searchEl}
            type="search"
            value={query}
            placeholder={t("搜索设置项…")}
            aria-label={t("搜索设置项")}
            on:input={(e) => (query = e.currentTarget.value)}
          />
          {#if searching}
            <span class="rwd-search-count">{t("{n} 项").replace("{n}", String(hits.length))}</span>
            <button type="button" class="rwd-search-clear" aria-label={t("清空")} on:click={() => (query = "")}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                   stroke-linecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          {/if}
        </div>
      {/if}

      <!-- ===== 内容：二级页 or 分组渲染卡片 ===== -->
      <!-- svelte-ignore a11y-no-static-element-interactions -->
      <div class="rwd-body" on:click|stopPropagation>
        {#if subPage === "dict"}
          <DictManagerPage {dictManager} on:changed={(e) => dispatch("dictChanged", e.detail)} />

        {:else if subPage === "translate"}
          <TranslateEnginePage host={translateHost} />

        {:else if subPage === "glossary"}
          <GlossaryPage host={translateHost} />

        {:else if subPage === "cache"}
          <CachePage host={translateHost} />

        {:else if subPage === "fonts"}
          <!--
            字体管理页。「选哪本」不自己写 settings，经 change 冒泡给宿主
            （customFontId 属 settings 分片，由 ReaderView 落盘）。
          -->
          <FontManagerPage
            {fontStore}
            {settings}
            on:change={(e) => onRowChange(e.detail?.path, e.detail?.value)}
            on:changed={(e) => dispatch("fontChanged", e.detail)}
          />

        {:else if subPage === "targetManager"}
          <!--
            笔记发送目标总览页（2026-10-10 列表化收敛）。
            默认目标行 + 自动建档行（笔记本下拉 + 子路径 + 开关）+ 统计 + 搜索 + 书目列表。
            「选择」按钮 → 打开 docTree 子页（由 on:openTree 接管切页）。
          -->
          <TargetManagerPage
            {store}
            {settings}
            api={siyuanApi}
            on:change={(e) => onRowChange(e.detail?.path, e.detail?.value)}
            on:openTree={(e) => {
              pendingTreeMode = e.detail?.mode === "book" ? "book" : "default";
              pendingTreeBookId = e.detail?.bookId ?? "";
              subPage = "docTree";
            }}
            on:clearBook={(e) => {
              subPage = null;
              dispatch("bookTargetPicked", { bookId: e.detail?.bookId, docId: null });
            }}
          />

        {:else if subPage === "templates"}
          <!--
            模板定制页（2026-10-10 新建）：划词发送（位置 + 预设 + 正文）与
            摘录导出（预设 + 正文）的编辑入口；全部经 change 冒泡 setByPath 落盘。
          -->
          <TemplatePage
            {settings}
            on:change={(e) => onRowChange(e.detail?.path, e.detail?.value)}
          />

        {:else if subPage === "docTree"}
          <!--
            文档树选择器（2026-10-10 列表化收敛，取代 DocumentPickerPage 的平铺列表）。
            mode=default 写全局 3 字段；mode=book 冒泡 bookTargetPicked 给宿主写 BookMeta。
          -->
          <DocTreePickerPage
            bind:this={treePicker}
            api={siyuanApi}
            mode={pendingTreeMode}
            bookId={pendingTreeBookId}
            activeId={pendingTreeMode === "book"
              ? (store?.getNotebookTarget?.(pendingTreeBookId)?.docId ?? "")
              : (settings?.exportDocId ?? "")}
            on:selchange={(e) => (treePickerHasPick = !!e.detail)}
            on:pick={(e) => {
              subPage = "targetManager";
              treePickerHasPick = false;
              if (pendingTreeMode === "book") {
                dispatch("bookTargetPicked", {
                  bookId: pendingTreeBookId,
                  docId: e.detail?.docId,
                  docTitle: e.detail?.docTitle,
                  notebookName: e.detail?.notebookName,
                });
              } else {
                dispatch("change", { path: "exportDocId", value: e.detail?.docId });
                dispatch("change", { path: "exportDocTitle", value: e.detail?.docTitle ?? "" });
                dispatch("change", { path: "exportNotebookName", value: e.detail?.notebookName ?? "" });
              }
            }}
            on:clear={() => {
              subPage = "targetManager";
              if (pendingTreeMode === "book") {
                dispatch("bookTargetPicked", { bookId: pendingTreeBookId, docId: null });
              } else {
                dispatch("change", { path: "exportDocId", value: "" });
                dispatch("change", { path: "exportDocTitle", value: "" });
                dispatch("change", { path: "exportNotebookName", value: "" });
              }
            }}
          />

        {:else if searching}
          <!-- 搜索结果视图：跨 Tab 列出命中项，点一条跳到对应 Tab -->
          {#if !hits.length}
            <p class="rwd-search-empty">{t("没有匹配「{q}」的设置项").replace("{q}", query.trim())}</p>
          {:else}
            {#each hitGroups as hg (hg.tabKey)}
              <section class="rwd-hits">
                <h4 class="rwd-group-title">
                  <button type="button" class="rwd-hits-tab" on:click={() => jumpTo(hg.tabKey)}>
                    {hg.tabLabel}
                    <span class="rwd-hits-count">{t("{n} 项").replace("{n}", String(hg.rows.length))}</span>
                  </button>
                </h4>
                <div class="rwd-card">
                  {#each hg.rows as hit (hit.row.path + "|" + hit.row.label)}
                    <div class="rwd-hit-row">
                      <button
                        type="button"
                        class="rwd-hit-label"
                        title={t("跳到该设置")}
                        on:click={() => jumpTo(hit.tabKey)}
                      >
                        <span class="rwd-hit-name">{hit.row.label}</span>
                        {#if hit.groupTitle}
                          <span class="rwd-hit-group">{hit.groupTitle}</span>
                        {/if}
                        {#if hit.row.showIf}
                          <!-- showIf 行在当前条件下可能不渲染，跳过去会「看不见」 →
                               明确标注「可能不生效」，而不是假装它一定在 -->
                          <span class="rwd-hit-warn">{t("当前条件下可能不显示")}</span>
                        {/if}
                      </button>
                      <div class="rwd-hit-ctrl">
                        <RowControl
                          {settings}
                          row={hit.row}
                          {extra}
                          forceVisible={true}
                          onChange={onRowChange}
                          onAction={onAction}
                        />
                      </div>
                    </div>
                  {/each}
                </div>
              </section>
            {/each}
          {/if}

        {:else}
        {#each groups as group, gi (gi)}
          {#if group.collapsed}
            <!--
              「更多」折叠区（2026-10-07，对标 Readest）。
              用原生 <details>：零 JS、无障碍属性免费、键盘可用。
              标题右侧显示「当前 N 项生效」——组内大量行带 showIf
              （如口音仅 youdao、讯飞密钥仅 iflytek），不显示计数的话
              用户点开看到空列表会以为功能丢了。
            -->
            {@const activeCount = countActiveRows(group, settings, extra)}
            <details
              class="rwd-group rwd-group-collapsed"
              open={collapsedOpen[activeTab.key] === true}
              on:toggle={(e) => {
                // 双向同步：程序展开（jumpTo）与用户手点都要落到同一份状态，
                // 否则下一次切 Tab 会拿到过期值，出现「刚展开就又收起」。
                const key = activeTab.key;
                const open = e.currentTarget.open;
                if ((collapsedOpen[key] === true) !== open) {
                  collapsedOpen = { ...collapsedOpen, [key]: open };
                }
              }}
            >
              <summary class="rwd-group-summary">
                <span class="rwd-group-chevron" aria-hidden="true">›</span>
                <span class="rwd-group-summary-title">{group.title}</span>
                <span class="rwd-group-count">
                  {activeCount > 0
                    ? t("{n} 项").replace("{n}", String(activeCount))
                    : t("无")}
                </span>
              </summary>
              <div class="rwd-card">
                {#each group.rows as row, ri (gi + "-c" + ri)}
                  <RowControl
                    {settings}
                    row={decorateRow(row)}
                    {extra}
                    onChange={onRowChange}
                    onAction={onAction}
                  />
                {/each}
              </div>
            </details>
          {:else}
            {#if group.title}
              <h4 class="rwd-group-title">{group.title}</h4>
            {/if}
            <div class="rwd-card">
              <!-- key 用「分组内序号」而非 path+label：
                   path 可能重复（如 marginTopPx / marginBottomPx 同一 transform），
                   用 path+label 会触发 Svelte 重复键异常并销毁组件树。 -->
              {#each group.rows as row, ri (gi + "-" + ri)}
                <RowControl
                  {settings}
                  row={decorateRow(row)}
                  {extra}
                  onChange={onRowChange}
                  onAction={onAction}
                />
              {/each}
            </div>
          {/if}
        {/each}
        {/if}
      </div>

      <!-- ===== 底部操作条 ===== -->
      <footer class="rwd-footer">
        {#if subPage}
          <!-- 二级页：左侧改为说明文字。这里刻意不放按钮——
               导入/删除都在词典页本体里，底部再塞「导入」会让人以为是批量导入全部。
               放「重置为默认」更糟：读者看到「重置」会以为要把词典全清了。 -->
          <span class="rwd-footer-note">
            {subPage === "translate"
              ? t("密钥仅保存在本机，不会上传到任何服务器")
              : subPage === "fonts"
                ? t("字体文件保存在插件目录下，切换后立即对所有书籍生效")
                : subPage === "targetManager"
                  ? t("每本书可单独设置发送文档；未设置的书可走默认目标或导出时自动建档")
                  : subPage === "docTree"
                    ? t("点文档名打勾选中，再点右侧「确定选择」生效；搜索会自动展开路径")
                    : subPage === "templates"
                      ? t("改动失焦后自动保存；导出前会校验模板，错误不写入")
                      : t("词典为全局资源，切换后立即对所有书籍生效")}
          </span>
        {:else}
          <button type="button" class="rwd-btn rwd-btn-ghost" on:click={() => dispatch("reset")}>
            {t("重置为默认")}
          </button>
        {/if}
        <!--
          文档树专属：点文档只打勾（不写回、不跳页），点「确定选择」才真正写回并跳回总览页。
          未打勾时禁用，避免空提交。「清除绑定」是 DocTreeBody 里的独立按钮。
        -->
        {#if subPage === "docTree"}
          <div class="rwd-footer-actions">
            <button
              type="button"
              class="rwd-btn rwd-btn-primary"
              disabled={!treePickerHasPick}
              on:click={() => { treePicker?.confirmPick?.(); }}
            >
              {t("确定选择")}
            </button>
            <button type="button" class="rwd-btn rwd-btn-ghost" on:click={close}>
              {t("完成")}
            </button>
          </div>
        {:else}
          <button type="button" class="rwd-btn rwd-btn-primary" on:click={close}>
            {t("完成")}
          </button>
        {/if}
      </footer>
    </div>
  </div>
{/if}
