/**
 * W1：等待律师确认或回答的时间不计入 A1 工作时限（第 02 篇 §9.3“默认档逐项确认”、§9.6“遇确认即暂停等人”）。
 * 工作时限调到 4 秒（宿主按 4 秒自判、内核兜底 4 + 5 秒）：Agent 提问后律师 12 秒才作答——任务停在“等待你回答”、不超时；作答后照常完成。
 * 任一侧把等待计入时限，本用例都会失败（宿主判 run_deadline_exceeded 或内核判 timed_out）。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "w1-wait-secret-0123456789abcdef";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeKernel, waitRun, type TestKernel } from "./helpers.ts";
import { startCloudV0, type CloudV0 } from "./cloud-v0.ts";

let tk: TestKernel;
let cloud: CloudV0;

before(async () => {
  cloud = await startCloudV0({ tenant: "ten_w1-wait-firm" });
  tk = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_KERNEL_TCP: "off", ZR_AGENT_WORK_LIMIT_MS: "4000" }, "w1-wait-firm");
});

after(async () => {
  await tk.kernel.close();
  await cloud.close();
});

type Msg = { role?: string; tool_call_id?: string; content?: unknown };
const msgs = (body: Record<string, unknown>): Msg[] => (Array.isArray(body.messages) ? (body.messages as Msg[]) : []);

test("W1 等待律师的时间不计入工作时限：提问后 12 秒才作答（工作时限 4 秒）——任务等待而不超时，作答后完成", { timeout: 120_000 }, async () => {
  const { inv } = tk;
  const { matter } = await inv("matters.create", {
    title: "等待测试",
    stance: "原告",
    basis: { engagement: "confirmed", personal_info: "confirmed", sensitive: "not_applicable", subprocessor: "confirmed" },
    model_endpoint: "standard",
  });
  const M = "W1WAIT";
  cloud.model.script = (body) => {
    const first = JSON.stringify(msgs(body).find((m) => m.role === "user")?.content ?? "");
    if (!first.includes(M)) return null;
    const answered = msgs(body).some((m) => m.role === "tool" && m.tool_call_id === "q_wait");
    return answered
      ? { content: "已按你的选择完成。" }
      : { toolCalls: [{ id: "q_wait", name: "AskUserQuestion", args: { questions: [{ question: "按哪方立场写？", header: "立场", options: [{ label: "原告", description: "" }, { label: "被告", description: "" }], multi_select: false }] } }] };
  };
  try {
    const est = await inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [] });
    const run = await inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `w1-wait-${Date.now()}`, goal: `${M} 起草答辩要点`, mode: "default", plan_first: false });
    // 等到提问出现
    let q: any = null;
    for (let i = 0; i < 200 && !q; i++) {
      const it = await inv("runs.interactions", { run_id: run.run_id }).catch(() => ({ questions: [] }));
      q = it.questions?.[0] ?? null;
      if (!q) await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(q, "应出现提问卡");
    // 等待律师期间导入补充材料：开放任务不占用材料导入/OCR 的锁（Kimi Code 集成核查 P0-3），导入应立即完成
    const t0 = Date.now();
    const imp = await inv("materials.import", { matter_id: matter.matter_id, filename: "补充材料.txt", data_base64: Buffer.from("补充：对方已于十月一日回函。", "utf8").toString("base64"), mime: "text/plain" });
    assert.ok(imp, "导入应成功");
    assert.ok(Date.now() - t0 < 5_000, `等待律师期间导入材料不应被阻塞（用时 ${Date.now() - t0} ms）`);
    // 律师 12 秒后才作答（超过工作时限与内核兜底宽限之和）：期间任务一直在“等待你回答”
    await new Promise((r) => setTimeout(r, Math.max(0, 12_000 - (Date.now() - t0))));
    const mid = await inv("runs.get", { run_id: run.run_id });
    assert.equal(mid.run.status, "waiting_input", `等待期间不应超时：${mid.run.status}`);
    await inv("runs.answer", { run_id: run.run_id, question_id: q.question_id, answers: Object.fromEntries(q.questions.map((x: any) => [x.id, { kind: "single", option_id: x.options[0].id }])) });
    const done = await waitRun(inv, run.run_id, 60_000);
    assert.equal(done.run.status, "succeeded", JSON.stringify(done.events.map((e: any) => e.type)));
  } finally {
    cloud.model.script = null;
  }
});
