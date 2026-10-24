/**
 * Node 内置模块惰性转发工厂（2026-10-24 移动端加载修复）
 * ==================================================================
 * 背景：本插件此前把 node:fs / path / zlib / os / assert 全部 vite external，
 * 产物 index.js 顶层出现 `require("node:fs")` 等求值即执行的调用。
 * 桌面端 Electron 有 Node 运行时，没问题；**移动端是 WebView（无 Node）**，
 * 整个 index.js 一求值就抛 "Cannot find module 'fs'" → 插件类注册不上
 * → 顶栏图标 / 页签 / "进入"按钮全不出现（手机端"插件没图标"的根因）。
 *
 * 方案：内置模块经 vite alias 指到 shims/ 下的惰性转发模块——
 * 模块求值阶段零 require；首次调用成员时才经宿主 require 解析：
 *   · 桌面端（Electron / SiYuan wrapper 的 require）→ 真实实现，行为不变；
 *   · 移动端 → require 不存在或抛错，读操作返回安全空值（existsSync=false、
 *     readFileSync=""…）、写操作静默 no-op：词典显示 MISSING、日志不落盘，
 *     插件本体正常加载运行。调用方原有的 `if (!fs.existsSync(p)) return;`
 *     守卫与 try/catch 自然接住，不需要任何业务代码改动。
 */

/** 每模块只告警一次，避免移动端刷屏 */
const warned = new Set<string>();
function warnOnce(mod: string): void {
  if (warned.has(mod)) return;
  warned.add(mod);
  try {
    console.warn(`[RE 阅读器] 当前环境无 Node 运行时（移动端），${mod} 相关文件功能已降级`);
  } catch {
    /* ignore */
  }
}

/**
 * 经宿主 require 解析真实模块。
 * ⚠️ 这里的 `require` 是**自由变量**：rollup CJS 产物在宿主（SiYuan 桌面端）
 * 提供的 require 作用域里求值 → 桌面端解析到真实 Node 模块；
 * 移动端 WebView 没有该符号 → 抛 ReferenceError → 捕获返回 null。
 * 刻意不写成顶层 import —— 那会回到"求值即 require"的老问题。
 */
function requireNode(mod: string): any {
  try {
    return (require as (id: string) => any)(mod);
  } catch {
    return null;
  }
}

/**
 * 成员函数转发。
 * @param safeReturn 移动端无真实实现时的安全返回值工厂
 *   （读操作给"空"，让 `existsSync → false` 之类的守卫自然降级；
 *     写操作不给 safeReturn → 返回 undefined，静默 no-op）
 */
export function nodeFn(mod: string, name: string, safeReturn?: (...args: any[]) => unknown): any {
  return (...args: any[]) => {
    const m = requireNode(mod);
    const f = m && typeof m[name] === "function" ? m[name] : null;
    if (f) return f.apply(m, args);
    warnOnce(mod);
    return safeReturn ? safeReturn(...args) : undefined;
  };
}

/**
 * 整模块代理（fs.promises / assert 的直调形态 / 未知成员兜底）：
 * 桌面端逐成员转发真实实现；移动端属性取值与调用都降级为 no-op。
 */
export function nodeObj(mod: string): any {
  return new Proxy(function noop() {}, {
    get(_t, prop: string | symbol) {
      const m = requireNode(mod);
      if (m && m[prop as any] != null) {
        const v = m[prop as any];
        return typeof v === "function" ? v.bind(m) : v;
      }
      warnOnce(mod);
      return (..._a: any[]) => undefined;
    },
    apply(_t, _this, args) {
      const m = requireNode(mod);
      if (typeof m === "function") return m(...args);
      warnOnce(mod);
      return undefined;
    },
  });
}
