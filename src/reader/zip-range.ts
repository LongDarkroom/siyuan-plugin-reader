/**
 * 远端 zip 的**按需读取**（Range 版只读归档）
 * ---------------------------------------------------------------
 * 为什么需要它（2026-11-25，C 期「引用式导入」地基）：
 *
 * 引用式导入不复制文件，书还在原处（思源资源 / public / http 直链）。
 * 想在**不下载整本**的前提下拿到书名、作者、封面，就必须能从远端 zip 里
 * 只读那几个条目 —— 一本 148 MB 的 AZW3/EPUB 不该为了一个书名全量下载，
 * 更不该像现在这样「整本读进内存再全量解压」。
 *
 * 做法是最小的 zip 中央目录读取器：
 *   1. 取文件尾部 ≤ 64 KB，从后往前找 EOCD（0x06054b50）→ 得到目录偏移/长度；
 *   2. 取那段中央目录，解析出每个条目的名字、压缩方式、压缩/原始长度、本地头偏移；
 *   3. `read()` 时按偏移取本地头 → 算出数据起点 → 只取该条目的字节 → inflate。
 *
 * 三个刻意的边界：
 *  - **只支持普通 zip**（EPUB/CBZ 够用）；遇到 Zip64 直接抛 `zip64`，调用方回落整本读。
 *  - **服务器必须支持 Range**（思源的 `/public` 与 `/assets` 都支持，实测 206）。
 *    返回 200 说明被忽略，抛 `range-unsupported`，同样由调用方回落。
 *  - **单条目有上限**：调用方给 `maxBytes`，超了不取（封面不该为一张图换内存）。
 */

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const EOCD_MIN = 22;
/** EOCD 之后最多 64 KB 注释（zip 规范限制） */
const EOCD_MAX_TAIL = 65558;

export interface ZipRangeEntry {
  name: string;
  /** 0 = stored，8 = deflate */
  method: number;
  compSize: number;
  uncompSize: number;
  /** 本地文件头在文件中的偏移 */
  headerOffset: number;
}

export class ZipRangeError extends Error {
  /**
   * 刻意不用构造器参数属性（`constructor(public reason: …)`）：
   * 测试 loader 会把参数属性降级成「先赋值 this、后 super()」的写法，
   * 派生类在 super() 之前访问 this 会直接抛 TypeError。显式写字段最稳。
   */
  readonly reason: "range-unsupported" | "zip64" | "bad-zip" | "http";

  constructor(reason: "range-unsupported" | "zip64" | "bad-zip" | "http", message?: string) {
    super(message || reason);
    this.name = "ZipRangeError";
    this.reason = reason;
  }
}

async function fetchRange(url: string, start: number, end: number): Promise<Uint8Array> {
  const res = await fetch(url, {
    headers: { Range: `bytes=${start}-${end}` },
    // 复用 cookie（思源的 /assets 与 /public 都走同源会话）
    credentials: "same-origin",
  });
  if (res.status === 416) throw new ZipRangeError("bad-zip", "416");
  if (res.status !== 206) {
    // 200 = 服务器忽略 Range 直接给了整份：不在这里吞掉，交给调用方决定回落
    throw new ZipRangeError("range-unsupported", `status ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

function u16(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}
function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

export class RangeZip {
  private constructor(
    private url: string,
    private entries: Map<string, ZipRangeEntry>,
    readonly size: number
  ) {}

  get names(): string[] {
    return [...this.entries.keys()];
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** 探测远端文件大小（HEAD 优先；不支持时用 Range 0-0 的 Content-Range 兜底） */
  static async probeSize(url: string): Promise<number> {
    try {
      const head = await fetch(url, { method: "HEAD", credentials: "same-origin" });
      const len = Number(head.headers.get("content-length") || 0);
      if (head.ok && len > 0) return len;
    } catch { /* 某些服务器/代理禁 HEAD，走下面的 Range 兜底 */ }
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Range: "bytes=0-0" },
        credentials: "same-origin",
      });
    } catch {
      // 网络层直接失败（域名不通/连接被拒/CORS）：这里必须给出人话，
      // 否则 UI 上只会是 "Failed to fetch"
      throw new ZipRangeError("http", "引用不可达，无法获取文件大小");
    }
    const cr = res.headers.get("content-range") || "";
    const total = Number(cr.split("/")[1] || 0);
    if (total > 0) return total;
    const len = Number(res.headers.get("content-length") || 0);
    if (len > 0) return len;
    throw new ZipRangeError("http", "引用不可达，无法获取文件大小");
  }

  /** 打开远端 zip（只读中央目录，不下载正文） */
  static async open(url: string, sizeHint?: number): Promise<RangeZip> {
    const size = sizeHint && sizeHint > 0 ? sizeHint : await RangeZip.probeSize(url);
    if (size < EOCD_MIN) throw new ZipRangeError("bad-zip", "太小");

    const tailLen = Math.min(size, EOCD_MAX_TAIL);
    const tailStart = size - tailLen;
    const tail = await fetchRange(url, tailStart, size - 1);

    let eocd = -1;
    for (let i = tail.length - EOCD_MIN; i >= 0; i--) {
      if (u32(tail, i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new ZipRangeError("bad-zip", "找不到 EOCD");

    const count = u16(tail, eocd + 10);
    const cdSize = u32(tail, eocd + 12);
    const cdOffset = u32(tail, eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw new ZipRangeError("zip64", "Zip64 不支持（回落整本读）");
    }

    const cd = await fetchRange(url, cdOffset, cdOffset + cdSize - 1);
    const entries = new Map<string, ZipRangeEntry>();
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || u32(cd, p) !== CEN_SIG) break;
      const method = u16(cd, p + 10);
      const compSize = u32(cd, p + 20);
      const uncompSize = u32(cd, p + 24);
      const nameLen = u16(cd, p + 28);
      const extraLen = u16(cd, p + 30);
      const commentLen = u16(cd, p + 32);
      const headerOffset = u32(cd, p + 42);
      const name = new TextDecoder().decode(cd.subarray(p + 46, p + 46 + nameLen));
      entries.set(name, { name, method, compSize, uncompSize, headerOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return new RangeZip(url, entries, size);
  }

  /** 读单个条目的原始字节；超过 maxBytes 或不存在时返回 null */
  async read(name: string, maxBytes = Infinity): Promise<Uint8Array | null> {
    const e = this.entries.get(name);
    if (!e) return null;
    if (e.uncompSize > maxBytes) return null;
    // 本地头 30 字节足够读出名字/扩展字段长度（名字本身不用再取，长度在头里）
    const local = await fetchRange(this.url, e.headerOffset, e.headerOffset + 29);
    if (u32(local, 0) !== LOC_SIG) throw new ZipRangeError("bad-zip", `本地头损坏: ${name}`);
    const dataStart = e.headerOffset + 30 + u16(local, 26) + u16(local, 28);
    if (!e.compSize) return new Uint8Array(0);
    const raw = await fetchRange(this.url, dataStart, dataStart + e.compSize - 1);
    if (e.method === 0) return raw;
    if (e.method === 8) {
      const { inflateSync } = await import("fflate");
      try {
        return e.uncompSize > 0
          ? inflateSync(raw, { out: new Uint8Array(e.uncompSize) })
          : inflateSync(raw);
      } catch {
        return null; // 损坏条目按「读不到」处理，不阻断上层
      }
    }
    return null; // 不认识的压缩方式（bzip2/lzma 等）
  }

  async readText(name: string, maxBytes = 4 * 1024 * 1024): Promise<string | null> {
    const bytes = await this.read(name, maxBytes);
    return bytes ? new TextDecoder().decode(bytes) : null;
  }
}
