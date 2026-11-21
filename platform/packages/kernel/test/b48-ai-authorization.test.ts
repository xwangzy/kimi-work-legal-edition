/**
 * 第 48 批（D-202）：客户授权前移——律师本人的默认设置（委托合同含 AI 辅助条款）、四项依据的记录方式（basis_source）、
 * （第 51 批 D-216 起：按委托合同条款记录须逐案写明出处，开关只用于预填常用出处——见 b51-authorization-evidence.test.ts）
 * 阻断原因分类（只有“四项依据待确认”能靠记录授权解决：consent；L3b、不使用模型、席位失效等是 policy）。
 * 闸门、宿主、网关按四项依据的判定口径不变（由既有 egress / w1 用例覆盖）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeKernel, importText, type TestKernel } from "./helpers.ts";

let tk: TestKernel;
const FULL = { engagement: "confirmed", personal_info: "confirmed", sensitive: "not_applicable", subprocessor: "confirmed" };
const PENDING = { engagement: "pending", personal_info: "pending", sensitive: "not_applicable", subprocessor: "pending" };

before(async () => {
  tk = await makeKernel({}, "b48-authz-firm");
});

after(async () => {
  await tk.kernel.close();
});

test("默认设置：缺省关闭；按委托合同条款记录须有出处（失败关闭，第 51 批 D-216：开关只用于预填常用出处）；开关与撤回入审计；撤回不改写已建事项", async () => {
  const { inv } = tk;
  const initial = await inv("ai_authorization.get", {});
  assert.equal(initial.engagement_terms, false);
  assert.equal(initial.default_ref, null);
  assert.equal(initial.updated_at, null);
  // 没有出处、也没有可预填的常用出处：不能凭界面一句话就记成“按委托合同”
  await assert.rejects(inv("matters.create", { title: "未声明", stance: "原告", basis: FULL, basis_source: "engagement_terms" }), /请写明授权依据的出处/);
  await assert.rejects(inv("ai_authorization.set", { engagement_terms: "yes" }), /布尔/);
  const on = await inv("ai_authorization.set", { engagement_terms: true });
  assert.equal(on.engagement_terms, true);
  assert.ok(on.updated_at);
  // 开关打开但没存常用出处：仍须逐案写明出处（开关本身不再替事项记录）
  await assert.rejects(inv("matters.create", { title: "只开开关", stance: "原告", basis: FULL, basis_source: "engagement_terms" }), /请写明授权依据的出处/);
  const { matter } = await inv("matters.create", { title: "按委托合同", stance: "原告", basis: FULL, basis_source: "engagement_terms", basis_ref: "委托代理合同 第 9 条" });
  assert.equal(matter.basis_source, "engagement_terms");
  assert.equal(matter.consent_status, "agreed");
  assert.equal(matter.basis_complete, true);
  // 撤回只影响之后新建的事项
  await inv("ai_authorization.set", { engagement_terms: false });
  const again = await inv("matters.get", { matter_id: matter.matter_id });
  assert.equal(again.matter.basis_source, "engagement_terms");
  await assert.rejects(inv("matters.create", { title: "撤回后", stance: "原告", basis: FULL, basis_source: "engagement_terms" }), /请写明授权依据的出处/);
  // 审计：打开与撤回各一条
  const rows = tk.kernel.db.all<{ action: string }>(`SELECT action FROM audit_events WHERE action = 'ai_authorization.set'`, []);
  assert.equal(rows.length, 2);
});

test("记录方式：委托/保密授权未确认时不记；非法值拒绝；逐项编辑（不带 basis_source）清为 NULL；律师确认记 confirmed", async () => {
  const { inv } = tk;
  await assert.rejects(inv("matters.create", { title: "非法", stance: "原告", basis: FULL, basis_source: "client_said_ok" }), /basis_source/);
  const { matter: pending } = await inv("matters.create", { title: "待确认", stance: "原告", basis: PENDING, basis_source: "confirmed" });
  assert.equal(pending.basis_source, null, "委托/保密授权未确认时记录方式无意义");
  const upd = await inv("matters.update", { matter_id: pending.matter_id, patch: { basis: FULL, basis_source: "confirmed" } });
  assert.equal(upd.matter.basis_source, "confirmed");
  assert.equal(upd.matter.basis_complete, true);
  const manual = await inv("matters.update", { matter_id: pending.matter_id, patch: { basis: FULL } });
  assert.equal(manual.matter.basis_source, null, "逐项编辑");
  const list = await inv("matters.list", {});
  assert.ok(list.matters.some((m: { matter_id: string; basis_source?: unknown }) => m.matter_id === pending.matter_id && "basis_source" in m));
});

test("阻断分类：依据待确认 = consent；当事人限制（L3b）、不使用模型 = policy；runs.start 拒绝时同样带类别", { timeout: 60_000 }, async () => {
  const { inv } = tk;
  const est = async (matterId: string) => {
    const doc = await importText(inv, matterId, "a.txt", "材料");
    return inv("runs.estimate", { matter_id: matterId, scenario: "a1.agent_task", document_version_ids: [doc.document_version_id] });
  };
  const { matter: pending } = await inv("matters.create", { title: "待确认", stance: "原告", basis: PENDING });
  const e1 = await est(pending.matter_id);
  assert.equal(e1.data_where.start_blocked, true);
  assert.equal(e1.data_where.block_kind, "consent");
  // 当事人限制（L3b）：四项也待确认，但第一个命中的原因是 L3b——记录授权解决不了
  const { matter: strict } = await inv("matters.create", { title: "不上云", stance: "被告", confidentiality: "strict", basis: PENDING });
  const e2 = await est(strict.matter_id);
  assert.equal(e2.data_where.block_kind, "policy");
  const { matter: none } = await inv("matters.create", { title: "不用模型", stance: "被告", model_endpoint: "none", basis: { ...FULL, subprocessor: "not_applicable" } });
  const e3 = await est(none.matter_id);
  assert.equal(e3.data_where.block_kind, "policy");
  // 发起时复核：拒绝的 detail 里带类别（界面据此不再把 L3b 当成“去记录同意”）
  await assert.rejects(
    inv("runs.start", { matter_id: pending.matter_id, estimate_id: e1.estimate_id, idempotency_key: `b48-${Date.now()}`, goal: "x" }),
    (e: { detail?: { block_kind?: string; start_blocked?: boolean } }) => e.detail?.start_blocked === true && e.detail?.block_kind === "consent",
  );
  await assert.rejects(
    inv("runs.start", { matter_id: strict.matter_id, estimate_id: e2.estimate_id, idempotency_key: `b48s-${Date.now()}`, goal: "x" }),
    (e: { detail?: { block_kind?: string } }) => e.detail?.block_kind === "policy",
  );
});

test("记录方式与当事人拒绝一致（复核第 48 批 #2）：记为拒绝即清空；清除拒绝不带回旧来源；只改端点把某项改回待确认也清空", async () => {
  const { inv } = tk;
  const { matter } = await inv("matters.create", { title: "拒绝一致", stance: "原告", basis: FULL, basis_source: "confirmed" });
  assert.equal(matter.basis_source, "confirmed");
  const refused = await inv("matters.update", { matter_id: matter.matter_id, patch: { consent_status: "refused" } });
  assert.equal(refused.matter.consent_status, "refused");
  assert.equal(refused.matter.basis_source, null);
  // 同时给四项与来源、又记为拒绝：来源仍为空
  const both = await inv("matters.update", { matter_id: matter.matter_id, patch: { basis: FULL, basis_source: "confirmed", consent_status: "refused" } });
  assert.equal(both.matter.basis_source, null);
  // 清除拒绝：不带来源即为空（须重新记录）；带了按规则重核
  const cleared = await inv("matters.update", { matter_id: matter.matter_id, patch: { consent_status: "pending" } });
  assert.equal(cleared.matter.consent_status, "agreed");
  assert.equal(cleared.matter.basis_source, null);
  const reconfirmed = await inv("matters.update", { matter_id: matter.matter_id, patch: { basis: FULL, basis_source: "confirmed" } });
  assert.equal(reconfirmed.matter.basis_source, "confirmed");
  // 次处理者“不适用”（不使用模型）后改回标准端点：该项自动改回待确认，来源清空
  const { matter: none } = await inv("matters.create", { title: "端点", stance: "原告", model_endpoint: "none", basis: { ...FULL, subprocessor: "not_applicable" }, basis_source: "confirmed" });
  assert.equal(none.basis_source, "confirmed");
  const reopened = await inv("matters.update", { matter_id: none.matter_id, patch: { model_endpoint: "standard" } });
  assert.equal(reopened.matter.basis.subprocessor, "pending");
  assert.equal(reopened.matter.basis_source, null);
});
