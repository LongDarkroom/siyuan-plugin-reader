/**
 * 阅读器 - 键盘共用层（提示面板 toggle 注册 + 全局键盘入口 + 翻页语义分发）
 * --------------------------------------------------------------------
 * 把 ReaderView / BookshelfView / 未来的 Notebook 共享的键盘逻辑抽到一处：
 *  1. 顶层注册一个 capture 阶段的 keydown 监听，**单一真源**调用 matchShortcut。
 *  2. 翻页键（←→/↑↓/Space/Home/End/PageUp/PageDown）走 `onPageTurn` 回调，
 *     由回调按 view 模式（滚动 vs 分页）自行决定 view.next(size) 还是 view.goRight()。
 *  3. 其它动作（设置 / TTS / 缩放 / 主题 / 全屏 / 书签 / 字号）走 `onShortcut` 回调。
 *  4. `?` 唤出快捷键提示面板 —— 任何一个视图调用 `bindGlobalShortcutHint(toggle)` 后，
 *     `?` 与 `Shift+/` 都会触发该 toggle（Mac 物理 `?` 键就是 Shift+/）。
 *  5. 跳过 input/textarea/contenteditable，让原生输入框照常工作。
 *
 * 不依赖：annotation / vocab / ai / dict（reader 内部独立）。
 * 复用：reader-shortcuts.ts 的 READER_SHORTCUTS / NO_MODIFIER_SHORTCUTS / matchShortcut。
 *
 * 生命周期：mount 时 installGlobalKeyHandler 一次性挂到 window，
 * 组件 onDestroy 调用返回的 dispose 清理（避免热重载泄漏）。
 */
import { logSwallow } from "../core/safe.ts";
import {
  matchShortcut,
  getHintGroups,
  type ShortcutAction,
  type ShortcutOverride,
  type HintLine,
} from "./reader-shortcuts.ts";
// 2026-10-24：翻页动作改走 page-turn.ts（统一翻页入口的单一真源）。
// 语义在 page-turn.ts 里定义（逻辑方向 vs 物理方向），本文件只做动作→意图的映射，
// 避免「同一个翻页动作在不同入口用不同方向」这种 RTL 书必炸的分叉。
import { turnPage } from "./page-turn.ts";

// 2026-10-10：re-export matchShortcut。
// ReaderView / BookshelfView 等消费者从**本模块** import matchShortcut（把 keyboard-shared
// 当作阅读器键盘的单一入口），而该函数实际定义在 reader-shortcuts.ts。
// 不做 re-export 时 vite/rollup 会报「"matchShortcut" is not exported by keyboard-shared.ts」
// → 整个插件构建失败 → 用户加载的是上一次的旧 dist（方向键翻页修复根本发不出去）。
export { matchShortcut };

/* ---------------------------------------------------------------- *
 * 1. 提示面板 toggle 顶层注册
 * ---------------------------------------------------------------- */

/** 提示面板 toggle 函数（任意视图注册后共享） */
type HintToggle = (force?: boolean) => void;
let boundHintToggle: HintToggle | null = null;

/**
 * 把「切换快捷键提示面板」的回调注册到顶层。
 *
 * 设计：顶层持有单例，**任意一个 ReaderView / BookshelfView / Notebook 调用一次**即可，
 * 后续按 `?`（Mac Shift+/）都会触发该 toggle。重复调用会**覆盖**（最后一次生效），
 * 避免热重载或 Tab 切换时多个实例互相打架。
 *
 * @returns 解绑函数（视图销毁时调用，回归未绑定状态）
 */
export function bindGlobalShortcutHint(toggle: HintToggle | null): () => void {
  boundHintToggle = toggle;
  return () => {
    if (boundHintToggle === toggle) boundHintToggle = null;
  };
}

/** 取当前已注册的 toggle（测试用） */
export function getBoundHintToggle(): HintToggle | null {
  return boundHintToggle;
}

/* ---------------------------------------------------------------- *
 * 2. 翻页语义分发（视图层用）
 * ---------------------------------------------------------------- */

/** 翻页回调入参：动作 + view 引用（可能为 null） */
export type PageTurnHandler = (action: PageTurnAction, view: any) => void;

/** 触发翻页的动作（与 ShortcutAction 子集对齐，方便 UI 提示） */
export type PageTurnAction =
  | "prevPage"
  | "nextPage"
  | "prevSection"
  | "nextSection"
  | "goStart"
  | "goEnd";

/**
 * 默认翻页实现（视图层可复用或完全替换）：
 *  - prevPage/nextPage/PgUp/PgDn：整页翻（与←→ 等价，物理方向）
 *  - prevSection/nextSection（↑↓）：滚动模式按视口高度滚一段，分页模式翻页
 *  - goStart（Home）：view.goToTextStart()
 *  - goEnd（End）：view.goTo(last section)
 *  - view 为 null：静默吞掉，不抛错
 *
 * 2026-10-24：翻页部分委托给 page-turn.ts 的 turnPage（单一真源）。
 * 动作→意图的映射：
 *   prevPage    → prevPhysical  （← 键 / PgUp：屏幕向左）
 *   nextPage    → nextPhysical  （→ 键 / PgDn：屏幕向右）
 *   prevSection → prevSection   （↑：滚动模式退一屏，分页模式翻页）
 *   nextSection → nextSection   （↓：同上）
 * ⚠️ 行为与改前**完全一致**（test/smoke-keyboard-shared.test.mjs 钉住），
 *    差别只是实现搬了家 —— 以后加「滚轮翻页」不必再各写一份方向判断。
 */
export function defaultPageTurn(action: PageTurnAction, view: any): void {
  if (!view) {
    // view 还没装好（foliate 异步加载期间）—— 静默吞掉，避免 throw 与 toast 噪音
    return;
  }
  try {
    switch (action) {
      case "prevPage":
        turnPage(view, "prevPhysical");
        return;
      case "nextPage":
        turnPage(view, "nextPhysical");
        return;
      case "prevSection":
      case "nextSection":
        turnPage(view, action === "nextSection" ? "nextSection" : "prevSection");
        return;
      case "goStart":
        void view.goToTextStart?.();
        return;
      case "goEnd":
        try {
          const last = view?.book?.sections?.length
            ? view.book.sections.length - 1
            : 0;
          void view.goTo?.(last);
        } catch (__e) {
          logSwallow(__e, "keyboard-shared.ts · goEnd", "debug");
        }
        return;
    }
  } catch (__e) {
    logSwallow(__e, "keyboard-shared.ts · pageTurn", "debug");
  }
}

/** 动作是否是翻页类（用于提示面板分组 / 单元测试） */
export function isPageTurnAction(action: ShortcutAction): action is PageTurnAction {
  return (
    action === "prevPage" ||
    action === "nextPage" ||
    action === "prevSection" ||
    action === "nextSection" ||
    action === "goStart" ||
    action === "goEnd"
  );
}

/* ---------------------------------------------------------------- *
 * 3. 全局键盘入口
 * ---------------------------------------------------------------- */

export interface GlobalKeyOptions {
  /** Mac 决定 ⌘ / Ctrl；非 Mac 决定 Ctrl */
  isMac: boolean;
  /** 用户自定义键位（来自快捷键设置面板） */
  overrides?: Record<string, ShortcutOverride> | null;
  /** view 提供器（每次按键时调用，避免 view 还没装好就拿空引用） */
  getView?: () => any;
  /** 翻页回调；不传则用 defaultPageTurn */
  onPageTurn?: PageTurnHandler;
  /** 其它快捷键回调（设置 / TTS / 缩放 / 主题 / 全屏 / 书签 / 字号） */
  onShortcut?: (action: ShortcutAction, e: KeyboardEvent) => void;
  /**
   * 是否处理提示面板 toggle（默认 true）。
   * 当多个视图同时挂载，**只有一个**应设为 true，其它 false。
   */
  consumeHint?: boolean;
}

/**
 * 安装全局键盘入口（capture 阶段 + 顶层 window，覆盖 iframe 内按键）。
 *
 * @returns dispose 函数（视图销毁时调用）
 */
export function installGlobalKeyHandler(opts: GlobalKeyOptions): () => void {
  const isMac = opts.isMac;
  const overrides = opts.overrides;
  const getView = opts.getView;
  const onPageTurn = opts.onPageTurn ?? defaultPageTurn;
  const onShortcut = opts.onShortcut;
  const consumeHint = opts.consumeHint !== false;

  const handler = (e: KeyboardEvent) => {
    // 1. 跳过输入控件
    const t = e.target as HTMLElement | null;
    if (t) {
      const tag = t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || t.isContentEditable) {
        return;
      }
    }

    // 2. 提示面板（? 与 Mac 的 Shift+/）
    if (consumeHint && (e.key === "?" || (e.key === "/" && e.shiftKey))) {
      e.preventDefault();
      boundHintToggle?.();
      return;
    }

    // 3. 匹配 ShortcutAction
    const action = matchShortcut(e, isMac, overrides);
    if (!action) return;

    // 4. 翻页类 → onPageTurn
    if (isPageTurnAction(action)) {
      e.preventDefault();
      const view = getView ? getView() : null;
      onPageTurn(action, view);
      return;
    }

    // 5. 其它动作 → onShortcut
    if (onShortcut) {
      e.preventDefault();
      try {
        onShortcut(action, e);
      } catch (__e) {
        logSwallow(__e, "keyboard-shared.ts · onShortcut", "warn");
      }
    }
  };

  window.addEventListener("keydown", handler, true);
  return () => window.removeEventListener("keydown", handler, true);
}

/* ---------------------------------------------------------------- *
 * 4. 提示面板数据（任意 UI 都可消费，不耦合 ReaderView）
 * ---------------------------------------------------------------- */

export interface HintGroupPayload {
  key: "nav" | "view" | "tts" | "other";
  label: string;
  items: HintLine[];
}

/**
 * 包装 getHintGroups 并统一返回类型，方便 UI 直接消费。
 * 不传参数时走默认（无 overrides + Windows 平台）。
 */
export function getHintPayload(
  overrides?: Record<string, ShortcutOverride> | null,
  isMac = false,
): HintGroupPayload[] {
  return getHintGroups(overrides, isMac) as HintGroupPayload[];
}
