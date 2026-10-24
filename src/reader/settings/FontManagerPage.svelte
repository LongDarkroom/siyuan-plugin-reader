<!--
  字体管理 · 二级页内容（Readest 风格「同一弹窗内二级页」）
  ==================================================================
  ## 为什么单独一页

  `fontMode === "custom"` 时用户需要一个「导入 ttf/otf/woff/woff2、选中、删除」
  的地方。把 file input 和一列按钮塞进字体 Tab 会让首屏被低频操作占满，
  且字体列表长度不可控（用户可能导十几本）。Readest 的做法同样是
  `FontPanel` 里一个「Manage Fonts」入口 → 独立子页 `CustomFonts.tsx`。

  ## 形态

  与词典管理页完全同构：**纯内容面板**，外壳（顶部返回条 / 底部条 / 遮罩）
  由 SettingsDialog 统一提供，本组件只管「列表 + 导入 + 选中 + 删除」。

  ## 数据流（与词典页的关键差异）

  词典页的 `DictManager` 是全局资源、数据都在它自己身上，本页可以自己写。
  字体不同：**「选哪本」是 reader-settings 里的 `customFontId`**，
  属于 settings 分片，必须经 `onChange` 冒泡给宿主（ReaderView）落盘，
  否则就是「面板显示选中了、正文字体没变」。
  而「导入 / 删除」是 FontStore 自己的事（它内部已持久化到
  hiword-reader-fonts.json），本页直接调 FontStore 即可。

  ## 边界

  - fontStore 缺失（宿主未注入 / 单测）→ 降级为只读提示，不崩。
  - 删除正被使用的字体 → 由宿主决定回落，本页只负责触发并刷新列表。
-->
<script lang="ts">
  import { createEventDispatcher, onMount } from "svelte";
  import { t } from "../../i18n/index.ts";
  import { getLogger } from "../../core/logger.ts";

  /** FontStore 实例（宿主注入；缺失时降级为只读提示） */
  export let fontStore: any = null;
  /** 宿主 settings（读 customFontId 以标记「使用中」） */
  export let settings: any = {};

  const dispatch = createEventDispatcher();

  /** 已导入字体列表 */
  let fonts: any[] = [];
  /** 正在导入 */
  let importing = false;
  /** 拖拽悬停 */
  let dragOver = false;
  /** 提示（3.2s 自动淡出，不清空以便复制） */
  let tip = "";
  let tipIsErr = false;
  /** 隐藏的文件选择 input */
  let fileInput: HTMLInputElement | null = null;

  /** 当前正在使用的字体 id（settings 里读；容错为 null） */
  $: activeId = (settings && typeof settings === "object" ? settings.customFontId : "") || "";

  /** 字体格式化：ttf/otf/woff/woff2 + 可选字重 + 大小 */
  function metaOf(f: any): string {
    const bits: string[] = [String(f.ext || "").toUpperCase()];
    if (f.weight && Number(f.weight) !== 400) bits.push(`${f.weight}`);
    if (f.style && f.style !== "normal") bits.push(f.style === "italic" ? "斜体" : "倾斜");
    if (f.variable) bits.push("可变");
    return bits.filter(Boolean).join(" · ");
  }

  function fmtSize(n: number): string {
    const kb = Number(n || 0) / 1024;
    return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`;
  }

  async function refresh() {
    if (!fontStore) return;
    try {
      await fontStore.load?.();
      fonts = Array.isArray(fontStore.list) ? fontStore.list : [];
    } catch (e) {
      getLogger().warn("[RE 阅读器] 读取字体列表失败", { error: e });
      fonts = [];
    }
  }

  onMount(() => {
    void refresh();
  });

  function say(msg: string, isErr = false) {
    tip = msg;
    tipIsErr = isErr;
    setTimeout(() => {
      if (tip === msg) tip = "";
    }, 3200);
  }

  /**
   * 选中字体：**只上报，不自己写**。
   * customFontId 存在 reader-settings（按书分片），由宿主写 store 才生效。
   */
  function pick(id: string) {
    if (id === activeId) return;
    dispatch("change", { path: "customFontId", value: id });
    say(t("已切换到「{name}」").replace("{name}", nameOf(id)));
  }

  function nameOf(id: string): string {
    return fonts.find((f) => f.id === id)?.name || id;
  }

  /** 导入（支持多选）。导入完自动选中最后一本 —— 用户刚导完就是想用它。 */
  async function doImport(files: File[]) {
    if (!fontStore?.importFont) {
      say(t("字体管理器未就绪，请重启思源后再试"), true);
      return;
    }
    if (!files.length) return;
    importing = true;
    let lastId = "";
    const errs: string[] = [];
    let ok = 0;
    for (const f of files) {
      try {
        const font = await fontStore.importFont(f);
        ok++;
        lastId = font?.id || lastId;
      } catch (e: any) {
        errs.push(`${f.name}：${e?.message || t("导入失败")}`);
      }
    }
    await refresh();
    importing = false;
    if (ok) {
      say(t("已导入 {n} 个字体").replace("{n}", String(ok)));
      // 自动选中：导入动作的意图几乎总是「我要用这本」
      if (lastId) dispatch("change", { path: "customFontId", value: lastId });
      dispatch("changed", { imported: ok });
    }
    if (errs.length) {
      say(errs[0], true);
      getLogger().error("[RE 阅读器] 部分字体导入失败", { error: errs.join("; ") });
    }
  }

  function pickFile() {
    try {
      fileInput?.click();
    } catch {
      say(t("无法打开文件选择器"), true);
    }
  }

  function onFileChange(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const files = [...(input.files || [])];
    if (files.length) void doImport(files);
    input.value = ""; // 允许重复选同一个文件
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) void doImport(files);
  }

  async function remove(f: any) {
    if (!fontStore?.removeFont) return;
    const wasActive = f.id === activeId;
    if (
      !window.confirm(
        t("确定删除字体「{name}」？\n（同时会删除插件目录下的字体文件，不可撤销）").replace(
          "{name}",
          f.name || f.id,
        ),
      )
    ) {
      return;
    }
    try {
      await fontStore.removeFont(f.id);
      await refresh();
      say(t("已删除「{name}」").replace("{name}", f.name || f.id));
      // 删掉正在用的那本 → 让宿主把 customFontId 清掉（否则正文会继续引用已删文件）
      if (wasActive) dispatch("change", { path: "customFontId", value: "" });
      dispatch("changed", { removed: f.id });
    } catch (e: any) {
      say(e?.message || t("删除失败"), true);
    }
  }
</script>

<div class="rwd-font-body">
  {#if !fontStore}
    <p class="rwd-dict-empty">{t("字体管理器未就绪，请重启思源后再试")}</p>
  {:else}
    {#if !fonts.length}
      <p class="rwd-dict-empty">{t("还没有导入字体。可拖入 ttf / otf / woff / woff2 文件。")}</p>
    {:else}
      <h4 class="rwd-group-title rwd-dict-group-title">
        {t("已导入字体")}
        <span class="rwd-dict-group-n">{t("{n} 个").replace("{n}", String(fonts.length))}</span>
      </h4>
      <ul class="rwd-dict-list">
        {#each fonts as f (f.id)}
          <!--
            选中态 = customFontId 指向本条（settings 是唯一真源，
            不用组件内局部 state —— 否则会出现「界面选了、正文没变」）。
          -->
          <li class="rwd-dict-item" class:on={f.id === activeId}>
            <div class="rwd-dict-info">
              <span class="rwd-dict-name">{f.name || f.id}</span>
              <span class="rwd-dict-tags">
                {#if f.family && f.family !== f.name}
                  <span class="rwd-dict-tag">{f.family}</span>
                {/if}
                <span class="rwd-dict-tag">{metaOf(f)}</span>
                <span class="rwd-dict-tag">{fmtSize(f.size)}</span>
              </span>
            </div>
            <div class="rwd-dict-ops">
              {#if f.id === activeId}
                <span class="rwd-dict-tag rwd-dict-tag-on">{t("使用中")}</span>
              {:else}
                <button type="button" class="rwd-dict-btn" on:click={() => pick(f.id)}>
                  {t("使用")}
                </button>
              {/if}
              <button
                type="button"
                class="rwd-dict-btn rwd-dict-btn-danger"
                on:click={() => remove(f)}
              >
                {t("删除")}
              </button>
            </div>
          </li>
        {/each}
      </ul>
      <p class="rwd-dict-note">
        {t("选中的字体将作为正文主字体；西文字体缺汉字字形时，中文会自动回落到中文字体。")}
      </p>
    {/if}

    <!-- 导入区（拖拽 / 点击），与词典页同构 -->
    <div
      class="rwd-dict-drop"
      class:over={dragOver}
      role="button"
      tabindex="0"
      on:click={pickFile}
      on:keydown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          pickFile();
        }
      }}
      on:dragover={(e) => {
        e.preventDefault();
        dragOver = true;
      }}
      on:dragleave={() => (dragOver = false)}
      on:drop={onDrop}
    >
      {#if importing}
        <span class="rwd-dict-drop-main">{t("正在导入…")}</span>
      {:else}
        <span class="rwd-dict-drop-main">{t("拖入字体文件，或点击选择")}</span>
        <span class="rwd-dict-drop-sub">.ttf / .otf / .woff / .woff2</span>
      {/if}
    </div>
  {/if}

  <span class="rwd-dict-tip" class:err={tipIsErr}>{tip}</span>

  <input
    bind:this={fileInput}
    type="file"
    accept=".ttf,.otf,.woff,.woff2"
    multiple
    style="display:none"
    on:change={onFileChange}
  />
</div>