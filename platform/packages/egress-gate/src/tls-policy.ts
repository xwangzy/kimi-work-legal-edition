/**
 * 上游传输安全——闸门进程内的请求实现（undici Agent：证书校验不放宽、握手时核对钉住集）。规则说明见 tls-check.ts。
 */
import { createHash } from "node:crypto";
import { checkServerIdentity, type DetailedPeerCertificate, type PeerCertificate } from "node:tls";
import { Agent, fetch as undiciFetch } from "undici";
import { normalizePins, spkiPin } from "./tls-check.ts";

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
export function upstreamFetch(o: { pins?: readonly string[] | null; caPem?: string | null } = {}): typeof fetch {
  const pins = normalizePins(o.pins) ?? [];
  const agent = new Agent({
    connect: {
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      ...(o.caPem ? { ca: o.caPem } : {}),
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
    },
  });
  // 一律不跟随重定向（复核 B3-A01）：调用方传什么都覆盖为 error——目的地固定，重定向目标不经传输检查与钉住
  return ((input: string | URL, init?: RequestInit) => undiciFetch(input as string, { ...(init as object), redirect: "error", dispatcher: agent } as never)) as unknown as typeof fetch;
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
