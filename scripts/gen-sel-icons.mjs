#!/usr/bin/env node
/**
 * 阅读器/书架图标生成器（2026-10-08 建，2026-10-11 扩到书架）
 * ----------------------------------------------------------------
 * 产物 `SEL_ICONS` 同时服务两处：`ReaderView.svelte` 的划词工具栏，
 * 和书架一族组件（`BookshelfView` / 右键菜单 / OPDS / 图谱）。
 * ## 为什么需要这个脚本
 *
 * 想用思源自带的图标（`data/emojis/icons/`，1858 枚 Tabler Icons，MIT 许可），
 * 但**插件在运行时读不到那个目录**——已查证三点：
 *   1. 本项目源码内 `fs` / `node:fs` 的引用是 **0 处**：前端组件层不走 Node API；
 *   2. `vite.config.mts` 的 `external: ["fs", ...]` 只服务于 `js-mdict` 等第三方库，
 *      我们自己没有 import；
 *   3. 插件跑在 iframe / renderer 进程，没有 `require('fs')` 的能力。
 *
 * 而且插件会**打包分发到别的机器**，不能依赖思源工作空间的私有目录
 * —— 别人装上时 `data/emojis/icons/` 未必存在、未必是同一批图标。
 *
 * ⇒ 唯一可行的是**构建期抽取并内联进产物**，与 `vite.config.mts` 里
 *   `__REWORD_VERSION__` / `__REWORD_BUILD_TIME__` 的注入是同一套路。
 *
 * ## 用法
 *   node scripts/gen-sel-icons.mjs            # 生成
 *   node scripts/gen-sel-icons.mjs --check    # 只校验生成物是否与源文件同步（CI 用）
 *
 * ## 语义映射（为何是这 9 枚）
 * 见 docs/划词工具栏审计与图标换用-调研报告.md §2.4。
 * 其中 **dict 刻意用书本（book-open）而非放大镜**：
 *   Tabler 的 `search.svg` 也是纯放大镜，而「词典=查解释 / 搜索=找全书出现处」
 *   这组语义区分在 16px 下靠「只差一点」根本分不出来
 *   （这个坑 2026-10-08 已踩过一次，现有代码特意把 dict/search 做成两个样子）。
 */

/** 思源图标目录。可用 env 覆盖，便于在别的机器 / 别的思源数据目录下生成。 */
const ICON_DIR =
  process.env.SIYUAN_ICONS_DIR ||
  "/Users/xieyue/Downloads/思源笔记/data/emojis/icons";

const OUT = new URL("../src/reader/sel-icons.generated.ts", import.meta.url);

/**
 * 笔画粗细。
 *
 * 这一档是**兜底**：真正生效的是 CSS（思源宿主给 svg 设 fill 的事故逼着我们在
 * bookshelf-icons.less / ReaderView 里逐条声明 stroke-width，CSS 优先级高于
 * presentation attribute）。写进生成物只是为了脱离那几处样式时图标不至于细成
 * 0.6px，所以它必须等于 **16px 档**的那个值。
 *
 * 历史：一开始压到 1.5 是为了让「换图标」看起来变化最小（Tabler 原值 2）。
 * 2026-10-11 真机反馈太纤细 —— 1.5 在 16px 下只有 1.0px、12px 下 0.75px，
 * 提到 1.8（≈1.2px）。换算表与各尺寸档见 bookshelf-icons.less 的注释，
 * 改这里要同步 `npm run icons` 重跑生成。
 */
const STROKE_WIDTH = "1.8";

/**
 * 图标清单。
 * `key` 与 `ReaderView.svelte` 里 `SEL_ICONS.xxx` 的引用一一对应，**不可改名**。
 */
const ICONS = [
  // create 态 / edit 态共用
  { key: "copy", file: "copy", label: "复制" },
  { key: "highlight", file: "highlighter", label: "标注" },
  { key: "annotate", file: "message-square-text", label: "批注" },
  { key: "dict", file: "book-open", label: "词典" },
  { key: "search", file: "search", label: "划词后搜索" },
  { key: "translate", file: "languages", label: "翻译" },
  { key: "tts", file: "volume-2", label: "朗读" },
  { key: "send", file: "send", label: "发送" },
  // edit 态专用
  { key: "trash", file: "trash", label: "删除划线" },
  // 2026-10-08 批注卡片改版新增：导出按钮与折叠触发器的箭头。
  // 此前「导出」用 emoji ⬇️、「样式/色板」折叠后需要下拉箭头，都得换成内联 SVG ——
  // emoji 在深色下有自己的彩色、不跟随主题（与刚统一掉的三个按钮同类问题）。
  { key: "download", file: "download", label: "导出批注" },
  { key: "chevronDown", file: "chevron-down", label: "展开选择" },
  // 2026-10-08 取消/保存并入工具条：原为两个文字按钮（「取消」「保存」），
  // 现在换成图标放进右侧图标组，卡片因此从 4 行降到 3 行。
  // ⚠️ 用**素色** x / check 而非 circle-x / circle-check：
  //   其余 10 枚全是线性单线形制，circle-* 是更重的一套，混在一起不协调。
  // ⚠️ device-floppy / arrow-back 在思源图标库里**不存在**（实测），
  //   所以「保存」不能画成软盘，只能用对勾。
  { key: "cancel", file: "x", label: "取消" },
  { key: "confirm", file: "check", label: "保存" },

  /* ============================================================
   * 书架（2026-10-11 · 美化方案 §3.2 P1）
   * ------------------------------------------------------------
   * 与划词工具栏共用这张表，理由不是省事而是**规格必须一致**：
   * 同一份 viewBox/16px/stroke-width 1.8/currentColor 只有一处定义，
   * 否则两处各写一套，深浅模式和思源宿主 `svg{fill:…}` 的防御就会分叉
   * （宿主给 svg 或 path 直接设 fill 会把线性图标填成黑块，
   *   这次事故 2026-10-08 在划词工具栏上已经踩过一次）。
   *
   * ⚠️ 下面每个 file 都实测存在于 ICON_DIR。Tabler 的命名不规整，
   *   以下名字**看起来该有但实际没有**，别照着语义瞎写（写错 = 构建直接失败）：
   *     player-play / grid-dots / layout-sidebar / books / adjustments / dots
   *     photo / alert-triangle / refresh / star-filled
   *   对应改用：play / layout-grid / menu / library / chart-bar / menu
   *              image / —（本清单用不到）/ — / star（实心态交给 CSS 的 fill）
   * ============================================================ */
  // 顶栏（5 枚 + 续读）
  { key: "menu", file: "menu", label: "书架·展开/收起分组栏（原 ☰）" },
  { key: "play", file: "play", label: "书架·续读（原 ▶；圆角三角，不是 circle-play）" },
  { key: "checklist", file: "list-check", label: "书架·多选（原 ☑）" },
  { key: "stats", file: "chart-bar", label: "书架·阅读统计（原 📊）" },
  { key: "globe", file: "globe", label: "书架·OPDS 在线书源（原 🌐）" },
  { key: "graph", file: "chart-network", label: "书架·阅读知识图谱（原 🕸️）" },
  // 工具栏
  { key: "sortAsc", file: "arrow-up", label: "书架·升序（原 ↑）" },
  { key: "sortDesc", file: "arrow-down", label: "书架·降序（原 ↓）" },
  { key: "gridView", file: "layout-grid", label: "书架·网格视图（原 ▦）" },
  { key: "listView", file: "list", label: "书架·列表视图（原 ☰，与顶栏那个 ☰ 必须不同形）" },
  // 侧栏
  { key: "allBooks", file: "library", label: "书架·全部（原 📚）" },
  { key: "ungrouped", file: "folder-open", label: "书架·未分组（原 📂）" },
  { key: "group", file: "folder", label: "书架·分组（原 📁）" },
  { key: "add", file: "plus", label: "书架·新建分组（原全角 ＋）" },
  { key: "palette", file: "palette", label: "书架·分组颜色（原 ●）" },
  // 卡片 / 列表行
  { key: "fav", file: "star", label: "书架·收藏（原 ★/☆；实心态由 CSS 加 fill）" },
  { key: "edit", file: "pencil", label: "书架·编辑书籍信息（原 ✎）" },
  { key: "noteBound", file: "file-text", label: "书架·已绑定笔记发送目标（原 📄）" },
  // 空态与兜底（尺寸由 CSS 放大，生成物本身仍是 16）
  { key: "dropImport", file: "inbox", label: "书架·拖拽导入（原 📥）" },
  { key: "bookFallback", file: "book", label: "书架·OPDS 无封面兜底（原 📖）" },
  // 2026-10-11 右键菜单：菜单项的 icon 字段此前是 emoji，与刚换完的工具栏并排看
  // 会「一半线性、一半彩色」。只补菜单里独需要的 5 枚；✎★📁📂📋🗑●▶✓ 直接复用
  // 上面已有的 key（edit/fav/group/ungrouped/copy/trash/palette/chevronRight/confirm）。
  { key: "autoBind", file: "zap", label: "书架菜单·按书名自动建档（原 ⚡）" },
  { key: "tags", file: "tag", label: "书架菜单·设置标签（原 🏷）" },
  { key: "status", file: "clock", label: "书架菜单·阅读状态（原 ⏱）" },
  { key: "cover", file: "image", label: "书架菜单·替换封面（原 🖼）" },
  { key: "chevronRight", file: "chevron-right", label: "书架菜单·子菜单箭头（原 ▶）" },
];

/**
 * 抽掉外层 `<svg>` 标签，只留内部图形；并压成单行。
 *
 * 为什么抽而不是直接内联整个文件：Tabler 的根标签带
 * `width="24" height="24"`（24px），而我们需要 16px，
 * 且 `stroke-width` 要改成 STROKE_WIDTH。直接套用会得到「一组 24px 的图挤在 16px 槽里」。
 */
function extractInner(raw) {
  const open = /<svg\b[^>]*>/i.exec(raw);
  if (!open) throw new Error("根标签不是 <svg>，或文件为空");
  const close = /<\/svg>\s*$/i.exec(raw);
  if (!close) throw new Error("缺少 </svg> 闭标签（文件被截断？）");
  const inner = raw.slice(open.index + open[0].length, close.index);
  if (!inner.trim()) throw new Error("内部为空（只有外壳没有图形？）");
  return inner.replace(/\s+/g, " ").trim();
}

/** 明显不该出现在这些图标里的东西——抽进来就说明选错了文件或源文件有意外内容 */
const FORBIDDEN = [
  [/<defs[\s>]/i, "含 <defs>（本项目的图标不需要定义复用符号）"],
  [/<(?:linear|radial)Gradient/i, "含渐变（本项目图标一律纯线条）"],
  [/<image\b/i, "含位图 <image>（无法跟随主题色）"],
  [/\shref=/i, "含外部引用 href（打包后会指向不存在的路径）"],
  [/\bxlink:/i, "含 xlink（旧命名空间）"],
  [/stroke="(?!currentColor|none)/i, "含非 currentColor 的描边色（会导致深色模式下图标颜色错乱）"],
];

function buildSvg(inner) {
  for (const [re, why] of FORBIDDEN) {
    if (re.test(inner)) throw new Error(why);
  }
  return (
    `<svg viewBox="0 0 24 24" width="16" height="16" fill="none"` +
    ` stroke="currentColor" stroke-width="${STROKE_WIDTH}"` +
    ` stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`
  );
}

function generate() {
  const parts = [];
  for (const { key, file, label } of ICONS) {
    const path = `${ICON_DIR}/${file}.svg`;
    let raw;
    try {
      raw = require("fs").readFileSync(path, "utf-8");
    } catch (e) {
      // ⚠️ 必须**报错并退出**，绝不静默回退到旧产物 ——
      // 「生成成功但产物是旧的」这种失败最难查。
      console.error(`\n✗ 取不到图标：${path}`);
      console.error(`  用途：${key}（${label}）`);
      console.error(`  原因：${e.message}`);
      console.error(
        `\n  若思源数据目录不在默认位置，用环境变量指定：\n` +
          `    SIYUAN_ICONS_DIR=/path/to/data/emojis/icons node scripts/gen-sel-icons.mjs`,
      );
      process.exit(1);
    }
    try {
      const svg = buildSvg(extractInner(raw));
      parts.push({ key, label, svg });
      console.log(`  ✓ ${key.padEnd(10)} ← ${file}.svg  (${svg.length} 字节)`);
    } catch (e) {
      console.error(`\n✗ 处理失败：${file}.svg（${key} / ${label}）`);
      console.error(`  原因：${e.message}`);
      process.exit(1);
    }
  }

  const body =
    `/* eslint-disable */\n` +
    `// ⚠️ 本文件是**生成物**，请勿手改。\n` +
    `// 改图标请改 scripts/gen-sel-icons.mjs 里的 ICONS 清单，然后重跑：\n` +
    `//     node scripts/gen-sel-icons.mjs\n` +
    `//\n` +
    `// 源：思源自带 Tabler Icons（MIT 许可）\n` +
    `//     ${ICON_DIR}\n` +
    `//\n` +
    `// 为什么内联而不是运行时引用目录：插件跑在 iframe/renderer 进程，读不到文件系统；\n` +
    `// 且插件会分发到别的机器，不能依赖思源工作空间的私有目录。\n\n` +
    `/** key 名与 ReaderView.svelte / 书架组件里 SEL_ICONS.xxx 的引用一一对应，勿改名 */\n` +
    `export const SEL_ICONS: Record<string, string> = {\n` +
    parts.map((p) => `  ${p.key}: \`${p.svg}\`, // ${p.label}`).join("\n") +
    `\n};\n`;

  require("fs").writeFileSync(OUT, body, "utf-8");
  console.log(`\n已生成 ${OUT.pathname.split("/").pop()}（${ICONS.length} 枚）`);
  return body;
}

function check(generated) {
  const fs = require("fs");
  if (!fs.existsSync(OUT)) {
    console.error("✗ 生成物不存在，请先跑 node scripts/gen-sel-icons.mjs");
    process.exit(1);
  }
  const onDisk = fs.readFileSync(OUT, "utf-8");
  if (onDisk !== generated) {
    console.error("✗ 生成物与源文件不同步 —— 请重跑 node scripts/gen-sel-icons.mjs");
    process.exit(1);
  }
  console.log("✓ 生成物与源文件同步");
}

// ESM 里用 createRequire 拿 fs（脚本本身是 .mjs）
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const generated = generate();
if (process.argv.includes("--check")) check(generated);