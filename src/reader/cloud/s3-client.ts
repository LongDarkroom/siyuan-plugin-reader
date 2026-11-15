/**
 * 阅读器 · 云端书库 —— S3 兼容 provider
 * ----------------------------------------------------------------
 * 2026-11-15 实测：签名头（Authorization / x-amz-date / x-amz-content-sha256）、
 * 查询串、HEAD/GET/DELETE、302 跟随全部经 `forwardProxy` 原样透传；
 * Range 分片能拿到 206 且字节可拼接 —— 所以 32 MiB 单响应上限不构成文件上限。
 *
 * 只读：只用 List / Head / Get。PutObject 需要二进制 payload，而内核代理的
 * `payload` 字段是字符串（UTF-8 会改坏字节），要做成上传得先解决编码问题，
 * 且「从思源往云端写书」并不在用户的原始诉求里（诉求就是把文件移过去然后读）。
 */

import { cloudFetch, pickHeader, CloudError } from "./cloud-http.ts";
import { buildSignedRequest, EMPTY_PAYLOAD_SHA256 } from "./sigv4.ts";
import { normalizeS3Prefix, type RemoteEntry, type S3Account } from "./cloud-types.ts";

/** 列举分页数上限：1000 条/页 × 50 = 5 万对象，再多就是配错了前缀 */
const MAX_PAGES = 50;

export function isAwsEndpoint(host: string): boolean {
  return /(^|\.)amazonaws\.com$/i.test(host.split(":")[0]);
}

/** endpoint → {scheme, host(含端口)} */
export function endpointParts(acct: S3Account): { scheme: "http" | "https"; host: string } {
  const u = new URL(acct.endpoint);
  return { scheme: u.protocol.replace(":", "") as "http" | "https", host: u.host };
}

/**
 * 寻址风格：AWS 用 virtual-hosted（bucket 进 host），自建端点（MinIO / rclone /
 * 群晖）基本只认 path-style。用户显式勾选优先，没勾就按 host 自动判。
 */
export function resolvePathStyle(acct: S3Account): boolean {
  if (typeof acct.pathStyle === "boolean") return acct.pathStyle;
  return !isAwsEndpoint(endpointParts(acct).host);
}

/** 对象/列举的 host 与路径前缀 */
export function s3Address(acct: S3Account): { scheme: "http" | "https"; host: string; basePath: string } {
  const { scheme, host } = endpointParts(acct);
  const pathStyle = resolvePathStyle(acct);
  if (pathStyle) return { scheme, host, basePath: `/${acct.bucket}` };
  return { scheme, host: `${acct.bucket}.${host}`, basePath: "/" };
}

/** 完整对象 key：账号 prefix + 面板里的相对路径 */
export function s3ObjectKey(acct: S3Account, relPath: string): string {
  const prefix = normalizeS3Prefix(acct.prefix);
  const rel = (relPath || "").replace(/^\/+/, "");
  return `${prefix}${rel}`;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&"); // 必须最后做，否则 &amp;lt; 会解错
}

/**
 * 解析 ListBucketResult（V2）。
 * CommonPrefixes → 目录，Contents → 文件；名字都按当前 prefix 剥。
 */
export function parseListBucketResult(xml: string, currentPrefix: string): {
  entries: RemoteEntry[];
  truncated: boolean;
  nextToken: string;
} {
  const grab = (tag: string, from: string) => from.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1] || "";

  const entries: RemoteEntry[] = [];

  for (const cp of xml.match(/<CommonPrefixes>[\s\S]*?<\/CommonPrefixes>/g) || []) {
    const key = decodeXmlEntities(grab("Prefix", cp));
    const name = key.slice(currentPrefix.length).replace(/\/+$/, "");
    if (name) entries.push({ name, path: `${name}/`, isDir: true, size: 0 });
  }

  for (const c of xml.match(/<Contents>[\s\S]*?<\/Contents>/g) || []) {
    const key = decodeXmlEntities(grab("Key", c));
    const name = key.slice(currentPrefix.length);
    if (!name || name.endsWith("/")) continue; // 目录占位对象（0 字节 key/）
    entries.push({
      name,
      path: name,
      isDir: false,
      size: Number(grab("Size", c)) || 0,
      mtime: grab("LastModified", c) || undefined,
      etag: grab("ETag", c).replace(/^"|"$/g, "") || undefined,
    });
  }

  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/.test(xml);
  return { entries, truncated, nextToken: truncated ? decodeXmlEntities(grab("NextContinuationToken", xml)) : "" };
}

/** 一次带签名的请求：返回可直接给 cloudFetch 的 url + headers */
export async function s3Signed(
  acct: S3Account,
  method: string,
  key: string,
  query?: Record<string, string>,
  payloadHash = EMPTY_PAYLOAD_SHA256,
  date?: Date
): Promise<{ url: string; headers: Record<string, string> }> {
  const { scheme, host, basePath } = s3Address(acct);
  const path = key ? `${basePath === "/" ? "" : basePath}/${key}` : basePath;
  const signed = await buildSignedRequest({
    method,
    host,
    scheme,
    path,
    query,
    payloadHash,
    accessKeyId: acct.accessKeyId,
    secretAccessKey: acct.secretAccessKey,
    region: acct.region || "us-east-1",
    service: "s3",
    date,
  });
  return { url: signed.url, headers: signed.headers };
}

/** 列一个"目录"（其实是 prefix + delimiter） */
export async function listS3Dir(acct: S3Account, relDir: string): Promise<RemoteEntry[]> {
  const basePrefix = normalizeS3Prefix(acct.prefix);
  const rel = (relDir || "").replace(/^\/+|\/+$/g, "");
  const currentPrefix = `${basePrefix}${rel ? `${rel}/` : ""}`;

  const all: RemoteEntry[] = [];
  let token = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const query: Record<string, string> = { "list-type": "2", prefix: currentPrefix, delimiter: "/" };
    if (token) query["continuation-token"] = token;
    const req = await s3Signed(acct, "GET", "", query);
    const r = await cloudFetch({ url: req.url, method: "GET", headers: req.headers, timeoutMs: 60000 });
    const parsed = parseListBucketResult(r.text, currentPrefix);
    all.push(...parsed.entries);
    if (!parsed.truncated || !parsed.nextToken) break;
    token = parsed.nextToken;
    if (page === MAX_PAGES - 1) {
      throw new CloudError(`对象数量超过 ${MAX_PAGES * 1000} 条，请把书库收到更具体的前缀下`, 0, "too_many");
    }
  }

  return all.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, "zh") : a.isDir ? -1 : 1));
}

/** 对象大小（分块下载前要的大小） */
export async function statS3(acct: S3Account, relPath: string): Promise<{ size: number; etag: string }> {
  const req = await s3Signed(acct, "HEAD", s3ObjectKey(acct, relPath));
  const r = await cloudFetch({ url: req.url, method: "HEAD", headers: req.headers, timeoutMs: 30000 });
  return {
    size: Number(pickHeader(r.headers, "content-length") || 0),
    etag: pickHeader(r.headers, "etag").replace(/^"|"$/g, ""),
  };
}

/**
 * 分片下载用的头部工厂：每片重新签名一次。
 * Range 不进签名头，所以每片只是换时间戳 —— 一本书下满 15 分钟仍会撞
 * `RequestTimeTooSkewed`，逐片重签才是稳的。
 */
export function makeS3HeaderFactory(acct: S3Account, relPath: string) {
  const key = s3ObjectKey(acct, relPath);
  return async (): Promise<{ url: string; headers: Record<string, string> }> => {
    const signed = await s3Signed(acct, "GET", key);
    return { url: signed.url, headers: signed.headers };
  };
}
