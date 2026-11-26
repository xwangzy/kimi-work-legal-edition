/**
 * 开通与成员入组（第 13 批；设计 docs/design/开通与成员入组设计-v1.md）的律所侧。
 *
 * 待激活模式（KernelConfig.onboarding）：
 * - `onboarding.redeem`：开通码 / 邀请码经闸门的控制面通道兑换 → 创始：认领凭据封装暂存进目标工作区 keys/、写 activation.json、
 *   请主进程按新身份重启内核；成员：本机生成设备密钥、提交入组申请（只含公钥 + 持有证明）、暂存、写 onboarding.json，等管理员批准。
 * - `onboarding.check`：成员取回申请结果；批准 → 核验证书与律所公钥包后暂存 join-approved.json、写 activation.json、请求重启。
 *   内核在待批准期间每 15 秒自动取一次。
 * 正常模式（管理员设备）：`members.*` 发邀请、列待批准申请（核对码由本机独立计算）、批准（用本机律所根签发证书 + 律所公钥包）或拒绝。
 *
 * 秘密（认领凭据、设备私钥、取回的证书）只进按数据库主密钥封装的 keys/ 文件；activation.json / onboarding.json 只有编号、显示名与状态。
 */
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { issueDeviceCertificate, SoftwareSigner, verifyBytes, verifyDeviceCertificate, type DeviceCertificate, type DeviceKeys, type DeviceRole } from "@zr-legal/keys";
import {
  deviceEnrollProofBytes,
  firmBundleBytes,
  firmCheckCode,
  openEnvelope,
  parsePublicKeyMap,
  verifyDeviceCertificateAny,
  formatActivationCode,
  joinCheckCode,
  joinProofBytes,
  MEMBER_SLUG_PATTERN,
  approvalMacBytes,
  expectedJoinDeviceId,
  inviteMac,
  inviteMacValid,
  joinMacBytes,
  newInviteSecret,
  splitInvitationInput,
  validDisplayName,
  type FirmBundle,
} from "@zr-legal/firm-trust";
import { DomainError } from "@zr-legal/domain";
import { slog } from "@zr-legal/safe-log";
import { activationFilePath, PENDING_WORKSPACE_SLUG, type ActivationFile, type KernelConfig } from "../config.ts";
import { configureSecretSealing, generateJoinDeviceKeys, getFirmRootPrivateKey, keysDirOf, readSecretFile, writeStagedSecret, type FirmIdentityRow } from "../devices.ts";
import type { KernelDb } from "../db.ts";
import type { Identity } from "../identity.ts";
import { accountErrorText, accountFailure, dropLoginRequired, onboardingStateText, writeAccountSession } from "../account-session.ts";
import { cloudFailureText } from "./cloud-connection.ts";
import { allocateWorkspace, findProfile, PROFILE_FILE, workspaceNameOf, writeProfile, type ProfileHandoff } from "../profiles.ts";

type CpRelay = (req: { method: string; path: string; headers: Record<string, string>; body: string }) => Promise<{ ok: true; status: number; body: string } | { ok: false; reason: string }>;
type SignedCall = (method: string, path: string, body?: unknown) => Promise<{ ok: true; status: number; json: Record<string, unknown> } | { ok: false; error: string; status?: number }>;

type Role = ActivationFile["role"];
const ROLES: readonly Role[] = ["admin", "partner", "lawyer", "assistant"];
/** 证书角色 → 本机成员角色（memberships.role）。 */
const MEMBERSHIP_ROLE: Record<Role, string> = { admin: "firm_admin", partner: "partner", lawyer: "lawyer", assistant: "paralegal" };
const ROLE_OF_MEMBERSHIP: Record<string, Role> = { firm_admin: "admin", partner: "partner", lawyer: "lawyer", paralegal: "assistant" };

/** 成员机等待批准期间的状态（<数据根>/onboarding.json；无秘密）。 */
interface OnboardingFile {
  v: 1;
  stage: "member_pending";
  tid: string;
  firm_slug: string;
  firm_name: string;
  member_slug: string;
  member_name: string | null;
  role: Role;
  activation_id: string;
  join_request_id: string;
  device_id: string;
  check_code: string;
  created_at: string;
  /** 第 44 批：账号登录后的新设备入组（没有邀请码本机段，批准方人工核对核对码）。 */
  via_account?: boolean;
  /** 第 68 批（D-294）：暂存所在的工作区目录名（没有 = 律所标识）。 */
  workspace?: string;
}

/** 成员机暂存（keys/join-pending.json，封装）。 */
interface JoinPending {
  tid: string;
  activation_id: string;
  claim_secret: string;
  /** 申请提交前即写下（复核 A-09：提交成功后再回填编号）。 */
  join_request_id: string | null;
  keys: DeviceKeys;
  /** 邀请码的本机秘密段（复核 A-01/03：对申请做 HMAC、核对管理员对批准结果的 HMAC）；账号新设备入组（第 44 批 D-186）没有，为 null。 */
  invite_secret: string | null;
}

const ONBOARDING_FILE = "onboarding.json";

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | null {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null;
  } catch {
    return null;
  }
}

/** 控制面应答里的错误代码 → 律师看得懂的一句话（不区分码错与过期，防枚举）。 */
function cpErrorText(code: string): string {
  // 第 52 批（IP 部署）：激活时控制面通道的证书校验与安装包连接配置单独说（原来一律并成“连不上中软服务”）
  const cloud = cloudFailureText(code);
  if (cloud) return cloud;
  switch (code) {
    case "code_invalid":
      return "开通码不正确或已失效，请向发码人重新获取";
    case "rate_limited":
      return "尝试过于频繁，请一分钟后再试";
    case "license_expired":
      return "律所订阅已到期，请联系中软开通";
    case "claim_invalid":
      return "这次激活已失效，请重新输入开通码或邀请码";
    case "join_attempts_exceeded":
      return "申请次数已用完，请向管理员重新获取邀请码";
    case "device_exists":
      return "这台电脑对应的成员已在律所登记过；如需更换电脑，请管理员先移除旧设备";
    case "cp_not_configured":
    case "gate_unavailable":
    case "cp_unreachable":
      return "连不上中软服务，请检查网络后重试";
    default:
      return "激活没有完成，请稍后重试；仍不行请联系客服";
  }
}

async function cpPost(
  relay: CpRelay,
  path: string,
  body: unknown,
  method: "POST" | "GET" = "POST",
  headers: Record<string, string> = {},
): Promise<{ ok: true; json: Record<string, any> } | { ok: false; code: string; message?: string; min_version?: string; retry_after_s?: number; hold?: { reason: string; sms_available: boolean; phone_masked: string | null }; devices?: unknown[]; device_limit?: number }> {
  const r = await relay({ method, path, headers, body: method === "GET" ? "" : JSON.stringify(body) });
  // 证书类、安装包配置类的代码原样保留（cp_tls_*、cp_upstream_*），其余通道错误并成 cp_unreachable
  if (!r.ok) return { ok: false, code: r.reason.startsWith("cp_") && !cloudFailureText(r.reason) ? "cp_unreachable" : r.reason };
  let json: Record<string, any> = {};
  try {
    json = r.body ? JSON.parse(r.body) : {};
  } catch {
    return { ok: false, code: "cp_reply_not_json" };
  }
  // 控制面的错误说明（中文、可直接显示；只用于账号接口里密码规则、锁定剩余时间这类需要原话的提示）
  if (r.status >= 400)
    return {
      ok: false,
      code: String(json?.error?.code ?? `http_${r.status}`),
      ...(typeof json?.error?.message === "string" && json.error.message.length <= 200 ? { message: json.error.message } : {}),
      // 第 46 批：客户端版本过旧（426）时控制面给出最低版本号
      ...(typeof json?.error?.min_version === "string" && json.error.min_version.length <= 40 ? { min_version: json.error.min_version } : {}),
      // 第 62 批：验证码重发还要等几秒
      ...(Number.isSafeInteger(json?.error?.retry_after_s) && json.error.retry_after_s > 0 && json.error.retry_after_s <= 86_400 ? { retry_after_s: json.error.retry_after_s } : {}),
      // 第 66 批（V40，D-292）：新电脑自动登记被风控暂停时的原因与能否用短信确认
      ...(json?.error?.code === "device_enroll_hold"
        ? { hold: { reason: String(json.error.reason ?? ""), sms_available: json.error.sms_available === true, phone_masked: typeof json.error.phone_masked === "string" && json.error.phone_masked.length <= 20 ? json.error.phone_masked : null } }
        : {}),
      // 第 68 批（V42，D-295）：登记新电脑时电脑数已满，云端给出已登记的电脑
      ...(json?.error?.code === "device_limit" && Array.isArray(json.error.devices) ? { devices: (json.error.devices as unknown[]).slice(0, 20) } : {}),
      ...(json?.error?.code === "device_limit" && Number.isSafeInteger(json.error.device_limit) && json.error.device_limit > 0 && json.error.device_limit <= 99 ? { device_limit: json.error.device_limit as number } : {}),
    };
  return { ok: true, json };
}

export interface OnboardingDeps {
  config: KernelConfig;
  relay: CpRelay;
  /** 请主进程按新身份重启内核（广播 kernel.restart_for_identity）。 */
  requestRestart: () => void;
  /**
   * 第 68 批（D-294）：切换到这台电脑上另一个账号档案（或为新账号登记设备）——把一次性交接交给主进程，主进程换用那个档案的密钥后重启内核。
   * 没有给（旧的开发桥、测试）时退化为 requestRestart（交接丢失：律师在打开的档案里再登录一次）。
   */
  requestSwitch?: (h: ProfileHandoff) => void;
}

/** 待激活模式下的开通服务。 */
export class OnboardingService {
  private readonly d: OnboardingDeps;
  private timer: NodeJS.Timeout | null = null;
  private checking: Promise<unknown> | null = null;
  private restarting = false;
  private busy = false;

  constructor(d: OnboardingDeps) {
    this.d = d;
  }

  private get root(): string {
    return this.d.config.dataRoot;
  }

  private pending(): OnboardingFile | null {
    const f = readJson<OnboardingFile>(join(this.root, ONBOARDING_FILE));
    // firm_slug 也按律所标识字符集校验（复核 A 第 1 节补充：它用来拼 keys 目录）
    const firmOk = typeof f?.firm_slug === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(f.firm_slug) && f.firm_slug !== PENDING_WORKSPACE_SLUG;
    const wsOk = f?.workspace === undefined || (typeof f.workspace === "string" && (f.workspace === f.firm_slug || f.workspace.startsWith(`${f.firm_slug}.`)) && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(f.workspace));
    return f && f.v === 1 && f.stage === "member_pending" && MEMBER_SLUG_PATTERN.test(f.member_slug) && firmOk && wsOk ? f : null;
  }

  /** 第 68 批：暂存与激活后的工作区按目录名（同一律所的另一位成员不与已有档案共用目录）。 */
  private keysDirFor(workspace: string): string {
    const dir = keysDirOf(join(this.root, workspace));
    configureSecretSealing(dir, this.d.config.dbKey);
    return dir;
  }

  /** 第 68 批：给这个账号分配（或沿用）本机工作区目录名。 */
  private workspaceFor(tid: string, firmSlug: string, memberSlug: string): string {
    return allocateWorkspace(this.root, tid, firmSlug, memberSlug);
  }

  /**
   * 第 68 批（D-294）：登录的账号在这台电脑上已有档案 → 不再登记新设备，切换到那个档案（会话随交接写进它自己的工作区）。
   * 返回给界面的答复；没有档案返回 null。
   */
  private switchToExisting(j: Record<string, any>): Record<string, unknown> | null {
    const acc = j.account ?? {};
    const tid = String(acc.tid ?? j.onboarding?.tid ?? "");
    const memberSlug = String(acc.member_slug ?? j.onboarding?.member?.slug ?? "");
    if (!tid || !memberSlug || typeof j.session_token !== "string") return null;
    const prof = findProfile(this.root, tid, memberSlug);
    if (!prof) return null;
    writeJsonAtomic(activationFilePath(this.root), prof);
    slog.event("KERNEL_PROFILE_SWITCH", { to: "existing" });
    const session = { token: j.session_token, aid: String(acc.aid ?? ""), email: String(acc.email ?? ""), name: String(acc.name ?? prof.member_name ?? ""), tid, role: String(acc.role ?? prof.role) };
    this.switchSoon({ v: 1, kind: "session", tid, member_slug: memberSlug, session });
    return { next: "switch", account: { email: session.email, name: session.name, role: session.role }, firm: { name: prof.firm_name } };
  }

  private switchSoon(h: ProfileHandoff): void {
    this.restarting = true;
    setTimeout(() => (this.d.requestSwitch ? this.d.requestSwitch(h) : this.d.requestRestart()), 300).unref();
  }

  /** 第 68 批：上一个档案里登录的新账号，交接过来继续登记这台电脑（结果留给激活页显示）。 */
  private handoffResult: Record<string, unknown> | null = null;
  async resumeHandoff(h: ProfileHandoff): Promise<void> {
    if (h.kind !== "auth") return;
    // 进行中：激活页据此显示“正在登记这台电脑…”并等结果（登记成功会直接按新身份重启）
    this.handoffResult = { next: "working" };
    let done: (() => void) | null = null;
    try {
      // 安全复核 P-4：与登录、注册、就地移除互斥（各自写激活记录）
      done = this.exclusive();
      this.handoffResult = await this.afterAuth(h.auth as Record<string, any>, null);
    } catch (e) {
      this.handoffResult = { next: "error", message: (e as Error).message || "没有完成，请重新登录" };
    } finally {
      if (done && !this.restarting) done();
    }
  }

  /**
   * 第 68 批（安全复核 C-1）：登录应答里没有入组认领 / 预分配编号（云端见到的是这台电脑上别的账号的设备签名，先不签发认领，
   * 免得撤掉这个账号在别的新电脑上等批准的申请）——真要为它登记这台电脑时，用这次会话向云端取一次。
   */
  private async withClaim(j: Record<string, any>): Promise<Record<string, any>> {
    const onb = j.onboarding ?? {};
    const state = String(onb.state ?? "");
    const missing = (state === "needs_device_join" || state === "needs_founder_setup") ? !onb.claim : state === "needs_device_auto" ? !onb.device_id : false;
    if (!missing || typeof j.session_token !== "string") return j;
    const o = await cpPost(this.d.relay, "/v1/auth/onboarding", {}, "POST", { "x-kwl-session": j.session_token });
    if (!o.ok) {
      const f = accountFailure(o.code, o.message ?? null);
      throw new DomainError(f.fault, f.text, f.status, { reason: f.reason });
    }
    return { ...j, onboarding: o.json.onboarding ?? onb, account: o.json.account ?? j.account };
  }

  /** 待批准时定时取结果（每 15 秒；不阻止进程退出）。 */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.pending() && !this.checking) void this.check().catch(() => {});
    }, 15_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): Record<string, unknown> {
    const p = this.pending();
    if (p) {
      return {
        mode: "member_pending",
        firm: { name: p.firm_name },
        member: { name: p.member_name, role: p.role },
        check_code: p.check_code,
        requested_at: p.created_at,
        ...(p.via_account ? { via_account: true } : {}),
      };
    }
    const failed = readJoinFailure(this.root);
    const setAside = this.setAside();
    const others = this.otherProfiles();
    return {
      mode: "unactivated",
      restarting: this.restarting,
      legacy_workspaces: this.legacyWorkspaces(),
      // 第 68 批：这台电脑上别的账号的工作空间（只给个数，不列姓名：共用电脑的人看不到彼此是谁）；登录那个账号即打开
      ...(others > 0 ? { other_profiles: others } : {}),
      ...(this.handoffResult ? { handoff: this.handoffResult } : {}),
      ...(failed ? { last_failure: failed } : {}),
      ...(setAside.length ? { set_aside: setAside } : {}),
    };
  }

  /**
   * 主进程因主密钥解封失败而移到一边的目录（`<数据根>/.unreadable-<时刻>/`，v9.3 主文 §9 第 7 项）：只报目录名、新的在前；
   * 激活页据此直接打开“从备份恢复”，并告诉律师原来的数据在哪、没有删除。
   */
  private setAside(): string[] {
    try {
      return readdirSync(this.root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^\.unreadable-[0-9TZ-]{1,40}$/.test(e.name))
        .map((e) => e.name)
        .sort()
        .reverse()
        .slice(0, 5);
    } catch {
      return [];
    }
  }

  /**
   * 本机已有的旧工作区（复核 B13-K06）：第 13 批之前的安装包以 demo-firm 等身份运行，升级后进入待激活，旧工作区不会自动迁移、界面也不再可见——
   * 只报目录名（律所标识），由所内 IT 决定导出或清理；占位工作区不算。
   */
  private legacyWorkspaces(): string[] {
    try {
      return readdirSync(this.root, { withFileTypes: true })
        // 第 68 批：带档案记录的是这台电脑上别的账号的工作空间（各有密钥，恢复与开通都不会动它们），不算“以前留下的数据”
        .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== PENDING_WORKSPACE_SLUG && existsSync(join(this.root, e.name, "ledger.db")) && !existsSync(join(this.root, e.name, PROFILE_FILE)))
        .map((e) => e.name)
        .slice(0, 10);
    } catch {
      return [];
    }
  }

  /** 第 68 批：这台电脑上别的账号档案的个数。 */
  private otherProfiles(): number {
    try {
      return readdirSync(this.root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== PENDING_WORKSPACE_SLUG && existsSync(join(this.root, e.name, PROFILE_FILE))).length;
    } catch {
      return 0;
    }
  }

  /**
   * 写激活记录（= 当前档案指针）并在工作区里留一份档案记录。第 68 批：工作区目录名与律所标识不同时写 workspace；
   * 本次待激活用的是另起的那把密钥（keySlot = pending）时写 key_slot，主进程据此把那把密钥归到这个档案名下。
   */
  private writeActivation(a: Omit<ActivationFile, "v" | "activated_at" | "workspace" | "key_slot">, workspace: string): void {
    const rec: ActivationFile = {
      v: 1,
      ...a,
      ...(workspace !== a.firm_slug ? { workspace } : {}),
      ...(this.d.config.keySlot === "pending" ? { key_slot: workspace } : {}),
      activated_at: new Date().toISOString(),
    };
    writeProfile(this.root, rec);
    writeJsonAtomic(activationFilePath(this.root), rec);
  }

  private restartSoon(): void {
    this.restarting = true;
    // 先让本次调用的应答回到界面，再请主进程重启
    setTimeout(() => this.d.requestRestart(), 300).unref();
  }

  /**
   * 兑换、入组生效与从备份恢复互斥（复核 R2A-07）：进行中或已请求重启时，另一次一律 409——
   * 否则两次快速的恢复会交错写激活记录与主密钥。返回“结束”函数（失败时调用以释放）。
   */
  exclusive(): () => void {
    if (this.restarting || this.busy) throw new DomainError("conflict", "上一步还在进行（或正在重启）：请稍候再试", 409);
    this.busy = true;
    return () => {
      this.busy = false;
    };
  }

  /** 已请求主进程重启（恢复完成后由调用方标记）。 */
  markRestarting(): void {
    this.restarting = true;
  }

  async redeem(p: { code?: unknown }): Promise<Record<string, unknown>> {
    if (this.restarting) throw new DomainError("conflict", "正在完成激活，请稍候", 409);
    if (this.pending()) throw new DomainError("conflict", "这台电脑正在等待管理员批准；如要改用别的邀请码，请先点“重新输入”", 409);
    const input = splitInvitationInput(p.code);
    if (!input) throw new DomainError("validation", "开通码是 20 位、邀请码是 36 位字母与数字（可带连字符），请核对后重新输入", 400);
    rmSync(join(this.root, JOIN_FAILED_FILE), { force: true });
    const r = await cpPost(this.d.relay, "/v1/activation/redeem", { code: input.code });
    if (!r.ok) {
      slog.event("KERNEL_ONBOARDING_REDEEM_FAILED", {});
      throw new DomainError(r.code === "code_invalid" ? "validation" : r.code === "rate_limited" ? "rate_limited" : "provider_unavailable", cpErrorText(r.code), r.code === "code_invalid" ? 400 : r.code === "rate_limited" ? 429 : 502, { reason: r.code });
    }
    const j = r.json;
    const firmSlug = String(j.firm?.slug ?? "");
    const memberSlug = String(j.member?.slug ?? "");
    const role = String(j.member?.role ?? "") as Role;
    const ok =
      j.ok === true &&
      (j.kind === "founder" || j.kind === "member") &&
      /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(firmSlug) &&
      firmSlug !== PENDING_WORKSPACE_SLUG &&
      j.tid === `ten_${firmSlug}` &&
      MEMBER_SLUG_PATTERN.test(memberSlug) &&
      ROLES.includes(role) &&
      (j.kind !== "founder" || role === "admin") &&
      typeof j.activation_id === "string" &&
      typeof j.claim_secret === "string" &&
      j.claim_secret.length >= 32;
    if (!ok) throw new DomainError("provider_unavailable", cpErrorText("reply_invalid"), 502);
    const firmName = validDisplayName(j.firm?.name) ? String(j.firm.name) : firmSlug;
    const memberName = validDisplayName(j.member?.name) ? String(j.member.name) : null;
    const ws = this.workspaceFor(j.tid, firmSlug, memberSlug);
    const keysDir = this.keysDirFor(ws);

    if (j.kind === "founder") {
      writeStagedSecret(join(keysDir, "activation-claim.json"), { tid: j.tid, activation_id: j.activation_id, claim_secret: j.claim_secret });
      this.writeActivation({ tid: j.tid, firm_slug: firmSlug, firm_name: firmName, member_slug: memberSlug, member_name: memberName, role, kind: "founder" }, ws);
      slog.event("KERNEL_ONBOARDING_ACTIVATED", {});
      this.restartSoon();
      return { kind: "founder", next: "restart", firm: { name: firmName }, member: { name: memberName, role } };
    }

    // 成员：邀请码必须带本机秘密段（复核 A-01）
    if (!input.secret) throw new DomainError("validation", "邀请码不完整：应为 36 位（管理员页面上完整的那一串），请向管理员核对", 400);
    return this.submitJoin({ tid: j.tid, activation_id: j.activation_id, claim_secret: j.claim_secret, firmSlug, firmName, memberSlug, memberName, role, workspace: ws }, input.secret, expectedJoinDeviceId(firmSlug, memberSlug));
  }

  /**
   * 提交入组申请（邀请码入组与第 44 批账号新设备入组共用）：本机生成设备密钥，先暂存再提交（复核 A-09）——只含公钥、持有证明；
   * 有邀请码本机段时另带 HMAC（复核 A-01）。账号新设备没有本机段（D-186）：批准方按核对码人工核对。
   */
  private async submitJoin(c: { tid: string; activation_id: string; claim_secret: string; firmSlug: string; firmName: string; memberSlug: string; memberName: string | null; role: Role; workspace: string }, secret: string | null, deviceId: string): Promise<Record<string, unknown>> {
    const { tid, firmSlug, firmName, memberSlug, memberName, role } = c;
    const keysDir = this.keysDirFor(c.workspace);
    const { keys, signer } = generateJoinDeviceKeys();
    const proof = signer.signSync(joinProofBytes({ tid, activationId: c.activation_id, deviceId, signPublicKeyPem: keys.signPublicKeyPem, encPublicKeyPem: keys.encPublicKeyPem }));
    // 律所名称与本人姓名按兑换时看到的进 HMAC（复核 A-03 余项）：控制面换掉名称，管理员机按本机邀请记录核对即不通过
    const mac = secret
      ? inviteMac(secret, joinMacBytes({ tid, activationId: c.activation_id, deviceId, signPublicKeyPem: keys.signPublicKeyPem, encPublicKeyPem: keys.encPublicKeyPem, memberSlug, role, firmName, memberName }))
      : null;
    const pendingPath = join(keysDir, "join-pending.json");
    const staged: JoinPending = { tid, activation_id: c.activation_id, claim_secret: c.claim_secret, join_request_id: null, keys, invite_secret: secret };
    writeStagedSecret(pendingPath, staged);
    const jr = await cpPost(this.d.relay, "/v1/join-requests", {
      tid,
      activation_id: c.activation_id,
      claim_secret: c.claim_secret,
      device_id: deviceId,
      sign_pub: keys.signPublicKeyPem,
      enc_pub: keys.encPublicKeyPem,
      proof,
      ...(mac ? { mac } : {}),
    });
    if (!jr.ok || typeof jr.json.join_request_id !== "string") {
      rmSync(pendingPath, { force: true });
      throw new DomainError("provider_unavailable", jr.ok ? cpErrorText("reply_invalid") : jr.code === "device_limit" ? accountErrorText("device_limit") : cpErrorText(jr.code), 502, { reason: jr.ok ? "reply_invalid" : jr.code });
    }
    writeStagedSecret(pendingPath, { ...staged, join_request_id: jr.json.join_request_id });
    const checkCode = joinCheckCode({ tid, deviceId, signPublicKeyPem: keys.signPublicKeyPem, encPublicKeyPem: keys.encPublicKeyPem });
    const file: OnboardingFile = {
      v: 1,
      stage: "member_pending",
      tid,
      firm_slug: firmSlug,
      firm_name: firmName,
      member_slug: memberSlug,
      member_name: memberName,
      role,
      activation_id: c.activation_id,
      join_request_id: jr.json.join_request_id,
      device_id: deviceId,
      check_code: checkCode,
      created_at: new Date().toISOString(),
      ...(secret ? {} : { via_account: true }),
      ...(c.workspace !== firmSlug ? { workspace: c.workspace } : {}),
    };
    writeJsonAtomic(join(this.root, ONBOARDING_FILE), file);
    slog.event("KERNEL_ONBOARDING_JOIN_REQUESTED", {});
    this.start();
    return { kind: "member", next: "wait", firm: { name: firmName }, member: { name: memberName, role }, check_code: checkCode, ...(secret ? {} : { via_account: true }) };
  }

  // ─── 第 44 批：账号注册与登录（待激活模式；之后的登录、退出、改密在正常模式的 account.* 里） ───

  /**
   * 处理控制面的 AuthResult：会话令牌暂存进目标工作区 keys/（封装），再按 onboarding 状态走创始开通或入组申请。
   * code = 注册时输入的邀请码（成员凭邀请码入组时要用它的本机段做 HMAC）。
   */
  private async afterAuth(j: Record<string, any>, inviteSecret: string | null): Promise<Record<string, unknown>> {
    // 第 68 批（D-294）：这台电脑上已有这个账号的档案 → 直接打开它（不重复登记设备、不新建工作区）
    const existing = this.switchToExisting(j);
    if (existing) return existing;
    j = await this.withClaim(j);
    const onb = j.onboarding ?? {};
    const acc = j.account ?? {};
    const firmSlug = String(onb.firm?.slug ?? acc.org?.slug ?? "");
    const firmOk = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(firmSlug) && firmSlug !== PENDING_WORKSPACE_SLUG && String(onb.tid ?? acc.tid) === `ten_${firmSlug}`;
    if (!firmOk || typeof j.session_token !== "string") throw new DomainError("provider_unavailable", cpErrorText("reply_invalid"), 502);
    const firmName = validDisplayName(onb.firm?.name) ? String(onb.firm.name) : firmSlug;
    const memberSlug = String(onb.member?.slug ?? acc.member_slug ?? "");
    const memberName = validDisplayName(onb.member?.name) ? String(onb.member.name) : validDisplayName(acc.name) ? String(acc.name) : null;
    const role = String(onb.member?.role ?? acc.role ?? "") as Role;
    if (!MEMBER_SLUG_PATTERN.test(memberSlug) || !ROLES.includes(role)) throw new DomainError("provider_unavailable", cpErrorText("reply_invalid"), 502);
    const account = { aid: String(acc.aid ?? ""), email: String(acc.email ?? ""), name: memberName ?? "", tid: `ten_${firmSlug}`, role };
    const state = String(onb.state ?? "");
    const ws = this.workspaceFor(account.tid, firmSlug, memberSlug);
    const keysDir = this.keysDirFor(ws);
    // 会话令牌：能在这台电脑上继续时才暂存（入组等待期间也算已登录；重启后按新身份读回）；不能继续的不留会话文件
    const proceed = state === "needs_founder_setup" || state === "needs_device_join" || state === "needs_device_auto";
    if (proceed) {
      writeAccountSession(keysDir, { token: j.session_token, ...account });
      // 第 64 批：同一工作区留有“要重新登录”的旧记录时一并删掉（开通 / 入组之后按新会话打开）
      try {
        dropLoginRequired(keysDir);
      } catch {
        // 启动时会话比记录新，记录也会作废
      }
    }
    const view = { account: { email: account.email, name: account.name, role }, firm: { name: firmName }, state };
    if (state === "needs_founder_setup") {
      const c = onb.claim ?? {};
      if (c.kind !== "founder" || role !== "admin" || typeof c.activation_id !== "string" || typeof c.claim_secret !== "string" || c.claim_secret.length < 32) throw new DomainError("provider_unavailable", cpErrorText("reply_invalid"), 502);
      writeStagedSecret(join(keysDir, "activation-claim.json"), { tid: account.tid, activation_id: c.activation_id, claim_secret: c.claim_secret });
      this.writeActivation({ tid: account.tid, firm_slug: firmSlug, firm_name: firmName, member_slug: memberSlug, member_name: memberName, role, kind: "founder" }, ws);
      slog.event("KERNEL_ONBOARDING_ACTIVATED", {});
      this.restartSoon();
      return { ...view, kind: "founder", next: "restart" };
    }
    if (state === "needs_device_join") {
      const c = onb.claim ?? {};
      const deviceId = String(onb.device_id ?? "");
      const viaInvite = onb.via === "invite_code";
      if (c.kind !== "member" || typeof c.activation_id !== "string" || typeof c.claim_secret !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(deviceId) || !deviceId.startsWith(`dev_${firmSlug}_${memberSlug}`)) throw new DomainError("provider_unavailable", cpErrorText("reply_invalid"), 502);
      if (viaInvite && !inviteSecret) throw new DomainError("validation", "邀请码不完整：应为 36 位（管理员页面上完整的那一串），请向管理员核对", 400);
      const r = await this.submitJoin({ tid: account.tid, activation_id: c.activation_id, claim_secret: c.claim_secret, firmSlug, firmName, memberSlug, memberName, role, workspace: ws }, viaInvite ? inviteSecret : null, deviceId);
      return { ...view, ...r };
    }
    // 第 66 批（V40，D-292）：个人账号的新电脑——云端用账号设备签发钥直接签发设备证书，不等另一台电脑批准（复用“暂存批准结果 → 重启”）
    if (state === "needs_device_auto") {
      const deviceId = String(onb.device_id ?? "");
      const sid = String(j.session?.sid ?? "");
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(deviceId) || !deviceId.startsWith(`dev_${firmSlug}_${memberSlug}`) || !/^ses_[A-Za-z0-9_-]{16}$/.test(sid) || !/^acc_[A-Za-z0-9_-]{1,64}$/.test(account.aid))
        throw new DomainError("provider_unavailable", cpErrorText("reply_invalid"), 502);
      this.autoPending = { tid: account.tid, aid: account.aid, sid, token: j.session_token, deviceId, firmSlug, firmName, memberSlug, memberName, role, gen: null, workspace: ws };
      return { ...view, ...(await this.autoEnroll(null)) };
    }
    // 不能在这台电脑上继续的状态：如实告诉律师（处理好后再登录即可）。文案与正常模式的 account.login 同一份（account-session.ts，第 46 批）；
    // ready（控制面认得这台电脑是该成员的设备，但本机没有对应工作区，例如重装后）也说清怎么办，不再落到“请联系客服”
    // 第 68 批（V42，D-295）：电脑数已满——记下这次登录的会话（只在内存、10 分钟内有效），律师可在这一页就地移除一台再继续，不必再收一次验证码
    let canUnbind = false;
    if (state === "device_limit" && typeof j.session_token === "string" && Array.isArray(onb.devices) && onb.devices.length > 0) {
      this.limitSession = { token: j.session_token, at: Date.now() };
      canUnbind = (await this.registrationMeta().catch(() => null))?.device_unbind_on_login === true;
    }
    // 第 69 批（D-297）：带上云端设定的电脑数上限（界面写“最多同时在 N 台电脑上使用”；客户端不另设上限）
    const limitN = Number.isSafeInteger(onb.device_limit) && (onb.device_limit as number) > 0 && (onb.device_limit as number) <= 99 ? (onb.device_limit as number) : null;
    return { ...view, next: "blocked", reason: state, message: onboardingStateText(state, { admin: role === "admin" }), devices: Array.isArray(onb.devices) ? onb.devices : [], ...(limitN ? { device_limit: limitN } : {}), ...(canUnbind ? { can_unbind: true } : {}) };
  }

  /** 第 68 批：电脑数已满时这次登录的会话（只在内存里；就地移除一台后用它继续登记这台电脑）。 */
  private limitSession: { token: string; at: number } | null = null;

  /**
   * 第 68 批（V42，D-295）：电脑数已满时，就地移除这个账号的一台旧电脑（云端核对：这次登录 10 分钟内、会话还没绑任何电脑），
   * 再按同一会话重取“这台电脑该做什么”继续登记——不用再输一次密码或再收一次验证码。
   */
  async unbindForLogin(p: { device_id?: unknown }): Promise<Record<string, unknown>> {
    const done = this.exclusive();
    try {
      return await this.unbindForLoginInner(p);
    } finally {
      if (!this.restarting) done();
    }
  }

  private async unbindForLoginInner(p: { device_id?: unknown }): Promise<Record<string, unknown>> {
    const ls = this.limitSession;
    if (!ls || Date.now() - ls.at > 9 * 60_000) throw new DomainError("conflict", "这次登录已超过 10 分钟：请重新登录后再移除", 409);
    const dev = String(p.device_id ?? "");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(dev)) throw new DomainError("validation", "设备编号不合法", 400);
    const r = await cpPost(this.d.relay, `/v1/auth/devices/${dev}/unbind`, {}, "POST", { "x-kwl-session": ls.token });
    if (!r.ok) {
      const f = accountFailure(r.code, r.message ?? null);
      throw new DomainError(f.fault, r.code === "auth_invalid" ? "云端暂不支持在这里移除电脑：请在那台电脑上（设置 → 账号）或云端控制台“我的电脑”里移除" : f.text, f.status, { reason: f.reason });
    }
    const o = await cpPost(this.d.relay, "/v1/auth/onboarding", {}, "POST", { "x-kwl-session": ls.token });
    if (!o.ok) {
      const f = accountFailure(o.code, o.message ?? null);
      throw new DomainError(f.fault, `已移除那台电脑；${f.text}`, f.status, { reason: f.reason, removed: true });
    }
    this.limitSession = null;
    return this.afterAuth({ ...o.json, session_token: ls.token }, null);
  }

  /** 第 66 批：正在自动登记的新电脑（登录应答里的会话与预分配编号；风控暂停后用短信验证码重试时沿用同一对设备密钥）。只在内存里。 */
  private autoPending: {
    tid: string;
    aid: string;
    sid: string;
    token: string;
    deviceId: string;
    firmSlug: string;
    firmName: string;
    memberSlug: string;
    memberName: string | null;
    role: Role;
    gen: ReturnType<typeof generateJoinDeviceKeys> | null;
    workspace: string;
  } | null = null;

  /**
   * 第 66 批（V40，D-292）：个人账号新电脑自动登记。本机生成设备密钥，用本次登录的会话 + 持有证明请云端签发；应答是控制面签名信封
   * （按内置的控制面公钥验），证书须由信封里的账号设备签发钥签、编号成员公钥都是本机的、律所公钥包须由律所根签名——任何一项不符都不采用。
   * 通过即暂存 join-approved.json、写激活记录、请求重启（与“另一台电脑批准”之后的路径相同）。风控暂停时返回 next = sms_confirm。
   */
  private async autoEnroll(sms: { phone: string; sms_code: string } | null): Promise<Record<string, unknown>> {
    const a = this.autoPending;
    if (!a) throw new DomainError("conflict", "请重新登录后再登记这台电脑", 409);
    a.gen ??= generateJoinDeviceKeys();
    const { keys, signer } = a.gen;
    const proof = signer.signSync(deviceEnrollProofBytes({ tid: a.tid, aid: a.aid, sid: a.sid, deviceId: a.deviceId, signPublicKeyPem: keys.signPublicKeyPem, encPublicKeyPem: keys.encPublicKeyPem }));
    const r = await cpPost(
      this.d.relay,
      "/v1/auth/devices/enroll",
      { device_id: a.deviceId, sign_pub: keys.signPublicKeyPem, enc_pub: keys.encPublicKeyPem, proof, client: this.clientInfo(), ...(sms ? { phone: sms.phone, sms_code: sms.sms_code } : {}) },
      "POST",
      { "x-kwl-session": a.token },
    );
    if (!r.ok) {
      slog.event("KERNEL_ONBOARDING_AUTO_ENROLL_FAILED", { reason: /^[a-z_]{1,40}$/.test(r.code) ? r.code : "other" });
      // 第 68 批（D-295）：登录之后、登记之前电脑数满了（另一台电脑抢先登记）——与登录时的“已满”同样处理，可就地移除一台
      if (r.code === "device_limit") {
        this.limitSession = { token: a.token, at: Date.now() };
        this.autoPending = null;
        const canUnbind = (await this.registrationMeta().catch(() => null))?.device_unbind_on_login === true;
        return { kind: "member", next: "blocked", reason: "device_limit", message: onboardingStateText("device_limit"), devices: r.devices ?? [], ...(r.device_limit ? { device_limit: r.device_limit } : {}), ...(canUnbind && (r.devices ?? []).length > 0 ? { can_unbind: true } : {}) };
      }
      if (r.hold)
        return {
          kind: "member",
          next: "sms_confirm",
          auto: true,
          hold_reason: r.hold.reason,
          sms_available: r.hold.sms_available,
          phone_masked: r.hold.phone_masked,
          message: r.hold.sms_available ? (r.message ?? onboardingStateText("device_enroll_hold")) : "短时间内有多台新电脑登录这个账号，为安全起见已暂停自动登记。账号没有绑定手机号（或短信暂不可用）：请先在已登录的电脑上移除不认识的电脑并修改密码，24 小时后再试，或联系客服",
        };
      const known = ["session_not_fresh", "device_auto_unavailable", "sms_phone_mismatch", "sms_code_invalid", "sms_code_expired", "sms_code_attempts"];
      throw new DomainError(r.code.startsWith("sms_") ? "validation" : "provider_unavailable", known.includes(r.code) ? (r.message ?? accountErrorText(r.code)) : cpErrorText(r.code), r.code.startsWith("sms_") ? 400 : 502, { reason: r.code });
    }
    const o = openEnvelope<{ tid: string; device_id: string; cert: DeviceCertificate; root_public_key_pem: string; firm_bundle: FirmBundle; ca: { kid: string; public_key_pem: string } }>(r.json, "kwl-device-enroll", parsePublicKeyMap(this.d.config.env.ZR_CONTROL_PLANE_KEYS));
    const b = o.ok ? o.body : null;
    const caPem = typeof b?.ca?.public_key_pem === "string" ? b.ca.public_key_pem : null;
    const rootPub = typeof b?.root_public_key_pem === "string" ? b.root_public_key_pem : "";
    const cert = b?.cert;
    const certOk =
      !!b &&
      !!cert &&
      b.tid === a.tid &&
      b.device_id === a.deviceId &&
      cert.issuer === "account_ca" &&
      verifyDeviceCertificateAny(cert, { root: rootPub, accountCa: caPem }).ok &&
      cert.deviceId === a.deviceId &&
      cert.memberId === `usr_${a.firmSlug}_${a.memberSlug}` &&
      cert.signPublicKeyPem === keys.signPublicKeyPem &&
      cert.encPublicKeyPem === keys.encPublicKeyPem;
    const fb = b?.firm_bundle;
    const fbOk = !!fb && !!rootPub && typeof fb.recovery_public_key_pem === "string" && typeof fb.sig === "string" && verifyBytes(rootPub, firmBundleBytes(a.tid, rootPub, fb.recovery_public_key_pem), fb.sig);
    if (!certOk || !fbOk || !caPem) {
      slog.event("KERNEL_ONBOARDING_CERT_REJECTED", {});
      throw new DomainError("provider_unavailable", "收到的登记结果核对不通过，没有采用。请重新登录；如反复出现请联系客服", 502);
    }
    const keysDir = this.keysDirFor(a.workspace);
    writeStagedSecret(join(keysDir, "join-approved.json"), { cert: cert!, root_public_key_pem: rootPub, recovery_public_key_pem: fb!.recovery_public_key_pem, keys, account_ca_public_key_pem: caPem });
    const role = (ROLES.includes(cert!.role as Role) ? cert!.role : a.role) as Role;
    this.writeActivation({ tid: a.tid, firm_slug: a.firmSlug, firm_name: a.firmName, member_slug: a.memberSlug, member_name: a.memberName, role, kind: "member", ...(a.deviceId !== expectedJoinDeviceId(a.firmSlug, a.memberSlug) ? { device_id: a.deviceId } : {}) }, a.workspace);
    this.autoPending = null;
    slog.event("KERNEL_ONBOARDING_AUTO_ENROLLED", {});
    this.restartSoon();
    return { kind: "member", next: "restart", auto: true, firm_check_code: firmCheckCode(a.tid, rootPub) };
  }

  /** 第 66 批：新电脑自动登记被风控暂停后，用账号绑定手机号收到的验证码（/v1/auth/sms/send purpose = login）确认是本人，再登记一次。 */
  async deviceConfirm(p: { phone?: unknown; sms_code?: unknown }): Promise<Record<string, unknown>> {
    const phone = typeof p.phone === "string" ? p.phone.replace(/\s+/g, "") : "";
    const code = typeof p.sms_code === "string" ? p.sms_code.replace(/\s+/g, "") : "";
    if (!/^1\d{10}$/.test(phone)) throw new DomainError("validation", "请填写账号绑定的 11 位手机号", 400);
    if (!/^\d{4,8}$/.test(code)) throw new DomainError("validation", "请填写短信验证码", 400);
    if (!this.autoPending) throw new DomainError("conflict", "这次登录已结束：请重新登录", 409);
    return this.autoEnroll({ phone, sms_code: code });
  }

  private async accountCall(path: string, body: unknown): Promise<Record<string, any>> {
    const r = await cpPost(this.d.relay, path, body);
    if (!r.ok) {
      slog.event("KERNEL_ACCOUNT_CALL_FAILED", { reason: /^[a-z_]{1,40}$/.test(r.code) ? r.code : "other" });
      // 第 46 批：与正常模式的 account.* 共用一处映射（状态码、文案；控制面原话只用于密码规则与锁定时长）
      const f = accountFailure(r.code, r.message ?? null, { min_version: r.min_version ?? null, retry_after_s: r.retry_after_s ?? null });
      throw new DomainError(f.fault, f.text, f.status, { reason: f.reason, ...(r.retry_after_s ? { retry_after_s: r.retry_after_s } : {}) });
    }
    return r.json;
  }

  /**
   * 注册策略（第 62 批；GET /v1/meta 的能力字段）：云端有 registration_policy 才按它显示手机号与邀请码；旧云端没有、取不到或格式不对，
   * 一律回 legacy（注册页照旧流程：不要求手机号，码可填可不填）。只回界面要用的几项，不透传云端原文。
   */
  async registrationMeta(): Promise<Record<string, unknown>> {
    // 第 64 批：同一时刻只发一个请求（开通页首屏与内核启动时的预取共用）；取到的结果记 20 秒（只为让开机预取与界面第一次调用共用一次结果；运营改了策略，重新打开登录页即生效），取不到不记（下次点“重试”重新取）
    const now = Date.now();
    if (this.metaCache && now - this.metaCache.at < 20_000) return this.metaCache.value;
    this.metaInflight ??= fetchRegistrationMeta(async () => {
      const r = await cpPost(this.d.relay, "/v1/meta", undefined, "GET");
      return r.ok ? { ok: true as const, json: r.json } : { ok: false as const, code: r.code };
    })
      .then((value) => {
        this.metaCache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        this.metaInflight = null;
      });
    return this.metaInflight;
  }
  private metaInflight: Promise<Record<string, unknown>> | null = null;
  private metaCache: { at: number; value: Record<string, unknown> } | null = null;

  /**
   * 第 64 批：内核一启动就预取注册 / 登录策略（顺带把出站闸门拉起来）——开通页首屏要用它决定显示哪几种登录方式；
   * 界面的第一次调用接上这个请求，不用从头等闸门拉起。失败不在这里报（界面调用时如实显示“取不到 · 重试”）。
   */
  prefetchRegistrationMeta(): void {
    void this.registrationMeta().catch(() => {});
  }

  /** 发短信验证码（第 62 批；register = 注册、reset = 找回密码；第 63 批 login = 验证码登录）。手机号只经闸门的控制面通道发给中软，本机不保存、不记日志。 */
  async smsSend(p: { phone?: unknown; purpose?: unknown }): Promise<Record<string, unknown>> {
    const purpose = p.purpose === "reset" || p.purpose === "login" ? p.purpose : "register";
    const phone = smsPhoneInput(p.phone);
    const j = await this.accountCall("/v1/auth/sms/send", { phone, purpose, client: this.clientInfo() });
    return smsSendResult(j);
  }

  /**
   * 注册（待激活模式）：自助开通个人律所，或凭开通码 / 邀请码。密码只经闸门的控制面通道发给中软（TLS 钉住），本机不保存。
   * 第 62 批：可带手机号与短信验证码（云端要求时必填）；码另认 12 位注册邀请码（运营按批次发，凭它开试用律所，没有本机核对段）。
   */
  async accountRegister(p: { email?: unknown; password?: unknown; name?: unknown; org_name?: unknown; code?: unknown; phone?: unknown; sms_code?: unknown }): Promise<Record<string, unknown>> {
    const done = this.exclusive();
    try {
      if (this.pending()) throw new DomainError("conflict", "这台电脑正在等待批准；如要改用别的账号，请先点“重新输入”", 409);
      const hasCode = typeof p.code === "string" && p.code.trim() !== "";
      const input = hasCode ? (splitInvitationInput(p.code) ?? registrationInviteInput(p.code)) : null;
      if (hasCode && !input) throw new DomainError("validation", "注册邀请码是 12 位、开通码是 20 位、成员邀请码是 36 位字母与数字（可带连字符），请核对后重新输入", 400);
      rmSync(join(this.root, JOIN_FAILED_FILE), { force: true });
      const phone = typeof p.phone === "string" && p.phone.trim() ? p.phone.trim() : null;
      const smsCode = typeof p.sms_code === "string" && p.sms_code.trim() ? p.sms_code.replace(/\s+/g, "") : null;
      const j = await this.accountCall("/v1/auth/register", { email: p.email, password: p.password, name: p.name, ...(typeof p.org_name === "string" && p.org_name.trim() ? { org_name: p.org_name } : {}), ...(input ? { code: input.code } : {}), ...(phone ? { phone, ...(smsCode ? { sms_code: smsCode } : {}) } : {}), client: this.clientInfo() });
      return await this.afterAuth(j, input?.secret ?? null);
    } finally {
      if (!this.restarting) done();
    }
  }

  /** 登录（待激活模式：这台电脑还没有身份）。第 63 批：也可用手机号 + 短信验证码（先 account.sms_send purpose=login）。 */
  async accountLogin(p: { email?: unknown; password?: unknown; phone?: unknown; sms_code?: unknown }): Promise<Record<string, unknown>> {
    const done = this.exclusive();
    try {
      // 第 68 批（安全复核 P-1）：一个账号在等批准时，别的账号仍可登录回这台电脑上它自己的档案（等批准的申请原样保留）；
      // 只有“再为一个新账号登记”要先点“重新输入”
      const waiting = this.pending();
      const j = await this.accountCall("/v1/auth/login", { ...loginBody(p), client: this.clientInfo(), account_switch: true });
      if (waiting) {
        const ex = this.switchToExisting(j);
        if (ex) return ex;
        throw new DomainError("conflict", "这台电脑正在等待批准；如要改用别的账号，请先点“重新输入”", 409);
      }
      return await this.afterAuth(j, null);
    } finally {
      if (!this.restarting) done();
    }
  }

  /** 找回密码（两种模式都可用）：有邮件通道发验证码，否则提示找管理员要重置码。 */
  async resetRequest(p: { email?: unknown }): Promise<Record<string, unknown>> {
    return this.accountCall("/v1/auth/password-reset/request", { email: p.email });
  }

  /** 用验证码 / 重置码 / 设置码设新密码（两种模式都可用；之后要重新登录）。第 62 批：也可用手机号 + 短信验证码（先 account.sms_send purpose=reset）。 */
  async resetConfirm(p: { email?: unknown; phone?: unknown; code?: unknown; password?: unknown }): Promise<Record<string, unknown>> {
    const byPhone = typeof p.phone === "string" && p.phone.trim() !== "" && (p.email === undefined || p.email === null || p.email === "");
    await this.accountCall("/v1/auth/password-reset/confirm", byPhone ? { phone: String(p.phone).trim(), code: p.code, password: p.password } : { email: p.email, code: p.code, password: p.password });
    return { ok: true };
  }

  private clientInfo(): { version: string | null; platform: string } {
    return { version: this.d.config.env.ZR_APP_VERSION ?? null, platform: process.platform === "win32" || process.platform === "darwin" ? process.platform : "linux" };
  }

  /** 成员取回申请结果；批准则暂存证书并请求重启。 */
  check(): Promise<Record<string, unknown>> {
    if (this.checking) return this.checking as Promise<Record<string, unknown>>;
    const run = this.doCheck().finally(() => {
      this.checking = null;
    });
    this.checking = run;
    return run;
  }

  private async doCheck(): Promise<Record<string, unknown>> {
    const p = this.pending();
    if (!p) return this.status();
    const keysDir = this.keysDirFor(p.workspace ?? p.firm_slug);
    const pendingPath = join(keysDir, "join-pending.json");
    if (!existsSync(pendingPath)) throw new DomainError("conflict", "本机的申请记录丢失，请点“重新输入”后用邀请码重新申请", 409);
    const st = readSecretFile<JoinPending>(pendingPath);
    const r = await cpPost(this.d.relay, `/v1/join-requests/${p.join_request_id}/fetch`, { tid: p.tid, claim_secret: st.claim_secret });
    if (!r.ok) return { ...this.status(), last_check: "unreachable", message: cpErrorText(r.code) };
    const status = String(r.json.status ?? "");
    if (status === "pending") return { ...this.status(), last_check: "pending" };
    // 账号登录的新电脑没有邀请码可重发：申请失效（被拒、过期，或同一账号在另一台新电脑上又登录过而换了新申请）就重新登录（第 47 批真实走查）
    if (status === "rejected" || (p.via_account && status === "withdrawn"))
      return {
        ...this.status(),
        last_check: "rejected",
        message: p.via_account
          ? "这次申请已失效（管理员拒绝、超过 7 天，或这个账号在别的新电脑上又登录过）。请点“改用别的账号”重新登录，会生成新的申请和新的核对码"
          : "管理员没有批准这次申请（或申请已超过 7 天）。可以请管理员重新发邀请码后点“重新输入”",
      };
    if (status !== "approved") return { ...this.status(), last_check: "unknown" };

    const cert = r.json.cert as DeviceCertificate;
    const rootPub = String(r.json.root_public_key_pem ?? "");
    const fb = r.json.firm_bundle as FirmBundle | undefined;
    const vr = cert && rootPub ? verifyDeviceCertificate(cert, rootPub) : { ok: false };
    const same =
      !!cert &&
      cert.deviceId === p.device_id &&
      cert.memberId === `usr_${p.firm_slug}_${p.member_slug}` &&
      cert.signPublicKeyPem === st.keys.signPublicKeyPem &&
      cert.encPublicKeyPem === st.keys.encPublicKeyPem;
    const fbOk = !!fb && typeof fb.recovery_public_key_pem === "string" && typeof fb.sig === "string" && verifyBytes(rootPub, firmBundleBytes(p.tid, rootPub, fb.recovery_public_key_pem), fb.sig);
    // 管理员用邀请码本机秘密段对批准结果做的 HMAC（复核 A-03）：控制面不知秘密，伪造不了律所根、证书与恢复托管公钥——不再首次信任
    // 管理员对律所名称与成员姓名的核对也在其中：与本机兑换时记下的不一致即不采用（activation.json 里的显示名因此经管理员确认）
    // 账号新设备入组（第 44 批 D-186）没有邀请码本机段：没有批准核对段可核，靠律师比对核对码（批准后另显示律所核对码，与已有设备上的比对）
    const macOk =
      st.invite_secret === null
        ? p.via_account === true
        : typeof st.invite_secret === "string" &&
          inviteMacValid(st.invite_secret, approvalMacBytes({ tid: p.tid, joinRequestId: p.join_request_id, cert, rootPublicKeyPem: rootPub, bundle: fb, firmName: p.firm_name, memberName: p.member_name }), r.json.admin_mac);
    if (!vr.ok || !same || !fbOk || !macOk) {
      slog.event("KERNEL_ONBOARDING_CERT_REJECTED", {});
      throw new DomainError("provider_unavailable", "收到的批准结果核对不通过，没有采用。请联系管理员重新批准；如反复出现请联系客服", 502);
    }
    writeStagedSecret(join(keysDir, "join-approved.json"), { cert, root_public_key_pem: rootPub, recovery_public_key_pem: fb!.recovery_public_key_pem, keys: st.keys });
    const role = (ROLES.includes(cert.role as Role) ? cert.role : "lawyer") as Role;
    this.writeActivation({ tid: p.tid, firm_slug: p.firm_slug, firm_name: p.firm_name, member_slug: p.member_slug, member_name: p.member_name, role, kind: "member", ...(p.device_id !== expectedJoinDeviceId(p.firm_slug, p.member_slug) ? { device_id: p.device_id } : {}) }, p.workspace ?? p.firm_slug);
    rmSync(pendingPath, { force: true });
    rmSync(join(this.root, ONBOARDING_FILE), { force: true });
    this.stop();
    slog.event("KERNEL_ONBOARDING_JOINED", {});
    this.restartSoon();
    return { mode: "member_pending", last_check: "approved", next: "restart", firm_check_code: firmCheckCode(p.tid, rootPub), ...(p.via_account ? { via_account: true } : {}) };
  }

  /** 放弃本机的待批准申请（被拒、换邀请码）：同时请控制面撤回（复核 A-09，不必等 7 天）；撤回失败不影响本机重来。 */
  async reset(): Promise<Record<string, unknown>> {
    const p = this.pending();
    if (p) {
      const pendingPath = join(this.keysDirFor(p.workspace ?? p.firm_slug), "join-pending.json");
      try {
        const st = existsSync(pendingPath) ? readSecretFile<JoinPending>(pendingPath) : null;
        if (st?.join_request_id) await cpPost(this.d.relay, `/v1/join-requests/${st.join_request_id}/withdraw`, { tid: p.tid, claim_secret: st.claim_secret });
      } catch {
        // 撤回不了：控制面上的申请 7 天后自动作废
      }
      rmSync(pendingPath, { force: true });
    }
    rmSync(join(this.root, ONBOARDING_FILE), { force: true });
    rmSync(join(this.root, JOIN_FAILED_FILE), { force: true });
    this.stop();
    return this.status();
  }
}

/** 正常模式：律所核对码与激活信息（设置页显示，成员可与管理员核对）。 */
export function activationInfo(config: KernelConfig, firm: FirmIdentityRow, identity: Identity): Record<string, unknown> | null {
  const a = config.activation;
  if (!a) return null;
  return {
    firm: { name: a.firm_name },
    member: { name: a.member_name, role: a.role },
    kind: a.kind,
    activated_at: a.activated_at,
    firm_check_code: firmCheckCode(identity.tenantId, firm.rootPublicKeyPem),
  };
}

export interface MembersDeps {
  db: KernelDb;
  identity: Identity;
  config: KernelConfig;
  firm: FirmIdentityRow;
  keysDir: string;
  call: SignedCall | null;
  audit: (action: string, kind: string, objectId: string) => void;
}

/** 管理员本机记录的律所名称（与成员机兑换时的取法一致：激活记录里的名称，开发形态没有激活记录时用律所标识）。 */
function firmNameOf(d: MembersDeps): string {
  return d.config.activation?.firm_name ?? d.config.firmSlug;
}

function requireCp(d: MembersDeps): SignedCall {
  if (!d.call) throw new DomainError("conflict", "成员管理需要连接中软服务（本机为开发形态）", 409);
  return d.call;
}

function cpFail(r: { ok: false; error: string }): never {
  const map: Record<string, string> = {
    admin_required: "只有律所管理员能做这件事",
    join_unknown: "这个申请已处理或已过期，请刷新",
    activation_not_claimed: "这个邀请已作废或已使用",
    too_many_open_codes: "未使用的邀请过多，请先作废不用的邀请",
    member_slug_invalid: "成员信息不合规",
    member_name_invalid: "姓名须为 1–40 个字符",
  };
  throw new DomainError(r.error === "admin_required" ? "forbidden" : "provider_unavailable", map[r.error] ?? "没有完成，请稍后重试", r.error === "admin_required" ? 403 : 502, { reason: r.error });
}

/** 管理员看过的待批准申请快照（复核 A-01）：批准只用这里核对过的内容，不在批准那一刻再向控制面取。 */
interface JoinSnapshot {
  id: string;
  activation_id: string;
  member_slug: string;
  role: Role;
  device_id: string;
  sign_pub: string;
  enc_pub: string;
  check_code: string;
  /** 第 44 批：invitation = 凭邀请码入组；account = 同一账号的新设备（D-186，人工核对核对码）。 */
  via: "invitation" | "account";
  account_email: string | null;
}

interface LocalInvite {
  activation_id: string;
  member_slug: string;
  role: Role;
  display_name: string;
  invite_secret: string;
  status: string;
}

/** 正常模式的成员管理（管理员设备）。 */
export const membersApi = (d: MembersDeps) => {
  const snapshots = new Map<string, JoinSnapshot>();
  // 侧栏提醒的上次结果（B-3 余项）：60 秒内复用（失败也缓存，复核 RB16B-18）；批准、拒绝、刷新成员页后作废
  let attentionCache: { at: number; n: number } | null = null;
  const ATTENTION_TTL_MS = 60_000;
  /** 一份入组申请能不能在这台电脑上批准（成员页与侧栏提醒同一判定，复核 RB16B-19）：本机发出的有效邀请、成员与角色一致、设备编号合规、HMAC 核对通过。 */
  const checkJoin = (x: any): { local: LocalInvite | undefined; snap: JoinSnapshot; verified: boolean } => {
    const local = inviteOf(String(x.activation_id));
    const snap: JoinSnapshot = {
      id: String(x.id),
      activation_id: String(x.activation_id),
      member_slug: String(x.member_slug),
      role: String(x.role) as Role,
      device_id: String(x.device_id),
      sign_pub: String(x.sign_pub),
      enc_pub: String(x.enc_pub),
      check_code: joinCheckCode({ tid: d.identity.tenantId, deviceId: String(x.device_id), signPublicKeyPem: String(x.sign_pub), encPublicKeyPem: String(x.enc_pub) }),
      via: x.via === "account" ? "account" : "invitation",
      account_email: typeof x.account?.email === "string" ? x.account.email : null,
    };
    if (snap.via === "account") {
      // 账号新设备（D-186）：成员须是本所已有成员、角色与本机记录一致（控制面不能借此提权）、设备编号属于这位成员（_D2～_D9）
      const m = d.db.get<{ role: string }>(`SELECT role FROM memberships WHERE tenant_id = ? AND user_id = ?`, [d.identity.tenantId, `usr_${d.config.firmSlug}_${snap.member_slug}`]);
      const base = expectedJoinDeviceId(d.config.firmSlug, snap.member_slug);
      const ok = !!m && ROLE_OF_MEMBERSHIP[m.role] === snap.role && MEMBER_SLUG_PATTERN.test(snap.member_slug) && /^_D(?:[2-9]|[1-9]\d{1,2})$/.test(snap.device_id.slice(base.length)) && snap.device_id.startsWith(base);
      return { local: undefined, snap, verified: ok };
    }
    const verified =
      !!local &&
      local.status === "open" &&
      local.member_slug === snap.member_slug &&
      local.role === snap.role &&
      snap.device_id === expectedJoinDeviceId(d.config.firmSlug, snap.member_slug) &&
      inviteMacValid(
        local.invite_secret,
        joinMacBytes({
          tid: d.identity.tenantId,
          activationId: snap.activation_id,
          deviceId: snap.device_id,
          signPublicKeyPem: snap.sign_pub,
          encPublicKeyPem: snap.enc_pub,
          memberSlug: snap.member_slug,
          role: snap.role,
          firmName: firmNameOf(d),
          memberName: local.display_name,
        }),
        x.mac,
      );
    return { local, snap, verified };
  };
  const inviteOf = (activationId: string) =>
    d.db.get<LocalInvite>(`SELECT activation_id, member_slug, role, display_name, invite_secret, status FROM member_invitations WHERE activation_id = ? AND tenant_id = ?`, [activationId, d.identity.tenantId]);
  return {
    /** 邀请成员：本机生成邀请码的秘密段（不经控制面）并记下成员与角色，再向中软申请一次性的控制面码；两段拼成 36 位邀请码，只显示这一次。 */
    async invite(p: { name?: unknown; role?: unknown }): Promise<Record<string, unknown>> {
      const call = requireCp(d);
      const name = typeof p.name === "string" ? p.name.trim() : "";
      if (!validDisplayName(name)) throw new DomainError("validation", "请填写成员姓名（1–40 个字符）", 400);
      const role = (typeof p.role === "string" && ROLES.includes(p.role as Role) ? p.role : "lawyer") as Role;
      const slug = `m-${randomBytes(5).toString("hex")}`;
      const r = await call("POST", "/v1/invitations", { member_slug: slug, name, role, ttl_hours: 72 });
      if (!r.ok) cpFail(r);
      const secret = newInviteSecret();
      const userId = `usr_${d.config.firmSlug}_${slug}`;
      d.db.tx(() => {
        d.db.run(`INSERT INTO member_invitations (activation_id, tenant_id, member_slug, role, display_name, invite_secret) VALUES (?,?,?,?,?,?)`, [String(r.json.activation_id), d.identity.tenantId, slug, role, name, secret]);
        d.db.run(`INSERT OR IGNORE INTO users (user_id, tenant_id, display_name) VALUES (?, ?, ?)`, [userId, d.identity.tenantId, name]);
      });
      attentionCache = null;
      d.audit("member.invite", "member", userId);
      return { ok: true, code: formatActivationCode(`${String(r.json.code)}${secret}`), expires_at: r.json.expires_at, activation_id: r.json.activation_id, member: { name, role } };
    },

    /**
     * 邀请与待批准申请：每条申请用本机邀请记录的秘密段核对 HMAC（控制面改过的申请核对不通过）、核对设备编号与角色，
     * 核对码由本机按申请公钥独立算出；核对通过的才留快照、才能批准。
     */
    async list(): Promise<Record<string, unknown>> {
      const call = requireCp(d);
      const [inv, jr] = await Promise.all([call("GET", "/v1/invitations"), call("GET", "/v1/join-requests")]);
      if (!inv.ok) cpFail(inv);
      if (!jr.ok) cpFail(jr);
      const invitations = (inv.json.invitations as any[]).map((x) => {
        const local = inviteOf(String(x.activation_id));
        return { activation_id: x.activation_id, name: local?.display_name ?? null, role: local?.role ?? x.member?.role, status: x.status, created_at: x.created_at, expires_at: x.expires_at, local: !!local };
      });
      snapshots.clear();
      const requests = (jr.json.join_requests as any[]).map((x) => {
        const { local, snap, verified } = checkJoin(x);
        if (verified) snapshots.set(snap.id, snap);
        // 账号新电脑：本机成员表的姓名；本机记的只是成员标识（创始管理员的旧记录）时，用控制面账号上的姓名（第 47 批真实走查：显示成了“admin”）
        const localName = snap.via === "account" ? (d.db.get<{ display_name: string }>(`SELECT display_name FROM users WHERE tenant_id = ? AND user_id = ?`, [d.identity.tenantId, `usr_${d.config.firmSlug}_${snap.member_slug}`])?.display_name ?? null) : null;
        const accountName = typeof x.account?.name === "string" && x.account.name.trim() ? String(x.account.name).trim().slice(0, 40) : null;
        const memberName = snap.via === "account" ? (localName && localName !== snap.member_slug ? localName : (accountName ?? localName)) : null;
        return {
          id: snap.id,
          name: local?.display_name ?? memberName,
          role: local?.role ?? snap.role,
          requested_at: x.created_at,
          check_code: snap.check_code,
          // 第 44 批：账号新设备（同一成员换电脑或加电脑）——没有邀请可对，须当面或电话核对核对码
          via: snap.via,
          account_email: snap.account_email,
          // 本机没有发过这个邀请（例如另一台管理员设备发出）：不能在这台电脑上批准
          local_invite: !!local || snap.via === "account",
          // 申请在传送中被改动过（HMAC、设备编号或角色核对不通过）：不要批准
          verified,
        };
      });
      attentionCache = { at: Date.now(), n: requests.filter((x) => x.verified).length };
      return { invitations, join_requests: requests, firm_check_code: firmCheckCode(d.identity.tenantId, d.firm.rootPublicKeyPem) };
    },

    /**
     * 侧栏用户卡的提醒（v9.3 B-3 余项）：有几份入组申请等这台电脑批准——只数本机发出、仍有效的邀请对应的申请（别的管理员电脑发出的这里批不了）。
     * 不动 list() 的批准快照（批准只认律师在成员页核对过的那一份）；60 秒内复用上次结果（侧栏切页、运行中每 5 秒都会问）；
     * 没有控制面、不是管理员、联不上一律报 0，不报错。
     */
    async attention(): Promise<{ pending_joins: number }> {
      if (!d.call) return { pending_joins: 0 };
      if (attentionCache && Date.now() - attentionCache.at < ATTENTION_TTL_MS) return { pending_joins: attentionCache.n };
      // 本机没有仍有效的邀请：不可能有能在这里批准的申请，不联网（绝大多数时间如此，复核 RB16B-18）
      const open = d.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM member_invitations WHERE tenant_id = ? AND status = 'open'`, [d.identity.tenantId])?.n ?? 0;
      // 第 44 批：账号新设备的申请不对应本机邀请——管理员电脑总要看一眼（仍按 60 秒缓存）
      const isAdmin = d.db.get<{ role: string }>(`SELECT role FROM memberships WHERE tenant_id = ? AND user_id = ?`, [d.identity.tenantId, d.identity.userId])?.role === "firm_admin";
      if (open === 0 && !isAdmin) {
        attentionCache = { at: Date.now(), n: 0 };
        return { pending_joins: 0 };
      }
      const r = await d.call("GET", "/v1/join-requests").catch(() => null);
      if (!r || !r.ok || !Array.isArray(r.json?.join_requests)) {
        // 联不上或被拒（不是管理员证书）也缓存 60 秒：不让侧栏每 5 秒打一次控制面
        attentionCache = { at: Date.now(), n: attentionCache?.n ?? 0 };
        return { pending_joins: attentionCache.n };
      }
      const n = (r.json.join_requests as any[]).filter((x) => checkJoin(x).verified).length;
      attentionCache = { at: Date.now(), n };
      return { pending_joins: n };
    },

    /** 批准：只用列表时核对过的快照（复核 A-01）；成员编号与角色取本机邀请记录；证书 + 律所公钥包 + 用秘密段对批准结果做的 HMAC。 */
    async approve(p: { join_request_id?: unknown }): Promise<Record<string, unknown>> {
      const call = requireCp(d);
      const id = String(p.join_request_id ?? "");
      const snap = snapshots.get(id);
      if (!snap) throw new DomainError("conflict", "请先刷新成员页、核对数字后再批准（只能批准核对通过的申请）", 409);
      const viaAccount = snap.via === "account";
      const local = viaAccount ? undefined : inviteOf(snap.activation_id);
      if (!viaAccount && (!local || local.status !== "open" || local.member_slug !== snap.member_slug || local.role !== snap.role)) throw new DomainError("conflict", "这个邀请已处理过，或不是在这台电脑上发出的", 409);
      const role = (viaAccount ? snap.role : local!.role) as Role;
      const displayName = viaAccount ? (d.db.get<{ display_name: string }>(`SELECT display_name FROM users WHERE tenant_id = ? AND user_id = ?`, [d.identity.tenantId, `usr_${d.config.firmSlug}_${snap.member_slug}`])?.display_name ?? null) : local!.display_name;
      let root: { publicKeyPem: string; privateKeyPem: string };
      try {
        root = getFirmRootPrivateKey(d.keysDir);
      } catch {
        throw new DomainError("forbidden", "这台电脑不能批准新成员（需要在律所开通时的那台电脑上操作）", 409);
      }
      const userId = `usr_${d.config.firmSlug}_${snap.member_slug}`;
      const now = Date.now();
      const cert = issueDeviceCertificate(root.privateKeyPem, {
        certId: `cert_${snap.device_id}_${now.toString(36)}`,
        memberId: userId,
        deviceId: snap.device_id,
        role: role as DeviceRole,
        signPublicKeyPem: snap.sign_pub,
        encPublicKeyPem: snap.enc_pub,
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 365 * 24 * 3600 * 1000).toISOString(),
      });
      const bundle: FirmBundle = {
        recovery_public_key_pem: d.firm.recoveryPublicKeyPem,
        // 经签名者签（签名者表面门禁 KP-02：keys 包外不直接按私钥签名）
        sig: new SoftwareSigner(root.privateKeyPem).signSync(firmBundleBytes(d.identity.tenantId, root.publicKeyPem, d.firm.recoveryPublicKeyPem)),
      };
      // 账号新设备（D-186）没有邀请码本机段，没有批准核对段
      const adminMac = viaAccount
        ? null
        : inviteMac(local!.invite_secret, approvalMacBytes({ tid: d.identity.tenantId, joinRequestId: snap.id, cert, rootPublicKeyPem: root.publicKeyPem, bundle, firmName: firmNameOf(d), memberName: displayName }));
      const r = await call("POST", `/v1/join-requests/${id}/approve`, { cert, firm_bundle: bundle, ...(adminMac ? { admin_mac: adminMac } : {}) });
      if (!r.ok) cpFail(r);
      d.db.tx(() => {
        if (!viaAccount) d.db.run(`UPDATE member_invitations SET status = 'approved', device_id = ?, decided_at = ? WHERE activation_id = ?`, [snap.device_id, new Date(now).toISOString(), snap.activation_id]);
        d.db.run(`INSERT OR IGNORE INTO memberships (membership_id, tenant_id, user_id, role) VALUES (?, ?, ?, ?)`, [`membership_${snap.member_slug}`, d.identity.tenantId, userId, MEMBERSHIP_ROLE[role]]);
      });
      snapshots.delete(id);
      attentionCache = null;
      d.audit(viaAccount ? "member.device_approve" : "member.join_approve", "device", snap.device_id);
      return { ok: true, status: "approved" };
    },

    async reject(p: { join_request_id?: unknown }): Promise<Record<string, unknown>> {
      const call = requireCp(d);
      const id = String(p.join_request_id ?? "");
      if (!/^jr_[A-Za-z0-9_-]{16}$/.test(id)) throw new DomainError("not_found", "这个申请已处理或已过期，请刷新", 404);
      const r = await call("POST", `/v1/join-requests/${id}/reject`, {});
      if (!r.ok) cpFail(r);
      snapshots.delete(id);
      attentionCache = null;
      d.audit("member.join_reject", "join_request", id);
      return { ok: true, status: "rejected" };
    },

    async revokeInvitation(p: { activation_id?: unknown }): Promise<Record<string, unknown>> {
      const call = requireCp(d);
      const id = String(p.activation_id ?? "");
      if (!/^act_[A-Za-z0-9_-]{16}$/.test(id)) throw new DomainError("not_found", "没有这个邀请", 404);
      const r = await call("POST", `/v1/invitations/${id}/revoke`, {});
      if (!r.ok) cpFail(r);
      d.db.run(`UPDATE member_invitations SET status = 'revoked', decided_at = ? WHERE activation_id = ? AND status = 'open'`, [new Date().toISOString(), id]);
      attentionCache = null;
      d.audit("member.invite_revoke", "invitation", id);
      return { ok: true };
    },
  };
};

/** 待激活模式下开放的内核方法（其余一律 not_activated）。第 14 批加“从备份恢复”。 */
/**
 * 注册 / 登录策略（第 62 批；第 63 批加 phone_login、phone_bind）：云端 /v1/meta 有 registration_policy 才按它显示手机号、邀请码与验证码登录；
 * 旧云端没有、取不到或格式不对，一律回 legacy（界面照旧流程：只有邮箱密码登录、注册不要求手机号）。只回界面要用的几项，不透传云端原文。
 * 待激活模式（onboarding）与已激活模式（account.registration_meta）共用。
 */
export function registrationMetaOf(json: Record<string, unknown> | null): Record<string, unknown> {
  const pol = json ? (json.registration_policy as Record<string, unknown> | undefined) : undefined;
  const features = json && Array.isArray(json.features) ? (json.features as unknown[]).filter((x): x is string => typeof x === "string") : [];
  if (!pol || typeof pol !== "object" || !features.includes("sms_send")) return { legacy: true, mode: json && typeof json.registration === "string" ? json.registration : null };
  const sms = (pol.sms ?? {}) as Record<string, unknown>;
  const int = (v: unknown, lo: number, hi: number, d: number) => (Number.isSafeInteger(v) && (v as number) >= lo && (v as number) <= hi ? (v as number) : d);
  return {
    legacy: false,
    mode: pol.mode === "open" || pol.mode === "code" || pol.mode === "closed" ? pol.mode : "open",
    invite_required: pol.invite_required === true,
    require_phone: pol.require_phone === true,
    sms_available: pol.sms_available === true,
    phone_reset: pol.phone_reset === true,
    phone_login: features.includes("phone_login") && pol.phone_login === true,
    phone_bind: features.includes("phone_bind") && pol.phone_bind === true,
    // 第 68 批（V42）：云端支持同一台电脑换账号（带签名登录别的账号不再被拒）、电脑数已满时用刚完成的登录就地移除一台
    account_switch: features.includes("account_switch"),
    device_unbind_on_login: features.includes("device_limit_unbind"),
    // 第 69 批：密码登录可填手机号
    password_by_phone: pol.password_by_phone === true,
    sms: { code_length: int(sms.code_length, 4, 8, 6), resend_seconds: int(sms.resend_seconds, 30, 600, 60), ttl_minutes: int(sms.ttl_minutes, 1, 30, 10) },
  };
}

/**
 * 取注册 / 登录策略（第 64 批；开通页与已激活电脑的重新登录页共用）：
 * - 云端答了 → registrationMetaOf（没有 registration_policy 的旧云端照旧回 legacy）；很旧的云端没有 /v1/meta（404）也按 legacy；
 * - 取不到（连不上、超时、证书不符、云端 5xx）→ 抛错（reason 带原因代码），界面显示“取不到登录方式 · 重试”。
 *   此前一律回 legacy：界面会把“暂时连不上”当成“云端没开验证码登录”，只显示邮箱密码登录且这次打开不再变。
 */
export async function fetchRegistrationMeta(get: () => Promise<{ ok: true; json: Record<string, unknown> } | { ok: false; code: string; status?: number }>): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  const r = await get();
  // 很旧的云端没有 /v1/meta：控制面对未知路径回 not_found（部分代理回纯 404）
  if (r.ok || r.code === "http_404" || r.code === "not_found") {
    const meta = registrationMetaOf(r.ok ? r.json : null);
    slog.event("KERNEL_REGISTRATION_META", { outcome: meta.legacy ? "legacy" : "ok", ms: Date.now() - t0 });
    return meta;
  }
  const reason = /^[a-z0-9_]{1,40}$/.test(r.code) ? r.code : "other";
  slog.event("KERNEL_REGISTRATION_META", { outcome: "unavailable", ms: Date.now() - t0, reason });
  throw new DomainError("provider_unavailable", cloudFailureText(r.code) ?? "连不上 Kimi Work 服务。请检查网络或代理设置后点“重试”；网络恢复后这里会自动再试。", 503, { reason });
}

/** 手机号输入（本机先粗查格式，最终以云端为准）：不合格即 phone_invalid。 */
export function smsPhoneInput(v: unknown): string {
  const phone = typeof v === "string" ? v.trim() : "";
  if (!/^(?:\+?86)?1[3-9]\d{9}$/.test(phone.replace(/[\s-]/g, ""))) throw new DomainError("validation", accountErrorText("phone_invalid"), 400, { reason: "phone_invalid" });
  return phone;
}

/** 发码应答 → 界面要用的几项。dry-run（只在非生产云端）：云端随应答给出验证码，界面写明“测试环境”；生产不会有这一项。 */
export function smsSendResult(j: Record<string, any>): Record<string, unknown> {
  const n = (v: unknown, d: number) => (Number.isSafeInteger(v) && (v as number) > 0 && (v as number) <= 86_400 ? (v as number) : d);
  return { ok: true, phone: typeof j.phone === "string" ? j.phone : null, resend_after_s: n(j.resend_after_s, 60), expires_in_s: n(j.expires_in_s, 600), code_length: n(j.code_length, 6), ...(j.dry_run === true && typeof j.debug_code === "string" && /^\d{4,8}$/.test(j.debug_code) ? { dry_run: true, debug_code: j.debug_code } : {}) };
}

/** 登录请求体（第 63 批）：给了手机号、没给邮箱 → 验证码方式（phone + sms_code）；否则邮箱 + 密码。 */
export function loginBody(p: { email?: unknown; password?: unknown; phone?: unknown; sms_code?: unknown }): Record<string, unknown> {
  const byPhone = typeof p.phone === "string" && p.phone.trim() !== "" && (p.email === undefined || p.email === null || p.email === "");
  if (!byPhone) return { email: p.email, password: p.password };
  return { phone: smsPhoneInput(p.phone), sms_code: typeof p.sms_code === "string" ? p.sms_code.replace(/\s+/g, "") : "" };
}

export const ONBOARDING_METHODS: ReadonlySet<string> = new Set(["kernel.status", "onboarding.status", "onboarding.redeem", "onboarding.check", "onboarding.reset", "onboarding.restore", "onboarding.unbind_device", "onboarding.device_confirm", "device.env_probe", "account.register", "account.login", "account.reset_request", "account.reset_confirm", "account.registration_meta", "account.sms_send"]);

/** 第 62 批：12 位注册邀请码（Crockford Base32，与开通码同一归一规则）；不是即 null。纯函数。 */
export function registrationInviteInput(input: unknown): { code: string; secret: null } | null {
  if (typeof input !== "string" || input.length > 64) return null;
  const s = input
    .toUpperCase()
    .replace(/[\s\-‐-―－]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  return /^[0-9A-HJKMNP-TV-Z]{12}$/.test(s) ? { code: s, secret: null } : null;
}

const JOIN_FAILED_FILE = "onboarding-failed.json";
const PENDING_ACTIVATION_FILE = "activation.pending.json";

/**
 * 从备份恢复的“待生效激活记录”（复核 R2A-15）：恢复写好工作区后先写 activation.pending.json，主进程采用旧主密钥并重启后，
 * 内核在启动时（`reconcilePendingRestore`）用当前主密钥试开恢复出的账本——打得开才改名为 activation.json；打不开（主进程没能采用）
 * 就删掉恢复出的工作区与待生效记录、记原因代码，回到待激活，律师可以再恢复一次。
 */
export function writePendingActivation(dataRoot: string, a: ActivationFile): void {
  writeJsonAtomic(join(dataRoot, PENDING_ACTIVATION_FILE), a);
}

export function reconcilePendingRestore(dataRoot: string, canOpenLedger: (dbFile: string) => boolean, readActivation: (a: unknown) => ActivationFile | null): "promoted" | "rolled_back" | "none" {
  const pendingPath = join(dataRoot, PENDING_ACTIVATION_FILE);
  if (!existsSync(pendingPath)) return "none";
  const a = readActivation(readJson<unknown>(pendingPath));
  const ws = a ? join(dataRoot, workspaceNameOf(a)) : null;
  const restored = ws !== null && existsSync(join(ws, ".restored-from-backup.json"));
  if (a && ws && restored && !existsSync(activationFilePath(dataRoot)) && canOpenLedger(join(ws, "ledger.db"))) {
    writeProfile(dataRoot, a);
    renameSync(pendingPath, activationFilePath(dataRoot));
    rmSync(join(dataRoot, JOIN_FAILED_FILE), { force: true });
    return "promoted";
  }
  // 只删恢复出来的工作区（带恢复标记的），别的目录不动
  if (ws && restored) rmSync(ws, { recursive: true, force: true });
  rmSync(pendingPath, { force: true });
  writeJoinFailure(dataRoot, "restore_incomplete");
  return "rolled_back";
}

/**
 * 成员入组在本机没有生效（复核 B13-K02）：记下原因代码（不含路径与身份），回到待激活后激活页据此告诉律师“要重新申请”，
 * 而不是一直显示“正在打开…”。重新兑换或“重新输入”即删除。
 */
export function writeJoinFailure(dataRoot: string, code: string): void {
  writeJsonAtomic(join(dataRoot, JOIN_FAILED_FILE), { v: 1, code: /^[a-z_]{1,40}$/.test(code) ? code : "unknown", at: new Date().toISOString() });
}

function readJoinFailure(dataRoot: string): { code: string; at: string } | null {
  try {
    const f = JSON.parse(readFileSync(join(dataRoot, JOIN_FAILED_FILE), "utf8")) as { v?: number; code?: unknown; at?: unknown };
    return f.v === 1 && typeof f.code === "string" && /^[a-z_]{1,40}$/.test(f.code) ? { code: f.code, at: String(f.at ?? "") } : null;
  } catch {
    return null;
  }
}

/** 写本机激活记录（从备份恢复时用；与兑换开通码同一原子写）。 */
export function writeActivationFile(dataRoot: string, a: ActivationFile): void {
  writeJsonAtomic(activationFilePath(dataRoot), a);
}

/** 认领凭据暂存（创始设备首次登记根公钥时出示；登记成功即删除）。 */
export function readActivationClaim(keysDir: string): { activation_id: string; claim_secret: string } | null {
  const path = join(keysDir, "activation-claim.json");
  if (!existsSync(path)) return null;
  try {
    const c = readSecretFile<{ activation_id: string; claim_secret: string }>(path);
    return typeof c.activation_id === "string" && typeof c.claim_secret === "string" ? { activation_id: c.activation_id, claim_secret: c.claim_secret } : null;
  } catch {
    return null;
  }
}

export function dropActivationClaim(keysDir: string): void {
  rmSync(join(keysDir, "activation-claim.json"), { force: true });
}

/** 激活后按真实身份启动：删除待激活占位工作区（只认这一个固定名字）。 */
/**
 * 激活后删掉待激活占位工作区（只有空账本、日志与暂存）。第 54 批（Windows 安装包真实联调）：原来是裸 rmSync——Windows 上
 * 占位区里还有文件被占用（刚关闭的账本被杀毒软件扫描、残留句柄等）时抛 EBUSY / EPERM，内核每次启动都在这里失败，
 * 入组批准后“后台服务多次异常退出”，这台电脑始终登记不上。清理失败不能挡住启动：短暂重试，仍删不掉就记一条、下次启动再删。
 * 返回是否已删干净。
 */
export function removePendingWorkspace(dataRoot: string, rm: typeof rmSync = rmSync): boolean {
  try {
    rm(join(dataRoot, PENDING_WORKSPACE_SLUG), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    slog.event("KERNEL_PENDING_WORKSPACE_LEFT", { reason: code === "EBUSY" ? "busy" : code === "EPERM" || code === "EACCES" ? "perm" : "other" });
    return false;
  }
}
