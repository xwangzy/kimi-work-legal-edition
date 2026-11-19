/**
 * 第 47 批（第 46 批遗留 11）：云端停用账号后，问答的模型请求被网关当场拒绝（account_disabled）——内核立即切到“要重新登录”，
 * 不等下一次控制面同步（本用例关掉定时同步：ZR_CONTROL_PLANE_SYNC_MS=off）。
 * 真实控制面 + 法律模型网关（cloud-cp.ts）+ 内核实例，全程经出站闸门：
 * 注册开通 → 同步取得席位令牌 → 控制面把账号置为停用 → 问答 → 网关拒绝 → kernel.status 的 account 立即 login_required、
 * reason=account_disabled，广播 account.login_required（source=model），本机席位令牌清掉 → 管理员启用、律师重新登录 → 恢复、问答照常。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "b47-account-test-secret-0123456789ab";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCloudCp, type CloudCp } from "./cloud-cp.ts";
import type { Kernel } from "../src/index.ts";

const PW = "Lawyer2026secure";
const EMAIL = "zhao@example.cn";
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

test("账号停用：问答被网关拒绝即切到“要重新登录”（不等同步）并广播；启用后重新登录即恢复", { timeout: 240_000 }, async () => {
  cloud = await startCloudCp({ tenant: "ten_b47-unused" });
  const dir = mkdtempSync(join(tmpdir(), "kwl-b47-acc-"));
  let a = await boot(dir);
  const restarted = new Promise<void>((resolve) => a.onBroadcast((m) => m.type === "kernel.restart_for_identity" && resolve()));
  const r = (await a.invoke("account.register", { email: EMAIL, password: PW, name: "赵律师", org_name: "赵律师工作室" })) as any;
  assert.equal(r.kind, "founder");
  await restarted;
  await a.close();
  open.splice(open.indexOf(a), 1);
  a = await boot(dir);
  const events: any[] = [];
  a.onBroadcast((m) => {
    if (m.type === "account.login_required") events.push(m);
  });
  const sync = (await a.invoke("control_plane.sync")) as any;
  assert.equal(sync.report.steps.seat, "accepted", JSON.stringify(sync.report.steps));
  let st = (await a.invoke("kernel.status")) as any;
  assert.deepEqual([st.account.logged_in, st.account.login_required], [true, false]);

  // 运营在控制面停用这个账号（只改账号状态，不经同步通知本机）
  const acc = cloud.cp.ops.account(EMAIL);
  assert.ok(acc);
  acc.status = "disabled";

  // 问答：网关当场拒绝（账号停用）→ 回答处写清；内核立即切到要重新登录
  const q = (await a.invoke("chat.send", { text: "合同解除的法定事由有哪些？", route: "legal/k2.6" })) as any;
  const notice = q.messages.at(-1);
  assert.equal(notice.role, "notice", JSON.stringify(q.messages));
  assert.match(notice.text, /^未能取得回答：(你的账号已被停用|登录已失效)/, notice.text);
  assert.equal(notice.route, "legal/k2.6");
  st = (await a.invoke("kernel.status")) as any;
  assert.equal(st.account.login_required, true, JSON.stringify(st.account));
  assert.equal(st.account.logged_in, false);
  assert.ok(["account_disabled", "session_invalid"].includes(st.account.reason), st.account.reason);
  assert.equal(events.length, 1, JSON.stringify(events));
  assert.equal(events[0].source, "model");
  assert.equal(events[0].reason, st.account.reason);
  assert.equal(typeof events[0].message, "string");
  assert.equal(st.control_plane.seat?.has_token ?? false, false, "本机席位令牌已清掉（AI 停用）");
  const accStatus = (await a.invoke("account.status", {})) as any;
  assert.equal(accStatus.login_required, true);
  assert.ok(accStatus.message, "account.status 给出律师话");

  // 停用期间重新登录：控制面拒绝（账号已停用）
  await assert.rejects(a.invoke("account.login", { email: EMAIL, password: PW }), (e: any) => /账号已停用/.test(e.message));

  // 管理员启用 → 律师重新登录 → 恢复；同步重新取得席位令牌，问答照常
  acc.status = "active";
  const li = (await a.invoke("account.login", { email: EMAIL, password: PW })) as any;
  assert.equal(li.ok, true);
  st = (await a.invoke("kernel.status")) as any;
  assert.deepEqual([st.account.logged_in, st.account.login_required, st.account.reason], [true, false, null]);
  const s2 = (await a.invoke("control_plane.sync")) as any;
  assert.equal(s2.report.steps.seat, "accepted", JSON.stringify(s2.report.steps));
  // 网关领额度失败后 1 秒内不再打账本（legal-gateway quota.ts reserve 的冷却）：真实使用中律师重新登录不会这么快，这里等过冷却
  await sleep(1_200);
  const q2 = (await a.invoke("chat.send", { conversation_id: q.conversation_id, text: "那么约定解除呢？", route: "legal/k3" })) as any;
  const ans = q2.messages.at(-1);
  assert.equal(ans.role, "assistant", JSON.stringify(q2.messages.slice(-2)));
  assert.equal(ans.route_label, "K3");
  assert.equal(events.length, 1, "恢复后没有新的要重新登录广播");
});
