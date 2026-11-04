/**
 * Reader × Copilot AI 桥（前端侧）
 * ----------------------------------------------------------------
 * 内核 kernel.js 注册 MCP 工具 → `siyuan.rpc.broadcast("reader-bridge:request")`
 * → 本文件收到后转给「当前活动 ReaderView」的导出方法 → 用
 * `plugin.kernel.rpc.call["reader-bridge:response"]` 把结果回传内核。
 *
 * 只做三件事：路由、活动阅读器选择、多窗口防重复应答。
 * 参数校验与文本口径一律在 ReaderView / reader-bridge-protocol.ts，
 * 这里不复制第二份规则。
 */
import { getAnnotationStore } from "../annotation/store-singleton.ts";
import { getLogger } from "../core/logger.ts";
import {
  AI_BRIDGE_ERROR_TEXT,
  BRIDGE_REQUEST_EVENT,
  BRIDGE_RESPONSE_METHOD,
  type AiBridgeError,
} from "./reader-bridge-protocol.ts";

interface BridgeRequest {
  id?: string;
  method?: string;
  params?: any;
}

interface TabsLike {
  getActiveReader(): { bookId: string; comp: any; tab: any } | null;
}

/** 无书窗口的应答延迟：给「真正开着书的窗口」留出先答的窗口期 */
const NO_READER_DELAY = 400;
/** 有书但窗口未聚焦时的应答延迟（多窗口并排时优先让聚焦窗口作答） */
const UNFOCUSED_DELAY = 250;

let pluginRef: any = null;
let tabsRef: TabsLike | null = null;
let bound = false;

function activeComp(): any {
  try {
    return tabsRef?.getActiveReader?.()?.comp ?? null;
  } catch {
    return null;
  }
}

function isFocused(): boolean {
  try {
    return typeof document !== "undefined" && document.hasFocus();
  } catch {
    return true;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function fail(error: AiBridgeError, extra?: Record<string, unknown>) {
  return { ok: false as const, error, message: AI_BRIDGE_ERROR_TEXT[error], ...(extra || {}) };
}

/** 给顶层与逐条结果补上中文说明（错误码由 ReaderView 产出，文案只此处一份） */
function decorateResult(result: any): any {
  if (!result || typeof result !== "object") return result;
  const out = { ...result };
  if (out.ok === false && out.message === undefined && typeof out.error === "string") {
    out.message = (AI_BRIDGE_ERROR_TEXT as Record<string, string>)[out.error] || out.error;
  }
  if (Array.isArray(out.results)) {
    out.results = out.results.map((r: any) => {
      if (!r || typeof r !== "object" || r.ok !== false || typeof r.error !== "string") return r;
      return {
        ...r,
        message: (AI_BRIDGE_ERROR_TEXT as Record<string, string>)[r.error] || r.error,
      };
    });
  }
  return out;
}

/** 读取当前书状态（附带批注总数，AI 不必再单独查一次） */
function handleState() {
  const comp = activeComp();
  if (!comp || typeof comp.getReaderAiState !== "function") return fail("no_reader_open");
  const state = comp.getReaderAiState();
  if (!state?.ok) return fail("no_reader_open");
  let annotationCount = 0;
  try {
    if (state.bookId) annotationCount = getAnnotationStore().getByBook(state.bookId).length;
  } catch {
    /* 批注库未就绪时不影响状态读取 */
  }
  return { ...state, annotationCount };
}

async function handleGetChapter(params: any) {
  const comp = activeComp();
  if (!comp || typeof comp.getChapterSnapshot !== "function") return fail("no_reader_open");
  return await comp.getChapterSnapshot({
    sectionIndex: params?.sectionIndex,
    fromPara: params?.fromPara,
    maxChars: params?.maxChars,
  });
}

async function handleLocate(params: any) {
  const comp = activeComp();
  if (!comp || typeof comp.locateAiQuote !== "function") return fail("no_reader_open");
  return await comp.locateAiQuote({ quote: params?.quote, sectionIndex: params?.sectionIndex });
}

async function handleAnnotate(params: any) {
  const comp = activeComp();
  if (!comp || typeof comp.applyAiAnnotations !== "function") return fail("no_reader_open");
  return await comp.applyAiAnnotations(params?.items, {
    // 缺省即预演：AI 必须显式传 dryRun=false 才真正写入
    dryRun: params?.dryRun !== false,
    sectionIndex: params?.sectionIndex,
  });
}

function handleListAnnotations(params: any) {
  const comp = activeComp();
  const state = comp && typeof comp.getReaderAiState === "function" ? comp.getReaderAiState() : null;
  const bookId = String(params?.bookId || state?.bookId || "");
  if (!bookId) return fail("no_reader_open");
  const origin = String(params?.origin || "").toLowerCase();
  let all: any[] = [];
  try {
    all = getAnnotationStore().getByBook(bookId);
  } catch {
    return fail("internal");
  }
  const filtered = origin === "ai" || origin === "manual" ? all.filter((a) => a.origin === origin) : all;
  return {
    ok: true,
    bookId,
    title: state?.title || "",
    total: all.length,
    returned: Math.min(filtered.length, 200),
    items: filtered.slice(0, 200).map((a) => ({
      id: a.id,
      quote: a.selectedText || a.sentence || "",
      note: a.note || "",
      style: a.style || "highlight",
      color: a.color || "",
      origin: a.origin || "manual",
      cfi: a.cfi || "",
      createdAt: a.createdAt || "",
    })),
  };
}

async function dispatch(method: string, params: any) {
  switch (method) {
    case "reader.state":
      return handleState();
    case "reader.get_chapter":
      return await handleGetChapter(params);
    case "reader.locate":
      return await handleLocate(params);
    case "reader.annotate":
      return await handleAnnotate(params);
    case "reader.list_annotations":
      return handleListAnnotations(params);
    default:
      return fail("unknown_method", { method });
  }
}

async function handleRequest(payload: BridgeRequest): Promise<void> {
  const id = payload?.id;
  if (typeof id !== "string" || !id) return;
  const comp = activeComp();
  // 多窗口：聚焦且开着书的窗口先答；其余窗口延后一档，避免空窗口抢先回 no_reader_open
  if (!comp) await delay(NO_READER_DELAY);
  else if (!isFocused()) await delay(UNFOCUSED_DELAY);

  let result: any;
  try {
    result = decorateResult(await dispatch(String(payload?.method || ""), payload?.params || {}));
  } catch (e) {
    getLogger().warn("[RE 阅读器] AI 桥请求处理失败", { method: payload?.method, error: e });
    result = fail("internal");
  }

  const call = pluginRef?.kernel?.rpc?.call;
  if (!call?.[BRIDGE_RESPONSE_METHOD]) {
    getLogger().warn("[RE 阅读器] AI 桥不可用：kernel.rpc 未就绪");
    return;
  }
  try {
    await call[BRIDGE_RESPONSE_METHOD]({ id, result });
  } catch (e) {
    getLogger().warn("[RE 阅读器] AI 桥回传失败", { error: e });
  }
}

/** 插件 onload 调用：绑定内核广播 */
export function initReaderBridge(plugin: any, tabs: TabsLike): void {
  if (bound) return;
  pluginRef = plugin;
  tabsRef = tabs;
  const bind = plugin?.kernel?.rpc?.bind;
  if (typeof bind !== "function") {
    getLogger().warn("[RE 阅读器] AI 桥未启用：内核插件未运行（plugin.kernel 缺失）");
    return;
  }
  try {
    bind.call(plugin.kernel.rpc, BRIDGE_REQUEST_EVENT, handleRequest);
    bound = true;
    getLogger().info("[RE 阅读器] AI 桥已就绪");
  } catch (e) {
    getLogger().warn("[RE 阅读器] AI 桥绑定失败", { error: e });
  }
}

/** 插件 onunload 调用：解绑 */
export function disposeReaderBridge(): void {
  if (bound) {
    try {
      pluginRef?.kernel?.rpc?.unbind?.(BRIDGE_REQUEST_EVENT);
    } catch {
      /* 内核已卸载时忽略 */
    }
  }
  bound = false;
  pluginRef = null;
  tabsRef = null;
}
