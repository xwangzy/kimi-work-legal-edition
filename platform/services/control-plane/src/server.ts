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
import { createHash, generateKeyPairSync, randomBytes, timingSafeEqual, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { StateStore } from "./state-store.ts";
import { canonicalJson, verifyDeviceCertificate, DEVICE_ID_PATTERN, type DeviceCertificate } from "@zr-legal/keys";
import { issueSeatToken, MIN_SEAT_TTL_SECONDS } from "@zr-legal/seat-token";
import {
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

export interface TenantRecord {
  tid: string;
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
}

export interface ControlPlaneOps {
  /** 商务开通：建租户、发许可（≤ 30 天）、生成租户盐、发布最严模板策略 v1（不比最严模板宽：只需控制面签名）。 */
  createTenant(o: { tid: string; edition: LicenseBody["edition"]; seats: number; subscriptionDays?: number }): TenantRecord;
  /** 续订：订阅截止改为 days 天后（许可仍按签到滚动签发 ≤ 30 天）。 */
  renewLicense(tid: string, days: number): LicenseBody;
  /** 终止订阅（合同终止）：此后签发的许可立即到期，客户端进入退出模式。 */
  terminateLicense(tid: string): LicenseBody;
  /** 吊销设备；尚未登记的设备须附它的律所根签发证书（预先吊销，复核 S6-C05、S6-C09）。 */
  revokeDevice(tid: string, deviceId: string, o?: { cert?: unknown; by?: string }): void;
  revokeSeat(tid: string, uid: string): void;
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

/** 席位令牌缺省签发时长（96 小时，复核 S6-A01）。 */
export const SEAT_TTL_DEFAULT_SECONDS = 96 * 3600;

const DAY_MS = 24 * 3600 * 1000;

export function createControlPlane(o: ControlPlaneOptions): ControlPlane {
  const now = o.now ?? Date.now;
  const maxPreRevoked = o.maxPreRevoked ?? MAX_PRE_REVOKED;
  const iso = (t = now()) => new Date(t).toISOString();
  const tenants = new Map<string, TenantRecord>();
  const nonces = new Map<string, number>();
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
      tenants: [...tenants.values()].map((t) => ({ ...t, devices: [...t.devices], preRevoked: [...t.preRevoked], seatsByUser: [...t.seatsByUser], connectors: [...t.connectors], drafts: [...t.drafts], anon: [...t.anon] })),
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
      tenants.set(t.tid, { ...t, devices: new Map(t.devices), preRevoked: new Map(t.preRevoked), seatsByUser: new Map(t.seatsByUser), connectors: new Map(t.connectors), drafts: new Map(t.drafts), anon: new Map(t.anon) });
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
    createTenant({ tid, edition, seats, subscriptionDays = 365 }) {
      if (tenants.has(tid)) throw new Error(`租户已存在：${tid}`);
      const t: TenantRecord = {
        tid,
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
    tenant: (tid) => tenants.get(tid),
    seal,
    touch() {
      feedVersion += 1;
    },
  };
  // 运维操作（开通、续订、吊销等）之后同样落盘
  const ops: ControlPlaneOps = Object.fromEntries(
    Object.entries(rawOps).map(([k, fn]) => [
      k,
      (...args: unknown[]) => {
        let r: unknown;
        try {
          r = (fn as (...a: unknown[]) => unknown)(...args);
        } catch (e) {
          rollback();
          throw e;
        }
        if (k !== "tenant" && k !== "seal") persistNow();
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
  const send = (res: ServerResponse, status: number, body: unknown) => {
    // 先持久化再回复：吊销、席位、发布一旦回复成功即已落盘（写盘失败 → persistNow 回滚并抛 500，由外层以 sendRaw 回复）
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

  /** 收紧类管理动作（吊销设备与席位）：管理员或合伙人设备（与本机吊销的角色口径一致；复核 S6-B04）。 */
  const requireRevoker = (dev: DeviceRecord): void => {
    if (dev.cert.role !== "admin" && dev.cert.role !== "partner") throw new CpError(403, "revoker_required", "需要管理员或合伙人设备");
  };

  const requireAdmin = (dev: DeviceRecord): void => {
    if (dev.cert.role !== "admin") throw new CpError(403, "admin_required", "需要管理员设备");
  };

  const adminCheck = (t: TenantRecord, bytes: Buffer, sigs: AdminSignature[]) =>
    verifyAdminSignatures(bytes, sigs, {
      rootPublicKeyPem: t.root_public_key_pem ?? "",
      threshold: adminThresholdForEdition(t.edition),
      revokedDevices: new Set([...t.devices.values()].filter((d) => d.revoked_at).map((d) => d.cert.deviceId)),
      now: new Date(now()),
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
      const pol = t.policy && Date.parse(t.policy.doc.expires_at) > now() ? t.policy.doc.body : strictestTemplate();
      policies.push({ tid: t.tid, l3a_standard_model: pol.l3a_standard_model });
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
      t.root_public_key_pem = pem;
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
      const existing = t.devices.get(cert.deviceId);
      const revokedAt = existing?.revoked_at ?? t.preRevoked.get(cert.deviceId)?.revoked_at ?? null;
      if (revokedAt) {
        const body: DeviceRevocationNotice = { tid: t.tid, device_id: cert.deviceId, revoked_at: revokedAt };
        throw new CpError(403, "device_revoked", "设备已吊销", { notice: seal("kwl-device-revoked", body) });
      }
      if (!existing || existing.cert.signature !== cert.signature) {
        t.devices.set(cert.deviceId, { cert, registered_at: iso(), revoked_at: null });
        t.directoryVersion += 1;
      }
      // 席位：成员没有席位且许可内仍有余量时自动分配（G0；生产由管理员在控制台分配）
      if (!t.seatsByUser.has(cert.memberId) && cert.role !== "node") {
        const active = [...t.seatsByUser.values()].filter((s) => !s.revoked_at).length;
        if (active < t.seats) {
          t.seatCounter += 1;
          t.seatsByUser.set(cert.memberId, { sid: `seat_${t.tid}_${t.seatCounter}`, uid: cert.memberId, assigned_at: iso(), revoked_at: null });
        }
      }
      return send(res, 200, { ok: true, directory_version: t.directoryVersion, seat: t.seatsByUser.get(cert.memberId)?.sid ?? null });
    }

    // ─── 网关与检索服务订阅（服务间凭据） ───
    if (method === "GET" && p === "/v1/feed/gateway") {
      const h = req.headers.authorization;
      const tok = typeof h === "string" ? /^Bearer\s+(.+)$/i.exec(h)?.[1] ?? "" : "";
      const a = Buffer.from(tok);
      const b = Buffer.from(o.serviceSecret);
      if (a.length !== b.length || !timingSafeEqual(a, b)) throw new CpError(401, "service_auth_invalid", "服务凭据无效");
      return send(res, 200, seal("kwl-gateway-feed", feedBody()));
    }

    // 以下一律设备签名
    const { t, dev } = authDevice(req, path, raw);

    if (method === "GET" && p === "/v1/directory") return send(res, 200, seal("kwl-device-directory", directoryBody(t)));
    if (method === "GET" && p === "/v1/license") return send(res, 200, seal("kwl-license", issueLicense(t)));
    if (method === "GET" && p === "/v1/tenant-salt") {
      const body: TenantSaltBody = { tid: t.tid, purpose: "anon_matter", salt_b64: t.salt_b64, issued_at: t.created_at };
      return send(res, 200, seal("kwl-tenant-salt", body));
    }
    if (method === "POST" && p === "/v1/seat-token") {
      if (!licenseValid(t)) throw new CpError(402, "license_expired", "许可已到期：不签发席位令牌");
      const seat = t.seatsByUser.get(dev.cert.memberId);
      if (!seat) throw new CpError(402, "no_seat", "该成员没有席位");
      if (seat.revoked_at) throw new CpError(403, "seat_revoked", "席位已吊销");
      const token = issueSeatToken({ tid: t.tid, uid: dev.cert.memberId, sid: seat.sid, dev: dev.cert.deviceId, kid: o.keys.seat.kid }, o.keys.seat.privateKey, seatTtl, now());
      return send(res, 200, { token, expires_at: iso(now() + seatTtl * 1000) });
    }
    if (method === "GET" && p === "/v1/policy") return send(res, 200, seal("kwl-firm-policy-current", t.policy));
    if (method === "GET" && p === "/v1/connectors") {
      return send(res, 200, seal("kwl-firm-connectors", { tid: t.tid, version: t.connectorsVersion, issued_at: iso(), entries: [...t.connectors.values()] }));
    }
    if (method === "PUT" && p.startsWith("/v1/anon-matters/")) {
      const anon = decodeURIComponent(p.slice("/v1/anon-matters/".length));
      const s = validateSummary(parseJson(raw));
      if (!s.ok) throw new CpError(400, s.reason, "事项匿名摘要不合法");
      if (s.value.anon !== anon) throw new CpError(400, "summary_anon_mismatch", "匿名编号与路径不符");
      // 版本更高的才替换；同一版本按更严合并（信息落后的设备不能把摘要改回较宽——复核 S6-A07）
      const prev = t.anon.get(anon);
      const next = !prev || s.value.version > prev.version ? s.value : s.value.version === prev.version ? stricterSummary(prev, s.value) : prev;
      if (!prev || canonicalJson(prev) !== canonicalJson(next)) {
        t.anon.set(anon, next);
        feedVersion += 1;
      }
      return send(res, 200, { ok: true });
    }

    // ─── 起草 → 管理员设备签名 → 发布（律所策略、连接器登记） ───
    if (method === "GET" && p === "/v1/drafts") {
      requireAdmin(dev);
      return send(res, 200, { drafts: [...t.drafts.values()].filter((d) => !d.published_at) });
    }
    if (method === "POST" && p === "/v1/drafts") {
      requireAdmin(dev);
      const b = parseJson(raw);
      const draftId = `drf_${randomBytes(8).toString("hex")}`;
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
      requireAdmin(dev);
      if (t.connectors.delete(rc[1]!)) t.connectorsVersion += 1;
      return send(res, 200, { ok: true, version: t.connectorsVersion });
    }
    // 吊销（收紧：管理员或合伙人设备即可）；尚未登记的设备编号记预先吊销（复核 S6-B31）
    const rd = /^\/v1\/devices\/([^/]{1,200})\/revoke$/.exec(p);
    if (method === "POST" && rd) {
      requireRevoker(dev);
      const b = parseJson(raw);
      ops.revokeDevice(t.tid, rd[1]!, { cert: b.cert, by: dev.cert.deviceId });
      return send(res, 200, { ok: true, directory_version: t.directoryVersion });
    }
    const rs = /^\/v1\/seats\/([^/]{1,200})\/revoke$/.exec(p);
    if (method === "POST" && rs) {
      requireRevoker(dev);
      if (!t.seatsByUser.has(decodeURIComponent(rs[1]!))) throw new CpError(404, "seat_unknown", "成员没有席位");
      ops.revokeSeat(t.tid, decodeURIComponent(rs[1]!));
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
      const ce = e instanceof CpError ? e : new CpError(500, "control_plane_error", "控制面错误");
      if (res.headersSent) res.destroy();
      else sendRaw(res, ce.status, { error: { code: ce.code, message: ce.message }, ...(ce.extra ?? {}) });
    });
  });

  // 正常关闭：停定时写入，把未落盘的 nonce 一并写下
  server.on("close", () => {
    if (nonceFlush) clearInterval(nonceFlush);
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
