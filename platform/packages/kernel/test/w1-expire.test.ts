/**
 * 复核 S5-B17：等待律师期间到达总时长上限——任务按“过期”收尾（终态事件留痕、预留点数释放、批准作废），
 * 不会因取消宿主时的“离开等待”被改回运行中；内核重启后也不会被当作中断任务重跑。
 * 总时长调到 6 秒、工作时限 4 秒（本机配置 ZR_AGENT_WALL_MS / ZR_AGENT_WORK_LIMIT_MS）；Agent 提问后律师不作答。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "w1-expire-secret-0123456789abcdef";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeKernel, waitRun } from "./helpers.ts";
import { startCloudV0, type CloudV0 } from "./cloud-v0.ts";
import type { Kernel } from "../src/index.ts";

const kernels: Kernel[] = [];
let cloud: CloudV0 | null = null;
after(async () => {
  for (const k of kernels) await k.close().catch(() => {});
  await cloud?.close();
});

type Msg = { role?: string; tool_call_id?: string; content?: unknown };
const msgs = (body: Record<string, unknown>): Msg[] => (Array.isArray(body.messages) ? (body.messages as Msg[]) : []);

test("等待律师期间到达总时长上限：任务按过期收尾（终态事件、释放预留点数），取消宿主后不被改回运行中；重启后不重跑", { timeout: 180_000 }, async () => {
  cloud = await startCloudV0({ tenant: "ten_w1-expire-firm" });
  const env = { ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_KERNEL_TCP: "off", ZR_AGENT_ENGINE: "kap", ZR_AGENT_WORK_LIMIT_MS: "4000", ZR_AGENT_WALL_MS: "6000" };
  const tk = await makeKernel(env, "w1-expire-firm");
  kernels.push(tk.kernel);
  const { inv } = tk;
  const { matter } = await inv("matters.create", {
    title: "过期测试",
    stance: "原告",
    basis: { engagement: "confirmed", personal_info: "confirmed", sensitive: "not_applicable", subprocessor: "confirmed" },
  });
  cloud.model.script = (body) => {
    const first = JSON.stringify(msgs(body).find((m) => m.role === "user")?.content ?? "");
    if (!first.includes("W1EXPIRE")) return null;
    const answered = msgs(body).some((m) => m.role === "tool" && m.tool_call_id === "q_exp");
    return answered
      ? { content: "不应走到这里。" }
      : { toolCalls: [{ id: "q_exp", name: "AskUserQuestion", args: { questions: [{ question: "按哪方立场写？", header: "立场", options: [{ label: "原告", description: "" }, { label: "被告", description: "" }], multi_select: false }] } }] };
  };
  const est = await inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [] });
  const run = await inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `w1-exp-${Date.now()}`, goal: "W1EXPIRE 起草答辩要点", mode: "default", plan_first: false });
  // 律师不作答：总时长到点后任务过期
  const done = await waitRun(inv, run.run_id, 60_000);
  assert.equal(done.run.status, "expired", `应过期而不是 ${done.run.status}`);
  assert.equal(done.run.points_reserved, 0, "预留点数释放");
  assert.ok(done.events.some((e: any) => e.type === "run.expired"), "终态事件留痕");
  // 稍等宿主取消的后续事件：状态不得被改回运行中
  await new Promise((r) => setTimeout(r, 2000));
  assert.equal((await inv("runs.get", { run_id: run.run_id })).run.status, "expired", "取消宿主后状态仍是过期");
  const attempts = tk.kernel.db.all<{ status: string }>(`SELECT status FROM attempts WHERE run_id = ?`, [run.run_id]);
  // 重启内核：不当作中断任务重跑
  const dir = tk.dir;
  await tk.kernel.close();
  kernels.length = 0;
  const { createKernel } = await import("../src/index.ts");
  const k2 = await createKernel({ dataDir: dir, firmSlug: "w1-expire-firm", userSlug: "test-lawyer", env: { ...process.env, ...env } });
  kernels.push(k2);
  await new Promise((r) => setTimeout(r, 1500));
  const after = k2.db.get<{ status: string }>(`SELECT status FROM runs WHERE run_id = ?`, [run.run_id])!;
  assert.equal(after.status, "expired", "重启后仍是过期");
  const attempts2 = k2.db.all<{ status: string }>(`SELECT status FROM attempts WHERE run_id = ?`, [run.run_id]);
  assert.equal(attempts2.length, attempts.length, "没有新的尝试（不重跑）");
  cloud.model.script = null;
});
