/**
 * OPDS 在线书源客户端（B · 在线书源 / OPDS 搜书）
 * ------------------------------------------------------------------
 * 复用 SiYuan 内核代理 forwardProxy 拉取（CORS 安全）+ vendored foliate opds.js 解析。
 * 仅实现 OPDS 1.x（Atom XML）为主，附带 OPDS 2 JSON 最小解析分支。
 * 下载走 forwardProxy base64 → Blob → File，复用现有 store.importBook 导入流程。
 */

import { forwardProxyRaw } from "../siyuan/api";
// @ts-ignore - foliate vendor 为纯 JS，无类型声明（仅运行时 import）
import { getFeed, getOpenSearch, REL, SYMBOL } from "./vendor/foliate-js/opds.js";

const UA = "REword/1.4 (+SiYuan plugin)";

export interface OpdsLink {
  rel: string;
  href: string;
  type?: string;
  title?: string;
}

export interface OpdsEntry {
  kind: "publication" | "navigation";
  id?: string;
  title?: string;
  author?: string;
  summary?: string;
  cover?: string;
  /** publication：最佳可下载链接（向后兼容，快捷导入用） */
  download?: { href: string; type?: string };
  /** publication：全部 acquisition 链接（已绝对化；2026-10-15 详情页多格式选择） */
  downloads?: { href: string; type?: string; label: string }[];
  /** publication：rel="self" 详情文档地址（2026-10-15 详情视图用） */
  selfHref?: string;
  /** navigation：子目录地址 */
  href?: string;
}

/** 书籍详情文档（rel="self" 解析结果；参照 readest opdsPublication #4749） */
export interface OpdsDetail {
  title?: string;
  author?: string;
  summary?: string;
  publisher?: string;
  language?: string;
  issued?: string;
  cover?: string;
  downloads: { href: string; type?: string; label: string }[];
}

export interface OpdsFeed {
  title?: string;
  entries: OpdsEntry[];
  /** 顶层 feed 链接（用于 OpenSearch 搜索检测） */
  links?: OpdsLink[];
}

export interface OpdsCatalog {
  id: string;
  name: string;
  url: string;
  /** Basic Auth：user:pass（可选） */
  auth?: string;
  /** 搜索 URL 模板，{q} 占位关键词 */
  searchTemplate?: string;
  /** 描述（可选；管理列表展示） */
  description?: string;
  /** 自定义请求头（可选；2026-10-15 阶段 3，对齐 readest customHeaders） */
  customHeaders?: Record<string, string>;
  /** 订阅自动下载（可选；2026-10-15 阶段 3，opds-auto.ts 调度器消费） */
  autoDownload?: boolean;
}

/** 内置公共书源（用户可增删，存本地）。2026-10-15 对齐 readest 预置清单（均为合法 OPDS 源） */
export const BUILTIN_CATALOGS: OpdsCatalog[] = [
  {
    id: "standardebooks",
    name: "Standard Ebooks",
    url: "https://standardebooks.org/opds/all",
    searchTemplate: "https://standardebooks.org/opds/search?query={q}",
    description: "公版书精校版，排版质量极高",
  },
  {
    id: "gutenberg",
    name: "Project Gutenberg",
    url: "https://www.gutenberg.org/ebooks.opds",
    description: "7 万+ 公版经典电子书",
  },
  {
    id: "manybooks",
    name: "ManyBooks",
    url: "https://manybooks.net/opds/index.php",
    description: "5 万+ 免费电子书（readest 同款预置）",
  },
  // 2026-10-15 移除 Unglue.it：其 OPDS 服务已下线（/api/opds/ 与 /opds/ 均 403，
  // readest 预置清单同样过时）；如后续恢复可由用户自定义书源加回。
];

/**
 * 书源连通性验证（readest validateOPDSCatalog 同语义）：拉一次 feed 试解析。
 * 返回 valid + 解析到的 feed 标题（成功）或错误信息（失败）。
 */
export async function validateOpdsCatalog(
  url: string,
  auth?: string
): Promise<{ valid: boolean; error?: string; title?: string }> {
  try {
    const f = await fetchOpdsFeed(url, auth);
    return { valid: true, title: f.title };
  } catch (e: any) {
    return { valid: false, error: e?.message || String(e) };
  }
}

interface FetchResult {
  body: string;
  contentType: string;
}

async function fetchText(url: string, auth?: string, extraHeaders?: Record<string, string>): Promise<FetchResult> {
  const headers: Record<string, string> = {
    "User-Agent": UA,
    Accept:
      "application/atom+xml, application/xml, text/xml, application/opds+json, application/json, */*",
    ...(extraHeaders || {}),
  };
  if (auth) headers["Authorization"] = "Basic " + btoa(auth);
  const r = await forwardProxyRaw({
    url,
    method: "GET",
    responseEncoding: "text",
    headers,
    timeout: 60000,
  });
  if (r.code !== 0 || r.status >= 400) {
    throw new Error(`OPDS 拉取失败（HTTP ${r.status}）${r.msg ? "：" + r.msg : ""}`);
  }
  return {
    body: r.body,
    contentType: r.headers["content-type"] || r.headers["Content-Type"] || "application/xml",
  };
}

/** 取二进制为 base64（下载书籍 / 封面） */
async function fetchBase64(
  url: string,
  auth?: string,
  extraHeaders?: Record<string, string>,
  range?: { start: number; end: number }
): Promise<{ b64: string; type: string; status: number }> {
  const headers: Record<string, string> = { "User-Agent": UA, ...(extraHeaders || {}) };
  if (auth) headers["Authorization"] = "Basic " + btoa(auth);
  if (range) headers["Range"] = `bytes=${range.start}-${range.end}`;
  const r = await forwardProxyRaw({
    url,
    method: "GET",
    responseEncoding: "base64",
    headers,
    timeout: 120000,
  });
  if (r.code !== 0 || r.status >= 400) {
    throw new Error(`下载失败（HTTP ${r.status}）`);
  }
  return {
    b64: r.body,
    type: r.headers["content-type"] || r.headers["Content-Type"] || "",
    status: r.status,
  };
}

function parseXmlDoc(body: string): Document {
  const doc = new DOMParser().parseFromString(body, "application/xml");
  const err = doc.querySelector("parsererror");
  if (err) throw new Error("OPDS 返回不是合法 XML");
  return doc;
}

/** 相对链接 → 绝对 URL（对齐 readest opdsUtils.resolveURL） */
export function resolveOpdsUrl(href: string, base?: string): string {
  if (!href) return href;
  if (!base || /^(data:|https?:)/i.test(href)) return href;
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

/** 媒体类型 / 链接 → 格式显示名（EPUB/PDF/…，兜底取扩展名） */
export function formatLabel(type?: string, href?: string): string {
  const hay = `${type || ""} ${href || ""}`;
  const table: Array<[RegExp, string]> = [
    [/epub|kepub/i, "EPUB"],
    [/pdf/i, "PDF"],
    [/mobi|azw3?/i, "MOBI"],
    [/fb2/i, "FB2"],
    [/cbz|cbr/i, "CBZ"],
    [/text\/html/i, "HTML"],
    [/plain|txt/i, "TXT"],
  ];
  for (const [re, label] of table) if (re.test(hay)) return label;
  const ext = (href || "").split("?")[0].match(/\.([a-z0-9]{2,5})$/i)?.[1];
  return ext ? ext.toUpperCase() : "FILE";
}

/** 过滤 acquisition 链接（剔除 buy/borrow/sample），绝对化并打格式标签 */
function listAcquisitions(links: any[], baseUrl?: string): { href: string; type?: string; label: string }[] {
  if (!Array.isArray(links)) return [];
  const acq = links.filter((l) => {
    const rel = l.rel || "";
    if (!rel.startsWith(REL.ACQ) && rel !== "http://opds-spec.org/acquisition") return false;
    if (/buy|borrow|subscription|sample/i.test(rel)) return false;
    return !!l.href;
  });
  return acq.map((l) => ({
    href: resolveOpdsUrl(l.href, baseUrl),
    type: l.type,
    label: formatLabel(l.type, l.href),
  }));
}

/** 从链接数组里挑一个最佳可下载链接（优先 epub，其次 pdf） */
function pickDownload(links: any[]): { href: string; type?: string } | undefined {
  if (!Array.isArray(links)) return undefined;
  const acq = links.filter((l) => {
    const rel = l.rel || "";
    if (!rel.startsWith(REL.ACQ) && rel !== "http://opds-spec.org/acquisition") return false;
    if (/buy|borrow|subscription|sample/i.test(rel)) return false;
    return true;
  });
  if (!acq.length) return undefined;
  const pref =
    acq.find((l) => /epub|kepub/i.test(l.type || "")) ||
    acq.find((l) => /pdf/i.test(l.type || "")) ||
    acq.find((l) => /mobi|azw|fb2|cbz/i.test(l.type || "")) ||
    acq[0];
  return { href: pref.href, type: pref.type };
}

function mapPublication(raw: any, baseUrl?: string): OpdsEntry {
  const meta = raw.metadata || {};
  const links: any[] = raw.links || [];
  const coverLink = raw.images && raw.images[0] ? raw.images[0].href : undefined;
  const author = Array.isArray(meta.author)
    ? meta.author.map((a: any) => (typeof a === "string" ? a : a.name)).filter(Boolean).join(", ")
    : (typeof meta.author === "string" ? meta.author : meta.author?.name) || undefined;
  const selfLink = links.find((l) => {
    const rel = Array.isArray(l.rel) ? l.rel.join(" ") : l.rel || "";
    return rel.split(/\s+/).includes("self");
  });
  return {
    kind: "publication",
    id: meta.id,
    title: meta.title,
    author,
    summary: meta.summary || meta.subtitle,
    cover: coverLink ? resolveOpdsUrl(coverLink, baseUrl) : undefined,
    download: pickDownload(links),
    downloads: listAcquisitions(links, baseUrl),
    selfHref: selfLink?.href ? resolveOpdsUrl(selfLink.href, baseUrl) : undefined,
  };
}

function mapNavigation(raw: any): OpdsEntry {
  // getFeed 对 navigation 直接把 link 对象当 item：带 href/type/title + SYMBOL.SUMMARY
  return {
    kind: "navigation",
    title: raw.title,
    summary: raw[SYMBOL.SUMMARY],
    href: raw.href,
  };
}

export async function fetchOpdsFeed(url: string, auth?: string, extraHeaders?: Record<string, string>): Promise<OpdsFeed> {
  const { body, contentType } = await fetchText(url, auth, extraHeaders);
  if (/json/i.test(contentType) || body.trim().startsWith("{")) {
    try {
      const j = JSON.parse(body);
      const entries: OpdsEntry[] = [];
      for (const p of j.publications || []) {
        const links = (p.links || []).map((l: any) => ({ rel: l.rel, href: l.href, type: l.type }));
        const selfLink = links.find((l: any) => {
          const rel = Array.isArray(l.rel) ? l.rel.join(" ") : l.rel || "";
          return rel.split(/\s+/).includes("self");
        });
        entries.push({
          kind: "publication",
          title: p.metadata?.title,
          author: (p.metadata?.author || []).map((a: any) => a.name).join(", "),
          summary: p.metadata?.summary,
          cover: p.images?.[0]?.href ? resolveOpdsUrl(p.images[0].href, url) : undefined,
          download: pickDownload(links),
          downloads: listAcquisitions(links, url),
          selfHref: selfLink?.href ? resolveOpdsUrl(selfLink.href, url) : undefined,
        });
      }
      for (const n of j.navigation || []) {
        entries.push({ kind: "navigation", title: n.title, href: n.href });
      }
      return { title: j.metadata?.title, entries, links: j.links || [] };
    } catch {
      // 落到 XML 分支
    }
  }
  const doc = parseXmlDoc(body);
  const feed = getFeed(doc);
  const entries: OpdsEntry[] = [];
  for (const p of feed.publications || []) entries.push(mapPublication(p, url));
  for (const n of feed.navigation || []) entries.push(mapNavigation(n));
  return { title: feed.metadata?.title, entries, links: feed.links || [] };
}

/**
 * 搜索：优先用 catalog.searchTemplate；否则若当前 feed 含 OpenSearch 描述则解析后构造 URL。
 * 返回搜索结果 feed；无搜索能力时抛错。
 */
export async function searchOpds(
  catalog: OpdsCatalog,
  query: string,
  currentFeedLinks?: OpdsLink[]
): Promise<OpdsFeed> {
  const q = query.trim();
  if (!q) throw new Error("请输入关键词");
  if (catalog.searchTemplate) {
    const url = catalog.searchTemplate.replace("{q}", encodeURIComponent(q));
    return fetchOpdsFeed(url, catalog.auth, catalog.customHeaders);
  }
  // OpenSearch：在当前 feed 的 links 里找 search 描述
  const osLink = (currentFeedLinks || []).find(
    (l) => /opensearch/i.test(l.type || "") && /search/i.test(l.rel || "")
  );
  if (osLink?.href) {
    const { body } = await fetchText(osLink.href, catalog.auth, catalog.customHeaders);
    const doc = parseXmlDoc(body);
    const os = getOpenSearch(doc);
    const url = os.search(new Map([[undefined, new Map([["searchTerms", q]])]]));
    return fetchOpdsFeed(url, catalog.auth);
  }
  throw new Error("该书源未提供搜索，请用浏览");
}

/** 封面转 dataURL（经 forwardProxy 取二进制，规避 CORS/混合内容） */
export async function fetchImageDataUrl(url: string, auth?: string): Promise<string | null> {
  try {
    const { b64, type } = await fetchBase64(url, auth);
    if (!b64) return null;
    return `data:${type || "image/jpeg"};base64,${b64}`;
  } catch {
    return null;
  }
}

/** base64/类型 → File（命名清洗 + 扩展名推断，downloadAsFile/分块下载共用） */
function bytesToFile(b64: string, type: string, filenameHint?: string): File {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: type || "application/octet-stream" });
  const ext = (type.match(/epub|pdf|mobi|azw|fb2|cbz/i)?.[0] || "epub").toLowerCase();
  const name = (filenameHint || "book").replace(/[\\/:*?"<>|]/g, "_");
  return new File([blob], `${name}.${ext}`, { type: type || "application/epub+zip" });
}

/** 下载书籍为 File（复用现有 importBook） */
export async function downloadAsFile(
  url: string,
  auth?: string,
  filenameHint?: string
): Promise<File> {
  const { b64, type } = await fetchBase64(url, auth);
  if (!b64) throw new Error("下载内容为空");
  return bytesToFile(b64, type, filenameHint);
}

/**
 * 2026-10-15 阶段 3：带真实进度的下载。
 * 先 HEAD 探测 content-length，再按 512KB 分块 Range 拉取（每块回调一次百分比）；
 * 服务器不支持 Range（返回 200 而非 206）或无长度信息时，自动退回单次整取（进度只有 0/100）。
 */
export async function downloadAsFileWithProgress(
  url: string,
  auth?: string,
  filenameHint?: string,
  onProgress?: (pct: number) => void,
  extraHeaders?: Record<string, string>
): Promise<File> {
  const baseHeaders: Record<string, string> = { "User-Agent": UA, ...(extraHeaders || {}) };
  if (auth) baseHeaders["Authorization"] = "Basic " + btoa(auth);

  // 1) 探测总大小
  let total = 0;
  try {
    const h = await forwardProxyRaw({
      url,
      method: "HEAD",
      headers: { ...baseHeaders },
      timeout: 30000,
    });
    if (h.code === 0 && h.status < 400) {
      total = Number(h.headers["content-length"] || h.headers["Content-Length"] || 0);
    }
  } catch {
    // 探测失败 → 走单次整取
  }

  // 2) 无长度信息 → 单次整取（进度只有 0/100 两档）
  if (!total || total <= 0) {
    onProgress?.(0);
    const file = await downloadAsFile(url, auth, filenameHint);
    onProgress?.(100);
    return file;
  }

  // 3) 分块 Range 下载（512KB/块；首块若返回 200 说明服务器忽略 Range → 退回整取）
  const CHUNK = 512 * 1024;
  const merged = new Uint8Array(total);
  let type = "";
  for (let start = 0; start < total; start += CHUNK) {
    const end = Math.min(start + CHUNK, total) - 1;
    const r = await fetchBase64(url, auth, extraHeaders, { start, end });
    if (r.status === 200 && start > 0) {
      // 服务器不支持 Range：放弃分块，退回单次整取
      return downloadAsFile(url, auth, filenameHint);
    }
    if (!r.b64) throw new Error(`分块下载为空（${start}-${end}）`);
    type = r.type || type;
    const bin = atob(r.b64);
    const take = Math.min(bin.length, total - start);
    for (let i = 0; i < take; i++) merged[start + i] = bin.charCodeAt(i);
    onProgress?.(Math.min(99, Math.round(((start + take) / total) * 100)));
  }
  onProgress?.(100);
  const blob = new Blob([merged], { type: type || "application/octet-stream" });
  const ext = (type.match(/epub|pdf|mobi|azw|fb2|cbz/i)?.[0] || "epub").toLowerCase();
  const name = (filenameHint || "book").replace(/[\\/:*?"<>|]/g, "_");
  return new File([blob], `${name}.${ext}`, { type: type || "application/epub+zip" });
}

/**
 * 拉取书籍详情文档（rel="self"，参照 readest #4749）：feed 列表只带摘要，
 * 完整元数据（出版方/语言/年份/简介全文）与全部格式链接在详情文档里。
 * 支持 OPDS 2.0 JSON 与 Atom entry XML 双格式。
 */
export async function fetchOpdsDetail(url: string, auth?: string, extraHeaders?: Record<string, string>): Promise<OpdsDetail> {
  const { body, contentType } = await fetchText(url, auth, extraHeaders);
  const abs = (h?: string) => resolveOpdsUrl(h, url);
  if (/json/i.test(contentType) || body.trim().startsWith("{")) {
    try {
      const j = JSON.parse(body);
      const meta = j.metadata || {};
      return {
        title: meta.title,
        author: Array.isArray(meta.author)
          ? meta.author.map((a: any) => a.name).filter(Boolean).join(", ")
          : meta.author,
        summary: meta.summary || meta.subtitle,
        publisher: meta.publisher,
        language: Array.isArray(meta.language) ? meta.language.join(", ") : meta.language,
        issued: meta.issued,
        cover: abs(j.images?.[0]?.href),
        downloads: listAcquisitions(j.links || [], url),
      };
    } catch {
      // 落到 XML 分支
    }
  }
  const doc = parseXmlDoc(body);
  const root = doc.documentElement;
  const pub = getPublication(root) as any;
  const meta = pub?.metadata || {};
  return {
    title: meta.title,
    author: Array.isArray(meta.author)
      ? meta.author.map((a: any) => (typeof a === "string" ? a : a?.name)).filter(Boolean).join(", ")
      : meta.author?.name,
    summary: meta.summary || meta.subtitle,
    publisher: meta.publisher,
    language: meta.language,
    issued: meta.issued,
    cover: abs(pub?.images?.[0]?.href),
    downloads: listAcquisitions(pub?.links || [], url),
  };
}
