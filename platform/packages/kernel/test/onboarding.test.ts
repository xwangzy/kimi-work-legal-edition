/**
 * 开通与成员入组（第 13 批；docs/design/开通与成员入组设计-v1.md）端到端：控制面 v0 + 两台模拟设备（两个数据根），全程经闸门的控制面通道。
 * 创始：待激活模式只开放开通方法 → 开通码兑换 → 按 activation.json 重启 → 登记根公钥时出示认领（要求开通码的租户）→ 取得席位；
 * 成员：邀请码兑换 → 本机生成设备密钥并提交申请 → 管理员机列出（核对码一致）并批准（本机律所根签发）→ 成员取回证书 → 重启后
 * 不持律所根、角色是邀请时定的律师、登记取得席位；律所核对码两边一致。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "onboarding-test-secret-0123456789abcd";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatActivationCode } from "@zr-legal/firm-trust";
import { startCloudCp, type CloudCp } from "./cloud-cp.ts";
import type { Kernel } from "../src/index.ts";

const FIRM = "onbk-firm";
const TID = `ten_${FIRM}`;
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

test("开通与成员入组：创始开通码 → 重启按律所身份运行；邀请码 → 管理员批准 → 成员取回证书、不持律所根、取得席位", { timeout: 240_000 }, async () => {
  cloud = await startCloudCp({ tenant: "ten_onbk-unused" });
  cloud.cp.ops.createTenant({ tid: TID, edition: "team", seats: 5, points: 1_000_000, name: "测试律师事务所", activationRequired: true });
  const founderCode = cloud.cp.ops.issueActivationCode(TID, { member: { slug: "li", name: "李主任" } }).code;

  // ── 创始设备 ──
  const dirA = mkdtempSync(join(tmpdir(), "kwl-onb-a-"));
  let a = await boot(dirA);
  const st0 = (await a.invoke("kernel.status")) as any;
  assert.equal(st0.onboarding.mode, "unactivated");
  await assert.rejects(a.invoke("matters.list"), (e: any) => e.code === "not_activated");
  await assert.rejects(a.invoke("onboarding.redeem", { code: "ABCD" }), (e: any) => e.code === "validation");
  const wrong = founderCode.slice(0, 19) + (founderCode[19] === "0" ? "1" : "0");
  await assert.rejects(a.invoke("onboarding.redeem", { code: wrong }), (e: any) => e.code === "validation" && /开通码不正确或已失效/.test(e.message));
  const restartA = nextRestart(a);
  const red = (await a.invoke("onboarding.redeem", { code: formatActivationCode(founderCode).toLowerCase() })) as any;
  assert.equal(red.kind, "founder");
  assert.equal(red.firm.name, "测试律师事务所");
  await restartA;
  const act = JSON.parse(readFileSync(join(dirA, "activation.json"), "utf8"));
  assert.equal(act.firm_slug, FIRM);
  assert.equal(act.member_slug, "li");
  assert.ok(!JSON.stringify(act).includes(founderCode), "activation.json 不含码");
  assert.ok(!readFileSync(join(dirA, "activation.json"), "utf8").includes("claim"), "activation.json 不含认领凭据");
  a = await reboot(a, dirA);
  const st1 = (await a.invoke("kernel.status")) as any;
  assert.equal(st1.firm, FIRM);
  assert.equal(st1.user, "li");
  assert.equal(st1.onboarding, null);
  assert.equal(st1.activation.kind, "founder");
  assert.equal(st1.member_role, "firm_admin");
  assert.ok(!existsSync(join(dirA, "pending-activation")), "占位工作区已删除");
  const sync = (await a.invoke("control_plane.sync")) as any;
  assert.equal(sync.report.steps.register, "ok", JSON.stringify(sync.report.steps));
  assert.ok(cloud.cp.ops.tenant(TID)!.root_public_key_pem, "根公钥已登记");
  assert.ok(!existsSync(join(dirA, FIRM, "keys", "activation-claim.json")), "认领凭据登记后删除");
  const founderRec = [...cloud.cp.ops.tenant(TID)!.activations.values()].find((r) => r.kind === "founder")!;
  assert.equal(founderRec.status, "consumed");

  // ── 管理员邀请成员 ──
  const invite = (await a.invoke("members.invite", { name: "张律师", role: "lawyer" })) as any;
  assert.match(invite.code, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){4}$/);

  // ── 成员设备 ──
  const dirB = mkdtempSync(join(tmpdir(), "kwl-onb-b-"));
  let b = await boot(dirB);
  const rb = (await b.invoke("onboarding.redeem", { code: invite.code })) as any;
  assert.equal(rb.kind, "member");
  assert.equal(rb.next, "wait");
  assert.match(rb.check_code, /^\d{3} \d{3} \d{3} \d{3}$/);
  const stB = (await b.invoke("onboarding.status")) as any;
  assert.equal(stB.mode, "member_pending");
  assert.equal(stB.member.name, "张律师");
  assert.equal(((await b.invoke("onboarding.check")) as any).last_check, "pending");
  // 等待期间 onboarding.json 只有编号与状态，设备私钥在封装的 keys/ 文件里
  const ob = readFileSync(join(dirB, "onboarding.json"), "utf8");
  assert.ok(!/PRIVATE KEY|claim_secret/.test(ob));

  // 管理员机列出：核对码与成员机一致
  const list = (await a.invoke("members.list")) as any;
  assert.equal(list.join_requests.length, 1);
  const jr = list.join_requests[0];
  assert.equal(jr.check_code, rb.check_code);
  assert.equal(jr.name, "张律师");
  assert.equal(jr.local_invite, true);
  await a.invoke("members.approve", { join_request_id: jr.id });

  const restartB = nextRestart(b);
  const chk = (await b.invoke("onboarding.check")) as any;
  assert.equal(chk.last_check, "approved");
  await restartB;
  b = await reboot(b, dirB);
  const st2 = (await b.invoke("kernel.status")) as any;
  assert.equal(st2.firm, FIRM);
  assert.equal(st2.activation.kind, "member");
  assert.equal(((await b.invoke("onboarding.check")) as any).last_check, "approved", "重启后界面再查一次也得到已批准（与内核自动取回赛跑）");
  assert.equal(st2.member_role, "lawyer", "角色是邀请时定的，不被单人工作区规则提升为管理员");
  assert.equal(st2.activation.firm_check_code, chk.firm_check_code);
  assert.equal(st2.activation.firm_check_code, list.firm_check_code, "律所核对码两边一致");
  assert.ok(!existsSync(join(dirB, FIRM, "keys", "firm-root.json")), "成员设备不持律所根");
  assert.ok(!existsSync(join(dirB, FIRM, "keys", "join-approved.json")), "暂存已消费");
  const syncB = (await b.invoke("control_plane.sync")) as any;
  assert.equal(syncB.report.steps.register, "ok", JSON.stringify(syncB.report.steps));
  const seats = cloud.cp.ops.tenant(TID)!.seatsByUser;
  assert.ok(seats.has(st2.user_id), "成员取得席位");
  assert.equal(cloud.cp.ops.tenant(TID)!.devices.get(`dev_${FIRM}_${st2.user}`)?.cert.role, "lawyer");
});
