/**
 * 结案归档导出（第 02 篇 §9.13 开放格式；审计 P1-2）：清单签名可离线核对；每个文件 hash 与清单一致；导入原件逐字节一致；
 * 成果里的代号已还原；签名事件链的业务行原样导出，能按第 02 篇 §6.4 的口径重算出见证的 payload_hash；已删除事项不能导出。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { readZipEntries } from "@zr-legal/docx-engine";
import { canonicalJson, sha256B64, SoftwareSigner, verifyBytes } from "@zr-legal/keys";
import { findTokens } from "@zr-legal/tokenizer";
import { importText, makeKernel, runScenario, type TestKernel } from "./helpers.ts";
import { buildMatterArchive } from "../src/services/matter-archive.ts";
import { MatterTokenStore } from "../src/egress/matter-tokens.ts";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "archive-firm");
});
after(async () => {
  await tk.kernel.close();
});

test("归档：签名可核、文件 hash 一致、原件逐字节一致、代号已还原、链上业务行可重算", { timeout: 180_000 }, async () => {
  const db = tk.kernel.db;
  const { matter } = await tk.inv("matters.create", { title: "归档演示", client_name: "甲公司", stance: "买方", consent_status: "agreed" });
  const text = "第一条 甲方应于三十日内付款。联系人电话 13912345678。\n第二条 违约金为合同总额的百分之五。";
  const doc = await importText(tk.inv, matter.matter_id, "采购合同.txt", text);
  await runScenario(tk.inv, matter.matter_id, "s1.contract_review", { document_version_ids: [doc.document_version_id] }, 120_000);

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signPriv = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const signPub = publicKey.export({ type: "spki", format: "pem" }).toString();
  const out = buildMatterArchive(
    {
      db,
      blobs: tk.kernel.blobs,
      tokens: new MatterTokenStore(db),
      deviceId: "dev_test",
      signer: new SoftwareSigner(signPriv),
      deviceCert: { certId: "cert_test", deviceId: "dev_test", signPublicKeyPem: signPub } as any,
      firmRootPublicKeyPem: "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----\n",
    },
    matter.matter_id,
    { by: tk.kernel.identity.userId },
  );
  const files = readZipEntries(out.zip);
  const manifestJson = files.get("manifest.json")!.toString("utf8");
  const manifest = JSON.parse(manifestJson);
  // 1. 清单签名
  assert.equal(manifestJson, canonicalJson(manifest), "清单是规范 JSON");
  assert.equal(verifyBytes(signPub, new TextEncoder().encode(manifestJson), files.get("manifest.sig")!.toString("utf8")), true);
  // 2. 每个文件 hash 与清单一致，清单列出的文件都在
  for (const f of manifest.files) {
    const data = files.get(f.path);
    assert.ok(data, `缺 ${f.path}`);
    assert.equal(createHash("sha256").update(data!).digest("hex"), f.sha256, f.path);
  }
  // 3. 原件逐字节一致
  const mat = [...files.keys()].find((k) => k.startsWith("materials/"))!;
  assert.equal(files.get(mat)!.toString("utf8"), text);
  // 4. 成果与风险卡里没有残留代号
  for (const [k, v] of files) {
    if (k.startsWith("artifacts/") && /\.(md|txt|json)$/.test(k)) assert.equal(findTokens(v.toString("utf8")).length, 0, k);
  }
  assert.equal(findTokens(files.get("review/risk-cards.json")!.toString("utf8")).length, 0);
  assert.ok(manifest.counts.artifacts >= 1);
  // 5. 链：每个 run_event 业务行能重算出见证的 payload_hash
  const lines = files.get("ledger.jsonl")!.toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
  const signed = new Map(lines.filter((l) => l.type === "signed_event").map((l) => [`${l.kind}:${l.ref_id}`, l]));
  const runRows = lines.filter((l) => l.type === "business_row" && l.kind === "run_event");
  assert.ok(runRows.length > 0);
  for (const r of runRows) {
    const row = r.row;
    const recomputed = sha256B64(canonicalJson({ run_id: row.run_id, attempt_id: row.attempt_id, seq: row.seq, type: row.type, payload: JSON.parse(row.payload) }));
    assert.equal(recomputed, signed.get(`run_event:${r.ref_id}`)!.payload_hash);
  }
  // 6. 已删除事项不能导出
  db.run(`UPDATE matters SET lifecycle = 'purged' WHERE matter_id = ?`, [matter.matter_id]);
  assert.throws(() => buildMatterArchive({ db, blobs: tk.kernel.blobs, deviceId: "d", signer: new SoftwareSigner(signPriv), deviceCert: {} as any, firmRootPublicKeyPem: "" }, matter.matter_id, { by: "u" }), /已删除/);
});

test("接口：事项负责人导出归档、记审计；签名用本机设备证书（复核 C-A14 接线）", { timeout: 120_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "接口归档", stance: "原告", consent_status: "agreed" });
  await importText(tk.inv, matter.matter_id, "起诉状草稿.txt", "原告诉称……");
  const r = await tk.inv("matters.archive", { matter_id: matter.matter_id });
  const zip = Buffer.from(r.data_base64, "base64");
  assert.equal(createHash("sha256").update(zip).digest("hex"), r.sha256);
  const files = readZipEntries(zip);
  const cert = JSON.parse(files.get("signer-cert.json")!.toString("utf8"));
  assert.equal(verifyBytes(cert.signPublicKeyPem, new TextEncoder().encode(files.get("manifest.json")!.toString("utf8")), files.get("manifest.sig")!.toString("utf8")), true);
  assert.equal(r.counts.materials, 1);
  assert.ok(tk.kernel.db.get(`SELECT 1 AS x FROM audit_events WHERE action = 'matter.archive_exported' AND object_id = ?`, [matter.matter_id]));
});
