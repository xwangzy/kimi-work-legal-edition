/**
 * 编码工具：base64url 与签名用稳定 JSON 序列化（方案 v5.0 第 4 篇 §5.3 密钥体系的支撑模块）。
 * canonicalJson 只支持 JSON 值（对象键排序），用于「先序列化、后签名」的确定性口径。
 * undefined 语义与 JSON.stringify 对齐：对象中跳过、数组中序列化为 null；
 * 函数/Symbol/BigInt 与 NaN/Infinity 仍抛错（签名口径宁可显式失败也不静默变形）。
 */
import { KeysError } from "./errors.ts";

export function b64urlEncode(data: Uint8Array): string {
  return Buffer.from(data).toString("base64url");
}

export function b64urlDecode(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64url"));
}

/** 对象中 undefined 的跳过哨兵（数组中 undefined 映射为 null，与 JSON.stringify 一致）。 */
const SKIP = Symbol("canonicalJson.skip");

/** 键排序的稳定 JSON 序列化；拒绝函数/Symbol/BigInt/NaN/Infinity（非 JSON 值）。 */
export function canonicalJson(value: unknown): string {
  const sorted = sortValue(value);
  if (sorted === SKIP) throw new KeysError("validation", "canonicalJson 顶层值不能为 undefined");
  return JSON.stringify(sorted);
}

function sortValue(value: unknown): unknown {
  if (value === undefined) return SKIP;
  if (value === null) return null;
  const t = typeof value;
  if (t === "string" || t === "boolean") return value;
  if (t === "number") {
    if (!Number.isFinite(value as number)) throw new KeysError("validation", "canonicalJson 不支持 NaN/Infinity");
    return value;
  }
  if (t === "function" || t === "symbol" || t === "bigint") {
    throw new KeysError("validation", `canonicalJson 只支持 JSON 值，收到 ${t}`);
  }
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : sortValue(v)));
  if (t === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      // `__proto__` 自有键在赋值时会被当作原型设置而丢失，导致“带与不带该键”规范化结果相同（签名可延展；阶段 6 复核 S6-B17）：一律拒绝
      if (key === "__proto__") throw new KeysError("validation", "canonicalJson 不接受名为 __proto__ 的键");
      const v = sortValue((value as Record<string, unknown>)[key]);
      if (v === SKIP) continue; // 对象中 undefined 跳过（与 JSON.stringify 一致）
      out[key] = v;
    }
    return out;
  }
  throw new KeysError("validation", `canonicalJson 只支持 JSON 值，收到 ${t}`);
}
