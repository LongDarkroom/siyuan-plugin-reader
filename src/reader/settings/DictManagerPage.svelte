<!--
  词典管理 · 二级页内容（Readest 风格「同一弹窗内二级页」）
  ----------------------------------------------------------------
  决策 G 的落地界面：仓库与发版包不含 77 MB 词典实包，用户在此自助导入。

  形态说明（2026-10-07 改造）：
    此前是**独立叠加弹窗**（自带 backdrop + 标题栏 + 底部条），叠在设置弹窗之上。
    两个全屏遮罩同屏 → 用户只能看到最上面那个、且点任意空白都会「关掉一层」，
    体验与 Readest 的「设置内二级页」不一致。
    现改为**纯内容面板**：外壳（顶部返回条 / 底部按钮 / 遮罩）由 SettingsDialog 统一提供，
    本组件只负责「列表 + 拖拽导入 + 偏好设置」。

  职责边界：
  - 只管「界面 + 用户操作」，落盘/加载交给 DictManager
  - 通过 `dictManager` prop 拿管理器实例（宿主注入），自己不 new
-->
<script lang="ts">
  import { createEventDispatcher, onMount } from "svelte";
  import { t } from "../../i18n/index.ts";
  import { getLogger } from "../../core/logger.ts";

  /** DictManager 实例（宿主注入；缺失时降级为只读提示） */
  export let dictManager: any = null;

  const dispatch = createEventDispatcher();

  /** 已安装词典列表 */
  let dicts: any[] = [];
  /**
   * 已启用的词典 id 集合（2026-10-07 起为**复数**）。
   *
   * 此前这里只有一个 `activeId`（单数字符串），界面据此判「谁是当前启用的」，
   * 于是「启用一本 → 另一本被连带卸载 → 看起来像只能开一本」。
   * 现在启用态直接读清单的 `actives` 数组，与 DictManager 的语义对齐。
   */
  let actives: string[] = [];
  /** 默认词典 id（同语种内唯一；`actives` 中优先被查询的那本） */
  let activeId = "";
  /** 正在导入（显示进度态） */
  let importing = false;
  /** 拖拽悬停高亮 */
  let dragOver = false;
  /** 提示信息 */
  let tip = "";
  /** 提示是否为错误（决定配色） */
  let tipIsErr = false;
  /** 隐藏的文件选择 input */
  let fileInput: HTMLInputElement | null = null;
  /**
   * 词典偏好（对标 Readest 词典页的「外观 / 发音」）。
   * 数据落在 DictManager.manifest（词典是全局资源，不进reader-settings 分片）。
   */
  let fontScale = 1.0;
  let autoSpeak = false;

  /** 从管理器拉取最新列表 + 偏好 */
  async function refresh() {
    if (!dictManager) return;
    try {
      const m = dictManager.list?.();
      dicts = Array.isArray(m?.dicts) ? m.dicts : [];
      actives = Array.isArray(m?.actives) ? m.actives : [];
      activeId = m?.active || "";
      const p = dictManager.prefs?.();
      if (p && typeof p === "object") {
        fontScale = typeof p.fontScale === "number" ? p.fontScale : 1.0;
        autoSpeak = p.autoSpeak === true;
      }
    } catch (e) {
      getLogger().warn("[RE 阅读器] 读取词典列表失败", { error: e });
      dicts = [];
      actives = [];
    }
  }

  onMount(() => {
    void refresh();
  });

  /** 该词典是否已启用（即该组的开关是否打开） */
  function isOn(id: string): boolean {
    if (typeof dictManager?.isActive === "function") return dictManager.isActive(id);
    return actives.includes(id);
  }

  /**
   * 按语种分组（2026-10-07，方案 B：每语种限一本）。
   *
   * 分组顺序固定为「英文 → 中文 → 成语」，不按数量或名称排——
   * 用户每次打开看到的分组位置必须一致，否则找词典要来回扫。
   */
  $: groupsByLang = (() => {
    const buckets = [
      { key: "en", title: t("英文词典"), items: [] as any[] },
      { key: "zh", title: t("中文词典"), items: [] as any[] },
      { key: "idiom", title: t("成语词典"), items: [] as any[] },
    ];
    for (const d of dicts) {
      const key = d?.lang === "zh" ? "zh" : d?.lang === "idiom" ? "idiom" : "en";
      buckets.find((b) => b.key === key)!.items.push(d);
    }
    return buckets;
  })();

  function say(msg: string, isErr = false) {
    tip = msg;
    tipIsErr = isErr;
    // 3 秒后自动淡出提示（不清空，让用户能复制）
    setTimeout(() => {
      if (tip === msg) tip = "";
    }, 3200);
  }

  /** 写词典偏好（字号 / 自动发音），落盘由 DictManager 负责 */
  async function setPrefs(patch: { fontScale?: number; autoSpeak?: boolean }) {
    if (!dictManager?.setPrefs) return;
    try {
      await dictManager.setPrefs(patch);
      await refresh();
      dispatch("changed", { prefs: true });
    } catch (e: any) {
      say(e?.message || t("保存失败"), true);
    }
  }

  function bumpFontScale(delta: number) {
    // 0.05 步进，与 Readest 的字号倍率手感一致；范围由 DictManager 夹取
    const next = Math.round((fontScale + delta) * 100) / 100;
    if (next === fontScale) return;
    void setPrefs({ fontScale: next });
  }

  function toggleAutoSpeak() {
    void setPrefs({ autoSpeak: !autoSpeak });
  }

  /**
   * 导入词典文件（支持多选）。
   *
   * MDX 词典常配一个同名 `.mdd` 资源包（词条里的图片 / CSS / 音频）。
   * 两种导入方式都支持：
   *   ① 同时选中 `x.mdx` + `x.mdd` → 自动配对
   *   ② 只选 `x.mdx`（.mdd 已在 dict/ 目录）→ 按同名自动推断
   */
  async function doImport(files: File[]) {
    if (!dictManager) {
      say(t("词典管理器未就绪，请重启思源后再试"), true);
      return;
    }
    if (!files.length) return;
    importing = true;
    try {
      // 先把 .mdd 挑出来与同名 .mdx 配对
      const mddByStem = new Map<string, File>();
      for (const f of files) {
        if (/\.mdd$/i.test(f.name)) mddByStem.set(f.name.replace(/\.mdd$/i, "").toLowerCase(), f);
      }
      const mdxFiles = files.filter((f) => /\.mdx$/i.test(f.name));
      // 只拖了 .mdd 没拖 .mdx：仍按「资源包」尝试（DictManager 会转同名 .mdx）
      const targets = mdxFiles.length ? mdxFiles : files.filter((f) => /\.mdd$/i.test(f.name));

      if (!targets.length) {
        say(t("只支持 .mdx 词典包（可搭配同名 .mdd 资源包）"), true);
        return;
      }

      let ok = 0;
      const errs: string[] = [];
      for (const f of targets) {
        try {
          const buf = await f.arrayBuffer();
          const stem = f.name.replace(/\.(mdx|mdd)$/i, "").toLowerCase();
          const mdd = mddByStem.get(stem);
          const meta = await dictManager.importDictFile(f.name, buf, {
            ...(mdd ? { mddFile: mdd.name, mddBytes: await mdd.arrayBuffer() } : {}),
          });
          ok++;
          say(
            t("已导入「{name}」").replace("{name}", meta?.name || f.name) +
              (meta?.mdd ? t("（含资源包 {mdd}）").replace("{mdd}", meta.mdd) : ""),
          );
        } catch (e: any) {
          errs.push(`${f.name}：${e?.message || t("导入失败")}`);
        }
      }
      await refresh();
      if (ok) dispatch("changed", {});
      if (errs.length) {
        getLogger().error("[RE 阅读器] 部分词典导入失败", { error: errs.join("; ") });
        if (!ok) say(errs[0], true);
        else {
          say(
            t("成功 {ok} 个，{bad} 个失败：{msg}")
              .replace("{ok}", String(ok))
              .replace("{bad}", String(errs.length))
              .replace("{msg}", errs[0]),
            true,
          );
        }
      }
    } catch (e: any) {
      getLogger().error("[RE 阅读器] 导入词典失败", { error: e });
      say(e?.message || t("导入失败"), true);
    } finally {
      importing = false;
    }
  }

  /** 选择文件（点「选择词典文件」） */
  function pickFile() {
    try {
      fileInput?.click();
    } catch (e) {
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

  /**
   * 开关切换（2026-10-07 方案 B：每语种限一本）。
   *
   * 每组一个开关，打开新的会自动关掉同语种原来那本 —— 这正是
   * 「常驻一本英文 + 一本中文」的操作模型：每组的状态一目了然，
   * 不需要理解「启用集合 / 默认词典」这套两级概念。
   *
   * 失败时必须 refresh 把界面拉回来：DictManager 侧「加载失败不动清单」，
   * 若这里不刷新，开关会停在用户点的位置而实际没生效 ——
   * 典型的「界面变了、行为没变」。
   */
  async function toggle(d: any) {
    if (!dictManager) return;
    const id = d.id;
    const turningOn = !isOn(id);
    // 关掉整组里原来那本，提前取名用于提示
    const group = d?.lang === "zh" ? "zh" : d?.lang === "idiom" ? "idiom" : "en";
    const prevOn = turningOn
      ? dicts.find((x) => x.id !== id && (x?.lang === "zh" ? "zh" : x?.lang === "idiom" ? "idiom" : "en") === group && isOn(x.id))
      : null;

    try {
      const ok = turningOn ? await dictManager.enable(id) : (await dictManager.disable(id), true);
      await refresh();
      if (!ok) {
        say(t("词典加载失败，已保持原设置"), true);
        return;
      }
      if (turningOn) {
        say(
          prevOn
            ? t("已启用「{name}」，同组的「{old}」已自动停用")
                .replace("{name}", d.name || d.file)
                .replace("{old}", prevOn.name || prevOn.file)
            : t("已启用「{name}」").replace("{name}", d.name || d.file),
        );
      } else {
        say(t("已停用「{name}」").replace("{name}", d.name || d.file));
      }
      dispatch("changed", { id });
    } catch (e: any) {
      await refresh();
      say(e?.message || t("操作失败"), true);
    }
  }

  /**
   * 切换语种（2026-10-07 新增）。
   *
   * 导入时只能按文件名正则猜（英汉词典会被猜成 en），猜错必须能在界面上改。
   * 界面只给「中文 / 英文」两个选项（`idiom` 本期不暴露），
   * 点同一个值则取消（传当前值 → DictManager 视为无变化直接返回 false）。
   */
  async function toggleLang(d: any) {
    if (!dictManager || typeof dictManager.setLang !== "function") return;
    const next = d?.lang === "zh" ? "en" : "zh";
    try {
      const ok = await dictManager.setLang(d.id, next);
      await refresh();
      if (ok) {
        say(
          t("「{name}」已归类为{lang}词典").replace("{name}", d.name || d.file).replace("{lang}", langLabel(next)),
        );
        dispatch("changed", { id: d.id });
      }
    } catch (e: any) {
      await refresh();
      say(e?.message || t("修改语种失败"), true);
    }
  }

  async function remove(id: string) {
    if (!dictManager) return;
    const name = dicts.find((d) => d.id === id)?.name || id;
    // 删除词典文件不可撤销，明确二次确认
    if (
      !window.confirm(
        t("确定删除词典「{name}」？\n（只删本插件的清单登记，不会删除你手动放在 dict/ 目录里的文件）").replace(
          "{name}",
          name,
        ),
      )
    ) {
      return;
    }
    try {
      await dictManager.removeDict(id);
      await refresh();
      say(t("已删除「{name}」").replace("{name}", name));
      dispatch("changed", { id });
    } catch (e: any) {
      say(e?.message || t("删除失败"), true);
    }
  }

  /**
   * 语种徽标文案。
   * 2026-10-07：`idiom` 加进来；`auto` 保留（引擎侧支持，清单里暂不产生）。
   */
  function langLabel(lang?: string): string {
    if (lang === "zh") return t("中文");
    if (lang === "en") return t("英文");
    if (lang === "idiom") return t("成语");
    if (lang === "auto") return t("自动");
    return lang || t("未知");
  }

  /**
   * 免费词库来源（2026-10-08）。
   *
   * 三条都是实测可用的公开来源，附许可与体积 —— 让用户不必再去搜来路不明的包。
   * ⚠️ 只给**确实能用**的来源：欧路/ 有道等 App 的导出文件是自有格式，
   *   改名成 .mdx 不会被识别（实测：其文件头是 UTF-16LE 的 `Library_Data…`，
   *   而 mdict 要求 `AD DE` 魔数）。给出错误来源比不给更糟。
   */
  const DICT_SOURCES = [
    {
      id: "ecdict",
      title: t("英汉词典（ECDICT）"),
      meta: t("MIT 许可，约 66 MB（含词形变化与词频）"),
      url: "https://github.com/skywind3000/ECDICT",
    },
    {
      id: "cedict",
      title: t("中英词典（CC-CEDICT）"),
      meta: t("CC-BY-SA许可，约 4 MB"),
      url: "https://www.mdbg.net/chinese/export/cedict/",
    },
    {
      id: "wordlens",
      title: t("英汉词海（Readest 官方 CDN）"),
      meta: t("官方 CDN 托管，19 个语言对，随包更新"),
      url: "https://cdn.readest.com/wordlens/en-zh.json",
    },
  ];

  /**
   * 复制下载链接。
   *
   * ⚠️ 这里刻意**不复用** ReaderView 的 `writeClipboard` ——
   *   那个函数是该组件的内部实现、没有导出；而为了复制一个链接去 import
   *   整个 ReaderView 会造成组件循环依赖。二级页独立实现一份反而更干净。
   *   与 ReaderView 相同的教训：`navigator.clipboard?.writeText()` 的可选链在
   *   非安全上下文下**静默短路**（不抛错、不写盘）⇒ 必须显式判可用性。
   */
  async function copyLink(url: string) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(url);
      say(t("链接已复制"));
    } catch (e) {
      getLogger().warn("[RE 阅读器] 复制下载链接失败", { error: e });
      say(t("复制失败，请手动选中链接"), true);
    }
  }
</script>

<div class="rwd-dict-body">
  {#if !dictManager}
    <p class="rwd-dict-empty">{t("词典管理器未就绪，请重启思源后再试")}</p>
  {:else if !dicts.length}
    <p class="rwd-dict-empty">
      {t("还没有导入词典。支持 .mdx 词典包；词条需要图片时可同时拖入同名 .mdd 资源包。")}
    </p>
  {:else}
    <!--
      按语种分组 + 每组一个开关（2026-10-07 方案 B：每语种限一本）。

      为什么是「开关」而不是「启用/停用」按钮：
      用户要的心智模型是「常驻一本英文 + 一本中文」，即**每组一个开关位**。
      按钮形态（每行一个启用/停用）暗示「每本都能独立开」，
      而同语种其实只能开一本 —— 按钮会让人反复尝试然后发现「开了A 就得关 B」，
      反而困惑。开关把「这一组用哪本」表达成单选，语义与实现一致。
    -->
    {#each groupsByLang as g (g.key)}
      {#if g.items.length}
        {@const onId = g.items.find((d) => isOn(d.id))?.id ?? ""}
        <h4 class="rwd-group-title rwd-dict-group-title">
          {g.title}
          <span class="rwd-dict-group-n">
            {onId ? t("已启用 1 本") : t("未启用")}
          </span>
        </h4>
        <ul class="rwd-dict-list">
          {#each g.items as d (d.id)}
            <li class="rwd-dict-item" class:on={isOn(d.id)}>
              <div class="rwd-dict-info">
                <span class="rwd-dict-name">{d.name || d.file}</span>
                <span class="rwd-dict-tags">
                  {#if d.type === "stardict"}
                    <span class="rwd-dict-tag">SQLite</span>
                  {/if}
                  {#if d.mdd}
                    <span class="rwd-dict-tag">.mdd</span>
                  {/if}
                  <!--
                    语种标签做成可点击：导入时只能按文件名正则猜（英汉词典被猜成 en），
                    猜错必须能就地改。title 说明「点一下切换」。
                  -->
                  <button
                    type="button"
                    class="rwd-dict-tag rwd-dict-tag-lang"
                    title={t("点击切换语种")}
                    on:click={() => toggleLang(d)}
                  >{langLabel(d.lang)}</button>
                </span>
              </div>
              <div class="rwd-dict-ops">
                <!--
                  组内单选开关：打开本本会自动关掉同组原来那本。
                  「删除」放在开关之外 —— 删除是不可逆操作，
                  不该和「切换用哪本」这种高频操作挤在一起。
                -->
                <label class="rw-switch" title={isOn(d.id) ? t("点击停用") : t("点击启用（会停用同组的其它词典）")}>
                  <input
                    type="checkbox"
                    checked={isOn(d.id)}
                    on:change={() => toggle(d)}
                  />
                  <span class="rw-switch-track"><span class="rw-switch-thumb"></span></span>
                </label>
                {#if !d.builtin}
                  <button
                    type="button"
                    class="rwd-dict-btn rwd-dict-btn-danger"
                    on:click={() => remove(d.id)}
                  >
                    {t("删除")}
                  </button>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    {/each}

    <!--
      说明（方案 B）：必须讲清「每种语言只能启用一本」+ 打开会自动切走原来那本，
      否则用户打开开关发现「A 变灰了」会以为出bug。
    -->
    <p class="rwd-dict-note">
      {t("每种语言同时只启用一本词典：打开另一本会自动停用同组的这一本。划词时按词的文字自动选词典（中文查中文词典、英文查英文词典）。")}
    </p>
  {/if}

  <!-- 查词偏好（对标 Readest 词典页的「外观 / 发音」） -->
  <h4 class="rwd-group-title">{t("查词偏好")}</h4>
  <div class="rwd-card">
    <div class="rw-row">
      <div class="rw-label">
        <span class="rw-label-text">{t("释义字号")}</span>
        <span class="rw-hint">{t("仅调整划词查词弹窗，不影响正文排版")}</span>
      </div>
      <div class="rw-stepper">
        <button type="button" aria-label="−" on:click={() => bumpFontScale(-0.05)}>−</button>
        <span class="rw-stepper-value">{Math.round(fontScale * 100)}%</span>
        <button type="button" aria-label="＋" on:click={() => bumpFontScale(0.05)}>＋</button>
      </div>
    </div>
    <div class="rw-row">
      <div class="rw-label">
        <span class="rw-label-text">{t("自动发音")}</span>
        <span class="rw-hint">{t("查词后自动朗读一次（按词的语言判定中/英）")}</span>
      </div>
      <div class="rw-control">
        <label class="rw-switch">
          <input type="checkbox" checked={autoSpeak} on:change={toggleAutoSpeak} />
          <span class="rw-switch-track"><span class="rw-switch-thumb"></span></span>
        </label>
      </div>
    </div>
  </div>

  <!-- 导入区（拖拽 / 点击） -->
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
      <span class="rwd-dict-drop-main">{t("拖入词典文件，或点击选择")}</span>
      <span class="rwd-dict-drop-sub">.mdx（可同时拖入同名 .mdd）</span>
    {/if}
  </div>

  <!--
    下载引导（2026-10-08 新增）。

    为什么要加：导入失败的最常见原因不是代码，而是**用户手里的文件不对**
    —— 本项目实测就踩到过：用户把欧路词典（Eudic）的导出文件改名成 `.mdx`，
    界面显示「导入成功」但永远查不出词。
    旧文案写「请到插件市场下载后在此导入」，但**插件市场里并没有词库**
    （发版包刻意不含词典实包，约 77 MB）⇒ 这句话把人指向了一个不存在的地方。

    下面这三个是实测可用的免费来源，附带许可与体积，避免用户再去搜来路不明的包。
  -->
  <h4 class="rwd-group-title">{t("词典下载")}</h4>
  <div class="rwd-card rwd-dict-sources">
    {#each DICT_SOURCES as src (src.id)}
      <div class="rwd-dict-source">
        <div class="rwd-dict-source-info">
          <span class="rwd-dict-source-name">{src.title}</span>
          <span class="rwd-dict-source-meta">{src.meta}</span>
        </div>
        <div class="rwd-dict-source-ops">
          <button
            type="button"
            class="rwd-dict-btn"
            title={src.url}
            on:click={() => copyLink(src.url)}
          >{t("复制链接")}</button>
        </div>
      </div>
    {/each}
    <p class="rwd-dict-note">
      {t("这些是可用的免费词库来源（下载后在上方导入）。注意：下载的文件必须是 mdict 格式（.mdx），把其它词典 App 的导出文件改名成 .mdx 是无效的。")}
    </p>
  </div>

  <p class="rwd-dict-note">
    {t("词典实包体积较大（几 MB 到几十 MB），发版包不含词典文件。请先从上方来源下载，再在此导入。")}
  </p>

  <span class="rwd-dict-tip" class:err={tipIsErr}>{tip}</span>

  <input
    bind:this={fileInput}
    type="file"
    accept=".mdx,.mdd"
    multiple
    style="display:none"
    on:change={onFileChange}
  />
</div>