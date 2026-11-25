/**
 * 账号会话的本机保存（第 44 批，主文 §2.5）：会话令牌是登录凭据，只进按数据库主密钥封装的 keys/account-session.json
 * （kwl-sealed/1，与认领凭据、设备私钥同一封装），不给渲染层、不进日志与诊断包；控制面请求由内核附在 x-kwl-session 头里经闸门发出。
 * 待激活时登录：先暂存进目标工作区的 keys/，内核按新身份重启后照常读到。
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readSecretFile, writeStagedSecret } from "./devices.ts";
import { cloudFailureText } from "./services/cloud-connection.ts";

export interface AccountSessionFile {
  v: 1;
  token: string;
  aid: string;
  email: string;
  name: string;
  tid: string;
  role: string;
  saved_at: string;
}

const FILE = "account-session.json";
const TOKEN_RE = /^kws1\.ses_[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/;

export function accountSessionPath(keysDir: string): string {
  return join(keysDir, FILE);
}

export function readAccountSession(keysDir: string): AccountSessionFile | null {
  const p = accountSessionPath(keysDir);
  if (!existsSync(p)) return null;
  try {
    const s = readSecretFile<AccountSessionFile>(p);
    return s && s.v === 1 && typeof s.token === "string" && TOKEN_RE.test(s.token) ? s : null;
  } catch {
    return null;
  }
}

export function writeAccountSession(keysDir: string, s: Omit<AccountSessionFile, "v" | "saved_at">): void {
  if (!TOKEN_RE.test(s.token)) throw new Error("会话令牌格式不对");
  writeStagedSecret(accountSessionPath(keysDir), { v: 1, ...s, saved_at: new Date().toISOString() } satisfies AccountSessionFile);
}

export function dropAccountSession(keysDir: string): void {
  rmSync(accountSessionPath(keysDir), { force: true });
}

/**
 * “要重新登录”的本机记录（第 64 批）：退出登录、会话失效、账号停用之后，这台电脑应当停在登录页——此前这个状态只在内核内存里，
 * 应用一重启、内核自动恢复或断网（同步补不上）就丢了，界面会把工作区露出来。记录里没有令牌，只有原因与上次账号的邮箱、姓名、角色
 * （登录页预填与称呼用），与会话同一封装（kwl-sealed/1）；重新登录成功即删。
 */
export interface LoginRequiredFile {
  v: 1;
  reason: string;
  email: string;
  name: string;
  role: string;
  at: string;
}

const LOGIN_REQUIRED_FILE = "account-login-required.json";

export function loginRequiredPath(keysDir: string): string {
  return join(keysDir, LOGIN_REQUIRED_FILE);
}

export function readLoginRequired(keysDir: string): LoginRequiredFile | null {
  const p = loginRequiredPath(keysDir);
  if (!existsSync(p)) return null;
  try {
    const s = readSecretFile<LoginRequiredFile>(p);
    // 字段逐项按类型与长度核对（被改过的记录宁可不认，也不让登录页因为怪值出错）
    const str = (v: unknown, max: number) => typeof v === "string" && v.length <= max;
    return s && s.v === 1 && typeof s.reason === "string" && SESSION_PROBLEM_CODES.has(s.reason) && str(s.email, 254) && str(s.name, 80) && str(s.role, 40) && str(s.at, 40) && Number.isFinite(Date.parse(s.at)) ? s : null;
  } catch {
    return null;
  }
}

export function writeLoginRequired(keysDir: string, x: { reason: string; email?: string | null; name?: string | null; role?: string | null }): void {
  if (!SESSION_PROBLEM_CODES.has(x.reason)) return;
  writeStagedSecret(loginRequiredPath(keysDir), { v: 1, reason: x.reason, email: x.email ?? "", name: x.name ?? "", role: x.role ?? "", at: new Date().toISOString() } satisfies LoginRequiredFile);
}

export function dropLoginRequired(keysDir: string): void {
  rmSync(loginRequiredPath(keysDir), { force: true });
}

/** 控制面答复里表示“要重新登录”的错误代码。 */
export const SESSION_PROBLEM_CODES: ReadonlySet<string> = new Set(["session_required", "session_invalid", "session_expired", "account_disabled", "session_member_mismatch"]);

/**
 * 模型调用被法律模型网关**确定地**按身份拒绝 → 本机“要重新登录”的原因代码（第 47 批，第 46 批遗留 11）。
 * 与控制面同步用同一口径（SESSION_PROBLEM_CODES 里的代码，写进同一个 accountProblem）：
 * - account_disabled（控制面拒发额度租约 403，网关以 402 + 该代码转告）→ account_disabled；
 * - seat_session_inactive（网关 401：控制面订阅把这台设备列为暂停——退出登录、会话过期、账号停用）→ session_invalid；
 * - 网关若直接给出 session_* / account_disabled 代码，照用。
 * 其余一律 null：额度（402 quota_*）、限流 429、5xx、网络错误、授权续期中（seat_unavailable）、席位或设备被收回（seat_*_revoked，
 * 走席位收回的口径，不是重新登录能解决的）——这些都不改登录状态。
 * 输入是网关错误代码，或带“[kwl:代码]”的错误说明；只认代码，不按中文说明猜。纯函数。
 */
export function identityRejectionOf(codeOrMessage: string | null | undefined): string | null {
  const s = String(codeOrMessage ?? "");
  const tagged = /\[kwl:([a-z0-9_]{1,60})\]/.exec(s)?.[1];
  const codes = tagged ? [tagged] : (s.match(/(?<![a-z0-9_])(?:account_disabled|seat_session_inactive|session_(?:required|invalid|expired|member_mismatch))(?![a-z0-9_])/g) ?? []);
  for (const c of codes) {
    if (c === "seat_session_inactive") return "session_invalid";
    if (SESSION_PROBLEM_CODES.has(c)) return c;
  }
  return null;
}

/**
 * 刚重新登录后的宽限（毫秒）：网关的“暂停设备”名单来自控制面订阅（缺省每 30 秒刷新），重新登录后的头一段时间里网关可能还按旧名单
 * 回 seat_session_inactive——这时不把律师再踢回登录框（否则登录→被拒→再登录来回打转）。account_disabled 是控制面当场核的，不设宽限。
 */
export const SESSION_REJECTION_GRACE_MS = 60_000;

/**
 * 模型请求被拒后要不要切到“要重新登录”（第 47 批）：identityRejectionOf 认出的身份拒绝；但 session_invalid（网关 seat_session_inactive）
 * 在重新登录后 SESSION_REJECTION_GRACE_MS 内不算。msSinceLogin = 距本机上次重新登录成功的毫秒数（没有重新登录过传 Infinity）。纯函数。
 */
export function modelRejectionProblem(codeOrMessage: string | null | undefined, msSinceLogin: number): string | null {
  const code = identityRejectionOf(codeOrMessage);
  if (code === "session_invalid" && msSinceLogin < SESSION_REJECTION_GRACE_MS) return null;
  return code;
}

/** 账号接口错误代码 → 律师看得懂的一句话。 */
export function accountErrorText(code: string, fallback?: string): string {
  // 第 52 批（IP 部署）：控制面通道的证书校验（cp_tls_*）与安装包连接配置（cp_upstream_*）单独说，不落到“请稍后重试”
  const cloud = cloudFailureText(code);
  if (cloud) return cloud;
  switch (code) {
    case "auth_invalid":
      return fallback ?? "邮箱或密码不正确";
    case "account_locked":
      return fallback ?? "密码错误次数过多，请稍后再试，或找回密码";
    case "account_disabled":
      return "账号已停用，请联系律所管理员或中软客服";
    case "registration_closed":
      return "暂不开放自助注册，请联系中软开通";
    case "code_required":
      return "现在只能凭邀请码注册：请填写邀请码（或律所发给你的开通码）";
    case "code_invalid":
      return "邀请码、开通码或验证码不正确或已失效，请核对后重新输入";
    // ─── 第 62 批：注册邀请码与短信验证码 ───
    case "invite_exhausted":
      return "这个邀请码已用完，请向发码人重新获取";
    case "invite_expired":
      return "这个邀请码已过期，请向发码人重新获取";
    case "invite_disabled":
      return "这个邀请码已停用，请向发码人重新获取";
    case "phone_invalid":
      return "手机号格式不对：请填写 11 位中国大陆手机号";
    case "phone_required":
      return "请填写手机号并获取短信验证码";
    case "phone_taken":
      return fallback ?? "这个手机号已注册，请直接登录（忘记密码可用手机号找回）";
    case "sms_code_required":
      return "请填写短信验证码";
    case "sms_code_invalid":
      return fallback ?? "验证码不正确，请核对后重新输入";
    case "sms_code_expired":
      return "验证码已过期或已使用，请重新获取";
    case "sms_code_attempts":
      return "验证码输错次数过多，请重新获取";
    case "sms_too_frequent":
      return fallback ?? "验证码已发送，请稍后再重新获取";
    case "sms_daily_limit":
      return "这个手机号今天获取验证码的次数已达上限，请明天再试";
    case "sms_ip_limit":
    case "sms_daily_total_limit":
    case "sms_provider_throttled":
      return "获取验证码过于频繁，请稍后再试";
    case "sms_phone_rejected":
      return "这个手机号收不到验证码，请换一个手机号";
    case "sms_timeout":
    case "sms_network_error":
      return "短信发送超时，请稍后重试";
    case "sms_disabled":
    case "sms_not_configured":
      return "短信验证暂不可用，请联系中软客服";
    // ─── 第 63 批：验证码登录与绑定手机号 ───
    case "sms_login_disabled":
      return "手机号验证码登录暂未开放，请用邮箱和密码登录";
    case "phone_not_registered":
      return "这个手机号还没有注册账号。新用户请先注册；已用邮箱注册的，请用密码登录后在“设置 → 账号”绑定手机号";
    case "phone_same":
      return "这个手机号已经绑定在你的账号上";
    case "sms_probe_limit":
      return "获取验证码过于频繁，请一小时后再试";
    case "sms_dry_run_restricted":
      return "短信服务处于测试模式，暂时不能用验证码登录、找回密码或绑定手机号，请联系中软客服";
    case "member_only":
      return "这是中软平台人员账号，不能在律师端使用";
    case "sms_purpose_invalid":
      return "客户端与云端版本不一致，请升级客户端后再试";
    case "sms_auth_failed":
    case "sms_ip_blocked":
    case "sms_balance_insufficient":
    case "sms_sign_invalid":
    case "sms_template_invalid":
    case "sms_provider_error":
      return "短信服务暂时不可用，请稍后重试；仍不行请联系中软客服";
    case "email_invalid":
      return "邮箱格式不对";
    case "email_taken":
      return "这个邮箱已注册，请直接登录（忘记密码可找回）";
    case "member_taken":
      return "这份邀请对应的成员已有账号：请用那个账号登录";
    case "password_weak":
      return fallback ?? "密码太弱：至少 10 位，同时包含字母和数字";
    case "name_invalid":
      return "请填写姓名（1–40 个字符）";
    case "session_required":
    case "session_invalid":
    case "session_expired":
      return "登录已失效，请重新登录";
    case "device_mismatch":
      return "这台电脑已登记为本所另一位成员：请用那位成员的账号登录";
    case "device_limit":
      return "账号的设备数已满：请先在别的电脑上解绑一台，或请管理员调高上限";
    // 第 66 批（V40，D-292）：个人账号新电脑自动登记的几种失败
    case "device_enroll_hold":
      return "短时间内有多台新电脑登录这个账号，为安全起见已暂停自动登记：请用账号绑定的手机号接收验证码确认是本人";
    case "session_not_fresh":
      return "登录已超过 10 分钟：请重新登录后再登记这台电脑";
    case "device_auto_unavailable":
      return "这个账号的新电脑需要律所管理员批准：请重新登录按提示申请";
    case "sms_phone_mismatch":
      return "手机号与账号绑定的不一致";
    case "rate_limited":
      return "尝试过于频繁，请一分钟后再试";
    case "license_expired":
      return "律所订阅已到期，请联系中软续订";
    case "cp_not_configured":
    case "gate_unavailable":
    case "cp_unreachable":
    case "cp_timeout":
      return "连不上中软服务，请检查网络后重试";
    case "client_outdated":
      return clientOutdatedText(fallback);
    case "staff_client_forbidden":
      return "这是中软平台人员账号，请在网页控制台登录";
    default:
      return fallback ?? "没有完成，请稍后重试；仍不行请联系客服";
  }
}

/** 客户端版本过旧（控制面 426 client_outdated，主文 §2.5）：写出要升级到的版本；控制面没给版本号时不编造。 */
export function clientOutdatedText(minVersion?: string | null): string {
  const v = typeof minVersion === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,32})?$/.test(minVersion) ? minVersion : null;
  return v ? `客户端版本过旧，请升级到 ${v} 或以上` : "客户端版本过旧，请升级到最新版本";
}

/** 第 62 批：短信频控类（429）与短信服务类（502，云端或短信平台的问题）的代码。 */
const SMS_THROTTLE_CODES: ReadonlySet<string> = new Set(["sms_too_frequent", "sms_daily_limit", "sms_ip_limit", "sms_daily_total_limit", "sms_provider_throttled", "sms_probe_limit"]);
const SMS_SERVICE_CODES: ReadonlySet<string> = new Set(["sms_disabled", "sms_not_configured", "sms_login_disabled", "sms_dry_run_restricted", "sms_auth_failed", "sms_ip_blocked", "sms_balance_insufficient", "sms_sign_invalid", "sms_template_invalid", "sms_provider_error", "sms_timeout", "sms_network_error"]);

/**
 * 账号接口失败 → HTTP 状态、错误类别与律师话（第 46 批：待激活模式 onboarding.accountCall 与正常模式 account.* 共用这一处，口径不再分叉）。
 * 控制面原话只在密码规则、锁定剩余时间这类场合采用；client_outdated 用控制面给出的最低版本号。原始代码只进 detail.reason 与日志。
 */
export function accountFailure(code: string, cpMessage?: string | null, extra?: { min_version?: string | null; retry_after_s?: number | null }): { status: number; fault: "validation" | "rate_limited" | "provider_unavailable"; text: string; reason: string } {
  const c = /^[a-z0-9_]{1,60}$/.test(code) ? code : "error";
  const status =
    c === "auth_invalid" || c.startsWith("session_")
      ? 401
      : c === "account_locked"
        ? 423
        : c === "rate_limited" || SMS_THROTTLE_CODES.has(c)
          ? 429
          : c === "email_taken" || c === "member_taken" || c === "phone_taken" || c === "phone_same" || c === "invite_exhausted"
            ? 409
            : c === "account_disabled" || c === "registration_closed" || c === "code_required" || c === "staff_client_forbidden" || c === "invite_disabled" || c === "member_only"
              ? 403
              : c === "phone_not_registered"
                ? 404
              : c === "client_outdated"
                ? 426
                : c.startsWith("cp_") || c === "gate_unavailable" || SMS_SERVICE_CODES.has(c)
                  ? 502
                  : 400;
  // 第 63 批：改密码、换绑手机号时核对的是“当前密码”（云端原话），不能说成“邮箱或密码不正确”
  const useCp = typeof cpMessage === "string" && cpMessage !== "" && (c === "password_weak" || c === "account_locked" || (c === "auth_invalid" && /^(?:当前密码不正确|密码不正确)$/.test(cpMessage)));
  // 第 62 批：重发间隔按云端给的秒数说；验证码不对时说还能试几次（云端原话只在这两处采用）
  const wait = Number.isSafeInteger(extra?.retry_after_s) && (extra!.retry_after_s as number) > 0 ? (extra!.retry_after_s as number) : null;
  // 第 63 批：绑定手机号时被别的账号占用（云端原话“已绑定在别的账号上”），不能说成“请直接登录”
  const smsText =
    c === "sms_too_frequent" && wait
      ? `验证码已发送，请 ${wait} 秒后再重新获取`
      : c === "sms_code_invalid" && typeof cpMessage === "string" && /^验证码不正确（还可再试 \d 次）$/.test(cpMessage)
        ? cpMessage
        : c === "phone_taken" && typeof cpMessage === "string" && /^这个手机号已绑定在别的账号上[^<>]{0,40}$/.test(cpMessage)
          ? cpMessage
          : undefined;
  const text = c === "client_outdated" ? clientOutdatedText(extra?.min_version ?? null) : accountErrorText(c, useCp ? cpMessage! : smsText);
  return { status, fault: status === 502 ? "provider_unavailable" : status === 429 ? "rate_limited" : "validation", text, reason: c };
}

/**
 * 登录后这台电脑不能直接继续的状态（控制面 onboarding.state）→ 一句律师话（第 46 批：待激活模式与正常模式的登录共用）。
 * admin = 登录的是律所管理员本人（批准新电脑、调高上限都要管理员在自己的电脑上做）。
 */
export function onboardingStateText(state: string, o: { admin?: boolean } = {}): string {
  switch (state) {
    case "device_limit":
      return o.admin
        ? "这个账号的电脑数已满：请先在已登录的电脑上（设置 → 账号与团队 → 登录过的电脑）移除一台，或调高本所成员的电脑数上限"
        : "这个账号的电脑数已满：请先在已登录的电脑上（设置 → 账号与团队 → 登录过的电脑）移除一台，或请律所管理员调高上限";
    case "device_mismatch":
      return "这台电脑已登记为本所另一位成员：请用那位成员的账号登录";
    case "waiting_founder":
    case "needs_founder_setup":
      return "你的律所还没有完成开通：请律所负责人先在自己的电脑上登录完成开通";
    case "needs_device_join":
      return "这个账号还没有登记这台电脑：请用这台电脑原来登录的账号；要换人使用，请律所管理员处理";
    // 第 66 批（V40，D-292）：个人账号的新电脑由云端直接登记（不用另一台电脑批准）；正常模式下遇到即说明换到这台电脑怎么做
    case "needs_device_auto":
      return "这台电脑还没有用这个账号登录过：退出后在登录页重新登录，会自动登记为你的电脑（不需要别的电脑批准；这台电脑上的资料与别的电脑各自独立）";
    case "ready":
      return "这台电脑已登记为你的电脑，但这里没有找到对应的本机资料：请用“从备份恢复”找回；没有备份的，请律所管理员停用这台电脑的旧登记后重新加入";
    default:
      return "这台电脑暂时不能用这个账号继续，请联系客服";
  }
}

/** 席位令牌取不到时的发起阻断原因（第 55 批 K3；审计 B 5.3）：按最近一次同步“取席位令牌”那一步的结果码说清原因与办法。 */
export const SEAT_NONE_REASON = "本所席位已用完或还没有给你分配席位：请联系律所管理员释放闲置席位或增购席位，分到席位后联网即可继续（经标准端点的推理与联网检索暂不可用）";
export const SEAT_REVOKED_REASON = "你的席位已被律所收回：请联系律所管理员重新分配席位（经标准端点的推理与联网检索暂不可用）";
export const SEAT_PENDING_REASON = "席位令牌未取得或已失效（联网后自动续期）：经标准端点的推理与联网检索暂不可用";

/** seatStep：控制面同步报告里 steps.seat 的值（如 "no_seat"、"seat_revoked"、"cp_unreachable"；没同步过为 null）。纯函数。 */
export function seatBlockReason(seatStep: string | null | undefined): string {
  if (seatStep === "no_seat") return SEAT_NONE_REASON;
  if (seatStep === "seat_revoked") return SEAT_REVOKED_REASON;
  return SEAT_PENDING_REASON;
}

/**
 * 非账号的控制面调用（用量、上限、律所策略、操作记录）失败 → 律师话（第 46 批：原来写“控制面：<代码>”）。
 * 不认识的代码一律说“中软服务暂时不可用，请稍后重试”；原始代码只进日志与诊断。
 */
export function controlPlaneErrorText(code: string, o: { min_version?: string | null } = {}): string {
  const cloud = cloudFailureText(code);
  if (cloud) return cloud;
  switch (code) {
    case "no_seat":
      return "你还没有席位：请律所管理员先分配席位";
    case "rate_limited":
      return "操作过于频繁，请稍后再试";
    case "cap_invalid":
      return "月度上限须为 1–100 的整数百分比";
    case "cp_not_configured":
    case "gate_unavailable":
    case "cp_unreachable":
    case "cp_timeout":
      return "连不上中软服务，请检查网络后重试";
    case "device_auth_stale":
      return "这台电脑的时间与标准时间相差太多，中软服务拒绝了请求：请把系统时间设为自动同步后重试";
    case "admin_required":
    case "firm_role_required":
      return "这项操作需要律所管理员在自己的电脑上完成";
    case "device_revoked":
      return "这台电脑已被律所停用，不能再使用中软服务";
    case "license_expired":
      return "律所订阅已到期，请联系中软续订";
    case "client_outdated":
      return clientOutdatedText(o.min_version ?? null);
    case "staff_client_forbidden":
      return "这是中软平台人员账号，请在网页控制台登录";
    // 第 56 批（真实流程验收）：律所策略草稿被规则拒绝时，原先一律说“中软服务暂时不可用”——管理员以为服务坏了，其实是没签名或草稿过时
    case "admin_threshold_not_met":
      return "这份草稿放宽了规则，要管理员先在自己的电脑上确认签名才能发布（团队版 1 人，律所版 2 人）";
    case "draft_published":
      return "这份草稿已经发布过了：刷新后看当前生效的策略";
    case "draft_stale":
      return "已有更新的策略发布了，这份草稿已过时：请重新起草";
    case "draft_unknown":
      return "找不到这份草稿：可能已被撤下，请刷新后重新起草";
    default:
      return "中软服务暂时不可用，请稍后重试";
  }
}

/** 规则类拒绝（不是服务故障）：界面按“这件事现在不能做”提示，不提示“稍后重试”。 */
export const CP_RULE_REJECTIONS: ReadonlySet<string> = new Set(["admin_threshold_not_met", "draft_published", "draft_stale", "draft_unknown"]);
