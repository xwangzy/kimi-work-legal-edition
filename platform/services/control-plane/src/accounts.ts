/**
 * 我方自有账号（第 44 批，主文 §2）：邮箱 + 密码、会话、设备上限、个人上限。
 *
 * - 云端是身份、权限、额度的唯一可信来源；账号与律所成员一一对应（tid + 成员标识），设备证书仍由律所根签发。
 * - 密码 scrypt（N=2^15, r=8, p=1, 64 字节），每账号 16 字节盐；比对恒定时间；登录失败不区分“邮箱不存在 / 密码错”。
 * - 会话令牌 `kws1.<sid>.<secret>` 只在登录/注册应答里出现一次；服务端只存 SHA-256。桌面会话空闲 30 天、绝对 180 天；网页 12 小时 / 7 天。
 * - 一次性码（运营发的“设置密码码 / 重置码”、邮件验证码）只存 HMAC，过期或用过即作废。
 */
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export type AccountRole = "admin" | "partner" | "lawyer" | "assistant";

export interface PasswordHash {
  alg: "scrypt";
  n: number;
  r: number;
  p: number;
  salt: string;
  hash: string;
}

export interface AccountRecord {
  aid: string;
  email: string;
  name: string;
  status: "active" | "disabled";
  disabled_reason: string | null;
  tid: string;
  member_slug: string;
  role: AccountRole;
  /** null = 尚未设密码（运营代建、等本人用设置码设密码）。 */
  pw: PasswordHash | null;
  pw_changed_at: string | null;
  created_at: string;
  created_via: "self" | "founder_code" | "invite_code" | "ops";
  last_login_at: string | null;
  failed: { count: number; first_at: string | null; locked_until: string | null };
  device_limit: number | null;
  quota_limit: number | null;
}

export interface SessionRecord {
  sid: string;
  aid: string;
  secret_hash: string;
  kind: "desktop" | "web";
  device_id: string | null;
  created_at: string;
  last_seen_at: string;
  idle_expires_at: string;
  abs_expires_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
  client: { version: string | null; platform: string | null };
}

/** 一次性码（设置密码 / 重置密码 / 邮件验证码）：只存 HMAC。 */
export interface OneTimeCode {
  id: string;
  aid: string;
  purpose: "setup" | "reset" | "email_reset";
  mac: string;
  created_at: string;
  expires_at: string;
  attempts: number;
  used_at: string | null;
  by: string | null;
}

export class AuthError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown> | undefined;
  constructor(status: number, code: string, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const SESSION_IDLE_MS = { desktop: 30 * 24 * 3600_000, web: 12 * 3600_000 } as const;
export const SESSION_ABS_MS = { desktop: 180 * 24 * 3600_000, web: 7 * 24 * 3600_000 } as const;
export const LOCK_AFTER_FAILURES = 10;
export const LOCK_WINDOW_MS = 15 * 60_000;
export const LOCK_MS = 15 * 60_000;
export const MAX_DEVICES_PER_ACCOUNT = 9;

const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+$/;
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 } as const;
/** 常见弱口令（小写比较；只拦最常见的，规则另外要求字母 + 数字 + 10 位）。 */
const WEAK = new Set(["password123", "password1234", "qwerty123456", "1234567890a", "a1234567890", "abc1234567", "abcd123456", "admin123456", "zhangsan123", "woaini1314", "iloveyou123", "qwertyuiop1", "1qaz2wsx3edc", "passw0rd123", "kimiwork123"]);

export function normalizeEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const e = v.trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

/** 密码问题清单（空 = 合格）。 */
export function passwordProblems(pw: unknown, email?: string | null): string[] {
  if (typeof pw !== "string") return ["请输入密码"];
  const out: string[] = [];
  if (pw.length < 10) out.push("至少 10 位");
  if (pw.length > 128) out.push("不超过 128 位");
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) out.push("同时包含字母和数字");
  const local = email ? email.split("@")[0]! : "";
  if (local.length >= 3 && pw.toLowerCase().includes(local)) out.push("不要包含邮箱前缀");
  if (WEAK.has(pw.toLowerCase())) out.push("太常见，换一个");
  if (/^(.)\1+$/.test(pw)) out.push("不要用同一个字符重复");
  return out;
}

export function hashPassword(pw: string): PasswordHash {
  const salt = randomBytes(16);
  const hash = scryptSync(pw.normalize("NFKC"), salt, 64, SCRYPT);
  return { alg: "scrypt", n: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString("base64url"), hash: hash.toString("base64url") };
}

/** 没有密码哈希时也算一次（恒定时间：不让响应时间泄露“邮箱是否存在”）。 */
const DUMMY = hashPassword("dummy-password-for-timing-0");

export function verifyPassword(pw: unknown, h: PasswordHash | null): boolean {
  const target = h ?? DUMMY;
  const got = scryptSync(String(typeof pw === "string" ? pw : "").normalize("NFKC"), Buffer.from(target.salt, "base64url"), 64, { N: target.n, r: target.r, p: target.p, maxmem: SCRYPT.maxmem });
  const want = Buffer.from(target.hash, "base64url");
  return h !== null && got.length === want.length && timingSafeEqual(got, want);
}

export const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

export function newSessionToken(): { sid: string; secret: string; token: string } {
  const sid = newId("ses");
  const secret = randomBytes(32).toString("base64url");
  return { sid, secret, token: `kws1.${sid}.${secret}` };
}

export function parseSessionToken(v: unknown): { sid: string; secret: string } | null {
  if (typeof v !== "string" || v.length > 120) return null;
  const m = /^kws1\.(ses_[A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/.exec(v.trim());
  return m ? { sid: m[1]!, secret: m[2]! } : null;
}

/** 一次性码：12 位大写字母数字（去掉易混的 0 O 1 I L），显示为 4-4-4。 */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export function newOneTimeCode(): string {
  const b = randomBytes(12);
  let s = "";
  for (const x of b) s += CODE_ALPHABET[x % CODE_ALPHABET.length];
  return s;
}
export function normalizeOneTimeCode(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.toUpperCase().replace(/[\s-]/g, "");
  return /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{12}$/.test(s) ? s : /^[0-9]{6}$/.test(s) ? s : null;
}
export const formatOneTimeCode = (c: string): string => (c.length === 12 ? `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}` : c);
export const codeMac = (pepper: Buffer, purpose: string, aid: string, code: string): string => createHmac("sha256", pepper).update(`kwl-account-code/1\n${purpose}\n${aid}\n${code}`).digest("hex");
export function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export function validName(v: unknown): v is string {
  return typeof v === "string" && v.trim().length >= 1 && v.trim().length <= 40 && !/[\u0000-\u001f<>]/.test(v);
}

/** 由邮箱前缀生成成员标识 / 律所标识的基底（小写字母数字，3–20 位，不足补随机）。 */
export function slugBase(email: string): string {
  const local = email.split("@")[0]!.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16);
  return local.length >= 3 ? local : `u${randomBytes(3).toString("hex")}`;
}

export function sessionLive(s: SessionRecord, t: number): boolean {
  return !s.revoked_at && Date.parse(s.idle_expires_at) > t && Date.parse(s.abs_expires_at) > t;
}

export function locked(a: AccountRecord, t: number): number {
  const until = a.failed.locked_until ? Date.parse(a.failed.locked_until) : 0;
  return until > t ? Math.ceil((until - t) / 1000) : 0;
}

/** 登录失败记一次；同账号 15 分钟内 10 次锁 15 分钟。 */
export function noteFailure(a: AccountRecord, t: number): void {
  const first = a.failed.first_at ? Date.parse(a.failed.first_at) : 0;
  if (!first || t - first > LOCK_WINDOW_MS) a.failed = { count: 1, first_at: new Date(t).toISOString(), locked_until: null };
  else a.failed.count += 1;
  if (a.failed.count >= LOCK_AFTER_FAILURES) a.failed.locked_until = new Date(t + LOCK_MS).toISOString();
}

export function clientInfo(v: unknown): { version: string | null; platform: string | null } {
  const c = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const version = typeof c.version === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9a-z.]{1,20})?$/.test(c.version) ? c.version : null;
  const platform = typeof c.platform === "string" && /^(win32|darwin|linux|web)$/.test(c.platform) ? c.platform : null;
  return { version, platform };
}

/** 对外的账号视图（不含哈希与失败计数细节）。 */
export function accountView(a: AccountRecord, extra: { org?: { slug: string; name: string } } = {}) {
  return { aid: a.aid, email: a.email, name: a.name, role: a.role, status: a.status, tid: a.tid, member_slug: a.member_slug, has_password: a.pw !== null, created_at: a.created_at, last_login_at: a.last_login_at, ...(extra.org ? { org: extra.org } : {}) };
}

export function sessionView(s: SessionRecord, currentSid: string | null) {
  return { sid: s.sid, kind: s.kind, device_id: s.device_id, created_at: s.created_at, last_seen_at: s.last_seen_at, idle_expires_at: s.idle_expires_at, client: s.client, current: s.sid === currentSid };
}

/** 账号的第 n 台设备编号（n=1 沿用 dev_<律所>_<成员>；2–9 加 _D<n>：成员标识只许小写，大写 D 不会混淆）。 */
export function accountDeviceId(firmSlug: string, memberSlug: string, n: number): string {
  return n <= 1 ? `dev_${firmSlug}_${memberSlug}` : `dev_${firmSlug}_${memberSlug}_D${n}`;
}

/** 设备编号属于该成员的第几台（不属于 = 0）。 */
export function accountDeviceIndex(firmSlug: string, memberSlug: string, deviceId: string): number {
  const base = `dev_${firmSlug}_${memberSlug}`;
  if (deviceId === base) return 1;
  const m = /^_D([2-9])$/.exec(deviceId.slice(base.length));
  return deviceId.startsWith(base) && m ? Number(m[1]) : 0;
}
