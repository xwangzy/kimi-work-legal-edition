/**
 * 第 70 批（V44）：
 * - /v1/quota 的 own_recent 与 /v1/quota/usage 翻页行追加 client_request_id（出站闸门生成的编号，账本本来就记着）与 this_device（这一行是不是本机发出的）——
 *   律师端内核在本机按编号对回“哪件事项的哪个任务”，事项名不上云；
 * - PUT /v1/auth/devices/<编号>/name：给本人账号的一台电脑起名字（只存律师自填的这一串），/v1/auth/me 与电脑数已满的列表带 name；
 *   规整与拒绝（控制字符、方向控制符、超 20 字）、别人的电脑 404、已移除的 409、空串去掉名字；审计不记名字本身；/v1/meta features 带 device_name、usage_request_ids。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDeviceKeys, generateFirmRoot, issueDeviceCertificate, type DeviceRole } from "@zr-legal/keys";
import { enrollProofBytes, firmBundleBytes, openEnvelope, publicKeyMap, signDeviceRequest } from "@zr-legal/firm-trust";
import { accountDeviceId, createAuditLog, createControlPlane, deviceNameOf, devControlPlaneKeys, UsageBook, type ControlPlane } from "../src/index.ts";

const DAY = 86_400_000;
const keys = devControlPlaneKeys({ accountCa: true });
const SECRET = "b70-test-service-secret-0123456789abcdef";
const PW = "Lawyer2026secure";
let cp: ControlPlane;
let base = "";
const audit = createAuditLog();
const dir = mkdtempSync(join(tmpdir(), "kwl-b70-"));

before(async () => {
  cp = createControlPlane({ keys, auditLog: audit, serviceSecret: SECRET, usageBook: new UsageBook({ dir: join(dir, "usage") }), routing: { bootstrap: { provider: { base_url: "https://maas.example.test/v1" } }, key_id: "0123456789abcdef" } });
  await new Promise<void>((r) => cp.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(cp.server.address() as AddressInfo).port}`;
});
after(async () => {
  cp.server.closeAllConnections();
  await new Promise<void>((r) => cp.server.close(() => r()));
});

const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as any };
};
const service = (path: string, body: unknown) => post(path, body, { authorization: `Bearer ${SECRET}` });

async function founder(email: string) {
  const reg = await post("/v1/auth/register", { email, password: PW, name: "钱律师", org_name: "钱律师工作室", client: { version: "0.9.1", platform: "darwin" } });
  assert.equal(reg.status, 200, JSON.stringify(reg.json));
  const onb = reg.json.onboarding;
  const tid = onb.claim.tid as string;
  const root = generateFirmRoot();
  const recovery = generateFirmRoot();
  const ts = Date.now();
  const proof = sign(null, enrollProofBytes(tid, root.publicKeyPem, ts), root.privateKeyPem).toString("base64url");
  const firm_bundle = { recovery_public_key_pem: recovery.publicKeyPem, sig: sign(null, firmBundleBytes(tid, root.publicKeyPem, recovery.publicKeyPem), root.privateKeyPem).toString("base64url") };
  const en = await post("/v1/enroll", { tid, root_public_key_pem: root.publicKeyPem, ts, proof, activation_id: onb.claim.activation_id, claim_secret: onb.claim.claim_secret, firm_bundle });
  assert.equal(en.status, 200, JSON.stringify(en.json));
  const memberId = `usr_${tid.slice(4)}_${onb.member.slug}`;
  const k = generateDeviceKeys();
  const deviceId = accountDeviceId(tid.slice(4), onb.member.slug, 1);
  const cert = issueDeviceCertificate(root.privateKeyPem, { certId: `cert_${deviceId}`, memberId, deviceId, role: "admin" as DeviceRole, signPublicKeyPem: k.signPublicKeyPem, encPublicKeyPem: k.encPublicKeyPem, issuedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 365 * DAY).toISOString() });
  const session = reg.json.session_token as string;
  const call = async (method: string, path: string, body?: unknown, sess = session) => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const h = signDeviceRequest({ method, path, body: raw, tid, deviceId, signPrivateKeyPem: k.signPrivateKeyPem, now: Date.now() });
    const r = await fetch(`${base}${path}`, { method, headers: { ...h, ...(raw ? { "content-type": "application/json" } : {}), "x-kwl-session": sess }, ...(raw ? { body: raw } : {}) });
    return { status: r.status, json: (await r.json()) as any };
  };
  assert.equal((await call("POST", "/v1/devices/register", { tid, cert })).status, 200);
  return { tid, memberId, deviceId, call, session };
}

test("deviceNameOf：去首尾空白、并空白；空串与 null 去掉名字；控制字符、方向控制符、零宽字符与超 20 字拒绝（纯函数）", () => {
  assert.equal(deviceNameOf("  办公室   iMac "), "办公室 iMac");
  assert.equal(deviceNameOf(""), null);
  assert.equal(deviceNameOf("   "), null);
  assert.equal(deviceNameOf(null), null);
  assert.equal(deviceNameOf("家里\nWindows"), undefined, "换行是控制字符（单行输入框本来打不出来）");
  assert.equal(deviceNameOf("a\u0007b"), undefined, "响铃等控制字符");
  assert.equal(deviceNameOf("office‮exe.cad"), undefined, "从右到左覆盖（伪装）");
  assert.equal(deviceNameOf("王​律师"), undefined, "零宽空格");
  assert.equal(deviceNameOf("一二三四五六七八九十一二三四五六七八九十"), "一二三四五六七八九十一二三四五六七八九十", "20 个字正好");
  assert.equal(deviceNameOf("一二三四五六七八九十一二三四五六七八九十一"), undefined, "21 个字");
  assert.equal(deviceNameOf(42), undefined);
});

test("own_recent 与翻页行带 client_request_id 与 this_device；别的电脑发出的行 this_device=false；没有编号的旧行为 null", async () => {
  const f = await founder("b70-ids@example.cn");
  const t = cp.ops.tenant(f.tid)!;
  const sid = t.seatsByUser.get(f.memberId)!.sid;
  const l = await service("/v1/quota/lease", { tid: f.tid, sid, holder: "gw-test", need_estimate: { alias: "legal/k3", input: 100_000, output: 8192 } });
  assert.equal(l.status, 200, JSON.stringify(l.json));
  const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const rec = (id: string, crid: string | null, dev: string, min: number, qa = false) => ({ request_id: id, client_request_id: crid, upstream_request_id: `chatcmpl-${id}`, at: at(min), sid, uid: f.memberId, dev, alias: "legal/k3", provider: "maas", upstream_model: "kimi-k3.1-pro", stream: true, status: 200, outcome: "ok", qa, usage: { input: 1000 + min, cached: 0, output: 200, reasoning: 0 }, usage_source: "upstream", latency_ms: 900, attempts: [{ provider: "maas", status: 200, error: null, ms: 900 }], lease_id: l.json.lease_id });
  const other = accountDeviceId(f.tid.slice(4), "qian", 2);
  const records = [rec("kwlgw_a1", "kwlg_11111111-2222-3333-4444-555555555555", f.deviceId, 30), rec("kwlgw_a2", "kwlg_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", other, 20), rec("kwlgw_a3", null, f.deviceId, 10, true)];
  const s = await service("/v1/quota/settle", { tid: f.tid, lease_id: l.json.lease_id, holder: "gw-test", records, final: true });
  assert.equal(s.status, 200, JSON.stringify(s.json));

  const q = await f.call("GET", "/v1/quota");
  const v = openEnvelope<any>(q.json, "kwl-quota-view", publicKeyMap(cp.publicKeys.envelope));
  assert.ok(v.ok);
  const recent = v.ok ? v.body.own_recent : [];
  assert.deepEqual(
    recent.map((r: any) => [r.client_request_id, r.this_device, r.kind]),
    [
      [null, true, "qa"],
      ["kwlg_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", false, "task"],
      ["kwlg_11111111-2222-3333-4444-555555555555", true, "task"],
    ],
  );
  // 翻页行同口径
  const pg = await f.call("GET", "/v1/quota/usage?limit=10");
  const pv = openEnvelope<any>(pg.json, "kwl-usage-page", publicKeyMap(cp.publicKeys.envelope));
  assert.ok(pv.ok);
  assert.deepEqual((pv.ok ? pv.body.rows : []).map((r: any) => [r.client_request_id, r.this_device]), recent.map((r: any) => [r.client_request_id, r.this_device]));
  // 不因此多出内容字段：没有上游请求编号、网关请求编号、设备编号
  for (const r of recent) for (const k of ["request_id", "upstream_request_id", "dev", "sid"]) assert.ok(!(k in r), `明细不给 ${k}`);
});

test("PUT /v1/auth/devices/<编号>/name：起名、规整、/v1/auth/me 带 name；空串去掉；非法 400、别人的 404；审计只记哪台电脑", async () => {
  const f = await founder("b70-name@example.cn");
  const g = await founder("b70-name-other@example.cn");
  const put = (dev: string, body: unknown, who = f) => who.call("PUT", `/v1/auth/devices/${dev}/name`, body);
  let r = await put(f.deviceId, { name: "  办公室   iMac " });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.name, "办公室 iMac");
  let me = await f.call("GET", "/v1/auth/me");
  assert.equal(me.status, 200);
  assert.equal(me.json.devices.find((d: any) => d.device_id === f.deviceId).name, "办公室 iMac");
  assert.equal(cp.ops.tenant(f.tid)!.devices.get(f.deviceId)!.name, "办公室 iMac", "存在设备登记上（随状态落盘）");

  assert.equal((await put(f.deviceId, { name: "a‮b" })).status, 400);
  assert.equal((await put(f.deviceId, { name: "x".repeat(21) })).status, 400);
  assert.equal((await put(f.deviceId, {})).status, 400, "缺 name 不当作去掉名字");
  assert.equal((await put(g.deviceId, { name: "别人的电脑" })).status, 404, "不能改别的账号的电脑");
  assert.equal(cp.ops.tenant(g.tid)!.devices.get(g.deviceId)!.name, undefined);

  r = await put(f.deviceId, { name: "" });
  assert.equal(r.status, 200);
  assert.equal(r.json.name, null);
  me = await f.call("GET", "/v1/auth/me");
  assert.equal(me.json.devices.find((d: any) => d.device_id === f.deviceId).name, null);
  assert.equal(cp.ops.tenant(f.tid)!.devices.get(f.deviceId)!.name, undefined);

  // 审计：device.rename 两条，目标是设备编号，不含名字
  const rows = audit.list(f.tid, 0, 500).map((x: any) => x.entry ?? x);
  const ren = rows.filter((x: any) => x.action === "device.rename");
  assert.equal(ren.length, 2);
  assert.ok(ren.every((x: any) => x.target === f.deviceId));
  assert.ok(!JSON.stringify(ren).includes("iMac"), "审计不记名字");

  // 能力字段
  const m = await (await fetch(`${base}/v1/meta`)).json() as any;
  assert.ok(m.features.includes("device_name") && m.features.includes("usage_request_ids"));
});
