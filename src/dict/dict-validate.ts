/**
 * 词典文件格式校验（2026-10-08 新增；2026-11-20 修正文件头识别）
 * ----------------------------------------------------------------
 * ## 为什么需要它
 *
 * 改造前的 `importDictFile()` **没有任何格式校验**：写盘 + 登记清单就算成功，
 * 真正的解析推迟到**查词那一刻**才发生。后果是用户看到的是：
 *
 *   导入 → 「已导入」✓  → 划词 → 什么都没出来 / 报一句看不懂的错
 *
 * ⇒ 本模块把「能不能用」这个判断**提前到导入那一刻**，并给出
 *   **可行动**的报错（不是「导入失败」四个字）。
 *
 * ## 🔴 2026-11-20 修正：MDict 并没有 `AD DE` 魔数
 *
 * 旧实现把「前两字节 = AD DE」当成 mdict 的魔数，实际上**所有真正的
 * .mdx/.mdd 都以「4 字节大端头长度 + UTF-16LE XML 头」开头**：
 *
 *   00 00 06 A6 | 3C 00 44 00 69 00 63 00 …   →  <Dictionary GeneratedByEngineVersion="2.0" …
 *
 * 后果是 ncecd、新汉英大辞典等一切合法词库都被判为「不是 mdict」，
 * 导入全线失败（REword 的词典也因此无法在阅读器里重新导入）。
 *
 * 旧版还把 `Library_Data` 头误判成「欧路导出」——其实那是 **.mdd 资源包
 * 的标准头**，说明用户拖进来的是一本词典的图片/CSS 包，缺了词典本体。
 *
 * 现在的识别规则：解析 4 字节头长度 → UTF-16LE 文本 → 看根元素：
 *   `<Dictionary …>`   = 词典本体（.mdx）
 *   `<Library_Data …>` = 资源包（.mdd）
 */

import { t } from "../i18n/index.ts";

/** MDict 头部最大长度：正常词库头 1~4KB；给到 16KB 容错，同时防止把垃圾长度当真去解码 */
const MDICT_HEADER_MAX = 16384;

/** 支持的词典格式 */
export type DictFormat = "mdx" | "stardict";

export interface ValidateOk {
  ok: true;
  format: DictFormat;
  /** mdict 的版本号（1/2/3），仅 mdict 有 */
  version?: number;
}

export interface ValidateFail {
  ok: false;
  /** 可直接展示给用户的理由（已 i18n） */
  reason: string;
  /** 机器可读的分类，便于界面选择不同的视觉强调 */
  code:
    | "empty"          // 空文件
    | "not-mdict"      // 扩展名 .mdx 但内容不是 mdict
    | "looks-like-eudic" // 疑似欧路导出文件
    | "mdd-as-mdx"     // 拖进来的是 .mdd 资源包，不是词典本体
    | "not-stardict"   // starDict 缺配套文件
    | "too-small";     // 体积小到不可能是词典
}

export type ValidateResult = ValidateOk | ValidateFail;

/** 读前n 字节为 base64/hex 片段，用于报错时告诉用户「我看到的开头是什么」 */
function hexPreview(buf: Uint8Array, n = 8): string {
  return Array.from(buf.slice(0, n))
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join(" ");
}

/** UTF-16LE 解码（Node 与 Electron 都有 TextDecoder；兜底手写解码便于单测环境） */
function decodeUtf16Le(bytes: Uint8Array): string {
  const Ctor = (globalThis as any).TextDecoder;
  if (typeof Ctor === "function") {
    try {
      return new Ctor("utf-16le").decode(bytes);
    } catch { /* 落到手写解码 */ }
  }
  let s = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
  return s;
}

interface MdictHeader {
  kind: "mdx" | "mdd";
  /** GeneratedByEngineVersion / RequiredEngineVersion 的主版本号 */
  version?: number;
}

/**
 * 读取 MDict 头部：前 4 字节是**大端**头长度，随后是 UTF-16LE 的 XML 头。
 *
 * 真实样本（ncecd.mdx / 新汉英大辞典.mdx）：
 *   `00 00 06 A6` + `<Dictionary GeneratedByEngineVersion="2.0" …>`
 * .mdd 资源包：
 *   `00 00 01 B0` + `<Library_Data GeneratedByEngineVersion="2.0" …>`
 *
 * 返回 null 表示不是 MDict 容器（或头长度不可信）。
 */
function readMdictHeader(buf: Uint8Array): MdictHeader | null {
  if (buf.length < 12) return null;
  const len = ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0;
  if (!len || len > MDICT_HEADER_MAX || 4 + len > buf.length) return null;
  const text = decodeUtf16Le(buf.subarray(4, 4 + len)).replace(/^\uFEFF/, "").trimStart();
  if (/^<\s*Dictionary\b/i.test(text)) {
    const m = /(?:GeneratedBy|Required)EngineVersion="([^"]+)"/i.exec(text);
    const version = m ? parseInt(m[1], 10) : undefined;
    return { kind: "mdx", version: Number.isFinite(version) ? version : undefined };
  }
  if (/^<\s*Library_Data\b/i.test(text)) return { kind: "mdd" };
  return null;
}

/** 是否为 SQLite 数据库（欧路等 App 的导出格式；魔数在文件最开头） */
function looksLikeSqlite(buf: Uint8Array): boolean {
  const magic = "SQLite format 3\u0000";
  if (buf.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (buf[i] !== magic.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * 校验一个待导入的词典文件。
 *
 * @param buf    文件内容
 * @param name   原始文件名（用于判扩展名 + starDict 配套检查）
 * @param hasCompanion .stardict 专用：同 stem 的 .idx / .dict 是否已存在
 */
export function validateDictFile(
  buf: Uint8Array,
  name: string,
  hasCompanion?: { idx: boolean; dict: boolean },
): ValidateResult {
  const lower = (name || "").toLowerCase();

  // ---- ① 空文件 ----
  if (!buf || buf.length === 0) {
    return { ok: false, code: "empty", reason: t("文件是空的，没有内容可导入") };
  }

  // ---- ② starDict：靠扩展名 + 配套文件 ----
  if (/\.ifo$/i.test(lower)) {
    if (!hasCompanion) {
      return {
        ok: false,
        code: "not-stardict",
        reason: t("starDict 词典需成套文件（.ifo / .idx / .dict），单文件导入不适用"),
      };
    }
    if (!hasCompanion.idx || !hasCompanion.dict) {
      const missing = [!hasCompanion.idx ? ".idx" : "", !hasCompanion.dict ? ".dict" : ""]
        .filter(Boolean)
        .join(" 与 ");
      return {
        ok: false,
        code: "not-stardict",
        reason: t("starDict 词典缺少配套文件：{missing}（请把整套文件一起选中）").replace(
          "{missing}",
          missing,
        ),
      };
    }
    return { ok: true, format: "stardict" };
  }

  // ---- ③ 非 .mdx/.ifo：直接拒 ----
  if (!/\.mdx$/i.test(lower)) {
    return {
      ok: false,
      code: "not-mdict",
      reason: t("只支持 .mdx 词典包（可搭配同名 .mdd 资源包）；starDict 请整套导入 .ifo / .idx / .dict"),
    };
  }

  // ---- ④ MDict：解析「4 字节头长度 + UTF-16LE XML 头」----
  // 体积门槛放在结构校验之后：宁可先给准确原因，再补体积提示。
  if (looksLikeSqlite(buf)) {
    return {
      ok: false,
      code: "looks-like-eudic",
      reason:
        t("这看起来是欧路词典（Eudic）的导出数据库，不是 mdict 词典包。") +
        t("它不能直接改名成 .mdx 使用 —— 请导入 mdict 格式的词典包。"),
    };
  }

  const header = readMdictHeader(buf);
  if (!header) {
    // 🔴 `.replace()` 只能作用在**紧邻的那个字符串**上 ——
    //   写成 `t("…{hex}…") + t("…").replace("{hex}", x)` 时，替换只发生在第二段，
    //   第一段的 `{hex}` 会原样漏给用户（实测踩到）。
    //⇒ 必须先拼成整句、再 replace。
    return {
      ok: false,
      code: "not-mdict",
      reason: (
        t("这不是有效的 mdict 词典包（真实 MDict 以「头部长度 + <Dictionary …>」开头，实际是{hex}）。") +
        t("常见原因：下载不完整，或把其它格式直接改了扩展名。")
      ).replace("{hex}", hexPreview(buf)),
    };
  }

  if (header.kind === "mdd") {
    return {
      ok: false,
      code: "mdd-as-mdx",
      reason: t(
        "这是 .mdd 资源包（图片 / CSS / 音频），不是词典本体。请找到同名的 .mdx 词典文件，和它一起选中导入。",
      ),
    };
  }

  // ---- ⑤ 体积兜底 ----
  // 结构成立但小于 4KB 的，基本是被截断/占位的空包。
  if (buf.length < 4096) {
    return {
      ok: false,
      code: "too-small",
      reason: t("文件只有 {size} 字节，即便格式正确也不像一本完整词典，请确认下载完整").replace(
        "{size}",
        String(buf.length),
      ),
    };
  }

  return { ok: true, format: "mdx", version: header.version };
}

/**
 * 计算内容哈希（对标 Readest 的「内容哈希做身份」）。
 *
 * 用途：识别「同一本词典的重复导入」。
 * Readest 用 `partialMD5 + byteSize + sortedFilenames`，这里取同样思路但
 * **只哈希首尾各若干 KB** —— 中间部分不参与，理由：
 *   - 大文件（几十 MB）全量哈希会明显拖慢导入；
 *   - 词典文件改版本时通常整体重写、首尾会变，取首尾足以区分。
 *
 * 用 FNV-1a 32 位 ×2（不同偏移、不同素数）拼成一个 16 位十六进制串。
 * 它**不是**密码学哈希 —— 只用于「同一份文件重复导入」的快速识别，
 * 碰撞只会导致两本不同的词典被认为相同（用户手动改回即可）。
 */
export function dictContentHash(buf: Uint8Array): string {
  const CHUNK = 4096;
  const head = buf.slice(0, Math.min(CHUNK, buf.length));
  const tail = buf.length > CHUNK * 2 ? buf.slice(buf.length - CHUNK) : new Uint8Array(0);

  const fnv = (data: Uint8Array, seed: number, prime: number): number => {
    let h = seed >>> 0;
    for (let i = 0; i < data.length; i++) {
      h ^= data[i];
      h = Math.imul(h, prime) >>> 0;
    }
    return h >>> 0;
  };

  const a = fnv(head, 0x811c9dc5, 0x01000193);
  const b = fnv(tail, 0x811c9dc5 ^ buf.length, 0x01000193);
  return (a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0")).slice(0, 16);
}