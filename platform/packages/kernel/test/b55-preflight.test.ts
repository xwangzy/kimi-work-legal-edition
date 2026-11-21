/**
 * 第 55 批 K1（审计 A P0-2、B 1.6）：任务提示词在【任务】之后写明【开工前已知】——本次指定材料几份、本事项共几份（读不出文字的几份）、
 * 已确认与待确认事实几条，以及固定的“已写明的不再问”；空事项另写“不必先查材料目录、没有案情就第一步一次问清”。
 * 数目由内核从库里算（不信任界面传值）；不传时提示词与旧版逐字相同；追问不加。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { agentFollowUpPrompt, agentGoalPrompt, preflightLine, preflightOf, PREFLIGHT_EMPTY_RULE, PREFLIGHT_KNOWN_RULE } from "../src/executor/executor.ts";
import { importText, makeKernel, type TestKernel } from "./helpers.ts";

const KNOWN = "任务说明与方法参数里律师已经写明的（法院、请求、日期、立场、金额口径等）不再问；";
const EMPTY = "本事项没有材料、也没有确认过的事实：案情以任务说明为准，不必先查材料目录；任务说明里也没有案情的，第一步就用提问工具一次问清（纠纷类型、基本事实、请求、对方是谁），不要先起草。";

test("固定句逐字", () => {
  assert.equal(PREFLIGHT_KNOWN_RULE, KNOWN);
  assert.equal(PREFLIGHT_EMPTY_RULE, EMPTY);
});

test("三种情形逐字：空事项 / 有材料无确认事实 / 有确认事实", () => {
  assert.equal(
    preflightLine({ selected: 0, matterMaterials: 0, unreadable: 0, confirmedFacts: 0, pendingFacts: 0 }),
    `【开工前已知】本次指定材料 0 份；本事项共 0 份材料；本事项已确认事实 0 条、待确认 0 条。${KNOWN}${EMPTY}\n`,
  );
  assert.equal(
    preflightLine({ selected: 2, matterMaterials: 3, unreadable: 1, confirmedFacts: 0, pendingFacts: 4 }),
    `【开工前已知】本次指定材料 2 份；本事项共 3 份材料（其中读不出文字的 1 份）；本事项已确认事实 0 条、待确认 4 条。${KNOWN}\n`,
  );
  assert.equal(
    preflightLine({ selected: 0, matterMaterials: 0, confirmedFacts: 5, pendingFacts: 1 }),
    `【开工前已知】本次指定材料 0 份；本事项共 0 份材料；本事项已确认事实 5 条、待确认 1 条。${KNOWN}\n`,
  );
  // 事项有材料但本次没指定：不算“空事项”
  assert.ok(!preflightLine({ selected: 0, matterMaterials: 2, confirmedFacts: 0, pendingFacts: 0 }).includes(EMPTY));
});

test("agentGoalPrompt：这一行紧跟【任务】；不传时与旧版逐字相同；追问不加", () => {
  const base = { stance: "原告", jurisdiction: "内地民商事", asOf: "2026-11-22", facts: "", goal: "起草起诉状", methodLine: "【方法】按起诉状方法。\n", rulesBlock: "", prefsLine: "" };
  const old = agentGoalPrompt(base);
  assert.equal(old.includes("【开工前已知】"), false);
  const pf = { selected: 0, matterMaterials: 0, confirmedFacts: 0, pendingFacts: 0 };
  const withPf = agentGoalPrompt({ ...base, preflight: pf });
  assert.ok(withPf.includes(`【任务】起草起诉状\n${preflightLine(pf)}【方法】按起诉状方法。\n`));
  // 去掉这一行后与旧版逐字相同
  assert.equal(withPf.replace(preflightLine(pf), ""), old);
  assert.equal(agentFollowUpPrompt("再改一下", "", false).includes("【开工前已知】"), false);
});

let tk: TestKernel | null = null;
after(async () => {
  await tk?.kernel.close();
});

test("preflightOf 从库里算：最新版本、读不出文字、确认与待确认事实、本次指定份数去重", async () => {
  tk = await makeKernel({}, "b55-preflight-firm");
  const { matter } = await tk.inv("matters.create", { title: "开工前已知探针", stance: "原告", consent_status: "not_required", key_dates: { analysis_as_of: "2026-11-22" } });
  const db = tk.kernel.db;
  assert.deepEqual(preflightOf(db, matter.matter_id, []), { selected: 0, matterMaterials: 0, unreadable: 0, confirmedFacts: 0, pendingFacts: 0 });

  const a = await importText(tk.inv, matter.matter_id, "合同.txt", "甲方与乙方签订买卖合同。");
  const b = await importText(tk.inv, matter.matter_id, "催款函.txt", "请于十日内付款。");
  // 新版本取代旧版本：只算一份
  db.run(`UPDATE document_versions SET supersedes = ? WHERE document_version_id = ?`, [a.document_version_id, b.document_version_id]);
  let pf = preflightOf(db, matter.matter_id, [b.document_version_id, b.document_version_id]);
  assert.equal(pf.matterMaterials, 1);
  assert.equal(pf.selected, 1);
  db.run(`UPDATE document_versions SET supersedes = NULL WHERE document_version_id = ?`, [b.document_version_id]);

  // 读不出文字：最新解析的各页都识别失败
  const pv = db.get<{ parse_version_id: string }>(`SELECT parse_version_id FROM parse_versions WHERE document_version_id = ? ORDER BY created_at DESC LIMIT 1`, [a.document_version_id]);
  assert.ok(pv, "导入后应有解析版本");
  db.run(`DELETE FROM parse_pages WHERE parse_version_id = ?`, [pv!.parse_version_id]);
  db.run(`INSERT INTO parse_pages (parse_version_id, page_no, kind, quality, note) VALUES (?, 1, 'scanned', 'unreadable', NULL)`, [pv!.parse_version_id]);

  const tid = db.get<{ tenant_id: string }>(`SELECT tenant_id FROM matters WHERE matter_id = ?`, [matter.matter_id])!.tenant_id;
  const fact = (id: string, status: string) =>
    db.run(`INSERT INTO matter_facts (fact_id, tenant_id, matter_id, seq, statement, kind, anchor_status, status) VALUES (?, ?, ?, 1, '某事实', ?, 'no_document', ?)`, [id, tid, matter.matter_id, status === "confirmed" ? "confirmed" : "claimed", status]);
  fact("fct_c1", "confirmed");
  fact("fct_c2", "confirmed");
  fact("fct_p1", "proposed");
  fact("fct_r1", "rejected");
  pf = preflightOf(db, matter.matter_id, [a.document_version_id]);
  assert.deepEqual(pf, { selected: 1, matterMaterials: 2, unreadable: 1, confirmedFacts: 2, pendingFacts: 1 });
  assert.equal(
    preflightLine(pf),
    `【开工前已知】本次指定材料 1 份；本事项共 2 份材料（其中读不出文字的 1 份）；本事项已确认事实 2 条、待确认 1 条。${KNOWN}\n`,
  );
});
