/**
 * 按书名自动建档并绑定（2026-10-10 新增，方案 B）
 * ----------------------------------------------------------------
 * ## 职责
 * 把「给某本书单开一篇《书名》文档并绑定为本书发送目标」这件事收敛到一个函数。
 *
 * ## 核心约束（G5）
 * - `autoNotebookId` 必填：未选归档笔记本 → 直接抛错，绝不落到未知位置。
 * - **落点固定**：所有自动建档文档统一建在 `/笔记本/归档子路径/《书名》`，
 *   所有书聚在用户指定的固定角落，互不串味。
 * - **幂等**：按「书名 + 固定落点」在 blocks 表里查重，命中则复用，
 *   重复导出 / 重复点击不会建出第二篇同名文档。
 *
 * ## 不做什么
 * - 不引入新的持久状态：建档后 `store.setNotebookTarget` 固化为普通绑定（mode=bound），
 *   后续完全复用 `resolve-target.ts` 的 per-book → 全局兜底链路。
 * - 不改解析优先级、写入链、块属性补挂——那些与显式绑定完全共用。
 */

import { t } from "../../i18n/index.ts";
import { loadDocPickerApi } from "../settings/doc-picker-api.ts";

/** 自动建档结果 */
export interface AutoBindResult {
  /** 目标文档 ID（复用或新建） */
  docId: string;
  /** 是否本次新建（false = 查重命中复用） */
  created: boolean;
  /** 文档相对笔记本根的路径（如 `/RE阅读器/三体`） */
  hpath: string;
}

/** SQL 单引号转义（书名可能含引号） */
function escSql(s: string): string {
  return s.replace(/'/g, "''");
}

/** 把书名里的 `/` 换成 `-`，避免 createDocWithMd 把书名当多级路径 */
function safeTitle(title: string): string {
  return title.replace(/\//g, "-").trim();
}

/**
 * 按书名自动建档并绑定为本书的笔记发送目标。
 *
 * @param store        书架 store（需有 `setNotebookTarget(bookId, target)`）
 * @param bookId       当前书 id
 * @param bookTitle    书名（作为文档标题；会自动 sanitize）
 * @param notebookId   自动建档笔记本 ID（必填）
 * @param notebookName 自动建档笔记本名（展示用，与 id 一并回填）
 * @param archivePath  归档子路径（可选，首尾 `/` 会被规整掉）
 */
export async function autoBindByTitle(
  store: any,
  bookId: string,
  bookTitle: string,
  notebookId: string,
  notebookName: string,
  archivePath: string,
): Promise<AutoBindResult> {
  const nb = String(notebookId || "").trim();
  const title = safeTitle(String(bookTitle || "").trim());
  if (!nb) {
    throw new Error(t("请先在「自动建档位置」选择归档笔记本"));
  }
  if (!title) {
    throw new Error(t("书名缺失，无法按书名建档"));
  }

  // 落点路径（相对笔记本根）：/归档子路径/书名
  const seg = String(archivePath || "").trim().replace(/^\/+|\/+$/g, "");
  const docPath = "/" + (seg ? seg + "/" : "") + title;

  const api = await loadDocPickerApi();
  if (!api) {
    throw new Error(t("思源接口未就绪，请稍后重试"));
  }

  // 校验归档笔记本仍存在（被删 / 改名 → 明确提示，不清值但中断）
  if (api.listNotebooks) {
    try {
      const nbs = (await api.listNotebooks()) || [];
      if (!nbs.some((n) => n.id === nb)) {
        throw new Error(t("归档笔记本已失效，请重新选择「自动建档位置」"));
      }
    } catch (e) {
      // 列笔记本失败不阻断建档（可能是权限），但若是我们的明确报错要透传
      if (e instanceof Error && e.message.includes("归档笔记本")) throw e;
    }
  }

  // 按书名 + 固定落点查重（幂等）
  let docId = "";
  if (api.sql) {
    try {
      const rows: any[] = await api.sql(
        `SELECT id, hpath FROM blocks WHERE type='d' AND box='${escSql(nb)}' AND content='${escSql(title)}'`,
      );
      const hit = (rows || []).find((r) => String(r?.hpath || "").endsWith(docPath));
      if (hit) docId = hit.id;
    } catch (__e) {
      // 查重失败不致命：下面会走新建，最多多建一篇；比直接放弃好
      docId = "";
    }
  }

  let created = false;
  if (!docId) {
    if (!api.createDocWithMd) {
      throw new Error(t("思源接口未就绪，无法创建文档"));
    }
    docId = await api.createDocWithMd(nb, docPath, "");
    created = true;
  }

  await store.setNotebookTarget(bookId, {
    docId,
    docTitle: title,
    notebookName: notebookName || "",
  });

  return { docId, created, hpath: docPath };
}
