/**
 * 控制面签名服务 cp-signer（v9.3 A-8；云端持久化与 KMS 设计 v1 §4）。
 *
 * 控制面（cp-api）不再持有签名私钥：信封与席位令牌都向本服务申请。本服务：
 * - **只接受结构，不接受字节**：信封给种类 + 文档、席位令牌给租户/成员/席位/设备/受众/有效期；签名字节由同一个包里的
 *   `sealEnvelope` / `issueSeatToken` 生成（与进程内签名逐字节相同），调用方给不出任意字节、也拿不到把席位令牌当信封的签名；
 * - **按种类核对**（只核格式与时限，不判断宽严——宽严由律所侧的锚点把关）：未登记的种类、时刻偏差超过 5 秒、有效期超限、
 *   字段不合规一律拒签；
 * - **mTLS 调用方核对**：只认登记的客户端证书身份（生产入口 `allowed_callers`）；
 * - **签名账**（ledger.ts）：每次签名与拒签各记一行（不写文档内容），哈希链；**记不进去就不签**；
 * - 只提供公钥，不提供任何其他密钥操作；不连数据库、不出公网（部署约束见 docs/部署-云端生产入口.md）。
 *
 * 能防与不能防（如实，同设计 §4.3）：能防私钥从 API 进程被窃取、任意字节签名、超长有效期、无账签名；
 * 不能防已攻陷的 cp-api 申请签“格式合法”的许可或吊销通知——仍靠“控制面签名只够收紧”+ 签名速率指标 + 签名账与控制面审计对账。
 */
import { createHash, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { TLSSocket } from "node:tls";
import {
  openEnvelope,
  sealEnvelope,
  validateConnectorDoc,
  validateLicense,
  validatePolicyDoc,
} from "@zr-legal/firm-trust";
import { issueSeatToken, verifySeatToken } from "@zr-legal/seat-token";
import { DEVICE_ID_PATTERN } from "@zr-legal/keys";
import {
  ENVELOPE_KINDS,
  SEAT_AUDIENCES,
  SEAT_TTL_BOUNDS,
  seatKeyFor,
  signerPublicKeys,
  type ControlPlaneKeys,
  type EnvelopeKind,
  type SeatAudience,
} from "../../control-plane/src/signer.ts";
import { openSignerLedger, type SignerLedger } from "./ledger.ts";

export { openSignerLedger, verifySignerLedger, type SignerLedger, type SignerLedgerRecord } from "./ledger.ts";

export interface SignerServiceOptions {
  keys: ControlPlaneKeys;
  /** 签名账文件（生产在数据目录；外送 WORM 随 A-11）。 */
  ledgerFile?: string;
  ledger?: SignerLedger;
  /** 允许的调用方身份（mTLS 客户端证书的 URI SAN，如 spiffe://kwl/prod/cp-api；或 CN）。 */
  allowedCallers: string[];
  /** 只许测试：明文 HTTP、调用方记为 insecure-test（生产入口只许回环地址）。 */
  insecureForTest?: boolean;
  now?: () => number;
  /** 请求时刻与本服务时钟的最大偏差（缺省 5 秒）。 */
  maxSkewMs?: number;
  maxBodyBytes?: number;
}

export interface SignerMetrics {
  /** 按“操作/种类/结果”计数（指标监听导出；签名速率异常由告警规则对照 7 日基线）。 */
  counts: Record<string, number>;
  last_ok_at: string | null;
}

export interface SignerService {
  server: Server;
  metrics(): SignerMetrics;
  publicKeys: ReturnType<typeof signerPublicKeys>;
  close(): void;
}

class Reject extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const DAY_MS = 24 * 3600 * 1000;
const TID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const sha = (x: string | Buffer) => createHash("sha256").update(x).digest("hex");
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const isInt = (x: unknown) => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
const t = (x: unknown) => (typeof x === "string" ? Date.parse(x) : NaN);

/**
 * 按种类核对文档（只核格式与时限）。返回拒签原因或 null。
 * near：签发时刻与请求时刻相差不超过偏差上限（终止许可的签发时刻比请求时刻早 1 毫秒，也在范围内）。
 */
export function checkEnvelopeBody(kind: EnvelopeKind, body: unknown, reqNow: number, skewMs = 5_000): string | null {
  const near = (iso: unknown) => Number.isFinite(t(iso)) && Math.abs(t(iso) - reqNow) <= skewMs;
  const tidOk = (b: Record<string, unknown>) => typeof b.tid === "string" && TID_RE.test(b.tid);
  switch (kind) {
    case "kwl-license": {
      if (!isObj(body) || !tidOk(body)) return "license_malformed";
      const v = validateLicense(body, String(body.tid));
      if (!v.ok) return v.reason;
      return near(body.issued_at) ? null : "issued_at_not_now";
    }
    case "kwl-device-directory": {
      if (!isObj(body) || !tidOk(body) || !isInt(body.version)) return "directory_malformed";
      if (!near(body.issued_at)) return "issued_at_not_now";
      const ttl = t(body.expires_at) - t(body.issued_at);
      if (!(ttl > 0 && ttl <= 30 * DAY_MS)) return "directory_ttl_invalid";
      if (!Array.isArray(body.devices) || !body.devices.every((d) => isObj(d) && typeof d.deviceId === "string" && DEVICE_ID_PATTERN.test(d.deviceId))) return "directory_devices_invalid";
      if (!Array.isArray(body.revoked_devices) || !body.revoked_devices.every((d) => isObj(d) && typeof d.device_id === "string" && Number.isFinite(t(d.revoked_at)))) return "directory_revoked_invalid";
      if (!Array.isArray(body.revoked_seats) || !body.revoked_seats.every((x) => typeof x === "string")) return "directory_revoked_invalid";
      return null;
    }
    case "kwl-tenant-salt": {
      if (!isObj(body) || !tidOk(body) || body.purpose !== "anon_matter" || typeof body.salt_b64 !== "string") return "salt_malformed";
      if (Buffer.from(body.salt_b64, "base64").length < 16) return "salt_too_short";
      return Number.isFinite(t(body.issued_at)) ? null : "salt_malformed";
    }
    case "kwl-firm-policy-current": {
      if (body === null) return null;
      if (!isObj(body) || !Array.isArray(body.admin_signatures) || body.admin_signatures.length > 16) return "policy_malformed";
      const v = validatePolicyDoc(body.doc);
      return v.ok ? null : "policy_doc_invalid";
    }
    case "kwl-firm-connectors": {
      if (!isObj(body) || !tidOk(body) || !isInt(body.version) || !near(body.issued_at) || !Array.isArray(body.entries)) return "connectors_malformed";
      for (const e of body.entries) if (!isObj(e) || !Array.isArray(e.admin_signatures) || !validateConnectorDoc(e.doc).ok) return "connector_doc_invalid";
      return null;
    }
    case "kwl-gateway-feed": {
      if (!isObj(body) || !isInt(body.version) || !near(body.issued_at)) return "feed_malformed";
      for (const k of ["revoked_devices", "revoked_seats", "matters", "policies"]) if (!Array.isArray(body[k])) return "feed_malformed";
      return null;
    }
    case "kwl-device-revoked": {
      if (!isObj(body) || !tidOk(body) || typeof body.device_id !== "string" || !DEVICE_ID_PATTERN.test(body.device_id) || !Number.isFinite(t(body.revoked_at))) return "revoked_malformed";
      return null;
    }
    case "kwl-quota-view": {
      if (!isObj(body) || !tidOk(body) || !near(body.issued_at)) return "quota_view_malformed";
      return null;
    }
    case "kwl-cp-audit-page": {
      if (!isObj(body) || !tidOk(body) || !near(body.issued_at) || !Array.isArray(body.records) || body.records.length > 500 || !isObj(body.head)) return "audit_page_malformed";
      return null;
    }
  }
}

/** 调用方身份：mTLS 客户端证书（已由 TLS 层按签发 CA 核验）的 URI SAN，没有则 CN。 */
function callerOf(req: IncomingMessage, insecure: boolean): string | null {
  const sock = req.socket as Partial<TLSSocket>;
  if (typeof sock.getPeerCertificate !== "function") return insecure ? "insecure-test" : null;
  if (!sock.authorized) return null;
  const cert = sock.getPeerCertificate();
  if (!cert || !Object.keys(cert).length) return null;
  const uri = /(?:^|,\s*)URI:([^,\s]+)/.exec(String(cert.subjectaltname ?? ""))?.[1];
  const cn = cert.subject && typeof cert.subject.CN === "string" ? cert.subject.CN : null;
  return uri ?? cn;
}

export function createSignerService(o: SignerServiceOptions): SignerService {
  const now = o.now ?? Date.now;
  const skew = o.maxSkewMs ?? 5_000;
  const maxBody = o.maxBodyBytes ?? 8 * 1024 * 1024;
  if (!o.allowedCallers.length && !o.insecureForTest) throw new Error("签名服务须登记允许的调用方（allowed_callers）");
  for (const k of [o.keys.envelope, o.keys.seat, ...Object.values(o.keys.seatAudiences ?? {})]) {
    if (!k || k.privateKey.asymmetricKeyType !== "ed25519") throw new Error("签名私钥须为 Ed25519");
  }
  const publicKeys = signerPublicKeys(o.keys);
  // 启动自检：用公钥验一次自己签的信封与每把席位密钥签的令牌（任一不过即不启动）
  {
    const at = now();
    const env = sealEnvelope("kwl-signer-selftest", { at }, o.keys.envelope);
    const envKeys = new Map<string, KeyObject>([[o.keys.envelope.kid, o.keys.envelope.publicKey]]);
    if (!openEnvelope(env, "kwl-signer-selftest", envKeys).ok) throw new Error("签名自检不通过（信封密钥）");
    for (const aud of [undefined, ...SEAT_AUDIENCES] as (SeatAudience | undefined)[]) {
      const k = seatKeyFor(o.keys, aud);
      const tok = issueSeatToken({ tid: "selftest", uid: "u", sid: "s", dev: "d", kid: k.kid, ...(aud ? { aud: [aud] } : {}) }, k.privateKey, 120, at);
      verifySeatToken(tok, new Map([[k.kid, k.publicKey]]), { now: at, ...(aud ? { audience: aud } : {}) });
    }
  }
  const ledger = o.ledger ?? (o.ledgerFile ? openSignerLedger(o.ledgerFile) : null);
  if (!ledger) throw new Error("签名服务须有签名账（ledgerFile）");
  const counts: Record<string, number> = {};
  let lastOkAt: string | null = null;
  const count = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);

  const readBody = (req: IncomingMessage): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let n = 0;
      req.on("data", (c: Buffer) => {
        n += c.length;
        if (n > maxBody) {
          reject(new Reject(413, "body_too_large"));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", () => reject(new Reject(400, "body_broken")));
    });

  const reply = (res: ServerResponse, status: number, body: unknown) => {
    const s = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(s), "cache-control": "no-store" });
    res.end(s);
  };

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const caller = callerOf(req, !!o.insecureForTest);
    if (!caller || (!o.insecureForTest && !o.allowedCallers.includes(caller))) {
      count("caller/rejected");
      // 未通过调用方核对的请求不进签名账（不能用来撑大账本）；只计数
      return reply(res, 403, { error: "caller_not_allowed" });
    }
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && path === "/v1/public-keys") return reply(res, 200, publicKeys);
    if (req.method !== "POST" || (path !== "/v1/sign/envelope" && path !== "/v1/sign/seat-token")) return reply(res, 404, { error: "not_found" });
    const op = path === "/v1/sign/envelope" ? "envelope" : "seat_token";
    let b: Record<string, unknown>;
    const raw = await readBody(req);
    try {
      const j = JSON.parse(raw.toString("utf8")) as unknown;
      if (!isObj(j)) throw new Error();
      b = j;
    } catch {
      throw new Reject(400, "body_malformed");
    }
    const at = now();
    const requestId = typeof b.request_id === "string" && REQUEST_ID.test(b.request_id) ? b.request_id : null;
    const tid = typeof b.tid === "string" && TID_RE.test(b.tid) ? b.tid : isObj(b.body) && typeof b.body.tid === "string" && TID_RE.test(b.body.tid) ? b.body.tid : null;
    const kind = op === "envelope" ? (typeof b.kind === "string" && b.kind.length <= 64 ? b.kind : null) : null;
    const bodySha = op === "envelope" ? sha(JSON.stringify(b.body ?? null)) : null;
    const reject = (status: number, reason: string, kid: string | null = null): never => {
      count(`${op}/${kind ?? (typeof b.aud === "string" ? b.aud : "general")}/rejected`);
      // 拒签也记账：记不进去照样拒（本来就不签）
      try {
        ledger.append({ request_id: requestId ?? "-", caller, op, kind, kid, tid, body_sha256: bodySha, signed_sha256: null, result: "rejected", reason }, new Date(at).toISOString());
      } catch {
        // 账本不可写：拒签本身不受影响；下一次签名会因写不进而拒绝
      }
      throw new Reject(status, reason);
    };
    if (!requestId) reject(400, "request_id_invalid");
    const reqNow = typeof b.req_now === "number" && Number.isFinite(b.req_now) ? b.req_now : NaN;
    if (!(Math.abs(reqNow - at) <= skew)) reject(400, "req_now_skew");

    let out: unknown;
    let signed: string;
    let kid: string;
    if (op === "envelope") {
      if (!kind || !(ENVELOPE_KINDS as readonly string[]).includes(kind)) reject(400, "kind_not_allowed");
      // 只认这四个字段：带了“字节”“签名输入”之类别的字段即拒（调用方不能塞原始字节）
      if (Object.keys(b).some((k) => !["request_id", "req_now", "kind", "body"].includes(k))) reject(400, "field_not_allowed");
      const why = checkEnvelopeBody(kind as EnvelopeKind, b.body, reqNow, skew);
      if (why) reject(400, why);
      const env = sealEnvelope(kind!, b.body ?? null, o.keys.envelope);
      kid = env.kid;
      signed = env.sig;
      out = { envelope: { kind: env.kind, kid: env.kid, sig: env.sig } };
    } else {
      if (Object.keys(b).some((k) => !["request_id", "req_now", "tid", "uid", "sid", "dev", "aud", "ttl_s"].includes(k))) reject(400, "field_not_allowed");
      const aud = b.aud === undefined ? undefined : (SEAT_AUDIENCES as readonly unknown[]).includes(b.aud) ? (b.aud as SeatAudience) : reject(400, "audience_not_allowed");
      if (!tid || typeof b.uid !== "string" || !SAFE_ID.test(b.uid) || typeof b.sid !== "string" || !SAFE_ID.test(b.sid) || typeof b.dev !== "string" || !DEVICE_ID_PATTERN.test(b.dev)) reject(400, "seat_fields_invalid");
      const [lo, hi] = SEAT_TTL_BOUNDS[aud ?? "general"];
      if (!(isInt(b.ttl_s) && (b.ttl_s as number) >= lo && (b.ttl_s as number) <= hi)) reject(400, "ttl_out_of_range");
      const k = seatKeyFor(o.keys, aud);
      kid = k.kid;
      signed = issueSeatToken({ tid: tid!, uid: b.uid as string, sid: b.sid as string, dev: b.dev as string, kid: k.kid, ...(aud ? { aud: [aud] } : {}) }, k.privateKey, b.ttl_s as number, reqNow);
      out = { token: signed };
    }
    // 先记账、后交付：记不进去就不签（失败关闭）
    try {
      ledger.append({ request_id: requestId!, caller, op, kind, kid, tid, body_sha256: bodySha, signed_sha256: sha(signed), result: "ok", reason: null }, new Date(at).toISOString());
    } catch {
      count(`${op}/ledger_unavailable`);
      throw new Reject(503, "ledger_unavailable");
    }
    count(`${op}/${kind ?? (op === "seat_token" ? ((b.aud as string | undefined) ?? "general") : "-")}/ok`);
    lastOkAt = new Date(at).toISOString();
    return reply(res, 200, out);
  };

  const server = createServer((req, res) => {
    route(req, res).catch((e: unknown) => {
      const r = e instanceof Reject ? e : new Reject(500, "signer_error");
      if (res.headersSent) res.destroy();
      else reply(res, r.status, { error: r.code });
    });
  });
  server.on("close", () => {
    try {
      ledger.close();
    } catch {
      // 已关闭
    }
  });
  return {
    server,
    publicKeys,
    metrics: () => ({ counts: { ...counts }, last_ok_at: lastOkAt }),
    close: () => server.close(),
  };
}
