/**
 * node:fs / fs 的惰性 shim（vite alias 指向本文件，见 lazy-node.ts 头注释）。
 * 成员清单 = src 全库实际用到的 + js-mdict 用到的（openSync/readSync/closeSync）
 * + 少量防御性补充；未列出的成员走 default 代理兜底。
 */
import { nodeFn, nodeObj } from "./lazy-node.ts";

const MOD = "fs";

export const existsSync = nodeFn(MOD, "existsSync", () => false);
export const readFileSync = nodeFn(MOD, "readFileSync", () => "");
export const writeFileSync = nodeFn(MOD, "writeFileSync");
export const appendFileSync = nodeFn(MOD, "appendFileSync");
export const appendFile = nodeFn(MOD, "appendFile");
export const mkdirSync = nodeFn(MOD, "mkdirSync");
export const readdirSync = nodeFn(MOD, "readdirSync", () => []);
export const unlinkSync = nodeFn(MOD, "unlinkSync");
export const renameSync = nodeFn(MOD, "renameSync");
export const copyFileSync = nodeFn(MOD, "copyFileSync");
export const statSync = nodeFn(MOD, "statSync", () => ({ isFile: () => false, isDirectory: () => false, size: 0, mtimeMs: 0 }));
export const openSync = nodeFn(MOD, "openSync", () => -1);
export const readSync = nodeFn(MOD, "readSync", () => 0);
export const closeSync = nodeFn(MOD, "closeSync");
export const fstatSync = nodeFn(MOD, "fstatSync", () => ({ isFile: () => false, size: 0 }));

/** fs.promises（logger 的异步落盘走这里） */
export const promises = nodeObj(MOD);
/** __importDefault(require("fs")) 等默认导入互操作兜底 */
export default nodeObj(MOD);
