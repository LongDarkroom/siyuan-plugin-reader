import { logSwallow } from "../core/safe.ts";
/**
 * 阅读器 - 字体管理
 * ---------------------------------------------------------------
 * 两种来源：
 * 1. 「跟随思源」：扫描宿主页面的 @font-face（CSSFontFaceRule，src 转绝对 URL）
 *    + 取 document.body 计算后的字体栈，一并注入阅读器 iframe；
 *    思源主题/字体插件换字体，阅读器自动跟随。
 * 2. 「自定义导入」：用户上传 ttf/otf/woff/woff2，存 /data/public/<name>/fonts/，
 *    注册表持久化 hiword-reader-fonts.json；生成 @font-face 注入。
 *
 * 2026-11-26：字体文件此前存在 /data/plugins/<name>/fonts/ —— 商店更新会整目录
 * 替换插件目录，字体文件被删而注册表（loadData 本来就落在 petal）还在，界面上
 * 就剩一排永远加载不出来的名字。现在与书库同一套：public 存放 + 首次加载迁移 +
 * 迁移标记 + 缺失可见。放 public 而不是 petal：写 petal 会广播插件重载
 * （内核 push_reload.go），public 不会，还能用 /public/… 直接 GET。
 */

import { putFile, getFileBlob, removeFile, renameFile } from "../siyuan/api";
import { writable } from "svelte/store";
import { probeFile } from "./file-probe.ts";

export interface CustomFont {
  id: string;
  /** font-family 名（文件名去扩展名；@font-face 与字体栈都用它，注册别名语义） */
  name: string;
  /** 思源 data 内路径 */
  path: string;
  /** ttf / otf / woff / woff2 */
  ext: string;
  size: number;
  addedAt: number;
  /** 真实字体族名（字体 name 表解析，2026-09-29 P1；旧档无此字段 → 回落 name） */
  family?: string;
  /** CSS font-weight（OS/2 usWeightClass / 风格名推断；缺省 400 = 不标注） */
  weight?: number;
  /** normal / italic / oblique（fsSelection 位 + 风格名推断） */
  style?: "normal" | "italic" | "oblique";
  /** 可变字体（fvar 表存在 → @font-face 不标注 weight/style，覆盖全轴） */
  variable?: boolean;
}

const FONTS_KEY = "hiword-reader-fonts.json";
/** 字体文件落点：思源静态资源目录（不触发插件重载、不随同步、不被商店更新替换） */
const FONTS_DIR = (pluginName: string) => `/data/public/${pluginName}/fonts`;
/**
 * 历史存放位置（仅用于一次性迁移，按新→旧顺序）：
 * 1. petal/fonts —— 0.11.5 曾用过（未发版），写盘会触发插件重载；
 * 2. 安装目录 fonts —— ≤0.11.4，商店更新整目录替换时被删。
 */
const LEGACY_FONTS_DIRS = (pluginName: string) => [
  `/data/storage/petal/${pluginName}/fonts`,
  `/data/plugins/${pluginName}/fonts`,
];
const legacyFontSourceOf = (pluginName: string, p?: string): string | null => {
  for (const dir of LEGACY_FONTS_DIRS(pluginName)) {
    if (p?.startsWith(`${dir}/`)) return dir;
  }
  return null;
};
/** 迁移标记（纯排障：跑过没、搬了几个、几个字节、失败几个） */
const FONT_MIGRATION_KEY = "font-storage-migration.json";

export class FontStore {
  private fonts: CustomFont[] = [];
  private loaded = false;
  /** 内部 Svelte store：让消费者可订阅字体列表变化（导入/删除后自动刷新） */
  private _store = writable<CustomFont[]>([]);
  /** 文件已确认丢失的字体 id（设置页据此标「文件缺失」并要求重新导入） */
  private missingSet = new Set<string>();
  private _missing = writable<Set<string>>(new Set());
  /** 迁移/探测只跑一次（load 会被设置页、ReaderView 多处调用） */
  private afterLoadStarted = false;
  // 显式字段声明（避免 constructor parameter property，Node 24 strip-types 不支持）
  private plugin: any;

  constructor(plugin: any) {
    this.plugin = plugin;
  }

  /** 实现 Svelte store 契约：返回退订函数 */
  subscribe(run: (value: CustomFont[]) => void, invalidate?: (value?: CustomFont[]) => void): () => void {
    return this._store.subscribe(run, invalidate as any);
  }

  get list(): CustomFont[] {
    return [...this.fonts].sort((a, b) => b.addedAt - a.addedAt);
  }

  /** 文件缺失集合（只读订阅） */
  get missing() {
    return this._missing;
  }

  isMissing(id: string): boolean {
    return this.missingSet.has(id);
  }

  /** 插件名（内置字体要把 `assets/fonts/*` 拼成 `/plugins/<name>/...` 取回） */
  get pluginName(): string {
    return this.plugin?.name ?? "";
  }

  get(id: string): CustomFont | undefined {
    return this.fonts.find((f) => f.id === id);
  }

  async load(): Promise<void> {
    if (this.loaded) {
      this._store.set([...this.fonts]);
      return;
    }
    try {
      const data = await this.plugin.loadData(FONTS_KEY);
      if (Array.isArray(data)) this.fonts = data;
    } catch {
      this.fonts = [];
    }
    this.loaded = true;
    this._store.set([...this.fonts]);
    // 迁移旧目录 + 探测缺失：都是磁盘往返，放后台，不拖慢启动与设置页首屏
    if (!this.afterLoadStarted) {
      this.afterLoadStarted = true;
      void this.afterLoad();
    }
  }

  private async afterLoad(): Promise<void> {
    // Node 测试环境没有思源的文件 API，跳过所有磁盘探测（用例自行调用）
    if (typeof document === "undefined") return;
    try {
      await this.migrateLegacyFonts();
    } catch (e) {
      logSwallow(e, "reader-fonts.ts · migrateLegacyFonts", "warn");
    }
    try {
      await this.refreshMissing();
    } catch (e) {
      logSwallow(e, "reader-fonts.ts · refreshMissing", "warn");
    }
  }

  private async save(): Promise<void> {
    try {
      await this.plugin.saveData(FONTS_KEY, this.fonts);
    } catch (e) {
      console.warn("[REword] 字体注册表持久化失败:", e);
    }
  }

  /**
   * 一次性把历史目录里的字体搬到 public。
   *
   * 与书库迁移同一套规则，理由也相同：
   *  - 目标目录必须先建：内核 renameFile 不会替我们建父目录；
   *  - 优先 rename（同盘秒级、不读文件内容），失败再退化为「读成 Blob 再上传」；
   *  - 幂等可断点续跑：目标已在就只改注册表，索引只写一次；
   *  - 迁移结果写 font-storage-migration.json，出问题不用靠猜。
   *
   * ⚠️ 已经装过旧版、且商店更新把旧目录清掉的用户，这一步搬不到任何东西 ——
   * 文件在安装时就被删了。那种情况由 refreshMissing 标成「文件缺失」，
   * 让用户重新导入，而不是留一个点不动又看不出原因的名字。
   */
  private async migrateLegacyFonts(): Promise<void> {
    const pluginName = this.plugin.name;
    const dir = FONTS_DIR(pluginName);
    const pending = this.fonts.filter((f) => legacyFontSourceOf(pluginName, f.path));
    if (!pending.length) return;

    await putFile(dir, true, null);

    const stat = { fonts: 0, bytes: 0, renamed: 0, copied: 0, failed: 0 };
    let changed = false;
    for (const font of pending) {
      try {
        const oldPath = font.path;
        const src = legacyFontSourceOf(pluginName, oldPath);
        if (!src) continue;
        const name = oldPath.slice(src.length + 1);
        const dest = `${dir}/${name}`;
        const destState = await probeFile(dest);
        if (destState === null) continue; // 目录读不出来：别改注册表，下次再试
        let viaCopy = false;
        if (!destState) {
          if (await renameFile(oldPath, dest)) {
            stat.renamed++;
          } else {
            const blob = await getFileBlob(oldPath);
            if (!blob) {
              // rename 与旧文件都读不到：保留原路径，交给 refreshMissing 标缺失
              stat.failed++;
              continue;
            }
            if (!(await putFile(dest, false, blob))) {
              stat.failed++;
              continue;
            }
            stat.copied++;
            viaCopy = true;
          }
        }
        font.path = dest;
        stat.fonts++;
        stat.bytes += font.size || 0;
        changed = true;
        // rename 成功后旧路径已不存在；这一步只兜底清掉「复制」路径留下的原件
        if (viaCopy) {
          try {
            await removeFile(oldPath);
          } catch (__swallowErr) {
            logSwallow(__swallowErr, "reader-fonts.ts · migrate rmOld", "debug");
          }
        }
      } catch (e) {
        stat.failed++;
        logSwallow(e, `reader-fonts.ts · migrate ${font.id}`, "warn");
      }
    }
    if (!changed) return;
    await this.save();
    this._store.set([...this.fonts]);
    await this.writeMigrationMarker(stat);
  }

  /** 迁移标记（诊断用，保留最近 10 次）；写 public 而不是 petal：写 petal 会触发插件重载 */
  private async writeMigrationMarker(stat: {
    fonts: number; bytes: number; renamed: number; copied: number; failed: number;
  }): Promise<void> {
    const path = `/data/public/${this.plugin.name}/${FONT_MIGRATION_KEY}`;
    try {
      const prevBlob = await getFileBlob(path);
      let runs: unknown[] = [];
      if (prevBlob) {
        // 标记文件被人手改坏也不该让整次迁移「无记录」：解析失败就从空历史开始
        try {
          const prev = JSON.parse(await prevBlob.text());
          if (Array.isArray(prev?.runs)) runs = prev.runs;
        } catch {
          runs = [];
        }
      }
      runs.push({
        at: Date.now(),
        from: LEGACY_FONTS_DIRS(this.plugin.name),
        to: FONTS_DIR(this.plugin.name),
        ...stat,
      });
      const body = JSON.stringify({ v: 1, runs: runs.slice(-10) }, null, 2);
      await putFile(path, false, new Blob([body], { type: "application/json" }));
    } catch (e) {
      logSwallow(e, "reader-fonts.ts · writeMigrationMarker", "debug");
    }
  }

  /** 重新探测所有字体文件是否在位（加载后一次；导入/删除后局部刷新） */
  async refreshMissing(): Promise<void> {
    if (typeof document === "undefined") return;
    const next = new Set<string>();
    for (const f of this.fonts) {
      if ((await probeFile(f.path)) === false) next.add(f.id);
    }
    const changed =
      next.size !== this.missingSet.size || [...next].some((id) => !this.missingSet.has(id));
    this.missingSet = next;
    if (changed) this._missing.set(new Set(next));
  }

  private setMissing(id: string, missing: boolean): void {
    if (this.missingSet.has(id) === missing) return;
    if (missing) this.missingSet.add(id);
    else this.missingSet.delete(id);
    this._missing.set(new Set(this.missingSet));
  }

  /**
   * 取字体文件内容（@font-face 用）。
   * 读不到就标缺失并返回 null —— 调用方（ReaderView）此时会退回字体链，
   * 正文继续按可用的字体排版，不会因为一个死掉的 @font-face 卡住。
   */
  async getBlob(font: CustomFont): Promise<Blob | null> {
    let blob: Blob | null = null;
    try {
      blob = await getFileBlob(font.path);
    } catch (e) {
      logSwallow(e, "reader-fonts.ts · getBlob", "warn");
    }
    this.setMissing(font.id, !blob);
    return blob;
  }

  /** 导入自定义字体文件 */
  async importFont(file: File): Promise<CustomFont> {
    await this.load();
    const ext = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] ?? "ttf").toLowerCase();
    if (!["ttf", "otf", "woff", "woff2"].includes(ext)) {
      throw new Error("仅支持 ttf / otf / woff / woff2 字体文件");
    }
    const id = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const dir = FONTS_DIR(this.pluginName);
    const path = `${dir}/${id}.${ext}`;
    // 目标目录先就位：putFile 不会替我们建父目录
    try {
      await putFile(dir, true, null);
    } catch (__swallowErr) {
      logSwallow(__swallowErr, "reader-fonts.ts · importFont mkdir", "debug");
    }
    const ok = await putFile(path, false, file);
    if (!ok) throw new Error("字体文件上传失败");
    // 2026-09-29 P1：解析字体二进制元数据（真实族名/字重/斜体/可变轴），
    // 供 @font-face 标注 font-weight/style —— 多字重家族此前一律按 400 注册，
    // 粗体标题会走合成加粗而非真实字重。woff/woff2 是压缩容器解析不了 → 回落文件名。
    let meta: FontMeta = { family: "", weight: 400, style: "normal" as const, variable: false };
    if (ext === "ttf" || ext === "otf") {
      try {
        meta = parseFontInfo(await file.arrayBuffer(), file.name);
      } catch (e) {
        console.warn("[REword] 字体元数据解析失败，按文件名注册:", e);
      }
    }
    const font: CustomFont = {
      id,
      name: file.name.replace(/\.(ttf|otf|woff|woff2)$/i, "") || file.name,
      path,
      ext,
      size: file.size,
      addedAt: Date.now(),
      family: meta.family || undefined,
      weight: meta.weight,
      style: meta.style,
      variable: meta.variable,
    };
    this.fonts.push(font);
    await this.save();
    this._store.set([...this.fonts]);
    return font;
  }

  /** 删除自定义字体（文件 + 注册） */
  async removeFont(id: string): Promise<void> {
    await this.load();
    const font = this.get(id);
    if (font) {
      try {
        await removeFile(font.path);
      } catch (__swallowErr) { logSwallow(__swallowErr, "reader-fonts.ts · removeFont", "warn"); }
      this.fonts = this.fonts.filter((f) => f.id !== id);
      this.setMissing(id, false);
      await this.save();
      this._store.set([...this.fonts]);
    }
  }
}

/** src 的 format 提示（用于 @font-face 注入） */
export function fontFormat(ext: string): string {
  return ext === "ttf" ? "truetype" : ext === "otf" ? "opentype" : ext;
}

/**
 * 扫描宿主页面的全部 @font-face 规则 + 已注册到 document.fonts 的 FontFace
 * - 跨域 stylesheet 读取 cssRules 会抛 SecurityError → 跳过
 * - 相对 URL 基于 document.baseURI 转绝对（iframe 内无法解析相对路径）
 * - 2026-08-23 增强：思源「霞鹜文楷」等字体插件常通过 `document.fonts.add(new FontFace(...))`
 *   注册字体（不生成 stylesheet 规则），旧实现扫不到。现在同时扫 document.fonts，
 *   为每个已注册 family 生成 local() fallback @font-face，让本机已装字体可继承。
 *   即使宿主进程注入的字体文件本身跨进程拿不到，至少 local() 命中的本机字体可用。
 *
 * 接受可选 doc 参数：测试用 jsdom 注入，生产用全局 document。
 */
export function collectHostFontFaces(doc?: Document): string[] {
  const d = doc ?? (typeof document !== "undefined" ? document : undefined);
  if (!d) return [];
  const out: string[] = [];
  const base = d.baseURI;
  // 1) 扫 stylesheets 中的 @font-face 规则
  try {
    for (const sheet of Array.from(d.styleSheets)) {
      let rules: CSSRuleList | null = null;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // 跨域 stylesheet
      }
      if (!rules) continue;
      for (const rule of Array.from(rules)) {
        if (!(rule instanceof (d.defaultView as any).CSSFontFaceRule)) continue;
        let css = rule.cssText;
        css = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (_m, q: string, urlStr: string) => {
          const u = urlStr.trim();
          if (/^(data:|blob:|https?:|\/)/i.test(u)) return `url(${q}${u}${q})`;
          try {
            return `url(${q}${new URL(u, base).href}${q})`;
          } catch {
            return _m;
          }
        });
        if (css && !out.includes(css)) out.push(css);
      }
    }
  } catch (__swallowErr) { logSwallow(__swallowErr, "reader-fonts.ts · collectHostFontFaces", "debug"); }
  // 2) 扫 document.fonts 已注册 FontFace（思源字体插件常用 API）
  //    拿到每个 family，注入 local() fallback @font-face
  //    - 命中本机已装字体 → 立即可用
  //    - 命中跨进程已加载字体 → 在多数浏览器也可用（同源继承）
  try {
    const seen = new Set<string>();
    const fonts: any = (d as any).fonts;
    if (fonts && typeof fonts.forEach === "function") {
      fonts.forEach((face: any) => {
        const family = face?.family;
        if (!family || typeof family !== "string") return;
        if (seen.has(family)) return;
        seen.add(family);
        // 多个 local() 候选：用户可能装的是 "LXGW WenKai" 或 "LXGWWenKai-Regular" 或 "霞鹜文楷"
        const css =
          `@font-face{font-family:"${family}";` +
          `src:local("${family}"),local("${family.replace(/\s+/g, "")}");` +
          `font-display:swap;}`;
        if (!out.includes(css)) out.push(css);
      });
    }
  } catch (__swallowErr) { logSwallow(__swallowErr, "reader-fonts.ts · try { const seen = new Set<string>(); const fonts: any = (d as …", "debug"); }
  return out;
}

/**
 * 宿主当前正文字体栈（已解析的计算值，如 -apple-system, "PingFang SC", ...）
 * 2026-08-23 问题 2 修复：
 * - **优先读思源文档字体变量 --b3-font-family**（霞鹜文楷等字体插件就挂在这个变量上，
 *   作用于文档正文而非 body 全局）→ 读 CSS 变量，再读 body / html 计算字体兜底。
 * 接受可选 doc + computedStyle 参数（测试可注入 mock）。
 */
export function getHostFontStack(
  doc?: Document,
  computedStyle?: (el: Element) => CSSStyleDeclaration
): string {
  const d = doc ?? (typeof document !== "undefined" ? document : undefined);
  if (!d) return "";
  const cs = computedStyle ?? ((el: Element) => getComputedStyle(el));
  // 1) 思源文档字体变量（霞鹜文楷等挂在此）
  try {
    const cssVar = cs(d.documentElement).getPropertyValue("--b3-font-family");
    if (cssVar && cssVar.trim()) return cssVar.trim();
  } catch (__swallowErr) { logSwallow(__swallowErr, "reader-fonts.ts · getHostFontStack", "debug"); }
  // 2) body 计算字体
  try {
    const body = cs(d.body).fontFamily;
    if (body) return body.trim();
  } catch (__swallowErr) { logSwallow(__swallowErr, "reader-fonts.ts · getHostFontStack", "debug"); }
  // 3) html 计算字体（兜底）
  try {
    const html = cs(d.documentElement).fontFamily;
    if (html) return html.trim();
  } catch (__swallowErr) { logSwallow(__swallowErr, "reader-fonts.ts · getHostFontStack", "debug"); }
  return "";
}

/**
 * 从宿主 @font-face 规则中提取字体文件 src URL（带 family 名）。
 * 2026-08-23 问题 2 修复核心：
 * - 霞鹜文楷等网页字体的 `@font-face` src 是字体文件 URL（网络/CDN/插件本地资源）。
 * - foliate iframe 跨文档拿不到这些文件，`local()` 又不命中（网页字体未装系统）。
 * - 解法：把 URL 提取出来 → 宿主 fetch → blob → 注入 iframe 的 @font-face（blob 同源可加载）。
 * 返回去重的 { url, family } 列表（http(s)/相对路径可 fetch；data:/blob: 已可直接加载，跳过）。
 */
export function collectHostFontUrls(doc?: Document): { url: string; family: string }[] {
  const d = doc ?? (typeof document !== "undefined" ? document : undefined);
  if (!d) return [];
  const out: { url: string; family: string }[] = [];
  const base = d.baseURI;
  try {
    for (const sheet of Array.from(d.styleSheets)) {
      let rules: CSSRuleList | null = null;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // 跨域 stylesheet
      }
      if (!rules) continue;
      for (const rule of Array.from(rules)) {
        if (!(rule instanceof (d.defaultView as any).CSSFontFaceRule)) continue;
        const css = rule.cssText || "";
        const m = css.match(/url\(\s*(['"]?)([^'")]+)\1\s*\)/);
        if (!m) continue;
        const u = m[2].trim();
        if (/^(data:|blob:)/i.test(u)) continue; // 已可直接加载，无需 fetch
        const fam = css.match(/font-family:\s*(['"]?)([^'";]+)\1/i)?.[2].trim() ?? "";
        if (!fam) continue;
        let abs: string;
        try {
          abs = /^https?:/i.test(u) ? u : new URL(u, base).href;
        } catch {
          continue;
        }
        if (!out.some((x) => x.url === abs)) out.push({ url: abs, family: fam });
      }
    }
  } catch (__swallowErr) { logSwallow(__swallowErr, "reader-fonts.ts · stFontUrls", "debug"); }
  return out;
}

/** 自定义字体 → @font-face CSS（blob URL 由调用方提供）。
 *  2026-09-29 P1：有元数据时标注 font-weight/font-style（可变字体不标注 → 覆盖全轴）。
 *  标注后浏览器按「最近字重」匹配：只导入了 700 单字重字体时，400 正文也会选中该 face（CSS 字体匹配保证不落空）。 */
export function customFontFaceCss(font: CustomFont, blobUrl: string): string {
  const format = fontFormat(font.ext);
  const variable = font.variable === true;
  const weightPart = !variable && font.weight && font.weight !== 400 ? `font-weight:${font.weight};` : "";
  const stylePart = !variable && font.style && font.style !== "normal" ? `font-style:${font.style};` : "";
  return `@font-face{font-family:"${font.name}";${weightPart}${stylePart}src:url("${blobUrl}") format("${format}");font-display:swap;}`;
}

/* ================= 字体二进制元数据解析（2026-09-29 P1，移植自 Readest utils/font.ts） ================= */

export interface FontMeta {
  family: string;
  weight: number;
  style: "normal" | "italic" | "oblique";
  variable: boolean;
}

function parseUtf16Be(dv: DataView, offset: number, length: number): string {
  let s = "";
  for (let i = 0; i < length; i += 2) {
    const c = dv.getUint16(offset + i, false);
    if (c !== 0) s += String.fromCharCode(c);
  }
  return s;
}

function parseAscii(dv: DataView, offset: number, length: number): string {
  let s = "";
  for (let i = 0; i < length; i++) s += String.fromCharCode(dv.getUint8(offset + i));
  return s;
}

function langPriority(platformID: number, languageID: number, userLang: string): number {
  let p = 0;
  if (platformID === 0) p += 100;
  else if (platformID === 3) p += 90;
  else if (platformID === 1) p += 50;
  const ul = userLang.toLowerCase();
  if (platformID === 0 || platformID === 3) {
    if (ul.startsWith("zh")) {
      if (languageID === 0x0804) p += 50;
      else if (languageID === 0x0404 || languageID === 0x0c04) p += 45;
      else if (languageID === 0x1004) p += 35;
    } else if (ul.startsWith("ja") && languageID === 0x0411) p += 50;
    else if (ul.startsWith("ko") && languageID === 0x0412) p += 50;
    else if (ul.startsWith("en") && languageID === 0x0409) p += 50;
    if (languageID === 0x0409) p += 10;
  } else if (platformID === 1) {
    if (ul.startsWith("zh")) {
      if (languageID === 33) p += 50;
      else if (languageID === 19) p += 45;
    } else if (ul.startsWith("ja") && languageID === 11) p += 50;
    else if (ul.startsWith("ko") && languageID === 23) p += 50;
    else if (ul.startsWith("en") && languageID === 0) p += 50;
    if (languageID === 0) p += 10;
  }
  return p;
}

function inferWeightFromStyleName(styleName: string): number {
  const s = styleName.toLowerCase();
  if (s.includes("thin") || s.includes("hairline")) return 100;
  if (s.includes("extralight") || s.includes("ultralight")) return 200;
  if (s.includes("light") && !s.includes("extralight") && !s.includes("ultralight")) return 300;
  if (s.includes("medium")) return 500;
  if (s.includes("semibold") || s.includes("demibold")) return 600;
  if (s.includes("extrabold") || s.includes("ultrabold")) return 800;
  if (s.includes("black") || s.includes("heavy")) return 900;
  if (s.includes("bold") && !s.includes("semibold") && !s.includes("extrabold")) return 700;
  return 400;
}

function inferStyleFromName(styleName: string, fsSelection: number): "normal" | "italic" | "oblique" {
  const s = styleName.toLowerCase();
  if (fsSelection & 0x200) return "oblique";
  if (fsSelection & 0x1) return "italic";
  if (s.includes("oblique")) return "oblique";
  if (s.includes("italic") || s.includes("slant")) return "italic";
  return "normal";
}

/**
 * 解析 sfnt（ttf/otf）字体的 name / OS/2 / fvar 表，提取真实族名、CSS 字重、
 * 斜体风格与可变字体标记。仅限本机 ttf/otf；woff/woff2 为压缩容器，调用方自行回落文件名。
 * 任何异常都抛出，由调用方 catch 后回落默认元数据（导入流程不因此失败）。
 */
export function parseFontInfo(data: ArrayBuffer, filename: string): FontMeta {
  const fallbackName = filename.replace(/\.[^/.]+$/, "");
  const dv = new DataView(data);
  const sig = dv.getUint32(0, false);
  if (sig !== 0x00010000 && sig !== 0x74727565 && sig !== 0x4f54544f) {
    throw new Error("unsupported sfnt signature");
  }
  const numTables = dv.getUint16(4, false);
  let nameOff = 0;
  let os2Off = 0;
  let fvarOff = 0;
  for (let i = 0; i < numTables; i++) {
    const to = 12 + i * 16;
    const tag = String.fromCharCode(dv.getUint8(to), dv.getUint8(to + 1), dv.getUint8(to + 2), dv.getUint8(to + 3));
    if (tag === "name") nameOff = dv.getUint32(to + 8, false);
    else if (tag === "OS/2") os2Off = dv.getUint32(to + 8, false);
    else if (tag === "fvar") fvarOff = dv.getUint32(to + 8, false);
  }
  if (!nameOff) throw new Error("name table not found");

  const userLang = (typeof navigator !== "undefined" && navigator.language) || "zh-CN";
  type Entry = { name: string; p: number; langID: number };
  const families: Entry[] = [];
  const styles: Entry[] = [];
  const prefFamilies: Entry[] = [];
  const prefStyles: Entry[] = [];
  const count = dv.getUint16(nameOff + 2, false);
  const strOff = nameOff + dv.getUint16(nameOff + 4, false);
  for (let i = 0; i < count; i++) {
    const rec = nameOff + 6 + i * 12;
    const platformID = dv.getUint16(rec, false);
    const languageID = dv.getUint16(rec + 4, false);
    const nameID = dv.getUint16(rec + 6, false);
    const len = dv.getUint16(rec + 8, false);
    // 记录里的 offset 是相对「name 表字符串存储区」的：绝对位置 = nameOff + stringOffset + offInTable
    // （strOff 已含 nameOff；此前在这里又加了一次 nameOff = 双重偏移 → 越界/乱码，2026-09-29 实测修正）
    const off = dv.getUint16(rec + 10, false);
    if (nameID !== 1 && nameID !== 2 && nameID !== 16 && nameID !== 17) continue;
    let s = "";
    if (platformID === 0 || platformID === 3) s = parseUtf16Be(dv, strOff + off, len);
    else if (platformID === 1) s = parseAscii(dv, strOff + off, len);
    s = s.trim();
    if (!s) continue;
    const e = { name: s, p: langPriority(platformID, languageID, userLang), langID: languageID };
    if (nameID === 1) families.push(e);
    else if (nameID === 2) styles.push(e);
    else if (nameID === 16) prefFamilies.push(e);
    else prefStyles.push(e);
  }
  if (!families.length) throw new Error("font family name not found");
  const byP = (a: Entry, b: Entry) => b.p - a.p;
  families.sort(byP);
  styles.sort(byP);
  prefFamilies.sort(byP);
  prefStyles.sort(byP);
  const familyName = (prefFamilies[0] || families[0]).name;
  const styleEntry = prefStyles[0] || styles[0];
  const styleName = styleEntry?.name || "";
  let weight = 400;
  let fsSelection = 0;
  if (os2Off) {
    try {
      const weightClass = dv.getUint16(os2Off + 4, false);
      weight = weightClass <= 100 ? 100 : weightClass >= 801 ? 900 : Math.min(900, Math.max(100, Math.round(weightClass / 100) * 100));
      fsSelection = dv.getUint16(os2Off + 62, false);
    } catch {
      /* OS/2 解析失败 → 风格名推断 */
    }
  }
  if (weight === 400 && styleName) {
    const inferred = inferWeightFromStyleName(styleName);
    if (inferred !== 400) weight = inferred;
  }
  let variable = false;
  if (fvarOff) {
    try {
      if (dv.getUint16(fvarOff + 4, false) > 0) variable = true;
    } catch {
      /* fvar 损坏 → 视为静态字体 */
    }
  }
  return {
    family: familyName,
    weight,
    style: inferStyleFromName(styleName, fsSelection),
    variable,
  };
}
