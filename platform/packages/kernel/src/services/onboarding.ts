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
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { issueDeviceCertificate, SoftwareSigner, verifyBytes, verifyDeviceCertificate, type DeviceCertificate, type DeviceKeys, type DeviceRole } from "@zr-legal/keys";
import {
  firmBundleBytes,
  firmCheckCode,
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
}

/** 成员机暂存（keys/join-pending.json，封装）。 */
interface JoinPending {
  tid: string;
  activation_id: string;
  claim_secret: string;
  /** 申请提交前即写下（复核 A-09：提交成功后再回填编号）。 */
  join_request_id: string | null;
  keys: DeviceKeys;
  /** 邀请码的本机秘密段（复核 A-01/03：对申请做 HMAC、核对管理员对批准结果的 HMAC）。 */
  invite_secret: string;
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

async function cpPost(relay: CpRelay, path: string, body: unknown): Promise<{ ok: true; json: Record<string, any> } | { ok: false; code: string }> {
  const r = await relay({ method: "POST", path, headers: {}, body: JSON.stringify(body) });
  if (!r.ok) return { ok: false, code: r.reason.startsWith("cp_") ? "cp_unreachable" : r.reason };
  let json: Record<string, any> = {};
  try {
    json = r.body ? JSON.parse(r.body) : {};
  } catch {
    return { ok: false, code: "cp_reply_not_json" };
  }
  if (r.status >= 400) return { ok: false, code: String(json?.error?.code ?? `http_${r.status}`) };
  return { ok: true, json };
}

export interface OnboardingDeps {
  config: KernelConfig;
  relay: CpRelay;
  /** 请主进程按新身份重启内核（广播 kernel.restart_for_identity）。 */
  requestRestart: () => void;
}

/** 待激活模式下的开通服务。 */
export class OnboardingService {
  private readonly d: OnboardingDeps;
  private timer: NodeJS.Timeout | null = null;
  private checking: Promise<unknown> | null = null;
  private restarting = false;

  constructor(d: OnboardingDeps) {
    this.d = d;
  }

  private get root(): string {
    return this.d.config.dataRoot;
  }

  private pending(): OnboardingFile | null {
    const f = readJson<OnboardingFile>(join(this.root, ONBOARDING_FILE));
    return f && f.v === 1 && f.stage === "member_pending" && MEMBER_SLUG_PATTERN.test(f.member_slug) ? f : null;
  }

  private keysDirFor(firmSlug: string): string {
    const dir = keysDirOf(join(this.root, firmSlug));
    configureSecretSealing(dir, this.d.config.dbKey);
    return dir;
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
      };
    }
    return { mode: "unactivated", restarting: this.restarting };
  }

  private writeActivation(a: Omit<ActivationFile, "v" | "activated_at">): void {
    writeJsonAtomic(activationFilePath(this.root), { v: 1, ...a, activated_at: new Date().toISOString() } satisfies ActivationFile);
  }

  private restartSoon(): void {
    this.restarting = true;
    // 先让本次调用的应答回到界面，再请主进程重启
    setTimeout(() => this.d.requestRestart(), 300).unref();
  }

  async redeem(p: { code?: unknown }): Promise<Record<string, unknown>> {
    if (this.pending()) throw new DomainError("conflict", "这台电脑正在等待管理员批准；如要改用别的邀请码，请先点“重新输入”", 409);
    const input = splitInvitationInput(p.code);
    if (!input) throw new DomainError("validation", "开通码是 20 位、邀请码是 36 位字母与数字（可带连字符），请核对后重新输入", 400);
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
    const keysDir = this.keysDirFor(firmSlug);

    if (j.kind === "founder") {
      writeStagedSecret(join(keysDir, "activation-claim.json"), { tid: j.tid, activation_id: j.activation_id, claim_secret: j.claim_secret });
      this.writeActivation({ tid: j.tid, firm_slug: firmSlug, firm_name: firmName, member_slug: memberSlug, member_name: memberName, role, kind: "founder" });
      slog.event("KERNEL_ONBOARDING_ACTIVATED", {});
      this.restartSoon();
      return { kind: "founder", next: "restart", firm: { name: firmName }, member: { name: memberName, role } };
    }

    // 成员：邀请码必须带本机秘密段（复核 A-01）；本机生成设备密钥，先暂存再提交入组申请（复核 A-09）——只含公钥、持有证明与 HMAC
    if (!input.secret) throw new DomainError("validation", "邀请码不完整：应为 36 位（管理员页面上完整的那一串），请向管理员核对", 400);
    const { keys, signer } = generateJoinDeviceKeys();
    const deviceId = expectedJoinDeviceId(firmSlug, memberSlug);
    const proof = signer.signSync(joinProofBytes({ tid: j.tid, activationId: j.activation_id, deviceId, signPublicKeyPem: keys.signPublicKeyPem, encPublicKeyPem: keys.encPublicKeyPem }));
    const mac = inviteMac(input.secret, joinMacBytes({ tid: j.tid, activationId: j.activation_id, deviceId, signPublicKeyPem: keys.signPublicKeyPem, encPublicKeyPem: keys.encPublicKeyPem, memberSlug, role }));
    const pendingPath = join(keysDir, "join-pending.json");
    const staged: JoinPending = { tid: j.tid, activation_id: j.activation_id, claim_secret: j.claim_secret, join_request_id: null, keys, invite_secret: input.secret };
    writeStagedSecret(pendingPath, staged);
    const jr = await cpPost(this.d.relay, "/v1/join-requests", {
      tid: j.tid,
      activation_id: j.activation_id,
      claim_secret: j.claim_secret,
      device_id: deviceId,
      sign_pub: keys.signPublicKeyPem,
      enc_pub: keys.encPublicKeyPem,
      proof,
      mac,
    });
    if (!jr.ok || typeof jr.json.join_request_id !== "string") {
      rmSync(pendingPath, { force: true });
      throw new DomainError("provider_unavailable", cpErrorText(jr.ok ? "reply_invalid" : jr.code), 502);
    }
    writeStagedSecret(pendingPath, { ...staged, join_request_id: jr.json.join_request_id });
    const checkCode = joinCheckCode({ tid: j.tid, deviceId, signPublicKeyPem: keys.signPublicKeyPem, encPublicKeyPem: keys.encPublicKeyPem });
    const file: OnboardingFile = {
      v: 1,
      stage: "member_pending",
      tid: j.tid,
      firm_slug: firmSlug,
      firm_name: firmName,
      member_slug: memberSlug,
      member_name: memberName,
      role,
      activation_id: j.activation_id,
      join_request_id: jr.json.join_request_id,
      device_id: deviceId,
      check_code: checkCode,
      created_at: new Date().toISOString(),
    };
    writeJsonAtomic(join(this.root, ONBOARDING_FILE), file);
    slog.event("KERNEL_ONBOARDING_JOIN_REQUESTED", {});
    this.start();
    return { kind: "member", next: "wait", firm: { name: firmName }, member: { name: memberName, role }, check_code: checkCode };
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
    const keysDir = this.keysDirFor(p.firm_slug);
    const pendingPath = join(keysDir, "join-pending.json");
    if (!existsSync(pendingPath)) throw new DomainError("conflict", "本机的申请记录丢失，请点“重新输入”后用邀请码重新申请", 409);
    const st = readSecretFile<JoinPending>(pendingPath);
    const r = await cpPost(this.d.relay, `/v1/join-requests/${p.join_request_id}/fetch`, { tid: p.tid, claim_secret: st.claim_secret });
    if (!r.ok) return { ...this.status(), last_check: "unreachable", message: cpErrorText(r.code) };
    const status = String(r.json.status ?? "");
    if (status === "pending") return { ...this.status(), last_check: "pending" };
    if (status === "rejected") return { ...this.status(), last_check: "rejected", message: "管理员没有批准这次申请（或申请已超过 7 天）。可以请管理员重新发邀请码后点“重新输入”" };
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
    const macOk = typeof st.invite_secret === "string" && inviteMacValid(st.invite_secret, approvalMacBytes({ tid: p.tid, joinRequestId: p.join_request_id, cert, rootPublicKeyPem: rootPub, bundle: fb }), r.json.admin_mac);
    if (!vr.ok || !same || !fbOk || !macOk) {
      slog.event("KERNEL_ONBOARDING_CERT_REJECTED", {});
      throw new DomainError("provider_unavailable", "收到的批准结果核对不通过，没有采用。请联系管理员重新批准；如反复出现请联系客服", 502);
    }
    writeStagedSecret(join(keysDir, "join-approved.json"), { cert, root_public_key_pem: rootPub, recovery_public_key_pem: fb!.recovery_public_key_pem, keys: st.keys });
    const role = (ROLES.includes(cert.role as Role) ? cert.role : "lawyer") as Role;
    this.writeActivation({ tid: p.tid, firm_slug: p.firm_slug, firm_name: p.firm_name, member_slug: p.member_slug, member_name: p.member_name, role, kind: "member" });
    rmSync(pendingPath, { force: true });
    rmSync(join(this.root, ONBOARDING_FILE), { force: true });
    this.stop();
    slog.event("KERNEL_ONBOARDING_JOINED", {});
    this.restartSoon();
    return { mode: "member_pending", last_check: "approved", next: "restart", firm_check_code: firmCheckCode(p.tid, rootPub) };
  }

  /** 放弃本机的待批准申请（被拒、换邀请码）：同时请控制面撤回（复核 A-09，不必等 7 天）；撤回失败不影响本机重来。 */
  async reset(): Promise<Record<string, unknown>> {
    const p = this.pending();
    if (p) {
      const pendingPath = join(this.keysDirFor(p.firm_slug), "join-pending.json");
      try {
        const st = existsSync(pendingPath) ? readSecretFile<JoinPending>(pendingPath) : null;
        if (st?.join_request_id) await cpPost(this.d.relay, `/v1/join-requests/${st.join_request_id}/withdraw`, { tid: p.tid, claim_secret: st.claim_secret });
      } catch {
        // 撤回不了：控制面上的申请 7 天后自动作废
      }
      rmSync(pendingPath, { force: true });
    }
    rmSync(join(this.root, ONBOARDING_FILE), { force: true });
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
        };
        const verified =
          !!local &&
          local.status === "open" &&
          local.member_slug === snap.member_slug &&
          local.role === snap.role &&
          snap.device_id === expectedJoinDeviceId(d.config.firmSlug, snap.member_slug) &&
          inviteMacValid(local.invite_secret, joinMacBytes({ tid: d.identity.tenantId, activationId: snap.activation_id, deviceId: snap.device_id, signPublicKeyPem: snap.sign_pub, encPublicKeyPem: snap.enc_pub, memberSlug: snap.member_slug, role: snap.role }), x.mac);
        if (verified) snapshots.set(snap.id, snap);
        return {
          id: snap.id,
          name: local?.display_name ?? null,
          role: local?.role ?? snap.role,
          requested_at: x.created_at,
          check_code: snap.check_code,
          // 本机没有发过这个邀请（例如另一台管理员设备发出）：不能在这台电脑上批准
          local_invite: !!local,
          // 申请在传送中被改动过（HMAC、设备编号或角色核对不通过）：不要批准
          verified,
        };
      });
      return { invitations, join_requests: requests, firm_check_code: firmCheckCode(d.identity.tenantId, d.firm.rootPublicKeyPem) };
    },

    /** 批准：只用列表时核对过的快照（复核 A-01）；成员编号与角色取本机邀请记录；证书 + 律所公钥包 + 用秘密段对批准结果做的 HMAC。 */
    async approve(p: { join_request_id?: unknown }): Promise<Record<string, unknown>> {
      const call = requireCp(d);
      const id = String(p.join_request_id ?? "");
      const snap = snapshots.get(id);
      if (!snap) throw new DomainError("conflict", "请先刷新成员页、核对数字后再批准（只能批准核对通过的申请）", 409);
      const local = inviteOf(snap.activation_id);
      if (!local || local.status !== "open" || local.member_slug !== snap.member_slug || local.role !== snap.role) throw new DomainError("conflict", "这个邀请已处理过，或不是在这台电脑上发出的", 409);
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
        role: local.role as DeviceRole,
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
      const adminMac = inviteMac(local.invite_secret, approvalMacBytes({ tid: d.identity.tenantId, joinRequestId: snap.id, cert, rootPublicKeyPem: root.publicKeyPem, bundle }));
      const r = await call("POST", `/v1/join-requests/${id}/approve`, { cert, firm_bundle: bundle, admin_mac: adminMac });
      if (!r.ok) cpFail(r);
      d.db.tx(() => {
        d.db.run(`UPDATE member_invitations SET status = 'approved', device_id = ?, decided_at = ? WHERE activation_id = ?`, [snap.device_id, new Date(now).toISOString(), snap.activation_id]);
        d.db.run(`INSERT OR IGNORE INTO memberships (membership_id, tenant_id, user_id, role) VALUES (?, ?, ?, ?)`, [`membership_${snap.member_slug}`, d.identity.tenantId, userId, MEMBERSHIP_ROLE[local.role as Role]]);
      });
      snapshots.delete(id);
      d.audit("member.join_approve", "device", snap.device_id);
      return { ok: true, status: "approved" };
    },

    async reject(p: { join_request_id?: unknown }): Promise<Record<string, unknown>> {
      const call = requireCp(d);
      const id = String(p.join_request_id ?? "");
      if (!/^jr_[A-Za-z0-9_-]{16}$/.test(id)) throw new DomainError("not_found", "这个申请已处理或已过期，请刷新", 404);
      const r = await call("POST", `/v1/join-requests/${id}/reject`, {});
      if (!r.ok) cpFail(r);
      snapshots.delete(id);
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
      d.audit("member.invite_revoke", "invitation", id);
      return { ok: true };
    },
  };
};

/** 待激活模式下开放的内核方法（其余一律 not_activated）。第 14 批加“从备份恢复”。 */
export const ONBOARDING_METHODS: ReadonlySet<string> = new Set(["kernel.status", "onboarding.status", "onboarding.redeem", "onboarding.check", "onboarding.reset", "onboarding.restore", "device.env_probe"]);

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
export function removePendingWorkspace(dataRoot: string): void {
  rmSync(join(dataRoot, PENDING_WORKSPACE_SLUG), { recursive: true, force: true });
}
