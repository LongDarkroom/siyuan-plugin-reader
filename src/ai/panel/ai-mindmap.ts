/**
 * AI 阅读面板 · 思维导图（P3）
 * ------------------------------------------------------------------
 * 三件事，全部是纯逻辑（不碰 DOM / 网络 / Svelte）：
 *  ① 识别回答里的 ```mindmap 围栏，把正文切成「Markdown / 导图」片段；
 *  ② 把 Markdown 大纲（标题 + 嵌套列表）解析成节点树；
 *  ③ 把节点树排成 SVG 坐标（含折叠与标签换行），组件只负责画。
 * 另有两块给组件用的数学：视口（缩放/平移/适应，公式对齐思源内核导图）
 * 与「复制成思源思维导图块」的 kramdown 序列化。
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
    // 块尾 IAL（{: …}）不是节点：复制成导图再粘回来时不能多出一个幽灵节点
    if (/^\s*\{:.*\}\s*$/.test(raw)) continue;
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

/* ============================ 文字度量 ============================ */

export type MindmapMeasurer = (text: string) => number;

const LABEL_FONT = 12;
/**
 * 宽字符（占满一个字框）：中日韩、全角标点，外加箭头/带圈数字/几何符号——
 * 这些在导图标签里很常见（「船上闲聊 → 决定远航」），按半宽算会让盒宽偏小。
 */
const WIDE_RE = /[\u1100-\u115f\u2e80-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef\u2190-\u21ff\u2460-\u24ff\u25a0-\u25ff\u2b00-\u2bff\u3000-\u303f]/;

const num = (value: unknown, fallback = 0): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * 无 DOM（单测/SSR）时的估算：宽字符按 1em，其余 0.55em。
 * 浏览器里组件会传 canvas.measureText 的真实度量进来——盒宽由文字实测决定，
 * 估算只会让盒子略宽或略窄，不再出现「文字出框」。
 */
export const heuristicMindmapWidth: MindmapMeasurer = (text) => {
  let total = 0;
  for (const ch of Array.from(String(text || ""))) {
    total += WIDE_RE.test(ch) ? LABEL_FONT : LABEL_FONT * 0.55;
  }
  return total;
};

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
  gapX?: number;
  gapY?: number;
  padding?: number;
  /** 每个节点最多显示几行文字（1–2） */
  maxLines?: number;
  /** 文字宽度实测；缺省用 heuristicMindmapWidth */
  measure?: MindmapMeasurer;
  /** 换行预算：单行最大宽度（默认 190px ≈ 15 个汉字） */
  labelMaxWidth?: number;
  /** 盒宽上下限（默认 96–260） */
  minNodeWidth?: number;
  maxNodeWidth?: number;
  /** 盒内左右内边距合计（默认 20） */
  labelPadX?: number;
  /** 折叠徽标「−/＋」预留宽度（默认 26） */
  badgeWidth?: number;
}

const GAP_X = 40;
const GAP_Y = 10;
const PADDING = 14;
const LABEL_MAX_WIDTH = 190;
const MIN_NODE_W = 96;
const MAX_NODE_W = 260;
const LABEL_PAD_X = 20;
const BADGE_W = 26;

/**
 * 标签换行：逐字累加实测宽度，超过 `maxWidth` 换行；超过 `maxLines` 截断加省略号。
 * 省略号记在行内，盒宽按产出的行实测 → 盒永远比文字宽，不会出框。
 */
export function wrapMindmapLabel(
  text: string,
  maxWidth = LABEL_MAX_WIDTH,
  maxLines = 2,
  measure: MindmapMeasurer = heuristicMindmapWidth,
): string[] {
  const chars = Array.from(String(text || "").trim());
  const limit = Math.max(24, Math.round(Number(maxWidth) || LABEL_MAX_WIDTH));
  const lines = Math.max(1, Math.min(2, Math.round(Number(maxLines) || 2)));
  if (!chars.length) return [""];
  const out: string[] = [];
  let line = "";
  let used = 0;
  let truncated = false;
  for (let i = 0; i < chars.length; i++) {
    const w = measure(chars[i]);
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

interface LayoutMeta {
  node: MindmapNode;
  id: string;
  depth: number;
  parentId?: string;
  lines: string[];
  w: number;
  h: number;
  x: number;
  y: number;
  kids: LayoutMeta[];
}

/**
 * 节点树 → SVG 坐标（左→右生长）。两遍走：
 *  ① 自顶向下按内容实测算出每个盒子的宽高（列宽不再是定值，文字必在框内）；
 *  ② 列宽取该层最宽的盒子，x 按列推进；纵向叶子按游标排、父节点居中于首末子节点。
 */
export function layoutMindmap(root: MindmapNode, opts: MindmapLayoutOptions = {}): MindmapLayout {
  const collapsed = new Set((opts.collapsed || []).map(String));
  const gapX = Math.max(16, Math.round(num(opts.gapX, GAP_X)));
  const gapY = Math.max(4, Math.round(num(opts.gapY, GAP_Y)));
  const padding = Math.max(0, Math.round(num(opts.padding, PADDING)));
  const maxLines = Math.max(1, Math.min(2, Math.round(num(opts.maxLines, 2))));
  const measure = typeof opts.measure === "function" ? opts.measure : heuristicMindmapWidth;
  const labelMaxWidth = Math.max(24, Math.round(num(opts.labelMaxWidth, LABEL_MAX_WIDTH)));
  const minW = Math.max(48, Math.round(num(opts.minNodeWidth, MIN_NODE_W)));
  const maxW = Math.max(minW, Math.round(num(opts.maxNodeWidth, MAX_NODE_W)));
  const padX = Math.max(4, Math.round(num(opts.labelPadX, LABEL_PAD_X)));
  const badge = Math.max(0, Math.round(num(opts.badgeWidth, BADGE_W)));

  const metas: LayoutMeta[] = [];
  const build = (
    node: MindmapNode,
    depth: number,
    parentId: string | undefined,
    id: string,
  ): LayoutMeta => {
    const lines = wrapMindmapLabel(node.text, labelMaxWidth, maxLines, measure);
    const widest = lines.reduce((mx, ln) => Math.max(mx, measure(ln)), 0);
    const reserve = padX + (node.children.length ? badge : 0);
    const w = Math.min(maxW, Math.max(minW, Math.ceil(widest) + reserve));
    const self: LayoutMeta = {
      node,
      id,
      depth,
      parentId,
      lines,
      w,
      h: lines.length > 1 ? 48 : 36,
      x: 0,
      y: 0,
      kids: [],
    };
    metas.push(self);
    if (!collapsed.has(id)) {
      node.children.forEach((child, i) => self.kids.push(build(child, depth + 1, id, `${id}.${i}`)));
    }
    return self;
  };
  build(root, 0, undefined, "0");

  const colW: number[] = [];
  for (const m of metas) colW[m.depth] = Math.max(colW[m.depth] || 0, m.w);
  const colX: number[] = [];
  let acc = padding;
  for (let d = 0; d < colW.length; d++) {
    colX[d] = acc;
    acc += colW[d] + gapX;
  }

  const nodes: MindmapLayoutNode[] = [];
  const edges: MindmapEdge[] = [];
  let cursor = padding;

  const place = (m: LayoutMeta): void => {
    for (const k of m.kids) place(k);
    if (!m.kids.length) {
      m.y = cursor;
      cursor += m.h + gapY;
    } else {
      const first = m.kids[0];
      const last = m.kids[m.kids.length - 1];
      m.y = (first.y + first.h / 2 + last.y + last.h / 2) / 2 - m.h / 2;
    }
    m.x = colX[m.depth] ?? padding;
    const isCollapsed = collapsed.has(m.id) && m.node.children.length > 0;
    nodes.push({
      id: m.id,
      text: m.node.text,
      lines: m.lines,
      x: m.x,
      y: m.y,
      w: m.w,
      h: m.h,
      depth: m.depth,
      parentId: m.parentId,
      hasChildren: m.node.children.length > 0,
      collapsed: isCollapsed,
      ref: m.node.ref,
    });
    // 只连可见子节点；曲线从父右缘到子左缘
    for (const k of m.kids) {
      const x1 = m.x + m.w;
      const y1 = m.y + m.h / 2;
      const x2 = k.x;
      const y2 = k.y + k.h / 2;
      const mx = (x1 + x2) / 2;
      edges.push({ from: m.id, to: k.id, d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}` });
    }
  };
  place(metas[0]);

  let maxRight = padding;
  for (const m of metas) maxRight = Math.max(maxRight, m.x + m.w);
  nodes.sort((a, b) => a.depth - b.depth || a.y - b.y);
  const width = maxRight + padding;
  const height = Math.max(cursor - gapY + padding, padding * 2 + 36);
  return { nodes, edges, width, height };
}

/** 当前可见节点数（折叠的子树不计）——标题栏的「N 个节点」用，不必为了计数排一遍版 */
export function countVisibleMindmapNodes(root: MindmapNode, collapsed: string[] = []): number {
  const set = new Set((collapsed || []).map(String));
  let n = 0;
  const walk = (node: MindmapNode, id: string) => {
    n++;
    if (set.has(id)) return;
    node.children.forEach((c, i) => walk(c, `${id}.${i}`));
  };
  walk(root, "0");
  return n;
}

/** 折叠到第 depth 级（1 起）：返回该深度以下、且有子节点的节点 id；depth<=0 表示全展开 */
export function foldMindmapByDepth(root: MindmapNode, depth: number): string[] {
  const level = Math.round(Number(depth));
  if (!Number.isFinite(level) || level <= 0) return [];
  const ids: string[] = [];
  const walk = (node: MindmapNode, d: number, id: string) => {
    if (d >= level && node.children.length) ids.push(id);
    node.children.forEach((c, i) => walk(c, d + 1, `${id}.${i}`));
  };
  walk(root, 0, "0");
  return ids;
}

/* ============================ 视口 ============================ */

export interface MindmapViewport {
  /** 缩放比例 */
  s: number;
  /** 平移量（屏幕像素，已含缩放） */
  ox: number;
  oy: number;
}

/** 视野盒：容器尺寸 + 未缩放的整图尺寸 */
export interface MindmapViewBox {
  viewW: number;
  viewH: number;
  contentW: number;
  contentH: number;
}

export const MINDMAP_MIN_SCALE = 0.15;
export const MINDMAP_MAX_SCALE = 2.5;
/** 滚轮缩放速率：与思源内核 mindmap 的 `scale * Math.exp(-delta * 0.01)` 一致 */
export const MINDMAP_WHEEL_RATE = 0.01;
/** 平移边界：内容至少留这么多像素在视野里，防止一甩就甩丢 */
export const MINDMAP_PAN_KEEP = 60;

export function clampMindmapScale(value: number): number {
  const s = num(value, 1);
  return Math.min(MINDMAP_MAX_SCALE, Math.max(MINDMAP_MIN_SCALE, s));
}

/** 滚轮增量 → 新缩放（先夹紧 deltaY，触控板惯性大值不至于一次翻档） */
export function mindmapWheelScale(scale: number, deltaY: number): number {
  const d = Math.max(-100, Math.min(100, num(deltaY)));
  return clampMindmapScale(clampMindmapScale(scale) * Math.exp(-d * MINDMAP_WHEEL_RATE));
}

/** 跟着指针缩放，保持 (px,py) 处的内容点不动；同思源内核 zoomAt 的公式 */
export function zoomMindmapAt(vp: MindmapViewport, nextScale: number, px: number, py: number): MindmapViewport {
  const s = clampMindmapScale(vp.s);
  const ns = clampMindmapScale(nextScale);
  if (ns === s) return { s, ox: num(vp.ox), oy: num(vp.oy) };
  const k = ns / s;
  return { s: ns, ox: num(px) - (num(px) - num(vp.ox)) * k, oy: num(py) - (num(py) - num(vp.oy)) * k };
}

/** 夹紧平移：内容比视野大时两端各留 keep 可见；比视野小时贴左上，不许拖进空白里漂 */
export function boundedMindmapPan(vp: MindmapViewport, box: MindmapViewBox, keep = MINDMAP_PAN_KEEP): MindmapViewport {
  const s = clampMindmapScale(vp.s);
  const bound = (offset: number, view: number, content: number) => {
    const v = Math.max(1, num(view, 1));
    const c = Math.max(0, num(content)) * s;
    if (c <= v) return 0;
    return Math.min(v - Math.min(keep, v), Math.max(Math.min(keep, c) - c, offset));
  };
  return {
    s,
    ox: bound(num(vp.ox), box.viewW, box.contentW),
    oy: bound(num(vp.oy), box.viewH, box.contentH),
  };
}

/** 适应画布：缩到能看全整图；上限 1:1（小图不硬放大，免得发糊） */
export function fitMindmapViewport(box: MindmapViewBox, pad = 8): MindmapViewport {
  const vw = Math.max(1, Math.max(1, num(box.viewW, 1)) - pad * 2);
  const vh = Math.max(1, Math.max(1, num(box.viewH, 1)) - pad * 2);
  const cw = Math.max(1, num(box.contentW, 1));
  const ch = Math.max(1, num(box.contentH, 1));
  const s = clampMindmapScale(Math.min(1, Math.min(vw / cw, vh / ch)));
  return { s, ox: pad + Math.max(0, (vw - cw * s) / 2), oy: pad + Math.max(0, (vh - ch * s) / 2) };
}

/** 适应宽度：只保证横向看全，纵向居中或顶格（宽图看骨架） */
export function fitMindmapWidth(box: MindmapViewBox, pad = 8): MindmapViewport {
  const vw = Math.max(1, Math.max(1, num(box.viewW, 1)) - pad * 2);
  const vh = Math.max(1, num(box.viewH, 1));
  const ch = Math.max(1, num(box.contentH, 1));
  const s = clampMindmapScale(Math.min(1, vw / Math.max(1, num(box.contentW, 1))));
  return { s, ox: pad, oy: ch * s <= vh ? pad + (vh - ch * s) / 2 : pad };
}

/** 默认视口：1:1（字能读），左上起排、图比视野矮时垂直居中——靠拖动看全图 */
export function resetMindmapViewport(box: MindmapViewBox, pad = 8): MindmapViewport {
  const vh = Math.max(1, num(box.viewH, 1));
  const ch = Math.max(1, num(box.contentH, 1));
  return { s: 1, ox: pad, oy: ch <= vh ? pad + (vh - ch) / 2 : pad };
}

/** 把某个节点挪到视野中心（键盘导航/搜索定位用） */
export function centerMindmapOn(
  vp: MindmapViewport,
  viewW: number,
  viewH: number,
  cx: number,
  cy: number,
): MindmapViewport {
  const s = clampMindmapScale(vp.s);
  return {
    s,
    ox: (Number(viewW) || 0) / 2 - cx * s,
    oy: (Number(viewH) || 0) / 2 - cy * s,
  };
}

/* ============================ 复制成思源思维导图块 ============================ */

/**
 * 思源「思维导图块」的可达形态：**普通列表 + IAL `custom-sy-list-mindmap="1"`**。
 * （旧 `type=mindmap` 那种块的 IAL 只有宽高，Markdown 里表达不出来，别往那条路上走。）
 * 尾行 `{: …}` 是块的 IAL，Lute 需要 `SetKramdownIAL(true)` 才认——思源正文粘贴走的
 * protyle lute 恰好开着这个开关，2026-11-08 真机验证：粘进文档直接成导图。
 */
export const MINDMAP_LIST_IAL = "custom-sy-list-mindmap";

/** 块引用文字进了 `((id "文字"))` 就要避开会截断解析的引号与括号 */
function refDisplayText(text: string): string {
  return String(text || "")
    .replace(/["“”]/g, "'")
    .replace(/[()[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 行首的列表符号/序号会被 Lute 当成子列表（凭空多一层），用反斜杠转义掉 */
function escapeItemStart(text: string): string {
  return text
    .replace(/^([-*+])(?=\s)/, "\\$1")
    .replace(/^(\d+)([.)])(?=\s)/, "$1\\$2");
}

function kramdownLine(node: MindmapNode): string {
  const text = String(node.text || "").replace(/\s+/g, " ").trim();
  if (node.ref) {
    const display = refDisplayText(text);
    return display ? `((${node.ref} "${display}"))` : `((${node.ref}))`;
  }
  return escapeItemStart(text);
}

/** 节点树 → 可粘贴的 kramdown（嵌套列表 + 导图 IAL） */
export function mindmapToKramdown(root: MindmapNode, indentStep = 2): string {
  const step = " ".repeat(Math.max(2, Math.min(4, Math.round(Number(indentStep) || 2))));
  const lines: string[] = [];
  const walk = (node: MindmapNode, depth: number) => {
    lines.push(`${step.repeat(depth)}- ${kramdownLine(node)}`);
    for (const child of node.children) walk(child, depth + 1);
  };
  walk(root, 0);
  return `${lines.join("\n")}\n{: ${MINDMAP_LIST_IAL}="1"}`;
}
