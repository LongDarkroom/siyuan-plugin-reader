/**
 * 内容适配器契约 + 注册表（R0 地基 · Readest 蓝本）
 * ---------------------------------------------------------------
 * 对齐 Readest DocumentLoader 范式：检测格式 → 分派适配器 → 产出 BookDoc。
 * 每个内容类型一个适配器；基础层只认本契约，不认 foliate / pdf.js。
 *
 * R0 仅契约 + 注册表 + 魔数检测（纯函数）；具体适配器 R1 落地：
 *   现有 books 延伸收进 EpubAdapter、pdf 延伸收进 PdfAdapter、漫画立薄壳。
 * 精简说明：metadata / toc / 分页信息全部由 open() 返回的 BookDoc 承载，
 * 适配器不再暴露冗余 getter（Readest 同构：open 一次拿全）。
 */
import type { BookDoc } from "./book-doc.ts";

export type ContentType = "epub" | "pdf" | "comic" | "text" | "other";

/** 打开书的输入源（R1 由书架 / 阅读入口装配） */
export interface BookSource {
  bookId: string;
  /** 文件名（含扩展名，用于类型检测） */
  name: string;
  /** 文件二进制（从思源资产 / 用户导入读取后填充；魔数检测用） */
  bytes?: Uint8Array;
  /** 已有 File 对象（与 bytes 二选一） */
  file?: File;
  /** 书名（纯文本适配器 makeTextBook 需要，用于兜底标题） */
  title?: string;
}

/** 特性能力开关（漫画类 supports("text")=false → 双语自动跳过） */
export type FeatureFlag = "text" | "selection" | "webtoon";

export interface ContentAdapter {
  readonly type: ContentType;
  /**
   * 把内容打开到【已挂载的】foliate view 上（不创建 view、不挂监听、不应用样式）。
   * 时序由调用方（openBook）控制：view 创建 → setupAnnotationLayer → 挂监听 → 调本方法。
   * 行为等价于旧 openBook 内联的 view.open(file) / view.open(makeTextBook(...))。
   */
  openView(view: any, source: BookSource): Promise<void>;
  /**
   * 给定已打开的 view，产出归一化 BookDoc（目录 / 分节 / PDF 大纲 / 总页数）。
   * 不负责打开，调用方在 view.open 之后调用。
   */
  buildBookDoc(source: BookSource, view: any): Promise<BookDoc> | BookDoc;
  supports(feature: FeatureFlag): boolean;
}

type AdapterCtor = new () => ContentAdapter;

const registry = new Map<ContentType, AdapterCtor>();

/** 注册适配器（R1 各适配器模块加载时自注册） */
export function registerAdapter(type: ContentType, ctor: AdapterCtor): void {
  registry.set(type, ctor);
}

export function createAdapter(type: ContentType): ContentAdapter {
  const Ctor = registry.get(type);
  if (!Ctor) throw new Error(`[REword] 未注册的内容适配器: ${type}`);
  return new Ctor();
}

/** ZIP 容器判定（对齐 Readest：前 3 字节 PK + 本地头/中央目录/空档标记） */
function looksLikeZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 && bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)
  );
}

/** PDF 魔数 "%PDF-" */
function looksLikePdf(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 5 &&
    bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 &&
    bytes[3] === 0x46 && bytes[4] === 0x2d
  );
}

/**
 * 纯按文件名 / 格式名归类内容类型（无魔数时的兜底逻辑，也是能力真值的归类入口）。
 * 兼容两种入参：完整文件名（"book.epub"）与 BookMeta.format 纯格式名（"epub" / ".epub"）——
 * 取最后一段点分后缀再比对，大小写不敏感。detectContentType 的扩展名分支与
 * resolveCapabilities 共用本函数，避免「格式→类型」的判定散落两处、彼此漂移。
 */
export function contentTypeFromFormat(nameOrFormat: string): ContentType {
  const ext = (nameOrFormat || "").toLowerCase().replace(/^\.+/, "").split(".").pop() || "";
  if (ext === "pdf") return "pdf";
  if (ext === "cbz") return "comic";
  if (ext === "epub" || ext === "mobi" || ext === "azw3" || ext === "fb2") return "epub";
  if (ext === "txt" || ext === "md" || ext === "markdown") return "text";
  return "other";
}

/**
 * 类型检测：魔数优先、扩展名兜底（对齐 Readest 多层检测策略）。
 * ZIP 容器内 EPUB / CBZ 按扩展名区分；无扩展名 ZIP 默认按 EPUB（Readest 同策略）。
 * 非容器（无魔数）内容一律交给 contentTypeFromFormat 归类。
 */
export function detectContentType(name: string, bytes?: Uint8Array): ContentType {
  const lower = (name || "").toLowerCase();
  if (bytes && looksLikePdf(bytes)) return "pdf";
  if (bytes && looksLikeZip(bytes)) {
    if (lower.endsWith(".cbz")) return "comic";
    return "epub";
  }
  return contentTypeFromFormat(name);
}

/**
 * 阅读器「能力」单一真源（2026-10-14 地基重构）。
 * -------------------------------------------------------------------
 * 背景：此前 PDF/漫画的能力判断靠 ReaderView 里散落的 ~50 处 isPdfBook() 硬编码，
 * 且适配器 supports() 定义了却从不被消费（死代码，且与运行时判断各说各话）。
 * 本表把「内容类型 → 是否具备某能力」收敛为唯一真值，供适配器与 UI 共同消费。
 *
 * 边界（重要）：能力=「内容本身能不能做到」，不是「渲染管线走哪条」。
 * 缩放 / 反色 / 对开 / 翻页 / PdfTextHlLayer 双绘规避等属管线选择，
 * 继续留在各自的 isPdfBook() 分支里，不要塞进这里。
 *
 * - text：有可抽取正文（双语注入 / 朗读取词 / 搜索命中的前提）。漫画无正文文本=false。
 * - selection：用户可划词选区（划词工具栏）。漫画=false。
 * - reflow：可重排版（字号 / 行距 / 字体 / 段落 / 双语对照注入）。
 *   固定版式（PDF 位图、漫画图片）=false；PDF/漫画改用缩放而非 reflow。
 */
export interface ReaderCapabilities {
  text: boolean;
  selection: boolean;
  reflow: boolean;
}

const CAPS_BY_TYPE: Record<ContentType, ReaderCapabilities> = {
  epub:   { text: true,  selection: true,  reflow: true },
  text:   { text: true,  selection: true,  reflow: true },
  other:  { text: true,  selection: true,  reflow: true },
  pdf:    { text: true,  selection: true,  reflow: false },
  comic:  { text: false, selection: false, reflow: false },
};

/** 内容类型 → 能力（唯一真值表）。 */
export function capabilitiesForType(type: ContentType): ReaderCapabilities {
  return CAPS_BY_TYPE[type] ?? CAPS_BY_TYPE.other;
}

/** 由 BookMeta.format（纯格式名或文件名）解析能力——UI 侧无需持有适配器实例即可消费。 */
export function resolveCapabilities(nameOrFormat: string): ReaderCapabilities {
  return capabilitiesForType(contentTypeFromFormat(nameOrFormat));
}

/**
 * 适配器 supports() 的统一实现：把 FeatureFlag 映射到能力真值表，
 * webtoon 是漫画专属、不在通用能力表内，单独特判。四个适配器都调本函数，
 * 使 supports() 不再是各写各的死代码，而是能力表的薄视图。
 */
export function supportsForType(type: ContentType, f: FeatureFlag): boolean {
  if (f === "webtoon") return type === "comic";
  const c = capabilitiesForType(type);
  return f === "text" ? c.text : c.selection;
}
