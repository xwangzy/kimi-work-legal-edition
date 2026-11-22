/**
 * 第 56 批：设备“最近使用”按北京时间自然日记（原先按 UTC 取日，北京时间 0～8 点报到会记成前一天）。
 *
 * 规则（全系统同一条）：时刻存 UTC ISO；“日”一律是北京时间自然日（usage-ledger.ts dayOf）；界面按北京时间显示。
 * 这里用可拨的钟跨日界：UTC 15:59:59（北京 23:59:59）与 UTC 16:00:00（北京次日 00:00:00）分属两天；
 * 北京时间凌晨 00:30 登记的电脑，“最近使用”与登记日是同一天；30 天未报到的判定也按北京日。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sign } from "node:crypto";
import type { AddressInfo } from "node:net";
import { generateDeviceKeys, generateFirmRoot, issueDeviceCertificate } from "@zr-legal/keys";
import { enrollProofBytes, signDeviceRequest } from "@zr-legal/firm-trust";
import { createControlPlane, devControlPlaneKeys, type ControlPlane } from "../src/index.ts";
import { dayOf } from "../src/usage-ledger.ts";
import { call, devStaffOf, staffToken, staffEmail } from "./staff-fixture.ts";

let clock = Date.parse("2026-11-21T15:59:59Z");
let cp: ControlPlane;
let base = "";

before(async () => {
  cp = createControlPlane({ keys: devControlPlaneKeys(), serviceSecret: "b56-secret", now: () => clock, devStaff: devStaffOf({ viewer_1: ["viewer"] }) });
  await new Promise<void>((r) => cp.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(cp.server.address() as AddressInfo).port}`;
});
after(async () => {
  cp.server.closeAllConnections();
  await new Promise<void>((r) => cp.server.close(() => r()));
});

async function firm(tid: string) {
  const rec = cp.ops.createTenant({ activationRequired: false, tid, edition: "team", seats: 3 });
  const root = generateFirmRoot();
  const proof = sign(null, enrollProofBytes(tid, root.publicKeyPem, clock), root.privateKeyPem).toString("base64url");
  const en = await fetch(`${base}/v1/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tid, root_public_key_pem: root.publicKeyPem, ts: clock, proof }) });
  assert.equal(en.status, 200, await en.text());
  const slug = tid.replace(/^ten_/, "");
  const dk = generateDeviceKeys();
  const deviceId = `dev_${slug}_admin`;
  const cert = issueDeviceCertificate(root.privateKeyPem, {
    certId: `cert_${deviceId}`,
    memberId: `usr_${slug}_admin`,
    deviceId,
    role: "admin",
    signPublicKeyPem: dk.signPublicKeyPem,
    encPublicKeyPem: dk.encPublicKeyPem,
    issuedAt: new Date(clock - 60_000).toISOString(),
    expiresAt: new Date(clock + 365 * 86400_000).toISOString(),
  });
  const register = async () => {
    const raw = JSON.stringify({ tid, cert, client: { version: "0.2.0" } });
    const h = signDeviceRequest({ method: "POST", path: "/v1/devices/register", body: raw, tid, deviceId, signPrivateKeyPem: dk.signPrivateKeyPem, now: clock });
    const r = await fetch(`${base}/v1/devices/register`, { method: "POST", headers: { ...h, "content-type": "application/json" }, body: raw });
    assert.equal(r.status, 200, await r.text());
  };
  const seenOn = () => rec.devices.get(deviceId)?.client_seen_on ?? null;
  /** 运营设备列表里这台设备的标记（每次按当前钟重新登录，会话不跨月）。 */
  const flags = async (): Promise<string[]> => {
    const tok = await staffToken(base, staffEmail("viewer_1"), { reauth: false });
    const r = await call(base, "GET", `/v1/ops/devices?tid=${tid}`, undefined, { authorization: `Bearer ${tok}` });
    assert.equal(r.status, 200, r.text);
    const rows = (r.json.devices ?? []) as { tid: string; flags: string[] }[];
    assert.equal(rows.filter((x) => x.tid === tid).length, 1, r.text);
    return rows.find((x) => x.tid === tid)!.flags;
  };
  return { register, seenOn, flags, deviceId, rec };
}

test("dayOf：UTC 15:59:59 仍是北京当天，16:00:00 起是北京次日；跨月、跨年同理", () => {
  assert.equal(dayOf(Date.parse("2026-11-21T15:59:59Z")), "2026-11-21");
  assert.equal(dayOf(Date.parse("2026-11-21T16:00:00Z")), "2026-11-22");
  assert.equal(dayOf(Date.parse("2026-11-30T16:00:00Z")), "2026-12-01");
  assert.equal(dayOf(Date.parse("2026-12-31T16:00:00Z")), "2027-01-01");
  assert.equal(dayOf(Date.parse("2027-02-28T15:59:59.999Z")), "2027-02-28");
});

test("设备“最近使用”跨日界：北京 23:59:59 记当天，北京 00:00:00 记次日（原先 0～8 点会记成前一天）", async () => {
  clock = Date.parse("2026-11-21T15:59:59Z"); // 北京 11-21 23:59:59
  const f = await firm("ten_b56-edge");
  await f.register();
  assert.equal(f.seenOn(), "2026-11-21");
  clock = Date.parse("2026-11-21T16:00:00Z"); // 北京 11-22 00:00:00
  await f.register();
  assert.equal(f.seenOn(), "2026-11-22", "北京时间零点起就是新的一天");
  clock = Date.parse("2026-11-21T23:59:59Z"); // 北京 11-22 07:59:59——修复前这里会是 2026-11-21
  await f.register();
  assert.equal(f.seenOn(), "2026-11-22");
});

test("北京时间凌晨登记的电脑：最近使用不早于登记日", async () => {
  clock = Date.parse("2026-11-21T16:30:00Z"); // 北京 11-22 00:30
  const f = await firm("ten_b56-dawn");
  await f.register();
  const d = f.rec.devices.get(f.deviceId)!;
  assert.equal(d.client_seen_on, "2026-11-22");
  assert.equal(dayOf(Date.parse(d.registered_at)), d.client_seen_on, "登记日（北京）与最近使用是同一天");
});

test("30 天未报到的判定按北京日：第 30 天不标，第 31 天才标", async () => {
  clock = Date.parse("2026-10-01T16:30:00Z"); // 北京 10-02 00:30 报到 → 最近使用 10-02
  const f = await firm("ten_b56-stale");
  await f.register();
  const flags = f.flags;
  clock = Date.parse("2026-11-01T15:00:00Z"); // 北京 11-01 23:00：30 天前是 10-02，不算久未报到
  assert.ok(!(await flags()).includes("stale"), "第 30 天不应标久未报到");
  clock = Date.parse("2026-11-01T16:00:00Z"); // 北京 11-02 00:00：30 天前是 10-03，10-02 早于它
  assert.ok((await flags()).includes("stale"), "第 31 天应标久未报到");
});
