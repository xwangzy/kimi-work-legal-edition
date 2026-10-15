/**
 * 席位令牌（第 02 篇 §10：席位令牌 ≥ 72 小时、网关离线验签、在线自动续期；第 04 篇 §5.2：设备凭据 + 席位令牌）。
 *
 * 形态：`zst1.<b64url(载荷 JSON)>.<b64url(Ed25519 签名)>`。控制面持私钥签发；法律模型网关、检索服务只持公钥，离线验签。
 * 载荷只有租户、用户、席位、设备与有效期——**不含事项信息**（检索调用不携带事项编号；模型网关的匿名事项编号在请求头另给）。
 */
import { createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";

export interface SeatClaims {
  /** 租户（律所）。 */
  tid: string;
  /** 用户。 */
  uid: string;
  /** 席位。 */
  sid: string;
  /** 设备（吊销按设备）。 */
  dev: string;
  /** 签发密钥 ID（轮换用）。 */
  kid: string;
  iat: number;
  exp: number;
  /**
   * 受众（第 9 批复核 S9B-03）：没有 = 通用席位令牌（网关、检索、分发都认，第 9 批之前的形态）；有 = 只给列出的服务用。
   * 支持服务只收带 "support" 受众的短期凭据，网关、检索、分发拒收只限支持服务的凭据——诊断包上传不再把通用席位令牌交给支持域。
   */
  aud?: string[];
}

const PREFIX = "zst1.";
/** 网关离线验签的最短有效期（第 02 篇 §10）。 */
export const MIN_SEAT_TTL_SECONDS = 72 * 3600;

export function issueSeatToken(claims: Omit<SeatClaims, "iat" | "exp">, privateKey: KeyObject, ttlSeconds = MIN_SEAT_TTL_SECONDS, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const payload = Buffer.from(JSON.stringify({ ...claims, iat, exp: iat + ttlSeconds })).toString("base64url");
  const sig = sign(null, Buffer.from(`${PREFIX}${payload}`), privateKey).toString("base64url");
  return `${PREFIX}${payload}.${sig}`;
}

export class SeatTokenError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`席位令牌无效：${reason}`);
    this.reason = reason;
  }
}

/**
 * 离线验签：公钥按 kid 选取；过期、吊销（设备或席位）、形态不符一律拒绝。
 * `audience`：本服务的受众名——令牌带受众而不含它即拒绝；`requireAudience`：没有受众的通用令牌也拒绝（支持服务）。
 */
export function verifySeatToken(
  token: string,
  keys: ReadonlyMap<string, KeyObject>,
  o: { now?: number; revokedDevices?: ReadonlySet<string>; revokedSeats?: ReadonlySet<string>; audience?: string; requireAudience?: boolean } = {},
): SeatClaims {
  if (typeof token !== "string" || !token.startsWith(PREFIX)) throw new SeatTokenError("format");
  const rest = token.slice(PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0) throw new SeatTokenError("format");
  const payload = rest.slice(0, dot);
  const sig = rest.slice(dot + 1);
  let claims: SeatClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SeatClaims;
  } catch {
    throw new SeatTokenError("payload");
  }
  if (!claims || typeof claims.kid !== "string" || typeof claims.tid !== "string" || typeof claims.exp !== "number") throw new SeatTokenError("claims");
  const key = keys.get(claims.kid);
  if (!key) throw new SeatTokenError("unknown_key");
  if (!verify(null, Buffer.from(`${PREFIX}${payload}`), key, Buffer.from(sig, "base64url"))) throw new SeatTokenError("signature");
  const now = Math.floor((o.now ?? Date.now()) / 1000);
  if (claims.exp <= now) throw new SeatTokenError("expired");
  if (o.revokedDevices?.has(claims.dev)) throw new SeatTokenError("device_revoked");
  if (o.revokedSeats?.has(claims.sid)) throw new SeatTokenError("seat_revoked");
  if (claims.aud !== undefined) {
    if (!Array.isArray(claims.aud) || claims.aud.length === 0 || claims.aud.some((a) => typeof a !== "string")) throw new SeatTokenError("audience");
    if (o.audience === undefined || !claims.aud.includes(o.audience)) throw new SeatTokenError("audience");
  } else if (o.requireAudience) throw new SeatTokenError("audience");
  return claims;
}

/** 开发与测试用：生成一对签发密钥。 */
export function devSeatKeyPair(): { privateKey: KeyObject; publicKey: KeyObject } {
  return generateKeyPairSync("ed25519");
}

export function publicKeyFromPem(pem: string): KeyObject {
  return createPublicKey(pem);
}
