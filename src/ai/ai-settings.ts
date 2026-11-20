/**
 * REword · AI 设置
 * ------------------------------------------------------------------
 * 适配自 Achuan-2/siyuan-plugin-copilot 的 AI 请求能力，裁剪为 REword 英语学习
 * 所需的最小可用配置：仅保留 OpenAI 兼容的「对话 / 文本处理」字段，移除生图、
 * agent、工具调用、视觉、多模态等无关项。
 *
 * 设计要点（与 copilot 一致）：
 *  - baseUrl 仅填「基础地址」，端点由 ai-client.buildChatUrl 归一化补全
 *    （默认追加 /v1/chat/completions）。
 *  - apiKey 通过内核代理 /api/network/forwardProxy 透传，前端不受 CORS 限制。
 *  - jsonMode=true 时要求模型返回结构化 JSON，便于面板渲染「收藏/批注」交互按钮。
 */

import { PLATFORM_PRESETS } from "./settings/ai-platform-presets.ts";
import { AUTO_RENAME_PROMPT_MAX, DEFAULT_AUTO_RENAME_PROMPT } from "./auto-title.ts";

/** AI 设置（持久化于 hiword-ai.json） */
export interface AiSettings {
  enabled: boolean;       // 是否启用 AI 精读
  baseUrl: string;        // 基础地址，不含末尾 chat/completions
  apiKey: string;         // 服务商 API Key（Authorization: Bearer）
  model: string;          // 模型名（如 gpt-4o-mini / deepseek-chat）
  models: string[];       // 预设模型列表（面板 header 下拉切换用）
  temperature: number;    // 0~2
  maxTokens: number;      // 单次最大生成 token（16~32768）
  jsonMode: boolean;      // true: 要求结构化 JSON；false: 直出 markdown
  /** 显示与操作 */
  fontSize: number;       // 消息字体大小（px），默认 14（与思源 Copilot 插件的 messageFontSize 默认一致）
  inputFontSize: number;  // 输入框字体大小（px），默认 13
  /**
   * AI 输入框实现选择。
   * - true（2026-09-07 T4 起默认）：SiYuan 原生 Protyle 富文本输入框（块引用卡片等原生能力）。
   * - false：稳定的 contenteditable 纯文本框。
   * 现在只作为**降级兜底**：Protyle 构造失败 / 容器持续零尺寸时由 ai-panel.ts 自动切回，
   * normalizeAiSettings 恒写 true（全面翻新，不区分新老用户），面板开关已移除。
   */
  useProtyleInput?: boolean;
  /**
   * 2026-09-07 T6：按模型覆写采样参数。key = 模型名，value 只存**显式设置过**的字段，
   * 未设的走全局 temperature / maxTokens。
   * 刻意不做「能力 checkbox」（思考/视觉/生图…）——只留两个真正影响精读结果的数值。
   */
  modelParams?: Record<string, ModelParamOverride>;
  /**
   * 2026-09-07 改动点 1/2/3：平台配置列表（单一真源）。
   * 每个平台独立存 baseUrl / apiKey / 模型 / 模型参数；发送请求时按 activePlatformId
   * 取当前平台的 baseUrl/apiKey（见 ai-orchestrator.toEngineSettings + activePlatformOf）。
   * 顶层的 baseUrl/apiKey/models/modelParams 仅作「当前平台」的镜像，供旧消费方
   * （anno-ai-dialog 的 apiKey 判空、toEngineSettings 兜底）读取，永远由 normalize 同步。
   */
  platforms?: AiPlatform[];
  /** 当前选中的平台 id（面板两级选择器即时持久化） */
  activePlatformId?: string;
  /** 对话导出 */
  exportNotebookId: string; // 导出目标笔记本 ID（空=收集箱）
  /** 记忆文档 */
  soulDocId: string;         // SOUL 文档 ID（用于记忆上下文）
  /** 阅读器「翻译」按钮发送到 AI 精读时预置的提示词（如「请把下面这句话翻译一下」） */
  translatePrompt: string;
  /**
   * 段落级"简洁版"翻译的提示词（2026-08-30 v1.4.3 新增）。
   * 用户点击译文右上角 `🔄 简洁版` 按钮时使用，与 default 直译风格互不污染。
   * 留空则回退到 translatePrompt 拼"精简附加要求"后缀。
   */
  conciseTranslatePrompt?: string;
  /** 翻译引擎：微软 Translator 订阅 Key（Azure 认知服务） */
  msKey?: string;
  /** 翻译引擎：微软 Translator 区域（如 eastasia / westeurope） */
  msRegion?: string;
  /** 翻译引擎：启用微软 Translator（默认关闭；AI 恒为首选，此为兜底开关） */
  msEnabled?: boolean;
  /** 翻译引擎：LibreTranslate 实例地址（如 https://libretranslate.com） */
  libreUrl?: string;
  /** 翻译引擎：启用 LibreTranslate（默认关闭；AI 恒为首选，此为兜底开关） */
  libreEnabled?: boolean;
  /** 免费翻译引擎优先级（按数组顺序尝试；AI 永远兜底，不在此列） */
  translatePriority?: string[];
  /** 腾讯云机器翻译（TMT） */
  tencentSecretId?: string;
  tencentSecretKey?: string;
  tencentEnabled?: boolean;
  /** 腾讯翻译本月已用字符数（用于 500 万免费额度内的用量锁） */
  tencentCharsUsed?: number;
  /** 腾讯翻译用量锁（默认 400 万字符；达到后自动禁用腾讯引擎） */
  tencentCharsLock?: number;
  /** 有道智云文本翻译 */
  youdaoAppKey?: string;
  youdaoAppSecret?: string;
  youdaoEnabled?: boolean;
  /** 百度翻译开放平台 */
  baiduAppId?: string;
  baiduKey?: string;
  baiduEnabled?: boolean;
  /** 百度翻译已用字符数（用于用量监控，达到锁后自动禁用） */
  baiduCharsUsed?: number;
  /** 百度翻译用量锁（0=不限；>0 达到后自动禁用百度引擎） */
  baiduCharsLock?: number;
  /** 有道智云已用字符数（用于用量监控） */
  youdaoCharsUsed?: number;
  /** 有道智云用量锁（0=不限） */
  youdaoCharsLock?: number;
  /** AI 翻译累计消耗 Token（跨批次累加；监督中心配额显示用） */
  aiTokenUsed?: number;
  /** AI 翻译 Token 配额上限（0=不限） */
  aiTokenLimit?: number;
  /** AI Token 告警阈值（0~1，默认 0.8） */
  aiTokenAlertRatio?: number;
  /** AI 兜底翻译风格（2026-08-30）：literal 硬直译（默认，低温度）/ natural 允许轻微润色 */
  bilingualStyle?: "literal" | "natural";
  /** AI 翻译参数：翻译温度（覆写「AI 服务」的 temperature，默认 0.2，直译低稳） */
  trTemperature?: number;

  // ─────────────────────────────────────────────────────────────
  // 2026-09-06 第 1 批：功能蓝图字段（设置面板先立，功能后补）
  //
  // 这批字段统一先落「接口 + 默认值 + normalize」三层，因此**能存能读**，
  // 只是消费方尚未实现 —— 面板上标 🟡 待接线 / 🔵 规划中。
  // ─────────────────────────────────────────────────────────────

  // —— 🟡 待接线：字段与 UI 已有，消费方缺失（多为把硬编码常量提升为开关）——
  /** 发送快捷键：enter（Enter 发送，默认，2026-09-10 起）｜ mod+enter（⌘/Ctrl+Enter） */
  sendShortcut?: "mod+enter" | "enter";
  /** 流式节流间隔（ms）。未节流时 12000 字 / 2400 帧实测耗 936ms，会卡死思源 */
  streamThrottleMs?: number;

  // —— 🔵 规划中：功能尚未实现，UI 正常显示并标注「暂不生效」——
  /** 默认精读角色预设 ID；空 = 走自由对话（对应 P0-4） */
  defaultPresetId?: string;
  /** 会话保留天数（0 = 永久） */
  sessionRetentionDays?: number;
  /** 会话落盘节流间隔（ms）；0 = 不节流 */
  sessionSaveThrottleMs?: number;
  /**
   * 会话自动重命名：首条消息发出后让模型概括标题（默认关）。
   * 只覆盖「本地生成且未改过」的标题；用户手改过的标题永不覆盖。
   */
  autoRenameSession?: boolean;
  /** 命名专用平台 id；空 = 跟随当前对话的平台 */
  autoRenamePlatformId?: string;
  /** 命名专用模型；空 = 跟随当前平台默认模型 */
  autoRenameModel?: string;
  /** 命名提示词，{message} 会被替换成用户第一句话 */
  autoRenamePrompt?: string;

  // 2026-08-21 精简：以下字段已删除(从 21 个 → 14 个,-33%)
  //  - chatApi: 强制 OpenAI 兼容,不再支持多格式
  //  - contextWindow: 用 inferContextWindow 自动推断
  //  - topP / frequencyPenalty / presencePenalty: 用 OpenAI 规范默认
  //  - timeoutSec / autoContinue / transportMode: 用代码默认(auto + 60s + 续传)
  //  - sendShortcut: 固定 Ctrl/⌘+Enter
  //  - defaultMode / chatPromptTemplate: 双模式删除
  // 老数据兼容：normalizeAiSettings 会忽略这些字段。
}

/** 默认预设模型列表（可在设置对话框增删） */
export const DEFAULT_MODELS: string[] = [
  "gpt-4o-mini",
  "gpt-4o",
  "deepseek-chat",
  "deepseek-reasoner",
  "claude-3-5-sonnet",
];

/**
 * 2026-09-07 T6：单个模型的参数覆写。两个字段都可选——没设的走全局值。
 * 用「有没有这个 key」而不是「值是否为 0」判断，因为 temperature=0 是合法且常用取值。
 */
export interface ModelParamOverride {
  /** 0~2 */
  temperature?: number;
  /** 16~32768 */
  maxTokens?: number;
  /**
   * 2026-09-07 R2：流式覆写。false = 该模型禁用流式（端点不支持 SSE 时用），
   * 编排层自动降级 requestAIGenerate（内容一次性到达，onToken 不再逐字）。
   * true 不设开关语义——有流式回调时本来就是流式，「强制开」是空操作，故 UI 不提供。
   */
  stream?: boolean;
  /**
   * 2026-09-07 R2：模型专属系统提示词，非空时**最高优先级**（覆盖 AI 角色提示词）。
   * 理由：模型专属提示词是「为这个型号修行为」的特化配置，角色是泛化人格，特化 > 泛化。
   * 生效点在编排层组装 system 消息处（runAiDeepRead / runAiChat），
   * 不在 toEngineSettings——那里拿不到角色合并结果。
   */
  systemPrompt?: string;
}

/**
 * 2026-09-07 改动点 1/2/3：单个 AI 平台的配置（平台列表的单元）。
 * 每个平台自带 baseUrl / apiKey / 模型 / 模型参数，互不干扰——
 * 同一模型名出现在不同平台也各自持有参数（旧的全局 modelParams 按模型名会撞名）。
 */
export interface AiPlatform {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  modelParams?: Record<string, ModelParamOverride>;
  /** 固定平台（硅基流动）：不可删除、不可改名；保证列表永远非空 */
  fixed?: boolean;
}

/** 地址归一化：去空白与末尾斜杠、小写，用于平台命中比较 */
function normUrl(u: string): string {
  return (u || "").trim().replace(/\/+$/, "").toLowerCase();
}

/**
 * 2026-09-07 改动点 1：按 API 地址自动识别平台名。
 * 用于「+ 新建平台」表单里边输入地址边回填名称，以及旧数据迁移时给平台命名。
 * 优先精确命中内置预设（容忍用户在预设地址后补路径），其次走域名/路径关键词识别。
 */
export function detectPlatformName(baseUrl: string): string {
  const u = normUrl(baseUrl);
  if (!u) return "";
  const hit = PLATFORM_PRESETS.find((p) => {
    const pre = normUrl(p.baseUrl);
    return pre === u || u.startsWith(pre + "/");
  });
  if (hit) return hit.name;
  const rules: [RegExp, string][] = [
    [/siliconflow/, "硅基流动"],
    [/deepseek/, "DeepSeek"],
    [/dashscope|aliyun|qwen|tongyi/, "阿里通义 Qwen"],
    [/bigmodel|zhipu|glm/, "智谱 GLM"],
    [/moonshot|kimi/, "Kimi"],
    [/volces|ark|doubao/, "豆包"],
    [/minimax/, "MiniMax"],
    [/openai/, "OpenAI"],
    [/openrouter/, "OpenRouter"],
    [/ollama/, "Ollama"],
    [/lmstudio|1234/, "LM Studio"],
    [/localai/, "LocalAI"],
  ];
  for (const [re, name] of rules) if (re.test(u)) return name;
  return "";
}

/** 固定平台「硅基流动」的默认形态（新建用户即带，不可删） */
export function defaultSiliconflowPlatform(): AiPlatform {
  return {
    id: "siliconflow",
    name: "硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1",
    apiKey: "",
    models: ["deepseek-ai/DeepSeek-V3"],
    modelParams: {},
    fixed: true,
  };
}

/** 容错归一化单个平台（字段缺失/非法用兜底；id 缺失自动生成） */
function normalizePlatform(p: any): AiPlatform {
  const baseUrl = str(p?.baseUrl, "").trim();
  const name =
    str(p?.name, "").trim() ||
    detectPlatformName(baseUrl) ||
    "我的平台";
  const id = typeof p?.id === "string" && p.id ? p.id : "plat-" + Math.random().toString(36).slice(2, 9);
  return {
    id,
    name,
    baseUrl,
    apiKey: str(p?.apiKey, "").trim(),
    models: strArr(p?.models, []),
    modelParams: modelParamsOf(p?.modelParams),
    fixed: p?.fixed === true || id === "siliconflow",
  };
}

/** 从旧扁平字段（baseUrl/apiKey/model/models/modelParams）构造一个可迁移平台 */
function platformFromFlat(r: any): AiPlatform | null {
  const baseUrl = str(r?.baseUrl, "").trim();
  const apiKey = str(r?.apiKey, "").trim();
  const models = strArr(r?.models, []);
  // 无任何配置（连模型列表都没有）才放弃迁移——只配过模型列表的老用户也不能丢数据
  if (!baseUrl && !apiKey && !models.length) return null;
  const name = detectPlatformName(baseUrl) || "我的平台";
  const id =
    /siliconflow/.test(baseUrl.toLowerCase()) ? "siliconflow" : "plat-" + Math.random().toString(36).slice(2, 9);
  return {
    id,
    name,
    baseUrl,
    apiKey,
    models: strArr(r?.models, []),
    modelParams: modelParamsOf(r?.modelParams),
    fixed: id === "siliconflow",
  };
}

/**
 * 解析平台列表 + 当前激活平台 id（含旧数据迁移）。
 * - 已有 platforms：直接归一化，activePlatformId 取已存的（缺省回退首个）。
 * - 旧扁平数据：构造迁移平台，并保证硅基流动固定平台始终存在；
 *   若旧配置本身就是硅基流动则合并进固定平台，否则追加为自定义平台，
 *   且老用户沿用其现有平台作为激活项（保留当前模型可用性）。
 */
function platformsOf(r: any): { platforms: AiPlatform[]; activePlatformId: string } {
  if (Array.isArray(r?.platforms) && r.platforms.length) {
    const list: AiPlatform[] = r.platforms.map(normalizePlatform);
    let active = typeof r?.activePlatformId === "string" ? r.activePlatformId : "";
    if (!list.some((p) => p.id === active)) active = list[0].id;
    return { platforms: list, activePlatformId: active };
  }
  const flat = platformFromFlat(r);
  const list = [defaultSiliconflowPlatform()];
  if (flat) {
    if (flat.id === "siliconflow") {
      const sf = list[0];
      sf.baseUrl = flat.baseUrl;
      sf.apiKey = flat.apiKey;
      sf.models = flat.models;
      sf.modelParams = flat.modelParams;
      sf.fixed = true;
    } else {
      list.push(flat);
    }
  }
  const active = flat ? flat.id : "siliconflow";
  return { platforms: list, activePlatformId: active };
}

/** 取当前激活平台（找不到则回退首个）；供请求发送与面板选择器使用 */
export function activePlatformOf(s: {
  platforms?: AiPlatform[];
  activePlatformId?: string;
}): AiPlatform | undefined {
  if (!Array.isArray(s.platforms) || !s.platforms.length) return undefined;
  return s.platforms.find((p) => p.id === s.activePlatformId) || s.platforms[0];
}

/**
 * T6：解析某个模型最终生效的采样参数（模型覆写优先于全局）。
 * 唯一入口在 ai-client.buildRequestBody —— 精读 / 对话 / 翻译 / 批注 AI 全链路统一生效。
 */
export function resolveModelParams(settings: {
  model: string;
  temperature: number;
  maxTokens: number;
  modelParams?: Record<string, ModelParamOverride>;
}): { temperature: number; maxTokens: number } {
  // 刻意用内联结构类型而非 Pick<AiSettings>：types.ts 另有一套引擎侧 AiSettings
  // （无 modelParams），两侧都要能调用本函数。
  const ov = settings.modelParams?.[settings.model];
  return {
    temperature: typeof ov?.temperature === "number" ? ov.temperature : settings.temperature,
    maxTokens: typeof ov?.maxTokens === "number" ? ov.maxTokens : settings.maxTokens,
  };
}

/** 根据常见模型名推断上下文窗口；未知模型返回 128000。 */
export function inferContextWindow(model: string): number {
  const m = (model || "").toLowerCase();
  if (m.includes("deepseek-v4") || m.includes("deepseek-v4-flash")) return 1_048_576;
  if (m.includes("deepseek-v3") || m.includes("deepseek-chat")) return 64_000;
  if (m.includes("deepseek-reasoner") || m.includes("deepseek-r1")) return 64_000;
  if (m.includes("gpt-4o") || m.includes("gpt-4-turbo") || m.includes("o1")) return 128_000;
  if (m.includes("gpt-4") && !m.includes("gpt-4o")) return 8_192;
  if (m.includes("claude-3") || m.includes("claude-4")) return 200_000;
  if (m.includes("gemini-1.5") || m.includes("gemini-2")) return 1_000_000;
  if (m.includes("gemini")) return 32_000;
  if (m.includes("qwen2.5") || m.includes("qwen3")) return 128_000;
  if (m.includes("qwen")) return 32_000;
  if (m.includes("llama-3.1") || m.includes("llama-3.2") || m.includes("llama-4")) return 128_000;
  return 128_000;
}

/**
 * 2026-08-30 重构：翻译提示词收紧为「硬直译」。
 * 目标：限制 AI 不要发挥、不要润色、不要拓展，只做精确直译，省 token 且风格稳定。
 */
/** 硬直译（默认风格 literal）：逐词直译、禁止发挥 */
export const DEFAULT_TRANSLATE_PROMPT =
  "你是逐段直译助手。严格遵循：\n" +
  "1. 逐句翻译，不要合并或拆句子。\n" +
  "2. 忠于原文字面意思，禁止扩写、润色、添加解释、注音、词性、例句或任何额外内容。\n" +
  "3. 人名、地名、专有名词保留原文或按通用译法，不要意译。\n" +
  "4. 只输出中文译文，一段对应一段。\n" +
  "5. 保持原文语序，不要为通顺而调顺序。";

/**
 * 自然译（风格 natural）：允许在不改意前提下做极轻微润色，读起来更顺。
 *
 * 2026-08-31：末尾追加「排版引导」，让译文可携带轻量 Markdown 结构，
 * 由 lute 渲染层（bilingual-v2/render.ts 的 mdToHtml）美化排版——
 * 解决长译文糊成一坨、多义项无层次的「释义排版问题」。
 * 只改呈现形式，不改翻译内容要求（忠实 / 极轻微润色 / 只输出译文）。
 * 注：直译（literal）风格刻意保持不变，仍是纯译文。
 */
export const DEFAULT_TRANSLATE_PROMPT_NATURAL =
  "你是一位严谨的英译中翻译器。请逐句忠实翻译，不要过度发挥；仅在不改变单词基本意思的前提下做极轻微润色，使中文通顺易读。保持原文段落与句子顺序一一对应。只输出译文本身，不要添加解释、注音或任何额外内容。\n" +
  "排版（只影响呈现，不改变译文内容）：若一句含多个义项或并列成分，可用 Markdown 无序列表分行；需要留意的关键词用 **加粗**；多个自然段之间空一行。";

/**
 * 简洁版（2026-08-30 v1.4.3 新增）：段落级"重新翻译为简洁版"按钮触发的 prompt。
 * 默认策略：保留默认直译 prompt + 在末尾追加"精简附加要求"（控制 token / 不破坏用户自定义 base prompt）。
 * 进阶用户可在设置里覆盖 `conciseTranslatePrompt`，则完全替换。
 */
export const DEFAULT_CONCISE_TRANSLATE_PROMPT =
  "你是逐段直译助手（同默认模式），但对每段译文做极严格的长度控制与去冗余：\n" +
  "1. 用最简短的中文翻译原句，长度贴近原文（不扩写、不补充、不解释）。\n" +
  "2. 去掉语法分析、注释、背景信息、连接词、语气词、过渡短语。\n" +
  "3. 直接给译文，不要加任何前缀（如\"翻译：\"）或后缀（如\"。\" 之外的标点）。\n" +
  "4. 逐句翻译，不要合并或拆句子。\n" +
  "5. 忠于原文字面意思，禁止扩写、润色、添加解释、注音、词性、例句或任何额外内容。\n" +
  "6. 人名、地名、专有名词保留原文或按通用译法，不要意译。\n" +
  "7. 只输出中文译文，一段对应一段。";

export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: false,
  // 2026-09-07 改动点 1：默认平台即固定「硅基流动」，顶层 baseUrl 为激活平台镜像，
  // 默认值与之对齐（此前遗留 openai 与 model=DeepSeek-V3 不一致）
  baseUrl: "https://api.siliconflow.cn/v1",
  apiKey: "",
  // 2026-08-21 精简：chatApi 字段删除,统一 openai-completion
  model: "deepseek-ai/DeepSeek-V3",
  conciseTranslatePrompt: DEFAULT_CONCISE_TRANSLATE_PROMPT,
  models: ["deepseek-ai/DeepSeek-V3"],
  // T6：默认不带任何覆写（全走全局 temperature / maxTokens）
  modelParams: {},
  // 2026-09-07 改动点 1/2/3：平台列表（单一真源）；新建用户即带硅基流动固定平台
  platforms: [defaultSiliconflowPlatform()],
  activePlatformId: "siliconflow",
  temperature: 0.3,
  maxTokens: 2048,
  // 2026-08-21 精简：contextWindow/topP/frequencyPenalty/presencePenalty/timeoutSec/autoContinue/transportMode/sendShortcut 已删除
  //   - contextWindow 用 inferContextWindow() 动态推断
  //   - 其余字段在调用处用硬编码默认
  jsonMode: true,
  // 显示与操作
  fontSize: 14,
  inputFontSize: 13,
  // 2026-09-07 T4：Protyle 输入框全面转正（默认开）。
  //   contenteditable 不再是「默认路径」，仅作 Protyle 构造失败 / 容器零尺寸时的兜底。
  useProtyleInput: true,
  // 对话导出
  exportNotebookId: "",
  // 记忆文档
  soulDocId: "",
  // 2026-08-27 阅读器「翻译」预置提示词
  translatePrompt: DEFAULT_TRANSLATE_PROMPT,
  // 2026-08-27 翻译引擎配置（免费引擎链 + AI 兜底）
  msKey: "",
  msRegion: "",
  msEnabled: false,
  libreUrl: "",
  libreEnabled: false,
  // 2026-08-30 新增三个免费引擎（默认关闭，用户填 key 后启用）
  tencentSecretId: "",
  tencentSecretKey: "",
  tencentEnabled: false,
  tencentCharsUsed: 0,
  tencentCharsLock: 4_000_000,
  youdaoAppKey: "",
  youdaoAppSecret: "",
  youdaoEnabled: false,
  baiduAppId: "",
  baiduKey: "",
  baiduEnabled: false,
  baiduCharsUsed: 0,
  baiduCharsLock: 0,
  youdaoCharsUsed: 0,
  youdaoCharsLock: 0,
  aiTokenUsed: 0,
  aiTokenLimit: 0,
  aiTokenAlertRatio: 0.8,
  // 免费引擎顺序（AI 永远兜底，不在此列）；缓存命中仍由调用方优先拦截
  translatePriority: ["tencent", "youdao", "baidu", "microsoft", "libretranslate"],
  // AI 兜底翻译风格（默认硬直译）
  bilingualStyle: "literal",
  // 2026-08-28 AI 翻译参数（翻译引擎 Tab 可调；默认值与 index.ts 常量一致）
  trTemperature: 0.1,
  // 2026-09-06 第 1 批：功能蓝图字段默认值（与上方接口注释一一对应）
  //   🟡 待接线
  // 2026-09-10 P3：默认发送键由「⌘/Ctrl+Enter」改为「Enter 发送」，
  //   对齐对话面板的通用习惯（Enter 发送 / Shift+Enter 换行）。
  //   注意：老用户落盘里仍是显式 "mod+enter"，需在设置里手动切换（未做自动迁移，避免覆盖用户选择）。
  sendShortcut: "enter",
  streamThrottleMs: 100,
  //   🔵 规划中
  defaultPresetId: "",
  sessionRetentionDays: 0,
  sessionSaveThrottleMs: 800,
  // 2026-11-07：会话自动重命名（默认关；默认跟随当前对话平台与模型）
  autoRenameSession: false,
  autoRenamePlatformId: "",
  autoRenameModel: "",
  autoRenamePrompt: DEFAULT_AUTO_RENAME_PROMPT,
  // 2026-08-21 精简：双模式字段 defaultMode / chatPromptTemplate 已删除
};

function num(v: any, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : parseFloat(v);
  if (!isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function str(v: any, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function bool(v: any, fallback: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "yes" || s === "1" || s === "on") return true;
    if (s === "false" || s === "no" || s === "0" || s === "off" || s === "") return false;
  }
  return fallback;
}

/**
 * 枚举容错：不在候选集内则回退默认（2026-09-06 第 1 批，供功能蓝图的枚举字段使用）。
 * 与 bool 一样做「静默回退」而非抛错——设置脏数据不该让插件起不来。
 */
function enumOf<T extends string>(v: any, valid: readonly T[], fallback: T): T {
  return typeof v === "string" && (valid as readonly string[]).includes(v) ? (v as T) : fallback;
}

/**
 * T6：按模型参数覆写表的容错。
 * 只保留「模型名非空 + 至少一个合法数值」的条目；越界值夹到合法区间（与全局字段同区间）。
 */
function modelParamsOf(v: any): Record<string, ModelParamOverride> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, ModelParamOverride> = {};
  for (const [name, raw] of Object.entries(v as Record<string, any>)) {
    const key = (name || "").trim();
    if (!key || !raw || typeof raw !== "object") continue;
    const ov: ModelParamOverride = {};
    if (typeof raw.temperature === "number" && Number.isFinite(raw.temperature)) {
      ov.temperature = Math.max(0, Math.min(2, raw.temperature));
    }
    if (typeof raw.maxTokens === "number" && Number.isFinite(raw.maxTokens)) {
      ov.maxTokens = Math.round(Math.max(16, Math.min(32768, raw.maxTokens)));
    }
    // R2：流式开关只认 boolean；专属提示词 trim 后非空才保留
    if (typeof raw.stream === "boolean") ov.stream = raw.stream;
    if (typeof raw.systemPrompt === "string" && raw.systemPrompt.trim()) {
      ov.systemPrompt = raw.systemPrompt;
    }
    if (
      ov.temperature !== undefined || ov.maxTokens !== undefined ||
      ov.stream !== undefined || ov.systemPrompt !== undefined
    ) {
      out[key] = ov;
    }
  }
  return out;
}

/**
 * R2（2026-09-07）：读取当前模型的流式覆写。
 * undefined = 跟随全局（编排层默认「有回调走流式」）；
 * false = 该模型禁用流式，编排层降级 requestAIGenerate。
 */
export function resolveModelStreamOverride(settings: {
  model: string;
  modelParams?: Record<string, ModelParamOverride>;
}): boolean | undefined {
  return settings.modelParams?.[settings.model]?.stream;
}

/**
 * R2（2026-09-07）：读取当前模型的专属系统提示词（trim 后）。空串 = 未设置。
 * 消费方仅编排层 runAiDeepRead / runAiChat（组装 system 消息处）；
 * 翻译 / 批注 AI 不消费——它们有自己的固定提示词协议，专属提示词若覆盖会破坏 JSON 解析。
 */
export function resolveModelSystemPrompt(settings: {
  model: string;
  modelParams?: Record<string, ModelParamOverride>;
}): string {
  return (settings.modelParams?.[settings.model]?.systemPrompt || "").trim();
}

/** 字符串数组容错（去空、去重、非字符串项剔除） */
function strArr(v: any, fallback: string[]): string[] {
  if (!Array.isArray(v)) return [...fallback];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") continue;
    const s = item.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out.length ? out : [...fallback];
}

/**
 * 容错合并：用默认值补齐缺失/非法字段，数值限幅，避免脏数据导致请求异常。
 */
export function normalizeAiSettings(raw: any): AiSettings {
  const r = raw && typeof raw === "object" ? raw : {};
  // 2026-09-07 改动点 1/2/3：解析平台列表（含旧扁平迁移），并同步顶层镜像字段
  const { platforms, activePlatformId } = platformsOf(r);
  const activePlat = activePlatformOf({ platforms, activePlatformId }) || platforms[0];
  const syncedModels = activePlat?.models && activePlat.models.length ? activePlat.models : strArr(r.models, []);
  // 命名平台必须存在于平台列表；不存在就回到「跟随当前」，模型随之清空。
  // 指定平台时模型不在该平台列表里 → 回落第一个，避免请求带着无效模型。
  const renamePlatformWanted = str(r.autoRenamePlatformId, "").trim();
  const renamePlat = renamePlatformWanted
    ? platforms.find((p) => p.id === renamePlatformWanted) || null
    : null;
  const renamePlatformId = renamePlat ? renamePlat.id : "";
  const renameModelWanted = str(r.autoRenameModel, "").trim();
  const renameModel = renamePlat
    ? (renamePlat.models.includes(renameModelWanted) ? renameModelWanted : (renamePlat.models[0] || ""))
    : "";
  const renamePromptRaw = str(r.autoRenamePrompt, "").trim();
  return {
    enabled: bool(r.enabled, false),
    // 顶层 baseUrl/apiKey/models/modelParams 为「当前激活平台」的镜像，供旧消费方读取；
    // 单一真源永远是 platforms[activePlatformId]（见 ai-orchestrator.toEngineSettings）。
    baseUrl: (activePlat?.baseUrl || str(r.baseUrl, "")).trim(),
    apiKey: (activePlat?.apiKey || str(r.apiKey, "")).trim(),
    // 2026-08-21 精简：chatApi 字段已删除(默认 openai-completion,不再支持多格式选择)
    model: str(r.model, syncedModels[0] || DEFAULT_AI_SETTINGS.model).trim() || syncedModels[0] || DEFAULT_AI_SETTINGS.model,
    models: syncedModels,
    // T6：按模型参数覆写（默认空 = 全走全局），以当前平台为准
    modelParams: { ...(activePlat?.modelParams || modelParamsOf(r.modelParams)) },
    platforms,
    activePlatformId,
    temperature: num(r.temperature, 0.3, 0, 2),
    maxTokens: Math.round(num(r.maxTokens, 2048, 16, 32768)),
    // 2026-08-21 精简：contextWindow/topP/frequencyPenalty/presencePenalty/timeoutSec/autoContinue/transportMode/sendShortcut 已删除
    //   - contextWindow 用 inferContextWindow 自动推断
    //   - 其余用代码默认(由 OpenAI 兼容规范保证)
    jsonMode: bool(r.jsonMode, true),
    // 显示与操作
    fontSize: Math.round(num(r.fontSize, 14, 10, 24)),
    inputFontSize: Math.round(num(r.inputFontSize, 13, 10, 24)),
    // 2026-09-03 P0：AI 输入框模式（默认 contenteditable，Protyle 实验性）
    useProtyleInput: bool(r.useProtyleInput, false),
    // 对话导出
    exportNotebookId: str(r.exportNotebookId, ""),
    // 记忆文档
    soulDocId: str(r.soulDocId, ""),
    // 2026-08-27 阅读器「翻译」预置提示词（缺省回退到默认，避免空串）
    translatePrompt: (typeof r.translatePrompt === "string" && r.translatePrompt.trim())
      ? r.translatePrompt
      : DEFAULT_TRANSLATE_PROMPT,
    // 2026-09-06 P0：conciseTranslatePrompt 此前**漏在本返回对象之外** —— 接口(:51)、
    //   默认值(:247)、消费方(index.ts:1823/1834)三层都在，唯独持久化层缺失。
    //   因它在 AiSettings 里是可选字段、TS 不会报错，表现为「用户自定义后重启即回退默认」。
    //   空串同样回退默认，与 translatePrompt 口径保持一致。
    conciseTranslatePrompt: (typeof r.conciseTranslatePrompt === "string" && r.conciseTranslatePrompt.trim())
      ? r.conciseTranslatePrompt
      : DEFAULT_CONCISE_TRANSLATE_PROMPT,
    // 2026-08-30 翻译引擎配置（免费引擎在前，AI 兜底）
    tencentSecretId: str(r.tencentSecretId, ""),
    tencentSecretKey: str(r.tencentSecretKey, ""),
    tencentEnabled: bool(r.tencentEnabled, false),
    tencentCharsUsed: Math.max(0, Math.round(num(r.tencentCharsUsed, 0, 0, Number.MAX_SAFE_INTEGER))),
    tencentCharsLock: Math.max(0, Math.round(num(r.tencentCharsLock, 4_000_000, 0, Number.MAX_SAFE_INTEGER))),
    youdaoAppKey: str(r.youdaoAppKey, ""),
    youdaoAppSecret: str(r.youdaoAppSecret, ""),
    youdaoEnabled: bool(r.youdaoEnabled, false),
    baiduAppId: str(r.baiduAppId, ""),
    baiduKey: str(r.baiduKey, ""),
    baiduEnabled: bool(r.baiduEnabled, false),
    baiduCharsUsed: Math.max(0, Math.round(num(r.baiduCharsUsed, 0, 0, Number.MAX_SAFE_INTEGER))),
    baiduCharsLock: Math.max(0, Math.round(num(r.baiduCharsLock, 0, 0, Number.MAX_SAFE_INTEGER))),
    youdaoCharsUsed: Math.max(0, Math.round(num(r.youdaoCharsUsed, 0, 0, Number.MAX_SAFE_INTEGER))),
    youdaoCharsLock: Math.max(0, Math.round(num(r.youdaoCharsLock, 0, 0, Number.MAX_SAFE_INTEGER))),
    aiTokenUsed: Math.max(0, Math.round(num(r.aiTokenUsed, 0, 0, Number.MAX_SAFE_INTEGER))),
    aiTokenLimit: Math.max(0, Math.round(num(r.aiTokenLimit, 0, 0, Number.MAX_SAFE_INTEGER))),
    aiTokenAlertRatio: num(r.aiTokenAlertRatio, 0.8, 0, 1),
    msKey: str(r.msKey, ""),
    msRegion: str(r.msRegion, ""),
    msEnabled: bool(r.msEnabled, false),
    libreUrl: str(r.libreUrl, ""),
    libreEnabled: bool(r.libreEnabled, false),
    bilingualStyle: r.bilingualStyle === "natural" ? "natural" : "literal",
    translatePriority: (() => {
      const valid = ["tencent", "youdao", "baidu", "microsoft", "libretranslate"];
      const arr = Array.isArray(r.translatePriority) ? r.translatePriority.filter((x: any) => valid.includes(x)) : [];
      // 去重保序；AI 不在此列（恒为最后兜底）
      const seen = new Set<string>();
      const out = arr.filter((x: string) => (seen.has(x) ? false : (seen.add(x), true)));
      return out.length ? out : ["tencent", "youdao", "baidu", "microsoft", "libretranslate"];
    })(),
    // 2026-08-28 AI 翻译参数（与翻译引擎 Tab 联动）
    trTemperature: num(r.trTemperature, 0.1, 0, 1),

    // ── 2026-09-06 第 1 批：功能蓝图字段（🟡 待接线 / 🔵 规划中）──
    //   三层同步是本批的硬要求：接口 + 默认 + normalize 缺一不可，
    //   否则 listNormalizeGaps() 会报缺口、测试会红。
    //   🟡 待接线
    sendShortcut: enumOf(r.sendShortcut, ["mod+enter", "enter"] as const, "enter"),
    streamThrottleMs: Math.round(num(r.streamThrottleMs, 100, 0, 500)),
    //   🔵 规划中
    defaultPresetId: str(r.defaultPresetId, ""),
    sessionRetentionDays: Math.round(num(r.sessionRetentionDays, 0, 0, 365)),
    sessionSaveThrottleMs: Math.round(num(r.sessionSaveThrottleMs, 800, 0, 5000)),
    // 2026-11-07：会话自动重命名（提示词空串回退默认，超长截断）
    autoRenameSession: bool(r.autoRenameSession, false),
    autoRenamePlatformId: renamePlatformId,
    autoRenameModel: renameModel,
    autoRenamePrompt: renamePromptRaw
      ? renamePromptRaw.slice(0, AUTO_RENAME_PROMPT_MAX)
      : DEFAULT_AUTO_RENAME_PROMPT,
  };
}

/**
 * 2026-09-06 P0 自检：列出 normalizeAiSettings 返回对象中**缺失**的字段键。
 *
 * 背景：conciseTranslatePrompt 曾被漏在返回对象外，而它在 AiSettings 里是可选字段
 * （TS 不报错），缺陷于是静默存在——用户以为保存成功，重启后配置消失。
 * 本函数把这类缺陷变成可自动检测的：此后新增字段若忘了补 normalize，启动即报警。
 *
 * - 启动时调用一次，非空应 warn（见 index.ts initAiSettings）
 * - 测试里断言必须为空数组（见 test/ai-settings-normalize.test.mjs）
 */
export function listNormalizeGaps(): string[] {
  const expected = Object.keys(DEFAULT_AI_SETTINGS);
  const actual = new Set(Object.keys(normalizeAiSettings({})));
  return expected.filter((k) => !actual.has(k));
}
