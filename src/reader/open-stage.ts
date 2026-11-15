/**
 * 开书阶段 → 用户能看懂的一句话
 * ------------------------------------------------------------------
 * 背景（2026-11-15 真机反馈「移动端打开书籍有点慢」）：
 *
 * 开书链路上本来就有 `markStage()` 打点（取文件 → 解析 → 首屏 → 目录 → 排版），
 * 但那些字符串只进日志，界面上**什么都不显示** —— 用户点开一本 27 MB 的 EPUB，
 * 看到的是纯白屏，几秒内没有任何反馈，体感上会被放大成「卡死了」。
 *
 * 本模块只做一件事：把内部阶段字符串映射成一句人话，供加载态直接显示。
 * 刻意做成纯函数、不 import 任何业务模块，便于 Node strip-only 直接单测。
 */

/** 阶段 → i18n key（中文原文即 key，调用方再交给 t()） */
export function openStageLabel(stage: string): string {
  const s = String(stage || "");
  if (!s) return "正在打开…";
  if (s.includes("取书籍文件")) return "正在读取书籍文件…";
  if (s.includes("view.open")) return "正在解析书籍…";
  if (s.includes("view.init")) return "正在排版首屏…";
  if (s.includes("构建目录")) return "正在整理目录…";
  if (s.includes("应用样式") || s.includes("排版")) return "正在应用排版…";
  if (s.includes("附加内容")) return "正在准备批注与译文…";
  return "正在打开…";
}

/**
 * 是否需要提示「大书要等一会儿」。
 *
 * 书架里 10 MB 以上的书很常见（实测最大 176 MB PDF / 148 MB AZW3），
 * 这类文件在手机上首次打开注定要几秒；与其让用户以为坏了，不如提前说清楚。
 * 阈值取 8 MB：低于它基本 1 秒内完成，再提示反而啰嗦。
 */
export const BIG_BOOK_BYTES = 8 * 1024 * 1024;

export function isBigBook(sizeBytes: number | undefined | null): boolean {
  return typeof sizeBytes === "number" && sizeBytes >= BIG_BOOK_BYTES;
}
