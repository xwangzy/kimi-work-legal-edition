/**
 * 本设备被吊销（阶段 6 复核 S6-A02、S6-B01；第 02 篇 §9.13“在线设备收到后终止任务”）：
 * 控制面对已吊销设备的请求返回控制面签名的吊销通知 → 本机验过即进入退出模式、清除席位令牌、终止进行中的任务；
 * 新任务、同步、签发不可用；已解密到本机的内容无法远程收回（界面如实说明，不再提示“可导出”）。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "cp-self-revoke-secret-0123456789ab";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeKernel, type TestKernel } from "./helpers.ts";
import { startCloudCp, type CloudCp } from "./cloud-cp.ts";

const FIRM = "cpsr-firm";
const TID = `ten_${FIRM}`;
let cloud: CloudCp | null = null;
let tk: TestKernel | null = null;
after(async () => {
  await tk?.kernel.close().catch(() => {});
  await cloud?.close();
});

type Msg = { role?: string; tool_call_id?: string; content?: unknown };
const msgs = (body: Record<string, unknown>): Msg[] => (Array.isArray(body.messages) ? (body.messages as Msg[]) : []);

test("本设备被吊销：凭控制面签名的通知进入退出模式，清除席位令牌，终止正在等待律师的任务；新任务与同步不可用", { timeout: 180_000 }, async () => {
  cloud = await startCloudCp({ tenant: TID });
  tk = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_KERNEL_TCP: "off" }, FIRM);
  const { inv } = tk;
  assert.equal((await inv("control_plane.sync")).report.ok, true);
  const { matter } = await inv("matters.create", { title: "吊销演练", stance: "原告", basis: { engagement: "confirmed", personal_info: "confirmed", sensitive: "not_applicable", subprocessor: "confirmed" } });
  cloud.model.script = (body) => {
    const first = JSON.stringify(msgs(body).find((m) => m.role === "user")?.content ?? "");
    if (!first.includes("CPSELFREVOKE")) return null;
    return { toolCalls: [{ id: "q_sr", name: "AskUserQuestion", args: { questions: [{ question: "按哪方立场写？", header: "立场", options: [{ label: "原告", description: "" }, { label: "被告", description: "" }], multi_select: false }] } }] };
  };
  const est = await inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [] });
  const run = await inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `cpsr-${Date.now()}`, goal: "CPSELFREVOKE 起草答辩要点", mode: "default", plan_first: false });
  // 等到任务停在“等待律师作答”
  const waitStatus = async (want: string[], ms: number) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const s = (await inv("runs.get", { run_id: run.run_id })).run.status as string;
      if (want.includes(s)) return s;
      if (Date.now() > deadline) throw new Error(`任务状态为 ${s}，等不到 ${want.join("/")}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  };
  await waitStatus(["waiting_input"], 90_000);
  // 管理员在控制面吊销本设备
  cloud.cp.ops.revokeDevice(TID, `dev_${FIRM}_test-lawyer`);
  const rep = await inv("control_plane.sync");
  assert.equal(rep.report.steps.register, "device_revoked", JSON.stringify(rep.report.steps));
  const st = await inv("control_plane.status");
  assert.equal(st.exit_mode?.code, "device_revoked");
  assert.doesNotMatch(st.exit_mode.message, /可继续查看与导出/, "被吊销的设备不提示可导出");
  assert.match(st.exit_mode.message, /无法远程收回/);
  assert.equal(st.seat.has_token, false, "席位令牌已清除");
  assert.equal(await waitStatus(["cancelled"], 30_000), "cancelled", "进行中的任务被终止");
  // 新任务、同步不可用
  const est2 = await inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [] });
  assert.equal(est2.data_where.start_blocked, true);
  await assert.rejects(inv("runs.start", { matter_id: matter.matter_id, estimate_id: est2.estimate_id, idempotency_key: `cpsr2-${Date.now()}`, goal: "x" }), /本设备已被吊销/);
  await assert.rejects(inv("sync.export", { share_dir: tk.dir }), /本设备已被吊销/);
  cloud.model.script = null;
});
