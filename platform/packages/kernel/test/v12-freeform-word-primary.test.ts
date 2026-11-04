/**
 * V12：要求起草或修订法律文书，最终却输出 Excel——内核结算一侧。
 * 根因：自由描述的任务（律师点“仍按我的描述处理”，快照里没有方法）只按助手加载过的方法核对主交付物；
 * 助手没加载方法、或只加载了金额测算、回稿比对这类主交付物为 Excel 的方法时，只交一张表也记“已完成”。
 * 现在律师的请求句明确要起草、修改一份文书时，按 Word 文书核对（与首页建议同一口径 wantsWordDocument）。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { wantsWordDocument } from "@zr-legal/domain/deliverable-intent";
import { liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { REQUESTED_WORD_PRIMARY, freeformPrimaryOutput, loadedPrimaryOutput, primaryDeliverableMissing } from "../src/executor/executor.ts";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "v12-freeform-word-firm");
});
after(async () => {
  await tk.kernel.close();
});

const PRIMARY: Record<string, string> = { "amount-calc": "计算明细.xlsx", "redraft-review": "变更清单.xlsx", "pleading-draft": "民事起诉状（草稿）.docx" };
const primaryOf = (s: string) => PRIMARY[s] ?? null;

test("自由描述任务的主交付物：请求句要文书时按 Word 核对；要表、只问问题的照旧", () => {
  // 要文书：没加载方法、或只加载了出表的方法 → Word
  assert.equal(freeformPrimaryOutput("请按违约金计算结果起草一份律师函，催告对方十日内付款", null), REQUESTED_WORD_PRIMARY);
  assert.equal(freeformPrimaryOutput("请按违约金计算结果起草一份律师函，催告对方十日内付款", "计算明细.xlsx"), REQUESTED_WORD_PRIMARY);
  assert.equal(freeformPrimaryOutput("对方回稿了，请按我方意见修改出修订稿", "变更清单.xlsx"), REQUESTED_WORD_PRIMARY);
  // 加载了文书方法：用方法的文书名
  assert.equal(freeformPrimaryOutput("起草一份民事起诉状", "民事起诉状（草稿）.docx"), "民事起诉状（草稿）.docx");
  // 要表或只问问题：不改变原口径
  assert.equal(freeformPrimaryOutput("把这些付款记录整理成一张逾期利息计算明细表", "计算明细.xlsx"), "计算明细.xlsx");
  assert.equal(freeformPrimaryOutput("这份合同的管辖条款有效吗？", null), null);
  assert.equal(freeformPrimaryOutput("对方回稿，看看改了什么", "变更清单.xlsx"), "变更清单.xlsx");
  // 材料描述与审查成果不是要文书
  assert.equal(wantsWordDocument("根据对方起草的合同列一份风险清单"), false);
  assert.equal(wantsWordDocument("给出修改意见即可"), false);
});

test("只交 Excel 的“起草律师函”自由描述任务记主交付物缺失，交出 Word 后不再报", async () => {
  const { matter } = await tk.inv("matters.create", { title: "V12 自由描述要文书", stance: "原告", consent_status: "agreed", key_dates: { analysis_as_of: "2026-11-04" } });
  const db = tk.kernel.db;
  const live = liveTaskIdentity(tk, matter.matter_id, "v12-freeform");
  db.run(`INSERT INTO run_events (run_id, attempt_id, seq, type, payload) VALUES (?,?,?,?,?)`, [live.rid, null, 10_001, "agent.skill", JSON.stringify({ skill: "amount-calc" })]);
  const art = (kind: string, filename: string) =>
    db.run(
      `INSERT INTO artifact_versions (artifact_version_id, tenant_id, matter_id, run_id, kind, version, audience, status, filename, sha256, storage_uri, open_items, manifest, created_by) VALUES (?,?,?,?,?,1,'internal','draft',?,?,?,'[]','{}',?)`,
      [`art_${Math.random().toString(36).slice(2, 10)}`, live.tid, matter.matter_id, live.rid, kind, filename, "x".repeat(64), "blob://x", live.uid],
    );
  const goal = "请按违约金计算结果起草一份律师函，催告对方十日内付款";
  art("agent_table", "计算明细.xlsx");
  // 改动前：只按加载过的方法核对 → 计算明细.xlsx 已交，记“已完成”
  assert.equal(primaryDeliverableMissing(db, live.rid, loadedPrimaryOutput(db, live.rid, primaryOf)), null);
  // 改动后：按请求句要的文书核对 → 缺失
  const expected = freeformPrimaryOutput(goal, loadedPrimaryOutput(db, live.rid, primaryOf));
  const miss = primaryDeliverableMissing(db, live.rid, expected);
  assert.ok(miss, "只交了 Excel 的起草任务要报缺失");
  assert.equal(miss.cause === "no_word_output" || miss.cause === "outline_missing" || miss.cause === "outline_pending", true);
  assert.match(miss.note, /没有交出《律师要求的 Word 文书》/);
  art("agent_report", "律师函.docx");
  assert.equal(primaryDeliverableMissing(db, live.rid, expected), null);
});
