/**
 * 第 34 批：律师直接描述任务（没从场景卡指定方法）时，按助手自己加载的方法核对主交付物。
 * 真实走查：首页写“帮我起草一份民事起诉状……”后点“仍按我的描述处理”，任务快照里没有方法，原先结算时不做任何主交付物核对——
 * 助手即使只交 Excel 也会记“已完成”。现在按 agent.skill 事件里加载过的方法：先找主交付物是 Word 的，再找 Excel 的。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { loadedPrimaryOutput, primaryDeliverableMissing } from "../src/executor/executor.ts";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "freeform-primary-firm");
});
after(async () => {
  await tk.kernel.close();
});

const PRIMARY: Record<string, string> = { "pleading-draft": "民事起诉状（草稿）.docx", "amount-calc": "计算明细.xlsx", "legal-research-memo": "法规研究备忘录.docx" };
const primaryOf = (s: string) => PRIMARY[s] ?? null;

test("自由描述的任务：按加载过的方法核对主交付物（起诉状 + 金额测算 → 要 Word；只加载金额测算 → 要 Excel；没加载方法 → 不核对）", async () => {
  const { matter } = await tk.inv("matters.create", { title: "自由描述核对主交付物", stance: "原告", consent_status: "agreed", key_dates: { analysis_as_of: "2026-11-01" } });
  const db = tk.kernel.db;
  const skillEvent = (rid: string, seq: number, skill: string) => db.run(`INSERT INTO run_events (run_id, attempt_id, seq, type, payload) VALUES (?,?,?,?,?)`, [rid, null, seq, "agent.skill", JSON.stringify({ skill })]);
  const art = (live: { tid: string; rid: string; uid: string }, kind: string, filename: string) =>
    db.run(
      `INSERT INTO artifact_versions (artifact_version_id, tenant_id, matter_id, run_id, kind, version, audience, status, filename, sha256, storage_uri, open_items, manifest, created_by) VALUES (?,?,?,?,?,1,'internal','draft',?,?,?,'[]','{}',?)`,
      [`art_${Math.random().toString(36).slice(2, 10)}`, live.tid, matter.matter_id, live.rid, kind, filename, "x".repeat(64), "blob://x", live.uid],
    );

  // 起诉状任务：助手先加载起诉状方法、再加载金额测算——应交的是起诉状（Word），只交了计算明细不算完成
  const a = liveTaskIdentity(tk, matter.matter_id, "freeform-a");
  skillEvent(a.rid, 10_001, "pleading-draft");
  skillEvent(a.rid, 10_002, "amount-calc");
  assert.equal(loadedPrimaryOutput(db, a.rid, primaryOf), "民事起诉状（草稿）.docx");
  art(a, "agent_table", "计算明细.xlsx");
  const miss = primaryDeliverableMissing(db, a.rid, loadedPrimaryOutput(db, a.rid, primaryOf));
  assert.ok(miss, "只交了 Excel 的起诉状任务要报缺失");
  assert.match(miss.note, /没有交出《民事起诉状（草稿）》/);
  art(a, "agent_report", "民事起诉状.docx");
  assert.equal(primaryDeliverableMissing(db, a.rid, loadedPrimaryOutput(db, a.rid, primaryOf)), null);

  // 先加载金额测算、后加载起诉状：仍按 Word 文书核对
  const b = liveTaskIdentity(tk, matter.matter_id, "freeform-b");
  skillEvent(b.rid, 10_001, "amount-calc");
  skillEvent(b.rid, 10_002, "pleading-draft");
  assert.equal(loadedPrimaryOutput(db, b.rid, primaryOf), "民事起诉状（草稿）.docx");

  // 只加载金额测算：要一张表
  const c = liveTaskIdentity(tk, matter.matter_id, "freeform-c");
  skillEvent(c.rid, 10_001, "amount-calc");
  assert.equal(loadedPrimaryOutput(db, c.rid, primaryOf), "计算明细.xlsx");
  assert.equal(primaryDeliverableMissing(db, c.rid, loadedPrimaryOutput(db, c.rid, primaryOf))?.cause, "no_sheet_output");

  // 没加载方法（直接问答）、或加载的方法不在模板包里：不核对
  const d = liveTaskIdentity(tk, matter.matter_id, "freeform-d");
  assert.equal(loadedPrimaryOutput(db, d.rid, primaryOf), null);
  skillEvent(d.rid, 10_001, "unknown-skill");
  assert.equal(loadedPrimaryOutput(db, d.rid, primaryOf), null);
});
