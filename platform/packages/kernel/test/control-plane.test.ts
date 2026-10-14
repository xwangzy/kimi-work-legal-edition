/**
 * 内核接入控制面最小集（v9 阶段 6；第 02 篇 §7.1 #2–#5、§9.11、§10；第 04 篇 §5.2；第 06 篇 §1 G0“控制面最小集”）：
 * - 开通同步（经出站闸门代发，内核本身不联网）：设备登记、许可、租户盐、设备目录、律所策略（新租户为最严模板）、席位令牌；状态不含令牌；
 * - 放宽类律所策略由管理员在本机签名后才生效（自动档、抓取白名单追加）；
 * - 网关按控制面下发的事项匿名摘要做二次检查（收敛 D-20）：自报级别低于摘要、L3b 事项一律拒绝；
 * - 许可到期进入退出模式（新任务不可用，查看照常）；吊销其他设备同步到本机；席位吊销后清掉本机席位令牌。
 * 首次同步在 before 里完成，各用例自建所需事项，可单独运行（复核 S6-B14）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeKernel, runScenario, importText, type TestKernel } from "./helpers.ts";
import { startCloudCp, type CloudCp } from "./cloud-cp.ts";
import { SEAT_RENEW_BEFORE_MS } from "../src/control-plane/governance.ts";

const FIRM = "cp-firm";
const TID = `ten_${FIRM}`;
const FULL = { engagement: "confirmed", personal_info: "confirmed", sensitive: "not_applicable", subprocessor: "confirmed" };
let cloud: CloudCp;
let tk: TestKernel;
let firstStatus: any;
let firstReport: any;

before(async () => {
  cloud = await startCloudCp({ tenant: TID });
  tk = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream" }, FIRM);
  firstStatus = await tk.inv("control_plane.status");
  firstReport = await tk.inv("control_plane.sync");
});
after(async () => {
  await tk.kernel.close();
  await cloud.close();
});

test("开通同步：设备登记、许可、租户盐、目录、最严模板策略与席位令牌；状态不含令牌", { timeout: 60_000 }, async () => {
  assert.equal(firstStatus.mode, "control_plane");
  assert.equal(firstStatus.exit_mode?.code, "license_missing", "首次同步之前没有许可：新任务不可用");
  const r = firstReport;
  assert.equal(r.report.ok, true, JSON.stringify(r.report));
  const st = r.status;
  assert.equal(st.license.state, "valid");
  assert.equal(st.exit_mode, null);
  assert.equal(st.policy.source, "control_plane");
  assert.equal(st.policy.version, 1);
  assert.deepEqual(st.policy.relaxations, []);
  assert.equal(st.admin_threshold, 1, "团队版门限 1（开通时固定）");
  assert.equal(st.seat.has_token, true);
  // 离线窗口（复核 S6-A01）：同步后席位令牌剩余 ≥ 72 小时，且不在续期阈值内（控制面恰在此刻停机，推理与检索仍可用 72 小时以上）
  assert.ok(Date.parse(st.seat.expires_at) - Date.now() >= 72 * 3600_000, st.seat.expires_at);
  assert.ok(Date.parse(st.seat.expires_at) - Date.now() > SEAT_RENEW_BEFORE_MS);
  assert.equal(st.admin_threshold_pinned, true);
  assert.deepEqual(st.alerts, []);
  const t = cloud.cp.ops.tenant(TID)!;
  assert.ok(t.root_public_key_pem, "律所根公钥已入组");
  assert.ok(t.devices.has(`dev_${FIRM}_test-lawyer`), "本机设备已登记");
  const salt = tk.kernel.db.get<{ salt_b64: string }>(`SELECT salt_b64 FROM tenant_salts WHERE tenant_id = ? AND purpose = 'anon_matter'`, [TID])!;
  assert.equal(salt.salt_b64, t.salt_b64, "匿名事项编号用控制面下发的租户盐（同一律所各设备一致）");
  const seatDoc = tk.kernel.db.get<{ body_json: string }>(`SELECT body_json FROM cp_documents WHERE tenant_id = ? AND kind = 'seat'`, [TID])!;
  const token = (JSON.parse(seatDoc.body_json) as { token: string }).token;
  for (const view of [await tk.inv("control_plane.status"), await tk.inv("kernel.status")]) assert.ok(!JSON.stringify(view).includes(token), "界面接口不返回席位令牌");
});

test("放宽类律所策略：管理员在本机签名后才生效（自动档出现在档位选择；抓取白名单追加生效）", { timeout: 60_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "策略生效", stance: "原告", basis: FULL });
  const allowed0 = (await tk.inv("matters.get", { matter_id: matter.matter_id })).run_policy.allowed_modes;
  assert.ok(!allowed0.includes("auto"), "最严模板：没有自动档");
  const body = { max_mode: "auto", auto_preauthorizations: ["search_generalized"], fetch_allowlist_extra: ["regulator-example.cn"], l3a_standard_model: "deny" };
  const { draft } = await tk.inv("firm_policy.create_draft", { kind: "policy", body, ttl_days: 30 });
  assert.deepEqual(draft.relaxations, ["max_mode:auto", "auto_preauthorization:search_generalized", "fetch_allowlist:regulator-example.cn"], "签名前在本机如实列出放宽项");
  const signed = await tk.inv("firm_policy.sign", { draft_id: draft.draft_id, expected_digest: draft.digest });
  assert.equal(signed.draft.signed_by_me, true);
  const pub = await tk.inv("firm_policy.publish", { draft_id: draft.draft_id });
  assert.equal(pub.status.policy.version, 2);
  assert.equal(pub.status.policy.source, "control_plane");
  assert.deepEqual(pub.status.policy.signers, [`usr_${FIRM}_test-lawyer`]);
  const allowed1 = (await tk.inv("matters.get", { matter_id: matter.matter_id })).run_policy.allowed_modes;
  assert.ok(allowed1.includes("auto"), "管理员签名的放宽策略生效");
  assert.ok(tk.kernel.gate.fetchAllowlist.includes("regulator-example.cn"));
  // 复原为最严模板（收紧：同样走起草—签名—发布，本机接受）
  const strict = await tk.inv("firm_policy.create_draft", { kind: "policy", body: { max_mode: "default", auto_preauthorizations: [], fetch_allowlist_extra: [], l3a_standard_model: "deny" } });
  assert.deepEqual(strict.draft.relaxations, []);
  const pub2 = await tk.inv("firm_policy.publish", { draft_id: strict.draft.draft_id });
  assert.equal(pub2.status.policy.version, 3);
  assert.equal(pub2.report.steps.policy, "accepted");
  assert.ok(!(await tk.inv("matters.get", { matter_id: matter.matter_id })).run_policy.allowed_modes.includes("auto"));
});

test("网关二次检查：事项匿名摘要经控制面送达网关；自报级别低于摘要、L3b 事项一律拒绝（收敛 D-20）", { timeout: 120_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "摘要二次检查", stance: "出借人", basis: FULL, model_endpoint: "standard", key_dates: { analysis_as_of: "2026-10-01" } });
  const doc = await importText(tk.inv, matter.matter_id, "借款合同.txt", "借款合同（示例）\n借款人：甲科技有限公司。\n第三条 借款金额人民币伍万元，年利率 6%。");
  const { run } = await runScenario(tk.inv, matter.matter_id, "s1.contract_review", { document_version_ids: [doc.document_version_id] });
  assert.equal(run.status, "succeeded");
  const reserve = cloud.gatewayMeter.filter((m) => m.kind === "reserve").at(-1)!;
  assert.equal(reserve.reason, null, "网关已有该事项的摘要（不是按请求头兜底）");
  const anon = reserve.anonMatter!;
  await cloud.feed.refresh();
  assert.equal(cloud.feed.matter(TID, anon)?.level, "L2");

  // 同一事项改为当事人限制（L3b，私有端点）：摘要随策略变化上报
  await tk.inv("matters.update", { matter_id: matter.matter_id, patch: { confidentiality: "strict", model_endpoint: "private" } });
  await tk.inv("control_plane.sync");
  await cloud.feed.refresh();
  assert.equal(cloud.feed.matter(TID, anon)?.level, "L3b");
  // 误配置或旧客户端按旧属性（L2）直接请求网关：按摘要拒绝
  const seat = cloud.seatFor({ tid: TID, uid: `usr_${FIRM}_test-lawyer`, sid: `seat_${TID}_1`, dev: `dev_${FIRM}_test-lawyer` });
  const res = await fetch(`${cloud.gatewayUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${seat}`, "x-kwl-anon-matter": anon, "x-kwl-data-level": "L2", "content-type": "application/json" },
    body: JSON.stringify({ model: "legal/k3", messages: [{ role: "user", content: "测试" }] }),
  });
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, "data_level_mismatch");
});

test("吊销：控制面吊销同事设备 → 本机设备表同步吊销并推进纪元；吊销席位 → 清掉本机席位令牌", { timeout: 60_000 }, async () => {
  const { generateDeviceKeys, issueDeviceCertificate } = await import("@zr-legal/keys");
  const { getFirmRootPrivateKey, keysDirOf } = await import("../src/index.ts");
  const root = getFirmRootPrivateKey(keysDirOf(tk.kernel.config.workspaceDir));
  const k = generateDeviceKeys();
  const cert = issueDeviceCertificate(root.privateKeyPem, {
    certId: "cert_dev_colleague",
    memberId: `usr_${FIRM}_colleague`,
    deviceId: "dev_colleague",
    role: "lawyer",
    signPublicKeyPem: k.signPublicKeyPem,
    encPublicKeyPem: k.encPublicKeyPem,
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 365 * 86400_000).toISOString(),
  });
  assert.equal((await cloud.deviceCall(TID, { cert, signPrivateKeyPem: k.signPrivateKeyPem }, "POST", "/v1/devices/register", { tid: TID, cert })).status, 200);
  await tk.inv("control_plane.sync");
  const row = () => tk.kernel.db.get<{ status: string; enc_pub_pem: string }>(`SELECT status, enc_pub_pem FROM devices WHERE device_id = 'dev_colleague'`);
  assert.equal(row()?.status, "active", "目录中由本所律所根签发的同事设备进入本机设备表");
  assert.equal(row()?.enc_pub_pem, k.encPublicKeyPem);
  const epoch0 = (await tk.inv("devices.list")).tenant_epoch;
  cloud.cp.ops.revokeDevice(TID, "dev_colleague");
  await tk.inv("control_plane.sync");
  assert.equal(row()?.status, "revoked");
  assert.ok((await tk.inv("devices.list")).tenant_epoch > epoch0, "吊销推进租户纪元");
  // 吊销本机成员的席位：本机席位令牌清除（闸门不再发出模型与检索请求）
  cloud.cp.ops.revokeSeat(TID, `usr_${FIRM}_test-lawyer`);
  await tk.inv("control_plane.sync");
  assert.equal((await tk.inv("control_plane.status")).seat.has_token, false);
});

test("许可到期进入退出模式：新任务不可用，查看与列表照常；续期后恢复", { timeout: 60_000 }, async () => {
  const { matter: m } = await tk.inv("matters.create", { title: "退出模式", stance: "原告", basis: FULL });
  cloud.cp.ops.terminateLicense(TID);
  await new Promise((r) => setTimeout(r, 5));
  const rep = await tk.inv("control_plane.sync");
  assert.equal(rep.report.steps.license, "accepted");
  const st = await tk.inv("control_plane.status");
  assert.equal(st.exit_mode?.code, "license_expired");
  const { matters } = await tk.inv("matters.list");
  assert.ok(matters.some((x: { matter_id: string }) => x.matter_id === m.matter_id), "查看照常");
  // 退出模式下手动同步、转交节点、重试与签发同样不可用（复核 S6-A04、S6-B10）
  await assert.rejects(tk.inv("sync.export", { share_dir: tk.dir }), /许可已到期/);
  await assert.rejects(tk.inv("sync.import", { share_dir: tk.dir }), /许可已到期/);
  await assert.rejects(tk.inv("runs.node_enqueue", { matter_id: m.matter_id, scenario: "s6.redaction" }), /许可已到期/);
  await assert.rejects(tk.inv("runs.retry", { run_id: "run_none" }), /许可已到期/);
  await assert.rejects(tk.inv("review.approve", { artifact_version_id: "art_none", decision: "approved" }), /许可已到期/);
  const est = await tk.inv("runs.estimate", { matter_id: m.matter_id, scenario: "s6.redaction", document_version_ids: [] });
  assert.equal(est.data_where.start_blocked, true);
  assert.match(est.data_where.preview, /许可已到期/);
  await assert.rejects(tk.inv("runs.start", { matter_id: m.matter_id, estimate_id: est.estimate_id, idempotency_key: `exit-${Date.now()}` }), /许可已到期/);
  cloud.cp.ops.renewLicense(TID, 30);
  await new Promise((r) => setTimeout(r, 5));
  await tk.inv("control_plane.sync");
  assert.equal((await tk.inv("control_plane.status")).exit_mode, null);
});
