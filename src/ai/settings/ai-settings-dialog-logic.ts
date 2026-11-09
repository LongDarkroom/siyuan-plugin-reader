/**
 * 阅读助手设置窗口 · 纯逻辑
 * ------------------------------------------------------------------
 * 窗口同时编辑两层配置：
 *  - 插件级 AiSettings（凭据、模型、字号、发送键、保留天数…）
 *  - 面板级 AiPanelPrefs（上下文预算、历史轮数、皮肤…）
 *
 * 这里不碰 DOM / Svelte，便于 node 单测。UI 只负责把草稿字段搬来搬去；
 * 脏检查、校验、补丁组装都在本文件完成，避免「保存了一半」。
 */
import {
  DEFAULT_AI_SETTINGS,
  normalizeAiSettings,
  type AiSettings,
  type AiPlatform,
} from "../ai-settings.ts";
import {
  DEFAULT_AI_PANEL_PREFS,
  normalizeAiPanelPrefs,
  MIN_CONTEXT_CHARS,
  MAX_CONTEXT_CHARS,
  MAX_HISTORY_TURNS,
  type AiPanelPrefs,
  type AiSkin,
} from "../panel/ai-panel-logic.ts";
import { KNOWLEDGE_MIN_CHARS, KNOWLEDGE_MAX_CHARS } from "../panel/ai-knowledge.ts";
import { AUTO_RENAME_PROMPT_MAX, DEFAULT_AUTO_RENAME_PROMPT } from "../auto-title.ts";

export interface AiSettingsDraft {
  settings: AiSettings;
  prefs: AiPanelPrefs;
}

export interface DraftValidationError {
  /** 字段路径，UI 用来聚焦与高亮 */
  field: string;
  /** 中文原文即 i18n key，UI 直接 t(message) */
  message: string;
}

/** 本窗口负责的 AiSettings 字段；其他字段（翻译引擎、提示词等）一律不动 */
export const AI_SETTINGS_OWNED_KEYS = [
  "baseUrl",
  "apiKey",
  "model",
  "models",
  "temperature",
  "maxTokens",
  "modelParams",
  "platforms",
  "activePlatformId",
  "sendShortcut",
  "fontSize",
  "inputFontSize",
  "streamThrottleMs",
  "sessionRetentionDays",
  "autoRenameSession",
  "autoRenamePlatformId",
  "autoRenameModel",
  "autoRenamePrompt",
] as const;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function activePlatform(settings: AiSettings): AiPlatform | undefined {
  const list = Array.isArray(settings.platforms) ? settings.platforms : [];
  return list.find((p) => p.id === settings.activePlatformId) || list[0];
}

/** 深拷贝 + 归一化；坏数据不让窗口炸 */
export function createDraft(settings: any, prefs: AiPanelPrefs): AiSettingsDraft {
  return {
    settings: clone(normalizeAiSettings(settings && typeof settings === "object" ? settings : DEFAULT_AI_SETTINGS)),
    prefs: clone(normalizeAiPanelPrefs(prefs)),
  };
}

/** 切换平台：把该平台的凭据与模型镜像到顶层，模型不在列表时回落到第一个 */
export function switchPlatform(draft: AiSettingsDraft, platformId: string): AiSettingsDraft {
  const list = draft.settings.platforms || [];
  const target = list.find((p) => p.id === platformId);
  if (!target) return draft;
  const models = Array.isArray(target.models) ? target.models.slice() : [];
  const model = models.includes(draft.settings.model) ? draft.settings.model : models[0] || "";
  return {
    settings: {
      ...draft.settings,
      activePlatformId: target.id,
      baseUrl: String(target.baseUrl || ""),
      apiKey: String(target.apiKey || ""),
      models,
      model,
      modelParams: clone(target.modelParams || {}),
    },
    prefs: draft.prefs,
  };
}

/**
 * 草稿快照：只取本窗口拥有的字段。
 * 平台列表里其他平台的改动、翻译引擎字段不参与脏检查。
 */
function ownedSnapshot(draft: AiSettingsDraft): Record<string, any> {
  const s = draft.settings;
  const p = draft.prefs;
  return {
    baseUrl: String(s.baseUrl || "").trim(),
    apiKey: String(s.apiKey || ""),
    model: String(s.model || "").trim(),
    models: Array.isArray(s.models) ? s.models.map((m) => String(m)) : [],
    temperature: Number(s.temperature),
    maxTokens: Number(s.maxTokens),
    modelParams: s.modelParams || {},
    activePlatformId: String(s.activePlatformId || ""),
    sendShortcut: s.sendShortcut === "mod+enter" ? "mod+enter" : "enter",
    fontSize: Number(s.fontSize),
    inputFontSize: Number(s.inputFontSize),
    streamThrottleMs: Number(s.streamThrottleMs),
    sessionRetentionDays: Number(s.sessionRetentionDays),
    autoRenameSession: s.autoRenameSession === true,
    autoRenamePlatformId: String(s.autoRenamePlatformId || ""),
    autoRenameModel: String(s.autoRenameModel || ""),
    autoRenamePrompt: String(s.autoRenamePrompt || "").trim(),
    prefs: {
      contextChars: p.contextChars,
      knowledgeChars: p.knowledgeChars,
      historyTurns: p.historyTurns,
      showReasoning: p.showReasoning,
      contextScope: p.contextScope,
      aiSkin: p.aiSkin,
      showUsage: p.showUsage,
    },
  };
}

/** 稳定序列化：对象键排序，undefined 视同缺省 */
export function stableStringify(v: any): string {
  const walk = (x: any): any => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") {
      const out: Record<string, any> = {};
      for (const k of Object.keys(x).sort()) {
        if (x[k] !== undefined) out[k] = walk(x[k]);
      }
      return out;
    }
    return x;
  };
  return JSON.stringify(walk(v));
}

export function isDirty(baseline: AiSettingsDraft, draft: AiSettingsDraft): boolean {
  return stableStringify(ownedSnapshot(baseline)) !== stableStringify(ownedSnapshot(draft));
}

function intIn(v: unknown, min: number, max: number): boolean {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max && Math.round(n) === n;
}

export function validateDraft(draft: AiSettingsDraft): DraftValidationError[] {
  const errors: DraftValidationError[] = [];
  const s = draft.settings;
  const p = draft.prefs;
  const baseUrl = String(s.baseUrl || "").trim();
  if (!/^https?:\/\/\S+/i.test(baseUrl)) {
    errors.push({ field: "baseUrl", message: "请填写以 http(s):// 开头的接口地址" });
  }
  if (!String(s.model || "").trim()) {
    errors.push({ field: "model", message: "请填写或选择模型" });
  }
  if (!(Number(s.temperature) >= 0 && Number(s.temperature) <= 2)) {
    errors.push({ field: "temperature", message: "温度需在 0–2 之间" });
  }
  if (!intIn(s.maxTokens, 16, 32768)) {
    errors.push({ field: "maxTokens", message: "最大输出需在 16–32768 之间" });
  }
  if (!intIn(s.fontSize, 10, 24)) {
    errors.push({ field: "fontSize", message: "字号需在 10–24 之间" });
  }
  if (!intIn(s.inputFontSize, 10, 24)) {
    errors.push({ field: "inputFontSize", message: "字号需在 10–24 之间" });
  }
  if (!intIn(s.streamThrottleMs, 0, 500)) {
    errors.push({ field: "streamThrottleMs", message: "流式节流需在 0–500 毫秒之间" });
  }
  if (!intIn(s.sessionRetentionDays, 0, 365)) {
    errors.push({ field: "sessionRetentionDays", message: "保留天数需在 0–365 之间" });
  }
  if (String(s.autoRenamePrompt || "").length > AUTO_RENAME_PROMPT_MAX) {
    errors.push({ field: "autoRenamePrompt", message: `命名提示词不能超过 ${AUTO_RENAME_PROMPT_MAX} 个字符` });
  }
  if (!intIn(p.contextChars, MIN_CONTEXT_CHARS, MAX_CONTEXT_CHARS)) {
    errors.push({ field: "contextChars", message: "上下文字符需在 2000–40000 之间" });
  }
  if (!intIn(p.knowledgeChars, KNOWLEDGE_MIN_CHARS, KNOWLEDGE_MAX_CHARS)) {
    errors.push({ field: "knowledgeChars", message: "知识区字符需在 1000–20000 之间" });
  }
  if (!intIn(p.historyTurns, 0, MAX_HISTORY_TURNS)) {
    errors.push({ field: "historyTurns", message: "历史轮数需在 0–12 之间" });
  }
  return errors;
}

function uniqueModels(list: unknown): string[] {
  const out: string[] = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const m = String(raw || "").trim();
    if (m && !out.includes(m)) out.push(m);
  }
  return out;
}

/**
 * 组装传给 plugin.updateAiSettings 的补丁。
 * 只包含本窗口拥有的键；凭据同时写入激活平台与顶层镜像，避免下一次
 * normalize 用平台值把顶层盖回去。
 */
export function buildSettingsPatch(draft: AiSettingsDraft): Record<string, any> {
  const s = draft.settings;
  const baseUrl = String(s.baseUrl || "").trim().replace(/\/+$/, "");
  const apiKey = String(s.apiKey || "").trim();
  const model = String(s.model || "").trim();
  let models = uniqueModels(s.models);
  if (model && !models.includes(model)) models = [model, ...models];
  const platforms = clone(Array.isArray(s.platforms) ? s.platforms : []);
  let activeId = String(s.activePlatformId || "");
  if (!platforms.length) {
    platforms.push({
      id: "reader-ai",
      name: "阅读 AI",
      baseUrl,
      apiKey,
      models,
      modelParams: clone(s.modelParams || {}),
    });
    activeId = "reader-ai";
  } else {
    const target = platforms.find((p) => p.id === activeId) || platforms[0];
    target.baseUrl = baseUrl;
    target.apiKey = apiKey;
    target.models = models;
    target.modelParams = clone(s.modelParams || {});
    activeId = target.id;
  }
  // 命名平台/模型：跟随当前（空）或指定平台；无效平台与模型一律回落到安全值
  let autoRenamePlatformId = String(s.autoRenamePlatformId || "").trim();
  let autoRenameModel = String(s.autoRenameModel || "").trim();
  if (!autoRenamePlatformId) {
    autoRenameModel = "";
  } else {
    const renamePlat = platforms.find((p) => p.id === autoRenamePlatformId);
    if (!renamePlat) {
      autoRenamePlatformId = "";
      autoRenameModel = "";
    } else if (!renamePlat.models.includes(autoRenameModel)) {
      autoRenameModel = renamePlat.models[0] || "";
    }
  }
  const autoRenamePrompt =
    String(s.autoRenamePrompt || "").trim().slice(0, AUTO_RENAME_PROMPT_MAX) || DEFAULT_AUTO_RENAME_PROMPT;
  return {
    baseUrl,
    apiKey,
    model,
    models,
    temperature: Math.min(2, Math.max(0, Number(s.temperature) || 0)),
    maxTokens: Math.min(32768, Math.max(16, Math.round(Number(s.maxTokens) || 2048))),
    modelParams: clone(s.modelParams || {}),
    platforms,
    activePlatformId: activeId,
    sendShortcut: s.sendShortcut === "mod+enter" ? "mod+enter" : "enter",
    fontSize: Math.min(24, Math.max(10, Math.round(Number(s.fontSize) || 14))),
    inputFontSize: Math.min(24, Math.max(10, Math.round(Number(s.inputFontSize) || 13))),
    streamThrottleMs: Math.min(500, Math.max(0, Math.round(Number(s.streamThrottleMs) || 0))),
    sessionRetentionDays: Math.min(365, Math.max(0, Math.round(Number(s.sessionRetentionDays) || 0))),
    autoRenameSession: s.autoRenameSession === true,
    autoRenamePlatformId,
    autoRenameModel,
    autoRenamePrompt,
  };
}

/** 设置窗口保存成功后的本地偏好快照（写 localStorage 前再归一化一次） */
export function savePrefsPatch(prefs: AiPanelPrefs): AiPanelPrefs {
  return normalizeAiPanelPrefs(prefs);
}

/** 字号生效值：设置缺失时给面板一个明确默认（消息 14 / 输入 13），而不是 CSS 兜底 */
export function fontSizesOf(settings: any): { message: number; input: number } {
  const s = settings || {};
  const num = (v: any, fallback: number) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(24, Math.max(10, n)) : fallback;
  };
  return { message: num(s.fontSize, 14), input: num(s.inputFontSize, 13) };
}

export function normalizeSkin(v: unknown): AiSkin {
  return v === "paper" ? "paper" : "auto";
}

export { DEFAULT_AI_PANEL_PREFS };
