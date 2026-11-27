/**
 * 第 72 批（U-2，D-304）端到端：团队成员由账号签发钥直接登记的电脑“事后确认”为可接收团队共享事项。
 * 真实控制面（带账号设备签发钥）+ 两个内核数据根：乙（团队管理员，律所根电脑）、甲（团队成员，account_ca 电脑），全程经内核方法与真实闸门：
 *   甲 team.deviceShare.request（12 位核对码）→ 乙 members.list 看到“甲 的电脑申请接收团队共享事项”、核对码与甲屏幕上的一致
 *   → 乙输错核对码确认被拒 → 输对确认（律所根签证书、立即同步）→ 乙本机设备表含甲这台、团队共享事项的密钥能包给它
 *   → 甲 team.deviceShare.status 取回、核验、换证、请求重启 → 重启后 device_issuer = firm_root、同步登记照常、席位照常。
 * 另：成员电脑换证的核验（不按应答里的根公钥、不收账号签发钥签的、不收换了公钥 / 编号 / 成员的、不收升角色的）用单元用例逐条覆盖。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "b72-share-confirm-secret-0123456789";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDeviceKeys, generateFirmRoot, issueDeviceCertificate, type DeviceCertificate } from "@zr-legal/keys";
import { joinCheckCode } from "@zr-legal/firm-trust";
import { startCloudCp, type CloudCp } from "./cloud-cp.ts";
import type { Kernel } from "../src/index.ts";
import type { ProfileHandoff } from "../src/profiles.ts";
import { DeviceShareConfirm } from "../src/services/device-share.ts";
import type { KernelDb } from "../src/db.ts";

const PW = "Lawyer2026secure";
let cloud: CloudCp | null = null;
const open: Kernel[] = [];
after(async () => {
  for (const k of open) await k.close().catch(() => {});
  await cloud?.close();
});

async function boot(dir: string, o: { keySlot?: "legacy" | "pending" | "profile"; handoff?: unknown } = {}): Promise<Kernel> {
  const { createKernel } = await import("../src/index.ts");
  const env: Record<string, string | undefined> = { ...process.env, ...cloud!.env, ZR_MODEL_PROVIDER: "upstream", ZR_KERNEL_TCP: "off", ZR_ONBOARDING: "1", ZR_CONTROL_PLANE_SYNC_MS: "off", ZR_BACKUP_TIMER: "off", ZR_SESSION_CHECK_MS: "off", ZR_MODEL_CATALOG_MS: "off" };
  delete env.ZR_FIRM_SLUG;
  delete env.ZR_USER_SLUG;
  delete env.ZR_SEAT_TOKEN;
  const k = await createKernel({ dataDir: dir, env: env as NodeJS.ProcessEnv, ...(o.keySlot ? { keySlot: o.keySlot } : {}), ...(o.handoff ? { handoff: o.handoff } : {}) });
  open.push(k);
  return k;
}
async function close(k: Kernel): Promise<void> {
  await k.close();
  open.splice(open.indexOf(k), 1);
}
const stateFiles = (dir: string) => (readdirSync(dir, { recursive: true }) as string[]).filter((f) => String(f).endsWith("share-confirm.json"));
const nextBroadcast = (k: Kernel, type: string) => new Promise<Record<string, unknown>>((resolve) => k.onBroadcast((m) => m.type === type && resolve(m)));

async function registerOn(dir: string, email: string, name: string): Promise<Kernel> {
  let k = await boot(dir);
  const ra = nextBroadcast(k, "kernel.restart_for_identity");
  await k.invoke("account.register", { email, password: PW, name });
  await ra;
  await close(k);
  k = await boot(dir);
  assert.equal(((await k.invoke("control_plane.sync")) as any).report.steps.seat, "accepted");
  return k;
}

test("申请 → 管理员核对核对码后确认 → 管理员本机设备表含这台、团队共享事项密钥包给它 → 成员取回换证 → 重启后 firm_root", { timeout: 480_000 }, async () => {
  cloud = await startCloudCp({ tenant: "b72u2seed", accountCa: true });
  const meta = await fetch(`${cloud.base}/v1/meta`).then((r) => r.json() as Promise<any>);
  assert.ok(meta.features.includes("device_share_confirm"), JSON.stringify(meta.features));

  // ── 乙：开通、升级为团队、邀请甲 ──
  const dirB = mkdtempSync(join(tmpdir(), "kwl-u2-b-"));
  let kb = await registerOn(dirB, "b-u2k@example.cn", "乙律师");
  assert.equal(((await kb.invoke("workspace.upgrade", { name: "乙律师事务所" })) as any).ok, true);
  assert.equal(((await kb.invoke("kernel.status")) as any).device_issuer, "firm_root", "开通团队的那台电脑是律所根签发的");
  // 复测 N8：升级并改名后，本机记的律所名称随之改为团队名（对外文书署名 doc_style、修订作者、恢复包名称都读它），重启后仍是新名
  assert.equal(((await kb.invoke("kernel.status")) as any).firm_name, "乙律师事务所");
  assert.equal(((await kb.invoke("doc_style.get")) as any).firm_name, "乙律师事务所");
  const inv = (await kb.invoke("team.invites.create", { name: "甲律师", role: "lawyer" })) as any;
  await close(kb);
  kb = await boot(dirB);
  assert.equal(((await kb.invoke("kernel.status")) as any).firm_name, "乙律师事务所", "重启后仍是新名（activation.json 已改写）");
  assert.equal(((await kb.invoke("kernel.status")) as any).activation?.firm?.name, "乙律师事务所", "侧栏读的激活信息同为新名");
  await close(kb);

  // ── 甲：个人工作室 → 接受邀请 → 团队空间档案（账号签发钥直接登记）──
  const dir = mkdtempSync(join(tmpdir(), "kwl-u2-a-"));
  let k = await registerOn(dir, "a-u2k@example.cn", "甲律师");
  const sw = nextBroadcast(k, "kernel.switch_profile");
  const j = (await k.invoke("teams.join", { code: inv.code })) as any;
  assert.deepEqual([j.switched, j.enrolling], [true, true], JSON.stringify(j));
  const h1 = (await sw).handoff as ProfileHandoff;
  await close(k);
  k = await boot(dir, { keySlot: "pending", handoff: h1 });
  await nextBroadcast(k, "kernel.restart_for_identity");
  await close(k);
  k = await boot(dir, { keySlot: "profile" });
  assert.equal(((await k.invoke("control_plane.sync")) as any).report.steps.register, "ok");
  const stT = (await k.invoke("kernel.status")) as any;
  assert.equal(stT.device_issuer, "account_ca");
  const mine = (await k.invoke("devices.list")) as any;
  const myDevice = mine.my_device_id as string;
  const myUser = mine.devices.find((d: any) => d.device_id === myDevice).member_id as string;
  assert.deepEqual(((await k.invoke("team.deviceShare.status")) as any).state, "none");
  const rq = (await k.invoke("team.deviceShare.request")) as any;
  assert.equal(rq.supported, true, JSON.stringify(rq));
  assert.equal(rq.state, "pending");
  assert.match(rq.check_code, /^\d{3} \d{3} \d{3} \d{3}$/);
  const again = (await k.invoke("team.deviceShare.request")) as any;
  assert.equal(again.request_id, rq.request_id, "重发原样返回同一份申请");
  assert.equal(((await k.invoke("team.deviceShare.status")) as any).state, "pending");
  assert.equal(stateFiles(dir).length, 1, "本机记下了申请编号（无秘密）");
  await close(k);

  // ── 乙：确认前甲这台不在本机设备表；电脑待确认里看到申请（带派生的电脑名），本机算出的核对码不给界面 ──
  // 补测 D1：乙本机 users 表里还没有甲（甲没被加进乙的任何事项）——这正是最常见的首次确认，曾报 FOREIGN KEY constraint failed
  kb = await boot(dirB);
  assert.equal(((await kb.invoke("control_plane.sync")) as any).report.steps.register, "ok");
  assert.ok(!((await kb.invoke("devices.list")) as any).devices.some((d: any) => d.device_id === myDevice), "account_ca 电脑不进本机设备表");
  const ls = (await kb.invoke("members.list")) as any;
  const row = ls.join_requests.find((x: any) => x.id === rq.request_id);
  assert.ok(row, JSON.stringify(ls.join_requests));
  assert.deepEqual([row.kind, row.via, row.name, row.role, row.verified, row.local_invite], ["upgrade", "upgrade", "甲律师", "lawyer", true, true]);
  assert.match(String(row.device_name), /^(Mac|Windows|Linux) 电脑 · 第 \d+ 台$|^电脑 · 第 \d+ 台$/, "没起名的电脑按平台与第几台派生（补测 D3）");
  assert.equal(row.check_code, null, "补测 D4：本机算出的核对码不给界面，管理员只能输入对方念出的");
  // 两端按同一函数、同一份公钥算核对码：甲屏幕上的就是乙本机快照里的
  assert.equal(rq.check_code, joinCheckCode({ tid: stT.tenant_id, deviceId: myDevice, signPublicKeyPem: cloud.cp.ops.tenant(stT.tenant_id)!.devices.get(myDevice)!.cert.signPublicKeyPem, encPublicKeyPem: cloud.cp.ops.tenant(stT.tenant_id)!.devices.get(myDevice)!.cert.encPublicKeyPem }));
  // 核对码不一致 / 没填：不能确认
  await assert.rejects(kb.invoke("members.approve", { join_request_id: rq.request_id }), /12 位入组核对码/);
  const wrong = rq.check_code.replace(/\d$/, (x: string) => String((Number(x) + 1) % 10));
  await assert.rejects(kb.invoke("members.approve", { join_request_id: rq.request_id, check_code: wrong }), /核对码不一致/);
  assert.equal(cloud.cp.ops.tenant(stT.tenant_id)!.devices.get(myDevice)!.cert.issuer, "account_ca", "没确认");
  const ap = (await kb.invoke("members.approve", { join_request_id: rq.request_id, check_code: rq.check_code.replace(/ /g, "") })) as any;
  assert.deepEqual([ap.ok, ap.kind], [true, "upgrade"], JSON.stringify(ap));
  assert.equal(cloud.cp.ops.tenant(stT.tenant_id)!.devices.get(myDevice)!.cert.issuer, undefined, "云端设备记录已换成律所根证书");
  // 确认后立即同步过：本机设备表含甲这台；团队共享事项的密钥包给它
  const devB = (await kb.invoke("devices.list")) as any;
  const got = devB.devices.find((d: any) => d.device_id === myDevice);
  assert.ok(got, "确认后管理员本机设备表含这台");
  assert.deepEqual([got.member_id, got.status], [myUser, "active"]);
  // 补测 D1：本机原来没有甲的 users 行——确认时先写 users（账号上的姓名）再写成员记录
  const ro = (await kb.invoke("members.roster")) as any;
  const mine2 = ro.members.find((x: any) => x.member_id === myUser);
  assert.equal(mine2?.name, "甲律师", JSON.stringify(ro.members));
  const m1 = (await kb.invoke("matters.create", { title: "团队共享事项", stance: "原告", consent_status: "not_required" })) as any;
  const add1 = (await kb.invoke("matters.members.add", { matter_id: m1.matter.matter_id, user_id: myUser, matter_role: "editor" })) as any;
  assert.equal(add1.devices_wrapped, 1, JSON.stringify(add1));
  assert.ok(!((await kb.invoke("members.list")) as any).join_requests.some((x: any) => x.id === rq.request_id), "已确认的不再列出");
  await close(kb);

  // ── 甲：取回 → 核验 → 换证 → 请求重启 ──
  k = await boot(dir, { keySlot: "profile" });
  // 本机还是旧证书：同步登记被云端拒（旧 account_ca 证书不再被接受），同步随即取回并换证
  const restart = nextBroadcast(k, "kernel.restart_for_identity");
  const sy = (await k.invoke("control_plane.sync")) as any;
  assert.equal(sy.report.steps.register, "device_cert_superseded", "旧 account_ca 证书登记被拒");
  const st1 = (await k.invoke("team.deviceShare.status")) as any;
  assert.equal(st1.state, "confirmed", JSON.stringify(st1));
  assert.equal(((await k.invoke("kernel.status")) as any).device_issuer, "firm_root", "取回后即报 firm_root");
  await restart;
  await close(k);
  k = await boot(dir, { keySlot: "profile" });
  const st2 = (await k.invoke("kernel.status")) as any;
  assert.equal(st2.device_issuer, "firm_root");
  const sy2 = (await k.invoke("control_plane.sync")) as any;
  assert.equal(sy2.report.steps.register, "ok", JSON.stringify(sy2.report));
  assert.ok(["accepted", "valid", "unchanged"].includes(sy2.report.steps.seat), JSON.stringify(sy2.report));
  assert.deepEqual(((await k.invoke("team.deviceShare.status")) as any).state, "confirmed");
  const own = (await k.invoke("devices.list")) as any;
  assert.equal(own.devices.find((d: any) => d.device_id === myDevice).status, "active", "本机设备表里这台仍是同一编号、在用");
  assert.equal(stateFiles(dir).length, 0, "确认后申请记录已清掉");
  await close(k);
});

test("成员电脑换证的核验：只认本机律所根签的、签发者为律所根、编号 / 成员 / 两把公钥一致、角色不升；写入失败不丢旧证书", () => {
  const root = generateFirmRoot();
  const keys = generateDeviceKeys();
  const now = Date.now();
  const base = { certId: "c1", memberId: "usr_f_m", deviceId: "dev_f_m_D2", role: "lawyer" as const, signPublicKeyPem: keys.signPublicKeyPem, encPublicKeyPem: keys.encPublicKeyPem, issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 86400_000).toISOString() };
  const caKey = generateFirmRoot();
  const own = issueDeviceCertificate(caKey.privateKeyPem, { ...base, issuer: "account_ca" } as any);
  const rows: { sql: string; args: unknown[] }[] = [];
  let failWrite = false;
  const db = {
    tx: (fn: () => void) => fn(),
    get: (sql: string) => (sql.includes("sign_pub_pem") ? { sign_pub_pem: keys.signPublicKeyPem, enc_pub_pem: keys.encPublicKeyPem } : sql.includes("cert_json") ? { cert_json: JSON.stringify(own) } : { s: 0 }),
    run: (sql: string, args: unknown[]) => {
      if (failWrite && sql.startsWith("UPDATE devices")) throw new Error("disk");
      rows.push({ sql, args });
    },
    all: () => [],
  } as unknown as KernelDb;
  let restarts = 0;
  const audits: string[] = [];
  const mk = () =>
    new DeviceShareConfirm({ db, tenantId: "ten_f", userId: "usr_f_m", device: { deviceId: "dev_f_m_D2", cert: own as DeviceCertificate, keys: { signPublicKeyPem: keys.signPublicKeyPem, encPublicKeyPem: keys.encPublicKeyPem, encPrivateKeyPem: keys.encPrivateKeyPem } as any }, firm: { rootPublicKeyPem: root.publicKeyPem }, workspaceDir: mkdtempSync(join(tmpdir(), "kwl-u2-unit-")), call: async () => ({ ok: false, error: "offline" }), requestRestart: () => void (restarts += 1), audit: (a) => void audits.push(a) });
  const s = mk();
  assert.equal(s.issuer(), "account_ca");
  const evil = generateDeviceKeys();
  const otherRoot = generateFirmRoot();
  // 控制面签的（账号签发钥）——即使声称是律所根
  assert.equal(s.adopt(issueDeviceCertificate(caKey.privateKeyPem, base)), "cert_invalid");
  assert.equal(s.adopt(issueDeviceCertificate(caKey.privateKeyPem, { ...base, issuer: "account_ca" } as any)), "issuer_not_firm_root");
  // 别家律所根签的
  assert.equal(s.adopt(issueDeviceCertificate(otherRoot.privateKeyPem, base)), "cert_invalid");
  // 换了公钥 / 编号 / 成员
  assert.equal(s.adopt(issueDeviceCertificate(root.privateKeyPem, { ...base, signPublicKeyPem: evil.signPublicKeyPem })), "key_mismatch");
  assert.equal(s.adopt(issueDeviceCertificate(root.privateKeyPem, { ...base, encPublicKeyPem: evil.encPublicKeyPem })), "key_mismatch");
  assert.equal(s.adopt(issueDeviceCertificate(root.privateKeyPem, { ...base, deviceId: "dev_f_m_D3" })), "identity_mismatch");
  assert.equal(s.adopt(issueDeviceCertificate(root.privateKeyPem, { ...base, memberId: "usr_f_x" })), "identity_mismatch");
  // 升角色
  assert.equal(s.adopt(issueDeviceCertificate(root.privateKeyPem, { ...base, role: "admin" })), "role_raised");
  assert.equal(s.adopt(undefined), "cert_missing");
  assert.equal(rows.length, 0, "以上都没有动本机证书");
  // 写入失败：不采用，旧证书不动
  failWrite = true;
  assert.equal(s.adopt(issueDeviceCertificate(root.privateKeyPem, base)), "apply_failed");
  assert.equal(s.issuer(), "account_ca");
  failWrite = false;
  rows.length = 0;
  const good = issueDeviceCertificate(root.privateKeyPem, base);
  assert.equal(s.adopt(good), null);
  assert.equal(s.issuer(), "firm_root");
  assert.ok(rows.some((r) => r.sql.includes("device_cert_history")), "旧证书留档");
  const upd = rows.find((r) => r.sql.startsWith("UPDATE devices"))!;
  assert.equal(upd.args[0], JSON.stringify(good));
  assert.deepEqual(audits, ["device.share_confirmed"]);
});

test("补测 D5：被拒的结果一直保留（不再只闪一个轮询周期）——之后不再联网取、重启后仍在；“知道了”放下；重新申请覆盖", async () => {
  const keys = generateDeviceKeys();
  const own = issueDeviceCertificate(generateFirmRoot().privateKeyPem, { certId: "c0", memberId: "usr_f_m", deviceId: "dev_f_m_D2", role: "lawyer", signPublicKeyPem: keys.signPublicKeyPem, encPublicKeyPem: keys.encPublicKeyPem, issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 86400_000).toISOString(), issuer: "account_ca" } as any);
  const calls: string[] = [];
  let reply: Record<string, unknown> = { ok: true, join_request_id: "jr_AAAAAAAAAAAAAAAA", status: "pending", created_at: new Date().toISOString() };
  const ws = mkdtempSync(join(tmpdir(), "kwl-u2-d5-"));
  const mk = () =>
    new DeviceShareConfirm({
      db: {} as unknown as KernelDb,
      tenantId: "ten_f",
      userId: "usr_f_m",
      device: { deviceId: "dev_f_m_D2", cert: own as DeviceCertificate, keys: { signPublicKeyPem: keys.signPublicKeyPem, encPublicKeyPem: keys.encPublicKeyPem, encPrivateKeyPem: keys.encPrivateKeyPem } as any },
      firm: { rootPublicKeyPem: generateFirmRoot().publicKeyPem },
      workspaceDir: ws,
      call: async (_m, path) => {
        calls.push(path);
        return { ok: true, status: 200, json: reply };
      },
      requestRestart: () => undefined,
      audit: () => undefined,
      pollMs: 3_600_000,
    });
  const s = mk();
  try {
    assert.equal(((await s.request()) as any).state, "pending");
    reply = { ok: true, status: "rejected", decided_at: "2026-11-27T06:20:00.000Z" };
    const r1 = (await s.status()) as any;
    assert.deepEqual([r1.state, r1.decided_at], ["rejected", "2026-11-27T06:20:00.000Z"]);
    const n = calls.length;
    reply = { ok: false };
    const r2 = (await s.status()) as any;
    assert.equal(r2.state, "rejected", "下一次轮询仍是被拒");
    assert.equal(calls.length, n, "已有结果：不再联网取");
    s.stop();
    const again = mk();
    assert.equal(((await again.status()) as any).state, "rejected", "重启内核后仍在");
    assert.equal((again.dismiss() as any).state, "none", "知道了");
    assert.equal(((await again.status()) as any).state, "none");
    // 过期同样保留；重新申请覆盖
    reply = { ok: true, join_request_id: "jr_BBBBBBBBBBBBBBBB", status: "pending", created_at: new Date().toISOString() };
    assert.equal(((await again.request()) as any).request_id, "jr_BBBBBBBBBBBBBBBB");
    reply = { ok: true, status: "expired", decided_at: "2026-12-04T06:20:00.000Z" };
    assert.equal(((await again.status()) as any).state, "expired");
    reply = { ok: true, join_request_id: "jr_CCCCCCCCCCCCCCCC", status: "pending", created_at: new Date().toISOString() };
    const re = (await again.request()) as any;
    assert.deepEqual([re.state, re.request_id], ["pending", "jr_CCCCCCCCCCCCCCCC"], "被拒 / 过期后重新申请");
    again.stop();
  } finally {
    s.stop();
  }
});
