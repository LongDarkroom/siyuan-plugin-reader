/**
 * 文件在位探测（书库 / 字体共用）
 * ---------------------------------------------------------------
 * 判定「这个文件还在不在」只有一个可靠且便宜的办法：读它所在目录的清单。
 * `/api/file/getFile` 拿 404 也能判，但那要整份传输，几十 MB 的书不适合；
 * `readDir` 只回文件名，一本书的书架一次性探完。
 *
 * 三态返回是刻意的：
 *   true  = 确认在位
 *   false = 确认不在（目录 404 也算「不在」，目录不存在 ⇒ 文件更不存在）
 *   null  = 判断不了（网络错误、非 0 code）—— 调用方**不要**据此改索引，
 *           否则一次抖动就会把好书标成「已丢失」。
 */

/** 目录内文件名清单；目录不存在 → 空集；无法判断 → null */
export async function listDirNames(dir: string): Promise<Set<string> | null> {
  try {
    const res = await fetch("/api/file/readDir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: dir }),
    });
    if (res.status === 404) return new Set();
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    if (json?.code === 0 && Array.isArray(json.data)) {
      return new Set<string>(
        json.data.filter((x: any) => x && !x.isDir).map((x: any) => String(x.name))
      );
    }
    if (json?.code === 404) return new Set();
    return null;
  } catch {
    return null;
  }
}

/** 文件是否在位：true 在 / false 不在 / null 无法判断（空路径直接判 false） */
export async function probeFile(path: string): Promise<boolean | null> {
  if (!path) return false;
  const slash = path.lastIndexOf("/");
  const files = await listDirNames(path.slice(0, slash));
  if (!files) return null;
  return files.has(path.slice(slash + 1));
}
