// 跨平台拷贝 dist 产物到插件根目录（替代 npm script 中的 `cp`，兼容 Windows）。
// 用法：node scripts/copy-dist.mjs
//
// 2026-09-04 P0：全脚本不执行任何删除。此前对 cmaps/ standard_fonts/ 先 rmSync 再 cpSync，
// 单次删除 170+ 文件，会触发批量删除保护使构建中断；改为 cpSync(force:true) 覆盖写，
// 效果等价（同名文件被覆盖）且不产生删除动作。
//
// 2026-10-26 修复：PDF 三件套（pdf.worker.mjs / cmaps/ / standard_fonts/）原是
// 「从 src/reader/vendor/foliate-js/vendor/pdfjs/ 拷到插件根」。但那三个源路径
// **从未进过 git**（仓库里只有 pdf.worker.mjs.map），真实来源是 foliate-js 的
// rollup 从 node_modules/pdfjs-dist 拷的——而 node_modules/ 被 .gitignore 排除，
// 不在本仓库安装 ⇒ 拷贝步骤永远拿不到源，`npm run build` 一直以退出码 1 结束。
// 后果：发版命令 `npm run make`（check && build && make_release.py）在 build 这一步断链。
//
// 现在的口径：**这三个文件直接以插件根的形态入库**（git 跟踪 pdf.worker.mjs、
// cmaps/ 169 个 .bcmap、standard_fonts/ 16 个 .pfb），运行时由思源 webview 经
// `/plugins/siyuan-plugin-reader/` 读取，无需构建期搬运。
// 因此这里从「拷贝」改为「校验就位」——缺了就报错（不是可选项：
//   · 缺 pdf.worker.mjs ⇒ 桌面端解析 PDF 元数据/封面失败；
//   · 缺 cmaps/ ⇒ CJK PDF 中文显示为方块，PDF.js 抛 "cMapUrl/cMapPacked required"；
//   · 缺 standard_fonts/ ⇒ PDF 1.7 之前引用的 Type1 字体拿不到）。
import { copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const files = [
  // 主 bundle + 样式
  ["dist/index.js", "index.js"],
  ["dist/style.css", "index.css"],
];

let ok = true;
for (const [src, dest] of files) {
  const srcPath = resolve(ROOT, src);
  const destPath = resolve(ROOT, dest);
  if (!existsSync(srcPath)) {
    console.error(`[copy-dist] 未找到 ${src}，请先运行 vite build`);
    ok = false;
    continue;
  }
  copyFileSync(srcPath, destPath);
  console.log(`[copy-dist] ${src} -> ${dest}`);
}

// PDF 三件套：已以插件根形态入库，这里只校验就位（见文件头注释）。
const pdfAssets = [
  ["pdf.worker.mjs", "file", "桌面端解析 PDF 元数据/封面"],
  ["cmaps", "dir", "CJK PDF 中文（缺了显示为方块）"],
  ["standard_fonts", "dir", "PDF 1.7 之前引用的 Type1 字体"],
];
for (const [name, kind, why] of pdfAssets) {
  const p = resolve(ROOT, name);
  const exists = existsSync(p);
  // 目录要求非空（空目录等于没有资源）
  const nonEmpty = !exists
    ? false
    : kind === "file"
      ? statSync(p).isFile()
      : statSync(p).isDirectory() && readdirSync(p).length > 0;
  if (!nonEmpty) {
    console.error(`[copy-dist] 缺少 ${name}（${kind}）—— 影响：${why}`);
    ok = false;
    continue;
  }
  console.log(`[copy-dist] ${name} 已就位（${why}）`);
}

if (!ok) process.exit(1);
