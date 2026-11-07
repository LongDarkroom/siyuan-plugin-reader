/**
 * AI 右栏控制器（2026-11-06）
 * ----------------------------------------------------------------
 * 把阅读助手放进思源原生右侧停靠栏，作为**常驻入口**：
 *  - `register()` 在 onload 同步阶段 addDock（与 addTab 同样的硬性要求）；
 *  - `open()` 选中并展开右栏 AI 图标；没有书时 AiTabView 会自动切到通用对话；
 *  - `deliverQuote()` 打开右栏并把选段投进面板（等挂载后重试，避免首开落空）；
 *  - 与 AI 页签互斥：打开一个就收起另一个，避免同一会话两份在跑流式。
 *
 * 内容复用 AiTabView（surface="dock"），宿主能力仍来自 ReaderView.getAiPanelHost()。
 */
import { t } from "../i18n/index.ts";
import { getLogger } from "../core/logger.ts";
import { logSwallow } from "../core/safe.ts";
import { isMobile } from "../core/env.ts";
// @ts-ignore - Svelte 组件
import AiTabView from "./AiTabView.svelte";

export const AI_DOCK_TYPE = "reader-ai-dock";

export class AiDockController {
  private view: any = null;
  private pending: { bookId: string; quote: any } | null = null;
  private retryTimer: any = null;

  /**
   * @param plugin 插件实例（提供 addDock / openAiTab / 设置读写）
   * @param getReaderTabs 懒取 ReaderTabController（onload 同步阶段它还没建好）
   */
  constructor(
    private plugin: any,
    private getReaderTabs: () => any
  ) {}

  /** 必须在 onload 的同步阶段调用（addDock 的硬性要求） */
  register(): void {
    try {
      this.plugin.addDock({
        config: {
          position: "RightBottom",
          size: { width: 400, height: 0 },
          icon: "iconREAi",
          title: t("阅读助手"),
          show: false,
        },
        data: {},
        type: AI_DOCK_TYPE,
        init: (custom: any) => this.mount(custom),
        destroy: () => this.unmount(),
      });
    } catch (e) {
      getLogger().warn("[RE 阅读器] AI 右栏注册失败", { error: e });
    }
  }

  /** addDock 注册后，思源用「插件名 + type」作为 dock 的 data-type */
  private dataType(): string {
    return `${this.plugin.name}${AI_DOCK_TYPE}`;
  }

  private dockItem(): HTMLSpanElement | null {
    try {
      return document.querySelector(`span.dock__item[data-type="${this.dataType()}"]`);
    } catch {
      return null;
    }
  }

  private isActive(el: HTMLElement | null): boolean {
    return (
      !!el &&
      (el.classList.contains("dock__item--active") || el.classList.contains("dock__item--activefocus"))
    );
  }

  /** 右栏当前是否展开（按 DOM 状态判断，不依赖组件是否常驻内存） */
  isOpen(): boolean {
    return this.isActive(this.dockItem());
  }

  /**
   * 打开或聚焦右栏 AI。
   * 已经展开时只把焦点送进输入框；未展开时点击 dock 图标让思源自己完成
   * 选中态、布局与持久化，避免直接调内部 API 的版本差异。
   */
  open(): void {
    if (isMobile()) return;
    try {
      this.plugin.closeAiTab?.();
    } catch (__swallowErr) {
      logSwallow(__swallowErr, "ai-dock-controller.ts · open · closeAiTab", "debug");
    }
    const item = this.dockItem();
    if (!item) {
      getLogger().warn("[RE 阅读器] 未找到 AI 右栏图标，无法打开", { data: { type: this.dataType() } });
      return;
    }
    if (this.isActive(item)) {
      this.view?.focusComposer?.();
      return;
    }
    try {
      item.click();
    } catch (e) {
      getLogger().warn("[RE 阅读器] 打开 AI 右栏失败", { error: e });
      return;
    }
    this.focusWhenMounted();
  }

  /** 收起右栏（页签打开时调用）；找不到面板时退回点击图标 */
  close(): void {
    const item = this.dockItem();
    if (!item || !this.isActive(item)) return;
    const type = this.dataType();
    try {
      const layout = (window as any).siyuan?.layout;
      const dock =
        (layout?.rightDock?.data?.[type] && layout.rightDock) ||
        (layout?.leftDock?.data?.[type] && layout.leftDock) ||
        (layout?.bottomDock?.data?.[type] && layout.bottomDock) ||
        null;
      if (dock && typeof dock.toggleModel === "function") {
        dock.toggleModel(type, false, true);
        return;
      }
    } catch (__swallowErr) {
      logSwallow(__swallowErr, "ai-dock-controller.ts · close · toggleModel", "debug");
    }
    try {
      item.click();
    } catch (__swallowErr) {
      logSwallow(__swallowErr, "ai-dock-controller.ts · close · click", "debug");
    }
  }

  /**
   * 把选段投进右栏：先打开，再等面板挂载后投递。
   * 返回 true 表示已经发起打开（手机端没有右栏，返回 false）。
   */
  deliverQuote(bookId: string, quote: any): boolean {
    if (isMobile()) return false;
    this.open();
    this.pending = { bookId, quote };
    this.scheduleDeliver(0);
    return true;
  }

  private scheduleDeliver(attempt: number): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      const pending = this.pending;
      if (!pending) return;
      let ok = false;
      try {
        ok = !!this.view?.deliverQuote?.(pending.bookId, pending.quote);
      } catch (__swallowErr) {
        logSwallow(__swallowErr, "ai-dock-controller.ts · deliverQuote", "debug");
      }
      if (ok) {
        this.pending = null;
        this.view?.focusComposer?.();
        return;
      }
      // 首开时 dock 内容要等思源渲染，最多等约 1.2 秒
      if (attempt >= 15) {
        this.pending = null;
        getLogger().warn("[RE 阅读器] 选段未能投进 AI 右栏", { data: { bookId: pending.bookId } });
        return;
      }
      this.scheduleDeliver(attempt + 1);
    }, 80);
  }

  private focusWhenMounted(): void {
    let tries = 0;
    const tick = () => {
      if (this.view) {
        this.view.focusComposer?.();
        return;
      }
      if (++tries > 12) return;
      setTimeout(tick, 80);
    };
    setTimeout(tick, 0);
  }

  private mount(custom: any): void {
    this.unmount();
    // 点 dock 图标打开、或还原布局时页签也在：同一会话只留右栏这一份
    try {
      this.plugin.closeAiTab?.();
    } catch (__swallowErr) {
      logSwallow(__swallowErr, "ai-dock-controller.ts · mount · closeAiTab", "debug");
    }
    try {
      const host = custom?.element as HTMLElement | undefined;
      if (!host) return;
      host.style.cssText =
        "display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;position:relative;";
      const holder = document.createElement("div");
      holder.style.cssText =
        "position:relative;flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;";
      host.append(holder);

      this.view = new AiTabView({
        target: holder,
        props: {
          surface: "dock",
          readerTabs: this.readerFacade(),
          getAiSettings: () => this.plugin.getAiSettings?.() ?? null,
          saveAiSettings: (patch: any) => this.plugin.updateAiSettings?.(patch) ?? Promise.resolve(),
          openShelf: () => this.plugin.openShelfTab?.(),
          onClose: () => this.close(),
          onOpenTab: () => this.plugin.openAiTab?.(),
        },
      });
    } catch (e) {
      getLogger().warn("[RE 阅读器] AI 右栏挂载失败", { error: e });
    }
  }

  private unmount(): void {
    const view = this.view;
    this.view = null;
    this.pending = null;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (!view) return;
    try {
      view.$destroy?.();
    } catch (__swallowErr) {
      logSwallow(__swallowErr, "ai-dock-controller.ts · unmount", "debug");
    }
  }

  /** 插件卸载：销毁面板，避免残留指向已销毁实例的组件 */
  dispose(): void {
    this.unmount();
  }

  /** 懒取 ReaderTabController 的门面（与 AiTabController 同形） */
  private readerFacade() {
    const tabs = () => this.getReaderTabs();
    return {
      getActiveReader: () => tabs()?.getActiveReader?.() ?? null,
      getReaderComp: (bookId: string) => tabs()?.getReaderComp?.(bookId) ?? null,
      listOpenBooks: () => tabs()?.listOpenBooks?.() ?? [],
      openBookTab: (bookId: string, title?: string) => tabs()?.openBookTab?.(bookId, title),
    };
  }
}
