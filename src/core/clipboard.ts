/**
 * 剪贴板：跨上下文安全带（2026-11-19 · 移动端 P1）
 * ==================================================================
 * ## 为什么需要
 *
 * `navigator.clipboard` 只在**安全上下文**（https / localhost）存在。
 * 手机连电脑上的思源，访问的是 `http://192.168.x.x:6806` —— **非安全上下文**
 * ⇒ `navigator.clipboard` 是 `undefined`。
 *
 * 全项目 29 处调用，几乎都写成 `navigator.clipboard?.writeText(x)`：
 * 可选链在 `clipboard` 为 undefined 时**静默短路**——不报错、不写盘，
 * 而界面照样弹「已复制」⇒ 用户以为复制成功，粘贴出来是空的。
 * （`AiMindmap.svelte` 曾经单独加过 `execCommand` 降级，属于「只修一处」，
 *   本轮把它收敛成全局能力。）
 *
 * ## 两条入口
 *
 *  1. `installClipboardFallback()` —— **一次性补丁**，给 `navigator.clipboard`
 *     装一个 `writeText` 降级实现。29 处旧调用**一行都不用改**就有兜底：
 *     `navigator.clipboard?.writeText(...)` 从「静默短路」变成「真的写进去」。
 *     只在缺失时装；已有原生实现时绝不覆盖（原生异步写不会抢焦点）。
 *  2. `copyText(text)` —— 给**新代码**用的统一入口：原生优先、失败降级，
 *     返回 boolean 让调用方能如实提示成败（而不是假成功）。
 *
 * ## 降级手段为什么是 execCommand
 *
 * `document.execCommand("copy")` 是唯一在非安全上下文可用的同步复制通道
 * （Chrome / Safari / WebView 全支持）。限制是必须由**用户手势**触发，
 * 而这些调用都发生在点击回调里 ⇒ 成立。
 * 它需要一个「真实选区」，所以用一个屏幕外 textarea 承载文本；
 * 复制完必须把**宿主文档的选区与焦点还回去**，否则用户刚选中的文字会被清掉、
 * 输入框会失焦（手机上表现为键盘收起）。
 */

/** 标记：本实现是降级垫片（copyText 靠它避免自己调自己） */
const FALLBACK_FLAG = "__reClipboardFallback";

/** 取 navigator（方法内现取：node 单测可以先装假对象再 import） */
function nav(): any {
  try {
    return typeof navigator !== "undefined" ? navigator : null;
  } catch {
    return null;
  }
}

/**
 * 降级复制：屏幕外 textarea + `execCommand("copy")`。
 *
 * 成功 resolve、失败 reject（调用方据此给用户真实反馈）。
 */
export function legacyCopyText(text: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    try {
      const doc: Document | undefined = typeof document !== "undefined" ? document : undefined;
      if (!doc?.body || typeof doc.execCommand !== "function") {
        reject(new Error("execCommand unavailable"));
        return;
      }
      const value = String(text ?? "");
      // 先记下宿主文档的选区与焦点，复制完原样还回去
      const sel = doc.getSelection?.() ?? null;
      const ranges: Range[] = [];
      if (sel) {
        for (let i = 0; i < sel.rangeCount; i++) {
          try { ranges.push(sel.getRangeAt(i)); } catch { /* 跨文档选区：跳过 */ }
        }
      }
      const active = (doc.activeElement as HTMLElement | null) ?? null;

      const ta = doc.createElement("textarea");
      ta.value = value;
      ta.setAttribute("readonly", "");
      ta.setAttribute("aria-hidden", "true");
      // 不能用 display:none / visibility:hidden —— 那样无法 select()
      ta.style.cssText =
        "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;pointer-events:none;z-index:-1;";
      doc.body.appendChild(ta);
      ta.focus({ preventScroll: true });
      ta.select();
      try { ta.setSelectionRange(0, value.length); } catch { /* 老 WebView 可能不支持 */ }

      const ok = doc.execCommand("copy");
      ta.remove();

      // 还原选区与焦点（顺序：先选区、后焦点，避免 focus 清掉选区）
      if (sel && ranges.length) {
        try {
          sel.removeAllRanges();
          for (const r of ranges) sel.addRange(r);
        } catch { /* 选区已失效：忽略 */ }
      }
      if (active && active !== doc.body && typeof active.focus === "function") {
        try { active.focus({ preventScroll: true }); } catch { /* 元素已卸载 */ }
      }

      ok ? resolve() : reject(new Error("execCommand('copy') returned false"));
    } catch (e) {
      reject(e as Error);
    }
  });
}

/**
 * 统一复制入口（新代码用这个）。
 *
 * 原生 `navigator.clipboard.writeText` 优先；缺失或抛错（权限被拒 /
 * 非安全上下文 / iframe 未授权）时降级到 `execCommand`。
 *
 * @returns 是否真的复制成功 —— 调用方据此决定弹「已复制」还是「复制失败」
 */
export async function copyText(text: string): Promise<boolean> {
  const value = String(text ?? "");
  if (!value) return false;
  const clip = nav()?.clipboard;
  if (clip?.writeText && !clip[FALLBACK_FLAG]) {
    try {
      await clip.writeText(value);
      return true;
    } catch {
      // 落到降级通道（异步剪贴板要用户手势 + 权限，失败很常见）
    }
  }
  try {
    await legacyCopyText(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * 给 `navigator.clipboard` 装降级垫片（幂等）。
 *
 * 只补 `writeText` / `readText` 两个最常用成员；`write()`（图片）需要
 * `ClipboardItem`，在非安全上下文根本不存在，无法用 execCommand 等价实现，
 * 因此不补（图片复制在手机上仍走「下载」路径更靠谱）。
 */
export function installClipboardFallback(): void {
  const n = nav();
  if (!n) return;
  const clip = n.clipboard;
  if (clip?.writeText) return; // 安全上下文：原生可用，一律不动

  const shim: any = clip && typeof clip === "object" ? clip : {};
  if (typeof shim.writeText !== "function") {
    shim.writeText = (t: string) => legacyCopyText(String(t ?? ""));
  }
  shim[FALLBACK_FLAG] = true;
  try {
    // navigator.clipboard 在非安全上下文是**未定义**的（属性本身可能不存在），
    // 直接 defineProperty 造一个自有属性最稳；已有对象时只补方法。
    Object.defineProperty(n, "clipboard", { value: shim, configurable: true, writable: true });
  } catch {
    try { (n as any).clipboard = shim; } catch { /* 只读环境：放弃（copyText 仍可用） */ }
  }
}
