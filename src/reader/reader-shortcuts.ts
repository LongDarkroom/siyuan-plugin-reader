/**
 * 阅读器 - 键盘快捷键（注册表 + 冲突检测 + hint overlay 数据源）
 * --------------------------------------------------------------------
 * - 18 项快捷键注册表（←→翻页 / Home/End 跳头尾 / Space 下一段 / Ctrl± 字号 /
 *   Ctrl+F 搜索 / Ctrl+B 书签 / Ctrl+T TTS / Ctrl+S 设置 / Ctrl+Shift+L 主题 /
 *   F11 全屏 / Ctrl ± 0 1 2 3 PDF 缩放 / ? 显隐 hint / Esc 关闭浮窗）
 * - 冲突检测：与思源全局快捷键冲突时跳过（不抢），由 ReaderHint 标注
 * - 跨平台：Mac 用 Cmd，其它用 Ctrl
 * - 注册/注销生命周期：mount 时注册，dispose 时清理（避免热重载泄漏）
 * - 测试：reader-shortcuts.test.mjs（注册表完整性 + 冲突检测 + 键位匹配）
 *
 * 不依赖：annotation / vocab / ai / dict（reader 内部独立）
 */

export type ShortcutAction =
  | "prevPage"
  | "nextPage"
  | "prevSection"
  | "nextSection"
  | "goStart"
  | "goEnd"
  | "fontIncrease"
  | "fontDecrease"
  | "openSearch"
  | "toggleBookmark"
  | "openTTS"
  | "openSettings"
  | "toggleTheme"
  | "toggleFullscreen"
  | "showHint"
  | "closeOverlay"
  // [REword patch 2026-08-29] PDF 缩放（参考 Obsidian PDF++ 风格）
  | "zoomIn"            // Cmd/Ctrl + =    放大到下一档
  | "zoomOut"           // Cmd/Ctrl + -    缩小到上一档
  | "zoomReset"         // Cmd/Ctrl + 0    重置到 fit-page
  | "fitWidth"          // Cmd/Ctrl + 1    适应宽度
  | "fitPage"           // Cmd/Ctrl + 2    适应整页
  | "cycleZoomPreset";  // Cmd/Ctrl + 3    循环切换预设档位（50/75/100/125/150/200%）

export interface ShortcutSpec {
  action: ShortcutAction;
  /** 人类可读标签（hint overlay 用） */
  label: string;
  /** Windows/Linux 修饰键（与 ctrlKey 一起使用） */
  ctrl?: boolean;
  /** Mac 修饰键（与 metaKey 一起使用） */
  cmd?: boolean;
  /** Shift 键 */
  shift?: boolean;
  /** Alt/Option 键 */
  alt?: boolean;
  /** 主键（不区分大小写）；特殊键用 'ArrowLeft' / 'Home' 等 */
  key: string;
  /**
   * 提示面板分组（2026-10-10 新增）。
   *
   * 此前提示面板只能把 18 项拉成一长条列表，实际不可读；按语义分三组后
   * 一眼能扫完。缺省归入「其它」，故新增键位不写也不会漏显示。
   */
  group?: ShortcutGroup;
  /**
   * 该键位是否**真的接线可用**（2026-10-10）。
   *
   * 注册表里有些键是「有意不接」的（如 ⌘T：与思源/浏览器快捷键冲突）。
   * 提示面板据此标注「暂不可用」——避免宣传按了没反应的键。
   * 缺省视为 `true`。
   */
  wired?: boolean;
}

/** 提示面板分组 */
export type ShortcutGroup = "nav" | "view" | "tts" | "other";

/** 完整快捷键注册表（18 项；不含 ?/Esc 因为它们无修饰键，单独处理） */
export const READER_SHORTCUTS: ShortcutSpec[] = [
  { action: "prevPage",       label: "上一页",                key: "ArrowLeft", group: "nav" },
  { action: "nextPage",       label: "下一页",                key: "ArrowRight", group: "nav" },
  // 2026-10-10：↑↓ 语义明确为「翻段/滚动一段」。
  // Readest 同款：滚动模式按视口高滚一段；分页模式也生效（与←→ 同为翻页），
  // 保证两种阅读模式下按上下键都有反馈，不出现「按了没反应」。
  { action: "prevSection",    label: "上一段（连续滚动）",      key: "ArrowUp", group: "nav" },
  { action: "nextSection",    label: "下一段（连续滚动）",      key: "ArrowDown", group: "nav" },
  { action: "goStart",        label: "跳到开头",               key: "Home", group: "nav" },
  { action: "goEnd",          label: "跳到结尾",               key: "End", group: "nav" },
  // 2026-10-10：Space 语义由「下一段」改为「下一页」（用户拍板，与 Readest 一致）。
  // 此前它与 ↑↓ 撞在同一个 action 上，导致注册表里出现两条 key 指向同一动作。
  { action: "nextPage",       label: "下一页（Space）",        key: " ", group: "nav" },
  // PgUp / PgDn：与 ←→ 同义（部分用户习惯用这两个键翻页）
  { action: "prevPage",       label: "上一页（PgUp）",         key: "PageUp", group: "nav" },
  { action: "nextPage",       label: "下一页（PgDn）",         key: "PageDown", group: "nav" },
  { action: "fontIncrease",   label: "字号 +",   ctrl: true, cmd: true,  key: "=", group: "view" },
  { action: "fontDecrease",   label: "字号 -",   ctrl: true, cmd: true,  key: "-", group: "view" },
  { action: "openSearch",     label: "搜索",     ctrl: true, cmd: true,  key: "f", group: "view" },
  { action: "toggleBookmark", label: "添加/移除书签", ctrl: true, cmd: true,  key: "b", group: "view" },
  // ⚠️ openTTS（⌘T）**注册但未接线**（见 onGlobalKey 注释：与思源/浏览器冲突，
  // 前人刻意跳过）。提示面板据`wired: false` 标为「暂不可用」，不宣传假键。
  { action: "openTTS",        label: "TTS 朗读",  ctrl: true, cmd: true,  key: "t", group: "tts", wired: false },
  // 2026-10-10：**刻意不接** Cmd/Ctrl+S（openSettings）。
  // 理由：与思源自身及浏览器「保存」撞车，且用户无法预期阅读器会拦下这个键。
  // 如需打开设置，点顶栏齿轮即可；后续要接也应先做冲突提示。
  { action: "toggleTheme",    label: "切换主题（明/暗）", ctrl: true, cmd: true, shift: true, key: "l", group: "view" },
  { action: "toggleFullscreen", label: "全屏",  key: "F11", group: "view" },
  // [REword patch 2026-08-29] PDF 缩放快捷键（参考 Obsidian PDF++）
  // 注意：fontIncrease / fontDecrease 跟 zoomIn / zoomOut 都用 "=" / "-"，
  // 实际触发哪个由"当前是否在 PDF"决定（ReaderView 内部按格式分流）。
  { action: "zoomIn",         label: "PDF 放大",    ctrl: true, cmd: true,  key: "=", group: "view" },
  { action: "zoomOut",        label: "PDF 缩小",    ctrl: true, cmd: true,  key: "-", group: "view" },
  { action: "zoomReset",      label: "PDF 重置缩放", ctrl: true, cmd: true,  key: "0", group: "view" },
  { action: "fitWidth",       label: "PDF 适应宽度", ctrl: true, cmd: true,  key: "1", group: "view" },
  { action: "fitPage",        label: "PDF 适应整页", ctrl: true, cmd: true,  key: "2", group: "view" },
  { action: "cycleZoomPreset",label: "PDF 切换缩放档位", ctrl: true, cmd: true,  key: "3", group: "view" },
];

/**
 * 提示面板的分组元数据（顺序即展示顺序）。
 *
 * 「tts」组当前**全部未接线**（openTTS 被刻意跳过），面板据`wired:false` 标注
 * 「暂不可用」——宁可告诉用户真相，也不宣传按了没反应的键。
 */
export const HINT_GROUPS: Array<{ key: ShortcutGroup; label: string }> = [
  { key: "nav", label: "翻页与导航" },
  { key: "view", label: "显示与阅读" },
  { key: "tts", label: "朗读" },
  { key: "other", label: "其它" },
];

/** 无修饰键快捷键（独立处理） */
export const NO_MODIFIER_SHORTCUTS: Array<{ action: ShortcutAction; label: string; key: string }> = [
  { action: "showHint",     label: "显示/隐藏快捷键面板",   key: "?" },
  { action: "closeOverlay", label: "关闭浮窗 / 退出全屏",  key: "Escape" },
];

/** 用户自定义覆盖表：action → 部分字段（未给的字段沿用默认） */
export type ShortcutOverride = Partial<
  Pick<ShortcutSpec, "ctrl" | "cmd" | "shift" | "alt" | "key">
>;

/**
 * 合并自定义覆盖与默认表（2026-10-06 快捷键自定义 UI）。
 *
 * 设计要点：**按 action 合并**而非整表替换 —— 用户只改想改的项，
 * 其余动作的默认键位必须原样保留（否则会出现"改一个键崩一堆"的体验）。
 * 未在 `overrides` 里出现的 action 走 `READER_SHORTCUTS` 原值。
 */
export function mergeShortcuts(overrides?: Record<string, ShortcutOverride> | null): ShortcutSpec[] {
  if (!overrides) return READER_SHORTCUTS;
  return READER_SHORTCUTS.map((spec) => {
    const ov = overrides[spec.action];
    if (!ov) return spec;
    const merged: ShortcutSpec = { ...spec };
    // key 必须存在且非空，否则该动作会变成"匹配不到任何键"
    if (typeof ov.key === "string" && ov.key.trim()) merged.key = ov.key.trim();
    // 修饰键允许显式给 false（用于取消某个修饰键），故用 in 判断后逐项赋值
    if ("ctrl" in ov) merged.ctrl = ov.ctrl;
    if ("cmd" in ov) merged.cmd = ov.cmd;
    if ("shift" in ov) merged.shift = ov.shift;
    if ("alt" in ov) merged.alt = ov.alt;
    return merged;
  });
}

/** 把 keydown 事件匹配到 ShortcutAction；无匹配返回 null
 *  @param overrides 用户自定义键位（快捷键设置面板写入）
 */
export function matchShortcut(
  e: KeyboardEvent,
  isMac: boolean,
  overrides?: Record<string, ShortcutOverride> | null,
): ShortcutAction | null {
  // 跳过输入框内（让 input/textarea 正常接收）
  const target = e.target as HTMLElement | null;
  if (target) {
    const tag = target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) {
      return null;
    }
  }

  const table = mergeShortcuts(overrides);

  // 无修饰键（? / Escape）
  if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
    for (const spec of NO_MODIFIER_SHORTCUTS) {
      if (e.key === spec.key) return spec.action;
    }
    // Space / Arrow / Home / End
    for (const spec of table) {
      if (spec.ctrl || spec.cmd || spec.shift) continue;
      if (e.key === spec.key) return spec.action;
    }
    return null;
  }

  // 有修饰键
  for (const spec of table) {
    if (spec.ctrl || spec.cmd) {
      const wantMod = isMac ? e.metaKey : e.ctrlKey;
      if (!wantMod) continue;
      if (isMac && spec.cmd && !e.metaKey) continue;
      if (!isMac && spec.ctrl && !e.ctrlKey) continue;
    } else {
      // 该快捷键无修饰键要求，但当前有修饰键 → 不匹配
      continue;
    }
    if (!!spec.shift !== e.shiftKey) continue;
    if (e.altKey) continue; // 我们的快捷键不用 alt
    if (e.key.toLowerCase() === spec.key.toLowerCase()) return spec.action;
  }
  return null;
}

/** 探测与思源全局快捷键冲突（粗略：以相同 key 组合视为冲突）
 *  spec.ctrl/cmd 表示「Mac/Win 任一侧有修饰键即视为匹配」（双平台共用） */
export function detectConflicts(
  siyuanReserved: Array<{ ctrl?: boolean; cmd?: boolean; shift?: boolean; key: string }>,
  overrides?: Record<string, ShortcutOverride> | null,
): ShortcutSpec[] {
  const conflicts: ShortcutSpec[] = [];
  for (const spec of mergeShortcuts(overrides)) {
    for (const reserved of siyuanReserved) {
      const keyMatch = spec.key.toLowerCase() === reserved.key.toLowerCase();
      if (!keyMatch) continue;
      // spec 的 ctrl/cmd 只要任一与 reserved 匹配 → 视为冲突（双平台共通）
      const modCtrlOk =
        (spec.ctrl && reserved.ctrl) || (spec.cmd && reserved.cmd) ||
        (!spec.ctrl && !spec.cmd && !reserved.ctrl && !reserved.cmd);
      const modShiftOk = !!spec.shift === !!reserved.shift;
      if (modCtrlOk && modShiftOk) {
        conflicts.push(spec);
        break;
      }
    }
  }
  return conflicts;
}

/** 提示面板的一行 */
export interface HintLine {
  keys: string;
  label: string;
  /** 分组键 */
  group: ShortcutGroup;
  /** false = 该键位有意未接线，面板需标灰并注明 */
  wired: boolean;
}

/**
 * 生成提示面板数据（按分组聚合）。
 *
 * @param overrides 用户自定义键位
 * @param isMac     平台（决定 ⌘ / Ctrl 与方向符号的显示方式，见 formatKeys）
 * @param skipUnwired true = 过滤掉未接线的键位（默认保留但标灰，见 HintLine.wired）
 */
export function getHintGroups(
  overrides?: Record<string, ShortcutOverride> | null,
  isMac = false,
  skipUnwired = false,
): Array<{ key: ShortcutGroup; label: string; items: HintLine[] }> {
  const table = mergeShortcuts(overrides);
  const all: HintLine[] = [
    ...table.map((spec) => ({
      keys: formatKeys(spec, isMac),
      label: spec.label,
      group: (spec.group ?? "other") as ShortcutGroup,
      wired: spec.wired !== false,
    })),
    // 无修饰键那组（? / Esc）归入「其它」
    ...NO_MODIFIER_SHORTCUTS.map((spec) => ({
      keys: formatMainKey(spec.key, isMac),
      label: spec.label,
      group: "other" as ShortcutGroup,
      wired: true,
    })),
  ];
  return HINT_GROUPS.map((g) => ({
    ...g,
    items: all.filter((x) => x.group === g.key && (!skipUnwired || x.wired)),
  })).filter((g) => g.items.length > 0);
}

/**
 * 生成扁平 hint 文本（按行）—— 保留旧签名供既有调用方使用。
 *
 * @param overrides 用户自定义键位
 * @param isMac     平台（决定 ⌘ / Ctrl 与方向符号的显示方式，见 formatKeys）
 */
export function getHintLines(
  overrides?: Record<string, ShortcutOverride> | null,
  isMac = false,
): Array<{ keys: string; label: string }> {
  const lines: Array<{ keys: string; label: string }> = [];
  for (const spec of mergeShortcuts(overrides)) {
    lines.push({
      keys: formatKeys(spec, isMac),
      label: spec.label,
    });
  }
  for (const spec of NO_MODIFIER_SHORTCUTS) {
    lines.push({
      keys: formatMainKey(spec.key, isMac),
      label: spec.label,
    });
  }
  return lines;
}

/**
 * 把 spec 格式化成人类可读的键位串（提示面板用）。
 *
 * 🔴 2026-10-10 修正：`formatKeys` 此前**不区分平台**，对 `ctrl:true, cmd:true` 的项
 * 会输出「Ctrl + Cmd + B」—— Mac 上这键根本按不出来（只有 ⌘），Windows 上同理。
 * 现按调用方传入的平台只取该平台实际生效的那个修饰键。
 *
 * @param isMac 决定显示 ⌘ 还是 Ctrl
 */
function formatKeys(spec: ShortcutSpec, isMac = false): string {
  const parts: string[] = [];
  if (spec.ctrl && spec.cmd) {
    // 双平台共用：按当前平台挑一个显示
    parts.push(isMac ? "⌘" : "Ctrl");
  } else if (spec.cmd) {
    parts.push(isMac ? "⌘" : "Cmd");
  } else if (spec.ctrl) {
    parts.push(isMac ? "⌃" : "Ctrl");
  }
  if (spec.alt) parts.push(isMac ? "⌥" : "Alt");
  if (spec.shift) parts.push(isMac ? "⇧" : "Shift");
  parts.push(formatMainKey(spec.key, isMac));
  return parts.join(isMac ? "" : " + ");
}

/** 主键显示：符号键用Mac 记法（←→），空格显式写 Space */
function formatMainKey(key: string, isMac: boolean): string {
  if (key === " " || key === "Space") return "Space";
  if (isMac) {
    const macMap: Record<string, string> = {
      ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓",
      Escape: "Esc", Enter: "↩",
    };
    if (macMap[key]) return macMap[key];
  }
  return key;
}

/** 快捷键控制器：mount 时绑定到 rootEl，dispose 时解绑 */
export class ShortcutController {
  private rootEl: HTMLElement;
  private isMac: boolean;
  private siyuanReserved: Array<{ ctrl?: boolean; cmd?: boolean; shift?: boolean; key: string }>;
  private bound: ((e: KeyboardEvent) => void) | null = null;
  private handlers: Partial<Record<ShortcutAction, () => void | Promise<void>>> = {};
  private conflicts: Set<ShortcutAction> = new Set();
  /** 用户自定义键位（2026-10-06 快捷键设置）；setOverrides 可在运行期替换 */
  private overrides: Record<string, ShortcutOverride> | null = null;

  constructor(
    rootEl: HTMLElement,
    isMac: boolean = false,
    /** 思源全局保留快捷键（如思源内置 Ctrl+F 搜索）；本控制器会跳过这些 */
    siyuanReserved: Array<{ ctrl?: boolean; cmd?: boolean; shift?: boolean; key: string }> = []
  ) {
    this.rootEl = rootEl;
    this.isMac = isMac;
    this.siyuanReserved = siyuanReserved;
    // 探测冲突
    for (const c of detectConflicts(siyuanReserved, this.overrides)) {
      this.conflicts.add(c.action);
    }
  }

  /**
   * 替换自定义键位并**重算冲突**（2026-10-06）。
   * 必须在改键后调用，否则冲突集合仍是旧的 —— 表现为"改完键位，
   * 与思源冲突的那一项仍被静默跳过"，且用户无从得知。
   */
  setOverrides(overrides: Record<string, ShortcutOverride> | null): void {
    this.overrides = overrides && Object.keys(overrides).length ? overrides : null;
    this.conflicts = new Set(detectConflicts(this.siyuanReserved, this.overrides).map((c) => c.action));
  }

  /** 当前生效的键位表（默认值 + 用户覆盖） */
  getTable(): ShortcutSpec[] {
    return mergeShortcuts(this.overrides);
  }

  /** 注册 action 处理器 */
  on(action: ShortcutAction, handler: () => void | Promise<void>): void {
    this.handlers[action] = handler;
  }

  /** 启动监听（rootEl 获得焦点时） */
  start(): void {
    if (this.bound) return;
    this.bound = (e: KeyboardEvent) => this.handleKeydown(e);
    this.rootEl.addEventListener("keydown", this.bound as EventListener);
    // 让 rootEl 可获焦
    if (!this.rootEl.hasAttribute("tabindex")) {
      this.rootEl.setAttribute("tabindex", "-1");
    }
  }

  /** 停止监听 */
  stop(): void {
    if (this.bound && this.rootEl) {
      this.rootEl.removeEventListener("keydown", this.bound as EventListener);
    }
    this.bound = null;
  }

  /** 获取当前所有冲突的 action（hint overlay 标注用） */
  getConflicts(): ShortcutAction[] {
    return Array.from(this.conflicts);
  }

  private handleKeydown(e: KeyboardEvent): void {
    const action = matchShortcut(e, this.isMac, this.overrides);
    if (!action) return;
    if (this.conflicts.has(action)) return; // 与思源冲突，跳过
    const handler = this.handlers[action];
    if (!handler) return;
    e.preventDefault();
    void handler();
  }
}
