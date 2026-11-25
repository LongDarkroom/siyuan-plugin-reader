/**
 * 远端 EPUB 元数据（引用式导入用）
 * ---------------------------------------------------------------
 * 只取三样东西：container.xml、OPF、封面。走 Range，不下载整本。
 *
 * 失败语义：**任何一步不成立都返回 null**，由调用方决定是否回落
 * （服务器不支持 Range、Zip64、OPF 缺失、封面超限……都不该让导入失败，
 * 最差也该能「只有标题和作者为空、书名用文件名」地导进来）。
 */
import { RangeZip } from "./zip-range.ts";
import { parseContainerXml, parseOpf, coverExtOf, coverMimeOf } from "./epub-opf.ts";

export interface RemoteEpubMeta {
  title?: string;
  author?: string;
  language?: string;
  identifier?: string;
  cover?: { blob: Blob; ext: string };
}

/** 封面解压上限（与本地导入一致：封面只是缩略图） */
export const REMOTE_COVER_MAX = 8 * 1024 * 1024;

export async function extractEpubMetaRemote(
  url: string,
  sizeHint?: number,
  maxCover = REMOTE_COVER_MAX
): Promise<RemoteEpubMeta | null> {
  try {
    const zip = await RangeZip.open(url, sizeHint);

    let rootfile = "META-INF/container.xml";
    const containerXml = await zip.readText("META-INF/container.xml", 256 * 1024);
    if (containerXml) {
      rootfile = parseContainerXml(containerXml) || "";
      if (!rootfile) return null;
    } else {
      // 少数 EPUB 缺 container.xml：退一步找唯一的 .opf
      const opfName = zip.names.find((n) => n.toLowerCase().endsWith(".opf"));
      if (!opfName) return null;
      rootfile = opfName;
    }

    const opfXml = await zip.readText(rootfile, 2 * 1024 * 1024);
    if (!opfXml) return null;
    const info = parseOpf(opfXml, rootfile);

    let cover: { blob: Blob; ext: string } | undefined;
    if (info.cover) {
      const path = info.dir + info.cover.href;
      let bytes = await zip.read(path, maxCover);
      if (!bytes) {
        try {
          const decoded = info.dir + decodeURIComponent(info.cover.href);
          bytes = await zip.read(decoded, maxCover);
        } catch { /* 非法编码：保持原样 */ }
      }
      if (bytes) {
        const ext = coverExtOf(info.cover.href);
        cover = { blob: new Blob([new Uint8Array(bytes)], { type: coverMimeOf(ext, info.cover.mediaType) }), ext };
      }
    }
    return { title: info.title, author: info.author, language: info.language, identifier: info.identifier, cover };
  } catch {
    return null;
  }
}
