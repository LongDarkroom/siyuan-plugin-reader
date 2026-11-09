/**
 * 阅读助手 · 会话持久化 IO（2026-11-08 · P0）
 * ------------------------------------------------------------------
 * 解决「重载思源后 AI 会话全部消失」的根因：
 * 思源桌面端启动内核时用 `server.listen(0)` 向系统要**随机空闲端口**，
 * 而 localStorage 按 origin（含端口）隔离 —— 端口一变，插件就去读写
 * 另一个空库。书架/批注/进度写 petal 文件所以不受影响，AI 会话写
 * localStorage 因此必然丢失。
 *
 * 本模块把 AI 会话的真源搬到 petal 文件（`plugin.loadData/saveData`），
 * localStorage 降级为**同 origin 热缓存**：
 *
 *   写：内存态 → localStorage 同步镜像 → petal 防抖落盘（默认 800ms）
 *   读：localStorage 同步命中（<5ms 出首屏）→ 异步读盘对账 → rev 新者胜
 *
 * 三条安全规则（缺一不可）：
 *  1. **未对账不落盘**：`saveBook` 在该书未完成首次 `loadBook` 前只写热缓存，
 *     把状态挂到 pending，等对账完成再合并写入。否则「打开面板 → 立即造一条
 *     空会话 → 卸载时落盘」会把磁盘上几十条历史覆盖成空。
 *  2. **缩水守卫**：会话数骤减或消息数腰斩且非显式删除 → 先归档旧盘再写。
 *  3. **损坏隔离**：解析失败的档另存 `.corrupt-<ts>.json`，回落 `.bak`，
 *     仍失败则返回空态并标记 readOnly（禁止覆盖坏档）。
 *
 * 只依赖注入进来的 load/save 与 Storage，不 import Svelte / 思源 API，
 * 因此可在 Node 测试里直接跑。
 */
import { logSwallow } from "../../core/safe.ts";
import {
  bumpRev,
  emptySessionState,
  loadSessionState,
  mergeSessionStates,
  normalizeSessionState,
  pruneSessionTombstones,
  sessionStorageKey,
  stateMeta,
  trimSessionState,
  type AiSessionState,
} from "./ai-session-store.ts";

/** 宿主的落盘通道（思源插件实例的 loadData / saveData） */
export interface AiSessionIOHost {
  load(file: string): Promise<unknown>;
  save(file: string, data: unknown): Promise<void>;
}

/** 会话状态读取来源，用于 UI 提示与诊断 */
export type SessionLoadSource = "memory" | "disk" | "backup" | "empty";

export interface SessionLoadResult {
  state: AiSessionState;
  source: SessionLoadSource;
  /** true 表示磁盘损坏且备份也读不出来 —— 禁止后续覆盖 */
  readOnly: boolean;
  /** 磁盘档的 rev（没有档时为 0） */
  diskRev: number;
}

export interface AiSessionIOOptions {
  /** 热缓存通道；默认 localStorage，测试可注入内存实现 */
  storage?: () => Storage | null;
  /** 落盘防抖毫秒数；每次写前读取，便于设置页实时生效 */
  debounceMs?: () => number;
  /** 注入时钟，便于测试 */
  now?: () => number;
}

export interface SessionWriteOptions {
  /** 显式删除/清空：跳过缩水守卫，并写入墓碑 */
  explicit?: boolean;
  /** 跳过防抖，立即落盘（卸载 / pagehide 用） */
  immediate?: boolean;
  /** 本批被删除的会话 id（用于墓碑，防止另一实例写回来） */
  removedIds?: string[];
}

export interface SessionDiagnostics {
  /** 有过读写的书 id */
  books: string[];
  /** 已完成磁盘对账的书 */
  hydrated: string[];
  /** 仍在等待落盘的书（定时器未触发） */
  dirty: string[];
  /** 最近一次落盘失败信息 */
  lastError: string;
  /** 最近一次成功落盘时间 */
  lastWriteAt: number;
  /** journal 中的条目数 */
  journalEntries: number;
}

/** 索引里一本书的摘要 */
export interface BookIndexEntry {
  sessions: number;
  messages: number;
  chars: number;
  rev: number;
  updatedAt: number;
}

/** 跨书会话摘要（dock 空态「最近对话」列表用） */
export interface BookSessionSummary extends BookIndexEntry {
  bookId: string;
  /** true 表示来自本次运行的内存态（含未落盘改动），false 来自磁盘索引 */
  fromMemory: boolean;
}

const INDEX_FILE = "ai-sessions-index.json";
const JOURNAL_FILE = "ai-sessions-journal.json";
const JOURNAL_MAX = 200;
const BACKUP_SUFFIX = ".bak.json";
const DEFAULT_DEBOUNCE_MS = 800;

/** bookId 可能是 `b<base36>` 或 `unknown`；统一压成安全文件名 */
function bookFile(bookId: string): string {
  const safe = String(bookId ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, 64);
  return `ai-sessions-${safe || "unknown"}.json`;
}

function backupFile(bookId: string): string {
  return bookFile(bookId).replace(/\.json$/, BACKUP_SUFFIX);
}

function archiveFile(bookId: string, at: number): string {
  return bookFile(bookId).replace(/\.json$/, `.${at}.archive.json`);
}

function corruptFile(bookId: string, at: number): string {
  return bookFile(bookId).replace(/\.json$/, `.corrupt-${at}.json`);
}

interface JournalEntry {
  at: number;
  bookId: string;
  event: string;
  detail?: string;
}

/** 墓碑归一：只留「非空 id → 正时间戳」；空则返回 undefined（不写空字段） */
function normalizeTombstones(raw: Record<string, number> | undefined): Record<string, number> | undefined {
  if (!raw) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    const id = String(k || "").trim();
    const at = Math.round(Number(v));
    if (id && Number.isFinite(at) && at > 0) out[id] = at;
  }
  return Object.keys(out).length ? out : undefined;
}

interface BookRuntime {
  timer: any;
  /** 等待落盘的最新状态 */
  pending: AiSessionState | null;
  /** 未对账时暂存的状态，等 loadBook 完成后合并 */
  deferred: AiSessionState | null;
  /** 已确认的墓碑（来自磁盘/本次删除），供 saveBook 同步段立即过滤 */
  tombstones: Record<string, number>;
  /** 串行化落盘，避免同一文件的并发写 */
  chain: Promise<void>;
}

export class AiSessionIO {
  private host: AiSessionIOHost;
  private storage: () => Storage | null;
  private debounceMs: () => number;
  private now: () => number;

  private runtimes = new Map<string, BookRuntime>();
  /** 已完成磁盘对账的书 */
  private hydrated = new Set<string>();
  /** 磁盘损坏且无法恢复的书（禁止覆盖） */
  private readOnly = new Set<string>();

  private journal: JournalEntry[] = [];
  private journalDirty = false;
  private lastError = "";
  private lastWriteAt = 0;

  constructor(host: AiSessionIOHost, opts: AiSessionIOOptions = {}) {
    this.host = host;
    this.storage = opts.storage || (() => {
      try {
        return typeof localStorage === "undefined" ? null : localStorage;
      } catch {
        return null;
      }
    });
    this.debounceMs = opts.debounceMs || (() => DEFAULT_DEBOUNCE_MS);
    this.now = opts.now || (() => Date.now());
  }

  /* ------------------------------------------------------------------ *
   * 读
   * ------------------------------------------------------------------ */

  /**
   * 同步读热缓存：面板首屏用它立即渲染，不等磁盘。
   * 未注入宿主时（测试 / 独立使用）行为与旧版一致。
   */
  loadCache(bookId: string): AiSessionState {
    return loadSessionState(this.storage(), bookId);
  }

  /**
   * 完整加载：热缓存优先命中，再异步读盘对账。
   *
   * 返回的 state 已经是「合并后的最终态」：
   *  - 磁盘 rev 更新 → 用磁盘态；
   *  - 内存有未落盘的改动（deferred）→ 与磁盘态按会话 LWW 合并。
   */
  async loadBook(bookId: string, opts: { pruneRetentionDays?: number; migrateCache?: boolean } = {}): Promise<SessionLoadResult> {
    // 一次性迁移：磁盘无档但热缓存有内容 → 先写进 petal，否则换端口后永久丢失
    if (opts.migrateCache !== false) {
      try {
        await this.migrateFromCache(bookId);
      } catch (__swallowErr) {
        logSwallow(__swallowErr, "ai-session-io.ts · loadBook · migrate", "debug");
      }
    }
    const cached = this.loadCache(bookId);
    const disk = await this.readDiskWithFallback(bookId);
    const days = Math.round(Number(opts.pruneRetentionDays) || 0);
    const pruneIfNeeded = (s: AiSessionState) => pruneSessionTombstones(normalizeSessionState(s), this.now());

    let state: AiSessionState;
    let source: SessionLoadSource;

    if (!disk) {
      // 无磁盘档：以内存态为准；内存也为空则空态
      state = pruneIfNeeded(cached);
      source = stateMeta(state).sessionCount ? "memory" : "empty";
    } else if (disk.corrupt && !disk.state) {
      // 档损坏且备份也读不出：只读空态，禁止覆盖
      this.readOnly.add(bookId);
      this.appendJournal(bookId, "load-corrupt", disk.error || "");
      state = emptySessionState();
      source = "empty";
      this.hydrated.add(bookId);
      this.writeCache(bookId, state);
      return { state, source, readOnly: true, diskRev: 0 };
    } else {
      const diskState = pruneIfNeeded(disk.state as AiSessionState);
      const cachedMeta = stateMeta(cached);
      const diskMeta = stateMeta(diskState);
      // 内存里有尚未落盘的改动时合并，避免「刚发一条就切书」被磁盘态吞掉
      const deferred = this.runtimeOf(bookId).deferred;
      let merged = diskState;
      if (deferred && stateMeta(deferred).sessionCount) {
        merged = mergeSessionStates(deferred, diskState, this.now());
      } else if (cachedMeta.sessionCount && cachedMeta.rev > diskMeta.rev) {
        merged = mergeSessionStates(cached, diskState, this.now());
      }
      state = merged;
      source = disk.fromBackup ? "backup" : "disk";
    }

    if (days > 0) state = this.applyRetention(state, days);

    this.hydrated.add(bookId);
    const rt = this.runtimeOf(bookId);
    const hadDeferred = !!rt.deferred;
    rt.deferred = null;
    // 对账后把磁盘墓碑记进运行时：此后即使调用方传入不含 deleted 的状态，
    // saveBook 的同步段也能立刻把已删会话挡在门外。
    rt.tombstones = { ...(state.deleted || {}) };
    this.writeCache(bookId, state);

    // 对账完成：未对账期间挂起的写入（deferred）已合并进 state，必须排入落盘；
    // 只写热缓存的话，换端口重启（localStorage origin 变化）后这批改动就丢了。
    if (rt.pending) this.scheduleFlush(bookId, rt.pending);
    else if (hadDeferred) this.scheduleFlush(bookId, state);

    return { state, source, readOnly: this.readOnly.has(bookId), diskRev: stateMeta(state).rev };
  }

  /** 读磁盘档；主档坏则回落 .bak */
  private async readDiskWithFallback(
    bookId: string,
  ): Promise<{ state: AiSessionState | null; fromBackup: boolean; corrupt: boolean; error?: string } | null> {
    let primaryError = "";
    let primaryRaw: unknown = null;
    try {
      const raw = await this.host.load(bookFile(bookId));
      primaryRaw = raw;
      if (raw === null || raw === undefined || raw === "") return null;
      const state = normalizeSessionState(raw);
      return { state, fromBackup: false, corrupt: false };
    } catch (e) {
      primaryError = String((e as any)?.message || e);
      logSwallow(e, "ai-session-io.ts · readDisk · primary", "debug");
      // 主档坏：用第一次已经读到的原始档留隔离副本，再试备份。
      // 此前在这里又 load 一次同一坏档：normalize 抛错时第二次照样抛，副本永远写不出来。
      try {
        if (primaryRaw !== null && primaryRaw !== undefined && primaryRaw !== "") {
          await this.host.save(corruptFile(bookId, this.now()), primaryRaw as any);
        }
      } catch (__swallowErr) {
        logSwallow(__swallowErr, "ai-session-io.ts · readDisk · quarantine", "debug");
      }
    }
    try {
      const raw = await this.host.load(backupFile(bookId));
      if (raw === null || raw === undefined || raw === "") {
        return { state: null, fromBackup: false, corrupt: true, error: primaryError };
      }
      return { state: normalizeSessionState(raw), fromBackup: true, corrupt: false };
    } catch (e) {
      logSwallow(e, "ai-session-io.ts · readDisk · backup", "debug");
      return { state: null, fromBackup: false, corrupt: true, error: primaryError };
    }
  }

  /* ------------------------------------------------------------------ *
   * 写
   * ------------------------------------------------------------------ */

  /**
   * 保存一本书的会话。
   *
   * 同步部分：立刻写热缓存（同 origin 下 ⌘R 秒开），并返回清理后的状态，
   * 让调用方（AiPanel）能同步更新内存态。
   *
   * 异步部分：防抖后落盘。**未对账前不落盘**，只挂 deferred，
   * 等 loadBook 完成后合并 —— 这是防止空态覆盖磁盘历史的关键。
   */
  saveBook(bookId: string, state: AiSessionState, opts: SessionWriteOptions = {}): AiSessionState {
    if (this.readOnly.has(bookId)) {
      // 磁盘损坏且读不出：只更新内存与热缓存，绝不覆盖主档
      const clean = trimSessionState(normalizeSessionState(state));
      this.writeCache(bookId, clean);
      return clean;
    }

    let next = normalizeSessionState(state);
    // 运行时已确认的墓碑（对账时从磁盘读到、或本实例删过）必须先并进来，
    // 否则调用方传入一份「不含 deleted 的整份状态」就会把删除事实抹掉。
    const rt0 = this.runtimeOf(bookId);
    if (Object.keys(rt0.tombstones).length) {
      next = { ...next, deleted: { ...rt0.tombstones, ...(next.deleted || {}) } };
    }
    if (opts.removedIds?.length) next = this.markTombstones(next, opts.removedIds);
    next = pruneSessionTombstones(bumpRev(next), this.now());
    // 墓碑优先于任何一方内容：已删会话即便被另一实例写回来，也不得复活
    if (next.deleted) {
      const blocked = next.deleted;
      const kept = next.sessions.filter((s) => !blocked[s.id]);
      if (kept.length !== next.sessions.length) {
        next = { ...next, sessions: kept, activeId: kept.some((s) => s.id === next.activeId) ? next.activeId : (kept[0]?.id || "") };
      }
    }
    const clean = trimSessionState(next);
    // 记下本次确认的墓碑，供后续写（包括另一实例场景）继续生效
    rt0.tombstones = { ...(clean.deleted || {}) };

    this.writeCache(bookId, clean);

    if (!this.hydrated.has(bookId)) {
      // 尚未对账：先挂起，等 loadBook 回来再合并写盘
      rt0.deferred = clean;
      return clean;
    }

    rt0.pending = clean;
    if (opts.immediate) {
      void this.flushBook(bookId, opts.explicit);
    } else {
      this.scheduleFlush(bookId, clean, opts.explicit);
    }
    return clean;
  }

  /** 立即把所有待写状态落盘（卸载 / pagehide / 切换书时用） */
  async flush(): Promise<void> {
    const ids = Array.from(this.runtimes.keys());
    await Promise.all(
      ids.map(async (id) => {
        await this.flushBook(id);
        // flushBook 只保证「把 pending 排进写链」，若该书的写链还在跑
        // （例如刚做过 immediate 写），必须等它结束，否则卸载后可能丢最后一批。
        await this.runtimeOf(id).chain;
      }),
    );
  }

  /** 删除一本书的全部会话档（含备份） */
  async removeBook(bookId: string): Promise<void> {
    const rt = this.runtimeOf(bookId);
    if (rt.timer) {
      clearTimeout(rt.timer);
      rt.timer = null;
    }
    rt.pending = null;
    rt.deferred = null;
    rt.tombstones = {};
    this.hydrated.add(bookId);
    try {
      this.storage()?.removeItem(sessionStorageKey(bookId));
    } catch (__swallowErr) {
      logSwallow(__swallowErr, "ai-session-io.ts · removeBook · cache", "debug");
    }
    // petal 没有删除 API：写成空态即可，读取时视为无会话
    try {
      await this.host.save(bookFile(bookId), emptySessionState());
      await this.host.save(backupFile(bookId), emptySessionState());
      this.appendJournal(bookId, "remove-book");
      await this.flushJournal();
    } catch (e) {
      this.lastError = String((e as any)?.message || e);
      logSwallow(e, "ai-session-io.ts · removeBook · disk", "debug");
    }
  }

  /** 诊断信息：设置页「导出与诊断」用 */
  diagnostics(): SessionDiagnostics {
    const dirty: string[] = [];
    for (const [id, rt] of this.runtimes) if (rt.pending) dirty.push(id);
    return {
      books: Array.from(this.runtimes.keys()),
      hydrated: Array.from(this.hydrated),
      dirty,
      lastError: this.lastError,
      lastWriteAt: this.lastWriteAt,
      journalEntries: this.journal.length,
    };
  }

  /** 供 UI 判断是否需要「从磁盘重新加载」 */
  isHydrated(bookId: string): boolean {
    return this.hydrated.has(bookId);
  }

  /** 磁盘损坏标记：UI 可提示「本次不落盘，请检查档」 */
  isReadOnly(bookId: string): boolean {
    return this.readOnly.has(bookId);
  }

  /* ------------------------------------------------------------------ *
   * 内部
   * ------------------------------------------------------------------ */

  private runtimeOf(bookId: string): BookRuntime {
    let rt = this.runtimes.get(bookId);
    if (!rt) {
      rt = { timer: null, pending: null, deferred: null, tombstones: {}, chain: Promise.resolve() };
      this.runtimes.set(bookId, rt);
    }
    return rt;
  }

  private writeCache(bookId: string, state: AiSessionState): void {
    try {
      this.storage()?.setItem(sessionStorageKey(bookId), JSON.stringify(state));
    } catch (__swallowErr) {
      logSwallow(__swallowErr, "ai-session-io.ts · writeCache", "debug");
    }
  }

  private scheduleFlush(bookId: string, state: AiSessionState, explicit = false): void {
    const rt = this.runtimeOf(bookId);
    rt.pending = state;
    if (rt.timer) return; // 已有定时器：沿用，只更新 pending
    const ms = Math.max(0, Math.min(5000, Math.round(Number(this.debounceMs()) || DEFAULT_DEBOUNCE_MS)));
    rt.timer = setTimeout(() => {
      rt.timer = null;
      void this.flushBook(bookId, explicit);
    }, ms);
  }

  private async flushBook(bookId: string, explicit = false): Promise<void> {
    const rt = this.runtimeOf(bookId);
    if (rt.timer) {
      clearTimeout(rt.timer);
      rt.timer = null;
    }
    const state0 = rt.pending;
    if (!state0) return;
    rt.pending = null;

    // 串行化：同一本书的写按顺序执行，避免旧状态覆盖新状态
    rt.chain = rt.chain.then(async () => {
      let state = state0;
      try {
        const prev = await this.readPrevForGuard(bookId);
        if (prev && !explicit && this.shrinkDetected(prev, state)) {
          // 缩水守卫：先归档旧盘，再写新态
          try {
            await this.host.save(archiveFile(bookId, this.now()), prev as any);
            this.appendJournal(bookId, "shrink-guard", `${stateMeta(prev).sessionCount}→${stateMeta(state).sessionCount}`);
            // 合并而非覆盖：把旧盘里仍在的会话补回来
            state = mergeSessionStates(state, prev, this.now());
          } catch (__swallowErr) {
            logSwallow(__swallowErr, "ai-session-io.ts · shrinkGuard · archive", "debug");
          }
        }
        // 墓碑继承：saveBook 是同步的、读不了盘，传入的 state 可能不带 deleted
        // （典型场景：另一个 origin 的实例把整份旧状态写回）。这里在写链内
        // 把磁盘既有墓碑并进来，已删会话才不会被复活。
        if (prev) state = this.inheritTombstones(state, prev);
        // 写前留备份（只留上一版）
        if (prev) {
          try {
            await this.host.save(backupFile(bookId), prev as any);
          } catch (__swallowErr) {
            logSwallow(__swallowErr, "ai-session-io.ts · flush · backup", "debug");
          }
        }
        await this.host.save(bookFile(bookId), state);
        this.lastWriteAt = this.now();
        this.lastError = "";
        this.writeCache(bookId, state);
        // 索引同步（2026-11-08 · dock 空态「最近对话」）：每本书落盘后刷新一次。
        // 不刷索引的话，右栏在没开阅读器时只能看到空列表，用户会以为历史丢了。
        await this.refreshIndexEntry(bookId, state);
        this.appendJournal(bookId, "flush", `sessions=${stateMeta(state).sessionCount} chars=${stateMeta(state).chars}`);
        await this.flushJournal();
      } catch (e) {
        this.lastError = String((e as any)?.message || e);
        this.appendJournal(bookId, "flush-error", this.lastError);
        logSwallow(e, "ai-session-io.ts · flushBook", "debug");
      }
    });
    await rt.chain;
  }

  /** 缩水判定：会话数减少，或消息总数腰斩 */
  private shrinkDetected(prev: AiSessionState, next: AiSessionState): boolean {
    const a = stateMeta(prev);
    const b = stateMeta(next);
    if (b.sessionCount === 0 && a.sessionCount > 0) return true;
    if (b.sessionCount < a.sessionCount) return true;
    if (a.messageCount >= 4 && b.messageCount < a.messageCount * 0.5) return true;
    return false;
  }

  /**
   * 单本书落盘后刷新索引条目（2026-11-08 · dock 空态「最近对话」）。
   *
   * 只改自己这一条：索引里其它书的记录从磁盘读回来后原样写回。这样每次落盘
   * 的成本是一次小 JSON 读写，不会因为书多就变慢。
   */
  private async refreshIndexEntry(bookId: string, state: AiSessionState): Promise<void> {
    // general 模式 bookId 是空串（bookFile 才映射成 unknown 档），两个都要挡住
    if (!bookId || bookId === "unknown") return;
    const m = stateMeta(state);
    if (!m.sessionCount) return;
    try {
      const books = await this.readIndex();
      books[bookId] = {
        sessions: m.sessionCount,
        messages: m.messageCount,
        chars: m.chars,
        rev: m.rev,
        updatedAt: m.updatedAt || this.now(),
      };
      await this.host.save(INDEX_FILE, { version: 1, at: this.now(), books });
    } catch (e) {
      logSwallow(e, "ai-session-io.ts · refreshIndexEntry", "debug");
    }
  }

  /** 读当前主档（守卫用）；坏档返回 null，避免误判 */
  private async readPrevForGuard(bookId: string): Promise<AiSessionState | null> {
    try {
      const raw = await this.host.load(bookFile(bookId));
      if (raw === null || raw === undefined || raw === "") return null;
      return normalizeSessionState(raw);
    } catch {
      return null;
    }
  }

  private markTombstones(state: AiSessionState, ids: string[]): AiSessionState {
    const deleted = { ...(state.deleted || {}) };
    const at = this.now();
    for (const id of ids) if (id) deleted[id] = at;
    return { ...state, deleted };
  }

  /**
   * 继承磁盘既有墓碑，并据其过滤会话（落盘前的最后一道闸）。
   *
   * 为什么必须在落盘时做：`saveBook` 是同步的，读不了盘，只能看到调用方传进来的
   * state。当另一个 origin 的实例（或一个尚未对账的旧内存态）把整份状态写回来时，
   * 传入的 state 里没有 `deleted` 字段，若直接落盘就会把墓碑清空、已删会话复活。
   * 因此把这一步挪到写链内 —— 那里已经读到 `prev`。
   */
  private inheritTombstones(state: AiSessionState, prev: AiSessionState): AiSessionState {
    const merged = { ...(prev.deleted || {}), ...(state.deleted || {}) };
    const deleted = normalizeTombstones(merged);
    let next: AiSessionState = { ...state };
    if (deleted) next.deleted = deleted;
    else delete next.deleted;

    if (!deleted) return next;

    const kept = next.sessions.filter((s) => !deleted[s.id]);
    if (kept.length === next.sessions.length) return next;
    const activeId = kept.some((s) => s.id === next.activeId) ? next.activeId : (kept[0]?.id || "");
    return { ...next, activeId, sessions: kept };
  }

  private applyRetention(state: AiSessionState, days: number): AiSessionState {
    const cutoff = this.now() - days * 86400000;
    const sessions = state.sessions.filter((s) => s.pinned || Number(s.updatedAt) >= cutoff);
    if (sessions.length === state.sessions.length) return state;
    const activeId = sessions.some((s) => s.id === state.activeId) ? state.activeId : (sessions[0]?.id || "");
    return { ...state, activeId, sessions };
  }

  private appendJournal(bookId: string, event: string, detail = ""): void {
    this.journal.push({ at: this.now(), bookId, event, detail });
    if (this.journal.length > JOURNAL_MAX) this.journal = this.journal.slice(-JOURNAL_MAX);
    this.journalDirty = true;
  }

  private async flushJournal(): Promise<void> {
    if (!this.journalDirty) return;
    this.journalDirty = false;
    try {
      await this.host.save(JOURNAL_FILE, { version: 1, entries: this.journal.slice(-JOURNAL_MAX) });
    } catch (e) {
      logSwallow(e, "ai-session-io.ts · flushJournal", "debug");
    }
  }

  /** 写索引（会话数/字符数快照），供设置页与「打开慢」排查 */
  async writeIndex(): Promise<void> {
    const books: Record<string, BookIndexEntry> = {};
    for (const [id, rt] of this.runtimes) {
      const s = rt.pending || rt.deferred;
      if (!s) continue;
      const m = stateMeta(s);
      books[id] = { sessions: m.sessionCount, messages: m.messageCount, chars: m.chars, rev: m.rev, updatedAt: m.updatedAt || this.lastWriteAt };
    }
    try {
      await this.host.save(INDEX_FILE, { version: 1, at: this.now(), books });
    } catch (e) {
      logSwallow(e, "ai-session-io.ts · writeIndex", "debug");
    }
  }

  /** 读索引（可能不存在） */
  async readIndex(): Promise<Record<string, BookIndexEntry>> {
    try {
      const raw = (await this.host.load(INDEX_FILE)) as any;
      const books = raw?.books;
      if (!books || typeof books !== "object") return {};
      const out: Record<string, BookIndexEntry> = {};
      for (const [id, v] of Object.entries(books as Record<string, any>)) {
        const sessions = Math.max(0, Math.round(Number(v?.sessions) || 0));
        if (!sessions) continue;
        out[id] = {
          sessions,
          messages: Math.max(0, Math.round(Number(v?.messages) || 0)),
          chars: Math.max(0, Math.round(Number(v?.chars) || 0)),
          rev: Math.max(0, Math.round(Number(v?.rev) || 0)),
          updatedAt: Math.max(0, Math.round(Number(v?.updatedAt) || 0)),
        };
      }
      return out;
    } catch (e) {
      logSwallow(e, "ai-session-io.ts · readIndex", "debug");
      return {};
    }
  }

  /**
   * 跨书会话摘要（2026-11-08 · dock 空态用）。
   *
   * 右栏在没有活动阅读器时会落到独立的 `unknown` 会话空间，看不到任何书的
   * 历史。这里提供一个「哪本书有多少条会话、最近什么时候聊过」的清单，
   * 供空态列成入口。
   *
   * 数据来源优先级：
   *  1) 本次运行已加载/写过书的内存态（最准，含未落盘的改动）；
   *  2) 磁盘索引 `ai-sessions-index.json`（上次落盘快照）。
   *
   * `unknown` 被排除：它是「无书通用对话」自己的空间，不应出现在书的清单里。
   */
  async listBooks(): Promise<BookSessionSummary[]> {
    const merged = new Map<string, BookSessionSummary>();
    const put = (id: string, entry: Partial<BookIndexEntry> & { sessionCount?: number }, fromMemory: boolean) => {
      if (!id || id === "unknown") return;
      // stateMeta 给的是 sessionCount，索引用的是 sessions：统一成索引字段
      const sessions = Math.max(0, Math.round(Number(entry.sessions ?? entry.sessionCount) || 0));
      if (!sessions) return;
      const normalized: BookIndexEntry = {
        sessions,
        messages: Math.max(0, Math.round(Number(entry.messages) || 0)),
        chars: Math.max(0, Math.round(Number(entry.chars) || 0)),
        rev: Math.max(0, Math.round(Number(entry.rev) || 0)),
        updatedAt: Math.max(0, Math.round(Number(entry.updatedAt) || 0)),
      };
      const prev = merged.get(id);
      if (!prev || normalized.updatedAt >= prev.updatedAt) {
        merged.set(id, { bookId: id, ...normalized, fromMemory });
      }
    };

    for (const [id, rt] of this.runtimes) {
      const s = rt.pending || rt.deferred;
      if (!s) continue;
      put(id, stateMeta(s), true);
    }
    for (const [id, entry] of Object.entries(await this.readIndex())) put(id, entry, false);

    // 索引可能还没建过（升级前的老数据、或刚落盘还没写索引）：
    // 把已对账过的书逐个读盘补上，否则列表会是空的。
    if (!merged.size) {
      const ids = this.hydrated.size ? Array.from(this.hydrated) : Array.from(this.runtimes.keys());
      for (const id of ids) {
        try {
          const raw = await this.host.load(bookFile(id));
          if (raw === null || raw === undefined || raw === "") continue;
          put(id, stateMeta(normalizeSessionState(raw)), false);
        } catch (__swallowErr) {
          logSwallow(__swallowErr, "ai-session-io.ts · listBooks · scan", "debug");
        }
      }
    }

    return Array.from(merged.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * 把 localStorage 里的旧会话导入 petal（2026-11-08 · 一次性迁移）。
   *
   * 场景：升级前用户的历史会话全在当前 origin 的 localStorage 里，磁盘还没有档。
   * 第一次 `loadBook` 会读到「无磁盘档」，此时若不迁移，一旦换端口这些历史就永久
   * 躺在旧 origin 的 LevelDB 里再也读不出来了。
   *
   * 返回 true 表示实际写入；已迁移过（磁盘已有档）返回 false。
   */
  async migrateFromCache(bookId: string): Promise<boolean> {
    const cached = this.loadCache(bookId);
    if (!stateMeta(cached).sessionCount) return false;
    try {
      const raw = await this.host.load(bookFile(bookId));
      const existing = raw === null || raw === undefined || raw === "" ? null : normalizeSessionState(raw);
      // 磁盘已有会话：不覆盖，交给正常对账逻辑合并
      if (existing && stateMeta(existing).sessionCount) return false;
      const state = bumpRev(pruneSessionTombstones(normalizeSessionState(cached), this.now()));
      await this.host.save(bookFile(bookId), state);
      this.hydrated.add(bookId);
      this.appendJournal(bookId, "migrate-from-cache", `sessions=${stateMeta(state).sessionCount}`);
      await this.flushJournal();
      return true;
    } catch (e) {
      logSwallow(e, "ai-session-io.ts · migrateFromCache", "debug");
      return false;
    }
  }
}
