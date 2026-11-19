<!--
  翻译引擎配置（设置弹窗内的二级页）
  ==================================================================
  ## 为什么单独一页而不是塞进「语言」Tab

  「语言」Tab 里的 `bilingualEngine` 只是一个**下拉选择**（选哪个引擎），
  但用户拿到一个全新插件时**根本不知道每个引擎要填什么密钥**：
  腾讯要 SecretId/SecretKey、有道要 AppKey/AppSecret、微软要 Key/Region…
  结果就是「下拉里选了腾讯 → 什么都没发生 → 以为功能坏了」。

  所以引擎凭据必须有一个**能填、能测、能看状态**的地方。

  ## 形态对标 Readest

  Readest 的做法是 `LangPanel` 里放「Manage Dictionaries」入口，
  点开是独立弹窗 `CustomDictionaries.tsx`。我们沿用同构：
  设置 → 语言 → 「引擎配置」→ 本页。

  ## 数据流

  本页不自己存数据，全部经 `host.update(patch)` 交给 TranslateHost 归一化并落盘
  （`reader-translate.json`）。引擎开关、凭据、引擎选择都走同一条通路，
  设置页与运行时读的是同一份配置，避免「界面改了、翻译链路没变」。
-->
<script lang="ts">
  import { createEventDispatcher, onMount } from "svelte";
  import { t } from "../../i18n/index.ts";
  import { getLogger } from "../../core/logger.ts";
  import { isTranslationModel, preferTranslationModels } from "../../translate/model-prefs.ts";

  /** 翻译宿主（由 SettingsDialog 从宿主传入） */
  export let host: any = null;

  const dispatch = createEventDispatcher();

  /** 当前配置（从 host 读出的深拷贝） */
  let cfg: any = {};
  /** 引擎状态：[{ id, label, ready, enabled }] */
  let status: Array<{ id: string; label: string; ready: boolean; enabled: boolean }> = [];
  /** 正在测试的引擎 id（null = 无） */
  let testing = "";
  /** 每引擎的测试结果 */
  let testResult: Record<string, { ok: boolean; msg: string }> = {};
  /** 密钥类字段是否明文显示 */
  let reveal: Record<string, boolean> = {};
  /**
   * 拉取到的模型列表（按字段 key 存，qwenModel / openaiModel 各自独立）。
   * 空数组 = 未拉取过（界面显示「获取模型」按钮）；非空 = 显示下拉。
   * 2026-11-19：从单一数组改为按字段存 —— 两张卡的模型列表不能互相串。
   */
  let modelList: Record<string, string[]> = {};
  /** 正在拉取模型的字段 key（空 = 无） */
  let fetchingModels = "";
  /** 拉取模型的结果提示（按字段 key 存） */
  let modelTip: Record<string, string> = {};
  /** 宿主未就绪（插件 onload 尚未挂到 window）：此时表单为空不代表「没配过」 */
  let hostMissing = false;

  /** 引擎的一个凭据字段 */
  interface EngineField {
    key: string;
    label: string;
    ph: string;
    /** 多行输入（提示词等长文本） */
    textarea?: boolean;
    /** 枚举值（存在则渲染成下拉） */
    options?: readonly string[];
    /**
     * 可拉取服务端模型列表（2026-11-19）。
     * 字段名约定 `<prefix>Model` → 地址/密钥取 `<prefix>BaseUrl` / `<prefix>ApiKey`。
     */
    fetchable?: boolean;
  }

  /**
   * 引擎元信息：顺序、显示名、各自需要的凭据字段。
   * 2026-11-13：恢复双引擎 —— 千问 MT（首选）+ 腾讯机翻（兜底）。
   * 2026-11-19：模型字段统一支持「获取模型」，拉到的列表按翻译模型置顶排序
   *   （见 translate/model-prefs.ts）—— 千问 /models 有上百条，不排序会淹没 qwen-mt。
   */
  interface EngineMeta {
    id: string;
    name: string;
    fields: EngineField[];
    /** 凭据申请文档链接（空则不显示） */
    doc: string;
  }

  const ENGINES: EngineMeta[] = [
    {
      id: "qwen-mt",
      name: t("Qwen 翻译"),
      fields: [
        { key: "qwenApiKey", label: "API Key", ph: "sk-…" },
        {
          key: "qwenBaseUrl",
          label: t("接口地址"),
          ph: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        },
        {
          key: "qwenModel",
          label: t("模型"),
          ph: "qwen-mt-flash",
          options: ["qwen-mt-flash", "qwen-mt-plus", "qwen-mt-lite"],
          fetchable: true,
        },
      ],
      doc: "https://help.aliyun.com/zh/model-studio/get-api-key",
    },
    {
      id: "openai-compat",
      name: t("通用大模型"),
      fields: [
        {
          key: "openaiBaseUrl",
          label: t("接口地址"),
          ph: "https://api.deepseek.com/v1",
        },
        { key: "openaiApiKey", label: "API Key", ph: "sk-…" },
        { key: "openaiModel", label: t("模型"), ph: "deepseek-chat", fetchable: true },
      ],
      doc: "",
    },
    {
      id: "tencent",
      name: t("腾讯翻译"),
      fields: [
        { key: "tencentSecretId", label: t("SecretId"), ph: "AKID…" },
        { key: "tencentSecretKey", label: t("SecretKey"), ph: "…" },
      ],
      doc: "https://cloud.tencent.com/product/tmt",
    },
  ] as EngineMeta[];

  /** 引擎选择（决定实际走哪家 / 自动按优先级） */
  const ENGINE_MODES: Array<{ value: string; label: string }> = [
    { value: "auto", label: t("自动（千问 → 大模型 → 腾讯）") },
    { value: "qwen-mt", label: t("Qwen 翻译") },
    { value: "openai-compat", label: t("通用大模型") },
    { value: "tencent", label: t("腾讯翻译") },
  ];

  /**
   * 通用大模型的常用平台快捷填充（2026-11-19）。
   * 这些平台都是 OpenAI 兼容协议，没必要各自做成一个引擎卡：
   * 点一下填好「接口地址 + 代表性模型」，Key 仍由用户自己填。
   * 硅基流动放在第一位 —— 它是最常见的「一个 Key 逛多家模型」入口。
   */
  const OPENAI_PRESETS: Array<{ id: string; name: string; baseUrl: string; model: string }> = [
    { id: "siliconflow", name: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", model: "deepseek-ai/DeepSeek-V3" },
    { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
    { id: "qwen", name: "通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
    { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  ];

  /** 地址归一：用于判断「AI 平台」里是否已有同一家的 Key（忽略大小写与尾斜杠） */
  function normUrl(v: any): string {
    return String(v || "").trim().toLowerCase().replace(/\/+$/, "");
  }

  /**
   * 应用平台预设：填地址 + 模型；若翻译侧还没有 Key，而「AI 平台」里
   * 同一地址已存有 Key，则顺带带入 —— 同一把钥匙不让人再粘一遍。
   */
  async function applyPreset(p: { name: string; baseUrl: string; model: string }) {
    const patch: any = { openaiBaseUrl: p.baseUrl, openaiModel: p.model };
    const platforms = Array.isArray(cfg.platforms) ? cfg.platforms : [];
    const hit = platforms.find((x: any) => normUrl(x?.baseUrl) === normUrl(p.baseUrl) && String(x?.apiKey || "").trim());
    const imported = !!hit && !String(cfg.openaiApiKey || "").trim();
    if (imported) patch.openaiApiKey = hit.apiKey;
    cfg = { ...cfg, ...patch };
    modelList = { ...modelList, openaiModel: [] };
    modelTip = {
      ...modelTip,
      openaiModel: imported
        ? t("已填入 {name} 的接口地址与模型，并沿用了 AI 平台中保存的密钥", { name: p.name })
        : t("已填入 {name} 的接口地址与模型", { name: p.name }),
    };
    await emit(patch);
  }

  /** 该引擎的启用开关字段名（qwen-mt 用 qwenEnabled，AI 走 aiEnabled，其余走 xxxEnabled） */
  function enabledKey(id: string): string {
    if (id === "qwen-mt") return "qwenEnabled";
    if (id === "openai-compat") return "openaiEnabled";
    return id === "ai" ? "aiEnabled" : `${id}Enabled`;
  }

  /** 切换引擎链（auto / 千问 / 腾讯），立即落盘 */
  async function setEngine(value: string) {
    cfg = { ...cfg, engine: value };
    await emit({ engine: value });
  }

  onMount(() => {
    load();
  });

  function load() {
    hostMissing = !host;
    try {
      cfg = host?.getSettings?.() ?? host?.getTranslateSettings?.() ?? {};
      status = host?.engineStatus?.() ?? host?.getTranslateStatus?.() ?? [];
    } catch (e) {
      getLogger().warn("[RE 阅读器] 读翻译设置失败", { error: e });
      cfg = {};
    }
  }

  /** 该引擎是否已配好（可参与翻译） */
  function readyOf(id: string): boolean {
    return !!status.find((s) => s.id === id)?.ready;
  }

  /** 开关变更：立即落盘 */
  async function toggleEngine(id: string, on: boolean) {
    cfg = { ...cfg, [enabledKey(id)]: on };
    testResult = { ...testResult, [id]: { ok: false, msg: "" } };
    await emit({ [enabledKey(id)]: on });
  }

  /** 凭据字段变更：写内存 + 落盘 */
  async function setField(id: string, key: string, value: string) {
    cfg = { ...cfg, [key]: value };
    await emit({ [key]: value });
  }

  /** 测试连通性（走真引擎，能立刻知道密钥对不对） */
  async function test(id: string) {
    testing = id;
    testResult = { ...testResult, [id]: { ok: false, msg: t("测试中…") } };
    try {
      const r = await (host?.testEngine?.(id) ?? host?.testTranslationEngine?.(id));
      const msg = r?.ok
        ? t("连接成功（{p}）", { p: r.provider || "-" })
        : r?.error || t("连接失败");
      testResult = { ...testResult, [id]: { ok: !!r?.ok, msg } };
    } catch (e: any) {
      testResult = { ...testResult, [id]: { ok: false, msg: String(e?.message ?? e) } };
    } finally {
      testing = "";
      // 测试后刷新状态（可能刚刚才配好）
      load();
    }
  }

  /**
   * 拉取服务端模型列表（2026-11-19 接通到翻译引擎卡）。
   *
   * 直传当前输入框的值（`cfg[baseKey]` / `cfg[keyKey]`）而不是读宿主 settings：
   * 用户往往刚填完就点按钮，**此时输入框的值才是对的**，
   * 而 settings 可能还没落盘或已是旧值。
   *
   * 排序：翻译专用模型置顶（qwen-mt-flash / opus-mt / *translation* 等）——
   * 千问的 /models 返回上百条，不排序的话用户要在一堆对话模型里翻找。
   *
   * 失败**不阻断配置** —— 很多服务商/代理不实现 `GET /v1/models`，
   * 此时用户可手填模型名（界面会保留输入框）。
   */
  async function fetchModels(fieldKey: string) {
    const prefix = fieldKey.replace(/Model$/, "");
    const baseUrl = String(cfg[`${prefix}BaseUrl`] ?? "").trim();
    const apiKey = String(cfg[`${prefix}ApiKey`] ?? "");
    if (!baseUrl) {
      modelTip = { ...modelTip, [fieldKey]: t("接口地址为空") };
      return;
    }
    fetchingModels = fieldKey;
    modelTip = { ...modelTip, [fieldKey]: t("正在获取模型列表…") };
    try {
      const r = await (host?.fetchModels?.(baseUrl, apiKey)
        ?? host?.fetchTranslateModels?.(baseUrl, apiKey));
      if (r?.ok && r.models?.length) {
        const list = preferTranslationModels(r.models);
        modelList = { ...modelList, [fieldKey]: list };
        const current = String(cfg[fieldKey] ?? "").trim();
        const hasTranslation = list.some((m: string) => isTranslationModel(m));
        if (current && !list.includes(current)) {
          // 不自动改写 —— 用户可能故意填了别名，只提示
          modelTip = { ...modelTip, [fieldKey]: t("已获取 {n} 个模型；当前填写的模型不在列表中", { n: String(list.length) }) };
        } else {
          modelTip = {
            ...modelTip,
            [fieldKey]: hasTranslation
              ? t("已获取 {n} 个模型，翻译模型已置顶", { n: String(list.length) })
              : t("已获取 {n} 个模型，请选择", { n: String(list.length) }),
          };
        }
      } else {
        modelList = { ...modelList, [fieldKey]: [] };
        modelTip = { ...modelTip, [fieldKey]: r?.error || t("获取模型列表失败，可手动填写模型名") };
      }
    } catch (e: any) {
      modelList = { ...modelList, [fieldKey]: [] };
      modelTip = { ...modelTip, [fieldKey]: String(e?.message ?? e) };
    } finally {
      if (fetchingModels === fieldKey) fetchingModels = "";
    }
  }

  /** 统一出口：交给宿主落盘 */
  async function emit(patch: any) {
    try {
      await (host?.update?.(patch) ?? host?.updateTranslateSettings?.(patch));
      status = host?.engineStatus?.() ?? host?.getTranslateStatus?.() ?? status;
    } catch (e) {
      getLogger().warn("[RE 阅读器] 保存翻译设置失败", { error: e });
    }
  }

  /** 判定字段是否应做密码框（名字带 Key/Secret/AppSecret） */
  function isSecret(key: string): boolean {
    return /secret|key|password/i.test(key) && !/enabled|lock|id$/i.test(key);
  }

  /** 重置某个引擎的所有字段 */
  async function resetEngine(id: string) {
    const meta = ENGINES.find((e) => e.id === id);
    if (!meta) return;
    const patch: any = { [enabledKey(id)]: false };
    for (const f of meta.fields) patch[f.key] = "";
    cfg = { ...cfg, ...patch };
    testResult = { ...testResult, [id]: { ok: false, msg: "" } };
    await emit(patch);
    // 清空后按归一化结果回读：qwenBaseUrl / qwenModel 有默认值，
    // 若只看 patch 会显示成空框（实际运行时用的是默认值），造成误解。
    load();
  }
</script>

<div class="rwd-tr-body">
  <!-- 引擎选择：自动 = 千问优先、腾讯兜底；也可强制单引擎 -->
  <div class="rwd-tr-field">
    <label class="rwd-tr-label" for="tr-engine">{t("引擎选择")}</label>
    <select
      id="tr-engine"
      class="rwd-tr-select"
      value={cfg.engine ?? "auto"}
      on:change={(e) => setEngine(e.currentTarget.value)}
    >
      {#each ENGINE_MODES as mode (mode.value)}
        <option value={mode.value}>{mode.label}</option>
      {/each}
    </select>
  </div>
  <p class="rwd-tr-modeltip">{t("自动模式按千问 → 通用大模型 → 腾讯依次尝试，命中即可用。")}</p>

  <!--
    宿主未就绪 ≠ 没配置过：此时读不到任何字段，表单全空会误导成「密钥丢了」。
    单独提示并让用户关掉重开，比显示一张空表更诚实。
  -->
  {#if hostMissing}
    <p class="rwd-tr-tip err">
      {t("翻译服务尚未加载完成，下面的配置暂时为空（不代表没保存过）。请关闭设置后重新打开。")}
    </p>
  {:else if !status.some((s) => s.ready)}
    <!-- 未配置总提示：这是最容易被忽略的「为什么没反应」 -->
    <p class="rwd-tr-tip err">
      {t("尚未配置任何翻译引擎。请至少开启一个引擎并填入凭据，否则开启「启用翻译」也不会有译文。")}
    </p>
  {/if}

  {#each ENGINES as eng (eng.id)}
    {@const on = cfg[enabledKey(eng.id)] === true || (eng.id === "ai" && cfg.aiEnabled !== false)}
    {@const ready = readyOf(eng.id)}
    <div class="rwd-tr-card" class:on={on}>
      <div class="rwd-tr-head">
        <label class="rw-switch">
          <input
            type="checkbox"
            checked={on}
            on:change={(e) => toggleEngine(eng.id, e.currentTarget.checked)}
          />
          <span class="rw-switch-track"><span class="rw-switch-thumb" /></span>
        </label>
        <span class="rwd-tr-name">{eng.name}</span>
        {#if ready}
          <span class="rwd-tr-badge ok">{t("可用")}</span>
        {:else if on}
          <span class="rwd-tr-badge warn">{t("缺凭据")}</span>
        {:else}
          <span class="rwd-tr-badge">{t("未启用")}</span>
        {/if}
        <div class="rwd-tr-ops">
          <button
            type="button"
            class="rwd-tr-btn"
            disabled={testing === eng.id || !on}
            title={on ? "" : t("先启用该引擎")}
            on:click={() => test(eng.id)}
          >
            {testing === eng.id ? t("测试中…") : t("测试连接")}
          </button>
          {#if on}
            <button type="button" class="rwd-tr-btn ghost" on:click={() => resetEngine(eng.id)}>
              {t("清空")}
            </button>
          {/if}
        </div>
      </div>

      {#if on}
        <div class="rwd-tr-fields">
          {#if eng.id === "openai-compat"}
            <!-- 常用平台：一键填地址与模型。此前换一家就要手抄 baseUrl 和模型名，
                 最容易抄错的是模型 ID（如 deepseek-ai/DeepSeek-V3）。 -->
            <div class="rwd-tr-presets">
              <span class="rwd-tr-label">{t("常用平台")}</span>
              <div class="rwd-tr-preset-row">
                {#each OPENAI_PRESETS as p (p.id)}
                  <button type="button" class="rwd-tr-btn ghost" on:click={() => applyPreset(p)}>
                    {p.name}
                  </button>
                {/each}
              </div>
            </div>
          {/if}
          {#each eng.fields as f (f.key)}
            <div class="rwd-tr-field">
              <label class="rwd-tr-label" for={"tr-" + eng.id + "-" + f.key}>{f.label}</label>
              {#if f.fetchable}
                <!--
                  模型：三种形态合一（2026-11-19 从死分支改成通用能力，千问/大模型共用）
                  ① 未拉取 → 输入框（或预置下拉）+「获取模型」按钮（手填兜底永远可用）
                  ② 拉取中 → 按钮禁用 + 「获取中…」
                  ③ 已有列表 → 下拉选择（翻译类模型已置顶，仍可切回手填）
                  设计理由：不少代理不实现 GET /v1/models，拉不到是常态，
                  所以**手填路径必须始终存在**，不能做成「必须先拉取」的向导。
                -->
                {@const fetched = modelList[f.key] ?? []}
                <div class="rwd-tr-model">
                  {#if fetched.length}
                    <select
                      id={"tr-" + eng.id + "-" + f.key}
                      class="rwd-tr-select"
                      value={cfg[f.key] ?? ""}
                      on:change={(e) => setField(eng.id, f.key, e.currentTarget.value)}
                    >
                      {#each fetched as m (m)}
                        <option value={m}>{m}{#if isTranslationModel(m)}（{t("翻译")}）{/if}</option>
                      {/each}
                      {#if cfg[f.key] && !fetched.includes(cfg[f.key])}
                        <option value={cfg[f.key]}>{cfg[f.key]}（{t("手填")}）</option>
                      {/if}
                    </select>
                    <button
                      type="button"
                      class="rwd-tr-btn ghost"
                      title={t("手动输入模型名")}
                      on:click={() => {
                        modelList = { ...modelList, [f.key]: [] };
                        modelTip = { ...modelTip, [f.key]: "" };
                      }}
                    >{t("手填")}</button>
                  {:else if f.options}
                    <select
                      id={"tr-" + eng.id + "-" + f.key}
                      class="rwd-tr-select"
                      value={cfg[f.key] ?? f.options[0]}
                      on:change={(e) => setField(eng.id, f.key, e.currentTarget.value)}
                    >
                      {#each f.options as o (o)}
                        <option value={o}>{o}</option>
                      {/each}
                      {#if cfg[f.key] && !f.options.includes(cfg[f.key])}
                        <!-- 从「获取模型」里选过非预置模型后切回手填，仍要能回显 -->
                        <option value={cfg[f.key]}>{cfg[f.key]}（{t("手填")}）</option>
                      {/if}
                    </select>
                    <button
                      type="button"
                      class="rwd-tr-btn"
                      disabled={fetchingModels === f.key}
                      on:click={() => fetchModels(f.key)}
                    >
                      {fetchingModels === f.key ? t("获取中…") : t("获取模型")}
                    </button>
                  {:else}
                    <input
                      id={"tr-" + eng.id + "-" + f.key}
                      class="rwd-tr-input"
                      type="text"
                      placeholder={f.ph}
                      value={cfg[f.key] ?? ""}
                      on:change={(e) => setField(eng.id, f.key, e.currentTarget.value)}
                    />
                    <button
                      type="button"
                      class="rwd-tr-btn"
                      disabled={fetchingModels === f.key}
                      on:click={() => fetchModels(f.key)}
                    >
                      {fetchingModels === f.key ? t("获取中…") : t("获取模型")}
                    </button>
                  {/if}
                </div>
                {#if modelTip[f.key]}
                  <p class="rwd-tr-modeltip">{modelTip[f.key]}</p>
                {/if}
              {:else if f.textarea}
                <textarea
                  id={"tr-" + eng.id + "-" + f.key}
                  class="rwd-tr-textarea"
                  rows="4"
                  placeholder={f.ph}
                  value={cfg[f.key] ?? ""}
                  on:change={(e) => setField(eng.id, f.key, e.currentTarget.value)}
                ></textarea>
              {:else if f.options}
                <select
                  id={"tr-" + eng.id + "-" + f.key}
                  class="rwd-tr-select"
                  value={cfg[f.key] ?? f.options[0]}
                  on:change={(e) => setField(eng.id, f.key, e.currentTarget.value)}
                >
                  {#each f.options as o (o)}
                    <option value={o}>{o}</option>
                  {/each}
                </select>
              {:else if isSecret(f.key)}
                <div class="rwd-tr-secret">
                  <input
                    id={"tr-" + eng.id + "-" + f.key}
                    class="rwd-tr-input"
                    type={reveal[f.key] ? "text" : "password"}
                    placeholder={f.ph}
                    value={cfg[f.key] ?? ""}
                    on:change={(e) => setField(eng.id, f.key, e.currentTarget.value)}
                  />
                  <button
                    type="button"
                    class="rwd-tr-eye"
                    title={reveal[f.key] ? t("隐藏") : t("显示")}
                    on:click={() => (reveal = { ...reveal, [f.key]: !reveal[f.key] })}
                  >{reveal[f.key] ? "◉" : "◎"}</button>
                </div>
              {:else}
                <input
                  id={"tr-" + eng.id + "-" + f.key}
                  class="rwd-tr-input"
                  type="text"
                  placeholder={f.ph}
                  value={cfg[f.key] ?? ""}
                  on:change={(e) => setField(eng.id, f.key, e.currentTarget.value)}
                />
              {/if}
            </div>
          {/each}

          {#if testResult[eng.id]}
            <p class="rwd-tr-test" class:ok={testResult[eng.id].ok}>
              {testResult[eng.id].msg}
            </p>
          {/if}

          {#if eng.doc}
            <a class="rwd-tr-doc" href={eng.doc} target="_blank" rel="noreferrer noopener">
              {t("获取凭据 ↗")}
            </a>
          {/if}
        </div>
      {/if}
    </div>
  {/each}

  <!--
    翻译提示（领域 / 翻译记忆）：
    与引擎凭据分开——它们不属于某一家引擎，但对「译文口径」影响很大。
    千问走原生 domains / tm_list；通用大模型拼进 system prompt；腾讯机翻忽略。
    两者都并入缓存 salt：改完旧译文自动失效，不需要用户手动清缓存。
  -->
  <div class="rwd-tr-card">
    <div class="rwd-tr-head">
      <span class="rwd-tr-name">{t("翻译提示（可选）")}</span>
      <span class="rwd-tr-badge">{t("影响译文口径")}</span>
    </div>
    <div class="rwd-tr-fields">
      <div class="rwd-tr-field">
        <label class="rwd-tr-label" for="tr-domains">{t("领域")}</label>
        <input
          id="tr-domains"
          class="rwd-tr-input"
          type="text"
          placeholder={t("如：计算机 / 医学 / 文学")}
          value={cfg.domains ?? ""}
          on:change={(e) => setField("", "domains", e.currentTarget.value)}
        />
      </div>
      <div class="rwd-tr-field">
        <label class="rwd-tr-label" for="tr-tm">{t("翻译记忆")}</label>
        <textarea
          id="tr-tm"
          class="rwd-tr-textarea"
          rows="4"
          placeholder={t("每行一条：原文 => 译文")}
          value={cfg.translationMemory ?? ""}
          on:change={(e) => setField("", "translationMemory", e.currentTarget.value)}
        ></textarea>
      </div>
      <p class="rwd-tr-modeltip">
        {t("领域提示用于专业术语口径；翻译记忆是整句参考译法（最多 50 条）。修改后旧译文会自动重译。")}
      </p>
    </div>
  </div>
</div>
