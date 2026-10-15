/**
 * 第 10 批 S9 期限提醒（v9 #51、K7）：
 * - 本机：未配置通知服务也照常到时提醒（放进“收到的提醒”并通知界面），不重复；
 * - 云端：只见触发时刻、接收设备编号与密文；本人的另一台设备、事项成员的设备用自己的私钥解开并核对发出设备签名；
 *   电脑关机时（本机未到时巡检）由云端送达；改动升版本、撤销与事项删除即云端删除；
 * - 伪造与挪用：别的提醒或别的设备的密文、目录里没有的发出设备、已吊销的发出设备、触发时刻被改——一律不收。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, generateDeviceKeys, issueDeviceCertificate, openForDevice, sealForDevice, SoftwareSigner, verifyBytes, type DeviceCertificate } from "@zr-legal/keys";
import type { NotifyRelayRequest, NotifyRelayResult } from "@zr-legal/egress-gate";
import { makeKernel, type TestKernel } from "./helpers.ts";
import { startCloudCp, type CloudCp } from "./cloud-cp.ts";
import { getFirmRootPrivateKey, keysDirOf } from "../src/index.ts";
import { ReminderService, reminderAad, type ReminderBody } from "../src/services/reminders.ts";
import { getDeviceKeys } from "../src/devices.ts";

const FIRM = "rem-firm";
const TID = `ten_${FIRM}`;
const ME = `usr_${FIRM}_test-lawyer`;
const MY_DEV = `dev_${FIRM}_test-lawyer`;
const COLLEAGUE = `usr_${FIRM}_colleague`;
let cloud: CloudCp;
let tk: TestKernel;
let local: TestKernel;
const events: Record<string, unknown>[] = [];

function device(member: string, id: string) {
  const k = generateDeviceKeys();
  const cert: DeviceCertificate = issueDeviceCertificate(getFirmRootPrivateKey(keysDirOf(tk.kernel.config.workspaceDir)).privateKeyPem, {
    certId: `cert_${id}`,
    memberId: member,
    deviceId: id,
    role: "lawyer",
    signPublicKeyPem: k.signPublicKeyPem,
    encPublicKeyPem: k.encPublicKeyPem,
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString(),
  });
  return { cert, keys: k, signPrivateKeyPem: k.signPrivateKeyPem };
}
let phone: ReturnType<typeof device>;
let colleague: ReturnType<typeof device>;

/** 北京时间“现在 + n 分钟”的期限日与时刻（期限日当天提醒，days_before 0）。 */
function soon(minutes: number): { due_date: string; remind_time: string; fire_at: string } {
  const t = Math.floor((Date.now() + minutes * 60_000) / 60_000) * 60_000;
  const bj = new Date(t + 8 * 3600_000).toISOString();
  return { due_date: bj.slice(0, 10), remind_time: bj.slice(11, 16), fire_at: new Date(t).toISOString() };
}
function inDays(n: number): string {
  return new Date(Date.now() + 8 * 3600_000 + n * 86_400_000).toISOString().slice(0, 10);
}

/** 以某台设备的身份取通知凭据并直连通知服务（模拟那台设备上的客户端）。 */
async function deviceDue(d: ReturnType<typeof device>): Promise<{ token: string; items: { id: string; version: number; fire_at: string; ct: string }[] }> {
  const t = await cloud.deviceCall(TID, d, "POST", "/v1/notify-token", {});
  assert.equal(t.status, 200, JSON.stringify(t.json));
  const r = await fetch(`${cloud.notify.base}/v1/notify/due`, { headers: { authorization: `Bearer ${t.json.token}` } });
  return { token: t.json.token, items: ((await r.json()) as any).items };
}
function openAs(d: ReturnType<typeof device>, it: { id: string; version: number; ct: string }): { body: ReminderBody; sig: string } {
  return JSON.parse(new TextDecoder().decode(openForDevice(it.ct, d.keys.encPrivateKeyPem, reminderAad(TID, it.id, it.version, d.cert.deviceId))));
}

before(async () => {
  cloud = await startCloudCp({ tenant: TID });
  tk = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream" }, FIRM);
  tk.kernel.onBroadcast((m) => void events.push(m));
  assert.equal((await tk.inv("control_plane.sync")).report.ok, true);
  phone = device(ME, "dev_rem_phone");
  colleague = device(COLLEAGUE, "dev_rem_colleague");
  for (const d of [phone, colleague]) assert.equal((await cloud.deviceCall(TID, d, "POST", "/v1/devices/register", { tid: TID, cert: d.cert })).status, 200);
  assert.equal((await tk.inv("control_plane.sync")).report.ok, true);
  local = await makeKernel({ ZR_NOTIFY_POLL_MS: "off" }, "rem-local");
});
after(async () => {
  await local.kernel.close();
  await tk.kernel.close();
  await cloud.close();
});

test("本机提醒（未配置通知服务）：到时放进收到的提醒、通知界面、不重复；已读；撤销的不再响；入参校验", { timeout: 60_000 }, async () => {
  const seen: Record<string, unknown>[] = [];
  local.kernel.onBroadcast((m) => void seen.push(m));
  const { matter } = await local.inv("matters.create", { title: "本机提醒事项", stance: "原告", consent_status: "agreed" });
  const r = await local.inv("reminders.create", { matter_id: matter.matter_id, kind: "hearing", due_date: inDays(10), days_before: 3, note: "带齐证据原件" });
  assert.equal(r.cloud_state, "local", "未配置通知服务：只在本机");
  assert.equal((await local.inv("reminders.sync")).local, 0, "未到时");
  const c = await local.inv("reminders.create", { matter_id: matter.matter_id, kind: "appeal", due_date: inDays(9), days_before: 1 });
  await local.inv("reminders.cancel", { reminder_id: c.reminder_id });
  local.kernel.db.run(`UPDATE reminders SET remind_at = ? WHERE matter_id = ?`, [new Date(Date.now() - 60_000).toISOString(), matter.matter_id]);
  assert.equal((await local.inv("reminders.sync")).local, 1, "只有有效的那条");
  assert.equal((await local.inv("reminders.sync")).local, 0, "不重复");
  assert.deepEqual(seen.filter((m) => m.type === "reminder.due"), [{ type: "reminder.due", count: 1 }]);
  const l = await local.inv("reminders.list");
  assert.equal(l.unread, 1);
  assert.equal(l.inbox[0].note, "带齐证据原件");
  assert.equal(l.inbox[0].matter_title, "本机提醒事项");
  assert.equal(l.inbox[0].source, "local");
  assert.equal(l.cloud.configured, false);
  await local.inv("reminders.mark_read", { all: true });
  assert.equal((await local.inv("reminders.list")).unread, 0);
  const bad = (p: Record<string, unknown>) => assert.rejects(local.inv("reminders.create", { matter_id: matter.matter_id, kind: "hearing", due_date: inDays(5), ...p }), (e: any) => e.code === "validation");
  await bad({ due_date: inDays(-1) });
  await bad({ due_date: "2026-02-30" });
  await bad({ kind: "party" });
  await bad({ note: "长".repeat(201) });
  await bad({ days_before: 61 });
  await bad({ remind_time: "25:00" });
  await bad({ audience: "everyone" });
  await assert.rejects(local.inv("reminders.create", { matter_id: "mat_nope", kind: "hearing", due_date: inDays(5) }), (e: any) => e.code === "not_found");
});

let mid = "";
let rid = "";

test("云端：只提醒我 → 本人两台设备；云端只见触发时刻、设备编号与密文；另一台设备解开并核对签名；电脑未巡检到时由云端送达", { timeout: 90_000 }, async () => {
  const { matter } = await tk.inv("matters.create", { title: "云端提醒事项", client_name: "客户甲", stance: "原告", consent_status: "agreed" });
  mid = matter.matter_id;
  const s = soon(3);
  const r = await tk.inv("reminders.create", { matter_id: mid, kind: "evidence", due_date: s.due_date, days_before: 0, remind_time: s.remind_time, note: "举证期限届满前提交补充证据" });
  rid = r.reminder_id;
  assert.equal(r.remind_at, s.fire_at);
  await tk.inv("reminders.sync");
  const row = tk.kernel.db.get<any>(`SELECT * FROM reminders WHERE reminder_id = ?`, [rid]);
  assert.equal(row.cloud_state, "synced", row.cloud_error);
  assert.equal(row.cloud_targets, 2);
  const stored = cloud.notify.server.snapshot();
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.fire_at, s.fire_at);
  assert.deepEqual(Object.keys(stored[0]!.targets).sort(), [MY_DEV, phone.cert.deviceId].sort());
  const text = JSON.stringify(stored);
  for (const plain of ["举证", "evidence", mid, "云端提醒事项", "客户甲", s.due_date]) assert.ok(!text.includes(plain), `云端看不到：${plain}`);

  // 另一台设备：未到时取不到；到时（通知服务时钟前拨）取到自己那份，用自己的私钥解开、核对发出设备签名
  assert.deepEqual((await deviceDue(phone)).items, []);
  cloud.notify.setSkew(5 * 60_000);
  try {
    const got = await deviceDue(phone);
    assert.equal(got.items.length, 1);
    const { body, sig } = openAs(phone, got.items[0]!);
    assert.equal(body.note, "举证期限届满前提交补充证据");
    assert.equal(body.matter_id, mid);
    assert.equal(body.from_dev, MY_DEV);
    const signPub = tk.kernel.db.get<{ sign_pub_pem: string }>(`SELECT sign_pub_pem FROM devices WHERE device_id = ?`, [MY_DEV])!.sign_pub_pem;
    assert.ok(verifyBytes(signPub, new TextEncoder().encode(canonicalJson(body)), sig), "发出设备签名");
    assert.throws(() => openAs(colleague, { ...got.items[0]!, ct: got.items[0]!.ct }), "别的设备解不开");

    // 本机：内核按真实时钟还没到时（不会本机放入）——云端送达，核对后放入；再巡检不重复
    events.length = 0;
    const t1 = await tk.inv("reminders.sync");
    assert.deepEqual([t1.local, t1.cloud], [0, 1]);
    const l = await tk.inv("reminders.list");
    assert.equal(l.inbox[0].source, "cloud");
    assert.equal(l.inbox[0].matter_title, "云端提醒事项");
    assert.equal(l.inbox[0].from_me, true);
    assert.deepEqual(events.filter((m) => m.type === "reminder.due"), [{ type: "reminder.due", count: 1 }]);
    assert.deepEqual([(await tk.inv("reminders.sync")).cloud], [0]);
    assert.equal(cloud.notify.server.snapshot()[0]!.targets[MY_DEV]!.delivered_at !== null, true, "已确认收到");
  } finally {
    cloud.notify.setSkew(0);
  }
  // 本机到时巡检：同一编号与版本已在收件里，不再放第二条
  tk.kernel.db.run(`UPDATE reminders SET remind_at = ? WHERE reminder_id = ?`, [new Date(Date.now() - 1000).toISOString(), rid]);
  assert.equal((await tk.inv("reminders.sync")).local, 0);
  tk.kernel.db.run(`UPDATE reminders SET remind_at = ? WHERE reminder_id = ?`, [s.fire_at, rid]);
});

test("改动升版本整条重登、撤销即云端删除；通知事项成员 → 同事的设备收到并能核对", { timeout: 90_000 }, async () => {
  const d = inDays(20);
  const u = await tk.inv("reminders.update", { reminder_id: rid, kind: "evidence", due_date: d, days_before: 5, note: "改期" });
  assert.equal(u.version, 2);
  await tk.inv("reminders.sync");
  assert.equal(cloud.notify.server.snapshot().find((x) => x.id === rid)!.version, 2);
  await tk.inv("reminders.cancel", { reminder_id: rid });
  await tk.inv("reminders.sync");
  assert.equal(cloud.notify.server.snapshot().find((x) => x.id === rid), undefined, "撤销即云端删除");
  assert.equal(tk.kernel.db.get<any>(`SELECT cloud_state FROM reminders WHERE reminder_id = ?`, [rid]).cloud_state, "cancelled");

  await tk.inv("matters.members.add", { matter_id: mid, user_id: COLLEAGUE, matter_role: "editor" });
  const s = soon(4);
  const team = await tk.inv("reminders.create", { matter_id: mid, kind: "hearing", due_date: s.due_date, days_before: 0, remind_time: s.remind_time, note: "开庭", audience: "team" });
  await tk.inv("reminders.sync");
  const stored = cloud.notify.server.snapshot().find((x) => x.id === team.reminder_id)!;
  assert.deepEqual(Object.keys(stored.targets).sort(), [MY_DEV, colleague.cert.deviceId, phone.cert.deviceId].sort());
  cloud.notify.setSkew(6 * 60_000);
  try {
    const got = (await deviceDue(colleague)).items.find((x) => x.id === team.reminder_id)!;
    const { body } = openAs(colleague, got);
    assert.equal(body.audience, "team");
    assert.equal(body.note, "开庭");
  } finally {
    cloud.notify.setSkew(0);
  }
});

test("伪造与挪用一律不收：别的提醒的密文、别的设备的密文、目录里没有的发出设备（暂不确认）、已吊销的发出设备、触发时刻被改", { timeout: 60_000 }, async () => {
  const myEnc = tk.kernel.db.get<{ enc_pub_pem: string }>(`SELECT enc_pub_pem FROM devices WHERE device_id = ?`, [MY_DEV])!.enc_pub_pem;
  const stranger = generateDeviceKeys();
  const revokedDev = generateDeviceKeys();
  tk.kernel.db.run(
    `INSERT INTO devices (device_id, tenant_id, member_id, role, sign_pub_pem, enc_pub_pem, cert_json, status) VALUES (?,?,?,?,?,?,?, 'revoked')`,
    ["dev_rem_revoked", TID, ME, "lawyer", revokedDev.signPublicKeyPem, revokedDev.encPublicKeyPem, "{}"],
  );
  const phoneSigner = new SoftwareSigner(phone.signPrivateKeyPem);
  const fire = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
  const mk = (id: string, o: { signer: SoftwareSigner; from: string; aadId?: string; aadDev?: string; fireInBody?: string; recipientPub?: string }) => {
    const body: ReminderBody = {
      f: "kwl-reminder/1", tid: TID, rid: id, ver: 1, matter_id: mid, kind: "other", due_date: inDays(3), remind_at: o.fireInBody ?? fire, note: "伪造", audience: "me",
      from_dev: o.from, from_member: ME, issued_at: new Date().toISOString(),
    };
    const plain = new TextEncoder().encode(canonicalJson({ body, sig: o.signer.signSync(new TextEncoder().encode(canonicalJson(body))) }));
    return { id, version: 1, fire_at: fire, ct: sealForDevice(plain, o.recipientPub ?? myEnc, reminderAad(TID, o.aadId ?? id, 1, o.aadDev ?? MY_DEV)) };
  };
  const id = (c: string) => `rmd_${c.repeat(24)}`;
  const items = [
    mk(id("1"), { signer: phoneSigner, from: phone.cert.deviceId, aadId: id("9") }), // 别的提醒的密文
    mk(id("2"), { signer: phoneSigner, from: phone.cert.deviceId, aadDev: phone.cert.deviceId }), // 发给别的设备的
    mk(id("3"), { signer: new SoftwareSigner(stranger.signPrivateKeyPem), from: "dev_rem_unknown" }), // 目录里没有：暂不确认
    mk(id("4"), { signer: new SoftwareSigner(revokedDev.signPrivateKeyPem), from: "dev_rem_revoked" }), // 已吊销
    mk(id("5"), { signer: phoneSigner, from: phone.cert.deviceId, fireInBody: new Date(Date.parse(fire) + 86_400_000).toISOString() }), // 触发时刻被改
    mk(id("6"), { signer: new SoftwareSigner(stranger.signPrivateKeyPem), from: phone.cert.deviceId }), // 冒用本人另一台设备的编号
    mk(id("7"), { signer: phoneSigner, from: phone.cert.deviceId }), // 合格
  ];
  const acked: string[] = [];
  const relay = async (req: NotifyRelayRequest): Promise<NotifyRelayResult> => {
    if (req.step === "due") return { ok: true, status: 200, body: JSON.stringify({ items, more: false }) };
    if (req.step === "ack") acked.push(...req.items.map((x) => x.id));
    return { ok: true, status: 200, body: '{"ok":true}' };
  };
  const svc = new ReminderService({
    db: tk.kernel.db,
    tenantId: TID,
    userId: ME,
    deviceId: MY_DEV,
    encPrivateKeyPem: getDeviceKeys(keysDirOf(tk.kernel.config.workspaceDir)).encPrivateKeyPem,
    signer: new SoftwareSigner(phone.signPrivateKeyPem),
    cloudConfigured: () => true,
    suspended: () => false,
    credential: async () => ({ token: "zst1.x.y", expiresAt: Date.now() + 3600_000 }),
    relay,
    onDue: () => {},
    audit: () => {},
  });
  const r = await svc.tick();
  assert.equal(r.cloud, 1, "只收合格的那一条");
  assert.deepEqual(acked.sort(), [id("1"), id("2"), id("4"), id("5"), id("6"), id("7")].sort(), "不合格的确认后丢弃；发出设备未知的暂不确认");
  const inbox = tk.kernel.db.all<{ reminder_id: string }>(`SELECT reminder_id FROM reminder_inbox WHERE note = '伪造'`);
  assert.deepEqual(inbox.map((x) => x.reminder_id), [id("7")]);
});

test("删除事项：交过云端的提醒由云端删除，删除回执写明中软通知服务；收到的提醒一并删除", { timeout: 90_000 }, async () => {
  const s = soon(30);
  const keep = await tk.inv("reminders.create", { matter_id: mid, kind: "contract", due_date: s.due_date, days_before: 0, remind_time: s.remind_time, note: "删除前" });
  await tk.inv("reminders.sync");
  assert.ok(cloud.notify.server.snapshot().some((x) => x.id === keep.reminder_id));
  await tk.inv("matters.close", { matter_id: mid, retention_years: 1 });
  await assert.rejects(tk.inv("reminders.create", { matter_id: mid, kind: "other", due_date: inDays(3) }), (e: any) => e.code === "validation", "已结案的事项不能设新提醒");
  const purged = await tk.inv("matters.purge", { matter_id: mid, confirm_title: "云端提醒事项", early: true, reason: "客户书面要求删除" });
  const copy = purged.receipt.receipt.copies.find((c: any) => c.where === "中软通知服务（期限提醒）");
  assert.equal(copy.status, "pending");
  assert.equal(tk.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM reminder_inbox WHERE matter_id = ?`, [mid])!.n, 0);
  assert.equal(tk.kernel.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM reminders WHERE matter_id = ? AND note <> ''`, [mid])!.n, 0, "备注已清空");
  await tk.inv("reminders.sync");
  assert.deepEqual(cloud.notify.server.snapshot().filter((x) => x.id === keep.reminder_id), [], "云端副本已删除");
  assert.deepEqual((await tk.inv("reminders.list")).reminders.filter((x: any) => x.matter_id === mid), []);
});

test("凭据受众：通知凭据在网关被拒；通用席位令牌在通知服务被拒", { timeout: 30_000 }, async () => {
  const t = await cloud.deviceCall(TID, phone, "POST", "/v1/notify-token", {});
  const g = await fetch(`${cloud.gatewayUrl}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${t.json.token}`, "content-type": "application/json" }, body: "{}" });
  assert.equal(g.status, 401);
  const seat = cloud.seatFor({ tid: TID, uid: ME, sid: "s", dev: phone.cert.deviceId });
  const n = await fetch(`${cloud.notify.base}/v1/notify/due`, { headers: { authorization: `Bearer ${seat}` } });
  assert.equal(n.status, 401);
  // 签发记进中软侧操作记录（律所侧可取回核对）
  const a = await tk.inv("control_plane.audit");
  assert.ok(a.records.some((r: any) => r.action === "notify_token.issue" && r.actor.id === MY_DEV), "本机领通知凭据记进操作记录");
});
