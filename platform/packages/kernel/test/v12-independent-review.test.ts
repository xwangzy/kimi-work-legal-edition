/**
 * V12 交付前独立复核：助手交出 Word 文书后、结算前，内核另起一次全新上下文的复核；有重要缺陷或指令要点没落实的，交回同一会话的助手修正。
 * 根因（V12 用例 1 独立律师评分 22/30）：律师指令里的“性能不达标的违约责任要有约束力”没有落实到任何条款，起草人自查看不出。
 * 全链路：真实内核 + kap 宿主 + 测试网关，模型动作由脚本固定（只验证“模型这样做时内核怎么做”）。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "v12-review-secret-0123456789abcdef";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeKernel, waitRun, type TestKernel } from "./helpers.ts";
import { startCloudV0, type CloudV0 } from "./cloud-v0.ts";
import { parseReview, reviewFixPrompt, reviewMessages, reviewNeedsFix, reviewSummaryLine } from "../src/executor/independent-review.ts";

let tk: TestKernel;
let off: TestKernel;
let cloud: CloudV0;

before(async () => {
  cloud = await startCloudV0({ tenant: "ten_v12-review-firm" });
  tk = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_KERNEL_TCP: "off" }, "v12-review-firm");
  off = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_KERNEL_TCP: "off", ZR_INDEPENDENT_REVIEW: "off" }, "v12-review-firm-off");
});
after(async () => {
  await tk.kernel.close();
  await off.kernel.close();
  await cloud.close();
});

type Msg = { role?: string; tool_call_id?: string; content?: unknown };
const msgs = (b: Record<string, unknown>): Msg[] => (Array.isArray(b.messages) ? (b.messages as Msg[]) : []);
const text = (m: Msg) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""));
const isReviewer = (b: Record<string, unknown>) => msgs(b).some((m) => m.role === "system" && text(m).includes("复核合伙人"));
function lastAsk(b: Record<string, unknown>): string {
  const users = msgs(b).filter((m) => m.role === "user").map(text).filter((t) => !t.startsWith("<system-reminder>"));
  return users[users.length - 1] ?? "";
}

const MAJOR = JSON.stringify({
  trace: [
    { point: "性能不达标的违约责任要有约束力", clause: "第19.4条", status: "partial", note: "违约金只在整体不能实现时适用" },
    { point: "争议提交杭州仲裁委员会", clause: "第22条", status: "covered" },
  ],
  issues: [{ severity: "major", kind: "instruction_gap", where: "合同·第19.4条", quote: "合同目的整体不能实现的", problem: "性能不达标而不解除时没有金钱责任", fix: "增设按超标幅度计的阶梯违约金" }],
  summary: "需修改后交付",
});

let reviewerCalls = 0;
let fixPrompts: string[] = [];
/** 起草：出一份合同；复核：返回给定结果；修正轮：在原文书上改一处后收尾。 */
function script(marker: string, review: string) {
  return (body: Record<string, unknown>) => {
    if (isReviewer(body)) {
      if (!msgs(body).some((m) => text(m).includes(marker))) return null;
      reviewerCalls++;
      return { content: review };
    }
    const last = lastAsk(body);
    const tools = msgs(body).filter((m) => m.role === "tool").map((m) => m.tool_call_id);
    if (last.includes("【独立复核意见】")) {
      fixPrompts.push(last);
      if (!tools.includes(`fix_${marker}`)) {
        const list = msgs(body).filter((m) => m.role === "tool").map(text).find((t) => t.includes("artifact_version_id"));
        const id = list ? /"artifact_version_id"\s*:\s*"([^"]+)"/.exec(list.replace(/\\"/g, '"'))?.[1] : undefined;
        return { toolCalls: [{ id: `fix_${marker}`, name: "mcp__legal__docx_edit_draft", args: { artifact_version_id: id, patches: [{ anchor: "性能违约暂无约定。", proposed_text: "性能不达标的，按超标幅度每一个百分点支付合同总价1%的违约金。" }] } }] };
      }
      return { content: "已采纳第1条，改在第19.4条。" };
    }
    if (!last.includes(marker)) return null;
    if (!tools.includes(`draft_${marker}`)) return { toolCalls: [{ id: `draft_${marker}`, name: "mcp__legal__docx_render_report", args: { title: "技术开发合同", sections: [{ heading: "第十九条 违约责任", paragraphs: ["19.1 性能违约暂无约定。"] }] } }] };
    return { content: "已起草。" };
  };
}

async function newMatter(k: TestKernel, title: string) {
  const { matter } = await k.inv("matters.create", { title, stance: "委托方", basis: { engagement: "confirmed", personal_info: "confirmed", sensitive: "not_applicable", subprocessor: "confirmed" }, model_endpoint: "standard" });
  return matter;
}
async function start(k: TestKernel, matterId: string, body: Record<string, unknown>) {
  const est = await k.inv("runs.estimate", { matter_id: matterId, scenario: "a1.agent_task", document_version_ids: [] });
  return k.inv("runs.start", { matter_id: matterId, estimate_id: est.estimate_id, idempotency_key: `v12r-${Math.random().toString(36).slice(2)}`, mode: "default", plan_first: false, ...body });
}

test("纯函数：解析容忍代码块；有重要缺陷或要点没落实才修正；修正轮的话写明律师要点优先", () => {
  const r = parseReview("```json\n" + MAJOR + "\n```");
  assert.equal(r.issues.length, 1);
  assert.equal(reviewNeedsFix(r), true);
  assert.match(reviewFixPrompt(r), /律师在指令里明确给出的交易要点.*以律师为准/);
  assert.match(reviewFixPrompt(r), /性能不达标的违约责任要有约束力——只落实一半/);
  assert.match(reviewSummaryLine(r, true), /指令要点 2 项，1 项没有落实或只落实一半；发现重要 1 处；已交助手/);
  const minorOnly = parseReview(JSON.stringify({ trace: [{ point: "a", clause: "1", status: "covered" }], issues: [{ severity: "minor", kind: "drafting", where: "x", problem: "措辞" }] }));
  assert.equal(reviewNeedsFix(minorOnly), false, "只有轻微问题不再占一轮");
  assert.equal(parseReview("不是 JSON").unparsed, true);
  assert.equal(reviewNeedsFix(parseReview("不是 JSON")), false);
  const m = reviewMessages({ goal: "起草", stance: "委托方", jurisdiction: "中国大陆", asOf: "2026-11-04", method: "contract-draft", checklist: ["金额大小写一致"], docs: [{ name: "合同", text: "正文" }] });
  assert.match(m[0]!.content, /你不是起草人/);
  assert.match(m[1]!.content, /【该方法的质量自检清单/);
});

test("复核发现重要缺陷：交回同一会话修正，文书出新版本，任务照常完成；时间线有复核与修正记录", { timeout: 300_000 }, async () => {
  const matter = await newMatter(tk, "V12 独立复核");
  reviewerCalls = 0;
  fixPrompts = [];
  cloud.model.script = script("V12REVIEW", MAJOR);
  try {
    const r = await start(tk, matter.matter_id, { goal: "V12REVIEW 起草技术开发合同，性能不达标的违约责任要有约束力", skill: "contract-draft", title: "起草合同" });
    const a = await waitRun(tk.inv, r.run_id, 240_000);
    const types = a.events.map((e: any) => e.type);
    assert.equal(a.run.status, "succeeded", JSON.stringify(types));
    assert.equal(reviewerCalls, 1, "复核只调用一次");
    const rv = a.events.find((e: any) => e.type === "agent.independent_review");
    assert.ok(rv && rv.payload.fix_requested === true && rv.payload.counts.major === 1, JSON.stringify(rv?.payload));
    assert.ok(types.includes("agent.review_fix_started") && types.includes("agent.review_fix_outcome"), JSON.stringify(types));
    assert.ok(fixPrompts.some((t) => t.includes("性能不达标而不解除时没有金钱责任")), `复核意见交给了助手：${JSON.stringify(a.events.filter((e: any) => e.seq >= 9050).map((e: any) => [e.seq, e.type, JSON.stringify(e.payload).slice(0, 300)]))}`);
    const reports = a.artifacts.filter((x: any) => x.kind === "agent_report");
    assert.ok(reports.length >= 2, `修正轮在原文书上出了新版本：${JSON.stringify(a.artifacts.map((x: any) => [x.kind, x.filename]))}`);
  } finally {
    cloud.model.script = null;
  }
});

test("没有问题：不占修正轮；关闭开关：不复核", { timeout: 300_000 }, async () => {
  const clean = JSON.stringify({ trace: [{ point: "起草技术开发合同", clause: "全文", status: "covered" }], issues: [], summary: "可交付" });
  reviewerCalls = 0;
  cloud.model.script = script("V12CLEAN", clean);
  try {
    const m1 = await newMatter(tk, "V12 复核无问题");
    const a = await waitRun(tk.inv, (await start(tk, m1.matter_id, { goal: "V12CLEAN 起草技术开发合同", skill: "contract-draft", title: "起草合同" })).run_id, 240_000);
    assert.equal(a.run.status, "succeeded");
    assert.equal(reviewerCalls, 1);
    assert.ok(!a.events.some((e: any) => e.type === "agent.review_fix_started"));
    reviewerCalls = 0;
    const m2 = await newMatter(off, "V12 复核关闭");
    const b = await waitRun(off.inv, (await start(off, m2.matter_id, { goal: "V12CLEAN 起草技术开发合同", skill: "contract-draft", title: "起草合同" })).run_id, 240_000);
    assert.equal(b.run.status, "succeeded");
    assert.equal(reviewerCalls, 0, "关闭开关不复核");
    assert.ok(!b.events.some((e: any) => e.type === "agent.independent_review"));
  } finally {
    cloud.model.script = null;
  }
});

test("按意见改原件的任务：复核只核对落实与联动，修正轮不改授权范围外的条款、联动写进答复并附替代条款", () => {
  const m = reviewMessages({ goal: "改第5.1款", stance: "买方", jurisdiction: "中国大陆", asOf: "2026-11-04", method: "doc-revise", checklist: [], docs: [{ name: "清洁稿", text: "正文" }], revise: true });
  assert.match(m[0]!.content, /律师授权范围以外的条款起草人不得改，你也不要求改/);
  assert.match(m[0]!.content, /没收或扣留款项/);
  const r = parseReview(JSON.stringify({ trace: [{ point: "5.1", clause: "5.1", status: "covered" }], issues: [{ severity: "major", kind: "logic_conflict", where: "9.3", problem: "没收预付款架空 5.2 上限", fix: "第9.3款改为……" }] }));
  const f = reviewFixPrompt(r, { revise: true });
  assert.match(f, /不改正文（律师说了其他条款不要动）/);
  assert.doesNotMatch(f, /docx\.edit_draft/);
});
