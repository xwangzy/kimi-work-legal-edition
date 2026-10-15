/**
 * 内容分发通道（v9.2 §5.1 S6 法规增量包、S7 方法模板包；与控制面通道 cp-relay.ts 同一做法）。
 *
 * 内核不直接联网：法规库与方法模板的通道清单、包文件由内核经 IPC 请闸门代取，闸门发往**随客户端构建固定**的分发地址
 * （release.json 的 dist_base，钉住集与其他中软上游同规则）。只有内核持有 IPC（Agent 宿主与执行域到不了这里）；
 * 只许 GET、路径按白名单、不带内核给的任何请求头——凭据（席位令牌）由闸门自己附上；响应有上限、以 base64 交回内核。
 * 闸门不解析、不记录内容（清单与包的核验都在内核：签名、摘要、防回退）。
 */
import { transportFailureReason, type TransportCheck } from "./tls-policy.ts";

export type DistRelayResult = { ok: true; status: number; body_b64: string } | { ok: false; reason: string };

/** 与 @zr-legal/content-dist 的文件名规则、类别与通道一致。 */
const PATH_RE = /^\/dist\/(lawdb|skills)\/(stable|beta)\/(latest\.json|files\/[A-Za-z0-9][A-Za-z0-9._-]{0,119})$/;
/** 单次响应上限：经 IPC 以 base64 交回，取 64 MiB（与 content-dist MAX_PACKAGE_BYTES 一致）。 */
export const DIST_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

export function distRelayAllowed(path: unknown): string | null {
  if (typeof path !== "string" || path.length > 200 || path.includes("..") || !PATH_RE.test(path)) return "dist_path_not_allowed";
  return null;
}

export async function relayDist(
  path: string,
  o: { baseUrl: string | null; seatToken: string | null; fetchImpl?: typeof fetch; timeoutMs?: number; transport?: TransportCheck },
): Promise<DistRelayResult> {
  if (!o.baseUrl) return { ok: false, reason: "dist_not_configured" };
  if (o.transport?.state === "invalid") return { ok: false, reason: `dist_${o.transport.reason ?? "upstream_tls_required"}` };
  const bad = distRelayAllowed(path);
  if (bad) return { ok: false, reason: bad };
  if (!o.seatToken) return { ok: false, reason: "dist_seat_unavailable" };
  const base = o.baseUrl.replace(/\/+$/, "");
  try {
    if (new URL(`${base}${path}`).pathname !== `${new URL(base).pathname.replace(/\/+$/, "")}${path}`) return { ok: false, reason: "dist_path_not_allowed" };
  } catch {
    return { ok: false, reason: "dist_path_not_allowed" };
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? 120_000);
  try {
    const r = await (o.fetchImpl ?? globalThis.fetch)(`${base}${path}`, {
      method: "GET",
      headers: { authorization: `Bearer ${o.seatToken}` },
      redirect: "error",
      signal: ac.signal,
    });
    const declared = Number(r.headers.get("content-length") ?? "0");
    if (declared > DIST_MAX_RESPONSE_BYTES) {
      await r.body?.cancel().catch(() => {});
      return { ok: false, reason: "dist_response_too_large" };
    }
    const reader = r.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > DIST_MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => {});
          return { ok: false, reason: "dist_response_too_large" };
        }
        chunks.push(value);
      }
    }
    return { ok: true, status: r.status, body_b64: Buffer.concat(chunks).toString("base64") };
  } catch (e) {
    if (ac.signal.aborted) return { ok: false, reason: "dist_timeout" };
    const r = transportFailureReason(e, false);
    return { ok: false, reason: r.startsWith("tls_") ? `dist_${r}` : "dist_unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
