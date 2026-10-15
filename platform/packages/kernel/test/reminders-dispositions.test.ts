/**
 * 第 10 批两路复核处置（S10A、S10B）：期限提醒的失败分支、配置变化、收件核对与删除事项。
 * 用真实的通知服务（进程内）+ 真实的闸门通道函数 relayNotify，按需注入失败；时钟可拨。
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, generateDeviceKeys, sealForDevice, SoftwareSigner } from "@zr-legal/keys";
import { relayNotify, type NotifyRelayRequest, type NotifyRelayResult } from "@zr-legal/egress-gate";
import { devSeatKeyPair, issueSeatToken } from "@zr-legal/seat-token";
import { createNotifyApi } from "@zr-legal/notify-api";
import { makeKernel, type TestKernel } from "./helpers.ts";
import { keysDirOf } from "../src/index.ts";
import { getDeviceKeys } from "../src/devices.ts";
import { ReminderService, reminderAad, REMINDER_PLAIN_BYTES, type ReminderBody } from "../src/services/reminders.ts";

const SLUG = "rem-disp";
const TID = `ten_${SLUG}`;
const ME = `usr_${SLUG}_test-lawyer`;
const MY_DEV = `dev_${SLUG}_test-lawyer`;
const COL = `usr_${SLUG}_colleague`;
const COL_DEV = "dev_rem_disp_col";

let tk: TestKernel;
let clock = Date.now();
const seat = devSeatKeyPair();
let notify: ReturnType<typeof createNotifyApi>;
let base = "";
let myKeys: ReturnType<typeof getDeviceKeys>;
const col = generateDeviceKeys();
let mid = "";

/** 失败注入：返回结果即代替真实请求；返回 "pass-then" 时先真实发出、再返回给定结果（模拟“送达后才超时”）。 */
let inject: ((req: NotifyRelayRequest) => NotifyRelayResult | { after: NotifyRelayResult } | null) | null = null;
const calls: string[] = [];
let credCalls = 0;
let credFail = false;
let configured = true;
const due: number[] = [];

const relay = async (req: NotifyRelayRequest): Promise<NotifyRelayResult> => {
  calls.push(req.step);
  const x = inject?.(req) ?? null;
  if (x && "after" in x) {
    await relayNotify(req, { baseUrl: base });
    return x.after;
  }
  if (x) return x;
  return relayNotify(req, { baseUrl: base });
};

function svc(o: { userId?: string; deviceId?: string; enc?: string; signer?: SoftwareSigner } = {}): ReminderService {
  const deviceId = o.deviceId ?? MY_DEV;
  const userId = o.userId ?? ME;
  return new ReminderService({
    db: tk.kernel.db,
    tenantId: TID,
    userId,
    deviceId,
    encPrivateKeyPem: o.enc ?? myKeys.encPrivateKeyPem,
    signer: o.signer ?? new SoftwareSigner(myKeys.signPrivateKeyPem),
    cloudConfigured: () => configured,
    suspended: () => false,
    credential: async () => {
      credCalls++;
      if (credFail) throw new Error("cp_unreachable");
      return { token: issueSeatToken({ tid: TID, uid: userId, sid: `s-${userId}`, dev: deviceId, kid: "k1", aud: ["notify"] }, seat.privateKey, 6 * 3600, clock), expiresAt: clock + 6 * 3600_000 };
    },
    relay,
    onDue: (n) => void due.push(n),
    audit: () => {},
    now: () => clock,
  });
}
const row = (rid: string) => tk.kernel.db.get<any>(`SELECT * FROM reminders WHERE reminder_id = ?`, [rid]);
const inDays = (n: number) => new Date(clock + 8 * 3600_000 + n * 86_400_000).toISOString().slice(0, 10);
const input = (o: Record<string, unknown> = {}) => ({ matter_id: mid, kind: "hearing" as const, due_date: inDays(10), days_before: 3, remind_time: "09:00", note: "", audience: "me" as const, ...o });

before(async () => {
  tk = await makeKernel({ ZR_NOTIFY_POLL_MS: "off" }, SLUG);
  myKeys = getDeviceKeys(keysDirOf(tk.kernel.config.workspaceDir));
  notify = createNotifyApi({ dir: mkdtempSync(join(tmpdir(), "kwl-rd-")), keys: new Map([["k1", seat.publicKey]]), now: () => clock });
  await new Promise<void>((r) => notify.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(notify.address() as AddressInfo).port}`;
  mid = (await tk.inv("matters.create", { title: "复核处置事项", stance: "原告", consent_status: "agreed" })).matter.matter_id;
  tk.kernel.db.run(`INSERT INTO devices (device_id, tenant_id, member_id, role, sign_pub_pem, enc_pub_pem, cert_json, status) VALUES (?,?,?,?,?,?,?, 'active')`, [
    COL_DEV, TID, COL, "lawyer", col.signPublicKeyPem, col.encPublicKeyPem, "{}",
  ]);
  await tk.inv("matters.members.add", { matter_id: mid, user_id: COL, matter_role: "editor" });
});
after(async () => {
  await new Promise<void>((r) => notify.close(() => r()));
  await tk.kernel.close();
});
beforeEach(() => {
  inject = null;
  calls.length = 0;
  due.length = 0;
  credFail = false;
  configured = true;
});

/** 以某台设备身份封一条云端条目（测试收件核对）。 */
function item(o: { id: string; version?: number; body?: Partial<ReminderBody>; signer?: SoftwareSigner; plain?: string; to?: string; toEnc?: string; fireAt?: string }) {
  const version = o.version ?? 1;
  const fire = o.fireAt ?? new Date(Math.floor(clock / 60_000) * 60_000).toISOString();
  const body: ReminderBody = {
    f: "kwl-reminder/1", tid: TID, rid: o.id, ver: version, matter_id: mid, kind: "other", due_date: inDays(3), remind_at: fire, note: "复核", audience: "team",
    from_dev: COL_DEV, from_member: COL, issued_at: new Date(clock - 1000).toISOString(), ...o.body,
  };
  const signer = o.signer ?? new SoftwareSigner(col.signPrivateKeyPem);
  const plain = o.plain ?? canonicalJson({ body, sig: signer.signSync(new TextEncoder().encode(canonicalJson(body))) });
  return { id: o.id, version, fire_at: fire, ct: sealForDevice(new TextEncoder().encode(plain), o.toEnc ?? myKeys.encPublicKeyPem, reminderAad(TID, o.id, version, o.to ?? MY_DEV)) };
}
const rid = (c: string) => `rmd_${c.repeat(24)}`;

/** 只回放给定条目的“取提醒”，记录确认与暂缓（其余请求照常发往通知服务）。 */
function feed(items: ReturnType<typeof item>[], acked: string[], deferred: { id: string; until: string }[]) {
  inject = (req) => {
    if (req.step === "due") return { ok: true, status: 200, body: JSON.stringify({ items, more: false }) };
    if (req.step === "ack") {
      acked.push(...req.items.map((x) => x.id));
      return { ok: true, status: 200, body: '{"ok":true}' };
    }
    if (req.step === "defer") {
      deferred.push(...req.items.map((x) => ({ id: x.id, until: x.until })));
      return { ok: true, status: 200, body: '{"ok":true}' };
    }
    return null;
  };
}

test("S10A-01 毒丸条目：明文为 null、数组、数字、字符串、缺正文或字段类型错——一律丢弃并确认，合格的照收；本机到时提醒照常通知", async () => {
  const s = svc();
  const r = s.create(input());
  tk.kernel.db.run(`UPDATE reminders SET remind_at = ? WHERE reminder_id = ?`, [new Date(clock - 60_000).toISOString(), r.reminder_id]);
  const acked: string[] = [];
  const poison = ["null", "[]", "42", '"x"', "{}", JSON.stringify({ body: null, sig: "x" }), JSON.stringify({ body: { f: "kwl-reminder/1" }, sig: 1 })];
  const items = [...poison.map((p, i) => item({ id: rid(String(i)), plain: p })), item({ id: rid("a") })];
  feed(items, acked, []);
  const out = await s.tick();
  assert.deepEqual(out, { local: 1, cloud: 1 });
  assert.deepEqual(acked.sort(), [...poison.map((_, i) => rid(String(i))), rid("a")].sort());
  assert.deepEqual(due, [1, 1], "本机与云端各通知一次");
  s.cancel(r.reminder_id);
});

test("S10A-02 / S10B-04 云端路径出任何异常，本机到时提醒照常通知、巡检不外抛；某行封装失败只影响该行", async () => {
  const s = svc();
  const r = s.create(input());
  tk.kernel.db.run(`UPDATE reminders SET remind_at = ? WHERE reminder_id = ?`, [new Date(clock - 60_000).toISOString(), r.reminder_id]);
  inject = () => {
    throw new Error("闸门意外");
  };
  const out = await s.tick();
  assert.equal(out.local, 1);
  assert.deepEqual(due, [1]);
  inject = null;
  // 目录里一台本人设备的公钥损坏：只有用到它的那一行退避，别的行照常登记
  const ok = s.create(input({ audience: "me" }));
  tk.kernel.db.run(`INSERT INTO devices (device_id, tenant_id, member_id, role, sign_pub_pem, enc_pub_pem, cert_json, status) VALUES ('dev_rem_bad', ?, ?, 'lawyer', 'x', 'not a key', '{}', 'active')`, [TID, ME]);
  await s.tick();
  assert.equal(row(ok.reminder_id).cloud_state, "pending");
  assert.equal(row(ok.reminder_id).cloud_error, "internal_error");
  tk.kernel.db.run(`DELETE FROM devices WHERE device_id = 'dev_rem_bad'`);
  clock += 2 * 60_000;
  await s.tick();
  assert.equal(row(ok.reminder_id).cloud_state, "synced", "退避后重试成功");
  for (const x of [r, ok]) s.cancel(x.reminder_id);
  await s.tick();
});

test("S10A-07 / S10B-01 失败分支：撤销遇 401 永不放弃、退避后删成；登记遇 429 与 target_revoked 退避重试；只有云端判定请求不合格才“失败”，可重试", async () => {
  const s = svc();
  const a = s.create(input());
  await s.tick();
  assert.equal(row(a.reminder_id).cloud_state, "synced");
  s.cancel(a.reminder_id);
  inject = (req) => (req.step === "delete" ? { ok: true, status: 401, body: '{"error":"credential_signature"}' } : null);
  await s.tick();
  assert.equal(row(a.reminder_id).cloud_state, "cancel_pending");
  assert.equal(row(a.reminder_id).cloud_attempts, 1);
  calls.length = 0;
  await s.tick();
  assert.equal(calls.includes("delete"), false, "退避期内不再发");
  inject = null;
  clock += 2 * 60_000;
  await s.tick();
  assert.equal(row(a.reminder_id).cloud_state, "cancelled");
  assert.equal(row(a.reminder_id).cloud_may_have_copy, 0);
  assert.equal(notify.snapshot().some((x) => x.id === a.reminder_id), false);

  for (const [status, code, expect] of [
    [429, "too_many_writes", "pending"],
    [400, "target_revoked", "pending"],
    [400, "body_invalid", "failed"],
  ] as const) {
    const b = s.create(input());
    inject = (req) => (req.step === "put" ? { ok: true, status, body: JSON.stringify({ error: code }) } : null);
    await s.tick();
    assert.equal(row(b.reminder_id).cloud_state, expect, code);
    if (code === "target_revoked") assert.equal(row(b.reminder_id).cloud_body, null, "重新挑接收设备");
    inject = null;
    if (expect === "failed") s.retry(b.reminder_id);
    clock += 2 * 60_000;
    await s.tick();
    assert.equal(row(b.reminder_id).cloud_state, "synced", `${code} 之后恢复`);
    s.cancel(b.reminder_id);
    await s.tick();
  }
});

test("S10A-09 / S10B-07 送达后才超时：同一版本原样重发命中云端幂等，不升版本、不重响", async () => {
  const s = svc();
  const a = s.create(input());
  inject = (req) => (req.step === "put" ? { after: { ok: false, reason: "notify_timeout" } } : null);
  await s.tick();
  assert.equal(row(a.reminder_id).cloud_state, "pending");
  assert.equal(notify.snapshot().find((x) => x.id === a.reminder_id)?.version, 1, "其实云端已收下");
  inject = null;
  clock += 2 * 60_000;
  await s.tick();
  assert.equal(row(a.reminder_id).cloud_state, "synced");
  assert.equal(row(a.reminder_id).version, 1, "没有升版本");
  s.cancel(a.reminder_id);
  await s.tick();
});

test("S10B-02 配置变化：未配置时设的提醒配置后登记；已登记的在未配置时改动或撤销，配置后替换或删除云端旧版本", async () => {
  const s = svc();
  configured = false;
  const a = s.create(input());
  await s.tick();
  assert.equal(calls.length, 0, "未配置不发");
  assert.equal(row(a.reminder_id).cloud_state, "pending");
  configured = true;
  await s.tick();
  assert.equal(row(a.reminder_id).cloud_state, "synced");
  configured = false;
  s.update(a.reminder_id, input({ note: "改期" }));
  assert.equal(row(a.reminder_id).cloud_state, "pending");
  s.cancel(a.reminder_id);
  assert.equal(row(a.reminder_id).cloud_state, "cancel_pending", "云端可能还有旧版本：待删除");
  configured = true;
  await s.tick();
  assert.equal(notify.snapshot().some((x) => x.id === a.reminder_id), false, "云端旧版本已删");
  // 第 10 批首版留下的“只在本机”行：配置后升为待登记
  const b = s.create(input());
  tk.kernel.db.run(`UPDATE reminders SET cloud_state = 'local' WHERE reminder_id = ?`, [b.reminder_id]);
  await s.tick();
  assert.equal(row(b.reminder_id).cloud_state, "synced");
  s.cancel(b.reminder_id);
  await s.tick();
});

test("S10A-03 / S10A-11 暂时不能判断的条目请云端暂缓、不堵队头，24 小时后丢弃并计数；提前送达的暂缓到提醒时刻", async () => {
  const s = svc();
  const acked: string[] = [];
  const deferred: { id: string; until: string }[] = [];
  const stranger = generateDeviceKeys();
  const early = new Date(Math.floor((clock + 2 * 3600_000) / 60_000) * 60_000).toISOString();
  feed(
    [
      item({ id: rid("b"), body: { from_dev: "dev_unknown" }, signer: new SoftwareSigner(stranger.signPrivateKeyPem) }),
      item({ id: rid("c"), fireAt: early }),
    ],
    acked,
    deferred,
  );
  await s.tick();
  assert.equal(acked.length, 0);
  assert.deepEqual(deferred.map((d) => d.id).sort(), [rid("b"), rid("c")]);
  assert.equal(deferred.find((d) => d.id === rid("c"))!.until, early, "暂缓到提醒时刻");
  clock += 25 * 3600_000;
  acked.length = 0;
  deferred.length = 0;
  await s.tick();
  assert.ok(acked.includes(rid("b")), "24 小时后仍不认识：丢弃");
  assert.ok(s.rejectSummary().some((r) => r.reason === "held_unknown_sender"));
});

test("S10A-06 / S10B-03 收件核对：本人已被移出、事项已删除 → 不收；发出者成员关系未同步 → 暂缓；同一编号见过更高版本，旧版本不收（S10A-10）", async () => {
  const s = svc();
  const acked: string[] = [];
  const deferred: { id: string; until: string }[] = [];
  // 发出者不是成员（成员关系可能未同步）
  tk.kernel.db.run(`UPDATE matter_members SET removed_at = ? WHERE matter_id = ? AND user_id = ?`, [new Date().toISOString(), mid, COL]);
  feed([item({ id: rid("d") })], acked, deferred);
  await s.tick();
  assert.deepEqual([acked, deferred.map((d) => d.id)], [[], [rid("d")]]);
  tk.kernel.db.run(`UPDATE matter_members SET removed_at = NULL WHERE matter_id = ? AND user_id = ?`, [mid, COL]);
  // 新旧版本：先收 v2，再来 v1 不收
  acked.length = 0;
  feed([item({ id: rid("e"), version: 2 })], acked, deferred);
  assert.equal((await s.tick()).cloud, 1);
  feed([item({ id: rid("e"), version: 1 })], acked, deferred);
  assert.equal((await s.tick()).cloud, 0);
  // 本人被移出事项
  tk.kernel.db.run(`UPDATE matter_members SET removed_at = ? WHERE matter_id = ? AND user_id = ?`, [new Date().toISOString(), mid, ME]);
  feed([item({ id: rid("f") })], acked, deferred);
  assert.equal((await s.tick()).cloud, 0);
  assert.ok(s.rejectSummary().some((r) => r.reason === "not_member"));
  tk.kernel.db.run(`UPDATE matter_members SET removed_at = NULL WHERE matter_id = ? AND user_id = ?`, [mid, ME]);
  // 事项已删除（只看 lifecycle）
  tk.kernel.db.run(`UPDATE matters SET lifecycle = 'purged' WHERE matter_id = ?`, [mid]);
  feed([item({ id: rid("9") })], acked, deferred);
  assert.equal((await s.tick()).cloud, 0);
  assert.ok(s.rejectSummary().some((r) => r.reason === "matter_deleted"));
  tk.kernel.db.run(`UPDATE matters SET lifecycle = 'active' WHERE matter_id = ?`, [mid]);
});

test("S10A-05 明文填充到固定长度：期限类型、通知对象、备注长短不同，密文长度相同", async () => {
  const s = svc();
  const a = s.create(input({ kind: "hearing", note: "" }));
  const b = s.create(input({ kind: "limitation", note: "备".repeat(200) }));
  await s.tick();
  const len = (id: string) => notify.snapshot().find((x) => x.id === id)!.targets[MY_DEV]!.ct.length;
  assert.equal(len(a.reminder_id), len(b.reminder_id));
  assert.ok(REMINDER_PLAIN_BYTES >= 2048);
  for (const x of [a, b]) s.cancel(x.reminder_id);
  await s.tick();
});

test("S10A-14 并发巡检合并：正在跑时到来的 10 次调用共享下一轮（只多跑一轮）", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slowRelay = relay;
  const s2 = new ReminderService({
    db: tk.kernel.db, tenantId: TID, userId: ME, deviceId: MY_DEV, encPrivateKeyPem: myKeys.encPrivateKeyPem, signer: new SoftwareSigner(myKeys.signPrivateKeyPem),
    cloudConfigured: () => true, suspended: () => false,
    credential: async () => ({ token: issueSeatToken({ tid: TID, uid: ME, sid: "s", dev: MY_DEV, kid: "k1", aud: ["notify"] }, seat.privateKey, 3600, clock), expiresAt: clock + 3600_000 }),
    relay: async (req) => {
      if (req.step === "due") await gate;
      return slowRelay(req);
    },
    onDue: () => {}, audit: () => {}, now: () => clock,
  });
  const first = s2.tick();
  const rest = Array.from({ length: 10 }, () => s2.tick());
  release();
  await Promise.all([first, ...rest]);
  assert.equal(calls.filter((c) => c === "due").length, 2, "只多跑一轮");
});

test("S10B-11 / S10A-04 接收设备变化（新设备、对方换钥）：已登记、未到时的提醒升版本重登", async () => {
  const s = svc();
  const a = s.create(input({ audience: "team" }));
  await s.tick();
  assert.equal(row(a.reminder_id).cloud_targets, 2);
  const extra = generateDeviceKeys();
  tk.kernel.db.run(`INSERT INTO devices (device_id, tenant_id, member_id, role, sign_pub_pem, enc_pub_pem, cert_json, status) VALUES ('dev_rem_new', ?, ?, 'lawyer', ?, ?, '{}', 'active')`, [TID, ME, extra.signPublicKeyPem, extra.encPublicKeyPem]);
  await s.tick();
  assert.equal(row(a.reminder_id).version, 2);
  assert.equal(row(a.reminder_id).cloud_targets, 3);
  const rekey = generateDeviceKeys();
  tk.kernel.db.run(`UPDATE devices SET enc_pub_pem = ? WHERE device_id = ?`, [rekey.encPublicKeyPem, COL_DEV]);
  await s.tick();
  assert.equal(row(a.reminder_id).version, 3, "同事换了加密公钥");
  tk.kernel.db.run(`UPDATE devices SET enc_pub_pem = ? WHERE device_id = ?`, [col.encPublicKeyPem, COL_DEV]);
  tk.kernel.db.run(`DELETE FROM devices WHERE device_id = 'dev_rem_new'`);
  s.cancel(a.reminder_id);
  await s.tick();
});

test("S10B-14 / S10B-05 删除事项：云端没有副本的提醒整行删除；有副本的抹去内容、云端删除后整行删除", async () => {
  const s = svc();
  const m2 = (await tk.inv("matters.create", { title: "待删除事项", stance: "原告", consent_status: "agreed" })).matter.matter_id;
  const synced = s.create(input({ matter_id: m2, note: "机密备注" }));
  await s.tick();
  configured = false;
  const never = s.create(input({ matter_id: m2 }));
  tk.kernel.db.tx(() => ReminderService.purgeMatter(tk.kernel.db, m2));
  tk.kernel.db.run(`UPDATE matters SET lifecycle = 'purged' WHERE matter_id = ?`, [m2]);
  assert.equal(row(never.reminder_id), undefined, "没交过云端的整行删除");
  const left = row(synced.reminder_id);
  assert.deepEqual([left.kind, left.due_date, left.note, left.remind_at, left.cloud_state], ["other", "1970-01-01", "", "1970-01-01T00:00:00.000Z", "cancel_pending"]);
  configured = true;
  await s.tick();
  assert.equal(row(synced.reminder_id), undefined, "云端删除后整行删除");
  assert.equal(notify.snapshot().some((x) => x.id === synced.reminder_id), false);
});

test("S10B-10 取凭据失败后暂停 5 分钟：不在控制面刷签发", async () => {
  const s = svc();
  const a = s.create(input());
  credFail = true;
  const before = credCalls;
  await s.tick();
  await s.tick();
  assert.equal(credCalls - before, 1);
  clock += 6 * 60_000;
  credFail = false;
  await s.tick();
  assert.equal(row(a.reminder_id).cloud_state, "synced");
  s.cancel(a.reminder_id);
  await s.tick();
});

test("S10B-19 前面各行网络往返期间被撤销的行，轮到它时不再发出（云端不留孤儿）", async () => {
  const s = svc();
  const a = s.create(input());
  const b = s.create(input());
  inject = (req) => {
    if (req.step === "put" && req.reminder_id === a.reminder_id) s.cancel(b.reminder_id);
    return null;
  };
  await s.tick();
  assert.equal(notify.snapshot().some((x) => x.id === b.reminder_id), false, "已撤销的没有发出");
  assert.equal(row(b.reminder_id).cloud_state, "cancelled");
  inject = null;
  s.cancel(a.reminder_id);
  await s.tick();
});

test("S10B-21 超过云端可接受范围仍没登记成功的有效提醒改为只在本机，不删云端已有的旧版本；撤销时再删", async () => {
  const s = svc();
  const a = s.create(input());
  await s.tick();
  s.update(a.reminder_id, input({ note: "新版本" }));
  tk.kernel.db.run(`UPDATE reminders SET remind_at = ? WHERE reminder_id = ?`, [new Date(clock - 25 * 3600_000).toISOString(), a.reminder_id]);
  await s.tick();
  assert.deepEqual([row(a.reminder_id).cloud_state, row(a.reminder_id).cloud_may_have_copy], ["local", 1]);
  assert.ok(notify.snapshot().some((x) => x.id === a.reminder_id), "旧版本仍在云端");
  s.cancel(a.reminder_id);
  assert.equal(row(a.reminder_id).cloud_state, "cancel_pending");
  await s.tick();
  assert.equal(notify.snapshot().some((x) => x.id === a.reminder_id), false);
});

test("S10B-23 取提醒中途出错，已放进收件的照样通知", async () => {
  const s = svc();
  inject = (req) => {
    if (req.step === "due") return { ok: true, status: 200, body: JSON.stringify({ items: [item({ id: rid("7") })], more: false }) };
    if (req.step === "ack") throw new Error("闸门意外");
    return null;
  };
  const out = await s.tick();
  assert.equal(out.cloud, 1);
  assert.deepEqual(due, [1]);
});

test("S10B-20 删除回执：送达过其他设备、后来撤销且云端已删的提醒也计入“已送达其他设备的期限提醒”", async () => {
  const m3 = (await tk.inv("matters.create", { title: "回执事项", stance: "原告", consent_status: "agreed" })).matter.matter_id;
  const s = svc();
  const a = s.create(input({ matter_id: m3, audience: "team" }));
  await s.tick();
  s.cancel(a.reminder_id);
  await s.tick();
  assert.deepEqual([row(a.reminder_id).cloud_may_have_copy, row(a.reminder_id).cloud_state], [0, "cancelled"]);
  await tk.inv("matters.close", { matter_id: m3, retention_years: 1 });
  const purged = await tk.inv("matters.purge", { matter_id: m3, confirm_title: "回执事项", early: true, reason: "客户书面要求删除" });
  const copies = purged.receipt.receipt.copies as { where: string; status: string }[];
  assert.equal(copies.find((c) => c.where === "已送达其他设备的期限提醒")!.status, "pending");
  assert.equal(copies.find((c) => c.where === "中软通知服务（期限提醒）")!.status, "none", "云端已删");
});

test("S10A-04 遗留 / S10A-22 对方换钥待核对时一直暂缓（不计 24 小时）；发出方时钟偏快暂缓而不丢弃", async () => {
  const s = svc();
  const acked: string[] = [];
  const deferred: { id: string; until: string }[] = [];
  const newKey = generateDeviceKeys();
  tk.kernel.db.run(
    `INSERT OR REPLACE INTO device_key_changes (device_id, tenant_id, member_id, cert_json, safety_code, detected_at, status) VALUES (?,?,?,?,?,?, 'pending')`,
    [COL_DEV, TID, COL, "{}", "000000", new Date().toISOString()],
  );
  feed(
    [
      item({ id: rid("8"), signer: new SoftwareSigner(newKey.signPrivateKeyPem) }),
      item({ id: rid("6"), body: { issued_at: new Date(clock + 3600_000).toISOString() } }),
    ],
    acked,
    deferred,
  );
  await s.tick();
  assert.deepEqual(deferred.map((d) => d.id).sort(), [rid("6"), rid("8")]);
  clock += 30 * 3600_000;
  acked.length = 0;
  deferred.length = 0;
  await s.tick();
  assert.ok(deferred.some((d) => d.id === rid("8")), "换钥待核对：超过 24 小时仍暂缓");
  assert.equal(acked.includes(rid("8")), false);
  tk.kernel.db.run(`DELETE FROM device_key_changes WHERE device_id = ?`, [COL_DEV]);
});

test("S10A-23 待登记行的缓存密文按当时的接收设备封装：名单变了就升版本重封，不原样重发", async () => {
  const s = svc();
  const a = s.create(input({ audience: "team" }));
  // 已到时的提醒（登记指纹重扫只管未到时的；这里只能靠重发前核对）
  tk.kernel.db.run(`UPDATE reminders SET remind_at = ? WHERE reminder_id = ?`, [new Date(Math.floor((clock - 60_000) / 60_000) * 60_000).toISOString(), a.reminder_id]);
  inject = (req) => (req.step === "put" ? { ok: false, reason: "notify_timeout" } : null);
  await s.tick();
  assert.ok(row(a.reminder_id).cloud_body, "已缓存");
  inject = null;
  tk.kernel.db.run(`UPDATE matter_members SET removed_at = ? WHERE matter_id = ? AND user_id = ?`, [new Date().toISOString(), mid, COL]);
  clock += 2 * 60_000;
  await s.tick();
  await s.tick();
  assert.equal(row(a.reminder_id).version, 2, "升版本重封");
  assert.deepEqual(Object.keys(notify.snapshot().find((x) => x.id === a.reminder_id)!.targets), [MY_DEV], "被移出的同事不在接收设备里");
  tk.kernel.db.run(`UPDATE matter_members SET removed_at = NULL WHERE matter_id = ? AND user_id = ?`, [mid, COL]);
  s.cancel(a.reminder_id);
  await s.tick();
});
