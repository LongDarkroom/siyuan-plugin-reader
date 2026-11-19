/**
 * Microsoft Translator (Azure 认知服务翻译)
 * ------------------------------------------------------------------
 * - 免费额度：200 万字符 / 月。
 * - CORS：官方支持跨域（浏览器前端可直接调用）。
 * - 鉴权：Ocp-Apim-Subscription-Key + Ocp-Apim-Subscription-Region 头。
 * - 目标语言：简体中文映射到 "zh-Hans"。
 * - 批量：请求体为 [{Text}, ...]，响应为 [{translations:[{text}]}, ...]。
 */
import type { Translator, TranslateRequest } from "../types.ts";
import { postJson } from "./proxy-post.ts";

export class MicrosoftTranslator implements Translator {
  readonly name = "microsoft" as const;

  private key: string;
  private region: string;

  constructor(key: string, region: string) {
    this.key = key;
    this.region = region;
  }

  get available(): boolean {
    return !!(this.key && this.region);
  }

  async translate(req: TranslateRequest): Promise<string[]> {
    if (!this.available) throw new Error("Microsoft Translator 未配置 key/region");

    const to = req.to === "zh" ? "zh-Hans" : req.to;
    const from = req.from && req.from !== "auto" ? req.from : undefined;

    const params = new URLSearchParams({ "api-version": "3.0", to });
    if (from) params.set("from", from);

    const url = `https://api.cognitive.microsofttranslator.com/translate?${params.toString()}`;
    const body = req.texts.map((t) => ({ Text: t }));

    // 2026-11-19 P2-11：直连 fetch → postJson（先内核转发、再回落直连）。
    // 企业内网 / 移动 WebView 下直连 Azure 端点会被 CORS 或混合内容挡掉。
    const r = await postJson(
      url,
      {
        "Ocp-Apim-Subscription-Key": this.key,
        "Ocp-Apim-Subscription-Region": this.region,
        "Content-Type": "application/json",
      },
      JSON.stringify(body),
    );
    if (r.status === 0) {
      throw new Error(`Microsoft Translator 网络请求失败：${r.text.slice(0, 200)}`);
    }

    if (r.status < 200 || r.status >= 300) {
      throw new Error(`Microsoft Translator 请求失败 (${r.status}): ${r.text.slice(0, 200)}`);
    }

    const data = JSON.parse(r.text) as Array<{ translations?: Array<{ text?: string }> }>;
    if (!Array.isArray(data)) throw new Error("Microsoft Translator 响应格式异常");

    return data.map((d) => d?.translations?.[0]?.text ?? "");
  }
}
