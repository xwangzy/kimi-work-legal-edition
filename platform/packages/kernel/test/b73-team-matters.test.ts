/**
 * 第 73 批（V47，D-307～D-309，契约 02 §2.1～§2.6）：律师端团队共享事项入口的内核部分。
 *
 * 一、纯函数：同事名单答复的校验与成员编号、“连不上 / 旧云端”的判定；开通同事之间同步的底稿（只改 share_relay）、剩余天数与到期提醒、状态。
 * 二、旧律所体系（两台律所根管理员电脑，律所版门限 2；真实控制面 + 中继，全程经内核方法）：
 *     L3b 不能团队共享（建与转都拒）；团队 → 个人拒绝（scope_irreversible）；改范围把字段放在顶层 → 说明要放 patch（V46 10b 的“无可更新字段”即此）；
 *     个人 → 团队立即锚定成员链；开通同步未达门限 → pending_second_signature，第二位管理员在自己电脑上“开通”即签同一份并发布；
 *     非负责人不能改范围、不能加人；事项成员视图（my_role / can_manage / sync）；移出的结果说明。
 *     实拍补：team.refresh_share_state 的节流与“等在跑的同步”；上手清单第 1 步把同事加我的团队共享事项也算上（guide.progress）。
 * 三、账号体系（真实控制面带账号设备签发钥 + W1 的 GET /v1/team/roster）：个人空间不可选团队；账号签发钥登记的电脑不能建 / 转团队事项；
 *     同事名单（不含邮箱手机号、can_receive、封装缓存）；建事项同时加同事一个事务（名单外的人整体失败、不留半个事项）；存真实姓名；
 *     离线用缓存名单、缓存也没有 → roster_unavailable；开通同步以当前生效规则为底稿不收紧其它项；续期与到期前 7 天提醒；
 *     同事被移出团队 → 事项成员标“已离开团队”、不能再加。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "b73-team-matters-secret-0123456789";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strictestTemplate } from "@zr-legal/firm-trust";
import { startCloudCp, type CloudCp } from "./cloud-cp.ts";
import { importText, makeKernel, type TestKernel } from "./helpers.ts";
import type { Kernel } from "../src/index.ts";
import type { ProfileHandoff } from "../src/profiles.ts";
import { rosterFromReply, rosterOfflineCode, rosterUnsupportedCode, rosterUserId } from "../src/services/team-roster.ts";
import { AI_SUBPROCESSORS, AI_SUBPROCESSORS_TEAM, dataFlowsFor } from "../src/services/ai-authorization.ts";
import { carriedRelaxations, daysLeftOf, enableBodyOf, expiringOf, sameBody, seatProblemOf, shareRelayStateOf, signerCount } from "../src/services/share-relay-policy.ts";

/** 律师层的报错不讲这些词（D-310；第 73 批补四项第 2 条）。 */
const JARGON = /中继|控制成员|纪元|包裹|证书|密钥/;
const fault = (code: string, reason?: string) => (e: any) => {
  assert.equal(e?.code, code, `${e?.code}：${e?.message}`);
  if (reason) assert.equal(e?.detail?.reason, reason, JSON.stringify(e?.detail));
  return true;
};

// ───────────────────────── 一、纯函数 ─────────────────────────

test("同事名单答复：只认本租户；成员编号与控制面同式；丢掉不合格的项；不认识的状态不当作在用；只留显示用的四项", () => {
  const tid = "ten_b73unit";
  assert.equal(rosterUserId(tid, "zhang"), "usr_b73unit_zhang");
  assert.equal(rosterFromReply({ ok: true, tid: "ten_other", members: [] }, tid), null, "别的租户的名单不收");
  assert.equal(rosterFromReply({ ok: false }, tid), null);
  assert.equal(rosterFromReply({ ok: true, members: "x" }, tid), null);
  const r = rosterFromReply(
    {
      ok: true,
      tid,
      members: [
        { member_slug: "wang", name: "王律师", role: "lawyer", status: "active", email: "w@example.cn", phone: "13800000000", aid: "acc_AAAAAAAAAAAAAAAA" },
        { member_slug: "li", name: "  李\n律师 ", role: "partner", status: "removed" },
        { member_slug: "zhao", name: "赵律师", role: "admin", status: "weird" },
        { member_slug: "Bad Slug", name: "坏", role: "lawyer", status: "active" },
        { member_slug: "wang", name: "重复", role: "lawyer", status: "active" },
        { name: "没有标识" },
      ],
    },
    tid,
  )!;
  assert.deepEqual(
    r.map((m) => [m.user_id, m.name, m.role, m.status]),
    [
      ["usr_b73unit_li", "李律师", "partner", "removed"],
      ["usr_b73unit_wang", "王律师", "lawyer", "active"],
      ["usr_b73unit_zhao", "赵律师", "admin", "disabled"],
    ].sort((a, b) => a[1]!.localeCompare(b[1]!, "zh")),
  );
  for (const m of r) assert.deepEqual(Object.keys(m).sort(), ["member_slug", "name", "role", "seat", "status", "user_id"], "不带邮箱、手机号、账号编号");
  assert.ok(r.every((m) => m.seat === null), "旧云端不给席位：为 null");
  assert.deepEqual(rosterFromReply({ ok: true, tid, members: [{ member_slug: "qian", name: "钱", role: "lawyer", status: "active", seat: false }] }, tid)![0]!.seat, false);
  // 连不上 → 用缓存；旧云端 / 闸门没放行 → 不支持
  for (const c of ["cp_unreachable", "cp_timeout", "cp_tls_pin_mismatch", "gate_unavailable", "http_503"]) assert.equal(rosterOfflineCode(c), true, c);
  for (const c of ["cp_path_not_allowed", "team_only", "session_invalid", "not_found"]) assert.equal(rosterOfflineCode(c), false, c);
  for (const c of ["cp_path_not_allowed", "not_found", "http_404"]) assert.equal(rosterUnsupportedCode(c), true, c);
  assert.equal(rosterUnsupportedCode("session_invalid"), false);
});

test("开通同事之间同步的底稿：当前生效规则只改 share_relay（不收紧、不放宽其它项）；状态、剩余天数与到期前 7 天提醒", () => {
  const cur = { ...strictestTemplate(), max_mode: "auto" as const, auto_preauthorizations: ["search_generalized" as const], fetch_allowlist_extra: ["www.court.example.cn"], l3a_standard_model: "allow" as const, support_upload: "allow" as const };
  const b = enableBodyOf(cur);
  assert.deepEqual(b, { ...cur, share_relay: "allow" }, "其它五项原样");
  assert.deepEqual(carriedRelaxations(b), ["max_mode:auto", "auto_preauthorization:search_generalized", "fetch_allowlist:www.court.example.cn", "l3a_standard_model:allow", "support_upload:allow"]);
  assert.deepEqual(enableBodyOf({ ...strictestTemplate(), max_mode: "manual" }), { ...strictestTemplate(), max_mode: "manual", share_relay: "allow" }, "比最严还严的档位上限也原样保留（不放宽成“默认”）");
  assert.equal(sameBody({ ...b }, JSON.parse(JSON.stringify(b))), true);
  assert.equal(sameBody(b, { ...b, l3a_standard_model: "deny" }), false);
  assert.equal(sameBody(b, { ...b, unknown: 1 }), false, "认不出的字段不算一致");
  const now = Date.parse("2026-11-27T00:00:00Z");
  assert.equal(daysLeftOf("2026-12-04T00:00:00Z", now), 7);
  assert.equal(daysLeftOf("2026-12-04T00:00:01Z", now), 8);
  assert.equal(daysLeftOf("2026-11-01T00:00:00Z", now), 0);
  assert.equal(daysLeftOf(null, now), null);
  assert.deepEqual(expiringOf("allowed", "2026-12-04T00:00:00Z", now), { days_left: 7 });
  assert.equal(expiringOf("allowed", "2026-12-05T00:00:00Z", now), null);
  assert.equal(expiringOf("not_allowed", "2026-12-01T00:00:00Z", now), null);
  assert.equal(signerCount([{ member_id: "a" }, { member_id: "a" }, { member_id: "b" }]), 2, "门限按成员计");
  // 没有席位：没分配到（no_seat）与名额被释放 / 收回（seat_revoked）同样算（11-27 实拍）
  for (const c of ["credential_no_seat", "credential_seat_revoked"]) assert.equal(seatProblemOf(c, null, true), true, c);
  for (const st of ["no_seat", "seat_revoked"]) assert.equal(seatProblemOf(null, st, false), true, st);
  assert.equal(seatProblemOf(null, "seat_revoked", true), false, "席位令牌已重新取得");
  assert.equal(seatProblemOf("credential_cp_unreachable", "cp_unreachable", false), false, "连不上不是没有席位");
  assert.equal(seatProblemOf("credential_backoff", "accepted", true), false);
  assert.equal(shareRelayStateOf({ effectiveAllows: true, fallback: false, latestAllows: true, pendingEnable: true }), "allowed");
  assert.equal(shareRelayStateOf({ effectiveAllows: false, fallback: false, latestAllows: false, pendingEnable: true }), "pending_second_signature");
  assert.equal(shareRelayStateOf({ effectiveAllows: false, fallback: true, latestAllows: true, pendingEnable: false }), "expired");
  assert.equal(shareRelayStateOf({ effectiveAllows: false, fallback: true, latestAllows: false, pendingEnable: false }), "not_allowed");
});

// ───────────────────────── 二、旧律所体系（律所版，门限 2） ─────────────────────────

const FIRM = "b73l-firm";
const usr = (s: string) => `usr_${FIRM}_${s}`;
let legacyCloud: CloudCp | null = null;
let kA: TestKernel | null = null;
const legacyOthers: { kernel: Kernel; inv: TestKernel["inv"] }[] = [];
after(async () => {
  for (const k of legacyOthers) await k.kernel.close().catch(() => {});
  await kA?.kernel.close().catch(() => {});
  await legacyCloud?.close();
});

async function secondLegacy(slug: string): Promise<{ kernel: Kernel; inv: TestKernel["inv"] }> {
  const ws = mkdtempSync(join(tmpdir(), `kwl-b73-${slug}-`));
  mkdirSync(join(ws, FIRM, "keys"), { recursive: true });
  copyFileSync(join(kA!.dir, FIRM, "keys", "firm-root.json"), join(ws, FIRM, "keys", "firm-root.json"));
  const { createKernel } = await import("../src/index.ts");
  // ZR_RELAY_PROBE_MS=0：用例里“是否已被移出”的核对不节流（产品缺省每事项 60 秒）
  const kernel = await createKernel({ dataDir: ws, firmSlug: FIRM, userSlug: slug, env: { ...process.env, ...legacyCloud!.env, ZR_MODEL_PROVIDER: "upstream", ZR_RELAY_PROBE_MS: "0" } });
  const k = { kernel, inv: (m: string, p?: any) => kernel.invoke(m, p) as Promise<any> };
  legacyOthers.push(k);
  return k;
}

test("旧律所体系：L3b 不能团队共享；团队 → 个人拒绝；字段放顶层说明要放 patch；个人 → 团队即锚定成员链；同事名单不支持；开通同步两位管理员各签一次", { timeout: 300_000 }, async () => {
  legacyCloud = await startCloudCp({ tenant: `ten_${FIRM}`, edition: "firm" });
  kA = await makeKernel({ ...legacyCloud.env, ZR_MODEL_PROVIDER: "upstream" }, FIRM);
  const inv = kA.inv;
  assert.equal((await inv("control_plane.sync")).report.ok, true);
  const kB = await secondLegacy("bob");
  assert.equal((await kB.inv("control_plane.sync")).report.ok, true);
  for (const k of [kA, kB]) assert.equal((await k.inv("control_plane.sync")).report.ok, true);
  assert.ok(kA.kernel.db.get(`SELECT 1 AS x FROM devices WHERE member_id = ? AND status = 'active'`, [usr("bob")]), "A 已从设备目录取得 B 的电脑");

  // L3b：客户要求不上云（strict）与客户拒绝云端处理（refused）都不能建成团队事项，也不能转成团队事项
  const nBefore = (await inv("matters.list")).matters.length;
  await assert.rejects(inv("matters.create", { title: "不上云", stance: "原告", consent_status: "not_required", confidentiality: "strict", collab_scope: "team" }), fault("team_scope_unavailable", "client_no_cloud"));
  await assert.rejects(inv("matters.create", { title: "拒绝云端", stance: "原告", consent_status: "refused", collab_scope: "team" }), fault("team_scope_unavailable", "client_no_cloud"));
  assert.equal((await inv("matters.list")).matters.length, nBefore, "拒绝时没建出事项");
  const strict = (await inv("matters.create", { title: "不上云个人事项", stance: "原告", consent_status: "not_required", confidentiality: "strict" })).matter;
  await assert.rejects(inv("matters.update", { matter_id: strict.matter_id, patch: { collab_scope: "team" } }), fault("team_scope_unavailable", "client_no_cloud"));
  // 个人事项不能同时加同事
  await assert.rejects(inv("matters.create", { title: "个人加人", stance: "原告", consent_status: "not_required", members: [{ user_id: usr("bob"), matter_role: "editor" }] }), /只有“和同事一起办”/);
  await assert.rejects(inv("matters.create", { title: "角色不对", stance: "原告", consent_status: "not_required", collab_scope: "team", members: [{ user_id: usr("bob"), matter_role: "owner" }] }), /editor（一起办）或 viewer（只看）/);

  // V46 10b：把 collab_scope 放在顶层 → 说明要放 patch（原来回“无可更新字段”）
  const p1 = (await inv("matters.create", { title: "以后一起办", stance: "原告", consent_status: "not_required" })).matter;
  await assert.rejects(inv("matters.update", { matter_id: p1.matter_id, collab_scope: "team" }), fault("validation", "patch_missing"));
  assert.equal((await inv("matters.get", { matter_id: p1.matter_id })).matter.collab_scope, "personal", "没改");
  // 个人 → 团队（负责人）：立即锚定成员链；不可逆
  const up = await inv("matters.update", { matter_id: p1.matter_id, patch: { collab_scope: "team" } });
  assert.equal(up.matter.collab_scope, "team");
  assert.match(up.lawyer_note, /不能再改回只有我/);
  assert.match(up.lawyer_note, /所内开通同事之间同步后/, "所内还没开通时如实说明");
  const log = await inv("matters.member_log", { matter_id: p1.matter_id });
  assert.ok(JSON.stringify(log).includes("anchor"), `转成团队即锚定：${JSON.stringify(log).slice(0, 300)}`);
  await assert.rejects(inv("matters.update", { matter_id: p1.matter_id, patch: { collab_scope: "personal" } }), fault("scope_irreversible", "team_to_personal"));
  assert.equal((await inv("matters.get", { matter_id: p1.matter_id })).matter.collab_scope, "team");
  // 同值不算改动
  assert.match((await inv("matters.update", { matter_id: p1.matter_id, patch: { collab_scope: "team" } })).note, /没有变化/);
  // D-307 补拦截：已和同事一起办的事项不能再设为“客户要求不上云”（strict 或记客户拒绝云端处理）
  const pv = (await inv("matters.get", { matter_id: p1.matter_id })).matter.policy_version;
  await assert.rejects(inv("matters.update", { matter_id: p1.matter_id, patch: { confidentiality: "strict" } }), (e: any) => fault("team_scope_conflict", "strict")(e) && /另建一个只有我的事项/.test(e.message) && !JARGON.test(e.message));
  await assert.rejects(inv("matters.update", { matter_id: p1.matter_id, patch: { consent_status: "refused" } }), fault("team_scope_conflict", "consent_refused"));
  const after1 = (await inv("matters.get", { matter_id: p1.matter_id })).matter;
  assert.deepEqual([after1.confidentiality, after1.consent_status, after1.policy_version], ["normal", "not_required", pv], "没改");
  assert.equal((await inv("matters.update", { matter_id: p1.matter_id, patch: { confidentiality: "high" } })).matter.confidentiality, "high", "敏感（L3a）照常可设");
  assert.equal((await inv("matters.update", { matter_id: strict.matter_id, patch: { consent_status: "refused" } })).matter.consent_status, "refused", "只有我的事项照常可记客户拒绝");

  // 旧律所体系没有云端同事名单
  assert.deepEqual(await inv("team.roster"), { available: false, reason: "not_supported", fetched_at: null, members: [] });

  // 开通同事之间同步（律所版门限 2）：A 签了等 B；B 在自己电脑上“开通”即签同一份并发布
  const s0 = await inv("firm_policy.share_relay_status");
  assert.deepEqual([s0.relay_configured, s0.state, s0.can_manage, s0.threshold, s0.signatures, s0.pending], [true, "not_allowed", true, 2, 0, null], JSON.stringify(s0));
  const e1 = await inv("firm_policy.share_relay_enable");
  assert.deepEqual([e1.published, e1.state, e1.signatures, e1.threshold], [false, "pending_second_signature", 1, 2], JSON.stringify(e1));
  assert.match(e1.lawyer_note, /还需另一位管理员/);
  const e1b = await inv("firm_policy.share_relay_enable");
  assert.equal(e1b.draft_id, e1.draft_id, "再点一次：同一份草稿，不重复起草");
  assert.equal(e1b.state, "pending_second_signature");
  const sB = await kB.inv("firm_policy.share_relay_status");
  assert.deepEqual([sB.state, sB.pending?.draft_id, sB.pending?.signed_by_me, sB.signatures], ["pending_second_signature", e1.draft_id, false, 1], JSON.stringify(sB));
  const eB = await kB.inv("firm_policy.share_relay_enable");
  assert.deepEqual([eB.published, eB.state, eB.draft_id], [true, "allowed", e1.draft_id], JSON.stringify(eB));
  assert.ok(eB.days_left === 30 || eB.days_left === 29, String(eB.days_left));
  await legacyCloud.feed.refresh();
  assert.equal((await inv("control_plane.sync")).report.ok, true);
  const sA = await inv("firm_policy.share_relay_status");
  assert.equal(sA.state, "allowed");
  assert.equal((await inv("kernel.status")).share_relay_expiring, null, "还有 30 天：不提醒");
  // 已开通再点：不重复签
  assert.equal((await inv("firm_policy.share_relay_enable")).published, false);
});

test("旧律所体系：建团队事项同时加同事；事项成员视图与同步状态；非负责人不能改范围、不能加人；负责人移出有结果说明", { timeout: 300_000 }, async () => {
  const inv = kA!.inv;
  const kB = legacyOthers[0]!;
  const made = await inv("matters.create", { title: "一起办的并购案", stance: "受让方", consent_status: "not_required", collab_scope: "team", members: [{ user_id: usr("bob"), matter_role: "editor" }] });
  const mid = made.matter.matter_id as string;
  assert.equal(made.members_added.length, 1);
  assert.deepEqual([made.members_added[0].user_id, made.members_added[0].devices_wrapped, made.members_added[0].can_receive], [usr("bob"), 1, true], JSON.stringify(made.members_added));
  const l0 = await inv("matters.members.list", { matter_id: mid });
  assert.deepEqual([l0.collab_scope, l0.my_role, l0.is_owner, l0.can_manage, l0.sync], ["team", "owner", true, true, "pending"], JSON.stringify(l0));
  assert.deepEqual(l0.members.map((m: any) => [m.user_id, m.matter_role, m.is_me, m.can_receive, m.departed]), [
    [usr("test-lawyer"), "owner", true, true, false],
    [usr("bob"), "editor", false, true, false],
  ]);
  const a1 = await inv("relay.sync");
  assert.deepEqual(a1.push.errors, [], JSON.stringify(a1.push));
  assert.equal((await inv("matters.members.list", { matter_id: mid })).sync, "ok");
  const b1 = await kB.inv("relay.sync");
  assert.ok(b1.pull.applied >= 1, JSON.stringify(b1.pull));
  const lB = await kB.inv("matters.members.list", { matter_id: mid });
  assert.deepEqual([lB.my_role, lB.is_owner, lB.can_manage], ["editor", false, false], JSON.stringify(lB));
  assert.deepEqual(lB.members.map((m: any) => [m.user_id, m.is_me]), [
    [usr("test-lawyer"), false],
    [usr("bob"), true],
  ]);
  // 实拍补 2：上手清单第 1 步按“我在其中、未删除的事项”算——B 自己一个没建，被 A 加进团队共享事项也算完成
  const gB = await kB.inv("guide.progress");
  assert.deepEqual([gB.own_matters, gB.created_matters, gB.shared_matters, gB.latest_matter_id], [1, 0, 1, mid], JSON.stringify(gB));
  const gA = await inv("guide.progress");
  assert.equal(gA.shared_matters, 0, "A 的事项都是自己建的");
  assert.equal(gA.own_matters, gA.created_matters);
  // 非负责人：不能改范围，不能加人
  await assert.rejects(kB.inv("matters.update", { matter_id: mid, patch: { collab_scope: "personal" } }), (e: any) => e.code === "forbidden" && /只有事项负责人/.test(e.message));
  await assert.rejects(kB.inv("matters.members.add", { matter_id: mid, user_id: usr("carol") }), (e: any) => e.code === "forbidden");
  const pB = (await kB.inv("matters.create", { title: "B 的个人事项", stance: "原告", consent_status: "not_required" })).matter;
  await kB.inv("matters.members.add", { matter_id: pB.matter_id, user_id: usr("test-lawyer"), matter_role: "editor" });
  await assert.rejects(kB.inv("matters.members.add", { matter_id: mid, user_id: usr("carol") }), (e: any) => /只有事项负责人能加人或移出同事/.test(e.message) && !JARGON.test(e.message));
  // 负责人：团队 → 个人不允许
  await assert.rejects(inv("matters.update", { matter_id: mid, patch: { collab_scope: "personal" } }), fault("scope_irreversible"));

  // 律师层的报错（补四项第 2 条）：B 升为共同负责人，但同事名单由最先同步它的 A 管理——B 加人 / 移出被拒，说“由谁管理、请他来”
  await inv("matters.members.add", { matter_id: mid, user_id: usr("bob"), matter_role: "owner" });
  await inv("relay.sync");
  await kB.inv("relay.sync");
  const lB2 = await kB.inv("matters.members.list", { matter_id: mid });
  assert.deepEqual([lB2.my_role, lB2.is_owner, lB2.can_manage, lB2.relay_controller], ["owner", true, false, usr("test-lawyer")], JSON.stringify(lB2));
  for (const call2 of [() => kB.inv("matters.members.add", { matter_id: mid, user_id: usr("carol") }), () => kB.inv("matters.members.remove", { matter_id: mid, user_id: usr("test-lawyer") })]) {
    await assert.rejects(call2(), (e: any) => {
      assert.equal(e.code, "forbidden");
      assert.match(e.message, /^这个事项的同事名单由.+管理：请他来加人或移出$/);
      assert.doesNotMatch(e.message, JARGON);
      assert.deepEqual([e.detail?.reason, e.detail?.controller_user_id], ["relay_controller_other", usr("test-lawyer")]);
      assert.equal(typeof e.detail?.controller_name, "string");
      return true;
    });
  }
  // A 负责同步，不能把自己改成一起办 / 只看
  await assert.rejects(inv("matters.members.add", { matter_id: mid, user_id: usr("test-lawyer"), matter_role: "viewer" }), (e: any) => {
    assert.equal(e.code, "forbidden");
    assert.match(e.message, /负责这个事项与同事之间的同步，不能改成只看：请联系管理员/);
    assert.doesNotMatch(e.message, JARGON);
    assert.equal(e.detail?.reason, "relay_controller_role_change");
    return true;
  });
  // 本机确认不了负责人（同步告警）时：一句人话
  kA!.kernel.db.run(`INSERT INTO sync_alerts (matter_id, kind, epoch, detail, first_at, last_at) VALUES (?,?,0,'test',?,?)`, [mid, "owner_unverifiable", new Date().toISOString(), new Date().toISOString()]);
  await assert.rejects(inv("matters.members.add", { matter_id: mid, user_id: usr("carol") }), (e: any) => {
    assert.match(e.message, /暂时确认不了这个事项的负责人是谁，现在不能加人/);
    assert.doesNotMatch(e.message, JARGON);
    assert.equal(e.detail?.reason, "owner_unverifiable");
    return true;
  });
  kA!.kernel.db.run(`DELETE FROM sync_alerts WHERE matter_id = ? AND kind = 'owner_unverifiable'`, [mid]);

  // 负责人移出有结果说明（先把 B 改回一起办，B 同步到“一起办”）
  await inv("matters.members.add", { matter_id: mid, user_id: usr("bob"), matter_role: "editor" });
  await inv("relay.sync");
  await kB.inv("relay.sync");
  assert.equal((await kB.inv("matters.members.list", { matter_id: mid })).my_role, "editor");
  const rm = await inv("matters.members.remove", { matter_id: mid, user_id: usr("bob") });
  assert.match(rm.lawyer_note, /拿不到此后的新内容；已同步到他电脑上的不会被收回/);
  assert.doesNotMatch(rm.lawyer_note, JARGON);
  assert.ok(rm.new_epoch >= 2, "移出即轮换");
  assert.deepEqual((await inv("matters.members.list", { matter_id: mid })).members.map((m: any) => m.user_id), [usr("test-lawyer")]);

  // ── P2-2（真实中继，被移出者这一侧）：B 读不到移出事件（新纪元的段只给在册成员），本机仍以为自己在册 ──
  // B 不知情时加材料（本机写入照常）；A 把新纪元登记到中继（读者整体替换，不含 B）；B 推送被中继拒（不是读者）：记为已被移出、这一段丢弃，不再卡住重试
  await importText(kB.inv, mid, "移出后B写.txt", "B 不知道自己已被移出时写的内容");
  assert.deepEqual((await inv("relay.sync")).push.errors, []);
  const pushB = await kB.inv("relay.sync");
  assert.equal(pushB.pull.applied, 0, "B 收不到移出之后的段");
  assert.ok(pushB.push.errors.includes("removed_from_matter"), JSON.stringify(pushB.push));
  assert.ok(pushB.push.dropped >= 1);
  const stB = await kB.inv("relay.status");
  assert.deepEqual([stB.stuck, stB.removed_matters], [0, 1], JSON.stringify(stB));
  const lR = await kB.inv("matters.members.list", { matter_id: mid });
  assert.deepEqual([lR.removed_me, lR.sync, lR.can_manage], [true, "removed", false], JSON.stringify(lR));
  const gR = (await kB.inv("matters.get", { matter_id: mid })).matter;
  assert.deepEqual([gR.removed_me, gR.can_write], [true, false]);
  assert.ok((await kB.inv("matters.get", { matter_id: mid })).documents.length >= 1, "已有内容留在本机、照常能看");
  await assert.rejects(importText(kB.inv, mid, "再写.txt", "再写"), (e: any) => {
    assert.equal(e.detail?.reason, "removed_from_matter");
    assert.match(e.message, /负责人已把你移出这个事项：之后的改动不会再同步给同事；已有内容留在你的电脑上，只能查看/);
    assert.doesNotMatch(e.message, JARGON);
    return true;
  });
  const again = await kB.inv("relay.sync");
  assert.ok(!again.push.errors.includes("removed_from_matter") && !again.push.errors.includes("relay_matter_conflict"), "不再重试");
  assert.equal((await inv("matters.get", { matter_id: mid })).documents.some((d: any) => d.filename === "移出后B写.txt"), false, "没有写进负责人那边");
  // 不写也能得知：清掉本机记号后，打开事项成员页即向中继核对（本机不是负责人、中继答不是读者）
  kB.kernel.db.run(`DELETE FROM relay_kv WHERE k LIKE 'removed:%'`);
  const lP = await kB.inv("matters.members.list", { matter_id: mid });
  assert.deepEqual([lP.removed_me, lP.sync], [true, "removed"], "核对后同样如实");
  assert.deepEqual(await kB.inv("team.refresh_share_state", { matter_id: mid }), { refreshed: false, sync: "removed" });

  // 补四项第 1 条：律所规则回退（签名的管理员电脑被停用 → 签名人不足门限）不是“所内没开通”——sync 回 unknown
  await inv("devices.revoke", { device_id: `dev_${FIRM}_bob`, reason: "用例：签名人不足" });
  const rs = await inv("relay.status");
  assert.deepEqual([rs.blocked, rs.policy_fallback], ["not_allowed", true], JSON.stringify(rs));
  assert.equal((await inv("matters.members.list", { matter_id: mid })).sync, "unknown");
  const sf = await inv("firm_policy.share_relay_status");
  assert.deepEqual([sf.state, sf.fallback_reason], ["expired", "signers_insufficient"], JSON.stringify(sf));
});

test("实拍补 1：team.refresh_share_state——管理员刚开通，成员电脑不等 10 分钟：没开通 / 不知道时距上次同步超过节流间隔才立即同步（在跑的同步就等它）；节流内、已开通、没配中继都不同步", { timeout: 300_000 }, async () => {
  const F2 = "b73r-firm";
  const c = await startCloudCp({ tenant: `ten_${F2}` });
  const kA2 = await makeKernel({ ...c.env, ZR_MODEL_PROVIDER: "upstream" }, F2);
  const ws = mkdtempSync(join(tmpdir(), "kwl-b73r-bob-"));
  mkdirSync(join(ws, F2, "keys"), { recursive: true });
  copyFileSync(join(kA2.dir, F2, "keys", "firm-root.json"), join(ws, F2, "keys", "firm-root.json"));
  const { createKernel } = await import("../src/index.ts");
  const WINDOW = 4_000;
  const bk = await createKernel({ dataDir: ws, firmSlug: F2, userSlug: "bob", env: { ...process.env, ...c.env, ZR_MODEL_PROVIDER: "upstream", ZR_SHARE_REFRESH_MS: String(WINDOW) } });
  const kB2 = (m: string, p?: any) => bk.invoke(m, p) as Promise<any>;
  const bare = await makeKernel({}, "b73r-bare");
  try {
    for (const inv2 of [kA2.inv, kB2, kA2.inv, kB2]) assert.equal((await inv2("control_plane.sync")).report.ok, true);
    // 没配中继（开发形态）：不同步
    assert.deepEqual(await bare.inv("team.refresh_share_state"), { refreshed: false, sync: "not_configured" });
    // A 起草并签好“开通同事之间同步”（还没发布）；B 此刻同步过一次：所内没开通
    const body = { max_mode: "default", auto_preauthorizations: [], fetch_allowlist_extra: [], l3a_standard_model: "deny", share_relay: "allow" };
    const { draft } = await kA2.inv("firm_policy.create_draft", { kind: "policy", body });
    await kA2.inv("firm_policy.sign", { draft_id: draft.draft_id, expected_digest: draft.digest });
    assert.equal((await kB2("control_plane.sync")).report.ok, true);
    const tB = Date.now();
    assert.deepEqual(await kB2("team.refresh_share_state"), { refreshed: false, sync: "not_allowed" }, "刚同步过：节流内不再同步");
    // A 发布：B 在节流内仍不同步（没开通的律所不会因为界面反复调用而加快轮询）
    await kA2.inv("firm_policy.publish", { draft_id: draft.draft_id });
    await c.feed.refresh();
    const r1 = await kB2("team.refresh_share_state");
    assert.ok(Date.now() - tB < WINDOW, "用例自身：这一步须在节流间隔内");
    assert.deepEqual(r1, { refreshed: false, sync: "not_allowed" });
    assert.equal((await kB2("kernel.status")).egress_gate.share_relay_allowed, false, "B 还不知道");
    // 过了节流间隔：两次并发调用——第一次立即同步，第二次等这次同步（不另起一次），都拿到新状态
    await new Promise((r) => setTimeout(r, Math.max(0, WINDOW + 200 - (Date.now() - tB))));
    const [x, y] = await Promise.all([kB2("team.refresh_share_state"), kB2("team.refresh_share_state")]);
    assert.deepEqual([x, y], [{ refreshed: true, sync: "ok" }, { refreshed: true, sync: "ok" }], JSON.stringify([x, y]));
    assert.equal((await kB2("kernel.status")).egress_gate.share_relay_allowed, true, "B 已知道所内开通了");
    // 已开通：不再同步
    assert.deepEqual(await kB2("team.refresh_share_state"), { refreshed: false, sync: "ok" });
  } finally {
    await bk.close().catch(() => {});
    await kA2.kernel.close().catch(() => {});
    await bare.kernel.close().catch(() => {});
    await c.close();
  }
});

test("P2-1：没有席位的成员——同事之间同步用不了如实报 no_seat（不说“连不上”），relay.status 给出 credential_no_seat", { timeout: 300_000 }, async () => {
  const F3 = "b73s-firm";
  const c = await startCloudCp({ tenant: `ten_${F3}`, seats: 1 });
  const kA3 = await makeKernel({ ...c.env, ZR_MODEL_PROVIDER: "upstream" }, F3);
  const ws = mkdtempSync(join(tmpdir(), "kwl-b73s-bob-"));
  mkdirSync(join(ws, F3, "keys"), { recursive: true });
  copyFileSync(join(kA3.dir, F3, "keys", "firm-root.json"), join(ws, F3, "keys", "firm-root.json"));
  const { createKernel } = await import("../src/index.ts");
  const bk = await createKernel({ dataDir: ws, firmSlug: F3, userSlug: "bob", env: { ...process.env, ...c.env, ZR_MODEL_PROVIDER: "upstream" } });
  const kB3 = (m: string, p?: any) => bk.invoke(m, p) as Promise<any>;
  try {
    assert.equal((await kA3.inv("control_plane.sync")).report.steps.seat, "accepted");
    const sb = await kB3("control_plane.sync");
    assert.equal(sb.report.steps.seat, "no_seat", "1 个席位已被 A 占用");
    assert.equal((await kA3.inv("firm_policy.share_relay_enable")).published, true);
    await c.feed.refresh();
    await kB3("control_plane.sync");
    await kA3.inv("control_plane.sync");
    const mB = (await kB3("matters.create", { title: "没有席位时建的团队事项", stance: "原告", consent_status: "not_required", collab_scope: "team" })).matter;
    const r = await kB3("relay.sync");
    assert.ok(r.push.errors.concat(r.pull.errors).some((e: string) => e.startsWith("credential_")), JSON.stringify(r));
    const st = await kB3("relay.status");
    assert.equal(st.credential_error, "credential_no_seat", JSON.stringify(st));
    assert.equal(st.blocked, null);
    assert.equal((await kB3("matters.members.list", { matter_id: mB.matter_id })).sync, "no_seat", "不是“连不上”");
    assert.equal((await kB3("team.refresh_share_state")).sync, "no_seat");
    // 有席位的 A 照常
    const mA = (await kA3.inv("matters.create", { title: "有席位的团队事项", stance: "原告", consent_status: "not_required", collab_scope: "team" })).matter;
    await kA3.inv("relay.sync");
    assert.equal((await kA3.inv("matters.members.list", { matter_id: mA.matter_id })).sync, "ok");
    // 管理员收回 A 的名额（seat_revoked 系列）：同样说“没有席位”，不说“连不上”
    c.cp.ops.revokeSeat(`ten_${F3}`, `usr_${F3}_test-lawyer`);
    await c.feed.refresh();
    await kA3.inv("control_plane.sync");
    let stA: any = null;
    for (let i = 0; i < 3 && stA?.credential_error !== "credential_seat_revoked"; i++) {
      await importText(kA3.inv, mA.matter_id, `收回后-${i}.txt`, "收回名额之后写的");
      await kA3.inv("relay.sync");
      stA = await kA3.inv("relay.status");
    }
    const seatStep = (await kA3.inv("kernel.status")).control_plane.last_sync?.steps?.seat;
    assert.ok(stA.credential_error === "credential_seat_revoked" || seatStep === "seat_revoked", JSON.stringify({ stA, seatStep }));
    assert.equal((await kA3.inv("matters.members.list", { matter_id: mA.matter_id })).sync, "no_seat");
  } finally {
    await bk.close().catch(() => {});
    await kA3.kernel.close().catch(() => {});
    await c.close();
  }
});

test("P2-3：团队共享事项的客户授权按团队共享的次处理者清单与数据去向记录（同事电脑、中软加密副本）；只有我的事项照旧；只有我转团队须按新范围重新确认", async () => {
  const tk = await makeKernel({}, "b73a-firm");
  const FULL = { engagement: "confirmed", personal_info: "confirmed", sensitive: "not_applicable", subprocessor: "confirmed" };
  const REF = "委托代理合同 第 12 条";
  try {
    // 清单与去向（纯函数口径）
    assert.notEqual(AI_SUBPROCESSORS_TEAM.version, AI_SUBPROCESSORS.version);
    assert.match(AI_SUBPROCESSORS_TEAM.items[0]!.role, /保存加密副本，打不开内容；本机删除事项不会删除中软上的加密副本/);
    assert.deepEqual(dataFlowsFor("personal").map((f) => f.text), ["案卷只存这台电脑"]);
    assert.deepEqual(dataFlowsFor("team", 2).map((f) => f.key), ["colleagues", "zr_relay"]);
    // 团队共享事项：记录时按团队清单版本；授权记录里落下范围与去向
    const team = (await tk.inv("matters.create", { title: "团队授权", stance: "原告", collab_scope: "team", basis: FULL, basis_source: "engagement_terms", basis_ref: REF })).matter;
    assert.deepEqual([team.basis_notice_version, team.basis_state], [AI_SUBPROCESSORS_TEAM.version, "valid"]);
    const gt = (await tk.inv("matters.get", { matter_id: team.matter_id })).matter;
    assert.equal(gt.subprocessors.version, AI_SUBPROCESSORS_TEAM.version);
    assert.deepEqual(gt.data_flows.map((f: any) => f.key), ["colleagues", "zr_relay"]);
    assert.equal(gt.data_flows[0].text, "经加密同步到之后加进来的同事电脑；他们电脑上也会有材料与成果", "还没加同事：不写“0 人”");
    assert.match(dataFlowsFor("team", 2)[0]!.text, /经加密同步到事项成员的电脑（本所同事 2 人）/);
    assert.doesNotMatch(dataFlowsFor("team", null)[0]!.text, /人）/);
    assert.equal(gt.authorization_history[0].scope, "team");
    assert.deepEqual(gt.authorization_history[0].data_flows.map((f: any) => f.key), ["colleagues", "zr_relay"]);
    assert.equal(gt.authorization_history[0].current_version, true);
    const aa = await tk.inv("ai_authorization.get", { matter_id: team.matter_id });
    assert.deepEqual([aa.scope, aa.subprocessors.version], ["team", AI_SUBPROCESSORS_TEAM.version]);
    assert.ok(aa.data_flows.some((f: any) => f.key === "zr_relay"));
    assert.equal((await tk.inv("ai_authorization.get")).subprocessors.version, AI_SUBPROCESSORS.version, "不给事项时照旧");
    const est = await tk.inv("runs.estimate", { matter_id: team.matter_id, scenario: "s1.contract_review", document_version_ids: [] });
    assert.deepEqual(est.data_where.data_flows.map((f: any) => f.key), ["colleagues", "zr_relay"]);
    assert.equal(est.data_where.subprocessors.version, AI_SUBPROCESSORS_TEAM.version);
    // 只有我的事项照旧
    const solo = (await tk.inv("matters.create", { title: "只有我授权", stance: "原告", basis: FULL, basis_source: "engagement_terms", basis_ref: REF })).matter;
    assert.deepEqual([solo.basis_notice_version, solo.basis_state], [AI_SUBPROCESSORS.version, "valid"]);
    const gs = (await tk.inv("matters.get", { matter_id: solo.matter_id })).matter;
    assert.deepEqual(gs.data_flows.map((f: any) => f.text), ["案卷只存这台电脑"]);
    assert.equal(gs.authorization_history[0].scope, "personal");
    // 只有我转为团队共享：原授权没覆盖同事之间同步 → 须按团队共享的清单重新确认（模型推理随之拦下）
    const up = await tk.inv("matters.update", { matter_id: solo.matter_id, patch: { collab_scope: "team" } });
    assert.equal(up.matter.basis_state, "reconfirm");
    const est2 = await tk.inv("runs.estimate", { matter_id: solo.matter_id, scenario: "a1.agent_task", goal: "审一下" });
    assert.equal(est2.data_where.reconfirm, true, JSON.stringify(est2.data_where));
    const re = await tk.inv("matters.update", { matter_id: solo.matter_id, patch: { basis_source: "engagement_terms", basis_ref: REF } });
    assert.deepEqual([re.matter.basis_notice_version, re.matter.basis_state], [AI_SUBPROCESSORS_TEAM.version, "valid"]);
    const hist = (await tk.inv("matters.get", { matter_id: solo.matter_id })).matter.authorization_history;
    assert.deepEqual(hist.map((h: any) => [h.scope, h.current_version]), [
      ["team", true],
      ["personal", false],
    ]);
  } finally {
    await tk.kernel.close().catch(() => {});
  }
});

// ───────────────────────── 三、账号体系（真实控制面 + 同事名单） ─────────────────────────

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
const nextBroadcast = (k: Kernel, type: string) => new Promise<Record<string, unknown>>((resolve) => k.onBroadcast((m) => m.type === type && resolve(m)));
const rosterFiles = (dir: string) => (readdirSync(dir, { recursive: true }) as string[]).filter((f) => String(f).endsWith("team-roster.json")).map((f) => join(dir, String(f)));
const call = (k: Kernel, m: string, p?: unknown) => k.invoke(m, p) as Promise<any>;

async function registerOn(dir: string, email: string, name: string): Promise<Kernel> {
  let k = await boot(dir);
  const ra = nextBroadcast(k, "kernel.restart_for_identity");
  await k.invoke("account.register", { email, password: PW, name });
  await ra;
  await close(k);
  k = await boot(dir);
  assert.equal((await call(k, "control_plane.sync")).report.steps.seat, "accepted");
  return k;
}

test("账号体系：个人空间与未确认电脑不能选团队；同事名单；建事项同时加同事一个事务；离线用缓存名单；开通同步不收紧其它项；续期与到期提醒；同事离开团队", { timeout: 600_000 }, async () => {
  cloud = await startCloudCp({ tenant: "b73seed", accountCa: true });
  const meta = await fetch(`${cloud.base}/v1/meta`).then((r) => r.json() as Promise<any>);
  assert.ok(meta.features.includes("team_roster"), `云端（W1）须有 team_roster：${JSON.stringify(meta.features)}`);

  // ── 乙：个人工作室——不能选团队、名单 personal_workspace；升级为团队、邀请甲 ──
  const dirB = mkdtempSync(join(tmpdir(), "kwl-b73-b-"));
  let kb = await registerOn(dirB, "b-b73@example.cn", "乙律师");
  assert.deepEqual(await call(kb, "team.roster"), { available: false, reason: "personal_workspace", fetched_at: null, members: [] });
  await assert.rejects(call(kb, "matters.create", { title: "个人空间", stance: "原告", consent_status: "not_required", collab_scope: "team" }), fault("team_scope_unavailable", "personal_workspace"));
  assert.equal((await call(kb, "workspace.upgrade", { name: "乙律师事务所" })).ok, true);
  const r0 = await call(kb, "team.roster");
  assert.equal(r0.available, true, JSON.stringify(r0));
  const me0 = r0.members.find((m: any) => m.is_me);
  assert.deepEqual([me0?.name, me0?.status, me0?.can_receive], ["乙律师", "active", true], JSON.stringify(r0.members));
  const inv = await call(kb, "team.invites.create", { name: "甲律师", role: "lawyer" });
  await close(kb);

  // ── 甲：接受邀请 → 团队空间（账号签发钥直接登记）：不能建 / 转团队事项 ──
  const dirA = mkdtempSync(join(tmpdir(), "kwl-b73-a-"));
  let ka = await registerOn(dirA, "a-b73@example.cn", "甲律师");
  const sw = nextBroadcast(ka, "kernel.switch_profile");
  const j = await call(ka, "teams.join", { code: inv.code });
  assert.deepEqual([j.switched, j.enrolling], [true, true], JSON.stringify(j));
  const h1 = (await sw).handoff as ProfileHandoff;
  await close(ka);
  ka = await boot(dirA, { keySlot: "pending", handoff: h1 });
  await nextBroadcast(ka, "kernel.restart_for_identity");
  await close(ka);
  ka = await boot(dirA, { keySlot: "profile" });
  assert.equal((await call(ka, "control_plane.sync")).report.steps.register, "ok");
  const stA = await call(ka, "kernel.status");
  assert.equal(stA.device_issuer, "account_ca");
  const userA = stA.user_id as string;
  // 刚接受邀请换到的新档案还没记下工作空间类型（workspace_kind 为 null）：选团队时内核先取一次本人资料补上，再按证书拒
  await assert.rejects(call(ka, "matters.create", { title: "甲的团队事项", stance: "原告", consent_status: "not_required", collab_scope: "team" }), fault("team_scope_unavailable", "device_not_confirmed"));
  assert.equal((await call(ka, "kernel.status")).workspace_kind, "team", "已补记为团队空间");
  const pa = (await call(ka, "matters.create", { title: "甲的个人事项", stance: "原告", consent_status: "not_required" })).matter;
  await assert.rejects(call(ka, "matters.update", { matter_id: pa.matter_id, patch: { collab_scope: "team" } }), fault("team_scope_unavailable", "device_not_confirmed"));
  const rA = await call(ka, "team.roster");
  assert.equal(rA.available, true);
  assert.deepEqual(
    rA.members.filter((m: any) => m.is_me).map((m: any) => [m.user_id, m.can_receive]),
    [[userA, false]],
    "自己这台还没确认：不能接收",
  );
  await close(ka);

  // ── 乙：名单、建事项同时加同事、名单外的人整体失败 ──
  kb = await boot(dirB);
  assert.equal((await call(kb, "control_plane.sync")).report.steps.register, "ok");
  const r1 = await call(kb, "team.roster");
  const a1 = r1.members.find((m: any) => m.user_id === userA);
  assert.deepEqual([a1?.name, a1?.role, a1?.status, a1?.can_receive, a1?.is_me], ["甲律师", "lawyer", "active", false, false], JSON.stringify(r1.members));
  for (const m of r1.members) assert.deepEqual(Object.keys(m).sort(), ["can_receive", "is_me", "member_slug", "name", "role", "seat", "status", "user_id"], "不含邮箱、手机号、账号编号");
  // P2-1：云端名单带席位（旧云端没有为 null）
  assert.equal(r1.members.find((m: any) => m.is_me)?.seat, true, JSON.stringify(r1.members));
  for (const m of r1.members) assert.ok(m.seat === true || m.seat === false, JSON.stringify(m));
  const files = rosterFiles(dirB);
  assert.equal(files.length, 1, "名单写了本机缓存");
  assert.ok(!readFileSync(files[0]!, "utf8").includes("example.cn"), "缓存里没有邮箱");

  const nBefore = (await call(kb, "matters.list")).matters.length;
  await assert.rejects(
    call(kb, "matters.create", { title: "带了外人", stance: "原告", consent_status: "not_required", collab_scope: "team", members: [{ user_id: userA, matter_role: "editor" }, { user_id: "usr_bogus_x", matter_role: "viewer" }] }),
    fault("member_not_in_team", "not_in_roster"),
  );
  assert.equal((await call(kb, "matters.list")).matters.length, nBefore, "整体失败：没有建出事项");
  await assert.rejects(call(kb, "matters.create", { title: "不上云", stance: "原告", consent_status: "not_required", confidentiality: "strict", collab_scope: "team" }), fault("team_scope_unavailable", "client_no_cloud"));
  const made = await call(kb, "matters.create", { title: "一起办的合同纠纷", stance: "原告", consent_status: "not_required", collab_scope: "team", members: [{ user_id: userA, matter_role: "viewer" }] });
  const mid = made.matter.matter_id as string;
  assert.deepEqual(made.members_added.map((x: any) => [x.user_id, x.name, x.matter_role, x.devices_wrapped, x.can_receive]), [[userA, "甲律师", "viewer", 0, false]]);
  assert.match(made.members_added[0].lawyer_note, /还不能接收：请他在 设置 → 团队 里申请/);
  assert.doesNotMatch(made.members_added[0].lawyer_note, JARGON);
  const l1 = await call(kb, "matters.members.list", { matter_id: mid });
  // 所内真的还没开通（生效规则来自控制面、没有放开同事之间同步）→ not_allowed，不是 unknown
  assert.equal((await call(kb, "relay.status")).policy_fallback, false);
  assert.deepEqual([l1.collab_scope, l1.is_owner, l1.can_manage, l1.sync], ["team", true, true, "not_allowed"], JSON.stringify(l1));
  assert.ok(l1.members.every((m: any) => typeof m.seat === "boolean"), "事项成员同样带席位");
  assert.equal(l1.removed_me, false);
  assert.deepEqual(l1.members.map((m: any) => [m.name, m.matter_role, m.can_receive, m.departed, m.is_me]), [
    ["乙律师", "owner", true, false, true],
    ["甲律师", "viewer", false, false, false],
  ]);
  await assert.rejects(call(kb, "matters.members.add", { matter_id: mid, user_id: "usr_bogus_x" }), fault("member_not_in_team"));
  // 改角色（名单里在用）：真实姓名
  const ch = await call(kb, "matters.members.add", { matter_id: mid, user_id: userA, matter_role: "editor" });
  assert.equal(ch.name, "甲律师");

  // ── 开通同事之间同步：以当前生效规则为底稿，只改这一项（先发布一份带其它放宽项的策略）──
  const base = { ...strictestTemplate(), fetch_allowlist_extra: ["www.court.example.cn"], l3a_standard_model: "allow" };
  const { draft } = await call(kb, "firm_policy.create_draft", { kind: "policy", body: base });
  await call(kb, "firm_policy.sign", { draft_id: draft.draft_id, expected_digest: draft.digest });
  await call(kb, "firm_policy.publish", { draft_id: draft.draft_id });
  const s0 = await call(kb, "firm_policy.share_relay_status");
  assert.deepEqual([s0.state, s0.can_manage, s0.threshold], ["not_allowed", true, 1], JSON.stringify(s0));
  assert.deepEqual(s0.carry_relaxations.enable, ["fetch_allowlist:www.court.example.cn", "l3a_standard_model:allow"]);
  const en = await call(kb, "firm_policy.share_relay_enable");
  assert.deepEqual([en.published, en.state], [true, "allowed"], JSON.stringify(en));
  const body1 = (await call(kb, "kernel.status")).control_plane.policy.body;
  assert.deepEqual(body1, { ...base, share_relay: "allow" }, "其它放宽项原样保留（没被最严缺省静默收紧）");
  assert.equal((await call(kb, "kernel.status")).share_relay_expiring, null);
  // 续期（有效期 5 天）：到期前 7 天提醒
  const rn = await call(kb, "firm_policy.share_relay_renew", { ttl_days: 5 });
  assert.deepEqual([rn.published, rn.state, rn.days_left], [true, "allowed", 5], JSON.stringify(rn));
  const st5 = await call(kb, "kernel.status");
  assert.deepEqual(st5.share_relay_expiring, { days_left: 5 });
  assert.deepEqual(st5.control_plane.policy.body, { ...base, share_relay: "allow" }, "续期原样重签");
  assert.deepEqual((await call(kb, "firm_policy.share_relay_status")).expiring, { days_left: 5 });
  assert.notEqual((await call(kb, "matters.members.list", { matter_id: mid })).sync, "not_allowed", "开通后不再是“所内没开通”");
  await close(kb);

  // ── 离线：用缓存名单；缓存也没有 → roster_unavailable ──
  cloud.setControlPlaneAvailable(false);
  try {
    kb = await boot(dirB);
    const off = await call(kb, "team.roster");
    assert.deepEqual([off.available, off.reason], [false, "offline"], JSON.stringify(off));
    assert.ok(off.members.some((m: any) => m.user_id === userA && m.name === "甲律师"), "离线时给缓存名单");
    const p2 = (await call(kb, "matters.create", { title: "离线建的", stance: "原告", consent_status: "not_required" })).matter;
    const add2 = await call(kb, "matters.members.add", { matter_id: p2.matter_id, user_id: userA });
    assert.equal(add2.name, "甲律师", "离线按缓存名单核对并存真实姓名");
    await assert.rejects(call(kb, "matters.members.add", { matter_id: p2.matter_id, user_id: "usr_bogus_x" }), fault("member_not_in_team"));
    await close(kb);
    for (const f of rosterFiles(dirB)) rmSync(f);
    kb = await boot(dirB);
    await assert.rejects(call(kb, "matters.members.add", { matter_id: p2.matter_id, user_id: userA }), fault("roster_unavailable", "offline"));
    await close(kb);
  } finally {
    cloud.setControlPlaneAvailable(true);
  }

  // ── 甲被移出团队：名单标 removed，事项成员标“已离开团队”，不能再加；负责人移出 ──
  kb = await boot(dirB);
  const tm = await call(kb, "team.members.list");
  const aRow = (tm.members as any[]).find((m) => m.name === "甲律师");
  assert.ok(aRow?.aid, JSON.stringify(tm.members));
  await call(kb, "team.members.remove", { aid: aRow.aid });
  const r2 = await call(kb, "team.roster");
  assert.equal(r2.available, true);
  assert.deepEqual(
    r2.members.filter((m: any) => m.user_id === userA).map((m: any) => [m.status, m.can_receive]),
    [["removed", false]],
  );
  const l2 = await call(kb, "matters.members.list", { matter_id: mid });
  assert.equal(l2.members.find((m: any) => m.user_id === userA)?.departed, true, "已离开团队");
  const p3 = (await call(kb, "matters.create", { title: "再加一次", stance: "原告", consent_status: "not_required", collab_scope: "team" })).matter;
  await assert.rejects(call(kb, "matters.members.add", { matter_id: p3.matter_id, user_id: userA }), fault("member_not_in_team", "removed"));
  const rm = await call(kb, "matters.members.remove", { matter_id: mid, user_id: userA });
  assert.equal(rm.name, "甲律师");
  assert.match(rm.lawyer_note, /已把甲律师移出这个事项/);
  await close(kb);
});
