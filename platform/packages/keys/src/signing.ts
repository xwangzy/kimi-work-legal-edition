/**
 * 签名与哈希原语（方案 v5.0 第 4 篇 §5.3：事件签名、证书签名、审计记录哈希的底层）。
 * Ed25519 签名（Node 内置 crypto，算法标识为 null——Ed25519 自带纯签名模式），base64url 编码。
 */
import { createHash, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { b64urlDecode, b64urlEncode } from "./encoding.ts";

export function signBytes(ed25519PrivateKeyPem: string, data: Uint8Array): string {
  return b64urlEncode(new Uint8Array(cryptoSign(null, Buffer.from(data), ed25519PrivateKeyPem)));
}

/** 验签；签名无效或输入格式异常一律返回 false（验签函数不抛）。 */
export function verifyBytes(ed25519PublicKeyPem: string, data: Uint8Array, signatureB64: string): boolean {
  try {
    return cryptoVerify(null, Buffer.from(data), ed25519PublicKeyPem, new Uint8Array(b64urlDecode(signatureB64)));
  } catch {
    return false;
  }
}

export function sha256B64(data: Uint8Array | string): string {
  return createHash("sha256").update(typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data)).digest("base64url");
}
