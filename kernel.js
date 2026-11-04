/**
 * RE 阅读器 · 内核插件（Copilot MCP 工具）
 * ==================================================================
 * 为什么需要两层：
 *   · 书的内容在 foliate（前端 iframe / 每章 DOM），内核拿不到；
 *   · Copilot 的 MCP 工具只能注册在内核。
 * 所以工具只做「转发 + 超时」，真实读写由前端 src/ai/reader-bridge.ts
 * 转给当前活动的 ReaderView。
 *
 * 通道名与前端 src/ai/reader-bridge-protocol.ts 是同一对常量：
 *   内核 --broadcast("reader-bridge:request")--> 前端
 *   前端 --call("reader-bridge:response")--> 内核
 *
 * 一个工具、多个 action（对标 task-note-management 的聚合式工具）：
 *   get_state / get_chapter / locate / annotate / list_annotations
 */
"use strict";

const REQUEST_EVENT = "reader-bridge:request";
const RESPONSE_METHOD = "reader-bridge:response";
/** 前端多窗口会按聚焦度错峰应答，10s 足够覆盖最慢一档 */
const REQUEST_TIMEOUT = 10000;

const ACTION_METHOD = {
  get_state: "reader.state",
  get_chapter: "reader.get_chapter",
  locate: "reader.locate",
  annotate: "reader.annotate",
  list_annotations: "reader.list_annotations",
};

const ACTIONS = Object.keys(ACTION_METHOD);

const KERNEL_ERROR_TEXT = {
  timeout: "阅读器未响应（请确认书籍已打开且思源窗口在前台）",
  bridge_unavailable: "内核广播不可用",
  unknown_action: "未知的 action",
};

class ReaderKernel {
  constructor() {
    this.siyuan = globalThis.siyuan;
    this.logger = this.siyuan && this.siyuan.logger;
    /** id -> resolve；同一时刻可有多个请求（AI 并行调用） */
    this.pending = new Map();
    this.registeredTool = "";
    this.siyuan.plugin.lifecycle.onload = this.onload.bind(this);
    this.siyuan.plugin.lifecycle.onunload = this.onunload.bind(this);
  }

  log(level, message, error) {
    try {
      const fn = this.logger && this.logger[level];
      if (typeof fn === "function") {
        Promise.resolve(fn.call(this.logger, "[RE reader kernel] " + message, error)).catch(function () {});
        return;
      }
    } catch (e) {
      /* 日志失败不影响工具 */
    }
    try {
      console.log("[RE reader kernel]", message, error || "");
    } catch (e) {
      /* goja 无 console 时静默 */
    }
  }

  async onload() {
    try {
      this.siyuan.rpc.bind(RESPONSE_METHOD, (payload) => this.onResponse(payload));
    } catch (e) {
      this.log("error", "绑定回传通道失败", e);
    }
    try {
      await this.registerCapability("reader", this.buildToolConfig(), (args) => this.handle(args));
      this.registeredTool = "reader";
      this.log("info", "reader 工具已注册");
    } catch (e) {
      this.log("error", "注册 reader 工具失败（Copilot 将看不到阅读器能力）", e);
    }
  }

  async onunload() {
    for (const id of Array.from(this.pending.keys())) this.pending.delete(id);
    try {
      this.siyuan.rpc.unbind(RESPONSE_METHOD);
    } catch (e) {
      /* 已解绑则忽略 */
    }
    if (!this.registeredTool) return;
    const name = this.registeredTool;
    this.registeredTool = "";
    try {
      if (this.siyuan.agent && typeof this.siyuan.agent.unregisterCapability === "function") {
        await this.siyuan.agent.unregisterCapability(name);
      } else if (this.siyuan.mcp && typeof this.siyuan.mcp.unregisterTool === "function") {
        await this.siyuan.mcp.unregisterTool(name);
      }
    } catch (e) {
      this.log("error", "注销 reader 工具失败", e);
    }
  }

  /**
   * 新版优先 agent.registerCapability，旧版回落 mcp.registerTool。
   * task-note-management 用同一顺序，Copilot 两种都能发现。
   */
  async registerCapability(name, config, handler) {
    if (this.siyuan.agent && typeof this.siyuan.agent.registerCapability === "function") {
      return await this.siyuan.agent.registerCapability(name, config, handler);
    }
    if (this.siyuan.mcp && typeof this.siyuan.mcp.registerTool === "function") {
      return await this.siyuan.mcp.registerTool(name, config, handler);
    }
    throw new Error("Neither siyuan.agent.registerCapability nor siyuan.mcp.registerTool is available");
  }

  buildToolConfig() {
    return {
      title: "RE 阅读器",
      description:
        "操作思源里的 RE 阅读器（EPUB/MOBI/AZW3/FB2/TXT/MD）。" +
        "Actions: " +
        "get_state(当前书、章节、格式、是否可被 AI 读取、批注数)；" +
        "get_chapter(读取一章正文，一次只读一章，超长用 fromPara 续读)；" +
        "locate(在当前章定位一段原文，只读不写)；" +
        "annotate(给当前章划线/写备注，默认 dryRun 预演，dryRun=false 才落库)；" +
        "list_annotations(列出一本书的已有批注)。" +
        "PDF/CBZ 暂不支持读取与划线。写入只能落在用户当前正在阅读的那一章。",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "操作类型",
            enum: ACTIONS,
          },
          sectionIndex: {
            type: "number",
            description: "章节序号（0 起）。get_chapter/locate 可用；缺省为当前章。",
          },          fromPara: {
            type: "number",
            description: "get_chapter 续读起点：填上一次返回的 nextFromPara",
          },
          maxChars: {
            type: "number",
            description: "get_chapter 单次字符预算，默认 12000，上限 40000",
          },
          quote: {
            type: "string",
            description:
              "locate 必填；annotate 的 items[].quote 同口径。必须从 get_chapter 返回的正文里逐字复制，≤300 字，只取一段连续文字。",
          },
          items: {
            type: "array",
            description:
              "annotate 必填：批注数组，最多 30 条。每项 { quote: string(必填, ≤300字), note?: string, style?: 'highlight'|'solid'|'wavy', color?: '#rrggbb' }。quote 必须来自当前章正文。",
            items: {
              type: "object",
              properties: {
                quote: { type: "string", description: "原文片段，逐字复制" },
                note: { type: "string", description: "备注（可选）" },
                style: {
                  type: "string",
                  enum: ["highlight", "solid", "wavy"],
                  description: "划线样式：highlight 荧光、solid 实线、wavy 波浪",
                },
                color: {
                  type: "string",
                  description: "颜色 #rrggbb（可选，缺省沿用用户上次使用的颜色）",
                },
              },
              required: ["quote"],
            },
          },
          dryRun: {
            type: "boolean",
            description:
              "annotate 专用。默认 true = 只预演定位、不写入；用户确认后再传 false 落库。",
          },
          bookId: {
            type: "string",
            description: "list_annotations 可用；缺省为当前打开的书",
          },
          origin: {
            type: "string",
            enum: ["manual", "ai"],
            description: "list_annotations 来源筛选（可选）",
          },
        },
        required: ["action"],
      },
      // 权限声明：读取走 localRead；annotate 是唯一的本地写入。
      effects: { localRead: true, localWrite: true },
      actionEffects: {
        get_state: { localRead: true },
        get_chapter: { localRead: true },
        locate: { localRead: true },
        annotate: { localRead: true, localWrite: true },
        list_annotations: { localRead: true },
      },
    };
  }

  async handle(args) {
    const action = String((args && args.action) || "");
    const method = ACTION_METHOD[action];
    if (!method) {
      return JSON.stringify({
        ok: false,
        error: "unknown_action",
        message: KERNEL_ERROR_TEXT.unknown_action,
        actions: ACTIONS,
      });
    }
    const result = await this.callFrontend(method, args || {});
    return JSON.stringify(result);
  }

  callFrontend(method, params) {
    return new Promise((resolve) => {
      const id = "re-" + Date.now() + "-" + Math.floor(Math.random() * 1e6);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: "timeout", message: KERNEL_ERROR_TEXT.timeout });
      }, REQUEST_TIMEOUT);
      this.pending.set(id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      try {
        const p = this.siyuan.rpc.broadcast(REQUEST_EVENT, { id: id, method: method, params: params });
        if (p && typeof p.catch === "function") {
          p.catch(() => {
            if (this.pending.delete(id)) {
              clearTimeout(timer);
              resolve({ ok: false, error: "bridge_unavailable", message: KERNEL_ERROR_TEXT.bridge_unavailable });
            }
          });
        }
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve({ ok: false, error: "bridge_unavailable", message: KERNEL_ERROR_TEXT.bridge_unavailable });
      }
    });
  }

  onResponse(payload) {
    const id = payload && payload.id;
    if (typeof id !== "string") return;
    const cb = this.pending.get(id);
    if (!cb) return;
    this.pending.delete(id);
    try {
      cb(payload.result);
    } catch (e) {
      this.log("error", "回传结果处理失败", e);
    }
  }
}

new ReaderKernel();
