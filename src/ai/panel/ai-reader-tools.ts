/**
 * AI 阅读面板 · 阅读器只读工具（P1）
 * ------------------------------------------------------------------
 * 面板内的 AI 想「自己翻书」时调用这组工具，而不是靠宿主一次性塞进来的
 * 当前章节。全部只读：写入（划线/备注）属 P2，不在这里出现。
 *
 * 口径与内核 MCP 工具（kernel.js / reader-bridge-protocol.ts）保持一致：
 * 同一套 quote 规范化、同一套章节字符预算上限。区别只是通道 ——
 * 这里是前端进程内直调 ReaderView 导出的方法，不经内核广播，延迟更低。
 *
 * 刻意不 import Svelte / siyuan：本文件要能在 node 测试里直接跑。
 */
import type { AiToolDef } from "../ai-client.ts";
import { MAX_QUOTE_CHARS, normalizeQuote } from "../reader-bridge-protocol.ts";
import { MAX_RANGE_CHAPTERS, normalizeToolRange } from "./ai-toc.ts";

/** 单次工具读章的默认/最大字符预算（比宿主预注入上下文更省，模型可按需续读） */
export const TOOL_CHAPTER_DEFAULT_CHARS = 8000;
export const TOOL_CHAPTER_MAX_CHARS = 20000;
/** 工具结果回灌给模型前的上限：超过就截断并提示缩小范围 */
export const MAX_TOOL_RESULT_CHARS = 24000;

export const READER_TOOL = {
  state: "reader_get_state",
  chapter: "reader_get_chapter",
  range: "reader_get_range",
  toc: "reader_list_toc",
  locate: "reader_locate",
  annotations: "reader_list_annotations",
} as const;

export const READER_TOOL_NAMES = Object.values(READER_TOOL);

/** 系统提示词里的工具使用说明（仅在有工具时追加） */
export const READER_TOOLS_PROMPT = `【阅读工具】
你可以调用工具读取本书（只读，不会改动正文或批注）：
- reader_get_state：看当前书、章节与格式；
- reader_list_toc：看全书目录与章节序号（找不到章节时先用它）；
- reader_get_chapter：读任意一章正文，一次一章；结果里的 nextFromPara 非空时可用 fromPara 续读；
- reader_get_range：一次读连续几章（≤${MAX_RANGE_CHAPTERS} 章）；章节序号从 0 起，fromSection/toSection 含两端；
- reader_locate：在当前章内核对一段原文是否存在（逐字匹配，≤${MAX_QUOTE_CHARS} 字）；
- reader_list_annotations：列出一本书已有的划线/备注。
需要当前章节以外的内容、或要核对引文时先调用工具，不要凭空编造。一次只取必要的部分，不要反复整章重读。`;

/** 宿主（ReaderView）注入的只读能力 */
export interface ReaderToolHost {
  getState(): any;
  getChapter(opts: { sectionIndex?: number; fromPara?: number; maxChars?: number }): Promise<any>;
  getRange(opts: { fromSection?: number; toSection?: number; maxChars?: number }): Promise<any>;
  listToc(): Promise<any>;
  locate(opts: { quote: string; sectionIndex?: number }): Promise<any>;
  listAnnotations(opts: { origin?: string }): Promise<any>;
}

export interface ReaderToolExecution {
  name: string;
  /** 给用户看的一句话（工具轨迹） */
  label: string;
  ok: boolean;
  error?: string;
  data?: any;
}

function intOrUndefined(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

export function clampToolChapterChars(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return TOOL_CHAPTER_DEFAULT_CHARS;
  return Math.min(TOOL_CHAPTER_MAX_CHARS, Math.max(500, Math.floor(n)));
}

/** 模型传来的 arguments 是 JSON 字符串；坏 JSON 不抛错，交给调用方回一条 tool 消息 */
export function parseToolArguments(raw: unknown): { ok: true; args: any } | { ok: false; error: string } {
  if (raw == null || raw === "") return { ok: true, args: {} };
  if (typeof raw === "object") return { ok: true, args: Array.isArray(raw) ? {} : raw };
  try {
    const v = JSON.parse(String(raw));
    return { ok: true, args: v && typeof v === "object" && !Array.isArray(v) ? v : {} };
  } catch {
    return { ok: false, error: "工具参数不是合法 JSON" };
  }
}

export function buildReaderToolDefs(): AiToolDef[] {
  return [
    {
      type: "function",
      function: {
        name: READER_TOOL.state,
        description: "查看当前阅读器状态：书名、格式、当前章节、总章数。",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    {
      type: "function",
      function: {
        name: READER_TOOL.chapter,
        description:
          "读取一章正文（一次一章）。缺省读当前章；结果含 paragraphs（段号 i 与文本）、" +
          "truncated 与 nextFromPara，超长时用 fromPara 续读。",
        parameters: {
          type: "object",
          properties: {
            sectionIndex: { type: "integer", description: "章节序号（0 起），缺省为当前章" },
            fromPara: { type: "integer", description: "续读起点：上一次返回的 nextFromPara" },
            maxChars: {
              type: "integer",
              description: `本次字符预算，默认 ${TOOL_CHAPTER_DEFAULT_CHARS}，上限 ${TOOL_CHAPTER_MAX_CHARS}`,
            },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: READER_TOOL.range,
        description:
          `一次读取连续几章正文（≤${MAX_RANGE_CHAPTERS} 章，字符预算按章均分）。` +
          "章节序号从 0 起，fromSection/toSection 均含两端；结果按章给出段落、截断与续读提示。",
        parameters: {
          type: "object",
          properties: {
            fromSection: { type: "integer", description: "起始章节序号（0 起）" },
            toSection: { type: "integer", description: "结束章节序号（0 起，含）；缺省为 fromSection 同一章" },
            maxChars: {
              type: "integer",
              description: `本次字符预算，默认 ${TOOL_CHAPTER_DEFAULT_CHARS}，上限 ${TOOL_CHAPTER_MAX_CHARS}`,
            },
          },
          required: ["fromSection"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: READER_TOOL.toc,
        description: "查看本书目录：每项含 sectionIndex、层级与标题。找不到章节时先用它。",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    {
      type: "function",
      function: {
        name: READER_TOOL.locate,
        description: "在当前章里逐字核对一段原文并返回位置（只读）。quote 必须来自工具或上下文里的正文。",
        parameters: {
          type: "object",
          properties: {
            quote: { type: "string", description: `原文片段，逐字复制，≤${MAX_QUOTE_CHARS} 字` },
            sectionIndex: { type: "integer", description: "章节序号（0 起），缺省为当前章" },
          },
          required: ["quote"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: READER_TOOL.annotations,
        description: "列出当前书已有的划线/备注（最多 200 条）。",
        parameters: {
          type: "object",
          properties: {
            origin: { type: "string", enum: ["manual", "ai"], description: "按来源筛选，缺省全部" },
          },
          required: [],
        },
      },
    },
  ];
}

/** 工具轨迹文案（模型给不出参数时也要有可读标签） */
export function readerToolLabel(name: string, args?: any): string {
  const sec = intOrUndefined(args?.sectionIndex);
  switch (name) {
    case READER_TOOL.state:
      return "查看阅读状态";
    case READER_TOOL.chapter: {
      const where = sec !== undefined ? `第 ${sec + 1} 章` : "当前章节";
      const from = intOrUndefined(args?.fromPara);
      return from !== undefined && from > 0 ? `读取${where}（从第 ${from + 1} 段起）` : `读取${where}`;
    }
    case READER_TOOL.range: {
      const a = intOrUndefined(args?.fromSection);
      const b = intOrUndefined(args?.toSection);
      if (a === undefined) return "读取章节范围";
      const lo = Math.min(a, b ?? a);
      const hi = Math.max(a, b ?? a);
      return lo === hi ? `读取第 ${lo + 1} 章` : `读取第 ${lo + 1}–${hi + 1} 章`;
    }
    case READER_TOOL.toc:
      return "查看目录";
    case READER_TOOL.locate: {
      const q = String(args?.quote || "").trim().replace(/\s+/g, " ");
      return q ? `核对原文：${q.length > 18 ? q.slice(0, 18) + "…" : q}` : "核对原文";
    }
    case READER_TOOL.annotations:
      return args?.origin === "ai" ? "查看 AI 写的批注" : args?.origin === "manual" ? "查看手动批注" : "查看已有批注";
    default:
      return name || "调用工具";
  }
}

function failure(name: string, label: string, error: string): ReaderToolExecution {
  return { name, label, ok: false, error };
}

/**
 * 执行一次工具调用。
 * 参数在这里做二次收敛（模型不一定会遵守 schema）：
 *  - 章节预算压到 500…20000；
 *  - quote 用协议层的 normalizeQuote，超长直接拒绝（避免整段模糊定位）；
 *  - sectionIndex / fromPara 只接受非负整数。
 */
export async function executeReaderTool(
  name: string,
  rawArgs: unknown,
  host: ReaderToolHost | null | undefined,
): Promise<ReaderToolExecution> {
  const parsed = parseToolArguments(rawArgs);
  const label = readerToolLabel(name, parsed.ok ? parsed.args : {});
  if (!parsed.ok) return failure(name, label, parsed.error);
  const args = parsed.args || {};
  if (!host) return failure(name, label, "阅读器未就绪");

  try {
    if (name === READER_TOOL.state) {
      const r = await host.getState();
      return finish(name, label, r);
    }
    if (name === READER_TOOL.chapter) {
      const r = await host.getChapter({
        sectionIndex: intOrUndefined(args.sectionIndex),
        fromPara: intOrUndefined(args.fromPara),
        maxChars: clampToolChapterChars(args.maxChars),
      });
      return finish(name, label, r);
    }
    if (name === READER_TOOL.range) {
      const r = normalizeToolRange(args);
      if (!r.ok) return failure(name, label, r.error);
      const out = await host.getRange({
        fromSection: r.from,
        toSection: r.to,
        maxChars: clampToolChapterChars(args.maxChars),
      });
      return finish(name, label, out);
    }
    if (name === READER_TOOL.toc) {
      const r = await host.listToc();
      return finish(name, label, r);
    }
    if (name === READER_TOOL.locate) {
      const quote = normalizeQuote(args.quote);
      if (!quote) return failure(name, label, "quote 不能为空");
      if (quote.length > MAX_QUOTE_CHARS) return failure(name, label, `quote 过长（上限 ${MAX_QUOTE_CHARS} 字）`);
      const r = await host.locate({ quote, sectionIndex: intOrUndefined(args.sectionIndex) });
      return finish(name, label, r);
    }
    if (name === READER_TOOL.annotations) {
      const origin = args.origin === "ai" || args.origin === "manual" ? args.origin : undefined;
      const r = await host.listAnnotations({ origin });
      return finish(name, label, r);
    }
    return failure(name, label, `未知工具：${name}`);
  } catch (e: any) {
    return failure(name, label, e?.message ? String(e.message).slice(0, 200) : "工具执行失败");
  }
}

function finish(name: string, label: string, r: any): ReaderToolExecution {
  if (r && typeof r === "object" && r.ok === false) {
    return { name, label, ok: false, error: String(r.error || "工具返回失败"), data: r };
  }
  return { name, label, ok: true, data: r };
}

/** 结果 → 回灌给模型的 tool 消息正文（超长时截断并明示原因） */
export function stringifyToolResult(exec: ReaderToolExecution, max = MAX_TOOL_RESULT_CHARS): string {
  const base: any = { ok: exec.ok };
  if (exec.error) base.error = exec.error;
  if (exec.data !== undefined) base.data = exec.data;
  let text = "";
  try {
    text = JSON.stringify(base);
  } catch {
    text = JSON.stringify({ ok: exec.ok, error: exec.error || "结果无法序列化" });
  }
  if (!text) text = JSON.stringify({ ok: exec.ok });
  if (text.length <= max) return text;
  return JSON.stringify({
    ok: exec.ok,
    truncated: true,
    note: "结果过长已截断。请缩小 maxChars、改用 fromPara 续读，或把整段范围拆成几次 reader_get_range。",
    preview: text.slice(0, max),
  });
}

/** 从模型给出的工具执行结果取展示用轨迹（失败也保留，便于用户判断为什么答偏） */
export function toTrace(exec: ReaderToolExecution): { label: string; ok: boolean; error?: string } {
  const out: { label: string; ok: boolean; error?: string } = { label: exec.label, ok: exec.ok };
  if (!exec.ok && exec.error) out.error = exec.error;
  return out;
}
