/**
 * 控制面文档的律所侧核验（v9 第 02 篇 §9.11 律所侧校验锚、§10；第 04 篇 §10；T17 的判定规则单元）：
 * 控制面信封、律所策略（宽严判定、管理员设备签名门限、版本单调、有效期）、连接器登记、设备签名请求、安全码、许可。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { canonicalJson, generateDeviceKeys, generateFirmRoot, issueDeviceCertificate, type DeviceCertificate, type DeviceRole } from "@zr-legal/keys";
import {
  adminSign,
  connectorSigningBytes,
  evaluateConnector,
  evaluatePolicy,
  openEnvelope,
  policyRelaxations,
  policySigningBytes,
  safetyCode,
  sealEnvelope,
  signDeviceRequest,
  signersStillSufficient,
  stricterBody,
  stricterSummary,
  strictestTemplate,
  validateSummary,
  verifyAdminSignatures,
  MAX_POLICY_VERSION_JUMP,
  MAX_FIRST_VERSION,
  isUnrecognizedFormat,
  unrecognizedNewerVersion,
  validatePolicyDoc,
  validateLicense,
  validatePolicyBody,
  verifyDeviceRequest,
  type FirmConnectorDoc,
  type FirmPolicyBody,
  type FirmPolicyDoc,
} from "../src/index.ts";

const TID = "ten_trust";
const DAY = 24 * 3600 * 1000;
const NOW = Date.parse("2026-10-12T08:00:00.000Z");
const root = generateFirmRoot();
const otherRoot = generateFirmRoot();

function device(role: DeviceRole, member: string, id: string, rootPriv = root.privateKeyPem): { cert: DeviceCertificate; signPrivateKeyPem: string } {
  const k = generateDeviceKeys();
  const cert = issueDeviceCertificate(rootPriv, {
    certId: `cert_${id}`,
    memberId: member,
    deviceId: id,
    role,
    signPublicKeyPem: k.signPublicKeyPem,
    encPublicKeyPem: k.encPublicKeyPem,
    issuedAt: new Date(NOW - DAY).toISOString(),
    expiresAt: new Date(NOW + 365 * DAY).toISOString(),
  });
  return { cert, signPrivateKeyPem: k.signPrivateKeyPem };
}

const adminA = device("admin", "usr_a", "dev_a");
const adminA2 = device("admin", "usr_a", "dev_a2");
const adminB = device("admin", "usr_b", "dev_b");
const lawyer = device("lawyer", "usr_l", "dev_l");
const foreignAdmin = device("admin", "usr_x", "dev_x", otherRoot.privateKeyPem);

function doc(body: FirmPolicyBody, version = 2, o: { iat?: number; days?: number; tid?: string } = {}): FirmPolicyDoc {
  const iat = o.iat ?? NOW - 60_000;
  return { kind: "kwl-firm-policy", v: 1, tid: o.tid ?? TID, version, issued_at: new Date(iat).toISOString(), expires_at: new Date(iat + (o.days ?? 30) * DAY).toISOString(), body };
}

const RELAXED: FirmPolicyBody = { max_mode: "auto", auto_preauthorizations: ["search_generalized"], fetch_allowlist_extra: ["example-firm.cn"], l3a_standard_model: "allow" };
const ctx = (o: Partial<Parameters<typeof evaluatePolicy>[1]> = {}) => ({
  tid: TID,
  rootPublicKeyPem: root.publicKeyPem,
  adminThreshold: 1,
  highWater: null,
  revokedDevices: new Set<string>(),
  now: new Date(NOW),
  ...o,
});
const signWith = (d: FirmPolicyDoc, ...signers: { cert: DeviceCertificate; signPrivateKeyPem: string }[]) => ({
  doc: d,
  admin_signatures: signers.map((s) => adminSign(policySigningBytes(d), s.cert, s.signPrivateKeyPem)),
});

test("控制面信封：签名有效才打开；改动正文、未知 kid、种类不符一律无效", () => {
  const k = generateKeyPairSync("ed25519");
  const keys = new Map([["cp1", k.publicKey]]);
  const env = sealEnvelope("kwl-license", { tid: TID, n: 1 }, { kid: "cp1", privateKey: k.privateKey });
  assert.equal(openEnvelope(env, "kwl-license", keys).ok, true);
  assert.equal(openEnvelope({ ...env, body: { tid: TID, n: 2 } }, "kwl-license", keys).ok, false);
  assert.equal(openEnvelope({ ...env, kid: "cp2" }, "kwl-license", keys).ok, false);
  assert.equal(openEnvelope(env, "kwl-device-directory", keys).ok, false);
  assert.equal(openEnvelope(JSON.parse(JSON.stringify(env)), "kwl-license", keys).ok, true, "JSON 往返后仍可验");
});

test("策略正文：不认识的字段、非自动档的预授权、非法域名一律不合法；最严模板没有放宽项", () => {
  assert.equal(validatePolicyBody({ ...strictestTemplate(), extra_field: 1 }).ok, false);
  assert.equal(validatePolicyBody({ ...strictestTemplate(), auto_preauthorizations: ["search_generalized"] }).ok, false);
  assert.equal(validatePolicyBody({ ...strictestTemplate(), fetch_allowlist_extra: ["Example.CN"] }).ok, false);
  assert.equal(validatePolicyBody({ ...strictestTemplate(), max_mode: "full" }).ok, false);
  assert.equal(validatePolicyBody(RELAXED).ok, true);
  assert.deepEqual(policyRelaxations(strictestTemplate()), []);
  assert.deepEqual(policyRelaxations({ ...strictestTemplate(), max_mode: "manual" }), [], "比最严模板更严不是放宽");
  assert.deepEqual(policyRelaxations(RELAXED), ["max_mode:auto", "auto_preauthorization:search_generalized", "fetch_allowlist:example-firm.cn", "l3a_standard_model:allow"]);
});

test("不比最严模板宽的策略只需控制面签名；放宽项须管理员设备签名（证书由本所律所根签发、角色 admin、未吊销）", () => {
  assert.equal(evaluatePolicy({ doc: doc(strictestTemplate()), admin_signatures: [] }, ctx()).ok, true);
  const unsigned = evaluatePolicy({ doc: doc(RELAXED), admin_signatures: [] }, ctx());
  assert.equal(unsigned.ok, false);
  assert.equal(!unsigned.ok && unsigned.code, "relaxation_unsigned");
  const good = evaluatePolicy(signWith(doc(RELAXED), adminA), ctx());
  assert.equal(good.ok, true);
  assert.deepEqual(good.ok && good.signers, ["usr_a"]);
  for (const [who, why] of [
    [foreignAdmin, "其他律所根签发的管理员证书"],
    [lawyer, "非管理员设备"],
  ] as const) {
    const v = evaluatePolicy(signWith(doc(RELAXED), who), ctx());
    assert.equal(v.ok, false, why);
  }
  assert.equal(evaluatePolicy(signWith(doc(RELAXED), adminA), ctx({ revokedDevices: new Set(["dev_a"]) })).ok, false, "签名设备已吊销");
  // 签名覆盖整份文档：签名后改版本号、正文或有效期即失效（复核 S6-B05：有效期同样覆盖）
  const signed = signWith(doc(RELAXED, 2), adminA);
  assert.equal(evaluatePolicy({ ...signed, doc: { ...signed.doc, version: 3 } }, ctx()).ok, false);
  assert.equal(evaluatePolicy({ ...signed, doc: { ...signed.doc, body: { ...RELAXED, fetch_allowlist_extra: ["other.cn"] } } }, ctx()).ok, false);
  assert.equal(evaluatePolicy({ ...signed, doc: { ...signed.doc, expires_at: new Date(NOW + 29 * DAY).toISOString() } }, ctx()).ok, false);
});

test("管理员签名门限按不同成员计：律所版 2 名，同一管理员的两台设备只算一名", () => {
  assert.equal(evaluatePolicy(signWith(doc(RELAXED), adminA), ctx({ adminThreshold: 2 })).ok, false);
  assert.equal(evaluatePolicy(signWith(doc(RELAXED), adminA, adminA2), ctx({ adminThreshold: 2 })).ok, false, "同一成员两台设备");
  assert.equal(evaluatePolicy(signWith(doc(RELAXED), adminA, adminB), ctx({ adminThreshold: 2 })).ok, true);
});

test("版本单调：低于高水位为回放；同版本同内容不算变化；同版本不同内容为冲突", () => {
  const cur = signWith(doc(RELAXED, 5), adminA);
  const first = evaluatePolicy(cur, ctx());
  assert.ok(first.ok);
  const hw = { version: 5, digest: first.ok ? first.digest : "" };
  const old = evaluatePolicy(signWith(doc(RELAXED, 4), adminA), ctx({ highWater: hw }));
  assert.equal(!old.ok && old.code, "replayed");
  const again = evaluatePolicy(cur, ctx({ highWater: hw }));
  assert.equal(again.ok && again.unchanged, true);
  const conflict = evaluatePolicy(signWith(doc(strictestTemplate(), 5), adminA), ctx({ highWater: hw }));
  assert.equal(!conflict.ok && conflict.code, "version_conflict");
  // 回放的旧版本即使已过期也按“回放”判定
  const oldExpired = evaluatePolicy(signWith(doc(RELAXED, 3, { iat: NOW - 40 * DAY }), adminA), ctx({ highWater: hw }));
  assert.equal(!oldExpired.ok && oldExpired.code, "replayed");
});

test("有效期：超过 30 天、签发在未来、已过期、属于其他租户一律拒绝", () => {
  const code = (v: ReturnType<typeof evaluatePolicy>) => (v.ok ? "ok" : v.code);
  assert.equal(code(evaluatePolicy({ doc: doc(strictestTemplate(), 2, { days: 31 }), admin_signatures: [] }, ctx())), "ttl_too_long");
  assert.equal(code(evaluatePolicy({ doc: doc(strictestTemplate(), 2, { iat: NOW + 3600_000 }), admin_signatures: [] }, ctx())), "not_yet_valid");
  assert.equal(code(evaluatePolicy({ doc: doc(strictestTemplate(), 2, { iat: NOW - 31 * DAY, days: 30 }), admin_signatures: [] }, ctx())), "expired");
  assert.equal(code(evaluatePolicy({ doc: doc(strictestTemplate(), 2, { tid: "ten_other" }), admin_signatures: [] }, ctx())), "tenant_mismatch");
  assert.equal(code(evaluatePolicy({ doc: { ...doc(strictestTemplate()), extra: 1 } as never, admin_signatures: [] }, ctx())), "malformed");
});

test("连接器登记：一律须管理员设备签名；版本单调；工具清单按 schema hash 锁定", () => {
  const c: FirmConnectorDoc = {
    kind: "kwl-firm-connector",
    v: 1,
    tid: TID,
    connector_id: "firm-dms",
    version: 1,
    name: "本所文档管理系统",
    server: "firm-dms",
    url: "https://dms.example-firm.cn/mcp",
    max_data_level: "L2",
    tools: [{ name: "dms.search", side_effect: "read", schema_hash: "a".repeat(64) }],
    registered_at: new Date(NOW).toISOString(),
  };
  const cctx = { tid: TID, rootPublicKeyPem: root.publicKeyPem, adminThreshold: 1, highWater: null, revokedDevices: new Set<string>(), now: new Date(NOW) };
  const unsigned = evaluateConnector({ doc: c, admin_signatures: [] }, cctx);
  assert.equal(!unsigned.ok && unsigned.code, "unsigned");
  const signed = { doc: c, admin_signatures: [adminSign(connectorSigningBytes(c), adminA.cert, adminA.signPrivateKeyPem)] };
  const ok = evaluateConnector(signed, cctx);
  assert.equal(ok.ok, true);
  assert.equal(evaluateConnector({ doc: c, admin_signatures: [adminSign(connectorSigningBytes(c), foreignAdmin.cert, foreignAdmin.signPrivateKeyPem)] }, cctx).ok, false);
  const replay = evaluateConnector(signed, { ...cctx, highWater: { version: 2, digest: "x" } });
  assert.equal(!replay.ok && replay.code, "replayed");
  assert.equal(evaluateConnector({ doc: { ...c, tools: [{ name: "dms.search", side_effect: "read", schema_hash: "nothex" }] }, admin_signatures: [] }, cctx).ok, false);
  assert.equal(evaluateConnector({ doc: { ...c, max_data_level: "L3b" }, admin_signatures: [] }, cctx).ok, false, "L3b 不可接收");
  // 首次接受（本机尚无该连接器的高水位）的版本号同样有绝对上限（复核 S6-B29、S6-C06）
  const big = { ...c, version: MAX_FIRST_VERSION + 1 };
  const first = evaluateConnector({ doc: big, admin_signatures: [adminSign(connectorSigningBytes(big), adminA.cert, adminA.signPrivateKeyPem)] }, cctx);
  assert.equal(!first.ok && first.code, "version_jump");
});

test("设备签名请求：方法、路径、请求体、租户与设备都在签名内；过时、重放、未知设备拒绝", () => {
  const seen = new Set<string>();
  const o = { publicKeyFor: (tid: string, d: string) => (tid === TID && d === "dev_l" ? lawyer.cert.signPublicKeyPem : null), now: NOW, seenNonce: (k: string) => (seen.has(k) ? true : (seen.add(k), false)) };
  const h = signDeviceRequest({ method: "POST", path: "/v1/seat-token", body: "{}", tid: TID, deviceId: "dev_l", signPrivateKeyPem: lawyer.signPrivateKeyPem, now: NOW });
  assert.equal(verifyDeviceRequest(h, { method: "POST", path: "/v1/seat-token", body: "{}" }, o).ok, true);
  const r2 = verifyDeviceRequest(h, { method: "POST", path: "/v1/seat-token", body: "{}" }, o);
  assert.equal(!r2.ok && r2.reason, "device_auth_replayed");
  const h2 = signDeviceRequest({ method: "POST", path: "/v1/seat-token", body: "{}", tid: TID, deviceId: "dev_l", signPrivateKeyPem: lawyer.signPrivateKeyPem, now: NOW });
  assert.equal(verifyDeviceRequest(h2, { method: "POST", path: "/v1/policy", body: "{}" }, o).ok, false, "路径不符");
  const h3 = signDeviceRequest({ method: "POST", path: "/v1/seat-token", body: "{}", tid: TID, deviceId: "dev_l", signPrivateKeyPem: lawyer.signPrivateKeyPem, now: NOW });
  assert.equal(verifyDeviceRequest(h3, { method: "POST", path: "/v1/seat-token", body: '{"x":1}' }, o).ok, false, "请求体不符");
  const stale = signDeviceRequest({ method: "GET", path: "/v1/license", body: "", tid: TID, deviceId: "dev_l", signPrivateKeyPem: lawyer.signPrivateKeyPem, now: NOW - 10 * 60_000 });
  assert.equal(verifyDeviceRequest(stale, { method: "GET", path: "/v1/license", body: "" }, o).ok, false);
  const other = signDeviceRequest({ method: "GET", path: "/v1/license", body: "", tid: TID, deviceId: "dev_q", signPrivateKeyPem: lawyer.signPrivateKeyPem, now: NOW });
  assert.equal(verifyDeviceRequest(other, { method: "GET", path: "/v1/license", body: "" }, o).ok, false);
});

test("安全码：6 组 5 位数字；公钥变了安全码就变", () => {
  const code = safetyCode(adminA.cert);
  assert.match(code, /^\d{5}( \d{5}){5}$/);
  assert.notEqual(code, safetyCode(adminB.cert));
  assert.equal(code, safetyCode({ signPublicKeyPem: adminA.cert.signPublicKeyPem, encPublicKeyPem: adminA.cert.encPublicKeyPem }));
});

test("许可：有效期 ≤ 30 天、租户相符、版本合法", () => {
  const lic = { tid: TID, edition: "team", seats: 5, issued_at: new Date(NOW).toISOString(), expires_at: new Date(NOW + 30 * DAY).toISOString() };
  assert.equal(validateLicense(lic, TID).ok, true);
  assert.equal(validateLicense({ ...lic, expires_at: new Date(NOW + 31 * DAY).toISOString() }, TID).ok, false);
  assert.equal(validateLicense(lic, "ten_other").ok, false);
  assert.equal(validateLicense({ ...lic, edition: "enterprise" }, TID).ok, false);
});

test("逐项取更严（复核 S6-A09）：律所选“手动”的策略回退时不会回到“默认”；名单取交集；L3a 任一不放开即不放开", () => {
  const manual: FirmPolicyBody = { ...strictestTemplate(), max_mode: "manual" };
  assert.equal(stricterBody(strictestTemplate(), manual).max_mode, "manual");
  assert.equal(stricterBody(strictestTemplate(), RELAXED).max_mode, "default");
  assert.deepEqual(stricterBody(RELAXED, { ...RELAXED, fetch_allowlist_extra: [] }).fetch_allowlist_extra, []);
  assert.equal(stricterBody(RELAXED, strictestTemplate()).l3a_standard_model, "deny");
});

test("管理员签名只认核验通过的条目（复核 S6-B03、S6-B26）：按设备与公钥去重；映射不受伪造条目影响；签名人吊销后按成员重算门限", () => {
  const d = doc(RELAXED);
  const bytes = policySigningBytes(d);
  const good = adminSign(bytes, adminA.cert, adminA.signPrivateKeyPem);
  // 伪造条目：设备号与 adminA 相同、成员不同、签名无效
  const bogus = { cert: { ...adminB.cert, deviceId: "dev_a" }, sig: good.sig };
  const v = verifyAdminSignatures(bytes, [good, bogus, adminSign(bytes, adminA2.cert, adminA2.signPrivateKeyPem), good], { rootPublicKeyPem: root.publicKeyPem, threshold: 2, revokedDevices: new Set(), now: new Date(NOW) });
  assert.deepEqual(v.deviceMembers, { dev_a: "usr_a", dev_a2: "usr_a" });
  assert.equal(v.verified.length, 2, "重复条目只算一次，伪造条目不保存");
  assert.equal(v.ok, false, "同一成员两台设备不够律所版门限");
  // 同一把签名公钥换一张成员不同的证书：仍只算一次
  const sameKey = issueDeviceCertificate(root.privateKeyPem, { ...adminA.cert, certId: "cert_dup", memberId: "usr_dup", deviceId: "dev_dup", issuedAt: adminA.cert.issuedAt, expiresAt: adminA.cert.expiresAt });
  const v2 = verifyAdminSignatures(bytes, [good, adminSign(bytes, sameKey, adminA.signPrivateKeyPem)], { rootPublicKeyPem: root.publicKeyPem, threshold: 2, revokedDevices: new Set(), now: new Date(NOW) });
  assert.equal(v2.members.length, 1);
  assert.equal(signersStillSufficient({ dev_a: "usr_a", dev_b: "usr_b" }, new Set(["dev_b"]), 2), false);
  assert.equal(signersStillSufficient({ dev_a: "usr_a", dev_a2: "usr_a", dev_b: "usr_b" }, new Set(["dev_a"]), 2), true, "同成员另一台设备仍有效");
});

test("版本跳跃上限（复核 S6-A13、S6-B20）：单次跳跃超过上限拒收", () => {
  const first = evaluatePolicy({ doc: doc(strictestTemplate(), 5), admin_signatures: [] }, ctx());
  assert.ok(first.ok);
  const hw = { version: 5, digest: first.ok ? first.digest : "" };
  const jump = evaluatePolicy({ doc: doc(strictestTemplate(), 5 + MAX_POLICY_VERSION_JUMP + 1), admin_signatures: [] }, ctx({ highWater: hw }));
  assert.equal(!jump.ok && jump.code, "version_jump");
  assert.equal(evaluatePolicy({ doc: doc(strictestTemplate(), 6), admin_signatures: [] }, ctx({ highWater: hw })).ok, true);
  // 首次接受（本机尚无高水位）同样有绝对上限（复核 S6-B29）
  const firstJump = evaluatePolicy({ doc: doc(strictestTemplate(), MAX_FIRST_VERSION + 1), admin_signatures: [] }, ctx());
  assert.equal(!firstJump.ok && firstJump.code, "version_jump");
  assert.equal(evaluatePolicy({ doc: doc(strictestTemplate(), MAX_FIRST_VERSION), admin_signatures: [] }, ctx()).ok, true);
});

test("不认识的格式（复核 S6-B18、S6-B30）：不认识的字段、取值与格式版本属于“更新的格式”；候选须本租户、时刻合法、版本领先且不超过上限", () => {
  const v2 = validatePolicyDoc({ ...doc(strictestTemplate(), 7), v: 2 });
  assert.ok(!v2.ok && isUnrecognizedFormat(v2.reason), "格式版本 v2");
  const field = validatePolicyDoc({ ...doc(strictestTemplate(), 7), body: { ...strictestTemplate(), retention_days: 30 } });
  assert.ok(!field.ok && isUnrecognizedFormat(field.reason), "不认识的字段");
  const kind = validatePolicyDoc({ ...doc(strictestTemplate(), 7), kind: "kwl-other" });
  assert.ok(!kind.ok && !isUnrecognizedFormat(kind.reason), "种类不符不是“更新的格式”");
  const hw = { version: 5, digest: "x" };
  const c = (version: number, o: { iat?: number; days?: number; tid?: string } = {}) => ({ doc: { ...doc(strictestTemplate(), version, o), v: 2 } });
  const opts = { tid: TID, highWater: hw, now: new Date(NOW), maxLead: 10 };
  assert.equal(unrecognizedNewerVersion(c(7), opts), 7);
  assert.equal(unrecognizedNewerVersion(c(5), opts), null, "不比已接受的新");
  assert.equal(unrecognizedNewerVersion(c(16), opts), 15, "领先超过上限：标记钳在高水位 + 10（仍回退，复核 S6-C04）");
  assert.equal(unrecognizedNewerVersion(c(5000), opts), 15);
  assert.equal(unrecognizedNewerVersion(c(7, { tid: "ten_other" }), opts), null, "其他租户");
  assert.equal(unrecognizedNewerVersion(c(7, { iat: NOW + 3600_000 }), opts), null, "签发在未来");
  assert.equal(unrecognizedNewerVersion(c(7, { iat: NOW - 40 * DAY }), opts), null, "已过期");
  assert.equal(unrecognizedNewerVersion(c(7, { days: 45 }), opts), null, "有效期超过 30 天");
  assert.equal(unrecognizedNewerVersion(c(500), { ...opts, highWater: null }), 500, "本机尚未接受过策略：不查领先幅度");
});

test("事项匿名摘要：必须带策略版本；同版本按更严合并（复核 S6-A07）", () => {
  const base = { anon: "A".repeat(22), level: "L2", endpoint: "standard", basis_complete: true, updated_at: new Date(NOW).toISOString() };
  assert.equal(validateSummary(base).ok, false, "缺版本");
  assert.equal(validateSummary({ ...base, version: 3 }).ok, true);
  const a = { ...base, version: 3 } as Parameters<typeof stricterSummary>[0];
  const merged = stricterSummary(a, { ...a, level: "L3a", basis_complete: false });
  assert.deepEqual([merged.level, merged.basis_complete], ["L3a", false]);
  assert.equal(stricterSummary(a, { ...a, endpoint: "private" }).endpoint, "private");
});

test("规范化 JSON 拒绝 __proto__ 键（复核 S6-B17：否则带与不带该键的签名字节相同）", () => {
  assert.throws(() => canonicalJson(JSON.parse('{"a":1,"__proto__":{"x":1}}')), /__proto__/);
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test("第 9 批 support_upload：可选字段（没有 = 不允许）；允许即放宽、须管理员签名；取值不合法拒绝；逐项取更严；旧策略的签名字节不变", async () => {
  const { supportUploadAllowed, validatePolicyDoc } = await import("../src/index.ts");
  const base = strictestTemplate();
  assert.equal(validatePolicyBody({ ...base, support_upload: "maybe" }).ok, false);
  const allowed = validatePolicyBody({ ...base, support_upload: "allow" });
  assert.ok(allowed.ok && supportUploadAllowed(allowed.value));
  assert.ok(!supportUploadAllowed(base));
  assert.deepEqual(policyRelaxations({ ...base, support_upload: "allow" }), ["support_upload:allow"]);
  assert.deepEqual(policyRelaxations({ ...base, support_upload: "deny" }), []);
  const unsigned = evaluatePolicy({ doc: doc({ ...base, support_upload: "allow" }), admin_signatures: [] }, ctx());
  assert.equal(unsigned.ok, false, "允许上传须管理员设备签名");
  assert.equal(stricterBody({ ...base, support_upload: "allow" }, base).support_upload, undefined);
  assert.equal(stricterBody({ ...base, support_upload: "allow" }, { ...base, support_upload: "allow" }).support_upload, "allow");
  // 第 9 批之前签发的策略不含此字段：核验后的文档仍不含它，签名字节与原文一致
  const old = doc(base);
  const v = validatePolicyDoc(JSON.parse(JSON.stringify(old)));
  assert.ok(v.ok);
  assert.equal(v.ok && "support_upload" in v.value.body, false);
  assert.ok(v.ok && policySigningBytes(v.value).equals(policySigningBytes(old)));
});

test("复核 S9B-01、S9B-06：未升级客户端遇到 support_upload 判为“更新的格式”（整份回退最严）；将来的新取值同样按更新的格式", async () => {
  const { isUnrecognizedFormat } = await import("../src/index.ts");
  // 第 8 批客户端的 validatePolicyBody 对未知字段返回 unknown_field:<字段>
  assert.equal(isUnrecognizedFormat("unknown_field:support_upload"), true);
  assert.equal(validatePolicyBody({ ...strictestTemplate(), support_upload: "ask_admin" }).ok, false);
  const r = validatePolicyBody({ ...strictestTemplate(), support_upload: "ask_admin" });
  assert.equal(!r.ok && isUnrecognizedFormat(r.reason), true, "不认识的取值不沿用可能更宽的旧策略");
});

test("第 11 批 share_relay：可选字段（没有 = 不允许）；允许即放宽、须管理员签名；取值不合法按更新的格式；逐项取更严；与 support_upload 互不影响；旧策略签名字节不变", async () => {
  const { shareRelayAllowed, supportUploadAllowed, validatePolicyDoc, isUnrecognizedFormat } = await import("../src/index.ts");
  const base = strictestTemplate();
  const bad = validatePolicyBody({ ...base, share_relay: "members_only" });
  assert.equal(!bad.ok && bad.reason, "share_relay_invalid");
  assert.equal(!bad.ok && isUnrecognizedFormat(bad.reason), true, "不认识的取值整份回退最严");
  assert.equal(isUnrecognizedFormat("unknown_field:share_relay"), true, "第 10 批客户端遇到此字段按更新的格式");
  const allowed = validatePolicyBody({ ...base, share_relay: "allow" });
  assert.ok(allowed.ok && shareRelayAllowed(allowed.value) && !supportUploadAllowed(allowed.value));
  assert.ok(!shareRelayAllowed(base));
  assert.deepEqual(policyRelaxations({ ...base, share_relay: "allow", support_upload: "allow" }), ["support_upload:allow", "share_relay:allow"]);
  assert.deepEqual(policyRelaxations({ ...base, share_relay: "deny" }), []);
  assert.equal(evaluatePolicy({ doc: doc({ ...base, share_relay: "allow" }), admin_signatures: [] }, ctx()).ok, false, "允许经中继同步须管理员设备签名");
  assert.equal(stricterBody({ ...base, share_relay: "allow" }, base).share_relay, undefined);
  assert.equal(stricterBody({ ...base, share_relay: "allow" }, { ...base, share_relay: "allow" }).share_relay, "allow");
  const old = doc(base);
  const v = validatePolicyDoc(JSON.parse(JSON.stringify(old)));
  assert.ok(v.ok && !("share_relay" in v.value.body) && policySigningBytes(v.value).equals(policySigningBytes(old)));
});
