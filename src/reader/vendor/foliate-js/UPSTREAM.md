# foliate-js 本地副本溯源（provenance）

本目录是 [johnfactotum/foliate-js](https://github.com/johnfactotum/foliate-js) 的
vendored fork，服务于 RE 阅读器的 EPUB/MOBI/FXL 渲染。**不做整体升级**，只按需
cherry-pick 上游修复。

## 上游基线

基线钉在 **`6b11e174`（2025-11-28，"Properly handle empty fragments for MOBI (#107)"）**，
即包含 6b11e174、不含其后续源码提交。

foliate-js 无 release 标签（version 恒为 0.0.0），无法按 tag 对齐，采用**特性标记法**
二分钉定（证据均可在本目录源码复核）：

| 上游提交 | 日期 | 本地是否存在 | 证据 |
|---|---|---|---|
| `052123be` Add EventTarget for transforming the book | 2025-03-29 | ✅ | epub.js:876 `eventTarget = new EventTarget()`；paginator.js:1768 `transformTarget?.addEventListener` |
| `26788cda` EPUB: support `srcset` | 2025-09-24 | ✅ | epub.js:1080 `querySelectorAll('[srcset]')` |
| `6b11e174` MOBI empty fragments (#107) | 2025-11-28 | ✅ | mobi.js:1010 `reduce((a, b) => a + b, 0)` |
| `a70ad3a1` EPUB: multiple publishers | 2026-03-04 | ❌ | epub.js:340 仍是旧式 `makeContributor(dc.publisher?.[0])` |
| `ab5abb9d` EPUB: pageBreakSource (#109) | 2026-03-05 | ❌ | 全目录 grep 无 `pageBreakSource` |

窗口内 `fd20452d`/`b0c02a52` 只改 package(-lock)，不落源码，故基线在源码层面
等价于 6b11e174..2026-03-04 区间。

## 运行时 pdfjs

- `vendor/pdfjs/pdf.mjs` 与插件根 `pdf.worker.mjs`：**4.7.76**。
- 上游 `12170962`（2026-03-05）已把 pdfjs 升到 5.5.207 —— **有意不跟进**，
  pdfjs 4→5 是独立项目（API 破坏性变更），不在 cherry-pick 范围。

## 本地改动面

带 `REword` 标记的文件（grep `REword` 可定位每一处）：
epub.js、epubcfi.js、fixed-layout.js、overlayer.js、paginator.js、pdf.js、
tts.js、view-light.js、view.js、footnotes.js（1 处）。

**无标记但有本地定制**（升级时须人工比对）：
- epub.js：`mapWithLimit`、`decodeURIPath`、`getCalibreUserMetadata`、封面兜底查找
- search.js：`collectBefore` / `collectAfter`
- mobi.js / view-light.js 等含 `transformTarget` 上游代码（来自 052123be，非本地补丁）

## cherry-pick 记录

| 上游提交 | 日期 | 合入方式 | 本地落点 |
|---|---|---|---|
| `b74d50e6` Fix: selections inside FILTER_SKIP wrappers must preserve offsets (#101) | 2026-03-05 | **融合**（非逐字）：本地 nodeToParts 已有 cfi-skip 属性上溯，将上游 filter 回调上溯 + documentElement 止界并入同一 while；回归测试块逐字移植进 tests/epubcfi-tests.js，另加 cfi-skip 属性变体 | epubcfi.js `nodeToParts`（≈L272-286，标记 `REword patch (2026-10-13)`）|

注：本 fork 的 CFI.fromRange/toRange 现网调用均不传 filter（跳过语义由
cfi-inert/cfi-skip 属性承担），#101 属**潜在分歧修复**，防未来传 filter 时踩坑。

产物侧注意：rollup（本仓 4.64.0，treeshake 默认开）能对全调用图证明 `filter`
恒为 undefined，会把 bundle 里 `filter && …===FILTER_SKIP` 折叠成 `(filter)`。
这是**正确的死代码消除**，不是构建损坏；核对产物时别按源码字面量强匹配这一段，
或临时 `--config` 里关 treeshake 复核（源码层由 test/smoke-foliate-101.test.mjs
钉死）。

## 后续同步策略

1. 只 cherry-pick 修 bug 的源码提交；依赖升级类（rollup/eslint/pdfjs）不入。
2. 每次合入在上表登记：上游 sha、日期、合入方式（逐字/融合）、本地落点。
3. epubcfi 层回归可用 jsdom 临时 harness 跑 `tests/epubcfi-tests.js`
   （需注入 `DOMParser`/`NodeFilter` 全局；测试文件用 `console.assert`，
   harness 须把失败转成非零退出）。
