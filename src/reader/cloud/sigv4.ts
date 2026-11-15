/**
 * 阅读器 · 云端书库 —— AWS Signature V4（Web Crypto 手写，零依赖）
 * ----------------------------------------------------------------
 * ## 为什么不用 @aws-sdk/client-s3
 * ReadAny 的做法是让 SDK 只**构造**已签名请求、再由自己的 `platform.fetch` 发出。
 * 我们必须经思源内核 `forwardProxy` 转发（iframe 是 null 源，直连 S3 要用户给桶配
 * CORS），等于只用 SDK 的签名部分却要背上几百 KB 产物 —— 不值，签名的核心就
 * canonical request → string to sign → HMAC 链四步，一百行写得完。
 *
 * ## 一条必须守住的不变量
 * **发出去的 URL 必须和签名时的 URL 逐字节一致。** 所以这里不接收"现成 URL"，
 * 而是接收结构化的 path / query，由本函数同时产出 canonical 串和最终 URL，
 * 调用方拿到的 url 与 headers 天然配套。任何一处手工拼串都会以
 * `SignatureDoesNotMatch` 的形式回来，很难查 —— 别在别处拼。
 *
 * ## 时间窗
 * x-amz-date 与服务器时钟偏差超过 15 分钟直接 403（`RequestTimeTooSkewed`）。
 * 大文件分块下载时每片重新签名（见 range-download.ts），所以单片再慢也不会
 * 撞窗；整取路径只有一次签名，同样安全。
 */

/** 空载荷的 SHA-256，GET/HEAD/DELETE 都用它 */
export const EMPTY_PAYLOAD_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const ENC = new TextEncoder();

/** RFC3986 编码：encodeURIComponent 漏掉的 `!'()*` 要补上 */
function uriEncodeComponent(seg: string): string {
  return encodeURIComponent(seg).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

/**
 * 路径编码：保留 `/` 分隔符。
 * S3 的 canonical URI 对 s3 服务是「每段编码、斜杠不编码」（双编码只用于
 * 某些签名 v4 变体，这里按标准 S3 行为来）。
 */
export function encodeS3Path(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return p
    .split("/")
    .map((seg) => uriEncodeComponent(seg))
    .join("/");
}

/** 查询串：按 key、再按 value 排序，全部编码 */
export function canonicalQuery(query?: Record<string, string>): string {
  if (!query) return "";
  const pairs = Object.entries(query)
    .map(([k, v]) => [uriEncodeComponent(k), uriEncodeComponent(String(v ?? ""))] as const)
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))
    .map(([k, v]) => `${k}=${v}`);
  return pairs.join("&");
}

/** 20261115T090000Z */
export function amzDate(d: Date = new Date()): string {
  return d.toISOString().replace(/[:-]|\.\d{3}/g, "");
}
/** 20261115 */
export function dateStamp(d: Date = new Date()): string {
  return amzDate(d).slice(0, 8);
}

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const buf = typeof data === "string" ? ENC.encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", buf as unknown as ArrayBuffer);
  return hex(new Uint8Array(digest));
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

async function hmacSha256(key: Uint8Array | string, msg: string): Promise<Uint8Array> {
  const rawKey = typeof key === "string" ? ENC.encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    rawKey as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, ENC.encode(msg) as unknown as ArrayBuffer);
  return new Uint8Array(sig);
}

export interface SigV4Input {
  method: string;
  /** 含端口（若有），不含 scheme —— 必须与 Go 客户端实际发出的 Host 一致 */
  host: string;
  scheme: "http" | "https";
  /** 未编码的原始路径，如 /books/我的书.epub */
  path: string;
  /** 未编码的原始查询键值 */
  query?: Record<string, string>;
  /**
   * 参与签名的额外头（键名大小写不敏感）。注意：`range` 也常被签进去，
   * 但签名只对「同一组头值」有效 —— 分块下载走 headersToSign 为空，
   * 让 Range 留在签名之外，每片只需换时间戳。
   */
  extraHeaders?: Record<string, string>;
  /** 载荷 SHA-256；GET/HEAD/DELETE 用 EMPTY_PAYLOAD_SHA256 */
  payloadHash?: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string;
  /** 固定时间戳（测试用）；缺省取当前时间 */
  date?: Date;
}

export interface SignedRequest {
  /** 最终 URL：scheme + host + 编码路径 + canonical 查询 */
  url: string;
  /** 直接塞给 forwardProxy 的请求头（含 Authorization） */
  headers: Record<string, string>;
  /** 调试用：中间量，SignatureDoesNotMatch 时先对这两个串 */
  canonicalRequest: string;
  stringToSign: string;
  signedHeaders: string;
}

/** 头部值规范化：去首尾空白、连续空格压成一个（AWS 明确要求） */
function trimHeader(value: string): string {
  return String(value).trim().replace(/\s+/g, " ");
}

export async function buildSignedRequest(i: SigV4Input): Promise<SignedRequest> {
  // 插件界面跑在 srcdoc iframe（null origin）里，WebCrypto 只在"可信源"下开放。
  // 正常情况下父页是 http://127.0.0.1:6806，属可信源；真取不到要直接说清楚，
  // 别在签名过程中抛一个看不懂的 ReferenceError。
  if (!globalThis.crypto?.subtle) {
    throw new Error("当前运行环境未开放 WebCrypto（crypto.subtle），无法为 S3 请求签名");
  }
  const now = i.date ?? new Date();
  const ad = amzDate(now);
  const ds = dateStamp(now);
  const service = i.service ?? "s3";
  const payloadHash = i.payloadHash ?? EMPTY_PAYLOAD_SHA256;

  const uri = encodeS3Path(i.path);
  const cq = canonicalQuery(i.query);

  // 参与签名的头：host + x-amz-date + x-amz-content-sha256（+ 调用方附加的）
  const toSign: Record<string, string> = {
    host: i.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": ad,
  };
  for (const [k, v] of Object.entries(i.extraHeaders || {})) {
    const lk = k.toLowerCase();
    if (lk === "authorization") continue;
    toSign[lk] = v;
  }
  const signedNames = Object.keys(toSign).sort();
  const canonicalHeaders = signedNames.map((k) => `${k}:${trimHeader(toSign[k])}\n`).join("");
  const signedHeaders = signedNames.join(";");

  const canonicalRequest = [
    i.method.toUpperCase(),
    uri,
    cq,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${ds}/${i.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", `${ad}`, scope, await sha256Hex(canonicalRequest)].join("\n");

  const kDate = await hmacSha256(`AWS4${i.secretAccessKey}`, ds);
  const kRegion = await hmacSha256(kDate, i.region);
  const kService = await hmacSha256(kRegion, service);
  const kSigning = await hmacSha256(kService, "aws4_request");
  const signature = hex(await hmacSha256(kSigning, stringToSign));

  const headers: Record<string, string> = {
    "x-amz-date": ad,
    "x-amz-content-sha256": payloadHash,
  };
  for (const [k, v] of Object.entries(i.extraHeaders || {})) {
    if (k.toLowerCase() === "authorization") continue;
    headers[k] = v;
  }
  headers[
    "Authorization"
  ] = `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    url: `${i.scheme}://${i.host}${uri}${cq ? `?${cq}` : ""}`,
    headers,
    canonicalRequest,
    stringToSign,
    signedHeaders,
  };
}
