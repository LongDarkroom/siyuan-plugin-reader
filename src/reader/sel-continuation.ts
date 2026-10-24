/**
 * 跨页选区续接的 DOM 底层工具（无 Svelte 依赖，可单测）。
 *
 * ## 背景：分页模式下"选区跨页"到底能不能做
 * foliate 的分页渲染是**一个 section 一个 iframe**，iframe 内部用 CSS 多列排版：
 *   - `documentElement` 的宽度被钉成**一列宽**（`columnize`），
 *     `column-fill: auto` ⇒ 内容按列横向流动；
 *   - iframe 元素本身被撑成**整个 section 的宽度**（`expand()` 里
 *     `expandedSize = pageCount * columnSize`），外层容器 `overflow:hidden` + scrollLeft 翻页。
 *
 * ⇒ **同一个 section 内，所有页的内容在 DOM 上是连续的一段**，
 *   列与列之间只是 CSS 分栏。DOM Range 天然可以跨列 ⇒ 一个 CFI 就能覆盖跨页选区。
 *   （foliate 的 overlayer 用 `getClientRects()` 画高亮，跨列 range 会返回两列的矩形，
 *   两列都会被画上 —— 见 vendor/foliate-js/overlayer.js `#getRects`。）
 *
 * ⇒ **跨 section 不行**：不同 section 是不同 iframe / 不同 Document，
 *   Range 无法跨文档。只能按段存储（`AnnotationItem.segments`），逐段画。
 *
 * 本文件提供三组能力：
 *   ① 矩形工具：可见区求交 / 求并（工具栏锚点 + 可见性判定）
 *   ② 选区延长：沿 DOM 顺序把 Range 的末端向后 / 起点向前推进 N 个字符
 *   ③ 边缘判定：指针是否越过了当前可见列的左右边界
 */

/** 矩形（视口坐标或 iframe 局部坐标皆可） */
export interface Rect4 {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 两个矩形是否相交（有面积重叠） */
export function rectsIntersect(a: Rect4, b: Rect4): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** 求一组矩形的并集；空数组返回 null */
export function unionRects(rects: ArrayLike<Rect4> | null | undefined): Rect4 | null {
  if (!rects) return null;
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  let count = 0;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (!r) continue;
    if (r.right <= r.left || r.bottom <= r.top) continue;
    count++;
    if (r.left < left) left = r.left;
    if (r.top < top) top = r.top;
    if (r.right > right) right = r.right;
    if (r.bottom > bottom) bottom = r.bottom;
  }
  if (!count) return null;
  return { left, top, right, bottom };
}

/**
 * 只保留与"可见窗口"相交的矩形，再求并集。
 *
 * 用于**跨页选区**的锚点：跨页 Range 的整体包围盒横跨两页（中间是空白），
 * 直接拿它当锚点会把工具栏放到两页之间的空隙里。取"可见部分"的并集才是用户看到的那块。
 */
export function visibleRect(rects: ArrayLike<Rect4> | null | undefined, visible: Rect4): Rect4 | null {
  const kept = visibleRects(rects, visible);
  return unionRects(kept);
}

/**
 * 只保留与"可见窗口"相交的矩形，**逐段返回**（不做并集）。
 *
 * 用于**手柄定位**：并集后的包围盒横跨多列，取首/末矩形会把 Y 落在另一页的行上
 * （用户看到"手柄飘在页边、高度对不上文字"）。先按可见区过滤，再取过滤后的
 * 首/末段，才是当前可见页上真正的首行/末行片段。
 *
 * 泛型是为了把 `DOMRect` 原样传出去（手柄还要用 height / width，Rect4 上没有）。
 */
export function visibleRects<T extends Rect4>(
  rects: ArrayLike<T> | null | undefined,
  visible: Rect4,
): T[] {
  const kept: T[] = [];
  if (!rects) return kept;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (!r) continue;
    if (r.right <= r.left || r.bottom <= r.top) continue;
    if (!rectsIntersect(r, visible)) continue;
    kept.push(r);
  }
  return kept;
}

/* ==================== 选区延长 ==================== */

/** 找到 (container, offset) 之后的第一个非空文本节点 */
export function findNextTextNode(doc: Document, container: Node, offset: number): Text | null {
  const body = doc?.body;
  if (!body) return null;
  if (container.nodeType === 3) {
    const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    try {
      walker.currentNode = container as Text;
    } catch {
      return null;
    }
    let n = walker.nextNode() as Text | null;
    while (n && n.length === 0) n = walker.nextNode() as Text | null;
    return n ?? null;
  }
  // 容器是元素：在它之后找第一个文本节点
  let range: Range;
  try {
    range = doc.createRange();
    range.setStart(container, offset);
    range.setEnd(body, body.childNodes.length);
  } catch {
    return null;
  }
  const walker = doc.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
  let n = walker.nextNode() as Text | null;
  while (n) {
    if (n.length > 0 && range.intersectsNode(n)) return n;
    n = walker.nextNode() as Text | null;
  }
  return null;
}

/** 找到 (container, offset) 之前的最后一个非空文本节点 */
export function findPrevTextNode(doc: Document, container: Node, offset: number): Text | null {
  const body = doc?.body;
  if (!body) return null;
  if (container.nodeType === 3) {
    const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    try {
      walker.currentNode = container as Text;
    } catch {
      return null;
    }
    let n = walker.previousNode() as Text | null;
    while (n && n.length === 0) n = walker.previousNode() as Text | null;
    return n ?? null;
  }
  let range: Range;
  try {
    range = doc.createRange();
    range.setStart(body, 0);
    range.setEnd(container, offset);
  } catch {
    return null;
  }
  const walker = doc.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  let n = walker.nextNode() as Text | null;
  while (n) {
    if (n.length > 0 && range.intersectsNode(n)) last = n;
    n = walker.nextNode() as Text | null;
  }
  return last;
}

/**
 * 把 Range 的**末端**沿 DOM 顺序向后推进最多 chars 个字符。
 * 返回 true 表示确实推进了（末端位置变了）。
 *
 * 用途：拖到页边自动翻页后，把选区从"本页末尾"续到"下一页开头"——
 *       DOM 顺序 == 分栏顺序，所以推进几个字符就等于跨过栏断。
 */
export function extendRangeForward(doc: Document, range: Range, chars: number): boolean {
  if (!doc || !range || chars <= 0) return false;
  const endNode = range.endContainer;
  const endOffset = range.endOffset;

  // ① 末端所在文本节点还有剩余字符
  if (endNode.nodeType === 3) {
    const t = endNode as Text;
    const avail = t.length - endOffset;
    if (avail > 0) {
      const take = Math.min(avail, chars);
      range.setEnd(t, endOffset + take);
      if (take >= chars) return true;
      chars -= take;
    }
  }
  // ② 推进到后续文本节点
  let node = findNextTextNode(doc, endNode, endOffset);
  while (node && chars > 0) {
    const take = Math.min(node.length, chars);
    range.setEnd(node, take);
    chars -= take;
    if (chars > 0) node = findNextTextNode(doc, node, node.length);
  }
  return true;
}

/**
 * 把 Range 的**起点**沿 DOM 顺序向前退最多 chars 个字符。
 * 返回 true 表示确实退回了（起点位置变了）。
 */
export function extendRangeBackward(doc: Document, range: Range, chars: number): boolean {
  if (!doc || !range || chars <= 0) return false;
  const startNode = range.startContainer;
  const startOffset = range.startOffset;

  // ① 起点所在文本节点前面还有字符
  if (startNode.nodeType === 3) {
    const t = startNode as Text;
    if (startOffset > 0) {
      const take = Math.min(startOffset, chars);
      range.setStart(t, startOffset - take);
      if (take >= chars) return true;
      chars -= take;
    }
  }
  // ② 退到前面的文本节点
  let node = findPrevTextNode(doc, startNode, startOffset);
  while (node && chars > 0) {
    const take = Math.min(node.length, chars);
    range.setStart(node, node.length - take);
    chars -= take;
    if (chars > 0) node = findPrevTextNode(doc, node, 0);
  }
  return true;
}

/* ==================== 边缘判定 ==================== */

/** 边缘判定结果 */
export type EdgeSide = "prev" | "next";

/**
 * 判断指针（iframe 局部 x 坐标）是否越过了当前可见列的边界。
 *
 * 注意：这里的"边缘"是**可视窗口**的边缘，触发带从窗口边缘往里量 `edgeZone`。
 * 划词手柄的页边翻页不用它 —— 分页模式下 foliate 在 `#container` 里还自带页边距，
 * 窗口边缘比**文字列**右缘再往外 70~90px，从窗口往里量的带子落在文字之外，
 * 手柄贴在文字末端根本进不了带。那条规则见 `inPageMarginBand`。
 *
 * @param localX        指针在 iframe 内的局部 x
 * @param visibleLeft   当前可见列左边界（iframe 局部 x）
 * @param visibleRight  当前可见列右边界（iframe 局部 x）
 * @param edgeZone      边缘触发带宽度（px）
 * @returns 越过的方向；没越过返回 null
 */
export function detectEdge(
  localX: number,
  visibleLeft: number,
  visibleRight: number,
  edgeZone: number
): EdgeSide | null {
  if (edgeZone <= 0) return null;
  if (localX <= visibleLeft + edgeZone) return "prev";
  if (localX >= visibleRight - edgeZone) return "next";
  return null;
}

/** 页边带的物理侧（不是逻辑翻页方向 —— RTL 书里末端手柄在左侧，侧别由调用方换算好） */
export type MarginSide = "left" | "right";

/**
 * 指针 x 是否落在**页边带**里：文字列边缘与可视窗口边缘之间的那段留白。
 *
 * 与 `detectEdge` 的区别是基准：这条把带子的内沿钉在文字列边缘上（往外扩到窗口边缘），
 * 所以"把手柄拖过文字末端"就等价于"进入页边带"；触发点由文字列边缘决定，
 * `tol`（调用方的 EDGE_TURN_TOL）只是贴边时的容差，不再是带子宽度。
 *
 * @param x        指针 x（与下面两个参数同一坐标空间）
 * @param textEdge 该侧的文字列边缘
 * @param winEdge  该侧的可视窗口边缘
 * @param side     "right"：带子 = [textEdge, winEdge]；"left"：带子 = [winEdge, textEdge]
 * @param tol      容差（px）。手柄本就画在文字末端上，不给容差会出现"看得见却进不去"
 * @returns 是否在带内；文字列与窗口重合（退化）时返回 false，避免整页都能触发
 */
export function inPageMarginBand(
  x: number,
  textEdge: number,
  winEdge: number,
  side: MarginSide,
  tol = 4
): boolean {
  const lo = side === "right" ? textEdge : winEdge;
  const hi = side === "right" ? winEdge : textEdge;
  if (!(hi > lo)) return false;
  return x >= lo - tol && x <= hi + tol;
}
