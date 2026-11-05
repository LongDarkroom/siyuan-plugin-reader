/**
 * 宿主分屏拖拽事件桥（2026-11-05）
 * ------------------------------------------------------------
 * 思源分屏线（.layout__resize）的拖拽把 `document.onmousemove/onmouseup` 挂在主文档上：
 *   · mousemove 处理**不检查按键**，只要属性还在，鼠标一动就继续改宽度；
 *   · 唯一收尾点是主文档的 mouseup。
 * 它本来靠 `.fn__pointer-none iframe { pointer-events: none }` 让 iframe 在拖拽期间「透明」，
 * 但书页 iframe 在 foliate 的 shadow DOM 里 —— 主文档样式进不去，iframe 仍会吃掉指针；
 * 而 iframe 是独立文档，里面的 mouseup 也不会冒泡回主文档。
 * ⇒ 越过书页松手时宿主收不到 mouseup，残留的 onmousemove 让分屏线跟着裸鼠标乱跑。
 *
 * 本模块只放纯逻辑：判定宿主是否在拖拽、把 iframe 坐标换算回主文档坐标。
 */
export const HOST_DRAG_CLASS = "fn__pointer-none";

/** 宿主是否处于拖拽态：思源用 document 上的两个 property handler + body 类标记。 */
export function isHostDragActive(doc: Document): boolean {
  const anyDoc = doc as Document & { onmousemove?: unknown; onmouseup?: unknown };
  return !!(anyDoc.onmousemove || anyDoc.onmouseup || doc.body?.classList.contains(HOST_DRAG_CLASS));
}

export type FrameRect = { left: number; top: number };

/** iframe 局部 client 坐标 → 主文档 client 坐标。 */
export function toHostPoint(
  rect: FrameRect | null | undefined,
  clientX: number,
  clientY: number,
): { clientX: number; clientY: number } {
  return { clientX: clientX + (rect?.left ?? 0), clientY: clientY + (rect?.top ?? 0) };
}
