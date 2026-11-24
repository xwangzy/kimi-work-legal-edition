/**
 * 注册管理（第 62 批；契约 docs/contract-b62-registration.md）：短信验证码记录、发送记录、平台注册邀请码与管理操作记录。
 *
 * - 平台注册邀请码在“开通码 / 邀请码”机制上演进（不另起一套）：同一个注册字段 `code`、同一个注册方式 `code`（仅凭码注册）、
 *   同一套 Crockford Base32 字母表与输入归一（忽略大小写、空格、连字符，I/L 读作 1、O 读作 0）、同一把胡椒做 HMAC 查找。
 *   长度 12 位（60 bit，显示 4-4-4）——比 20 位开通码好念好输；与 20 位开通码、36 位成员邀请码按长度区分，互不冲突。
 *   不同之处：开通码绑定已建好的律所（运营先开通租户），注册邀请码不绑律所——凭它注册即开一家试用律所（套餐、天数、席位可随批次设定）。
 * - 存储取舍：码的 HMAC 用于查找与比对（恒定时间）；另存 AES-256-GCM 密文（密钥由胡椒派生），供有 registration.manage 的运营
 *   再次查看、复制与导出 CSV——运营要把码交给渠道，只显示一次不够用；状态快照泄露时没有胡椒也解不开。只读权限只看打码的码。
 * - 原子占用：码的“已用次数 + 1”与建账号在同一段同步代码里完成（Node 单线程，中间没有 await），并发注册时第二个人看到“已用完”。
 */
import { createHmac, randomBytes } from "node:crypto";
import { maskPhone, openText, RegError, sealText, type SmsPurpose } from "./sms.ts";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const INVITE_CODE_LEN = 12;
const INVITE_AAD = "kwl-reg-invite/1";

export function newInviteCode(): string {
  let s = "";
  for (const b of randomBytes(INVITE_CODE_LEN)) s += CROCKFORD[b & 31];
  return s;
}

/** 输入归一（与开通码同一规则）；不是 12 位合法字符即 null。 */
export function normalizeInviteCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 64) return null;
  const s = input
    .toUpperCase()
    .replace(/[\s\-‐-―－]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (s.length !== INVITE_CODE_LEN) return null;
  for (const c of s) if (!CROCKFORD.includes(c)) return null;
  return s;
}

export const formatInviteCode = (c: string): string => c.replace(/(.{4})(?=.)/g, "$1-");
export const maskInviteCode = (c: string): string => `${c.slice(0, 4)}-****-${c.slice(-4)}`;
export const inviteCodeMac = (pepper: Buffer, code: string): string => createHmac("sha256", pepper).update(`kwl-reg-invite/1\n${code}`).digest("hex");

export interface InviteBatch {
  id: string;
  name: string;
  note: string | null;
  count: number;
  max_uses: number;
  expires_at: string | null;
  /** 凭本批的码注册时开通的试用规格（null = 用注册设置里的 trial_plan / trial_days / trial_seats）。 */
  plan: string | null;
  trial_days: number | null;
  trial_seats: number | null;
  created_at: string;
  created_by: string;
}

export interface InviteUse {
  at: string;
  aid: string;
  tid: string;
}

export interface InviteCode {
  id: string;
  batch_id: string;
  mac: string;
  sealed: string;
  max_uses: number;
  used: number;
  expires_at: string | null;
  status: "active" | "disabled";
  disabled_at: string | null;
  disabled_by: string | null;
  disabled_reason: string | null;
  created_at: string;
  uses: InviteUse[];
}

export type InviteStatus = "available" | "exhausted" | "expired" | "disabled";
export const INVITE_STATUSES: readonly InviteStatus[] = ["available", "exhausted", "expired", "disabled"];

export function inviteStatus(c: InviteCode, t: number): InviteStatus {
  if (c.status === "disabled") return "disabled";
  if (c.used >= c.max_uses) return "exhausted";
  if (c.expires_at && Date.parse(c.expires_at) <= t) return "expired";
  return "available";
}

/** 注册时对律师说的话（码本身无效统一说“不正确”，不区分“不存在”与“格式不对”）。 */
export const INVITE_REJECT: Readonly<Record<Exclude<InviteStatus, "available">, { status: number; code: string; message: string }>> = {
  exhausted: { status: 409, code: "invite_exhausted", message: "这个邀请码已用完，请向发码人重新获取" },
  expired: { status: 410, code: "invite_expired", message: "这个邀请码已过期，请向发码人重新获取" },
  disabled: { status: 403, code: "invite_disabled", message: "这个邀请码已停用，请向发码人重新获取" },
};

/** 短信验证码记录：只存 HMAC（绑定用途、手机号摘要与记录编号），一次性，过期或校验次数用完即作废。 */
export interface SmsCodeRecord {
  id: string;
  /** test = 运营的“发送测试短信”（只占发送额度，不能用来核对）。 */
  purpose: SmsPurpose | "test";
  phone_mac: string;
  mac: string;
  created_at: string;
  expires_at: string;
  attempts: number;
  used_at: string | null;
  /** 同一手机号同一用途又发了新码：旧码作废。 */
  superseded: boolean;
}

/** 发送记录（运营排查用；手机号打码，不含验证码）。 */
export interface SmsLogEntry {
  at: string;
  purpose: SmsPurpose | "test";
  phone: string;
  result: "sent" | "dry_run" | "failed";
  code: string | null;
  provider_code: string | null;
  by: string | null;
}

/** 注册管理的操作记录（配置变更、测试发送、策略、邀请码批次与停用；不含 AppKey 与完整手机号）。 */
export interface RegAuditEntry {
  at: string;
  actor: string;
  action: string;
  target: string | null;
  detail: Record<string, string | number | boolean | null> | null;
}

export const MAX_INVITES = 10_000;
const MAX_LOG = 500;
const MAX_AUDIT = 1000;

export interface RegistrationDump {
  v: 1;
  sms_codes: SmsCodeRecord[];
  sms_log: SmsLogEntry[];
  batches: InviteBatch[];
  invites: InviteCode[];
  audit: RegAuditEntry[];
}

/** 注册管理的状态（随控制面状态快照落盘；启动读回与失败回滚时整体重建）。 */
export class RegistrationBook {
  readonly smsCodes = new Map<string, SmsCodeRecord>();
  smsLog: SmsLogEntry[] = [];
  readonly batches = new Map<string, InviteBatch>();
  readonly invites = new Map<string, InviteCode>();
  readonly byMac = new Map<string, string>();
  audit: RegAuditEntry[] = [];

  clear(): void {
    this.smsCodes.clear();
    this.smsLog = [];
    this.batches.clear();
    this.invites.clear();
    this.byMac.clear();
    this.audit = [];
  }

  /** 读回（第 62 批之前的状态没有这一段：空）。 */
  load(raw: unknown): void {
    this.clear();
    const d = (raw && typeof raw === "object" ? raw : {}) as Partial<RegistrationDump>;
    for (const c of d.sms_codes ?? []) this.smsCodes.set(c.id, c);
    this.smsLog = Array.isArray(d.sms_log) ? d.sms_log.slice(0, MAX_LOG) : [];
    for (const b of d.batches ?? []) this.batches.set(b.id, b);
    for (const c of d.invites ?? []) {
      this.invites.set(c.id, c);
      this.byMac.set(c.mac, c.id);
    }
    this.audit = Array.isArray(d.audit) ? d.audit.slice(0, MAX_AUDIT) : [];
  }

  dump(): RegistrationDump {
    return { v: 1, sms_codes: [...this.smsCodes.values()], sms_log: this.smsLog, batches: [...this.batches.values()], invites: [...this.invites.values()], audit: this.audit };
  }

  note(e: RegAuditEntry): void {
    this.audit.unshift(e);
    if (this.audit.length > MAX_AUDIT) this.audit.length = MAX_AUDIT;
  }

  logSend(e: SmsLogEntry): void {
    this.smsLog.unshift(e);
    if (this.smsLog.length > MAX_LOG) this.smsLog.length = MAX_LOG;
  }

  /** 清掉 48 小时前的验证码记录（每日上限按北京时间自然日计，48 小时足够）。 */
  sweepCodes(t: number): void {
    for (const [k, c] of this.smsCodes) if (Date.parse(c.created_at) + 48 * 3600_000 < t) this.smsCodes.delete(k);
  }

  inviteByCode(pepper: Buffer, code: string): InviteCode | undefined {
    const id = this.byMac.get(inviteCodeMac(pepper, code));
    return id ? this.invites.get(id) : undefined;
  }
}

/** 解出码明文（有 registration.manage 的视图与导出用）。 */
export function inviteCodeText(c: InviteCode, sealKey: Buffer): string | null {
  return openText(sealKey, c.sealed, `${INVITE_AAD}\n${c.id}`);
}

const intOr = (v: unknown, lo: number, hi: number, code: string, what: string, dflt: number | null): number | null => {
  if (v === undefined || v === null) return dflt;
  if (!(typeof v === "number" && Number.isSafeInteger(v) && v >= lo && v <= hi)) throw new RegError(400, code, `${what}须为 ${lo}–${hi} 的整数`);
  return v;
};

/** 生成一批注册邀请码：返回批次与码明文（应答里给全；之后有 registration.manage 的也能再看）。 */
export function createInviteBatch(
  book: RegistrationBook,
  raw: Record<string, unknown>,
  o: { pepper: Buffer; sealKey: Buffer; by: string; t: number; planExists: (id: string) => boolean; newId: (prefix: string) => string },
): { batch: InviteBatch; codes: { id: string; code: string }[] } {
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (name.length < 1 || name.length > 40 || /[\u0000-\u001f<>]/.test(name)) throw new RegError(400, "batch_name_invalid", "批次名称须为 1–40 个字符");
  if (raw.note !== undefined && raw.note !== null && !(typeof raw.note === "string" && raw.note.length <= 200 && !/[\u0000-\u0008\u000b-\u001f<>]/.test(raw.note))) throw new RegError(400, "batch_note_invalid", "备注至多 200 个字符");
  const count = intOr(raw.count, 1, 1000, "batch_count_invalid", "数量", null);
  if (count === null) throw new RegError(400, "batch_count_invalid", "数量须为 1–1000 的整数");
  const maxUses = intOr(raw.max_uses, 1, 1000, "batch_max_uses_invalid", "每个码可用次数", 1)!;
  let expiresAt: string | null = null;
  if (raw.expires_at !== undefined && raw.expires_at !== null) {
    const ms = typeof raw.expires_at === "string" ? Date.parse(raw.expires_at) : NaN;
    if (!Number.isFinite(ms) || ms <= o.t || ms > o.t + 3650 * 86400_000) throw new RegError(400, "batch_expires_invalid", "有效期须为未来 10 年内的时刻（ISO 8601）");
    expiresAt = new Date(ms).toISOString();
  } else if (raw.ttl_days !== undefined && raw.ttl_days !== null) {
    expiresAt = new Date(o.t + intOr(raw.ttl_days, 1, 3650, "batch_expires_invalid", "有效天数", null)! * 86400_000).toISOString();
  }
  const plan = raw.plan === undefined || raw.plan === null || raw.plan === "" ? null : raw.plan;
  if (plan !== null && !(typeof plan === "string" && o.planExists(plan))) throw new RegError(400, "plan_unknown", "套餐不在目录里");
  const trialDays = intOr(raw.trial_days, 1, 365, "trial_days_invalid", "试用天数", null);
  const trialSeats = intOr(raw.trial_seats, 1, 50, "trial_seats_invalid", "试用席位", null);
  if (book.invites.size + count > MAX_INVITES) throw new RegError(409, "too_many_invites", `邀请码总数至多 ${MAX_INVITES} 个（现有 ${book.invites.size} 个）：请先清理不用的批次或减少数量`);
  const at = new Date(o.t).toISOString();
  const batch: InviteBatch = { id: o.newId("ivb"), name, note: typeof raw.note === "string" && raw.note.trim() ? raw.note.trim() : null, count, max_uses: maxUses, expires_at: expiresAt, plan: plan as string | null, trial_days: trialDays, trial_seats: trialSeats, created_at: at, created_by: o.by };
  book.batches.set(batch.id, batch);
  const out: { id: string; code: string }[] = [];
  while (out.length < count) {
    const code = newInviteCode();
    const mac = inviteCodeMac(o.pepper, code);
    if (book.byMac.has(mac)) continue;
    const id = o.newId("inv");
    const rec: InviteCode = { id, batch_id: batch.id, mac, sealed: sealText(o.sealKey, code, `${INVITE_AAD}\n${id}`), max_uses: maxUses, used: 0, expires_at: expiresAt, status: "active", disabled_at: null, disabled_by: null, disabled_reason: null, created_at: at, uses: [] };
    book.invites.set(id, rec);
    book.byMac.set(mac, id);
    out.push({ id, code });
  }
  return { batch, codes: out };
}

/** 一条邀请码的视图：plain = 解出的码；reveal = 给完整的码（registration.manage），否则只给打码。 */
export function inviteView(c: InviteCode, b: InviteBatch | undefined, t: number, plain: string | null, reveal: boolean) {
  return {
    id: c.id,
    code: plain && reveal ? formatInviteCode(plain) : null,
    code_masked: plain ? maskInviteCode(plain) : null,
    batch_id: c.batch_id,
    batch_name: b?.name ?? null,
    status: inviteStatus(c, t),
    max_uses: c.max_uses,
    used: c.used,
    remaining: Math.max(0, c.max_uses - c.used),
    expires_at: c.expires_at,
    plan: b?.plan ?? null,
    trial_days: b?.trial_days ?? null,
    trial_seats: b?.trial_seats ?? null,
    created_at: c.created_at,
    last_used_at: c.uses.at(-1)?.at ?? null,
    disabled_at: c.disabled_at,
    disabled_by: c.disabled_by,
    disabled_reason: c.disabled_reason,
  };
}

export function batchView(b: InviteBatch, book: RegistrationBook, t: number) {
  const counts: Record<InviteStatus, number> = { available: 0, exhausted: 0, expired: 0, disabled: 0 };
  let used = 0;
  for (const c of book.invites.values())
    if (c.batch_id === b.id) {
      counts[inviteStatus(c, t)] += 1;
      used += c.used;
    }
  return { ...b, used_total: used, by_status: counts };
}

export { maskPhone };
