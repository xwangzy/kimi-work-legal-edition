/**
 * V11 路由体检（文书任务交成 Excel、没交 Word 也记“完成”）：经真实内核 + kap 宿主 + 测试网关跑完整链路，模型动作由脚本固定（确定性，
 * 不代表真实模型会这样做——只验证“模型这样做时内核怎么记”）。
 * - 自由描述“起草一份协议”，没加载方法，只交了一张表：原先没有任何主交付物核对，记“已完成”；
 * - 在上一轮（没交出文书）上追问“补出来”，只答了文字：原先追问的快照里没有方法与主交付物，记“已完成”；
 * - 场景卡的方法主交付物是 Excel（回稿重审 → 变更清单），律师在说明里写了“给我 Word”：原先只核对 Excel，交了表就记“已完成”；
 * - 律师在说明里点名的格式写进任务快照（deliverable_request），追问继承上一轮没交出的主交付物（carry_primary_output）。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "v11-routing-secret-0123456789abcdef";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeKernel, waitRun, type TestKernel } from "./helpers.ts";
import { startCloudV0, type CloudV0 } from "./cloud-v0.ts";

let tk: TestKernel;
let cloud: CloudV0;

before(async () => {
  cloud = await startCloudV0({ tenant: "ten_v11-routing-firm" });
  tk = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_KERNEL_TCP: "off" }, "v11-routing-firm");
});

after(async () => {
  await tk.kernel.close();
  await cloud.close();
});

type Msg = { role?: string; tool_call_id?: string; content?: unknown };
const msgs = (body: Record<string, unknown>): Msg[] => (Array.isArray(body.messages) ? (body.messages as Msg[]) : []);

/** 本轮律师的那条消息（宿主另附的 system-reminder 不算）。 */
function lastAsk(body: Record<string, unknown>): string {
  const users = msgs(body)
    .filter((m) => m.role === "user")
    .map((m) => JSON.stringify(m.content ?? ""))
    .filter((t) => !t.startsWith('"<system-reminder>'));
  return users[users.length - 1] ?? "";
}

/** 只出一张表、然后收尾的脚本（marker 出现在本轮最后一条律师消息里才接手）。 */
function sheetOnly(marker: string) {
  return (body: Record<string, unknown>) => {
    const last = lastAsk(body);
    if (!last.includes(marker)) return null;
    const done = msgs(body).some((m) => m.role === "tool" && m.tool_call_id === `sheet_${marker}`);
    if (!done) return { toolCalls: [{ id: `sheet_${marker}`, name: "mcp__legal__xlsx_render_table", args: { title: "交易要点", sheets: [{ name: "要点", columns: ["事项", "内容"], rows: [["价款", "【待确认】"]] }] } }] };
    return { content: "已整理交易要点表。" };
  };
}

/** 只用文字答复的脚本。 */
function textOnly(marker: string) {
  return (body: Record<string, unknown>) => {
    const last = lastAsk(body);
    return last.includes(marker) ? { content: "协议要点如下：价款待确认。" } : null;
  };
}

async function newMatter(title: string) {
  const { matter } = await tk.inv("matters.create", {
    title,
    stance: "受让方",
    basis: { engagement: "confirmed", personal_info: "confirmed", sensitive: "not_applicable", subprocessor: "confirmed" },
    model_endpoint: "standard",
  });
  return matter;
}

async function start(matterId: string, body: Record<string, unknown>) {
  const est = await tk.inv("runs.estimate", { matter_id: matterId, scenario: "a1.agent_task", document_version_ids: [] });
  return tk.inv("runs.start", { matter_id: matterId, estimate_id: est.estimate_id, idempotency_key: `v11-${Math.random().toString(36).slice(2)}`, mode: "default", plan_first: false, ...body });
}

const snapshotOf = (runId: string) => JSON.parse(tk.kernel.db.get<{ input_snapshot: string }>(`SELECT input_snapshot FROM runs WHERE run_id = ?`, [runId])!.input_snapshot);

test("自由描述起草协议、没加载方法、只交了一张表：不记“已完成”，写明没交出 Word 文书；追问只答文字同样不记完成", { timeout: 240_000 }, async () => {
  const matter = await newMatter("V11 自由描述起草");
  cloud.model.script = sheetOnly("V11FREEDOC");
  try {
    const r1 = await start(matter.matter_id, { goal: "V11FREEDOC 帮我起草一份股权转让协议，转让方持有目标公司 60% 股权" });
    const a = await waitRun(tk.inv, r1.run_id, 150_000);
    const types = a.events.map((e: any) => e.type);
    assert.ok(a.artifacts.some((x: any) => x.kind === "agent_table"), "交了一张表");
    assert.equal(a.run.status, "partial", `只交了表格的起草任务不记“已完成”：${JSON.stringify(types)}`);
    assert.deepEqual(snapshotOf(r1.run_id).deliverable_request, { formats: [], not: [], document: "draft" }, "律师要的是文书：写进任务快照");
    const miss = a.events.find((e: any) => e.type === "agent.primary_missing");
    assert.ok(miss, "有主交付物缺失事件");
    assert.equal(miss.payload.cause, "no_word_output");

    // 追问“补出来”：上一轮没交出的文书随追问继承；只答了文字仍不记完成
    cloud.model.script = textOnly("V11FOLLOW");
    const r2 = await start(matter.matter_id, { goal: "V11FOLLOW 把协议补出来", followup_of: r1.run_id });
    const b = await waitRun(tk.inv, r2.run_id, 150_000);
    assert.equal(b.run.status, "partial", `追问没补出文书不记“已完成”：${JSON.stringify(b.events.map((e: any) => e.type))}`);
    assert.equal(snapshotOf(r2.run_id).carry_primary_output, `${miss.payload.primary}.docx`, "追问继承上一轮没交出的主交付物");
    assert.ok(b.events.some((e: any) => e.type === "agent.primary_missing"));
  } finally {
    cloud.model.script = null;
  }
});

test("场景卡方法的主交付物是 Excel（回稿重审），律师说明里写了“给我 Word”：只交表格不记完成", { timeout: 240_000 }, async () => {
  const matter = await newMatter("V11 回稿出 Word");
  cloud.model.script = sheetOnly("V11REDRAFTWORD");
  try {
    const r = await start(matter.matter_id, { goal: "V11REDRAFTWORD 请比对我方上一稿与对方回稿，并只对改动部分重新审查。\n回稿意见给我 Word", skill: "redraft-review", title: "对方回稿：比对与重审" });
    const a = await waitRun(tk.inv, r.run_id, 150_000);
    assert.equal(a.run.status, "partial", JSON.stringify(a.events.map((e: any) => e.type)));
    const snap = snapshotOf(r.run_id);
    assert.equal(snap.skill_primary_output, "变更清单.xlsx");
    assert.deepEqual(snap.deliverable_request?.formats, ["docx"], "律师点名的格式写进快照");
    assert.equal(a.events.find((e: any) => e.type === "agent.primary_missing")?.payload.cause, "no_word_output");
  } finally {
    cloud.model.script = null;
  }
});

test("对照：只问问题的自由描述任务（没要文书、没点名格式）照常记完成；表格类方法只交表照常完成", { timeout: 240_000 }, async () => {
  const matter = await newMatter("V11 对照");
  cloud.model.script = textOnly("V11QA");
  try {
    const r = await start(matter.matter_id, { goal: "V11QA 股权转让需要其他股东同意吗？" });
    assert.equal(snapshotOf(r.run_id).deliverable_request, undefined, "没有交付要求时快照里不写");
    const a = await waitRun(tk.inv, r.run_id, 150_000);
    assert.equal(a.run.status, "succeeded", JSON.stringify(a.events.map((e: any) => e.type)));
    cloud.model.script = sheetOnly("V11AMOUNT");
    const r2 = await start(matter.matter_id, { goal: "V11AMOUNT 请按合同约定测算逾期付款违约金", skill: "amount-calc", title: "金额测算" });
    const b = await waitRun(tk.inv, r2.run_id, 150_000);
    assert.equal(b.run.status, "succeeded", JSON.stringify(b.events.map((e: any) => e.type)));
  } finally {
    cloud.model.script = null;
  }
});

test("场景卡起诉状只交了表（已记部分完成），追问“补出起诉状”只答了文字：追问不记“已完成”", { timeout: 240_000 }, async () => {
  const matter = await newMatter("V11 追问补文书");
  cloud.model.script = sheetOnly("V11PLEAD");
  try {
    const r1 = await start(matter.matter_id, { goal: "V11PLEAD 请起草民事起诉状", skill: "pleading-draft", title: "起草起诉状" });
    const a = await waitRun(tk.inv, r1.run_id, 150_000);
    assert.equal(a.run.status, "partial", "第一轮按方法核对，已记部分完成（第 28 批）");
    cloud.model.script = textOnly("V11PLEADFU");
    const r2 = await start(matter.matter_id, { goal: "V11PLEADFU 请补出起诉状", followup_of: r1.run_id });
    const b = await waitRun(tk.inv, r2.run_id, 150_000);
    assert.equal(b.run.status, "partial", `追问没补出起诉状不记“已完成”：${JSON.stringify(b.events.map((e: any) => e.type))}`);
    assert.equal(snapshotOf(r2.run_id).carry_primary_output, "民事起诉状（草稿）.docx");
  } finally {
    cloud.model.script = null;
  }
});
