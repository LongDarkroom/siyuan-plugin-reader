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
 *     （2026-11-20 在这三态之外再分第四态「恒等跳过」，见 InjectResult.skipped）
 *  4. **恒等译文不注入（2026-11-20）**：引擎对「本来就是目标语言」的段落会原样回吐，
 *     注入后就是重复行。这类块记进 skippedSet（视同已处理、不退避），
 *     否则不注入≠不花钱：每轮翻页还会再送一次。
 *  5. **裸文本块（2026-11-20 方案 A）**：章节首段常是直接挂在 div 下的文本节点，
 *     没有可打标的原文元素 → 译文按锚点插在容器内（insertBefore），
 *     幂等看「文本块之后第一个非空白兄弟是否已是译文块」，清理靠 looseDivsByKey 自持引用。
 *
 * 注入器只负责「把已有译文写进 DOM」，不发起任何网络请求 ——
 * 取译文由编排层（bilingual-v2.ts）先完成。
 */
import type { InjectBatch, InjectorLike } from "../core/types.ts";
import { INJECT_DEFAULTS, PRETRANSLATE_DEFAULTS } from "../core/types.ts";
import {
  buildTranslationEl,
  injectSibling,
  injectLooseText,
  isLooseTextTranslated,
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
  /**
   * 译文与原文一致（引擎把「已经是目标语言」的段落原样回吐）→ 不注入。
   * 计入已处理，后续轮次不再重复送译。
   */
  skipped: number;
}

/**
 * 恒等译文判定：折叠全部空白 + 转小写后与原文完全一致。
 * 2026-11-20 立：英文书里夹的中文简介页 / 中英混排行（「外文名： Madeline Carroll」）
 * 块级语种闸门（CJK 占比过半）拦不住，引擎按「译成中文」原样回吐，
 * 注入后就是一模一样的重复行。既然译文和原文没差别，就不值得再占一行。
 */
function isEchoTranslation(translation: string, source: string): boolean {
  const norm = (s: string): string => (s || "").replace(/\s+/g, "").toLowerCase();
  return norm(translation) === norm(source);
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
  /**
   * 「已是目标语言」的块（2026-11-20）：不注入译文，但视同已处理。
   * 与 injectedSet 分开放，是为了让 stats/injected 仍然只表示「界面上真出了译文」，
   * 也让 hasInjected 一处判定同时覆盖两种「不必再送译」。
   */
  const skippedSet = new Set<string>();
  const failedSet = new Map<string, FailRecord>();
  /**
   * 空译文退避（2026-11-19）：引擎对某段返回空串时旧实现不记任何状态，
   * 下一轮窗口刷新会再送译一次 —— 翻页越频繁越烧额度。这里与异常共用退避表规则，
   * 只是分类记录（stats 仍只把异常算作 failed）。
   */
  const emptySet = new Map<string, FailRecord>();
  const nodesByKey = new Map<string, Element>();
  /** 裸文本块的译文元素：它们不是任何原文元素的兄弟，只能自己记着自己 */
  const looseDivsByKey = new Map<string, HTMLElement>();

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
   * 视同已处理（不进退避、下轮不再送译）。
   * ⚠️ 必须记状态：光「不注入」而不记账，这段中文每轮翻页都会被重新送去翻译，
   * 反而比原来更烧额度。
   */
  function markSkipped(key: string): void {
    skippedSet.add(key);
    failedSet.delete(key);
    emptySet.delete(key);
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
    const result: InjectResult = { injected: 0, empty: 0, failed: 0, skipped: 0 };

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
        if (isEchoTranslation(tr, seg.text)) {
          // 译文与原文一致 = 这段本来就是目标语言，插上去只会多一行重复文字
          markSkipped(seg.locatorKey);
          result.skipped++;
          return;
        }
        const loose = seg.loose as { run?: Node; before?: Element | null } | undefined;
        if (loose && isLooseTextTranslated(loose.run ?? null)) {
          // 幂等：同一段可能被窗口注入与队列补注各撞上一次
          injectedSet.add(seg.locatorKey);
          result.injected++;
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
          const ok = loose
            ? injectLooseText(el, (loose.before as Element | null) ?? null, div)
            : injectSibling(el, div);
          if (!ok) {
            result.empty++;
            return;
          }
          applyAlignment(div, styles[j]);
          // 只有走到这一步（译文非空 + 插入成功）才算完成
          if (loose) {
            // 裸文本块没有可打标的原文元素（文本节点无 setAttribute，父容器整章共用会误伤），
            // 自持译文引用即可：清理时直接 remove，绝不能用 removeTranslationSibling(容器)。
            looseDivsByKey.set(seg.locatorKey, div);
          } else {
            el.setAttribute("data-reword-translated", "1");
            nodesByKey.set(seg.locatorKey, el);
          }
          injectedSet.add(seg.locatorKey);
          skippedSet.delete(seg.locatorKey);
          failedSet.delete(seg.locatorKey);
          emptySet.delete(seg.locatorKey);
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
      return injectedSet.has(locatorKey) || skippedSet.has(locatorKey);
    },
    erase(locatorKey: string): void {
      const el = nodesByKey.get(locatorKey);
      if (el) {
        el.removeAttribute("data-reword-translated");
        removeTranslationSibling(el);
      }
      looseDivsByKey.get(locatorKey)?.remove();
      injectedSet.delete(locatorKey);
      skippedSet.delete(locatorKey);
      nodesByKey.delete(locatorKey);
      looseDivsByKey.delete(locatorKey);
    },
    clear(): void {
      for (const el of nodesByKey.values()) {
        if (!(el as Element).isConnected) continue;
        el.removeAttribute("data-reword-translated");
        removeTranslationSibling(el);
      }
      for (const div of looseDivsByKey.values()) div.remove();
      injectedSet.clear();
      skippedSet.clear();
      nodesByKey.clear();
      looseDivsByKey.clear();
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
