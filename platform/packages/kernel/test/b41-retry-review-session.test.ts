/**
 * V16 第 41 批真实回归：任务第一次因上游出错失败，律师点“重新运行”（同一任务、新的尝试）。重新运行那次写出了文书、独立复核提了意见，
 * 修改轮里助手却说“工作区里没有已生成的文书”，整份重写并换了文件名。
 * 根因：事件按（任务，序号）去重，每次尝试都从同样的序号写起——重新运行那次的“开始”“助手会话已启动”全被当成重复丢掉，
 * 修改轮按“最后一条助手会话已启动”取到的是失败那一次的空会话。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "b41-retry-secret-0123456789abcdef";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { importBytes, makeKernel, waitRun, type TestKernel } from "./helpers.ts";
import { startCloudV0, type CloudV0 } from "./cloud-v0.ts";

let tk: TestKernel;
let cloud: CloudV0;

before(async () => {
  cloud = await startCloudV0({ tenant: "ten_b41-retry-firm" });
  tk = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_KERNEL_TCP: "off", ZR_INDEPENDENT_REVIEW: "on", ZR_REVIEW_LIMIT_MS: "20000", ZR_REVIEW_FIX_LIMIT_MS: "20000" }, "b41-retry-firm");
});

after(async () => {
  await tk.kernel.close();
  await cloud.close();
});

type Msg = { role?: string; tool_call_id?: string; content?: unknown };
const msgs = (body: Record<string, unknown>): Msg[] => (Array.isArray(body.messages) ? (body.messages as Msg[]) : []);
const REVIEWER = "现在独立复核";

test("重新运行后独立复核的修改轮接回重新运行那一次的会话：看得到刚出的文书，在同一份上改出第 2 版", { timeout: 240_000 }, async () => {
  const marker = "B41RETRY";
  let failedOnce = false;
  const fixRound: { sawRender: boolean | null; prompt: string } = { sawRender: null, prompt: "" };
  cloud.model.script = (body: Record<string, unknown>) => {
    const ms = msgs(body);
    const sys = ms.filter((m) => m.role === "system").map((m) => String(m.content ?? "")).join("\n");
    if (sys.includes(REVIEWER)) return { content: "【1】第二条｜价款写成 100 万元，与委托的 120 万元不一致｜委托原话：价款120万元｜2.1 改为“价款为人民币120万元”｜必须改" };
    const first = JSON.stringify(ms.find((m) => m.role === "user")?.content ?? "");
    if (!first.includes(marker)) return null;
    // 第一次尝试：上游出错（真实回归是额度不足），任务失败
    if (!failedOnce) {
      failedOnce = true;
      return { status: 400, content: "upstream quota exceeded" };
    }
    const users = ms.filter((m) => m.role === "user").map((m) => JSON.stringify(m.content ?? ""));
    const inFix = users.some((u) => u.includes("【独立复核】"));
    const render = ms.find((m) => m.role === "tool" && m.tool_call_id === "render_1");
    if (inFix && fixRound.sawRender === null) {
      fixRound.sawRender = !!render;
      fixRound.prompt = users.at(-1) ?? "";
    }
    if (!render) {
      return { toolCalls: [{ id: "render_1", name: "mcp__legal__docx_render_report", args: { title: "设备买卖合同", sections: [{ heading: "第一条 标的", paragraphs: ["1.1 买方向卖方购买压装设备一台。"] }, { heading: "第二条 价款", paragraphs: ["2.1 价款为人民币100万元。"] }] } }] };
    }
    if (!inFix) return { content: "已起草《设备买卖合同》。" };
    if (!ms.some((m) => m.role === "tool" && m.tool_call_id === "edit_1")) {
      const id = /artv_[0-9a-f-]+/.exec(JSON.stringify(render.content ?? ""))?.[0];
      return { toolCalls: [{ id: "edit_1", name: "mcp__legal__docx_edit_draft", args: { artifact_version_id: id, patches: [{ anchor: "价款为人民币100万元", proposed_text: "价款为人民币120万元" }] } }] };
    }
    return { content: "已按独立复核意见改正。\n\n独立复核处理情况：\n1｜已改（第 2.1 款价款改为 120 万元）" };
  };
  try {
    const { matter } = await tk.inv("matters.create", {
      title: `重新运行复核 ${marker}`,
      stance: "买方",
      basis: { engagement: "confirmed", personal_info: "confirmed", sensitive: "not_applicable", subprocessor: "confirmed" },
      model_endpoint: "standard",
    });
    const doc = await importBytes(tk.inv, matter.matter_id, "交易条款清单.txt", Buffer.from("设备：压装设备一台。价款：人民币120万元，验收合格后10日内一次付清。", "utf8"), "text/plain");
    const est = await tk.inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [doc.document_version_id] });
    const run = await tk.inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `b41-retry-${Date.now()}`, goal: `${marker} 起草设备买卖合同，价款120万元`, skill: "contract-draft", document_version_ids: [doc.document_version_id], mode: "default", plan_first: false });
    const failed = await waitRun(tk.inv, run.run_id, 100_000);
    assert.equal(failed.run.status, "failed", JSON.stringify(failed.events.map((e: any) => e.type)));

    await tk.inv("runs.retry", { run_id: run.run_id, expected_version: failed.run.status_version });
    await new Promise((r) => setTimeout(r, 500));
    const done = await waitRun(tk.inv, run.run_id, 150_000);
    const types = done.events.map((e: any) => e.type);
    assert.equal(done.run.status, "succeeded", JSON.stringify(types));

    // 两次尝试的“开始”都在任务过程里
    assert.equal(types.filter((t: string) => t === "run.started").length, 2, JSON.stringify(types));
    // 两次尝试各一个会话；修改轮接的是重新运行那次的会话
    const sessions = done.events.filter((e: any) => e.type === "agent.started").map((e: any) => e.payload.session_id);
    assert.ok(sessions.length >= 3, JSON.stringify(sessions));
    const [s1, s2] = sessions;
    assert.ok(typeof s1 === "string" && typeof s2 === "string" && s1 !== s2, JSON.stringify(sessions));
    const fixStartedAt = done.events.findIndex((e: any) => e.type === "review.fix_started");
    assert.ok(fixStartedAt > 0, JSON.stringify(types));
    const fixSession = done.events.slice(fixStartedAt).find((e: any) => e.type === "agent.started")?.payload.session_id;
    assert.equal(fixSession, s2, "修改轮接回重新运行那一次的会话");

    // 修改轮的消息历史里看得到第二次尝试出的文书；在同一份上改出第 2 版，没有另起一份
    assert.equal(fixRound.sawRender, true, "修改轮看得到重新运行那次的 render 工具结果");
    const reports = done.artifacts.filter((a: any) => a.kind === "agent_report");
    assert.deepEqual([...new Set(reports.map((a: any) => a.filename))], ["设备买卖合同.docx"], JSON.stringify(reports.map((a: any) => a.filename)));
    assert.equal(reports.length, 2, "同名第 2 版");
    assert.equal(done.events.find((e: any) => e.type === "review.fix_outcome")?.payload.status, "succeeded");
  } finally {
    cloud.model.script = null;
  }
});
