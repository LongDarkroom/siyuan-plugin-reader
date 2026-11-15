/**
 * 阅读器 · 云端书库 —— WebDAV provider
 * ----------------------------------------------------------------
 * 2026-11-15 实测：`forwardProxy` 能把 PROPFIND 原样送出（返回 207 + XML），
 * 二进制用 base64 取回可逐字节还原 —— 所以 WebDAV 只需要 PROPFIND + GET 两个动作。
 *
 * 只读：不提供 PUT/MKCOL/DELETE。用户的用法是「把书放进网盘目录，插件读」，
 * 反方向写会引入冲突合并问题，而收益（在思源里传书上云）远小于风险。
 */

import { cloudFetch, pickHeader, CloudError } from "./cloud-http.ts";
import { normalizeDirPath, type RemoteEntry, type WebDavAccount } from "./cloud-types.ts";

const PROPFIND_BODY =
  '<?xml version="1.0"?>' +
  '<d:propfind xmlns:d="DAV:">' +
  "<d:prop>" +
  "<d:displayname/><d:getcontentlength/><d:getcontenttype/>" +
  "<d:getlastmodified/><d:getetag/><d:resourcetype/>" +
  "</d:prop></d:propfind>";

/** 逐段编码，避免文件名里的空格/中文/# 把路径打断 */
function encodePath(segments: string[]): string {
  return segments.filter((s) => s !== "").map((s) => encodeURIComponent(s)).join("/");
}

/** 拼出某个远端路径的完整 URL；dir=true 时补末尾斜杠（PROPFIND 目录要） */
export function webdavUrlFor(acct: WebDavAccount, relPath: string, dir = false): string {
  const base = new URL(acct.baseUrl);
  const root = normalizeDirPath(acct.rootPath);
  const rel = normalizeDirPath(relPath);
  const tail = encodePath([...root.split("/"), ...rel.split("/")]);
  const prefix = base.pathname.replace(/\/+$/, "");
  let p = `${prefix}/${tail}`;
  if (dir && !p.endsWith("/")) p += "/";
  return `${base.protocol}//${base.host}${p.replace(/\/{2,}/g, "/")}`;
}

export function webdavHeaders(acct: WebDavAccount): Record<string, string> {
  const h: Record<string, string> = {};
  if (acct.username || acct.password) {
    h["Authorization"] = "Basic " + basicAuth(acct.username || "", acct.password || "");
  }
  return h;
}

/** 凭据转 Basic：网盘账号常见中文，必须先按 UTF-8 编码再 base64（btoa 只吃 latin1） */
export function basicAuth(user: string, pass: string): string {
  const bytes = new TextEncoder().encode(`${user}:${pass}`);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function localNameAll(scope: Document | Element, tag: string): Element[] {
  return Array.from(scope.getElementsByTagNameNS("*", tag));
}

function textOf(el: Element | null | undefined): string {
  return (el?.textContent || "").trim();
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * 解析 207 响应。
 * @param xml      响应体
 * @param selfUrl  本次 PROPFIND 请求的 URL，用于把 href 折成相对路径
 */
export function parsePropfind(xml: string, selfUrl: string): RemoteEntry[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) throw new CloudError("WebDAV 返回的不是合法 XML", 0, "bad_xml");

  const responses = localNameAll(doc, "response");
  const selfPath = safeDecode(new URL(selfUrl).pathname);
  const out: RemoteEntry[] = [];

  for (const resp of responses) {
    const hrefEl = localNameAll(resp, "href")[0];
    const href = textOf(hrefEl);
    if (!href) continue;
    const decoded = safeDecode(href.replace(/^https?:\/\/[^/]+/i, ""));
    const isSelf = decoded.replace(/\/+$/, "") === selfPath.replace(/\/+$/, "");
    if (isSelf) continue;

    // 只取 status 200 的 propstat（部分服务器把找不到的属性放 404 propstat）
    let props: Element | null = null;
    for (const ps of localNameAll(resp, "propstat")) {
      const st = textOf(localNameAll(ps, "status")[0]);
      if (!st || /200/.test(st)) {
        props = localNameAll(ps, "prop")[0] || null;
        if (props) break;
      }
    }
    if (!props) continue;

    const rt = localNameAll(props, "resourcetype")[0];
    const isDir = !!rt && localNameAll(rt, "collection").length > 0;

    // 相对路径：优先按前缀剥，剥不动就退化为最后一段（服务器端点前缀不一致时）。
    // 目录保留尾部斜杠 —— 和 S3 provider 的 path 约定一致，进入子目录时直接拼。
    let rel = decoded;
    if (rel.startsWith(selfPath)) rel = rel.slice(selfPath.length);
    else rel = rel.split("/").filter(Boolean).pop() || "";
    rel = rel.replace(/^\/+/, "");
    if (isDir && rel && !rel.endsWith("/")) rel += "/";

    const name = textOf(localNameAll(props, "displayname")[0]) || rel.replace(/\/+$/, "").split("/").pop() || "";
    if (!name || !rel) continue;

    out.push({
      name,
      path: rel,
      isDir,
      size: isDir ? 0 : Number(textOf(localNameAll(props, "getcontentlength")[0]) || 0) || 0,
      mtime: textOf(localNameAll(props, "getlastmodified")[0]) || undefined,
      etag: textOf(localNameAll(props, "getetag")[0]) || undefined,
      contentType: textOf(localNameAll(props, "getcontenttype")[0]) || undefined,
    });
  }

  // 目录在前、按名字排序，和文件管理器一致
  return out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, "zh") : a.isDir ? -1 : 1));
}

export async function listWebdavDir(acct: WebDavAccount, relPath: string): Promise<RemoteEntry[]> {
  const url = webdavUrlFor(acct, relPath, true);
  const r = await cloudFetch({
    url,
    method: "PROPFIND",
    headers: { ...webdavHeaders(acct), Depth: "1", "Content-Type": "application/xml" },
    payload: PROPFIND_BODY,
    contentType: "application/xml",
    timeoutMs: 60000,
  });
  // 有些服务器对 PROPFIND 回 200 而不是 207，两者都接受
  if (r.status !== 207 && r.status !== 200) throw new CloudError(`WebDAV 列目录失败（HTTP ${r.status}）`, r.status);
  return parsePropfind(r.text, url);
}

/** 单文件属性（用于拿大小做分块下载） */
export async function statWebdav(acct: WebDavAccount, relPath: string): Promise<{ size: number; etag: string; mtime: string }> {
  const url = webdavUrlFor(acct, relPath, false);
  try {
    const r = await cloudFetch({
      url,
      method: "PROPFIND",
      headers: { ...webdavHeaders(acct), Depth: "0", "Content-Type": "application/xml" },
      payload: PROPFIND_BODY,
      contentType: "application/xml",
      timeoutMs: 30000,
    });
    const entries = parsePropfindSelf(r.text, url);
    return { size: entries.size, etag: entries.etag, mtime: entries.mtime };
  } catch (e) {
    // 少数服务器禁 Depth:0 —— 退化到 HEAD
    const h = await cloudFetch({ url, method: "HEAD", headers: webdavHeaders(acct), timeoutMs: 30000 });
    return {
      size: Number(pickHeader(h.headers, "content-length") || 0),
      etag: pickHeader(h.headers, "etag"),
      mtime: pickHeader(h.headers, "last-modified"),
    };
  }
}

/** stat 用：这次要保留 self 条目 */
function parsePropfindSelf(xml: string, selfUrl: string): { size: number; etag: string; mtime: string } {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const resp = localNameAll(doc, "response")[0];
  if (!resp) return { size: 0, etag: "", mtime: "" };
  const ps = localNameAll(resp, "propstat")[0];
  const props = ps ? localNameAll(ps, "prop")[0] : localNameAll(resp, "prop")[0];
  const get = (t: string) => textOf(props ? localNameAll(props, t)[0] : null);
  return {
    size: Number(get("getcontentlength") || 0) || 0,
    etag: get("getetag"),
    mtime: get("getlastmodified"),
  };
}

/** 下载用的请求头（Range 由 range-download 逐片附加） */
export function webdavDownloadHeaders(acct: WebDavAccount): Record<string, string> {
  return webdavHeaders(acct);
}
