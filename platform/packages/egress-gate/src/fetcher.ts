/**
 * 闸门本机抓取（第 04 篇 §5.1 `/fetch`：本机直连或抓取代理；G0 为本机直连）：
 * 每一跳都先做静态检查（url-guard），再解析域名并要求全部地址为公网地址，连接钉在已校验的地址上（防 DNS 重绑定），
 * 手动跟随重定向（≤ 5 跳，每跳重新校验）；只 GET；响应大小、时长、类型有上限；结果标注“不可信外部内容”。
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import type { MatterTokenizer } from "@zr-legal/tokenizer";
import { checkUrlStatic, DEFAULT_ALLOWED_PORTS, isPublicAddress } from "./url-guard.ts";

export interface FetchLimits {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
}

export const DEFAULT_FETCH_LIMITS: FetchLimits = Object.freeze({ maxBytes: 5 * 1024 * 1024, timeoutMs: 20_000, maxRedirects: 5 });

export class FetchDenied extends Error {
  readonly reason: string;
  constructor(reason: string, detail?: string) {
    super(`抓取被出站闸门拒绝：${reason}${detail ? `（${detail}）` : ""}`);
    this.reason = reason;
  }
}

export interface FetchOutcome {
  finalUrl: string;
  status: number;
  contentType: string;
  /** 已转为纯文本（HTML 去标签）；超长截断。 */
  text: string;
  bytes: number;
  truncated: boolean;
  hops: string[];
}

/** 解析域名并校验全部地址为公网；返回钉住的地址。 */
export type Resolver = (host: string) => Promise<{ address: string; family: 4 | 6 }[]>;

const systemResolver: Resolver = async (host) => {
  const r = await dnsLookup(host, { all: true, verbatim: true });
  return r.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

/** 地址准入（缺省：只允许公网地址）。只能由宿主代码在构造时传入，请求无法影响。 */
export type AddressPolicy = (ip: string) => boolean;

async function resolvePublic(host: string, resolver: Resolver, allowed: AddressPolicy): Promise<{ address: string; family: 4 | 6 }> {
  const bare = host.replace(/^\[|\]$/g, "");
  if (/^[\d.]+$/.test(bare) || bare.includes(":")) {
    if (!allowed(bare)) throw new FetchDenied("address_not_public", bare);
    return { address: bare, family: bare.includes(":") ? 6 : 4 };
  }
  let addrs: { address: string; family: 4 | 6 }[];
  try {
    addrs = await resolver(bare);
  } catch {
    throw new FetchDenied("dns_failed", bare);
  }
  if (addrs.length === 0) throw new FetchDenied("dns_empty", bare);
  // 任何一个地址不是公网即拒绝（不挑“好的”那个：防混合应答）
  const bad = addrs.find((a) => !allowed(a.address));
  if (bad) throw new FetchDenied("address_not_public", `${bare} → ${bad.address}`);
  return addrs[0]!;
}

function pinnedLookup(pin: { address: string; family: 4 | 6 }, allowed: AddressPolicy): LookupFunction {
  return ((_host: string, opts: { all?: boolean } | number | undefined, cb: (...a: unknown[]) => void) => {
    const all = typeof opts === "object" && opts?.all;
    if (!allowed(pin.address)) return cb(new Error("address_not_public"));
    if (all) cb(null, [{ address: pin.address, family: pin.family }]);
    else cb(null, pin.address, pin.family);
  }) as unknown as LookupFunction;
}

function getOnce(url: URL, pin: { address: string; family: 4 | 6 }, allowed: AddressPolicy, limits: FetchLimits, signal?: AbortSignal): Promise<{ res: IncomingMessage; body: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "GET",
        lookup: pinnedLookup(pin, allowed),
        headers: {
          "user-agent": "KimiWorkLegal-Gate/0.1 (+fetch for legal research)",
          accept: "text/html,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.1",
          "accept-encoding": "identity",
        },
        timeout: limits.timeoutMs,
        ...(signal ? { signal } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on("data", (c: Buffer) => {
          if (truncated) return;
          size += c.length;
          if (size > limits.maxBytes) {
            truncated = true;
            chunks.push(c.subarray(0, c.length - (size - limits.maxBytes)));
            res.destroy();
            resolve({ res, body: Buffer.concat(chunks), truncated: true });
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          if (!truncated) resolve({ res, body: Buffer.concat(chunks), truncated: false });
        });
        res.on("error", (e) => {
          if (!truncated) reject(e);
        });
      },
    );
    req.on("timeout", () => req.destroy(new FetchDenied("timeout")));
    req.on("error", reject);
    req.end();
  });
}

/** 把 HTML 转成可读纯文本（去脚本、样式、标签；块级元素换行）。 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function gateFetch(
  raw: string,
  o: {
    tokenizer?: MatterTokenizer;
    resolver?: Resolver;
    addressPolicy?: AddressPolicy;
    allowedPorts?: readonly number[];
    limits?: Partial<FetchLimits>;
    signal?: AbortSignal;
    /** 域名准入（白名单）：首跳与每一次重定向都须通过（防开放重定向绕过白名单）。缺省不限。 */
    allowHost?: (host: string) => boolean;
  } = {},
): Promise<FetchOutcome> {
  const limits = { ...DEFAULT_FETCH_LIMITS, ...o.limits };
  const resolver = o.resolver ?? systemResolver;
  const allowed = o.addressPolicy ?? isPublicAddress;
  const hops: string[] = [];
  let current = raw;
  for (let hop = 0; hop <= limits.maxRedirects; hop++) {
    const v = checkUrlStatic(current, o.tokenizer, o.allowedPorts ?? DEFAULT_ALLOWED_PORTS);
    if (!v.ok) throw new FetchDenied(v.reason, v.detail);
    const host = v.url.hostname.toLowerCase().replace(/\.$/, "");
    if (o.allowHost && !o.allowHost(host)) throw new FetchDenied(hop === 0 ? "fetch_domain_not_allowlisted" : "redirect_domain_not_allowlisted", host);
    const pin = await resolvePublic(v.url.hostname, resolver, allowed);
    hops.push(v.url.href);
    const { res, body, truncated } = await getOnce(v.url, pin, allowed, limits, o.signal);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      current = new URL(res.headers.location, v.url).href;
      continue;
    }
    const contentType = String(res.headers["content-type"] ?? "");
    if (!/^(?:text\/|application\/(?:json|xhtml\+xml|xml))/i.test(contentType)) {
      throw new FetchDenied("content_type_not_allowed", contentType || "（无）");
    }
    const charset = /charset=([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase();
    let decoded: string;
    try {
      decoded = new TextDecoder(charset && charset !== "utf8" ? charset : "utf-8").decode(body);
    } catch {
      decoded = body.toString("utf8");
    }
    const text = /html/i.test(contentType) ? htmlToText(decoded) : decoded;
    return { finalUrl: v.url.href, status, contentType, text, bytes: body.length, truncated, hops };
  }
  throw new FetchDenied("too_many_redirects");
}
