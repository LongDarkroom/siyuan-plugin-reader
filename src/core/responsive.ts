/**
 * 响应式布局工具（2026-08-29 移动端适配 Phase 5）
 * ------------------------------------------------------------------
 * 提供"屏幕尺寸 / 软键盘状态 / 设备能力"三类查询。
 * 全插件判断"在移动端 / 小屏 / 软键盘弹起"等都应走本文件，
 * 避免散落写 `window.innerWidth < 600` 这种 magic number。
 *
 * 与 env.ts 的关系：
 *  - env.ts 关心"是什么设备"（iPhone / iPad / Android / Desktop）
 *  - responsive.ts 关心"现在能用的视口是多少"（屏幕、视口、软键盘）
 * 两者正交，env 决定交互模式，responsive 决定 UI 尺寸。
 */

/**
 * 屏幕断点（与 SiYuan B3 设计 token 对齐）
 *
 * ⚠️ 这是**唯一真源**：CSS 里不要再写 `@media (max-width: 612px)` 这种魔法数。
 * 宽度类媒体查询一律改走下面两种形态之一：
 *   1. 阅读器 / 书架子树内 → 根节点的 `.re-*` 状态类（re-phone / re-large-phone /
 *      re-tablet / re-narrow / re-tiny）；
 *   2. portal 到 body 的二级面板 → 本文件 `applyViewportTiers()` 写在
 *      `<body>` 上的 `.re-w380 … .re-w768` 档位类（见 WIDTH_TIERS）。
 * 只有**设备能力**类查询（pointer / hover / prefers-*）继续留在 CSS 里。
 */
export const BREAKPOINTS = {
  /** 超小屏（折叠机半屏 / 旧 SE 竖屏） */
  tinyPhone: 380,
  /** 窄屏手机（iPhone SE 一代 / 小屏安卓） */
  narrowPhone: 420,
  /** 小屏手机（portrait） */
  phone: 480,
  /** 大屏手机 / 小平板（portrait iPad mini） */
  largePhone: 600,
  /** 二级弹窗改底部抽屉的宽度（设置 / AI 设置） */
  dialogDrawer: 720,
  /** 平板 / 桌面（横屏 iPad） */
  tablet: 768,
  /** 桌面 */
  desktop: 1024,
} as const;

export type BreakpointKey = keyof typeof BREAKPOINTS;

/**
 * 需要投射成 `<body>` 档位类的宽度档（升序）。
 * 语义是 `max-width`：视口 500px 时 body 同时带 `re-w380 re-w420 re-w480 re-w600`…… 里
 * 所有 ≥500 的档**不**带 —— 即 `.re-w600` 命中表示「视口 ≤600」，与 `@media (max-width:600px)` 等价。
 */
export const WIDTH_TIERS = [
  BREAKPOINTS.tinyPhone,
  BREAKPOINTS.narrowPhone,
  BREAKPOINTS.phone,
  BREAKPOINTS.largePhone,
  BREAKPOINTS.dialogDrawer,
  BREAKPOINTS.tablet,
] as const;

/**
 * 当前**布局视口**宽度 —— 断点判定的唯一依据。
 *
 * 🔴 为什么不能用 visualViewport：iPad 分屏 / 转屏瞬间 `visualViewport.width` 会短暂
 * 等于分屏后的窄宽，而 CSS 的 `@media (max-width:480px)` 判的是**布局视口**。
 * 两边不同源 ⇒ 转屏那一刻 JS 挂的 `re-phone` 和 CSS 的 `@media` 会打架（半帧手机样式、
 * 半帧桌面样式）。visualViewport 只用于「软键盘占高」和「浮层定位」。
 */
export function layoutWidth(): number {
  if (typeof window === "undefined") return BREAKPOINTS.desktop;
  return window.innerWidth || document.documentElement?.clientWidth || BREAKPOINTS.desktop;
}

/** 当前**布局视口**高度（不受软键盘影响） */
export function layoutHeight(): number {
  if (typeof window === "undefined") return BREAKPOINTS.tablet;
  return window.innerHeight || document.documentElement?.clientHeight || BREAKPOINTS.tablet;
}

/** 当前**可视视口**宽度（软键盘弹出 / 双指缩放时会缩；浮层定位用） */
export function visualWidth(): number {
  if (typeof window === "undefined") return BREAKPOINTS.desktop;
  const vv = (window as any).visualViewport;
  if (vv && typeof vv.width === "number" && vv.width > 0) return vv.width;
  return layoutWidth();
}

/** 当前**可视视口**高度（软键盘弹出时会缩；浮层尺寸 / 键盘检测用） */
export function visualHeight(): number {
  if (typeof window === "undefined") return BREAKPOINTS.tablet;
  const vv = (window as any).visualViewport;
  if (vv && typeof vv.height === "number" && vv.height > 0) return vv.height;
  return layoutHeight();
}

/**
 * 视口宽度 —— **断点语义**（= layoutWidth()）。
 *
 * 2026-11-19 P2-1：历史上这里优先取 `visualViewport.width`，与 CSS 断点不同源。
 * 现在固定为布局视口；需要可视视口的场景请显式用 `visualWidth()`。
 */
export function viewportWidth(): number {
  return layoutWidth();
}

/** 视口高度 —— **可视视口**语义（软键盘弹起后会变小，弹窗尺寸用它才不会被键盘顶出屏） */
export function viewportHeight(): number {
  return visualHeight();
}

/**
 * 把宽度档位类写到 `<body>` 上（`re-w380` … `re-w768`，语义同 `max-width`）。
 *
 * 为什么需要：四个二级面板（阅读统计 / OPDS / 云端书库 / 图谱）与书架右键菜单都用
 * `use:portal` 挂到 `document.body`，**不在阅读器 / 书架子树里**，拿不到 `.re-phone`；
 * 它们原先各自写 `@media (max-width:600px)`。现在统一由这里投影，CSS 侧只认类，
 * 全项目的宽度断点回到 `BREAKPOINTS` 一个真源。
 */
export function applyViewportTiers(w: number = layoutWidth()): void {
  if (typeof document === "undefined" || !document.body) return;
  const cl = document.body.classList;
  for (const t of WIDTH_TIERS) {
    const name = `re-w${t}`;
    if (w <= t) cl.add(name);
    else cl.remove(name);
  }
}

/**
 * 「算作键盘弹起」的最小压缩量（px）。
 * 原值 150 是为了避开 iOS 地址栏收起（~60px）与横屏工具栏，但会漏掉
 * **浮动 / 半屏键盘**（压缩 100–140px）⇒ 2026-11-19 降到 120。
 */
const KEYBOARD_MIN_SHRINK = 120;

/** 当前是否为粗指针（触屏）。只用于「没有任何尺寸信号时」的键盘兜底判定。 */
function isCoarsePointer(): boolean {
  try {
    return window.matchMedia?.("(pointer: coarse)")?.matches === true;
  } catch {
    return false;
  }
}

/** 焦点是否在可编辑元素上（input / textarea / contenteditable，含思源 Protyle） */
function isEditableFocused(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  if (el.isContentEditable) return true;
  return !!el.closest?.("[contenteditable='true'], .protyle-wysiwyg");
}

/**
 * 软键盘占掉的高度（px；未弹起 / 桌面 = 0）。
 *
 * 🔴 为什么需要这个数：**移动端软键盘只压缩 visualViewport，布局视口不变**。
 * 所以 `position:absolute; bottom:0` 的元素（AI 输入框、批注编辑器、TTS 条…）
 * 会停在键盘**下面**，用户既看不见也点不到。拿到了这个值，把它们改成
 * `bottom: var(--re-kb, 0px)` 就自然让开了 —— 见 ReaderView 的 `--re-kb`。
 *
 * 布局视口也一起缩的 WebView 里相减接近 0，此时返回 0 是**正确**的
 * （那些环境里 absolute 元素本来就跟着缩，无需再让）。
 */
export function keyboardInset(): number {
  if (typeof window === "undefined") return 0;
  const vv = (window as any).visualViewport;
  if (!vv || typeof vv.height !== "number" || vv.height <= 0) return 0;
  const shrunk = window.innerHeight - vv.height;
  return shrunk > KEYBOARD_MIN_SHRINK ? Math.round(shrunk) : 0;
}

/**
 * 软键盘是否弹起（仅在移动端 + 视口高度被压 / 焦点在可编辑元素上时为 true）。
 * 注意：与 `keyboardInset() > 0` **不总是等价** —— 后者可能因布局视口同步缩小而返回 0。
 */
export function isSoftKeyboardOpen(): boolean {
  if (typeof window === "undefined") return false;
  if (keyboardInset() > 0) return true;
  // 兜底：部分 WebView（iOS 15 起 / 安卓 WebView）会把布局视口一起缩，
  // 上面的相减拿不到信号。此时用「触屏 + 焦点在可编辑元素」判定。
  return isCoarsePointer() && isEditableFocused();
}

/** 断点判定（粗粒度；与 deviceClass 不完全等价） */
export function isPhoneSize(): boolean {
  return viewportWidth() <= BREAKPOINTS.phone;
}
export function isLargePhoneOrSmallTablet(): boolean {
  const w = viewportWidth();
  return w > BREAKPOINTS.phone && w <= BREAKPOINTS.tablet;
}
export function isTabletOrLarger(): boolean {
  return viewportWidth() > BREAKPOINTS.tablet;
}

/**
 * 响应式宽度换算：给定"设计宽度"（桌面默认），按视口宽度折算。
 *  - phone（≤480）：designWidth * 0.92 - 16px
 *  - largePhone（≤600）：designWidth * 0.85
 *  - tablet（≤1024）：designWidth * 0.7
 *  - desktop：原样
 *
 * 用途：所有 Dialog / Popup 的 width 从固定 px 改为"在视口内可放下"。
 *  - width=720px 的设置 dialog，在 360px iPhone 上 = 360*0.92-16 = 315px
 *  - width=720px 的设置 dialog，在 768px iPad 上 = 720*0.7 = 504px（仍合理）
 *  - width=720px 的设置 dialog，在 1280px desktop 上 = 720px
 *
 * @param designWidth 桌面默认宽度（px）
 * @param min 不低于这个值（默认 280）
 * @param max 不超过 designWidth
 */
export function responsiveWidth(designWidth: number, min = 280, max?: number): number {
  const vw = viewportWidth();
  const cap = max ?? designWidth;
  if (vw >= cap) return Math.min(designWidth, cap);
  if (vw <= BREAKPOINTS.phone) {
    return Math.max(min, Math.min(cap, Math.round(vw * 0.92 - 16)));
  }
  if (vw <= BREAKPOINTS.largePhone) {
    return Math.max(min, Math.min(cap, Math.round(designWidth * 0.85)));
  }
  if (vw <= BREAKPOINTS.tablet) {
    return Math.max(min, Math.min(cap, Math.round(designWidth * 0.7)));
  }
  return Math.min(designWidth, cap);
}

/**
 * 响应式高度换算（与 width 独立）
 *  - phone（≤480）：视口高度的 75%
 *  - largePhone（≤600）：80%
 *  - tablet（≤1024）：85%
 *  - desktop：原样
 *
 * 用**可视**视口高度：软键盘弹起时对话框要跟着缩，否则确认按钮会被顶到键盘下面。
 */
export function responsiveHeight(designHeight: number, min = 280, max?: number): number {
  const vh = viewportHeight();
  const cap = max ?? designHeight;
  if (vh >= cap) return Math.min(designHeight, cap);
  if (vh <= BREAKPOINTS.phone) {
    return Math.max(min, Math.min(cap, Math.round(vh * 0.75)));
  }
  if (vh <= BREAKPOINTS.largePhone) {
    return Math.max(min, Math.min(cap, Math.round(vh * 0.8)));
  }
  if (vh <= BREAKPOINTS.tablet) {
    return Math.max(min, Math.min(cap, Math.round(vh * 0.85)));
  }
  return Math.min(designHeight, cap);
}

/* ------------------------------------------------------------------
 * visualViewport 监听：iOS 软键盘 / Android 输入法弹起时主动通知
 * ------------------------------------------------------------------ */

/** visualViewport 变化监听器 */
export interface ViewportListener {
  /** 视口尺寸变化（旋转、软键盘、地址栏收起等） */
  onResize: (info: { width: number; height: number; keyboardOpen: boolean }) => void;
}

/**
 * 注册 visualViewport / window resize 监听，返回 dispose 函数。
 * 内部去重 + 合并 rAF；用于浮动工具栏 / 输入框定位等需要在键盘弹起时重排的 UI。
 *
 * 浏览器兼容：visualViewport 是标准 API，Chrome 61+/Safari 13+。无此 API 时降级到 window resize。
 */
export function watchViewport(listener: ViewportListener): () => void {
  if (typeof window === "undefined") return () => {};

  let raf = 0;
  let lastW = 0;
  let lastH = 0;
  let lastKeyboard = false;
  const fire = () => {
    raf = 0;
    const w = viewportWidth();
    const h = viewportHeight();
    const keyboardOpen = isSoftKeyboardOpen();
    // 档位类每次 fire 都同步一次：宽度没变时是幂等的 6 次 classList 判断，成本可忽略；
    // 好处是「别人刚把 body 类清掉（重挂载 / 主题重载）」时能自愈。
    applyViewportTiers(w);
    if (w === lastW && h === lastH && keyboardOpen === lastKeyboard) return;
    lastW = w;
    lastH = h;
    lastKeyboard = keyboardOpen;
    listener.onResize({ width: w, height: h, keyboardOpen });
  };
  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(fire);
  };

  const vv = (window as any).visualViewport;
  if (vv && typeof vv.addEventListener === "function") {
    vv.addEventListener("resize", schedule);
    // scroll 事件在 iOS 软键盘弹起时也会触发
    vv.addEventListener("scroll", schedule);
  } else {
    // 降级：仅监听 window resize（无 visualViewport 时代）
    window.addEventListener("resize", schedule);
  }

  // 立即 fire 一次，让 listener 拿到初始值
  schedule();

  return () => {
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    if (vv && typeof vv.removeEventListener === "function") {
      vv.removeEventListener("resize", schedule);
      vv.removeEventListener("scroll", schedule);
    } else {
      window.removeEventListener("resize", schedule);
    }
  };
}
