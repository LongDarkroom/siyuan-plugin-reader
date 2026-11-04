import { logSwallow } from "../core/safe.ts";
/**
 * 阅读器 - 作者对齐意图快照（2026-11-01 新增，对标 Readest `keepTextAlignment`）
 * ------------------------------------------------------------------------------
 *
 * ## 要解决的问题
 * 我们的对齐默认值改到 **body 层**（`html body { text-align: justify|start }`）之后，
 * 书籍自己声明的对齐（`p { text-align: center }` —— 诗、题词、版权页）会**原样保留**。
 * 这正是 Readest 观感更好的原因之一。
 *
 * 但还有两个例外必须由用户设置说了算，否则「按作者意图保留」会变成「设置失效」：
 *   ① 书籍写死 `text-align: left` 的块 —— 用户开着「两端对齐」时，
 *      正文应当统一两端对齐（否则同一页里左对齐/两端对齐混排，反而更乱）；
 *   ② 书籍写死 `text-align: justify` 的块 —— 用户**关掉**两端对齐时，
 *      应当回到顶格（否则那一段仍是两端对齐，开关形同虚设）。
 *
 * ⇒ 需要知道「这个元素**作者**原本写的是什么对齐」。
 *
 * ## 怎么知道：读计算样式，而不是解析 CSS
 * 元素自身的声明永远赢过继承值 ⇒ 只要我们的默认值只作用在 body 层，
 * `getComputedStyle(el).textAlign` 读到的就是**作者声明**的值
 * （没声明的元素读到继承来的默认值，无所谓 —— 两种取值都已覆盖）。
 * 这也是为什么对齐默认值**必须**放在 body 层：一旦在段落层用 !important 压，
 * 计算值就全被压平成同一个值，作者意图彻底丢失。
 *
 * ## 为什么两阶段（先全读、再全写）
 * Readest 的原话：早期版本在同一个 forEach 里「读 computed style → 加 class」，
 * 而 `classList.add` 会让文档样式缓存失效（选择器可能命中后代），
 * 于是循环里下一个 `getComputedStyle()` 触发**整篇文档**的样式重算 ——
 * Readest 在 Android 上实测到 1210ms 的 Forced reflow。
 * 两阶段（读一遍 / 再写一遍）把代价压到 O(N) 元素 + 1 次重算。
 *
 * **项目铁律遵守**：本模块只读计算样式 + 加 class，不改元素 style 属性、
 * 不改书籍文件、不写回磁盘；class 随 foliate 重建文档自然消失，卸载零残留。
 */

/** 快照打上的 class（与 reader-style.ts 里施加层的选择器一一对应） */
export const ALIGN_CLASS_CENTER = "reword-align-center";
export const ALIGN_CLASS_LEFT = "reword-align-left";
export const ALIGN_CLASS_RIGHT = "reword-align-right";
export const ALIGN_CLASS_JUSTIFY = "reword-align-justify";

/** 候选元素：与施加层的段落选择器保持同一批（Readest 同款口径） */
const CANDIDATE_SELECTOR =
  ":is(div, p, blockquote, dd):not([data-foliate-chunk]):not(.reword-bilingual):not(.reword-bilingual *)";

/**
 * 读取元素的计算对齐值并映射到快照 class。
 * @returns class 名；无对应（start / inherit / 未知）时返回 null
 */
function alignClassOf(align: string): string | null {
  switch (align) {
    case "center":
      return ALIGN_CLASS_CENTER;
    case "left":
      return ALIGN_CLASS_LEFT;
    case "right":
      return ALIGN_CLASS_RIGHT;
    case "justify":
      return ALIGN_CLASS_JUSTIFY;
    default:
      return null;
  }
}

/**
 * 给内容文档里的块级元素打上「作者对齐意图」标记。
 *
 * @param doc foliate 内容文档
 * @returns 被打上标记的元素数（0 表示文档不可读或没有可标记的元素）
 */
export function keepTextAlignment(doc: Document | null | undefined): number {
  if (!doc) return 0;
  const win = doc.defaultView;
  if (!win || typeof win.getComputedStyle !== "function") return 0;

  let els: Element[] = [];
  try {
    els = Array.from(doc.querySelectorAll(CANDIDATE_SELECTOR));
  } catch (__swallowErr) { logSwallow(__swallowErr, "reader-align.ts · querySelectorAll", "debug"); }
  if (!els.length) return 0;

  // ── 读阶段：一次性收集全部计算对齐值 ──
  // 第一次 getComputedStyle 会触发一次样式/布局重算，之后的调用复用同一结果。
  const classes: (string | null)[] = new Array(els.length);
  for (let i = 0; i < els.length; i++) {
    let align = "";
    try {
      align = win.getComputedStyle(els[i] as Element).textAlign || "";
    } catch (__swallowErr) { logSwallow(__swallowErr, "reader-align.ts · getComputedStyle", "debug"); }
    classes[i] = alignClassOf(align);
  }

  // ── 写阶段：批量打 class（只触发一次样式失效）──
  let n = 0;
  for (let i = 0; i < els.length; i++) {
    const cls = classes[i];
    if (!cls) continue;
    try {
      const el = els[i] as Element;
      if (el.classList.contains(cls)) continue;
      el.classList.add(cls);
      n++;
    } catch (__swallowErr) { logSwallow(__swallowErr, "reader-align.ts · classList.add", "debug"); }
  }
  return n;
}
