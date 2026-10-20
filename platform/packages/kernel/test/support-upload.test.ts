/**
 * 第 9 批 S13：诊断包上传给中软支持——律所策略未开启即拒绝；管理员签名开启后，律师预览后确认上传，
 * 上传的正是预览的那一份（中软侧收到的字节摘要等于预览摘要）；预览过期或摘要对不上即拒绝。请求经出站闸门（内核不联网）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { makeKernel, type TestKernel } from "./helpers.ts";
import { startCloudCp, type CloudCp } from "./cloud-cp.ts";

const FIRM = "sup-firm";
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

test("最严模板：预览可看但不允许上传；上传被拒、中软侧没有收到任何包", { timeout: 60_000 }, async () => {
  const p = await tk.inv("diagnostics.upload_preview");
  assert.equal(p.allowed, false);
  assert.equal(p.configured, true);
  assert.match(p.preview, /"format"/);
  await assert.rejects(() => tk.inv("diagnostics.upload", { file_sha256: p.file_sha256 }), (e: any) => e.code === "forbidden");
  assert.equal(cloud.support.access.filter((r) => r.action === "upload").length, 0);
});

test("管理员开启后：预览 → 确认上传，中软收到的字节就是预览的那一份；同一预览不能再传；伪造摘要拒绝", { timeout: 60_000 }, async () => {
  const body = { max_mode: "default", auto_preauthorizations: [], fetch_allowlist_extra: [], l3a_standard_model: "deny", support_upload: "allow" };
  const { draft } = await tk.inv("firm_policy.create_draft", { kind: "policy", body });
  assert.deepEqual(draft.relaxations, ["support_upload:allow"]);
  await tk.inv("firm_policy.sign", { draft_id: draft.draft_id, expected_digest: draft.digest });
  const pub = await tk.inv("firm_policy.publish", { draft_id: draft.draft_id });
  assert.equal(pub.status.policy.body.support_upload, "allow");
  await cloud.feed.refresh();
  const st = await tk.inv("kernel.status");
  assert.equal(st.egress_gate.support_configured, true);
  assert.equal(st.egress_gate.support_upload_allowed, true);

  const p = await tk.inv("diagnostics.upload_preview");
  assert.equal(p.allowed, true);
  await assert.rejects(() => tk.inv("diagnostics.upload", { file_sha256: "0".repeat(64) }), (e: any) => e.code === "validation");
  const r = await tk.inv("diagnostics.upload", { file_sha256: p.file_sha256 });
  assert.match(r.ticket, /^SUP-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  const dl = await fetch(`${cloud.support.base}/v1/support/ops/packages/${r.ticket}`, { headers: cloud.support.opsHeaders("GET", `/v1/support/ops/packages/${r.ticket}`) });
  assert.equal(dl.status, 200);
  const got = Buffer.from(await dl.arrayBuffer());
  assert.equal(createHash("sha256").update(got).digest("hex"), p.file_sha256, "中软收到的字节就是预览的那一份");
  assert.equal(JSON.parse(got.toString("utf8")).content_sha256, p.content_sha256);
  await assert.rejects(() => tk.inv("diagnostics.upload", { file_sha256: p.file_sha256 }), (e: any) => e.code === "validation", "同一预览只能上传一次");
  // 本机上传记录（复核 S9B-02）：发送前写进行中、完成后为已上传；审计记“尝试 + 结果”
  const ups = (await tk.inv("diagnostics.uploads")).uploads;
  assert.deepEqual(ups.map((u: any) => [u.status, u.ticket]), [["sent", r.ticket]]);
  const audits = tk.kernel.db.all<{ action: string }>(`SELECT action FROM audit_events WHERE action LIKE 'diagnostics.upload%' ORDER BY audit_event_id`);
  assert.deepEqual(audits.map((a) => a.action), ["diagnostics.upload_attempt", "diagnostics.upload_sent"]);
  // 支持服务收到的凭据是“只限支持服务”的短期凭据（复核 S9B-03）：同一张凭据在网关被拒
  assert.ok(cloud.support.access.some((x) => x.action === "upload" && x.result === "ok"));
});
