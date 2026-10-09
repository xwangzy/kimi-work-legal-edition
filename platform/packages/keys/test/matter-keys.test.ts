/**
 * 事项密钥包裹（方案 v5.0 第 4 篇 §5.3：ECIES 形态，只包裹给该事项成员的设备公钥 + 恢复托管公钥）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateDeviceKeys, generateMatterKey, generateRecoveryEscrow, unwrapMatterKey, wrapMatterKey } from "../src/index.ts";

test("包裹/解包往返：成员设备与恢复托管公钥各自可解", () => {
  const matterKey = generateMatterKey();
  assert.equal(matterKey.length, 32);
  const dev = generateDeviceKeys();
  const escrow = generateRecoveryEscrow();

  const forDevice = wrapMatterKey(matterKey, dev.encPublicKeyPem);
  const forEscrow = wrapMatterKey(matterKey, escrow.publicKeyPem);
  assert.deepEqual(unwrapMatterKey(forDevice, dev.encPrivateKeyPem), matterKey);
  assert.deepEqual(unwrapMatterKey(forEscrow, escrow.privateKeyPem), matterKey);
});

test("错误接收私钥抛 unwrap_failed（伦理墙：非成员设备解不开）", () => {
  const matterKey = generateMatterKey();
  const alice = generateDeviceKeys();
  const stranger = generateDeviceKeys();
  const wrapped = wrapMatterKey(matterKey, alice.encPublicKeyPem);
  assert.throws(
    () => unwrapMatterKey(wrapped, stranger.encPrivateKeyPem),
    (e: unknown) => (e as { code?: string }).code === "unwrap_failed",
  );
});

test("同一事项密钥两次包裹产物不同（每次一次性 X25519 密钥对）", () => {
  const matterKey = generateMatterKey();
  const dev = generateDeviceKeys();
  const w1 = wrapMatterKey(matterKey, dev.encPublicKeyPem);
  const w2 = wrapMatterKey(matterKey, dev.encPublicKeyPem);
  assert.notEqual(w1, w2);
  assert.notEqual(JSON.parse(w1).ephem_pub, JSON.parse(w2).ephem_pub);
  assert.deepEqual(unwrapMatterKey(w2, dev.encPrivateKeyPem), matterKey);
});

test("包裹数据被篡改（ct 改一字节）解包抛 unwrap_failed", () => {
  const dev = generateDeviceKeys();
  const wrapped = JSON.parse(wrapMatterKey(generateMatterKey(), dev.encPublicKeyPem));
  wrapped.ct = (wrapped.ct[0] === "A" ? "B" : "A") + wrapped.ct.slice(1);
  assert.throws(
    () => unwrapMatterKey(JSON.stringify(wrapped), dev.encPrivateKeyPem),
    (e: unknown) => (e as { code?: string }).code === "unwrap_failed",
  );
});
