import { logSwallow } from "../core/safe.ts";
import { loadLibraryIndex, saveLibraryIndex, INDEX_KEY, GROUPS_KEY } from "./library/library-persist.ts";
import { isValidBookMeta, isValidBookGroup } from "./library/library-types.ts";
/**
 * 阅读器 - 书架存储
 * ---------------------------------------------------------------
 * - 书架索引持久化到插件数据 hiword-bookshelf.json（loadData/saveData）
 * - 书籍文件本体存 /data/public/<name>/books/（思源静态资源目录）。
 *   为什么不放 /data/plugins/<name>/：商店更新整目录替换，书每更新一次丢一次。
 *   为什么不放 /data/storage/petal/<name>/：思源 v3.1.8 起「写 petal → 广播
 *   该插件重载」（内核 push_reload.go），且 petal 参与云端同步，几百 MB 书库
 *   会把同步打爆。public 既不触发重载、也不进同步，还能用 /public/… 直接 GET（支持 Range）。
 *   代价：public 不随思源同步，换设备/新工作空间只剩索引 —— 由 refreshMissing
 *   标「已丢失」并在书卡上提示重新导入，记录与进度都还在。
 *   旧路径（插件目录、petal）的书在首次加载时后台迁移过来。
 */

import { putFile, getFileBlob, removeFile, renameFile } from "../siyuan/api";
import { unzipSync } from "fflate";
import { writable } from "svelte/store";
import { bookFingerprint } from "./book-fingerprint.ts";
import { type BookType } from "./reader-mode.ts";
import { isMobile } from "../core/env.ts";
import { parseContainerXml, parseOpf, coverExtOf, coverMimeOf } from "./epub-opf.ts";
import { extractEpubMetaRemote } from "./epub-meta-remote.ts";
import {
  parseBookRef, bookRefUrl, bookRefExt, bookRefName, bookRefKey, isSupportedRef,
} from "./book-ref.ts";
import { loadRefBlob } from "./book-ref-load.ts";
import { listDirNames } from "./file-probe.ts";

/*
 * 类型与常量已原位抽取到 library/ 层（library-types.ts / library-persist.ts），
 * 这里 import 供内部使用 + re-export 保持对外契约 100% 不变（约 10 处消费者零改动）。
 */
import {
  BOOK_COLORS, isValidBookColor, BOOK_COLOR_INDEX,
} from "./library/library-types.ts";
export { BOOK_COLORS, ZOOM_PRESETS, isValidBookColor } from "./library/library-types.ts";

import type {
  ReadingProgress, ZoomState, BookStatus, BookColor, BookGroup,
  BookSortKey, SortDir, BookFilter, BookMark, BookMeta,
} from "./library/library-types.ts";
export type {
  ReadingProgress, ZoomState, BookStatus, BookColor, BookGroup,
  BookSortKey, SortDir, BookFilter, BookMark, BookMeta,
} from "./library/library-types.ts";
const BOOKS_DIR = (pluginName: string) =>
  `/data/public/${pluginName}/books`;
/**
 * 历史存放位置（仅用于一次性迁移，按新→旧顺序）：
 * 1. petal —— 0.11.4/0.11.5 的落点，写盘会触发插件重载；
 * 2. 插件安装目录 —— 0.11.3 及更早，商店更新会被整目录替换。
 */
const LEGACY_BOOKS_DIRS = (pluginName: string) => [
  `/data/storage/petal/${pluginName}/books`,
  `/data/plugins/${pluginName}/books`,
];
/** 旧路径相对 BOOKS_DIR 取文件名（covers/ 子目录同样适用） */
const legacySourceOf = (pluginName: string, p?: string): string | null => {
  for (const dir of LEGACY_BOOKS_DIRS(pluginName)) {
    if (p?.startsWith(`${dir}/`)) return dir;
  }
  return null;
};

/** 本地日期键 YYYY-MM-DD（按用户时区，非 UTC） */
function localDateKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export class BookshelfStore {
  private books: BookMeta[] = [];
  /** 用户自建分组（独立持久化，见 GROUPS_KEY） */
  private _groups: BookGroup[] = [];
  private loaded = false;
  /** 内部 Svelte store：让消费者可订阅书架变化（导入/删除/进度更新后自动刷新） */
  private _store = writable<BookMeta[]>([]);

  /**
   * 2026-11-15 开书提速：最近打开书籍的**文件缓存**（bookId → Blob，LRU）。
   *
   * 为什么需要：`getFileBlob` 每次都把整个书籍文件经 `/api/file/getFile`
   * 从磁盘搬到 WebView 内存（书架上 10–27 MB 的 EPUB 很常见，还有 176 MB 的 PDF）。
   * 关掉再开同一本书时，这份搬运会**原样再做一遍** —— 移动端 IO 与内存都弱，
   * 表现就是「每次点书都要等好几秒」。
   *
   * 预算按前端分档（Map 迭代顺序即插入顺序，命中时重新 set 到末尾即为 LRU）：
   *  · 桌面：单本 ≤ 160 MB，总计 ≤ 320 MB —— 大 PDF 也能缓存；
   *  · 移动：单本 ≤ 32 MB，总计 ≤ 64 MB —— WebView 进程内存有限，
   *    缓存过大反被系统回收（甚至 OOM），宁可重读。
   * 超过单本上限的文件一律不缓存：大 PDF 首次慢是文件本身决定的，缓存救不了它，
   * 但牺牲它换整机稳定是划算的。
   */
  private fileCache = new Map<string, Blob>();
  private fileCacheBytes = 0;

  /** 文件已确认丢失的书籍 id（书架据此给「重新导入」入口） */
  private missingSet = new Set<string>();
  private _missing = writable<Set<string>>(new Set());
  /** 目录清单缓存：迁移/缺失探测按目录批量判断，避免逐本发请求 */
  private dirCache = new Map<string, Set<string>>();
  /** 探测期间发生导入/删除/读成功时递增，旧探测结果作废 */
  private presenceEpoch = 0;

  constructor(private plugin: any) {}

  /** 实现 Svelte store 契约：返回退订函数 */
  subscribe(run: (value: BookMeta[]) => void, invalidate?: (value?: BookMeta[]) => void): () => void {
    return this._store.subscribe(run, invalidate as any);
  }

  /** 文件缺失集合（只读订阅） */
  get missing() {
    return this._missing;
  }

  get list(): BookMeta[] {
    return [...this.books].sort((a, b) => (b.lastReadAt ?? b.addedAt) - (a.lastReadAt ?? a.addedAt));
  }

  get(id: string): BookMeta | undefined {
    return this.books.find((b) => b.id === id);
  }

  async load(): Promise<void> {
    if (this.loaded) {
      this._store.set([...this.books]);
      return;
    }
    // 安全恢复：主索引损坏回退 .bak、单条损坏 quarantine 保留其余
    const idx = await loadLibraryIndex<BookMeta>(this.plugin, INDEX_KEY, isValidBookMeta);
    this.books = idx.data;
    const groups = await loadLibraryIndex<BookGroup>(this.plugin, GROUPS_KEY, isValidBookGroup);
    this._groups = groups.data;
    this.loaded = true;
    // 恢复场景自愈：主索引/分组损坏或含坏条 → 把清洗后的数据写回，避免下次再走恢复路径
    if (
      idx.primaryFailed || idx.quarantined.length > 0 ||
      groups.primaryFailed || groups.quarantined.length > 0
    ) {
      await this.save();
      await this.saveGroups();
    }
    this._store.set([...this.books]);
    // 迁移旧目录 + 探测缺失文件：都要读目录/拷文件，放后台，不阻塞书架首屏
    void this.afterLoad();
  }

  private async afterLoad(): Promise<void> {
    // Node 测试环境没有思源的文件 API，跳过所有磁盘探测
    if (typeof document === "undefined") return;
    try {
      await this.migrateLegacyBooks();
    } catch (e) {
      logSwallow(e, "bookshelf-store.ts · migrateLegacyBooks", "warn");
    }
    try {
      await this.refreshMissing();
    } catch (e) {
      logSwallow(e, "bookshelf-store.ts · refreshMissing", "warn");
    }
  }

  /**
   * 一次性把历史目录里的书搬到 public 目录。
   * 历史目录有两级：petal/books（0.11.4/0.11.5）与 plugins/books（≤0.11.3）。
   * 幂等且可断点续跑：目标是「存在就只改索引、不存在就搬」，索引只写一次；
   * 中途崩溃下次按同一规则补上。
   *
   * 优先用内核 rename（同盘秒级、不占内存）；
   * 失败场景（跨盘/权限）再退化为「读成 Blob 再上传」。
   *
   * 2026-11-25 修：rename 前必须先建目标目录 —— 内核的 renameFile 不会
   * 自动创建 newPath 的父目录，petal/<name>/books 不存在时每次 rename 都失败，
   * 于是每本书都退化成「整本读进内存再上传」（292 MB 书库的迁移会变成内存事故）。
   *
   * 迁移结果写 `storage-migration.json`（不是逻辑门，纯排障用）：
   * 出问题能一眼看出「跑过没、搬了几本、几个字节、失败了几个」。
   */
  private async migrateLegacyBooks(): Promise<void> {
    const pluginName = this.plugin.name;
    const dir = BOOKS_DIR(pluginName);
    // 封面单独判断：书搬成功但封面失败时，下次仍要为封面重试
    const pending = this.books.filter(
      (b) => legacySourceOf(pluginName, b.path) || legacySourceOf(pluginName, b.cover)
    );
    if (!pending.length) return;

    // 目标目录先就位（renameFile 不会替我们建父目录）
    let dirReady = false;
    const ensureDir = async (target: string): Promise<boolean> => {
      if (dirReady && target === dir) return true;
      const ok = await putFile(target, true, null);
      this.dirCache.delete(target);
      if (target === dir) dirReady = !!ok;
      return !!ok;
    };
    await ensureDir(dir);

    const stale: string[] = [];
    const stat = { files: 0, covers: 0, bytes: 0, renamed: 0, copied: 0, failed: 0 };
    let changed = false;
    for (const meta of pending) {
      try {
        const pathSrc = legacySourceOf(pluginName, meta.path);
        if (pathSrc && meta.path) {
          const oldPath = meta.path;
          const name = oldPath.slice(pathSrc.length + 1);
          const dest = `${dir}/${name}`;
          const destState = await this.fileExists(dest);
          if (destState === null) continue; // 目录读不出来：别改索引，下次再试
          if (!destState) {
            if (await renameFile(oldPath, dest)) {
              stat.renamed++;
            } else {
              // 退路：读原文件再写目标（跨盘/权限差异时 rename 会失败）
              const blob = await getFileBlob(oldPath);
              if (!blob) {
                if (!(await this.listFiles(dir, true))?.has(name)) {
                  // rename 与旧文件都失败：保留原路径，交给 refreshMissing 标「已丢失」
                  stat.failed++;
                  continue;
                }
              } else {
                if (!(await putFile(dest, false, blob))) {
                  stat.failed++;
                  continue;
                }
                stat.copied++;
              }
            }
          }
          meta.path = dest;
          stale.push(oldPath);
          stat.files++;
          stat.bytes += meta.size || 0;
          changed = true;
        }
        const coverSrc = legacySourceOf(pluginName, meta.cover);
        if (coverSrc && meta.cover) {
          const oldCover = meta.cover;
          const coverName = oldCover.slice(coverSrc.length + 1);
          const coverDest = `${dir}/${coverName}`;
          if ((await this.fileExists(coverDest)) === false) {
            // covers/ 子目录同样要先生成
            if (coverName.includes("/")) await ensureDir(`${dir}/${coverName.slice(0, coverName.lastIndexOf("/"))}`);
            if (!(await renameFile(oldCover, coverDest))) {
              const coverBlob = await getFileBlob(oldCover);
              if (coverBlob) await putFile(coverDest, false, coverBlob);
            }
          }
          if (await this.fileExists(coverDest)) {
            meta.cover = coverDest;
            stale.push(oldCover);
            stat.covers++;
            changed = true;
          }
        }
      } catch (e) {
        stat.failed++;
        logSwallow(e, `bookshelf-store.ts · migrate ${meta.id}`, "warn");
      }
    }
    if (!changed) return;
    this.dirCache.clear();
    await this.save();
    this._store.set([...this.books]);
    // rename 成功后旧路径已不存在，removeFile 只是兜底清掉「复制」路径留下的原件
    for (const p of stale) {
      try {
        await removeFile(p);
      } catch (__swallowErr) {
        logSwallow(__swallowErr, "bookshelf-store.ts · migrate rmOld", "debug");
      }
    }
    await this.writeMigrationMarker(stat);
  }

  /**
   * 写迁移标记（诊断用，最多保留最近 10 次）。
   *
   * 为什么单独一个文件而不是塞进书架索引：索引是「用户数据」，标记是「运维记录」，
   * 混在一起会让索引 schema 变动、也会被导出/同步当成书单处理。
   */
  private async writeMigrationMarker(stat: {
    files: number; covers: number; bytes: number;
    renamed: number; copied: number; failed: number;
  }): Promise<void> {
    // 标记也放 public：写 petal 会触发插件重载（内核 push_reload），迁移刚跑完
    // 就被重载打断，下次又要从头探一遍。
    const path = `/data/public/${this.plugin.name}/storage-migration.json`;
    try {
      const prevBlob = await getFileBlob(path);
      let runs: unknown[] = [];
      if (prevBlob) {
        const prev = JSON.parse(await prevBlob.text());
        if (Array.isArray(prev?.runs)) runs = prev.runs;
      }
      runs.push({
        at: Date.now(),
        from: LEGACY_BOOKS_DIRS(this.plugin.name),
        to: BOOKS_DIR(this.plugin.name),
        ...stat,
      });
      const body = JSON.stringify({ v: 1, runs: runs.slice(-10) }, null, 2);
      await putFile(path, false, new Blob([body], { type: "application/json" }));
    } catch (e) {
      logSwallow(e, "bookshelf-store.ts · writeMigrationMarker", "debug");
    }
  }

  /**
   * 目录内文件清单；目录不存在返回空集；无法判断返回 null。
   * 底层只读目录（file-probe.ts，字体那边共用），缓存留在这一层：
   * 书架一次要探几十本，同一目录重复问内核没有意义。
   */
  private async listFiles(dir: string, fresh = false): Promise<Set<string> | null> {
    if (!fresh) {
      const hit = this.dirCache.get(dir);
      if (hit) return hit;
    }
    const names = await listDirNames(dir);
    if (names) this.dirCache.set(dir, names);
    return names;
  }

  /** 文件是否在位：true 在 / false 不在 / null 无法判断 */
  private async fileExists(path: string): Promise<boolean | null> {
    if (!path) return false;
    const slash = path.lastIndexOf("/");
    const files = await this.listFiles(path.slice(0, slash));
    if (!files) return null;
    return files.has(path.slice(slash + 1));
  }

  /** 重新探测所有书籍文件是否在位（书架加载后调用一次） */
  async refreshMissing(): Promise<void> {
    if (typeof document === "undefined") return;
    const epoch = this.presenceEpoch;
    const next = new Set<string>();
    for (const b of this.books) {
      // 引用式书源没有本地副本，`fileExists("")` 必然为 false ⇒ 直接跳过，
      // 改由真正打开失败时标 missing（远端可用性只能靠实际访问判断）
      if (b.src) continue;
      if ((await this.fileExists(b.path)) === false) next.add(b.id);
    }
    // 探测期间有导入/删除/成功读文件：结果可能已过期，丢弃
    if (epoch !== this.presenceEpoch) return;
    const changed =
      next.size !== this.missingSet.size ||
      [...next].some((id) => !this.missingSet.has(id));
    this.missingSet = next;
    if (changed) this._missing.set(new Set(next));
  }

  private setMissing(id: string, missing: boolean): void {
    this.presenceEpoch++;
    if (this.missingSet.has(id) === missing) return;
    if (missing) this.missingSet.add(id);
    else this.missingSet.delete(id);
    this._missing.set(new Set(this.missingSet));
  }

  private async save(): Promise<void> {
    await saveLibraryIndex<BookMeta>(this.plugin, INDEX_KEY, this.books);
  }

  /**
   * 从 PDF 中解析元数据与封面
   * - 元数据：PDF.js getMetadata().info（Title / Author / Subject）
   * - 封面：渲染第 1 页为缩略图（scale 0.3, jpeg 80%）
   *
   * [REword patch 2026-08-29] PDF 适配 Phase 1：复用 foliate-js vendor 里的 pdf.mjs
   * pdf.mjs 第 45 行 `var __webpack_exports__ = globalThis.pdfjsLib = {};` 自挂载，
   * 这里动态 import 一次触发副作用即可拿到 pdfjsLib。
   *
   * 失败容错：解析失败不阻断导入（返回空对象，调用方用文件名 fallback）
   */
  private async extractPdfMeta(file: File): Promise<{
    title?: string;
    author?: string;
    cover?: { blob: Blob; ext: string };
  }> {
    // 2026-09-05：提到外层，供 finally 统一释放（原实现中途抛错即泄漏）
    let loadingTask: any = null;
    let pdf: any = null;
    try {
      // 动态 import 触发 pdf.mjs 自挂载到 globalThis.pdfjsLib
      // @ts-expect-error vendor/pdfjs/pdf.mjs 无 .d.ts，运行时类型已挂 globalThis
      await import("./vendor/foliate-js/vendor/pdfjs/pdf.mjs");
      const pdfjsLib = (globalThis as any).pdfjsLib;
      if (!pdfjsLib?.getDocument) return {};

      // PDF.js worker：与 foliate-js/pdf.js 一致，用独立 worker 文件
      // Phase 1.5：copy-dist.mjs 已把 pdf.worker.mjs 复制到插件根目录
      // 思源 webview 通过 /plugins/siyuan-plugin-reader/pdf.worker.mjs 访问
      // [P1 2026-10-23] 站点名改为本插件（siyuan-plugin-reader），PDF 资源不再依赖 siyuan-plugin-reword
      // [REword patch 2026-08-29] Phase 1 移动端：弱设备/iOS WKWebView 用主线程模式
      // 原因：iOS 15.4+ WKWebView 对 Web Worker 严格 CORS 校验，
      // 且 iOS 15.6 以下无 OffscreenCanvas，worker 加载失败导致白屏。
      // 弱设备（移动端 / < 4 核 / iOS）→ workerSrc 设空走 fake worker（主线程跑）
      try {
        const isWeakDevice = (() => {
          try {
            const ua = navigator.userAgent;
            const cores = navigator.hardwareConcurrency ?? 4;
            const isMob = /Mobi|Android|iPhone|iPad|iPod/.test(ua);
            const isIOS = /iPad|iPhone|iPod/.test(ua);
            return isMob || isIOS || cores < 4;
          } catch {
            return false;
          }
        })();
        if (isWeakDevice) {
          // 弱设备：禁用 worker，主线程同步跑（性能损失但能加载）
          pdfjsLib.GlobalWorkerOptions.workerSrc = "";
        } else {
          const origin = (typeof globalThis !== "undefined" && globalThis.location?.origin) || "";
          pdfjsLib.GlobalWorkerOptions.workerSrc = origin
            ? `${origin}/plugins/siyuan-plugin-reader/pdf.worker.mjs`
            : "./pdf.worker.mjs";
        }
      } catch {
        // ignore
      }

      const buf = new Uint8Array(await file.arrayBuffer());
      loadingTask = pdfjsLib.getDocument({
        data: buf,
        // [REword patch 2026-08-29] PDF 适配 Phase 1.5：恢复 worker 模式
        // 配合 workerSrc = /plugins/siyuan-plugin-reader/pdf.worker.mjs
        // Phase 1 的 disableWorker: true 已移除（详见 foliate-js/pdf.js 注释）
        // [REword patch 2026-08-29] 移动端：workerSrc 为空时 PDF.js 自动主线程跑
      });
      pdf = await loadingTask.promise;

      // 1. 元数据
      const info = await pdf.getMetadata().then((m: any) => m?.info ?? {});
      const title = (info?.Title || "").trim() || undefined;
      const author = (info?.Author || "").trim() || undefined;

      // 2. 封面：渲染第 1 页为缩略图
      let cover: { blob: Blob; ext: string } | undefined;
      try {
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 0.3 });
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));
        const ctx = canvas.getContext("2d");
        if (ctx) {
          await page.render({ canvasContext: ctx, viewport, canvas }).promise;
          const blob: Blob | null = await new Promise((resolve) =>
            canvas.toBlob((b) => resolve(b), "image/jpeg", 0.8)
          );
          if (blob) cover = { blob, ext: "jpg" };
        }
      } catch {
        // 封面渲染失败不阻断
      }

      return { title, author, cover };
    } catch {
      return {};
    } finally {
      // 2026-09-05：pdf.destroy() 只释放文档对象，必须再 loadingTask.destroy()
      // 才会真正终止 pdf.js 的 worker 线程；放进 finally 保证元数据/封面渲染
      // 中途抛错时也释放（原实现在抛错路径上整份 PDF 常驻）。
      try { await pdf?.destroy?.(); } catch { /* ignore */ }
      try { await loadingTask?.destroy?.(); } catch { /* ignore */ }
    }
  }

  /**
   * 从 EPUB 中解析元数据与封面（**按需解压**，三趟点名）
   * - 元数据：OPF 的 dc:title / dc:creator / dc:language
   * - 封面：container.xml → OPF → meta[name=cover] → manifest item
   *
   * 2026-11-25 内存优化：此前 `unzipSync(buf)` 不带 filter，会把整本全部条目
   * （实测 809 个，含图片与字体）一次性 inflate 进内存，只为读三样小东西。
   * 实测 27.3 MB 的 EPUB：读入 +27 MB、全量解压再 +57 MB，RSS 峰值 +84 MB（≈3.1×）。
   * 批量导入时每本都来一次这种尖峰，是「导入多本书内存膨胀」的直接来源。
   *
   * 现在每趟只解压点名的那几个条目：解压量从「整本」降到「几十 KB + 一张封面」，
   * 且封面超过 EPUB_COVER_MAX 时直接放弃（封面只是书架缩略图，不值得为它换内存）。
   */
  private static readonly EPUB_COVER_MAX = 8 * 1024 * 1024;

  private async extractEpubMeta(file: File): Promise<{
    title?: string;
    author?: string;
    language?: string;
    identifier?: string;
    cover?: { blob: Blob; ext: string };
  }> {
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      /** 只解压点名条目（fflate 的 filter 在 inflate 之前就拦掉，其余条目零成本） */
      const pick = (names: string[], maxSize?: number): Record<string, Uint8Array> => {
        const want = new Set(names);
        return unzipSync(buf, {
          filter: (f) => want.has(f.name) && (maxSize === undefined || f.originalSize <= maxSize),
        });
      };
      const decode = (bytes: Uint8Array | undefined): string | null =>
        bytes ? new TextDecoder().decode(bytes) : null;
      // 1. container.xml → OPF 路径（通常几百字节）
      const containerXml = decode(pick(["META-INF/container.xml"])["META-INF/container.xml"]);
      if (!containerXml) return {};
      const rootfile = parseContainerXml(containerXml);
      if (!rootfile) return {};
      // 2. OPF → 元数据 + 封面（通常几十 KB）
      const opfXml = decode(pick([rootfile])[rootfile]);
      if (!opfXml) return {};
      // 解析与远端引用共用一份实现（epub-opf.ts），保证两条路径字段一致
      const info = parseOpf(opfXml, rootfile);
      // 3. 封面：只解压这一张（超 EPUB_COVER_MAX 直接跳过 ⇒ cover 不设）
      //    OPF 里偶有 URL 编码的 href（空格写成 %20），按原名取不到再试解码一次
      let cover: { blob: Blob; ext: string } | undefined;
      if (info.cover) {
        const clean = info.cover.href;
        let data = pick([info.dir + clean], BookshelfStore.EPUB_COVER_MAX)[info.dir + clean];
        if (!data) {
          try {
            const decoded = info.dir + decodeURIComponent(clean);
            data = pick([decoded], BookshelfStore.EPUB_COVER_MAX)[decoded];
          } catch { /* 非法编码：保持原样 */ }
        }
        if (data) {
          const ext = coverExtOf(clean);
          // 复制一次（≤8 MB）：既满足 BlobPart 的 ArrayBuffer 约束，
          // 也让封面不再挂着整份 zip 输入缓冲（否则封面 Blob 会把书本体钉在内存里）
          cover = { blob: new Blob([new Uint8Array(data)], { type: coverMimeOf(ext, info.cover.mediaType) }), ext };
        }
      }
      return {
        title: info.title,
        author: info.author,
        language: info.language,
        identifier: info.identifier,
        cover,
      };
    } catch {
      return {}; // 解析失败不阻断导入
    }
  }

  /**
   * 导入书籍：上传文件到思源 + 提取元数据/封面 + 登记书架
   * @returns 新书的 meta；返回 null 表示与已有书重复（文件名+大小一致），已跳过
   */
  async importBook(file: File): Promise<BookMeta | null> {
    await this.load();
    const ext = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] ?? "epub").toLowerCase();
    const nameBase = file.name.replace(/\.(epub|mobi|azw3|fb2|cbz|pdf|txt|md|markdown)$/i, "") || file.name;
    // 去重：同名(去扩展名)+同大小视为重复；但文件已确认丢失时不算重复，
    // 走下面的「恢复到原书目」流程（用户重导同一本书即可找回进度/批注）
    const dup = this.books.find(
      (b) => b.title.toLowerCase() === nameBase.toLowerCase() && b.size === file.size
    );
    if (dup && (await this.fileExists(dup.path)) !== false) return null;

    // 先提取元数据（EPUB/PDF），以便用「内容指纹」生成稳定 bookId
    let title: string | undefined;
    let author: string | undefined;
    let language: string | undefined;
    let identifier: string | undefined;
    let coverBlob: { blob: Blob; ext: string } | undefined;
    if (ext === "epub") {
      const meta = await this.extractEpubMeta(file);
      title = meta.title;
      author = meta.author;
      language = meta.language;
      identifier = meta.identifier;
      coverBlob = meta.cover;
    } else if (ext === "pdf") {
      // [REword patch 2026-08-29] PDF 适配 Phase 1：元数据 + 首页封面
      const meta = await this.extractPdfMeta(file);
      title = meta.title;
      author = meta.author;
      coverBlob = meta.cover;
    }

    // 内容指纹 → 稳定 id：同一实体书无论导入几次、删除后重导，
    // 永远得到同一 id，复用同一份 translations/<id>.json 缓存，
    // 从根本上避免「同一本书多份缓存翻译」。
    const id = bookFingerprint({
      identifier,
      title: title || nameBase,
      author,
      size: file.size,
      format: ext === "markdown" ? "md" : ext,
    });
    // 指纹级去重：文件还在就跳过；文件已确认丢失则复用原书目（进度/批注自动接回）
    const existing = this.books.find((b) => b.id === id);
    if (existing && (await this.fileExists(existing.path)) !== false) return null;
    const restore = existing ?? dup ?? null;
    // 恢复时沿用原书目 id 命名文件：dup 命中的旧 id 未必等于本次指纹 id
    const fileId = restore?.id ?? id;

    const dir = BOOKS_DIR(this.plugin.name);
    const path = `${dir}/${fileId}.${ext}`;
    try {
      await putFile(dir, true, null);
    } catch (__swallowErr) {
      logSwallow(__swallowErr, "bookshelf-store.ts · importBook mkdir books", "debug");
    }
    const ok = await putFile(path, false, file);
    if (!ok) throw new Error(`书籍上传失败: ${file.name}`);
    this.dirCache.delete(dir);

    let cover: string | undefined;
    if (coverBlob) {
      try {
        await putFile(`${dir}/covers`, true, null);
      } catch (__swallowErr) { logSwallow(__swallowErr, "bookshelf-store.ts · importBook mkdir covers", "debug"); }
      const coverPath = `${dir}/covers/${fileId}.${coverBlob.ext}`;
      const coverOk = await putFile(coverPath, false, coverBlob.blob);
      if (coverOk) cover = coverPath;
      this.dirCache.delete(`${dir}/covers`);
    }
    if (restore) {
      this.forgetFile(id);
      restore.path = path;
      restore.size = file.size;
      // 原本是引用式书源：现在有了副本，指针必须清掉（否则 getBlob 仍按引用取）
      delete restore.src;
      if (cover) restore.cover = cover;
      this.setMissing(id, false);
      await this.save();
      this._store.set([...this.books]);
      return restore;
    }
    const book: BookMeta = {
      id,
      title: title || nameBase,
      author,
      language,
      format: ext === "markdown" ? "md" : ext,
      path,
      cover,
      size: file.size,
      addedAt: Date.now(),
      lastReadAt: Date.now(),
    };
    this.books.push(book);
    await this.save();
    this._store.set([...this.books]);
    return book;
  }

  /**
   * 引用式导入（2026-11-25 C 期）：只登记指针，**不复制文件**。
   *
   * 与 `importBook` 的区别：
   *  - 书还在原处（思源资源 / public / http 直链），书库里没有副本 ⇒ 不占双份磁盘、
   *    不把整本塞进同步、导入瞬间完成；
   *  - 元数据优先走 Range 只读三个条目（container/OPF/封面），**不下载整本**；
   *    服务器不支持 Range 时退化为「只放指针、标题用文件名」，绝不为了书名搬 148 MB；
   *  - `path` 留空串，`src` 记引用；`getBlob` 打开时按引用取。
   *
   * @returns 新书 meta；返回 null 表示该引用已在架上（判重跳过）
   */
  async importByRef(input: string): Promise<BookMeta | null> {
    await this.load();
    const ref = parseBookRef(input);
    // ⚠️ 文案里不要出现双斜杠：测试 loader 会把 `//` 之后当注释抹掉（含字符串内），
    //    这类文件（带 constructor 参数属性）一旦命中，import 直接语法错误。
    if (!ref) throw new Error("无法识别的书源（支持 assets/… 、/data/… 、http 或 https 链接）");
    if (!isSupportedRef(ref)) throw new Error("不支持的文件类型");

    const key = bookRefKey(ref);
    const dup = this.books.find((b) => b.src && bookRefKey(b.src) === key);
    if (dup) return null;

    const ext = bookRefExt(ref);
    const name = bookRefName(ref);
    const nameBase = name.replace(/\.(epub|mobi|azw3|fb2|cbz|pdf|txt|md|markdown)$/i, "") || name;

    let title: string | undefined;
    let author: string | undefined;
    let language: string | undefined;
    let identifier: string | undefined;
    let coverBlob: { blob: Blob; ext: string } | undefined;
    let size = 0;

    const url = bookRefUrl(ref);
    if (url) {
      // 先探大小（HEAD / Range 0-0）：失败说明引用不可达，直接报错而不是建一条死记录
      const { RangeZip } = await import("./zip-range.ts");
      size = await RangeZip.probeSize(url);
      if (ext === "epub") {
        const remote = await extractEpubMetaRemote(url, size);
        if (remote) {
          title = remote.title;
          author = remote.author;
          language = remote.language;
          identifier = remote.identifier;
          coverBlob = remote.cover;
        }
      }
    } else {
      // 内核路径（/data/… 但不在 public 下）：只能整本读一次
      const blob = await getFileBlob(ref.uri);
      if (!blob) throw new Error("引用文件不存在或不可读");
      size = blob.size;
      if (ext === "epub") {
        const meta = await this.extractEpubMeta(new File([blob], name, { type: "application/epub+zip" }));
        title = meta.title;
        author = meta.author;
        language = meta.language;
        identifier = meta.identifier;
        coverBlob = meta.cover;
      }
    }

    const id = bookFingerprint({
      identifier,
      title: title || nameBase,
      author,
      size,
      format: ext === "markdown" ? "md" : ext,
    });
    // 与已有书库副本同一个实体书 ⇒ 视为重复（宁可让用户用副本，也不建两份进度）
    if (this.books.some((b) => b.id === id)) return null;

    const dir = BOOKS_DIR(this.plugin.name);
    let cover: string | undefined;
    if (coverBlob) {
      try {
        await putFile(`${dir}/covers`, true, null);
      } catch (__swallowErr) { logSwallow(__swallowErr, "bookshelf-store.ts · importByRef mkdir covers", "debug"); }
      const coverPath = `${dir}/covers/${id}.${coverBlob.ext}`;
      if (await putFile(coverPath, false, coverBlob.blob)) {
        cover = coverPath;
        this.dirCache.delete(`${dir}/covers`);
      }
    }

    const book: BookMeta = {
      id,
      title: title || nameBase,
      author,
      language,
      format: ext === "markdown" ? "md" : ext,
      path: "",
      src: { kind: ref.kind, uri: ref.uri },
      cover,
      size,
      addedAt: Date.now(),
      lastReadAt: Date.now(),
    };
    this.books.push(book);
    await this.save();
    this._store.set([...this.books]);
    return book;
  }
  /**
   * 2026-10-15 OPDS 书源元数据补全（参照 readest #5270：目录源元数据优先）：
   * 导入后用书源提供的 title/author 覆盖文件内嵌缺省值；封面 dataURL 落盘 covers
   * 目录并改写 meta.cover。全程 best-effort：任何一步失败返回 false 不阻断导入。
   */
  async enrichFromOpds(
    id: string,
    patch: { title?: string; author?: string; coverDataUrl?: string }
  ): Promise<boolean> {
    await this.load();
    const meta = this.get(id);
    if (!meta) return false;
    try {
      if (patch.title?.trim()) meta.title = patch.title.trim();
      if (patch.author?.trim()) meta.author = patch.author.trim();
      if (patch.coverDataUrl?.startsWith("data:image/")) {
        const res = await fetch(patch.coverDataUrl);
        const blob = await res.blob();
        const mime = blob.type || "image/jpeg";
        const ext = /png/i.test(mime) ? "png" : /webp/i.test(mime) ? "webp" : "jpg";
        const dir = BOOKS_DIR(this.plugin.name);
        try {
          await putFile(`${dir}/covers`, true, null);
        } catch (__swallowErr) { logSwallow(__swallowErr, "bookshelf-store.ts · enrichFromOpds mkdir covers", "debug"); }
        const coverPath = `${dir}/covers/${id}.${ext}`;
        const ok = await putFile(coverPath, false, blob);
        if (ok) meta.cover = coverPath;
      }
      await this.save();
      this._store.set([...this.books]);
      return true;
    } catch (e) {
      logSwallow(e, "bookshelf-store.ts · enrichFromOpds", "debug");
      return false;
    }
  }

  /**
   * 更新书籍元信息，返回是否成功
   * [2026-08-29] 从「书名/作者」扩展到丛书 / 状态 / 评分 / 收藏 / 标签 / 分组
   * 空串语义：author / series 传 "" = 清空该字段（转 undefined）
   */
  async updateMeta(
    id: string,
    patch: Partial<
      Pick<
        BookMeta,
        | "title"
        | "author"
        | "series"
        | "status"
        | "rating"
        | "favorite"
        | "tags"
        | "groupId"
        | "bookmarks"
        | "color"
        | "order"
        | "notebookTarget"
      >
    >
  ): Promise<boolean> {
    await this.load();
    const meta = this.get(id);
    if (!meta) return false;
    if (typeof patch.title === "string" && patch.title.trim()) meta.title = patch.title.trim();
    if (patch.author !== undefined) meta.author = patch.author.trim() || undefined;
    if (patch.series !== undefined) meta.series = patch.series.trim() || undefined;
    if (patch.status !== undefined) meta.status = patch.status;
    if (patch.rating !== undefined) {
      const r = Math.max(0, Math.min(5, Math.round(patch.rating)));
      meta.rating = r > 0 ? r : undefined;
    }
    if (patch.favorite !== undefined) meta.favorite = patch.favorite || undefined;
    if (patch.tags !== undefined) {
      const clean = Array.from(new Set(patch.tags.map((t) => t.trim()).filter(Boolean)));
      meta.tags = clean.length ? clean : undefined;
    }
    if (patch.groupId !== undefined) meta.groupId = patch.groupId || undefined;
    // [2026-08-29] P2:颜色 / 手动排序
    if (patch.color !== undefined) {
      meta.color = isValidBookColor(patch.color) ? patch.color : undefined;
    }
    if (patch.order !== undefined) {
      const o = Number(patch.order);
      meta.order = Number.isFinite(o) ? o : undefined;
    }
    // [2026-10-09] 每本书的笔记发送目标。
    // ⚠️ 语义：`docId` 为空串 = **解除绑定**（字段变undefined = "从未绑定"）。
    //   两者不同，不要混。docId 缺失时保持字段不变（Partial 的语义）。
    if (patch.notebookTarget !== undefined) {
      const docId = String(patch.notebookTarget?.docId ?? "").trim();
      meta.notebookTarget = docId
        ? {
            docId,
            docTitle: patch.notebookTarget?.docTitle?.trim() || undefined,
            notebookName: patch.notebookTarget?.notebookName?.trim() || undefined,
            boundAt:
              typeof patch.notebookTarget?.boundAt === "number"
                ? patch.notebookTarget.boundAt
                : Date.now(),
          }
        : undefined;
    }
    if (patch.bookmarks !== undefined) {
      const clean = patch.bookmarks
        .filter((b) => b && typeof b.cfi === "string" && b.cfi)
        .map((b) => ({
          id: b.id || `bm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          cfi: b.cfi,
          label: b.label?.trim() || undefined,
          excerpt: b.excerpt?.trim() || undefined,
          createdAt: typeof b.createdAt === "number" ? b.createdAt : Date.now(),
        }))
        .sort((a, b) => a.createdAt - b.createdAt);
      meta.bookmarks = clean.length ? clean : undefined;
    }
    await this.save();
    this._store.set([...this.books]);
    return true;
  }

  /** 读取书籍封面 Blob（无封面返回 null） */
  async getCoverBlob(id: string): Promise<Blob | null> {
    await this.load();
    const meta = this.get(id);
    if (!meta?.cover) return null;
    return getFileBlob(meta.cover);
  }

  /** 读取书籍文件为 Blob（命中文件缓存时不再走磁盘；引用式书源按引用取） */
  async getBlob(id: string): Promise<Blob | null> {
    await this.load();
    const meta = this.get(id);
    if (!meta) return null;
    const cached = this.fileCache.get(id);
    if (cached) {
      // LRU：命中后挪到末尾（Map 迭代顺序 = 插入顺序）
      this.fileCache.delete(id);
      this.fileCache.set(id, cached);
      return cached;
    }
    const blob = meta.src ? await loadRefBlob(meta.src.uri, meta.src.kind) : await getFileBlob(meta.path);
    if (blob) {
      this.setMissing(id, false);
      this.rememberFile(id, blob);
    } else {
      // 文件确实读不到：标「已丢失」，书架给出重新导入入口
      this.setMissing(id, true);
    }
    return blob;
  }

  /** 把刚读到的书籍文件放进缓存（超预算则跳过或淘汰最旧的） */
  private rememberFile(id: string, blob: Blob): void {
    const mobile = isMobile();
    const maxOne = mobile ? 32 * 1024 * 1024 : 160 * 1024 * 1024;
    const maxTotal = mobile ? 64 * 1024 * 1024 : 320 * 1024 * 1024;
    if (blob.size > maxOne) return;
    // 同一本书被重新导入（同 id 新文件）时先减掉旧值，避免重复计数
    const prev = this.fileCache.get(id);
    if (prev) {
      this.fileCacheBytes -= prev.size;
      this.fileCache.delete(id);
    }
    this.fileCache.set(id, blob);
    this.fileCacheBytes += blob.size;
    // 超总量：从最旧的开始淘汰，但绝不淘汰刚放进去的这本
    while (this.fileCacheBytes > maxTotal && this.fileCache.size > 1) {
      const oldest = this.fileCache.keys().next().value as string | undefined;
      if (oldest === undefined || oldest === id) break;
      const old = this.fileCache.get(oldest);
      this.fileCache.delete(oldest);
      if (old) this.fileCacheBytes -= old.size;
    }
  }

  /** 书籍删除/替换时清缓存，避免继续读到旧文件 */
  private forgetFile(id: string): void {
    const old = this.fileCache.get(id);
    if (!old) return;
    this.fileCache.delete(id);
    this.fileCacheBytes -= old.size;
  }

  /**
   * 关闭阅读页签时释放该书的文件缓存（2026-11-25 内存水位修复）。
   *
   * 此前 `fileCache` 只在删除/重导入时清理，**关书不释放**：桌面端上限 320 MB，
   * 于是「读得越多、水位越高」，读五六本大书后进程常驻几百 MB 且不再回落 ——
   * 这正是用户感受到的「多本书内存膨胀」。
   *
   * 现在语义改成「缓存跟着打开的书走」：页签销毁即释放，重开时重新读一次磁盘
   * （本地 30 MB 约 0.2 s，比长期常驻 320 MB 划算；大书重开本来就要等）。
   * 注意只摘缓存条目、不打断仍持有该 Blob 的其他页签（它们各自握着引用）。
   */
  releaseFileCache(id: string): void {
    this.forgetFile(id);
  }

  /**
   * 从书架移除书籍
   * - 默认只移除索引（源文件保留在插件目录，便于重新导入/回收）
   * - deleteFile=true 时同时删除源文件与封面
   */
  async removeBook(id: string, opts: { deleteFile?: boolean } = {}): Promise<void> {
    await this.load();
    const meta = this.get(id);
    if (meta) {
      // 2026-11-15：先清文件缓存，防止「删了还能从缓存里打开」
      this.forgetFile(id);
      if (opts.deleteFile) {
        // 引用式书源没有副本：绝不能 removeFile("")，更不能去删用户的源文件
        // （引用语义 = 删除书目只解除登记，不动原处文件）
        if (meta.path) {
          try {
            await removeFile(meta.path);
          } catch (__swallowErr) { logSwallow(__swallowErr, "bookshelf-store.ts · removeBook", "warn"); }
        }
        if (meta.cover) {
          try {
            await removeFile(meta.cover);
          } catch (__swallowErr) { logSwallow(__swallowErr, "bookshelf-store.ts · removeBook", "warn"); }
        }
      }
      this.books = this.books.filter((b) => b.id !== id);
      this.setMissing(id, false);
      this.dirCache.clear();
      await this.save();
      this._store.set([...this.books]);
    }
  }

  /**
   * 累加阅读时长（毫秒）；同时按本地日期写入 readingLog 分桶（用于日历热力图）。
   * @param dayKey 可选：该段时长「累加所属」的本地日期（YYYY-MM-DD）。
   *   缺省取**落盘时刻** —— 23:58 开始读、00:02 落盘会把这段记到次日。
   *   计时器侧显式传入本段所属日期键即可修正（跨日阅读归桶错误）。
   *   老调用方不传第三参，行为完全不变。
   */
  async addReadingTime(id: string, ms: number, dayKey?: string): Promise<void> {
    await this.load();
    const meta = this.get(id);
    if (!meta || ms <= 0) return;
    const delta = Math.round(ms);
    meta.readingTimeMs = (meta.readingTimeMs || 0) + delta;
    const day = dayKey || localDateKey();
    meta.readingLog = meta.readingLog || {};
    meta.readingLog[day] = (meta.readingLog[day] || 0) + delta;
    await this.save();
    this._store.set([...this.books]);
  }

  /**
   * 保存阅读进度（防抖由调用方控制）
   *
   * 🔴 2026-10-09 改为**合并式**写入。
   *
   * 此前是`meta.progress = progress`（整体替换）。调用方
   * `scheduleProgressSave` 虽然会把多次改动合并进一个 pending，但那只在
   * **同一次 pending 内**有效：一旦某次落盘的 payload 不含某个字段，
   * 该字段就会被整体替换抹掉。
   *
   * 实锤场景（已用脚本复现）：用户读了 5 章（已落盘 visitedHrefs），
   * 随后只缩放一次（`scheduleProgressSave({ zoom })`）就立刻关书
   * ⇒ flush 写盘时 payload 里没有 visitedHrefs ⇒ **5 条已读记录全丢**。
   *
   * 这类"某条路径少传一个字段 ⇒ 静默丢历史"的 bug 极难查
   * （位置恢复是对的、缩放是对的，只有已读数变0），所以修在**写入层**：
   * 新字段以合并进旧值的方式落盘，任何调用路径都不会丢。
   *
   * ⚠️ `undefined` 值视为「本次未涉及该字段」⇒ 不覆盖旧值。
   *   调用方若真要清空某个字段，需显式传 `null`（`{...prev, k: null}` 可生效）。
   */
  async saveProgress(id: string, progress: ReadingProgress): Promise<void> {
    await this.load();
    const meta = this.get(id);
    if (!meta) return;
    const prev = meta.progress ?? {};
    const next: ReadingProgress = { ...prev };
    for (const [k, v] of Object.entries(progress)) {
      if (v !== undefined) (next as any)[k] = v;
    }
    meta.progress = next;
    meta.lastReadAt = Date.now();
    // [2026-08-29] 阅读状态自动流转：读到 99.5%+ 记「读完」；
    // 只在 unread/未设置时自动置「在读」，避免覆盖用户手动标记的 finished
    const frac = typeof next.fraction === "number" ? next.fraction : undefined;
    if (typeof frac === "number" && frac >= 0.995) meta.status = "finished";
    else if (!meta.status || meta.status === "unread") meta.status = "reading";
    await this.save();
    this._store.set([...this.books]);
  }

  getProgress(id: string): ReadingProgress | undefined {
    return this.get(id)?.progress;
  }

  /* ================================================================
   * 2026-08-29 书架 P0/P1 API：搜索 / 排序 / 筛选 / 分组 / 标签 / 批量
   * ================================================================ */

  /** 当前所有用户分组（按创建时间升序） */
  get groups(): BookGroup[] {
    return [...this._groups].sort((a, b) => a.createdAt - b.createdAt);
  }

  private async saveGroups(): Promise<void> {
    await saveLibraryIndex<BookGroup>(this.plugin, GROUPS_KEY, this._groups);
  }

  /** 新建分组；同名直接复用已有，返回分组对象 */
  async createGroup(name: string): Promise<BookGroup | null> {
    await this.load();
    const n = name.trim();
    if (!n) return null;
    const exist = this._groups.find((g) => g.name === n);
    if (exist) return exist;
    const g: BookGroup = {
      id: `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name: n,
      createdAt: Date.now(),
    };
    this._groups.push(g);
    await this.saveGroups();
    this._store.set([...this.books]);
    return g;
  }

  /** 重命名分组 */
  async renameGroup(id: string, name: string): Promise<boolean> {
    await this.load();
    const g = this._groups.find((x) => x.id === id);
    const n = name.trim();
    if (!g || !n) return false;
    g.name = n;
    await this.saveGroups();
    this._store.set([...this.books]);
    return true;
  }

  /** 删除分组：组内书籍回到「未分组」，书本身不删 */
  async deleteGroup(id: string): Promise<void> {
    await this.load();
    this._groups = this._groups.filter((g) => g.id !== id);
    let touched = false;
    for (const b of this.books) {
      if (b.groupId === id) {
        b.groupId = undefined;
        touched = true;
      }
    }
    await this.saveGroups();
    if (touched) await this.save();
    this._store.set([...this.books]);
  }

  /** 单本设置阅读状态 */
  async setStatus(id: string, status: BookStatus): Promise<boolean> {
    return this.updateMeta(id, { status });
  }

  /** 单本设置评分（0 = 清空） */
  async setRating(id: string, rating: number): Promise<boolean> {
    return this.updateMeta(id, { rating });
  }

  /** 切换收藏星标，返回切换后的状态 */
  async toggleFavorite(id: string): Promise<boolean> {
    await this.load();
    const meta = this.get(id);
    if (!meta) return false;
    const next = !meta.favorite;
    await this.updateMeta(id, { favorite: next });
    return next;
  }

  /** 单本移入/移出分组（groupId 省略 = 移出） */
  async setGroup(id: string, groupId?: string): Promise<boolean> {
    return this.updateMeta(id, { groupId: groupId ?? "" });
  }

  /* =============2026-10-09 每本书的笔记发送目标 ============= */

  /**
   * 绑定/ 解除本书的笔记发送目标。
   *
   * `docId` 传空串 = **解除绑定**（与"从未绑定"不同：后者是字段缺失）。
   *
   * ⚠️ 解除绑定时**不清除**任何全局设置 —— 用户可能还指着用全局兜底，
   *   而"我的设置丢了"比"要重新配一次"更让人烦躁。
   */
  async setNotebookTarget(
    id: string,
    target:
      | { docId: string; docTitle?: string; notebookName?: string }
      | ""
      | null
      | undefined,
  ): Promise<boolean> {
    if (target === "" || target === null || target === undefined) {
      return this.updateMeta(id, { notebookTarget: { docId: "" } });
    }
    const docId = String(target.docId ?? "").trim();
    if (!docId) return this.updateMeta(id, { notebookTarget: { docId: "" } });
    return this.updateMeta(id, {
      notebookTarget: {
        docId,
        docTitle: target.docTitle,
        notebookName: target.notebookName,
        boundAt: Date.now(),
      },
    });
  }

  /** 取本书的发送目标（未绑定 = null；**不做全局回落**，回落由调用方决定） */
  getNotebookTarget(id: string): BookMeta["notebookTarget"] | null {
    const t = this.get(id)?.notebookTarget;
    return t?.docId ? t : null;
  }

  /** 给单本加标签（已存在则忽略） */
  async addTag(id: string, tag: string): Promise<boolean> {
    await this.load();
    const meta = this.get(id);
    const t = tag.trim();
    if (!meta || !t) return false;
    const next = Array.from(new Set([...(meta.tags ?? []), t]));
    return this.updateMeta(id, { tags: next });
  }

  /** 移除单本的某个标签 */
  async removeTag(id: string, tag: string): Promise<boolean> {
    await this.load();
    const meta = this.get(id);
    if (!meta) return false;
    const next = (meta.tags ?? []).filter((t) => t !== tag);
    return this.updateMeta(id, { tags: next });
  }

  /* ===================== 2026-08-29 P2:颜色 / 排序 ===================== */

  /** 单本设色(color = undefined 表示移除颜色) */
  async setColor(id: string, color?: BookColor): Promise<boolean> {
    return this.updateMeta(id, { color });
  }

  /** 单本在同组内手动排序(数字小 = 靠前;0/缺省 = 跟随 query 排序) */
  async setOrder(id: string, order: number): Promise<boolean> {
    return this.updateMeta(id, { order });
  }

  /** 分组设色(groupId 无效或 color = undefined = 移除) */
  async setGroupColor(id: string, color?: BookColor): Promise<boolean> {
    await this.load();
    const g = this._groups.find((x) => x.id === id);
    if (!g) return false;
    if (isValidBookColor(color)) {
      g.color = color;
    } else {
      g.color = undefined;
    }
    await this.saveGroups();
    this._store.set([...this.books]);
    return true;
  }

  /* ===================== 书签（2026-08-29 新增） ===================== */

  /** 取本书书签（按创建时间升序）；书不存在 / 无书签 → 空数组 */
  getBookmarks(id: string): BookMark[] {
    const meta = this.get(id);
    if (!meta?.bookmarks?.length) return [];
    return [...meta.bookmarks].sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * 新增书签。同一 cfi 已存在则直接返回现有列表（幂等，不重复添加）。
   * @returns 操作后的书签列表（升序）
   */
  async addBookmark(id: string, bm: { cfi: string; label?: string; excerpt?: string; bookType?: BookType }): Promise<BookMark[]> {
    await this.load();
    const cfi = bm?.cfi?.trim();
    if (!cfi) return this.getBookmarks(id);
    const list = this.getBookmarks(id);
    if (list.some((b) => b.cfi === cfi)) return list;
    const next = [
      ...list,
      {
        id: `bm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        cfi,
        label: bm.label?.trim() || undefined,
        excerpt: bm.excerpt?.trim() || undefined,
        createdAt: Date.now(),
        bookType: bm.bookType,
      },
    ];
    await this.updateMeta(id, { bookmarks: next });
    return this.getBookmarks(id);
  }

  /** 按书签 id 删除；返回操作后的列表 */
  async removeBookmark(id: string, bookmarkId: string): Promise<BookMark[]> {
    await this.load();
    const next = this.getBookmarks(id).filter((b) => b.id !== bookmarkId);
    await this.updateMeta(id, { bookmarks: next });
    return this.getBookmarks(id);
  }

  /** 重命名书签；返回操作后的列表 */
  async renameBookmark(id: string, bookmarkId: string, label: string): Promise<BookMark[]> {
    await this.load();
    const next = this.getBookmarks(id).map((b) =>
      b.id === bookmarkId ? { ...b, label: label.trim() || undefined } : b
    );
    await this.updateMeta(id, { bookmarks: next });
    return this.getBookmarks(id);
  }

  /**
   * 按 cfi 切换书签：已存在 → 删除；不存在 → 新增。
   * 供阅读器工具栏「🔖」一键加/删当前位置使用。
   * @returns { list, added } —— 操作后的列表与本次是新增还是删除
   */
  async toggleBookmark(
    id: string,
    bm: { cfi: string; label?: string; excerpt?: string; bookType?: BookType }
  ): Promise<{ list: BookMark[]; added: boolean }> {
    await this.load();
    const cfi = bm?.cfi?.trim();
    if (!cfi) return { list: this.getBookmarks(id), added: false };
    const list = this.getBookmarks(id);
    const hit = list.find((b) => b.cfi === cfi);
    if (hit) return { list: await this.removeBookmark(id, hit.id), added: false };
    return { list: await this.addBookmark(id, bm), added: true };
  }

  /** 全部标签 + 用量计数（计数降序，同数按名升序）——智能分组用 */
  tagCounts(): { tag: string; count: number }[] {
    const map = new Map<string, number>();
    for (const b of this.books) {
      for (const t of b.tags ?? []) map.set(t, (map.get(t) ?? 0) + 1);
    }
    return Array.from(map, ([tag, count]) => ({ tag, count })).sort(
      (a, b) => b.count - a.count || a.tag.localeCompare(b.tag, "zh-Hans-CN")
    );
  }

  /** 全部已用格式 + 计数（升序）——智能分组用 */
  formatCounts(): { format: string; count: number }[] {
    const map = new Map<string, number>();
    for (const b of this.books) {
      const f = (b.format || "").toLowerCase();
      if (f) map.set(f, (map.get(f) ?? 0) + 1);
    }
    return Array.from(map, ([format, count]) => ({ format, count })).sort((a, b) =>
      a.format.localeCompare(b.format)
    );
  }

  /** 各阅读状态计数（缺省状态归入 unread）——智能分组用 */
  statusCounts(): Record<BookStatus, number> {
    const out: Record<BookStatus, number> = { unread: 0, reading: 0, finished: 0 };
    for (const b of this.books) out[b.status ?? "unread"]++;
    return out;
  }

  /** 收藏数量 */
  favoriteCount(): number {
    return this.books.filter((b) => b.favorite).length;
  }

  /** 未分组书籍数量 */
  ungroupedCount(): number {
    return this.books.filter((b) => !b.groupId).length;
  }

  /** 某分组内书籍数量 */
  groupCount(groupId: string): number {
    return this.books.filter((b) => b.groupId === groupId).length;
  }

  /**
   * 「继续读最近一本」:按 lastReadAt 倒序,返回未读完且有进度的书的 id。
   * 已读完的(进度 >= 99.5%)会被跳过;无任何读过的书则返回 null。
   * 用于顶栏 ⏵ 按钮(2026-08-29 P2 I5)。
   */
  getContinueReadId(): string | null {
    let best: BookMeta | null = null;
    for (const b of this.books) {
      const frac = b.progress?.fraction;
      // 跳过没读过的、读完的、零进度的
      if (typeof frac !== "number" || frac <= 0 || frac >= 0.995) continue;
      if (!best || (b.lastReadAt ?? 0) > (best.lastReadAt ?? 0)) best = b;
    }
    return best?.id ?? null;
  }

  /**
   * 搜索 + 筛选 + 排序一次出结果（UI 的唯一数据入口）
   * 排序稳定性：数值键相等时用书名做次级键，避免列表抖动
   */
  query(
    filter: BookFilter = {},
    sortKey: BookSortKey = "lastRead",
    dir: SortDir = "desc"
  ): BookMeta[] {
    const kw = (filter.keyword ?? "").trim().toLowerCase();
    const out = this.books.filter((b) => {
      if (filter.status && filter.status !== "all" && (b.status ?? "unread") !== filter.status) return false;
      if (
        filter.format &&
        filter.format !== "all" &&
        (b.format || "").toLowerCase() !== filter.format.toLowerCase()
      )
        return false;
      if (filter.tag && !(b.tags ?? []).includes(filter.tag)) return false;
      if (filter.groupId === "ungrouped") {
        if (b.groupId) return false;
      } else if (filter.groupId && filter.groupId !== "all" && b.groupId !== filter.groupId) {
        return false;
      }
      if (filter.favoriteOnly && !b.favorite) return false;
      if (typeof filter.minRating === "number" && filter.minRating > 0 && (b.rating ?? 0) < filter.minRating)
        return false;
      // [2026-08-29] P2:颜色筛选
      if (filter.color && b.color !== filter.color) return false;
      if (kw) {
        const hay = [b.title, b.author ?? "", b.series ?? "", ...(b.tags ?? [])].join(" ").toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
    const sign = dir === "asc" ? 1 : -1;
    const num = (b: BookMeta): number => {
      switch (sortKey) {
        case "addedAt":
          return b.addedAt ?? 0;
        case "progress":
          return b.progress?.fraction ?? 0;
        case "readingTime":
          return b.readingTimeMs ?? 0;
        case "rating":
          return b.rating ?? 0;
        case "size":
          return b.size ?? 0;
        case "lastRead":
        default:
          return b.lastReadAt ?? b.addedAt ?? 0;
      }
    };
    out.sort((a, b) => {
      // [2026-08-29] P2:颜色排序按 BOOK_COLORS 数组索引(色相 HSL 顺序:红→橙→黄→绿→蓝→紫→灰)
      // 无色的书排在最后(索引 = 999),保证有色的始终相邻
      if (sortKey === "color") {
        const ai = a.color ? BOOK_COLOR_INDEX[a.color] : 999;
        const bi = b.color ? BOOK_COLOR_INDEX[b.color] : 999;
        const r = ai - bi;
        if (r !== 0) return r * sign;
        return a.title.localeCompare(b.title, "zh-Hans-CN");
      }
      if (sortKey === "title" || sortKey === "author") {
        const av = (sortKey === "title" ? a.title : a.author ?? "") || "";
        const bv = (sortKey === "title" ? b.title : b.author ?? "") || "";
        // 中文按拼音序（localeCompare zh-Hans-CN）
        return av.localeCompare(bv, "zh-Hans-CN") * sign;
      }
      // [2026-08-29] P2:同组内手动排序优先(数字小 = 靠前)
      // 只在两边都设置了 order 时按 order 排,否则走原本的次级键
      if (typeof a.order === "number" && typeof b.order === "number" && a.order !== b.order) {
        return (a.order - b.order) * sign;
      }
      const r = num(a) - num(b);
      if (r !== 0) return r * sign;
      return a.title.localeCompare(b.title, "zh-Hans-CN");
    });
    return out;
  }

  /** 批量设置阅读状态，返回实际生效数量 */
  async batchSetStatus(ids: string[], status: BookStatus): Promise<number> {
    await this.load();
    let n = 0;
    for (const b of this.books) {
      if (ids.includes(b.id)) {
        b.status = status;
        n++;
      }
    }
    if (n) {
      await this.save();
      this._store.set([...this.books]);
    }
    return n;
  }

  /** 批量加标签，返回实际生效数量 */
  async batchAddTag(ids: string[], tag: string): Promise<number> {
    await this.load();
    const t = tag.trim();
    if (!t) return 0;
    let n = 0;
    for (const b of this.books) {
      if (!ids.includes(b.id)) continue;
      const next = Array.from(new Set([...(b.tags ?? []), t]));
      if (next.length !== (b.tags ?? []).length) {
        b.tags = next;
        n++;
      }
    }
    if (n) {
      await this.save();
      this._store.set([...this.books]);
    }
    return n;
  }

  /** 批量移除标签，返回实际生效数量 */
  async batchRemoveTag(ids: string[], tag: string): Promise<number> {
    await this.load();
    let n = 0;
    for (const b of this.books) {
      if (!ids.includes(b.id)) continue;
      const next = (b.tags ?? []).filter((x) => x !== tag);
      if (next.length !== (b.tags ?? []).length) {
        b.tags = next.length ? next : undefined;
        n++;
      }
    }
    if (n) {
      await this.save();
      this._store.set([...this.books]);
    }
    return n;
  }

  /** 批量设置分组（groupId 省略 = 移出分组），返回实际生效数量 */
  async batchSetGroup(ids: string[], groupId?: string): Promise<number> {
    await this.load();
    let n = 0;
    for (const b of this.books) {
      if (!ids.includes(b.id)) continue;
      b.groupId = groupId || undefined;
      n++;
    }
    if (n) {
      await this.save();
      this._store.set([...this.books]);
    }
    return n;
  }

  /** 批量移除（复用 removeBook 保证源文件/封面清理逻辑一致），返回实际删除数量 */
  async batchRemove(ids: string[], opts: { deleteFile?: boolean } = {}): Promise<number> {
    await this.load();
    let n = 0;
    for (const id of [...ids]) {
      if (!this.get(id)) continue;
      await this.removeBook(id, opts);
      n++;
    }
    return n;
  }

  /* ===================== 2026-08-29 P2:批量设色 / 评分 / 收藏 ===================== */

  /** 批量设色(color = undefined = 移除颜色),返回实际生效数量 */
  async batchSetColor(ids: string[], color?: BookColor): Promise<number> {
    await this.load();
    let n = 0;
    for (const b of this.books) {
      if (!ids.includes(b.id)) continue;
      if (isValidBookColor(color)) {
        if (b.color !== color) {
          b.color = color;
          n++;
        }
      } else if (b.color !== undefined) {
        b.color = undefined;
        n++;
      }
    }
    if (n) {
      await this.save();
      this._store.set([...this.books]);
    }
    return n;
  }

  /** 批量评分(0 = 清除),返回实际生效数量 */
  async batchSetRating(ids: string[], rating: number): Promise<number> {
    await this.load();
    const r = Math.max(0, Math.min(5, Math.round(rating)));
    const next = r > 0 ? r : undefined;
    let n = 0;
    for (const b of this.books) {
      if (!ids.includes(b.id)) continue;
      if (b.rating !== next) {
        b.rating = next;
        n++;
      }
    }
    if (n) {
      await this.save();
      this._store.set([...this.books]);
    }
    return n;
  }

  /** 批量收藏 / 取消收藏,返回实际生效数量 */
  async batchSetFavorite(ids: string[], favorite: boolean): Promise<number> {
    await this.load();
    const next = !!favorite;
    let n = 0;
    for (const b of this.books) {
      if (!ids.includes(b.id)) continue;
      if (!!b.favorite !== next) {
        b.favorite = next || undefined;
        n++;
      }
    }
    if (n) {
      await this.save();
      this._store.set([...this.books]);
    }
    return n;
  }

  /* ===================== 2026-08-29 P2:facets 计数(颜色 / 丛书) ===================== */

  /** 颜色使用计数:每色用了多少本(只含已用色,用于侧边栏 7 色区块) */
  colorCounts(): { color: BookColor; count: number }[] {
    const map = new Map<BookColor, number>();
    for (const b of this.books) {
      if (b.color) map.set(b.color, (map.get(b.color) ?? 0) + 1);
    }
    // 按 BOOK_COLORS 数组顺序输出(色相 HSL 顺序)
    return BOOK_COLORS.filter((c) => map.has(c.token)).map((c) => ({
      color: c.token,
      count: map.get(c.token) ?? 0,
    }));
  }

  /** 丛书使用计数:同 series 至少 2 本才显示(避免小书库的噪音,见设计 §10 风险表) */
  seriesCounts(): { series: string; count: number }[] {
    const map = new Map<string, number>();
    for (const b of this.books) {
      const s = (b.series ?? "").trim();
      if (s) map.set(s, (map.get(s) ?? 0) + 1);
    }
    return Array.from(map, ([series, count]) => ({ series, count }))
      .filter((x) => x.count >= 2)
      .sort((a, b) => b.count - a.count || a.series.localeCompare(b.series, "zh-Hans-CN"));
  }

  /**
   * 替换封面（用户自选图片）
   * - 新文件名带时间戳，避开 webview 对旧封面的缓存
   * - 写成功后才删旧封面，避免中途失败丢图
   */
  async replaceCover(id: string, file: File | Blob, ext = "jpg"): Promise<string | null> {
    await this.load();
    const meta = this.get(id);
    if (!meta) return null;
    const dir = BOOKS_DIR(this.plugin.name);
    try {
      await putFile(`${dir}/covers`, true, null);
    } catch (__swallowErr) {
      logSwallow(__swallowErr, "bookshelf-store.ts · replaceCover mkdir", "debug");
    }
    const safeExt = (ext.match(/^[a-z0-9]+$/i)?.[0] ?? "jpg").toLowerCase();
    const path = `${dir}/covers/${id}-${Date.now().toString(36)}.${safeExt}`;
    const ok = await putFile(path, false, file);
    if (!ok) return null;
    this.dirCache.delete(`${dir}/covers`);
    const old = meta.cover;
    meta.cover = path;
    await this.save();
    if (old && old !== path) {
      try {
        await removeFile(old);
      } catch (__swallowErr) {
        logSwallow(__swallowErr, "bookshelf-store.ts · replaceCover rmOld", "debug");
      }
    }
    this._store.set([...this.books]);
    return path;
  }
}
