/**
 * 导出模板的过滤器（2026-10-09 新建）
 * ----------------------------------------------------------------
 * ## 为什么自己实现而不引Nunjucks
 *
 * 见设计方案 13.1：Nunjucks + 依赖约 200KB（主包现1.5MB），插件要过思源市场审核，
 * 且它支持任意函数调用 = 代码执行风险面。实际需求不到其能力的 10%。
 *
 * ## ���全约束（最重要的一条）
 *
 * 🔴 **变量值永远不被当作模板二次解析**。
 *   渲染时的插值走 `String(value)`，绝不再进词法分析。
 *   否则用户某条摘录里恰好写了 `{% for %}`，导出时就会被执行。
 *   这个保证由 `template-engine.ts` 的 `renderNodes` 负责落实，
 *   本文件的过滤器**也绝不能**返回会被重新解析的字符串。
 */

/** 过滤器上下文（供需要访问元数据的过滤器使用，但**不允许访问数据对象**） */
export interface FilterCtx {
  /** 过滤器名（如 "date"），报错时用 */
  __name: string;
}

/**
 * 过滤器签名。
 *
 * 🔴 约定：返回值是**最终字符串**，引擎不会二次解析它。
 */
export type Filter = (value: any, ...args: string[]) => string;

function toStr(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  // 对象/数组：给JSON 而不是 "[object Object]"，后者对用户毫无信息量
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/* ================================================================
 * 时间格式化
 * ================================================================ */

const MONTHS = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];

function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

/**
 * `date(fmt)` —— 时间戳格式化。
 *
 * 用 Python `strftime` 风格（与 Readest 一致，用户不用记两套语法）。
 * 支持的占位符（**只实现常用这几个**，不是完整 strftime）：
 *   %Y 四位年 / %y 两位年 / %m 月（01-12）/ %d 日（01-31）
 *   %H 时（00-23）/ %M 分 / %S 秒 / %p AM/PM
 *
 * 不传 fmt 或 fmt 为空 → 用一个固定的、可读的中文格式。
 * 不解析时间戳 → 传入 None 时的当前时间（模板里很少用到）。
 */
const date: Filter = (value, fmt) => {
  let ts: number;
  if (value == null || value === "") {
    ts = Date.now();
  } else if (typeof value === "number") {
    // 小于 1e11 的数当成秒级时间戳（10 位 = 2001年后，13 位 = 毫秒级）
    ts = value < 1e11 ? value * 1000 : value;
  } else if (value instanceof Date) {
    ts = value.getTime();
  } else {
    const parsed = Date.parse(String(value));
    if (Number.isNaN(parsed)) return toStr(value); // 解析不了就原样返回
    ts = parsed;
  }
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const f = String(fmt || "");
  if (!f) return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return f.replace(/%([YymdHMSp])/g, (m, c: string) => {
    switch (c) {
      case "Y": return String(d.getFullYear());
      case "y": return pad2(d.getFullYear() % 100);
      case "m": return pad2(d.getMonth() + 1);
      case "d": return pad2(d.getDate());
      case "H": return pad2(d.getHours());
      case "M": return pad2(d.getMinutes());
      case "S": return pad2(d.getSeconds());
      case "p": return d.getHours() < 12 ? "AM" : "PM";
      default: return m;
    }
  });
};

/** `month()` —— 「2026年3月」这类中文月份，供标题用 */
const month: Filter = (value) => {
  let ts: number;
  if (typeof value === "number") ts = value < 1e11 ? value * 1000 : value;
  else if (value instanceof Date) ts = value.getTime();
  else if (value == null || value === "") ts = Date.now();
  else {
    const p = Date.parse(String(value));
    if (Number.isNaN(p)) return toStr(value);
    ts = p;
  }
  const d = new Date(ts);
  return `${d.getFullYear()}年${MONTHS[d.getMonth()]}`;
};

/* ================================================================
 * 文本处理
 * ================================================================ */

/**
 * `blockquote` —— 每行加 `> `，生成思源引用块。
 * （对标 Readest 的同名过滤器）
 */
const blockquote: Filter = (value) => {
  const s = toStr(value);
  if (!s) return "";
  return s
    .split("\n")
    .map((line) => (line.trim() ? "> " + line : ">"))
    .join("\n");
};

const upper: Filter = (value) => toStr(value).toUpperCase();
const lower: Filter = (value) => toStr(value).toLowerCase();
const trim: Filter = (value) => toStr(value).trim();

/** `default(值)` —— 空值兜底。空 = undefined / null / 空串 / 空数组 */
const defaultF: Filter = (value, fallback) => {
  const empty =
    value == null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0);
  return empty ? toStr(fallback ?? "") : toStr(value);
};

/** `join(分隔符)` —— 列表拼接 */
const join: Filter = (value, sep) => {
  if (!Array.isArray(value)) return toStr(value);
  return value.map((x) => toStr(x)).join(sep ?? "");
};

/** `truncate(n)` —— 截断到 n 个字符，超出加省略号（摘要用） */
const truncate: Filter = (value, n) => {
  const s = toStr(value);
  const max = parseInt(String(n ?? "40"), 10);
  if (!Number.isFinite(max) || max <= 0) return s;
  return s.length <= max ? s : s.slice(0, max) + "…";
};

/** `replace(旧, 新)` —— 简单字面替换（非正则，避免注入） */
const replace: Filter = (value, from, to) => {
  const s = toStr(value);
  const f = toStr(from);
  if (!f) return s;
  return s.split(f).join(toStr(to ?? ""));
};

/** `indent(n)` —— 缩进 n 个空格（嵌套列表用） */
const indent: Filter = (value, n) => {
  const s = toStr(value);
  const k = parseInt(String(n ?? "2"), 10);
  const pad = " ".repeat(Number.isFinite(k) && k > 0 ? k : 2);
  return s
    .split("\n")
    .map((line) => (line.trim() ? pad + line : line))
    .join("\n");
};

/**
 * `link` —— 输出思源块引用 `((id))`。
 *
 * 🔴 **只接受字符串**（块 ID 是 `20260124...-abcdefg` 这种）。
 *   早期版本用 `toStr()` 统一转换，于是传对象时会把整个 JSON 塞进
 *   `(({"a":1}))` —— 那不是链接，是垃圾内容，而且看起来像合法的
 *   思源块引用语法，导出后用户根本不知道哪里错了。
 */
const link: Filter = (value) => {
  if (value == null) return "";
  if (typeof value !== "string" && typeof value !== "number") return "";
  const id = String(value).trim();
  // 思源块 ID 形如 20260124212504-490vtgy（14 位时间戳- 7 位 base58）
  if (!/^[A-Za-z0-9-]{4,64}$/.test(id)) return "";
  return `((${id}))`;
};

/**
 * `mark` —— 🔴 RE 专有：**挂块属性的占位标记**。
 *
 * ## 它解决什么
 *
 * 实测（2026-10-09，思源 3.8.6）：**`::xxx` 文本写法无法挂块属性**，
 * 块属性只能走 `/api/block/setBlockAttrs`，而 `appendBlock` 不返回块 ID。
 * 所以模板用这个过滤器输出一行**占位符**：
 *
 *   模板：`{{ a.text | blockquote }}{{ a | mark }}`
 *   渲染：`> 原文…\n\n%%REWORD:3%%`
 *
 * 引擎写入后扫到 `%%REWORD:3%%`，就知道第 3 个摘录块要挂
 * `book / chapter / href / style / color` 属性 ⇒ 查回块 ID ⇒ 调 setBlockAttrs
 * ⇒ 清理占位行。详见 `attr-writer.ts`。
 *
 * ## 为什么不在模板里输出属性文本
 *
 * 因为那样无效（实测），且会把"内容"与"元数据"耦合在模板里，
 * 用户改模板时容易把属性格式改坏。
 *
 * ## 序号从哪来
 *
 * 由 `buildExportTemplateData` 在数据里预置 `__markIndex`（从 1 开始的稳定序号），
 * 引擎扫占位符时按序号取对应条目的属性。
 * 模板里也可以显式传：`{{ a | mark(7) }}`。
 */
const mark: Filter = (value, indexArg) => {
  const raw = value as Record<string, unknown> | null;
  let idx = "";
  if (indexArg != null && String(indexArg).trim() !== "") {
    idx = String(parseInt(String(indexArg), 10) || 0).trim();
  } else if (raw && typeof raw === "object") {
    const pre = (raw as any).__markIndex;
    if (pre != null) idx = String(pre);
  }
  if (!idx) return "";
  // 🔴 前后**都要**换行 —— 占位符必须独占一个 Markdown 段落。
  //
  // 只有前置换行时渲染结果是 `> 原文\n%%REWORD:1%%`，
  // 而 CommonMark 会把非空行接在上一行之后当作**懒延续** ⇒ 占位符落进
  // 引用块的正文里，写进思源后与摘录原文同块 ⇒ 属性挂错块。
  //
  // ⚠️ 代价：模板里 `{{ a | mark }}` **前面不能再有空行**，
  //   否则叠成连续 4 个换行（= 一串空段落）。
  return `\n\n%%REWORD:${idx}%%\n\n`;
};

/**
 * `cell` —— 表格单元格转义（Markdown 表格专用）。
 *
 * 🔴 为什么不能靠 `replace("|", "\\|") | replace("\n", " ")` 链式做：
 *   ① 引擎按 `|` 切分过滤器链，参数里的 `"|"` 会被当**分隔符**切碎
 *      （实测报「过滤器写法不合法「replace("」）；
 *   ② 原文里的**换行**会让 Markdown 表格整个塌掉 —— 表格单元格里不能有换行，
 *      换行必须变成空格或 `<br>`，这与"转义竖线"是两件事，不该让用户自己拼。
 *
 * 行为：`|` → `\|`，换行/回车/制表 → 空格，连续空格压成一个，两端去空白。
 * 超过 200 字截断并加省略号（表格列宽有限，长文本会把表撑烂）。
 */
const cell: Filter = (value) => {
  let s = toStr(value);
  s = s.replace(/\r\n?|\n|\t/g, " ").replace(/\|/g, "\\|");
  s = s.replace(/\s{2,}/g, " ").trim();
  if (s.length > 200) s = s.slice(0, 200) + "…";
  return s;
};

/* ================================================================
 * 注册表
 * ============================================================ */

export const FILTERS: Record<string, Filter> = {
  date,
  month,
  blockquote,
  upper,
  lower,
  trim,
  default: defaultF,
  join,
  truncate,
  replace,
  indent,
  link,
  mark,
  cell,
};

/** 供编辑器「插入变量」面板展示的清单 */
export const FILTER_DOCS: Array<{ name: string; usage: string; desc: string }> = [
  { name: "date", usage: '{{ d | date }} / {{ d | date("%Y-%m-%d") }}', desc: "时间戳格式化" },
  { name: "month", usage: '{{ d | month }}', desc: "中文月份，如 2026年3月" },
  { name: "blockquote", usage: "{{ a.text | blockquote }}", desc: "每行加 > 生成引用块" },
  { name: "upper", usage: "{{ s | upper }}", desc: "转大写" },
  { name: "lower", usage: "{{ s | lower }}", desc: "转小写" },
  { name: "trim", usage: "{{ s | trim }}", desc: "去首尾空白" },
  { name: "default", usage: "{{ a.note | default('（无笔记）') }}", desc: "空值兜底" },
  { name: "join", usage: "{{ tags | join('、') }}", desc: "列表拼接" },
  { name: "truncate", usage: "{{ a.text | truncate(40) }}", desc: "截断并加省略号" },
  { name: "replace", usage: "{{ s | replace('旧', '新') }}", desc: "字面替换" },
  { name: "indent", usage: "{{ s | indent(2) }}", desc: "缩进" },
  { name: "link", usage: "{{ a.id | link }}", desc: "思源块引用 ((id))" },
  { name: "mark", usage: "{{ a | mark }}", desc: "挂块属性的占位标记（引擎会补挂属性）" },
  { name: "cell", usage: "{{ a.text | cell }}", desc: "表格单元格转义（竖线 + 换行）" },
];

export function hasFilter(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(FILTERS, name);
}
