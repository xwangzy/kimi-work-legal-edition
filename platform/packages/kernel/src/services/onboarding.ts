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
import { generateDeviceKeys, issueDeviceCertificate, signBytes, verifyBytes, verifyDeviceCertificate, type DeviceCertificate, type DeviceKeys, type DeviceRole } from "@zr-legal/keys";
import {
  firmBundleBytes,
  firmCheckCode,
  formatActivationCode,
  joinCheckCode,
  joinProofBytes,
  MEMBER_SLUG_PATTERN,
  normalizeActivationCode,
  validDisplayName,
  type FirmBundle,
} from "@zr-legal/firm-trust";
import { DomainError } from "@zr-legal/domain";
import { slog } from "@zr-legal/safe-log";
import { activationFilePath, PENDING_WORKSPACE_SLUG, type ActivationFile, type KernelConfig } from "../config.ts";
import { configureSecretSealing, getFirmRootPrivateKey, keysDirOf, readSecretFile, writeStagedSecret, type FirmIdentityRow } from "../devices.ts";
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
  join_request_id: string;
  keys: DeviceKeys;
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
    const code = normalizeActivationCode(p.code);
    if (!code) throw new DomainError("validation", "开通码是 20 位字母与数字（可带连字符），请核对后重新输入", 400);
    const r = await cpPost(this.d.relay, "/v1/activation/redeem", { code });
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

    // 成员：本机生成设备密钥，提交入组申请（只含公钥 + 持有证明）
    const keys = generateDeviceKeys();
    const deviceId = `dev_${firmSlug}_${memberSlug}`;
    const proof = signBytes(keys.signPrivateKeyPem, joinProofBytes({ tid: j.tid, activationId: j.activation_id, deviceId, signPublicKeyPem: keys.signPublicKeyPem, encPublicKeyPem: keys.encPublicKeyPem }));
    const jr = await cpPost(this.d.relay, "/v1/join-requests", {
      tid: j.tid,
      activation_id: j.activation_id,
      claim_secret: j.claim_secret,
      device_id: deviceId,
      sign_pub: keys.signPublicKeyPem,
      enc_pub: keys.encPublicKeyPem,
      proof,
    });
    if (!jr.ok || typeof jr.json.join_request_id !== "string") throw new DomainError("provider_unavailable", cpErrorText(jr.ok ? "reply_invalid" : jr.code), 502);
    writeStagedSecret(join(keysDir, "join-pending.json"), { tid: j.tid, activation_id: j.activation_id, claim_secret: j.claim_secret, join_request_id: jr.json.join_request_id, keys } satisfies JoinPending);
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
    if (!vr.ok || !same || !fbOk) {
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

  /** 放弃本机的待批准申请（被拒、换邀请码）。 */
  reset(): Record<string, unknown> {
    const p = this.pending();
    if (p) rmSync(join(this.keysDirFor(p.firm_slug), "join-pending.json"), { force: true });
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

/** 正常模式的成员管理（管理员设备）。 */
export const membersApi = (d: MembersDeps) => ({
  /** 邀请成员：本机先登记成员（姓名与角色以本机为准），再向中软申请一次性邀请码。 */
  async invite(p: { name?: unknown; role?: unknown }): Promise<Record<string, unknown>> {
    const call = requireCp(d);
    const name = typeof p.name === "string" ? p.name.trim() : "";
    if (!validDisplayName(name)) throw new DomainError("validation", "请填写成员姓名（1–40 个字符）", 400);
    const role = (typeof p.role === "string" && ROLES.includes(p.role as Role) ? p.role : "lawyer") as Role;
    const slug = `m-${randomBytes(5).toString("hex")}`;
    const r = await call("POST", "/v1/invitations", { member_slug: slug, name, role, ttl_hours: 72 });
    if (!r.ok) cpFail(r);
    const userId = `usr_${d.config.firmSlug}_${slug}`;
    d.db.tx(() => {
      d.db.run(`INSERT OR IGNORE INTO users (user_id, tenant_id, display_name) VALUES (?, ?, ?)`, [userId, d.identity.tenantId, name]);
      d.db.run(`INSERT OR IGNORE INTO memberships (membership_id, tenant_id, user_id, role) VALUES (?, ?, ?, ?)`, [`membership_${slug}`, d.identity.tenantId, userId, MEMBERSHIP_ROLE[role]]);
    });
    d.audit("member.invite", "member", userId);
    return { ok: true, code: formatActivationCode(String(r.json.code)), expires_at: r.json.expires_at, activation_id: r.json.activation_id, member: { name, role } };
  },

  /** 邀请与待批准申请（核对码由本机按申请里的公钥独立算出）。 */
  async list(): Promise<Record<string, unknown>> {
    const call = requireCp(d);
    const [inv, jr] = await Promise.all([call("GET", "/v1/invitations"), call("GET", "/v1/join-requests")]);
    if (!inv.ok) cpFail(inv);
    if (!jr.ok) cpFail(jr);
    const nameOf = (slug: string) => d.db.get<{ display_name: string }>(`SELECT display_name FROM users WHERE user_id = ?`, [`usr_${d.config.firmSlug}_${slug}`])?.display_name ?? null;
    const invitations = (inv.json.invitations as any[]).map((x) => ({
      activation_id: x.activation_id,
      name: nameOf(x.member?.slug) ?? x.member?.name ?? null,
      role: x.member?.role,
      status: x.status,
      created_at: x.created_at,
      expires_at: x.expires_at,
    }));
    const requests = (jr.json.join_requests as any[]).map((x) => ({
      id: x.id,
      name: nameOf(x.member_slug),
      role: x.role,
      requested_at: x.created_at,
      check_code: joinCheckCode({ tid: d.identity.tenantId, deviceId: x.device_id, signPublicKeyPem: x.sign_pub, encPublicKeyPem: x.enc_pub }),
      // 本机没有发过这个邀请（例如由另一台管理员设备发出）：不能在这台电脑上批准
      local_invite: nameOf(x.member_slug) !== null,
    }));
    return { invitations, join_requests: requests, firm_check_code: firmCheckCode(d.identity.tenantId, d.firm.rootPublicKeyPem) };
  },

  /** 批准：用本机律所根签发证书（成员编号与角色取本机邀请记录，不取申请自报）+ 律所公钥包。 */
  async approve(p: { join_request_id?: unknown }): Promise<Record<string, unknown>> {
    const call = requireCp(d);
    const id = String(p.join_request_id ?? "");
    const jr = await call("GET", "/v1/join-requests");
    if (!jr.ok) cpFail(jr);
    const item = (jr.json.join_requests as any[]).find((x) => x.id === id);
    if (!item) throw new DomainError("not_found", "这个申请已处理或已过期，请刷新", 404);
    const userId = `usr_${d.config.firmSlug}_${String(item.member_slug)}`;
    const local = d.db.get<{ role: string }>(`SELECT role FROM memberships WHERE tenant_id = ? AND user_id = ?`, [d.identity.tenantId, userId]);
    if (!local) throw new DomainError("conflict", "这个申请对应的邀请不是在这台电脑上发出的，请在发出邀请的电脑上批准", 409);
    const role: DeviceRole = ROLE_OF_MEMBERSHIP[local.role] ?? "lawyer";
    let root: { publicKeyPem: string; privateKeyPem: string };
    try {
      root = getFirmRootPrivateKey(d.keysDir);
    } catch {
      throw new DomainError("forbidden", "这台电脑不能批准新成员（需要在律所开通时的那台电脑上操作）", 409);
    }
    const now = Date.now();
    const cert = issueDeviceCertificate(root.privateKeyPem, {
      certId: `cert_${item.device_id}_${now.toString(36)}`,
      memberId: userId,
      deviceId: String(item.device_id),
      role,
      signPublicKeyPem: String(item.sign_pub),
      encPublicKeyPem: String(item.enc_pub),
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 365 * 24 * 3600 * 1000).toISOString(),
    });
    const bundle: FirmBundle = {
      recovery_public_key_pem: d.firm.recoveryPublicKeyPem,
      sig: signBytes(root.privateKeyPem, firmBundleBytes(d.identity.tenantId, root.publicKeyPem, d.firm.recoveryPublicKeyPem)),
    };
    const r = await call("POST", `/v1/join-requests/${id}/approve`, { cert, firm_bundle: bundle });
    if (!r.ok) cpFail(r);
    d.audit("member.join_approve", "device", String(item.device_id));
    return { ok: true, status: "approved" };
  },

  async reject(p: { join_request_id?: unknown }): Promise<Record<string, unknown>> {
    const call = requireCp(d);
    const id = String(p.join_request_id ?? "");
    if (!/^jr_[A-Za-z0-9_-]{16}$/.test(id)) throw new DomainError("not_found", "这个申请已处理或已过期，请刷新", 404);
    const r = await call("POST", `/v1/join-requests/${id}/reject`, {});
    if (!r.ok) cpFail(r);
    d.audit("member.join_reject", "join_request", id);
    return { ok: true, status: "rejected" };
  },

  async revokeInvitation(p: { activation_id?: unknown }): Promise<Record<string, unknown>> {
    const call = requireCp(d);
    const id = String(p.activation_id ?? "");
    if (!/^act_[A-Za-z0-9_-]{16}$/.test(id)) throw new DomainError("not_found", "没有这个邀请", 404);
    const r = await call("POST", `/v1/invitations/${id}/revoke`, {});
    if (!r.ok) cpFail(r);
    d.audit("member.invite_revoke", "invitation", id);
    return { ok: true };
  },
});

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
