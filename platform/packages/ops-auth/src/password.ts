/**
 * 运营“账号 + 密码”登录（网页运营控制台；替代把私钥文件拖进浏览器）。
 *
 * 身份与权限仍以安全管理员签名的运营名册为准（运营编号、权限、状态；名册里的人可以没有公钥）——密码只是登录凭据：
 * - **凭据库**（文件，0600，原子写）：每位运营一条 {运营编号, 登录名, scrypt 哈希, 须改密码, 更新时刻, 停用}；由安全管理员用
 *   `ops-cli password set / reset / disable` 维护（初始密码只打印一次、首次登录须改），控制面只在运营本人改密码时写回；
 *   文件被命令行改写后控制面自动重读（与名册同一方式），重置或停用即令此人已有的登录失效。
 * - **会话**：令牌 `kwlops_<会话编号>.<随机串>` 只在登录应答里出现一次，服务端只存随机串的 SHA-256、只在内存（重启即需重新登录）；
 *   闲置 30 分钟、绝对 8 小时；退出即吊销；改密码吊销此人其他会话。每个请求仍按当前名册核验此人在册、有效与权限（吊销即时生效）。
 * - **防暴力**：同一登录名 15 分钟内失败 5 次锁 15 分钟（不存在的登录名同样计数、同样锁，响应不泄露账号是否存在）；另按来源每分钟限 10 次；
 *   对外一律“账号或密码不对”，不区分没有这个账号 / 密码错 / 已停用 / 不在名册。
 * 密码 = 单因素（知道密码）：靠锁定与按来源限流兜底（D-218 起生产入口不再按来源 IP 准入，没有运维网段）；需要更强时接名册的 second_factor（双因素接口）。
 * 本文件不 import index.ts（index.ts 再导出本文件）。
 */
import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export const OPS_CREDENTIALS_FORMAT = "kwl-ops-credentials/1";
/** 登录名：小写字母或数字开头，3–64 位小写字母、数字与 . _ @ -（可以是邮箱）。 */
export const OPS_LOGIN_RE = /^[a-z0-9][a-z0-9._@-]{2,63}$/;
export const OPS_SESSION_IDLE_MS = 30 * 60_000;
export const OPS_SESSION_ABS_MS = 8 * 3600_000;
export const OPS_LOGIN_MAX_FAILURES = 5;
export const OPS_LOGIN_WINDOW_MS = 15 * 60_000;
export const OPS_LOGIN_LOCK_MS = 15 * 60_000;
export const OPS_LOGIN_PER_SOURCE_PER_MINUTE = 10;
const OPERATOR_RE = /^op_[0-9]{4,12}$/;
const MAX_CREDENTIALS = 500;
const MAX_SESSIONS_PER_OPERATOR = 5;
const MAX_SESSIONS = 2000;
/** scrypt 参数与律师账号（control-plane accounts.ts）一致：N=2^15, r=8, p=1, 64 字节，每条 16 字节盐，NFKC。 */
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 } as const;
const WEAK = new Set(["password1234", "password12345", "qwerty123456", "admin1234567", "admin123456789", "123456789abc", "abc123456789", "1qaz2wsx3edc", "passw0rd1234", "kimiwork1234", "operator1234", "zaq12wsxcde3"]);

export interface OpsPasswordHash {
  alg: "scrypt";
  n: number;
  r: number;
  p: number;
  salt: string;
  hash: string;
}

export interface OpsCredential {
  operator: string;
  login: string;
  hash: OpsPasswordHash;
  /** 初始密码或被重置后：首次登录须先改密码（只能改密码、看本人身份、退出）。 */
  must_change: boolean;
  updated_at: string;
  disabled?: boolean;
}

export interface OpsCredentialsDoc {
  format: typeof OPS_CREDENTIALS_FORMAT;
  credentials: OpsCredential[];
}

const keysOf = (x: object) => Object.keys(x).sort().join(",");
const isoOk = (v: unknown): v is string => typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v));
const sha256 = (s: string) => createHash("sha256").update(s).digest();

/** 登录名规范化（去首尾空白、NFKC、小写）；不合规返回 null。 */
export function normalizeOpsLogin(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.normalize("NFKC").trim().toLowerCase();
  return OPS_LOGIN_RE.test(s) ? s : null;
}

/** 运营密码问题清单（空 = 合格）：至少 12 位、字母 + 数字、不含登录名、不是常见弱口令、不是同一字符重复。 */
export function opsPasswordProblems(pw: unknown, login?: string | null): string[] {
  if (typeof pw !== "string" || pw.length === 0) return ["请输入密码"];
  const out: string[] = [];
  if (pw.length < 12) out.push("至少 12 位");
  if (pw.length > 128) out.push("不超过 128 位");
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) out.push("同时包含字母和数字");
  const name = (login ?? "").split("@")[0]!;
  if (name.length >= 3 && pw.toLowerCase().includes(name.toLowerCase())) out.push("不要包含登录名");
  if (WEAK.has(pw.toLowerCase())) out.push("太常见，换一个");
  if (/^(.)\1+$/.test(pw)) out.push("不要用同一个字符重复");
  return out;
}

export function hashOpsPassword(pw: string): OpsPasswordHash {
  const salt = randomBytes(16);
  const hash = scryptSync(pw.normalize("NFKC"), salt, 64, SCRYPT);
  return { alg: "scrypt", n: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString("base64url"), hash: hash.toString("base64url") };
}

/** 没有这条凭据时也算一次（恒定时间：响应时间不泄露登录名是否存在）。 */
let dummy: OpsPasswordHash | null = null;
export function verifyOpsPassword(pw: unknown, h: OpsPasswordHash | null): boolean {
  dummy ??= hashOpsPassword("dummy-ops-password-for-timing-0");
  const target = h ?? dummy;
  let got: Buffer;
  try {
    got = scryptSync(String(typeof pw === "string" ? pw : "").normalize("NFKC"), Buffer.from(target.salt, "base64url"), 64, { N: target.n, r: target.r, p: target.p, maxmem: SCRYPT.maxmem });
  } catch {
    return false;
  }
  const want = Buffer.from(target.hash, "base64url");
  return h !== null && got.length === want.length && timingSafeEqual(got, want);
}

/** 初始密码：20 位（4 组 × 5，去掉易混的 0 O 1 l I），保证同时有字母和数字；只由命令行打印一次。 */
const PW_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
export function generateOpsPassword(): string {
  for (;;) {
    const chars = Array.from({ length: 20 }, () => PW_ALPHABET[randomInt(PW_ALPHABET.length)]!);
    const pw = [0, 5, 10, 15].map((i) => chars.slice(i, i + 5).join("")).join("-");
    if (opsPasswordProblems(pw).length === 0) return pw;
  }
}

const hashOk = (h: unknown): h is OpsPasswordHash => {
  const x = h as OpsPasswordHash;
  return (
    !!x &&
    typeof x === "object" &&
    keysOf(x) === "alg,hash,n,p,r,salt" &&
    x.alg === "scrypt" &&
    // 参数有上下限：凭据库被改坏也不能拿 scrypt 拖垮服务
    [16384, 32768, 65536].includes(x.n) &&
    x.r === 8 &&
    x.p === 1 &&
    typeof x.salt === "string" &&
    /^[A-Za-z0-9_-]{16,64}$/.test(x.salt) &&
    typeof x.hash === "string" &&
    /^[A-Za-z0-9_-]{86}$/.test(x.hash)
  );
};

/** 凭据库逐项校验：不合规返回原因代码。 */
export function validateOpsCredentials(x: unknown): string | null {
  const d = x as OpsCredentialsDoc;
  if (!d || typeof d !== "object" || Array.isArray(d) || keysOf(d) !== "credentials,format") return "credentials_malformed";
  if (d.format !== OPS_CREDENTIALS_FORMAT) return "credentials_format_unknown";
  if (!Array.isArray(d.credentials) || d.credentials.length > MAX_CREDENTIALS) return "credentials_malformed";
  const ops = new Set<string>();
  const logins = new Set<string>();
  for (const c of d.credentials) {
    if (!c || typeof c !== "object") return "credentials_malformed";
    const k = keysOf(c);
    if (k !== "hash,login,must_change,operator,updated_at" && k !== "disabled,hash,login,must_change,operator,updated_at") return "credentials_malformed";
    if (typeof c.operator !== "string" || !OPERATOR_RE.test(c.operator) || ops.has(c.operator)) return "credentials_operator_invalid";
    if (typeof c.login !== "string" || !OPS_LOGIN_RE.test(c.login) || logins.has(c.login)) return "credentials_login_invalid";
    ops.add(c.operator);
    logins.add(c.login);
    if (!hashOk(c.hash) || typeof c.must_change !== "boolean" || !isoOk(c.updated_at)) return "credentials_malformed";
    if (c.disabled !== undefined && typeof c.disabled !== "boolean") return "credentials_malformed";
  }
  // 登录名不能是别人的运营编号（登录时运营编号也可当登录名用）
  for (const c of d.credentials) if (OPERATOR_RE.test(c.login) && c.login !== c.operator && ops.has(c.login)) return "credentials_login_invalid";
  return null;
}

export const emptyOpsCredentials = (): OpsCredentialsDoc => ({ format: OPS_CREDENTIALS_FORMAT, credentials: [] });

/** 读凭据库：没有文件 = 空库（没有人能用密码登录）；读得到却不合规即抛错。 */
export function readOpsCredentialsFile(file: string): OpsCredentialsDoc {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return emptyOpsCredentials();
    throw new Error("凭据库读不出");
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error("凭据库不是 JSON");
  }
  const why = validateOpsCredentials(doc);
  if (why) throw new Error(`凭据库不合规：${why}`);
  return doc as OpsCredentialsDoc;
}

/** 原子写（随机临时名 + O_EXCL + fsync + 改名），0600；内容不合规即抛错、不写。 */
export function writeOpsCredentialsFile(file: string, doc: OpsCredentialsDoc): void {
  const why = validateOpsCredentials(doc);
  if (why) throw new Error(`凭据库不合规：${why}`);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(doc, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

/**
 * 设置某人的登录凭据（纯函数，返回新库）：没有就新建，有就换密码（登录名可改）；mustChange 为真即首次登录须改。
 * 登录名已被别人用、或是别人的运营编号即抛错。
 */
export function setOpsCredential(doc: OpsCredentialsDoc, o: { operator: string; login?: string; password: string; mustChange: boolean; now?: number }): OpsCredentialsDoc {
  if (!OPERATOR_RE.test(o.operator)) throw new Error("运营编号须为 op_ 加数字工号");
  const cur = doc.credentials.find((c) => c.operator === o.operator);
  const login = o.login !== undefined ? normalizeOpsLogin(o.login) : (cur?.login ?? null);
  if (!login) throw new Error("登录名须为 3–64 位小写字母、数字与 . _ @ -（以字母或数字开头）");
  const taken = doc.credentials.find((c) => c.login === login && c.operator !== o.operator);
  if (taken || (OPERATOR_RE.test(login) && login !== o.operator)) throw new Error(`登录名 ${login} 已被占用`);
  const rec: OpsCredential = { operator: o.operator, login, hash: hashOpsPassword(o.password), must_change: o.mustChange, updated_at: new Date(o.now ?? Date.now()).toISOString() };
  return { format: OPS_CREDENTIALS_FORMAT, credentials: [...doc.credentials.filter((c) => c.operator !== o.operator), rec].sort((a, b) => a.operator.localeCompare(b.operator)) };
}

/** 停用或恢复某人的密码登录（纯函数）；更新时刻随之变化，此人已有的登录即失效。 */
export function setOpsCredentialDisabled(doc: OpsCredentialsDoc, operator: string, disabled: boolean, now = Date.now()): OpsCredentialsDoc {
  const cur = doc.credentials.find((c) => c.operator === operator);
  if (!cur) throw new Error(`${operator} 没有登录凭据`);
  const { disabled: _drop, ...rest } = cur;
  void _drop;
  const rec: OpsCredential = { ...rest, updated_at: new Date(now).toISOString(), ...(disabled ? { disabled: true } : {}) };
  return { ...doc, credentials: doc.credentials.map((c) => (c.operator === operator ? rec : c)) };
}

export type OpsCredentialsState = { ok: true; doc: OpsCredentialsDoc } | { ok: false; reason: string };
export interface OpsCredentialSource {
  current(): OpsCredentialsState;
  /** 读最新内容 → 改 → 原子写回（写不进去即抛错，调用方按失败处理）。 */
  update(fn: (doc: OpsCredentialsDoc) => OpsCredentialsDoc): void;
}

/** 文件凭据库：文件有变化（inode、大小、修改时刻）或距上次读满 maxAgeMs 即重读；读不出或不合规时密码登录整体 503（不回退到空库）。 */
export function fileOpsCredentialSource(file: string, o: { maxAgeMs?: number; now?: () => number } = {}): OpsCredentialSource {
  const now = o.now ?? Date.now;
  const maxAge = o.maxAgeMs ?? 30_000;
  let cache: { stamp: string; at: number; state: OpsCredentialsState } | null = null;
  const stampOf = (): string => {
    try {
      const st = statSync(file);
      return `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    } catch {
      return "absent";
    }
  };
  const load = (): OpsCredentialsState => {
    try {
      return { ok: true, doc: readOpsCredentialsFile(file) };
    } catch {
      return { ok: false, reason: "credentials_unavailable" };
    }
  };
  return {
    current() {
      const stamp = stampOf();
      if (!cache || cache.stamp !== stamp || now() - cache.at >= maxAge) cache = { stamp, at: now(), state: load() };
      return cache.state;
    },
    update(fn) {
      const next = fn(readOpsCredentialsFile(file));
      writeOpsCredentialsFile(file, next);
      cache = { stamp: stampOf(), at: now(), state: { ok: true, doc: next } };
    },
  };
}

/** 内存凭据库（测试与进程内开发栈）。 */
export function memoryOpsCredentialSource(initial: OpsCredentialsDoc = emptyOpsCredentials()): OpsCredentialSource {
  let doc = initial;
  return {
    current: () => ({ ok: true, doc }),
    update(fn) {
      const next = fn(doc);
      const why = validateOpsCredentials(next);
      if (why) throw new Error(`凭据库不合规：${why}`);
      doc = next;
    },
  };
}

// ─── 会话 ──────────────────────────────────────────────────────────

interface SessionRecord {
  sid: string;
  operator: string;
  login: string;
  secret_hash: Buffer;
  /** 登录时凭据的更新时刻：凭据被重置、停用或改过（别处），此会话即失效。 */
  cred_stamp: string;
  created_at: number;
  last_at: number;
  expires_at: number;
}

export interface OpsSessionInfo {
  sid: string;
  operator: string;
  login: string;
  must_change: boolean;
  created_at: string;
  /** 绝对到期时刻（ISO）。 */
  expires_at: string;
  idle_ms: number;
}

export type OpsAttempt =
  | { ok: true; credential: OpsCredential }
  | { ok: false; reason: "throttled"; retry_after_ms: number; operator: string | null }
  | { ok: false; reason: "locked"; retry_after_ms: number; operator: string | null }
  | { ok: false; reason: "invalid"; operator: string | null; detail: string }
  | { ok: false; reason: "credentials_unavailable"; operator: null };

export type OpsChangeResult =
  | { ok: true; other_sessions_revoked: number }
  | { ok: false; reason: "session_invalid" | "current_wrong" | "locked" | "credentials_unavailable" }
  | { ok: false; reason: "weak"; rules: string[] };

export interface OpsPasswordSessions {
  readonly idleMs: number;
  readonly absMs: number;
  /** 核对登录名与密码（含限频与锁定）；不开会话。 */
  attempt(login: unknown, password: unknown, source: string): OpsAttempt;
  /** 按凭据开会话：令牌只在这里出现一次。 */
  open(c: OpsCredential): { token: string; info: OpsSessionInfo };
  /** 核验令牌（同时续闲置时限）；凭据被重置、停用或换了即失效。 */
  verify(token: unknown): { ok: true; info: OpsSessionInfo } | { ok: false; reason: string };
  close(sid: string): boolean;
  /** 吊销某人的全部会话（可留一个）；返回吊销数。 */
  closeOperator(operator: string, exceptSid?: string): number;
  /** 本人改密码：核当前密码（错了计入锁定）、新密码合规后写回凭据库，吊销此人其他会话。 */
  changePassword(sid: string, current: unknown, next: unknown): OpsChangeResult;
  credentials: OpsCredentialSource;
}

const TOKEN_RE = /^kwlops_([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/;
export const isOpsSessionToken = (v: unknown): v is string => typeof v === "string" && TOKEN_RE.test(v);

export function createOpsPasswordSessions(o: { credentials: OpsCredentialSource; now?: () => number; idleMs?: number; absMs?: number; maxFailures?: number; windowMs?: number; lockMs?: number; perSourcePerMinute?: number }): OpsPasswordSessions {
  const now = o.now ?? Date.now;
  const idleMs = o.idleMs ?? OPS_SESSION_IDLE_MS;
  const absMs = o.absMs ?? OPS_SESSION_ABS_MS;
  const maxFailures = o.maxFailures ?? OPS_LOGIN_MAX_FAILURES;
  const windowMs = o.windowMs ?? OPS_LOGIN_WINDOW_MS;
  const lockMs = o.lockMs ?? OPS_LOGIN_LOCK_MS;
  const perSource = o.perSourcePerMinute ?? OPS_LOGIN_PER_SOURCE_PER_MINUTE;
  const sessions = new Map<string, SessionRecord>();
  // 失败计数按登录名（规范化后；不合规的按原文摘要），不存在的登录名同样计数
  const fails = new Map<string, { at: number[]; locked_until: number }>();
  const sources = new Map<string, { minute: number; n: number }>();
  const credOf = (doc: OpsCredentialsDoc, key: string): OpsCredential | null => doc.credentials.find((c) => c.login === key) ?? (OPERATOR_RE.test(key) ? (doc.credentials.find((c) => c.operator === key) ?? null) : null);
  const failKey = (login: unknown) => normalizeOpsLogin(login) ?? `#${sha256(String(login ?? "")).toString("base64url").slice(0, 16)}`;
  const lockedFor = (key: string, t: number): number => {
    const f = fails.get(key);
    return f && f.locked_until > t ? f.locked_until - t : 0;
  };
  const noteFailure = (key: string, t: number) => {
    if (fails.size > 20_000) for (const [k, f] of fails) if (f.locked_until <= t && (f.at[f.at.length - 1] ?? 0) < t - windowMs) fails.delete(k);
    const f = fails.get(key) ?? { at: [], locked_until: 0 };
    f.at = [...f.at.filter((x) => x > t - windowMs), t];
    if (f.at.length >= maxFailures) {
      f.locked_until = t + lockMs;
      f.at = [];
    }
    fails.set(key, f);
  };
  const view = (s: SessionRecord, c: OpsCredential): OpsSessionInfo => ({ sid: s.sid, operator: s.operator, login: c.login, must_change: c.must_change, created_at: new Date(s.created_at).toISOString(), expires_at: new Date(s.expires_at).toISOString(), idle_ms: idleMs });
  const live = (s: SessionRecord, t: number) => s.expires_at > t && t - s.last_at < idleMs;
  const sweep = (t: number) => {
    for (const [k, s] of sessions) if (!live(s, t)) sessions.delete(k);
  };
  const closeOperator = (operator: string, exceptSid?: string): number => {
    let n = 0;
    for (const [k, s] of sessions)
      if (s.operator === operator && k !== exceptSid) {
        sessions.delete(k);
        n += 1;
      }
    return n;
  };
  const self: OpsPasswordSessions = {
    idleMs,
    absMs,
    credentials: o.credentials,
    attempt(login, password, source) {
      const t = now();
      const minute = Math.floor(t / 60_000);
      if (sources.size > 20_000) for (const [k, w] of sources) if (w.minute !== minute) sources.delete(k);
      const w = sources.get(source);
      if (!w || w.minute !== minute) sources.set(source, { minute, n: 1 });
      else if (++w.n > perSource) return { ok: false, reason: "throttled", retry_after_ms: (minute + 1) * 60_000 - t, operator: null };
      const key = failKey(login);
      const st = o.credentials.current();
      const cred = st.ok && normalizeOpsLogin(login) ? credOf(st.doc, normalizeOpsLogin(login)!) : null;
      const locked = lockedFor(key, t);
      if (locked > 0) return { ok: false, reason: "locked", retry_after_ms: locked, operator: cred?.operator ?? null };
      if (!st.ok) return { ok: false, reason: "credentials_unavailable", operator: null };
      // 恒定时间：没有这条凭据也算一次 scrypt
      const good = verifyOpsPassword(password, cred?.hash ?? null);
      if (!cred || !good || cred.disabled) {
        noteFailure(key, t);
        const detail = !cred ? "login_unknown" : !good ? "password_wrong" : "credential_disabled";
        const after = lockedFor(key, t);
        if (after > 0) return { ok: false, reason: "locked", retry_after_ms: after, operator: cred?.operator ?? null };
        return { ok: false, reason: "invalid", operator: cred?.operator ?? null, detail };
      }
      fails.delete(key);
      return { ok: true, credential: cred };
    },
    open(c) {
      const t = now();
      sweep(t);
      const mine = [...sessions.values()].filter((s) => s.operator === c.operator).sort((a, b) => a.created_at - b.created_at);
      while (mine.length >= MAX_SESSIONS_PER_OPERATOR) sessions.delete(mine.shift()!.sid);
      if (sessions.size >= MAX_SESSIONS) {
        const oldest = [...sessions.values()].sort((a, b) => a.last_at - b.last_at)[0];
        if (oldest) sessions.delete(oldest.sid);
      }
      const sid = randomBytes(12).toString("base64url");
      const secret = randomBytes(32).toString("base64url");
      const s: SessionRecord = { sid, operator: c.operator, login: c.login, secret_hash: sha256(secret), cred_stamp: c.updated_at, created_at: t, last_at: t, expires_at: t + absMs };
      sessions.set(sid, s);
      return { token: `kwlops_${sid}.${secret}`, info: view(s, c) };
    },
    verify(token) {
      const m = typeof token === "string" ? TOKEN_RE.exec(token.trim()) : null;
      if (!m) return { ok: false, reason: "session_malformed" };
      const s = sessions.get(m[1]!);
      const t = now();
      if (!s) return { ok: false, reason: "session_unknown" };
      const got = sha256(m[2]!);
      if (got.length !== s.secret_hash.length || !timingSafeEqual(got, s.secret_hash)) return { ok: false, reason: "session_unknown" };
      if (s.expires_at <= t) {
        sessions.delete(s.sid);
        return { ok: false, reason: "session_expired" };
      }
      if (t - s.last_at >= idleMs) {
        sessions.delete(s.sid);
        return { ok: false, reason: "session_idle" };
      }
      const st = o.credentials.current();
      if (!st.ok) return { ok: false, reason: "credentials_unavailable" };
      const c = st.doc.credentials.find((x) => x.operator === s.operator);
      // 命令行重置、停用或删掉了这条凭据（或登录名改了）：此会话作废
      if (!c || c.disabled || c.updated_at !== s.cred_stamp || c.login !== s.login) {
        sessions.delete(s.sid);
        return { ok: false, reason: "credential_changed" };
      }
      s.last_at = t;
      return { ok: true, info: view(s, c) };
    },
    close(sid) {
      return sessions.delete(sid);
    },
    closeOperator,
    changePassword(sid, current, next) {
      const s = sessions.get(sid);
      const t = now();
      if (!s || !live(s, t)) return { ok: false, reason: "session_invalid" };
      const st = o.credentials.current();
      if (!st.ok) return { ok: false, reason: "credentials_unavailable" };
      const c = st.doc.credentials.find((x) => x.operator === s.operator);
      if (!c || c.disabled || c.updated_at !== s.cred_stamp) return { ok: false, reason: "session_invalid" };
      const key = c.login;
      if (lockedFor(key, t) > 0) return { ok: false, reason: "locked" };
      if (!verifyOpsPassword(current, c.hash)) {
        noteFailure(key, t);
        return { ok: false, reason: lockedFor(key, t) > 0 ? "locked" : "current_wrong" };
      }
      const rules = opsPasswordProblems(next, c.login);
      if (typeof next === "string" && next === current) rules.push("不能与当前密码相同");
      if (rules.length) return { ok: false, reason: "weak", rules };
      let stamp = "";
      try {
        o.credentials.update((doc) => {
          const out = setOpsCredential(doc, { operator: c.operator, password: String(next), mustChange: false, now: t });
          stamp = out.credentials.find((x) => x.operator === c.operator)!.updated_at;
          return out;
        });
      } catch {
        return { ok: false, reason: "credentials_unavailable" };
      }
      s.cred_stamp = stamp;
      s.last_at = t;
      return { ok: true, other_sessions_revoked: closeOperator(c.operator, sid) };
    },
  };
  return self;
}
