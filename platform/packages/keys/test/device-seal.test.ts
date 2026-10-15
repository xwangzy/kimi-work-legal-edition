/**
 * 发给设备的密文（第 10 批 S9 期限提醒）：只有接收设备、且附加数据（租户、提醒编号、版本、接收设备）完全相同才解得开；
 * 每次加密产物不同；任一字节被改即失败；超过上限的明文拒绝。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEVICE_SEAL_MAX_PLAINTEXT, generateDeviceKeys, openForDevice, sealForDevice, KeysError } from "../src/index.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

test("DS-01 往返：接收设备用自己的私钥、同一附加数据解开；两次加密产物不同", () => {
  const a = generateDeviceKeys();
  const s1 = sealForDevice(enc("开庭：2026-11-30"), a.encPublicKeyPem, "ctx-1");
  const s2 = sealForDevice(enc("开庭：2026-11-30"), a.encPublicKeyPem, "ctx-1");
  assert.notEqual(s1, s2);
  assert.match(s1, /^[A-Za-z0-9_-]+$/);
  assert.equal(dec(openForDevice(s1, a.encPrivateKeyPem, "ctx-1")), "开庭：2026-11-30");
  assert.ok(!Buffer.from(s1, "base64url").includes(Buffer.from("开庭")), "密文里没有明文");
});

test("DS-02 别的设备、别的附加数据、被改动的密文一律解不开（同一错误代码，不区分原因）", () => {
  const a = generateDeviceKeys();
  const b = generateDeviceKeys();
  const s = sealForDevice(enc("x"), a.encPublicKeyPem, "kwl-notify/1\nt\nrmd_1\n1\ndevA");
  const fails = (fn: () => unknown) => assert.throws(fn, (e: unknown) => e instanceof KeysError && e.code === "unwrap_failed");
  fails(() => openForDevice(s, b.encPrivateKeyPem, "kwl-notify/1\nt\nrmd_1\n1\ndevA"));
  fails(() => openForDevice(s, a.encPrivateKeyPem, "kwl-notify/1\nt\nrmd_1\n2\ndevA"));
  fails(() => openForDevice(s, a.encPrivateKeyPem, "kwl-notify/1\nt\nrmd_1\n1\ndevB"));
  const raw = Buffer.from(s, "base64url");
  for (const i of [0, 1, 40, raw.length - 1]) {
    const t = Buffer.from(raw);
    t[i] = t[i]! ^ 1;
    fails(() => openForDevice(t.toString("base64url"), a.encPrivateKeyPem, "kwl-notify/1\nt\nrmd_1\n1\ndevA"));
  }
  fails(() => openForDevice("not base64!", a.encPrivateKeyPem, "x"));
  fails(() => openForDevice("AAAA", a.encPrivateKeyPem, "x"));
});

test("DS-03 明文超过上限拒绝加密", () => {
  const a = generateDeviceKeys();
  assert.throws(() => sealForDevice(new Uint8Array(DEVICE_SEAL_MAX_PLAINTEXT + 1), a.encPublicKeyPem, "x"), (e: unknown) => e instanceof KeysError && e.code === "validation");
  assert.doesNotThrow(() => sealForDevice(new Uint8Array(DEVICE_SEAL_MAX_PLAINTEXT), a.encPublicKeyPem, "x"));
});
