/**
 * V12 F10：起草合同只交了附件《起草说明与待定事项》.docx（方法前言标明“（附件）”），原先算作“已交出 Word”、记“已完成”——
 * 律师拿到的是说明备忘录而不是合同。现在方法规定的附件不算主交付物：记“部分完成”并写明没交出合同草稿。
 * 对照：同一方法交了合同（文件名任意，如“技术开发合同”）照常完成；附件与合同都交照常完成。
 * 经真实内核 + kap 宿主 + 测试网关跑完整链路，模型动作由脚本固定（只验证“模型这样做时内核怎么记”）。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "v12-attachment-secret-0123456789abcdef";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeKernel, waitRun, type TestKernel } from "./helpers.ts";
import { startCloudV0, type CloudV0 } from "./cloud-v0.ts";
import { attachmentMatcher } from "../src/executor/executor.ts";

let tk: TestKernel;
let cloud: CloudV0;

before(async () => {
  cloud = await startCloudV0({ tenant: "ten_v12-attach-firm" });
  tk = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_KERNEL_TCP: "off" }, "v12-attach-firm");
});

after(async () => {
  await tk.kernel.close();
  await cloud.close();
});

type Msg = { role?: string; tool_call_id?: string; content?: unknown };
const msgs = (body: Record<string, unknown>): Msg[] => (Array.isArray(body.messages) ? (body.messages as Msg[]) : []);
function lastAsk(body: Record<string, unknown>): string {
  const users = msgs(body).filter((m) => m.role === "user").map((m) => JSON.stringify(m.content ?? "")).filter((t) => !t.startsWith('"<system-reminder>'));
  return users[users.length - 1] ?? "";
}

/** 依次出给定标题的 Word 文书，然后收尾。 */
function renders(marker: string, titles: string[]) {
  return (body: Record<string, unknown>) => {
    if (!lastAsk(body).includes(marker)) return null;
    const done = new Set(msgs(body).filter((m) => m.role === "tool").map((m) => m.tool_call_id));
    const i = titles.findIndex((_, k) => !done.has(`r_${marker}_${k}`));
    if (i >= 0) return { toolCalls: [{ id: `r_${marker}_${i}`, name: "mcp__legal__docx_render_report", args: { title: titles[i], sections: [{ heading: "一、说明", paragraphs: ["本文件为起草说明。"] }] } }] };
    return { content: "已出文件。" };
  };
}

async function newMatter(title: string) {
  const { matter } = await tk.inv("matters.create", {
    title,
    stance: "委托方",
    basis: { engagement: "confirmed", personal_info: "confirmed", sensitive: "not_applicable", subprocessor: "confirmed" },
    model_endpoint: "standard",
  });
  return matter;
}
async function start(matterId: string, body: Record<string, unknown>) {
  const est = await tk.inv("runs.estimate", { matter_id: matterId, scenario: "a1.agent_task", document_version_ids: [] });
  return tk.inv("runs.start", { matter_id: matterId, estimate_id: est.estimate_id, idempotency_key: `v12-${Math.random().toString(36).slice(2)}`, mode: "default", plan_first: false, ...body });
}

test("附件判定（纯函数）：只认附件基名，不把含主交付物名称的文件当附件", () => {
  const isAtt = attachmentMatcher(["起草说明与待定事项.docx（附件）"], "合同草稿.docx");
  assert.equal(isAtt("起草说明与待定事项.docx"), true);
  assert.equal(isAtt("《起草说明与待定事项》（技术开发合同）.docx"), true);
  assert.equal(isAtt("技术开发（委托）合同.docx"), false);
  assert.equal(isAtt("合同草稿及起草说明与待定事项.docx"), false, "含主交付物名称的不算附件");
  // 太短的附件名不参与（避免误伤）
  assert.equal(attachmentMatcher(["说明.docx（附件）"], "合同草稿.docx")("说明.docx"), false);
});

test("起草合同只交了《起草说明与待定事项》：记“部分完成”，写明没交出合同草稿；交了合同照常完成", { timeout: 300_000 }, async () => {
  const matter = await newMatter("V12 只交附件");
  try {
    cloud.model.script = renders("V12ATTONLY", ["起草说明与待定事项"]);
    const r1 = await start(matter.matter_id, { goal: "V12ATTONLY 请起草技术开发合同", skill: "contract-draft", title: "起草合同" });
    const a = await waitRun(tk.inv, r1.run_id, 150_000);
    assert.ok(a.artifacts.some((x: any) => x.kind === "agent_report"), "交了一份 Word（附件）");
    assert.equal(a.run.status, "partial", `只交附件不记“已完成”：${JSON.stringify(a.events.map((e: any) => e.type))}`);
    assert.equal(a.events.find((e: any) => e.type === "agent.primary_missing")?.payload.primary, "合同草稿");

    cloud.model.script = renders("V12BOTH", ["技术开发（委托）合同", "起草说明与待定事项"]);
    const r2 = await start(matter.matter_id, { goal: "V12BOTH 请起草技术开发合同", skill: "contract-draft", title: "起草合同" });
    const b = await waitRun(tk.inv, r2.run_id, 150_000);
    assert.equal(b.run.status, "succeeded", JSON.stringify(b.events.map((e: any) => e.type)));
  } finally {
    cloud.model.script = null;
  }
});
