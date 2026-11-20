/**
 * 自动版式（2026-11-20）
 * ----------------------------------------------------------------
 * 按「书籍语言 + 屏幕尺寸 + 字号」推导一套阅读排版值：
 * 每列宽 / 栏数 / 行距 / 段距 / 首行缩进 / 字距 / 词距 / 上下边距。
 *
 * 设计边界：
 *  · 纯函数，不碰 DOM / store / Svelte —— 可直接单测；
 *  · 只产出**派生值**，是否落盘由调用方决定（阅读器自动模式下刻意不落盘，
 *    换书 / 拉窗口 / 改字号都重算，不会把手动设置洗掉）；
 *  · 页宽按「每行目标字数 × 字号」反推，而不是屏幕百分比 ——
 *    这样改字号不会破坏一行该有的字数。
 *
 * 为什么不控制字距 / 词距的值：这两项自动调最伤观感
 * （西文负字距会粘连、两端对齐会长出空洞），自动模式固定收敛到 0。
 */

import type { ReaderSettings } from "./reader-settings.ts";

export type AutoTypographyScript = "cjk" | "latin";

/** 分页器判定「一列舒适宽」的基准值（vendor/foliate-js/paginator.js --max-inline-size 默认 720） */
export const FOLIATE_COMFORT_COLUMN_PX = 720;

export interface AutoTypographyInput {
  /** EPUB OPF dc:language（如 "zh-CN" / "en-US"） */
  language?: string | null;
  /** dc:language 缺失时的正文采样（用于按 CJK 占比兜底） */
  sampleText?: string | null;
  /** 采样也没有时按界面语言兜底 */
  fallbackScript?: AutoTypographyScript;
  /** 阅读区可用宽高（CSS px，不含思源外框） */
  viewportWidth: number;
  viewportHeight: number;
  /** 当前正文字号（px） */
  fontSize: number;
  /** 设备档（phone / largePhone / tablet / desktop），仅用于收紧手机端参数 */
  deviceClass?: string | null;
  /** 分页 / 滚动；滚动模式没有并排多栏，栏数固定 1 */
  flow?: "paginated" | "scrolled";
}

export interface AutoTypography {
  script: AutoTypographyScript;
  /** 目标每行字数（中文按字、西文按字符） */
  targetChars: number;
  /** 按当前字号估算的实际每行字数（多栏扣掉栏间距） */
  estimatedCharsPerLine: number;
  /** 每列宽（px） */
  columnWidthPx: number;
  /** 实际生效栏数（受分页器 720px 基准约束） */
  columnCount: number;
  /** 写给 --_max-column-count 的上限 */
  maxColumnCount: number;
  lineHeight: number;
  paragraphSpacing: number;
  /** em */
  textIndent: number;
  /** em */
  letterSpacing: number;
  /** em */
  wordSpacing: number;
  marginTopPx: number;
  marginBottomPx: number;
  /** 左右边距（px，写进分页器 --_margin-left/right） */
  marginSidePx: number;
}

const CJK_TARGET_CHARS = 38;
const LATIN_TARGET_CHARS = 66;
/** 拉丁字母平均步进（Georgia 等衬线体约 0.5em，留一点余量） */
const LATIN_AVG_EM = 0.52;

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function roundTo(n: number, step: number): number {
  return Math.round(n / step) * step;
}

/**
 * 判定排版语种：dc:language 优先，其次正文采样 CJK 占比，最后界面语言兜底。
 * 只分「中日韩」与「拉丁」两档 —— 法/德/西等拉丁语系的排版规则同样适用。
 */
export function resolveTypographyScript(input: {
  language?: string | null;
  sampleText?: string | null;
  fallbackScript?: AutoTypographyScript;
}): AutoTypographyScript {
  const lang = String(input.language ?? "").trim().toLowerCase();
  if (/^(zh|ja|ko|yue|cmn|wuu)/.test(lang)) return "cjk";
  if (/^[a-z]{2,3}([-_]|$)/.test(lang)) return "latin";

  const sample = String(input.sampleText ?? "").slice(0, 4000);
  let cjk = 0;
  let latin = 0;
  for (const ch of sample) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjk++;
    } else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
      latin++;
    }
  }
  if (cjk + latin === 0) return input.fallbackScript === "latin" ? "latin" : "cjk";
  return cjk / (cjk + latin) >= 0.2 ? "cjk" : "latin";
}

export function computeAutoTypography(input: AutoTypographyInput): AutoTypography {
  const vw = clamp(input.viewportWidth, 240, 10000);
  const vh = clamp(input.viewportHeight, 240, 10000);
  const fontSize = clamp(input.fontSize, 9, 72);
  const phone =
    input.deviceClass === "phone" ||
    input.deviceClass === "largePhone" ||
    vw < 560;
  const large = !phone && (vh >= 1000 || vw >= 1400);

  const script = resolveTypographyScript(input);
  const cjk = script === "cjk";
  const avgEm = cjk ? 1 : LATIN_AVG_EM;
  const targetChars = cjk
    ? phone
      ? 34
      : CJK_TARGET_CHARS
    : phone
      ? 55
      : LATIN_TARGET_CHARS;

  // 每列宽 = 目标字数 × 平均字宽；手机端再压到视口内，避免列宽大于屏幕
  let columnWidthPx = roundTo(targetChars * avgEm * fontSize, 4);
  columnWidthPx = clamp(columnWidthPx, phone ? 240 : 420, 900);
  if (phone) columnWidthPx = Math.min(columnWidthPx, Math.max(240, vw - 32));

  // 栏数：按「目标列宽 + 栏间距」判断放得下几栏；
  // 分页器的实际栏数还会被 ceil(视口宽 / 720) 截断，这里同步算出来，
  // 否则摘要会写「2 栏」而画面只有 1 栏。
  let desiredCols = 1;
  if (!phone) {
    if (vw >= columnWidthPx * 2 + 48) desiredCols = 2;
    if (vw >= columnWidthPx * 3 + 96) desiredCols = 3;
  }
  if (input.flow === "scrolled") desiredCols = 1;
  const foliateCols = Math.max(1, Math.ceil(vw / FOLIATE_COMFORT_COLUMN_PX));
  const columnCount = Math.max(1, Math.min(desiredCols, foliateCols));

  // 多栏时标题/正文之间还有 7% 栏间距，估算每行字数时扣掉
  const perColumnPx = columnCount > 1 ? columnWidthPx * 0.93 : columnWidthPx;
  const estimatedCharsPerLine = Math.max(8, Math.round(perColumnPx / (avgEm * fontSize)));

  const lineHeight = cjk
    ? roundTo(phone ? 1.7 : large ? 1.8 : 1.75, 0.05)
    : roundTo(phone ? 1.55 : large ? 1.65 : 1.6, 0.05);
  const paragraphSpacing = cjk ? (phone ? 0.2 : 0.3) : phone ? 0.7 : 0.8;

  const marginSidePx = Math.round(clamp(vw * 0.04, phone ? 12 : 16, 64));
  const marginTopPx = Math.round(clamp(vh * 0.03, 16, 40));
  const marginBottomPx = Math.round(
    clamp(vh * 0.045, marginTopPx + 12, 56),
  );

  return {
    script,
    targetChars,
    estimatedCharsPerLine,
    columnWidthPx: Math.round(columnWidthPx),
    columnCount,
    maxColumnCount: desiredCols,
    lineHeight,
    paragraphSpacing,
    textIndent: cjk ? 2 : 0,
    letterSpacing: 0,
    wordSpacing: 0,
    marginTopPx,
    marginBottomPx,
    marginSidePx,
  };
}

/**
 * 把派生版式合并成一份**临时设置**（供样式生成与分页器几何使用）。
 * 不写回 store；调用方若要做「转为手动」，再自行落盘这份结果。
 *
 * 自动版式天然意味着接管原书排版（否则段距/缩进会被 overrideBookLayout=false 忽略），
 * 因此这里强制 overrideBookLayout=true —— 与 UI 上隐藏该开关保持一致。
 */
export function applyAutoTypographyToSettings(
  settings: ReaderSettings,
  auto: AutoTypography,
): ReaderSettings {
  return {
    ...settings,
    lineHeight: auto.lineHeight,
    overrideBookLayout: true,
    paragraph: {
      ...settings.paragraph,
      paragraphSpacing: auto.paragraphSpacing,
      textIndent: auto.textIndent,
    },
    text: {
      ...settings.text,
      letterSpacing: auto.letterSpacing,
      wordSpacing: auto.wordSpacing,
    },
    layout: {
      ...settings.layout,
      widthMode: "fixed",
      fixedWidthPx: auto.columnWidthPx,
      maxColumnCount: Math.max(1, Math.min(4, auto.maxColumnCount)),
      marginTopPx: auto.marginTopPx,
      marginBottomPx: auto.marginBottomPx,
      marginLeftPx: auto.marginSidePx,
      marginRightPx: auto.marginSidePx,
      followSiyuanMargin: false,
    },
  };
}