/**
 * 共享中继通道（第 11 批，v9.2 §5.1 S11 事项共享密文中继；与通知通道 notify-relay.ts 同一做法）。
 *
 * 内核不直接联网：团队事项的同步段与密文块由内核切成块后经 IPC 交给闸门，闸门发往**随客户端构建固定**的中继服务地址
 * （release.json 的 relay_base，钉住集同规则）。只有六种请求，请求都由闸门按固定形状重新拼出：
 *   ① 查缺 `POST /v1/relay/matters/<事项>/have`（只有块摘要）；
 *   ② 上传块 `PUT /v1/relay/matters/<事项>/chunks/<cid>`（≤ 4 MiB，**闸门按实际字节重算摘要**，与 cid 不符即不发）；
 *   ③ 登记段 `POST /v1/relay/matters/<事项>/segments`（段编号、段摘要与大小、块摘要、纪元、读者设备编号）；
 *   ④ 取新段 `GET /v1/relay/changes/<游标>[/wait]`；⑤ 取某事项历史 `GET /v1/relay/matters/<事项>/segments/<游标>`；
 *   ⑥ 取块 `GET /v1/relay/matters/<事项>/chunks/<cid>`（**闸门按收到的字节重算摘要**，与 cid 不符即判失败——云端不能换内容）。
 * 凭据是控制面签发的**只限中继**的短期凭据（受众 relay），由内核随请求交来，闸门核对形态与载荷里的受众后附上；
 * 不跟随跳转；响应有上限；闸门不解析、不记录块内容。
 */
import { createHash } from "node:crypto";
import { transportFailureReason, type TransportCheck } from "./tls-policy.ts";

export type ShareRelayRequest =
  | { step: "have"; credential: string; matter_id: string; cids: string[] }
  | { step: "put_chunk"; credential: string; matter_id: string; cid: string; body_b64: string }
  | {
      step: "commit";
      /** 本机知道的该事项重置代数（第四轮复核：中继据此拒收重置前的登记，非负责人不会在重置后抢先成为控制成员）。 */
      gen: number;
      /** 本机知道的中继实例编号（24 位十六进制；还不知道时为空串；第六轮复核 S11B-50）。 */
      instance: string;
      credential: string;
      matter_id: string;
      segment_id: string;
      sha256: string;
      size: number;
      chunks: string[];
      blob_chunks: string[];
      epoch: number;
      readers: string[];
    }
  | { step: "changes"; credential: string; since: number; wait: boolean }
  | { step: "history"; credential: string; matter_id: string; since: number }
  | { step: "get_chunk"; credential: string; matter_id: string; cid: string };
/** 取块时 body_b64 是块字节（已核对摘要）；其余请求 body 是响应 JSON 文本。 */
export type ShareRelayResult = { ok: true; status: number; body: string; body_b64?: string } | { ok: false; reason: string };

export const RELAY_CHUNK_MAX_BYTES = 4 * 1024 * 1024;
const RELAY_MAX_JSON_RESPONSE = 2 * 1024 * 1024;
const CREDENTIAL_RE = /^zst1\.[A-Za-z0-9_-]{20,2000}\.[A-Za-z0-9_-]{40,200}$/;
const MATTER_ID_RE = /^mat_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SEGMENT_ID_RE = /^seg_[A-Za-z0-9_-]{1,200}_[0-9a-z]{1,13}_[0-9a-f]{8}$/;
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const CID_RE = /^[0-9a-f]{64}$/;
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** 凭据载荷里须写明受众 relay（闸门不验签，只防内核误把通用席位令牌交来）。 */
function relayAudience(cred: string): boolean {
  try {
    const payload = JSON.parse(Buffer.from(cred.split(".")[1] ?? "", "base64url").toString("utf8")) as { aud?: unknown };
    return Array.isArray(payload.aud) && payload.aud.includes("relay");
  } catch {
    return false;
  }
}

const keysAre = (x: Record<string, unknown>, keys: string) => Object.keys(x).sort().join(",") === keys;
const cidList = (v: unknown, min: number, max: number) => Array.isArray(v) && v.length >= min && v.length <= max && v.every((c) => typeof c === "string" && CID_RE.test(c));
const cursorOk = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** 请求形状检查（纯函数）：返回 null = 合格。 */
export function shareRelayAllowed(r: unknown): string | null {
  const x = r as Record<string, unknown> | null;
  if (!x || typeof x !== "object") return "relay_request_invalid";
  if (typeof x.credential !== "string" || !CREDENTIAL_RE.test(x.credential)) return "relay_credential_invalid";
  if (!relayAudience(x.credential)) return "relay_credential_audience";
  const midOk = typeof x.matter_id === "string" && MATTER_ID_RE.test(x.matter_id);
  switch (x.step) {
    case "have":
      if (!keysAre(x, "cids,credential,matter_id,step")) return "relay_request_invalid";
      if (!midOk) return "relay_matter_invalid";
      return cidList(x.cids, 1, 512) ? null : "relay_cid_invalid";
    case "put_chunk": {
      if (!keysAre(x, "body_b64,cid,credential,matter_id,step")) return "relay_request_invalid";
      if (!midOk) return "relay_matter_invalid";
      if (typeof x.cid !== "string" || !CID_RE.test(x.cid)) return "relay_cid_invalid";
      if (typeof x.body_b64 !== "string" || x.body_b64.length === 0 || x.body_b64.length > Math.ceil(RELAY_CHUNK_MAX_BYTES / 3) * 4 || !B64_RE.test(x.body_b64)) return "relay_chunk_invalid";
      return null;
    }
    case "commit": {
      if (!keysAre(x, "blob_chunks,chunks,credential,epoch,gen,instance,matter_id,readers,segment_id,sha256,size,step")) return "relay_request_invalid";
      if (typeof x.gen !== "number" || !Number.isSafeInteger(x.gen) || x.gen < 0) return "relay_request_invalid";
      if (typeof x.instance !== "string" || !/^([0-9a-f]{24})?$/.test(x.instance)) return "relay_request_invalid";
      if (!midOk) return "relay_matter_invalid";
      if (typeof x.segment_id !== "string" || !SEGMENT_ID_RE.test(x.segment_id)) return "relay_segment_invalid";
      if (typeof x.sha256 !== "string" || !CID_RE.test(x.sha256)) return "relay_segment_invalid";
      if (typeof x.size !== "number" || !Number.isSafeInteger(x.size) || x.size < 1) return "relay_segment_invalid";
      if (!cidList(x.chunks, 1, 64) || !cidList(x.blob_chunks, 0, 16384)) return "relay_cid_invalid";
      if (typeof x.epoch !== "number" || !Number.isSafeInteger(x.epoch) || x.epoch < 1) return "relay_epoch_invalid";
      const rd = x.readers;
      if (!Array.isArray(rd) || rd.length < 1 || rd.length > 1000 || rd.some((d) => typeof d !== "string" || !DEVICE_ID_RE.test(d)) || new Set(rd).size !== rd.length) return "relay_readers_invalid";
      return null;
    }
    case "changes":
      if (!keysAre(x, "credential,since,step,wait")) return "relay_request_invalid";
      return cursorOk(x.since) && typeof x.wait === "boolean" ? null : "relay_cursor_invalid";
    case "history":
      if (!keysAre(x, "credential,matter_id,since,step")) return "relay_request_invalid";
      if (!midOk) return "relay_matter_invalid";
      return cursorOk(x.since) ? null : "relay_cursor_invalid";
    case "get_chunk":
      if (!keysAre(x, "cid,credential,matter_id,step")) return "relay_request_invalid";
      if (!midOk) return "relay_matter_invalid";
      return typeof x.cid === "string" && CID_RE.test(x.cid) ? null : "relay_cid_invalid";
    default:
      return "relay_request_invalid";
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

const sha256Hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export async function relayShare(
  req: ShareRelayRequest,
  o: { baseUrl: string | null; fetchImpl?: typeof fetch; timeoutMs?: number; transport?: TransportCheck },
): Promise<ShareRelayResult> {
  if (!o.baseUrl) return { ok: false, reason: "relay_not_configured" };
  if (o.transport?.state === "invalid") return { ok: false, reason: `relay_${o.transport.reason ?? "upstream_tls_required"}` };
  const bad = shareRelayAllowed(req);
  if (bad) return { ok: false, reason: bad };
  const base = o.baseUrl.replace(/\/+$/, "");
  const auth = { authorization: `Bearer ${req.credential}` };
  const json = { ...auth, "content-type": "application/json" };
  let path: string;
  let init: RequestInit;
  let limit = RELAY_MAX_JSON_RESPONSE;
  // 请求由闸门按固定字段重新拼出（内核交来的对象里任何其他内容都不会被发出）
  switch (req.step) {
    case "have":
      path = `/v1/relay/matters/${req.matter_id}/have`;
      init = { method: "POST", headers: json, body: JSON.stringify({ cids: [...req.cids] }) };
      break;
    case "put_chunk": {
      const bytes = Buffer.from(req.body_b64, "base64");
      if (bytes.length === 0 || bytes.length > RELAY_CHUNK_MAX_BYTES) return { ok: false, reason: "relay_chunk_invalid" };
      // 摘要由闸门按实际字节重算：与内核声明的块名不符即不发
      if (sha256Hex(bytes) !== req.cid) return { ok: false, reason: "relay_chunk_digest_mismatch" };
      path = `/v1/relay/matters/${req.matter_id}/chunks/${req.cid}`;
      init = { method: "PUT", headers: { ...auth, "content-type": "application/octet-stream" }, body: bytes };
      break;
    }
    case "commit":
      path = `/v1/relay/matters/${req.matter_id}/segments`;
      init = {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          segment_id: req.segment_id,
          sha256: req.sha256,
          size: req.size,
          chunks: [...req.chunks],
          blob_chunks: [...req.blob_chunks],
          epoch: req.epoch,
          readers: [...req.readers],
          gen: req.gen,
          instance: req.instance,
        }),
      };
      break;
    case "changes":
      path = `/v1/relay/changes/${req.since}${req.wait ? "/wait" : ""}`;
      init = { method: "GET", headers: auth };
      break;
    case "history":
      path = `/v1/relay/matters/${req.matter_id}/segments/${req.since}`;
      init = { method: "GET", headers: auth };
      break;
    default:
      path = `/v1/relay/matters/${req.matter_id}/chunks/${req.cid}`;
      init = { method: "GET", headers: auth };
      limit = RELAY_CHUNK_MAX_BYTES;
  }
  try {
    if (new URL(`${base}${path}`).pathname !== `${new URL(base).pathname.replace(/\/+$/, "")}${path}`) return { ok: false, reason: "relay_path_not_allowed" };
  } catch {
    return { ok: false, reason: "relay_path_not_allowed" };
  }
  const ac = new AbortController();
  // 长轮询最多 25 秒；块上下行按 4 MiB 留足时间
  const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? (req.step === "changes" && req.wait ? 45_000 : 120_000));
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
        if (size > limit) {
          await reader.cancel().catch(() => {});
          return { ok: false, reason: "relay_response_too_large" };
        }
        chunks.push(value);
      }
    }
    const body = Buffer.concat(chunks);
    if (req.step === "get_chunk" && r.status === 200) {
      // 闸门按收到的字节重算摘要：云端换了内容即判失败（内核另按段签名与密文认证再核一次）
      if (sha256Hex(body) !== req.cid) return { ok: false, reason: "relay_chunk_digest_mismatch" };
      return { ok: true, status: 200, body: "", body_b64: body.toString("base64") };
    }
    return { ok: true, status: r.status, body: body.toString("utf8") };
  } catch (e) {
    if (ac.signal.aborted) return { ok: false, reason: "relay_timeout" };
    const t = transportFailureReason(e, false);
    if (t.startsWith("tls_")) return { ok: false, reason: `relay_${t}` };
    return { ok: false, reason: connectFailed(e) ? "relay_connect_failed" : "relay_unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
