/**
 * node:os / os、node:child_process / child_process、node:net / net 的惰性 shim。
 * 产物中暂无 child_process/net 的 require（防御性覆盖，防依赖升级引入）。
 */
import { nodeFn, nodeObj } from "./lazy-node.ts";

export const platform = nodeFn("os", "platform", () => "browser");
export const tmpdir = nodeFn("os", "tmpdir", () => "");
export const homedir = nodeFn("os", "homedir", () => "");
export const EOL = "\n";

export default nodeObj("os");
