/**
 * 密钥纪元与撤权（方案 v5.0 第 4 篇 §5.2/§5.3）：
 * devices.revoke → tenant 纪元递增 + 审计；撤权校验不依赖时钟（吊销设备旧纪元事件一律拒收）；
 * members.add 为对方设备补包裹（可解同一事项密钥）；members.remove 轮换新纪元
 * （旧设备解不开新密钥 unwrap_failed，旧纪元行保留）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { b64urlDecode, combineRecoveryPrivateKey, generateDeviceKeys, issueDeviceCertificate, unwrapMatterKey, type DeviceCertificate } from "@zr-legal/keys";
import { assertIncomingEventAcceptable, getDeviceKeys, getFirmRootPrivateKey, keysDirOf } from "../src/index.ts";
import { makeKernel, type TestKernel } from "./helpers.ts";

let tk: TestKernel;

before(async () => {
  tk = await makeKernel({}, "epoch-firm");
});

after(async () => {
  await tk.kernel.close();
});

test("密钥纪元：吊销撤权 + 成员加移的密钥分发", { timeout: 120_000 }, async () => {
  const { inv, kernel, dir } = tk;
  const db = kernel.db;
  const tenantId = kernel.identity.tenantId;
  const keysDir = keysDirOf(join(dir, "epoch-firm"));
  const hostDeviceId = `dev_epoch-firm_test-lawyer`;

  // ── 成员加移（先做密钥分发，再测撤权） ──
  const { matter } = await inv("matters.create", { title: "纪元测试事项", stance: "受让方", consent_status: "not_required" });
  // 构造同事用户 + 其设备（用律所根私钥签发证书——与管理员签发同路径）
  const root = getFirmRootPrivateKey(keysDir);
  const colleagueId = `usr_epoch-firm_colleague`;
  const colleagueDeviceId = `dev_epoch-firm_colleague`;
  const colleagueKeys = generateDeviceKeys();
  const cert: DeviceCertificate = issueDeviceCertificate(root.privateKeyPem, {
    certId: `cert_${colleagueDeviceId}_t1`,
    memberId: colleagueId,
    deviceId: colleagueDeviceId,
    role: "lawyer",
    signPublicKeyPem: colleagueKeys.signPublicKeyPem,
    encPublicKeyPem: colleagueKeys.encPublicKeyPem,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
  });
  db.run(
    `INSERT INTO devices (device_id, tenant_id, member_id, role, sign_pub_pem, enc_pub_pem, cert_json, status, key_epoch_at_issue)
     VALUES (?,?,?,?,?,?,?, 'active', 1)`,
    [colleagueDeviceId, tenantId, colleagueId, "lawyer", colleagueKeys.signPublicKeyPem, colleagueKeys.encPublicKeyPem, JSON.stringify(cert)],
  );

  // add：为对方 active 设备补包裹（当前 epoch=1）
  const add = await inv("matters.members.add", { matter_id: matter.matter_id, user_id: colleagueId });
  assert.equal(add.devices_wrapped, 1);
  assert.equal(add.epoch, 1);
  // 双方设备解出同一把事项密钥
  const hostKeys = getDeviceKeys(keysDir);
  const hostWrap = db.get(`SELECT wrapped_key FROM matter_keys WHERE matter_id = ? AND epoch = 1 AND wrapped_for = ?`, [matter.matter_id, hostDeviceId]) as any;
  const colWrap = db.get(`SELECT wrapped_key FROM matter_keys WHERE matter_id = ? AND epoch = 1 AND wrapped_for = ?`, [matter.matter_id, colleagueDeviceId]) as any;
  assert.ok(hostWrap && colWrap, "双方设备都应有 epoch=1 包裹行");
  const k1 = unwrapMatterKey(hostWrap.wrapped_key, hostKeys.encPrivateKeyPem);
  const k2 = unwrapMatterKey(colWrap.wrapped_key, colleagueKeys.encPrivateKeyPem);
  assert.deepEqual(k2, k1, "同事设备应解出同一把事项密钥");
  // recovery 包裹行存在
  assert.ok(db.get(`SELECT 1 AS x FROM matter_keys WHERE matter_id = ? AND epoch = 1 AND wrapped_for = 'recovery'`, [matter.matter_id]));

  // remove：轮换新纪元；同事设备解不开新密钥；旧纪元行保留
  const rm = await inv("matters.members.remove", { matter_id: matter.matter_id, user_id: colleagueId });
  assert.equal(rm.new_epoch, 2);
  const newHostWrap = db.get(`SELECT wrapped_key FROM matter_keys WHERE matter_id = ? AND epoch = 2 AND wrapped_for = ?`, [matter.matter_id, hostDeviceId]) as any;
  assert.ok(newHostWrap, "剩余成员设备应有 epoch=2 包裹行");
  const k3 = unwrapMatterKey(newHostWrap.wrapped_key, hostKeys.encPrivateKeyPem);
  assert.notDeepEqual(k3, k1, "轮换后应为新事项密钥");
  assert.throws(() => unwrapMatterKey(newHostWrap.wrapped_key, colleagueKeys.encPrivateKeyPem), (e: any) => e.code === "unwrap_failed");
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM matter_keys WHERE matter_id = ? AND epoch = 1`, [matter.matter_id])!.n, 3, "旧纪元行保留（host+colleague+recovery）");
  assert.ok(db.get(`SELECT 1 AS x FROM key_epochs WHERE scope = 'matter' AND scope_id = ? AND epoch = 2`, [matter.matter_id]));
  assert.ok(db.get(`SELECT 1 AS x FROM audit_events WHERE action = 'matter.member_remove' AND object_id = ?`, [matter.matter_id]));

  // 新纪元 recovery 包裹行存在，且能用分持份额重组的托管私钥解出新事项密钥（§5.3 破窗路径的密码学可行性端到端自测）
  const rec2 = db.get(`SELECT wrapped_key FROM matter_keys WHERE matter_id = ? AND epoch = 2 AND wrapped_for = 'recovery'`, [matter.matter_id]) as any;
  assert.ok(rec2, "新纪元应有 recovery 包裹行");
  const shares = [1, 2, 3].map((x) => {
    const s = JSON.parse(readFileSync(join(keysDir, "recovery-shares", `share-${x}.json`), "utf8")) as { x: number; y: string; privateKeyHash: string };
    return { x: s.x, y: b64urlDecode(s.y), hash: s.privateKeyHash };
  });
  const combined = combineRecoveryPrivateKey(shares.map((s) => ({ x: s.x, y: s.y })), shares[0]!.hash);
  assert.equal(combined.ok, true, "3 份份额应重组出托管私钥");
  if (combined.ok) {
    assert.deepEqual(unwrapMatterKey(rec2.wrapped_key, combined.privateKeyPem), k3, "托管私钥应解出新纪元事项密钥");
  }

  // ── 吊销与撤权校验 ──
  const before1 = await inv("devices.list");
  assert.equal(before1.tenant_epoch, 1);
  const rv = await inv("devices.revoke", { device_id: hostDeviceId, reason: "测试吊销" });
  assert.equal(rv.tenant_epoch, 2);
  assert.ok(db.get(`SELECT 1 AS x FROM key_epochs WHERE scope = 'tenant' AND scope_id = ? AND epoch = 2`, [tenantId]));
  assert.ok(db.get(`SELECT 1 AS x FROM audit_events WHERE action = 'device.revoke' AND object_id = ?`, [hostDeviceId]));
  const devRow = db.get(`SELECT status, revoked_epoch FROM devices WHERE device_id = ?`, [hostDeviceId]) as any;
  assert.equal(devRow.status, "revoked");
  assert.equal(devRow.revoked_epoch, 2);

  // 撤权校验不依赖时钟（§5.2）：吊销设备引用旧纪元的事件一律拒收
  assert.throws(
    () => assertIncomingEventAcceptable(db, { signerDeviceId: hostDeviceId, keyEpoch: 1 }),
    (e: any) => e.code === "revoked_device_event" && e.httpStatus === 403,
  );
  assertIncomingEventAcceptable(db, { signerDeviceId: hostDeviceId, keyEpoch: 2 }); // 不抛
  assertIncomingEventAcceptable(db, { signerDeviceId: colleagueDeviceId, keyEpoch: 1 }); // 未吊销设备不抛
  assert.throws(() => assertIncomingEventAcceptable(db, { signerDeviceId: "dev_ghost", keyEpoch: 9 }), (e: any) => e.code === "revoked_device_event");

  // 无权吊销：调用方 membership 非管理员/合伙人 → forbidden（临时改本机身份角色再还原）
  db.run(`UPDATE memberships SET role = 'lawyer' WHERE tenant_id = ? AND user_id = ?`, [tenantId, kernel.identity.userId]);
  await assert.rejects(() => inv("devices.revoke", { device_id: colleagueDeviceId }), (e: any) => e.code === "forbidden" || /管理员或合伙人/.test(e.message));
  db.run(`UPDATE memberships SET role = 'firm_admin' WHERE tenant_id = ? AND user_id = ?`, [tenantId, kernel.identity.userId]);
});
