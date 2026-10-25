/**
 * v9.4 第 27 批（精修二）内核：开始前确认的“完整说明”分行给出（与 preview 同一组文字，界面排成表）。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { importText, makeKernel, waitRun, type TestKernel } from "./helpers.ts";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "b27-firm");
});
after(async () => {
  await tk.kernel.close();
});

test("完整说明分行：每行文字都原样出现在 preview 里；开放任务有“联网检索”一行；本机场景与不会发送时不给", async () => {
  const { matter } = await tk.inv("matters.create", {
    title: "完整说明分行测试（原告）",
    stance: "原告",
    basis: { engagement: "confirmed", personal_info: "confirmed", sensitive: "not_applicable", subprocessor: "confirmed" },
  });
  const doc = await importText(tk.inv, matter.matter_id, "签收单.txt", "签收单：买方于 2026 年 3 月 1 日签收全部货物。");
  const est = await tk.inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [doc.document_version_id], goal: "整理时间线" });
  const { preview, preview_rows } = est.data_where;
  assert.deepEqual(
    preview_rows.map((r: any) => r.label),
    ["发送什么", "发给谁", "换成代号", "按原文发送", "联网检索", "是否保存", "记录"],
  );
  for (const r of preview_rows) assert.ok(preview.includes(r.text), `“${r.label}”一行的文字原样在完整说明里：${r.text}`);
  assert.match(preview_rows[1].text, /经中软/, "发给谁仍写明经中软");
  assert.match(preview_rows[3].text, /未能识别的姓名也会以原文发送/, "按原文发送的风险句一字不少");

  const local = await tk.inv("runs.estimate", { matter_id: matter.matter_id, scenario: "s2.case_file", document_version_ids: [doc.document_version_id] });
  assert.equal("preview_rows" in local.data_where, false, "本机场景不发送，没有分行");

  const { matter: pending } = await tk.inv("matters.create", { title: "依据待确认（原告）", stance: "原告" });
  const blocked = await tk.inv("runs.estimate", { matter_id: pending.matter_id, scenario: "a1.agent_task", document_version_ids: [], goal: "整理时间线" });
  assert.match(blocked.data_where.preview, /^不会发送/);
  assert.equal("preview_rows" in blocked.data_where, false, "不会发送时不给分行");
});

test("事项模板“劳动仲裁应诉（用人单位）”：答辩期按十个工作日推算（办案规则第八十条），不再按自然日", async () => {
  // 2026-09-28 收到副本：按自然日是 10-08；十个工作日跨国庆长假，是 10-16（与评审 S3 用期间工具实测一致）
  const er = await tk.inv("matters.create", { title: "用人单位应诉（工作日）", stance: "用人单位", consent_status: "agreed", template_id: "labor-employer", template_start: "2026-09-28" });
  assert.equal(er.template_applied.deadline.date, "2026-10-16");
  const m = await tk.inv("matters.get", { matter_id: er.matter.matter_id });
  assert.equal(m.matter.key_dates["仲裁答辩期届满"], "2026-10-16");
  const todos = await tk.inv("todos.list", { matter_id: er.matter.matter_id });
  assert.equal(todos.open.find((t: any) => /提交仲裁答辩书/.test(t.title))?.due_date, "2026-10-16");
  const { templateById } = await import("../src/services/matter-templates.ts");
  assert.match(templateById("labor-employer")!.start_fact!.basis, /第八十条/);
});

test("待签发的待办带成果种类与任务名（界面写“签发：××（任务名）”，不再是“草稿-日期.md”）", async () => {
  const { matter } = await tk.inv("matters.create", { title: "待签发命名（原告）", stance: "原告", consent_status: "not_required", key_dates: { analysis_as_of: "2026-10-01" } });
  const doc = await importText(tk.inv, matter.matter_id, "签收单.txt", "签收单：买方于 2026 年 3 月 1 日签收全部货物。");
  const est = await tk.inv("runs.estimate", { matter_id: matter.matter_id, scenario: "s2.case_file", document_version_ids: [doc.document_version_id] });
  const run = await tk.inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `b27-sign-${Date.now()}`, title: "整理案卷" });
  await waitRun(tk.inv, run.run_id);
  const arts = (await tk.inv("artifacts.list", { matter_id: matter.matter_id })).artifacts;
  assert.ok(arts.length > 0);
  assert.equal(arts[0].run_title, "整理案卷", "成果列表带所属任务名（没有内容标题的助手草稿用它命名）");
  await tk.inv("review.submit", { artifact_version_id: arts[0].artifact_version_id });
  const todos = await tk.inv("todos.list", { matter_id: matter.matter_id });
  const sign = todos.derived.find((d: any) => d.kind === "to_sign");
  assert.equal(sign.artifact_kind, arts[0].kind);
  assert.equal(sign.goal, "整理案卷");
});

test("Agent 工作时限缺省 25 分钟（D-152：真实 K3 审合同约 9.5 分钟、劳动仲裁申请书 10 分钟内没写完），不超过宿主上限 30 分钟", async () => {
  const { AGENT_WORK_LIMIT_MS } = await import("../src/executor/executor.ts");
  assert.equal(AGENT_WORK_LIMIT_MS, 25 * 60_000);
  assert.ok(AGENT_WORK_LIMIT_MS <= 30 * 60_000, "宿主缺省上限 maxRunMs 30 分钟");
});
