/**
 * 翻译 Provider 的 POST 公共通道（2026-11-19 P2-11）
 * ------------------------------------------------------------------
 * 为什么不是直接 fetch：
 *  - 移动端插件跑在思源 App 的 WebView 里，页面是**局域网 / 非安全上下文**，
 *    自建 LibreTranslate、企业内网 Azure 端点经常因 CORS 预检直接失败；
 *  - 桌面端同源问题也存在（iframe null 源）。
 * 思源内核的 `/api/network/forwardProxy` 是服务端转发，没有 CORS，也不受混合内容限制。
 *
 * 口径与 tencent / baidu / youdao 一致：**先走代理，代理不可用时回落到直连**。
 * 回落是必要的 —— 老内核没有 forwardProxy、或用户在独立页面里调用本模块时，
 * 直连至少还有机会成功（公共 LibreTranslate 实例默认开 CORS）。
 *
 * ⚠️ 用动态 import 引入 siyuan/api：本目录下的 provider 有单测与纯函数场景，
 * 静态 import 会把整个思源 API 层拖进依赖图。
 */

export interface PostJsonResult {
  /** HTTP 状态；0 表示网络层失败（没有拿到任何响应） */
  status: number;
  /** 响应体（文本；Provider 自己 JSON.parse） */
  text: string;
  /** 走了哪条通道（排障用） */
  via: "proxy" | "direct";
}

/** POST JSON，优先经思源内核 forwardProxy 转发，失败回落直连 fetch */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  payload: string,
  timeout = 30000,
): Promise<PostJsonResult> {
  try {
    const { forwardProxyRaw } = await import("../../siyuan/api.ts");
    const r = await forwardProxyRaw({ url, method: "POST", headers, payload, timeout, contentType: "application/json" });
    // status 为 0 / 缺省 ⇒ 内核侧网络失败，交给直连再试一次
    if (r && typeof r.status === "number" && r.status > 0) {
      return { status: r.status, text: r.body ?? "", via: "proxy" };
    }
  } catch {
    /* 非思源环境 / 老内核：忽略，走直连 */
  }
  try {
    const res = await fetch(url, { method: "POST", headers, body: payload });
    return { status: res.status, text: await res.text(), via: "direct" };
  } catch (e) {
    return { status: 0, text: e instanceof Error ? e.message : String(e), via: "direct" };
  }
}
