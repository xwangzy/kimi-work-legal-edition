/**
 * 律所根密钥（方案 v5.0 第 4 篇 §5.3：律所开通时生成；离线恢复码 + 可选多名合伙人分持）。
 * - 根密钥为 Ed25519 签名密钥对，只用于签发成员设备证书，不能解事项密钥（伦理墙）。
 * - 恢复码即私钥种子：32 字节随机 → HKDF-SHA256（info=kwl-firm-root-v1）确定性派生根密钥对；
 *   恢复码文本为 Crockford base32（不含 I/L/O/U），每 4 位一组连字符分组（32 字节 = 52 字符 = 13 组），供离线抄写。
 * - 单机与专业版：设备/根私钥可用律师自设恢复口令（scrypt 派生 + AES-256-GCM）包裹导出；
 *   口令遗失则不可恢复（开通时如实告知）。
 * 边界：本模块只做密码学原语；恢复码的纸质保管、分持与演练由开通流程负责。
 */
import { createPrivateKey, createPublicKey, hkdfSync, randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import { b64urlDecode, b64urlEncode } from "./encoding.ts";
import { KeysError } from "./errors.ts";

/** Ed25519 PKCS8 DER = 16 字节固定前缀 + 32 字节种子（RFC 8410）。 */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

const ROOT_HKDF_INFO = "kwl-firm-root-v1";
const SEED_BYTES = 32;

/** Crockford base32 字母表（编码不含 I/L/O/U；解码时 O→0、I/L→1 容错）。 */
const B32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const B32_DECODE: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < B32_ALPHABET.length; i++) m[B32_ALPHABET[i]!] = i;
  m["O"] = 0;
  m["I"] = 1;
  m["L"] = 1;
  return m;
})();

export interface FirmRoot {
  publicKeyPem: string;
  privateKeyPem: string;
  recoveryCode: string;
}

/** 生成律所根密钥：随机 32 字节种子派生 Ed25519 密钥对，恢复码可确定性重建同一密钥对。 */
export function generateFirmRoot(): FirmRoot {
  const seed = randomBytes(SEED_BYTES);
  const { publicKeyPem, privateKeyPem } = deriveRootFromSeed(new Uint8Array(seed));
  return { publicKeyPem, privateKeyPem, recoveryCode: encodeRecoveryCode(new Uint8Array(seed)) };
}

/** 从恢复码重建律所根密钥对（同码同钥）。 */
export function firmRootFromRecoveryCode(code: string): { publicKeyPem: string; privateKeyPem: string } {
  const seed = decodeRecoveryCode(code);
  return deriveRootFromSeed(seed);
}

function deriveRootFromSeed(seed: Uint8Array): { publicKeyPem: string; privateKeyPem: string } {
  if (seed.length !== SEED_BYTES) throw new KeysError("validation", `根密钥种子须为 ${SEED_BYTES} 字节，收到 ${seed.length}`);
  const derived = new Uint8Array(hkdfSync("sha256", seed, "", ROOT_HKDF_INFO, SEED_BYTES));
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(derived)]);
  const privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const publicKey = createPublicKey({ key: privateKey.export({ format: "jwk" }), format: "jwk" });
  return {
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
}

function encodeRecoveryCode(seed: Uint8Array): string {
  if (seed.length !== SEED_BYTES) throw new KeysError("validation", `恢复码种子须为 ${SEED_BYTES} 字节`);
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const byte of seed) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32_ALPHABET[(acc >>> bits) & 31];
    }
  }
  if (bits > 0) out += B32_ALPHABET[(acc << (5 - bits)) & 31];
  const groups: string[] = [];
  for (let i = 0; i < out.length; i += 4) groups.push(out.slice(i, i + 4));
  return groups.join("-");
}

function decodeRecoveryCode(code: string): Uint8Array {
  const clean = code.toUpperCase().replace(/[\s-]/g, "");
  let bits = 0;
  let acc = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const v = B32_DECODE[ch];
    if (v === undefined) throw new KeysError("validation", `恢复码含非法字符「${ch}」（Crockford base32，连字符与空格可省略）`);
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 0xff);
    }
  }
  if (out.length !== SEED_BYTES) {
    throw new KeysError("validation", `恢复码长度不符：解码得 ${out.length} 字节，应为 ${SEED_BYTES} 字节（52 个 base32 字符）`);
  }
  return new Uint8Array(out);
}

export interface ScryptWrappedBlob {
  v: 1;
  kdf: "scrypt";
  N: number;
  r: number;
  p: number;
  salt: string;
  nonce: string;
  ct: string;
  tag: string;
}

const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1 } as const;
const SCRYPT_KEY_BYTES = 32;
const SALT_BYTES = 16;
const GCM_NONCE_BYTES = 12;
/** N=2^15,r=8,p=1 的 scrypt 内存需求约 32 MiB，显式放宽 maxmem 以免触 Node 默认上限。 */
const SCRYPT_MAXMEM = 128 * 1024 * 1024;

/** 用恢复口令包裹私钥 PEM：scrypt(N=2^15,r=8,p=1) 派生 32 字节密钥 + AES-256-GCM。 */
export function wrapPrivateKeyScrypt(privateKeyPem: string, password: string): string {
  if (!password) throw new KeysError("validation", "恢复口令不能为空");
  const salt = randomBytes(SALT_BYTES);
  const key = scryptSync(password, salt, SCRYPT_KEY_BYTES, { ...SCRYPT_PARAMS, maxmem: SCRYPT_MAXMEM });
  const nonce = randomBytes(GCM_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(privateKeyPem, "utf8"), cipher.final()]);
  const blob: ScryptWrappedBlob = {
    v: 1,
    kdf: "scrypt",
    ...SCRYPT_PARAMS,
    salt: b64urlEncode(new Uint8Array(salt)),
    nonce: b64urlEncode(new Uint8Array(nonce)),
    ct: b64urlEncode(new Uint8Array(ct)),
    tag: b64urlEncode(new Uint8Array(cipher.getAuthTag())),
  };
  return JSON.stringify(blob);
}

/** 解包 scrypt 包裹的私钥；口令错误（GCM 校验失败）抛 code=bad_password。 */
export function unwrapPrivateKeyScrypt(blobJson: string, password: string): string {
  let blob: ScryptWrappedBlob;
  try {
    blob = JSON.parse(blobJson) as ScryptWrappedBlob;
  } catch {
    throw new KeysError("validation", "包裹数据不是合法 JSON");
  }
  if (blob?.v !== 1 || blob.kdf !== "scrypt" || typeof blob.N !== "number" || typeof blob.r !== "number" || typeof blob.p !== "number") {
    throw new KeysError("validation", "包裹数据格式不符（需要 {v:1,kdf:'scrypt',N,r,p,salt,nonce,ct,tag}）");
  }
  const key = scryptSync(password, new Uint8Array(b64urlDecode(blob.salt)), SCRYPT_KEY_BYTES, {
    N: blob.N,
    r: blob.r,
    p: blob.p,
    maxmem: SCRYPT_MAXMEM,
  });
  const decipher = createDecipheriv("aes-256-gcm", key, new Uint8Array(b64urlDecode(blob.nonce)));
  decipher.setAuthTag(new Uint8Array(b64urlDecode(blob.tag)));
  try {
    return Buffer.concat([decipher.update(new Uint8Array(b64urlDecode(blob.ct))), decipher.final()]).toString("utf8");
  } catch {
    throw new KeysError("bad_password", "恢复口令错误或包裹数据已损坏（AES-GCM 校验失败）");
  }
}
