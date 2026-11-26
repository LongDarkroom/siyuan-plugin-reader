/**
 * PDF 用的中文字体加载（2026-11-17 引入；2026-11-26 改为「首次导出时才下载」）
 * ==================================================================
 *
 * 为什么必须是单独的 TTF（不能复用阅读器用的 woff2）：
 *  pdf-lib 嵌字体时对输入格式有硬要求——
 *   - woff2：能 embed，但**不能 subset**（fontkit 报 `glyph._decode is not a function`）；
 *   - CFF 轮廓（.otf / CFF2）：能 embed，但会嵌成 CIDFontType0，
 *     **Chrome 画不出来**（文本能提取，页面却是空白）；
 *   - TrueType(glyf) 的 .ttf：embed + subset 都正常。
 *  ⇒ 产物是 `assets/fonts/REwordSerifSC-PDF.ttf`（7544 个汉字的 glyf 轮廓，5.27MB，
 *    生成脚本 `scripts/build_pdf_font.py`）。
 *
 * 为什么不再随包分发（0.11.6 起）：
 *  5.27MB 占发行包四成体积，而它只在「PDF 整本翻译」这一条路径上用到，绝大多数用户
 *  一次都不会触发。装包越大、文件越多，集市更新时内核整目录 rename 被占用的概率越高。
 *  所以改成：包里不带，首次导出时下载一次，落到 `data/public/<插件>/fonts/` 长期缓存
 *  （和自定义字体同目录，更新插件不会丢；这里不参与同步，也不触发内核重载）。
 *
 * 取字体的顺序（先本地、后网络，能离线就离线）：
 *   1. 内存缓存（同一会话只跑一次）
 *   2. `data/public/<插件>/fonts/REwordSerifSC-PDF.ttf` —— 上次下载留下的
 *   3. `/plugins/<插件>/assets/fonts/...` —— 本地开发副本、或 0.11.5 及以前的安装
 *   4. CDN 下载（jsDelivr 固定 tag → jsDelivr 备线 → raw.githubusercontent）
 *
 * 校验：sfnt 头必须是 0x00010000（TrueType），且体积 ≥ 1MB。少了这道，
 * 一次 404 错误页、一次 CDN 拦截页都会被当成字体塞给 pdf-lib，报错信息会跑偏
 * 到「字体解析失败」，用户根本想不到是网络问题。
 */

import { getFileBlob, putFile } from "../siyuan/api";
import { probeFile } from "./file-probe.ts";
import { PLUGIN_VERSION } from "../core/changelog.ts";

/** 字体文件名（发布仓库里的路径与包内路径都用它） */
export const PDF_FONT_NAME = "REwordSerifSC-PDF.ttf";

/** 包内相对路径（本地开发副本 / 0.11.5 及以前随包分发的版本） */
export const PDF_FONT_FILE = `assets/fonts/${PDF_FONT_NAME}`;

/** 字体发布仓库（插件仓库本身；字体文件留在仓库里，只是不进安装包） */
const FONT_REPO = "LongDarkroom/siyuan-plugin-reader";
/** 仓库内路径 */
const FONT_REPO_PATH = `assets/fonts/${PDF_FONT_NAME}`;

/** 合法字体下限：截断文件与错误页都过不了；真实约 5.27MB */
const MIN_FONT_BYTES = 1_000_000;

/**
 * 包内字体 URL（思源把插件目录挂在 `/plugins/<name>/` 下）。
 * 0.11.6 起包内不再有这个文件，这里只作为「本地开发 / 老版本残留」的快路径。
 */
export function pdfFontUrl(pluginName: string): string {
  const origin = typeof location !== "undefined" && location.origin ? location.origin : "";
  return `${origin}/plugins/${pluginName}/${PDF_FONT_FILE}`;
}

/** 下载后的缓存落点：与自定义字体同目录（public 不参与同步，也不触发重载） */
export function pdfFontCachePath(pluginName: string): string {
  return `/data/public/${pluginName}/fonts/${PDF_FONT_NAME}`;
}

/**
 * 下载源，按顺序尝试。
 *
 * - 固定 tag（`@v<当前版本>`）优先：内容不可变，CDN 可以长期缓存；
 * - 三个 jsDelivr 域名（cdn / fastly / gcore）是同一份内容的不同入口，
 *   国内网络经常只挂其中一个，所以逐个试而不是只写一个；
 * - 版本号没注入（测试 / 构建漏配置）时退回 `@main`；
 * - `raw.githubusercontent` 放最后：域名经常不可达，但仓库主干的文件一定最新。
 */
export function pdfFontRemoteSources(version: string = PLUGIN_VERSION): string[] {
  const out: string[] = [];
  if (version) {
    const tag = `@v${version.replace(/^v/, "")}`;
    for (const host of ["cdn", "fastly", "gcore"]) {
      out.push(`https://${host}.jsdelivr.net/gh/${FONT_REPO}${tag}/${FONT_REPO_PATH}`);
    }
  } else {
    out.push(`https://cdn.jsdelivr.net/gh/${FONT_REPO}@main/${FONT_REPO_PATH}`);
  }
  out.push(`https://raw.githubusercontent.com/${FONT_REPO}/main/${FONT_REPO_PATH}`);
  return out;
}

/** 已加载的字体字节（同一会话只取一次——5MB 不小） */
let fontBytesCache: Uint8Array | null = null;
let fontLoadPromise: Promise<Uint8Array | null> | null = null;

/** sfnt 头校验：必须是 TrueType(glyf) 且体积合理 */
function isUsableFont(bytes: Uint8Array | null | undefined): bytes is Uint8Array {
  if (!bytes || bytes.length < MIN_FONT_BYTES) return false;
  // 0x00010000 = TrueType；"OTTO"（CFF）不能要，嵌进 PDF 后 Chrome 画不出来
  return bytes[0] === 0x00 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00;
}

/** 读本地文件（先探在位，避免对不存在的大文件发起整份请求） */
async function readLocalFont(path: string): Promise<Uint8Array | null> {
  try {
    const state = await probeFile(path);
    if (state !== true) return null;
    const blob = await getFileBlob(path);
    if (!blob) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return isUsableFont(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

/** 包内副本（本地开发 / 老版本安装）；包里没有时是 404，一次请求就结束 */
async function readBundledFont(pluginName: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(pdfFontUrl(pluginName), { cache: "force-cache" });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    return isUsableFont(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

/** 依次试下载源；全部失败返回 null（调用方负责给用户可执行的提示） */
async function downloadFont(version: string): Promise<Uint8Array | null> {
  for (const url of pdfFontRemoteSources(version)) {
    try {
      const res = await fetch(url, { cache: "force-cache" });
      if (!res.ok) continue;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (isUsableFont(bytes)) return bytes;
    } catch {
      // 换下一个源
    }
  }
  return null;
}

/** 把下载到的字体写进 public 缓存（失败只影响下次还得再下载，不影响本次导出） */
async function persistFont(pluginName: string, bytes: Uint8Array): Promise<void> {
  try {
    const path = pdfFontCachePath(pluginName);
    await putFile(path.slice(0, path.lastIndexOf("/")), true, null);
    await putFile(path, false, new Blob([bytes as BlobPart], { type: "font/ttf" }));
  } catch {
    // 忽略：最坏情况是下次导出再下一次
  }
}

/** 取字体时的可选回调 */
export interface PdfFontLoadOptions {
  /** 真正要走网络下载时回调一次（命中本地缓存不回调），用于提示用户「正在下载」 */
  onDownload?: () => void;
}

/**
 * 取 PDF 用中文字体字节（首次会下载并缓存到 public）。
 *
 * @param pluginName 插件名（用于拼包内路径与缓存路径）
 * @returns 字体字节；取不到返回 null（调用方应给用户明确提示，别静默降级）
 */
export async function loadPdfFontBytes(
  pluginName: string,
  opts: PdfFontLoadOptions = {}
): Promise<Uint8Array | null> {
  if (fontBytesCache) return fontBytesCache;
  if (fontLoadPromise) return fontLoadPromise;
  if (!pluginName) return null;
  fontLoadPromise = (async () => {
    try {
      const local =
        (await readLocalFont(pdfFontCachePath(pluginName))) ?? (await readBundledFont(pluginName));
      if (local) {
        fontBytesCache = local;
        return local;
      }
      opts.onDownload?.();
      const downloaded = await downloadFont(PLUGIN_VERSION);
      if (!downloaded) return null;
      fontBytesCache = downloaded;
      await persistFont(pluginName, downloaded);
      return downloaded;
    } catch {
      return null;
    } finally {
      fontLoadPromise = null;
    }
  })();
  return fontLoadPromise;
}

/** 清掉内存缓存（测试用；换书不必——字体与书无关） */
export function resetPdfFontCache(): void {
  fontBytesCache = null;
  fontLoadPromise = null;
}
