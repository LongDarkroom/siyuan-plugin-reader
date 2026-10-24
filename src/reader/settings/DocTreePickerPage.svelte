<!--
  文档树选择器（2026-10-10 列表化收敛新建，取代 DocumentPickerPage 的平铺列表）
  ----------------------------------------------------------------
  ## 职责
  把「选一篇文档作为发送目标」做成**树形**而不是平铺列表：
  - 缩进 = 层级（每层 20px），文件夹 ▸/▾ 折叠；
  - 当前绑定显示绿「使用中」、默认目标显示蓝「默认目标」徽标；
  - 搜索按文档名过滤，命中项自动展开其祖先路径并高亮。

  ## 笔记本归属（2026-10-10 修正）
  思源 `blocks.hpath` **不含笔记本名**（笔记本在独立的 `box` 列）——
  旧版把 hpath 第一段当笔记本名导致「选了笔记本照样全量展示」。
  现在 `listDocuments` 返回 `notebookId`（= box），树按真实笔记本分组：
  - 「全部笔记本」：顶层 = 各笔记本分组节点（isNotebook，可折叠），
    其子树 hpath 以 `@<notebookId>` 作前缀键（内部键，不展示），保证跨笔记本不撞 key；
  - 选中具体笔记本：只渲染该笔记本的子树（顶层即它的第一层内容，无额外包装层）。

  ## 双上下文
  - `standalone=false`（默认）：纯内容，作为 SettingsDialog 的 `docTree` 子页渲染，
    由 SettingsDialog 提供返回条；选中经 `dispatch("pick", {...})` / `dispatch("clear")` 冒泡。
  - `standalone=true`：自带浮层壳（挂在 document.body 用），供 dock 右键「笔记发送目标」直接弹。

  ## 数据源
  `listDocuments(limit=5000)` 全量拉取 → 前端切段建树（零新内核 API）。
  文档数超 5000 时搜索仍可用（searchDocuments 独立接口）。
-->
<script lang="ts">
  import { createEventDispatcher, onMount } from "svelte";
  import { t } from "../../i18n/index.ts";
  import { loadDocPickerApi, getDocPickerFailReason } from "./doc-picker-api.ts";
  import type { DocPickerApi, DocPickerDoc } from "./doc-picker-api.ts";
  import { logSwallow } from "../../core/safe.ts";
  import DocTreeBody from "./DocTreeBody.svelte";

  /**
   * 事件派发器（2026-10-10 修复：此前本行被误删，导致页内 5 处 `dispatch(...)`
   * 全部抛 ReferenceError —— 表现为「点文档/文件夹完全没反应」）。
   * ⚠️ 改动本文件时注意：任何 `dispatch(...)` 调用都依赖它，删掉即整页交互失效。
   */
  const dispatch = createEventDispatcher();

  /** 思源 API（可缺省；缺省时降级为粘贴 ID） */
  export let api: DocPickerApi | null = null;
  /** 选择模式：default=设全局默认目标；book=绑定某本书 */
  export let mode: "default" | "book" = "default";
  /** book 模式下当前书的 id（清除用） */
  export let bookId = "";
  /** 当前已选文档 id（高亮「使用中 / 默认目标」） */
  export let activeId = "";
  /**
   * 是否自带浮层壳（dock 用）
   */
  export let standalone = false;
  /** standalone 时浮层标题 */
  export let title = "";

  // ---- standalone 回调 ----
  export let onPick: ((p: { docId: string; docTitle?: string; notebookName?: string } | null) => void) | null = null;
  export let onClose: (() => void) | null = null;

  /**
   * 供宿主（SettingsDialog「确定选择」按钮 / 外部）调用的确认与取消（2026-10-10）。
   *
   * 交互改为「点文档打勾 → 点确定选择才写回」：点文档只改内部 `picked`，
   * 不立刻写回/跳页，让用户看得见选中了哪篇、且能反悔。
   */
  export function confirmPick(): void {
    if (!picked) return;
    const payload = picked;
    if (standalone && onPick) onPick(payload);
    else dispatch("pick", payload);
  }

  /** 取消：放弃本次勾选并返回（不写回）。清除绑定走独立的 clearBinding，不经这里。 */
  export function cancelPick(): void {
    if (standalone && onClose) onClose();
    else dispatch("close");
  }

  interface TreeNode {
    id: string;
    name: string;
    hpath: string;
    notebookName: string;
    isFolder: boolean;
    /** 顶层笔记本分组节点（仅「全部笔记本」视图出现） */
    isNotebook?: boolean;
    docId?: string;
    children: TreeNode[];
  }

  let docs: DocPickerDoc[] = [];
  let notebooks: { id: string; name: string }[] = [];
  /** 当前选中的笔记本（存 **id**，name 仅展示用——重名笔记本也能区分） */
  let selectedNotebook = "";
  let loading = true;
  let loadError = "";
  let keyword = "";
  let expanded: Set<string> = new Set();
  let manualId = "";
  let showManual = false;
  /**
   * 待确认选中的文档（打勾态，2026-10-10）。
   * 点文档只写这里，底部「确定选择」才 dispatch pick 真正写回。
   * 初始 = activeId 对应的那篇（重开时能看出当前绑定），但用户一旦重新点就以点选的为准。
   */
  let picked: { docId: string; docTitle?: string; notebookName?: string } | null = null;

  // ---- 折叠状态记忆（2026-10-10 用户要求：收起后重新打开要恢复，不能全展开） ----
  // 存「当前展开的全集」（绝对状态）而非「折叠增量」：
  // 新增文档/文件夹出现在记忆里没有的键上时默认收起，与首次行为一致。
  const FOLD_KEY = "hiword-reader-doctree-expanded";
  let storedExpanded: Set<string> = loadFolded();

  function loadFolded(): Set<string> {
    try {
      const arr = JSON.parse(localStorage.getItem(FOLD_KEY) || "null");
      return Array.isArray(arr) ? new Set(arr as string[]) : new Set();
    } catch {
      return new Set();
    }
  }

  function persistFolded() {
    try {
      localStorage.setItem(FOLD_KEY, JSON.stringify([...expanded]));
    } catch {
      /* 隐私模式等写不进就降级为不记忆，不影响交互 */
    }
  }

  $: headerTitle = title || (mode === "book" ? t("选择本书的发送目标") : t("选择默认目标"));
  $: highlightId = activeId;
  /** 打勾态：本次待确认选中的文档 id（null = 尚未点选/已点「清除绑定」） */
  $: pickedId = picked?.docId ?? "";
  /**
   * 勾选变化 → 通知宿主（2026-10-10）。
   * 宿主的「确定选择」按钮要按此禁用/启用（没勾选时不该能提交）。
   * 用 dispatch 而非 bind prop，因为父→子才是主流数据流，反向只需一个布尔信号。
   *
   * ⚠️ 用 `pickedId`（上面的派生）而不是直接读 `picked`：Svelte 4 的 reactive
   *   按拓扑序调度，写给pickedId 的块在本块之前跑，读它能保证值已是最新；
   *   若直接读 `picked` 则两条 reactive 都依赖 picked，顺序不保证。
   */
  $: if (pickedId) dispatch("selchange", pickedId);
  /** 展示树：随文档/笔记本/选中项自动重算 */
  $: roots = computeRoots(docs, notebooks, selectedNotebook);
  /**
   * 展开状态（2026-10-10 改为带记忆）。
   *
   * 🔴 这里曾写成 `$: expanded = computeExpanded(roots)` —— **reactive 无条件覆盖
   *   用户交互**，实测点文件夹「我的职业是小说家」后 `expanded` 被立刻重算回旧值，
   *   表现为「点不动」（已用最小复现验证：toggle 后集合回到原样）。
   *
   * 正解：**只在树本身换了引用时**（load 完/ 换笔记本 / 换搜索视图）才重算折叠态，
   * 用户的每次 toggle 都不该被派生逻辑覆盖。用 `lastRootsRef` 记住上一次处理的树。
   */
  $: syncExpandedWithRoots(roots);

  let lastRootsRef: TreeNode[] | null = null;

  function syncExpandedWithRoots(rs: TreeNode[]): void {
    if (rs === lastRootsRef) return; // 同一棵树：不动用户的折叠态
    lastRootsRef = rs;
    // 内部直接读模块级 storedExpanded（此刻不在 reactive 依赖链上，
    // 用闭包读取是安全的 —— 它只在本函数被调用时求值）。
    expanded = computeExpanded(rs, storedExpanded);
  }

  /**
   * 展开态计算：
   * - 有记忆且与当前树有交集 → 按记忆展开/收起（跨开合保持用户的折叠）；
   * - 无记忆，或键全失配（视图切换后另一套键空间）→ 回退默认（顶层 + 第二层）。
   *
   * 参数显式传入 `stored`，而不是闭包读模块级 `storedExpanded`：
   * reactive 的依赖分析只能看见函数**实参**，闭包捕获的变量它看不见。
   */
  function computeExpanded(rs: TreeNode[], stored: Set<string>): Set<string> {
    if (!stored.size) return defaultExpanded(rs);
    const keys = collectFolderKeys(rs);
    const kept = [...stored].filter((k) => keys.has(k));
    if (!kept.length) return defaultExpanded(rs);
    return new Set(kept);
  }

  function collectFolderKeys(rs: TreeNode[]): Set<string> {
    const keys = new Set<string>();
    const walk = (ns: TreeNode[]) => {
      for (const n of ns) {
        if (n.isFolder) keys.add(n.hpath);
        if (n.children.length) walk(n.children);
      }
    };
    walk(rs);
    return keys;
  }

  onMount(load);

  async function load() {
    loading = true;
    loadError = "";
    try {
      const a = api || (await loadDocPickerApi());
      if (!a) {
        const why = getDocPickerFailReason();
        loadError = why
          ? t("思源接口加载失败（{why}），可改用下方「粘贴文档 ID」", { why })
          : t("思源接口未就绪，可改用下方「粘贴文档 ID」");
        docs = [];
        loading = false;
        return;
      }
      const [dl, nbs] = await Promise.all([
        a.listDocuments ? a.listDocuments(5000) : Promise.resolve([] as DocPickerDoc[]),
        a.listNotebooks ? a.listNotebooks() : Promise.resolve([] as { id: string; name: string }[]),
      ]);
      docs = (dl || []).filter((d) => (d.hpath || "").trim());
      notebooks = (nbs || []).filter((n) => n && n.id && n.name);
    } catch (__e) {
      logSwallow(__e, "DocTreePickerPage · load", "warn");
      loadError = __e instanceof Error ? __e.message : t("读取文档列表失败");
    } finally {
      loading = false;
    }
  }

  /**
   * 按 hpath 切段建一棵子树。
   * @param prefix hpath 内部键前缀（分组视图用 `@<notebookId>` 保证跨笔记本唯一；单笔记本视图为空串）
   * @param nbName 该子树归属的笔记本名（写进 pick payload）
   */
  function buildTree(list: DocPickerDoc[], prefix: string, nbName: string): TreeNode[] {
    const root: TreeNode[] = [];
    const map = new Map<string, TreeNode>();
    for (const d of list) {
      const segs = (d.hpath || "").split("/").filter(Boolean);
      if (!segs.length) continue;
      let parentChildren = root;
      let acc = prefix;
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        acc = acc ? acc + "/" + seg : seg;
        const isLast = i === segs.length - 1;
        let node = map.get(acc);
        if (!node) {
          node = {
            id: isLast ? d.id : "__f__" + acc,
            name: seg,
            hpath: "/" + acc,
            notebookName: nbName,
            isFolder: !isLast,
            docId: isLast ? d.id : undefined,
            children: [],
          };
          map.set(acc, node);
          parentChildren.push(node);
        }
        parentChildren = node.children;
      }
    }
    return root;
  }

  /**
   * 计算展示树。
   * - 选中具体笔记本：只渲染该笔记本的子树（顶层 = 它的第一层内容）；
   * - 「全部笔记本」：顶层 = 笔记本分组节点（保持 listNotebooks 的顺序），
   *   box 缺失/笔记本已不在列表的散文档兜底平铺在根部。
   */
  function computeRoots(allDocs: DocPickerDoc[], nbs: { id: string; name: string }[], selId: string): TreeNode[] {
    if (selId) {
      const list = allDocs.filter((d) => (d.notebookId || "") === selId);
      const nbName = nbs.find((n) => n.id === selId)?.name || selId;
      return buildTree(list, "", nbName);
    }
    const byNb = new Map<string, DocPickerDoc[]>();
    for (const d of allDocs) {
      const k = d.notebookId || "";
      const arr = byNb.get(k);
      if (arr) arr.push(d);
      else byNb.set(k, [d]);
    }
    const roots: TreeNode[] = [];
    for (const n of nbs) {
      const list = byNb.get(n.id);
      if (!list || !list.length) continue;
      byNb.delete(n.id);
      roots.push({
        id: "__nb__" + n.id,
        name: n.name,
        hpath: "/@" + n.id,
        notebookName: n.name,
        isFolder: true,
        isNotebook: true,
        children: buildTree(list, "@" + n.id, n.name),
      });
    }
    const rest: DocPickerDoc[] = [];
    for (const list of byNb.values()) rest.push(...list);
    if (rest.length) roots.push(...buildTree(rest, "", ""));
    return roots;
  }

  /** 默认展开：顶层 + 第二层文件夹（与旧版行为一致，视图切换时重置） */
  function defaultExpanded(rs: TreeNode[]): Set<string> {
    const e = new Set<string>();
    for (const n of rs) {
      e.add(n.hpath);
      for (const c of n.children) if (c.isFolder) e.add(c.hpath);
    }
    return e;
  }

  function matchSet(): Set<string> | null {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return null;
    const hit = new Set<string>();
    const collect = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        if (n.name.toLowerCase().includes(kw)) hit.add(n.hpath);
        if (n.children.length) collect(n.children);
      }
    };
    collect(roots);
    for (const h of Array.from(hit)) {
      const parts = h.split("/").filter(Boolean);
      let acc = "";
      for (const p of parts) {
        acc = acc ? acc + "/" + p : p;
        hit.add(acc);
      }
    }
    return hit;
  }

  /**
   * 点文档名：只切换「待确认选中」（打勾），不写回、不跳页（2026-10-10）。
   * 真正的写回由宿主底部「确定选择」→ confirmPick() 触发。
   */
  function pick(node: TreeNode) {
    if (node.isFolder) return;
    picked = { docId: node.docId as string, docTitle: node.name, notebookName: node.notebookName };
  }

  /**
   * 「清除绑定」：带明确标签的独立按钮，点了立即解绑（不需要二次确认）。
   * 不走 confirmPick —— 否则「待清除」与「没选中」在 picked=null 上无法区分。
   */
  function clearBinding() {
    if (standalone && onPick) onPick(null);
    else dispatch("clear");
  }

  function toggle(node: TreeNode) {
    if (!node.isFolder) return;
    const s = new Set(expanded);
    if (s.has(node.hpath)) s.delete(node.hpath);
    else s.add(node.hpath);
    expanded = s;
    // 记忆：同步到持久层，下次打开原样恢复
    storedExpanded = s;
    persistFolded();
  }

  /**
   * 粘贴 ID：与点文档名一致，只填入待确认选中（打勾），由「确定选择」写回。
   * 保持两条选择路径行为一致。
   */
  function useManual() {
    const id = manualId.trim();
    if (!id) return;
    picked = { docId: id, docTitle: "", notebookName: "" };
  }

  function close() {
    if (standalone && onClose) onClose();
    else dispatch("close");
  }
</script>

{#if standalone}
  <div class="rwt-picker-mask" on:click={close}>
    <div class="rwt-picker-card" on:click|stopPropagation role="dialog" aria-label={headerTitle}>
      <header class="rwt-picker-head">
        <span>{headerTitle}</span>
        <button type="button" class="rwt-picker-x" aria-label={t("关闭")} on:click={close}>×</button>
      </header>
      <DocTreeBody
        tree={roots} {loading} {loadError} {keyword} {expanded} {highlightId} {pickedId}
        {mode} {selectedNotebook} {notebooks} {manualId} {showManual}
        onReload={load} onPick={pick} onToggle={toggle}
        onClear={clearBinding} onUseManual={useManual}
        onKeyword={(v) => (keyword = v)} onNotebook={(v) => (selectedNotebook = v)}
        onManual={(v) => (manualId = v)} onToggleManual={(v) => (showManual = v)}
        {matchSet} filteredRoots={() => roots}
      />
      <footer class="rwt-picker-foot">
        <button type="button" class="rwt-picker-btn" on:click={cancelPick}>{t("取消")}</button>
        <button
          type="button"
          class="rwt-picker-btn rwt-picker-btn-primary"
          disabled={!picked}
          on:click={confirmPick}
        >{t("确定选择")}</button>
      </footer>
    </div>
  </div>
{:else}
  <DocTreeBody
    tree={roots} {loading} {loadError} {keyword} {expanded} {highlightId} {pickedId}
    {mode} {selectedNotebook} {notebooks} {manualId} {showManual}
    onReload={load} onPick={pick} onToggle={toggle}
    onClear={clearBinding} onUseManual={useManual}
    onKeyword={(v) => (keyword = v)} onNotebook={(v) => (selectedNotebook = v)}
    onManual={(v) => (manualId = v)} onToggleManual={(v) => (showManual = v)}
    {matchSet} filteredRoots={() => roots}
  />
{/if}

<style>
  .rwt-picker-mask {
    position: fixed; inset: 0; z-index: 9999;
    background: rgba(0, 0, 0, 0.36);
    display: flex; align-items: center; justify-content: center; padding: 24px;
  }
  .rwt-picker-card {
    width: 420px; max-width: 92vw; max-height: 78vh;
    background: var(--b3-theme-background, #fff); border-radius: 12px; overflow: hidden;
    display: flex; flex-direction: column;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.28);
    border: 0.5px solid var(--b3-border-color, rgba(127, 127, 127, 0.18));
  }
  .rwt-picker-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 14px; border-bottom: 0.5px solid var(--b3-border-color, rgba(127, 127, 127, 0.18));
    font-size: 14px; font-weight: 500;
  }
  .rwt-picker-x {
    border: none; background: transparent; cursor: pointer; font-size: 20px; line-height: 1;
    color: var(--b3-theme-on-surface-light, #888); padding: 0 4px;
  }
  .rwt-picker-x:hover { color: var(--b3-theme-on-background, #222); }
  /* standalone 浮层底部：取消 / 确定选择（与设置页同语义，点文档只打勾、此处才写回） */
  .rwt-picker-foot {
    display: flex; justify-content: flex-end; gap: 8px;
    padding: 10px 14px; border-top: 0.5px solid var(--b3-border-color, rgba(127, 127, 127, 0.18));
    flex: none;
  }
  .rwt-picker-btn {
    height: 30px; padding: 0 14px; border-radius: 7px; font-size: 13px; cursor: pointer;
    border: 0.5px solid var(--b3-border-color, rgba(127, 127, 127, 0.25));
    background: transparent; color: var(--b3-theme-on-background, #222); font-family: inherit;
  }
  .rwt-picker-btn-primary {
    background: var(--b3-theme-primary, #3370ff); color: #fff; border-color: transparent;
  }
  .rwt-picker-btn:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
