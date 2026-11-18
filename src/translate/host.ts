/**
 * 翻译宿主服务（把引擎链接到思源插件实例）
 * ---------------------------------------------------------------
 * ## 拆分背景
 *
 * 拆插件时 `src/translate/`（引擎链 + 全部 provider）与 `src/ai/ai-client.ts`
 * （HTTP 传输层）都完整迁移过来了，但**驱动它们的宿主能力没有**：
 * `EngineDeps.translateOne/translateBatch` 是注入的回调，
 * 主插件由 `ai/ai-translate.ts` 提供，新插件没有对应文件。
 *
 * 结果 `index.ts` 的 `translateBatch` 一直是空的，
 * `reader-tab.ts:166` 的 `plugin?.translateBatch?.()` 恒走空兜底
 * （`?? Promise.resolve([])`）→ **双语翻译完全不工作**。
 *
 * ## 本文件职责
 *
 * 只做「装配」，不含翻译逻辑：
 * 1. 持有 AI 设置（含各引擎凭据与用量计数），落盘到 `reader-translate.json`
 * 2. 构造 `TranslationCache`（按书缓存，已存在于 translate/cache.ts）
 * 3. 把 `AiTranslateService`（AI 末端）与 cache 装进 `runTranslate` 所需的 deps
 * 4. 暴露 `isTranslationConfigured` 等给设置界面做「有没有配好」的判定
 *
 * ## 存储 key 为什么不用主插件的 `hiword-ai.json`
 *
 * 两个插件是两个独立的思源插件，`loadData/saveData` 各自落在
 * `data/storage/petal/<插件名>/` 下，**物理隔离**。若沿用同名 key，
 * 用户装了两个插件时会在思源存储里看到两份同名条目，且
 * 「主插件改了 AI 配置 → 阅读器也跟着变」这种隐式联动很难排查。
 *
 * 故新插件用 `reader-translate.json`（带 `reader-` 前缀表明归属）。
 */
import { getLogger } from "../core/logger.ts";
import { showMessage } from "siyuan";
import { TranslationCache, type TranslationMode, type CacheStats } from "./cache.ts";
import { runTranslate, type TranslateBatchMeta, type TranslateBatchOpts, type TranslateRunDeps } from "./run.ts";
import { AiTranslateService } from "./host-service.ts";
import { DEFAULT_AI_SETTINGS, normalizeAiSettings } from "../ai/ai-settings.ts";
import { fetchModelList, requestAIGenerate } from "../ai/ai-client.ts";
import type { AiSettings as EngineAiSettings } from "../ai/types.ts";
import { isEngineAvailable, hasEngine, cacheNamespaceOf, type EngineConfig, type EngineChoice } from "./engine.ts";
import { DEFAULT_QWEN_BASE_URL, DEFAULT_QWEN_MT_MODEL } from "./providers/qwen-mt.ts";
import { GlossaryStore, type GlossaryTerm } from "./glossary.ts";
import { toQwenLang } from "./lang-names.ts";
import { t } from "../i18n/index.ts";

/** 思源存储 key（本插件私有，不与主插件的 hiword-ai.json 共用） */
const TRANSLATE_SETTINGS_KEY = "reader-translate.json";
/** 术语表存储 key（独立于凭据，改术语不影响登录态） */
const GLOSSARY_KEY = "reader-glossary.json";

/**
 * 2026-11-13：双语恢复双引擎 —— 千问 MT（首选）+ 腾讯机翻（兜底）。
 * 2026-11-13 P2：新增「通用大模型」（任意 OpenAI 兼容端点），自动链夹在中间。
 * 顺序即「自动」模式的尝试顺序；engineStatus/isConfigured 据此报状态。
 */
const ENGINE_IDS = ["qwen-mt", "openai-compat", "tencent"] as const;

export type EngineId = (typeof ENGINE_IDS)[number];

/** 引擎显示名（不走 t(id)：id 是内部标识，不是中文原文 key） */
const ENGINE_LABELS: Record<EngineId, string> = {
  "qwen-mt": "Qwen 翻译",
  "openai-compat": "通用大模型",
  tencent: "腾讯翻译",
};

/** 「自动」链的默认顺序（新增引擎时同步这里） */
const DEFAULT_PRIORITY: EngineId[] = ["qwen-mt", "openai-compat", "tencent"];

/**
 * 翻译设置（全量）。
 *
 * **不用 extends**：项目里有两个同名 `AiSettings`
 * （`ai/ai-settings.ts` 的完整配置 / `ai/types.ts` 的传输层窄形状），
 * extend 错一个就会带进不相关字段并触发属性类型冲突。
 * 这里显式声明需要翻译的字段，与 `ai-settings.ts` 的 AiSettings 重叠部分
 * 由 `normalizeTranslateSettings` 负责填充。
 */
export interface TranslateSettings {
  /** 引擎选择：auto = 千问 → 腾讯；也可强制单引擎（2026-11-13 新增） */
  engine?: EngineChoice;

  // ---- 千问 MT（DashScope 兼容模式）----
  qwenEnabled?: boolean;
  qwenApiKey?: string;
  /** 默认官方兼容端点，可填代理网关 */
  qwenBaseUrl?: string;
  /** qwen-mt-flash / qwen-mt-plus / qwen-mt-lite */
  qwenModel?: string;
  /** 千问累计提交字符数（仅展示，不做用量锁） */
  qwenCharsUsed?: number;

  // ---- 通用大模型（任意 OpenAI 兼容端点）----
  openaiEnabled?: boolean;
  openaiApiKey?: string;
  /** 不含 /chat/completions 的 baseUrl（如 https://api.deepseek.com/v1） */
  openaiBaseUrl?: string;
  openaiModel?: string;
  /** 通用大模型累计提交字符数（仅展示） */
  openaiCharsUsed?: number;

  // ---- 免费引擎凭据 ----
  tencentEnabled?: boolean;
  tencentSecretId?: string;
  tencentSecretKey?: string;
  tencentCharsUsed?: number;
  tencentCharsLock?: number;

  baiduEnabled?: boolean;
  baiduAppId?: string;
  baiduKey?: string;
  baiduCharsUsed?: number;
  baiduCharsLock?: number;

  youdaoEnabled?: boolean;
  youdaoAppKey?: string;
  youdaoAppSecret?: string;
  youdaoCharsUsed?: number;
  youdaoCharsLock?: number;

  msEnabled?: boolean;
  msKey?: string;
  msRegion?: string;

  libreEnabled?: boolean;
  libreUrl?: string;

  // ---- AI（与 ai/ai-settings.ts 的 AiSettings 字段对齐，详见上方注释）----
  /** AI 总开关 */
  enabled?: boolean;
  /** 服务商 baseUrl（不含末尾 /v1/chat/completions） */
  baseUrl?: string;
  /** 兼容字段：ai-client 的传输层读这个 */
  apiKey?: string;
  /** 全局默认模型 */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  /** 系统提示词（对话用；翻译走 translatePrompt） */
  systemPrompt?: string;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;

  aiEnabled?: boolean;
  /** 翻译提示词（改它会通过缓存 salt 让旧译文自动失效） */
  translatePrompt?: string;
  /**
   * 领域提示（2026-11-13）：如「计算机 / 医学 / 文学」。
   * 千问 MT 走原生 `domains` 参数，通用大模型拼进 system prompt；腾讯忽略。
   * 改动会并入缓存 salt（领域不同译文口径不同）。
   */
  domains?: string;
  /**
   * 翻译记忆（2026-11-13）：整句级参考译法，每行「原文 => 译文」。
   * 千问走 `tm_list`，通用大模型拼进 prompt；与术语表（词级）互补。
   * 改动会并入缓存 salt。
   */
  translationMemory?: string;
  /** 翻译专用模型（留空则用全局 model） */
  translateModel?: string;
  aiApiKey?: string;
  aiModels?: string[];
  aiTokenUsed?: number;
  aiTokenLimit?: number;
  /** 免费引擎优先级（仅在开关开启且已配置才生效） */
  priority?: string[];
}

export class TranslateHost {
  private plugin: any;
  private settings: TranslateSettings;
  private cache: TranslationCache;
  private ai: AiTranslateService;
  /** 用量预警节流（避免每次翻译都弹提示） */
  private lastWarnAt: Record<string, number> = {};
  private quotaNotified = false;
  /**
   * 术语表（2026-10-14 双语重设计接活）。
   * 此前是个从不消费的 `Record<string,string>` 占位——术语「设了不生效」。
   * 现在用 GlossaryStore：译后硬性替换 + 版本并入缓存 salt（改术语自动失效重译）。
   */
  private glossary = new GlossaryStore((d) => {
    try { void this.plugin?.saveData?.(GLOSSARY_KEY, d); } catch (e) {
      getLogger().warn("[RE 阅读器] 术语表保存失败", { error: e });
    }
  });

  constructor(plugin: any) {
    this.plugin = plugin;
    this.settings = normalizeTranslateSettings({});
    this.cache = new TranslationCache(plugin, () => {
      // salt 带翻译提示词（AI 风格）+ 术语表版本 + 领域提示 + 翻译记忆：
      // 任一改了就自动失效旧译文（不删，手动清也行）。
      // 空值不拼入，保证「从未配置过」的用户缓存键与旧版一致、历史缓存继续命中。
      const s = this.settings;
      const parts = [s.translatePrompt || ""];
      if (s.domains?.trim()) parts.push(`d:${s.domains.trim()}`);
      if (s.translationMemory?.trim()) parts.push(`tm:${s.translationMemory.trim()}`);
      const gv = this.glossary.version;
      const salt = parts.join("#");
      return gv > 0 ? `${salt}#g${gv}` : salt;
    });
    this.ai = new AiTranslateService(plugin, () => this.settings);
  }

  /** 载入持久化设置（onload 阶段调用） */
  async load(): Promise<void> {
    try {
      const raw = await this.plugin?.loadData?.(TRANSLATE_SETTINGS_KEY);
      this.settings = normalizeTranslateSettings(raw || {});
    } catch (e) {
      getLogger().warn("[RE 阅读器] 翻译设置载入失败，使用默认", { error: e });
      this.settings = normalizeTranslateSettings({});
    }
    try {
      await this.glossary.load((k) => this.plugin?.loadData?.(k));
    } catch (e) {
      getLogger().warn("[RE 阅读器] 术语表载入失败，使用空表", { error: e });
    }
  }

  /** 落盘（供设置界面改完立即保存） */
  private async save(): Promise<void> {
    try {
      await this.plugin?.saveData?.(TRANSLATE_SETTINGS_KEY, this.settings);
    } catch (e) {
      getLogger().warn("[RE 阅读器] 翻译设置保存失败", { error: e });
    }
  }

  /** 供设置面板读取当前设置（深拷贝，防外部改坏内部状态） */
  getSettings(): TranslateSettings {
    return { ...this.settings };
  }

  /** 局部更新设置（设置面板用） */
  async update(patch: Partial<TranslateSettings>): Promise<void> {
    this.settings = normalizeTranslateSettings({ ...this.settings, ...patch });
    await this.save();
  }

  /** 是否有任何可用引擎（设置界面据此提示「还没配置」）。按当前选择判定。 */
  isConfigured(): boolean {
    return hasEngine(this.engineConfig(), this.settings.engine);
  }

  /**
   * 已配置引擎清单（设置界面高亮用）。
   * 返回 `{ id, label, ready }`——ready=false 表示勾选了开关但缺凭据。
   */
  engineStatus(): Array<{ id: EngineId; label: string; ready: boolean; enabled: boolean }> {
    const cfg = this.engineConfig();
    return ENGINE_IDS.map((id) => ({
      id,
      label: t(ENGINE_LABELS[id]),
      ready: isEngineAvailable(id, cfg),
      enabled: this.isEngineEnabled(id),
    }));
  }

  private isEngineEnabled(id: EngineId): boolean {
    if (id === "qwen-mt") return this.settings.qwenEnabled === true;
    if (id === "openai-compat") return this.settings.openaiEnabled === true;
    return this.settings.tencentEnabled === true;
  }

  /** 构造引擎链要的配置视图 */
  private engineConfig(): EngineConfig {
    const s = this.settings;
    return {
      qwenEnabled: s.qwenEnabled,
      qwenApiKey: s.qwenApiKey,
      qwenBaseUrl: s.qwenBaseUrl,
      qwenModel: s.qwenModel,
      qwenCharsUsed: s.qwenCharsUsed ?? 0,
      openaiEnabled: s.openaiEnabled,
      openaiApiKey: s.openaiApiKey,
      openaiBaseUrl: s.openaiBaseUrl,
      openaiModel: s.openaiModel,
      openaiCharsUsed: s.openaiCharsUsed ?? 0,
      tencentEnabled: s.tencentEnabled,
      tencentSecretId: s.tencentSecretId,
      tencentSecretKey: s.tencentSecretKey,
      tencentCharsUsed: s.tencentCharsUsed ?? 0,
      tencentCharsLock: s.tencentCharsLock ?? 0,
      baiduEnabled: s.baiduEnabled,
      baiduAppId: s.baiduAppId,
      baiduKey: s.baiduKey,
      baiduCharsUsed: s.baiduCharsUsed ?? 0,
      baiduCharsLock: s.baiduCharsLock ?? 0,
      youdaoEnabled: s.youdaoEnabled,
      youdaoAppKey: s.youdaoAppKey,
      youdaoAppSecret: s.youdaoAppSecret,
      youdaoCharsUsed: s.youdaoCharsUsed ?? 0,
      youdaoCharsLock: s.youdaoCharsLock ?? 0,
      msEnabled: s.msEnabled,
      msKey: s.msKey,
      msRegion: s.msRegion,
      libreEnabled: s.libreEnabled,
      libreUrl: s.libreUrl,
      aiEnabled: s.aiEnabled !== false && s.enabled !== false,
      aiApiKey: s.aiApiKey || s.apiKey,
      aiModels: s.aiModels,
      aiTokenUsed: s.aiTokenUsed ?? 0,
      aiTokenLimit: s.aiTokenLimit ?? 0,
      priority: Array.isArray(s.priority) && s.priority.length ? s.priority : [...DEFAULT_PRIORITY],
    };
  }

  /** 用量预警（60s 节流）。当前仅腾讯设了用量锁；千问按量计费不做硬锁。 */
  private warnUsage(): void {
    const s = this.settings;
    const now = Date.now();
    const THROTTLE = 60_000;
    const warn = (key: string, msg: string) => {
      if (now - (this.lastWarnAt[key] || 0) < THROTTLE) return;
      this.lastWarnAt[key] = now;
      try {
        showMessage(msg, 4000);
      } catch { /* 无 UI 环境忽略 */ }
    };
    const ratio = 0.8;
    const tLock = s.tencentCharsLock ?? 0;
    if (tLock > 0 && s.tencentCharsUsed) {
      const r = s.tencentCharsUsed / tLock;
      if (r >= ratio) warn("tencent", t("腾讯翻译额度已用至 {n}%，接近上限将自动停止。", { n: Math.round(r * 100) }));
    }
  }

  private notifyQuotaExhausted(): void {
    if (this.quotaNotified) return;
    this.quotaNotified = true;
    try {
      showMessage(t("翻译引擎不可用：请在「双语翻译」设置中检查引擎开关、密钥或用量上限"), 5000);
    } catch { /* ignore */ }
  }

  /** 按实际命中的引擎累计用量并落盘 */
  private async recordUsage(provider: string | undefined, submitChars: number): Promise<void> {
    if (!provider || provider === "none") return;
    if (provider === "qwen-mt") {
      this.settings.qwenCharsUsed = (this.settings.qwenCharsUsed ?? 0) + submitChars;
      await this.save();
      return;
    }
    if (provider === "openai-compat") {
      this.settings.openaiCharsUsed = (this.settings.openaiCharsUsed ?? 0) + submitChars;
      await this.save();
      return;
    }
    if (provider === "tencent") {
      this.settings.tencentCharsUsed = (this.settings.tencentCharsUsed ?? 0) + submitChars;
      await this.save();
    }
  }

  /** runTranslate 所需的宿主依赖 */
  private deps(tag: string): TranslateRunDeps {
    return {
      tag,
      cache: this.cache,
      aiSettings: this.engineConfig(),
      aiTranslateText: (t2, f, to, bid) => this.ai.translateOne(t2, f, to, bid),
      aiTranslateBatch: (ts, f, to, bid, ctx, meta, o) =>
        this.ai.translateBatch(ts, f, to, bid, ctx, meta, o),
      warnUsage: () => this.warnUsage(),
      notifyQuotaExhausted: () => this.notifyQuotaExhausted(),
      recordUsage: (provider, chars) => this.recordUsage(provider, chars),
      // 译前术语约束（千问原生 terms 参数）；不支持的引擎忽略
      glossaryTerms: () =>
        this.glossary.terms
          .filter((term) => term.src && term.dst)
          .map((term) => ({ source: term.src, target: term.dst })),
      // 译后术语兜底替换：GlossaryStore 空表时 apply 原样返回，零开销
      postProcess: (text) => this.glossary.apply(text),
      // 领域 / 翻译记忆（空串 = undefined / 空数组，provider 侧零开销）
      domains: () => this.settings.domains?.trim() || undefined,
      tm: () => parseTranslationMemory(this.settings.translationMemory),
    };
  }

  /** 批量翻译（只返回译文） */
  async translateBatch(
    texts: string[],
    from: string,
    to: string,
    bookId: string,
    ctxBefore?: (string | null)[],
    meta?: TranslateBatchMeta | null,
    opts?: TranslateBatchOpts,
  ): Promise<string[]> {
    const r = await this.translateBatchDetailed(texts, from, to, bookId, ctxBefore, meta, opts);
    return r.texts;
  }

  /** 批量翻译（回传每段来源，供成本与引擎统计） */
  async translateBatchDetailed(
    texts: string[],
    from: string,
    to: string,
    bookId: string,
    ctxBefore?: (string | null)[],
    meta?: TranslateBatchMeta | null,
    opts?: TranslateBatchOpts,
  ): Promise<{ texts: string[]; providers: (string | null)[]; fromCache: boolean[] }> {
    // 引擎链为空时不要静默返回空数组——那是「用户以为功能坏了」的经典成因。
    if (!this.isConfigured()) {
      this.notifyQuotaExhausted();
      return { texts: [], providers: [], fromCache: [] };
    }
    // 调用方未显式指定时用设置里的引擎选择（auto / qwen-mt / tencent）
    const engine = opts?.engine || this.settings.engine;
    try {
      return await runTranslate(this.deps("translateBatch"), {
        texts, from, to, bookId, ctxBefore, meta,
        opts: { ...(opts || {}), engine },
      });
    } catch (e) {
      getLogger().error("[RE 阅读器] 批量翻译失败", { error: e });
      return { texts: [], providers: [], fromCache: [] };
    }
  }

  /**
   * 拉取服务端模型列表（设置页「获取模型」按钮）。
   *
   * 直传 baseUrl/apiKey 而非读 settings：用户往往是**刚填完还没失焦**，
   * 此刻settings 里还是旧值。若只读settings，用户会看到「获取失败」
   * 但地址明明填对了 —— 极难定位。
   */
  async fetchModels(
    baseUrl?: string,
    apiKey?: string,
  ): Promise<{ ok: boolean; models: string[]; error?: string }> {
    const url = (baseUrl ?? this.settings.baseUrl ?? "").trim();
    const key = apiKey ?? this.settings.apiKey ?? this.settings.aiApiKey ?? "";
    try {
      const models = await fetchModelList(url, key);
      return { ok: true, models };
    } catch (e: any) {
      return { ok: false, models: [], error: String(e?.message ?? e) };
    }
  }

  /**
   * 当前引擎选择对应的缓存命名空间。
   * 缓存是纯本地读取，不依赖凭据是否填好 —— 即使用户刚关掉引擎，
   * 也应能看见「这本书已经缓存了多少」。
   */
  private cacheNamespaces(): string[] {
    const want = this.settings.engine;
    const ids: EngineId[] =
      want === "qwen-mt" || want === "openai-compat" || want === "tencent"
        ? [want]
        : [...DEFAULT_PRIORITY];
    const cfg = this.engineConfig();
    const out: string[] = [];
    for (const id of ids) {
      const ns = cacheNamespaceOf(id, cfg);
      if (!out.includes(ns)) out.push(ns);
    }
    return out;
  }

  /** 查某书某批原文的缓存命中（整书预翻译弹窗统计用；跨引擎命名空间取并集） */
  async checkCacheHits(bookId: string, texts: string[], mode?: TranslationMode): Promise<boolean[]> {
    try {
      const namespaces = this.cacheNamespaces();
      const hits = texts.map(() => false);
      let pending = texts.map((_, i) => i);
      for (const ns of namespaces) {
        if (!pending.length) break;
        const r = await this.cache.getBatch(bookId, pending.map((i) => texts[i]), mode ?? "default", ns);
        for (const k in r.hits) hits[pending[+k]] = true;
        pending = r.misses.map((j) => pending[j]);
      }
      return hits;
    } catch {
      return texts.map(() => false);
    }
  }

  /**
   * 读缓存里的译文（2026-11-17，PDF 整本翻译用）。
   *
   * 为什么需要它：`checkCacheHits` 只回「有没有命中」，不回译文内容。
   * PDF 流程里命中段的译文**必须取出来填进结果**，否则那一页只有未命中段有译文
   * （实测踩过：结果变成「原文\n\n原文\n\n译文」这种前后拼接的怪东西）。
   *
   * @returns 原文 → 译文（只含命中的）
   */
  async getCachedTranslations(
    bookId: string,
    texts: string[],
    mode?: TranslationMode,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    try {
      const namespaces = this.cacheNamespaces();
      const pending = texts.map((_, i) => i);
      for (const ns of namespaces) {
        if (!pending.length) break;
        const r = await this.cache.getBatch(bookId, pending.map((i) => texts[i]), mode ?? "default", ns);
        for (const k in r.hits) {
          const idx = pending[+k];
          const src = idx !== undefined ? texts[idx] : undefined;
          const val = r.hits[k];
          if (src !== undefined && val) out.set(src, val);
        }
        const stillPending = new Set(r.misses);
        for (let i = pending.length - 1; i >= 0; i--) {
          if (!stillPending.has(i)) pending.splice(i, 1);
        }
      }
    } catch {
      // 缓存读失败不该中断翻译（顶多是重新译一遍）
    }
    return out;
  }

  // ===== 术语表（供「双语翻译」设置子页读写；2026-10-14 接活）=====

  /** 当前术语词条（返回副本，外部改动不回灌内部状态） */
  glossaryTerms(): GlossaryTerm[] {
    return this.glossary.terms.map((t2) => ({ ...t2 }));
  }

  /**
   * 整体替换术语表。GlossaryStore 内部 version++ 并落盘，
   * 版本已并入缓存 salt → 相关旧译文自动失效、下次读到即按新术语重译。
   */
  glossaryReplaceAll(terms: GlossaryTerm[]): void {
    this.glossary.replaceAll(terms);
  }

  /** 术语表是否为空（UI 据此提示「未配置」并跳过替换开销） */
  glossaryIsEmpty(): boolean {
    return this.glossary.isEmpty();
  }

  /**
   * 从书籍样本自动提取术语（2026-11-13）。
   *
   * 只「产出候选」，不落盘：术语译法需要用户确认，错误词条会污染整本书。
   * 走对话模型（通用大模型 / AI 配置）；千问 MT 是专用翻译模型，不会按
   * 「提取 JSON」的指令输出，强制调用只会得到一段翻译，故不作为候选源。
   */
  async extractGlossaryTerms(sample: string, target = "zh"): Promise<ExtractTermsResult> {
    const text = String(sample || "").replace(/\s+/g, " ").trim().slice(0, 6000);
    if (!text) return { ok: false, terms: [], error: t("没有可用的书籍样本文本") };
    const chat = this.chatConfig();
    if (!chat) {
      return {
        ok: false,
        terms: [],
        error: t("术语提取需要对话模型：请先在「翻译引擎与凭据」配置「通用大模型」"),
      };
    }
    try {
      const lang = toQwenLang(target) || target;
      const res = await requestAIGenerate({
        settings: chat,
        messages: [
          {
            role: "system",
            content:
              `You extract glossary terms from a book excerpt for translation into ${lang}. ` +
              `Return ONLY a JSON array (no prose, no code fence). Each item: ` +
              `{"source":"term in the original language","target":"suggested ${lang} translation"}. ` +
              `Include proper nouns (people, places, organizations, invented terms), technical terms ` +
              `and recurring key phrases. Exclude common words. 8-40 items, no duplicates.`,
          },
          { role: "user", content: text },
        ],
        jsonMode: false,
        timeout: 45000,
      });
      const terms = parseExtractedTerms(res?.content || "");
      if (!terms.length) {
        return { ok: false, terms: [], error: t("模型没有返回可解析的术语，请重试") };
      }
      return { ok: true, terms };
    } catch (e: any) {
      getLogger().warn("[RE 阅读器] 术语自动提取失败", { error: e });
      return { ok: false, terms: [], error: String(e?.message ?? e) };
    }
  }

  /**
   * 术语提取用的对话模型配置。
   * 优先「通用大模型」（用户为此专门配过）；否则回退到 AI 一组配置。
   * 千问 MT / 腾讯不在此列（前者不会按指令输出 JSON，后者是纯机翻）。
   */
  private chatConfig(): EngineAiSettings | null {
    const s = this.settings;
    if (s.openaiEnabled && s.openaiBaseUrl && s.openaiApiKey && s.openaiModel) {
      return {
        enabled: true,
        baseUrl: s.openaiBaseUrl,
        apiKey: s.openaiApiKey,
        model: s.openaiModel,
        temperature: 0.2,
        maxTokens: 2048,
        systemPrompt: "",
        jsonMode: false,
      };
    }
    const aiOn = s.aiEnabled !== false && s.enabled !== false;
    const baseUrl = (s.baseUrl || "").trim();
    const apiKey = (s.aiApiKey || s.apiKey || "").trim();
    const model = (s.translateModel || s.model || "").trim();
    if (aiOn && baseUrl && apiKey && model) {
      return {
        enabled: true,
        baseUrl,
        apiKey,
        model,
        temperature: 0.2,
        maxTokens: 2048,
        systemPrompt: "",
        jsonMode: false,
      };
    }
    return null;
  }

  // ===== 翻译缓存管理（供「双语翻译」设置子页列书 / 清空；从独立弹窗迁入）=====

  /** 列出所有已有翻译缓存的书（bookId + 书名 + 段数） */
  async listCachedBooks(): Promise<any[]> {
    try {
      return await this.cache.listCachedBooks();
    } catch {
      return [];
    }
  }

  /** 某书缓存段数 */
  async cacheSize(bookId: string, mode?: TranslationMode): Promise<number> {
    try {
      return await this.cache.size(bookId, mode);
    } catch {
      return 0;
    }
  }

  /** 清空某书的翻译缓存（含 .json / meta / 修订） */
  async clearCacheBook(bookId: string): Promise<void> {
    await this.cache.clear(bookId);
  }

  /** 某书缓存按引擎汇总（缓存面板展示「千问 120 段 / 腾讯 30 段」） */
  async cacheStats(bookId: string): Promise<CacheStats> {
    try {
      return await this.cache.stats(bookId);
    } catch {
      return { total: 0, chars: 0, engines: [] };
    }
  }

  /** 清空全部书的翻译缓存，返回清掉的书数 */
  async clearAllCaches(): Promise<number> {
    const books = await this.listCachedBooks();
    for (const b of books) await this.cache.clear(b.bookId);
    return books.length;
  }

  /**
   * 清理孤儿缓存（书架里已不存在的书）。
   * 书架为空 / 未加载时直接返回 0 —— 宁可不清，也不能把在读书的缓存全删掉。
   */
  async cleanOrphanCaches(): Promise<number> {
    const list = (this.plugin as any)?.readerDock?.storeRef?.list;
    if (!Array.isArray(list) || !list.length) return 0;
    const valid = new Set<string>();
    for (const b of list) if (b?.id) valid.add(String(b.id));
    if (!valid.size) return 0;
    return this.cache.cleanOrphanCaches(valid);
  }

  /**
   * 清理 N 天未更新的翻译缓存（含「最近翻译」时间来自 readDir）。
   * 取不到时间的书**不删** —— 无法判定新旧时宁可留着。
   */
  async cleanOldCaches(days: number): Promise<number> {
    if (!Number.isFinite(days) || days <= 0) return 0;
    const cutoff = Date.now() / 1000 - days * 86400;
    const books = await this.listCachedBooks();
    let removed = 0;
    for (const b of books) {
      if (typeof b.updated !== "number") continue;
      if (b.updated >= cutoff) continue;
      await this.cache.clear(b.bookId);
      removed++;
    }
    return removed;
  }

  /**
   * 测试某引擎连通性：一句样例走指定引擎，返回是否拿到有效译文。
   * 设置界面「测试连接」按钮用。
   */
  async testEngine(engineId: string): Promise<{ ok: boolean; provider?: string; error?: string }> {
    try {
      const sample = "Hello, world! This is a connectivity test.";
      // 走 runTranslate 的单条路径，天然覆盖「配置读取 + 引擎调用 + 净化」全链路
      const r = await runTranslate(this.deps("testEngine"), {
        texts: [sample],
        from: "en",
        to: "zh",
        bookId: "__test__",
        opts: { overwrite: true, engine: engineId },
      });
      const out = r.texts[0] || "";
      const provider = r.providers[0];
      if (out.trim()) return { ok: true, provider: provider ?? undefined };
      return { ok: false, provider: provider ?? undefined, error: t("引擎未返回有效译文（请检查密钥/配置）") };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  }
}

/** 把任意 raw（可能是 undefined / 旧版格式 / 脏数据）归一为完整设置 */
export function normalizeTranslateSettings(raw: any): TranslateSettings {
  const base = normalizeAiSettings(raw || {}) as TranslateSettings;
  // 免费/付费引擎默认关闭：用户必须显式开开关 + 填凭据才启用
  // （默认开启会导致「以为在用千问其实没配」的困惑）
  return {
    ...base,
    engine:
      raw?.engine === "qwen-mt" || raw?.engine === "openai-compat" || raw?.engine === "tencent"
        ? raw.engine
        : "auto",
    qwenEnabled: raw?.qwenEnabled === true,
    qwenApiKey: raw?.qwenApiKey || "",
    qwenBaseUrl: raw?.qwenBaseUrl || DEFAULT_QWEN_BASE_URL,
    qwenModel: raw?.qwenModel || DEFAULT_QWEN_MT_MODEL,
    qwenCharsUsed: num(raw?.qwenCharsUsed),
    openaiEnabled: raw?.openaiEnabled === true,
    openaiApiKey: raw?.openaiApiKey || "",
    openaiBaseUrl: raw?.openaiBaseUrl || "",
    openaiModel: raw?.openaiModel || "",
    openaiCharsUsed: num(raw?.openaiCharsUsed),
    tencentEnabled: raw?.tencentEnabled === true,
    tencentSecretId: raw?.tencentSecretId || "",
    tencentSecretKey: raw?.tencentSecretKey || "",
    tencentCharsUsed: num(raw?.tencentCharsUsed),
    tencentCharsLock: num(raw?.tencentCharsLock),
    baiduEnabled: raw?.baiduEnabled === true,
    baiduAppId: raw?.baiduAppId || "",
    baiduKey: raw?.baiduKey || "",
    baiduCharsUsed: num(raw?.baiduCharsUsed),
    baiduCharsLock: num(raw?.baiduCharsLock),
    youdaoEnabled: raw?.youdaoEnabled === true,
    youdaoAppKey: raw?.youdaoAppKey || "",
    youdaoAppSecret: raw?.youdaoAppSecret || "",
    youdaoCharsUsed: num(raw?.youdaoCharsUsed),
    youdaoCharsLock: num(raw?.youdaoCharsLock),
    msEnabled: raw?.msEnabled === true,
    msKey: raw?.msKey || "",
    msRegion: raw?.msRegion || "southeastasia",
    libreEnabled: raw?.libreEnabled === true,
    libreUrl: raw?.libreUrl || "",
    aiEnabled: raw?.aiEnabled !== false,
    translateModel: raw?.translateModel || base.model,
    translatePrompt: raw?.translatePrompt || DEFAULT_AI_SETTINGS.translatePrompt || "",
    domains: raw?.domains || "",
    translationMemory: raw?.translationMemory || "",
    aiTokenUsed: num(raw?.aiTokenUsed),
    aiTokenLimit: num(raw?.aiTokenLimit),
    priority: Array.isArray(raw?.priority) && raw.priority.length
      ? raw.priority
      : [...DEFAULT_PRIORITY],
  };
}

function num(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 翻译记忆行数上限：与千问 tm_list 条数上限对齐，超出截断避免撑爆请求体 */
const MAX_TM_LINES = 50;

/** 自动提取术语的结果（失败时 error 给用户看，不抛异常到 UI） */
export interface ExtractTermsResult {
  ok: boolean;
  terms: Array<{ src: string; dst: string }>;
  error?: string;
}

/** 单次自动提取的术语条数上限 */
const MAX_EXTRACTED_TERMS = 50;

/**
 * 解析模型返回的术语 JSON。
 *
 * 容错三类常见偏差（不要因为一个格式问题让整次提取白费）：
 *  1. 包了 ```json 代码围栏或前后带解释文字 → 截取第一个 `[` 到最后一个 `]`；
 *  2. 字段名写法不一 → source/src/term/original 与 target/dst/translation 都认；
 *  3. 模型完全不按 JSON 输出 → 退化为逐行「原文 => 译法」（与翻译记忆同格式）。
 */
export function parseExtractedTerms(raw: string): Array<{ src: string; dst: string }> {
  const text = String(raw || "").trim();
  if (!text) return [];
  const out: Array<{ src: string; dst: string }> = [];
  const seen = new Set<string>();
  const push = (srcRaw: unknown, dstRaw: unknown) => {
    const src = String(srcRaw ?? "").trim();
    const dst = String(dstRaw ?? "").trim();
    if (!src || !dst || src.length > 80 || dst.length > 120) return;
    const key = src.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ src, dst });
  };

  const l = text.indexOf("[");
  const r = text.lastIndexOf("]");
  let data: any = null;
  if (l >= 0 && r > l) {
    try {
      data = JSON.parse(text.slice(l, r + 1));
    } catch {
      data = null;
    }
  }
  const rows: any[] = Array.isArray(data) ? data : Array.isArray(data?.terms) ? data.terms : [];
  for (const row of rows) {
    if (Array.isArray(row)) push(row[0], row[1]);
    else if (row && typeof row === "object") {
      push(
        row.source ?? row.src ?? row.term ?? row.original,
        row.target ?? row.dst ?? row.translation,
      );
    }
    if (out.length >= MAX_EXTRACTED_TERMS) return out;
  }
  if (!out.length) {
    for (const line of text.split(/\r?\n/)) {
      const m = line.trim().match(/^(.+?)\s*(?:=>|\t)\s*(.+)$/);
      if (m) push(m[1], m[2]);
      if (out.length >= MAX_EXTRACTED_TERMS) break;
    }
  }
  return out;
}

/**
 * 解析翻译记忆文本（每行「原文 => 译文」，也接受 Tab 分隔）。
 *
 * 空行 / `#` 注释行 / 不含分隔符的行一律跳过：用户多半从表格或笔记里
 * 直接粘贴，脏行不应让整份记忆失效。解析结果交给 provider：
 * 千问透传 `tm_list`，通用大模型拼进 prompt，腾讯忽略。
 */
export function parseTranslationMemory(
  raw: string | undefined,
): Array<{ source: string; target: string }> {
  const out: Array<{ source: string; target: string }> = [];
  for (const line of String(raw || "").split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const m = s.match(/^(.+?)\s*(?:=>|\t)\s*(.+)$/);
    if (!m) continue;
    const source = m[1].trim();
    const target = m[2].trim();
    if (source && target) out.push({ source, target });
    if (out.length >= MAX_TM_LINES) break;
  }
  return out;
}
