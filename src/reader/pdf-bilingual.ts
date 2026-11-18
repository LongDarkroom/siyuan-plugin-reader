/**
 * 双语对照 PDF 生成（2026-11-17）
 * ==================================================================
 *
 * 形态：**横向页 = 原页宽 × 2**，左半是原页面（矢量搬移，可搜索、可复制），
 * 右半是中文译文（真实文本，不是图片）。
 *
 * 为什么这么排：
 *  - 原页搬移用 pdf-lib 的 `copyPages` + `embedPage` ⇒ 矢量保真、可搜索，
 *    不像「整页渲染成图」那样把文字变成像素（文件暴涨、搜不了）；
 *  - 译文用嵌入字体写字 ⇒ 中文可搜索、可复制；
 *  - 左右并排 ⇒ 视线不用来回翻页（交替排「原文页 / 译文页」要翻两次）。
 *
 * ⚠️ 字体是本模块最大的坑（2026-11-17 实测）：
 *  - pdf-lib 对 **CFF 轮廓**的字体（CFF2/OTF）会嵌成 CIDFontType0，
 *    **Chrome 画不出来**（文本能提取，但页面空白）；
 *  - pdf-lib 也**不能 subset woff2**（fontkit 报 `glyph._decode is not a function`）；
 *  ⇒ 运行时必须用 TrueType(glyf) 的 .ttf（见 scripts/build_pdf_font.py）。
 *
 * 本模块的排版计算（换行 / 分页 / 字号）是纯函数，node 里直接断言；
 * 真正调 pdf-lib 的部分在 `pdf-bilingual-runtime.ts`。
 */

/** 一页的译文（按原文段落对应） */
export interface TranslatedPage {
  /** 1-based 页码 */
  page: number;
  /** 该页的译文（可为空 —— 纯图片页没得译） */
  translation: string;
}

/** 排版参数 */
export interface BilingualLayout {
  /** 译文栏页边距（pt） */
  margin: number;
  /** 正文字号（pt） */
  fontSize: number;
  /** 行距倍数 */
  lineHeight: number;
  /** 译文栏的标题（如「第 12 页」） */
  showPageHeader: boolean;
}

export const DEFAULT_LAYOUT: BilingualLayout = {
  margin: 36,
  fontSize: 10.5,
  lineHeight: 1.75,
  showPageHeader: true,
};

/**
 * 按宽度给 CJK 文本断行。
 *
 * 中文可以**任意位置断行**（除标点不能行首外），英文则要按词断。
 * 这里做混合处理：英文单词整体不拆，CJK 逐字可断。
 *
 * @param text  待断行的文本
 * @param maxWidth 每行最大宽度（pt）
 * @param fontSize 字号（用于估算字符宽度）
 */
export function wrapText(text: string, maxWidth: number, fontSize: number): string[] {
  if (!text) return [];
  // CJK 字符按 1 em 宽，ASCII 按 0.5 em 宽（宋体/黑体的经验值）
  const charWidth = (ch: string): number => {
    const cp = ch.codePointAt(0) ?? 0;
    const wide =
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x3000 && cp <= 0x303f) ||
      (cp >= 0xff00 && cp <= 0xffef);
    return wide ? fontSize : fontSize * 0.5;
  };

  const lines: string[] = [];
  let line = "";
  let lineWidth = 0;
  // 英文单词缓冲：遇到 ASCII 字母/数字先攒着，作为整体断行单位
  let word = "";

  const flushWord = (): void => {
    if (!word) return;
    const w = charWidth(word[0] as string) * word.length;
    if (lineWidth + w > maxWidth && line !== "") {
      lines.push(line.trimEnd());
      line = "";
      lineWidth = 0;
    }
    line += word;
    lineWidth += w;
    word = "";
  };

  for (const ch of text) {
    if (/[A-Za-z0-9'’\-]/.test(ch)) {
      word += ch;
      continue;
    }
    flushWord();
    const w = charWidth(ch);
    if (lineWidth + w > maxWidth && line !== "") {
      lines.push(line.trimEnd());
      line = "";
      lineWidth = 0;
    }
    line += ch;
    lineWidth += w;
  }
  flushWord();
  if (line.trim()) lines.push(line.trimEnd());
  return lines;
}

/**
 * 中文排版的**避头尾**处理：标点不能出现在行首。
 * （「，」「。」「）」等若被断到行首，视觉上很糟）
 */
export function applyKinsoku(lines: ReadonlyArray<string>): string[] {
  const NO_LINE_START = "，。！？；：、）】」』》…％%";
  const out = [...lines];
  for (let i = 1; i < out.length; i++) {
    const line = out[i] as string;
    if (!line) continue;
    const first = line[0] as string;
    if (!NO_LINE_START.includes(first)) continue;
    // 把这个标点挪到上一行末尾
    const prev = out[i - 1] as string;
    if (prev.endsWith(" ")) {
      out[i - 1] = `${prev.trimEnd()}${first}`;
      out[i] = line.slice(1);
    } else {
      out[i - 1] = `${prev}${first}`;
      out[i] = line.slice(1);
    }
  }
  return out;
}

/**
 * 把译文排进右栏，算出每一行的 y 坐标。
 *
 * @param translation 该页译文
 * @param colWidth   右栏宽度（pt）
 * @param pageHeight 页高（pt）
 * @param layout     排版参数
 * @returns 行文本 + 每行的 y（PDF 坐标，向上为正）；溢出时返回 null（该页放不下）
 */
export function layoutTranslation(
  translation: string,
  colWidth: number,
  pageHeight: number,
  layout: BilingualLayout = DEFAULT_LAYOUT,
): Array<{ text: string; y: number }> | null {
  const usableWidth = colWidth - layout.margin * 2;
  if (usableWidth <= 0) return null;
  const raw = wrapText(translation, usableWidth, layout.fontSize);
  const lines = applyKinsoku(raw);
  const lineH = layout.fontSize * layout.lineHeight;

  const headerH = layout.showPageHeader ? layout.fontSize * 2 : 0;
  const capacity = Math.floor((pageHeight - layout.margin * 2 - headerH) / lineH);
  if (lines.length > capacity) return null; // 放不下 → 走「另起一页」策略

  const out: Array<{ text: string; y: number }> = [];
  let y = pageHeight - layout.margin - headerH;
  for (const ln of lines) {
    out.push({ text: ln, y });
    y -= lineH;
  }
  return out;
}

/**
 * 译文放不下时的**分页策略**：把译文切成若干「续页」。
 *
 * @param translation 该页译文
 * @param colWidth   右栏宽度
 * @param pageHeight 页高
 * @param layout     排版参数
 * @returns 每页的行数组（长度 ≥1 表示需要一页）
 */
export function splitTranslationIntoPages(
  translation: string,
  colWidth: number,
  pageHeight: number,
  layout: BilingualLayout = DEFAULT_LAYOUT,
): Array<Array<{ text: string; y: number }>> {
  const usableWidth = colWidth - layout.margin * 2;
  if (usableWidth <= 0) return [];
  const lineH = layout.fontSize * layout.lineHeight;
  const headerH = layout.showPageHeader ? layout.fontSize * 2 : 0;
  const capacity = Math.max(1, Math.floor((pageHeight - layout.margin * 2 - headerH) / lineH));

  const lines = applyKinsoku(wrapText(translation, usableWidth, layout.fontSize));
  const pages: Array<Array<{ text: string; y: number }>> = [];
  for (let i = 0; i < lines.length; i += capacity) {
    const chunk = lines.slice(i, i + capacity);
    const out: Array<{ text: string; y: number }> = [];
    let y = pageHeight - layout.margin - headerH;
    for (const ln of chunk) {
      out.push({ text: ln, y });
      y -= lineH;
    }
    pages.push(out);
  }
  return pages.length > 0 ? pages : [[]];
}

/**
 * 双语页的尺寸：原页宽 × 2。
 *
 * @param originalWidth 原页宽（pt）
 * @param originalHeight 原页高（pt）
 */
export function bilingualPageSize(
  originalWidth: number,
  originalHeight: number,
): { width: number; height: number } {
  return { width: originalWidth * 2, height: originalHeight };
}

/**
 * 右栏（译文栏）的几何。
 */
export function translationColumn(
  originalWidth: number,
  originalHeight: number,
  layout: BilingualLayout = DEFAULT_LAYOUT,
): { x: number; y: number; width: number; height: number } {
  return {
    x: originalWidth,
    y: 0,
    width: originalWidth,
    height: originalHeight,
  };
}
