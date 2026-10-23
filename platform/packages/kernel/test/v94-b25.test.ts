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

test("同一份文件才算新版本（走查发现）：别的任务的同类成果不再让前一份“已有更新版本”、不能签发；追问重出的才是新版；已签发的验签不因别的成果失效", async () => {
  const { inv, kernel } = tk;
  const { registerToolArtifact } = await import("../src/tools/tools/review.ts");
  const { docNameKey } = await import("../src/services/artifact-lineage.ts");
  assert.equal(docNameKey("草稿-2026-10-23.md"), "草稿.md");
  assert.equal(docNameKey("草稿-2026-10-24-部分完成.md"), "草稿.md");
  assert.equal(docNameKey("民事起诉状（草稿）.docx"), "民事起诉状（草稿）.docx");

  const { matter } = await inv("matters.create", { title: "成果版本", stance: "原告", consent_status: "agreed" });
  const reg = (rid: string, filename: string, kind = "agent_report") => {
    const stored = kernel.blobs.put(Buffer.from(`${filename}\n${randomUUID()}`, "utf8"), matter.matter_id);
    const ctx = { claims: { tid: kernel.identity.tenantId, mid: matter.matter_id, rid }, db: kernel.db, blobs: kernel.blobs } as any;
    const r = registerToolArtifact(ctx, { kind, filename, sha256: stored.sha256, storage_uri: stored.storage_uri, manifest: {} });
    kernel.db.run(`UPDATE artifact_versions SET status = 'pending_review' WHERE artifact_version_id = ?`, [r.artifact_version_id]);
    return { id: r.artifact_version_id, sha256: stored.sha256 };
  };
  const stale = (c: any) => c.blockers.some((b: string) => /已有更新版本/.test(b));
  const r1 = liveTaskIdentity(tk, matter.matter_id, "lin1");
  const pleading = reg(r1.rid, "民事起诉状（草稿）.md");
  const r2 = liveTaskIdentity(tk, matter.matter_id, "lin2");
  const catalog = reg(r2.rid, "证据目录（草稿）.md");
  // 第二个任务的证据目录不让起诉状变成旧版
  assert.equal(stale(await inv("review.completeness", { artifact_version_id: pleading.id })), false, "别的任务的同类成果不算新版本");
  // 追问（followup_of 指向第一次任务）重出起诉状：这才是新版
  const r3 = liveTaskIdentity(tk, matter.matter_id, "lin3");
  kernel.db.run(`UPDATE runs SET input_snapshot = ? WHERE run_id = ?`, [JSON.stringify({ goal: "把诉讼请求改一下", followup_of: r1.rid }), r3.rid]);
  const pleading2 = reg(r3.rid, "民事起诉状（草稿）.md");
  assert.equal(stale(await inv("review.completeness", { artifact_version_id: pleading.id })), true, "追问重出的是新版");
  await assert.rejects(inv("review.approve", { artifact_version_id: pleading.id, decision: "approved", expected_sha256: pleading.sha256, checklist: { reviewed_open_items: true } }), (e: any) => e.code === "approval_invalidated");
  assert.equal(stale(await inv("review.completeness", { artifact_version_id: pleading2.id })), false);
  // 签发证据目录，之后别的任务再出一份同类成果：验签照常有效
  const ok = await inv("review.approve", { artifact_version_id: catalog.id, decision: "approved", expected_sha256: catalog.sha256, checklist: { reviewed_open_items: true } });
  reg(liveTaskIdentity(tk, matter.matter_id, "lin4").rid, "律师函（草稿）.md");
  assert.equal((await inv("approvals.verify", { approval_id: ok.approval_id })).overall, "valid", "别的成果不让已签发的失效");
  // 交付件列表：第几版按同一份文件、is_latest
  const list = (await inv("artifacts.list", { matter_id: matter.matter_id })).artifacts as any[];
  const by = (id: string) => list.find((a) => a.artifact_version_id === id)!;
  assert.deepEqual([by(pleading.id).version, by(pleading.id).is_latest], [1, false]);
  assert.deepEqual([by(pleading2.id).version, by(pleading2.id).is_latest], [2, true]);
  assert.deepEqual([by(catalog.id).version, by(catalog.id).is_latest], [1, true]);
  assert.equal((await inv("review.completeness", { artifact_version_id: pleading2.id })).version, 2);
  // 任务页的成果同样按同一份文件编号
  assert.equal((await inv("runs.get", { run_id: r3.rid })).artifacts[0].version, 2);
  // 另起一个任务重新起草同名的起诉状：同一份文件的第 3 版
  const pleading3 = reg(liveTaskIdentity(tk, matter.matter_id, "lin5").rid, "民事起诉状（草稿）.md");
  assert.equal(stale(await inv("review.completeness", { artifact_version_id: pleading2.id })), true, "同名重出是新版");
  assert.equal((await inv("review.completeness", { artifact_version_id: pleading3.id })).version, 3);
  // 走查原样：两个任务的最终回复草稿都叫“草稿-日期.md”，不是同一份；同一追问链里的才是
  const q1 = liveTaskIdentity(tk, matter.matter_id, "rep1");
  const reply1 = reg(q1.rid, "草稿-2026-10-23.md", "a1_agent_draft");
  const reply2 = reg(liveTaskIdentity(tk, matter.matter_id, "rep2").rid, "草稿-2026-10-23.md", "a1_agent_draft");
  assert.equal(stale(await inv("review.completeness", { artifact_version_id: reply1.id })), false, "别的任务的回复草稿不算新版");
  const q3 = liveTaskIdentity(tk, matter.matter_id, "rep3");
  kernel.db.run(`UPDATE runs SET input_snapshot = ? WHERE run_id = ?`, [JSON.stringify({ goal: "再改一下", followup_of: q1.rid }), q3.rid]);
  reg(q3.rid, "草稿-2026-10-24-部分完成.md", "a1_agent_draft_partial");
  assert.equal(stale(await inv("review.completeness", { artifact_version_id: reply2.id })), false);
  // 部分完成的种类与完整回复不同，按种类各自编号；同种类的追问才互为新版
  const reply1b = reg(q3.rid, "草稿-2026-10-24.md", "a1_agent_draft");
  assert.equal(stale(await inv("review.completeness", { artifact_version_id: reply1.id })), true, "追问链里的回复草稿互为新版");
  assert.equal(stale(await inv("review.completeness", { artifact_version_id: reply1b.id })), false);
});

test("审查工作台导出的意见表按所审合同分开：审第二份合同不让第一份的意见表变成旧版", async () => {
  const { inv, kernel } = tk;
  const { matter } = await inv("matters.create", { title: "两份合同", stance: "买方", consent_status: "agreed" });
  const exportFor = async (name: string) => {
    const doc = await importText(inv, matter.matter_id, name, "第五条 付款\n买方应于验收合格后九十日内付款。");
    const live = liveTaskIdentity(tk, matter.matter_id, `x${name.length}`);
    submitRiskCards({ db: kernel.db, blobs: kernel.blobs }, { tenantId: live.tid, matterId: matter.matter_id, runId: live.rid }, { document_version_id: doc.document_version_id, cards: [{ anchor_text: "买方应于验收合格后九十日内付款。", severity: "mid", category: "commercial", issue: "付款期限过长", suggestion: "改为三十日" }] });
    return (await inv("riskcards.export_table", { matter_id: matter.matter_id, document_version_id: doc.document_version_id })).artifact_version_id as string;
  };
  const a = await exportFor("甲合同.txt");
  const b = await exportFor("乙合同（长名字）.txt");
  const rows = (await inv("artifacts.list", { matter_id: matter.matter_id })).artifacts as any[];
  assert.equal(rows.find((r) => r.artifact_version_id === a).is_latest, true, "第一份合同的意见表仍是最新");
  assert.equal(rows.find((r) => r.artifact_version_id === b).is_latest, true);
});

test("迁移 0066 回填：最终回复草稿按任务、其余任务产出按去掉日期的文件名、意见表按所审合同、审阅表导出按表；告知书照旧按种类；与新写入的算法一致", async () => {
  const { inv, kernel } = tk;
  const { readFileSync } = await import("node:fs");
  const { docNameKey } = await import("../src/services/artifact-lineage.ts");
  const { matter } = await inv("matters.create", { title: "回填", stance: "原告", consent_status: "agreed" });
  const live = liveTaskIdentity(tk, matter.matter_id, "bf");
  const rows: [string, string, string | null, Record<string, unknown>][] = [
    ["a1_agent_draft", "草稿-2026-10-23.md", live.rid, {}],
    ["a1_agent_draft_partial", "草稿-2026-10-23-部分完成.md", live.rid, {}],
    ["agent_report", "合同-2023版说明.docx", live.rid, {}],
    ["review_table", "采购合同（审查意见表）.xlsx", live.rid, { source_document_version_id: "docv_x" }],
    ["review_grid", "表（表格审阅）.xlsx", null, { table_id: "tbl_y" }],
    ["consent_notice", "告知书.md", null, {}],
  ];
  const ids = rows.map(([kind, filename, rid, manifest]) => {
    const id = `artv_${randomUUID()}`;
    kernel.db.run(
      `INSERT INTO artifact_versions (artifact_version_id, tenant_id, matter_id, run_id, kind, audience, version, filename, sha256, storage_uri, status, manifest, created_by, lineage)
       VALUES (?,?,?,?,?,'internal',?,?,?,?,'draft',?,?,NULL)`,
      [id, kernel.identity.tenantId, matter.matter_id, rid, kind, 900 + Math.floor(Math.random() * 1e6), filename, "0".repeat(64), "mem://x", JSON.stringify(manifest), kernel.identity.userId],
    );
    return id;
  });
  const sql = readFileSync(new URL("../src/migrations/0066_v94_artifact_lineage.sql", import.meta.url), "utf8");
  for (const stmt of sql.split(/;\s*\n/).map((x) => x.replace(/--[^\n]*\n/g, "").trim()).filter((x) => x.startsWith("UPDATE"))) kernel.db.run(`${stmt} AND artifact_version_id IN (${ids.map(() => "?").join(",")})`, ids);
  const lin = ids.map((id) => kernel.db.get<{ lineage: string | null }>(`SELECT lineage FROM artifact_versions WHERE artifact_version_id = ?`, [id])!.lineage);
  assert.equal(lin[0], `run:${live.rid}`);
  assert.equal(lin[1], `run:${live.rid}`);
  assert.equal(lin[2], `name:${docNameKey("合同-2023版说明.docx")}`);
  assert.equal(lin[3], "doc:docv_x");
  assert.equal(lin[4], "table:tbl_y");
  assert.equal(lin[5], null);
});

test("迁移 0066 回填：带日期的文件名去掉日期后与新写入的算法一致", async () => {
  const { inv, kernel } = tk;
  const { readFileSync } = await import("node:fs");
  const { docNameKey } = await import("../src/services/artifact-lineage.ts");
  const { matter } = await inv("matters.create", { title: "回填二", stance: "买方", consent_status: "agreed" });
  const live = liveTaskIdentity(tk, matter.matter_id, "bf2");
  const id = `artv_${randomUUID()}`;
  kernel.db.run(
    `INSERT INTO artifact_versions (artifact_version_id, tenant_id, matter_id, run_id, kind, audience, version, filename, sha256, storage_uri, status, manifest, created_by, lineage)
     VALUES (?,?,?,?,'s1_opinion','internal',7,'协议（审查意见书）-2026-10-23.docx',?,?,'draft','{}',?,NULL)`,
    [id, kernel.identity.tenantId, matter.matter_id, live.rid, "0".repeat(64), "mem://x", kernel.identity.userId],
  );
  const sql = readFileSync(new URL("../src/migrations/0066_v94_artifact_lineage.sql", import.meta.url), "utf8");
  for (const stmt of sql.split(/;\s*\n/).map((x) => x.replace(/--[^\n]*\n/g, "").trim()).filter((x) => x.startsWith("UPDATE"))) kernel.db.run(`${stmt} AND artifact_version_id = ?`, [id]);
  assert.equal(kernel.db.get<{ lineage: string }>(`SELECT lineage FROM artifact_versions WHERE artifact_version_id = ?`, [id])!.lineage, `name:${docNameKey("协议（审查意见书）-2026-10-23.docx")}`);
});

test("签发记录显示不确认论点就签发的理由（走查：理由记下了却没处显示）", async () => {
  const { inv, kernel } = tk;
  const { matter } = await inv("matters.create", { title: "理由显示", stance: "原告", consent_status: "agreed" });
  const bytes = Buffer.from(`民事起诉状（草稿）\n诉讼请求：判令被告支付货款。${randomUUID()}`, "utf8");
  const { sha256, storage_uri } = kernel.blobs.put(bytes, matter.matter_id);
  const id = `artv_${randomUUID()}`;
  kernel.db.run(
    `INSERT INTO artifact_versions (artifact_version_id, tenant_id, matter_id, run_id, kind, audience, version, filename, sha256, storage_uri, status, open_items, created_by)
     VALUES (?,?,?,NULL,'b25_reason','internal',1,'起诉状.md',?,?,'pending_review',?,?)`,
    [id, kernel.identity.tenantId, matter.matter_id, sha256, storage_uri, JSON.stringify([{ kind: "outline_unconfirmed" }]), kernel.identity.userId],
  );
  assert.equal((await inv("review.completeness", { artifact_version_id: id })).approved_by, null);
  await inv("review.approve", { artifact_version_id: id, decision: "approved", expected_sha256: sha256, checklist: { reviewed_open_items: true, outline_unconfirmed_reason: "论点已在电话里与合伙人核过" } });
  assert.equal((await inv("review.completeness", { artifact_version_id: id })).approved_by.outline_unconfirmed_reason, "论点已在电话里与合伙人核过");
});
