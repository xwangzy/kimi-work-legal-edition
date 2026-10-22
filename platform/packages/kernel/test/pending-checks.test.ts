/**
 * v9.4 第 21 批（主文 §6.4“统一待核清单对象缺”）：事项的统一待核清单——没确认的事实、没核的格子、没处理的审查意见（按合同、重大在前）、
 * 成果未决项；处理完就从清单里消失（现算，不另存）。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createDocx } from "@zr-legal/docx-engine";
import { importBytes, liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { submitFacts, submitRiskCards } from "../src/services/review-cards.ts";
import { fillCells } from "../src/services/review-tables.ts";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "pending-checks-firm");
});
after(async () => {
  await tk.kernel.close();
});

test("待核清单：事实、格子、审查意见、成果未决项；处理完即消失", { timeout: 60_000 }, async () => {
  const { inv, kernel } = tk;
  const { matter } = await inv("matters.create", { title: "待核", stance: "买方", consent_status: "agreed" });
  const m = matter.matter_id;
  assert.deepEqual((await inv("matters.pending_checks", { matter_id: m })).checks, [], "新事项没有待核");
  const doc = await importBytes(tk.inv, m, "采购合同.docx", createDocx("采购合同", [{ heading: "第八条", paragraphs: ["8.1 买方应于验收合格后九十日内支付货款。"] }]), DOCX);
  const live = liveTaskIdentity(tk, m, "pending");
  const scope = { tenantId: live.tid, matterId: m, runId: live.rid };
  const deps = { db: kernel.db, blobs: kernel.blobs };
  submitFacts(deps, scope, { facts: [{ statement: "买方签收", kind: "claimed", occurred_on: "2026-03-01" }, { statement: "卖方催款", kind: "claimed", occurred_on: "2026-04-01" }] });
  submitRiskCards(deps, scope, { document_version_id: doc.document_version_id, cards: [{ anchor_text: "买方应于验收合格后九十日内支付货款。", severity: "high", issue: "【权利义务】付款期限过长" }] });
  const T = (await inv("tables.create", { matter_id: m, template: "contract_ledger", columns: ["contract_name"], document_version_ids: [doc.document_version_id] })).table.table_id;
  fillCells({ ...deps, tokens: (kernel as any).tokens }, { matterId: m, runId: live.rid }, { table_id: T, cells: [{ document_version_id: doc.document_version_id, column: "contract_name", value: "采购合同", quote: "采购合同" }] });
  const d = await inv("tables.draft", { matter_id: m, table_id: T }).catch(() => null);
  assert.equal(d, null, "台账不起草（只设提醒），这里只为确认不会误报");

  let r = await inv("matters.pending_checks", { matter_id: m });
  assert.deepEqual(r.checks.map((c: any) => [c.kind, c.count]), [["facts", 2], ["table_cells", 1], ["risk_cards", 1]]);
  assert.match(r.checks[2].text, /《采购合同\.docx》有 1 条审查意见没处理（其中重大 1 条）/);
  assert.deepEqual(r.checks[2].target, { workbench: doc.document_version_id });
  assert.deepEqual(r.checks[1].target, { tab: "materials", view: "table", table_id: T });
  assert.equal(r.total, 4);

  // 处理掉：确认事实、核格子、决定意见
  for (const f of (await inv("facts.list", { matter_id: m })).facts) await inv("facts.decide", { matter_id: m, fact_id: f.fact_id, decision: "confirm" });
  const cell = (await inv("tables.get", { matter_id: m, table_id: T })).cells[0];
  await inv("tables.decide_cell", { matter_id: m, table_id: T, cell_id: cell.cell_id, decision: "verify" });
  const card = (await inv("riskcards.list", { matter_id: m })).cards[0];
  await inv("riskcards.decide", { matter_id: m, card_id: card.card_id, decision: "reject" });
  r = await inv("matters.pending_checks", { matter_id: m });
  assert.deepEqual(r.checks, []);

  // 成果未决项：据审阅表起草、格子没核时带“来自审阅表、还没核的内容”
  const T2 = (await inv("tables.create", { matter_id: m, template: "evidence_list", columns: ["evidence_name"], document_version_ids: [doc.document_version_id] })).table.table_id;
  const dr = await inv("tables.draft", { matter_id: m, table_id: T2 });
  r = await inv("matters.pending_checks", { matter_id: m });
  const oi = r.checks.find((c: any) => c.kind === "open_items");
  assert.ok(oi, JSON.stringify(r.checks));
  assert.match(oi.text, /来自审阅表、还没核的内容/);
  assert.deepEqual(oi.target, { artifact_version_id: dr.artifact_version_id });
});
