/**
 * 阅读器 · 云端书库 —— 分块 Range 下载
 * ----------------------------------------------------------------
 * 存在的理由只有一个：思源内核 `forwardProxy` 的单次响应硬顶是 32 MiB
 * （`code=10 response body too large: limit is 33554432 bytes`，2026-11-15 实测）。
 * 服务端支持 Range 时按片取就能突破；不支持时只能整取，于是 32 MiB 就成了
 * 真实文件上限 —— 这里必须把这两种情况分开处理，而不是假装都能下。
 *
 * 服务器忽略 Range 的表现是**返回 200 而不是 206**（实测 speed.cloudflare.com
 * 就这样）。首片看到 200 就要立刻改道，否则会把第一片的完整响应当成 8 MiB 拼错。
 */

import { cloudFetch, MAX_RESPONSE_BYTES, CloudError } from "./cloud-http.ts";

/** 单片字节数：留出 base64 膨胀（×4/3）与内核上限之间的余量 */
export const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;

export interface ChunkedDownloadOptions {
  /**
   * 每次 HTTP 尝试前取一次「完整请求」。S3 的签名里含时间戳，必须逐片重签，
   * 所以 url 和 headers 是一体的 —— 分开传就会签出对不上的 URL。
   */
  request: () => Promise<{ url: string; headers: Record<string, string> }>;
  /** 已知总大小；传 0 表示未知，走单次整取 */
  total: number;
  chunkSize?: number;
  onProgress?: (loaded: number, total: number) => void;
  shouldAbort?: () => boolean;
  timeoutMs?: number;
}

export interface DownloadedFile {
  file: File;
  /** 是否走了分片（用于提示"该服务不支持 Range"） */
  chunked: boolean;
}

function rangeHeader(start: number, end: number): Record<string, string> {
  return { Range: `bytes=${start}-${end}` };
}

/** 把 [start,end] 的响应体落到目标数组的对应偏移上 */
function place(target: Uint8Array, src: Uint8Array, start: number, total: number): number {
  const take = Math.min(src.length, total - start);
  target.set(src.subarray(0, take), start);
  return take;
}

export async function downloadChunked(o: ChunkedDownloadOptions, filename: string, mime = ""): Promise<DownloadedFile> {
  const chunkSize = Math.min(o.chunkSize ?? DEFAULT_CHUNK_BYTES, MAX_RESPONSE_BYTES);

  // 大小未知：单次整取，进度只有 0/100 两档
  if (!o.total || o.total <= 0) {
    o.onProgress?.(0, 0);
    const req = await o.request();
    const r = await cloudFetch({ url: req.url, method: "GET", headers: req.headers, binary: true, timeoutMs: o.timeoutMs });
    o.onProgress?.(1, 1);
    const bytes = r.bytes || new Uint8Array(0);
    return { file: new File([bytes as unknown as BlobPart], filename, { type: mime || guessMime(filename) }), chunked: false };
  }

  const merged = new Uint8Array(o.total);
  let loaded = 0;
  let chunked = false;

  for (let start = 0; start < o.total; start += chunkSize) {
    if (o.shouldAbort?.()) throw new CloudError("下载已取消", 0, "aborted");
    const end = Math.min(start + chunkSize, o.total) - 1;
    const req = await o.request();
    const r = await cloudFetch({
      url: req.url,
      method: "GET",
      headers: { ...req.headers, ...rangeHeader(start, end) },
      binary: true,
      timeoutMs: o.timeoutMs,
    });
    const bytes = r.bytes || new Uint8Array(0);

    // 服务器忽略 Range：整包在首片就回来了
    if (r.status === 200) {
      if (start > 0) throw new CloudError("该服务不支持分片下载（Range 被忽略）", 0, "no_range");
      if (o.total > MAX_RESPONSE_BYTES) {
        throw new CloudError(
          `该服务不支持分片下载，而文件超过内核单次上限 ${Math.round(MAX_RESPONSE_BYTES / 1048576)} MB`,
          0,
          "no_range_too_large"
        );
      }
      return { file: new File([bytes as unknown as BlobPart], filename, { type: mime || guessMime(filename) }), chunked: false };
    }

    const take = place(merged, bytes, start, o.total);
    if (take !== end - start + 1 && end !== o.total - 1) {
      throw new CloudError(`分片不完整（期望 ${end - start + 1} 字节，实到 ${take}）`, r.status, "short_chunk");
    }
    loaded += take;
    chunked = true;
    o.onProgress?.(loaded, o.total);
  }

  return { file: new File([merged as unknown as BlobPart], filename, { type: mime || guessMime(filename) }), chunked };
}

const MIME_BY_EXT: Record<string, string> = {
  epub: "application/epub+zip",
  pdf: "application/pdf",
  mobi: "application/x-mobipocket-ebook",
  azw3: "application/vnd.amazon.ebook",
  fb2: "application/xml",
  cbz: "application/x-cbz",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
};

export function guessMime(name: string): string {
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
  return MIME_BY_EXT[ext] || "application/octet-stream";
}
