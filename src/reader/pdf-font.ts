/**
 * PDF 用的中文字体加载（2026-11-17，双语对照 PDF 导出）
 * ==================================================================
 *
 * 为什么要单独的 TTF（而不是复用阅读器用的 woff2）：
 *  pdf-lib 嵌字体时对输入格式有硬要求——
 *   - woff2：能 embed，但**不能 subset**（fontkit 报 `glyph._decode is not a function`）；
 *   - CFF 轮廓（.otf / CFF2）：能 embed，但会嵌成 CIDFontType0，
 *     **Chrome 画不出来**（文本能提取，页面却是空白）；
 *   - TrueType(glyf) 的 .ttf：embed + subset 都正常。
 *  ⇒ 随包分发的 `assets/fonts/REwordSerifSC-PDF.ttf` 就是转换后的产物
 *    （转换脚本：scripts/build_pdf_font.py）。
 *
 * 体积说明：TTF 5.27MB（7544 个汉字的 glyf 轮廓，无法再压）；
 * 但 pdf-lib 运行时 subset 后，每个产出的 PDF 只增加几 KB。
 */

/** 字体文件名（与 assets/fonts/ 下的产物同名） */
export const PDF_FONT_FILE = "assets/fonts/REwordSerifSC-PDF.ttf";

/** 插件资源 URL（思源把插件目录挂在 /plugins/<name>/ 下） */
export function pdfFontUrl(pluginName: string): string {
  const origin = typeof location !== "undefined" && location.origin ? location.origin : "";
  return `${origin}/plugins/${pluginName}/${PDF_FONT_FILE}`;
}

/** 已加载的字体字节（同一会话只取一次——5MB 不小） */
let fontBytesCache: Uint8Array | null = null;
let fontLoadPromise: Promise<Uint8Array | null> | null = null;

/**
 * 取 PDF 用中文字体字节。
 *
 * @param pluginName 插件名（用于拼资源 URL）
 * @returns 字体字节；取不到返回 null（调用方应给用户明确提示，别静默降级）
 */
export async function loadPdfFontBytes(pluginName: string): Promise<Uint8Array | null> {
  if (fontBytesCache) return fontBytesCache;
  if (fontLoadPromise) return fontLoadPromise;
  if (!pluginName) return null;
  fontLoadPromise = (async () => {
    try {
      const res = await fetch(pdfFontUrl(pluginName), { cache: "force-cache" });
      if (!res.ok) return null;
      const buf = new Uint8Array(await res.arrayBuffer());
      // 太小说明取到的是错误页（404 HTML 之类）
      if (buf.length < 100_000) return null;
      fontBytesCache = buf;
      return buf;
    } catch {
      return null;
    } finally {
      fontLoadPromise = null;
    }
  })();
  return fontLoadPromise;
}

/** 清掉缓存（测试用；或换书时不必要——字体与书无关） */
export function resetPdfFontCache(): void {
  fontBytesCache = null;
  fontLoadPromise = null;
}
