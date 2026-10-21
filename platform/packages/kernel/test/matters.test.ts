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
  // 依据待确认：预览按强制结果写“不会发送”（复核 S5-A08）
  assert.match(est.data_where.preview, /^不会发送：四项依据/);
  assert.match(est.data_where.warning, /四项依据/);
  assert.match(est.data_where.warning, /告知函/);
  // 依据齐备：预览写明发往哪里、哪些替换为代号
  const { matter: ok } = await inv("matters.create", {
    title: "预览测试（齐备）",
    stance: "受让方",
    basis: { engagement: "confirmed", personal_info: "confirmed", sensitive: "not_applicable", subprocessor: "confirmed" },
  });
  const doc2 = await importText(inv, ok.matter_id, "协议.txt", DEMO_CONTRACT);
  const est2 = await inv("runs.estimate", { matter_id: ok.matter_id, scenario: "s1.contract_review", document_version_ids: [doc2.document_version_id] });
  assert.match(est2.data_where.preview, /^将发送：/);
  assert.match(est2.data_where.preview, /替换为代号/);
  assert.match(est2.data_where.preview, /每一次发送都记在本任务的“数据去向”里/);
  assert.doesNotMatch(est2.data_where.preview, /令牌化|出站|上游|网关/, "完整说明也用律师话（v9.4）");
  assert.ok(est2.data_where.bullets.length >= 3 && est2.data_where.bullets.every((b: string) => [...b].length <= 40), "要点每句 ≤ 40 字（v9.4 U1 §3.3）");
  // 隐私安全增量评审 P0-3：如实写明以原文发送的类别与上游留存口径
  assert.match(est2.data_where.preview, /以原文发送的有：机构名称、案情事实、金额、日期、条款文字与案号（未能识别的姓名也会以原文发送）/);
  assert.match(est2.data_where.preview, /AI 服务方是否保存，以其企业协议为准/);
  assert.equal(est2.data_where.warning, null);
  const estLocal = await inv("runs.estimate", { matter_id: matter.matter_id, scenario: "s6.redaction", document_version_ids: [doc.document_version_id] });
  assert.match(estLocal.data_where.preview, /全部在这台电脑上完成/);
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

test("事项列表常显数据级别与依据（第 03 篇 §4.1；复核 S5-A05）：L3a、L3b 不再被标成 L2；依据按内核判定（含拒绝记录）", async () => {
  const { inv } = tk;
  const full = { engagement: "confirmed", personal_info: "confirmed", sensitive: "confirmed", subprocessor: "confirmed" };
  const { matter: a } = await inv("matters.create", { title: "列表-高敏", stance: "原告", confidentiality: "high", basis: full });
  const { matter: b } = await inv("matters.create", { title: "列表-当事人限制", stance: "原告", confidentiality: "strict", basis: full });
  const { matter: c } = await inv("matters.create", { title: "列表-拒绝记录", stance: "原告", consent_status: "refused" });
  const { matter: d } = await inv("matters.create", { title: "列表-拒绝云端用私有模型", stance: "原告", consent_status: "refused", model_endpoint: "private" });
  const list = (await inv("matters.list", {})).matters as any[];
  const by = (id: string) => list.find((m) => m.matter_id === id);
  assert.equal(by(a.matter_id).data_level, "L3a");
  assert.equal(by(b.matter_id).data_level, "L3b");
  assert.equal(by(a.matter_id).basis_complete, true);
  assert.equal(by(c.matter_id).basis_complete, false, "拒绝云端处理的记录：标准端点下依据不齐备");
  assert.equal(by(d.matter_id).basis_complete, true, "只拒绝云端时可用律所私有模型（第 02 篇 §8.2 L3b 行）");
});

test("材料用途（v9.2 Y4 §5 D-4）：我方 / 对方 / 参考可设、可清除；事项材料清单带出；非法值拒绝；记审计", async () => {
  const { makeKernel: mk, importText: imp } = await import("./helpers.ts");
  const tk = await mk({}, "doc-roles");
  try {
    const { matter } = await tk.inv("matters.create", { title: "用途标注", stance: "原告", consent_status: "not_required" });
    const doc = await imp(tk.inv, matter.matter_id, "对方回函.txt", "对方回函正文。");
    await tk.inv("materials.set_role", { document_version_id: doc.document_version_id, role: "theirs" });
    let got = await tk.inv("matters.get", { matter_id: matter.matter_id });
    assert.equal(got.documents.find((d: any) => d.document_version_id === doc.document_version_id).role, "theirs");
    await assert.rejects(() => tk.inv("materials.set_role", { document_version_id: doc.document_version_id, role: "mine" }), (e: any) => e.code === "validation");
    await tk.inv("materials.set_role", { document_version_id: doc.document_version_id, role: null });
    got = await tk.inv("matters.get", { matter_id: matter.matter_id });
    assert.equal(got.documents.find((d: any) => d.document_version_id === doc.document_version_id).role ?? null, null);
    assert.ok(tk.kernel.db.get(`SELECT 1 AS x FROM audit_events WHERE action = 'materials.set_role'`));
    await assert.rejects(() => tk.inv("materials.set_role", { document_version_id: "nope", role: "ours" }), (e: any) => e.code === "not_found");
  } finally {
    await tk.kernel.close();
  }
});
