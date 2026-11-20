/**
 * 沉浸阅读（2026-11-19 初版 / 2026-11-20 重写）
 * ----------------------------------------------------------------
 * 不接管系统全屏 —— macOS 的「绿钮全屏」交给用户自己按；这里只把
 * **思源自己的外框**让位给阅读区：
 *   · #toolbar          顶部工具条（搜索/窗口菜单那一行）
 *   · #status           底部状态栏
 *   · #dockLeft         左侧图标竖条（**不是** .layout__dockl）
 *   · #dockRight        右侧图标竖条
 *   · .layout__dockl / .layout__dockr / .layout__dockb  左/右/下停靠面板
 *   · .layout__resize   分屏拖拽线（不隐藏会让布局被误拖动）
 *   · 阅读页签所在窗口的页签行（只藏当前窗口，不误伤其它分屏）
 *
 * ⚠️ 2026-11-20 修正三处「看起来生效、其实没生效」的坑：
 *
 *  ① **`.layout__wnd` / `.layout__panel` 在思源 3.8 已不存在。**
 *     真实结构是 `#layouts > … > div[data-type="wnd"] > div.fn__flex > ul.layout-tab-bar`
 *     （见 3.8.11 前端模板 `data-type="wnd" class="fn__flex-column fn__flex fn__flex-1"`）。
 *     旧代码 `root.closest(".layout__wnd")` 恒为 null ⇒ 页签栏从来没被藏过，
 *     用户看到的是「有时消失有时不消失」——那其实是思源自己在切布局。
 *     现在按 `[data-type="wnd"]` 定位，并保留旧类名作向后兼容兜底。
 *
 *  ② **只藏 `<ul class="layout-tab-bar">` 不够稳。** 内核的布局重算会把页签行的
 *     外层 `div.fn__flex` 上的 `fn__none` 摘掉（`re.classList.remove("fn__none")`），
 *     节点重建（拆窗、拖页签）也会换掉 <ul>。所以现在改藏**页签行包装层**，
 *     并且额外用 `:has()` 直接从「哪个窗口装着阅读器」推导，节点重建也自动生效。
 *
 *  ③ **左右图标竖条从没被隐藏过。** 旧 CSS 藏的是 `.layout__dockl/.layout__dockr`
 *     （停靠**面板**），而两条竖条是 `#dockLeft` / `#dockRight`，它们是 `#layouts`
 *     的兄弟节点，压根没进过隐藏名单。
 *
 * ⚠️ 为什么停靠面板不用 `:not(:has(…))`：`:has()` 不可用时整条选择器非法，
 *   CSS 会把**整条规则**丢掉（连 #toolbar 一起失效）。所以面板是否隐藏改由 JS
 *   判定并打 `.reword-immersive-keep` 类，CSS 只用 CSS3 的 `:not(.class)`；
 *   `:has()` 只出现在最后一条**增强**规则里，掉了也只是少一层保险。
 *
 * 之所以不用 requestFullscreen：那会连 macOS 菜单栏/绿钮一起接管，
 * 用户无法再用系统全屏按钮控制窗口，退出也只能靠 Esc。
 *
 * body 上挂类 + 注入一段 <style>，不改思源源码、不动布局内联样式；
 * 退出时只移除类名，思源下次布局计算自然回到原样。
 */

export const IMMERSIVE_BODY_CLASS = "reword-immersive";
export const IMMERSIVE_HIDE_CLASS = "reword-immersive-hide";
/** 标在阅读器根节点上：`:has()` 增强规则靠它判断「哪个窗口装着阅读器」 */
export const IMMERSIVE_HOST_CLASS = "reword-immersive-host";
/** 标在「装着阅读器的停靠面板」上：这类面板不能藏，否则阅读区自己消失 */
export const IMMERSIVE_KEEP_CLASS = "reword-immersive-keep";
export const IMMERSIVE_STYLE_ID = "reword-immersive-style";

export const IMMERSIVE_CSS = `
body.${IMMERSIVE_BODY_CLASS} #toolbar,
body.${IMMERSIVE_BODY_CLASS} #status,
body.${IMMERSIVE_BODY_CLASS} #dockLeft,
body.${IMMERSIVE_BODY_CLASS} #dockRight,
body.${IMMERSIVE_BODY_CLASS} .layout__resize,
body.${IMMERSIVE_BODY_CLASS} .layout__dockl:not(.${IMMERSIVE_KEEP_CLASS}),
body.${IMMERSIVE_BODY_CLASS} .layout__dockr:not(.${IMMERSIVE_KEEP_CLASS}),
body.${IMMERSIVE_BODY_CLASS} .layout__dockb:not(.${IMMERSIVE_KEEP_CLASS}),
body.${IMMERSIVE_BODY_CLASS} .${IMMERSIVE_HIDE_CLASS} {
  display: none !important;
}
body.${IMMERSIVE_BODY_CLASS} [data-type="wnd"]:has(.${IMMERSIVE_HOST_CLASS}) > .fn__flex > .layout-tab-bar {
  display: none !important;
}
`.trim();

/** 当前被隐藏的页签行（同一时刻只允许一个沉浸实例） */
let activeTabBar: HTMLElement | null = null;
/** 当前标了宿主类的阅读器根节点 */
let activeHost: HTMLElement | null = null;
/** 为了「不藏自己」而临时打了 keep 类的停靠面板 */
let keptDocks: HTMLElement[] = [];

export function ensureImmersiveStyle(doc: Document | null | undefined): void {
  if (!doc?.head) return;
  if (doc.getElementById(IMMERSIVE_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = IMMERSIVE_STYLE_ID;
  style.textContent = IMMERSIVE_CSS;
  doc.head.append(style);
}

export function removeImmersiveStyle(doc: Document | null | undefined): void {
  doc?.getElementById(IMMERSIVE_STYLE_ID)?.remove();
}

/**
 * 找到「阅读器所在窗口」的页签行包装层。
 *
 * 3.8 结构：`[data-type="wnd"] > div.fn__flex > ul.layout-tab-bar`
 * 旧结构（3.1 之前）：`.layout__wnd > .layout-tab-bar` / `.layout__panel > …`
 *
 * 返回**包装层**而不是 `<ul>`：内核重算会把包装层上的 `fn__none` 摘掉，
 * 藏 <ul> 在极端时序下会被重新显示；藏包装层则连 `fn__none` 一起去掉。
 */
function findTabBar(root: HTMLElement | null): HTMLElement | null {
  const wnd =
    root?.closest('[data-type="wnd"]') ??
    root?.closest(".layout__wnd") ??
    root?.closest(".layout__panel");
  if (!wnd) return null;
  // 手工扫子节点而不用 `:scope > …`：`:scope` 在部分运行时（含 jsdom）行为不一致，
  // 而这里只需要「窗口节点的直接子行」。3.8 模板里页签行是 `div.fn__flex`。
  const rows = Array.from(wnd.children).filter(
    (el) => el.nodeType === 1 && el.classList.contains("fn__flex"),
  ) as HTMLElement[];
  for (const row of rows) {
    const bar = Array.from(row.children).find(
      (el) => el.nodeType === 1 && el.classList.contains("layout-tab-bar"),
    ) as HTMLElement | undefined;
    // 只把「专装页签的那一行」当包装层，避免误伤别的 .fn__flex 容器
    if (bar && row.children.length <= 3) return row;
  }
  const bar = wnd.querySelector(".layout-tab-bar") as HTMLElement | null;
  if (!bar) return null;
  const row = bar.parentElement;
  if (row && row !== wnd && row.classList.contains("fn__flex") && row.children.length <= 3) {
    return row;
  }
  return bar;
}

/** 阅读器自己停在侧栏里时，那块停靠面板不能藏（否则阅读区瞬间 0 尺寸） */
function markKeptDocks(root: HTMLElement | null): void {
  if (!root) return;
  for (const sel of [".layout__dockl", ".layout__dockr", ".layout__dockb"]) {
    const dock = root.closest(sel) as HTMLElement | null;
    if (!dock || keptDocks.includes(dock)) continue;
    dock.classList.add(IMMERSIVE_KEEP_CLASS);
    keptDocks.push(dock);
  }
}

function clearKeptDocks(): void {
  for (const dock of keptDocks) {
    try {
      dock.classList.remove(IMMERSIVE_KEEP_CLASS);
    } catch {
      /* 面板可能已随布局销毁 */
    }
  }
  keptDocks = [];
}

/**
 * 让思源自己的布局重算跑一遍（它绑的是 `window.addEventListener("resize", …)`）。
 * 必要性：内核会在页签行的 `getBoundingClientRect().top <= 0` 时给只读条写
 * `minWidth: 56px` 等内联样式；页签行被我们藏掉后 rect 全 0，退出时若不复算，
 * 这些内联样式会残留，页签栏恢复后看着「窄了一截」。dispatch 一次 resize 即回到正轨。
 */
function nudgeHostLayout(doc?: Document | null): void {
  const win = (doc ?? globalThis.document)?.defaultView;
  if (!win?.requestAnimationFrame) return;
  win.requestAnimationFrame(() => {
    try {
      win.dispatchEvent(new win.Event("resize"));
    } catch {
      /* 宿主可能已销毁 */
    }
  });
}

/** 进入沉浸：隐藏思源外框。重复调用是幂等的（会先复位上一个实例）。 */
export function enterImmersive(doc: Document | null | undefined, root: HTMLElement | null): void {
  if (!doc?.body) return;
  exitImmersive(doc);
  ensureImmersiveStyle(doc);
  // 先标宿主与 keep 面板：`:has()` 增强规则与「不藏自己」都必须赶在挂 body 类之前生效，
  // 否则停靠态下会先闪一帧「容器被藏 → 阅读区 0 尺寸」。
  if (root) {
    root.classList.add(IMMERSIVE_HOST_CLASS);
    activeHost = root;
    markKeptDocks(root);
  }
  doc.body.classList.add(IMMERSIVE_BODY_CLASS);
  const tabBar = findTabBar(root);
  if (tabBar) {
    tabBar.classList.add(IMMERSIVE_HIDE_CLASS);
    activeTabBar = tabBar;
  }
  nudgeHostLayout(doc);
}

/** 退出沉浸：原样还回思源外框。没有活动实例时静默返回。 */
export function exitImmersive(doc?: Document | null): void {
  try {
    activeTabBar?.classList.remove(IMMERSIVE_HIDE_CLASS);
  } catch {
    /* 页签栏可能已随 Tab 关闭被销毁 */
  }
  activeTabBar = null;
  try {
    activeHost?.classList.remove(IMMERSIVE_HOST_CLASS);
  } catch {
    /* 根节点可能已随 Tab 关闭被销毁 */
  }
  activeHost = null;
  clearKeptDocks();
  (doc ?? globalThis.document)?.body?.classList.remove(IMMERSIVE_BODY_CLASS);
  nudgeHostLayout(doc);
}

/**
 * 补挂：沉浸期间页签行被内核重建（拆窗 / 拖页签 / 布局重载）时，
 * 重新把隐藏类挂到新的包装层上。浏览器支持 `:has()` 时其实冗余，
 * 但 `:has()` 缺失的环境（老 WebView）需要它。
 */
export function resyncImmersiveTabBar(doc: Document | null | undefined): void {
  if (!doc?.body || !activeHost) return;
  if (!doc.body.classList.contains(IMMERSIVE_BODY_CLASS)) return;
  if (activeTabBar?.isConnected && activeTabBar.classList.contains(IMMERSIVE_HIDE_CLASS)) return;
  const next = findTabBar(activeHost);
  if (!next || next === activeTabBar) return;
  try {
    activeTabBar?.classList.remove(IMMERSIVE_HIDE_CLASS);
  } catch {
    /* 旧节点可能已销毁 */
  }
  next.classList.add(IMMERSIVE_HIDE_CLASS);
  activeTabBar = next;
}
