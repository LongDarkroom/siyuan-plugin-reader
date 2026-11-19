/**
 * 双语运行时 · 注入器（L2 runtime）
 * ==================================================================
 * 替代旧 bilingual-v2.ts:249-278 的同步注入循环。三点变化：
 *
 *  1. **分帧有界**：每帧最多 perFrame（默认 8）条，跨帧用 rAF 续做，
 *     单帧长任务 < 50ms，不再一次性阻塞主线程。
 *  2. **读写分离**：一帧内先连续读 N 段原文样式（只触发 1 次 layout），
 *     再连续写 N 段译文（写不触发 layout）。强制同步布局从 2N 降到 O(1)。
 *  3. **三态**：成功才打 data-reword-translated；译文为空（未译出）留空、
 *     不打标、下轮自动补；抛异常进 failedSet 退避重试，绝不打标。
 *
 * 注入器只负责「把已有译文写进 DOM」，不发起任何网络请求 ——
 * 取译文由编排层（bilingual-v2.ts）先完成。
 */
import type { InjectBatch, InjectorLike } from "../core/types.ts";
import { INJECT_DEFAULTS, PRETRANSLATE_DEFAULTS } from "../core/types.ts";
import {
  buildTranslationEl,
  injectSibling,
  removeTranslationSibling,
  readParaStyle,
  applyAlignment,
  bindAiRedoDelegation,
  bindHideDelegation,
  segHash,
} from "../../bilingual-v2/render.ts";

export interface InjectResult {
  /** 成功注入并打标段数 */
  injected: number;
  /** 译文为空（留空，不打标，下轮补） */
  empty: number;
  /** 抛异常（进 failedSet，退避重试） */
  failed: number;
}

export interface InjectorOptions {
  perFrame?: number;
  /**
   * 失败重试上限（动态读取，默认 PRETRANSLATE_DEFAULTS.maxRetries=2）。
   * 返回 0 = 关闭自动重试（2026-09-05 设置项 bilingualRetry）。
   */
  maxRetries?: () => number;
  /** 是否渲染段落级「AI 重译」按钮 */
  showAiRedo?: boolean;
  onAiRedo?: (wrap: Element, sourceText: string) => void;
  /** 是否渲染段落级「删除译文」按钮 */
  showHideSegment?: boolean;
  /** 隐藏回调（已由编排层绑定 bookId） */
  onHideSegment?: (hash: string) => void;
  /** 帧调度器（默认 requestAnimationFrame；单测里可换成同步执行） */
  scheduleFrame?: (fn: () => void) => void;
}

export interface Injector extends InjectorLike {
  /** 注入一批（内部按 perFrame 分帧） */
  injectBatch(batch: InjectBatch): Promise<InjectResult>;
  /** 已到重试期的失败块定位键（tries 未超限） */
  retryableKeys(now?: number): string[];
  /** 该块是否被退避挡住（仍在退避期 或 已超重试上限）——collectPending 用它过滤 */
  isBlocked(locatorKey: string, now?: number): boolean;
  stats(): { injected: number; failed: number };
}

interface FailRecord {
  tries: number;
  nextAt: number;
}

/** 空译文重试用尽后的长冷却（不永久拉黑，网络恢复后还能自愈） */
const EMPTY_COOLDOWN_MS = 5 * 60_000;

export function createInjector(opts: InjectorOptions = {}): Injector {
  const perFrameDefault = opts.perFrame ?? INJECT_DEFAULTS.perFrame;
  /** 重试上限（动态读，支持设置开关关闭 = 0 即不自动重试） */
  const maxRetries = () =>
    opts.maxRetries && opts.maxRetries() >= 0 ? opts.maxRetries() : PRETRANSLATE_DEFAULTS.maxRetries;
  const injectedSet = new Set<string>();
  const failedSet = new Map<string, FailRecord>();
  /**
   * 空译文退避（2026-11-19）：引擎对某段返回空串时旧实现不记任何状态，
   * 下一轮窗口刷新会再送译一次 —— 翻页越频繁越烧额度。这里与异常共用退避表规则，
   * 只是分类记录（stats 仍只把异常算作 failed）。
   */
  const emptySet = new Map<string, FailRecord>();
  const nodesByKey = new Map<string, Element>();

  function nextFrame(): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => resolve();
      if (opts.scheduleFrame) opts.scheduleFrame(done);
      else if (typeof requestAnimationFrame === "function") requestAnimationFrame(done);
      else setTimeout(done, 16);
    });
  }

  function backoff(set: Map<string, FailRecord>, key: string): void {
    const prev = set.get(key);
    const tries = (prev?.tries ?? 0) + 1;
    const delays = PRETRANSLATE_DEFAULTS.retryDelaysMs;
    const delay = delays[Math.min(tries - 1, delays.length - 1)];
    set.set(key, { tries, nextAt: Date.now() + delay });
  }

  function markFailed(key: string): void {
    backoff(failedSet, key);
  }

  /**
   * 空译文退避：重试用尽后不永久拉黑，改为 5 分钟长冷却再放行。
   * 网络抖动/限流造成的空译会自然恢复；真正译不出的段也不会被每轮翻页反复送译。
   */
  function markEmpty(key: string): void {
    const prev = emptySet.get(key);
    const tries = (prev?.tries ?? 0) + 1;
    const delays = PRETRANSLATE_DEFAULTS.retryDelaysMs;
    const delay = tries <= delays.length ? delays[tries - 1] : EMPTY_COOLDOWN_MS;
    emptySet.set(key, { tries, nextAt: Date.now() + delay });
  }

  async function injectBatch(batch: InjectBatch): Promise<InjectResult> {
    const segments = batch.segments ?? [];
    const translations = batch.translations ?? [];
    const per = batch.perFrame && batch.perFrame > 0 ? batch.perFrame : perFrameDefault;
    const result: InjectResult = { injected: 0, empty: 0, failed: 0 };

    for (let i = 0; i < segments.length; i += per) {
      const slice = segments.slice(i, i + per);
      const texts = translations.slice(i, i + per);

      // 读阶段：连续读，浏览器合并为 1 次 layout
      const styles = slice.map((seg) =>
        seg.node ? readParaStyle(seg.node as Element) : { padLeft: 0, textIndent: 0 },
      );

      // 写阶段：建元素 → 插入 → 写样式 → 打标，全程不读
      slice.forEach((seg, j) => {
        const el = seg.node as Element | undefined;
        if (!el || !(el as Element).isConnected) {
          // foliate 翻页会重建 Document，旧节点失效 → 记为留空，下轮重新切出
          result.empty++;
          return;
        }
        const tr = (texts[j] || "").trim();
        if (!tr) {
          // 引擎返回空译：进入轻量退避，避免每轮翻页重复送译（打标仍不做，窗口过后自动重试）
          markEmpty(seg.locatorKey);
          result.empty++;
          return;
        }
        try {
          const doc = el.ownerDocument;
          if (!doc) {
            markFailed(seg.locatorKey);
            result.failed++;
            return;
          }
          const div = buildTranslationEl(doc, tr, {
            showAiRedo: !!opts.showAiRedo,
            showHide: !!opts.showHideSegment,
          });
          if (!injectSibling(el, div)) {
            result.empty++;
            return;
          }
          applyAlignment(div, styles[j]);
          // 只有走到这一步（译文非空 + 插入成功）才打标
          el.setAttribute("data-reword-translated", "1");
          injectedSet.add(seg.locatorKey);
          failedSet.delete(seg.locatorKey);
          emptySet.delete(seg.locatorKey);
          nodesByKey.set(seg.locatorKey, el);
          if (opts.showAiRedo && opts.onAiRedo) bindAiRedoDelegation(doc, opts.onAiRedo);
          if (opts.showHideSegment && opts.onHideSegment) {
            const onHide = opts.onHideSegment;
            bindHideDelegation(doc, (wrap, sourceText) => {
              onHide(segHash(sourceText));
              wrap.remove();
            });
          }
          result.injected++;
        } catch {
          markFailed(seg.locatorKey);
          result.failed++;
        }
      });

      if (i + per < segments.length) await nextFrame();
    }
    return result;
  }

  return {
    injectBatch,
    async inject(batch: InjectBatch): Promise<void> {
      await injectBatch(batch);
    },
    hasInjected(locatorKey: string): boolean {
      return injectedSet.has(locatorKey);
    },
    erase(locatorKey: string): void {
      const el = nodesByKey.get(locatorKey);
      if (el) {
        el.removeAttribute("data-reword-translated");
        removeTranslationSibling(el);
      }
      injectedSet.delete(locatorKey);
      nodesByKey.delete(locatorKey);
    },
    clear(): void {
      for (const el of nodesByKey.values()) {
        if (!(el as Element).isConnected) continue;
        el.removeAttribute("data-reword-translated");
        removeTranslationSibling(el);
      }
      injectedSet.clear();
      nodesByKey.clear();
    },
    retryableKeys(now = Date.now()): string[] {
      const out: string[] = [];
      for (const [key, rec] of failedSet) {
        if (rec.tries <= maxRetries() && rec.nextAt <= now) out.push(key);
      }
      return out;
    },
    isBlocked(key: string, now = Date.now()): boolean {
      const failed = failedSet.get(key);
      if (failed && (failed.tries > maxRetries() || failed.nextAt > now)) return true;
      // 空译文只看冷却时间（长冷却结束后仍可再试，不会永久拉黑）
      const empty = emptySet.get(key);
      return !!empty && empty.nextAt > now;
    },
    stats() {
      return { injected: injectedSet.size, failed: failedSet.size };
    },
  };
}
