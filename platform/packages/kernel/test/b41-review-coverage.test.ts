/**
 * V16 第 41 批：独立复核的覆盖面（回归评分二）。
 * - 原先只看 Word：m29 要发给对方董秘的资料清单（xlsx）、m26 的计算表没人复核；m37 七份公司文件只复核了四份；
 * - 多个方法没有复核环节：庭审提纲（m10 举证期限晚一天）、管辖与时效核查、文稿体检、访谈纪要、回稿重审、交割清单、修订说明、
 *   整理审查要点（E5、m41、m44）、精读整理案卷（E1、m02）、争点分析（m03）、金额测算（m05）。
 * 现在：全部 Word 文书与表格附件都进复核（总量按主次分配、没给全的如实告诉复核人）；以表格为主的方法按“表格”清单复核；
 * 整理审查要点读本任务存下的草稿复核，修改轮用 rules.propose 重交。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "b41-review-coverage-secret-0123456789ab";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createXlsx } from "@zr-legal/docx-engine";
import { importBytes, makeKernel, waitRun, type TestKernel } from "./helpers.ts";
import { startCloudV0, type CloudV0 } from "./cloud-v0.ts";
import { REVIEW_DELIVERABLE_MAX, REVIEW_DOC_MAX, REVIEW_KIND_OF_SKILL, allocateDeliverables, fixPrompt, reviewMessages, workbookText } from "../src/services/independent-review.ts";

test("覆盖面：补上的方法各有复核清单类别；以表格为主的按“表格”清单", () => {
  const want: Record<string, string> = {
    "casefile-organize": "table",
    "issue-evidence-matrix": "table",
    "amount-calc": "table",
    "procedure-check": "table",
    "citation-check": "table",
    "closing-checklist": "table",
    "intake-notes": "table",
    "hearing-outline": "pleading",
    "redraft-review": "review",
    "contract-redline": "review",
    "review-rules-draft": "rules",
  };
  for (const [skill, kind] of Object.entries(want)) assert.equal(REVIEW_KIND_OF_SKILL[skill], kind, skill);
  const m = reviewMessages({ kind: "table", stance: "原告", jurisdiction: "中国大陆", asOf: "2026-11-10", goal: "测算违约金", materials: [], docs: [{ filename: "计算明细.xlsx", text: "［工作表］明细" }] });
  for (const re of [/金额与期限逐项复算[\s\S]*写出算式/, /表内小计与合计/, /最早届满的口径[\s\S]*其他口径/, /每一行写的材料名[\s\S]*能否在材料里对上/, /内部提示或流程用语/, /委托里点名要查[\s\S]*都有对应的行/]) assert.match(m[1]!.content, re);
  assert.match(m[0]!.content, /工作表格（Excel）/);
  assert.match(fixPrompt("table", [{ no: 1, where: "明细第 3 行", problem: "p", basis: "b", fix: "f", must: true }], ""), /表格用 xlsx\.edit_cells 在原表上逐格改/);
  assert.match(fixPrompt("rules", [{ no: 1, where: "要点 2", problem: "p", basis: "b", fix: "f", must: true }], ""), /rules\.propose 重新提交审查要点[\s\S]*要交全部要点/);
});

test("表格的文字视图：表名、表头、按数据行号逐行（与 xlsx.edit_cells 行号一致）", () => {
  const t = workbookText(createXlsx([{ name: "明细", rows: [["期间", "金额（元）"], ["2026-01-01至2026-03-31", 45000], ["合计", 45000]] }, { name: "说明", rows: [["事项"], ["日数按算头不算尾"]] }]));
  assert.equal(t, "［工作表］明细\n［表头］期间｜金额（元）\n［第 1 行］2026-01-01至2026-03-31｜45000\n［第 2 行］合计｜45000\n\n［工作表］说明\n［表头］事项\n［第 1 行］日数按算头不算尾");
});

test("字数按主次分配：主交付物优先给全，其余各保底；超出上限的如实告诉复核人哪些没给全、哪些没给", () => {
  assert.deepEqual(allocateDeliverables([1000, 2000]), [1000, 2000]);
  const a = allocateDeliverables([100_000, 50_000, 10_000, 5_000]);
  assert.equal(a[0], REVIEW_DOC_MAX, "主交付物给到单份上限");
  assert.equal(a.reduce((x, y) => x + y, 0), REVIEW_DELIVERABLE_MAX);
  assert.ok(a.every((n) => n >= 3_000), JSON.stringify(a));
  const docs = [{ filename: "主文书.docx", text: "甲".repeat(100_000) }, ...Array.from({ length: 30 }, (_, i) => ({ filename: `附件${i + 1}.docx`, text: "乙".repeat(4_000) }))];
  const u = reviewMessages({ kind: "draft", stance: "x", jurisdiction: "x", asOf: "2026-11-10", goal: "x", materials: [], docs })[1]!.content;
  assert.match(u, /【复核范围说明】交付件合计超出这次复核的字数上限（80000 字），《主文书\.docx》只给了前 \d+ 字（全文 100000 字）/);
  assert.match(u, /《附件30\.docx》没有提供文字/);
  assert.match(u, /未见全文，建议核对”，不定为“必须改”/);
  assert.equal(/复核范围说明/.test(reviewMessages({ kind: "draft", stance: "x", jurisdiction: "x", asOf: "x", goal: "x", materials: [], docs: [{ filename: "a.docx", text: "短" }] })[1]!.content), false, "给全了不写");
});

let tk: TestKernel;
let cloud: CloudV0;
before(async () => {
  cloud = await startCloudV0({ tenant: "ten_b41-review-coverage" });
  tk = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_KERNEL_TCP: "off", ZR_INDEPENDENT_REVIEW: "on", ZR_REVIEW_LIMIT_MS: "20000", ZR_REVIEW_FIX_LIMIT_MS: "20000" }, "b41-review-coverage");
});
after(async () => {
  await tk.kernel.close();
  await cloud.close();
});

type Msg = { role?: string; tool_call_id?: string; content?: unknown };
const msgs = (body: Record<string, unknown>): Msg[] => (Array.isArray(body.messages) ? (body.messages as Msg[]) : []);
const REVIEWER = "现在独立复核";

async function start(marker: string, skill: string, goal: string) {
  const { matter } = await tk.inv("matters.create", { title: `复核覆盖 ${marker}`, stance: "原告", basis: { engagement: "confirmed", personal_info: "confirmed", sensitive: "not_applicable", subprocessor: "confirmed" }, model_endpoint: "standard" });
  const doc = await importBytes(tk.inv, matter.matter_id, "材料.txt", Buffer.from("本金30万元，2026年1月1日到期未付；范本：付款期限不超过30日，不得预付。", "utf8"), "text/plain");
  const est = await tk.inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [doc.document_version_id] });
  return tk.inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `b41-cov-${marker}-${Date.now()}`, goal: `${marker} ${goal}`, skill, document_version_ids: [doc.document_version_id], mode: "default", plan_first: false });
}

test("金额测算（只交表格）也经复核：复核人看到逐行的表，修改轮按表格目标与行号用 xlsx.edit_cells 改出新版本", { timeout: 180_000 }, async () => {
  const seen = { review: [] as string[], fixUser: [] as string[] };
  cloud.model.script = (body) => {
    const ms = msgs(body);
    const sys = ms.filter((m) => m.role === "system").map((m) => String(m.content ?? "")).join("\n");
    if (sys.includes(REVIEWER)) {
      seen.review.push(`${sys}\n${String(ms.find((m) => m.role === "user")?.content ?? "")}`);
      return { content: "【1】明细第 1 行｜违约金写成 4,500 元｜本金 300,000×日万分之五×30 日＝4,500，表里写 5,400｜改为 4500｜必须改" };
    }
    const first = JSON.stringify(ms.find((m) => m.role === "user")?.content ?? "");
    if (!first.includes("B41COVX")) return null;
    const users = ms.filter((m) => m.role === "user").map((m) => JSON.stringify(m.content ?? ""));
    const render = ms.find((m) => m.role === "tool" && m.tool_call_id === "tab_1");
    if (!render) return { toolCalls: [{ id: "tab_1", name: "mcp__legal__xlsx_render_table", args: { title: "计算明细", sheets: [{ name: "明细", columns: ["项目", "金额（元）"], rows: [["违约金", 5400]] }] } }] };
    if (!users.some((u) => u.includes("【独立复核】"))) return { content: "已生成《计算明细》。" };
    seen.fixUser.push(users.at(-1) ?? "");
    if (!ms.some((m) => m.role === "tool" && m.tool_call_id === "edit_1")) {
      const id = /artv_[0-9a-f-]+/.exec(JSON.stringify(render.content ?? ""))?.[0];
      return { toolCalls: [{ id: "edit_1", name: "mcp__legal__xlsx_edit_cells", args: { artifact_version_id: id, edits: [{ sheet: "明细", row: 1, column: "金额（元）", value: 4500 }] } }] };
    }
    return { content: "已改。\n\n独立复核处理情况：\n1｜已改（明细第 1 行）" };
  };
  try {
    const run = await start("B41COVX", "amount-calc", "测算逾期违约金");
    const done = await waitRun(tk.inv, run.run_id, 150_000);
    assert.equal(done.run.status, "succeeded", JSON.stringify(done.events.map((e: any) => [e.type, e.payload?.remaining ?? e.payload?.status ?? ""])));
    assert.equal(seen.review.length, 1, "只交表格的任务也复核");
    assert.match(seen.review[0]!, /工作表格（Excel）/);
    assert.match(seen.review[0]!, /【交付件：计算明细\.xlsx】\n［工作表］明细\n［表头］项目｜金额（元）\n［第 1 行］违约金｜5400/);
    assert.match(seen.fixUser.at(-1) ?? "", /《计算明细\.xlsx》——用 xlsx\.edit_cells，成果编号 artv_/);
    assert.equal(done.events.find((e: any) => e.type === "review.fix_outcome")?.payload.revised, 1, "表格出了第 2 版");
  } finally {
    cloud.model.script = null;
  }
});

test("多份 Word 文书与表格附件全部进复核（m37 七份只复核了四份；m29 发给对方的资料清单不在复核范围）", { timeout: 180_000 }, async () => {
  const seen: string[] = [];
  const names = ["股东会决议", "董事会决议", "监事决定", "章程修正案", "股东名册", "授权委托书", "签署指引"];
  cloud.model.script = (body) => {
    const ms = msgs(body);
    const sys = ms.filter((m) => m.role === "system").map((m) => String(m.content ?? "")).join("\n");
    if (sys.includes(REVIEWER)) {
      seen.push(String(ms.find((m) => m.role === "user")?.content ?? ""));
      return { content: "未发现实质问题。" };
    }
    const first = JSON.stringify(ms.find((m) => m.role === "user")?.content ?? "");
    if (!first.includes("B41COVM")) return null;
    const done = new Set(ms.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
    for (const [i, n] of names.entries()) if (!done.has(`d${i}`)) return { toolCalls: [{ id: `d${i}`, name: "mcp__legal__docx_render_report", args: { title: n, sections: [{ heading: "正文", paragraphs: [`${n}正文内容 B41COVM-${i}`] }] } }] };
    if (!done.has("x1")) return { toolCalls: [{ id: "x1", name: "mcp__legal__xlsx_render_table", args: { title: "资料清单（致目标公司）", sheets: [{ name: "清单", columns: ["序号", "资料"], rows: [[1, "营业执照"]] }] } }] };
    return { content: "已起草全部公司文件。" };
  };
  try {
    const run = await start("B41COVM", "corporate-resolutions", "起草增资所需全部公司文件");
    const done = await waitRun(tk.inv, run.run_id, 150_000);
    assert.ok(["succeeded", "partial"].includes(done.run.status));
    assert.equal(seen.length, 1);
    for (const [i, n] of names.entries()) assert.match(seen[0]!, new RegExp(`【交付件：${n}\\.docx】[\\s\\S]*B41COVM-${i}`), n);
    assert.match(seen[0]!, /【交付件：资料清单（致目标公司）\.xlsx】\n［工作表］清单\n［表头］序号｜资料\n［第 1 行］1｜营业执照/);
  } finally {
    cloud.model.script = null;
  }
});

test("整理审查要点：复核读本任务存下的审查要点草稿；修改轮用 rules.propose 重交，算作改出了新版本", { timeout: 180_000 }, async () => {
  const seen = { review: [] as string[], fixUser: [] as string[] };
  const rules = (standard: string) => ({ title: "采购合同审查要点", rules: [{ topic: "付款", standard }, { topic: "预付款", standard: "不预付" }] });
  cloud.model.script = (body) => {
    const ms = msgs(body);
    const sys = ms.filter((m) => m.role === "system").map((m) => String(m.content ?? "")).join("\n");
    if (sys.includes(REVIEWER)) {
      seen.review.push(`${sys}\n${String(ms.find((m) => m.role === "user")?.content ?? "")}`);
      return { content: "【1】要点 1｜付款期限写成 60 日｜范本：付款期限不超过30日｜改为不超过 30 日｜必须改" };
    }
    const first = JSON.stringify(ms.find((m) => m.role === "user")?.content ?? "");
    if (!first.includes("B41COVR")) return null;
    const users = ms.filter((m) => m.role === "user").map((m) => JSON.stringify(m.content ?? ""));
    const done = new Set(ms.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
    if (!done.has("r1")) return { toolCalls: [{ id: "r1", name: "mcp__legal__rules_propose", args: rules("付款期限不超过 60 日") }] };
    if (!users.some((u) => u.includes("【独立复核】"))) return { content: "审查要点草稿已存，待你审定。" };
    seen.fixUser.push(users.at(-1) ?? "");
    if (!done.has("r2")) return { toolCalls: [{ id: "r2", name: "mcp__legal__rules_propose", args: rules("付款期限不超过 30 日") }] };
    return { content: "已按复核意见改正要点 1。\n\n独立复核处理情况：\n1｜已改（要点 1）" };
  };
  try {
    const run = await start("B41COVR", "review-rules-draft", "按范本整理采购合同审查要点");
    const done = await waitRun(tk.inv, run.run_id, 150_000);
    assert.equal(done.run.status, "succeeded", JSON.stringify(done.events.map((e: any) => [e.type, e.payload?.remaining ?? ""])));
    assert.equal(seen.review.length, 1, JSON.stringify(done.events.filter((e: any) => /tool_result|review|skill/.test(e.type)).map((e: any) => [e.type, JSON.stringify(e.payload).slice(0, 300)])));
    assert.match(seen.review[0]!, /审查要点草稿/);
    assert.match(seen.review[0]!, /要点 1｜付款｜我方标准：付款期限不超过 60 日｜可退让：（未写）｜不可谈：（未写）\n要点 2｜预付款｜我方标准：不预付/);
    assert.match(seen.fixUser.at(-1) ?? "", /rules\.propose 重新提交审查要点/);
    const outcome = done.events.find((e: any) => e.type === "review.fix_outcome")?.payload;
    assert.equal(outcome?.revised, 1, JSON.stringify(outcome));
    assert.equal(done.events.find((e: any) => e.type === "run.succeeded")?.payload.remaining, undefined, "改出了新草稿，不提示“没有改动”");
  } finally {
    cloud.model.script = null;
  }
});
