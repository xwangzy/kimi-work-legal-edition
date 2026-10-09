/**
 * 交付件端到端（内核版）：
 * S1 DOCX 进 → 修订稿（原生 w:ins/w:del）/清洁稿/意见书/问题表出；
 * S1b 回稿比对（静默改动检出）；S6 脱敏（脱敏件无修订痕迹泄露）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createDocx, readZipText, extractParagraphs } from "@zr-legal/docx-engine";
import { makeKernel, runScenario, importBytes, downloadArtifact, type TestKernel } from "./helpers.ts";

let tk: TestKernel;

before(async () => {
  tk = await makeKernel({}, "deliverables-firm");
});

after(async () => {
  await tk.kernel.close();
});

async function newMatter(title: string): Promise<any> {
  const { matter } = await tk.inv("matters.create", {
    title,
    stance: "受让方",
    consent_status: "not_required",
    key_dates: { analysis_as_of: "2026-10-01" },
  });
  return matter;
}

test("S1: DOCX 合同 → 修订稿/清洁稿/意见书/问题表（修订稿可被 Word 语义回读）", { timeout: 120_000 }, async () => {
  const { inv } = tk;
  const matter = await newMatter("S1-DOCX 端到端");
  const contractBuf = createDocx("股权转让协议（示例）", [
    { heading: "第七条 保密", paragraphs: ["7.1 乙方应当遵守《律师法》第三十八条规定的保密义务，不得泄露甲方商业秘密。", "7.2 双方其他权利义务适用《民法典》第五百零九条。"] },
    { heading: "第八条 违约责任", paragraphs: ["8.1 任何一方违约，应赔偿对方由此遭受的全部损失。"] },
  ]);
  const doc = await importBytes(inv, matter.matter_id, "股权转让协议-示例.docx", contractBuf, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  const { run, artifacts } = await runScenario(inv, matter.matter_id, "s1.contract_review", {
    document_version_ids: [doc.document_version_id],
    topic_hint: "保密义务",
  });
  assert.equal(run.status, "succeeded");
  const kinds = artifacts.map((a: any) => a.kind).sort();
  assert.deepEqual(kinds, ["s1_clean", "s1_issue_table", "s1_opinion", "s1_redline"]);

  // 修订稿：原生 w:del/w:ins + 批注
  const redline = artifacts.find((a: any) => a.kind === "s1_redline");
  const redlineBuf = await downloadArtifact(inv, redline.artifact_version_id);
  const xml = readZipText(redlineBuf, "word/document.xml")!;
  assert.match(xml, /<w:delText[^>]*>《律师法》第三十八条<\/w:delText>/);
  assert.match(xml, /<w:ins\b[^>]*>[\s\S]*?《中华人民共和国律师法》第四十一条/);
  assert.match(xml, /w:author="Kimi Work 法律发行版（AI 建议）"/);

  // 清洁稿：无修订痕迹、定稿文本正确
  const cleanArt = artifacts.find((a: any) => a.kind === "s1_clean");
  const cleanBuf = await downloadArtifact(inv, cleanArt.artifact_version_id);
  const cleanXml = readZipText(cleanBuf, "word/document.xml")!;
  assert.ok(!/<w:del\b/.test(cleanXml) && !/<w:ins\b/.test(cleanXml));
  assert.ok(cleanXml.includes("《中华人民共和国律师法》第四十一条"));

  await downloadArtifact(inv, artifacts.find((a: any) => a.kind === "s1_opinion").artifact_version_id);
  await downloadArtifact(inv, artifacts.find((a: any) => a.kind === "s1_issue_table").artifact_version_id);

  // 修订桥指令可供宿主加载项取用
  const ops = await inv("artifacts.revisionOps", { artifact_version_id: redline.artifact_version_id });
  assert.equal(ops.ops.length, 1);
  assert.ok(ops.writeback_contract.on_anchor_mismatch.includes("停止"));
});

test("S1b: 回稿比对检出静默改动并产出报告与差异表（本机完成，不调用模型）", { timeout: 120_000 }, async () => {
  const { inv } = tk;
  const matter = await newMatter("S1b 比对");
  const baseBuf = createDocx("股权转让协议", [
    { heading: "第八条 违约责任", paragraphs: ["8.1 任何一方违约，应赔偿对方由此遭受的全部损失。"] },
  ]);
  const replyBuf = createDocx("股权转让协议", [
    { heading: "第八条 违约责任", paragraphs: ["8.1 任何一方违约，应赔偿对方由此遭受的直接损失（不含间接损失）。"] },
  ]);
  const baseDoc = await importBytes(inv, matter.matter_id, "我方稿.docx", baseBuf, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  const replyDoc = await importBytes(inv, matter.matter_id, "对方回稿.docx", replyBuf, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  const { run, artifacts, events } = await runScenario(inv, matter.matter_id, "s1b.draft_compare", {
    baseline_document_version_id: baseDoc.document_version_id,
    current_document_version_id: replyDoc.document_version_id,
  });
  assert.equal(run.status, "succeeded");
  const cmp = events.find((e: any) => e.type === "compare.completed");
  assert.equal(cmp.payload.silent, 1, "对方未开修订的改动应判为静默");
  assert.ok(artifacts.some((a: any) => a.kind === "s1b_report"));
  assert.ok(artifacts.some((a: any) => a.kind === "s1b_diff_table"));
  // S1b 不调用模型：数据去向应为零记录
  const eg = await inv("egress.records", { run_id: run.run_id });
  assert.equal(eg.records.length, 0, "回稿比对在本机完成，无外发");
});

test("S6: 脱敏件遮盖直接标识符且不留修订痕迹，附脱敏报告（本机完成）", { timeout: 120_000 }, async () => {
  const { inv } = tk;
  const matter = await newMatter("S6 脱敏");
  const buf = createDocx("证据材料", [
    { heading: "联系记录", paragraphs: ["联系人张律师，手机 13800138000；身份证号 11010519491231002X。"] },
  ]);
  const doc = await importBytes(inv, matter.matter_id, "证据材料.docx", buf, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  const { run, artifacts } = await runScenario(inv, matter.matter_id, "s6.redaction", {
    document_version_ids: [doc.document_version_id],
  });
  assert.equal(run.status, "succeeded");
  const redacted = artifacts.find((a: any) => a.kind === "s6_redacted");
  const redactedBuf = await downloadArtifact(inv, redacted.artifact_version_id);
  const text = extractParagraphs(redactedBuf).map((p) => p.text).join("\n");
  assert.ok(!text.includes("13800138000"), "手机号不得残留");
  assert.ok(!text.includes("11010519491231002X"), "身份证号不得残留");
  assert.ok(text.includes("138****8000"), "遮盖值可见");
  const xml = readZipText(redactedBuf, "word/document.xml")!;
  assert.ok(!/<w:del\b/.test(xml), "脱敏件不得留修订痕迹（防止经修订还原）");
  assert.ok(artifacts.some((a: any) => a.kind === "s6_report"));
});
