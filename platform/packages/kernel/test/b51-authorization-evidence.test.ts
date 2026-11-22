/**
 * 第 51 批（D-216）：客户授权依据逐案留痕——依据类型 + 可核对的出处（basis_ref）+ 记录时告知的 AI 次处理者清单版本（basis_notice_version）；
 * 设置里的开关降为“预填常用条款出处”（default_ref）；次处理者清单变更后按旧清单记录的事项须重新确认（consent，reconfirm）；
 * 律师本人的“首次使用 AI 数据去向告知”版本（ai_notice.get / ack）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeKernel, importText, type TestKernel } from "./helpers.ts";
import { AI_NOTICE_VERSION, AI_SUBPROCESSORS } from "../src/services/ai-authorization.ts";
import { kapMatterPolicy } from "../src/index.ts";
import { DEVICE_LOCAL_COLUMNS } from "../src/sync-engine.ts";

let tk: TestKernel;
const FULL = { engagement: "confirmed", personal_info: "confirmed", sensitive: "not_applicable", subprocessor: "confirmed" };
const PENDING = { engagement: "pending", personal_info: "pending", sensitive: "not_applicable", subprocessor: "pending" };
const REF = "委托代理合同（2026）沪律字第 123 号 第 9 条，2026-03-02 签订";

before(async () => {
  tk = await makeKernel({}, "b51-evidence-firm");
});

after(async () => {
  await tk.kernel.close();
});

const evidenceOf = (m: { basis_source: unknown; basis_ref: unknown; basis_notice_version: unknown }) => [m.basis_source, m.basis_ref, m.basis_notice_version];

test("常量与设置视图：次处理者清单随 ai_authorization.get 返回；新列团队同步与 basis_source 同口径（不在本机专属列）", async () => {
  assert.equal(AI_SUBPROCESSORS.version, "sp-2026-11");
  assert.deepEqual(AI_SUBPROCESSORS.items.map((i) => i.name), ["中软国际", "月之暗面"]);
  assert.equal(AI_NOTICE_VERSION, "notice-2026-11");
  const view = await tk.inv("ai_authorization.get", {});
  assert.deepEqual(view, { engagement_terms: false, default_ref: null, updated_at: null, subprocessors: AI_SUBPROCESSORS });
  for (const c of ["basis_source", "basis_ref", "basis_notice_version"]) assert.ok(!(DEVICE_LOCAL_COLUMNS.matters ?? []).includes(c), c);
});

test("按委托合同条款：无出处且无常用出处被拒；给出处被接受并写入出处与当前清单版本（去首尾空白）；列表与详情带出处与版本", async () => {
  const { inv } = tk;
  await assert.rejects(inv("matters.create", { title: "无出处", stance: "原告", basis: FULL, basis_source: "engagement_terms" }), /请写明授权依据的出处：委托合同名称或编号、条款号/);
  await assert.rejects(inv("matters.create", { title: "空白出处", stance: "原告", basis: FULL, basis_source: "engagement_terms", basis_ref: "   " }), /请写明授权依据的出处/);
  const { matter } = await inv("matters.create", { title: "有出处", stance: "原告", basis: FULL, basis_source: "engagement_terms", basis_ref: `  ${REF}  ` });
  assert.deepEqual(evidenceOf(matter), ["engagement_terms", REF, AI_SUBPROCESSORS.version]);
  assert.equal(matter.basis_reconfirm, false);
  const got = await inv("matters.get", { matter_id: matter.matter_id });
  assert.deepEqual(evidenceOf(got.matter), ["engagement_terms", REF, AI_SUBPROCESSORS.version]);
  const list = await inv("matters.list", {});
  const row = list.matters.find((m: { matter_id: string }) => m.matter_id === matter.matter_id);
  assert.deepEqual(evidenceOf(row), ["engagement_terms", REF, AI_SUBPROCESSORS.version]);
  // 委托/保密授权未确认：三列都不记
  const { matter: pending } = await inv("matters.create", { title: "未确认", stance: "原告", basis: PENDING, basis_source: "engagement_terms", basis_ref: REF });
  assert.deepEqual(evidenceOf(pending), [null, null, null]);
  // 审计摘要带来源类型（不带出处原文）
  const audits = tk.kernel.db.all<{ action: string }>(`SELECT action FROM audit_events WHERE action = 'matter.create' AND object_id = ?`, [matter.matter_id]);
  assert.equal(audits.length, 1);
});

test("常用出处（D-225 起内核不再自动套用，只在界面预填）：开关开且有 default_ref 时不给出处同样被拒；开关关时不预填；空串存 NULL；超长、空参数被拒；改动入审计", async () => {
  const { inv } = tk;
  await assert.rejects(inv("ai_authorization.set", {}), /engagement_terms 或 default_ref/);
  await assert.rejects(inv("ai_authorization.set", { default_ref: "条".repeat(201) }), /200/);
  await assert.rejects(inv("ai_authorization.set", { default_ref: 9 }), /文字/);
  const before = tk.kernel.db.all(`SELECT 1 FROM audit_events WHERE action = 'ai_authorization.set'`, []).length;
  // 只存常用出处、不开开关：不预填
  const refOnly = await inv("ai_authorization.set", { default_ref: "  本所标准委托合同 第 9 条  " });
  assert.equal(refOnly.engagement_terms, false);
  assert.equal(refOnly.default_ref, "本所标准委托合同 第 9 条");
  await assert.rejects(inv("matters.create", { title: "开关关", stance: "原告", basis: FULL, basis_source: "engagement_terms" }), /请写明授权依据的出处/);
  // 打开开关（只给开关不动常用出处）：D-225 起内核不替律师套用常用出处——不给出处仍被拒；给了出处以本次为准
  const on = await inv("ai_authorization.set", { engagement_terms: true });
  assert.equal(on.default_ref, "本所标准委托合同 第 9 条");
  await assert.rejects(inv("matters.create", { title: "预填", stance: "原告", basis: FULL, basis_source: "engagement_terms" }), /请写明授权依据的出处/);
  const { matter: own } = await inv("matters.create", { title: "本次出处", stance: "原告", basis: FULL, basis_source: "engagement_terms", basis_ref: REF });
  assert.equal(own.basis_ref, REF);
  // 常用出处清空（空串）存 NULL：再不给出处即被拒
  const cleared = await inv("ai_authorization.set", { default_ref: "" });
  assert.equal(cleared.default_ref, null);
  assert.equal(cleared.engagement_terms, true);
  await assert.rejects(inv("matters.create", { title: "清空后", stance: "原告", basis: FULL, basis_source: "engagement_terms" }), /请写明授权依据的出处/);
  const after = tk.kernel.db.all(`SELECT 1 FROM audit_events WHERE action = 'ai_authorization.set'`, []).length;
  assert.equal(after - before, 3);
  await inv("ai_authorization.set", { engagement_terms: false });
});

test("客户单独书面同意须有出处；出处超过 200 字被拒；逐项记录 confirmed 同样须有出处（D-225）、版本照写；只给出处不给类型被拒", async () => {
  const { inv } = tk;
  await assert.rejects(inv("matters.create", { title: "书面同意", stance: "原告", basis: FULL, basis_source: "separate_consent" }), /请写明客户书面同意的出处，例如日期与方式/);
  const { matter: sc } = await inv("matters.create", { title: "书面同意", stance: "原告", basis: FULL, basis_source: "separate_consent", basis_ref: "2026-11-18 客户邮件书面同意" });
  assert.deepEqual(evidenceOf(sc), ["separate_consent", "2026-11-18 客户邮件书面同意", AI_SUBPROCESSORS.version]);
  await assert.rejects(inv("matters.create", { title: "超长", stance: "原告", basis: FULL, basis_source: "separate_consent", basis_ref: "字".repeat(201) }), /至多 200 字/);
  await assert.rejects(inv("matters.update", { matter_id: sc.matter_id, patch: { basis: FULL, basis_source: "engagement_terms", basis_ref: "字".repeat(201) } }), /至多 200 字/);
  const ok200 = await inv("matters.update", { matter_id: sc.matter_id, patch: { basis: FULL, basis_source: "engagement_terms", basis_ref: "字".repeat(200) } });
  assert.equal(ok200.matter.basis_ref.length, 200);
  await assert.rejects(inv("matters.create", { title: "非法", stance: "原告", basis: FULL, basis_source: "lawyer_said_ok" }), /basis_source 须为 engagement_terms \/ separate_consent \/ confirmed/);
  await assert.rejects(inv("matters.create", { title: "旧值", stance: "原告", basis: FULL, basis_source: "confirmed" }), /逐项记录同样须写明授权依据的出处/);
  const { matter: legacy } = await inv("matters.create", { title: "旧值", stance: "原告", basis: FULL, basis_source: "confirmed", basis_ref: "委托合同 第 9 条" });
  assert.deepEqual(evidenceOf(legacy), ["confirmed", "委托合同 第 9 条", AI_SUBPROCESSORS.version]);
  // 只记录授权依据（不改四项）：按现有四项核；只给出处不给类型被拒
  const rec = await inv("matters.update", { matter_id: legacy.matter_id, patch: { basis_source: "separate_consent", basis_ref: "2026-11-19 客户回函" } });
  assert.deepEqual(evidenceOf(rec.matter), ["separate_consent", "2026-11-19 客户回函", AI_SUBPROCESSORS.version]);
  await assert.rejects(inv("matters.update", { matter_id: legacy.matter_id, patch: { basis_ref: "只给出处" } }), /basis_source/);
  await assert.rejects(inv("matters.update", { matter_id: legacy.matter_id, patch: { basis_source: "separate_consent" } }), /书面同意的出处/);
});

test("来源清为 NULL 的路径同时清空出处与版本：当事人拒绝、逐项编辑、清除拒绝、只改端点把某项改回待确认", async () => {
  const { inv } = tk;
  const rec = { basis: FULL, basis_source: "separate_consent", basis_ref: "2026-11-18 客户邮件书面同意" };
  const { matter } = await inv("matters.create", { title: "清空", stance: "原告", ...rec });
  assert.equal(matter.basis_ref, "2026-11-18 客户邮件书面同意");
  const refused = await inv("matters.update", { matter_id: matter.matter_id, patch: { consent_status: "refused" } });
  assert.deepEqual(evidenceOf(refused.matter), [null, null, null]);
  // 拒绝期间再给依据与出处：仍不记
  const both = await inv("matters.update", { matter_id: matter.matter_id, patch: { ...rec, consent_status: "refused" } });
  assert.deepEqual(evidenceOf(both.matter), [null, null, null]);
  // 清除拒绝：不带来源即为空
  const cleared = await inv("matters.update", { matter_id: matter.matter_id, patch: { consent_status: "pending" } });
  assert.deepEqual(evidenceOf(cleared.matter), [null, null, null]);
  // 重新记录后逐项编辑：清空
  const again = await inv("matters.update", { matter_id: matter.matter_id, patch: rec });
  assert.deepEqual(evidenceOf(again.matter), ["separate_consent", "2026-11-18 客户邮件书面同意", AI_SUBPROCESSORS.version]);
  const manual = await inv("matters.update", { matter_id: matter.matter_id, patch: { basis: FULL } });
  assert.deepEqual(evidenceOf(manual.matter), [null, null, null]);
  // 次处理者“不适用”（不使用模型）后改回标准端点：该项改回待确认，来源、出处、版本一并清空
  const { matter: none } = await inv("matters.create", { title: "端点", stance: "原告", model_endpoint: "none", basis: { ...FULL, subprocessor: "not_applicable" }, basis_source: "confirmed", basis_ref: "委托合同 第 9 条" });
  assert.deepEqual(evidenceOf(none), ["confirmed", "委托合同 第 9 条", AI_SUBPROCESSORS.version]);
  const reopened = await inv("matters.update", { matter_id: none.matter_id, patch: { model_endpoint: "standard" } });
  assert.equal(reopened.matter.basis.subprocessor, "pending");
  assert.deepEqual(evidenceOf(reopened.matter), [null, null, null]);
});

test("次处理者清单变更须重新确认：旧版本 → 估价 consent + reconfirm、发起被拒、宿主不放行；版本为空同样须重新确认（D-225）；按新清单重新记录即放开", { timeout: 60_000 }, async () => {
  const { inv } = tk;
  const { matter } = await inv("matters.create", { title: "清单变更", stance: "原告", basis: FULL, basis_source: "engagement_terms", basis_ref: REF });
  const doc = await importText(inv, matter.matter_id, "a.txt", "材料");
  const est = () => inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [doc.document_version_id] });
  const current = await est();
  assert.notEqual(current.data_where.block_kind, "consent");
  assert.equal(current.data_where.reconfirm, undefined);
  assert.equal(kapMatterPolicy(tk.kernel.db, matter.matter_id).basisComplete, true);

  tk.kernel.db.run(`UPDATE matters SET basis_notice_version = 'sp-2025-01' WHERE matter_id = ?`, [matter.matter_id]);
  const stale = await est();
  assert.equal(stale.data_where.start_blocked, true);
  assert.equal(stale.data_where.block_kind, "consent");
  assert.equal(stale.data_where.reconfirm, true);
  assert.match(stale.data_where.warning, /^四项依据须重新确认：AI 次处理者清单已更新/);
  assert.equal((await inv("matters.get", { matter_id: matter.matter_id })).matter.basis_reconfirm, true);
  assert.equal(kapMatterPolicy(tk.kernel.db, matter.matter_id).basisComplete, false, "宿主与闸门同一口径");
  await assert.rejects(
    inv("runs.start", { matter_id: matter.matter_id, estimate_id: stale.estimate_id, idempotency_key: `b51-${Date.now()}`, goal: "x" }),
    (e: { detail?: { block_kind?: string; reconfirm?: boolean } }) => e.detail?.block_kind === "consent" && e.detail?.reconfirm === true,
  );

  // 版本为空（有出处但没记清单版本）：D-225 起同样须按当前清单重新确认（不再静默放行）
  tk.kernel.db.run(`UPDATE matters SET basis_notice_version = NULL WHERE matter_id = ?`, [matter.matter_id]);
  const legacy = await est();
  assert.equal(legacy.data_where.block_kind, "consent");
  assert.equal(legacy.data_where.reconfirm, true);
  assert.equal(kapMatterPolicy(tk.kernel.db, matter.matter_id).basisComplete, false);

  // 按新清单重新记录（只记依据、不改四项）：版本写成当前、放开
  tk.kernel.db.run(`UPDATE matters SET basis_notice_version = 'sp-2025-01' WHERE matter_id = ?`, [matter.matter_id]);
  const before = tk.kernel.db.get<{ policy_version: number }>(`SELECT policy_version FROM matters WHERE matter_id = ?`, [matter.matter_id])!.policy_version;
  const rec = await inv("matters.update", { matter_id: matter.matter_id, patch: { basis_source: "engagement_terms", basis_ref: REF } });
  assert.equal(rec.matter.basis_notice_version, AI_SUBPROCESSORS.version);
  assert.equal(rec.matter.basis_reconfirm, false);
  const after = tk.kernel.db.get<{ policy_version: number }>(`SELECT policy_version FROM matters WHERE matter_id = ?`, [matter.matter_id])!.policy_version;
  assert.equal(after, before + 1, "只记依据同样算策略变更");
  const reopened = await est();
  assert.notEqual(reopened.data_where.block_kind, "consent");
});

test("首次使用 AI 的数据去向告知：缺省须确认；错版本被拒；确认后 needs_ack=false 并入审计；告知版本更新后须重新确认", async () => {
  const { inv } = tk;
  const initial = await inv("ai_notice.get", {});
  assert.equal(initial.version, AI_NOTICE_VERSION);
  assert.equal(initial.acked_version, null);
  assert.equal(initial.acked_at, null);
  assert.equal(initial.needs_ack, true);
  await assert.rejects(inv("ai_notice.ack", { version: "notice-2020-01" }), /告知已更新/);
  await assert.rejects(inv("ai_notice.ack", {}), /告知已更新/);
  const acked = await inv("ai_notice.ack", { version: AI_NOTICE_VERSION });
  assert.equal(acked.needs_ack, false);
  assert.equal(acked.acked_version, AI_NOTICE_VERSION);
  assert.ok(acked.acked_at);
  assert.equal(tk.kernel.db.all(`SELECT 1 FROM audit_events WHERE action = 'ai_notice.ack'`, []).length, 1);
  // 按律师本人存：模拟此前确认的是旧版告知
  tk.kernel.db.run(`UPDATE user_ai_notice SET version = 'notice-2026-01'`, []);
  const stale = await inv("ai_notice.get", {});
  assert.equal(stale.needs_ack, true);
  assert.equal(stale.acked_version, "notice-2026-01");
});

test("删除事项：授权依据的出处（合同编号、书面同意的日期与方式）随四项依据一并清除", async () => {
  const { inv } = tk;
  const title = "待删除的授权事项";
  const { matter } = await inv("matters.create", { title, stance: "原告", basis: FULL, basis_source: "engagement_terms", basis_ref: REF });
  await inv("matters.close", { matter_id: matter.matter_id, retention_years: 1 });
  await inv("matters.purge", { matter_id: matter.matter_id, confirm_title: title, early: true, reason: "测试删除" });
  const row = tk.kernel.db.get<{ basis: string | null; basis_ref: string | null }>(`SELECT basis, basis_ref FROM matters WHERE matter_id = ?`, [matter.matter_id])!;
  assert.deepEqual({ ...row }, { basis: null, basis_ref: null });
});
