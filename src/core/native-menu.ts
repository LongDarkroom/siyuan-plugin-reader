/**
 * 移动端「浏览器原生菜单」压制（2026-10-26）
 * ==================================================================
 * ## 这模块解决什么
 *
 * 真机截图实证：手机长按选词后，**浏览器原生浮选菜单**（Chrome Android 的
 * 「询问Copilot / 大声朗读 / 复制 / 全选」）压在插件自己的划词工具栏上，
 * 两层叠在一起（用户原话：「手机自带工具栏与我自己功能栏杂合在一起了」）。
 * 原生菜单属于浏览器 UI 层，**z-index / CSS 盖不住**，唯一的办法是**不让它出现**。
 *
 * ## 为什么不做成「不弹自己的工具栏」
 *
 * 插件自己的划词工具栏承载高亮 / 批注 / 复制 / 翻译等全部功能，且已实现
 * 选区手柄（selHandles），是完整的划词交互；退让它等于砍功能。
 * 对标「思阅」（SiReader v2.5.7）的做法就是压制原生菜单、保留自有工具栏。
 *
 * ## 两条压制手段（各管一个平台，缺一不可）
 *
 *  1. **contextmenu → preventDefault**（管 Chrome Android / 桌面触屏）
 *     长按选中文字时浏览器会派发可取消的 `contextmenu` 事件；取消掉它，
 *     原生浮选菜单就不会弹出。对标思阅 index.js 的
 *     `r.addEventListener("contextmenu", u => u.preventDefault())`。
 *
 *  2. **-webkit-touch-callout: none**（管 iOS Safari / WKWebView）
 *     iOS 的长按「复制 / 查找 / 共享」是**系统 callout 菜单**，
 *     **不派发 DOM contextmenu 事件**，只能靠 CSS 属性关掉。
 *     `-webkit-touch-callout` 是**继承属性**，设在内容文档的 html 上即对全文生效
 *     （思阅用的是 `html{-webkit-touch-callout:none!important;}`）。
 *
 * ## 为什么门控只看「移动端」
 *
 * 桌面端右键菜单有实际用途（复制粘贴 / PDF 标注右键菜单 / 链接右键），
 * 桌面触屏笔记本也不该被误伤 ⇒ 门控用 `isMobile()`（思源 App / 移动浏览器），
 * **不是** `isTouchDevice()`（后者在带触摸屏的桌面机也为真）。
 *
 * ## 为什么不影响 PDF 矩形标注菜单
 *
 * PdfTextHlLayer 的矩形标注右键菜单是**插件自己弹的 JS 菜单**，
 * 与浏览器默认菜单无关：`preventDefault()` 只取消「浏览器默认行为」，
 * **不会**阻止同文档上其它 listener 继续执行 ⇒ PDF 标注菜单照常可用。
 * （PDF 路径不需要任何改动。）
 */

export interface NativeMenuGuardOptions {
  /** 是否移动端前端（思源 App / 移动浏览器）。桌面端一律不压制。 */
  mobile: boolean;
}

/**
 * 是否应压制浏览器原生 contextmenu 菜单。
 * 只看移动端前端：桌面（含触屏笔记本）保留右键菜单。
 */
export function shouldSuppressNativeMenu(opts: NativeMenuGuardOptions): boolean {
  return !!opts?.mobile;
}

/**
 * contextmenu 压制处理器：取消浏览器默认行为（= 不弹原生菜单）。
 *
 * 刻意**不** stopPropagation / stopImmediatePropagation：
 * 同文档上别的 listener（如 PDF 矩形标注菜单）仍要继续跑。
 */
export function nativeMenuGuardHandler(e: Event): void {
  try {
    e?.preventDefault?.();
  } catch {
    /* 事件对象异常时静默：压制失败也不能影响阅读 */
  }
}

/**
 * iOS 长按 callout 菜单压制：给内容文档的 html 加 `-webkit-touch-callout:none`。
 *
 * 该属性是**继承属性**，设在 documentElement 上即对整篇正文生效；
 * 用 `!important` 是为了压过 EPUB 自带样式表里可能存在的 callout 设置。
 * 非 iOS 平台不识别该属性 ⇒ 无副作用。
 */
export function applyTouchCalloutNone(doc: Document | null | undefined): void {
  try {
    const de = doc?.documentElement;
    if (!de?.style?.setProperty) return;
    de.style.setProperty("-webkit-touch-callout", "none", "important");
  } catch {
    /* 内容文档可能正在销毁：忽略 */
  }
}
