/**
 * 恢复演练（§16.3 探针 11）：
 * - M-of-N 破窗：模拟「唯一成员设备丢失」（删 device.json 重引导 → 旧包裹解不开）→
 *   3 份份额重组托管私钥恢复（能解密该事项块 + 破窗审计）；2 份份额恢复失败。
 * - 单机口令：scrypt 包裹导出/口令恢复导入；错口令 bad_password。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeKernel, type TestKernel } from "./helpers.ts";

let tk: TestKernel;
let k2: { kernel: any; inv: (m: string, p?: any) => Promise<any> } | null = null;
let blobUri = "";
let matterId = "";

before(async () => {
  tk = await makeKernel({}, "drill-firm");
});

after(async () => {
  await tk.kernel.close();
  if (k2) await k2.kernel.close();
});

test("M-of-N 破窗恢复：设备丢失 → 3 份恢复成功、2 份失败", async () => {
  const { inv } = tk;
  const { matter } = await inv("matters.create", { title: "破窗恢复事项", stance: "受让方", consent_status: "not_required" });
  matterId = matter.matter_id;
  const secret = "机密内容：委托人特别授权条款（恢复演练标记）。";
  const doc = await inv("materials.import", { matter_id: matterId, filename: "机密.txt", data_base64: Buffer.from(secret, "utf8").toString("base64"), mime: "text/plain" });
  blobUri = tk.kernel.db.get<any>(`SELECT storage_uri FROM document_versions WHERE document_version_id = ?`, [doc.document_version_id]).storage_uri;
  assert.equal(tk.kernel.blobs.read(blobUri).toString("utf8"), secret);

  // 模拟设备丢失：删除本机设备私钥文件，重引导（同 workspace → 新设备密钥、同 device_id 新证书）
  await tk.kernel.close();
  rmSync(join(tk.dir, "drill-firm", "keys", "device.json"));
  const { createKernel } = await import("../src/index.ts");
  const kernel2 = await createKernel({ dataDir: tk.dir, firmSlug: "drill-firm", userSlug: "test-lawyer", env: { ...process.env, ZR_MODEL_PROVIDER: "mock" } });
  k2 = { kernel: kernel2, inv: (m, p) => kernel2.invoke(m, p) };

  // 新设备解不开旧包裹（密钥已换）——读块失败
  assert.throws(() => kernel2.blobs.read(blobUri), /密钥|unwrap|持有/);

  const shareDir = join(tk.dir, "drill-firm", "keys", "recovery-shares");
  const shares = (n: number[]) => n.map((x) => join(shareDir, `share-${x}.json`));

  // 2 份份额：恢复失败（不足 M）
  const r2 = await k2.inv("recovery.restore_matter", { matter_id: matterId, share_files: shares([1, 2]) });
  assert.equal(r2.ok, false, "2 份份额不得恢复");

  // 3 份份额：恢复成功 → 新设备可解密该事项块
  const r3 = await k2.inv("recovery.restore_matter", { matter_id: matterId, share_files: shares([1, 3, 5]) });
  assert.equal(r3.ok, true, JSON.stringify(r3));
  assert.ok(r3.break_glass.record_id, "破窗记录");
  assert.equal(kernel2.blobs.read(blobUri).toString("utf8"), secret, "恢复后可解密该事项块");
  assert.ok(kernel2.db.get(`SELECT 1 AS x FROM audit_events WHERE action = 'recovery.break_glass' AND object_id = ?`, [matterId]), "破窗审计事件");

  const st = await k2.inv("recovery.status");
  assert.equal(st.drill_completed, true, "演练计数");
});

test("单机口令：scrypt 包裹导出 / 口令恢复导入 / 错口令 bad_password", async () => {
  assert.ok(k2, "前置：k2 已启动");
  const { inv } = k2!;
  const out = await inv("recovery.export_device", { password: "律师自设口令-恢复演练" });
  assert.ok(existsSync(out.path));
  await assert.rejects(
    () => inv("recovery.import_device", { file: out.path, password: "错误口令" }),
    (e: any) => e.code === "bad_password",
  );
  const ok = await inv("recovery.import_device", { file: out.path, password: "律师自设口令-恢复演练" });
  assert.ok(ok.device_id, "口令正确即恢复设备身份");
});

test("rotate=true：恢复即轮换，被列设备解不开新内容", async () => {
  // 独立工作区（避免前序破窗的轮换污染）
  const t2 = await makeKernel({}, "drill-rotate-firm");
  try {
    const { inv, kernel } = t2;
    const { matter } = await inv("matters.create", { title: "轮换恢复事项", stance: "受让方", consent_status: "not_required" });
    // 构造 bob 设备并加为成员（wrapped at epoch 1）
    const { getFirmRootPrivateKey, keysDirOf, getDeviceKeys } = await import("../src/index.ts");
    const { generateDeviceKeys, issueDeviceCertificate, unwrapMatterKey } = await import("@zr-legal/keys");
    const { join } = await import("node:path");
    const keysDir = keysDirOf(join(t2.dir, "drill-rotate-firm"));
    const root = getFirmRootPrivateKey(keysDir);
    const bob = generateDeviceKeys();
    const cert = issueDeviceCertificate(root.privateKeyPem, {
      certId: "cert_bob_rot",
      memberId: "usr_drill-rotate-firm_bob",
      deviceId: "dev_drill-rotate-firm_bob",
      role: "lawyer",
      signPublicKeyPem: bob.signPublicKeyPem,
      encPublicKeyPem: bob.encPublicKeyPem,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
    });
    kernel.db.run(
      `INSERT INTO devices (device_id, tenant_id, member_id, role, sign_pub_pem, enc_pub_pem, cert_json, status, key_epoch_at_issue) VALUES (?,?,?,?,?,?,?, 'active', 1)`,
      ["dev_drill-rotate-firm_bob", kernel.identity.tenantId, "usr_drill-rotate-firm_bob", "lawyer", bob.signPublicKeyPem, bob.encPublicKeyPem, JSON.stringify(cert)],
    );
    await inv("matters.members.add", { matter_id: matter.matter_id, user_id: "usr_drill-rotate-firm_bob" });
    const doc = await inv("materials.import", { matter_id: matter.matter_id, filename: "x.txt", data_base64: Buffer.from("轮换前内容").toString("base64"), mime: "text/plain" });
    void doc;

    // rotate=true 且把 bob 设备列为吊销候选 → epoch+1 只包裹给 host(+recovery)
    const shareDir = join(t2.dir, "drill-rotate-firm", "keys", "recovery-shares");
    const r = await inv("recovery.restore_matter", {
      matter_id: matter.matter_id,
      share_files: [1, 2, 3].map((x) => join(shareDir, `share-${x}.json`)),
      rotate: true,
      revoke_device_ids: ["dev_drill-rotate-firm_bob"],
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.rotated, true);
    assert.equal(r.epoch, 2);
    assert.equal(kernel.db.get(`SELECT 1 AS x FROM matter_keys WHERE matter_id = ? AND epoch = 2 AND wrapped_for = 'dev_drill-rotate-firm_bob'`, [matter.matter_id]), undefined, "bob 无新纪元包裹");
    // bob 私钥解不开 epoch 2 的恢复包裹行（GCM 失败）；host 正常
    const rec2 = kernel.db.get<any>(`SELECT wrapped_key FROM matter_keys WHERE matter_id = ? AND epoch = 2 AND wrapped_for = 'recovery'`, [matter.matter_id]);
    assert.throws(() => unwrapMatterKey(rec2.wrapped_key, bob.encPrivateKeyPem), (e: any) => e.code === "unwrap_failed");
    // host 以新纪元写入新块并可读
    const d2 = await inv("materials.import", { matter_id: matter.matter_id, filename: "y.txt", data_base64: Buffer.from("轮换后内容").toString("base64"), mime: "text/plain" });
    const uri2 = kernel.db.get<any>(`SELECT storage_uri FROM document_versions WHERE document_version_id = ?`, [d2.document_version_id]).storage_uri;
    assert.equal(kernel.blobs.read(uri2).toString("utf8"), "轮换后内容", "host 用新纪元密钥读写正常");
    // 设备私钥仍可解 epoch 1 旧块（旧纪元行保留）
    const uri1 = kernel.db.get<any>(`SELECT storage_uri FROM document_versions WHERE filename = 'x.txt'`, []).storage_uri;
    assert.equal(kernel.blobs.read(uri1).toString("utf8"), "轮换前内容", "旧纪元旧块仍可读");
    void getDeviceKeys;
  } finally {
    await t2.kernel.close();
  }
});
