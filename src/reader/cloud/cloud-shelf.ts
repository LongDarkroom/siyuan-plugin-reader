/**
 * 阅读器 · 云端书库 —— provider 门面
 * ----------------------------------------------------------------
 * 面板只跟这一层打交道：列目录、测连接、下载成 File。
 * 下载产物直接交给现有 `BookshelfStore.importBook`，于是去重（内容指纹）、
 * 封面提取、进度与批注全部沿用本地书架那套，云端不额外发明第二条阅读通路。
 */

import { CloudError } from "./cloud-http.ts";
import { listWebdavDir, statWebdav, webdavHeaders, webdavUrlFor } from "./webdav-client.ts";
import { listS3Dir, s3ObjectKey, s3Signed, statS3 } from "./s3-client.ts";
import { downloadChunked } from "./range-download.ts";
import type { CloudAccount, RemoteEntry, S3Account, WebDavAccount } from "./cloud-types.ts";

export type RequestFactory = () => Promise<{ url: string; headers: Record<string, string> }>;

export function isWebdav(acct: CloudAccount): acct is WebDavAccount {
  return acct.kind === "webdav";
}
export function isS3(acct: CloudAccount): acct is S3Account {
  return acct.kind === "s3";
}

/** 列目录（rel 为相对书库根的路径，"" 表示根） */
export async function listCloud(acct: CloudAccount, rel: string): Promise<RemoteEntry[]> {
  if (isWebdav(acct)) return listWebdavDir(acct, rel);
  return listS3Dir(acct, rel);
}

/** 单个文件大小（S3 用 HEAD，WebDAV 优先 PROPFIND Depth:0） */
async function statCloud(acct: CloudAccount, rel: string): Promise<number> {
  if (isWebdav(acct)) return (await statWebdav(acct, rel)).size;
  return (await statS3(acct, rel)).size;
}

/** 每片请求（含重签名/重取 Basic 头） */
function requestFactoryFor(acct: CloudAccount, rel: string): RequestFactory {
  if (isWebdav(acct)) {
    const url = webdavUrlFor(acct, rel);
    const headers = webdavHeaders(acct);
    return async () => ({ url, headers });
  }
  return async () => {
    const signed = await s3Signed(acct, "GET", s3ObjectKey(acct, rel));
    return { url: signed.url, headers: signed.headers };
  };
}

export interface DownloadCloudOptions {
  onProgress?: (loaded: number, total: number) => void;
  shouldAbort?: () => boolean;
}

/**
 * 下载一个云端文件为 File。
 * 大小探测失败不致命：拿不到 total 就退化为单次整取（>32 MiB 会由内核报错，
 * 那时给出的文案已经明确说明原因）。
 */
export async function downloadCloud(
  acct: CloudAccount,
  entry: RemoteEntry,
  opts: DownloadCloudOptions = {}
): Promise<File> {
  const total = entry.size || (await statCloud(acct, entry.path).catch(() => 0));
  const { file } = await downloadChunked(
    {
      request: requestFactoryFor(acct, entry.path),
      total,
      onProgress: opts.onProgress,
      shouldAbort: opts.shouldAbort,
    },
    entry.name,
    entry.contentType || ""
  );
  return file;
}

export interface CloudTestResult {
  ok: boolean;
  message: string;
  entries: number;
}

/** 连通性自检：列一次书库根目录，把失败原因翻成人话 */
export async function testCloud(acct: CloudAccount): Promise<CloudTestResult> {
  try {
    const list = await listCloud(acct, "");
    return {
      ok: true,
      message: `连接成功，根目录下 ${list.length} 个条目`,
      entries: list.length,
    };
  } catch (e: any) {
    const err: CloudError = e instanceof CloudError ? e : new CloudError(e?.message || String(e));
    return { ok: false, message: err.message || "连接失败", entries: 0 };
  }
}
