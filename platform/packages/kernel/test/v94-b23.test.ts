/**
 * v9.4 第 23 批（复核 Q4 建议 3 的余项）：
 * - 事项模板核对立场：立场不在模板的常见立场里，填了起算日的拒绝（期限按模板的一方推算），没填的照常创建并标出；
 * - 示例事项只读的内核门禁：阶段与事件时点、待办、审查要点（含 AI 草稿）、提醒在示例事项上一律拒绝；看材料、发起任务照常。
 * （离所时清除个人设置的用例在 member-offboarding.test.ts。）
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { makeKernel, type TestKernel } from "./helpers.ts";
import { proposeDraft } from "../src/services/review-rules.ts";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "b23-firm");
});
after(async () => {
  await tk.kernel.close();
});

test("事项模板核对立场：填了起算日、立场又对不上的拒绝创建；没填起算日的照常创建并标出", async () => {
  const { inv } = tk;
  const n0 = tk.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM matters`)!.n;
  // “合同纠纷一审（应诉）”按被告推答辩期：原告不该得到一个答辩期届满日
  await assert.rejects(
    inv("matters.create", { title: "立场不符", stance: "原告", consent_status: "agreed", template_id: "lit-contract-defendant", template_start: "2026-10-09" }),
    /按被告一方推算.*我方立场是“原告”/,
  );
  assert.equal(tk.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM matters`)!.n, n0, "失败时不留半个事项");
  const ok = await inv("matters.create", { title: "立场不符但没填起算日", stance: "原告", consent_status: "agreed", template_id: "lit-contract-defendant" });
  assert.equal(ok.template_applied.stance_mismatch, true);
  assert.equal(ok.template_applied.deadline, null);
  assert.deepEqual(ok.matter.key_dates, {});
  const fit = await inv("matters.create", { title: "立场相符", stance: "被告", consent_status: "agreed", template_id: "lit-contract-defendant", template_start: "2026-10-09" });
  assert.equal(fit.template_applied.stance_mismatch, false);
  // 多个常见立场的模板：其中任一个都算相符
  const deal = await inv("matters.create", { title: "合同审查", stance: "卖方", consent_status: "agreed", template_id: "deal-contract" });
  assert.equal(deal.template_applied.stance_mismatch, false);
  // 同一方的别的叫法（复核 Q5-04）：劳动仲裁里劳动者就是申请人、用人单位就是被申请人，期限一样，照常推算
  const emp = await inv("matters.create", { title: "劳动者申请", stance: "申请人", consent_status: "agreed", template_id: "labor-employee", template_start: "2026-10-09" });
  assert.equal(emp.template_applied.stance_mismatch, false);
  assert.ok(emp.template_applied.deadline);
  const er = await inv("matters.create", { title: "用人单位应诉", stance: "被申请人", consent_status: "agreed", template_id: "labor-employer", template_start: "2026-10-09" });
  assert.ok(er.template_applied.deadline);
  await assert.rejects(inv("matters.create", { title: "x", stance: "被申请人", consent_status: "agreed", template_id: "labor-employee", template_start: "2026-10-09" }), /按劳动者一方推算/);
});

test("示例事项只读（内核门禁）：阶段、事件时点、地域、关键日期、待办、审查要点、提醒、从范本整理的任务都拒绝；事项详情与材料照常", async () => {
  const { inv } = tk;
  const s = await inv("samples.install", {});
  const mid = s.matter_id as string;
  const ro = (p: Promise<unknown>) => assert.rejects(p, (e: any) => e.code === "validation" && /示例事项只用来看效果/.test(e.message));
  await ro(inv("matters.update", { matter_id: mid, patch: { stage: "first_instance" } }));
  await ro(inv("matters.update", { matter_id: mid, patch: { region: "上海市" } }));
  await ro(inv("matters.update", { matter_id: mid, patch: { event_date: "2023-05" } }));
  await ro(inv("matters.update", { matter_id: mid, patch: { key_dates: { 开庭: "2026-12-01" } } }));
  await ro(inv("todos.create", { matter_id: mid, title: "示例里加一条" }));
  await ro(inv("review_rules.save", { matter_id: mid, title: "示例要点", rules: [{ topic: "付款", standard: "六十日" }], base_version: null }));
  await ro(inv("review_rules.retire", { matter_id: mid, base_version: null }));
  await ro(inv("reminders.create", { matter_id: mid, kind: "hearing", due_date: "2027-03-01", days_before: 3, note: "示例提醒" }));
  // AI 草稿同样拦（材料里的注入不能往示例事项里塞要点草稿）
  assert.throws(() => proposeDraft(tk.kernel.db, { tenantId: "ten_b23-firm", matterId: mid, runId: "run_x" }, { title: "草稿", rules: [{ topic: "付款", standard: "六十日" }] }), /示例事项只用来看效果/);
  // 从范本整理审查要点：示例事项上开始前就拒绝（复核 Q5-03），不等跑完才在最后一步失败
  const est = await inv("runs.estimate", { matter_id: mid, scenario: "a1.agent_task", document_version_ids: [] });
  await ro(inv("runs.start", { matter_id: mid, estimate_id: est.estimate_id, idempotency_key: `b23-${Date.now()}`, goal: "整理审查要点", plan_first: false, mode: "default", skill: "review-rules-draft" }));
  assert.equal(tk.kernel.db.get(`SELECT 1 AS x FROM runs WHERE matter_id = ? AND input_snapshot LIKE '%review-rules-draft%'`, [mid]), undefined, "没有建任务");
  // 只读的是事项设置：看材料、标题、事项详情照常
  const g = await inv("matters.get", { matter_id: mid });
  assert.equal(g.matter.is_sample, true);
  assert.ok(g.documents.length > 0);
  // 普通事项不受影响
  const { matter } = await inv("matters.create", { title: "普通", stance: "买方", consent_status: "agreed" });
  await inv("matters.update", { matter_id: matter.matter_id, patch: { stage: "negotiation" } });
  await inv("todos.create", { matter_id: matter.matter_id, title: "普通事项的待办" });
});
