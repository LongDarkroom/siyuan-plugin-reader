/**
 * 【临时诊断模块 · 验完即删】iPad 环境探测
 * ------------------------------------------------------------------
 * 用途：在 iPad 思源 App 里执行「RE 阅读器：环境诊断」命令，弹窗显示
 * getFrontend()/getBackend()/UA/触摸点/屏幕尺寸等原始信号，以及 reader
 * 自己的 isMobile()/getDeviceClass() 判定结果。用来坐实「iPad 上
 * getFrontend() 到底返回什么」这个决定性前提。
 *
 * 不改任何正常启动逻辑；验完把本文件与 index.ts 的 diag 命令一起删掉。
 */
import { Dialog, getBackend } from "siyuan";
import { currentFrontend, isMobile, isTouchDevice, getDeviceClass, isIOS, isAndroid } from "./env.ts";
import { layoutWidth, layoutHeight, visualWidth, visualHeight, viewportWidth } from "./responsive.ts";

function safe(fn: () => unknown): string {
  try {
    const v = fn();
    return typeof v === "string" ? v : String(v);
  } catch (e) {
    return "<调用异常: " + (e instanceof Error ? e.message : String(e)) + ">";
  }
}

function collect(): Record<string, string> {
  const nav = window.navigator as any;
  const ua = safe(() => navigator.userAgent);
  return {
    "getFrontend()": safe(() => currentFrontend()),
    "getBackend()": safe(() => getBackend()),
    "isMobile()（reader判定）": safe(() => isMobile()),
    "getDeviceClass()": safe(() => getDeviceClass()),
    "isTouchDevice()": safe(() => isTouchDevice()),
    "isIOS()": safe(() => isIOS()),
    "isAndroid()": safe(() => isAndroid()),
    "platform": safe(() => navigator.platform),
    "maxTouchPoints": safe(() => String(nav.maxTouchPoints ?? "undefined")),
    "ontouchstart in window": safe(() => String("ontouchstart" in window)),
    "innerWidth × innerHeight": safe(() => `${window.innerWidth} × ${window.innerHeight}`),
    "layoutWidth × layoutHeight": safe(() => `${layoutWidth()} × ${layoutHeight()}`),
    "visualWidth × visualHeight": safe(() => `${visualWidth()} × ${visualHeight()}`),
    "viewportWidth()": safe(() => String(viewportWidth())),
    "screen.width × height": safe(() => `${screen.width} × ${screen.height}`),
    "document.body.classList": safe(() => document.body.className || "(空)"),
    "location.href": safe(() => location.href),
    "UA": ua,
  };
}

/** 打开环境诊断弹窗 */
export function openDiag(): void {
  const rows = collect();
  const lines = Object.entries(rows).map(([k, v]) => `${k}\n  ${v}`);
  const text = lines.join("\n\n");
  const dialog = new Dialog({
    title: "RE 阅读器 · 环境诊断（iPad）",
    content: `
      <div style="padding:12px;font-family:var(--font-mono);font-size:12px;line-height:1.6">
        <div style="margin-bottom:12px;font-family:var(--font-sans);font-size:13px">
          请把下面全部内容截图发我（或长按选中复制）：
        </div>
        <pre id="re-diag-out" style="white-space:pre-wrap;word-break:break-all;user-select:text;-webkit-user-select:text;background:var(--color-background-secondary);padding:12px;border-radius:8px;border:0.5px solid var(--color-border-tertiary)">${escapeHtml(text)}</pre>
      </div>`,
    width: "640px",
  });
  // 复制到剪贴板按钮，方便直接粘贴文本
  try {
    const bar = dialog.element.querySelector(".b3-dialog__action");
    if (bar) {
      const btn = document.createElement("button");
      btn.className = "b3-button b3-button--outline";
      btn.textContent = "复制诊断信息";
      btn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(text);
          btn.textContent = "已复制";
        } catch {
          btn.textContent = "复制失败，请截图";
        }
      });
      bar.prepend(btn);
    }
  } catch {
    /* 没有 action 栏就算了，截图同样可用 */
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
