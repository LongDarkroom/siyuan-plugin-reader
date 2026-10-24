/** node:zlib / zlib 的惰性 shim（js-mdict 的 inflateSync 走这里）。 */
import { nodeFn, nodeObj } from "./lazy-node.ts";

const MOD = "zlib";

export const inflateSync = nodeFn(MOD, "inflateSync", () => null);
export const gunzipSync = nodeFn(MOD, "gunzipSync", () => null);
export const deflateSync = nodeFn(MOD, "deflateSync", () => null);
export const gzipSync = nodeFn(MOD, "gzipSync", () => null);

export default nodeObj(MOD);
