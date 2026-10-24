/**
 * 导出模板的数据组装（2026-10-09 新建）
 * ----------------------------------------------------------------
 * ## 职责：把「散落的批注数组」变成「模板能直接用的结构」
 *
 * 原始数据（`ReaderView.annotsList`）是**扁平**的：
 * ```ts
 * { kind, id, cfi, href, page, selectedText, sentence, note, style, color, createdAt }
 * ```
 * 模板若直接遍历它，输出就是一堆平铺的引用块 —— 长书完全看不出层次。
 *
 * ⇒ 这里做两件事：
 * ① 按目录（`tocItems`）把批注**分到各章**；
 * ② 预置 `__markIndex`（块属性占位符的序号，见 template-filters 的 `mark`）。
 *
 * ## 章节顺序：按目录原始顺序，不按批注时间
 *
 * 用户在目录里看到的顺序就是书里的顺序。若按 `createdAt` 排，
 * 跳着读的用户会得到一个乱序的笔记。章内才按时间升序（阅读顺序）。
 */

/** 单条批注在模板里的形态 */
export interface AnnotationTemplateData {
  kind: "text" | "ink" | "bookmark";
  id: string;
  /** 选中的原文（`selectedText` 优先，退`sentence`） */
  text: string;
  /** 用户笔记 */
  note: string;
  /** 所在章节标题（分不到章时为空串） */
  chapter: string;
  /** EPUB：章节内锚点；PDF：页码键 */
  href?: string;
  /** PDF 页码（1-based） */
  page?: number;
  /** 高亮样式 */
  style?: string;
  /** 高亮色 */
  color?: string;
  /** CFI（用于将来做块引用） */
  cfi?: string;
  createdAt?: number;
  /**
   * 块属性占位序号（从 1 开始）。
   *
   * 🔴 这是**引擎用的内部字段**，模板不该直接输出它——
   *   要输出占位符请写 `{{ a | mark }}`，由过滤器读这个序号。
   *   刻意用 `__` 前缀命名，一眼看出是内部契约。
   */
  __markIndex: number;
}

export interface ChapterTemplateData {
  /** 章节键（EPUB 的 href / PDF 的页码） */
  key: string;
  title: string;
  /** 目录层级（0-based），用于缩进 */
  level: number;
  /** 在目录里的序号（0-based），保证输出顺序 = 目录顺序 */
  index: number;
  annotations: AnnotationTemplateData[];
}

export interface ExportTemplateData {
  book: {
    id: string;
    title: string;
    author?: string;
    format: string;
    totalChapters: number;
    /** 本次导出的目标文档（per-book 绑定解析后的结果） */
    targetDocId?: string;
  };
  meta: {
    /** ISO 字符串 */
    exportDate: string;
    /** 本地化日期（`2026年10月9日`） */
    exportDateText: string;
    count: number;
    plugin: string;
  };
  chapters: ChapterTemplateData[];
  /** 扁平列表（便利项，避免用户自己遍历 chapters） */
  annotations: AnnotationTemplateData[];
}

/** 目录项的最小形状（只需 href + 标题） */
export interface TocLike {
  href?: string;
  label?: string;
  title?: string;
  level?: number;
}

/** 取批注的原文（`selectedText` 优先，退回整句） */
function textOf(a: any): string {
  return String(a?.selectedText || a?.sentence || "").trim();
}

/** 取批注类型；缺省按 text 处理 */
function kindOf(a: any): "text" | "ink" | "bookmark" {
  const k = String(a?.kind || "text");
  return k === "ink" || k === "bookmark" ? k : "text";
}

/**
 * 构建模板数据。
 *
 * @param opts.books  书籍元信息
 * @param opts.annotations 原始批注数组（**不会**被修改）
 * @param opts.tocItems    目录（用于章节分组，可缺省 ⇒ 全归到「未分章」）
 * @param opts.targetDocId 本次导出目标（写进 `book.targetDocId` 供模板引用）
 */
export function buildExportTemplateData(opts: {
  book: { id: string; title: string; author?: string; format: string };
  annotations: any[];
  tocItems?: TocLike[];
  targetDocId?: string;
  now?: number;
}): ExportTemplateData {
  const now = typeof opts.now === "number" ? opts.now : Date.now();
  const toc = Array.isArray(opts.tocItems) ? opts.tocItems : [];
  const src = Array.isArray(opts.annotations) ? opts.annotations : [];

  // ① 先按目录顺序建章节目录（**不含批注**）
  const chapters: ChapterTemplateData[] = toc.map((t, i) => ({
    key: String(t?.href || `__idx${i}`),
    title: String(t?.label || t?.title || t?.href || `${i + 1}`),
    level: typeof t?.level === "number" ? t.level : 0,
    index: i,
    annotations: [],
  }));
  const byKey = new Map<string, ChapterTemplateData>();
  for (const c of chapters) byKey.set(c.key, c);

  // ② 扁平列表：先全部转成模板形态并分配 __markIndex（**按原始顺序**）
  const flat: AnnotationTemplateData[] = src.map((a: any, i: number) => ({
    kind: kindOf(a),
    id: String(a?.id || `a${i}`),
    text: textOf(a),
    note: String(a?.note || "").trim(),
    chapter: "",
    href: a?.href ? String(a.href) : undefined,
    page: typeof a?.page === "number" ? a.page : undefined,
    style: a?.style ? String(a.style) : undefined,
    color: a?.color ? String(a.color) : undefined,
    cfi: a?.cfi ? String(a.cfi) : undefined,
    createdAt: typeof a?.createdAt === "number" ? a.createdAt : undefined,
    __markIndex: i + 1,
  }));

  // ③ 分章：href 前缀匹配（批注的 href 可能带锚点，如 "ch1.xhtml#p12"）
  const anchorless = (s: string) => String(s).split("#")[0];
  for (const item of flat) {
    const key = item.href ? anchorless(item.href) : item.page != null ? `p${item.page}` : "";
    const ch = key ? byKey.get(key) : undefined;
    if (ch) {
      ch.annotations.push(item);
      item.chapter = ch.title;
    }
  }

  // ④ 章内按阅读顺序（时间升序）；无时间戳的保持原序（稳定排序）
  for (const c of chapters) {
    c.annotations.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  }

  // ⑤ 分不到章的批注不丢：挂到一个「其他」章（放最后，避免打乱目录结构）
  const orphans = flat.filter((x) => !x.chapter);
  if (orphans.length) {
    chapters.push({
      key: "__other",
      title: "其他",
      level: 0,
      index: chapters.length,
      annotations: orphans,
    });
    for (const o of orphans) o.chapter = "其他";
  }

  const d = new Date(now);
  return {
    book: {
      id: String(opts.book?.id || ""),
      title: String(opts.book?.title || ""),
      author: opts.book?.author || undefined,
      format: String(opts.book?.format || ""),
      totalChapters: chapters.length,
      targetDocId: opts.targetDocId || undefined,
    },
    meta: {
      exportDate: d.toISOString(),
      exportDateText: `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`,
      count: flat.length,
      plugin: "RE 阅读器",
    },
    chapters,
    annotations: flat,
  };
}

/**
 * 供 `validateTemplate` 用的**最小样例数据**。
 *
 * 为什么不用真实数据做校验：真实数据几十条、字段全非空，
 * 校验时反而掩盖了"字段缺失"这类问题。样例要**故意精简**。
 */
export function sampleTemplateData(): ExportTemplateData {
  return {
    book: { id: "b1", title: "书名", author: "作者", format: "epub", totalChapters: 1, targetDocId: "d1" },
    meta: { exportDate: "2026-01-01T00:00:00.000Z", exportDateText: "2026年1月1日", count: 1, plugin: "RE 阅读器" },
    chapters: [
      {
        key: "c1",
        title: "第一章",
        level: 0,
        index: 0,
        annotations: [
          {
            kind: "text", id: "a1", text: "原文", note: "笔记", chapter: "第一章",
            href: "c1", style: "highlight", color: "#ffd700", createdAt: 1, __markIndex: 1,
          },
        ],
      },
    ],
    annotations: [
      {
        kind: "text", id: "a1", text: "原文", note: "笔记", chapter: "第一章",
        href: "c1", style: "highlight", color: "#ffd700", createdAt: 1, __markIndex: 1,
      },
    ],
  };
}
