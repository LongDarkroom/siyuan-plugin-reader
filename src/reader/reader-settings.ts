import { logSwallow } from "../core/safe.ts";
import { t } from "../i18n/index.ts";

/** 阅读设置全局单例（供非 Svelte 模块如 graph.ts / index.ts 读取绑定文档 ID） */
let _globalSettingsStore: any = null;
export function getGlobalSettingsStore(): ReaderSettingsStore | null {
  return _globalSettingsStore as ReaderSettingsStore | null;
}
/**
 * 阅读器 - 文本样式与阅读设置（持久化）
 * ---------------------------------------------------------------
 * 字号 / 行距 / 主题（8 预设 + 自定义色）/ 行宽 / 阅读模式 / 翻页动画，
 * 文本设置（字重/字距）/ 段落设置（段距/首行缩进）/ 页面布局（4 边距/页眉/页脚/进度等）/
 * 笔记插入（发送模板/插入位置/同步开关），存 hiword-reader-settings.json，变更防抖保存。
 *
 * 2026-08-24 扩展：4 大分类（文本/段落/页面布局/笔记插入）—— 适配自思阅 SiReader。
 * 向后兼容：旧版本 settings（无 text/paragraph/layout/note 字段）加载时用 DEFAULTS 合并。
 * 2026-09-09 P0 设置双分家：book / pdf 两个独立分片（{version:2, book, pdf}），
 * ReaderTab 按书类型取 scopeView 路由读写；未指定 scope 的全局调用默认 book。
 */

import { writable, type Writable } from "svelte/store";

/**
 * 主题**配色**（2026-10-07 从ReaderTheme 拆出）。
 *
 * 只管颜色，**不管明暗**。明暗由 `ReaderThemeMode` 独立控制。
 *
 * 拆分的理由（用户 2026-10-07 反馈：「点击跟随按钮，下面配色也随着改变」）：
 * 此前 `theme` 一个字段同时表达两件事 ——
 *   · 明暗模式：`auto` / `light`
 *   · 配色：almond / autumn / green / blue / night / dark / gold / custom
 * 于是「主题模式」只能靠改写 `theme` 来表达（选暗 → theme 改成 "dark"），
 * **配色被连带改掉**。这不是逻辑写错，是字段设计不足以承载两个维度。
 *
 * 注意：`light` 这一档是「白底黑字」，语义上既是配色也是「无彩色相」，
 * 保留它在配色列表里（用户可能想要「强制纯白，不要任何色相」）。
 * 它的明暗由 themeMode 决定，与其它配色同等对待。
 */
export type ReaderTheme =
  | "light"
  | "almond"
  | "autumn"
  | "green"
  | "blue"
  | "night"
  | "dark"
  | "gold"
  | "custom";

/**
 * 主题**明暗模式**（2026-10-07 新增）。
 *
 * 与配色的合成规则（见 `themeOf()` / `deriveStyleOutput()`）：
 *   · auto  → 跟随系统/思源的明暗，配色照用
 *   · light → 强制浅色，配色照用
 *   · dark  → 强制深色，配色照用
 * **关键**：无论选哪档，**配色字段都不被改写**。
 * 若配色本身与目标明暗冲突（如「杏仁黄」+ 深色模式），
 * 由样式层做明暗适配（提亮/压暗），而不是偷偷换成另一档配色。
 */
export type ReaderThemeMode = "auto" | "light" | "dark";

export type ReaderLineWidth = "narrow" | "normal" | "wide";
export type ReaderFlow = "paginated" | "scrolled";
// 2026-10-09：ReaderTurnStyle（default / slide / curl）随翻页动画 UI 一并删除。
// 翻页固定走 foliate 朴素推移（turn-style="" + animated 属性），无样式可选。
/**
 * 字体来源：跟随思源 / 自定义
 *
 * ## 2026-10-07：从四档砍到两档
 * 原先 `follow-siyuan | custom | system | classified` 四档并列在一个控件里，
 * 但它们**不是同一维度**：
 *   · 跟随思源 / 自定义 / 系统默认 → 「字体从哪来」（三选一，互斥）
 *   · 分类                      → 「接管之后怎么分工」（三条字体链各走哪条）
 * 两个维度塞进一个 segmented 只能靠试错理解，是「设置看不懂」的根因。
 *
 * 现在：来源两档；字族分配下沉为「自定义」态下的五个字段
 * （`defaultFontFamily` / `serifFont` / `sansSerifFont` / `monospaceFont` / `defaultCJKFont`），
 * 执行层以 `fontMode === "custom"` 作为它们的唯一开关。
 *
 * ## 为什么类型里仍保留 `system` / `classified`
 * **只为老设置档兼容**。改版前用户可能已存下这两个值；若从联合类型里删掉，
 * 载入旧档时类型对不上（`load()` 的浅合并不会校验值），容易在别处引发难查的分支错乱。
 * 执行层已不再消费它们 —— `system` 的分支删除，`classified` 由 `custom` 接管。
 */
export type ReaderFontMode = "follow-siyuan" | "custom" | "system" | "classified";

/** 正文默认走哪条字体链（2026-08-28，Readest 的「默认字体」概念） */
export type ReaderDefaultFontFamily = "serif" | "sans-serif";
/** 笔记插入位置：剪贴板 / 指定文档（2026-10-10 收敛：删除「当前文档」「笔记本」两条假成功去向） */
export type NoteInsertPosition = "clipboard" | "doc";
/** 笔记模板预设 */
export type NoteTemplatePreset = "simple" | "heading" | "quote" | "custom";
/** 进度样式：分数（如 5/100）/ 页码（如 12）/ 百分比（如 5%） */
export type ReaderProgressStyle = "fraction" | "page" | "percent";
/** 底部进度条「程序坞」唤出方式（2026-08-30）：小圆点常驻 / 悬浮热区 / 两者 */
export type ReaderBottomBarMode = "dot" | "hover" | "both";

/** 排版预设（2026-08-30）：一键套用边距 / 行距 / 段距 / 字距组合（与边距预设 LAYOUT_PRESETS 并存，维度更全） */
export type ReaderTypographyPreset = "compact" | "comfort" | "spacious" | "picture";

/** 文本设置（2026-08-24 新增） */
export interface ReaderTextSettings {
  /** 字重 100-900，step 100（默认 400） */
  fontWeight: number;
  /**
   * 字距0 ~ 4 px，step 0.5（默认 0）
   *
   * 2026-10-07 **去掉负值区间**（原 -1 ~ 4）。
   * 原因：`letter-spacing` 作用在**所有相邻字符之间（含词内）**，
   * 负值会让西文单词的字母互相粘连（`word` 的 w 与 o 挤在一起）。
   * 要调「词与词之间的疏密」应该用下面的 `wordSpacing`，那才是正确的旋钮。
   * Readest 的 letterSpacing 区间同样是 0~2。
   */
  letterSpacing: number;
  /**
   * 词间距 0 ~ 8 px，step 0.5（默认 0）
   *
   * 2026-10-07 新增（对标 Readest 的 `wordSpacing`，我们此前完全没有）。
   * 只作用在词与词之间，不影响词内 letter-spacing。
   * 对中文书籍的用处：调节西文单词之间、以及中西混排时的整体疏密。
   */
  wordSpacing?: number;
}

/** 段落设置（2026-08-24 新增） */
export interface ReaderParagraphSettings {
  /** 段距 0-2 em，step 0.1（默认 0.8） */
  paragraphSpacing: number;
  /** 首行缩进 0-4 em，step 0.5（默认 0） */
  textIndent: number;
}

/** 页面布局（2026-08-24 新增） */
export interface ReaderLayoutSettings {
  /** 4 边距（px）——上下边距仍直接生效；左右边距仅在「跟随思源页边」开启时使用（页宽语义下由 widthPct 派生） */
  marginTopPx: number;
  marginBottomPx: number;
  marginLeftPx: number;
  marginRightPx: number;
  /** 内容宽度占视口百分比（50-100；三档预设 铺满95 / 正常80 / 宽松70；左右 padding = (100-pct)/2 %，随窗口伸缩） */
  widthPct?: number;
  /** 页宽模式（2026-09-29）：pct = 随窗口百分比（原行为，默认）；fixed = 固定书页宽（Readst 式，居中） */
  widthMode?: "pct" | "fixed";
  /** 固定书页宽（widthMode=fixed 时生效，560-1440 px，默认 720；窗口窄于该值时退化撑满） */
  fixedWidthPx?: number;
  /** 分栏间距 0-40 px（默认 16，foliate 默认单列，预留多列扩展） */
  columnGapPx: number;
  /**
   * 正文分栏数（2026-10-07 新增）。
   *
   * 存在的理由：CSS `column-gap` **只在多栏布局下才生效**。
   * 在此之前项目里没有任何地方输出 `column-count`，
   * 导致「分栏间距」滑块永远无效（能拖、有反馈、视觉不变）。
   *
   * 语义：分页模式下决定一屏并排显示几页（对标 Readest 的 `maxColumnCount`）。
   * 1 = 单栏（默认，与既有行为一致）。
   */
  /**
   * CSS `column-count`（2026-10-07 新增）：**正文内部**的多栏排版（报纸式分栏）。
   *
   * ⚠️ 与 `maxColumnCount` 是**两套完全不同的机制**，切勿混淆：
   *  · `columnCount`    = body { column-count: N }，把一段正文在**栏内**纵向分栏
   *  · `maxColumnCount` = foliate 的 `--_max-column-count`，决定**一屏并排几页**
   */
  columnCount?: 1 | 2 | 3;
  /**
   * 一屏最多并排几页（2026-10-08 新增，对标 Readest 的 `maxColumnCount`）。
   *
   *## 为什么需要它
   * foliate 的 `#top` 默认样式里**硬编码** `--_max-column-count: 2`。
   * 此前我们没有覆盖它 ⇒ 无论把「书页宽度」调到多窄，**最多只有 2 栏**，
   * 「窄列 + 多栏」这种报纸式排版根本表达不出来。
   *
   * ## 语义边界
   * 它是**上限**，不是「实际栏数」。实际栏数由 foliate 依
   * `ceil(书区宽 / 每列舒适宽)` 算出后再被这个上限截断。
   *
   * 默认 2 = foliate 原生值，不改变既有观感。
   */
  maxColumnCount?: number;
  /** 显示页眉（默认 true） */
  showHeader: boolean;
  /** 显示页脚（默认 true） */
  showFooter: boolean;
  /** 显示阅读进度（默认 true） */
  showProgress: boolean;
  /** 进度样式（默认 fraction） */
  progressStyle: ReaderProgressStyle;
  /** 底部进度条「程序坞」唤出方式（默认 both：小圆点常驻 + 悬浮热区） */
  bottomBarMode: ReaderBottomBarMode;
  /**
   * 顶栏悬浮（默认 true，2026-10-08）。
   *
   * true = 顶栏脱离文档流（`position: absolute`），浮在正文上方：
   *   · 收起态只剩顶部中央一个小圆点，点一下浮起，再点收回（纯点击，无 hover 触发）；
   *   · 收起/展开**不改变正文几何**（纯 transform/opacity）—— 正文不重排、不跳页。
   * false = 恢复 2026-10-08 之前的行为：顶栏常驻文档流顶部（占 36px），中心点击切换显隐。
   *
   * 显隐**不落盘**：这是本次会话的临时状态（与底栏的 bottomBarPinned 同理），
   * 每次打开书默认收起。
   */
  topBarFloating: boolean;
  /** 参考页数 0-2000（默认 0，0=不显示） */
  referencePageCount: number;
  /** 显示当前时间（默认 false） */
  showCurrentTime: boolean;
  /** 24 小时制（默认 false） */
  use24Hour: boolean;
  /** 跟随思源文档边距：用宿主 .protyle-wysiwyg 的水平 padding 作为阅读器左右边距（默认 false，2026-08-29） */
  followSiyuanMargin?: boolean;
  /** 重启思源后自动恢复上次打开的阅读 Tab（默认 true；思源不会自动恢复自定义插件 Tab） */
  restoreTabsOnLaunch?: boolean;
}

/** 笔记模板支持的变量（用于 linkFormat 模板） */
export type NoteTemplateVar =
  | "bookTitle"
  | "author"
  | "chapter"
  | "cfi"
  | "link"
  | "text"
  | "note"
  | "image"
  | "date";

/** 笔记插入（发送文档设计，2026-08-24 新增；2026-10-10 收敛：删除 4 个零消费死字段） */
export interface ReaderNoteSettings {
  /** 插入位置（默认 doc，2026-10-10 由 clipboard 改为 doc，与用户实际用法一致） */
  insertPosition: NoteInsertPosition;
  /** 模板预设（默认 simple） */
  templatePreset: NoteTemplatePreset;
  /** 链接格式（textarea，默认 simple 模板） */
  linkFormat: string;
  /** 标注标签预设（textarea，每行一个或中文逗号分隔） */
  tagPresets: string;
}

/**
 * 正文字号的合法区间（2026-10-07）。
 *
 * ## 为什么上限给到 72（而不是原先的 28）
 * 思源自己的编辑器字号范围是 **9~72**（实测自思源前端产物 `common.*.js`：
 * `EDITOR_FONT_SIZE_MIN = 9` / `EDITOR_FONT_SIZE_MAX = 72` / `DEFAULT = 16`），
 * 你的截图里那个滑块就是它。
 * 「跟随思源」必须能接住思源允许的**每一个**值 —— 否则用户把编辑器字号设成
 * 32，我们这边因超界 `return 0` 静默不跟随，表现为「跟随不上、永远不变」。
 * 上限再高也没意义：滑块主体行程在 9~28，超过 28 的部分极少用到。
 *
 * ⚠️ schema 的滑块 min/max 与本常量必须一致（闭环测试会校验）。
 */
export const READER_FONT_SIZE_MIN = 9;
export const READER_FONT_SIZE_MAX = 72;
/** 思源的默认编辑器字号（对齐思源，首次安装时的观感一致） */
export const READER_FONT_SIZE_DEFAULT = 17;

export interface ReaderSettings {
  /** 字号 12-28 px */
  fontSize: number;
  /**
   * 字号是否跟随思源笔记（2026-10-07 新增）。
   *
   * 思源没有 `--b3-font-size` 变量，能读到的是正文 **计算后** 的 `font-size`
   * （思源设置里那个「字号」，通常 12~20）。因此「跟随」= 每次打开阅读器
   * 与打开设置面板时读一次宿主计算值，写进 `fontSize`。
   *
   * ## 为什么需要这个开关（而不是每次都覆盖）
   * 用户**手动拖过滑块**就说明他有明确意图，此后不该再被系统值覆盖 ——
   * 否则「我明明调到了 20px，下次开书又变回14px」，是另一种「设了不生效」。
   * 故语义定为（方案 A）：
   *   · `true`  → 跟随宿主，用户一拖滑块即改写为 `false`（自动转「自定义」）
   *   · `false` → 用 `fontSize` 里用户填的值，**永不被覆盖**
   */
  fontSizeSync: boolean;
  /**
   * 最小字号 8-20 px（2026-10-06 设置弹窗补齐，对齐 Readest）。
   * 2026-10-07 执行层接通：作用于图注/脚注等小字，
   * 实际字号 = max(正文字号 × 0.82, minFontSize)，见 reader-style 的 minFontSizeStyles。
   */
  minFontSize: number;
  /** 行距 1.4-2.2 */
  lineHeight: number;
  theme: ReaderTheme;
  /**
   * 主题明暗模式（2026-10-07 新增，与 `theme` 配色**互不影响**）。
   *
   * 之前明暗与配色共用 `theme` 一个字段，导致「改主题模式」必然「改配色」。
   * 拆开后：调 themeMode 只改明暗，`theme`（配色）一个字节都不动。
   */
  themeMode: ReaderThemeMode;
  /** 两端对齐（2026-10-06 补齐，对齐 Readest 布局页） */
  textAlign: boolean;
  /** 断字 / 连字符（2026-10-06 补齐，对齐 Readest；西文换行优化） */
  hyphenate: boolean;
  /** 深色主题下把图片反色（2026-10-06 补齐，夜间阅读必备） */
  invertImagesInDark: boolean;
  /** 覆盖书籍自带配色（2026-10-06 补齐，夜间/亮色下白底黑字刺眼时用） */
  overrideBookColor: boolean;
  /** 自定义主题文字色/背景色（theme=custom 时生效） */
  customFg?: string;
  customBg?: string;
  /** 自定义背景图 URL（theme=custom 时生效，2026-08-27 晚 P2.3） */
  customBgImage?: string;
  /** @deprecated 2026-09-29 设置整合：三档行宽 UI 已删（与「页宽模式」重叠）。字段保留兼容旧档，
   *  运行时不再消费（buildStyles 恒用 LINE_WIDTH_PRESETS.normal）。 */
  lineWidth: ReaderLineWidth;
  /** 阅读模式：分页 / 连续滚动 */
  flow: ReaderFlow;
  /**
   * ~~turnStyle / turnAnimated~~（2026-10-09 随 UI 一并移除，字段不再声明）
   *
   * ## 为什么字段也删掉，而不只是删 UI
   *
   * 保留无面板入口的字段 = 制造新的「有货无柜」死设置（settings-schema.ts 里
   * 记录过这类问题：`flow` 曾有 66 处执行层引用却零面板入口）。
   * 旧设置档里残留的 `turnStyle: "curl"` 等键会被 `_mergeDefaults` 忽略
   * （只做浅合并、不校验未知键），无需迁移。
   *
   * 翻页观感现在是**固定**的：foliate 朴素推移（`turn-style=""` + `animated` 属性）。
   * 见 ReaderView.applyTurnStyle。
   */
  /** 字体来源 */
  fontMode: ReaderFontMode;
  /** fontMode=custom 时选中的自定义字体 id */
  customFontId?: string;
  /* ---- 2026-08-28 分类字体（fontMode=classified，参考 Readest 字体面板） ---- */
  /** 正文默认走衬线还是无衬线链（默认 serif） */
  defaultFontFamily?: ReaderDefaultFontFamily;
  /** 衬线链首选字体（默认「霞鹜文楷」，思源笔记常用） */
  serifFont?: string;
  /** 无衬线链首选字体（默认「苹方」） */
  sansSerifFont?: string;
  /** 等宽链首选字体（默认「Fira Code」，代码块专用） */
  monospaceFont?: string;
  /** 中文字体：插入每条链的次位（留空=不插入，仅用跨平台 CJK 兜底栈） */
  defaultCJKFont?: string;
  /** 强制正文使用阅读器字体（霞鹜文楷），覆盖书籍自带死字体；默认开（参考 Readest/思阅「覆盖出版商字体」） */
  overridePublisherFont?: boolean;
  /** 统一正文字号：压平书籍自带 p/li 级字号（如 font-size: medium），让字号 A+/A- 全局生效；默认开 */
  overrideBookFontSize?: boolean;
  /**
   * 排版让位：书籍自带排版（行距/首行缩进/对齐/断词）是否让位给阅读器设置。
   * 默认开 = Readest 的 overrideLayout：先清洗出版方写在 body 上的脏排版值，
   * 再把用户设置以 !important 施加到段落级选择器，让滑块真正说了算。
   * 关闭 = 使用书籍原版排版：只保留颜色/字号/字体族与容器横向对齐，
   * 行距/缩进/对齐/断词全部交给书自己（适合排版考究的精排书）。
   * 与 overridePublisherFont / overrideBookFontSize 独立：那两项管字体与字号。
   */
  overrideBookLayout?: boolean;
  /**
   * 竖排（中文竖排阅读）：默认关。
   * - `false`（默认）= 横排，与之前一致。
   * - `true` = 竖排（`writing-mode: vertical-rl`，从右往左逐列）。
   *
   * 实现依据：vendored `paginator.js` 的 `getDirection()` **只看 CSS `writing-mode`**，
   * 不读任何插件配置；分页器自身在竖排下会自动把 `column-gap` 换成上下间距、
   * 把 body 的 `max-width` 换成 `max-height`、并翻转翻页方向（`rtl`）。
   * 所以插件侧只需**注入 writing-mode** + 做竖排专属的排版适配。
   */
  verticalWriting?: boolean;
  /**
   * 竖排标点替换（2026-10-06）：仅在 `verticalWriting` 开启时生效。
   * - `true`（默认）= 开启竖排时，把横排引号 `“”‘’「」『』` 换成竖排字形 `﹃﹄﹁﹂`。
   * - `false` = 保持横排引号形态（部分字体/个人习惯）。
   * 简体与繁体用不同映射表（与 Readest 一致），依据书籍语言或界面语言自动选择。
   */
  verticalPunctuation?: boolean;
  /** 专注模式：滚动时高亮视口中心段落、其余淡出（仅滚动模式生效）；默认关 */
  focusMode?: boolean;
  /**
   * 划词工具栏总开关（2026-10-08 新增，此前**强制开启、无法关闭**）。
   *
   * ## 为什么需要一个「关」的选项
   * ① 点书内链接时若恰好有选区，工具栏会误弹，遮挡刚点开的链接内容；
   * ② 批注/划线重度用户可能更想用其他入口（如摘录面板）而不是每次都弹。
   *
   * 默认 true = 保持既有行为，升级后观感不变。
   */
  selToolbarEnabled?: boolean;
  /**
   * 划词工具栏是否显示「搜索」按钮（2026-10-08 新增）。
   *
   * 补的是 Readest 有、我们唯一**真正缺**的划词工具项：
   * copylink 在 EPUB 里是书内锚点不是可分享 URL ⇒ 抄了也没用；
   * proofread 是英文语法检查 ⇒ 中文书用不上。
   * 「搜索」是真需求：选中即查这个词在全书的其他用法。
   *
   * 默认 false —— 加一项按钮会让原本 6 个的横向工具栏变挤，按需开启。
   */
  selSearchEnabled?: boolean;
  /**
   * 摘录导出目标（2026-10-08 新增）。
   *
   * - `clipboard`：写入系统剪贴板（= 既有 `exportAnnots` 的行为，默认）
   * - `doc`：追加到 `exportDocId` 指定的那篇思源笔记文档末尾
   *
   * ⚠️ 刻意**只做追加、不做覆盖** —— 覆盖会销毁用户文档已有内容，
   * 属破坏性操作，与本项目既定原则冲突（底栏浮层、四边距都守这条）。
   */
  exportTarget?: "clipboard" | "doc";
  /**
   * 「导出到文档」的目标文档 ID（2026-10-08 新增）。
   *
   * 由文档选择二级页写入。空串 = 尚未选择 ⇒ 导出时应提示先选文档。
   *
   * 🔴 2026-10-09 语义调整：per-book 绑定上线后，本字段**降级为「全局兜底」**。
   *   解析顺序见 `export/resolve-target.ts`：
   *   `BookMeta.notebookTarget?.docId ?? settings.exportDocId`。
   *   用户已拍板「per-book 为唯一来源」，但保留本字段是为了：
   *   ① 老设置档不失效（零破坏升级）；② 未绑定时有明确引导而非硬失败。
   *
   * ⚠️ 标题/路径**可以**持久化（下一条），原注释里"刻意不持久化已解析的标题"已过时 ——
   *   那是 2026-10-08 的判断，2026-10-09 推翻：设置里只显示一串
   *   `20260124212504-490vtgy` 用户根本认不出选的是哪篇。
   */
  exportDocId?: string;
  /**
   * 目标文档的标题（2026-10-09 新增）。
   *
   * 由文档选择页回填（取列表项的 `d.name`，无需额外查询）。
   * ⚠️ 手动粘贴 ID 时会**清空** —— 拿不到名字就别留旧标题，
   *   显示"上一篇的标题"而 ID 已是另一篇，比不显示更糟。
   */
  exportDocTitle?: string;
  /** 目标文档所属笔记本 ID（2026-10-09 新增，留空 = 未知，不猜）。 */
  exportNotebookId?: string;
  /** 目标文档所属笔记本名（展示用，避免去查 lsNotebooks）。 */
  exportNotebookName?: string;
  /**
   * 自动建档位置（「按书名自动建档」用，2026-10-10 新增）。
   *
   * 按书名自动建档的文档统一建在这个笔记本下（**必填**）；
   * 未设置时所有「自动建档」入口禁用，绝不落到未知位置（G5 硬约束）。
   */
  autoNotebookId?: string;
  /** 自动建档笔记本名（展示用；与 id 一并回填） */
  autoNotebookName?: string;
  /**
   * 归档子路径（2026-10-10 新增；默认值为 "阅读手札"，2026-10-10 收敛设定）。
   *
   * 留空 = 建在笔记本根下；填了则统一收进 `/笔记本/子路径/《书名》`。
   * 所有书共用同一个固定子路径（或无），不为每本书建独立子目录。
   * 默认 "阅读手札" 让自动建档的《书名》与用户既有的手记笔记同列。
   */
  autoArchivePath?: string;
  /**
   * 自动建档兜底开关（2026-10-10 列表化收敛新增）。
   *
   * true（默认开）= 某本书**未单独设置**且**未命中全局默认**时，
   * 第一次导出笔记会自动在 `autoNotebookId` 锚点（经 `autoArchivePath` 子层）
   * 下建《书名》并绑定，之后再导出走 per-book。
   * 锚点（`autoNotebookId`）未配时不生效，绝不落到未知位置（G5 硬约束）。
   * 默认打开=用户配了锚点即生效；老用户升级后行为更省心（零操作绑定）。
   */
  autoArchiveEnabled?: boolean;
  /**
   * 导出模板（2026-10-09 新增，受限 Jinja2 子集语法）。
   *
   * 空串 = 用内置默认预设（`export/template-presets.ts` 的第一个）。
   *
   * 🔴 **不进 `BookMeta`**：模板是**个人偏好**，不是某本书的属性
   *   （与"每本书一个发送目标"不同）。
   *
   * ⚠️ 换预设 / 清空都必须能回到"默认预设"，
   *   所以这里是"模板正文"而不是"预设 id"——
   *   预设被改过之后无法再靠 id 还原（用户可能只改了一行）。
   *   `exportTemplatePreset` 只用于 UI 高亮当前选中的预设。
   */
  exportTemplate?: string;
  /** 已命中的预设 id，仅用于 UI 高亮；用户手改模板后应清空 */
  exportTemplatePreset?: string;
  /**
   * 查词弹窗的默认数据源（2026-10-08 新增）。
   *
   * `offline` = 离线词典；`online` = 海词（`corp.dict.cn`）。
   * 决定**打开弹窗时先查哪个**，用户仍可用弹窗内的 🌐 按钮即时切换。
   *
   * 🔴 这不是「在线兜底」：弹窗内两者是**二选一**（`dictPopupMode`），
   * 不是「离线查不到才走在线」。理由见默认设置处的注释。
   */
  dictDefaultSource?: "offline" | "online";
  /**
   * 是否允许使用在线词典（海词，2026-10-08 新增）。默认 `true`。
   *
   * 与 `dictDefaultSource` 分开的原因：用户可能想「留个 🌐 以备不时之需」
   *（查生僻词时手动切），但默认仍走离线 —— 这两个诉求不该被一个开关绑死。
   *
   * 关掉后：🌐 按钮禁用、弹窗**完全不发起网络请求**（私密书稿场景）。
   */
  onlineDictEnabled?: boolean;
  /** 双语对照：开启后每段正文后注入译文（2026-08-27 重设计） */
  bilingual?: boolean;
  /**
   * 双语模式是否显示原文（2026-10-07，对标 Readest 的「显示原文」开关）。
   *
   * 实现方式：译文是原文元素的**紧邻兄弟节点**（见 bilingual-v2/render.ts v2 方案），
   * 故「隐藏原文」用 CSS 在 `.reader-view` 上加一个属性选择器即可，无需改 DOM 结构：
   *   关闭时只隐藏有译文的那些段落，纯原文段（无译文）不受影响。
   * 默认 true（显示原文）—— 关掉后对照阅读时视野只有译文，更专注。
   */
  bilingualShowSource?: boolean;
  /**
   * 翻译服务选择（2026-10-07，对标 Readest 的「翻译服务」）。
   *
   * 取值对应 `src/translate/engine.ts` 的 `buildProviders(cfg, deps, engine)` 第三参：
   *   auto（自动：免费引擎链 + AI 兜底）/ tencent / youdao / baidu /
   *   microsoft / libretranslate / ai（强制 AI）
   * ⚠️ 注意与 `ai-settings` 里的 `bilingualStyle`（翻译提示词风格）区分，
   *    两者同名不同义，勿混。
   */
  bilingualEngine?: string;
  /** 双语目标语言（ISO-639-1，默认 "zh"） */
  bilingualTarget?: string;
  /** 译文风格：直译(default) / 简洁版(concise)。简洁版译文更短、更像学习者笔记（2026-08-31 重新启用） */
  bilingualStyle?: "default" | "concise";
  /** 隐藏译文集合（2026-08-31）：bookId → 已隐藏段落指纹(segHash)数组，关闭/重开双语后保持隐藏 */
  bilingualHidden?: Record<string, string[]>;
  /** 译文字号（em 倍数，相对正文；默认 0.70；思源 CJK 字体大，0.70≈书籍字体的 0.90；2026-08-28） */
  translationFontSize?: number;
  /**
   * 预取分节数（整数 0–4，默认 2）：渐进窗口与注入闸门共用的「当前 + N 分节」。
   * 2026-09-05 更名与复活：R6 新运行时重新消费它（此前「窗口页数」UI 改了无效）；
   * 值越大翻页等待越少但消耗额度越快。
   */
  bilingualPrefetchPages?: number;
  /** 双语调试信息：译文块显示引擎与 Token 明细（默认关，替代原写死的 DEBUG_BILINGUAL 常量；2026-08-30） */
  bilingualDebug?: boolean;
  /** 双语默认模式：点击「双语」时如何翻译
   *  - "ask"        （默认）弹窗询问「整书预翻译 / 渐进式」
   *  - "whole-book" 直接整书预翻译（后台填充缓存）
   *  - "progressive" 直接渐进式（当前页 + N 页窗口，翻页自动补译）
   *  2026-08-31 Phase 4：独立「双语翻译设置」Tab 的全局默认行为。 */
  bilingualDefaultMode?: "ask" | "whole-book" | "progressive";
  /** 双语源语言（ISO-639-1，默认 "en"；英文书为主，亦支持 "auto"/"ja"/"fr"/...） */
  bilingualSourceLang?: string;
  /** 渐进式：翻页自动补译当前窗口（默认 true） */
  bilingualProgressiveAuto?: boolean;
  /** 翻译时跳过已缓存段落（默认 true，避免重复消耗 token/额度） */
  bilingualSkipCached?: boolean;
  /** 整书预翻译：边译边显示译文（默认 true；关则纯后台缓存，不注入 DOM） */
  bilingualRealtimePreview?: boolean;
  /**
   * 失败自动重试（默认 true）：翻译失败的段落按 5s→30s 退避最多重试 2 次。
   * 关闭后失败段不再自动重试（等下一轮翻页窗口自然重试）。2026-09-05 新增。
   * （2026-09-05 删除了 bilingualAlertRatio：R6 换运行时后无消费方，
   *   用量告警统一由监督中心 aiTokenAlertRatio 承担。）
   */
  bilingualRetry?: boolean;
  /* 2026-08-31：原 bilingualV2Enabled 开关已删除——v1（bilingual.ts）移除后，
   * v2 兄弟节点渲染成为唯一实现，无需再灰度切换。 */
  /** 段落悬停高亮：鼠标悬停段落时轻微底色（默认开，2026-08-28 增强项） */
  /* ---- 2026-08-31 Phase 2：译文归档到思源 SQLite ---- */
  /** 是否把译文同步写进思源笔记（可搜索 / 可 SQL 查询 / 随思源同步）。
   *  关闭时译文只存在插件自己的 JSON 缓存里。默认关闭——在用户思源里建文档是
   *  写入操作，需用户明确启用。 */
  translationArchiveEnabled?: boolean;
  /** 译文归档文档 ID（由 ensureTranslationArchiveDoc 自动创建并回填，一般无需手改） */
  translationArchiveDocId?: string;
  /* ---- 2026-09-01 笔记文档绑定：阅读摘录 / 书图谱 发送目标（替代写死的 /REword 路径） ---- */
  /** 阅读摘录绑定目标文档 ID：发送摘录时 append 到此文档 */
  excerptDocId?: string;
  /** 阅读摘录绑定文档标题（仅展示用） */
  excerptDocTitle?: string;
  /** 阅读摘录绑定文档所在笔记本 ID */
  excerptNotebookId?: string;
  /** 书图谱绑定目标文档 ID：导出书图谱时按书名去重 append 到此文档 */
  bookGraphDocId?: string;
  /** 书图谱绑定文档标题（仅展示用） */
  bookGraphDocTitle?: string;
  /** 书图谱绑定文档所在笔记本 ID */
  bookGraphNotebookId?: string;
  /* ---- 2026-08-29 PDF 显示设置（仅 PDF 书生效，对齐 Obsidian PDF++ 阅读菜单） ---- */
  /** PDF 视图模式：单页 / 双页 / 书籍（映射 foliate spread: none/both/portrait） */
  pdfViewMode?: "single" | "double" | "book";
  /** PDF 滚动方向：垂直 / 水平（仅「滚动」模式生效；映射 foliate scroll-direction） */
  pdfScrollDir?: "vertical" | "horizontal";
  /** PDF 反色 / 暗色：canvas 级 pageColors 反色，独立于阅读器通用主题 */
  pdfInvert?: boolean;
  /** 2026-09-04 P2：PDF 文本标注类型开关（精简聚焦，仅保留 3 类） */
  pdfAnnotHighlight?: boolean;  // 高亮（背景标注）
  pdfAnnotUnderline?: boolean;  // 直线段 / 波浪线（下划线类）
  pdfAnnotAnnotate?: boolean;   // 带批注内容的气泡
  /** 文本设置（2026-08-24 新增） */
  text: ReaderTextSettings;
  /** 段落设置（2026-08-24 新增） */
  paragraph: ReaderParagraphSettings;
  /** 页面布局（2026-08-24 新增） */
  layout: ReaderLayoutSettings;
  /** 笔记插入（2026-08-24 新增） */
  note: ReaderNoteSettings;
}

export const READER_DEFAULT_SETTINGS: ReaderSettings = {
  fontSize: 17,
  // 2026-10-07：默认跟随思源字号 —— 首次安装时用户什么都没配，
  // 与思源正文保持一致是最合理的默认（且拖一次滑块就会自动转为「自定义」）。
  fontSizeSync: true,
  // 2026-10-06 设置弹窗补齐：最小字号（Readest 面板有此项）。用于图片说明/脚注等小字兜底，
  // 避免书籍里的小字被整体放大到跟正文一样大。缺省取正文字号 −2，下限 10。
  minFontSize: 15,
  lineHeight: 1.7,
  theme: "light", // 配色档：2026-10-07 从「跟随思源」改为「默认白底」——明暗已由 themeMode 承担
  // 2026-10-07：明暗模式独立成字段。默认 auto = 跟随思源/系统，
  // 这是绝大多数用户想要的行为（跟宿主走），且**不影响配色**。
  themeMode: "auto",
  // 2026-10-06 设置弹窗：custom* 原为可选字段且默认值缺失 → 取色器读到 undefined 会
  // 渲染成空白。给兜底值（选 theme=custom 时才生效，故不影响其它主题）。
  customFg: "#222222",
  customBg: "#ffffff",
  customBgImage: "",
  lineWidth: "normal",
  flow: "paginated",
  // 2026-10-09：turnStyle / turnAnimated 字段已随 UI 一并删除，
  // 翻页固定走 foliate 朴素推移（turn-style="" + animated 属性），无设置项。
  fontMode: "follow-siyuan",
  // 2026-10-06 设置弹窗补齐：段落级排版开关（对齐 Readest「两端对齐」「断字」）
  //
  // 2026-10-07 修正：textAlign 由false 改**true**。
  // 此前它是**完全死设置**（执行层硬编码 `text-align: justify`），
  // 所以「实际观感一直是两端对齐」，而这个 false 只是个从不生效的假象。
  // 现在真正接上线后，默认必须与实际观感一致 = true，
  // 否则老用户一升级就会突然变成顶格（观感突变，且他从没主动要求过）。
  // hyphenate 保持 false：断字对中文书无意义，仅西文书按需开启。
  textAlign: true,
  hyphenate: false,
  // 2026-10-06 设置弹窗补齐：夜间阅读痛点两项
  invertImagesInDark: false, // 深色主题下图片反色
  overrideBookColor: false, // 覆盖书籍自带配色
  // 分类字体默认值（对齐 Readest 面板默认：衬线=霞鹜文楷 / 无衬线=微软雅黑 / 等宽=Fira Code）
  defaultFontFamily: "serif",
  serifFont: "霞鹜文楷",
  sansSerifFont: "苹方",
  monospaceFont: "Fira Code",
  defaultCJKFont: "",
  overridePublisherFont: true,
  overrideBookFontSize: true,
  overrideBookLayout: true,
  verticalWriting: false,
  verticalPunctuation: true,
  focusMode: false,
  // 2026-10-08 行为 Tab：划词工具栏默认开（= 既有行为），
  // 「搜索」按钮默认关（加了会让原本 6 项的横向工具栏变挤）；
  // 导出目标默认剪贴板（= 既有 exportAnnots 的行为）。
  selToolbarEnabled: true,
  selSearchEnabled: false,
  exportTarget: "clipboard",
  exportDocId: "",
  exportDocTitle: "",
  exportNotebookId: "",
  exportNotebookName: "",
  autoNotebookId: "",
  autoNotebookName: "",
  autoArchivePath: "阅读手札",
  // 2026-10-10 列表化收敛：自动建档兜底默认开启（配了锚点即生效）。
  autoArchiveEnabled: true,
  exportTemplate: "",
  exportTemplatePreset: "",
  // 2026-10-08 词典：查词弹窗的**默认**数据源（offline=离线词典 / online=海词）。
  //
  // 🔴 这不是「在线兜底」开关，而是**默认落在哪个源**——
  //   弹窗内已有 🌐 按钮可在两者间即时切换（2026-09-07 起就有），
  //   但 `dictPopupMode` 原先只是内存里的一个 `let` 变量，**刷新页面就回到 offline**。
  //   本字段把它持久化，让「我习惯用海词查生僻词」这个偏好能留住。
  //
  // 为什么默认 offline：离线词典是用户自己装的、确定可用；
  // 在线每次划词都要等网络（Readest 的注释明确警告过这一点）。
  dictDefaultSource: "offline",
  // 在线词典开关（2026-10-08）。关掉后🌐 按钮不可用、弹窗不发起任何网络请求。
  // 与 dictDefaultSource 分开的原因：用户可能想「留个🌐 以备不时之需」，
  // 但默认仍走离线 —— 这两个诉求不该被一个开关绑死。
  onlineDictEnabled: true,
  bilingual: false,
  // 2026-10-07 对标 Readest 新增的三个字段（默认值必须给，否则面板读到 undefined 会崩）
  bilingualShowSource: true,   // 默认显示原文（关掉后只看译文）
  bilingualEngine: "auto",      // 自动：免费引擎链 → AI 兜底
  bilingualTarget: "zh",
  bilingualStyle: "default",
  translationFontSize: 0.62,
  bilingualPrefetchPages: 2,
  bilingualDebug: false,
  // 2026-08-31 Phase 4：双语「独立设置 Tab」全局默认行为
  bilingualDefaultMode: "ask",
  bilingualSourceLang: "en",
  bilingualProgressiveAuto: true,
  bilingualSkipCached: true,
  bilingualRealtimePreview: true,
  bilingualRetry: true,
  // 2026-08-31 Phase 2：译文归档默认关闭（会在用户思源里建文档，需明确启用）
  translationArchiveEnabled: false,
  translationArchiveDocId: "",
  excerptDocId: "",
  excerptDocTitle: "",
  excerptNotebookId: "",
  bookGraphDocId: "",
  bookGraphDocTitle: "",
  bookGraphNotebookId: "",
  pdfViewMode: "single",
  pdfScrollDir: "vertical",
  pdfInvert: false,
  pdfAnnotHighlight: true,
  pdfAnnotUnderline: true,
  pdfAnnotAnnotate: true,
  text: {
    fontWeight: 400,
    letterSpacing: 0,
    wordSpacing: 0,
  },
  paragraph: {
    paragraphSpacing: 0.8,
    textIndent: 0,
  },
  layout: {
    // 2026-10-07 真机反馈「正文离上下边框太近，看着费劲」：
    //   原 16px（对齐 Readest 的左右边距）被误用成了上下边距。
    //   Readest 的 0.12.12 `DEFAULT_BOOK_LAYOUT` 是 **上下 44 / 左右 16**
    //   （上下本就该比左右宽裕 —— 视线纵向扫行，起止留白决定呼吸感）。
    //   2026-10-07 二次校准：32 → **44**（直接对齐 Readest 的 44）。
    //   32 是在「未知真机观感」时的保守取值，实测后确认仍偏挤：
    //   **分页模式下每页都撑满栏高、行数固定** ⇒ 末行到框线的距离
    //   就等于 marginBottomPx，32px 在缩略图上折合约 3px，肉眼看「几乎没有」。
    //   ⚠️ 老档通过 _migrateMargins 迁移（判定含 16 / 32 / 44 三档）。
    //
    // 2026-10-08 顶栏浮层化后**上边距再降到 24**：
    //   首行距顶从「顶栏占位 36 + 上边距 32 = 68px」变成「只有上边距 32px」——
    //   浮层化本身已经把文字靠近了 36px，但 32 仍偏松。
    //   收到 24 的两个理由：
    //   ① 阅读感：纵向起止的留白决定呼吸感，32 在缩略图上折合约 3px，肉眼看「几乎没有」；
    //   ② 几何：收起态顶栏只剩一个小圆点，其命中区高度被 clamp 到
    //      `min(28, marginTopPx - 4)`（Readest #4977/#5427：触发区压过正文顶边
    //      会吞掉第一行的划词与点击）⇒ 上边距 ≥28px 时圆点恒为满命中区，24 也够用。
    //   ⚠️ 必须与 LAYOUT_PRESETS.normal.top 保持一致（有测试锁住），
    //   否则用户点一下「正常」预设就会把刚调好的上边距打回旧值。
    marginTopPx: 24,
    marginBottomPx: 44,
    marginLeftPx: 16,
    marginRightPx: 16,
    widthPct: 80,
    widthMode: "pct",
    fixedWidthPx: 720,
    columnGapPx: 16,
    columnCount: 1,
    // 2026-10-08 新增：foliate 的栏数上限。默认 2 = foliate 原生 #top 样式里的值，
    // 不改变既有观感；暴露成设置项才能实现「窄列 + 多栏」。
    maxColumnCount: 2,
    showHeader: true,
    showFooter: true,
    showProgress: true,
    progressStyle: "fraction",
    bottomBarMode: "both",
    // 2026-10-08 新增：顶栏浮层化。默认开—— 用户明确要求「上面这个栏也做成悬浮的，
    // 在上面做一个圆点，点击就展开」，且收起时文字更靠近上边框、更有阅读感。
    topBarFloating: true,
    referencePageCount: 0,
    showCurrentTime: false,
    use24Hour: false,
    followSiyuanMargin: false,
    restoreTabsOnLaunch: true,
  },
  note: {
    insertPosition: "doc",
    templatePreset: "simple",
    // 2026-08-29：末行 {{link}} = 回跳原书的深链（siyuan://plugins/…），在思源文档里
    // 点击即打开该书并定位到摘录处。此前该变量恒为空串，模板里等于没有这个功能。
    linkFormat:
      "> {{text}}\n>\n> ——《{{bookTitle}}》{{author}} · {{chapter}}\n\n{{note}}\n\n{{link}}",
    tagPresets: "未分组\n生词\n句法\n文化\n逻辑",
  },
};

/**
 * 字体来源预设（2026-10-07 从四档砍到两档）。
 *
 * ## 为什么砍掉「分类」与「系统默认」
 * 原先四档 `follow-siyuan / custom / system / classified` 并列在一个控件里，
 * 但它们**不是同一维度**：
 *   · 跟随思源 / 自定义 / 系统默认 → 「字体从哪来」（三选一，互斥）
 *   · 分类                      → 「接管之后怎么分工」（衬线/无衬线/等宽各走哪条链）
 * 把两个维度塞进一个 segmented，用户只能靠试错理解，是「设置看不懂」的根因。
 *
 * 现在：来源只有两档，字族分配下沉为「自定义」态下的分组（schema 用 showIf 控制）。
 *
 * - `system`（系统默认 = 不接管字体）已删：与「覆盖书籍字体」开关语义重叠，
 *   且真用到它的用户极少。**字段保留在 ReaderFontMode 类型里不做迁移**，
 *   老设置档里存着 "system" 也不会读出 undefined（执行层已不再消费该值）。
 */
export const FONT_MODE_PRESETS: Record<"follow-siyuan" | "custom", { label: string; hint: string }> = {
  "follow-siyuan": { label: t("跟随思源"), hint: t("使用思源笔记当前的字体（含字体插件/主题）") },
  custom: { label: t("自定义"), hint: t("分别指定衬线 / 无衬线 / 等宽 / 中文四条字体链") },
};

/** 正文默认链（Readest「默认字体」） */
export const DEFAULT_FONT_FAMILY_PRESETS: Record<
  ReaderDefaultFontFamily,
  { label: string; hint: string }
> = {
  serif: { label: t("衬线字体"), hint: t("笔画末端有饰线，长文阅读更省力，适合小说/文学") },
  "sans-serif": { label: t("无衬线字体"), hint: t("笔画均匀简洁，小字号更清晰，适合技术/新闻") },
};

/* ================= 分类字体候选池（2026-08-28，参考 Readest services/constants.ts） =================
 * 排序原则：思源笔记常用字体 → macOS → Windows → 跨平台开源 → 通用兜底。
 * 静态预设覆盖主流场景；未命中的字体浏览器自动跳过，由链尾 CJK 兜底栈接管。
 * 2026-10-14 方案 A：用 document.fonts 动态枚举 + 合并到 Svelte store，下拉自动更新。
 */

/** 衬线链候选池 */
export const SERIF_FONT_PRESETS: string[] = [
  "霞鹜文楷",
  "LXGW WenKai",
  "LXGW WenKai Screen",
  "Songti SC",
  "宋体",
  "SimSun",
  "Source Han Serif CN",
  "Noto Serif CJK SC",
  "Noto Serif SC",
  "Georgia",
  "Times New Roman",
  "Literata",
  "Merriweather",
];

/** 无衬线链候选池 */
export const SANS_SERIF_FONT_PRESETS: string[] = [
  "苹方",
  "PingFang SC",
  "微软雅黑",
  "Microsoft YaHei",
  "思源黑体",
  "Source Han Sans CN",
  "Noto Sans SC",
  "Helvetica",
  "Arial",
  "Roboto",
  "Open Sans",
];

/** 等宽链候选池（代码块 / <pre> / <code> 专用） */
export const MONOSPACE_FONT_PRESETS: string[] = [
  "Fira Code",
  "JetBrains Mono",
  "Source Code Pro",
  "SF Mono",
  "Menlo",
  "Monaco",
  "Consolas",
  "Courier New",
  "Noto Sans Mono CJK SC",
];

/** 中文字体候选池（插入每条链次位，留空则不插入） */
export const CJK_FONT_PRESETS: string[] = [
  "霞鹜文楷",
  "LXGW WenKai",
  "苹方",
  "PingFang SC",
  "微软雅黑",
  "Microsoft YaHei",
  "思源黑体",
  "Source Han Sans CN",
  "Noto Sans SC",
  "Songti SC",
  "宋体",
  "SimSun",
];

/* ================= 动态字体枚举（2026-10-14 方案 A） =================
 * 用户反馈下拉字体太少。根因：以上 4 个数组是硬编码预设，不反映用户已安装的系统字体 /
 * 思源字体插件注入的字体。修复：
 *   1. 用 document.fonts.forEach() 枚举所有已注册 FontFace 的 family 名；
 *   2. 合并到预设数组 + 去重 + 保持预设优先序；
 *   3. 结果写入 Svelte writable store，RowControl.svelte 的 optionsFrom 响应式消费，
 *      下拉自动更新（无需重新渲染整个设置面板）。
 * 调用时机：设置面板 mount 后立即读一次（微任务），再等 document.fonts.ready 后读一次，
 *           并监听 document.fonts loadingdone 事件以覆盖面板打开期间的增量加载。
 */

/**
 * 是否应从动态枚举中剔除的「非阅读字体」（2026-10-14 方案 1）。
 * 思源主文档的 document.fonts 里混着大量 UI 用途字体：图标字体（fcicons / Symbola /
 * Font Awesome / Material Icons…）、emoji 回退字体、KaTeX 数学字体。它们不是正文字体，
 * 出现在阅读字体选择器里既无意义、又把列表撑得过长（原生 select 弹层超长后滚动会卡死）。
 * 这里按族名（去引号、转小写）做前缀/包含匹配过滤。
 */
export function isNonReadingFontFamily(family: string): boolean {
  const f = String(family || "").replace(/^["']|["']$/g, "").trim().toLowerCase();
  if (!f) return true;
  // 数学字体：KaTeX_Main / KaTeX_AMS / STIX...
  if (f.startsWith("katex")) return true;
  // emoji 回退：Apple Color Emoji / Noto Color Emoji / Emojis / Twemoji...
  if (f.includes("emoji")) return true;
  // 图标 / 符号字体
  const iconExact = [
    "fcicons", "symbola", "b-icon", "b3-icons", "iconfont", "feather",
    "lucide", "tabler icons", "phosphor", "remixicon",
  ];
  if (iconExact.includes(f)) return true;
  if (
    f.includes("font awesome") || f.startsWith("fontawesome") ||
    f.includes("material icons") || f.includes("material-icons") ||
    f.includes("material symbols")
  ) return true;
  return false;
}

/** 从 document.fonts 枚举所有已注册字体族名（去重、过滤掉图标/emoji/数学等非阅读字体） */
export function enumerateAvailableFontFamilies(doc?: Document): string[] {
  const d = doc ?? (typeof document !== "undefined" ? document : undefined);
  if (!d) return [];
  const out: string[] = [];
  try {
    const fonts: any = (d as any).fonts;
    if (fonts && typeof fonts.forEach === "function") {
      fonts.forEach((face: any) => {
        const family = face?.family;
        if (family && typeof family === "string" && !out.includes(family) && !isNonReadingFontFamily(family)) {
          out.push(family);
        }
      });
    }
  } catch (__swallowErr) { logSwallow(__swallowErr, "reader-settings.ts · enumerateAvailableFontFamilies", "debug"); }
  return out;
}

/** 将动态枚举结果合并到预设数组：去重 + 保持预设优先序 */
function mergeDynamicWithPresets(presets: string[], dynamic: string[]): string[] {
  const seen = new Set(presets);
  const result = [...presets];
  for (const f of dynamic) {
    if (!seen.has(f)) {
      seen.add(f);
      result.push(f);
    }
  }
  return result;
}

/** 衬线字体下拉选项（Svelte store，初始值=预设，后续动态更新） */
export const serifFontOptions = writable<string[]>([...SERIF_FONT_PRESETS]);

/** 无衬线字体下拉选项（Svelte store） */
export const sansSerifFontOptions = writable<string[]>([...SANS_SERIF_FONT_PRESETS]);

/** 等宽字体下拉选项（Svelte store） */
export const monospaceFontOptions = writable<string[]>([...MONOSPACE_FONT_PRESETS]);

/** 中文字体下拉选项（Svelte store，首项为「自动（跟随书籍）」对应空串 value） */
export const cjkFontOptions = writable<{ value: string; label: string }[]>([
  { value: "", label: t("自动（跟随书籍）") },
  ...CJK_FONT_PRESETS.map((v) => ({ value: v, label: v })),
]);

/** 刷新所有字体下拉选项（合并 document.fonts 动态枚举结果） */
export function refreshFontOptions(doc?: Document): void {
  const dynamic = enumerateAvailableFontFamilies(doc);
  serifFontOptions.set(mergeDynamicWithPresets(SERIF_FONT_PRESETS, dynamic));
  sansSerifFontOptions.set(mergeDynamicWithPresets(SANS_SERIF_FONT_PRESETS, dynamic));
  monospaceFontOptions.set(mergeDynamicWithPresets(MONOSPACE_FONT_PRESETS, dynamic));
  // CJK：首项保留翻译标签，其余合并动态字体
  const cjkPresets = [...CJK_FONT_PRESETS];
  const seen = new Set(cjkPresets);
  for (const f of dynamic) {
    if (!seen.has(f)) { seen.add(f); cjkPresets.push(f); }
  }
  cjkFontOptions.set([
    { value: "", label: t("自动（跟随书籍）") },
    ...cjkPresets.map((v) => ({ value: v, label: v })),
  ]);
}

/** 笔记插入位置选项（设置面板「发送位置」分段控件；2026-10-10 收敛为 2 选 1） */
export const NOTE_INSERT_POSITION_PRESETS: Record<NoteInsertPosition, { label: string; hint: string }> = {
  clipboard: { label: t("剪贴板"), hint: t("复制到剪贴板，手动粘贴") },
  doc: { label: t("指定文档"), hint: t("追加到本书绑定的笔记发送目标文档（与摘录「导出」同一目标）") },
};

/** 笔记模板预设 */
export const NOTE_TEMPLATE_PRESETS: Record<NoteTemplatePreset, { label: string; template: string }> = {
  simple: {
    label: t("简洁"),
    template: "> {{text}}\n\n——《{{bookTitle}}》{{chapter}}",
  },
  heading: {
    label: t("标题+引文"),
    template: "## {{bookTitle}}\n\n> {{text}}\n\n——{{chapter}}\n\n{{note}}",
  },
  quote: {
    label: t("纯引文"),
    template: "> {{text}}\n\n—— 《{{bookTitle}}》 {{author}}",
  },
  custom: {
    label: t("自定义"),
    template: "",
  },
};

/** 进度样式选项 */
export const PROGRESS_STYLE_PRESETS: Record<ReaderProgressStyle, { label: string; hint: string }> = {
  fraction: { label: t("分数"), hint: t("如 5/100") },
  page: { label: t("页码"), hint: t("如 12") },
  percent: { label: t("百分比"), hint: t("如 5%") },
};

/** 底部进度条「程序坞」唤出方式（2026-08-30） */
export const BOTTOM_BAR_MODE_PRESETS: Record<ReaderBottomBarMode, { label: string; hint: string }> = {
  dot: { label: t("小圆点"), hint: t("底部中央常驻小圆点，点击展开进度条") },
  hover: { label: t("悬浮"), hint: t("平时收起，鼠标移至阅读器底部边框才平滑显现") },
  both: { label: t("两者"), hint: t("小圆点常驻 + 悬浮热区都能唤出") },
};

/**
 * 排版预设（2026-08-30）：一行选「紧凑 / 舒适 / 宽松 / 绘本」，一键套用
 * 边距（上下/左右）+ 行距 + 段距 + 字距的组合，免去逐个拖滑块。
 * - compact  紧凑：小边距、小行距，适合手机小屏或想多装字。
 * - comfort  舒适（默认基线）：适中边距行距，通读最舒服。
 * - spacious 宽松：大边距、大行距，适合大屏 / 长时间阅读。
 * - picture  绘本：图文书（儿童绘本 / 画册）友好——边距适中、行距略紧、
 *   段距偏小，让文图更紧凑成块（避免短句被拉太散）。
 */
export const READER_TYPO_PRESETS: Record<
  ReaderTypographyPreset,
  {
    label: string;
    hint: string;
    lineHeight: number;
    letterSpacing: number;
    marginTopPx: number;
    marginBottomPx: number;
    marginLeftPx: number;
    marginRightPx: number;
    paragraphSpacing: number;
  }
> = {
  compact: { label: t("紧凑"), hint: t("小边距小行距，适合手机小屏"), lineHeight: 1.5, letterSpacing: 0, marginTopPx: 8, marginBottomPx: 8, marginLeftPx: 12, marginRightPx: 12, paragraphSpacing: 0.5 },
  comfort: { label: t("舒适"), hint: t("适中边距行距，通读最舒服"), lineHeight: 1.7, letterSpacing: 0.2, marginTopPx: 16, marginBottomPx: 16, marginLeftPx: 18, marginRightPx: 18, paragraphSpacing: 0.8 },
  spacious: { label: t("舒展"), hint: t("大边距大行距，适合大屏长读"), lineHeight: 1.9, letterSpacing: 0.4, marginTopPx: 28, marginBottomPx: 28, marginLeftPx: 30, marginRightPx: 30, paragraphSpacing: 1.2 },
  picture: { label: t("绘本"), hint: t("图文书友好，文图紧凑成块"), lineHeight: 1.55, letterSpacing: 0, marginTopPx: 12, marginBottomPx: 12, marginLeftPx: 14, marginRightPx: 14, paragraphSpacing: 0.6 },
};

/** 8 款预设主题 + 自定义（参考 sireader 色板） */
export const THEME_PRESETS: Record<ReaderTheme, { label: string; bg: string; fg: string; fg2: string }> = {
  light: { label: t("默认"), bg: "#ffffff", fg: "#222222", fg2: "#888888" },
  almond: { label: t("杏仁黄"), bg: "#f5ecdc", fg: "#4a3f2f", fg2: "#8f8370" },
  autumn: { label: t("秋叶褐"), bg: "#f4e8d8", fg: "#5a4632", fg2: "#97856e" },
  green: { label: t("青草绿"), bg: "#eef4e8", fg: "#2e4a2e", fg2: "#6d8468" },
  blue: { label: t("海天蓝"), bg: "#e8f2f8", fg: "#1f3a4d", fg2: "#5f7f92" },
  night: { label: t("夜间"), bg: "#23262e", fg: "#c8ccd4", fg2: "#7d828c" },
  dark: { label: t("暗黑"), bg: "#121212", fg: "#d6d6d6", fg2: "#888888" },
  gold: { label: t("赤金"), bg: "#241c10", fg: "#e6c977", fg2: "#9d8448" },
  custom: { label: t("自定义"), bg: "#ffffff", fg: "#222222", fg2: "#888888" },
};

/** @deprecated 2026-09-29 设置整合：三档行宽 UI 已删；仅 normal 仍被 buildStyles 作为正文 padding 常量使用。 */
export const LINE_WIDTH_PRESETS: Record<ReaderLineWidth, { label: string; padding: string }> = {
  narrow: { label: t("窄"), padding: "2em 3em" },
  normal: { label: t("标准"), padding: "2em 1.5em" },
  wide: { label: t("宽"), padding: "2em 0.6em" },
};

/* ================= 2026-09-25 页面宽度三档预设（用户定稿：铺满 95% / 正常 80% / 宽松 70%） =================
 * 语义从「四边 px 边距」改为「内容宽度占视口百分比」：widthPct 驱动 body 左右 padding =
 * (100-pct)/2 %（随窗口伸缩，见 reader-style.ts layoutMarginStyles）。
 * 点击预设时须同时关掉「跟随思源页边」，否则左右边距会被宿主 padding 覆盖（点击无效的根因）。
 * margins 只保留上/下两边（px）；custom 仅作 UI 态（拖「页面宽度」滑块即进入该态）。
 */
export type ReaderLayoutPreset = "fill" | "normal" | "loose" | "custom";
/**
 * 排版预设（一键套用边距 / 行距 / 段距 / 字距组合）
 *
 * 2026-10-07 边距口径统一为「上下比左右宽」（对标 Readest `DEFAULT_BOOK_LAYOUT`：
 * 上下 44 / 左右 16）。此前「正常」档上下只给 16~20，与左右同量级 ——
 * 真机观感是正文紧贴上下框线，扫行起止没有呼吸感。
 */
export const LAYOUT_PRESETS: Record<
  ReaderLayoutPreset,
  { label: string; widthPct: number; margins: { top: number; right: number; bottom: number; left: number } }
> = {
  // ⚠️ 2026-10-08 校准：这三档的上下边距必须与
  // `READER_DEFAULT_SETTINGS.layout` 保持一致，否则用户点一下预设
  // 就会把刚调好的边距打回旧值。
  //
  //## 真实踩坑（不是预防性担忧，是已发生的 bug）
  // 上一轮把默认下边距从 32 提到 44（对齐 Readest），但 normal 档
  // 仍是 bottom: 36。宿主 `path === "__preset"` 会一次性覆写
  // marginTopPx / marginBottomPx ⇒ **点「正常」预设，44px 被打回 36px**。
  //
  //## 校准后的设计意图
  //  · normal = **出厂默认**（点了等于没动，只把宽度设成 80%）
  //  · fill   = 上下更紧，但仍留呼吸，不贴框线
  //  · loose  = 上下更宽，适合大屏与慢读
  // 「上下 > 上下」的递增关系必须保持 —— 那是用户判断「更宽松」的依据。
  //
  // 有测试锁住「normal.top === 默认 top」与「normal.bottom === 默认 bottom」，
  // 改默认值时会被抓到。
  //
  // ⚠️ 2026-10-08 顶栏浮层化：normal.top 随默认上边距 32 → 24 同步下调，
  //   fill.top 24 → 16（保持 normal > fill 的递增关系，否则「铺满」看起来反而更松）。
  fill: { label: t("铺满"), widthPct: 95, margins: { top: 16, right: 16, bottom: 32, left: 12 } },
  normal: { label: t("正常"), widthPct: 80, margins: { top: 24, right: 24, bottom: 44, left: 20 } },
  loose: { label: t("宽松"), widthPct: 70, margins: { top: 56, right: 56, bottom: 64, left: 48 } },
  // ⚠️ custom 的 margins 全部为 0，但宿主对 custom **不覆写任何字段**
  //（见 ReaderView 的 `path === "__preset"` 分支）——
  // 它的语义是「退出预设接管」，真实值由面板上那6 个滑块决定。
  // 若真按 0 覆写，正文会上下左右全部贴框线（用户反复投诉过的观感）。
  custom: { label: t("自定义"), widthPct: 80, margins: { top: 0, right: 0, bottom: 0, left: 0 } },
};

/** 根据内容宽度百分比反推当前落在哪个预设（都不匹配则「自定义」） */
export function detectLayoutPreset(layout: ReaderLayoutSettings): ReaderLayoutPreset {
  for (const key of ["fill", "normal", "loose"] as ReaderLayoutPreset[]) {
    if (layout.widthPct === LAYOUT_PRESETS[key].widthPct) return key;
  }
  return "custom";
}

export const FLOW_PRESETS: Record<ReaderFlow, { label: string }> = {
  paginated: { label: t("分页") },
  scrolled: { label: t("滚动") },
};

// 2026-10-09：TURN_STYLE_PRESETS 随翻页动画 UI 一并删除。
// 翻页观感固定为 foliate 朴素推移，不再有可选样式，也就没有预设表。

const STORAGE_KEY = "hiword-reader-settings.json";

/**
 * 设置作用域（2026-09-09 P0 设置双分家）：图书阅读器 / PDF 阅读器各一份独立设置。
 * 存储格式 `{ version: 2, book, pdf }`；旧版扁平数据加载时整体归入 book 分片，
 * pdf 分片从默认值起步（pdf 专属字段 pdfViewMode/pdfInvert 等从旧数据继承，不丢偏好）。
 * 未显式指定作用域的调用（插件级全局面板）一律路由到 book（历史主场景）。
 */
export type ReaderSettingsScope = "book" | "pdf";

/** 设置存储鸭子类型（2026-09-09 双分家）：ReaderSettingsStore 本体与 scopeView 返回的
 *  作用域视图共同满足——ReaderView 及子组件以此声明 prop，即插即用两种形态。 */
export interface ReaderSettingsLike {
  get(): ReaderSettings;
  update(patch: Partial<ReaderSettings>): ReaderSettings;
  subscribe(run: (value: ReaderSettings) => void, invalidate?: (value?: ReaderSettings) => void): () => void;
  load(): Promise<void>;
}

export class ReaderSettingsStore {
  /** 双分片：book / pdf 各一份完整设置 */
  private slices: Record<ReaderSettingsScope, ReaderSettings> = {
    book: { ...READER_DEFAULT_SETTINGS },
    pdf: { ...READER_DEFAULT_SETTINGS },
  };
  /** 每个 scope 一个 Svelte store：订阅按 scope 隔离，跨 Tab 同步互不串扰 */
  private _stores: Record<ReaderSettingsScope, Writable<ReaderSettings>> = {
    book: writable<ReaderSettings>({ ...READER_DEFAULT_SETTINGS }),
    pdf: writable<ReaderSettings>({ ...READER_DEFAULT_SETTINGS }),
  };
  private loaded = false;
  private saveTimer: any = null;
  /** 思源插件实例（loadData / saveData）。
   *  2026-08-28：原先这里用的是 TS **参数属性**写法（把 private 修饰符写进
   *  constructor 的参数列表），而 Node 的 strip-only 类型擦除不支持该语法，
   *  一旦有测试文件 import 本模块就会抛 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX 整个崩掉。
   *  改为显式字段 + 构造函数赋值（语义等价，且 strip 兼容）。
   *
   *  ⚠️ 本注释**刻意不复述**上面那种参数属性写法：测试 loader 靠正则判断
   *  「本文件是否用了参数属性」，若注释里出现那段源码文本会被误判为真代码，
   *  改写时把正常的 constructor 一并弄坏（表现为 `this.plugin` 变 undefined，
   *  症状是 load() 静默失败、设置全回默认值，极难定位）。 */
  private plugin: any;

  constructor(plugin: any) {
    this.plugin = plugin;
    // 2026-09-01：注册为全局单例，供非 Svelte 模块读取绑定文档 ID
    _globalSettingsStore = this;
  }

  /** 实现 Svelte store 契约：返回退订函数（支持 `$settingsStore` 自动订阅）。
   *  2026-09-09 双分家：不传 scope 时订阅 book 分片（历史主场景语义）。 */
  subscribe(run: (value: ReaderSettings) => void, invalidate?: (value?: ReaderSettings) => void, scope?: ReaderSettingsScope): () => void {
    return this._stores[scope ?? "book"].subscribe(run, invalidate as any);
  }

  async load(): Promise<void> {
    if (this.loaded) {
      // 已加载：重新推送当前值，唤醒（可能晚于 onMount 才订阅的）组件
      this._push();
      return;
    }
    try {
      const data = await this.plugin.loadData(STORAGE_KEY);
      if (data && typeof data === "object") {
        if ((data as any).book || (data as any).pdf) {
          // 新格式 { version:2, book, pdf }：两个分片各自浅合并 + 子对象逐层合并
          for (const s of ["book", "pdf"] as ReaderSettingsScope[]) {
            const d = (data as any)[s];
            if (d && typeof d === "object") this.slices[s] = this._mergeDefaults(d);
          }
        } else {
          // 旧版扁平格式：整体归入 book 分片；pdf 分片继承 pdf 专属偏好后用默认值
          this.slices.book = this._mergeDefaults(data);
          const d = data as any;
          this.slices.pdf = this._mergeDefaults({
            pdfViewMode: d.pdfViewMode,
            pdfScrollDir: d.pdfScrollDir,
            pdfInvert: d.pdfInvert,
            pdfAnnotHighlight: d.pdfAnnotHighlight,
            pdfAnnotUnderline: d.pdfAnnotUnderline,
            pdfAnnotAnnotate: d.pdfAnnotAnnotate,
          });
        }
      }
    } catch (__swallowErr) { logSwallow(__swallowErr, "reader-settings.ts · load", "debug"); }
    this.loaded = true;
    // 加载完成后推送最新值 → 订阅者（含其它已开 Tab）立即生效
    this._push();
  }

  /**
   * 边距迁移（2026-10-07）。
   *
   * ## 为什么需要
   * 默认上下边距从 16 提到 32（对标 Readest 的「上下 44 / 左右 16」），
   * 但**改默认值只对新档生效** —— 老设置档里已经存着 16，
   * 于是「改了好几天代码、真机依然贴着框线」（本项目已踩过一次）。
   *
   * ## 判定条件（尽量保守）
   * **只看下边距**是否仍为老默认 16：
   * 用户实际存档是「上 36 / 下 16」—— 上边距是他自己拖滑块调的（有意愿），
   * 而下边距还是出厂值（没碰过）。若要求「上下都等于老默认才迁移」，
   * 这种「只调过一边」的最常见情况反而会被跳过，修复等于没做。
   * ⇒ 上边距一律尊重；下边距为 16 时抬到 32。
   * 若用户确实想要 16 的下边距（手动拖回去的），也尊重 —— 他可以再拖一次。
   *
   * ## 为什么不动左右
   * 左右边距从 16 起是 Readest 的口径（本就偏小），用户也没反馈过，不动。
   */
  /**
   * textAlign 迁移（2026-10-07）。
   *
   * ## 背景
   * 该字段此前是**死设置**——执行层硬编码 `text-align: justify`，
   * 设置文件里存的 `false` 从未产生任何效果。
   * 现在真正接上线后，若不迁移，所有老用户（档里都是 false）
   * 升级即观感突变：两端对齐 → 顶格。而这个变化**不是他们要求的**。
   *
   * ## 处理
   * 把「老档里显式存着 false」的，一律视为「无效历史值」迁到 true，
   * 使升级前后观感一致（都是两端对齐）。
   * 用户之后自己关掉开关，存的是 false —— 但那时它已经真生效了，
   * 下次加载时 `=== false` 仍会命中迁移……
   *
   * ⇒ 所以必须靠「是否已经迁过」区分。加显式标记字段做幂等保护。
   */
  private _migrateTextAlign(data: any): void {
    if (!data || typeof data !== "object") return;
    // 幂等标记：本迁移只应执行一次
    if (data.__migratedTextAlign === true) return;
    if (data.textAlign === false) data.textAlign = true;
    data.__migratedTextAlign = true;
  }

  private _migrateMargins(data: any): void {
    // ⚠️ OLD_DEFAULTS 必须**枚举全部历史默认值**，不是只列第一个。
    //   只写 16 的话：已在上一轮迁到 32 的档（本项目实测档就是 32）
    //   判定「32 ∉ {16}」→ 不再迁移 → 永远停在 32，新默认值对它无效。
    //
    // 2026-10-08 顶栏浮层化：上下边距的「历史默认值」各有一份清单，不能共用 ——
    //   上边距：16（初版）→ 32（2026-10-07 二次校准）→ **24（本次，顶栏浮层化后）**
    //   下边距：16（初版）→ **44（2026-10-07 对齐 Readest）**
    // 合并写成一个数组会出事：上边距 44 从来不是合法默认值，若混进去，
    //   一个「下边距被用户手动设成 44」的档会被误判为「上边距还是老默认」而被改掉。
    const OLD_BOTTOM_DEFAULTS = [16, 32];
    const OLD_TOP_DEFAULTS = [16, 32, 44];
    const NEW_BOTTOM_DEFAULT = 44; // 与 READER_DEFAULT_SETTINGS.layout 保持一致
    const NEW_TOP_DEFAULT = 24;    // 同上
    if (!data || typeof data !== "object") return;
    const layout = data.layout;
    if (!layout || typeof layout !== "object") return;
    // ⚠️ 只在「仍等于历史默认值」时才改 —— 用户自己拖过的值一律尊重
    //（这条不能妥协：覆盖用户主动设置是本项目反复消灭的那类缺陷）。
    if (OLD_BOTTOM_DEFAULTS.includes(layout.marginBottomPx)) {
      layout.marginBottomPx = NEW_BOTTOM_DEFAULT;
    }
    if (OLD_TOP_DEFAULTS.includes(layout.marginTopPx)) {
      layout.marginTopPx = NEW_TOP_DEFAULT;
    }
  }

  /** 旧数据 → 补齐默认值（顶层 + text/paragraph/layout/note 子对象逐层合并） */
  private _mergeDefaults(data: any): ReaderSettings {
    this._migrateTheme(data);
    // 2026-10-07：剔除已删除的 `paragraphHover`（段落悬停高亮）。
    // 该机制是为了「适配思源风格」自己加的，Readest 没有；用户反馈
    // 「鼠标停在文字上（没选中）就有一层浅深色背景」指的就是它，已整体删除。
    // 存量设置里若还留着这个键，在此显式删掉，避免每次 load 都带着无用字段
    // （`{...DEFAULTS, ...data}` 的展开会把它带进结果对象）。
    if (data && typeof data === "object" && "paragraphHover" in data) {
      delete data.paragraphHover;
    }
    this._migrateMargins(data);
    this._migrateTextAlign(data);
    return {
      ...READER_DEFAULT_SETTINGS,
      ...data,
      text: { ...READER_DEFAULT_SETTINGS.text, ...(data.text ?? {}) },
      paragraph: { ...READER_DEFAULT_SETTINGS.paragraph, ...(data.paragraph ?? {}) },
      layout: { ...READER_DEFAULT_SETTINGS.layout, ...(data.layout ?? {}) },
      note: { ...READER_DEFAULT_SETTINGS.note, ...(data.note ?? {}) },
    };
  }

  /**
   * 存量设置迁移：拆分 theme → themeMode + theme（2026-10-07）。
   *
   * 旧版本一个 `theme` 字段同时表达「明暗模式」与「配色」，导致：
   *   · `theme: "auto"`        → 明暗=跟随系统，配色=（被思源接管）
   *   · `theme: "light"`       → 明暗=浅色，配色=白底
   *   · `theme: "night"|"dark"|"gold"` → 既是深色配色，也意味着「我要深色」
   *   · `theme: "almond"` 等   → 浅色配色
   *
   * 拆分后目标：
   *   · theme     = 配色（auto → light，即默认白底）
   *   · themeMode = auto（跟随） / dark（强制深色）
   *
   * 判定规则：
   *   - `auto` → themeMode=auto，theme=light（配色回到出厂默认 → 仍跟随思源配色，与旧行为一致）
   *   - 深色配色档 → themeMode=dark，**保留原配色**（用户明确选了这份配色，不能动）
   *   - 其余 → themeMode=auto，保留配色
   *
   * 深色配色那批**不动 theme**，只补 themeMode=dark：这样「夜间配色 + 强制深色」
   * 观感与旧版完全一致，同时其它配色从此不再被明暗设置改写。
   */
  private _migrateTheme(data: any): void {
    if (!data || typeof data !== "object") return;
    const t = data.theme as string | undefined;
    if (t === undefined) return;
    if (data.themeMode !== undefined) return; // 已迁移过（新档）

    if (t === "auto") {
      data.theme = "light";
      data.themeMode = "auto";
      return;
    }
    if (t === "night" || t === "dark" || t === "gold") {
      // 保留配色，只把「深色」这个意图搬到 themeMode
      data.themeMode = "dark";
      return;
    }
    data.themeMode = "auto";
  }

  /** 把两个分片的当前值推给各自的订阅者 */
  private _push(): void {
    for (const s of ["book", "pdf"] as ReaderSettingsScope[]) {
      this._stores[s].set({ ...this.slices[s] });
    }
  }

  get(scope?: ReaderSettingsScope): ReaderSettings {
    return { ...this.slices[scope ?? "book"] };
  }

  /** 更新指定（或默认 book）分片并立即返回新设置；保存防抖 300ms；推送该分片通知订阅者（跨 Tab 同步） */
  update(patch: Partial<ReaderSettings>, scope?: ReaderSettingsScope): ReaderSettings {
    const s = scope ?? "book";
    this.slices[s] = { ...this.slices[s], ...patch };
    this._stores[s].set({ ...this.slices[s] });
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.plugin
        .saveData(STORAGE_KEY, { version: 2, book: this.slices.book, pdf: this.slices.pdf })
        .catch(() => {});
    }, 300);
    return this.get(s);
  }

  /** 双分片作用域视图：duck-typed 与 ReaderSettingsStore 同签名（get/update/subscribe/load），
   *  但读写固定路由到指定 scope——ReaderView 及其子组件零改动即可按 Tab 类型隔离。 */
  scopeView(scope: ReaderSettingsScope): {
    get(): ReaderSettings;
    update(patch: Partial<ReaderSettings>): ReaderSettings;
    subscribe(run: (value: ReaderSettings) => void, invalidate?: (value?: ReaderSettings) => void): () => void;
    load(): Promise<void>;
  } {
    return {
      get: () => this.get(scope),
      update: (patch) => this.update(patch, scope),
      subscribe: (run, invalidate) => this.subscribe(run, invalidate, scope),
      load: () => this.load(),
    };
  }

  /** 数据面板「重置阅读设置」：两个分片一起恢复出厂 */
  resetAll(): void {
    this.update({ ...READER_DEFAULT_SETTINGS }, "book");
    this.update({ ...READER_DEFAULT_SETTINGS }, "pdf");
  }
}
