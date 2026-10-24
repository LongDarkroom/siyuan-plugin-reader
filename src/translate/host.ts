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
import { TranslationCache, type TranslationMode } from "./cache.ts";
import { runTranslate, type TranslateBatchMeta, type TranslateBatchOpts, type TranslateRunDeps } from "./run.ts";
import { AiTranslateService } from "./host-service.ts";
import { DEFAULT_AI_SETTINGS, normalizeAiSettings } from "../ai/ai-settings.ts";
import { fetchModelList } from "../ai/ai-client.ts";
import { isEngineAvailable, type EngineConfig } from "./engine.ts";
import { GlossaryStore, type GlossaryTerm } from "./glossary.ts";
import { t } from "../i18n/index.ts";

/** 思源存储 key（本插件私有，不与主插件的 hiword-ai.json 共用） */
const TRANSLATE_SETTINGS_KEY = "reader-translate.json";
/** 术语表存储 key（独立于凭据，改术语不影响登录态） */
const GLOSSARY_KEY = "reader-glossary.json";

/**
 * 2026-10-14 简化：双语只支持**腾讯机器翻译**单引擎。
 * 引擎集合收窄成只含 tencent —— engineStatus/isConfigured 据此只报腾讯，
 * AI 兜底与其余四家（有道/百度/微软/LibreTranslate）不再作为可选项呈现。
 * （TranslateSettings / normalizeTranslateSettings 仍**容忍**旧持久化里的
 *  其它字段，避免用户历史数据报错，但运行链路已不消费它们。）
 */
const ENGINE_IDS = ["tencent"] as const;

export type EngineId = (typeof ENGINE_IDS)[number];

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
      // salt 带翻译提示词（AI 风格）+ 术语表版本：任一改了就自动失效旧译文（不删，手动清也行）。
      // 腾讯机翻无 prompt，实际只有 glossary.version 在变动时影响命中——这正是「改术语即重译」的兑现。
      const p = this.settings.translatePrompt || "";
      const gv = this.glossary.version;
      return gv > 0 ? `${p}#g${gv}` : p;
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

  /** 是否有任何可用引擎（设置界面据此提示「还没配置」）。腾讯单引擎。 */
  isConfigured(): boolean {
    return isEngineAvailable("tencent", this.engineConfig());
  }

  /**
   * 已配置引擎清单（设置界面高亮用）。
   * 返回 `{ id, label, ready }`——ready=false 表示勾选了开关但缺凭据。
   * 简化后只报腾讯。
   */
  engineStatus(): Array<{ id: EngineId; label: string; ready: boolean; enabled: boolean }> {
    const cfg = this.engineConfig();
    return ENGINE_IDS.map((id) => ({
      id,
      label: t(id),
      ready: isEngineAvailable(id, cfg),
      enabled: this.isEngineEnabled(id),
    }));
  }

  private isEngineEnabled(id: EngineId): boolean {
    return id === "tencent" && this.settings.tencentEnabled === true;
  }

  /** 构造引擎链要的配置视图 */
  private engineConfig(): EngineConfig {
    const s = this.settings;
    return {
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
      priority: Array.isArray(s.priority) && s.priority.length ? s.priority : ["tencent"],
    };
  }

  /** 用量预警（60s 节流）。腾讯单引擎：仅在设了用量锁且接近上限时提示。 */
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
      showMessage(t("腾讯翻译不可用：请在「双语翻译」设置中检查密钥或用量上限"), 5000);
    } catch { /* ignore */ }
  }

  /** 按实际命中的引擎累计用量并落盘（腾讯单引擎） */
  private async recordUsage(provider: string | undefined, submitChars: number): Promise<void> {
    if (!provider || provider === "none") return;
    if (provider === "tencent") {
      const s = this.settings;
      s.tencentCharsUsed = (s.tencentCharsUsed ?? 0) + submitChars;
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
      // 译后术语兜底替换：GlossaryStore 空表时 apply 原样返回，零开销
      postProcess: (text) => this.glossary.apply(text),
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
    try {
      return await runTranslate(this.deps("translateBatch"), {
        texts, from, to, bookId, ctxBefore, meta, opts,
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

  /** 查某书某批原文的缓存命中（整书预翻译弹窗统计用） */
  async checkCacheHits(bookId: string, texts: string[], mode?: TranslationMode): Promise<boolean[]> {
    try {
      const r = await this.cache.getBatch(bookId, texts, mode ?? "default");
      return texts.map((_, i) => !!r.fromCache[i]);
    } catch {
      return texts.map(() => false);
    }
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
  // 免费引擎默认关闭：用户必须显式开开关 + 填凭据才启用
  // （默认开启会导致「以为在用腾讯其实没配」的困惑）
  return {
    ...base,
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
    aiTokenUsed: num(raw?.aiTokenUsed),
    aiTokenLimit: num(raw?.aiTokenLimit),
    priority: Array.isArray(raw?.priority) && raw.priority.length
      ? raw.priority
      : ["tencent"],
  };
}

function num(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
