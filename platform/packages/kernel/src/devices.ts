/**
 * 首次启动引导：律所身份与本机设备（方案 v5.0 第 4 篇 §5.3/§5.4）。
 *
 * **G0 开发形态（如实声明，非生产形态）**：
 * - 律所根私钥以 0600 文件存于 `<workspace>/keys/firm-root.json`——生产形态为离线恢复码
 *   抄写 + 可选多名合伙人分持，根私钥不应常驻任何联机设备；本文件仅为 G0 单机开发便利。
 * - 恢复托管私钥 Shamir 3-of-5 分持，份额以 0600 文件存于 `<workspace>/keys/recovery-shares/`——
 *   生产形态由合伙人各自离线保管，份额不应同机落盘；完整托管私钥用后即弃，绝不持久化。
 * - 根私钥/托管私钥/份额不出 `<workspace>/keys/` 目录；数据库 firm_identity 只存公钥。
 * - 首跑且该 tenant 仅 1 个 membership 时将其角色提升为 firm_admin（G0 单机开发形态；
 *   生产由管理控制台分配角色）。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  b64urlEncode,
  firmRootFromRecoveryCode,
  generateDeviceKeys,
  generateFirmRoot,
  generateRecoveryEscrow,
  issueDeviceCertificate,
  splitRecoveryPrivateKey,
  type DeviceCertificate,
  type DeviceKeys,
  type DeviceRole,
} from "@zr-legal/keys";
import type { KernelDb } from "./db.ts";
import type { Identity } from "./identity.ts";
import type { LedgerSigner } from "./ledger-signer.ts";

export interface FirmIdentityRow {
  rootPublicKeyPem: string;
  recoveryPublicKeyPem: string;
}

export interface KernelKeyContext {
  signer: LedgerSigner;
  device: DeviceContext;
  firm: FirmIdentityRow;
  keysDir: string;
}

export interface DeviceContext {
  deviceId: string;
  memberId: string;
  cert: DeviceCertificate;
  keys: DeviceKeys;
}

export function keysDirOf(workspaceDir: string): string {
  return join(workspaceDir, "keys");
}

function writeSecret0600(path: string, content: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(content, null, 2), { mode: 0o600 });
}

/** 首跑生成律所根密钥与恢复托管（分持落盘为开发形态）；之后只读公钥。
 * 若 db 无记录但 firm-root.json 已存在（工作区库重建/新引导同律所第二台机器），复用既有根密钥——
 * 同一律所多设备共用同一根（证书链一致的前提）；恢复托管公钥无法从文件恢复（份额仍在），
 * 以占位空串登记并如实注释（M-of-N 恢复流程不依赖库内该公钥，仅用份额）。 */
export function ensureFirmIdentity(db: KernelDb, keysDir: string, tenantId: string): FirmIdentityRow {
  const existing = db.get<{ root_public_key_pem: string; recovery_public_key_pem: string }>(
    `SELECT root_public_key_pem, recovery_public_key_pem FROM firm_identity WHERE tenant_id = ?`,
    [tenantId],
  );
  if (existing) return { rootPublicKeyPem: existing.root_public_key_pem, recoveryPublicKeyPem: existing.recovery_public_key_pem };

  const rootFile = join(keysDir, "firm-root.json");
  if (existsSync(rootFile)) {
    const root = getFirmRootPrivateKey(keysDir); // 自检恢复码一致性
    // 本工作区没有创始时的托管私钥（份额在创始处）——生成独立托管对（开发形态如实注明：
    // 本工作区的 recovery 包裹只能由本份额恢复；创始工作区事项的 recovery 包裹用其原份额）。
    const escrow = generateRecoveryEscrow();
    const { shares, privateKeyHash } = splitRecoveryPrivateKey(escrow.privateKeyPem, 5, 3);
    for (const share of shares) {
      writeSecret0600(join(keysDir, "recovery-shares", `share-${share.x}.json`), {
        _comment: "G0 开发形态：本工作区恢复托管私钥的 Shamir 份额（3-of-5）；与创始工作区的份额不同，勿混用。",
        x: share.x,
        y: b64urlEncode(share.y),
        privateKeyHash,
      });
    }
    db.run(`INSERT INTO firm_identity (tenant_id, root_public_key_pem, recovery_public_key_pem) VALUES (?,?,?)`, [tenantId, root.publicKeyPem, escrow.publicKeyPem]);
    return { rootPublicKeyPem: root.publicKeyPem, recoveryPublicKeyPem: escrow.publicKeyPem };
  }

  const root = generateFirmRoot();
  const escrow = generateRecoveryEscrow();
  const { shares, privateKeyHash } = splitRecoveryPrivateKey(escrow.privateKeyPem, 5, 3);
  // 完整托管私钥到此为止：只落份额，不持久化私钥本体
  db.tx(() => {
    db.run(`INSERT INTO firm_identity (tenant_id, root_public_key_pem, recovery_public_key_pem) VALUES (?,?,?)`, [
      tenantId,
      root.publicKeyPem,
      escrow.publicKeyPem,
    ]);
  });
  writeSecret0600(join(keysDir, "firm-root.json"), {
    _comment:
      "G0 开发形态：生产形态为离线恢复码抄写+合伙人分持，根私钥不应常驻联机设备；本文件仅用于签发设备证书，切勿提交或外传。中软不托管任何密钥。",
    publicKeyPem: root.publicKeyPem,
    privateKeyPem: root.privateKeyPem,
    recoveryCode: root.recoveryCode,
  });
  for (const share of shares) {
    writeSecret0600(join(keysDir, "recovery-shares", `share-${share.x}.json`), {
      _comment: "G0 开发形态：恢复托管私钥的 Shamir 份额（3-of-5）；生产由合伙人各自离线保管，不应同机落盘。",
      x: share.x,
      y: b64urlEncode(share.y),
      privateKeyHash,
    });
  }
  return { rootPublicKeyPem: root.publicKeyPem, recoveryPublicKeyPem: escrow.publicKeyPem };
}

/** 仅签发设备证书时读取根私钥（G0 开发形态，见文件头声明）。 */
export function getFirmRootPrivateKey(keysDir: string): { publicKeyPem: string; privateKeyPem: string; recoveryCode: string } {
  const raw = JSON.parse(readFileSync(join(keysDir, "firm-root.json"), "utf8")) as { publicKeyPem: string; privateKeyPem: string; recoveryCode: string };
  // 自检：文件内私钥与恢复码应派生同一公钥（发现被改/混放即拒用）
  const derived = firmRootFromRecoveryCode(raw.recoveryCode);
  if (derived.publicKeyPem !== raw.publicKeyPem || derived.privateKeyPem !== raw.privateKeyPem) {
    throw new Error("firm-root.json 内容与恢复码不一致（文件可能被改动），已拒用");
  }
  return raw;
}

export function getDeviceKeys(keysDir: string): DeviceKeys {
  return JSON.parse(readFileSync(join(keysDir, "device.json"), "utf8")) as DeviceKeys;
}

/** membership 角色 → 证书角色（G0 映射；生产由管理控制台按席位分配）。
 * userSlug === 'node' 的工作区是所内节点服务身份（§5.3 服务成员，firm-node 形态）——角色恒为 node。 */
function certRoleOf(membershipRole: string | undefined, userSlug?: string): DeviceRole {
  if (userSlug === "node") return "node";
  switch (membershipRole) {
    case "firm_admin":
      return "admin";
    case "partner":
      return "partner";
    case "paralegal":
      return "assistant";
    default:
      return "lawyer";
  }
}

/**
 * 当前主机设备（v0 确定性 device_id = dev_<firmSlug>_<userSlug>；一人一台设备）：
 * 首跑生成设备密钥（0600）→ 根私钥签发 1 年期设备证书 → devices upsert；之后直接装载。
 */
export function ensureDevice(db: KernelDb, keysDir: string, identity: Identity, slugs: { firmSlug: string; userSlug: string }): DeviceContext {
  const deviceId = `dev_${slugs.firmSlug}_${slugs.userSlug}`;

  // G0 单机开发形态：首跑且仅 1 个 membership 时提升为 firm_admin（生产由管理控制台分配）
  const ms = db.all<{ membership_id: string; role: string }>(`SELECT membership_id, role FROM memberships WHERE tenant_id = ?`, [identity.tenantId]);
  if (ms.length === 1 && ms[0]!.role === "lawyer") {
    db.run(`UPDATE memberships SET role = 'firm_admin' WHERE membership_id = ?`, [ms[0]!.membership_id]);
  }
  const membershipRole = db.get<{ role: string }>(`SELECT role FROM memberships WHERE tenant_id = ? AND user_id = ?`, [identity.tenantId, identity.userId])?.role;

  const deviceFile = join(keysDir, "device.json");
  const row = db.get<{ cert_json: string }>(`SELECT cert_json FROM devices WHERE device_id = ?`, [deviceId]);
  if (row && existsSync(deviceFile)) {
    return { deviceId, memberId: identity.userId, cert: JSON.parse(row.cert_json) as DeviceCertificate, keys: getDeviceKeys(keysDir) };
  }

  const root = getFirmRootPrivateKey(keysDir);
  const keys = generateDeviceKeys();
  const now = Date.now();
  const epoch = currentTenantEpoch(db, identity.tenantId);
  const cert = issueDeviceCertificate(root.privateKeyPem, {
    certId: `cert_${deviceId}_${now.toString(36)}`,
    memberId: identity.userId,
    deviceId,
    role: certRoleOf(membershipRole, slugs.userSlug),
    signPublicKeyPem: keys.signPublicKeyPem,
    encPublicKeyPem: keys.encPublicKeyPem,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 365 * 24 * 3600 * 1000).toISOString(),
  });
  db.run(
    `INSERT INTO devices (device_id, tenant_id, member_id, role, sign_pub_pem, enc_pub_pem, cert_json, status, key_epoch_at_issue)
     VALUES (?,?,?,?,?,?,?, 'active', ?)
     ON CONFLICT(device_id) DO UPDATE SET cert_json = excluded.cert_json, sign_pub_pem = excluded.sign_pub_pem,
       enc_pub_pem = excluded.enc_pub_pem, key_epoch_at_issue = excluded.key_epoch_at_issue`,
    [deviceId, identity.tenantId, identity.userId, cert.role, keys.signPublicKeyPem, keys.encPublicKeyPem, JSON.stringify(cert), epoch],
  );
  writeSecret0600(deviceFile, {
    _comment: "G0 开发形态：本机设备私钥（生产由 safeStorage/TPM 包裹保存，§5.3）；切勿提交或外传。",
    ...keys,
  });
  return { deviceId, memberId: identity.userId, cert, keys };
}

/** 当前 tenant 密钥纪元（无记录为 1）。 */
export function currentTenantEpoch(db: KernelDb, tenantId: string): number {
  const r = db.get<{ e: number | null }>(`SELECT MAX(epoch) AS e FROM key_epochs WHERE scope = 'tenant' AND scope_id = ?`, [tenantId]);
  return r?.e ?? 1;
}

/**
 * 节点设备（§5.3 服务成员，v0 简化形态：与桌面同机引导、同一律所根下独立 node-device.json）。
 * 真实所内节点是另一台机器/进程——跨机器节点加入流程（证书导入与密钥包裹下发）列入 G1 缺口，
 * v0 用于验证「逐事项授权 → 包裹给节点设备 → 节点可解 / 撤销后不可解」的完整密钥路径。
 */
export function ensureNodeDevice(db: KernelDb, keysDir: string, identity: Identity, slugs: { firmSlug: string }): DeviceContext {
  const deviceId = `node_${slugs.firmSlug}`;
  const deviceFile = join(keysDir, "node-device.json");
  const row = db.get<{ cert_json: string }>(`SELECT cert_json FROM devices WHERE device_id = ?`, [deviceId]);
  if (row && existsSync(deviceFile)) {
    const keys = JSON.parse(readFileSync(deviceFile, "utf8")) as DeviceKeys;
    return { deviceId, memberId: "node_service", cert: JSON.parse(row.cert_json) as DeviceCertificate, keys };
  }
  const root = getFirmRootPrivateKey(keysDir);
  const keys = generateDeviceKeys();
  const now = Date.now();
  const cert = issueDeviceCertificate(root.privateKeyPem, {
    certId: `cert_${deviceId}_${now.toString(36)}`,
    memberId: "node_service",
    deviceId,
    role: "node",
    signPublicKeyPem: keys.signPublicKeyPem,
    encPublicKeyPem: keys.encPublicKeyPem,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 365 * 24 * 3600 * 1000).toISOString(),
  });
  db.run(
    `INSERT INTO devices (device_id, tenant_id, member_id, role, sign_pub_pem, enc_pub_pem, cert_json, status, key_epoch_at_issue)
     VALUES (?,?,?,?,?,?,?, 'active', ?)
     ON CONFLICT(device_id) DO UPDATE SET cert_json = excluded.cert_json, sign_pub_pem = excluded.sign_pub_pem, enc_pub_pem = excluded.enc_pub_pem`,
    [deviceId, identity.tenantId, "node_service", "node", keys.signPublicKeyPem, keys.encPublicKeyPem, JSON.stringify(cert), currentTenantEpoch(db, identity.tenantId)],
  );
  writeSecret0600(deviceFile, {
    _comment: "G0 开发形态：节点设备私钥（生产为所内节点 TPM/硬件封存，导出受控并写入审计，§5.3）；切勿提交或外传。",
    ...keys,
  });
  return { deviceId, memberId: "node_service", cert, keys };
}

export function getNodeDeviceKeys(keysDir: string): DeviceKeys {
  return JSON.parse(readFileSync(join(keysDir, "node-device.json"), "utf8")) as DeviceKeys;
}
