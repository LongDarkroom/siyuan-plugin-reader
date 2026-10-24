import { logSwallow } from "../core/safe.ts";
import { getLogger } from "../core/logger.ts";
/**
 * AI 请求客户端
 * ------------------------------------------------------------------
 * 核心适配自 Achuan-2/siyuan-plugin-copilot（reword 中已二次裁剪）。
 *  - 通过 SiYuan 内核代理 /api/network/forwardProxy 转发请求（绕开前端 CORS）。
 *  - 兼容 OpenAI 兼容端点的非流式 JSON 与 SSE 流式两种返回。
 *
 * 为便于单测，所有网络行为收敛到 AiTransport 接口；生产用 forwardProxyFetch，
 * 测试可注入内存 mock。
 */
import type { AiSettings, AiTransportMode } from "./types.ts";
import { t as T } from "../i18n/index.ts";

export type AiRole = "system" | "user" | "assistant";

export interface AiMessage {
  role: AiRole;
  content: string;
  /** 2026-09-08：用户消息展开后的正文（占位符已替换为块/文档正文），用于多轮发送上下文；
   *  历史恢复时可能缺失，发送前若仍含占位符则兜底展开 */
  expandedContent?: string;
}

/** token 用量（部分服务商返回；缺失则 undefined） */
export interface AiUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/** 传输层请求（与 fetch 入参对齐） */
export interface AiTransportRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  timeout: number;
  /** 取消信号（停止生成用；内核代理转发实际无法中断底层 HTTP，仅标记用） */
  signal?: AbortSignal;
}

/** 传输层响应 */
export interface AiTransportResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
}

/** 可注入的传输实现（生产 = forwardProxyFetch，测试 = mock） */
export type AiTransport = (req: AiTransportRequest) => Promise<AiTransportResponse>;

export interface AiGenerateOptions {
  messages: AiMessage[];
  settings: AiSettings;
  jsonMode?: boolean;
  timeout?: number;
  /** 取消信号（停止生成用） */
  signal?: AbortSignal;
}

export interface AiGenerateResult {
  content: string; // 抽取出的正文
  raw: string; // 原始返回
  model?: string;
  /** 思考/推理过程（reasoning_content，可选） */
  reasoning?: string;
  /** 输出被 max_tokens 截断（finish_reason === "length"） */
  truncated?: boolean;
  /** token 用量（部分服务商返回；缺失则 undefined） */
  usage?: AiUsage;
}

/** 流式生成请求参数 */
export interface AiStreamOptions {
  messages: AiMessage[];
  settings: AiSettings;
  jsonMode?: boolean;
  timeout?: number;
  /** 取消信号（停止生成用） */
  signal?: AbortSignal;
  /** 每收到一个增量片段回调（已解码的 delta.content） */
  onToken?: (chunk: string) => void;
  /** 每收到一个推理增量片段回调（reasoning_content，可驱动「思考中」折叠面板） */
  onReasoning?: (chunk: string) => void;
}

/** 流式生成结果 */
export interface AiStreamResult {
  ok: boolean;
  content: string; // 完整正文（流式时已累积）
  model?: string;
  error?: string;
  /** 思考/推理过程（reasoning_content，可选） */
  reasoning?: string;
  /** 因 signal 中断而结束（content 为已生成的部分内容） */
  aborted?: boolean;
  /** 因 max_tokens 上限被服务端截断（finish_reason === "length"） */
  truncated?: boolean;
  /** token 用量统计（流式末端 chunk 携带，可选） */
  usage?: AiUsage;
  /** 是否走了内核代理缓冲回退（直连 CORS/网络失败）：UI 可据此提示「缓冲模式」 */
  buffered?: boolean;
}

/**
 * 端点归一化（改编自 copilot 的 j1 函数）。
 * 无论用户填 `https://api.openai.com/v1`、`https://api.deepseek.com`
 * 还是完整 `.../chat/completions`，都收敛为可用的 chat 补全地址。
 */
export function buildChatUrl(baseUrl: string): string {
  const raw = (baseUrl || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  if (/\/chat\/completions$/i.test(raw)) return raw;
  if (/\/messages$/i.test(raw)) return raw;
  if (/\/v1$/i.test(raw)) return raw + "/chat/completions";
  if (/\/v1\/$/i.test(raw)) return raw + "chat/completions";
  if (/\/v1\//i.test(raw)) {
    if (/\/v1\/(models|embeddings|completions)$/i.test(raw)) {
      return raw.replace(/\/(models|embeddings|completions)$/i, "/chat/completions");
    }
    return raw;
  }
  return raw + "/v1/chat/completions";
}

/** 构造 OpenAI 兼容请求体 */
export function buildRequestBody(
  messages: AiMessage[],
  settings: AiSettings,
  jsonMode: boolean
): Record<string, any> {
  // 注：T6 的「按模型覆写参数」不在这里做 —— 本函数是翻译等其他路径的共用入口，
  // 那些路径会显式指定 temperature（如 trTemperature），覆写会把它们盖掉。
  // 覆写只在精读/对话的窄化点 toEngineSettings 生效。
  const body: Record<string, any> = {
    model: settings.model,
    messages: messages,
    temperature: settings.temperature,
    max_tokens: settings.maxTokens,
    stream: false,
  };
  // 采样参数：仅在显式配置时透传（0 也是合法值，用 != null 判断避免被忽略）
  if (settings.topP != null) body.top_p = settings.topP;
  if (settings.frequencyPenalty != null) body.frequency_penalty = settings.frequencyPenalty;
  if (settings.presencePenalty != null) body.presence_penalty = settings.presencePenalty;
  if (jsonMode) {
    body.response_format = { type: "json_object" };
  }
  return body;
}

/**
 * 从响应正文抽取 AI 文本与思考过程。
 *  - SSE：累加 choices[].delta.content，同时累加 choices[].delta.reasoning_content（思考链）。
 *  - 普通 JSON：取 choices[].message.content 与 choices[].message.reasoning_content。
 *  - 其余：原样返回 content（兜底）。
 * 返回 { content, reasoning }，reasoning 缺失时为 undefined。
 */
export function extractContentFromBody(raw: string): { content: string; reasoning?: string } {
  const trimmed = (raw || "").trim();
  if (!trimmed) return { content: "" };

  const looksSse = trimmed.startsWith("data:") || /\r?\ndata:/.test(trimmed);
  if (looksSse) {
    let acc = "";
    let reason = "";
    const lines = trimmed.split(/\r?\n/);
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const obj = JSON.parse(payload);
        const delta = obj?.choices?.[0]?.delta;
        if (delta) {
          if (typeof delta.content === "string") acc += delta.content;
          if (typeof delta.reasoning_content === "string") reason += delta.reasoning_content;
        } else {
          const msg = obj?.choices?.[0]?.message;
          if (msg && typeof msg.content === "string") acc += msg.content;
          if (msg && typeof msg.reasoning_content === "string") reason += msg.reasoning_content;
        }
      } catch (__swallowErr) { logSwallow(__swallowErr, "ai-client.ts · extractContentFromBody", "debug"); }
    }
    if (acc || reason) return { content: acc, reasoning: reason || undefined };
  }

  try {
    const obj = JSON.parse(trimmed);
    const msg = obj?.choices?.[0]?.message;
    let content = "";
    let reasoning: string | undefined;
    if (msg && typeof msg.content === "string") content = msg.content;
    else if (typeof obj?.content === "string") content = obj.content;
    if (msg && typeof msg.reasoning_content === "string") reasoning = msg.reasoning_content;
    return { content: content || trimmed, reasoning };
  } catch (__swallowErr) { logSwallow(__swallowErr, "ai-client.ts · try { const obj = JSON.parse(trimmed); const msg = obj?.choices…", "debug"); }
  return { content: trimmed };
}

/**
 * 从响应正文解析 token 用量（OpenAI 兼容 usage 字段）。
 * 部分服务商（如 DeepSeek）也返回 `usage`，字段名为 prompt_tokens /
 * completion_tokens / total_tokens。SSE 流式时取最后一个含 usage 的 data 帧。
 * 解析失败返回 undefined（调用方不显示用量）。
 */
export function extractUsageFromBody(raw: string): AiUsage | undefined {
  const trimmed = (raw || "").trim();
  if (!trimmed) return undefined;

  const parseUsage = (obj: any): AiUsage | undefined => {
    const u = obj?.usage;
    if (!u || typeof u !== "object") return undefined;
    const pt = typeof u.prompt_tokens === "number" ? u.prompt_tokens : (typeof u.promptTokens === "number" ? u.promptTokens : 0);
    const ct = typeof u.completion_tokens === "number" ? u.completion_tokens : (typeof u.completionTokens === "number" ? u.completionTokens : 0);
    const tt = typeof u.total_tokens === "number" ? u.total_tokens : (typeof u.totalTokens === "number" ? u.totalTokens : pt + ct);
    if (!pt && !ct && !tt) return undefined;
    return { promptTokens: pt, completionTokens: ct, totalTokens: tt };
  };

  // SSE：逐帧解析，保留最后一个带 usage 的帧
  if (trimmed.startsWith("data:") || /\r?\ndata:/.test(trimmed)) {
    let last: AiUsage | undefined;
    for (const line of trimmed.split(/\r?\n/)) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const u = parseUsage(JSON.parse(payload));
        if (u) last = u;
      } catch (__swallowErr) { logSwallow(__swallowErr, "ai-client.ts · try { const u = parseUsage(JSON.parse(payload)); if (u) last = …", "debug"); }
    }
    return last;
  }

  // 普通 JSON
  try {
    return parseUsage(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

/**
 * 粗略估算文本 token 数（无本地 tiktoken 时按字符加权）。
 * 中文/日文/韩文按约 2 字符/token，英文按约 4 字符/token，空白与标点折半。
 * 结果仅供 UI 提示，不用于计费。
 */
export function estimateTokens(text: string): number {
  const t = text || "";
  if (!t) return 0;
  let chars = 0;
  let cjk = 0;
  let whitespace = 0;
  for (const ch of t) {
    const code = ch.codePointAt(0) || 0;
    const isCjk = (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3040 && code <= 0x309f) ||
      (code >= 0x30a0 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0x3400 && code <= 0x4dbf);
    if (isCjk) cjk++;
    else if (/\s/.test(ch)) whitespace++;
    chars++;
  }
  const nonCjkNonSpace = Math.max(0, chars - cjk - whitespace);
  const est = Math.round(cjk / 2 + whitespace / 4 + nonCjkNonSpace / 4 + (chars > 0 ? 2 : 0));
  return Math.max(1, est);
}

/** 生产传输：经 SiYuan 内核代理转发（siyuan 仅在此处按需动态加载，避免测试环境静态依赖） */
/**
 * 从 AI 服务的错误响应里提取「可读的真实原因」。
 *
 * 2026-10-06：此前直接把响应体前 300 字塞进错误消息，导致用户看到的是
 * 服务商返回的**营销/引导文案**（如「插件初始化失败，请稍候再试」「月卡独立可用，
 * 永久可用」这类与本插件无关的推销话术），完全无法判断真实问题。
 * 这里改为：优先取标准 JSON 里的 `error.message` / `message`；
 * 取不到则按 HTTP 状态给出可行动的提示；最后才回落到原文截断。
 */
function extractApiError(raw: string, status: number): string {
  const text = (raw || "").trim();

  // 1) 优先解析标准错误结构
  if (text) {
    try {
      const j = JSON.parse(text);
      const msg = j?.error?.message ?? j?.error ?? j?.message;
      if (typeof msg === "string" && msg.trim()) {
        // 带上 code 便于用户反馈（如 invalid_api_key / insufficient_quota）
        const code = typeof j?.error?.code === "string" ? j.error.code : "";
        const type = typeof j?.error?.type === "string" ? j.error.type : "";
        const tag = code || type ? ` [${code || type}]` : "";
        return `${msg.trim()}${tag}`.slice(0, 300);
      }
    } catch {
      /* 非 JSON（如纯文本 / HTML 错误页）→ 走下面 */
    }
    // 2) 非 JSON 但短且像一句话：可用（限长，避免整页 HTML）
    if (text.length <= 200 && !/^<|^\{|^\[/.test(text)) {
      return text;
    }
  }

  // 3) 按状态码给可行动提示（比服务商文案有用得多）
  const HINTS: Record<number, string> = {
    401: T("API Key 无效或已过期（请在设置里检查密钥）"),
    402: T("账户余额不足或订阅已过期"),
    403: T("当前密钥无权访问该模型（请检查模型名与密钥权限）"),
    404: T("接口地址或模型名不存在（请检查 Base URL）"),
    408: T("请求超时（请稍后重试或调大超时时间）"),
    413: T("请求内容过长（请缩短选段或分批翻译）"),
    429: T("请求过于频繁（已触发限流，请稍后重试）"),
    500: T("服务内部错误（服务商侧问题，请稍后重试）"),
    502: T("服务网关错误（服务商不可用，请稍后重试）"),
    503: T("服务暂不可用（请稍后重试）"),
    504: T("服务网关超时（请稍后重试）"),
  };
  if (HINTS[status]) return HINTS[status];
  if (status >= 500) return T("服务异常（HTTP {status}），请稍后重试", { status });

  // 4) 兜底：截断原文（去掉 HTML 标签，避免刷屏）
  return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) ||
    T("未知错误（HTTP {status}）", { status });
}

export const forwardProxyFetch: AiTransport = async (req: AiTransportRequest) => {
  // 注意：原 copilot 插件的 api/siyuan.ts 兼容 shim 已删除，此处直接动态加载唯一枢纽
  // src/siyuan/api.ts 的 forwardProxyRaw，并内联其对象式返回值（与旧 shim 行为一致）。
  // 动态加载是为避免测试环境对 siyuan 内核 API 的静态依赖。
  //
  // 2026-10-06 健壮性：动态 import 的解构结果**必须校验**。
  // 此前直接 `const { forwardProxyRaw } = await import(...)` 后就调用，若模块加载失败
  // 或导出缺失会抛 `forwardProxyRaw is not a function`，该异常一路冒泡到 UI，
  // 报出 `TypeError: this.xxx is not a function` 这类**指向不明**的压缩变量名，
  // 极难定位（产物已压缩，函数名全是 it1Bm10 之类）。这里显式校验并抛出可读错误。
  const mod: any = await import("../siyuan/api.ts");
  const forwardProxyRaw = mod?.forwardProxyRaw;
  if (typeof forwardProxyRaw !== "function") {
    throw new Error(
      T("内核代理不可用：未能加载 forwardProxy（思源内核版本过低或模块加载失败）"),
    );
  }
  const r = await forwardProxyRaw({
    url: req.url,
    method: req.method || "POST",
    timeout: req.timeout || 60000,
    headers: req.headers || {},
    payload: req.body || "",
  });
  return { status: r.status, headers: r.headers, body: r.body };
};

/**
 * 端点归一化：把用户填的各种形态收敛为 `{base}/models` 列表端点。
 *
 * 与 buildChatUrl 同构但独立实现 —— 两者归一化的**目标后缀不同**
 * （一个要 chat/completions，一个要 models），共用一个函数会多出一堆
 * 「先归一到 chat 再换后缀」的转换，反而更难读。
 *
 * 覆盖的输入形态（用户真的会这么填）：
 *   https://api.openai.com          → https://api.openai.com/v1/models
 *   https://api.openai.com/v1       → https://api.openai.com/v1/models
 *   https://api.openai.com/v1/      → 同上
 *   .../v1/chat/completions         → .../v1/models
 *   .../v1/models                  → 原样
 *   .../v1                         → .../v1/models
 *   （空）                          → ""（调用方应先校验）
 */
export function buildModelsUrl(baseUrl: string): string {
  const raw = (baseUrl || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  if (/\/models$/i.test(raw)) return raw;
  if (/\/chat\/completions$/i.test(raw)) {
    return raw.replace(/\/chat\/completions$/i, "/models");
  }
  if (/\/messages$/i.test(raw)) return raw.replace(/\/messages$/i, "/models");
  if (/\/v1$/i.test(raw)) return raw + "/models";
  // 形如 .../v1/xxx（既不是 models 也不是 chat）→ 取到 /v1 为止再补 models
  if (/\/v1\//i.test(raw)) return raw.replace(/\/v1\/.*$/i, "/v1/models");
  return raw + "/v1/models";
}

/**
 * 拉取服务端可用的模型列表（OpenAI 兼容的 `GET /v1/models`）。
 *
 * ## 为什么要它
 *
 * 翻译设置里的「模型」原先是**自由文本框**，让用户手打 `gpt-4o-mini`。
 * 问题：① 不知道该服务商有哪些模型；② 模型名拼错要等到翻译失败才发现；
 * ③ 各家命名差异大（`gpt-4o-mini` / `deepseek-chat` / `claude-3-5-sonnet`…）。
 *
 * ## 容错策略（重要）
 *
 * **拉取失败不阻断配置流程**。不少服务商/代理不实现 `GET /v1/models`
 * （或需要额外 header），此时应退回「手填模型名」。
 * 故本函数只在网络/解析失败时抛错，由调用方决定降级策略。
 *
 * @param baseUrl 服务商地址（形态任意，见 buildModelsUrl）
 * @param apiKey  Bearer key
 * @returns 模型 id 数组（去重 + 按字母序，保证下拉顺序稳定）
 */
export async function fetchModelList(
  baseUrl: string,
  apiKey: string,
  transport: AiTransport = forwardProxyFetch,
  timeout = 20000,
): Promise<string[]> {
  const url = buildModelsUrl(baseUrl);
  if (!url) throw new Error(T("接口地址为空"));
  if (!apiKey) throw new Error(T("API Key 为空"));

  const headers: Record<string, string> = { Accept: "application/json" };
  headers["Authorization"] = `Bearer ${apiKey}`;

  const res = await transport({ url, method: "GET", headers, body: "", timeout });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(T("获取模型列表失败（HTTP {status}）：{body}", {
      status: res.status,
      body: extractApiError(res.body, res.status),
    }));
  }

  let json: any;
  try {
    json = JSON.parse(res.body || "");
  } catch {
    throw new Error(T("模型列表响应不是合法 JSON（该服务商可能不支持此接口）"));
  }
  // OpenAI 兼容形状：{ object: "list", data: [{ id, object, ... }] }
  const arr: unknown[] = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
  const ids = arr
    .map((m: any) => (typeof m === "string" ? m : typeof m?.id === "string" ? m.id : ""))
    .map((s: string) => s.trim())
    .filter(Boolean);
  if (!ids.length) throw new Error(T("该接口未返回任何模型"));
  // 去重 + 排序：保证同一服务商每次打开下拉的顺序一致（避免随机跳动）
  return Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b));
}

/**
 * 执行一次 AI 生成。transport 缺省走 forwardProxyFetch。
 * 任何非 2xx 或网络异常都会抛出，由调用方决定降级。
 */
export async function requestAIGenerate(
  opts: AiGenerateOptions,
  transport: AiTransport = forwardProxyFetch
): Promise<AiGenerateResult> {
  const settings = opts.settings;
  const url = buildChatUrl(settings.baseUrl);
  if (!url) throw new Error(T("AI baseUrl 为空或无法解析为 chat 端点"));

  const body = buildRequestBody(opts.messages, settings, opts.jsonMode ?? settings.jsonMode);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (settings.apiKey) headers["Authorization"] = `Bearer ${settings.apiKey}`;

  const res = await transport({
    url,
    method: "POST",
    headers,
    body: JSON.stringify(body),
    timeout: opts.timeout ?? 60000,
    signal: opts.signal,
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(T("AI 请求失败（HTTP {status}）：{body}", {
      status: res.status,
      body: extractApiError(res.body, res.status),
    }));
  }

  const { content, reasoning } = extractContentFromBody(res.body);
  let model: string | undefined;
  let usage: AiUsage | undefined;
  let truncated = false;
  try {
    const bodyText = res.body || "";
    const j = bodyText.trim() ? JSON.parse(bodyText) : {};
    if (typeof j?.model === "string") model = j.model;
    if (j?.usage) {
      usage = {
        promptTokens: j.usage.prompt_tokens,
        completionTokens: j.usage.completion_tokens,
        totalTokens: j.usage.total_tokens,
      };
    }
    if (j?.choices?.[0]?.finish_reason === "length") truncated = true;
  } catch (__swallowErr) { logSwallow(__swallowErr, "ai-client.ts · try { const j = JSON.parse(res.body); if (typeof j?.model === \"…", "debug"); }
  return { content, raw: res.body, model, reasoning, usage, truncated };
}

/**
 * 流式生成：优先「直连 fetch 读取 SSE」实现真实逐字输出；
 * 若端点不允许浏览器跨域（CORS）或直连零产出即失败，则回退到内核代理
 * forwardProxy 的缓冲式请求（仍可用，但非逐字）。
 *
 * 之所以直连而非走 forwardProxy：SiYuan 的 /api/network/forwardProxy 经
 * fetchSyncPost 是缓冲后一次性返回，不支持流式读取；对本地 LLM / 开启 CORS
 * 的网关，直连可拿到真正的 SSE 流。CORS 受限时自然降级，不阻塞用户。
 *
 * 支持 AbortSignal：调用方可在用户点击「停止生成」时中断，已生成内容保留。
 */
export async function requestAIStream(opts: AiStreamOptions): Promise<AiStreamResult> {
  // ⏱ 诊断临时计时起点（2026-09-08 排查用）
  const diagT0 = Date.now();
  const settings = opts.settings;
  const mode: AiTransportMode = settings.transportMode ?? "auto";
  const url = buildChatUrl(settings.baseUrl);
  if (!url) return { ok: false, content: "", error: T("AI baseUrl 为空或无法解析为 chat 端点") };

  const body = buildRequestBody(opts.messages, settings, opts.jsonMode ?? settings.jsonMode);
  body.stream = true; // 覆盖 buildRequestBody 中的 stream:false
  // OpenAI/DeepSeek/硅基流动等需要显式声明才会在 SSE 末帧返回 usage
  body.stream_options = { include_usage: true };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (settings.apiKey) headers["Authorization"] = `Bearer ${settings.apiKey}`;

  // 代理缓冲模式：跳过直连，直接走内核代理缓冲请求（非流式，但用打字机模拟渐进输出）
  if (mode === "proxy") {
    return runBufferMode(opts);
  }

  let acc = "";
  let reason = "";
  let model: string | undefined;
  let usage: AiUsage | undefined;
  let truncated = false;

  // ⏱ 诊断临时日志（2026-09-08）：进入直连流式时的 signal 状态
  getLogger().info("AI 流式直连开始（诊断）", { operation: "AI对话", data: { mode, signalAborted: opts.signal?.aborted ?? null, hasModel: !!settings.model } });

  /** 解析单个 SSE data 帧（含 delta.content / reasoning / usage / finish_reason） */
  const processLine = (line: string) => {
    const t = line.trim();
    if (!t.startsWith("data:")) return;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    try {
      const obj = JSON.parse(payload);
      const delta = obj?.choices?.[0]?.delta;
      if (delta?.content && typeof delta.content === "string") {
        acc += delta.content;
        opts.onToken?.(delta.content);
      }
      if (typeof delta?.reasoning_content === "string") {
        reason += delta.reasoning_content;
        opts.onReasoning?.(delta.reasoning_content);
      }
      if (typeof obj?.model === "string") model = obj.model;
      // finish_reason=length 表示被 max_tokens 截断
      if (obj?.choices?.[0]?.finish_reason === "length") truncated = true;
      // 流式末端可能携带 usage；统一归一化为 camelCase（与 ai-panel.ts 消费侧对齐）。
      if (obj?.usage) {
        const u = extractUsageFromBody(payload);
        if (u) usage = u;
      }
    } catch (__swallowErr) { logSwallow(__swallowErr, "ai-client.ts · processLine", "debug"); }
  };

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!resp.ok || !resp.body) {
      throw new Error(T("AI 请求失败（HTTP {status}）", { status: resp.status }));
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      for (const raw of parts) processLine(raw);
    }
    // flush 残留：末帧可能没有结尾换行，直接吞掉会丢 content/usage/finish_reason
    if (buf) processLine(buf);

    if (opts.signal?.aborted) return { ok: true, content: acc, model, reasoning: reason || undefined, aborted: true, truncated, usage };
    return { ok: true, content: acc, model, reasoning: reason || undefined, truncated, usage };
  } catch (e: any) {
    // 用户主动中断：保留已生成的部分内容
    if (opts.signal?.aborted) return { ok: true, content: acc, model, reasoning: reason || undefined, aborted: true, truncated, usage };

    // 直连未产出任何 token 即失败（多为 CORS / 网络）：回退内核代理缓冲请求
    if (!acc) {
      const directErr = e?.message || String(e);
      if (mode === "direct") {
        // 直连模式：不回退代理，直接报错（用户明确选择直连）
        return { ok: false, content: "", error: directErr };
      }
      // P0.5（2026-09-08）：代理兜底也失败时合并两段错误——此前只留代理错误，
      // 直连失败原因（HTTP 状态/CORS/超时）被丢弃，排查时无从下手。
      const bufRes = await runBufferMode(opts);
      if (!bufRes.ok) {
        return { ok: false, content: "", error: `${T("直连失败：")}${directErr}${T("；代理兜底失败：")}${bufRes.error || T("未知错误")}` };
      }
      return bufRes;
    }

    // 已产出部分 token 后中断：返回已得内容（避免丢字）
    return { ok: true, content: acc, model, reasoning: reason || undefined, truncated, usage };
  }
}

/**
 * 内核代理缓冲模式：经 forwardProxy 一次性请求（非流式），再把整段内容
 * 用打字机效果渐进回调 onToken，消除「等很久突然全出」的顿挫感。
 * 用于 transportMode=proxy，以及 auto 模式直连失败时的回退。
 */
async function runBufferMode(opts: AiStreamOptions): Promise<AiStreamResult> {
  const settings = opts.settings;
  const url = buildChatUrl(settings.baseUrl);
  if (!url) return { ok: false, content: "", error: T("AI baseUrl 为空或无法解析为 chat 端点") };
  try {
    const gen = await requestAIGenerate(
      { messages: opts.messages, settings, jsonMode: opts.jsonMode ?? settings.jsonMode, timeout: opts.timeout },
      forwardProxyFetch
    );
    if (opts.onToken) {
      await playBufferTypewriter(gen.content, opts.onToken, opts.signal);
    }
    return { ok: true, content: gen.content, model: gen.model, reasoning: gen.reasoning, truncated: false, usage: gen.usage, buffered: true };
  } catch (e2: any) {
    return { ok: false, content: "", error: e2?.message || String(e2) };
  }
}

/** 把正文切成「句/行」粒度的块（保留标点与换行），超长块再按 ~80 字符细分；整体不超过 ~150 块以限制总时长 */
function splitTypewriterChunks(text: string): string[] {
  const parts = (text || "").match(/[\s\S]*?([。！？!?；;\n]|$)/g) ?? [text];
  let chunks = parts.filter((s) => s.length > 0);
  const MAX = 150;
  if (chunks.length > MAX) {
    const per = Math.ceil(chunks.length / MAX);
    const merged: string[] = [];
    for (let i = 0; i < chunks.length; i += per) merged.push(chunks.slice(i, i + per).join(""));
    chunks = merged;
  }
  const out: string[] = [];
  for (const c of chunks) {
    if (c.length <= 80) out.push(c);
    else for (let i = 0; i < c.length; i += 80) out.push(c.slice(i, i + 80));
  }
  return out;
}

/** 可中断的睡眠（signal 触发时立即 resolve，避免停止后仍逐字播放） */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { cleanup(); resolve(); };
    function cleanup() {
      clearTimeout(t);
      signal?.removeEventListener?.("abort", onAbort);
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

/** 缓冲模式打字机：逐块回调 onToken，块间小延迟模拟渐进输出；受 signal 中断控制 */
async function playBufferTypewriter(text: string, onToken: (c: string) => void, signal?: AbortSignal): Promise<void> {
  const chunks = splitTypewriterChunks(text);
  if (chunks.length <= 1) {
    onToken(text);
    return;
  }
  for (const c of chunks) {
    if (signal?.aborted) return;
    onToken(c);
    await sleep(Math.min(45, Math.max(10, c.length * 4)), signal);
  }
}
