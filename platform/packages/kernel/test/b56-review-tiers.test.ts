/**
 * 第 56 批（偏离 D-223）：独立复核意见分档。
 * - 复核意见保留四级（必须改 / 建议改 / 建议复算 / 风险提示），原先解析时压成 must 布尔；
 * - 只有非“必须改”的意见时不跑修改轮：意见登记为《独立复核意见》（写明只有建议、没有自动修改），记 review.skipped（suggestions_only），任务记成功；
 * - 有“必须改”时照旧自动交回修改（传全部意见）、回看；
 * - 律师在任务页勾选意见后发起的“按复核意见修改”追问（review_apply）不再复核、不再自动修改；
 * - 修改轮没做完时 review.fix_outcome 带上已改出的新版本（界面据此不一律写“文书是复核前的版本”）。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "b56-review-tiers-secret-0123456789ab";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { importBytes, makeKernel, waitRun, type TestKernel } from "./helpers.ts";
import { startCloudV0, type CloudV0 } from "./cloud-v0.ts";
import { findingLevel, parseFindings, reviewItems, reviewNote } from "../src/services/independent-review.ts";

let tk: TestKernel;
let cloud: CloudV0;

before(async () => {
  cloud = await startCloudV0({ tenant: "ten_b56-review-tiers" });
  tk = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_KERNEL_TCP: "off", ZR_INDEPENDENT_REVIEW: "on", ZR_REVIEW_LIMIT_MS: "20000", ZR_REVIEW_FIX_LIMIT_MS: "20000", ZR_REVIEW_RETRY_WAIT_MS: "0" }, "b56-review-tiers");
});

after(async () => {
  await tk.kernel.close();
  await cloud.close();
});

type Msg = { role?: string; tool_call_id?: string; content?: unknown };
const msgs = (body: Record<string, unknown>): Msg[] => (Array.isArray(body.messages) ? (body.messages as Msg[]) : []);
const REVIEWER = "现在独立复核";
const LOOK_BACK = "逐条核对你标为“必须改”的意见";
const SUGGESTIONS = "【1】第一条｜标的型号未写｜条款清单｜补写型号｜建议改\n【2】第二条｜付款期限按日历日还是工作日未写明｜条款清单：验收合格后10日内｜复核 10 日的起算｜建议复算\n【3】第五条｜未约定质保期，可能对买方不利｜无｜提示律师与客户确认｜风险提示";

type Seen = { review: number; lookBack: number; fixUser: string[]; applyUser: string[] };

/** 主任务出一份合同（价款 100 万）；复核回 reviewText；修改轮与“按复核意见修改”的追问都把 100 万改成 120 万再写答复。 */
function script(marker: string, reviewText: string, seen: Seen, o: { failFixAfterEdit?: boolean } = {}) {
  return (body: Record<string, unknown>) => {
    const ms = msgs(body);
    const sys = ms.filter((m) => m.role === "system").map((m) => String(m.content ?? "")).join("\n");
    if (sys.includes(LOOK_BACK)) {
      seen.lookBack += 1;
      return { content: Array.from({ length: 15 }, (_, i) => `【${i + 1}】已落实｜最新版已改`).join("\n") };
    }
    if (sys.includes(REVIEWER)) {
      seen.review += 1;
      return { content: reviewText };
    }
    const users = ms.filter((m) => m.role === "user").map((m) => JSON.stringify(m.content ?? ""));
    if (!(users[0] ?? "").includes(marker)) return null;
    const done = (id: string) => ms.some((m) => m.role === "tool" && m.tool_call_id === id);
    const cur = [...users].reverse().find((u) => /【独立复核】|按独立复核意见修改|FUAGAIN/.test(u)) ?? users[0]!;
    if (cur.includes("FUAGAIN")) {
      if (done("again_1")) return { content: "已把价款改为 130 万元。" };
      const id = /成果编号 (artv_[0-9a-f-]+)/.exec(cur)?.[1];
      return { toolCalls: [{ id: "again_1", name: "mcp__legal__docx_edit_draft", args: { artifact_version_id: id, patches: [{ anchor: "价款为人民币120万元", proposed_text: "价款为人民币130万元" }] } }] };
    }
    if (cur.includes("按独立复核意见修改")) {
      seen.applyUser.push(cur);
      if (done("apply_1")) return { content: "已按勾选的复核意见修改。\n\n复核意见处理情况：\n1｜已改" };
      const id = /成果编号 (artv_[0-9a-f-]+)/.exec(cur)?.[1];
      return { toolCalls: [{ id: "apply_1", name: "mcp__legal__docx_edit_draft", args: { artifact_version_id: id, patches: [{ anchor: "价款为人民币100万元", proposed_text: "价款为人民币120万元" }] } }] };
    }
    const render = ms.find((m) => m.role === "tool" && m.tool_call_id === "render_1");
    if (!render) {
      return { toolCalls: [{ id: "render_1", name: "mcp__legal__docx_render_report", args: { title: "设备买卖合同", sections: [{ heading: "第一条 标的", paragraphs: ["1.1 买方向卖方购买压装设备一台。"] }, { heading: "第二条 价款", paragraphs: ["2.1 价款为人民币100万元。"] }] } }] };
    }
    if (!cur.includes("【独立复核】")) return { content: "已起草《设备买卖合同》。" };
    seen.fixUser.push(cur);
    if (!done("edit_1")) {
      const id = /artv_[0-9a-f-]+/.exec(JSON.stringify(render.content ?? ""))?.[0];
      return { toolCalls: [{ id: "edit_1", name: "mcp__legal__docx_edit_draft", args: { artifact_version_id: id, patches: [{ anchor: "价款为人民币100万元", proposed_text: "价款为人民币120万元" }] } }] };
    }
    if (o.failFixAfterEdit) return { status: 400, content: "bad request" };
    return { content: "已按独立复核意见改正。\n\n独立复核处理情况：\n1｜已改（第 2.1 款价款改为 120 万元）" };
  };
}

async function newMatter(marker: string) {
  const { matter } = await tk.inv("matters.create", { title: `分档 ${marker}`, stance: "买方", basis: { engagement: "confirmed", personal_info: "confirmed", sensitive: "not_applicable", subprocessor: "confirmed" }, basis_source: "engagement_terms", basis_ref: "委托合同第 9 条", model_endpoint: "standard" });
  const doc = await importBytes(tk.inv, matter.matter_id, "交易条款清单.txt", Buffer.from("设备：压装设备一台。价款：人民币120万元，验收合格后10日内一次付清。", "utf8"), "text/plain");
  const start = async (goal: string, extra: Record<string, unknown>) => {
    const est = await tk.inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [doc.document_version_id] });
    return tk.inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `b56-${marker}-${Date.now()}-${Math.random()}`, goal, document_version_ids: [doc.document_version_id], ...extra });
  };
  return { matter, start };
}

const types = (d: any) => d.events.map((e: any) => e.type);
const manifestOf = (id: string) => JSON.parse(tk.kernel.db.get<{ manifest: string }>(`SELECT manifest FROM artifact_versions WHERE artifact_version_id = ?`, [id])!.manifest);

test("①四级解析：末栏的必须改、建议改、建议复算、风险提示各自保留；“1. …｜必须改”替代写法；末栏缺失时沿用原 must 判定", () => {
  const f = parseFindings(`${SUGGESTIONS}\n【4】第二条｜价款与委托不一致｜委托原话｜改为 120 万元｜必须改`);
  assert.deepEqual(f.map((x) => [x.no, x.level, x.must]), [[1, "should", false], [2, "recheck", false], [3, "risk", false], [4, "must", true]]);
  // 替代写法（没有【1】序号）
  const alt = parseFindings("1. 第二条｜价款写成 100 万元｜委托原话｜改为 120 万元｜必须改\n2. 第五条｜质保期未约定｜无｜提示客户｜风险提示\n3. 第三条｜违约金基数｜合同第 3.1 条｜复算｜建议复算");
  assert.deepEqual(alt.map((x) => [x.no, x.level, x.must]), [[1, "must", true], [2, "risk", false], [3, "recheck", false]]);
  // 末栏缺失（只有三栏或末栏是别的话）：整条里写了“必须改”的仍算必须改，否则算建议改
  const tailless = parseFindings("【1】第二条｜价款写错，必须改｜委托原话｜改为 120 万元\n【2】第三条｜措辞可以斟酌｜无｜调整用语｜酌情");
  assert.deepEqual(tailless.map((x) => [x.level, x.must]), [["must", true], ["should", false]]);
  // 整段兜底
  assert.equal(parseFindings("复核意见：价款写错了，必须改。")[0]!.level, "must");
  assert.equal(parseFindings("复核意见：个别措辞建议改得更明确。")[0]!.level, "should");
  // 旧检查点（只有 must）按 must 落档
  assert.equal(findingLevel({ must: true }), "must");
  assert.equal(findingLevel({ must: false }), "should");
  // 给界面的逐条载荷：至多 15 条、各栏截断且不切开代号
  const long = parseFindings(Array.from({ length: 18 }, (_, i) => `【${i + 1}】第${i + 1}条｜${"甲".repeat(598)}〔自然人·ABCDEF〕｜无｜改｜建议改`).join("\n"));
  const items = reviewItems(long);
  assert.equal(items.length, 15);
  assert.deepEqual(Object.keys(items[0]!).sort(), ["fix", "level", "no", "problem", "where"]);
  assert.ok(items[0]!.problem.endsWith("…") && !items[0]!.problem.includes("〔"), "截断时不留半截代号");
  // 《独立复核意见》写出各自的级别；只有建议时抬头写明没有自动修改
  const note = reviewNote("合同", f.slice(0, 3), "", "suggestions_only");
  assert.match(note, /只是建议，没有自动修改，由律师决定是否采纳/);
  assert.match(note, /\| 建议复算 \|/);
  assert.match(note, /\| 风险提示 \|/);
});

test("②只有建议、没有必须改：不进修改轮，意见登记为《独立复核意见》、写明由律师决定，任务记成功，事件带逐条意见", { timeout: 150_000 }, async () => {
  const seen: Seen = { review: 0, lookBack: 0, fixUser: [], applyUser: [] };
  cloud.model.script = script("B56SUG", SUGGESTIONS, seen);
  try {
    const { start } = await newMatter("B56SUG");
    const r = await start("B56SUG 起草设备买卖合同，价款120万元", { skill: "contract-draft", mode: "default", plan_first: false });
    const done = await waitRun(tk.inv, r.run_id, 120_000);
    assert.equal(done.run.status, "succeeded", JSON.stringify(types(done)));
    assert.equal(seen.review, 1);
    assert.equal(types(done).includes("review.fix_started"), false, "只有建议不进修改轮");
    assert.equal(seen.fixUser.length, 0);
    assert.equal(seen.lookBack, 0);
    const completed = done.events.find((e: any) => e.type === "review.completed")?.payload;
    assert.equal(completed.findings, 3);
    assert.equal(completed.must, 0);
    assert.deepEqual(completed.items.map((x: any) => [x.no, x.level]), [[1, "should"], [2, "recheck"], [3, "risk"]]);
    assert.deepEqual(Object.keys(completed.items[0]).sort(), ["fix", "level", "no", "problem", "where"]);
    assert.equal(completed.items[1].where, "第二条");
    const skipped = done.events.find((e: any) => e.type === "review.skipped")?.payload;
    assert.equal(skipped?.reason, "suggestions_only");
    assert.equal(skipped?.findings, 3);
    // 终态成功，“还差什么”里没有要律师必须处理的条目
    assert.equal(done.events.find((e: any) => e.type === "run.succeeded")?.payload.remaining, undefined);
    const note = done.artifacts.find((a: any) => a.kind === "a1_review_note");
    assert.ok(note, "有《独立复核意见》");
    const m = manifestOf(note.artifact_version_id);
    assert.match(m.note, /只有建议，没有自动修改，由律师决定是否采纳/);
    assert.equal(m.findings, 3);
    assert.equal(m.must, 0);
    assert.equal(m.suggestions_only, true);
    const text = Buffer.from((await tk.inv("artifacts.download", { artifact_version_id: note.artifact_version_id })).data_base64, "base64").toString("utf8");
    assert.match(text, /没有自动修改/);
    assert.doesNotMatch(text, /已交回起草的助手逐条处理/);
    // 合同只有第 1 版（没有修改轮）
    assert.equal(done.artifacts.filter((a: any) => a.kind === "agent_report" && a.filename === "设备买卖合同.docx").length, 1);
  } finally {
    cloud.model.script = null;
  }
});

test("③有必须改：修改轮照旧（传全部意见，含建议复算），回看照旧，任务记成功", { timeout: 180_000 }, async () => {
  const seen: Seen = { review: 0, lookBack: 0, fixUser: [], applyUser: [] };
  cloud.model.script = script("B56MUST", "【1】第二条｜价款写成 100 万元，与委托的 120 万元不一致｜委托原话：价款120万元｜2.1 改为“价款为人民币120万元”｜必须改\n【2】第二条｜付款期限起算未写明｜条款清单｜复核 10 日的起算｜建议复算", seen);
  try {
    const { start } = await newMatter("B56MUST");
    const r = await start("B56MUST 起草设备买卖合同，价款120万元", { skill: "contract-draft", mode: "default", plan_first: false });
    const done = await waitRun(tk.inv, r.run_id, 150_000);
    assert.equal(done.run.status, "succeeded", JSON.stringify(types(done)));
    assert.ok(types(done).includes("review.fix_started"), "有必须改照常交回修改");
    assert.equal(done.events.some((e: any) => e.type === "review.skipped"), false);
    assert.equal(done.events.find((e: any) => e.type === "review.fix_outcome")?.payload.status, "succeeded");
    assert.match(seen.fixUser.at(-1) ?? "", /【独立复核】[\s\S]*价款写成 100 万元[\s\S]*付款期限起算未写明/, "全部意见都交回");
    assert.equal(seen.lookBack, 1, "回看照常做");
    const completed = done.events.find((e: any) => e.type === "review.completed")?.payload;
    assert.deepEqual(completed.items.map((x: any) => x.level), ["must", "recheck"]);
    const note = done.artifacts.find((a: any) => a.kind === "a1_review_note" && /已交回助手逐条处理|回看/.test(manifestOf(a.artifact_version_id).note));
    assert.ok(note, "复核意见写明已交回");
  } finally {
    cloud.model.script = null;
  }
});

test("④按复核意见修改的追问（review_apply）：不再独立复核、不再自动修改；没带追问的 review_apply 被拒", { timeout: 200_000 }, async () => {
  const seen: Seen = { review: 0, lookBack: 0, fixUser: [], applyUser: [] };
  cloud.model.script = script("B56APPLY", SUGGESTIONS, seen);
  try {
    const { start } = await newMatter("B56APPLY");
    const r1 = await start("B56APPLY 起草设备买卖合同，价款120万元", { skill: "contract-draft", mode: "default", plan_first: false });
    const d1 = await waitRun(tk.inv, r1.run_id, 120_000);
    assert.equal(d1.run.status, "succeeded", JSON.stringify(types(d1)));
    assert.equal(seen.review, 1);
    // 不是追问不能带 review_apply
    await assert.rejects(start("B56APPLY 再起草一份", { skill: "contract-draft", mode: "default", plan_first: false, review_apply: true }), /按复核意见修改只能/);
    await assert.rejects(start("B56APPLY 追问", { followup_of: r1.run_id, review_apply: "yes" }), /review_apply 须为 true \/ false/);
    // 律师勾选第 1 条后发起：追问重出了合同（价款改成 120 万），但这一轮不复核、不进修改轮
    const r2 = await start("按独立复核意见修改（以下是我勾选要采纳的 1 条）：\n【1】（建议改）位置：第一条；问题：标的型号未写；改法：补写型号", { followup_of: r1.run_id, review_apply: true });
    const d2 = await waitRun(tk.inv, r2.run_id, 150_000);
    assert.equal(d2.run.status, "succeeded", JSON.stringify(types(d2)));
    assert.equal(seen.applyUser.length > 0, true, "追问按勾选的意见改了");
    assert.ok(d2.artifacts.some((a: any) => a.kind === "agent_report" && a.filename === "设备买卖合同.docx"), "本轮交出了改后的合同");
    assert.equal(seen.review, 1, "review_apply 追问不调用复核");
    assert.equal(types(d2).includes("review.started"), false);
    assert.equal(types(d2).includes("review.fix_started"), false);
    assert.equal(d2.events.find((e: any) => e.type === "review.skipped")?.payload.reason, "review_apply");
    const snap = JSON.parse(tk.kernel.db.get<{ input_snapshot: string }>(`SELECT input_snapshot FROM runs WHERE run_id = ?`, [r2.run_id])!.input_snapshot);
    assert.equal(snap.review_apply, true);
    // 同样重出文书、但没带 review_apply 的普通追问照 D-184 复核
    const r3 = await start("FUAGAIN 价款改成130万元", { followup_of: r2.run_id });
    const d3 = await waitRun(tk.inv, r3.run_id, 150_000);
    assert.equal(d3.run.status, "succeeded", JSON.stringify(types(d3)));
    assert.ok(types(d3).includes("review.started"), "普通追问重出文书照常复核");
    assert.equal(seen.review, 2);
  } finally {
    cloud.model.script = null;
  }
});

test("⑤修改轮没做完但已改出新版本：review.fix_outcome 带 revised 与 revised_files（界面不再一律写“复核前的版本”）", { timeout: 150_000 }, async () => {
  const seen: Seen = { review: 0, lookBack: 0, fixUser: [], applyUser: [] };
  cloud.model.script = script("B56HALF", "【1】第二条｜价款与委托不一致｜委托原话｜改为 120 万元｜必须改", seen, { failFixAfterEdit: true });
  try {
    const { start } = await newMatter("B56HALF");
    const r = await start("B56HALF 起草设备买卖合同，价款120万元", { skill: "contract-draft", mode: "default", plan_first: false });
    const done = await waitRun(tk.inv, r.run_id, 120_000);
    assert.equal(done.run.status, "partial", JSON.stringify(types(done)));
    const out = done.events.find((e: any) => e.type === "review.fix_outcome")?.payload;
    assert.notEqual(out.status, "succeeded");
    assert.ok(Number(out.revised) >= 1, JSON.stringify(out));
    assert.deepEqual(out.revised_files, ["设备买卖合同.docx"]);
  } finally {
    cloud.model.script = null;
  }
});
