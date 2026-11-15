/**
 * AI 阅读助手 · 承载决策（2026-11-15 移动端全量走通 P0）
 * ------------------------------------------------------------------
 * 背景（真实断档）：
 *  - 桌面端 AI 助手放在思源右侧停靠栏（AiDockController）或原生页签（AiTabController）；
 *  - 思源**移动端没有右侧停靠栏**，且两个控制器在 `isMobile()` 时直接 return；
 *  - 旧判定只看视口宽度（phone / largePhone），平板宽度 >768 落进 desktop 档，
 *    于是平板点顶栏 ✨ 会去打开一个不存在的右栏 —— 静默无反应。
 *
 * 现在的口径：
 *  - 是否移动端由运行环境（env.ts 的 isMobile）决定，与宽度无关；
 *  - 移动端一律用阅读器内嵌面板；
 *  - 内嵌时分两档：手机档（≤600px）全屏覆盖；平板 / 宽视口移动端右侧半屏。
 *
 * 抽成纯函数是为了让「哪台设备走哪条路」可被单测钉住，
 * 避免再出现「只在某种尺寸下静默失效」的回归。
 */

/** 与 core/viewport-store.ts 的 ViewportBreakpoint 同形（此处不 import，保持零依赖可测） */
export type AiViewportBreakpoint = "phone" | "largePhone" | "tablet" | "desktop";

export interface AiEntryInput {
  /** 是否移动端运行环境（思源 App 或移动浏览器） */
  mobile: boolean;
  /** 当前视口断点 */
  breakpoint: AiViewportBreakpoint;
}

export interface AiEntryDecision {
  /** 是否使用阅读器内嵌面板；false = 交给桌面右栏 */
  overlay: boolean;
  /** 内嵌时是否全屏；false 表示右侧半屏（平板 / 宽视口移动端） */
  fullScreen: boolean;
}

/**
 * 决策表（8 种组合）：
 *
 * | 环境   | phone/largePhone | tablet | desktop |
 * |--------|------------------|--------|---------|
 * | 桌面   | 内嵌 + 全屏       | 右栏   | 右栏    |
 * | 移动端 | 内嵌 + 全屏       | 内嵌 + 半屏 | 内嵌 + 半屏 |
 *
 * 说明：桌面窄窗口（≤600px）走内嵌全屏是 2026-11-05 起的既有行为，本次保留，
 * 因为窄窗口本来就没有足够空间展开右栏；桌面宽度恢复正常即回到右栏。
 */
export function decideAiEntry(input: AiEntryInput): AiEntryDecision {
  const fullScreen = input.breakpoint === "phone" || input.breakpoint === "largePhone";
  return {
    overlay: input.mobile || fullScreen,
    fullScreen,
  };
}
