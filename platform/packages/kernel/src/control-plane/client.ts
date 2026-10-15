/**
 * 控制面客户端（v9 阶段 6）：设备签名请求经出站闸门代发（内核本身不联网；第 04 篇 §5.1 控制面行“目的地固定、只出元数据”）。
 *
 * 同步顺序：设备登记（租户根公钥未入组时先开通——G0 创始设备持根私钥）→ 补发待同步的收紧动作（本机吊销）→ 许可 → 租户盐 → 设备目录
 * → 律所策略 → 连接器目录 → 席位令牌（缺失或剩余不足 73 小时时续期）→ 事项匿名摘要上报。任何一步失败都记在同步报告里，
 * 已接受的文档继续有效（控制面不可达时本机能力照常；许可与策略各自按有效期处理，第 02 篇 §10）。
 * 控制面答复“本设备已吊销”时附带控制面签名的通知：本机验过即进入退出模式（复核 S6-A02、S6-B01）。
 * 管理员动作（起草、签名、发布律所策略与连接器登记）同样经这里；签名绑定管理员在界面上看到的确切内容（待签字节摘要），
 * 签名时控制面返回的草稿与之不符即拒签并告警（复核 S6-B02）。
 */
import { sign } from "node:crypto";
import { DEVICE_ID_PATTERN, type DeviceCertificate, type DeviceSyncSigner } from "@zr-legal/keys";
import {
  adminSign,
  bytesDigest,
  connectorSigningBytes,
  enrollProofBytes,
  policyRelaxations,
  policySigningBytes,
  signDeviceRequest,
  validateConnectorDoc,
  validatePolicyDoc,
  verifyAdminSignatures,
  verifyAuditChain,
  AUDIT_GENESIS,
  type CpAuditPage,
  type CpAuditRecord,
  POLICY_MAX_TTL_MS,
  type AdminSignature,
  type FirmConnectorDoc,
  type FirmPolicyDoc,
} from "@zr-legal/firm-trust";
import type { CpRelayRequest, CpRelayResult } from "@zr-legal/egress-gate";
import type { FirmGovernance } from "./governance.ts";

export interface ControlPlaneClientDeps {
  gov: FirmGovernance;
  /** 经闸门代发（闸门按需拉起）。 */
  relay: (req: CpRelayRequest) => Promise<CpRelayResult>;
  tenantId: string;
  /** 控制面请求与管理员签名对外可验证：只收设备签名者（复核 S7A-06）。 */
  device: { deviceId: string; cert: DeviceCertificate; signer: DeviceSyncSigner };
  /** G0 开发形态：创始设备的律所根密钥（开通时登记根公钥用；生产为开通流程，不在联机设备上）。 */
  firmRoot?: () => { publicKeyPem: string; privateKeyPem: string } | null;
  now?: () => number;
  /** 每次同步结束后（内核据此在退出模式解除后恢复暂停的任务；复核 S6-B34）。 */
  onSynced?: (report: SyncReport) => void;
}

/**
 * 同步间隔上限（复核 S6-A21）：席位令牌签发 96 小时、剩余不足 73 小时即续期，“控制面停机后仍有 ≥ 72 小时”依赖同步间隔 ≤ 1 小时。
 */
export const SYNC_MAX_INTERVAL_MS = 3600 * 1000;

/** 控制面拒绝、重发也不会成功的错误：不自动重试，界面写明原因、需人工处理（复核 S6-A22）。 */
// 控制面暂时无法核实尚未登记的设备（cert_required / cert_invalid / pre_revocation_limit）不在此列：自动重试，
// 该设备一登记，下一次重试即按已登记设备吊销（复核 S6-C19：否则一台恶意设备可借无效证书让预先吊销永久失败）
const PERMANENT_ACTION_ERRORS: ReadonlySet<string> = new Set([
  "revoker_required",
  "device_id_invalid",
  "cp_path_not_allowed",
  "cp_method_not_allowed",
  "cp_header_not_allowed",
  "cp_body_too_large",
]);

export interface SyncReport {
  at: string;
  ok: boolean;
  steps: Record<string, string>;
}

export interface DraftView {
  draft_id: string;
  kind: "policy" | "connector";
  /** 起草时刻（控制面记录；界面区分同号草稿用）。 */
  created_at: string | null;
  /** 草稿的完整文档（所见即所签）。 */
  doc: FirmPolicyDoc | FirmConnectorDoc;
  /** 本机重算的待签字节摘要：签名时须原样交回，内核比对后才签（复核 S6-B02）。 */
  digest: string | null;
  /** 本机重算：相对最严模板放宽的项（连接器登记一律视为放宽）。 */
  relaxations: string[];
  /** 本机核验通过的签名成员（未通过核验的不显示；复核 S6-B22）。 */
  signed_by: { device_id: string; member_id: string }[];
  signed_by_me: boolean;
  /** 本机核验文档本身是否合法（不合法即不签）。 */
  valid: boolean;
  problem: string | null;
}

/** 本所用量视图（控制面 quotaView 的字段；只有点数与成员编号）。 */
export interface QuotaView {
  period: string;
  cap_monthly: number | null;
  cap_set_at: string | null;
  period_used: number;
  in_flight: number;
  own: { points: number; requests: number } | null;
  history: { period: string; used: number }[];
  issued_at: string;
  pool_remaining?: number;
  granted_total?: number;
  by_member?: { member_id: string | null; points: number; requests: number }[];
  unreconciled_leases?: number;
}

type CallResult = { ok: true; status: number; json: Record<string, unknown> } | { ok: false; error: string; status?: number };

export class ControlPlaneClient {
  private readonly d: ControlPlaneClientDeps;
  private last: SyncReport | null = null;
  private running: Promise<SyncReport> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private pushing: Promise<number> | null = null;
  /** 应用控制面文档的操作串行执行（同步与吊销即时同步；复核 S6-C07：交错时较旧的目录会在之后被判“回放”误报）。 */
  private lock: Promise<void> = Promise.resolve();

  constructor(d: ControlPlaneClientDeps) {
    this.d = d;
  }

  get lastSync(): SyncReport | null {
    return this.last;
  }

  private async call(method: string, path: string, body?: unknown): Promise<CallResult> {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const headers = { ...signDeviceRequest({ method, path, body: raw, tid: this.d.tenantId, deviceId: this.d.device.deviceId, signer: this.d.device.signer, ...(this.d.now ? { now: this.d.now() } : {}) }) };
    const r = await this.d.relay({ method, path, headers, body: raw });
    if (!r.ok) return { ok: false, error: r.reason };
    let json: Record<string, unknown> = {};
    try {
      json = r.body ? (JSON.parse(r.body) as Record<string, unknown>) : {};
    } catch {
      return { ok: false, error: "cp_reply_not_json", status: r.status };
    }
    if (r.status >= 400) {
      const code = (json.error as { code?: string } | undefined)?.code ?? `http_${r.status}`;
      // 本设备已吊销：验过控制面签名的通知即进入退出模式（收紧信号，控制面可单方面给出）
      if (code === "device_revoked" && json.notice) this.d.gov.applyRevocationNotice(json.notice);
      // 本机时钟偏差超过 5 分钟：控制面拒绝签名请求，同步、续期都会失败——告警写明原因（复核 S6-B37）
      if (code === "device_auth_stale") this.clockAlert(json.server_time);
      return { ok: false, error: code, status: r.status };
    }
    return { ok: true, status: r.status, json };
  }

  /** 设备登记（幂等）；租户根公钥未入组时先开通（G0）。 */
  private async register(): Promise<string> {
    const body = { tid: this.d.tenantId, cert: this.d.device.cert };
    let r = await this.call("POST", "/v1/devices/register", body);
    if (!r.ok && r.error === "root_not_enrolled") {
      const root = this.d.firmRoot?.() ?? null;
      if (!root) return "root_not_enrolled";
      const ts = this.d.now?.() ?? Date.now();
      const proof = sign(null, enrollProofBytes(this.d.tenantId, root.publicKeyPem, ts), root.privateKeyPem).toString("base64url");
      const e = await this.call("POST", "/v1/enroll", { tid: this.d.tenantId, root_public_key_pem: root.publicKeyPem, ts, proof });
      if (!e.ok) return `enroll:${e.error}`;
      r = await this.call("POST", "/v1/devices/register", body);
    }
    return r.ok ? "ok" : r.error;
  }

  private clockAlert(serverTime: unknown): void {
    const t = typeof serverTime === "string" ? Date.parse(serverTime) : NaN;
    const minutes = Number.isFinite(t) ? Math.round(((this.d.now?.() ?? Date.now()) - t) / 60_000) : null;
    const how = minutes === null ? "相差超过 5 分钟" : minutes > 0 ? `快约 ${minutes} 分钟` : `慢约 ${-minutes} 分钟`;
    this.d.gov.alert(
      "clock",
      "clock_skew",
      null,
      `本机时钟比控制面${how}：控制面拒绝了本机的签名请求，同步、许可续期与席位令牌都会失败，许可到期后进入退出模式——请校准系统时间`,
    );
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 一次完整同步（单飞）。retryFailed：手动“立即同步”时连同控制面拒绝过的待同步动作一起重发。 */
  sync(opts: { retryFailed?: boolean } = {}): Promise<SyncReport> {
    if (this.running) return this.running;
    this.running = this.exclusive(() => this.doSync(opts)).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async doSync(opts: { retryFailed?: boolean }): Promise<SyncReport> {
    const { gov } = this.d;
    const steps: Record<string, string> = {};
    const outcome = (o: { accepted: boolean; changed: boolean; code?: string }) => (o.accepted ? (o.changed ? "accepted" : "unchanged") : `rejected:${o.code ?? "?"}`);
    // 一步出错不影响其余步骤（复核 S6-B11：apply 抛出的异常也只记在该步）
    const step = async (name: string, fn: () => Promise<string>) => {
      try {
        steps[name] = await fn();
      } catch (e) {
        steps[name] = `error:${(e as Error)?.message ?? e}`.slice(0, 200);
      }
    };
    await step("register", () => this.register());
    if (steps.register === "ok") {
      await step("pending_actions", async () => `sent:${await this.flushPendingActions(!!opts.retryFailed)}`);
      const fetchDoc = (name: string, path: string, apply: (env: unknown) => { accepted: boolean; changed: boolean; code?: string }) =>
        step(name, async () => {
          const r = await this.call("GET", path);
          return r.ok ? outcome(apply(r.json)) : r.error;
        });
      await fetchDoc("license", "/v1/license", (e) => gov.applyLicense(e));
      await fetchDoc("salt", "/v1/tenant-salt", (e) => gov.applySalt(e));
      await fetchDoc("directory", "/v1/directory", (e) => gov.applyDirectory(e));
      await fetchDoc("policy", "/v1/policy", (e) => gov.applyPolicy(e));
      await fetchDoc("connectors", "/v1/connectors", (e) => gov.applyConnectors(e));
      await step("seat", async () => {
        const exit = gov.exitMode();
        if (exit) return `skipped:${exit.code}`;
        if (!gov.seatInfo().renew_due && gov.seatToken()) return "valid";
        const r = await this.call("POST", "/v1/seat-token", {});
        if (!r.ok) {
          // 控制面答复席位已吊销：清掉本机席位令牌（收紧）
          if (r.error === "seat_revoked") gov.seatRevokedByControlPlane();
          return r.error;
        }
        return typeof r.json.token === "string" ? outcome(gov.applySeatToken(r.json.token)) : "seat_reply_invalid";
      });
      await step("summaries", async () => `pushed:${await this.pushSummaries()}`);
    }
    const ok = Object.values(steps).every((v) => v === "ok" || v === "accepted" || v === "unchanged" || v === "valid" || v.startsWith("pushed:") || v.startsWith("sent:"));
    this.last = { at: new Date(this.d.now?.() ?? Date.now()).toISOString(), ok, steps };
    try {
      this.d.onSynced?.(this.last);
    } catch {
      // 回调异常不影响同步结果
    }
    return this.last;
  }

  /**
   * 补发待同步的收紧动作（本机吊销设备；复核 S6-A12、S6-B04、S6-A22、S6-B31）：控制面应答接受只记“已提交”，完成以控制面签名的目录
   * 把该设备列为吊销为准（控制面对尚未登记的设备记预先吊销，之后拒绝它登记）；控制面拒绝（如本设备证书角色不是管理员或合伙人）
   * 记“拒绝”、不再自动重试；其余失败下次同步重试。返回提交成功的条数。
   */
  private async flushPendingActions(includeFailed = false): Promise<number> {
    let sent = 0;
    for (const a of this.d.gov.pendingActions({ includeFailed })) {
      if (a.kind !== "revoke_device") continue;
      if (!DEVICE_ID_PATTERN.test(a.target)) {
        this.d.gov.markActionResult(a.action_id, "failed", "device_id_invalid");
        continue;
      }
      // 附本机设备表里该设备的证书（本机先核验是律所根签发、编号相符）：控制面对尚未登记的设备只凭这样的证书记预先吊销（复核 S6-C05、S6-C19）
      const cert = this.d.gov.deviceCertificate(a.target);
      const r = await this.call("POST", `/v1/devices/${a.target}/revoke`, cert ? { cert } : {});
      if (r.ok) {
        this.d.gov.markActionResult(a.action_id, "submitted", null);
        sent += 1;
      } else {
        this.d.gov.markActionResult(a.action_id, PERMANENT_ACTION_ERRORS.has(r.error) ? "failed" : "retry", r.error);
      }
    }
    return sent;
  }

  /** 上报待推送的事项匿名摘要（单飞）；返回推送成功条数。 */
  pushSummaries(): Promise<number> {
    if (this.pushing) return this.pushing;
    this.pushing = (async () => {
      let n = 0;
      for (const p of this.d.gov.pendingSummaries()) {
        const r = await this.call("PUT", `/v1/anon-matters/${encodeURIComponent(p.summary.anon)}`, p.summary);
        if (!r.ok) break;
        this.d.gov.markSummaryPushed(p.matter_id, p.summary);
        n += 1;
      }
      return n;
    })().finally(() => {
      this.pushing = null;
    });
    return this.pushing;
  }

  /** 发起任务前尽量让网关拿到该事项的最新摘要（短超时，失败不阻断：网关对摘要尚未到达的事项按请求头检查，D-34）。 */
  async ensureSummary(matterId: string, timeoutMs = 3000): Promise<boolean> {
    this.d.gov.enqueueSummary(matterId);
    if (this.d.gov.summaryPushed(matterId)) return true;
    await Promise.race([this.pushSummaries(), new Promise((r) => setTimeout(r, timeoutMs).unref())]);
    return this.d.gov.summaryPushed(matterId);
  }

  /**
   * 本机吊销设备后立即尝试同步到控制面，控制面接受后再取一次设备目录：控制面签名的目录把该设备列为吊销才算完成（复核 S6-B31）。
   * 返回 synced / submitted（控制面已接受、目录尚未确认）/ pending（暂时失败，下次同步重试）/ failed（控制面拒绝，需人工处理）。
   */
  async syncRevocation(deviceId: string): Promise<"synced" | "submitted" | "pending" | "failed"> {
    return this.exclusive(async () => {
      await this.flushPendingActions().catch(() => 0);
      if (this.d.gov.revocationState(deviceId) === "submitted") {
        const r = await this.call("GET", "/v1/directory").catch(() => null);
        if (r?.ok) this.d.gov.applyDirectory(r.json);
      }
      return this.d.gov.revocationState(deviceId);
    });
  }

  /** 定时同步；间隔钳在 10 秒～1 小时（复核 S6-A21）。 */
  start(intervalMs: number): void {
    if (this.timer) return;
    void this.sync().catch(() => {});
    this.timer = setInterval(() => void this.sync().catch(() => {}), Math.min(SYNC_MAX_INTERVAL_MS, Math.max(10_000, intervalMs)));
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ─── 管理员：起草 → 签名 → 发布 ───

  private view(raw: Record<string, unknown>): DraftView {
    const kind = raw.kind === "connector" ? "connector" : "policy";
    const doc = raw.doc as FirmPolicyDoc | FirmConnectorDoc;
    let valid = true;
    let problem: string | null = null;
    let relaxations: string[] = [];
    let bytes: Buffer | null = null;
    if (kind === "policy") {
      const v = validatePolicyDoc(doc);
      if (!v.ok) {
        valid = false;
        problem = v.reason;
      } else if (v.value.tid !== this.d.tenantId) {
        valid = false;
        problem = "tenant_mismatch";
      } else if (Date.parse(v.value.expires_at) - Date.parse(v.value.issued_at) > POLICY_MAX_TTL_MS) {
        valid = false;
        problem = "ttl_too_long";
      } else {
        relaxations = policyRelaxations(v.value.body);
        bytes = policySigningBytes(v.value);
        // 已有同版本或更高版本生效：草稿已过时（控制面也会拒绝发布；复核 S6-B29）
        if (v.value.version <= this.d.gov.acceptedVersion("policy")) {
          valid = false;
          problem = "已有同版本或更高版本的律所策略生效，本草稿已过时，请重新起草";
        }
      }
    } else {
      const v = validateConnectorDoc(doc);
      if (!v.ok) {
        valid = false;
        problem = v.reason;
      } else if (v.value.tid !== this.d.tenantId) {
        valid = false;
        problem = "tenant_mismatch";
      } else {
        relaxations = [`connector:${v.value.connector_id}（${v.value.tools.length} 个工具，可接收至 ${v.value.max_data_level}）`];
        bytes = connectorSigningBytes(v.value);
        if (v.value.version <= this.d.gov.acceptedVersion(`connector:${v.value.connector_id}`)) {
          valid = false;
          problem = "该连接器已有同版本或更高版本的登记生效，本草稿已过时，请重新起草";
        }
      }
    }
    // 已签名成员只显示本机核验通过的（复核 S6-B22）
    const sigs = (Array.isArray(raw.admin_signatures) ? raw.admin_signatures : []) as AdminSignature[];
    const signedBy = bytes ? verifyAdminSignatures(bytes, sigs, this.d.gov.trustContext()) : null;
    const signed_by = signedBy ? Object.entries(signedBy.deviceMembers).map(([device_id, member_id]) => ({ device_id, member_id })) : [];
    return {
      draft_id: String(raw.draft_id ?? ""),
      kind,
      created_at: typeof raw.created_at === "string" ? raw.created_at : null,
      doc,
      digest: bytes ? bytesDigest(bytes) : null,
      relaxations,
      signed_by,
      signed_by_me: signed_by.some((s) => s.device_id === this.d.device.deviceId),
      valid,
      problem,
    };
  }

  async drafts(): Promise<DraftView[]> {
    const r = await this.call("GET", "/v1/drafts");
    if (!r.ok) throw new Error(r.error);
    return (Array.isArray(r.json.drafts) ? (r.json.drafts as Record<string, unknown>[]) : []).map((d) => this.view(d));
  }

  async createDraft(input: { kind: "policy"; body: unknown; ttl_days?: number } | { kind: "connector"; connector: unknown }): Promise<DraftView> {
    const r = await this.call("POST", "/v1/drafts", input);
    if (!r.ok) throw new Error(r.error);
    return this.view(r.json.draft as Record<string, unknown>);
  }

  /**
   * 管理员设备签名：先取草稿、本机核验，并与管理员在界面上看到的那份比对（待签字节摘要须一致——复核 S6-B02），合法且一致才签。
   */
  async signDraft(draftId: string, expectedDigest: string): Promise<DraftView> {
    if (!/^drf_[0-9a-f]{16}$/.test(draftId)) throw new Error("draft_id 不合法");
    if (typeof expectedDigest !== "string" || expectedDigest.length < 20) throw new Error("签名须带上界面所见草稿的摘要");
    const g = await this.call("GET", `/v1/drafts/${draftId}`);
    if (!g.ok) throw new Error(g.error);
    const view = this.view(g.json.draft as Record<string, unknown>);
    if (!view.valid) throw new Error(`草稿未通过本机核验（${view.problem}）：不签名`);
    if (view.digest !== expectedDigest) {
      this.d.gov.alert("drafts", "draft_changed_before_signing", draftId, "签名时控制面返回的草稿与界面上展示的不同：已拒绝签名（请重新核对草稿内容）");
      throw new Error("草稿内容与界面展示的不一致：未签名（已告警）");
    }
    const checked = view.kind === "policy" ? validatePolicyDoc(view.doc) : validateConnectorDoc(view.doc);
    if (!checked.ok) throw new Error(`草稿未通过本机核验（${checked.reason}）：不签名`);
    const bytes = view.kind === "policy" ? policySigningBytes(checked.value as FirmPolicyDoc) : connectorSigningBytes(checked.value as FirmConnectorDoc);
    const sig = adminSign(bytes, this.d.device.cert, this.d.device.signer);
    const r = await this.call("POST", `/v1/drafts/${draftId}/signatures`, sig);
    if (!r.ok) throw new Error(r.error);
    return this.view(r.json.draft as Record<string, unknown>);
  }

  // ─── 用量与上限（第 9 批 S3） ───

  /** 本所本月用量与上限（控制面签名的视图；管理员与合伙人另含按成员明细与池余额）。 */
  async quota(): Promise<QuotaView> {
    const r = await this.call("GET", "/v1/quota");
    if (!r.ok) throw new Error(r.error);
    const v = this.d.gov.openSigned<QuotaView & { tid: string }>(r.json, "kwl-quota-view");
    if (!v || v.tid !== this.d.tenantId) throw new Error("quota_view_invalid");
    return v;
  }

  /** 管理员设月度上限（点数；null = 不设上限）。 */
  async setQuotaCap(cap: number | null): Promise<{ cap_monthly: number | null }> {
    if (cap !== null && !(Number.isSafeInteger(cap) && cap >= 0)) throw new Error("月度上限须为非负整数点数");
    const r = await this.call("PUT", "/v1/quota/cap", { monthly_cap: cap });
    if (!r.ok) throw new Error(r.error);
    return { cap_monthly: (r.json.cap_monthly as number | null) ?? null };
  }

  // ─── 中软侧操作记录（第 9 批 S14） ───

  /**
   * 取回本机还没有的运营审计流水：验控制面签名、验哈希链、与本机见过的最高序号对照（同一序号 hash 不同 = 云端改写了历史，告警且不覆盖）；
   * 通过的记录留存在本机（云端之后删改，本机仍有原记录）。返回本次新增条数与云端当前最高序号。
   */
  async fetchAudit(): Promise<{ added: number; head: number }> {
    const anchor = this.d.gov.auditAnchor();
    // 有锚点时从锚点那一条开始取（重新取回它、比对 hash）
    let after = anchor ? anchor.seq - 1 : 0;
    let link: { seq: number; hash: string } = anchor ? { seq: anchor.seq - 1, hash: "" } : { seq: 0, hash: AUDIT_GENESIS };
    let added = 0;
    let head = anchor?.seq ?? 0;
    for (let page = 0; page < 200; page++) {
      const r = await this.call("GET", `/v1/audit?after=${after}&limit=500`);
      if (!r.ok) throw new Error(r.error);
      const body = this.d.gov.openSigned<CpAuditPage>(r.json, "kwl-cp-audit-page");
      if (!body || body.tid !== this.d.tenantId || !Array.isArray(body.records) || !body.head || !Number.isSafeInteger(body.head.seq)) {
        this.d.gov.alert("cp_audit", "cp_audit_page_invalid", null, "中软侧操作记录未通过控制面签名核验：已拒收");
        throw new Error("cp_audit_page_invalid");
      }
      let recs: unknown[] = body.records;
      if (page === 0 && anchor) {
        const first = recs[0] as CpAuditRecord | undefined;
        if (!first || first.seq !== anchor.seq || first.hash !== anchor.hash) {
          this.d.gov.alert("cp_audit", "cp_audit_rewritten", String(anchor.seq), `中软侧操作记录第 ${anchor.seq} 条与本机此前取回的不一致（云端改写或删除了已给出的历史）：已拒收，本机留存的原记录不变`);
          throw new Error("cp_audit_rewritten");
        }
        link = { seq: first.seq, hash: first.hash };
        recs = recs.slice(1);
      }
      const v = verifyAuditChain(recs, this.d.tenantId, link);
      if (!v.ok) {
        this.d.gov.alert("cp_audit", "cp_audit_chain_invalid", v.seq === null ? null : String(v.seq), `中软侧操作记录未通过哈希链核验（${v.reason}）：已拒收`);
        throw new Error("cp_audit_chain_invalid");
      }
      const ok = recs as CpAuditRecord[];
      const st = this.d.gov.storeAuditRecords(ok);
      if (st.conflicts.length) {
        this.d.gov.alert("cp_audit", "cp_audit_rewritten", String(st.conflicts[0]), `中软侧操作记录第 ${st.conflicts[0]} 条与本机留存的不一致：已拒收，本机留存的原记录不变`);
        throw new Error("cp_audit_rewritten");
      }
      added += st.stored;
      const last = ok.at(-1);
      if (last) {
        this.d.gov.raiseAuditAnchor(last.seq, last.hash);
        link = { seq: last.seq, hash: last.hash };
        after = last.seq;
      }
      head = Math.max(head, last?.seq ?? 0);
      if (!last || last.seq >= body.head.seq) {
        // 分页说已到头，但云端的最高序号比给出的多：扣下了记录
        if (body.head.seq > head) {
          this.d.gov.alert("cp_audit", "cp_audit_withheld", String(body.head.seq), `中软侧操作记录最高序号为 ${body.head.seq}，只给出到 ${head}`);
        }
        return { added, head: body.head.seq };
      }
    }
    return { added, head };
  }

  async publishDraft(draftId: string): Promise<{ ok: true }> {
    if (!/^drf_[0-9a-f]{16}$/.test(draftId)) throw new Error("draft_id 不合法");
    const r = await this.call("POST", `/v1/drafts/${draftId}/publish`, {});
    if (!r.ok) throw new Error(r.error);
    return { ok: true };
  }
}
