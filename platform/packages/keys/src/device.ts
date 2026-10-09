/**
 * 成员设备证书（方案 v5.0 第 4 篇 §5.3：律所根密钥签发；成员 ID、角色、设备 ID、有效期；
 * Ed25519 签名密钥 + X25519 加密密钥）。
 * 证书 = 上述字段 + 根私钥对 canonicalJson(除 signature 外全部字段) 的 Ed25519 签名。
 * 边界：验签只查签名、字段完整性与有效期；吊销检查在内核侧按密钥纪元处理，不在本模块。
 */
import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { b64urlDecode, b64urlEncode, canonicalJson } from "./encoding.ts";

export const DeviceRoles = ["partner", "lawyer", "assistant", "admin", "node"] as const;
export type DeviceRole = (typeof DeviceRoles)[number];

export interface DeviceKeys {
  signPublicKeyPem: string;
  signPrivateKeyPem: string;
  encPublicKeyPem: string;
  encPrivateKeyPem: string;
}

/** 生成一台设备的两对密钥：Ed25519（签名）+ X25519（加密/收事项密钥包裹）。 */
export function generateDeviceKeys(): DeviceKeys {
  const sign = generateKeyPairSync("ed25519");
  const enc = generateKeyPairSync("x25519");
  return {
    signPublicKeyPem: sign.publicKey.export({ format: "pem", type: "spki" }).toString(),
    signPrivateKeyPem: sign.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    encPublicKeyPem: enc.publicKey.export({ format: "pem", type: "spki" }).toString(),
    encPrivateKeyPem: enc.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
}

export interface DeviceCertificateInput {
  certId: string;
  memberId: string;
  deviceId: string;
  role: DeviceRole;
  signPublicKeyPem: string;
  encPublicKeyPem: string;
  /** ISO 时间串。 */
  issuedAt: string;
  expiresAt: string;
}

export interface DeviceCertificate extends DeviceCertificateInput {
  /** 根私钥对 canonicalJson(其余字段) 的 Ed25519 签名，base64url。 */
  signature: string;
}

export function issueDeviceCertificate(rootPrivateKeyPem: string, input: DeviceCertificateInput): DeviceCertificate {
  const check = checkCertificateFields(input);
  if (check) throw new Error(`签发前字段校验失败：${check}`);
  const signature = b64urlEncode(new Uint8Array(cryptoSign(null, Buffer.from(canonicalJson(input), "utf8"), rootPrivateKeyPem)));
  return { ...input, signature };
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/** 验签 + 字段完整性 + expiresAt 未过（now 可注入便于测试）。不做吊销检查。 */
export function verifyDeviceCertificate(cert: DeviceCertificate, rootPublicKeyPem: string, now: Date = new Date()): VerifyResult {
  const fieldProblem = checkCertificateFields(cert);
  if (fieldProblem) return { ok: false, reason: fieldProblem };
  if (typeof cert.signature !== "string" || cert.signature.length === 0) return { ok: false, reason: "缺少 signature 字段" };

  const { signature, ...unsigned } = cert;
  let valid = false;
  try {
    valid = cryptoVerify(null, Buffer.from(canonicalJson(unsigned), "utf8"), rootPublicKeyPem, new Uint8Array(b64urlDecode(signature)));
  } catch {
    return { ok: false, reason: "验签过程出错（根公钥或签名格式异常）" };
  }
  if (!valid) return { ok: false, reason: "签名无效：证书字段与律所根密钥签名不符" };

  const expiresAt = Date.parse(cert.expiresAt);
  if (expiresAt <= now.getTime()) return { ok: false, reason: `证书已过有效期（expiresAt=${cert.expiresAt}）` };
  return { ok: true };
}

/** 字段完整性检查；返回问题描述，null 表示通过。 */
function checkCertificateFields(c: DeviceCertificateInput): string | null {
  for (const key of ["certId", "memberId", "deviceId", "signPublicKeyPem", "encPublicKeyPem", "issuedAt", "expiresAt"] as const) {
    if (typeof c[key] !== "string" || c[key].length === 0) return `字段 ${key} 缺失或为空`;
  }
  if (!DeviceRoles.includes(c.role)) return `角色非法：${String(c.role)}（应为 ${DeviceRoles.join("/")}）`;
  if (Number.isNaN(Date.parse(c.issuedAt))) return "issuedAt 不是合法时间";
  if (Number.isNaN(Date.parse(c.expiresAt))) return "expiresAt 不是合法时间";
  if (Date.parse(c.expiresAt) <= Date.parse(c.issuedAt)) return "expiresAt 须晚于 issuedAt";
  return null;
}
