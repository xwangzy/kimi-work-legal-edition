/**
 * 发给某台设备的密文（第 10 批，v9 #51 期限提醒“期限类型、事项代号与文案用接收人设备公钥加密”；Y2 §3.9 S9）。
 *
 * 与事项密钥包裹（matter-keys.ts）同一 ECIES 构造，但用途分开：HKDF info 不同（`kwl-device-seal-v1`），并把调用方给的
 * **附加数据**（AAD）绑进 AES-GCM——云端把一份密文挪给另一条提醒、另一台设备或另一个版本，接收设备解密即失败。
 *
 * 线上形态为一个 base64url 串（便于闸门只按“一个不透明串”检查形状）：
 *   `0x01 ‖ 一次性 X25519 公钥 32 ‖ nonce 12 ‖ 密文 ‖ tag 16`
 * 只负责机密性与“这份密文属于这个上下文”；发送者是谁由调用方另行签名（ECIES 本身不认证发送者）。
 */
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import { b64urlDecode, b64urlEncode } from "./encoding.ts";
import { KeysError } from "./errors.ts";
import { x25519PublicFromRaw, x25519PublicRaw } from "./matter-keys.ts";

const SEAL_VERSION = 0x01;
const SEAL_HKDF_INFO = "kwl-device-seal-v1";
const RAW = 32;
const NONCE = 12;
const TAG = 16;
/** 单份明文上限（提醒文案等小载荷；超过即拒绝，不做分块）。 */
export const DEVICE_SEAL_MAX_PLAINTEXT = 16 * 1024;

function kek(shared: Buffer, ephemRaw: Uint8Array): Uint8Array {
  return new Uint8Array(hkdfSync("sha256", shared, ephemRaw, SEAL_HKDF_INFO, 32));
}

/** 用接收设备的 X25519 公钥加密；`aad` 为上下文（同一字符串才解得开）。每次调用产物不同。 */
export function sealForDevice(plaintext: Uint8Array, recipientX25519PublicKeyPem: string, aad: string): string {
  if (plaintext.byteLength > DEVICE_SEAL_MAX_PLAINTEXT) throw new KeysError("validation", `明文超过 ${DEVICE_SEAL_MAX_PLAINTEXT} 字节`);
  const ephem = generateKeyPairSync("x25519");
  const shared = diffieHellman({ privateKey: ephem.privateKey, publicKey: createPublicKey(recipientX25519PublicKeyPem) });
  const ephemRaw = x25519PublicRaw(ephem.publicKey.export({ format: "pem", type: "spki" }).toString());
  const key = kek(shared, ephemRaw);
  const nonce = randomBytes(NONCE);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  key.fill(0);
  return b64urlEncode(new Uint8Array(Buffer.concat([Buffer.from([SEAL_VERSION]), Buffer.from(ephemRaw), nonce, ct, c.getAuthTag()])));
}

/** 用本设备 X25519 私钥解密；形态不符、上下文不符或数据被改一律抛 `unwrap_failed`（不区分原因）。 */
export function openForDevice(sealed: string, recipientX25519PrivateKeyPem: string, aad: string): Uint8Array {
  if (typeof sealed !== "string" || !/^[A-Za-z0-9_-]+$/.test(sealed)) throw new KeysError("unwrap_failed", "密文形态不符");
  const buf = Buffer.from(b64urlDecode(sealed));
  if (buf.length < 1 + RAW + NONCE + TAG || buf[0] !== SEAL_VERSION) throw new KeysError("unwrap_failed", "密文形态不符");
  const ephemRaw = new Uint8Array(buf.subarray(1, 1 + RAW));
  const nonce = buf.subarray(1 + RAW, 1 + RAW + NONCE);
  const ct = buf.subarray(1 + RAW + NONCE, buf.length - TAG);
  const tag = buf.subarray(buf.length - TAG);
  let key: Uint8Array | null = null;
  try {
    const shared = diffieHellman({ privateKey: createPrivateKey(recipientX25519PrivateKeyPem), publicKey: x25519PublicFromRaw(ephemRaw) });
    key = kek(shared, ephemRaw);
    const d = createDecipheriv("aes-256-gcm", key, nonce);
    d.setAAD(Buffer.from(aad, "utf8"));
    d.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([d.update(ct), d.final()]));
  } catch {
    throw new KeysError("unwrap_failed", "密文解不开：不是发给本设备的、上下文不符或已被改动");
  } finally {
    key?.fill(0);
  }
}
