/**
 * V13 真实走查 N2（仓储合同审查，K3.1-Pro）：交付前独立复核（D-160）把助手写的意见书放在 user 消息里、按材料做姓名识别，
 * “单次涨幅”被学成自然人“单次涨”，复核人看到“〔自然人〕幅”判“正文被占位符截断”，修正轮把清洁的 Word 改成“乙违约”。
 * 文书是模型写的，应与 D-157 同一口径：只替换已知名单、不学新姓名；律师指令照常识别。
 * 全链路：真实内核 + kap 宿主 + 出站闸门 + 测试网关，模型动作由脚本固定；脚本看到的是闸门处理后的请求体。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "v13-review-secret-0123456789abcdef";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeKernel, waitRun, type TestKernel } from "./helpers.ts";
import { startCloudV0, type CloudV0 } from "./cloud-v0.ts";
import { reviewMessages } from "../src/executor/independent-review.ts";

let tk: TestKernel;
let cloud: CloudV0;
before(async () => {
  cloud = await startCloudV0({ tenant: "ten_v13-review-firm" });
  tk = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_KERNEL_TCP: "off" }, "v13-review-firm");
});
after(async () => {
  await tk.kernel.close();
  await cloud.close();
});

type Msg = { role?: string; tool_call_id?: string; content?: unknown };
const msgs = (b: Record<string, unknown>): Msg[] => (Array.isArray(b.messages) ? (b.messages as Msg[]) : []);
const text = (m: Msg) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""));
const isReviewer = (b: Record<string, unknown>) => msgs(b).some((m) => m.role === "system" && text(m).includes("复核合伙人"));
const lastUser = (b: Record<string, unknown>) => msgs(b).filter((m) => m.role === "user").map(text).filter((t) => !t.startsWith("<system-reminder>")).at(-1) ?? "";

test("复核提示：文书在不在末尾的 assistant 消息里、律师指令在最后的 user 消息里", () => {
  const m = reviewMessages({ goal: "审查仓储合同", stance: "委托方", jurisdiction: "中国大陆", asOf: "2026-11-04", method: "contract-review", checklist: ["按条号排列"], docs: [{ name: "审查意见书", text: "单次涨幅不得超过5%" }] });
  assert.deepEqual(m.map((x) => x.role), ["system", "assistant", "user"]);
  assert.match(m[1]!.content, /单次涨幅不得超过5%/);
  assert.doesNotMatch(m[2]!.content, /单次涨幅/);
  assert.match(m[2]!.content, /【律师的指令】\n审查仓储合同/);
});

test("复核时文书只替换已知名单：助手写进文书的“姓名样”文字不学进令牌表、复核人看到原文；律师指令里的姓名照常换成代号", { timeout: 300_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "V13 复核只替换已知名单", stance: "委托方", basis: { engagement: "confirmed", personal_info: "confirmed", sensitive: "not_applicable", subprocessor: "confirmed" }, model_endpoint: "standard" });
  let reviewerBody = "";
  cloud.model.script = (body: Record<string, unknown>) => {
    if (isReviewer(body)) {
      reviewerBody = JSON.stringify(body.messages);
      return { content: JSON.stringify({ trace: [{ point: "审查", clause: "全文", status: "covered" }], issues: [], summary: "可交付" }) };
    }
    const last = lastUser(body);
    const tools = msgs(body).filter((m) => m.role === "tool").map((m) => m.tool_call_id);
    if (!last.includes("V13KNOWN")) return null;
    if (!tools.includes("draft_v13")) {
      return { toolCalls: [{ id: "draft_v13", name: "mcp__legal__docx_render_report", args: { title: "审查意见书", sections: [{ heading: "逐条意见", paragraphs: ["可退让：单次涨幅不得超过原单价的5%。", "联系人：钱多多，负责对接。"] }] } }] };
    }
    return { content: "已出审查意见书。" };
  };
  try {
    const est = await tk.inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [] });
    const r = await tk.inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `v13k-${Math.random().toString(36).slice(2)}`, mode: "default", plan_first: false, goal: "V13KNOWN 请审查合同。客户联系人：王建国，电话另告", title: "审合同" });
    const a = await waitRun(tk.inv, r.run_id, 240_000);
    assert.equal(a.run.status, "succeeded", JSON.stringify(a.events.map((e: any) => e.type)));
    assert.ok(reviewerBody, "复核调用到达了网关");
    assert.match(reviewerBody, /单次涨幅不得超过原单价的5%/, "文书原文没有被姓名识别改写");
    assert.match(reviewerBody, /联系人：钱多多/, "模型写的“姓名样”文字只替换已知名单，不新学");
    assert.doesNotMatch(reviewerBody, /王建国/, "律师指令里的姓名照常换成代号");
  } finally {
    cloud.model.script = null;
  }
});
