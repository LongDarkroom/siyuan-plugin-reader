/**
 * 翻译引擎编排
 * ------------------------------------------------------------------
 * buildProviders：组装「未命中缓存」段落要走的 provider 链。
 *   - 2026-10-14 简化：双语只保留**腾讯机器翻译**单一引擎。
 *     原先的「免费引擎优先级链（腾讯/有道/百度/微软/LibreTranslate）+ AI 兜底」
 *     整条下线 —— AI 翻译暂不支持，其余四家凭据/用量/优先级配置一并撤除。
 *     deps（AI 注入函数）形参保留只为不破坏 run.ts 的调用签名，实际不再使用。
 *   - 链为 `[TencentTranslator]`（已配置密钥）或 `[]`（未配置）。
 *     链空时由调用方（run.ts / TranslateHost）提示「未配置」，不静默返回空。
 *
 * translateWithFallback：链内依次尝试，返回首个「成功且译文非空」的结果；
 *   全部失败则返回全空串（provider: "none"）。单引擎下等价于「试一次腾讯」。
 */
import type { Translator, TranslateRequest, TranslateOutcome } from "./types.ts";
import { TencentTranslator } from "./providers/tencent.ts";
import type { AiTranslateFn, AiTranslateBatchFn } from "./providers/ai.ts";

/** 引擎配置（来自 AiSettings 的翻译相关字段） */
export interface EngineConfig {
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

/**
 * 组装 provider 链：只可能是「腾讯」单引擎。
 * 仅当腾讯「已启用 + 已配置密钥 + 未达用量锁」才入链，否则返回空链（由调用方提示未配置）。
 *
 * @param _deps  保留形参以兼容 run.ts 调用签名；AI 已下线，这里不使用。
 * @param _engine 保留形参；单引擎下无「选链」语义，忽略用户传入值。
 */
export function buildProviders(cfg: EngineConfig, _deps: EngineDeps, _engine?: string): Translator[] {
  if (isEngineAvailable("tencent", cfg)) {
    return [new TencentTranslator(cfg.tencentSecretId!, cfg.tencentSecretKey!)];
  }
  return [];
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
