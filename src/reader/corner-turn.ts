/**
 * 角落自动翻页（2026-10-25，复刻 Readest 0.12.12 useAutoPageTurn / PageTurnHint）
 * ------------------------------------------------------------------
 * Readest 源码参考（/Users/xieyue/Downloads/readest-0.12.12/apps/readest-app/src/）：
 *  - app/reader/hooks/useAutoPageTurn.ts —— 状态机：角落四分之一椭圆区（半径
 *    min(轴长×15%, 50px)）驻留 500ms 翻一页；一次驻留只翻一页（须离开角再进）；
 *    dwell 到点时活性复检；RTL 先镜像横轴；br=下一页 / tl=上一页。
 *  - app/reader/components/annotator/PageTurnHint.tsx —— L 形双条动画（视觉层在 ReaderView）。
 *
 * 本文件只放**纯逻辑**（几何 + 状态机），DOM/计时器由调用方注入 —— 与
 * wheel-gesture.ts 同一套"纯函数可单测"的模式。
 */

/** 角落半径 = min(轴长 × 此比例, 上限 px)。比例保小屏、上限保大屏只占角不侵正文（Readest 同值） */
export const CORNER_TURN_FRACTION = 0.15;
export const CORNER_TURN_MAX_PX = 50;
/** 角内驻留时长：掠过不翻（Readest AUTO_TURN_DWELL_MS 同值） */
export const CORNER_TURN_DWELL_MS = 500;

/** 物理角：br=右下（下一页方向），tl=左上（上一页方向） */
export type CornerSide = "br" | "tl";

/** 视口坐标矩形（getContentBounds 的形态） */
export interface CornerRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * 点落在哪个角落的四分之一椭圆内（无则 null）。
 * @param rtl RTL 书先镜像横轴：镜像后"逻辑 br"落在物理左下 —— 翻页方向仍走逻辑 next（Readest cornerAt 同款）。
 */
export function cornerAtPoint(
  x: number,
  y: number,
  rect: CornerRect,
  rtl = false
): CornerSide | null {
  const w = rect.right - rect.left;
  const h = rect.bottom - rect.top;
  if (w <= 0 || h <= 0) return null;
  const rx = Math.min(w * CORNER_TURN_FRACTION, CORNER_TURN_MAX_PX);
  const ry = Math.min(h * CORNER_TURN_FRACTION, CORNER_TURN_MAX_PX);
  const local = x - rect.left;
  const lx = rtl ? w - local : local;
  const ly = y - rect.top;
  const inEllipse = (dx: number, dy: number) => (dx / rx) ** 2 + (dy / ry) ** 2 <= 1;
  if (inEllipse(w - lx, h - ly)) return "br";
  if (inEllipse(lx, ly)) return "tl";
  return null;
}

/** 角 → 逻辑翻页方向（br=next / tl=prev；RTL 已在检测时镜像，这里恒物理角→逻辑向） */
export function cornerTurnDirection(corner: CornerSide): "prev" | "next" {
  return corner === "br" ? "next" : "prev";
}

export interface CornerTurnHost {
  /** 宿主现在的阅读区矩形（每拍重取，旋转/停靠栏变化自然跟随） */
  rect(): CornerRect | null;
  /** RTL 判定（renderer.rtl ?? book.dir） */
  rtl(): boolean;
  /** 进入角（armed）：宿主显示 L 形进度条 */
  onArmed(corner: CornerSide, rect: CornerRect): void;
  /** 离开角/取消：宿主收起动画 */
  onDismiss(): void;
  /** 驻留期满且活性复检通过：宿主执行翻页（翻后 L 条切 turned 态由 onTurnShown 汇报） */
  onTurn(corner: CornerSide, dir: "prev" | "next"): void;
  /** dwell 到点时的活性复检：指针此刻是否仍在该角（宿主持最后指针位） */
  stillInCorner(corner: CornerSide): boolean;
  /** 计时器注入（可测） */
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/**
 * 角落驻留状态机（Readest noteCorner/armDwell 的直译）：
 *  - note(point)：每次指针移动喂入；进角 armed + 起 dwell；出角 dismiss + 清计时。
 *  - 一次驻留只翻一页：翻页后角保持 engaged（turned 态），必须离开角再进才允许翻第二页。
 *  - dwell 到点先做 stillInCorner 复检（指针可能已移出）。
 */
export class CornerTurnMachine {
  private engaged: CornerSide | null = null;
  private turnedOnce = false;
  private timer: unknown = null;
  private lastPoint: { x: number; y: number } | null = null;

  constructor(private host: CornerTurnHost) {}

  /** 当前是否有活跃角（armed 或 turned）—— 共存规则用：此时边带机制让位 */
  isActive(): boolean {
    return this.engaged !== null;
  }

  /** 最后喂入的指针点（翻页后回放选区用；无则 null） */
  getPoint(): { x: number; y: number } | null {
    return this.lastPoint;
  }

  note(x: number, y: number): void {
    this.lastPoint = { x, y };
    const rect = this.host.rect();
    const corner = rect ? cornerAtPoint(x, y, rect, this.host.rtl()) : null;
    if (corner && rect) {
      if (this.engaged !== corner) {
        // 进入新角（或离开后再进）：重新武装 —— 这正是"一次驻留一页"的解锁点
        this.clear();
        this.engaged = corner;
        this.turnedOnce = false;
        this.host.onArmed(corner, rect);
        this.timer = this.host.setTimer(() => {
          this.timer = null;
          if (!this.engaged || this.turnedOnce) return;
          if (!this.host.stillInCorner(this.engaged)) return; // 活性复检（Readest armDwell 同款）
          this.turnedOnce = true;
          this.host.onTurn(this.engaged, cornerTurnDirection(this.engaged));
        }, CORNER_TURN_DWELL_MS);
      }
    } else if (this.engaged) {
      this.clear();
      this.host.onDismiss();
    }
  }

  /** 外部取消（松手/工具栏弹出/组件销毁） */
  cancel(): void {
    if (this.engaged) this.host.onDismiss();
    this.clear();
    this.lastPoint = null;
  }

  /** 活性复检实现（宿主回调的便捷拼装）：最后喂入的点是否仍在角内 */
  checkLiveness(corner: CornerSide): boolean {
    if (!this.lastPoint) return false;
    const rect = this.host.rect();
    if (!rect) return false;
    return cornerAtPoint(this.lastPoint.x, this.lastPoint.y, rect, this.host.rtl()) === corner;
  }

  private clear(): void {
    if (this.timer !== null) {
      this.host.clearTimer(this.timer);
      this.timer = null;
    }
    this.engaged = null;
    this.turnedOnce = false;
  }
}
