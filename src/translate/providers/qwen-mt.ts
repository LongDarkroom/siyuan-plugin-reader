/**
 * 通义千问机器翻译（Qwen-MT）
 * ------------------------------------------------------------------
 * 与通用大模型翻译不同，Qwen-MT 是**专用翻译模型**：不拼 system prompt，
 * 源/目标语言与术语通过顶层 `translation_options` 传入，模型直接输出译文。
 * 这带来三个必须注意的约束（踩错就是「配了不生效」）：
 *
 * 1. **只认 user 消息**：system prompt 会被忽略，语言/术语必须走 options。
 * 2. **语言用英文全名**（"Chinese" / "English"），不是 ISO 代码。
 * 3. **上下文 8192 token**：批量必须按字符预算分片，且模型可能合并/漏段，
 *    段数对不上时逐段重译兜底 —— 错配译文比空缺更糟。
 *
 * 计费：按输入/输出 token（qwen-mt-flash 约 ¥0.7 / ¥1.95 每百万 token），
 * 远低于通用大模型翻译，故作为「自动」模式的首选引擎。
 */
import type { Translator, TranslateRequest } from "../types.ts";
import {
  requestAIGenerate,
  type AiGenerateOptions,
  type AiGenerateResult,
} from "../../ai/ai-client.ts";
import type { AiSettings as EngineAiSettings } from "../../ai/types.ts";
import { toQwenLang } from "../lang-names.ts";
import { chunkTexts, isRetriable as retriable, splitBatch } from "./batch.ts";

/** 兼容旧名：千问分片逻辑已抽到 batch.ts，两个引擎共用 */
export function chunkForQwen(
  texts: string[],
  maxChars = MAX_CHARS_PER_REQUEST,
  maxCount = MAX_SEGMENTS_PER_REQUEST,
): number[][] {
  return chunkTexts(texts, maxChars, maxCount);
}
export const splitQwenBatch = splitBatch;

/** 官方兼容模式端点（用户可改；代理网关自行填写自己的 /v1） */
export const DEFAULT_QWEN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
/** 默认模型：flash 最便宜且足够做段落翻译 */
export const DEFAULT_QWEN_MT_MODEL = "qwen-mt-flash";
/** 可选模型（设置页下拉；也可手填代理上的其它模型名） */
export const QWEN_MT_MODELS = ["qwen-mt-flash", "qwen-mt-plus", "qwen-mt-lite"] as const;

/** 单次请求的保守预算（8192 token 上下文，留足输出空间） */
const MAX_CHARS_PER_REQUEST = 3500;
const MAX_SEGMENTS_PER_REQUEST = 12;
/** 千问 terms 参数条数上限（超出会被服务端拒绝，宁少勿多） */
const MAX_TERMS = 50;

export type QwenGenerateFn = (opts: AiGenerateOptions) => Promise<AiGenerateResult>;

export interface QwenMtConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

export interface QwenMtOptions {
  /** 测试注入用；生产缺省 requestAIGenerate */
  generate?: QwenGenerateFn;
  /** 重试退避基数（毫秒；测试可调小） */
  backoffMs?: number;
}

/** 批量译文段数对不上：上层据此逐段兜底，而不是把内容错配到别的段落 */
export class QwenBatchParseError extends Error {
  readonly raw: string;
  readonly expect: number;

  constructor(raw: string, expect: number) {
    super(`千问返回 ${expect} 段的译文对不上（响应 ${raw.length} 字符）`);
    this.raw = raw;
    this.expect = expect;
    this.name = "QwenBatchParseError";
  }
}

/**
 * 构造 translation_options。
 * 目标语言必须是具体语言（"auto" 只对 source 合法），映射不到直接抛可读错误。
 */
export function buildQwenTranslationOptions(
  req: Pick<TranslateRequest, "from" | "to" | "terms" | "domains" | "tm">,
): Record<string, any> {
  const target = toQwenLang(req.to);
  if (!target || target === "auto") {
    throw new Error(`千问翻译不支持目标语言「${req.to || "空"}」`);
  }
  const source = toQwenLang(req.from) || "auto";
  const opts: Record<string, any> = { source_lang: source, target_lang: target };
  if (req.domains?.trim()) opts.domains = req.domains.trim();
  const terms = (req.terms || [])
    .map((term) => ({ source: (term?.source || "").trim(), target: (term?.target || "").trim() }))
    .filter((term) => term.source && term.target)
    .slice(0, MAX_TERMS);
  if (terms.length) opts.terms = terms;
  // 翻译记忆（tm_list）：整句级参考译法，与术语表分开传，模型按句优先复用
  const tm = (req.tm || [])
    .map((pair) => ({ source: (pair?.source || "").trim(), target: (pair?.target || "").trim() }))
    .filter((pair) => pair.source && pair.target)
    .slice(0, MAX_TERMS);
  if (tm.length) opts.tm_list = tm;
  return opts;
}

export class QwenMtTranslator implements Translator {
  readonly name = "qwen-mt" as const;

  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private generate: QwenGenerateFn;
  private backoffMs: number;

  constructor(cfg: QwenMtConfig, opts?: QwenMtOptions) {
    this.apiKey = (cfg.apiKey || "").trim();
    this.baseUrl = (cfg.baseUrl || DEFAULT_QWEN_BASE_URL).trim();
    this.model = (cfg.model || DEFAULT_QWEN_MT_MODEL).trim();
    this.generate = opts?.generate ?? ((o) => requestAIGenerate(o));
    this.backoffMs = opts?.backoffMs ?? 600;
  }

  /** 缓存按模型隔离：换模型必须重译，不能读到上一个模型的译文 */
  get cacheNs(): string {
    return `qwen-mt:${this.model}`;
  }

  get available(): boolean {
    return !!this.apiKey && !!this.baseUrl && !!this.model;
  }

  async translate(req: TranslateRequest): Promise<string[]> {
    if (!this.available) throw new Error("千问翻译未配置 API Key");
    const out: string[] = new Array(req.texts.length).fill("");
    let anyOk = false;
    let lastErr: unknown;

    for (const chunk of chunkForQwen(req.texts)) {
      if (req.signal?.aborted) break;
      const slice = chunk.map((i) => req.texts[i] || "");
      try {
        const parts = await this.callChunk(slice, req);
        chunk.forEach((idx, j) => {
          out[idx] = parts[j] || "";
        });
        anyOk = true;
      } catch (e) {
        if (!(e instanceof QwenBatchParseError)) {
          // 单片失败不连坐：保留其余分片的结果，失败段留空由窗口下一轮补译。
          // 旧实现直接抛出 → 整批作废，兜底引擎把全部段落重译一遍（双倍费用）。
          lastErr = e;
          continue;
        }
        // 段数对不上：逐段重译。整片只给一段时没有可拆的，留空即可。
        if (slice.length === 1) continue;
        for (let j = 0; j < slice.length; j++) {
          if (req.signal?.aborted) break;
          try {
            const one = await this.callChunk([slice[j]], req);
            out[chunk[j]] = one[0] || "";
            anyOk = true;
          } catch {
            // 单段失败留空：下次读到该段会自动重试，绝不把别的段落内容填进来
          }
        }
      }
    }
    // 一片都没成功才抛：让引擎链切到下家兜底（全空返回会被 translateWithFallback 忽略）
    if (!anyOk && lastErr) throw lastErr;
    return out;
  }

  private async callChunk(texts: string[], req: TranslateRequest): Promise<string[]> {
    const settings: EngineAiSettings = {
      enabled: true,
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      model: this.model,
      temperature: 0.1,
      maxTokens: 4096,
      systemPrompt: "",
      jsonMode: false,
    };
    const res = await this.request({
      settings,
      // Qwen-MT 只读 user 消息；段落之间用空行分隔，便于按段落拆回
      messages: [{ role: "user", content: texts.join("\n\n") }],
      jsonMode: false,
      timeout: 60000,
      signal: req.signal,
      extraBody: {
        translation_options: buildQwenTranslationOptions(req),
        // 专用翻译模型不接受采样参数：用 undefined 让 JSON.stringify 省略
        temperature: undefined,
        max_tokens: undefined,
      },
    });
    const parts = splitQwenBatch(res?.content || "", texts.length);
    if (!parts) throw new QwenBatchParseError(res?.content || "", texts.length);
    return parts;
  }

  /** 429 / 5xx / 网络异常做指数退避重试；401/400 等配置错误立即抛出 */
  private async request(opts: AiGenerateOptions, attempt = 0): Promise<AiGenerateResult> {
    try {
      return await this.generate(opts);
    } catch (e) {
      if (!retriable(e) || attempt >= 2 || opts.signal?.aborted) throw e;
      await new Promise((r) => setTimeout(r, this.backoffMs * Math.pow(3, attempt)));
      return this.request(opts, attempt + 1);
    }
  }
}
