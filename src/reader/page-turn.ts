/**
 * 统一翻页入口（单一真源）。
 *
 * ## 为什么需要它
 * 改之前，翻页动作散落在 7+ 处调用点（iframe 内键盘、侧边箭头、底部栏、
 * 进度条、触摸滑动……），各自直接调 `view.goLeft()/goRight()`。问题有两个：
 *
 *  ① **语义混淆**：foliate 里 `goLeft/goRight` 是**物理方向**（屏幕左/右），
 *     `next/prev` 是**逻辑方向**（下一段/上一段）。RTL 书里两者相反。
 *     滚轮翻页要的是**逻辑方向**（滚轮向下 = 下一页，与书写方向无关），
 *     方向键要的是**物理方向**（按 ← 就是往左）。混用就会在 RTL 书里翻反。
 *  ② **入口分散**：加"滚轮翻页"时若再写一个 `view.goRight()`，
 *     就又多一处需要维护 RTL 语义的调用点。
 *
 * ## 术语
 *   - 逻辑（logical）：prev/next，与书写方向无关。滚轮用这个。
 *   - 物理（physical）：left/right，屏幕方向。方向键 / 箭头按钮用这个。
 *
 * foliate 的 `view.goLeft()` 内部已经按 `renderer.rtl` 做了 RTL 适配，
 * 所以**物理方向**的调用方不需要自己判断书写方向。
 */

/** 翻页意图 */
export type TurnIntent =
  /** 逻辑上一页（与书写方向无关；RTL 书里也是"上一页"） */
  | "prev"
  /** 逻辑下一页 */
  | "next"
  /** 物理左一页（← 键 / 左侧箭头） */
  | "prevPhysical"
  /** 物理右一页（→ 键 / 右侧箭头） */
  | "nextPhysical"
  /** 上一节 / 下一节（滚动模式 = 滚一屏，分页模式 = 翻一页） */
  | "prevSection"
  | "nextSection";

/** 是否连续滚动模式 */
export function isScrolledMode(view: any): boolean {
  return !!(view as any)?.renderer?.scrolled;
}

/** 滚动模式下"一屏"的滚动距离 */
export function scrollStep(view: any): number {
  return Math.max(120, Number((view as any)?.renderer?.size) || 0);
}

/**
 * 执行一次翻页。view 为空（foliate 尚未加载完成）时静默吞掉，不抛错。
 *
 * ⚠️ 不改变既有行为：键盘上下键在分页模式下仍等价于左右键（goLeft/goRight），
 *    在滚动模式下仍按视口高度滚一段（next/prev(size)）。
 */
export function turnPage(view: any, intent: TurnIntent): void {
  if (!view) return;
  try {
    const scrolled = isScrolledMode(view);
    switch (intent) {
      case "prev":
        // 逻辑上一页：分页/滚动都用 foliate 的 prev（RTL 下自动正确）
        void view.prev?.();
        return;
      case "next":
        void view.next?.();
        return;
      case "prevPhysical":
        void view.goLeft?.();
        return;
      case "nextPhysical":
        void view.goRight?.();
        return;
      case "prevSection":
        if (scrolled) void view.prev?.(scrollStep(view));
        else void view.goLeft?.();
        return;
      case "nextSection":
        if (scrolled) void view.next?.(scrollStep(view));
        else void view.goRight?.();
        return;
    }
  } catch {
    // 翻页失败不应打断阅读（foliate 未就绪 / 章节边界异常）
  }
}
