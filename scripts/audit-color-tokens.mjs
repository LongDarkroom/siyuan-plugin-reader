#!/usr/bin/env node
/**
 * 交互态颜色令牌审计（2026-10-11 · 书架美化 P0）
 * =================================================================
 * ## 为什么需要它
 *
 * `docs/全局体检报告-交互态与主题适配.md` 用**逐主题实测**证明了两类写法
 * 在思源的多套主题下是坏的，且成因完全不可见 —— 代码在 daylight 下看着挺好：
 *
 *  R1 交互态（`:hover` / `.active` / `.selected` / `.on` / `:checked`）
 *     底色 = `--b3-theme-background-light`。
 *     该令牌在七套主题里**语义不一致**：daylight/QYL 是实心中性灰（可见），
 *     Neo/Asri/midnight 是「自色 10% alpha」→ 叠在同色底上 **ΔRGB = 0.00**，
 *     交互反馈等于不存在。用户在用的正是 Neo。
 *     ⇒ 改 `--b3-list-hover`（七套主题全有定义，Neo 下 ΔRGB 29.6）。
 *
 *  R2 `.active/.selected/.on/:checked` 或 `:hover` 的底色 = `--b3-theme-primary-light`
 *     这是**实心强调色**，叠宿主底色后 ΔRGB 106~164（五套主题无一例外），
 *     当选中/hover 底色必然「过重、压过内容」。
 *     ⇒ 改 `--b3-theme-primary-lightest`（ΔRGB 26~38，够看见又不压内容）。
 *     旁证：这些位置的硬编码兜底值全是 `rgba(55,138,221,.1x)` —— 作者本意就是淡底。
 *
 *  R3 交互态里 `color: var(--b3-theme-primary)` 压淡底
 *     实测对比度仅 **2.97~3.65，不达 WCAG AA（4.5）**。
 *     ⇒ 选中项文字保持 `on-background`，选中指示交给字重 + 竖条，不靠染色。
 *
 *  R4 `var(--b3-primary-light)`（漏了 `theme-`）
 *     七套主题**全部未定义**该变量 ⇒ 整条声明被丢弃 ⇒ 永远走逗号后的硬编码兜底，
 *     表现为「换主题界面不跟着变」。纯拼写错误，但肉眼查不出来。
 *
 * 这四条都是**会随新增代码复发**的形态：本次修完 25 处，下次写新面板还会踩。
 * 所以做成脚本 + 测试，而不是改完就完事。
 *
 * 确属有意为之的写法（如 26px 纯图标按钮按非文本 3:1 门槛）在**规则体内**写
 * `/* token-allow:R3 理由 *\/` 显式豁免；不要用 BASELINE 的数量豁免去盖它，
 * 数量豁免只留给「后续批次整体收敛」的整文件欠账。
 *
 * ## 用法
 *   node scripts/audit-color-tokens.mjs            # 人读报告
 *   node scripts/audit-color-tokens.mjs --json     # 机器读
 *   node scripts/audit-color-tokens.mjs --baseline # 打印当前违规清单（用于更新 BASELINE 豁免表）
 *
 * 退出码：0 = 无新增违规；1 = 有不在豁免表里的违规。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url).split("/").slice(0, -1).join("/"), "..");
const SRC = join(ROOT, "src");
const EXT = [".svelte", ".less", ".css", ".ts"];
/** vendor 是第三方（foliate-js 13MB），不参与本插件的样式约定 */
const SKIP_DIR = ["vendor", "node_modules"];

/* ================================================================
 * 豁免表：P0 只收敛「书架」这一片界面，其余面板留给后续批次。
 * 键 = 相对 src 的路径，值 = 该文件**已知**的违规数。
 *
 * 为什么记数量而不是逐行：逐行豁免会在改文件时集体失效（行号漂移），
 * 数量则允许同文件的旧违规存在、但**一新增就超**，足够拦住回归。
 *
 * 2026-10-11 P0 范围 = 书架 surface（BookshelfView + 书架顶栏拉起的
 * GraphPanel / OpdsSearchPanel / ReadingStatsPanel + 右键菜单）。
 * 下面三个文件属于**阅读 surface**，P0 不动：
 *  · ReaderView.svelte 的 4 处 R4（`--b3-primary-light` 漏 `theme-`）
 *    改了会让「本来被丢弃、从不生效」的淡底**突然开始生效** ——
 *    那是阅读界面的可见行为变化，必须单独验证，不能混进书架批次。
 * ================================================================ */
const BASELINE = {
  "reader/ReaderView.svelte": 11,
  "reader/reader-controls.less": 5,
  "reader/BilingualSettingsTab.svelte": 2,
};

/* ================================================================
 * 解析：把样式文本切成「规则块」，带上选择器链
 * ================================================================ */

/**
 * 去掉注释（保留换行以维持行号）。
 *
 * 例外：含 `token-allow:` 的注释**原样保留**。
 * 这是给审计用的显式豁免标记 —— 有些形态是**故意**的，例如 26px 纯图标按钮
 * 的选中态用主色描图标（WCAG 1.4.11 非文本对比度门槛 3:1，不是文本的 4.5:1），
 * 套 R3 会误报。与其在整个文件层面按数量豁免（会连带放过同文件的新错），
 * 不如在**那一行**写清理由，让豁免可读、可查、可审。
 *   用法：把 `/* token-allow:R3 纯图标，按 3:1 非文本对比 *\/` 写在规则体内。
 */
function stripComments(css) {
  const out = [];
  let i = 0;
  while (i < css.length) {
    if (css[i] === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      const seg = end === -1 ? css.slice(i + 2) : css.slice(i + 2, end);
      out.push(/token-allow:/.test(seg) ? css.slice(i, end === -1 ? undefined : end + 2) : seg.replace(/[^\n]/g, " "));
      i = end === -1 ? css.length : end + 2;
      continue;
    }
    out.push(css[i]);
    i++;
  }
  return out.join("");
}

/** 行号（1-based）：按字符偏移量数换行 */
function lineAt(text, pos) {
  let n = 1;
  for (let i = 0; i < pos && i < text.length; i++) if (text[i] === "\n") n++;
  return n;
}

const HOVER_RE = /:hover|:focus-visible/;
const SELECTED_RE = /\.active\b|\.selected\b|\.on\b|:checked|\[class\*="active"\]/;
const INTERACTIVE_RE = new RegExp(HOVER_RE.source + "|" + SELECTED_RE.source);

/**
 * 取规则体内每条声明（简化：按 ; 和换行切，忽略嵌套块内的声明 ——
 * 嵌套块会在收集阶段成为独立规则，这里把 `}` 之后的尾巴丢掉即可）。
 */
function declarations(body) {
  return body
    .split(/[\n;]/)
    // 只剥 `token-allow` 这类被保留下来的注释，**不能整行丢掉** ——
    // 否则把标记和声明写在同一行时，这条声明会对所有规则隐身。
    .map((s) => s.replace(/\/\*[\s\S]*?\*\//g, "").trim())
    .filter((s) => s.includes(":") && !s.startsWith("@") && !s.includes("{"));
}

/** 该规则显式豁免了哪几条规则（`token-allow:R3` / `token-allow:R1,R2`） */
function allowedRules(body) {
  const out = new Set();
  // 只吃「R编号, R编号」，后面的中文理由原样留给读者
  for (const m of body.matchAll(/token-allow:\s*(R\d+(?:\s*,\s*R\d+)*)/gi)) {
    for (const id of m[1].split(",")) out.add(id.trim().toUpperCase());
  }
  return out;
}

/** 规则体里是否存在「prop 匹配且值匹配」的声明 */
function hasDecl(body, propRe, valRe) {
  for (const d of declarations(body)) {
    const prop = d.slice(0, d.indexOf(":")).trim();
    const val = d.slice(d.indexOf(":") + 1);
    if (propRe.test(prop) && valRe.test(val)) return true;
  }
  return false;
}

/**
 * 扫描一段样式文本，返回违规列表。
 *
 * 两趟：
 *  趟 1 用花括号栈收集所有规则（含 `@media` 外层链），不做判定；
 *  趟 2 判定。之所以要两趟：R3 关心的「主色文字」在真实代码里几乎从不和
 *  淡底写在同一条规则 —— 淡底在父选择器（`.shelf-sb-item.active`），
 *  文字色在后代选择器（`.shelf-sb-item.active .shelf-sb-num`）。
 *  单趟看不到这个关系。
 */
export function scanStyle(css, rel, lineOffset) {
  const text = stripComments(css);
  const rules = [];
  const stack = []; // { sel, start }
  let buf = "";
  let inStr = null;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === inStr && text[i - 1] !== "\\") inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = ch; continue; }

    if (ch === "{") {
      stack.push({ sel: buf.trim(), start: i });
      buf = "";
      continue;
    }
    if (ch === "}") {
      const finished = stack.pop();
      if (finished) {
        rules.push({
          sel: finished.sel,
          chain: stack.map((s) => s.sel),
          body: text.slice(finished.start + 1, i),
          start: finished.start,
        });
      }
      buf = "";
      continue;
    }
    if (ch === ";") { buf = ""; continue; }
    buf += ch;
  }

  /* 趟 2 前置：找出「带淡主色底的交互态」选择器，供 R3 认后代规则 */
  const selectedLightBg = new Set();
  for (const r of rules) {
    if (!INTERACTIVE_RE.test(r.sel)) continue;
    if (hasDecl(r.body, /^background(-color)?$/i, /--b3-theme-primary-light(?:est)?\b(?!-)/) && !allowedRules(r.body).has("R2")) {
      selectedLightBg.add(r.sel);
    }
  }

  const hits = [];
  for (const r of rules) {
    for (const h of checkRule(r, selectedLightBg)) {
      hits.push({ ...h, file: rel, line: lineAt(text, r.start + 1) + (lineOffset || 0) });
    }
  }
  return hits;
}

/** 后代关系：`.a.active .num` 是 `.a.active` 的后代（选择器文本前缀 + 空格） */
function isDescendantOf(sel, ancestorSel) {
  return sel === ancestorSel || sel.startsWith(ancestorSel + " ") || sel.startsWith(ancestorSel + ",");
}

function checkRule(r, selectedLightBg) {
  const out = [];
  const sel = r.sel;
  if (!sel || sel.startsWith("@")) return out;
  const allows = allowedRules(r.body);
  const isInteractive = INTERACTIVE_RE.test(sel);
  const bgSet = [...selectedLightBg];

  const bgDecls = declarations(r.body).filter((d) =>
    /^background(-color)?$/i.test(d.slice(0, d.indexOf(":")).trim())
  );

  for (const d of bgDecls) {
    const val = d.slice(d.indexOf(":") + 1);
    // R1：交互态底色用 background-light（hover / active 一样不可见）
    if (isInteractive && /--b3-theme-background-light\b/.test(val)) {
      out.push({ rule: "R1", sel, msg: "交互态底色用 --b3-theme-background-light（Neo/Asri/midnight 下 ΔRGB=0，与同色底叠成「没有反馈」）→ 改 --b3-list-hover" });
    }
    // R2：交互态（hover / active / selected / on / :checked）底色用 primary-light（实心）
    //     hover 侧同样中招：`.shelf-menu-item:hover` 就是这么写的，实测整行糊成实心蓝
    if (isInteractive && /--b3-theme-primary-light(?!est)\b/.test(val)) {
      out.push({ rule: "R2", sel, msg: "交互态底色用 --b3-theme-primary-light（ΔRGB 106+，实心压内容）→ 改 --b3-theme-primary-lightest" });
    }
  }

  // R3：交互态的主色文字（本规则自带淡底，或祖先交互态规则带淡底）
  const underLightBg = isInteractive || bgSet.some((a) => isDescendantOf(sel, a));
  if (underLightBg) {
    const fgPrimary = hasDecl(r.body, /^color$/i, /var\(\s*--b3-theme-primary\s*[,)]/);
    const lightBgHere = hasDecl(r.body, /^background(-color)?$/i, /--b3-theme-primary-light(?:est)?\b/);
    const lightBgKnown = bgSet.some((a) => isDescendantOf(sel, a));
    if (fgPrimary && (lightBgHere || lightBgKnown)) {
      out.push({ rule: "R3", sel, msg: "主色文字压 primary-light(-est) 淡底，对比度 2.97~3.65 不达 AA → 文字改 on-background，选中指示用字重/竖条" });
    }
  }

  // R4：变量名拼错（漏 theme-）
  for (const d of declarations(r.body)) {
    if (/--b3-primary-light\b/.test(d) || /--b3-on-surface-light\b/.test(d) || /--b3-border-color-light\b/.test(d)) {
      out.push({ rule: "R4", sel, msg: "变量名缺 `theme-` 前缀，七套主题全未定义 ⇒ 整条声明被丢弃，永远走硬编码兜底：" + d.trim() });
    }
  }
  return out.filter((h) => !allows.has(h.rule));
}

/* ================================================================
 * 文件收集
 * ================================================================ */

function walk(dir, acc) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (!SKIP_DIR.includes(name)) walk(p, acc);
      continue;
    }
    if (EXT.some((e) => name.endsWith(e))) acc.push(p);
  }
  return acc;
}

/** 从 .svelte 抽 <style> 段（带行号偏移）；.less/.css 全文；.ts 无样式段 */
function stylesOf(file) {
  const raw = readFileSync(file, "utf-8");
  if (file.endsWith(".svelte")) {
    const out = [];
    const re = /<style[^>]*>([\s\S]*?)<\/style>/g;
    let m;
    while ((m = re.exec(raw))) {
      const contentStart = m.index + m[0].indexOf(m[1]);
      const offset = raw.slice(0, contentStart).split("\n").length - 1;
      out.push({ css: m[1], offset });
    }
    return out;
  }
  if (file.endsWith(".less") || file.endsWith(".css")) return [{ css: raw, offset: 0 }];
  return [];
}

/* ================================================================
 * 主流程
 * ================================================================ */

export function audit() {
  const files = walk(SRC, []);
  const hits = [];
  for (const f of files) {
    const rel = relative(SRC, f);
    for (const style of stylesOf(f)) hits.push(...scanStyle(style.css, rel, style.offset));
  }
  const byFile = new Map();
  for (const h of hits) {
    if (!byFile.has(h.file)) byFile.set(h.file, []);
    byFile.get(h.file).push(h);
  }
  const fresh = [];
  const waived = [];
  for (const [file, list] of byFile) {
    const cap = BASELINE[file];
    if (cap === undefined) { fresh.push(...list); continue; }
    const sorted = [...list].sort((a, b) => a.line - b.line);
    waived.push(...sorted.slice(0, cap));
    fresh.push(...sorted.slice(cap));
  }
  return { hits, fresh, waived, files: files.length };
}

function main() {
  const args = process.argv.slice(2);
  const { hits, fresh, waived, files } = audit();

  if (args.includes("--baseline")) {
    const byFile = {};
    for (const h of [...fresh, ...waived]) byFile[h.file] = (byFile[h.file] || 0) + 1;
    console.log("const BASELINE = " + JSON.stringify(byFile, null, 2) + ";");
    return;
  }

  const fmt = (h) => `  ${h.rule}  ${h.file}:${h.line}  ${h.sel}\n        ${h.msg}`;

  if (args.includes("--json")) {
    console.log(JSON.stringify({ files, total: hits.length, fresh, waived }, null, 2));
  } else {
    console.log(`审计 ${files} 个样式文件：违规 ${hits.length} 处（新增 ${fresh.length} / 豁免 ${waived.length}）`);
    if (fresh.length) {
      console.log("\n新增违规（必须修，或确认后再进 BASELINE 豁免）：");
      for (const h of fresh.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) console.log(fmt(h));
    }
    if (waived.length && !args.includes("--quiet")) {
      console.log(`\n豁免中 ${waived.length} 处（后续批次收敛，勿新增）：`);
      const grouped = {};
      for (const h of waived) (grouped[h.file] ||= []).push(h);
      for (const [f, list] of Object.entries(grouped).sort((a, b) => b[1].length - a[1].length)) {
        console.log(`  ${f}  ×${list.length}  [${[...new Set(list.map((x) => x.rule))].join(",")}]`);
      }
    }
  }
  process.exitCode = fresh.length ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith("audit-color-tokens.mjs")) main();
