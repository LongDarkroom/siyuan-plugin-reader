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

  本页不自己存数据，全部经 `onChange` 上报给 `SettingsDialog`，
  由宿主（ReaderView）调 `plugin.updateTranslateSettings(patch)`落盘。
  这样「设置项↔ 运行时」的唯一通路仍是 schema + onChange 一条，
  与其它设置项保持一致。
-->
<script lang="ts">
  import { createEventDispatcher, onMount } from "svelte";
  import { t } from "../../i18n/index.ts";
  import { getLogger } from "../../core/logger.ts";

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
   * 拉取到的模型列表（按引擎 id 存）。
   * 空数组 = 未拉取过（界面显示「获取模型」按钮）；非空 = 显示下拉。
   */
  let modelList: string[] = [];
  /** 正在拉取模型 */
  let fetchingModels = false;
  /** 拉取模型的结果提示 */
  let modelTip = "";

  /** 引擎的一个凭据字段 */
  interface EngineField {
    key: string;
    label: string;
    ph: string;
    /** 多行输入（提示词等长文本） */
    textarea?: boolean;
    /** 枚举值（存在则渲染成下拉） */
    options?: readonly string[];
  }

  /**
   * 引擎元信息：顺序、显示名、各自需要的凭据字段。
   * 2026-10-14 简化：双语只保留**腾讯机器翻译**，其余引擎卡（有道/百度/微软/
   *   LibreTranslate/AI）已从配置面下架。下方 fetchModels / __model 等 AI 专属
   *   逻辑因此成为不可达分支（保留不影响渲染，留待后续统一清理）。
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
      id: "tencent",
      name: t("腾讯翻译"),
      fields: [
        { key: "tencentSecretId", label: t("SecretId"), ph: "AKID…" },
        { key: "tencentSecretKey", label: t("SecretKey"), ph: "…" },
      ],
      doc: "https://cloud.tencent.com/product/tmt",
    },
  ] as EngineMeta[];

  /** 该引擎的启用开关字段名（AI 走 aiEnabled，其余走 xxxEnabled） */
  function enabledKey(id: string): string {
    return id === "ai" ? "aiEnabled" : `${id}Enabled`;
  }

  onMount(() => {
    load();
  });

  function load() {
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
   * 拉取服务端模型列表。
   *
   * 直传当前输入框的值（`cfg.baseUrl` / `cfg.apiKey`）而不是读宿主 settings：
   * 用户往往刚填完就点按钮，**此时输入框的值才是对的**，
   * 而 settings 可能还没落盘或已是旧值。
   *
   * 失败**不阻断配置** —— 很多服务商/代理不实现 `GET /v1/models`，
   * 此时用户可手填模型名（界面会保留输入框）。
   */
  async function fetchModels() {
    fetchingModels = true;
    modelTip = t("正在获取模型列表…");
    try {
      const r = await (host?.fetchModels?.(cfg.baseUrl ?? "", cfg.apiKey ?? "")
        ?? host?.fetchTranslateModels?.(cfg.baseUrl ?? "", cfg.apiKey ?? ""));
      if (r?.ok && r.models?.length) {
        modelList = r.models;
        modelTip = t("已获取 {n} 个模型，请选择", { n: String(r.models.length) });
        // 若当前填的模型不在列表里，提示但不自动改写 —— 用户可能故意填别名
        if (cfg.translateModel && !modelList.includes(cfg.translateModel)) {
          modelTip = t("已获取 {n} 个模型；当前填写的模型不在列表中", { n: String(modelList.length) });
        }
      } else {
        modelList = [];
        modelTip = r?.error || t("获取模型列表失败，可手动填写模型名");
      }
    } catch (e: any) {
      modelList = [];
      modelTip = String(e?.message ?? e);
    } finally {
      fetchingModels = false;
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
  }
</script>

<div class="rwd-tr-body">
  <!-- 未配置总提示：这是最容易被忽略的「为什么没反应」 -->
  {#if !status.some((s) => s.ready)}
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
          <span class="rw-switch-track" />
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
            disabled={testing === eng.id || !ready}
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
          {#each eng.fields as f (f.key)}
            <div class="rwd-tr-field">
              <label class="rwd-tr-label" for={"tr-" + eng.id + "-" + f.key}>{f.label}</label>
              {#if f.key === "__model"}
                <!--
                  模型：三种形态合一
                  ① 未拉取 → 输入框 + 「获取模型」按钮（手填兜底永远可用）
                  ② 拉取中 → 按钮禁用 + 转圈提示
                  ③ 已有列表 → 下拉选择（仍保留「手填」切换，见下）
                  设计理由：不少代理不实现 GET /v1/models，拉不到是常态，
                  所以**手填路径必须始终存在**，不能做成「必须先拉取」的向导。
                -->
                <div class="rwd-tr-model">
                  {#if modelList.length}
                    <select
                      id={"tr-" + eng.id + "-model"}
                      class="rwd-tr-select"
                      value={cfg.translateModel ?? ""}
                      on:change={(e) => setField(eng.id, "translateModel", e.currentTarget.value)}
                    >
                      {#each modelList as m (m)}
                        <option value={m}>{m}</option>
                      {/each}
                      {#if cfg.translateModel && !modelList.includes(cfg.translateModel)}
                        <option value={cfg.translateModel}>{cfg.translateModel}（{t("手填")}）</option>
                      {/if}
                    </select>
                    <button
                      type="button"
                      class="rwd-tr-btn ghost"
                      title={t("手动输入模型名")}
                      on:click={() => { modelList = []; modelTip = ""; }}
                    >{t("手填")}</button>
                  {:else}
                    <input
                      id={"tr-" + eng.id + "-model"}
                      class="rwd-tr-input"
                      type="text"
                      placeholder={t("如gpt-4o-mini / deepseek-chat")}
                      value={cfg.translateModel ?? ""}
                      on:change={(e) => setField(eng.id, "translateModel", e.currentTarget.value)}
                    />
                    <button
                      type="button"
                      class="rwd-tr-btn"
                      disabled={fetchingModels}
                      on:click={fetchModels}
                    >
                      {fetchingModels ? t("获取中…") : t("获取模型")}
                    </button>
                  {/if}
                </div>
                {#if modelTip}
                  <p class="rwd-tr-modeltip">{modelTip}</p>
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
</div>
