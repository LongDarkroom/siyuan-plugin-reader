/**
 * AI 阅读面板 · 思维导图（P3）
 * ------------------------------------------------------------------
 * 三件事，全部是纯逻辑（不碰 DOM / 网络 / Svelte）：
 *  ① 识别回答里的 ```mindmap 围栏，把正文切成「Markdown / 导图」片段；
 *  ② 把 Markdown 大纲（标题 + 嵌套列表）解析成节点树；
 *  ③ 把节点树排成 SVG 坐标（含折叠与标签换行），组件只负责画。
 *
 * 导图语法刻意选 Markdown 本身：模型不必学新 DSL，列表缩进就是层级；
 * 节点里出现思源块引用 `((id "文本"))` / `[文本](siyuan://blocks/id)` 时，
 * 记录 ref 供点击打开，标签只保留可读文字。
 */

export interface MindmapNode {
  text: string;
  children: MindmapNode[];
  /** 思源块 ID：点击节点可打开对应块 */
  ref?: string;
}

export interface MindmapParseOptions {
  /** 最多保留几层（含根），默认 6 */
  maxDepth?: number;
  /** 最多保留多少个节点，默认 160 */
  maxNodes?: number;
  /** 只收标题/列表，跳过普通段落（回答大纲模式） */
  structureOnly?: boolean;
  /** 至少多少个节点才算成图（默认 1） */
  minNodes?: number;
  /** 没有自然根节点时的合成根标题 */
  fallbackTitle?: string;
}

export const MINDMAP_MAX_NODES = 160;
export const MINDMAP_MAX_DEPTH = 6;
export const MINDMAP_MAX_TEXT = 160;

/** 空状态快捷提问：让模型按可解析的语法输出 */
export const MINDMAP_QUICK_ASK =
  "用 ```mindmap 代码块画出本章的思维导图：块内第一行写中心主题，其余用 Markdown 列表表示层级，最多 3 层、12 个节点；每个节点不超过 20 字。";

/** 系统提示词里的一行约定（用户临时说「画成导图」时也能看懂） */
export const MINDMAP_SYNTAX_HINT =
  "需要画思维导图或梳理结构时，用一个 ```mindmap 围栏代码块：第一行写中心主题，其余用 Markdown 列表表示层级。";

interface RawRow {
  text: string;
  depth: number;
  ref?: string;
}

/* ============================ 文本清理 ============================ */

function headingOf(line: string): { level: number; text: string } | null {
  const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
  return m ? { level: m[1].length, text: m[2] } : null;
}

function bulletOf(line: string): { indent: number; text: string } | null {
  const m = line.match(/^([ \t]*)(?:[-*+]|\d+[.)])\s+(.+)$/);
  if (!m) return null;
  return { indent: indentWidth(m[1]), text: m[2].replace(/^\[[ xX]\]\s+/, "") };
}

function indentWidth(s: string): number {
  let n = 0;
  for (const ch of s) n += ch === "\t" ? 2 : 1;
  return n;
}

function stripCommonIndent(src: string): string[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  let min = Infinity;
  for (const line of lines) {
    if (!line.trim()) continue;
    min = Math.min(min, indentWidth((line.match(/^[ \t]*/) || [""])[0]));
  }
  if (!Number.isFinite(min) || min <= 0) return lines;
  return lines.map((line) => {
    const lead = (line.match(/^[ \t]*/) || [""])[0];
    return line.slice(Math.min(lead.length, min));
  });
}

/** 抽出块引用并清掉 Markdown 装饰；ref 只保留第一个 */
export function cleanMindmapText(raw: string): { text: string; ref?: string } {
  let s = String(raw || "");
  let ref = "";
  let display = "";

  s = s.replace(/\[([^\]]*)\]\(\s*siyuan:\/\/blocks?\/([\w-]{8,})[^)]*\)/gi, (_m, txt: string, id: string) => {
    if (!ref) ref = id;
    return txt || "";
  });
  s = s.replace(/siyuan:\/\/blocks?\/([\w-]{8,})/gi, (_m, id: string) => {
    if (!ref) ref = id;
    return "";
  });
  s = s.replace(/\(\(\s*([\w-]{8,})\s+"([^"]*)"\s*\)\)/g, (_m, id: string, txt: string) => {
    if (!ref) ref = id;
    if (txt) display = txt;
    return " ";
  });
  s = s.replace(/\(\(\s*([\w-]{8,})\s*\)\)/g, (_m, id: string) => {
    if (!ref) ref = id;
    return " ";
  });

  s = s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/==(.*?)==/g, "$1")
    .replace(/`+([^`]+)`+/g, "$1")
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, "$1")
    .replace(/^#{1,6}\s+/, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!s) s = display.trim();
  if (!s) return { text: ref ? "引用块" : "", ref: ref || undefined };
  if (s.length > MINDMAP_MAX_TEXT) s = s.slice(0, MINDMAP_MAX_TEXT - 1) + "…";
  return { text: s, ref: ref || undefined };
}

/* ============================ 解析 ============================ */

function collectRows(src: string, opts: MindmapParseOptions): RawRow[] {
  const maxDepth = Math.max(1, Math.round(Number(opts.maxDepth) || MINDMAP_MAX_DEPTH));
  const structureOnly = !!opts.structureOnly;
  const lines = stripCommonIndent(src);

  // 先找结构行，决定解析模式（标题 / 列表 / 缩进大纲）
  const structural: Array<
    | { kind: "heading"; level: number; text: string; indent: number }
    | { kind: "bullet"; level: 0; text: string; indent: number }
    | { kind: "plain"; level: 0; text: string; indent: number }
  > = [];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const line = raw.replace(/^\s*(?:>\s*)+/, "");
    const h = headingOf(line);
    if (h) {
      structural.push({ kind: "heading", level: h.level, text: h.text, indent: 0 });
      continue;
    }
    const b = bulletOf(line);
    if (b) {
      structural.push({ kind: "bullet", level: 0, text: b.text, indent: b.indent });
      continue;
    }
    if (!structureOnly) {
      const lead = (line.match(/^[ \t]*/) || [""])[0];
      structural.push({ kind: "plain", level: 0, text: line, indent: indentWidth(lead) });
    }
  }
  if (!structural.length) return [];

  const first = structural[0];
  const mode: "heading" | "list" | "plain" =
    first.kind === "heading" ? "heading" : first.kind === "bullet" ? "list" : "plain";
  const firstHeadingLevel = first.kind === "heading" ? first.level : 0;
  const baseIndent = first.kind === "plain" || first.kind === "bullet" ? first.indent : 0;
  const bulletBase = structural.reduce(
    (min, item) => (item.kind === "bullet" ? Math.min(min, item.indent) : min),
    Infinity,
  );

  let headingDepth = -1;
  const rows: RawRow[] = [];
  for (let i = 0; i < structural.length; i++) {
    const item = structural[i];
    if (item.kind === "heading") {
      const d = Math.max(0, item.level - firstHeadingLevel);
      headingDepth = d;
      rows.push({ ...cleanMindmapText(item.text), depth: Math.min(d, maxDepth - 1) });
      continue;
    }
    const base = item.kind === "bullet" ? (Number.isFinite(bulletBase) ? bulletBase : item.indent) : baseIndent;
    const units = Math.max(0, Math.floor((item.indent - base) / 2));
    let depth: number;
    if (mode === "heading") depth = headingDepth + 1 + units;
    else if (mode === "list") depth = units;
    else if (i === 0) depth = 0;
    else depth = item.kind === "bullet" ? 1 + units : Math.max(1, units);
    rows.push({ ...cleanMindmapText(item.text), depth: Math.min(depth, maxDepth - 1) });
  }
  return rows.filter((r) => r.text);
}

function makeNode(row: RawRow): MindmapNode {
  return { text: row.text, children: [], ...(row.ref ? { ref: row.ref } : {}) };
}

/** Markdown（标题 + 嵌套列表 + 缩进大纲）→ 节点树；无有效结构返回 null */
export function parseMindmapMarkdown(src: string, opts: MindmapParseOptions = {}): MindmapNode | null {
  const maxNodes = Math.max(1, Math.round(Number(opts.maxNodes) || MINDMAP_MAX_NODES));
  const maxDepth = Math.max(1, Math.round(Number(opts.maxDepth) || MINDMAP_MAX_DEPTH));
  const minNodes = Math.max(1, Math.round(Number(opts.minNodes) || 1));
  const rows = collectRows(src, { ...opts, maxDepth, maxNodes });
  if (!rows.length) return null;

  const topCount = rows.filter((r) => r.depth === 0).length;
  let root: MindmapNode;
  let rest: RawRow[];

  if (topCount === 0) {
    const title = cleanMindmapText(opts.fallbackTitle || "思维导图").text || "思维导图";
    root = { text: title, children: [] };
    rest = rows;
  } else if (topCount === 1) {
    root = makeNode(rows[0]);
    rest = rows.slice(1);
  } else {
    const title = cleanMindmapText(opts.fallbackTitle || "思维导图").text || "思维导图";
    root = { text: title, children: [] };
    rest = rows.map((r) => ({ ...r, depth: r.depth + 1 }));
  }

  let count = 1;
  const stack: Array<{ node: MindmapNode; depth: number }> = [{ node: root, depth: 0 }];
  for (const row of rest) {
    if (count >= maxNodes) break;
    const depth = Math.max(1, Math.min(row.depth, maxDepth - 1));
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
    const parent = stack[stack.length - 1].node;
    const node = makeNode(row);
    parent.children.push(node);
    stack.push({ node, depth });
    count++;
  }

  return count >= minNodes ? root : null;
}

/** 回答大纲 → 导图（只收标题/列表，至少 3 个节点才值得出图） */
export function outlineFromMarkdown(md: string, opts: MindmapParseOptions = {}): MindmapNode | null {
  const body = stripCodeFences(String(md || ""));
  if (!body.trim()) return null;
  return parseMindmapMarkdown(body, {
    maxDepth: 5,
    maxNodes: 80,
    minNodes: 3,
    structureOnly: true,
    fallbackTitle: "回答要点",
    ...opts,
  });
}

/** 去掉围栏代码块（回答大纲模式下不想把代码当结构） */
export function stripCodeFences(md: string): string {
  return String(md || "").replace(/^[ \t]*```[^\n]*\n[\s\S]*?^[ \t]*```[ \t]*$/gm, "");
}

/* ============================ 围栏拆分 ============================ */

export type MindmapSegment =
  | { kind: "html"; markdown: string }
  | { kind: "mindmap"; source: string; root: MindmapNode };

const MINDMAP_FENCE_RE = /^[ \t]*```[ \t]*(mindmap|mmap)[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/gim;

/**
 * 把回答切成可顺序渲染的片段：```mindmap 围栏变成导图，其余仍是 Markdown。
 * 语法无效的围栏原样保留为代码块，避免用户内容凭空消失。
 */
export function splitMindmapSegments(md: string, opts: MindmapParseOptions = {}): MindmapSegment[] {
  const text = String(md || "");
  const out: MindmapSegment[] = [];
  let last = 0;
  MINDMAP_FENCE_RE.lastIndex = 0;
  for (let m = MINDMAP_FENCE_RE.exec(text); m; m = MINDMAP_FENCE_RE.exec(text)) {
    const before = text.slice(last, m.index);
    if (before.trim()) out.push({ kind: "html", markdown: before });
    const source = m[2] || "";
    const root = parseMindmapMarkdown(source, opts);
    if (root) out.push({ kind: "mindmap", source, root });
    else out.push({ kind: "html", markdown: m[0] });
    last = m.index + m[0].length;
  }
  const tail = text.slice(last);
  if (tail.trim() || !out.length) out.push({ kind: "html", markdown: tail });
  // 相邻 Markdown 片段合并，避免模板里出现大量空 div
  const merged: MindmapSegment[] = [];
  for (const seg of out) {
    const prev = merged[merged.length - 1];
    if (seg.kind === "html" && prev && prev.kind === "html") {
      prev.markdown += seg.markdown;
    } else {
      merged.push(seg);
    }
  }
  return merged;
}

/* ============================ 布局 ============================ */

export interface MindmapLayoutNode {
  id: string;
  text: string;
  lines: string[];
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
  parentId?: string;
  hasChildren: boolean;
  collapsed: boolean;
  ref?: string;
}

export interface MindmapEdge {
  from: string;
  to: string;
  d: string;
}

export interface MindmapLayout {
  nodes: MindmapLayoutNode[];
  edges: MindmapEdge[];
  width: number;
  height: number;
}

export interface MindmapLayoutOptions {
  /** 已折叠的节点 id */
  collapsed?: string[];
  nodeWidth?: number;
  gapX?: number;
  gapY?: number;
  padding?: number;
  /** 每个节点最多显示几行文字（1–2） */
  maxLines?: number;
}

const NODE_W = 156;
const GAP_X = 44;
const GAP_Y = 10;
const PADDING = 12;

/**
 * 标签换行：CJK 记 1 个单位，西文/数字约 0.55。
 * 超过两行就截断加省略号（导图节点不是正文，完整文字放在 title）。
 */
export function wrapMindmapLabel(text: string, maxUnits = 15, maxLines = 2): string[] {
  const chars = Array.from(String(text || "").trim());
  const limit = Math.max(4, Math.round(maxUnits));
  const lines = Math.max(1, Math.min(2, Math.round(maxLines)));
  if (!chars.length) return [""];
  const width = (ch: string) => (/[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch) ? 1 : 0.55);
  const out: string[] = [];
  let line = "";
  let used = 0;
  let truncated = false;
  for (let i = 0; i < chars.length; i++) {
    const w = width(chars[i]);
    if (used + w > limit && line) {
      out.push(line);
      line = "";
      used = 0;
      if (out.length === lines) {
        truncated = true;
        break;
      }
    }
    line += chars[i];
    used += w;
  }
  if (!truncated && line) out.push(line);
  if (truncated) {
    const lastLine = out[out.length - 1] || "";
    out[out.length - 1] = lastLine.replace(/…$/, "") + "…";
  }
  return out.slice(0, lines);
}

/** 节点树 → SVG 坐标（左→右生长；父节点垂直居中于首末子节点之间） */
export function layoutMindmap(root: MindmapNode, opts: MindmapLayoutOptions = {}): MindmapLayout {
  const collapsed = new Set((opts.collapsed || []).map(String));
  const nodeW = Math.max(96, Math.round(Number(opts.nodeWidth) || NODE_W));
  const gapX = Math.max(16, Math.round(Number(opts.gapX) || GAP_X));
  const gapY = Math.max(4, Math.round(Number(opts.gapY) || GAP_Y));
  const padding = Math.max(0, Math.round(Number(opts.padding) || PADDING));
  const maxLines = Math.max(1, Math.min(2, Math.round(Number(opts.maxLines) || 2)));

  const nodes: MindmapLayoutNode[] = [];
  const edges: MindmapEdge[] = [];
  let cursor = padding;
  let maxRight = padding;

  const walk = (
    node: MindmapNode,
    depth: number,
    parentId: string | undefined,
    id: string,
  ): MindmapLayoutNode => {
    const lines = wrapMindmapLabel(node.text, 15, maxLines);
    const h = lines.length > 1 ? 48 : 36;
    const isCollapsed = collapsed.has(id) && node.children.length > 0;
    const childNodes: MindmapLayoutNode[] = [];
    if (!isCollapsed) {
      node.children.forEach((child, i) => {
        childNodes.push(walk(child, depth + 1, id, `${id}.${i}`));
      });
    }

    let centerY: number;
    if (!childNodes.length) {
      centerY = cursor + h / 2;
      cursor += h + gapY;
    } else {
      const first = childNodes[0];
      const last = childNodes[childNodes.length - 1];
      centerY = (first.y + first.h / 2 + last.y + last.h / 2) / 2;
    }

    const x = padding + depth * (nodeW + gapX);
    const y = centerY - h / 2;
    const out: MindmapLayoutNode = {
      id,
      text: node.text,
      lines,
      x,
      y,
      w: nodeW,
      h,
      depth,
      parentId,
      hasChildren: node.children.length > 0,
      collapsed: isCollapsed && node.children.length > 0,
      ref: node.ref,
    };
    nodes.push(out);
    maxRight = Math.max(maxRight, x + nodeW);

    // 只连可见子节点；曲线从父右缘到子左缘
    for (const child of childNodes) {
      const x1 = x + nodeW;
      const y1 = y + h / 2;
      const x2 = child.x;
      const y2 = child.y + child.h / 2;
      const mx = (x1 + x2) / 2;
      edges.push({
        from: id,
        to: child.id,
        d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`,
      });
    }
    return out;
  };

  walk(root, 0, undefined, "0");

  const width = maxRight + padding;
  const height = Math.max(cursor - gapY + padding, padding * 2 + 36);
  nodes.sort((a, b) => a.depth - b.depth || a.y - b.y);
  return { nodes, edges, width, height };
}
