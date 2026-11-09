/**
 * V14 第 39 批：《事实时间线》由系统按已提交的事实生成；事实提交判重。
 * 根因（V13 W5 真实走查，独立评分 11/24、命中否决 V5“交付格式与要求不符”）：案卷整理任务已把 119 条事实提交入库，
 * 律师点名的第一项《事实时间线》却没有文件——助手要用模型输出把 119 条逐行重写成表，40 分钟时限到时还没渲染出来；
 * 事项“事实”页里另有 8 条重复。时间线是已提交事实的确定性投影，由内核生成。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "b39-timeline-secret-0123456789abcdef";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { importBytes, makeKernel, waitRun, type TestKernel } from "./helpers.ts";
import { startCloudV0, type CloudV0 } from "./cloud-v0.ts";
import { buildTimeline, dateSortKey, type TimelineFact } from "../src/services/facts-timeline.ts";
import { factKeys, statementOverlap } from "../src/services/review-cards.ts";

const fact = (p: Partial<TimelineFact> & { seq: number; statement: string }): TimelineFact => ({
  fact_id: `fct_${p.seq}`,
  kind: "claimed",
  occurred_on: null,
  amount_yuan: null,
  party: null,
  document_version_id: "docv_1",
  quote: null,
  anchor_status: "located",
  status: "proposed",
  filename: "承揽合同.docx",
  ...p,
});

test("时间线排序：按日期升序，只到月的在该月末、只到年的在该年末，日期不明的在表尾；同日按提交先后", () => {
  const t = buildTimeline([
    fact({ seq: 1, statement: "日期不明的事", occurred_on: null }),
    fact({ seq: 2, statement: "2026 年某月", occurred_on: "2026" }),
    fact({ seq: 3, statement: "3 月某日", occurred_on: "2026-03" }),
    fact({ seq: 4, statement: "3 月 31 日", occurred_on: "2026-03-31" }),
    fact({ seq: 5, statement: "3 月 1 日 后交", occurred_on: "2026-03-01" }),
    fact({ seq: 0, statement: "3 月 1 日 先交", occurred_on: "2026-03-01" }),
  ]);
  const body = t.sheets[0]!.rows.slice(1).map((r) => r[2]);
  assert.deepEqual(body, ["3 月 1 日 先交", "3 月 1 日 后交", "3 月 31 日", "3 月某日", "2026 年某月", "日期不明的事"]);
  assert.ok(dateSortKey("2026-03") > dateSortKey("2026-03-31"));
});

test("四类分列：律师确认的写在“律师确认”列；待确认另列一张表；同日期同陈述合并为一行、事实编号并列", () => {
  const t = buildTimeline([
    fact({ seq: 1, statement: "甲方于 2026-01-05 送达验收单", occurred_on: "2026-01-05", quote: "验收单已送达" }),
    fact({ seq: 2, statement: "甲方于 2026-01-05 送达验收单。", occurred_on: "2026-01-05", quote: "验收单已送达" }),
    fact({ seq: 3, statement: "乙方已付 30 万元", occurred_on: "2026-02-01", kind: "confirmed", status: "confirmed", amount_yuan: 300000 }),
    fact({ seq: 4, statement: "交货日期两份材料不一致：送货单 3 月 2 日、对账单 3 月 5 日", occurred_on: "2026-03", kind: "to_confirm" }),
    fact({ seq: 5, statement: "依对账单推定乙方认可欠款", occurred_on: "2026-03-10", kind: "inferred", anchor_status: "not_found" }),
  ]);
  const [head, ...rows] = t.sheets[0]!.rows;
  assert.deepEqual(head, ["序号", "日期", "材料载明", "律师确认", "推论", "待确认", "涉及主体", "金额（元）", "来源材料", "逐字引文", "定位状态", "事实编号"]);
  assert.equal(rows.length, 4, "重复的一行已合并");
  assert.equal(t.merged, 1);
  assert.equal(rows[0]![11], "F1、F2");
  assert.equal(rows[1]![3], "乙方已付 30 万元", "律师确认列");
  assert.equal(rows[1]![2], null);
  assert.equal(rows[1]![7], 300000);
  assert.equal(rows[2]![4], "依对账单推定乙方认可欠款", "推论列");
  assert.equal(rows[2]![10], "未定位");
  assert.equal(rows[3]![5], "交货日期两份材料不一致：送货单 3 月 2 日、对账单 3 月 5 日", "待确认列（只到月，排在 3 月 10 日之后）");
  assert.equal(t.sheets[1]!.name, "待确认事项");
  assert.equal(t.sheets[1]!.rows.length, 2);
  assert.match(String(t.sheets[2]!.rows[1]![0]), /共 5 条事实[\s\S]*合并（1 条）/);
});

test("判重键：同日期同陈述算重复；同一句引文支撑两条不同的事实不算重复", () => {
  const a = { statement: "甲方于 1 月 5 日送达验收单", kind: "claimed", occurred_on: "2026-01-05", document_version_id: "docv_1", quote: "验收单于 1 月 5 日送达乙方" };
  const b = { ...a, statement: "甲方于1月5日送达验收单。" };
  assert.ok(factKeys(a).some((k) => factKeys(b).includes(k)));
  const c = { ...a, statement: "乙方于 1 月 5 日签收验收单" };
  assert.ok(statementOverlap(a.statement, c.statement) < 0.85, "陈述不同（主体不同）：引文相同也不算重复");
  assert.ok(statementOverlap(a.statement, b.statement) >= 0.85);
});

let tk: TestKernel;
let cloud: CloudV0;
before(async () => {
  cloud = await startCloudV0({ tenant: "ten_b39-timeline-firm" });
  tk = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_KERNEL_TCP: "off", ZR_INDEPENDENT_REVIEW: "off" }, "b39-timeline-firm");
});
after(async () => {
  await tk.kernel.close();
  await cloud.close();
});

type Msg = { role?: string; tool_call_id?: string; content?: unknown };
const msgs = (body: Record<string, unknown>): Msg[] => (Array.isArray(body.messages) ? (body.messages as Msg[]) : []);

test("案卷整理：助手提交了事实、只交《案卷总目录》，系统生成《事实时间线》；重复事实不入库", { timeout: 180_000 }, async () => {
  const { matter } = await tk.inv("matters.create", {
    title: "承揽款纠纷",
    stance: "原告",
    basis: { engagement: "confirmed", personal_info: "confirmed", sensitive: "not_applicable", subprocessor: "confirmed" },
    model_endpoint: "standard",
  });
  const text = "加工合同约定加工费 50 万元。2026 年 1 月 5 日，原告将验收单送达被告。2026 年 2 月 1 日，被告支付加工费 30 万元。";
  const doc = await importBytes(tk.inv, matter.matter_id, "加工合同与往来.txt", Buffer.from(text, "utf8"), "text/plain");
  const facts = [
    { statement: "原告于 2026-01-05 将验收单送达被告", kind: "claimed", occurred_on: "2026-01-05", document_version_id: doc.document_version_id, quote: "2026 年 1 月 5 日，原告将验收单送达被告" },
    { statement: "被告于 2026-02-01 支付加工费 30 万元", kind: "claimed", occurred_on: "2026-02-01", amount_yuan: 300000, document_version_id: doc.document_version_id, quote: "2026 年 2 月 1 日，被告支付加工费 30 万元" },
  ];
  const results: Record<string, string> = {};
  cloud.model.script = (body) => {
    const ms = msgs(body);
    if (!JSON.stringify(ms.find((m) => m.role === "user")?.content ?? "").includes("B39TL")) return null;
    for (const m of ms) if (m.role === "tool" && m.tool_call_id) results[m.tool_call_id] = JSON.stringify(m.content ?? "");
    if (!results.f1) return { toolCalls: [{ id: "f1", name: "mcp__legal__facts_submit", args: { facts } }] };
    // 第二批里有一条与第一批重复（同日期同陈述，标点不同）
    if (!results.f2) return { toolCalls: [{ id: "f2", name: "mcp__legal__facts_submit", args: { facts: [{ ...facts[0], statement: "原告于2026-01-05将验收单送达被告。" }] } }] };
    if (!results.t1) return { toolCalls: [{ id: "t1", name: "mcp__legal__xlsx_render_table", args: { title: "案卷总目录-承揽款纠纷", sheets: [{ name: "案卷目录", columns: ["卷内序号", "材料名称"], rows: [[1, "加工合同与往来"]] }] } }] };
    return { content: "已整理：案卷总目录 1 份；事实 2 条。" };
  };
  try {
    const est = await tk.inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [doc.document_version_id] });
    const run = await tk.inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `b39-tl-${Date.now()}`, goal: "B39TL 整理案卷", skill: "casefile-organize", document_version_ids: [doc.document_version_id], mode: "default", plan_first: false });
    const done = await waitRun(tk.inv, run.run_id, 150_000);
    assert.equal(done.run.status, "succeeded", JSON.stringify(done.events.map((e: any) => e.type)));
    assert.match(results.f2 ?? "", /duplicates[\s\S]*duplicate_of/, "第二批的重复事实被识别");
    const rows = tk.kernel.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM matter_facts WHERE matter_id = ?`, [matter.matter_id]);
    assert.equal(rows[0]!.n, 2, "重复事实没有入库");
    const tl = done.artifacts.filter((a: any) => /^事实时间线/.test(a.filename));
    assert.equal(tl.length, 1, `系统生成了时间线：${done.artifacts.map((a: any) => a.filename).join("、")}`);
    const x = await tk.inv("artifacts.download", { artifact_version_id: tl[0].artifact_version_id });
    const { readZipText } = await import("@zr-legal/docx-engine");
    const sheet = readZipText(Buffer.from(x.data_base64, "base64"), "xl/sharedStrings.xml") ?? readZipText(Buffer.from(x.data_base64, "base64"), "xl/worksheets/sheet1.xml") ?? "";
    assert.match(sheet, /原告于 2026-01-05 将验收单送达被告/);
    assert.match(sheet, /被告于 2026-02-01 支付加工费 30 万元/);
    const ev = done.events.find((e: any) => e.type === "artifact.drafted" && /^事实时间线/.test(e.payload.filename));
    assert.ok(ev, "时间线登记在任务时间线里");
  } finally {
    cloud.model.script = null;
  }
});

test("助手自己交了《事实时间线》的不再重复生成", { timeout: 180_000 }, async () => {
  const { matter } = await tk.inv("matters.create", {
    title: "承揽款纠纷二",
    stance: "原告",
    basis: { engagement: "confirmed", personal_info: "confirmed", sensitive: "not_applicable", subprocessor: "confirmed" },
    model_endpoint: "standard",
  });
  const doc = await importBytes(tk.inv, matter.matter_id, "往来.txt", Buffer.from("2026 年 3 月 1 日，原告交付第一批货物。", "utf8"), "text/plain");
  const results: Record<string, string> = {};
  cloud.model.script = (body) => {
    const ms = msgs(body);
    if (!JSON.stringify(ms.find((m) => m.role === "user")?.content ?? "").includes("B39OWN")) return null;
    for (const m of ms) if (m.role === "tool" && m.tool_call_id) results[m.tool_call_id] = "1";
    if (!results.f1) return { toolCalls: [{ id: "f1", name: "mcp__legal__facts_submit", args: { facts: [{ statement: "原告于 2026-03-01 交付第一批货物", kind: "claimed", occurred_on: "2026-03-01", document_version_id: doc.document_version_id, quote: "2026 年 3 月 1 日，原告交付第一批货物" }] } }] };
    if (!results.t1) return { toolCalls: [{ id: "t1", name: "mcp__legal__xlsx_render_table", args: { title: "事实时间线-按付款线索", sheets: [{ name: "时间线", columns: ["日期", "事实"], rows: [["2026-03-01", "交付第一批货物"]] }] } }] };
    return { content: "已整理。" };
  };
  try {
    const est = await tk.inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [doc.document_version_id] });
    const run = await tk.inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `b39-own-${Date.now()}`, goal: "B39OWN 整理案卷", skill: "casefile-organize", document_version_ids: [doc.document_version_id], mode: "default", plan_first: false });
    const done = await waitRun(tk.inv, run.run_id, 150_000);
    const tl = done.artifacts.filter((a: any) => /^事实时间线/.test(a.filename));
    assert.equal(tl.length, 1, "只有助手自己那份");
    assert.equal(tl[0].filename, "事实时间线-按付款线索.xlsx");
  } finally {
    cloud.model.script = null;
  }
});
