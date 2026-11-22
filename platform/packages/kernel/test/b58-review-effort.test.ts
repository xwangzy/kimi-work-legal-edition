/**
 * 第 58 批（D-235）：独立复核与回看缺省用高强度推理。
 * 第 57 批两卡对照（案件汇报、劳动者请求测算）：同一份复核输入 high 都抓到了评分认定的头号问题，low 都漏了，且各提了一条方向不对的“必须改”。
 * - 不设 ZR_REVIEW_EFFORT：复核与回看的请求都带 reasoning_effort=high，输出上限放宽（复核 32k、回看 16k），回看时限 10 分钟；
 * - ZR_REVIEW_EFFORT=low 调回低强度（24k / 8k / 5 分钟）。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "b58-review-effort-secret-0123456789ab";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { importBytes, makeKernel, waitRun, type TestKernel } from "./helpers.ts";
import { startCloudV0, type CloudV0 } from "./cloud-v0.ts";
import { followUpLimitMs, followUpMaxTokens, reviewEffortOf, reviewMaxTokens } from "../src/executor/executor.ts";

let tk: TestKernel;
let cloud: CloudV0;

before(async () => {
  cloud = await startCloudV0({ tenant: "ten_b58-review-effort" });
  tk = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_KERNEL_TCP: "off", ZR_INDEPENDENT_REVIEW: "on", ZR_REVIEW_LIMIT_MS: "20000", ZR_REVIEW_FIX_LIMIT_MS: "20000", ZR_REVIEW_RETRY_WAIT_MS: "50" }, "b58-review-effort");
});

after(async () => {
  await tk.kernel.close();
  await cloud.close();
});

type Msg = { role?: string; tool_call_id?: string; content?: unknown };
const msgs = (body: Record<string, unknown>): Msg[] => (Array.isArray(body.messages) ? (body.messages as Msg[]) : []);
const REVIEWER = "现在独立复核";
const LOOK_BACK = "逐条核对你标为“必须改”的意见";
const M = "B58EFFORT";

test("纯函数：缺省 high；low 时上限与时限回到原值", () => {
  assert.equal(reviewEffortOf({}), "high");
  assert.equal(reviewEffortOf({ reviewEffort: undefined }), "high");
  assert.equal(reviewEffortOf({ reviewEffort: "low" }), "low");
  assert.equal(reviewMaxTokens("high"), 32_000);
  assert.equal(reviewMaxTokens("low"), 24_000);
  assert.equal(followUpMaxTokens("high"), 16_000);
  assert.equal(followUpMaxTokens("low"), 8_000);
  assert.equal(followUpLimitMs("high", 15 * 60_000), 10 * 60_000);
  assert.equal(followUpLimitMs("low", 15 * 60_000), 5 * 60_000);
  assert.equal(followUpLimitMs("high", 20_000), 20_000, "律所配置的复核时限更短时取更短的");
});

test("不设 ZR_REVIEW_EFFORT：复核与回看请求都以高强度发出", { timeout: 200_000 }, async () => {
  const seen = { review: [] as Record<string, unknown>[], lookBack: [] as Record<string, unknown>[], drafter: [] as Record<string, unknown>[] };
  cloud.model.script = (body) => {
    const ms = msgs(body);
    const sys = ms.filter((m) => m.role === "system").map((m) => String(m.content ?? "")).join("\n");
    if (sys.includes(LOOK_BACK)) {
      seen.lookBack.push(body);
      return { content: "【1】已落实｜第 2.1 款已是 180 万元" };
    }
    if (sys.includes(REVIEWER)) {
      seen.review.push(body);
      return { content: "【1】第二条｜价款写成 170 万元，与委托要求的 180 万元不一致｜委托：价款180万元｜2.1 改为“价款为人民币180万元”｜必须改" };
    }
    const users = ms.filter((m) => m.role === "user").map((m) => JSON.stringify(m.content ?? ""));
    if (!(users[0] ?? "").includes(M)) return null;
    seen.drafter.push(body);
    const done = (id: string) => ms.some((m) => m.role === "tool" && m.tool_call_id === id);
    const last = users[users.length - 1] ?? "";
    if (last.includes("【独立复核】")) {
      if (!done("edit_180")) {
        const r = ms.find((m) => m.role === "tool" && m.tool_call_id === "render_1");
        const id = /artv_[0-9a-f-]+/.exec(JSON.stringify(r?.content ?? ""))?.[0];
        return { toolCalls: [{ id: "edit_180", name: "mcp__legal__docx_edit_draft", args: { artifact_version_id: id, patches: [{ anchor: "价款为人民币170万元", proposed_text: "价款为人民币180万元" }] } }] };
      }
      return { content: "已按独立复核意见改正。\n\n独立复核处理情况：\n1｜已改（第 2.1 款价款改为 180 万元）" };
    }
    if (done("render_1")) return { content: "已起草《设备买卖合同》。" };
    return { toolCalls: [{ id: "render_1", name: "mcp__legal__docx_render_report", args: { title: "设备买卖合同", sections: [{ heading: "第一条 标的", paragraphs: ["1.1 买方向卖方购买压装设备一台。"] }, { heading: "第二条 价款", paragraphs: ["2.1 价款为人民币170万元。"] }] } }] };
  };
  const { matter } = await tk.inv("matters.create", { title: "复核强度", stance: "买方", basis: { engagement: "confirmed", personal_info: "confirmed", sensitive: "not_applicable", subprocessor: "confirmed" }, basis_source: "engagement_terms", basis_ref: "委托合同第 9 条", model_endpoint: "standard" });
  const doc = await importBytes(tk.inv, matter.matter_id, "交易条款清单.txt", Buffer.from("设备：压装设备一台。价款：人民币180万元，验收合格后10日内一次付清。", "utf8"), "text/plain");
  const est = await tk.inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [doc.document_version_id] });
  const r = await tk.inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `b58eff-${Date.now()}`, goal: `${M} 起草设备买卖合同，价款180万元`, skill: "contract-draft", mode: "default", plan_first: false });
  const d = await waitRun(tk.inv, r.run_id, 150_000);
  assert.equal(d.run.status, "succeeded", JSON.stringify(d.events.map((e: any) => e.type)));
  assert.equal(seen.review.length, 1, "做了一次独立复核");
  assert.equal(seen.review[0]!.reasoning_effort, "high");
  assert.equal(seen.review[0]!.max_completion_tokens, 32_000, "出站时 max_tokens 改写为 max_completion_tokens");
  assert.ok(seen.lookBack.length >= 1, "必须改交回修改后做了回看");
  assert.equal(seen.lookBack[0]!.reasoning_effort, "high");
  assert.equal(seen.lookBack[0]!.max_completion_tokens, 16_000);
});

// 第 58 批（C6）：方法原先要求逐处标的计算与核验状态，交付前检查按固定串拦下
import { checkDeliverable } from "../src/services/deliverable-check.ts";
test("交付前检查：工具计算、手工计算请复核、未读取范围、基于未确认事实，内部稿也报", () => {
  const hit = (p: string) => checkDeliverable("尽调报告（内部稿）", [{ heading: "一、发现", paragraphs: [p] }]).issues.map((i) => i.kind + ":" + i.fix).join("\n");
  for (const p of ["敞口约 120,000 元（手工计算，请复核）。", "以下均为工具计算。", "工作年限 5.5 年（工具计算）。", "未读取范围：不存在。", "基于未确认事实：原告已交货。"]) {
    assert.match(hit(p), /计算与核验状态|删去这类/, p);
  }
  for (const p of ["敞口 = 120,000 × 10% = 12,000 元。", "经核算，工作年限为 5.5 年。", "以下事实出自材料，尚待确认。"]) {
    assert.doesNotMatch(hit(p), /删去这类计算与核验状态/, p);
  }
});

// 第 58 批（复核 C4）：确定性计算工具的结果记作金额出处
import { calcResultTexts, invokeTool } from "../src/tools/registry.ts";
import { checkAmounts } from "../src/services/amount-check.ts";
test("诉讼费工具算出的数并入金额出处：文书里引用它不再报“找不到出处”", async () => {
  const out = (await invokeTool("calc.court_fee", { kind: "case_property", amount_yuan: 1_234_567 }, { claims: { rid: "run_b58_fee" } } as any)) as any;
  const texts = calcResultTexts(["run_b58_fee"]);
  assert.equal(texts.length, 1);
  const fee = Number(out.fee_yuan ?? out.amount_yuan ?? out.total_yuan);
  assert.ok(fee > 0, JSON.stringify(out).slice(0, 300));
  // 金额出处核对只在这一单有计算表时做：一张计算表 + 一份文书，文书里引用诉讼费工具算出的受理费
  const docs = [
    { kind: "xlsx" as const, filename: "计算明细.xlsx", rows: [{ where: "汇总第 1 行", cells: ["本金", "1,234,567.00 元"] }] },
    { kind: "docx" as const, filename: "案情分析.docx", paragraphs: [{ where: "第 3 段", text: `案件受理费预计 ${fee.toLocaleString("en-US", { minimumFractionDigits: 2 })} 元。` }] },
  ];
  const without = checkAmounts({ docs, sources: [] }).issues.filter((i) => i.kind === "orphan_amount");
  const withCalc = checkAmounts({ docs, sources: texts }).issues.filter((i) => i.kind === "orphan_amount");
  assert.ok(without.length >= 1, "没有工具结果时报找不到出处");
  assert.equal(withCalc.length, 0, JSON.stringify(withCalc));
  assert.deepEqual(calcResultTexts(["run_other"]), []);
});

test("交付前检查：逐条挂“已核验”报一次；解释代号的话（“同一代号地址”）报出", () => {
  const many = checkDeliverable("庭审提纲", [{ heading: "依据", paragraphs: ["民法典第五百零九条（已核验）。", "民法典第五百七十七条（已核验）。", "民法典第六百二十条（已核验）。", "民事诉讼法第六十七条（已核验）。"] }]);
  assert.equal(many.issues.filter((i) => i.text.startsWith("核验状态标注")).length, 1, JSON.stringify(many.issues));
  const few = checkDeliverable("庭审提纲", [{ heading: "依据", paragraphs: ["民法典第五百零九条（已核验）。"] }]);
  assert.equal(few.issues.filter((i) => i.text.startsWith("核验状态标注")).length, 0);
  const tok = checkDeliverable("庭审提纲", [{ heading: "发问", paragraphs: ["受托方住所为原告同一代号地址的3幢。"] }]);
  assert.ok(tok.issues.some((i) => i.kind === "internal_term" && i.text.includes("代号")), JSON.stringify(tok.issues));
});

import { reviewEffortDowngrade } from "../src/executor/executor.ts";
test("高强度复核跑了很久被断开：重试降为低强度；限流、短时失败、低强度不降", () => {
  assert.equal(reviewEffortDowngrade("high", "terminated", 600_000), "low");
  assert.equal(reviewEffortDowngrade("high", "other side closed", 8 * 60_000), "low");
  assert.equal(reviewEffortDowngrade("high", "terminated", 60_000), null, "很快断开的照原强度重试");
  assert.equal(reviewEffortDowngrade("high", "upstream_429 rate limit", 600_000), null);
  assert.equal(reviewEffortDowngrade("low", "terminated", 600_000), null);
});

test("对外文书里上传文件的文件名式引用报出；内部稿不报", () => {
  const out = checkDeliverable("质证意见", [{ heading: "一、对证据1的质证意见", paragraphs: ["我方材料《02-送货单、验收单与现场服务确认单》显示设备已验收。", "见《售后服务记录.docx》。", "证据2《送货单》载明 2025 年 12 月 3 日验收。"] }]);
  const hits = out.issues.filter((i) => i.kind === "note_to_lawyer" && /文件名/.test(i.fix));
  assert.equal(hits.length, 2, JSON.stringify(out.issues));
  const inner = checkDeliverable("庭审提纲（内部工作稿）", [{ heading: "证据", paragraphs: ["我方材料《02-送货单、验收单与现场服务确认单》。"] }]);
  assert.equal(inner.issues.filter((i) => i.kind === "note_to_lawyer" && /文件名/.test(i.fix)).length, 0);
});
