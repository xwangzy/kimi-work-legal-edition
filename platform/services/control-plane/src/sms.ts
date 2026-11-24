/**
 * 短信验证码通道（第 62 批：手机号验证码注册与找回密码；契约 docs/contract-b62-registration.md）。
 *
 * - 供应商：赛邮云 SUBMAIL v4（`/sms/xsend` 模板短信、`/balance/sms` 查余额、`/service/timestamp` 取服务器时间）。数字签名 md5：
 *   md5(appid + appkey + 按键名升序的 `键=值&…` + appid + appkey)；不参与计算的：signature、tag，以及 sign_version=2 时的 vars
 *   （赛邮云文档“API 授权与验证机制”；思路借鉴 MaaS new-api service/sms.go，代码独立实现）。时间戳须在 6 秒内送达：
 *   本机时钟偏差时（151 / 152）改取赛邮云服务器时间重试一次。
 * - AppKey 只写不回显：落在控制面状态里的是 AES-256-GCM 密文（密钥由开通码胡椒 HKDF 派生，与状态封装密钥分开），视图只给末 4 位。
 * - 本模块不写任何日志；验证码、AppKey、完整手机号都不进日志与审计（审计里的手机号一律打码）。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from "node:crypto";

/** 本批新增接口的错误（server.ts 统一映射为 HTTP 应答；与 PlanError 同一形状）。 */
export class RegError extends Error {
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

// ─── 手机号 ───

/** 中国大陆手机号归一：去空格、连字符、括号与 +86 / 0086 / 86 前缀，须为 1[3-9] 开头的 11 位；不合格为 null。 */
export function normalizePhone(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 32) return null;
  let s = v.replace(/[\s\-()（）]/g, "");
  if (s.startsWith("+86")) s = s.slice(3);
  else if (s.startsWith("0086")) s = s.slice(4);
  else if (s.length === 13 && s.startsWith("86")) s = s.slice(2);
  return /^1[3-9]\d{9}$/.test(s) ? s : null;
}

/** 打码：138****8000。 */
export const maskPhone = (p: string): string => (p.length >= 7 ? `${p.slice(0, 3)}****${p.slice(-4)}` : "****");

// ─── 密封（AES-256-GCM；aad 绑定用途，换个字段解不开） ───

export function sealText(key: Buffer, plain: string, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `s1.${Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url")}`;
}

export function openText(key: Buffer, sealed: unknown, aad: string): string | null {
  if (typeof sealed !== "string" || !sealed.startsWith("s1.")) return null;
  try {
    const b = Buffer.from(sealed.slice(3), "base64url");
    if (b.length < 29) return null;
    const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
    d.setAAD(Buffer.from(aad, "utf8"));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// ─── 设置 ───

export type SmsPurpose = "register" | "reset";
export const SMS_PURPOSES: readonly SmsPurpose[] = ["register", "reset"];

export interface SmsSettings {
  /** 总开关：关 = 不发任何验证码（注册要求手机号时须先关掉那一项）。 */
  enabled: boolean;
  provider: "submail";
  app_id: string | null;
  /** AppKey 密文（sealText，aad "kwl-sms-app-key/1"）；null = 未配置。只写不回显。 */
  app_key_sealed: string | null;
  /** AppKey 末 4 位（视图里的“尾号提示”）。 */
  app_key_hint: string | null;
  /** 短信签名（模板变量 sign_name：在赛邮云报备的签名文字，不带【】）。 */
  sign_name: string | null;
  /** 模板项目编号（赛邮云“短信模板”的项目标识）：注册、找回密码、登录（登录为预留，本批不开手机号登录）。 */
  projects: { register: string | null; reset: string | null; login: string | null };
  code_length: number;
  ttl_minutes: number;
  resend_seconds: number;
  daily_limit_per_phone: number;
  ip_hourly_limit: number;
  daily_total_limit: number;
  max_attempts: number;
  /** 不经短信、把验证码随应答返回（只给非生产部署联调；生产入口拒绝打开，见 server.ts allowDryRun）。 */
  dry_run: boolean;
  updated_at: string | null;
  updated_by: string | null;
}

export const DEFAULT_SMS: SmsSettings = {
  enabled: false,
  provider: "submail",
  app_id: null,
  app_key_sealed: null,
  app_key_hint: null,
  sign_name: null,
  projects: { register: null, reset: null, login: null },
  code_length: 6,
  ttl_minutes: 10,
  resend_seconds: 60,
  daily_limit_per_phone: 10,
  ip_hourly_limit: 20,
  daily_total_limit: 2000,
  max_attempts: 5,
  dry_run: false,
  updated_at: null,
  updated_by: null,
};

const LIMITS = {
  code_length: [4, 8, "验证码位数"],
  ttl_minutes: [1, 30, "有效期（分钟）"],
  resend_seconds: [30, 600, "重发间隔（秒）"],
  daily_limit_per_phone: [1, 50, "每个手机号每日上限"],
  ip_hourly_limit: [1, 1000, "每个来源地址每小时上限"],
  daily_total_limit: [1, 100_000, "全平台每日上限"],
  max_attempts: [1, 10, "单个验证码最多校验次数"],
} as const;

const APP_KEY_AAD = "kwl-sms-app-key/1";

/** 读回旧状态或缺字段时补齐缺省（不校验凭据是否可用）。 */
export function migrateSms(raw: unknown): SmsSettings {
  const b = (raw && typeof raw === "object" ? raw : {}) as Partial<SmsSettings>;
  const out: SmsSettings = { ...structuredClone(DEFAULT_SMS), ...b, projects: { ...DEFAULT_SMS.projects, ...(b.projects ?? {}) }, provider: "submail" };
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
    const v = (out as unknown as Record<string, unknown>)[k];
    if (!(typeof v === "number" && Number.isSafeInteger(v) && v >= lo && v <= hi)) (out as unknown as Record<string, unknown>)[k] = (DEFAULT_SMS as unknown as Record<string, unknown>)[k];
  }
  return out;
}

const PROJECT_RE = /^[0-9A-Za-z_-]{1,32}$/;
const APP_ID_RE = /^[0-9A-Za-z_-]{1,64}$/;
const APP_KEY_RE = /^[0-9A-Za-z_-]{8,128}$/;

/** 缺了哪些才能真实发送（注册用途）：空 = 齐。 */
export function smsMissing(s: SmsSettings, purpose: SmsPurpose | "test" = "register"): string[] {
  const m: string[] = [];
  if (!s.app_id) m.push("app_id");
  if (!s.app_key_sealed) m.push("app_key");
  if (!s.sign_name) m.push("sign_name");
  const proj = purpose === "test" ? s.projects.register : s.projects[purpose];
  if (!proj) m.push(`projects.${purpose === "test" ? "register" : purpose}`);
  return m;
}

/**
 * 运营改设置（PUT 的部分字段）→ 新设置。app_key 只写：给字符串即换（加密保存），给 null 或 "" 即清除，不给保持原样。
 * allowDryRun = 部署允许 dry-run（生产为 false：打开即拒绝）。启用且不是 dry-run 时须凭据、签名与注册模板齐全。
 */
export function validateSmsPatch(raw: unknown, prev: SmsSettings, o: { sealKey: Buffer; allowDryRun: boolean; by: string; at: string }): { next: SmsSettings; changed: string[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RegError(400, "sms_settings_invalid", "请求体须为对象");
  const b = raw as Record<string, unknown>;
  const next: SmsSettings = structuredClone(prev);
  const changed: string[] = [];
  const known = new Set(["enabled", "provider", "app_id", "app_key", "sign_name", "projects", "dry_run", ...Object.keys(LIMITS)]);
  for (const k of Object.keys(b)) if (!known.has(k)) throw new RegError(400, "sms_settings_invalid", `不认识的设置项：${k.slice(0, 40)}`);
  const bool = (k: "enabled" | "dry_run") => {
    if (!(k in b)) return;
    if (typeof b[k] !== "boolean") throw new RegError(400, "sms_settings_invalid", `${k} 须为 true 或 false`);
    if (next[k] !== b[k]) changed.push(k);
    next[k] = b[k] as boolean;
  };
  bool("enabled");
  bool("dry_run");
  if ("provider" in b && b.provider !== "submail") throw new RegError(400, "sms_provider_invalid", "短信供应商目前只支持 submail（赛邮云）");
  if ("app_id" in b) {
    const v = b.app_id === "" ? null : b.app_id;
    if (v !== null && !(typeof v === "string" && APP_ID_RE.test(v.trim()))) throw new RegError(400, "sms_app_id_invalid", "AppID 只允许字母、数字、下划线与连字符（1–64 位）");
    const nv = v === null ? null : (v as string).trim();
    if (nv !== next.app_id) changed.push("app_id");
    next.app_id = nv;
  }
  if ("app_key" in b) {
    const v = b.app_key === "" ? null : b.app_key;
    if (v !== null && !(typeof v === "string" && APP_KEY_RE.test(v.trim()))) throw new RegError(400, "sms_app_key_invalid", "AppKey 只允许字母、数字、下划线与连字符（8–128 位）");
    next.app_key_sealed = v === null ? null : sealText(o.sealKey, (v as string).trim(), APP_KEY_AAD);
    next.app_key_hint = v === null ? null : (v as string).trim().slice(-4);
    changed.push("app_key");
  }
  if ("sign_name" in b) {
    const v = b.sign_name === "" ? null : b.sign_name;
    if (v !== null && !(typeof v === "string" && v.trim().length >= 2 && v.trim().length <= 24 && !/[\u0000-\u001f<>【】]/.test(v))) throw new RegError(400, "sms_sign_name_invalid", "短信签名须为 2–24 个字符（在赛邮云报备的签名文字，不带【】）");
    const nv = v === null ? null : (v as string).trim();
    if (nv !== next.sign_name) changed.push("sign_name");
    next.sign_name = nv;
  }
  if ("projects" in b) {
    const p = b.projects;
    if (!p || typeof p !== "object" || Array.isArray(p)) throw new RegError(400, "sms_project_invalid", "projects 须为 { register, reset, login }");
    for (const [k, v0] of Object.entries(p as Record<string, unknown>)) {
      if (k !== "register" && k !== "reset" && k !== "login") throw new RegError(400, "sms_project_invalid", `不认识的模板用途：${k.slice(0, 20)}`);
      const v = v0 === "" ? null : v0;
      if (v !== null && !(typeof v === "string" && PROJECT_RE.test(v.trim()))) throw new RegError(400, "sms_project_invalid", "模板项目编号只允许字母、数字、下划线与连字符（1–32 位）");
      const nv = v === null ? null : (v as string).trim();
      if (nv !== next.projects[k]) changed.push(`projects.${k}`);
      next.projects[k] = nv;
    }
  }
  for (const [k, [lo, hi, what]] of Object.entries(LIMITS)) {
    if (!(k in b)) continue;
    const v = b[k];
    if (!(typeof v === "number" && Number.isSafeInteger(v) && v >= lo && v <= hi)) throw new RegError(400, "sms_limit_invalid", `${what}须为 ${lo}–${hi} 的整数`, { field: k });
    if ((next as unknown as Record<string, number>)[k] !== v) changed.push(k);
    (next as unknown as Record<string, number>)[k] = v;
  }
  if (next.dry_run && !o.allowDryRun) throw new RegError(409, "sms_dry_run_forbidden", "生产部署不能打开 dry-run（验证码不经短信、随应答返回）：请配置真实短信通道");
  if (next.enabled && !next.dry_run) {
    const miss = smsMissing(next, "register");
    if (miss.length) throw new RegError(400, "sms_incomplete", `启用短信前须先填好：${miss.join("、")}`, { missing: miss });
  }
  if (changed.length) {
    next.updated_at = o.at;
    next.updated_by = o.by;
  }
  return { next, changed };
}

/** 发送方式：live（真实发送）/ dry_run（只在允许的部署）；不能发送时给原因代码。 */
export function smsMode(s: SmsSettings, allowDryRun: boolean, purpose: SmsPurpose | "test"): { ok: true; mode: "live" | "dry_run" } | { ok: false; code: "sms_disabled" | "sms_not_configured" } {
  if (!s.enabled) return { ok: false, code: "sms_disabled" };
  if (s.dry_run && allowDryRun) return { ok: true, mode: "dry_run" };
  return smsMissing(s, purpose).length ? { ok: false, code: "sms_not_configured" } : { ok: true, mode: "live" };
}

/** 运营视图（不含 AppKey，只给是否已设与末 4 位）。 */
export function smsView(s: SmsSettings, allowDryRun: boolean) {
  const m = smsMode(s, allowDryRun, "register");
  return {
    enabled: s.enabled,
    provider: s.provider,
    app_id: s.app_id,
    app_key: { set: s.app_key_sealed !== null, hint: s.app_key_hint },
    sign_name: s.sign_name,
    projects: { ...s.projects },
    code_length: s.code_length,
    ttl_minutes: s.ttl_minutes,
    resend_seconds: s.resend_seconds,
    daily_limit_per_phone: s.daily_limit_per_phone,
    ip_hourly_limit: s.ip_hourly_limit,
    daily_total_limit: s.daily_total_limit,
    max_attempts: s.max_attempts,
    dry_run: s.dry_run,
    // 部署是否允许 dry-run；状态里开着、部署不允许（例如从测试环境搬来的状态）时视为关闭，控制台据此告警
    dry_run_allowed: allowDryRun,
    dry_run_blocked: s.dry_run && !allowDryRun,
    missing: smsMissing(s, "register"),
    available: m.ok,
    mode: m.ok ? m.mode : null,
    unavailable_reason: m.ok ? null : m.code,
    updated_at: s.updated_at,
    updated_by: s.updated_by,
  };
}

export function smsCreds(s: SmsSettings, sealKey: Buffer): SubmailCreds | null {
  if (!s.app_id || !s.app_key_sealed) return null;
  const k = openText(sealKey, s.app_key_sealed, APP_KEY_AAD);
  return k ? { app_id: s.app_id, app_key: k } : null;
}

/** 纯数字验证码（均匀随机）。 */
export function newSmsCode(len: number): string {
  return String(randomInt(0, 10 ** len)).padStart(len, "0");
}

// ─── 赛邮云 SUBMAIL v4 ───

export const SUBMAIL_BASE = "https://api-v4.mysubmail.com";

export interface SubmailCreds {
  app_id: string;
  app_key: string;
}

/** md5(appid + appkey + 排序参数串 + appid + appkey)；signature、tag 不参与，sign_version=2 时 vars 也不参与。 */
export function submailSignature(appId: string, appKey: string, params: Record<string, string>): string {
  const skip = new Set(["signature", "tag", ...(params.sign_version === "2" ? ["vars"] : [])]);
  const sorted = Object.keys(params)
    .filter((k) => !skip.has(k))
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return createHash("md5").update(`${appId}${appKey}${sorted}${appId}${appKey}`, "utf8").digest("hex");
}

/** 可排查的失败代码（运营看得到原因；对律师端由内核换成人话）。 */
export type SmsFailCode =
  | "sms_disabled"
  | "sms_not_configured"
  | "sms_auth_failed"
  | "sms_ip_blocked"
  | "sms_balance_insufficient"
  | "sms_sign_invalid"
  | "sms_template_invalid"
  | "sms_phone_rejected"
  | "sms_provider_throttled"
  | "sms_provider_error"
  | "sms_timeout"
  | "sms_network_error";

/** 赛邮云错误代码 → 本平台失败代码（赛邮云文档“API 错误代码”）。 */
export function submailFailCode(code: string): SmsFailCode {
  const n = Number(code);
  if ([903, 904, 905].includes(n)) return "sms_balance_insufficient";
  if (n === 113) return "sms_ip_blocked";
  if ([101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 119, 151, 152].includes(n)) return "sms_auth_failed";
  if ([116, 126, 127, 154, 401, 402, 411, 412, 413].includes(n)) return "sms_sign_invalid";
  if ([117, 118, 120, 305, 306, 307, 406, 407, 409, 417, 418, 420].includes(n)) return "sms_template_invalid";
  if ([114, 251, 252, 253].includes(n)) return "sms_phone_rejected";
  if ([115, 408, 901].includes(n)) return "sms_provider_throttled";
  return "sms_provider_error";
}

/** 失败代码 → HTTP 状态与运营 / 网页看的说明（律师端另由内核换成更短的人话）。 */
export const SMS_FAIL: Readonly<Record<SmsFailCode, { status: number; message: string }>> = {
  sms_disabled: { status: 503, message: "短信验证暂未开放，请联系中软客服" },
  sms_not_configured: { status: 503, message: "短信服务未配置，暂时不能发送验证码，请联系中软客服" },
  sms_auth_failed: { status: 503, message: "短信服务暂时不可用（短信平台凭据或签名校验未通过），请联系中软客服" },
  sms_ip_blocked: { status: 503, message: "短信服务暂时不可用（服务器地址不在短信平台白名单），请联系中软客服" },
  sms_balance_insufficient: { status: 503, message: "短信服务暂时不可用（短信余额不足），请联系中软客服" },
  sms_sign_invalid: { status: 503, message: "短信服务暂时不可用（短信签名未通过审核或格式不对），请联系中软客服" },
  sms_template_invalid: { status: 503, message: "短信服务暂时不可用（短信模板不存在或未通过审核），请联系中软客服" },
  sms_phone_rejected: { status: 400, message: "这个手机号收不到验证码（号码无效或已退订），请换一个手机号" },
  sms_provider_throttled: { status: 429, message: "这个手机号接收验证码过于频繁，请稍后再试" },
  sms_provider_error: { status: 503, message: "短信服务暂时不可用，请稍后重试" },
  sms_timeout: { status: 504, message: "短信发送超时，请稍后重试" },
  sms_network_error: { status: 502, message: "连不上短信平台，请稍后重试" },
};

export interface SubmailOptions {
  base?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

export type SubmailResult = { ok: true; json: Record<string, unknown> } | { ok: false; code: SmsFailCode; provider_code: string | null };

async function submailFetch(url: string, init: RequestInit, o: SubmailOptions): Promise<{ ok: true; json: Record<string, unknown> } | { ok: false; code: "sms_timeout" | "sms_network_error" | "sms_provider_error" }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? 10_000);
  try {
    const r = await (o.fetchImpl ?? globalThis.fetch)(url, { ...init, redirect: "error", signal: ac.signal });
    const text = (await r.text()).slice(0, 64 * 1024);
    try {
      const json = JSON.parse(text) as unknown;
      return json && typeof json === "object" ? { ok: true, json: json as Record<string, unknown> } : { ok: false, code: "sms_provider_error" };
    } catch {
      return { ok: false, code: "sms_provider_error" };
    }
  } catch {
    return { ok: false, code: ac.signal.aborted ? "sms_timeout" : "sms_network_error" };
  } finally {
    clearTimeout(timer);
  }
}

/** 赛邮云签名 POST（表单编码）。时间戳被拒（151 / 152，本机时钟偏差）时改用赛邮云服务器时间重试一次。 */
export async function submailPost(path: "/sms/xsend" | "/balance/sms", fields: Record<string, string>, creds: SubmailCreds, o: SubmailOptions = {}): Promise<SubmailResult> {
  const base = (o.base ?? SUBMAIL_BASE).replace(/\/+$/, "");
  const attempt = async (timestamp: string): Promise<SubmailResult> => {
    const params: Record<string, string> = { appid: creds.app_id, ...fields, sign_type: "md5", timestamp, ...(path === "/sms/xsend" ? { sign_version: "2" } : {}) };
    const body = new URLSearchParams({ ...params, signature: submailSignature(creds.app_id, creds.app_key, params) }).toString();
    const r = await submailFetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }, o);
    if (!r.ok) return { ok: false, code: r.code, provider_code: null };
    if (String(r.json.status ?? "").toLowerCase() === "success") return { ok: true, json: r.json };
    const pc = r.json.code === undefined || r.json.code === null ? null : String(r.json.code).slice(0, 12);
    return { ok: false, code: pc ? submailFailCode(pc) : "sms_provider_error", provider_code: pc };
  };
  const first = await attempt(String(Math.floor((o.now?.() ?? Date.now()) / 1000)));
  if (first.ok || (first.provider_code !== "151" && first.provider_code !== "152")) return first;
  const ts = await submailFetch(`${base}/service/timestamp`, { method: "GET" }, o);
  const t = ts.ok ? Number(ts.json.timestamp) : NaN;
  return Number.isSafeInteger(t) && t > 0 ? attempt(String(t)) : first;
}

/** 发验证码（模板变量：code、sign_name、time = “10分钟”）。 */
export function submailSendCode(creds: SubmailCreds, m: { to: string; project: string; code: string; signName: string; ttlMinutes: number }, o?: SubmailOptions): Promise<SubmailResult> {
  return submailPost("/sms/xsend", { to: m.to, project: m.project, vars: JSON.stringify({ code: m.code, sign_name: m.signName, time: `${m.ttlMinutes}分钟` }) }, creds, o);
}

/** 查余额（不发短信）：balance = 通用短信余额，transactional_balance = 事务类短信余额（条）。 */
export async function submailBalance(creds: SubmailCreds, o?: SubmailOptions): Promise<{ ok: true; balance: number | null; transactional_balance: number | null } | { ok: false; code: SmsFailCode; provider_code: string | null }> {
  const r = await submailPost("/balance/sms", {}, creds, o);
  if (!r.ok) return r;
  const num = (v: unknown) => (v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  return { ok: true, balance: num(r.json.balance), transactional_balance: num(r.json.transactional_balance) };
}
