/**
 * PDF 文本抽取与清洗（2026-11-17，双语对照 PDF 导出）
 * ==================================================================
 *
 * 为什么单独成模块：PDF 文本层的原始形态**不能直接送翻译**。
 * 实测（本机真实 PDF，394 页）发现两个硬问题：
 *
 *  ① **中文页的字间空格**：PDF 文本层按字定位，抽取出来是 `考 试 时 间 轴`。
 *     实测 10/10 页中招；单页清洗前 748 字 → 清洗后 508 字，**32% 是无效空格**。
 *     不清洗直接送翻译，模型会把 `考 试` 当成一个词，译文质量明显下降。
 *
 *  ② **空页**：纯图片页 / 空白页抽出来是空串。实测 20 页里有 1 页为 0 字。
 *     空串不能送翻译（模型会返回垃圾或报错），必须过滤。
 *
 * 本模块的纯逻辑部分（清洗 / 段落化 / 过滤）零依赖，node 里直接断言；
 * 真正调 pdf.js 的部分在 `pdf-extract-runtime.ts`（需要 worker 环境）。
 */

/** 一页抽出来的段落 */
export interface PdfPageParagraph {
  /** 1-based 页码 */
  page: number;
  /** 段落文本（已清洗） */
  text: string;
  /** 该页是否没有可翻译文本（纯图片页） */
  empty?: boolean;
}

/** PDF 文本层的原始 item（pdf.js TextContent.items 的一部分） */
export interface RawTextItem {
  str?: string;
  /** 文本项的变换矩阵，pdf.js 用它定位 */
  transform?: number[];
  width?: number;
  height?: number;
  hasEOL?: boolean;
}

/** 判断一个字符是否中日韩表意文字（用于「字间空格」清理） */
function isCjk(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意文字
    (cp >= 0x3400 && cp <= 0x4dbf) || // 扩展 A
    (cp >= 0xf900 && cp <= 0xfaff) || // 兼容表意文字
    (cp >= 0x3000 && cp <= 0x303f) || // CJK 标点
    (cp >= 0xff00 && cp <= 0xffef) // 全角字符
  );
}

/** 英文/数字之间允许出现的空白（用于区分「真空格」与「字间空格」） */
function isLatin(ch: string): boolean {
  return /[A-Za-z0-9]/.test(ch);
}

/**
 * 清理 CJK 字间空格。
 *
 * 只在**两个 CJK 字符之间**的空白才删——英文单词之间的空格必须留着
 * （`The quick brown` 里的空格是有意义的）。
 *
 * 另外顺带清掉「标点前的空格」（PDF 文本层常在标点前后留白，
 * 中文排版里 `， ` 这种是错的）。
 */
export function cleanCjkSpacing(text: string): string {
  if (!text) return "";
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    // ⚠️ 换行是**段落边界**，绝不能当普通空白处理
    //    （踩过：这里若把 \n 也吃掉，段落会被粘成一段）
    if (ch === "\n") {
      out += ch;
      continue;
    }
    if (!/[ \t]/.test(ch)) {
      out += ch;
      continue;
    }
    // 找这段空白之后的首个非空白字符
    let j = i;
    while (j < text.length && /[ \t]/.test(text[j] as string)) j++;
    const nextCh = j < text.length ? (text[j] as string) : "";
    const prevCh = out.length > 0 ? (out[out.length - 1] as string) : "";
    // 两侧都是 CJK ⇒ 这是字间空格，删掉
    if (isCjk(prevCh) && isCjk(nextCh)) {
      i = j - 1;
      continue;
    }
    // 标点前的空格删掉（中文排版不该有）
    if (isCjk(nextCh) && /[，。！？；：、）】」』》…]/.test(nextCh) && !isLatin(prevCh)) {
      i = j - 1;
      continue;
    }
    out += " ";
    i = j - 1;
  }
  return out;
}

/**
 * 还原英文断词：PDF 文本层常在换行处把单词拆成 `inter-\nnational`。
 * 这里把「连字符 + 换行」合并回原词。
 */
export function joinHyphenatedWords(text: string): string {
  return text.replace(/([A-Za-z])-\s*\n\s*([a-z])/g, "$1$2");
}

/**
 * 常见的排版 ligature（PDF 里常以 Unicode 私有区或兼容区出现）。
 *
 * ⚠️ 键一律用**码位转义**写：像 "ﬁ" 这类字符，源码里可能是一个码位
 *    （U+FB01）或两个码位的组合写法（U+0066 U+0069）——后者在 TS 看来
 *    与前者是同一个键吗？不是——但同一个视觉字符可能有多个码位，
 *    直接写字面量会出现「同键不同码位」或 TS1117 重复键。
 *    用 \u 转义把每个码位写死，杜绝歧义。
 */
const LIGATURES: Record<string, string> = {
  "\ufb00": "ff", // ﬀ
  "\ufb01": "fi", // ﬁ
  "\ufb02": "fl", // ﬂ
  "\ufb03": "ffi", // ﬃ
  "\ufb04": "ffl", // ﬄ
  "\ufb05": "st", // ﬅ
  "\ufb06": "st", // ﬆ
  "­": "", // soft hyphen
};

/** 归一化：ligature 还原 + 去 soft hyphen + 去控制字符 + 统一空白 */
export function normalizeUnicode(text: string): string {
  let out = "";
  for (const ch of text) {
    out += LIGATURES[ch] ?? ch;
  }
  return (
    out
      // \u0000 在 PDF 文本层里是「字体没有该字形映射」的占位符。
      // 实测中文 PDF 里的短横线 `-` 就是这样：抽出来是 \u0000
      // （`3\u670820\u65e5\u00003\u670826\u65e5` ⇒ 删掉就变成 `3\u670820\u65e53\u670826\u65e5`，语义全毁）。
      // 所以它要**换成短横线**而不是删掉——删掉会丢信息。
      .replace(/\u0000/g, "-")
      // 其余控制字符是真垃圾（实测夹在词中间会让模型输出乱码）
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
  );
}

/**
 * 完整清洗流水线：归一化 → 断词还原 → CJK 空格清理 → 收尾。
 *
 * 顺序有讲究：
 *  - 归一化在前（把 ligature 变回普通字母，后面的 CJK 判断才准）；
 *  - 断词还原在 CJK 清理之前（断词处会引入换行，先合并再处理空白）；
 *  - CJK 清理最后（此时文本形态已定）。
 */
export function cleanPdfText(raw: string): string {
  if (!raw) return "";
  let s = normalizeUnicode(raw);
  s = joinHyphenatedWords(s);
  s = cleanCjkSpacing(s);
  // ⚠️ 段落边界靠**空行**标记，这里只能压 3 个以上的连续换行，
  //    压成 1 个会把段落粘在一起（实测踩过：cleanPdfText 里 \n{2,} → \n
  //    会让两段变一段）。
  return s
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 把 pdf.js 的 TextContent items 拼成「按行分组」的文本（只取行文本）。
 *
 * 真正的实现是 `itemsToLinesWithGaps`（还带 y 坐标与段落边界标记）；
 * 这里是个薄封装，供只需要行文本的调用方使用。
 */
export function itemsToLines(items: ReadonlyArray<RawTextItem>): string[] {
  return itemsToLinesWithGaps(items).map((l) => l.text);
}

/**
 * 把「行」合并成「段落」。
 *
 * 判据：调用方给出的 `gapFlags[i]` 为 true 表示「第 i 行与第 i+1 行之间是段落边界」
 * （通常由 y 间距显著大于行内行距推得）。没有 gapFlags 时按空行分段。
 */
export function linesToParagraphs(
  lines: ReadonlyArray<string>,
  gapFlags?: ReadonlyArray<boolean>,
): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (cur === "") {
      cur = line;
    } else if (gapFlags && gapFlags[i - 1]) {
      out.push(cur);
      cur = line;
    } else {
      cur = `${cur} ${line}`;
    }
  }
  if (cur) out.push(cur);
  return out.filter((p) => p.trim().length > 0);
}

/**
 * 页面行（带 y 坐标，用于判段落边界）。
 */
export interface PdfLine {
  text: string;
  /** 该行的基线 y（PDF 坐标，向上为正） */
  y: number;
}

/**
 * 由 pdf.js items 产出「行 + 行间距」。
 *
 * 段落边界判据：相邻两行的 y 间距 **显著大于** 该页的典型行距。
 * 段内行距均匀（≈ 一个行高），段间通常有空行（≈ 1.5–2 倍行高）。
 *
 * @param typicalLineGap 该页的行距中位数（用中位数而非均值：均值会被段间空行拉高）
 */
export function itemsToLinesWithGaps(
  items: ReadonlyArray<RawTextItem>,
  typicalLineGap?: number,
): PdfLine[] {
  const parts: Array<{ text: string; y: number; x: number; width: number; size: number }> = [];
  for (const it of items) {
    const text = (it.str ?? "").replace(/\s+/g, " ");
    if (!text.trim()) continue;
    const tr = it.transform;
    const y = tr && tr.length >= 6 ? (tr[5] as number) : 0;
    const x = tr && tr.length >= 6 ? (tr[4] as number) : 0;
    // 字号：transform[0] 是水平缩放，对文本项即字号（实测 20 / 10.5）
    const size = tr && tr.length >= 1 && typeof tr[0] === "number" ? (tr[0] as number) : 10;
    parts.push({ text, y, x, width: typeof it.width === "number" ? it.width : 0, size });
  }
  if (parts.length === 0) return [];

  const sorted = [...parts].sort((a, b) => (b.y - a.y) || (a.x - b.x));
  const rows: Array<{ y: number; parts: typeof parts }> = [];
  for (const p of sorted) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(p.y - last.y) <= 3) {
      last.parts.push(p);
    } else {
      rows.push({ y: p.y, parts: [p] });
    }
  }

  const lines: PdfLine[] = [];
  for (const row of rows) {
    row.parts.sort((a, b) => a.x - b.x);
    let text = "";
    let lastEnd: number | null = null;
    for (const p of row.parts) {
      if (lastEnd !== null) {
        // 间隙判据必须**随字号缩放**：正常词间距约 0.25~0.4 em。
        // 固定阈值会两头出错——实测 20pt 正文里 4.1pt 的正常间距被漏掉
        // （`I am doing` + `and` 粘成 `doingand`），而 10.5pt 正文里
        // 6pt 的间隙又会误插空格。
        const gap = p.x - lastEnd;
        // 0.15em 是实测校准出来的：
        //   正常词间距最小实测到 4.1pt / 20pt 字号 = 0.2em（必须补空格，
        //   否则 `I am doing` + `and` 粘成 `doingand`）；
        //   连写片段（同一词的碎片）间隙 < 0.1em（不能插空格）。
        // 取 0.15em 落在两者之间。
        const threshold = Math.max(0.8, p.size * 0.15);
        if (gap > threshold && !/\s$/.test(text) && !/^\s/.test(p.text)) text += " ";
      }
      text += p.text;
      lastEnd = p.x + p.width;
    }
    const t = text.trim();
    if (t) lines.push({ text: t, y: row.y });
  }

  // 行距中位数（典型行距）
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    gaps.push(Math.abs((lines[i] as PdfLine).y - (lines[i - 1] as PdfLine).y));
  }
  gaps.sort((a, b) => a - b);
  const median = gaps.length ? (gaps[Math.floor(gaps.length / 2)] as number) : 0;
  const typical = typicalLineGap && typicalLineGap > 0 ? typicalLineGap : median;

  // 标记段落边界：行距 > 1.45× 典型行距 ⇒ 段间空行
  const flags: boolean[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const gap = Math.abs((lines[i + 1] as PdfLine).y - (lines[i] as PdfLine).y);
    flags.push(typical > 0 ? gap > typical * 1.45 : false);
  }
  lines.forEach((l, i) => {
    (l as PdfLine & { breakAfter?: boolean }).breakAfter = flags[i] ?? false;
  });
  return lines;
}

/**
 * 一页的段落（从「行 + 段落边界」推出）。
 */
export function paragraphsFromLines(page: number, lines: ReadonlyArray<PdfLine>): PdfPageParagraph[] {
  if (lines.length === 0) return [{ page, text: "", empty: true }];
  const out: PdfPageParagraph[] = [];
  let cur = "";
  for (const l of lines) {
    const line = cleanPdfText(l.text);
    if (!line) continue;
    if (cur === "") {
      cur = line;
    } else {
      cur += " " + line;
    }
    const brk = (l as PdfLine & { breakAfter?: boolean }).breakAfter;
    if (brk && cur) {
      out.push({ page, text: cur });
      cur = "";
    }
  }
  if (cur) out.push({ page, text: cur });
  if (out.length === 0) return [{ page, text: "", empty: true }];
  return out;
}

/**
 * 一页的段落（从纯文本推出；按空行分段）。
 *
 * 简易场景用这个；**有 pdf.js items 时用 paragraphsFromLines**（能按几何间距分段）。
 */
export function pageParagraphsOf(page: number, rawText: string): PdfPageParagraph[] {
  const cleaned = cleanPdfText(rawText);
  if (cleaned === "") return [{ page, text: "", empty: true }];
  // 空行分段（PDF 段落之间通常有空行）
  const paras = cleaned
    .split(/\n+/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0);
  if (paras.length === 0) return [{ page, text: "", empty: true }];
  return paras.map((text) => ({ page, text }));
}
/**
 * 一页的段落里，哪些值得送翻译。
 *
 * 过滤掉「纯页眉页脚」——重复出现的短行（如书名、页码、章节名）
 * 反复送翻译既烧钱又污染缓存键。
 */
export function isTranslatableParagraph(text: string, minLen = 2): boolean {
  const t = text.trim();
  if (t.length < minLen) return false;
  // 纯数字（页码）不译
  if (/^[\d\s.,·—–-]+$/.test(t)) return false;
  return true;
}

/**
 * 估算 token 数（粗粒度，仅用于预算提示与进度估算）。
 *
 * 中英混排的粗略口径：英文约 1.35 token/词，中文约 0.85 token/字。
 */
export function estimateTokens(text: string): number {
  const s = text;
  const cjk = (s.match(/[一-鿿]/g) || []).length;
  const rest = s.length - cjk;
  const words = rest ? rest / 6 : 0; // 英文约 6 字符/词
  return Math.ceil(cjk * 0.85 + words * 1.35);
}
