/**
 * Shamir 秘密分持（方案 v5.0 第 4 篇 §5.3：恢复托管私钥按 M-of-N 分持给多名合伙人，
 * 默认 3-of-5，任何一人单独不可用）。
 * GF(256) 运算，约减多项式 x^8+x^4+x^3+x+1（0x11b，xtime 标准实现），log/exp 表以 3 为生成元。
 * 逐字节取随机多项式：f(0)=秘密字节，其余系数 crypto.randomBytes；份额 x ∈ 1..255。
 * 边界：combineShares 不做「份额是否足够」的判断——份额不足会得到错误结果但不报错，
 * 调用方须用哈希校验识别（见 recovery.ts 的 privateKeyHash）。
 */
import { randomBytes } from "node:crypto";
import { KeysError } from "./errors.ts";

const FIELD_SIZE = 256;
const MAX_SHARES = 255;

const EXP = new Uint8Array(FIELD_SIZE * 2);
const LOG = new Uint8Array(FIELD_SIZE);

(function initTables() {
  let x = 1;
  for (let i = 0; i < MAX_SHARES; i++) {
    EXP[i] = x;
    LOG[x] = i;
    // 乘以生成元 3：xtime(x) ^ x
    x = xtime(x) ^ x;
  }
  for (let i = MAX_SHARES; i < EXP.length; i++) EXP[i] = EXP[i - MAX_SHARES]!;
})();

/** 乘以 2（模 0x11b：溢出异或 0x1b）。 */
function xtime(a: number): number {
  const t = a << 1;
  return (a & 0x80) !== 0 ? (t ^ 0x1b) & 0xff : t & 0xff;
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

function gfInv(a: number): number {
  if (a === 0) throw new KeysError("internal", "GF(256) 0 无乘法逆元");
  return EXP[MAX_SHARES - LOG[a]!]!;
}

export interface Share {
  x: number;
  y: Uint8Array;
}

/**
 * 把秘密分成 total 份，任意 threshold 份可重组。
 * 参数校验：total ≤ 255、2 ≤ threshold ≤ total（不合规抛 code=validation）。
 */
export function splitSecret(secret: Uint8Array, total: number, threshold: number): Share[] {
  if (secret.length === 0) throw new KeysError("validation", "秘密不能为空");
  if (!Number.isInteger(total) || !Number.isInteger(threshold)) throw new KeysError("validation", "total 与 threshold 须为整数");
  if (total > MAX_SHARES) throw new KeysError("validation", `total 上限 ${MAX_SHARES}（x ∈ 1..255），收到 ${total}`);
  if (threshold < 2) throw new KeysError("validation", "threshold 至少为 2（单人单独可用违背分持目的）");
  if (threshold > total) throw new KeysError("validation", `threshold（${threshold}）不能大于 total（${total}）`);

  // 逐字节随机多项式：coeffs[j][0]=秘密字节，其余为随机系数
  const coeffs: Uint8Array[] = [];
  for (let j = 0; j < secret.length; j++) {
    const c = new Uint8Array(randomBytes(threshold));
    c[0] = secret[j]!;
    coeffs.push(c);
  }

  const shares: Share[] = [];
  for (let i = 1; i <= total; i++) {
    const y = new Uint8Array(secret.length);
    for (let j = 0; j < secret.length; j++) {
      // Horner 法求值 f(i)
      let acc = 0;
      const c = coeffs[j]!;
      for (let k = threshold - 1; k >= 0; k--) acc = gfMul(acc, i) ^ c[k]!;
      y[j] = acc;
    }
    shares.push({ x: i, y });
  }
  return shares;
}

/**
 * x=0 处 Lagrange 插值重组秘密。重复 x、x=0、份额长度与 expectedLength 不符均抛 code=validation。
 * 份额不足 threshold 时不报错（得到错误结果），由调用方负责校验（如哈希比对）。
 */
export function combineShares(shares: Share[], expectedLength: number): Uint8Array {
  if (!Number.isInteger(expectedLength) || expectedLength <= 0) throw new KeysError("validation", "expectedLength 须为正整数");
  if (shares.length === 0) throw new KeysError("validation", "份额列表为空");
  const seen = new Set<number>();
  for (const s of shares) {
    if (!Number.isInteger(s.x) || s.x < 1 || s.x > MAX_SHARES) throw new KeysError("validation", `份额 x 非法：${s.x}（须为 1..255 整数）`);
    if (seen.has(s.x)) throw new KeysError("validation", `份额 x 重复：${s.x}`);
    seen.add(s.x);
    if (s.y.length !== expectedLength) throw new KeysError("validation", `份额 x=${s.x} 长度 ${s.y.length} 与期望 ${expectedLength} 不符`);
  }

  const out = new Uint8Array(expectedLength);
  for (let j = 0; j < expectedLength; j++) {
    let acc = 0;
    for (let i = 0; i < shares.length; i++) {
      // L_i(0) = Π_{k≠i} x_k / (x_i ^ x_k)（GF(2^8) 中减即异或）
      let li = 1;
      for (let k = 0; k < shares.length; k++) {
        if (k === i) continue;
        li = gfMul(li, gfMul(shares[k]!.x, gfInv(shares[i]!.x ^ shares[k]!.x)));
      }
      acc ^= gfMul(shares[i]!.y[j]!, li);
    }
    out[j] = acc;
  }
  return out;
}
