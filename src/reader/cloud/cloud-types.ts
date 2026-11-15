/**
 * 阅读器 · 云端书库 —— 类型、账号存储与地址规范化
 * ----------------------------------------------------------------
 * ## 定位（2026-11-15 真机实测后定）
 * 远端**只存书的二进制文件，插件只读**。批注/进度/书签一律留在思源本地索引，
 * 云端文件下载后走现有 `importBook` 进书架，所以云端不需要知道"阅读状态"这件事。
 *
 * 不提供远端删除：软链方案实测 `removeFile` 会穿透软链删掉真实文件（验了两次），
 * 这条教训直接搬到这里 —— 云端书库的任何"移除"都只动本地索引。
 *
 * ## 为什么凭据存 localStorage 而不是插件设置
 * 插件的 `saveData` 落在 `/data/plugins/<name>/`，会跟着思源自己的 S3/WebDAV 数据
 * 备份整体被复制走。AccessKey / 应用密码不该出现在数据备份里，所以和 OPDS 书源
 * 同策略放 localStorage。代价是换设备要重配一次，可接受。
 */

export type CloudKind = "webdav" | "s3";

export interface CloudAccountBase {
  id: string;
  /** 用户自定义显示名，例如「坚果云」「家里 MinIO」 */
  name: string;
  kind: CloudKind;
}

export interface WebDavAccount extends CloudAccountBase {
  kind: "webdav";
  /** 服务器根，如 https://dav.jianguoyun.com/dav —— 不含末尾斜杠 */
  baseUrl: string;
  username: string;
  password: string;
  /** 书库目录，相对 baseUrl，如 "Books" */
  rootPath: string;
}

export interface S3Account extends CloudAccountBase {
  kind: "s3";
  /** 端点，如 https://s3.us-west-2.amazonaws.com 或 https://play.min.io */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** key 前缀（相当于书库目录），如 "books/" */
  prefix: string;
  /**
   * 寻址风格。非 amazonaws.com 的自建端点（MinIO / rclone / 群晖）基本只认
   * path-style，默认自动判为 true；AWS 用 virtual-hosted（bucket 进 host）。
   */
  pathStyle: boolean;
}

export type CloudAccount = WebDavAccount | S3Account;

/** 一个远端条目（目录或文件），两种 provider 归一后的形态 */
export interface RemoteEntry {
  /** 显示名（已解码的原始文件名） */
  name: string;
  /** 相对当前目录的路径；文件用它拼下载，目录用它下钻 */
  path: string;
  isDir: boolean;
  /** 字节数；目录或服务器未给大小时为 0 */
  size: number;
  /** ISO 时间字符串（服务器原样，可能缺失） */
  mtime?: string;
  /** 远端版本标识（S3 ETag / WebDAV getetag），用于变更判断 */
  etag?: string;
  contentType?: string;
}

/* ============================================================
 * 存储
 * ============================================================ */

export const CLOUD_ACCOUNTS_KEY = "reword-cloud-accounts";
export const CLOUD_ACTIVE_KEY = "reword-cloud-active";

/** localStorage 在无痕模式下会抛错，这里统一兜住（属于真实边界，不是假想防御） */
function safeGet(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function safeSet(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* 存不下就用当前会话，不阻断阅读 */
  }
}

function isWebDavAccount(x: any): x is WebDavAccount {
  return !!x && x.kind === "webdav" && typeof x.baseUrl === "string" && typeof x.id === "string";
}
function isS3Account(x: any): x is S3Account {
  return !!x && x.kind === "s3" && typeof x.bucket === "string" && typeof x.endpoint === "string" && typeof x.id === "string";
}

/** 读账号清单：坏条目丢弃而不是整批作废（手改过的 localStorage 不该让面板打不开） */
export function loadCloudAccounts(): CloudAccount[] {
  const raw = safeGet(CLOUD_ACCOUNTS_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x) => isWebDavAccount(x) || isS3Account(x)) as CloudAccount[];
  } catch {
    return [];
  }
}

export function saveCloudAccounts(list: CloudAccount[]): void {
  safeSet(CLOUD_ACCOUNTS_KEY, JSON.stringify(list));
}

export function loadActiveCloudId(): string {
  return safeGet(CLOUD_ACTIVE_KEY) || "";
}
export function saveActiveCloudId(id: string): void {
  safeSet(CLOUD_ACTIVE_KEY, id);
}

export function newCloudId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/* ============================================================
 * 规范化与展示
 * ============================================================ */

/** 补协议、去末尾斜杠；缺协议时按 https 处理（WebDAV 服务基本都是 https） */
export function normalizeBaseUrl(input: string): string {
  const s = (input || "").trim().replace(/\/+$/, "");
  if (!s) return "";
  if (/^[a-z]+:\/\//i.test(s)) return s;
  return `https://${s}`;
}

/** S3 端点规范化：允许用户只填 host，也允许填带 scheme 的完整端点 */
export function normalizeS3Endpoint(input: string): string {
  const s = (input || "").trim().replace(/\/+$/, "");
  if (!s) return "";
  if (/^[a-z]+:\/\//i.test(s)) return s;
  return `https://${s}`;
}

/** 目录路径规范化：去首尾斜杠，禁止 .. 逃逸（越界由服务器拒绝，但先别给它机会） */
export function normalizeDirPath(input: string): string {
  const s = (input || "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!s) return "";
  return s
    .split("/")
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .join("/");
}

/** S3 prefix 以 / 结尾（空 prefix 表示整桶） */
export function normalizeS3Prefix(input: string): string {
  const s = normalizeDirPath(input);
  return s ? `${s}/` : "";
}

const BOOK_EXT_RE = /\.(epub|mobi|azw3|fb2|cbz|pdf|txt|md|markdown)$/i;

export function isBookName(name: string): boolean {
  return BOOK_EXT_RE.test(name || "");
}

/** 书架导入用的扩展名判定与 importBook 的正则保持一致 */
export function bookExtOf(name: string): string {
  return (name.match(BOOK_EXT_RE)?.[1] || "").toLowerCase();
}

export function formatBytes(n: number): string {
  if (!n || n < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** 密钥展示用脱敏：只留头尾各 2 位 */
export function maskSecret(value: string): string {
  const s = value || "";
  if (!s) return "";
  if (s.length <= 4) return "••••";
  return `${s.slice(0, 2)}••••${s.slice(-2)}`;
}
