/**
 * AI 翻译宿主服务（翻译链路的最后一环）
 * ---------------------------------------------------------------
 * ## 为什么需要这个文件
 *
 * `src/translate/` 下的引擎链（engine.ts / run.ts）与全部 provider
 * （腾讯/有道/百度/微软/LibreTranslate/AI）在拆插件时**都完整迁移过来了**，
 * 但**驱动它们的宿主能力没有**：
 *
 * - `EngineDeps.translateOne` / `translateBatch` 是注入进来的回调
 *   （`engine.ts:73-77`），主插件由 `ai/ai-translate.ts` 提供；
 * - 新插件的 `src/ai/` 只有 `ai-client.ts`（HTTP 传输层）
 *   与 `ai-settings.ts`（配置），**没有「拼prompt → 调模型 → 拆结果」这一层**。
 *
 * 结果：`index.ts` 里的 `translateBatch` 一直是空的，
 * `reader-tab.ts:166` 的 `self.plugin?.translateBatch?.()` 恒走空兜底，
 * **双语翻译完全不工作**。
 *
 * 本文件补上这一层，让引擎链的 AI 末端真正能跑。
 *
 * ## 与主插件的差异（有意为之，不要照抄主插件的 ai-translate.ts）
 *
 * 主插件的 `aiTranslateText` / `aiTranslateBatch` 有 800+ 行，因为主插件还要服务
 * 精读、对话、划线解释等场景，涉及多轮上下文、术语表注入、流式分块、Token 精算。
 * **阅读器插件只需要「把 N 段正文翻成中文」**，故此处只做最小可用实现：
 *
 * - 不做多轮（翻译是无状态的，一次请求给全量prompt）
 * - 不做流式（一批一段请求，返回即用）
 * - 不做 Token 精算（用量按字符数估算，仅用于配额告警的比例参考）
 *
 * 保留的：元数据注入（书名/作者/语言/目录）→ 提升术语一致性；
 * 模式切换（default / concise）→ 与主插件的提示词保持一致，
 * 否则用户切「精简」模式会发现译文风格没变。
 */
import { getLogger } from "../core/logger.ts";
import {
  DEFAULT_AI_SETTINGS,
  normalizeAiSettings,
} from "../ai/ai-settings.ts";
import { requestAIGenerate } from "../ai/ai-client.ts";
import type { AiSettings as EngineAiSettings } from "../ai/types.ts";
import { t } from "../i18n/index.ts";
import type { TranslateBatchMeta, TranslateBatchOpts } from "./run.ts";

/** 批量翻译的返回（与 run.ts 的 AiTranslateBatchFn 对齐） */
export type AiBatchResult = string[];

/**
 * 构造翻译用的 prompt。
 *
 * 分三段（与主插件 DEFAULT_TRANSLATE_PROMPT 的意图一致，但措辞简化）：
 *   ① 角色与硬约束（只译正文、不加解释、不输出 Markdown）
 *   ② 书籍元数据（有则给，帮助处理专名与文体）
 *   ③ 术语表（用户自定义词条）
 *
 * 关键约束：**明确要求「一行一段、段间用固定分隔符」**。
 * 模型很爱加「译文：」「以下是翻译」这类前后缀，
 * `sanitizeTranslation` 能拦一部分，但 prompt 里先约束住更省事。
 */
function buildTranslatePrompt(
  texts: string[],
  from: string,
  to: string,
  meta: TranslateBatchMeta | null | undefined,
  ctxBefore: (string | null)[] | undefined,
  mode: "default" | "concise",
  glossary?: Readonly<Record<string, string>>,
): string {
  const langName = (code: string): string => {
    const m: Record<string, string> = {
      auto: "自动检测", en: "英语", zh: "简体中文", ja: "日语", ko: "韩语",
      fr: "法语", de: "德语", es: "西班牙语", ru: "俄语", pt: "葡萄牙语",
    };
    return m[code] || code;
  };

  const sys: string[] = [
    `你是专业电子书翻译引擎。把原文译成${langName(to)}，只输出译文本身。`,
    ``,
    `硬性要求：`,
    `1. 严格保留原文的段落划分：第 N 段输出第 N 段，**不要合并或拆分段落**。`,
    `2. 禁止添加任何解释、注解、序号、引号包裹或「译文：」之类的前缀。`,
    `3. 禁止输出 Markdown 标记（#、**、--- 等）。`,
    `4. 专有名词、书名、人名保持原文或采用通行译法，不要音译生造。`,
  ];

  if (mode === "concise") {
    sys.push(`5. 采用简洁译法：能用四字格/短句的地方不展开，删去冗余修饰。`);
  }

  // 元数据：帮助模型统一术语与文体
  if (meta && (meta.title || meta.author || meta.language)) {
    const bits: string[] = [];
    if (meta.title) bits.push(`书名《${meta.title}》`);
    if (meta.author) bits.push(`作者 ${meta.author}`);
    if (meta.language) bits.push(`原文语言 ${meta.language}`);
    sys.push(``, `书籍背景（有助于统一术语与文体）：${bits.join("，")}。`);
  }

  // 术语表：强制指定译法，优先于模型自己的偏好
  const terms = Object.entries(glossary || {}).slice(0, 120);
  if (terms.length) {
    sys.push(
      ``,
      `术语表（必须严格遵守，译法与下表不一致时以本表为准）：`,
      ...terms.map(([k, v]) => `  ${k} → ${v}`),
    );
  }

  const user: string[] = [`请翻译以下 ${texts.length} 个段落。`];

  // 前文参考：只在有值时给（供模型理解语境，无需翻译）
  if (ctxBefore?.some((c) => !!c?.trim())) {
    const idx = ctxBefore.findIndex((c) => !!c?.trim());
    if (idx >= 0) {
      user.push(``, `前文（供理解语境，**不要翻译**）：${ctxBefore[idx]!.trim()}`);
    }
  }

  user.push(
    ``,
    `原文（源语言：${langName(from)}）：`,
    ...texts.map((x, i) => `[${i + 1}] ${x}`),
    ``,
    `译文（${langName(to)}）：`,
  );

  return `${sys.join("\n")}\n\n---\n\n${user.join("\n")}`;
}

/**
 * 拆解批量响应。
 *
 * 模型被要求「一行一段」，但仍可能返回：
 *   - 编号前缀（`1. xxx`）
 *   - 围栏包裹（``` … ```）
 *   - 段间空行
 *   - 前后的「译文：」标题行
 *
 * 这里做**逐段宽松匹配**：优先按 `[n]` 编号切，退化到按非空行切，
 * 都失败则把整体返回单条（宁可只译一段，也不要丢内容）。
 */
export function splitTranslateResponse(raw: string, expect: number): string[] {
  const text = (raw || "").trim();
  if (!text) return [];
  if (expect <= 1) return [text.replace(/^```[\w]*\n?|\n?```$/g, "").trim()];

  // 去掉可能的代码围栏
  let body = text.replace(/^```[\w]*\n?/, "").replace(/\n?```$/, "").trim();

  // 路径①：带 [n] 或 n. 编号
  // ⚠️ split 的**第一段不含分隔符**（`"[1] a\n[2] b"` 切出 `["[1] a", "[2] b"]`），
  // 所以必须对每段都跑一次剥编号，否则第一段会带着 "[1] " 前缀进译文。
  const stripNo = (s: string): string => s.replace(/^\s*(?:\[\s*\d+\s*\]|\d+\s*[.、)])\s*/, "").trim();
  const numbered = body
    .split(/\n\s*(?:\[\s*\d+\s*\]|\d+\s*[.、)])\s*/)
    .map(stripNo)
    .filter(Boolean);
  if (numbered.length >= expect) {
    return numbered.slice(0, expect);
  }

  // 路径②：按非空行切
  const lines = body.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (lines.length >= expect) return lines.slice(0, expect);

  // 路径③：整体当一条
  return [body];
}

/** 宿主侧的 AI 翻译服务（每个插件实例一份） */
export class AiTranslateService {
  /** 插件实例（读设置 / 落盘） */
  private plugin: any;
  /** 读AI 设置（含各引擎凭据与用量计数） */
  private readSettings: () => any;
  /** 读术语表（可选，缺失则不注入） */
  private readGlossary?: () => Readonly<Record<string, string>> | undefined;
  /** 本轮实际消耗字符（供上层累计用量） */
  private lastSubmitChars = 0;

  constructor(
    plugin: any,
    readSettings: () => any,
    readGlossary?: () => Readonly<Record<string, string>> | undefined,
  ) {
    this.plugin = plugin;
    this.readSettings = readSettings;
    this.readGlossary = readGlossary;
  }

  /** 本轮提交的字符数（引擎链调用后读取，用于配额统计） */
  get lastChars(): number {
    return this.lastSubmitChars;
  }

  /**
   * 翻译用的 AI 窄设置。
   *
   * **注意有两个同名 AiSettings**（踩过的坑）：
   *   - `ai/types.ts` 的：给 `ai-client.ts` 用的传输层窄形状（含 systemPrompt）
   *   - `ai/ai-settings.ts` 的：完整用户配置（有一堆引擎凭据字段）
   * `requestAIGenerate` 要的是**前者**。故这里显式声明结构，
   * 不从任一 AiSettings extends，避免「继承到错误的那份」。
   */
  private toEngineSettings(raw: any): EngineAiSettings {
    // 走 any：`translateModel` / `translatePrompt` 是完整配置才有的字段，
    // 而 normalizeAiSettings 的返回类型是 `ai/ai-settings.ts` 的 AiSettings，
    // 它的声明里没有 translateModel（那个文件只管全局 model）。
    // 运行时字段确实在（host.ts 的 normalizeTranslateSettings 会填），
    // 这里只是 TS 看不到，用 any 读一次并注释说明来由。
    const s: any = normalizeAiSettings(raw || {});
    const model = s.translateModel || s.model || DEFAULT_AI_SETTINGS.model;
    return {
      enabled: s.enabled !== false,
      baseUrl: s.baseUrl || "",
      apiKey: s.apiKey || "",
      model,
      temperature: 0.2,
      maxTokens: s.maxTokens || 4096,
      systemPrompt: s.translatePrompt || DEFAULT_AI_SETTINGS.translatePrompt || "",
      jsonMode: false,
    };
  }

  /**
   * 翻译单条（`EngineDeps.translateOne` 的实现）。
   *
   * 失败时**抛异常**（引擎链会 catch 并回退到下一个 provider），
   * 不返回空串 —— 返回空串会被 `translateWithFallback` 判为「译文无效」
   * 继续回退，但会丢掉原始错误信息。
   */
  async translateOne(text: string, from: string, to: string, _bookId?: string): Promise<string> {
    this.lastSubmitChars = text.length;
    const prompt = buildTranslatePrompt(
      [text], from, to, null, undefined, "default", this.readGlossary?.(),
    );
    const settings = this.toEngineSettings(this.readSettings());
    if (!settings.baseUrl || !settings.apiKey) {
      throw new Error(t("AI 翻译未配置（缺少 baseUrl 或 API Key）"));
    }
    const res = await requestAIGenerate({
      settings,
      messages: [{ role: "user", content: prompt }],
      jsonMode: false,
      timeout: 60000,
    });
    const out = (res?.content || "").trim();
    if (!out) throw new Error(t("AI 翻译返回空内容"));
    return splitTranslateResponse(out, 1)[0] || out;
  }

  /**
   * 翻译一批（`EngineDeps.translateBatch` 的实现）。
   *
   * **分片发送**：一次请求塞几十段会被截断（`max_tokens` 限制），
   * 也会让模型混淆段落对应关系。故按 `CHUNK` 切片，逐片请求后拼接。
   */
  async translateBatch(
    texts: string[],
    from: string,
    to: string,
    _bookId?: string,
    ctxBefore?: (string | null)[],
    meta?: TranslateBatchMeta | null,
    opts?: TranslateBatchOpts,
  ): Promise<AiBatchResult> {
    this.lastSubmitChars = texts.reduce((n, x) => n + (x?.length || 0), 0);
    const mode = opts?.mode === "concise" ? "concise" : "default";
    const glossary = this.readGlossary?.();
    const settings = this.toEngineSettings(this.readSettings());
    if (!settings.baseUrl || !settings.apiKey) {
      throw new Error(t("AI 翻译未配置（缺少 baseUrl 或 API Key）"));
    }

    // 单片大小：实测 8 段/ 片较稳（过大会截断，过小则请求数过多）
    const CHUNK = 8;
    const out: string[] = [];
    for (let i = 0; i < texts.length; i += CHUNK) {
      const slice = texts.slice(i, i + CHUNK);
      const ctx = ctxBefore?.slice(i, i + CHUNK);
      const prompt = buildTranslatePrompt(slice, from, to, meta, ctx, mode, glossary);
      getLogger().debug?.(`[RE 阅读器] AI 翻译第 ${out.length + 1}~${out.length + slice.length} 段`);
      const res = await requestAIGenerate({
        settings,
        messages: [{ role: "user", content: prompt }],
        jsonMode: false,
        timeout: 90000,
      });
      const parsed = splitTranslateResponse(res?.content || "", slice.length);
      // 分片数对不上时（模型少给/多给）：按位置补空，绝不整体丢弃已译内容
      for (let k = 0; k < slice.length; k++) out.push(parsed[k] ?? "");
    }
    return out;
  }
}
