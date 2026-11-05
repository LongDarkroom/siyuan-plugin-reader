/**
 * 自绘 Tooltip 的纯逻辑（2026-11-05）
 * ----------------------------------------------------------------
 * 原生 `title` 的延迟由系统决定（约 1s）、样式跟 OS 走、触屏上还会黏住不消失；
 * 阅读器浮层（划词工具栏 / 批注卡 / 词典）统一改用 `data-tip` + 单层绘制。
 *
 * 这里只放可测的落点计算与时长常量，事件接线在 ReaderView.svelte。
 * 坐标系 = `.reader-floating-layer`（即 .reader-view）本地坐标。
 */

/** 悬停多久才出现：450ms 与桌面端常见 tooltip 手感一致，又不至于误触刷屏。 */
export const TIP_DELAY_MS = 450;

/** 与锚点按钮的间距。 */
export const TIP_GAP = 8;

export type TipBox = { left: number; top: number; right: number; bottom: number };
export type TipSize = { width: number; height: number };

/**
 * 计算落点：
 *  · 默认贴锚点上方 TIP_GAP；
 *  · 上方放不下且下方放得下 → 翻到下方；
 *  · 上下都不够 → 选空间更大的一侧，并夹进容器（宁可贴边也不出界）；
 *  · 水平方向居中于锚点，再左右夹紧。
 */
export function placeTip(
  anchor: TipBox,
  size: TipSize,
  bounds: TipBox,
  gap = TIP_GAP,
): { left: number; top: number; below: boolean } {
  const aboveTop = anchor.top - gap - size.height;
  const belowTop = anchor.bottom + gap;
  const fitsAbove = aboveTop >= bounds.top;
  const fitsBelow = belowTop + size.height <= bounds.bottom;

  let below = false;
  let top: number;
  if (fitsAbove) {
    top = aboveTop;
  } else if (fitsBelow) {
    below = true;
    top = belowTop;
  } else {
    below = bounds.bottom - anchor.bottom > anchor.top - bounds.top;
    top = below ? belowTop : aboveTop;
  }
  top = Math.max(bounds.top, Math.min(top, bounds.bottom - size.height));

  const center = (anchor.left + anchor.right) / 2;
  const left = Math.max(bounds.left, Math.min(center - size.width / 2, bounds.right - size.width));

  return { left, top, below };
}
