/**
 * 阶段 6 复核处置的失败关闭证据（复核 S6-B05、S6-A15 所列“没有用例”的行为逐项补齐）：
 * 闸门退出模式、席位续期窗口、策略过期回退（逐项取更严）、签名人吊销回退（策略与连接器，只用核验通过的映射）、
 * 门限（律所版 2 名、只升不降、未固定不接受放宽）、租户盐固定、目录签发在未来、版本跳跃、不认识的新版本、吊销墓碑、
 * 许可签发在未来与回放、公钥变更核对（非管理员成员、吊销后作废、本机安全码）、签名绑定界面所见内容、本机吊销入队补发、
 * 闩锁（已接入控制面不能退回开发形态）与产品构建要求控制面。
 * 治理规则的单元在内核数据库上直接构造 FirmGovernance（可注入时钟）；链路类用例走真实内核、闸门与控制面 v0。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { generateDeviceKeys, generateFirmRoot, issueDeviceCertificate, SoftwareSigner, type DeviceCertificate, type DeviceRole } from "@zr-legal/keys";
import { adminSign, connectorSigningBytes, enrollProofBytes, parsePublicKeyMap, policySigningBytes, safetyCode, strictestTemplate, type FirmPolicyBody, type FirmPolicyDoc } from "@zr-legal/firm-trust";
import { sign } from "node:crypto";
import { makeKernel, type TestKernel } from "./helpers.ts";
import { startCloudCp, type CloudCp } from "./cloud-cp.ts";
import { ControlPlaneClient, FirmGovernance, getFirmRootPrivateKey, keysDirOf } from "../src/index.ts";
import { SYNC_MAX_INTERVAL_MS } from "../src/control-plane/client.ts";
import { loadConfig } from "../src/config.ts";
import { createGateAuthorizer } from "../src/egress/gate-host.ts";
import { mintTaskToken, taskTokenKey } from "../src/identity.ts";
import { assertIncomingEventAcceptable } from "../src/ledger-signer.ts";

const FIRM = "cpd-firm";
const TID = `ten_${FIRM}`;
const ME = `usr_${FIRM}_test-lawyer`;
const MY_DEV = `dev_${FIRM}_test-lawyer`;
const DAY = 86400_000;
const FULL = { engagement: "confirmed", personal_info: "confirmed", sensitive: "not_applicable", subprocessor: "confirmed" };
let cloud: CloudCp;
let tk: TestKernel;

before(async () => {
  cloud = await startCloudCp({ tenant: TID });
  tk = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream" }, FIRM);
  const r = await tk.inv("control_plane.sync");
  assert.equal(r.report.ok, true, JSON.stringify(r.report));
});
after(async () => {
  await tk.kernel.close().catch(() => {});
  await cloud.close();
});

const tenant = () => cloud.cp.ops.tenant(TID)!;
const root = () => getFirmRootPrivateKey(keysDirOf(tk.kernel.config.workspaceDir));
const seal = <T,>(kind: string, body: T) => cloud.cp.ops.seal(kind, body);
const alerts = async () => (await tk.inv("control_plane.status")).alerts as { alert_id: number; area: string; code: string; subject: string | null; detail: string }[];

function gov(o: { tenantId?: string; deviceId?: string; rootPub?: string; now?: () => number; base?: string | null; env?: NodeJS.ProcessEnv } = {}) {
  return new FirmGovernance({
    db: tk.kernel.db,
    tenantId: o.tenantId ?? TID,
    userId: ME,
    deviceId: o.deviceId ?? MY_DEV,
    rootPublicKeyPem: o.rootPub ?? root().publicKeyPem,
    signer: tk.kernel.signer,
    env: o.env ?? {},
    controlPlaneBase: o.base === undefined ? cloud.base : o.base,
    cpKeys: parsePublicKeyMap(cloud.env.ZR_CONTROL_PLANE_KEYS),
    seatKeys: parsePublicKeyMap(cloud.env.ZR_SEAT_KEYS),
    ...(o.now ? { now: o.now } : {}),
  });
}

function device(rootPriv: string, role: DeviceRole, member: string, id: string) {
  const k = generateDeviceKeys();
  const cert: DeviceCertificate = issueDeviceCertificate(rootPriv, {
    certId: `cert_${id}`,
    memberId: member,
    deviceId: id,
    role,
    signPublicKeyPem: k.signPublicKeyPem,
    encPublicKeyPem: k.encPublicKeyPem,
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 365 * DAY).toISOString(),
  });
  return { cert, keys: k, signPrivateKeyPem: k.signPrivateKeyPem };
}

function policyDoc(tid: string, version: number, body: FirmPolicyBody, iat = Date.now() - 60_000, days = 30): FirmPolicyDoc {
  return { kind: "kwl-firm-policy", v: 1, tid, version, issued_at: new Date(iat).toISOString(), expires_at: new Date(iat + days * DAY).toISOString(), body };
}

const RELAXED: FirmPolicyBody = { max_mode: "auto", auto_preauthorizations: ["search_generalized"], fetch_allowlist_extra: [], l3a_standard_model: "deny" };

test("闸门授权在退出模式下对一切用途拒绝（模型、检索、抓取、问答）", () => {
  const authorize = createGateAuthorizer({
    db: tk.kernel.db,
    secret: taskTokenKey(),
    revoked: { rids: new Set(), jtis: new Set() },
    anonSalt: () => Buffer.alloc(32, 1),
    tokenizerContext: () => ({ keyB64: "", parties: [], table: [], fullPseudonym: false, tableVersion: 0 }),
    fetchAllowlist: () => [],
    l3aStandardAllowed: () => false,
    exitMode: () => ({ code: "license_expired", message: "许可已到期" }),
  });
  const token = mintTaskToken({ tid: TID, uid: ME, mid: "m1", rid: "r1", scope: ["model:chat", "egress:search", "egress:fetch", "qa:chat"] });
  for (const purpose of ["model", "search", "fetch", "qa"] as const) {
    const r = authorize({ token, matterId: "m1", purpose });
    assert.deepEqual(r.ok ? "ok" : r.reason, "license_expired", purpose);
  }
});

test("席位令牌：签发 96 小时，剩余不足 73 小时即续期（任何时刻控制面停机后都还有 ≥ 72 小时）", () => {
  const start = Date.now();
  assert.equal(gov({ now: () => start }).seatInfo().renew_due, false);
  assert.equal(gov({ now: () => start + 20 * 3600_000 }).seatInfo().renew_due, false, "剩余约 76 小时");
  assert.equal(gov({ now: () => start + 24 * 3600_000 }).seatInfo().renew_due, true, "剩余约 72 小时");
  assert.ok(gov({ now: () => start + 23.5 * 3600_000 }).seatToken(), "续期之前令牌仍有效");
});

test("律所策略过期回退：最严模板且逐项不比最后一份策略宽（律所选“手动”的过期后仍是“手动”）", async () => {
  const { draft } = await tk.inv("firm_policy.create_draft", { kind: "policy", body: { ...strictestTemplate(), max_mode: "manual" }, ttl_days: 1 });
  assert.deepEqual(draft.relaxations, [], "比最严模板更严：只需控制面签名");
  const pub = await tk.inv("firm_policy.publish", { draft_id: draft.draft_id });
  assert.equal(pub.report.steps.policy, "accepted");
  assert.equal(pub.status.policy.body.max_mode, "manual");
  const later = gov({ now: () => Date.now() + 2 * DAY }).effectivePolicy();
  assert.equal(later.source, "strictest_fallback");
  assert.equal(later.fallback_reason, "expired");
  assert.equal(later.body.max_mode, "manual", "过期回退不比原策略宽");
});

test("签名管理员被吊销：有效签名不足即回退（策略与连接器）；只保存核验通过的签名，控制面夹带的条目不影响重算", { timeout: 60_000 }, async () => {
  const a2 = device(root().privateKeyPem, "admin", `usr_${FIRM}_admin2`, "dev_cpd_admin2");
  assert.equal((await cloud.deviceCall(TID, { cert: a2.cert, signPrivateKeyPem: a2.signPrivateKeyPem }, "POST", "/v1/devices/register", { tid: TID, cert: a2.cert })).status, 200);
  // 放宽策略由第二名管理员签名
  const { draft } = await tk.inv("firm_policy.create_draft", { kind: "policy", body: RELAXED });
  const sig = adminSign(policySigningBytes(draft.doc), a2.cert, a2.signPrivateKeyPem);
  assert.equal((await cloud.deviceCall(TID, { cert: a2.cert, signPrivateKeyPem: a2.signPrivateKeyPem }, "POST", `/v1/drafts/${draft.draft_id}/signatures`, sig)).status, 200);
  assert.equal((await cloud.deviceCall(TID, { cert: a2.cert, signPrivateKeyPem: a2.signPrivateKeyPem }, "POST", `/v1/drafts/${draft.draft_id}/publish`, {})).status, 200);
  // 被攻破的控制面在下发时夹带一条伪造条目（设备号与第二名管理员相同、成员不同、签名无效）
  tenant().policy!.admin_signatures.push({ cert: { ...a2.cert, memberId: `usr_${FIRM}_ghost` }, sig: sig.sig.replace(/^./, (c) => (c === "A" ? "B" : "A")) });
  // 连接器同样由第二名管理员签名登记
  const c = await tk.inv("firm_policy.create_draft", { kind: "connector", connector: { connector_id: "firm-kb", name: "本所知识库", server: "firm-kb", url: "https://kb.example-firm.cn/mcp", max_data_level: "L2", tools: [{ name: "kb.search", side_effect: "read", schema_hash: "d".repeat(64) }] } });
  const csig = adminSign(connectorSigningBytes(c.draft.doc), a2.cert, a2.signPrivateKeyPem);
  await cloud.deviceCall(TID, { cert: a2.cert, signPrivateKeyPem: a2.signPrivateKeyPem }, "POST", `/v1/drafts/${c.draft.draft_id}/signatures`, csig);
  assert.equal((await cloud.deviceCall(TID, { cert: a2.cert, signPrivateKeyPem: a2.signPrivateKeyPem }, "POST", `/v1/drafts/${c.draft.draft_id}/publish`, {})).status, 200);
  const r = await tk.inv("control_plane.sync");
  assert.equal(r.report.steps.policy, "accepted", JSON.stringify(r.report.steps));
  assert.equal(r.report.steps.connectors, "accepted");
  let st = await tk.inv("control_plane.status");
  assert.equal(st.policy.source, "control_plane");
  assert.deepEqual(st.policy.signers, [`usr_${FIRM}_admin2`]);
  assert.deepEqual(st.connectors.map((x: { connector_id: string }) => x.connector_id), ["firm-kb"]);
  const stored = tk.kernel.db.get<{ admin_signatures_json: string; signers_json: string }>(`SELECT admin_signatures_json, signers_json FROM firm_policies WHERE tenant_id = ? ORDER BY version DESC LIMIT 1`, [TID])!;
  assert.equal((JSON.parse(stored.admin_signatures_json) as unknown[]).length, 1, "只保存核验通过的签名");
  assert.deepEqual((JSON.parse(stored.signers_json) as { device_members: Record<string, string> }).device_members, { dev_cpd_admin2: `usr_${FIRM}_admin2` });
  // 吊销第二名管理员的设备：放宽策略与连接器都不再生效
  cloud.cp.ops.revokeDevice(TID, "dev_cpd_admin2");
  await tk.inv("control_plane.sync");
  st = await tk.inv("control_plane.status");
  assert.equal(st.policy.source, "strictest_fallback");
  assert.equal(st.policy.fallback_reason, "signers_insufficient");
  assert.equal(st.policy.body.max_mode, "default");
  assert.deepEqual(st.connectors, []);
});

test("门限：律所版首次取得许可即固定为 2 名，之后只升不降；门限未固定时不接受任何放宽内容", () => {
  const feRoot = generateFirmRoot();
  const g = gov({ tenantId: "ten_cpd_fe", rootPub: feRoot.publicKeyPem });
  const lic = (edition: "team" | "firm", iat: number) => seal("kwl-license", { tid: "ten_cpd_fe", edition, seats: 5, issued_at: new Date(iat).toISOString(), expires_at: new Date(iat + 30 * DAY).toISOString() });
  // 门限未固定：带放宽项的策略不接受（不告警），不比最严模板宽的策略照常接受
  const a = device(feRoot.privateKeyPem, "admin", "usr_fe_a", "dev_fe_a");
  const b = device(feRoot.privateKeyPem, "admin", "usr_fe_b", "dev_fe_b");
  const d1 = policyDoc("ten_cpd_fe", 1, RELAXED);
  const signed1 = { doc: d1, admin_signatures: [adminSign(policySigningBytes(d1), a.cert, a.signPrivateKeyPem)] };
  assert.equal(g.pinnedThreshold(), null);
  assert.deepEqual(g.applyPolicy(seal("kwl-firm-policy-current", signed1)), { accepted: false, changed: false, code: "threshold_not_pinned" });
  assert.equal(g.applyPolicy(seal("kwl-firm-policy-current", { doc: policyDoc("ten_cpd_fe", 1, strictestTemplate()), admin_signatures: [] })).accepted, true);
  // 律所版：固定为 2
  assert.equal(g.applyLicense(lic("firm", Date.now() - 1000)).accepted, true);
  assert.equal(g.pinnedThreshold(), 2);
  const d2 = policyDoc("ten_cpd_fe", 2, RELAXED);
  assert.equal(g.applyPolicy(seal("kwl-firm-policy-current", { doc: d2, admin_signatures: [adminSign(policySigningBytes(d2), a.cert, a.signPrivateKeyPem)] })).code, "relaxation_unsigned", "一名不够");
  const d3 = policyDoc("ten_cpd_fe", 3, RELAXED);
  assert.equal(
    g.applyPolicy(seal("kwl-firm-policy-current", { doc: d3, admin_signatures: [adminSign(policySigningBytes(d3), a.cert, a.signPrivateKeyPem), adminSign(policySigningBytes(d3), b.cert, b.signPrivateKeyPem)] })).accepted,
    true,
    "两名不同成员",
  );
  // 之后控制面下发团队版许可：门限不降
  assert.equal(g.applyLicense(lic("team", Date.now())).accepted, true);
  assert.equal(g.pinnedThreshold(), 2, "只升不降");
});

test("租户盐固定：控制面之后下发不同的盐即拒绝并告警，匿名编号不变", () => {
  const g = gov();
  const before = tk.kernel.db.get<{ salt_b64: string }>(`SELECT salt_b64 FROM tenant_salts WHERE tenant_id = ? AND purpose = 'anon_matter'`, [TID])!.salt_b64;
  const r = g.applySalt(seal("kwl-tenant-salt", { tid: TID, purpose: "anon_matter", salt_b64: Buffer.alloc(32, 9).toString("base64"), issued_at: new Date().toISOString() }));
  assert.deepEqual([r.accepted, r.code], [false, "salt_changed"]);
  assert.equal(tk.kernel.db.get<{ salt_b64: string }>(`SELECT salt_b64 FROM tenant_salts WHERE tenant_id = ? AND purpose = 'anon_matter'`, [TID])!.salt_b64, before);
});

test("设备目录：签发时刻在未来、版本跳跃过大拒收；吊销墓碑对本机尚不认识的设备同样粘滞", async () => {
  // 独立租户：不抬高本所租户的目录高水位（否则之后从控制面取到的目录都会按回放拒收）
  const DT = "ten_cpd_dir";
  tk.kernel.db.run(`INSERT OR IGNORE INTO tenants (tenant_id, name) VALUES (?, ?)`, [DT, DT]);
  const g = gov({ tenantId: DT });
  const now = Date.now();
  const dir = (version: number, o: Partial<{ iat: number; devices: DeviceCertificate[]; revoked: { device_id: string; revoked_at: string }[] }> = {}) =>
    seal("kwl-device-directory", { tid: DT, version, issued_at: new Date(o.iat ?? now).toISOString(), expires_at: new Date((o.iat ?? now) + 10 * DAY).toISOString(), devices: o.devices ?? [], revoked_devices: o.revoked ?? [], revoked_seats: [] });
  assert.equal(g.applyDirectory(dir(1)).accepted, true);
  const hw = 1;
  assert.equal(g.applyDirectory(dir(hw + 1, { iat: now + 3600_000 })).code, "not_yet_valid");
  assert.equal(g.applyDirectory(dir(hw + 200_000)).code, "version_jump");
  // 墓碑：本机不认识的设备先被列为吊销，之后又以有效证书出现（目录没有同列为吊销）——只以“已吊销”身份记入、告警
  const ghost = device(root().privateKeyPem, "lawyer", `usr_${FIRM}_ghost`, "dev_cpd_ghost");
  assert.equal(g.applyDirectory(dir(hw + 1, { revoked: [{ device_id: "dev_cpd_ghost", revoked_at: new Date(now).toISOString() }] })).accepted, true);
  assert.equal(g.applyDirectory(dir(hw + 2, { devices: [ghost.cert] })).accepted, true);
  assert.equal(tk.kernel.db.get<{ status: string }>(`SELECT status FROM devices WHERE device_id = 'dev_cpd_ghost'`)?.status, "revoked", "已吊销的设备不会以有效身份进入本机设备表");
  assert.ok(g.alerts().some((a) => a.code === "revoked_device_relisted" && a.subject === "dev_cpd_ghost"));
  assert.throws(() => assertIncomingEventAcceptable(tk.kernel.db, { signerDeviceId: "dev_cpd_ghost", keyEpoch: 1_000_000 }), /已吊销/, "其事件一律拒收");
});

test("诚实目录不告警（复核 S6-A19、S6-B28）：吊销之后才加入的设备首次同步，目录在“设备”与“吊销”两处同列——以“已吊销”身份记入、不告警；只在墓碑里的设备事件一律拒收", async () => {
  const HT = "ten_cpd_hon";
  tk.kernel.db.run(`INSERT OR IGNORE INTO tenants (tenant_id, name) VALUES (?, ?)`, [HT, HT]);
  const g = gov({ tenantId: HT });
  const now = Date.now();
  const left = device(root().privateKeyPem, "lawyer", `usr_${FIRM}_left`, "dev_cpd_left");
  const active = device(root().privateKeyPem, "lawyer", `usr_${FIRM}_stay`, "dev_cpd_stay");
  const revokedAt = new Date(now - DAY).toISOString();
  const honest = (version: number) =>
    seal("kwl-device-directory", {
      tid: HT,
      version,
      issued_at: new Date(now).toISOString(),
      expires_at: new Date(now + 10 * DAY).toISOString(),
      devices: [left.cert, active.cert],
      // 尚未登记即被预先吊销的设备编号：只在吊销列表里（没有证书）
      revoked_devices: [
        { device_id: "dev_cpd_left", revoked_at: revokedAt },
        { device_id: "dev_cpd_never", revoked_at: revokedAt },
      ],
      revoked_seats: [],
    });
  assert.equal(g.applyDirectory(honest(7)).accepted, true);
  assert.deepEqual(g.alerts().filter((a) => a.code === "revoked_device_relisted"), [], "诚实目录不告警");
  const rows = tk.kernel.db.all<{ device_id: string; status: string; revoked_at: string | null; revoked_epoch: number | null }>(
    `SELECT device_id, status, revoked_at, revoked_epoch FROM devices WHERE device_id IN ('dev_cpd_left','dev_cpd_stay') ORDER BY device_id`,
    [],
  );
  assert.deepEqual(rows.map((r) => [r.device_id, r.status, r.revoked_at]), [["dev_cpd_left", "revoked", revokedAt], ["dev_cpd_stay", "active", null]]);
  assert.ok(rows[0]!.revoked_epoch !== null, "带吊销纪元（共享文件夹同步据此拒收）");
  // 下一份诚实目录（内容变化）也不再告警
  const next = seal("kwl-device-directory", { tid: HT, version: 8, issued_at: new Date(now).toISOString(), expires_at: new Date(now + 10 * DAY).toISOString(), devices: [left.cert], revoked_devices: [{ device_id: "dev_cpd_left", revoked_at: revokedAt }], revoked_seats: [] });
  assert.equal(g.applyDirectory(next).accepted, true);
  assert.deepEqual(g.alerts().filter((a) => a.code === "revoked_device_relisted"), []);
  // 只在墓碑里、本机设备表没有的设备：事件一律拒收（共享文件夹同步与事件验收同样查墓碑）
  assert.equal(tk.kernel.db.get(`SELECT 1 AS x FROM devices WHERE device_id = 'dev_cpd_never'`), undefined);
  assert.throws(() => assertIncomingEventAcceptable(tk.kernel.db, { signerDeviceId: "dev_cpd_never", keyEpoch: 1_000_000 }), /已吊销/);
  assert.doesNotThrow(() => assertIncomingEventAcceptable(tk.kernel.db, { signerDeviceId: "dev_cpd_stay", keyEpoch: 1 }));
});

test("律所策略：版本跳跃过大拒收；收到本机不认识的新版本即回退最严模板，之后认得的新版本恢复生效", () => {
  // 独立租户：不抬高本所租户的策略高水位
  const PT = "ten_cpd_pol";
  const g = gov({ tenantId: PT });
  assert.equal(g.applyPolicy(seal("kwl-firm-policy-current", { doc: policyDoc(PT, 1, strictestTemplate()), admin_signatures: [] })).accepted, true);
  const hw = 1;
  assert.equal(g.applyPolicy(seal("kwl-firm-policy-current", { doc: policyDoc(PT, hw + 5000, strictestTemplate()), admin_signatures: [] })).code, "version_jump");
  const unknown = { ...policyDoc(PT, hw + 1, strictestTemplate()), body: { ...strictestTemplate(), retention_days: 30 } };
  assert.equal(g.applyPolicy(seal("kwl-firm-policy-current", { doc: unknown, admin_signatures: [] })).code, "unrecognized_newer");
  const eff = g.effectivePolicy();
  assert.deepEqual([eff.source, eff.fallback_reason], ["strictest_fallback", "unrecognized_newer"]);
  assert.equal(g.applyPolicy(seal("kwl-firm-policy-current", { doc: policyDoc(PT, hw + 2, strictestTemplate()), admin_signatures: [] })).accepted, true);
  assert.equal(g.effectivePolicy().source, "control_plane");
});

test("不认识的新版本（复核 S6-B30、S6-C04）：只有本租户、时刻合法的更新版本才触发回退；领先再多也回退，标记钳在高水位 + 10；格式版本 v2、内容本机无法核验的同样按不认识的新版本", () => {
  const PT = "ten_cpd_pol2";
  const g = gov({ tenantId: PT });
  const marker = () => tk.kernel.db.get<{ version: number }>(`SELECT version FROM cp_high_water WHERE tenant_id = ? AND kind = 'policy_unrecognized'`, [PT])?.version ?? null;
  const send = (doc: unknown) => g.applyPolicy(seal("kwl-firm-policy-current", { doc, admin_signatures: [] }));
  assert.equal(send(policyDoc(PT, 5, strictestTemplate())).accepted, true);
  const unk = (version: number, o: Partial<{ tid: string; iat: number; days: number }> = {}) => ({
    ...policyDoc(o.tid ?? PT, version, strictestTemplate(), o.iat ?? Date.now() - 60_000, o.days ?? 30),
    body: { ...strictestTemplate(), retention_days: 30 },
  });
  // 其他租户、已过期、签发在未来：按格式不合法拒绝，不抬标记，生效策略不受影响
  assert.equal(send(unk(6, { tid: "ten_other" })).code, "malformed");
  assert.equal(send(unk(6, { iat: Date.now() - 40 * DAY })).code, "malformed");
  assert.equal(send(unk(6, { iat: Date.now() + 3600_000 })).code, "malformed");
  assert.equal(marker(), null);
  assert.equal(g.effectivePolicy().source, "control_plane");
  // 格式版本 v2（kind 相符）：按不认识的新版本，回退最严模板
  assert.equal(send({ ...policyDoc(PT, 7, strictestTemplate()), v: 2 }).code, "unrecognized_newer");
  assert.equal(marker(), 7);
  assert.deepEqual([g.effectivePolicy().source, g.effectivePolicy().fallback_reason], ["strictest_fallback", "unrecognized_newer"]);
  // 领先超过 10：同样回退，标记钳在“高水位 + 10”（恢复所需的发布次数有界）
  assert.equal(send(unk(5 + 11)).code, "unrecognized_newer");
  assert.equal(marker(), 15);
  assert.equal(send(unk(5000)).code, "unrecognized_newer");
  assert.equal(marker(), 15);
  // 内容本机无法核验（例如新格式的抓取白名单取值）也按不认识的新版本失败关闭
  const badValue = { ...policyDoc(PT, 8, strictestTemplate()), body: { ...strictestTemplate(), fetch_allowlist_extra: ["*.example-firm.cn"] } };
  assert.equal(send(badValue).code, "unrecognized_newer");
  // 认得的更新版本超过标记后恢复生效；升级后越过回退标记属于正常追上，不按“大跳跃”告警（复核 S6-C15）
  assert.equal(send(policyDoc(PT, 16, strictestTemplate())).accepted, true);
  assert.equal(g.effectivePolicy().source, "control_plane");
  assert.equal(g.alerts().some((a) => a.code === "version_jump_large"), false);
});

test("版本一次跳过很多（复核 S6-C03）：仍接受但告警；首次接受时目录与连接器目录的版本号有绝对上限（复核 S6-C06）", () => {
  const JT = "ten_cpd_jump";
  tk.kernel.db.run(`INSERT OR IGNORE INTO tenants (tenant_id, name) VALUES (?, ?)`, [JT, JT]);
  const g = gov({ tenantId: JT });
  const now = Date.now();
  const dir = (version: number) =>
    seal("kwl-device-directory", { tid: JT, version, issued_at: new Date(now).toISOString(), expires_at: new Date(now + 10 * DAY).toISOString(), devices: [], revoked_devices: [], revoked_seats: [] });
  assert.equal(g.applyDirectory(dir(100_000_001)).code, "version_jump", "首次接受的上限");
  assert.equal(g.applyDirectory(dir(1)).accepted, true);
  assert.equal(g.applyDirectory(dir(1 + 1001)).accepted, true);
  assert.ok(g.alerts().some((a) => a.area === "directory" && a.code === "version_jump_large"));
  const cat = (version: number) => seal("kwl-firm-connectors", { tid: JT, version, issued_at: new Date(now).toISOString(), entries: [] });
  assert.equal(g.applyConnectors(cat(100_000_001)).code, "version_jump", "连接器目录首次接受的上限");
  assert.equal(g.applyPolicy(seal("kwl-firm-policy-current", { doc: policyDoc(JT, 1, strictestTemplate()), admin_signatures: [] })).accepted, true);
  assert.equal(g.applyPolicy(seal("kwl-firm-policy-current", { doc: policyDoc(JT, 12, strictestTemplate()), admin_signatures: [] })).accepted, true);
  assert.ok(g.alerts().some((a) => a.area === "policy" && a.code === "version_jump_large" && a.subject === "v12"));
  // 先抬起“不认识的新版本”标记、再大跳越过它很多：仍按大跳跃告警（复核 S6-C21）
  const KT = "ten_cpd_jump2";
  const g2 = gov({ tenantId: KT });
  const send2 = (doc: unknown) => g2.applyPolicy(seal("kwl-firm-policy-current", { doc, admin_signatures: [] }));
  assert.equal(send2(policyDoc(KT, 1, strictestTemplate())).accepted, true);
  assert.equal(send2({ ...policyDoc(KT, 2, strictestTemplate()), v: 2 }).code, "unrecognized_newer");
  assert.equal(send2(policyDoc(KT, 100, strictestTemplate())).accepted, true);
  assert.ok(g2.alerts().some((a) => a.code === "version_jump_large" && a.subject === "v100"));
});

test("本机自吊销与开发形态遗留的吊销（复核 S6-C10）：本机被吊销即结掉“吊销本机”的待同步项；进入控制面形态时为开发形态下的本机吊销补建待同步动作；已吊销设备行没有墓碑也一律拒收（复核 S6-C08）", () => {
  const ST = "ten_cpd_self";
  tk.kernel.db.run(`INSERT OR IGNORE INTO tenants (tenant_id, name) VALUES (?, ?)`, [ST, ST]);
  // 开发形态下的本机吊销（只记墓碑、未入队）
  tk.kernel.db.run(`INSERT INTO cp_revoked_devices (tenant_id, device_id, revoked_at, source) VALUES (?, 'dev_cpd_old', ?, 'local')`, [ST, new Date().toISOString()]);
  const SELF = "dev_cpd_selfdev";
  const g = gov({ tenantId: ST, deviceId: SELF });
  assert.deepEqual(g.pendingActions().map((a) => a.target), ["dev_cpd_old"], "进入控制面形态时补建待同步动作");
  assert.equal(gov({ tenantId: ST, deviceId: SELF }).pendingActions().length, 1, "不重复补建");
  // 吊销本机：控制面签名的吊销通知到达后，该项结掉
  tk.kernel.db.run(`INSERT INTO cp_pending_actions (tenant_id, kind, target, created_at, submitted_at) VALUES (?, 'revoke_device', ?, ?, ?)`, [ST, SELF, new Date().toISOString(), new Date().toISOString()]);
  const r = g.applyRevocationNotice(seal("kwl-device-revoked", { tid: ST, device_id: SELF, revoked_at: new Date().toISOString() }));
  assert.equal(r.accepted, true);
  assert.equal(g.revocationState(SELF), "synced");
  // 已吊销的设备行（没有墓碑，例如更早的数据）：不论自报的纪元一律拒收
  tk.kernel.db.run(
    `INSERT INTO devices (device_id, tenant_id, member_id, role, sign_pub_pem, enc_pub_pem, cert_json, status, key_epoch_at_issue, revoked_at, revoked_epoch) VALUES ('dev_cpd_legacy', ?, 'usr_x', 'lawyer', 'x', 'x', '{}', 'revoked', 1, ?, 2)`,
    [ST, new Date().toISOString()],
  );
  assert.throws(() => assertIncomingEventAcceptable(tk.kernel.db, { signerDeviceId: "dev_cpd_legacy", keyEpoch: 999 }), /已吊销/);
});

test("已过时的草稿（复核 S6-B29、S6-C06）：本机已接受同版本或更高版本时，草稿标为不可签，签名被拒", { timeout: 60_000 }, async () => {
  const { draft } = await tk.inv("firm_policy.create_draft", { kind: "policy", body: strictestTemplate() });
  // 期间另有同号版本生效（例如经其他途径发布）：控制面仍列出这份草稿
  tenant().policy = { doc: policyDoc(TID, draft.doc.version, { ...strictestTemplate(), max_mode: "manual" }), admin_signatures: [] };
  await tk.inv("control_plane.sync");
  const listed = (await tk.inv("firm_policy.drafts")).drafts.find((d: { draft_id: string }) => d.draft_id === draft.draft_id);
  assert.equal(listed?.valid, false);
  assert.match(listed?.problem ?? "", /已过时/);
  await assert.rejects(tk.inv("firm_policy.sign", { draft_id: draft.draft_id, expected_digest: listed.digest }), /未通过本机核验/);
});

test("时钟偏差告警走真实控制面（复核 S6-C02）：本机时钟快 12 分钟时，同步第一步登记即被拒，告警写明快约 12 分钟", { timeout: 60_000 }, async () => {
  const { relayControlPlane } = await import("@zr-legal/egress-gate");
  const CT = "ten_cpd_clock2";
  cloud.cp.ops.createTenant({ tid: CT, edition: "team", seats: 5 });
  const r0 = root();
  const ts = Date.now();
  const proof = sign(null, enrollProofBytes(CT, r0.publicKeyPem, ts), r0.privateKeyPem).toString("base64url");
  assert.equal((await fetch(`${cloud.base}/v1/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tid: CT, root_public_key_pem: r0.publicKeyPem, ts, proof }) })).status, 200);
  const dev = device(r0.privateKeyPem, "lawyer", `usr_${FIRM}_clock`, "dev_cpd_clock");
  const g = gov({ tenantId: CT, deviceId: "dev_cpd_clock" });
  const client = new ControlPlaneClient({
    gov: g,
    tenantId: CT,
    device: { deviceId: "dev_cpd_clock", cert: dev.cert, signer: new SoftwareSigner(dev.signPrivateKeyPem) },
    relay: (req) => relayControlPlane(req, { baseUrl: cloud.base }),
    now: () => Date.now() + 12 * 60_000,
  });
  const rep = await client.sync();
  assert.equal(rep.steps.register, "device_auth_stale");
  const a = g.alerts().find((x) => x.area === "clock" && x.code === "clock_skew");
  assert.ok(a && /快约 1[12] 分钟/.test(a.detail), JSON.stringify(a));
});

test("时钟偏差告警（复核 S6-B37）与同步间隔上限（复核 S6-A21）：控制面以时钟偏差拒绝签名请求时告警写明快慢几分钟；定时同步间隔钳在 1 小时以内", async () => {
  const CT = "ten_cpd_clock";
  const g = gov({ tenantId: CT });
  const serverTime = new Date(Date.now() - 12 * 60_000).toISOString();
  const client = new ControlPlaneClient({
    gov: g,
    tenantId: CT,
    device: { deviceId: MY_DEV, cert: JSON.parse(tk.kernel.db.get<{ cert_json: string }>(`SELECT cert_json FROM devices WHERE device_id = ?`, [MY_DEV])!.cert_json), signer: new SoftwareSigner(generateDeviceKeys().signPrivateKeyPem) },
    relay: async () => ({ ok: true, status: 401, body: JSON.stringify({ error: { code: "device_auth_stale", message: "x" }, server_time: serverTime }) }),
  });
  const rep = await client.sync();
  assert.equal(rep.steps.register, "device_auth_stale");
  const a = g.alerts().find((x) => x.area === "clock" && x.code === "clock_skew");
  assert.ok(a && /快约 12 分钟/.test(a.detail) && /请校准系统时间/.test(a.detail), JSON.stringify(a));
  // 同步间隔：配置 24 小时也钳到 1 小时（席位令牌“控制面停机后仍有 ≥ 72 小时”依赖于此）
  const realSetInterval = globalThis.setInterval;
  let captured = 0;
  globalThis.setInterval = ((fn: () => void, ms: number) => {
    captured = ms;
    return realSetInterval(fn, 1e9);
  }) as typeof setInterval;
  try {
    client.start(24 * 3600_000);
  } finally {
    globalThis.setInterval = realSetInterval;
    client.stop();
  }
  assert.equal(captured, SYNC_MAX_INTERVAL_MS);
  assert.equal(SYNC_MAX_INTERVAL_MS, 3600_000);
});

test("律所与成员标识（复核 S6-A22）：只允许字母、数字、下划线与连字符——设备编号与工作区目录名都由它们拼成", () => {
  for (const bad of ["../x", "a/b", "firm.one", "律所", "", "-lead", "a".repeat(49)]) {
    assert.throws(() => loadConfig({ firmSlug: bad, userSlug: "u", env: {} }), /律所标识/, bad);
    assert.throws(() => loadConfig({ firmSlug: "f", userSlug: bad, env: {} }), /成员标识/, bad);
  }
  assert.doesNotThrow(() => loadConfig({ firmSlug: "cpd-firm_2", userSlug: "test-lawyer", env: {} }));
});

test("许可：签发时刻在未来拒收并告警；签发更早的旧许可回放告警", async () => {
  const g = gov();
  const lic = (iat: number) => seal("kwl-license", { tid: TID, edition: "team", seats: 10, issued_at: new Date(iat).toISOString(), expires_at: new Date(iat + 30 * DAY).toISOString() });
  assert.equal(g.applyLicense(lic(Date.now() + 3600_000)).code, "not_yet_valid");
  assert.equal(g.applyLicense(lic(Date.now() - 10 * DAY)).code, "replayed");
  const codes = (await alerts()).map((a) => `${a.area}/${a.code}`);
  assert.ok(codes.includes("license/not_yet_valid") && codes.includes("license/replayed"), codes.join(","));
});

test("公钥变更核对：本机安全码可见；非管理员成员可核对；设备吊销后挂起的变更作废、不能确认", { timeout: 60_000 }, async () => {
  const { safety } = { safety: (await tk.inv("devices.list")).my_safety_code as string };
  const own = tk.kernel.db.get<{ sign_pub_pem: string; enc_pub_pem: string }>(`SELECT sign_pub_pem, enc_pub_pem FROM devices WHERE device_id = ?`, [MY_DEV])!;
  assert.equal(safety, safetyCode({ signPublicKeyPem: own.sign_pub_pem, encPublicKeyPem: own.enc_pub_pem }));
  const mk = (keys: ReturnType<typeof generateDeviceKeys>, id: string, n: string) =>
    issueDeviceCertificate(root().privateKeyPem, {
      certId: `cert_${id}_${n}`,
      memberId: `usr_${FIRM}_${id}`,
      deviceId: id,
      role: "lawyer",
      signPublicKeyPem: keys.signPublicKeyPem,
      encPublicKeyPem: keys.encPublicKeyPem,
      issuedAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 365 * DAY).toISOString(),
    });
  const k1 = generateDeviceKeys();
  const c1 = mk(k1, "dev_cpd_col", "1");
  await cloud.deviceCall(TID, { cert: c1, signPrivateKeyPem: k1.signPrivateKeyPem }, "POST", "/v1/devices/register", { tid: TID, cert: c1 });
  await tk.inv("control_plane.sync");
  const k2 = generateDeviceKeys();
  const c2 = mk(k2, "dev_cpd_col", "2");
  tenant().devices.set("dev_cpd_col", { cert: c2, registered_at: new Date().toISOString(), revoked_at: null });
  tenant().directoryVersion += 1;
  await tk.inv("control_plane.sync");
  // 非管理员成员：本机当前成员都可以核对（只影响本机今后的包裹）
  tk.kernel.db.run(`UPDATE memberships SET role = 'lawyer' WHERE tenant_id = ? AND user_id = ?`, [TID, ME]);
  try {
    await tk.inv("devices.key_changes.confirm", { device_id: "dev_cpd_col", safety_code: safetyCode(c2) });
  } finally {
    tk.kernel.db.run(`UPDATE memberships SET role = 'firm_admin' WHERE tenant_id = ? AND user_id = ?`, [TID, ME]);
  }
  assert.equal(tk.kernel.db.get<{ enc_pub_pem: string }>(`SELECT enc_pub_pem FROM devices WHERE device_id = 'dev_cpd_col'`)!.enc_pub_pem, k2.encPublicKeyPem);
  // 再次变更后、确认之前设备被吊销：挂起项作废，不能确认
  const k3 = generateDeviceKeys();
  const c3 = mk(k3, "dev_cpd_col", "3");
  tenant().devices.set("dev_cpd_col", { cert: c3, registered_at: new Date().toISOString(), revoked_at: null });
  tenant().directoryVersion += 1;
  await tk.inv("control_plane.sync");
  assert.ok((await tk.inv("control_plane.status")).key_changes.some((x: { device_id: string }) => x.device_id === "dev_cpd_col"));
  cloud.cp.ops.revokeDevice(TID, "dev_cpd_col");
  await tk.inv("control_plane.sync");
  assert.ok(!(await tk.inv("control_plane.status")).key_changes.some((x: { device_id: string }) => x.device_id === "dev_cpd_col"), "吊销后挂起项作废");
  await assert.rejects(tk.inv("devices.key_changes.confirm", { device_id: "dev_cpd_col", safety_code: safetyCode(c3) }), /没有待核对的公钥变更/);
  assert.equal(tk.kernel.db.get<{ enc_pub_pem: string }>(`SELECT enc_pub_pem FROM devices WHERE device_id = 'dev_cpd_col'`)!.enc_pub_pem, k2.encPublicKeyPem, "公钥没有被替换");
});

test("签名绑定界面所见内容：签名时控制面返回的草稿与界面展示的不同即拒签并告警；草稿列表只显示本机核验通过的签名人", async () => {
  const { draft } = await tk.inv("firm_policy.create_draft", { kind: "policy", body: { ...strictestTemplate(), max_mode: "manual" } });
  const listed = (await tk.inv("firm_policy.drafts")).drafts.find((d: { draft_id: string }) => d.draft_id === draft.draft_id);
  assert.ok(listed?.digest);
  // 被攻破的控制面在管理员点“签名”之前换掉草稿内容
  const rec = tenant().drafts.get(draft.draft_id)!;
  (rec.doc as FirmPolicyDoc).body = { ...RELAXED };
  await assert.rejects(tk.inv("firm_policy.sign", { draft_id: draft.draft_id, expected_digest: listed.digest }), /不一致/);
  assert.ok((await alerts()).some((a) => a.code === "draft_changed_before_signing" && a.subject === draft.draft_id));
  // 控制面声称“另一名管理员已签名”（伪造的签名条目）：列表不显示
  const fake = device(generateFirmRoot().privateKeyPem, "admin", "usr_fake", "dev_fake");
  rec.admin_signatures.push(adminSign(policySigningBytes(rec.doc as FirmPolicyDoc), fake.cert, fake.signPrivateKeyPem));
  const again = (await tk.inv("firm_policy.drafts")).drafts.find((d: { draft_id: string }) => d.draft_id === draft.draft_id);
  assert.deepEqual(again.signed_by, [], "非本所律所根签发的签名不显示为已签名");
});

test("本机吊销：控制面不可达时入队，控制面恢复后同步时补发；网关据此拒绝该设备", { timeout: 60_000 }, async () => {
  const lost = device(root().privateKeyPem, "lawyer", `usr_${FIRM}_lost2`, "dev_cpd_lost2");
  await cloud.deviceCall(TID, { cert: lost.cert, signPrivateKeyPem: lost.signPrivateKeyPem }, "POST", "/v1/devices/register", { tid: TID, cert: lost.cert });
  await tk.inv("control_plane.sync");
  // 控制面不可达（复核 S6-B32：不关闭端口，避免与并行运行的测试争用）
  cloud.setControlPlaneAvailable(false);
  try {
    const r = await tk.inv("devices.revoke", { device_id: "dev_cpd_lost2", reason: "丢失" });
    assert.equal(r.control_plane, "pending");
    const st = await tk.inv("control_plane.status");
    assert.deepEqual(
      st.pending_actions.filter((a: { target: string }) => a.target === "dev_cpd_lost2").map((a: { state: string; last_error: string }) => [a.state, a.last_error]),
      [["pending", "cp_unreachable"]],
      "暂时失败：待发送，联网后自动重试",
    );
  } finally {
    cloud.setControlPlaneAvailable(true);
  }
  const rep = await tk.inv("control_plane.sync");
  assert.equal(rep.report.steps.pending_actions, "sent:1", JSON.stringify(rep.report.steps));
  assert.ok(tenant().devices.get("dev_cpd_lost2")!.revoked_at, "控制面已吊销");
  // 完成以控制面签名的目录把它列为吊销为准（同一次同步里随后取到的目录已列出）
  assert.deepEqual((await tk.inv("control_plane.status")).pending_actions, []);
  await cloud.feed.refresh();
  assert.equal(cloud.feed.revokedDevice(TID, "dev_cpd_lost2"), true, "网关与检索服务的订阅已含该吊销");
});

/** 本机设备表里登记一台设备（模拟经共享文件夹同步得知、但从未联网登记到控制面的新电脑）。 */
function knowDevice(d: { cert: DeviceCertificate }) {
  tk.kernel.db.run(
    `INSERT INTO devices (device_id, tenant_id, member_id, role, sign_pub_pem, enc_pub_pem, cert_json, status, key_epoch_at_issue) VALUES (?,?,?,?,?,?,?, 'active', 1)`,
    [d.cert.deviceId, TID, d.cert.memberId, d.cert.role, d.cert.signPublicKeyPem, d.cert.encPublicKeyPem, JSON.stringify(d.cert)],
  );
}

test("本机吊销尚未登记到控制面的设备（复核 S6-B31）：控制面记预先吊销并列入目录与网关订阅，以目录确认为完成；该设备之后登记被拒并收到吊销通知", { timeout: 60_000 }, async () => {
  const fresh = device(root().privateKeyPem, "lawyer", `usr_${FIRM}_fresh`, "dev_cpd_fresh");
  knowDevice(fresh);
  const r = await tk.inv("devices.revoke", { device_id: "dev_cpd_fresh", reason: "新电脑丢失" });
  assert.equal(r.control_plane, "synced", r.note);
  assert.ok(tenant().preRevoked.has("dev_cpd_fresh"), "控制面记下预先吊销");
  assert.deepEqual((await tk.inv("control_plane.status")).pending_actions, []);
  const reg = await cloud.deviceCall(TID, { cert: fresh.cert, signPrivateKeyPem: fresh.signPrivateKeyPem }, "POST", "/v1/devices/register", { tid: TID, cert: fresh.cert });
  assert.equal(reg.status, 403);
  assert.equal(reg.json.error.code, "device_revoked");
  assert.ok(reg.json.notice, "附控制面签名的吊销通知");
  assert.equal(tenant().devices.has("dev_cpd_fresh"), false, "不登记");
  await cloud.feed.refresh();
  assert.equal(cloud.feed.revokedDevice(TID, "dev_cpd_fresh"), true, "网关与检索服务的订阅已含该吊销");
});

test("控制面拒绝本设备发起的吊销（复核 S6-A22）：记“控制面拒绝”、写明原因、不自动重试；手动同步重发，目录列为吊销后完成", { timeout: 60_000 }, async () => {
  const lost = device(root().privateKeyPem, "lawyer", `usr_${FIRM}_lost3`, "dev_cpd_lost3");
  await cloud.deviceCall(TID, { cert: lost.cert, signPrivateKeyPem: lost.signPrivateKeyPem }, "POST", "/v1/devices/register", { tid: TID, cert: lost.cert });
  await tk.inv("control_plane.sync");
  // 控制面记录的本设备证书角色不是管理员或合伙人（模拟证书签发之后成员角色变更、两边口径不一致）
  const rec = tenant().devices.get(MY_DEV)!;
  const orig = rec.cert;
  rec.cert = { ...orig, role: "lawyer" };
  try {
    const r = await tk.inv("devices.revoke", { device_id: "dev_cpd_lost3", reason: "离职" });
    assert.equal(r.control_plane, "failed");
    assert.match(r.note, /不会自动重试，需人工处理/);
    const st = await tk.inv("control_plane.status");
    assert.deepEqual(
      st.pending_actions.filter((a: { target: string }) => a.target === "dev_cpd_lost3").map((a: { state: string; last_error: string }) => [a.state, a.last_error]),
      [["failed", "revoker_required"]],
    );
    // 自动同步不重发控制面拒绝过的动作；手动同步才重发
    assert.equal(gov().pendingActions().some((a) => a.target === "dev_cpd_lost3"), false);
    assert.equal(gov().pendingActions({ includeFailed: true }).some((a) => a.target === "dev_cpd_lost3"), true);
  } finally {
    rec.cert = orig;
  }
  const rep = await tk.inv("control_plane.sync");
  assert.equal(rep.report.steps.pending_actions, "sent:1", JSON.stringify(rep.report.steps));
  assert.ok(tenant().devices.get("dev_cpd_lost3")!.revoked_at);
  assert.deepEqual((await tk.inv("control_plane.status")).pending_actions, []);
});

test("控制面应答“已吊销”却不在之后的目录里列出（复核 S6-B31）：本机不判完成，保持“已提交、待目录确认”，并告警；控制面如实吊销后完成", { timeout: 60_000 }, async () => {
  const lost = device(root().privateKeyPem, "lawyer", `usr_${FIRM}_lost4`, "dev_cpd_lost4");
  await cloud.deviceCall(TID, { cert: lost.cert, signPrivateKeyPem: lost.signPrivateKeyPem }, "POST", "/v1/devices/register", { tid: TID, cert: lost.cert });
  await tk.inv("control_plane.sync");
  // 被攻破的控制面：吊销请求照常应答 200，但并不吊销
  const real = cloud.cp.ops.revokeDevice;
  cloud.cp.ops.revokeDevice = () => {};
  try {
    const r = await tk.inv("devices.revoke", { device_id: "dev_cpd_lost4", reason: "离职" });
    assert.equal(r.control_plane, "submitted", r.note);
    // 提交已过 10 分钟：之后签发的目录仍未列为吊销。期间目录有别的变化（另一台设备登记、版本递增）：
    // 本机按“内容有变”的路径逐张核对证书——仍把 lost4 列为有效、本机又已记墓碑，走到“待确认的吊销不告警”这一分支（复核 S6-C14）
    tk.kernel.db.run(`UPDATE cp_pending_actions SET submitted_at = ? WHERE target = 'dev_cpd_lost4' AND done_at IS NULL`, [new Date(Date.now() - 10 * 60_000).toISOString()]);
    const other = device(root().privateKeyPem, "lawyer", `usr_${FIRM}_other4`, "dev_cpd_other4");
    const v0 = tenant().directoryVersion;
    await cloud.deviceCall(TID, { cert: other.cert, signPrivateKeyPem: other.signPrivateKeyPem }, "POST", "/v1/devices/register", { tid: TID, cert: other.cert });
    assert.ok(tenant().directoryVersion > v0, "目录版本已递增");
    await tk.inv("control_plane.sync");
    assert.ok(tk.kernel.db.get(`SELECT 1 AS x FROM devices WHERE device_id = 'dev_cpd_other4'`), "本机已按新目录应用（走了证书循环）");
    const st = await tk.inv("control_plane.status");
    assert.deepEqual(st.pending_actions.filter((a: { target: string }) => a.target === "dev_cpd_lost4").map((a: { state: string }) => a.state), ["submitted"], "不凭 HTTP 应答判完成");
    assert.ok(st.alerts.some((a: { code: string; subject: string }) => a.code === "revocation_not_reflected" && a.subject === "dev_cpd_lost4"), JSON.stringify(st.alerts));
    // 本机尚待控制面确认的吊销：目录仍把它列为有效属正常，不按“重新出现”告警（复核 S6-C06）
    assert.equal(st.alerts.some((a: { code: string; subject: string }) => a.code === "revoked_device_relisted" && a.subject === "dev_cpd_lost4"), false);
  } finally {
    cloud.cp.ops.revokeDevice = real;
  }
  await tk.inv("control_plane.sync");
  assert.deepEqual((await tk.inv("control_plane.status")).pending_actions, [], "控制面如实吊销、目录列出后完成");
});

/** 经内核拉起的真实出站闸门发一次请求（闸门进程 + 内核侧授权器）。 */
async function gatePost(path: string, token: string, body: unknown): Promise<{ status: number; text: string }> {
  const { socketPath } = await tk.kernel.gate.ensure();
  const { request } = await import("node:http");
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request(
      { socketPath, path, method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "content-length": Buffer.byteLength(data) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

test("闸门接线端到端（复核 S6-B35）：许可到期后经内核拉起的真实闸门发模型请求，授权即以 license_expired 拒绝；续订后恢复", { timeout: 60_000 }, async () => {
  const token = mintTaskToken({ tid: TID, uid: ME, mid: "m_gate_e2e", rid: "r_gate_e2e", scope: ["model:chat"] });
  const call = () => gatePost("/m/m_gate_e2e/v1/chat/completions", token, { model: "legal/k3", messages: [{ role: "user", content: "测试" }] });
  const before = await call();
  assert.doesNotMatch(before.text, /license_expired/, "许可有效时不以退出模式拒绝");
  cloud.cp.ops.terminateLicense(TID);
  try {
    await tk.inv("control_plane.sync");
    assert.equal((await tk.inv("control_plane.status")).exit_mode?.code, "license_expired");
    const r = await call();
    assert.equal(r.status, 403, r.text);
    assert.match(r.text, /license_expired/);
  } finally {
    cloud.cp.ops.renewLicense(TID, 365);
    await tk.inv("control_plane.sync");
  }
  assert.equal((await tk.inv("control_plane.status")).exit_mode, null, "续订后退出模式解除");
  const after = await call();
  assert.doesNotMatch(after.text, /license_expired/, "续订后闸门不再以退出模式拒绝（复核 S6-C06）");
});

test("闩锁与产品构建：已接入控制面的工作区去掉控制面地址不能退回开发形态；要求控制面而未配置即退出模式", { timeout: 60_000 }, async () => {
  const { createKernel } = await import("../src/index.ts");
  const dir = tk.dir;
  await tk.kernel.close();
  const env = { ...process.env, ZR_MODEL_PROVIDER: "upstream", ZR_CONTROL_PLANE_SYNC_MS: "off", ZR_FIRM_MAX_MODE: "auto" } as NodeJS.ProcessEnv;
  delete env.ZR_CONTROL_PLANE_BASE;
  const k2 = await createKernel({ dataDir: dir, firmSlug: FIRM, userSlug: "test-lawyer", env });
  try {
    const st = (await k2.invoke("control_plane.status")) as { mode: string; exit_mode: { code: string } | null; policy: { body: { max_mode: string } } };
    assert.equal(st.mode, "control_plane");
    assert.equal(st.exit_mode?.code, "control_plane_unconfigured");
    assert.notEqual(st.policy.body.max_mode, "auto", "本机配置项不生效");
  } finally {
    await k2.close();
  }
  // 产品构建要求控制面：全新工作区、没有控制面地址 → 退出模式
  const fresh = await makeKernel({ ZR_REQUIRE_CONTROL_PLANE: "1", ZR_CONTROL_PLANE_SYNC_MS: "off" }, "cpd-required-firm");
  try {
    const st = await fresh.inv("control_plane.status");
    assert.equal(st.mode, "control_plane");
    assert.equal(st.exit_mode?.code, "control_plane_unconfigured");
  } finally {
    await fresh.kernel.close();
  }
  // 复原本文件后续可能用到的内核
  const k3 = await createKernel({ dataDir: dir, firmSlug: FIRM, userSlug: "test-lawyer", env: { ...process.env, ZR_MODEL_PROVIDER: "upstream", ...cloud.env } });
  tk = { kernel: k3, dir, inv: (m, p) => k3.invoke(m, p) };
});

test("退出模式下重启（复核 S6-B34）：排队与中断的任务暂停、不拉起；同步取得许可、退出模式解除后恢复", { timeout: 90_000 }, async () => {
  const { createKernel } = await import("../src/index.ts");
  const { matter } = await tk.inv("matters.create", { title: "暂停任务探针", stance: "原告", basis: FULL });
  const rid = `run_parked_${Date.now().toString(36)}`;
  tk.kernel.db.run(
    `INSERT INTO runs (run_id, tenant_id, matter_id, scenario, workflow_version, status, idempotency_key, created_by) VALUES (?,?,?,?,?,?,?,?)`,
    [rid, TID, matter.matter_id, "s1.contract_review", "test", "queued", `idem-${rid}`, ME],
  );
  cloud.cp.ops.terminateLicense(TID);
  await tk.inv("control_plane.sync");
  assert.equal((await tk.inv("control_plane.status")).exit_mode?.code, "license_expired");
  const dir = tk.dir;
  await tk.kernel.close();
  const k = await createKernel({ dataDir: dir, firmSlug: FIRM, userSlug: "test-lawyer", env: { ...process.env, ZR_MODEL_PROVIDER: "upstream", ...cloud.env } });
  tk = { kernel: k, dir, inv: (m, p) => k.invoke(m, p) };
  const attempts = () => k.db.all(`SELECT attempt_id FROM attempts WHERE run_id = ?`, [rid]).length;
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(k.db.get<{ status: string }>(`SELECT status FROM runs WHERE run_id = ?`, [rid])!.status, "queued", "退出模式下不拉起");
  assert.equal(attempts(), 0);
  cloud.cp.ops.renewLicense(TID, 365);
  await tk.inv("control_plane.sync");
  assert.equal((await tk.inv("control_plane.status")).exit_mode, null);
  const deadline = Date.now() + 15_000;
  while (attempts() === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.ok(attempts() > 0, "退出模式解除后恢复（任务被拉起）");
});

test("运行中进入退出模式（复核 S6-C12、S6-C14）：内核把退出模式接到队列的放行判断——排队的任务不拉起；同步取得许可后恢复", { timeout: 90_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "运行中暂停探针", stance: "原告", basis: FULL });
  cloud.cp.ops.terminateLicense(TID);
  await tk.inv("control_plane.sync");
  assert.equal((await tk.inv("control_plane.status")).exit_mode?.code, "license_expired");
  const rid = `run_gate_${Date.now().toString(36)}`;
  tk.kernel.db.run(
    `INSERT INTO runs (run_id, tenant_id, matter_id, scenario, workflow_version, status, idempotency_key, created_by) VALUES (?,?,?,?,?,?,?,?)`,
    [rid, TID, matter.matter_id, "s1.contract_review", "test", "queued", `idem-${rid}`, ME],
  );
  tk.kernel.queue.enqueue(rid);
  const attempts = () => tk.kernel.db.all(`SELECT attempt_id FROM attempts WHERE run_id = ?`, [rid]).length;
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(attempts(), 0, "退出模式下不拉起");
  cloud.cp.ops.renewLicense(TID, 365);
  await tk.inv("control_plane.sync");
  const deadline = Date.now() + 15_000;
  while (attempts() === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.ok(attempts() > 0, "退出模式解除后恢复（任务被拉起）");
});

test("尚未登记、本机证书无法核实的设备（复核 S6-C19）：吊销自动重试，不判“控制面拒绝”；该设备一登记，下一次同步即吊销", { timeout: 60_000 }, async () => {
  const sly = device(root().privateKeyPem, "lawyer", `usr_${FIRM}_sly`, "dev_cpd_sly");
  // 本机设备表里的证书被改过（例如经共享文件夹同步写入的设备行）：本机核验不过，补发时不附
  knowDevice({ cert: { ...sly.cert, memberId: `usr_${FIRM}_someone` } });
  const r = await tk.inv("devices.revoke", { device_id: "dev_cpd_sly", reason: "离职" });
  assert.equal(r.control_plane, "pending", r.note);
  const st = await tk.inv("control_plane.status");
  assert.deepEqual(
    st.pending_actions.filter((a: { target: string }) => a.target === "dev_cpd_sly").map((a: { state: string; last_error: string }) => [a.state, a.last_error]),
    [["pending", "cert_required"]],
    "暂时失败：自动重试",
  );
  // 该设备用真实证书登记之后，下一次同步即按已登记设备吊销
  await cloud.deviceCall(TID, { cert: sly.cert, signPrivateKeyPem: sly.signPrivateKeyPem }, "POST", "/v1/devices/register", { tid: TID, cert: sly.cert });
  await tk.inv("control_plane.sync");
  assert.ok(tenant().devices.get("dev_cpd_sly")?.revoked_at, "控制面已吊销");
  assert.deepEqual((await tk.inv("control_plane.status")).pending_actions.filter((a: { target: string }) => a.target === "dev_cpd_sly"), []);
});
