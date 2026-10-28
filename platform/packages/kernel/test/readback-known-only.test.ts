/**
 * 读回工具的结果按字段令牌化（v9.4 第 30 批，D-157 第二步）：Agent 经本机端点用 riskcards.list / facts.list / outline.get / table.get
 * 读回自己提交的卡片、事实、论点与格子——模型写的字段只替换已知名单，不把“乙方应开具……”里的“应开具”学成姓名；
 * 律师写的字段（修改后接受的文字、确认时改写的事实、改写的论点与备注、改过的格子）照常识别并学进事项令牌表。
 * 第 30 批真实复测（run_4652ff17）：riskcards.list 交回的卡片建议在这里学进了“应开具、应完整、应完成”。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createDocx } from "@zr-legal/docx-engine";
import { importBytes, liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { mintTaskToken } from "../src/identity.ts";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "readback-known-only-firm");
});
after(async () => {
  await tk.kernel.close();
});

/** 助手意见里的话术（第 30 批真实复测原话）：现行规则按材料口径会认出“应开具、应完整、应完成”。 */
const SAID = {
  suggestion: "每期付款前，乙方应开具等额合法有效的增值税专用发票。",
  fallback: "乙方应完整交付源代码、文档及相关资料，并保证不侵权。",
  issue: "合同解除或终止后，乙方应完成工作、源代码、文档及数据的交接。",
};

test("四个读回工具：模型写的字段不学新姓名、原样交回；律师写的字段照常识别并学进令牌表", { timeout: 120_000 }, async () => {
  const { Agent, fetch } = await import("undici");
  const { matter } = await tk.inv("matters.create", { title: "技术服务合同审查", stance: "甲方", consent_status: "agreed", key_dates: { analysis_as_of: "2026-10-28" } });
  const m = matter.matter_id;
  const contract = createDocx("技术服务合同", [
    { heading: "第三条 付款", paragraphs: ["3.3 乙方收到款项后十五个工作日内向甲方开具等额增值税专用发票。"] },
    { heading: "第五条 成果", paragraphs: ["5.1 乙方在履行本合同过程中形成的全部成果归乙方所有。"] },
  ]);
  const doc = await importBytes(tk.inv, m, "技术服务合同.docx", contract, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  const live = liveTaskIdentity(tk, m, "readback");
  tk.kernel.db.run(`UPDATE runs SET input_snapshot = ? WHERE run_id = ?`, [JSON.stringify({ goal: "审查", document_version_ids: [doc.document_version_id] }), live.rid]);
  const token = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: live.fence, fx: ["read", "write_draft"], scope: ["tool:legal"] }, 300);
  const agent = new Agent({ connect: { socketPath: tk.kernel.pipePath } });
  let seq = 0;
  const call = async (name: string, args: unknown) => {
    const r = (await fetch("http://tools.kwl/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } }),
      dispatcher: agent,
    }).then((x) => x.json())) as any;
    assert.equal(r.result?.isError, false, `${name}: ${JSON.stringify(r)}`);
    return r.result.structuredContent;
  };
  const persons = () => tk.kernel.db.all<{ value: string }>(`SELECT value FROM matter_tokens WHERE matter_id = ? AND category = 'person' ORDER BY value`, [m]).map((r) => r.value);

  // Agent 提交（模型写的）
  await call("riskcards.submit", {
    document_version_id: doc.document_version_id,
    cards: [
      { clause_ref: "3.3", anchor_text: "乙方收到款项后十五个工作日内向甲方开具等额增值税专用发票。", severity: "high", category: "both", issue: "先收款后开票。", suggestion: SAID.suggestion, fallback: SAID.fallback },
      { clause_ref: "5.1", anchor_text: "乙方在履行本合同过程中形成的全部成果归乙方所有。", severity: "high", category: "legal", issue: SAID.issue, suggestion: "成果归甲方所有。" },
    ],
  });
  await call("facts.submit", { facts: [{ statement: SAID.suggestion, kind: "claimed" }, { statement: "乙方未交付源代码。", kind: "claimed" }] });
  const { table } = await tk.inv("tables.create", { matter_id: m, template: "contract_ledger", columns: ["contract_name", "counterparty"], document_version_ids: [doc.document_version_id] });
  await call("table.fill", {
    table_id: table.table_id,
    cells: [
      { document_version_id: doc.document_version_id, column: "contract_name", value: SAID.fallback, quote: "技术服务合同" },
      { document_version_id: doc.document_version_id, column: "counterparty", value: "乙方", quote: "乙方" },
    ],
  });
  const ol = await call("outline.submit", { doc_kind: "律师函", arguments: [{ claim: SAID.issue, basis: [{ law: "民法典", article: 509 }] }, { claim: "乙方应退还已付款项", basis: [{ law: "民法典", article: 566 }] }] });
  assert.deepEqual(persons(), [], "提交本身不学");

  // 读回：模型写的字段原样交回、不学
  const cards = (await call("riskcards.list", {})).cards;
  assert.deepEqual(cards.map((c: any) => c.suggestion), [SAID.suggestion, "成果归甲方所有。"]);
  assert.equal(cards[0].fallback, SAID.fallback);
  assert.equal(cards[1].issue, SAID.issue);
  const facts = (await call("facts.list", {})).facts;
  assert.equal(facts.find((f: any) => f.statement.startsWith("每期付款前")).statement, SAID.suggestion);
  const grid = await call("table.get", { table_id: table.table_id });
  assert.equal(grid.cells.find((c: any) => c.column === "contract_name").value, SAID.fallback);
  assert.deepEqual(persons(), [], "读回模型写的字段不学进令牌表");

  // 律师写的字段：修改后接受、确认时改写事实、改写论点与备注、改格子——照常识别
  await tk.inv("riskcards.decide", { matter_id: m, card_id: cards[1].card_id, decision: "modify", final_text: "合同解除后十日内，乙方向甲方移交全部资料，由证人王建业签收。" });
  await tk.inv("facts.decide", { matter_id: m, fact_id: facts.find((f: any) => f.statement === "乙方未交付源代码。").fact_id, decision: "confirm", statement: "证人赵立新确认乙方未交付源代码。" });
  const cell = (await tk.inv("tables.get", { matter_id: m, table_id: table.table_id })).cells.find((c: any) => c.col_key === "counterparty");
  await tk.inv("tables.decide_cell", { matter_id: m, table_id: table.table_id, cell_id: cell.cell_id, decision: "edit", value: "北京远帆信息技术有限公司（联系人：钱志远）" });
  await tk.inv("outlines.decide", { matter_id: m, outline_id: ol.outline_id, decisions: [{ arg_id: "a1", keep: true }, { arg_id: "a2", keep: true, claim: "证人孙志强可证明乙方已收款" }], note: "联系人周文涛另行核实" });

  const back = (await call("riskcards.list", {})).cards;
  assert.ok(!back[1].lawyer_text.includes("王建业"), back[1].lawyer_text);
  const facts2 = (await call("facts.list", {})).facts;
  assert.ok(!facts2.some((f: any) => f.statement.includes("赵立新")));
  const grid2 = await call("table.get", { table_id: table.table_id });
  assert.ok(!grid2.cells.find((c: any) => c.column === "counterparty").value.includes("钱志远"));
  const got = await call("outline.get", {});
  assert.equal(got.confirmed_arguments[0].claim, SAID.issue, "未改写的论点原样");
  assert.ok(!got.confirmed_arguments[1].claim.includes("孙志强") && !got.lawyer_note.includes("周文涛"));
  assert.deepEqual(persons(), ["孙志强", "周文涛", "王建业", "赵立新", "钱志远"].sort(), "只学进律师写的字段里的姓名");
});
