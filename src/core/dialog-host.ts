/**
 * 移动端 Dialog 内容高度链硬化 v2（2026-10-25 书架/阅读弹窗 C1）
 * ==================================================================
 * 背景：书架/阅读在移动端由 Dialog 承载（思源移动端 openTab 是空实现）。
 * 思源 Dialog 把 options.content 放进 `.b3-dialog__body`，height 选项只写在
 * `.b3-dialog__container` 上 —— `.b3-dialog__body` 自身没有确定高度，我们原来的
 * `height:100%` host 在这条链上解析不到值 ⇒ 视图塌缩/溢出（真机布局炸裂）。
 *
 * v2 双保险策略（不依赖思源全局 CSS 的任何假设）：
 *  1) flex 主策略：container → body → host 三层显式 flex 列；
 *  2) 实测兜底：按 container 实测高度 − header 实测高度，把 body 高度**写死成 px**，
 *     ResizeObserver 跟随旋转/窗口变化重算。
 * 只碰本插件自己的弹窗（调用方传入 dialog 实例），不影响思源其他弹窗。
 */

export function hardenDialogBody(
  dialog: { element: HTMLElement },
  hostSelector: string
): HTMLElement | null {
  const container = dialog.element.querySelector(".b3-dialog__container") as HTMLElement | null;
  const body = dialog.element.querySelector(".b3-dialog__body") as HTMLElement | null;
  const host = dialog.element.querySelector(hostSelector) as HTMLElement | null;
  if (!host) return null;

  // ---- 辅策略：三层 flex 列（思源 CSS 正常时 100% 链天然成立）----
  if (container) {
    container.style.display = "flex";
    container.style.flexDirection = "column";
    container.style.overflow = "hidden";
  }
  if (body) {
    body.style.flex = "1";
    body.style.minHeight = "0";
    body.style.display = "flex";
    body.style.flexDirection = "column";
    body.style.overflow = "hidden";
    // 思源给 __body 的默认 padding 会吃掉书架/阅读的可用宽度，去掉
    body.style.padding = "0";
  }
  host.style.flex = "1";
  host.style.minHeight = "0";
  host.style.position = "relative";
  host.style.display = "flex";
  host.style.flexDirection = "column";
  host.style.overflow = "hidden";

  // ---- 主兜底：实测 container 高 − header 高，把 body 高度写成确定 px ----
  const fit = () => {
    try {
      if (!container) return;
      const rect = container.getBoundingClientRect();
      if (rect.height < 40) return; // 弹窗还没排好（动画中），等下一轮 RO
      const header = dialog.element.querySelector(".b3-dialog__header") as HTMLElement | null;
      const headerH = header ? header.offsetHeight : 0;
      const h = Math.max(120, Math.round(rect.height - headerH));
      if (body) body.style.height = h + "px";
    } catch {
      /* ignore */
    }
  };
  fit();
  let ro: ResizeObserver | null = null;
  try {
    ro = new ResizeObserver(fit);
    if (container) ro.observe(container);
  } catch {
    /* 无 ResizeObserver 环境： fit() 一次性兜底 */
  }
  // 弹窗销毁时由调用方取用，防 ResizeObserver 泄漏
  (host as HTMLElement & { __reDisposeDialogFit?: () => void }).__reDisposeDialogFit = () => {
    try { ro?.disconnect(); } catch { /* ignore */ }
  };
  return host;
}

/** 取出并执行弹窗尺寸观察器的清理（destroyCallback 里调用） */
export function disposeDialogFit(host: HTMLElement | null | undefined): void {
  const d = (host as (HTMLElement & { __reDisposeDialogFit?: () => void }) | null | undefined)?.__reDisposeDialogFit;
  try { d?.(); } catch { /* ignore */ }
}
