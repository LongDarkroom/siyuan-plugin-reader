/**
 * 翻译批处理核心（R0 地基 · 行为保持不变的重构）
 * ---------------------------------------------------------------
 * index.ts 的 translateBatch / translateBatchDetailed 原为近乎完全
 * copy-paste 的双胞胎（仅返回值不同，双改必漂移）。本模块抽取公共
 * 核心 runTranslate：缓存查询 → 引擎链 fallback → 写侧净化 → 写回
 * 缓存 → 用量统计。宿主能力（缓存/AI/用量/配额提示）由 deps 注入，
 * run 层零插件状态、可独立单测。
 *
 * 行为对齐原实现：
 * - overwrite 时跳过缓存，全部当作未命中重新翻译；
 * - 引擎链为空 → 配额耗尽提示后原样返回（已命中缓存照常返回）；
 * - 引擎返回经 sanitizeTranslation 规整后才入缓存（拦截「AI 解说体」）；
 * - 空译文不入缓存（pairs 只收非空）；
 * - 用量按实际命中引擎分流（qwen-mt / tencent）；
 * - 2026-11-13：缓存按引擎命名空间隔离，auto 模式按链顺序跨命名空间查找。
 */
import { getLogger } from "../core/logger.ts";
import { buildProviders, translateWithFallback, type EngineConfig } from "./engine.ts";
import { sanitizeTranslation } from "./sanitize.ts";
import { DEFAULT_TRANSLATION_MODE, type TranslationCache, type TranslationMode } from "./cache.ts";

const DEBUG_TRANSLATE = false;
function trLog(...args: unknown[]): void {
  if (DEBUG_TRANSLATE) console.log("[REword]", ...args);
}

export interface TranslateBatchMeta {
  title?: string;
  author?: string;
  language?: string;
  toc?: string;
}

export interface TranslateBatchOpts {
  model?: string;
  overwrite?: boolean;
  signal?: AbortSignal;
  mode?: TranslationMode;
  engine?: string;
}

export interface TranslateRunResult {
  texts: string[];
  /** 每段来源：命中缓存为 "cache"，引擎译出为 provider 名，空译为 null */
  providers: (string | null)[];
  fromCache: boolean[];
}

/** runTranslate 宿主依赖（插件实例注入，run 层不持有状态） */
export interface TranslateRunDeps {
  /** 日志前缀（"translateBatch" / "translateBatchDetailed"） */
  tag: string;
  cache: Pick<TranslationCache, "getBatch" | "setBatch">;
  aiSettings: EngineConfig;
  aiTranslateText: (text: string, from: string, to: string, bookId?: string) => Promise<string>;
  aiTranslateBatch: (
    texts: string[],
    from: string,
    to: string,
    bookId: string | undefined,
    ctxBefore: (string | null)[] | undefined,
    meta: TranslateBatchMeta | null,
    opts: TranslateBatchOpts | undefined,
  ) => Promise<string[]>;
  /** 用量预警（黄色，宿主侧节流） */
  warnUsage(): void;
  /** 配额耗尽提示（红色，宿主侧去重） */
  notifyQuotaExhausted(): void;
  /** 按实际命中引擎累计用量并持久化 */
  recordUsage(provider: string | undefined, submitChars: number, mode: TranslationMode): Promise<void>;
  /**
   * 译前术语约束（可选）：千问 MT 支持原生 terms 参数，能在生成阶段就采用
   * 指定译法；不支持的引擎忽略。返回空数组时零开销。
   */
  glossaryTerms?(): Array<{ source: string; target: string }>;
  /**
   * 译后处理器（可选）：净化之后、写缓存之前对译文再加工。
   * 用于「术语表」硬性替换——把引擎漏译/保留原文的术语换成指定译法。
   * 处理结果即入缓存值，故术语变更须并入缓存 salt 触发重译（见 host.ts）。
   */
  postProcess?(text: string): string;
  /**
   * 领域提示（可选；千问 `domains` / 通用大模型 prompt）。
   * 与缓存 salt 联动：改动后旧译文自动失效（见 host.ts）。
   */
  domains?(): string | undefined;
  /**
   * 翻译记忆（可选；千问 `tm_list` / 通用大模型 prompt 整句参考）。
   * 与术语表分开：术语约束词级，翻译记忆给整句参考译法。
   */
  tm?(): Array<{ source: string; target: string }>;
}

export interface TranslateRunRequest {
  texts: string[];
  from: string;
  to: string;
  bookId: string;
  ctxBefore?: (string | null)[];
  meta?: TranslateBatchMeta | null;
  opts?: TranslateBatchOpts;
}

/**
 * 批量翻译公共核心：先查按书缓存，未命中走引擎链，写侧净化后回写缓存。
 * 返回恒为 { texts, providers, fromCache }（translateBatch 取 texts 即旧行为）。
 */
export async function runTranslate(
  deps: TranslateRunDeps,
  req: TranslateRunRequest,
): Promise<TranslateRunResult> {
  const { texts, from, to, bookId, meta, opts } = req;
  if (!Array.isArray(texts) || texts.length === 0) {
    return { texts: [], providers: [], fromCache: [] };
  }
  const mode: TranslationMode = opts?.mode ?? DEFAULT_TRANSLATION_MODE;
  const out: string[] = new Array(texts.length).fill("");
  const providers: (string | null)[] = new Array(texts.length).fill(null);
  const fromCache: boolean[] = new Array(texts.length).fill(false);

  // 1) 先建链：缓存命名空间由链上 provider 决定（千问按模型隔离、腾讯沿用旧键）。
  //    建链是纯内存操作，先建不影响「链空但缓存有值」的旧行为。
  const chain = buildProviders(
    deps.aiSettings,
    {
      translateOne: (t, f, t2, bid) => deps.aiTranslateText(t, f, t2, bid),
      translateBatch: (ts, f, t2, bid) =>
        deps.aiTranslateBatch(ts, f, t2, bid, undefined, meta ?? null, { ...opts, mode }),
    },
    opts?.engine,
  );
  const namespaces: string[] = [];
  for (const p of chain) {
    const ns = p.cacheNs ?? "";
    if (!namespaces.includes(ns)) namespaces.push(ns);
  }

  // 2) 按命名空间顺序查缓存。auto 模式下同一段可能命中腾讯旧缓存（ns=""）
  //    或千问缓存（ns="qwen-mt:<model>"），命中即用，不重复付费翻译。
  let pending: number[] = texts.map((_, i) => i);
  if (!opts?.overwrite) {
    for (const ns of namespaces) {
      if (!pending.length) break;
      const sub = pending.map((i) => texts[i]);
      let r: { hits: Record<number, string>; misses: number[] };
      try {
        r = await deps.cache.getBatch(bookId, sub, mode, ns);
      } catch (e) {
        // 缓存读失败不应阻断翻译：当作全部未命中继续
        console.warn(`[REword] ${deps.tag}: 缓存读取失败（ns=${ns || "legacy"}）`, e);
        continue;
      }
      for (const k in r.hits) {
        const idx = pending[+k];
        out[idx] = r.hits[+k];
        providers[idx] = "cache";
        fromCache[idx] = true;
      }
      pending = r.misses.map((j) => pending[j]);
    }
  }
  const misses = pending;
  trLog(`${deps.tag}: 缓存命中 ${texts.length - misses.length}, 未命中 ${misses.length}/${texts.length}${opts?.overwrite ? " (覆盖缓存)" : ""}`);

  // 3) 未命中部分走引擎链（选择顺序见 engine.ts）
  if (misses.length) {
    const reqTexts = misses.map((i) => texts[i]);
    try {
      deps.warnUsage();
      if (chain.length === 0) {
        deps.notifyQuotaExhausted();
        return { texts: out, providers, fromCache };
      }
      trLog(`${deps.tag}: ${chain.length} 个引擎, 调用 translateWithFallback...`);
      const res = await translateWithFallback(chain, {
        texts: reqTexts,
        from,
        to,
        bookId,
        mode,
        terms: deps.glossaryTerms?.(),
        tm: deps.tm?.(),
        domains: deps.domains?.(),
        signal: opts?.signal,
      });
      const tr = res.texts || [];
      trLog(`${deps.tag}: 引擎返回 provider=${res.provider}, ${tr.length} 条译文, 非空 ${tr.filter((t) => t?.trim()).length} 条`);
      // 写入实际命中引擎的命名空间：换引擎后旧译文不会被覆盖，切回时还能复用
      const writeNs = chain.find((p) => p.name === res.provider)?.cacheNs ?? "";
      const pairs: Array<[string, string]> = [];
      misses.forEach((idx, j) => {
        // 写侧净化：引擎返回先规整为整洁单行再入缓存（拦截「AI 解说体」）
        let translation = sanitizeTranslation(tr[j] || "");
        // 译后术语兜底替换（若有）：净化后、入缓存前，把残留原文术语换成指定译法
        if (translation && deps.postProcess) translation = deps.postProcess(translation);
        out[idx] = translation;
        providers[idx] = translation ? res.provider : null;
        if (translation) pairs.push([texts[idx], translation]);
      });
      if (pairs.length) await deps.cache.setBatch(bookId, pairs, mode, writeNs);
      // 用量按实际命中引擎累计（按提交字符数 / AI Token 计费）
      const submitChars = reqTexts.reduce((s, t) => s + t.length, 0);
      await deps.recordUsage(res.provider === "none" ? undefined : res.provider, submitChars, mode);
    } catch (e) {
      console.error(`[REword] ${deps.tag}: 引擎链异常:`, e);
      getLogger().error("[REword] 批量翻译失败:", { error: e });
    }
  }
  trLog(`${deps.tag}: 最终返回 ${out.length} 条, 非空 ${out.filter((t) => t?.trim()).length} 条`);
  return { texts: out, providers, fromCache };
}
