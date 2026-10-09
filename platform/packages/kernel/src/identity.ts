/**
 * 身份与工作区（v0 开发形态）：律所工作区 + 当前成员，slug 即确定性 ID（稳定、可读）。
 * 生产（§5.4）：团队版/律所版身份来自律所 IM 组织扫码认证，本机生成设备密钥对，
 * 管理员签发设备证书——接口语义保持：每次调用解析出 tenant（律所工作区）+ user（成员设备）。
 * 本机缓存不构成有效授权：授权判定全部在内核。
 */
import { newId } from "@zr-legal/domain";
import { issueToken, requireSecret } from "@zr-legal/service-auth";
import type { KernelDb } from "./db.ts";

export interface Identity {
  tenantId: string;
  userId: string;
}

export function resolveIdentity(db: KernelDb, firmSlug: string, userSlug: string): Identity {
  const tenantId = `ten_${firmSlug}`;
  const userId = `usr_${firmSlug}_${userSlug}`;
  db.run(`INSERT OR IGNORE INTO tenants (tenant_id, name) VALUES (?, ?)`, [tenantId, firmSlug]);
  db.run(`INSERT OR IGNORE INTO users (user_id, tenant_id, display_name) VALUES (?, ?, ?)`, [userId, tenantId, userSlug]);
  db.run(
    `INSERT OR IGNORE INTO memberships (membership_id, tenant_id, user_id, role) VALUES (?, ?, ?, 'lawyer')`,
    [newId("membership"), tenantId, userId],
  );
  return { tenantId, userId };
}

/** 为 Agent 宿主等签发短期任务令牌（绑定工作区/成员/事项/任务；只在本机有效）。 */
export function mintTaskToken(
  claims: { tid: string; uid: string; mid?: string; rid?: string; aid?: string; scope: string[] },
  ttl = 900,
): string {
  return issueToken(claims, requireSecret("ZR_INTERNAL_SECRET"), ttl);
}
