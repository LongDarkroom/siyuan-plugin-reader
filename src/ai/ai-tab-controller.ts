/**
 * AI 页签控制器（2026-11-05）
 * ----------------------------------------------------------------
 * 职责只有三件：
 *  1. 在 onload 同步阶段注册自定义页签类型（type = "reader-ai"）；
 *  2. `open()` 打开/聚焦唯一一个 AI 页签（手机端不提供，沿用阅读器内浮层）；
 *  3. 在页签头挂「锁定本书」按钮 —— 按钮 DOM 由本控制器维护，
 *     状态（文案/是否可点）由 AiTabView 经 onPinState 回传。
 *
 * 页签内容本身是 AiTabView：它自己解析「跟随活动阅读器 / 锁定书」，
 * 并调用 ReaderView.getAiPanelHost() 取宿主能力。
 */
import { openTab } from "siyuan";
import { t } from "../i18n/index.ts";
import { getLogger } from "../core/logger.ts";
import { logSwallow } from "../core/safe.ts";
import { isMobile } from "../core/env.ts";
// @ts-ignore - Svelte 组件
import AiTabView from "./AiTabView.svelte";

export const AI_TAB_TYPE = "reader-ai";

interface PinState {
  locked: boolean;
  disabled: boolean;
  label: string;
  title: string;
}

interface AiTabRecord {
  tab: any;
  view: any;
  headBtn: HTMLButtonElement;
  headObserver: MutationObserver | null;
  cleanupHead: () => void;
}

export class AiTabController {
  private rec: AiTabRecord | null = null;

  /**
   * @param plugin 插件实例（提供 addTab / openShelfTab / 设置读写）
   * @param getReaderTabs 懒取 ReaderTabController（onload 同步阶段它还没建好）
   */
  constructor(
    private plugin: any,
    private getReaderTabs: () => any
  ) {}

  /** 必须在 onload 的同步阶段调用（addTab 的硬性要求） */
  register(): void {
    const self = this;
    try {
      this.plugin.addTab({
        type: AI_TAB_TYPE,
        init(this: any) {
          self.mount(this);
        },
        destroy(this: any) {
          self.unmount(this);
        },
      });
    } catch (e) {
      getLogger().warn("[RE 阅读器] AI 页签注册失败", { error: e });
    }
  }

  /** 打开或聚焦 AI 页签（页签 id 固定 → 反复调用不会开多个） */
  open(): void {
    // 手机端 openTab 是官方空实现；阅读器内的全屏面板已经覆盖该场景
    if (isMobile()) return;
    // 与右栏互斥：同一会话不在两处同时挂载（否则会各跑一条流式、互相覆盖存储）
    try {
      this.plugin.closeAiDock?.();
    } catch (__swallowErr) {
      logSwallow(__swallowErr, "ai-tab-controller.ts · open · closeAiDock", "debug");
    }
    if (this.rec?.tab) {
      try {
        this.rec.tab.parent?.switchTab?.(this.rec.tab.headElement);
        return;
      } catch (__swallowErr) {
        logSwallow(__swallowErr, "ai-tab-controller.ts · focus existing", "debug");
      }
    }
    try {
      void openTab({
        app: this.plugin.app,
        custom: {
          id: `${this.plugin.name}${AI_TAB_TYPE}`,
          // 与书架/阅读页签同源的线性图标；由 index.ts 的 addIcons 注册
          icon: "iconREAi",
          title: t("阅读助手"),
          data: {},
        },
        // 从阅读器停靠栏呼出时直接在右侧分屏，省掉手动拖拽；
        // 页签已存在时走上面的 switchTab，不会重复开。
        position: "right",
        keepCursor: false,
        afterOpen: () => {
          try {
            const tab = this.rec?.tab;
            if (tab) tab.parent?.switchTab?.(tab.headElement);
          } catch (__swallowErr) {
            logSwallow(__swallowErr, "ai-tab-controller.ts · afterOpen", "debug");
          }
        },
      });
    } catch (e) {
      getLogger().warn("[RE 阅读器] 打开 AI 页签失败", { error: e });
    }
  }

  /** 页签当前是否挂载（阅读器据此判断「问 AI」能不能直接投递） */
  isOpen(): boolean {
    return !!this.rec?.tab;
  }

  /** 收起 AI 页签（右栏打开时调用，保证同一时刻只有一个 AI 面板） */
  close(): void {
    const rec = this.rec;
    if (!rec) return;
    try {
      rec.tab?.close?.();
    } catch (__swallowErr) {
      logSwallow(__swallowErr, "ai-tab-controller.ts · close", "debug");
    }
    this.unmount(rec.tab);
  }

  /**
   * 把选段直接投到已打开的 AI 页签。
   * 页签未挂载、宿主没就绪或锁定的是别的书时返回 false，由调用方回落停靠栏；
   * 投递成功后聚焦页签——用户刚点「问 AI」，结果应当就在眼前。
   */
  deliverQuote(bookId: string, quote: any): boolean {
    let ok = false;
    try {
      ok = !!this.rec?.view?.deliverQuote?.(bookId, quote);
    } catch (__swallowErr) {
      logSwallow(__swallowErr, "ai-tab-controller.ts · deliverQuote", "debug");
    }
    if (ok) this.open();
    return ok;
  }

  private mount(custom: any): void {
    if (this.rec) return;
    // 还原布局时右栏和页签可能同时被恢复：谁先挂载谁留下，另一个立即收掉
    try {
      this.plugin.closeAiDock?.();
    } catch (__swallowErr) {
      logSwallow(__swallowErr, "ai-tab-controller.ts · mount · closeAiDock", "debug");
    }
    try {
      custom.element.style.display = "flex";
      custom.element.style.flexDirection = "column";
      custom.element.style.height = "100%";
      custom.element.style.minHeight = "0";
      custom.element.style.position = "relative";
      custom.element.style.overflow = "hidden";
      const holder = document.createElement("div");
      holder.style.cssText =
        "position:relative;flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;";
      custom.element.append(holder);

      const head = this.createHeadButton(custom.tab, () => this.rec?.view);
      const view: any = new AiTabView({
        target: holder,
        props: {
          readerTabs: this.readerFacade(),
          getAiSettings: () => this.plugin.getAiSettings?.() ?? null,
          saveAiSettings: (patch: any) => this.plugin.updateAiSettings?.(patch) ?? Promise.resolve(),
          openShelf: () => this.plugin.openShelfTab?.(),
          onPinState: (state: PinState) => head.sync(state),
        },
      });
      this.rec = {
        tab: custom.tab,
        view,
        headBtn: head.btn,
        headObserver: head.observer,
        cleanupHead: head.cleanup,
      };
    } catch (e) {
      getLogger().warn("[RE 阅读器] AI 页签挂载失败", { error: e });
    }
  }

  private unmount(custom: any): void {
    const rec = this.rec;
    if (!rec) return;
    if (custom?.tab && rec.tab !== custom.tab) return;
    try {
      rec.cleanupHead();
    } catch (__swallowErr) {
      logSwallow(__swallowErr, "ai-tab-controller.ts · cleanupHead", "debug");
    }
    try {
      rec.view?.$destroy?.();
    } catch (__swallowErr) {
      logSwallow(__swallowErr, "ai-tab-controller.ts · destroy view", "debug");
    }
    this.rec = null;
  }

  /** 插件卸载：关掉 AI 页签，避免残留指向已销毁实例的组件 */
  dispose(): void {
    try {
      this.rec?.tab?.close?.();
    } catch (__swallowErr) {
      logSwallow(__swallowErr, "ai-tab-controller.ts · dispose", "debug");
    }
    if (this.rec) this.unmount(this.rec.tab);
  }

  /**
   * 懒取 ReaderTabController 的门面。
   * AI 页签可能在阅读器控制器建好之前就被思源恢复，因此每次调用都现取；
   * 缺席时返回安全的空值，不抛错。
   */
  private readerFacade() {
    const tabs = () => this.getReaderTabs();
    return {
      getActiveReader: () => tabs()?.getActiveReader?.() ?? null,
      getReaderComp: (bookId: string) => tabs()?.getReaderComp?.(bookId) ?? null,
      listOpenBooks: () => tabs()?.listOpenBooks?.() ?? [],
      openBookTab: (bookId: string, title?: string) => tabs()?.openBookTab?.(bookId, title),
    };
  }

  /**
   * 页签头的「锁定本书」按钮。
   *
   * 自定义 Tab 的 headElement 由思源在 `updateTitle` 时可能重建，
   * 所以用 MutationObserver 兜底重新插入；按钮点击不得触发页签拖拽/切换以外的行为。
   */
  private createHeadButton(tab: any, getView: () => any) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "re-ai-tab-head-btn";
    btn.textContent = t("锁定本书");
    btn.title = t("打开一本书后即可锁定");
    btn.setAttribute("aria-pressed", "false");
    btn.disabled = true;

    const onClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      getView()?.togglePin?.();
    };
    const onPointerDown = (e: Event) => e.stopPropagation();
    btn.addEventListener("click", onClick);
    btn.addEventListener("pointerdown", onPointerDown);

    const mountButton = () => {
      const head = tab?.headElement as HTMLElement | null;
      if (!head) return;
      if (btn.isConnected) return;
      const close = head.querySelector(".item__close");
      if (close) close.before(btn);
      else head.append(btn);
    };
    mountButton();

    let observer: MutationObserver | null = null;
    const headEl = tab?.headElement as HTMLElement | null;
    if (headEl && typeof MutationObserver !== "undefined") {
      observer = new MutationObserver(() => mountButton());
      observer.observe(headEl, { childList: true });
    }

    return {
      btn,
      observer,
      sync(state: PinState) {
        btn.textContent = state.label || t("锁定本书");
        btn.title = state.title || "";
        btn.classList.toggle("is-locked", !!state.locked);
        btn.setAttribute("aria-pressed", state.locked ? "true" : "false");
        btn.disabled = !!state.disabled;
      },
      cleanup() {
        observer?.disconnect();
        btn.removeEventListener("click", onClick);
        btn.removeEventListener("pointerdown", onPointerDown);
        btn.remove();
      },
    };
  }
}
