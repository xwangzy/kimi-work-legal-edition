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
    default:
      return fallback ?? "没有完成，请稍后重试；仍不行请联系客服";
  }
}
