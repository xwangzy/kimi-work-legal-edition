/**
 * 平台人员的角色与权限（第 46 批，契约 §2.2）。
 *
 * - 权限名沿用 ops-auth 的 OPS_PERMISSIONS（support / relay / notify 的名册仍用那一套，这里不改它），另加读权限按域拆分与人员权限。
 * - 角色 → 权限是固定表；一人 1–3 个角色；客户运营与开通专员互斥（沿用“开通租户 ⟂ 发创始开通码”的职责分离，D-106）。
 * - 危险操作（人员、系统设置、路由写、终止订阅、整体删除）要求 10 分钟内复核过（server.ts opsRoute）。
 */
import type { OpsPermission } from "@zr-legal/ops-auth";

export const CP_EXTRA_PERMISSIONS = ["account.read", "usage.read", "billing.read", "route.read", "system.read", "staff.manage", "settings.manage", "account.support"] as const;
export type CpPermission = OpsPermission | (typeof CP_EXTRA_PERMISSIONS)[number];

export const READ_PERMISSIONS: readonly CpPermission[] = ["tenant.read", "account.read", "usage.read", "billing.read", "route.read", "system.read"];

export const PLATFORM_ROLES = ["sysadmin", "operator", "issuer", "finance", "support", "viewer"] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const ROLE_TABLE: Readonly<Record<PlatformRole, { label: string; note: string; perms: readonly CpPermission[] }>> = {
  sysadmin: { label: "系统管理员", note: "人员与权限、系统设置、模型与路由、整体删除；可看全部", perms: ["staff.manage", "settings.manage", "route.manage", "tenant.purge", ...READ_PERMISSIONS] },
  operator: {
    label: "客户运营",
    note: "律所开通与续订、套餐与额度、账号与设备；不能发创始开通码",
    perms: ["tenant.manage", "tenant.terminate", "quota.manage", "quota.cap", "plan.manage", "account.manage", "account.support", "device.revoke", "tenant.read", "account.read", "usage.read", "billing.read", "route.read"],
  },
  issuer: { label: "开通专员", note: "发与作废创始开通码；看律所与账号", perms: ["activation.issue", "tenant.read", "account.read"] },
  finance: { label: "财务", note: "看律所、用量与账单", perms: ["tenant.read", "usage.read", "billing.read"] },
  support: { label: "客服", note: "帮律师解锁、发重置码、强制下线；看律所、账号与用量", perms: ["account.support", "tenant.read", "account.read", "usage.read"] },
  viewer: { label: "只读", note: "看全部，不能改", perms: [...READ_PERMISSIONS] },
};

/** 互斥的角色对。 */
export const ROLE_CONFLICTS: readonly (readonly [PlatformRole, PlatformRole])[] = [["operator", "issuer"]];

/** 危险权限：持有它的写操作要求复核。 */
export const DANGER_PERMISSIONS: ReadonlySet<CpPermission> = new Set<CpPermission>(["staff.manage", "settings.manage", "route.manage", "tenant.terminate", "tenant.purge"]);

export function permsOf(roles: readonly string[]): CpPermission[] {
  const out = new Set<CpPermission>();
  for (const r of roles) for (const p of ROLE_TABLE[r as PlatformRole]?.perms ?? []) out.add(p);
  return [...out].sort();
}

/** 角色组合的问题（空 = 合格）。 */
export function rolesProblem(roles: unknown): string | null {
  if (!Array.isArray(roles) || roles.length < 1 || roles.length > 3) return "须为 1–3 个角色";
  if (new Set(roles).size !== roles.length) return "角色不要重复";
  for (const r of roles) if (!(PLATFORM_ROLES as readonly string[]).includes(r)) return `没有这个角色：${String(r).slice(0, 20)}`;
  for (const [a, b] of ROLE_CONFLICTS) if (roles.includes(a) && roles.includes(b)) return `“${ROLE_TABLE[a].label}”与“${ROLE_TABLE[b].label}”不能由同一人兼任（职责分离）`;
  return null;
}

export const rolesView = () => PLATFORM_ROLES.map((id) => ({ id, label: ROLE_TABLE[id].label, note: ROLE_TABLE[id].note, perms: [...ROLE_TABLE[id].perms], danger: ROLE_TABLE[id].perms.filter((p) => DANGER_PERMISSIONS.has(p)) }));
