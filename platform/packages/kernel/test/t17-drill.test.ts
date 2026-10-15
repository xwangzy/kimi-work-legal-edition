/**
 * T17 控制面被攻破演练（v9 第 06 篇 §2 T17；第 02 篇 §13 第 8 条；第 04 篇 §10）：
 * 设定控制面（含其签名密钥）已被他人控制、可以下发任意经控制面签名的内容。律所侧固定的校验锚（律所根公钥、管理员签名门限、
 * 版本高水位）是本机的最后裁决依据——下列内容客户端全部拒绝并告警（告警进本机签名审计链、界面可见），生效状态不变：
 *  1. 只有控制面签名（或附带非本所律所根签发的“管理员”签名）的放宽策略；
 *  2. 回放的旧策略（含内核重启之后）；
 *  3. 替换的成员公钥（证书非本所律所根签发：拒绝；由本所根签发但公钥变了：挂起，核对安全码后才替换）；
 *  4. 未经管理员签名登记的连接器（含篡改已登记的连接器）；
 *  另：回放旧设备目录不能撤回吊销。
 * 演练用测试进程里的控制面 v0：直接改写它的存储，由它以自己的密钥签名下发——与控制面被攻破时的能力相同。
 * 每次同步都断言相关步骤的结论（复核 S6-B15）；回放类用例另断言版本高水位不变（真正把关的是高水位，不只是告警）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { generateDeviceKeys, generateFirmRoot, issueDeviceCertificate, type DeviceCertificate } from "@zr-legal/keys";
import { adminSign, policySigningBytes, safetyCode, type FirmConnectorDoc, type FirmPolicyBody, type FirmPolicyDoc } from "@zr-legal/firm-trust";
import { makeKernel, type TestKernel } from "./helpers.ts";
import { startCloudCp, type CloudCp } from "./cloud-cp.ts";

const FIRM = "t17-firm";
const TID = `ten_${FIRM}`;
const DAY = 86400_000;
const RELAXED: FirmPolicyBody = { max_mode: "auto", auto_preauthorizations: ["search_generalized"], fetch_allowlist_extra: ["exfil-example.cn"], l3a_standard_model: "allow" };
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
const status = () => tk.inv("control_plane.status");
const alertCodes = async () => (await status()).alerts.map((a: { area: string; code: string }) => `${a.area}/${a.code}`);
/** 同步并断言指定步骤的结论（步骤失败时用例在这里给出可诊断的信息）。 */
async function sync(expect: Record<string, string>) {
  const r = await tk.inv("control_plane.sync");
  for (const [k, v] of Object.entries(expect)) assert.equal(r.report.steps[k], v, `同步步骤 ${k}：${JSON.stringify(r.report.steps)}`);
  return r;
}
const hwOf = (kind: string) => tk.kernel.db.get<{ version: number }>(`SELECT version FROM cp_high_water WHERE tenant_id = ? AND kind = ?`, [TID, kind])?.version ?? null;
/** 断言存在某一对象（subject）的未处理告警，并返回它。 */
async function alertOn(area: string, code: string, subject: string) {
  const a = (await status()).alerts.find((x: { area: string; code: string; subject: string | null }) => x.area === area && x.code === code && x.subject === subject);
  assert.ok(a, `应有告警 ${area}/${code}/${subject}`);
  return a as { alert_id: number; detail: string };
}
const rejectedAudit = () => tk.kernel.db.all<{ object_id: string }>(`SELECT object_id FROM audit_events WHERE action = 'control_plane.rejected'`, []).map((r) => r.object_id);
function policyDoc(version: number, body: FirmPolicyDoc["body"], iat = Date.now() - 60_000): FirmPolicyDoc {
  return { kind: "kwl-firm-policy", v: 1, tid: TID, version, issued_at: new Date(iat).toISOString(), expires_at: new Date(iat + 30 * DAY).toISOString(), body: { ...body, auto_preauthorizations: [...body.auto_preauthorizations], fetch_allowlist_extra: [...body.fetch_allowlist_extra] } };
}
/** 被攻破的控制面直接改写当前策略（由它以自己的密钥签名下发）。 */
function servePolicy(doc: FirmPolicyDoc, admin_signatures: { cert: DeviceCertificate; sig: string }[] = []) {
  tenant().policy = { doc, admin_signatures };
}
async function myDevice(): Promise<{ cert: DeviceCertificate; signPrivateKeyPem: string }> {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const keys = JSON.parse(readFileSync(join(tk.kernel.config.workspaceDir, "keys", "device.json"), "utf8")) as { signPrivateKeyPem: string };
  const row = tk.kernel.db.get<{ cert_json: string }>(`SELECT cert_json FROM devices WHERE device_id = ?`, [`dev_${FIRM}_test-lawyer`])!;
  return { cert: JSON.parse(row.cert_json) as DeviceCertificate, signPrivateKeyPem: keys.signPrivateKeyPem };
}
async function firmRoot() {
  const { getFirmRootPrivateKey, keysDirOf } = await import("../src/index.ts");
  return getFirmRootPrivateKey(keysDirOf(tk.kernel.config.workspaceDir));
}

test("T17-1 只有控制面签名的放宽策略：拒绝并告警；生效策略不变（无自动档、白名单无追加、L3a 不放开）", { timeout: 60_000 }, async () => {
  const v0 = (await status()).policy.version;
  const hw0 = hwOf("policy");
  servePolicy(policyDoc(v0 + 1, RELAXED));
  await sync({ policy: "rejected:relaxation_unsigned" });
  const st = await status();
  assert.equal(st.policy.version, v0, "生效策略不变");
  assert.equal(hwOf("policy"), hw0, "高水位不变（被拒的版本不占用版本号）");
  assert.deepEqual(st.policy.relaxations, []);
  assert.ok((await alertCodes()).includes("policy/relaxation_unsigned"), JSON.stringify(st.alerts));
  assert.ok(rejectedAudit().some((o) => o.startsWith("policy:relaxation_unsigned")), "告警进本机签名审计链");
  const { matter } = await tk.inv("matters.create", { title: "演练事项", stance: "原告", confidentiality: "high", basis: { engagement: "confirmed", personal_info: "confirmed", sensitive: "confirmed", subprocessor: "confirmed" } });
  const pol = (await tk.inv("matters.get", { matter_id: matter.matter_id })).run_policy;
  assert.ok(!pol.allowed_modes.includes("auto"));
  assert.ok(!tk.kernel.gate.fetchAllowlist.includes("exfil-example.cn"));
  const est = await tk.inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: [] });
  assert.match(est.data_where.preview, /须由律所管理员放开/, "L3a 经标准端点仍须律所管理员放开");

  // 附带“管理员签名”，但签名证书不是本所律所根签发的（控制面自造的管理员）：同样拒绝
  const fakeRoot = generateFirmRoot();
  const k = generateDeviceKeys();
  const fakeAdmin = issueDeviceCertificate(fakeRoot.privateKeyPem, {
    certId: "cert_fake_admin",
    memberId: "usr_fake_admin",
    deviceId: "dev_fake_admin",
    role: "admin",
    signPublicKeyPem: k.signPublicKeyPem,
    encPublicKeyPem: k.encPublicKeyPem,
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 365 * DAY).toISOString(),
  });
  const d = policyDoc(v0 + 2, RELAXED);
  servePolicy(d, [adminSign(policySigningBytes(d), fakeAdmin, k.signPrivateKeyPem)]);
  await sync({ policy: "rejected:relaxation_unsigned" });
  const st2 = await status();
  assert.equal(st2.policy.version, v0);
  const a = st2.alerts.find((x: { code: string; subject: string }) => x.code === "relaxation_unsigned" && x.subject === `v${v0 + 2}`);
  assert.ok(a && /cert_not_issued_by_firm_root/.test(a.detail), JSON.stringify(st2.alerts));
});

test("T17-2 回放的旧策略：管理员签名的旧版本在更新的版本之后再下发——拒绝并告警；内核重启后依然拒绝", { timeout: 90_000 }, async () => {
  const me = await myDevice();
  const hw = tk.kernel.db.get<{ version: number }>(`SELECT version FROM cp_high_water WHERE tenant_id = ? AND kind = 'policy'`, [TID])!.version;
  // 正常流程：管理员签名的放宽策略（vA），随后收紧为最严模板（vB）
  const vA = Math.max(hw, tenant().policy?.doc.version ?? 0) + 1;
  const docA = policyDoc(vA, { ...RELAXED, fetch_allowlist_extra: [], l3a_standard_model: "deny" });
  const signedA = [adminSign(policySigningBytes(docA), me.cert, me.signPrivateKeyPem)];
  servePolicy(docA, signedA);
  await sync({ policy: "accepted" });
  assert.equal((await status()).policy.version, vA, "管理员签名的放宽策略生效");
  const docB = policyDoc(vA + 1, { max_mode: "default", auto_preauthorizations: [], fetch_allowlist_extra: [], l3a_standard_model: "deny" });
  servePolicy(docB);
  await sync({ policy: "accepted" });
  assert.equal((await status()).policy.version, vA + 1);
  // 回放 vA（签名本身有效）
  servePolicy(docA, signedA);
  await sync({ policy: "rejected:replayed" });
  assert.equal(hwOf("policy"), vA + 1, "高水位不变");
  let st = await status();
  assert.equal(st.policy.version, vA + 1, "回放不改变生效策略");
  assert.deepEqual(st.policy.relaxations, []);
  assert.ok((await alertCodes()).includes("policy/replayed"));
  // 内核重启：高水位持久化，回放依旧拒绝
  const dir = tk.dir;
  await tk.kernel.close();
  const { createKernel } = await import("../src/index.ts");
  const k2 = await createKernel({ dataDir: dir, firmSlug: FIRM, userSlug: "test-lawyer", env: { ...process.env, ZR_MODEL_PROVIDER: "upstream", ...cloud.env } });
  tk = { kernel: k2, dir, inv: (m, p) => k2.invoke(m, p) };
  const again = await tk.inv("control_plane.sync");
  assert.equal(again.report.steps.policy, "rejected:replayed", "重启后同一回放依旧拒绝");
  st = await status();
  assert.equal(st.policy.version, vA + 1);
  assert.deepEqual(st.policy.relaxations, []);
});

test("T17-3 替换的成员公钥：非本所律所根签发的证书拒绝并告警；本所根签发但公钥变了的挂起，核对安全码后才替换", { timeout: 60_000 }, async () => {
  const root = await firmRoot();
  const mk = (keys: ReturnType<typeof generateDeviceKeys>, issuerPriv: string, certId: string) =>
    issueDeviceCertificate(issuerPriv, {
      certId,
      memberId: `usr_${FIRM}_colleague`,
      deviceId: "dev_t17_colleague",
      role: "lawyer",
      signPublicKeyPem: keys.signPublicKeyPem,
      encPublicKeyPem: keys.encPublicKeyPem,
      issuedAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 365 * DAY).toISOString(),
    });
  const original = generateDeviceKeys();
  const certOk = mk(original, root.privateKeyPem, "cert_col_1");
  assert.equal((await cloud.deviceCall(TID, { cert: certOk, signPrivateKeyPem: original.signPrivateKeyPem }, "POST", "/v1/devices/register", { tid: TID, cert: certOk })).status, 200);
  await sync({ directory: "accepted" });
  const row = () => tk.kernel.db.get<{ status: string; enc_pub_pem: string; sign_pub_pem: string }>(`SELECT status, enc_pub_pem, sign_pub_pem FROM devices WHERE device_id = 'dev_t17_colleague'`)!;
  assert.equal(row().enc_pub_pem, original.encPublicKeyPem);

  // (a) 控制面把同事设备的公钥换成另一对，证书由别的根签发
  const replacement = generateDeviceKeys();
  const forged = mk(replacement, generateFirmRoot().privateKeyPem, "cert_col_forged");
  tenant().devices.set("dev_t17_colleague", { cert: forged, registered_at: new Date().toISOString(), revoked_at: null });
  tenant().directoryVersion += 1;
  await sync({ directory: "unchanged" });
  assert.equal(row().enc_pub_pem, original.encPublicKeyPem, "本机设备表不变（不会向替换的公钥包裹事项密钥）");
  await alertOn("directory", "cert_not_issued_by_firm_root", "dev_t17_colleague");

  // 事项加入同事：密钥只包裹给原公钥
  const { matter } = await tk.inv("matters.create", { title: "成员公钥演练", stance: "原告" });
  await tk.inv("matters.members.add", { matter_id: matter.matter_id, user_id: `usr_${FIRM}_colleague`, matter_role: "editor" });
  const { unwrapMatterKey } = await import("@zr-legal/keys");
  const wrapped = tk.kernel.db.get<{ wrapped_key: string }>(`SELECT wrapped_key FROM matter_keys WHERE matter_id = ? AND wrapped_for = 'dev_t17_colleague'`, [matter.matter_id])!;
  assert.doesNotThrow(() => unwrapMatterKey(wrapped.wrapped_key, original.encPrivateKeyPem), "包裹给原公钥");
  assert.throws(() => unwrapMatterKey(wrapped.wrapped_key, replacement.encPrivateKeyPem), "替换的公钥解不开");

  // (b) 证书确由本所律所根签发、但已知设备的公钥变了（例如重装）：挂起 + 告警，安全码不符不替换，核对一致后才替换
  const rekeyed = mk(replacement, root.privateKeyPem, "cert_col_2");
  tenant().devices.set("dev_t17_colleague", { cert: rekeyed, registered_at: new Date().toISOString(), revoked_at: null });
  tenant().directoryVersion += 1;
  await sync({ directory: "accepted" });
  assert.equal(row().enc_pub_pem, original.encPublicKeyPem, "核对安全码之前不替换");
  const st = await status();
  const pending = st.key_changes.find((c: { device_id: string }) => c.device_id === "dev_t17_colleague");
  assert.ok(pending, JSON.stringify(st.key_changes));
  assert.equal(pending.safety_code, undefined, "状态里不给出新公钥的安全码：由对方读出、本机比对（复核 S6-B21）");
  await alertOn("directory", "member_key_changed", "dev_t17_colleague");
  await assert.rejects(tk.inv("devices.key_changes.confirm", { device_id: "dev_t17_colleague", safety_code: "00000 00000 00000 00000 00000 00000" }), /安全码不一致/);
  assert.equal(row().enc_pub_pem, original.encPublicKeyPem);
  await tk.inv("devices.key_changes.confirm", { device_id: "dev_t17_colleague", safety_code: safetyCode(rekeyed) });
  assert.equal(row().enc_pub_pem, replacement.encPublicKeyPem, "核对一致后替换");
});

test("T17-4 未经管理员签名登记的连接器：拒绝并告警、不进入已核验登记（运行通道在 G1，D-39）；篡改已登记的连接器即撤下并告警", { timeout: 60_000 }, async () => {
  const base: FirmConnectorDoc = {
    kind: "kwl-firm-connector",
    v: 1,
    tid: TID,
    connector_id: "firm-dms",
    version: 1,
    name: "本所文档管理系统",
    server: "firm-dms",
    url: "https://dms.example-firm.cn/mcp",
    max_data_level: "L2",
    tools: [{ name: "dms.search", side_effect: "read", schema_hash: "b".repeat(64) }],
    registered_at: new Date().toISOString(),
  };
  // 控制面自行登记（没有管理员签名）
  tenant().connectors.set("firm-unsigned", { doc: { ...base, connector_id: "firm-unsigned", server: "firm-unsigned" }, admin_signatures: [] });
  tenant().connectorsVersion += 1;
  // 目录本身被处理（版本前进），其中唯一的登记被拒：本机没有任何变化
  await sync({ connectors: "unchanged" });
  let st = await status();
  assert.deepEqual(st.connectors, [], "未签名登记的连接器不进入已核验登记");
  const unsignedAlert = await alertOn("connectors", "connector_unsigned", "firm-unsigned");
  await tk.inv("control_plane.alerts.ack", { alert_id: unsignedAlert.alert_id });

  // 管理员经本机签名登记：启用
  tenant().connectors.delete("firm-unsigned");
  const { draft } = await tk.inv("firm_policy.create_draft", { kind: "connector", connector: { connector_id: "firm-dms", name: base.name, server: base.server, url: base.url, max_data_level: "L2", tools: base.tools } });
  await tk.inv("firm_policy.sign", { draft_id: draft.draft_id, expected_digest: draft.digest });
  const pub = await tk.inv("firm_policy.publish", { draft_id: draft.draft_id });
  assert.equal(pub.report.steps.connectors, "accepted");
  st = await status();
  assert.deepEqual(
    st.connectors.map((c: { connector_id: string }) => c.connector_id),
    ["firm-dms"],
  );

  // 控制面篡改已登记的连接器（加一个写入工具、改可接收级别），不重新取得管理员签名：拒绝，连接器撤下（失败关闭）
  const cur = tenant().connectors.get("firm-dms")!;
  tenant().connectors.set("firm-dms", {
    doc: { ...cur.doc, version: cur.doc.version + 1, max_data_level: "L3a", tools: [...cur.doc.tools, { name: "dms.upload", side_effect: "external", schema_hash: "c".repeat(64) }] },
    admin_signatures: cur.admin_signatures,
  });
  tenant().connectorsVersion += 1;
  await sync({ connectors: "accepted" });
  st = await status();
  assert.deepEqual(st.connectors, [], "篡改后的登记不进入已核验登记，原登记撤下");
  await alertOn("connectors", "connector_unsigned", "firm-dms");
});

test("回放旧设备目录不能撤回吊销：版本低于本机高水位即拒绝并告警", { timeout: 60_000 }, async () => {
  const root = await firmRoot();
  const k = generateDeviceKeys();
  const cert = issueDeviceCertificate(root.privateKeyPem, {
    certId: "cert_t17_lost",
    memberId: `usr_${FIRM}_lost`,
    deviceId: "dev_t17_lost",
    role: "lawyer",
    signPublicKeyPem: k.signPublicKeyPem,
    encPublicKeyPem: k.encPublicKeyPem,
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 365 * DAY).toISOString(),
  });
  const reg = await cloud.deviceCall(TID, { cert, signPrivateKeyPem: k.signPrivateKeyPem }, "POST", "/v1/devices/register", { tid: TID, cert });
  assert.equal(reg.status, 200, JSON.stringify(reg.json));
  await sync({ directory: "accepted" });
  const before = tenant().directoryVersion;
  cloud.cp.ops.revokeDevice(TID, "dev_t17_lost");
  await sync({ directory: "accepted" });
  const hwAfterRevoke = hwOf("directory");
  const status1 = tk.kernel.db.get<{ status: string }>(`SELECT status FROM devices WHERE device_id = 'dev_t17_lost'`)!.status;
  assert.equal(status1, "revoked");
  // 控制面把目录退回到吊销之前（旧版本号、设备未吊销）
  tenant().devices.get("dev_t17_lost")!.revoked_at = null;
  tenant().directoryVersion = before;
  await sync({ directory: "rejected:replayed" });
  assert.equal(hwOf("directory"), hwAfterRevoke, "高水位不变");
  assert.equal(tk.kernel.db.get<{ status: string }>(`SELECT status FROM devices WHERE device_id = 'dev_t17_lost'`)!.status, "revoked", "吊销是粘滞的");
  assert.ok((await alertCodes()).includes("directory/replayed"));
  // 版本号前进但不再列出吊销：目录被处理（高水位前进），已吊销的设备按墓碑跳过、本机没有任何变化——吊销不撤回
  tenant().directoryVersion = before + 10;
  await sync({ directory: "unchanged" });
  assert.equal(hwOf("directory"), before + 10);
  assert.equal(tk.kernel.db.get<{ status: string }>(`SELECT status FROM devices WHERE device_id = 'dev_t17_lost'`)!.status, "revoked");
});

test("设备目录带有效期（第 02 篇 §9.11）：已过期、有效期超过 30 天的目录拒收并告警", { timeout: 60_000 }, async () => {
  const { FirmGovernance } = await import("../src/index.ts");
  const { parsePublicKeyMap } = await import("@zr-legal/firm-trust");
  const firm = tk.kernel.db.get<{ root_public_key_pem: string }>(`SELECT root_public_key_pem FROM firm_identity WHERE tenant_id = ?`, [TID])!;
  const gov = new FirmGovernance({
    db: tk.kernel.db,
    tenantId: TID,
    userId: `usr_${FIRM}_test-lawyer`,
    deviceId: `dev_${FIRM}_test-lawyer`,
    rootPublicKeyPem: firm.root_public_key_pem,
    signer: tk.kernel.signer,
    env: {},
    controlPlaneBase: cloud.base,
    cpKeys: parsePublicKeyMap(cloud.env.ZR_CONTROL_PLANE_KEYS),
    seatKeys: parsePublicKeyMap(cloud.env.ZR_SEAT_KEYS),
  });
  const hw = tk.kernel.db.get<{ version: number }>(`SELECT version FROM cp_high_water WHERE tenant_id = ? AND kind = 'directory'`, [TID])!.version;
  const body = (iat: number, exp: number) => ({ tid: TID, version: hw + 5, issued_at: new Date(iat).toISOString(), expires_at: new Date(exp).toISOString(), devices: [], revoked_devices: [], revoked_seats: [] });
  const now = Date.now();
  const expired = gov.applyDirectory(cloud.cp.ops.seal("kwl-device-directory", body(now - 40 * DAY, now - 10 * DAY)));
  assert.deepEqual([expired.accepted, expired.code], [false, "expired"]);
  const tooLong = gov.applyDirectory(cloud.cp.ops.seal("kwl-device-directory", body(now, now + 90 * DAY)));
  assert.deepEqual([tooLong.accepted, tooLong.code], [false, "malformed"]);
  assert.equal(tk.kernel.db.get<{ version: number }>(`SELECT version FROM cp_high_water WHERE tenant_id = ? AND kind = 'directory'`, [TID])!.version, hw, "高水位不变");
  assert.ok((await alertCodes()).includes("directory/expired"));
});
