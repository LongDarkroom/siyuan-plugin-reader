/**
 * ES 运行时 API 补丁（2026-11-19 · 移动端 P0）
 * ==================================================================
 * ## 为什么需要这个文件
 *
 * `src/reader/vendor/foliate-js/epub.js` 用了 **ES2024 的 `Object.groupBy` /
 * `Map.groupBy`**（第 244 / 266 / 270 / 272 / 328 行）。这两个 API 需要
 * Chrome 117+ / Safari 17.4+；不少国产 ROM 的 Android WebView 还停在
 * Chrome 90 上下 ⇒ `TypeError: Object.groupBy is not a function`
 * ⇒ **打开 EPUB 后正文与目录全空**（不是报错弹窗，是静默白屏，最难排查）。
 *
 * 桌面端思源用的是内置 Chromium，基本都够新；**这个坑只在手机上暴露**。
 *
 * ## 为什么放在 index.ts 的 onload 里，而不是改 vendored 文件
 *
 * 已追完整条导入链：
 *
 *   ReaderView.svelte:67   import "../vendor/foliate-js/view-light.js"
 *     └─ view-light.js:98  const { EPUB } = await import('./epub.js')   ← 动态 import
 *          └─ epub.js:244  Object.groupBy(...)                          ← 仅解析 EPUB 时执行
 *
 * 也就是说 **不是模块求值期就调用**，而是「开书那一刻」才调用。
 * ⇒ 补丁只要在打开第一本书之前装好即可，`onload()` 同步阶段装上绝对够早，
 *   不必碰 vendor 代码（vendor 一升级就会被覆盖，改它等于埋雷）。
 *
 * ## 幂等
 *
 * 先判 `typeof === "function"` 再赋值：已经支持的浏览器上**绝不覆盖原生实现**
 * （原生实现有引擎级优化，且行为必须与规范完全一致）。
 */

/** 分组回调：与规范一致，收到 (元素, 下标) */
type GroupFn = (value: any, index: number) => any;

/**
 * 装 ES2024 分组 API 补丁（幂等，可重复调用）。
 *
 * 只在缺失时赋值；已存在（现代浏览器 / Node 21+）时整段跳过。
 */
export function installEsPolyfills(): void {
  const g: any = globalThis;

  if (typeof g.Object?.groupBy !== "function") {
    g.Object.groupBy = function groupBy(items: any, fn: GroupFn) {
      if (items == null) {
        throw new TypeError("Object.groupBy: items is null or undefined");
      }
      if (typeof fn !== "function") {
        throw new TypeError("Object.groupBy: callback is not a function");
      }
      // 规范要求返回 null 原型对象（避免 "__proto__" 之类的键污染原型链）
      const out: Record<string, any[]> = Object.create(null);
      const buckets = new Map<string, any[]>();
      let i = 0;
      for (const v of items as Iterable<any>) {
        const key = String(fn(v, i++));
        const bucket = buckets.get(key);
        if (bucket) bucket.push(v);
        else buckets.set(key, [v]);
      }
      // 规范：键按字符串升序写入（epub.js 只做查表，排序无关结果，但保真不花钱）
      for (const key of Array.from(buckets.keys()).sort()) {
        out[key] = buckets.get(key)!;
      }
      return out;
    };
  }

  if (typeof g.Map?.groupBy !== "function") {
    g.Map.groupBy = function groupBy(items: any, fn: GroupFn) {
      if (items == null) {
        throw new TypeError("Map.groupBy: items is null or undefined");
      }
      if (typeof fn !== "function") {
        throw new TypeError("Map.groupBy: callback is not a function");
      }
      const out = new Map<any, any[]>();
      let i = 0;
      for (const v of items as Iterable<any>) {
        // Map.groupBy 的键**不做字符串化**（可以是对象），与 Object 版不同
        const key = fn(v, i++);
        const bucket = out.get(key);
        if (bucket) bucket.push(v);
        else out.set(key, [v]);
      }
      return out;
    };
  }
}
