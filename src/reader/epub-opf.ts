/**
 * EPUB 的 container.xml / OPF 解析（本地导入与远端引用共用）
 * ---------------------------------------------------------------
 * 2026-11-25 从 bookshelf-store.extractEpubMeta 抽出：同一套字段解析现在有两条路径
 *   本地：整本 `unzipSync(filter)` → 内存里的三份字节
 *   远端：`RangeZip` 只取三个条目 → 同样三份字节
 * 两条路径必须得出**完全一致**的字段，所以解析只留一份实现。
 */

/** container.xml → OPF 相对路径 */
export function parseContainerXml(xml: string): string | null {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const rootfile = Array.from(doc.getElementsByTagName("rootfile"))[0]?.getAttribute("full-path");
  return rootfile || null;
}

export interface OpfInfo {
  title?: string;
  author?: string;
  language?: string;
  identifier?: string;
  /** OPF 所在目录（含尾斜杠），用于拼封面相对路径 */
  dir: string;
  /** 封面条目：相对 OPF 的 href（已去掉 #/?）+ media-type */
  cover?: { href: string; mediaType: string };
}

export function parseOpf(xml: string, rootfile: string): OpfInfo {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const dir = rootfile.includes("/") ? rootfile.slice(0, rootfile.lastIndexOf("/") + 1) : "";
  const q = (local: string): string | undefined => {
    const el = doc.getElementsByTagNameNS("*", local)[0];
    return el?.textContent?.trim() || undefined;
  };
  const info: OpfInfo = {
    title: q("title"),
    author: q("creator"),
    language: q("language"),
    identifier: q("identifier"),
    dir,
  };
  let coverId = "";
  for (const meta of Array.from(doc.getElementsByTagName("meta"))) {
    if (meta.getAttribute("name") === "cover") {
      coverId = meta.getAttribute("content") ?? "";
      break;
    }
  }
  if (coverId) {
    for (const item of Array.from(doc.getElementsByTagName("item"))) {
      if (item.getAttribute("id") === coverId) {
        const href = item.getAttribute("href") ?? "";
        if (href) {
          info.cover = {
            href: href.split("#")[0].split("?")[0],
            mediaType: item.getAttribute("media-type") ?? "",
          };
        }
        break;
      }
    }
  }
  return info;
}

/** 封面扩展名（用于落盘文件名与 MIME） */
export function coverExtOf(href: string): string {
  return (href.match(/\.(jpe?g|png|gif|webp)$/i)?.[1] ?? "jpg").toLowerCase();
}

export function coverMimeOf(ext: string, mediaType?: string): string {
  return mediaType || `image/${ext === "jpg" ? "jpeg" : ext}`;
}
