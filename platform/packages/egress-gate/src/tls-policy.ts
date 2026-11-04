/**
 * 上游传输安全——闸门进程内的请求实现（undici Agent：证书校验不放宽、握手时核对钉住集）。规则说明见 tls-check.ts。
 */
import { createHash } from "node:crypto";
import { checkServerIdentity, rootCertificates, type DetailedPeerCertificate, type PeerCertificate } from "node:tls";
import { Agent, ProxyAgent, fetch as undiciFetch } from "undici";
import { isLoopbackHost, normalizePins, spkiPin } from "./tls-check.ts";

export { checkUpstream, isLoopbackHost, normalizePins, PIN_RE, spkiPin, type TransportCheck, type TransportState } from "./tls-check.ts";

/** 证书链（叶子起，至自签根或链尾）中每张证书的 SPKI 钉住值。 */
export function chainPins(cert: PeerCertificate | DetailedPeerCertificate): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let c: (PeerCertificate & { issuerCertificate?: DetailedPeerCertificate }) | undefined = cert;
  while (c && c.raw && out.length < 10) {
    const fp = c.fingerprint256 ?? createHash("sha256").update(c.raw).digest("hex");
    if (seen.has(fp)) break;
    seen.add(fp);
    try {
      out.push(spkiPin(c.raw));
    } catch {
      // 解析不了的证书不贡献钉住值
    }
    c = c.issuerCertificate;
  }
  return out;
}

export const PIN_MISMATCH_CODE = "KWL_TLS_PIN_MISMATCH";

/**
 * 为一个上游构造 fetch：证书校验不放宽、TLS ≥ 1.2；给了钉住集就在握手时核对（不命中即在发送任何请求字节之前断开）；
 * `caPem` 只用于律所私有端点（律所内部 CA）。
 */
export function upstreamFetch(o: { pins?: readonly string[] | null; caPem?: string | null; proxy?: { url: string; caPem?: string } | null } = {}): typeof fetch {
  const pins = normalizePins(o.pins) ?? [];
  // 经代理时：代理重签证书的根证书只追加到系统根之后（不替换），律所私有 CA 照旧
  const ca = o.proxy?.caPem ? [...rootCertificates, o.proxy.caPem, ...(o.caPem ? [o.caPem] : [])] : o.caPem ? o.caPem : undefined;
  const tlsOpts = {
    rejectUnauthorized: true,
    minVersion: "TLSv1.2" as const,
    ...(ca ? { ca } : {}),
    checkServerIdentity(host: string, cert: PeerCertificate) {
      const err = checkServerIdentity(host, cert);
      if (err) return err;
      if (pins.length === 0) return undefined;
      const chain = chainPins(cert);
      if (chain.some((p) => pins.includes(p))) return undefined;
      const e = new Error(`上游证书公钥与客户端内置的钉住集不符（${host}）`) as Error & { code?: string };
      e.code = PIN_MISMATCH_CODE;
      return e;
    },
  };
  // 代理只是 CONNECT 隧道：TLS 仍与目标服务器握手（requestTls），证书校验与钉住集照常；连代理本身按 proxyTls（http 代理不用）
  const agent = o.proxy ? new ProxyAgent({ uri: o.proxy.url, requestTls: tlsOpts, proxyTls: { rejectUnauthorized: true, ...(ca ? { ca } : {}) } }) : new Agent({ connect: tlsOpts });
  // 一律不跟随重定向（复核 B3-A01）：调用方传什么都覆盖为 error——目的地固定，重定向目标不经传输检查与钉住
  return ((input: string | URL, init?: RequestInit) => undiciFetch(input as string, { ...(init as object), redirect: "error", dispatcher: agent } as never)) as unknown as typeof fetch;
}

/** 某个上游是否经代理：未配置代理、地址缺失或回环地址（本机网关、开发桩）一律直连。 */
export function viaProxy(baseUrl: string | undefined | null, proxy: { url: string; caPem?: string } | null | undefined): { url: string; caPem?: string } | null {
  if (!proxy?.url || !baseUrl) return null;
  try {
    return isLoopbackHost(new URL(baseUrl).hostname) ? null : proxy;
  } catch {
    return null;
  }
}

/** fetch 失败的去向记录原因：钉住不符 / 证书校验失败 / 上游要求重定向（已拒绝）/ 其他（错误名）。 */
export function transportFailureReason(e: unknown, aborted: boolean): string {
  if (aborted) return "aborted";
  const seen = new Set<unknown>();
  let c: unknown = e;
  while (c && typeof c === "object" && !seen.has(c)) {
    seen.add(c);
    const code = (c as { code?: unknown }).code;
    if (code === PIN_MISMATCH_CODE) return "tls_pin_mismatch";
    if (/redirect/i.test(String((c as { message?: unknown }).message ?? ""))) return "upstream_redirect_refused";
    if (typeof code === "string" && /^(?:CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|ERR_TLS_CERT|ERR_SSL|ERR_TLS)/.test(code)) return "tls_verify_failed";
    c = (c as { cause?: unknown }).cause;
  }
  return (e as Error)?.name ?? "error";
}
