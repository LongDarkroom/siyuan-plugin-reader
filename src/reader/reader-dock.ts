import { logSwallow } from "../core/safe.ts";
/**
 * 阅读器 - Dock 集成控制器（书架容器）
 * ---------------------------------------------------------------
 * Dock 面板只承载「书架」（书库管理：导入/删除/编辑/续读标记）；
 * 点书 → 由 ReaderTabController 打开思源原生 Tab 阅读（支持多开）。
 * - 阅读样式设置（ReaderSettingsStore）与字体（FontStore）随 Dock 共享给 Tab
 * - 记忆上次阅读书籍：仅用于书架标记，不再自动弹 Tab（避免打扰）
 */

// @ts-ignore - Svelte 组件
import BookshelfView from "./BookshelfView.svelte";
// @ts-ignore - Svelte 组件（2026-10-10 列表化收敛：文档树选择器，取代 NotebookTargetPicker）
import DocTreePickerPage from "./settings/DocTreePickerPage.svelte";
import { BookshelfStore } from "./bookshelf-store";
import { ReaderSettingsStore } from "./reader-settings";
import { FontStore } from "./reader-fonts";
import { ReaderTabController } from "./reader-tab";
import { isSupportedBookFile } from "./book-adapters";
import { showMessage } from "siyuan";
// 2026-10-10：按书名自动建档（方案 B）
import { autoBindByTitle } from "./export/auto-bind.ts";
import { t } from "../i18n/index.ts";

export const READER_FEATURE_ID = "reader";

/** 书架「笔记发送目标」选择器回传的结果（2026-10-09） */
export type PickedTarget = { docId: string; docTitle?: string; notebookName?: string };

// 2026-09-11 移除死代码 createReaderFeature()：零调用点。
// reader feature 在 index.ts:843 的 dockFeatures 里内联定义（{ id: READER_FEATURE_ID, title: t("阅读器"), ... }），
// 这里的同名工厂函数自 2026 年某次重构后即无人调用，其 title: "阅读器" 是死字符串（翻译也轮不到它）。

export class ReaderDockController {
  private store: BookshelfStore;
  private settingsStore: ReaderSettingsStore;
  private fontStore: FontStore;
  private tabs: ReaderTabController;
  private comp: any = null;

  constructor(private plugin: any) {
    this.store = new BookshelfStore(plugin);
    this.settingsStore = new ReaderSettingsStore(plugin);
    this.fontStore = new FontStore(plugin);
    this.tabs = new ReaderTabController(plugin, {
      store: this.store,
      settingsStore: this.settingsStore,
      fontStore: this.fontStore,
    }, (id: string) => this.plugin?.resolveAnnotationLabel?.(id) ?? null);
    // addTab 必须在 onload 同步阶段注册
    this.tabs.register();
  }

  /** 初始化（书架索引 + 阅读设置 + 字体注册表） */
  async init(): Promise<void> {
    await this.store.load();
    await this.settingsStore.load();
    await this.fontStore.load();
  }

  get storeRef(): BookshelfStore {
    return this.store;
  }

  /** 阅读设置存储（2026-08-27：主设置「阅读设置」页直接读写，变更经 svelte store 推送到所有已开阅读 Tab） */
  get settingsStoreRef(): ReaderSettingsStore {
    return this.settingsStore;
  }

  get tabController(): ReaderTabController {
    return this.tabs;
  }

  /** 重置阅读器样式为出厂默认（数据面板「重置阅读设置」调用）；2026-09-09 双分家：book/pdf 一起重置 */
  resetReaderSettings(): void {
    this.settingsStore.resetAll();
  }

  /** 渲染书架面板（组合栏 Tab / 独立 Dock 共用入口） */
  render(dockElement: HTMLElement): void {
    const contentEl = dockElement.querySelector(
      "#hiword-dock-content"
    ) as HTMLElement | null;
    const target = contentEl ?? dockElement;
    // 销毁旧组件与旧视图，避免重复挂载泄漏
    try {
      this.comp?.$destroy?.();
    } catch (__swallowErr) { logSwallow(__swallowErr, "reader-dock.ts · render", "debug"); }
    this.comp = null;
    target.innerHTML = "";
    this.mountShelf(target);
  }

  /** 书架视图（点书 → 打开独立阅读 Tab） */
  private mountShelf(target: HTMLElement): void {
    this.comp = new BookshelfView({
      target,
      props: {
        store: this.store,
        onOpen: (bookId: string) => {
          const meta = this.store.get(bookId);
          void this.tabs.openBookTab(bookId, meta?.title);
        },
        // 2026-10-09：per-book 笔记发送目标的主入口。
        //
        // 依赖倒置：书架不加载思源 API、也不知道 settings 从哪来，
        // 由这里注入「弹选择器」的能力。弹窗挂在 document.body 上，
        // 不用 dock 的 target —— dock 面板有 overflow 约束会被裁掉。
        onPickNotebookTarget: (bookId: string, done: (p: PickedTarget | null) => void) => {
          this.openTargetPicker(bookId, done);
        },
        // 2026-10-10：按书名自动建档（方案 B）。
        // 依赖倒置同上：书架只传 bookId，建档/落盘由这里用 auto-bind.ts 完成。
        onAutoBind: (bookId: string, done: (ok: boolean) => void) => {
          void this.autoBindBook(bookId, done);
        },
      },
    });
  }

  /**
   * 打开「选择笔记发送目标」弹窗（挂 document.body，避开 dock 的 overflow 裁剪）。
   *
   * 2026-10-10 列表化收敛：由 `DocTreePickerPage`（standalone，mode=book）取代旧的
   * `NotebookTargetPicker` —— 文档树比平铺列表更直观，且与设置里的文档树同源。
   *
   * 交互：点文档名 → 选中（done(p) → 书架写 BookMeta）；点「清除绑定」→ onPick(null)
   * → 这里显式解绑（书架的 done(null) 是「取消」语义，不会清，故本地兜底）；
   * Esc / 点遮罩 → onClose → 取消（不动绑定）。
   */
  private openTargetPicker(bookId: string, done: (p: PickedTarget | null) => void): void {
    let pickerComp: any = null;
    const destroy = () => {
      try {
        pickerComp?.$destroy?.();
      } catch (__swallowErr) { logSwallow(__swallowErr, "reader-dock.ts · openTargetPicker", "debug"); }
      pickerComp = null;
    };
    try {
      pickerComp = new DocTreePickerPage({
        target: document.body,
        props: {
          api: null, // 缺失时页内自加载（loadDocPickerApi），与设置页同约定
          mode: "book",
          bookId,
          activeId: this.store.getNotebookTarget(bookId)?.docId ?? "",
          standalone: true,
          onPick: (p: PickedTarget | null) => {
            destroy();
            if (p) {
              done(p);
            } else {
              // 用户在文档树里点「清除绑定」：书架 done(null) 是「取消」语义不会清，
              // 这里显式解绑后再回调（回调忽略 null 也无妨）。
              void this.store.setNotebookTarget(bookId, null);
              done(null);
            }
          },
          onClose: () => {
            destroy();
            done(null);
          },
        },
      });
    } catch (__e) {
      logSwallow(__e, "reader-dock.ts · 打开目标选择器失败", "warn");
      destroy();
      done(null);
    }
  }

  /**
   * 按书名自动建档（2026-10-10，方案 B）。
   *
   * 由书架右键菜单触发。读 `settingsStore` 拿归档位置 / 子路径，
   * 经 `autoBindByTitle` 完成 校验 → 查重 → 建/复用 → 回填，
   * 用 `showMessage` 给反馈（dock 模块没有 ReaderView 那个本地 toast）。
   * 流程结束回调 `done(ok)` 让菜单项可感知结果。
   */
  private async autoBindBook(bookId: string, done: (ok: boolean) => void): Promise<void> {
    const s = this.settingsStore.get();
    const title = this.store.get(bookId)?.title;
    try {
      const r = await autoBindByTitle(
        this.store,
        bookId,
        title || "",
        s?.autoNotebookId || "",
        s?.autoNotebookName || "",
        s?.autoArchivePath || "",
      );
      showMessage(
        t(r.created ? "已创建并绑定《{doc}》" : "已绑定已有文档《{doc}》", { doc: title || "" }),
      );
      done(true);
    } catch (e) {
      showMessage(
        t("自动建档失败：{why}", { why: e instanceof Error ? e.message : String(e) }),
      );
      done(false);
    }
  }

  /** 卸载清理：销毁书架组件 + 关闭所有阅读 Tab */
  dispose(): void {
    try {
      this.comp?.$destroy?.();
    } catch (__swallowErr) { logSwallow(__swallowErr, "reader-dock.ts · dispose", "debug"); }
    this.comp = null;
    try {
      this.tabs.dispose();
    } catch (__swallowErr) { logSwallow(__swallowErr, "reader-dock.ts · dispose", "debug"); }
  }

  /** 编程式导入书籍（工具栏/命令可复用） */
  async importBook(file: File): Promise<boolean> {
    if (!isSupportedBookFile(file.name)) return false;
    try {
      await this.store.importBook(file);
      return true;
    } catch (e) {
      console.warn("[REword] 导入书籍失败:", e);
      return false;
    }
  }
}
