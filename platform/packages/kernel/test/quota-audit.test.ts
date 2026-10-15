/**
 * 第 9 批：内核接入额度账本（S3：本所用量与上限、管理员设月度上限）与中软侧操作记录（S14：取回、验签验链、本机留存、改写告警、导出）。
 * 请求经出站闸门代发（内核本身不联网）；网关额度走控制面租约（cloud-cp.ts）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUDIT_GENESIS, verifyAuditChain } from "@zr-legal/firm-trust";
import { makeKernel, type TestKernel } from "./helpers.ts";
import { startCloudCp, type CloudCp } from "./cloud-cp.ts";

const FIRM = "qa-firm";
const TID = `ten_${FIRM}`;
let cloud: CloudCp;
let tk: TestKernel;

before(async () => {
  cloud = await startCloudCp({ tenant: TID });
  tk = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream" }, FIRM);
  const r = await tk.inv("control_plane.sync");
  assert.equal(r.report.ok, true, JSON.stringify(r.report));
});
after(async () => {
  await tk.kernel.close();
  await cloud.close();
});

test("用量与上限：网关按租约结算并回报后，本所本月用量与按成员明细（成员名在本机换上）可见；管理员设月度上限经控制面生效", { timeout: 60_000 }, async () => {
  const s0 = await tk.inv("quota.status");
  assert.equal(s0.mode, "control_plane");
  assert.equal(s0.cap_monthly, null);
  assert.equal(s0.period_used, 0);
  // 模拟本所一次模型请求（直接打网关：内核的模型链路另有用例覆盖）
  const t = cloud.cp.ops.tenant(TID)!;
  const seat = t.seatsByUser.get(`usr_${FIRM}_test-lawyer`)!;
  const r = await fetch(`${cloud.gatewayUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cloud.seatFor({ tid: TID, uid: seat.uid, sid: seat.sid, dev: `dev_${FIRM}_test-lawyer` })}`, "x-kwl-anon-matter": "anon-qa-1", "x-kwl-data-level": "L2" },
    body: JSON.stringify({ model: "legal/k3", max_tokens: 50, messages: [{ role: "user", content: "示例" }] }),
  });
  assert.equal(r.status, 200);
  await r.text();
  await cloud.quota.flush();
  const s1 = await tk.inv("quota.status");
  assert.ok(s1.period_used > 0);
  assert.equal(s1.own.requests, 1);
  assert.equal(s1.by_member.length, 1);
  assert.equal(s1.by_member[0].member_id, `usr_${FIRM}_test-lawyer`);
  assert.ok(s1.by_member[0].name, "成员名由本机换上（控制面只有编号）");
  assert.equal(typeof s1.pool_remaining, "number");

  await assert.rejects(() => tk.inv("quota.set_cap", { monthly_cap: -1 }), (e: any) => e.code === "validation");
  assert.deepEqual(await tk.inv("quota.set_cap", { monthly_cap: 123_456 }), { cap_monthly: 123_456 });
  assert.equal(t.quota.cap_monthly, 123_456);
  assert.equal((await tk.inv("quota.status")).cap_monthly, 123_456);
  await tk.inv("quota.set_cap", { monthly_cap: null });
  assert.equal(t.quota.cap_monthly, null);
});

test("中软侧操作记录：取回后验签验链、本机留存（再取不重复）；云端改写已给出的历史即告警拒收、本机原记录不变；导出可自行验链", { timeout: 60_000 }, async () => {
  const a = await tk.inv("control_plane.audit");
  assert.equal(a.fetch_error, null);
  assert.ok(a.fetched.added > 0);
  const actions = a.records.map((r: any) => r.action);
  for (const x of ["tenant.create", "tenant.enroll_root", "device.register", "seat_token.issue"]) assert.ok(actions.includes(x), `${x} 在操作记录里`);
  const reg = a.records.find((r: any) => r.action === "device.register");
  assert.ok(reg.actor_name, "设备执行者在本机换成成员名");
  const again = await tk.inv("control_plane.audit");
  assert.equal(again.fetched.added, 0, "已留存的不重复入库");

  // 本机锚点与云端不一致（等价于云端改写了本机已取回的那一条）：拒收并告警，留存的记录不变
  const n = again.records.length;
  tk.kernel.db.run(`UPDATE cp_high_water SET digest = ? WHERE tenant_id = ? AND kind = 'cp_audit'`, ["f".repeat(64), TID]);
  const bad = await tk.inv("control_plane.audit");
  assert.equal(bad.fetch_error, "cp_audit_rewritten");
  assert.equal(bad.records.length, n);
  const st = await tk.inv("control_plane.status");
  assert.ok(st.alerts.some((x: any) => x.code === "cp_audit_rewritten"));

  const out = mkdtempSync(join(tmpdir(), "kwl-audit-export-"));
  const ex = await tk.inv("control_plane.audit_export", { save_path: join(out, "操作记录.json") });
  assert.equal(ex.saved, true);
  const doc = JSON.parse(readFileSync(join(out, ex.filename), "utf8"));
  assert.equal(doc.format, "kwl-cp-audit-export/1");
  assert.equal(doc.records.length, n);
  assert.deepEqual(verifyAuditChain(doc.records, TID, { seq: 0, hash: AUDIT_GENESIS }), { ok: true }, "导出的原记录收件人可自行验链");
  await assert.rejects(() => tk.inv("control_plane.audit_export", { save_path: join(tk.kernel.config.workspaceDir, "x.json") }), (e: any) => e.code === "validation");
});
