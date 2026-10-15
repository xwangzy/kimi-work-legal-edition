/**
 * 支持通道（第 9 批，v9.2 §5.1 S13 诊断包上传；与控制面通道 cp-relay.ts、分发通道 dist-relay.ts 同一做法）。
 *
 * 内核不直接联网：律师确认上传的脱敏诊断包由内核经 IPC 交给闸门，闸门发往**随客户端构建固定**的支持服务地址
 * （release.json 的 support_base，钉住集同规则）。只有两种请求、都由闸门按固定形状拼出：
 *   ① 申请工单 `POST /v1/support/tickets`（无请求体）；② 上传 `PUT /v1/support/packages/<工单号>`（请求体 ≤ 2 MiB，
 *   附单次上传令牌与内容摘要，摘要由闸门按实际字节重算、与内核声明不符即不发）。
 * 凭据是控制面签发的**只限支持服务**的短期凭据（受众 support、15 分钟；复核 S9B-03），由内核随请求交来，闸门核对形态与载荷里的受众后附上——
 * 通用席位令牌不发给支持服务；不跟随跳转；响应 ≤ 64 KiB；闸门不解析、不记录诊断包内容。
 */
import { createHash } from "node:crypto";
import { transportFailureReason, type TransportCheck } from "./tls-policy.ts";

export type SupportRelayRequest =
  | { step: "ticket"; credential: string }
  | { step: "upload"; credential: string; ticket: string; upload_token: string; content_sha256: string; body_b64: string };
export type SupportRelayResult = { ok: true; status: number; body: string } | { ok: false; reason: string };

export const SUPPORT_MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const SUPPORT_MAX_RESPONSE_BYTES = 64 * 1024;
const TICKET_RE = /^SUP-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
const CREDENTIAL_RE = /^zst1\.[A-Za-z0-9_-]{20,2000}\.[A-Za-z0-9_-]{40,200}$/;

/**
 * 凭据载荷里须写明受众 support（复核 S9B-19：闸门不验签，只防内核误把通用席位令牌交来——通用令牌不发往支持域）。
 */
function supportAudience(cred: string): boolean {
  try {
    const payload = JSON.parse(Buffer.from(cred.split(".")[1] ?? "", "base64url").toString("utf8")) as { aud?: unknown };
    return Array.isArray(payload.aud) && payload.aud.includes("support");
  } catch {
    return false;
  }
}

/** 请求形状检查（纯函数）：返回 null = 合格。 */
export function supportRelayAllowed(r: unknown): string | null {
  const x = r as Record<string, unknown> | null;
  if (!x || typeof x !== "object") return "support_request_invalid";
  if (x.step === "ticket") {
    if (Object.keys(x).sort().join(",") !== "credential,step") return "support_request_invalid";
    if (typeof x.credential !== "string" || !CREDENTIAL_RE.test(x.credential)) return "support_credential_invalid";
    return supportAudience(x.credential) ? null : "support_credential_audience";
  }
  if (x.step !== "upload") return "support_request_invalid";
  if (Object.keys(x).sort().join(",") !== "body_b64,content_sha256,credential,step,ticket,upload_token") return "support_request_invalid";
  if (typeof x.credential !== "string" || !CREDENTIAL_RE.test(x.credential)) return "support_credential_invalid";
  if (!supportAudience(x.credential)) return "support_credential_audience";
  if (typeof x.ticket !== "string" || !TICKET_RE.test(x.ticket)) return "support_ticket_invalid";
  if (typeof x.upload_token !== "string" || !/^[A-Za-z0-9_-]{20,100}$/.test(x.upload_token)) return "support_token_invalid";
  if (typeof x.content_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(x.content_sha256)) return "support_digest_invalid";
  if (typeof x.body_b64 !== "string" || x.body_b64.length > Math.ceil((SUPPORT_MAX_UPLOAD_BYTES * 4) / 3) + 4) return "support_body_too_large";
  return null;
}

function connectFailed(e: unknown): boolean {
  const seen = new Set<unknown>();
  for (let c: unknown = e; c && typeof c === "object" && !seen.has(c); c = (c as { cause?: unknown }).cause) {
    seen.add(c);
    const code = (c as { code?: unknown }).code;
    if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EHOSTUNREACH" || code === "ENETUNREACH") return true;
  }
  return false;
}

export async function relaySupport(
  req: SupportRelayRequest,
  o: { baseUrl: string | null; fetchImpl?: typeof fetch; timeoutMs?: number; transport?: TransportCheck },
): Promise<SupportRelayResult> {
  if (!o.baseUrl) return { ok: false, reason: "support_not_configured" };
  if (o.transport?.state === "invalid") return { ok: false, reason: `support_${o.transport.reason ?? "upstream_tls_required"}` };
  const bad = supportRelayAllowed(req);
  if (bad) return { ok: false, reason: bad };
  const base = o.baseUrl.replace(/\/+$/, "");
  let path: string;
  let init: RequestInit;
  if (req.step === "ticket") {
    path = "/v1/support/tickets";
    init = { method: "POST", headers: { authorization: `Bearer ${req.credential}` } };
  } else {
    const body = Buffer.from(req.body_b64, "base64");
    // 规范 base64 + 字节摘要由闸门重算：与内核声明不一致即不发（防止 IPC 上被夹带别的字节）
    if (body.toString("base64") !== req.body_b64) return { ok: false, reason: "support_body_invalid" };
    if (body.byteLength > SUPPORT_MAX_UPLOAD_BYTES) return { ok: false, reason: "support_body_too_large" };
    if (createHash("sha256").update(body).digest("hex") !== req.content_sha256) return { ok: false, reason: "support_digest_mismatch" };
    path = `/v1/support/packages/${req.ticket}`;
    init = { method: "PUT", headers: { authorization: `Bearer ${req.credential}`, "x-kwl-upload-token": req.upload_token, "x-kwl-content-sha256": req.content_sha256, "content-type": "application/json" }, body };
  }
  try {
    if (new URL(`${base}${path}`).pathname !== `${new URL(base).pathname.replace(/\/+$/, "")}${path}`) return { ok: false, reason: "support_path_not_allowed" };
  } catch {
    return { ok: false, reason: "support_path_not_allowed" };
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? 60_000);
  try {
    const r = await (o.fetchImpl ?? globalThis.fetch)(`${base}${path}`, { ...init, redirect: "error", signal: ac.signal });
    const reader = r.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > SUPPORT_MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => {});
          return { ok: false, reason: "support_response_too_large" };
        }
        chunks.push(value);
      }
    }
    return { ok: true, status: r.status, body: Buffer.concat(chunks).toString("utf8") };
  } catch (e) {
    if (ac.signal.aborted) return { ok: false, reason: "support_timeout" };
    const t = transportFailureReason(e, false);
    if (t.startsWith("tls_")) return { ok: false, reason: `support_${t}` };
    // 连接都没建立（域名解析失败、连接被拒）= 确定没有送出（复核 S9B-22：不报“结果不明”）
    return { ok: false, reason: connectFailed(e) ? "support_connect_failed" : "support_unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
