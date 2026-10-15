/**
 * 律所治理（v9 阶段 6：控制面最小集的本机一侧；第 02 篇 §7.1 #2–#5、§9.11、§9.13、§10；第 04 篇 §10；T17）。
 *
 * 本机是控制面下发内容的**最后裁决者**：
 * - 控制面信封（控制面公钥随客户端构建固定）只证明“出自控制面”——收紧类内容（吊销、最严模板、许可、租户盐、本机吊销通知）据此即可接受；
 * - 放宽类策略与连接器登记另须 ≥ 门限名管理员的设备签名（管理员证书由本机固定的律所根公钥核验；门限在首次取得许可时按版本固定、只升不降；
 *   门限固定之前不接受任何放宽内容）；本机只保存核验通过的签名，签名人被吊销后的重算只用核验通过的“设备 → 成员”映射；
 * - 成员设备证书须由律所根签发；已知设备的公钥变更挂起，双方核对安全码后才替换（替换前不向新公钥包裹事项密钥）；
 * - 策略、目录、连接器目录版本单调（本机高水位只增不减；单次跳跃有上限）：回放旧文档拒绝；吊销粘滞（含本机尚不认识的设备）；
 * - 律所策略 30 天有效期；过期、签名不足门限、或收到本机不认识的更新版本时，回退“产品基线 + 最严模板”且不比最后一份已接受策略宽；
 * - 许可 30 天离线有效（控制面按签到滚动续发），到期、从未取得或本机被吊销进入退出模式；
 * - 拒绝都记告警（本机审计链留痕、界面可见）：“拒绝或告警”（T17）。唯一例外：门限固定之前暂缓接受的放宽内容不告警（有意为之——取得许可后的下一次同步再判）。
 *
 * 未配置控制面（开发与测试形态）：律所策略沿用本机配置项（偏离 D-17，只限开发形态），不检查许可。
 * 已接入过控制面（本机有固定的门限或已接受的许可）或产品构建要求控制面（ZR_REQUIRE_CONTROL_PLANE=1）时不能退回开发形态：
 * 缺控制面地址即进入退出模式（复核 S6-B12、S6-A17）。
 */
import type { KeyObject } from "node:crypto";
import { randomBytes } from "node:crypto";
import { canonicalJson, sha256B64, verifyDeviceCertificate, type DeviceCertificate } from "@zr-legal/keys";
import { verifySeatToken } from "@zr-legal/seat-token";
import { OFFICIAL_SITE_BASELINE } from "@zr-legal/egress-gate";
import {
  adminThresholdForEdition,
  evaluateConnector,
  evaluatePolicy,
  openEnvelope,
  type CpAuditRecord,
  policyRelaxations,
  safetyCode,
  signersStillSufficient,
  stricterBody,
  strictestTemplate,
  isUnrecognizedFormat,
  unrecognizedNewerVersion,
  validateLicense,
  validatePolicyDoc,
  CLOCK_SKEW_MS,
  DIRECTORY_MAX_TTL_MS,
  DOMAIN_RE,
  RUN_MODES,
  type AnonMatterSummary,
  type DeviceRevocationNotice,
  type DirectoryBody,
  type FirmConnectorDoc,
  type FirmPolicyBody,
  type FirmPolicyDoc,
  type HighWater,
  type LicenseBody,
  type RunMode,
  type SignedFirmConnector,
  type SignedFirmPolicy,
  type TenantSaltBody,
} from "@zr-legal/firm-trust";
import type { KernelDb } from "../db.ts";
import { appendAuditEvent, type LedgerSigner } from "../ledger-signer.ts";
import { currentTenantEpoch } from "../devices.ts";
import { anonMatterIdOf, basisCompleteOf, dataLevelOf } from "../egress/gate-host.ts";

export type GovernanceMode = "control_plane" | "local_dev";

export interface EffectiveFirmPolicy {
  source: "control_plane" | "strictest_fallback" | "local_dev";
  version: number | null;
  issued_at: string | null;
  expires_at: string | null;
  body: FirmPolicyBody;
  relaxations: string[];
  /** 放宽项的签名管理员（成员）。 */
  signers: string[];
  /**
   * 回退原因：从未取得 / 已过期 / 有效管理员签名不足门限（签名设备被吊销或门限提高）/ 收到本机不认识的更新版本（客户端需要升级）。
   */
  fallback_reason: "none_received" | "expired" | "signers_insufficient" | "unrecognized_newer" | null;
}

export interface ExitMode {
  code: "control_plane_unconfigured" | "license_missing" | "license_expired" | "device_revoked";
  message: string;
}

export interface GovernanceAlert {
  alert_id: number;
  area: string;
  code: string;
  subject: string | null;
  detail: string;
  created_at: string;
}

export interface ApplyOutcome {
  accepted: boolean;
  changed: boolean;
  code?: string;
}

/** 待同步到控制面的收紧动作（本机吊销设备）。 */
export interface PendingAction {
  action_id: number;
  kind: string;
  target: string;
  attempts: number;
  last_error: string | null;
  /** 控制面已应答接受的时刻（完成仍以控制面签名的目录为准）。 */
  submitted_at: string | null;
  /** 控制面拒绝的时刻（不自动重试，需人工处理）。 */
  failed_at: string | null;
}

export interface FirmGovernanceDeps {
  db: KernelDb;
  tenantId: string;
  userId: string;
  deviceId: string;
  /** 本机固定的律所根公钥（firm_identity）。 */
  rootPublicKeyPem: string;
  signer: LedgerSigner;
  env: NodeJS.ProcessEnv;
  /** 控制面地址（随客户端构建固定）；未配置 = 开发形态（除非已接入过控制面或产品构建要求控制面）。 */
  controlPlaneBase: string | null;
  /** 控制面信封公钥（kid → 公钥；随客户端构建固定）。 */
  cpKeys: ReadonlyMap<string, KeyObject>;
  /** 席位令牌公钥（控制面形态下必填：本机验签并核对租户、设备、成员）。 */
  seatKeys: ReadonlyMap<string, KeyObject>;
  now?: () => number;
}

/**
 * 席位令牌续期阈值（复核 S6-A01）：剩余不足 73 小时即续期——控制面签发 96 小时，同步间隔 ≤ 1 小时，
 * 因此在线时任何时刻剩余都 ≥ 72 小时，控制面恰在续期前停机时推理与检索仍可用 72 小时（第 02 篇 §10、§13 第 10 条）。
 */
export const SEAT_RENEW_BEFORE_MS = 73 * 3600 * 1000;
/** 设备目录与连接器目录单次版本跳跃上限（目录随每次登记、吊销递增）。 */
const MAX_CATALOG_VERSION_JUMP = 100_000;
/** 首次接受（本机尚无高水位）时目录版本号的绝对上限（复核 S6-B29：防止新设备上版本号被一次抬到顶）。 */
const MAX_FIRST_CATALOG_VERSION = 100_000_000;
/**
 * 版本一次跳过很多仍接受、但告警（复核 S6-C03）：诚实的控制面每次发布策略只加一（草稿不占版本号），目录与连接器目录随登记与吊销递增；
 * 被攻破的控制面可在单次上限内逐次抬高高水位，之后诚实控制面的版本会被当作回放拒收——告警让管理员及早发现。
 */
const POLICY_JUMP_ALERT = 10;
const CATALOG_JUMP_ALERT = 1000;
/** 大跳跃告警的说明（复核 S6-C15：本机长时间离线或刚升级时追上属正常；阈值以下的逐次抬高不告警，见如实残余）。 */
const LARGE_JUMP_NOTE = "若本机长时间离线或刚升级客户端，这是正常追上；否则可能是控制面异常抬高版本，请联系中软核实";
/** 版本跳跃的处理办法（复核 S6-B29：告警写明怎么办）。 */
const VERSION_JUMP_HINT = "诚实的控制面每次发布或变更只加一，出现大跳跃说明控制面状态异常，请联系中软核实；本机高水位的人工重置在 G1";
/**
 * “不认识的更新版本”标记最多领先已接受版本的幅度（复核 S6-B30）：只凭控制面签名、本机解析不了的文档，
 * 最多让本机回退最严模板到控制面再发布 10 个版本为止（收紧方向）。
 */
const UNRECOGNIZED_MAX_LEAD = 10;

const POLICY_REJECT_TEXT: Readonly<Record<string, string>> = Object.freeze({
  malformed: "律所策略格式不合法或含本机不认识的字段",
  tenant_mismatch: "律所策略属于其他租户",
  ttl_too_long: "律所策略有效期超过 30 天",
  not_yet_valid: "律所策略签发时刻在未来",
  expired: "律所策略已过期",
  replayed: "律所策略版本低于本机已接受的版本（回放旧策略；或控制面曾异常抬高版本、被重置，请联系中软核实）",
  version_conflict: "同一版本号的律所策略内容不同",
  version_jump: `律所策略版本跳跃过大，已拒绝（${VERSION_JUMP_HINT}）`,
  relaxation_unsigned: "放宽类律所策略缺少管理员设备签名（只有控制面签名不生效）",
});

/** 证书核验失败的原因分类（复核 S6-B11、S6-A22）：已过期、格式不合法（含设备编号字符集）与“非本所律所根签发”分开告警。 */
function certProblemCode(reason: string): string {
  if (/已过有效期/.test(reason)) return "cert_expired";
  if (/签名|验签/.test(reason)) return "cert_not_issued_by_firm_root";
  return "cert_malformed";
}

const CERT_PROBLEM_TEXT: Readonly<Record<string, string>> = Object.freeze({
  cert_expired: "证书已过有效期：不用于事项密钥包裹",
  cert_malformed: "证书格式不合法：已拒绝，不用于事项密钥包裹",
  cert_not_issued_by_firm_root: "证书未由本所律所根签发：已拒绝，不用于事项密钥包裹",
});

export class FirmGovernance {
  readonly mode: GovernanceMode;
  /** 控制面形态但没有控制面地址（已接入过控制面、或产品构建要求控制面）：退出模式。 */
  readonly unconfigured: boolean;
  private readonly d: FirmGovernanceDeps;
  private readonly seatListeners = new Set<(token: string) => void>();
  private readonly saltListeners = new Set<() => void>();
  private readonly selfRevokedListeners = new Set<() => void>();

  constructor(d: FirmGovernanceDeps) {
    this.d = d;
    // 闩锁（复核 S6-B12）：本机已固定门限或已接受过许可，就不能再以开发形态运行
    const latched =
      !!d.db.get(`SELECT 1 AS x FROM firm_trust WHERE tenant_id = ?`, [d.tenantId]) || !!d.db.get(`SELECT 1 AS x FROM cp_documents WHERE tenant_id = ? AND kind = 'license'`, [d.tenantId]);
    const required = d.env.ZR_REQUIRE_CONTROL_PLANE === "1";
    this.mode = d.controlPlaneBase || latched || required ? "control_plane" : "local_dev";
    this.unconfigured = this.mode === "control_plane" && !d.controlPlaneBase;
    // 开发形态下做的本机吊销没有入队：进入控制面形态时补建待同步动作（复核 S6-C10）
    if (this.mode === "control_plane") {
      d.db.run(
        `INSERT INTO cp_pending_actions (tenant_id, kind, target, created_at)
         SELECT r.tenant_id, 'revoke_device', r.device_id, ? FROM cp_revoked_devices r
          WHERE r.tenant_id = ? AND r.source = 'local' AND r.device_id <> ?
            AND NOT EXISTS (SELECT 1 FROM cp_pending_actions a WHERE a.tenant_id = r.tenant_id AND a.kind = 'revoke_device' AND a.target = r.device_id)`,
        [new Date(this.now()).toISOString(), d.tenantId, d.deviceId],
      );
    }
  }

  now(): number {
    return this.d.now?.() ?? Date.now();
  }

  get tenantId(): string {
    return this.d.tenantId;
  }

  /** 本机固定的律所根公钥与当前吊销集（控制面客户端在本机核验草稿签名时使用）。 */
  trustContext(): { rootPublicKeyPem: string; threshold: number; revokedDevices: Set<string>; now: Date } {
    return { rootPublicKeyPem: this.d.rootPublicKeyPem, threshold: this.adminThreshold(), revokedDevices: this.revokedDeviceIds(), now: new Date(this.now()) };
  }

  // ─── 生效的律所策略 ───

  effectivePolicy(): EffectiveFirmPolicy {
    if (this.mode === "local_dev") return this.localDevPolicy();
    const row = this.d.db.get<{ version: number; doc_json: string; relaxations_json: string; signers_json: string }>(
      `SELECT version, doc_json, relaxations_json, signers_json FROM firm_policies WHERE tenant_id = ? ORDER BY version DESC LIMIT 1`,
      [this.d.tenantId],
    );
    const doc = row ? (JSON.parse(row.doc_json) as FirmPolicyDoc) : null;
    // 回退：产品基线 + 最严模板，且逐项不比最后一份已接受策略宽（复核 S6-A09）
    const fallback = (reason: EffectiveFirmPolicy["fallback_reason"]): EffectiveFirmPolicy => ({
      source: "strictest_fallback",
      version: doc?.version ?? null,
      issued_at: doc?.issued_at ?? null,
      expires_at: doc?.expires_at ?? null,
      body: doc ? stricterBody(strictestTemplate(), doc.body) : strictestTemplate(),
      relaxations: [],
      signers: [],
      fallback_reason: reason,
    });
    const unrecognized = this.highWater("policy_unrecognized");
    if (unrecognized && (!doc || unrecognized.version > doc.version)) return fallback("unrecognized_newer");
    if (!row || !doc) return fallback("none_received");
    if (Date.parse(doc.expires_at) <= this.now()) return fallback("expired");
    const relaxations = JSON.parse(row.relaxations_json) as string[];
    const signers = JSON.parse(row.signers_json) as { members: string[]; devices: string[]; device_members?: Record<string, string> };
    // 放宽项按当前门限与吊销集重算：只用核验通过的“设备 → 成员”映射（复核 S6-B03）
    if (relaxations.length > 0) {
      const threshold = this.pinnedThreshold();
      if (threshold === null || !signersStillSufficient(signers.device_members ?? {}, this.revokedDeviceIds(), threshold)) return fallback("signers_insufficient");
    }
    return { source: "control_plane", version: doc.version, issued_at: doc.issued_at, expires_at: doc.expires_at, body: doc.body, relaxations, signers: signers.members, fallback_reason: null };
  }

  /** 开发形态：本机配置项（D-17；只限未配置控制面且从未接入过控制面时）。 */
  private localDevPolicy(): EffectiveFirmPolicy {
    const body = localDevPolicyBody(this.d.env);
    return { source: "local_dev", version: null, issued_at: null, expires_at: null, body, relaxations: policyRelaxations(body), signers: [], fallback_reason: null };
  }

  maxMode(): RunMode {
    return this.effectivePolicy().body.max_mode;
  }

  autoPreauthorizations(): string[] {
    return [...this.effectivePolicy().body.auto_preauthorizations];
  }

  /** 抓取白名单 = 公开官方站点基线（产品基线）+ 律所策略追加。 */
  fetchAllowlist(): string[] {
    return [...new Set([...OFFICIAL_SITE_BASELINE, ...this.effectivePolicy().body.fetch_allowlist_extra])];
  }

  l3aStandardAllowed(): boolean {
    return this.effectivePolicy().body.l3a_standard_model === "allow";
  }

  /** 律所是否允许律师上传诊断包（第 9 批 S13；没有该项 = 不允许）。 */
  supportUploadAllowed(): boolean {
    return this.effectivePolicy().body.support_upload === "allow";
  }

  /** 已固定的管理员签名门限；首次取得许可之前为 null（此时不接受任何放宽内容；复核 SF-1、S6-B07）。 */
  pinnedThreshold(): number | null {
    return this.d.db.get<{ admin_threshold: number }>(`SELECT admin_threshold FROM firm_trust WHERE tenant_id = ?`, [this.d.tenantId])?.admin_threshold ?? null;
  }

  /** 门限（界面与草稿核验显示用；未固定时按 1 显示，接受放宽内容时另以 pinnedThreshold 为准）。 */
  adminThreshold(): number {
    return this.pinnedThreshold() ?? 1;
  }

  revokedDeviceIds(): Set<string> {
    const ids = new Set(this.d.db.all<{ device_id: string }>(`SELECT device_id FROM devices WHERE tenant_id = ? AND status = 'revoked'`, [this.d.tenantId]).map((r) => r.device_id));
    for (const r of this.d.db.all<{ device_id: string }>(`SELECT device_id FROM cp_revoked_devices WHERE tenant_id = ?`, [this.d.tenantId])) ids.add(r.device_id);
    return ids;
  }

  // ─── 许可、退出模式、席位令牌 ───

  license(): { state: "dev" | "missing" | "valid" | "expired"; edition: string | null; seats: number | null; expires_at: string | null } {
    if (this.mode === "local_dev") return { state: "dev", edition: null, seats: null, expires_at: null };
    const doc = this.doc<LicenseBody>("license");
    if (!doc) return { state: "missing", edition: null, seats: null, expires_at: null };
    return { state: Date.parse(doc.body.expires_at) > this.now() ? "valid" : "expired", edition: doc.body.edition, seats: doc.body.seats, expires_at: doc.body.expires_at };
  }

  /**
   * 退出模式（第 02 篇 §10）：许可到期或未取得——阅读、本机检索、导出、验签照常，模型、联网检索、共享文件夹同步、新任务与签发审批不可用
   * （控制面同步照常：取得新许可即解除）。
   * 本设备被吊销（第 02 篇 §9.13）：同样停止，并终止进行中的任务；已解密到本机的内容无法远程收回（如实，D-40）。
   */
  exitMode(): ExitMode | null {
    if (this.mode === "local_dev") return null;
    if (this.unconfigured) return { code: "control_plane_unconfigured", message: "控制面地址未配置：本设备已接入或须接入控制面，不能以开发形态运行；模型、联网检索、共享文件夹同步、新任务与签发审批不可用" };
    if (this.doc("self_revoked")) return { code: "device_revoked", message: "本设备已被吊销：新任务、模型、联网检索、共享文件夹同步与签发审批已停止，进行中的任务已终止；已解密到本机的内容无法远程收回" };
    const lic = this.license();
    if (lic.state === "missing") return { code: "license_missing", message: "尚未取得许可（联网后自动取得）：可继续查看与导出全部事项，模型、联网检索、共享文件夹同步、新任务与签发审批暂不可用" };
    if (lic.state === "expired") return { code: "license_expired", message: "许可已到期：可继续查看与导出全部事项，模型、联网检索、共享文件夹同步、新任务与签发审批不可用" };
    return null;
  }

  /** 当前有效的席位令牌（只在内核与闸门之间流转；不经任何界面接口返回）。开发形态返回 null（闸门用本机配置）。 */
  seatToken(): string | null {
    if (this.mode === "local_dev") return null;
    const doc = this.doc<{ token: string; exp: number }>("seat");
    if (!doc || doc.body.exp * 1000 <= this.now()) return null;
    return doc.body.token;
  }

  seatInfo(): { sid: string | null; expires_at: string | null; renew_due: boolean } {
    const doc = this.mode === "local_dev" ? null : this.doc<{ exp: number; sid: string }>("seat");
    const exp = doc ? doc.body.exp * 1000 : 0;
    return { sid: doc?.body.sid ?? null, expires_at: doc ? new Date(exp).toISOString() : null, renew_due: !doc || exp - this.now() < SEAT_RENEW_BEFORE_MS };
  }

  onSeatChange(cb: (token: string) => void): void {
    this.seatListeners.add(cb);
  }

  onSaltChange(cb: () => void): void {
    this.saltListeners.add(cb);
  }

  /** 本设备被吊销（复核 S6-A02、S6-B01）：内核据此终止进行中的任务。 */
  onSelfRevoked(cb: () => void): void {
    this.selfRevokedListeners.add(cb);
  }

  // ─── 告警 ───

  alerts(): GovernanceAlert[] {
    return this.d.db.all<GovernanceAlert>(
      `SELECT alert_id, area, code, subject, detail, created_at FROM cp_alerts WHERE tenant_id = ? AND acknowledged_at IS NULL ORDER BY alert_id DESC LIMIT 100`,
      [this.d.tenantId],
    );
  }

  ackAlert(alertId: number, by: string): boolean {
    const r = this.d.db.run(`UPDATE cp_alerts SET acknowledged_at = ?, acknowledged_by = ? WHERE alert_id = ? AND tenant_id = ? AND acknowledged_at IS NULL`, [
      new Date(this.now()).toISOString(),
      by,
      alertId,
      this.d.tenantId,
    ]);
    return r.changes > 0;
  }

  /** 记告警（同类未处理的不重复记）；也供控制面客户端记录草稿与签名的不一致。 */
  alert(area: string, code: string, subject: string | null, detail: string): void {
    const { db, tenantId } = this.d;
    const open = db.get(`SELECT 1 AS x FROM cp_alerts WHERE tenant_id = ? AND area = ? AND code = ? AND COALESCE(subject,'') = ? AND acknowledged_at IS NULL`, [tenantId, area, code, subject ?? ""]);
    if (open) return;
    db.run(`INSERT INTO cp_alerts (tenant_id, area, code, subject, detail, created_at) VALUES (?,?,?,?,?,?)`, [tenantId, area, code, subject, detail.slice(0, 600), new Date(this.now()).toISOString()]);
    this.audit("control_plane.rejected", "control_plane", `${area}:${code}${subject ? `:${subject}` : ""}`, { area, code, subject });
  }

  private reject(area: string, code: string, subject: string | null, detail: string): ApplyOutcome {
    this.alert(area, code, subject, detail);
    return { accepted: false, changed: false, code };
  }

  private audit(action: string, kind: string, objectId: string, detail: unknown): void {
    appendAuditEvent(this.d.db, this.d.signer, { tenantId: this.d.tenantId, actorId: "control_plane", action, kind, objectId: objectId.slice(0, 200), matterId: null, detailHash: sha256B64(canonicalJson(detail)) });
  }

  // ─── 存储小工具 ───

  private doc<T>(kind: string): { version: number | null; body: T; accepted_at: string } | null {
    const r = this.d.db.get<{ version: number | null; body_json: string; accepted_at: string }>(`SELECT version, body_json, accepted_at FROM cp_documents WHERE tenant_id = ? AND kind = ?`, [this.d.tenantId, kind]);
    return r ? { version: r.version, body: JSON.parse(r.body_json) as T, accepted_at: r.accepted_at } : null;
  }

  private saveDoc(kind: string, version: number | null, body: unknown): void {
    this.d.db.run(
      `INSERT INTO cp_documents (tenant_id, kind, version, body_json, accepted_at) VALUES (?,?,?,?,?)
       ON CONFLICT(tenant_id, kind) DO UPDATE SET version = excluded.version, body_json = excluded.body_json, accepted_at = excluded.accepted_at`,
      [this.d.tenantId, kind, version, JSON.stringify(body), new Date(this.now()).toISOString()],
    );
  }

  /**
   * 本机设备表里某台设备的证书（补发吊销时附上：控制面对尚未登记的设备只凭律所根签发的证书记预先吊销）。
   * 只返回本机核验通过的——由本所律所根签发、编号相符（按签发时刻核验，不看是否已过期；复核 S6-C19）。
   */
  deviceCertificate(deviceId: string): DeviceCertificate | null {
    const r = this.d.db.get<{ cert_json: string }>(`SELECT cert_json FROM devices WHERE device_id = ? AND tenant_id = ?`, [deviceId, this.d.tenantId]);
    if (!r) return null;
    try {
      const cert = JSON.parse(r.cert_json) as DeviceCertificate;
      const issued = Date.parse(String(cert?.issuedAt));
      if (!cert || cert.deviceId !== deviceId || !Number.isFinite(issued)) return null;
      return verifyDeviceCertificate(cert, this.d.rootPublicKeyPem, new Date(issued)).ok ? cert : null;
    } catch {
      return null;
    }
  }

  /** 验控制面信封（只读类文档：用量视图、操作记录分页）；不合法即 null。 */
  openSigned<T>(envelope: unknown, kind: string): T | null {
    const o = openEnvelope<T>(envelope, kind, this.d.cpKeys);
    return o.ok ? o.body : null;
  }

  /** 中软侧操作记录（S14）：本机见过的最高序号与它的 hash（防云端改写已给出的历史）。 */
  auditAnchor(): { seq: number; hash: string } | null {
    const hw = this.highWater("cp_audit");
    return hw && hw.digest ? { seq: hw.version, hash: hw.digest } : null;
  }

  raiseAuditAnchor(seq: number, hash: string): void {
    this.raiseHighWater("cp_audit", seq, hash);
  }

  /** 最后一次取到最新记录时那一页的控制面签名信封（导出用；复核 S9A-12）。 */
  saveSignedAuditPage(envelope: unknown): void {
    this.d.db.run(
      `INSERT INTO cp_audit_signed_page (tenant_id, envelope_json, fetched_at) VALUES (?,?,?)
       ON CONFLICT(tenant_id) DO UPDATE SET envelope_json = excluded.envelope_json, fetched_at = excluded.fetched_at`,
      [this.d.tenantId, JSON.stringify(envelope), new Date(this.now()).toISOString()],
    );
  }

  signedAuditPage(): { envelope: unknown; fetched_at: string } | null {
    const r = this.d.db.get<{ envelope_json: string; fetched_at: string }>(`SELECT envelope_json, fetched_at FROM cp_audit_signed_page WHERE tenant_id = ?`, [this.d.tenantId]);
    return r ? { envelope: JSON.parse(r.envelope_json) as unknown, fetched_at: r.fetched_at } : null;
  }

  /** 留存验过的记录；同一序号已有而 hash 不同 = 云端改写了历史（返回冲突的序号，不覆盖）。 */
  storeAuditRecords(recs: readonly CpAuditRecord[]): { stored: number; conflicts: number[] } {
    let stored = 0;
    const conflicts: number[] = [];
    this.d.db.tx(() => {
      for (const r of recs) {
        const prev = this.d.db.get<{ hash: string }>(`SELECT hash FROM cp_audit_records WHERE tenant_id = ? AND seq = ?`, [this.d.tenantId, r.seq]);
        if (prev) {
          if (prev.hash !== r.hash) conflicts.push(r.seq);
          continue;
        }
        this.d.db.run(
          `INSERT INTO cp_audit_records (tenant_id, seq, at, actor_kind, actor_id, actor_fp, action, target, result, prev, hash, detail_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [this.d.tenantId, r.seq, r.at, r.actor.kind, r.actor.id, r.actor.fp ?? null, r.action, r.target, r.result, r.prev, r.hash, r.detail ? JSON.stringify(r.detail) : null],
        );
        stored++;
      }
    });
    return { stored, conflicts };
  }

  /** 本机留存的操作记录（新的在前）。 */
  auditRecords(limit: number, beforeSeq?: number): CpAuditRecord[] {
    const rows = this.d.db.all<{ seq: number; at: string; actor_kind: CpAuditRecord["actor"]["kind"]; actor_id: string; actor_fp: string | null; action: string; target: string | null; result: string; prev: string; hash: string; detail_json: string | null }>(
      `SELECT seq, at, actor_kind, actor_id, actor_fp, action, target, result, prev, hash, detail_json FROM cp_audit_records WHERE tenant_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`,
      [this.d.tenantId, beforeSeq ?? Number.MAX_SAFE_INTEGER, Math.max(1, Math.min(1000, limit))],
    );
    return rows.map((r) => ({ tid: this.d.tenantId, seq: r.seq, at: r.at, actor: { kind: r.actor_kind, id: r.actor_id, ...(r.actor_fp ? { fp: r.actor_fp } : {}) }, action: r.action, target: r.target, result: r.result, prev: r.prev, ...(r.detail_json ? { detail: JSON.parse(r.detail_json) as Record<string, number> } : {}), hash: r.hash }));
  }

  /** 本机已接受的版本（高水位；控制面客户端据此标出已过时的草稿）。 */
  acceptedVersion(kind: "policy" | `connector:${string}`): number {
    return this.highWater(kind)?.version ?? 0;
  }

  private highWater(kind: string): HighWater | null {
    const r = this.d.db.get<{ version: number; digest: string | null }>(`SELECT version, digest FROM cp_high_water WHERE tenant_id = ? AND kind = ?`, [this.d.tenantId, kind]);
    return r ? { version: r.version, digest: r.digest } : null;
  }

  /** 高水位只增不减。 */
  private raiseHighWater(kind: string, version: number, digest: string): void {
    this.d.db.run(
      `INSERT INTO cp_high_water (tenant_id, kind, version, digest) VALUES (?,?,?,?)
       ON CONFLICT(tenant_id, kind) DO UPDATE SET version = excluded.version, digest = excluded.digest WHERE excluded.version > cp_high_water.version`,
      [this.d.tenantId, kind, version, digest],
    );
  }

  /** 吊销墓碑（粘滞；复核 SF-3、S6-B11）：不论本机是否认识该设备都记下，之后不再插入。 */
  private tombstone(deviceId: string, revokedAt: string, source: string): void {
    this.d.db.run(`INSERT OR IGNORE INTO cp_revoked_devices (tenant_id, device_id, revoked_at, source) VALUES (?,?,?,?)`, [this.d.tenantId, deviceId, revokedAt, source]);
    // 设备被吊销后，挂起的公钥变更一并作废（复核 SF-2、S6-B08）
    this.d.db.run(`UPDATE device_key_changes SET status = 'dismissed', resolved_at = ?, resolved_by = ? WHERE device_id = ? AND tenant_id = ? AND status = 'pending'`, [
      new Date(this.now()).toISOString(),
      `revoked:${source}`,
      deviceId,
      this.d.tenantId,
    ]);
  }

  // ─── 控制面文档的接受 ───

  applyLicense(envelope: unknown): ApplyOutcome {
    const o = openEnvelope<LicenseBody>(envelope, "kwl-license", this.d.cpKeys);
    if (!o.ok) return this.reject("license", o.reason, null, `许可信封无效（${o.reason}）`);
    const v = validateLicense(o.body, this.d.tenantId);
    if (!v.ok) return this.reject("license", v.reason, null, `许可不合法（${v.reason}）`);
    const iat = Date.parse(v.value.issued_at);
    // 签发时刻在未来的许可拒收（复核 S6-A06、S6-B09：否则它会粘滞，之后的终止许可被当作“较旧”）
    if (iat > this.now() + CLOCK_SKEW_MS) return this.reject("license", "not_yet_valid", v.value.issued_at, "许可的签发时刻在未来：已拒收（本机时钟可能落后于控制面，请校准系统时间）");
    const cur = this.doc<LicenseBody>("license");
    if (cur && iat < Date.parse(cur.body.issued_at)) return this.reject("license", "replayed", v.value.issued_at, "回放的旧许可（签发时刻早于本机已接受的许可）：已拒绝");
    if (cur && canonicalJson(cur.body) === canonicalJson(v.value)) return { accepted: true, changed: false };
    const wasValid = !!cur && Date.parse(cur.body.expires_at) > this.now();
    const nowValid = Date.parse(v.value.expires_at) > this.now();
    this.d.db.tx(() => {
      this.saveDoc("license", null, v.value);
      // 管理员签名门限：首次取得许可时按版本固定（团队版 1、律所版 2），之后只升不降——被攻破的控制面不能借“改版本”降低门限
      const want = adminThresholdForEdition(v.value.edition);
      const pinned = this.d.db.get<{ admin_threshold: number }>(`SELECT admin_threshold FROM firm_trust WHERE tenant_id = ?`, [this.d.tenantId]);
      if (!pinned) {
        this.d.db.run(`INSERT INTO firm_trust (tenant_id, admin_threshold, source, pinned_at) VALUES (?,?,?,?)`, [this.d.tenantId, want, `license:${v.value.edition}`, new Date(this.now()).toISOString()]);
      } else if (want > pinned.admin_threshold) {
        this.d.db.run(`UPDATE firm_trust SET admin_threshold = ?, source = ? WHERE tenant_id = ?`, [want, `license:${v.value.edition}`, this.d.tenantId]);
      }
    });
    // 滚动续发每次同步都会更新到期时刻：审计只记状态与版本、席位的变化（避免每 10 分钟一条）
    if (!cur || cur.body.edition !== v.value.edition || cur.body.seats !== v.value.seats || wasValid !== nowValid) {
      this.audit("license.accepted", "license", v.value.expires_at, { edition: v.value.edition, seats: v.value.seats, expires_at: v.value.expires_at, valid: nowValid });
    }
    return { accepted: true, changed: true };
  }

  applySalt(envelope: unknown): ApplyOutcome {
    const o = openEnvelope<TenantSaltBody>(envelope, "kwl-tenant-salt", this.d.cpKeys);
    if (!o.ok) return this.reject("salt", o.reason, null, `租户盐信封无效（${o.reason}）`);
    const b = o.body;
    const raw = typeof b?.salt_b64 === "string" ? Buffer.from(b.salt_b64, "base64") : Buffer.alloc(0);
    if (!b || b.tid !== this.d.tenantId || b.purpose !== "anon_matter" || raw.length < 16) return this.reject("salt", "malformed", null, "租户盐不合法");
    const pinned = this.doc<TenantSaltBody>("salt");
    if (pinned) {
      if (pinned.body.salt_b64 === b.salt_b64) return { accepted: true, changed: false };
      return this.reject("salt", "salt_changed", null, "控制面下发的租户盐与本机已固定的不同：已拒绝（匿名事项编号保持不变）");
    }
    this.d.db.tx(() => {
      this.d.db.run(
        `INSERT INTO tenant_salts (tenant_id, purpose, salt_b64) VALUES (?, 'anon_matter', ?) ON CONFLICT(tenant_id, purpose) DO UPDATE SET salt_b64 = excluded.salt_b64`,
        [this.d.tenantId, b.salt_b64],
      );
      this.saveDoc("salt", null, b);
    });
    for (const cb of this.saltListeners) cb();
    // 匿名编号随盐改变：全部事项重新排队上报
    for (const r of this.d.db.all<{ matter_id: string }>(`SELECT matter_id FROM matters WHERE tenant_id = ?`, [this.d.tenantId])) this.enqueueSummary(r.matter_id);
    return { accepted: true, changed: true };
  }

  applySeatToken(token: string): ApplyOutcome {
    // 控制面形态下席位公钥必填：本机验签并核对租户、设备、成员（复核 S6-B24）
    if (this.d.seatKeys.size === 0) return this.reject("seat", "seat_keys_missing", null, "席位令牌公钥未配置：不接受席位令牌（模型与联网检索不可用）");
    let exp: number;
    let sid: string;
    try {
      const c = verifySeatToken(token, this.d.seatKeys, { now: this.now() });
      if (c.tid !== this.d.tenantId || c.dev !== this.d.deviceId || c.uid !== this.d.userId) return this.reject("seat", "seat_claims_mismatch", null, "席位令牌的租户、设备或成员与本机不符");
      exp = c.exp;
      sid = c.sid;
    } catch {
      return this.reject("seat", "seat_invalid", null, "席位令牌无效");
    }
    this.saveDoc("seat", null, { token, exp, sid });
    for (const cb of this.seatListeners) cb(token);
    return { accepted: true, changed: true };
  }

  /** 清掉席位令牌（闸门随即不再发出模型与检索请求）；返回是否有变化（监听器由调用方在事务提交后通知）。 */
  private clearSeatRow(): boolean {
    if (!this.doc("seat")) return false;
    this.d.db.run(`DELETE FROM cp_documents WHERE tenant_id = ? AND kind = 'seat'`, [this.d.tenantId]);
    return true;
  }

  private notifySeatCleared(): void {
    for (const cb of this.seatListeners) cb("");
  }

  /** 控制面答复本机席位已被吊销（收紧信号，控制面可单方面给出）：清掉席位令牌。 */
  seatRevokedByControlPlane(): void {
    if (this.clearSeatRow()) {
      this.audit("seat.revoked", "seat", this.d.userId, { by: "control_plane" });
      this.notifySeatCleared();
    }
  }

  /** 控制面签名的“本设备已吊销”通知（复核 S6-A02、S6-B01）。 */
  applyRevocationNotice(envelope: unknown): ApplyOutcome {
    const o = openEnvelope<DeviceRevocationNotice>(envelope, "kwl-device-revoked", this.d.cpKeys);
    if (!o.ok) return this.reject("revocation", o.reason, null, `吊销通知信封无效（${o.reason}）`);
    const b = o.body;
    if (!b || b.tid !== this.d.tenantId || b.device_id !== this.d.deviceId) return this.reject("revocation", "notice_mismatch", null, "吊销通知的租户或设备与本机不符：已忽略");
    return { accepted: true, changed: this.markSelfRevoked(typeof b.revoked_at === "string" ? b.revoked_at : new Date(this.now()).toISOString(), "control_plane_notice") };
  }

  private markSelfRevoked(revokedAt: string, source: string): boolean {
    if (this.doc("self_revoked")) return false;
    let seatCleared = false;
    this.d.db.tx(() => {
      this.saveDoc("self_revoked", null, { revoked_at: revokedAt, source });
      this.tombstone(this.d.deviceId, revokedAt, source);
      // 本机发起的“吊销本机”到此完成（之后的同步止于登记，不会再取到目录；复核 S6-C10）
      this.d.db.run(`UPDATE cp_pending_actions SET done_at = ?, last_error = NULL WHERE tenant_id = ? AND kind = 'revoke_device' AND target = ? AND done_at IS NULL`, [
        new Date(this.now()).toISOString(),
        this.d.tenantId,
        this.d.deviceId,
      ]);
      seatCleared = this.clearSeatRow();
      this.audit("device.self_revoked", "device", this.d.deviceId, { revoked_at: revokedAt, source });
    });
    if (seatCleared) this.notifySeatCleared();
    for (const cb of this.selfRevokedListeners) cb();
    return true;
  }

  /**
   * 设备目录（整份在一个事务里应用，监听器在提交之后通知——复核 S6-B11）：
   * 证书须由本所律所根签发；新设备进入本机设备表；已知设备公钥变更挂起；吊销粘滞（含本机尚不认识的设备）。
   * - 本机不认识的已吊销设备以“已吊销”身份记入设备表（证书已核验；保留撤权纪元语义，共享文件夹同步据此拒收它的段——复核 S6-B28）；
   * - 诚实的目录本来就把已吊销设备同时列在“设备”与“吊销”两处：只有已记墓碑的设备被当作有效设备下发（同一份目录没有同列为吊销）才告警
   *   （复核 S6-A19、S6-B28）；
   * - 待同步的本机吊销以这份控制面签名的目录把该设备列为吊销为完成条件，不凭 HTTP 应答（复核 S6-B31）。
   */
  applyDirectory(envelope: unknown): ApplyOutcome {
    const o = openEnvelope<DirectoryBody>(envelope, "kwl-device-directory", this.d.cpKeys);
    if (!o.ok) return this.reject("directory", o.reason, null, `设备目录信封无效（${o.reason}）`);
    const b = o.body;
    if (!b || b.tid !== this.d.tenantId || !Number.isSafeInteger(b.version) || !Array.isArray(b.devices) || !Array.isArray(b.revoked_devices) || !Array.isArray(b.revoked_seats)) {
      return this.reject("directory", "malformed", null, "设备目录格式不合法");
    }
    const digest = sha256B64(canonicalJson({ version: b.version, devices: b.devices, revoked_devices: b.revoked_devices, revoked_seats: b.revoked_seats }));
    const hw = this.highWater("directory");
    // 版本先于有效期判断（与策略一致：过期的旧目录按“回放”）
    if (hw && b.version < hw.version) return this.reject(
        "directory",
        "replayed",
        `v${b.version}`,
        `控制面下发的设备目录版本 ${b.version} 低于本机已接受的 ${hw.version}：已拒绝，本机已知的吊销不会被撤回；若控制面曾异常抬高版本或被重置，之后新的吊销将无法应用到本机——请联系中软核实`,
      );
    if (hw && b.version === hw.version && hw.digest !== digest) return this.reject("directory", "version_conflict", `v${b.version}`, `同一版本号（${b.version}）的设备目录内容不同：已拒绝`);
    if (hw ? b.version - hw.version > MAX_CATALOG_VERSION_JUMP : b.version > MAX_FIRST_CATALOG_VERSION) {
      const what = hw ? `设备目录版本从 ${hw.version} 跳到 ${b.version}，超过单次上限` : `设备目录版本 ${b.version} 超过首次接受的上限`;
      return this.reject("directory", "version_jump", `v${b.version}`, `${what}：已拒绝（${VERSION_JUMP_HINT}）`);
    }
    // 有效期（第 02 篇 §9.11）：过期、签发在未来或有效期超过 30 天的目录拒收
    const iat = Date.parse(String(b.issued_at));
    const exp = Date.parse(String(b.expires_at));
    if (!Number.isFinite(iat) || !Number.isFinite(exp) || exp <= iat || exp - iat > DIRECTORY_MAX_TTL_MS) return this.reject("directory", "malformed", `v${b.version}`, "设备目录的有效期不合法（须 ≤ 30 天）");
    if (iat > this.now() + CLOCK_SKEW_MS) return this.reject("directory", "not_yet_valid", `v${b.version}`, "设备目录的签发时刻在未来：已拒收（本机时钟可能落后于控制面，请校准系统时间）");
    if (exp <= this.now()) return this.reject("directory", "expired", `v${b.version}`, `设备目录已于 ${b.expires_at} 过期：已拒收`);
    const { db, tenantId } = this.d;
    const nowIso = new Date(this.now()).toISOString();
    const revoked: { id: string; revoked_at: string }[] = [];
    for (const r of b.revoked_devices.slice(0, 50_000)) {
      const id = String((r as { device_id?: unknown })?.device_id ?? "");
      if (id) revoked.push({ id, revoked_at: String((r as { revoked_at?: unknown })?.revoked_at ?? nowIso) });
    }
    const listedRevoked = new Set(revoked.map((r) => r.id));
    if (hw && b.version === hw.version) {
      // 内容未变：只更新有效期（控制面重新签发的同一版本目录）
      const cur = this.doc<Record<string, unknown>>("directory");
      db.tx(() => {
        if (cur) this.saveDoc("directory", b.version, { ...cur.body, expires_at: b.expires_at });
        this.confirmRevocations(listedRevoked, iat);
      });
      return { accepted: true, changed: false };
    }
    const now = new Date(this.now());
    let changed = false;
    let seatCleared = false;
    let selfRevoked: string | null = null;
    const ownCert = db.get<{ sign_pub_pem: string; enc_pub_pem: string }>(`SELECT sign_pub_pem, enc_pub_pem FROM devices WHERE device_id = ?`, [this.d.deviceId]);
    db.tx(() => {
      const tombstones = new Map(
        db.all<{ device_id: string; revoked_at: string }>(`SELECT device_id, revoked_at FROM cp_revoked_devices WHERE tenant_id = ?`, [tenantId]).map((r) => [r.device_id, r.revoked_at] as const),
      );
      // 先记吊销墓碑（本目录列出的吊销同样适用于本目录列出的证书）
      for (const r of revoked) {
        if (!tombstones.has(r.id)) {
          this.tombstone(r.id, r.revoked_at, "control_plane_directory");
          tombstones.set(r.id, r.revoked_at);
        }
      }
      // 本机发起、尚待控制面确认的吊销：目录暂时仍把该设备列为有效属正常，不按“重新出现”告警（界面另列“待同步”）
      const awaiting = new Set(
        db.all<{ target: string }>(`SELECT target FROM cp_pending_actions WHERE tenant_id = ? AND kind = 'revoke_device' AND done_at IS NULL`, [tenantId]).map((r) => r.target),
      );
      for (const raw of b.devices.slice(0, 50_000)) {
        const cert = raw as DeviceCertificate;
        const id = typeof cert?.deviceId === "string" ? cert.deviceId : "?";
        const cv = cert && typeof cert === "object" ? verifyDeviceCertificate(cert, this.d.rootPublicKeyPem, now) : { ok: false as const, reason: "证书缺失" };
        if (!cv.ok) {
          const code = certProblemCode(cv.reason);
          this.alert("directory", code, id.slice(0, 200), `设备目录中设备 ${id.slice(0, 200)} 的${CERT_PROBLEM_TEXT[code]}（${cv.reason}）`);
          continue;
        }
        if (cert.deviceId === this.d.deviceId) {
          // 目录里本机设备的公钥与本机不同：证书被另行签发或遭替换（复核 S6-B26）
          if (ownCert && (ownCert.sign_pub_pem !== cert.signPublicKeyPem || ownCert.enc_pub_pem !== cert.encPublicKeyPem)) {
            this.alert("directory", "own_device_key_mismatch", cert.deviceId, "设备目录中本设备的公钥与本机不同：可能有人以本设备编号另行签发了证书，请核实");
          }
          continue;
        }
        const tomb = tombstones.get(cert.deviceId);
        if (tomb !== undefined) {
          const row = db.get<{ status: string }>(`SELECT status FROM devices WHERE device_id = ?`, [cert.deviceId]);
          if (!row) {
            // 本机不认识的已吊销设备：以“已吊销”身份记入设备表（复核 S6-B28）
            const next = currentTenantEpoch(db, tenantId) + 1;
            db.run(
              `INSERT INTO devices (device_id, tenant_id, member_id, role, sign_pub_pem, enc_pub_pem, cert_json, status, key_epoch_at_issue, revoked_at, revoked_epoch) VALUES (?,?,?,?,?,?,?, 'revoked', ?, ?, ?)`,
              [cert.deviceId, tenantId, cert.memberId, cert.role, cert.signPublicKeyPem, cert.encPublicKeyPem, JSON.stringify(cert), currentTenantEpoch(db, tenantId), tomb, next],
            );
            db.run(`INSERT INTO key_epochs (scope, scope_id, epoch, reason) VALUES ('tenant', ?, ?, ?)`, [tenantId, next, `control_plane.revoke ${cert.deviceId}`]);
            this.audit("device.directory_added_revoked", "device", cert.deviceId, { member: cert.memberId, role: cert.role, revoked_at: tomb });
            changed = true;
          } else if (row.status !== "revoked" && !listedRevoked.has(cert.deviceId)) {
            // 墓碑优先于设备表（此前记下的吊销，本目录未再列出）：补记吊销；本目录列出的由下面的吊销循环处理
            this.revokeDeviceRow(cert.deviceId, "control_plane_tombstone");
            changed = true;
          }
          if (!listedRevoked.has(cert.deviceId) && !awaiting.has(cert.deviceId)) {
            this.alert("directory", "revoked_device_relisted", cert.deviceId, `已吊销的设备 ${cert.deviceId} 在设备目录中以有效身份重新出现（目录没有把它列为吊销）：吊销是粘滞的，不会重新启用`);
          }
          continue;
        }
        const row = db.get<{ status: string; sign_pub_pem: string; enc_pub_pem: string; member_id: string }>(`SELECT status, sign_pub_pem, enc_pub_pem, member_id FROM devices WHERE device_id = ?`, [cert.deviceId]);
        if (!row) {
          db.run(
            `INSERT INTO devices (device_id, tenant_id, member_id, role, sign_pub_pem, enc_pub_pem, cert_json, status, key_epoch_at_issue) VALUES (?,?,?,?,?,?,?, 'active', ?)`,
            [cert.deviceId, tenantId, cert.memberId, cert.role, cert.signPublicKeyPem, cert.encPublicKeyPem, JSON.stringify(cert), currentTenantEpoch(db, tenantId)],
          );
          this.audit("device.directory_added", "device", cert.deviceId, { member: cert.memberId, role: cert.role, code: safetyCode(cert) });
          changed = true;
          continue;
        }
        if (row.status === "revoked") continue;
        if (row.sign_pub_pem === cert.signPublicKeyPem && row.enc_pub_pem === cert.encPublicKeyPem && row.member_id === cert.memberId) {
          // 目录回到本机已知的公钥：挂起的变更作废（复核 S6-B21）
          db.run(`UPDATE device_key_changes SET status = 'dismissed', resolved_at = ?, resolved_by = 'directory_reverted' WHERE device_id = ? AND tenant_id = ? AND status = 'pending'`, [nowIso, cert.deviceId, tenantId]);
          continue;
        }
        // 已知设备的公钥（或归属成员）变了：挂起，核对安全码后才替换；替换前不向新公钥包裹事项密钥
        const pending = db.get<{ cert_json: string }>(`SELECT cert_json FROM device_key_changes WHERE device_id = ? AND status = 'pending'`, [cert.deviceId]);
        if (!pending || pending.cert_json !== JSON.stringify(cert)) {
          db.run(
            `INSERT INTO device_key_changes (device_id, tenant_id, member_id, cert_json, safety_code, detected_at, status) VALUES (?,?,?,?,?,?, 'pending')
             ON CONFLICT(device_id) DO UPDATE SET member_id = excluded.member_id, cert_json = excluded.cert_json, safety_code = excluded.safety_code, detected_at = excluded.detected_at, status = 'pending', resolved_at = NULL, resolved_by = NULL`,
            [cert.deviceId, tenantId, cert.memberId, JSON.stringify(cert), safetyCode(cert), nowIso],
          );
          this.alert("directory", "member_key_changed", cert.deviceId, `成员 ${cert.memberId} 的设备 ${cert.deviceId} 公钥已变更：核对安全码后才会替换，替换前不向新公钥包裹事项密钥`);
          changed = true;
        }
      }
      // 吊销（收紧：控制面签名即可；本机粘滞——后来的目录不再列出也不恢复）
      for (const r of revoked) {
        if (r.id === this.d.deviceId) {
          if (!this.doc("self_revoked")) {
            selfRevoked = r.revoked_at;
            this.saveDoc("self_revoked", null, { revoked_at: selfRevoked, source: "control_plane_directory" });
            this.audit("device.self_revoked", "device", r.id, { revoked_at: selfRevoked, source: "control_plane_directory" });
            seatCleared = this.clearSeatRow() || seatCleared;
            changed = true;
          }
          continue;
        }
        const row = db.get<{ status: string }>(`SELECT status FROM devices WHERE device_id = ? AND tenant_id = ?`, [r.id, tenantId]);
        if (!row || row.status === "revoked") continue;
        this.revokeDeviceRow(r.id, "control_plane_directory");
        changed = true;
      }
      const mySeat = this.doc<{ sid: string }>("seat")?.body.sid;
      if (mySeat && b.revoked_seats.includes(mySeat)) seatCleared = this.clearSeatRow() || seatCleared;
      this.confirmRevocations(listedRevoked, iat);
      this.saveDoc("directory", b.version, { version: b.version, expires_at: b.expires_at, devices: b.devices.length, revoked_devices: b.revoked_devices, revoked_seats: b.revoked_seats });
      this.raiseHighWater("directory", b.version, digest);
      if (hw && b.version - hw.version > CATALOG_JUMP_ALERT) {
        this.alert("directory", "version_jump_large", `v${b.version}`, `设备目录版本从 ${hw.version} 一次跳到 ${b.version}：已接受（${LARGE_JUMP_NOTE}）`);
      }
    });
    if (seatCleared) this.notifySeatCleared();
    if (selfRevoked) for (const cb of this.selfRevokedListeners) cb();
    return { accepted: true, changed };
  }

  /** 吊销本机设备表里的一台设备并推进租户密钥纪元（该设备引用旧纪元的事件此后一律拒收）。 */
  private revokeDeviceRow(deviceId: string, by: string): void {
    const { db, tenantId } = this.d;
    const next = currentTenantEpoch(db, tenantId) + 1;
    db.run(`UPDATE devices SET status = 'revoked', revoked_at = ?, revoked_epoch = ? WHERE device_id = ?`, [new Date(this.now()).toISOString(), next, deviceId]);
    db.run(`INSERT INTO key_epochs (scope, scope_id, epoch, reason) VALUES ('tenant', ?, ?, ?)`, [tenantId, next, `control_plane.revoke ${deviceId}`]);
    this.audit("device.revoke", "device", deviceId, { by });
  }

  /**
   * 待同步的本机吊销以控制面签名的目录把该设备列为吊销为完成条件（复核 S6-B31）；含控制面曾拒绝的（例如另一台管理员设备已吊销）。
   * 控制面已接受吊销请求、而之后签发的目录仍未列为吊销：告警（诚实的控制面先吊销、再应答）。
   */
  private confirmRevocations(listed: ReadonlySet<string>, directoryIssuedAt: number): void {
    const { db, tenantId } = this.d;
    const open = db.all<{ action_id: number; target: string; submitted_at: string | null }>(
      `SELECT action_id, target, submitted_at FROM cp_pending_actions WHERE tenant_id = ? AND kind = 'revoke_device' AND done_at IS NULL`,
      [tenantId],
    );
    for (const a of open) {
      if (listed.has(a.target)) {
        db.run(`UPDATE cp_pending_actions SET done_at = ?, last_error = NULL WHERE action_id = ?`, [new Date(this.now()).toISOString(), a.action_id]);
        this.audit("device.revoke_confirmed", "device", a.target, { by: "control_plane_directory" });
      } else if (a.submitted_at && directoryIssuedAt > Date.parse(a.submitted_at) + CLOCK_SKEW_MS) {
        this.alert("revocation", "revocation_not_reflected", a.target, `控制面已接受对设备 ${a.target} 的吊销，但之后签发的设备目录仍未把它列为吊销：网关可能仍接受该设备，请联系中软核实`);
      }
    }
  }

  applyPolicy(envelope: unknown): ApplyOutcome {
    const o = openEnvelope<SignedFirmPolicy | null>(envelope, "kwl-firm-policy-current", this.d.cpKeys);
    if (!o.ok) return this.reject("policy", o.reason, null, `律所策略信封无效（${o.reason}）`);
    if (o.body === null) return { accepted: false, changed: false, code: "none" };
    const hw = this.highWater("policy");
    const pinned = this.pinnedThreshold();
    // 门限尚未固定（首次取得许可之前）：带放宽项的策略一律不接受（不告警：许可到达后下次同步再判；复核 SF-1、S6-B07）
    const pre = validatePolicyDoc((o.body as Partial<SignedFirmPolicy>)?.doc);
    if (pinned === null && pre.ok && policyRelaxations(pre.value.body).length > 0) return { accepted: false, changed: false, code: "threshold_not_pinned" };
    const v = evaluatePolicy(o.body, {
      tid: this.d.tenantId,
      rootPublicKeyPem: this.d.rootPublicKeyPem,
      adminThreshold: pinned ?? 1,
      highWater: hw,
      revokedDevices: this.revokedDeviceIds(),
      now: new Date(this.now()),
    });
    if (!v.ok) {
      // 更新的格式（不认识的字段、取值或格式版本——客户端需要升级）：生效策略回退最严模板，而不是沿用可能更宽的旧策略（复核 S6-B18）。
      // 只有按可识别策略的同一规则核对得过（本租户、时刻、版本领先 ≤ 10）的才抬高标记（复核 S6-B30）
      // 本机解析不了、但看起来是本租户在有效期内的更新版本：一律按“不认识的新版本”失败关闭（复核 S6-C04：领先再多也回退，标记钳在高水位 + 10）
      if (v.code === "malformed") {
        const marker = unrecognizedNewerVersion(o.body, { tid: this.d.tenantId, highWater: hw, now: new Date(this.now()), maxLead: UNRECOGNIZED_MAX_LEAD });
        if (marker !== null) {
          if (hw) this.raiseHighWater("policy_unrecognized", marker, "unrecognized");
          const ver = v.version ?? marker;
          return this.reject(
            "policy",
            "unrecognized_newer",
            `v${ver}`,
            `律所策略 v${ver} 本机无法解析（${v.detail}${isUnrecognizedFormat(v.detail) ? "；客户端需要升级" : ""}）：${
              hw ? "生效策略已回退最严模板，直到收到本机认得的更新版本" : "升级之前按最严模板"
            }`,
          );
        }
      }
      return this.reject("policy", v.code, v.version !== null ? `v${v.version}` : null, `${POLICY_REJECT_TEXT[v.code] ?? v.code}：${v.detail}`);
    }
    if (v.unchanged) return { accepted: true, changed: false };
    this.d.db.tx(() => {
      this.d.db.run(
        `INSERT INTO firm_policies (tenant_id, version, doc_json, admin_signatures_json, digest, relaxations_json, signers_json, accepted_at) VALUES (?,?,?,?,?,?,?,?)`,
        [
          this.d.tenantId,
          v.doc.version,
          JSON.stringify(v.doc),
          // 只保存核验通过的签名（复核 S6-B03）
          JSON.stringify(v.verifiedSignatures),
          v.digest,
          JSON.stringify(v.relaxations),
          JSON.stringify({ members: v.signers, devices: v.signerDevices, device_members: v.deviceMembers }),
          new Date(this.now()).toISOString(),
        ],
      );
      this.raiseHighWater("policy", v.doc.version, v.digest);
      this.audit("firm_policy.accepted", "firm_policy", `v${v.doc.version}`, { version: v.doc.version, relaxations: v.relaxations, signers: v.signers, expires_at: v.doc.expires_at });
      // 升级后越过“不认识的新版本”回退标记、且越过幅度不大，属于正常追上，不告警（复核 S6-C15、S6-C21：越过很多仍告警——
      // 否则被攻破的控制面可先抬起标记再大跳，把“大跳跃”告警换成看似无害的“客户端需要升级”）
      const unrecognized = this.highWater("policy_unrecognized");
      const caughtUp =
        !!unrecognized && !!hw && unrecognized.version > hw.version && v.doc.version >= unrecognized.version && v.doc.version - unrecognized.version <= POLICY_JUMP_ALERT;
      if (hw && v.doc.version - hw.version > POLICY_JUMP_ALERT && !caughtUp) {
        this.alert("policy", "version_jump_large", `v${v.doc.version}`, `律所策略版本从 ${hw.version} 一次跳到 ${v.doc.version}：已接受（${LARGE_JUMP_NOTE}）`);
      }
    });
    return { accepted: true, changed: true };
  }

  applyConnectors(envelope: unknown): ApplyOutcome {
    const o = openEnvelope<{ tid: string; version: number; issued_at: string; entries: SignedFirmConnector[] }>(envelope, "kwl-firm-connectors", this.d.cpKeys);
    if (!o.ok) return this.reject("connectors", o.reason, null, `连接器目录信封无效（${o.reason}）`);
    const b = o.body;
    if (!b || b.tid !== this.d.tenantId || !Number.isSafeInteger(b.version) || !Array.isArray(b.entries)) return this.reject("connectors", "malformed", null, "连接器目录格式不合法");
    const digest = sha256B64(canonicalJson({ version: b.version, entries: b.entries }));
    const hw = this.highWater("connectors");
    if (hw && b.version < hw.version) return this.reject("connectors", "replayed", `v${b.version}`, `回放的旧连接器目录（版本 ${b.version} 低于本机已接受的 ${hw.version}）：已拒绝`);
    if (hw && b.version === hw.version) {
      if (hw.digest === digest) return { accepted: true, changed: false };
      return this.reject("connectors", "version_conflict", `v${b.version}`, `同一版本号（${b.version}）的连接器目录内容不同：已拒绝`);
    }
    if (hw ? b.version - hw.version > MAX_CATALOG_VERSION_JUMP : b.version > MAX_FIRST_CATALOG_VERSION) {
      const what = hw ? `连接器目录版本从 ${hw.version} 跳到 ${b.version}，超过单次上限` : `连接器目录版本 ${b.version} 超过首次接受的上限`;
      return this.reject("connectors", "version_jump", `v${b.version}`, `${what}：已拒绝（${VERSION_JUMP_HINT}）`);
    }
    // 门限尚未固定：连接器登记一律是放宽，暂不处理（复核 SF-1）
    const pinned = this.pinnedThreshold();
    if (pinned === null) return { accepted: false, changed: false, code: "threshold_not_pinned" };
    const { db, tenantId } = this.d;
    const keep = new Set<string>();
    let changed = false;
    db.tx(() => {
      for (const e of b.entries.slice(0, 200)) {
        const id = typeof (e as { doc?: { connector_id?: unknown } })?.doc?.connector_id === "string" ? String((e as { doc: { connector_id: string } }).doc.connector_id) : null;
        const v = evaluateConnector(e, {
          tid: tenantId,
          rootPublicKeyPem: this.d.rootPublicKeyPem,
          adminThreshold: pinned,
          highWater: id ? this.highWater(`connector:${id}`) : null,
          revokedDevices: this.revokedDeviceIds(),
          now: new Date(this.now()),
        });
        if (!v.ok) {
          const text =
            v.code === "unsigned"
              ? `未经管理员签名登记的连接器「${id ?? "?"}」：已拒绝，不会进入已核验登记（${v.detail}）`
              : v.code === "replayed"
                ? `回放的旧版连接器登记「${id ?? "?"}」：已拒绝（${v.detail}）`
                : v.code === "version_jump"
                  ? `连接器登记「${id ?? "?"}」版本跳跃过大：已拒绝（${v.detail}；${VERSION_JUMP_HINT}）`
                  : `连接器登记「${id ?? "?"}」不合法：已拒绝（${v.detail}）`;
          this.alert("connectors", `connector_${v.code}`, id, text);
          continue;
        }
        keep.add(v.doc.connector_id);
        if (v.unchanged) continue;
        db.run(
          `INSERT INTO firm_connectors (tenant_id, connector_id, version, doc_json, admin_signatures_json, signers_json, accepted_at) VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(tenant_id, connector_id) DO UPDATE SET version = excluded.version, doc_json = excluded.doc_json, admin_signatures_json = excluded.admin_signatures_json,
             signers_json = excluded.signers_json, accepted_at = excluded.accepted_at`,
          [
            tenantId,
            v.doc.connector_id,
            v.doc.version,
            JSON.stringify(v.doc),
            JSON.stringify(v.verifiedSignatures),
            JSON.stringify({ members: v.signers, devices: v.signerDevices, device_members: v.deviceMembers }),
            new Date(this.now()).toISOString(),
          ],
        );
        this.raiseHighWater(`connector:${v.doc.connector_id}`, v.doc.version, v.digest);
        this.audit("firm_connector.accepted", "firm_connector", v.doc.connector_id, { version: v.doc.version, max_data_level: v.doc.max_data_level, signers: v.signers });
        changed = true;
      }
      // 目录里没有（或本次未通过核验）的连接器撤下（收紧）
      for (const r of db.all<{ connector_id: string }>(`SELECT connector_id FROM firm_connectors WHERE tenant_id = ?`, [tenantId])) {
        if (keep.has(r.connector_id)) continue;
        db.run(`DELETE FROM firm_connectors WHERE tenant_id = ? AND connector_id = ?`, [tenantId, r.connector_id]);
        this.audit("firm_connector.removed", "firm_connector", r.connector_id, { catalog_version: b.version });
        changed = true;
      }
      this.saveDoc("connectors", b.version, { version: b.version, entries: b.entries.length });
      this.raiseHighWater("connectors", b.version, digest);
      if (hw && b.version - hw.version > CATALOG_JUMP_ALERT) {
        this.alert("connectors", "version_jump_large", `v${b.version}`, `连接器目录版本从 ${hw.version} 一次跳到 ${b.version}：已接受（${LARGE_JUMP_NOTE}）`);
      }
    });
    return { accepted: true, changed };
  }

  /** 已核验的律所连接器（律所策略回退最严模板时一律不可用；有效管理员签名不足门限时不可用）。 */
  activeConnectors(): (FirmConnectorDoc & { signers: string[] })[] {
    if (this.mode === "local_dev") return [];
    if (this.effectivePolicy().source !== "control_plane") return [];
    const threshold = this.pinnedThreshold();
    if (threshold === null) return [];
    const revoked = this.revokedDeviceIds();
    const out: (FirmConnectorDoc & { signers: string[] })[] = [];
    for (const r of this.d.db.all<{ doc_json: string; signers_json: string }>(`SELECT doc_json, signers_json FROM firm_connectors WHERE tenant_id = ? ORDER BY connector_id`, [this.d.tenantId])) {
      const s = JSON.parse(r.signers_json) as { members: string[]; devices: string[]; device_members?: Record<string, string> };
      if (!signersStillSufficient(s.device_members ?? {}, revoked, threshold)) continue;
      out.push({ ...(JSON.parse(r.doc_json) as FirmConnectorDoc), signers: s.members });
    }
    return out;
  }

  // ─── 成员公钥变更（核对安全码后替换） ───

  /** 待核对的公钥变更（不含新公钥的安全码：由对方读出、本机比对，避免照抄——复核 S6-B21）。 */
  keyChanges(): { device_id: string; member_id: string; detected_at: string }[] {
    return this.d.db.all(`SELECT device_id, member_id, detected_at FROM device_key_changes WHERE tenant_id = ? AND status = 'pending' ORDER BY detected_at`, [this.d.tenantId]);
  }

  /** 本机设备的安全码（同事核对本机公钥变更时由本人读出；复核 S6-A03）。 */
  mySafetyCode(): string | null {
    const row = this.d.db.get<{ sign_pub_pem: string; enc_pub_pem: string }>(`SELECT sign_pub_pem, enc_pub_pem FROM devices WHERE device_id = ?`, [this.d.deviceId]);
    return row ? safetyCode({ signPublicKeyPem: row.sign_pub_pem, encPublicKeyPem: row.enc_pub_pem }) : null;
  }

  /**
   * 双方在可信渠道核对安全码一致后替换公钥（之后本机的事项密钥包裹才用新公钥）；安全码不符即不替换。
   * 设备已被吊销：变更作废、不替换（复核 SF-2、S6-B08）。
   */
  confirmKeyChange(deviceId: string, code: string, by: string): { ok: true } | { ok: false; reason: string } {
    const { db, tenantId } = this.d;
    const p = db.get<{ cert_json: string; safety_code: string }>(`SELECT cert_json, safety_code FROM device_key_changes WHERE device_id = ? AND tenant_id = ? AND status = 'pending'`, [deviceId, tenantId]);
    if (!p) return { ok: false, reason: "没有待核对的公钥变更" };
    const dev = db.get<{ status: string }>(`SELECT status FROM devices WHERE device_id = ? AND tenant_id = ?`, [deviceId, tenantId]);
    if (!dev || dev.status !== "active" || this.revokedDeviceIds().has(deviceId)) {
      db.run(`UPDATE device_key_changes SET status = 'dismissed', resolved_at = ?, resolved_by = ? WHERE device_id = ? AND status = 'pending'`, [new Date(this.now()).toISOString(), by, deviceId]);
      return { ok: false, reason: "该设备已被吊销：公钥变更作废，不替换" };
    }
    if (p.safety_code.replace(/\s+/g, "") !== String(code).replace(/\s+/g, "")) return { ok: false, reason: "安全码不一致：未替换公钥" };
    const cert = JSON.parse(p.cert_json) as DeviceCertificate;
    const cv = verifyDeviceCertificate(cert, this.d.rootPublicKeyPem, new Date(this.now()));
    if (!cv.ok) return { ok: false, reason: `证书已不再有效：${cv.reason}` };
    try {
      db.tx(() => {
        const r = db.run(`UPDATE devices SET sign_pub_pem = ?, enc_pub_pem = ?, cert_json = ?, member_id = ?, role = ? WHERE device_id = ? AND tenant_id = ? AND status = 'active'`, [
          cert.signPublicKeyPem,
          cert.encPublicKeyPem,
          JSON.stringify(cert),
          cert.memberId,
          cert.role,
          deviceId,
          tenantId,
        ]);
        if (r.changes !== 1) throw new Error("device_not_active");
        db.run(`UPDATE device_key_changes SET status = 'confirmed', resolved_at = ?, resolved_by = ? WHERE device_id = ?`, [new Date(this.now()).toISOString(), by, deviceId]);
        this.audit("device.key_change_confirmed", "device", deviceId, { by, code: p.safety_code });
      });
    } catch {
      return { ok: false, reason: "设备状态已变化：未替换公钥" };
    }
    return { ok: true };
  }

  // ─── 本机发起的收紧动作（吊销）：记墓碑、入队同步到控制面（复核 S6-A12、S6-B04） ───

  recordLocalRevocation(deviceId: string): void {
    this.d.db.tx(() => {
      this.tombstone(deviceId, new Date(this.now()).toISOString(), "local");
      if (this.mode === "control_plane") {
        const open = this.d.db.get(`SELECT 1 AS x FROM cp_pending_actions WHERE tenant_id = ? AND kind = 'revoke_device' AND target = ? AND done_at IS NULL`, [this.d.tenantId, deviceId]);
        if (!open) this.d.db.run(`INSERT INTO cp_pending_actions (tenant_id, kind, target, created_at) VALUES (?, 'revoke_device', ?, ?)`, [this.d.tenantId, deviceId, new Date(this.now()).toISOString()]);
      }
    });
  }

  /**
   * 未完成的待同步动作（复核 S6-A22、S6-B31）：待发送（自动重试）/ 已提交、待控制面目录确认 / 控制面拒绝（不自动重试，需人工处理）。
   * includeFailed：手动“立即同步”时连同控制面拒绝过的一起重发。
   */
  pendingActions(o: { includeFailed?: boolean } = {}): PendingAction[] {
    return this.d.db.all<PendingAction>(
      `SELECT action_id, kind, target, attempts, last_error, submitted_at, failed_at FROM cp_pending_actions WHERE tenant_id = ? AND done_at IS NULL ${o.includeFailed ? "" : "AND failed_at IS NULL"} ORDER BY action_id`,
      [this.d.tenantId],
    );
  }

  /** 补发结果：已提交（控制面已应答接受，完成仍以目录为准）/ 暂时失败（自动重试）/ 控制面拒绝（不自动重试）。 */
  markActionResult(actionId: number, outcome: "submitted" | "retry" | "failed", error: string | null): void {
    const nowIso = new Date(this.now()).toISOString();
    if (outcome === "submitted") {
      this.d.db.run(`UPDATE cp_pending_actions SET attempts = attempts + 1, last_error = NULL, failed_at = NULL, submitted_at = COALESCE(submitted_at, ?) WHERE action_id = ?`, [nowIso, actionId]);
    } else {
      this.d.db.run(`UPDATE cp_pending_actions SET attempts = attempts + 1, last_error = ?, failed_at = ? WHERE action_id = ?`, [error?.slice(0, 200) ?? null, outcome === "failed" ? nowIso : null, actionId]);
    }
  }

  /** 本机吊销某设备的同步状态：synced（控制面目录已列为吊销）/ submitted / pending / failed。 */
  revocationState(deviceId: string): "synced" | "submitted" | "pending" | "failed" {
    const a = this.d.db.get<{ submitted_at: string | null; failed_at: string | null }>(
      `SELECT submitted_at, failed_at FROM cp_pending_actions WHERE tenant_id = ? AND kind = 'revoke_device' AND target = ? AND done_at IS NULL ORDER BY action_id DESC LIMIT 1`,
      [this.d.tenantId, deviceId],
    );
    if (!a) return "synced";
    return a.failed_at ? "failed" : a.submitted_at ? "submitted" : "pending";
  }

  /** 某设备的吊销是否已由控制面目录确认（无未完成的待同步动作）。 */
  revocationSynced(deviceId: string): boolean {
    return this.revocationState(deviceId) === "synced";
  }

  // ─── 事项匿名摘要（经控制面下发网关二次检查） ───

  /** 匿名事项编号用的租户盐：已从控制面固定的用它；否则本机生成（开发形态，或首次同步之前）。 */
  anonSalt(tenantId: string): Buffer {
    const row = this.d.db.get<{ salt_b64: string }>(`SELECT salt_b64 FROM tenant_salts WHERE tenant_id = ? AND purpose = 'anon_matter'`, [tenantId]);
    if (row) return Buffer.from(row.salt_b64, "base64");
    this.d.db.run(`INSERT OR IGNORE INTO tenant_salts (tenant_id, purpose, salt_b64) VALUES (?, 'anon_matter', ?)`, [tenantId, randomBytes(32).toString("base64")]);
    return Buffer.from(this.d.db.get<{ salt_b64: string }>(`SELECT salt_b64 FROM tenant_salts WHERE tenant_id = ? AND purpose = 'anon_matter'`, [tenantId])!.salt_b64, "base64");
  }

  anonIdOf(matterId: string): string {
    return anonMatterIdOf(this.anonSalt(this.d.tenantId), this.d.tenantId, matterId);
  }

  summaryOf(matterId: string): AnonMatterSummary | null {
    const m = this.d.db.get<{ confidentiality: string; consent_status: string; basis: string | null; model_endpoint: string; policy_version: number }>(
      `SELECT confidentiality, consent_status, basis, model_endpoint, policy_version FROM matters WHERE matter_id = ? AND tenant_id = ?`,
      [matterId, this.d.tenantId],
    );
    if (!m) return null;
    return {
      anon: this.anonIdOf(matterId),
      level: dataLevelOf(m.confidentiality, m.consent_status),
      endpoint: (["standard", "byok", "private", "mock", "none"].includes(m.model_endpoint) ? m.model_endpoint : "none") as AnonMatterSummary["endpoint"],
      basis_complete: basisCompleteOf(m) && m.model_endpoint !== "none",
      version: Number(m.policy_version) || 0,
      updated_at: new Date(this.now()).toISOString(),
    };
  }

  /** 事项策略相关字段变化后排队上报（摘要不变不排队）。 */
  enqueueSummary(matterId: string): void {
    if (this.mode === "local_dev") return;
    const s = this.summaryOf(matterId);
    if (!s) return;
    const keyOf = (x: AnonMatterSummary) => canonicalJson({ anon: x.anon, level: x.level, endpoint: x.endpoint, basis_complete: x.basis_complete, version: x.version ?? 0 });
    const cur = this.d.db.get<{ summary_json: string }>(`SELECT summary_json FROM anon_matter_outbox WHERE matter_id = ?`, [matterId]);
    if (cur && keyOf(JSON.parse(cur.summary_json) as AnonMatterSummary) === keyOf(s)) return;
    this.d.db.run(
      `INSERT INTO anon_matter_outbox (matter_id, tenant_id, anon_id, summary_json, updated_at) VALUES (?,?,?,?,?)
       ON CONFLICT(matter_id) DO UPDATE SET anon_id = excluded.anon_id, summary_json = excluded.summary_json, updated_at = excluded.updated_at`,
      [matterId, this.d.tenantId, s.anon, JSON.stringify(s), s.updated_at],
    );
  }

  pendingSummaries(limit = 200): { matter_id: string; summary: AnonMatterSummary }[] {
    return this.d.db
      .all<{ matter_id: string; summary_json: string }>(
        `SELECT matter_id, summary_json FROM anon_matter_outbox WHERE tenant_id = ? AND (pushed_json IS NULL OR pushed_json <> summary_json) ORDER BY updated_at LIMIT ?`,
        [this.d.tenantId, limit],
      )
      .map((r) => ({ matter_id: r.matter_id, summary: JSON.parse(r.summary_json) as AnonMatterSummary }));
  }

  markSummaryPushed(matterId: string, summary: AnonMatterSummary): void {
    this.d.db.run(`UPDATE anon_matter_outbox SET pushed_json = ?, pushed_at = ? WHERE matter_id = ? AND summary_json = ?`, [
      JSON.stringify(summary),
      new Date(this.now()).toISOString(),
      matterId,
      JSON.stringify(summary),
    ]);
  }

  summaryPushed(matterId: string): boolean {
    const r = this.d.db.get<{ x: number }>(`SELECT 1 AS x FROM anon_matter_outbox WHERE matter_id = ? AND pushed_json IS NOT NULL AND pushed_json = summary_json`, [matterId]);
    return !!r;
  }

  // ─── 界面状态（不含任何令牌） ───

  status(): Record<string, unknown> {
    const pol = this.effectivePolicy();
    const lic = this.license();
    const seat = this.seatInfo();
    const dir = this.doc<{ version: number; expires_at?: string; devices: number; revoked_devices: unknown[]; revoked_seats: string[] }>("directory");
    const exit = this.exitMode();
    return {
      mode: this.mode,
      unconfigured: this.unconfigured,
      admin_threshold: this.mode === "local_dev" ? null : this.adminThreshold(),
      admin_threshold_pinned: this.mode === "local_dev" ? null : this.pinnedThreshold() !== null,
      policy: pol,
      license: lic,
      seat: this.mode === "local_dev" ? null : { has_token: !!this.seatToken(), sid: seat.sid, expires_at: seat.expires_at },
      // 目录过期（长时间未能从控制面更新）：吊销信息可能不完整（如实提示；已知的吊销保持）
      directory: dir
        ? { version: dir.version, devices: dir.body.devices, revoked_devices: dir.body.revoked_devices.length, expires_at: dir.body.expires_at ?? null, stale: !!dir.body.expires_at && Date.parse(dir.body.expires_at) <= this.now() }
        : null,
      connectors: this.activeConnectors().map((c) => ({ connector_id: c.connector_id, name: c.name, version: c.version, url: c.url, max_data_level: c.max_data_level, tools: c.tools.length, signers: c.signers })),
      exit_mode: exit,
      key_changes: this.keyChanges(),
      pending_actions:
        this.mode === "local_dev"
          ? []
          : this.pendingActions({ includeFailed: true }).map((a) => ({
              kind: a.kind,
              target: a.target,
              attempts: a.attempts,
              last_error: a.last_error,
              state: a.failed_at ? "failed" : a.submitted_at ? "submitted" : "pending",
            })),
      alerts: this.alerts(),
    };
  }
}

/** 开发形态的律所策略（未配置控制面时；偏离 D-17）。语义与阶段 5 一致：档位上限未设置为“默认”、取值不认识按“手动”；自动档预授权泛化检索。 */
export function localDevPolicyBody(env: NodeJS.ProcessEnv): FirmPolicyBody {
  const max: RunMode =
    env.ZR_FIRM_MAX_MODE === undefined || env.ZR_FIRM_MAX_MODE === "" ? "default" : (RUN_MODES as readonly string[]).includes(env.ZR_FIRM_MAX_MODE) ? (env.ZR_FIRM_MAX_MODE as RunMode) : "manual";
  const extra = [
    ...new Set(
      (env.ZR_FETCH_ALLOWLIST ?? "")
        .split(/[,\s]+/)
        .map((x) => x.trim().toLowerCase())
        .filter((x) => DOMAIN_RE.test(x)),
    ),
  ];
  return {
    max_mode: max,
    auto_preauthorizations: max === "auto" ? ["search_generalized"] : [],
    fetch_allowlist_extra: extra,
    l3a_standard_model: env.ZR_FIRM_L3A_STANDARD_MODEL === "allow" ? "allow" : "deny",
    // 第 9 批 S13：开发形态按本机配置项（缺省不允许上传诊断包）
    ...(env.ZR_FIRM_SUPPORT_UPLOAD === "allow" ? { support_upload: "allow" as const } : {}),
  };
}

/** 事项运行策略用到的律所策略项。 */
export interface FirmPolicyInput {
  maxMode: RunMode;
  autoPreauthorizations: readonly string[];
  /** 公开官方站点基线 + 律所策略追加。 */
  fetchAllowlist: readonly string[];
}

export function firmPolicyInputOf(body: FirmPolicyBody): FirmPolicyInput {
  return { maxMode: body.max_mode, autoPreauthorizations: [...body.auto_preauthorizations], fetchAllowlist: [...new Set([...OFFICIAL_SITE_BASELINE, ...body.fetch_allowlist_extra])] };
}
