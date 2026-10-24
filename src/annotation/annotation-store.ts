/**
 * 批注 · 本地持久化实现（阅读器独立插件）
 * ----------------------------------------------------------------
 * 背景：批注数据**完全留在本插件** `siyuan-plugin-reader` 的存储中
 *   （数据文件 `hiword-annotations.json`，由本插件的 PersistentStore 管理），
 *   不依赖主插件 `siyuan-plugin-reword`，也不再用任何跨插件桥。
 *
 * 独立性演进：
 *   - 2026-10-13：从 `window.__rewordBridge` 跨插件读写改为本地持久化，
 *     消除跨插件依赖（旧桥代码 `src/bridge/client.ts` 已删除）。
 *   - 2026-10-23：首启迁移 —— 若本插件批注库为空、而主插件
 *     `siyuan-plugin-reword` 的 `hiword-annotations.json` 存在，则一次性
 *     拷贝过来并落本插件目录，方便从主插件升级过来的老用户保留批注。
 *
 * 数据模型与主插件 AnnotationItem 完全对齐（类型/常量/纯函数
 * 本地各留一份副本 —— 它们是跨插件的静态契约，稳定且零成本）。
 *
 * 持久化机制：
 *   - 防抖合并（400ms trailing）：高频划词/批注操作合并为一次写盘
 *   - 失败重试（指数退避，最多 3 次）
 *   - onDestroy 时 flush：确保关闭阅读器时挂起的进度/批注不落空
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { t } from "../i18n/index.ts";
import type { BookType } from "../reader/reader-mode.ts";
import { PersistentStore } from "../core/persist.ts";

/** 供 reader 直接复用（避免重复定义导致类型不兼容） */
export type { BookType };

/** 持久化结构（与主插件 AnnotationStore.toJSON 对齐） */
interface AnnotationStoreData {
  annotations: AnnotationItem[];
}

/** 存储键名 */
const ANNOTATIONS_KEY = "hiword-annotations.json";

/** 存储键名（旧版兼容：主插件的键名） */
const ANNOTATIONS_KEY_LEGACY = "hiword-annotations.json";

/** 是否已完成数据迁移（避免重复迁移） */
let migrated = false;

/* ============================================================
 * 一、静态契约（本地副本，与主插件保持一致）
 * ============================================================ */

/** 批注性质：highlight=纯高亮无批注内容；annotate=带批注内容 */
export type AnnotationType = "highlight" | "annotate";

/** 样式：highlight=背景标记 / solid=直线段 / wavy=波浪线 */
export type AnnotationStyle = "highlight" | "solid" | "wavy";

/** 批注分类：重要 / 困难 / 待办 / 日程（whale 预设用） */
export type AnnotationCategory = "important" | "hard" | "todo" | "schedule";

/** 批注来源：manual=用户手标 / ai=AI 生成 */
export type AnnotationOrigin = "manual" | "ai";

/** 批注范围：word=词 / sentence=句 / both=两者 */
export type AnnotationScope = "word" | "sentence" | "both";

/** PDF 矩形高亮坐标（阅读器 PDF 场景） */
export interface PdfRect {
  x: number;
  y: number;
  w: number;
  h: number;
  page: number;
}

/** 一条批注（结构与主插件 AnnotationItem 对齐） */
export interface AnnotationItem {
  id: string;
  blockId: string;
  docId: string;
  /** 书籍批注归属（思源块批注不填） */
  bookId?: string;
  /** foliate CFI 锚点（书籍场景精确定位） */
  cfi?: string;
  type?: AnnotationType;
  sentence: string;
  selectedText: string;
  start?: number;
  end?: number;
  note: string;
  /** note 存储格式（历史兼容，新写入一律 kramdown） */
  noteFormat?: "html" | "kramdown";
  version?: number;
  origin: AnnotationOrigin;
  color?: string;
  style?: AnnotationStyle;
  scope?: AnnotationScope;
  /** 下划线颜色（与背景色 color 独立，缺省 = color） */
  lineColor?: string;
  /** 旧流程标签（已废弃保留兼容） */
  tags?: string[];
  /** 分类标签 id 数组 */
  labels?: string[];
  category?: AnnotationCategory;
  /** 创建时间（ISO 字符串） */
  createdAt: string;
  /** 更新时间（ISO 字符串） */
  updatedAt: string;
  /** 仅 origin==="ai" 或曾用 AI 时存在 */
  ai?: unknown;
  /** 软删时间戳（ISO）；未删为 undefined。读取路径一律过滤 */
  deletedAt?: string;
  /** 媒体类型双保险（pdf/epub/other），渲染「我的标记」时按当前书籍过滤 */
  bookType?: BookType;
  /** PDF 标注在无 CFI 时的页码兜底（跳转用） */
  page?: number;
  /** PDF 自建覆盖层用的归一化矩形（按页存储，翻页/缩放重映射） */
  pdfRects?: PdfRect[];
  /** kind="rect" 表示框选矩形（非文本划选） */
  kind?: "rect";
  /** 矩形标注的 assets 快照相对路径（删除时连带清理） */
  snapshotPath?: string;
}

/** 批注输入（upsert 用） */
export interface AnnotationInput {
  blockId: string;
  docId: string;
  bookId?: string;
  cfi?: string;
  type?: AnnotationType;
  sentence: string;
  selectedText: string;
  start?: number;
  end?: number;
  note?: string;
  color?: string;
  style?: AnnotationStyle;
  rects?: PdfRect[];
  [k: string]: unknown;
}

/** 微信读书 5 色调色板（2026-10-14 复刻微信「饱和原色 → 淡彩呈现」两段式机制：
 *  存值为微信工具栏色点的饱和原色（截图逐像素取样）；文本呈现 = 原色 ×0.38 叠纸
 *  （overlayer marker opacity），淡彩观感与旧淡彩色板差 Δ≤6。
 *  旧淡彩存量值经 LEGACY_COLOR_MAP 保色迁移，不跳色。 */
export const WHALE_COLORS = [
  { name: t("明黄"), value: "#fec06b", hex: "#fec06b" }, // 0: 黄（微信色点实测）
  { name: t("翠绿"), value: "#61cd6f", hex: "#61cd6f" }, // 1: 绿（微信色点实测）
  { name: t("青蓝"), value: "#62a2ff", hex: "#62a2ff" }, // 2: 青（默认，微信色点实测）
  { name: t("玫粉"), value: "#fc798b", hex: "#fc798b" }, // 3: 粉（微信色点实测）
  { name: t("紫罗兰"), value: "#a988ff", hex: "#a988ff" }, // 4: 紫（微信色点实测）
] as const;

/** 2026-10-14 旧淡彩 → 新饱和 1:1 映射（历轮校准的存量标注保色不跳色） */
export const LEGACY_COLOR_MAP: Record<string, string> = {
  "#fce2c8": "#fec06b", // 明黄
  "#cfe8da": "#61cd6f", // 翠绿
  "#c8e2fd": "#62a2ff", // 青蓝
  "#fcd0da": "#fc798b", // 玫粉
  "#e7d8fc": "#a988ff", // 紫罗兰
};

/** 默认样式与颜色（阅读器 / 微阅统一） */
export const DEFAULT_ANNOTATION_COLOR: string = WHALE_COLORS[2].value; // 青蓝
export const DEFAULT_ANNOTATION_STYLE: AnnotationStyle = "highlight";

/** 样式顺序（设置面板 / 工具栏共用） */
export const ANNOTATION_PANEL_STYLES: AnnotationStyle[] = ["highlight", "solid", "wavy"];

/** 内置样式定义（3 种） */
export const ANNOTATION_STYLES: Record<
  AnnotationStyle,
  { label: string; css: string; hint: string; icon: string }
> = {
  highlight: { label: t("高亮"), css: "highlight", hint: t("背景标记"), icon: "▮" },
  solid: { label: t("直线段"), css: "solid", hint: t("一般笔记 / 重点"), icon: "━" },
  wavy: { label: t("波浪线"), css: "wavy", hint: t("生词 / 不认识"), icon: "﹏" },
};

/**
 * 旧样式降级映射（2026-08-24）：删除的线型落到语义最接近的新样式。
 *   dashed / double → solid（直线段）；dotted → wavy（波浪线）。
 */
const LEGACY_STYLE_FALLBACK: Record<string, AnnotationStyle> = {
  dashed: "solid",
  double: "solid",
  dotted: "wavy",
};

/** 规整样式名（未知值回退默认） */
export function normalizeAnnotationStyle(style?: string): AnnotationStyle {
  if (style === "highlight" || style === "solid" || style === "wavy") return style;
  if (style && LEGACY_STYLE_FALLBACK[style]) return LEGACY_STYLE_FALLBACK[style];
  return DEFAULT_ANNOTATION_STYLE;
}

/** 把任意颜色规整为 5 色调色板内的值：
 *  当前色板直通 → 旧淡彩经 LEGACY_COLOR_MAP 保色迁移 → 其余非法值回退默认青蓝 */
export function normalizeAnnotationColor(color?: string): string {
  if (!color) return DEFAULT_ANNOTATION_COLOR;
  if (WHALE_COLORS.some((c) => c.value === color)) return color;
  const mapped = LEGACY_COLOR_MAP[String(color).trim().toLowerCase()];
  if (mapped) return mapped;
  return DEFAULT_ANNOTATION_COLOR;
}

/**
 * 是否「纯标注」（无笔记内容）——只有高亮/画线，没有文字批注。
 * 与主插件 isPureHighlight 同口径：note 为空、或 note 就等于选中文本。
 */
export function isPureHighlight(a: AnnotationItem): boolean {
  const noteText = (a.note || "").trim();
  const sel = (a.selectedText || "").trim();
  return !noteText || noteText === sel;
}

/** 是否为「阅读批注」（带 bookId）；思源正文块批注不带 bookId */
export function isReading(a: AnnotationItem): boolean {
  return !!a.bookId;
}

/**
 * 规整 PDF 矩形数组：剔除非有限数 / 零面积 / 页码 < 1，并把坐标夹到 [0,1]。
 * 与主插件同口径（PDF 文本层与批注层共用一套坐标）。
 */
export function sanitizePdfRects(rects?: PdfRect[]): PdfRect[] | undefined {
  if (!rects || !Array.isArray(rects)) return undefined;
  const out: PdfRect[] = [];
  for (const r of rects) {
    if (!r || typeof r !== "object") continue;
    const x = Number(r.x), y = Number(r.y), w = Number(r.w), h = Number(r.h), p = Number(r.page);
    if (![x, y, w, h, p].every((n) => Number.isFinite(n))) continue;
    if (w <= 0 || h <= 0 || p < 1) continue;
    out.push({
      x: Math.min(1, Math.max(0, x)),
      y: Math.min(1, Math.max(0, y)),
      w: Math.min(1, Math.max(0, w)),
      h: Math.min(1, Math.max(0, h)),
      page: Math.round(p),
    });
  }
  return out.length ? out : undefined;
}

/** 批注去重键（blockId + 句子 + 选中文本，跨会话稳定） */
export function annotationKey(blockId: string, sentence: string, selectedText = ""): string {
  return `${blockId}::${sentence}::${selectedText}`;
}

/** 推断批注性质（无显式 type 时按 note 兜底）：有内容 → annotate，否则 highlight */
export function inferType(a: AnnotationItem): AnnotationType {
  return isPureHighlight(a) ? "highlight" : "annotate";
}

/* ============================================================
 * 二、本地持久化层（替代原 bridge 通道）
 * ============================================================ */

/** 软删除过滤 */
function isActive(it: AnnotationItem): boolean {
  return !it.deletedAt;
}

/** 生成唯一 ID */
function genId(): string {
  const c: any = (globalThis as any).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return "ann-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

/** 当前时间 ISO 字符串 */
function nowIso(): string {
  return new Date().toISOString();
}

/* ============================================================
 * 三、AnnotationStore（本地持久化实现）
 * ============================================================ */

/**
 * 批注存储。本地持久化 + 内存缓存 + 订阅机制。
 * 接口与主插件 AnnotationStore 对齐（reader 只用到这 8 个方法）：
 *   getAll / getByBook / get / upsert / remove / restore / subscribe / flush
 */
export class AnnotationStore {
  private items = new Map<string, AnnotationItem>();
  private byKey = new Map<string, string>(); // annotationKey -> id
  private byBlock = new Map<string, Set<string>>(); // blockId -> ids
  private subs = new Set<(v: AnnotationItem[]) => void>();
  private persist!: PersistentStore;

  /** 初始化持久化层（由 index.ts 在 onload 中调用） */
  async init(plugin: any): Promise<void> {
    this.persist = new PersistentStore(
      (d) => plugin.saveData(ANNOTATIONS_KEY, d),
      {
        delay: 400,
        retries: 3,
        onError: (e) => {
          console.warn("[RE 阅读器] 批注保存失败", e);
        },
      }
    );
    // 从本插件存储加载已有数据
    await this.loadFromDisk(plugin).catch(() => {});
    // 首启迁移：从主插件 REword 拷贝历史批注（仅当本插件为空且主插件有数据）
    await this.migrateFromReword(plugin);
  }

  /**
   * 首启迁移（2026-10-23）：从主插件 `siyuan-plugin-reword` 的
   * `hiword-annotations.json` 一次性拷贝历史批注到本插件目录。
   * 仅当本插件批注库为空、且主插件数据文件存在时执行；执行一次后置 `migrated`。
   * 主插件未安装 / 文件不存在 → 静默跳过，不影响本插件自有数据。
   */
  private async migrateFromReword(plugin: any): Promise<void> {
    if (migrated) return;
    if (this.items.size > 0) { migrated = true; return; }
    try {
      const sys = (globalThis as any)?.window?.siyuan?.config?.system;
      const wsDir: string | undefined = sys?.workspaceDir || sys?.dataDir;
      if (!wsDir) return; // 运行时尚未就绪（window.siyuan 未注入），下次加载再尝试
      const rewordFile = path.join(
        wsDir, "data", "storage", "petal", "siyuan-plugin-reword", "hiword-annotations.json"
      );
      migrated = true; // 本次已真正尝试，避免反复重试
      if (!fs.existsSync(rewordFile)) return;
      const raw = JSON.parse(fs.readFileSync(rewordFile, "utf-8"));
      if (raw && Array.isArray(raw.annotations) && raw.annotations.length) {
        this.load(raw);
        await plugin.saveData(ANNOTATIONS_KEY, this.toJSON());
        console.info(`[RE 阅读器] 已从 REword 迁移 ${raw.annotations.length} 条批注到本插件`);
      }
    } catch (e) {
      console.warn("[RE 阅读器] 批注首启迁移失败（不影响本插件已有数据）", e);
    }
  }

  /** 从磁盘加载数据 */
  private async loadFromDisk(plugin: any): Promise<void> {
    try {
      const raw = await plugin.loadData(ANNOTATIONS_KEY);
      if (raw && Array.isArray(raw.annotations)) {
        this.load(raw);
      }
    } catch {
      // 无历史数据：以空库启动
    }
  }

  /** 从持久化结构载入（容错：非法 / 旧结构不抛错，仅收集有效项） */
  load(raw: any): void {
    this.items.clear();
    this.byKey.clear();
    this.byBlock.clear();
    const list = Array.isArray(raw?.annotations) ? raw.annotations : [];
    for (const it of list) {
      if (it && typeof it.id === "string" && typeof it.blockId === "string") {
        const item = it as AnnotationItem;
        // 2026-08-25 修复：阅读器批注因历史 bug 导致 blockId 以「book:」开头
        // 但 bookId 字段缺失（undefined），导致 isReading() 返回 false
        if (!item.bookId && item.blockId.startsWith("book:")) {
          item.bookId = item.blockId.slice(5);
        }
        const normalized: AnnotationItem = {
          ...item,
          style: normalizeAnnotationStyle(item.style),
          color: normalizeAnnotationColor(item.color),
          lineColor: normalizeAnnotationColor(item.lineColor ?? item.color),
          noteFormat: item.noteFormat ?? "kramdown",
          version: item.version ?? 0,
        };
        this.items.set(normalized.id, normalized);
        this.byKey.set(annotationKey(normalized.blockId, normalized.sentence || "", normalized.selectedText || ""), normalized.id);
        this.indexByBlockAdd(normalized);
      }
    }
    this.notify();
  }

  /** 导出为可持久化结构 */
  toJSON(): AnnotationStoreData {
    return { annotations: [...this.items.values()] };
  }

  /** 提交更新到持久化层（防抖合并） */
  private async persistUpdate(): Promise<void> {
    if (this.persist) {
      try { await this.persist.update(this.toJSON()); }
      catch (e) { console.warn("[RE 阅读器] 批注持久化失败", e); }
    }
  }

  /** 立即落盘（onDestroy 时调用） */
  async flush(): Promise<void> {
    if (this.persist) {
      try { await this.persist.flush(); }
      catch (e) { console.warn("[RE 阅读器] 批注 flush 失败", e); }
    }
  }

  private emit(): void {
    for (const cb of this.subs) {
      try { cb(this.getAll()); } catch { /* 单个订阅者异常不应影响其他订阅者 */ }
    }
  }

  private notify(): void {
    for (const l of this.subs) {
      try { l(); } catch (e) { console.warn("[RE 阅读器] annotation listener 异常:", e); }
    }
  }

  /** 全部批注（按 createdAt 倒序，供面板展示） */
  getAll(): AnnotationItem[] {
    return [...this.items.values()]
      .filter(isActive)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): AnnotationItem | undefined {
    const it = this.items.get(id);
    return it && isActive(it) ? it : undefined;
  }

  /** 某块下的全部批注 */
  getByBlock(blockId: string): AnnotationItem[] {
    const ids = this.byBlock.get(blockId);
    if (!ids || ids.size === 0) return [];
    const out: AnnotationItem[] = [];
    for (const id of ids) {
      const a = this.items.get(id);
      if (a && isActive(a)) out.push(a);
    }
    return out;
  }

  /** 某本书下的全部批注（按 bookId 聚合） */
  getByBook(bookId: string): AnnotationItem[] {
    return [...this.items.values()].filter((a) => a.bookId === bookId && isActive(a));
  }

  /** 是否已对某块的某句子 + 选中文本做过批注 */
  exists(blockId: string, sentence: string, selectedText = ""): boolean {
    return this.byKey.has(annotationKey(blockId, sentence, selectedText));
  }

  /** 某块下是否有任意批注 */
  hasBlock(blockId: string): boolean {
    return this.getByBlock(blockId).length > 0;
  }

  /** 全部被批注的块 ID 集合 */
  annotatedBlockIds(): string[] {
    return [...new Set([...this.items.values()].filter(isActive).map((a) => a.blockId))];
  }

  /** 批注条数 */
  get size(): number {
    return this.items.size;
  }

  /**
   * 新增或更新一条批注（核心 upsert）。
   *  - 传入 id 且存在：按 id 更新 note/ai，刷新 updatedAt（createdAt 不变）。
   *  - 否则按 (blockId, sentence, selectedText) 去重覆盖。
   *  - 否则新增，生成 id 与 createdAt。
   */
  async upsert(input: Partial<AnnotationInput> & { id?: string }): Promise<AnnotationItem> {
    const ts = nowIso();
    const cleanNote = (input.note ?? "").trim();
    const cleanSentence = (input.sentence ?? "").trim();
    const cleanSelected = (input.selectedText ?? "").trim();

    // 1) 显式按 id 更新
    if (input.id && this.items.has(input.id)) {
      const prev = this.items.get(input.id)!;
      const note = input.note !== undefined ? cleanNote : prev.note;
      const updated: AnnotationItem = {
        ...prev,
        blockId: input.blockId || prev.blockId,
        docId: input.docId || prev.docId,
        sentence: input.sentence !== undefined ? cleanSentence : prev.sentence,
        selectedText: cleanSelected || prev.selectedText,
        start: input.start ?? prev.start,
        end: input.end ?? prev.end,
        note,
        noteFormat: "kramdown",
        version: (prev.version ?? 0) + 1,
        origin: input.origin || prev.origin,
        color: input.color || prev.color,
        style: input.style || prev.style,
        scope: input.scope ?? prev.scope,
        lineColor: input.lineColor || prev.lineColor || input.color || prev.color,
        tags: input.tags ?? prev.tags,
        labels: input.labels ?? prev.labels,
        category: input.category ?? prev.category,
        ai: input.ai ? { ...prev.ai, ...input.ai } : prev.ai,
        pdfRects: sanitizePdfRects(input.pdfRects) ?? prev.pdfRects,
        kind: input.kind ?? prev.kind,
        snapshotPath: input.snapshotPath ?? prev.snapshotPath,
        updatedAt: ts,
      };
      delete updated.deletedAt;
      this.items.set(updated.id, updated);
      this.indexByBlockRemove(prev);
      this.indexByBlockAdd(updated);
      this.reindexKeys();
      await this.persistUpdate();
      this.emit();
      return updated;
    }

    // 2) 按 (blockId, sentence, selectedText) 去重覆盖
    const key = annotationKey(String(input.blockId), cleanSentence, cleanSelected);
    const existingId = this.byKey.get(key);
    if (existingId && this.items.has(existingId)) {
      const prev = this.items.get(existingId)!;
      const note = input.note !== undefined ? cleanNote : prev.note;
      const updated: AnnotationItem = {
        ...prev,
        note,
        noteFormat: "kramdown",
        version: (prev.version ?? 0) + 1,
        start: input.start ?? prev.start,
        end: input.end ?? prev.end,
        origin: input.origin || prev.origin,
        color: input.color || prev.color,
        style: input.style || prev.style,
        scope: input.scope ?? prev.scope,
        lineColor: input.lineColor || prev.lineColor || input.color || prev.color,
        tags: input.tags ?? prev.tags,
        labels: input.labels ?? prev.labels,
        category: input.category ?? prev.category,
        ai: input.ai ? { ...prev.ai, ...input.ai } : prev.ai,
        pdfRects: sanitizePdfRects(input.pdfRects) ?? prev.pdfRects,
        kind: input.kind ?? prev.kind,
        snapshotPath: input.snapshotPath ?? prev.snapshotPath,
        updatedAt: ts,
      };
      delete updated.deletedAt;
      this.items.set(updated.id, updated);
      await this.persistUpdate();
      this.emit();
      return updated;
    }

    // 3) 新增
    const created: AnnotationItem = {
      id: input.id || genId(),
      blockId: input.blockId as string,
      docId: input.docId as string,
      bookId: input.bookId,
      cfi: input.cfi,
      type: input.type,
      sentence: cleanSentence,
      selectedText: cleanSelected,
      start: input.start,
      end: input.end,
      note: cleanNote,
      noteFormat: "kramdown",
      version: 1,
      origin: input.origin || "manual",
      color: normalizeAnnotationColor(input.color) || "#62a2ff",
      style: normalizeAnnotationStyle(input.style) || "highlight",
      scope: input.scope ?? "word",
      lineColor: normalizeAnnotationColor(input.lineColor || input.color) || "#62a2ff",
      tags: input.tags || [],
      labels: input.labels || [],
      category: input.category,
      createdAt: ts,
      updatedAt: ts,
      ai: input.origin === "ai" ? (input.ai || {}) : input.ai,
      bookType: input.bookType,
      page: input.page,
      pdfRects: sanitizePdfRects(input.pdfRects),
      kind: input.kind,
      snapshotPath: input.snapshotPath,
    };
    this.items.set(created.id, created);
    this.byKey.set(key, created.id);
    this.indexByBlockAdd(created);
    await this.persistUpdate();
    this.emit();
    return created;
  }

  /** 软删除（置 deletedAt 时间戳） */
  async remove(id: string): Promise<boolean> {
    const it = this.items.get(id);
    if (!it) return false;
    if (it.deletedAt) return true;
    it.deletedAt = nowIso();
    it.updatedAt = it.deletedAt;
    await this.persistUpdate();
    this.emit();
    return true;
  }

  /** 撤销软删除 */
  async restore(id: string): Promise<boolean> {
    const it = this.items.get(id);
    if (!it) return false;
    if (!it.deletedAt) return true;
    delete it.deletedAt;
    it.updatedAt = nowIso();
    await this.persistUpdate();
    this.emit();
    return true;
  }

  /** 清空全部批注 */
  async clearAll(): Promise<number> {
    const count = this.items.size;
    if (count === 0) return 0;
    this.items.clear();
    this.byKey.clear();
    this.byBlock.clear();
    await this.persistUpdate();
    this.emit();
    return count;
  }

  /** 订阅数据变更（返回退订函数） */
  subscribe(listener: () => void): () => void {
    this.subs.add(listener);
    return () => { this.subs.delete(listener); };
  }

  /* ===== byBlock 索引维护 ===== */

  private indexByBlockAdd(it: AnnotationItem): void {
    let set = this.byBlock.get(it.blockId);
    if (!set) { set = new Set(); this.byBlock.set(it.blockId, set); }
    set.add(it.id);
  }

  private indexByBlockRemove(it: AnnotationItem): void {
    const set = this.byBlock.get(it.blockId);
    if (!set) return;
    set.delete(it.id);
    if (set.size === 0) this.byBlock.delete(it.blockId);
  }

  private reindexKeys(): void {
    this.byKey.clear();
    for (const it of this.items.values()) {
      this.byKey.set(annotationKey(it.blockId, it.sentence || "", it.selectedText || ""), it.id);
    }
  }
}
