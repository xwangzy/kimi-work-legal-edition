/**
 * 两步验证（第 46 批，契约 §2.3）：TOTP（RFC 6238 / RFC 4226，HMAC-SHA-1、6 位、30 秒一步，前后各容 1 步）与恢复码。
 *
 * - 只用 node:crypto，不引依赖；比对恒定时间。
 * - 同一步不得重复使用：调用方记“最后一次用过的步号”，只接受比它大的步。
 * - 恢复码 8 个、12 位（与一次性码同一字母表，显示为 4-4-4），服务端只存 HMAC；用过即删。
 * - 密钥（20 字节）放控制面状态里：状态快照整体已封装加密（state-store / pg-state-store）。
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { newOneTimeCode } from "./accounts.ts";

export const TOTP_STEP_MS = 30_000;
export const TOTP_DIGITS = 6;
export const TOTP_WINDOW = 1;
export const RECOVERY_CODES = 8;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let val = 0;
  let out = "";
  for (const b of buf) {
    val = (val << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(val >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  if (!/^[A-Z2-7]*$/.test(clean)) throw new Error("base32 字符不合法");
  let bits = 0;
  let val = 0;
  const out: number[] = [];
  for (const c of clean) {
    val = (val << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((val >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newTotpSecret = (): string => base32Encode(randomBytes(20));
export const totpStep = (t: number): number => Math.floor(t / TOTP_STEP_MS);

/** RFC 4226 HOTP（动态截断）；TOTP = HOTP(密钥, 步号)。 */
export function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", secret).update(msg).digest();
  const off = h[h.length - 1]! & 0x0f;
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

export const totpAt = (secretB32: string, t: number): string => hotp(base32Decode(secretB32), totpStep(t));

/**
 * 核对 6 位码：在 [当前步 −1, 当前步 +1] 里找命中的步，且必须大于 lastStep（同一步不得重用）。
 * 返回命中的步号；不中返回 null。每一步都算（不因提前命中而少算，耗时不随命中位置变化）。
 */
export function verifyTotp(secretB32: string, code: unknown, t: number, lastStep: number | null): number | null {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secretB32);
  const now = totpStep(t);
  let hit: number | null = null;
  for (let s = now - TOTP_WINDOW; s <= now + TOTP_WINDOW; s++) {
    const ok = timingSafeEqual(Buffer.from(hotp(key, s)), Buffer.from(code));
    if (ok && (lastStep === null || s > lastStep) && hit === null) hit = s;
  }
  return hit;
}

export function otpauthUri(secretB32: string, account: string, issuer = "Kimi Work 法律版"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_MS / 1000}`;
}

/** 恢复码：12 位（同一次性码字母表），HMAC 绑定人员编号。 */
export const newRecoveryCodes = (): string[] => Array.from({ length: RECOVERY_CODES }, () => newOneTimeCode());
export const recoveryMac = (pepper: Buffer, aid: string, code: string): string => createHmac("sha256", pepper).update(`kwl-staff-recovery/1\n${aid}\n${code}`).digest("hex");
