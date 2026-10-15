/**
 * 管理员设备签名（v9 第 02 篇 §9.11 “律所侧校验锚”：管理员公钥入组固定；放宽类策略与连接器登记须管理员设备签名
 * （团队版 1 名、律所版 2 名）；第 04 篇 §10）。
 *
 * 管理员公钥的来源是**律所根密钥签发的设备证书（角色 admin）**，律所根公钥在开通时固定在每台设备上——控制面不持有律所根私钥，
 * 因此不能自造管理员；只有控制面签名、没有管理员设备签名的放宽内容一律拒绝。
 * 门限按**不同成员**计（同一管理员的两台设备只算一名）。
 */
import { createHash } from "node:crypto";
import { signSyncWith, verifyBytes, verifyDeviceCertificate, type DeviceCertificate, type SyncSignerLike } from "@zr-legal/keys";

export interface AdminSignature {
  /** 签名设备的证书（律所根签发，角色须为 admin）。 */
  cert: DeviceCertificate;
  /** 设备签名私钥对待签字节的签名（Ed25519 或 P-256 低 S，base64url）。 */
  sig: string;
}

export function adminSign(bytes: Buffer, cert: DeviceCertificate, signer: SyncSignerLike): AdminSignature {
  return { cert, sig: signSyncWith(signer, bytes) };
}

export interface AdminVerifyContext {
  /** 本机固定的律所根公钥（开通时入组）。 */
  rootPublicKeyPem: string;
  /** 本机固定的管理员签名门限（按不同成员计）。 */
  threshold: number;
  /** 本机已知的已吊销设备（吊销是粘滞的：控制面后来不再列出也不恢复）。 */
  revokedDevices: ReadonlySet<string>;
  now: Date;
}

export interface AdminVerifyResult {
  ok: boolean;
  /** 有效签名的成员（去重）。 */
  members: string[];
  /** 有效签名的设备。 */
  devices: string[];
  /** 只由核验通过的条目构成的“设备 → 成员”映射（重算门限只用它；阶段 6 复核 S6-B03）。 */
  deviceMembers: Record<string, string>;
  /** 核验通过的签名条目（本机只保存这些）。 */
  verified: AdminSignature[];
  /** 无效签名的原因（逐条）。 */
  problems: string[];
}

/** 最多核验的签名条数（超出的条目不核验、不保存、不计数）。 */
export const MAX_ADMIN_SIGNATURES = 16;

/**
 * 逐条核验管理员签名：证书由律所根签发且未过期、角色 admin、设备未吊销、签名对待签字节有效；有效成员数 ≥ 门限为通过。
 * 按设备与签名公钥去重：同一设备（或同一把签名公钥）只算一次，即使它持有不同成员的证书（S6-B26）。
 */
export function verifyAdminSignatures(bytes: Buffer, sigs: unknown, ctx: AdminVerifyContext): AdminVerifyResult {
  const members = new Set<string>();
  const devices: string[] = [];
  const deviceMembers: Record<string, string> = {};
  const verified: AdminSignature[] = [];
  const seenKeys = new Set<string>();
  const problems: string[] = [];
  const list = Array.isArray(sigs) ? sigs.slice(0, MAX_ADMIN_SIGNATURES) : [];
  for (const raw of list) {
    const s = raw as Partial<AdminSignature> | null;
    const cert = s?.cert as DeviceCertificate | undefined;
    if (!cert || typeof cert !== "object" || typeof s?.sig !== "string") {
      problems.push("signature_malformed");
      continue;
    }
    const cv = verifyDeviceCertificate(cert, ctx.rootPublicKeyPem, ctx.now);
    if (!cv.ok) {
      problems.push(`cert_not_issued_by_firm_root:${String(cert.deviceId ?? "?")}`);
      continue;
    }
    if (cert.role !== "admin") {
      problems.push(`signer_not_admin:${cert.deviceId}`);
      continue;
    }
    if (ctx.revokedDevices.has(cert.deviceId)) {
      problems.push(`signer_revoked:${cert.deviceId}`);
      continue;
    }
    const good = typeof s.sig === "string" && verifyBytes(cert.signPublicKeyPem, bytes, s.sig);
    if (!good) {
      problems.push(`signature_invalid:${cert.deviceId}`);
      continue;
    }
    const keyId = cert.signPublicKeyPem.trim();
    if (devices.includes(cert.deviceId) || seenKeys.has(keyId)) continue;
    devices.push(cert.deviceId);
    seenKeys.add(keyId);
    deviceMembers[cert.deviceId] = cert.memberId;
    verified.push({ cert, sig: s.sig });
    members.add(cert.memberId);
  }
  return { ok: members.size >= Math.max(1, ctx.threshold), members: [...members], devices, deviceMembers, verified, problems };
}

/** 按已保存的核验通过签名重算：去掉已吊销的设备后，剩余不同成员数是否仍达门限。 */
export function signersStillSufficient(deviceMembers: Readonly<Record<string, string>>, revokedDevices: ReadonlySet<string>, threshold: number): boolean {
  const alive = new Set<string>();
  for (const [dev, member] of Object.entries(deviceMembers)) if (!revokedDevices.has(dev)) alive.add(member);
  return alive.size >= Math.max(1, threshold);
}

/** 待签字节的摘要（同一版本号不同内容的判定、审计留痕）。 */
export function bytesDigest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("base64url");
}
