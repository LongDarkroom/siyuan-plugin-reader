/**
 * 阅读器线性图标表（2026-11-06）
 * ----------------------------------------------------------------
 * 上下栏与设置面板共用同一套图标，替代此前的「字符拼贴」
 * （‹ ☰ 📝 ⬚ ✦ ⚙ 🔍 ⋯ ⌄ ⏮ ⏪ ◀ ▶ ⏩ ⏭）。
 *
 * 字符的问题不是不好看，而是**不可控**：来自不同字体，字重/基线/大小
 * 随系统与字号漂移，emoji 还会被渲染成彩色，和思源的线性风格打架。
 *
 * 规格：24 网格 / 1.75px 描边 / 圆头圆角，栏内 18px、设置导航 17px。
 * 翻页图标刻意分两档表达层级：单箭头 = 页，双箭头 = 章。
 *
 * 值是一段 SVG 内部标记（path/rect/circle），由调用方塞进
 * `<svg viewBox="0 0 24 24">`，描边属性统一在外层控制。
 */
export const ICONS = {
  /* ---- 上下栏 ---- */
  back: '<path d="M15 5l-7 7 7 7"/>',
  toc:
    '<path d="M8.5 6h11M8.5 12h11M8.5 18h11"/>' +
    '<circle cx="4.4" cy="6" r="1.2" fill="currentColor" stroke="none"/>' +
    '<circle cx="4.4" cy="12" r="1.2" fill="currentColor" stroke="none"/>' +
    '<circle cx="4.4" cy="18" r="1.2" fill="currentColor" stroke="none"/>',
  marks: '<path d="M7 4h10a1 1 0 011 1v15l-6-4.2L6 20V5a1 1 0 011-1z"/>',
  scan:
    '<path d="M4 9V6.5A2.5 2.5 0 016.5 4H9M15 4h2.5A2.5 2.5 0 0120 6.5V9' +
    'M20 15v2.5a2.5 2.5 0 01-2.5 2.5H15M9 20H6.5A2.5 2.5 0 014 17.5V15"/>',
  sparkles:
    '<path d="M11.5 3.5l1.6 4.2 4.2 1.6-4.2 1.6-1.6 4.2-1.6-4.2L5.7 9.3l4.2-1.6z"/>' +
    '<path d="M18 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  settings:
    '<path d="M4 8h5M13 8h7M4 16h8M16 16h4"/>' +
    '<circle cx="11" cy="8" r="2"/><circle cx="14" cy="16" r="2"/>',
  search: '<circle cx="11" cy="11" r="6.2"/><path d="M15.6 15.6L20 20"/>',
  more:
    '<circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/>' +
    '<circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/>' +
    '<circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/>',

  /* ---- 翻页：单箭头 = 页，双箭头 = 章 ---- */
  chevronDown: '<path d="M6 9.5l6 6 6-6"/>',
  chevronLeft: '<path d="M14.5 6l-6 6 6 6"/>',
  chevronRight: '<path d="M9.5 6l6 6-6 6"/>',
  first: '<path d="M6 5v14"/><path d="M18 6l-6 6 6 6"/>',
  last: '<path d="M18 5v14"/><path d="M6 6l6 6-6 6"/>',
  prevChapter: '<path d="M11.5 6.5L6 12l5.5 5.5"/><path d="M18.5 6.5L13 12l5.5 5.5"/>',
  nextChapter: '<path d="M12.5 6.5L18 12l-5.5 5.5"/><path d="M5.5 6.5L11 12l-5.5 5.5"/>',

  /* ---- 设置面板导航 ---- */
  font: '<path d="M6 19L12 5l6 14"/><path d="M8.5 14h7"/>',
  layout:
    '<rect x="4" y="4" width="7" height="16" rx="1.5"/>' +
    '<rect x="13" y="4" width="7" height="16" rx="1.5"/>',
  theme:
    '<circle cx="12" cy="12" r="8"/>' +
    '<path d="M12 4a8 8 0 010 16z" fill="currentColor" stroke="none"/>',
  behavior:
    '<path d="M9 11V5.5a1.5 1.5 0 013 0V11m0-1.5a1.5 1.5 0 013 0V12' +
    'm0-1a1.5 1.5 0 013 0v3.5a6 6 0 01-6 6h-1.6a5 5 0 01-3.7-1.7L6 15.5' +
    'a1.6 1.6 0 012.4-2L9 14"/>',
  lang: '<path d="M4 19l5-14 5 14M6.5 14h7M14 19l3.5-9 3.5 9M15.6 16h3.8"/>',
  translate:
    '<path d="M3.5 6h7.5M7.2 4v2c0 3.4-1.7 6.3-4.7 7.8"/>' +
    '<path d="M4.8 9.2c1 1.9 2.9 3.4 5.2 4.2"/>' +
    '<path d="M13 20l3.6-8.5L20.2 20M14.4 17.2h4.4"/>',
  tts:
    '<path d="M4.5 10v4h3l4.5 3.5v-11L7.5 10z"/>' +
    '<path d="M16.5 9a4.2 4.2 0 010 6"/><path d="M19 6.5a7.6 7.6 0 010 11"/>',

  /* ---- PDF 工具栏 ---- */
  zoomOut: '<circle cx="11" cy="11" r="6.2"/><path d="M15.6 15.6L20 20"/><path d="M8.4 11h5.2"/>',
  zoomIn: '<circle cx="11" cy="11" r="6.2"/><path d="M15.6 15.6L20 20"/><path d="M8.4 11h5.2M11 8.4v5.2"/>',
  fitWidth:
    '<path d="M4 8v8M20 8v8"/>' +
    '<path d="M8.5 12h7"/><path d="M11.5 9.2L8.5 12l3 2.8M12.5 9.2l3 2.8-3 2.8"/>',
  fitPage: '<rect x="5" y="3.5" width="14" height="17" rx="1.6"/><path d="M9 9h6M9 12.5h6M9 16h4"/>',

  /* ---- 目录当前位置（微信读书式） ---- */
  bookOpen:
    '<path d="M12 6.5C10.5 5 8.4 4.5 5 4.5v13c3.4 0 5.5.5 7 2 1.5-1.5 3.6-2 7-2v-13c-3.4 0-5.5.5-7 2z"/>' +
    '<path d="M12 6.5v13"/>',

  /* ---- 通用 ---- */
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  reset: '<path d="M4.5 12a7.5 7.5 0 101.8-4.9"/><path d="M4 4v4.5h4.5"/>',

  /* ---- 朗读条 ---- */
  play: '<path d="M8 5.5l11 6.5-11 6.5z"/>',
  pause: '<path d="M9.5 6v12M14.5 6v12"/>',
  stop: '<rect x="7.5" y="7.5" width="9" height="9" rx="2"/>',
  prevSentence: '<path d="M6 5.5v13"/><path d="M18 6l-8 6 8 6z"/>',
  nextSentence: '<path d="M18 5.5v13"/><path d="M6 6l8 6-8 6z"/>',
} as const;

export type IconName = keyof typeof ICONS;
