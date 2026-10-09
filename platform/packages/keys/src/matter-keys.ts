/**
 * 事项密钥包裹（方案 v5.0 第 4 篇 §5.3：每事项一把 AES-256 数据密钥，
 * 只包裹给该事项成员的设备公钥 + 律所恢复托管公钥；伦理墙由密钥分发实现——
 * 不是事项成员的设备拿不到事项密钥，律所根密钥也不能解事项密钥）。
 * 包裹形态为 ECIES：每次包裹生成一次性 X25519 密钥对，shared=DH，
 * KEK=HKDF-SHA256(shared, salt=一次性公钥 raw, info=kwl-matter-key-wrap-v1)，AES-256-GCM 加密。
 * 边界：只负责「事项密钥 ↔ 接收方 X25519 公钥」的包裹/解包；包裹清单的分发与轮换（密钥纪元）在内核侧。
 */
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import { b64urlDecode, b64urlEncode } from "./encoding.ts";
import { KeysError } from "./errors.ts";

/**
 * X25519 公钥 SPKI DER = 12 字节固定前缀 + 32 字节 raw 公钥（RFC 8410）；
 * 私钥 PKCS8 DER = 16 字节固定前缀 + 32 字节种子。
 * 以下辅助函数依赖该布局前提（Node 内置 crypto 生成的 X25519 密钥恒为此格式）。
 */
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const X25519_RAW_BYTES = 32;

const MATTER_KEY_BYTES = 32;
const WRAP_HKDF_INFO = "kwl-matter-key-wrap-v1";
const GCM_NONCE_BYTES = 12;

/** 每事项一把 AES-256 数据密钥（32 字节随机）。 */
export function generateMatterKey(): Uint8Array {
  return new Uint8Array(randomBytes(MATTER_KEY_BYTES));
}

/** 从 SPKI PEM 提取 X25519 raw 公钥（DER 最后 32 字节；布局前提见文件头注释）。 */
export function x25519PublicRaw(publicKeyPem: string): Uint8Array {
  const der = createPublicKey(publicKeyPem).export({ format: "der", type: "spki" });
  if (der.length !== X25519_SPKI_PREFIX.length + X25519_RAW_BYTES) {
    throw new KeysError("validation", `X25519 公钥 DER 长度异常（${der.length}），不符合 SPKI 布局前提`);
  }
  return new Uint8Array(der.subarray(der.length - X25519_RAW_BYTES));
}

/** 从 PKCS8 PEM 提取 X25519 私钥种子（DER 最后 32 字节；布局前提见文件头注释）。 */
export function x25519PrivateSeed(privateKeyPem: string): Uint8Array {
  const der = createPrivateKey(privateKeyPem).export({ format: "der", type: "pkcs8" });
  if (der.length !== X25519_PKCS8_PREFIX.length + X25519_RAW_BYTES) {
    throw new KeysError("validation", `X25519 私钥 DER 长度异常（${der.length}），不符合 PKCS8 布局前提`);
  }
  return new Uint8Array(der.subarray(der.length - X25519_RAW_BYTES));
}

/** 由 32 字节 raw 公钥重建 X25519 公钥对象。 */
export function x25519PublicFromRaw(raw: Uint8Array): ReturnType<typeof createPublicKey> {
  if (raw.length !== X25519_RAW_BYTES) throw new KeysError("validation", `X25519 raw 公钥须为 ${X25519_RAW_BYTES} 字节`);
  return createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(raw)]), format: "der", type: "spki" });
}

/** 由 32 字节种子重建 X25519 私钥 PEM（恢复托管私钥重组用）。 */
export function x25519PrivateKeyPemFromSeed(seed: Uint8Array): string {
  if (seed.length !== X25519_RAW_BYTES) throw new KeysError("validation", `X25519 私钥种子须为 ${X25519_RAW_BYTES} 字节`);
  const key = createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, Buffer.from(seed)]), format: "der", type: "pkcs8" });
  return key.export({ format: "pem", type: "pkcs8" }).toString();
}

export interface WrappedMatterKey {
  v: 1;
  /** 一次性 X25519 公钥 raw，base64url。 */
  ephem_pub: string;
  nonce: string;
  ct: string;
  tag: string;
}

/** JSON 字符串 {v:1,ephem_pub,nonce,ct,tag}（base64url 字段）。 */
export type WrappedKey = string;

/** 把事项密钥包裹给一把接收方 X25519 公钥（每次包裹用新的一次性密钥对，产物互不相同）。 */
export function wrapMatterKey(matterKey: Uint8Array, recipientX25519PublicKeyPem: string): WrappedKey {
  if (matterKey.length !== MATTER_KEY_BYTES) throw new KeysError("validation", `事项密钥须为 ${MATTER_KEY_BYTES} 字节`);
  const ephem = generateKeyPairSync("x25519");
  const shared = diffieHellman({ privateKey: ephem.privateKey, publicKey: createPublicKey(recipientX25519PublicKeyPem) });
  const ephemPubRaw = x25519PublicRaw(ephem.publicKey.export({ format: "pem", type: "spki" }).toString());
  const kek = new Uint8Array(hkdfSync("sha256", shared, ephemPubRaw, WRAP_HKDF_INFO, 32));
  const nonce = randomBytes(GCM_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", kek, nonce);
  const ct = Buffer.concat([cipher.update(matterKey), cipher.final()]);
  const wrapped: WrappedMatterKey = {
    v: 1,
    ephem_pub: b64urlEncode(ephemPubRaw),
    nonce: b64urlEncode(new Uint8Array(nonce)),
    ct: b64urlEncode(new Uint8Array(ct)),
    tag: b64urlEncode(new Uint8Array(cipher.getAuthTag())),
  };
  return JSON.stringify(wrapped);
}

/** 用接收方 X25519 私钥解包；密钥不符（GCM 校验失败）抛 code=unwrap_failed。 */
export function unwrapMatterKey(wrapped: WrappedKey, recipientX25519PrivateKeyPem: string): Uint8Array {
  let data: WrappedMatterKey;
  try {
    data = JSON.parse(wrapped) as WrappedMatterKey;
  } catch {
    throw new KeysError("validation", "包裹数据不是合法 JSON");
  }
  if (data?.v !== 1 || typeof data.ephem_pub !== "string" || typeof data.nonce !== "string" || typeof data.ct !== "string" || typeof data.tag !== "string") {
    throw new KeysError("validation", "包裹数据格式不符（需要 {v:1,ephem_pub,nonce,ct,tag}）");
  }
  const ephemPubRaw = b64urlDecode(data.ephem_pub);
  const shared = diffieHellman({ privateKey: createPrivateKey(recipientX25519PrivateKeyPem), publicKey: x25519PublicFromRaw(ephemPubRaw) });
  const kek = new Uint8Array(hkdfSync("sha256", shared, ephemPubRaw, WRAP_HKDF_INFO, 32));
  const decipher = createDecipheriv("aes-256-gcm", kek, new Uint8Array(b64urlDecode(data.nonce)));
  decipher.setAuthTag(new Uint8Array(b64urlDecode(data.tag)));
  try {
    return new Uint8Array(Buffer.concat([decipher.update(new Uint8Array(b64urlDecode(data.ct))), decipher.final()]));
  } catch {
    throw new KeysError("unwrap_failed", "事项密钥解包失败：接收私钥与包裹不符或数据已损坏（AES-GCM 校验失败）");
  }
}
