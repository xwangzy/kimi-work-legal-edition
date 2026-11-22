/**
 * 第 57 批（偏离 D-229）：整单金额勾稽并入独立复核。
 * - 复核模型说“未发现实质问题”，但文书里写出来的算式两边不等：内核把它列为必须改、交回修改；
 * - 修改后由内核重跑同一项核对判断是否落实，不调模型回看；改好了任务记成功；
 * - 修改轮没改：任务记部分完成，并写明第几条没落实；
 * - 文书里的金额在最新计算表与材料里都找不到出处：同样列为必须改。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "b57-amount-reconcile-secret-0123456789";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { importBytes, makeKernel, waitRun, type TestKernel } from "./helpers.ts";
import { startCloudV0, type CloudV0 } from "./cloud-v0.ts";
import { MACHINE_BASIS, machineFindings, issueKey } from "../src/executor/amount-reconcile.ts";

let tk: TestKernel;
let cloud: CloudV0;

before(async () => {
  cloud = await startCloudV0({ tenant: "ten_b57-amount-reconcile" });
  tk = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_KERNEL_TCP: "off", ZR_INDEPENDENT_REVIEW: "on", ZR_REVIEW_LIMIT_MS: "20000", ZR_REVIEW_FIX_LIMIT_MS: "20000", ZR_REVIEW_RETRY_WAIT_MS: "0" }, "b57-amount-reconcile");
});

after(async () => {
  await tk.kernel.close();
  await cloud.close();
});

type Msg = { role?: string; tool_call_id?: string; content?: unknown };
const msgs = (body: Record<string, unknown>): Msg[] => (Array.isArray(body.messages) ? (body.messages as Msg[]) : []);
const REVIEWER = "现在独立复核";
const LOOK_BACK = "逐条核对你标为“必须改”的意见";
type Seen = { review: number; lookBack: number; fixUser: string[] };

/**
 * 主任务出一份《违约金测算说明》（Word）与一份计算表（Excel）。wrong 决定 Word 里写错的是什么：
 * equation：算式“810,000×0.0005×22＝9,910”（应为 8,910）；orphan：正文写“合计 69,910.00 元”，而计算表与材料里只有 69,010.00。
 * 复核模型一律答“未发现实质问题”。修改轮：fix=true 时用 docx.edit_draft 改正，否则只写答复。
 */
function script(marker: string, wrong: "equation" | "orphan", seen: Seen, fix: boolean) {
  const bad = wrong === "equation" ? "第一段违约金：810,000×0.0005×22＝9,910 元。" : "三段违约金合计 69,910.00 元。";
  const good = wrong === "equation" ? "第一段违约金：810,000×0.0005×22＝8,910 元。" : "三段违约金合计 69,010.00 元。";
  return (body: Record<string, unknown>) => {
    const ms = msgs(body);
    const sys = ms.filter((m) => m.role === "system").map((m) => String(m.content ?? "")).join("\n");
    if (sys.includes(LOOK_BACK)) {
      seen.lookBack += 1;
      return { content: "【1】已落实｜最新版已改" };
    }
    if (sys.includes(REVIEWER)) {
      seen.review += 1;
      return { content: "未发现实质问题。" };
    }
    const users = ms.filter((m) => m.role === "user").map((m) => JSON.stringify(m.content ?? ""));
    if (!(users[0] ?? "").includes(marker)) return null;
    const done = (id: string) => ms.some((m) => m.role === "tool" && m.tool_call_id === id);
    const cur = [...users].reverse().find((u) => /【独立复核】/.test(u)) ?? users[0]!;
    if (!done("sheet_1")) {
      return { toolCalls: [{ id: "sheet_1", name: "mcp__legal__xlsx_render_table", args: { title: "计算明细", sheets: [{ name: "分段", columns: ["段", "本金", "日数", "金额（元）"], rows: [[1, 810000, 22, 8910], [2, 510000, 74, 18870], [3, 310000, 266, 41230], ["合计", null, null, 69010]] }] } }] };
    }
    const render = ms.find((m) => m.role === "tool" && m.tool_call_id === "render_1");
    if (!render) {
      return { toolCalls: [{ id: "render_1", name: "mcp__legal__docx_render_report", args: { title: "违约金测算说明", sections: [{ heading: "一、测算", paragraphs: [bad, "本金余额 310,000 元。"] }] } }] };
    }
    if (!cur.includes("【独立复核】")) return { content: "已出具《违约金测算说明》与《计算明细》。" };
    seen.fixUser.push(cur);
    if (fix && !done("edit_1")) {
      const id = /《违约金测算说明\.docx》——用 docx\.edit_draft，成果编号 (artv_[0-9a-f-]+)/.exec(cur.replace(/\\"/g, '"'))?.[1] ?? /artv_[0-9a-f-]+/.exec(JSON.stringify(render.content ?? ""))?.[0];
      return { toolCalls: [{ id: "edit_1", name: "mcp__legal__docx_edit_draft", args: { artifact_version_id: id, patches: [{ anchor: bad, proposed_text: good }] } }] };
    }
    return { content: fix ? "已按独立复核意见改正。\n\n独立复核处理情况：\n1｜已改" : "独立复核处理情况：\n1｜未改，最新版已经正确" };
  };
}

async function run(marker: string, wrong: "equation" | "orphan", fix: boolean) {
  const seen: Seen = { review: 0, lookBack: 0, fixUser: [] };
  cloud.model.script = script(marker, wrong, seen, fix);
  const { matter } = await tk.inv("matters.create", { title: `勾稽 ${marker}`, stance: "卖方", basis: { engagement: "confirmed", personal_info: "confirmed", sensitive: "not_applicable", subprocessor: "confirmed" }, basis_source: "engagement_terms", basis_ref: "委托合同第 9 条", model_endpoint: "standard" });
  const doc = await importBytes(tk.inv, matter.matter_id, "收款记录.txt", Buffer.from("验收款 810,000 元；2025-12-26 收 300,000 元；2026-03-10 收 200,000 元。违约金每日万分之五。", "utf8"), "text/plain");
  const est = await tk.inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [doc.document_version_id] });
  const r = await tk.inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `b57-${marker}-${Date.now()}-${Math.random()}`, goal: `${marker} 测算逾期违约金并出一份测算说明`, document_version_ids: [doc.document_version_id], skill: "client-advice", mode: "default", plan_first: false });
  const done = await waitRun(tk.inv, r.run_id, 120_000);
  return { done, seen };
}
const types = (d: any) => d.events.map((e: any) => e.type);
const payload = (d: any, type: string) => d.events.find((e: any) => e.type === type)?.payload;

test("①machineFindings：编号接在模型意见之后，都是必须改，依据写明是系统复算", () => {
  const issues = [
    { kind: "equation" as const, where: "一、测算 第 1 段", text: "810,000×0.0005×22＝9,910", expected: 8910, actual: 9910, fix: "改", filename: "说明.docx" },
    { kind: "orphan_amount" as const, where: "一、测算 第 2 段", text: "合计 69,910.00 元", amount: 69910, fix: "改", filename: "说明.docx" },
  ];
  const f = machineFindings(issues, 4);
  assert.deepEqual(f.map((x) => [x.no, x.must, x.level, x.basis]), [[4, true, "must", MACHINE_BASIS], [5, true, "must", MACHINE_BASIS]]);
  assert.match(f[0]!.problem, /左边算出来是 8,910\.00，写的是 9,910\.00/);
  assert.match(f[1]!.problem, /69,910\.00 元.*找不到出处/);
  assert.equal(f[0]!.machine_key, issueKey(issues[0]!));
});

test("②算式两边不等、复核模型没发现：内核列为必须改并交回；改好后内核重跑核对，不调模型回看，任务成功", { timeout: 150_000 }, async () => {
  const { done, seen } = await run("B57EQFIX", "equation", true);
  assert.equal(done.run.status, "succeeded", JSON.stringify(types(done)));
  const completed = payload(done, "review.completed");
  assert.equal(completed.machine, 1, JSON.stringify(completed));
  assert.equal(completed.must, 1);
  assert.match(completed.items[0].problem, /两边不等/);
  assert.equal(seen.fixUser.length >= 1, true, "进了修改轮");
  assert.match(seen.fixUser[0]!, /系统复算/);
  assert.equal(seen.lookBack, 0, "机器核对的意见不调模型回看");
  const fu = payload(done, "review.followup");
  assert.deepEqual([fu.done, fu.open, fu.machine], [1, [], 1], JSON.stringify(fu));
});

test("③修改轮没有改：内核重跑核对仍不一致，任务记部分完成并写明哪一条没落实", { timeout: 150_000 }, async () => {
  const { done, seen } = await run("B57EQOPEN", "equation", false);
  assert.equal(done.run.status, "partial", JSON.stringify(types(done)));
  assert.equal(seen.lookBack, 0);
  const fu = payload(done, "review.followup");
  assert.deepEqual(fu.open, [1], JSON.stringify(fu));
  assert.match(JSON.stringify(done.events), /第 1 条没有落实到最新版文件/);
  // 最终答复与回看结论对齐：起草方答“未改，最新版已经正确”，答复最前面加了系统核对结论
  const reply = tk.kernel.db.get<{ storage_uri: string }>(`SELECT storage_uri FROM artifact_versions WHERE run_id = ? AND kind IN ('a1_agent_draft','a1_agent_draft_partial') ORDER BY created_at DESC, version DESC LIMIT 1`, [done.run.run_id]);
  const text = tk.kernel.blobs.read(reply!.storage_uri).toString("utf8");
  assert.match(text, /^> \*\*系统核对\*\*：.*第 1 条.*没有落实到文件里/);
  assert.match(text, /未改，最新版已经正确/, "原答复保留在后面");
});

test("④文书里的金额在计算表和材料里都找不到：列为必须改；改成计算表里的数后任务成功", { timeout: 150_000 }, async () => {
  const { done } = await run("B57ORPHAN", "orphan", true);
  assert.equal(done.run.status, "succeeded", JSON.stringify(types(done)));
  const completed = payload(done, "review.completed");
  assert.equal(completed.machine, 1, JSON.stringify(completed));
  assert.match(completed.items[0].problem, /69,910\.00 元.*找不到出处/);
  assert.deepEqual(payload(done, "review.followup").open, []);
});

test("⑤复核与回看：分析截止日与实际运行日不同时，告诉复核人两个日期各管什么；相同时不加", async () => {
  const { reviewMessages, followUpMessages, runDateLines } = await import("../src/services/independent-review.ts");
  assert.deepEqual(runDateLines("2026-11-22", "2026-11-22"), []);
  const base = { kind: "table" as const, stance: "投资方", jurisdiction: "中国大陆", goal: "审回稿", materials: [], docs: [{ filename: "变更清单.xlsx", text: "比对时间：2026年11月22日" }], diff: [], inventory: [], reply: "" };
  const diff = reviewMessages({ ...base, asOf: "2026-11-09", today: "2026-11-22" }).map((m) => m.content).join("\n");
  assert.match(diff, /【日期】事项的分析截止日是 2026-11-09，这些文件实际生成于 2026-11-22：.*不算没有依据/);
  assert.doesNotMatch(reviewMessages({ ...base, asOf: "2026-11-22", today: "2026-11-22" }).map((m) => m.content).join("\n"), /【日期】/);
  const fu = followUpMessages({ findings: [{ no: 5, where: "变更清单", problem: "比对时间没有依据", basis: "", fix: "删去", must: true }], handling: "5｜未改", docs: [], hints: [], asOf: "2026-11-09", today: "2026-11-22" }).map((m) => m.content).join("\n");
  assert.match(fu, /【日期】事项的分析截止日是 2026-11-09/);
});

test("⑥复核取法条：以某部法命名的司法解释、实施条例的条号不归到这部法上", async () => {
  const { lawRefsIn } = await import("../src/services/independent-review.ts");
  const refs = lawRefsIn(["依据《民法典》第五百八十五条；民法典合同编通则解释第三十一条、第五十五条；劳动合同法实施条例第二十五条；劳动合同法（2012年修正）第四十七条。"]);
  const civil = refs.filter((r) => r.law === "民法典").map((r) => r.article);
  assert.deepEqual(civil, [585], JSON.stringify(refs));
  assert.ok(refs.some((r) => /合同编通则若干问题的解释/.test(r.law) && r.article === 31), JSON.stringify(refs));
  assert.ok(refs.some((r) => r.law === "劳动合同法" && r.article === 47));
  assert.equal(refs.some((r) => r.law === "劳动合同法" && r.article === 25), false);
  const bare = lawRefsIn(["《民法典》第五百八十五条；合同编通则解释第六十五条应改为第六十四条。"], { followBare: true });
  assert.equal(bare.some((r) => r.law === "民法典" && r.article === 65), false, JSON.stringify(bare));
});

test("⑦上游限流时复核多试几次：429 五次后成功 → 照常复核、任务成功；一直 429 → 试满 6 次后部分完成，提示里没有研发用语", { timeout: 200_000 }, async () => {
  const { reviewRetryWait, reviewFailureReason } = await import("../src/executor/executor.ts");
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => reviewRetryWait("模型通道 429（模型服务返回 429 [kwl:upstream_429]）", n, 15_000)), [15_000, 30_000, 60_000, 60_000, 60_000, null]);
  assert.deepEqual([1, 2].map((n) => reviewRetryWait("bad request", n, 15_000)), [15_000, null], "其他错误照旧只重试一次");
  assert.equal(reviewFailureReason("模型通道 429（模型服务返回 429 [kwl:upstream_429]；交编排层有界退避，不切换端点）"), "AI 服务繁忙，请求被限流，重试几次仍没有成功");

  const runWith = async (marker: string, failTimes: number) => {
    const seen: Seen = { review: 0, lookBack: 0, fixUser: [] };
    const base = script(marker, "equation", seen, true);
    let reviewerCalls = 0;
    cloud.model.script = (body) => {
      const sys = msgs(body).filter((m) => m.role === "system").map((m) => String(m.content ?? "")).join("\n");
      if (sys.includes(REVIEWER) && ++reviewerCalls <= failTimes) return { status: 429, content: "rate limited" };
      return base(body);
    };
    const { matter } = await tk.inv("matters.create", { title: `限流 ${marker}`, stance: "卖方", basis: { engagement: "confirmed", personal_info: "confirmed", sensitive: "not_applicable", subprocessor: "confirmed" }, basis_source: "engagement_terms", basis_ref: "委托合同第 9 条", model_endpoint: "standard" });
    const doc = await importBytes(tk.inv, matter.matter_id, "收款记录.txt", Buffer.from("验收款 810,000 元。", "utf8"), "text/plain");
    const est = await tk.inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [doc.document_version_id] });
    const r = await tk.inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `b57-${marker}-${Date.now()}`, goal: `${marker} 出一份测算说明`, document_version_ids: [doc.document_version_id], skill: "client-advice", mode: "default", plan_first: false });
    return { done: await waitRun(tk.inv, r.run_id, 150_000), reviewerCalls: () => reviewerCalls };
  };
  const ok = await runWith("B57RL5", 5);
  assert.equal(ok.reviewerCalls(), 6);
  assert.ok(ok.done.events.some((e: any) => e.type === "review.completed"), "第六次成功，复核照常完成");
  const bad = await runWith("B57RLX", 99);
  assert.equal(bad.done.run.status, "partial");
  assert.equal(bad.reviewerCalls(), 6, "限流最多试 6 次");
  const remaining = String(bad.done.events.find((e: any) => e.type === "run.partial")?.payload.remaining?.join("") ?? "");
  assert.match(remaining, /独立复核没有完成（AI 服务繁忙，请求被限流，重试几次仍没有成功）：这一稿未经独立复核/);
  assert.doesNotMatch(remaining, /429|upstream|端点|编排/);
});

test("⑧“调解仲裁法”是劳动争议调解仲裁法的简称，不是仲裁法", async () => {
  const { lawRefsIn } = await import("../src/services/independent-review.ts");
  const { extractCitations } = await import("../src/tools/tools/citations.ts");
  const refs = lawRefsIn(["依据调解仲裁法第二十七条、第四十七条，以及仲裁法第十六条。"]);
  assert.deepEqual(refs.filter((r) => /^(?:中华人民共和国)?仲裁法$/.test(r.law)).map((r) => r.article), [16], JSON.stringify(refs));
  assert.ok(refs.some((r) => /调解仲裁法/.test(r.law) && r.article === 27) && refs.some((r) => /调解仲裁法/.test(r.law) && r.article === 47), JSON.stringify(refs));
  const cites = extractCitations("调解仲裁法第二十七条规定了一年的仲裁时效。");
  assert.equal(cites.length, 1);
  assert.match(cites[0]!.law, /调解仲裁法/);
});
