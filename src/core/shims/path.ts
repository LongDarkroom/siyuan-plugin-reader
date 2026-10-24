/** node:path / path 的惰性 shim（见 lazy-node.ts 头注释）。 */
import { nodeFn, nodeObj } from "./lazy-node.ts";

const MOD = "path";

export const join = nodeFn(MOD, "join", (...a: any[]) =>
  a.filter((s) => typeof s === "string" && s).join("/"));
export const basename = nodeFn(MOD, "basename", (p: any = "") =>
  String(p).split("/").pop() ?? "");
export const dirname = nodeFn(MOD, "dirname", (p: any = "") => {
  const parts = String(p).split("/");
  parts.pop();
  return parts.join("/");
});
export const normalize = nodeFn(MOD, "normalize", (p: any = "") => String(p));
export const resolve = nodeFn(MOD, "resolve", (...a: any[]) =>
  a.filter((s) => typeof s === "string" && s).join("/"));
export const isAbsolute = nodeFn(MOD, "isAbsolute", (p: any = "") =>
  String(p).startsWith("/"));

export default nodeObj(MOD);
