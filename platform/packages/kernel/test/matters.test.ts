/** 事项口径与告知函（第 2 篇 §4.2 / §15.2：estimate 数据去向预览；「待取得」一键告知函）。 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeKernel, importText, DEMO_CONTRACT, type TestKernel } from "./helpers.ts";

let tk: TestKernel;

before(async () => {
  tk = await makeKernel({}, "matters-firm");
});

after(async () => {
  await tk.kernel.close();
});

test("estimate 含数据去向预览：待取得事项给出拦截预警，本机场景声明无外发", async () => {
  const { inv } = tk;
  const { matter } = await inv("matters.create", { title: "预览测试", stance: "受让方", consent_status: "pending" });
  const doc = await importText(inv, matter.matter_id, "协议.txt", DEMO_CONTRACT);
  const est = await inv("runs.estimate", { matter_id: matter.matter_id, scenario: "s1.contract_review", document_version_ids: [doc.document_version_id] });
  assert.ok(est.data_where, "estimate 应含 data_where");
  assert.equal(est.data_where.model_endpoint, "standard");
  assert.match(est.data_where.preview, /化名校验/);
  assert.match(est.data_where.warning, /待取得/);
  const estLocal = await inv("runs.estimate", { matter_id: matter.matter_id, scenario: "s6.redaction", document_version_ids: [doc.document_version_id] });
  assert.match(estLocal.data_where.preview, /本机完成/);
  assert.equal(estLocal.data_where.warning, null);
});

test("告知函：一键生成草稿并留痕，回执口径提示更新同意状态", async () => {
  const { inv, kernel } = tk;
  const { matter } = await inv("matters.create", { title: "告知函测试", stance: "受让方", client_name: "甲公司", consent_status: "pending" });
  const r = await inv("matters.consent_notice", { matter_id: matter.matter_id });
  assert.ok(r.artifact_version_id.startsWith("artv_"));
  assert.match(r.filename, /当事人告知函/);
  assert.match(r.note, /已同意/);
  const art = kernel.db.get<any>(`SELECT * FROM artifact_versions WHERE artifact_version_id = ?`, [r.artifact_version_id]);
  assert.equal(art.status, "draft", "告知函生成物为草稿，发出前须律师复核");
  const audits = kernel.db.all<any>(`SELECT * FROM audit_events WHERE action = 'matter.consent_notice' AND object_id = ?`, [matter.matter_id]);
  assert.equal(audits.length, 1, "生成告知函留审计痕");
  // 文件内容可回读且含关键条款
  const dl = await inv("artifacts.download", { artifact_version_id: r.artifact_version_id });
  const { readZipText } = await import("@zr-legal/docx-engine");
  const xml = readZipText(Buffer.from(dl.data_base64, "base64"), "word/document.xml")!;
  assert.ok(xml.includes("数据去向卡"));
  assert.ok(xml.includes("拒绝云端处理"));
});
