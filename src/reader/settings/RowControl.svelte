<!--
  行控件工厂（数据驱动）
  ----------------------------------------------------------------
  按 RowDef.ctrl 分发到具体控件。schema 里加一行就多一个控件，
  不必改任何组件。新增控件类型只需在这里加一个分支。
-->
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { get } from "svelte/store";
  import { t } from "../../i18n/index.ts";
  import { getByPath, setByPath, type RowDef } from "./settings-schema.ts";

  /**
   * 控件选项的统一形状（2026-10-07）。
   * 与 schema 的 `RowDef.options` / `asyncOptions` 返回值对齐 ——
   * `bg` / `fg` 只在主题色板（swatches）用得上，但统一写在这里
   * 可以避免三个来源被推成联合类型后模板里访问 `o.bg` 报错。
   */
  interface Option {
    value: string | number;
    label: string;
    /** 色板格底色（仅 swatches 用） */
    bg?: string;
    /** 色板格前景色（仅 swatches 用） */
    fg?: string;
  }

  /** 当前设置对象（顶层 ReaderSettings） */
  export let settings: any = {};
  /** 行定义 */
  export let row: RowDef;
  /** 外部数据（TTS 配置、readerMode 等） */
  export let extra: any = {};
  /** 值变更回调（冒泡给 Tab 组件 → SettingsDialog → 宿主） */
  export let onChange: (path: string, value: any) => void;
  /** 「管理词典」等特殊动作回调 */
  export let onAction: (kind: string) => void = () => {};
  /**
   * 强制显示（2026-10-07，搜索结果视图用）。
   *
   * 搜索结果的语义是「这条参数存在，搜到了」，而不是「它此刻恰好满足 showIf」。
   * 例：搜「中文发音人」时当前引擎是 youdao —— 若按 showIf 隐藏，用户搜到了却
   * 看到一个空结果，等于搜索骗人。故结果视图强制渲染控件，让用户当场改。
   */
  export let forceVisible = false;

  /** 该行是否应显示（showIf 惰性求值） */
  // 2026-10-06 容错：showIf 是调用方写的小函数，schema 里存在
  //   `showIf: (s) => s.defaultFontFamily !== undefined` 这类**未判空**的写法。
  //   一旦 settings 为 null/undefined（宿主初始化时序、异常降级）就会抛
  //   `Cannot read properties of null`，把整棵组件树带崩。
  //   故：① 传入的对象永远兜底为 {}；② showIf 自身抛错时按「不显示」处理，不外溢。
  $: visible = (() => {
    if (forceVisible) return true;
    if (!row.showIf) return true;
    try {
      return !!row.showIf(settings ?? {}, extra ?? {});
    } catch {
      // 条件判定失败宁可先不显示这行，也不要拖垮整个面板
      return false;
    }
  })();

  /**
   * 当前值。
   *
   * ⚠️ 兜底很关键：若 schema 的 path 与真实设置结构不符（曾发生过 `fontWeight`
   * 实际在 `text.fontWeight` 而 schema 写顶层），getByPath 会返回 undefined，
   * 直接渲染进模板会抛
   *   `Uncaught TypeError: Cannot read properties of undefined (reading 'innerHTML')`
   * 导致整个阅读界面崩溃。这里统一给出 undefined 兜底值，缺字段只影响该行显示，
   * 不会拖垮全局。
   *
   * 2026-10-14：tts.* 行取值路由到 extra.tts。
   * TTS 配置不在 settings（那是 ReaderSettings 的 book/pdf 分片），而在宿主透传的
   * extra.tts（ReaderView: extra={{ tts: ttsCfg }}）。早先所有 tts 行都从 settings 取
   * → 永远 undefined：引擎下拉空白、语速/音高/音量滑块显示 0（safeValue 兜底成 0）、
   * 重新打开面板像「设置丢了」。按前缀路由到 extra 即修好（写回仍走 onChange→宿主）。
   */
  $: value = (row.readonlyPath ?? row.path).startsWith("tts.")
    ? getByPath(extra, row.readonlyPath ?? row.path)
    : getByPath(settings, row.readonlyPath ?? row.path);

  /** 控件展示值：数字类缺值时用 0，避免 stepper 渲染出 "undefined" */
  $: safeValue = value === undefined || value === null || Number.isNaN(Number(value)) && typeof value !== "string"
    ? 0
    : value;

  /**
   * 选项归一：静态 options / 从 store 读 / 从数组生成 / 异步选项。
   * 另有「运行时异步选项」通道（`row.asyncOptions`）：系统音色这类只能在
   *   浏览器里枚举的选项（TTS 发音人），schema 阶段拿不到，须挂载后异步取。
   *
   * 分四步：① static options（非空即走）→ ② Svelte store（响应式，值变化自动重算）
   *   → ③ 静态数组 optionsFrom → ④ asyncOpts（初始空数组，{#each} 安全）。
   *   全部用 try/catch 包裹，防止 store 读取失败带崩整棵组件树。
   *   `smoke-settings-crash.test.mjs` 有一条回归断言检查最终 fallback 到 `??` 兜底
   *   （`{#each undefined}` 会抛错，是一类真实崩溃）。
   */
  $: rawOptions = (() => {
    try {
      if ((row.options ?? []).length > 0) return row.options;
      if (row.optionsFrom && typeof row.optionsFrom.subscribe === "function") {
        // Svelte store：读 onMount 订阅维护的 storeValue，值变化时 $: 自动重算
        if (!Array.isArray(storeValue)) return [];
        return storeValue.map((v: any) => (typeof v === "string" ? { value: v, label: v } : v));
      }
      if (Array.isArray(row.optionsFrom)) {
        return row.optionsFrom.map((v: any) => (typeof v === "string" ? { value: v, label: v } : v));
      }
    } catch (__e) {
      // 任何错误都回退到空数组，防止带崩整棵组件树
      void __e;
    }
    return asyncOpts;
  })();

  /**
   * 收窄成统一类型（2026-10-07）。
   *
   * 不收窄的话 TS 会把上面三个来源推成联合类型，模板里访问 `o.bg`
   * （只有主题色板 swatches 用得到）就报
   * 「Property 'bg' does not exist on type '{ value: string; label: string; }'」。
   * 统一成 Option[] 后模板侧不必再做类型体操。
   */
  $: options = rawOptions as Option[];

  /**
   * 2026-10-07：运行时异步选项。
   * 例：TTS「中文/英文发音人」—— 系统音色列表来自 speechSynthesis.getVoices()，
   *   macOS/Electron 首次为空且需等 voiceschanged，只能异步取。
   * 实现约定：schema 给 `asyncOptions: (extra) => Promise<选项[]>`，
   *   本组件在挂载时（以及 extra.tts.engine 变化时）重新拉取。
   */
  let asyncOpts: { value: string; label: string }[] = [];
  /** 拉取序号：只接受最后一次请求的结果，避免竞态覆盖 */
  let asyncSeq = 0;

  /**
   * 2026-10-14：optionsFrom store 的订阅值。
   * Svelte 的 $: 语句无法追踪 get() 调用（get 不是订阅），store 更新后 $: 不会重算。
   * 改为在 onMount 订阅 store，store 推新值时更新本变量，触发 $: 自动重算。
   */
  let storeValue: any[] = [];
  let unsubStore: (() => void) | null = null;

  async function loadAsyncOptions() {
    const fn = row.asyncOptions;
    if (typeof fn !== "function") {
      asyncOpts = [];
      return;
    }
    const seq = ++asyncSeq;
    try {
      const got = await fn(extra ?? {});
      if (seq === asyncSeq && Array.isArray(got)) {
        asyncOpts = got;
      }
    } catch {
      if (seq === asyncSeq) asyncOpts = [];
    }
  }

  onMount(() => {
    void loadAsyncOptions();
    // 2026-10-14：订阅 optionsFrom store，使 refreshFontOptions() 写入新值后下拉能自动刷新
    if (row.optionsFrom && typeof (row.optionsFrom as any).subscribe === "function") {
      unsubStore = (row.optionsFrom as any).subscribe((v: any) => { storeValue = v ?? []; });
    }
  });

  onDestroy(() => {
    unsubStore?.();
    unsubStore = null;
  });

  /** 依赖变化（如 TTS 引擎切换导致可用音色不同）时重新拉取 */
  $: if (row.asyncOptions) {
    // 读这两个值建立响应式依赖；引擎变了音色列表也要变
    void (extra?.tts?.engine ?? "");
    void loadAsyncOptions();
  }

  function emit(v: any) {
    onChange(row.path, v);
  }

  /**
   * 是否只读（2026-10-07）。
   * 只读行仍渲染、值仍可见，但所有写操作被拦下——用于「跟随态展示思源实际字号」
   * 这类「需要看见、但不允许在此改」的行。
   */
  $: ro = row.readonly === true;

  /**
   * 布尔↔可读值的双向转换（2026-10-07，当前只有 fontSizeSync 一处）。
   *
   * 为什么不让 schema 直接把 options 写成 boolean：
   * segmented 的选中判定是 `String(safeValue) === String(o.value)`，
   * 布尔 `true` 会让value="true"/"false" 的选项永远匹配不上（`"true" !== true`
   * 之外的场景也一并出错）。而设置字段存布尔才便于宿主与执行层直接消费。
   * ⇒ UI 层用 "sync"/"custom" 这种人话值，落到字段时转成布尔。
   */
  $: isFontSizeSync = row.transform === "fontSizeSync";

  /** segmented 的实际选中值：跟随态显示 "sync" */
  $: segValue = isFontSizeSync
    ? (safeValue === false ? "custom" : "sync")
    : safeValue;

  /** 点分段按钮：转换后写入 */
  function emitSegment(v: string | number) {
    if (isFontSizeSync) {
      // 手动切档 = 用户表达了意图 → 脱离跟随（方案 A：拖滑块自动转自定义，
      // 这里点分段按钮同理，因为「切到跟随」本身就是要恢复跟随）
      emit(v === "sync");
      return;
    }
    emit(v);
  }

  /**
   * 把浮点误差按 `step` 的小数位数吸附回去。
   *
   *## 为什么需要（真机报障「1.5999999999999999」）
   * IEEE754 双精度无法精确表示 0.1。`1.7 - 0.1 - 0.1` 的实际结果是
   * `1.4999999999999998`，再减就是 `1.3999999999999997`…**误差会随点击次数累积**，
   * 于是面板上显示出十几个小数的「行间距」。
   *
   * ## 为什么不能沿用「step >= 1 才取整」的原写法
   * 原来的 `if (row.step && row.step >= 1) n = Math.round(n)` 只覆盖整数步长，
   * 而本项目大量用小数步长：`lineHeight` / `paragraphSpacing` / `textIndent` = 0.1，
   * `letterSpacing` / `wordSpacing` = 0.5，`tts.volume` = 0.05。
   * 这些全部走了「不取整」分支 ⇒ 全部是浮点风险行。
   *
   *## 正确做法：按 step 的小数位数定点化
   * `1.4999999999999998` 在 step=0.1（即1 位小数）的语义下就是 **1.5**，
   * 不该去修它「真的」是1.4999999999999998 —— 用户拖滑块时心里想的粒度就是 0.1。
   * 所以：`Math.round(v * 10^d) / 10^d`，d = step 的小数位数。
   * `tts.volume` 的 step=0.05 有2 位小数也能正确处理。
   *
   * ⚠️ 不用 `toFixed` 直接转字符串：它对超出 21 位有效数字会退化成科学计数法。
   */
  function snapToStep(v: number): number {
    const step = Number(row.step);
    if (!step || step >= 1) return Math.round(v);
    const decimals = (String(step).split(".")[1] || "").length;
    if (!decimals) return Math.round(v);
    // 先放大到整数域再除回去，避开 0.1+0.2 这类表示误差
    const f = Math.pow(10, decimals);
    return Math.round(v * f) / f;
  }

  /** 数字输入的边界钳制 + 步长吸附 */
  function clampNum(v: number): number {
    let n = Number(v);
    if (Number.isNaN(n)) return v;
    if (row.min != null) n = Math.max(row.min, n);
    if (row.max != null) n = Math.min(row.max, n);
    // ⚠️ 不能只对 step>=1 取整 —— 小数步长（0.1 / 0.5 / 0.05）同样需要吸附，
    //否则「1.7 减两次 0.1」会存成 1.4999999999999998 并原样显示给用户。
    n = snapToStep(n);
    return n;
  }

  function stepBy(delta: number) {
    // 先吸附再相加：1.5 + 0.1 = 1.6 本身是精确的，但1.4+0.1 = 1.5000000000000002
    //   —— 加法之后必须再吸附一次，误差才不会留在结果里。
    const base = snapToStep(Number(value) || 0);
    emit(clampNum(base + delta * (row.step ?? 1)));
  }

  /** 滑块百分比（用于 CSS 轨道填充） */
  $: sliderBase = value ?? 0;
  $: sliderPct =
    row.min != null && row.max != null && row.max > row.min
      ? Math.max(0, Math.min(100, ((Number(sliderBase) - row.min) / (row.max - row.min)) * 100))
      : 0;

  /** marginPair 变换：上下边距合一行时，label 显示当前上边距值，作用于 top */
  $: isMarginPair = row.transform === "marginPair";
  $: marginBottom = isMarginPair ? (getByPath(settings, "layout.marginBottomPx") ?? 0) : 0;
  $: displayValue = isMarginPair
    ? (getByPath(settings, row.readonlyPath ?? row.path) ?? 0)
    : (value ?? 0);

  /**
   * marginPair 的下边距值（2026-10-08 加吸附）。
   * 边距是整数 px（step=4），这里主要是**防御性**：
   * 万一将来把 marginPair 复用到小数步长的字段上，不会又冒出长小数。
   */
  $: marginBottomShown =
    typeof marginBottom === "number" && Number.isFinite(marginBottom) && row.step
      ? snapToStep(marginBottom)
      : marginBottom;

  /** 百分比显示（TTS 音量 0-1 → 0-100） */
  $: shownValue =
    row.path === "tts.volume" ? Math.round((Number(safeValue) || 0) * 100) : displayValue;

  /**
   * 真正渲染到界面上的数值（2026-10-08）。
   *
   * ## 为什么显示层还要再吸附一次
   * `clampNum` 只管**新写入**的值，但**存量设置档里可能已经有脏数据** ——
   * 用户在修复前点过几次 ±，档里存的就是 `1.4999999999999998`。
   * 那一档要等到用户再次点 ± 才会被 `snapToStep` 纠正，在此之前界面会一直显示长小数。
   *
   * ⇒ 显示层无条件吸附一次。这是「最后一道防线」：
   * 无论数据从哪来（存储 / 迁移 / 外部写入），界面都不该出现十几个小数。
   *
   * 纯整数步长的行不受影响（`snapToStep` 对 step>=1 就是 `Math.round`）。
   * 非数字值（枚举字符串如 tts 音色）原样返回。
   */
  $: displaySafe =
    typeof shownValue === "number" && Number.isFinite(shownValue) && row.step
      ? snapToStep(shownValue)
      : shownValue;
</script>

{#if visible}
  <div class="rw-row" class:rw-row-pair={isMarginPair} class:rw-row-readonly={ro}>
    <div class="rw-label">
      <span class="rw-label-text">{row.label}</span>
      {#if row.hint}
        <span class="rw-hint">{row.hint}</span>
      {/if}
    </div>

    <div class="rw-control">
      {#if row.ctrl === "switch"}
        <label class="rw-switch">
          <input
            type="checkbox"
            checked={safeValue !== false}
            disabled={ro}
            on:change={(e) => emit(e.currentTarget.checked)}
          />
          <span class="rw-switch-track"><span class="rw-switch-thumb"></span></span>
        </label>

      {:else if row.ctrl === "slider"}
        <!-- 2026-10-08：marginPair 模式下给两个滑块各加「上 / 下」小标签。
             此前一行塞两个滑块却只有「上下边距」一个 label，
             用户分不清哪个管上、哪个管下（marginPair 的第一个滑块作用于 top）。 -->
        <div class="rw-slider-wrap" class:rw-slider-paired={isMarginPair}>
          {#if isMarginPair}<span class="rw-slider-tag">上</span>{/if}
          <input
            type="range"
            min={row.min}
            max={row.max}
            step={row.step ?? 1}
            value={displayValue}
            disabled={ro}
            style={`--rw-pct:${sliderPct}%`}
            on:input={(e) => emit(clampNum(Number(e.currentTarget.value)))}
          />
          <!-- ⚠️ 2026-10-08：显示走 displaySafe（已按 step 吸附）。
               行间距/段间距这些 step<1 的行，存量脏数据会在这里暴露出长小数。 -->
          <span class="rw-value">{displaySafe}{row.unit ?? ""}</span>
        </div>

      {:else if row.ctrl === "stepper"}
        <div class="rw-stepper">
          <button type="button" aria-label="−" disabled={ro} on:click={() => stepBy(-1)}>−</button>
          <span class="rw-stepper-value">
            {displaySafe}{row.unit ?? ""}
          </span>
          <button type="button" aria-label="＋" disabled={ro} on:click={() => stepBy(1)}>＋</button>
        </div>
        {#if isMarginPair}
          <!-- 上下边距合一行：第二个滑块紧跟其后，共用同一控制区 -->
          <div class="rw-slider-wrap rw-slider-sub">
            <span class="rw-slider-tag">下</span>
            <input
              type="range"
              min={row.min}
              max={row.max}
              step={row.step ?? 1}
              value={marginBottom}
              on:input={(e) => onChange("layout.marginBottomPx", clampNum(Number(e.currentTarget.value)))}
            />
            <span class="rw-value">{marginBottomShown}{row.unit ?? ""}</span>
          </div>
        {/if}

      {:else if row.ctrl === "select"}
        <select
          class="rw-select"
          value={String(safeValue ?? "")}
          on:change={(e) => emit(e.currentTarget.value)}
        >
          {#each options as o}
            <option value={String(o.value)}>{o.label}</option>
          {/each}
        </select>

      {:else if row.ctrl === "segmented"}
        <div class="rw-segmented">
          {#each options as o}
            <button
              type="button"
              class:on={String(segValue) === String(o.value)}
              disabled={ro}
              on:click={() => emitSegment(o.value)}
            >{o.label}</button>
          {/each}
        </div>

      {:else if row.ctrl === "chips"}
        <!-- 胶囊标签：与 segmented 同为单选，但容器可换行、按钮按内容宽度，
             适合「睡眠定时 关/15/30/45/60」这类值多、文字短的档位。 -->
        <div class="rw-chips">
          {#each options as o}
            <button
              type="button"
              class:on={String(safeValue) === String(o.value)}
              disabled={ro}
              on:click={() => emit(o.value)}
            >{o.label}</button>
          {/each}
        </div>

      {:else if row.ctrl === "color"}
        <div class="rw-color">
          <input
            type="color"
            value={safeValue || "#ffffff"}
            on:input={(e) => emit(e.currentTarget.value)}
          />
          <span class="rw-color-hex">{safeValue || ""}</span>
        </div>

      {:else if row.ctrl === "colorRow"}
        <!-- 取色器 + 快速色块（对齐 Readest 的 TTS 高亮颜色） -->
        <div class="rw-color-row">
          <div class="rw-color">
            <input
              type="color"
              value={safeValue || "#ffe082"}
              on:input={(e) => emit(e.currentTarget.value)}
            />
          </div>
          <div class="rw-quick-colors">
            {#each ["#ffe082", "#facc15", "#22c55e", "#06b6d4", "#ec4899", "#8b5cf6"] as c}
              <button
                type="button"
                class:on={safeValue === c}
                style={`background:${c}`}
                aria-label={c}
                on:click={() => emit(c)}
              ></button>
            {/each}
          </div>
        </div>

      {:else if row.ctrl === "swatches"}
        <!--
          主题色板宫格（对齐 Readest：3 列 × N 行，每格 Aa + 名称，末格自定义）
          · 每格用该档**真实的 bg/fg** 上色，而不是统一底色 —— 用户能「看见」配色本身，
            这是 Readest 色板的关键设计（挑颜色时看的是颜色，不是文字）。
          · auto 档（跟随思源）底色会随思源主题变，用 CSS 变量取当前思源背景/前景。
          · custom 档显示用户当前取色结果；未取色时回退中性灰。
        -->
        <div class="rw-swatches" class:cols-4={options.length > 9}>
          {#each options as o}
            <!-- custom 档的底色是「用户当前取色结果」，schema 只能给静态兜底，
                 故在此按 settings.customBg / customFg 动态取真实值。 -->
            {@const swBg = o.value === "custom"
              ? (getByPath(settings, "customBg") || "#ffffff")
              : o.value === "auto"
                ? "var(--b3-theme-background,#fff)"
                : o.bg}
            {@const swFg = o.value === "custom"
              ? (getByPath(settings, "customFg") || "#222222")
              : o.value === "auto"
                ? "var(--b3-theme-on-background,#222)"
                : o.fg || o.bg}
            <button
              type="button"
              class:on={safeValue === o.value}
              class:custom={o.value === "custom"}
              title={o.label}
              style={swBg ? `--sw-bg:${swBg};--sw-fg:${swFg}` : ""}
              on:click={() => emit(o.value)}
            >
              <span class="rw-swatch-aa">Aa</span>
              <span class="rw-swatch-label">{o.label}</span>
            </button>
          {/each}
        </div>

      {:else if row.ctrl === "entry"}
        <div class="rw-entry">
          <input
            type="text"
            value={safeValue ?? ""}
            placeholder={row.label}
            on:change={(e) => emit(e.currentTarget.value)}
          />
        </div>

      {:else if row.ctrl === "action"}
        <!--
          入口按钮（2026-10-07）：不落值，只派发动作。
          词典管理用它替代了原先的 entry —— 词典的「值」由 DictManager 持有，
          给个文本框既无处可写、又让人误以为要填什么。

          2026-10-09：新增 `row.displayValue` ——
          只在按钮左侧显示一段**只读**文字（当前绑的是哪篇文档/ 字体 / 词典）。
          改造前按钮只有「打开」两个字，用户点进去之前无从判断"是不是这里"；
          尤其 per-book 发送目标这种"每本书不同"的东西，不显示就完全不可见。
          ⚠️ 刻意不给文本框：值由各自的二级页持有，这里是**镜像**不是编辑器。
        -->
        <div class="rw-action-wrap">
          {#if row.displayValue}
            <span class="rw-action-current" class:empty={!row.displayValueSet}>
              {row.displayValue}
            </span>
          {/if}
          <button
            type="button"
            class="rw-entry-go rw-action"
            on:click={() => onAction(row.action || "dictManager")}
          >
            {row.actionLabel || t("打开")}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}
