/**
 * 阅读器本地生词本（2026-11-20 · 方案 C 去耦）
 * ================================================================
 * 此前词典卡的 ★ / 朗读面板「收词」直接读写 REword 插件的词库单例
 * （`hiword-vocab.json`）：REword 未装/未启用时功能整体失效，且数据落在别人的命名空间。
 *
 * 现在真源在本插件自己的 petal：`reader-vocab.json`。
 *   - 键名沿用「原始单词小写」，同一词的不同大小写视为一条；
 *   - 写盘做 400ms 防抖（「一键收词」会连续 add 几十个词）；
 *   - 读失败/文件损坏一律从空集合启动，不影响阅读。
 *
 * 2026-11-20：词条开始携带可选的词典/出处快照（音标、词性、释义、原句、
 * 书名、章节），供「我的标记 → 生词」列表直接展示。旧版 `word + addedAt`
 * 数据仍可读取，缺失字段只在 UI 上隐藏，不做迁移写回。
 *
 * 只暴露 UI 实际用到的同步方法（has/add/remove/list/subscribe）+ flush：
 * 阅读器弹窗的 ☆ 是**乐观翻转**（点击即改样式、不 await），异步写失败
 * 至多丢一条记录，不应阻塞交互。
 */

/** 新建/合并词条时可携带的出处与释义快照 */
export interface VocabSeed {
  /** 原始单词（store 内统一小写去重） */
  word: string;
  /** 恢复撤销时用；新建词条不传则取当前时间 */
  addedAt?: number;
  phonetic?: string;
  /** 词性，如 n. / v. / adj. */
  pos?: string;
  /** 首选中文释义 */
  meaning?: string;
  /** 收词时的原句/选区上下文 */
  sentence?: string;
  bookId?: string;
  bookTitle?: string;
  chapter?: string;
}

export interface VocabEntry extends VocabSeed {
  /** 归一化后的单词（小写） */
  word: string;
  addedAt: number;
}

interface VocabFile {
  version: 1;
  words: VocabEntry[];
}

const FILE_KEY = "reader-vocab.json";
const SAVE_DEBOUNCE_MS = 400;

const TEXT_FIELDS = ["phonetic", "pos", "meaning", "sentence", "bookId", "bookTitle", "chapter"] as const;

function cleanText(v: unknown, max = 600): string {
  return String(v ?? "").trim().slice(0, max);
}

export class ReaderVocabStore {
  private words = new Map<string, VocabEntry>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private loaded = false;
  /**
   * 是否有「还没落盘的变更」。
   *
   * 2026-11-25 无限重载修复：思源（3.8.x）把「插件 petal 数据写盘」当作插件重载信号
   * （内核 push_reload：`dataChanges=[siyuan-plugin-reader]` → 所有前端重新加载该插件）。
   * 而 unload 时若**无条件**写盘，就会形成自激回路：
   *   重载 → 旧实例 onunload → flush 写盘 → 内核广播重载 → 重载 → …
   * 实测频率约 1 次/秒，症状是顶栏图标反复消失、页签内容被反复清空（UI 像被压扁/半渲染）、
   * 控制台刷 `WebSocket is closed. Reconnect will be attempted…`。
   * 因此写盘必须由脏标记门控：没变过就一个字节都不写。
   */
  private dirty = false;
  private listeners = new Set<() => void>();

  constructor(
    private io: {
      load: (file: string) => Promise<any>;
      save: (file: string, data: unknown) => Promise<void>;
    },
  ) {}

  private static norm(word: string): string {
    return String(word || "").trim().toLowerCase();
  }

  private static entryFrom(raw: any, fallbackAt = Date.now()): VocabEntry | null {
    const word = ReaderVocabStore.norm(raw?.word);
    if (!word) return null;
    const addedAt = Number(raw?.addedAt);
    const entry: VocabEntry = {
      word,
      addedAt: Number.isFinite(addedAt) && addedAt > 0 ? addedAt : fallbackAt,
    };
    for (const k of TEXT_FIELDS) {
      const v = cleanText(raw?.[k]);
      if (v) entry[k] = v;
    }
    return entry;
  }

  private emit(): void {
    for (const fn of [...this.listeners]) {
      try { fn(); } catch { /* 单个订阅者失败不打断其他 UI */ }
    }
  }

  /** 订阅词库变化；返回取消订阅函数。面板在 onMount 内登记即可。 */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /** 载入持久化数据（onload 时调用一次） */
  async load(): Promise<void> {
    try {
      const raw = await this.io.load(FILE_KEY);
      const list: any[] = Array.isArray(raw?.words) ? raw.words : [];
      for (const it of list) {
        const entry = ReaderVocabStore.entryFrom(it);
        if (entry) this.words.set(entry.word, entry);
      }
    } catch (e) {
      // 损坏/首次运行：从空集合启动
      this.words.clear();
    }
    this.loaded = true;
    this.dirty = false; // 刚读进来的内容与磁盘一致
    this.emit();
  }

  get ready(): boolean {
    return this.loaded;
  }

  count(): number {
    return this.words.size;
  }

  hasWord(word: string): boolean {
    const w = ReaderVocabStore.norm(word);
    return !!w && this.words.has(w);
  }

  /** 全部词条快照（按加入时间倒序；调用方可再过滤/排序） */
  list(): VocabEntry[] {
    return [...this.words.values()]
      .sort((a, b) => b.addedAt - a.addedAt)
      .map((it) => ({ ...it }));
  }

  /**
   * 加入词条。已存在时只补空字段，不覆盖用户已有释义/原句，
   * 也不改原 addedAt —— 列表顺序保持「第一次加入」的时间。
   */
  addWord(input: string | VocabSeed): void {
    const seed: VocabSeed = typeof input === "string" ? { word: input } : input;
    const w = ReaderVocabStore.norm(seed?.word);
    if (!w) return;

    const existing = this.words.get(w);
    if (existing) {
      let changed = false;
      for (const k of TEXT_FIELDS) {
        if (existing[k]) continue;
        const v = cleanText((seed as any)?.[k]);
        if (!v) continue;
        existing[k] = v;
        changed = true;
      }
      if (changed) {
        this.scheduleSave();
        this.emit();
      }
      return;
    }

    const entry = ReaderVocabStore.entryFrom({ ...seed, word: w });
    if (!entry) return;
    this.words.set(w, entry);
    this.scheduleSave();
    this.emit();
  }

  removeWord(word: string): void {
    const w = ReaderVocabStore.norm(word);
    if (!w || !this.words.delete(w)) return;
    this.scheduleSave();
    this.emit();
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, SAVE_DEBOUNCE_MS);
  }

  /** 立即落盘（onunload / 插件卸载时调用，避免丢掉防抖窗口内的词） */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    // 没变过 → 不写。写了会让思源把这当成「插件数据变更」并重载整个插件，
    // unload 又回到这里，形成每秒一次的无限重载（见 dirty 字段注释）。
    if (!this.dirty) return;
    const data: VocabFile = { version: 1, words: [...this.words.values()] };
    try {
      await this.io.save(FILE_KEY, data);
      this.dirty = false;
    } catch {
      /* 写盘失败不打断阅读；下次有变更会再试 */
    }
  }
}