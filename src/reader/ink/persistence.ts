/**
 * Apple Pencil 墨迹 · 持久化（saveData 包装）
 * ----------------------------------------------------------------
 * 2026-09-04 P0-3 补完：墨迹原本只在内存（Svelte store），重启思源后丢失。
 * 这里走思源官方 saveData / loadData 持久化到 `hiword-ink.json`，
 * 与方案 C「独立存储、正文零污染」一致——不写 PDF 也不写思源块。
 *
 * 设计要点：
 *  - 全部笔触一个文件：每条 InkStroke 自带 bookId + pageIndex，索引天然
 *  - PersistentStore 防抖（400ms 合并高频 stroke 写入）+ 退避重试
 *  - 容错：loadData 失败 / 非法 JSON → 静默降级空集合
 *  - 切书不重读盘：loadInk() 一次性灌入 inkStrokes，切书时按 bookId 过滤
 *  - flush() 在 onunload / dock 关闭时强制落盘，防抖中数据丢失兜底
 *
 * 不依赖：foliate / siyuan SDK
 */
import { PersistentStore } from "../../core/persist.ts";
import { getLogger } from "../../core/logger.ts";
import type { InkStroke } from "./types.ts";

/** 持久化结构（落盘 JSON） */
export interface InkPersisted {
  /** 格式版本号（v1 = 2026-09-04 首版）。未来字段迁移时按 rev 判定路径。 */
  rev: number;
  /** 全部墨迹笔触，按 bookId + pageIndex 已被字段自带，无须额外分组。 */
  strokes: InkStroke[];
}

/** 当前格式版本 */
const INK_PERSIST_REV = 1;

/** 落盘文件名（与 index.ts 的 saveData 列表配对） */
export const INK_STORAGE_KEY = "hiword-ink.json";

/**
 * 容错反序列化：loadData 拿到的 raw 可能是 undefined / null / 旧格式 / 损坏 JSON。
 * 任何异常都不抛错，只回退到空集合。
 */
export function parseInkPersisted(raw: unknown): InkStroke[] {
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as Partial<InkPersisted>;
  // 兼容未来版本：rev 不匹配时仍尝试读 strokes 字段（增量迁移友好）
  const list = Array.isArray(obj.strokes) ? obj.strokes : [];
  const valid: InkStroke[] = [];
  for (const it of list) {
    if (
      it && typeof it === "object" &&
      typeof (it as any).id === "string" &&
      typeof (it as any).bookId === "string" &&
      typeof (it as any).pageIndex === "number" &&
      Array.isArray((it as any).points)
    ) {
      valid.push(it as InkStroke);
    }
  }
  return valid;
}

/**
 * 序列化全部笔触为 InkPersisted。纯函数，便于单测。
 */
export function serializeInkPersisted(strokes: readonly InkStroke[]): InkPersisted {
  return { rev: INK_PERSIST_REV, strokes: [...strokes] };
}

/**
 * 墨迹持久化器。
 * 用法：
 *   const saver = new InkSaver(
 *     (d) => this.saveData(KEY, d),
 *     () => this.loadData(KEY)
 *   );
 *   await saver.load();                    // 启动时灌入内存
 *   saver.attach(inkStrokes);              // 一次性绑定：seed store + 订阅自动落盘
 *   await saver.flush();                   // onunload 强制落盘
 *
 * 设计：attach 是幂等的——多次调用只 seed 一次（第一次），之后只多挂订阅。
 * 多个 ReaderView Tab 共用一个 InkSaver 时不会重复触发落盘：
 *   - 第一次 attach：seed + 订阅
 *   - 后续 attach：仅多挂一个订阅
 *   - 共享的 `this.current` 内部去重（v === this.current 短路）
 */
export class InkSaver {
  private readonly store: PersistentStore;
  private current: InkStroke[] = [];
  private readonly loadData: () => Promise<unknown>;
  /** 是否已 seed 过 store（attach 内部用，避免多 Tab 重复 seed） */
  private seeded = false;
  /**
   * 上次「已落盘 / 已排队落盘」的内容指纹（JSON 串）。
   * 与当前 store 内容一致时**不再写盘** —— 写盘会让思源重载整个插件（见 attach 注释）。
   */
  private lastSavedKey: string | null = null;

  constructor(
    save: (data: unknown) => Promise<void>,
    loadData: () => Promise<unknown>
  ) {
    this.store = new PersistentStore(save, {
      delay: 400,
      retries: 3,
      onError: (e) => {
        getLogger().warn("[REword-Ink] 墨迹保存失败:", { error: e });
      },
    });
    this.loadData = loadData;
  }

  /**
   * 启动时一次性加载：把磁盘上所有笔触塞到内存数组。
   * 失败/无数据时回退到空数组（不抛错）。
   */
  async load(): Promise<InkStroke[]> {
    try {
      const raw = await this.loadData();
      this.current = parseInkPersisted(raw);
      // 磁盘内容 = 当前内容：记下指纹，后续没有真改动就不写盘
      this.lastSavedKey = JSON.stringify(serializeInkPersisted(this.current));
      getLogger().info(`[REword-Ink] 墨迹加载完成（${this.current.length} 笔）`);
    } catch (e) {
      getLogger().warn("[REword-Ink] 墨迹加载失败，从空集合启动:", { error: e });
      this.current = [];
      this.lastSavedKey = JSON.stringify(serializeInkPersisted(this.current));
    }
    return this.current;
  }

  /**
   * 把 current 灌到 store（仅首次，后续 no-op）。
   * 用于 onload 时显式把磁盘数据写回 Svelte store。
   */
  seedStore(inkStrokes: { set: (arr: InkStroke[]) => void }): void {
    if (this.seeded) return;
    this.seeded = true;
    inkStrokes.set([...this.current]);
  }

  /**
   * 一次性订阅 inkStrokes：每次变化 → 同步 current → 防抖落盘。
   * attach 是幂等的：
   *   - 首次调用：seed + 订阅
   *   - 后续调用：只多挂一个订阅（不重复 seed，store 已有正确数据）
   * 订阅内部用 `v === this.current` 短路避免重复写盘——
   * 多 Tab 共享时，每个 store.set 会触发所有订阅，每个订阅拿到的 v 引用相同，
   * 第一个写完 current 后，其余订阅发现 v === current 直接跳过。
   */
  attach(inkStrokes: { set: (arr: InkStroke[]) => void; subscribe: (fn: (v: InkStroke[]) => void) => () => void }): () => void {
    if (!this.seeded) {
      this.seeded = true;
      inkStrokes.set([...this.current]);
    }
    // 2026-11-25 无限重载修复 —— 两处保险，缺一不可：
    //  ① svelte/store 的 subscribe 会**同步回调一次当前值**（正是上面 seed 进去的那份），
    //     它不是用户改动。旧代码把它当成改动 → update → 400ms 后写 hiword-ink.json。
    //  ② 思源（3.8.x）把「插件 petal 写盘」当作插件重载信号（内核 push_reload：
    //     `dataChanges=[siyuan-plugin-reader]` → 所有前端重新加载该插件）。于是：
    //       插件加载 → attach 误判一次改动 → 写盘 → 内核广播重载 → 插件再加载 → …
    //     实测每秒 1 次，症状：顶栏图标反复消失、页签内容被反复清空（UI 像被压扁/半渲染）、
    //     控制台刷 `WebSocket is closed. Reconnect will be attempted…`。
    //     所以「内容与上次落盘一致」时不写盘（用序列化结果比对，比引用比对更稳）。
    let primed = false;
    return inkStrokes.subscribe((v) => {
      if (!primed) {
        primed = true;
        return;
      }
      // 同样的 v 引用 → current 已经是这个值 → 跳过 save
      if (v === this.current) return;
      const payload = serializeInkPersisted(v);
      const key = JSON.stringify(payload);
      if (key === this.lastSavedKey) return;
      this.lastSavedKey = key;
      this.current = [...v];
      this.store.update(payload);
    });
  }

  /**
   * 旧 API 兼容：等价于 attach()。
   * 保留以便未来 import 不会因为重命名而 break。
   * @deprecated 使用 attach() 替代
   */
  bindToStore(inkStrokes: Parameters<InkSaver["attach"]>[0]): () => void {
    return this.attach(inkStrokes);
  }

  /**
   * 切书时调用：用指定 bookId 的笔触替换 current，并同步到 store。
   * 不落盘——磁盘上是全部笔触，切书不改磁盘内容。
   * 当前设计已不需要（inkStrokes 保留全局全量，currentPageStrokes 派生过滤），
   * 但保留入口以便未来按需切分。
   */
  setStrokesForBook(strokes: InkStroke[]): void {
    this.current = [...strokes];
  }

  /** 当前内存中的全部笔触（只读视图） */
  getStrokes(): readonly InkStroke[] {
    return this.current;
  }

  /** 立即落盘（onunload / dock 关闭时调用） */
  async flush(): Promise<void> {
    await this.store.flush();
  }
}
