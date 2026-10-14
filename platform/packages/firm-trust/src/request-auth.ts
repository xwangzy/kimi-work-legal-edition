/**
 * 设备签名请求（v9 第 04 篇 §5.2“设备凭据”；第 02 篇 §7.1 #1：设备本地解锁）：设备向控制面的每个请求都用本机设备签名私钥签名，
 * 绑定方法、路径、请求体摘要、租户、设备、时刻与一次性随机数；控制面按目录中该设备的公钥核验（时刻偏差 ≤ 5 分钟、随机数不重放）。
 * 首次登记时目录里还没有该设备：用请求体里由律所根签发的证书公钥核验（持有证明）。
 */
import { createHash, randomBytes, sign, verify } from "node:crypto";
import { canonicalJson } from "@zr-legal/keys";

const REQ_DOMAIN = "kwl-device-request-v1\n";
export const REQUEST_MAX_SKEW_MS = 5 * 60 * 1000;

export type DeviceRequestHeaders = {
  "x-kwl-tenant": string;
  "x-kwl-device": string;
  "x-kwl-ts": string;
  "x-kwl-nonce": string;
  "x-kwl-sig": string;
};

export interface DeviceRequestParts {
  method: string;
  path: string;
  body: string;
}

function bytes(p: DeviceRequestParts & { tid: string; deviceId: string; ts: string; nonce: string }): Buffer {
  return Buffer.from(
    REQ_DOMAIN +
      canonicalJson({
        m: p.method.toUpperCase(),
        p: p.path,
        b: createHash("sha256").update(p.body, "utf8").digest("base64url"),
        t: p.tid,
        d: p.deviceId,
        ts: p.ts,
        n: p.nonce,
      }),
    "utf8",
  );
}

export function signDeviceRequest(p: DeviceRequestParts & { tid: string; deviceId: string; signPrivateKeyPem: string; now?: number }): DeviceRequestHeaders {
  const ts = String(p.now ?? Date.now());
  const nonce = randomBytes(16).toString("base64url");
  const sig = sign(null, bytes({ ...p, ts, nonce }), p.signPrivateKeyPem).toString("base64url");
  return { "x-kwl-tenant": p.tid, "x-kwl-device": p.deviceId, "x-kwl-ts": ts, "x-kwl-nonce": nonce, "x-kwl-sig": sig };
}

export type DeviceRequestVerdict = { ok: true; tid: string; deviceId: string } | { ok: false; reason: string };

export function verifyDeviceRequest(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  req: DeviceRequestParts,
  o: {
    /** 目录中该设备（未吊销）的签名公钥；首次登记时由调用方给出证书公钥。 */
    publicKeyFor: (tid: string, deviceId: string) => string | null;
    now?: number;
    /** 随机数是否已用过（用过返回 true；未用过则记下并返回 false）。 */
    seenNonce: (key: string) => boolean;
  },
): DeviceRequestVerdict {
  const h = (k: keyof DeviceRequestHeaders): string | null => {
    const v = headers[k];
    return typeof v === "string" && v.length > 0 && v.length < 512 ? v : null;
  };
  const tid = h("x-kwl-tenant");
  const deviceId = h("x-kwl-device");
  const ts = h("x-kwl-ts");
  const nonce = h("x-kwl-nonce");
  const sig = h("x-kwl-sig");
  if (!tid || !deviceId || !ts || !nonce || !sig) return { ok: false, reason: "device_auth_missing" };
  const t = Number(ts);
  const now = o.now ?? Date.now();
  if (!Number.isFinite(t) || Math.abs(now - t) > REQUEST_MAX_SKEW_MS) return { ok: false, reason: "device_auth_stale" };
  const pub = o.publicKeyFor(tid, deviceId);
  if (!pub) return { ok: false, reason: "device_unknown_or_revoked" };
  let good = false;
  try {
    good = verify(null, bytes({ ...req, tid, deviceId, ts, nonce }), pub, Buffer.from(sig, "base64url"));
  } catch {
    good = false;
  }
  if (!good) return { ok: false, reason: "device_auth_signature_invalid" };
  if (o.seenNonce(`${tid}\u0000${deviceId}\u0000${nonce}`)) return { ok: false, reason: "device_auth_replayed" };
  return { ok: true, tid, deviceId };
}

/** 开通证明的待签字节（G0：创始设备用律所根私钥签名，证明登记的根公钥确由开通方持有；生产为开通流程）。 */
export function enrollProofBytes(tid: string, rootPublicKeyPem: string, ts: number): Buffer {
  return Buffer.from(`kwl-enroll-v1\n${canonicalJson({ tid, root_public_key_pem: rootPublicKeyPem, ts })}`, "utf8");
}
