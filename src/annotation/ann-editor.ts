import { t } from "../i18n/index.ts";
import { logSwallow } from "../core/safe.ts";
/**
 * 批注内联编辑器 —— lite Protyle 统一封装（2026-08-17）
 * ------------------------------------------------------------------
 * 把「思源 lite Protyle」的挂载 / 初始内容写入 / 序列化读取 / 销毁
 * 封装为参数化组件，供批注弹窗与汇总面板编辑态共用：
 *  - 复用思源 Protyle 引擎：快捷键（⌘B/⌘I/⌘U…）、粘贴富文本零转换、
 *    块引用 / 标签 / 公式等原生支持；
 *  - 元素需进入布局且有尺寸才能挂载（隐藏容器零尺寸会崩），用 rAF 重试；
 *  - 构造失败 / app 不可用 / 长时间未就绪 → 自动回退 contenteditable（保持旧行为）；
 *  - 读：BlockDOM2Md 序列化为 Kramdown（思源原生，含块引用/标签/公式）；
 *    写：旧数据 HTML → HTML2Md → Md2BlockDOM，新数据 Kramdown 直接渲染。
 */

import { Protyle } from "siyuan";
import { sanitizeHtml, stripIal, ensureBlockSeparators } from "./annotation-render.ts";
import { configureKramdownLute, htmlToMd } from "./lute.ts";
import { getLogger } from "../core/logger.ts";

/**
 * 思源默认浮动工具栏项（与桌面端 Protyle 一致）。
 * 当调用方未传入 toolbar 或传入空数组时回退到此列表，保证「选中文本即唤起原生工具栏」。
 * 注意：window.siyuan.config.editor 实际并不存在 toolbar 字段，故不能依赖它。
 */
export const DEFAULT_ANN_TOOLBAR = [
  "block-ref", "a", "|", "text", "strong", "em", "u", "s", "mark",
  "sup", "sub", "|", "code", "kbd", "tag", "inline-math", "inline-memo", "clear",
];

/**
 * lite Protyle 万一没有自行建块时的兜底空段落（只在 Protyle 初始化完成后仍为空才写入）。
 * ⚠️ 不要再用它来做「占位」：文案遮罩由宿主的 ::before 画，Protyle 自己那一段才是光标所在行。
 */
const PLACEHOLDER_BLOCK_HTML =
  '<div data-reword-placeholder="1" data-node-id="placeholder" data-type="NodeParagraph">' +
  '<div contenteditable="true"><br></div></div>';

/**
 * 布局诊断开关（默认关闭）。
 * 排查「批注编辑区首行空白」这类只能在真机复现的排版问题时置 true：会把 Protyle 各级容器
 * 的盒模型、wysiwyg 祖先链、空白测算打到控制台，并挂 __annDump() / __annWhy()。
 * 关闭时不打印、不挂全局、不注册观察器，对业务逻辑与包体无影响。
 */
let ANN_DEBUG_LAYOUT = false;

/** 单个元素的盒模型摘要（高度 / 上下内边距 / 上下外边距 / display） */
function annDebugDesc(n: Element | null): string {
  if (!n) return "∅";
  const el = n as HTMLElement;
  const cs = getComputedStyle(el);
  const cls = typeof el.className === "string" && el.className.trim()
    ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".")
    : "";
  return `${el.tagName.toLowerCase()}${cls} h=${Math.round(el.offsetHeight)}` +
    ` pt=${cs.paddingTop} mt=${cs.marginTop} mb=${cs.marginBottom} d=${cs.display}`;
}

/**
 * 逐个遍历页面样式表，列出「命中该元素且设置了 padding / display」的规则。
 * 用途：当某条覆盖没生效时，直接看是谁在赢，而不是靠猜。
 */
function annWhyBox(el: Element | null): string[] {
  const out: string[] = [];
  if (!el) return ["（元素为空）"];
  try {
    const walk = (list: CSSRuleList, href: string): void => {
      for (const rule of Array.from(list) as any[]) {
        // 媒体查询/图层等分组规则：递归进去
        if (rule.cssRules && !rule.selectorText) {
          try { walk(rule.cssRules, href); } catch { /* 忽略不可读分组 */ }
          continue;
        }
        const sel: string | undefined = rule.selectorText;
        if (!sel) continue;
        let hit = false;
        try { hit = el.matches(sel); } catch { hit = false; }
        if (!hit) continue;
        const p = rule.style?.getPropertyValue("padding");
        const pt = rule.style?.getPropertyValue("padding-top");
        const d = rule.style?.getPropertyValue("display");
        if (!p && !pt && !d) continue;
        const parts: string[] = [];
        if (p) parts.push(`padding:${p}${rule.style.getPropertyPriority("padding") === "important" ? "!" : ""}`);
        if (pt) parts.push(`padding-top:${pt}${rule.style.getPropertyPriority("padding-top") === "important" ? "!" : ""}`);
        if (d) parts.push(`display:${d}`);
        out.push(`  ${sel} → ${parts.join(" , ")}   [${href}]`);
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList | null = null;
      try { rules = (sheet as CSSStyleSheet).cssRules; } catch { continue; } // 跨域表读不到
      if (!rules) continue;
      walk(rules, (sheet.href || "inline").split("/").pop() || "inline");
    }
  } catch (e) {
    out.push("  （遍历失败：" + String(e) + "）");
  }
  return out.length ? out : ["  （没有任何规则设置 padding/display —— 可能来自内联样式）"];
}

/**
 * 打印一次布局快照（v2）。
 * v1 的 bug：this.el 本身就是 .protyle 元素，querySelector(".protyle") 查不到自身 → 容器链整段丢失。
 * v2 改为「从 wysiwyg 往上走祖先链」+「逐层列出 .protyle-content 直接子元素及其相对 top」，
 * 并直接算出「首块距 content 顶部还有多少像素」，让空白来源无处可藏。
 */
function dumpAnnLayout(label: string, root: HTMLElement | null, wysiwyg: HTMLElement | null): void {
  if (!ANN_DEBUG_LAYOUT) return;
  try {
    const L: string[] = [];
    L.push(`━━ [REword-Ann] 布局快照 · ${label} · ${new Date().toLocaleTimeString()} ━━`);
    const hostBox = root?.getBoundingClientRect();
    if (hostBox) L.push(`  宿主 h=${Math.round(hostBox.height)} top=${Math.round(hostBox.top)}`);
    const hostEl = wysiwyg?.closest ? (wysiwyg.closest(".reader-note-protyle") as HTMLElement | null) : null;
    L.push(`  作用域: wysiwyg.closest(".reader-note-protyle") = ${hostEl ? "命中" : "❌ 未命中（CSS 作用域失效）"}`);
    if (wysiwyg) L.push(`  wysiwyg 内联样式: ${wysiwyg.getAttribute("style") || "(空)"}`);

    const p = root
      ? (root.classList.contains("protyle") ? root : (root.querySelector(".protyle") as HTMLElement | null))
      : null;
    const content = (p?.querySelector(".protyle-content") as HTMLElement | null) || null;

    if (content) {
      const cb = content.getBoundingClientRect();
      const ccs = getComputedStyle(content);
      L.push(`  .protyle-content h=${Math.round(cb.height)} top=${Math.round(cb.top)}` +
        ` pt=${ccs.paddingTop} scrollTop=${Math.round(content.scrollTop)}`);
      L.push(`  .protyle-content 直接子元素 ${content.children.length} 个:`);
      Array.from(content.children).slice(0, 8).forEach((k, i) => {
        const el = k as HTMLElement;
        const b = el.getBoundingClientRect();
        L.push(`    <${i}> ${annDebugDesc(el)} 相对content顶=${Math.round(b.top - cb.top)}px`);
      });
    } else {
      L.push("  .protyle-content: ∅");
    }

    if (wysiwyg && root) {
      const chain: Element[] = [];
      let n: Element | null = wysiwyg;
      while (n && n !== root) { chain.push(n); n = n.parentElement; }
      L.push(`  wysiwyg 祖先链（含自身，自下而上 ${chain.length} 层）:`);
      chain.forEach((el) => {
        const b = el.getBoundingClientRect();
        L.push(`    · ${annDebugDesc(el)} top=${Math.round(b.top)}`);
      });
    }

    if (content && wysiwyg) {
      const cb = content.getBoundingClientRect();
      const wb = wysiwyg.getBoundingClientRect();
      const ccs = getComputedStyle(content);
      const wcs = getComputedStyle(wysiwyg);
      const first = wysiwyg.firstElementChild as HTMLElement | null;
      L.push(`  ▶ 空白测算: wysiwyg 顶距 content 顶 ${Math.round(wb.top - cb.top)}px` +
        `（content pt=${ccs.paddingTop}；wysiwyg pt=${wcs.paddingTop} mt=${wcs.marginTop}）`);
      L.push(`  ▶ 首块距 wysiwyg 顶 ${first ? Math.round(first.getBoundingClientRect().top - wb.top) : "-"}px` +
        `；wysiwyg h=${Math.round(wb.height)} 首块 h=${first ? Math.round(first.offsetHeight) : 0}`);
    }

    const items = wysiwyg ? Array.from(wysiwyg.children) : [];
    L.push(`  wysiwyg.children = ${items.length}`);
    items.slice(0, 8).forEach((k, i) => {
      const el = k as HTMLElement;
      const cs = getComputedStyle(el);
      const txt = (el.textContent || "").trim().slice(0, 16);
      L.push(
        `    [${i}] <${el.tagName.toLowerCase()}> type=${el.getAttribute("data-type") || "-"}` +
        ` node-id=${el.getAttribute("data-node-id") || "-"} h=${Math.round(el.offsetHeight)}` +
        ` mt=${cs.marginTop} mb=${cs.marginBottom} pt=${cs.paddingTop}` +
        ` placeholder=${el.hasAttribute("data-reword-placeholder") ? "Y" : "N"}` +
        ` text="${txt}"`,
      );
    });
    console.log(L.join("\n"));
  } catch (e) {
    console.log("[REword-Ann] 布局快照失败", e);
  }
}

/**
 * 判断 note 是否含表格（编辑态分流/提示用）。
 * lite Protyle（blockId:""）对表格仅支持单元格文本编辑，增删行列等结构性操作受限，
 * 故含表格时编辑区应给出能力提示（而非静默失败）。
 */
export function hasBlockTable(note: string): boolean {
  if (/<table[\s>]/i.test(note)) return true;
  const lines = (note || "").split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    const header = lines[i];
    const sep = lines[i + 1];
    if (header.includes("|") && /^\s*\|?[\s:\-|]+\|?\s*$/.test(sep) && sep.includes("-")) return true;
  }
  return false;
}

/** 内联编辑器配置 */
export interface AnnEditorOptions {
  /** 思源 ws.app 实例（挂载 lite Protyle 必需）；缺失时直接回退 contenteditable */
  app: any;
  /** 初始内容：Kramdown 或旧 HTML（自动 HTML2Md 转换后写入） */
  initial?: string;
  /**
   * 原生工具栏配置：传入有效数组即使用；为空/不传时自动回退思源默认工具栏
   * （DEFAULT_ANN_TOOLBAR），保证选中文字即唤起原生浮动栏。
   */
  toolbar?: any[];
  /** 空态变化回调（用于「占位符样式」切换）；参数 true = 内容为空 */
  onEmptyChange?: (empty: boolean) => void;
  /**
   * 原生浮动工具栏是否按**视口**定位（2026-11-06）。
   *
   * 思源默认把浮动栏夹在「最近的 .protyle 元素」的上下边之间：批注小卡片里
   * 那个容器只有两百来像素高，浮动栏会被压进卡片内、甚至跑到卡片外看不见。
   * 置 true 后给 toolbar.element / subElement 打 `data-position-boundary="viewport"`，
   * 思源改用量口尺寸夹取 → 浮动栏始终贴在选区上方的可视区域内。
   */
  toolbarViewportBoundary?: boolean;
  /** 挂载失败时是否回退 contenteditable（默认 true） */
  fallback?: boolean;
  /**
   * 只读预览模式（2026-08-18）：禁止编辑 / 不挂工具栏 / 不抢占焦点 / 不装空态观察器。
   * 用于批注面板/浮层把 note 以原生 Protyle 形式 1:1 还原展示。
   */
  readonly?: boolean;
  /** 挂载结果回调：true = 原生 Protyle 就绪；false = 回退（调用方决定是否显示静态兜底） */
  onReady?: (ok: boolean) => void;
}

/** 内联编辑器实例（由 mountAnnEditor 创建） */
export class AnnEditor {
  readonly el: HTMLElement;
  private opts: AnnEditorOptions;
  private protyle: any = null;
  private attempts = 0;
  private emptyObserver: MutationObserver | null = null;
  private inputHandler: (() => void) | null = null;
  private wysiwygEl: HTMLElement | null = null;
  private disposed = false;
  /** 回退 contenteditable 时挂载的轻量浮动样式栏（防御性兜底，保证「选中即显示」不落空） */
  private fallbackToolbarEl: HTMLElement | null = null;
  private fallbackSelHandler: ((e: Event) => void) | null = null;

  constructor(el: HTMLElement, opts: AnnEditorOptions) {
    this.el = el;
    this.opts = opts;
  }

  /** 是否成功挂载 lite Protyle（false = contenteditable 回退模式） */
  isProtyle(): boolean {
    return !!this.protyle && !!this.protyle?.protyle?.wysiwyg;
  }

  /** 开始挂载（rAF 重试直到容器有尺寸；失败自动回退 contenteditable） */
  mount(): void {
    if (!this.opts.app) {
      getLogger().warn("[REword-Ann] siyuan.app 不可用，批注编辑器回退 contenteditable");
      this.fallback();
      return;
    }
    const attempt = () => {
      if (this.disposed || this.protyle) return;
      const target = this.el;
      // 若此前因容器隐藏/构造失败已回退 contenteditable，先还原容器再挂 Protyle
      if (target.getAttribute("contenteditable") === "true") {
        target.removeAttribute("contenteditable");
        target.innerHTML = "";
      }
      // 容器必须可见且有高度，否则 lite Protyle 构造后 wysiwyg 无法初始化
      // 只读预览宿主可能大量离屏，重试上限收紧到 30 帧，避免占用过多 rAF
      if (!target.isConnected || target.getBoundingClientRect().height < 2) {
        if (this.attempts++ < (this.opts.readonly ? 30 : 120)) {
          requestAnimationFrame(attempt);
        } else {
          getLogger().warn("[REword-Ann] Protyle 容器长时间未就绪，回退 contenteditable");
          this.fallback();
        }
        return;
      }
      try {
        target.querySelector(".protyle")?.remove();
        // 只读预览：构造前快照当前焦点，构造后（Protyle 可能抢焦点）再还原，避免打断侧栏搜索框
        const prevActive = this.opts.readonly ? (document.activeElement as HTMLElement | null) : null;
        // 2026-08-18 修复（方案 A）：恢复 `lite: true`。
        //   完整 Protyle + blockId:"" 会在使用工具栏（setInlineMark 等内核事务）时，
        //   尝试写入「空 blockId 对应的块」（该块不在块树/索引中）→ 触发「请重建索引」。
        //   lite 模式不挂内核块树，编辑/工具栏均在本地 DOM 完成，天然不会触发索引报错；
        //   块级结构（表格/标题/列表/加粗等）由 write() 的 Md2BlockDOM 正确渲染。
        const p = new Protyle(this.opts.app, target, {
          lite: true,
          blockId: "",
          mode: "wysiwyg",
          render: {
            background: false,
            title: false,
            breadcrumb: false,
            gutter: false,
            scroll: false,
            // 隐藏块动作菜单（最右侧的「⋯」按钮），侧栏批注编辑区不需新增块的入口
            // （块级结构靠工具栏的「块引用 / 标签 / 公式」等内置项或直接粘贴）
          },
          hint: { extend: [] },
          // 只读预览：字面空数组，绕过下方的 DEFAULT_ANN_TOOLBAR 回退，彻底隐藏工具栏。
          // 编辑态：有有效数组则用之，否则回退思源默认工具栏，确保选中文字即唤起原生栏。
          toolbar: this.opts.readonly
            ? []
            : (Array.isArray(this.opts.toolbar) && this.opts.toolbar.length > 0
              ? this.opts.toolbar
              : DEFAULT_ANN_TOOLBAR),
        });
        this.protyle = p;
        this.attempts = 0;
        this.applyToolbarBoundary();

        const wysiwyg = p.protyle?.wysiwyg?.element as HTMLElement | null;
        if (wysiwyg) {
          // 2026-11-12（首行空白·实测收口）：
          // 控制台快照显示 .protyle-wysiwyg 计算值仍是 padding-top:16px、display:flex ——
          // 插件侧 CSS（.reader-note-protyle .protyle-wysiwyg{padding:0}）没能赢过后来加载的
          // Protyle 样式。批注框的留白本就该由外壳统一给（6px/10px），这里直接对内联样式
          // 加 important 钉死，绕开整条 CSS 级联，任何来源的样式都盖不回去。
          try {
            wysiwyg.style.setProperty("padding", "0", "important");
            wysiwyg.style.setProperty("margin", "0", "important");
            wysiwyg.style.setProperty("gap", "0", "important");
          } catch (__swallowErr) {
            logSwallow(__swallowErr, "ann-editor.ts · wysiwyg 内联留白清零", "debug");
          }
          const ro = !!this.opts.readonly;
          if (ro) {
            // 只读预览：跳过占位段落 / 空态观察 / 焦点抢占，仅把 note 渲染出来并设为只读
            if (this.opts.initial) this.write(this.opts.initial);
            this.applyReadonly(p, wysiwyg);
            this.el.classList.add("ann-editor--readonly");
            // 还原构造前快照的焦点（见上方 prevActive），不打断侧栏搜索框等
            if (prevActive) { try { prevActive.focus(); } catch (__swallowErr) { logSwallow(__swallowErr, "ann-editor.ts · try { prevActive.focus(); }", "debug"); } }
            this.opts.onReady?.(true);
          } else {
            // 2026-11-12 修复（光标比占位文案低一行）：**不要**在构造后立刻塞占位段落。
            // 此刻 Protyle 还没初始化 wysiwyg，childElementCount 恒为 0 ⇒ 每次都会塞一块；
            // 而 Protyle 随后自己也会建一个空段落 ⇒ 两行空段落叠在一起：
            // 光标落在第二行，宿主 ::before 画的「写点批注…」却在第一行 ⇒ 看起来光标错位一行。
            // 现在正常路径下 DOM 里只有 Protyle 自己那一行，空态判断也不再被伪块干扰。
            // 写入初始内容（旧数据 HTML → HTML2Md → Md2BlockDOM；新数据 Kramdown 直接渲染）
            // 2026-08-18：完整 Protyle 模式下 Md2BlockDOM 输出的 BlockDOM 会被 Protyle 正确
            // 解析为 NodeTable / NodeHeading / NodeList / NodeBlockquote 等块级结构，
            // WYSIWYG 完整保留表格/标题/列表/加粗/代码块等富文本样式。
            if (this.opts.initial) this.write(this.opts.initial);

            // 兜底：极少数情况下 Protyle 不会自动建块 → 等它初始化完成（两帧）仍为空才补一块，
            // 保证后续输入有落点。正常路径 Protyle 已建好空段落，这里不会执行。
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                if (this.disposed || !wysiwyg.isConnected) return;
                if (wysiwyg.childElementCount > 0) return;
                wysiwyg.innerHTML = PLACEHOLDER_BLOCK_HTML;
              });
            });

            // 2026-11-12（二次修复 · 用户实测首行空白仍在）：
            // 首行空白的两个来源都在这段里 ——
            //   ① lite Protyle 异步补建的默认空段落；
            //   ② 上面 rAF 兜底塞入的伪空段（Protyle 建块晚于两帧时，两者会并存）。
            // 二者都与真正的段落构成「[空段, 内容段]」，视觉上就是内容前多一行空白；
            // 上一版按「编辑态 + 500ms 窗口」清理，新建批注（以及更慢的 Protyle 初始化）
            // 都漏掉了，故改为通用规则：
            //   · 不分新建/编辑：首块无文字且无块引用、且后面还有其它块 → 删首块；
            //   · 由 MutationObserver 驱动（见 refreshEmpty），不依赖时间窗口，
            //     Protyle 多晚插入都能清掉；
            //   · 用户一旦开始键入（keydown/beforeinput）立即停止自动清理，
            //     避免误删用户自己敲出的空行。
            let autoTrim = true;
            const trimLeadingEmpty = () => {
              if (!autoTrim || this.disposed || !wysiwyg.isConnected) return;
              let guard = 0;
              while (wysiwyg.childElementCount > 1 && guard++ < 10) {
                const first = wysiwyg.firstElementChild as HTMLElement | null;
                if (!first) break;
                const hasText = !!((first.textContent) || "").trim();
                const hasRef = !!first.querySelector("[data-type='block-ref']");
                if (hasText || hasRef) break;
                first.remove();
              }
            };
            const stopAutoTrim = () => {
              // 先做最后一次清理再交接：用户开始键入时若首行还有残留空段，
              // 此刻内容块已存在（非空），这次清理能把它删掉；之后交还给用户。
              trimLeadingEmpty();
              autoTrim = false;
            };
            wysiwyg.addEventListener("keydown", stopAutoTrim, { once: true });
            wysiwyg.addEventListener("beforeinput", stopAutoTrim, { once: true });

            // 空态占位符切换
            const refreshEmpty = () => {
              // 先清前导空段再判空态：否则残留的伪空段会让「无内容」被误判为有内容
              trimLeadingEmpty();
              let hasContent = false;
              for (const child of Array.from(wysiwyg.children)) {
                const c = child as HTMLElement;
                // 2026-08-18 修复：占位段落也参与空态判断，用户在其中输入文字后
                // 应立即认为有内容，避免占位遮罩盖在文字上。
                if ((c.textContent || "").trim()) { hasContent = true; break; }
                if (c.querySelector("[data-type='block-ref']")) { hasContent = true; break; }
              }
              this.opts.onEmptyChange?.(!hasContent);
            };
            // 2026-11-03 泄漏清理：先记录元素引用再注册监听，
            // 否则 destroy() 若在此刻被调用，this.wysiwygEl 还没指向新元素 → 解绑不到。
            this.wysiwygEl = wysiwyg;
            wysiwyg.addEventListener("input", refreshEmpty);
            const obs = new MutationObserver(() => refreshEmpty());
            obs.observe(wysiwyg, { childList: true, subtree: true, characterData: true });
            this.emptyObserver = obs;
            this.inputHandler = refreshEmpty;
            refreshEmpty();
            p.focus();

            // ────────── 布局诊断（2026-11-12，默认关闭）──────────
            // 排查「批注框首行空白」时把 ANN_DEBUG_LAYOUT 置 true 即可全套启用。
            // 发布版保持 false：不打印、不挂 __annDump/__annWhy、不注册观察器。
            if (ANN_DEBUG_LAYOUT) console.log(
              "%c[REword-Ann] 布局诊断已开启：控制台若未自动输出，请在批注框可见时手动执行 __annDump()",
              "color:#fff;background:#7950f2;padding:2px 6px;border-radius:3px",
            );
            if (ANN_DEBUG_LAYOUT) {
              (window as any).__annDump = (label?: string) =>
                dumpAnnLayout(label || "手动 __annDump()", this.el, wysiwyg);
              // 追问「是谁在设 padding / display」：列出所有命中 wysiwyg 的相关规则（后者胜出）
              (window as any).__annWhy = () => {
                console.log("━━ [REword-Ann] wysiwyg 命中规则（按样式表顺序，靠后的赢；带 ! 的是 !important）━━");
                console.log(annWhyBox(wysiwyg).join("\n"));
                const cs = getComputedStyle(wysiwyg);
                console.log(`最终计算值: padding=${cs.padding} display=${cs.display}`);
              };
            }
            if (ANN_DEBUG_LAYOUT) {
              dumpAnnLayout("挂载即刻", this.el, wysiwyg);
              for (const ms of [80, 200, 500, 1000, 2000]) {
                setTimeout(() => {
                  if (!this.disposed) dumpAnnLayout(`挂载后 +${ms}ms`, this.el, wysiwyg);
                }, ms);
              }
              let dbgMut = 0;
              const dbgObs = new MutationObserver((records) => {
                dbgMut++;
                if (dbgMut > 6) { dbgObs.disconnect(); return; }
                // 记录这一批变动增删了什么：能看清 Protyle 是「在自己建段」还是「清掉我们的伪块」
                const deltas: string[] = [];
                const brief = (n: Node): string => {
                  const e = n as Element;
                  if (!e.tagName) return "#text";
                  const type = e.getAttribute?.("data-type");
                  const mark = e.hasAttribute?.("data-reword-placeholder") ? "(伪块)" : "";
                  return `${e.tagName.toLowerCase()}${type ? ":" + type : ""}${mark}`;
                };
                for (const r of records) {
                  if (r.addedNodes.length) deltas.push("+" + Array.from(r.addedNodes).map(brief).join(","));
                  if (r.removedNodes.length) deltas.push("-" + Array.from(r.removedNodes).map(brief).join(","));
                }
                dumpAnnLayout(`DOM 变化 #${dbgMut} ${deltas.join(" ")}`.trim(), this.el, wysiwyg);
              });
              dbgObs.observe(wysiwyg, { childList: true, subtree: true });
              setTimeout(() => dbgObs.disconnect(), 20000);
              wysiwyg.addEventListener("input", () => {
                dumpAnnLayout("首次输入即刻", this.el, wysiwyg);
                setTimeout(() => {
                  if (!this.disposed) dumpAnnLayout("首次输入 +300ms", this.el, wysiwyg);
                }, 300);
              }, { once: true });
            }
            // ────────── 诊断结束 ──────────
          }
        }
      } catch (e) {
        getLogger().error("[REword-Ann] Protyle 挂载失败，回退 contenteditable", { error: e });
        try { this.protyle?.destroy?.(); } catch (__swallowErr) { logSwallow(__swallowErr, "ann-editor.ts · refreshEmpty", "debug"); }
        this.protyle = null;
        this.fallback();
      }
    };
    requestAnimationFrame(attempt);
  }

  /** 原生浮动栏改按视口夹取（父容器太矮时默认口径会把它塞进卡片内） */
  private applyToolbarBoundary(): void {
    if (!this.opts.toolbarViewportBoundary) return;
    const toolbar = this.protyle?.protyle?.toolbar;
    for (const node of [toolbar?.element, toolbar?.subElement]) {
      try {
        (node as HTMLElement | null)?.setAttribute("data-position-boundary", "viewport");
      } catch (__swallowErr) {
        logSwallow(__swallowErr, "ann-editor.ts · applyToolbarBoundary", "debug");
      }
    }
  }

  /** 占位段落是否「无内容」：无文字且无块引用才算空（避免误删用户输入） */
  private isPlaceholderEmpty(n: Element): boolean {
    const hasText = !!((n.textContent) || "").trim();
    const hasRef = !!n.querySelector("[data-type='block-ref']");
    return !hasText && !hasRef;
  }

  /** 读取内容：Protyle 模式 → Kramdown；回退模式 → 白名单 HTML */
  read(): string {
    const p = this.protyle;
    if (p && p.protyle?.wysiwyg) {
      const wysiwyg = p.protyle.wysiwyg.element;
      const lute = p.protyle.lute;
      try {
        const clone = wysiwyg.cloneNode(true) as HTMLElement;
        // 2026-08-18 修复：仅删除「空」占位段落；若用户已输入文字/块引用则保留
        clone.querySelectorAll('[data-reword-placeholder="1"]').forEach((n) => {
          if (this.isPlaceholderEmpty(n)) n.remove();
        });
        const md = lute.BlockDOM2Md(clone.innerHTML).trim();
        // 2026-08-18：剥 IAL，防止块导出的 `{.: id="…" updated="…"}` 被存进 note
        if (md) return stripIal(md);
      } catch (e) {
        getLogger().warn("[REword-Ann] BlockDOM2Md 失败，回退 innerHTML", { error: e });
      }
      // 序列化失败/空：回退 HTML → Kramdown（保持 D9 单格式），无 Lute 时退化为 sanitize
      let html = wysiwyg.innerHTML?.trim() || "";
      if (html) {
        const tmp = wysiwyg.cloneNode(true) as HTMLElement;
        tmp.querySelectorAll('[data-reword-placeholder="1"]').forEach((n) => {
          if (this.isPlaceholderEmpty(n)) n.remove();
        });
        html = tmp.innerHTML.trim();
        if (html) return stripIal(htmlToKramdownOrSanitize(html));
      }
      return "";
    }
    // contenteditable 回退模式
    const raw = this.el.innerHTML?.trim() || "";
    if (!raw) return "";
    return stripIal(htmlToKramdownOrSanitize(raw.replace(/<br\s*\/?>$/i, "")));
  }

  /** 写入初始内容（编辑已有批注时调用） */
  write(note: string): void {
    const p = this.protyle;
    const wysiwyg = p?.protyle?.wysiwyg?.element as HTMLElement | null;
    if (!p || !wysiwyg || !note) return;
    const lute = p.protyle.lute;
    try {
      // 旧数据是 HTML（白名单标签）→ 先 HTML2Md 再渲染；新数据是 Kramdown 直接渲染
      const isHtml = /<[a-z][\s\S]*>/i.test(note);
      let md = isHtml ? lute.HTML2Md(note) : note;
      // 开启 GFM Table 等完整 Kramdown 能力，避免表格被当成普通文本
      configureKramdownLute(lute);
      // 表格块前后需空行分隔，否则 Lute Md2BlockDOM 可能把表格与相邻文本合并解析
      md = ensureBlockSeparators(md || "");
      wysiwyg.innerHTML = lute.Md2BlockDOM(md);
      if (!this.opts.readonly) this.focus();
    } catch (e) {
      getLogger().warn("[REword-Ann] 初始 note 写入失败", { error: e });
    }
  }

  /** 只读化：优先用官方 Protyle.disable()（= disabledProtyle），否则手动降级 */
  private applyReadonly(p: any, wysiwyg: HTMLElement): void {
    try {
      if (typeof p.disable === "function") { p.disable(); return; }
    } catch (e) {
      getLogger().warn("[REword-Ann] Protyle.disable 失败，手动只读降级", { error: e });
    }
    try {
      if (p.protyle) p.protyle.disabled = true;
      wysiwyg
        .querySelectorAll('[contenteditable="true"]')
        .forEach((n) => n.setAttribute("contenteditable", "false"));
    } catch (__swallowErr) { logSwallow(__swallowErr, "ann-editor.ts · applyReadonly", "debug"); }
  }

  /** 聚焦编辑器（Protyle 或回退 contenteditable） */
  focus(): void {
    try { this.protyle?.focus?.(); return; } catch (__swallowErr) { logSwallow(__swallowErr, "ann-editor.ts · focus", "debug"); }
    try { this.el.focus(); } catch (__swallowErr) { logSwallow(__swallowErr, "ann-editor.ts · focus", "debug"); }
  }

  /** 销毁（必须清理 MutationObserver 与内核监听，避免 detached 元素崩溃） */
  destroy(): void {
    this.disposed = true;
    try { this.emptyObserver?.disconnect(); } catch (__swallowErr) { logSwallow(__swallowErr, "ann-editor.ts · destroy", "debug"); }
    this.emptyObserver = null;
    // 移除挂载时注册的 input 监听，避免 detached 节点残留处理器（D6）
    if (this.inputHandler) {
      try { this.wysiwygEl?.removeEventListener("input", this.inputHandler); } catch (__swallowErr) { logSwallow(__swallowErr, "ann-editor.ts · destroy", "debug"); }
      this.inputHandler = null;
    }
    this.wysiwygEl = null;
    try { this.protyle?.destroy?.(); } catch (__swallowErr) { logSwallow(__swallowErr, "ann-editor.ts · destroy", "debug"); }
    try { this.el.querySelector(".protyle")?.remove(); } catch (__swallowErr) { logSwallow(__swallowErr, "ann-editor.ts · destroy", "debug"); }
    // 宿主状态清理（对称于 readonly/fallback 写入，D6）
    this.el.classList.remove("ann-editor--readonly");
    this.el.removeAttribute("contenteditable");
    this.teardownFallbackToolbar();
    this.protyle = null;
  }

  /** 回退 contenteditable 时，叠加轻量浮动样式栏（加粗/斜体/下划线/删除线/高亮） */
  private setupFallbackToolbar(): void {
    if (this.opts.readonly) return;            // 只读预览不挂（无编辑需求）
    if (this.fallbackToolbarEl) return;        // 幂等
    const host = this.el;
    const bar = document.createElement("div");
    bar.className = "ann-fallback-toolbar";
    bar.innerHTML = `<button type="button" data-cmd="bold" title="${t("加粗")}"><b>B</b></button>` +
      `<button type="button" data-cmd="italic" title="${t("斜体")}"><i>I</i></button>` +
      `<button type="button" data-cmd="underline" title="${t("下划线")}"><u>U</u></button>` +
      `<button type="button" data-cmd="strikeThrough" title="${t("删除线")}"><s>S</s></button>` +
      `<button type="button" data-cmd="hiliteColor" title="${t("高亮")}">▣</button>`;
    // mousedown 阻止默认，避免点击按钮时 contenteditable 失焦导致选区丢失
    bar.addEventListener("mousedown", (e) => e.preventDefault());
    bar.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        const cmd = btn.dataset.cmd;
        if (!cmd) return;
        if (cmd === "hiliteColor") document.execCommand("hiliteColor", false, "#ffe58f");
        else document.execCommand(cmd, false);
        this.positionFallbackToolbar(bar, host);
      });
    });
    host.appendChild(bar);
    this.fallbackToolbarEl = bar;
    const onSel = () => this.positionFallbackToolbar(bar, host);
    document.addEventListener("selectionchange", onSel);
    this.fallbackSelHandler = onSel;
  }

  /** 选区变化时定位浮动栏（选区在 host 内且非空才显示） */
  private positionFallbackToolbar(bar: HTMLElement, host: HTMLElement): void {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) { bar.style.display = "none"; return; }
    const range = sel.getRangeAt(0);
    if (!host.contains(range.commonAncestorContainer)) { bar.style.display = "none"; return; }
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) { bar.style.display = "none"; return; }
    bar.style.display = "flex";
    const top = rect.top - bar.offsetHeight - 6 + window.scrollY;
    const left = rect.left + rect.width / 2 - bar.offsetWidth / 2 + window.scrollX;
    bar.style.top = `${Math.max(4, top)}px`;
    bar.style.left = `${Math.max(4, left)}px`;
  }

  /** 销毁时移除回退浮动栏与选区监听 */
  private teardownFallbackToolbar(): void {
    if (this.fallbackSelHandler) {
      document.removeEventListener("selectionchange", this.fallbackSelHandler);
      this.fallbackSelHandler = null;
    }
    this.fallbackToolbarEl?.remove();
    this.fallbackToolbarEl = null;
  }

  /** 回退模式：contenteditable（保持旧版输入能力） */
  private fallback(): void {
    // 只读预览的回退：不写内容、不设 contenteditable，清空宿主交回静态兜底（由调用方显示）
    if (this.opts.readonly) {
      try { this.el.querySelector(".protyle")?.remove(); } catch (__swallowErr) { logSwallow(__swallowErr, "ann-editor.ts · fallback", "debug"); }
      this.el.innerHTML = "";
      this.opts.onReady?.(false);
      return;
    }
    if (this.opts.fallback === false) return;
    try { this.el.querySelector(".protyle")?.remove(); } catch (__swallowErr) { logSwallow(__swallowErr, "ann-editor.ts · fallback", "debug"); }
    this.el.setAttribute("contenteditable", "true");
    const init = this.opts.initial || "";
    if (init) {
      // 旧数据 HTML → 白名单清洗后直接显示；纯文本/Kramdown → 转义显示
      this.el.innerHTML = /<[a-z][\s\S]*>/i.test(init) ? sanitizeHtml(init) : this.escapeHtml(init);
    }
    // 回退兜底：contenteditable 无原生浮动栏 → 叠加轻量样式栏（选中即显示）
    this.setupFallbackToolbar();
    this.focus();
  }

  private escapeHtml(s: string): string {
    return (s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
}

/** read 回退分支：HTML → Kramdown（D9 单格式），无 Lute 时退化为 sanitize */
function htmlToKramdownOrSanitize(html: string): string {
  const md = htmlToMd(html);
  return md && md !== html ? md : sanitizeHtml(html);
}

/**
 * 便捷入口：创建并挂载内联编辑器（弹窗与汇总面板编辑态共用）。
 * @param el 目标容器（需为空 div，高度由 CSS 保证）
 * @param opts 配置
 */
export function mountAnnEditor(el: HTMLElement, opts: AnnEditorOptions): AnnEditor {
  const editor = new AnnEditor(el, opts);
  editor.mount();
  return editor;
}
