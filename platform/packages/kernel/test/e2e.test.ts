/**
 * 端到端冒烟（标准演示用例，内核进程内）：
 * 建事项 → 导入含《律师法》第三十八条引用的合同 → 估价 → 起任务 →
 * 事件流可见“拦截 1 条 + 改引第四十一条” → 草稿成果 → 点数结算 → 幂等与取消语义 → 数据去向记录。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeKernel, waitRun, importText, DEMO_CONTRACT, type TestKernel } from "./helpers.ts";

let tk: TestKernel;

before(async () => {
  tk = await makeKernel({}, "e2e-firm");
});

after(async () => {
  await tk.kernel.close();
});

test("e2e: 标准演示用例全链路（本机内核）", { timeout: 60_000 }, async () => {
  const { inv } = tk;
  // 1. 建事项（v5：模型端点 × 协作范围 × 当事人同意；演示合成材料选「无需」）
  const { matter } = await inv("matters.create", {
    title: "甲公司受让乙公司股权（e2e）",
    stance: "受让方",
    jurisdiction: "内地民商事",
    model_endpoint: "standard",
    collab_scope: "personal",
    consent_status: "not_required",
    key_dates: { analysis_as_of: "2026-10-01" },
  });
  assert.ok(matter.matter_id.startsWith("mat_"));
  assert.equal(matter.model_endpoint, "standard");
  assert.equal(matter.consent_status, "not_required");

  // 2. 导入合同 + hash 不符被拒
  const doc = await importText(inv, matter.matter_id, "股权转让协议-示例.txt", DEMO_CONTRACT);
  assert.ok(doc.parse_version_id);
  await assert.rejects(
    () => inv("materials.import", { matter_id: matter.matter_id, filename: "假.txt", data_base64: Buffer.from("abc").toString("base64"), sha256: "0".repeat(64) }),
    (e: any) => e.code === "hash_mismatch" || /hash/.test(e.message),
  );

  // 3. 估价 → 起任务（幂等重放）
  const est = await inv("runs.estimate", { matter_id: matter.matter_id, scenario: "s1.contract_review", document_version_ids: [doc.document_version_id], topic_hint: "保密义务" });
  assert.ok(est.points >= 30);
  const idem = `e2e-${Date.now()}`;
  const run = await inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: idem });
  const replay = await inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: idem });
  assert.equal(replay.run_id, run.run_id);
  assert.equal(replay.idempotent_replay, true);

  // 4. 等待终态
  const { run: finalRun, artifacts, events } = await waitRun(inv, run.run_id);
  assert.equal(finalRun.status, "succeeded", `事件: ${JSON.stringify(events.map((e: any) => [e.type, e.payload?.error ?? ""]))}`);

  // 5. 关键事件断言
  const types = events.map((e: any) => e.type);
  assert.deepEqual(types, [
    "run.started",
    "plan.created",
    "materials.loaded",
    "citations.verified",
    "model.completed",
    "artifact.drafted",
    "artifact.drafted",
    "run.degraded",
    "run.succeeded",
  ]);
  const cit = events.find((e: any) => e.type === "citations.verified");
  assert.equal(cit.payload.intercepted, 1, "应拦截 1 条引用（律师法第三十八条）");
  const intercepted = cit.payload.intercepted_items[0];
  assert.match(intercepted.suggestion, /第四十一条/);
  assert.match(intercepted.historical_note, /已修改/);
  assert.equal(cit.payload.where, "本机（离线核验）", "法条核验离线完成（断网演示）");
  const model = events.find((e: any) => e.type === "model.completed");
  assert.equal(model.payload.provider, "mock");
  assert.ok(model.payload.cost_microcny > 0);
  const degraded = events.find((e: any) => e.type === "run.degraded");
  assert.ok(degraded.payload.notes.some((n: string) => n.includes("非 DOCX")));

  // 6. 成果与点数
  assert.equal(finalRun.points_charged, finalRun.points_reserved);
  assert.deepEqual(artifacts.map((a: any) => a.kind).sort(), ["s1_issue_table", "s1_opinion"]);
  for (const a of artifacts) {
    assert.equal(a.status, "draft");
    assert.equal(a.audience, "internal");
  }

  // 7. 数据去向卡：mock 链路只有一条「未外发」记录
  const eg = await inv("egress.records", { run_id: run.run_id });
  assert.equal(eg.records.length, 1);
  assert.equal(eg.records[0].destination_kind, "mock_local");
  assert.ok(eg.records[0].chars > 0);

  // 8. 已完成任务不可取消
  await assert.rejects(
    () => inv("runs.cancel", { run_id: run.run_id, expected_version: 2, reason: "测试" }),
    (e: any) => e.code === "conflict" || /状态/.test(e.message),
  );
});
