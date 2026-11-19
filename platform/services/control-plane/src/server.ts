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
import { availability, boostPct as quotaBoost, chargeLease, closeLease, emptyQuota, ensurePeriod, forecastExhaust, leaseQuota, memberLimitOf, migrateQuota, outstanding, pausedOf, QuotaError, quotaView, ratio, setCap as quotaSetCap, sweepLeases, totalsOf, usedOf, type QuotaCtx, type QuotaState } from "./quota.ts";
import { catalogFromConfig, microToCny, migrateCatalog, periodBill, periodBounds, planOf, PlanError, seatQuotaUnits, unitOut, validatePlan, validateSettings, type Catalog, type PlanSpec } from "./billing.ts";
import { bootstrapRouting, chargeOf, currentPrices, deleteModel, deleteProvider, migrateRouting, priceTableOf, recordHealth, requestProbe, routingFeedBody, RoutingError, routingView, setPrices, upsertModel, upsertProvider, type RoutingState } from "./routing.ts";
import { addAgg, dayOf, emptyAgg, UsageBook, usedIn, type Agg, type UsageRow } from "./usage-ledger.ts";
import {
  accountDeviceId,
  accountDeviceIndex,
  accountView,
  AuthError,
  clientInfo,
  codeMac,
  formatOneTimeCode,
  hashPassword,
  locked,
  MAX_DEVICES_PER_ACCOUNT,
  newId,
  newOneTimeCode,
  newSessionToken,
  normalizeEmail,
  normalizeOneTimeCode,
  noteFailure,
  parseSessionToken,
  passwordProblems,
  sameHex as sameHexStr,
  SESSION_ABS_MS,
  SESSION_IDLE_MS,
  sessionLive,
  sessionView,
  sha256Hex,
  slugBase,
  validName,
  verifyPassword,
  type AccountRecord,
  type OneTimeCode,
  type SessionRecord,
} from "./accounts.ts";
import { canonicalJson, verifyBytes, verifyDeviceCertificate, DEVICE_ID_PATTERN, type DeviceCertificate } from "@zr-legal/keys";
import { OpsAuthError, type OpsAuthorized, type OpsGuard, type OpsLoginResult, type OpsPermission } from "@zr-legal/ops-auth";
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
  /** 第 44 批：由账号登录生成的认领（没有码可兑换；成员新设备入组时预先分配了设备编号）。 */
  via_account?: string;
  device_id?: string;
}

/** 告警（第 44 批，主文 §4.3）：额度阈值、上限、用完、异常消耗、上游不可用、设备异常。 */
export interface AlertRecord {
  id: string;
  at: string;
  kind: "threshold" | "cap" | "exhausted" | "anomaly" | "route_down" | "device_flag";
  level: "info" | "warn" | "critical";
  tid: string | null;
  aid: string | null;
  provider: string | null;
  pct: number | null;
  message: string;
  acked_at: string | null;
  acked_by: string | null;
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
  /** 本期额度配置、加量、上限与在途租约（第 44 批 v2：已用量从用量账本算，quota.ts）。 */
  quota: QuotaState;
  /** 套餐代码（套餐目录在控制面状态里，billing.ts）。 */
  plan: string;
  /** 定制本期额度（内部单位：tokens 或微元；设了即不按“席位 × 套餐”计；null = 按套餐）。 */
  allowance_override?: number | null;
  /** 要求账号登录才签发席位令牌（第 44 批；之后开通的缺省 true，之前的读回为 false）。 */
  accounts_required?: boolean;
  /** 开通方式：运营开通 / 自助注册（试用）。 */
  created_via?: "ops" | "self";
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
  /** 配置文件里的 billing 段（首次启动导入套餐目录与注册设置；之后以状态里的为准，运营在控制台改）。 */
  billing?: unknown;
  /** 用量账本（usage-ledger.ts）：未给出 = 只在内存（开发与测试）。 */
  usageBook?: UsageBook;
  /** API 路由（第 44 批）：首次启动导入的初始上游；网关路由公钥编号（控制台加密上游密钥用的那把，提交的密文须与之相符）。 */
  routing?: { bootstrap?: Parameters<typeof bootstrapRouting>[1]; key_id?: string | null };
  /** 邮件通道（找回密码验证码）；没有 = 只能由运营发重置码。 */
  mailer?: { from: string; send(to: string, subject: string, text: string): Promise<void> };
  /** 服务版本（运营“系统”页显示）。 */
  serverVersion?: string;
  /** 运营名册的只读信息（“系统”页显示；入口按名册来源给出）。 */
  opsInfo?: { deployment: string; roster: () => { version: number; expires_at: string; operators: { id: string; perms: string[]; keys: { kid: string }[]; revoked_at?: string }[] } | null };
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
  /** 凭据方式（key = 私钥签名，password = 账号密码登录的会话）与密码会话编号前 8 位。 */
  via?: "key" | "password";
  session?: string;
}

export interface ControlPlaneOps {
  /** 商务开通：建租户、发许可（≤ 30 天）、生成租户盐、发布最严模板策略 v1（不比最严模板宽：只需控制面签名）。 */
  createTenant(o: { tid: string; edition: LicenseBody["edition"]; seats: number; subscriptionDays?: number; plan?: string; allowanceUnits?: number; name?: string; activationRequired?: boolean; accountsRequired?: boolean; createdVia?: "ops" | "self" }): TenantRecord;
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
  /** 运营加量包：按套餐额度的百分比加到本期；返回折合的内部单位。 */
  boostQuota(tid: string, pct: number): number;
  /** 改套餐与席位数（立即对本月额度生效；席位数不得少于在用席位）。 */
  setPlan(tid: string, o: { plan?: string; seats?: number }): void;
  /** 运营代设本期上限（百分比 1–100；律所管理员通常在客户端自己设；null = 不设上限）。 */
  setQuotaCap(tid: string, capPct: number | null): void;
  /** 是否要求账号登录才签发席位令牌（第 44 批）。 */
  setAccountsRequired(tid: string, required: boolean): void;
  tenant(tid: string): TenantRecord | undefined;
  /** 账号（第 44 批）：按邮箱查（开发脚本与用例）。 */
  account(email: string): AccountRecord | undefined;
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
  /** 用量账本（第 44 批；用例与运维脚本读）。 */
  usageBook: UsageBook;
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
  // ─── 第 44 批：账号、会话、一次性码、套餐目录、API 路由、告警（随状态快照落盘）；逐请求用量在独立的账本 ───
  const accounts = new Map<string, AccountRecord>();
  const accountByEmail = new Map<string, string>();
  /** 租户 + 成员编号 → 账号（账号与成员一一对应）。 */
  const accountByMember = new Map<string, string>();
  const sessions = new Map<string, SessionRecord>();
  const codes = new Map<string, OneTimeCode>();
  const catalogDefault = catalogFromConfig(o.billing);
  let catalog: Catalog = structuredClone(catalogDefault);
  let routing: RoutingState = bootstrapRouting(now(), o.routing?.bootstrap);
  let alerts: AlertRecord[] = [];
  const book = o.usageBook ?? new UsageBook({ now });
  const startedAt = iso();
  const routingKeyId = o.routing?.key_id ?? null;
  const memberKey = (tid: string, uid: string) => `${tid}\u0000${uid}`;
  const indexAccount = (a: AccountRecord) => {
    accountByEmail.set(a.email, a.aid);
    accountByMember.set(memberKey(a.tid, `usr_${a.tid.slice(4)}_${a.member_slug}`), a.aid);
  };
  const accountOfMember = (tid: string, uid: string): AccountRecord | undefined => {
    const aid = accountByMember.get(memberKey(tid, uid));
    return aid ? accounts.get(aid) : undefined;
  };
  const planFor = (t: TenantRecord): PlanSpec => planOf(catalog, t.plan);
  /** 额度上下文：当前套餐、席位、账号个人上限与用量账本（改套餐、改席位、改上限即对本期生效）。 */
  const ctxOf = (t: TenantRecord): QuotaCtx => {
    const plan = planFor(t);
    return {
      tid: t.tid,
      plan,
      seats: t.seats,
      allowance_override: typeof t.allowance_override === "number" ? t.allowance_override : null,
      book,
      t: now(),
      memberLimit: (uid) => {
        const a = accountOfMember(t.tid, uid);
        if (!a || a.quota_limit === null) return null;
        return plan.quota_unit === "cny" ? Math.round(a.quota_limit * 1_000_000) : Math.round(a.quota_limit);
      },
    };
  };
  const qOf = (t: TenantRecord): { q: QuotaState; ctx: QuotaCtx } => {
    const ctx = ctxOf(t);
    ensurePeriod(t.quota, ctx);
    return { q: t.quota, ctx };
  };
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
      accounts: [...accounts.values()],
      sessions: [...sessions.values()],
      codes: [...codes.values()],
      catalog,
      routing,
      alerts,
    });
  const snapshot = (state = stateOnly()): string => JSON.stringify({ ...(JSON.parse(state) as object), nonces: [...nonces] });
  /** 由快照重建内存状态（启动读回与失败回滚共用）；null = 空状态。 */
  const applySnapshot = (raw: string | null, withNonces: boolean): void => {
    tenants.clear();
    accounts.clear();
    accountByEmail.clear();
    accountByMember.clear();
    sessions.clear();
    codes.clear();
    catalog = structuredClone(catalogDefault);
    routing = bootstrapRouting(now(), o.routing?.bootstrap);
    alerts = [];
    feedVersion = 1;
    if (withNonces) nonces.clear();
    if (raw === null) return;
    const st = JSON.parse(raw) as { v: number; feedVersion: number; nonces?: [string, number][]; tenants: any[]; accounts?: AccountRecord[]; sessions?: SessionRecord[]; codes?: OneTimeCode[]; catalog?: Catalog; routing?: RoutingState; alerts?: AlertRecord[] };
    // 第 44 批之前的状态没有这些：套餐从配置导入、路由按配置初始化、账号为空
    catalog = migrateCatalog(st.catalog, structuredClone(catalogDefault));
    routing = migrateRouting(st.routing, now(), o.routing?.bootstrap);
    alerts = Array.isArray(st.alerts) ? st.alerts : [];
    for (const a of st.accounts ?? []) {
      accounts.set(a.aid, a);
      indexAccount(a);
    }
    for (const x of st.sessions ?? []) sessions.set(x.sid, x);
    for (const c of st.codes ?? []) codes.set(c.id, c);
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
        // 第 40 批的“内部单位”账本：本期已用冻结为比例，新账本从此计（quota.ts migrateQuota，主文 §4.6）
        quota: migrateQuota(t.quota, planOf(catalog, typeof t.plan === "string" ? t.plan : catalog.default_plan), now()),
        plan: typeof t.plan === "string" ? t.plan : catalog.default_plan,
        // 第 44 批之前开通的律所不要求账号登录（运营可在控制台打开）；Kimi 账号绑定（第 40 批）已撤下，读回时丢弃
        accounts_required: t.accounts_required === true,
        kimiAccounts: undefined,
        kimi_required: undefined,
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
  // 账号一次性码（设置密码、重置、邮件验证码）的 HMAC 密钥：由胡椒派生（与开通码 HMAC 分开用途）
  const accountPepper = Buffer.from(hkdfSync("sha256", codePepper, Buffer.alloc(0), "kwl-account-code/1", 32));
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
    createTenant({ tid, edition, seats, subscriptionDays = 365, plan, allowanceUnits, name, activationRequired = true, accountsRequired = false, createdVia = "ops" }) {
      // 租户编号字符集（复核 S9A-01：不合规的编号写进审计流水会让重启验链失败）
      if (typeof tid !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(tid)) throw new CpError(400, "tid_invalid", "租户编号只能用字母、数字、下划线与连字符");
      if (tenants.has(tid)) throw new Error(`租户已存在：${tid}`);
      if (name !== undefined && !validDisplayName(name)) throw new CpError(400, "tenant_name_invalid", "律所名称须为 1–40 个字符");
      if (plan !== undefined && !catalog.plans.some((x) => x.id === plan)) throw new CpError(400, "plan_unknown", "套餐不在目录里");
      if (allowanceUnits !== undefined && !(Number.isSafeInteger(allowanceUnits) && allowanceUnits >= 0)) throw new CpError(400, "allowance_invalid", "定制额度须为非负整数");
      const planId = plan ?? catalog.default_plan;
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
        quota: emptyQuota(planOf(catalog, planId), now()),
        plan: planId,
        ...(allowanceUnits !== undefined ? { allowance_override: allowanceUnits } : {}),
        accounts_required: accountsRequired,
        created_via: createdVia,
      };
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
    boostQuota(tid, pct) {
      const { q, ctx } = qOf(tenantOf(tid));
      return quotaBoost(q, ctx, pct, opsActor.id === "ops" ? null : opsActor.id);
    },
    setPlan(tid, { plan, seats }) {
      const t = tenantOf(tid);
      if (plan !== undefined && !catalog.plans.some((x) => x.id === plan)) throw new CpError(400, "plan_unknown", "套餐不在目录里");
      if (seats !== undefined) {
        if (!Number.isSafeInteger(seats) || seats < 1 || seats > 10_000) throw new CpError(400, "seats_invalid", "席位数须为 1–10000 的整数");
        const used = [...t.seatsByUser.values()].filter((x) => !x.revoked_at).length;
        if (seats < used) throw new CpError(409, "seats_in_use", `在用席位 ${used} 个，席位数不能少于它（先由律所收回席位）`);
      }
      if (plan !== undefined) t.plan = plan;
      if (seats !== undefined && seats !== t.seats) {
        t.seats = seats;
        issueLicense(t);
      }
      qOf(t);
    },
    setAccountsRequired(tid, required) {
      tenantOf(tid).accounts_required = required === true;
      feedVersion += 1;
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
      const { q, ctx } = qOf(tenantOf(tid));
      quotaSetCap(q, ctx, cap, opsActor.id === "ops" ? null : opsActor.id);
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
    account: (email) => {
      const aid = accountByEmail.get(String(email).toLowerCase());
      return aid ? accounts.get(aid) : undefined;
    },
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
        const x = (a[0] ?? {}) as { seats?: unknown };
        return { seats: Number(x.seats) || 0 };
      },
    },
    renewLicense: { action: "license.renew", detail: (a) => ({ days: Math.floor(Number(a[1])) || 0 }) },
    terminateLicense: { action: "license.terminate" },
    revokeDevice: { action: "device.revoke", target: (a) => String(a[1]) },
    revokeSeat: { action: "seat.revoke", target: (a) => seatOf(String(a[0]), a[1]) },
    boostQuota: { action: "quota.boost", detail: (a) => ({ pct: Math.floor(Number(a[1])) || 0 }) },
    setPlan: { action: "plan.change", detail: (a) => { const x = (a[1] ?? {}) as { seats?: unknown }; return x.seats === undefined ? { plan: 1 } : { seats: Number(x.seats) || 0 }; } },
    setAccountsRequired: { action: "accounts.policy", detail: (a) => ({ required: a[1] === true ? 1 : 0 }) },
    issueActivationCode: { action: "activation.issue" },
    revokeActivationCode: { action: "activation.revoke", target: (a) => String(a[1]) },
    setQuotaCap: { action: "quota.cap_set", detail: (a) => (a[1] === null ? { uncapped: 1 } : { cap_pct: Math.floor(Number(a[1])) || 0 }) },
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
              auditLog.append({ ...entry, result: `rejected:${e instanceof CpError || e instanceof QuotaError || e instanceof RoutingError || e instanceof PlanError ? e.code : "error"}` }, iso());
            } catch {
              // 审计写不进去：操作本身已失败
            }
          }
          throw e;
        }
        // 路由代调时不在这里写盘（复核 S9A-03）：由路由的 send 统一按“审计 → 写盘 → 回复”执行，审计写不进去即整个操作回滚
        if (k !== "tenant" && k !== "seal" && k !== "account" && !routeCall) {
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

  /**
   * 账号闸（第 44 批，主文 §2.5）：要求账号登录的律所，签发席位令牌与各服务专用凭据前须有本设备上的有效会话、账号有效、账号就是证书上的成员。
   * 会话还没绑设备（登录在激活之前）就在此绑定。
   */
  const accountGate = (req: IncomingMessage, t: TenantRecord, dev: DeviceRecord): void => {
    if (t.accounts_required !== true) return;
    let me: { s: SessionRecord; a: AccountRecord };
    try {
      me = sessionOf(req, true)!;
    } catch (e) {
      return authErr(e);
    }
    if (me.a.tid !== t.tid || uidOfAccount(me.a) !== dev.cert.memberId) throw new CpError(403, "session_member_mismatch", "登录的账号不是这台电脑上的成员：请用本机成员的账号重新登录");
    if (me.s.device_id !== null && me.s.device_id !== dev.cert.deviceId) throw new CpError(401, "session_invalid", "登录已失效，请重新登录");
    if (me.s.device_id === null) {
      me.s.device_id = dev.cert.deviceId;
      feedVersion += 1;
    }
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
    return { version: feedVersion, issued_at: iso(), revoked_devices: revokedDevices, revoked_seats: revokedSeats, matters, policies, suspended_devices: suspendedDevices() };
  };

  // ═══ 第 44 批：账号、会话、设备、路由、用量入账、告警 ═══
  const sourceOf = (req: IncomingMessage) => String(req.socket.remoteAddress ?? "?");
  /** 未认证账号入口的限速（按来源与种类，每分钟）。 */
  const authWindow = new Map<string, { minute: number; n: number }>();
  const authAllowed = (source: string, kind: string, max: number): boolean => {
    const minute = Math.floor(now() / 60_000);
    if (authWindow.size > 50_000) for (const [k, w] of authWindow) if (w.minute !== minute) authWindow.delete(k);
    const k = `${kind}\u0000${source}`;
    const w = authWindow.get(k);
    if (!w || w.minute !== minute) {
      authWindow.set(k, { minute, n: 1 });
      return true;
    }
    return ++w.n <= max;
  };
  const uidOfAccount = (a: AccountRecord) => `usr_${a.tid.slice(4)}_${a.member_slug}`;
  const orgOf = (tid: string) => ({ slug: tid.slice(4), name: tenants.get(tid)?.name ?? tid.slice(4) });
  const deviceLimitOf = (a: AccountRecord): number => Math.min(MAX_DEVICES_PER_ACCOUNT, a.device_limit ?? (tenants.get(a.tid) ? planFor(tenants.get(a.tid)!).device_limit : catalog.settings.default_device_limit));
  const accountDevices = (a: AccountRecord): DeviceRecord[] => [...(tenants.get(a.tid)?.devices.values() ?? [])].filter((d) => d.cert.memberId === uidOfAccount(a));
  const liveSessionsOf = (aid: string) => [...sessions.values()].filter((x) => x.aid === aid && sessionLive(x, now()));
  /** 暂停的设备：要求账号登录的律所里，设备所属成员没有账号、账号停用，或这台设备上没有有效的桌面会话。 */
  const suspendedDevices = (): { tid: string; device_id: string }[] => {
    const out: { tid: string; device_id: string }[] = [];
    const t0 = now();
    const liveDev = new Set<string>();
    for (const x of sessions.values()) if (x.device_id && sessionLive(x, t0) && accounts.get(x.aid)?.status === "active") liveDev.add(`${accounts.get(x.aid)!.tid}\u0000${x.device_id}`);
    for (const t of tenants.values()) {
      if (t.accounts_required !== true) continue;
      for (const d of t.devices.values()) if (!d.revoked_at && d.cert.role !== "node" && !liveDev.has(`${t.tid}\u0000${d.cert.deviceId}`)) out.push({ tid: t.tid, device_id: d.cert.deviceId });
    }
    return out;
  };
  /** 会话到期是按时间发生的：每 10 分钟看一次有没有新到期的，有就让订阅版本前进（网关据此暂停对应设备）。 */
  let lastSuspendedSig = "";
  const suspendSweep = setInterval(() => {
    const sig = suspendedDevices().map((d) => `${d.tid}/${d.device_id}`).sort().join(",");
    if (sig !== lastSuspendedSig) {
      lastSuspendedSig = sig;
      feedVersion += 1;
    }
  }, 600_000);
  suspendSweep.unref();
  const addAlert = (a: Omit<AlertRecord, "id" | "at" | "acked_at" | "acked_by">): void => {
    alerts.unshift({ id: newId("alr"), at: iso(), acked_at: null, acked_by: null, ...a });
    if (alerts.length > 500) alerts.length = 500;
  };
  const newSession = (a: AccountRecord, kind: SessionRecord["kind"], deviceId: string | null, client: unknown): { token: string; rec: SessionRecord } => {
    const { sid, secret, token } = newSessionToken();
    const t0 = now();
    // 同一账号的会话至多 20 个（最旧的先失效）
    const mine = [...sessions.values()].filter((x) => x.aid === a.aid && !x.revoked_at).sort((x, y) => x.created_at.localeCompare(y.created_at));
    for (const x of mine.slice(0, Math.max(0, mine.length - 19))) Object.assign(x, { revoked_at: iso(t0), revoked_reason: "too_many_sessions" });
    // 同一台设备只留一个有效桌面会话（重新登录即替换）
    if (deviceId) for (const x of mine) if (x.device_id === deviceId && x.kind === "desktop") Object.assign(x, { revoked_at: iso(t0), revoked_reason: "replaced" });
    const rec: SessionRecord = { sid, aid: a.aid, secret_hash: sha256Hex(secret), kind, device_id: deviceId, created_at: iso(t0), last_seen_at: iso(t0), idle_expires_at: iso(t0 + SESSION_IDLE_MS[kind]), abs_expires_at: iso(t0 + SESSION_ABS_MS[kind]), revoked_at: null, revoked_reason: null, client: clientInfo(client) };
    sessions.set(sid, rec);
    feedVersion += 1;
    return { token, rec };
  };
  /** 请求里的会话（桌面：x-kwl-session；网页：Authorization: Bearer）；required = 没有即 401。 */
  const sessionOf = (req: IncomingMessage, required: boolean): { s: SessionRecord; a: AccountRecord } | null => {
    const h = req.headers["x-kwl-session"] ?? (typeof req.headers.authorization === "string" ? /^Bearer\s+(kws1\..+)$/i.exec(req.headers.authorization)?.[1] : undefined);
    if (h === undefined) {
      if (required) throw new AuthError(401, "session_required", "请先登录");
      return null;
    }
    const pt = parseSessionToken(Array.isArray(h) ? h[0] : h);
    const x = pt ? sessions.get(pt.sid) : undefined;
    if (!pt || !x || !sameHexStr(x.secret_hash, sha256Hex(pt.secret))) throw new AuthError(401, "session_invalid", "登录已失效，请重新登录");
    if (!sessionLive(x, now())) throw new AuthError(401, "session_expired", "登录已过期，请重新登录");
    const a = accounts.get(x.aid);
    if (!a) throw new AuthError(401, "session_invalid", "登录已失效，请重新登录");
    if (a.status !== "active") throw new AuthError(403, "account_disabled", "账号已停用，请联系管理员");
    // 续期：空闲到期往后推；按小时落盘（不让每个请求都整份重写状态）
    const t0 = now();
    if (t0 - Date.parse(x.last_seen_at) > 3600_000) {
      x.last_seen_at = iso(t0);
      x.idle_expires_at = iso(Math.min(t0 + SESSION_IDLE_MS[x.kind], Date.parse(x.abs_expires_at)));
    }
    return { s: x, a };
  };
  const revokeSessions = (pred: (x: SessionRecord) => boolean, reason: string): number => {
    let n = 0;
    for (const x of sessions.values())
      if (!x.revoked_at && pred(x)) {
        Object.assign(x, { revoked_at: iso(), revoked_reason: reason });
        n += 1;
      }
    // 过期与吊销超过 30 天的会话清掉
    for (const [k, x] of sessions) if ((x.revoked_at && Date.parse(x.revoked_at) + 30 * DAY_MS < now()) || Date.parse(x.abs_expires_at) + 30 * DAY_MS < now()) sessions.delete(k);
    if (n) feedVersion += 1;
    return n;
  };
  /**
   * 账号生成的认领（主文 §2.2）：创始 = 登记律所根；成员 = 新设备入组（预先分配设备编号）。同一账号同一种类只留一份，重新登录即换新凭据。
   */
  const accountClaim = (t: TenantRecord, a: AccountRecord, kind: "founder" | "member", deviceId?: string): { activation_id: string; claim_secret: string } => {
    for (const r of t.activations.values())
      if (r.via_account === a.aid && r.kind === kind && (r.status === "claimed" || r.status === "open")) {
        r.status = "revoked";
        for (const jr of t.joinRequests.values()) if (jr.activation_id === r.id && jr.status === "pending") Object.assign(jr, { status: "withdrawn", decided_at: iso(), decided_by: "account_relogin" });
      }
    const secret = newClaimSecret();
    const at = now();
    const rec: ActivationRecord = {
      id: newRecordId("act"),
      // 没有可兑换的码：MAC 取一个随机值（码索引里查不到）
      code_mac: randomBytes(32).toString("hex"),
      kind,
      member: { slug: a.member_slug, name: a.name, role: a.role },
      created_at: iso(at),
      expires_at: iso(at + 7 * DAY_MS),
      created_by: `account:${a.aid}`,
      status: "claimed",
      claim_hash: claimSecretHash(secret),
      claimed_at: iso(at),
      consumed_at: null,
      join_attempts: 0,
      first_claimed_at: iso(at),
      redeem_count: 1,
      via_account: a.aid,
      ...(deviceId ? { device_id: deviceId } : {}),
    };
    t.activations.set(rec.id, rec);
    return { activation_id: rec.id, claim_secret: secret };
  };
  type Onboarding = Record<string, unknown> & { state: string };
  /** 登录后这台电脑该做什么（主文 §2.2 Onboarding）。dev = 已激活且请求带了有效设备签名的本机设备。 */
  const onboardingOf = (a: AccountRecord, dev: DeviceRecord | null): Onboarding => {
    const t = tenantOf(a.tid);
    const firm = orgOf(t.tid);
    const member = { slug: a.member_slug, name: a.name, role: a.role };
    const devs = accountDevices(a);
    const live = devs.filter((d) => !d.revoked_at);
    const limit = deviceLimitOf(a);
    const base = { tid: t.tid, firm, member, devices_used: live.length, device_limit: limit };
    if (dev) return dev.cert.memberId === uidOfAccount(a) ? { state: "ready", ...base, device_id: dev.cert.deviceId } : { state: "device_mismatch", ...base };
    if (!t.root_public_key_pem) {
      if (a.role !== "admin") return { state: "waiting_founder", ...base };
      return { state: "needs_founder_setup", ...base, claim: { kind: "founder", tid: t.tid, firm, member, ...accountClaim(t, a, "founder") } };
    }
    if (live.length >= limit) return { state: "device_limit", ...base, devices: live.map((d) => ({ device_id: d.cert.deviceId, registered_at: d.registered_at, client_version: d.client_version ?? null, last_seen_on: d.client_seen_on ?? null })) };
    // 下一台的编号：1..9 里第一个从未用过的（吊销过的编号不再复用）
    const used = new Set([...devs.map((d) => accountDeviceIndex(t.tid.slice(4), a.member_slug, d.cert.deviceId)), ...[...t.preRevoked.keys()].map((id) => accountDeviceIndex(t.tid.slice(4), a.member_slug, id))]);
    for (const jr of t.joinRequests.values()) if (jr.member_slug === a.member_slug && (jr.status === "pending" || jr.status === "approved")) used.add(accountDeviceIndex(t.tid.slice(4), a.member_slug, jr.device_id));
    let n = 1;
    while (used.has(n) && n <= MAX_DEVICES_PER_ACCOUNT) n += 1;
    if (n > MAX_DEVICES_PER_ACCOUNT) return { state: "device_limit", ...base, devices: [] };
    const deviceId = accountDeviceId(t.tid.slice(4), a.member_slug, n);
    return { state: "needs_device_join", ...base, device_id: deviceId, claim: { kind: "member", tid: t.tid, firm, member, ...accountClaim(t, a, "member", deviceId) } };
  };
  const authResult = (a: AccountRecord, token: string, x: SessionRecord, onb: Onboarding) => ({
    ok: true,
    session_token: token,
    session: { sid: x.sid, kind: x.kind, idle_expires_at: x.idle_expires_at },
    account: accountView(a, { org: orgOf(a.tid) }),
    onboarding: onb,
  });
  /** 已激活设备的登录：请求带了设备签名头就核验（核验失败即 401，不降级为“未激活”）。 */
  const optionalDevice = async (req: IncomingMessage, path: string, raw: string): Promise<DeviceRecord | null> => {
    if (req.headers["x-kwl-device"] === undefined) return null;
    const { dev } = await authDevice(req, path, raw);
    return dev;
  };
  const newMemberSlug = (t: TenantRecord, email: string): string => {
    const base = slugBase(email);
    const taken = (slug: string) => [...accounts.values()].some((x) => x.tid === t.tid && x.member_slug === slug) || [...t.activations.values()].some((r) => r.member.slug === slug) || [...t.devices.values()].some((d) => d.cert.memberId === `usr_${t.tid.slice(4)}_${slug}`);
    if (!taken(base)) return base;
    for (let i = 2; i < 1000; i++) if (!taken(`${base}${i}`)) return `${base}${i}`;
    return `${base}${randomBytes(3).toString("hex")}`;
  };
  const newFirmTid = (email: string): string => {
    const base = slugBase(email);
    for (let i = 0; i < 50; i++) {
      const tid = `ten_${base}${i === 0 ? "" : `-${randomBytes(2).toString("hex")}`}`;
      if (!tenants.has(tid)) return tid;
    }
    return `ten_${base}-${randomBytes(4).toString("hex")}`;
  };
  const issueAccountCode = (a: AccountRecord, purpose: OneTimeCode["purpose"], ttlMs: number, by: string | null): { code: string; expires_at: string } => {
    for (const c of codes.values()) if (c.aid === a.aid && c.purpose === purpose && !c.used_at) c.used_at = iso();
    const code = purpose === "email_reset" ? String(randomBytes(4).readUInt32BE() % 1_000_000).padStart(6, "0") : newOneTimeCode();
    const rec: OneTimeCode = { id: newId("otc"), aid: a.aid, purpose, mac: codeMac(accountPepper, purpose, a.aid, code), created_at: iso(), expires_at: iso(now() + ttlMs), attempts: 0, used_at: null, by };
    codes.set(rec.id, rec);
    for (const [k, c] of codes) if (Date.parse(c.expires_at) + 7 * DAY_MS < now()) codes.delete(k);
    return { code, expires_at: rec.expires_at };
  };

  // ─── 用量入账（网关回报的逐请求记录 → 账本行；按请求编号去重、按价目版本重算） ───
  const REQ_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
  const OUTCOMES = new Set(["ok", "client_gone", "upstream_error", "timeout", "blocked"]);
  const SOURCES = new Set(["upstream", "drained", "estimated", "none"]);
  const nnInt = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 1e10 ? v : 0);
  const strOr = (v: unknown, re: RegExp): string | null => (typeof v === "string" && re.test(v) ? v : null);
  const rowOf = (t: TenantRecord, r: Record<string, any>, plan: PlanSpec): UsageRow => {
    if (!r || typeof r !== "object" || typeof r.request_id !== "string" || !REQ_ID_RE.test(r.request_id)) throw new QuotaError(400, "records_invalid", "用量记录缺少请求编号");
    const usage = r.usage && typeof r.usage === "object" ? { input: nnInt(r.usage.input), cached: Math.min(nnInt(r.usage.cached), nnInt(r.usage.input)), output: nnInt(r.usage.output), reasoning: nnInt(r.usage.reasoning) } : null;
    const atMs = Number.isFinite(Date.parse(r.at)) ? Math.min(Date.parse(r.at), now() + 60_000) : now();
    const uid = strOr(r.uid, /^[A-Za-z0-9_-]{1,160}$/);
    const alias = strOr(r.alias, /^[a-z0-9][a-z0-9._/-]{1,47}$/);
    const priceTable = priceTableOf(routing, r.price_version);
    const money = usage ? chargeOf(alias ? priceTable.items[alias] : undefined, usage) : { value_micro: null, cost_micro: null };
    const unit = plan.quota_unit;
    const charge = usage ? (unit === "tokens" ? usage.input + usage.output : (money.value_micro ?? 0)) : 0;
    const acc = uid ? accountOfMember(t.tid, uid) : undefined;
    return {
      v: 1,
      request_id: r.request_id,
      client_request_id: strOr(r.client_request_id, /^[A-Za-z0-9_-]{1,96}$/),
      upstream_request_id: strOr(r.upstream_request_id, /^[A-Za-z0-9_.:-]{1,128}$/),
      at: iso(atMs),
      started_at: Number.isFinite(Date.parse(r.started_at)) ? iso(Date.parse(r.started_at)) : null,
      day: dayOf(atMs),
      tid: t.tid,
      aid: acc?.aid ?? null,
      uid,
      sid: strOr(r.sid, /^[A-Za-z0-9_-]{1,120}$/),
      dev: strOr(r.dev, /^[A-Za-z0-9_-]{1,128}$/),
      alias,
      provider: strOr(r.provider, /^[a-z][a-z0-9-]{1,31}$/),
      upstream_model: strOr(r.upstream_model, /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/),
      stream: r.stream === true,
      qa: r.qa === true,
      status: Number.isSafeInteger(r.status) ? r.status : null,
      outcome: OUTCOMES.has(r.outcome) ? r.outcome : usage ? "ok" : "upstream_error",
      usage,
      usage_source: SOURCES.has(r.usage_source) ? r.usage_source : usage ? "upstream" : "none",
      unit,
      charge,
      value_micro: money.value_micro,
      cost_micro: money.cost_micro,
      price_version: priceTable.version,
      latency_ms: Number.isSafeInteger(r.latency_ms) && r.latency_ms >= 0 ? r.latency_ms : null,
      attempts: Array.isArray(r.attempts) ? r.attempts.slice(0, 5).map((x: any) => ({ provider: strOr(x?.provider, /^[a-z][a-z0-9-]{1,31}$/), status: Number.isSafeInteger(x?.status) ? x.status : null, error: strOr(x?.error, /^[a-z0-9_:.-]{1,64}$/i), ms: Number.isSafeInteger(x?.ms) ? x.ms : null })) : [],
      finish_reason: strOr(r.finish_reason, /^[a-z_]{1,32}$/),
      lease_id: strOr(r.lease_id, /^ls_[0-9a-f]{24}$/),
    };
  };
  /** 入账后的提醒：租户与成员跨过阈值、到上限、用完；成员 1 小时消耗异常。 */
  const checkAlerts = (t: TenantRecord, uids: Set<string>): void => {
    const { q, ctx } = qOf(t);
    const plan = ctx.plan;
    const tot = totalsOf(q, ctx);
    const used = usedOf(q, ctx);
    const pct = tot.total > 0 ? (used / tot.total) * 100 : 0;
    const once = (key: string, f: () => void) => {
      if (q.alerts_sent.includes(key)) return;
      q.alerts_sent.push(key);
      f();
    };
    for (const th of plan.alert_thresholds) if (pct >= th) once(`${q.period_key}:t:${th}`, () => addAlert({ kind: th >= 100 ? "exhausted" : "threshold", level: th >= 100 ? "critical" : th >= 90 ? "warn" : "info", tid: t.tid, aid: null, provider: null, pct: th, message: th >= 100 ? `${t.name ?? t.tid} 本期额度已用完` : `${t.name ?? t.tid} 本期已用 ${th}%` }));
    if (tot.cap !== null && used >= tot.cap) once(`${q.period_key}:cap`, () => addAlert({ kind: "cap", level: "warn", tid: t.tid, aid: null, provider: null, pct: q.cap_pct, message: `${t.name ?? t.tid} 已到律所设定的上限（${q.cap_pct}%）` }));
    for (const uid of uids) {
      const a = accountOfMember(t.tid, uid);
      const ml = memberLimitOf(ctx, uid);
      if (ml.limit !== null) {
        const mp = (usedOf(q, ctx, uid) / ml.limit) * 100;
        for (const th of plan.alert_thresholds) if (mp >= th) once(`${q.period_key}:m:${uid}:${th}`, () => addAlert({ kind: th >= 100 ? "exhausted" : "threshold", level: th >= 100 ? "warn" : "info", tid: t.tid, aid: a?.aid ?? null, provider: null, pct: th, message: `${a?.email ?? uid} 个人额度已用 ${th}%` }));
      }
      // 异常：最近 1 小时 > 本期总额度 5%，且 > 近 7 日小时均值的 10 倍
      const hour = ctx.book.window(t.tid, uid, 1, ctx.t);
      const hourUsed = plan.quota_unit === "tokens" ? hour.tokens : hour.value;
      if (tot.total > 0 && hourUsed > tot.total * 0.05) {
        const week = usedIn(plan.quota_unit, ctx.book.member(t.tid, uid, dayOf(ctx.t - 7 * DAY_MS), dayOf(ctx.t)));
        if (hourUsed > (week / 168) * 10) once(`${q.period_key}:anomaly:${uid}:${Math.floor(ctx.t / 3600_000)}`, () => addAlert({ kind: "anomaly", level: "warn", tid: t.tid, aid: a?.aid ?? null, provider: null, pct: Math.round((hourUsed / tot.total) * 100), message: `${a?.email ?? uid} 最近 1 小时用量异常（占本期总额度 ${Math.round((hourUsed / tot.total) * 100)}%）` }));
      }
    }
  };
  /** 上游健康变差时记告警（每个上游每小时至多一条）。 */
  const routeAlertSent = new Map<string, number>();
  const checkRouteAlerts = (): void => {
    for (const p of routing.providers) {
      if (!p.enabled) continue;
      const states = Object.values(routing.health).map((h) => h.providers[p.id]?.state).filter(Boolean);
      if (!states.length || !states.every((x) => x === "down" || x === "key_unusable" || x === "blocked_by_allowlist")) continue;
      const last = routeAlertSent.get(p.id) ?? 0;
      if (now() - last < 3600_000) continue;
      routeAlertSent.set(p.id, now());
      addAlert({ kind: "route_down", level: "critical", tid: null, aid: null, provider: p.id, pct: null, message: `上游“${p.label}”不可用（${states[0]}）` });
    }
  };
  /** 一次请求预估所需（内部单位）：网关给出别名与估算 token，控制面按当前价目折算。 */
  const needUnits = (plan: PlanSpec, est: unknown): number => {
    const e = (est && typeof est === "object" ? est : {}) as Record<string, unknown>;
    const input = nnInt(e.input);
    const output = nnInt(e.output);
    if (plan.quota_unit === "tokens") return Math.max(1, input + output);
    const alias = typeof e.alias === "string" ? e.alias : "";
    const item = currentPrices(routing).items[alias];
    const m = chargeOf(item, { input, cached: 0, output });
    if (m.value_micro === null) throw new QuotaError(503, "price_unconfigured", "这个模型还没有定价：按金额计的套餐暂不可用，请联系管理员");
    return Math.max(1, m.value_micro);
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
  const issuerKind = (by: string) => (by === "ops" || /^op_[0-9]+$/.test(by) ? by : by.startsWith("account:") ? "account" : "firm_admin");
  const cny = (micro: number) => Math.round(micro / 100) / 10_000;
  const tenantStatus = (t: TenantRecord): "active" | "pending" | "expired" | "terminated" => {
    if (Date.parse(t.subscription_until) <= now()) return Date.parse(t.license.expires_at) <= Date.parse(t.license.issued_at) + 1 ? "terminated" : "expired";
    return t.root_public_key_pem ? "active" : "pending";
  };
  /** 客户（律所）一行（运营接口契约 §2 TenantRow）。 */
  const tenantRow = (t: TenantRecord) => {
    const { q, ctx } = qOf(t);
    const plan = ctx.plan;
    const unit = plan.quota_unit;
    const tot = totalsOf(q, ctx);
    const used = usedOf(q, ctx);
    const b = periodBounds(plan.period, now());
    const agg = book.tenant(t.tid, q.period_from, q.period_to);
    const tAccounts = [...accounts.values()].filter((a) => a.tid === t.tid);
    return {
      tid: t.tid,
      name: t.name ?? t.tid.replace(/^ten_/, ""),
      edition: t.edition,
      plan: { id: plan.id, label: plan.label },
      seats: t.seats,
      seats_used: [...t.seatsByUser.values()].filter((x) => !x.revoked_at).length,
      status: tenantStatus(t),
      subscription_until: t.subscription_until,
      created_at: t.created_at,
      created_via: t.created_via ?? "ops",
      accounts_required: t.accounts_required === true,
      unit,
      period: { kind: plan.period, key: b.key, start: b.start, resets_at: b.resets_at },
      used: unitOut(unit, used),
      total: unitOut(unit, tot.total),
      used_ratio: ratio(used, tot.total),
      in_flight_ratio: ratio(outstanding(q), tot.total),
      cap_pct: q.cap_pct,
      boost_pct: tot.boost_pct,
      paused: pausedOf(q, ctx),
      forecast_exhaust_at: forecastExhaust(q, ctx),
      accounts: tAccounts.length,
      devices: [...t.devices.values()].filter((d) => !d.revoked_at).length,
      alerts_open: alerts.filter((x) => x.tid === t.tid && !x.acked_at).length,
      value_cny: agg.requests && agg.unpriced && !agg.value_micro ? null : cny(agg.value_micro),
      cost_cny: agg.requests && agg.uncosted && !agg.cost_micro ? null : cny(agg.cost_micro),
      requests: agg.requests,
      legacy_used_ratio: q.legacy && q.legacy.period_key === q.period_key ? q.legacy.used_ratio : null,
      root_enrolled: t.root_public_key_pem !== null,
    };
  };
  const billRow = (t: TenantRecord, month: string) => {
    const plan = planFor(t);
    const { q } = qOf(t);
    const rows = book.monthRows(month).filter((r) => r.tid === t.tid);
    const agg = emptyAgg();
    for (const r of rows) addAgg(agg, { requests: 1, tokens_in: r.usage?.input ?? 0, tokens_cached: r.usage?.cached ?? 0, tokens_out: r.usage?.output ?? 0, value_micro: r.value_micro ?? 0, cost_micro: r.cost_micro ?? 0, errors: 0, estimated: 0, unpriced: r.usage && r.value_micro === null ? 1 : 0, uncosted: r.usage && r.cost_micro === null ? 1 : 0 });
    // 加量只有本期有记录（跨期清零）；历史月份的加量百分比取历史行
    const cur = periodBounds("month", now()).key === month;
    const boost = cur ? q.boosts.reduce((s2, x) => s2 + x.pct, 0) : 0;
    return { tid: t.tid, name: t.name ?? t.tid.replace(/^ten_/, ""), plan: { id: plan.id, label: plan.label }, seats: t.seats, ...periodBill({ plan, seats: t.seats, boost_pct: boost, value_micro: agg.value_micro, cost_micro: agg.cost_micro, unpriced: agg.unpriced, uncosted: agg.uncosted, requests: agg.requests }), requests: agg.requests, tokens: agg.tokens_in + agg.tokens_out, unpriced_rows: agg.unpriced };
  };
  const deviceRow = (t: TenantRecord, d: DeviceRecord) => {
    const a = accountOfMember(t.tid, d.cert.memberId);
    const live = [...sessions.values()].some((x) => x.device_id === d.cert.deviceId && accounts.get(x.aid)?.tid === t.tid && sessionLive(x, now()));
    const flags: string[] = [];
    const since = new Date(now() - 30 * DAY_MS).toISOString().slice(0, 10);
    if (!d.revoked_at && (!d.client_seen_on || d.client_seen_on < since)) flags.push("stale");
    const newest = [...tenants.values()].flatMap((x) => [...x.devices.values()]).map((x) => x.client_version).filter((v): v is string => !!v && v !== "legacy").sort((x, y) => cmpVer(y, x))[0];
    if (!d.revoked_at && d.client_version && newest && (d.client_version === "legacy" || cmpVer(d.client_version, newest) < 0)) flags.push("outdated");
    if (!d.revoked_at && t.accounts_required === true && !live) flags.push("suspended");
    // 没有账号的成员：设备编号与成员编号里含成员标识（可能是姓名拼音），只给证书指纹（复核 RA10B-05）
    return { tid: t.tid, tenant_name: t.name ?? t.tid.replace(/^ten_/, ""), device_id: a ? d.cert.deviceId : `fp:${certFingerprint(d.cert)}`, uid: a ? d.cert.memberId : null, aid: a?.aid ?? null, email: a?.email ?? null, role: d.cert.role, client_version: d.client_version ?? null, last_seen_on: d.client_seen_on ?? null, registered_at: d.registered_at, revoked_at: d.revoked_at, session: live ? "active" : "none", flags };
  };
  const cmpVer = (x: string, y: string): number => {
    const px = x.split(/[.-]/).map((n) => Number(n) || 0);
    const py = y.split(/[.-]/).map((n) => Number(n) || 0);
    for (let i = 0; i < 3; i++) if ((px[i] ?? 0) !== (py[i] ?? 0)) return (px[i] ?? 0) - (py[i] ?? 0);
    return 0;
  };
  const accountRow = (a: AccountRecord) => {
    const t = tenants.get(a.tid);
    let usedRatio: number | null = null;
    if (t) {
      const { q, ctx } = qOf(t);
      const ml = memberLimitOf(ctx, uidOfAccount(a));
      usedRatio = ratio(usedOf(q, ctx, uidOfAccount(a)), ml.limit ?? seatQuotaUnits(ctx.plan));
    }
    return {
      aid: a.aid,
      email: a.email,
      name: a.name,
      status: a.status,
      disabled_reason: a.disabled_reason,
      tid: a.tid,
      tenant_name: t?.name ?? a.tid.replace(/^ten_/, ""),
      role: a.role,
      member_slug: a.member_slug,
      created_at: a.created_at,
      created_via: a.created_via,
      last_login_at: a.last_login_at,
      has_password: a.pw !== null,
      devices: accountDevices(a).filter((d) => !d.revoked_at).length,
      device_limit: deviceLimitOf(a),
      sessions_active: liveSessionsOf(a.aid).length,
      quota_limit: a.quota_limit,
      used_ratio: usedRatio,
      locked: locked(a, now()) > 0,
    };
  };
  const accountUsage = (a: AccountRecord) => {
    const t = tenantOf(a.tid);
    const { q, ctx } = qOf(t);
    const unit = ctx.plan.quota_unit;
    const uid = uidOfAccount(a);
    const agg = book.member(t.tid, uid, q.period_from, q.period_to);
    const ml = memberLimitOf(ctx, uid);
    const denom = ml.limit ?? seatQuotaUnits(ctx.plan);
    const used = usedIn(unit, agg);
    const from = dayOf(now() - 29 * DAY_MS);
    const daily = [...book.daily(null, from, dayOf(now()))].length ? lastDays(30).map((day) => ({ day, used: unitOut(unit, usedIn(unit, book.member(t.tid, uid, day, day))), requests: book.member(t.tid, uid, day, day).requests })) : [];
    const models = [...book.group("member", t.tid, q.period_from, q.period_to)].length ? memberModels(t.tid, uid, q.period_from, q.period_to, unit) : [];
    const pb = periodBounds(ctx.plan.period, now());
    return { unit, period: { kind: ctx.plan.period, key: pb.key, start: pb.start, resets_at: pb.resets_at }, used: unitOut(unit, used), total: unitOut(unit, denom), used_ratio: ratio(used, denom), denominator: ml.limit !== null ? ml.source : "seat_quota", enforced: ml.limit !== null, requests: agg.requests, tokens: agg.tokens_in + agg.tokens_out, value_cny: agg.requests && agg.unpriced && !agg.value_micro ? null : cny(agg.value_micro), by_model: models, daily };
  };
  const lastDays = (n: number): string[] => Array.from({ length: n }, (_, i) => dayOf(now() - (n - 1 - i) * DAY_MS));
  /** 成员按模型（账本没有“成员 × 模型”的聚合：从已载入行现算）。 */
  const memberModels = (tid: string, uid: string, from: string, to: string, unit: "tokens" | "cny") => {
    const m = new Map<string, Agg>();
    for (const r of book.query({ tid, from, to, limit: 200 }).rows) {
      if (r.uid !== uid) continue;
      const k = r.alias ?? "";
      addAgg(m.get(k) ?? (m.set(k, emptyAgg()), m.get(k)!), { requests: 1, tokens_in: r.usage?.input ?? 0, tokens_cached: r.usage?.cached ?? 0, tokens_out: r.usage?.output ?? 0, value_micro: r.value_micro ?? 0, cost_micro: r.cost_micro ?? 0, errors: 0, estimated: 0, unpriced: 0, uncosted: 0 });
    }
    return [...m].map(([alias, a]) => ({ alias, used: unitOut(unit, usedIn(unit, a)), requests: a.requests }));
  };
  const tenantUsage = (t: TenantRecord) => {
    const { q, ctx } = qOf(t);
    const unit = ctx.plan.quota_unit;
    const tot = totalsOf(q, ctx);
    const used = usedOf(q, ctx);
    const view = quotaView(q, ctx, { detail: true, uid: null, sid: null, memberName: () => null });
    const byMember = [...book.group("member", t.tid, q.period_from, q.period_to)].map(([k, a]) => {
      const uid = k.split("\u0000")[1] || null;
      const acc = uid ? accountOfMember(t.tid, uid) : undefined;
      const u = usedIn(unit, a);
      const ml = uid ? memberLimitOf(ctx, uid) : { limit: null };
      return { aid: acc?.aid ?? null, uid, email: acc?.email ?? null, name: acc?.name ?? null, used: unitOut(unit, u), used_ratio_of_firm: ratio(u, tot.total), own_ratio: ratio(u, ml.limit ?? seatQuotaUnits(ctx.plan)), requests: a.requests };
    }).sort((x, y) => y.used_ratio_of_firm - x.used_ratio_of_firm);
    return {
      unit,
      period: view.period,
      used: unitOut(unit, used),
      total: unitOut(unit, tot.total),
      used_ratio: ratio(used, tot.total),
      burst: view.burst,
      history: view.history,
      daily: lastDays(30).map((day) => {
        const a = book.tenant(t.tid, day, day);
        return { day, used: unitOut(unit, usedIn(unit, a)), requests: a.requests };
      }),
      by_model: view.models,
      by_account: byMember,
      boosts: q.boosts,
      cap_set_at: q.cap_set_at,
      cap_set_by: q.cap_set_by === null ? null : issuerKind(q.cap_set_by),
      unreconciled_leases: Object.values(q.leases).filter((l) => l.unreconciled).length,
      open_leases: Object.values(q.leases).filter((l) => !l.closed_at).length,
    };
  };
  const alertView = (x: AlertRecord) => ({ ...x, tenant_name: x.tid ? (tenants.get(x.tid)?.name ?? x.tid.replace(/^ten_/, "")) : null, email: x.aid ? (accounts.get(x.aid)?.email ?? null) : null });
  const usageRowView = (r: UsageRow) => ({ ...r, tenant_name: tenants.get(r.tid)?.name ?? r.tid.replace(/^ten_/, ""), email: r.aid ? (accounts.get(r.aid)?.email ?? null) : null, value_cny: r.value_micro === null ? null : cny(r.value_micro), cost_cny: r.cost_micro === null ? null : cny(r.cost_micro) });
  const dayParam = (qs: URLSearchParams, k: string, dflt: string): string => {
    const v = qs.get(k);
    if (v === null || v === "") return dflt;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new CpError(400, "date_invalid", `${k} 须为 YYYY-MM-DD`);
    return v;
  };
  const usageQuery = (qs: URLSearchParams, limitMax: number) => {
    const lim = Number(qs.get("limit") ?? "50");
    return {
      from: dayParam(qs, "from", dayOf(now() - 29 * DAY_MS)),
      to: dayParam(qs, "to", dayOf(now())),
      ...(qs.get("tid") ? { tid: qs.get("tid")! } : {}),
      ...(qs.get("aid") ? { aid: qs.get("aid")! } : {}),
      ...(qs.get("alias") ? { alias: qs.get("alias")! } : {}),
      ...(qs.get("outcome") ? { outcome: qs.get("outcome")! } : {}),
      ...(qs.get("request_id") ? { request_id: qs.get("request_id")! } : {}),
      ...(qs.get("cursor") ? { cursor: qs.get("cursor")! } : {}),
      limit: Number.isSafeInteger(lim) && lim >= 1 ? Math.min(lim, limitMax) : 50,
    };
  };
  const csvCell = (v: unknown) => {
    const t = v === null || v === undefined ? "" : String(v);
    // 防 CSV 公式注入：以 = + - @ 开头的加单引号
    const safe = /^[=+\-@]/.test(t) ? `'${t}` : t;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const csv = (header: string[], rows: unknown[][]) => `﻿${[header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
  /** CSV 应答（运营接口里唯一不回 JSON 的）：路由返回这个形状，由 opsRoute 原样发出。 */
  type CsvOut = { __csv: string; filename: string };
  const planView = (p: PlanSpec) => ({ ...p, seat_quota_display: p.quota_unit === "tokens" ? `${p.seat_quota} tokens` : `¥${p.seat_quota}` });
  type OpsSpec = {
    perm: OpsPermission;
    action: string;
    /** 租户与目标编号（内部访问审计用；开通时租户编号在请求体里）。 */
    tid: (b: Record<string, unknown>) => string | null;
    target: (b: Record<string, unknown>) => string | null;
    run: (b: Record<string, unknown>, who: OpsAuthorized) => unknown;
  };
  /** 账号写操作的律所审计（律所可见流水：执行者 = 运营编号，目标 = 账号编号，不记邮箱）。 */
  const accountAudit = (a: AccountRecord, action: string, who: OpsAuthorized) => audit({ tid: a.tid, actor: { kind: "ops", id: who.operator }, action, target: a.aid, result: "ok" });
  const accountOf = (aid: string): AccountRecord => {
    const a = accounts.get(aid);
    if (!a) throw new CpError(404, "account_unknown", "没有这个账号");
    return a;
  };
  /** 运营路由只按方法与路径确定（先鉴权、后解析请求体；复核 RA10B-21）；GET 可带查询串。 */
  const opsSpec = (method: string, p: string, qs: URLSearchParams): OpsSpec | null => {
    const none = () => null;
    const read = (action: string, run: () => unknown, perm: OpsPermission = "tenant.read"): OpsSpec => ({ perm, action, tid: none, target: none, run });
    // ─── 总览 ───
    if (method === "GET" && p === "/v1/ops/overview")
      return read("overview.read", () => {
        const days = Math.min(90, Math.max(7, Number(qs.get("days") ?? "30") || 30));
        const from = dayOf(now() - (days - 1) * DAY_MS);
        const to = dayOf(now());
        const b = periodBounds("month", now());
        const tot = book.daily(null, b.fromDay, b.toDay);
        const sum = emptyAgg();
        for (const a of tot.values()) addAgg(sum, a);
        const revenue = [...tenants.values()].map((t) => billRow(t, b.key).revenue_cny).reduce<number | null>((s2, v) => (v === null ? s2 : (s2 ?? 0) + v), null);
        const daily = book.daily(null, from, to);
        const allAcc = [...accounts.values()];
        const allDev = [...tenants.values()].flatMap((t) => [...t.devices.values()].filter((d) => !d.revoked_at).map((d) => deviceRow(t, d)));
        const since7 = iso(now() - 7 * DAY_MS);
        const byModel = new Map<string, Agg>();
        for (const t of tenants.values()) for (const [alias, a] of book.group("model", t.tid, b.fromDay, b.toDay)) addAgg(byModel.get(alias) ?? (byModel.set(alias, emptyAgg()), byModel.get(alias)!), a);
        const allTok = [...byModel.values()].reduce((s2, a) => s2 + a.tokens_in + a.tokens_out, 0);
        return {
          generated_at: iso(),
          period: { kind: "month", key: b.key, start: b.start, resets_at: b.resets_at },
          // 有用量却全部未定价：显示“未定价”（null），不显示 0
          totals: { requests: sum.requests, tokens_in: sum.tokens_in, tokens_cached: sum.tokens_cached, tokens_out: sum.tokens_out, value_cny: sum.unpriced && !sum.value_micro ? null : cny(sum.value_micro), cost_cny: sum.uncosted && !sum.cost_micro ? null : cny(sum.cost_micro), revenue_cny: revenue, margin_cny: revenue === null || (sum.uncosted && !sum.cost_micro) ? null : Math.round((revenue - cny(sum.cost_micro)) * 100) / 100, errors: sum.errors, estimated_rows: sum.estimated, unpriced_rows: sum.unpriced },
          accounts: { total: allAcc.length, active_7d: allAcc.filter((a) => a.last_login_at && a.last_login_at >= since7).length, new_7d: allAcc.filter((a) => a.created_at >= since7).length, disabled: allAcc.filter((a) => a.status === "disabled").length },
          tenants: { total: tenants.size, active: [...tenants.values()].filter((t) => tenantStatus(t) === "active").length, pending: [...tenants.values()].filter((t) => tenantStatus(t) === "pending").length, expiring_30d: [...tenants.values()].filter((t) => Date.parse(t.subscription_until) > now() && Date.parse(t.subscription_until) < now() + 30 * DAY_MS).length },
          devices: { total: allDev.length, active_7d: allDev.filter((d) => d.last_seen_on && d.last_seen_on >= dayOf(now() - 7 * DAY_MS)).length, flagged: allDev.filter((d) => d.flags.length > 0).length },
          daily: lastDays(days).map((day) => {
            const a = daily.get(day) ?? emptyAgg();
            return { day, requests: a.requests, tokens: a.tokens_in + a.tokens_out, value_cny: cny(a.value_micro), cost_cny: cny(a.cost_micro), errors: a.errors };
          }),
          by_model: [...byModel].map(([alias, a]) => ({ alias, label: routing.models.find((m) => m.alias === alias)?.label ?? alias, requests: a.requests, tokens: a.tokens_in + a.tokens_out, value_cny: cny(a.value_micro), share: ratio(a.tokens_in + a.tokens_out, allTok) })).sort((x, y) => y.tokens - x.tokens),
          attention: alerts.filter((x) => !x.acked_at).slice(0, 20).map(alertView),
          routing: { version: routing.version, providers: routing.providers.map((x) => { const h = routingView(routing, routingKeyId).providers.find((y) => y.id === x.id)?.health; return { id: x.id, label: x.label, enabled: x.enabled, state: x.enabled ? (h?.state ?? "unknown") : "disabled", latency_ms: h?.latency_ms ?? null, updated_at: h?.updated_at ?? null }; }) },
        };
      });
    // ─── 套餐与注册设置 ───
    if (method === "GET" && p === "/v1/ops/plans") return read("plan.list", () => ({ plans: catalog.plans.map(planView), default_plan: catalog.default_plan }));
    const pl = /^\/v1\/ops\/plans\/([a-z0-9][a-z0-9-]{0,23})$/.exec(p);
    if (method === "PUT" && pl)
      return {
        perm: "plan.manage",
        action: "plan.upsert",
        tid: none,
        target: () => pl[1]!,
        run: (b) => {
          const prev = catalog.plans.find((x) => x.id === pl[1]);
          const next = validatePlan(pl[1]!, b, "ops", prev);
          if (prev) Object.assign(prev, next);
          else {
            if (catalog.plans.length >= 20) throw new CpError(409, "too_many_plans", "套餐过多（至多 20 个）");
            catalog.plans.push(next);
          }
          if (b.make_default === true) catalog.default_plan = next.id;
          return { ok: true, plan: planView(next), default_plan: catalog.default_plan };
        },
      };
    if (method === "GET" && p === "/v1/ops/settings") return read("settings.read", () => ({ ...catalog.settings, mail: { configured: !!o.mailer, from: o.mailer?.from ?? null } }));
    if (method === "PUT" && p === "/v1/ops/settings")
      return {
        perm: "plan.manage",
        action: "settings.update",
        tid: none,
        target: none,
        run: (b) => {
          catalog.settings = validateSettings(b, catalog.plans, catalog.settings);
          return { ok: true, ...catalog.settings, mail: { configured: !!o.mailer, from: o.mailer?.from ?? null } };
        },
      };
    // ─── 告警 ───
    if (method === "GET" && p === "/v1/ops/alerts") {
      const all = qs.get("status") === "all";
      const lim = Math.min(500, Math.max(1, Number(qs.get("limit") ?? "100") || 100));
      return read("alert.list", () => ({ alerts: alerts.filter((x) => all || !x.acked_at).slice(0, lim).map(alertView) }));
    }
    const ak = /^\/v1\/ops\/alerts\/(alr_[A-Za-z0-9_-]{16})\/ack$/.exec(p);
    if (method === "POST" && ak)
      return {
        perm: "tenant.read",
        action: "alert.ack",
        tid: none,
        target: () => ak[1]!,
        run: (_b, who) => {
          const x = alerts.find((y) => y.id === ak[1]);
          if (!x) throw new CpError(404, "alert_unknown", "没有这条告警");
          if (!x.acked_at) Object.assign(x, { acked_at: iso(), acked_by: who.operator });
          return { ok: true, alert: alertView(x) };
        },
      };
    // ─── 账号 ───
    if (method === "GET" && p === "/v1/ops/accounts")
      return read("account.list", () => {
        const q = (qs.get("q") ?? "").trim().toLowerCase();
        const tid = qs.get("tid");
        const status = qs.get("status");
        const lim = Math.min(200, Math.max(1, Number(qs.get("limit") ?? "50") || 50));
        const cursor = qs.get("cursor");
        let list = [...accounts.values()].sort((x, y) => y.created_at.localeCompare(x.created_at) || x.aid.localeCompare(y.aid));
        if (q) list = list.filter((a) => a.email.includes(q) || a.name.toLowerCase().includes(q) || (tenants.get(a.tid)?.name ?? a.tid).toLowerCase().includes(q));
        if (tid) list = list.filter((a) => a.tid === tid);
        if (status === "active" || status === "disabled") list = list.filter((a) => a.status === status);
        const start = cursor ? Math.max(0, list.findIndex((a) => a.aid === cursor) + 1) : 0;
        const page = list.slice(start, start + lim);
        return { accounts: page.map(accountRow), next: start + lim < list.length ? page[page.length - 1]!.aid : null, total: list.length };
      });
    if (method === "POST" && p === "/v1/ops/accounts")
      return {
        perm: "account.manage",
        action: "account.create",
        tid: (b) => (typeof b.tid === "string" ? b.tid : null),
        target: none,
        run: (b, who) => {
          const t = tenantOf(String(b.tid ?? ""));
          if (!firmSlugOf(t.tid)) throw new CpError(400, "tid_not_activatable", "租户编号须为 ten_<律所标识>");
          const email = normalizeEmail(b.email);
          if (!email) throw new CpError(400, "email_invalid", "邮箱格式不对");
          if (accountByEmail.has(email)) throw new CpError(409, "email_taken", "这个邮箱已有账号");
          if (!validName(b.name)) throw new CpError(400, "name_invalid", "姓名须为 1–40 个字符");
          const role = b.role === undefined ? "lawyer" : b.role;
          if (role !== "admin" && role !== "partner" && role !== "lawyer" && role !== "assistant") throw new CpError(400, "role_invalid", "角色须为 admin / partner / lawyer / assistant");
          if (role !== "admin" && !t.root_public_key_pem) throw new CpError(409, "founder_first", "这家律所还没有完成开通：先为负责人建管理员账号");
          if (role === "admin" && !t.root_public_key_pem && [...accounts.values()].some((a) => a.tid === t.tid && a.role === "admin")) throw new CpError(409, "founder_exists", "这家律所已有创始管理员账号");
          const a: AccountRecord = { aid: newId("acc"), email, name: String(b.name).trim(), status: "active", disabled_reason: null, tid: t.tid, member_slug: newMemberSlug(t, email), role, pw: null, pw_changed_at: null, created_at: iso(), created_via: "ops", last_login_at: null, failed: { count: 0, first_at: null, locked_until: null }, device_limit: null, quota_limit: null };
          accounts.set(a.aid, a);
          indexAccount(a);
          const c = issueAccountCode(a, "setup", 24 * 3600_000, who.operator);
          accountAudit(a, "account.create", who);
          return { ok: true, account: accountRow(a), setup_code: formatOneTimeCode(c.code), expires_at: c.expires_at };
        },
      };
    const acm = /^\/v1\/ops\/accounts\/(acc_[A-Za-z0-9_-]{16})(?:\/([a-z-]+(?:\/[a-z-]+)?))?$/.exec(p);
    if (acm) {
      const aid = acm[1]!;
      const sub = acm[2] ?? "";
      const tgt = () => aid;
      const tidOf = () => accounts.get(aid)?.tid ?? null;
      if (method === "GET" && sub === "")
        return {
          perm: "tenant.read",
          action: "account.read",
          tid: tidOf,
          target: tgt,
          run: () => {
            const a = accountOf(aid);
            const t = tenants.get(a.tid);
            return {
              account: accountRow(a),
              devices: t ? accountDevices(a).map((d) => deviceRow(t, d)) : [],
              sessions: [...sessions.values()].filter((x) => x.aid === aid && sessionLive(x, now())).map((x) => sessionView(x, null)),
              usage: t ? accountUsage(a) : null,
              alerts: alerts.filter((x) => x.aid === aid).slice(0, 50).map(alertView),
            };
          },
        };
      if (method !== "POST") return null;
      const w = (action: string, run: (a: AccountRecord, b: Record<string, unknown>, who: OpsAuthorized) => unknown): OpsSpec => ({ perm: "account.manage", action, tid: tidOf, target: tgt, run: (b, who) => run(accountOf(aid), b, who) });
      if (sub === "disable")
        return w("account.disable", (a, b, who) => {
          if (b.reason !== undefined && (typeof b.reason !== "string" || b.reason.length > 100)) throw new CpError(400, "reason_invalid", "原因至多 100 个字符");
          a.status = "disabled";
          a.disabled_reason = typeof b.reason === "string" ? b.reason : null;
          const n = revokeSessions((x) => x.aid === a.aid, "account_disabled");
          feedVersion += 1;
          accountAudit(a, "account.disable", who);
          return { ok: true, sessions_revoked: n, account: accountRow(a) };
        });
      if (sub === "enable")
        return w("account.enable", (a, _b, who) => {
          a.status = "active";
          a.disabled_reason = null;
          a.failed = { count: 0, first_at: null, locked_until: null };
          feedVersion += 1;
          accountAudit(a, "account.enable", who);
          return { ok: true, account: accountRow(a) };
        });
      if (sub === "reset-code")
        return w("account.reset_code", (a, _b, who) => {
          const c = issueAccountCode(a, a.pw ? "reset" : "setup", (a.pw ? 30 * 60_000 : 24 * 3600_000), who.operator);
          accountAudit(a, "account.reset_code", who);
          return { ok: true, reset_code: formatOneTimeCode(c.code), expires_at: c.expires_at, purpose: a.pw ? "reset" : "setup" };
        });
      if (sub === "sessions/revoke")
        return w("account.sessions_revoke", (a, _b, who) => {
          const n = revokeSessions((x) => x.aid === a.aid, "ops_revoked");
          accountAudit(a, "account.sessions_revoke", who);
          return { ok: true, revoked: n };
        });
      if (sub === "limits")
        return w("account.limits", (a, b, who) => {
          const t = tenantOf(a.tid);
          const unit = planFor(t).quota_unit;
          if ("quota_limit" in b) {
            const v = b.quota_limit;
            if (v !== null && !(typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1e13 && (unit === "cny" || Number.isSafeInteger(v)))) throw new CpError(400, "quota_limit_invalid", unit === "tokens" ? "个人上限须为正整数 token，或不设（null）" : "个人上限须为正数（元），或不设（null）");
            a.quota_limit = v as number | null;
          }
          if ("device_limit" in b) {
            const v = b.device_limit;
            if (v !== null && !(Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= MAX_DEVICES_PER_ACCOUNT)) throw new CpError(400, "device_limit_invalid", `设备数须为 1–${MAX_DEVICES_PER_ACCOUNT}，或按套餐（null）`);
            a.device_limit = v as number | null;
          }
          accountAudit(a, "account.limits", who);
          return { ok: true, account: accountRow(a), unit };
        });
      return null;
    }
    // ─── 设备 ───
    if (method === "GET" && p === "/v1/ops/devices")
      return read("device.list", () => {
        const tid = qs.get("tid");
        const status = qs.get("status");
        const flag = qs.get("flag");
        let list = [...tenants.values()].filter((t) => !tid || t.tid === tid).flatMap((t) => [...t.devices.values()].map((d) => deviceRow(t, d)));
        if (status === "active") list = list.filter((d) => !d.revoked_at);
        if (status === "revoked") list = list.filter((d) => d.revoked_at);
        if (flag) list = list.filter((d) => d.flags.includes(flag));
        return { devices: list.sort((x, y) => (y.last_seen_on ?? "").localeCompare(x.last_seen_on ?? "")).slice(0, 2000) };
      });
    // ─── 模型与路由 ───
    if (method === "GET" && p === "/v1/ops/routing") return read("routing.read", () => routingView(routing, routingKeyId));
    const rp = /^\/v1\/ops\/routing\/providers\/([a-z][a-z0-9-]{1,31})(\/probe)?$/.exec(p);
    if (rp) {
      const id = rp[1]!;
      if (method === "PUT" && !rp[2]) return { perm: "route.manage", action: "routing.provider_upsert", tid: none, target: () => id, run: (b, who) => ({ ok: true, created: upsertProvider(routing, id, b, now(), who.operator, routingKeyId), routing: routingView(routing, routingKeyId) }) };
      if (method === "DELETE" && !rp[2]) return { perm: "route.manage", action: "routing.provider_delete", tid: none, target: () => id, run: (_b, who) => (deleteProvider(routing, id, now(), who.operator), { ok: true, routing: routingView(routing, routingKeyId) }) };
      if (method === "POST" && rp[2]) return { perm: "route.manage", action: "routing.probe", tid: none, target: () => id, run: () => ({ ok: true, probe_requested_at: requestProbe(routing, id, now()) }) };
      return null;
    }
    const rm = /^\/v1\/ops\/routing\/models\/([^/]{1,160})$/.exec(p);
    if (rm) {
      let alias = "";
      try {
        alias = decodeURIComponent(rm[1]!);
      } catch {
        alias = "";
      }
      if (method === "PUT") return { perm: "route.manage", action: "routing.model_upsert", tid: none, target: () => alias, run: (b, who) => ({ ok: true, created: upsertModel(routing, alias, b, now(), who.operator), routing: routingView(routing, routingKeyId) }) };
      if (method === "DELETE") return { perm: "route.manage", action: "routing.model_delete", tid: none, target: () => alias, run: (_b, who) => (deleteModel(routing, alias, now(), who.operator), { ok: true, routing: routingView(routing, routingKeyId) }) };
      return null;
    }
    if (method === "PUT" && p === "/v1/ops/routing/prices") return { perm: "route.manage", action: "routing.prices", tid: none, target: none, run: (b, who) => ({ ok: true, version: setPrices(routing, b.items, now(), who.operator), routing: routingView(routing, routingKeyId) }) };
    // ─── 用量 ───
    if (method === "GET" && p === "/v1/ops/usage/summary")
      return read("usage.summary", () => {
        const f = usageQuery(qs, 200);
        const group = qs.get("group") ?? "day";
        if (!["day", "model", "tenant", "account"].includes(group)) throw new CpError(400, "group_invalid", "group 须为 day / model / tenant / account");
        const out = (key: string, label: string, a: Agg) => ({ key, label, requests: a.requests, tokens_in: a.tokens_in, tokens_cached: a.tokens_cached, tokens_out: a.tokens_out, value_cny: cny(a.value_micro), cost_cny: cny(a.cost_micro), errors: a.errors, estimated: a.estimated, unpriced: a.unpriced });
        let rows: ReturnType<typeof out>[] = [];
        const tidF = f.tid ?? null;
        if (f.aid) {
          const a = accountOf(f.aid);
          const uid = uidOfAccount(a);
          rows = group === "day" ? lastDaysBetween(f.from, f.to).map((day) => out(day, day, book.member(a.tid, uid, day, day))) : [out(a.aid, a.email, book.member(a.tid, uid, f.from, f.to))];
        } else if (group === "day") {
          const d = book.daily(tidF, f.from, f.to);
          rows = lastDaysBetween(f.from, f.to).map((day) => out(day, day, d.get(day) ?? emptyAgg()));
        } else if (group === "model") {
          const m = new Map<string, Agg>();
          for (const t of tenants.values()) if (!tidF || t.tid === tidF) for (const [alias, a] of book.group("model", t.tid, f.from, f.to)) addAgg(m.get(alias) ?? (m.set(alias, emptyAgg()), m.get(alias)!), a);
          rows = [...m].map(([alias, a]) => out(alias, routing.models.find((x) => x.alias === alias)?.label ?? alias, a));
        } else if (group === "tenant") {
          rows = [...book.group("tenant", tidF, f.from, f.to)].map(([tid, a]) => out(tid, tenants.get(tid)?.name ?? tid.replace(/^ten_/, ""), a));
        } else {
          rows = [...book.group("member", tidF, f.from, f.to)].map(([k, a]) => {
            const [tid, uid] = k.split("\u0000") as [string, string];
            const acc = uid ? accountOfMember(tid, uid) : undefined;
            return out(acc?.aid ?? k, acc?.email ?? uid ?? "（无账号）", a);
          });
        }
        if (group !== "day") rows.sort((x, y) => y.tokens_in + y.tokens_out - (x.tokens_in + x.tokens_out));
        const sum = emptyAgg();
        for (const r of rows) addAgg(sum, { requests: r.requests, tokens_in: r.tokens_in, tokens_cached: r.tokens_cached, tokens_out: r.tokens_out, value_micro: Math.round(r.value_cny * 1e6), cost_micro: Math.round(r.cost_cny * 1e6), errors: r.errors, estimated: r.estimated, unpriced: r.unpriced, uncosted: 0 });
        return { from: f.from, to: f.to, group, rows, totals: out("total", "合计", sum) };
      });
    // 历史用量补录（主文 §4.6）：升级前网关预写日志里的 settle 行（有上游给的真实 token 数）→ 账本行，按请求编号去重；
    // clear_legacy = 运营确认已交齐全部网关实例本期的日志，清掉该律所本期“旧口径冻结比例”，改按补录的真实用量算
    if (method === "POST" && p === "/v1/ops/usage/backfill")
      return {
        perm: "plan.manage",
        action: "usage.backfill",
        tid: (b) => (typeof b.tid === "string" ? b.tid : null),
        target: none,
        run: (b) => {
          const t = tenantOf(String(b.tid ?? ""));
          const { q, ctx } = qOf(t);
          if (!Array.isArray(b.rows) || b.rows.length > 2000) throw new CpError(400, "rows_invalid", "每次至多 2000 行");
          const seatUid = new Map([...t.seatsByUser.values()].map((x) => [x.sid, x.uid]));
          const rows: UsageRow[] = [];
          let skipped = 0;
          for (const raw of b.rows as Record<string, any>[]) {
            // 旧格式（第 43 批及以前）：kind=settle、requestId、sid、model、status、inputTokens/outputTokens/cachedTokens、reason
            if (!raw || raw.kind !== "settle" || raw.tid !== t.tid || typeof raw.requestId !== "string" || raw.record) {
              skipped += 1;
              continue;
            }
            const has = Number.isSafeInteger(raw.inputTokens) && raw.inputTokens >= 0;
            const uid = typeof raw.sid === "string" ? (seatUid.get(raw.sid) ?? null) : null;
            const r = rowOf(t, { request_id: raw.requestId, client_request_id: raw.clientRequestId ?? null, at: raw.at, sid: raw.sid, uid, alias: raw.model, upstream_model: raw.upstreamModel ?? null, status: raw.status, outcome: has ? "ok" : /timeout/.test(String(raw.reason ?? "")) ? "timeout" : "upstream_error", usage: has ? { input: raw.inputTokens, cached: raw.cachedTokens ?? 0, output: raw.outputTokens ?? 0, reasoning: 0 } : null, usage_source: has ? "upstream" : "none", latency_ms: raw.latencyMs ?? null, finish_reason: raw.finishReason ?? null }, ctx.plan);
            rows.push({ ...r, backfill: true });
          }
          const fresh = book.append(rows.filter((r) => !book.has(r.request_id)));
          let cleared = false;
          if (b.clear_legacy === true && q.legacy) {
            q.legacy = null;
            cleared = true;
          }
          return { ok: true, accepted: fresh.length, duplicates: rows.length - fresh.length, skipped, legacy_cleared: cleared, tenant: tenantRow(t) };
        },
      };
    if (method === "GET" && p === "/v1/ops/usage/records")
      return read("usage.records", () => {
        const r = book.query(usageQuery(qs, 200));
        return { records: r.rows.map(usageRowView), next: r.next };
      });
    if (method === "GET" && p === "/v1/ops/usage/records.csv")
      return read("usage.export", (): CsvOut => {
        const f = usageQuery(qs, 200);
        const rows: UsageRow[] = [];
        let cursor: string | undefined;
        for (let i = 0; i < 500 && rows.length < 100_000; i++) {
          const r = book.query({ ...f, limit: 200, ...(cursor ? { cursor } : {}) });
          rows.push(...r.rows);
          if (!r.next) break;
          cursor = r.next;
        }
        const head = ["时间", "请求编号", "客户端请求编号", "上游请求编号", "律所", "账号", "成员", "设备", "模型别名", "上游", "上游型号", "结果", "状态码", "输入token", "缓存token", "输出token", "用量来源", "售价金额(元)", "成本(元)", "价目版本", "耗时(毫秒)", "尝试次数"];
        return { __csv: csv(head, rows.map((r) => [r.at, r.request_id, r.client_request_id, r.upstream_request_id, tenants.get(r.tid)?.name ?? r.tid, r.aid ? (accounts.get(r.aid)?.email ?? r.aid) : "", r.uid, r.dev, r.alias, r.provider, r.upstream_model, r.outcome, r.status, r.usage?.input ?? "", r.usage?.cached ?? "", r.usage?.output ?? "", r.usage_source, r.value_micro === null ? "" : cny(r.value_micro), r.cost_micro === null ? "" : cny(r.cost_micro), r.price_version, r.latency_ms, r.attempts.length])), filename: `usage-${f.from}-${f.to}.csv` };
      });
    // ─── 计费 ───
    if (method === "GET" && (p === "/v1/ops/billing" || p === "/v1/ops/billing.csv")) {
      const month = qs.get("period") ?? periodBounds("month", now()).key;
      if (!/^\d{4}-\d{2}$/.test(month)) throw new CpError(400, "period_invalid", "period 须为 YYYY-MM");
      return read(p.endsWith(".csv") ? "billing.export" : "billing.read", () => {
        const rows = [...tenants.values()].map((t) => billRow(t, month)).sort((x, y) => (y.revenue_cny ?? 0) - (x.revenue_cny ?? 0) || y.requests - x.requests);
        const add = (k: keyof (typeof rows)[number]) => rows.reduce<number | null>((s2, r) => (typeof r[k] === "number" ? (s2 ?? 0) + (r[k] as number) : s2), null);
        const totals = { seat_fee_cny: add("seat_fee_cny"), boost_fee_cny: add("boost_fee_cny"), revenue_cny: add("revenue_cny"), value_cny: add("value_cny"), cost_cny: add("cost_cny"), margin_cny: add("margin_cny"), requests: add("requests"), tokens: add("tokens") };
        if (p.endsWith(".csv")) return { __csv: csv(["律所", "租户编号", "套餐", "席位", "席位单价(元)", "席位费(元)", "加量(%)", "加量费(元)", "应收(元)", "用量价值(元)", "成本(元)", "毛利(元)", "请求数", "token"], rows.map((r) => [r.name, r.tid, r.plan.label, r.seats, r.seat_price_cny, r.seat_fee_cny, r.boost_pct, r.boost_fee_cny, r.revenue_cny, r.value_cny, r.cost_cny, r.margin_cny, r.requests, r.tokens])), filename: `billing-${month}.csv` } satisfies CsvOut;
        return { period: month, priced: catalog.plans.some((x) => x.seat_price_cny !== null), rows, totals };
      });
    }
    // ─── 系统 ───
    if (method === "GET" && p === "/v1/ops/system")
      return read("system.read", () => {
        const r = o.opsInfo?.roster() ?? null;
        return { deployment: o.opsInfo?.deployment ?? null, server_version: o.serverVersion ?? null, started_at: startedAt, usage_book: { rows_loaded: book.size, load_errors: book.loadErrors }, roster: r ? { version: r.version, expires_at: r.expires_at, operators: r.operators.map((x) => ({ id: x.id, perms: x.perms, keys: x.keys.map((k) => k.kid), revoked: !!x.revoked_at })) } : null, client_versions: cpMetrics().client_versions, quota_counters: { ...quotaCounts } };
      });
    // ─── 客户（律所） ───
    if (method === "POST" && p === "/v1/ops/tenants")
      return {
        perm: "tenant.manage",
        action: "tenant.create",
        tid: (b) => (typeof b.tid === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(b.tid) ? b.tid : null),
        target: none,
        run: (b) => {
          const tid = typeof b.tid === "string" ? b.tid : "";
          // 经运营接口开通的租户一律要求开通码（不能再开“知道租户编号即可抢先登记律所根”的口子）
          if (!firmSlugOf(tid)) throw new CpError(400, "tid_not_activatable", "租户编号须为 ten_<律所标识>");
          if (tenants.has(tid)) throw new CpError(409, "tenant_exists", "租户已存在");
          if (b.edition !== "team" && b.edition !== "firm") throw new CpError(400, "edition_invalid", "版本须为 team 或 firm");
          const seats = intIn(b.seats, 1, 10_000, "seats_invalid", "席位数");
          const subscriptionDays = b.subscription_days === undefined ? 365 : intIn(b.subscription_days, 1, 3650, "days_invalid", "订阅天数");
          if (b.points !== undefined) throw new CpError(400, "points_removed", "已取消点数：额度按“席位 × 套餐”计，加量请用加量包（百分比）");
          if (b.plan !== undefined && (typeof b.plan !== "string" || !catalog.plans.some((x) => x.id === b.plan))) throw new CpError(400, "plan_unknown", "套餐不在目录里");
          if (b.accounts_required !== undefined && typeof b.accounts_required !== "boolean") throw new CpError(400, "accounts_required_invalid", "accounts_required 须为 true 或 false");
          if (b.name !== undefined && typeof b.name !== "string") throw new CpError(400, "tenant_name_invalid", "律所名称须为 1–40 个字符");
          const t = ops.createTenant({ tid, edition: b.edition, seats, subscriptionDays, ...(typeof b.plan === "string" ? { plan: b.plan } : {}), ...(typeof b.name === "string" ? { name: b.name } : {}), activationRequired: true, accountsRequired: b.accounts_required !== false });
          return { ok: true, tenant: tenantRow(t) };
        },
      };
    if (method === "GET" && p === "/v1/ops/tenants") return read("tenant.list", () => ({ tenants: [...tenants.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)).map(tenantRow) }));
    const m = /^\/v1\/ops\/tenants\/([A-Za-z0-9_-]{1,64})(?:\/(.+))?$/.exec(p);
    if (!m) return null;
    const tid = m[1]!;
    const rest = m[2] ?? "";
    const at = () => tid;
    if (method === "GET" && rest === "")
      return {
        perm: "tenant.read",
        action: "tenant.read",
        tid: at,
        target: none,
        run: () => {
          const t = tenantOf(tid);
          const members = new Map<string, { uid: string; member_slug: string; role: string; aid: string | null; email: string | null; name: string | null; seat: { sid: string; revoked_at: string | null } | null; devices: number }>();
          const ensure = (uid: string, role: string) => {
            if (!members.has(uid)) {
              const a = accountOfMember(t.tid, uid);
              const s2 = t.seatsByUser.get(uid);
              members.set(uid, { uid, member_slug: uid.replace(`usr_${t.tid.slice(4)}_`, ""), role, aid: a?.aid ?? null, email: a?.email ?? null, name: a?.name ?? null, seat: s2 ? { sid: s2.sid, revoked_at: s2.revoked_at } : null, devices: 0 });
            }
            return members.get(uid)!;
          };
          for (const d of t.devices.values()) if (!d.revoked_at) ensure(d.cert.memberId, d.cert.role).devices += 1;
          for (const a of accounts.values()) if (a.tid === t.tid) ensure(uidOfAccount(a), a.role);
          for (const s2 of t.seatsByUser.values()) ensure(s2.uid, "lawyer");
          // 没有账号的成员（第 44 批之前入组的）不外露成员标识（复核 RA10B-05：可能是姓名拼音），只给席位编号
          const memberList = [...members.values()].map((x) => (x.aid ? x : { ...x, uid: null, member_slug: null }));
          return {
            tenant: { ...tenantRow(t), activation_required: t.activation_required === true },
            members: memberList,
            devices: [...t.devices.values()].map((d) => deviceRow(t, d)),
            // 只列创始开通码（运营的事）；律所管理员发的成员邀请码只给计数（复核 RA10B-06）
            activation_codes: [...t.activations.values()].filter((r) => r.kind === "founder" && !r.via_account).map((r) => ({ id: r.id, kind: r.kind, status: r.status, created_at: r.created_at, expires_at: r.expires_at, issued_by: issuerKind(r.created_by) })),
            member_invitations: { total: [...t.activations.values()].filter((r) => r.kind === "member" && !r.via_account).length, open: [...t.activations.values()].filter((r) => r.kind === "member" && !r.via_account && r.status === "open").length },
            usage: tenantUsage(t),
            bill: billRow(t, periodBounds("month", now()).key),
            license: { issued_at: t.license.issued_at, expires_at: t.license.expires_at },
          };
        },
      };
    if (method === "GET" && rest === "usage") return { perm: "tenant.read", action: "tenant.usage", tid: at, target: none, run: () => ({ tid, issued_at: iso(), ...tenantUsage(tenantOf(tid)) }) };
    if (method !== "POST") return null;
    if (rest === "activation-codes")
      return {
        perm: "activation.issue",
        action: "activation.issue",
        tid: at,
        target: none,
        run: (b) => {
          const slug = b.slug ?? b.member_slug ?? "admin";
          if (typeof slug !== "string") throw new CpError(400, "member_slug_invalid", "成员标识只允许小写字母、数字、下划线与连字符");
          if (b.name !== undefined && typeof b.name !== "string") throw new CpError(400, "member_name_invalid", "成员姓名须为 1–40 个字符");
          const ttlHours = b.ttl_hours === undefined ? undefined : intIn(b.ttl_hours, 1, 14 * 24, "ttl_invalid", "有效小时数");
          tenantOf(tid);
          return { ok: true, ...ops.issueActivationCode(tid, { member: { slug, ...(typeof b.name === "string" ? { name: b.name } : {}) }, ...(ttlHours !== undefined ? { ttlHours } : {}) }) };
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
    if (rest === "points") return { perm: "quota.manage", action: "quota.grant", tid: at, target: none, run: () => { throw new CpError(410, "points_removed", "已取消点数：请用加量包（按套餐额度的百分比）"); } };
    if (rest === "boost") return { perm: "quota.manage", action: "quota.boost", tid: at, target: none, run: (b) => { ops.boostQuota(tid, b.pct as number); return { ok: true, tenant: tenantRow(tenantOf(tid)) }; } };
    if (rest === "accounts-required")
      return {
        perm: "tenant.manage",
        action: "accounts.policy",
        tid: at,
        target: none,
        run: (b) => {
          if (typeof b.required !== "boolean") throw new CpError(400, "accounts_required_invalid", "required 须为 true 或 false");
          ops.setAccountsRequired(tid, b.required);
          return { ok: true, tenant: tenantRow(tenantOf(tid)) };
        },
      };
    if (rest === "plan")
      return {
        perm: "tenant.manage",
        action: "plan.change",
        tid: at,
        target: none,
        run: (b) => {
          if (b.plan === undefined && b.seats === undefined) throw new CpError(400, "plan_invalid", "须给出套餐 plan 或席位数 seats");
          if (b.plan !== undefined && typeof b.plan !== "string") throw new CpError(400, "plan_unknown", "套餐不在目录里");
          const seats = b.seats === undefined ? undefined : intIn(b.seats, 1, 10_000, "seats_invalid", "席位数");
          ops.setPlan(tid, { ...(typeof b.plan === "string" ? { plan: b.plan } : {}), ...(seats !== undefined ? { seats } : {}) });
          return { ok: true, tenant: tenantRow(tenantOf(tid)) };
        },
      };
    if (rest === "cap")
      return {
        perm: "quota.cap",
        action: "quota.cap_set",
        tid: at,
        target: none,
        run: (b) => {
          if (!("cap_pct" in b)) throw new CpError(400, "cap_invalid", "须给出 cap_pct（1–100 的百分比，或 null 表示不设上限）");
          // 运营代设上限只能调低（复核 RA10A-17）：调高或取消律所已设的上限是放宽律所的管控，须律所管理员自己在客户端操作
          const cur = tenantOf(tid).quota.cap_pct;
          if (cur !== null && (b.cap_pct === null || (typeof b.cap_pct === "number" && b.cap_pct > cur))) throw new CpError(409, "cap_raise_by_firm_only", "调高或取消上限须由律所管理员操作");
          ops.setQuotaCap(tid, b.cap_pct as number | null);
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
          revokeSessions((x) => x.device_id === dv[1] && accounts.get(x.aid)?.tid === tid, "device_revoked");
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
  const lastDaysBetween = (from: string, to: string): string[] => {
    const out: string[] = [];
    for (let t = Date.parse(`${from}T00:00:00+08:00`); out.length < 400; t += DAY_MS) {
      const d = dayOf(t);
      if (d > to) break;
      out.push(d);
    }
    return out;
  };
  const OPS_AUTH_MESSAGE: Record<number, string> = { 401: "运营凭据无效、已吊销或已过期", 403: "没有这项运营权限", 503: "运营名册暂不可用（运营接口暂停，业务不受影响）" };
  /** 账号密码登录相关的原因代码（对外不区分没有这个账号 / 密码错 / 已停用 / 不在名册）。 */
  const OPS_AUTH_TEXT: Record<string, string> = {
    ops_login_invalid: "账号或密码不对",
    ops_login_throttled: "尝试过于频繁，请稍后再试",
    ops_session_invalid: "登录已失效（超时、已退出或密码已被重置），请重新登录",
    ops_password_current_wrong: "当前密码不正确",
    ops_credentials_unavailable: "运营凭据库暂不可用（密码登录暂停），请联系安全管理员",
  };
  const opsAuthCp = (e: OpsAuthError): CpError => {
    const info = e.info;
    let msg = OPS_AUTH_TEXT[e.code] ?? OPS_AUTH_MESSAGE[e.status] ?? "运营凭据无效";
    if (e.code === "ops_login_locked") msg = `尝试次数过多，已暂时锁定，请 ${Math.max(1, Math.ceil(Number(info?.retry_after_ms ?? 0) / 60_000))} 分钟后再试`;
    if (e.code === "ops_password_weak") msg = `新密码需要：${Array.isArray(info?.rules) ? (info!.rules as string[]).join("、") : "至少 12 位，同时包含字母和数字"}`;
    return new CpError(e.status, e.code, msg, info);
  };
  /** 登录、退出、改密码的内部访问审计（不记密码与令牌）；记不进去：登录不发会话、改密码之前不改。 */
  const sessionAccess = (rec: { action: string; operator: string; roster_version: number; result: string; session?: string }) => opsAccess({ at: iso(), action: rec.action, operator: rec.operator, op_key: "password", roster_version: rec.roster_version, tid: null, target: null, result: rec.result, via: "password", ...(rec.session ? { session: rec.session } : {}) });
  const sessionAccessQuiet = (rec: Parameters<typeof sessionAccess>[0]) => {
    try {
      sessionAccess(rec);
    } catch {
      // 失败的尝试本来就被拒了
    }
  };
  /**
   * 账号密码登录（网页运营控制台；凭据与会话在 ops-auth，身份与权限仍按运营名册）：
   * - POST /v1/ops/login {login, password}：不带凭据（核登录名与密码、限频与锁定都在守卫里），成功返回会话令牌（只此一次）；
   * - POST /v1/ops/logout：吊销所带会话（幂等）；GET /v1/ops/me：本人身份与权限（私钥签名与会话都认）；
   * - POST /v1/ops/password {current, next}：本人改密码（须带会话），成功后此人其他会话全部吊销。
   * 返回 true = 已处理。
   */
  const opsSessionRoute = (req: IncomingMessage, res: ServerResponse, method: string, path: string, p: string, raw: string): boolean => {
    if (!o.opsGuard) return false;
    if (method === "POST" && p === "/v1/ops/login") {
      if (!o.opsGuard.login) throw new CpError(404, "not_found", "没有这条路由");
      const b = parseJson(raw);
      let r: OpsLoginResult;
      try {
        r = o.opsGuard.login({ login: b.login, password: b.password, source: sourceOf(req) });
      } catch (e) {
        if (!(e instanceof OpsAuthError)) throw e;
        sessionAccessQuiet({ action: "ops.login", operator: e.claimed ?? "-", roster_version: 0, result: `rejected:${e.code}` });
        throw opsAuthCp(e);
      }
      try {
        sessionAccess({ action: "ops.login", operator: r.operator, roster_version: r.roster_version, result: "ok", session: r.session });
      } catch {
        o.opsGuard.logout?.({ authorization: `Bearer ${r.token}` });
        throw new CpError(503, "ops_access_log_unavailable", "运营访问审计写不进去");
      }
      send(res, 200, { token: r.token, operator: r.operator, login: r.login, perms: r.perms, roster_version: r.roster_version, expires_at: r.expires_at, idle_ms: r.idle_ms, must_change: r.must_change });
      return true;
    }
    if (method === "POST" && p === "/v1/ops/logout") {
      const r = o.opsGuard.logout ? o.opsGuard.logout(req.headers) : null;
      if (r) sessionAccessQuiet({ action: "ops.logout", operator: r.operator, roster_version: 0, result: "ok", session: r.session });
      send(res, 200, { ok: true });
      return true;
    }
    if (method === "GET" && p === "/v1/ops/me") {
      let who: OpsAuthorized;
      try {
        who = o.opsGuard.authorize(req.headers, { method, path, body: raw }, []);
      } catch (e) {
        if (e instanceof OpsAuthError) throw opsAuthCp(e);
        throw e;
      }
      send(res, 200, { operator: who.operator, via: who.via, kid: who.via === "key" ? who.kid : null, login: who.login ?? null, perms: who.perms, roster_version: who.roster_version, expires_at: who.expires_at ?? null, idle_ms: who.idle_ms ?? null, must_change: who.must_change === true, password_login: !!o.opsGuard.login });
      return true;
    }
    if (method === "POST" && p === "/v1/ops/password") {
      if (!o.opsGuard.changePassword) throw new CpError(404, "not_found", "没有这条路由");
      const b = parseJson(raw);
      let r: ReturnType<NonNullable<OpsGuard["changePassword"]>>;
      try {
        r = o.opsGuard.changePassword(req.headers, b.current, b.next);
      } catch (e) {
        if (!(e instanceof OpsAuthError)) throw e;
        sessionAccessQuiet({ action: "ops.password_change", operator: e.claimed ?? "-", roster_version: 0, result: `rejected:${e.code}` });
        throw opsAuthCp(e);
      }
      sessionAccessQuiet({ action: "ops.password_change", operator: r.operator, roster_version: r.roster_version, result: "ok", session: r.session });
      send(res, 200, { ok: true, other_sessions_revoked: r.other_sessions_revoked });
      return true;
    }
    return false;
  };
  const opsRoute = (req: IncomingMessage, res: ServerResponse, method: string, path: string, p: string, raw: string): void => {
    if (!o.opsGuard) throw new CpError(404, "not_found", "没有这条路由");
    // 运营路径按请求行原样匹配（不认点段与编码）：生产入口按原样路径判断来源网段，规范化后才落到运营路由的写法一律不认。
    // 第 44 批：GET 可带查询串（筛选与分页）；签名覆盖完整路径（含查询串，原样）
    const qi = path.indexOf("?");
    const pathOnly = qi < 0 ? path : path.slice(0, qi);
    if (pathOnly !== p || (qi >= 0 && method !== "GET")) throw new CpError(404, "not_found", "没有这条路由");
    if (opsSessionRoute(req, res, method, path, p, raw)) return;
    const spec = opsSpec(method, p, new URLSearchParams(qi < 0 ? "" : path.slice(qi + 1)));
    if (!spec) throw new CpError(404, "not_found", "没有这条路由");
    let who: OpsAuthorized;
    try {
      who = o.opsGuard.authorize(req.headers, { method, path, body: raw }, spec.perm);
    } catch (e) {
      if (e instanceof OpsAuthError) throw opsAuthCp(e);
      throw e;
    }
    const b = method === "GET" ? {} : parseJson(raw);
    const rec = { action: spec.action, operator: who.operator, op_key: who.kid, roster_version: who.roster_version, tid: spec.tid(b), target: spec.target(b), ...(who.via === "password" ? { via: "password" as const, ...(who.session ? { session: who.session } : {}) } : {}) };
    // 初始密码或被重置后：只能改密码、看本人身份、退出（其余运营接口一律 403）
    if (who.must_change) {
      try {
        opsAccess({ at: iso(), ...rec, result: "rejected:password_change_required" });
      } catch {
        // 本来就拒绝
      }
      throw new CpError(403, "password_change_required", "首次登录（或密码被重置后）须先修改密码");
    }
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
        opsAccess({ at: iso(), ...rec, result: `rejected:${e instanceof CpError || e instanceof QuotaError || e instanceof RoutingError || e instanceof PlanError ? e.code : "error"}` });
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
    if (out && typeof out === "object" && "__csv" in (out as object)) {
      const c = out as { __csv: string; filename: string };
      persistNow();
      res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-length": Buffer.byteLength(c.__csv), "cache-control": "no-store", "content-disposition": `attachment; filename="${c.filename.replace(/[^A-Za-z0-9._-]/g, "_")}"` });
      res.end(c.__csv);
      return;
    }
    send(res, 200, out);
  };

  // ─── 第 44 批：账号接口（/v1/auth/*；不需要设备身份，已激活设备登录时可带设备签名把会话绑到本机） ───
  const authErr = (e: unknown): never => {
    if (e instanceof AuthError) throw new CpError(e.status, e.code, e.message, e.extra);
    throw e;
  };
  const accountMark = (res: ServerResponse, a: AccountRecord, action: string) => auditCtx.set(res, { entry: { tid: a.tid, actor: { kind: "account", id: a.aid }, action, target: a.aid }, written: false });
  const authRoute = async (req: IncomingMessage, res: ServerResponse, method: string, path: string, p: string, raw: string): Promise<void> => {
    const src = sourceOf(req);
    if (method === "POST" && p === "/v1/auth/register") {
      if (!authAllowed(src, "register", 10)) throw new CpError(429, "rate_limited", "尝试过于频繁，请稍后再试");
      const b = parseJson(raw);
      const set = catalog.settings;
      if (set.registration === "closed") throw new CpError(403, "registration_closed", "暂不开放注册，请联系中软开通");
      const email = normalizeEmail(b.email);
      if (!email) throw new CpError(400, "email_invalid", "邮箱格式不对");
      if (!validName(b.name)) throw new CpError(400, "name_invalid", "请填写姓名（1–40 个字符）");
      const probs = passwordProblems(b.password, email);
      if (probs.length) throw new CpError(400, "password_weak", `密码需要：${probs.join("、")}`, { rules: probs });
      if (accountByEmail.has(email)) throw new CpError(409, "email_taken", "这个邮箱已注册，请直接登录（忘记密码可找回）");
      const name = String(b.name).trim();
      let t: TenantRecord;
      let role: AccountRecord["role"];
      let slug: string;
      let via: AccountRecord["created_via"];
      let claim: Record<string, unknown> | null = null;
      const hasCode = typeof b.code === "string" && b.code.trim() !== "";
      if (hasCode) {
        // 开通码（20 位）或邀请码的控制面段（邀请码的本机核对段留在客户端，用于入组申请的 HMAC）
        const code = normalizeActivationCode(b.code);
        const mac = code ? activationCodeMac(codePepper, code) : null;
        const ix = mac ? codeIndex.get(mac) : undefined;
        const ht = ix ? tenants.get(ix.tid) : undefined;
        const r = ix && ht ? ht.activations.get(ix.id) : undefined;
        if (!ht || !r || r.via_account || !sameHex(r.code_mac, mac!) || !redeemable(ht, r)) throw new CpError(400, "code_invalid", "开通码或邀请码不正确或已失效，请向发码人重新获取");
        if (!licenseValid(ht)) throw new CpError(402, "license_expired", "律所订阅已到期，请联系中软开通");
        t = ht;
        slug = r.member.slug;
        role = r.kind === "founder" ? "admin" : r.member.role;
        if (r.kind === "founder" && (t.root_public_key_pem || [...accounts.values()].some((x) => x.tid === t.tid && x.role === "admin"))) throw new CpError(400, "code_invalid", "开通码或邀请码不正确或已失效，请向发码人重新获取");
        if (accountOfMember(t.tid, `usr_${t.tid.slice(4)}_${slug}`)) throw new CpError(409, "member_taken", "这份邀请对应的成员已有账号：请用那个账号登录");
        via = r.kind === "founder" ? "founder_code" : "invite_code";
        const secret = newClaimSecret();
        r.status = "claimed";
        r.claim_hash = claimSecretHash(secret);
        r.claimed_at = iso();
        r.first_claimed_at = r.first_claimed_at ?? r.claimed_at;
        r.redeem_count = (r.redeem_count ?? 0) + 1;
        claim = { kind: r.kind, tid: t.tid, activation_id: r.id, claim_secret: secret, firm: orgOf(t.tid), member: { slug, name, role } };
      } else {
        if (set.registration === "code") throw new CpError(403, "code_required", "请输入律所发给你的开通码或邀请码");
        const orgName = typeof b.org_name === "string" && validDisplayName(b.org_name.trim()) ? b.org_name.trim() : `${name}的工作室`.slice(0, 40);
        t = viaRoute(() => ops.createTenant({ tid: newFirmTid(email), edition: "team", seats: set.trial_seats, subscriptionDays: set.trial_days, plan: set.trial_plan, name: orgName, activationRequired: true, accountsRequired: true, createdVia: "self" }));
        role = "admin";
        slug = newMemberSlug(t, email);
        via = "self";
      }
      const a: AccountRecord = { aid: newId("acc"), email, name, status: "active", disabled_reason: null, tid: t.tid, member_slug: slug, role, pw: hashPassword(String(b.password)), pw_changed_at: iso(), created_at: iso(), created_via: via, last_login_at: iso(), failed: { count: 0, first_at: null, locked_until: null }, device_limit: null, quota_limit: null };
      accounts.set(a.aid, a);
      indexAccount(a);
      const kind = clientInfo(b.client).platform === "web" ? "web" : "desktop";
      const { token, rec } = newSession(a, kind, null, b.client);
      const base = { tid: t.tid, firm: orgOf(t.tid), member: { slug, name, role }, devices_used: 0, device_limit: deviceLimitOf(a) };
      const onb: Onboarding = claim
        ? claim.kind === "founder"
          ? { state: "needs_founder_setup", ...base, claim }
          : { state: "needs_device_join", ...base, device_id: expectedJoinDeviceId(t.tid.slice(4), slug), claim, via: "invite_code" }
        : onboardingOf(a, null);
      accountMark(res, a, "account.register");
      return send(res, 200, authResult(a, token, rec, onb));
    }
    if (method === "POST" && p === "/v1/auth/login") {
      if (!authAllowed(src, "login", 20)) throw new CpError(429, "rate_limited", "尝试过于频繁，请稍后再试");
      const b = parseJson(raw);
      const email = normalizeEmail(b.email);
      const a = email ? accounts.get(accountByEmail.get(email) ?? "") : undefined;
      if (a) {
        const lk = locked(a, now());
        if (lk) throw new CpError(423, "account_locked", `密码错误次数过多，请 ${Math.ceil(lk / 60)} 分钟后再试，或找回密码`, { retry_after_s: lk });
      }
      const ok = verifyPassword(b.password, a?.pw ?? null);
      if (!a || !ok) {
        if (a) {
          noteFailure(a, now());
          persistNow();
        }
        throw new CpError(401, "auth_invalid", a && !a.pw ? "这个账号还没有设置密码：请用管理员给你的设置码设置密码" : "邮箱或密码不正确");
      }
      if (a.status !== "active") throw new CpError(403, "account_disabled", "账号已停用，请联系管理员");
      if (!tenants.has(a.tid)) throw new CpError(403, "account_disabled", "账号所属律所已不存在，请联系管理员");
      const dev = await optionalDevice(req, path, raw);
      if (dev && (!tenants.get(a.tid)!.devices.has(dev.cert.deviceId) || dev.cert.memberId !== uidOfAccount(a))) throw new CpError(409, "device_mismatch", "这台电脑已登记为本所另一位成员（或另一家律所）：请用那位成员的账号登录");
      a.failed = { count: 0, first_at: null, locked_until: null };
      a.last_login_at = iso();
      const onb = onboardingOf(a, dev);
      const kind = clientInfo(b.client).platform === "web" ? "web" : "desktop";
      const { token, rec } = newSession(a, kind, dev ? dev.cert.deviceId : null, b.client);
      accountMark(res, a, "account.login");
      return send(res, 200, authResult(a, token, rec, onb));
    }
    if (method === "POST" && p === "/v1/auth/password-reset/request") {
      if (!authAllowed(src, "reset", 5)) throw new CpError(429, "rate_limited", "尝试过于频繁，请稍后再试");
      const b = parseJson(raw);
      const email = normalizeEmail(b.email);
      const a = email ? accounts.get(accountByEmail.get(email) ?? "") : undefined;
      if (a && o.mailer && a.status === "active") {
        const c = issueAccountCode(a, "email_reset", 15 * 60_000, null);
        persistNow();
        try {
          await o.mailer.send(a.email, "Kimi Work 法律版：找回密码验证码", `你的验证码是 ${c.code}，15 分钟内有效。如果不是你本人操作，请忽略这封邮件。`);
        } catch {
          // 发送失败不改变应答（不泄露账号是否存在）
        }
      }
      return sendRaw(res, 202, { ok: true, channel: o.mailer ? "email" : "admin", message: o.mailer ? "如果这个邮箱已注册，验证码已发到邮箱（15 分钟内有效）" : "请联系律所管理员或中软客服获取重置码" });
    }
    if (method === "POST" && p === "/v1/auth/password-reset/confirm") {
      if (!authAllowed(src, "reset-confirm", 10)) throw new CpError(429, "rate_limited", "尝试过于频繁，请稍后再试");
      const b = parseJson(raw);
      const email = normalizeEmail(b.email);
      const a = email ? accounts.get(accountByEmail.get(email) ?? "") : undefined;
      const code = normalizeOneTimeCode(b.code);
      const fail = () => new CpError(400, "code_invalid", "验证码或重置码不正确或已过期");
      if (!a || !code) throw fail();
      const live = [...codes.values()].filter((c) => c.aid === a.aid && !c.used_at && Date.parse(c.expires_at) > now() && c.attempts < 5);
      const hit = live.find((c) => sameHexStr(c.mac, codeMac(accountPepper, c.purpose, a.aid, code)));
      if (!hit) {
        for (const c of live) c.attempts += 1;
        persistNow();
        throw fail();
      }
      const probs = passwordProblems(b.password, a.email);
      if (probs.length) throw new CpError(400, "password_weak", `密码需要：${probs.join("、")}`, { rules: probs });
      a.pw = hashPassword(String(b.password));
      a.pw_changed_at = iso();
      a.failed = { count: 0, first_at: null, locked_until: null };
      hit.used_at = iso();
      revokeSessions((x) => x.aid === a.aid, "password_reset");
      accountMark(res, a, hit.purpose === "setup" ? "account.password_setup" : "account.password_reset");
      return send(res, 200, { ok: true });
    }
    // 以下要求会话
    let me: { s: SessionRecord; a: AccountRecord };
    try {
      me = sessionOf(req, true)!;
    } catch (e) {
      return authErr(e);
    }
    const { s, a } = me;
    if (method === "GET" && p === "/v1/auth/me") {
      const t = tenantOf(a.tid);
      const devs = accountDevices(a);
      const dev = s.device_id ? (t.devices.get(s.device_id) ?? null) : null;
      return sendRaw(res, 200, {
        ok: true,
        account: { ...accountView(a, { org: orgOf(a.tid) }), device_limit: deviceLimitOf(a) },
        session: sessionView(s, s.sid),
        onboarding: dev && !dev.revoked_at ? { state: "ready", tid: t.tid, device_id: dev.cert.deviceId } : null,
        devices: devs.map((d) => ({ device_id: d.cert.deviceId, registered_at: d.registered_at, revoked_at: d.revoked_at, client_version: d.client_version ?? null, last_seen_on: d.client_seen_on ?? null, current: d.cert.deviceId === s.device_id, session: liveSessionsOf(a.aid).some((x) => x.device_id === d.cert.deviceId) ? "active" : "none" })),
        sessions: liveSessionsOf(a.aid).map((x) => sessionView(x, s.sid)),
      });
    }
    if (method === "POST" && p === "/v1/auth/logout") {
      revokeSessions((x) => x.sid === s.sid, "logout");
      accountMark(res, a, "account.logout");
      return send(res, 200, { ok: true });
    }
    if (method === "POST" && p === "/v1/auth/password") {
      const b = parseJson(raw);
      if (!verifyPassword(b.current, a.pw)) {
        noteFailure(a, now());
        persistNow();
        throw new CpError(401, "auth_invalid", "当前密码不正确");
      }
      const probs = passwordProblems(b.next, a.email);
      if (probs.length) throw new CpError(400, "password_weak", `密码需要：${probs.join("、")}`, { rules: probs });
      a.pw = hashPassword(String(b.next));
      a.pw_changed_at = iso();
      const n = revokeSessions((x) => x.aid === a.aid && x.sid !== s.sid, "password_changed");
      accountMark(res, a, "account.password_change");
      return send(res, 200, { ok: true, other_sessions_revoked: n });
    }
    const sr = /^\/v1\/auth\/sessions\/(ses_[A-Za-z0-9_-]{16})\/revoke$/.exec(p);
    if (method === "POST" && sr) {
      const x = sessions.get(sr[1]!);
      if (!x || x.aid !== a.aid) throw new CpError(404, "session_unknown", "没有这个登录");
      revokeSessions((y) => y.sid === x.sid, "user_revoked");
      accountMark(res, a, "account.session_revoke");
      return send(res, 200, { ok: true });
    }
    const du = /^\/v1\/auth\/devices\/([A-Za-z0-9_-]{1,128})\/unbind$/.exec(p);
    if (method === "POST" && du) {
      const b = parseJson(raw);
      if (!verifyPassword(b.password, a.pw)) {
        noteFailure(a, now());
        persistNow();
        throw new CpError(401, "auth_invalid", "密码不正确");
      }
      const d = accountDevices(a).find((x) => x.cert.deviceId === du[1]);
      if (!d) throw new CpError(404, "device_unknown", "这台设备不属于你的账号");
      viaRoute(() => ops.revokeDevice(a.tid, d.cert.deviceId, { by: `account:${a.aid}` }));
      revokeSessions((x) => x.aid === a.aid && x.device_id === d.cert.deviceId, "device_unbound");
      auditCtx.set(res, { entry: { tid: a.tid, actor: { kind: "account", id: a.aid }, action: "device.revoke", target: d.cert.deviceId }, written: false });
      return send(res, 200, { ok: true });
    }
    throw new CpError(404, "not_found", "没有这条路由");
  };

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const path = req.url ?? "/";
    const url = new URL(path, "http://control-plane");
    const p = url.pathname;
    const raw = method === "GET" ? "" : await readBody(req);

    if (p === "/v1/ops" || p.startsWith("/v1/ops/")) return opsRoute(req, res, method, path, p, raw);
    if (p.startsWith("/v1/auth/")) return authRoute(req, res, method, path, p, raw);

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
      // 客户端版本（v9.3 P3）：只记版本号与日期；版本变了或换了一天才改写（每台设备每天至多一次写入）。
      // 没报版本（第 16 批之前的客户端）也记报到日期，版本记为 legacy——统计只数 30 天内报到的（复核 RB16B-22）
      const clientVer = typeof (b.client as { version?: unknown } | undefined)?.version === "string" ? String((b.client as { version: string }).version) : null;
      {
        const rec = t.devices.get(cert.deviceId)!;
        const v = clientVer && CLIENT_VERSION_RE.test(clientVer) ? clientVer : "legacy";
        const today = iso().slice(0, 10);
        if (rec.client_version !== v || rec.client_seen_on !== today) Object.assign(rec, { client_version: v, client_seen_on: today });
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
      // 第 44 批：带了账号会话的登记把会话绑到这台设备（会话还没绑设备、账号就是证书上的成员）
      if (req.headers["x-kwl-session"] !== undefined) {
        try {
          const me = sessionOf(req, true)!;
          if (me.a.tid === t.tid && uidOfAccount(me.a) === cert.memberId && me.s.device_id === null) {
            me.s.device_id = cert.deviceId;
            feedVersion += 1;
          }
        } catch {
          // 会话无效不影响登记本身（席位令牌那一步再要求登录）
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
      // 设备编号只能是 dev_<律所>_<成员>（复核 A-02）；申请须带成员机用邀请码本机秘密段做的 HMAC（复核 A-01，管理员机核对）。
      // 第 44 批（D-186）：账号登录生成的新设备入组用预先分配的编号（第 2～9 台加 _D<n>），没有邀请码本机段 → 不带 HMAC，由批准方人工核对核对码
      if (deviceId !== (rec.via_account ? rec.device_id : expectedJoinDeviceId(firmSlugOf(t.tid) ?? "", rec.member.slug))) throw new CpError(400, "device_id_invalid", "设备编号不合法");
      const jmac = String(b.mac ?? "");
      if (!rec.via_account && !/^[0-9a-f]{64}$/.test(jmac)) throw new CpError(400, "join_mac_missing", "邀请码不完整（缺少本机核对段），请向管理员核对邀请码");
      if (rec.via_account) {
        const acc = accounts.get(rec.via_account);
        if (!acc || acc.status !== "active") throw new CpError(403, "claim_invalid", "开通凭据无效或已过期，请重新登录");
        if (accountDevices(acc).filter((d) => !d.revoked_at).length >= deviceLimitOf(acc)) throw new CpError(409, "device_limit", "账号的设备数已满：请先在别的设备上解绑一台");
      }
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
        ...(rec.via_account ? {} : { mac: jmac }),
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
    // ─── API 路由订阅与健康上报（第 44 批；服务间凭据） ───
    if (method === "GET" && p === "/v1/feed/routing") {
      requireService(req);
      return sendRaw(res, 200, await seal("kwl-routing-feed", routingFeedBody(routing, now())));
    }
    if (method === "POST" && p === "/v1/feed/routing-health") {
      requireService(req);
      try {
        recordHealth(routing, parseJson(raw), now());
      } catch (e) {
        if (e instanceof RoutingError) throw new CpError(e.status, e.code, e.message);
        throw e;
      }
      checkRouteAlerts();
      return send(res, 200, { ok: true, version: routing.version });
    }
    // ─── 额度租约 v2（第 44 批）：网关按席位领一段额度、本地扣减；回报逐请求记录，控制面按请求编号去重入账（服务间凭据） ───
    if (method === "POST" && p === "/v1/quota/lease") {
      requireService(req);
      const b = parseJson(raw);
      const t = tenantOf(String(b.tid ?? ""));
      if (!licenseValid(t)) throw new CpError(402, "license_expired", "律所订阅已到期：不发放额度");
      const sid = String(b.sid ?? "");
      const seat = [...t.seatsByUser.values()].find((x) => x.sid === sid);
      if (!seat || seat.revoked_at) throw new CpError(403, "seat_revoked", "席位不存在或已收回");
      const acc = accountOfMember(t.tid, seat.uid);
      if (acc && acc.status !== "active") throw new CpError(403, "account_disabled", "账号已停用");
      const { q, ctx } = qOf(t);
      const est = (b.need_estimate && typeof b.need_estimate === "object" ? b.need_estimate : {}) as Record<string, unknown>;
      const allowed = ctx.plan.models;
      if (allowed && typeof est.alias === "string" && !allowed.includes(est.alias)) throw new CpError(403, "model_not_allowed", "本所套餐不含这个模型");
      let l: ReturnType<typeof leaseQuota>;
      try {
        l = leaseQuota(q, ctx, { sid, uid: seat.uid, holder: b.holder, need: needUnits(ctx.plan, est), want: b.want, ttl_ms: b.ttl_ms });
      } catch (e) {
        quotaCount(`lease_denied:${e instanceof QuotaError && /^[a-z_]{1,40}$/.test(e.code) ? e.code : "other"}`);
        throw e;
      }
      quotaCount(l.limited_by ? `lease_limited:${l.limited_by}` : "lease_ok");
      return send(res, 200, { lease_id: l.lease_id, unit: l.unit, units: l.units, expires_at: l.expires_at, limited_by: l.limited_by, price_version: currentPrices(routing).version, allowed_aliases: allowed });
    }
    if (method === "POST" && p === "/v1/quota/settle") {
      requireService(req);
      const b = parseJson(raw);
      const t = tenantOf(String(b.tid ?? ""));
      const { q, ctx } = qOf(t);
      const leaseId = typeof b.lease_id === "string" ? b.lease_id : "";
      const l = q.leases[leaseId];
      // 迟到的回报（租约已过保留期）仍入账（按请求编号去重），只是不再记到租约上
      if (l && b.holder !== l.holder) throw new CpError(403, "lease_holder_mismatch", "租约不属于该网关实例");
      if (!Array.isArray(b.records) || b.records.length > 2000) throw new CpError(400, "records_invalid", "用量记录不合法（每次至多 2000 条）");
      const rows = (b.records as Record<string, any>[]).map((r) => rowOf(t, r, ctx.plan));
      const fresh = book.append(rows.filter((r) => !book.has(r.request_id)));
      for (const r of fresh) chargeLease(q, r.lease_id ?? (l ? leaseId : null), r.charge);
      let closed = false;
      if (b.final === true && l) closed = closeLease(q, leaseId, b.holder, now());
      sweepLeases(q, now());
      if (fresh.length) checkAlerts(t, new Set(fresh.map((r) => r.uid).filter((x): x is string => !!x)));
      quotaCount("settle_ok");
      return send(res, 200, { ok: true, accepted: fresh.length, duplicates: rows.length - fresh.length, closed });
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
      accountGate(req, t, dev);
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
      accountGate(req, t, dev);
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
      accountGate(req, t, dev);
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
      accountGate(req, t, dev);
      return send(res, 200, await seatToken(t, dev, seat.sid, RELAY_TOKEN_TTL_SECONDS, "relay"));
    }
    if (method === "GET" && p === "/v1/policy") return send(res, 200, await seal("kwl-firm-policy-current", t.policy));
    // ─── 本所用量与额度（第 44 批 v2）：成员看本所与自己的百分比、剩余、重置时间；管理员与合伙人另看用量数与按成员明细 ───
    if (method === "GET" && p === "/v1/quota") {
      const detail = dev.cert.role === "admin" || dev.cert.role === "partner";
      const { q, ctx } = qOf(t);
      const plan = ctx.plan;
      const me = accountOfMember(t.tid, dev.cert.memberId);
      const view = quotaView(q, ctx, { detail, uid: dev.cert.memberId, sid: t.seatsByUser.get(dev.cert.memberId)?.sid ?? null, memberName: (uid) => accountOfMember(t.tid, uid)?.name ?? null });
      // 模型显示名取路由登记里的（运营改了路由，客户端跟着变）
      const models = view.models.map((m) => ({ ...m, label: routing.models.find((x) => x.alias === m.alias)?.label ?? m.alias }));
      return send(res, 200, await seal("kwl-quota-view", { tid: t.tid, issued_at: iso(), plan: { id: plan.id, label: plan.label }, account: me ? { aid: me.aid, email: me.email, name: me.name } : null, accounts_required: t.accounts_required === true, ...view, models }));
    }
    if (method === "PUT" && p === "/v1/quota/cap") {
      mark("quota.cap_set");
      requireAdmin(dev);
      const b = parseJson(raw);
      // 第 40 批：上限为本月总额度的百分比（monthly_cap_pct）；旧客户端的点数上限明确拒绝
      if ("monthly_cap" in b) throw new CpError(400, "cap_invalid", "已取消点数：月度上限请按百分比设置（monthly_cap_pct）");
      if (!("monthly_cap_pct" in b)) throw new CpError(400, "cap_invalid", "缺少月度上限（不设上限请传 null）");
      {
        const { q, ctx } = qOf(t);
        quotaSetCap(q, ctx, b.monthly_cap_pct, dev.cert.deviceId);
      }
      const ctx = auditCtx.get(res);
      if (ctx) ctx.entry.detail = t.quota.cap_pct === null ? { uncapped: 1 } : { cap_pct: t.quota.cap_pct };
      return send(res, 200, { ok: true, cap_pct: t.quota.cap_pct });
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
        .map((x) => {
          const r = t.activations.get(x.activation_id);
          const acc = r?.via_account ? accounts.get(r.via_account) : undefined;
          return { id: x.id, activation_id: x.activation_id, member_slug: x.member_slug, role: x.role, device_id: x.device_id, sign_pub: x.sign_pub, enc_pub: x.enc_pub, created_at: x.created_at, mac: x.mac ?? null, via: r?.via_account ? "account" : "invitation", account: acc ? { email: acc.email, name: acc.name } : null };
        });
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
        // 账号新设备入组（D-186）没有邀请码本机段：批准方人工核对核对码，没有批准核对段
        if (!rec.via_account && !/^[0-9a-f]{64}$/.test(amac)) throw new CpError(400, "admin_mac_missing", "缺少批准核对段");
        Object.assign(jr, { status: "approved", decided_at: iso(), decided_by: dev.cert.deviceId, cert, firm_bundle: { recovery_public_key_pem: fb!.recovery_public_key_pem, sig: fb!.sig }, admin_mac: rec.via_account ? null : amac });
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
          : e instanceof QuotaError || e instanceof RoutingError || e instanceof PlanError || e instanceof AuthError
            ? new CpError(e.status, e.code, e.message, e instanceof AuthError ? e.extra : undefined)
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
    clearInterval(suspendSweep);
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
    metrics: () => cpMetrics(),
    publicKeys: { envelope: pk.envelope, seat: pk.seat, seatFor: (aud?: SeatAudience) => ({ [aud ? (pk.seat_audiences[aud] ?? pk.seat_general) : pk.seat_general]: pk.seat[aud ? (pk.seat_audiences[aud] ?? pk.seat_general) : pk.seat_general]! }) },
    usageBook: book,
  };
  function cpMetrics() {
    {
      // 客户端版本分布（v9.3 P3；设计 §4.7 轮换签名密钥前看“旧版本活跃设备 < 1%”）：只数未吊销、30 天内报到过的设备；至多 20 个版本，其余归 other
      const since = new Date(now() - 30 * DAY_MS).toISOString().slice(0, 10);
      const byVersion = new Map<string, number>();
      for (const t of tenants.values())
        for (const d of t.devices.values()) {
          if (d.revoked_at) continue;
          // 只数 30 天内报到过的；第 16 批之后从未报到的设备（关机多时、已不用）不计入（复核 RB16B-22）
          if (!d.client_version || !d.client_seen_on || d.client_seen_on < since) continue;
          byVersion.set(d.client_version, (byVersion.get(d.client_version) ?? 0) + 1);
        }
      const sorted = [...byVersion].sort((a, b) => b[1] - a[1]);
      const versions: Record<string, number> = Object.fromEntries(sorted.slice(0, 20));
      const rest = sorted.slice(20).reduce((n, [, c]) => n + c, 0);
      if (rest) versions.other = (versions.other ?? 0) + rest;
      return { quota: { ...quotaCounts }, client_versions: versions };
    }
  }
}

/** 测试与运维：设备证书指纹（日志里只记指纹，不记公钥全文）。 */
export function certFingerprint(cert: Pick<DeviceCertificate, "signPublicKeyPem">): string {
  return createHash("sha256").update(cert.signPublicKeyPem).digest("base64url").slice(0, 16);
}
