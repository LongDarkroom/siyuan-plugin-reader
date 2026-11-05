/**
 * AI 页签 · 跟随活动阅读器 / 锁定本书（纯逻辑）
 * ----------------------------------------------------------------
 * 页签默认跟着「当前活动阅读器」走；用户点页签头的「锁定本书」后，
 * 即使另开了别的书也继续绑定锁定书。
 *
 * 锁定的书被关掉时**不关 AI 页签**：这里只把 `pinnedClosed` 置真，
 * 由视图展示空状态（提示 + 重新打开 / 恢复跟随），对话历史按 bookId
 * 存在 localStorage，重开即回。
 */

export interface AiTabPin {
  bookId: string;
  title: string;
}

export interface AiTabTarget {
  /** follow = 跟随活动阅读器；pinned = 锁定在某一本 */
  mode: "follow" | "pinned";
  /** 当前应绑定的书（pinned 时即使已关闭也保留，供「重新打开」用） */
  bookId: string;
  /** 锁定书关闭时空状态展示用书名 */
  title: string;
  /** 锁定的书已经没有打开的阅读器 */
  pinnedClosed: boolean;
  /** 此刻是否有活动阅读器（没有且未锁定时 = 完全空状态） */
  hasActiveReader: boolean;
}

export const AI_TAB_PIN_KEY = "reword-ai-tab-pin";

type PinStorage = Pick<Storage, "getItem" | "setItem" | "removeItem"> | null | undefined;

function text(v: unknown, max = 200): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function openIdsOf(list: Array<{ bookId?: unknown } | string> | undefined): Set<string> {
  const out = new Set<string>();
  for (const item of list || []) {
    const id = typeof item === "string" ? item : text(item?.bookId);
    if (id) out.add(id);
  }
  return out;
}

/**
 * 解析页签当前应绑定的书。
 *
 * 规则：
 *  1) 有锁定书 → 永远以锁定书为准（活动阅读器换成别的书也不动摇）；
 *  2) 没锁定 → 跟随活动阅读器；
 *  3) 两者都没有 → bookId 为空，视图展示空状态。
 */
export function resolveAiTabTarget(input: {
  pinnedBookId?: string;
  pinnedTitle?: string;
  activeBookId?: string;
  openBooks?: Array<{ bookId?: unknown } | string>;
} = {}): AiTabTarget {
  const pinned = text(input.pinnedBookId);
  const active = text(input.activeBookId);
  if (pinned) {
    const open = openIdsOf(input.openBooks).has(pinned) || active === pinned;
    return {
      mode: "pinned",
      bookId: pinned,
      title: text(input.pinnedTitle),
      pinnedClosed: !open,
      hasActiveReader: !!active,
    };
  }
  return {
    mode: "follow",
    bookId: active,
    title: "",
    pinnedClosed: false,
    hasActiveReader: !!active,
  };
}

export function loadAiTabPin(storage: PinStorage): AiTabPin {
  try {
    const raw = storage?.getItem(AI_TAB_PIN_KEY) || "";
    if (!raw) return { bookId: "", title: "" };
    const data = JSON.parse(raw) as any;
    return { bookId: text(data?.bookId), title: text(data?.title) };
  } catch {
    return { bookId: "", title: "" };
  }
}

export function saveAiTabPin(storage: PinStorage, pin: AiTabPin | null): void {
  try {
    const bookId = text(pin?.bookId);
    if (!bookId) {
      storage?.removeItem(AI_TAB_PIN_KEY);
      return;
    }
    storage?.setItem(AI_TAB_PIN_KEY, JSON.stringify({ bookId, title: text(pin?.title) }));
  } catch {
    /* 存储不可用（隐私模式等）时只影响记忆，不影响当前会话 */
  }
}
