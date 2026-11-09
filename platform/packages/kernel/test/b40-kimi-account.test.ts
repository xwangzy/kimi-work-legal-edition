/**
 * 第 40 批：内核接 Kimi 账号登录（授权由控制面代办；请求经出站闸门代发，内核本身不联网、不经手 Kimi 令牌）
 * 与百分比口径的发起预估（不出现点数）。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { makeKernel, type TestKernel } from "./helpers.ts";
import { startCloudCp, type CloudCp } from "./cloud-cp.ts";
// @ts-expect-error 纯 JS 开发脚本（无类型声明）
import { startMockKimi } from "../../../scripts/lib/dev-kimi-oauth.mjs";
import { chargedDisplay, estimateDisplay, pctText } from "../src/services/usage-display.ts";

const FIRM = "kimi-firm";
const TID = `ten_${FIRM}`;
let kimi: { base: string; approve(code: string, idx?: number, deny?: boolean): boolean; close(): Promise<void> };
let cloud: CloudCp;
let tk: TestKernel;

before(async () => {
  kimi = await startMockKimi({ interval: 2 });
  cloud = await startCloudCp({ tenant: TID, kimiAccount: { config: { oauth_host: kimi.base, client_id: "kwl-legal-test", api_base: kimi.base } } });
  tk = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream" }, FIRM);
  const r = await tk.inv("control_plane.sync");
  assert.equal(r.report.ok, true, JSON.stringify(r.report));
});
after(async () => {
  await tk.kernel.close();
  await cloud.close();
  await kimi.close();
});

test("Kimi 账号登录：发起拿到验证码与授权页、在授权页确认后轮询绑定；用量视图带本人账号；解绑", { timeout: 60_000 }, async () => {
  assert.deepEqual(await tk.inv("account.kimi_status"), { mode: "control_plane", enabled: true, required: false, account: null });
  const s = await tk.inv("account.kimi_start");
  assert.match(s.user_code, /^[0-9A-F]{4}-[0-9A-F]{4}$/);
  assert.ok(s.verification_uri_complete.startsWith(kimi.base));
  assert.equal("device_code" in s, false);
  await assert.rejects(() => tk.inv("account.kimi_poll", { flow_id: "bad" }), (e: any) => e.code === "validation");
  assert.ok(kimi.approve(s.user_code, 2));
  let r: any = { status: "pending" };
  for (let i = 0; i < 20 && r.status !== "bound"; i++) {
    await new Promise((x) => setTimeout(x, 500));
    r = await tk.inv("account.kimi_poll", { flow_id: s.flow_id });
  }
  assert.equal(r.status, "bound", JSON.stringify(r));
  assert.equal(r.account.nickname, "王**");
  const st = await tk.inv("account.kimi_status");
  assert.deepEqual({ ...st.account, bound_at: "x" }, { nickname: "王**", phone_tail: "0003", level: "Vivace", bound_at: "x" });
  const q = await tk.inv("quota.status");
  assert.equal(q.kimi.own.nickname, "王**");
  assert.equal("members" in q.kimi, false, "成员账号表只用于按成员明细，不原样转给界面");
  const t = cloud.cp.ops.tenant(TID)!;
  assert.equal(t.kimiAccounts.size, 1);
  assert.deepEqual(await tk.inv("account.kimi_unbind"), { ok: true });
  assert.equal(t.kimiAccounts.size, 0);
  // 本机审计记了登录与绑定（不含验证码与授权页地址）
  const rows = tk.kernel.db.all<{ action: string }>(`SELECT action FROM audit_events WHERE action LIKE 'account.kimi%' ORDER BY audit_event_id`);
  assert.deepEqual(rows.map((x) => x.action), ["account.kimi_login_start", "account.kimi_bind", "account.kimi_unbind"]);
});

test("用量显示：发起预估按“这类任务上限的百分比”、任务记录按“本任务预留额度的百分比”，不出现点数", () => {
  assert.equal(estimateDisplay(30, 60), "中等（约为这类任务上限的 50%）");
  assert.equal(estimateDisplay(10, 60), "较少（约为这类任务上限的 17%）");
  assert.equal(estimateDisplay(60, 60), "较大（约为这类任务上限的 100%）");
  assert.equal(estimateDisplay(0, 0, true), "不调用 AI，不占用额度");
  assert.equal(chargedDisplay(27, 60), "已用本任务预留额度的 45%");
  assert.equal(chargedDisplay(0, 60), "未占用额度");
  assert.equal(pctText(0.004), "不到 1%");
  for (const s of [estimateDisplay(30, 60), chargedDisplay(27, 60)]) assert.doesNotMatch(s, /点/);
});
