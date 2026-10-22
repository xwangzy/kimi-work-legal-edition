/**
 * v9.4 第 19 批 C-01（评审 C1 §3.3）：表格审阅最小版——律师建表（模板 + 选列 + 材料），读不出文字的材料整行“读取差”；
 * Agent 经本机端点 table.get / table.fill 逐格填值与逐字引文（格式核对、引文定位、没有引文的“找到”拒收）；
 * 律师逐格确认 / 改值（原 AI 值保留）/ 撤回；已核、已改的格子重跑不覆盖；导出 Excel 未核的标“【待核】”；结果交回 Agent 前令牌化。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createDocx, readZipText } from "@zr-legal/docx-engine";
import { LEGAL_MCP_TOOLS } from "@zr-legal/domain";
import { findTokens } from "@zr-legal/tokenizer";
import { importBytes, importText, liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { mintTaskToken } from "../src/identity.ts";
import { legalToolLockProblems } from "../src/tools/registry.ts";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "tables-firm");
});
after(async () => {
  await tk.kernel.close();
});

test("工具登记与锁文件一致", () => {
  for (const n of ["table.get", "table.fill"]) {
    assert.ok((LEGAL_MCP_TOOLS as readonly string[]).includes(n));
    assert.equal(legalToolLockProblems().has(n), false, `${n}: ${legalToolLockProblems().get(n)}`);
  }
});

test("建表 → Agent 填 → 律师核 / 改 / 撤回 → 重跑不覆盖已核 → 导出", { timeout: 120_000 }, async () => {
  const { Agent, fetch } = await import("undici");
  const { matter } = await tk.inv("matters.create", { title: "尽调", stance: "收购方", consent_status: "agreed" });
  await tk.inv("matters.parties.upsert", { matter_id: matter.matter_id, name: "王芳", kind: "person" });
  const c1 = await importBytes(tk.inv, matter.matter_id, "供货合同.docx", createDocx("供货合同", [{ heading: "第一条", paragraphs: ["甲方：星河科技有限公司；乙方：联系人王芳。", "合同总价为人民币 120 万元。", "本合同于 2025 年 6 月签署，有效期三年。"] }]), DOCX);
  const c2 = await importBytes(tk.inv, matter.matter_id, "租赁合同.docx", createDocx("租赁合同", [{ heading: "第一条", paragraphs: ["出租方：东方物业有限公司。", "争议提交上海仲裁委员会仲裁。"] }]), DOCX);
  const blank = await importText(tk.inv, matter.matter_id, "扫描件.txt", " ");
  const m = matter.matter_id;

  const tpl = (await tk.inv("tables.templates")).templates;
  assert.deepEqual(tpl.map((t: any) => t.id), ["evidence_list", "dd_contract_summary", "contract_ledger"]);
  const { table } = await tk.inv("tables.create", { matter_id: m, template: "dd_contract_summary", columns: ["contract_name", "counterparty", "amount", "dispute"], document_version_ids: [c1.document_version_id, c2.document_version_id, blank.document_version_id] });
  assert.deepEqual(table.columns.map((c: any) => c.key), ["contract_name", "counterparty", "amount", "dispute"]);
  let grid = await tk.inv("tables.get", { matter_id: m, table_id: table.table_id });
  assert.equal(grid.cells.filter((c: any) => c.state === "unreadable").length, 4, "读不出文字的材料整行标读取差");
  await assert.rejects(tk.inv("tables.create", { matter_id: m, template: "nope", document_version_ids: [c1.document_version_id] }), /template 须为/);

  // Agent 经本机端点
  const live = liveTaskIdentity(tk, m, "table");
  const token = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: live.fence, fx: ["read", "write_draft"], scope: ["tool:legal"] }, 300);
  const agent = new Agent({ connect: { socketPath: tk.kernel.pipePath } });
  let seq = 0;
  const call = async (name: string, args: unknown) => {
    const r = (await fetch("http://tools.kwl/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } }), dispatcher: agent }).then((x) => x.json())) as any;
    assert.equal(r.result?.isError, false, `${name}: ${JSON.stringify(r)}`);
    assert.equal(JSON.stringify(r).includes("王芳"), false, `${name} 的结果交回 Agent 前须令牌化`);
    return r.result.structuredContent;
  };
  const view = await call("table.get", { table_id: table.table_id });
  assert.equal(view.documents.find((d: any) => d.filename === "扫描件.txt").unreadable, true);
  const excerpt = await call("materials.read_excerpt", { parse_version_id: (await call("materials.list", {})).materials.find((x: any) => x.filename === "供货合同.docx").parse_version_id });
  const nameTok = findTokens(excerpt.text).find((t: string) => t.startsWith("〔自然人"));
  assert.ok(nameTok);
  const d1 = c1.document_version_id;
  const d2 = c2.document_version_id;
  const fill = await call("table.fill", {
    table_id: table.table_id,
    cells: [
      { document_version_id: d1, column: "contract_name", value: "供货合同", quote: "供货合同" },
      { document_version_id: d1, column: "counterparty", value: `星河科技有限公司（联系人${nameTok}）`, quote: `甲方：星河科技有限公司；乙方：联系人${nameTok}。` },
      { document_version_id: d1, column: "amount", value: "120 万元", quote: "合同总价为人民币 120 万元。" },
      { document_version_id: d1, column: "dispute", status: "not_found" },
      { document_version_id: d2, column: "dispute", value: "上海仲裁委员会仲裁", quote: "争议提交上海仲裁委员会" },
      { document_version_id: d2, column: "amount", value: "未写明", quote: "出租方" },
      { document_version_id: d2, column: "counterparty", value: "东方物业有限公司", quote: "这句话不在合同里" },
      { document_version_id: d2, column: "contract_name", value: "租赁合同" },
      { document_version_id: blank.document_version_id, column: "contract_name", value: "猜一个", quote: "x" },
      { document_version_id: d1, column: "no_such", value: "x", quote: "x" },
    ],
  });
  assert.equal(fill.written, 6);
  assert.deepEqual(fill.rejected.map((r: any) => r.reason), ["金额须含数字", "找到的格子要附逐字引文（quote），律师据此回原文核对", "这份材料读不出文字：不填，留给律师看原件", "没有这一列"]);
  assert.equal(fill.quote_not_found, 1);

  grid = await tk.inv("tables.get", { matter_id: m, table_id: table.table_id });
  const cell = (doc: string, col: string) => grid.cells.find((c: any) => c.document_version_id === doc && c.col_key === col);
  assert.equal(cell(d1, "amount").anchor_status, "located");
  assert.equal(cell(d2, "counterparty").anchor_status, "not_found", "引文找不到照收、标出");
  assert.equal(cell(d1, "dispute").state, "not_found");

  // 律师：确认一格、改一格（原文写真名）、撤回后再确认
  await tk.inv("tables.decide_cell", { matter_id: m, table_id: table.table_id, cell_id: cell(d1, "amount").cell_id, decision: "verify" });
  const edited = (await tk.inv("tables.decide_cell", { matter_id: m, table_id: table.table_id, cell_id: cell(d1, "counterparty").cell_id, decision: "edit", value: "星河科技有限公司（联系人王芳）" })).cell;
  assert.equal(edited.state, "edited");
  assert.match(edited.value, /〔自然人/, "原 AI 值保留可查");
  await assert.rejects(tk.inv("tables.decide_cell", { matter_id: m, table_id: table.table_id, cell_id: cell(d1, "amount").cell_id, decision: "edit", value: "一百二十" }), /金额须含数字/);
  // 律师直接填一个 AI 没填的格子
  const manual = (await tk.inv("tables.decide_cell", { matter_id: m, table_id: table.table_id, document_version_id: d2, column: "amount", decision: "edit", value: "月租 3 万元" })).cell;
  assert.equal(manual.state, "edited");

  // 重跑：已核、已改的不覆盖
  const again = await call("table.fill", {
    table_id: table.table_id,
    cells: [
      { document_version_id: d1, column: "amount", value: "999 万元", quote: "合同总价为人民币 120 万元。" },
      { document_version_id: d1, column: "counterparty", value: "别的", quote: "甲方：星河科技有限公司" },
      { document_version_id: d1, column: "contract_name", value: "供货合同（修订）", quote: "供货合同" },
    ],
  });
  assert.deepEqual([again.written, again.locked], [1, 2]);
  const v2 = await call("table.get", { table_id: table.table_id });
  const agentCell = v2.cells.find((c: any) => c.document_version_id === d1 && c.column === "counterparty");
  assert.equal(agentCell.locked, true);
  assert.match(agentCell.value, /〔自然人/, "律师改的值交回 Agent 时换成代号");
  // 撤回后可再填
  grid = await tk.inv("tables.get", { matter_id: m, table_id: table.table_id });
  await tk.inv("tables.decide_cell", { matter_id: m, table_id: table.table_id, cell_id: cell(d1, "amount").cell_id, decision: "reset" });
  assert.equal((await call("table.fill", { table_id: table.table_id, cells: [{ document_version_id: d1, column: "amount", value: "130 万元", quote: "合同总价为人民币 120 万元。" }] })).written, 1);

  await tk.inv("tables.decide_cell", { matter_id: m, table_id: table.table_id, cell_id: cell(d2, "dispute").cell_id, decision: "verify" });
  // 导出：已核照写、已改用律师的值（还原真名）、AI 值标待核、没找到与读取差如实写
  const ex = await tk.inv("tables.export", { matter_id: m, table_id: table.table_id });
  assert.equal(ex.rows, 3);
  const sheet = readZipText(Buffer.from((await tk.inv("artifacts.download", { artifact_version_id: ex.artifact_version_id })).data_base64, "base64"), "xl/worksheets/sheet1.xml") ?? "";
  assert.match(sheet, /星河科技有限公司（联系人王芳）/);
  assert.match(sheet, /130 万元【待核】/);
  assert.match(sheet, /上海仲裁委员会仲裁</, "已核的照写，不标待核");
  assert.match(sheet, /未找到/);
  assert.match(sheet, /读取差，未读/);
  assert.match(sheet, /月租 3 万元/);
  assert.equal(findTokens(sheet).length, 0);
  assert.equal((await tk.inv("tables.list", { matter_id: m })).tables[0].verified, 3);
  await agent.close();
});

test("跨事项：别的事项的表与材料不可用", { timeout: 60_000 }, async () => {
  const { matter: a } = await tk.inv("matters.create", { title: "甲", stance: "原告", consent_status: "agreed" });
  const { matter: b } = await tk.inv("matters.create", { title: "乙", stance: "原告", consent_status: "agreed" });
  const doc = await importText(tk.inv, b.matter_id, "b.txt", "乙事项的合同文本，足够长的一段文字用于解析。");
  await assert.rejects(tk.inv("tables.create", { matter_id: a.matter_id, template: "contract_ledger", document_version_ids: [doc.document_version_id] }), /不存在|无权/);
  const { table } = await tk.inv("tables.create", { matter_id: b.matter_id, template: "contract_ledger", document_version_ids: [doc.document_version_id] });
  await assert.rejects(tk.inv("tables.get", { matter_id: a.matter_id, table_id: table.table_id }), /不存在|无权/);
});

// ─── 复核 Q2 处置 ───

test("Q2-02 材料隔离：这份材料的格子删除、整行不显示不导出、不能再填；提纲里抄来的事实文字抹去", { timeout: 60_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "隔离", stance: "原告", consent_status: "agreed" });
  const m = matter.matter_id;
  const a = await importText(tk.inv, m, "甲.txt", "甲合同全文：总价人民币 50 万元，签署于 2025 年 6 月。");
  const b = await importText(tk.inv, m, "乙.txt", "乙合同全文：总价人民币 80 万元，签署于 2025 年 7 月。金丝雀KWLQ202");
  const { table } = await tk.inv("tables.create", { matter_id: m, template: "contract_ledger", columns: ["contract_name"], document_version_ids: [a.document_version_id, b.document_version_id] });
  const live = liveTaskIdentity(tk, m, "q202");
  const { fillCells } = await import("../src/services/review-tables.ts");
  fillCells({ db: tk.kernel.db, blobs: tk.kernel.blobs }, { matterId: m, runId: live.rid }, { table_id: table.table_id, cells: [
    { document_version_id: a.document_version_id, column: "contract_name", value: "甲合同", quote: "甲合同全文" },
    { document_version_id: b.document_version_id, column: "contract_name", value: "乙合同金丝雀KWLQ202", quote: "金丝雀KWLQ202" },
  ] });
  // 提纲里引用了据乙材料的事实
  tk.kernel.db.run(`INSERT INTO matter_facts (fact_id, tenant_id, matter_id, seq, statement, kind, document_version_id, anchor_status, status) VALUES ('fct_q202', ?, ?, 1, '乙合同总价 80 万元 金丝雀KWLQ202', 'claimed', ?, 'no_document', 'proposed')`, [live.tid, m, b.document_version_id]);
  const { submitOutline } = await import("../src/services/argument-outlines.ts");
  submitOutline({ db: tk.kernel.db }, { tenantId: live.tid, matterId: m, runId: live.rid }, { doc_kind: "起诉状", arguments: [{ claim: "甲", facts: [{ fact_id: "fct_q202" }] }] });
  // 重新解析才发现密级标志 → 隔离（与 classified-marking 用例同一做法）
  const marked = tk.kernel.blobs.put(Buffer.from("机密★1年\n乙合同全文 金丝雀KWLQ202"), m);
  tk.kernel.db.run(`UPDATE document_versions SET sha256 = ?, storage_uri = ? WHERE document_version_id = ?`, [marked.sha256, marked.storage_uri, b.document_version_id]);
  await assert.rejects(tk.inv("materials.reparse", { document_version_id: b.document_version_id }), (e: any) => e.code === "classified_material");
  assert.equal(tk.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM review_cells WHERE document_version_id = ?`, [b.document_version_id])!.n, 0, "格子删除");
  const grid = await tk.inv("tables.get", { matter_id: m, table_id: table.table_id });
  assert.deepEqual(grid.docs.map((d: any) => d.filename), ["甲.txt"], "整行不显示");
  const r = fillCells({ db: tk.kernel.db, blobs: tk.kernel.blobs }, { matterId: m, runId: live.rid }, { table_id: table.table_id, cells: [{ document_version_id: b.document_version_id, column: "contract_name", value: "x", quote: "x" }] });
  assert.equal(r.rejected[0]?.reason, "这份材料不在表里", "不能再填");
  const ex = await tk.inv("tables.export", { matter_id: m, table_id: table.table_id });
  const sheet = readZipText(Buffer.from((await tk.inv("artifacts.download", { artifact_version_id: ex.artifact_version_id })).data_base64, "base64"), "xl/worksheets/sheet1.xml") ?? "";
  assert.doesNotMatch(sheet, /乙/);
  const items = tk.kernel.db.get<{ items: string }>(`SELECT items FROM argument_outlines WHERE run_id = ?`, [live.rid])!.items;
  assert.doesNotMatch(items, /KWLQ202/, "提纲里抄来的事实文字抹去");
  assert.match(items, /所依据的材料已隔离/);
});

test("Q2-05 过期确认：格子在律师打开后被助手重填过，按旧版本确认被拒、仍是待核；按新版本可确认", { timeout: 60_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "过期确认", stance: "原告", consent_status: "agreed" });
  const m = matter.matter_id;
  const a = await importText(tk.inv, m, "甲.txt", "甲合同全文：总价人民币 120 万元，分三期支付，验收合格后付清。");
  const { table } = await tk.inv("tables.create", { matter_id: m, template: "contract_ledger", columns: ["payment_milestones"], document_version_ids: [a.document_version_id] });
  const live = liveTaskIdentity(tk, m, "q205");
  const { fillCells } = await import("../src/services/review-tables.ts");
  const fill = (v: string) => fillCells({ db: tk.kernel.db, blobs: tk.kernel.blobs }, { matterId: m, runId: live.rid }, { table_id: table.table_id, cells: [{ document_version_id: a.document_version_id, column: "payment_milestones", value: v, quote: "总价人民币 120 万元" }] });
  fill("120 万元");
  const seen = (await tk.inv("tables.get", { matter_id: m, table_id: table.table_id })).cells[0];
  await new Promise((r) => setTimeout(r, 5));
  const second = fill("999 万元");
  assert.equal(second.written, 1, JSON.stringify(second));
  const after2 = (await tk.inv("tables.get", { matter_id: m, table_id: table.table_id })).cells[0];
  assert.notEqual(after2.updated_at, seen.updated_at, JSON.stringify([seen, after2]));
  await assert.rejects(tk.inv("tables.decide_cell", { matter_id: m, table_id: table.table_id, cell_id: seen.cell_id, decision: "verify", expected_updated_at: seen.updated_at }), /刚被助手更新过/);
  const now = (await tk.inv("tables.get", { matter_id: m, table_id: table.table_id })).cells[0];
  assert.equal(now.state, "ai");
  assert.equal((await tk.inv("tables.decide_cell", { matter_id: m, table_id: table.table_id, cell_id: now.cell_id, decision: "verify", expected_updated_at: now.updated_at })).cell.state, "verified");
});

test("Q2-09 / Q2-10：撤回回到“有冲突”；材料重新识别能读后，读取差的格子可以填", { timeout: 60_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "撤回与重新识别", stance: "原告", consent_status: "agreed" });
  const m = matter.matter_id;
  const a = await importText(tk.inv, m, "甲.txt", "甲合同全文：签署于 2025 年 6 月；另页写 2025 年 7 月签署。");
  const blank = await importText(tk.inv, m, "扫描件.txt", " ");
  const { table } = await tk.inv("tables.create", { matter_id: m, template: "contract_ledger", columns: ["signed_on"], document_version_ids: [a.document_version_id, blank.document_version_id] });
  const live = liveTaskIdentity(tk, m, "q209");
  const { fillCells } = await import("../src/services/review-tables.ts");
  const deps = { db: tk.kernel.db, blobs: tk.kernel.blobs };
  fillCells(deps, { matterId: m, runId: live.rid }, { table_id: table.table_id, cells: [{ document_version_id: a.document_version_id, column: "signed_on", status: "conflict", value: "2025-06", quote: "签署于 2025 年 6 月", note: "另页写 7 月" }] });
  let cell = (await tk.inv("tables.get", { matter_id: m, table_id: table.table_id })).cells.find((c: any) => c.document_version_id === a.document_version_id);
  await tk.inv("tables.decide_cell", { matter_id: m, table_id: table.table_id, cell_id: cell.cell_id, decision: "verify" });
  cell = (await tk.inv("tables.decide_cell", { matter_id: m, table_id: table.table_id, cell_id: cell.cell_id, decision: "reset" })).cell;
  assert.equal(cell.state, "conflict", "撤回回到有冲突");
  // 读取差：先拒；模拟重新识别后能读，再填就收
  const try1 = fillCells(deps, { matterId: m, runId: live.rid }, { table_id: table.table_id, cells: [{ document_version_id: blank.document_version_id, column: "signed_on", value: "2025-08", quote: "2025 年 8 月" }] });
  assert.equal(try1.written, 0);
  const pv = tk.kernel.db.get<{ parse_version_id: string }>(`SELECT parse_version_id FROM parse_versions WHERE document_version_id = ? ORDER BY created_at DESC LIMIT 1`, [blank.document_version_id])!.parse_version_id;
  tk.kernel.db.run(`UPDATE parse_texts SET content = ? WHERE parse_version_id = ?`, ["重新识别后的扫描件正文：本合同于 2025 年 8 月签署。", pv]);
  const try2 = fillCells(deps, { matterId: m, runId: live.rid }, { table_id: table.table_id, cells: [{ document_version_id: blank.document_version_id, column: "signed_on", value: "2025-08", quote: "2025 年 8 月" }] });
  assert.equal(try2.written, 1);
});

test("v9.4 第 20 批 C-01 残余：自建列（校验、上限、只能删自建列）→ 格子看原文前后文 → 推为事实（只推已核、不重复）→ 据此起草（未核标待核）→ 台账设提醒候选", { timeout: 120_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "台账与证据", stance: "原告", consent_status: "agreed" });
  const m = matter.matter_id;
  const c1 = await importBytes(tk.inv, m, "采购合同.docx", createDocx("采购合同", [{ heading: "第一条", paragraphs: ["本合同自 2025-01-01 起至 2030-12-31 止。", "双方于 2025-01-01 签署本合同，合同总价为人民币 120 万元。"] }]), DOCX);
  const c2 = await importBytes(tk.inv, m, "租赁合同.docx", createDocx("租赁合同", [{ heading: "第一条", paragraphs: ["租期至 2027-06 届满。"] }]), DOCX);
  const { table } = await tk.inv("tables.create", { matter_id: m, template: "contract_ledger", columns: ["contract_name", "expires_on", "signed_on"], document_version_ids: [c1.document_version_id, c2.document_version_id] });
  const T = table.table_id;
  // 自建列
  await assert.rejects(tk.inv("tables.add_column", { matter_id: m, table_id: T, label: "保证金" }), (e: any) => e.code === "validation" && /填写说明/.test(e.message));
  await assert.rejects(tk.inv("tables.add_column", { matter_id: m, table_id: T, label: "类型", hint: "合同类型", format: "choice", options: ["买卖"] }), (e: any) => e.code === "validation");
  await assert.rejects(tk.inv("tables.add_column", { matter_id: m, table_id: T, label: "到期日", hint: "x" }), /同名/);
  const added = (await tk.inv("tables.add_column", { matter_id: m, table_id: T, label: "保证金", hint: "履约保证金金额，没有写“未约定”", format: "money" })).table;
  assert.deepEqual(added.columns.map((c: any) => c.key), ["contract_name", "signed_on", "expires_on", "custom_1"]);
  await assert.rejects(tk.inv("tables.remove_column", { matter_id: m, table_id: T, column: "expires_on" }), /只能去掉自己加的列/);
  // 填格子（直接走服务，Agent 路径上一条用例已测）
  const { fillCells } = await import("../src/services/review-tables.ts");
  const live = liveTaskIdentity(tk, m, "table2");
  const r = fillCells({ db: tk.kernel.db, blobs: tk.kernel.blobs, tokens: (tk.kernel as any).tokens }, { matterId: m, runId: live.rid }, { table_id: T, cells: [
    { document_version_id: c1.document_version_id, column: "expires_on", value: "2030-12-31", quote: "本合同自 2025-01-01 起至 2030-12-31 止。" },
    { document_version_id: c1.document_version_id, column: "signed_on", value: "2025-01-01", quote: "双方于 2025-01-01 签署本合同" },
    { document_version_id: c2.document_version_id, column: "expires_on", value: "2027-06", quote: "租期至 2027-06 届满。" },
    { document_version_id: c1.document_version_id, column: "custom_1", value: "120 万元", quote: "合同总价为人民币 120 万元" },
  ] });
  assert.equal(r.written, 4, "自建列也能填");
  let grid = await tk.inv("tables.get", { matter_id: m, table_id: T });
  const cell = (doc: string, col: string) => grid.cells.find((c: any) => c.document_version_id === doc && c.col_key === col);
  // 原文前后文
  const ctx = await tk.inv("tables.cell_context", { matter_id: m, table_id: T, cell_id: cell(c1.document_version_id, "signed_on").cell_id });
  assert.equal(ctx.located, true);
  assert.equal(ctx.quote, "双方于 2025-01-01 签署本合同");
  assert.match(ctx.before, /2030-12-31 止。\n?$/);
  assert.match(ctx.after, /^，合同总价/);
  // 推为事实：没核的不推
  assert.deepEqual(await tk.inv("tables.push_facts", { matter_id: m, table_id: T }), { pushed: 0, already: 0, not_verified: 4 });
  await tk.inv("tables.decide_cell", { matter_id: m, table_id: T, cell_id: cell(c1.document_version_id, "signed_on").cell_id, decision: "verify" });
  await tk.inv("tables.decide_cell", { matter_id: m, table_id: T, cell_id: cell(c1.document_version_id, "expires_on").cell_id, decision: "edit", value: "2030-12-30" });
  const p1 = await tk.inv("tables.push_facts", { matter_id: m, table_id: T });
  assert.equal(p1.pushed, 2);
  assert.equal((await tk.inv("tables.push_facts", { matter_id: m, table_id: T })).already, 2, "不重复推");
  const facts = (await tk.inv("facts.list", { matter_id: m })).facts;
  const signed = facts.find((f: any) => f.statement.includes("签署日"));
  assert.equal(signed.status, "confirmed");
  assert.equal(signed.occurred_on, "2025-01-01");
  assert.equal(signed.anchor_status, "located");
  assert.ok(facts.some((f: any) => f.statement === "采购合同：到期日为2030-12-30"), "律师改的值");
  // 去掉自建列：有已核格子须确认
  grid = await tk.inv("tables.get", { matter_id: m, table_id: T });
  await tk.inv("tables.decide_cell", { matter_id: m, table_id: T, cell_id: cell(c1.document_version_id, "custom_1").cell_id, decision: "verify" });
  await assert.rejects(tk.inv("tables.remove_column", { matter_id: m, table_id: T, column: "custom_1" }), (e: any) => e.code === "conflict");
  const removed = (await tk.inv("tables.remove_column", { matter_id: m, table_id: T, column: "custom_1", confirm: true })).table;
  assert.equal(removed.columns.length, 3);
  // 台账：设提醒候选（已过的、只到月的不给日期）；台账不能“据此起草”
  const cand = (await tk.inv("tables.reminder_candidates", { matter_id: m, table_id: T })).candidates;
  assert.deepEqual(cand.map((c: any) => [c.filename, c.column, c.date, c.verified]), [["采购合同.docx", "expires_on", "2030-12-30", true], ["租赁合同.docx", "expires_on", null, false]]);
  assert.match(cand[1].note, /只到月/);
  await assert.rejects(tk.inv("tables.draft", { matter_id: m, table_id: T }), /据此设提醒/);
  // 证据清单 → 证据目录（Word）：未核的标待核，成果带未决项
  const ev = (await tk.inv("tables.create", { matter_id: m, template: "evidence_list", columns: ["evidence_name", "formed_on"], document_version_ids: [c1.document_version_id] })).table;
  fillCells({ db: tk.kernel.db, blobs: tk.kernel.blobs, tokens: (tk.kernel as any).tokens }, { matterId: m, runId: live.rid }, { table_id: ev.table_id, cells: [{ document_version_id: c1.document_version_id, column: "evidence_name", value: "《采购合同》", quote: "采购合同" }] });
  const d = await tk.inv("tables.draft", { matter_id: m, table_id: ev.table_id });
  assert.equal(d.open, 2, "一格没核、一格没填");
  const art = tk.kernel.db.get<{ storage_uri: string; open_items: string; status: string }>(`SELECT storage_uri, open_items, status FROM artifact_versions WHERE artifact_version_id = ?`, [d.artifact_version_id])!;
  assert.equal(art.status, "draft");
  assert.equal(JSON.parse(art.open_items)[0].count, 2);
  const xml = readZipText(tk.kernel.blobs.read(art.storage_uri), "word/document.xml")!;
  assert.ok(xml.includes("证据目录") && xml.includes("【待核】") && xml.includes("【未填】"));
});
