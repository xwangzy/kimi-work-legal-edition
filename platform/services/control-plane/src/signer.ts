/**
 * 控制面签名者（v9.3 A-8；云端持久化与 KMS 设计 v1 §4）：控制面不再直接持有签名私钥，一律经签名者签信封与席位令牌。
 *
 * - `localSigner(keys)`：进程内（开发、测试、单机试点）；包装原有的 `sealEnvelope` / `issueSeatToken`，字节完全不变；
 * - `connectRemoteSigner(o)`：独立签名服务 `cp-signer`（services/cp-signer）的 mTLS 客户端——只提交结构（种类 + 文档、席位字段），
 *   签名服务按种类核对后签名并记签名账；生产入口的控制面只能用它（私钥不在 API 进程）。
 *
 * 席位密钥按受众拆分（A-8）：网关、检索、分发认的通用席位令牌，与支持、通知、中继各自的短期凭据由不同的密钥签——
 * 一把受众密钥泄露或轮换不牵连其他服务；各服务的公钥表只放自己受众的公钥。没有给受众密钥时回落到通用席位密钥（开发与测试）。
 */
import { createPublicKey, randomUUID, type KeyObject } from "node:crypto";
import { request as httpsRequest, Agent } from "node:https";
import { request as httpRequest } from "node:http";
import { openEnvelope, publicKeyMap, sealEnvelope, type CpEnvelope } from "@zr-legal/firm-trust";
import { issueSeatToken, verifySeatToken } from "@zr-legal/seat-token";
import { DEVICE_ID_PATTERN, issueDeviceCertificate, verifyDeviceCertificate, type DeviceCertificate, type DeviceCertificateInput } from "@zr-legal/keys";

export interface CpKeyPair {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

/** 席位令牌的受众（没有受众 = 通用席位令牌：网关、检索、分发）。 */
export const SEAT_AUDIENCES = ["support", "notify", "relay"] as const;
export type SeatAudience = (typeof SEAT_AUDIENCES)[number];

export interface ControlPlaneKeys {
  envelope: CpKeyPair;
  seat: CpKeyPair;
  /** 按受众拆分的席位密钥（A-8）；缺的受众用通用席位密钥。 */
  seatAudiences?: Partial<Record<SeatAudience, CpKeyPair>>;
  /**
   * 第 66 批（V40，D-292）：账号设备签发钥——只给个人租户（1 名成员且为管理员）的新电脑签设备证书（issuer = account_ca），
   * 与信封钥、席位钥分开（kid 经 /v1/meta 公布）。没有配置 = 个人账号新电脑仍走“另一台电脑批准”。
   */
  accountDeviceCa?: CpKeyPair;
}

/** 控制面签的全部信封种类（签名服务只签这些；新增种类须同时在签名服务登记按种类的核对）。 */
export const ENVELOPE_KINDS = [
  "kwl-license",
  "kwl-device-directory",
  "kwl-tenant-salt",
  "kwl-firm-policy-current",
  "kwl-firm-connectors",
  "kwl-gateway-feed",
  "kwl-device-revoked",
  "kwl-quota-view",
  "kwl-cp-audit-page",
  // 第 44 批：API 路由订阅（网关取上游、别名、价目；上游密钥是只有网关解得开的密文）
  "kwl-routing-feed",
  // 第 66 批：客户端模型目录（别名与可用性；不含上游型号、地址与密钥）
  "kwl-model-catalog",
  // 第 66 批（V40）：个人用量明细翻页；个人账号新电脑自动登记的应答（证书 + 律所根公钥 + 律所公钥包 + 账号设备签发钥公钥）
  "kwl-usage-page",
  "kwl-device-enroll",
] as const;
export type EnvelopeKind = (typeof ENVELOPE_KINDS)[number];

/**
 * 各类席位令牌的有效期范围（秒；签名服务按它拒签）：通用席位令牌 72～96 小时（网关离线验签的下限，第 02 篇 §10）；
 * 支持服务凭据至多 15 分钟、通知与中继凭据至多 6 小时（与 server.ts 的 *_TOKEN_TTL_SECONDS 一致，用例对照）。
 */
export const SEAT_TTL_BOUNDS: Readonly<Record<"general" | SeatAudience, readonly [number, number]>> = {
  general: [72 * 3600, 96 * 3600],
  support: [60, 15 * 60],
  notify: [60, 6 * 3600],
  relay: [60, 6 * 3600],
};

export interface SeatTokenRequest {
  tid: string;
  uid: string;
  sid: string;
  dev: string;
  aud?: SeatAudience;
  ttlSeconds: number;
  /** 签发时刻（毫秒；控制面按同一时刻推出回复里的到期时刻）。 */
  at: number;
}

export interface SignerPublicKeys {
  envelope: Record<string, string>;
  /** 全部席位公钥（通用 + 各受众）。 */
  seat: Record<string, string>;
  /** 各受众用哪把（kid）；没有的受众用通用席位密钥。 */
  seat_audiences: Partial<Record<SeatAudience, string>>;
  seat_general: string;
  /** 第 66 批：账号设备签发钥（没有配置 = null）。 */
  account_device_ca?: { kid: string; public_key_pem: string } | null;
}

/** 账号设备证书的申请（第 66 批）：签名服务按这些字段核对后签发，issuer 固定 account_ca，有效期至多 366 天、角色不能是 node。 */
export type AccountDeviceCertRequest = Omit<DeviceCertificateInput, "issuer"> & { issuer: "account_ca" };
export const ACCOUNT_DEVICE_CERT_MAX_DAYS = 366;

/** 申请字段核对（本地签名者与签名服务共用）：返回拒签原因，null = 可以签。 */
export function accountDeviceCertProblem(c: unknown, reqNow: number, skewMs = 5 * 60_000): string | null {
  if (!c || typeof c !== "object" || Array.isArray(c)) return "cert_fields_invalid";
  const x = c as Record<string, unknown>;
  const allowed = ["certId", "memberId", "deviceId", "role", "signPublicKeyPem", "encPublicKeyPem", "issuedAt", "expiresAt", "signAlg", "issuer"];
  if (Object.keys(x).some((k) => !allowed.includes(k))) return "cert_field_not_allowed";
  if (x.issuer !== "account_ca") return "cert_issuer_invalid";
  if (typeof x.role !== "string" || !["admin", "partner", "lawyer", "assistant"].includes(x.role)) return "cert_role_not_allowed";
  if (typeof x.deviceId !== "string" || !DEVICE_ID_PATTERN.test(x.deviceId)) return "cert_device_invalid";
  if (typeof x.memberId !== "string" || !/^usr_[A-Za-z0-9_-]{1,120}$/.test(x.memberId)) return "cert_member_invalid";
  const iat = Date.parse(String(x.issuedAt));
  const exp = Date.parse(String(x.expiresAt));
  if (!Number.isFinite(iat) || Math.abs(iat - reqNow) > skewMs) return "cert_issued_at_skew";
  if (!Number.isFinite(exp) || exp <= iat || exp - iat > ACCOUNT_DEVICE_CERT_MAX_DAYS * 86_400_000) return "cert_validity_out_of_range";
  return null;
}

export interface CpSigner {
  readonly mode: "local" | "remote";
  sealEnvelope<T>(kind: EnvelopeKind, body: T, reqNow: number): Promise<CpEnvelope<T>>;
  issueSeatToken(r: SeatTokenRequest): Promise<string>;
  publicKeys(): SignerPublicKeys;
  /** 第 66 批：用账号设备签发钥签一张设备证书（没有配置这把钥的签名者没有此方法）。 */
  issueAccountDeviceCert?(c: AccountDeviceCertRequest, reqNow: number): Promise<DeviceCertificate>;
  /** 进程内同步签名：只有本地签名者有（演练“控制面被攻破”与开发脚本用）；远程签名者没有——生产入口拿不到 ops.seal。 */
  readonly sealSync?: <T>(kind: string, body: T) => CpEnvelope<T>;
  /** 开通码胡椒的派生材料：只有本地签名者有（生产入口必须另给胡椒文件）。 */
  readonly envelopePrivateKey?: KeyObject;
  close?(): void;
}

const pem = (k: KeyObject) => k.export({ type: "spki", format: "pem" }).toString();

export function signerPublicKeys(keys: ControlPlaneKeys): SignerPublicKeys {
  const seat: Record<string, string> = { [keys.seat.kid]: pem(keys.seat.publicKey) };
  const aud: Partial<Record<SeatAudience, string>> = {};
  for (const a of SEAT_AUDIENCES) {
    const k = keys.seatAudiences?.[a];
    if (!k) continue;
    if (k.kid === keys.seat.kid || Object.values(aud).includes(k.kid)) throw new Error(`席位受众密钥编号不能重复：${k.kid}`);
    seat[k.kid] = pem(k.publicKey);
    aud[a] = k.kid;
  }
  const ca = keys.accountDeviceCa;
  if (ca && (ca.kid === keys.envelope.kid || seat[ca.kid])) throw new Error(`账号设备签发钥编号不能与其他密钥重复：${ca.kid}`);
  return { envelope: { [keys.envelope.kid]: pem(keys.envelope.publicKey) }, seat, seat_audiences: aud, seat_general: keys.seat.kid, account_device_ca: ca ? { kid: ca.kid, public_key_pem: pem(ca.publicKey) } : null };
}

/** 选签这一受众的席位密钥（没有拆分的受众用通用席位密钥）。 */
export function seatKeyFor(keys: ControlPlaneKeys, aud: SeatAudience | undefined): CpKeyPair {
  return (aud && keys.seatAudiences?.[aud]) || keys.seat;
}

export function localSigner(keys: ControlPlaneKeys): CpSigner {
  const pub = signerPublicKeys(keys);
  return {
    mode: "local",
    async sealEnvelope(kind, body) {
      return sealEnvelope(kind, body, keys.envelope);
    },
    async issueSeatToken(r) {
      const k = seatKeyFor(keys, r.aud);
      return issueSeatToken({ tid: r.tid, uid: r.uid, sid: r.sid, dev: r.dev, kid: k.kid, ...(r.aud ? { aud: [r.aud] } : {}) }, k.privateKey, r.ttlSeconds, r.at);
    },
    publicKeys: () => pub,
    ...(keys.accountDeviceCa
      ? {
          async issueAccountDeviceCert(c: AccountDeviceCertRequest, reqNow: number) {
            const why = accountDeviceCertProblem(c, reqNow);
            if (why) throw new SignerUnavailableError(why);
            return issueDeviceCertificate(keys.accountDeviceCa!.privateKey.export({ format: "pem", type: "pkcs8" }).toString(), c);
          },
        }
      : {}),
    sealSync: (kind, body) => sealEnvelope(kind, body, keys.envelope),
    envelopePrivateKey: keys.envelope.privateKey,
  };
}

export class SignerUnavailableError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`签名服务不可用：${code}`);
    this.code = code;
  }
}

export interface RemoteSignerOptions {
  /** https://<签名服务>（生产）；http://127.0.0.1:<端口> 只许测试（insecureLoopbackForTest）。 */
  url: string;
  /** mTLS：控制面的客户端证书与私钥、签名服务证书的签发 CA（只信它，不信系统根）。 */
  tls?: { cert: string; key: string; ca: string; servername?: string };
  insecureLoopbackForTest?: boolean;
  timeoutMs?: number;
}

/**
 * 连上签名服务：先取公钥表（只收公钥）并核对格式；之后每次签名一个请求。签名服务不可达、拒签或回复不合格一律抛
 * SignerUnavailableError（控制面对设备回 503，不降级为进程内签名）。
 */
export async function connectRemoteSigner(o: RemoteSignerOptions): Promise<CpSigner> {
  const base = new URL(o.url);
  const secure = base.protocol === "https:";
  if (!secure && !(o.insecureLoopbackForTest && base.hostname === "127.0.0.1")) throw new Error("签名服务只能经 https（mTLS）访问");
  if (secure && !o.tls) throw new Error("签名服务须配置 mTLS（客户端证书、私钥与签发 CA）");
  const agent = secure ? new Agent({ keepAlive: true, maxSockets: 16, cert: o.tls!.cert, key: o.tls!.key, ca: o.tls!.ca, ...(o.tls!.servername ? { servername: o.tls!.servername } : {}), minVersion: "TLSv1.2" }) : undefined;
  const timeoutMs = o.timeoutMs ?? 5_000;
  const call = (method: "GET" | "POST", path: string, body?: unknown): Promise<any> =>
    new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = (secure ? httpsRequest : httpRequest)(
        new URL(path, base),
        { method, agent, headers: { accept: "application/json", ...(data ? { "content-type": "application/json", "content-length": String(data.length) } : {}) }, timeout: timeoutMs },
        (res) => {
          const chunks: Buffer[] = [];
          let n = 0;
          res.on("data", (c: Buffer) => {
            n += c.length;
            if (n > 16 * 1024 * 1024) req.destroy(new SignerUnavailableError("reply_too_large"));
            else chunks.push(c);
          });
          res.on("end", () => {
            let j: any = null;
            try {
              j = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              return reject(new SignerUnavailableError("reply_malformed"));
            }
            if (res.statusCode !== 200) return reject(new SignerUnavailableError(typeof j?.error === "string" && /^[a-z_]{1,48}$/.test(j.error) ? j.error : `status_${res.statusCode}`));
            resolve(j);
          });
          res.on("error", () => reject(new SignerUnavailableError("reply_broken")));
        },
      );
      req.on("timeout", () => req.destroy(new SignerUnavailableError("timeout")));
      req.on("error", (e) => reject(e instanceof SignerUnavailableError ? e : new SignerUnavailableError("unreachable")));
      req.end(data);
    });
  const pk = await call("GET", "/v1/public-keys");
  const checkMap = (m: unknown, what: string): Record<string, string> => {
    if (!m || typeof m !== "object" || Array.isArray(m) || Object.keys(m).length === 0) throw new Error(`签名服务的${what}公钥表为空`);
    for (const [kid, p] of Object.entries(m as Record<string, unknown>)) {
      if (typeof p !== "string" || /PRIVATE/i.test(p)) throw new Error(`签名服务的${what}公钥 ${kid} 不合格`);
      createPublicKey(p);
    }
    return m as Record<string, string>;
  };
  const pub: SignerPublicKeys = {
    envelope: checkMap(pk.envelope, "信封"),
    seat: checkMap(pk.seat, "席位"),
    seat_audiences: pk.seat_audiences && typeof pk.seat_audiences === "object" ? pk.seat_audiences : {},
    seat_general: String(pk.seat_general ?? ""),
    account_device_ca: null,
  };
  // 第 66 批：账号设备签发钥（旧签名服务没有这一项 = 个人账号新电脑仍走批准）
  if (pk.account_device_ca && typeof pk.account_device_ca === "object") {
    const c = pk.account_device_ca as { kid?: unknown; public_key_pem?: unknown };
    if (typeof c.kid !== "string" || typeof c.public_key_pem !== "string" || /PRIVATE/i.test(c.public_key_pem)) throw new Error("签名服务的账号设备签发钥公钥不合格");
    createPublicKey(c.public_key_pem);
    pub.account_device_ca = { kid: c.kid, public_key_pem: c.public_key_pem };
  }
  if (!pub.seat[pub.seat_general]) throw new Error("签名服务没有报通用席位密钥");
  // 交付前先用签名服务报的公钥验一遍回复（复核 RB16A-04）：签名服务配错密钥或被替换时在控制面这一侧就报错，而不是让全部设备验签失败
  const envKeys = publicKeyMap(pub.envelope);
  const seatKeys = publicKeyMap(pub.seat);
  return {
    mode: "remote",
    async sealEnvelope(kind, body, reqNow) {
      const r = await call("POST", "/v1/sign/envelope", { request_id: randomUUID(), req_now: reqNow, kind, body });
      const e = r?.envelope;
      if (!e || e.kind !== kind || typeof e.kid !== "string" || !pub.envelope[e.kid] || typeof e.sig !== "string") throw new SignerUnavailableError("reply_malformed");
      // 签名须对提交的文档成立（按设备收到的 JSON 形态核：与设备验签同一口径）
      const env = { kind, kid: e.kid, body, sig: e.sig };
      if (!openEnvelope(JSON.parse(JSON.stringify(env)), kind, envKeys).ok) throw new SignerUnavailableError("reply_invalid");
      return env;
    },
    async issueSeatToken(r) {
      const j = await call("POST", "/v1/sign/seat-token", { request_id: randomUUID(), req_now: r.at, tid: r.tid, uid: r.uid, sid: r.sid, dev: r.dev, ...(r.aud ? { aud: r.aud } : {}), ttl_s: r.ttlSeconds });
      if (typeof j?.token !== "string" || !j.token.startsWith("zst1.")) throw new SignerUnavailableError("reply_malformed");
      // 令牌须能验过，且字段与申请的一致（租户、成员、席位、设备、受众、有效期）
      let c;
      try {
        c = verifySeatToken(j.token, seatKeys, { now: r.at, ...(r.aud ? { audience: r.aud } : {}) });
      } catch {
        throw new SignerUnavailableError("reply_invalid");
      }
      const audOk = r.aud ? c.aud?.length === 1 && c.aud[0] === r.aud && c.kid === (pub.seat_audiences[r.aud] ?? pub.seat_general) : c.aud === undefined && c.kid === pub.seat_general;
      if (c.tid !== r.tid || c.uid !== r.uid || c.sid !== r.sid || c.dev !== r.dev || c.exp - c.iat !== r.ttlSeconds || !audOk) throw new SignerUnavailableError("reply_invalid");
      return j.token;
    },
    publicKeys: () => pub,
    ...(pub.account_device_ca
      ? {
          async issueAccountDeviceCert(c: AccountDeviceCertRequest, reqNow: number) {
            const j = await call("POST", "/v1/sign/device-cert", { request_id: randomUUID(), req_now: reqNow, cert: c });
            const cert = j?.cert as DeviceCertificate | undefined;
            // 签回来的证书须对账号设备签发钥验过，且字段与申请的一致（签名服务不能借机改编号、成员、角色、公钥或有效期）
            if (!cert || typeof cert !== "object" || !verifyDeviceCertificate(cert, pub.account_device_ca!.public_key_pem, new Date(reqNow)).ok) throw new SignerUnavailableError("reply_invalid");
            const { signature: _sig, ...body } = cert;
            if (JSON.stringify(Object.keys(body).sort().map((k) => [k, (body as Record<string, unknown>)[k]])) !== JSON.stringify(Object.keys(c).filter((k) => (c as Record<string, unknown>)[k] !== undefined).sort().map((k) => [k, (c as Record<string, unknown>)[k]]))) throw new SignerUnavailableError("reply_invalid");
            return cert;
          },
        }
      : {}),
    close: () => agent?.destroy(),
  };
}
