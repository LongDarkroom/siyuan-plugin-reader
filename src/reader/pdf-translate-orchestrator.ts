/**
 * PDF 整本翻译编排（2026-11-17）
 * ==================================================================
 *
 * 把「800 页 PDF → 双语对照 PDF」这条链路的**调度**部分独立出来：
 * 扫描 → 分批翻译 → 缓存 → 生成 → 落盘。
 *
 * 为什么单独写而不用现有的 pretranslate 队列：
 *  现有队列深度耦合 EPUB 的 section/segment 抽象（`PretranslateDeps` 依赖
 *  `SectionSource` / `SegmenterLike` / `Injector`），PDF 是「页 → 段落 → 译文 →
 *  生成 PDF」，形态完全不同（PDF 的产物是**新文件**，不是往书里注入译文）。
 * 硬套会把 EPUB 的注入模型一起拖进来，反而更乱。
 *  ⇒ 这里复用它的**翻译调用**（translateBatch）、**缓存**（SQLite）与**限流经验**，
 *    但调度自己写。
 *
 * ## 限流是本模块的核心
 * qwen-mt-flash 的 TPM 上限是 35,000 token/分钟（华北2），RPM 60。
 * 实测 800 页约 62 万 token ⇒ **不节流就会 429**；按 TPM 节流后约 36 分钟。
 * 节流策略：滑动窗口记录最近 60 秒的 token 消耗，超出 TPM 就等。
 */

/** 一段待译文本 */
export interface PdfSegment {
  /** 1-based 页码 */
  page: number;
  /** 段落在该页内的序号 */
  index: number;
  text: string;
}

/** 翻译进度回调 */
export interface PdfTranslateProgress {
  /** 已译段数 */
  done: number;
  /** 总段数 */
  total: number;
  /** 当前页 */
  page: number;
  /** 总页数 */
  totalPages: number;
  /** 估算剩余秒数（0 = 未知） */
  etaSeconds: number;
  /** 本轮是否全部命中缓存（没花 token） */
  allFromCache: boolean;
}

/** 编排器的依赖（宿主注入，便于测试） */
export interface PdfTranslateDeps {
  /** 批量翻译（返回与输入等长的译文数组） */
  translateBatch: (
    texts: string[],
    from: string,
    to: string,
    bookId: string,
    extra?: { signal?: AbortSignal; overwrite?: boolean },
  ) => Promise<string[]>;
  /** 查缓存命中（同序 boolean[]） */
  checkCached?: (texts: string[]) => Promise<boolean[]>;
  /**
   * 读缓存译文（key = 原文）。
   *
   * ⚠️ 缓存命中**不等于**不用管：命中段落的译文就在缓存里，必须取出来填进结果，
   *    否则那一页只有未命中的段落有译文（实测踩过：结果变成
   *    `原文\n\n原文\n\n译文` 这种前后拼接的怪东西）。
   */
  getCached?: (texts: string[]) => Promise<Map<string, string>>;
  /** 进度上报 */
  onProgress?: (p: PdfTranslateProgress) => void;
  /** 中断信号 */
  signal?: AbortSignal;
}

/** 编排结果 */
export interface PdfTranslateResult {
  /** 每页译文（按页码；无译文的页为空串） */
  translations: Map<number, string>;
  /** 实际调用翻译的段数 */
  translated: number;
  /** 命中缓存的段数 */
  cached: number;
}

/**
 * 令牌桶限流器（按 TPM）。
 *
 * qwen-mt-flash 华北2：TPM 35,000、RPM 60；国际站 TPM 100,000。
 * 这里按「每分钟 token 预算」实现滑动窗口，并额外限制 RPM。
 */
export class TokenBucketLimiter {
  private stamps: Array<{ at: number; tokens: number }> = [];
  private requestStamps: number[] = [];
  private readonly tpm: number;
  private readonly rpm: number;
  private readonly now: () => number;

  constructor(tpm: number, rpm: number, now: () => number = () => Date.now()) {
    this.tpm = tpm;
    this.rpm = rpm;
    this.now = now;
  }

  /** 记一次消耗 */
  consume(tokens: number): void {
    const t = this.now();
    this.stamps.push({ at: t, tokens });
    this.requestStamps.push(t);
  }

  /** 还要等多久才够用（毫秒；0 = 现在就能发） */
  waitMs(estimatedTokens: number): number {
    const t = this.now();
    // 滑出 60 秒窗口
    while (this.stamps.length > 0 && t - (this.stamps[0] as { at: number }).at > 60_000) {
      this.stamps.shift();
    }
    while (
      this.requestStamps.length > 0 &&
      t - (this.requestStamps[0] as number) > 60_000
    ) {
      this.requestStamps.shift();
    }
    const used = this.stamps.reduce((s, x) => s + x.tokens, 0);
    const tokenWait = used + estimatedTokens > this.tpm ? used + estimatedTokens - this.tpm : 0;
    const rpmWait =
      this.requestStamps.length >= this.rpm ? 60_000 - (t - (this.requestStamps[0] as number)) : 0;
    return Math.max(tokenWait, rpmWait);
  }

  /** 已用 token（窗口内） */
  usedTokens(): number {
    const t = this.now();
    while (this.stamps.length > 0 && t - (this.stamps[0] as { at: number }).at > 60_000) {
      this.stamps.shift();
    }
    return this.stamps.reduce((s, x) => s + x.tokens, 0);
  }
}

/** 单次请求的段数上限（与 qwen-mt provider 的分块口径一致） */
export const SEGMENTS_PER_REQUEST = 12;

/**
 * 把段落切成翻译批次。
 *
 * 每批最多 SEGMENTS_PER_REQUEST 段，且总字符不超过上限——
 * 与 qwen-mt provider 的 3500 字符/请求口径一致（provider 内部还会再切一次，
 * 这里切是为了让进度/缓存粒度更细）。
 */
export function chunkSegments(
  segments: ReadonlyArray<PdfSegment>,
  maxSegments = SEGMENTS_PER_REQUEST,
  maxChars = 3500,
): PdfSegment[][] {
  const out: PdfSegment[][] = [];
  let cur: PdfSegment[] = [];
  let chars = 0;
  for (const seg of segments) {
    const len = seg.text.length;
    if (cur.length > 0 && (cur.length >= maxSegments || chars + len > maxChars)) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(seg);
    chars += len;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * 编排：把整本 PDF 的段落翻译完。
 *
 * 流程：分段 → 先查缓存 → 未命中的分批送翻译 → 合并回每页译文。
 *
 * @param segments 全部待译段落
 * @param pages     全部页码（没段落的页也要出现在结果里，值为空串）
 */
export async function translatePdfSegments(
  segments: ReadonlyArray<PdfSegment>,
  pages: ReadonlyArray<number>,
  deps: PdfTranslateDeps,
  opts: { tpm?: number; rpm?: number; from?: string; to?: string; bookId?: string } = {},
): Promise<PdfTranslateResult> {
  const tpm = opts.tpm ?? 35_000;
  const rpm = opts.rpm ?? 60;
  const from = opts.from ?? "auto";
  const to = opts.to ?? "zh";
  const bookId = opts.bookId ?? "pdf";
  const limiter = new TokenBucketLimiter(tpm, rpm);

  // 每页一个「译文槽位」数组，**按段在 segments 里的原始顺序**排。
  // ⚠️ 不能用「翻译完再 push」——那会让译文顺序与原文顺序不一致
  //   （缓存命中段与未命中段混排时尤其明显）。
  const perPage = new Map<number, string[]>();
  const slotOf = new Map<PdfSegment, number>();
  for (const p of pages) perPage.set(p, []);
  for (const seg of segments) {
    const arr = perPage.get(seg.page);
    if (arr) {
      slotOf.set(seg, arr.length);
      arr.push(""); // 占位，等译文填
    }
  }

  // 先查缓存：命中的直接用，不花钱。
  // 命中段的译文要从缓存里**取出来**（不取就只有未命中段有译文）。
  const allTexts = segments.map((s) => s.text);
  const cachedFlags = deps.checkCached ? await deps.checkCached(allTexts) : [];
  const cachedMap = deps.getCached ? await deps.getCached(allTexts) : new Map<string, string>();
  let translated = 0;
  let cached = 0;

  // 段对象 → 全局下标（避免 indexOf 的 O(n²)）
  const segIndex = new Map<PdfSegment, number>();
  for (let i = 0; i < segments.length; i++) segIndex.set(segments[i] as PdfSegment, i);

  const batches = chunkSegments(segments);
  const startTime = Date.now();
  let processed = 0;

  for (const batch of batches) {
    if (deps.signal?.aborted) break;
    // 本批里未命中缓存的部分才送翻译。
    // ⚠️ 不能用 segments.indexOf(batch[i]) 反查全局下标——那是 O(n²)，
    //    800 页（数千段）会跑成百万次查找。chunkSegments 保持原顺序，
    //    用游标推进即可拿到全局下标。
    const todoIdx: number[] = [];
    for (let i = 0; i < batch.length; i++) {
      const seg = batch[i] as PdfSegment;
      const globalIdx = segIndex.get(seg) ?? -1;
      const hit = globalIdx >= 0 && cachedFlags[globalIdx] === true;
      if (hit) {
        cached++;
        processed++;
        // 从缓存取译文填进对应槽位（缺缓存值时留空，不重复请求）
        const hitText = cachedMap.get(seg.text) ?? "";
        const arr = perPage.get(seg.page);
        const slot = slotOf.get(seg);
        if (arr && slot !== undefined) arr[slot] = hitText;
      } else {
        todoIdx.push(i);
      }
    }
    if (todoIdx.length === 0) {
      report(deps, processed, segments.length, batch, startTime, translated === 0 && cached > 0);
      continue;
    }

    const texts = todoIdx.map((i) => (batch[i] as PdfSegment).text);
    // 估算 token（粗粒度够用：限流只要知道大概占用）
    const est = texts.reduce((s, t) => s + Math.ceil(t.length * 0.4), 0) * 2;
    const wait = limiter.waitMs(est);
    if (wait > 0) await sleep(Math.min(wait, 15_000), deps.signal);

    let out: string[];
    try {
      out = await deps.translateBatch(texts, from, to, bookId, { signal: deps.signal });
    } catch (e) {
      if (deps.signal?.aborted) break;
      throw e;
    }
    limiter.consume(est);
    for (let k = 0; k < todoIdx.length; k++) {
      const seg = batch[todoIdx[k] as number] as PdfSegment;
      const arr = perPage.get(seg.page);
      const slot = slotOf.get(seg);
      if (arr && slot !== undefined) arr[slot] = out[k] ?? "";
      translated++;
      processed++;
    }
    report(deps, processed, segments.length, batch, startTime, translated === 0);
  }

  // 合并每页译文
  const translations = new Map<number, string>();
  for (const [page, arr] of perPage) {
    translations.set(page, arr.filter((t) => t !== "").join("\n\n"));
  }
  return { translations, translated, cached };
}

/** 上报进度 */
function report(
  deps: PdfTranslateDeps,
  done: number,
  total: number,
  batch: ReadonlyArray<PdfSegment>,
  startTime: number,
  allFromCache: boolean,
): void {
  if (!deps.onProgress) return;
  const elapsed = (Date.now() - startTime) / 1000;
  const rate = done > 0 ? done / elapsed : 0;
  const remaining = total - done;
  deps.onProgress({
    done,
    total,
    page: batch[0]?.page ?? 0,
    totalPages: 0,
    etaSeconds: rate > 0 ? Math.round(remaining / rate) : 0,
    allFromCache,
  });
}

/** 可中断的 sleep */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
