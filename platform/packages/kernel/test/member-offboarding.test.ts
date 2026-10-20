// v9.3 第 14 批续（B-10 成员离所；评审 Z4 §五第 5 项、P1-8；D-94）：离所的人在自己电脑上交接（个人事项导出归档、团队事项交负责人与中继控制），
// 管理员移出律所（停用全部电脑、释放席位）；验收线：离所后，交接过的团队事项仍可由接手的同事调整成员。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeKernel, type TestKernel } from "./helpers.ts";
import { startCloudCp, type CloudCp } from "./cloud-cp.ts";
import { createKernel } from "../src/index.ts";

const FIRM = "off-firm";
const TID = `ten_${FIRM}`;
const usr = (s: string) => `usr_${FIRM}_${s}`;
type K = { kernel: Awaited<ReturnType<typeof createKernel>>; dir: string; inv: (m: string, p?: any) => Promise<any> };
let cloud: CloudCp;
let kA: TestKernel;
let kB: K;
let kC: K;

before(async () => {
  cloud = await startCloudCp({ tenant: TID });
  kA = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_RELAY_SYNC_MS: "off" }, FIRM);
  await kA.inv("control_plane.sync");
  const second = async (slug: string): Promise<K> => {
    const ws = mkdtempSync(join(tmpdir(), `kwl-off-${slug}-`));
    mkdirSync(join(ws, FIRM, "keys"), { recursive: true });
    copyFileSync(join(kA.dir, FIRM, "keys", "firm-root.json"), join(ws, FIRM, "keys", "firm-root.json"));
    const kernel = await createKernel({ dataDir: ws, firmSlug: FIRM, userSlug: slug, env: { ...process.env, ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_RELAY_SYNC_MS: "off" } });
    return { kernel, dir: ws, inv: (m, p) => kernel.invoke(m, p) };
  };
  kB = await second("bob");
  kC = await second("carol");
  for (const k of [kB, kC, kA, kB, kC]) await k.inv("control_plane.sync");
  const body = { max_mode: "default", auto_preauthorizations: [], fetch_allowlist_extra: [], l3a_standard_model: "deny", share_relay: "allow" };
  const { draft } = await kA.inv("firm_policy.create_draft", { kind: "policy", body });
  await kA.inv("firm_policy.sign", { draft_id: draft.draft_id, expected_digest: draft.digest });
  await kA.inv("firm_policy.publish", { draft_id: draft.draft_id });
  await cloud.feed.refresh();
  for (const k of [kB, kC]) await k.inv("control_plane.sync");
});
after(async () => {
  for (const k of [kB, kC]) await k.kernel.close().catch(() => {});
  await kA.kernel.close();
  await cloud.close();
});

const imp = (k: K | TestKernel, mid: string, fn: string, t: string) =>
  k.inv("materials.import", { matter_id: mid, filename: fn, data_base64: Buffer.from(t, "utf8").toString("base64"), mime: "text/plain" });
const hasDoc = (k: K | TestKernel, mid: string, fn: string) => !!k.kernel.db.get(`SELECT 1 AS x FROM document_versions WHERE matter_id = ? AND filename = ?`, [mid, fn]);
const syncPair = async () => {
  for (let i = 0; i < 2; i++) for (const k of [kC, kB]) await k.inv("relay.sync");
};
const itemOf = (r: any, mid: string) => r.matters.find((x: any) => x.matter_id === mid);

test("离所交接：个人事项导出归档、团队事项交负责人与中继控制；管理员移出后，接手的同事仍可调整成员（未交接的事项如实拦下）", { timeout: 300_000 }, async () => {
  const team = async (title: string, bobRole: string) => {
    const m = (await kC.inv("matters.create", { title, stance: "受让方", consent_status: "not_required", collab_scope: "team" })).matter.matter_id as string;
    await kC.inv("matters.members.add", { matter_id: m, user_id: usr("bob"), matter_role: bobRole });
    await imp(kC, m, `${title}-甲.txt`, "甲");
    return m;
  };
  const m1 = await team("交给乙", "editor");
  const m2 = await team("没交接", "owner");
  const p1 = (await kC.inv("matters.create", { title: "只在本机", stance: "受让方", consent_status: "not_required" })).matter.matter_id as string;
  await imp(kC, p1, "个人.txt", "只在 carol 电脑上");
  await syncPair();
  for (const m of [m1, m2]) assert.equal(cloud.relay.server.tenant(TID)!.controller(m), usr("carol"));
  assert.ok(hasDoc(kB, m1, "交给乙-甲.txt"), "bob 已收到并成为中继读者");

  // 清单：m1 没有别的负责人；m2 有别的负责人但 carol 是中继控制成员；p1 只在本机、没导出过
  let off = await kC.inv("members.offboarding");
  assert.equal(itemOf(off, m1).status, "needs_owner");
  assert.deepEqual(itemOf(off, m1).colleagues.map((c: any) => c.user_id), [usr("bob")]);
  assert.equal(itemOf(off, m2).status, "needs_handoff");
  assert.equal(itemOf(off, p1).status, "needs_archive");
  assert.equal(off.pending, 3);

  // 个人事项：导出归档后算交接完成；之后再有新改动又要重新导出
  await kC.inv("matters.archive", { matter_id: p1 });
  assert.equal(itemOf(await kC.inv("members.offboarding"), p1).status, "ok");
  await imp(kC, p1, "导出后又加的.txt", "新材料");
  assert.equal(itemOf(await kC.inv("members.offboarding"), p1).status, "needs_archive", "导出之后又有改动：要重新导出");
  await kC.inv("matters.archive", { matter_id: p1 });
  assert.equal(itemOf(await kC.inv("members.offboarding"), p1).status, "ok");
  // 只在本机的事项不能“交给同事”
  await assert.rejects(kC.inv("members.offboard_handoff", { matter_id: p1, to_user: usr("bob") }), /导出归档/);
  // 只能交给事项里在用的同事
  await assert.rejects(kC.inv("members.offboard_handoff", { matter_id: m1, to_user: usr("test-lawyer") }), /不是这个事项的成员/);

  // 第一步：bob 设为负责人；中继只把管理权交给在这个事项里发出过改动的电脑——bob 还没有，如实说明还差一步
  const h0 = await kC.inv("members.offboard_handoff", { matter_id: m1, to_user: usr("bob") });
  assert.equal(h0.owner_set, true);
  assert.equal(h0.relay, "pending");
  assert.match(h0.note, /同步过一次自己的改动/);
  assert.equal(h0.item.status, "needs_handoff");
  await syncPair();
  await imp(kB, m1, "乙.txt", "bob 的改动");
  await syncPair();
  const h = await kC.inv("members.offboard_handoff", { matter_id: m1, to_user: usr("bob") });
  assert.equal(h.owner_set, false, "已是负责人，不再重复设");
  assert.equal(h.relay, "done", h.note);
  assert.equal(h.item.status, "ok");
  assert.equal(cloud.relay.server.tenant(TID)!.controller(m1), usr("bob"));
  off = await kC.inv("members.offboarding");
  assert.equal(off.pending, 1, "只剩 m2 没交接");

  // 管理员：成员列表、移出前提醒、不能移出自己
  const roster = await kA.inv("members.roster");
  assert.equal(roster.can_remove, true);
  const carol = roster.members.find((x: any) => x.member_id === usr("carol"));
  assert.equal(carol.status, "active");
  assert.equal(roster.members.find((x: any) => x.is_me).member_id, usr("test-lawyer"));
  const pv = await kA.inv("members.removal_preview", { member_id: usr("carol") });
  assert.equal(pv.active_devices, 1);
  assert.deepEqual(pv.matters, [], "管理员不在这些事项里：本机不知道，交接只能由本人做");
  await assert.rejects(kA.inv("members.remove", { member_id: usr("test-lawyer") }), /不能移出自己/);
  await assert.rejects(kA.inv("members.remove", { member_id: usr("nobody") }), /成员/);

  // 停用电脑不等于移出律所（复核 R15A-02）：只停用了电脑的人显示“电脑都已停用”，席位还占着，仍可移出
  const carolDevice = carol.devices[0].device_id as string;
  const stop = await kA.inv("devices.revoke", { device_id: carolDevice, reason: "丢失" });
  assert.match(stop.lawyer_note, /已停用这台电脑/);
  assert.doesNotMatch(stop.lawyer_note, /纪元|吊销|验签/);
  assert.equal((await kA.inv("members.roster")).members.find((x: any) => x.member_id === usr("carol")).status, "devices_stopped");
  // 不能在这台电脑上停用它自己（复核 R15A-03）
  await assert.rejects(kA.inv("devices.revoke", { device_id: roster.members.find((x: any) => x.is_me).devices[0].device_id }), /不能在这台电脑上停用它自己/);
  // “只有开通律所（持有律所根）的电脑能移出成员”这里测不出来：只有 alice 一位管理员（处置表 R15A-03 记为无用例）
  // 中软暂时连不上：席位释放记下来，之后随同步自动重试（复核 R15A-11）
  cloud.setControlPlaneAvailable(false);
  const rm = await kA.inv("members.remove", { member_id: usr("carol") });
  cloud.setControlPlaneAvailable(true);
  assert.equal(rm.devices_revoked, 0, "电脑此前已停用");
  assert.equal(rm.seat_released, false);
  assert.match(rm.note, /之后每次同步会自动再试/);
  let after = (await kA.inv("members.roster")).members.find((x: any) => x.member_id === usr("carol"));
  assert.equal(after.status, "removed");
  assert.equal(after.removal.seat_released, false);
  await kA.inv("control_plane.sync");
  after = (await kA.inv("members.roster")).members.find((x: any) => x.member_id === usr("carol"));
  assert.equal(after.removal.seat_released, true, "同步时自动释放了席位");
  // 再点一次是幂等的
  assert.equal((await kA.inv("members.remove", { member_id: usr("carol") })).devices_revoked, 0);

  // carol 的电脑：下次与控制面同步即进入退出模式，不能再同步、交接，也不能再把事项导出成明文（复核 R15A-04）；应用内预览照常
  await kC.inv("control_plane.sync");
  await assert.rejects(kC.inv("relay.sync"), /不可用/);
  await assert.rejects(kC.inv("members.offboard_handoff", { matter_id: m2, to_user: usr("bob") }), /不可用/);
  await assert.rejects(kC.inv("matters.archive", { matter_id: p1 }), /已被律所停用/);

  // 交接过的事项：bob 的电脑提醒“还有电脑已全部停用的成员”（复核 R15A-05）；bob 不知道 carol 是否已离所——须明确确认（复核 R15A-01）
  await kB.inv("control_plane.sync");
  await kB.inv("relay.sync");
  const departed = await kB.inv("members.departed_in_matters");
  assert.deepEqual(departed.items.map((x: any) => x.matter_id).sort(), [m1, m2].sort());
  await assert.rejects(kB.inv("matters.members.remove", { matter_id: m1, user_id: usr("carol") }), /确认他已离所/);
  const r = await kB.inv("matters.members.remove", { matter_id: m1, user_id: usr("carol"), confirm_departed: true });
  assert.ok(r.new_epoch > 1);
  await imp(kB, m1, "移出后.txt", "carol 离所之后");
  assert.ok((await kB.inv("relay.sync")).push.uploaded > 0, "新纪元的内容照常发出");
  // 没交接的事项：中继上的控制成员已离所，bob 调整不了成员——如实说明须找中软客服办理（D-94 残余）
  await assert.rejects(kB.inv("matters.members.add", { matter_id: m2, user_id: usr("test-lawyer") }), /电脑已全部停用.*中软客服/);
});
