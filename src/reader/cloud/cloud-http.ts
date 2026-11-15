/**
 * 阅读器 · 云端书库 —— 传输底座（思源内核 forwardProxy）
 * ----------------------------------------------------------------
 * ## 为什么必须走内核而不是 fetch
 * 插件 UI 跑在 `srcdoc` iframe 里，源是 `null`：直连 S3 要用户给桶配放行 `null`
 * 源的 CORS，直连 WebDAV 同理，还要处理预检。走内核 `forwardProxy` 这些全免，
 * 凭据也只在主进程与内核之间过，不出浏览器。
 *
 * ## 2026-11-15 在这台机器上实测过的三条边界
 * 1. 响应体硬顶 **33554432 字节**（`code=10 response body too large`），限的是
 *    上游原始字节，不是 base64 字符串长度 —— 所以分块 Range 是唯一出路。
 * 2. 请求方向宽松：自定义头（Authorization / x-amz-*）、查询串、PUT body、
 *    DELETE/HEAD/OPTIONS、302 跟随都原样透传。
 * 3. 内网地址不被 SSRF 黑名单拦（192.168 可连），但 `169.254` 元数据地址会被拒；
 *    另外内核**不接受自签证书**（x509 校验失败），所以思源自己的「网络服务 TLS」
 *    开着时，设备间直连这条路是走不通的。
 */

import { forwardProxyRaw } from "../../siyuan/api";

/** 内核单次响应的字节上限，超过直接 code=10 */
export const MAX_RESPONSE_BYTES = 33554432;

export interface CloudFetchOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  payload?: string;
  contentType?: string;
  /** 二进制必须用 base64：text 编码会把字节改坏（实测不还原） */
  binary?: boolean;
  timeoutMs?: number;
}

export interface CloudFetchResult {
  status: number;
  headers: Record<string, string>;
  /** 文本响应（binary=false 时有值） */
  text: string;
  /** 二进制响应（binary=true 时有值） */
  bytes: Uint8Array | null;
}

/** 云端操作失败：message 直接面向用户，所以带上可读的原因 */
export class CloudError extends Error {
  status: number;
  code: string;
  detail: string;

  constructor(message: string, status = 0, code = "", detail = "") {
    super(message);
    this.name = "CloudError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/** 从 XML 响应里取 <Code>/<Message>（S3 的 Error 体、WebDAV 的少量错误体） */
export function extractXmlError(body: string): { code: string; message: string } | null {
  if (!body || !/<Error[\s>]|<error[\s>]/i.test(body)) return null;
  const code = body.match(/<(?:amp;)?[Cc]ode>([^<]+)<\/[Cc]ode>/)?.[1]?.trim() || "";
  const msg = body.match(/<[Mm]essage>([^<]+)<\/[Mm]essage>/)?.[1]?.trim() || "";
  if (!code && !msg) return null;
  return { code, message: msg };
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64 || "");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 大小写不敏感取响应头 */
export function pickHeader(h: Record<string, string>, name: string): string {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(h || {})) {
    if (k.toLowerCase() === want) return String(v ?? "");
  }
  return "";
}

export async function cloudFetch(o: CloudFetchOptions): Promise<CloudFetchResult> {
  const r = await forwardProxyRaw({
    url: o.url,
    method: (o.method || "GET").toUpperCase(),
    headers: o.headers || {},
    payload: o.payload || "",
    contentType: o.contentType || "application/octet-stream",
    responseEncoding: o.binary ? "base64" : "text",
    timeout: o.timeoutMs ?? 120000,
  });

  // 内核层错误（还没到 HTTP 就失败了）
  if (r.code !== 0) {
    const msg = r.msg || "";
    if (/response body too large/i.test(msg)) {
      throw new CloudError(
        `文件超过思源内核单次响应上限（${Math.round(MAX_RESPONSE_BYTES / 1048576)} MB），且该服务不支持分片下载`,
        0,
        "kernel_too_large",
        msg
      );
    }
    if (/tls: failed to verify certificate|x509/i.test(msg)) {
      throw new CloudError("证书校验失败：该端点使用了自签名证书，内核不接受", 0, "kernel_tls", msg);
    }
    if (/ip address not allowed/i.test(msg)) {
      throw new CloudError("该地址被思源内核的安全策略拒绝", 0, "kernel_ssrf", msg);
    }
    throw new CloudError(`网络请求失败：${msg || "未知原因"}`, 0, "kernel", msg);
  }

  const result: CloudFetchResult = {
    status: r.status,
    headers: r.headers || {},
    text: o.binary ? "" : r.body,
    bytes: o.binary ? decodeBase64(r.body) : null,
  };

  if (r.status >= 400) {
    const xml = extractXmlError(r.body);
    const code = xml?.code || "";
    const server = (xml?.message || "").replace(/\s+/g, " ").trim().slice(0, 200);
    // 服务端原文常常是英文甚至 "Forbidden"，对使用者没有下一步价值；
    // 所以先给中文处置建议，再括号附上原文便于对照日志。
    let hint = "";
    if (r.status === 401 || r.status === 403) {
      hint =
        code === "SignatureDoesNotMatch"
          ? "签名不匹配：请检查 SecretKey、region 与本机时钟"
          : code === "AccessDenied"
            ? "访问被拒绝：该密钥没有这个桶/前缀的读权限"
            : "认证失败：请检查用户名与密码（坚果云要用「应用密码」）或 AccessKey/SecretKey";
    } else if (r.status === 404) {
      hint = "路径不存在：请检查服务器地址、书库目录或桶名";
    } else if (r.status === 409) {
      hint = "区域不匹配：endpoint 与 bucket 所在 region 不一致";
    }
    const human = hint ? (server ? `${hint}（${server}）` : hint) : server || `HTTP ${r.status}`;
    throw new CloudError(human, r.status, code, (result.text || "").slice(0, 2000));
  }

  return result;
}
