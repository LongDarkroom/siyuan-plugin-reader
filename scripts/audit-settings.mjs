#!/usr/bin/env node
/**
 * 设置闭环审计（2026-10-07 新建）
 * ----------------------------------------------------------------
 * 目的：把「schema 里的每一行设置，是否真有执行层消费点」变成**可重复的检查**。
 *
 * ## 为什么需要它
 * 本项目出现过**三次**「面板能点、参数能存、执行层零消费」的静默失效：
 *   ① `minFontSize`   —— 只有 schema/类型/默认值，无任何 CSS 消费
 *   ② `serifFont` 等  —— 被fontMode门控，而面板没有 fontMode 入口
 *   ③ `textAlign` / `hyphenate` —— schema 有，执行层**硬编码**了别的值
 * 这类问题tsc 查不出、测试也不一定覆盖（因为测试断言的是"代码存在"，
 * 不是"这个开关真的改变输出"）。所以需要一个**独立于两者**的结构性检查。
 *
 * ## 判定口径
 * 对每个 path取字段名（末段），在执行层两个文件里查：
 *   - reader-style.ts   （样式生成，纯函数层）
 *   - ReaderView.svelte （宿主行为层：几何、UI、事件）
 * 两者都无命中 → 判为「死设置」。
 *
 * ## 已知局限（重要，别误用）
 * ① 字段名相同但语义不同的**误判可能**：例如 `marginTopPx` 在 style 里是
 *    CSS 生成、在 view 里是写变量，任一命中即算活。
 * ② 反过来**漏判**：若某字段被 `Object.keys()` 式的遍历消费
 *    （本项目暂无此写法），本脚本会误报为死设置。
 * ③ 它只查「字段名出现」，**不查是否被真正使用**——
 *    所以「出现在注释里」也算命中。本脚本刻意不过滤注释，
 *    因为过滤注释会漏掉「只在注释里提到、代码已删」这类更隐蔽的死代码。
 *    精确判定请配合 `test/smoke-settings-layout.test.mjs` 的行为断言。
 *
 * 用法：node scripts/audit-settings.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src", "reader");
const read = (p) => readFileSync(join(SRC, p), "utf-8");

const schema = read("settings/settings-schema.ts");
const style = read("reader-style.ts");
const view = read("ReaderView.svelte");
const cfg = read("reader-settings.ts");

/** 抽某个 Tab 的 schema 片段 */
function tabSegment(key) {
  const start = schema.indexOf(`key: "${key}"`);
  if (start < 0) return "";
  // 到下一个 `key: "..."` 为止
  const rest = schema.slice(start + 10);
  const m = rest.match(/\n {4}key: "/);
  return m ? schema.slice(start, start + 10 + m.index) : schema.slice(start);
}

/** 抽出行 path（跳过 __ 前缀的虚拟 path 与只读/预设行） */
function rowPaths(seg) {
  return [...seg.matchAll(/path:\s*"([^"]+)"/g)]
    .map((m) => m[1])
    .filter((p) => !p.startsWith("__"));
}

const TABS = ["font", "layout", "theme", "behavior", "lang", "tts"];
let dead = 0;
let total = 0;

for (const key of TABS) {
  const seg = tabSegment(key);
  const paths = rowPaths(seg);
  if (!paths.length) {
    console.log(`\n[${key}] 未解析到行（Tab 可能改名或结构变了）`);
    continue;
  }
  console.log(`\n===== Tab: ${key}（${paths.length} 项）`);
  for (const p of paths) {
    total++;
    const leaf = p.split(".").pop();
    const inStyle = style.includes(leaf);
    const inView = view.includes(leaf);
    const inCfg = cfg.includes(leaf);
    const alive = inStyle || inView;
    if (!alive) dead++;
    const mark = alive ? (inStyle && inView ? "OK  " : "WARN") : "DEAD";
    console.log(
      `  [${mark}] ${p.padEnd(28)} style=${inStyle ? "Y" : "-"} view=${inView ? "Y" : "-"} cfg=${inCfg ? "Y" : "-"}`,
    );
    if (!inCfg) console.log(`         ⚠️ 配置类型里找不到字段 ${leaf} —— 该行写入会落到无声明处`);
  }
}

/* ============================================================
 * 反向检查：「有货无柜」—— 执行层有、面板无
 * ------------------------------------------------------------
 * 动机（2026-10-08）：审计查出 `flow` / `clickToTurn` / `turnStyle` /
 * `focusMode` 四个字段**执行链完整**（flow 在 ReaderView 有 66 处引用），
 * 却一个面板入口都没有 ⇒ 用户看不到、也改不了。
 *
 * 这与「死设置」是**镜像问题**，且**更难被发现**：
 * 死设置至少还看得到开关（用户会问「为什么没用」），
 * 「有货无柜」的用户根本不知道它存在。
 *
 * ⚠️ 本检查必然有**误报**：settings 里有相当多字段是**内部状态**，
 * 由代码直接读写、刻意不给用户开关（如 pdfViewMode / 各种运行时缓存）。
 * 所以这里只**列出清单**供人工判断，不作为失败条件。
 * ============================================================ */
function reverseCheck() {
  // 从 ReaderSettings 接口的顶层字段里取出所有名字
  const i = cfg.indexOf("export interface ReaderSettings");
  if (i < 0) return [];
  const j = cfg.indexOf("export const READER_DEFAULT_SETTINGS", i);
  const iface = cfg.slice(i, j > 0 ? j : i + 12000);
  const names = new Set();
  for (const m of [...iface.matchAll(/^\s{2}(\w+)\??:/gm)]) names.add(m[1]);

  // schema 里出现过的所有 path（任意 Tab，含 __ 前缀）
  const inSchema = new Set();
  for (const m of [...schema.matchAll(/path:\s*"([^"]+)"/g)]) inSchema.add(m[1]);

  // 默认设置里出现过的键也算「有货」（用户至少存了这个值）
  const inDefaults = new Set();
  const k0 = cfg.indexOf("export const READER_DEFAULT_SETTINGS");
  const defaultsBlock = cfg.slice(k0, cfg.indexOf("};", k0));
  for (const m of [...defaultsBlock.matchAll(/^\s{2,4}(\w+):/gm)]) inDefaults.add(m[1]);

  const missing = [];
  for (const name of names) {
    if (inSchema.has(name)) continue;
    // 嵌套路径（text.xxx / paragraph.xxx / layout.xxx）也算有
    if ([...inSchema].some((p) => p.endsWith("." + name))) continue;
    // 有执行层消费 + 有默认值 ⇒ 值得报告（很可能是漏了入口）
    const consumed =
      style.includes(name) || view.includes(name) || cfg.includes(name);
    if (consumed && inDefaults.has(name)) missing.push(name);
  }
  return missing;
}

const orphans = reverseCheck();
console.log(`\n===== 反向检查（有货无柜）：${orphans.length} 个字段执行层有、面板无入口`);
if (orphans.length) {
  console.log("  下列字段需人工判断：是「内部状态刻意不给开关」还是「漏了入口」：");
  for (const name of orphans) console.log("   -", name);
  console.log("  参考：2026-10-08 就是这样查出了 flow / clickToTurn / turnStyle / focusMode。");
}

console.log(`\n===== 汇总：${total} 项，疑似死设置 ${dead} 项`);
if (dead > 0) {
  console.log("DEAD 项需人工确认：是「执行层用了别的名字」还是「真的没接上」。");
  process.exitCode = 1;
}
