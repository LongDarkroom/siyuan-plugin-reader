/**
 * 翻译引擎编排
 * ------------------------------------------------------------------
 * buildProviders：组装「未命中缓存」段落要走的 provider 链。
 *   - 2026-11-13：恢复双引擎 —— 千问 MT（首选）+ 腾讯机翻（兜底）。
 *     用户可在设置里选「自动 / 千问 / 通用大模型 / 腾讯」；自动模式按
 *     千问 → 通用大模型 → 腾讯 顺序尝试。显式选择时只装配该引擎，未配置
 *     就返回空链（由调用方提示未配置，而不是静默换另一家 —— 用户选了腾讯
 *     却走千问会产生费用归属困惑）。
 *   - 缓存命名空间跟引擎/模型绑定（见 cacheNamespaceOf），换引擎不会误用旧译文。
 *
 * translateWithFallback：链内依次尝试，返回首个「成功且译文非空」的结果；
 *   全部失败则返回全空串（provider: "none"）。
 */
import type { Translator, TranslateRequest, TranslateOutcome } from "./types.ts";
import { TencentTranslator } from "./providers/tencent.ts";
import {
  QwenMtTranslator,
  DEFAULT_QWEN_BASE_URL,
  DEFAULT_QWEN_MT_MODEL,
} from "./providers/qwen-mt.ts";
import { OpenAiCompatTranslator } from "./providers/openai-compat.ts";
import type { AiTranslateFn, AiTranslateBatchFn } from "./providers/ai.ts";

/** 用户可选的引擎链（auto = 按优先级自动尝试） */
export type EngineChoice = "auto" | "qwen-mt" | "openai-compat" | "tencent";

/** 引擎配置（来自 AiSettings 的翻译相关字段） */
export interface EngineConfig {
  // 千问机器翻译（Qwen-MT / DashScope 兼容模式）
  qwenEnabled?: boolean;
  qwenApiKey?: string;
  qwenBaseUrl?: string;
  qwenModel?: string;
  qwenCharsUsed?: number;
  // 通用大模型（任意 OpenAI 兼容端点）
  openaiEnabled?: boolean;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  openaiModel?: string;
  openaiCharsUsed?: number;
  // 腾讯翻译（Tencent Cloud TMT）
  tencentSecretId?: string;
  tencentSecretKey?: string;
  tencentEnabled?: boolean;
  // 有道翻译（有道智云）
  youdaoAppKey?: string;
  youdaoAppSecret?: string;
  youdaoEnabled?: boolean;
  // 百度翻译
  baiduAppId?: string;
  baiduKey?: string;
  baiduEnabled?: boolean;
  // 微软 Translator
  msKey?: string;
  msRegion?: string;
  /** 兜底引擎开关（默认关闭；AI 恒为首选） */
  msEnabled?: boolean;
  // LibreTranslate
  libreUrl?: string;
  libreEnabled?: boolean;
  /** 免费引擎优先级（仅当开关开启且已配置才生效；AI 永远兜底，不在此列） */
  priority?: string[];
  /** 腾讯翻译已用字符数（用于 400 万用量锁） */
  tencentCharsUsed?: number;
  /** 腾讯翻译用量锁 */
  tencentCharsLock?: number;
  /** AI 是否启用（用于可用性判断） */
  aiEnabled?: boolean;
  /** AI API Key */
  aiApiKey?: string;
  /** 可用 AI 模型列表 */
  aiModels?: string[];
  /** 百度翻译已用字符数 */
  baiduCharsUsed?: number;
  /** 百度翻译用量锁（0=不限；>0 达到后自动禁用百度引擎） */
  baiduCharsLock?: number;
  /** 有道智云已用字符数 */
  youdaoCharsUsed?: number;
  /** 有道智云用量锁（0=不限） */
  youdaoCharsLock?: number;
  /** AI 翻译累计消耗 Token（跨批次累加；监督中心配额显示用） */
  aiTokenUsed?: number;
  /** AI 翻译 Token 配额上限（0=不限） */
  aiTokenLimit?: number;
}

/** 引擎依赖（注入自有 AI 翻译函数） */
export interface EngineDeps {
  translateOne: AiTranslateFn;
  /** 批量翻译（可选）：注入后 AI 走「一次请求译 N 段」的批量模式 */
  translateBatch?: AiTranslateBatchFn;
}

/** 腾讯翻译是否已达到用量锁 */
export function isTencentLocked(cfg: EngineConfig): boolean {
  const used = cfg.tencentCharsUsed ?? 0;
  const lock = cfg.tencentCharsLock ?? 4_000_000;
  return lock > 0 && used >= lock;
}

/** 百度翻译是否已达到用量锁 */
export function isBaiduLocked(cfg: EngineConfig): boolean {
  const used = cfg.baiduCharsUsed ?? 0;
  const lock = cfg.baiduCharsLock ?? 0;
  return lock > 0 && used >= lock;
}

/** 有道智云是否已达到用量锁 */
export function isYoudaoLocked(cfg: EngineConfig): boolean {
  const used = cfg.youdaoCharsUsed ?? 0;
  const lock = cfg.youdaoCharsLock ?? 0;
  return lock > 0 && used >= lock;
}

/** AI 翻译是否已达到 Token 上限 */
export function isAiTokenLocked(cfg: EngineConfig): boolean {
  const used = cfg.aiTokenUsed ?? 0;
  const limit = cfg.aiTokenLimit ?? 0;
  return limit > 0 && used >= limit;
}

/** 判断单引擎当前是否可用（已启用 + 已配置 + 未达用量锁） */
export function isEngineAvailable(name: string, cfg: EngineConfig): boolean {
  switch (name) {
    case "qwen-mt":
      return !!(cfg.qwenEnabled && cfg.qwenApiKey);
    case "openai-compat":
      return !!(
        cfg.openaiEnabled &&
        cfg.openaiApiKey &&
        cfg.openaiBaseUrl &&
        cfg.openaiModel
      );
    case "tencent":
      return !!(cfg.tencentEnabled && cfg.tencentSecretId && cfg.tencentSecretKey && !isTencentLocked(cfg));
    case "youdao":
      return !!(cfg.youdaoEnabled && cfg.youdaoAppKey && cfg.youdaoAppSecret);
    case "baidu":
      return !!(cfg.baiduEnabled && cfg.baiduAppId && cfg.baiduKey && !isBaiduLocked(cfg));
    case "microsoft":
      return !!(cfg.msEnabled && cfg.msKey && cfg.msRegion);
    case "libretranslate":
      return !!(cfg.libreEnabled && cfg.libreUrl);
    case "ai":
      return !!(cfg.aiEnabled && cfg.aiApiKey && !isAiTokenLocked(cfg));
    default:
      return false;
  }
}

/** 用户传入的引擎值归一：任何未知值（含 undefined / 旧字段）都按 auto 处理 */
export function normalizeEngine(engine: string | undefined): EngineChoice {
  return engine === "qwen-mt" || engine === "openai-compat" || engine === "tencent"
    ? engine
    : "auto";
}

/**
 * 引擎对应的缓存命名空间。
 * 千问/通用大模型按模型隔离（不同模型译文不同）；腾讯沿用空串（历史缓存继续命中）。
 */
export function cacheNamespaceOf(name: string, cfg: EngineConfig): string {
  if (name === "qwen-mt") return `qwen-mt:${cfg.qwenModel || DEFAULT_QWEN_MT_MODEL}`;
  if (name === "openai-compat") {
    return cfg.openaiModel ? `openai:${cfg.openaiModel}` : "openai:";
  }
  if (name === "ai") return "ai";
  return "";
}

/**
 * 组装 provider 链。
 * - auto：千问（已配置）→ 通用大模型（已配置）→ 腾讯（已配置），任一可缺；
 * - 显式：只装配所选引擎，未配置返回空链（调用方据此提示「未配置」）。
 *
 * @param _deps 保留形参以兼容 run.ts 调用签名；AI provider 当前不在链内。
 */
export function buildProviders(cfg: EngineConfig, _deps: EngineDeps, engine?: string): Translator[] {
  const want = normalizeEngine(engine);
  const qwenOk = isEngineAvailable("qwen-mt", cfg);
  const openaiOk = isEngineAvailable("openai-compat", cfg);
  const tencentOk = isEngineAvailable("tencent", cfg);

  const qwen = () =>
    new QwenMtTranslator({
      apiKey: cfg.qwenApiKey || "",
      baseUrl: cfg.qwenBaseUrl || DEFAULT_QWEN_BASE_URL,
      model: cfg.qwenModel || DEFAULT_QWEN_MT_MODEL,
    });
  const openai = () =>
    new OpenAiCompatTranslator({
      apiKey: cfg.openaiApiKey || "",
      baseUrl: cfg.openaiBaseUrl || "",
      model: cfg.openaiModel || "",
    });
  const tencent = () => new TencentTranslator(cfg.tencentSecretId!, cfg.tencentSecretKey!);

  if (want === "qwen-mt") return qwenOk ? [qwen()] : [];
  if (want === "openai-compat") return openaiOk ? [openai()] : [];
  if (want === "tencent") return tencentOk ? [tencent()] : [];
  const chain: Translator[] = [];
  if (qwenOk) chain.push(qwen());
  if (openaiOk) chain.push(openai());
  if (tencentOk) chain.push(tencent());
  return chain;
}

/** 当前选择下是否存在可翻译引擎（isConfigured / 设置页状态用） */
export function hasEngine(cfg: EngineConfig, engine?: string): boolean {
  return buildProviders(cfg, { translateOne: async () => "" }, engine).length > 0;
}

/** 按顺序尝试 providers，返回首个成功且译文非空的结果 */
export async function translateWithFallback(
  providers: Translator[],
  req: TranslateRequest,
  opts?: { onTry?: (name: string) => void }
): Promise<TranslateOutcome> {
  let lastErr: unknown;
  for (const p of providers) {
    if (!p.available) continue;
    try {
      opts?.onTry?.(p.name);
      const texts = await p.translate(req);
      const ok =
        Array.isArray(texts) &&
        texts.length === req.texts.length &&
        texts.some((t) => t && t.trim());
      if (ok) return { texts, provider: p.name };
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) {
    // eslint-disable-next-line no-console
    console.warn("[REword] 全部翻译引擎失败:", lastErr);
  }
  return { texts: req.texts.map(() => ""), provider: "none" };
}
