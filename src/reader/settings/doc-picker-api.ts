/**
 * 文档选择页专用的思源 API 加载器（2026-10-09 新建）
 * ----------------------------------------------------------------
 * ## 为什么单独建这个文件（而不是直接 import 整个 api.ts）
 *
 * 改造前 `ReaderView.svelte:595-602` 直接 `import("../siyuan/api.ts")`，
 * 有**两个叠加的缺陷**：
 *
 * ① **耦合面过大**：`api.ts` 顶层 `import { fetchPost, openTab, … } from "siyuan"`
 *    （思源运行时模块），而它导出了 60+ 个函数，其中 `openTab` / `addRiffCards` /
 *    `platformUtils` 等与「选一篇文档」毫无关系。任何一处出问题都会连带拖垮本页。
 * ② **失败原因不可见**：`.catch` 只写 debug 级日志 ⇒ UI 上只能显示
 *    `DocumentPickerPage:88` 那句笼统的「未接入思源 API，只能手动粘贴文档 ID」。
 *    **用户看到的提示是误导的** —— 不是"没写"，是"没加载出来"，
 *    而真实原因（思源运行时模块拿不到）被日志吞了。
 *
 * 本模块按 `translate/sqlite-cache.ts:78-92` 的既有 `loadApi()` 模式重写：
 * ① 只挂真正需要的函数 ② 失败时**留存原因**供 UI 展示 ③ 失败结果缓存，不重复重试。
 */

/** 文档列表项（与 `api.ts` 的 DocSummary 形状一致） */
export interface DocPickerDoc {
  id: string;
  name: string;
  hpath: string;
  /** 所属笔记本 id（= blocks.box；⚠️ hpath 不含笔记本名，按笔记本分组靠它，2026-10-10 新增） */
  notebookId?: string;
  updated?: number;
}

/**
 * 文档选择页需要的最小接口。
 *
 * ⚠️ **刻意不 import 整个 `api.ts` 的类型** —— 那会把 `siyuan` 运行时模块
 * 的类型拖进来，单测环境（无思源窗口）直接编译失败。这里全部用本地最小类型。
 */
export interface DocPickerApi {
  listDocuments(limit?: number): Promise<DocPickerDoc[]>;
  searchDocuments(keyword: string, limit?: number): Promise<DocPickerDoc[]>;
  /** 取文档完整正文；用于写入前探活（目标文档是否还存在） */
  getDoc(id: string): Promise<unknown>;
  /** 新建文档（按书名自动建档用） */
  createDocWithMd?(notebook: string, path: string, markdown: string): Promise<string>;
  /** 列出所有笔记本（自动建档位置选择 / 校验用，2026-10-10 新增） */
  listNotebooks?(): Promise<{ id: string; name: string }[]>;
  /** 追加块（导出摘录用） */
  appendBlock(parentId: string, dataType: string, data: string): Promise<unknown>;
  /** 设置块属性（模板的「块属性」功能用；实测 `::xxx` 文本写法在思源 3.8.6 无效） */
  setBlockAttrs?(id: string, attrs: Record<string, string>): Promise<unknown>;
  /** 查块（写属性前需要先拿到刚写入的块 ID——appendBlock 不返回） */
  sql?(stmt: string): Promise<unknown[]>;
}

/* 模块级缓存。三种状态：未加载 / 成功 / 失败。
 * 失败也缓存 —— 否则每次开页面都重试一次必然失败的 import。 */
let cached: DocPickerApi | null = null;
let loading: Promise<DocPickerApi | null> | null = null;
let failReason = "";

/**
 * 加载思源 API（惰性，成功后缓存）。
 *
 * 🔴 与改造前的关键区别：**失败时把原因存进 `failReason`**，
 * 由`getDocPickerFailReason()` 交给 UI 展示，而不是只写 debug 日志。
 */
export async function loadDocPickerApi(): Promise<DocPickerApi | null> {
  if (cached) return cached;
  if (!loading) {
    loading = import("../../siyuan/api.ts")
      .then((m: any) => {
        // ⚠️ 逐个检查存在性：api.ts 若将来改了导出名，这里要能**明确报出缺哪个**，
        //   而不是让下游在调用时才炸出一个 undefined is not a function。
        const missing: string[] = [];
        const need = ["listDocuments", "searchDocuments", "getDoc", "appendBlock"] as const;
        for (const k of need) {
          if (typeof m?.[k] !== "function") missing.push(k);
        }
        if (missing.length) {
          throw new Error(`思源接口缺少方法：${missing.join("、")}`);
        }
        cached = {
          listDocuments: m.listDocuments,
          searchDocuments: m.searchDocuments,
          getDoc: m.getDoc,
          createDocWithMd: m.createDocWithMd,
          /**
           * ⚠️ **必须做参数重排**（2026-10-10 真机修复）。
           *
           * 底层 `siyuan/api.ts` 的签名是 `appendBlock(dataType, data, parentID)`
           * —— dataType 在**前**；而本接口对外声明的是 `appendBlock(parentId, dataType, data)`
           * —— 文档 id 在**前**（对 UI 层更自然：主语是"往哪写"）。
           *
           * 之前直接 `appendBlock: m.appendBlock` 原样透传 ⇒ 两套顺序不匹配，
           * 调用方按 (docId, "markdown", md) 传入，内核实际收到
           * dataType=docId、data="markdown"、parentID=md
           * ⇒ 真机报错 `dataType must be markdown or dom v3.8.6`，文字根本没写进去。
           *
           * 同理 `setBlockAttrs(id, attrs)` / `sql(stmt)` 是具名参数、顺序一致，无需重排。
           */
          appendBlock: (parentId: string, dataType: string, data: string) =>
            m.appendBlock(dataType, data, parentId),
          setBlockAttrs: m.setBlockAttrs,
          sql: m.sql,
          listNotebooks: m.listNotebooks,
        };
        return cached;
      })
      .catch((e: unknown) => {
        cached = null;
        failReason = e instanceof Error ? e.message : String(e);
        // 保留 warn 级：这不是"可忽略的调试信息"，是用户会看到的失败原因
        console.warn("[RE 阅读器] 思源 API 加载失败：", failReason);
        return null;
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

/** 上次加载失败的原因（成功时为空串）。
 *  UI 必须把它显示出来 —— 否则用户永远不知道为什么只能粘贴 ID。 */
export function getDocPickerFailReason(): string {
  return failReason;
}

/**
 * 探活：目标文档是否还存在。
 *
 * 🔴 改造前 `exportAnnotsToDoc` 的 catch 一律 toast
 *   「目标文档可能已被删除」—— 但**网络失败、权限不足**也会走这句 ⇒ 误导。
 *   先探活再写，才能把「文档没了」与「写不进去」分开报。
 *
 * @returns `true` 存在 / `false` 明确不存在 / `null` 探活本身失败（网络等）
 */
export async function probeDoc(api: DocPickerApi | null, docId: string): Promise<boolean | null> {
  if (!api?.getDoc) return null;
  try {
    const r: any = await api.getDoc(docId);
    // 思源对不存在的块返回 code -1 与 "not found" 类message；
    // 正常返回的 data 里会有 markdown 或 id。
    if (r && typeof r === "object" && "code" in r && (r as any).code !== 0) {
      return false;
    }
    if (r == null) return false;
    return true;
  } catch {
    return null; // 探活失败 ≠ 文档不存在
  }
}
