/**
 * 离所交接清单的“已导出归档”判定（复核 R15A-06、R15A-18）：
 * - 归档写失败不算导出过（写成功之后才记审计）；
 * - 导出后风险卡、事实有了变化，同样要重新导出；
 * - 已结案的团队事项不能再加负责人：按导出归档交接，不列“交给同事”。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { makeKernel, importText, type TestKernel } from "./helpers.ts";

let tk: TestKernel | null = null;
// 同一毫秒里的改动按“导出后又有改动”算（宁可多导一次）：改动与导出之间隔开几毫秒，免得用例偶发撞上同一毫秒
const tick = () => new Promise((r) => setTimeout(r, 5));
after(async () => {
  await tk?.kernel.close().catch(() => {});
});

test("复核 R15A-06：写失败不算已导出；导出后改了风险卡或事实要重新导出", async () => {
  tk = await makeKernel({}, "offboard-archive");
  const { inv, kernel } = tk;
  const db = kernel.db;
  const p = (await inv("matters.create", { title: "个人事项", stance: "原告", consent_status: "not_required" })).matter.matter_id as string;
  const doc = await importText(inv, p, "合同.txt", "第一条 付款。");
  const status = async () => ((await inv("members.offboarding")).matters as any[]).find((x) => x.matter_id === p).status;
  const exported = () => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'matter.archive_exported' AND object_id = ?`, [p])!.n;
  assert.equal(await status(), "needs_archive");
  await tick();

  // 保存位置写不进去：报错，清单仍是“还没有导出归档”，也没有记成已导出
  await assert.rejects(inv("matters.archive", { matter_id: p, save_path: join(tk.dir, "不存在的目录", "子目录", "归档.zip") }));
  assert.equal(exported(), 0, "写失败不记审计");
  assert.equal(await status(), "needs_archive");

  await inv("matters.archive", { matter_id: p });
  assert.equal(await status(), "ok");
  await tick();

  // 导出后新出一张风险卡（或改了卡片决定）
  const tenant = db.get<{ tenant_id: string }>(`SELECT tenant_id FROM matters WHERE matter_id = ?`, [p])!.tenant_id;
  db.run(
    `INSERT INTO risk_cards (card_id, tenant_id, matter_id, run_id, document_version_id, seq, clause_ref, anchor_text, anchor_status, severity, category, issue, status)
     VALUES ('rkc_off', ?, ?, NULL, ?, 1, '第一条', '付款', 'located', 'high', 'commercial', '付款期限不明', 'proposed')`,
    [tenant, p, doc.document_version_id],
  );
  assert.equal(await status(), "needs_archive", "风险卡变化要重新导出");
  await tick();
  await inv("matters.archive", { matter_id: p });
  assert.equal(await status(), "ok");
  await tick();

  // 导出后新提交了一条事实
  db.run(`INSERT INTO matter_facts (fact_id, tenant_id, matter_id, seq, statement, kind, anchor_status) VALUES ('fct_off', ?, ?, 1, '2023年3月5日签订合同', 'claimed', 'no_document')`, [tenant, p]);
  assert.equal(await status(), "needs_archive", "事实变化要重新导出");
});

test("复核 R15A-18：已结案的团队事项按导出归档交接，不列可接手的同事", async () => {
  const { inv, kernel } = tk!;
  const db = kernel.db;
  const t = (await inv("matters.create", { title: "团队事项", stance: "原告", consent_status: "not_required", collab_scope: "team" })).matter.matter_id as string;
  const tenant = db.get<{ tenant_id: string }>(`SELECT tenant_id FROM matters WHERE matter_id = ?`, [t])!.tenant_id;
  // 一位有在用电脑的同事（编辑）
  db.run(`INSERT INTO users (user_id, tenant_id, display_name) VALUES ('usr_colleague', ?, '同事乙')`, [tenant]);
  db.run(`INSERT INTO matter_members (matter_id, user_id, matter_role, added_by) VALUES (?, 'usr_colleague', 'editor', 'test')`, [t]);
  db.run(`INSERT INTO devices (device_id, tenant_id, member_id, role, sign_pub_pem, enc_pub_pem, cert_json) VALUES ('dev_colleague', ?, 'usr_colleague', 'lawyer', 'x', 'x', '{}')`, [tenant]);
  const item = async () => ((await inv("members.offboarding")).matters as any[]).find((x) => x.matter_id === t);
  const open = await item();
  assert.equal(open.status, "needs_owner", "进行中：交给同事");
  assert.deepEqual(open.colleagues.map((c: any) => c.user_id), ["usr_colleague"]);

  await inv("matters.close", { matter_id: t, retention_years: 1 });
  const closed = await item();
  assert.equal(closed.closed, true);
  assert.equal(closed.status, "needs_archive", "已结案：按导出归档交接");
  assert.deepEqual(closed.colleagues, [], "不列“交给他”（已结案的事项不能再加负责人）");
});
