/**
 * 材料块按事项密钥加密（§5.1 收尾）：密文落盘无明文、读路径透明、自描述块头（epoch/事项）、
 * 轮换后旧块可读新块用新纪元、明文 hash 寻址不变、_shared 例外形态。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { blobHeaderOf, isSealedBlob } from "../src/blobs.ts";
import { makeKernel, runScenario, DEMO_CONTRACT, type TestKernel } from "./helpers.ts";

let tk: TestKernel;

before(async () => {
  tk = await makeKernel({}, "cipher-firm");
});

after(async () => {
  await tk.kernel.close();
});

function allBlobFiles(dir: string): string[] {
  const out: string[] = [];
  for (const scope of readdirSync(dir, { withFileTypes: true })) {
    if (!scope.isDirectory()) continue;
    for (const f of readdirSync(join(dir, scope.name))) {
      if (!f.startsWith(".")) out.push(join(dir, scope.name, f));
    }
  }
  return out;
}

test("导入即密文：落盘无明文片段、自描述块头、读路径透明还原", async () => {
  const { inv, kernel } = tk;
  const { matter } = await inv("matters.create", { title: "块加密测试", stance: "受让方", consent_status: "not_required", key_dates: { analysis_as_of: "2026-10-01" } });
  const secret = "机密条款：违约金上限为合同总额百分之三十（密文断言用标记）。";
  const doc = await inv("materials.import", {
    matter_id: matter.matter_id,
    filename: "机密.txt",
    data_base64: Buffer.from(secret, "utf8").toString("base64"),
    mime: "text/plain",
  });
  assert.ok(doc.document_version_id);

  // 落盘字节：magic 头 + 无明文片段
  const files = allBlobFiles(kernel.blobs.dir);
  assert.ok(files.length >= 1);
  const raw = readFileSync(files[0]!);
  assert.equal(isSealedBlob(raw), true, "应为 KWB1 封装");
  const head = blobHeaderOf(raw)!;
  assert.equal(head.matterId, matter.matter_id);
  assert.equal(head.epoch, 1);
  assert.equal(raw.includes(Buffer.from("机密条款", "utf8")), false, "落盘不得含明文片段");
  assert.equal(raw.includes(Buffer.from("密文断言用标记", "utf8")), false);

  // 读路径透明（调用方无感）
  const dv = kernel.db.get<any>(`SELECT storage_uri FROM document_versions WHERE document_version_id = ?`, [doc.document_version_id]);
  const back = kernel.blobs.read(dv.storage_uri).toString("utf8");
  assert.equal(back, secret, "blobs.read 应透明解密还原");
});

test("派生块同样加密且全链可用（S1 成果重算/下载不回归）", { timeout: 180_000 }, async () => {
  const { inv, kernel } = tk;
  const { matter } = await inv("matters.create", { title: "块加密 S1", stance: "受让方", consent_status: "not_required", key_dates: { analysis_as_of: "2026-10-01" } });
  const doc = await inv("materials.import", { matter_id: matter.matter_id, filename: "协议.txt", data_base64: Buffer.from(DEMO_CONTRACT, "utf8").toString("base64"), mime: "text/plain" });
  const d = await runScenario(inv, matter.matter_id, "s1.contract_review", { document_version_ids: [doc.document_version_id] }, 120_000);
  assert.equal(d.run.status, "succeeded");
  // 所有落盘块均为密文
  for (const f of allBlobFiles(kernel.blobs.dir)) {
    const raw = readFileSync(f);
    if (raw.length > 16) assert.equal(isSealedBlob(raw), true, `${f} 应为密文块`);
  }
  // 下载透明（hash 校验与明文内容）
  const art = d.artifacts.find((a: any) => a.kind === "s1_opinion");
  const dl = await inv("artifacts.download", { artifact_version_id: art.artifact_version_id });
  assert.equal(dl.sha256, art.sha256);
  const text = Buffer.from(dl.data_base64, "base64").toString("utf8");
  assert.ok(text.length > 50);
});

test("密钥轮换：旧块按旧纪元可读、新块用新纪元", async () => {
  const { inv, kernel } = tk;
  const { matter } = await inv("matters.create", { title: "轮换块测试", stance: "受让方", consent_status: "not_required" });
  const b1 = await inv("materials.import", { matter_id: matter.matter_id, filename: "v1.txt", data_base64: Buffer.from("第一纪元内容").toString("base64"), mime: "text/plain" });
  const uri1 = kernel.db.get<any>(`SELECT storage_uri FROM document_versions WHERE document_version_id = ?`, [b1.document_version_id]).storage_uri;
  assert.equal(blobHeaderOf(readFileSync(kernel.blobs.pathOf(uri1)))!.epoch, 1);

  // 加移成员触发轮换（纪元 2）
  const { getFirmRootPrivateKey, keysDirOf } = await import("../src/index.ts");
  const { generateDeviceKeys, issueDeviceCertificate } = await import("@zr-legal/keys");
  const { join: j } = await import("node:path");
  const keysDir = keysDirOf(j(tk.dir, "cipher-firm"));
  const root = getFirmRootPrivateKey(keysDir);
  const other = generateDeviceKeys();
  const otherId = "usr_cipher-firm_other";
  const cert = issueDeviceCertificate(root.privateKeyPem, {
    certId: "cert_other_t1",
    memberId: otherId,
    deviceId: "dev_cipher-firm_other",
    role: "lawyer",
    signPublicKeyPem: other.signPublicKeyPem,
    encPublicKeyPem: other.encPublicKeyPem,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
  });
  kernel.db.run(
    `INSERT INTO devices (device_id, tenant_id, member_id, role, sign_pub_pem, enc_pub_pem, cert_json, status, key_epoch_at_issue) VALUES (?,?,?,?,?,?,?, 'active', 1)`,
    ["dev_cipher-firm_other", kernel.identity.tenantId, otherId, "lawyer", other.signPublicKeyPem, other.encPublicKeyPem, JSON.stringify(cert)],
  );
  await inv("matters.members.add", { matter_id: matter.matter_id, user_id: otherId });
  await inv("matters.members.remove", { matter_id: matter.matter_id, user_id: otherId });
  assert.equal(kernel.db.get<any>(`SELECT MAX(epoch) AS e FROM matter_keys WHERE matter_id = ?`, [matter.matter_id]).e, 2);

  const b2 = await inv("materials.import", { matter_id: matter.matter_id, filename: "v2.txt", data_base64: Buffer.from("第二纪元内容").toString("base64"), mime: "text/plain" });
  const uri2 = kernel.db.get<any>(`SELECT storage_uri FROM document_versions WHERE document_version_id = ?`, [b2.document_version_id]).storage_uri;
  assert.equal(blobHeaderOf(readFileSync(kernel.blobs.pathOf(uri2)))!.epoch, 2, "新块用新纪元");

  // 旧块仍可读（本机持有旧纪元密钥；旧成员曾持有旧密钥，不重加密）
  assert.equal(kernel.blobs.read(uri1).toString("utf8"), "第一纪元内容");
  assert.equal(kernel.blobs.read(uri2).toString("utf8"), "第二纪元内容");
});
