/**
 * 第 9 批：运营审计流水 v0（S14：每租户哈希链、律所侧可取与验链）。额度账本的用例在第 44 批改写为 b44-quota-ledger.test.ts（v2：逐请求入账、按席位租约）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sign } from "node:crypto";
import { appendFileSync, fsyncSync, mkdtempSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDeviceKeys, generateFirmRoot, issueDeviceCertificate, type DeviceCertificate, type DeviceRole } from "@zr-legal/keys";
import { AUDIT_GENESIS, enrollProofBytes, openEnvelope, publicKeyMap, signDeviceRequest, verifyAuditChain, type CpAuditPage } from "@zr-legal/firm-trust";
import { createAuditLog, createControlPlane, devControlPlaneKeys, type ControlPlane } from "../src/index.ts";

const keys = devControlPlaneKeys();
let cp: ControlPlane;
let base = "";
const SECRET = "quota-test-service-secret";
const root = generateFirmRoot();

before(async () => {
  cp = createControlPlane({ keys, serviceSecret: SECRET });
  await new Promise<void>((r) => cp.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(cp.server.address() as AddressInfo).port}`;
});
after(async () => {
  cp.server.closeAllConnections();
  await new Promise<void>((r) => cp.server.close(() => r()));
});

function makeDevice(tid: string, role: DeviceRole, member: string, id: string) {
  const k = generateDeviceKeys();
  const cert: DeviceCertificate = issueDeviceCertificate(root.privateKeyPem, {
    certId: `cert_${id}`,
    memberId: member,
    deviceId: id,
    role,
    signPublicKeyPem: k.signPublicKeyPem,
    encPublicKeyPem: k.encPublicKeyPem,
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 365 * 86400_000).toISOString(),
  });
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const h = signDeviceRequest({ method, path, body: raw, tid, deviceId: id, signPrivateKeyPem: k.signPrivateKeyPem });
    const r = await fetch(`${base}${path}`, { method, headers: { ...h, ...(raw ? { "content-type": "application/json" } : {}) }, ...(raw ? { body: raw } : {}) });
    return { status: r.status, json: await r.json() };
  };
  return { cert, call, register: () => call("POST", "/v1/devices/register", { tid, cert }) };
}

async function enroll(tid: string): Promise<void> {
  const ts = Date.now();
  const proof = sign(null, enrollProofBytes(tid, root.publicKeyPem, ts), root.privateKeyPem).toString("base64url");
  const r = await fetch(`${base}/v1/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tid, root_public_key_pem: root.publicKeyPem, ts, proof }) });
  assert.equal(r.status, 200);
}

const service = async (path: string, body: unknown, secret = SECRET) => {
  const r = await fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as any };
};

test("运营审计流水：运营与设备的写操作逐条入链（吊销只记一次、重复登记不记、拒绝也记）；管理员与合伙人可取、律师不可；控制面签名 + 律所侧验链", async () => {
  const tid = "ten_audit_http";
  cp.ops.createTenant({ activationRequired: false, tid, edition: "team", seats: 5 });
  await enroll(tid);
  const admin = makeDevice(tid, "admin", "usr_a", "dev_aadmin");
  const partner = makeDevice(tid, "partner", "usr_p", "dev_apartner");
  const lawyer = makeDevice(tid, "lawyer", "usr_l", "dev_alaw");
  for (const d of [admin, partner, lawyer]) assert.equal((await d.register()).status, 200);
  assert.equal((await admin.register()).status, 200, "重复登记（证书未变）不记");
  cp.ops.boostQuota(tid, 25);
  assert.equal((await lawyer.call("PUT", "/v1/quota/cap", { monthly_cap_pct: 1 })).status, 403);
  assert.equal((await partner.call("POST", "/v1/devices/dev_alaw/revoke", {})).status, 200);

  assert.equal((await partner.call("GET", "/v1/audit?after=0&limit=500")).status, 200);
  assert.equal((await lawyer.call("GET", "/v1/audit?after=0&limit=500")).status, 403, "已吊销设备的请求得到吊销通知，不是流水");
  const page = openEnvelope<CpAuditPage>((await admin.call("GET", "/v1/audit?after=0&limit=500")).json, "kwl-cp-audit-page", publicKeyMap(cp.publicKeys.envelope));
  assert.ok(page.ok);
  if (!page.ok) return;
  const recs = page.body.records;
  assert.deepEqual(
    recs.map((r) => `${r.actor.kind}:${r.action}:${r.target ?? "-"}:${r.result}`),
    [
      "ops:tenant.create:-:ok",
      "root:tenant.enroll_root:-:ok",
      `device:seat.assign:seat_${tid}_1:ok`,
      "device:device.register:dev_aadmin:ok",
      `device:seat.assign:seat_${tid}_2:ok`,
      "device:device.register:dev_apartner:ok",
      `device:seat.assign:seat_${tid}_3:ok`,
      "device:device.register:dev_alaw:ok",
      "ops:quota.boost:-:ok",
      "device:quota.cap_set:-:rejected:admin_required",
      "device:device.revoke:dev_alaw:ok",
    ],
  );
  // 数值明细（复核 S9A-09）
  assert.deepEqual(recs.find((r) => r.action === "tenant.create")!.detail, { seats: 5 });
  assert.deepEqual(recs.find((r) => r.action === "quota.boost")!.detail, { pct: 25 });
  // 成员编号不进流水（复核 S9A-11）
  assert.ok(!JSON.stringify(recs).includes("usr_"), "流水里只有席位编号，没有成员编号");
  assert.equal(recs.find((r) => r.action === "device.revoke")!.actor.id, "dev_apartner");
  assert.ok(recs.every((r) => r.tid === tid));
  assert.deepEqual(verifyAuditChain(recs, tid, { seq: 0, hash: AUDIT_GENESIS }), { ok: true });
  assert.deepEqual(page.body.head, { seq: recs.at(-1)!.seq, hash: recs.at(-1)!.hash });
  // 篡改任一条即验链失败
  const forged = recs.map((r, i) => (i === 3 ? { ...r, result: "rejected:x" } : r));
  assert.equal(verifyAuditChain(forged, tid, { seq: 0, hash: AUDIT_GENESIS }).ok, false);
  // 分页：after 之后的部分以前一条为锚
  const tail = openEnvelope<CpAuditPage>((await admin.call("GET", "/v1/audit?after=5&limit=2")).json, "kwl-cp-audit-page", publicKeyMap(cp.publicKeys.envelope));
  assert.ok(tail.ok && tail.body.records.length === 2 && tail.body.records[0]!.seq === 6);
  assert.deepEqual(tail.ok && verifyAuditChain(tail.body.records, tid, { seq: 5, hash: recs[4]!.hash }), { ok: true });
  // 被拒绝记录限速（复核 S9A-10）：同一设备同一动作每分钟至多 10 条
  for (let i = 0; i < 30; i++) await partner.call("PUT", "/v1/quota/cap", { monthly_cap_pct: 1 });
  const all = openEnvelope<CpAuditPage>((await admin.call("GET", "/v1/audit?after=0&limit=500")).json, "kwl-cp-audit-page", publicKeyMap(cp.publicKeys.envelope));
  assert.ok(all.ok);
  const spam = all.ok ? all.body.records.filter((r) => r.action === "quota.cap_set" && r.actor.id === "dev_apartner").length : -1;
  assert.ok(spam <= 10, `限速后只有 ${spam} 条`);
  assert.equal((await admin.call("GET", "/v1/audit?after=0&limit=501")).status, 400);
});

test("审计流水落盘：重启读回并验链；最后半行（掉电）丢弃；中间被改即拒绝启动", () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-cp-audit-"));
  const file = join(dir, "audit.jsonl");
  const a = createAuditLog({ file });
  a.append({ tid: "t1", actor: { kind: "ops", id: "ops" }, action: "tenant.create", target: null, result: "ok" }, new Date().toISOString());
  a.append({ tid: "t2", actor: { kind: "ops", id: "ops" }, action: "tenant.create", target: null, result: "ok" }, new Date().toISOString());
  a.append({ tid: "t1", actor: { kind: "device", id: "dev_1", fp: "abcdefghijklmnop" }, action: "device.revoke", target: "dev_2", result: "ok" }, new Date().toISOString());
  a.close();
  appendFileSync(file, '{"tid":"t1","seq":3,"at"'); // 掉电留下的半行
  const b = createAuditLog({ file });
  assert.equal(b.head("t1").seq, 2);
  assert.equal(b.head("t2").seq, 1);
  b.close();
  const lines = readFileSync(file, "utf8").split("\n");
  writeFileSync(file, [lines[0], lines[1]!.replace('"tenant.create"', '"tenant.renamed"'), lines[2], ""].join("\n"));
  assert.throws(() => createAuditLog({ file }), /未通过验链/);
});

test("复核 S9A-01：成员设备在匿名摘要里塞带中文的未知键——拒绝记录只留固定代码、仍通过记录校验；落盘重启照常；不合规的租户编号拒绝开通", async () => {
  const { validAuditRecord } = await import("@zr-legal/firm-trust");
  const dir = mkdtempSync(join(tmpdir(), "kwl-cp-audit-s01-"));
  const file = join(dir, "audit.jsonl");
  const local = createControlPlane({ keys: devControlPlaneKeys(), serviceSecret: "s01-secret", auditLog: createAuditLog({ file }) });
  await new Promise<void>((r) => local.server.listen(0, "127.0.0.1", () => r()));
  const b0 = base;
  base = `http://127.0.0.1:${(local.server.address() as AddressInfo).port}`;
  try {
    const tid = "ten_s01";
    local.ops.createTenant({ activationRequired: false, tid, edition: "team", seats: 3 });
    const ts = Date.now();
    const proof = sign(null, enrollProofBytes(tid, root.publicKeyPem, ts), root.privateKeyPem).toString("base64url");
    await fetch(`${base}/v1/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tid, root_public_key_pem: root.publicKeyPem, ts, proof }) });
    const law = makeDevice(tid, "lawyer", "usr_l1", "dev_s01");
    assert.equal((await law.register()).status, 200);
    const anon = "A".repeat(22);
    const r = await law.call("PUT", `/v1/anon-matters/${anon}`, { "张三诉李四 Foo": 1 });
    assert.equal(r.status, 400);
    const page = openEnvelope<CpAuditPage>((await law.call("GET", "/v1/audit?after=0&limit=500")).json, "kwl-cp-audit-page", publicKeyMap(local.publicKeys.envelope));
    // 律师设备取不到流水（403）：直接看文件
    void page;
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const rej = lines.find((x) => x.action === "anon_summary.update")!;
    assert.equal(rej.result, "rejected:summary_unknown_field");
    assert.ok(lines.every((x) => validAuditRecord(x)));
    assert.ok(!readFileSync(file, "utf8").includes("张三"), "请求方的文字进不了流水");
    assert.throws(() => local.ops.createTenant({ activationRequired: false, tid: "律所A", edition: "team", seats: 1 }), /租户编号/);
  } finally {
    local.server.closeAllConnections();
    await new Promise<void>((r) => local.server.close(() => r()));
    base = b0;
  }
  const again = createAuditLog({ file });
  assert.ok(again.head("ten_s01").seq >= 3, "重启验链通过");
  again.close();
});

test("复核 S9A-02：半行截断后再追加、再重启照常；fsync 失败截断回去——文件与内存一致", () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-cp-audit-s02-"));
  const file = join(dir, "audit.jsonl");
  const a = createAuditLog({ file });
  a.append({ tid: "t1", actor: { kind: "ops", id: "ops" }, action: "tenant.create", target: null, result: "ok" }, new Date().toISOString());
  a.close();
  appendFileSync(file, '{"tid":"t1","seq":2,"at"');
  const b = createAuditLog({ file });
  b.append({ tid: "t1", actor: { kind: "ops", id: "ops" }, action: "license.renew", target: null, result: "ok" }, new Date().toISOString());
  b.close();
  const c = createAuditLog({ file });
  assert.equal(c.head("t1").seq, 2);
  c.close();
  // fsync 失败：截断回写入前，重启后没有这一条
  let failOnce = true;
  const d = createAuditLog({
    file,
    fs: {
      writeSync: (fd, data) => writeSync(fd, data),
      fsyncSync: (fd) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("EIO");
        }
        fsyncSync(fd);
      },
    },
  });
  assert.throws(() => d.append({ tid: "t1", actor: { kind: "ops", id: "ops" }, action: "quota.grant", target: null, result: "ok" }, new Date().toISOString()));
  assert.equal(d.head("t1").seq, 2);
  d.append({ tid: "t1", actor: { kind: "ops", id: "ops" }, action: "quota.grant", target: null, result: "ok" }, new Date().toISOString());
  d.close();
  const e = createAuditLog({ file });
  assert.equal(e.head("t1").seq, 3, "失败的那条不在文件里；之后的追加照常");
  e.close();
});

test("复核 S9A-03：审计写不进去时吊销整体不生效（设备未吊销、目录版本不变）", async () => {
  let failRevoke = false;
  const real = createAuditLog();
  const flaky = { ...real, append: (e: Parameters<typeof real.append>[0], at: string) => (failRevoke && e.action === "device.revoke" ? (() => { throw new Error("disk full"); })() : real.append(e, at)) };
  const store = { saved: null as string | null, load: () => null, save(j: string) { this.saved = j; } };
  const local = createControlPlane({ keys: devControlPlaneKeys(), serviceSecret: "s03-secret", auditLog: flaky, stateStore: store });
  await new Promise<void>((r) => local.server.listen(0, "127.0.0.1", () => r()));
  const b0 = base;
  base = `http://127.0.0.1:${(local.server.address() as AddressInfo).port}`;
  try {
    const tid = "ten_s03";
    local.ops.createTenant({ activationRequired: false, tid, edition: "team", seats: 3 });
    const ts = Date.now();
    const proof = sign(null, enrollProofBytes(tid, root.publicKeyPem, ts), root.privateKeyPem).toString("base64url");
    await fetch(`${base}/v1/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tid, root_public_key_pem: root.publicKeyPem, ts, proof }) });
    const adm = makeDevice(tid, "admin", "usr_a3", "dev_a3");
    const law = makeDevice(tid, "lawyer", "usr_l3", "dev_l3");
    await adm.register();
    await law.register();
    const v0 = local.ops.tenant(tid)!.directoryVersion;
    failRevoke = true;
    const r = await adm.call("POST", "/v1/devices/dev_l3/revoke", {});
    assert.equal(r.status, 500);
    assert.equal(local.ops.tenant(tid)!.devices.get("dev_l3")!.revoked_at, null, "吊销没有生效");
    assert.equal(local.ops.tenant(tid)!.directoryVersion, v0);
    assert.ok(!store.saved!.includes('"revoked_at":"20'), "状态文件里也没有");
  } finally {
    local.server.closeAllConnections();
    await new Promise<void>((r) => local.server.close(() => r()));
    base = b0;
  }
});

test("复核 S9A-22、S9A-23、S9B-21：证书未变的重复登记顺带分配席位只记“席位分配”；凭据签发每小时限 12 张；支持专用凭据受众 support、15 分钟", async () => {
  const { verifySeatToken } = await import("@zr-legal/seat-token");
  const tid = "ten_s22";
  cp.ops.createTenant({ activationRequired: false, tid, edition: "team", seats: 1 });
  await enroll(tid);
  const a = makeDevice(tid, "admin", "usr_s22a", "dev_s22a");
  const b = makeDevice(tid, "lawyer", "usr_s22b", "dev_s22b");
  await a.register();
  await b.register(); // 席位已满：B 没有席位
  cp.ops.revokeSeat(tid, "usr_s22a");
  assert.equal((await b.register()).json.seat !== null, true, "空出席位后重复登记即分配");
  const page = openEnvelope<CpAuditPage>((await a.call("GET", "/v1/audit?after=0&limit=500")).json, "kwl-cp-audit-page", publicKeyMap(cp.publicKeys.envelope));
  // A 已收回席位但设备仍是管理员设备，可取流水
  assert.ok(page.ok);
  const tailActs = page.ok ? page.body.records.slice(-2).map((r) => `${r.action}:${r.actor.id}`) : [];
  assert.deepEqual(tailActs, ["seat.revoke:ops", "seat.assign:dev_s22b"], "重复登记不记登记本身，只记席位分配");

  const st = await b.call("POST", "/v1/support-token", {});
  assert.equal(st.status, 200);
  const claims = verifySeatToken(st.json.token, publicKeyMap(cp.publicKeys.seat), { audience: "support", requireAudience: true });
  assert.deepEqual(claims.aud, ["support"]);
  assert.equal(claims.exp - claims.iat, 900);
  let last = 0;
  for (let i = 0; i < 12; i++) last = (await b.call("POST", "/v1/seat-token", {})).status;
  assert.equal(last, 200);
  assert.equal((await b.call("POST", "/v1/seat-token", {})).status, 429, "第 13 张被限速");
});

test("客户端版本分布（v9.3 P3）：按 30 天内报到、未吊销的设备计；不合格或没报的版本记为 legacy；同一天同版本不改写状态", async () => {
  const tid = "ten_cv";
  cp.ops.createTenant({ activationRequired: false, tid, edition: "team", seats: 5 });
  await enroll(tid);
  const a = makeDevice(tid, "admin", "usr_cv_a", "dev_cv_a");
  const b = makeDevice(tid, "lawyer", "usr_cv_b", "dev_cv_b");
  const c = makeDevice(tid, "lawyer", "usr_cv_c", "dev_cv_c");
  const reg = (d: ReturnType<typeof makeDevice>, client?: unknown) => d.call("POST", "/v1/devices/register", { tid, cert: d.cert, ...(client === undefined ? {} : { client }) });
  assert.equal((await reg(a, { version: "0.9.3" })).status, 200);
  assert.equal((await reg(b, { version: "0.9.2-beta.1" })).status, 200);
  assert.equal((await reg(c, { version: "not a version; drop table" })).status, 200, "不合格的版本号不影响登记");
  const v = cp.metrics().client_versions;
  assert.equal(v["0.9.3"], 1);
  assert.equal(v["0.9.2-beta.1"], 1);
  assert.ok((v.legacy ?? 0) >= 1, "没报合格版本的设备记为 legacy，也只按 30 天内报到计（复核 RB16B-22；同一控制面上前面用例登记的设备也在其中）");
  assert.equal(cp.ops.tenant(tid)!.devices.get("dev_cv_c")!.client_version, "legacy");
  // 升级：版本改写；吊销的不再计入
  assert.equal((await reg(b, { version: "0.9.3" })).status, 200);
  assert.equal(cp.metrics().client_versions["0.9.3"], 2);
  cp.ops.revokeDevice(tid, "dev_cv_a");
  assert.equal(cp.metrics().client_versions["0.9.3"], 1);
});
