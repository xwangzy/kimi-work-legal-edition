/**
 * 通知通道（第 10 批，v9 #51 期限提醒、v9.2 §5.1 S9；与支持通道 support-relay.ts 同一做法）。
 *
 * 内核不直接联网：提醒的登记、撤销、取到时提醒与确认收到经 IPC 交给闸门，闸门发往**随客户端构建固定**的通知服务地址
 * （release.json 的 notify_base，钉住集同规则）。只有四种请求，请求体都由闸门按固定形状重新拼出：
 *   ① 登记 `PUT /v1/reminders/<编号>`：只有触发时刻（到分钟）、版本号、接收设备编号与每台设备一份不透明密文——
 *      云端不收任何明文字段（期限类型、事项、文案都在密文里，由内核按接收设备公钥加密）；
 *   ② 撤销 `DELETE /v1/reminders/<编号>`；③ 取到时提醒 `GET /v1/notify/due`；④ 确认收到 `POST /v1/notify/ack`。
 * 凭据是控制面签发的**只限通知服务**的短期凭据（受众 notify），由内核随请求交来，闸门核对形态与载荷里的受众后附上；
 * 不跟随跳转；响应 ≤ 1 MiB；闸门不解析、不记录密文。
 */
import { transportFailureReason, type TransportCheck } from "./tls-policy.ts";

export interface NotifyTarget {
  dev: string;
  ct: string;
}
export type NotifyRelayRequest =
  | { step: "put"; credential: string; reminder_id: string; fire_at: string; version: number; targets: NotifyTarget[] }
  | { step: "delete"; credential: string; reminder_id: string }
  | { step: "due"; credential: string }
  | { step: "ack"; credential: string; items: { id: string; version: number }[] };
export type NotifyRelayResult = { ok: true; status: number; body: string } | { ok: false; reason: string };

const NOTIFY_MAX_RESPONSE_BYTES = 1024 * 1024;
const CREDENTIAL_RE = /^zst1\.[A-Za-z0-9_-]{20,2000}\.[A-Za-z0-9_-]{40,200}$/;
const REMINDER_ID_RE = /^rmd_[0-9a-f]{24}$/;
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const FIRE_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/;
const CT_RE = /^[A-Za-z0-9_-]{40,8192}$/;
const MAX_TARGETS = 50;
const MAX_ACK = 50;

/** 凭据载荷里须写明受众 notify（闸门不验签，只防内核误把通用席位令牌交来）。 */
function notifyAudience(cred: string): boolean {
  try {
    const payload = JSON.parse(Buffer.from(cred.split(".")[1] ?? "", "base64url").toString("utf8")) as { aud?: unknown };
    return Array.isArray(payload.aud) && payload.aud.includes("notify");
  } catch {
    return false;
  }
}

const keysAre = (x: Record<string, unknown>, keys: string) => Object.keys(x).sort().join(",") === keys;

/** 请求形状检查（纯函数）：返回 null = 合格。 */
export function notifyRelayAllowed(r: unknown): string | null {
  const x = r as Record<string, unknown> | null;
  if (!x || typeof x !== "object") return "notify_request_invalid";
  if (typeof x.credential !== "string" || !CREDENTIAL_RE.test(x.credential)) return "notify_credential_invalid";
  if (!notifyAudience(x.credential)) return "notify_credential_audience";
  switch (x.step) {
    case "due":
      return keysAre(x, "credential,step") ? null : "notify_request_invalid";
    case "delete":
      if (!keysAre(x, "credential,reminder_id,step")) return "notify_request_invalid";
      return typeof x.reminder_id === "string" && REMINDER_ID_RE.test(x.reminder_id) ? null : "notify_reminder_invalid";
    case "put": {
      if (!keysAre(x, "credential,fire_at,reminder_id,step,targets,version")) return "notify_request_invalid";
      if (typeof x.reminder_id !== "string" || !REMINDER_ID_RE.test(x.reminder_id)) return "notify_reminder_invalid";
      if (typeof x.fire_at !== "string" || !FIRE_AT_RE.test(x.fire_at) || Number.isNaN(Date.parse(x.fire_at))) return "notify_fire_at_invalid";
      if (typeof x.version !== "number" || !Number.isSafeInteger(x.version) || x.version < 1) return "notify_version_invalid";
      if (!Array.isArray(x.targets) || x.targets.length < 1 || x.targets.length > MAX_TARGETS) return "notify_targets_invalid";
      const seen = new Set<string>();
      for (const t of x.targets as unknown[]) {
        const y = t as Record<string, unknown> | null;
        if (!y || typeof y !== "object" || !keysAre(y, "ct,dev")) return "notify_targets_invalid";
        if (typeof y.dev !== "string" || !DEVICE_ID_RE.test(y.dev) || seen.has(y.dev)) return "notify_targets_invalid";
        if (typeof y.ct !== "string" || !CT_RE.test(y.ct)) return "notify_ciphertext_invalid";
        seen.add(y.dev);
      }
      return null;
    }
    case "ack": {
      if (!keysAre(x, "credential,items,step")) return "notify_request_invalid";
      if (!Array.isArray(x.items) || x.items.length < 1 || x.items.length > MAX_ACK) return "notify_items_invalid";
      for (const it of x.items as unknown[]) {
        const y = it as Record<string, unknown> | null;
        if (!y || typeof y !== "object" || !keysAre(y, "id,version")) return "notify_items_invalid";
        if (typeof y.id !== "string" || !REMINDER_ID_RE.test(y.id) || typeof y.version !== "number" || !Number.isSafeInteger(y.version) || y.version < 1) return "notify_items_invalid";
      }
      return null;
    }
    default:
      return "notify_request_invalid";
  }
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

export async function relayNotify(
  req: NotifyRelayRequest,
  o: { baseUrl: string | null; fetchImpl?: typeof fetch; timeoutMs?: number; transport?: TransportCheck },
): Promise<NotifyRelayResult> {
  if (!o.baseUrl) return { ok: false, reason: "notify_not_configured" };
  if (o.transport?.state === "invalid") return { ok: false, reason: `notify_${o.transport.reason ?? "upstream_tls_required"}` };
  const bad = notifyRelayAllowed(req);
  if (bad) return { ok: false, reason: bad };
  const base = o.baseUrl.replace(/\/+$/, "");
  const auth = { authorization: `Bearer ${req.credential}` };
  let path: string;
  let init: RequestInit;
  // 请求体由闸门按固定字段重新拼出（内核交来的对象里任何其他内容都不会被发出）
  if (req.step === "put") {
    path = `/v1/reminders/${req.reminder_id}`;
    const body = JSON.stringify({ fire_at: req.fire_at, version: req.version, targets: req.targets.map((t) => ({ dev: t.dev, ct: t.ct })) });
    init = { method: "PUT", headers: { ...auth, "content-type": "application/json" }, body };
  } else if (req.step === "delete") {
    path = `/v1/reminders/${req.reminder_id}`;
    init = { method: "DELETE", headers: auth };
  } else if (req.step === "due") {
    path = "/v1/notify/due";
    init = { method: "GET", headers: auth };
  } else {
    path = "/v1/notify/ack";
    init = { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ items: req.items.map((i) => ({ id: i.id, version: i.version })) }) };
  }
  try {
    if (new URL(`${base}${path}`).pathname !== `${new URL(base).pathname.replace(/\/+$/, "")}${path}`) return { ok: false, reason: "notify_path_not_allowed" };
  } catch {
    return { ok: false, reason: "notify_path_not_allowed" };
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? 30_000);
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
        if (size > NOTIFY_MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => {});
          return { ok: false, reason: "notify_response_too_large" };
        }
        chunks.push(value);
      }
    }
    return { ok: true, status: r.status, body: Buffer.concat(chunks).toString("utf8") };
  } catch (e) {
    if (ac.signal.aborted) return { ok: false, reason: "notify_timeout" };
    const t = transportFailureReason(e, false);
    if (t.startsWith("tls_")) return { ok: false, reason: `notify_${t}` };
    return { ok: false, reason: connectFailed(e) ? "notify_connect_failed" : "notify_unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
