/**
 * 成员设备证书（方案 v5.0 第 4 篇 §5.3：律所根密钥签发；成员 ID、角色、设备 ID、有效期；
 * 签名密钥 Ed25519（存量）或 ECDSA P-256（TPM 与新安装，证书 signAlg 写明）+ X25519 加密密钥）。
 * 证书 = 上述字段 + 根私钥对 canonicalJson(除 signature 外全部字段) 的 Ed25519 签名。
 * 边界：验签只查签名、字段完整性与有效期；吊销检查在内核侧按密钥纪元处理，不在本模块。
 */
import { generateKeyPairSync } from "node:crypto";
import { canonicalJson } from "./encoding.ts";
import { signAlgOfPublicKey, signBytes, verifyBytes, type SignAlg } from "./signing.ts";

export const DeviceRoles = ["partner", "lawyer", "assistant", "admin", "node"] as const;
export type DeviceRole = (typeof DeviceRoles)[number];

/**
 * 设备编号字符集（v9 阶段 6 复核 S6-A22）：控制面接口以设备编号为路径段（吊销等），签发与验签都检查——
 * 编号含其他字符的证书签发不出来，目录里出现也按格式不合法拒绝。
 */
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

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
  /**
   * 设备签名算法（TPM 设计 v1 §4.2 算法敏捷）：缺省视为 ed25519（存量证书没有此字段，签名字节不变）；
   * ECDSA P-256 设备（TPM 或软件新安装）必须写明。签发与核验都要求它与 signPublicKeyPem 的实际类型一致。
   */
  signAlg?: SignAlg;
}

export interface DeviceCertificate extends DeviceCertificateInput {
  /** 根私钥对 canonicalJson(其余字段) 的 Ed25519 签名，base64url。 */
  signature: string;
}

export function issueDeviceCertificate(rootPrivateKeyPem: string, input: DeviceCertificateInput): DeviceCertificate {
  // 非 Ed25519 的设备公钥必须写明算法（未写时按公钥补上；Ed25519 不写，存量证书签名字节不变）
  const alg = signAlgOfPublicKey(input.signPublicKeyPem);
  const body: DeviceCertificateInput = alg === "ed25519" || input.signAlg ? input : { ...input, ...(alg ? { signAlg: alg } : {}) };
  const check = checkCertificateFields(body);
  if (check) throw new Error(`签发前字段校验失败：${check}`);
  const signature = signBytes(rootPrivateKeyPem, Buffer.from(canonicalJson(body), "utf8"));
  return { ...body, signature };
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/** 验签 + 字段完整性 + expiresAt 未过（now 可注入便于测试）。不做吊销检查。 */
export function verifyDeviceCertificate(cert: DeviceCertificate, rootPublicKeyPem: string, now: Date = new Date()): VerifyResult {
  const fieldProblem = checkCertificateFields(cert);
  if (fieldProblem) return { ok: false, reason: fieldProblem };
  if (typeof cert.signature !== "string" || cert.signature.length === 0) return { ok: false, reason: "缺少 signature 字段" };

  const { signature, ...unsigned } = cert;
  // 根签名（Ed25519）经同一分派核验；格式异常一律按无效
  const valid = verifyBytes(rootPublicKeyPem, Buffer.from(canonicalJson(unsigned), "utf8"), signature);
  if (!valid) return { ok: false, reason: "签名无效：证书字段与律所根密钥签名不符" };

  const expiresAt = Date.parse(cert.expiresAt);
  if (expiresAt <= now.getTime()) return { ok: false, reason: `证书已过有效期（expiresAt=${cert.expiresAt}）` };
  return { ok: true };
}

/**
 * 证书写明（或缺省）的签名算法与设备公钥实际类型一致；所有证书有效性核验点共用这一口径（复核 S7A-05）。
 */
export function certSignAlgConsistent(c: Pick<DeviceCertificateInput, "signAlg" | "signPublicKeyPem">): boolean {
  const actual = signAlgOfPublicKey(c.signPublicKeyPem);
  return !!actual && (c.signAlg ?? "ed25519") === actual;
}

/** 字段完整性检查；返回问题描述，null 表示通过。 */
function checkCertificateFields(c: DeviceCertificateInput): string | null {
  for (const key of ["certId", "memberId", "deviceId", "signPublicKeyPem", "encPublicKeyPem", "issuedAt", "expiresAt"] as const) {
    if (typeof c[key] !== "string" || c[key].length === 0) return `字段 ${key} 缺失或为空`;
  }
  if (!DEVICE_ID_PATTERN.test(c.deviceId)) return "设备编号只允许字母、数字、下划线与连字符（1–128 位）";
  if (!DeviceRoles.includes(c.role)) return `角色非法：${String(c.role)}（应为 ${DeviceRoles.join("/")}）`;
  if (Number.isNaN(Date.parse(c.issuedAt))) return "issuedAt 不是合法时间";
  if (Number.isNaN(Date.parse(c.expiresAt))) return "expiresAt 不是合法时间";
  if (Date.parse(c.expiresAt) <= Date.parse(c.issuedAt)) return "expiresAt 须晚于 issuedAt";
  // 算法敏捷：只认 Ed25519 与 ECDSA P-256；写明的 signAlg 须与公钥实际类型一致，未写即须为 Ed25519
  const actual = signAlgOfPublicKey(c.signPublicKeyPem);
  if (!actual) return "设备签名公钥不是 Ed25519 或 ECDSA P-256";
  if ((c.signAlg ?? "ed25519") !== actual) return `签名算法与公钥类型不符（证书 ${c.signAlg ?? "未写（视为 ed25519）"}，公钥 ${actual}）`;
  return null;
}
