/**
 * 其余控制面文档（v9 第 02 篇 §7.1 #2 许可、#3 设备与公钥目录与吊销、#5 事项匿名摘要；§10 凭据表；第 04 篇 §5.2 网关二次检查）。
 * 这些都是收紧类或运营类内容：控制面签名（信封）即可；成员公钥另须律所根签发的设备证书（本机按固定的根公钥核验）。
 */
import { createHash } from "node:crypto";
import { canonicalJson, type DeviceCertificate } from "@zr-legal/keys";

// ─── 许可（端侧离线验签 30 天，过期进入退出模式） ───

export interface LicenseBody {
  tid: string;
  /** 团队版 / 律所版（管理员签名门限 1 / 2，第 02 篇 §9.11）。 */
  edition: "team" | "firm";
  seats: number;
  issued_at: string;
  expires_at: string;
}

export const LICENSE_MAX_TTL_MS = 30 * 24 * 3600 * 1000;

export function adminThresholdForEdition(edition: LicenseBody["edition"]): number {
  return edition === "firm" ? 2 : 1;
}

export function validateLicense(x: unknown, tid: string): { ok: true; value: LicenseBody } | { ok: false; reason: string } {
  const b = x as Partial<LicenseBody> | null;
  if (!b || typeof b !== "object") return { ok: false, reason: "license_malformed" };
  if (b.tid !== tid) return { ok: false, reason: "license_tenant_mismatch" };
  if (b.edition !== "team" && b.edition !== "firm") return { ok: false, reason: "license_edition_invalid" };
  if (typeof b.seats !== "number" || !Number.isSafeInteger(b.seats) || b.seats < 1) return { ok: false, reason: "license_seats_invalid" };
  const iat = typeof b.issued_at === "string" ? Date.parse(b.issued_at) : NaN;
  const exp = typeof b.expires_at === "string" ? Date.parse(b.expires_at) : NaN;
  if (!Number.isFinite(iat) || !Number.isFinite(exp) || exp <= iat) return { ok: false, reason: "license_times_invalid" };
  if (exp - iat > LICENSE_MAX_TTL_MS) return { ok: false, reason: "license_ttl_too_long" };
  return { ok: true, value: { tid, edition: b.edition, seats: b.seats, issued_at: b.issued_at!, expires_at: b.expires_at! } };
}

// ─── 租户盐（匿名事项编号：同一律所各设备对同一事项给出同一编号；网关只见编号） ───

export interface TenantSaltBody {
  tid: string;
  purpose: "anon_matter";
  salt_b64: string;
  issued_at: string;
}

// ─── 设备与公钥目录（含吊销） ───

export interface DirectoryBody {
  tid: string;
  /** 目录版本（单调；回放旧目录不能撤销吊销）。 */
  version: number;
  issued_at: string;
  /** 有效期（第 02 篇 §9.11“策略与公钥目录版本单调、带有效期”）：≤ 30 天；过期的目录拒收，已接受的过期后界面提示吊销信息可能不完整。 */
  expires_at: string;
  /** 设备证书（律所根签发；控制面只是转交，不能改动——本机按固定的根公钥逐一核验）。 */
  devices: DeviceCertificate[];
  revoked_devices: { device_id: string; revoked_at: string }[];
  revoked_seats: string[];
}

export const DIRECTORY_MAX_TTL_MS = 30 * 24 * 3600 * 1000;

/**
 * 安全码（第 02 篇 §9.11：成员设备公钥变更须核对安全码后才重新包裹）：签名与加密公钥的 SHA-256 → 6 组 5 位数字，
 * 双方在可信渠道（当面、电话）各自读出比对。
 */
export function safetyCode(k: Pick<DeviceCertificate, "signPublicKeyPem" | "encPublicKeyPem">): string {
  const h = createHash("sha256").update(canonicalJson({ s: k.signPublicKeyPem.trim(), e: k.encPublicKeyPem.trim() })).digest();
  const groups: string[] = [];
  for (let i = 0; i < 6; i++) groups.push(String(h.readUIntBE(i * 5, 5) % 100000).padStart(5, "0"));
  return groups.join(" ");
}

// ─── 事项匿名摘要（本地事项：端生成、经控制面同步到网关，供二次检查——第 02 篇 §7.1 #5、第 04 篇 §5.2） ───

export const SUMMARY_LEVELS = ["L0", "L1", "L2", "L3a", "L3b", "L4"] as const;
export const SUMMARY_ENDPOINTS = ["standard", "byok", "private", "mock", "none"] as const;

export interface AnonMatterSummary {
  /** 匿名事项编号（HMAC(租户盐, 租户‖事项) 截断；不含事项名称与任何内容）。 */
  anon: string;
  level: (typeof SUMMARY_LEVELS)[number];
  endpoint: (typeof SUMMARY_ENDPOINTS)[number];
  basis_complete: boolean;
  /** 事项策略版本（控制面只收更高的版本；同版本按更严合并——复核 S6-A07：信息落后的设备不能把摘要改回较宽）。 */
  version: number;
  updated_at: string;
}

const LEVEL_ORDER: Readonly<Record<string, number>> = { L0: 0, L1: 1, L2: 2, L3a: 3, L3b: 4, L4: 5 };

/** 同一事项、同一策略版本的两份摘要按更严合并（级别取高、非标准端点优先、依据须两份都齐备）。 */
export function stricterSummary(a: AnonMatterSummary, b: AnonMatterSummary): AnonMatterSummary {
  return {
    anon: a.anon,
    level: (LEVEL_ORDER[a.level]! >= LEVEL_ORDER[b.level]! ? a.level : b.level) as AnonMatterSummary["level"],
    endpoint: a.endpoint !== "standard" ? a.endpoint : b.endpoint,
    basis_complete: a.basis_complete && b.basis_complete,
    version: a.version,
    updated_at: a.updated_at > b.updated_at ? a.updated_at : b.updated_at,
  };
}

export function validateSummary(x: unknown): { ok: true; value: AnonMatterSummary } | { ok: false; reason: string } {
  const s = x as Partial<AnonMatterSummary> | null;
  if (!s || typeof s !== "object") return { ok: false, reason: "summary_malformed" };
  for (const k of Object.keys(s)) if (!["anon", "level", "endpoint", "basis_complete", "version", "updated_at"].includes(k)) return { ok: false, reason: `summary_unknown_field:${k}` };
  if (typeof s.version !== "number" || !Number.isSafeInteger(s.version) || s.version < 0) return { ok: false, reason: "summary_version_invalid" };
  if (typeof s.anon !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(s.anon)) return { ok: false, reason: "summary_anon_invalid" };
  if (!(SUMMARY_LEVELS as readonly unknown[]).includes(s.level)) return { ok: false, reason: "summary_level_invalid" };
  if (!(SUMMARY_ENDPOINTS as readonly unknown[]).includes(s.endpoint)) return { ok: false, reason: "summary_endpoint_invalid" };
  if (typeof s.basis_complete !== "boolean") return { ok: false, reason: "summary_basis_invalid" };
  if (typeof s.updated_at !== "string" || !Number.isFinite(Date.parse(s.updated_at))) return { ok: false, reason: "summary_time_invalid" };
  return { ok: true, value: { anon: s.anon, level: s.level as AnonMatterSummary["level"], endpoint: s.endpoint as AnonMatterSummary["endpoint"], basis_complete: s.basis_complete, version: s.version, updated_at: s.updated_at } };
}

// ─── 网关订阅（控制面 → 法律模型网关、检索服务：吊销集、事项匿名摘要、律所策略中网关执行的项） ───

export interface GatewayFeedBody {
  version: number;
  issued_at: string;
  /** 已吊销的设备（按租户区分：设备编号由各律所根自行写入证书，不同律所可能相同——复核 S6-A08）。 */
  revoked_devices: { tid: string; device_id: string }[];
  revoked_seats: string[];
  matters: (AnonMatterSummary & { tid: string })[];
  policies: { tid: string; l3a_standard_model: "deny" | "allow" }[];
}

/** 网关与检索服务对控制面订阅的只读视图（订阅器在云端服务一侧实现：services/control-plane 的 GatewayFeedSubscriber）。 */
export interface GatewayFeedView {
  /** 是否取得过订阅。 */
  ready(): boolean;
  revokedDevice(tid: string, deviceId: string): boolean;
  revokedSeat(seatId: string): boolean;
  matter(tid: string, anon: string): AnonMatterSummary | null;
  l3aStandardAllowed(tid: string): boolean;
  /** 按需刷新（单飞、限频）：遇到未知事项或级别不符时调用一次。 */
  refresh(): Promise<void>;
}

// ─── 本机被吊销的通知（复核 S6-A02、S6-B01：控制面对已吊销设备的请求返回这份签名通知，设备据此进入退出模式） ───

export interface DeviceRevocationNotice {
  tid: string;
  device_id: string;
  revoked_at: string;
}
