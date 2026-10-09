/**
 * 签名与编码原语：Ed25519 签名往返与篡改识别、sha256 已知向量、canonicalJson 稳定性。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { b64urlDecode, b64urlEncode, canonicalJson, generateDeviceKeys, sha256B64, signBytes, verifyBytes } from "../src/index.ts";

test("Ed25519 签名往返；篡改数据或签名验签失败", () => {
  const dev = generateDeviceKeys();
  const data = new TextEncoder().encode("事项事件体 v1");
  const sig = signBytes(dev.signPrivateKeyPem, data);
  assert.equal(verifyBytes(dev.signPublicKeyPem, data, sig), true);
  assert.equal(verifyBytes(dev.signPublicKeyPem, new TextEncoder().encode("事项事件体 v2"), sig), false);
  assert.equal(verifyBytes(dev.signPublicKeyPem, data, sig.slice(0, -2) + "xx"), false);
  assert.equal(verifyBytes(generateDeviceKeys().signPublicKeyPem, data, sig), false);
});

test("sha256B64 已知向量（空串）与字符串/字节一致性", () => {
  // SHA-256("") 的标准 base64url 值
  assert.equal(sha256B64(""), "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU");
  assert.equal(sha256B64(new Uint8Array(0)), sha256B64(""));
  assert.equal(sha256B64(new TextEncoder().encode("abc")), sha256B64("abc"));
});

test("base64url 往返；canonicalJson 键排序稳定与 undefined 语义", () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  assert.deepEqual(b64urlDecode(b64urlEncode(bytes)), bytes);

  const a = canonicalJson({ b: 1, a: { d: [3, 2], c: "x" } });
  const b = canonicalJson({ a: { c: "x", d: [3, 2] }, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":{"c":"x","d":[3,2]},"b":1}');

  // undefined 与 JSON.stringify 对齐：对象中跳过、数组中为 null（含嵌套）
  assert.equal(canonicalJson({ x: undefined, y: 1 }), '{"y":1}');
  assert.equal(canonicalJson({ a: [1, undefined, { b: undefined, c: 2 }] }), '{"a":[1,null,{"c":2}]}');
  assert.equal(canonicalJson({ x: undefined, y: 1 }), JSON.stringify({ x: undefined, y: 1 }));
  // 函数/Symbol/BigInt/NaN/顶层 undefined 仍抛错
  assert.throws(() => canonicalJson({ f: () => 1 }), /function/);
  assert.throws(() => canonicalJson({ s: Symbol("s") }), /symbol/);
  assert.throws(() => canonicalJson({ n: 1n }), /bigint/);
  assert.throws(() => canonicalJson(Number.NaN), /NaN/);
  assert.throws(() => canonicalJson(undefined), /undefined/);
});
