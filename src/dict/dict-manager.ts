/**
 * 词典管理（含导入接口）
 * ----------------------------------------------------------------
 * 切分自主插件 `index.ts` 的词典相关方法（loadDictManifest / initDictionary /
 * dictFileExists / loadDictFile / dictLangGroup）。
 *
 * 与主插件的差异：
 *   - 主插件初始化后会 `refreshActivePanel()`（dock 面板联动）；本插件无 dock，
 *     就绪后只打日志 + 置 `ready` 标志，划词查词直接读引擎。
 *   - 落盘键沿用 `hiword-dicts.json`（保持用户已有词典配置不丢）。
 *
 * 决策 G：**仓库与发版包不含词典实包**（约 77 MB），由用户经
 *   `importDictFile()` 导入到插件 `dict/` 目录。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getLogger } from "../core/logger.ts";
import { logSwallow } from "../core/safe.ts";
import * as dictEngine from "../dict/dict-engine.ts";
// 2026-10-08：导入前格式校验 + 内容哈希（详见两个模块的注释）
import { validateDictFile, dictContentHash } from "./dict-validate.ts";
// 2026-10-07：导入流程的错误提示需 i18n（此前本文件错误文案全为硬编码中文，
// 此次仅为 importDictFile 的新提示引入 t，不改动既有文案口径）
import { t } from "../i18n/index.ts";
import { resolvePluginPathWithFs, isPluginRootWithFs } from "../core/plugin-path.ts";

/** 插件名（用于插件目录身份校验；与 plugin.json 的 name 一致） */
const PLUGIN_NAME = "siyuan-plugin-reader";

/** 词典清单落盘键（沿用主插件，保持用户已有配置不丢） */
const DICT_MANIFEST_KEY = "hiword-dicts.json";

/**
 * 稳定序列化：递归按 key 排序后再 JSON.stringify。
 *
 * 用途只有一个 —— 判断「这份清单和上次落盘的是不是同一份」（见 saveManifest）。
 * 直接用 JSON.stringify 会被对象字面量顺序影响（迁移时给条目补 `type` 字段就会变序），
 * 从而误判成「变了」并白写一次盘，又触发一次插件重载。
 */
function stableKey(v: unknown): string {
  const walk = (x: any): any => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") {
      const out: Record<string, any> = {};
      for (const k of Object.keys(x).sort()) out[k] = walk(x[k]);
      return out;
    }
    return x;
  };
  return JSON.stringify(walk(v));
}

/**
 * 内置词典（ncecd）。
 *
 * 决策 G 之后发版包**不含**词典实包 ⇒ 多数用户的 dict/ 里没有这个文件。
 * 2026-11-20：条目不再无条件补回 —— 文件不存在就整条剔除，
 * 否则设置页会常驻一条永远启用失败的「幽灵词典」。
 */
const BUILTIN_DICT: DictMeta = {
  id: "ncecd",
  name: "牛津核心词（内置）",
  file: "ncecd.mdx",
  type: "mdx",
  lang: "en",
  builtin: true,
};

/** 词典元信息 */
export interface DictMeta {
  id: string;
  name: string;
  /** 相对 dict/ 目录的文件名（stardict 为 .ifo 主文件） */
  file: string;
  /** stardict 需成套文件（.ifo/.idx/.dict） */
  files?: string[];
  /**
   * 2026-10-07：MDX 伴生资源包文件名（同名 .mdd）。
   *
   * 背景：js-mdict 的 MDX 词条里可以引用相对路径的图片 / CSS / 字体 / 音频，
   *   这些资源打包在同名的 `.mdd` 文件里。dict-engine 的 `initMdd()` 一直支持
   *   挂载，但 **DictManager 从没记录也没调用它** → 用户导入了带 .mdd 的词典后，
   *   词条文字能查出来，但图片全裂。
   * 规则：与 `file` 同目录同名的 .mdd（`x.mdx` → `x.mdd`），不存在则静默跳过。
   */
  mdd?: string;
  type: "mdx" | "stardict";
  /**
   * 2026-10-07 扩容：新增 "idiom"（成语词典）。
   *
   * 现状 `langGroup()` 把一切非 zh 都当 en，导致「同一个语种内强制单选」——
   *   用户同时装两本英汉词典时，启用了第二本就会连带卸载第一本。
   * 成语词典单列一类的原因：它查的是中文成语，但**不该占用中文词典的名额**
   *   （两本中文词典可以并存，成语词典与它们也是并存关系，不是替代关系）。
   * 本期界面只展示「中文词典 / 英文词典」两组，`idiom` 先在数据层可用。
   */
  lang: "zh" | "en" | "idiom";
  builtin?: boolean;
  /**
   * 文件内容哈希（2026-10-08 新增，对标 Readest「内容哈希做身份」）。
   *
   * 用途：识别「同一本词典的重复导入」。
   * 有了它，重复导入同一份文件会**替换**原记录而不是新增 ——
   * 否则列表里会出现两本同名词典，且用户的启用态被割裂
   * （两本同内容、只有一本被启用，看起来就像「导入没生效」）。
   *
   * 取首尾各 4KB 做 FNV-1a（见 dictContentHash 的注释：不是密码学哈希）。
   * 存量清单没有这个字段 ⇒ `undefined`，不会误判重复。
   */
  contentHash?: string;
}

/**
 * 词典清单
 *
 * 2026-10-07 语义澄清（此前两个字段的含义是错位的）：
 * - `actives`（复数）= **所有已启用词典**。可为空、可多本。
 *   旧实现被 `enable()` 覆写成 `[id]`，等于退化成单选 ——
 *   这是「启用一本后就无法启用另一本」的直接原因。
 * - `active`（单数）= **默认词典**，同语种内唯一，作用只是「查询优先级靠前」。
 *   它**不再代表唯一启用的词典**。引擎的 `routeTargets()` 本来就会在
 *   所有已启用词典里按词的文字类型路由，active 只影响谁先被试。
 */
export interface DictManifest {
  active: string;
  /** 所有已启用词典的 id（可多本） */
  actives: string[];
  dicts: DictMeta[];
  /**
   * 词典结果文字大小倍率（2026-10-07，对标 Readest 词典二级页的「字号」）。
   * 0.8 ~ 1.6，默认 1.0。与阅读界面字号**相互独立**（Readest 明确说明这点）——
   * 划词弹窗本来就比正文小，按个人偏好单独调更合理。
   */
  fontScale?: number;
  /**
   * 查词后自动播放发音（2026-10-07，对标 Readest 的「自动播放发音」）。
   * 关：保持现状（只弹释义）；开：查到词后自动读一次（语言自动判定中/英）。
   */
  autoSpeak?: boolean;
  /**
   * 用户**主动**停用过所有词典（2026-10-07 新增）。
   *
   * 为什么需要这个字段：`{active:"", actives:[]}` 这个状态有两种成因，
   *  处理方式完全相反——
   *   a) 首次运行 / 从旧版本升级上来（用户从没管过词典）→ 该给个可用的起点，
   *      否则插件开箱查不了词；
   *   b) 用户明确把所有词典都关了（想去掉内存占用）→ **必须尊重**，
   *      否则重启后又冒出来一本，用户会觉得设置没生效。
   * 光看actives 为空区分不了，只能显式记一个标记。
   *
   * 存量用户（无此字段）一律按 (a) 处理 —— 这与他们的实际意图相符：
   * 旧版本下actives 变空的原因是 bug（启用A → 启用 B 把 A 连带抹掉 → 停用 B），
   * 并非用户主动关闭。
   */
  userDisabledAll?: boolean;
}

export class DictManager {
  private manifest: DictManifest = { active: "", actives: [], dicts: [] };
  private ready = false;
  /**
   * 上次落盘的清单指纹（见 saveManifest 注释）。
   * null = 未知/磁盘内容与内存不一致 → 下一次 saveManifest 照常写。
   */
  private lastSavedKey: string | null = null;
  /** 旧目录→public 的迁移只尝试一次（loadManifest/init 都可能触发） */
  private dictMigrationDone = false;

  constructor(private plugin: any) {}

  /** 词典是否就绪（划词查词入口据此决定是否提示导入） */
  get isReady(): boolean {
    return this.ready;
  }

  /**
   * 有没有 Node 运行时。
   *
   * 桌面端（Electron 渲染进程）有；移动端 WebView、浏览器访问
   * （`http://127.0.0.1:6806` 用外部浏览器打开）都没有 —— 那里的
   * `node:fs` 走 shims 惰性转发，`existsSync` 恒为 **false**。
   * 这点很关键：**不能**把「读不到」当成「文件不存在」，否则一进浏览器
   * 就会把整份词典清单清空（2026-11-26 事故，见 dictDirState 注释）。
   */
  private hasNodeRuntime(): boolean {
    try {
      return typeof process !== "undefined" && !!process.versions;
    } catch {
      return false;
    }
  }

  /**
   * 词典目录绝对路径：`<工作区>/data/public/<插件名>/dict`。
   *
   * 为什么不再放 `plugins/<name>/dict`：商店更新会整目录替换插件目录，
   * 用户导入的词典每次更新都被删（发布包还显式排除 dict/）。
   * 为什么不是 petal：思源 v3.1.8 起写 petal 会广播插件重载（push_reload.go），
   * 且 petal 参与云端同步，上百 MB 词典会把同步打爆。public 不触发重载、不进同步。
   */
  private dictDir(): string | null {
    if (!this.hasNodeRuntime()) return null;
    try {
      const ws = this.workspaceRoot();
      if (ws) return path.join(ws, "data", "public", PLUGIN_NAME, "dict");
      // 回退：插件根是 <ws>/data/plugins/<name>，往上两级即 data/
      const root = this.pluginRoot();
      if (!root) return null;
      return path.join(path.dirname(path.dirname(root)), "public", PLUGIN_NAME, "dict");
    } catch {
      return null;
    }
  }

  /** 旧落点：插件安装目录内（仅迁移/回退用） */
  private legacyDictDir(): string | null {
    if (!this.hasNodeRuntime()) return null;
    try {
      const root = this.pluginRoot();
      return root ? path.join(root, "dict") : null;
    } catch {
      return null;
    }
  }

  /** 工作区根（思源运行时注入；取不到返回空串） */
  private workspaceRoot(): string {
    try {
      const sys = (globalThis as any)?.window?.siyuan?.config?.system;
      const ws: string | undefined = sys?.workspaceDir;
      if (ws && !/app\.asar/i.test(ws)) return ws;
    } catch { /* 沙箱/单测拿不到 window.siyuan */ }
    return "";
  }

  /** 插件根目录；取不到返回空串 */
  private pluginRoot(): string {
    // ⚠️ 移动端 / 浏览器访问时 `process` 根本不存在。旧写法在 catch 分支里
    // 又引用了一次 `process.env`，等于「兜底自己再抛一次」——ReferenceError
    // 冒到 loadManifest，整条词典初始化链路直接崩掉。先挡掉再谈路径。
    if (!this.hasNodeRuntime()) return "";
    let homedir = "";
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      homedir = (require("os").homedir && require("os").homedir()) || process.env.HOME || "";
    } catch {
      homedir = "";
    }
    const env = {
      dirname: typeof __dirname !== "undefined" ? __dirname : "",
      cwd: process.cwd(),
      platform: process.platform,
      homedir,
      appData: process.env.APPDATA || "",
      localAppData: process.env.LOCALAPPDATA || "",
      execPath: process.execPath,
      resourcesPath: (process as any).resourcesPath,
      thisPath: (this.plugin as any)?.path || "",
      pluginName: PLUGIN_NAME,
    };
    const root = resolvePluginPathWithFs(env);
    if (!root || !isPluginRootWithFs(root, PLUGIN_NAME)) return "";
    return root;
  }

  /**
   * 一次性把插件目录里的词典搬到 public（同步 fs，同盘 rename 秒级）。
   *
   * 幂等：目标已存在同名文件就跳过；中途中断下次接着搬。
   * 标记写到 public 根（不写 petal —— 写 petal 会触发插件重载，可能打断迁移）。
   * 迁移失败不删旧文件：resolveDictPath 会回退到旧路径，词典照样能用。
   */
  private migrateLegacyDictDir(): void {
    if (this.dictMigrationDone) return;
    this.dictMigrationDone = true;
    try {
      const dest = this.dictDir();
      const legacy = this.legacyDictDir();
      if (!dest || !legacy || dest === legacy || !fs.existsSync(legacy)) return;
      const names = fs.readdirSync(legacy).filter((n) => !n.startsWith("."));
      if (!names.length) return;
      fs.mkdirSync(dest, { recursive: true });
      const stat = { files: 0, bytes: 0, renamed: 0, copied: 0, failed: 0 };
      for (const name of names) {
        const from = path.join(legacy, name);
        const to = path.join(dest, name);
        try {
          if (!fs.statSync(from).isFile()) continue;
          if (fs.existsSync(to)) continue;
          try {
            fs.renameSync(from, to);
            stat.renamed++;
          } catch {
            fs.copyFileSync(from, to);
            fs.unlinkSync(from);
            stat.copied++;
          }
          stat.files++;
          stat.bytes += fs.statSync(to).size;
        } catch {
          stat.failed++;
        }
      }
      if (!stat.files && !stat.failed) return;
      const marker = path.join(dest, "..", "dict-storage-migration.json");
      fs.writeFileSync(marker, JSON.stringify({
        v: 1,
        at: Date.now(),
        from: legacy,
        to: dest,
        ...stat,
      }, null, 2));
      getLogger().info(`[RE 阅读器] 词典迁移到 public：${stat.files} 个文件 / ${stat.bytes} 字节（失败 ${stat.failed}）`);
    } catch (e) {
      logSwallow(e, "dict-manager.ts · migrateLegacyDictDir", "warn");
    }
  }

  /** 词典文件的绝对路径（新目录优先；迁移失败时回退旧目录，保证还能查词） */
  private resolveDictPath(file: string): string | null {
    const dir = this.dictDir();
    if (!dir) return null;
    const next = path.join(dir, file);
    if (fs.existsSync(next)) return next;
    const legacy = this.legacyDictDir();
    if (legacy) {
      const old = path.join(legacy, file);
      if (fs.existsSync(old)) return old;
    }
    return next;
  }

  /** 语种分组（用于界面分组与「默认词典」的同语种重选） */
  private langGroup(meta: DictMeta): "zh" | "en" | "idiom" {
    return meta.lang === "zh" ? "zh" : meta.lang === "idiom" ? "idiom" : "en";
  }

  /**
   * 目录能不能判定：`ok` 目录在（可判文件真假）、`missing` 目录确实没有、
   * `unknown` 连目录路径都定位不到。
   *
   * 只有 `ok` 才允许把「文件不在」当成事实去删清单条目 —— `unknown` 时
   * 任何删除都是在拿用户数据赌路径解析（2026-11-26 清单被清空的事故）。
   */
  private dictDirState(): "ok" | "missing" | "unknown" {
    if (!this.hasNodeRuntime()) return "unknown"; // 浏览器/移动端读不到文件，不代表文件没了
    const dir = this.dictDir();
    if (!dir) return "unknown";
    try {
      if (fs.existsSync(dir)) return "ok";
      // 迁移没做成时文件还在旧目录，一样算「能判定」
      const legacy = this.legacyDictDir();
      if (legacy && fs.existsSync(legacy)) return "ok";
    } catch {
      return "unknown";
    }
    return "missing";
  }

  /** 按文件名猜语种（与 importDictFile 共用一套规则，避免两处判断分叉） */
  private guessLang(name: string): "en" | "zh" {
    return /(英|english|ecdict|ncecd)/i.test(name) ? "en" : "zh";
  }

  /** 文件名 → 稳定 id：同一文件每次扫描得到同一个 id，不会来回换 */
  private adoptId(name: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < name.length; i++) {
      h ^= name.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `scan-${h.toString(36)}`;
  }

  /**
   * 把目录里「清单没登记」的词典文件补登记。
   *
   * 两个来源都要靠它：
   *  1. 清单被清空过（见 `dictDirState` 的注释）—— 文件在、界面里没有，
   *     不做这一步用户只能把上百 MB 的词典重新导入一遍；
   *  2. 官方提示里那条「请手动放入 dict/ 目录」—— 光把文件拷进去，
   *     以前是永远不会出现在列表里的，提示等于失效。
   *
   * 只认 `.mdx` 与成套的 starDict（.ifo + .idx + .dict/.dict.dz）；
   * `.mdd` 作为同名伴生资源挂到 `.mdx` 上，`.bak` / `README.md` 一律跳过。
   * 幂等：已登记（按文件名，忽略大小写）的不重复加入。
   */
  private adoptUnlistedDicts(m: DictManifest): DictMeta[] {
    const dir = this.dictDir();
    if (!dir) return [];
    let names: string[] = [];
    try {
      if (!fs.existsSync(dir)) return [];
      names = fs.readdirSync(dir).filter((n) => !n.startsWith("."));
    } catch {
      return [];
    }
    const lowerSet = new Set(names.map((n) => n.toLowerCase()));
    const known = new Set(m.dicts.map((d) => path.basename(d.file).toLowerCase()));
    const adopted: DictMeta[] = [];

    for (const name of names) {
      const lower = name.toLowerCase();
      if (known.has(lower)) continue;

      if (lower.endsWith(".ifo")) {
        const base = name.slice(0, -4);
        const has = (ext: string) => lowerSet.has(`${base}${ext}`.toLowerCase());
        if (!has(".idx")) continue;
        if (!has(".dict") && !has(".dict.dz")) continue; // 缺词表 = 半套，不入册
        adopted.push({
          id: this.adoptId(lower),
          name: base,
          file: name,
          files: [".ifo", ".idx", ".dict", ".dict.dz"]
            .map((ext) => `${base}${ext}`)
            .filter((f) => lowerSet.has(f.toLowerCase())),
          type: "stardict",
          lang: this.guessLang(base),
        });
        known.add(lower);
        continue;
      }

      if (!lower.endsWith(".mdx")) continue;
      const mdd = names.find((n) => n.toLowerCase() === lower.replace(/\.mdx$/, ".mdd"));
      adopted.push({
        id: this.adoptId(lower),
        name: name.replace(/\.mdx$/i, ""),
        file: name,
        ...(mdd ? { mdd } : {}),
        type: "mdx",
        lang: this.guessLang(name),
      });
      known.add(lower);
    }

    if (adopted.length) m.dicts.push(...adopted);
    return adopted;
  }

  /** 磁盘文件是否真实存在 */
  private fileExists(meta: DictMeta): boolean {
    try {
      if (meta.type === "stardict") {
        const set = meta.files && meta.files.length ? meta.files : [meta.file];
        return set.every((f) => {
          const fp = this.resolveDictPath(f);
          return !!fp && fs.existsSync(fp);
        });
      }
      const fp = this.resolveDictPath(meta.file);
      return !!fp && fs.existsSync(fp);
    } catch {
      return false;
    }
  }

  /**
   * 加载清单（首次运行写入默认清单）。
   * 容错策略（承自主插件，保证词典开箱即用）：
   *   1) 内置词典被误删 / 清单损坏 → 补回（**仅当文件真实存在**）；
   *   2) 清理磁盘文件已丢失的条目（含内置——发版包不含词典实包）；
   *   3) 激活项必须指向真实存在的文件，否则回退内置。
   */
  private async loadManifest(): Promise<DictManifest> {
    // 必须先搬目录再读清单：清单加载完会按 fileExists() 清理「文件已丢失」的条目，
    // 目录还没搬就清理 = 把用户导入的词典从清单里删干净。
    this.migrateLegacyDictDir();
    let m: DictManifest | null = null;
    /** 磁盘原文的指纹：读完后与归一化结果比对，相同则不必回写 */
    let rawKey: string | null = null;
    try {
      const raw = await this.plugin.loadData(DICT_MANIFEST_KEY);
      // 只有「文件不存在 / 结构不是清单」才算首次运行。
      // 注意**不能**用 `raw.dicts.length` 判断：清单元信息为 `{"dicts":[]}` 是合法状态
      // （用户所有词典文件都不在了），把它当成「首次运行」会每次加载都重走一遍默认
      // 清单→剔除→落盘，落盘又触发插件重载，形成每秒一次的自激重载（2026-11-25 事故）。
      if (raw && typeof raw === "object" && Array.isArray((raw as any).dicts)) {
        rawKey = stableKey(raw);
        m = raw as DictManifest;
        // 迁移：旧版以 .sqlite/.db 注册的词典自动指向同名 .mdx 原包
        for (const d of m.dicts) {
          if (/\.(sqlite|db)$/i.test(d.file)) {
            d.file = d.file.replace(/\.(sqlite|db)$/i, ".mdx");
          }
          /**
           * 迁移：更早的清单把路径写成 `dict/xxx.mdx`（相对插件根）。
           * `DictMeta.file` 的语义是「相对 dict/ 目录的文件名」，现在 dictDir()
           * 本身就是那个目录，保留前缀会拼成 `<dict>/dict/xxx.mdx` → fileExists
           * 判否 → 整本被当成「文件已丢失」清掉。REword/hiword 时代落下来的
           * 清单都是带前缀的，所以这一步必须做。
           */
          d.file = d.file.replace(/^dict[\\/]/i, "");
          if (!d.type) d.type = /\.ifo$/i.test(d.file) ? "stardict" : "mdx";
          if (!d.id) d.id = "dict-" + Math.random().toString(36).slice(2, 8);
        }
        // 迁移：旧清单只写 active、漏写 actives
        if (!Array.isArray(m.actives) || !m.actives.length) {
          m.actives = m.active ? [m.active] : [];
        }
        // 迁移：旧版 lang 只有 zh/en，且可能是 undefined/脏值
        for (const d of m.dicts) {
          if (d.lang !== "zh" && d.lang !== "en" && d.lang !== "idiom") {
            d.lang = "en";
          }
        }
      }
    } catch (e) {
      logSwallow(e, "dict-manager.ts · loadManifest", "debug");
    }

    if (!m) {
      m = { active: BUILTIN_DICT.id, actives: [BUILTIN_DICT.id], dicts: [{ ...BUILTIN_DICT }] };
    }

    /** 目录可判定性：unknown 时既不补内置、也不清理，整份清单原样保留 */
    const dirState = this.dictDirState();

    // 内置词典兜底补回（判断不了目录时不补：补了也永远剔不掉，只会多一条点不动的幽灵条目）
    if (dirState !== "unknown" && !m.dicts.some((d) => d.id === BUILTIN_DICT.id)) {
      m.dicts.unshift({ ...BUILTIN_DICT });
    }
    /**
     * 清理文件已丢失的条目（内置同样清理：发版包不带词典实包，
     * 留一条永不存在的内置词典只会让用户反复点开关、看不到任何效果）。
     *
     * ⚠️ 只在「目录真实存在」时才清理。
     *
     * 2026-11-26 事故：`fileExists()` 对「文件不在」和「判断不了」返回同一个
     * false。只要某次加载时 `dictDir()` 解析失败（浏览器模式拿不到
     * `window.siyuan.config.system.workspaceDir`、插件根探测失败、目录还没建），
     * 整份清单就会被就地清空并立刻落盘 —— 用户 134 MB 词典文件还在磁盘上，
     * 但界面里一本都没有，只能看到一个「未加载到可用词典」的警告，且无从恢复。
     * 现在把三态分开：**判断不了就一条都不删**。
     */
    if (dirState !== "unknown") {
      const before = m.dicts.length;
      m.dicts = m.dicts.filter((d) => this.fileExists(d));
      const dropped = before - m.dicts.length;
      if (dropped > 0) {
        getLogger().warn(`[RE 阅读器] 有 ${dropped} 本词典的文件已不在磁盘上，已从清单移除`);
      }
    }

    // 反向兜底：磁盘上有、清单里没有的词典文件补登记（清空事故与被清空的目录共用）
    const adopted = this.adoptUnlistedDicts(m);
    if (adopted.length) {
      getLogger().info(`[RE 阅读器] 在 dict 目录发现 ${adopted.length} 个未登记的词典，已自动登记`);
    }
    // 激活项必须真实存在
    const valid = new Set(m.dicts.map((d) => d.id));
    /**
     * 2026-10-07 脏数据归一化（升级自「同语种单选」版本时必需）。
     *
     * 旧版本每次 `enable()` 都把 actives 覆写成 `[id]`，所以存量用户的清单里
     * actives 往往只有一本 —— 甚至像本文档撰写时用户的实际情况：
     *   {"active":"", "actives":[], "dicts":[牛津核心词, 新世纪英汉大词典]}
     * actives 为空是因为用户「启用A → 启用B（A 被连带卸载并从 actives 抹掉）」
     * → 停用 B 之后就没有任何启用项了。
     *
     * 这里做三件事，让升级后的第一次启动是合理的：
     *   1) 去重；
     *   2) 剔除不在 dicts 里的 id（清单有、条目已被清理）；
     *   3) 若 active 为空但 actives 非空 → 用 actives[0] 补上。
     * 注意**不再**做「actives 为空就强制塞内置词典」——
     * 用户可能主动把所有词典都停用了（这是合法状态，界面上就该显示「未启用」）。
     */
    m.actives = Array.from(new Set((m.actives || []).filter((id) => valid.has(id))));
    if (!m.active || !valid.has(m.active)) {
      m.active = m.actives[0] ?? "";
    }

    this.manifest = m;
    // 归一化没改写任何东西（原文 == 内存）→ 视为「已落盘」，启动流程里的
    // saveManifest() 就不会白写一次盘。若迁移改过内容，rawKey 与当前指纹不等，
    // 留给下一次 saveManifest 落盘（一次性，不会循环）。
    this.lastSavedKey = rawKey === stableKey(m) ? rawKey : null;
    return m;
  }

  private async saveManifest(): Promise<void> {
    // 2026-11-25 无限重载修复：没变过就不写盘。
    //
    // 思源（3.8.x）把「插件 petal 写盘」当成插件重载信号：内核 push_reload 收到
    // `dataChanges=[siyuan-plugin-reader]` 就通知所有前端重新加载该插件。
    // 而本插件的词典初始化路径里有一句**无条件** saveManifest（加载完 actives 之后），
    // 于是形成自激回路：
    //   插件加载 → 词典初始化写 hiword-dicts.json → 内核广播重载 →
    //   插件再加载 → 再写 → …（实测约每秒 1 次）
    // 症状：顶栏图标反复消失、页签内容被反复清空（书架像被压成窄条、封面溢出），
    // 控制台刷 `WebSocket is closed. Reconnect will be attempted…`。
    // 现在用「清单内容指纹」门控：内容与上次落盘一致就一个字节都不写。
    const key = stableKey(this.manifest);
    if (key === this.lastSavedKey) return;
    try {
      await this.plugin.saveData(DICT_MANIFEST_KEY, this.manifest);
      this.lastSavedKey = key;
    } catch (e) {
      getLogger().warn("[RE 阅读器] 词典清单落盘失败", { error: e });
    }
  }

  /** 加载单个词典文件到引擎（签名对齐 dict-engine：位置参数 + void 返回） */
  private async loadOne(meta: DictMeta): Promise<boolean> {
    const fp = this.resolveDictPath(meta.file);
    if (!fp) return false;
    try {
      if (meta.type === "stardict") {
        const set = meta.files && meta.files.length ? meta.files : [meta.file];
        const ifo = this.resolveDictPath(set[0]);
        const idx = set[1] ? this.resolveDictPath(set[1]) ?? undefined : undefined;
        const dict = set[2] ? this.resolveDictPath(set[2]) ?? undefined : undefined;
        if (!ifo) return false;
        await dictEngine.initStarDict(ifo, meta.id, meta.name, meta.lang, idx, dict);
        return true;
      }
      await dictEngine.initDict(fp, meta.id, meta.name, meta.lang);
      // 2026-10-07：自动挂载同名伴生资源包（词条里的图片/CSS/音频）。
      // 显式指定 mdd 优先；未指定则按「同目录同名 .mdd」推断。
      // 缺失或解析失败静默降级（词条文本照常显示），不牵连词典本身加载。
      const mddName = meta.mdd || fp.replace(/\.mdx$/i, ".mdd");
      if (mddName && mddName !== meta.file && this.fileExists({ ...meta, file: mddName } as DictMeta)) {
        const mddPath = this.resolveDictPath(mddName);
        if (mddPath) {
          try {
            await dictEngine.initMdd?.(mddPath, meta.id);
          } catch (e) {
            getLogger().debug?.("[RE 阅读器] 伴生资源包挂载失败（不影响词条文本）", { error: e });
          }
        }
      }
      return true;
    } catch (e) {
      getLogger().warn(`[RE 阅读器] 词典「${meta.name}」加载失败`, { error: e });
      return false;
    }
  }

  /**
   * 初始化词典引擎（2026-10-07 调整「回退」语义）。
   *
   * 遍历 `actives` 逐个加载 —— 数据层本来就支持多词典并行，
   * 这次只是把 `enable()` 的单选限制拿掉后，这里无需再改。
   *
   * ⚠️ 去掉了旧版的「均不可用时自动回退到任一词典」：
   *   那是单选时代的行为（actives 只有一个，加不上就等于没词典）。
   *   多本并存后它会造成**状态不一致** —— 用户明明把三本都停用了，
   *   引擎却偷偷加载了一本，界面显示「未启用」但查词有结果。
   *   现在改成：**首次运行**（既无 actives 也无 active）才自动启用内置词典，
   *   其余情况完全尊重用户的选择。
   */
  async init(): Promise<void> {
    const m = await this.loadManifest();

    // 首次运行：给一个可用的起点，否则插件开箱无法查词。
    // `userDisabledAll` 存在说明是用户主动全关的 → 尊重，不再塞回内置。
    //
    // 2026-11-26：条件从「必须有内置词典」放宽到「目录里有任意一本」。
    // 发版包从来不带内置词典实包，内置条目又会在清理时被剔掉，所以旧条件
    // 实际上永远不成立 —— 清单被清空过的用户即使把词典文件捡回来，
    // 也一直停在「未加载到可用词典」，划词只能走在线词典。
    if (!m.actives.length && !m.active && m.userDisabledAll !== true && m.dicts.length) {
      const pick = m.dicts.find((d) => this.langGroup(d) === "en") ?? m.dicts[0];
      m.actives = [pick.id];
      m.active = pick.id;
      getLogger().info(`[RE 阅读器] 没有已启用的词典，自动启用「${pick.name}」`);
    }

    let loaded = 0;
    for (const id of m.actives) {
      const meta = m.dicts.find((d) => d.id === id);
      if (!meta || !this.fileExists(meta)) continue;
      if (await this.loadOne(meta)) loaded++;
    }

    // 默认词典指针：英文优先（英文为主查），否则 actives 里第一本
    if (m.actives.length) {
      const byId = (aid: string) => m.dicts.find((d) => d.id === aid);
      const enMeta = m.actives.find((aid) => {
        const meta = byId(aid);
        return meta && this.langGroup(meta) === "en";
      });
      m.active = enMeta || m.actives[0] || m.active;
    }
    /**
     * 指针必须落在 actives 里，但不能反过来问引擎「加载了吗」。
     *
     * 原因（2026-10-07 修掉的一个不一致）：某本词典文件损坏 / 权限不足时
     * `loadOne()` 会失败，若此时把 active 清空，界面就会显示「没有默认词典」，
     * 而清单里它明明是启用状态 —— 用户会以为自己的设置被改了。
     * 正确做法是**界面与清单保持一致**（显示默认，但查不到词），
     * 加载失败的诊断信息由引擎日志承担。
     */
    if (!m.actives.includes(m.active)) {
      m.active = m.actives[0] ?? "";
    }

    await this.saveManifest();
    this.applyPrefsToDom();

    this.ready = loaded > 0;
    if (this.ready) {
      getLogger().info(`[RE 阅读器] 词典引擎就绪，已加载 ${loaded} 个词典（启用 ${m.actives.length} 本）`);
    } else {
      getLogger().warn("[RE 阅读器] 未加载到可用词典，划词查词将只走在线词典");
    }
  }

  /** 当前清单（设置面板展示用） */
  list(): DictManifest {
    return this.manifest;
  }

  /**
   * 读词典偏好（2026-10-07，对标 Readest 词典二级页的「外观 / 发音」）。
   *
   * 放在 manifest 里而非 reader-settings：词典是**全局**资源（跨书籍、跨格式通用），
   * 而 reader-settings 是按 book/pdf 分片的阅读偏好。两者语义不同，不该混在一起。
   */
  prefs(): { fontScale: number; autoSpeak: boolean } {
    return {
      fontScale: this.manifest.fontScale ?? 1.0,
      autoSpeak: this.manifest.autoSpeak === true,
    };
  }

  /** 写词典偏好（自动落盘）。数值会夹到合法区间，避免写入非法值导致弹窗排版错乱。 */
  async setPrefs(patch: { fontScale?: number; autoSpeak?: boolean }): Promise<void> {
    if (typeof patch.fontScale === "number" && Number.isFinite(patch.fontScale)) {
      this.manifest.fontScale = Math.min(1.6, Math.max(0.8, patch.fontScale));
    }
    if (typeof patch.autoSpeak === "boolean") {
      this.manifest.autoSpeak = patch.autoSpeak;
    }
    await this.saveManifest();
    this.applyPrefsToDom();
    getLogger().info(
      `[RE 阅读器] 词典偏好已更新（字号 ${this.manifest.fontScale ?? 1.0}，自动发音 ${this.manifest.autoSpeak === true}）`,
    );
  }

  /**
   * 把词典偏好写进 DOM（字号 → --hw-dict-font-scale）。
   * index.less 的 `.hiword-dict-card { zoom: var(--hw-dict-font-scale, 1) }` 是 2026-09-07
   * 就备好的机制，但此前全仓没有 setter ⇒ 设置页的字号 stepper 存了不生效。
   * 挂在 documentElement 上，阅读弹窗卡与侧边栏卡命中同一个变量。
   */
  applyPrefsToDom(): void {
    try {
      if (typeof document === "undefined") return;
      document.documentElement.style.setProperty(
        "--hw-dict-font-scale",
        String(this.manifest.fontScale ?? 1.0),
      );
    } catch (e) {
      logSwallow(e, "dict-manager.ts · applyPrefsToDom", "debug");
    }
  }

  /**
   * 某词典是否处于启用状态（界面开关用，读清单即可，无需查引擎）。
   */
  isActive(id: string): boolean {
    return this.manifest.actives.includes(id);
  }

  /** 某语种当前启用的词典 id（没有则空串） */
  activeInGroup(lang: "zh" | "en" | "idiom"): string {
    const m = this.manifest.dicts.find(
      (d) => this.langGroup(d) === lang && this.manifest.actives.includes(d.id),
    );
    return m?.id ?? "";
  }

  /**
   * 启用某词典（2026-10-07 改为「每语种限一本」方案 B）。
   *
   * ### 规则
   * 每个语种同时只有**一本**启用词典。启用 A（语种 en）时若同语种的 B 在启用，
   * 自动关掉 B —— 这与「每组一个开关」的界面心智一致：
   * 打开新的必然意味着旧的关掉。用户要的就是这个，不是「同语种可开多本」。
   *
   * ### ⚠️ 关键：加载与顶替的顺序不能反
   * 「先关旧的、再加载新的」在新词典加载失败时会造成**两头落空**：
   * 旧的已被卸载（内存释放、清单移除）、新的没起来——
   * 用户原本能用的词典变得不可用，且无法回退。
   * 故顺序固定为：**先加载新的 → 成功后才关旧的**。
   * 加载失败时清单与引擎都保持原样，界面开关也不动。
   *
   * ### 与旧 bug 的区别
   * 旧实现也会「顶掉同语种的其它词典」，但它顶得毫无提示且不校验新词典能否加载
   * —— 用户看到「我刚启用的那本怎么又变成未启用了」，完全无法预期。
   * 现在顶替发生在**开关界面**里（用户主动点的），语义明确可预期。
   */
  async enable(id: string): Promise<boolean> {
    const meta = this.manifest.dicts.find((d) => d.id === id);
    if (!meta || !this.fileExists(meta)) return false;

    const group = this.langGroup(meta);
    // 同语种当前启用的那本（即要被顶替的对象）
    const prev = this.manifest.actives.find((aid) => {
      if (aid === id) return false;
      const m = this.manifest.dicts.find((d) => d.id === aid);
      return m && this.langGroup(m) === group;
    });

    // 已经是本组启用的那本 → 幂等：确保引擎里加载着、补齐指针即可
    if (this.manifest.actives.includes(id)) {
      if (!dictEngine.isDictLoaded(id)) {
        if (!(await this.loadOne(meta))) return false;
      }
      this.manifest.active = id;
      this.manifest.userDisabledAll = false;
      dictEngine.setActiveDict(id);
      this.ready = true;
      await this.saveManifest();
      return true;
    }

    // ---- ① 先加载新的（失败则什么都不动）----
    // 已加载过（例如从 actives 移除后又重新启用）则跳过重复解析：
    // MDX 构造会读整份词表索引，代价不小。
    if (!dictEngine.isDictLoaded(id) && !(await this.loadOne(meta))) {
      return false;
    }

    // ---- ② 加载成功，现在才提交顶替 ----
    this.manifest.actives = this.manifest.actives.filter((x) => x !== id && x !== prev);
    this.manifest.actives.push(id);
    this.manifest.active = id;
    this.manifest.userDisabledAll = false;
    // 关掉被顶替的那本，释放它的 MDX 实例（内存）
    if (prev) dictEngine.deactivateAndRemove(prev, null);
    dictEngine.setActiveDict(id);
    this.ready = true;
    await this.saveManifest();
    getLogger().info(
      `[RE 阅读器] 启用词典「${meta.name}」${prev ? "（已停用同语种的其它词典）" : ""}`,
    );
    return true;
  }

  /**
   * 停用某词典（2026-10-07 方案 B）。
   *
   * 因为「每语种限一本」，停用一本后**同语种必然没有剩余启用项**，
   * 所以默认指针只需跨语种重选（优先英文，其次任意一本）。
   */
  async disable(id: string): Promise<boolean> {
    dictEngine.deactivateAndRemove(id, null);
    this.manifest.actives = this.manifest.actives.filter((x) => x !== id);
    // 记下「用户主动全关了」—— 否则下次启动 init() 会当成首次运行又塞回内置。
    this.manifest.userDisabledAll = this.manifest.actives.length === 0;
    if (this.manifest.active === id) {
      const rest = this.manifest.dicts.filter((d) => this.manifest.actives.includes(d.id));
      const en = rest.find((d) => this.langGroup(d) === "en");
      this.manifest.active = (en ?? rest[0])?.id ?? "";
      if (this.manifest.active) dictEngine.setActiveDict(this.manifest.active);
    }
    this.ready = this.manifest.actives.length > 0;
    await this.saveManifest();
    return true;
  }

  /**
   * 切换某词典的语种（2026-10-07）。
   *
   * 动机：`importDictFile()` 只能按**文件名正则**猜语种
   *   （`/(英|english|ecdict|ncecd)/i ? "en" : "zh"`），不可靠——
   *   用户的「新世纪英汉大词典」被判为 `en`，但它其实中英都能查。
   * 让用户在词典列表里直接改，比在导入弹窗加下拉更顺手
   *   （导入是低频，发现猜错了再改也是低频，后者路径更短）。
   *
   * 方案 B 下要额外维护「每语种一本」约束：
   *   把一本**已启用**的英汉词典改成中文时，若中文组已有启用项，
   *   必须顶替掉它（否则中文组会出现两本启用，破坏规则）。
   */
  async setLang(id: string, lang: "zh" | "en" | "idiom"): Promise<boolean> {
    const meta = this.manifest.dicts.find((d) => d.id === id);
    if (!meta || meta.lang === lang) return false;
    meta.lang = lang;
    const group = this.langGroup(meta);

    // 维持「每语种至多一本启用」：若本词典已启用，顶替新语种组里原有那本
    if (this.manifest.actives.includes(id)) {
      const prev = this.manifest.actives.find((aid) => {
        if (aid === id) return false;
        const m = this.manifest.dicts.find((d) => d.id === aid);
        return m && this.langGroup(m) === group;
      });
      if (prev) {
        this.manifest.actives = this.manifest.actives.filter((x) => x !== prev);
        dictEngine.deactivateAndRemove(prev, null);
        getLogger().info(`[RE 阅读器] 语种调整：已停用同组的「${prev}」以保持每语种一本`);
      }
      this.manifest.active = id;
    }

    // 引擎里已加载的实例也带着旧 lang，重载一次让路由立即生效
    if (dictEngine.isDictLoaded(id)) {
      try {
        await this.loadOne(meta);
      } catch {
        /* 重载失败保留旧实例，不影响清单 */
      }
    }
    await this.saveManifest();
    getLogger().info(`[RE 阅读器] 词典「${meta.name}」语种改为 ${lang}`);
    return true;
  }

  /**
   * 导入后兜底启用（2026-11-20）。
   *
   * 原逻辑只在本组已有启用项时才把新词典放进 actives（`actives = [id, ...]`）；
   * 用户「一本都没启用」时导入完仍是未启用状态 —— 划词依旧查不到词，
   * 而界面只显示开关没开，很容易被当成「导入没生效」。
   * 导入是明确的「我想用这本」信号，故本组没有启用项时直接启用它。
   */
  private async autoEnableIfGroupEmpty(id: string): Promise<void> {
    if (this.manifest.actives.includes(id)) return;
    const meta = this.manifest.dicts.find((d) => d.id === id);
    if (!meta) return;
    const group = this.langGroup(meta);
    const hasGroupActive = this.manifest.actives.some((aid) => {
      const m = this.manifest.dicts.find((d) => d.id === aid);
      return m && this.langGroup(m) === group;
    });
    if (!hasGroupActive) await this.enable(id);
  }

  /**
   * 导入词典文件（决策 G 的用户自助入口）。
   *
   * 2026-10-07 修掉的三个问题：
   *  1. **写盘顺序 bug**：原实现先 `writeFileSync` 再判格式，若用户误传
   *     starDict（.ifo）会「先落一个垃圾文件再抛错」，dict/ 目录越用越脏。
   *     → 改为**先校验、后写盘**。
   *  2. **不校验文件真实性**：原实现只登记清单，真正解析发生在查词时 ——
   *     用户传任何文件都「导入成功」，到查词才报错且极难定位。
   *     → 改为写盘后**立即试解析**，失败则回滚（删文件 + 不登记）。
   *  3. **不支持 .mdd 伴生资源包**：MDX 词条里的图片/CSS/音频打包在同名
   *     .mdd 里，缺了它图片全裂。→ 支持显式传 .mdd 并登记到 meta.mdd。
   *
   * @param fileName 原始文件名（只取 basename，防路径穿越）
   * @param bytes   文件内容
   * @param opts.lang 语种；不传则按文件名猜测
   * @param opts.name 显示名
   * @param opts.mddFile 伴生资源包文件名（与 fileName 同目录）；也支持直接传 .mdd 作为第一个参数
   */
  async importDictFile(
    fileName: string,
    bytes: ArrayBuffer | Uint8Array,
    opts: { lang?: "zh" | "en" | "idiom"; name?: string; mddFile?: string; mddBytes?: ArrayBuffer | Uint8Array } = {},
  ): Promise<DictMeta> {
    const dir = this.dictDir();
    if (!dir) throw new Error(t("未找到词典目录（data/public/<插件名>/dict），无法导入词典"));

    const safeName = path.basename(fileName);
    if (!safeName || safeName.startsWith(".")) throw new Error(t("非法的词典文件名"));

    // ---- ① 格式判定（写盘前）----
    const lower = safeName.toLowerCase();
    // 允许把 .mdd 作为第一个参数传入（用户拖到的是资源包而非词典本体）：
    // 自动转成「同名 .mdx + 这个 .mdd」的组合，并给出明确提示。
    let dictName = safeName;
    let mddFromArg: { name: string; bytes: ArrayBuffer | Uint8Array } | null = null;
    if (lower.endsWith(".mdd")) {
      dictName = safeName.replace(/\.mdd$/i, ".mdx");
      mddFromArg = { name: safeName, bytes };
    }

    const isStardict = /\.ifo$/i.test(dictName);
    if (isStardict) {
      // starDict 是成套文件（.ifo/.idx/.dict），单文件导入不适用。
      // 此处**不再写盘**，避免留下垃圾文件。
      throw new Error(t("starDict 词典需成套文件（.ifo/.idx/.dict），请手动放入 dict/ 目录"));
    }
    if (!/\.mdx$/i.test(dictName)) {
      throw new Error(t("只支持 .mdx 词典包（可搭配同名 .mdd 资源包）；starDict 请手动放入 dict/ 目录"));
    }

    const dest = path.join(dir, dictName);
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (!buf.length) throw new Error(t("词典文件为空"));

    // ---- ②🔴 格式校验（2026-10-08 新增，必须在写盘之前）----
    //
    // 为什么放在写盘前而不是沿用「写盘后试解析、失败回滚」：
    //   1. js-mdict 抛的是它的原始错误，用户看不懂；
    //   2. 大文件已经落盘才失败 ⇒ 磁盘上留下垃圾（回滚也不可靠）。
    // 详见 dict-validate.ts 的模块注释。
    const checked = validateDictFile(buf, dictName, {
      idx: fs.existsSync(path.join(dir, path.basename(dictName.replace(/\.ifo$/i, ".idx")))),
      dict: fs.existsSync(path.join(dir, path.basename(dictName.replace(/\.ifo$/i, ".dict")))),
    });
    if (!checked.ok) throw new Error(checked.reason);

    fs.mkdirSync(dir, { recursive: true });
    const contentHash = dictContentHash(buf);

    // ---- ③ 重复导入检测（对标 Readest「内容哈希做身份」）----
    // 同一份文件再导入一次 ⇒ **替换**原记录而不是新增，
    // 否则列表里会出现两本同名词典、且用户的启用态被割裂。
    const dup = this.manifest.dicts.find((d) => d.contentHash === contentHash && d.builtin !== true);
    if (dup) {
      getLogger().info(
        `[RE 阅读器] 词典「${dictName}」与已有「${dup.file}」内容相同，按替换处理`,
      );
    }

    // ---- ③ 伴生资源包（.mdd）----
    //
    // 🔴 2026-10-08：**不再按同名自动推断**。
    // 原实现是`opts.mddFile || (mddFromArg ? … : dictName.replace(/\.mdx$/,".mdd"))`
    // 然后 `hasMdd = fs.existsSync(mddPath)` —— 目录里恰好有个同名 .mdd 就会被挂上，
    // **哪怕它与本次导入的 .mdx 毫无关系**。
    // 本项目实测踩到：用户的 .mdd 与 .mdx MD5 完全相同（是副本不是资源包），
    // 这种错误 .mdd 会被静默登记、掩盖「词典文件本身有问题」这个真正的原因。
    // ⇒ 改为**只认显式传入**：用户在拖拽时同时选中 .mdx + .mdd，或事先手动放进目录。
    const mddPath = opts.mddFile
      ? path.join(dir, path.basename(opts.mddFile))
      : (mddFromArg ? path.join(dir, path.basename(mddFromArg.name)) : "");
    // 显式传入 mddBytes 时先落盘（用于「同时选中两个文件」的拖拽场景），
    // 再判断资源包是否存在 —— 顺序反了会导致首次导入不登记 meta.mdd。
    if (opts.mddBytes && mddPath && mddPath !== dest) {
      const mb = opts.mddBytes instanceof Uint8Array ? opts.mddBytes : new Uint8Array(opts.mddBytes);
      fs.writeFileSync(mddPath, mb);
    }
    const hasMdd = !!mddPath && mddPath !== dest && fs.existsSync(mddPath);

    // ---- ④ 写盘 + 立即试解析（失败回滚）----
    fs.writeFileSync(dest, buf);
    const id = "dict-" + Math.random().toString(36).slice(2, 8);
    const meta: DictMeta = {
      id,
      name: opts.name || dictName.replace(/\.[^.]+$/, ""),
      file: dictName,
      // ⚠️ 判定用 `hasMdd`（它已含`mddPath` 非空判断）。
    // 原式写的是 `hasMdd || opts.mddBytes` —— 当 mddBytes 有值但 mddPath 为空时
    // 会走到 `path.basename("")` 得到空串，登记出一个 `mdd: ""` 的幽灵字段。
      ...(hasMdd && mddPath ? { mdd: path.basename(mddPath) } : {}),
      type: "mdx",
      /**
       * 语种初值：文件名正则**只是猜测**（2026-10-07 明确）
       *
       * 已知误判案例：用户的「新世纪英汉大词典[全量提取词组版]A」含「英」字
       * → 被判为 `en`，但它其实中英都能查。正则永远猜不准，
       * 所以猜错之后必须**能在界面上改**（见 `setLang()`），
       * 而不是想办法把正则写得更复杂（那只会把误判换成另一种误判）。
       */
      lang: opts.lang || this.guessLang(dictName),
      contentHash,
    };

    try {
      // ⚠️ loadOne 内部 catch 后返回 false（不抛错）——只看 try/catch 会把
      // 「文件头合法但词表损坏」的包当成导入成功。必须判返回值。
      if (!(await this.loadOne(meta))) {
        throw new Error(t("词典文件无法解析（词表结构损坏或文件不完整）"));
      }
    } catch (e) {
      // 解析失败：回滚（删文件 + 不登记清单），让用户拿到明确错误而非"导入了但查不了"
      try { fs.unlinkSync(dest); } catch { /* 忽略 */ }
      const msg = (e as Error)?.message || String(e);
      throw new Error(t("词典文件无法解析：{msg}\n已回滚，未写入清单。请确认是有效的 .mdx 词典包。").replace("{msg}", msg));
    }

    // 重复导入：替换旧记录而不是 push 新条目。
    // 旧记录若正在被加载，先卸载 —— 否则同一份内容会在内存里留两份实例。
    if (dup) {
      const stillEnabled = this.manifest.actives.includes(dup.id);
      dictEngine.removeDict(dup.id);
      const at = this.manifest.dicts.findIndex((d) => d.id === dup.id);
      this.manifest.dicts.splice(at, 1, meta);
      // 保留用户此前对「这本词典」的启用态 —— 他当初是主动开的，
      // 重新导入只是换了份文件，不该逼他再点一次开关。
      if (stillEnabled) this.manifest.actives = [meta.id, ...this.manifest.actives.filter((x) => x !== meta.id)];
      this.manifest.active = meta.id;
      await this.saveManifest();
      await this.autoEnableIfGroupEmpty(meta.id);
      getLogger().info(`[RE 阅读器] 词典「${dictName}」已替换同内容的旧记录 ${dup.id}`);
      return meta;
    }

    this.manifest.dicts.push(meta);
    if (this.manifest.actives.length) this.manifest.actives = [id, ...this.manifest.actives.filter((x) => x !== id)];
    this.manifest.active = id;
    await this.saveManifest();
    await this.autoEnableIfGroupEmpty(id);
    getLogger().info(
      `[RE 阅读器] 已导入词典「${meta.name}」(${meta.file}${meta.mdd ? ` + ${meta.mdd}` : ""})`,
    );
    return meta;
  }

  /** 移除某个非内置词典（同时删文件） */
  async removeDict(id: string): Promise<boolean> {
    const idx = this.manifest.dicts.findIndex((d) => d.id === id);
    if (idx < 0) return false;
    const meta = this.manifest.dicts[idx];
    if (meta.builtin) return false; // 内置词典不可删
    dictEngine.removeDict(id);
    this.manifest.dicts.splice(idx, 1);
    this.manifest.actives = this.manifest.actives.filter((x) => x !== id);
    if (this.manifest.active === id) this.manifest.active = this.manifest.actives[0] || "";
    try {
      const fp = this.resolveDictPath(meta.file);
      if (fp && fs.existsSync(fp)) fs.unlinkSync(fp);
    } catch (e) {
      logSwallow(e, "dict-manager.ts · removeDict", "debug");
    }
    await this.saveManifest();
    return true;
  }
}
