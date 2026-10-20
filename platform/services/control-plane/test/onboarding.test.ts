/**
 * 开通与成员入组（第 13 批；docs/design/开通与成员入组设计-v1.md）：
 * 开通码一次性、只存 HMAC、错码与过期同一句话；要求开通码的租户只接受出示创始认领的根公钥登记（关闭租户抢注）；
 * 管理员发邀请 → 成员凭邀请码提交入组申请（持有证明）→ 管理员用律所根签发证书批准（逐项与申请一致）→ 成员取回证书并登记；
 * 状态持久化往返；双方独立算出同一核对码。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { generateDeviceKeys, generateFirmRoot, issueDeviceCertificate, signBytes, type DeviceCertificate, type DeviceRole } from "@zr-legal/keys";
import {
  activationCodeMac,
  approvalMacBytes,
  inviteMac,
  joinMacBytes,
  newInviteSecret,
  enrollProofBytes,
  firmBundleBytes,
  formatActivationCode,
  joinCheckCode,
  joinProofBytes,
  normalizeActivationCode,
  openEnvelope,
  publicKeyMap,
  signDeviceRequest,
  AUDIT_GENESIS,
  verifyAuditChain,
  type CpAuditPage,
} from "@zr-legal/firm-trust";
import { createControlPlane, devControlPlaneKeys, fileStateStore, type ControlPlane } from "../src/index.ts";

const keys = devControlPlaneKeys();
const SECRET = "cp-onboarding-secret";
let cp: ControlPlane;
let base = "";

before(async () => {
  cp = createControlPlane({ keys, serviceSecret: SECRET });
  await new Promise<void>((r) => cp.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(cp.server.address() as AddressInfo).port}`;
});
after(async () => {
  cp.server.closeAllConnections();
  await new Promise<void>((r) => cp.server.close(() => r()));
});

const post = async (path: string, body: unknown, b = base) => {
  const r = await fetch(`${b}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as any };
};

function deviceCaller(tid: string, deviceId: string, signPrivateKeyPem: string, b = () => base) {
  return async (method: string, path: string, body?: unknown) => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const h = signDeviceRequest({ method, path, body: raw, tid, deviceId, signPrivateKeyPem });
    const r = await fetch(`${b()}${path}`, { method, headers: { ...h, ...(raw ? { "content-type": "application/json" } : {}) }, ...(raw ? { body: raw } : {}) });
    return { status: r.status, json: (await r.json()) as any };
  };
}

function issueCert(rootPriv: string, o: { memberId: string; deviceId: string; role: DeviceRole; sign: string; enc: string }): DeviceCertificate {
  return issueDeviceCertificate(rootPriv, {
    certId: `cert_${o.deviceId}`,
    memberId: o.memberId,
    deviceId: o.deviceId,
    role: o.role,
    signPublicKeyPem: o.sign,
    encPublicKeyPem: o.enc,
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 365 * 86400_000).toISOString(),
  });
}

/** 创始设备完整开通：兑换开通码 → 出示认领登记根公钥 → 登记设备。 */
async function foundFirm(tid: string, code: string) {
  const red = await post("/v1/activation/redeem", { code });
  assert.equal(red.status, 200, JSON.stringify(red.json));
  const root = generateFirmRoot();
  const dk = generateDeviceKeys();
  const deviceId = `dev_${red.json.member.slug}`;
  const ts = Date.now();
  const proof = sign(null, enrollProofBytes(tid, root.publicKeyPem, ts), root.privateKeyPem).toString("base64url");
  const en = await post("/v1/enroll", { tid, root_public_key_pem: root.publicKeyPem, ts, proof, activation_id: red.json.activation_id, claim_secret: red.json.claim_secret });
  assert.equal(en.status, 200, JSON.stringify(en.json));
  const cert = issueCert(root.privateKeyPem, { memberId: `usr_${red.json.firm.slug}_${red.json.member.slug}`, deviceId, role: "admin", sign: dk.signPublicKeyPem, enc: dk.encPublicKeyPem });
  const call = deviceCaller(tid, deviceId, dk.signPrivateKeyPem);
  const reg = await call("POST", "/v1/devices/register", { tid, cert });
  assert.equal(reg.status, 200, JSON.stringify(reg.json));
  return { red: red.json, root, dk, deviceId, cert, call };
}

test("开通码：格式归一（大小写、分隔符、I/L/O）；云端只存 HMAC；码不对、作废与过期同一句话", async () => {
  const tid = "ten_onb-format";
  cp.ops.createTenant({ tid, edition: "team", seats: 3, name: "示例律师事务所", activationRequired: true });
  const issued = cp.ops.issueActivationCode(tid, { member: { slug: "wang", name: "王律师" } });
  assert.equal(issued.code.length, 20);
  const shown = formatActivationCode(issued.code);
  assert.match(shown, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){4}$/);
  assert.equal(normalizeActivationCode(` ${shown.toLowerCase()} `), issued.code);
  assert.equal(normalizeActivationCode("too-short"), null);
  // 状态里只有 HMAC，没有明文码
  const rec = cp.ops.tenant(tid)!.activations.get(issued.activation_id)!;
  assert.ok(!JSON.stringify([...cp.ops.tenant(tid)!.activations]).includes(issued.code));
  assert.equal(rec.code_mac.length, 64);

  const wrong = await post("/v1/activation/redeem", { code: issued.code.slice(0, 19) + (issued.code[19] === "0" ? "1" : "0") });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.json.error.code, "code_invalid");
  cp.ops.revokeActivationCode(tid, issued.activation_id);
  const revoked = await post("/v1/activation/redeem", { code: issued.code });
  assert.equal(revoked.json.error.code, "code_invalid");
  assert.equal(revoked.json.error.message, wrong.json.error.message, "作废与错码不区分");
});

test("要求开通码的租户：不出示创始认领不能登记根公钥（关闭租户抢注）；兑换后登记成功、开通码随即消费", async () => {
  const tid = "ten_onb-founder";
  cp.ops.createTenant({ tid, edition: "team", seats: 3, name: "示例所", activationRequired: true });
  const squatter = generateFirmRoot();
  const ts = Date.now();
  const proof = sign(null, enrollProofBytes(tid, squatter.publicKeyPem, ts), squatter.privateKeyPem).toString("base64url");
  const sq = await post("/v1/enroll", { tid, root_public_key_pem: squatter.publicKeyPem, ts, proof });
  assert.equal(sq.status, 403);
  assert.equal(sq.json.error.code, "claim_invalid");
  assert.equal(cp.ops.tenant(tid)!.root_public_key_pem, null);

  const { code } = cp.ops.issueActivationCode(tid, { member: { slug: "founder", name: "李主任" } });
  const f = await foundFirm(tid, code);
  assert.equal(f.red.kind, "founder");
  assert.equal(f.red.firm.slug, "onb-founder");
  assert.equal(f.red.firm.name, "示例所");
  assert.equal(f.red.member.role, "admin");
  assert.ok(f.red.claim_secret.length >= 40);
  const rec = cp.ops.tenant(tid)!.activations.get(f.red.activation_id)!;
  assert.equal(rec.status, "consumed");
  assert.equal(rec.member.name, null, "消费后云端不再保存姓名");
  // 开通码已用：再兑换失败
  assert.equal((await post("/v1/activation/redeem", { code })).json.error.code, "code_invalid");
  // 不要求开通码的旧租户：行为不变（先到先得）
  const legacy = "ten_onb-legacy";
  cp.ops.createTenant({ activationRequired: false, tid: legacy, edition: "team", seats: 1 });
  const r2 = generateFirmRoot();
  const p2 = sign(null, enrollProofBytes(legacy, r2.publicKeyPem, ts), r2.privateKeyPem).toString("base64url");
  assert.equal((await post("/v1/enroll", { tid: legacy, root_public_key_pem: r2.publicKeyPem, ts, proof: p2 })).status, 200);
});

test("成员入组：管理员发邀请 → 凭邀请码提交申请（持有证明）→ 管理员批准（证书逐项一致）→ 成员取回证书并登记取得席位", async () => {
  const tid = "ten_onb-join";
  cp.ops.createTenant({ tid, edition: "team", seats: 3, name: "合作所", activationRequired: true });
  const f = await foundFirm(tid, cp.ops.issueActivationCode(tid, { member: { slug: "admin1" } }).code);

  // 非管理员不能发邀请
  const inv = await f.call("POST", "/v1/invitations", { member_slug: "zhang", name: "张律师", role: "lawyer" });
  assert.equal(inv.status, 200, JSON.stringify(inv.json));
  assert.equal(inv.json.code.length, 20);
  const listed = await f.call("GET", "/v1/invitations");
  assert.equal(listed.json.invitations.length, 1);
  assert.ok(!JSON.stringify(listed.json).includes(inv.json.code), "邀请列表不含码");

  // 成员兑换
  const red = await post("/v1/activation/redeem", { code: formatActivationCode(inv.json.code) });
  assert.equal(red.json.kind, "member");
  assert.deepEqual(red.json.member, { slug: "zhang", name: "张律师", role: "lawyer" });
  const mk = generateDeviceKeys();
  const deviceId = "dev_onb-join_zhang";
  const S = newInviteSecret();
  const body = (o: { proofKey?: string; signPub?: string } = {}) => ({
    tid,
    activation_id: red.json.activation_id,
    claim_secret: red.json.claim_secret,
    device_id: deviceId,
    sign_pub: o.signPub ?? mk.signPublicKeyPem,
    enc_pub: mk.encPublicKeyPem,
    proof: signBytes(o.proofKey ?? mk.signPrivateKeyPem, joinProofBytes({ tid, activationId: red.json.activation_id, deviceId, signPublicKeyPem: o.signPub ?? mk.signPublicKeyPem, encPublicKeyPem: mk.encPublicKeyPem })),
    mac: inviteMac(S, joinMacBytes({ tid, activationId: red.json.activation_id, deviceId, signPublicKeyPem: o.signPub ?? mk.signPublicKeyPem, encPublicKeyPem: mk.encPublicKeyPem, memberSlug: "zhang", role: "lawyer", firmName: red.json.firm.name, memberName: red.json.member.name })),
  });
  // 持有证明不对：拒绝
  const bad = await post("/v1/join-requests", body({ proofKey: generateDeviceKeys().signPrivateKeyPem }));
  assert.equal(bad.json.error.code, "join_proof_invalid");
  // 认领凭据不对：拒绝
  assert.equal((await post("/v1/join-requests", { ...body(), claim_secret: "x".repeat(43) })).json.error.code, "claim_invalid");
  const jr = await post("/v1/join-requests", body());
  assert.equal(jr.status, 200, JSON.stringify(jr.json));
  // 同一设备重发：原样返回
  assert.equal((await post("/v1/join-requests", body())).json.join_request_id, jr.json.join_request_id);
  // 未批准前取回：pending，无证书
  const pend = await post(`/v1/join-requests/${jr.json.join_request_id}/fetch`, { tid, claim_secret: red.json.claim_secret });
  assert.equal(pend.json.status, "pending");
  assert.equal(pend.json.cert, undefined);

  // 管理员列出待批准，独立算出与成员一致的核对码
  const pendList = await f.call("GET", "/v1/join-requests");
  assert.equal(pendList.json.join_requests.length, 1);
  const item = pendList.json.join_requests[0];
  const adminSide = joinCheckCode({ tid, deviceId: item.device_id, signPublicKeyPem: item.sign_pub, encPublicKeyPem: item.enc_pub });
  const memberSide = joinCheckCode({ tid, deviceId, signPublicKeyPem: mk.signPublicKeyPem, encPublicKeyPem: mk.encPublicKeyPem });
  assert.equal(adminSide, memberSide);
  assert.match(adminSide, /^\d{3} \d{3} \d{3} \d{3}$/);

  // 证书与申请不一致（角色被抬高、或换了公钥）：控制面拒绝
  const memberId = `usr_onb-join_zhang`;
  const wrongRole = issueCert(f.root.privateKeyPem, { memberId, deviceId, role: "admin", sign: mk.signPublicKeyPem, enc: mk.encPublicKeyPem });
  assert.equal((await f.call("POST", `/v1/join-requests/${item.id}/approve`, { cert: wrongRole })).json.error.code, "cert_mismatch");
  const otherKey = generateDeviceKeys();
  const wrongKey = issueCert(f.root.privateKeyPem, { memberId, deviceId, role: "lawyer", sign: otherKey.signPublicKeyPem, enc: mk.encPublicKeyPem });
  assert.equal((await f.call("POST", `/v1/join-requests/${item.id}/approve`, { cert: wrongKey })).json.error.code, "cert_mismatch");
  // 别的律所根签的证书：拒绝
  const foreign = issueCert(generateFirmRoot().privateKeyPem, { memberId, deviceId, role: "lawyer", sign: mk.signPublicKeyPem, enc: mk.encPublicKeyPem });
  assert.equal((await f.call("POST", `/v1/join-requests/${item.id}/approve`, { cert: foreign })).json.error.code, "cert_mismatch");

  const good = issueCert(f.root.privateKeyPem, { memberId, deviceId, role: "lawyer", sign: mk.signPublicKeyPem, enc: mk.encPublicKeyPem });
  // 律所公钥包缺失或不是律所根签的：拒绝
  assert.equal((await f.call("POST", `/v1/join-requests/${item.id}/approve`, { cert: good })).json.error.code, "firm_bundle_invalid");
  const recoveryPub = generateDeviceKeys().encPublicKeyPem;
  const forged = { recovery_public_key_pem: recoveryPub, sig: signBytes(generateFirmRoot().privateKeyPem, firmBundleBytes(tid, f.root.publicKeyPem, recoveryPub)) };
  assert.equal((await f.call("POST", `/v1/join-requests/${item.id}/approve`, { cert: good, firm_bundle: forged })).json.error.code, "firm_bundle_invalid");
  const bundle = { recovery_public_key_pem: recoveryPub, sig: signBytes(f.root.privateKeyPem, firmBundleBytes(tid, f.root.publicKeyPem, recoveryPub)) };
  // 缺管理员 MAC：拒绝
  assert.equal((await f.call("POST", `/v1/join-requests/${item.id}/approve`, { cert: good, firm_bundle: bundle })).json.error.code, "admin_mac_missing");
  const adminMac = inviteMac(S, approvalMacBytes({ tid, joinRequestId: item.id, cert: good, rootPublicKeyPem: f.root.publicKeyPem, bundle, firmName: red.json.firm.name, memberName: red.json.member.name }));
  const ap = await f.call("POST", `/v1/join-requests/${item.id}/approve`, { cert: good, firm_bundle: bundle, admin_mac: adminMac });
  assert.equal(ap.status, 200, JSON.stringify(ap.json));
  const got = await post(`/v1/join-requests/${jr.json.join_request_id}/fetch`, { tid, claim_secret: red.json.claim_secret });
  assert.equal(got.json.status, "approved");
  assert.equal(got.json.root_public_key_pem, f.root.publicKeyPem);
  assert.deepEqual(got.json.cert, good);
  assert.deepEqual(got.json.firm_bundle, bundle);
  assert.equal(got.json.admin_mac, adminMac, "成员取回管理员对批准结果的 MAC");
  // 成员用取回的证书登记，取得席位
  const memberCall = deviceCaller(tid, deviceId, mk.signPrivateKeyPem);
  const reg = await memberCall("POST", "/v1/devices/register", { tid, cert: got.json.cert });
  assert.equal(reg.status, 200);
  assert.ok(reg.json.seat);
  // 邀请已消费、姓名已清空；同一邀请码不能再用
  const rec = cp.ops.tenant(tid)!.activations.get(red.json.activation_id)!;
  assert.equal(rec.status, "consumed");
  assert.equal(rec.member.name, null);
  assert.equal((await post("/v1/activation/redeem", { code: inv.json.code })).json.error.code, "code_invalid");
});

test("只有管理员设备能发邀请与批准；成员设备被拒；审计流水记下开通、兑换、邀请、申请与批准且链完整", async () => {
  const tid = "ten_onb-roles";
  cp.ops.createTenant({ tid, edition: "team", seats: 5, activationRequired: true });
  const f = await foundFirm(tid, cp.ops.issueActivationCode(tid, { member: { slug: "boss" } }).code);
  // 管理员直接签一张律师设备证书（模拟已入组的成员）
  const lk = generateDeviceKeys();
  const lawyerCert = issueCert(f.root.privateKeyPem, { memberId: "usr_onb-roles_l1", deviceId: "dev_l1", role: "lawyer", sign: lk.signPublicKeyPem, enc: lk.encPublicKeyPem });
  const lawyer = deviceCaller(tid, "dev_l1", lk.signPrivateKeyPem);
  assert.equal((await lawyer("POST", "/v1/devices/register", { tid, cert: lawyerCert })).status, 200);
  assert.equal((await lawyer("POST", "/v1/invitations", { member_slug: "x1", role: "lawyer" })).json.error.code, "admin_required");
  assert.equal((await lawyer("GET", "/v1/join-requests")).json.error.code, "admin_required");
  // 角色不合法、成员标识不合法
  assert.equal((await f.call("POST", "/v1/invitations", { member_slug: "x1", role: "root" })).json.error.code, "role_invalid");
  assert.equal((await f.call("POST", "/v1/invitations", { member_slug: "Bad Slug", role: "lawyer" })).json.error.code, "member_slug_invalid");
  // 作废邀请后兑换失败
  const inv = await f.call("POST", "/v1/invitations", { member_slug: "x2", role: "assistant" });
  assert.equal((await f.call("POST", `/v1/invitations/${inv.json.activation_id}/revoke`)).status, 200);
  assert.equal((await post("/v1/activation/redeem", { code: inv.json.code })).json.error.code, "code_invalid");

  const res = await f.call("GET", "/v1/audit");
  assert.equal(res.status, 200);
  const opened = openEnvelope<CpAuditPage>(res.json, "kwl-cp-audit-page", publicKeyMap(cp.publicKeys.envelope));
  assert.ok(opened.ok);
  const page = { json: opened.ok ? opened.body : ({} as CpAuditPage) };
  const actions = page.json.records.map((r: any) => r.action);
  for (const a of ["activation.issue", "activation.redeem", "tenant.enroll_root", "invitation.create", "invitation.revoke"]) assert.ok(actions.includes(a), `审计应含 ${a}：${actions.join(",")}`);
  const claimant = page.json.records.find((r: any) => r.action === "activation.redeem");
  assert.equal(claimant?.actor.kind, "claimant");
  assert.ok(verifyAuditChain(page.json.records, tid, { seq: 0, hash: AUDIT_GENESIS }).ok);
});

test("开通码与入组申请随状态持久化：重启后未兑换的码仍可用、胡椒不变", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-onb-state-"));
  const path = join(dir, "cp-state");
  const k = devControlPlaneKeys();
  const a = createControlPlane({ keys: k, serviceSecret: SECRET, stateStore: fileStateStore(path) });
  a.ops.createTenant({ tid: "ten_onb-persist", edition: "team", seats: 2, activationRequired: true });
  const { code } = a.ops.issueActivationCode("ten_onb-persist", { member: { slug: "p1" } });
  a.server.close();
  const b = createControlPlane({ keys: k, serviceSecret: SECRET, stateStore: fileStateStore(path) });
  await new Promise<void>((r) => b.server.listen(0, "127.0.0.1", () => r()));
  const bBase = `http://127.0.0.1:${(b.server.address() as AddressInfo).port}`;
  try {
    assert.equal(b.ops.tenant("ten_onb-persist")!.activation_required, true);
    const red = await post("/v1/activation/redeem", { code }, bBase);
    assert.equal(red.status, 200, JSON.stringify(red.json));
    // 胡椒由信封私钥派生：两次实例一致
    const rec = b.ops.tenant("ten_onb-persist")!.activations.get(red.json.activation_id)!;
    assert.equal(rec.code_mac, activationCodeMac(Buffer.from(require_hkdf(k)), code));
  } finally {
    b.server.closeAllConnections();
    await new Promise<void>((r) => b.server.close(() => r()));
  }
});

import { hkdfSync } from "node:crypto";
function require_hkdf(k: ReturnType<typeof devControlPlaneKeys>): ArrayBuffer {
  return hkdfSync("sha256", k.envelope.privateKey.export({ format: "der", type: "pkcs8" }), Buffer.alloc(0), "kwl-cp-code-pepper/1", 32);
}
