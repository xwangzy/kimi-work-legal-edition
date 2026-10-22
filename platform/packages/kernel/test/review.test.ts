/** 复核与签发流端到端（内核版）：提交复核 → 完整性单 → hash 绑定批准 → 版本失效 → 外发门禁 → 待我处理。 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createDocx } from "@zr-legal/docx-engine";
import { decideAllCitations, makeKernel, runScenario, importBytes, type TestKernel } from "./helpers.ts";

let tk: TestKernel;

before(async () => {
  tk = await makeKernel({}, "review-firm");
});

after(async () => {
  await tk.kernel.close();
});

async function runS1(matterId: string, docId: string): Promise<any> {
  return runScenario(tk.inv, matterId, "s1.contract_review", { document_version_ids: [docId], topic_hint: "保密义务" }, 90_000);
}

test("复核签发全链路（含版本失效与外发门禁）", { timeout: 240_000 }, async () => {
  const { inv } = tk;
  const { matter } = await inv("matters.create", {
    title: "复核流测试事项",
    stance: "受让方",
    consent_status: "not_required",
    key_dates: { analysis_as_of: "2026-10-01" },
  });
  const buf = createDocx("协议", [{ heading: "第七条", paragraphs: ["7.1 乙方应当遵守《律师法》第三十八条规定的保密义务。"] }]);
  const doc = await importBytes(inv, matter.matter_id, "协议.docx", buf, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");

  // run1 → v1 草稿
  const d1 = await runS1(matter.matter_id, doc.document_version_id);
  assert.equal(d1.run.status, "succeeded");
  const v1 = d1.artifacts.find((a: any) => a.kind === "s1_opinion");
  assert.equal(v1.version, 1);

  // 完整性单（含数据去向摘要）
  const comp = await inv("review.completeness", { artifact_version_id: v1.artifact_version_id });
  assert.equal(comp.completeness.file_integrity, "ok");
  assert.equal(comp.completeness.citations.intercepted, 1);
  assert.ok(comp.blockers.some((b: string) => b.includes("未决项")));
  assert.ok(comp.completeness.egress, "完整性单应含数据去向摘要");

  // 未提交复核不得批准
  await assert.rejects(
    () => inv("review.approve", { artifact_version_id: v1.artifact_version_id, decision: "approved", expected_sha256: v1.sha256 }),
    (e: any) => e.code === "conflict" || /状态/.test(e.message),
  );

  // 提交复核 → 待我处理可见
  await inv("review.submit", { artifact_version_id: v1.artifact_version_id });
  const pending = await inv("pending.list");
  assert.ok(pending.pending.some((p: any) => p.artifact_version_id === v1.artifact_version_id));

  // hash 不符 → approval_invalidated
  await assert.rejects(
    () => inv("review.approve", { artifact_version_id: v1.artifact_version_id, decision: "approved", expected_sha256: "0".repeat(64) }),
    (e: any) => e.code === "approval_invalidated",
  );

  // 新版本出现（run2 → v2）：旧版批准失效
  const d2 = await runS1(matter.matter_id, doc.document_version_id);
  const v2 = d2.artifacts.find((a: any) => a.kind === "s1_opinion");
  assert.equal(v2.version, 2);
  await assert.rejects(
    () => inv("review.approve", { artifact_version_id: v1.artifact_version_id, decision: "approved", expected_sha256: v1.sha256 }),
    (e: any) => e.code === "approval_invalidated",
  );

  // 批准最新版 v2
  await inv("review.submit", { artifact_version_id: v2.artifact_version_id });
  await decideAllCitations(inv, v2.artifact_version_id);
  const ok = await inv("review.approve", {
    artifact_version_id: v2.artifact_version_id,
    decision: "approved",
    expected_sha256: v2.sha256,
    checklist: { reviewed_open_items: true },
  });
  assert.equal(ok.status, "approved");
  assert.equal(ok.bound_sha256, v2.sha256);

  // 内部稿外发 → forbidden；下载留痕 → ok
  await assert.rejects(
    () => inv("deliveries.create", { artifact_version_id: v2.artifact_version_id, action: "external_send", audience: "client" }),
    (e: any) => e.code === "forbidden" || /内部稿/.test(e.message),
  );
  const dl = await inv("deliveries.create", { artifact_version_id: v2.artifact_version_id, action: "download" });
  assert.equal(dl.package_sha256, v2.sha256);

  // 已批准版本非 pending_review：退回被拒
  await assert.rejects(
    () => inv("review.approve", { artifact_version_id: v2.artifact_version_id, decision: "rejected", expected_sha256: v2.sha256 }),
    (e: any) => e.code === "conflict" || /状态/.test(e.message),
  );
});
