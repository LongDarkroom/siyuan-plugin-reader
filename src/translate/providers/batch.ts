/**
 * 批量翻译的通用分片与拆解
 * ------------------------------------------------------------------
 * 千问 MT 与通用大模型（OpenAI 兼容）都按「整批送译 → 按段落拆回」工作：
 * 一次请求塞多段原文，模型按空行分隔返回。两个纯函数在这里共用，
 * 避免两套实现漂移（过去「段数对不上就按位置硬摊」会静默错配译文）。
 */

/** 按字符预算 + 段数上限切片，返回每片在原文数组中的索引 */
export function chunkTexts(
  texts: string[],
  maxChars: number,
  maxCount: number,
): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  let chars = 0;
  for (let i = 0; i < texts.length; i++) {
    const len = (texts[i] || "").length;
    if (cur.length && (cur.length >= maxCount || chars + len > maxChars)) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(i);
    chars += len;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** 去掉代码围栏与「译文：」这类标题行 */
function stripNoise(raw: string): string {
  return (raw || "")
    .replace(/^```[\w-]*\s*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .split(/\n{2,}/)
    .filter((block) => !/^\s*(?:译文|翻译|translation)\s*[：:]?\s*$/i.test(block))
    .join("\n\n")
    .trim();
}

/** 剥掉模型自加的 [1] / 1. / 1、 编号 */
function stripNumber(s: string): string {
  return s.replace(/^\s*(?:\[\s*\d+\s*\]|\d+\s*[.、)])\s*/, "").trim();
}

/**
 * 拆解批量返回：优先按空行，退化到按单换行。
 * 段数对不上返回 null —— 调用方逐段重译，**绝不按位置硬摊**。
 */
export function splitBatch(raw: string, expect: number): string[] | null {
  const body = stripNoise(raw);
  if (!body) return null;
  if (expect <= 1) return [body];

  const blocks = body.split(/\n{2,}/).map(stripNumber).filter(Boolean);
  if (blocks.length === expect) return blocks;

  const lines = body.split(/\n+/).map(stripNumber).filter(Boolean);
  if (lines.length === expect) return lines;

  return null;
}

/** 从错误消息里取 HTTP 状态（requestAIGenerate 统一带「HTTP xxx」） */
export function httpStatus(e: unknown): number | null {
  const m = /HTTP\s+(\d{3})/.exec(String((e as any)?.message ?? e));
  return m ? Number(m[1]) : null;
}

/** 429 / 5xx / 网络异常值得重试；401/400 等配置错误立即失败 */
export function isRetriable(e: unknown): boolean {
  const status = httpStatus(e);
  if (status == null) return true;
  return status === 408 || status === 429 || status >= 500;
}
