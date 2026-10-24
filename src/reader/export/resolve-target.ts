/**
 * 导出目标解析（2026-10-09 新建）
 * ----------------------------------------------------------------
 * ## 唯一的职责：把「往哪儿写」这件事收敛到一个函数里
 *
 * 改造前写入端直接 `String(settings.exportDocId || "").trim()`
 * 写在 `ReaderView.exportAnnotsToDoc` 内，只管全局单值。
 * 现在有两个来源（per-book 与全局兜底），若散落在多处判断，
 * 迟早会出现「设置里显示绑了 A、导出却发到 B」这种不一致。
 *
 * ## 优先级（用户 2026-10-09 拍板：per-book 为**唯一来源**）
 *
 * ```
 * BookMeta.notebookTarget.docId   ← 每本书独立设置（唯一真源）
 *   ↓ 没有则
 * settings.exportDocId            ← 全局兜底
 *   ↓ 也没有
 * null（未配置）→ 调用方给引导提示
 * ```
 *
 * ⚠️ 为什么**保留**全局兜底而不是直接报错：
 * 用户说"现在测试没有用户"，所以不必为老数据迁移操心；
 * 但保留兜底仍然有两个好处：
 * ① 书架里没绑过的书不会突然不能导出（用户可能只想临时用一次）；
 * ② 灰度期间不会因为"忘了绑"而阻断功能。
 * 若将来要改成严格模式，只需把`ALLOW_GLOBAL_FALLBACK` 置false，
 * 不用动所有调用点。
 */

import { autoBindByTitle, type AutoBindResult } from "./auto-bind.ts";

/** 解析结果（显式区分「有目标」与「没目标」，不用空串当哨兵） */
export interface ResolvedTarget {
  docId: string;
  /** 目标文档标题；per-book 绑定时来自 BookMeta，全局时来自 settings */
  docTitle?: string;
  /** 所属笔记本名（展示用） */
  notebookName?: string;
  /** 目标来自哪里 —— UI 要靠它告诉用户"这是本书的设置"还是"全局兜底" */
  from: "book" | "global";
}

/**
 * 全局兜底开关。
 *
 * 留true 是为了不阻断「书架里没绑过的书」；
 * 改成 false 即为严格模式（per-book 未设直接提示去设置）。
 */
export const ALLOW_GLOBAL_FALLBACK = true;

/**
 * 解析导出目标。
 *
 * @param bookId 当前书id
 * @param bookMeta 当前书的元信息（`store.get(bookId)` 的结果）
 * @param settings 宿主settings（用于全局兜底）
 */
export function resolveExportTarget(
  bookId: string | null | undefined,
  bookMeta: { notebookTarget?: { docId?: string; docTitle?: string; notebookName?: string } } | null | undefined,
  settings: { exportDocId?: string; exportDocTitle?: string; exportNotebookName?: string } | null | undefined,
): ResolvedTarget | null {
  // ① per-book（唯一真源）
  const t = bookMeta?.notebookTarget;
  const perBook = String(t?.docId ?? "").trim();
  if (perBook) {
    return {
      docId: perBook,
      docTitle: t?.docTitle?.trim() || undefined,
      notebookName: t?.notebookName?.trim() || undefined,
      from: "book",
    };
  }
  // ② 全局兜底
  if (ALLOW_GLOBAL_FALLBACK) {
    const g = String(settings?.exportDocId ?? "").trim();
    if (g) {
      return {
        docId: g,
        docTitle: settings?.exportDocTitle?.trim() || undefined,
        notebookName: settings?.exportNotebookName?.trim() || undefined,
        from: "global",
      };
    }
  }
  // ③ 未配置
  void bookId; // 保留参数：将来做"按书名自动建档"时会用到
  return null;
}

/**
 * 异步解析导出目标（2026-10-10 列表化收敛新增）。
 *
 * 与 `resolveExportTarget` 的区别：在「per-book → 全局兜底」之后，
 * 多一步**导出时自动建档兜底**——适合那些「懒得一本本设、但希望导出时
 * 自动落进一篇《书名》文档」的场景。
 *
 * 优先级（沿用同步版的三段式 + 兜底建档）：
 *
 * ```
 * BookMeta.notebookTarget.docId   ← 每本书独立设置（唯一真源）→ 不建档
 *   ↓
 * settings.exportDocId            ← 全局兜底 → 不建档
 *   ↓
 * autoArchiveEnabled && autoNotebookId → autoBindByTitle 建/复用《书名》并绑定
 *   ↓ 都没命中
 * null（未配置）→ 调用方给引导提示
 * ```
 *
 * ⚠️ 自动建档是**副作用**：会真的建文档并写 BookMeta。故本函数返回
 *   `{ target, autoCreated }`，且建档失败不致命（降级为 null，由调用方提示）。
 *
 * @param store 书架 store（建档回填用；缺失则跳过兜底建档）
 */
export async function resolveExportTargetAsync(
  bookId: string | null | undefined,
  bookMeta: { notebookTarget?: { docId?: string; docTitle?: string; notebookName?: string }; title?: string } | null | undefined,
  settings: {
    exportDocId?: string;
    exportDocTitle?: string;
    exportNotebookName?: string;
    autoNotebookId?: string;
    autoNotebookName?: string;
    autoArchivePath?: string;
    autoArchiveEnabled?: boolean;
  } | null | undefined,
  store?: any,
): Promise<{ target: ResolvedTarget | null; autoCreated: boolean }> {
  // ① per-book（唯一真源）
  const t = bookMeta?.notebookTarget;
  const perBook = String(t?.docId ?? "").trim();
  if (perBook) {
    return {
      target: {
        docId: perBook,
        docTitle: t?.docTitle?.trim() || undefined,
        notebookName: t?.notebookName?.trim() || undefined,
        from: "book",
      },
      autoCreated: false,
    };
  }
  // ② 全局兜底
  if (ALLOW_GLOBAL_FALLBACK) {
    const g = String(settings?.exportDocId ?? "").trim();
    if (g) {
      return {
        target: {
          docId: g,
          docTitle: settings?.exportDocTitle?.trim() || undefined,
          notebookName: settings?.exportNotebookName?.trim() || undefined,
          from: "global",
        },
        autoCreated: false,
      };
    }
  }
  // ③ 自动建档兜底（仅当开关开 + 锚点已设 + 有书架 + 有书 id）
  const nbId = String(settings?.autoNotebookId ?? "").trim();
  const enabled = settings?.autoArchiveEnabled !== false;
  if (store && bookId && nbId && enabled) {
    try {
      const r: AutoBindResult = await autoBindByTitle(
        store,
        String(bookId),
        String(bookMeta?.title ?? "").trim(),
        nbId,
        String(settings?.autoNotebookName ?? "").trim(),
        String(settings?.autoArchivePath ?? "").trim(),
      );
      return {
        target: {
          docId: r.docId,
          docTitle: String(bookMeta?.title ?? "").trim(),
          notebookName: String(settings?.autoNotebookName ?? "").trim(),
          from: "book",
        },
        autoCreated: r.created,
      };
    } catch (__e) {
      // 建档失败不致命：降级为「未配置」，由调用方引导去设置
      return { target: null, autoCreated: false };
    }
  }
  // ④ 未配置
  return { target: null, autoCreated: false };
}

/** 给用户看的目标描述（toast / 设置行用） */
export function describeTarget(t: ResolvedTarget | null): string {
  if (!t) return "";
  if (t.docTitle) return t.from === "book" ? `《${t.docTitle}》` : `《${t.docTitle}》（全局）`;
  // 没有标题（多半是手动粘贴的 ID）⇒ 截短 ID 让人还能辨认
  const short = t.docId.length > 12 ? `${t.docId.slice(0, 8)}…` : t.docId;
  return t.from === "book" ? short : `${short}（全局）`;
}
