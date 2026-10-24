/**
 * 导出模板的格式预设（2026-10-09 新建）
 * ----------------------------------------------------------------
 * ## 🔴 第一条铁律：默认预设必须**逐字复刻**改造前的输出
 *
 * 改造前 `ReaderView.exportAnnots` 的输出是硬编码的：
 * ```ts
 * const body = textOnly.map(it => {
 *   const text = String(it.selectedText || it.sentence || "").trim();
 *   const note = String(it.note || "").trim();
 *   return [text ? `> ${text}` : "", note].filter(Boolean).join("\n\n");
 * }).join("\n\n");
 * const md = t("# 《{title}》摘录\n\n{body}\n", { title: title || t("阅读"), body });
 * ```
 *
 * 「不配模板 ⇒ 升级后导出结果与现在完全一致」是**零破坏升级**的前提。
 * 用户已有的笔记文档里存着旧格式的产物，突然变格式会让人以为丢东西。
 *
 * ## 第二个约束：默认预设**必须含 `{{ a | mark }}`**
 *
 * 用户 2026-10-09 拍板「预设加块属性」—— 这是本功能相对 Readest 的
 * **唯一差异化优势**：摘录写进思源后可用 SQL 查、可做数据库视图。
 * 见 `attr-writer.ts` 里 `::xxx` 文本写法实测无效的说明。
 */

export interface TemplatePreset {
  id: string;
  /** 中文名（i18n key） */
  label: string;
  /** 一句话说明 */
  desc: string;
  template: string;
}

/** 默认（思源笔记）：章节分组 + 引用原文 + 笔记 + 块属性占位
 *
 * ## 🔴 缩进/空行的讲究（三条都是实测踩出来的）
 *
 * ① 块标签必须**紧贴**内容行写（`{% for %}…{% endfor %}`）——
 *    标签独占一行会各产出一个空行，渲染结果里出现连续 3~4 个空行，
 *    写进思源后变成一串空段落。
 * ② 摘录之间要**两个换行**（一个空行）。
 *    只用一个换行时占位符会与**下一条**的原文挤进同一块
 *    （实测得到 `["%%REWORD:1%%\n> 第二条"]`），
 *    属性就会挂到错误的块上。
 * ③ `{{ a | mark }}` 放在本条摘录的**末尾**，其后紧跟两个换行。
 *
 * 与改造前的差异只有「增」没有「改」：多了章节标题与 mark 占位；
 * 原文与笔记的排版（`> ` 引用 + 空行 + 笔记）**逐字未变**。
 */
const DEFAULT_TEMPLATE = `# 《{{ book.title }}》读书笔记

> 导出于 {{ meta.exportDateText }} · 共 {{ meta.count }} 条

{% for c in chapters %}{% if c.annotations %}## {{ c.title }}

{% for a in c.annotations %}{{ a.text | blockquote }}
{% if a.note %}
**笔记**：{{ a.note }}
{% endif %}{{ a | mark }}{% endfor %}
{% endif %}{% endfor %}`;

/** 纯文本摘录：只有原文和笔记，最简 */
const PLAIN_TEMPLATE = `# 《{{ book.title }}》摘录

{% for a in annotations %}{{ a.text }}
{% if a.note %}
{{ a.note }}
{% endif %}

{% endfor %}`;

/** 间隔重复（Anki 友好）：一条一块、块间 `---`，便于手动制卡 */
const SRS_TEMPLATE = `# 《{{ book.title }}》

{% for c in chapters %}{% if c.annotations %}## {{ c.title }}
{% endif %}{% for a in c.annotations %}### {{ a.chapter }}

{{ a.text | blockquote }}
{% if a.note %}
笔记：{{ a.note }}
{% endif %}
---
{% endfor %}{% endfor %}`;

/** 表格：章节 / 原文 / 笔记 三列
 *
 * ⚠️ 必须用 `| cell` 过滤器：表格单元格里**不能有竖线与换行**。
 *   不能写 `replace("|", "\\|")` —— 引擎按竖线切过滤器链，
 *   参数里的竖线会被当分隔符切碎（实测报「过滤器写法不合法」）。
 */
const TABLE_TEMPLATE = `# 《{{ book.title }}》读书笔记

| 章节 | 原文 | 笔记 |
| --- | --- | --- |
{% for a in annotations %}|{{ a.chapter | cell }}|{{ a.text | cell }}|{{ a.note | cell }}|
{% endfor %}`;

/** Readest 兼容：对齐 Readest 的默认输出，方便两边对照 */
const READEST_TEMPLATE = `# {{ book.title }}

{% for c in chapters %}{% if c.annotations %}## {{ c.title }}
{% endif %}{% for a in c.annotations %}{{ a.text | blockquote }}
{% if a.note %}
> 笔记：{{ a.note }}
{% endif %}

{% endfor %}{% endfor %}`;

export const TEMPLATE_PRESETS: TemplatePreset[] = [
  { id: "default", label: "默认（思源笔记）", desc: "章节分组 + 引用原文 + 笔记 + 块属性（可被 SQL 查询）", template: DEFAULT_TEMPLATE },
  { id: "plain", label: "纯文本摘录", desc: "只有原文和笔记，最简", template: PLAIN_TEMPLATE },
  { id: "srs", label: "间隔重复（Anki 友好）", desc: "一条一块、块间分隔线，便于手动制作卡片", template: SRS_TEMPLATE },
  { id: "table", label: "表格", desc: "章节 / 原文 / 笔记 三列表格", template: TABLE_TEMPLATE },
  { id: "readest", label: "Readest 兼容", desc: "对齐 Readest 的默认输出，方便两边对照", template: READEST_TEMPLATE },
];

/** 取默认预设的模板（模板为空时用） */
export function defaultTemplate(): string {
  return DEFAULT_TEMPLATE;
}

/** 按 id 取预设 */
export function presetById(id: string): TemplatePreset | undefined {
  return TEMPLATE_PRESETS.find((p) => p.id === id);
}
