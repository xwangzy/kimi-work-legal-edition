/**
 * v9.4 第 21 批（评审 S1 §4“律师勾选项写入签发记录未核实”）：复核页“你来核对”的勾选写进签发记录——
 * 界面只交序号，内核按本任务方法的自检清单换成条目原文，签进 signed_payload（完整性单 hash 也覆盖）；序号越界或重复的拒绝。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { decideAllCitations, DEMO_CONTRACT, importText, makeKernel, runScenario, type TestKernel } from "./helpers.ts";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "lawyer-checklist-firm");
});
after(async () => {
  await tk.kernel.close();
});

test("你来核对：勾上的条目原文签进签发记录；越界、重复的序号拒绝", { timeout: 240_000 }, async () => {
  const { inv, kernel } = tk;
  const { matter } = await inv("matters.create", { title: "勾选留痕", stance: "受让方", consent_status: "not_required", key_dates: { analysis_as_of: "2026-10-01" } });
  const doc = await importText(inv, matter.matter_id, "协议.txt", DEMO_CONTRACT);
  const d = await runScenario(inv, matter.matter_id, "s1.contract_review", { document_version_ids: [doc.document_version_id], topic_hint: "保密义务" }, 120_000);
  const art = d.artifacts.find((a: any) => a.kind === "s1_opinion");
  const c = await inv("review.completeness", { artifact_version_id: art.artifact_version_id });
  const items: string[] = c.lawyer_checklist.items;
  assert.equal(c.lawyer_checklist.skill, "contract-review");
  assert.ok(items.length >= 3, "合同审查方法有自检清单");
  await inv("review.submit", { artifact_version_id: art.artifact_version_id });
  await decideAllCitations(inv, art.artifact_version_id);
  const base = { artifact_version_id: art.artifact_version_id, decision: "approved", expected_sha256: art.sha256 };
  await assert.rejects(inv("review.approve", { ...base, checklist: { lawyer_checked: [items.length] } }), /对不上/);
  await assert.rejects(inv("review.approve", { ...base, checklist: { lawyer_checked: [0, 0] } }), /对不上/);
  await assert.rejects(inv("review.approve", { ...base, checklist: { lawyer_checked: ["0"] } }), /对不上/);
  const ok = await inv("review.approve", { ...base, checklist: { lawyer_checked: [2, 0], reviewed_open_items: true } });
  const row = kernel.db.get<{ signed_payload: string; checklist: string }>(`SELECT signed_payload, checklist FROM approvals WHERE approval_id = ?`, [ok.approval_id])!;
  const signed = JSON.parse(row.signed_payload);
  assert.deepEqual(signed.lawyer_checklist, { skill: "contract-review", items: items.length, checked: [items[0], items[2]] });
  assert.deepEqual(JSON.parse(row.checklist).lawyer_checked_items, [items[0], items[2]], "完整性单里也是原文");
  assert.equal((await inv("approvals.verify", { approval_id: ok.approval_id })).overall, "valid");
});
