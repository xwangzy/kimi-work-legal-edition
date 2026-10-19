/**
 * 控制面最小集 v0（v9 第 02 篇 §5 ① 控制面、§7.1 #1–#5、§9.9、§10；第 04 篇 §5.2、§10；第 06 篇 §1 G0“控制面最小集”）。
 *
 * - 租户与许可（30 天，端侧离线验签）、席位（≥ 72 小时席位令牌，在线续期）；
 * - 设备与公钥目录（设备证书由律所根签发，控制面只转交）与吊销；网关与检索服务订阅吊销集；
 * - 律所策略与连接器登记：起草（版本 = 当前已发布版本 + 1，草稿不占版本号；复核 S6-B29）→ 管理员设备签名 → 发布（已过时的草稿拒绝发布）；
 *   新租户发布最严模板（只需控制面签名）；
 * - 吊销尚未登记的设备编号（例如证书已签发、从未联网的新电脑）记为预先吊销：列入目录与网关订阅，之后拒绝它登记（复核 S6-B31）；
 * - 租户盐下发设备；事项匿名摘要由设备上报、下发网关做二次检查（收敛偏离 D-20）；
 * - **不持久化客户内容**：只有账号、设备、席位、策略、匿名事项编号与属性（v0 为内存存储）。
 *
 * 控制面是“诚实时”的行为：发布放宽类策略与连接器时同样检查管理员签名门限。但律所侧**不依赖**控制面诚实——
 * 客户端按本机固定的律所根公钥与门限独立核验（packages/firm-trust；T17 演练）。
 * 设备请求一律设备签名（firm-trust/request-auth）；网关订阅用服务间凭据（G0：共享密钥；生产为 mTLS）。
 */
import { createHash, generateKeyPairSync, hkdfSync, randomBytes, timingSafeEqual, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { StateStore } from "./state-store.ts";
import { createAuditLog, type AuditEntry, type AuditLog } from "./audit-log.ts";
import { emptyQuota, grantPoints as quotaGrant, leaseQuota, QuotaError, quotaView, setCap as quotaSetCap, settleLease, type QuotaState } from "./quota.ts";
import { canonicalJson, verifyBytes, verifyDeviceCertificate, DEVICE_ID_PATTERN, type DeviceCertificate } from "@zr-legal/keys";
import { issueSeatToken, MIN_SEAT_TTL_SECONDS } from "@zr-legal/seat-token";
import {
  activationCodeMac,
  claimSecretHash,
  firmBundleBytes,
  joinProofBytes,
  type FirmBundle,
  MEMBER_SLUG_PATTERN,
  newActivationCode,
  newClaimSecret,
  normalizeActivationCode,
  validDisplayName,
  type ActivationRedeemResult,
  adminThresholdForEdition,
  connectorSigningBytes,
  enrollProofBytes,
  policyRelaxations,
  policySigningBytes,
  sealEnvelope,
  strictestTemplate,
  validateConnectorDoc,
  validatePolicyBody,
  stricterSummary,
  validateSummary,
  verifyAdminSignatures,
  verifyDeviceRequest,
  type AdminSignature,
  type AnonMatterSummary,
  type CpEnvelope,
  type DeviceRevocationNotice,
  type DirectoryBody,
  type FirmConnectorDoc,
  type FirmPolicyDoc,
  type GatewayFeedBody,
  type LicenseBody,
  type SignedFirmConnector,
  type SignedFirmPolicy,
  type TenantSaltBody,
  type CpAuditActor,
  type CpAuditPage,
} from "@zr-legal/firm-trust";

export interface CpKeyPair {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

export interface ControlPlaneKeys {
  /** 控制面文档信封签名密钥（许可、目录、盐、策略外层、连接器目录、网关订阅）。 */
  envelope: CpKeyPair;
  /** 席位令牌签发密钥（网关、检索服务离线验签）。 */
  seat: CpKeyPair;
}

/** 开发与测试用：生成控制面的两对密钥（生产在 KMS，公钥随客户端与网关构建固定）。 */
export function devControlPlaneKeys(): ControlPlaneKeys {
  const e = generateKeyPairSync("ed25519");
  const s = generateKeyPairSync("ed25519");
  return { envelope: { kid: "cp-dev1", ...e }, seat: { kid: "seat-dev1", ...s } };
}

export interface DeviceRecord {
  cert: DeviceCertificate;
  registered_at: string;
  revoked_at: string | null;
}

export interface SeatRecord {
  sid: string;
  uid: string;
  assigned_at: string;
  revoked_at: string | null;
}

export interface DraftRecord {
  draft_id: string;
  kind: "policy" | "connector";
  doc: FirmPolicyDoc | FirmConnectorDoc;
  admin_signatures: AdminSignature[];
  created_by: string;
  created_at: string;
  published_at: string | null;
}

/**
 * 开通码 / 邀请码记录（第 13 批，设计 docs/design/开通与成员入组设计-v1.md）：只存码的 HMAC 与认领凭据的摘要。
 * 状态：open（未兑换）→ claimed（已兑换，认领凭据有效；同一码在消费前可再兑换一次，旧凭据作废）→ consumed（创始：律所根已登记；
 * 成员：入组申请已批准）；revoked / 过期不再接受。成员显示名只留到消费为止（之后清空，云端不长期保存姓名）。
 */
export interface ActivationRecord {
  id: string;
  code_mac: string;
  kind: "founder" | "member";
  member: { slug: string; name: string | null; role: "admin" | "partner" | "lawyer" | "assistant" };
  created_at: string;
  expires_at: string;
  /** 发码者：运营（"ops"）或管理员设备编号。 */
  created_by: string;
  status: "open" | "claimed" | "consumed" | "revoked";
  claim_hash: string | null;
  claimed_at: string | null;
  consumed_at: string | null;
  /** 同一认领提交入组申请的次数（被拒后可重提，至多 3 次）。 */
  join_attempts: number;
}

/** 成员入组申请：成员设备提交公钥，管理员本机核对核对码后用律所根签发证书，经此送达。 */
export interface JoinRequestRecord {
  id: string;
  activation_id: string;
  member_slug: string;
  role: ActivationRecord["member"]["role"];
  device_id: string;
  sign_pub: string;
  enc_pub: string;
  created_at: string;
  status: "pending" | "approved" | "rejected";
  decided_at: string | null;
  decided_by: string | null;
  cert: DeviceCertificate | null;
  /** 律所公钥包（恢复托管公钥 + 律所根签名），批准时随证书一并存，成员取回。 */
  firm_bundle: FirmBundle | null;
}

export interface TenantRecord {
  tid: string;
  /** 律所显示名（开通时运营填写；缺省为租户编号）。 */
  name?: string;
  /** 开通须出示创始开通码（第 13 批：关闭“知道租户编号即可抢先登记律所根”）；旧状态缺省 false。 */
  activation_required?: boolean;
  activations: Map<string, ActivationRecord>;
  joinRequests: Map<string, JoinRequestRecord>;
  edition: LicenseBody["edition"];
  seats: number;
  root_public_key_pem: string | null;
  salt_b64: string;
  created_at: string;
  license: LicenseBody;
  /** 订阅截止（合同）：许可按设备签到滚动签发 ≤ 30 天，但不超过订阅截止（复核 S6-A06）。 */
  subscription_until: string;
  devices: Map<string, DeviceRecord>;
  /** 预先吊销的设备编号（尚未登记即被吊销；之后拒绝其登记）→ 吊销时刻与发起吊销的设备。 */
  preRevoked: Map<string, { revoked_at: string; by: string | null }>;
  seatsByUser: Map<string, SeatRecord>;
  seatCounter: number;
  directoryVersion: number;
  policy: SignedFirmPolicy | null;
  connectors: Map<string, SignedFirmConnector>;
  connectorsVersion: number;
  drafts: Map<string, DraftRecord>;
  anon: Map<string, AnonMatterSummary>;
  /** 额度池与月度上限（S3 v0，quota.ts）。 */
  quota: QuotaState;
}

export interface ControlPlaneOptions {
  keys: ControlPlaneKeys;
  /** 网关与检索服务订阅凭据（G0：共享密钥；生产为 mTLS）。 */
  serviceSecret: string;
  /** 席位令牌有效期（秒；不低于 72 小时）。 */
  seatTtlSeconds?: number;
  now?: () => number;
  maxBodyBytes?: number;
  /** 每租户预先吊销的设备数上限（缺省 1000；用例可调小）。 */
  maxPreRevoked?: number;
  /** 状态持久化（试点形态，state-store.ts）：未给出 = 只在内存（开发与测试）。 */
  stateStore?: StateStore;
  /** 运营审计流水（S14 v0，audit-log.ts）：未给出 = 只在内存。 */
  auditLog?: AuditLog;
  /**
   * 开通码 HMAC 的胡椒（32 字节；生产由 KMS 下发，与签名密钥分开）。未给出 = 由信封签名私钥 HKDF 派生（开发与试点形态：
   * 重启后不变，码记录仍可核对）。
   */
  codePepper?: Uint8Array;
}

export interface ControlPlaneOps {
  /** 商务开通：建租户、发许可（≤ 30 天）、生成租户盐、发布最严模板策略 v1（不比最严模板宽：只需控制面签名）。 */
  createTenant(o: { tid: string; edition: LicenseBody["edition"]; seats: number; subscriptionDays?: number; points?: number; name?: string; activationRequired?: boolean }): TenantRecord;
  /** 发创始开通码（交律所管理员）：返回码明文（只此一次）；云端只存 HMAC。 */
  issueActivationCode(tid: string, o: { member: { slug: string; name?: string }; ttlHours?: number }): { code: string; activation_id: string; expires_at: string };
  /** 作废尚未消费的开通码 / 邀请码。 */
  revokeActivationCode(tid: string, activationId: string): void;
  /** 续订：订阅截止改为 days 天后（许可仍按签到滚动签发 ≤ 30 天）。 */
  renewLicense(tid: string, days: number): LicenseBody;
  /** 终止订阅（合同终止）：此后签发的许可立即到期，客户端进入退出模式。 */
  terminateLicense(tid: string): LicenseBody;
  /** 吊销设备；尚未登记的设备须附它的律所根签发证书（预先吊销，复核 S6-C05、S6-C09）。 */
  revokeDevice(tid: string, deviceId: string, o?: { cert?: unknown; by?: string }): void;
  revokeSeat(tid: string, uid: string): void;
  /** 运营加量：额度池注入点数（S3）。 */
  grantPoints(tid: string, points: number): void;
  /** 运营代设月度上限（律所管理员通常在客户端自己设；null = 不设上限）。 */
  setQuotaCap(tid: string, cap: number | null): void;
  tenant(tid: string): TenantRecord | undefined;
  /** 用控制面自己的信封密钥签任意文档（演练“控制面被攻破”时攻击者同样能做到）。 */
  seal<T>(kind: string, body: T): CpEnvelope<T>;
  /** 网关订阅版本递增（直接改了存储之后调用）。 */
  touch(): void;
}

export interface ControlPlane {
  server: Server;
  ops: ControlPlaneOps;
  publicKeys: { envelope: Record<string, string>; seat: Record<string, string> };
}

class CpError extends Error {
  readonly status: number;
  readonly code: string;
  /** 随错误一并返回的字段（例如已吊销设备的签名吊销通知）。 */
  readonly extra: Record<string, unknown> | undefined;
  constructor(status: number, code: string, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** 每租户预先吊销的设备数上限（复核 S6-C09：防止目录被撑过通道响应上限）。 */
const MAX_PRE_REVOKED = 1000;

/** 支持服务专用凭据的有效期（复核 S9B-03）。 */
export const SUPPORT_TOKEN_TTL_SECONDS = 15 * 60;
/**
 * 通知服务专用凭据的有效期（第 10 批 S9）：客户端在线时每分钟取一次到时提醒，凭据 6 小时一换——
 * 签发要记操作审计并同步写盘，过短会让每台设备每天往流水里写几十条。
 */
export const NOTIFY_TOKEN_TTL_SECONDS = 6 * 3600;
/** 共享中继专用凭据的有效期（第 11 批 S11；客户端在线时持续收发，与通知凭据同为 6 小时）。 */
export const RELAY_TOKEN_TTL_SECONDS = 6 * 3600;

/** 席位令牌缺省签发时长（96 小时，复核 S6-A01）。 */
export const SEAT_TTL_DEFAULT_SECONDS = 96 * 3600;

const DAY_MS = 24 * 3600 * 1000;

export function createControlPlane(o: ControlPlaneOptions): ControlPlane {
  const now = o.now ?? Date.now;
  const maxPreRevoked = o.maxPreRevoked ?? MAX_PRE_REVOKED;
  const iso = (t = now()) => new Date(t).toISOString();
  const tenants = new Map<string, TenantRecord>();
  const nonces = new Map<string, number>();
  const auditLog = o.auditLog ?? createAuditLog();
  /** 写一条审计；写不进去即整个操作失败（调用方回滚）。 */
  const audit = (e: AuditEntry): void => {
    try {
      auditLog.append(e, iso());
    } catch {
      throw new CpError(500, "audit_unavailable", "审计流水写入失败，本次操作未生效");
    }
  };
  let feedVersion = 1;
  // 持久化（试点形态）：启动时读回；每个响应发出之前、每个运维操作之后，状态有变化即写盘（state-store.ts）。
  // “没写成就等于没发生”（复核 B4-R01）：写盘失败或请求出错时，内存状态回到上次写成的样子；请求得到 500，进程不退出。
  // 防重放 nonce 单独处理（复核 B4-R14）：只有 nonce 变了不触发整份重写（否则每个只读请求都要重写并 fsync），
  // 随下一次状态写入或每 30 秒的定时写入一并落盘；崩溃后丢失的至多是最近一个周期的 nonce，且只能在请求时间窗内重放
  let lastSaved: string | null = null;
  let lastSavedState: string | null = null;
  let noncesDirty = false;
  const stateOnly = (): string =>
    JSON.stringify({
      v: 1,
      feedVersion,
      tenants: [...tenants.values()].map((t) => ({ ...t, devices: [...t.devices], preRevoked: [...t.preRevoked], seatsByUser: [...t.seatsByUser], connectors: [...t.connectors], drafts: [...t.drafts], anon: [...t.anon], activations: [...t.activations], joinRequests: [...t.joinRequests] })),
    });
  const snapshot = (state = stateOnly()): string => JSON.stringify({ ...(JSON.parse(state) as object), nonces: [...nonces] });
  /** 由快照重建内存状态（启动读回与失败回滚共用）；null = 空状态。 */
  const applySnapshot = (raw: string | null, withNonces: boolean): void => {
    tenants.clear();
    feedVersion = 1;
    if (withNonces) nonces.clear();
    if (raw === null) return;
    const st = JSON.parse(raw) as { v: number; feedVersion: number; nonces?: [string, number][]; tenants: any[] };
    if (st.v !== 1) throw new Error(`控制面状态版本不认识：${st.v}`);
    feedVersion = st.feedVersion;
    if (withNonces) for (const [k, exp] of st.nonces ?? []) nonces.set(k, exp);
    for (const t of st.tenants) {
      // 第 9 批之前保存的状态没有额度字段：按空池读回（运营须重新注入点数）
      // 第 13 批之前保存的状态没有开通码与入组申请：按空读回（这些租户不要求开通码，行为与之前相同）
      tenants.set(t.tid, {
        ...t,
        devices: new Map(t.devices),
        preRevoked: new Map(t.preRevoked),
        seatsByUser: new Map(t.seatsByUser),
        connectors: new Map(t.connectors),
        drafts: new Map(t.drafts),
        anon: new Map(t.anon),
        activations: new Map(t.activations ?? []),
        joinRequests: new Map(t.joinRequests ?? []),
        quota: t.quota ?? emptyQuota(now()),
      });
    }
  };
  if (o.stateStore) {
    const raw = o.stateStore.load();
    if (raw !== null) {
      applySnapshot(raw, true);
      lastSaved = raw;
      lastSavedState = stateOnly();
    }
  }
  /** 状态有变化（或 force 且 nonce 有变化）即写盘；失败则回滚到上次写成的状态并抛 500。 */
  const persistNow = (force = false): void => {
    if (!o.stateStore) return;
    const state = stateOnly();
    if (state === lastSavedState && !(force && noncesDirty)) return;
    const json = snapshot(state);
    try {
      o.stateStore.save(json);
    } catch {
      rollback();
      throw new CpError(500, "state_persist_failed", "控制面状态写盘失败，本次操作未生效");
    }
    lastSaved = json;
    lastSavedState = state;
    noncesDirty = false;
  };
  /** 回到上次写成的状态（nonce 保留：已见过的仍视为见过，回滚不能打开重放）。 */
  const rollback = (): void => {
    if (!o.stateStore) return;
    if (stateOnly() !== lastSavedState) applySnapshot(lastSaved, false);
  };
  const nonceFlush = o.stateStore
    ? setInterval(() => {
        try {
          persistNow(true);
        } catch {
          // 下个周期再试
        }
      }, 30_000)
    : null;
  nonceFlush?.unref();
  // 席位令牌签发 96 小时（复核 S6-A01）：客户端剩余不足 73 小时即续期，任何时刻控制面停机后都还有 ≥ 72 小时可用（第 02 篇 §10、§13 第 10 条）
  const seatTtl = Math.max(MIN_SEAT_TTL_SECONDS, o.seatTtlSeconds ?? SEAT_TTL_DEFAULT_SECONDS);
  const seal = <T>(kind: string, body: T): CpEnvelope<T> => sealEnvelope(kind, body, o.keys.envelope);

  const seenNonce = (key: string): boolean => {
    const t = now();
    if (nonces.size > 20_000) for (const [k, exp] of nonces) if (exp < t) nonces.delete(k);
    if (nonces.has(key)) return true;
    nonces.set(key, t + 10 * 60_000);
    noncesDirty = true;
    return false;
  };

  const tenantOf = (tid: string): TenantRecord => {
    const t = tenants.get(tid);
    if (!t) throw new CpError(404, "tenant_unknown", "租户未开通");
    return t;
  };

  const licenseValid = (t: TenantRecord): boolean => Date.parse(t.subscription_until) > now();

  // ─── 开通与入组（第 13 批） ───
  const codePepper: Buffer = o.codePepper
    ? Buffer.from(o.codePepper)
    : Buffer.from(hkdfSync("sha256", o.keys.envelope.privateKey.export({ format: "der", type: "pkcs8" }), Buffer.alloc(0), "kwl-cp-code-pepper/1", 32));
  if (codePepper.byteLength !== 32) throw new Error("开通码胡椒须为 32 字节");
  /** 律所标识 = 租户编号去掉 ten_ 前缀（与内核 identity.ts 的 ten_<律所标识> 对应）；不合规的租户不能发开通码。 */
  const firmSlugOf = (tid: string): string | null => (/^ten_[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(tid) ? tid.slice(4) : null);
  const newRecordId = (prefix: string) => `${prefix}_${randomBytes(12).toString("base64url")}`;
  const sameHex = (a: string, b: string): boolean => {
    const x = Buffer.from(a, "hex");
    const y = Buffer.from(b, "hex");
    return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
  };
  const activationLive = (r: ActivationRecord): boolean => (r.status === "open" || r.status === "claimed") && Date.parse(r.expires_at) > now();
  /** 认领凭据核对（成员入组、创始登记根公钥）：码已兑换、未消费、未作废；认领后 7 天内有效。 */
  const claimOf = (t: TenantRecord, activationId: unknown, secret: unknown, kind: ActivationRecord["kind"]): ActivationRecord => {
    const r = typeof activationId === "string" ? t.activations.get(activationId) : undefined;
    const ok =
      !!r &&
      r.kind === kind &&
      r.status === "claimed" &&
      typeof secret === "string" &&
      secret.length <= 128 &&
      !!r.claim_hash &&
      sameHex(r.claim_hash, claimSecretHash(secret)) &&
      Date.parse(r.claimed_at ?? "") + 7 * DAY_MS > now();
    if (!ok) throw new CpError(403, "claim_invalid", "开通凭据无效或已过期，请重新输入开通码或邀请码");
    return r!;
  };
  const issueCode = (t: TenantRecord, o2: { kind: ActivationRecord["kind"]; member: { slug: string; name?: string | null; role: ActivationRecord["member"]["role"] }; ttlHours: number; by: string }) => {
    if (!firmSlugOf(t.tid)) throw new CpError(400, "tid_not_activatable", "租户编号须为 ten_<律所标识> 才能发开通码");
    if (!MEMBER_SLUG_PATTERN.test(o2.member.slug)) throw new CpError(400, "member_slug_invalid", "成员标识只允许小写字母、数字、下划线与连字符");
    if (o2.member.name != null && !validDisplayName(o2.member.name)) throw new CpError(400, "member_name_invalid", "成员姓名须为 1–40 个字符");
    const live = [...t.activations.values()].filter(activationLive).length;
    if (live >= 200) throw new CpError(409, "too_many_open_codes", "未使用的开通码与邀请码过多，请先作废不用的");
    const code = newActivationCode();
    const at = now();
    const rec: ActivationRecord = {
      id: newRecordId("act"),
      code_mac: activationCodeMac(codePepper, code),
      kind: o2.kind,
      member: { slug: o2.member.slug, name: o2.member.name ?? null, role: o2.member.role },
      created_at: iso(at),
      expires_at: iso(at + Math.min(Math.max(1, o2.ttlHours), 14 * 24) * 3600_000),
      created_by: o2.by,
      status: "open",
      claim_hash: null,
      claimed_at: null,
      consumed_at: null,
      join_attempts: 0,
    };
    t.activations.set(rec.id, rec);
    return { code, activation_id: rec.id, expires_at: rec.expires_at };
  };
  /** 兑换限速：同一来源每分钟 10 次、全平台每分钟 600 次（码有 100 bit，限速只为压低噪声与撑大流水）。 */
  const redeemWindow = new Map<string, { minute: number; n: number }>();
  const redeemAllowed = (source: string): boolean => {
    const minute = Math.floor(now() / 60_000);
    if (redeemWindow.size > 50_000) redeemWindow.clear();
    for (const [k, lim] of [[`src:${source}`, 10], ["all", 600]] as const) {
      const w = redeemWindow.get(k);
      if (!w || w.minute !== minute) redeemWindow.set(k, { minute, n: 1 });
      else if (++w.n > lim) return false;
    }
    return true;
  };

  /**
   * 签发许可（复核 S6-A06：按设备签到滚动）：签发时刻 = 现在，到期 = min(现在 + 30 天, 订阅截止)；
   * 订阅已终止 → 新签发一份立即到期的许可（客户端按签发时刻接受更新的一份，进入退出模式）。
   */
  const issueLicense = (t: TenantRecord): LicenseBody => {
    const iat = now();
    const until = Date.parse(t.subscription_until);
    // 订阅已终止：签发一份签发时刻比现在早 1 毫秒、到期即现在的许可——签发之后任何时刻都已过期（不依赖毫秒级时序）
    t.license =
      until > iat
        ? { tid: t.tid, edition: t.edition, seats: t.seats, issued_at: iso(iat), expires_at: iso(Math.min(iat + 30 * DAY_MS, until)) }
        : { tid: t.tid, edition: t.edition, seats: t.seats, issued_at: iso(iat - 1), expires_at: iso(iat) };
    return t.license;
  };

  const publishStrictest = (t: TenantRecord): void => {
    const iat = now();
    const doc: FirmPolicyDoc = { kind: "kwl-firm-policy", v: 1, tid: t.tid, version: (t.policy?.doc.version ?? 0) + 1, issued_at: iso(iat), expires_at: iso(iat + 30 * DAY_MS), body: strictestTemplate() };
    t.policy = { doc, admin_signatures: [] };
    feedVersion += 1;
  };

  const rawOps: ControlPlaneOps = {
    createTenant({ tid, edition, seats, subscriptionDays = 365, points = 0, name, activationRequired = false }) {
      // 租户编号字符集（复核 S9A-01：不合规的编号写进审计流水会让重启验链失败）
      if (typeof tid !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(tid)) throw new CpError(400, "tid_invalid", "租户编号只能用字母、数字、下划线与连字符");
      if (tenants.has(tid)) throw new Error(`租户已存在：${tid}`);
      if (name !== undefined && !validDisplayName(name)) throw new CpError(400, "tenant_name_invalid", "律所名称须为 1–40 个字符");
      const t: TenantRecord = {
        tid,
        ...(name !== undefined ? { name } : {}),
        activation_required: activationRequired,
        activations: new Map(),
        joinRequests: new Map(),
        edition,
        seats,
        root_public_key_pem: null,
        salt_b64: randomBytes(32).toString("base64"),
        created_at: iso(),
        license: { tid, edition, seats, issued_at: iso(), expires_at: iso() },
        subscription_until: iso(now() + subscriptionDays * DAY_MS),
        devices: new Map(),
        preRevoked: new Map(),
        seatsByUser: new Map(),
        seatCounter: 0,
        directoryVersion: 1,
        policy: null,
        connectors: new Map(),
        connectorsVersion: 1,
        drafts: new Map(),
        anon: new Map(),
        quota: emptyQuota(now()),
      };
      if (points > 0) quotaGrant(t.quota, points);
      issueLicense(t);
      publishStrictest(t);
      tenants.set(tid, t);
      return t;
    },
    renewLicense(tid, days) {
      const t = tenantOf(tid);
      t.subscription_until = iso(now() + Math.max(1, days) * DAY_MS);
      return issueLicense(t);
    },
    terminateLicense(tid) {
      const t = tenantOf(tid);
      t.subscription_until = iso(now());
      return issueLicense(t);
    },
    revokeDevice(tid, deviceId, o = {}) {
      const t = tenantOf(tid);
      if (!DEVICE_ID_PATTERN.test(deviceId)) throw new CpError(400, "device_id_invalid", "设备编号不合法");
      const d = t.devices.get(deviceId);
      if (d) {
        if (d.revoked_at) return;
        d.revoked_at = iso();
      } else {
        // 尚未登记：预先吊销（列入目录与网关订阅，之后拒绝其登记；复核 S6-B31）。只认本所律所根签发、编号相符的证书
        // （不能凭空封禁任意编号，例如尚未入职成员或所内节点；复核 S6-C05），每租户有数量上限（复核 S6-C09）
        if (t.preRevoked.has(deviceId)) return;
        const cert = o.cert as DeviceCertificate | undefined;
        if (!cert || typeof cert !== "object") throw new CpError(400, "cert_required", "吊销尚未登记的设备须附它的设备证书");
        // 只核对“由本所律所根签发、编号相符”，不看是否已过期（按签发时刻核验签名）
        const issued = Date.parse(String(cert.issuedAt));
        const cv = t.root_public_key_pem && Number.isFinite(issued) ? verifyDeviceCertificate(cert, t.root_public_key_pem, new Date(issued)) : { ok: false as const, reason: "root_not_enrolled" };
        if (!cv.ok || cert.deviceId !== deviceId) throw new CpError(400, "cert_invalid", "设备证书未由本所律所根签发或与设备编号不符");
        if (t.preRevoked.size >= maxPreRevoked) throw new CpError(409, "pre_revocation_limit", "预先吊销的设备数已达上限");
        t.preRevoked.set(deviceId, { revoked_at: iso(), by: o.by ?? null });
      }
      t.directoryVersion += 1;
      feedVersion += 1;
    },
    revokeSeat(tid, uid) {
      const t = tenantOf(tid);
      const s = t.seatsByUser.get(uid);
      if (!s) throw new Error(`成员没有席位：${uid}`);
      if (!s.revoked_at) {
        s.revoked_at = iso();
        t.directoryVersion += 1;
        feedVersion += 1;
      }
    },
    grantPoints(tid, points) {
      quotaGrant(tenantOf(tid).quota, points);
    },
    issueActivationCode(tid, { member, ttlHours = 14 * 24 }) {
      return issueCode(tenantOf(tid), { kind: "founder", member: { slug: member.slug, name: member.name ?? null, role: "admin" }, ttlHours, by: "ops" });
    },
    revokeActivationCode(tid, activationId) {
      const t = tenantOf(tid);
      const r = t.activations.get(activationId);
      if (!r) throw new CpError(404, "activation_unknown", "没有这个开通码");
      if (r.status === "consumed") throw new CpError(409, "activation_consumed", "开通码已使用，不能作废（请改为吊销设备）");
      r.status = "revoked";
      r.member.name = null;
      for (const jr of t.joinRequests.values()) if (jr.activation_id === r.id && jr.status === "pending") Object.assign(jr, { status: "rejected", decided_at: iso(), decided_by: "ops" });
    },
    setQuotaCap(tid, cap) {
      quotaSetCap(tenantOf(tid).quota, cap, now(), null);
    },
    tenant: (tid) => tenants.get(tid),
    seal,
    touch() {
      feedVersion += 1;
    },
  };
  // 运维操作（开通、续订、吊销等）之后同样落盘，并记运营审计（S14）：先记“成功”再写盘，写盘失败补记“已撤销”
  // 数值明细（复核 S9A-09）只放整数；成员只记席位编号（复核 S9A-11：成员编号可能是姓名拼音，流水不可删）
  const seatOf = (tid: string, uid: unknown): string | null => tenants.get(tid)?.seatsByUser.get(String(uid))?.sid ?? null;
  const OPS_AUDIT: Readonly<Record<string, { action: string; target?: (args: unknown[]) => string | null; detail?: (args: unknown[]) => Record<string, number> | undefined }>> = {
    createTenant: {
      action: "tenant.create",
      detail: (a) => {
        const x = (a[0] ?? {}) as { seats?: unknown; points?: unknown };
        return { seats: Number(x.seats) || 0, points: Number(x.points) || 0 };
      },
    },
    renewLicense: { action: "license.renew", detail: (a) => ({ days: Math.floor(Number(a[1])) || 0 }) },
    terminateLicense: { action: "license.terminate" },
    revokeDevice: { action: "device.revoke", target: (a) => String(a[1]) },
    revokeSeat: { action: "seat.revoke", target: (a) => seatOf(String(a[0]), a[1]) },
    grantPoints: { action: "quota.grant", detail: (a) => ({ points: Math.floor(Number(a[1])) || 0 }) },
    issueActivationCode: { action: "activation.issue" },
    revokeActivationCode: { action: "activation.revoke", target: (a) => String(a[1]) },
    setQuotaCap: { action: "quota.cap_set", detail: (a) => (a[1] === null ? { uncapped: 1 } : { cap: Math.floor(Number(a[1])) || 0 }) },
  };
  const OPS_ACTOR: CpAuditActor = { kind: "ops", id: "ops" };
  /** 路由代为调用运维操作时为真：审计由路由按设备执行者记，包装不再按“运营”记一条。 */
  let routeCall = false;
  const viaRoute = <T>(fn: () => T): T => {
    routeCall = true;
    try {
      return fn();
    } finally {
      routeCall = false;
    }
  };
  const ops: ControlPlaneOps = Object.fromEntries(
    Object.entries(rawOps).map(([k, fn]) => [
      k,
      (...args: unknown[]) => {
        const spec = routeCall ? undefined : OPS_AUDIT[k];
        const tid = k === "createTenant" ? String((args[0] as { tid?: unknown } | undefined)?.tid ?? "") : String(args[0] ?? "");
        const detail = spec?.detail?.(args);
        const entry = spec ? { tid, actor: OPS_ACTOR, action: spec.action, target: spec.target ? spec.target(args) : null, ...(detail ? { detail } : {}) } : null;
        let r: unknown;
        try {
          r = (fn as (...a: unknown[]) => unknown)(...args);
          if (entry && tenants.has(tid)) audit({ ...entry, result: "ok" });
        } catch (e) {
          rollback();
          if (entry && tenants.has(tid)) {
            try {
              auditLog.append({ ...entry, result: `rejected:${e instanceof CpError || e instanceof QuotaError ? e.code : "error"}` }, iso());
            } catch {
              // 审计写不进去：操作本身已失败
            }
          }
          throw e;
        }
        // 路由代调时不在这里写盘（复核 S9A-03）：由路由的 send 统一按“审计 → 写盘 → 回复”执行，审计写不进去即整个操作回滚
        if (k !== "tenant" && k !== "seal" && !routeCall) {
          try {
            persistNow();
          } catch (e) {
            if (entry) {
              try {
                auditLog.append({ ...entry, result: "rolled_back:state_persist_failed" }, iso());
              } catch {
                // 同上
              }
            }
            throw e;
          }
        }
        return r;
      },
    ]),
  ) as unknown as ControlPlaneOps;

  /** 已登记、未吊销的设备公钥（设备签名请求核验用）。 */
  const devicePub = (tid: string, deviceId: string): string | null => {
    const d = tenants.get(tid)?.devices.get(deviceId);
    return d && !d.revoked_at ? d.cert.signPublicKeyPem : null;
  };

  const readBody = async (req: IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > (o.maxBodyBytes ?? 256 * 1024)) throw new CpError(413, "body_too_large", "请求体过大");
      chunks.push(c as Buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  };

  const parseJson = (raw: string): Record<string, unknown> => {
    if (!raw) return {};
    try {
      const v = JSON.parse(raw) as unknown;
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not object");
      return v as Record<string, unknown>;
    } catch {
      throw new CpError(400, "body_not_json", "请求体不是 JSON 对象");
    }
  };

  /** 只发送、不持久化（错误应答用）。 */
  const sendRaw = (res: ServerResponse, status: number, body: unknown) => {
    const s = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(s), "cache-control": "no-store" });
    res.end(s);
  };
  /**
   * “被拒绝”记录限速（复核 S9A-10）：同一租户、同一执行者、同一动作每分钟至多 10 条，之后的同类拒绝不再进流水
   * （已认证设备反复发同一个被拒请求不能撑大流水、也不能每条都同步写盘拖慢全平台）。
   */
  /**
   * 凭据签发限速（复核 S9A-23）：同一设备每小时至多签 12 张席位令牌 / 支持凭据（正常续期每天一次、上传每次一张）——
   * 成功的签发都要记审计并同步写盘，不能让一台设备反复申请撑大流水。
   */
  const issueWindow = new Map<string, { hour: number; n: number }>();
  const issueAllowed = (tid: string, dev: string, action: string): boolean => {
    const hour = Math.floor(now() / 3600_000);
    const k = `${tid}\u0000${dev}\u0000${action}`;
    if (issueWindow.size > 50_000) issueWindow.clear();
    const w = issueWindow.get(k);
    if (!w || w.hour !== hour) {
      issueWindow.set(k, { hour, n: 1 });
      return true;
    }
    w.n += 1;
    return w.n <= 12;
  };
  const rejectedWindow = new Map<string, { minute: number; n: number }>();
  const rejectedAllowed = (e: Omit<AuditEntry, "result">): boolean => {
    const minute = Math.floor(now() / 60_000);
    const k = `${e.tid}\u0000${e.actor.id}\u0000${e.action}`;
    const w = rejectedWindow.get(k);
    if (rejectedWindow.size > 50_000) rejectedWindow.clear();
    if (!w || w.minute !== minute) {
      rejectedWindow.set(k, { minute, n: 1 });
      return true;
    }
    w.n += 1;
    return w.n <= 10;
  };
  /** 本请求要记的运营审计（设备签名核验通过之后才记：未认证的请求只进访问日志，不能用来撑大律所的审计流水）。 */
  /** extra：同一请求顺带发生的写操作（如登记时自动分配席位；复核 S9A-22），与主记录同样“先记、写盘失败补记已撤销”。 */
  const auditCtx = new WeakMap<ServerResponse, { entry: Omit<AuditEntry, "result">; written: boolean; extra?: Omit<AuditEntry, "result">[] }>();
  const send = (res: ServerResponse, status: number, body: unknown) => {
    // 先记审计、再持久化、再回复：吊销、席位、发布一旦回复成功即已落盘且有审计（写盘失败 → 外层补记“已撤销”）
    const ctx = auditCtx.get(res);
    if (ctx && !ctx.written) {
      for (const x of ctx.extra ?? []) audit({ ...x, result: "ok" });
      audit({ ...ctx.entry, result: "ok" });
      ctx.written = true;
    }
    persistNow();
    const s = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(s), "cache-control": "no-store" });
    res.end(s);
  };

  /**
   * 已吊销设备的签名请求（签名仍用它登记时的公钥核验）→ 403 + 控制面签名的吊销通知（复核 S6-A02、S6-B01）：
   * 设备据此进入退出模式。只有签名有效的请求才拿得到通知（通知本身只是收紧信号）。
   */
  const revokedNotice = (req: IncomingMessage, path: string, raw: string): never | void => {
    const v = verifyDeviceRequest(req.headers, { method: req.method ?? "GET", path, body: raw }, {
      publicKeyFor: (tid, deviceId) => {
        const d = tenants.get(tid)?.devices.get(deviceId);
        return d && d.revoked_at ? d.cert.signPublicKeyPem : null;
      },
      now: now(),
      seenNonce,
    });
    if (!v.ok) return;
    const d = tenants.get(v.tid)!.devices.get(v.deviceId)!;
    const body: DeviceRevocationNotice = { tid: v.tid, device_id: v.deviceId, revoked_at: d.revoked_at! };
    throw new CpError(403, "device_revoked", "设备已吊销", { notice: seal("kwl-device-revoked", body) });
  };

  /** 设备签名请求核验 → 设备记录（未吊销）；已吊销设备得到签名的吊销通知。 */
  const authDevice = (req: IncomingMessage, path: string, raw: string): { t: TenantRecord; dev: DeviceRecord } => {
    const v = verifyDeviceRequest(req.headers, { method: req.method ?? "GET", path, body: raw }, { publicKeyFor: devicePub, now: now(), seenNonce });
    if (!v.ok) {
      if (v.reason === "device_unknown_or_revoked") revokedNotice(req, path, raw);
      // 时钟偏差：附控制面当前时间，客户端据此告警“本机时钟快 / 慢约几分钟”（复核 S6-B37）
      throw new CpError(401, v.reason, "设备签名无效、设备未登记或已吊销", v.reason === "device_auth_stale" ? { server_time: iso() } : undefined);
    }
    const t = tenantOf(v.tid);
    return { t, dev: t.devices.get(v.deviceId)! };
  };

  /** 服务间凭据（网关、检索服务；G0 共享密钥，生产为 mTLS）。 */
  const requireService = (req: IncomingMessage): void => {
    const h = req.headers.authorization;
    const tok = typeof h === "string" ? /^Bearer\s+(.+)$/i.exec(h)?.[1] ?? "" : "";
    const a = Buffer.from(tok);
    const b = Buffer.from(o.serviceSecret);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new CpError(401, "service_auth_invalid", "服务凭据无效");
  };

  /** 收紧类管理动作（吊销设备与席位）：管理员或合伙人设备（与本机吊销的角色口径一致；复核 S6-B04）。 */
  const requireRevoker = (dev: DeviceRecord): void => {
    if (dev.cert.role !== "admin" && dev.cert.role !== "partner") throw new CpError(403, "revoker_required", "需要管理员或合伙人设备");
  };

  const requireAdmin = (dev: DeviceRecord): void => {
    if (dev.cert.role !== "admin") throw new CpError(403, "admin_required", "需要管理员设备");
  };

  const adminCheck = (t: TenantRecord, bytes: Buffer, sigs: AdminSignature[], at: Date = new Date(now())) =>
    verifyAdminSignatures(bytes, sigs, {
      rootPublicKeyPem: t.root_public_key_pem ?? "",
      threshold: adminThresholdForEdition(t.edition),
      revokedDevices: new Set([...t.devices.values()].filter((d) => d.revoked_at).map((d) => d.cert.deviceId)),
      now: at,
    });

  const signingBytesOf = (d: DraftRecord): Buffer => (d.kind === "policy" ? policySigningBytes(d.doc as FirmPolicyDoc) : connectorSigningBytes(d.doc as FirmConnectorDoc));

  // 签发与到期取同一时刻（复核 S6-C01：两次取时钟跨过毫秒边界时有效期多 1 毫秒，客户端按“有效期超过 30 天”拒收）
  const directoryBody = (t: TenantRecord, iat = now()): DirectoryBody => ({
    tid: t.tid,
    version: t.directoryVersion,
    issued_at: iso(iat),
    expires_at: iso(iat + 30 * DAY_MS),
    devices: [...t.devices.values()].map((d) => d.cert),
    revoked_devices: [
      ...[...t.devices.values()].filter((d) => d.revoked_at).map((d) => ({ device_id: d.cert.deviceId, revoked_at: d.revoked_at! })),
      ...[...t.preRevoked].map(([device_id, r]) => ({ device_id, revoked_at: r.revoked_at })),
    ],
    revoked_seats: [...t.seatsByUser.values()].filter((s) => s.revoked_at).map((s) => s.sid),
  });

  const feedBody = (): GatewayFeedBody => {
    const revokedDevices: GatewayFeedBody["revoked_devices"] = [];
    const revokedSeats: string[] = [];
    const matters: GatewayFeedBody["matters"] = [];
    const policies: GatewayFeedBody["policies"] = [];
    for (const t of tenants.values()) {
      for (const d of t.devices.values()) if (d.revoked_at) revokedDevices.push({ tid: t.tid, device_id: d.cert.deviceId });
      for (const id of t.preRevoked.keys()) revokedDevices.push({ tid: t.tid, device_id: id });
      for (const s of t.seatsByUser.values()) if (s.revoked_at) revokedSeats.push(s.sid);
      for (const m of t.anon.values()) matters.push({ ...m, tid: t.tid });
      // 放宽类策略按当前吊销集重算管理员签名是否仍够门限（复核 S9B-07：与客户端 signers_insufficient 回退同一口径）
      const live = t.policy && Date.parse(t.policy.doc.expires_at) > now() ? t.policy : null;
      // 与客户端同一口径（复核 S9B-18）：证书按策略签发时刻核验（之后到期不影响已签的策略），只按吊销集重算
      const pol =
        live && (policyRelaxations(live.doc.body).length === 0 || adminCheck(t, policySigningBytes(live.doc), live.admin_signatures, new Date(Date.parse(live.doc.issued_at))).ok) ? live.doc.body : strictestTemplate();
      policies.push({
        tid: t.tid,
        l3a_standard_model: pol.l3a_standard_model,
        support_upload: pol.support_upload === "allow" ? "allow" : "deny",
        share_relay: pol.share_relay === "allow" ? "allow" : "deny",
      });
    }
    return { version: feedVersion, issued_at: iso(), revoked_devices: revokedDevices, revoked_seats: revokedSeats, matters, policies };
  };

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const path = req.url ?? "/";
    const url = new URL(path, "http://control-plane");
    const p = url.pathname;
    const raw = method === "GET" ? "" : await readBody(req);

    // ─── 开通：律所根公钥入组（G0：创始设备持根私钥签名证明；生产为开通流程） ───
    if (method === "POST" && p === "/v1/enroll") {
      const b = parseJson(raw);
      const t = tenantOf(String(b.tid ?? ""));
      const pem = String(b.root_public_key_pem ?? "");
      const proof = String(b.proof ?? "");
      const ts = Number(b.ts);
      if (!Number.isFinite(ts) || Math.abs(now() - ts) > 5 * 60_000) throw new CpError(400, "enroll_stale", "开通证明已过期");
      let good = false;
      try {
        good = cryptoVerify(null, enrollProofBytes(t.tid, pem, ts), pem, Buffer.from(proof, "base64url"));
      } catch {
        good = false;
      }
      if (!good) throw new CpError(400, "enroll_proof_invalid", "开通证明无效");
      if (t.root_public_key_pem && t.root_public_key_pem !== pem) throw new CpError(409, "root_already_enrolled", "该租户已登记另一把律所根公钥");
      // 要求开通码的租户（第 13 批）：首次登记根公钥须出示创始认领（开通码兑换所得），之后创始码即消费——知道租户编号不再能抢先登记
      if (t.activation_required && !t.root_public_key_pem) {
        const rec = claimOf(t, b.activation_id, b.claim_secret, "founder");
        rec.status = "consumed";
        rec.consumed_at = iso();
        rec.member.name = null;
      }
      t.root_public_key_pem = pem;
      auditCtx.set(res, { entry: { tid: t.tid, actor: { kind: "root", id: t.tid }, action: "tenant.enroll_root", target: null }, written: false });
      return send(res, 200, { ok: true, tid: t.tid });
    }

    // ─── 设备登记（证书须由已入组的律所根签发；持有证明 = 用证书公钥签本请求） ───
    if (method === "POST" && p === "/v1/devices/register") {
      const b = parseJson(raw);
      const cert = b.cert as DeviceCertificate | undefined;
      const tid = String(b.tid ?? "");
      const t = tenantOf(tid);
      if (!t.root_public_key_pem) throw new CpError(409, "root_not_enrolled", "租户尚未登记律所根公钥");
      if (!cert || typeof cert !== "object") throw new CpError(400, "cert_missing", "缺少设备证书");
      const cv = verifyDeviceCertificate(cert, t.root_public_key_pem, new Date(now()));
      if (!cv.ok) throw new CpError(400, "cert_invalid", "设备证书未由本所律所根签发或已过期");
      const v = verifyDeviceRequest(req.headers, { method, path, body: raw }, { publicKeyFor: (rt, rd) => (rt === tid && rd === cert.deviceId ? cert.signPublicKeyPem : null), now: now(), seenNonce });
      // 时钟偏差同样附控制面当前时间（复核 S6-C02：每次同步第一步就是登记）
      if (!v.ok) throw new CpError(401, v.reason, "登记请求的设备签名无效", v.reason === "device_auth_stale" ? { server_time: iso() } : undefined);
      auditCtx.set(res, { entry: { tid: t.tid, actor: { kind: "device", id: cert.deviceId, fp: certFingerprint(cert) }, action: "device.register", target: cert.deviceId }, written: false });
      const existing = t.devices.get(cert.deviceId);
      const revokedAt = existing?.revoked_at ?? t.preRevoked.get(cert.deviceId)?.revoked_at ?? null;
      if (revokedAt) {
        const body: DeviceRevocationNotice = { tid: t.tid, device_id: cert.deviceId, revoked_at: revokedAt };
        throw new CpError(403, "device_revoked", "设备已吊销", { notice: seal("kwl-device-revoked", body) });
      }
      const changed = !existing || existing.cert.signature !== cert.signature;
      if (changed) {
        t.devices.set(cert.deviceId, { cert, registered_at: iso(), revoked_at: null });
        t.directoryVersion += 1;
      }
      // 席位：成员没有席位且许可内仍有余量时自动分配（G0；生产由管理员在控制台分配）
      if (!t.seatsByUser.has(cert.memberId) && cert.role !== "node") {
        const active = [...t.seatsByUser.values()].filter((s) => !s.revoked_at).length;
        if (active < t.seats) {
          t.seatCounter += 1;
          const sid = `seat_${t.tid}_${t.seatCounter}`;
          t.seatsByUser.set(cert.memberId, { sid, uid: cert.memberId, assigned_at: iso(), revoked_at: null });
          // 席位分配单独记一条（复核 S9A-09），随本请求的主记录一并“先记、写盘失败补记已撤销”（复核 S9A-22）
          const seatEntry = { tid: t.tid, actor: { kind: "device" as const, id: cert.deviceId, fp: certFingerprint(cert) }, action: "seat.assign", target: sid };
          const ctx = auditCtx.get(res);
          if (ctx) ctx.extra = [...(ctx.extra ?? []), seatEntry];
        }
      }
      // 已登记、证书未变：每次同步都会来一次，登记本身不记；顺带分配了席位则只记席位分配
      if (!changed) {
        const ctx = auditCtx.get(res);
        const seatOnly = ctx?.extra?.[0];
        if (ctx && seatOnly) auditCtx.set(res, { entry: seatOnly, written: false });
        else auditCtx.delete(res);
      }
      return send(res, 200, { ok: true, directory_version: t.directoryVersion, seat: t.seatsByUser.get(cert.memberId)?.sid ?? null });
    }

    // ─── 开通码 / 邀请码兑换（第 13 批；未登记设备，凭码本身）：成功即返回律所与成员信息和一次性认领凭据 ───
    if (method === "POST" && p === "/v1/activation/redeem") {
      if (!redeemAllowed(String(req.socket.remoteAddress ?? "?"))) throw new CpError(429, "rate_limited", "尝试过于频繁，请稍后再试");
      const b = parseJson(raw);
      const code = normalizeActivationCode(b.code);
      const mac = code ? activationCodeMac(codePepper, code) : null;
      let hit: { t: TenantRecord; r: ActivationRecord } | null = null;
      if (mac) {
        for (const t of tenants.values()) {
          for (const r of t.activations.values()) if (sameHex(r.code_mac, mac)) hit = { t, r };
          if (hit) break;
        }
      }
      // 码不对、过期、作废、已用：同一句话（不区分，防枚举）
      if (!hit || !activationLive(hit.r)) throw new CpError(400, "code_invalid", "开通码不正确或已失效，请向发码人重新获取");
      const { t, r } = hit;
      if (!licenseValid(t)) throw new CpError(402, "license_expired", "律所订阅已到期，请联系中软开通");
      const secret = newClaimSecret();
      r.status = "claimed";
      r.claim_hash = claimSecretHash(secret);
      r.claimed_at = iso();
      auditCtx.set(res, { entry: { tid: t.tid, actor: { kind: "claimant", id: r.id }, action: "activation.redeem", target: r.id }, written: false });
      const body: ActivationRedeemResult = {
        ok: true,
        tid: t.tid,
        activation_id: r.id,
        kind: r.kind,
        firm: { slug: firmSlugOf(t.tid)!, name: t.name ?? t.tid },
        member: { slug: r.member.slug, name: r.member.name, role: r.member.role },
        claim_secret: secret,
        edition: t.edition,
      };
      return send(res, 200, body);
    }
    // ─── 成员入组申请（凭认领凭据 + 设备签名私钥的持有证明；只含公钥） ───
    if (method === "POST" && p === "/v1/join-requests") {
      const b = parseJson(raw);
      const t = tenantOf(String(b.tid ?? ""));
      const rec = claimOf(t, b.activation_id, b.claim_secret, "member");
      const deviceId = String(b.device_id ?? "");
      const signPub = String(b.sign_pub ?? "");
      const encPub = String(b.enc_pub ?? "");
      if (!DEVICE_ID_PATTERN.test(deviceId)) throw new CpError(400, "device_id_invalid", "设备编号不合法");
      if (signPub.length > 4096 || encPub.length > 4096 || !/BEGIN PUBLIC KEY/.test(signPub) || !/BEGIN PUBLIC KEY/.test(encPub)) throw new CpError(400, "public_key_invalid", "公钥格式不对");
      if (t.devices.has(deviceId) || t.preRevoked.has(deviceId)) throw new CpError(409, "device_exists", "该设备编号已登记或已吊销");
      const proofOk = verifyBytes(signPub, joinProofBytes({ tid: t.tid, activationId: rec.id, deviceId, signPublicKeyPem: signPub, encPublicKeyPem: encPub }), String(b.proof ?? ""));
      if (!proofOk) throw new CpError(400, "join_proof_invalid", "入组证明无效");
      const open = [...t.joinRequests.values()].find((x) => x.activation_id === rec.id && x.status === "pending");
      if (open) {
        // 同一台设备重发（网络中断后重试）：原样返回；换了设备或公钥：先等管理员处理前一个
        if (open.device_id === deviceId && open.sign_pub === signPub && open.enc_pub === encPub) return send(res, 200, { ok: true, join_request_id: open.id, status: open.status });
        throw new CpError(409, "join_pending", "已有一个等待批准的申请");
      }
      if (rec.join_attempts >= 3) throw new CpError(409, "join_attempts_exceeded", "申请次数已用完，请向管理员重新获取邀请码");
      if ([...t.joinRequests.values()].filter((x) => x.status === "pending").length >= 100) throw new CpError(409, "too_many_pending", "等待批准的申请过多");
      rec.join_attempts += 1;
      const jr: JoinRequestRecord = {
        id: newRecordId("jr"),
        activation_id: rec.id,
        member_slug: rec.member.slug,
        role: rec.member.role,
        device_id: deviceId,
        sign_pub: signPub,
        enc_pub: encPub,
        created_at: iso(),
        status: "pending",
        decided_at: null,
        decided_by: null,
        cert: null,
        firm_bundle: null,
      };
      t.joinRequests.set(jr.id, jr);
      auditCtx.set(res, { entry: { tid: t.tid, actor: { kind: "claimant", id: rec.id }, action: "join.request", target: jr.id }, written: false });
      return send(res, 200, { ok: true, join_request_id: jr.id, status: jr.status });
    }
    // 成员取回申请结果（凭认领凭据；批准后附证书与律所根公钥）
    const rjf = /^\/v1\/join-requests\/([A-Za-z0-9_-]{1,64})\/fetch$/.exec(p);
    if (method === "POST" && rjf) {
      const b = parseJson(raw);
      const t = tenantOf(String(b.tid ?? ""));
      const jr = t.joinRequests.get(rjf[1]!);
      if (!jr) throw new CpError(404, "join_unknown", "没有这个申请");
      const rec = t.activations.get(jr.activation_id);
      if (!rec || !rec.claim_hash || typeof b.claim_secret !== "string" || !sameHex(rec.claim_hash, claimSecretHash(b.claim_secret))) throw new CpError(403, "claim_invalid", "开通凭据无效");
      const expired = jr.status === "pending" && Date.parse(jr.created_at) + 7 * DAY_MS < now();
      const status = expired ? "rejected" : jr.status;
      return sendRaw(res, 200, { ok: true, status, ...(status === "approved" ? { cert: jr.cert, root_public_key_pem: t.root_public_key_pem, firm_bundle: jr.firm_bundle } : {}) });
    }

    // ─── 网关与检索服务订阅（服务间凭据） ───
    if (method === "GET" && p === "/v1/feed/gateway") {
      requireService(req);
      return send(res, 200, seal("kwl-gateway-feed", feedBody()));
    }
    // ─── 额度租约（S3 v0）：网关领取一段点数、本地扣减、按租约回报累计用量（服务间凭据） ───
    if (method === "POST" && p === "/v1/quota/lease") {
      requireService(req);
      const b = parseJson(raw);
      const t = tenantOf(String(b.tid ?? ""));
      // 许可到期或已终止：不再发放（与席位令牌同一口径）
      if (!licenseValid(t)) throw new CpError(402, "license_expired", "许可已到期：不发放额度");
      const l = leaseQuota(t.quota, { want: b.want, holder: b.holder, ttl_ms: b.ttl_ms, need: b.need }, now());
      return send(res, 200, { lease_id: l.lease_id, points: l.points, expires_at: l.expires_at, limited_by: l.limited_by });
    }
    if (method === "POST" && p === "/v1/quota/settle") {
      requireService(req);
      const b = parseJson(raw);
      const t = tenantOf(String(b.tid ?? ""));
      const r = settleLease(t.quota, { lease_id: b.lease_id, holder: b.holder, usage: b.usage, final: b.final }, now());
      return send(res, 200, { ok: true, ...r });
    }

    // 以下一律设备签名
    const { t, dev } = authDevice(req, path, raw);
    const mark = (action: string, target: string | null = null) =>
      auditCtx.set(res, { entry: { tid: t.tid, actor: { kind: "device", id: dev.cert.deviceId, fp: certFingerprint(dev.cert) }, action, target }, written: false });

    if (method === "GET" && p === "/v1/directory") return send(res, 200, seal("kwl-device-directory", directoryBody(t)));
    if (method === "GET" && p === "/v1/license") return send(res, 200, seal("kwl-license", issueLicense(t)));
    if (method === "GET" && p === "/v1/tenant-salt") {
      const body: TenantSaltBody = { tid: t.tid, purpose: "anon_matter", salt_b64: t.salt_b64, issued_at: t.created_at };
      return send(res, 200, seal("kwl-tenant-salt", body));
    }
    if (method === "POST" && p === "/v1/seat-token") {
      mark("seat_token.issue", t.seatsByUser.get(dev.cert.memberId)?.sid ?? null);
      if (!issueAllowed(t.tid, dev.cert.deviceId, "seat_token")) throw new CpError(429, "rate_limited", "签发过于频繁，请稍后再试");
      if (!licenseValid(t)) throw new CpError(402, "license_expired", "许可已到期：不签发席位令牌");
      const seat = t.seatsByUser.get(dev.cert.memberId);
      if (!seat) throw new CpError(402, "no_seat", "该成员没有席位");
      if (seat.revoked_at) throw new CpError(403, "seat_revoked", "席位已吊销");
      // 签发时刻与回复里的到期时刻由同一时刻推出（云端持久化与 KMS 设计 v1 F-3）
      const at = now();
      const token = issueSeatToken({ tid: t.tid, uid: dev.cert.memberId, sid: seat.sid, dev: dev.cert.deviceId, kid: o.keys.seat.kid }, o.keys.seat.privateKey, seatTtl, at);
      return send(res, 200, { token, expires_at: iso(at + seatTtl * 1000) });
    }
    // 支持服务专用的短期凭据（第 9 批复核 S9B-03）：受众只有 "support"、15 分钟；网关、检索、分发拒收——诊断包上传不再把通用席位令牌交给支持域
    if (method === "POST" && p === "/v1/support-token") {
      mark("support_token.issue", t.seatsByUser.get(dev.cert.memberId)?.sid ?? null);
      if (!issueAllowed(t.tid, dev.cert.deviceId, "support_token")) throw new CpError(429, "rate_limited", "签发过于频繁，请稍后再试");
      if (!licenseValid(t)) throw new CpError(402, "license_expired", "许可已到期：不签发");
      const seat = t.seatsByUser.get(dev.cert.memberId);
      if (!seat) throw new CpError(402, "no_seat", "该成员没有席位");
      if (seat.revoked_at) throw new CpError(403, "seat_revoked", "席位已吊销");
      const at = now();
      const token = issueSeatToken({ tid: t.tid, uid: dev.cert.memberId, sid: seat.sid, dev: dev.cert.deviceId, kid: o.keys.seat.kid, aud: ["support"] }, o.keys.seat.privateKey, SUPPORT_TOKEN_TTL_SECONDS, at);
      return send(res, 200, { token, expires_at: iso(at + SUPPORT_TOKEN_TTL_SECONDS * 1000) });
    }
    // 通知服务专用凭据（第 10 批 S9）：受众只有 "notify"；网关、检索、分发、支持服务都拒收——期限提醒的密文与投递不用通用席位令牌
    if (method === "POST" && p === "/v1/notify-token") {
      mark("notify_token.issue", t.seatsByUser.get(dev.cert.memberId)?.sid ?? null);
      if (!issueAllowed(t.tid, dev.cert.deviceId, "notify_token")) throw new CpError(429, "rate_limited", "签发过于频繁，请稍后再试");
      if (!licenseValid(t)) throw new CpError(402, "license_expired", "许可已到期：不签发");
      const seat = t.seatsByUser.get(dev.cert.memberId);
      if (!seat) throw new CpError(402, "no_seat", "该成员没有席位");
      if (seat.revoked_at) throw new CpError(403, "seat_revoked", "席位已吊销");
      const at = now();
      const token = issueSeatToken({ tid: t.tid, uid: dev.cert.memberId, sid: seat.sid, dev: dev.cert.deviceId, kid: o.keys.seat.kid, aud: ["notify"] }, o.keys.seat.privateKey, NOTIFY_TOKEN_TTL_SECONDS, at);
      return send(res, 200, { token, expires_at: iso(at + NOTIFY_TOKEN_TTL_SECONDS * 1000) });
    }
    // 共享中继专用凭据（第 11 批 S11）：受众只有 "relay"；网关、检索、分发、支持、通知服务都拒收——团队事项的密文同步不用通用席位令牌。
    // 是否允许按律所策略由中继服务核对（订阅里的 share_relay）；这里只看席位与许可
    if (method === "POST" && p === "/v1/relay-token") {
      mark("relay_token.issue", t.seatsByUser.get(dev.cert.memberId)?.sid ?? null);
      if (!issueAllowed(t.tid, dev.cert.deviceId, "relay_token")) throw new CpError(429, "rate_limited", "签发过于频繁，请稍后再试");
      if (!licenseValid(t)) throw new CpError(402, "license_expired", "许可已到期：不签发");
      const seat = t.seatsByUser.get(dev.cert.memberId);
      if (!seat) throw new CpError(402, "no_seat", "该成员没有席位");
      if (seat.revoked_at) throw new CpError(403, "seat_revoked", "席位已吊销");
      const at = now();
      const token = issueSeatToken({ tid: t.tid, uid: dev.cert.memberId, sid: seat.sid, dev: dev.cert.deviceId, kid: o.keys.seat.kid, aud: ["relay"] }, o.keys.seat.privateKey, RELAY_TOKEN_TTL_SECONDS, at);
      return send(res, 200, { token, expires_at: iso(at + RELAY_TOKEN_TTL_SECONDS * 1000) });
    }
    if (method === "GET" && p === "/v1/policy") return send(res, 200, seal("kwl-firm-policy-current", t.policy));
    // ─── 本所用量与上限（S3 v0）：成员看本所本月用量、上限与自己的用量；管理员与合伙人另看按成员明细与池余额 ───
    if (method === "GET" && p === "/v1/quota") {
      const detail = dev.cert.role === "admin" || dev.cert.role === "partner";
      const owner = new Map([...t.seatsByUser.values()].map((x) => [x.sid, x.uid]));
      const view = quotaView(t.quota, now(), { detail, seatOwner: (sid) => owner.get(sid) ?? null, ownSid: t.seatsByUser.get(dev.cert.memberId)?.sid ?? null });
      return send(res, 200, seal("kwl-quota-view", { tid: t.tid, issued_at: iso(), ...view }));
    }
    if (method === "PUT" && p === "/v1/quota/cap") {
      mark("quota.cap_set");
      requireAdmin(dev);
      const b = parseJson(raw);
      if (!("monthly_cap" in b)) throw new CpError(400, "cap_invalid", "缺少月度上限（不设上限请传 null）");
      quotaSetCap(t.quota, b.monthly_cap, now(), dev.cert.deviceId);
      const ctx = auditCtx.get(res);
      if (ctx) ctx.entry.detail = t.quota.cap_monthly === null ? { uncapped: 1 } : { cap: t.quota.cap_monthly };
      return send(res, 200, { ok: true, cap_monthly: t.quota.cap_monthly });
    }
    // ─── 中软侧操作记录（S14 v0）：管理员与合伙人可取本所流水（控制面签名的分页；律所侧另行验链） ───
    if (method === "GET" && p === "/v1/audit") {
      requireRevoker(dev);
      const after = Number(url.searchParams.get("after") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "500");
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new CpError(400, "audit_range_invalid", "分页参数不合法");
      const page: CpAuditPage = { tid: t.tid, records: auditLog.list(t.tid, after, limit), head: auditLog.head(t.tid), issued_at: iso() };
      return send(res, 200, seal("kwl-cp-audit-page", page));
    }
    if (method === "GET" && p === "/v1/connectors") {
      return send(res, 200, seal("kwl-firm-connectors", { tid: t.tid, version: t.connectorsVersion, issued_at: iso(), entries: [...t.connectors.values()] }));
    }
    if (method === "PUT" && p.startsWith("/v1/anon-matters/")) {
      const anon = decodeURIComponent(p.slice("/v1/anon-matters/".length));
      mark("anon_summary.update", /^[A-Za-z0-9_-]{1,64}$/.test(anon) ? anon : null);
      const s = validateSummary(parseJson(raw));
      if (!s.ok) throw new CpError(400, s.reason, "事项匿名摘要不合法");
      if (s.value.anon !== anon) throw new CpError(400, "summary_anon_mismatch", "匿名编号与路径不符");
      // 版本更高的才替换；同一版本按更严合并（信息落后的设备不能把摘要改回较宽——复核 S6-A07）
      const prev = t.anon.get(anon);
      const next = !prev || s.value.version > prev.version ? s.value : s.value.version === prev.version ? stricterSummary(prev, s.value) : prev;
      if (!prev || canonicalJson(prev) !== canonicalJson(next)) {
        t.anon.set(anon, next);
        feedVersion += 1;
      } else auditCtx.delete(res); // 摘要没有变化：不记
      return send(res, 200, { ok: true });
    }

    // ─── 起草 → 管理员设备签名 → 发布（律所策略、连接器登记） ───
    if (method === "GET" && p === "/v1/drafts") {
      requireAdmin(dev);
      return send(res, 200, { drafts: [...t.drafts.values()].filter((d) => !d.published_at) });
    }
    if (method === "POST" && p === "/v1/drafts") {
      const draftId = `drf_${randomBytes(8).toString("hex")}`;
      mark("draft.create", draftId);
      requireAdmin(dev);
      const b = parseJson(raw);
      if (b.kind === "policy") {
        const body = validatePolicyBody(b.body);
        if (!body.ok) throw new CpError(400, body.reason, "策略内容不合法");
        const days = Math.min(30, Math.max(1, Math.floor(Number(b.ttl_days ?? 30)) || 30));
        const iat = now();
        // 版本 = 当前已发布版本 + 1（草稿不占版本号：未发布的草稿再多，发布出去的版本也只比上一版大一——复核 S6-B29）
        const doc: FirmPolicyDoc = { kind: "kwl-firm-policy", v: 1, tid: t.tid, version: (t.policy?.doc.version ?? 0) + 1, issued_at: iso(iat), expires_at: iso(iat + days * DAY_MS), body: body.value };
        const d: DraftRecord = { draft_id: draftId, kind: "policy", doc, admin_signatures: [], created_by: dev.cert.deviceId, created_at: iso(), published_at: null };
        t.drafts.set(draftId, d);
        return send(res, 200, { draft: d, relaxations: policyRelaxations(doc.body) });
      }
      if (b.kind === "connector") {
        const c = (b.connector ?? {}) as Record<string, unknown>;
        const id = String(c.connector_id ?? "");
        // 版本 = 该连接器已发布过的最高版本 + 1（撤下后重新登记也不回退；草稿不占版本号——复核 S6-B29）
        const prior = Math.max(
          t.connectors.get(id)?.doc.version ?? 0,
          ...[...t.drafts.values()].filter((x) => x.kind === "connector" && x.published_at && (x.doc as FirmConnectorDoc).connector_id === id).map((x) => (x.doc as FirmConnectorDoc).version),
        );
        const doc = { kind: "kwl-firm-connector", v: 1, tid: t.tid, connector_id: id, version: prior + 1, name: c.name, server: c.server, url: c.url, max_data_level: c.max_data_level, tools: c.tools, registered_at: iso() };
        const check = validateConnectorDoc(doc);
        if (!check.ok) throw new CpError(400, check.reason, "连接器登记不合法");
        const d: DraftRecord = { draft_id: draftId, kind: "connector", doc: check.value, admin_signatures: [], created_by: dev.cert.deviceId, created_at: iso(), published_at: null };
        t.drafts.set(draftId, d);
        return send(res, 200, { draft: d });
      }
      throw new CpError(400, "draft_kind_invalid", "只支持律所策略与连接器登记");
    }
    const m = /^\/v1\/drafts\/(drf_[0-9a-f]{16})(\/signatures|\/publish)?$/.exec(p);
    if (m) {
      if (method === "POST" && m[2]) mark(m[2] === "/signatures" ? "draft.sign" : "draft.publish", m[1]!);
      const d = t.drafts.get(m[1]!);
      if (!d) throw new CpError(404, "draft_unknown", "草稿不存在");
      requireAdmin(dev);
      if (method === "GET" && !m[2]) return send(res, 200, { draft: d });
      if (d.published_at) throw new CpError(409, "draft_published", "草稿已发布");
      const bytes = signingBytesOf(d);
      if (method === "POST" && m[2] === "/signatures") {
        const b = parseJson(raw);
        const sig = { cert: b.cert as DeviceCertificate, sig: String(b.sig ?? "") };
        const v = adminCheck(t, bytes, [sig]);
        if (v.devices.length !== 1) throw new CpError(400, "admin_signature_invalid", `管理员签名无效：${v.problems.join("、")}`);
        if (!d.admin_signatures.some((s) => s.cert.deviceId === sig.cert.deviceId)) d.admin_signatures.push(sig);
        return send(res, 200, { draft: d });
      }
      if (method === "POST" && m[2] === "/publish") {
        if (d.kind === "policy") {
          const doc = d.doc as FirmPolicyDoc;
          if (policyRelaxations(doc.body).length > 0 && !adminCheck(t, bytes, d.admin_signatures).ok) {
            throw new CpError(409, "admin_threshold_not_met", `放宽类策略需 ${adminThresholdForEdition(t.edition)} 名管理员设备签名`);
          }
          if (t.policy && t.policy.doc.version >= doc.version) throw new CpError(409, "draft_stale", "已有同版本或更高版本的策略发布：本草稿已过时，请重新起草");
          t.policy = { doc, admin_signatures: d.admin_signatures };
          // 同号及更早的未发布草稿作废（复核 S6-C11：否则已签名的过时草稿可被投给尚未接受同号版本的设备，造成同号异文）
          for (const [id, x] of t.drafts) if (id !== d.draft_id && !x.published_at && x.kind === "policy" && (x.doc as FirmPolicyDoc).version <= doc.version) t.drafts.delete(id);
        } else {
          const doc = d.doc as FirmConnectorDoc;
          if (!adminCheck(t, bytes, d.admin_signatures).ok) throw new CpError(409, "admin_threshold_not_met", `连接器登记需 ${adminThresholdForEdition(t.edition)} 名管理员设备签名`);
          const cur = t.connectors.get(doc.connector_id);
          const published = Math.max(cur?.doc.version ?? 0, ...[...t.drafts.values()].filter((x) => x.kind === "connector" && x.published_at && (x.doc as FirmConnectorDoc).connector_id === doc.connector_id).map((x) => (x.doc as FirmConnectorDoc).version));
          if (published >= doc.version) throw new CpError(409, "draft_stale", "该连接器已有同版本或更高版本的登记发布：本草稿已过时，请重新起草");
          t.connectors.set(doc.connector_id, { doc, admin_signatures: d.admin_signatures });
          for (const [id, x] of t.drafts) {
            if (id !== d.draft_id && !x.published_at && x.kind === "connector" && (x.doc as FirmConnectorDoc).connector_id === doc.connector_id && (x.doc as FirmConnectorDoc).version <= doc.version) t.drafts.delete(id);
          }
          t.connectorsVersion += 1;
        }
        d.published_at = iso();
        feedVersion += 1;
        return send(res, 200, { ok: true, draft: d });
      }
    }
    // 撤下连接器（收紧：管理员设备即可）
    const rc = /^\/v1\/connectors\/([a-z][a-z0-9_-]{1,40})$/.exec(p);
    if (method === "DELETE" && rc) {
      mark("connector.remove", rc[1]!);
      requireAdmin(dev);
      if (t.connectors.delete(rc[1]!)) t.connectorsVersion += 1;
      return send(res, 200, { ok: true, version: t.connectorsVersion });
    }
    // ─── 成员邀请与入组批准（第 13 批；管理员设备） ───
    if (method === "POST" && p === "/v1/invitations") {
      mark("invitation.create");
      requireAdmin(dev);
      const b = parseJson(raw);
      const role = String(b.role ?? "lawyer");
      if (role !== "lawyer" && role !== "partner" && role !== "assistant" && role !== "admin") throw new CpError(400, "role_invalid", "角色不合法");
      const ttl = Number(b.ttl_hours ?? 72);
      const r = issueCode(t, { kind: "member", member: { slug: String(b.member_slug ?? ""), name: b.name == null ? null : String(b.name), role }, ttlHours: Number.isFinite(ttl) ? Math.min(ttl, 7 * 24) : 72, by: dev.cert.deviceId });
      auditCtx.set(res, { entry: { tid: t.tid, actor: { kind: "device", id: dev.cert.deviceId, fp: certFingerprint(dev.cert) }, action: "invitation.create", target: r.activation_id }, written: false });
      return send(res, 200, { ok: true, ...r });
    }
    if (method === "GET" && p === "/v1/invitations") {
      requireAdmin(dev);
      const list = [...t.activations.values()]
        .filter((r) => r.kind === "member")
        .map((r) => ({
          activation_id: r.id,
          member: r.member,
          status: r.status !== "consumed" && r.status !== "revoked" && Date.parse(r.expires_at) <= now() && r.status === "open" ? "expired" : r.status,
          created_at: r.created_at,
          expires_at: r.expires_at,
          claimed_at: r.claimed_at,
          consumed_at: r.consumed_at,
        }));
      return sendRaw(res, 200, { ok: true, invitations: list });
    }
    const rir = /^\/v1\/invitations\/([A-Za-z0-9_-]{1,64})\/revoke$/.exec(p);
    if (method === "POST" && rir) {
      mark("invitation.revoke", rir[1]!);
      requireAdmin(dev);
      const r = t.activations.get(rir[1]!);
      if (!r || r.kind !== "member") throw new CpError(404, "activation_unknown", "没有这个邀请");
      viaRoute(() => ops.revokeActivationCode(t.tid, r.id));
      return send(res, 200, { ok: true });
    }
    if (method === "GET" && p === "/v1/join-requests") {
      requireAdmin(dev);
      const list = [...t.joinRequests.values()]
        .filter((x) => x.status === "pending" && Date.parse(x.created_at) + 7 * DAY_MS > now())
        .map((x) => ({ id: x.id, activation_id: x.activation_id, member_slug: x.member_slug, role: x.role, device_id: x.device_id, sign_pub: x.sign_pub, enc_pub: x.enc_pub, created_at: x.created_at }));
      return sendRaw(res, 200, { ok: true, join_requests: list });
    }
    const rja = /^\/v1\/join-requests\/([A-Za-z0-9_-]{1,64})\/(approve|reject)$/.exec(p);
    if (method === "POST" && rja) {
      const approve = rja[2] === "approve";
      mark(approve ? "join.approve" : "join.reject", rja[1]!);
      requireAdmin(dev);
      const jr = t.joinRequests.get(rja[1]!);
      if (!jr || jr.status !== "pending" || Date.parse(jr.created_at) + 7 * DAY_MS <= now()) throw new CpError(404, "join_unknown", "没有这个待批准的申请");
      const rec = t.activations.get(jr.activation_id);
      if (!rec || rec.status !== "claimed") throw new CpError(409, "activation_not_claimed", "该邀请已作废或已使用");
      if (approve) {
        const b = parseJson(raw);
        const cert = b.cert as DeviceCertificate | undefined;
        if (!cert || typeof cert !== "object" || !t.root_public_key_pem) throw new CpError(400, "cert_missing", "缺少设备证书");
        const cv = verifyDeviceCertificate(cert, t.root_public_key_pem, new Date(now()));
        // 证书须由本所律所根签发，且与申请里的设备、两把公钥、邀请的成员与角色逐项一致（控制面不能替管理员改任何一项）
        const firmSlug = firmSlugOf(t.tid);
        const same =
          cert.deviceId === jr.device_id &&
          cert.signPublicKeyPem === jr.sign_pub &&
          cert.encPublicKeyPem === jr.enc_pub &&
          cert.memberId === `usr_${firmSlug}_${jr.member_slug}` &&
          cert.role === jr.role;
        if (!cv.ok || !same) throw new CpError(400, "cert_mismatch", "设备证书与申请不一致或不是本所律所根签发");
        const fb = b.firm_bundle as FirmBundle | undefined;
        const fbOk =
          !!fb &&
          typeof fb.recovery_public_key_pem === "string" &&
          fb.recovery_public_key_pem.length <= 4096 &&
          typeof fb.sig === "string" &&
          verifyBytes(t.root_public_key_pem, firmBundleBytes(t.tid, t.root_public_key_pem, fb.recovery_public_key_pem), fb.sig);
        if (!fbOk) throw new CpError(400, "firm_bundle_invalid", "律所公钥包缺失或签名无效");
        Object.assign(jr, { status: "approved", decided_at: iso(), decided_by: dev.cert.deviceId, cert, firm_bundle: { recovery_public_key_pem: fb!.recovery_public_key_pem, sig: fb!.sig } });
        rec.status = "consumed";
        rec.consumed_at = iso();
        rec.member.name = null;
      } else {
        Object.assign(jr, { status: "rejected", decided_at: iso(), decided_by: dev.cert.deviceId });
      }
      return send(res, 200, { ok: true, status: jr.status });
    }
    // 吊销（收紧：管理员或合伙人设备即可）；尚未登记的设备编号记预先吊销（复核 S6-B31）
    const rd = /^\/v1\/devices\/([^/]{1,200})\/revoke$/.exec(p);
    if (method === "POST" && rd) {
      mark("device.revoke", rd[1]!);
      requireRevoker(dev);
      const b = parseJson(raw);
      // 本请求的审计由路由记（运维包装不再记一条“运营吊销”）；仍经 ops 调用（演练可替换 ops 模拟被攻破的控制面）
      viaRoute(() => ops.revokeDevice(t.tid, rd[1]!, { cert: b.cert, by: dev.cert.deviceId }));
      return send(res, 200, { ok: true, directory_version: t.directoryVersion });
    }
    const rs = /^\/v1\/seats\/([^/]{1,200})\/revoke$/.exec(p);
    if (method === "POST" && rs) {
      mark("seat.revoke", t.seatsByUser.get(decodeURIComponent(rs[1]!))?.sid ?? null);
      requireRevoker(dev);
      if (!t.seatsByUser.has(decodeURIComponent(rs[1]!))) throw new CpError(404, "seat_unknown", "成员没有席位");
      viaRoute(() => ops.revokeSeat(t.tid, decodeURIComponent(rs[1]!)));
      return send(res, 200, { ok: true, directory_version: t.directoryVersion });
    }
    throw new CpError(404, "not_found", "没有这条路由");
  }

  const server = createServer((req, res) => {
    route(req, res).catch((e: unknown) => {
      // 出错的请求不留下任何状态改动（已改的内存回滚到上次写成的样子）；错误应答不再触发写盘
      try {
        rollback();
      } catch {
        // 回滚失败不影响应答
      }
      const ce = e instanceof CpError ? e : e instanceof QuotaError ? new CpError(e.status, e.code, e.message) : new CpError(500, "control_plane_error", "控制面错误");
      const ctx = auditCtx.get(res);
      if (ctx && (ctx.written || rejectedAllowed(ctx.entry))) {
        try {
          if (ctx.written) for (const x of ctx.extra ?? []) auditLog.append({ ...x, result: `rolled_back:${ce.code}` }, iso());
          auditLog.append({ ...ctx.entry, result: `${ctx.written ? "rolled_back" : "rejected"}:${ce.code}` }, iso());
        } catch {
          // 审计写不进去：本请求本来就失败了
        }
      }
      if (res.headersSent) res.destroy();
      else sendRaw(res, ce.status, { error: { code: ce.code, message: ce.message }, ...(ce.extra ?? {}) });
    });
  });

  // 正常关闭：停定时写入，把未落盘的 nonce 一并写下
  server.on("close", () => {
    if (nonceFlush) clearInterval(nonceFlush);
    if (!o.auditLog) auditLog.close();
    try {
      persistNow(true);
    } catch {
      // 关闭时写盘失败：下次启动读回上次写成的状态
    }
  });

  const pem = (k: KeyObject) => k.export({ format: "pem", type: "spki" }).toString();
  return {
    server,
    ops,
    publicKeys: { envelope: { [o.keys.envelope.kid]: pem(o.keys.envelope.publicKey) }, seat: { [o.keys.seat.kid]: pem(o.keys.seat.publicKey) } },
  };
}

/** 测试与运维：设备证书指纹（日志里只记指纹，不记公钥全文）。 */
export function certFingerprint(cert: Pick<DeviceCertificate, "signPublicKeyPem">): string {
  return createHash("sha256").update(cert.signPublicKeyPem).digest("base64url").slice(0, 16);
}
