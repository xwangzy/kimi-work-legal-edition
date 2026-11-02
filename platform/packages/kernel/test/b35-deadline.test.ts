/**
 * 第 35 批真实走查 N1：《股权转让协议》已交出（同一任务 5 版），助手还在自查，25 分钟到点任务记“已超时、需要重试”、不扣点——
 * 律师看到的是失败。改为：到工作时限时主交付物已交出 → 按部分完成结算，写明“已交出《…》、收尾没完成”；什么都没交出的照常记超时。
 * 工作时限调到 4 秒：假模型先生成文书，之后一直调用只读工具不收尾，由宿主按时限判超时。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "b35-deadline-secret-0123456789abcdef";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeKernel, waitRun, type TestKernel } from "./helpers.ts";
import { startCloudV0, type CloudV0 } from "./cloud-v0.ts";

let tk: TestKernel;
let cloud: CloudV0;

before(async () => {
  cloud = await startCloudV0({ tenant: "ten_b35-deadline-firm" });
  tk = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_KERNEL_TCP: "off", ZR_AGENT_WORK_LIMIT_MS: "4000" }, "b35-deadline-firm");
});

after(async () => {
  await tk.kernel.close();
  await cloud.close();
});

type Msg = { role?: string; tool_call_id?: string; content?: unknown };
const msgs = (body: Record<string, unknown>): Msg[] => (Array.isArray(body.messages) ? (body.messages as Msg[]) : []);

async function startRun(marker: string) {
  const { matter } = await tk.inv("matters.create", {
    title: `时限测试 ${marker}`,
    stance: "受让方",
    basis: { engagement: "confirmed", personal_info: "confirmed", sensitive: "not_applicable", subprocessor: "confirmed" },
    model_endpoint: "standard",
  });
  const est = await tk.inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [] });
  return tk.inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `b35-${marker}-${Date.now()}`, goal: `${marker} 起草一份协议`, mode: "default", plan_first: false });
}

/** 先按需生成文书，之后每一步都再调一次只读检索（永不收尾）。 */
function busyScript(marker: string, render: boolean) {
  let n = 0;
  return (body: Record<string, unknown>) => {
    const first = JSON.stringify(msgs(body).find((m) => m.role === "user")?.content ?? "");
    if (!first.includes(marker)) return null;
    const rendered = msgs(body).some((m) => m.role === "tool" && m.tool_call_id === "render_1");
    if (render && !rendered) {
      return { toolCalls: [{ id: "render_1", name: "mcp__legal__docx_render_report", args: { title: "股权转让协议", sections: [{ heading: "第一条 标的股权", paragraphs: ["1.1 转让方同意转让、受让方同意受让标的股权。"] }] } }] };
    }
    n += 1;
    // 每次参数都不同（同一调用反复出现会被引擎当作打转而停下）
    return { toolCalls: [{ id: `busy_${n}`, name: "mcp__legal__law_search", args: { query: `股权转让 第${n}次检索` } }] };
  };
}

test("到工作时限时文书已交出：按部分完成结算，写明已交出与收尾没完成（不记“已超时、需要重试”）", { timeout: 120_000 }, async () => {
  cloud.model.script = busyScript("B35DLV", true);
  try {
    const run = await startRun("B35DLV");
    const done = await waitRun(tk.inv, run.run_id, 90_000);
    const types = done.events.map((e: any) => e.type);
    assert.equal(done.run.status, "partial", JSON.stringify(types));
    const ev = done.events.find((e: any) => e.type === "agent.deadline_delivered");
    assert.ok(ev, `有“到时限已交出”事件：${JSON.stringify(types)}`);
    assert.deepEqual(ev.payload.files, ["股权转让协议.docx"]);
    const settled = done.events.find((e: any) => e.type === "run.partial");
    assert.match(String(settled.payload.remaining?.[0] ?? ""), /已交出《股权转让协议》.*没有收尾/);
    assert.equal(types.includes("run.timed_out"), false);
    assert.ok(done.artifacts.some((a: any) => a.kind === "agent_report" && a.filename === "股权转让协议.docx"), "文书在交付件里");
  } finally {
    cloud.model.script = null;
  }
});

test("到工作时限时什么都没交出：照常记超时", { timeout: 120_000 }, async () => {
  cloud.model.script = busyScript("B35NONE", false);
  try {
    const run = await startRun("B35NONE");
    const done = await waitRun(tk.inv, run.run_id, 90_000);
    assert.equal(done.run.status, "timed_out", JSON.stringify(done.events.map((e: any) => e.type)));
    assert.equal(done.events.some((e: any) => e.type === "agent.deadline_delivered"), false);
  } finally {
    cloud.model.script = null;
  }
});
