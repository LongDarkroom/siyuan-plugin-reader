/**
 * 阅读器 - 内置中文字体（2026-11-13，2026-11-14 宋体改为可变字重）
 * ---------------------------------------------------------------------------
 * **为什么内置**
 * 阅读器此前把中文字体完全交给系统。实测（用户 macOS + 思源 757 条 face）：
 *   · macOS 根本没有「思源黑体」（只有苹方 / 冬青），Windows 没有「思源宋体」；
 *   · 用户在「衬线字体」下拉里选中的 23 项里，22 项的中文渲染结果**逐像素相同**
 *     —— 因为西文衬线字体没有汉字字形，汉字一路回退到链里第一个有汉字的字体。
 * ⇒ 想要「跨平台观感一致」，只能自己带字体文件。
 *
 * **带的是什么**
 * Adobe 思源宋体 / 思源黑体（SIL OFL 1.1），双双裁剪到
 * 「ASCII + GB2312 全字符（6763 汉字 + 682 符号）」并转 woff2：
 *   思源宋体可变子集（wght 250–900）≈ 4.1 MB，思源黑体 Regular ≈ 2.5 MB。
 * 生僻字不在子集里也**不会豆腐** —— CSS 按字符回退，会落到链里下一个字体。
 *
 * **宋体为什么保留 wght 轴**
 * 单字重静态字体下，CSS 只能把 100–500 全映射到 400、600–900 全交给浏览器
 * 合成粗体（实测各档墨迹完全相同）。保留 wght 轴后字重滑块才是真实连续变化，
 * 书里 `font-weight: bold` 的标题也不再是糊的合成粗体。
 * 黑体源文件目前只有静态 Regular，拿到 VF 后按同一流程重建即可。
 *
 * **名字表**
 * OFL 1.1 带保留字体名 'Source'，子集化属于修改版 ⇒ 构建脚本已把 family /
 * full / PostScript / 命名实例名统一改成 REword 自有名；版权行原样保留。
 * `@font-face` 另外用独立 CSS 族名，避免与用户已装字体互抢。
 *
 * **加载策略**
 * 只加载「当前正文真正会用到」的那一两个 face（衬线链一份、无衬线链一份），
 * 走 `getFileBlob` → `Blob` → `URL.createObjectURL`（与自定义导入字体同一条链路），
 * 不使用 `new FontFace()`（iframe 内 document.fonts 与宿主不同源，注入 CSS 更稳）。
 */

/** 内置字体描述 */
export interface BuiltinFont {
  /** 设置档里的持久化值（符号 id，与文件路径解耦） */
  id: string;
  /** @font-face 与字体栈使用的 CSS 族名（独立命名，避免与系统字体互抢） */
  cssFamily: string;
  /** 打包资源相对插件根的路径 */
  file: string;
  /** 归属哪条正文链（serif → 衬线链，sans → 无衬线链） */
  kind: "serif" | "sans";
  /** 字体体积（字节，粗略用于设置面板提示） */
  approxSize: number;
  /** @font-face 的 font-weight 声明（可变字体写区间，静态写单值） */
  weightRange: string;
}

export const BUILTIN_SERIF: BuiltinFont = {
  id: "__builtin_serif__",
  cssFamily: "REword Serif SC",
  file: "assets/fonts/REwordSerifSC-VF.woff2",
  kind: "serif",
  approxSize: 4_100_000,
  // wght 轴 250–900（源文件默认实例是 250）；低于 250 会按 250 渲染
  weightRange: "250 900",
};

export const BUILTIN_SANS: BuiltinFont = {
  id: "__builtin_sans__",
  cssFamily: "REword Sans SC",
  file: "assets/fonts/REwordSansSC-Regular.woff2",
  kind: "sans",
  approxSize: 2_600_000,
  weightRange: "400",
};

export const BUILTIN_FONTS: BuiltinFont[] = [BUILTIN_SERIF, BUILTIN_SANS];

/** 按 id 取内置字体（非内置值返回 undefined） */
export function builtinById(id: string): BuiltinFont | undefined {
  const v = (id || "").trim();
  if (!v) return undefined;
  return BUILTIN_FONTS.find((f) => f.id === v);
}

/** 按链归属取内置字体 */
export function builtinOfKind(kind: "serif" | "sans"): BuiltinFont {
  return kind === "sans" ? BUILTIN_SANS : BUILTIN_SERIF;
}

/**
 * 把「中文字体」槽的持久化值解析成**实际的 CSS 族名**。
 *
 * - 空值 / `__auto__`：跟随正文分类 —— 衬线链用思源宋体，无衬线链用思源黑体。
 *   这是 2026-11-13 的行为变更：此前空值 = 不插入中文字体槽，
 *   汉字实际由候选池第一名（霞鹜文楷）接走，与「默认字体」选择无关 ⇒
 *   用户切换衬线/无衬线时中文纹丝不动，正是「选什么都没反应」的根源。
 * - 内置 id：映射到独立 CSS 族名。
 * - 其它：原样返回（系统字体名 / 用户导入的字体名）。
 */
export function resolveCjkFamily(chosen: string, kind: "serif" | "sans"): string {
  const v = (chosen || "").trim();
  if (!v || v === CJK_AUTO) return builtinOfKind(kind).cssFamily;
  const b = builtinById(v);
  if (b) return b.cssFamily;
  return v;
}

/** 「自动」的显式别名（设置面板用符号值，空串仍是历史默认值） */
export const CJK_AUTO = "__auto__";

/**
 * 系统中文族名映射（对标 Readest `@font-face { src: local(...) }` 的做法）。
 *
 * 书籍 CSS 里常写 Windows 族名（`宋体` / `SimSun` / `FangSong`…），
 * macOS 上一个都不存在 ⇒ 浏览器按「未知族名」处理，直接落到通用族。
 * 这里给这些名字注册一个只用 `local()` 的 face：
 *   · 命中本机同名/近似字体 → 用本机字体；
 *   · 全部 local() 失败 → 该 @font-face 无效，浏览器照旧按未知族名回退（零风险）。
 *
 * 刻意**不映射** mac 已有的族名（PingFang SC / Songti SC / Hiragino…），
 * 否则会用我们的 face 顶掉系统真实字体，反而改变未写该族名的书籍观感。
 */
export const CJK_LOCAL_ALIAS_FACES: { family: string; locals: string[] }[] = [
  // 宋体系：Windows 宋体 / 中易宋体 → macOS 宋体-简 / 内置思源宋体
  { family: "宋体", locals: ["Songti SC", "STSong", "Source Han Serif SC", "SimSun"] },
  { family: "SimSun", locals: ["Songti SC", "STSong", "Source Han Serif SC"] },
  { family: "中易宋体", locals: ["Songti SC", "STSong", "Source Han Serif SC"] },
  // 黑体系
  { family: "黑体", locals: ["Heiti SC", "STHeiti", "PingFang SC", "SimHei"] },
  { family: "SimHei", locals: ["Heiti SC", "STHeiti", "PingFang SC"] },
  { family: "中易黑体", locals: ["Heiti SC", "STHeiti", "PingFang SC"] },
  // 楷体 / 仿宋
  { family: "楷体", locals: ["Kaiti SC", "STKaiti", "KaiTi", "LXGW WenKai"] },
  { family: "KaiTi", locals: ["Kaiti SC", "STKaiti", "LXGW WenKai"] },
  { family: "仿宋", locals: ["STFangsong", "FangSong"] },
  { family: "FangSong", locals: ["STFangsong"] },
  // 微软雅黑（mac 没有，落到苹方——同为屏幕无衬线黑体，观感最接近）
  { family: "微软雅黑", locals: ["Microsoft YaHei", "PingFang SC"] },
  { family: "Microsoft YaHei", locals: ["PingFang SC", "Heiti SC"] },
];

/**
 * 生成系统中文族名映射的 CSS 段。
 *
 * 别名 face **不接**内置字体：书籍显式指定「宋体」而本机没有宋体时，
 * 字形该由正文链决定（内置思源宋体本来就在链里），在这里硬塞一份反而
 * 会让「书籍指定了黑体，却显示成宋体」这类错误更难排查。
 */
export function cjkAliasFaceCss(): string {
  return CJK_LOCAL_ALIAS_FACES.map(({ family, locals }) => {
    const src = locals.map((l) => `local("${l}")`).join(",");
    return `@font-face{font-family:"${family}";src:${src};font-display:swap;}`;
  }).join("\n");
}

/* ================= 运行时加载（blob → @font-face） ================= */

/** 已就绪的内置字体 face CSS（按 cssFamily 缓存，避免重复 createObjectURL） */
const faceCssCache = new Map<string, string>();

/** 插件资源 URL（思源把插件目录挂到 /plugins/<name>/ 下，与 pdf.js 取 worker 同一策略） */
export function builtinFontUrl(pluginName: string, font: BuiltinFont): string {
  const origin =
    typeof location !== "undefined" && location.origin ? location.origin : "";
  return `${origin}/plugins/${pluginName}/${font.file}`;
}

/**
 * 加载单个内置字体，返回可直接注入 iframe 的 @font-face CSS。
 *
 * 返回 `src` 列表：blob URL 优先（iframe 内无需 CORS），插件 URL 兜底
 * （blob 化失败时仍有同源绝对地址可用）。两者都失败 ⇒ 返回空串，
 * 字体栈里的族名自然失效、回退到系统中文，不会白屏。
 */
export async function loadBuiltinFontFace(
  pluginName: string,
  font: BuiltinFont
): Promise<string> {
  const cached = faceCssCache.get(font.cssFamily);
  if (cached) return cached;
  if (!pluginName) return "";
  const absUrl = builtinFontUrl(pluginName, font);
  const sources: string[] = [];
  try {
    const res = await fetch(absUrl, { cache: "force-cache" });
    if (res.ok) {
      const blob = await res.blob();
      if (blob.size > 1024) {
        const url = URL.createObjectURL(blob);
        sources.push(`url("${url}") format("woff2")`);
      }
    }
  } catch {
    /* blob 化失败 → 下面用绝对 URL 兜底 */
  }
  sources.push(`url("${absUrl}") format("woff2")`);
  const css =
    `@font-face{font-family:"${font.cssFamily}";` +
    `src:${sources.join(",")};` +
    `font-weight:${font.weightRange};font-style:normal;font-display:swap;}`;
  faceCssCache.set(font.cssFamily, css);
  return css;
}

/**
 * 预热「当前正文字体分类」对应的那一款内置字体。
 *
 * 与 `prepareHostFontBlobs` 同样的约束：`buildFontFamilyLists()` 是同步纯函数，
 * 字体栈里只能写族名，所以必须在首次 applyStyles 之前把 face 注入好；
 * 注入失败也不阻塞 —— 族名失效即回退系统中文。
 *
 * @param kinds 需要预热的分类（衬线 / 无衬线；默认两者都备好，仅 2 个文件）
 * @returns 可拼进 fontFaceCss 的字符串（未就绪的项为空）
 */
export async function prepareBuiltinFontFaces(
  pluginName: string,
  kinds: ("serif" | "sans")[] = ["serif", "sans"]
): Promise<string> {
  const out: string[] = [];
  for (const kind of kinds) {
    const font = builtinOfKind(kind);
    try {
      const css = await loadBuiltinFontFace(pluginName, font);
      if (css) out.push(css);
    } catch {
      /* 单个字体失败不影响另一个 */
    }
  }
  return out.join("\n");
}

/** 同步取已就绪的 face CSS（供 buildFontInjection 这类同步路径使用） */
export function readyBuiltinFaceCss(): string {
  return BUILTIN_FONTS.map((f) => faceCssCache.get(f.cssFamily) || "")
    .filter(Boolean)
    .join("\n");
}

/** 已注册进主文档的内置字体（避免重复 `document.fonts.add`） */
const docRegistered = new Set<string>();

/**
 * 把内置字体注册到**主文档**（不只是阅读 iframe）。
 *
 * 为什么需要：设置面板要用 canvas 试画这些字体，才能判断「它和其它字体长得一样吗」，
 * 也是将来做「每行字体小样预览」的前提。未注册时 canvas 画出来是回退帧，
 * 会被判成「未安装」（`renderableValues` 里有 `__builtin_` 豁免，不会真的隐藏，
 * 但也就无法参与去重，列表里会和系统里那份思源宋体重复出现两行）。
 *
 * 失败不抛：任何一步出错就跳过，阅读器照常用 iframe 里的那份。
 */
export async function ensureBuiltinFontsInDocument(pluginName: string): Promise<void> {
  if (!pluginName) return;
  if (typeof document === "undefined" || !(document as any).fonts) return;
  await Promise.all(
    BUILTIN_FONTS.map(async (font) => {
      if (docRegistered.has(font.cssFamily)) return;
      try {
        const res = await fetch(builtinFontUrl(pluginName, font), { cache: "force-cache" });
        if (!res.ok) return;
        const buf = await res.arrayBuffer();
        const face = new FontFace(font.cssFamily, buf, { weight: font.weightRange, style: "normal" });
        await face.load();
        (document as any).fonts.add(face);
        docRegistered.add(font.cssFamily);
      } catch {
        /* 单个失败不影响另一个，也不影响阅读 */
      }
    })
  );
}
