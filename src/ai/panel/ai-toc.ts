/**
 * AI 阅读面板 · 目录与范围阅读（P0）
 * ------------------------------------------------------------------
 * 目的：让模型知道「这本书有什么」，用户也能主动圈一段章节让助手读，
 * 而不是每次只塞当前章（读不到前面内容）或整本（爆 token）。
 *
 * 三层：
 *  1. 目录（TOC）：压成编号清单注入系统提示词，编号 = sectionIndex + 1；
 *     太长就截断，并提示可用 `reader_list_toc` 取其余部分。
 *  2. 用户选范围：面板里点两次目录项得到 [from, to]，随本轮请求一次性读取。
 *  3. 范围预算：最多自动读 MAX_RANGE_CHAPTERS 章，字符预算按章均分；
 *     被截断的章在正文里留续读提示，模型可再用工具补读。
 *
 * 刻意不 import Svelte / siyuan：本文件要能在 node 测试里直接跑。
 */

/** AI 侧的目录项：section 是 0 起的章节序号（与 getChapterSnapshot 对齐） */
export interface AiTocItem {
  section: number;
  /** 1 起（ReaderView 的目录 level 从 0 起，归一化时 +1） */
  level: number;
  title: string;
}

/** 闭区间章节范围（0 起，含两端） */
export interface AiReadRange {
  from: number;
  to: number;
}

/** 一次自动注入最多读几章：再多就该让模型按需调工具，而不是整段灌进来 */
export const MAX_RANGE_CHAPTERS = 8;
/** 每章至少留多少字：低于这个数范围阅读没有意义（预算不够就少读几章） */
export const MIN_RANGE_CHAPTER_CHARS = 400;
/** 提示词里的目录：条数与字符双上限（超出部分交给工具按需取） */
export const MAX_TOC_PROMPT_ITEMS = 80;
export const MAX_TOC_PROMPT_CHARS = 1600;
/** 单条目录标题的展示上限（有些书把整段简介塞进目录标题） */
export const MAX_TOC_TITLE_CHARS = 90;

/** 工具 reader_list_toc 一次最多返回多少项 */
export const MAX_TOOL_TOC_ITEMS = 400;

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/**
 * 目录归一化：丢掉解析不出章节号的项、按 section 去重、限长。
 * 输入沿用 ReaderView 的 `{ title, level }`（level 0 起），输出 level 1 起。
 */
export function normalizeTocItems(raw: unknown, max = MAX_TOOL_TOC_ITEMS): AiTocItem[] {
  if (!Array.isArray(raw)) return [];
  const limit = clampInt(max, 1, MAX_TOOL_TOC_ITEMS, MAX_TOOL_TOC_ITEMS);
  const out: AiTocItem[] = [];
  const seen = new Set<number>();
  for (const it of raw) {
    if (!it || typeof it !== "object") continue;
    const section = Math.floor(Number((it as any).section ?? (it as any).sectionIndex));
    if (!Number.isFinite(section) || section < 0 || seen.has(section)) continue;
    const title = String((it as any).title ?? "").replace(/\s+/g, " ").trim();
    if (!title) continue;
    seen.add(section);
    out.push({
      section,
      level: clampInt(Number((it as any).level) + 1, 1, 6, 1),
      title: title.slice(0, MAX_TOC_TITLE_CHARS),
    });
    if (out.length >= limit) break;
  }
  return out;
}

export interface TocPromptResult {
  text: string;
  chars: number;
  shown: number;
  total: number;
  clipped: boolean;
}

/**
 * 目录清单 → 系统提示词块。
 * 编号用 section+1（不是清单位次）：模型据此调 reader_get_chapter/reader_get_range。
 */
export function buildTocPrompt(
  items: AiTocItem[] | null | undefined,
  opts: { maxItems?: number; maxChars?: number } = {},
): TocPromptResult {
  const list = Array.isArray(items) ? items : [];
  const maxItems = clampInt(opts.maxItems, 1, MAX_TOOL_TOC_ITEMS, MAX_TOC_PROMPT_ITEMS);
  const maxChars = clampInt(opts.maxChars, 120, 12000, MAX_TOC_PROMPT_CHARS);
  const header = `【本书目录】共 ${list.length} 项（编号 = sectionIndex + 1；不是每章都有目录项）`;
  const lines: string[] = [header];
  let chars = header.length;
  let shown = 0;
  for (const it of list) {
    if (shown >= maxItems) break;
    const line = `${it.section + 1}. ${"  ".repeat(Math.max(0, (it.level || 1) - 1))}${it.title}`;
    if (shown > 0 && chars + 1 + line.length > maxChars) break;
    lines.push(line);
    chars += 1 + line.length;
    shown++;
  }
  const clipped = shown < list.length;
  if (clipped) {
    const more = `（还有 ${list.length - shown} 项未列出；需要时调用 reader_list_toc）`;
    lines.push(more);
    chars += 1 + more.length;
  }
  lines.push("要读当前章以外的内容：用 reader_get_chapter 读单章，用 reader_get_range 读连续几章；不要凭空概括没读过的章节。");
  const text = lines.join("\n");
  return { text, chars: text.length, shown, total: list.length, clipped };
}

/** 预算下最多自动读几章（至少 1，至多 max） */
export function rangeChapterCap(maxChars: number, max = MAX_RANGE_CHAPTERS): number {
  const budget = Math.max(0, Math.floor(Number(maxChars) || 0));
  const hardCap = clampInt(max, 1, 1000, MAX_RANGE_CHAPTERS);
  const byBudget = Math.max(1, Math.floor(budget / MIN_RANGE_CHAPTER_CHARS));
  return Math.min(hardCap, byBudget);
}

/** 范围归一化：交换倒序、裁到 [0, total-1]；无效返回 null */
export function normalizeReadRange(raw: any, total?: number): AiReadRange | null {
  const a = Math.floor(Number(raw?.from));
  const b = Math.floor(Number(raw?.to));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  let from = Math.min(a, b);
  let to = Math.max(a, b);
  if (from < 0) from = 0;
  if (Number.isFinite(total) && Number(total) > 0) {
    const n = Math.floor(Number(total));
    if (from >= n) return null;
    to = Math.min(to, n - 1);
  }
  return { from, to };
}

export function rangeSpan(range: AiReadRange | null | undefined): number {
  if (!range) return 0;
  return Math.max(0, range.to - range.from + 1);
}

export function isSectionInRange(range: AiReadRange | null | undefined, section: number): boolean {
  if (!range) return false;
  const s = Math.floor(Number(section));
  return Number.isFinite(s) && s >= range.from && s <= range.to;
}

/**
 * 目录里的两次点击：
 *  - 没有范围 → 以该章为起点；
 *  - 已有单章范围且点了别的章 → 扩展成闭区间；
 *  - 已有区间 → 重新以该章为起点（再点一次成新范围）。
 */
export function pickRangeSection(current: AiReadRange | null | undefined, section: number): AiReadRange {
  const s = Math.max(0, Math.floor(Number(section) || 0));
  if (!current) return { from: s, to: s };
  if (current.from === current.to && current.from !== s) {
    return { from: Math.min(current.from, s), to: Math.max(current.from, s) };
  }
  return { from: s, to: s };
}

/** 回执/气泡用文案：第 3 章 / 第 3–5 章 */
export function rangeLabel(range: AiReadRange | null | undefined): string {
  if (!range) return "";
  return range.from === range.to ? `第 ${range.from + 1} 章` : `第 ${range.from + 1}–${range.to + 1} 章`;
}

export interface RangeChapterInput {
  section: number;
  title?: string;
  paragraphs: Array<{ i: number; text: string }>;
  totalParagraphs?: number;
}

export interface RangeContext {
  text: string;
  chars: number;
  paragraphs: number;
  chaptersRead: number;
  /** 因预算/上限没读的章数（由调用方补提示） */
  chaptersDropped: number;
  /** 读到了但段数不完整的章节序号 */
  truncatedChapters: number[];
  truncated: boolean;
}

/**
 * 多章正文 → 一个带章标题与段号的文本块。
 * 预算按剩余章数均分（前面短的章省下的额度自然滚到后面）；
 * 每章被截断时留一句续读提示，保留段落号让模型能引用「第 n 段」。
 */
export function buildRangeContext(
  chapters: RangeChapterInput[] | null | undefined,
  maxChars: number,
): RangeContext {
  const budget = Math.max(500, Math.floor(Number(maxChars) || 0));
  const input = Array.isArray(chapters)
    ? chapters.filter((c) => c && Number.isFinite(Number(c.section)))
    : [];
  const list = input.slice(0, rangeChapterCap(budget));
  const blocks: string[] = [];
  const truncatedChapters: number[] = [];
  let used = 0;
  let paragraphs = 0;

  for (let k = 0; k < list.length; k++) {
    const ch = list[k];
    const section = Math.max(0, Math.floor(Number(ch.section) || 0));
    const left = list.length - k;
    const share = Math.max(1, Math.floor((budget - used) / left));
    const title = String(ch.title || "").replace(/\s+/g, " ").trim();
    const head = `【第 ${section + 1} 章${title ? ` · ${title}` : ""}】`;
    const lines = [head];
    let blockChars = head.length;
    let kept = 0;
    let nextPara = 0;
    const paragraphsIn = Array.isArray(ch.paragraphs) ? ch.paragraphs : [];
    for (const p of paragraphsIn) {
      const text = String(p?.text || "").trim();
      if (!text) continue;
      const line = `[${(Number(p.i) || 0) + 1}] ${text}`;
      if (kept > 0 && blockChars + 1 + line.length > share) break;
      let clipped = line;
      if (blockChars + 1 + line.length > share) {
        const room = share - blockChars - 2;
        if (room <= 0) break;
        clipped = line.slice(0, room) + "…";
      }
      lines.push(clipped);
      blockChars += 1 + clipped.length;
      kept++;
      nextPara = (Number(p.i) || 0) + 1;
    }
    const total = Math.max(kept, Number(ch.totalParagraphs) || paragraphsIn.length || kept);
    if (kept < total) {
      truncatedChapters.push(section);
      lines.push(`（第 ${section + 1} 章仅显示前 ${kept} 段，共 ${total} 段；续读用 reader_get_chapter(sectionIndex=${section}, fromPara=${nextPara})）`);
      blockChars = lines.reduce((n, l) => n + l.length, 0) + (lines.length - 1);
    }
    used += blockChars + (blocks.length ? 2 : 0);
    paragraphs += kept;
    blocks.push(lines.join("\n"));
  }

  const chaptersDropped = Math.max(0, input.length - list.length);
  return {
    text: blocks.join("\n\n"),
    chars: used,
    paragraphs,
    chaptersRead: list.length,
    chaptersDropped,
    truncatedChapters,
    truncated: truncatedChapters.length > 0 || chaptersDropped > 0,
  };
}

/**
 * foliate `book.splitTOCHref()` 的同步返回 → section 索引。
 * AZW3/MOBI 返回 `[index, pos]`、FB2 返回 `[index, hash]`，可以直接用；
 * EPUB 返回 `[路径, hash]`（不是索引）、PDF 返回 Promise —— 都返回 -1 交给调用方回落。
 */
export function sectionIndexFromTocSplit(split: any): number {
  if (!Array.isArray(split)) return -1;
  const idx = Math.floor(Number(split[0]));
  return Number.isFinite(idx) && idx >= 0 ? idx : -1;
}

/** 工具 reader_get_range 的章节参数收敛（0 起，倒序自动交换） */
export function normalizeToolRange(
  raw: any,
  total?: number,
): { ok: true; from: number; to: number } | { ok: false; error: string } {
  const from = Math.floor(Number(raw?.fromSection));
  const to = Math.floor(Number(raw?.toSection));
  if (!Number.isFinite(from) || !Number.isFinite(to)) return { ok: false, error: "fromSection / toSection 必须是章节序号" };
  const range = normalizeReadRange({ from, to }, total);
  if (!range) return { ok: false, error: "范围超出本书章节数" };
  return { ok: true, from: range.from, to: range.to };
}
