/**
 * 引用式书源（2026-11-25 C 期）
 * ---------------------------------------------------------------
 * 目的：**只存引用，不复制文件**。
 *
 * 现状：导入 = 把整本书上传进 `petal/<插件>/books/`，于是同一本书在磁盘上
 * 有两份（用户原文件 + 书库副本），换设备还要再同步一遍。用户问题原话是
 * 「多个书籍文件导致内存膨胀」——其中一个来源就是这个「一份变两份」的模型。
 *
 * 引用式导入只记 `{ kind, uri }`：书还在原处，书架只持有指针。
 *
 * 支持的三类引用（都做过可达性验证）：
 *  - `asset`：思源资源，`assets/xxx.epub` → `GET /assets/xxx.epub`（支持 Range，实测 206）
 *  - `http` ：`http(s)://…` 直链（需服务端允许跨域或同源；不支持时回落代理）
 *  - `path` ：工作区内路径 `/data/…`。落在 `/data/public/` 的走 `/public/…`（支持 Range）；
 *             其他位置只能经内核 `getFile` 整本读（内核不允许读工作区外的绝对路径，
 *             所以**桌面本地任意路径无法引用**，这点在 UI 文案里要说清）。
 *
 * 本模块只做纯解析/映射，不碰网络与存储，便于 Node 直接单测。
 */

export type BookRefKind = "asset" | "http" | "path";

export interface BookRef {
  kind: BookRefKind;
  /** asset: 相对 data/assets 的路径；http: 完整 URL；path: 以 /data/ 开头的路径 */
  uri: string;
}

/** 引用式导入支持的扩展名（与书架 ACCEPT 保持一致） */
export const REF_EXTS = ["epub", "pdf", "mobi", "azw3", "fb2", "cbz", "txt", "md", "markdown"] as const;

function stripQuotes(s: string): string {
  return s.trim().replace(/^[`'"]+|[`'"]+$/g, "").trim();
}

/** 把用户输入解析成引用；无法识别返回 null（UI 据此报错，不猜） */
export function parseBookRef(input: string): BookRef | null {
  const raw = stripQuotes(String(input || ""));
  if (!raw) return null;

  if (/^https?:\/\//i.test(raw)) return { kind: "http", uri: raw };

  // asset://xxx / /assets/xxx / assets/xxx
  const asset = raw
    .replace(/^asset:\/\//i, "")
    .replace(/^\/?assets\//i, "");
  if (asset !== raw) {
    const uri = asset.replace(/^\/+/, "");
    return uri ? { kind: "asset", uri } : null;
  }

  // /data/xxx 或 data/xxx
  if (/^\/?data\//i.test(raw)) {
    return { kind: "path", uri: "/" + raw.replace(/^\/+/, "") };
  }
  return null;
}

/** 引用 → 可直接 fetch 的 URL；返回 null 表示必须走内核 getFile（整本读） */
export function bookRefUrl(ref: BookRef): string | null {
  if (ref.kind === "http") return ref.uri;
  const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");
  if (ref.kind === "asset") return "/assets/" + encodePath(ref.uri);
  // /data/public/... 是思源的静态目录，可直接当 URL 用（支持 Range）
  if (ref.uri.startsWith("/data/public/")) return "/" + ref.uri.slice("/data/".length).split("/").map(encodeURIComponent).join("/");
  return null;
}

/** 引用指向的文件名（含扩展名，用于类型判定与标题兜底） */
export function bookRefName(ref: BookRef): string {
  const noQuery = ref.uri.split("#")[0].split("?")[0];
  const seg = noQuery.split("/").filter(Boolean).pop() || "";
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/** 引用指向的扩展名（小写、无点）；无法判定返回空串 */
export function bookRefExt(ref: BookRef): string {
  const name = bookRefName(ref);
  return (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
}

export function isSupportedRef(ref: BookRef): boolean {
  return (REF_EXTS as readonly string[]).includes(bookRefExt(ref));
}

/** 引用是否可 Range 直读（决定元数据能否「只读几个小文件」拿到） */
export function refSupportsRange(ref: BookRef): boolean {
  return bookRefUrl(ref) !== null;
}

/** 同一引用的稳定键：用于判重 */
export function bookRefKey(ref: BookRef): string {
  return `${ref.kind}:${ref.uri}`;
}
