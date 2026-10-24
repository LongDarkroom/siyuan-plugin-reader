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
      // siyuan 与 node 内置模块（js-mdict 依赖 node:fs/node:zlib/node:assert）保持外部，
      // 运行时由 SiYuan(Electron) 提供；js-mdict 自身逻辑则打包进 index.js。
      external: [
        "siyuan",
        "node:fs",
        "node:path",
        "node:zlib",
        "node:assert",
        "node:os",
        "node:child_process",
        "node:net",
        "fs",
        "path",
        "zlib",
        "assert",
        "os",
        "child_process",
        "net",
      ],
      output: {
        // 禁用代码分割，将所有代码（含 Svelte 运行时）打包到单个 index.js，兼容 cjs 格式
        inlineDynamicImports: true,
      },
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  publicDir: "public",
});
