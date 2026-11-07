/**
 * V13 第 38 批真实走查 W7：律师对应用重启前完成的任务“追问”，任务一启动就失败（“session session_… not found”）。
 * 根因：宿主重启后会话只在磁盘上，查询会话（getSession）照样成功，宿主因此没有先恢复会话；引擎订阅事件要求会话在线，报“not found”。
 * 修复：接续前一律先恢复（恢复对在线会话幂等）。本用例：第一轮完成 → 关掉宿主进程（等同应用重启）→ 追问成功，且模型看得到上一轮。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "b38-followup-restart-secret-0123456789";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeKernel, waitRun, type TestKernel } from "./helpers.ts";
import { startCloudV0, type CloudV0 } from "./cloud-v0.ts";

let tk: TestKernel;
let cloud: CloudV0;

before(async () => {
  cloud = await startCloudV0({ tenant: "ten_b38-followup-firm" });
  tk = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "mock", ZR_KERNEL_TCP: "off" }, "b38-followup-firm");
});

after(async () => {
  await tk.kernel.close();
  await cloud.close();
});

test("宿主重启后追问：接续重启前的会话成功，模型看得到上一轮的问答（V13 W7）", { timeout: 240_000 }, async () => {
  const { inv } = tk;
  const { matter } = await inv("matters.create", { title: "重启后追问", stance: "原告", consent_status: "not_required" });
  type Msg = { role?: string; content?: unknown };
  const msgs = (body: Record<string, unknown>): Msg[] => (Array.isArray(body.messages) ? (body.messages as Msg[]) : []);
  let continuity = false;
  cloud.model.script = (body) => {
    const all = JSON.stringify(msgs(body));
    if (all.includes("B38RESTART2")) {
      continuity = all.includes("B38RESTART1") && all.includes("第一轮答复GAMMA");
      return { content: "第二轮答复DELTA" };
    }
    if (all.includes("B38RESTART1")) return { content: "第一轮答复GAMMA" };
    return null;
  };
  try {
    const est = await inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [] });
    const r1 = await inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `b38-rs1-${Date.now()}`, goal: "B38RESTART1 第一个问题", plan_first: false, mode: "default" });
    const a = await waitRun(inv, r1.run_id, 150_000);
    assert.equal(a.run.status, "succeeded", JSON.stringify(a.events.map((e: any) => e.type)));
    // 关掉宿主进程（应用重启时宿主随之退出）；下一次任务由内核重新拉起宿主
    const client = tk.kernel.agentClient as unknown as { close(): Promise<void>; hostPid(): number | null };
    const before = client.hostPid();
    assert.ok(before, "第一轮后宿主在运行");
    await client.close();
    assert.equal(client.hostPid(), null, "宿主已退出");
    const est2 = await inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [] });
    const r2 = await inv("runs.start", { matter_id: matter.matter_id, estimate_id: est2.estimate_id, idempotency_key: `b38-rs2-${Date.now()}`, goal: "B38RESTART2 再详细些", followup_of: r1.run_id });
    const b = await waitRun(inv, r2.run_id, 150_000);
    assert.equal(b.run.status, "succeeded", JSON.stringify(b.events.map((e: any) => [e.type, e.payload?.error ?? ""])));
    assert.notEqual(client.hostPid(), before, "追问由新拉起的宿主执行");
    assert.equal(continuity, true, "追问时模型应看到重启前那一轮的问题与答复（同一会话）");
    const sid = (evs: any[]) => evs.find((e) => e.type === "agent.started")?.payload?.session_id;
    assert.ok(sid(a.events) && sid(a.events) === sid(b.events), "两轮在同一会话上");
  } finally {
    cloud.model.script = null;
  }
});
