/**
 * 根密钥与恢复码（方案 v5.0 第 4 篇 §5.3）：恢复码确定性派生、scrypt 口令包裹。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { firmRootFromRecoveryCode, generateFirmRoot, unwrapPrivateKeyScrypt, wrapPrivateKeyScrypt } from "../src/index.ts";

test("恢复码确定性：同一恢复码重建同一根密钥对", () => {
  const root = generateFirmRoot();
  const rebuilt = firmRootFromRecoveryCode(root.recoveryCode);
  assert.equal(rebuilt.publicKeyPem, root.publicKeyPem);
  assert.equal(rebuilt.privateKeyPem, root.privateKeyPem);
  // 再建一次仍相同（纯确定性，无随机残留）
  assert.deepEqual(firmRootFromRecoveryCode(root.recoveryCode), rebuilt);
});

test("恢复码容忍连字符/大小写差异，不同恢复码得到不同密钥", () => {
  const a = generateFirmRoot();
  const b = generateFirmRoot();
  assert.notEqual(a.publicKeyPem, b.publicKeyPem);
  assert.notEqual(a.recoveryCode, b.recoveryCode);
  const sloppy = a.recoveryCode.toLowerCase().replace(/-/g, " ");
  assert.equal(firmRootFromRecoveryCode(sloppy).publicKeyPem, a.publicKeyPem);
});

test("恢复码格式：Crockford base32（编码不含 I/L/O/U），连字符分组", () => {
  const { recoveryCode } = generateFirmRoot();
  assert.match(recoveryCode, /^[0-9A-HJKMNP-TVWXYZ]{4}(-[0-9A-HJKMNP-TVWXYZ]{4})*$/);
  assert.throws(() => firmRootFromRecoveryCode("XXXX-XXXX"), /长度不符/);
  assert.throws(() => firmRootFromRecoveryCode("!!!!"), /非法字符/);
});

test("scrypt 包裹/解包往返；错误口令抛 bad_password", () => {
  const root = generateFirmRoot();
  const blob = wrapPrivateKeyScrypt(root.privateKeyPem, "律师自设口令-2026");
  const parsed = JSON.parse(blob);
  assert.equal(parsed.v, 1);
  assert.equal(parsed.kdf, "scrypt");
  assert.equal(parsed.N, 2 ** 15);
  assert.equal(unwrapPrivateKeyScrypt(blob, "律师自设口令-2026"), root.privateKeyPem);
  assert.throws(() => unwrapPrivateKeyScrypt(blob, "错误口令"), (e: unknown) => (e as { code?: string }).code === "bad_password");
  // 两次包裹产物不同（随机 salt/nonce）
  assert.notEqual(wrapPrivateKeyScrypt(root.privateKeyPem, "律师自设口令-2026"), blob);
});
