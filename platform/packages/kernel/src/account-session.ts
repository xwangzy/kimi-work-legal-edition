/**
 * 账号会话的本机保存（第 44 批，主文 §2.5）：会话令牌是登录凭据，只进按数据库主密钥封装的 keys/account-session.json
 * （kwl-sealed/1，与认领凭据、设备私钥同一封装），不给渲染层、不进日志与诊断包；控制面请求由内核附在 x-kwl-session 头里经闸门发出。
 * 待激活时登录：先暂存进目标工作区的 keys/，内核按新身份重启后照常读到。
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readSecretFile, writeStagedSecret } from "./devices.ts";

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

/** 控制面答复里表示“要重新登录”的错误代码。 */
export const SESSION_PROBLEM_CODES: ReadonlySet<string> = new Set(["session_required", "session_invalid", "session_expired", "account_disabled", "session_member_mismatch"]);

/** 账号接口错误代码 → 律师看得懂的一句话。 */
export function accountErrorText(code: string, fallback?: string): string {
  switch (code) {
    case "auth_invalid":
      return "邮箱或密码不正确";
    case "account_locked":
      return fallback ?? "密码错误次数过多，请稍后再试，或找回密码";
    case "account_disabled":
      return "账号已停用，请联系律所管理员或中软客服";
    case "registration_closed":
      return "暂不开放自助注册，请联系中软开通";
    case "code_required":
      return "请输入律所发给你的开通码或邀请码";
    case "code_invalid":
      return "开通码、邀请码或验证码不正确或已失效";
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
    case "rate_limited":
      return "尝试过于频繁，请一分钟后再试";
    case "license_expired":
      return "律所订阅已到期，请联系中软续订";
    case "cp_not_configured":
    case "gate_unavailable":
    case "cp_unreachable":
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

/**
 * 账号接口失败 → HTTP 状态、错误类别与律师话（第 46 批：待激活模式 onboarding.accountCall 与正常模式 account.* 共用这一处，口径不再分叉）。
 * 控制面原话只在密码规则、锁定剩余时间这类场合采用；client_outdated 用控制面给出的最低版本号。原始代码只进 detail.reason 与日志。
 */
export function accountFailure(code: string, cpMessage?: string | null, extra?: { min_version?: string | null }): { status: number; fault: "validation" | "rate_limited" | "provider_unavailable"; text: string; reason: string } {
  const c = /^[a-z0-9_]{1,60}$/.test(code) ? code : "error";
  const status =
    c === "auth_invalid" || c.startsWith("session_")
      ? 401
      : c === "account_locked"
        ? 423
        : c === "rate_limited"
          ? 429
          : c === "email_taken" || c === "member_taken"
            ? 409
            : c === "account_disabled" || c === "registration_closed" || c === "code_required" || c === "staff_client_forbidden"
              ? 403
              : c === "client_outdated"
                ? 426
                : c.startsWith("cp_") || c === "gate_unavailable"
                  ? 502
                  : 400;
  const useCp = typeof cpMessage === "string" && cpMessage !== "" && (c === "password_weak" || c === "account_locked");
  const text = c === "client_outdated" ? clientOutdatedText(extra?.min_version ?? null) : accountErrorText(c, useCp ? cpMessage! : undefined);
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
        ? "这个账号的电脑数已满：请先在已登录的电脑上（设置 → 账号与团队 → 我的电脑）解绑一台，或调高本所成员的电脑数上限"
        : "这个账号的电脑数已满：请先在已登录的电脑上（设置 → 账号与团队 → 我的电脑）解绑一台，或请律所管理员调高上限";
    case "device_mismatch":
      return "这台电脑已登记为本所另一位成员：请用那位成员的账号登录";
    case "waiting_founder":
    case "needs_founder_setup":
      return "你的律所还没有完成开通：请律所负责人先在自己的电脑上登录完成开通";
    case "needs_device_join":
      return "这个账号还没有登记这台电脑：请用这台电脑原来登录的账号；要换人使用，请律所管理员处理";
    case "ready":
      return "这台电脑已登记为你的电脑，但这里没有找到对应的本机资料：请用“从备份恢复”找回；没有备份的，请律所管理员停用这台电脑的旧登记后重新加入";
    default:
      return "这台电脑暂时不能用这个账号继续，请联系客服";
  }
}

/**
 * 非账号的控制面调用（用量、上限、律所策略、操作记录）失败 → 律师话（第 46 批：原来写“控制面：<代码>”）。
 * 不认识的代码一律说“中软服务暂时不可用，请稍后重试”；原始代码只进日志与诊断。
 */
export function controlPlaneErrorText(code: string, o: { min_version?: string | null } = {}): string {
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
    default:
      return "中软服务暂时不可用，请稍后重试";
  }
}
