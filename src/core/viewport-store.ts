/**
 * 视口状态 Svelte store（2026-10-24 移动端适配 · responsive.ts 接线）
 * ------------------------------------------------------------------
 * 把 core/responsive.ts 的 watchViewport 包成 Svelte readable store，
 * 组件用 `$viewport.breakpoint` / `$viewport.keyboardOpen` 响应式取值。
 *
 * 与 env.ts / responsive.ts 的分工（见各文件头注释）：
 *  - env.ts         → "是什么设备"（isMobile / deviceClass），决定交互模式
 *  - responsive.ts  → "现在视口多大"（纯函数查询）
 *  - viewport-store → responsive.ts 的**响应式**包装，供 Svelte 模板订阅
 *
 * 用法：
 * ```svelte
 * import { viewport } from "../core/viewport-store.ts";
 * <div class:re-phone={$viewport.breakpoint === "phone"}>
 * ```
 */

import { readable } from "svelte/store";
import { watchViewport, viewportWidth, viewportHeight, isSoftKeyboardOpen, BREAKPOINTS } from "./responsive.ts";

export type ViewportBreakpoint = "phone" | "largePhone" | "tablet" | "desktop";

export interface ViewportState {
  width: number;
  height: number;
  /** 软键盘是否弹起（仅移动端有意义） */
  keyboardOpen: boolean;
  breakpoint: ViewportBreakpoint;
}

function classify(w: number): ViewportBreakpoint {
  if (w <= BREAKPOINTS.phone) return "phone";
  if (w <= BREAKPOINTS.largePhone) return "largePhone";
  if (w <= BREAKPOINTS.tablet) return "tablet";
  return "desktop";
}

/** 同步算一次初值：watchViewport 的首次 fire 走 rAF，直接用初值可避免首帧闪断 */
function initialViewportState(): ViewportState {
  const w = viewportWidth();
  const h = viewportHeight();
  return { width: w, height: h, keyboardOpen: isSoftKeyboardOpen(), breakpoint: classify(w) };
}

/**
 * 全局视口状态（模块级单例；watchViewport 只挂一份监听）。
 * 断点：phone ≤480 < largePhone ≤600 < tablet ≤768 ≤ desktop（同 responsive.ts BREAKPOINTS）。
 */
export const viewport = readable<ViewportState>(initialViewportState(), (set) => {
  return watchViewport({
    onResize: (info) => {
      set({ width: info.width, height: info.height, keyboardOpen: info.keyboardOpen, breakpoint: classify(info.width) });
    },
  });
});

/** 是否手机级窄视口（phone / largePhone，≤600px）。顶栏 ⋯ 溢出菜单等紧凑布局的开关。 */
export function isPhoneBreakpoint(bp: ViewportBreakpoint): boolean {
  return bp === "phone" || bp === "largePhone";
}
