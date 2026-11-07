<script lang="ts">
  /**
   * 阅读助手设置窗口（2026-11-06）
   * ------------------------------------------------------------------
   * 从「第三个 tab」升级为浮窗：
   *  - 头部齿轮打开，portal 到 body，右栏/页签/手机覆盖层都不被父容器裁剪；
   *  - 同时编辑插件级 AiSettings 与面板级 AiPanelPrefs，保存走一个事务；
   *  - 取消 / Esc / 关闭可完整丢弃，脏数据不落盘。
   *
   * 本组件只负责界面与草稿搬运；脏检查、校验、补丁组装在
   * ./ai-settings-dialog-logic.ts（纯逻辑，可单测）。
   */
  import { onMount, onDestroy, tick } from "svelte";
  import { t } from "../../i18n/index.ts";
  import { fetchModelList } from "../ai-client.ts";
  import { portal } from "../../utils/portal.ts";
  import {
    createDraft,
    isDirty,
    validateDraft,
    buildSettingsPatch,
    switchPlatform,
    savePrefsPatch,
    fontSizesOf,
    type AiSettingsDraft,
    type DraftValidationError,
  } from "./ai-settings-dialog-logic.ts";
  import {
    MIN_CONTEXT_CHARS,
    MAX_CONTEXT_CHARS,
    MAX_HISTORY_TURNS,
    type AiPanelPrefs,
  } from "../panel/ai-panel-logic.ts";
  import { KNOWLEDGE_MIN_CHARS, KNOWLEDGE_MAX_CHARS } from "../panel/ai-knowledge.ts";
  import {
    AUTO_RENAME_PROMPT_MAX,
    DEFAULT_AUTO_RENAME_PROMPT,
  } from "../auto-title.ts";

  /** 取当前插件设置（保存后重读，避免窗口内出现旧值） */
  export let getSettings: (() => any) | undefined = undefined;
  /** 面板偏好快照（打开窗口时传入） */
  export let prefs: AiPanelPrefs;
  /** 通用对话（无书）：隐藏阅读上下文组 */
  export let general = false;
  /** 当前书的知识区文档（按书存储，不在本窗口事务里） */
  export let knowledge: { docId: string; docTitle?: string; notebookName?: string } | null = null;
  /** 保存插件设置增量 */
  export let saveSettings: ((patch: any) => Promise<void> | void) | undefined = undefined;
  /** 保存面板偏好（由宿主持久化） */
  export let savePrefs: ((next: AiPanelPrefs) => void) | undefined = undefined;
  export let onClose: (() => void) | undefined = undefined;
  /** 打开文档选择器（会先关掉本窗口） */
  export let onPickKnowledge: (() => void) | undefined = undefined;
  export let onClearKnowledge: (() => void) | undefined = undefined;

  type GroupId = "model" | "chat" | "context" | "data" | "look";
  interface GroupDef {
    id: GroupId;
    label: string;
    hint: string;
    icon: string;
  }

  const GROUPS: GroupDef[] = [
    { id: "model", label: "模型与平台", hint: "地址、密钥与默认模型", icon: "✦" },
    { id: "chat", label: "对话", hint: "发送、字号与思考过程", icon: "✎" },
    { id: "context", label: "阅读上下文", hint: "正文预算与知识区", icon: "❏" },
    { id: "data", label: "会话与数据", hint: "命名、保留与本机数据", icon: "⌘" },
    { id: "look", label: "外观与关于", hint: "皮肤、快捷键与说明", icon: "◐" },
  ];

  const FIELD_GROUP: Record<string, GroupId> = {
    baseUrl: "model",
    apiKey: "model",
    model: "model",
    models: "model",
    temperature: "model",
    maxTokens: "model",
    sendShortcut: "chat",
    fontSize: "chat",
    inputFontSize: "chat",
    streamThrottleMs: "chat",
    contextChars: "context",
    knowledgeChars: "context",
    historyTurns: "context",
    contextScope: "context",
    sessionRetentionDays: "data",
    autoRenameSession: "data",
    autoRenamePlatformId: "data",
    autoRenameModel: "data",
    autoRenamePrompt: "data",
    aiSkin: "look",
  };

  let draft: AiSettingsDraft | null = null;
  let baseline: AiSettingsDraft | null = null;
  let activeGroup: GroupId = "model";
  let errors: DraftValidationError[] = [];
  let saving = false;
  let saved = false;
  let saveError = "";
  let confirmDiscard = false;
  let showKey = false;
  let modelInput = "";
  /** 模型列表默认折叠，只留「N 个已启用 + 管理」，避免几十个标签铺满 */
  let modelsOpen = false;
  let modelQuery = "";
  /** 拉取模型后的多选弹层：先选再入库，不再一股脑全合并 */
  let pickerOpen = false;
  let pickerList: string[] = [];
  let pickerQuery = "";
  let pickerChecked = new Set<string>();
  let conn: { state: "idle" | "loading" | "ok" | "err"; text: string } = { state: "idle", text: "" };
  let dialogEl: HTMLDivElement | undefined = undefined;
  let previousFocus: Element | null = null;
  let savedTimer: ReturnType<typeof setTimeout> | null = null;

  $: dirty = !!draft && !!baseline && isDirty(baseline, draft);
  $: visibleGroups = general ? GROUPS.filter((g) => g.id !== "context") : GROUPS;
  $: ready = !!draft && !!String(draft.settings.baseUrl || "").trim() && !!String(draft.settings.model || "").trim();
  $: model = draft?.settings.model || "";
  $: modelOverride = (draft?.settings.modelParams || {})[model] || {};
  $: platforms = draft?.settings.platforms || [];
  $: models = draft?.settings.models || [];
  $: modelMatches = models.filter((m) => {
    const q = modelQuery.trim().toLowerCase();
    return !q || m.toLowerCase().includes(q);
  });
  $: autoRenamePlatformId = draft?.settings.autoRenamePlatformId || "";
  $: autoRenamePlatform = platforms.find((p) => p.id === autoRenamePlatformId) || null;
  $: autoRenameModels = autoRenamePlatform?.models || [];
  $: currentPlatform = platforms.find((p) => p.id === draft?.settings.activePlatformId) || platforms[0] || null;
  $: autoRenamePromptText = String(draft?.settings.autoRenamePrompt || "");
  $: autoRenamePromptLen = autoRenamePromptText.length;

  function initialDraft(settings: any, p: AiPanelPrefs): AiSettingsDraft {
    const first = createDraft(settings, p);
    return createDraft(first.settings, first.prefs);
  }

  onMount(() => {
    const initial = createDraft(getSettings?.() ?? null, prefs);
    draft = initialDraft(initial.settings, initial.prefs);
    baseline = initialDraft(initial.settings, initial.prefs);
    previousFocus = document.activeElement;
    tick().then(() => {
      dialogEl?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    });
    return () => {
      if (savedTimer) clearTimeout(savedTimer);
      try {
        (previousFocus as HTMLElement | null)?.focus?.();
      } catch {
        /* 元素已卸载 */
      }
    };
  });

  onDestroy(() => {
    if (savedTimer) {
      clearTimeout(savedTimer);
      savedTimer = null;
    }
  });

  function setS(patch: Record<string, any>): void {
    if (!draft) return;
    draft = { ...draft, settings: { ...draft.settings, ...patch } };
    saved = false;
    if (errors.length) errors = [];
  }

  function setP(patch: Partial<AiPanelPrefs>): void {
    if (!draft) return;
    draft = { ...draft, prefs: { ...draft.prefs, ...patch } };
    saved = false;
    if (errors.length) errors = [];
  }

  function numFrom(e: Event): number {
    const raw = (e.currentTarget as HTMLInputElement).value;
    return raw.trim() === "" ? NaN : Number(raw);
  }

  function numAttr(v: any): number | string {
    const n = Number(v);
    return Number.isFinite(n) ? n : "";
  }

  function textFrom(e: Event): string {
    return (e.currentTarget as HTMLInputElement | HTMLTextAreaElement).value;
  }

  function checkedFrom(e: Event): boolean {
    return (e.currentTarget as HTMLInputElement).checked;
  }

  function errorFor(field: string): string {
    const hit = errors.find((e) => e.field === field);
    return hit ? t(hit.message) : "";
  }

  function focusField(field: string): void {
    dialogEl?.querySelector<HTMLElement>(`[data-field="${field}"]`)?.focus();
  }

  function setModelParam(patch: Record<string, any>): void {
    if (!draft || !model) return;
    const all = { ...(draft.settings.modelParams || {}) };
    all[model] = { ...(all[model] || {}), ...patch };
    setS({ modelParams: all });
  }

  function onAutoRenamePlatform(e: Event): void {
    const id = (e.currentTarget as HTMLSelectElement).value;
    if (!id) {
      setS({ autoRenamePlatformId: "", autoRenameModel: "" });
      return;
    }
    const plat = platforms.find((p) => p.id === id);
    setS({ autoRenamePlatformId: id, autoRenameModel: plat?.models?.[0] || "" });
  }

  function onAutoRenameModel(e: Event): void {
    setS({ autoRenameModel: (e.currentTarget as HTMLSelectElement).value });
  }

  function resetAutoRenamePrompt(): void {
    setS({ autoRenamePrompt: DEFAULT_AUTO_RENAME_PROMPT });
  }

  function addModel(name: string): void {
    if (!draft) return;
    const m = String(name || "").trim();
    if (!m) return;
    const next = models.includes(m) ? models.slice() : [...models, m];
    setS({ models: next, model: draft.settings.model || m });
    modelInput = "";
  }

  function removeModel(name: string): void {
    if (!draft) return;
    const next = models.filter((m) => m !== name);
    const selected = draft.settings.model === name ? next[0] || "" : draft.settings.model;
    setS({ models: next, model: selected });
  }

  /* ── 拉取模型：先多选再入库 ─────────────────────────────── */
  function openPicker(list: string[]): void {
    pickerList = list;
    pickerQuery = "";
    pickerChecked = new Set<string>();
    pickerOpen = true;
  }

  function closePicker(): void {
    pickerOpen = false;
  }

  function pickerVisible(): string[] {
    const q = pickerQuery.trim().toLowerCase();
    return q ? pickerList.filter((m) => m.toLowerCase().includes(q)) : pickerList;
  }

  function togglePick(m: string, on: boolean): void {
    if (on) pickerChecked.add(m);
    else pickerChecked.delete(m);
    pickerChecked = pickerChecked;
  }

  function setAllPicked(on: boolean): void {
    pickerVisible().forEach((m) => {
      if (on) pickerChecked.add(m);
      else pickerChecked.delete(m);
    });
    pickerChecked = pickerChecked;
  }

  function confirmPick(): void {
    if (!draft) return;
    const picked = pickerList.filter((m) => pickerChecked.has(m));
    const known = new Set(models);
    const next = [...models, ...picked.filter((m) => !known.has(m))];
    setS({ models: next, model: draft.settings.model || next[0] || "" });
    pickerOpen = false;
    conn = { state: "ok", text: t("已加入 {n} 个模型", { n: picked.length }) };
  }

  function pickPlatform(id: string): void {
    if (!draft || id === draft.settings.activePlatformId) return;
    draft = switchPlatform(draft, id);
    saved = false;
    if (errors.length) errors = [];
    conn = { state: "idle", text: "" };
  }

  function mask(text: string): string {
    const key = String(draft?.settings.apiKey || "");
    if (key.length < 8 || !text.includes(key)) return text;
    return text.split(key).join(`${key.slice(0, 4)}****${key.slice(-4)}`);
  }

  async function runFetch(merge: boolean): Promise<void> {
    if (!draft || conn.state === "loading") return;
    const baseUrl = String(draft.settings.baseUrl || "").trim();
    if (!baseUrl) {
      conn = { state: "err", text: t("请先填写接口地址") };
      return;
    }
    conn = { state: "loading", text: t("正在连接…") };
    const started = Date.now();
    try {
      const list = await fetchModelList(baseUrl, String(draft.settings.apiKey || ""));
      const spent = Math.max(1, Date.now() - started);
      if (merge) {
        const known = new Set(models);
        const available = list.filter((m) => !known.has(m));
        if (!available.length) {
          conn = { state: "ok", text: t("已拉取 {n} 个模型，全部已在列表中", { n: list.length }) };
          return;
        }
        openPicker(available);
        conn = { state: "ok", text: t("已拉取 {n} 个模型，请选择要加入的", { n: list.length }) };
        return;
      }
      conn = {
        state: "ok",
        text: t("连接正常 · {n} 个模型 · {ms}ms", { n: list.length, ms: spent }),
      };
    } catch (e: any) {
      conn = { state: "err", text: mask(String(e?.message || e)) };
    }
  }

  function groupOf(field: string): GroupId {
    return FIELD_GROUP[field] || "model";
  }

  async function save(closeAfter = false): Promise<void> {
    if (!draft || saving) return;
    errors = validateDraft(draft);
    if (errors.length) {
      activeGroup = groupOf(errors[0].field);
      await tick();
      focusField(errors[0].field);
      return;
    }
    saving = true;
    saved = false;
    saveError = "";
    try {
      const patch = buildSettingsPatch(draft);
      await saveSettings?.(patch);
      const nextPrefs = savePrefsPatch(draft.prefs);
      savePrefs?.(nextPrefs);
      // 回读插件设置：补丁不含翻译等外部字段，不能拿它当新的基线
      const normalized = createDraft(getSettings?.() ?? patch, nextPrefs);
      draft = createDraft(normalized.settings, normalized.prefs);
      baseline = createDraft(normalized.settings, normalized.prefs);
      confirmDiscard = false;
      saved = true;
      if (savedTimer) clearTimeout(savedTimer);
      savedTimer = setTimeout(() => {
        saved = false;
        savedTimer = null;
      }, 2200);
      if (closeAfter) onClose?.();
    } catch (e: any) {
      saveError = t("保存失败：{msg}", { msg: mask(String(e?.message || e)) });
    } finally {
      saving = false;
    }
  }

  function requestClose(): void {
    if (saving) return;
    if (dirty) {
      confirmDiscard = true;
      tick().then(() => dialogEl?.querySelector<HTMLElement>("[data-discard]")?.focus());
      return;
    }
    onClose?.();
  }

  function discardAndClose(): void {
    confirmDiscard = false;
    onClose?.();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (pickerOpen) {
        pickerOpen = false;
        return;
      }
      if (confirmDiscard) {
        confirmDiscard = false;
        return;
      }
      requestClose();
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void save(false);
      return;
    }
    if (e.key === "Tab" && dialogEl) {
      const list = Array.from(
        dialogEl.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null);
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    }
  }

  function onOverlayClick(e: MouseEvent): void {
    if (e.target === e.currentTarget) requestClose();
  }

  function onNavKey(e: KeyboardEvent): void {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const list = visibleGroups;
    const i = list.findIndex((g) => g.id === activeGroup);
    const step = e.key === "ArrowDown" ? 1 : -1;
    activeGroup = list[(i + step + list.length) % list.length].id;
    tick().then(() => dialogEl?.querySelector<HTMLElement>(`[data-nav="${activeGroup}"]`)?.focus());
  }

  function pickKnowledge(): void {
    onClose?.();
    onPickKnowledge?.();
  }

  function resetWidth(): void {
    setP({ width: 420 });
  }

  function sizesHint(): string {
    if (!draft) return "";
    const sizes = fontSizesOf(draft.settings);
    return t("消息 {m}px · 输入 {i}px", { m: sizes.message, i: sizes.input });
  }
</script>

<svelte:window on:keydown={onKeydown} />

{#if draft}
  <div class="ai-set-overlay" use:portal on:click={onOverlayClick}>
    <div
      class="ai-set-dialog"
      data-skin={draft.prefs.aiSkin}
      role="dialog"
      aria-modal="true"
      aria-labelledby="ai-set-title"
      tabindex="-1"
      bind:this={dialogEl}
      on:click|stopPropagation={() => {}}
    >
      <header class="ai-set-hd">
        <div class="ai-set-mark" aria-hidden="true">✦</div>
        <div class="ai-set-hd-main">
          <h2 id="ai-set-title">{t("阅读助手设置")}</h2>
          <p>{general ? t("通用对话 · 不读取正文") : t("只影响阅读助手，不改变书籍排版")}</p>
        </div>
        <button class="ai-set-x" data-autofocus aria-label={t("关闭")} on:click={requestClose}>×</button>
      </header>

      <div class="ai-set-body">
        <div class="ai-set-nav" role="tablist" aria-orientation="vertical" tabindex="-1" on:keydown={onNavKey}>
          {#each visibleGroups as g (g.id)}
            <button
              class="ai-set-nav-item"
              class:on={activeGroup === g.id}
              data-nav={g.id}
              role="tab"
              aria-selected={activeGroup === g.id}
              on:click={() => {
                activeGroup = g.id;
                confirmDiscard = false;
              }}
            >
              <span class="ai-set-nav-ico" aria-hidden="true">{g.icon}</span>
              <span class="ai-set-nav-main">
                <span class="ai-set-nav-label">{t(g.label)}</span>
                <span class="ai-set-nav-hint">{t(g.hint)}</span>
              </span>
              {#if g.id === "model" && !ready}<span class="ai-set-dot" aria-hidden="true"></span>{/if}
            </button>
          {/each}
          <div class="ai-set-nav-foot">{t("对话只保存在本机")}</div>
        </div>

        <div class="ai-set-content" role="tabpanel" aria-label={t(visibleGroups.find((g) => g.id === activeGroup)?.label || "设置")}>
          {#if activeGroup === "model"}
            <div class="ai-set-group-hd">
              <h3>{t("模型与平台")}</h3>
              <p>{t("与双语翻译共用同一组 AI 凭据；只修改当前平台。")}</p>
            </div>

            {#if !ready}
              <div class="ai-set-note" role="status">
                <span class="ai-set-note-mark" aria-hidden="true">!</span>
                <span>{t("填好接口地址与模型后即可开始对话；本地模型可以留空密钥。")}</span>
              </div>
            {/if}

            {#if platforms.length > 1}
              <div class="ai-set-block">
                <div class="ai-set-block-title">{t("平台")}</div>
                <div class="ai-set-chips">
                  {#each platforms as p (p.id)}
                    <button
                      class="ai-set-chip"
                      class:on={p.id === draft.settings.activePlatformId}
                      on:click={() => pickPlatform(p.id)}
                      title={p.baseUrl}
                    >
                      {p.name || p.id}
                    </button>
                  {/each}
                </div>
              </div>
            {/if}

            <div class="ai-set-field" class:err={!!errorFor("baseUrl")}>
              <span class="ai-set-label">{t("接口地址")}</span>
              <input
                class="ai-set-input"
                data-field="baseUrl"
                type="text"
                spellcheck="false"
                placeholder="https://api.siliconflow.cn/v1"
                value={draft.settings.baseUrl}
                on:input={(e) => setS({ baseUrl: textFrom(e) })}
              />
              {#if errorFor("baseUrl")}<span class="ai-set-err">{errorFor("baseUrl")}</span>{/if}
            </div>

            <div class="ai-set-field" class:err={!!errorFor("apiKey")}>
              <span class="ai-set-label">{t("API Key")}</span>
              <div class="ai-set-inline">
                <input
                  class="ai-set-input"
                  data-field="apiKey"
                  type={showKey ? "text" : "password"}
                  spellcheck="false"
                  autocomplete="off"
                  placeholder={t("本地模型可留空")}
                  value={draft.settings.apiKey}
                  on:input={(e) => setS({ apiKey: textFrom(e) })}
                />
                <button class="ai-set-mini" on:click={() => (showKey = !showKey)}>
                  {showKey ? t("隐藏") : t("显示")}
                </button>
              </div>
              <span class="ai-set-help">{t("密钥只写入本机设置，不会出现在日志或导出的会话里。")}</span>
            </div>

            <div class="ai-set-field" class:err={!!errorFor("model")}>
              <span class="ai-set-label">{t("默认模型")}</span>
              <div class="ai-set-inline">
                <input
                  class="ai-set-input"
                  data-field="model"
                  type="text"
                  spellcheck="false"
                  list="ai-set-model-list"
                  placeholder="deepseek-ai/DeepSeek-V3"
                  value={draft.settings.model}
                  on:input={(e) => setS({ model: textFrom(e) })}
                />
                <datalist id="ai-set-model-list">
                  {#each models as m (m)}<option value={m}></option>{/each}
                </datalist>
                <button class="ai-set-mini" disabled={!String(draft.settings.model || "").trim()} on:click={() => addModel(draft?.settings.model || "")}>
                  {t("加入列表")}
                </button>
              </div>
              {#if errorFor("model")}<span class="ai-set-err">{errorFor("model")}</span>{/if}
            </div>

            <div class="ai-set-field">
              <div class="ai-set-labelrow">
                <span class="ai-set-label">{t("模型列表")}</span>
                <span class="ai-set-meta">{models.length} {t("个已启用")}</span>
                <button class="ai-set-mini" aria-expanded={modelsOpen} on:click={() => (modelsOpen = !modelsOpen)}>
                  {modelsOpen ? t("收起") : t("管理")}
                </button>
              </div>
              {#if !modelsOpen}
                <span class="ai-set-help">
                  {model ? t("当前使用 {name}", { name: model }) : t("还没有模型；填写后点「加入列表」")}
                </span>
              {:else}
                <div class="ai-set-model-mgr">
                  <input
                    class="ai-set-input"
                    type="search"
                    placeholder={t("搜索已启用的模型")}
                    bind:value={modelQuery}
                  />
                  <div class="ai-set-chips ai-set-chips--scroll">
                    {#each modelMatches as m (m)}
                      <span class="ai-set-tag" class:on={m === draft.settings.model}>
                        <button class="ai-set-tag-main" on:click={() => setS({ model: m })} title={m}>{m}</button>
                        <button class="ai-set-tag-x" aria-label={t("从列表移除 {name}", { name: m })} on:click={() => removeModel(m)}>×</button>
                      </span>
                    {/each}
                    {#if !models.length}<span class="ai-set-empty">{t("还没有模型；填写后点「加入列表」")}</span>{/if}
                    {#if models.length && !modelMatches.length}<span class="ai-set-empty">{t("没有匹配的模型")}</span>{/if}
                  </div>
                  <div class="ai-set-inline ai-set-inline--end">
                    <button class="ai-set-mini" disabled={conn.state === "loading"} on:click={() => runFetch(true)}>
                      {conn.state === "loading" ? t("连接中…") : t("拉取模型")}
                    </button>
                    <button class="ai-set-mini" disabled={conn.state === "loading"} on:click={() => runFetch(false)}>
                      {t("测试连接")}
                    </button>
                  </div>
                  {#if conn.state === "ok"}
                    <span class="ai-set-help ok">{conn.text}</span>
                  {:else if conn.state === "err"}
                    <span class="ai-set-help err">{conn.text}</span>
                  {/if}
                </div>
              {/if}
            </div>

            <div class="ai-set-grid2">
              <div class="ai-set-field" class:err={!!errorFor("temperature")}>
                <span class="ai-set-label">{t("温度")}</span>
                <input
                  class="ai-set-input"
                  data-field="temperature"
                  type="number"
                  min="0"
                  max="2"
                  step="0.1"
                  value={numAttr(draft.settings.temperature)}
                  on:input={(e) => setS({ temperature: numFrom(e) })}
                />
                <span class="ai-set-help">{t("越低越稳定，越高越发散。")}</span>
                {#if errorFor("temperature")}<span class="ai-set-err">{errorFor("temperature")}</span>{/if}
              </div>
              <div class="ai-set-field" class:err={!!errorFor("maxTokens")}>
                <span class="ai-set-label">{t("最大输出")}</span>
                <input
                  class="ai-set-input"
                  data-field="maxTokens"
                  type="number"
                  min="16"
                  max="32768"
                  step="128"
                  value={numAttr(draft.settings.maxTokens)}
                  on:input={(e) => setS({ maxTokens: numFrom(e) })}
                />
                <span class="ai-set-help">{t("单位 tokens。")}</span>
                {#if errorFor("maxTokens")}<span class="ai-set-err">{errorFor("maxTokens")}</span>{/if}
              </div>
            </div>

            <details class="ai-set-adv">
              <summary>{t("高级：当前模型的流式与专属提示词")}</summary>
              <label class="ai-set-check">
                <input
                  type="checkbox"
                  checked={modelOverride.stream !== false}
                  on:change={(e) => setModelParam({ stream: checkedFrom(e) })}
                />
                <span>{t("允许流式输出（端点不支持 SSE 时可关闭）")}</span>
              </label>
              <div class="ai-set-field">
                <span class="ai-set-label">{t("模型专属提示词")}</span>
                <textarea
                  class="ai-set-textarea"
                  rows="4"
                  placeholder={t("留空则使用阅读助手的默认提示词")}
                  value={modelOverride.systemPrompt || ""}
                  on:input={(e) => setModelParam({ systemPrompt: textFrom(e) })}
                ></textarea>
                <span class="ai-set-help">{t("只对当前模型生效，优先级高于默认角色提示词。")}</span>
              </div>
            </details>
          {:else if activeGroup === "chat"}
            <div class="ai-set-group-hd">
              <h3>{t("对话")}</h3>
              <p>{t("控制发送方式与消息的阅读密度。")}</p>
            </div>

            <div class="ai-set-field">
              <span class="ai-set-label">{t("发送键")}</span>
              <div class="ai-set-seg">
                <button class:on={draft.settings.sendShortcut !== "mod+enter"} on:click={() => setS({ sendShortcut: "enter" })}>
                  {t("Enter 发送")}
                </button>
                <button class:on={draft.settings.sendShortcut === "mod+enter"} on:click={() => setS({ sendShortcut: "mod+enter" })}>
                  {t("⌘/Ctrl+Enter 发送")}
                </button>
              </div>
              <span class="ai-set-help">{t("Enter 发送时 Shift+Enter 换行；⌘/Ctrl+Enter 发送时 Enter 换行。")}</span>
            </div>

            <div class="ai-set-grid2">
              <div class="ai-set-field" class:err={!!errorFor("fontSize")}>
                <span class="ai-set-label">{t("消息字号")}</span>
                <input
                  class="ai-set-input"
                  data-field="fontSize"
                  type="number"
                  min="10"
                  max="24"
                  step="1"
                  value={numAttr(draft.settings.fontSize)}
                  on:input={(e) => setS({ fontSize: numFrom(e) })}
                />
                <span class="ai-set-help">{sizesHint()}</span>
                {#if errorFor("fontSize")}<span class="ai-set-err">{errorFor("fontSize")}</span>{/if}
              </div>
              <div class="ai-set-field" class:err={!!errorFor("inputFontSize")}>
                <span class="ai-set-label">{t("输入框字号")}</span>
                <input
                  class="ai-set-input"
                  data-field="inputFontSize"
                  type="number"
                  min="10"
                  max="24"
                  step="1"
                  value={numAttr(draft.settings.inputFontSize)}
                  on:input={(e) => setS({ inputFontSize: numFrom(e) })}
                />
                <span class="ai-set-help">{t("单位 px。")}</span>
                {#if errorFor("inputFontSize")}<span class="ai-set-err">{errorFor("inputFontSize")}</span>{/if}
              </div>
            </div>

            <label class="ai-set-check">
              <input type="checkbox" checked={draft.prefs.showReasoning} on:change={(e) => setP({ showReasoning: checkedFrom(e) })} />
              <span>{t("默认展开思考过程")}</span>
            </label>
            <label class="ai-set-check">
              <input type="checkbox" checked={draft.prefs.showUsage} on:change={(e) => setP({ showUsage: checkedFrom(e) })} />
              <span>{t("在回答下方显示 token 用量")}</span>
            </label>

            <details class="ai-set-adv">
              <summary>{t("高级：流式刷新频率")}</summary>
              <div class="ai-set-field" class:err={!!errorFor("streamThrottleMs")}>
                <span class="ai-set-label">{t("节流间隔")}</span>
                <input
                  class="ai-set-input"
                  data-field="streamThrottleMs"
                  type="number"
                  min="0"
                  max="500"
                  step="10"
                  value={numAttr(draft.settings.streamThrottleMs)}
                  on:input={(e) => setS({ streamThrottleMs: numFrom(e) })}
                />
                <span class="ai-set-help">{t("0 = 每帧刷新；默认 100ms，长回答更稳。")}</span>
                {#if errorFor("streamThrottleMs")}<span class="ai-set-err">{errorFor("streamThrottleMs")}</span>{/if}
              </div>
            </details>
          {:else if activeGroup === "context"}
            <div class="ai-set-group-hd">
              <h3>{t("阅读上下文")}</h3>
              <p>{t("这些设置只影响阅读助手，不改书籍排版。")}</p>
            </div>

            <div class="ai-set-field">
              <span class="ai-set-label">{t("默认范围")}</span>
              <div class="ai-set-seg">
                <button class:on={draft.prefs.contextScope === "chapter"} on:click={() => setP({ contextScope: "chapter" })}>{t("本章")}</button>
                <button class:on={draft.prefs.contextScope === "page"} on:click={() => setP({ contextScope: "page" })}>{t("本页")}</button>
              </div>
              <span class="ai-set-help">{t("发送时仍可从底栏临时切换，也可以从目录选一段章节。")}</span>
            </div>

            <div class="ai-set-grid2">
              <div class="ai-set-field" class:err={!!errorFor("contextChars")}>
                <span class="ai-set-label">{t("章节预算")}</span>
                <input
                  class="ai-set-input"
                  data-field="contextChars"
                  type="number"
                  min={MIN_CONTEXT_CHARS}
                  max={MAX_CONTEXT_CHARS}
                  step="1000"
                  value={numAttr(draft.prefs.contextChars)}
                  on:input={(e) => setP({ contextChars: numFrom(e) })}
                />
                <span class="ai-set-help">{t("每次附带的正文上限，超出会截断并标注。")}</span>
                {#if errorFor("contextChars")}<span class="ai-set-err">{errorFor("contextChars")}</span>{/if}
              </div>
              <div class="ai-set-field" class:err={!!errorFor("historyTurns")}>
                <span class="ai-set-label">{t("历史轮数")}</span>
                <input
                  class="ai-set-input"
                  data-field="historyTurns"
                  type="number"
                  min="0"
                  max={MAX_HISTORY_TURNS}
                  step="1"
                  value={numAttr(draft.prefs.historyTurns)}
                  on:input={(e) => setP({ historyTurns: numFrom(e) })}
                />
                <span class="ai-set-help">{t("0 = 每轮只带本轮问题。")}</span>
                {#if errorFor("historyTurns")}<span class="ai-set-err">{errorFor("historyTurns")}</span>{/if}
              </div>
            </div>

            <div class="ai-set-field" class:err={!!errorFor("knowledgeChars")}>
              <span class="ai-set-label">{t("知识区预算")}</span>
              <input
                class="ai-set-input"
                data-field="knowledgeChars"
                type="number"
                min={KNOWLEDGE_MIN_CHARS}
                max={KNOWLEDGE_MAX_CHARS}
                step="500"
                value={numAttr(draft.prefs.knowledgeChars)}
                on:input={(e) => setP({ knowledgeChars: numFrom(e) })}
              />
              <span class="ai-set-help">{t("知识区按书单独保存；超出预算会截断。")}</span>
              {#if errorFor("knowledgeChars")}<span class="ai-set-err">{errorFor("knowledgeChars")}</span>{/if}
            </div>

            <div class="ai-set-source">
              <div class="ai-set-source-main">
                <span class="ai-set-source-label">{t("知识区")}</span>
                {#if knowledge}
                  <span class="ai-set-source-title" title={knowledge.docId}>《{knowledge.docTitle || t("未命名笔记")}》</span>
                  {#if knowledge.notebookName}<span class="ai-set-source-sub">{knowledge.notebookName}</span>{/if}
                {:else}
                  <span class="ai-set-source-title muted">{t("未选择知识区")}</span>
                {/if}
              </div>
              <div class="ai-set-inline">
                <button class="ai-set-mini" on:click={pickKnowledge}>{knowledge ? t("更换") : t("选择文档")}</button>
                {#if knowledge}<button class="ai-set-mini" on:click={() => onClearKnowledge?.()}>{t("清除")}</button>{/if}
              </div>
              <span class="ai-set-help">{t("选择文档会打开文档树；知识区绑定不随本窗口保存，立即生效。")}</span>
            </div>
          {:else if activeGroup === "data"}
            <div class="ai-set-group-hd">
              <h3>{t("会话与数据")}</h3>
              <p>{t("对话只保存在本机，按书籍分档。")}</p>
            </div>

            <div class="ai-set-field" class:err={!!errorFor("sessionRetentionDays")}>
              <span class="ai-set-label">{t("会话保留天数")}</span>
              <input
                class="ai-set-input"
                data-field="sessionRetentionDays"
                type="number"
                min="0"
                max="365"
                step="1"
                value={numAttr(draft.settings.sessionRetentionDays)}
                on:input={(e) => setS({ sessionRetentionDays: numFrom(e) })}
              />
              <span class="ai-set-help">{t("0 = 永久保留；目前上限为 365 天。")}</span>
              {#if errorFor("sessionRetentionDays")}<span class="ai-set-err">{errorFor("sessionRetentionDays")}</span>{/if}
            </div>

            <label class="ai-set-check">
              <input
                type="checkbox"
                data-field="autoRenameSession"
                checked={draft.settings.autoRenameSession === true}
                on:change={(e) => setS({ autoRenameSession: checkedFrom(e) })}
              />
              <span>{t("会话自动重命名")}</span>
            </label>
            <span class="ai-set-help ai-set-help--check">{t("首条消息后由 AI 生成标题；失败时保留本地标题。")}</span>

            {#if draft.settings.autoRenameSession}
              <div class="ai-set-grid2">
                <div class="ai-set-field">
                  <span class="ai-set-label">{t("命名平台")}</span>
                  <select
                    class="ai-set-input ai-set-select"
                    data-field="autoRenamePlatformId"
                    value={draft.settings.autoRenamePlatformId || ""}
                    on:change={onAutoRenamePlatform}
                  >
                    <option value="">{t("跟随当前对话")}</option>
                    {#each platforms as p (p.id)}
                      <option value={p.id}>{p.name}</option>
                    {/each}
                  </select>
                </div>
                <div class="ai-set-field">
                  <span class="ai-set-label">{t("命名模型")}</span>
                  <select
                    class="ai-set-input ai-set-select"
                    data-field="autoRenameModel"
                    value={draft.settings.autoRenameModel || ""}
                    disabled={!autoRenamePlatform || !autoRenameModels.length}
                    on:change={onAutoRenameModel}
                  >
                    {#if !autoRenamePlatform}
                      <option value="">{t("跟随当前对话")}</option>
                    {:else if !autoRenameModels.length}
                      <option value="">{t("该平台暂无模型")}</option>
                    {:else}
                      {#each autoRenameModels as m (m)}
                        <option value={m}>{m}</option>
                      {/each}
                    {/if}
                  </select>
                </div>
              </div>
              <span class="ai-set-help ai-set-help--check">
                {autoRenamePlatformId
                  ? t("命名只使用所选平台；模型不可用时回落到该平台第一个模型。")
                  : t("默认跟随当前对话的平台与模型：{name}", { name: currentPlatform?.name || t("未命名平台") })}
              </span>

              <details class="ai-set-adv">
                <summary>{t("高级：命名提示词")}</summary>
                <div class="ai-set-field" class:err={!!errorFor("autoRenamePrompt")}>
                  <div class="ai-set-inline">
                    <span class="ai-set-label">{t("命名提示词")}</span>
                    <span class="ai-set-help ai-set-push">{autoRenamePromptLen}/{AUTO_RENAME_PROMPT_MAX}</span>
                  </div>
                  <textarea
                    class="ai-set-textarea"
                    data-field="autoRenamePrompt"
                    rows="4"
                    maxlength={AUTO_RENAME_PROMPT_MAX}
                    value={autoRenamePromptText}
                    on:input={(e) => setS({ autoRenamePrompt: textFrom(e) })}
                  ></textarea>
                  <div class="ai-set-inline">
                    <button class="ai-set-mini" on:click={resetAutoRenamePrompt}>{t("恢复默认")}</button>
                    <span class="ai-set-help">{t("留空恢复默认；message 会被替换为用户第一句话。")}</span>
                  </div>
                  {#if errorFor("autoRenamePrompt")}<span class="ai-set-err">{errorFor("autoRenamePrompt")}</span>{/if}
                </div>
              </details>
            {/if}

            <div class="ai-set-readonly">
              <div>
                <div class="ai-set-readonly-title">{t("会话管理")}</div>
                <div class="ai-set-readonly-text">{t("历史会话在对话头部；支持切换、重命名、置顶与导出。")}</div>
              </div>
            </div>

            <div class="ai-set-readonly">
              <div>
                <div class="ai-set-readonly-title">{t("本机数据")}</div>
                <div class="ai-set-readonly-text">{t("每本书最多保留 20 条非置顶会话；卸载插件不会自动清除浏览器存储。")}</div>
              </div>
            </div>
          {:else if activeGroup === "look"}
            <div class="ai-set-group-hd">
              <h3>{t("外观与关于")}</h3>
              <p>{t("皮肤只影响阅读助手面板与设置窗口。")}</p>
            </div>

            <div class="ai-set-field">
              <span class="ai-set-label">{t("面板皮肤")}</span>
              <div class="ai-set-seg">
                <button class:on={draft.prefs.aiSkin === "auto"} on:click={() => setP({ aiSkin: "auto" })}>{t("自动")}</button>
                <button class:on={draft.prefs.aiSkin === "paper"} on:click={() => setP({ aiSkin: "paper" })}>{t("纸感")}</button>
              </div>
              <span class="ai-set-help">{t("自动跟随思源明暗；纸感使用暖黄强调与细线分隔。")}</span>
            </div>

            <div class="ai-set-field">
              <span class="ai-set-label">{t("面板宽度")}</span>
              <div class="ai-set-inline">
                <span class="ai-set-value">{draft.prefs.width}px</span>
                <button class="ai-set-mini" on:click={resetWidth}>{t("恢复默认")}</button>
              </div>
              <span class="ai-set-help">{t("默认 420px；右栏里也可以直接拖动左边缘。")}</span>
            </div>

            <div class="ai-set-block">
              <div class="ai-set-block-title">{t("快捷键")}</div>
              <div class="ai-set-keys">
                <div><span>{t("发送")}</span><kbd>{draft.settings.sendShortcut === "mod+enter" ? "⌘/Ctrl + Enter" : "Enter"}</kbd></div>
                <div><span>{t("换行")}</span><kbd>{draft.settings.sendShortcut === "mod+enter" ? "Enter" : "Shift + Enter"}</kbd></div>
                <div><span>{t("保存设置")}</span><kbd>⌘/Ctrl + S</kbd></div>
                <div><span>{t("关闭窗口")}</span><kbd>Esc</kbd></div>
              </div>
            </div>

            <div class="ai-set-readonly">
              <div>
                <div class="ai-set-readonly-title">RE Reader · {t("阅读助手")}</div>
                <div class="ai-set-readonly-text">{t("设置与对话都留在本机；阅读正文的纸感主题将在后续版本提供。")}</div>
              </div>
            </div>
          {/if}
        </div>
      </div>
      <footer class="ai-set-ft">
        <div class="ai-set-status" role="status">
          {#if confirmDiscard}
            <span class="warn">{t("有未保存的修改")}</span>
          {:else if saveError}
            <span class="err">{saveError}</span>
          {:else if saving}
            <span>{t("保存中…")}</span>
          {:else if saved}
            <span class="ok">{t("已保存")}</span>
          {:else if dirty}
            <span class="warn">{t("未保存")}</span>
          {:else}
            <span>{t("改动会同步到阅读助手与双语翻译的 AI 配置。")}</span>
          {/if}
        </div>
        <div class="ai-set-actions">
          {#if confirmDiscard}
            <button class="ai-set-btn" data-discard on:click={discardAndClose}>{t("放弃修改")}</button>
            <button class="ai-set-btn primary" disabled={saving} on:click={() => void save(true)}>{t("保存并关闭")}</button>
          {:else}
            <button class="ai-set-btn" disabled={saving} on:click={requestClose}>{t("取消")}</button>
            <button class="ai-set-btn primary" disabled={saving || !dirty} on:click={() => void save(false)}>
              {saving ? t("保存中…") : t("保存")}
            </button>
          {/if}
        </div>
      </footer>

      {#if pickerOpen}
        <div class="ai-set-pick" role="dialog" aria-modal="true" aria-label={t("选择要加入的模型")}>
          <div class="ai-set-pick-hd">
            <strong>{t("选择要加入的模型")}</strong>
            <span class="ai-set-pick-count">{pickerList.length} · {t("已选 {n}", { n: pickerChecked.size })}</span>
            <button class="ai-set-pick-x" aria-label={t("关闭")} on:click={closePicker}>×</button>
          </div>
          <input
            class="ai-set-input"
            type="search"
            placeholder={t("筛选模型…")}
            bind:value={pickerQuery}
          />
          <div class="ai-set-pick-list">
            {#each pickerVisible() as m (m)}
              <label class="ai-set-pick-item" class:on={pickerChecked.has(m)}>
                <input type="checkbox" checked={pickerChecked.has(m)} on:change={(e) => togglePick(m, checkedFrom(e))} />
                <span title={m}>{m}</span>
              </label>
            {/each}
            {#if !pickerVisible().length}<span class="ai-set-empty">{t("没有匹配的模型")}</span>{/if}
          </div>
          <div class="ai-set-pick-foot">
            <button class="ai-set-mini" on:click={() => setAllPicked(true)}>{t("全选")}</button>
            <button class="ai-set-mini" on:click={() => setAllPicked(false)}>{t("清空")}</button>
            <span class="ai-set-pick-gap"></span>
            <button class="ai-set-mini" on:click={closePicker}>{t("取消")}</button>
            <button
              class="ai-set-btn primary"
              disabled={!pickerChecked.size}
              on:click={confirmPick}
            >{t("加入选中")} ({pickerChecked.size})</button>
          </div>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* 窗口在 portal 后脱离 .ai-panel，必须自建令牌层，不能继承 --re-ai-* */
  .ai-set-overlay {
    --set-paper: var(--b3-theme-background, #ffffff);
    --set-canvas: var(--b3-theme-surface, #f7f6f2);
    --set-ink: var(--b3-theme-on-background, #1a1a1a);
    --set-muted: var(--b3-theme-on-surface, #6b6b6b);
    --set-faint: var(--b3-theme-on-surface-light, #9a9a9a);
    --set-line: var(--b3-border-color, #e8e8e8);
    --set-accent: var(--b3-theme-primary-lightest, #ffe28a);
    --set-accent-strong: var(--b3-theme-primary, #f2c94c);
    --set-danger: #c0392b;
    position: fixed;
    inset: 0;
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: rgba(20, 24, 32, 0.32);
    box-sizing: border-box;
  }

  .ai-set-dialog[data-skin="paper"] {
    --set-paper: #ffffff;
    --set-canvas: #f7f6f2;
    --set-ink: #1a1a1a;
    --set-muted: #6b6b6b;
    --set-faint: #9a9a9a;
    --set-line: #e8e8e8;
    --set-accent: #ffe28a;
    --set-accent-strong: #f2c94c;
  }

  :global(html[data-theme-mode="dark"]) .ai-set-dialog[data-skin="paper"] {
    --set-paper: #16181c;
    --set-canvas: #0f1115;
    --set-ink: #ececec;
    --set-muted: #a7adb7;
    --set-faint: #7c838d;
    --set-line: #2a2e35;
    --set-accent: #8a6d1f;
    --set-accent-strong: #d9b23c;
  }

  .ai-set-dialog {
    width: min(780px, 92vw);
    height: min(650px, 88vh);
    position: relative;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
    box-sizing: border-box;
    border: 1px solid var(--set-line);
    border-radius: 18px;
    background: var(--set-paper);
    color: var(--set-ink);
    box-shadow: 0 1px 0 rgba(26, 26, 26, 0.04), 0 24px 60px rgba(20, 26, 36, 0.18);
    outline: none;
  }

  .ai-set-hd {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: 0 0 auto;
    padding: 16px 18px 14px 20px;
    border-bottom: 1px solid var(--set-line);
  }

  .ai-set-mark {
    width: 34px;
    height: 34px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 12px;
    background: var(--set-accent);
    color: #1a1a1a;
    font-size: 17px;
    flex: 0 0 auto;
  }

  .ai-set-hd-main {
    flex: 1;
    min-width: 0;
  }

  .ai-set-hd-main h2 {
    margin: 0;
    font-size: 15px;
    line-height: 1.3;
    font-weight: 650;
    letter-spacing: 0.01em;
  }

  .ai-set-hd-main p {
    margin: 3px 0 0;
    font-size: 11.5px;
    line-height: 1.35;
    color: var(--set-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ai-set-x {
    width: 30px;
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid transparent;
    border-radius: 10px;
    background: transparent;
    color: var(--set-muted);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
  }

  .ai-set-x:hover {
    background: var(--set-canvas);
    border-color: var(--set-line);
    color: var(--set-ink);
  }

  .ai-set-body {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 176px minmax(0, 1fr);
  }

  .ai-set-nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 12px 10px;
    border-right: 1px solid var(--set-line);
    background: var(--set-canvas);
    min-height: 0;
    overflow: auto;
    box-sizing: border-box;
  }

  .ai-set-nav-item {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: 9px;
    width: 100%;
    padding: 9px 9px 9px 10px;
    border: 1px solid transparent;
    border-radius: 10px;
    background: transparent;
    color: var(--set-ink);
    text-align: left;
    cursor: pointer;
    box-sizing: border-box;
  }

  .ai-set-nav-item:hover {
    background: color-mix(in srgb, var(--set-paper) 62%, transparent);
  }

  .ai-set-nav-item.on {
    background: var(--set-paper);
    border-color: var(--set-line);
    box-shadow: inset 3px 0 0 var(--set-accent-strong);
  }

  .ai-set-nav-ico {
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 7px;
    background: var(--set-paper);
    border: 1px solid var(--set-line);
    color: var(--set-muted);
    font-size: 11px;
    flex: 0 0 auto;
  }

  .ai-set-nav-item.on .ai-set-nav-ico {
    background: var(--set-accent);
    border-color: var(--set-accent);
    color: #1a1a1a;
  }

  .ai-set-nav-main {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .ai-set-nav-label {
    font-size: 12.5px;
    font-weight: 600;
    line-height: 1.25;
    white-space: nowrap;
  }

  .ai-set-nav-hint {
    font-size: 10.5px;
    line-height: 1.3;
    color: var(--set-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ai-set-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--set-accent-strong);
    position: absolute;
    right: 9px;
    top: 9px;
  }

  .ai-set-nav-foot {
    margin-top: auto;
    padding: 10px 8px 2px;
    font-size: 10px;
    color: var(--set-faint);
    line-height: 1.4;
  }

  .ai-set-content {
    min-width: 0;
    min-height: 0;
    overflow: auto;
    padding: 20px 24px 24px;
    box-sizing: border-box;
  }

  .ai-set-content::-webkit-scrollbar,
  .ai-set-nav::-webkit-scrollbar {
    width: 8px;
    height: 8px;
  }

  .ai-set-content::-webkit-scrollbar-thumb,
  .ai-set-nav::-webkit-scrollbar-thumb {
    background: var(--set-line);
    border-radius: 99px;
  }

  .ai-set-group-hd {
    margin: 0 0 16px;
  }

  .ai-set-group-hd h3 {
    margin: 0;
    font-size: 16px;
    font-weight: 650;
    line-height: 1.3;
  }

  .ai-set-group-hd p {
    margin: 4px 0 0;
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--set-muted);
  }

  .ai-set-note {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin: 0 0 14px;
    padding: 9px 11px;
    border: 1px solid color-mix(in srgb, var(--set-accent-strong) 42%, var(--set-line));
    border-radius: 10px;
    background: color-mix(in srgb, var(--set-accent) 34%, var(--set-paper));
    font-size: 11.5px;
    line-height: 1.5;
  }

  .ai-set-note-mark {
    width: 16px;
    height: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    border-radius: 50%;
    background: #1a1a1a;
    color: #fff;
    font-size: 10px;
    font-weight: 700;
    margin-top: 1px;
  }

  .ai-set-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0 0 15px;
    min-width: 0;
  }

  .ai-set-label {
    font-size: 12px;
    font-weight: 600;
    line-height: 1.35;
    color: var(--set-ink);
  }

  .ai-set-input,
  .ai-set-textarea {
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    padding: 8px 10px;
    border: 1px solid var(--set-line);
    border-radius: 10px;
    background: var(--set-paper);
    color: var(--set-ink);
    font-family: var(--b3-font-family, inherit);
    font-size: 12.5px;
    line-height: 1.4;
    outline: none;
  }

  .ai-set-input {
    height: 34px;
  }

  .ai-set-select {
    cursor: pointer;
    appearance: auto;
    padding-right: 6px;
  }

  .ai-set-input:disabled {
    opacity: 0.55;
    cursor: default;
    background: var(--set-canvas);
  }

  .ai-set-textarea {
    resize: vertical;
    min-height: 88px;
  }

  .ai-set-input:hover,
  .ai-set-textarea:hover {
    border-color: color-mix(in srgb, var(--set-ink) 22%, var(--set-line));
  }

  .ai-set-input:focus,
  .ai-set-textarea:focus {
    border-color: var(--set-ink);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--set-accent) 70%, transparent);
  }

  .ai-set-field.err .ai-set-input {
    border-color: var(--set-danger);
  }

  .ai-set-inline {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .ai-set-inline--end {
    justify-content: flex-end;
    margin-top: 8px;
  }

  .ai-set-mini {
    flex: 0 0 auto;
    height: 30px;
    padding: 0 10px;
    border: 1px solid var(--set-line);
    border-radius: 8px;
    background: var(--set-paper);
    color: var(--set-ink);
    font-size: 11.5px;
    line-height: 1;
    cursor: pointer;
    white-space: nowrap;
  }

  .ai-set-mini:hover:not(:disabled) {
    border-color: color-mix(in srgb, var(--set-ink) 28%, var(--set-line));
    background: var(--set-canvas);
  }

  .ai-set-mini:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .ai-set-help {
    font-size: 10.5px;
    line-height: 1.45;
    color: var(--set-faint);
  }

  .ai-set-help--check {
    display: block;
    margin: -6px 0 14px 22px;
  }

  .ai-set-push {
    margin-left: auto;
  }

  .ai-set-help.ok {
    color: #2f7d4f;
  }

  .ai-set-help.err,
  .ai-set-err {
    color: var(--set-danger);
  }

  .ai-set-err {
    font-size: 10.5px;
    line-height: 1.4;
  }

  .ai-set-grid2 {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 14px;
  }

  .ai-set-adv {
    margin: 2px 0 16px;
    padding: 0;
    border: 1px dashed var(--set-line);
    border-radius: 10px;
    background: color-mix(in srgb, var(--set-canvas) 55%, var(--set-paper));
  }

  .ai-set-adv summary {
    padding: 9px 11px;
    font-size: 11.5px;
    cursor: pointer;
    color: var(--set-muted);
    user-select: none;
  }

  .ai-set-adv[open] summary {
    border-bottom: 1px dashed var(--set-line);
    color: var(--set-ink);
  }

  .ai-set-adv .ai-set-check,
  .ai-set-adv .ai-set-field {
    margin: 11px;
  }

  .ai-set-check {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin: 0 0 12px;
    font-size: 12px;
    line-height: 1.45;
    cursor: pointer;
  }

  .ai-set-check input {
    margin: 2px 0 0;
    accent-color: #1a1a1a;
    flex: 0 0 auto;
  }

  .ai-set-seg {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 3px;
    border: 1px solid var(--set-line);
    border-radius: 10px;
    background: var(--set-canvas);
    align-self: flex-start;
    box-sizing: border-box;
  }

  .ai-set-seg button {
    height: 27px;
    padding: 0 11px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--set-muted);
    font-size: 11.5px;
    cursor: pointer;
    white-space: nowrap;
  }

  .ai-set-seg button.on {
    background: var(--set-paper);
    color: var(--set-ink);
    box-shadow: 0 1px 2px rgba(20, 24, 32, 0.08);
    font-weight: 600;
  }

  .ai-set-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    min-height: 28px;
  }

  .ai-set-labelrow {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .ai-set-labelrow .ai-set-label {
    flex: none;
  }

  .ai-set-meta {
    flex: 1;
    min-width: 0;
    font-size: 11px;
    color: var(--set-faint);
    font-variant-numeric: tabular-nums;
  }

  .ai-set-model-mgr {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }

  .ai-set-chips--scroll {
    max-height: 136px;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 2px 2px 2px 0;
  }

  .ai-set-chips--scroll::-webkit-scrollbar {
    width: 8px;
  }

  .ai-set-chips--scroll::-webkit-scrollbar-thumb {
    background: var(--set-line);
    border-radius: 99px;
  }

  /* 拉取模型多选弹层：铺满整窗，先选再入库，不把几十个标签直接倒进列表 */
  .ai-set-pick {
    position: absolute;
    inset: 0;
    z-index: 5;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 18px 20px;
    box-sizing: border-box;
    background: var(--set-paper);
  }

  .ai-set-pick-hd {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .ai-set-pick-hd strong {
    font-size: 14px;
    font-weight: 650;
  }

  .ai-set-pick-count {
    flex: 1;
    font-size: 11px;
    color: var(--set-faint);
  }

  .ai-set-pick-x {
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--set-muted);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
  }

  .ai-set-pick-x:hover {
    background: var(--set-canvas);
    color: var(--set-ink);
  }

  .ai-set-pick-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    border: 1px solid var(--set-line);
    border-radius: 12px;
    padding: 4px;
  }

  .ai-set-pick-item {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 7px 9px;
    border-radius: 8px;
    font-size: 12px;
    cursor: pointer;
    min-width: 0;
  }

  .ai-set-pick-item:hover {
    background: var(--set-canvas);
  }

  .ai-set-pick-item.on {
    background: color-mix(in srgb, var(--set-accent) 40%, transparent);
  }

  .ai-set-pick-item span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ai-set-pick-item input {
    accent-color: var(--set-ink);
    flex: none;
  }

  .ai-set-pick-foot {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .ai-set-pick-gap {
    flex: 1;
  }

  .ai-set-chip {
    height: 28px;
    padding: 0 11px;
    border: 1px solid var(--set-line);
    border-radius: 999px;
    background: var(--set-paper);
    color: var(--set-muted);
    font-size: 11.5px;
    cursor: pointer;
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ai-set-chip:hover {
    border-color: color-mix(in srgb, var(--set-ink) 26%, var(--set-line));
    color: var(--set-ink);
  }

  .ai-set-chip.on {
    background: #1a1a1a;
    border-color: #1a1a1a;
    color: #fff;
  }

  .ai-set-tag {
    display: inline-flex;
    align-items: center;
    max-width: 100%;
    border: 1px solid var(--set-line);
    border-radius: 999px;
    background: var(--set-paper);
    overflow: hidden;
  }

  .ai-set-tag.on {
    border-color: #1a1a1a;
    background: #1a1a1a;
    color: #fff;
  }

  .ai-set-tag-main {
    max-width: 220px;
    height: 27px;
    padding: 0 4px 0 11px;
    border: 0;
    background: transparent;
    color: inherit;
    font-size: 11px;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ai-set-tag-x {
    width: 22px;
    height: 27px;
    border: 0;
    background: transparent;
    color: inherit;
    opacity: 0.55;
    cursor: pointer;
    font-size: 13px;
    line-height: 1;
  }

  .ai-set-tag-x:hover {
    opacity: 1;
  }

  .ai-set-empty {
    font-size: 11px;
    color: var(--set-faint);
    line-height: 28px;
  }

  .ai-set-block {
    margin: 0 0 15px;
  }

  .ai-set-block-title {
    margin-bottom: 7px;
    font-size: 12px;
    font-weight: 600;
  }

  .ai-set-value {
    min-width: 52px;
    font-size: 12px;
    color: var(--set-muted);
  }

  .ai-set-source {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 11px;
    border: 1px solid var(--set-line);
    border-radius: 10px;
    background: color-mix(in srgb, var(--set-canvas) 55%, var(--set-paper));
  }

  .ai-set-source-main {
    display: flex;
    align-items: baseline;
    gap: 7px;
    flex-wrap: wrap;
    min-width: 0;
  }

  .ai-set-source-label {
    font-size: 12px;
    font-weight: 600;
  }

  .ai-set-source-title {
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }

  .ai-set-source-title.muted {
    color: var(--set-faint);
  }

  .ai-set-source-sub {
    font-size: 10.5px;
    color: var(--set-faint);
  }

  .ai-set-readonly {
    display: flex;
    gap: 10px;
    padding: 11px 12px;
    margin: 0 0 10px;
    border: 1px solid var(--set-line);
    border-radius: 10px;
    background: color-mix(in srgb, var(--set-canvas) 45%, var(--set-paper));
  }

  .ai-set-readonly-title {
    font-size: 12px;
    font-weight: 600;
    line-height: 1.4;
  }

  .ai-set-readonly-text {
    margin-top: 3px;
    font-size: 11px;
    line-height: 1.5;
    color: var(--set-muted);
  }

  .ai-set-keys {
    display: flex;
    flex-direction: column;
    gap: 0;
    border: 1px solid var(--set-line);
    border-radius: 10px;
    overflow: hidden;
  }

  .ai-set-keys > div {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 11px;
    border-bottom: 1px solid var(--set-line);
    font-size: 11.5px;
  }

  .ai-set-keys > div:last-child {
    border-bottom: 0;
  }

  .ai-set-keys kbd {
    padding: 2px 7px;
    border: 1px solid var(--set-line);
    border-bottom-width: 2px;
    border-radius: 6px;
    background: var(--set-paper);
    color: var(--set-muted);
    font-family: var(--b3-font-family-code, monospace);
    font-size: 10.5px;
    white-space: nowrap;
  }

  .ai-set-ft {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 11px 18px 11px 20px;
    border-top: 1px solid var(--set-line);
    background: var(--set-paper);
  }

  .ai-set-status {
    flex: 1;
    min-width: 0;
    font-size: 10.5px;
    line-height: 1.4;
    color: var(--set-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ai-set-status .ok {
    color: #2f7d4f;
  }

  .ai-set-status .warn {
    color: #a4691a;
  }

  .ai-set-status .err {
    color: var(--set-danger);
    white-space: normal;
  }

  .ai-set-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
  }

  .ai-set-btn {
    height: 32px;
    padding: 0 14px;
    border: 1px solid var(--set-line);
    border-radius: 9px;
    background: var(--set-paper);
    color: var(--set-ink);
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
  }

  .ai-set-btn:hover:not(:disabled) {
    background: var(--set-canvas);
    border-color: color-mix(in srgb, var(--set-ink) 26%, var(--set-line));
  }

  .ai-set-btn.primary {
    border-color: #1a1a1a;
    background: #1a1a1a;
    color: #fff;
  }

  .ai-set-btn.primary:hover:not(:disabled) {
    background: #2a2a2a;
  }

  .ai-set-btn:disabled {
    opacity: 0.42;
    cursor: default;
  }

  .ai-set-x:focus-visible,
  .ai-set-nav-item:focus-visible,
  .ai-set-input:focus-visible,
  .ai-set-textarea:focus-visible,
  .ai-set-mini:focus-visible,
  .ai-set-chip:focus-visible,
  .ai-set-tag-main:focus-visible,
  .ai-set-tag-x:focus-visible,
  .ai-set-seg button:focus-visible,
  .ai-set-btn:focus-visible {
    outline: 2px solid var(--set-accent-strong);
    outline-offset: 1px;
  }

  @media (max-width: 720px) {
    .ai-set-overlay {
      padding: 0;
      align-items: stretch;
    }

    .ai-set-dialog {
      width: 100vw;
      height: 100dvh;
      max-height: 100dvh;
      border-radius: 0;
      border-left: 0;
      border-right: 0;
    }

    .ai-set-body {
      grid-template-columns: 1fr;
      grid-template-rows: auto minmax(0, 1fr);
    }

    .ai-set-nav {
      flex-direction: row;
      gap: 6px;
      padding: 8px 10px;
      border-right: 0;
      border-bottom: 1px solid var(--set-line);
      overflow-x: auto;
      overflow-y: hidden;
    }

    .ai-set-nav-item {
      width: auto;
      flex: 0 0 auto;
      align-items: center;
      padding: 7px 10px;
    }

    .ai-set-nav-item.on {
      box-shadow: inset 0 -2px 0 var(--set-accent-strong);
    }

    .ai-set-nav-hint,
    .ai-set-nav-foot {
      display: none;
    }

    .ai-set-content {
      padding: 16px 16px 20px;
    }

    .ai-set-grid2 {
      grid-template-columns: 1fr;
      gap: 0;
    }

    .ai-set-hd {
      padding: 12px 12px 10px 14px;
    }

    .ai-set-ft {
      flex-wrap: wrap;
      padding: 9px 14px;
    }

    .ai-set-status {
      flex-basis: 100%;
    }

    .ai-set-actions {
      width: 100%;
      justify-content: flex-end;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .ai-set-dialog,
    .ai-set-nav-item,
    .ai-set-btn,
    .ai-set-mini {
      transition: none !important;
    }
  }
</style>
