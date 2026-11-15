/**
 * 通用大模型翻译（任意 OpenAI 兼容端点）
 * ------------------------------------------------------------------
 * 与千问 MT 的区别：它不是专用翻译模型，所以要走普通 chat + system 提示词：
 *  - 语言、术语、领域、翻译记忆都写进 system prompt；
 *  - 段落之间用空行分隔，要求模型原样保持段数与顺序；
 *  - 返回段数对不上时逐段重译，绝不按位置硬摊（与千问同一策略）。
 *
 * 适用：DeepSeek / GPT / 自建网关等用户已付费的模型；质量通常高于机翻，
 * 但单价与延迟也更高，故在「自动」链里排在千问 MT 之后、腾讯之前。
 *
 * 注意：不要在这里塞「请只输出译文」以外的输出格式要求（比如 JSON）——
 * 模型偶发加编号/解释会破坏段落对齐，解析侧虽有编号剥离，仍以少约束为宜。
 */
import type { Translator, TranslateRequest, TranslateTerm } from "../types.ts";
import {
  requestAIGenerate,
  type AiGenerateOptions,
  type AiGenerateResult,
} from "../../ai/ai-client.ts";
import type { AiSettings as EngineAiSettings } from "../../ai/types.ts";
import { toQwenLang } from "../lang-names.ts";
import { chunkTexts, isRetriable as retriable, splitBatch } from "./batch.ts";

/** 通用端点默认值：留空要求用户显式填写（各家 baseUrl 不同，猜一个会误导） */
export const DEFAULT_OPENAI_BASE_URL = "";
/** 默认模型：不预设，避免「配了 key 却用了一个该网关没有的模型」 */
export const DEFAULT_OPENAI_MODEL = "";

const MAX_CHARS_PER_REQUEST = 4000;
const MAX_SEGMENTS_PER_REQUEST = 10;
const MAX_PROMPT_TERMS = 60;

export type OpenAiGenerateFn = (opts: AiGenerateOptions) => Promise<AiGenerateResult>;

export interface OpenAiCompatConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

export interface OpenAiCompatOptions {
  /** 测试注入用；生产缺省 requestAIGenerate */
  generate?: OpenAiGenerateFn;
  /** 重试退避基数（毫秒；测试可调小） */
  backoffMs?: number;
}

/** 批量返回与输入段数不一致：上层逐段兜底 */
export class OpenAiBatchParseError extends Error {
  readonly raw: string;
  readonly expect: number;

  constructor(raw: string, expect: number) {
    super(`模型返回 ${expect} 段的译文对不上（响应 ${raw.length} 字符）`);
    this.raw = raw;
    this.expect = expect;
    this.name = "OpenAiBatchParseError";
  }
}

function langName(code: string, fallback: string): string {
  return toQwenLang(code) || fallback;
}

/** 把术语 / 翻译记忆渲染成提示词条目 */
function pairLines(pairs: TranslateTerm[] | undefined, max: number): string[] {
  return (pairs || [])
    .map((p) => `${(p?.source || "").trim()} => ${(p?.target || "").trim()}`)
    .filter((line) => !line.startsWith("=>") && !line.endsWith("=>"))
    .slice(0, max);
}

/** 构造 system 提示词（纯函数，便于单测） */
export function buildOpenAiSystemPrompt(req: Pick<TranslateRequest, "from" | "to" | "terms" | "tm" | "domains">): string {
  const src = req.from && req.from !== "auto" ? langName(req.from, req.from) : "the source language";
  const dst = langName(req.to, req.to);
  const lines = [
    `You are a professional literary translator. Translate each paragraph from ${src} to ${dst}.`,
    "Rules:",
    "- Output ONLY the translations, one per input paragraph, separated by a blank line.",
    "- Keep the original paragraph order and count. Never merge or split paragraphs.",
    "- Do not add numbering, explanations, notes, or quotation marks.",
    "- Preserve names, numbers, and inline formatting unless a glossary says otherwise.",
  ];
  if (req.domains?.trim()) {
    lines.push(`- Domain: ${req.domains.trim()}. Prefer terminology natural to this domain.`);
  }
  const terms = pairLines(req.terms, MAX_PROMPT_TERMS);
  if (terms.length) {
    lines.push("Glossary (use these translations exactly):", ...terms.map((t) => `- ${t}`));
  }
  const tm = pairLines(req.tm, MAX_PROMPT_TERMS);
  if (tm.length) {
    lines.push("Translation memory (prefer these renderings when the sentence matches):", ...tm.map((t) => `- ${t}`));
  }
  return lines.join("\n");
}

export class OpenAiCompatTranslator implements Translator {
  readonly name = "openai-compat" as const;

  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private generate: OpenAiGenerateFn;
  private backoffMs: number;

  constructor(cfg: OpenAiCompatConfig, opts?: OpenAiCompatOptions) {
    this.apiKey = (cfg.apiKey || "").trim();
    this.baseUrl = (cfg.baseUrl || DEFAULT_OPENAI_BASE_URL).trim();
    this.model = (cfg.model || DEFAULT_OPENAI_MODEL).trim();
    this.generate = opts?.generate ?? ((o) => requestAIGenerate(o));
    this.backoffMs = opts?.backoffMs ?? 600;
  }

  /** 缓存按模型隔离：换模型必须重译 */
  get cacheNs(): string {
    return `openai:${this.model}`;
  }

  get available(): boolean {
    return !!this.apiKey && !!this.baseUrl && !!this.model;
  }

  async translate(req: TranslateRequest): Promise<string[]> {
    if (!this.available) throw new Error("通用大模型翻译未配置（需要接口地址、API Key 与模型名）");
    const out: string[] = new Array(req.texts.length).fill("");

    for (const chunk of chunkTexts(req.texts, MAX_CHARS_PER_REQUEST, MAX_SEGMENTS_PER_REQUEST)) {
      if (req.signal?.aborted) break;
      const slice = chunk.map((i) => req.texts[i] || "");
      try {
        const parts = await this.callChunk(slice, req);
        chunk.forEach((idx, j) => {
          out[idx] = parts[j] || "";
        });
      } catch (e) {
        if (!(e instanceof OpenAiBatchParseError)) throw e;
        if (slice.length === 1) continue;
        for (let j = 0; j < slice.length; j++) {
          if (req.signal?.aborted) break;
          try {
            const one = await this.callChunk([slice[j]], req);
            out[chunk[j]] = one[0] || "";
          } catch {
            // 单段失败留空：下次读到该段自动重试，绝不填别的段落内容
          }
        }
      }
    }
    return out;
  }

  private async callChunk(texts: string[], req: TranslateRequest): Promise<string[]> {
    const settings: EngineAiSettings = {
      enabled: true,
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      model: this.model,
      temperature: 0.2,
      maxTokens: 4096,
      systemPrompt: "",
      jsonMode: false,
    };
    const res = await this.request({
      settings,
      messages: [
        { role: "system", content: buildOpenAiSystemPrompt(req) },
        { role: "user", content: texts.join("\n\n") },
      ],
      jsonMode: false,
      timeout: 90000,
      signal: req.signal,
    });
    const parts = splitBatch(res?.content || "", texts.length);
    if (!parts) throw new OpenAiBatchParseError(res?.content || "", texts.length);
    return parts;
  }

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
