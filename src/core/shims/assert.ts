/**
 * node:assert / assert 的惰性 shim。
 * js-mdict 以 `assert_1.default(cond)` 直调形态使用 —— default 代理承接。
 * 移动端断言全部通过（no-op）：宁可让解析走到底再报"词典 MISSING"，
 * 也不让断言抛错炸掉插件加载。
 */
import { nodeObj, nodeFn } from "./lazy-node.ts";

const MOD = "assert";

export const ok = nodeFn(MOD, "ok");
export const strict = nodeObj(MOD);
export const strictEqual = nodeFn(MOD, "strictEqual");
export const deepEqual = nodeFn(MOD, "deepEqual");
export const equal = nodeFn(MOD, "equal");
export const notEqual = nodeFn(MOD, "notEqual");
export const fail = nodeFn(MOD, "fail");
export const throws = nodeFn(MOD, "throws");
export const doesNotThrow = nodeFn(MOD, "doesNotThrow");

export default nodeObj(MOD);
