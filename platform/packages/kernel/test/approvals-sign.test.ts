/**
 * 设备签名签发（方案 v5.0 第 4 篇 §6.3）：
 * 签发绑定最终字节 hash + 完整性单 hash；approvals.verify 出证明包（离线可验）；
 * 内容被改 → invalid；签发后吊销设备 → revoked_after_signing（签名仍有效）；
 * im_witnessed 本机不可自证（422）；外发只认 device_signature。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { verifyBytes, verifyDeviceCertificate } from "@zr-legal/keys";
import { makeKernel, runScenario, importText, DEMO_CONTRACT, type TestKernel } from "./helpers.ts";

let tk: TestKernel;
// 跨测试共享（test 1 产出，后续测试复用）
let sharedArt: any;
let sharedApproval: any;

before(async () => {
  tk = await makeKernel({}, "sign-firm");
});

after(async () => {
  await tk.kernel.close();
});

test("设备签名签发与离线验证", { timeout: 240_000 }, async () => {
  const { inv, kernel } = tk;
  const { matter } = await inv("matters.create", { title: "签发测试事项", stance: "受让方", consent_status: "not_required", key_dates: { analysis_as_of: "2026-10-01" } });
  const doc = await importText(inv, matter.matter_id, "协议.txt", DEMO_CONTRACT);
  const d = await runScenario(inv, matter.matter_id, "s1.contract_review", { document_version_ids: [doc.document_version_id], topic_hint: "保密义务" }, 120_000);
  const art = d.artifacts.find((a: any) => a.kind === "s1_opinion");
  sharedArt = art;

  // im_witnessed 本机不可自证 → 422
  await inv("review.submit", { artifact_version_id: art.artifact_version_id });
  await assert.rejects(
    () => inv("review.approve", { artifact_version_id: art.artifact_version_id, decision: "approved", expected_sha256: art.sha256, assurance_level: "im_witnessed" }),
    (e: any) => /device_signature|im_witnessed/.test(e.message),
  );

  // 设备签名签发
  const ok = await inv("review.approve", {
    artifact_version_id: art.artifact_version_id,
    decision: "approved",
    expected_sha256: art.sha256,
    checklist: { reviewed_open_items: true, audience_confirmed: true },
  });
  assert.equal(ok.assurance_level, "device_signature");
  sharedApproval = ok;

  // verify：overall valid + 证明包字段齐备
  const v1 = await inv("approvals.verify", { approval_id: ok.approval_id });
  assert.equal(v1.overall, "valid", JSON.stringify(v1));
  assert.equal(v1.artifact_hash_match, true);
  assert.equal(v1.signature_valid, true);
  assert.equal(v1.cert_chain_valid, true);
  assert.equal(v1.signer_status, "active");
  assert.equal(v1.binding_still_current, true);
  const proof = v1.proof;
  assert.ok(proof.signed_payload && proof.signature && proof.cert_json && proof.root_public_key_pem, "证明包字段齐备");

  // 离线验签：只用证明包（不查库）——证书链 + 签名 + signed_payload 内容
  const cert = JSON.parse(proof.cert_json);
  assert.deepEqual(verifyDeviceCertificate(cert, proof.root_public_key_pem), { ok: true }, "证书应通过律所根公钥验签");
  assert.equal(verifyBytes(cert.signPublicKeyPem, new TextEncoder().encode(proof.signed_payload), proof.signature), true, "signed_payload 签名离线验签通过");
  const payload = JSON.parse(proof.signed_payload);
  assert.equal(payload.artifact_sha256, art.sha256);
  assert.equal(payload.assurance_level, "device_signature");
  assert.equal(payload.signer.device_id, ok.signer_device_id);
  assert.equal(typeof payload.completeness_hash, "string");

  // 篡改成果内容一个字节 → artifact_hash_match=false → invalid
  const artRow = kernel.db.get(`SELECT storage_uri FROM artifact_versions WHERE artifact_version_id = ?`, [art.artifact_version_id]) as any;
  const blobPath = kernel.blobs.pathOf(String(artRow.storage_uri));
  const { readFileSync, writeFileSync } = await import("node:fs");
  const origBytes = readFileSync(blobPath);
  const tampered = Buffer.from(origBytes);
  tampered[0] = tampered[0]! ^ 0xff;
  writeFileSync(blobPath, tampered);
  const v2 = await inv("approvals.verify", { approval_id: ok.approval_id });
  assert.equal(v2.artifact_hash_match, false);
  assert.equal(v2.overall, "invalid");
  writeFileSync(blobPath, origBytes); // 还原
  const v3 = await inv("approvals.verify", { approval_id: ok.approval_id });
  assert.equal(v3.overall, "valid");

  // 签发后吊销该设备 → revoked_after_signing（签名仍有效，状态如实报告）
  await inv("devices.revoke", { device_id: ok.signer_device_id, reason: "测试：签发后吊销", self: true });
  const v4 = await inv("approvals.verify", { approval_id: ok.approval_id });
  assert.equal(v4.signer_status, "revoked_after_signing", JSON.stringify(v4));
  assert.equal(v4.signature_valid, true);
  assert.equal(v4.overall, "valid", "签发后吊销不影响当时签名效力");

  // 外发门禁：internal 受众按现有规则拒绝（forbidden 先于签名等级检查）
  await assert.rejects(
    () => inv("deliveries.create", { artifact_version_id: art.artifact_version_id, action: "external_send", audience: "client" }),
    (e: any) => e.code === "forbidden" || /内部稿/.test(e.message),
  );
});

test("approvals.verify：rejected 记录 invalid+原因（不抛错）；revoked_before_signing 判 invalid", { timeout: 60_000 }, async () => {
  const { inv, kernel, dir } = tk;
  const db = kernel.db;
  assert.ok(sharedArt && sharedApproval, "前置：test 1 已产出签发（且设备已吊销）");

  // rejected（批准记录形态，无签名）→ overall invalid + reason，不抛错
  const rejId = "apr_rejected_offline";
  db.run(
    `INSERT INTO approvals (approval_id, artifact_version_id, artifact_sha256, approver_id, decision, audience, assurance_level, checklist)
     VALUES (?,?,?,?,'rejected','internal','approval_record','{}')`,
    [rejId, sharedArt.artifact_version_id, sharedArt.sha256, kernel.identity.userId],
  );
  const vr = await inv("approvals.verify", { approval_id: rejId });
  assert.equal(vr.overall, "invalid");
  assert.match(vr.reason, /批准记录/);

  // revoked_before_signing：设备在 test 1 末尾已吊销；构造 signed_at 更晚的签发 → invalid
  const { getDeviceKeys, keysDirOf } = await import("../src/index.ts");
  const { signBytes, canonicalJson, sha256B64 } = await import("@zr-legal/keys");
  const keys = getDeviceKeys(keysDirOf(join(dir, "sign-firm")));
  const apId = "apr_late_signed";
  const signedPayload = canonicalJson({
    approval_id: apId,
    artifact_version_id: sharedArt.artifact_version_id,
    artifact_sha256: sharedArt.sha256,
    audience: "internal",
    completeness_hash: sha256B64(canonicalJson({})),
    signer: { member_id: kernel.identity.userId, device_id: sharedApproval.signer_device_id, cert_id: "cert_late" },
    key_epoch: 2,
    assurance_level: "device_signature",
    signed_at: new Date().toISOString(), // 晚于 revoked_at
  });
  const sig = signBytes(keys.signPrivateKeyPem, new TextEncoder().encode(signedPayload));
  db.run(
    `INSERT INTO approvals (approval_id, artifact_version_id, artifact_sha256, approver_id, decision, audience, assurance_level, checklist,
                            signer_device_id, signature, completeness_hash, key_epoch, signed_payload)
     VALUES (?,?,?,?,'approved','internal','device_signature','{}',?,?,?,?,?)`,
    [apId, sharedArt.artifact_version_id, sharedArt.sha256, kernel.identity.userId, sharedApproval.signer_device_id, sig, sha256B64(canonicalJson({})), 2, signedPayload],
  );
  const vl = await inv("approvals.verify", { approval_id: apId });
  assert.equal(vl.signer_status, "revoked_before_signing", JSON.stringify(vl));
  assert.equal(vl.signature_valid, true, "签名本身有效（确为该设备所签）");
  assert.equal(vl.overall, "invalid", "吊销前设备、签发时间更晚 → 整体判 invalid");
});
