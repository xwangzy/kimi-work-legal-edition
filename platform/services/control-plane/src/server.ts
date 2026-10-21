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
 * 运营接口（v9.3 A-10，`/v1/ops/…`）：按人运营签名（`@zr-legal/ops-auth`：安全管理员签名的运营名册 + 每人自己的签名密钥），
 * 只开最小集——开通租户（一律要求开通码）、发与作废开通码、续订、终止、加量、代设上限、吊销设备与席位、租户概要；
 * 写操作照常进律所可见的运营审计流水，执行者为**运营编号**（不再是笼统的 "ops"）；每个运营请求另记内部访问审计。
 */
import { createHash, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, timingSafeEqual, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { StateStore } from "./state-store.ts";
import { createAuditLog, type AuditEntry, type AuditLog } from "./audit-log.ts";
import { emptyQuota, grantPoints as quotaGrant, leaseQuota, QuotaError, quotaView, setCap as quotaSetCap, settleLease, type QuotaState } from "./quota.ts";
import { canonicalJson, verifyBytes, verifyDeviceCertificate, DEVICE_ID_PATTERN, type DeviceCertificate } from "@zr-legal/keys";
import { OpsAuthError, type OpsAuthorized, type OpsGuard, type OpsPermission } from "@zr-legal/ops-auth";
import { MIN_SEAT_TTL_SECONDS } from "@zr-legal/seat-token";
import { localSigner, SignerUnavailableError, type ControlPlaneKeys, type CpSigner, type EnvelopeKind, type SeatAudience } from "./signer.ts";
import {
  activationCodeMac,
  claimSecretHash,
  expectedJoinDeviceId,
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

export type { ControlPlaneKeys, CpKeyPair } from "./signer.ts";

/**
 * 开发与测试用：生成控制面的密钥（生产在签名服务 cp-signer，公钥随客户端与网关构建固定）。
 * `audiences: true` 另为支持、通知、中继各生成一把受众席位密钥（A-8 按受众拆分）。
 */
export function devControlPlaneKeys(o: { audiences?: boolean } = {}): ControlPlaneKeys {
  const e = generateKeyPairSync("ed25519");
  const s = generateKeyPairSync("ed25519");
  const keys: ControlPlaneKeys = { envelope: { kid: "cp-dev1", ...e }, seat: { kid: "seat-dev1", ...s } };
  if (o.audiences) keys.seatAudiences = { support: { kid: "seat-support-dev1", ...generateKeyPairSync("ed25519") }, notify: { kid: "seat-notify-dev1", ...generateKeyPairSync("ed25519") }, relay: { kid: "seat-relay-dev1", ...generateKeyPairSync("ed25519") } };
  return keys;
}

export interface DeviceRecord {
  cert: DeviceCertificate;
  registered_at: string;
  revoked_at: string | null;
  /** 客户端版本（v9.3 P3 版本分布统计；随签名的登记请求上报）与最近一次报到的日期（只到日，避免每次同步都改写状态）。 */
  client_version?: string;
  client_seen_on?: string;
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
  /** 发码者：运营（经运营接口为运营编号 op_…；进程内调用为 "ops"）或管理员设备编号。 */
  created_by: string;
  status: "open" | "claimed" | "consumed" | "revoked";
  claim_hash: string | null;
  claimed_at: string | null;
  consumed_at: string | null;
  /** 同一认领提交入组申请的次数（被拒后可重提，至多 3 次）。 */
  join_attempts: number;
  /** 首次兑换时刻与兑换次数（复核 A-04：只在首次兑换后 10 分钟内、尚未提交申请或登记根之前可再兑换，覆盖“应答丢失重试”）。 */
  first_claimed_at?: string | null;
  redeem_count?: number;
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
  status: "pending" | "approved" | "rejected" | "withdrawn";
  decided_at: string | null;
  decided_by: string | null;
  cert: DeviceCertificate | null;
  /** 律所公钥包（恢复托管公钥 + 律所根签名），批准时随证书一并存，成员取回。 */
  firm_bundle: FirmBundle | null;
  /** 成员机用邀请码本机秘密段对申请做的 HMAC（复核 A-01/02：控制面不知秘密，改不了申请）；管理员机核对。 */
  mac?: string;
  /** 管理员机用同一秘密对批准结果做的 HMAC（复核 A-03：成员机据此认律所根与证书，不再首次信任）。 */
  admin_mac?: string | null;
}

export interface TenantRecord {
  tid: string;
  /** 律所显示名（开通时运营填写；缺省为租户编号）。 */
  name?: string;
  /** 开通须出示创始开通码（第 13 批：关闭“知道租户编号即可抢先登记律所根”）；新建缺省 true（复核 A-05），第 13 批之前保存的状态读回为 false。 */
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
  /** 进程内签名密钥（开发、测试、单机试点）；与 signer 二选一。 */
  keys?: ControlPlaneKeys;
  /** 签名者（v9.3 A-8）：生产入口为独立签名服务的 mTLS 客户端（connectRemoteSigner），控制面进程不持私钥。 */
  signer?: CpSigner;
  /** 网关与检索服务订阅凭据（G0：共享密钥；生产为 mTLS）。 */
  serviceSecret: string;
  /** 席位令牌有效期（秒；不低于 72 小时）。 */
  seatTtlSeconds?: number;
  now?: () => number;
  maxBodyBytes?: number;
  /** 每租户预先吊销的设备数上限（缺省 1000；用例可调小）。 */
  maxPreRevoked?: number;
  /** 状态持久化（state-store.ts 文件两代交替；pg-state-store.ts PostgreSQL 一主多备）：未给出 = 只在内存（开发与测试）。 */
  stateStore?: StateStore;
  /**
   * 防重放随机数的外部副本（v9.3 A-7，nonce-mirror.ts 存 Redis）：seen 查打开时读回的随机数（换主实例不丢最近的随机数）；
   * 每见到一个新随机数即 record（异步，失败只计数，降级为状态快照里的随机数）。
   */
  nonceMirror?: { seen?(key: string): boolean; record(key: string, exp: number): void };
  /** 运营审计流水（S14 v0，audit-log.ts）：未给出 = 只在内存。 */
  auditLog?: AuditLog;
  /**
   * 开通码 HMAC 的胡椒（32 字节；生产由 KMS 下发，与签名密钥分开）。未给出 = 由信封签名私钥 HKDF 派生（开发与试点形态：
   * 重启后不变，码记录仍可核对）。
   */
  codePepper?: Uint8Array;
  /** 运营按人鉴权（v9.3 A-10）：没有 = 运营接口不开放（`/v1/ops/…` 一律 404）；运维操作只能由进程内代码调用（开发与测试）。 */
  opsGuard?: OpsGuard;
  /** 运营访问审计（每个通过鉴权的运营请求：先记“已请求”、记不进去即不执行，执行后补记结果）；缺省不记（开发与测试）。 */
  opsAccessLog?: (r: CpOpsAccessRecord) => void;
}

/** 控制面运营访问审计（中软内部，不进律所可见的流水）：只有运营编号、密钥编号、动作、租户与目标编号、结果。 */
export interface CpOpsAccessRecord {
  at: string;
  action: string;
  operator: string;
  op_key: string;
  /** 授权所依据的运营名册版本（复核 RA10A-07）。 */
  roster_version: number;
  tid: string | null;
  target: string | null;
  /** requested（执行前）/ ok / rejected:<代码>。 */
  result: string;
}

export interface ControlPlaneOps {
  /** 商务开通：建租户、发许可（≤ 30 天）、生成租户盐、发布最严模板策略 v1（不比最严模板宽：只需控制面签名）。 */
  createTenant(o: { tid: string; edition: LicenseBody["edition"]; seats: number; subscriptionDays?: number; points?: number; name?: string; activationRequired?: boolean }): TenantRecord;
  /** 发创始开通码（交律所管理员）：返回码明文（只此一次）；云端只存 HMAC。 */
  issueActivationCode(tid: string, o: { member: { slug: string; name?: string }; ttlHours?: number }): { code: string; activation_id: string; expires_at: string };
  /** 作废尚未消费的开通码 / 邀请码；by 为作废者（管理员设备编号；缺省为当前运维执行者）。 */
  revokeActivationCode(tid: string, activationId: string, o?: { by?: string }): void;
  /**
   * 开通记录清理（复核 A-16；控制面每小时自动执行）：成员显示名只用于兑换时回显——已过期、已作废、已消费或已提交入组申请的码清空姓名；
   * 已结束（消费、作废、过期）超过 31 天、且没有待批准申请的码记录连同入组申请记录删除（批准后 30 天内仍可凭认领凭据取回证书）。
   */
  sweepOnboarding(): { names_cleared: number; records_removed: number };
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
  /**
   * 用控制面自己的信封密钥签任意文档（演练“控制面被攻破”时攻击者同样能做到）。只有进程内签名者有：
   * 接独立签名服务（生产入口）时抛错——签名服务只签登记过的种类与合格的文档（A-8）。
   */
  seal<T>(kind: string, body: T): CpEnvelope<T>;
  /** 网关订阅版本递增（直接改了存储之后调用）。 */
  touch(): void;
}

export interface ControlPlane {
  server: Server;
  ops: ControlPlaneOps;
  /** 服务内部指标（额度租约按结果计数；客户端版本分布）。 */
  metrics(): { quota: Record<string, number>; client_versions: Record<string, number> };
  /** seat = 全部席位公钥（通用 + 各受众）；seatFor(受众) = 只给那一受众服务的公钥表（A-8 按受众拆分）。 */
  publicKeys: { envelope: Record<string, string>; seat: Record<string, string>; seatFor(aud?: SeatAudience): Record<string, string> };
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

/** 客户端版本号：数字点分，可带短后缀（与内核 control-plane/client.ts 同一口径）。 */
const CLIENT_VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9a-z.]{1,20})?$/;

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
  const onboardingSweep = setInterval(() => {
    try {
      ops.sweepOnboarding();
    } catch {
      // 下个周期再试（写盘失败已回滚）
    }
  }, 3600_000);
  onboardingSweep.unref();
  // 席位令牌签发 96 小时（复核 S6-A01）：客户端剩余不足 73 小时即续期，任何时刻控制面停机后都还有 ≥ 72 小时可用（第 02 篇 §10、§13 第 10 条）
  const seatTtl = Math.max(MIN_SEAT_TTL_SECONDS, o.seatTtlSeconds ?? SEAT_TTL_DEFAULT_SECONDS);
  /** 额度租约的服务内部指标（v9.3 A-9 余项）：发放、受限（月度上限 / 池余额）、拒发原因、回报次数。 */
  const quotaCounts: Record<string, number> = {};
  const quotaCount = (k: string) => (quotaCounts[k] = (quotaCounts[k] ?? 0) + 1);
  const signer: CpSigner = o.signer ?? (o.keys ? localSigner(o.keys) : (null as never));
  if (!signer) throw new Error("控制面须给出签名者（signer）或进程内密钥（keys）");
  const seal = <T>(kind: EnvelopeKind, body: T): Promise<CpEnvelope<T>> => signer.sealEnvelope(kind, body, now());
  /** 席位令牌与各服务专用凭据：签发时刻与回复里的到期时刻由同一时刻推出（云端持久化与 KMS 设计 v1 F-3）。 */
  const seatToken = async (t: TenantRecord, dev: DeviceRecord, sid: string, ttlSeconds: number, aud?: SeatAudience) => {
    const at = now();
    const token = await signer.issueSeatToken({ tid: t.tid, uid: dev.cert.memberId, sid, dev: dev.cert.deviceId, ...(aud ? { aud } : {}), ttlSeconds, at });
    // 等签名期间可能已被吊销（复核 RB16A-05：签名是一次网络往返，原先同步段内的“先查后签”不再原子）：交付前按当前状态再核一次
    const cur = tenants.get(t.tid);
    const seatNow = cur?.seatsByUser.get(dev.cert.memberId);
    const devNow = cur?.devices.get(dev.cert.deviceId);
    if (!cur || !devNow || devNow.revoked_at) throw new CpError(403, "device_revoked", "设备已吊销");
    if (!seatNow || seatNow.sid !== sid || seatNow.revoked_at) throw new CpError(403, "seat_revoked", "席位已吊销");
    if (!licenseValid(cur)) throw new CpError(402, "license_expired", "许可已到期：不签发");
    return { token, expires_at: iso(at + ttlSeconds * 1000) };
  };

  const seenNonce = (key: string): boolean => {
    const t = now();
    if (nonces.size > 20_000) for (const [k, exp] of nonces) if (exp < t) nonces.delete(k);
    // 换主实例时从 Redis 读回的随机数按 HMAC 比较（镜像里没有原文，复核 RB16A-08）
    if (nonces.has(key) || o.nonceMirror?.seen?.(key)) return true;
    nonces.set(key, t + 10 * 60_000);
    noncesDirty = true;
    o.nonceMirror?.record(key, t + 10 * 60_000);
    return false;
  };

  const tenantOf = (tid: string): TenantRecord => {
    const t = tenants.get(tid);
    if (!t) throw new CpError(404, "tenant_unknown", "租户未开通");
    return t;
  };

  const licenseValid = (t: TenantRecord): boolean => Date.parse(t.subscription_until) > now();

  // ─── 开通与入组（第 13 批） ───
  // 接独立签名服务时控制面没有信封私钥：胡椒必须另给（生产入口本来就必填，D-102）
  if (!o.codePepper && !signer.envelopePrivateKey) throw new Error("接独立签名服务时须给出开通码胡椒（codePepper）");
  const codePepper: Buffer = o.codePepper
    ? Buffer.from(o.codePepper)
    : Buffer.from(hkdfSync("sha256", signer.envelopePrivateKey!.export({ format: "der", type: "pkcs8" }), Buffer.alloc(0), "kwl-cp-code-pepper/1", 32));
  if (codePepper.byteLength !== 32) throw new Error("开通码胡椒须为 32 字节");
  /** 律所标识 = 租户编号去掉 ten_ 前缀（与内核 identity.ts 的 ten_<律所标识> 对应）；不合规的租户不能发开通码。 */
  const firmSlugOf = (tid: string): string | null => (/^ten_[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(tid) ? tid.slice(4) : null);
  const newRecordId = (prefix: string) => `${prefix}_${randomBytes(12).toString("base64url")}`;
  const sameHex = (a: string, b: string): boolean => {
    const x = Buffer.from(a, "hex");
    const y = Buffer.from(b, "hex");
    return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
  };
  /** 码索引（复核 A-07）：MAC → 码记录；启动读回与发码时维护，兑换不再线性扫描全部记录。 */
  const codeIndex = new Map<string, { tid: string; id: string }>();
  const rebuildCodeIndex = () => {
    codeIndex.clear();
    for (const t of tenants.values()) for (const r of t.activations.values()) codeIndex.set(r.code_mac, { tid: t.tid, id: r.id });
  };
  rebuildCodeIndex();
  const REREDEEM_WINDOW_MS = 10 * 60_000;
  /** 可兑换：未作废、未消费、未过期；已兑换的只在首次兑换后 10 分钟内且尚未提交入组申请（成员）/尚未登记根（创始）时可再兑换（复核 A-04）。 */
  const redeemable = (t: TenantRecord, r: ActivationRecord): boolean => {
    if (Date.parse(r.expires_at) <= now()) return false;
    if (r.status === "open") return true;
    if (r.status !== "claimed") return false;
    const first = Date.parse(r.first_claimed_at ?? r.claimed_at ?? "");
    if (!Number.isFinite(first) || now() - first > REREDEEM_WINDOW_MS) return false;
    if (r.kind === "founder") return !t.root_public_key_pem;
    return ![...t.joinRequests.values()].some((x) => x.activation_id === r.id);
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
    codeIndex.set(rec.code_mac, { tid: t.tid, id: rec.id });
    return { code, activation_id: rec.id, expires_at: rec.expires_at };
  };
  /**
   * 兑换限速：同一来源每分钟 10 次（码有 100 bit，限速只为压低噪声与撑大流水）。不设全平台桶（复核 A-07：否则任何人都能让全平台的激活 429）；
   * 计数按分钟滚动淘汰（不整表清空）。部署须在本进程或四层终止 TLS——七层代理后来源全是代理地址，限速失效（docs/部署-云端生产入口.md）。
   */
  const redeemWindow = new Map<string, { minute: number; n: number }>();
  const redeemAllowed = (source: string): boolean => {
    const minute = Math.floor(now() / 60_000);
    if (redeemWindow.size > 50_000) for (const [k, w] of redeemWindow) if (w.minute !== minute) redeemWindow.delete(k);
    const w = redeemWindow.get(source);
    if (!w || w.minute !== minute) {
      redeemWindow.set(source, { minute, n: 1 });
      return true;
    }
    return ++w.n <= 10;
  };
  /** 未认证入口按租户编号查：未知租户与凭据不对回同一错误（复核 A-11：不可借此枚举租户）。 */
  const claimTenant = (tid: unknown): TenantRecord => {
    const t = tenants.get(String(tid ?? ""));
    if (!t) throw new CpError(403, "claim_invalid", "开通凭据无效或已过期，请重新输入开通码或邀请码");
    return t;
  };
  /** 两把公钥按算法解析（复核 A-11）：签名公钥 Ed25519 或 P-256，加密公钥 X25519。 */
  const keysOk = (signPub: string, encPub: string): boolean => {
    try {
      const sk = createPublicKey(signPub);
      const ek = createPublicKey(encPub);
      return (sk.asymmetricKeyType === "ed25519" || sk.asymmetricKeyType === "ec") && ek.asymmetricKeyType === "x25519";
    } catch {
      return false;
    }
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

  /**
   * 当前运维操作的执行者：进程内调用（开发脚本与测试）为笼统的 "ops"；经运营接口调用时为核验过签名的运营编号
   * （运维操作都是同步的，`asOperator` 期间不会交错）。
   */
  let opsActor: CpAuditActor = { kind: "ops", id: "ops" };
  const rawOps: ControlPlaneOps = {
    createTenant({ tid, edition, seats, subscriptionDays = 365, points = 0, name, activationRequired = true }) {
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
      return issueCode(tenantOf(tid), { kind: "founder", member: { slug: member.slug, name: member.name ?? null, role: "admin" }, ttlHours, by: opsActor.id });
    },
    revokeActivationCode(tid, activationId, o2 = {}) {
      const t = tenantOf(tid);
      const r = t.activations.get(activationId);
      if (!r) throw new CpError(404, "activation_unknown", "没有这个开通码");
      if (r.status === "consumed") throw new CpError(409, "activation_consumed", "开通码已使用，不能作废（请改为吊销设备）");
      r.status = "revoked";
      r.member.name = null;
      for (const jr of t.joinRequests.values()) if (jr.activation_id === r.id && jr.status === "pending") Object.assign(jr, { status: "rejected", decided_at: iso(), decided_by: o2.by ?? opsActor.id });
    },
    setQuotaCap(tid, cap) {
      quotaSetCap(tenantOf(tid).quota, cap, now(), opsActor.id === "ops" ? null : opsActor.id);
    },
    sweepOnboarding() {
      const t0 = now();
      let names = 0;
      let removed = 0;
      for (const t of tenants.values()) {
        const jrsOf = new Map<string, JoinRequestRecord[]>();
        for (const jr of t.joinRequests.values()) jrsOf.set(jr.activation_id, [...(jrsOf.get(jr.activation_id) ?? []), jr]);
        for (const r of [...t.activations.values()]) {
          const jrs = jrsOf.get(r.id) ?? [];
          const expired = Date.parse(r.expires_at) <= t0;
          if (r.member.name !== null && (expired || jrs.length > 0 || r.status === "consumed" || r.status === "revoked")) {
            r.member.name = null;
            names += 1;
          }
          const pendingLive = jrs.some((x) => x.status === "pending" && Date.parse(x.created_at) + 7 * DAY_MS > t0);
          const finished = r.status === "consumed" || r.status === "revoked" || expired;
          if (!finished || pendingLive) continue;
          const ends = [Date.parse(r.consumed_at ?? ""), Math.min(Date.parse(r.expires_at), t0), ...jrs.map((x) => Date.parse(x.decided_at ?? "") || Date.parse(x.created_at) + 7 * DAY_MS)].filter(Number.isFinite);
          if (Math.max(...ends) + 31 * DAY_MS > t0) continue;
          for (const jr of jrs) t.joinRequests.delete(jr.id);
          t.activations.delete(r.id);
          codeIndex.delete(r.code_mac);
          removed += 1;
        }
      }
      return { names_cleared: names, records_removed: removed };
    },
    tenant: (tid) => tenants.get(tid),
    seal(kind, body) {
      if (!signer.sealSync) throw new Error("接独立签名服务时不能在进程内签任意文档（A-8）");
      return signer.sealSync(kind, body);
    },
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
        const entry = spec ? { tid, actor: opsActor, action: spec.action, target: spec.target ? spec.target(args) : null, ...(detail ? { detail } : {}) } : null;
        let r: unknown;
        try {
          r = (fn as (...a: unknown[]) => unknown)(...args);
          if (entry && tenants.has(tid)) audit({ ...entry, result: "ok" });
        } catch (e) {
          rollback();
          // 被拒记录同样按“租户 + 执行者 + 动作 + 分钟”限量（复核 RA10B-08：运营接口走网络后，被拒请求不能撑大律所的流水）
          if (entry && tenants.has(tid) && rejectedAllowed(entry)) {
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
  const revokedNotice = async (req: IncomingMessage, path: string, raw: string): Promise<void> => {
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
    throw new CpError(403, "device_revoked", "设备已吊销", { notice: await seal("kwl-device-revoked", body) });
  };

  /** 设备签名请求核验 → 设备记录（未吊销）；已吊销设备得到签名的吊销通知。 */
  const authDevice = async (req: IncomingMessage, path: string, raw: string): Promise<{ t: TenantRecord; dev: DeviceRecord }> => {
    const v = verifyDeviceRequest(req.headers, { method: req.method ?? "GET", path, body: raw }, { publicKeyFor: devicePub, now: now(), seenNonce });
    if (!v.ok) {
      if (v.reason === "device_unknown_or_revoked") await revokedNotice(req, path, raw);
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

  // ─── 运营接口（v9.3 A-10）：按人运营签名 + 权限；写操作经运维包装（审计执行者 = 运营编号），另记内部访问审计 ───
  // 守卫的受众须为控制面（复核 RA10A-15：配错时签给支持服务的请求不能在这里通过）
  if (o.opsGuard && o.opsGuard.audience !== "control-plane") throw new Error("运营守卫的受众须为 control-plane");
  const opsAccess = o.opsAccessLog ?? (() => {});
  const asOperator = <T>(id: string, fn: () => T): T => {
    opsActor = { kind: "ops", id };
    try {
      return fn();
    } finally {
      opsActor = { kind: "ops", id: "ops" };
    }
  };
  const intIn = (v: unknown, lo: number, hi: number, code: string, what: string): number => {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < lo || v > hi) throw new CpError(400, code, `${what}须为 ${lo}–${hi} 的整数`);
    return v;
  };
  /** 发码者对外只给种类（复核 RA10B-05：管理员发的邀请码 created_by 是设备编号，其中有成员标识）。 */
  const issuerKind = (by: string) => (by === "ops" || /^op_[0-9]+$/.test(by) ? by : "firm_admin");
  const tenantSummary = (t: TenantRecord) => {
    const q = quotaView(t.quota, now(), { detail: false, seatOwner: () => null, ownSid: null });
    const devs = [...t.devices.values()];
    const all = [...t.activations.values()];
    const invites = all.filter((r) => r.kind !== "founder");
    return {
      tid: t.tid,
      name: t.name ?? null,
      edition: t.edition,
      seats: t.seats,
      created_at: t.created_at,
      subscription_until: t.subscription_until,
      license_expires_at: t.license.expires_at,
      activation_required: t.activation_required === true,
      root_enrolled: t.root_public_key_pem !== null,
      devices: { active: devs.filter((d) => !d.revoked_at).length, revoked: devs.filter((d) => d.revoked_at).length, pre_revoked: t.preRevoked.size },
      seats_used: [...t.seatsByUser.values()].filter((x) => !x.revoked_at).length,
      // 只列创始开通码（运营的事）；律所管理员发的成员邀请码只给计数（复核 RA10B-06）。不给成员标识与姓名
      activations: all.filter((r) => r.kind === "founder").map((r) => ({ id: r.id, status: r.status, created_at: r.created_at, expires_at: r.expires_at, issued_by: issuerKind(r.created_by) })),
      member_invitations: { total: invites.length, open: invites.filter((r) => r.status === "open").length },
      quota: { period: q.period, paused: q.paused, cap_monthly: q.cap_monthly, period_used: q.period_used, pool_remaining: t.quota.pool },
    };
  };
  type OpsSpec = {
    perm: OpsPermission;
    action: string;
    /** 租户与目标编号（内部访问审计用；开通时租户编号在请求体里）。 */
    tid: (b: Record<string, unknown>) => string | null;
    target: (b: Record<string, unknown>) => string | null;
    run: (b: Record<string, unknown>, who: OpsAuthorized) => unknown;
  };
  /** 运营路由只按方法与路径确定（先鉴权、后解析请求体；复核 RA10B-21）。 */
  const opsSpec = (method: string, p: string): OpsSpec | null => {
    const none = () => null;
    if (method === "POST" && p === "/v1/ops/tenants")
      return {
        perm: "tenant.manage",
        action: "tenant.create",
        tid: (b) => (typeof b.tid === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(b.tid) ? b.tid : null),
        target: none,
        run: (b, who) => {
          const tid = typeof b.tid === "string" ? b.tid : "";
          // 经运营接口开通的租户一律要求开通码（不能再开“知道租户编号即可抢先登记律所根”的口子）
          if (!firmSlugOf(tid)) throw new CpError(400, "tid_not_activatable", "租户编号须为 ten_<律所标识>");
          if (tenants.has(tid)) throw new CpError(409, "tenant_exists", "租户已存在");
          if (b.edition !== "team" && b.edition !== "firm") throw new CpError(400, "edition_invalid", "版本须为 team 或 firm");
          const seats = intIn(b.seats, 1, 10_000, "seats_invalid", "席位数");
          const subscriptionDays = b.subscription_days === undefined ? 365 : intIn(b.subscription_days, 1, 3650, "days_invalid", "订阅天数");
          const points = b.points === undefined ? 0 : intIn(b.points, 0, Number.MAX_SAFE_INTEGER, "points_invalid", "点数");
          // 开通时附带点数等于加量：另须 quota.manage（复核 RA10B-07）
          if (points > 0 && !who.perms.includes("quota.manage")) throw new CpError(403, "ops_permission_denied", "开通时附带点数须有加量权限");
          if (b.name !== undefined && typeof b.name !== "string") throw new CpError(400, "tenant_name_invalid", "律所名称须为 1–40 个字符");
          const t = ops.createTenant({ tid, edition: b.edition, seats, subscriptionDays, points, ...(typeof b.name === "string" ? { name: b.name } : {}), activationRequired: true });
          return { ok: true, tenant: tenantSummary(t) };
        },
      };
    const m = /^\/v1\/ops\/tenants\/([A-Za-z0-9_-]{1,64})(?:\/(.+))?$/.exec(p);
    if (!m) return null;
    const tid = m[1]!;
    const rest = m[2] ?? "";
    const at = () => tid;
    if (method === "GET" && rest === "") return { perm: "tenant.read", action: "tenant.read", tid: at, target: none, run: () => ({ tenant: tenantSummary(tenantOf(tid)) }) };
    if (method !== "POST") return null;
    if (rest === "activation-codes")
      return {
        perm: "activation.issue",
        action: "activation.issue",
        tid: at,
        target: none,
        run: (b) => {
          if (typeof b.slug !== "string") throw new CpError(400, "member_slug_invalid", "成员标识只允许小写字母、数字、下划线与连字符");
          if (b.name !== undefined && typeof b.name !== "string") throw new CpError(400, "member_name_invalid", "成员姓名须为 1–40 个字符");
          const ttlHours = b.ttl_hours === undefined ? undefined : intIn(b.ttl_hours, 1, 14 * 24, "ttl_invalid", "有效小时数");
          tenantOf(tid);
          return { ok: true, ...ops.issueActivationCode(tid, { member: { slug: b.slug, ...(typeof b.name === "string" ? { name: b.name } : {}) }, ...(ttlHours !== undefined ? { ttlHours } : {}) }) };
        },
      };
    const ac = /^activation-codes\/(act_[A-Za-z0-9_-]{16})\/revoke$/.exec(rest);
    if (ac)
      return {
        perm: "activation.issue",
        action: "activation.revoke",
        tid: at,
        target: () => ac[1]!,
        run: () => {
          // 运营只作废创始开通码；律所管理员发的成员邀请码是律所自己的事（复核 RA10B-06）
          if (tenantOf(tid).activations.get(ac[1]!)?.kind !== "founder") throw new CpError(404, "activation_unknown", "没有这个开通码");
          ops.revokeActivationCode(tid, ac[1]!);
          return { ok: true };
        },
      };
    if (rest === "renew") return { perm: "tenant.manage", action: "license.renew", tid: at, target: none, run: (b) => ({ ok: true, license: ops.renewLicense(tid, intIn(b.days, 1, 3650, "days_invalid", "续订天数")) }) };
    if (rest === "terminate") return { perm: "tenant.terminate", action: "license.terminate", tid: at, target: none, run: () => ({ ok: true, license: ops.terminateLicense(tid) }) };
    if (rest === "points") return { perm: "quota.manage", action: "quota.grant", tid: at, target: none, run: (b) => (ops.grantPoints(tid, b.points as number), { ok: true }) };
    if (rest === "cap")
      return {
        perm: "quota.cap",
        action: "quota.cap_set",
        tid: at,
        target: none,
        run: (b) => {
          if (!("cap" in b)) throw new CpError(400, "cap_invalid", "须给出 cap（点数，或 null 表示不设上限）");
          // 运营代设上限只能调低（复核 RA10A-17）：调高或取消律所已设的上限是放宽律所的管控，须律所管理员自己在客户端操作
          const cur = tenantOf(tid).quota.cap_monthly;
          if (cur !== null && (b.cap === null || (typeof b.cap === "number" && b.cap > cur))) throw new CpError(409, "cap_raise_by_firm_only", "调高或取消月度上限须由律所管理员操作");
          ops.setQuotaCap(tid, b.cap as number | null);
          return { ok: true };
        },
      };
    const dv = /^devices\/([^/]{1,200})\/revoke$/.exec(rest);
    if (dv)
      return {
        perm: "device.revoke",
        action: "device.revoke",
        tid: at,
        target: () => dv[1]!,
        run: (b, who) => {
          const t = tenantOf(tid);
          ops.revokeDevice(tid, dv[1]!, { ...(b.cert !== undefined ? { cert: b.cert } : {}), by: who.operator });
          return { ok: true, directory_version: t.directoryVersion };
        },
      };
    const st = /^seats\/([^/]{1,200})\/revoke$/.exec(rest);
    if (st) {
      let uid = "";
      try {
        uid = decodeURIComponent(st[1]!);
      } catch {
        uid = "";
      }
      return {
        perm: "device.revoke",
        action: "seat.revoke",
        tid: at,
        // 内部访问审计记席位编号（复核 RA10B-18；成员编号不记）
        target: () => tenants.get(tid)?.seatsByUser.get(uid)?.sid ?? null,
        run: () => {
          const t = tenantOf(tid);
          if (!uid) throw new CpError(400, "seat_invalid", "成员编号不合法");
          if (!t.seatsByUser.has(uid)) throw new CpError(404, "seat_unknown", "成员没有席位");
          ops.revokeSeat(tid, uid);
          return { ok: true, directory_version: t.directoryVersion };
        },
      };
    }
    return null;
  };
  const OPS_AUTH_MESSAGE: Record<number, string> = { 401: "运营凭据无效、已吊销或已过期", 403: "没有这项运营权限", 503: "运营名册暂不可用（运营接口暂停，业务不受影响）" };
  const opsRoute = (req: IncomingMessage, res: ServerResponse, method: string, path: string, p: string, raw: string): void => {
    if (!o.opsGuard) throw new CpError(404, "not_found", "没有这条路由");
    // 运营路径按请求行原样匹配（不认查询串、点段与编码）：生产入口按原样路径判断来源网段，规范化后才落到运营路由的写法一律不认
    if (path !== p) throw new CpError(404, "not_found", "没有这条路由");
    const spec = opsSpec(method, p);
    if (!spec) throw new CpError(404, "not_found", "没有这条路由");
    let who: OpsAuthorized;
    try {
      who = o.opsGuard.authorize(req.headers, { method, path, body: raw }, spec.perm);
    } catch (e) {
      if (e instanceof OpsAuthError) throw new CpError(e.status, e.code, OPS_AUTH_MESSAGE[e.status] ?? "运营凭据无效");
      throw e;
    }
    const b = method === "GET" ? {} : parseJson(raw);
    const rec = { action: spec.action, operator: who.operator, op_key: who.kid, roster_version: who.roster_version, tid: spec.tid(b), target: spec.target(b) };
    // 先记“已请求”：记不进去即不执行（与支持服务同一口径；读操作只有这一处审计）
    try {
      opsAccess({ at: iso(), ...rec, result: "requested" });
    } catch {
      throw new CpError(503, "ops_access_log_unavailable", "运营访问审计写不进去");
    }
    let out: unknown;
    try {
      out = asOperator(who.operator, () => spec.run(b, who));
    } catch (e) {
      try {
        opsAccess({ at: iso(), ...rec, result: `rejected:${e instanceof CpError || e instanceof QuotaError ? e.code : "error"}` });
      } catch {
        // 结果补记不进去：“已请求”一条已在，运营审计流水另有结果
      }
      throw e;
    }
    try {
      opsAccess({ at: iso(), ...rec, result: "ok" });
    } catch {
      // 同上
    }
    send(res, 200, out);
  };

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const path = req.url ?? "/";
    const url = new URL(path, "http://control-plane");
    const p = url.pathname;
    const raw = method === "GET" ? "" : await readBody(req);

    if (p === "/v1/ops" || p.startsWith("/v1/ops/")) return opsRoute(req, res, method, path, p, raw);

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
        throw new CpError(403, "device_revoked", "设备已吊销", { notice: await seal("kwl-device-revoked", body) });
      }
      const changed = !existing || existing.cert.signature !== cert.signature;
      if (changed) {
        t.devices.set(cert.deviceId, { cert, registered_at: iso(), revoked_at: null });
        t.directoryVersion += 1;
      }
      // 客户端版本（v9.3 P3）：只记版本号与日期；版本变了或换了一天才改写（每台设备每天至多一次写入）
      const clientVer = typeof (b.client as { version?: unknown } | undefined)?.version === "string" ? String((b.client as { version: string }).version) : null;
      if (clientVer && CLIENT_VERSION_RE.test(clientVer)) {
        const rec = t.devices.get(cert.deviceId)!;
        const today = iso().slice(0, 10);
        if (rec.client_version !== clientVer || rec.client_seen_on !== today) Object.assign(rec, { client_version: clientVer, client_seen_on: today });
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
      const ix = mac ? codeIndex.get(mac) : undefined;
      const ht = ix ? tenants.get(ix.tid) : undefined;
      const hr = ix && ht ? ht.activations.get(ix.id) : undefined;
      // 码不对、过期、作废、已用、超出再兑换窗口：同一句话（不区分，防枚举）
      if (!ht || !hr || !sameHex(hr.code_mac, mac!) || !redeemable(ht, hr)) throw new CpError(400, "code_invalid", "开通码不正确或已失效，请向发码人重新获取");
      const t = ht;
      const r = hr;
      if (!licenseValid(t)) throw new CpError(402, "license_expired", "律所订阅已到期，请联系中软开通");
      const secret = newClaimSecret();
      r.status = "claimed";
      r.claim_hash = claimSecretHash(secret);
      r.claimed_at = iso();
      r.first_claimed_at = r.first_claimed_at ?? r.claimed_at;
      r.redeem_count = (r.redeem_count ?? 0) + 1;
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
      const t = claimTenant(b.tid);
      const rec = claimOf(t, b.activation_id, b.claim_secret, "member");
      const deviceId = String(b.device_id ?? "");
      const signPub = String(b.sign_pub ?? "");
      const encPub = String(b.enc_pub ?? "");
      if (!DEVICE_ID_PATTERN.test(deviceId)) throw new CpError(400, "device_id_invalid", "设备编号不合法");
      if (signPub.length > 4096 || encPub.length > 4096 || !keysOk(signPub, encPub)) throw new CpError(400, "public_key_invalid", "公钥格式不对");
      // 设备编号只能是 dev_<律所>_<成员>（复核 A-02）；申请须带成员机用邀请码本机秘密段做的 HMAC（复核 A-01，管理员机核对）
      if (deviceId !== expectedJoinDeviceId(firmSlugOf(t.tid) ?? "", rec.member.slug)) throw new CpError(400, "device_id_invalid", "设备编号不合法");
      const jmac = String(b.mac ?? "");
      if (!/^[0-9a-f]{64}$/.test(jmac)) throw new CpError(400, "join_mac_missing", "邀请码不完整（缺少本机核对段），请向管理员核对邀请码");
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
        mac: jmac,
        admin_mac: null,
      };
      t.joinRequests.set(jr.id, jr);
      // 提交申请后不能再兑换，显示名不再需要（复核 A-16：被拒绝、次数用完的邀请也不留姓名）
      rec.member.name = null;
      auditCtx.set(res, { entry: { tid: t.tid, actor: { kind: "claimant", id: rec.id }, action: "join.request", target: jr.id }, written: false });
      return send(res, 200, { ok: true, join_request_id: jr.id, status: jr.status });
    }
    // 成员取回申请结果（凭认领凭据；批准后附证书与律所根公钥）
    const rjf = /^\/v1\/join-requests\/([A-Za-z0-9_-]{1,64})\/fetch$/.exec(p);
    if (method === "POST" && rjf) {
      const b = parseJson(raw);
      const t = claimTenant(b.tid);
      const jr = t.joinRequests.get(rjf[1]!);
      const rec = jr ? t.activations.get(jr.activation_id) : undefined;
      if (!jr || !rec || !rec.claim_hash || typeof b.claim_secret !== "string" || !sameHex(rec.claim_hash, claimSecretHash(b.claim_secret))) throw new CpError(403, "claim_invalid", "开通凭据无效或已过期");
      // 批准 30 天后不再凭认领凭据取回（复核 A-11）
      if (jr.status === "approved" && Date.parse(jr.decided_at ?? "") + 30 * DAY_MS < now()) throw new CpError(403, "claim_invalid", "开通凭据无效或已过期");
      const expired = jr.status === "pending" && Date.parse(jr.created_at) + 7 * DAY_MS < now();
      const status = expired || jr.status === "withdrawn" ? "rejected" : jr.status;
      return sendRaw(res, 200, { ok: true, status, ...(status === "approved" ? { cert: jr.cert, root_public_key_pem: t.root_public_key_pem, firm_bundle: jr.firm_bundle, admin_mac: jr.admin_mac } : {}) });
    }
    // 成员撤回自己的待批准申请（复核 A-09：“重新输入”时让控制面也放下，不必等 7 天）
    const rjw = /^\/v1\/join-requests\/([A-Za-z0-9_-]{1,64})\/withdraw$/.exec(p);
    if (method === "POST" && rjw) {
      const b = parseJson(raw);
      const t = claimTenant(b.tid);
      const jr = t.joinRequests.get(rjw[1]!);
      const rec = jr ? t.activations.get(jr.activation_id) : undefined;
      if (!jr || !rec || !rec.claim_hash || typeof b.claim_secret !== "string" || !sameHex(rec.claim_hash, claimSecretHash(b.claim_secret))) throw new CpError(403, "claim_invalid", "开通凭据无效或已过期");
      if (jr.status === "pending") {
        Object.assign(jr, { status: "withdrawn", decided_at: iso(), decided_by: "member" });
        auditCtx.set(res, { entry: { tid: t.tid, actor: { kind: "claimant", id: rec.id }, action: "join.withdraw", target: jr.id }, written: false });
      }
      return send(res, 200, { ok: true, status: jr.status });
    }

    // ─── 网关与检索服务订阅（服务间凭据） ───
    if (method === "GET" && p === "/v1/feed/gateway") {
      requireService(req);
      return send(res, 200, await seal("kwl-gateway-feed", feedBody()));
    }
    // ─── 额度租约（S3 v0）：网关领取一段点数、本地扣减、按租约回报累计用量（服务间凭据） ───
    if (method === "POST" && p === "/v1/quota/lease") {
      requireService(req);
      const b = parseJson(raw);
      const t = tenantOf(String(b.tid ?? ""));
      // 许可到期或已终止：不再发放（与席位令牌同一口径）
      if (!licenseValid(t)) throw new CpError(402, "license_expired", "许可已到期：不发放额度");
      let l: ReturnType<typeof leaseQuota>;
      try {
        l = leaseQuota(t.quota, { want: b.want, holder: b.holder, ttl_ms: b.ttl_ms, need: b.need }, now());
      } catch (e) {
        quotaCount(`lease_denied:${e instanceof QuotaError && /^[a-z_]{1,40}$/.test(e.code) ? e.code : "other"}`);
        throw e;
      }
      quotaCount(l.limited_by ? `lease_limited:${l.limited_by}` : "lease_ok");
      return send(res, 200, { lease_id: l.lease_id, points: l.points, expires_at: l.expires_at, limited_by: l.limited_by });
    }
    if (method === "POST" && p === "/v1/quota/settle") {
      requireService(req);
      const b = parseJson(raw);
      const t = tenantOf(String(b.tid ?? ""));
      const r = settleLease(t.quota, { lease_id: b.lease_id, holder: b.holder, usage: b.usage, final: b.final }, now());
      quotaCount("settle_ok");
      return send(res, 200, { ok: true, ...r });
    }

    // 以下一律设备签名
    const { t, dev } = await authDevice(req, path, raw);
    const mark = (action: string, target: string | null = null) =>
      auditCtx.set(res, { entry: { tid: t.tid, actor: { kind: "device", id: dev.cert.deviceId, fp: certFingerprint(dev.cert) }, action, target }, written: false });

    if (method === "GET" && p === "/v1/directory") return send(res, 200, await seal("kwl-device-directory", directoryBody(t)));
    if (method === "GET" && p === "/v1/license") return send(res, 200, await seal("kwl-license", issueLicense(t)));
    if (method === "GET" && p === "/v1/tenant-salt") {
      const body: TenantSaltBody = { tid: t.tid, purpose: "anon_matter", salt_b64: t.salt_b64, issued_at: t.created_at };
      return send(res, 200, await seal("kwl-tenant-salt", body));
    }
    if (method === "POST" && p === "/v1/seat-token") {
      mark("seat_token.issue", t.seatsByUser.get(dev.cert.memberId)?.sid ?? null);
      if (!issueAllowed(t.tid, dev.cert.deviceId, "seat_token")) throw new CpError(429, "rate_limited", "签发过于频繁，请稍后再试");
      if (!licenseValid(t)) throw new CpError(402, "license_expired", "许可已到期：不签发席位令牌");
      const seat = t.seatsByUser.get(dev.cert.memberId);
      if (!seat) throw new CpError(402, "no_seat", "该成员没有席位");
      if (seat.revoked_at) throw new CpError(403, "seat_revoked", "席位已吊销");
      return send(res, 200, await seatToken(t, dev, seat.sid, seatTtl));
    }
    // 支持服务专用的短期凭据（第 9 批复核 S9B-03）：受众只有 "support"、15 分钟；网关、检索、分发拒收——诊断包上传不再把通用席位令牌交给支持域
    if (method === "POST" && p === "/v1/support-token") {
      mark("support_token.issue", t.seatsByUser.get(dev.cert.memberId)?.sid ?? null);
      if (!issueAllowed(t.tid, dev.cert.deviceId, "support_token")) throw new CpError(429, "rate_limited", "签发过于频繁，请稍后再试");
      if (!licenseValid(t)) throw new CpError(402, "license_expired", "许可已到期：不签发");
      const seat = t.seatsByUser.get(dev.cert.memberId);
      if (!seat) throw new CpError(402, "no_seat", "该成员没有席位");
      if (seat.revoked_at) throw new CpError(403, "seat_revoked", "席位已吊销");
      return send(res, 200, await seatToken(t, dev, seat.sid, SUPPORT_TOKEN_TTL_SECONDS, "support"));
    }
    // 通知服务专用凭据（第 10 批 S9）：受众只有 "notify"；网关、检索、分发、支持服务都拒收——期限提醒的密文与投递不用通用席位令牌
    if (method === "POST" && p === "/v1/notify-token") {
      mark("notify_token.issue", t.seatsByUser.get(dev.cert.memberId)?.sid ?? null);
      if (!issueAllowed(t.tid, dev.cert.deviceId, "notify_token")) throw new CpError(429, "rate_limited", "签发过于频繁，请稍后再试");
      if (!licenseValid(t)) throw new CpError(402, "license_expired", "许可已到期：不签发");
      const seat = t.seatsByUser.get(dev.cert.memberId);
      if (!seat) throw new CpError(402, "no_seat", "该成员没有席位");
      if (seat.revoked_at) throw new CpError(403, "seat_revoked", "席位已吊销");
      return send(res, 200, await seatToken(t, dev, seat.sid, NOTIFY_TOKEN_TTL_SECONDS, "notify"));
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
      return send(res, 200, await seatToken(t, dev, seat.sid, RELAY_TOKEN_TTL_SECONDS, "relay"));
    }
    if (method === "GET" && p === "/v1/policy") return send(res, 200, await seal("kwl-firm-policy-current", t.policy));
    // ─── 本所用量与上限（S3 v0）：成员看本所本月用量、上限与自己的用量；管理员与合伙人另看按成员明细与池余额 ───
    if (method === "GET" && p === "/v1/quota") {
      const detail = dev.cert.role === "admin" || dev.cert.role === "partner";
      const owner = new Map([...t.seatsByUser.values()].map((x) => [x.sid, x.uid]));
      const view = quotaView(t.quota, now(), { detail, seatOwner: (sid) => owner.get(sid) ?? null, ownSid: t.seatsByUser.get(dev.cert.memberId)?.sid ?? null });
      return send(res, 200, await seal("kwl-quota-view", { tid: t.tid, issued_at: iso(), ...view }));
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
      return send(res, 200, await seal("kwl-cp-audit-page", page));
    }
    if (method === "GET" && p === "/v1/connectors") {
      return send(res, 200, await seal("kwl-firm-connectors", { tid: t.tid, version: t.connectorsVersion, issued_at: iso(), entries: [...t.connectors.values()] }));
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
      viaRoute(() => ops.revokeActivationCode(t.tid, r.id, { by: dev.cert.deviceId }));
      return send(res, 200, { ok: true });
    }
    if (method === "GET" && p === "/v1/join-requests") {
      requireAdmin(dev);
      const list = [...t.joinRequests.values()]
        .filter((x) => x.status === "pending" && Date.parse(x.created_at) + 7 * DAY_MS > now())
        .map((x) => ({ id: x.id, activation_id: x.activation_id, member_slug: x.member_slug, role: x.role, device_id: x.device_id, sign_pub: x.sign_pub, enc_pub: x.enc_pub, created_at: x.created_at, mac: x.mac ?? null }));
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
        const amac = String(b.admin_mac ?? "");
        if (!/^[0-9a-f]{64}$/.test(amac)) throw new CpError(400, "admin_mac_missing", "缺少批准核对段");
        Object.assign(jr, { status: "approved", decided_at: iso(), decided_by: dev.cert.deviceId, cert, firm_bundle: { recovery_public_key_pem: fb!.recovery_public_key_pem, sig: fb!.sig }, admin_mac: amac });
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
      const ce =
        e instanceof CpError
          ? e
          : e instanceof QuotaError
            ? new CpError(e.status, e.code, e.message)
            : e instanceof SignerUnavailableError
              ? new CpError(503, "signer_unavailable", "控制面签名服务暂不可用，请稍后重试")
              : new CpError(500, "control_plane_error", "控制面错误");
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
    clearInterval(onboardingSweep);
    if (!o.auditLog) auditLog.close();
    try {
      persistNow(true);
    } catch {
      // 关闭时写盘失败：下次启动读回上次写成的状态
    }
  });

  const pk = signer.publicKeys();
  return {
    server,
    ops,
    metrics: () => {
      // 客户端版本分布（v9.3 P3；设计 §4.7 轮换签名密钥前看“旧版本活跃设备 < 1%”）：只数未吊销、30 天内报到过的设备；至多 20 个版本，其余归 other
      const since = new Date(now() - 30 * DAY_MS).toISOString().slice(0, 10);
      const byVersion = new Map<string, number>();
      for (const t of tenants.values())
        for (const d of t.devices.values()) {
          if (d.revoked_at) continue;
          const v = d.client_version && d.client_seen_on && d.client_seen_on >= since ? d.client_version : d.client_version ? null : "unknown";
          if (v) byVersion.set(v, (byVersion.get(v) ?? 0) + 1);
        }
      const sorted = [...byVersion].sort((a, b) => b[1] - a[1]);
      const versions: Record<string, number> = Object.fromEntries(sorted.slice(0, 20));
      const rest = sorted.slice(20).reduce((n, [, c]) => n + c, 0);
      if (rest) versions.other = (versions.other ?? 0) + rest;
      return { quota: { ...quotaCounts }, client_versions: versions };
    },
    publicKeys: { envelope: pk.envelope, seat: pk.seat, seatFor: (aud?: SeatAudience) => ({ [aud ? (pk.seat_audiences[aud] ?? pk.seat_general) : pk.seat_general]: pk.seat[aud ? (pk.seat_audiences[aud] ?? pk.seat_general) : pk.seat_general]! }) },
  };
}

/** 测试与运维：设备证书指纹（日志里只记指纹，不记公钥全文）。 */
export function certFingerprint(cert: Pick<DeviceCertificate, "signPublicKeyPem">): string {
  return createHash("sha256").update(cert.signPublicKeyPem).digest("base64url").slice(0, 16);
}
