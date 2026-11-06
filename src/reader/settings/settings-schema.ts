/**
 * 阅读设置 · 数据表（唯一真源）
 * ----------------------------------------------------------------
 * 全面对标 Readest 设置面板（2026-10-06）。所有 Tab 的行定义都在这里，
 * 组件只负责按 schema 渲染 —— 以后增删参数只改本文件，不动组件。
 *
 * 设计要点：
 * 1. **按维度分组，不按来源**。旧的 7 个 `<details>`（文本/段落/朗读/笔记导出/
 *    页面布局/状态栏/高级）是历史堆积；Readest 按「字体/布局/主题/语言/朗读」
 *    五维切分，每个参数只出现一次。
 * 2. **路径用点号**（`layout.marginTopPx`），由 `getByPath` / `setByPath` 解析，
 *    这样嵌套字段（layout.*）与顶层字段用同一套读写逻辑。
 * 3. **showIf 惰性求值**：某些行只在特定条件显示（如「中文发音人」仅 system 引擎时
 *    有意义、「讯飞密钥」仅选讯飞时显示）。写成函数而非布尔，便于引用运行时状态。
 *
 * 类型说明：`Ctrl` 决定渲染哪种控件，由 RowControl.svelte 统一分发。
 */
import { t } from "../../i18n/index.ts";
import {
  READER_FONT_SIZE_MIN,
  READER_FONT_SIZE_MAX,
  THEME_PRESETS,
  LAYOUT_PRESETS,
  LAYOUT_PRESET_KEYS,
  detectLayoutPreset,
  FONT_MODE_PRESETS,
  SERIF_FONT_PRESETS,
  SANS_SERIF_FONT_PRESETS,
  MONOSPACE_FONT_PRESETS,
  CJK_FONT_PRESETS,
  serifFontOptions,
  sansSerifFontOptions,
  monospaceFontOptions,
  cjkFontOptions,
} from "../reader-settings.ts";
import type { ReaderTheme, ReaderFontMode, ReaderDefaultFontFamily } from "../reader-settings.ts";
import { TARGET_LANG_OPTIONS } from "../bilingual-langs.ts";


/* ============================================================
 * 一、类型定义
 * ============================================================ */

/** 控件类型（对应 RowControl.svelte 的分支） */
export type Ctrl =
  | "switch" // 开关
  | "slider" // 滑块
  | "stepper" // 数值 − 数字 ＋（Readest 风格）
  | "select" // 下拉
  | "color" // 取色器
  | "colorRow" // 取色器 + 快速色块
  | "swatches" // 色板宫格（主题）
  | "segmented" // 分段按钮（二选一/多选一）
  | "presetCards" // 整宽预设卡（标题 + 指标副标，三档并列）
  | "chips" // 胶囊标签（多值单选，比 segmented 更宽松、可换行）
  | "entry" // 文本输入
  | "action" // 入口按钮（打开二级页，不落值）
  | "dropzone"; // 拖拽绑定区

/**
 * 行定义
 *
 * ============================ 参数闭环契约 ============================
 * 用户明确要求：「不要出现设置参数改变、而界面不变的情况」。
 * 为此每行都可声明 `apply` / `verify`，由测试遍历校验：
 *   apply  = 改值后需要触发什么（重排样式 / 重绘画布 / 重启 TTS …）
 *   verify = 断言「当前值落在有效区间」，用于捕获「改了但没生效」
 * 新增设置行时**必须**同时给 verify，否则测试会以「未声明闭环契约」失败。
 * ====================================================================
 */
export interface RowDef {
  /** 设置对象的字段路径，点号分隔 */
  path: string;
  /** 标签（中文原文，走 t() 国际化） */
  label: string;
  /** 控件类型 */
  ctrl: Ctrl;
  /**
   * 行内短说明（单行，≤16 字）。
   *
   * 2026-11-06 文案瘦身：只保留「不看说明就会用错」的一句；
   * 选项名已表达清楚的解释一律删掉，避免每行都挂灰字。
   */
  hint?: string;
  /**
   * 长说明（2026-11-06）：默认不占位，渲染成标签旁的 ⓘ，
   * 悬停 / 点击才浮出。用于发音人下载路径、手势边界这类必须讲全的引导。
   */
  info?: string;
  /** 数值范围（slider / stepper） */
  min?: number;
  max?: number;
  step?: number;
  /** 单位后缀（如 px / % / em） */
  unit?: string;
  /**
   * 下拉 / 分段 / 预设卡选项。
   * `meta` 仅 presetCards 用：卡片第二行的指标副标（如「页宽 80% · 行距 1.7」）。
   */
  options?: { value: string | number; label: string; bg?: string; fg?: string; meta?: string }[];
  /** 选项来源：静态数组或 Svelte store（字体列表等动态选项） */
  optionsFrom?: readonly string[] | import("svelte/store").Writable<string[]> | import("svelte/store").Writable<{ value: string; label: string }[]>;
  /** 条件显示 */
  showIf?: (s: any, extra: any) => boolean;
  /**
   * 只读（2026-10-07）。
   *
   * 控件仍渲染、值仍显示，但不可改（样式变灰 + 禁用交互）。
   * 用于「跟随态下展示思源实际字号」这类**需要看见、但不允许在此改**的行——
   * 若改用 showIf 隐藏，用户就失去了「当前跟随到多少」这个信息。
   */
  readonly?: boolean;
  /**
   * 只读行的取值路径（2026-10-07，配合 readonly 用）。
   *
   * ## 为什么需要它
   * 「跟随思源字号」那行要**显示** `fontSize` 的值但**不可改**，而
   * 「自定义字号」滑块也要读写同一个 `fontSize`。若两行都用 `path: "fontSize"`，
   * schema 里就出现**重复 path** —— 它破坏三件事：
   *   · 闭环测试「不得有完全重复的 path」直接失败；
   *   · 设置搜索结果的 each key 用 path 拼接时会撞；
   *   · 语义上「只读展示」与「可编辑」是两种角色，不该共用一个身份。
   * 故本行用虚拟 path（`__` 前缀 = 不落值，闭环测试会跳过），
   * 真实取值交给 readonlyPath。
   */
  readonlyPath?: string;
  /**
   * 派生取值（2026-11-04）。
   *
   * 虚拟 path（`__preset` 这类不落盘的 UI 态）需要「显示什么」由当前设置反查：
   * 预设的选中档 = detectLayoutPreset(settings)。声明成函数而不是在控件里特判，
   * 让 schema 仍是唯一真源（新增派生行不必改 RowControl）。
   */
  valueFrom?: (settings: any, extra: any) => any;
  /** 依赖的外部数据（如 TTS 配置、readerMode） */
  needs?: "tts" | "readerMode";
  /**
   * action 按钮的自定义文字（2026-10-09）。
   *
   * 默认「打开」对多数入口合适，但「本书发送目标」这类
   * 语义是"挑一个"而非"进二级页"的场景，说「选择」更准。
   */
  actionLabel?: string;
  /**
   * action 行左侧的**只读**当前值（2026-10-09）。
   *
   * ⚠️ schema 是**纯静态声明**，拿不到宿主的 BookMeta / store，
   * 所以 `__bookTarget` 这类行不会在 schema 里写死这个值 ——
   * 它由 `SettingsDialog.decorateRow()` 在渲染时注入。
   * 本字段只声明"这里可以放值"，让类型系统认得它。
   */
  displayValue?: string;
  /** 是否有值（false 时用弱化色显示"未设置"，见 RowControl） */
  displayValueSet?: boolean;
  /**
   * 运行时异步选项（2026-10-07）。
   *
   * 用于「只能在浏览器里枚举」的选项，schema 阶段拿不到：
   *   TTS 发音人列表来自 `speechSynthesis.getVoices()`，且 macOS/Electron
   *   首次返回空数组、需等 `voiceschanged` —— 同步的 options 表达不了。
   *
   * 约定：返回选项数组；控件挂载时自动调用，`extra.tts.engine` 变化时重取。
   */
  asyncOptions?: (extra: any) => Promise<{ value: string; label: string }[]>;

  /**
   * 改值后需要触发什么（闭环契约 · 2026-10-07）。
   *
   * - style  重算排版样式（applyStyles）
   * - render 重绘画布 / 重新渲染书籍内容
   * - tts    影响朗读行为（下次播放时生效，不必重排）
   * - dict   影响查词结果
   * - none   落盘即生效（如笔记导出绑定等）
   */
  apply?:
    | "style"
    | "render"
    | "tts"
    | "dict"
    // 翻译链路（2026-10-07 接通）：改动经宿主 updateTranslateSettings 落盘，
    // 不进 reader-settings 的 book/pdf 分片（配置是全局的，与书无关）。
    | "translate"
    | "none";

  /**
   * 设置所属分片（闭环契约 · 2026-10-07）。
   * - book   仅 EPUB/MOBI 等可重排文本生效
   * - pdf    仅 PDF 生效
   * - global 两个分片共用
   */
  scope?: "book" | "pdf" | "global";

  /**
   * 闭环校验函数（闭环契约 · 2026-10-07）。
   *
   * 给定当前设置值，返回是否「有效」。测试会遍历每行调用它 ——
   * 用途是捕获「面板改了但实际生效的值没变」这类静默失效。
   * 例：`verify: (v) => v >= 0.5 && v <= 3`（语速必须在 0.5~3 之间）
   */
  verify?: (value: any, extra?: any) => boolean;
  /**
   * 入口按钮要派发的动作名（2026-10-07）。
   * 仅 `ctrl: "action"` 用：点击后不写值，而是 dispatch(action) 给宿主 /
   * 或由 SettingsDialog 切二级页（如「词典管理」）。
   */
  action?: string;
  /**
   * 归一化 / 特殊处理交给控件工厂或宿主。
   * - marginPair   上下边距合一行（控件内渲染两个滑块）
   * - widthWithMode 页宽标签随模式切换（随窗口% / 固定书页px）
   * - themeColor   主题色板（宫格 + 每格取实际配色）
   * - ttsEngine    TTS 引擎（选项随 extra.tts 动态生成）
   * - layoutPreset 排版预设（宿主侧一次性套用多项，非普通 select）
   * - dictManager  词典管理入口（打开导入弹窗，非普通输入框）
   * - translateEngine 翻译引擎配置入口
   * - fontSizeSync  「跟随思源 / 自定义」二选一：schema 用 "sync"/"custom"
   *                 两个可读值，设置字段是布尔 fontSizeSync → 控件内转换
   */
  // 2026-11-03：收窄为「真正被实现」的两个。
  // 历史遗留：`widthWithMode`(2026-10-08 已删)、`ttsEngine`(2026-10-06 已删)、
  // 以及 themeColor / layoutPreset / dictManager / translateEngine / glossary / cache
  // 都只有声明没有实现 —— RowControl 只读 marginPair 与 fontSizeSync（见 RowControl.svelte:204/281），
  // 留着会让人以为这些行有 transform 行为。
  transform?: "marginPair" | "fontSizeSync";
}

/** 分组（小节标题 + 卡片容器） */
export interface GroupDef {
  /** 小节标题；空串表示不渲染标题（用于 Tab 顶部的第一个分组） */
  title?: string;
  rows: RowDef[];
  /**
   * 是否为「更多」折叠组（2026-10-07，对标 Readest 的折叠区）。
   *
   * 用于朗读 Tab：17 行平铺会让弹窗首屏装不下（max-height: 80vh），
   * 用户必须滚动才能看到「自动翻页 / 睡眠定时」等低频项。
   * 折叠后首屏 7 行（引擎/发音人/语速/文本源/粒度/高亮），其余收起。
   *
   * 折叠区标题右侧会显示「当前条件下有 N 项生效」，
   * 让用户点开前就知道里面有什么（否则 showIf 隐藏会导致布局跳动）。
   */
  collapsed?: boolean;
}

/** Tab 定义 */
export interface TabDef {
  /** Tab 唯一 key */
  key: string;
  /** Tab 显示名 */
  label: string;
  /**
   * SVG 内部标记（24×24 viewBox，1.75 描边、圆头，与上下栏 icons.ts 同口径）。
   * 存「内部标记」而不是单个 path：对比度图标需要填充块，布局图标需要 rect，
   * 只给 path 一个字段会逼着每个图标都画成路径，得不偿失。
   */
  icon: string;
  /** 是否为 PDF 模式下隐藏的 Tab（文本/段落/朗读类对固定版式无效） */
  hideInPdf?: boolean;
  groups: GroupDef[];
}

/* ============================================================
 * 二、路径读写工具
 * ============================================================ */

/** 按点号路径读取（支持 `layout.marginTopPx` 这类嵌套） */
export function getByPath(obj: any, path: string): any {
  if (!obj || !path) return undefined;
  if (!path.includes(".")) return obj[path];
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

/** 按点号路径写回（返回新的顶层对象，保持不可变更新） */
export function setByPath(obj: any, path: string, value: any): any {
  if (!path.includes(".")) return { ...obj, [path]: value };
  const parts = path.split(".");
  const [head, ...rest] = parts;
  return {
    ...obj,
    [head]: setByPath(obj?.[head] ?? {}, rest.join("."), value),
  };
}

/* ============================================================
 * 三、Tab 定义（对标 Readest 5 Tab）
 * ============================================================ */

/**
 * 「字族字段是否生效」的**唯一判据**（2026-10-07）。
 *
 * ## 为什么要一个函数而不是各处写 `s.fontMode === "custom"`
 * 砍档时漏掉一处就会造成「界面显示但执行层不读」或反之—— 也就是本次审计
 * 一直在消灭的那类静默失效。老设置档里还存着 `classified`，执行层是
 * `custom || classified` 双判，schema 若只判 custom就会让老用户的字族设置
 * 突然消失（界面无异常，只是下拉全没了）。
 *
 * ⇒ **改字体来源档位时，这里与 reader-style / ReaderView 的判断必须同步。**
 * 已有测试「老设置档残留的 classified 仍被识别为自定义」守着这一条。
 */
const FONT_FAMILY_ON = (s: any): boolean => s?.fontMode === "custom" || s?.fontMode === "classified";

/* 2026-11-06：图标从「裸 path 字符串」改为「SVG 内部标记」。
   原因是主题图标需要一个实心半圆（对比度示意），布局图标需要两个 rect——
   只允许 path 会逼着把矩形也手写成路径，可读性差且容易画歪。
   渲染端（SettingsDialog）统一包一层 24 网格的 <svg> + 1.75 描边。 */

/** 字体图标（Aa 的 A 字骨架） */
const ICON_FONT = '<path d="M6 19L12 5l6 14"/><path d="M8.5 14h7"/>';
/** 布局图标（双栏） */
const ICON_LAYOUT =
  '<rect x="4" y="4" width="7" height="16" rx="1.5"/><rect x="13" y="4" width="7" height="16" rx="1.5"/>';
/**
 * 行为图标（手形/手势）——2026-10-08 新增行为 Tab。
 * 沿用 Readest 行为 Tab 的语义，描边风格与其他图标统一。
 */
const ICON_BEHAVIOR =
  '<path d="M9 11V5.5a1.5 1.5 0 013 0V11m0-1.5a1.5 1.5 0 013 0V12m0-1a1.5 1.5 0 013 0v3.5a6 6 0 01-6 6h-1.6a5 5 0 01-3.7-1.7L6 15.5a1.6 1.6 0 012.4-2L9 14"/>';
/** 主题图标（对比度圆：左半实心）——比调色板更贴「明暗主题」的语义 */
const ICON_THEME =
  '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 010 16z" fill="currentColor" stroke="none"/>';
/** 语言图标（两个 A） */
const ICON_LANG =
  '<path d="M4 19l5-14 5 14M6.5 14h7M14 19l3.5-9 3.5 9M15.6 16h3.8"/>';
/** 朗读图标（喇叭 + 两道声波） */
const ICON_TTS =
  '<path d="M4.5 10v4h3l4.5 3.5v-11L7.5 10z"/><path d="M16.5 9a4.2 4.2 0 010 6"/><path d="M19 6.5a7.6 7.6 0 010 11"/>';
/** 双语翻译图标（左「文」右「A」的译义示意） */
const ICON_TRANSLATE =
  '<path d="M3.5 6h7.5M7.2 4v2c0 3.4-1.7 6.3-4.7 7.8"/><path d="M4.8 9.2c1 1.9 2.9 3.4 5.2 4.2"/><path d="M13 20l3.6-8.5L20.2 20M14.4 17.2h4.4"/>';

export const TABS: TabDef[] = [
  /* ==================== Tab 1 · 字体 ==================== */
  {
    key: "font",
    label: t("字体"),
    icon: ICON_FONT,
    // 2026-10-07：PDF 是固定版式，字号/字体族那套 CSS 完全不生效
    // （分页器按 PDF 原始页面尺寸渲染），面板却照常显示 → 用户点了就是「没反应」。
    // 与「朗读」Tab 同处理：PDF 下直接隐藏，不给无效控件。
    hideInPdf: true,
    groups: [
      {
        rows: [
          {
            path: "overridePublisherFont",
            label: t("覆盖书籍字体"),
            ctrl: "switch",
            hint: t("覆盖原书字体，改用下方设定"),
          },
        ],
      },
      {
        title: t("字号"),
        rows: [
          // 2026-10-07：字号改双态（方案 A）。
          //
          // 原先只有一个 stepper，用户抱怨「点不动/要点十几次」——
          // 26×26 的小按钮、1px 步进、从 17 调到 28 要点 11 次。
          // 现改为：来源二选一 + 随来源切换的输入形态。
          {
            path: "fontSizeSync",
            label: t("字号来源"),
            ctrl: "segmented",
            options: [
              { value: "sync", label: t("跟随思源") },
              { value: "custom", label: t("自定义") },
            ],
            hint: t("与思源正文字号一致"),
            // 值域是 "sync" / "custom"，而设置字段是布尔 → 需要转换，
            // 走 transform 而非让 RowControl 直接写。
            transform: "fontSizeSync",
          },
          // 跟随态：只读显示思源的实际字号，用户改不了（要改就切「自定义」）。
          {
            path: "__siyuanFontSize",
            readonlyPath: "fontSize",
            label: t("思源字号"),
            ctrl: "stepper",
            min: READER_FONT_SIZE_MIN,
            max: READER_FONT_SIZE_MAX,
            step: 1,
            unit: "px",
            showIf: (s) => s.fontSizeSync === true,
            // 跟随态不该能改：改动走「自定义」态的滑块。
            // 用 readonly 而非 showIf —— showIf 会让这一行消失，
            // 用户就看不到「当前跟随到的是多少」了（又变成信息缺失）。
            readonly: true,
          },
          // 自定义态：滑块。
          // 为什么不给更大的范围（Readest 是 1~120）：那是为桌面/触屏拖拽设计的，
          // 我们这是插件面板内的紧凑控件，28px 已远超正常阅读所需，
          // 上限放到 32 只会让滑块大部分行程落在「极端值」区。
          {
            path: "fontSize",
            label: t("自定义字号"),
            ctrl: "slider",
            min: READER_FONT_SIZE_MIN,
            max: READER_FONT_SIZE_MAX,
            step: 1,
            unit: "px",
            showIf: (s) => s.fontSizeSync === false,
          },
          // 2026-10-07 执行层接通（此前只有 schema/类型/默认值，零消费点 → 改了没反应）。
          // 语义是**小字下限**：图注/脚注实际字号 = max(正文字号 × 0.82, 本值)。
          {
            path: "minFontSize",
            label: t("最小字号"),
            ctrl: "stepper",
            min: 8,
            max: 20,
            step: 1,
            unit: "px",
            hint: t("图注 / 脚注的小字下限"),
          },
          { path: "text.fontWeight", label: t("字重"), ctrl: "stepper", min: 100, max: 900, step: 100 },
        ],
      },
      {
        title: t("字体来源"),
        rows: [
          // 2026-10-07 补齐（诊断见 docs/字体Tab诊断-设置与执行层衔接.md §三）。
          //
          // 为什么这是**所有字体链路的前置**：衬线/无衬线/等宽/中文四项只在
          // `fontMode === "custom"` 时被 reader-style.ts 消费。
          //
          // ⚠️ 2026-10-07 砍掉原「分类」档：它与「跟随思源/自定义」不是同一维度
          //   （前者是「接管后怎么分工」，后者是「字体从哪来」），
          //   并列在一个 segmented 里只能靠试错理解。原「系统默认」档同时砍掉
          //   （它其实是「不接管」，与「覆盖书籍字体」开关语义重叠）。
          // 现在来源只有两档，字族分配下沉为「自定义」态下的分组。
          {
            path: "fontMode",
            label: t("字体来源"),
            ctrl: "segmented",
            options: [
              { value: "follow-siyuan", label: t("跟随思源") },
              { value: "custom", label: t("自定义") },
            ],
          },
          // 字体导入/删除管理（对标 Readest 的 Manage Fonts 二级页）。
          // 依赖 reader-fonts.ts 已已有的 FontStore，本行只负责打开入口。
          {
            path: "__fontManager",
            label: t("管理字体"),
            ctrl: "action",
            action: "fontManager",
            hint: t("导入或删除字体文件"),
            showIf: (s) => FONT_FAMILY_ON(s),
          },
        ],
      },
      {
        title: t("字族"),
        rows: [
          // ⚠️ 五项都只在「自定义」模式下生效（reader-style.ts 的
          //   buildFontFamilyLists 仅在 fontMode==="custom" 时被调用）
          //   —— 不加 showIf 就是死设置。
          {
            path: "defaultFontFamily",
            label: t("默认字体"),
            ctrl: "segmented",
            options: [
              { value: "serif", label: t("衬线") },
              { value: "sans-serif", label: t("无衬线") },
            ],
            showIf: (s) => FONT_FAMILY_ON(s),
          },
          {
            path: "serifFont",
            label: t("衬线字体"),
            ctrl: "select",
            optionsFrom: serifFontOptions,
            showIf: (s) => FONT_FAMILY_ON(s),
            // 2026-11-01 拉丁/中文分工：这两槽是**西文**槽（英文正文走这里），
            // 汉字由「中文字体」槽接手（浏览器按字符逐个回退）。
            hint: t("西文衬线；汉字走中文字体"),
          },
          {
            path: "sansSerifFont",
            label: t("无衬线字体"),
            ctrl: "select",
            optionsFrom: sansSerifFontOptions,
            showIf: (s) => FONT_FAMILY_ON(s),
            hint: t("西文无衬线；汉字走中文字体"),
          },
          {
            path: "monospaceFont",
            label: t("等宽字体"),
            ctrl: "select",
            optionsFrom: monospaceFontOptions,
            showIf: (s) => FONT_FAMILY_ON(s),
            hint: t("代码块使用；汉字自动回落"),
          },
          {
            path: "defaultCJKFont",
            label: t("中文字体"),
            ctrl: "select",
            // 2026-10-07 闭环修复：默认值是空串""（= 跟随书籍/思源），
            //   但 CJK_FONT_PRESETS 里没有空串项 → 下拉永远不选中任何一行
            //   （用户看到的是「参数变了、控件没变」）。
            // 改为显式给 options，首项是「自动（跟随书籍）」对应空串。
            // 2026-10-14 方案 A：CJK 也改为动态 store，但首项保留翻译标签。
            optionsFrom: cjkFontOptions,
            showIf: (s) => FONT_FAMILY_ON(s),
            hint: t("汉字回退到此；留空用系统栈"),
          },
        ],
      },
      {
        title: t("竖排"),
        rows: [
          // 我们独有（Readest 无）：竖排中文书是真实需求
          { path: "verticalWriting", label: t("竖排阅读"), ctrl: "switch" },
          {
            path: "verticalPunctuation",
            label: t("竖排标点"),
            // 2026-10-07 闭环修复：此前用 segmented 输出字符串 "on"/"off"，
            // 而运行时判定是 `settings.verticalPunctuation !== false`
            //   → 存字符串 "off" 会被 `!== false` 判为**开**，用户选「不转换」却照转，
            //      典型的「参数改了、界面不变」。
            // 改为 switch，值域回到 boolean，与运行时口径一致。
            ctrl: "switch",
            showIf: (s) => !!s.verticalWriting,
            hint: t("西文标点转为中文标点"),
          },
        ],
      },
    ],
  },

  /* ==================== Tab 2 · 布局 ==================== */
  {
    key: "layout",
    label: t("布局"),
    icon: ICON_LAYOUT,
    groups: [
      {
        // 2026-11-04：预设从 Tab 底部移到最前 —— 它一键套用的正是下面所有滑块的组合，
        // 放底部等于「先让你拖十个滑块，最后才告诉你有一键」。
        // 只渲染三档（custom 不是档位，而是派生状态）。
        rows: [
          {
            path: "__preset",
            label: t("阅读预设"),
            ctrl: "presetCards",
            hint: t("一键套用；之后仍可微调"),
            // 选中档由当前设置反查：不再依赖一个永远不存在的 settings 字段
            valueFrom: (s) => detectLayoutPreset(s ?? {}),
            options: LAYOUT_PRESET_KEYS.map((k) => {
              const p = LAYOUT_PRESETS[k];
              return {
                value: k,
                label: p.label,
                meta: t("页宽 {w}% · 行距 {h}", { w: p.widthPct, h: p.lineHeight.toFixed(1) }),
              };
            }),
            // PDF 是固定版式，排版设置不生效（fixed-layout 不接 setStyles）——
            // 显示一排点了没反应的预设比不显示更糟。
            showIf: (_s, extra) => extra?.readerMode !== "pdf",
          },
        ],
      },
      {
        rows: [
          // M1 合并：旧的「排版让位」同时充当 Readest 的「覆盖版式布局」+「使用书籍排版」
          // 两者语义相同，合并为一个开关。
          {
            path: "overrideBookLayout",
            label: t("覆盖版式布局"),
            ctrl: "switch",
            hint: t("覆盖原书段距 / 行距 / 对齐"),
          },
        ],
      },
      {
        title: t("排版"),
        rows: [
          {
            path: "layout.widthMode",
            label: t("排版模式"),
            ctrl: "segmented",
            options: [
              { value: "pct", label: t("随窗口") },
              { value: "fixed", label: t("固定书页") },
            ],
            hint: t("随窗口伸缩，或按固定页宽分栏"),
          },
          // 每列宽度（2026-10-08 语义修正 + 补入口）。
          //
          //## 语义变更（这是本项目最隐蔽的一个 bug 的修复）
          // 旧实现把本字段当「**书页总宽**」写进 `--_reword-content-fixed`，
          // 而 paginator 把它当「**每列**宽」用：
          //   perColumn = min(fixed, hostSize) / 栏数
          // ⇒ 「总宽 720、2 栏」= 每列仅 360px。用户把滑块从 560 拖到 1200，
          //   每列始终撑不到 600px —— **拖到底也不变宽**（用户反馈「几乎不能使用」）。
          //
          // 现在对齐 Readest（utils/config.ts `getMaxInlineSize`）：
          // 本字段 = **每列的舒适宽度**，栏数由 foliate 依
          // `ceil(书区宽 / 本值)` 自己算，我们不插手瓜分。
          {
            path: "layout.fixedWidthPx",
            label: t("每列宽度"),
            ctrl: "stepper",
            min: 480,
            max: 1000,
            step: 20,
            unit: "px",
            showIf: (s) => s.layout?.widthMode === "fixed",
            hint: t("一列文字的宽度；栏数随窗口"),
          },
          // 栏数上限（2026-10-08 新增）：foliate 的 #top 默认样式硬编码
          // `--_max-column-count: 2`，此前我们没覆盖 ⇒ 无论多窄都最多 2 栏。
          {
            path: "layout.maxColumnCount",
            label: t("最大栏数"),
            ctrl: "stepper",
            min: 1,
            max: 4,
            step: 1,
            unit: t("栏"),
            showIf: (s) => s.layout?.widthMode === "fixed",
            hint: t("窗口不够宽时自动减少"),
          },
          // ⚠️ 2026-10-08 只在「随窗口」模式下显示。
          //
          //## 为什么加 showIf（此前是常显的无效行）
          // 它写的是 `layout.widthPct`，而 `pct` 模式在**固定书页**下已被忽略
          // （`layoutMarginStyles` 的 fixed 分支左右 padding 归零）。
          // ⇒ 常显一个「改了没反应」的行，正是本项目反复消灭的那类静默失效。
          //
          //## 为什么删掉 transform: "widthWithMode"
          // 那个 transform 声明了「页宽标签随模式切换」，但**全项目没有任何代码读它**
          //（RowControl 只实现了 fontSizeSync 与 marginPair）
          // ⇒ 死 transform + 一句会误导后人的注释，不如删掉。
          // 真正需要的「每列宽度」/「最大栏数」两行已在 fixed 模式下单独提供。
          {
            path: "layout.widthPct",
            label: t("页面宽度"),
            ctrl: "stepper",
            min: 50,
            max: 100,
            step: 5,
            unit: "%",
            showIf: (s) => s.layout?.widthMode !== "fixed",
          },
        ],
      },
      {
        title: t("段落"),
        rows: [
          { path: "paragraph.paragraphSpacing", label: t("段间距"), ctrl: "stepper", min: 0, max: 3, step: 0.1,
            hint: t("以字号为单位的倍数") },
          { path: "lineHeight", label: t("行间距"), ctrl: "stepper", min: 1, max: 2.6, step: 0.1 },
          // 从旧「文本设置」移来（Readest 把它放在布局里）
          //
          // 2026-10-07：字间距去掉负值（原 min: -1）。
          // letter-spacing 作用在**所有相邻字符之间（含词内）**，负值会让西文单词
          // 的字母粘连。Readest 的区间同样是 0 起的正值。
          // 2026-11-04：单位 px → em。px 不随字号缩放（17px 下 1px≈0.059em，
          // 22px 下只剩 0.045em），同一档设置在换字号后观感会漂。
          { path: "text.letterSpacing", label: t("字间距"), ctrl: "stepper", min: 0, max: 0.3, step: 0.01, unit: "em" },
          // 词间距（Readest 有，我们此前完全没有）：
          // 只作用在词与词之间，是调西文/中英混排疏密的正确旋钮。
          { path: "text.wordSpacing", label: t("词间距"), ctrl: "stepper", min: 0, max: 0.6, step: 0.01, unit: "em" },
          { path: "paragraph.textIndent", label: t("首行缩进"), ctrl: "stepper", min: 0, max: 4, step: 0.1, unit: "em" },
          // N2/N3 补齐：Readest 有，我们完全没有
          // 2026-10-07 接通：此前两端对齐是**完全死设置**（执行层硬编码 justify）。
          { path: "textAlign", label: t("两端对齐"), ctrl: "switch" },
          // 2026-10-07 接通：此前 hyphens:auto 是无条件施加的，本开关完全无效，
          // 且「覆盖版式布局」总开关也管不住它（实测输出仍在，只是丢了 !important）。
          { path: "hyphenate", label: t("断字"), ctrl: "switch",
            hint: t("西文换行加连字符") },
        ],
      },
      {
        title: t("页面"),
        rows: [
          // M6 合并：上/下边距合为一行双滑块
          {
            path: "layout.marginTopPx",
            label: t("上下边距"),
            ctrl: "slider",
            min: 0,
            max: 160,
            step: 4,
            unit: "px",
            transform: "marginPair",
          },
          // 2026-10-07：新增 columnCount。CSS `column-gap` 只在多栏布局下才有作用，
          // 而此前全项目没有任何 column-count 输出 ⇒ 这个滑块**单栏时完全无效**
          //（能拖、有反馈、视觉不变 = 又一个静默失效）。
          // 补了分栏数，间距滑块才有意义；单栏时直接不显示它。
          // ⚠️ 2026-10-08 更名：「分栏数」→「段内分栏」。
          // 它输出的是 CSS `body { column-count: N }` —— 把正文在**栏内纵向分栏**
          //（报纸式排版）。而上方「最大栏数」是 foliate 的**分页并排**（一屏几页）。
          // 两个都叫「分栏数」会让用户以为是同一个东西。
          {
            path: "layout.columnCount",
            label: t("段内分栏"),
            ctrl: "segmented",
            options: [
              { value: "1", label: t("不分栏") },
              { value: "2", label: t("两栏") },
              { value: "3", label: t("三栏") },
            ],
            hint: t("报纸式纵向分栏；不同于最大栏数"),
          },
          {
            path: "layout.columnGapPx",
            label: t("分栏间距"),
            ctrl: "slider",
            min: 0,
            max: 60,
            step: 2,
            unit: "px",
            showIf: (s) => Number(s.layout?.columnCount ?? 1) > 1,
          },
          {
            path: "layout.followSiyuanMargin",
            label: t("跟随思源边距"),
            ctrl: "switch",
            // 2026-10-07 修副作用前先说明：开启后会读宿主文档的左右内边距。
            // 旧实现把它**写回 settings**，关掉开关也不还原 ⇒ 已改为运行时缓存。
            hint: t("左右边距跟随思源正文宽度"),
          },
        ],
      },
      {
        // 2026-10-07：从主题 Tab 移到布局 Tab。
        //原位置不对——页眉页脚是**排版信息**（章节名 / 剩余量），不是配色。
        title: t("页眉页脚"),
        rows: [
          // ⚠️ 此项此前是**完全死设置**：宿主把值拆成 showHeader/showFooter 写进 settings，
          //   但这两个字段执行层零命中、阅读器也没有页眉页脚组件
          //   ⇒ 开关能点能存，什么都不发生。
          // 2026-11-06 方案 A：章节名只在顶栏显示（底栏那份已撤掉），
          // showHeader 改为门控顶栏；showFooter 仍门控进度条 title 里的剩余章节。
          { path: "layout.showHeader", label: t("顶栏显示章节名"), ctrl: "switch" },
          { path: "layout.showFooter", label: t("显示剩余章节"), ctrl: "switch" },
        ],
      },
    ],
  },

  /* ==================== Tab 3 · 主题 ==================== */
  {
    key: "theme",
    label: t("主题"),
    icon: ICON_THEME,
    groups: [
      {
        title: t("主题模式"),
        rows: [
          //2026-10-07：明暗与配色拆成两个独立字段。
          // 此前这一行写的是 `__themeMode`（虚拟path），靠宿主改写 `theme` 来表达明暗，
          // 于是「点主题模式 → 配色跟着变」。现在直接写 `themeMode`（真实字段），
          // 改明暗对 `theme` 零影响。
          {
            path: "themeMode",
            label: t("主题模式"),
            ctrl: "segmented",
            // 2026-10-08 hint 补充：选了 night/dark/gold 这三档深色配色时，
            // 实际呈现恒为深色（执行层 isDark || legacyDark），
            // 此时切「亮」不会有任何视觉变化 —— hint 必须说明，否则用户以为开关坏了。
            hint: t("深色配色下恒为深色"),
            options: [
              { value: "auto", label: t("跟随") },
              { value: "light", label: t("亮") },
              { value: "dark", label: t("暗") },
            ],
          },
        ],
      },
      {
        title: t("主题颜色"),
        rows: [
          {
            path: "theme",
            label: t("配色"),
            ctrl: "swatches",
            // 2026-10-07 对齐 Readest 色板：每格用该档**真实 bg/fg** 上色，
            // 让用户「看见颜色」而不是只读文字名。
            // 顺序「默认 → 亮色系 → 暗色系 → 自定义」。
            //
            // ⚠️ 移除了原先的首格「跟随」：它此前与上方的「主题模式·跟随」语义重叠，
            //   且实现上会让 theme 变成 "auto" → themeOf() 直接返回思源配色，
            //   **等于把用户选的配色顶掉**。用户点上方「跟随」时反馈「配色也变了」，
            //   就是这条路径造成的。「跟随」现在只由 themeMode 表达。
            options: [
              ...(["light", "almond", "autumn", "green", "blue"] as const)
                .map((k) => ({ value: k, label: THEME_PRESETS[k].label, bg: THEME_PRESETS[k].bg, fg: THEME_PRESETS[k].fg })),
              ...(["night", "dark", "gold"] as const)
                .map((k) => ({ value: k, label: THEME_PRESETS[k].label, bg: THEME_PRESETS[k].bg, fg: THEME_PRESETS[k].fg })),
              // 自定义档：底色取用户当前设置（未取色时回退白底黑字）
              {
                value: "custom",
                label: THEME_PRESETS.custom.label,
                // 运行时由 RowControl 用 settings.customBg 覆盖；这里给静态兜底
                bg: undefined,
                fg: undefined,
              },
            ],
          },
        ],
      },
      {
        title: t("自定义"),
        rows: [
          { path: "customFg", label: t("文字色"), ctrl: "color", showIf: (s) => s.theme === "custom" },
          { path: "customBg", label: t("背景色"), ctrl: "color", showIf: (s) => s.theme === "custom" },
          { path: "customBgImage", label: t("背景图（URL）"), ctrl: "entry", showIf: (s) => s.theme === "custom" },
        ],
      },
      {
        title: t("图片与书籍"),
        rows: [
          // N4/N5 补齐：Readest 有，我们完全没有。夜间阅读的实际痛点。
          { path: "invertImagesInDark", label: t("深色主题下图片反色"), ctrl: "switch",
            hint: t("照片会呈负片感") },
          { path: "overrideBookColor", label: t("覆盖书籍颜色"), ctrl: "switch",
            hint: t("拉回主题色，避免深底深字") },
        ],
      },
    ],
  },

  /* ==================== Tab 4 · 行为 ==================== */
  /*
   * 2026-10-08 新增。核心动机不是「补功能」，而是**暴露已有功能**：
   * 审计发现 `flow`（分页/连续滚动，ReaderView 里 66 处引用）、
   * `focusMode` **执行链全部完整，却一个面板入口都没有** ⇒ 用户看不到、也改不了。
   *
   * 这与之前消灭的「死设置」是**镜像问题**（那些是面板有、执行层无），
   * 且更难被发现 —— 用户根本不知道它存在。
   *
   * 位置：第 4 位（主题之后、语言之前）。
   * 理由：字体/布局/主题是「静态外观」，行为是「交互」，
   * 插在中间会打断「调整外观 → 调整操作」的节奏；
   * 放主题之后是「外观 → 交互 → 内容 → 声音」。
   *
   * ⚠️ 2026-10-09：本 Tab 原有的「翻页」分组整组删除（点击翻页 / 翻页动画 /
   *   翻页动画效果），连同本注释里对 clickToTurn / turnStyle 的提及。
   *   理由见下方「注释工具」分组上方的注释块。
   */
  {
    key: "behavior",
    label: t("行为"),
    icon: ICON_BEHAVIOR,
    groups: [
      {
        // 2026-11-06：上下栏改为「上下栏同一个 chrome 状态、纯浮层」的微信读书式交互后，
        // 「顶栏悬浮」开关整组退役。主入口恢复为顶栏收起时的小圆点；
        // 这里只放两个可选的手势增强项。
        title: t("阅读手势"),
        rows: [
          {
            path: "centerTapChrome",
            label: t("点正文中间开合上下栏"),
            ctrl: "switch",
            hint: t("点正文中心开合；顶栏圆点仍可用"),
            info: t("关闭时用顶栏收起后顶部中央的小圆点开合。开启后，桌面点正文中心、触屏点页面中心 1/3 也能开合；点其他位置仍会收起"),
          },
          {
            path: "tapZoneTurn",
            label: t("点按左右两侧翻页"),
            ctrl: "switch",
            hint: t("触屏左右 1/3 回退 / 前进"),
            info: t("触屏上点左侧 1/3 回退、右侧 1/3 前进。关闭后左右点按不再翻页，只保留开合手势与圆点"),
          },
        ],
      },
      {
        title: t("阅读与翻页"),
        rows: [
          {
            path: "flow",
            label: t("阅读模式"),
            ctrl: "segmented",
            options: [
              { value: "paginated", label: t("分页") },
              { value: "scrolled", label: t("连续滚动") },
            ],
          },
          {
            // 仅滚动模式生效：focusMode 的实现里写死了
            // `settings.focusMode && settings.flow === "scrolled"`
            path: "focusMode",
            label: t("专注模式"),
            ctrl: "switch",
            showIf: (s) => s.flow === "scrolled",
            hint: t("高亮视口中心段落"),
          },
          {
            // 2026-10-24 新增：滚轮翻页。
            // 仅分页模式生效 —— 连续滚动模式下正文本来就能滚，滚轮归原生滚动管。
            // 判定写在 wheelPageTurn 消费侧（ReaderView.onReaderWheel）：
            // `settings.flow !== "paginated"` 直接放行不拦截。
            path: "wheelPageTurn",
            label: t("滚轮翻页"),
            ctrl: "switch",
            showIf: (s) => s.flow === "paginated",
            hint: t("滚到底再滚一次才翻页"),
          },
        ],
      },
      {
        // 2026-10-09 整组删除：原「翻页」分组（点击翻页 / 翻页动画 / 翻页动画效果）。
        //
        // ## 为什么删掉「翻页动画效果」（slide / curl）
        //
        // 两条都走 View Transitions API，而阅读器是**插件 iframe 套在思源宿主里**，
        // 宿主之上还可能盖着别的插件的装饰层（如 Neo-Plus 纹理：
        // `position:fixed; z-index:99; mix-blend-mode:multiply`）。
        // VT 的快照与合成上下文**不受我们控制** —— 实测（docs/纹理闪烁-实测报告与方案.md）
        // 只能做到「CSS 变量正确」，无法保证像素级与静态画面一致。
        //
        // 更关键的是收益接近零：主力场景是**纯文本书**，卷页在纯文字上本质是
        // 「整页平移 + 阴影」，观感就是拖沓，而不是书页卷起来。
        // 用户实测反馈也是「只有默认好用」。
        //
        // 保留什么：foliate 的**朴素推移**（`turn-style=""` + `animated` 属性）。
        // 它不依赖 VT，稳定、跟手，是目前唯一可用的翻页观感。
        // ⇒ `applyTurnStyle` 现在只负责设 `animated` 属性（foliate 所有动画分支的总 gate）。
        //
        // ## 为什么删掉「点击翻页」
        //
        // 默认就是关的（`clickToTurn: false`，防误触），且触屏设备完全不走这条路径
        // （`setupZoneClick` 开头 `if (isTouchDevice()) return`）。
        // 桌面端留着它只是多一个「开了容易误触、关了没人用」的开关。
        //
        // ⚠️ 若日后要恢复，git 历史里有删除前的完整实现（schema 三行 +
        //   ReaderView 的 setupZoneClick / onSetTurnStyle / 三条分发分支）。
        title: t("注释工具"),
        rows: [
          {
            // 2026-10-08 新增。此前划词工具栏是**强制开启、无法关闭**的。
            // 给出关的选项有两个实际价值：
            //  ① 点链接时选中文本会误弹工具栏；
            //  ② 批注重度用户可能想改用其他入口。
            path: "selToolbarEnabled",
            label: t("启用划词工具栏"),
            ctrl: "switch",
            hint: t("选中文字后弹出工具栏"),
          },
          {
            // 补上 Readest 有、我们唯一真正缺的划词工具项。
            // copylink（复制链接）在 EPUB 里是书内锚点不是 URL ⇒ 抄了也没用；
            // proofread（校对）是英文语法检查 ⇒ 中文书用不上。
            // 「搜索」则是真需求：选中即查这个词在别处的用法。
            path: "selSearchEnabled",
            label: t("划词后搜索"),
            ctrl: "switch",
            hint: t("工具栏加一个「搜索」按钮"),
          },
        ],
      },
      {
        title: t("笔记与摘录"),
        rows: [
          {
            path: "exportTarget",
            label: t("导出方式"),
            ctrl: "segmented",
            options: [
              { value: "clipboard", label: t("剪贴板") },
              { value: "doc", label: t("文档") },
            ],
          },
          // ---- 2026-10-10 列表化收敛：四行散设置收敛为一行「笔记发送目标」入口 ----
          // 点「管理」进入总览页（TargetManagerPage）：默认目标 / 自动建档 / 书目列表全在里面。
          // 统计「共 N 本 · 已绑定 M」由 SettingsDialog.decorateRow 运行时注入（需读书架）。
          {
            path: "__targetManager",
            label: t("笔记发送目标"),
            ctrl: "action",
            action: "targetManager",
            actionLabel: t("管理"),
            showIf: (s) => s.exportTarget === "doc",
            hint: t("按书设置去向，或设默认目标"),
          },
          // ---- 2026-10-10：模板定制入口（划词发送模板/位置 + 摘录导出模板） ----
          {
            path: "__templates",
            label: t("模板定制"),
            ctrl: "action",
            action: "templates",
            hint: t("划词与摘录的模板"),
          },
        ],
      },
    ],
  },

  /* ==================== Tab 5 · 语言 ==================== */
  {
    key: "lang",
    label: t("语言"),
    icon: ICON_LANG,
    groups: [
      {
        title: t("词典"),
        rows: [
          // ---- 在线词典（2026-10-08）----
          // 🔴 这两项**不是新功能**，而是把早已存在的双源能力（2026-09-07 就有：
          //   弹窗内 🌐 按钮在离线/海词之间切换）暴露到设置页并持久化。
          //   改造前 dictPopupMode 只是内存里的 let 变量，**刷新页面就回到离线**。
          //
          // 刻意分成两项而不是一个：
          //   「是否允许联网」与「默认用哪个源」是两个独立诉求 ——
          //   私密书稿要彻底断网（关总闸），但也常想「留个 🌐 查生僻词时手动切」。
          { path: "onlineDictEnabled", label: t("在线词典"), ctrl: "switch",
            apply: "render", scope: "global",
            hint: t("联网查海词；关闭则完全离线") },
          { path: "dictDefaultSource", label: t("默认数据源"), ctrl: "segmented",
            apply: "render", scope: "global",
            showIf: (s) => s.onlineDictEnabled !== false,
            hint: t("弹窗内可用 🌐 随时切换"),
            options: [
              { value: "offline", label: t("离线词典") },
              { value: "online", label: t("海词") },
            ] },
          // N6 补齐（必须）：决策 G 的词典导入入口。
          // 2026-10-07 第 3 批：由 entry（带一个无用的文本框）改为 action
          //   ——词典数量/状态由 DictManager 持有，不存在「可编辑的值」，
          //   给个输入框会让用户以为要往里填什么（且改它没有任何效果）。
          //
          // 「释义字号 / 自动发音」两项**故意不在这里**：
          // 它们属于词典二级页（DictManagerPage），与词典列表同屏才说得清
          // 「这两个偏好只影响查词弹窗」。在此处再加一份= 两个入口改同一个
          // manifest 字段，用户改了一处不清另一处在哪生效。
          {
            path: "__dict",
            label: t("词典管理"),
            ctrl: "action",
            action: "dictManager",
            apply: "dict",
            scope: "global",
            hint: t("导入、启用离线词典"),
          },
        ],
      },
    ],
  },

  /* ==================== Tab · 双语翻译 ==================== */
  // 2026-10-14 简化重设计（对标 Readest「对照阅读」）：
  //   1. 从「语言」Tab 抽出、独立成 Tab；一个插件只有一个翻译配置入口。
  //   2. 引擎收口为**腾讯机器翻译单引擎** —— 删「翻译服务」下拉（含 AI 兜底）与
  //      「译文样式」（AI 提示词风格）；密钥仍走 __translateEngine 二级页（现只腾讯）。
  //   3. 运行时收敛为**渐进式单模式**（边读边译边缓存），故原「预翻译页数」改名
  //      「渐进预取分节」，语义是「当前分节之后额外预译的分节数」。
  //   AI 兜底、监督中心、五引擎优先级链、译文归档已整体下线。
  {
    key: "translate",
    label: t("双语翻译"),
    icon: ICON_TRANSLATE,
    groups: [
      {
        title: t("对照阅读"),
        rows: [
          { path: "bilingual", label: t("启用翻译"), ctrl: "switch",
            hint: t("原文下插入译文，边读边译"), apply: "render", scope: "book" },
          // 引擎凭据入口（现仅腾讯）。二级页给开关 + SecretId/SecretKey + 连通性测试。
          {
            path: "__translateEngine",
            label: t("腾讯翻译凭据"),
            ctrl: "action",
            action: "translateEngine",
            apply: "translate",
            scope: "global",
            hint: t("未配置则开启翻译无译文"),
          },
          // 术语表入口（二级页 GlossaryPage）：译后硬性替换，改术语自动失效重译。
          {
            path: "__glossary",
            label: t("术语表"),
            ctrl: "action",
            // 2026-11-03：transform 已删 —— RowControl 只实现了 marginPair /
            // fontSizeSync（见 RowControl.svelte:204/281），其余 transform 无任何
            // 代码读取；action 字段才是二级页入口，行为不变。
            action: "glossary",
            apply: "render",
            scope: "global",
            hint: t("统一专有名词译法"),
          },
          // 翻译缓存管理入口（二级页 CachePage）：列出已缓存的书、可按书清空。
          {
            path: "__cache",
            label: t("翻译缓存"),
            ctrl: "action",
            // 2026-11-03：transform 已删 —— RowControl 只实现了 marginPair /
            // fontSizeSync（见 RowControl.svelte:204/281），其余 transform 无任何
            // 代码读取；action 字段才是二级页入口，行为不变。
            action: "cache",
            apply: "render",
            scope: "global",
            hint: t("按书查看或清空缓存"),
          },
          // ---- 以下 3 项为 2026-10-07 对标 Readest 补齐（此前完全没有）----
          { path: "bilingualShowSource", label: t("显示原文"), ctrl: "switch",
            apply: "render", scope: "book",
            showIf: (s) => !!s.bilingual },
          { path: "bilingualTarget", label: t("翻译到"), ctrl: "select",
            // 2026-10-06：原先此行既无 options 也无 optionsFrom → 下拉渲染成空，
            // 用户以为功能坏了。选项复用双语模块的既有语言表（含简繁中文）。
            options: TARGET_LANG_OPTIONS,
            apply: "render", scope: "book",
            showIf: (s) => !!s.bilingual },
          { path: "bilingualPrefetchPages", label: t("渐进预取分节"), ctrl: "stepper",
            min: 0, max: 20, step: 1, unit: t("节"), showIf: (s) => !!s.bilingual },
          { path: "translationFontSize", label: t("译文字号"), ctrl: "slider",
            min: 0.4, max: 1.2, step: 0.02, unit: "%", showIf: (s) => !!s.bilingual },
          { path: "bilingualSkipCached", label: t("跳过已缓存"), ctrl: "switch",
            showIf: (s) => !!s.bilingual },
          { path: "bilingualRetry", label: t("失败自动重试"), ctrl: "switch",
            showIf: (s) => !!s.bilingual },
        ],
      },
    ],
  },

  /* ==================== Tab 5 · 朗读 ==================== */
  // 2026-10-14 纯布局重组（对标 Readest 朗读面板分区）：
  // 原来只有「语音」+「更多（折叠）」两组，17 行混在一起 —— 引擎/发音人（选音色）
  // 与句高亮/翻页（跟读体验）与睡眠定时/密钥（低频）平铺，找一项要扫全表。
  // 按「谁在说话 → 怎么跟读 → 怎么播 → 何时停」四段重排，只改分组与控件形态，
  // 不动 reader-tts.ts 引擎、不改任何 path 语义（sleepTimer 值仍是分钟数、
  // 音量仍是 0~1，只是把 stepper 换成 slider、把睡眠定时换成 chips）。
  // 2026-10-14 续：tts.scope（page/chapter/book 里只有 book 被引擎区分，与 autoPage
  // 重复）与 tts.source（引擎从不读取）两个「设了不生效」的死控件已在 schema 层删除
  // —— 控件下架即不再骗人，reader-tts.ts 里对应字段留默认、无害，未动引擎。
  {
    key: "tts",
    label: t("朗读"),
    icon: ICON_TTS,
    hideInPdf: true,
    groups: [
      // ---- 组1 · 语音：谁在念（引擎 + 发音人 + 韵律）----
      {
        title: t("语音"),
        rows: [
          { path: "tts.engine", label: t("语音引擎"), ctrl: "select", needs: "tts",
            // 2026-10-06：transform: "ttsEngine" 原是空壳（RowControl 只实现了
            // marginPair / dictManager），导致引擎下拉渲染成空。引擎取值是 5 个固定
            // 枚举（见 reader-tts.ts 的 TtsEngineKind），直接静态给出。
            options: [
              { value: "auto", label: t("自动（推荐）") },
              { value: "system", label: t("系统语音") },
              { value: "youdao", label: t("有道在线") },
              { value: "edge", label: t("Edge 在线") },
              { value: "iflytek", label: t("讯飞语音") },
            ] },
          // M3 合并：原「中文发音人」+「中文嗓音」两项语义重复 → 合并
          // 2026-10-07：选项改为运行时枚举系统音色（原先静态给不出 → 下拉永远空白）
          { path: "tts.preferVoiceURIZh", label: t("中文发音人"), ctrl: "select", needs: "tts",
            hint: t("优先离线增强音；下载见问号"),
            info: t("列表已按「离线·增强/优质」优先排序；想要离线高质量中文，先去 系统设置→辅助功能→朗读内容→自定义语音 下载 Tingting 等增强/优质版，下载后此处会标「离线·增强」"),
            asyncOptions: async () => {
              // ⚠️ 必须动态 import：reader-tts.ts 顶层会 import foliate vendor
              //   （text-walker.js 用到浏览器全局 NodeFilter），静态 import 会把
              //   vendor 拖进 Node 测试环境导致 ReferenceError。
              const m = await import("../reader-tts.ts");
              return m.systemVoiceOptions(await m.listSystemVoices("zh"));
            },
            showIf: (_s, x) => x?.tts?.engine === "system" },
          { path: "tts.preferVoiceURIEn", label: t("英文发音人"), ctrl: "select", needs: "tts",
            hint: t("优先离线增强音；下载见问号"),
            info: t("列表已按「离线·增强/优质」优先排序；想要离线高质量英文，先去 系统设置→辅助功能→朗读内容→自定义语音 下载增强/优质版，下载后此处会标「离线·增强」"),
            asyncOptions: async () => {
              const m = await import("../reader-tts.ts");
              return m.systemVoiceOptions(await m.listSystemVoices("en"));
            },
            showIf: (_s, x) => x?.tts?.engine === "system" },
          // 口音（有道）/发音人（讯飞）本质都是「选哪种嗓音」，归入语音组、按引擎显示；
          // 此前口音藏在折叠区，用户换了引擎找不到对应调节项。
          { path: "tts.accent", label: t("口音"), ctrl: "segmented", needs: "tts",
            showIf: (_s, x) => x?.tts?.engine === "youdao",
            options: [
              { value: "us", label: t("美音") },
              { value: "uk", label: t("英音") },
            ] },
          { path: "tts.iflytekVoice", label: t("讯飞发音人"), ctrl: "entry", needs: "tts",
            hint: t("留空默认小燕"),
            showIf: (_s, x) => x?.tts?.engine === "iflytek" },
          // 韵律三项由 stepper 改 slider：0.5~3 逐格点 ± 太慢，拖动直观。
          // 值语义不变（rate/pitch 仍是倍率、volume 仍是 0~1，RowControl 已按
          // path==="tts.volume" 把显示 ×100 加 %）。
          { path: "tts.rate", label: t("语速"), ctrl: "slider", needs: "tts", min: 0.5, max: 3, step: 0.1, unit: "×" },
          { path: "tts.pitch", label: t("音高"), ctrl: "slider", needs: "tts", min: 0.5, max: 2, step: 0.1, unit: "×" },
          { path: "tts.volume", label: t("音量"), ctrl: "slider", needs: "tts", min: 0, max: 1, step: 0.05, unit: "%" },
        ],
      },
      // ---- 组2 · 跟读：念到哪看得见（高亮跟随）----
      {
        title: t("跟读"),
        rows: [
          { path: "tts.enableHighlight", label: t("句高亮"), ctrl: "switch", needs: "tts" },
          { path: "tts.granularity", label: t("高亮粒度"), ctrl: "select", needs: "tts",
            showIf: (_s, x) => x?.tts?.enableHighlight !== false,
            options: [
              { value: "word", label: t("单词") },
              { value: "sentence", label: t("句子") },
              { value: "paragraph", label: t("段落") },
            ] },
          { path: "tts.highlightStyle", label: t("高亮样式"), ctrl: "select", needs: "tts",
            showIf: (_s, x) => x?.tts?.enableHighlight !== false,
            options: [
              { value: "background", label: t("荧光笔") },
              { value: "underline", label: t("下划线") },
              { value: "wavy", label: t("波浪线") },
            ] },
          { path: "tts.highlightColor", label: t("高亮颜色"), ctrl: "colorRow", needs: "tts",
            showIf: (_s, x) => x?.tts?.enableHighlight !== false },
        ],
      },
      // ---- 组3 · 播放：怎么连着念下去 ----
      {
        title: t("播放"),
        rows: [
          // 2026-10-14：删除「朗读范围」(tts.scope) 行 —— 引擎只在 autoPage 分支里判
          //   `scope === "book"`（reader-tts.ts:976），page/chapter 两种取值对引擎完全
          //   等价（都不跨节续读），且与下方「自动翻页」开关重复表达同一件事 →
          //   三个下拉两个是假档位。保留 autoPage 单一真源即可。scope 字段留默认 "book"
          //   （恒满足），行为等价于「autoPage 开 = 全书连读」。
          { path: "tts.autoPage", label: t("自动翻页"), ctrl: "switch", needs: "tts",
            hint: t("读完自动翻下一页") },
          { path: "tts.interval", label: t("句间停顿"), ctrl: "slider", needs: "tts", min: 0, max: 2000, step: 50, unit: "ms" },
        ],
      },
      // ---- 组4 · 定时与高级：低频项（折叠）----
      {
        title: t("定时与高级"),
        // 折叠区：睡眠定时 + 讯飞密钥。低频、且讯飞三项仅在 engine=iflytek 时显示，
        // 不折叠会让首屏被空行占满。折叠标题会显示「当前 N 项生效」。
        collapsed: true,
        rows: [
          // 睡眠定时由 stepper 改 chips：0/15/30/45/60 是常用档位，点一下即达，
          // 比连点 ± 快。值语义不变（仍是分钟数，0=关）。不含「本章结束」——
          // 引擎只认分钟数，放一个假档位就是「设了不生效」。
          { path: "tts.sleepTimerMin", label: t("睡眠定时"), ctrl: "chips", needs: "tts",
            options: [
              { value: 0, label: t("关闭") },
              { value: 15, label: "15" + t("分钟") },
              { value: 30, label: "30" + t("分钟") },
              { value: 45, label: "45" + t("分钟") },
              { value: 60, label: "60" + t("分钟") },
            ] },
          { path: "tts.iflytekAppId", label: "AppID", ctrl: "entry", needs: "tts",
            showIf: (_s, x) => x?.tts?.engine === "iflytek" },
          { path: "tts.iflytekApiKey", label: "APIKey", ctrl: "entry", needs: "tts",
            showIf: (_s, x) => x?.tts?.engine === "iflytek" },
          { path: "tts.iflytekApiSecret", label: "APISecret", ctrl: "entry", needs: "tts",
            showIf: (_s, x) => x?.tts?.engine === "iflytek" },
        ],
      },
    ],
  },
];

/** Tab key 联合类型 */
export type TabKey = (typeof TABS)[number]["key"];

/** 按 key 取 Tab */
export function getTab(key: string): TabDef | undefined {
  return TABS.find((t) => t.key === key);
}

/* ============================================================
 * 四、设置项搜索（2026-10-07 第 3 批）
 * ----------------------------------------------------------------
 * Readest 的设置面板顶部有搜索框：输入后跨所有 Tab 列出命中的设置项，
 * 点一条即跳到对应 Tab。参数已有 5 个 Tab、约 45 行，纯靠滚动找参数
 * 很慢（「睡眠定时」藏在朗读 Tab 的折叠区里），搜索是刚需。
 *
 * 设计要点：
 * 1. **索引在 schema 层构建**：RowDef 就是唯一真源，搜索直接遍历 TABS，
 *    不另维护一份关键词表 —— 否则加设置行时忘了加进索引表就搜不到。
 * 2. **匹配面**要宽：label（用户看到的）、hint（说明文案）、
 *    path（字段名，给记得 `tts.rate` 的人）、选项文案（搜「中文发音人」
 *    也能命中 `tts.preferVoiceURIZh` 的当前值）。
 * 3. **showIf 的行也要能被搜到**（如「中文发音人」只在 system 引擎下出现）。
 *    搜到了却跳过去看不见 = 搜索骗人。故索引保留全部行，由界面决定
 *    是否标注「当前条件下不生效」。
 * ============================================================ */

/** 搜索命中的一条结果 */
export interface SearchHit {
  /** 所属 Tab key */
  tabKey: string;
  /** 所属 Tab 显示名 */
  tabLabel: string;
  /** 所属分组标题（无标题分组为空串） */
  groupTitle: string;
  /** 该行定义（渲染时直接喂给 RowControl） */
  row: RowDef;
  /** 命中的文本片段（用于界面高亮，先取第一个命中的字段） */
  matchedOn: "label" | "hint" | "path" | "value";
}

/** 规范化：小写 + 去空白，便于大小写不敏感匹配 */
function norm(s: unknown): string {
  return String(s ?? "").toLowerCase().replace(/\s+/g, "");
}

/**
 * 当前设置的展示值文本（用于「搜选项文案」）。
 * 只取有意义的几个字段，避免把整个 settings 序列化进索引。
 */
function displayValueOf(settings: any, path: string): string {
  try {
    const v = getByPath(settings ?? {}, path);
    if (v === undefined || v === null || v === "") return "";
    if (typeof v === "boolean") return v ? "on" : "off";
    if (typeof v === "object") return "";
    return String(v);
  } catch {
    return "";
  }
}

/**
 * 遍历全部 Tab 的全部行，产出扁平索引。
 * @param settings 当前设置（用于把「选项当前值」也纳入可搜范围）
 */
export function buildSearchIndex(settings?: any): SearchHit[] {
  const out: SearchHit[] = [];
  for (const tab of TABS) {
    for (const group of tab.groups ?? []) {
      for (const row of group.rows ?? []) {
        out.push({
          tabKey: tab.key,
          tabLabel: tab.label,
          groupTitle: group.title ?? (group.collapsed ? t("更多") : ""),
          row,
          matchedOn: "label",
        });
      }
    }
  }
  return out;
}

/**
 * 搜索设置项。
 *
 * ⚠️ `visibleTabKeys` 不是可选项（2026-10-07 补）：PDF 模式下「朗读」Tab 整体隐藏，
 * 若搜索仍把它列出来，用户点结果会跳到一个**不存在的 Tab** —— 面板原地不动、
 * 看起来像搜索坏了。「搜不到」比「跳到空处」友好，故必须由调用方传可见 Tab 集合。
 *
 * @param query 关键词；空串返回空数组（界面据此显示「全部设置」而非结果列表）
 * @param settings 当前设置，用于把选项当前值纳入匹配
 * @param visibleTabKeys 仅在这些 Tab 内搜（PDF 模式要排除隐藏 Tab）；不传 = 全部
 * @returns 命中列表，按 Tab 原有顺序 + Tab 内原有顺序排列（稳定、可预期）
 */
export function searchSettings(
  query: string,
  settings?: any,
  visibleTabKeys?: readonly string[],
): SearchHit[] {
  const q = norm(query);
  if (!q) return [];
  const allow = visibleTabKeys && visibleTabKeys.length ? new Set(visibleTabKeys) : null;
  const hits: SearchHit[] = [];
  for (const item of buildSearchIndex(settings)) {
    if (allow && !allow.has(item.tabKey)) continue;
    const row = item.row;
    const candidates: { field: SearchHit["matchedOn"]; text: string }[] = [
      { field: "label", text: row.label },
      // info 也要能搜到（2026-11-06 文案瘦身）：长引导从 hint 挪进 ⓘ 后，
      // 只搜 hint 会让「Tingting」「离线·增强」这类关键词失联
      { field: "hint", text: [row.hint ?? "", row.info ?? ""].join(" ") },
      { field: "path", text: row.path },
      // 选项当前值：搜「youdao」能命中「中文发音人」这类下拉
      { field: "value", text: displayValueOf(settings, row.path) },
    ];
    const hit = candidates.find((c) => norm(c.text).includes(q));
    if (hit) hits.push({ ...item, matchedOn: hit.field });
  }
  return hits;
}
