/**
 * 平台人员（第 46 批，契约 §2.1）：中软运营、财务、客服、系统管理员与律师走同一套账号机制（邮箱唯一跨两表、scrypt、会话 kws1.、
 * 锁定 10 次 / 15 分钟锁 15 分钟、一次性码），但记录分开：人员没有律所、不能登录桌面客户端、不能调成员接口；成员账号不能获得平台角色。
 *
 * - 会话：网页，闲置 30 分钟、绝对 12 小时；邮箱 + 密码正确即发会话（第 53 批 D-218 取消两步验证与受限会话，也不再按来源 IP 限制）。
 * - 危险操作仍要本会话 10 分钟内用密码复核过（REAUTH_MS）。
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
}

export const STAFF_SESSION_IDLE_MS = 30 * 60_000;
export const STAFF_SESSION_ABS_MS = 12 * 3600_000;
/** 复核有效期：危险操作要求本会话 10 分钟内用密码复核过。 */
export const REAUTH_MS = 10 * 60_000;
export const STAFF_ID_RE = /^stf_[A-Za-z0-9_-]{16}$/;

export const isStaffId = (aid: string): boolean => aid.startsWith("stf_");

export function staffView(s: StaffRecord) {
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
