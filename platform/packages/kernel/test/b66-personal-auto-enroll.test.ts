/**
 * 第 66 批（V40，D-292）端到端：真实控制面（带账号设备签发钥）+ 两个内核数据根，全程经闸门的控制面通道。
 * - 个人账号（自助注册的单人工作室）在第二台电脑上 account.login → 内核按 needs_device_auto 自动登记（生成设备密钥、会话 + 持有证明、
 *   验控制面签名信封、证书由账号设备签发钥签、律所公钥包由律所根签）→ 写 join-approved.json → 重启即进入工作区（不等第一台批准、不按套餐台数挡）；
 * - 新电脑不持律所根；本机账本的证书链按账号设备签发钥核（迁移 0074）；登记、席位照常；
 * - quota.usage_page：经设备签名取本人用量明细（签名信封 kwl-usage-page）。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "b66-auto-enroll-secret-0123456789ab";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCloudCp, type CloudCp } from "./cloud-cp.ts";
import type { Kernel } from "../src/index.ts";

const PW = "Lawyer2026secure";
let cloud: CloudCp | null = null;
const open: Kernel[] = [];
after(async () => {
  for (const k of open) await k.close().catch(() => {});
  await cloud?.close();
});

async function boot(dir: string): Promise<Kernel> {
  const { createKernel } = await import("../src/index.ts");
  const env: Record<string, string | undefined> = { ...process.env, ...cloud!.env, ZR_MODEL_PROVIDER: "upstream", ZR_KERNEL_TCP: "off", ZR_ONBOARDING: "1", ZR_CONTROL_PLANE_SYNC_MS: "off" };
  delete env.ZR_FIRM_SLUG;
  delete env.ZR_USER_SLUG;
  delete env.ZR_SEAT_TOKEN;
  const k = await createKernel({ dataDir: dir, env: env as NodeJS.ProcessEnv });
  open.push(k);
  return k;
}
const nextRestart = (k: Kernel) => new Promise<void>((resolve) => k.onBroadcast((m) => m.type === "kernel.restart_for_identity" && resolve()));
async function reboot(k: Kernel, dir: string): Promise<Kernel> {
  await k.close();
  open.splice(open.indexOf(k), 1);
  return boot(dir);
}

test("个人账号第二台电脑：登录即自动登记（不等第一台批准；台数按云端配置）→ 重启进入工作区；不持律所根；账本证书链按账号设备签发钥核；本人用量明细可翻页", { timeout: 240_000 }, async () => {
  cloud = await startCloudCp({ tenant: "b66seed", accountCa: true });
  const dirA = mkdtempSync(join(tmpdir(), "kwl-b66-a-"));
  let a = await boot(dirA);
  const ra = nextRestart(a);
  await a.invoke("account.register", { email: "qian@example.cn", password: PW, name: "钱律师" });
  await ra;
  a = await reboot(a, dirA);
  const syncA = (await a.invoke("control_plane.sync")) as any;
  assert.equal(syncA.report.steps.seat, "accepted", JSON.stringify(syncA.report.steps));
  const stA = (await a.invoke("kernel.status")) as any;
  const t = cloud.cp.ops.tenant(stA.tenant_id)!;
  assert.equal(t.personal, true);
  assert.ok(t.firm_bundle, "创始电脑登记时上传了律所公钥包");

  // 第 68 批（V42，D-295）：电脑数上限按云端配置（试用套餐 1 台对个人账号同样生效）——这个账号调到 2 台
  cloud.cp.ops.account("qian@example.cn")!.device_limit = 2;
  const dirB = mkdtempSync(join(tmpdir(), "kwl-b66-b-"));
  let b = await boot(dirB);
  const rb = nextRestart(b);
  const r = (await b.invoke("account.login", { email: "qian@example.cn", password: PW })) as any;
  assert.deepEqual([r.kind, r.next, r.auto], ["member", "restart", true], JSON.stringify(r));
  assert.match(r.firm_check_code ?? "", /\d/);
  await rb;
  b = await reboot(b, dirB);
  const st = (await b.invoke("kernel.status")) as any;
  assert.equal(st.member_role, "firm_admin");
  assert.equal(st.account.logged_in, true);
  assert.equal(st.tenant_id, stA.tenant_id);
  const sync = (await b.invoke("control_plane.sync")) as any;
  assert.equal(sync.report.steps.register, "ok", JSON.stringify(sync.report.steps));
  assert.equal(sync.report.steps.seat, "accepted", JSON.stringify(sync.report.steps));
  assert.ok(!existsSync(join(dirB, st.firm, "keys", "firm-root.json")), "第二台不持律所根");
  const devB = [...t.devices.values()].find((d) => d.cert.deviceId.endsWith("_D2"))!;
  assert.equal(devB.cert.issuer, "account_ca");
  // 本机账本：证书链按账号设备签发钥核，不报篡改
  const chain = (await b.invoke("audit.verifyChain")) as any;
  assert.equal(chain.ok, true, JSON.stringify(chain).slice(0, 400));
  // 账号详情：个人账号、两台、最近登录里有新电脑登记
  const me = (await b.invoke("account.me", {})) as any;
  assert.equal(me.personal, true);
  assert.equal(me.devices.filter((d: any) => !d.revoked_at).length, 2);
  assert.ok(me.recent_logins.some((x: any) => x.kind === "enroll"));
  // 第一台同步设备目录：第二台是 account_ca 证书，不进本机设备表、也不告警“证书无效”
  const syncA2 = (await a.invoke("control_plane.sync")) as any;
  assert.ok(!JSON.stringify(syncA2.report).includes("cert_invalid"), JSON.stringify(syncA2.report.steps));
  // 本人用量明细（没有用量时为空页）
  const page = (await b.invoke("quota.usage_page", { limit: 10 })) as any;
  assert.deepEqual([page.mode, page.rows.length, page.next_before], ["control_plane", 0, null]);
  await assert.rejects(b.invoke("quota.usage_page", { limit: 500 }), /1～100/);
  const q = (await b.invoke("quota.status")) as any;
  assert.ok(q.personal && typeof q.personal.remaining_ratio === "number", JSON.stringify(q).slice(0, 300));
  assert.ok(Array.isArray(q.plan.models));
});
