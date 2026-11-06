/**
 * 设置行长说明的 ⓘ 浮层（2026-11-06）
 * ----------------------------------------------------------------
 * 为什么不用行内 absolute 气泡：`.rwd-card` 有 `overflow: hidden`（圆角裁切），
 * 行内气泡在卡片底部会被直接裁掉。
 * 故做成 body 上的单例浮层 + position: fixed，跨卡片/滚动容器都安全。
 *
 * 交互：
 *  · 悬停 / 聚焦 = 临时显示（离开即收）
 *  · 点击 = 钉住（触屏没有 hover），点空白处或再次点击才收
 *  · 滚动 / 窗口尺寸变化 = 收起（避免气泡停在旧位置）
 */

let el: HTMLDivElement | null = null;
let anchorEl: HTMLElement | null = null;
let pinned = false;
let listening = false;

const GAP = 7;
const MARGIN = 8;

function ensureEl(): HTMLDivElement {
  if (el) return el;
  const node = document.createElement("div");
  node.className = "rw-tip";
  node.setAttribute("role", "tooltip");
  document.body.appendChild(node);
  el = node;
  return node;
}

function setExpanded(anchor: HTMLElement | null, value: boolean) {
  try {
    anchor?.setAttribute("aria-expanded", value ? "true" : "false");
  } catch {
    /* 元素已卸载 */
  }
}

function place() {
  if (!el || !anchorEl) return;
  const rect = anchorEl.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let top = rect.top - GAP - h;
  if (top < MARGIN) top = rect.bottom + GAP;
  let left = rect.left + rect.width / 2 - w / 2;
  left = Math.max(MARGIN, Math.min(left, window.innerWidth - w - MARGIN));
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

function hideNow() {
  if (!el) return;
  el.classList.remove("on");
  setExpanded(anchorEl, false);
  anchorEl = null;
  pinned = false;
}

function onDocPointerDown(e: PointerEvent) {
  if (!el || !el.classList.contains("on")) return;
  const target = e.target as Node | null;
  if (target && anchorEl?.contains(target)) return;
  hideNow();
}

function onViewportChange() {
  hideNow();
}

function listenOnce() {
  if (listening) return;
  listening = true;
  document.addEventListener("pointerdown", onDocPointerDown, true);
  // capture：设置面板内部滚动不会冒泡到 window，必须捕获
  window.addEventListener("scroll", onViewportChange, true);
  window.addEventListener("resize", onViewportChange);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideNow();
  });
}

/** 悬停 / 聚焦：临时显示 */
export function showSettingsTip(anchor: HTMLElement, text: string) {
  if (!text) return;
  listenOnce();
  // 换到另一个 ⓘ 时，之前钉住的状态失效
  if (anchorEl !== anchor) pinned = false;
  const node = ensureEl();
  if (anchorEl && anchorEl !== anchor) setExpanded(anchorEl, false);
  node.textContent = text;
  node.classList.add("on");
  anchorEl = anchor;
  setExpanded(anchor, true);
  place();
}

/** 离开：若该 ⓘ 已被点击钉住则保留 */
export function hideSettingsTip(anchor?: HTMLElement) {
  if (anchor && pinned && anchorEl === anchor) return;
  hideNow();
}

/** 点击：钉住 / 取消钉住（触屏唯一入口） */
export function toggleSettingsTip(anchor: HTMLElement, text: string) {
  if (el && anchorEl === anchor && el.classList.contains("on")) {
    pinned = false;
    hideNow();
    return;
  }
  pinned = true;
  showSettingsTip(anchor, text);
  pinned = true;
}

/** 面板卸载 / 行隐藏时强制收起 */
export function resetSettingsTip() {
  pinned = false;
  hideNow();
}
