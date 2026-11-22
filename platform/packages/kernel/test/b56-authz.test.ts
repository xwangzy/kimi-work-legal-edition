/**
 * D-225：客户授权五个缺口——
 *  ① “逐项记录四项依据”不写出处即放行的绕过：四个强制点（闸门模型推理 / 联网检索 / 网页抓取、kap-host 事项运行策略、网关二次检查摘要、
 *     内核估价与发起）同一函数判“未授权”；
 *  ② 有出处但次处理者清单版本旧 → 须重新确认；
 *  ③ 旧数据（D-216 之前确认、没有出处）读时判“待补记”，走重新确认卡、补记一次即放开（不新增迁移）；
 *  ④ 内核不再替律师套用常用出处（开关只在界面预填）；
 *  ⑤ 授权记录追加不覆盖、明文可读、进归档 manifest；
 *  ⑥ 问答不带材料：带事项或材料的问答请求一律拒收。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { parsePublicKeyMap } from "@zr-legal/firm-trust";
import { screenSearchQuery } from "@zr-legal/egress-gate";
import { MatterTokenizer } from "@zr-legal/tokenizer";
import { makeKernel, importText, liveTaskIdentity, type TestKernel } from "./helpers.ts";
import { FirmGovernance, getFirmRootPrivateKey, kapMatterPolicy, keysDirOf } from "../src/index.ts";
import { aiAuthorizedOf, authorizationStateOf, createGateAuthorizer } from "../src/egress/gate-host.ts";
import { AI_SUBPROCESSORS, AUTHORIZATION_AUDIT_ACTION, NEEDS_REF_REASON } from "../src/services/ai-authorization.ts";
import { buildMatterArchive } from "../src/services/matter-archive.ts";
import { mintTaskToken, taskTokenKey } from "../src/identity.ts";

let tk: TestKernel;
const FULL = { engagement: "confirmed", personal_info: "confirmed", sensitive: "not_applicable", subprocessor: "confirmed" };
const PENDING = { engagement: "pending", personal_info: "pending", sensitive: "not_applicable", subprocessor: "pending" };
const REF = "委托代理合同（2026）沪律字第 123 号 第 12 条";

before(async () => {
  tk = await makeKernel({}, "b56-authz-firm");
});
after(async () => {
  await tk.kernel.close();
});

/** 闸门授权回调（与内核拉起闸门时同一份 createGateAuthorizer）。 */
function gateAuthorize(matterId: string, purpose: "model" | "search" | "fetch") {
  const authorize = createGateAuthorizer({
    db: tk.kernel.db,
    secret: taskTokenKey(),
    revoked: { rids: new Set(), jtis: new Set() },
    anonSalt: () => Buffer.alloc(32, 1),
    tokenizerContext: () => ({ keyB64: randomBytes(32).toString("base64"), parties: [], table: [], fullPseudonym: false, tableVersion: 0 }),
    fetchAllowlist: () => [],
    l3aStandardAllowed: () => false,
  });
  const live = liveTaskIdentity(tk, matterId, `authz${purpose}`);
  const token = mintTaskToken({ tid: live.tid, uid: live.uid, mid: live.mid, rid: live.rid, aid: live.aid, fen: live.fence, scope: ["model:chat", "egress:search", "egress:fetch"] }, 300);
  const r = authorize({ token, matterId, purpose });
  // 种下的执行中任务用完即结束（否则估价按“事项里另有进行中的任务”拦下）
  tk.kernel.db.run(`UPDATE attempts SET status = 'cancelled' WHERE attempt_id = ?`, [live.aid]);
  tk.kernel.db.run(`UPDATE runs SET status = 'cancelled' WHERE run_id = ?`, [live.rid]);
  assert.ok(r.ok, `闸门授权回调应给出上下文（${purpose}）`);
  return r.ctx;
}

/** 网关二次检查摘要（与内核里的 FirmGovernance 同一个类；开发形态）。 */
function summaryOf(matterId: string) {
  const g = new FirmGovernance({
    db: tk.kernel.db,
    tenantId: tk.kernel.identity.tenantId,
    userId: tk.kernel.identity.userId,
    deviceId: tk.kernel.db.get<{ device_id: string }>(`SELECT device_id FROM devices ORDER BY created_at LIMIT 1`, [])!.device_id,
    rootPublicKeyPem: getFirmRootPrivateKey(keysDirOf(tk.kernel.config.workspaceDir)).publicKeyPem,
    signer: tk.kernel.signer,
    env: {},
    controlPlaneBase: null,
    cpKeys: parsePublicKeyMap(""),
    seatKeys: parsePublicKeyMap(""),
  });
  return g.summaryOf(matterId)!;
}

async function estimate(matterId: string) {
  const doc = await importText(tk.inv, matterId, "a.txt", "材料");
  return tk.inv("runs.estimate", { matter_id: matterId, scenario: "a1.agent_task", document_version_ids: [doc.document_version_id] });
}

/** 四个强制点各自的判定：闸门三条出站（模型、检索、抓取）、kap-host、网关摘要、内核估价。 */
async function enforcement(matterId: string) {
  const model = gateAuthorize(matterId, "model");
  const search = gateAuthorize(matterId, "search");
  const fetch = gateAuthorize(matterId, "fetch");
  const verdict = screenSearchQuery("民间借贷 利率上限", { dataLevel: search.dataLevel, basisComplete: search.basisComplete, preauthorizedGeneralize: false, tokenizer: new MatterTokenizer({ matterKey: randomBytes(32) }) });
  const est = await estimate(matterId);
  return {
    model: model.basisComplete,
    search: verdict.decision === "deny" ? verdict.reason : verdict.decision,
    fetch: fetch.basisComplete,
    kap: kapMatterPolicy(tk.kernel.db, matterId).basisComplete,
    summary: summaryOf(matterId).basis_complete,
    estimate: est.data_where,
  };
}

test("①逐项四项全确认但不写出处：模型出站、检索、抓取、kap-host、网关摘要、发起估价都判未授权；补记出处后全部放开", { timeout: 60_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "逐项绕过", stance: "原告", basis: PENDING });
  // 绕过路径：只交四项、不带依据类型与出处（第 51 批“改为逐项记录四项依据”）
  const upd = await tk.inv("matters.update", { matter_id: matter.matter_id, patch: { basis: FULL } });
  assert.equal(upd.matter.basis_complete, true, "四项齐备");
  assert.equal(upd.matter.basis_state, "needs_ref");
  assert.equal(upd.matter.basis_reconfirm, true);
  const e = await enforcement(matter.matter_id);
  assert.equal(e.model, false, "模型出站");
  assert.equal(e.search, "basis_pending_no_egress", "联网检索");
  assert.equal(e.fetch, false, "网页抓取");
  assert.equal(e.kap, false, "kap-host 事项运行策略");
  assert.equal(e.summary, false, "网关二次检查摘要");
  assert.equal(e.estimate.start_blocked, true, "发起估价");
  assert.equal(e.estimate.block_kind, "consent");
  assert.equal(e.estimate.reconfirm, true);
  assert.equal(e.estimate.needs_ref, true);
  // 发起时复核同样拒绝
  const est = await estimate(matter.matter_id);
  await assert.rejects(
    tk.inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `b56a-${Date.now()}`, goal: "x" }),
    (err: { message?: string; detail?: { block_kind?: string; needs_ref?: boolean } }) => err.detail?.block_kind === "consent" && err.detail?.needs_ref === true && String(err.message).startsWith(NEEDS_REF_REASON),
  );
  // 逐项记录同样须写出处：带类型不带出处被拒；带出处即记版本并放开
  await assert.rejects(tk.inv("matters.update", { matter_id: matter.matter_id, patch: { basis: FULL, basis_source: "confirmed" } }), /逐项记录同样须写明授权依据的出处/);
  const ok = await tk.inv("matters.update", { matter_id: matter.matter_id, patch: { basis: FULL, basis_source: "confirmed", basis_ref: REF } });
  assert.equal(ok.matter.basis_state, "valid");
  assert.equal(ok.matter.basis_notice_version, AI_SUBPROCESSORS.version);
  const after = await enforcement(matter.matter_id);
  assert.deepEqual([after.model, after.search, after.fetch, after.kap, after.summary, after.estimate.block_kind ?? null], [true, "pass", true, true, true, null]);
});

test("②有出处但次处理者清单版本旧：四个强制点都要求重新确认（不是“待补记”）", { timeout: 60_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "清单旧", stance: "原告", basis: FULL, basis_source: "engagement_terms", basis_ref: REF });
  tk.kernel.db.run(`UPDATE matters SET basis_notice_version = 'sp-2025-01' WHERE matter_id = ?`, [matter.matter_id]);
  const got = await tk.inv("matters.get", { matter_id: matter.matter_id });
  assert.equal(got.matter.basis_state, "reconfirm");
  const e = await enforcement(matter.matter_id);
  assert.deepEqual([e.model, e.search, e.fetch, e.kap, e.summary], [false, "basis_pending_no_egress", false, false, false]);
  assert.equal(e.estimate.block_kind, "consent");
  assert.equal(e.estimate.reconfirm, true);
  assert.equal(e.estimate.needs_ref, undefined, "这是重新确认，不是补记");
  assert.match(e.estimate.warning, /次处理者清单已更新/);
});

test("③旧数据（D-216 之前确认、没有出处与版本）：读时判“待补记”，补记一次即放开；当事人拒绝 + 私有端点、无四项 JSON 的最早期事项沿用原口径", { timeout: 60_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "第 48 批旧事项", stance: "原告", basis: PENDING });
  // 模拟第 48 批：按律师设置记了 engagement_terms，没有出处，也没有版本
  tk.kernel.db.run(`UPDATE matters SET basis = ?, consent_status = 'agreed', basis_source = 'engagement_terms', basis_ref = NULL, basis_notice_version = NULL WHERE matter_id = ?`, [JSON.stringify(FULL), matter.matter_id]);
  const list = await tk.inv("matters.list", {});
  const row = list.matters.find((m: { matter_id: string }) => m.matter_id === matter.matter_id);
  assert.equal(row.basis_state, "needs_ref");
  assert.equal(row.basis_complete, true, "四项仍是齐备的（事项照常可用本机功能，不是“尚未记录”）");
  const e = await enforcement(matter.matter_id);
  assert.deepEqual([e.model, e.search, e.fetch, e.kap, e.summary], [false, "basis_pending_no_egress", false, false, false]);
  assert.equal(e.estimate.needs_ref, true);
  // 补记（只记依据、不改四项）：放开
  const rec = await tk.inv("matters.update", { matter_id: matter.matter_id, patch: { basis_source: "engagement_terms", basis_ref: REF } });
  assert.equal(rec.matter.basis_state, "valid");
  assert.equal((await enforcement(matter.matter_id)).model, true);
  // 例外沿用原口径
  assert.equal(authorizationStateOf({ basis: null, consent_status: "agreed" }), "valid", "没有四项 JSON 的最早期事项");
  assert.equal(aiAuthorizedOf({ basis: JSON.stringify(FULL), consent_status: "refused", model_endpoint: "private" }), true, "拒绝云端、只用律所私有端点");
  assert.equal(aiAuthorizedOf({ basis: JSON.stringify(FULL), consent_status: "refused", model_endpoint: "standard" }), false);
  assert.equal(aiAuthorizedOf({ basis: JSON.stringify(FULL), consent_status: "agreed", model_endpoint: "none", basis_source: "engagement_terms", basis_ref: REF, basis_notice_version: AI_SUBPROCESSORS.version }), false, "不使用模型");
});

test("④内核不再替律师套用常用出处：开关开、存了常用出处，不给出处仍被拒；给了出处以本次为准", async () => {
  await tk.inv("ai_authorization.set", { engagement_terms: true, default_ref: "本所标准委托合同 第 9 条" });
  await assert.rejects(tk.inv("matters.create", { title: "不给出处", stance: "原告", basis: FULL, basis_source: "engagement_terms" }), /请写明授权依据的出处/);
  const { matter } = await tk.inv("matters.create", { title: "只记依据", stance: "原告", basis: PENDING });
  await tk.inv("matters.update", { matter_id: matter.matter_id, patch: { basis: FULL } });
  await assert.rejects(tk.inv("matters.update", { matter_id: matter.matter_id, patch: { basis_source: "engagement_terms" } }), /请写明授权依据的出处/);
  const got = await tk.inv("matters.get", { matter_id: matter.matter_id });
  assert.equal(got.matter.basis_ref, null, "没有被常用出处静默填上");
  assert.equal(got.matter.basis_state, "needs_ref");
  await tk.inv("ai_authorization.set", { engagement_terms: false, default_ref: "" });
});

test("⑤授权记录：每次记录追加一条明文审计（不覆盖），matters.get 带历史与记录人，归档 manifest 带当前值与历史", async () => {
  const { matter } = await tk.inv("matters.create", { title: "留痕", stance: "原告", basis: FULL, basis_source: "engagement_terms", basis_ref: REF });
  await tk.inv("matters.update", { matter_id: matter.matter_id, patch: { basis_source: "separate_consent", basis_ref: "2026-11-22 客户邮件书面同意" } });
  const rows = tk.kernel.db.all<{ detail_hash: string }>(`SELECT detail_hash FROM audit_events WHERE action = ? AND object_id = ? ORDER BY audit_event_id`, [AUTHORIZATION_AUDIT_ACTION, matter.matter_id]);
  assert.equal(rows.length, 2, "追加，不覆盖");
  const first = JSON.parse(rows[0]!.detail_hash);
  assert.equal(first.basis_ref, REF, "出处明文可读");
  assert.equal(first.basis_source, "engagement_terms");
  assert.equal(first.basis_notice_version, AI_SUBPROCESSORS.version);
  // 审计行入签名链
  const signed = tk.kernel.db.all(`SELECT 1 FROM signed_events WHERE kind = 'audit_event' AND type = ? AND matter_id = ?`, [AUTHORIZATION_AUDIT_ACTION, matter.matter_id]);
  assert.equal(signed.length, 2);
  const got = await tk.inv("matters.get", { matter_id: matter.matter_id });
  assert.equal(got.matter.authorization_history.length, 2);
  assert.equal(got.matter.authorization_history[0].basis_ref, "2026-11-22 客户邮件书面同意", "新的在前");
  assert.equal(got.matter.authorization_history[1].basis_ref, REF, "旧记录仍在");
  assert.ok(got.matter.basis_recorded_at);
  const list = await tk.inv("matters.list", {});
  assert.ok(list.matters.find((m: { matter_id: string }) => m.matter_id === matter.matter_id).basis_recorded_at);
  const arch = await tk.inv("matters.archive", { matter_id: matter.matter_id });
  assert.ok(arch.data_base64);
  // 直接构造归档（与接口同一函数），核对 manifest
  const { manifest } = buildMatterArchive(
    { db: tk.kernel.db, blobs: (tk.kernel as any).blobs ?? { read: () => Buffer.alloc(0) }, deviceId: "dev", signer: { signSync: () => "sig" } as any, deviceCert: {} as any, firmRootPublicKeyPem: "" },
    matter.matter_id,
    { by: "test" },
  );
  assert.equal(manifest.authorization.basis_ref, "2026-11-22 客户邮件书面同意");
  assert.equal(manifest.authorization.state, "valid");
  assert.deepEqual(manifest.authorization.history.map((h) => h.basis_ref), ["2026-11-22 客户邮件书面同意", REF]);
});

test("⑥问答不绑定事项、不带材料：带事项或材料的请求一律拒收", async () => {
  const { matter } = await tk.inv("matters.create", { title: "问答口子", stance: "原告", basis: PENDING });
  const doc = await importText(tk.inv, matter.matter_id, "b.txt", "案件材料");
  for (const extra of [{ matter_id: matter.matter_id }, { document_version_ids: [doc.document_version_id] }, { attachments: [{ name: "x.txt" }] }]) {
    await assert.rejects(tk.inv("chat.send", { text: "这份合同有效吗？", ...extra }), /问答只用于一般法律问题，不带案件材料/);
  }
});
