import { logSwallow } from "../core/safe.ts";
/**
 * 阅读器 - 分类字体的 DOM 侧处理（2026-08-28 新增，参考 Readest utils/style.ts）
 * ------------------------------------------------------------------------------
 *
 * **为什么需要这个模块（纯 CSS 做不到的事）**
 *
 * EPUB 作者样式表里大量使用通用字体族关键词：
 *   body { font-family: Georgia, serif }
 *   code { font-family: monospace }
 *   h1   { font-family: serif }
 *
 * 这些声明位于**作者样式表**，我们的阅读器样式是**用户样式表**。
 * 用户样式表的 !important 确实能压过它们——但**仅限于我们显式声明了 font-family 的元素**。
 * 我们只声明了 body / pre / code 等少数选择器，于是出现割裂：
 *   - 标题 h1-h6 走书籍的 serif（不是用户选的衬线字体）
 *   - 各类 class 段落走书籍的 sans-serif（不是用户选的无衬线字体）
 * 结果是「分类字体只在部分元素生效」，体验不完整。
 *
 * **Readest 的同款解法**：加载完成后遍历内容文档的 CSSOM，把通用族关键词
 * 替换成对应的 CSS 变量引用。变量由 reader-style.ts 的 fontVariableStyles()
 * 定义在 `:root`（foliate 内容文档的 <html>）上，因此 var() 必然可解析。
 *
 * 替换规则：
 *   serif        → var(--reword-serif, serif)
 *   sans-serif   → var(--reword-sans-serif, sans-serif)
 *   monospace    → var(--reword-monospace, monospace)
 * 注意保留原声明的其它字体名（`Georgia, serif` → `Georgia, var(--reword-serif, serif)`），
 * 这样书籍自带的西文字体优先级仍在，只有「兜底族」被我们接管——最小侵入。
 *
 * **项目铁律遵守**：本模块只读写**运行时 CSSOM**，不修改 EPUB 文件、不写回磁盘、
 * 不修改元素的 style 属性。CSSOM 改动随 foliate 重建文档自然消失，卸载零残留。
 *
 * 全部逻辑 try-catch 包裹：任何 CSSOM 访问异常（跨域样式表）都静默跳过，
 * 最坏情况退化为「分类字体部分生效」，不会崩溃、不会白屏。
 */

/** 通用字体族关键词 → CSS 变量引用（带同名兜底，变量缺失时退化为原生行为） */
const KEYWORD_TO_VAR: Record<string, string> = {
  serif: "var(--reword-serif, serif)",
  "sans-serif": "var(--reword-sans-serif, sans-serif)",
  monospace: "var(--reword-monospace, monospace)",
  // cursive / fantasy 无对应链，映射到衬线（比系统默认更可控）
  cursive: "var(--reword-serif, cursive)",
  fantasy: "var(--reword-serif, fantasy)",
};

/**
 * 把 `font-family` 值里的通用族关键词替换为 CSS 变量引用。
 *
 * @example
 *   transformFontFamilyValue('Georgia, serif')      → 'Georgia, var(--reword-serif, serif)'
 *   transformFontFamilyValue('"Courier New",monospace') → '"Courier New", var(--reword-monospace, monospace)'
 *   transformFontFamilyValue('MyBookFont')          → 'MyBookFont'（未命中，原样返回）
 */
export function transformFontFamilyValue(value: string): string {
  if (!value) return value;
  return value
    .split(",")
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return trimmed;
      // 去引号后比较（CSS 允许 serif 不带引号，也允许 "serif"）
      const bare = trimmed.replace(/^["']+|["']+$/g, "").toLowerCase();
      const replacement = KEYWORD_TO_VAR[bare];
      return replacement || trimmed;
    })
    .join(", ");
}

/**
 * 单条声明重写：把 style.fontFamily 中的关键词换成变量。
 * @returns 是否发生了修改
 */
function rewriteDeclaration(style: CSSStyleDeclaration): boolean {
  let raw = "";
  try {
    raw = style.getPropertyValue("font-family");
  } catch {
    return false;
  }
  if (!raw) return false;

  const next = transformFontFamilyValue(raw);
  if (next === raw) return false;

  try {
    // 保留 original 的 !important 优先级，避免削弱书籍的强制声明
    const priority = style.getPropertyPriority("font-family");
    style.setProperty("font-family", next, priority);
    return true;
  } catch {
    return false;
  }
}

/* ================= 2026-11-01 字重重写（对标 Readest transformStylesheet） ================= */

/**
 * 是否是 `@font-face` 规则。
 *
 * ⚠️ 必须跳过：`@font-face` 里的 `font-weight` 是**描述符**（声明这个 face 覆盖哪些字重），
 * 不是「用法」。CSS 描述符里不允许出现 var() ⇒ 一旦被改写成 var(...)，整条 @font-face
 * 规则会被引擎丢弃，书籍内嵌字体就此脱钩（Readest readest#6047 同类事故）。
 */
/** CSS 规范里 CSSRule.FONT_FACE_RULE 的固定值（各浏览器一致） */
const FONT_FACE_RULE_TYPE = 5;

function isFontFaceRule(rule: CSSRule): boolean {
  try {
    const t = (CSSRule as unknown as { FONT_FACE_RULE?: number })?.FONT_FACE_RULE;
    if (typeof t === "number" && rule.type === t) return true;
  } catch {
    /* 无全局 CSSRule（如 Node 测试环境）→ 走下面的兜底 */
  }
  // 兜底 ①：规范固定值 5（CSSRule.FONT_FACE_RULE）
  try {
    if (rule.type === FONT_FACE_RULE_TYPE) return true;
  } catch {
    /* ignore */
  }
  // 兜底 ②：构造器名（个别环境里 type 不可读时）
  try {
    return (rule as any)?.constructor?.name === "CSSFontFaceRule";
  } catch {
    return false;
  }
}

/**
 * 单条声明重写：把 `font-weight: normal` 换成 `var(--reword-font-weight, normal)`。
 *
 * ## 为什么只改 normal
 * 书籍写死的 `bold / 700` 是**标题层级的语义**（书名、章名、强调），
 * 不该被用户的字重滑块抹平；只有 `normal`（作者的「常规字重」）才是
 * 「我想让这一段是常规字重」的声明，理应跟随用户设置。
 *
 * ## 为什么带兜底值
 * `var(--reword-font-weight, normal)` 的兜底不可省：变量缺失时整条声明在
 * 计算值阶段失效 → font-weight 回落成继承值 → 书籍的粗体标题会被抹平。
 * 兜底写成 normal（= 400），缺变量时与改写前完全等价。
 *
 * ## 为什么要避开 font 简写
 * 规则里若写了 `font: ...` 简写（CSSOM 会把它展开成各长属性），
 * 改写 font-weight 会让简写变成 `font: var(...) ...` —— 遇到 `font: menu`
 * 这类系统字体关键字时，替换后的简写**整体非法**，整条声明失效，
 * 字族/字号一起丢失 ⇒ 命中简写的规则一律跳过（宁可不改，也别改坏）。
 *
 * @returns 是否发生了修改
 */
function rewriteFontWeightDeclaration(style: CSSStyleDeclaration): boolean {
  let raw = "";
  try {
    raw = style.getPropertyValue("font-weight");
  } catch {
    return false;
  }
  if (!raw || raw.trim().toLowerCase() !== "normal") return false;

  // 规则里含 font 简写 → 跳过（见上方注释）
  try {
    if (/(^|;)\s*font\s*:/i.test(style.cssText)) return false;
  } catch {
    return false;
  }

  try {
    const priority = style.getPropertyPriority("font-weight");
    style.setProperty("font-weight", "var(--reword-font-weight, normal)", priority);
    return true;
  } catch {
    return false;
  }
}

/** 递归遍历规则集（含 @media / @supports 等分组规则内的嵌套规则） */
function walkRules(
  rules: CSSRuleList | undefined,
  handler: (style: CSSStyleDeclaration, rule: CSSRule) => boolean
): number {
  if (!rules) return 0;
  let n = 0;
  for (let i = 0; i < rules.length; i++) {
    let rule: CSSRule;
    try {
      rule = rules[i];
    } catch {
      continue; // 单条访问失败（跨域）跳过
    }
    try {
      // CSSStyleRule 有 .style；CSSFontFaceRule 也有（font-family 是字体名，不会命中关键词）
      const styleRule = rule as CSSStyleRule;
      if (styleRule.style && !isFontFaceRule(rule)) {
        if (handler(styleRule.style, rule)) n++;
      }
      // @media / @supports / @layer 等分组规则
      const grouped = rule as CSSGroupingRule;
      if (grouped && grouped.cssRules && grouped.cssRules.length) {
        n += walkRules(grouped.cssRules, handler);
      }
    } catch (__swallowErr) { logSwallow(__swallowErr, "reader-font-classify.ts · walkRules", "debug"); }
  }
  return n;
}

/**
 * 遍历内容文档里**全部可访问的样式表**（文档样式表 + adoptedStyleSheets），
 * 对每条规则套用 handler。
 *
 * @param doc foliate 内容文档
 * @param handler 对每条规则的 style 做改写，返回 true 表示改动了
 * @returns 被修改的规则条数
 */
function walkDocumentSheets(
  doc: Document,
  handler: (style: CSSStyleDeclaration, rule: CSSRule) => boolean
): number {
  let n = 0;

  // 1) 文档样式表（含 <style> 与同源 <link>）
  try {
    const sheets = doc.styleSheets;
    for (let i = 0; i < sheets.length; i++) {
      let sheet: CSSStyleSheet;
      try {
        sheet = sheets[i];
      } catch {
        continue; // 索引访问抛错（跨域）
      }
      let rules: CSSRuleList | undefined;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // 跨域样式表读不到 cssRules（EPUB 内联资源一般同源，此分支少见）
      }
      n += walkRules(rules, handler);
    }
  } catch (__swallowErr) { logSwallow(__swallowErr, "reader-font-classify.ts · walkDocumentSheets", "debug"); }

  // 2) adoptedStyleSheets（现代 foliate 可能用 constructable stylesheets）
  try {
    const adopted = (doc as any).adoptedStyleSheets as CSSStyleSheet[] | undefined;
    if (Array.isArray(adopted)) {
      for (const sheet of adopted) {
        let rules: CSSRuleList | undefined;
        try {
          rules = sheet.cssRules;
        } catch {
          continue;
        }
        n += walkRules(rules, handler);
      }
    }
  } catch (__swallowErr) { logSwallow(__swallowErr, "reader-font-classify.ts · adoptedStyleSheets", "debug"); }

  return n;
}

/**
 * 重写单个内容文档的字体族关键词。
 *
 * @param doc foliate 内容文档（来自 view.renderer.getContents()[i].doc）
 * @returns 被修改的规则条数（0 表示书籍未使用通用族关键词，或样式表不可访问）
 */
export function rewriteFontKeywordsInDocument(doc: Document): number {
  if (!doc) return 0;
  return walkDocumentSheets(doc, (style) => rewriteDeclaration(style));
}

/**
 * 重写单个内容文档里的 `font-weight: normal` → `var(--reword-font-weight, normal)`。
 *
 * 让用户的「字重」设置真正贯穿全书 —— 此前它只作用在 body 上，而书籍段落自身
 * 声明的 `font-weight: normal` 会赢过继承值（继承值永远输给元素自身的声明），
 * 于是字重滑块对那些段落完全无效。
 *
 * @param doc foliate 内容文档
 * @returns 被修改的规则条数
 */
export function rewriteFontWeightInDocument(doc: Document): number {
  if (!doc) return 0;
  return walkDocumentSheets(doc, (style) => rewriteFontWeightDeclaration(style));
}

/**
 * 对 foliate 当前所有已挂载内容文档执行关键词重写。
 *
 * @param getContents foliate 的 view.renderer.getContents()，
 *        返回 [{ index, overlayer, doc }, ...]（**Document 在 .doc 字段**，项目铁律）
 * @returns 被修改的规则总条数
 */
export function rewriteFontKeywordsInAllContents(
  getContents: () => any[] | undefined | null
): number {
  let list: any[] = [];
  try {
    list = getContents?.() || [];
  } catch {
    return 0;
  }
  let n = 0;
  for (const c of list) {
    const doc = (c as any)?.doc as Document | undefined;
    if (!doc) continue; // 项目铁律：必须解 .doc，直接把 c 当 Document 会抛 TypeError
    try {
      n += rewriteFontKeywordsInDocument(doc);
    } catch (__swallowErr) { logSwallow(__swallowErr, "reader-font-classify.ts · getContents", "debug"); }
  }
  return n;
}
