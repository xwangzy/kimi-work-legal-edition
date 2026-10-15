/**
 * 签名与哈希原语（方案 v5.0 第 4 篇 §5.3：事件签名、证书签名、审计记录哈希的底层）。
 * 算法敏捷（TPM 与根私钥离线分持设计 v1 §4.2；C6 §7.4 第 2 项）：按密钥类型分派——
 * - Ed25519：纯签名模式（算法标识 null），64 字节签名；
 * - ECDSA P-256：显式 SHA-256，签名编码一律 IEEE P1363（r‖s，64 字节，即 TPM `NCryptSignHash` 的原生输出），
 *   签名后规范化为低 S、核验时拒绝高 S——ECDSA 签名可塑（(r, n−s) 同样有效），本系统多处按签名串比较或去重，必须消除可塑性。
 * 其余密钥类型一律不签、核验返回 false。签名统一 base64url。
 */
import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { b64urlDecode, b64urlEncode } from "./encoding.ts";
import { KeysError } from "./errors.ts";

export type SignAlg = "ed25519" | "ecdsa-p256-sha256";

/** P-256 的群阶 n 与 n/2（低 S 规范化）。 */
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const P256_HALF_N = P256_N >> 1n;

function algOf(key: KeyObject): SignAlg | null {
  if (key.asymmetricKeyType === "ed25519") return "ed25519";
  if (key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1") return "ecdsa-p256-sha256";
  return null;
}

const toBig = (b: Uint8Array): bigint => BigInt(`0x${Buffer.from(b).toString("hex") || "0"}`);
const fromBig = (v: bigint): Uint8Array => new Uint8Array(Buffer.from(v.toString(16).padStart(64, "0"), "hex"));

/** 用私钥（PEM 或 KeyObject）签名；P-256 输出 P1363 且低 S。 */
export function signWithKey(privateKey: string | KeyObject, data: Uint8Array): string {
  const key = typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey;
  const alg = algOf(key);
  if (alg === "ed25519") return b64urlEncode(new Uint8Array(cryptoSign(null, Buffer.from(data), key)));
  if (alg === "ecdsa-p256-sha256") {
    const sig = new Uint8Array(cryptoSign("sha256", Buffer.from(data), { key, dsaEncoding: "ieee-p1363" }));
    const s = toBig(sig.subarray(32));
    if (s > P256_HALF_N) sig.set(fromBig(P256_N - s), 32);
    return b64urlEncode(sig);
  }
  throw new KeysError("validation", `不支持的签名密钥类型：${key.asymmetricKeyType ?? "未知"}`);
}

/** 兼容入口：按私钥 PEM 签名（Ed25519 或 P-256）。新代码请经签名者（signer.ts）签名。 */
export function signBytes(privateKeyPem: string, data: Uint8Array): string {
  return signWithKey(privateKeyPem, data);
}

/** 验签（按公钥类型分派）；签名无效、高 S、长度不符或输入格式异常一律返回 false（验签函数不抛）。 */
export function verifyBytes(publicKeyPem: string, data: Uint8Array, signatureB64: string): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    // 签名串也不可塑（复核 S7A-03）：只收规范 base64url（无填充、无多余字符、末字符填充位为 0）——解码后重新编码须与原串一致
    if (typeof signatureB64 !== "string" || !/^[A-Za-z0-9_-]+$/.test(signatureB64)) return false;
    const sig = new Uint8Array(b64urlDecode(signatureB64));
    if (b64urlEncode(sig) !== signatureB64) return false;
    const alg = algOf(key);
    if (alg === "ed25519") return sig.length === 64 && cryptoVerify(null, Buffer.from(data), key, sig);
    if (alg === "ecdsa-p256-sha256") {
      if (sig.length !== 64) return false;
      if (toBig(sig.subarray(32)) > P256_HALF_N) return false;
      return cryptoVerify("sha256", Buffer.from(data), { key, dsaEncoding: "ieee-p1363" }, sig);
    }
    return false;
  } catch {
    return false;
  }
}

/** 公钥的签名算法（证书 signAlg 与公钥类型一致性核对用）；不支持的类型返回 null。 */
export function signAlgOfPublicKey(publicKeyPem: string): SignAlg | null {
  try {
    return algOf(createPublicKey(publicKeyPem));
  } catch {
    return null;
  }
}

export function sha256B64(data: Uint8Array | string): string {
  return createHash("sha256").update(typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data)).digest("base64url");
}
