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
