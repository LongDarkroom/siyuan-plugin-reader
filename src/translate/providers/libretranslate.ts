/**
 * LibreTranslate（开源免费翻译，支持公共实例）
 * ------------------------------------------------------------------
 * - 公共实例（如 https://libretranslate.com）零配置即可用，但有限流 / 隐私弱。
 * - CORS：公共实例默认开启跨域，浏览器前端可直接调用。
 * - 鉴权：公共实例多为可选 apiKey；本实现不强制（留空即匿名）。
 * - 目标语言：简体中文用 "zh"（LibreTranslate 同时接受 "zh"、"zh-CN"）。
 * - 批量：官方 API 的 q 字段支持字符串数组，返回 [{translatedText}, ...]。
 */
import type { Translator, TranslateRequest } from "../types.ts";
import { postJson } from "./proxy-post.ts";

export class LibreTranslator implements Translator {
  readonly name = "libretranslate" as const;

  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  get available(): boolean {
    return !!this.baseUrl?.trim();
  }

  async translate(req: TranslateRequest): Promise<string[]> {
    if (!this.available) throw new Error("LibreTranslate URL 未配置");

    const base = this.baseUrl.replace(/\/+$/, "");
    const source = req.from && req.from !== "auto" ? req.from : "auto";
    const target = req.to === "zh" ? "zh" : req.to;

    // 2026-11-19 P2-11：直连 fetch → postJson（先内核转发、再回落直连）。
    // 自建实例常没开 CORS，手机 WebView 里直连必失败；其余 provider 早就走代理了。
    const r = await postJson(
      `${base}/translate`,
      { "Content-Type": "application/json" },
      JSON.stringify({ q: req.texts, source, target, format: "text" }),
    );
    if (r.status === 0) {
      throw new Error(`LibreTranslate 网络请求失败：${r.text.slice(0, 200)}`);
    }

    if (r.status < 200 || r.status >= 300) {
      throw new Error(`LibreTranslate 请求失败 (${r.status}): ${r.text.slice(0, 200)}`);
    }

    const data = JSON.parse(r.text);
    if (Array.isArray(data)) {
      return data.map((d: any) => d?.translatedText ?? "");
    }
    if (data && typeof data.translatedText === "string") {
      // 有些实例对数组 q 仍返回单条，按原数组长度平铺
      return req.texts.map(() => data.translatedText);
    }
    throw new Error("LibreTranslate 响应格式异常");
  }
}
