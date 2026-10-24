/**
 * 滚轮翻页手势判定（纯逻辑，无 DOM 依赖，可单测）。
 *
 * ## 为什么要单独抽一层
 * 滚轮翻页最容易出问题的不是"翻不翻"，而是**翻几次**：
 *   - 触控板一次惯性滑会连发几十个 wheel 事件 → 不做抑制就会一次滑过好几页；
 *   - 鼠标滚轮一格 = deltaY 100~120px，阈值太小则一格翻两页；
 *   - 慢速拖动几秒钟才累计够阈值 → 用户以为没反应。
 * 这些都是**纯数值判定**，与 foliate / DOM 无关 ⇒ 抽成纯函数，用单测钉死，
 * 视图层只负责"把 wheel 事件喂进来 + 按返回值翻页"。
 *
 * ## 参数取值参考 Readest 0.12.12
 *   apps/readest-app/src/app/reader/utils/wheelGesture.ts
 *     DEFAULT_THRESHOLD = 30        触发阈值（px）
 *     DEFAULT_IDLE_RESET_MS = 200   空闲复位窗口（ms）
 *     DEFAULT_LINE_HEIGHT = 40      deltaMode=1（行）折算用
 *     DEFAULT_PAGE_HEIGHT = 800     deltaMode=2（页）折算用
 * Readest 另有 `suppress(timeStamp)` 吞惯性尾巴，本实现合并进"抑制窗口"。
 *
 * ⚠️ 不要照抄 CSS scroll-snap：Readest 自己也没有用 scroll-snap，
 *    我们同样不用（分页模式的翻页由 foliate 的 #scrollToPage 负责）。
 */

/** 翻页方向：prev=往回，next=往前（逻辑方向，与书写方向无关） */
export type WheelDirection = "prev" | "next";

export interface WheelSample {
  /** 横向滚动量 */
  deltaX: number;
  /** 纵向滚动量 */
  deltaY: number;
  /** 事件时间戳（ms） */
  timeStamp: number;
  /** WheelEvent.deltaMode：0=像素 1=行 2=页 */
  deltaMode?: number;
}

export interface WheelGestureOptions {
  /** 累计多少 px 才翻一页 */
  threshold?: number;
  /** 超过这个空闲时长就清零累计（ms） */
  idleResetMs?: number;
  /** deltaMode=1 时的行高折算基准 */
  lineHeight?: number;
  /** deltaMode=2 时的页高折算基准 */
  pageHeight?: number;
  /** 翻页后的抑制窗口（ms）：吞掉惯性尾巴，避免一次滑动连翻多页 */
  suppressMs?: number;
}

export interface WheelGestureDetector {
  /** 喂入一个 wheel 采样；返回翻页方向，或 null（本次不翻） */
  feed(sample: WheelSample): WheelDirection | null;
  /** 清空累计（切书 / 换模式 / 失焦时调用） */
  reset(): void;
  /** 当前是否处于抑制窗口（翻页后吞惯性尾巴） */
  isSuppressed(timeStamp: number): boolean;
}

export const DEFAULT_WHEEL_THRESHOLD = 30;
export const DEFAULT_WHEEL_IDLE_RESET_MS = 200;
export const DEFAULT_WHEEL_LINE_HEIGHT = 40;
export const DEFAULT_WHEEL_PAGE_HEIGHT = 800;
export const DEFAULT_WHEEL_SUPPRESS_MS = 180;

/** deltaMode 归一化：统一折算成"像素"再比较阈值。 */
export function normalizeWheelDelta(
  delta: number,
  mode: number | undefined,
  lineHeight: number,
  pageHeight: number
): number {
  if (mode === 1) return delta * lineHeight;
  if (mode === 2) return delta * pageHeight;
  return delta;
}

export function createWheelGestureDetector(options: WheelGestureOptions = {}): WheelGestureDetector {
  const threshold = options.threshold ?? DEFAULT_WHEEL_THRESHOLD;
  const idleResetMs = options.idleResetMs ?? DEFAULT_WHEEL_IDLE_RESET_MS;
  const lineHeight = options.lineHeight ?? DEFAULT_WHEEL_LINE_HEIGHT;
  const pageHeight = options.pageHeight ?? DEFAULT_WHEEL_PAGE_HEIGHT;
  const suppressMs = options.suppressMs ?? DEFAULT_WHEEL_SUPPRESS_MS;

  let acc = 0;
  let lastTs = Number.NEGATIVE_INFINITY;
  let firedAt = Number.NEGATIVE_INFINITY;
  let lastDir: WheelDirection = "next";

  const reset = () => {
    acc = 0;
  };

  return {
    feed(sample: WheelSample): WheelDirection | null {
      const now = sample.timeStamp;
      // ① 抑制窗口：刚翻过页 ⇒ 这一小段时间内的滚轮只吞掉不触发。
      //    这是"一次惯性滑连翻好几页"的主要防线。
      if (now - firedAt < suppressMs) return null;
      // ② 空闲复位：超过 idleResetMs 没有新事件 ⇒ 之前的累计作废
      //    （否则慢慢拖 5 秒才翻一页，手感像失灵）。
      if (now - lastTs > idleResetMs) acc = 0;
      lastTs = now;

      const dy = normalizeWheelDelta(sample.deltaY, sample.deltaMode, lineHeight, pageHeight);
      const dx = normalizeWheelDelta(sample.deltaX, sample.deltaMode, lineHeight, pageHeight);
      // ③ 主轴判定：横向分量占优 ⇒ 不是翻页意图（触控板横滑 / 横向滚动）
      if (Math.abs(dx) > Math.abs(dy)) {
        acc = 0;
        return null;
      }
      if (dy === 0) return null;

      lastDir = dy > 0 ? "next" : "prev";
      acc += dy;
      if (Math.abs(acc) < threshold) return null;

      // ④ 达标 ⇒ 翻一页，并清零累计（下一页要重新攒够阈值）
      acc = 0;
      firedAt = now;
      return lastDir;
    },
    reset,
    isSuppressed(timeStamp: number): boolean {
      return timeStamp - firedAt < suppressMs;
    },
  };
}
