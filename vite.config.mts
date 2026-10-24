import { defineConfig } from "vite";
import { resolve } from "path";
import { readFileSync } from "fs";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// 构建期从 plugin.json 读取版本号，注入为 __REWORD_VERSION__。
// 沿用主插件做法：plugin.json 是思源集市认的清单（唯一真源），
// 设置面板「关于」页从构建期注入值读取，发版只改 plugin.json 一处。
const PLUGIN_VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(resolve(__dirname, "plugin.json"), "utf8")).version || "";
  } catch {
    return "";
  }
})();

export default defineConfig({
  base: "./",
  plugins: [svelte()],
  // 构建期注入真实时间戳，供 `window.__REWORD_BUILD_INFO__.buildTime` 判断
  // 「当前加载的是不是最新产物」（排查时容易误以为加载了新包其实是旧的）。
  define: {
    __REWORD_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __REWORD_VERSION__: JSON.stringify(PLUGIN_VERSION),
  },
  build: {
    target: "esnext",
    outDir: "dist",
    // 与主插件一致：不��空 dist。避免触发批量文件删除保护；
    // 本工程 inlineDynamicImports，产物恒为 index.js + style.css 两个固定文件名。
    emptyOutDir: false,
    minify: "esbuild",
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      formats: ["cjs"],
      fileName: () => "index.js",
      cssFileName: "index",
    },
    rollupOptions: {
      // 仅 siyuan 保持 external —— 运行时由思源宿主提供（桌面与移动端都注入）。
      // Node 内置模块（js-mdict 依赖 node:fs/node:zlib/node:assert）2026-10-24 起
      // 不再 external：移动端无 Node 运行时，顶层 require 会崩掉整个插件加载，
      // 已改为别名到 src/core/shims/ 惰性 shim（见上方 alias 注释）。
      external: [
        "siyuan",
      ],
      output: {
        // 禁用代码分割，将所有代码（含 Svelte 运行时）打包到单个 index.js，兼容 cjs 格式
        inlineDynamicImports: true,
      },
    },
  },
  resolve: {
    alias: [
      { find: "@", replacement: resolve(__dirname, "src") },
      // 2026-10-24 移动端加载修复：Node 内置模块不再 external（产物顶层 require("fs")
      // 在移动端 WebView 求值即崩，插件类注册不上 → 顶栏图标/页签全不出现），
      // 改为别名到 src/core/shims/ 的惰性转发 shim：
      //   模块求值零 require；桌面端首次调用经宿主 require 拿真实实现（行为不变），
      //   移动端返回安全空值自然降级（词典 MISSING / 日志不落盘，插件正常加载）。
      { find: /^node:fs$/, replacement: resolve(__dirname, "src/core/shims/fs.ts") },
      { find: /^fs$/, replacement: resolve(__dirname, "src/core/shims/fs.ts") },
      { find: /^node:path$/, replacement: resolve(__dirname, "src/core/shims/path.ts") },
      { find: /^path$/, replacement: resolve(__dirname, "src/core/shims/path.ts") },
      { find: /^node:zlib$/, replacement: resolve(__dirname, "src/core/shims/zlib.ts") },
      { find: /^zlib$/, replacement: resolve(__dirname, "src/core/shims/zlib.ts") },
      { find: /^node:assert$/, replacement: resolve(__dirname, "src/core/shims/assert.ts") },
      { find: /^assert$/, replacement: resolve(__dirname, "src/core/shims/assert.ts") },
      { find: /^node:os$/, replacement: resolve(__dirname, "src/core/shims/os.ts") },
      { find: /^os$/, replacement: resolve(__dirname, "src/core/shims/os.ts") },
      { find: /^node:(child_process|net)$/, replacement: resolve(__dirname, "src/core/shims/empty.ts") },
      { find: /^(child_process|net)$/, replacement: resolve(__dirname, "src/core/shims/empty.ts") },
    ],
  },
  publicDir: "public",
});
