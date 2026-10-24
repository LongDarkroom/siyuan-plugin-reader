/**
 * 导出内容的块属性写入（2026-10-09 新建）
 * ----------------------------------------------------------------
 * ## 为什么需要这一层（实测得出的结论）
 *
 * 方案原本设计「让模板输出 `::reword-meta` 文本块挂属性」。
 * **在真实思源 3.8.6 上验证：这种写法无效** ——
 * 临时建文档 → `appendBlock` 写入带 `::reword-meta` 的 Markdown → `getChildBlocks` 读回：
 *
 * ```
 * p | {} | 第一段普通文字
 * p | {} | ::reword-meta\n  book: 精力管理\n  c← 被当成**普通段落文字**
 * 结论：❌ 属性没挂上
 * ```
 *
 * 块属性只能走 `/api/attr/setBlockAttrs`（`{id, attrs}`），
 * 而 `appendBlock` **不返回块 ID**（只返回 IResdoOperations）。
 *
 * ## 因此采用「占位符 + 事后补挂」两阶段
 *
 * ```
 * ① 模板渲染出： >原文…\n\n%%REWORD:3%%
 * ② appendBlock 写入整篇
 * ③ 用 SQL 查出本篇的块（按 root_id + 创建时间窗口）
 * ④ 找到那个 %%REWORD:3%% 所在的块 → setBlockAttrs
 * ⑤ 删掉占位行（它对用户没有价值）
 * ```
 *
 * ## ⚠️ 属性名必须带 `custom-` 前缀
 *
 * 思源规范：自定义属性以 IAL 形式存在，键名**必须** `custom-` 前缀，
 * 否则不生效（`src/siyuan/attrs.ts:33withCustomPrefix` 已封装该规则）。
 * 方案里写的 `::reword-id` 是错的，实测后改为 `custom-reword-*`。
 */

/** 引擎需要的最小 API（与 DocPickerApi 同风格，不整个 import api.ts） */
export interface AttrWriterApi {
  sql?(stmt: string): Promise<any[]>;
  setBlockAttrs?(id: string, attrs: Record<string, string>): Promise<unknown>;
  updateBlock?(id: string, dataType: string, data: string): Promise<unknown>;
  deleteBlock?(id: string): Promise<unknown>;
}

export interface AttrPair {
  /** 模板里 `__markIndex` 的值（与 `{{ a | mark }}` 输出一一对应） */
  markIndex: number;
  /** 属性键（**不带** custom- 前缀，本函数统一补） */
  attrs: Record<string, string>;
}

/** 占位符：与 `template-filters.ts` 的 `mark` 过滤器**必须一致**
 *
 * 🔴 刻意**不用带 g 标志的模块级正则**。
 *   全局正则的 `lastIndex` 是**共享可变状态**：一次 `test()` 会推进它，
 *   下一次 `exec()` 就从中间开始 ⇒ 行为取决于调用历史。
 *   实测这造成了 OOM（内层 `test()` 推进 lastIndex，外层 `exec` 永不终止）。
 *   ⇒ 改为**每次调用新建局部正则**，无共享状态。
 */
const MARK_PATTERN = "%%REWORD:(\\d+)%%";
const markRe = () => new RegExp(MARK_PATTERN, "g");
const hasMark = (s: string) => new RegExp(MARK_PATTERN).test(s);

/** 属性名补 `custom-` 前缀（思源规范：自定义属性必须带此前缀） */
export function withCustomPrefix(key: string): string {
  const k = String(key || "").trim();
  if (!k) return "";
  return k.startsWith("custom-") ? k : `custom-${k}`;
}

/**
 * 从渲染结果里扫出占位符，建立「占位符 → 属性」映射。
 *
 * 🔴 纯字符串解析，不碰 DOM —— 这样能单测（不依赖浏览器）。
 *
 * ## 🔴 为什么按「占位符切区间」而不是「按空行切块 + 向前回溯」
 *
 * `mark` 过滤器输出 `\n\n%%REWORD:n%%`（**前置**换行、无后置换行），
 * 于是占位符在渲染结果里的位置取决于**上一条摘录有没有笔记**：
 *
 * ```
 * 有笔记： … **笔记**：我的笔记 \n\n %%REWORD:2%%   ← 占位在笔记之后的空行后
 * 无笔记： … %%REWORD:1%% \n > 第一条← 占位与「下一条原文」同处一块
 * ```
 *
 * 两种形态都实测出现过，且**随数据而变**（同一份代码，换批注就变）。
 * 任何依赖「块边界」或「向前回溯距离」的写法都会在其中一种形态下配错 ——
 * 实测回溯版会把第 2 条配到**第 1 条**的原文（两条挂到同一块）。
 *
 * ⇒ 改为**以占位符为分界**：第 n 个占位符的正文 = 上一个占位符之后、
 *   本占位符之前那段文本里的**最后一个引用块**。这个定义与空行无关，
 *   两种形态下都成立。
 */
export function parseMarkedBlocks(
  md: string,
  pairs: AttrPair[],
): Array<{ markIndex: number; attrs: Record<string, string>; before: string; after: string }> {
  const byIndex = new Map(pairs.map((p) => [p.markIndex, p.attrs]));
  const src = String(md || "");
  const out: Array<{ markIndex: number; attrs: Record<string, string>; before: string; after: string }> = [];

  // 收集全部占位符的位置（局部正则，无共享 lastIndex）
  const marks: Array<{ idx: number; start: number; end: number }> = [];
  const re = markRe();
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    marks.push({ idx: Number(m[1]), start: m.index, end: m.index + m[0].length });
  }
  if (!marks.length) return out;

  let prevEnd = 0;
  for (const mk of marks) {
    const attrs = byIndex.get(mk.idx);
    if (!attrs) {
      // 未知的序号也要推进游标，否则区间会串到下一条
      prevEnd = mk.end;
      continue;
    }
    // 本占位符**之前**的那段（不含上一个占位符）
    const before = pickBody(src.slice(prevEnd, mk.start), "");
    // 本占位符之后、到下一个占位符之前（供调试与「占位在正文前」的模板形态使用）
    const nextStart = marks.find((x) => x.start > mk.start)?.start ?? src.length;
    const after = pickBody("", src.slice(mk.end, nextStart));
    out.push({ markIndex: mk.idx, attrs, before, after });
    prevEnd = mk.end;
  }
  return out;
}

/**
 * 从一段文本里挑出**摘录正文**。
 *
 * 摘录正文经 `blockquote` 过滤器后必然以 `> ` 开头，所以判据很明确：
 * 取段内**最后一个**以 `> ` 开头的块。
 *
 * 🔴 必须是「最后一个」而不是「第一个」—— 区间里可能夹着上一条的内容
 *   （取决于占位符与正文的相对位置）。取最后一个才是紧邻本占位符的那条。
 */
function pickBody(segment: string, _unused: string): string {
  const blocks = String(segment || "")
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].startsWith("> ")) return blocks[i];
  }
  // 没有引用块 ⇒ 退而取最后一个非标签块（自定义模板可能不用 blockquote）
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (hasMark(b)) continue;
    if (/^\*\*[^*]+\*\*/.test(b)) continue; // 标签行（笔记/说明）
    return b;
  }
  return "";
}

/** 单引号转义（SQLite 标准：' → ''）。SQL 不支持占位符绑定，必须自己转。 */
function esc(v: unknown): string {
  return String(v ?? "").replace(/'/g, "''");
}

/** 等待一小段时间（用于索引延迟退避） */
function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * 带重试的块查询。
 *
 * ## 为什么需要（真机实测，2026-10-10 修复）
 * `appendBlock` 写入后，思源内核索引要 **1~2 秒** 才可见（`blocks` 表查得到）。
 * 若在写入后立刻 `SELECT ... WHERE root_id=...`，常常查回 0 行 ⇒
 * 块属性补挂静默失败（`writeMarkedAttrs` 直接 return 0），
 * `%%REWORD:n%%` 占位行也清不掉。这里最多重试 `attempts` 次、每次间隔
 * `intervalMs`，覆盖这段延迟（实测 t+2000ms 才稳定可见）。
 */
async function queryBlocksWithRetry(
  api: AttrWriterApi,
  stmt: string,
  attempts = 3,
  intervalMs = 1000,
): Promise<any[]> {
  let rows: any[] = [];
  for (let i = 0; i < attempts; i++) {
    try {
      rows = (await api.sql!(stmt)) || [];
    } catch {
      rows = [];
    }
    if (rows.length) return rows;
    if (i < attempts - 1) await sleep(intervalMs);
  }
  return rows;
}

/**
 * 给刚写入的块补挂属性。
 *
 * @param api思源 API（需sql / setBlockAttrs / updateBlock）
 * @param docId 目标文档 ID
 * @param pairs 每个占位序号对应的属性
 * @param md    渲染出的完整 Markdown（用于匹配块内容）
 * @returns 成功挂上的数量（失败不抛 —— 属性是增强功能，不该让整个导出失败）
 */
export async function writeMarkedAttrs(
  api: AttrWriterApi | null,
  docId: string,
  pairs: AttrPair[],
  md: string,
): Promise<number> {
  if (!api?.sql || !api?.setBlockAttrs || !api?.updateBlock) return 0;
  if (!pairs.length || !docId) return 0;

  const marked = parseMarkedBlocks(md, pairs);
  if (!marked.length) return 0;

  // 查本篇的块。root_id = 文档 id；按 sort 排序保证与写入顺序一致。
  // ⚠️ 带重试：appendBlock 写入后思源内核索引要 1~2s 才可见，立刻查会查回 0
  //   ⇒ 属性挂不上、占位行清不掉。覆盖这段延迟后再查。
  const rows = await queryBlocksWithRetry(
    api,
    `SELECT id, content, markdown, type FROM blocks WHERE root_id='${esc(docId)}' ORDER BY created ASC`,
  );
  if (!rows.length) return 0;

  // 建立「块文本 → 块」索引。思源 content/markdown 会被规范化（去标记），
  // 所以比对时统一做「去空白 + 取前若干字」的宽松匹配。
  const norm = (s: unknown) =>
    String(s ?? "")
      .replace(/[*_`>#\-\[\]()]/g, "")
      .replace(/\s+/g, "")
      .slice(0, 24);
  const index = new Map<string, any[]>();
  for (const r of rows) {
    for (const field of [r?.content, r?.markdown]) {
      const k = norm(field);
      if (!k) continue;
      if (!index.has(k)) index.set(k, []);
      index.get(k)!.push(r);
    }
  }

  let done = 0;
  for (const m of marked) {
    // 用占位符**前**的正文匹配（占位本身不是块内容）
    const key = norm(m.before);
    const cands = key ? index.get(key) : undefined;
    const block = cands?.[0];
    if (!block?.id) continue;
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(m.attrs || {})) {
      const full = withCustomPrefix(k);
      if (full) attrs[full] = String(v ?? "");
    }
    if (!Object.keys(attrs).length) continue;
    try {
      await api.setBlockAttrs(block.id, attrs);
      done++;
    } catch {
      // 单条失败不影响其余
    }
  }
  return done;
}

/**
 * 清理占位行。
 *
 * 占位符 `%%REWORD:n%%` 单独成一个块（模板里它前后都有空行），
 * 留着对用户毫无价值。查出来删掉。
 *
 * @returns 清理掉的块数
 */
export async function cleanupMarkBlocks(
  api: AttrWriterApi | null,
  docId: string,
): Promise<number> {
  if (!api?.sql || !api?.deleteBlock) return 0;
  // ⚠️ 带重试：占位块同样要等内核索引，立刻查会漏掉 ⇒ 文档里残留 %%REWORD:n%% 行。
  const rows = await queryBlocksWithRetry(
    api,
    `SELECT id, content FROM blocks WHERE root_id='${esc(docId)}' AND type='p' AND content LIKE '%%REWORD:%'`,
  );
  let n = 0;
  for (const r of rows) {
    if (!r?.id) continue;
    try {
      await api.deleteBlock(r.id);
      n++;
    } catch {
      /* 单条失败忽略 */
    }
  }
  return n;
}

/** 便捷入口：扫占位 → 挂属性 → 清理占位。返回 { tagged, cleaned } */
export async function applyBlockAttrs(
  api: AttrWriterApi | null,
  docId: string,
  pairs: AttrPair[],
  md: string,
): Promise<{ tagged: number; cleaned: number }> {
  const tagged = await writeMarkedAttrs(api, docId, pairs, md);
  const cleaned = await cleanupMarkBlocks(api, docId);
  return { tagged, cleaned };
}

/** 由模板数据生成 `AttrPair[]`（书名 + 章节 + 高亮信息） */
export function buildAttrPairs(
  annotations: Array<Record<string, any>>,
  bookTitle: string,
  bookId: string,
): AttrPair[] {
  const out: AttrPair[] = [];
  for (const a of annotations) {
    const idx = Number(a?.__markIndex);
    if (!Number.isFinite(idx) || idx <= 0) continue;
    const attrs: Record<string, string> = {
      // 属性名用连字符风格；值里的引号由思源自己转义，我们只防SQL 注入
      "reword-book": String(bookTitle || ""),
      "reword-book-id": String(bookId || ""),
    };
    if (a?.chapter) attrs["reword-chapter"] = String(a.chapter);
    if (a?.href) attrs["reword-href"] = String(a.href);
    if (a?.page != null) attrs["reword-page"] = String(a.page);
    if (a?.style) attrs["reword-style"] = String(a.style);
    if (a?.color) attrs["reword-color"] = String(a.color);
    if (a?.id) attrs["reword-annot-id"] = String(a.id);
    if (a?.createdAt) attrs["reword-created"] = new Date(a.createdAt).toISOString();
    out.push({ markIndex: idx, attrs });
  }
  return out;
}
