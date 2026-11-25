/**
 * 引用式书源的字节加载（2026-11-25 C 期）
 * ---------------------------------------------------------------
 * 只做一件事：把 `{kind, uri}` 变成 Blob。失败一律返回 null
 * （上层据此标「文件丢失」并给重新导入入口，不抛错打断开书流程）。
 *
 * 为什么要单独一层：`book-ref.ts` 是纯解析（可在 Node 里直接测），
 * 这里要碰 fetch / 内核 API，测试需要注入桩，所以拆开。
 */
import { getFileBlob } from "../siyuan/api";
import { bookRefUrl, type BookRefKind } from "./book-ref.ts";

export async function loadRefBlob(uri: string, kind: BookRefKind): Promise<Blob | null> {
  const url = bookRefUrl({ kind, uri });
  if (!url) {
    // 落在 /data 里、但不在 public 下的文件：内核 API 整本读（无 Range 可用）
    try {
      return await getFileBlob(uri);
    } catch {
      return null;
    }
  }
  try {
    const res = await fetch(url, { credentials: "same-origin" });
    if (!res.ok) return null;
    return await res.blob();
  } catch {
    return null;
  }
}
