/**
 * 批注 store 全局单例（阅读器独立插件）
 * ----------------------------------------------------------------
 * 本地持久化实现（2026-10-13 迁移）：数据存储在阅读器插件自身的
 * `hiword-annotations.json` 中，不再依赖主插件的 bridge。
 *
 * 初始化流程：
 *   1. 首次调用 getAnnotationStore() 时惰性创建实例
 *   2. index.ts onload 中调用 store.init(plugin) 绑定持久化层
 *   3. index.ts onunload 中调用 store.flush() 确保数据落盘
 */
import { AnnotationStore } from "./annotation-store.ts";

let instance: AnnotationStore | null = null;

/** 获取全局批注数据层单例（首次调用时惰性创建） */
export function getAnnotationStore(): AnnotationStore {
  if (!instance) instance = new AnnotationStore();
  return instance;
}

/** 初始化持久化层（由 index.ts 在 onload 中调用，传入 plugin 引用） */
export function initAnnotationStore(plugin: any): void {
  const store = getAnnotationStore();
  store.init(plugin);
}

/** 强制落盘（由 index.ts 在 onunload 中调用） */
export async function flushAnnotationStore(): Promise<void> {
  const store = getAnnotationStore();
  if (store) await store.flush();
}

/** 由入口显式注入（可选，兼容旧调用方式） */
export function setAnnotationStore(s: AnnotationStore): void {
  instance = s;
}
