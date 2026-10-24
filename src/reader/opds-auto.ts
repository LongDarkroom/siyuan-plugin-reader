/**
 * OPDS 订阅自动下载调度器（2026-10-15，参照 readest autoDownload/subscription）
 * ------------------------------------------------------------------
 * 书源开启「自动」后，定时拉取 feed，发现书架没有的新书自动下载入库。
 *
 * 设计要点：
 * - 调度器为模块级单例：首次 startOpdsAutoDownload 后常驻，面板关闭不影响；
 * - 书源清单/开关持久化在 localStorage（与 OpdsSearchPanel 共用 key）；
 * - 限制：每次每源最多 MAX_PER_RUN 本（对书源礼貌）；同一书按标题归一去重；
 * - 已知边界：仅书架视图被打开过（本模块被加载）后调度才启动；补全仅 title/author
 *   （封面略过，控制后台流量）。
 */

import { BUILTIN_CATALOGS, fetchOpdsFeed, downloadAsFile, type OpdsCatalog } from "./opds-client";
import type { BookshelfStore } from "./bookshelf-store";

export const OPDS_CATALOGS_KEY = "reword-opds-catalogs";
export const OPDS_AUTODL_KEY = "reword-opds-autodl";
const OPDS_AUTODL_STATE_KEY = "reword-opds-autodl-state";

const INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 小时
const FIRST_DELAY_MS = 90 * 1000; // 启动后 90s 跑第一轮
const MAX_PER_RUN = 3; // 每次每源最多入库本数

const normTitle = (s?: string) => (s || "").trim().toLowerCase();

export interface OpdsAutoDlRunState {
  ts: number;
  added: number;
  failed: number;
}

let timer: any = null;
let running = false;

function readCatalogs(): OpdsCatalog[] {
  let custom: OpdsCatalog[] = [];
  try {
    const raw = localStorage.getItem(OPDS_CATALOGS_KEY);
    if (raw) custom = JSON.parse(raw);
  } catch {
    // ignore
  }
  return [...BUILTIN_CATALOGS, ...custom];
}

function readAutoDlMap(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(OPDS_AUTODL_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  return {};
}

function readRunState(): Record<string, OpdsAutoDlRunState> {
  try {
    const raw = localStorage.getItem(OPDS_AUTODL_STATE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  return {};
}

function writeRunState(s: Record<string, OpdsAutoDlRunState>): void {
  try {
    localStorage.setItem(OPDS_AUTODL_STATE_KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}

/** 供管理 UI 展示「上次自动下载」状态 */
export function getAutoDlRunState(): Record<string, OpdsAutoDlRunState> {
  return readRunState();
}

async function runOnce(store: BookshelfStore): Promise<void> {
  if (running) return;
  running = true;
  try {
    const autodl = readAutoDlMap();
    const catalogs = readCatalogs().filter((c) => autodl[c.id] === true);
    if (!catalogs.length) return;
    await store.load();
    const owned = new Set(store.list.map((b) => normTitle(b.title)));
    const state = readRunState();
    for (const c of catalogs) {
      const st: OpdsAutoDlRunState = { ts: Date.now(), added: 0, failed: 0 };
      try {
        const feed = await fetchOpdsFeed(c.url, c.auth, c.customHeaders);
        const pubs = feed.entries.filter(
          (e) => e.kind === "publication" && e.download && !owned.has(normTitle(e.title))
        );
        for (const e of pubs.slice(0, MAX_PER_RUN)) {
          try {
            const file = await downloadAsFile(e.download!.href, c.auth, e.title);
            const meta = await store.importBook(file);
            if (meta) {
              st.added++;
              owned.add(normTitle(e.title));
              try {
                await store.enrichFromOpds(meta.id, { title: e.title, author: e.author });
              } catch {
                // 补全失败不影响自动下载
              }
            }
            // meta 为 null = 书架已有同指纹书（被跳过），不计失败
          } catch {
            st.failed++;
          }
        }
      } catch {
        st.failed++;
      }
      state[c.id] = st;
      writeRunState(state);
    }
  } finally {
    running = false;
  }
}

/**
 * 启动订阅自动下载调度器（模块级单例，重复调用无副作用）。
 * 由 BookshelfView 挂载时调用（传入书架 store 实例）。
 */
export function startOpdsAutoDownload(store: BookshelfStore): void {
  if (timer) return;
  timer = window.setInterval(() => void runOnce(store), INTERVAL_MS);
  window.setTimeout(() => void runOnce(store), FIRST_DELAY_MS);
}
