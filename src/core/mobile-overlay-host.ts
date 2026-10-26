/**
 * 移动端全屏浮层承载层（2026-10-26 · 路线 A）
 * ==================================================================
 * 对标「思阅」（SiReader v2.5.7）的手机端实现。逆向结论与证据见
 * docs/手机端适配对标思阅-调研与方案-2026-10-26.md。
 *
 * 为什么不再用思源 Dialog 承载（v0.2.0 的做法）
 * ------------------------------------------------------------------
 *  · 思源 Dialog 把 options.content 塞进 `.b3-dialog__body`，而 height 只写在
 *    `.b3-dialog__container` ⇒ body 没有确定高度，我们的 host 的 `height:100%`
 *    解析不到值（真机布局塌缩）。v0.2.0 用 core/dialog-host.ts 的「三层 flex +
 *    实测 px 写死 + ResizeObserver」硬修，等于**追着思源 Dialog 的实现跑**，
 *    思源一升级就可能再塌。
 *  · Dialog 自带标题栏 chrome（占正文 1~2 行），且书架 Dialog + 阅读 Dialog 两层叠加。
 *  · 移动端原生「返回」手势无处安放（思源 mobile 前端不用 history 路由）。
 *
 * 本模块承担三件事（与思阅 index.js @997747 的 Pe / ze / Z_ 一一对应）
 * ------------------------------------------------------------------
 *  1. 容器：`#re-mobile-overlay`（position:fixed; inset:0; z-index:100; 主题背景）
 *     **只建一次**，关闭时 display:none 复用 DOM，不每次开书重建（省闪白）。
 *  2. 层栈：最多两层 —— 底层「书架」+ 顶层「阅读」（与思阅一致：移动端一次一本）。
 *     关掉阅读层 → 露出下层书架；再关 → 整个浮层隐藏。
 *  3. 返回键：打开浮层时压一个历史哨兵（history.pushState），popstate 到来 ⇒
 *     消费一层（关阅读 / 关书架），而不是退出整个思源页面；
 *     UI 主动关闭时把哨兵退回去（history.back），历史栈不留幽灵条目。
 *
 * 设计约束
 * ------------------------------------------------------------------
 *  · document / window 一律**在方法内现取**（不在模块顶层捕获），
 *    这样 node 单测可以先装假 DOM 再 import 本模块。
 *  · 层栈与哨兵配平是纯逻辑，DOM 只在宿主方法里操作。
 */

import { logSwallow } from "./safe.ts";

/** 浮层角色：底层书架 / 顶层阅读（与思阅「一次一本」模型一致） */
export type MobileOverlayRole = "shelf" | "reader";

/** 层挂载后由调用方返回的句柄（destroy 用于卸载 Svelte 组件） */
export interface MobileOverlayLayerHandle {
  destroy?: () => void;
}

/** 打开一层的参数 */
export interface MobileOverlayOpenOptions {
  /**
   * 幂等键：同 role + 同 key 已存在 ⇒ **只聚焦不重建**（保留滚动位置/阅读进度）。
   * 同 role 不同 key ⇒ 替换旧层（换书）。
   */
  key?: string;
  /** 挂载回调：把组件挂到层元素上 */
  mount: (el: HTMLElement) => MobileOverlayLayerHandle | void;
}

const CONTAINER_ID = "re-mobile-overlay";
/** z-index 取思阅同值 100：高于思源 mobile 的 .toolbar(7)，低于 #sidebar(200) */
const CONTAINER_Z = 100;

interface Layer {
  role: MobileOverlayRole;
  key: string;
  el: HTMLElement;
  destroy?: () => void;
}

/**
 * 移动端全屏浮层宿主（单例）。
 *
 * 层级模型（自底向上）：
 *   container(#re-mobile-overlay, fixed inset:0)
 *     └─ layer(shelf)   书架层
 *        └─ layer(reader) 阅读层（覆盖整层）
 */
export class MobileOverlayHost {
    private container: HTMLElement | null = null;
    private layers = new Map<MobileOverlayRole, Layer>();
    /** 层序（自底向上） */
    private order: MobileOverlayRole[] = [];
    /** 已压入浏览器的历史哨兵数（每个打开的层一个） */
    private sentinels = 0;
    /** 自己 history.back() 触发的 popstate 需要忽略（避免把层也关掉） */
    private suppressPop = 0;
    private boundPop: ((e: Event) => void) | null = null;
    private boundKey: ((e: Event) => void) | null = null;

    /** 浮层是否开着（有任何一层） */
    isOpen(): boolean {
        return this.order.length > 0;
    }

    /** 当前层数（0=关闭，1=只有书架，2=书架+阅读） */
    depth(): number {
        return this.order.length;
    }

    /** 顶层角色（null=未开） */
    top(): MobileOverlayRole | null {
        return this.order.length ? this.order[this.order.length - 1] : null;
    }

    /** 某角色是否开着 */
    has(role: MobileOverlayRole): boolean {
        return this.layers.has(role);
    }

    /**
     * 打开一层。
     *  · 同 role + 同 key 已存在 ⇒ 只把它提到顶层（聚焦），不重新挂载。
     *  · 同 role + 不同 key ⇒ 先拆旧层再挂新层。
     */
    open(role: MobileOverlayRole, opts: MobileOverlayOpenOptions): void {
        const key = opts.key ?? role;
        const existing = this.layers.get(role);
        if (existing && existing.key === key) {
            // 已开同一目标：提到顶层即可（不重建，保住滚动位置与阅读状态）
            this.focus(role);
            return;
        }
        if (existing) {
            this.closeLayer(role);
        }

        const container = this.ensureContainer();
        const el = this.createLayerEl(role);
        container.appendChild(el);
        container.style.display = "block";

        let handle: MobileOverlayLayerHandle | void;
        try {
            handle = opts.mount(el);
        } catch (e) {
            // 挂载失败不留空壳：撤层、恢复容器状态，错误上抛给调用方
            try {
                el.remove?.();
            } catch (__e) {
                logSwallow(__e, "mobile-overlay-host.ts · open 回滚", "debug");
            }
            if (!this.order.length) container.style.display = "none";
            throw e;
        }

        this.layers.set(role, { role, key, el, destroy: handle?.destroy });
        this.order.push(role);
        // 调用方（如书架挂载）可能改写 position/尺寸 → 挂载后重申层几何
        this.assertLayerGeometry(el);
        // 层序变了 → 刷新层间 z-index（层与层的高低必须显式，不能靠 DOM 顺序）
        this.refreshLayerZIndex();
        this.bindGlobal();
        this.pushSentinel();
    }

    /** 关闭指定角色的一层（无此层则无操作） */
    close(role: MobileOverlayRole): void {
        this.closeLayer(role);
    }

    /** 关闭顶层（返回键 / Esc 走这里）：阅读层 → 书架层 → 浮层消失 */
    closeTop(): void {
        const top = this.top();
        if (!top) return;
        this.closeLayer(top);
    }

    /** 全部关闭（插件卸载时调用） */
    closeAll(): void {
        // 自顶向下拆，保证每次 closeLayer 的哨兵配平顺序正确
        while (this.order.length) {
            const top = this.order[this.order.length - 1];
            this.closeLayer(top);
        }
        this.hideContainer();
        this.unbindGlobal();
    }

    /** 容器：只建一次，重复调用复用 */
    private ensureContainer(): HTMLElement {
        const doc = this.doc();
        const exist = doc?.getElementById?.(CONTAINER_ID);
        if (exist) {
            this.container = exist as HTMLElement;
            return exist as HTMLElement;
        }
        const el = doc.createElement("div");
        el.id = CONTAINER_ID;
        el.style.cssText =
            "position:fixed;inset:0;z-index:" +
            CONTAINER_Z +
            ";background:var(--b3-theme-background);display:none;" +
            "overscroll-behavior:contain;";
        doc.body.appendChild(el);
        this.container = el;
        return el;
    }

    /**
     * 层元素：铺满容器。
     *
     * ⚠️ 2026-10-26 层叠上下文隔离（真机截图实证的「穿透」bug）：
     * 层元素若只有 `position:absolute` 而**没有 z-index / isolation**，
     * 它就**不建立层叠上下文** ⇒ 内部子元素的 z-index（如书架卡片右下角的
     * `.book-more-btn` 的 `z-index:3`）会逃逸到**容器**的层叠上下文里参与排序，
     * 结果是「书架层里的按钮浮到后绘制的阅读层之上」——正文中凭空出现一排圆点按钮。
     *
     * 修法：每个层元素都建立**独立层叠上下文**（`isolation:isolate` + 非 auto 的
     * z-index，二者任一都足以建立），子元素 z-index 被关在自己层内，不再逃逸。
     * 层与层之间的高低由 refreshLayerZIndex() 按**当前层序**显式定序。
     */
    private createLayerEl(role: MobileOverlayRole): HTMLElement {
        const el = this.doc().createElement("div");
        el.className = "re-mobile-overlay-layer";
        el.setAttribute("data-re-role", role);
        this.assertLayerGeometry(el);
        this.applyLayerZIndex(el, role);
        return el;
    }

    /**
     * 层元素自身的层叠属性：建立独立层叠上下文（隔离子元素 z-index）。
     *
     * 两条都做，互为备份：
     *  · `z-index` 非 auto + 定位元素 ⇒ **必定**建立层叠上下文（所有浏览器都支持）
     *  · `isolation:isolate` 显式声明（Safari 15.4+ / Chrome 41+，语义更清楚）
     */
    private applyLayerZIndex(el: HTMLElement, role: MobileOverlayRole): void {
        try {
            el.style.isolation = "isolate";
            el.style.zIndex = role === "reader" ? "2" : "1";
        } catch (e) {
            logSwallow(e, "mobile-overlay-host.ts · applyLayerZIndex", "debug");
        }
    }

    /**
     * 按**当前层序**刷新各层的 z-index（自底向上 1、2、3…）。
     * 用显式 z-index 而不是靠 DOM 顺序（appendChild 先后）——显式值不依赖
     * 「谁后 append 谁在上面」这条隐式规则，重排/复用/换书时更稳。
     */
    private refreshLayerZIndex(): void {
        this.order.forEach((role, idx) => {
            const layer = this.layers.get(role);
            if (!layer) return;
            try {
                layer.el.style.zIndex = String(idx + 1);
            } catch (e) {
                logSwallow(e, "mobile-overlay-host.ts · refreshLayerZIndex", "debug");
            }
        });
    }

    /** 重申层几何（调用方可能改写 style） */
    private assertLayerGeometry(el: HTMLElement): void {
        try {
            el.style.position = "absolute";
            el.style.left = "0";
            el.style.top = "0";
            el.style.width = "100%";
            el.style.height = "100%";
            el.style.minHeight = "0";
            el.style.display = "flex";
            el.style.flexDirection = "column";
            el.style.overflow = "hidden";
        } catch (e) {
            logSwallow(e, "mobile-overlay-host.ts · assertLayerGeometry", "debug");
        }
    }

    /** 拆掉某角色的一层：销毁组件 → 移除 DOM → 退一个历史哨兵 */
    private closeLayer(role: MobileOverlayRole): void {
        const layer = this.layers.get(role);
        if (!layer) return;
        this.layers.delete(role);
        const idx = this.order.indexOf(role);
        if (idx >= 0) this.order.splice(idx, 1);
        try {
            layer.destroy?.();
        } catch (e) {
            logSwallow(e, "mobile-overlay-host.ts · closeLayer destroy", "warn");
        }
        try {
            layer.el.remove?.();
        } catch (e) {
            logSwallow(e, "mobile-overlay-host.ts · closeLayer remove", "debug");
        }
        // 层序变了 → 刷新层间 z-index（否则留下的层仍带着旧序号的 z-index）
        this.refreshLayerZIndex();
        // 历史哨兵配平：UI 主动关闭要把哨兵退回（否则浏览器历史留下幽灵条目）
        this.popSentinel();
        if (!this.order.length) {
            this.hideContainer();
            this.unbindGlobal();
        }
    }

    /** 把某角色提到顶层（已开着同一目标时用） */
    private focus(role: MobileOverlayRole): void {
        const idx = this.order.indexOf(role);
        if (idx < 0) return;
        this.order.splice(idx, 1);
        this.order.push(role);
        const layer = this.layers.get(role);
        if (layer && this.container) {
            this.container.appendChild(layer.el);
            this.assertLayerGeometry(layer.el);
        }
        // 提到顶层 → 刷新层间 z-index（层序变了）
        this.refreshLayerZIndex();
    }

    /** 无层时隐藏容器（保留 DOM，下次复用） */
    private hideContainer(): void {
        try {
            if (this.container) this.container.style.display = "none";
        } catch (e) {
            logSwallow(e, "mobile-overlay-host.ts · hideContainer", "debug");
        }
    }

    /* ---------------- 全局监听（返回键 / Esc） ---------------- */

    private bindGlobal(): void {
        const win = this.win();
        if (!win) return;
        if (!this.boundPop) {
            this.boundPop = (e: Event) => this.onPopState(e);
            try {
                win.addEventListener("popstate", this.boundPop);
            } catch (e) {
                logSwallow(e, "mobile-overlay-host.ts · bind popstate", "debug");
            }
        }
        if (!this.boundKey) {
            this.boundKey = (e: Event) => {
                const ke = e as KeyboardEvent;
                if (ke?.key === "Escape") this.closeTop();
            };
            try {
                win.addEventListener("keydown", this.boundKey);
            } catch (e) {
                logSwallow(e, "mobile-overlay-host.ts · bind keydown", "debug");
            }
        }
    }

    private unbindGlobal(): void {
        const win = this.win();
        if (!win) return;
        if (this.boundPop) {
            try {
                win.removeEventListener("popstate", this.boundPop);
            } catch (e) {
                logSwallow(e, "mobile-overlay-host.ts · unbind popstate", "debug");
            }
            this.boundPop = null;
        }
        if (this.boundKey) {
            try {
                win.removeEventListener("keydown", this.boundKey);
            } catch (e) {
                logSwallow(e, "mobile-overlay-host.ts · unbind keydown", "debug");
            }
            this.boundKey = null;
        }
    }

    /**
     * 返回键：popstate ⇒ 消费一层。
     *  · 自己 history.back() 触发的 popstate 忽略（那是退哨兵，不是关层）。
     *  · 浮层开着就关顶层（与思阅「popstate → mobile-close」同语义）。
     */
    private onPopState(_e: Event): void {
        if (this.suppressPop > 0) {
            this.suppressPop--;
            return;
        }
        if (this.sentinels > 0) this.sentinels--;
        this.closeTop();
    }

    /* ---------------- 历史哨兵 ---------------- */

    /** 压一个哨兵：让「返回」先关浮层，而不是直接离开思源 */
    private pushSentinel(): void {
        const win = this.win();
        try {
            if (!win?.history?.pushState) return;
            win.history.pushState({ __reMobileOverlay: Date.now() }, "");
            this.sentinels++;
        } catch (e) {
            // 老 WebView / 受限环境没有 history API：返回键退化为浏览器默认行为
            logSwallow(e, "mobile-overlay-host.ts · pushSentinel", "debug");
        }
    }

    /** 退一个哨兵：UI 主动关闭时把历史条目还回去 */
    private popSentinel(): void {
        if (this.sentinels <= 0) return;
        this.sentinels--;
        const win = this.win();
        try {
            if (!win?.history?.back) return;
            this.suppressPop++;
            win.history.back();
            // history.back 是异步的：popstate 到达后会被忽略；超时兜底清标记
            setTimeout(() => {
                if (this.suppressPop > 0) this.suppressPop--;
            }, 600);
        } catch (e) {
            logSwallow(e, "mobile-overlay-host.ts · popSentinel", "debug");
        }
    }

    /* ---------------- 环境取用（现取，便于单测注入假 DOM） ---------------- */

    private doc(): Document {
        return (globalThis as any).document as Document;
    }

    private win(): (Window & typeof globalThis) | undefined {
        return (globalThis as any).window as (Window & typeof globalThis) | undefined;
    }
}

/** 单例：书架（index.ts）与阅读（reader-tab.ts）共用同一个浮层宿主 */
export const mobileOverlay = new MobileOverlayHost();
