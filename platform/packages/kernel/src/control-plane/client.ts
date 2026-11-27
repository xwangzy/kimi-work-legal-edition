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
import { slog } from "@zr-legal/safe-log";
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
  /** 第 66 批（V40，D-292）：创始设备的律所公钥包（恢复托管公钥 + 律所根签名，公开数据）——随登记上传，控制面下发给个人账号的新电脑。 */
  firmBundle?: () => { recovery_public_key_pem: string; sig: string } | null;
  /** 第 13 批：经开通码激活的创始设备，首次登记根公钥时出示的认领凭据（登记成功后 onEnrolled 删除暂存）。 */
  activationClaim?: () => { activation_id: string; claim_secret: string } | null;
  onEnrolled?: () => void;
  now?: () => number;
  /**
   * 客户端版本（v9.3 P3：客户端版本分布统计——控制面轮换签名密钥前要看旧版本活跃设备的比例，设计 §4.7）：
   * 随设备登记请求体一起发出（请求体在设备签名覆盖之内）；不合格的不发。
   */
  clientVersion?: string | null;
  /** 每次同步结束后（内核据此在退出模式解除后恢复暂停的任务；复核 S6-B34）。 */
  onSynced?: (report: SyncReport) => void;
  /** 第 44 批：本机保存的账号会话令牌（附在 x-kwl-session 头里；没有 = 不附）。 */
  sessionToken?: () => string | null;
  /** 控制面答复“要重新登录”（会话无效、过期、账号停用）时回调（内核据此提示重新登录）。 */
  /** 第 64 批：第二个参数是这次请求带的会话令牌（没带为 null）——答复回来时本机已换了会话（刚重新登录），就不是现在这次登录的问题。 */
  onSessionProblem?: (code: string, sentSession: string | null) => void;
  /** 第 72 批（A1 H2）：首次同步没成的退避重试间隔（毫秒；用例调短）。缺省 2、4、8、16、30 秒。 */
  firstSyncRetryMs?: readonly number[];
}

/** 第 72 批（A1 H2）：首次同步（register 或席位令牌）没成时按此退避重试，用尽后回到常规间隔。 */
export const FIRST_SYNC_RETRY_MS: readonly number[] = [2_000, 4_000, 8_000, 16_000, 30_000];

/**
 * 同步间隔上限（复核 S6-A21）：席位令牌签发 96 小时、剩余不足 73 小时即续期，“控制面停机后仍有 ≥ 72 小时”依赖同步间隔 ≤ 1 小时。
 */
export const SYNC_MAX_INTERVAL_MS = 3600 * 1000;

/** 客户端版本号：数字点分，可带短后缀（与控制面同一口径）。 */
export const CLIENT_VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9a-z.]{1,20})?$/;

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
  /** 第 72 批（A1 §2.4 T1）：各段用时（毫秒）：register、docs（五份文档并行取 + 逐个应用）、seat、total。 */
  ms?: Record<string, number>;
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

/**
 * 本所用量视图（第 44 批 v2，控制面 quotaView）：百分比、剩余、单位（tokens 或元）、统计周期与重置时间、5 小时频率窗口、
 * 自己的用量（分母 = 个人上限或每席位额度，写明来源与是否硬性生效）、按模型；管理员与合伙人另有用量数与按成员明细。
 */
export interface QuotaView {
  tid: string;
  issued_at: string;
  /** 第 66 批（V40）：note / period / burst / models（可用模型显示名，与模型目录同源）是追加字段，旧控制面没有。 */
  plan: { id: string; label: string; note?: string | null; period?: "month" | "week"; burst?: { hours: number; pct: number } | null; models?: string[]; valid_until?: string | null };
  account: { aid: string; email: string; name: string } | null;
  accounts_required: boolean;
  unit: "tokens" | "cny";
  unit_label: string;
  period: { kind: "month" | "week"; key: string; start: string; resets_at: string };
  firm: { used_ratio: number; remaining_ratio: number; in_flight_ratio: number; paused: "cap" | "allowance" | "burst" | null; cap_pct: number | null; cap_set_at: string | null; boost_pct: number; legacy_used_ratio: number | null; used: number | null; total: number | null; seats: number; denominator: string };
  burst: { hours: number; pct: number; used_ratio: number; resets_at: string | null } | null;
  own: { used_ratio: number; denominator: "account_limit" | "seat_quota"; enforced: boolean; used: number; total: number; requests: number; tokens: number; value_cny: number | null; estimated_rows: number } | null;
  history: { period: string; used_ratio: number | null; legacy: boolean }[];
  models: { alias: string; used: number; share: number; requests: number }[];
  by_member?: { uid: string | null; name: string | null; used: number; used_ratio_of_firm: number; requests: number }[];
  boosts?: { at: string; pct: number }[];
  unreconciled_leases?: number;
  /**
   * 第 66 批（V40）：个人口径——真正卡住“我”的那一项（额度、律所上限、频率窗口、个人上限四者最小）。limited_by = 正在卡住的那项（null = 都没卡）；
   * 旧控制面没有这一段（界面回退到 own）。
   */
  personal?: {
    used_ratio: number;
    remaining_ratio: number;
    limited_by: "allowance" | "cap" | "burst" | "seat" | null;
    paused: "allowance" | "cap" | "burst" | "seat" | null;
    in_flight_ratio?: number;
    /** 第 69 批（V43）：本期按天（北京日期升序、只含有调用的日子；ratio 与 used_ratio 同一分母，各日之和 = used_ratio）。旧控制面没有。 */
    daily?: { day: string; ratio: number; requests: number; qa_requests: number }[];
    /** 第 69 批（V43）：本期按用途（任务 + 问答 = used_ratio）。旧控制面没有。 */
    by_kind?: { task: { ratio: number; requests: number }; qa: { ratio: number; requests: number } };
  };
  ratio_basis?: "personal";
  /** 第 66 批：本人本期按模型（份额按 token，不含金额）；第 69 批追加 used_ratio（计入本人额度的比例，各模型之和 = personal.used_ratio）。 */
  own_models?: { alias: string; label: string; share: number; requests: number; used_ratio?: number }[];
}

/** 第 66 批（V40）：本人用量明细的一行（与 /v1/quota 的 own_recent 同口径，不含金额与请求内容）。 */
export interface UsagePageRow {
  at: string;
  kind: "qa" | "task";
  alias: string | null;
  label: string | null;
  tokens_in: number;
  tokens_cached: number;
  tokens_out: number;
  charge_ratio: number;
  outcome: string;
  partial: boolean;
  estimated: boolean;
  pending: boolean;
  in_period: boolean;
  /** 第 70 批（V44）：出站闸门给这次请求生成的编号（kwlg_…；云端 1.5.1 起有，旧云端没有这一字段）与是否本机发出。 */
  client_request_id?: string | null;
  this_device?: boolean;
}

type CallResult = { ok: true; status: number; json: Record<string, unknown> } | { ok: false; error: string; status?: number; message?: string; retry_after_s?: number };
/**
 * 账号接口路径（本地先粗查，闸门白名单再精确核对）。第 63 批：原来只认小写，第 2～9 台电脑的设备编号（…_D2）与登录编号（ses_ 后面是
 * base64url，大小写都有）在本机就被拒——“我的电脑 → 解绑”“登录记录 → 让这处下线”自第 44 批起在桌面端从没成功过（报“没有完成，请稍后重试”）。
 */
export const ACCOUNT_PATH = /^\/v1\/auth\/[A-Za-z0-9/_-]{2,120}$/;
/**
 * 第 72 批（契约 02 §3～§4）：工作空间、团队与账号上手状态接口（同样是账号会话 + 设备签名；闸门白名单再精确核对）：
 * /v1/workspace/upgrade、/v1/teams/{join,leave}、/v1/team/invites…、/v1/firm/…（团队成员管理）、/v1/me/onboarding。
 */
export const TEAM_PATH = /^\/v1\/(?:workspace|teams|team|firm|me)\/[A-Za-z0-9/_-]{2,120}$/;
const SESSION_PROBLEMS: ReadonlySet<string> = new Set(["session_required", "session_invalid", "session_expired", "account_disabled", "session_member_mismatch", "session_signed_out", "session_signed_out_admin", "session_signed_out_support", "session_device_limit"]);

export class ControlPlaneClient {
  private readonly d: ControlPlaneClientDeps;
  private last: SyncReport | null = null;
  private running: Promise<SyncReport> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private pushing: Promise<number> | null = null;
  /** 应用控制面文档的操作串行执行（同步与吊销即时同步；复核 S6-C07：交错时较旧的目录会在之后被判“回放”误报）。 */
  private lock: Promise<void> = Promise.resolve();
  /** 最近一次取到并验过签的用量视图与取到的时刻（第 46 批：发起任务前按它判断额度是否暂停，不在发起时同步请求控制面）。 */
  private quotaCache: { view: QuotaView; at: number } | null = null;
  private quotaRefreshing: Promise<unknown> | null = null;
  /** 控制面答复“客户端版本过旧”（426 client_outdated，主文 §2.5）：记下最低版本；之后签出席位令牌即清除。 */
  private outdated: { min_version: string | null; at: number } | null = null;

  constructor(d: ControlPlaneClientDeps) {
    this.d = d;
  }

  /**
   * 第 71 批（V45，首次打开的竞态）：刚开通 / 入组的电脑，内核重启后第一次同步才在云端登记这台电脑；登记完成前界面查用量、取模型目录，
   * 云端只会答 device_unknown_or_revoked（Windows 线上日志与本机复现都有：首屏用量报错、模型目录要等 10 分钟后才再取）。
   * start() 时记下“首次登记这一步”的完成信号，用量、模型目录、账号接口先等它（至多 8 秒；不开同步的形态不等）。
   */
  private registerSettled: Promise<void> | null = null;
  private resolveRegister: (() => void) | null = null;
  private async afterFirstRegister(): Promise<void> {
    const p = this.registerSettled;
    if (!p) return;
    await Promise.race([
      p,
      new Promise<void>((r) => {
        const t = setTimeout(r, 8000);
        t.unref?.();
      }),
    ]);
  }

  /** 最近一次的用量视图（没有取到过为 null；调用方按 at 判断是否过时）。 */
  cachedQuota(): { view: QuotaView; at: number } | null {
    return this.quotaCache;
  }

  /** 缓存比 maxAgeMs 旧（或没有）时在后台取一次（单飞；失败不抛，不阻塞调用方）。 */
  refreshQuotaIfStale(maxAgeMs: number): void {
    const now = this.d.now?.() ?? Date.now();
    if (this.quotaRefreshing || (this.quotaCache && now - this.quotaCache.at < maxAgeMs)) return;
    this.quotaRefreshing = this.quota()
      .catch(() => undefined)
      .finally(() => {
        this.quotaRefreshing = null;
      });
  }

  /** 控制面最近答复过“客户端版本过旧”（null = 没有）。 */
  clientOutdated(): { min_version: string | null; at: number } | null {
    return this.outdated;
  }

  get lastSync(): SyncReport | null {
    return this.last;
  }

  /** 设备签名的控制面请求（第 13 批成员管理：邀请、待批准列表、批准与拒绝）；不进同步单飞。 */
  request(method: string, path: string, body?: unknown): Promise<CallResult> {
    return this.call(method, path, body);
  }

  private async call(method: string, path: string, body?: unknown, sessionOverride?: string): Promise<CallResult> {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const session = sessionOverride ?? this.d.sessionToken?.() ?? null;
    const headers = { ...signDeviceRequest({ method, path, body: raw, tid: this.d.tenantId, deviceId: this.d.device.deviceId, signer: this.d.device.signer, ...(this.d.now ? { now: this.d.now() } : {}) }), ...(session ? { "x-kwl-session": session } : {}) };
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
      // 第 44 批：会话无效、过期或账号停用 → 提示重新登录（席位令牌不再续期，网关按订阅暂停本设备）
      if (SESSION_PROBLEMS.has(code)) this.d.onSessionProblem?.(code, session);
      // 第 46 批：客户端版本低于控制面要求（426）——记下最低版本，发起任务前与诊断据此提示升级
      if (code === "client_outdated") {
        const mv = (json.error as { min_version?: unknown } | undefined)?.min_version;
        this.outdated = { min_version: typeof mv === "string" && mv.length <= 40 ? mv : null, at: this.d.now?.() ?? Date.now() };
      }
      // 第 63 批：验证码重发、锁定还要等几秒（已激活电脑上的验证码登录与绑定手机号按它倒计时）
      const ra = (json.error as { retry_after_s?: unknown } | undefined)?.retry_after_s;
      return { ok: false, error: code, status: r.status, ...(typeof (json.error as { message?: unknown } | undefined)?.message === "string" ? { message: String((json.error as { message: string }).message).slice(0, 200) } : {}), ...(Number.isSafeInteger(ra) && (ra as number) > 0 && (ra as number) <= 86_400 ? { retry_after_s: ra as number } : {}) };
    }
    return { ok: true, status: r.status, json };
  }

  /** 设备登记（幂等）；租户根公钥未入组时先开通（G0）。 */
  private async register(): Promise<string> {
    const v = this.d.clientVersion;
    const fb = this.d.firmBundle?.() ?? null;
    const body = { tid: this.d.tenantId, cert: this.d.device.cert, ...(v && CLIENT_VERSION_RE.test(v) ? { client: { version: v } } : {}), ...(fb ? { firm_bundle: fb } : {}) };
    // 第 71 批：刚开通的创始设备（还握着认领凭据）律所根一定还没登记——直接先登记根，省掉一次注定失败的往返
    const pendingClaim = this.d.activationClaim?.() ?? null;
    let r: CallResult = pendingClaim && this.d.firmRoot?.() ? { ok: false, error: "root_not_enrolled" } : await this.call("POST", "/v1/devices/register", body);
    if (!r.ok && r.error === "root_not_enrolled") {
      const root = this.d.firmRoot?.() ?? null;
      if (!root) return "root_not_enrolled";
      const ts = this.d.now?.() ?? Date.now();
      const proof = sign(null, enrollProofBytes(this.d.tenantId, root.publicKeyPem, ts), root.privateKeyPem).toString("base64url");
      const claim = this.d.activationClaim?.() ?? null;
      const e = await this.call("POST", "/v1/enroll", { tid: this.d.tenantId, root_public_key_pem: root.publicKeyPem, ts, proof, ...(claim ? { activation_id: claim.activation_id, claim_secret: claim.claim_secret } : {}), ...(fb ? { firm_bundle: fb } : {}) });
      if (!e.ok) {
        // 第 71 批：跳过了第一次登记、而律所根其实已登记过（上次登记后认领凭据没来得及删）——照常登记设备，成功即删掉过期的认领凭据
        if (pendingClaim) {
          const again = await this.call("POST", "/v1/devices/register", body);
          if (again.ok) {
            this.d.onEnrolled?.();
            return "ok";
          }
        }
        return `enroll:${e.error}`;
      }
      if (claim) this.d.onEnrolled?.();
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
    const ms: Record<string, number> = {};
    const t0 = Date.now();
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
    ms.register = Date.now() - t0;
    // 第 71 批：首次登记这一步有结果了（成功或失败都放行，等着的请求照常发出、如实报错）。
    // 第 72 批（A1 H2）：首次同步失败会退避重试——没成时先不放行，等重试成功或重试用尽（等着的请求另有 8 秒封顶）
    if (this.resolveRegister && (steps.register === "ok" || !this.firstRetryPending)) this.settleRegister();
    if (steps.register === "ok") {
      await step("pending_actions", async () => `sent:${await this.flushPendingActions(!!opts.retryFailed)}`);
      // 第 71 批（V45）：五份文档并行取（原来逐个串行，开通后首次同步约 11 次往返，跨地域时要几秒），仍按原顺序逐个验签应用
      const docs: [string, string, (env: unknown) => { accepted: boolean; changed: boolean; code?: string }][] = [
        ["license", "/v1/license", (e) => gov.applyLicense(e)],
        ["salt", "/v1/tenant-salt", (e) => gov.applySalt(e)],
        ["directory", "/v1/directory", (e) => gov.applyDirectory(e)],
        ["policy", "/v1/policy", (e) => gov.applyPolicy(e)],
        ["connectors", "/v1/connectors", (e) => gov.applyConnectors(e)],
      ];
      // 第 72 批（A1 S6）：席位令牌与五份文档同时发出（省一次往返：首次登记后 AI 早一个往返可用）。只在本机此刻没有因吊销 / 未配置而停用时
      // 预先请求；许可还没取到或已到期的照样先请求（新许可可能正好解除），应用完许可后仍在退出模式就丢弃这份令牌、不采用——采用与否仍以应用后的许可为准
      const preExit = gov.exitMode();
      const wantSeat = (!preExit || preExit.code === "license_missing" || preExit.code === "license_expired") && (gov.seatInfo().renew_due || !gov.seatToken());
      const tDocs = Date.now();
      const seatEarly = wantSeat ? this.call("POST", "/v1/seat-token", {}).catch((e: unknown) => ({ ok: false as const, error: `error:${(e as Error)?.message ?? e}`.slice(0, 200) })) : null;
      const fetched = await Promise.all(docs.map(([, path]) => this.call("GET", path).catch((e: unknown) => ({ ok: false as const, error: `error:${(e as Error)?.message ?? e}`.slice(0, 200) }))));
      for (let i = 0; i < docs.length; i++) {
        const [name, , apply] = docs[i]!;
        const r = fetched[i]!;
        await step(name, async () => (r.ok ? outcome(apply(r.json)) : r.error));
      }
      ms.docs = Date.now() - tDocs;
      const tSeat = Date.now();
      await step("seat", async () => {
        const exit = gov.exitMode();
        if (exit) return `skipped:${exit.code}`;
        if (!seatEarly && !gov.seatInfo().renew_due && gov.seatToken()) return "valid";
        const r = (await seatEarly) ?? (await this.call("POST", "/v1/seat-token", {}));
        if (!r.ok) {
          // 控制面答复席位已吊销：清掉本机席位令牌（收紧）
          if (r.error === "seat_revoked") gov.seatRevokedByControlPlane();
          return r.error;
        }
        if (typeof r.json.token === "string") this.outdated = null;
        return typeof r.json.token === "string" ? outcome(gov.applySeatToken(r.json.token)) : "seat_reply_invalid";
      });
      ms.seat = Date.now() - tSeat;
      await step("summaries", async () => `pushed:${await this.pushSummaries()}`);
    }
    ms.total = Date.now() - t0;
    const ok = Object.values(steps).every((v) => v === "ok" || v === "accepted" || v === "unchanged" || v === "valid" || v.startsWith("pushed:") || v.startsWith("sent:"));
    this.last = { at: new Date(this.d.now?.() ?? Date.now()).toISOString(), ok, steps, ms };
    slog.event("KERNEL_CP_SYNC", { ms: ms.total, register_ms: ms.register ?? 0, ...(ms.docs !== undefined ? { docs_ms: ms.docs } : {}), ...(ms.seat !== undefined ? { seat_ms: ms.seat } : {}), ok, register_ok: steps.register === "ok", seat: seatOutcomeOf(steps.seat), first: this.inFirstRound });
    if (!this.aiReadyLogged && gov.seatToken()) {
      this.aiReadyLogged = true;
      slog.event("KERNEL_AI_READY", { since_boot_ms: Math.round(process.uptime() * 1000) });
    }
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
    // 移出成员时没释放成的席位（复核 R15A-11）：随同步重试；对方从没拿到过席位按已释放
    for (const uid of this.d.gov.pendingSeatReleases()) {
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(uid)) continue;
      const r = await this.call("POST", `/v1/seats/${uid}/revoke`, {});
      const released = r.ok || r.error === "seat_unknown";
      this.d.gov.markSeatRelease(uid, released, released ? null : r.error);
      if (released) sent += 1;
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
    this.registerSettled ??= new Promise<void>((r) => {
      this.resolveRegister = r;
    });
    const delays = this.d.firstSyncRetryMs ?? FIRST_SYNC_RETRY_MS;
    this.firstRetryPending = delays.length > 0;
    this.inFirstRound = true;
    // 第 72 批（A1 H2）：首次同步（登记这台电脑、取席位令牌）没成时按 2/4/8/16/30 秒退避重试——此前要等 10 分钟一次的定时同步，
    // 首次 register 碰上网络抖动或云端忙，AI 最长 10 分钟不可用，律师看来就是“登记没完成”。重试只在启动后这一轮，成功即停
    const attempt = (i: number): void => {
      void this.sync()
        .catch(() => null)
        .then((rep) => {
          if (this.stopped) return;
          if ((rep && firstSyncDone(rep)) || i >= delays.length) {
            this.inFirstRound = false;
            this.firstRetryPending = false;
            this.settleRegister();
            return;
          }
          if (i === delays.length - 1) this.firstRetryPending = false;
          this.firstRetryTimer = setTimeout(() => attempt(i + 1), delays[i]);
          this.firstRetryTimer.unref?.();
        });
    };
    attempt(0);
    this.timer = setInterval(() => void this.sync().catch(() => {}), Math.min(SYNC_MAX_INTERVAL_MS, Math.max(10_000, intervalMs)));
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.firstRetryTimer) clearTimeout(this.firstRetryTimer);
    this.firstRetryTimer = null;
    this.settleRegister();
  }

  /** 放行等“首次登记”的请求（成功、重试用尽或停止时）。 */
  private settleRegister(): void {
    if (!this.resolveRegister) return;
    this.resolveRegister();
    this.resolveRegister = null;
    this.registerSettled = null;
  }
  private firstRetryPending = false;
  private firstRetryTimer: NodeJS.Timeout | null = null;
  private inFirstRound = false;
  private stopped = false;
  private aiReadyLogged = false;

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
      this.d.gov.alert("drafts", "draft_changed_before_signing", draftId, "签名时服务器返回的草稿与你在界面上看到的不一致：已拒绝签名（请重新核对草稿内容）");
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

  // ─── 支持服务专用凭据（第 9 批复核 S9B-03） ───

  /** 只限支持服务、15 分钟的凭据（受众 support）：诊断包上传用它，通用席位令牌不发给支持服务。 */
  async supportToken(): Promise<string> {
    const r = await this.call("POST", "/v1/support-token", {});
    if (!r.ok) throw new Error(r.error);
    const tok = r.json.token;
    if (typeof tok !== "string" || !/^zst1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(tok)) throw new Error("support_token_invalid");
    return tok;
  }

  /** 只限通知服务、6 小时的凭据（受众 notify；第 10 批 S9 期限提醒）。返回凭据与到期时刻（毫秒）。 */
  async notifyToken(): Promise<{ token: string; expiresAt: number }> {
    const r = await this.call("POST", "/v1/notify-token", {});
    if (!r.ok) throw new Error(r.error);
    const tok = r.json.token;
    const exp = Date.parse(String(r.json.expires_at ?? ""));
    if (typeof tok !== "string" || !/^zst1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(tok) || !Number.isFinite(exp)) throw new Error("notify_token_invalid");
    return { token: tok, expiresAt: exp };
  }

  /** 只限共享中继、6 小时的凭据（受众 relay；第 11 批 S11 团队事项密文同步）。返回凭据与到期时刻（毫秒）。 */
  async relayToken(): Promise<{ token: string; expiresAt: number }> {
    const r = await this.call("POST", "/v1/relay-token", {});
    if (!r.ok) throw new Error(r.error);
    const tok = r.json.token;
    const exp = Date.parse(String(r.json.expires_at ?? ""));
    if (typeof tok !== "string" || !/^zst1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(tok) || !Number.isFinite(exp)) throw new Error("relay_token_invalid");
    return { token: tok, expiresAt: exp };
  }

  // ─── 用量与上限（第 9 批 S3） ───

  /** 本所本月用量与上限（控制面签名的视图；管理员与合伙人另含按成员明细与池余额）。 */
  async quota(): Promise<QuotaView> {
    await this.afterFirstRegister();
    const r = await this.call("GET", "/v1/quota");
    if (!r.ok) throw new Error(r.error);
    const v = this.d.gov.openSigned<QuotaView & { tid: string }>(r.json, "kwl-quota-view");
    if (!v || v.tid !== this.d.tenantId) throw new Error("quota_view_invalid");
    this.quotaCache = { view: v, at: this.d.now?.() ?? Date.now() };
    return v;
  }

  /**
   * 第 66 批（V40）：本人用量明细翻页（GET /v1/quota/usage；控制面签名信封 kwl-usage-page）。只收本租户、本人（证书成员）的页。
   */
  async quotaUsagePage(o: { before?: string | null; limit?: number }): Promise<{ rows: UsagePageRow[]; next_before: string | null }> {
    const lim = Math.min(100, Math.max(1, Math.floor(o.limit ?? 50)));
    const before = o.before && Number.isFinite(Date.parse(o.before)) ? new Date(Date.parse(o.before)).toISOString() : null;
    await this.afterFirstRegister();
    const r = await this.call("GET", `/v1/quota/usage?${before ? `before=${before}&` : ""}limit=${lim}`);
    if (!r.ok) throw new Error(r.error);
    const v = this.d.gov.openSigned<{ tid: string; uid: string; rows: UsagePageRow[]; next_before: string | null }>(r.json, "kwl-usage-page");
    if (!v || v.tid !== this.d.tenantId || v.uid !== this.d.device.cert.memberId || !Array.isArray(v.rows)) throw new Error("usage_page_invalid");
    return { rows: v.rows, next_before: typeof v.next_before === "string" ? v.next_before : null };
  }

  /**
   * 第 66 批：可用模型目录（GET /v1/models）。返回控制面签名信封原样——验签、只进不退与缓存在 ModelCatalogService（缓存存原信封，读回重验）。
   * 失败抛带 code 的错误（离线、会话失效等；调用方用上一版）。
   */
  async modelCatalogEnvelope(): Promise<unknown> {
    await this.afterFirstRegister();
    const r = await this.call("GET", "/v1/models");
    if (!r.ok) throw Object.assign(new Error(r.error), { code: r.error });
    return r.json;
  }

  /** 管理员设月度上限（本月总额度的百分比 1–100；null = 不设上限）。 */
  async setQuotaCap(capPct: number | null): Promise<{ cap_pct: number | null }> {
    if (capPct !== null && !(Number.isSafeInteger(capPct) && capPct >= 1 && capPct <= 100)) throw new Error("月度上限须为 1–100 的整数百分比");
    const r = await this.call("PUT", "/v1/quota/cap", { monthly_cap_pct: capPct });
    if (!r.ok) throw new Error(r.error);
    return { cap_pct: (r.json.cap_pct as number | null) ?? null };
  }

  // ─── 账号（第 44 批）：已激活设备上的登录（带设备签名，会话直接绑本机）、退出、改密、设备与会话管理 ───

  /** 账号接口原样调用（带设备签名与会话头）；失败抛带 code 的错误。 */
  async account(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<Record<string, unknown>> {
    if (!ACCOUNT_PATH.test(path) && !TEAM_PATH.test(path)) throw new Error("account_path_invalid");
    await this.afterFirstRegister();
    const r = await this.call(method, path, method === "GET" ? undefined : (body ?? {}));
    if (!r.ok) throw Object.assign(new Error(r.error), { code: r.error, cpMessage: r.message ?? null, status: r.status ?? null, retryAfter: r.retry_after_s ?? null, ...(r.error === "client_outdated" ? { minVersion: this.outdated?.min_version ?? null } : {}) });
    return r.json;
  }

  /**
   * 第 71 批（V45，D-298）：带本机设备签名、但用指定会话的账号接口调用——同一账号在这台已登记的电脑上重新登录、同时登录已满时，
   * 本次登录的会话还没绑这台电脑（不是本档案存着的会话），让出一台之后用它带签名取 /v1/auth/onboarding，云端即把会话绑到这台电脑。
   */
  async accountAs(session: string, method: "GET" | "POST", path: string, body?: unknown): Promise<Record<string, unknown>> {
    if (!ACCOUNT_PATH.test(path)) throw new Error("account_path_invalid");
    const r = await this.call(method, path, method === "GET" ? undefined : (body ?? {}), session);
    if (!r.ok) throw Object.assign(new Error(r.error), { code: r.error, cpMessage: r.message ?? null, status: r.status ?? null, retryAfter: r.retry_after_s ?? null });
    return r.json;
  }

  /**
   * 第 68 批（D-294）：不带设备签名、不带会话头的账号接口调用——用于旧云端（/v1/meta 没有 account_switch）上的登录：
   * 旧云端见到本机设备签名而账号是别人时整个登录被拒（device_mismatch），换账号只能不签名登录、由本机按档案判断。
   */
  async accountUnsigned(method: "POST", path: string, body: unknown, session: string | null = null): Promise<Record<string, unknown>> {
    if (!ACCOUNT_PATH.test(path)) throw new Error("account_path_invalid");
    const raw = JSON.stringify(body ?? {});
    // 第 68 批：换账号时（电脑数已满就地移除一台）带的是那个账号刚登录的会话，不是本档案的会话，也不带本档案的设备签名
    const r = await this.d.relay({ method, path, headers: session ? { "x-kwl-session": session } : {}, body: raw });
    if (!r.ok) throw Object.assign(new Error(r.reason), { code: r.reason, cpMessage: null, status: null, retryAfter: null });
    let json: Record<string, unknown> = {};
    try {
      json = r.body ? (JSON.parse(r.body) as Record<string, unknown>) : {};
    } catch {
      throw Object.assign(new Error("cp_reply_not_json"), { code: "cp_reply_not_json", cpMessage: null, status: r.status, retryAfter: null });
    }
    if (r.status >= 400) {
      const e = (json.error ?? {}) as { code?: string; message?: unknown; retry_after_s?: unknown; min_version?: unknown };
      const code = e.code ?? `http_${r.status}`;
      if (code === "client_outdated") this.outdated = { min_version: typeof e.min_version === "string" && e.min_version.length <= 40 ? e.min_version : null, at: this.d.now?.() ?? Date.now() };
      const ra = e.retry_after_s;
      throw Object.assign(new Error(code), { code, cpMessage: typeof e.message === "string" ? e.message.slice(0, 200) : null, status: r.status, retryAfter: Number.isSafeInteger(ra) && (ra as number) > 0 && (ra as number) <= 86_400 ? ra : null, ...(code === "client_outdated" ? { minVersion: this.outdated?.min_version ?? null } : {}) });
    }
    return json;
  }

  /** 第 63 批：云端版本与注册 / 登录策略（GET /v1/meta，无鉴权、不带个人信息）；取不到返回 null（界面按旧流程）。 */
  /** 公开的能力与注册策略（GET /v1/meta）。第 64 批：失败时带上原因代码（取不到与“旧云端”要分开说）。 */
  async meta(): Promise<{ ok: true; json: Record<string, unknown> } | { ok: false; code: string; status?: number }> {
    const r = await this.call("GET", "/v1/meta");
    return r.ok ? { ok: true, json: r.json } : { ok: false, code: r.error, ...(r.status ? { status: r.status } : {}) };
  }

  // ─── 中软侧操作记录（第 9 批 S14） ───

  /**
   * 取回本机还没有的运营审计流水：验控制面签名、验哈希链、与本机见过的最高序号对照（同一序号 hash 不同 = 云端改写了历史，告警且不覆盖）；
   * 通过的记录留存在本机（云端之后删改，本机仍有原记录）。返回本次新增条数与云端当前最高序号。
   */
  async fetchAudit(): Promise<{ added: number; head: number; withheld: boolean }> {
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
        const withheld = body.head.seq > head;
        if (withheld) {
          this.d.gov.alert("cp_audit", "cp_audit_withheld", String(body.head.seq), `中软侧操作记录最高序号为 ${body.head.seq}，只给出到 ${head}`);
        } else {
          // 留存最后一页的控制面签名信封（复核 S9A-12：导出时附上，收件人可用控制面公钥核对“截至云端序号 N”）
          this.d.gov.saveSignedAuditPage(r.json);
        }
        return { added, head: body.head.seq, withheld };
      }
    }
    return { added, head, withheld: false };
  }

  async publishDraft(draftId: string): Promise<{ ok: true }> {
    if (!/^drf_[0-9a-f]{16}$/.test(draftId)) throw new Error("draft_id 不合法");
    const r = await this.call("POST", `/v1/drafts/${draftId}/publish`, {});
    if (!r.ok) throw new Error(r.error);
    return { ok: true };
  }
}

/**
 * 第 72 批（A1 H2）：首次同步算不算“成了”——这台电脑登记上了（register ok）且席位令牌已取得或仍有效（AI 可用）；
 * 因许可到期、设备吊销等退出模式而跳过的，重试也不会好，也算结束。纯函数。
 */
export function firstSyncDone(rep: SyncReport): boolean {
  if (rep.steps.register !== "ok") return false;
  const seat = rep.steps.seat ?? "";
  return seat === "accepted" || seat === "unchanged" || seat === "valid" || (seat.startsWith("skipped:") && seat !== "skipped:license_missing");
}

/** 日志用：席位这一步的结果归到封闭枚举。纯函数。 */
function seatOutcomeOf(v: string | undefined): "accepted" | "unchanged" | "valid" | "skipped" | "rejected" | "error" | "none" {
  if (!v) return "none";
  if (v === "accepted" || v === "unchanged" || v === "valid") return v;
  if (v.startsWith("skipped:")) return "skipped";
  if (v.startsWith("rejected:")) return "rejected";
  return "error";
}
