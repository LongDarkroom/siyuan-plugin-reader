/**
 * 目录树纯函数层（2026-10-15 目录折叠 + 长列表方案 · 档 A）
 * =================================================================
 * 真源仍是**平坦数组** `TocItem[]`（`book-doc.ts:47`）：EPUB/MOBI 由
 * `flattenFoliateToc()`（`adapters/foliate-open.ts:27-39`）把 foliate 嵌套 toc 展平，
 * PDF 由 `pdf-outline.ts` 直接产出带 level 的平坦列表。平坦形状有 6 个消费方
 * （进度条刻度 / 页眉章节名 / 已读统计 / 批注导出 / 双语 prompt / goToc），
 * **一律不动**——层级关系在这一层按 `level` 无损重建，只在目录面板里用。
 *
 * 节点 id = 平坦数组下标（同一本书加载期内稳定），不用 href：
 * PDF 解析不出页码的节点 href 是空串（`pdf-outline.ts:101`），多条即触发
 * Svelte keyed each 重复 key（旧模板 RV:10242 就有这个隐患）。
 *
 * 折叠只影响**渲染**：`visibleRows()` 不输出被收起节点的子树 ⇒ DOM 行数随折叠收缩，
 * 配合行级 `content-visibility: auto`（浏览器原生虚拟渲染）解决长书目录的渲染成本。
 */

import type { TocItem } from "./book-doc.ts";

export interface TocNode {
  /** = 平坦数组下标，折叠状态与 keyed each 都用它 */
  id: number;
  title: string;
  href: string;
  level: number;
  children: TocNode[];
}

export interface TocRow {
  node: TocNode;
  /** 渲染缩进用（= node.level，与旧模板 `padding-left: level*12+4` 口径一致） */
  depth: number;
}

/**
 * 栈式重建，O(n)。输入是合法先序序列（展平的产物天然是）。
 * 容错：level 跳变（0→3）时中间没有实体父节点，直接挂到最近的 level 更小者；
 * 首条就 level>0 亦同样落到根，不崩、不丢行。
 */
export function buildTocTree(items: TocItem[]): TocNode[] {
  const roots: TocNode[] = [];
  if (!Array.isArray(items)) return roots;
  const stack: TocNode[] = [];
  items.forEach((it, id) => {
    const node: TocNode = { id, title: it?.title ?? "", href: it?.href ?? "", level: it?.level ?? 0, children: [] };
    while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(node);
    else roots.push(node);
    stack.push(node);
  });
  return roots;
}

/**
 * 可见行 = 深度优先展开、但**跳过 collapsed 节点的整段子树**。
 * `collapsed` 为空（默认）时输出顺序 === 平坦数组顺序 ⇒ 默认观感与改造前完全一致。
 */
export function visibleRows(roots: TocNode[], collapsed: Set<number>): TocRow[] {
  const out: TocRow[] = [];
  const walk = (n: TocNode): void => {
    out.push({ node: n, depth: n.level });
    if (collapsed?.has(n.id)) return;
    for (const c of n.children) walk(c);
  };
  for (const r of roots) walk(r);
  return out;
}

/** 某节点的祖先 id 链（不含自身）；找不到返回空数组。用于「打开目录即见当前章」。 */
export function ancestorIdsOf(roots: TocNode[], id: number): number[] {
  const found: number[] = [];
  const dfs = (n: TocNode, trail: number[]): boolean => {
    if (n.id === id) {
      found.push(...trail);
      return true;
    }
    for (const c of n.children) {
      if (dfs(c, [...trail, n.id])) return true;
    }
    return false;
  };
  for (const r of roots) {
    if (dfs(r, [])) break;
  }
  return found;
}

/** 按 href 取平坦下标（= 节点 id）；href 空串或不存在返回 -1。 */
export function tocIndexByHref(items: TocItem[], href: string): number {
  if (!href) return -1;
  return items.findIndex((it) => it?.href === href);
}
