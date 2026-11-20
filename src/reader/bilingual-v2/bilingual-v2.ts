/**
 * bilingual-v2 · 编排层（R6 新运行时）
 * ------------------------------------------------------------------
 * R6 之后本模块**只做编排**：切分 / 可见性 / 注入 / 预翻译队列四件职责
 * 已下沉到 src/reader/bilingual/runtime/ 下各自独立、可单测的模块，
 * 这里负责组装它们 + 遥测 + 对外 BilingualHandle 契约。
 *
 * 保留的既有行为（对外契约与可观测性不变）：
 *  1. 渲染仍是「兄弟节点」方案（render.ts），原文 DOM 零改动 → CFI/标注/批注/TTS 不受影响。
 *  2. Telemetry 总线照旧 emit（done / hit / try / cost / error），面板零埋点订阅。
 *  3. 300ms 防抖注入、跨文档去重、onSectionsCached 回传（2026-11-19：窗口翻译改为
 *     与引擎分片对齐的「增量注入」——每片译完立即注入，单片 60s 超时不连坐）。
 *  4. createBilingualV2 名字与 BilingualHandle 契约不变 → ReaderView 零改动。
 *
 * 变化：注入改为「分帧有界 + 读写分离 + 三态」，预翻译改为「全本/渐进队列 +
 * 注入闸门」，越界块只缓存不注入，翻页后按进度补注。
 */
import type {
  BilingualOptions,
  BilingualHandle,
  PretranslateOptions,
  PretranslateProgress,
  PretranslateScan,
} from "../bilingual-types.ts";
import { PRETRANSLATE_DEFAULTS } from "../bilingual/core/types.ts";
import { createSegmenter } from "../bilingual/runtime/segmenter.ts";
import { createVisibility } from "../bilingual/runtime/visibility.ts";
import { createInjector } from "../bilingual/runtime/injector.ts";
import { createPretranslateQueue } from "../bilingual/runtime/pretranslate.ts";
import { chunkTexts } from "../../translate/providers/batch.ts";
import { telemetry } from "./telemetry.ts";
import { getLogger } from "../../core/logger.ts";

/**
 * 窗口增量注入的分片预算（2026-11-19 P1-5）。
 * 与千问单次请求预算（3500 字 / 12 段）对齐：每片 ≈ 1 次引擎请求，
 * 译完一片就注入一片，用户不必等整窗全部返回（旧实现要等所有分片串行跑完）。
 */
const INJECT_BATCH_MAX_CHARS = 3500;
const INJECT_BATCH_MAX_SEGMENTS = 12;
/** 单片超时：超时只作废这一片（按空译退避），后续分片照常进行，不再整窗连坐 */
const INJECT_BATCH_TIMEOUT_MS = 60_000;

/** 给 Promise 套单片超时，按时清理定时器（旧实现 race 的定时器从不回收） */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export function createBilingualV2(opts: BilingualOptions): BilingualHandle {
  let enabled = false;
  let injectTimer: any = null;
  let injecting = false;
  /** 翻译进行中又有翻页/刷新触发的调度：本批结束后补跑一轮（否则那次调度被静默丢弃） */
  let injectDirty = false;
  /**
   * 整书预翻译进行中：暂停「窗口注入」这条通路。
   * 预翻译队列自己会注入闸门内的段（getLiveSegment + injectBatch），
   * 若 injectAll 同时在跑，同一段会被两条链路各送译一次 —— 按量计费就是白花钱。
   */
  let pretranslating = false;
  const from = opts.from || "auto";
  const to = opts.to || "zh";
  const getMode = (): "default" | "concise" =>
    typeof opts.getMode === "function" ? opts.getMode() : (opts.mode || "default");
  /**
   * 用户指定的引擎（2026-10-07 接通时补）。
   * 与 getMode 同构：宿主能提供就实时读（设置改完下一轮即生效），
   * 否则退回构造时传入的静态值。
   */
  const getEngine = (): string =>
    typeof opts.getEngine === "function" ? opts.getEngine() : (opts.engine || "auto");
  let runId = `run-${Date.now()}`;

  const segmenter = createSegmenter({
    isSegmentHidden: (h) => !!opts.isSegmentHidden?.(h),
    // 2026-11-20 块级语种闸门：目标语言用中日韩文书写时，中文主导的块不送译
    // （英文书里夹的中文简介页 / 人物介绍 / 推广页，送过去就是原样回吐的重复行）
    targetLang: to,
  });
  const visibility = createVisibility({
    getCurrentSection: () => opts.getCurrentSection?.() ?? 0,
  });
  const injector = createInjector({
    showAiRedo: !!opts.showAiRedo,
    onAiRedo: opts.onAiRedo,
    showHideSegment: !!opts.showHideSegment,
    onHideSegment: (h) => opts.onHideSegment?.(opts.bookId, h),
    // 2026-09-05 设置项「失败自动重试」：关闭 = 0 次自动重试（失败段等下一轮翻页窗口自然重试）
    maxRetries: () => (opts.getRetryEnabled?.() === false ? 0 : PRETRANSLATE_DEFAULTS.maxRetries),
  });

  /**
   * 预取分节数（0–4，默认 2）：渐进窗口与注入闸门共用的「当前 + N 分节」。
   * 2026-09-05 复活 —— R6 重写后此前的「窗口页数」设置一度无人消费。
   */
  const aheadOf = (): number => {
    const v = Math.round(opts.getPrefetchPages?.() ?? PRETRANSLATE_DEFAULTS.aheadSections);
    return Math.min(4, Math.max(0, Number.isFinite(v) ? v : PRETRANSLATE_DEFAULTS.aheadSections));
  };

  /** 统一送译入口：优先走 detailed（带 provider / fromCache 用于遥测） */
  async function translateTexts(
    texts: string[],
    ctxBefore: (string | null)[],
    extra?: { overwrite?: boolean; signal?: AbortSignal; model?: string; engine?: string },
  ): Promise<{ texts: string[]; providers: (string | null)[]; fromCache: boolean[] }> {
    const meta = opts.bookMeta ? opts.bookMeta() : null;
    const mode = getMode();
    // 引擎：extra.engine 优先（整书预翻译弹窗可临时指定），
    // 否则用设置里的「翻译服务」。`"auto"` 交给引擎链按默认顺序走。
    const engine = extra?.engine || getEngine();
    if (opts.translateBatchDetailed) {
      return await opts.translateBatchDetailed(texts, from, to, opts.bookId, ctxBefore, meta, {
        mode,
        engine,
        ...extra,
      });
    }
    const t = await opts.translateBatch(texts, from, to, opts.bookId, ctxBefore, meta, {
      mode,
      engine,
      ...extra,
    });
    return { texts: t, providers: t.map(() => null), fromCache: t.map(() => false) };
  }

  /**
   * 预翻译的翻译覆盖项（model / engine / overwrite / signal）。
   * 队列的 translate 回调签名只有 (texts, ctx)，这些覆盖项靠这里传递。
   */
  let txExtra: { overwrite?: boolean; signal?: AbortSignal; model?: string; engine?: string } | undefined;

  /** 预翻译进度转发：把队列状态翻译成弹窗用的 PretranslateProgress */
  let lastPo: PretranslateOptions | undefined;
  /** 本轮开始时间与起始进度（ETA 速率的分母） */
  let startedAt = 0;
  let startDone = 0;
  /** 预扫描得到的全书段数/字数（用于 estTokens 与进度占比；未扫描则为 null） */
  let scanTotals: { total: number; chars: number } | null = null;

  function emitProgress(status: PretranslateProgress["status"]): void {
    const st = queue.state();
    // 队列的 total 是「已切到的分节」累计值，逐节增长会让进度条反复跳回低值；
    // 有预扫结果时统一用全书段数作分母，才是用户理解的「整本进度」。
    const total = scanTotals && scanTotals.total > 0 ? scanTotals.total : st.total;
    const pending = Math.max(0, total - st.done);
    const elapsed = startedAt ? (Date.now() - startedAt) / 1000 : 0;
    const speed = elapsed > 0 ? (st.done - startDone) / elapsed : 0;
    const etaSeconds =
      status === "running" && speed > 0.01 && pending > 0
        ? Math.round(pending / speed)
        : undefined;
    // Token 估算：按「剩余段数 × 全书平均每段字符 / 4」粗算，仅用于事前提醒
    const estTokens =
      scanTotals && scanTotals.total > 0
        ? Math.max(0, Math.round(((scanTotals.chars * pending) / scanTotals.total) / 4))
        : undefined;
    lastPo?.onProgress?.({
      done: st.done,
      total,
      cached: st.cachedOnly,
      pending,
      status,
      estTokens,
      etaSeconds,
    });
  }

  const queue = createPretranslateQueue({
    bookId: opts.bookId,
    segmenter,
    visibility,
    injector,
    getContents: () => opts.getContents() || [],
    getSections: opts.getSections,
    getCurrentSection: opts.getCurrentSection,
    translate: async (texts, ctx) => (await translateTexts(texts, ctx, txExtra)).texts,
    checkCached: opts.checkCached,
    getLiveSegment: (locatorKey, sectionIndex) => {
      // full 模式用 section.createDocument() 取段，节点不在当前视图；
      // 这里到 getContents() 已挂载的 iframe doc 里重新切出同一段，保证 isConnected=true。
      for (const doc of opts.getContents() || []) {
        for (const s of segmenter.segmentsOf(doc, sectionIndex)) {
          if (s.locatorKey === locatorKey && !injector.hasInjected(s.locatorKey)) return s;
        }
      }
      return undefined;
    },
    onProgress: () => emitProgress(queue.state().status),
  });

  /** 收集「窗口内 + 未注入 + 未被退避挡住」的待处理段（定位键已含节内序号，重复文本各自保留） */
  function collectPending(): ReturnType<typeof segmenter.segmentsOfDocs> {
    const docs = opts.getContents() || [];
    const cur = opts.getCurrentSection?.() ?? 0;
    const gate = { aheadSections: aheadOf() };
    return segmenter
      .segmentsOfDocs(docs, cur)
      .filter((s) => visibility.withinInjectGate(s.sectionIndex, gate))
      .filter((s) => !injector.hasInjected(s.locatorKey))
      // 失败段退避过滤：仍在退避期 / 已超重试上限的不重复送译（避免每轮即时无上限重试）
      .filter((s) => !injector.isBlocked(s.locatorKey));
  }

  async function injectAll(): Promise<void> {
    if (!enabled) return;
    // 预翻译队列负责窗口内注入，避免同一段重复送译；它收尾时自会 scheduleInject 补跑
    if (pretranslating) return;
    if (injecting) {
      // 翻译进行中翻页触发的调度不能直接丢：记脏，本批结束后自动补跑一轮
      injectDirty = true;
      return;
    }
    injecting = true;
    let total = 0;
    let injectedTotal = 0;
    /** 译文与原文一致（已是目标语言）而未注入的段数 */
    let skippedTotal = 0;
    try {
      const pending = collectPending();
      total = pending.length;
      if (!total) {
        getLogger().info("[REword][双语] injectAll：无待注入段落（docs=0 或全部已注入/被排除）");
        return;
      }
      // 重复文本在窗口里可能出现多次（重复对白 / 分隔符）：送译按文本去重，
      // 注入仍按每个出现位置各做一次 —— 同一句只付一次钱，但不留空白。
      const textIdx = new Map<string, number>();
      const uniqTexts: string[] = [];
      const uniqCtx: (string | null)[] = [];
      const fanout: number[] = [];
      for (const s of pending) {
        let i = textIdx.get(s.text);
        if (i === undefined) {
          i = uniqTexts.length;
          textIdx.set(s.text, i);
          uniqTexts.push(s.text);
          uniqCtx.push(s.prev && s.prev.trim() ? s.prev : null);
        }
        fanout.push(i);
      }
      // uniq 序号 → 窗口内哪些段落用到它（注入按出现位置逐个做）
      const segsByUniq = new Map<number, number[]>();
      fanout.forEach((u, j) => {
        const arr = segsByUniq.get(u);
        if (arr) arr.push(j);
        else segsByUniq.set(u, [j]);
      });
      const batches = chunkTexts(uniqTexts, INJECT_BATCH_MAX_CHARS, INJECT_BATCH_MAX_SEGMENTS);
      getLogger().info(
        `[REword][双语] injectAll：窗口内待注入 ${total} 段（去重 ${uniqTexts.length} 条，${batches.length} 片增量注入）`,
      );

      const uniqTr: string[] = new Array(uniqTexts.length).fill("");
      const uniqProvider: (string | null)[] = new Array(uniqTexts.length).fill(null);
      const uniqFromCache: boolean[] = new Array(uniqTexts.length).fill(false);
      const sectionsCached = new Set<number>();
      const t0 = Date.now();
      let failedBatches = 0;
      /** 被预翻译接管而中断：剩余段由队列负责，不算「本轮失败」 */
      let interrupted = false;

      for (const batch of batches) {
        if (!enabled) return; // 关闭双语：立即停，不再送译后续分片
        // 预翻译接管：后续由队列负责注入，已发出的这批结果仍会入缓存
        if (pretranslating) {
          interrupted = true;
          break;
        }

        try {
          const res = await withTimeout(
            translateTexts(batch.map((i) => uniqTexts[i]), batch.map((i) => uniqCtx[i])),
            INJECT_BATCH_TIMEOUT_MS,
            "翻译超时(60s)：AI 服务无响应，请检查网络与 API 配置",
          );
          batch.forEach((ui, j) => {
            uniqTr[ui] = res.texts[j] ?? "";
            uniqProvider[ui] = res.providers[j] ?? null;
            uniqFromCache[ui] = !!res.fromCache[j];
          });
        } catch (e) {
          // 单片失败/超时只影响这一片：留空交给注入器退避，后续分片照常跑
          failedBatches++;
          getLogger().warn(
            `[REword][双语] 分片翻译失败（${batch.length} 段），继续后续分片：${String((e as Error)?.message || e)}`,
          );
        }

        // 本片译完立即注入（这就是「增量注入」：首批译文不必等整窗）
        if (!enabled) return;
        const segs: ReturnType<typeof collectPending> = [];
        const trs: string[] = [];
        for (const ui of batch) {
          const tr = uniqTr[ui] || "";
          for (const j of segsByUniq.get(ui) ?? []) {
            segs.push(pending[j]);
            trs.push(tr);
            if (tr.trim()) {
              const p = pending[j];
              if (typeof p.sectionIndex === "number" && p.sectionIndex >= 0) sectionsCached.add(p.sectionIndex + 1);
            }
          }
        }
        const ir = await injector.injectBatch({ segments: segs, translations: trs });
        injectedTotal += ir.injected;
        skippedTotal += ir.skipped ?? 0;
        opts.onProgress?.(injectedTotal, total, false);
      }

      const latencyMs = Date.now() - t0;
      getLogger().info(
        `[REword][双语] 窗口注入完成：成功 ${injectedTotal}/${total} 段（${skippedTotal} 段原文已是目标语言，不注入），失败分片 ${failedBatches}/${batches.length}，耗时 ${latencyMs}ms`,
      );
      if (injectedTotal === 0 && total > 0) {
        getLogger().warn("[REword][双语] 窗口内 0 段注入成功（AI 返回空译文或元素已断开）");
      }

      // —— 成本与引擎状态遥测（按唯一文本聚合，避免重复段重复计数）——
      const answered = uniqTexts.length;
      const cacheHits = uniqFromCache.filter(Boolean).length;
      const engineCounts: Record<string, number> = {};
      let tencentChars = 0;
      uniqProvider.forEach((p, i) => {
        if (!p) return;
        engineCounts[p] = (engineCounts[p] || 0) + 1;
        if (p === "tencent") tencentChars += uniqTexts[i]?.length || 0;
      });
      telemetry.emit({ phase: "done", bookId: opts.bookId, segmentCount: answered, latencyMs, runId });
      if (cacheHits > 0) {
        telemetry.emit({ phase: "hit", bookId: opts.bookId, engine: "cache", segmentCount: cacheHits, runId });
      }
      for (const [eng, cnt] of Object.entries(engineCounts)) {
        telemetry.emit({
          phase: "try",
          bookId: opts.bookId,
          engine: eng,
          segmentCount: cnt,
          chars: eng === "tencent" ? tencentChars : undefined,
          runId,
        });
      }
      telemetry.emit({
        phase: "cost",
        bookId: opts.bookId,
        segmentCount: answered,
        fromCache: cacheHits > 0,
        chars: tencentChars,
        runId,
      });

      if (opts.onSectionsCached && sectionsCached.size) {
        opts.onSectionsCached(opts.bookId, [...sectionsCached].sort((a, b) => a - b));
      }
      // 被预翻译接管时不做「本轮完成」判定：剩余段由队列补，避免误弹部分失败提示
      opts.onProgress?.(injectedTotal, total, !interrupted);
    } catch (e) {
      console.warn("[REword] 双语v2 注入失败:", e);
      getLogger().error("[REword][双语] injectAll 异常:", { error: String((e as Error)?.message || e) });
      telemetry.emit({ phase: "error", bookId: opts.bookId, error: String((e as Error)?.message || e), runId });
      opts.onProgress?.(injectedTotal, total, true);
    } finally {
      injecting = false;
      // 翻译期间被吞掉的调度在这里补跑（关闭双语后不补）
      if (injectDirty) {
        injectDirty = false;
        if (enabled) scheduleInject();
      }
    }
  }

  function scheduleInject(): void {
    if (injectTimer) clearTimeout(injectTimer);
    injectTimer = setTimeout(() => {
      void injectAll();
    }, 300);
  }

  function segmentStats(): { count: number; chars: number } {
    const docs = opts.getContents() || [];
    const cur = opts.getCurrentSection?.() ?? 0;
    const segs = segmenter.segmentsOfDocs(docs, cur);
    return { count: segs.length, chars: segs.reduce((s, x) => s + x.text.length, 0) };
  }

  function segmentTexts(): string[] {
    const docs = opts.getContents() || [];
    const cur = opts.getCurrentSection?.() ?? 0;
    return segmenter.segmentsOfDocs(docs, cur).map((s) => s.text);
  }

  /**
   * 整书预翻译：默认 full（惰性遍历全书 sections，名副其实地覆盖全书）。
   * 渐进式（progressive）不需要弹窗触发 —— 它就是 onViewLoad 的常规行为：
   * 每次翻页把「当前 + 后 N 分节」（N=预取分节数，默认 2）的块送译并注入。
   */
  async function pretranslateAll(po?: PretranslateOptions): Promise<void> {
    lastPo = po;
    const signal = po?.signal;
    txExtra = { model: po?.model, overwrite: po?.overwrite, signal, engine: po?.engine };
    const lanes = po?.concurrency && po.concurrency > 0 ? po.concurrency : PRETRANSLATE_DEFAULTS.lanes;
    const blocksPerLane = po?.batchSize && po.batchSize > 0 ? po.batchSize : PRETRANSLATE_DEFAULTS.blocksPerLane;
    queue.cancel(); // 重入时先停掉上一轮
    startedAt = Date.now();
    startDone = 0;

    // 缓存短路（防白烧 token）：仅在 progressive 模式下成立 ——
    // progressive 的视野就是窗口，checkCached 全命中 = 真的没事可做。
    // full 模式不能用这个短路：它的视野是全书，而 checkCached 只能查窗口内的
    // 已加载分节，全命中并不代表全书其余分节已译（会漏译）。
    if (po?.full === false && !po?.overwrite && opts.checkCached) {
      const texts = segmentTexts();
      if (texts.length) {
        try {
          const flags = await opts.checkCached(texts);
          if (flags.length && flags.every(Boolean)) {
            emitProgress("done");
            return;
          }
        } catch {
          // 查询失败则照常走队列，不因短路判定失败而中断预翻译
        }
      }
    }

    emitProgress("running");
    pretranslating = true;
    try {
      await queue.start({
        bookId: opts.bookId,
        mode: po?.full === false ? "progressive" : "full",
        lanes,
        blocksPerLane,
        aheadSections: aheadOf(),
        signal,
      });
    } finally {
      pretranslating = false;
    }
    const finalStatus = queue.state().status;
    emitProgress(
      finalStatus === "cancelled" ? "cancelled" : finalStatus === "error" ? "error" : "done",
    );
    telemetry.emit({ phase: "done", bookId: opts.bookId, segmentCount: queue.state().done, runId });
    // 收尾补一次窗口注入：预翻译期间被抑制的 injectAll 在这里补上
    if (enabled) scheduleInject();
  }

  /**
   * 预扫描（P1-1）：不送译、不花钱，只统计全书段数/字数/已缓存数。
   * 结果缓存在 scanTotals，后续进度里的 Token 估算直接复用。
   */
  async function pretranslateScan(
    scanOpts?: { full?: boolean; signal?: AbortSignal },
  ): Promise<PretranslateScan> {
    // progressive 的扫描范围就是窗口：无法提供 setSections 时 scan 会走窗口分支
    const r = await queue.scan(scanOpts?.signal);
    scanTotals = { total: r.total, chars: r.chars };
    return r;
  }

  return {
    get enabled() {
      return enabled;
    },
    setEnabled(on: boolean): void {
      enabled = on;
      if (!on) {
        injector.clear();
      } else {
        scheduleInject();
      }
    },
    refresh(): void {
      if (enabled) scheduleInject();
    },
    onViewLoad(): void {
      if (!enabled) return;
      scheduleInject();
      // 翻页推进窗口后，把窗口内已缓存但未注入的块补注进去（纯缓存读）
      void queue.pumpFromCache();
    },
    segmentStats,
    segmentTexts,
    pretranslateScan,
    pretranslatePause(): void {
      queue.pause();
    },
    pretranslateResume(): void {
      queue.resume();
    },
    pretranslateAll,
    destroy(): void {
      enabled = false;
      if (injectTimer) clearTimeout(injectTimer);
      queue.cancel();
      injector.clear();
    },
  };
}
