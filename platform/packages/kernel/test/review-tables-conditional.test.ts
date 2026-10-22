/**
 * v9.4 第 21 批 C-01 残余（评审 C1 §3.3）：条件列——只在同一行另一列（是否列 / 分类列）等于某值时才填。
 * 建列时核对条件；Agent 填表时条件不满足的拒收、条件列还没填的拒收（同一批里先填条件列可以）；导出与据此起草写“不适用”；
 * 被别的列当作条件的列不能直接去掉。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createDocx, readZipText } from "@zr-legal/docx-engine";
import { importBytes, liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { columnApplies, fillCells } from "../src/services/review-tables.ts";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "tables-cond-firm");
});
after(async () => {
  await tk.kernel.close();
});

test("columnApplies：无条件、等于、不等于、没找到算不适用、还没填与冲突算待定、律师改过的值优先", () => {
  const col = { key: "custom_2", label: "违约金比例", format: "text" as const, hint: "x", when: { column: "custom_1", equals: "是" } };
  const { when: _w, ...plain } = col;
  assert.equal(columnApplies(plain, undefined), "yes");
  assert.equal(columnApplies(col, undefined), "pending");
  assert.equal(columnApplies(col, { state: "ai", value: "是", lawyer_value: null }), "yes");
  assert.equal(columnApplies(col, { state: "ai", value: "否", lawyer_value: null }), "no");
  assert.equal(columnApplies(col, { state: "not_found", value: null, lawyer_value: null }), "no");
  assert.equal(columnApplies(col, { state: "conflict", value: "是", lawyer_value: null }), "pending");
  assert.equal(columnApplies(col, { state: "edited", value: "否", lawyer_value: "是" }), "yes");
});

test("条件列：建列核对、填表拒收不适用与待定、同批先填条件列、导出与起草写“不适用”、被依赖的列不能去掉", { timeout: 60_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "尽调条件列", stance: "收购方", consent_status: "agreed" });
  const m = matter.matter_id;
  const a = await importBytes(tk.inv, m, "供货合同.docx", createDocx("供货合同", [{ heading: "第九条", paragraphs: ["逾期交货的，按日万分之五支付违约金。"] }]), DOCX);
  const b = await importBytes(tk.inv, m, "租赁合同.docx", createDocx("租赁合同", [{ heading: "第一条", paragraphs: ["出租方：东方物业有限公司。"] }]), DOCX);
  const T = (await tk.inv("tables.create", { matter_id: m, template: "dd_contract_summary", columns: ["contract_name"], document_version_ids: [a.document_version_id, b.document_version_id] })).table.table_id;
  await tk.inv("tables.add_column", { matter_id: m, table_id: T, label: "有违约金条款", hint: "是否约定违约金", format: "yesno" });
  await tk.inv("tables.add_column", { matter_id: m, table_id: T, label: "备注", hint: "其他", format: "text" });
  // 建列核对：条件列须是是否 / 分类列、值在选项里、条件列本身不能带条件
  await assert.rejects(tk.inv("tables.add_column", { matter_id: m, table_id: T, label: "x1", hint: "x", when: { column: "custom_9", equals: "是" } }), /不在这张表里/);
  await assert.rejects(tk.inv("tables.add_column", { matter_id: m, table_id: T, label: "x2", hint: "x", when: { column: "custom_2", equals: "是" } }), /是 \/ 否/);
  await assert.rejects(tk.inv("tables.add_column", { matter_id: m, table_id: T, label: "x3", hint: "x", when: { column: "custom_1", equals: "有" } }), /只能是：是 \/ 否/);
  const t = (await tk.inv("tables.add_column", { matter_id: m, table_id: T, label: "违约金比例", hint: "违约金的计算方式，逐字摘录", format: "text", when: { column: "custom_1", equals: "是" } })).table;
  assert.deepEqual(t.columns.at(-1).when, { column: "custom_1", equals: "是" });
  await assert.rejects(tk.inv("tables.add_column", { matter_id: m, table_id: T, label: "x4", hint: "x", when: { column: "custom_3", equals: "是" } }), /是 \/ 否|条件列本身带条件/);

  const deps = { db: tk.kernel.db, blobs: tk.kernel.blobs, tokens: (tk.kernel as any).tokens };
  const live = liveTaskIdentity(tk, m, "cond");
  // 条件列还没填：拒收
  const r0 = fillCells(deps, { matterId: m, runId: live.rid }, { table_id: T, cells: [{ document_version_id: a.document_version_id, column: "custom_3", value: "日万分之五", quote: "按日万分之五支付违约金" }] });
  assert.equal(r0.written, 0);
  assert.match(r0.rejected[0]!.reason, /先填“有违约金条款”/);
  // 同一批里先填条件列：可以；条件不满足的拒收
  const r1 = fillCells(deps, { matterId: m, runId: live.rid }, { table_id: T, cells: [
    { document_version_id: a.document_version_id, column: "custom_1", value: "是", quote: "按日万分之五支付违约金" },
    { document_version_id: a.document_version_id, column: "custom_3", value: "日万分之五", quote: "按日万分之五支付违约金" },
    { document_version_id: b.document_version_id, column: "custom_1", value: "否", quote: "出租方：东方物业有限公司。" },
    { document_version_id: b.document_version_id, column: "custom_3", value: "无", quote: "出租方：东方物业有限公司。" },
  ] });
  assert.equal(r1.written, 3);
  assert.equal(r1.rejected.length, 1);
  assert.match(r1.rejected[0]!.reason, /不适用/);
  // 给 Agent 的表结构带条件
  const view = (await import("../src/services/review-tables.ts")).tableForAgent(tk.kernel.db, m, T);
  assert.deepEqual(view.columns.find((c: any) => c.column === "custom_3")!.only_when, { column: "custom_1", equals: "是" });
  assert.match(view.note, /only_when/);
  // 导出：不适用如实写
  const ex = await tk.inv("tables.export", { matter_id: m, table_id: T });
  const art = tk.kernel.db.get<{ storage_uri: string }>(`SELECT storage_uri FROM artifact_versions WHERE artifact_version_id = ?`, [ex.artifact_version_id])!;
  const sheet = readZipText(tk.kernel.blobs.read(art.storage_uri), "xl/worksheets/sheet1.xml") ?? "";
  assert.ok(sheet.includes("不适用"), "租赁合同的违约金比例写不适用");
  // 据此起草：不适用不算待核
  const d = await tk.inv("tables.draft", { matter_id: m, table_id: T });
  const art2 = tk.kernel.db.get<{ storage_uri: string }>(`SELECT storage_uri FROM artifact_versions WHERE artifact_version_id = ?`, [d.artifact_version_id])!;
  assert.ok((readZipText(tk.kernel.blobs.read(art2.storage_uri), "word/document.xml") ?? "").includes("不适用"));
  // 被依赖的列不能直接去掉；先去掉条件列之后可以
  await assert.rejects(tk.inv("tables.remove_column", { matter_id: m, table_id: T, column: "custom_1", confirm: true }), /违约金比例.*先去掉/);
  await tk.inv("tables.remove_column", { matter_id: m, table_id: T, column: "custom_3", confirm: true });
  await tk.inv("tables.remove_column", { matter_id: m, table_id: T, column: "custom_1", confirm: true });
});

test("问这张表的任务不改表（复核 Q3-08）：table.fill 在 mode=问表 的任务里被拒；普通填表照常", { timeout: 60_000 }, async () => {
  const { tableFill } = await import("../src/tools/tools/review.ts");
  const { matter } = await tk.inv("matters.create", { title: "问表不改表", stance: "收购方", consent_status: "agreed" });
  const m = matter.matter_id;
  const a = await importBytes(tk.inv, m, "供货合同.docx", createDocx("供货合同", [{ heading: "一", paragraphs: ["合同总价为人民币 120 万元。"] }]), DOCX);
  const T = (await tk.inv("tables.create", { matter_id: m, template: "dd_contract_summary", columns: ["amount"], document_version_ids: [a.document_version_id] })).table.table_id;
  const live = liveTaskIdentity(tk, m, "ask");
  const ctx = { claims: { tid: live.tid, mid: m, rid: live.rid } as any, db: tk.kernel.db, blobs: tk.kernel.blobs, lawdb: (tk.kernel as any).lawdb, tokens: (tk.kernel as any).tokens };
  const cells = [{ document_version_id: a.document_version_id, column: "amount", value: "120 万元", quote: "合同总价为人民币 120 万元。" }];
  tk.kernel.db.run(`UPDATE runs SET input_snapshot = ? WHERE run_id = ?`, [JSON.stringify({ skill: "tabular-review", skill_args: { table_id: T, mode: "问表" } }), live.rid]);
  assert.throws(() => tableFill(ctx, { table_id: T, cells }), (e: any) => e.code === "forbidden" && /不改表/.test(e.message));
  tk.kernel.db.run(`UPDATE runs SET input_snapshot = ? WHERE run_id = ?`, [JSON.stringify({ skill: "tabular-review", skill_args: { table_id: T } }), live.rid]);
  assert.equal(tableFill(ctx, { table_id: T, cells }).written, 1);
});
