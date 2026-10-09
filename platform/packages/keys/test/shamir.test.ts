/**
 * Shamir 分持与恢复托管（方案 v5.0 第 4 篇 §5.3：托管私钥 M-of-N 分持，默认 3-of-5；
 * 份额不足/有误由 privateKeyHash 识别，绝不静默返回错误密钥）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  combineRecoveryPrivateKey,
  combineShares,
  createBreakGlassRecord,
  generateRecoveryEscrow,
  hashBreakGlassRecord,
  splitRecoveryPrivateKey,
  splitSecret,
} from "../src/index.ts";

test("32 字节秘密 3-of-5：任取 3 份组合成功", () => {
  const secret = new Uint8Array(randomBytes(32));
  const shares = splitSecret(secret, 5, 3);
  assert.equal(shares.length, 5);
  // C(5,3) = 10 种组合全部还原
  for (let a = 0; a < 5; a++) {
    for (let b = a + 1; b < 5; b++) {
      for (let c = b + 1; c < 5; c++) {
        const combined = combineShares([shares[a]!, shares[b]!, shares[c]!], 32);
        assert.deepEqual(combined, secret, `组合 ${a},${b},${c} 失败`);
      }
    }
  }
});

test("份额逐份随机：同一秘密两次分持产物不同", () => {
  const secret = new Uint8Array(randomBytes(32));
  const a = splitSecret(secret, 5, 3);
  const b = splitSecret(secret, 5, 3);
  assert.notDeepEqual(a[0]!.y, b[0]!.y);
});

test("恢复托管：分持→任 3 份重组回原私钥；份额不足或有误 ok:false", () => {
  const escrow = generateRecoveryEscrow();
  const { shares, privateKeyHash } = splitRecoveryPrivateKey(escrow.privateKeyPem, 5, 3);

  const ok = combineRecoveryPrivateKey([shares[1]!, shares[3]!, shares[4]!], privateKeyHash);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.privateKeyPem, escrow.privateKeyPem);

  // 只有 2 份：插值出错误种子，hash 识别 → ok:false（不得静默返回错误密钥）
  const short2 = combineRecoveryPrivateKey([shares[0]!, shares[1]!], privateKeyHash);
  assert.equal(short2.ok, false);

  // 3 份但其中 1 份内容被改：同样 ok:false
  const corrupted = { x: shares[2]!.x, y: new Uint8Array(shares[2]!.y) };
  corrupted.y[0] = corrupted.y[0]! ^ 0xff;
  const bad = combineRecoveryPrivateKey([shares[0]!, shares[1]!, corrupted], privateKeyHash);
  assert.equal(bad.ok, false);
});

test("combineShares 重复 x 抛 validation", () => {
  const shares = splitSecret(new Uint8Array(randomBytes(32)), 5, 3);
  assert.throws(
    () => combineShares([shares[0]!, shares[0]!], 32),
    (e: unknown) => (e as { code?: string }).code === "validation",
  );
});

test("边界：1-of-1 拒绝（threshold≥2）；total=255 上限可用", () => {
  const secret = new Uint8Array(randomBytes(32));
  assert.throws(
    () => splitSecret(secret, 1, 1),
    (e: unknown) => (e as { code?: string }).code === "validation",
  );
  assert.throws(() => splitSecret(secret, 256, 2), /上限/);
  assert.throws(() => splitSecret(secret, 3, 4), /不能大于/);

  const shares = splitSecret(secret, 255, 3);
  assert.equal(shares.length, 255);
  assert.equal(shares[254]!.x, 255);
  assert.deepEqual(combineShares([shares[0]!, shares[128]!, shares[254]!], 32), secret);
});

test("破窗记录：纯数据构造 + 内容哈希稳定；缺字段抛 validation", () => {
  const rec = createBreakGlassRecord({
    matterId: "mat_1",
    keyEpoch: 2,
    shareHolderIds: ["mem_p1", "mem_p2", "mem_p3"],
    actorId: "mem_p1",
    at: "2026-10-02T08:00:00.000Z",
  });
  assert.equal(rec.kind, "break_glass");
  assert.equal(hashBreakGlassRecord(rec), hashBreakGlassRecord({ ...rec }));
  assert.notEqual(hashBreakGlassRecord(rec), hashBreakGlassRecord({ ...rec, key_epoch: 3 }));
  assert.throws(() => createBreakGlassRecord({ matterId: "mat_1", keyEpoch: 2, shareHolderIds: [], actorId: "mem_p1", at: "2026-10-02T08:00:00.000Z" }), (e: unknown) => (e as { code?: string }).code === "validation");
});
