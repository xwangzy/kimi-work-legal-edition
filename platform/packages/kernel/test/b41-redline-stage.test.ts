/**
 * V16 第 41 批（偏离 D-178，11-11 用户拍板）：审合同时律师在开始面板选了“同时出一份建议修订稿”的，审查与出修订稿分两段做，各有各的工作时限。
 * 根因（三次真实任务）：审查本身就接近 40 分钟，修订稿挤在最后几分钟；到时限时独立复核、修改轮与最终答复都被截掉，任务只能记“部分完成”。
 * 这里验证：只认开始面板的选项；审查那一轮被告知不写修订稿；审查交出后接着原会话另起一段写修订稿；这一段没做出来时审查成果照常结算并如实写“还差什么”。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "b41-redline-secret-0123456789abcdef";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createDocx } from "@zr-legal/docx-engine";
import { importBytes, makeKernel, waitRun, type TestKernel } from "./helpers.ts";
import { startCloudV0, type CloudV0 } from "./cloud-v0.ts";
import { fixTargetsOf, goalForReviewer, methodPromptLine, redlineStagePrompt, wantsRedlineStage } from "../src/executor/executor.ts";
import { fixPrompt } from "../src/services/independent-review.ts";
import { amendPatches, draftingNotesIn } from "../src/tools/tools/revise.ts";

let tk: TestKernel;
let cloud: CloudV0;
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const YES = "要：按审查意见直接在原件上写修订";

before(async () => {
  cloud = await startCloudV0({ tenant: "ten_b41-redline-firm" });
  tk = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_KERNEL_TCP: "off", ZR_INDEPENDENT_REVIEW: "off", ZR_REDLINE_LIMIT_MS: "20000" }, "b41-redline-firm");
});

after(async () => {
  await tk.kernel.close();
  await cloud.close();
});

type Msg = { role?: string; tool_call_id?: string; content?: unknown };
const msgs = (body: Record<string, unknown>): Msg[] => (Array.isArray(body.messages) ? (body.messages as Msg[]) : []);

async function startRun(marker: string, redline: string) {
  const { matter } = await tk.inv("matters.create", {
    title: `分段测试 ${marker}`,
    stance: "买方",
    basis: { engagement: "confirmed", personal_info: "confirmed", sensitive: "not_applicable", subprocessor: "confirmed" },
    model_endpoint: "standard",
  });
  const docx = createDocx("设备买卖合同", [{ heading: "第二条 价款", paragraphs: ["2.1 价款为人民币120万元，合同签订后三日内一次付清。"] }], { mark: false });
  const doc = await importBytes(tk.inv, matter.matter_id, "设备买卖合同（对方稿）.docx", docx, DOCX);
  const est = await tk.inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [doc.document_version_id] });
  const run = await tk.inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `b41rl-${marker}-${Date.now()}`, goal: `${marker} 审查这份设备买卖合同`, skill: "contract-review", skill_args: { type: "买卖", redline }, document_version_ids: [doc.document_version_id], mode: "default", plan_first: false });
  return { run, doc };
}

/** 审查那一轮出一份意见书；出修订稿那一段按 revise 决定是否调用 docx.revise。 */
function script(marker: string, docId: () => string, revise: boolean, seen: { first: string[]; stage: string[] }) {
  return (body: Record<string, unknown>) => {
    const ms = msgs(body);
    const users = ms.filter((m) => m.role === "user").map((m) => JSON.stringify(m.content ?? ""));
    if (!(users[0] ?? "").includes(marker)) return null;
    const inStage = users.some((u) => u.includes("【出建议修订稿】"));
    if (!ms.some((m) => m.role === "tool" && m.tool_call_id === "render_1")) {
      seen.first.push(users[0] ?? "");
      return { toolCalls: [{ id: "render_1", name: "mcp__legal__docx_render_report", args: { title: "审查意见书（内部稿）", sections: [{ heading: "一、付款", paragraphs: ["第 2.1 款签订后三日内一次付清对买方不利，必须修改为验收合格后付款。"] }] } }] };
    }
    if (!inStage) return { content: "审查意见书已出。建议修订稿随后生成。" };
    seen.stage.push(users.at(-1) ?? "");
    if (revise && !ms.some((m) => m.role === "tool" && m.tool_call_id === "rev_1")) {
      return { toolCalls: [{ id: "rev_1", name: "mcp__legal__docx_revise", args: { document_version_id: docId(), patches: [{ anchor: "合同签订后三日内一次付清", proposed_text: "验收合格后十日内一次付清", comment: "付款节点：改为验收后付款" }] } }] };
    }
    return { content: revise ? "审查意见书与建议修订稿、清洁稿、修改对照表均已生成。" : "原件无法定位，修订稿没有生成。" };
  };
}

test("只认开始面板的选项：选了“要”才分两段，审查那一轮的方法说明写明这一轮不写修订稿", () => {
  assert.equal(wantsRedlineStage("contract-review", { redline: YES }), true);
  assert.equal(wantsRedlineStage("contract-review", { redline: "不用，先看审查意见" }), false);
  assert.equal(wantsRedlineStage("contract-review", { type: "买卖" }), false);
  assert.equal(wantsRedlineStage("contract-draft", { redline: YES }), false);
  assert.equal(wantsRedlineStage(null, { redline: YES }), false);
  assert.match(methodPromptLine("contract-review", { redline: YES }), /【分两段】[\s\S]*这一轮不要调用 docx\.revise/);
  assert.equal(/【分两段】/.test(methodPromptLine("contract-review", { redline: "不用，先看审查意见" })), false);
  const p = redlineStagePrompt(25 * 60_000);
  assert.match(p, /【出建议修订稿】[\s\S]*docx\.revise[\s\S]*amend[\s\S]*约 25 分钟/);
  assert.equal(/分钟/.test(redlineStagePrompt()), false);
  // 数字待客户确认的照建议值写入；不添加没有出处的事实陈述
  assert.match(p, /数字待客户确认[\s\S]*不添加意见和材料里没有的事实陈述/);
  // 交给复核人的委托原话不带“这一轮不要调用 docx.revise”，换成一句如实说明
  const sent = `审查这份合同\n${methodPromptLine("contract-review", { redline: YES })}`;
  assert.equal(/不要调用 docx\.revise/.test(goalForReviewer(sent)), false);
  assert.match(goalForReviewer(sent), /修订稿、清洁稿是律师要的交付件/);
  assert.equal(goalForReviewer("起草合同"), "起草合同");
});

test("审查交出后另起一段写修订稿：接着原会话、单独时限，修订稿与清洁稿登记，任务完成", { timeout: 180_000 }, async () => {
  const seen = { first: [] as string[], stage: [] as string[] };
  let id = "";
  cloud.model.script = script("B41RL1", () => id, true, seen);
  try {
    const { run, doc } = await startRun("B41RL1", YES);
    id = doc.document_version_id;
    const done = await waitRun(tk.inv, run.run_id, 150_000);
    const types = done.events.map((e: any) => e.type);
    assert.equal(done.run.status, "succeeded", JSON.stringify(types));
    assert.match(seen.first[0] ?? "", /【分两段】/);
    assert.equal(seen.stage.length > 0, true, "出修订稿那一段发起了");
    assert.match(seen.stage[0] ?? "", /【出建议修订稿】/);
    const started = done.events.find((e: any) => e.type === "redline.started");
    assert.equal(started?.payload.limit_ms, 20000, "用的是这一段自己的时限");
    const outcome = done.events.find((e: any) => e.type === "redline.outcome");
    assert.equal(outcome?.payload.status, "succeeded");
    assert.equal(outcome?.payload.files >= 2, true, JSON.stringify(outcome?.payload));
    // 时间线上审查交出在前、出修订稿在后
    assert.ok(types.indexOf("agent.outcome") >= 0 && types.lastIndexOf("redline.started") > types.indexOf("agent.outcome"), JSON.stringify(types));
    const kinds = done.artifacts.map((a: any) => a.kind);
    assert.ok(kinds.includes("revision_draft") && kinds.includes("revision_clean"), JSON.stringify(kinds));
    assert.equal(done.artifacts.filter((a: any) => a.kind === "a1_agent_draft").length, 2, "最终答复有这一段之后的新版本");
    assert.equal(done.events.find((e: any) => e.type === "run.succeeded")?.payload.remaining, undefined);
    // 分段复验二：修改轮的“用 docx.edit_draft 改”清单不列修改对照表（docx.revise 生成的，edit_draft 会拒绝），只列意见书
    const targets = fixTargetsOf(tk.kernel.db, run.run_id, run.matter_id ?? done.run.matter_id);
    assert.equal(done.artifacts.some((a: any) => /修改对照表/.test(a.filename)), true, "对照表生成了");
    assert.equal(targets.some((t) => /修改对照表/.test(t.filename)), false, JSON.stringify(targets));
    assert.equal(targets.some((t) => /审查意见书/.test(t.filename)), true, JSON.stringify(targets));
  } finally {
    cloud.model.script = null;
  }
});

test("出修订稿那一段没有生成修订稿：审查成果照常交付，任务记部分完成并写明下一步", { timeout: 180_000 }, async () => {
  const seen = { first: [] as string[], stage: [] as string[] };
  cloud.model.script = script("B41RL2", () => "", false, seen);
  try {
    const { run } = await startRun("B41RL2", YES);
    const done = await waitRun(tk.inv, run.run_id, 150_000);
    assert.equal(done.run.status, "partial", JSON.stringify(done.events.map((e: any) => e.type)));
    assert.ok(done.artifacts.some((a: any) => a.kind === "agent_report"), "意见书在");
    const remaining = JSON.stringify(done.events.find((e: any) => e.type === "run.partial")?.payload ?? {});
    assert.match(remaining, /审查已完成[\s\S]*没有生成修订稿[\s\S]*生成修订稿/);
  } finally {
    cloud.model.script = null;
  }
});

test("没选同时出修订稿：不分段，不发起第二段", { timeout: 180_000 }, async () => {
  const seen = { first: [] as string[], stage: [] as string[] };
  cloud.model.script = script("B41RL3", () => "", false, seen);
  try {
    const { run } = await startRun("B41RL3", "不用，先看审查意见");
    const done = await waitRun(tk.inv, run.run_id, 150_000);
    const types = done.events.map((e: any) => e.type);
    assert.equal(done.run.status, "succeeded", JSON.stringify(types));
    assert.equal(types.some((t: string) => t.startsWith("redline.")), false);
    assert.equal(seen.stage.length, 0);
    assert.equal(/【分两段】/.test(seen.first[0] ?? ""), false);
  } finally {
    cloud.model.script = null;
  }
});

test("分段复验二：修改轮写明合同条文上的意见用 docx.revise 补交、意见书替换文字同步；修订稿段要求条文与意见书对得上、说明不进条文", () => {
  const f = [{ no: 1, where: "清洁稿第 9.1 条", problem: "p", basis: "b", fix: "f", must: true }];
  const withRedline = fixPrompt("review", f, "", undefined, [{ filename: "审查意见书（内部稿）.docx", artifact_version_id: "artv_1", kind: "docx" }], [], ["合同（修订稿）.docx", "合同（清洁稿）.docx"]);
  assert.match(withRedline, /《合同（修订稿）\.docx》、《合同（清洁稿）\.docx》/);
  assert.match(withRedline, /落在合同条文上的意见不用 docx\.edit_draft，在原件上调用 docx\.revise 用补交方式（amend）/);
  assert.match(withRedline, /意见书、问题清单里对应项的替换文字同步改成与修订稿实际写入的一致/);
  assert.match(withRedline, /修订署名由本所设置决定，工具改不了/);
  assert.equal(fixPrompt("review", f, "", undefined, [], [], []).includes("docx.revise"), false, "没有修订稿的任务不提");
  assert.equal(fixPrompt("revise", f, "", undefined, [], [], ["合同（修订稿）.docx"]).includes("本任务还在合同原件上写了修订稿"), false, "修订任务本来就用补交，不重复");
  const stage = redlineStagePrompt();
  assert.match(stage, /proposed_text 只写合同条文本身/);
  assert.match(stage, /把意见书、问题清单对应项的替换文字改成与修订稿实际写入的一致/);
});

test("分段复验二：写进条文的起草说明被认出来，正常条文与补充协议写法不误报；补交换了条文的序号回显", () => {
  const hits = draftingNotesIn([
    { proposed_text: "6.3 乙方逾期交货的，每日按合同总价的0.1%支付违约金。原第6.3条不再适用。" },
    { proposed_text: "删除按甲方已支付价款5%计算的赔偿上限。" },
    { proposed_text: "违约金上限为合同总价的20%（数字待客户确认）。" },
    { proposed_text: "修改理由：与第 4.4 条保持一致。" },
    { proposed_text: "11.2 合同解除后，乙方应于十日内返还甲方已付款项，并删除或销毁甲方全部保密信息。" },
    { proposed_text: "原合同第三条修改为：价款为人民币100万元。" },
    { proposed_text: "" },
  ]);
  assert.deepEqual(hits.map((h) => h.index), [1, 2, 3, 4], JSON.stringify(hits));
  const prev = [
    { anchor: "三日内", proposed_text: "十日内" },
    { anchor: "一次付清", proposed_text: "分两期付清" },
  ];
  const r = amendPatches(prev, { replace: [{ index: 1, patch: { anchor: "三日内", proposed_text: "十五日内" } }, { index: 2, patch: { anchor: "一次付清", proposed_text: "分两期付清", comment: "只改理由" } }] });
  assert.deepEqual(r.summary.text_changed, [1], "只有条文变了的才回显");
});
