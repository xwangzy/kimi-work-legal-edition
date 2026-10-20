/**
 * 开通与成员入组的控制面篡改（第 14 批复核 A 对第 13 批 A-01/A-03 的余项：两条未覆盖的篡改 + 显示名进核对）。
 * 单独一个文件、单独一个控制面：兑换限速每源每分钟 10 次，与 onboarding.test.ts 放在一起会撞限速。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "onboarding-tamper-secret-0123456789ab";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCloudCp, type CloudCp } from "./cloud-cp.ts";
import type { Kernel } from "../src/index.ts";

let cloud: CloudCp | null = null;
const open: Kernel[] = [];
after(async () => {
  for (const k of open) await k.close().catch(() => {});
  await cloud?.close();
});

async function boot(dir: string): Promise<Kernel> {
  const { createKernel } = await import("../src/index.ts");
  const env: Record<string, string | undefined> = { ...process.env, ...cloud!.env, ZR_MODEL_PROVIDER: "upstream", ZR_KERNEL_TCP: "off", ZR_ONBOARDING: "1" };
  delete env.ZR_FIRM_SLUG;
  delete env.ZR_USER_SLUG;
  const k = await createKernel({ dataDir: dir, env: env as NodeJS.ProcessEnv });
  open.push(k);
  return k;
}

function nextRestart(k: Kernel): Promise<void> {
  return new Promise((resolve) => k.onBroadcast((m) => m.type === "kernel.restart_for_identity" && resolve()));
}

async function reboot(k: Kernel, dir: string): Promise<Kernel> {
  await k.close();
  open.splice(open.indexOf(k), 1);
  return boot(dir);
}

test("控制面篡改：列表后改申请 → 管理员按快照签发、控制面拿不到别人的证书；自造律所根 + 原 MAC → 成员机不采用；兑换时换掉姓名或律所名称 → 核对不通过", { timeout: 240_000 }, async () => {
  const FIRM3 = "onbk-tamper2";
  const TID3 = `ten_${FIRM3}`;
  cloud = await startCloudCp({ tenant: "ten_onbk-unused2" });
  cloud!.cp.ops.createTenant({ tid: TID3, edition: "team", seats: 8, points: 1_000_000, name: "篡改演练二所" });
  const dirA = mkdtempSync(join(tmpdir(), "kwl-onb-t2a-"));
  let a = await boot(dirA);
  const restartA = nextRestart(a);
  await a.invoke("onboarding.redeem", { code: cloud!.cp.ops.issueActivationCode(TID3, { member: { slug: "admin" } }).code });
  await restartA;
  a = await reboot(a, dirA);
  assert.equal(((await a.invoke("control_plane.sync")) as any).report.steps.register, "ok");
  const t = cloud!.cp.ops.tenant(TID3)!;
  const { generateDeviceKeys, generateFirmRoot, issueDeviceCertificate, SoftwareSigner } = await import("@zr-legal/keys");
  const { firmBundleBytes } = await import("@zr-legal/firm-trust");

  // ③ 列表后改申请：管理员列表时核对通过、留了快照；控制面随后把申请里的签名公钥换成自己的
  const inv = (await a.invoke("members.invite", { name: "周律师", role: "lawyer" })) as any;
  const dirD = mkdtempSync(join(tmpdir(), "kwl-onb-t2d-"));
  const dev = await boot(dirD);
  await dev.invoke("onboarding.redeem", { code: inv.code });
  const listed = ((await a.invoke("members.list")) as any).join_requests.find((x: any) => x.name === "周律师");
  assert.equal(listed.verified, true);
  const jr = t.joinRequests.get(listed.id)!;
  const realSignPub = jr.sign_pub;
  jr.sign_pub = generateDeviceKeys().signPublicKeyPem;
  // 管理员不再向控制面取申请，按快照签发：证书里是成员真实的公钥，与被换过的申请对不上，控制面（按自己存的申请）不收
  await assert.rejects(a.invoke("members.approve", { join_request_id: listed.id }), (e: any) => e.detail?.reason === "cert_mismatch");
  assert.equal(jr.status, "pending");
  assert.equal(jr.cert ?? null, null, "控制面没有拿到为它的公钥签发的证书");
  // 控制面把申请还原：同一份快照批准成功，成员拿到的是自己公钥的证书
  jr.sign_pub = realSignPub;
  await a.invoke("members.approve", { join_request_id: listed.id });
  assert.equal((jr.cert as any).signPublicKeyPem, realSignPub);

  // ④ 自造律所根 + 原 MAC：控制面用自己的根为成员真实公钥重签证书、签一份带自己恢复托管公钥的公钥包，管理员的 MAC 原样转交——
  //    证书、根与公钥包彼此一致、都验得过签名，只有 MAC 对不上：成员机不采用，也不写激活记录
  const evil = generateFirmRoot();
  const evilRecovery = generateDeviceKeys().encPublicKeyPem;
  const c0 = jr.cert as any;
  jr.cert = issueDeviceCertificate(evil.privateKeyPem, {
    certId: c0.certId,
    memberId: c0.memberId,
    deviceId: c0.deviceId,
    role: c0.role,
    signPublicKeyPem: c0.signPublicKeyPem,
    encPublicKeyPem: c0.encPublicKeyPem,
    issuedAt: c0.issuedAt,
    expiresAt: c0.expiresAt,
  }) as any;
  jr.firm_bundle = { recovery_public_key_pem: evilRecovery, sig: new SoftwareSigner(evil.privateKeyPem).signSync(firmBundleBytes(TID3, evil.publicKeyPem, evilRecovery)) };
  const realRoot = t.root_public_key_pem;
  t.root_public_key_pem = evil.publicKeyPem;
  await assert.rejects(dev.invoke("onboarding.check"), (e: any) => /核对不通过/.test(e.message));
  assert.ok(!existsSync(join(dirD, "activation.json")), "自造根核对不通过时不写激活记录");
  assert.ok(existsSync(join(dirD, "onboarding.json")), "仍在等待，可请管理员重新批准");
  t.root_public_key_pem = realRoot;

  // ⑤ 兑换时换掉显示名：成员姓名被改成别人 → 成员机按看到的姓名做 HMAC，管理员机按本机邀请记录核对不通过
  const inv5 = (await a.invoke("members.invite", { name: "吴律师", role: "lawyer" })) as any;
  t.activations.get(inv5.activation_id)!.member.name = "王律师";
  const dirE = mkdtempSync(join(tmpdir(), "kwl-onb-t2e-"));
  const e5 = await boot(dirE);
  const r5 = (await e5.invoke("onboarding.redeem", { code: inv5.code })) as any;
  assert.equal(r5.member.name, "王律师", "成员机看到的是控制面给的姓名");
  const l5 = ((await a.invoke("members.list")) as any).join_requests.find((x: any) => x.name === "吴律师");
  assert.equal(l5.verified, false, "姓名被换过的申请核对不通过");
  await assert.rejects(a.invoke("members.approve", { join_request_id: l5.id }), (e: any) => e.code === "conflict");
  // 律所名称被换：同样核对不通过
  const inv6 = (await a.invoke("members.invite", { name: "郑律师", role: "lawyer" })) as any;
  const realName = t.name ?? "篡改演练二所";
  t.name = "冒名律师事务所";
  const dirF = mkdtempSync(join(tmpdir(), "kwl-onb-t2f-"));
  const f6 = await boot(dirF);
  const r6 = (await f6.invoke("onboarding.redeem", { code: inv6.code })) as any;
  assert.equal(r6.firm.name, "冒名律师事务所");
  t.name = realName;
  const l6 = ((await a.invoke("members.list")) as any).join_requests.find((x: any) => x.name === "郑律师");
  assert.equal(l6.verified, false, "律所名称被换过的申请核对不通过");
});
