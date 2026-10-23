/**
 * v9.4 第 25 批（复核 Q6 处置时没补上的用例与界面层防护）：
 * - 复核 Q6-08 / Q6-13：别人放入的范本，普通律师删不了，律所管理员、合伙人能删；只读成员不能把范本放进事项；
 *   别的律所的范本经接口查不到、删不了、放不进事项，审合同卡片也不会列出来；
 * - 复核 Q6-12：照范本改时带进修改框的【当事人】等占位符，内核同样拒绝保存（原来只在界面挡）。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { importText, liveTaskIdentity, makeKernel, type TestKernel } from "./helpers.ts";
import { submitRiskCards } from "../src/services/review-cards.ts";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel({}, "b25-firm");
});
after(async () => {
  await tk.kernel.close();
});

const PAY = "第五条 付款\n买方应于验收合格后三十日内付清全部价款。";
/** 直接写一份范本行（别人放入的、别的律所的）：测试内核只有一个成员，另起成员与租户只能落库。 */
function insertTemplate(tenantId: string, createdBy: string, title: string): string {
  const id = `ftpl_${randomUUID()}`;
  tk.kernel.db.run(
    `INSERT INTO firm_templates (template_id, tenant_id, title, contract_type, stance, note, source_name, sha256, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id, tenantId, title, "买卖", "买方", null, null, createHash("sha256").update(title).digest("hex"), createdBy, new Date().toISOString()],
  );
  tk.kernel.db.run(`INSERT INTO firm_template_clauses (template_id, seq, heading, text) VALUES (?,?,?,?)`, [id, 1, "第五条 付款", PAY]);
  return id;
}
const setRole = (role: string) => tk.kernel.db.run(`UPDATE memberships SET role = ? WHERE tenant_id = ? AND user_id = ?`, [role, tk.kernel.identity.tenantId, tk.kernel.identity.userId]);

test("复核 Q6-13：别人放入的范本，普通律师删不了（不删、不记审计）；合伙人、律所管理员能删；自己放入的随时能删", async () => {
  const { inv, kernel } = tk;
  const tid = kernel.identity.tenantId;
  let other = "";
  const was = kernel.db.get<{ role: string }>(`SELECT role FROM memberships WHERE tenant_id = ? AND user_id = ?`, [tid, kernel.identity.userId])!.role;
  try {
    setRole("lawyer");
    other = insertTemplate(tid, "usr_b25-firm_colleague", "采购合同（同事放入）");
    await assert.rejects(inv("firm_templates.remove", { template_id: other }), (e: any) => e.code === "forbidden" && /放入这份范本的人/.test(e.message));
    assert.ok((await inv("firm_templates.list")).templates.some((t: any) => t.template_id === other), "被拒后范本还在");
    assert.equal(kernel.db.get(`SELECT 1 AS x FROM audit_events WHERE action = 'firm_template.removed' AND object_id = ?`, [other]), undefined, "被拒不记删除审计");
    // 自己放入的：普通律师也能删
    const mine = (await inv("firm_templates.add", { title: "采购合同（我放入）", contract_type: "买卖", text: PAY })).template.template_id;
    await inv("firm_templates.remove", { template_id: mine });
    for (const role of ["partner", "firm_admin"]) {
      setRole(role);
      const t = insertTemplate(tid, "usr_b25-firm_colleague", `采购合同（${role}）`);
      await inv("firm_templates.remove", { template_id: t });
      assert.ok(!(await inv("firm_templates.list")).templates.some((x: any) => x.template_id === t), `${role} 能删别人放入的`);
    }
    setRole("lawyer");
    await assert.rejects(inv("firm_templates.remove", { template_id: other }), (e: any) => e.code === "forbidden");
  } finally {
    setRole(was);
  }
  await inv("firm_templates.remove", { template_id: other });
});

test("复核 Q6-08：只读成员不能把范本放进事项（不导入材料）；编辑成员可以", async () => {
  const { inv, kernel } = tk;
  const tpl = (await inv("firm_templates.add", { title: "采购合同（买方版）", contract_type: "买卖", stance: "买方", text: PAY })).template.template_id;
  const { matter } = await inv("matters.create", { title: "范本放入权限", stance: "买方", consent_status: "agreed" });
  const docs = () => kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM document_versions WHERE matter_id = ?`, [matter.matter_id])!.n;
  kernel.db.run(`UPDATE matter_members SET matter_role = 'viewer' WHERE matter_id = ? AND user_id = ?`, [matter.matter_id, kernel.identity.userId]);
  await assert.rejects(inv("firm_templates.to_matter", { template_id: tpl, matter_id: matter.matter_id }), (e: any) => e.code === "forbidden" && /只读/.test(e.message));
  assert.equal(docs(), 0, "被拒时没有导入材料");
  // 被移出的成员同样不能
  kernel.db.run(`UPDATE matter_members SET removed_at = ? WHERE matter_id = ? AND user_id = ?`, [new Date().toISOString(), matter.matter_id, kernel.identity.userId]);
  await assert.rejects(inv("firm_templates.to_matter", { template_id: tpl, matter_id: matter.matter_id }), (e: any) => e.code === "forbidden" || e.code === "not_found");
  kernel.db.run(`UPDATE matter_members SET removed_at = NULL, matter_role = 'owner' WHERE matter_id = ? AND user_id = ?`, [matter.matter_id, kernel.identity.userId]);
  const r = await inv("firm_templates.to_matter", { template_id: tpl, matter_id: matter.matter_id });
  assert.match(r.filename, /（本所范本）\.docx$/);
  assert.equal(docs(), 1);
  await inv("firm_templates.remove", { template_id: tpl });
});

test("复核 Q6-08：别的律所的范本经接口查不到、删不了、放不进事项，审合同卡片也不列", async () => {
  const { inv, kernel } = tk;
  const foreign = insertTemplate("ten_other-firm", "usr_other-firm_lawyer", "采购合同（别所）");
  assert.ok(!(await inv("firm_templates.list")).templates.some((t: any) => t.template_id === foreign), "列表不含别所范本");
  await assert.rejects(inv("firm_templates.get", { template_id: foreign }), (e: any) => e.code === "not_found");
  await assert.rejects(inv("firm_templates.remove", { template_id: foreign }), (e: any) => e.code === "not_found");
  const { matter } = await inv("matters.create", { title: "范本隔离", stance: "买方", consent_status: "agreed" });
  await assert.rejects(inv("firm_templates.to_matter", { template_id: foreign, matter_id: matter.matter_id }), (e: any) => e.code === "not_found");
  assert.ok(kernel.db.get(`SELECT 1 AS x FROM firm_templates WHERE template_id = ?`, [foreign]), "别所范本没被删");

  // 审合同卡片：本所库为空时不列别所的付款条款；本所放入同样的条款后才列
  const doc = await importText(inv, matter.matter_id, "采购合同.txt", "第五条 付款\n买方应于验收合格后九十日内付款。");
  const live = liveTaskIdentity(tk, matter.matter_id, "b25-iso");
  submitRiskCards({ db: kernel.db, blobs: kernel.blobs }, { tenantId: live.tid, matterId: matter.matter_id, runId: live.rid }, { document_version_id: doc.document_version_id, cards: [{ anchor_text: "买方应于验收合格后九十日内付款。", severity: "mid", category: "commercial", issue: "付款期限过长", suggestion: "改为三十日内付款" }] });
  const card = (await inv("riskcards.list", { matter_id: matter.matter_id })).cards[0];
  const empty = await inv("firm_templates.for_card", { matter_id: matter.matter_id, card_id: card.card_id });
  assert.equal(empty.items.length, 0, "别所的付款条款不列");
  assert.equal(empty.library_size, 0);
  const own = (await inv("firm_templates.add", { title: "采购合同（本所）", contract_type: "买卖", stance: "买方", text: PAY })).template.template_id;
  const hit = await inv("firm_templates.for_card", { matter_id: matter.matter_id, card_id: card.card_id });
  assert.ok(hit.items.length > 0 && hit.items.every((x: any) => x.template_id === own), "只列本所的");
  await inv("firm_templates.remove", { template_id: own });
});

test("复核 Q6-12：修改后的文字里还有【当事人】等范本占位符，内核拒绝保存、卡片不变；换掉后可以保存", async () => {
  const { inv, kernel } = tk;
  const { matter } = await inv("matters.create", { title: "占位符拦截", stance: "买方", consent_status: "agreed" });
  const doc = await importText(inv, matter.matter_id, "采购合同.txt", "第五条 付款\n买方应于验收合格后九十日内付款。");
  const live = liveTaskIdentity(tk, matter.matter_id, "b25-ph");
  submitRiskCards({ db: kernel.db, blobs: kernel.blobs }, { tenantId: live.tid, matterId: matter.matter_id, runId: live.rid }, { document_version_id: doc.document_version_id, cards: [{ anchor_text: "买方应于验收合格后九十日内付款。", severity: "mid", category: "commercial", issue: "付款期限过长", suggestion: "改为三十日内付款" }] });
  const card = (await inv("riskcards.list", { matter_id: matter.matter_id })).cards[0];
  for (const ph of ["【当事人】", "【账号】", "【信用代码】", "【出生日期】"]) {
    await assert.rejects(
      inv("riskcards.decide", { matter_id: matter.matter_id, card_id: card.card_id, decision: "modify", final_text: `买方应于验收合格后三十日内向${ph}付款。` }),
      (e: any) => e.code === "validation" && e.message.includes(ph),
    );
  }
  assert.equal((await inv("riskcards.list", { matter_id: matter.matter_id })).cards[0].status, "proposed", "被拒后卡片不变");
  // 不是范本占位符的方括号照常保存（律师自己的写法）
  const ok = await inv("riskcards.decide", { matter_id: matter.matter_id, card_id: card.card_id, decision: "modify", final_text: "买方应于验收合格后三十日内向【丁贸易有限公司】付款。" });
  assert.equal(ok.card.status, "modified");
});
