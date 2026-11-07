/**
 * 版本更新弹窗 · 纯逻辑（2026-10-26）
 * ==================================================================
 * ## 这模块解决什么
 *
 * 用户升级插件后想知道「这次更新了什么」。做法对标 Excali Studio：
 * 插件根目录放一份 `CHANGELOG.md`，运行时读文件、切出当前版本那一段、弹窗展示。
 *
 * ## 单一真源 = 插件根的 CHANGELOG.md
 *
 * 不在 src 里另存一份「本次更新」文案 —— 两份文案迟早分叉，且每次发版都要改两处。
 * 运行时读包内文件，按 `## v<当前版本>` 切出这一段。
 *
 * ## 为什么是纯逻辑模块（不 import 思源 SDK）
 *
 * 判定 / 切片 / 渲染都是纯函数，node 里能直接 import 跑单测
 * （`node --experimental-strip-types`），不必起浏览器、不必 mock 思源。
 * 只有「取版本号」「存版本号」「开弹窗」这三件事碰思源 API，放在 index.ts 里。
 *
 * ## 版本号从哪来
 *
 * 构建期注入：`vite.config.ts` 读 plugin.json 的 version 走 define 注入
 * `__REWORD_VERSION__`。**不读运行时 `this.version`** —— 思源的 `Plugin` 类
 * 没有这个字段（见 siyuan.d.ts），取到 undefined 会每次都判定成「有新版本」，
 * 变成重启弹窗风暴。取不到版本号就整条静默（unknown-version）。
 *
 * ⚠️ 配套铁律：**改 plugin.json 的版本号后必须重跑 `npm run build`**，
 * 否则产物里注入的还是旧号，弹窗会误判「有新版本」而每次重启都弹。
 */

declare const __REWORD_VERSION__: string | undefined;

/** 当前插件版本（= plugin.json 的 version）；未注入时为空串 */
export const PLUGIN_VERSION: string =
  typeof __REWORD_VERSION__ === "string" ? __REWORD_VERSION__ : "";

/**
 * 「本机已经看过哪个版本」单独占一个槽，不塞进任何已有配置：
 * 那些配置的持久化是整对象覆写，多一个字段就多改一处，漏一次版本号就记丢。
 */
export const VERSION_SLOT = "reader-changelog-version";

/** 该不该弹、要不要回写版本号——四种情形互斥，交给调用方按值分流 */
export type ChangelogAction = "unknown-version" | "first-install" | "up-to-date" | "show";

/**
 * 判定口径：
 * - unknown-version：版本号没注入（构建配置漏了 / 测试环境），什么都不做，也绝不回写；
 * - first-install：槽里没记录 = 首次安装，只静默记下版本号，不弹
 *   （用户装插件时不需要被弹窗迎接）；
 * - up-to-date：记过的就是当前版本，不弹不回写（不浪费一次写盘）；
 * - show：记过的和当前不一样 = 升级了，弹一次并把新版本写回去。
 */
export function changelogDecision(stored: unknown, current: string): ChangelogAction {
  const cur = (current || "").trim();
  if (!cur) return "unknown-version";
  const seen = (typeof stored === "string" ? stored : "").trim();
  if (!seen) return "first-install";
  return seen === cur ? "up-to-date" : "show";
}

/** 更新日志在包内的位置（思源把 data/plugins/<name>/ 挂在 /data/ 下） */
export function changelogPath(pluginName: string): string {
  return `/data/plugins/${pluginName}/CHANGELOG.md`;
}

const ESC_MAP: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 读插件包里的文件。
 *
 * ⚠️ 两条硬约束（都踩过）：
 *
 *  1. **不能走静态路径**。`fetch("/data/plugins/<name>/CHANGELOG.md")` 返回
 *     HTTP 200 但**内容长度 0** —— 思源把 /data/ 挂成静态目录但不吐文件内容。
 *     必须走内核接口 `POST /api/file/getFile`。
 *
 *  2. **这个接口读不到文件时回的是 HTTP 200 + JSON 错误体**
 *     （`{"code":-1,...}`），不是 404。所以 content-type 与正文里的 "code":404
 *     两道都要认，否则会把错误 JSON 当成日志正文渲染出来。
 */
export async function fetchPluginFile(path: string): Promise<string> {
  const res = await fetch("/api/file/getFile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) throw new Error(`getFile HTTP ${res.status}`);
  const text = await res.text();
  if ((res.headers.get("content-type") || "").includes("application/json") || /"code"\s*:\s*404/.test(text)) {
    throw new Error(`getFile 读不到文件：${path}`);
  }
  return text;
}

/**
 * 切出 `## v<version>` 这一段的 markdown（含标题整行，标题里的日期是有用信息）。
 * 边界是下一个 `## `（两个井号）；`### ` 小节留在段内。段尾的分隔线 `---` 和空行剥掉。
 * 找不到该版本段回空串——发版忘了写日志时的正常形态，调用方静默。
 */
export function sliceVersionSection(markdown: string, version: string): string {
  const v = (version || "").trim();
  if (!v) return "";
  // `(?![0-9.])`：v0.2 不能把 v0.2.0 那行也认下来
  const head = new RegExp(`^##\\s+v?${escapeRe(v)}(?![0-9.])`, "m").exec(markdown);
  if (!head) return "";
  // tail 从标题行的下一行开头起算，所以段里含标题整行，而 ^##\s 只会命中真正的下一段
  const tailStart = (() => {
    const lineEnd = markdown.indexOf("\n", head.index);
    return lineEnd < 0 ? markdown.length : lineEnd + 1;
  })();
  const tail = markdown.slice(tailStart);
  const next = tail.search(/^##[ \t]/m);
  const bodyEnd = next < 0 ? markdown.length : tailStart + next;
  const body = markdown.slice(head.index, bodyEnd).replace(/\s+$/, "");
  return body.replace(/\n-{3,}$/, "").replace(/\s+$/, "");
}

/**
 * markdown → HTML。优先用思源自带的 Lute（和内置插件同一个渲染器，表格/代码块样式
 * 跟着 .b3-typography 走）；拿不到（移动端裁剪 / 加载顺序）就回落 <pre> 纯文本，
 * 转义后再塞，绝不把日志正文当 HTML 拼。
 */
function renderMarkdownBlock(markdown: string, plainClass: string): string {
  const Lute = (globalThis as { Lute?: { New?: () => { Md2HTML?: (md: string) => string } } }).Lute;
  if (Lute?.New) {
    try {
      const html = Lute.New().Md2HTML?.(markdown);
      if (html) return html;
    } catch {
      // 渲染器抛错照样回落纯文本
    }
  }
  return `<pre class="${plainClass}">${escapeHtml(markdown)}</pre>`;
}

export function renderChangelogHtml(section: string): string {
  return renderMarkdownBlock(section, "re-changelog__plain");
}

/** 更新日志里的一节：`### 标题` + 正文 markdown */
export interface ChangelogGroup {
  title: string;
  markdown: string;
}

/** 一个版本：标题行里的版本号 / 日期，首段的引导语，以及若干 `###` 小节 */
export interface ChangelogVersion {
  version: string;
  date: string;
  lead: string;
  groups: ChangelogGroup[];
}

/** 版本标题行：`v0.5.5 (2026-11-06)` / `v0.7.0（2026-10-30）`，括号半角全角都认 */
const VERSION_HEAD_RE = /^v?(\d[\w.+-]*)[ \t]*(?:[(（][ \t]*([^)）]*?)[ \t]*[)）])?[ \t]*$/;

function stripTrailingRule(markdown: string): string {
  return markdown.replace(/\n-{3,}[ \t]*$/, "").replace(/\s+$/, "");
}

/**
 * 把整份 CHANGELOG 拆成版本列表（文件顺序 = 新→旧）。
 *
 * - 只认二级标题 `## `；文档最前面的标题/前言不算版本；
 * - 版本号与日期都从标题行取，日期括号半角、全角都收（两个插件的日志写法不同）；
 * - 首个 `### ` 之前是引导语，之后按 `### ` 切小节；
 * - 段尾的 `---` 分隔线剥掉，别让它跑进正文。
 */
export function parseChangelogVersions(markdown: string): ChangelogVersion[] {
  const heads: { index: number; bodyStart: number; title: string }[] = [];
  const headRe = /^##[ \t]+(.+?)[ \t]*$/gm;
  let m: RegExpExecArray | null;
  while ((m = headRe.exec(markdown))) {
    const lineEnd = markdown.indexOf("\n", m.index);
    heads.push({
      index: m.index,
      bodyStart: lineEnd < 0 ? markdown.length : lineEnd + 1,
      title: m[1].trim(),
    });
  }

  const versions: ChangelogVersion[] = [];
  for (let i = 0; i < heads.length; i++) {
    const hit = VERSION_HEAD_RE.exec(heads[i].title);
    if (!hit) continue;
    const end = i + 1 < heads.length ? heads[i + 1].index : markdown.length;
    const body = stripTrailingRule(markdown.slice(heads[i].bodyStart, end).trim());
    const parts = body.split(/^###[ \t]+/m);
    const lead = stripTrailingRule((parts.shift() || "").trim());
    const groups: ChangelogGroup[] = [];
    for (const part of parts) {
      const nl = part.indexOf("\n");
      const title = (nl < 0 ? part : part.slice(0, nl)).trim();
      if (!title) continue;
      const md = nl < 0 ? "" : stripTrailingRule(part.slice(nl + 1).trim());
      groups.push({ title, markdown: md });
    }
    versions.push({ version: hit[1], date: (hit[2] || "").trim(), lead, groups });
  }
  return versions;
}

/** 弹窗里的固定文案；由宿主按当前语言传入，纯逻辑模块不碰 i18n */
export interface ChangelogLabels {
  title: string;
  subtitle: string;
  history: string;
  latest: string;
  current: string;
  archived: string;
  ok: string;
  close: string;
}

/**
 * 双栏全历史弹窗的 HTML 外壳：
 * 左栏是完整版本时间线（默认选中当前版本），右栏按 `###` 分组渲染白卡片。
 * 每一页都先渲染好、用 `hidden` 切换——版本数量是几十级，切换时零重排最省事。
 */
export function buildChangelogDialogHtml(
  markdown: string,
  currentVersion: string,
  labels: ChangelogLabels
): string {
  const versions = parseChangelogVersions(markdown);
  if (!versions.length) return "";
  const cur = (currentVersion || "").trim().replace(/^v/i, "");
  const found = versions.findIndex((v) => v.version === cur);
  const active = found < 0 ? 0 : found;

  const rail = versions
    .map((v, i) => {
      const on = i === active;
      return `<button type="button" class="cl-ver${on ? " is-active" : ""}" data-cl-ver="${i}"${
        on ? ' aria-current="true"' : ""
      }>
        <span class="cl-ver-num">v${escapeHtml(v.version)}${
          i === 0 ? `<span class="cl-new">${escapeHtml(labels.latest)}</span>` : ""
        }</span>
        ${v.date ? `<span class="cl-ver-date">${escapeHtml(v.date)}</span>` : ""}
      </button>`;
    })
    .join("");

  const pages = versions
    .map((v, i) => {
      const latest = i === 0;
      const isCurrent = v.version === cur;
      const lead = v.lead ? `<div class="cl-lead">${renderMarkdownBlock(v.lead, "re-changelog__plain")}</div>` : "";
      const groups = v.groups
        .map(
          (g) =>
            `<section class="cl-group"><h3>${escapeHtml(g.title)}</h3><div class="cl-group-body">${
              g.markdown ? renderMarkdownBlock(g.markdown, "re-changelog__plain") : ""
            }</div></section>`
        )
        .join("");
      return `<section class="cl-page" data-cl-page="${i}"${i === active ? "" : " hidden"}${
        isCurrent ? ' data-cl-current="true"' : ""
      }>
        <div class="cl-ver-head">
          <h2>v${escapeHtml(v.version)}</h2>
          ${v.date ? `<time>${escapeHtml(v.date)}</time>` : ""}
          ${latest ? `<span class="cl-new">${escapeHtml(labels.latest)}</span>` : ""}
        </div>
        ${lead}
        <div class="cl-groups">${groups}</div>
      </section>`;
    })
    .join("");

  // 页脚放在滚动区之外：版本页再长，「知道了」也始终在弹窗底部
  const foot = `<footer class="cl-foot">
      <span class="cl-foot-status">${escapeHtml(
        versions[active].version === cur ? labels.current : labels.archived
      )}</span>
      <button type="button" class="cl-ok" data-cl-ok>${escapeHtml(labels.ok)}</button>
    </footer>`;

  return `<div class="cl-dialog" data-cl-text-current="${escapeHtml(labels.current)}" data-cl-text-archived="${escapeHtml(
    labels.archived
  )}">
    <header class="cl-head">
      <div class="cl-script">What's new</div>
      <h1 class="cl-title">${escapeHtml(labels.title)}</h1>
      <p class="cl-sub">${escapeHtml(labels.subtitle)}</p>
      <button type="button" class="cl-close" data-cl-close aria-label="${escapeHtml(labels.close)}">×</button>
    </header>
    <div class="cl-body">
      <nav class="cl-rail" aria-label="${escapeHtml(labels.history)}">
        <div class="cl-rail-label">${escapeHtml(labels.history)}</div>
        ${rail}
      </nav>
      <main class="cl-main">${pages}</main>
    </div>
    ${foot}
  </div>`;
}

/**
 * 弹窗交互：版本切换 + 关闭 / 知道了。
 * 只用根节点上的事件委托——弹窗内容整段是 innerHTML 生成的，逐元素绑事件
 * 在重绘后必丢；委托还顺手避开「按钮里套块级节点」的点击目标问题。
 */
export function wireChangelogDialog(root: HTMLElement, onClose: () => void): void {
  const railButtons = Array.from(root.querySelectorAll<HTMLElement>("[data-cl-ver]"));
  const pages = Array.from(root.querySelectorAll<HTMLElement>("[data-cl-page]"));
  const main = root.querySelector<HTMLElement>(".cl-main");
  const footStatus = root.querySelector<HTMLElement>(".cl-foot-status");
  const dialogEl = root.querySelector<HTMLElement>(".cl-dialog");
  const currentText = dialogEl?.getAttribute("data-cl-text-current") || "";
  const archivedText = dialogEl?.getAttribute("data-cl-text-archived") || "";

  root.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    if (target.closest("[data-cl-close], [data-cl-ok]")) {
      onClose();
      return;
    }
    const btn = target.closest<HTMLElement>("[data-cl-ver]");
    if (!btn) return;
    const idx = Number(btn.getAttribute("data-cl-ver"));
    if (!Number.isInteger(idx) || idx < 0) return;
    railButtons.forEach((b) => {
      const on = b === btn;
      b.classList.toggle("is-active", on);
      if (on) b.setAttribute("aria-current", "true");
      else b.removeAttribute("aria-current");
    });
    pages.forEach((p, i) => {
      p.hidden = i !== idx;
    });
    if (footStatus) {
      footStatus.textContent = pages[idx]?.hasAttribute("data-cl-current") ? currentText : archivedText;
    }
    if (main) main.scrollTop = 0;
    btn.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
}
