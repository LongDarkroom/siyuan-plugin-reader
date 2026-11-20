/**
 * 双语运行时 · 字符脚本统计（L0 core）
 * ==================================================================
 * 2026-11-20 从 runtime/detector.ts 抽出，供两处共用：
 *   1. 整书语种闸门（detector）：判断这本书是不是英文书；
 *   2. **块级语种闸门**（segmenter）：英文书里夹的中文页（站点塞的简介 /
 *      人物介绍 / 推广页）不该送译 —— 源语言一律按 auto 发给引擎，
 *      中文进去就是中文出来，界面上就是一模一样的重复行，还白烧额度。
 *
 * 纯函数、零 DOM 依赖，可被 test/ 直接 import。
 */

/** 统计拉丁字母与 CJK 字符数（CJK 含假名、扩展 A、统一/兼容表意文字、韩文音节） */
export function countScripts(sample: string): { latin: number; cjk: number } {
  let latin = 0;
  let cjk = 0;
  for (const ch of sample) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
      latin++;
    } else if (
      (code >= 0x3040 && code <= 0x30ff) || // 日文平假名 / 片假名
      (code >= 0x3400 && code <= 0x4dbf) || // CJK 扩展 A
      (code >= 0x4e00 && code <= 0x9fff) || // CJK 统一表意文字
      (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容表意文字
      (code >= 0xac00 && code <= 0xd7af) // 韩文音节
    ) {
      cjk++;
    }
  }
  return { latin, cjk };
}

/**
 * CJK 字符在「拉丁 + CJK」里的占比（0–1）；两者都为 0（纯数字/符号）返回 0。
 */
export function cjkRatioOf(text: string): number {
  const { latin, cjk } = countScripts(text || "");
  const denom = latin + cjk;
  return denom === 0 ? 0 : cjk / denom;
}

/** 块级闸门阈值：CJK 占到一半即视为「这段本来就是目标语言」 */
export const BLOCK_CJK_DOMINANT_RATIO = 0.5;

/** 该文本是否 CJK 主导（块级语种闸门用） */
export function isCjkDominant(text: string): boolean {
  return cjkRatioOf(text) >= BLOCK_CJK_DOMINANT_RATIO;
}

/**
 * 中日韩——用 CJK 文字书写的目标语言。
 * 块级闸门**只在目标语言属于这些时生效**：目标若是 en/fr/de，
 * 中文块是真的需要翻译的，不能跳过。
 */
const CJK_WRITTEN_LANGS: ReadonlySet<string> = new Set(["zh", "ja", "ko"]);

/** 目标语言码是否用 CJK 文字书写（"zh-Hant" / "zh-CN" 取主标签后判定） */
export function isCjkWrittenLang(code?: string | null): boolean {
  if (!code) return false;
  const m = String(code).trim().toLowerCase().match(/^([a-z]{2,3})/);
  return !!m && CJK_WRITTEN_LANGS.has(m[1]);
}
