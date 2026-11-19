/**
 * 平台人员（第 46 批，契约 §2.1）：中软运营、财务、客服、系统管理员与律师走同一套账号机制（邮箱唯一跨两表、scrypt、会话 kws1.、
 * 锁定 10 次 / 15 分钟锁 15 分钟、一次性码），但记录分开：人员没有律所、不能登录桌面客户端、不能调成员接口；成员账号不能获得平台角色。
 *
 * - 会话：网页，闲置 30 分钟、绝对 12 小时；未绑定两步验证且策略要求时发受限会话（只能看本人、绑定、退出）。
 * - 两步验证：TOTP 密钥与恢复码 HMAC 存在控制面状态里（状态快照整体封装加密）。
 */
import type { FailureCounter, PasswordHash } from "./accounts.ts";
import { permsOf, type PlatformRole } from "./rbac.ts";

export interface StaffRecord extends FailureCounter {
  aid: string;
  email: string;
  name: string;
  roles: PlatformRole[];
  status: "active" | "disabled";
  disabled_reason: string | null;
  /** null = 尚未设密码（新建、引导、找回后等本人用设置码设）。 */
  pw: PasswordHash | null;
  pw_changed_at: string | null;
  created_at: string;
  /** 建档者：人员编号，或 "bootstrap" / "recovery" / "dev"。 */
  created_by: string;
  last_login_at: string | null;
  mfa: {
    totp: { secret: string; enabled_at: string; last_step: number | null } | null;
    /** 正在绑定（setup 之后、enable 之前）；15 分钟内有效。 */
    pending: { secret: string; created_at: string } | null;
    /** 恢复码的 HMAC（用过即删）。 */
    recovery: string[];
  };
}

export type StaffMfaPolicy = "required" | "optional";

export const STAFF_SESSION_IDLE_MS = 30 * 60_000;
export const STAFF_SESSION_ABS_MS = 12 * 3600_000;
/** 复核有效期：危险操作要求本会话 10 分钟内复核过。 */
export const REAUTH_MS = 10 * 60_000;
/** 密码对了之后换会话的一次性票据：5 分钟、至多试 5 次。 */
export const MFA_TOKEN_MS = 5 * 60_000;
export const MFA_PENDING_MS = 15 * 60_000;
export const STAFF_ID_RE = /^stf_[A-Za-z0-9_-]{16}$/;

export const isStaffId = (aid: string): boolean => aid.startsWith("stf_");

export function staffView(s: StaffRecord, policy: StaffMfaPolicy) {
  return {
    aid: s.aid,
    email: s.email,
    name: s.name,
    roles: [...s.roles],
    perms: permsOf(s.roles),
    status: s.status,
    disabled_reason: s.disabled_reason,
    has_password: s.pw !== null,
    created_at: s.created_at,
    created_by: s.created_by,
    last_login_at: s.last_login_at,
    mfa: { enabled: s.mfa.totp !== null, required: policy === "required", recovery_left: s.mfa.recovery.length },
  };
}

/** 客户端版本号比较（数字点分；后缀不参与比较）。 */
export function compareVersion(x: string, y: string): number {
  const px = x.split(/[.-]/).map((n) => Number(n) || 0);
  const py = y.split(/[.-]/).map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) if ((px[i] ?? 0) !== (py[i] ?? 0)) return (px[i] ?? 0) - (py[i] ?? 0);
  return 0;
}
export const SEMVER_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
