/**
 * 第 73 批客户端（V47，impl-U：团队共享事项入口；D-307～D-310，契约 02 §3，A5 §6.3 / §7.6）：纯函数 + 只在团队空间出现 + 关键接线 + 本批文案门禁。
 * 真实栈截图（内核 W2 完成后）另见研究目录 impl-U-界面进度.md。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  addResultText,
  avatarOf,
  canManageMembers,
  effectiveKind,
  localOnlyBlocked,
  TEAM_SCOPE_CONFLICT_TEXT,
  teamFaultOf,
  teamFaultText,
  canOfferShare,
  carriedLine,
  dayOnly,
  manageBlockedText,
  memberCounts,
  needsShareRefresh,
  NO_SEAT_TEXT,
  reconfirmReason,
  relaxationText,
  REMOVED_ME_TEXT,
  authzFlowRows,
  shareRelayCloseLines,
  sharedMaterialNote,
  shareRelayRenewLines,
  colleagueMeta,
  createErrorText,
  filterColleagues,
  guideScopeNote,
  isTeamShared,
  levelOfMatter,
  MATTER_ROLE_OPTIONS,
  matterRoleLabel,
  memberErrorText,
  memberName,
  memberRowNote,
  ownerHint,
  PICKER_SEARCH_FROM,
  pickableColleagues,
  RELAY_NOT_ALLOWED_TEXT,
  RELAY_NOT_CONFIGURED_TEXT,
  relayExpiringText,
  relayReady,
  relaySyncOf,
  removeQuestion,
  removeResult,
  rosterNote,
  SCOPE_OPTIONS,
  scopeAvailability,
  scopeHint,
  scopeToSubmit,
  shareMatterLines,
  shareRelayEnableLines,
  shareRelayRow,
  sortMembers,
  syncNotice,
  teamPillText,
  teamPrefix,
  matterMark,
  markPrefix,
  CLOUD_UPGRADE_TEXT,
  colleaguesCount,
  colleaguesPendingText,
  NO_SEAT_CONFIRMED_TEXT,
  OFFLINE_HEAD,
  removeLocalCopyLines,
} from "../src/lib/team-matters.ts";
import { shareReadyText, upgradeLines } from "../src/lib/workspace.ts";
import { searchGroups } from "../src/lib/search.ts";
import { sidebarFoot } from "../src/lib/user-card.ts";
import { credentialNoSeat, relayErrorText, teamShareLine } from "../src/lib/relay-text.ts";
import { checklistItems, matterStepText } from "../src/lib/guide-checklist.ts";
import { authorizationStatus } from "../src/lib/authorization.ts";
import type { MatterMemberRow, ShareRelayStatus, TeamRosterMember } from "../src/api.ts";

const css0 = () => readFileSync(fileURLToPath(new URL("../src/styles-team-matters.css", import.meta.url)), "utf8");
const src = (p: string) => readFileSync(fileURLToPath(new URL(`../src/${p}`, import.meta.url)), "utf8");
const code = (p: string) => src(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const person = (o: Partial<TeamRosterMember>): TeamRosterMember => ({ user_id: "usr_t_a", member_slug: "a", name: "陈律师", role: "lawyer", status: "active", can_receive: true, is_me: false, ...o });
const row = (o: Partial<MatterMemberRow>): MatterMemberRow => ({ user_id: "usr_t_a", name: "陈律师", matter_role: "editor", can_receive: true, departed: false, is_me: false, ...o });

test("谁能看到（D-307）：只在团队空间出现；这台电脑没经团队确认、客户要求不上云、服务不支持名单时置灰并说原因", () => {
  assert.deepEqual(SCOPE_OPTIONS.map((o) => o.label), ["只有我", "团队共享"], "第二轮复评跨页 1：叫法统一为“团队共享”");
  assert.equal(SCOPE_OPTIONS[0]!.hint, "只在你的电脑上；以后可以在事项里加同事。");
  assert.equal(SCOPE_OPTIONS[1]!.hint, "加进来的同事在自己的电脑上也能看到、一起办；内容在你们的电脑之间加密同步。", "设计评分第一轮：律师层不讲服务方");
  // 个人空间、开发形态：一处不出现
  for (const kind of ["personal", null] as const) assert.equal(scopeAvailability({ kind, issuer: "firm_root", level: "normal" }).show, false);
  assert.deepEqual(scopeAvailability({ kind: "team", issuer: "firm_root", level: "normal" }), { show: true, team: true, reason: null, apply: false });
  const acct = scopeAvailability({ kind: "team", issuer: "account_ca", level: "normal" });
  assert.equal(acct.team, false);
  assert.equal(acct.apply, true, "给“去申请 →”");
  assert.equal(acct.reason, "这台电脑还没经管理员确认，不能设为团队共享：申请并确认后就可以。");
  const strict = scopeAvailability({ kind: "team", issuer: "firm_root", level: "strict" });
  assert.equal(strict.team, false);
  assert.equal(strict.apply, false);
  assert.match(strict.reason!, /客户要求不上云的事项只在这台电脑上/);
  // 不上云优先说（与这件事项的选择就近），即使这台电脑也没确认
  assert.match(scopeAvailability({ kind: "team", issuer: "account_ca", level: "strict" }).reason!, /客户要求不上云/);
  // 协调方口径：云端还没有同事名单能力（not_supported，如线上 1.6 / 1.7）——团队共享相关入口照旧不出现（整块不渲染，不置灰、不讲原因）；直接登录的电脑、不上云事项也一样
  for (const issuer of ["firm_root", "account_ca", null] as const)
    for (const level of ["normal", "strict"])
      assert.deepEqual(scopeAvailability({ kind: "team", issuer, level, roster: { reason: "not_supported" } }), { show: false, team: false, reason: null, apply: false }, `${issuer}/${level}`);
  // 联不上云端时仍可选（用缓存名单，或先建好再加）
  assert.equal(scopeAvailability({ kind: "team", issuer: "firm_root", level: "normal", roster: { reason: "offline" } }).team, true);
});

test("谁能看到：说明随同步状态如实写；提交只在团队空间、能选且选了一起办时带范围与同事（缺省“一起办”）", () => {
  assert.equal(scopeHint("personal", false), SCOPE_OPTIONS[0]!.hint, "只有我：不讲同步");
  assert.equal(scopeHint("team", true), SCOPE_OPTIONS[1]!.hint);
  assert.equal(scopeHint("team", null), SCOPE_OPTIONS[1]!.hint, "不知道时不替它说");
  assert.equal(scopeHint("team", false), RELAY_NOT_ALLOWED_TEXT);
  assert.equal(scopeHint("team", false, false), RELAY_NOT_CONFIGURED_TEXT);
  assert.equal(RELAY_NOT_ALLOWED_TEXT, "所内还没开通同事之间同步：加进来的同事要等管理员开通后才收得到。");
  const ok = scopeAvailability({ kind: "team", issuer: "firm_root", level: "normal" });
  assert.deepEqual(scopeToSubmit("personal", ok, ["usr_t_a"]), {}, "只有我：不带同事");
  assert.deepEqual(scopeToSubmit("team", ok, []), { collab_scope: "team", members: [] }, "可留空，建好再加");
  assert.deepEqual(scopeToSubmit("team", ok, ["usr_t_a", "usr_t_b"]), { collab_scope: "team", members: [{ user_id: "usr_t_a", matter_role: "editor" }, { user_id: "usr_t_b", matter_role: "editor" }] });
  // 选了一起办后又改成“客户要求不上云”：回落到只有我，不提交同事
  assert.deepEqual(scopeToSubmit("team", scopeAvailability({ kind: "team", issuer: "firm_root", level: "strict" }), ["usr_t_a"]), {});
  assert.deepEqual(scopeToSubmit("team", scopeAvailability({ kind: "personal", issuer: "firm_root", level: "normal" }), ["usr_t_a"]), {});
});

test("同事之间同步（D-309）：本所规则没允许如实算“没开通”（原映射成不知道）；规则过期回退仍是“不知道”", () => {
  assert.equal(relayReady({ blocked: "not_allowed" }), false);
  assert.equal(relayReady({ blocked: "not_allowed", policy_fallback: false }), false);
  assert.equal(relayReady({ blocked: "not_allowed", policy_fallback: true }), null);
  assert.equal(relayReady({ blocked: "not_configured" }), false);
  assert.equal(relayReady({ blocked: null }), true);
  assert.equal(relayReady({ blocked: "exit_mode" }), null);
  assert.equal(relayReady(null), null);
  assert.equal(relaySyncOf({ blocked: "not_allowed" }), "not_allowed");
  assert.equal(relaySyncOf({ blocked: "not_allowed", policy_fallback: true }), "unknown");
  assert.equal(relaySyncOf({ blocked: "not_configured" }), "not_configured");
  assert.equal(relaySyncOf({ blocked: null }), "ok");
  // 团队页那一行也改成同一说法，不再说“仍可经律所共享文件夹同步”
  assert.equal(teamShareLine({ blocked: "not_allowed" }), "同事之间同步：未开通 · 管理员开通后，团队共享事项才会在同事电脑之间同步");
  // 两处映射都改用同一个函数（原 not_allowed → 不知道 的写法不再出现）
  for (const f of ["components/TeamShare.tsx", "components/MembersAdmin.tsx"]) {
    assert.match(code(f), /relayReady\((st|r)\)/, f);
    assert.doesNotMatch(code(f), /blocked === "not_configured" \? false : \w+\.blocked === null \? true : null/, f);
  }
  // 已确认的电脑 + 所内没开通：成员页那句如实写前提（第 72 批同一口径）
  assert.match(shareReadyText({ kind: "member", confirmed: true, relay: relayReady({ blocked: "not_allowed" }), at: null }), /所内开通同事之间同步后即可收到团队共享事项$/);
});

test("选同事：只列在用的、不是自己、不在事项里的同事；角色与“电脑还不能接收”灰字；超过 8 人出搜索", () => {
  const roster = {
    members: [
      person({ user_id: "u3", name: "赵合伙人", role: "partner" }),
      person({ user_id: "u1", name: "陈律师" }),
      person({ user_id: "u2", name: "李助理", role: "assistant", can_receive: false }),
      person({ user_id: "me", name: "王律师", is_me: true }),
      person({ user_id: "u4", name: "钱律师", status: "left" }),
      person({ user_id: "u5", name: "孙律师", status: "disabled" }),
    ],
  };
  assert.deepEqual(pickableColleagues(roster).map((m) => m.user_id).sort(), ["u1", "u2", "u3"]);
  assert.deepEqual(pickableColleagues(roster, ["u1"]).map((m) => m.user_id).sort(), ["u2", "u3"], "已在事项里的不列");
  assert.deepEqual(pickableColleagues(null), []);
  assert.equal(colleagueMeta(person({ role: "lawyer" })), "律师");
  assert.equal(colleagueMeta(person({ role: "assistant", can_receive: false })), "助理 · 电脑还不能接收 · 确认后自动收到", "设计评分第一轮跨页 9：短句补去向");
  assert.equal(colleagueMeta(person({ role: "weird" as never, can_receive: false })), "电脑还不能接收 · 确认后自动收到");
  assert.equal(PICKER_SEARCH_FROM, 6, "6 人及以上出搜索框");
  assert.deepEqual(filterColleagues(pickableColleagues(roster), "李").map((m) => m.name), ["李助理"]);
  assert.equal(filterColleagues(pickableColleagues(roster), "  ").length, 3);
  assert.equal(avatarOf("陈律师"), "陈");
  assert.equal(avatarOf(""), "同");
  // 名单取不到不是错误：可以先建好
  assert.equal(rosterNote({ available: true, members: [] }), null);
  assert.match(rosterNote({ available: false, reason: "offline", members: [] })!, /可以先建好，联网后在事项里加同事/);
  assert.match(rosterNote({ available: false, reason: "offline", members: [person({})] })!, /上次取到的同事名单/);
  assert.match(rosterNote({ available: false, reason: "unavailable", members: [] })!, /暂时取不到同事名单/);
  assert.equal(rosterNote(null), "正在取同事名单…");
});

test("同事电脑能否接收（A5 §7.3）：与第 72 批 shareReadyText 同源（peer 分支）——列表短句、成员行长句；已可接收不说", () => {
  assert.equal(shareReadyText({ kind: "peer", confirmed: false, relay: null }), "电脑还不能接收 · 确认后自动收到");
  assert.equal(shareReadyText({ kind: "peer", confirmed: false, relay: false, long: true }), "他的电脑还不能接收这个事项：请他在“设置 → 团队”里申请，管理员确认后自动收到。");
  assert.equal(shareReadyText({ kind: "peer", confirmed: true, relay: true }), "");
  // 所内没开通同步不逐行重复（列表上方说一次）
  assert.doesNotMatch(shareReadyText({ kind: "peer", confirmed: false, relay: false, long: true }), /开通同事之间同步/);
  assert.deepEqual(memberRowNote(row({ can_receive: false })), { text: shareReadyText({ kind: "peer", confirmed: false, relay: null, long: true }), tone: "quiet" });
  assert.equal(memberRowNote(row({})), null);
  assert.equal(memberRowNote(row({ is_me: true, can_receive: false })), null);
  // 设计评分第一轮 T10：已离开的行补一句后果
  assert.deepEqual(memberRowNote(row({ departed: true, can_receive: false })), { text: "他已离开团队：建议从事项移出，此后的新内容就不会再给他；他电脑上已有的内容不会被收回。", tone: "off" });
  assert.deepEqual(memberCounts([row({}), row({ departed: true }), row({ is_me: true })]), { active: 2, departed: 1 }, "人数不计已离开的");
});

test("事项成员（D-308）：角色只露负责人 / 一起办 / 只看；负责人在前、已离开团队的在后；不露编号；非负责人表尾写找谁", () => {
  assert.equal(matterRoleLabel("owner"), "负责人");
  assert.equal(matterRoleLabel("editor"), "一起办");
  assert.equal(matterRoleLabel("viewer"), "只看");
  assert.equal(matterRoleLabel(null), "成员");
  assert.deepEqual(MATTER_ROLE_OPTIONS.map((o) => [o.value, o.label]), [["editor", "一起办"], ["viewer", "只看"]], "选择只给两种；负责人转让本批不做");
  const rows = sortMembers([row({ user_id: "x", name: "周律师", departed: true }), row({ user_id: "b", name: "李助理" }), row({ user_id: "me", name: "王律师", is_me: true }), row({ user_id: "o", name: "陈律师", matter_role: "owner" })]);
  assert.deepEqual(rows.map((r) => r.user_id), ["o", "me", "b", "x"]);
  assert.equal(memberName(row({ name: "usr_t_zhou", user_id: "usr_t_zhou" })), "一位同事");
  assert.equal(memberName(row({ name: null })), "一位同事");
  assert.equal(ownerHint([row({ matter_role: "owner", name: "王律师" }), row({})]), "要加人或移出，请找负责人王律师。");
  assert.equal(ownerHint([row({ matter_role: "owner", is_me: true })]), "要加人或移出，请找这个事项的负责人。");
  assert.equal(removeQuestion("陈律师"), "移出陈律师？移出后，他的电脑拿不到这个事项此后的新内容；他电脑上已有的内容不会被收回。");
  assert.equal(removeResult("陈律师"), "已移出陈律师：他的电脑拿不到这个事项此后的新内容。");
});

test("谁能调整成员：内核 can_manage 优先（最先同步它的是另一位负责人、负责人暂时无法确认时不能）；旧内核按负责人且进行中；结案只读", () => {
  const v = (o: object) => ({ is_owner: true, members: [row({ user_id: "o2", name: "李律师", matter_role: "owner" }), row({ user_id: "me", is_me: true, matter_role: "owner" })], ...o });
  assert.equal(canManageMembers(v({}), false), true, "旧内核没有 can_manage：负责人可改");
  assert.equal(canManageMembers(v({ can_manage: false }), false), false);
  assert.equal(canManageMembers(v({ can_manage: true }), true), false, "结案只读");
  assert.equal(canManageMembers({ is_owner: false, can_manage: true }, false), false);
  assert.equal(manageBlockedText(v({ can_manage: true }), false), null);
  assert.equal(manageBlockedText(v({ can_manage: false, relay_controller: "o2" }), false), "这个事项的同事名单由李律师管理：要加人、改角色或移出，请找他。");
  assert.match(manageBlockedText(v({ can_manage: false, relay_controller: null }), false)!, /联网同步一次后再试/);
  assert.equal(manageBlockedText(v({}), true), "事项已结案（只读）：不能再加同事、改角色或移出。");
  assert.equal(manageBlockedText({ is_owner: false, can_manage: false, members: [] }, false), null, "非负责人看表尾“请找负责人”");
});

test("事项成员页上方一句（sync 非 ok 时；不知道不说）；管理员在“所内没开通”时有去开通", () => {
  assert.deepEqual(syncNotice("not_allowed"), { text: RELAY_NOT_ALLOWED_TEXT, enable: true });
  assert.deepEqual(syncNotice("not_configured"), { text: RELAY_NOT_CONFIGURED_TEXT, enable: false });
  assert.equal(syncNotice("unreachable")!.text, "暂时连不上 Kimi Work：改动先留在这台电脑上，连上后自动同步给同事。", "第二轮复评 T14：与名单处同一说法");
  assert.match(syncNotice("pending")!.text, /还在等第一次同步：联网时会自动同步给同事/);
  for (const s of ["ok", "unknown", null, undefined] as const) assert.equal(syncNotice(s), null, String(s));
});

test("加人结果一句（A5 §7.2）：谁下次同步时收到、谁的电脑还要申请、所内没开通时如实说、没加上的单列原因", () => {
  assert.equal(addResultText([{ name: "陈律师", can_receive: true }, { name: "李助理", can_receive: false }], [], "ok"), "已加入陈律师、李助理。陈律师的电脑下次同步时收到；李助理的电脑还不能接收，申请并经管理员确认后自动收到。");
  // 所内没开通：上方一句已说，结果句不重复（实拍发现同一页说两遍）
  assert.equal(addResultText([{ name: "陈律师", can_receive: true }], [], "not_allowed"), "已加入陈律师。");
  assert.equal(addResultText([{ name: "李助理", can_receive: false }], [], "not_configured"), "已加入李助理。李助理的电脑经管理员确认后才收得到。");
  // 第三轮实拍：没有 AI 使用名额的同事单说，不混进“电脑经确认后收到”
  assert.equal(addResultText([{ name: "钱雨桐", can_receive: true, seat: false }], [], "not_allowed"), "已加入钱雨桐。钱雨桐还没有分配到 AI 使用名额，分配后才收得到。");
  assert.equal(addResultText([{ name: "陈律师", can_receive: true, seat: true }, { name: "孙明远", can_receive: false, seat: false }], [], "ok"), "已加入陈律师、孙明远。陈律师的电脑下次同步时收到；孙明远还没有分配到 AI 使用名额，分配后才收得到。");
  assert.equal(addResultText([], [{ name: "赵合伙人", why: "不在团队名单里（可能已离开团队）" }], "ok"), "没有加上：赵合伙人（不在团队名单里（可能已离开团队））。");
  assert.equal(addResultText([], [], "ok"), "");
});

test("个人事项改为一起办（D-307）：负责人、团队空间、进行中才给入口；二次确认三件事，不可改回在最后", () => {
  const m = { collab_scope: "personal", my_role: "owner", lifecycle: "active" };
  assert.equal(canOfferShare("team", m), true);
  assert.equal(canOfferShare("personal", m), false, "个人空间不出现");
  assert.equal(canOfferShare(null, m), false);
  assert.equal(canOfferShare("team", { ...m, my_role: "editor" }), false, "只有负责人");
  assert.equal(canOfferShare("team", { ...m, collab_scope: "team" }), false, "已是团队共享");
  assert.equal(canOfferShare("team", { ...m, lifecycle: "closed" }), false);
  assert.equal(canOfferShare("team", { ...m, is_sample: true }), false);
  const lines = shareMatterLines();
  assert.equal(lines.length, 3);
  assert.match(lines[1]!, /正在等你确认的任务需要重新确认一次/, "matters.update 是策略变更");
  assert.equal(lines[2], "之后不能改回“只有我”：要结束共享，把同事逐个移出，或结案。");
  assert.equal(levelOfMatter({ data_level: "L3b" }), "strict");
  assert.equal(levelOfMatter({ data_level: "L3a" }), "high");
  assert.equal(levelOfMatter({ data_level: "L2" }), "normal");
});

test("错误按内核终版 code + detail.reason 分支（03 第 W2 行 ⑥）：四个契约码 + team_scope_conflict + 开通 / 续期的 validation 原因", () => {
  const err = (code: string, reason?: string, extra: object = {}) => ({ code, message: "内核原句", detail: reason ? { reason, ...extra } : extra });
  // team_scope_unavailable 四种
  assert.match(teamFaultText(err("team_scope_unavailable", "personal_workspace")), /^个人空间里的事项只在你自己的电脑上/);
  assert.match(teamFaultText(err("team_scope_unavailable", "workspace_unknown")), /还没确认当前是团队空间/);
  assert.match(teamFaultText(err("team_scope_unavailable", "device_not_confirmed")), /^这台电脑还没经管理员确认，不能设为团队共享：请在“设置 → 团队”里申请/);
  assert.match(teamFaultText(err("team_scope_unavailable", "client_no_cloud")), /^客户要求不上云的事项不能设为团队共享/);
  for (const r of ["personal_workspace", "workspace_unknown", "device_not_confirmed", "client_no_cloud"]) assert.doesNotMatch(teamFaultText(err("team_scope_unavailable", r)), /中软|和同事一起办/, r);
  assert.equal(teamFaultText(err("team_scope_unavailable", "new_reason")), "内核原句", "认不出的原因用内核原句");
  // 其余
  assert.equal(teamFaultText(err("scope_irreversible", "team_to_personal")), "这个事项已是团队共享，不能改回“只有我”：要结束共享，请移出同事或结案。");
  assert.equal(teamFaultText(err("team_scope_conflict")), TEAM_SCOPE_CONFLICT_TEXT);
  assert.match(teamFaultText(err("roster_unavailable", "offline")), /联网后再试/);
  assert.equal(teamFaultText(err("roster_unavailable", "not_supported")), "同事名单需要中软把云端升级后才能使用。", "与团队页同一说法");
  assert.equal(memberErrorText(err("roster_unavailable", "not_supported")), "同事名单需要中软把云端升级后才能使用");
  assert.match(teamFaultText(err("validation", "relay_not_configured")), /中软还没为本所开通/);
  assert.equal(teamFaultText(err("validation", "not_enabled")), "同事之间同步还没开通：请先开通。");
  assert.deepEqual(teamFaultOf(err("member_not_in_team", "left", { user_id: "usr_t_a" })), { code: "member_not_in_team", reason: "left", userId: "usr_t_a", manager: null, message: "内核原句" });
  // 内核收尾（cdd366a0）：同事名单由别人管理——detail.controller_name 写“由某某管理”；编号不露
  assert.equal(teamFaultText({ code: "forbidden", message: "这个事项的同事名单由李律师管理：请他来加人或移出", detail: { reason: "relay_controller_other", controller_user_id: "usr_t_li", controller_name: "李律师" } }), "这个事项的同事名单由李律师管理：要加人、改角色或移出，请找他。");
  assert.equal(teamFaultText({ code: "forbidden", message: "这个事项的同事名单由usr_t_li管理：请他来加人或移出", detail: { reason: "relay_controller_other", controller_name: "usr_t_li" } }), "这个事项的同事名单由usr_t_li管理：请他来加人或移出", "不认识姓名：用内核原句");
  assert.equal(memberErrorText({ code: "forbidden", message: "李律师负责这个事项与同事之间的同步，不能改成只看：请联系管理员", detail: { reason: "relay_controller_role_change", controller_name: "李律师" } }), "李律师负责这个事项与同事之间的同步，不能改成只看：请联系管理员");
  assert.equal(memberErrorText({ code: "internal", message: "这台电脑还没拿到这个事项的最新内容，暂时不能加人：同步一次后再试", detail: { reason: "own_wrap_missing" } }), "这台电脑还没拿到这个事项的最新内容，暂时不能加人：同步一次后再试", "内核给了律师层原因时不换成泛泛一句");
  // RunSheet“记为客户要求不上云”在团队事项上收到 team_scope_conflict：按 code 显示
  assert.equal(teamFaultText({ code: "team_scope_conflict", message: "这个事项已是团队共享…", detail: { reason: "consent_refused" } }), TEAM_SCOPE_CONFLICT_TEXT);
  // 某位同事没加上：名单类给短语
  assert.equal(memberErrorText(err("member_not_in_team", "not_in_roster")), "不在团队同事名单里");
  assert.equal(memberErrorText(err("member_not_in_team", "disabled")), "已停用");
  assert.equal(memberErrorText(err("member_not_in_team", "removed")), "已被移出团队");
  assert.equal(memberErrorText(err("member_not_in_team", "left")), "已离开团队");
  assert.equal(memberErrorText(err("member_not_in_team")), "不在团队名单里（可能已离开团队）");
  assert.equal(memberErrorText(err("roster_unavailable", "offline")), "暂时取不到同事名单，联网后再试");
  // 兜底：研发用语换掉、讲加密细节的不搬
  const t = memberErrorText({ code: "forbidden", message: "这个事项经中软共享中继同步：加入成员须由中继上的控制成员（王律师）在其电脑上操作，或请对方先把控制成员移交给你" });
  assert.doesNotMatch(t, /中继|控制成员/);
  assert.match(t, /王律师/);
  assert.equal(memberErrorText({ code: "internal", message: "本机缺少当前纪元事项密钥包裹，无法为新成员补包裹" }), "没有完成：请稍后重试；仍不行请联系 Kimi Work 客服");
  assert.equal(memberErrorText({ code: "x", message: "已按当前密钥纪元补包裹" }), "没有完成：请稍后重试；仍不行请联系 Kimi Work 客服");
  // 建事项整体失败、不留建了一半；写出是哪位同事
  assert.equal(createErrorText(err("member_not_in_team", "left", { user_id: "usr_t_a" }), (id) => (id === "usr_t_a" ? "陈律师" : null)), "陈律师已离开团队，事项没有建：请重新选同事后再建。");
  assert.equal(createErrorText(err("member_not_in_team", "not_in_roster")), "选的同事里有人不在团队同事名单里，事项没有建：请重新选同事后再建。");
  assert.match(createErrorText(err("roster_unavailable", "offline")), /事项没有建：可以先选“只有我”建好/);
  assert.match(createErrorText(err("team_scope_unavailable", "device_not_confirmed")), /^这台电脑还没经管理员确认/);
});

test("类型还不知道（刚切到的团队档案 workspace_kind 起初为 null）：按名单推断、入口照常给，由内核判断；这台电脑不知道是否经确认时也交给内核", () => {
  assert.equal(effectiveKind("team", null), "team");
  assert.equal(effectiveKind("personal", { available: true }), "personal");
  assert.equal(effectiveKind(null, { available: true }), "team");
  assert.equal(effectiveKind(null, { available: false, reason: "offline" }), "team");
  assert.equal(effectiveKind(null, { available: false, reason: "personal_workspace" }), "personal");
  assert.equal(effectiveKind(null, { available: false, reason: "not_supported" }), null, "开发形态、试用版仍不出现");
  assert.equal(effectiveKind(null, null), null);
  // 推断出团队后“谁能看到”照常出现；证书类型不知道时不置灰（内核 device_not_confirmed 如实显示）
  assert.deepEqual(scopeAvailability({ kind: effectiveKind(null, { available: true }), issuer: null, level: "normal" }), { show: true, team: true, reason: null, apply: false });
  assert.equal(canOfferShare(effectiveKind(null, { available: true }), { collab_scope: "personal", my_role: "owner", lifecycle: "active" }), true);
  const tm = code("components/TeamMatter.tsx");
  assert.match(tm, /const probe = ws\.ready && ws\.kind === null;\s*const roster = useRoster\(probe\);\s*return \{ ws, kind: effectiveKind\(ws\.kind, probe \? roster : null\) \};/);
  assert.match(code("components/NewMatter.tsx"), /const \{ ws, kind \} = useTeamKind\(\);/);
  assert.match(code("pages/Matter.tsx"), /const \{ ws, kind: teamKind \} = useTeamKind\(\);/);
  // 内核拒的原因如实显示（改范围、开通 / 续期、记为不上云都走同一个说法）
  assert.match(tm, /setErr\(teamFaultText\(e\)\);/);
  assert.match(code("components/ShareRelayRow.tsx"), /setMsg\(\{ text: teamFaultText\(e\), ok: false \}\)/);
});

test("“记为客户要求不上云”在团队共享事项上置灰并说原因（内核 team_scope_conflict 同一说法）", () => {
  assert.equal(localOnlyBlocked({ collab_scope: "personal" }), null);
  // 设计评分第一轮 T3：原因一行（与置灰项同一行），不重复左侧“先只用本机功能”，不讲服务方；完整说法放悬停
  const why = localOnlyBlocked({ collab_scope: "team" })!;
  assert.equal(why.short, "团队共享事项不能选");
  assert.equal(why.long, TEAM_SCOPE_CONFLICT_TEXT);
  assert.match(why.long, /另建一个“只有我”的事项/);
  assert.doesNotMatch(why.long + why.short, /中软|先只用本机功能|和同事一起办/);
  const rs = code("components/RunSheet.tsx");
  assert.match(rs, /const localOnlyWhy = localOnlyBlocked\(matter\);/);
  assert.match(rs, /disabled=\{localOnlyBusy \|\| !!localOnlyWhy\}[^>]*title=\{localOnlyWhy\?\.long\}/);
  assert.match(rs, /<span className="authz-exit-why" id="local-only-why" title=\{localOnlyWhy\.long\}>\s*（\{localOnlyWhy\.short\}）/);
  assert.match(css0(), /\.authz-exits \.btn-link:disabled \{ color: var\(--text-secondary\); opacity: 0\.55; cursor: not-allowed; text-decoration: none; \}/, "与“谁能看到”置灰同一规则");
  assert.match(rs, /setErr\(teamFaultText\(e\)\);/);
});

test("团队共享记号（D-310）：个人空间不出现；胶囊“团队共享 · n 人”；菜单、搜索副标题前缀", () => {
  assert.equal(isTeamShared({ collab_scope: "team" }, "personal"), false);
  assert.equal(isTeamShared({ collab_scope: "team" }, "team"), true);
  assert.equal(isTeamShared({ collab_scope: "personal" }, "team"), false);
  assert.equal(isTeamShared(null, "team"), false);
  assert.deepEqual(teamPillText(3), { label: "团队共享 · 3 人", aria: "团队共享，3 位事项成员，展开查看" });
  assert.equal(teamPillText(null).label, "团队共享");
  assert.equal(teamPrefix("客户甲 / 乙公司", true), "团队共享 · 客户甲 / 乙公司");
  assert.equal(teamPrefix("", true), "团队共享");
  assert.equal(teamPrefix("客户甲", false), "客户甲");
  const g = searchGroups({ matters: [{ matter_id: "m1", title: "甲", sub: "客户甲" }, { matter_id: "m2", title: "乙", sub: "客户乙" }], runs: [], deliverables: [] }, Date.now(), new Set(["m2"]));
  assert.deepEqual(g[0]!.items.map((i) => i.sub), ["客户甲", "团队共享 · 客户乙"]);
  assert.equal(searchGroups({ matters: [{ matter_id: "m1", title: "甲", sub: "客户甲" }], runs: [], deliverables: [] })[0]!.items[0]!.sub, "客户甲", "不传团队编号时不变");
});

test("开通同事之间同步（D-309）：三态 + 待确认 + 过期；到期前 7 天才给续期；律所版写明还需另一位管理员；合伙人只读", () => {
  const base: ShareRelayStatus = { relay_configured: true, state: "not_allowed", expires_at: null, days_left: null, can_manage: true, threshold: 1, signatures: 0 };
  const now = Date.parse("2026-11-27T04:00:00Z");
  assert.equal(shareRelayRow(null).state, "unknown");
  const cfg = shareRelayRow({ ...base, relay_configured: false });
  assert.equal(cfg.state, "configure");
  assert.deepEqual(cfg.actions, [], "需中软开通：不给按钮（点了也没用）");
  assert.match(cfg.text, /^未开通 · 需要中软为本所开通/);
  // 设计评分第一轮 T8：状态行只说一次——“● 未开通 [开通…]”
  const off = shareRelayRow(base);
  assert.equal(off.text, "未开通");
  assert.deepEqual(off.actions, [{ kind: "enable", label: "开通…", primary: false }]);
  assert.deepEqual(shareRelayRow({ ...base, threshold: 2 }).actions[0], { kind: "enable", label: "发起开通…", primary: false });
  assert.deepEqual(shareRelayRow({ ...base, can_manage: false }).actions, [], "合伙人等只读");
  // “● 已开通 · 12 月 20 日前有效 [续期…] [关闭…]”
  const on = shareRelayRow({ ...base, state: "allowed", expires_at: "2026-12-20T04:00:00Z", days_left: 23 }, now);
  assert.equal(on.text, "已开通 · 12 月 20 日前有效");
  assert.deepEqual(on.actions.map((a) => [a.kind, a.label, a.primary]), [["renew", "续期…", false], ["close", "关闭…", false]]);
  // 到期前 7 天：“续期…”提为主按钮
  const soon = shareRelayRow({ ...base, state: "allowed", expires_at: "2026-12-01T04:00:00Z", days_left: 4 }, now);
  assert.equal(soon.state, "expiring");
  assert.equal(soon.warn, true);
  assert.equal(soon.text, "已开通 · 12 月 1 日前有效 · 还有 4 天");
  assert.deepEqual(soon.actions.map((a) => [a.kind, a.primary]), [["renew", true], ["close", false]]);
  const exp = shareRelayRow({ ...base, state: "expired" });
  assert.deepEqual(exp.actions, [{ kind: "renew", label: "续期…", primary: true }]);
  assert.equal(exp.text, "已过期 · 同事之间同步已暂停");
  const pend = shareRelayRow({ ...base, state: "pending_second_signature", threshold: 2, signatures: 1 });
  assert.equal(pend.text, "已发起开通 · 还需 1 位管理员在自己的电脑上确认");
  assert.deepEqual(pend.actions, [{ kind: "review", label: "去确认 ↓", primary: false }]);
  assert.equal(dayOnly("2027-01-05T04:00:00Z", now), "2027 年 1 月 5 日", "跨年写年份");
  // 开通确认框：服务方名字只出现一次；底栏有分隔线；行尾不留孤字（text-wrap: pretty）
  assert.equal(shareRelayEnableLines(1).length, 4);
  assert.equal((shareRelayEnableLines(1).join("").match(/中软/g) ?? []).length, 1);
  assert.match(shareRelayEnableLines(2).join(""), /还需另一位管理员在自己的电脑上确认才生效/);
  assert.match(shareRelayEnableLines(1).join(""), /只改这一项，本所规则的其他各项不变/, "以当前生效规则为底稿");
  assert.match(css0(), /\.acd-lines li, \.relay-lines li \{ text-wrap: pretty; \}/);
  // 关闭：内核没有单独方法——确认框写清后果（再开通要联系中软），再打开起草表单并预置“不允许同事之间同步”
  assert.match(shareRelayCloseLines().join(""), /关闭后要再开通，需要联系中软/);
  const rr0 = code("components/ShareRelayRow.tsx");
  assert.match(rr0, /<div className="modal-actions modal-actions-sticky">/);
  assert.match(rr0, /window\.dispatchEvent\(new CustomEvent\(POLICY_DRAFT_PRESET, \{ detail: \{ share_relay: false \} \}\)\)/);
  const conn = code("pages/Connections.tsx");
  assert.match(conn, /window\.addEventListener\(POLICY_DRAFT_PRESET, on\);/);
  assert.match(conn, /setRelay\(false\);\s*setPreset\(true\);/);
  // 结果是一次性轻提示（成功几秒后消失），不再常驻一句绿色正文；“生效策略”在同一到期日已写在上面时只写版本
  assert.match(rr0, /if \(!msg\?\.ok\) return;\s*const t = setTimeout\(\(\) => setMsg\(null\), 4000\);/);
  assert.match(rr0, /className=\{msg\.ok \? "lite-toast" : "activate-error relay-err"\}/);
  assert.match(conn, /if \(omitExpiry\) return `本所规则第 \$\{p\.version\} 版（\$\{who\}）`;/);
  assert.match(conn, /<PolicyTab key=\{policyKey\} relayRowAbove \/>/);
  // 律所版第二位管理员：别人发起、我还没确认 → 在这一行确认同一份；我发起的 → 只等
  const second = shareRelayRow({ ...base, state: "pending_second_signature", threshold: 2, signatures: 1, pending: { draft_id: "d1", kind: "enable", digest: "x", signatures: 1, signed_by_me: false } });
  assert.equal(second.text, "另一位管理员已发起开通 · 还需你确认");
  assert.deepEqual(second.actions, [{ kind: "enable", label: "确认开通…", primary: true }]);
  const mine = shareRelayRow({ ...base, state: "pending_second_signature", threshold: 2, signatures: 1, pending: { draft_id: "d1", kind: "renew", digest: "x", signatures: 1, signed_by_me: true } });
  assert.equal(mine.text, "已发起续期 · 还需 1 位管理员在自己的电脑上确认");
  assert.deepEqual(mine.actions, []);
  const secondRenew = shareRelayRow({ ...base, state: "pending_second_signature", threshold: 2, signatures: 1, pending: { draft_id: "d2", kind: "renew", digest: "x", signatures: 1, signed_by_me: false } });
  assert.deepEqual(secondRenew.actions, [{ kind: "renew", label: "确认续期…", primary: true }], "调同一个 renew 签同一份");
  assert.doesNotMatch(shareRelayEnableLines(2, true).join(""), /还需另一位管理员/, "第二位确认即生效，不再说还需另一位");
  assert.match(shareRelayRenewLines(1).join(""), /规则内容不变/);
  // 所见即所签：一并确认的其它放宽项逐条写出（同事之间同步本身不重复）
  assert.equal(carriedLine(["l3a_standard_model:allow", "max_mode:auto", "share_relay:allow"]), "这次确认的规则里同时仍允许：敏感事项可以用通用 AI 服务（全部化名）；AI 最高档位放宽到“放手做”。");
  assert.equal(carriedLine(["support_upload:allow"], "renew"), "续期后仍允许：律师可以把问题报告直接发给客服（每次确认；保存 7 天）。");
  assert.equal(carriedLine(["support_upload:allow"], "restore"), "续期会一并恢复这些放宽项：律师可以把问题报告直接发给客服（每次确认；保存 7 天）。", "已过期续期写明一并恢复的");
  assert.match(shareRelayRenewLines(1, false, true)[0]!, /按过期前最后一份本所规则原样恢复/);
  const rr = code("components/ShareRelayRow.tsx");
  assert.match(rr, /carriedLine\(s\?\.carry_relaxations\?\.renew, expired \? "restore" : "renew"\)/);
  assert.equal(carriedLine([]), null);
  assert.equal(carriedLine(null), null);
  assert.equal(relaxationText("support_upload:allow"), "律师可以把问题报告直接发给客服（每次确认；保存 7 天）");
  assert.match(code("pages/Connections.tsx"), /import \{ relaxationText as relaxationLabel \} from "\.\.\/lib\/team-matters\.ts";/, "设置页与确认框同一套说法");
  assert.equal(relayExpiringText(8), null);
  assert.equal(relayExpiringText(7), "同事之间同步 7 天后到期");
  assert.equal(relayExpiringText(0), "同事之间同步今天到期");
  assert.equal(relayExpiringText(null), null);
  // 侧栏：管理员电脑在到期前 7 天提醒，排在入组申请之后
  const ok = { gate: true, unresolved: 0, execOk: true, pendingJoins: 0 };
  assert.deepEqual(sidebarFoot({ ...ok, relayExpiring: 3 }), { title: "同事之间同步 3 天后到期", note: "到“设置 → 团队”续期", tone: "dot-warn", href: "/connections/team" });
  assert.equal(sidebarFoot({ ...ok, relayExpiring: 3, pendingJoins: 1 }).title, "有 1 台电脑等你确认");
  assert.equal(sidebarFoot({ ...ok, relayExpiring: null }).tone, "dot-ok");
});

test("用语（A5 §6.3）：升级确认第 2 条改说怎么做；上手清单按事项范围如实说", () => {
  assert.equal(upgradeLines("某所")[1], "你原有的事项仍只属于你，同事看不到；要和同事共享，在那件事项里点“⋯ → 改为团队共享…”。");
  assert.equal(guideScopeNote(), "“只有我”的事项只在你的电脑上；“团队共享”的也在加进来的同事电脑上。团队管理员都看不到内容。");
  const g = code("components/GuideChecklist.tsx");
  assert.match(g, /<p className="guide-checklist-note">\{guideScopeNote\(\)\}<\/p>/);
  assert.doesNotMatch(g, /事项内容只在你的电脑上，团队管理员看不到内容/);
});

test("本批文案门禁：律师层不讲密钥、纪元、包裹、中继、证书、控制成员；不用“私有 / 已共享 / 权限 / 编辑者”这类说法", () => {
  // 全库律师层禁词（lawyer-copy）暂不加“密钥”：会误伤现有两处（MatterLifecycle “加密钥匙（已销毁）”是“加密 + 钥匙”的误判；Activate 恢复失败的一句），
  // 这里先把本批新文件纳入门禁（进度文件记明）
  const visible = (s: string) =>
    [...s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1").matchAll(/"(?:[^"\\\n]|\\.)*"|`(?:[^`\\\n]|\\.)*`|>([^<>{}]*[一-鿿][^<>{}]*)</g)].map((m) => m[0]).filter((t) => /[一-鿿]/.test(t));
  for (const f of ["components/TeamMatter.tsx", "components/ShareRelayRow.tsx", "lib/team-matters.ts"]) {
    const hits = visible(src(f)).filter((t) => /密钥|纪元|包裹|中继|证书|控制成员|律所根|签发钥|account_ca|firm_root|席位|私有|仅本人可见|已共享|权限|编辑者|查看者|协作：/.test(t) && !/^"(firm_root|account_ca)"$/.test(t));
    assert.deepEqual(hits, [], f);
  }
  // 反向对照：门禁本身会拦
  assert.equal(visible('const a = "已轮换事项密钥";').length, 1);
});

test("接线：两处新建表单都有“谁能看到”（完整弹窗在“怎么处理”之后、“更多设置”之前，不折叠）；“更多设置”带上选择；弹窗按钮吊底", () => {
  const nm = code("components/NewMatter.tsx");
  const i = nm.indexOf('aria-label="怎么处理"');
  const j = nm.indexOf('<ScopeField variant="modal"');
  const k = nm.indexOf("更多设置（事件时点");
  assert.ok(i > 0 && j > i && k > j, "顺序：怎么处理 → 谁能看到 → 更多设置");
  assert.match(nm, /\.\.\.sc\.submit,/, "一个事务里建事项、加人（matters.create 带 collab_scope 与 members）");
  assert.match(nm, /<div className="modal-actions modal-actions-sticky nm-actions">\s*\{err && <div className="banner banner-red" role="alert">\{err\}<\/div>\}/);
  assert.match(css0(), /\.modal:has\(\.nm-actions\) > \.modal-head \{ position: sticky; top: 0;/, "实拍：滚动时标题栏留在顶上");
  assert.match(nm, /initial\?: \{ title\?: string; stance\?: string; confidentiality\?: string; scope\?: CollabScope; members\?: string\[\] \}/);
  const mp = code("components/MatterPlace.tsx");
  assert.match(mp, /<ScopeField variant="place" scope=\{sc\.scope\}/);
  assert.match(mp, /onMore\(\{ title, stance, confidentiality: level, scope: sc\.scope, members: sc\.picked \}\)/);
  assert.match(mp, /markPrefix\(\[m\.client_name, m\.counterparty\]\.filter\(Boolean\)\.join\(" \/ "\) \|\| `我方：\$\{stanceLabel\(m\.stance\)\}`, matterMark\(m, kind\)\)/);
  assert.match(mp, /\{m\.title\}<MatterMarkBadge mark=\{matterMark\(m, kind\)\} \/><\/span>/);
  // 个人空间：ScopeField 不渲染（show = false 时返回 null）
  const tm = code("components/TeamMatter.tsx");
  assert.match(tm, /if \(!avail\.show\) return null;/);
  assert.match(tm, /onClick=\{\(\) => nav\("\/connections\/team"\)\}>\s*去申请 →/);
  // 选同事最多 6 行高、内滚；置灰的分段有样式；记号走 currentColor（不写死色值）
  const css = src("styles-team-matters.css");
  assert.match(css, /\.cp-rows \{[^}]*max-height: calc\(6 \* 44px\); overflow-y: auto; \}/);
  assert.match(css, /\.scope-field \.seg-btn:disabled \{/);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, "颜色全部取令牌");
});

test("接线：事项页胶囊、常驻“事项成员”标签、“⋯ → 和同事一起办…”；成员页负责人才能加 / 改 / 移出，移出原位两步；已离开的人只留“从事项移出”", () => {
  const mh = code("components/MatterHeader.tsx");
  assert.match(mh, /\{team && onMembers && <TeamPill view=\{team\.view\} failed=\{!!team\.error\} onMembers=\{onMembers\} \/>\}/);
  const mt = code("pages/Matter.tsx");
  assert.match(mt, /team=\{teamShared && !removedMe \? \{ view: members, error: membersErr \} : null\}/);
  // 设计评分第一轮 T5 / 跨页 10：团队共享事项“事项成员”常驻为标签，“⋯”里不再重复
  assert.match(mt, /\.\.\.\(teamShared && !removedMe \? \(\[\["members", "事项成员"\]\] as \[Tab, string\]\[\]\) : \[\]\),/);
  assert.doesNotMatch(mt, /<span className="menu-label">事项成员<\/span>/);
  assert.doesNotMatch(mt, /members: "事项成员"/);
  assert.match(mt, /<AddColleaguesDialog\s+mode="share"/);
  // 材料区说明：团队共享事项写明也会同步给加进来的同事
  assert.match(mt, /sharedNote=\{sharedMaterialNote\(teamShared\)\}/);
  assert.equal(sharedMaterialNote(true), "也会加密同步到加进来的同事电脑上");
  assert.equal(sharedMaterialNote(false), null);
  assert.match(code("components/MaterialPicker.tsx"), /加密保存一份副本\{p\.sharedNote \? `，\$\{p\.sharedNote\}` : ""\}，原文件不改动/);
  assert.match(code("components/MaterialFolderBar.tsx"), /\{p\.sharedNote \? `这个事项的材料\$\{p\.sharedNote\}。` : ""\}/);
  const tm = code("components/TeamMatter.tsx");
  assert.match(tm, /const manage = canManageMembers\(view, closed\);/);
  assert.match(tm, /const editable = manage && !m\.is_me && !m\.departed && /, "实拍：已离开团队的人不给改角色，只留移出");
  assert.match(tm, /\{note && \(\s*<p className="mm-sub">\s*\{note\.text\}/, "实拍：长句放在名字下面整行；已离开的人同样一句后果");
  // 设计评分第一轮 T10：人数只数在团队里的；已离开的角色列写“已离开团队”、按钮写“从事项移出”；浮层角色列写“已离开”并另计人数
  assert.match(tm, /事项成员 <span className="team-count">\{counts\.active\}<\/span>/);
  assert.match(tm, /\{m\.departed \? "已离开团队" : matterRoleLabel\(m\.matter_role\)\}/);
  assert.match(tm, /\{m\.departed \? "从事项移出" : "移出"\}/);
  assert.match(tm, /const t = teamPillText\(view \? counts\.active : null\);/);
  assert.match(tm, /\{m\.departed \? "已离开" : matterRoleLabel\(m\.matter_role\)\}/);
  assert.match(tm, /另有 \{counts\.departed\} 人已离开团队/);
  // 行尾“移出”是灰色文字按钮（悬停变红）
  assert.match(tm, /<button type="button" className="mm-remove"/);
  assert.match(css0(), /\.mm-remove:hover:not\(:disabled\) \{ color: var\(--status-danger-text\); background: var\(--status-danger-bg\); \}/);
  assert.match(tm, /\{manage && \(\s*<button type="button" className="btn-ghost btn-sm mm-add"/);
  assert.match(tm, /const removable = manage && !m\.is_me && m\.matter_role !== "owner";/, "负责人行不给移出");
  assert.match(tm, /role="alertdialog"[\s\S]{0,200}removeQuestion\(name\)/, "原位两步：后果写在行内");
  assert.match(tm, /className="btn-danger-solid btn-sm"/);
  assert.match(tm, /\{!owner && <p className="mm-foot">\{ownerHint\(rows\)\}<\/p>\}/);
  assert.match(tm, /notice\.enable && canEnable/, "只有管理员有“去开通 →”");
  assert.match(tm, /matterMembers\.setRole\(/);
  assert.match(tm, /if \(mode === "share"\) await api\.updateMatter\(matter\.matter_id, \{ collab_scope: "team" \}\);/);
  // “加入（n）”在 n = 0 时禁用（深色禁用主按钮用全局同一修法）
  assert.match(tm, /disabled=\{busy \|\| \(mode === "add" && n === 0\)/);
  // 设计评分第一轮 T2：没人可加时整块换成一句话 +“知道了”；三个入口同一个选同事组件、都不再单独选角色（加进来一律一起办）
  assert.match(tm, /const nobody = mode === "add" && !!roster && rosterNote\(roster\) === null && all\.length === 0;/);
  assert.match(tm, /\{nobody \? \(\s*<p className="acd-empty">/);
  assert.match(tm, /<ColleaguePicker variant="dialog" roster=\{roster\}/);
  assert.match(tm, /<ColleaguePicker variant="inline" roster=\{roster\}/);
  assert.doesNotMatch(tm, /加入后是/);
  assert.match(tm, /matterMembers\.add\(matter\.matter_id, id, "editor"\)/);
  assert.match(tm, /加进来的同事默认是“一起办”；要只给看，加进来后在事项成员里改。/);
  // 选同事展开时不再同时显示已选胶囊；“收起 / 选同事”是文字链；复选框用产品样式
  assert.match(tm, /\{variant === "inline" && !open && \(\s*<div className="cp-chips">/);
  assert.match(tm, /<span className="cp-count">已选 \{chosen\.length\} 人<\/span>/);
  assert.match(tm, /className="btn-link cp-toggle"/);
  assert.match(tm, /<input type="checkbox" className="kw-check"/);
  assert.match(css0(), /\.kw-check \{ appearance: none;/);
  // 精简表单：切换“谁能看到”时上沿与左缘不动、只向下长
  const mp = code("components/MatterPlace.tsx");
  assert.match(mp, /if \(lk && lk\.key === lockKey\) \{\s*top = lk\.top;\s*left = lk\.left;\s*\} else locked\.current = \{ key: lockKey, top, left \};/);
  assert.match(mp, /maxHeight: Math\.max\(240, vh - top - m\)/);
  assert.match(mp, /usePlacement\(anchor, \[creating, !!err, sc\.scope, sc\.picked\.length, sc\.avail\.show\], creating\)/);
});

test("接线：侧栏事项行改 flex、长标题不挤掉尾部记号；事项列表可见标签替代悬停；输入框芯片与搜索带记号；个人空间不出现", () => {
  const sb = code("components/Sidebar.tsx");
  assert.match(sb, /className=\{`sidebar-link sidebar-link-row\$\{activeMatter === m\.matter_id \? " active" : ""\}`\}/);
  assert.match(sb, /<span className="sidebar-link-text">\{m\.title\}<\/span>\s*<MatterMarkBadge mark=\{matterMark\(m, ws\.kind\)\} \/>/);
  assert.match(sb, /relayExpiring \}\);/);
  const css = src("styles-team-matters.css");
  assert.match(css, /\.sidebar-link\.sidebar-link-row \{ display: flex; align-items: center; \}/);
  assert.match(css, /\.sidebar-link-row \.sidebar-link-text \{ flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/);
  const tmk = code("components/TeamMatter.tsx");
  assert.match(tmk, /<span className="sr-only">团队共享<\/span>/, "读屏文字，不靠悬停");
  const ml = code("pages/Matters.tsx");
  assert.match(ml, /matterMark\(m, kind\) === "shared" && \(\s*<span className="tag tag-gray tag-team">/);
  assert.match(ml, /\{matterMark\(m, kind\) === "removed" && <RemovedTag \/>\}/);
  assert.doesNotMatch(ml, /协作：/, "悬停串里不再重复");
  const c = code("components/Composer.tsx");
  assert.match(c, /<MatterMarkBadge mark=\{matterMark\(matter, wsKind\)\} \/> <Icon\.down \/>/);
  assert.match(c, /markPrefix\(\[m\.client_name, m\.counterparty\]\.filter\(Boolean\)\.join\(" \/ "\) \|\| stanceLabel\(m\.stance\), matterMark\(m, wsKind\)\)/);
  const sp = code("components/SearchPalette.tsx");
  assert.match(sp, /searchGroups\(res, Date\.now\(\), marks\)/);
  assert.match(sp, /const mk = matterMark\(m, kind\);\s*if \(mk\) next\.set\(m\.matter_id, mk\);/);
  assert.match(sp, /if \(kind === "personal"\) return;/);
});

test("接线：设置 → 团队 → 团队策略首行“同事之间同步”；到期提醒；起草表单以当前生效规则为底稿；团队共享处管理员可去开通", () => {
  const c = code("pages/Connections.tsx");
  const team = c.slice(c.indexOf("function TeamTab("), c.indexOf("function BackupTab("));
  assert.match(team, /\{f\.adminTab && <ShareRelayExpiring \/>\}/);
  assert.match(team, /<h2 className="h-section team-sec-title" id="sec-policy">团队策略<\/h2>\s*<div className="panel device-section">\s*(\{\}\s*)?<ShareRelayRow \/>/);
  assert.match(c, /id="sec-policy-drafts">待确认的规则草稿/);
  assert.match(c, /base=\{pol\?\.source === "control_plane" \? pol\.body : null\}/);
  assert.match(c, /useState<string>\(base\?\.max_mode \?\? "default"\)/);
  assert.match(c, /useState\(base\?\.share_relay === "allow"\)/);
  const rr = code("components/ShareRelayRow.tsx");
  assert.match(rr, /teamMatters\.shareRelayEnable\(\)/);
  assert.match(rr, /teamMatters\.shareRelayRenew\(\)/);
  assert.match(rr, /if \(s === null && roster\?\.reason !== "not_supported"\) return null;/, "旧内核没有这个方法时整行不出现（云端要升级时仍如实说）");
  const ts = code("components/TeamShare.tsx");
  assert.match(ts, /canEnable && st\?\.blocked === "not_allowed" && !st\.policy_fallback/);
  assert.match(ts, /\{!\(relay === false && noteLine\) && !\(noSeat && confirmedHere\) && <span>\{teamShareLine\(st\)\}<\/span>\}/, "同一页不重复“所内没开通”“没有名额”");
});

test("实拍补（内核 team.refresh_share_state）：提示可见时各问一次、不轮询——团队页打开、事项成员页（带 matter_id）、表单里“所内还没开通”那句；只在没开通 / 不知道时问", () => {
  for (const s of ["not_allowed", "unknown"] as const) assert.equal(needsShareRefresh(s), true, s);
  for (const s of ["ok", "pending", "unreachable", "not_configured", null, undefined] as const) assert.equal(needsShareRefresh(s), false, String(s));
  // 团队页：挂载时一次（在 15 秒轮询之外），放开了就立即重读
  const ts = code("components/TeamShare.tsx");
  assert.match(ts, /const t = setInterval\(load, 15_000\);\s*void teamMatters\.refreshShareState\(\)\.then\(\(r\) => r\?\.refreshed && load\(\)\);/);
  assert.doesNotMatch(ts, /setInterval\([^)]*refreshShareState/, "不轮询");
  // 事项成员页：带 matter_id，每次打开这个事项至多一次，拿到的 sync 直接换掉那句
  const mt = code("pages/Matter.tsx");
  assert.match(mt, /if \(tab !== "members" \|\| !members \|\| members\.matter_id !== matterId \|\| shareAsked\.current === matterId \|\| !needsShareRefresh\(members\.sync\)\) return;/);
  assert.match(mt, /teamMatters\.refreshShareState\(matterId\)\.then\(\(r\) => \{\s*if \(r && r\.sync !== members\.sync\) setMembers/);
  // 表单 / “和同事一起办…”：读到状态之后、每个表单至多一次
  const tm = code("components/TeamMatter.tsx");
  assert.match(tm, /if \(asked\.current \|\| !st\.loaded \|\| !needsShareRefresh\(st\.sync\)\) return;\s*asked\.current = true;\s*void teamMatters\.refreshShareState\(\)\.then\(\(r\) => r\?\.refreshed && read\(\)\);/);
  assert.match(tm, /if \(teamShown && relay\.ready !== true\) relay\.refresh\?\.\(\);/);
  assert.match(tm, /if \(mode === "share" && relay\.ready === false\) relay\.refresh\(\);/);
  for (const f of ["components/TeamMatter.tsx", "pages/Matter.tsx", "components/TeamShare.tsx"]) assert.equal((code(f).match(/refreshShareState\(/g) ?? []).length, 1, `${f} 只有一处调用`);
});

test("实拍补（内核 guide.progress 口径变了）：上手清单第 1 步只是被同事加进来时写“已有事项”，不写“建事项”", () => {
  const base = { materials: 0, runs: 0, deliverables: 0, latest_matter_id: null, latest_run: null };
  const shared = checklistItems({ ...base, own_matters: 2, created_matters: 0, shared_matters: 2 })[0]!;
  assert.deepEqual([shared.title, shared.done], ["已有事项", true]);
  assert.equal(shared.body, "同事把你加进了 2 个事项；自己的事项也可以随时新建");
  const mine = checklistItems({ ...base, own_matters: 3, created_matters: 1, shared_matters: 2 })[0]!;
  assert.deepEqual([mine.title, mine.done], ["建事项", true], "自己建过：照旧");
  assert.deepEqual([checklistItems({ ...base, own_matters: 0, created_matters: 0, shared_matters: 0 })[0]!.title, checklistItems({ ...base, own_matters: 0 })[0]!.done], ["建事项", false]);
  assert.deepEqual(matterStepText({ own_matters: 2 }), {}, "旧内核没有 created / shared：照旧");
});

test("端到端验收 P3-2～P3-4：已申请等确认不再给“去申请 →”；“只看”成员的事项页收起写入口并说明；团队空间上手清单第 2 卡按事项范围如实说", () => {
  const applied = scopeAvailability({ kind: "team", issuer: "account_ca", level: "normal", applied: true });
  assert.deepEqual([applied.team, applied.apply, applied.reason], [false, false, "这台电脑已申请，等管理员确认后就能设为团队共享。"]);
  assert.equal(scopeAvailability({ kind: "team", issuer: "account_ca", level: "normal", applied: false }).apply, true);
  const tm = code("components/TeamMatter.tsx");
  assert.match(tm, /setApplied\(s\.supported === true && s\.state === "pending"\)/);
  assert.match(code("components/NewMatter.tsx"), /const applied = useDeviceShareApplied\(team && ws\.issuer === "account_ca"\);/);
  // 只看：内核 can_write（旧内核按 my_role）；发起任务、加材料、关联案卷文件夹、材料用途、授权都收起，并说一句
  const mt = code("pages/Matter.tsx");
  assert.match(mt, /const viewOnly = !removedMe && \(matter\.can_write === false \|\| \(matter\.can_write === undefined && matter\.my_role === "viewer"\)\);\s*const locked = closed \|\| viewOnly \|\| removedMe;/);
  assert.match(mt, /\{!locked && \(\s*<button className="btn-ghost" aria-expanded=\{composerOpen/);
  assert.match(mt, /\{matView === "list" && !locked && \(\s*<MaterialPicker/);
  assert.match(mt, /readOnly=\{locked\} disabled=\{busy\} onChanged=\{reload\}/);
  assert.match(mt, /你在这个事项里是“只看”：可以看材料、AI 记录和成果，不能加材料、发起任务或改动。/);
  // 上手清单第 2 卡
  const base = { own_matters: 1, materials: 0, runs: 0, deliverables: 0, latest_matter_id: null, latest_run: null };
  assert.equal(checklistItems(base, null, { team: true })[1]!.body, "导入合同、起诉状等；团队共享事项会同步给同事");
  assert.equal(checklistItems(base, null)[1]!.body, "导入合同、起诉状等，只存本机", "个人空间照旧");
  assert.match(code("components/GuideChecklist.tsx"), /checklistItems\(p, backup, \{ team: role !== "personal" \}\)/);
});

test("验收修四项（内核 919fcafa）：授权卡按事项范围的数据去向与清单版本；被移出如实、收起写入口；没有名额如实；只看的原句", () => {
  // ① 数据去向：只有我接在“系统另外做到”后面；一起办的同事电脑、中软加密副本各一行；旧内核照旧
  assert.deepEqual(authzFlowRows([{ key: "local", label: "案卷", text: "案卷只存这台电脑" }]), { local: "案卷只存这台电脑", rows: [] });
  const team = authzFlowRows([{ key: "colleagues", label: "同事电脑", text: "经加密同步到事项成员的电脑（本所同事 2 人）；他们电脑上也有材料与成果" }, { key: "zr_relay", label: "中软", text: "保存加密副本，打不开内容；本机删除事项不会删除中软上的加密副本" }]);
  assert.equal(team.local, null);
  assert.deepEqual(team.rows.map((r) => r.label), ["同事电脑", "中软"]);
  assert.deepEqual(authzFlowRows(null), { local: "案卷只存这台电脑", rows: [] });
  const consent = code("components/Consent.tsx");
  assert.match(consent, /发出前把姓名、证件号、电话等换成代号\{flows\.local \? `；\$\{flows\.local\}` : ""\}/);
  assert.match(consent, /\{flowRows\.map\(\(f\) => \(/);
  assert.match(consent, /const flowRows = flows\.rows\.filter\(\(f\) => !\(f\.key === "zr_relay" && list\.some\(\(p\) => \/加密副本\/\.test\(p\.role\)\)\)\);/, "实拍：中软那条已写在次处理者说明里时不再单列");
  // 事项头授权一行：改为一起办引起的重新确认如实说
  assert.equal(authorizationStatus({ basis_state: "reconfirm", collab_scope: "team", authorization_history: [{ scope: "personal" }] }).label, "改为团队共享，待重新确认");
  assert.equal(authorizationStatus({ basis_state: "reconfirm", collab_scope: "personal" }).label, "次处理者清单已更新，待重新确认");
  assert.doesNotMatch(consent, /换成代号；案卷只存这台电脑<\/dd>/, "不再写死");
  // ② 重新确认：按事项范围的清单版本；只有我转一起办后如实引导
  const rs = code("components/RunSheet.tsx");
  assert.match(rs, /\.aiAuthorization\(matter\.matter_id\)/);
  assert.match(rs, /const scopeVersion = matter\.subprocessors\?\.version \?\? defaults\?\.subprocessors\?\.version;\s*const reconfirm = needsRef \|\| !!estimate\.data_where\?\.reconfirm \|\| needsReconfirm\(matter, scopeVersion\);/);
  assert.equal(reconfirmReason({ collab_scope: "team", authorization_history: [{ scope: "personal" }] }), "scope");
  assert.equal(reconfirmReason({ collab_scope: "team", authorization_history: [{ scope: "team" }] }), "list");
  assert.equal(reconfirmReason({ collab_scope: "team", basis_notice_version: "sp-2026-11" }, "sp-2026-11-team"), "scope", "事项列表里取的事项：按版本判断");
  assert.equal(reconfirmReason({ collab_scope: "personal", authorization_history: [{ scope: "personal" }] }), "list");
  assert.match(consent, /这个事项改为团队共享了，请重新确认本案授权/);
  // 第二轮复评 T12（41c / 41d）：说明压到两行，不再贴一遍标准段落
  assert.match(consent, /"原来的授权只覆盖这台电脑，没覆盖同事之间同步；核实客户授权覆盖下面的范围后重新记录，记录前不会发给 AI。"/);
  // ③ 被移出：一条说明、事项头不写“团队共享 · n 人”、事项成员标签收起、写入口收起
  assert.equal(REMOVED_ME_TEXT, "负责人已把你移出这个事项：之后同事的改动你不会再收到，你的改动也不会再同步给同事；你电脑上已有的内容保留，只能查看。");
  assert.deepEqual(syncNotice("removed"), { text: REMOVED_ME_TEXT, enable: false });
  const mt = code("pages/Matter.tsx");
  assert.match(mt, /const removedMe = !!matter\.removed_me \|\| members\?\.removed_me === true \|\| members\?\.sync === "removed";/);
  assert.match(mt, /\{removedMe && \(\s*<div className="banner banner-gray banner-inline removed-me-note" role="note">\s*<span>\{REMOVED_ME_TEXT\}<\/span>/);
  // ④ 没有名额：我这边、同事那边（律师层说“AI 使用名额”，不说席位——lawyer-copy 门禁）
  assert.deepEqual(syncNotice("no_seat"), { text: NO_SEAT_TEXT, enable: false });
  assert.equal(relaySyncOf({ blocked: null, credential_error: "credential_no_seat" }), "no_seat");
  assert.equal(relaySyncOf({ blocked: null, credential_error: "credential_seat_revoked" }), "no_seat", "实拍：名额被收回时凭据报 seat_revoked");
  assert.match(teamShareLine({ blocked: null, credential_error: "credential_seat_revoked" }), /还没有分配到 AI 使用名额/);
  assert.equal(needsShareRefresh("no_seat"), true);
  assert.equal(scopeHint("team", true, true, "no_seat"), NO_SEAT_TEXT);
  assert.match(teamShareLine({ blocked: null, credential_error: "credential_no_seat" }), /还没有分配到 AI 使用名额/);
  assert.deepEqual(memberRowNote(row({ seat: false, can_receive: false })), { text: "他还没有分配到 AI 使用名额，收不到这个事项：请管理员在“设置 → 团队”里分配。", tone: "quiet", assign: true }, "第二轮复评 T13（45）：管理员看时给“去分配 →”");
  assert.equal(colleagueMeta(person({ seat: false, can_receive: false })), "律师 · 还没有 AI 使用名额");
  for (const t of [NO_SEAT_TEXT, REMOVED_ME_TEXT]) assert.doesNotMatch(t, /席位|中继|密钥/);
  // ⑤ 只看 / 被移出的报错用内核原句
  assert.equal(teamFaultText({ code: "forbidden", message: "你在这个事项里是“只看”：不能加材料或发起任务，请找负责人周启明", detail: { reason: "viewer_read_only", owner_name: "周启明" } }), "你在这个事项里是“只看”：不能加材料或发起任务，请找负责人周启明");
  assert.equal(teamFaultText({ code: "forbidden", message: REMOVED_ME_TEXT, detail: { reason: "removed_from_matter" } }), REMOVED_ME_TEXT);
});

test("协调方口径 ①：被移出的事项在侧栏 / 列表 / 搜索不再带团队共享记号，改为灰色“已移出”小标（读屏同）；个人空间都不出现", () => {
  assert.equal(matterMark({ collab_scope: "team" }, "team"), "shared");
  assert.equal(matterMark({ collab_scope: "team", removed_me: true }, "team"), "removed", "被移出：不再算团队共享记号");
  assert.equal(matterMark({ collab_scope: "team", removed_me: true }, null), "removed", "类型还不知道时照实");
  assert.equal(matterMark({ collab_scope: "team", removed_me: true }, "personal"), null, "个人空间一处不变");
  assert.equal(matterMark({ collab_scope: "personal" }, "team"), null);
  assert.equal(matterMark(null, "team"), null);
  // 事项页的范围事实不变（被移出的仍是团队共享事项，横幅、只看另有判断）
  assert.equal(isTeamShared({ collab_scope: "team" }, "team"), true);
  assert.equal(markPrefix("客户甲", "removed"), "已移出 · 客户甲");
  assert.equal(markPrefix("", "removed"), "已移出");
  assert.equal(markPrefix("客户甲", "shared"), teamPrefix("客户甲", true));
  assert.equal(markPrefix("客户甲", null), "客户甲");
  // 搜索：传映射时按记号拼前缀；仍兼容传集合（= 团队共享）
  const marks = new Map([["m2", "shared" as const], ["m3", "removed" as const]]);
  const g = searchGroups({ matters: [{ matter_id: "m1", title: "甲", sub: "客户甲" }, { matter_id: "m2", title: "乙", sub: "客户乙" }, { matter_id: "m3", title: "丙", sub: "客户丙" }], runs: [], deliverables: [] }, Date.now(), marks);
  assert.deepEqual(g[0]!.items.map((i) => i.sub), ["客户甲", "团队共享 · 客户乙", "已移出 · 客户丙"]);
  // 小标是看得见的字（读屏读到同一句），灰色，不靠悬停；团队共享记号只在 shared 时出现
  const tm = code("components/TeamMatter.tsx");
  assert.match(tm, /export function RemovedTag\(\{ className = "" \}: \{ className\?: string \}\) \{\s*return <span className=\{`tag tag-gray tag-removed \$\{className\}`\.trim\(\)\}>已移出<\/span>;/);
  assert.match(tm, /return mark === "shared" \? <TeamMark \/> : mark === "removed" \? <RemovedTag \/> : null;/);
  assert.doesNotMatch(tm.slice(tm.indexOf("export function RemovedTag("), tm.indexOf("export function MatterMarkBadge(")), /title=/, "不靠悬停");
  const css = src("styles-team-matters.css");
  assert.match(css, /\.tag-removed \{ flex: none; white-space: nowrap; \}/);
  assert.match(css, /\.sidebar-link-row \.tag-removed \{ margin-left: 6px; \}/);
  // 侧栏、列表、输入框、首页浮层、搜索都走同一个判断
  for (const f of ["components/Sidebar.tsx", "pages/Matters.tsx", "components/Composer.tsx", "components/MatterPlace.tsx", "components/SearchPalette.tsx"]) {
    assert.match(code(f), /matterMark\(/, f);
    assert.doesNotMatch(code(f), /isTeamShared\(/, `${f} 不再只看 collab_scope`);
  }
});

test("协调方口径 ②：云端还没有同事名单能力（team.roster 回 not_supported）——团队页“同事之间同步”一行写“需要中软把云端升级后才能使用”，不说“暂时连不上”；团队共享入口照旧不出现", () => {
  assert.equal(CLOUD_UPGRADE_TEXT, "需要中软把云端升级后才能使用");
  const ns = { reason: "not_supported" as const };
  // 团队策略首行：不管同步状态读没读到、读到什么，都只说这一句、不给按钮
  const on = { relay_configured: true, state: "allowed", can_manage: true, threshold: 1, signatures: 1, days_left: 20, expires_at: "2026-12-27T00:00:00Z" } as unknown as ShareRelayStatus;
  for (const s of [null, on]) {
    const r = shareRelayRow(s, Date.now(), ns);
    assert.equal(r.state, "upgrade");
    assert.equal(r.text, CLOUD_UPGRADE_TEXT);
    assert.deepEqual(r.actions, []);
    assert.equal(r.warn, false);
    assert.doesNotMatch(r.text, /暂时连不上/);
  }
  // 名单连不上（offline）、取不到（unavailable）不算：照常显示同步状态
  assert.equal(shareRelayRow(on, Date.now(), { reason: "offline" }).state, "on");
  assert.equal(shareRelayRow(on, Date.now(), { reason: "unavailable" }).state, "on");
  // 入口：新建事项“谁能看到”整块不出现；事项“⋯ → 和同事一起办…”不出现；名单处、出错时同一说法
  assert.equal(scopeAvailability({ kind: "team", issuer: "firm_root", level: "normal", roster: ns }).show, false);
  const m = { collab_scope: "personal", my_role: "owner", lifecycle: "active", is_sample: false };
  assert.equal(canOfferShare("team", m, ns), false);
  assert.equal(canOfferShare("team", m, null), true, "名单没回来前照常给，由内核判断");
  assert.equal(canOfferShare("team", m, { reason: "offline" }), true);
  assert.equal(rosterNote({ available: false, reason: "not_supported", members: [] }), "同事名单需要中软把云端升级后才能使用。");
  // 接线
  const rr = code("components/ShareRelayRow.tsx");
  assert.match(rr, /const roster = useRoster\(true\);/);
  assert.match(rr, /const row = shareRelayRow\(s \?\? null, Date\.now\(\), roster\);/);
  assert.match(rr, /\{s === undefined && row\.state !== "upgrade" \? \(/);
  const ts = code("components/TeamShare.tsx");
  assert.match(ts, /if \(roster\?\.reason === "not_supported"\)\s*return relayRowAbove \? null : \(\s*<div className="device-row">\s*<div className="device-k">团队共享<\/div>\s*<div>\s*<span>同事之间同步：\{CLOUD_UPGRADE_TEXT\}<\/span>/, "普通成员也如实看到；管理员上面已有那一行，不重复");
  assert.ok(ts.indexOf('roster?.reason === "not_supported"') < ts.indexOf("teamShareLine(st)"), "在同步状态、出错句之前截住（不说“暂时连不上”，不给申请 / 立即同步）");
  const mt = code("pages/Matter.tsx");
  assert.match(mt, /const offerBase = !!matter && !teamShared && canOfferShare\(teamKind, matter\);\s*const offerRoster = useRoster\(offerBase\);\s*const offerShare = offerBase && canOfferShare\(teamKind, matter!, offerRoster\);/);
  const nm = code("components/NewMatter.tsx");
  assert.match(nm, /const roster = useRoster\(team\);/, "直接登录的电脑也先知道云端支不支持");
});

test("第二轮复评 T12：团队共享事项的授权卡固定列出“同事电脑”（同一来源、旧内核也不写“案卷只存这台电脑”）；同步未开通写“开通后会同步到 n 位同事电脑”；41b 只说一次；41c / 41d 两行", () => {
  const flows = [
    { key: "colleagues", label: "同事电脑", text: "经加密同步到事项成员的电脑（本所同事 2 人）；他们电脑上也有材料与成果", count: 2 },
    { key: "zr_relay", label: "中软", text: "保存加密副本，打不开内容；本机删除事项不会删除中软上的加密副本" },
  ];
  // 已开通：内核原句
  assert.equal(authzFlowRows(flows, { team: true, relay: true }).rows[0]!.text, flows[0]!.text);
  // 没开通：写成开通后会同步到哪里（人数用内核 count；没有 count 时从原句读）
  assert.equal(authzFlowRows(flows, { team: true, relay: false }).rows[0]!.text, "同事之间同步开通后，会加密同步到本事项 2 位同事的电脑；他们电脑上也会有材料与成果");
  assert.equal(colleaguesCount({ text: "经加密同步到事项成员的电脑（本所同事 3 人）；…" }), 3);
  assert.equal(colleaguesCount({ text: "经加密同步到之后加进来的同事电脑；他们电脑上也会有材料与成果" }), 0);
  assert.equal(colleaguesCount({ text: "x", count: 5 }), 5);
  assert.equal(colleaguesCount({ text: "经加密同步到事项成员的电脑；…" }), null);
  assert.equal(colleaguesPendingText(0), "同事之间同步开通后，会加密同步到之后加进来的同事电脑；他们电脑上也会有材料与成果");
  assert.equal(colleaguesPendingText(null), "同事之间同步开通后，会加密同步到本事项同事的电脑；他们电脑上也会有材料与成果");
  // 13 / win150-w5 的来源：旧内核没给 data_flows——团队共享事项也固定列“同事电脑”，不再写“案卷只存这台电脑”
  const old = authzFlowRows(null, { team: true, relay: null });
  assert.equal(old.local, null);
  assert.deepEqual(old.rows.map((r) => r.label), ["同事电脑", "中软"]);
  assert.deepEqual(authzFlowRows(null, { team: false }), { local: "案卷只存这台电脑", rows: [] }, "只有我的事项不变");
  // 开始前确认与事项页“记录授权”同一来源、同一判断
  const consent = code("components/Consent.tsx");
  assert.match(consent, /const relay = useRelayState\(team\);\s*const flows = authzFlowRows\(dataFlows, \{ team, relay: team \? relay\.ready : null \}\);/);
  for (const f of ["components/RunSheet.tsx", "pages/Matter.tsx"]) assert.match(code(f), /dataFlows=\{matter\.data_flows \?\? defaults\?\.data_flows \?\? null\}\s*team=\{matter\.collab_scope === "team"\}/, f);
  // 41c / 41d：重新确认的说明两行以内，不再贴标准段落
  assert.doesNotMatch(consent, /\}\s*请记下客户授权的依据/, "标准段落只在第一次记录时出现");
  // 41b：胶囊已说“待重新确认”，下一行只给去处
  const trail = code("components/AuthorizationTrail.tsx");
  assert.match(trail, /if \(onReconfirm && \(status\.key === "reconfirm" \|\| status\.key === "needs_ref"\)\)/);
  assert.match(trail, /\{status\.key === "needs_ref" \? "去补记出处 →" : "去重新确认 →"\}/);
  const mt = code("pages/Matter.tsx");
  assert.match(mt, /const again = matter\.basis_state === "reconfirm" \|\| matter\.basis_state === "needs_ref";\s*const complete = basisComplete\(basis\) && !again;/, "去重新确认打开与开始前确认同一张记录卡");
  assert.match(mt, /reconfirm=\{matter\.basis_state === "reconfirm"\}\s*reconfirmWhy=\{reconfirmReason\(matter, scopeVersion\)\}/);
});

test("第二轮复评 T13：被移出的说法与“从我的电脑移除”；没有名额不打对勾、藏起“立即同步”；管理员看到同事没名额可去分配", () => {
  assert.match(REMOVED_ME_TEXT, /之后同事的改动你不会再收到，你的改动也不会再同步给同事；你电脑上已有的内容保留，只能查看。$/);
  assert.equal(removeLocalCopyLines().length, 3);
  assert.match(removeLocalCopyLines()[1]!, /负责人和其他同事电脑上的这个事项、中软那里的加密副本都不受影响/);
  const mt = code("pages/Matter.tsx");
  assert.match(mt, /\{removedMe && \(\s*<button role="menuitem" className="menu-item" onClick=\{\(\) => \{ setRemovingLocal\(true\); setMoreOpen\(false\); \}\}>\s*<span className="menu-label">从我的电脑移除…<\/span>/);
  assert.match(mt, /\.\.\.\(removedMe \? \[\] : \[\["lifecycle", "结案与删除"\]\]\)/, "被移出的人不给“结案与删除”");
  assert.match(mt, /await api\.removeLocalCopy\(matter\.matter_id, title\);/);
  assert.match(mt, /disabled=\{busy \|\| title !== matter\.title\}/, "输入事项名称才能移除");
  assert.match(code("api.ts"), /invoke<[^>]*>\("matters\.remove_local_copy", \{ matter_id: id, confirm_title: confirmTitle \}\)/);
  assert.match(code("components/MatterLifecycle.tsx"), /r\.mode === "local_copy" \? "这台电脑上的副本已删除" : "事项数据已删除"/);
  // 43：没有名额
  assert.equal(credentialNoSeat({ credential_error: "credential_seat_revoked" }), true);
  assert.equal(credentialNoSeat({ credential_error: "credential_backoff" }), false);
  assert.doesNotMatch(NO_SEAT_CONFIRMED_TEXT, /席位/);
  const ts = code("components/TeamShare.tsx");
  assert.match(ts, /const ok = s\.state === "confirmed" && relay === true && !noSeat;/, "没名额不打对勾");
  assert.match(ts, /\{!noSeat && <button className="btn-ghost btn-sm" disabled=\{busy\} onClick=\{\(\) => void syncNow\(\)\}>/, "没名额不给“立即同步”");
  // 45：管理员看同事没名额
  const tm = code("components/TeamMatter.tsx");
  assert.match(tm, /\{note\.assign && canEnable && \(\s*<button type="button" className="btn-link mm-sub-go" onClick=\{\(\) => nav\("\/connections\/team"\)\}>\s*去分配 →/);
});

test("第二轮复评 T8 / T14 / 跨页：同步状态一套词；规则没生效写原因；连不上一种说法；提示两种样式；复选框产品样式；叫法统一为“团队共享”", () => {
  // 一套词：同事之间同步：已开通 / 未开通 / 已暂停 / 用不了
  for (const st of [{ blocked: null }, { blocked: "not_allowed" }, { blocked: "exit_mode" }, { blocked: null, credential_error: "credential_no_seat" }, { blocked: "not_allowed", policy_fallback: true }])
    assert.match(teamShareLine(st), /^同事之间同步：(已开通|未开通|已暂停|用不了)( · |$)/, JSON.stringify(st));
  assert.doesNotMatch(teamShareLine({ blocked: null }), /正常/);
  // 规则没在这台电脑上生效：写明原因与去向，不给“开通…”
  const fb = shareRelayRow({ relay_configured: true, state: "not_allowed", can_manage: true, threshold: 1, signatures: 0, expires_at: null, days_left: null, fallback_reason: "none_received" } as ShareRelayStatus);
  assert.equal(fb.text, "未开通 · 这台电脑还没收到本所规则，联网后自动更新");
  assert.deepEqual(fb.actions, []);
  // 连不上：一种说法
  assert.equal(OFFLINE_HEAD, "暂时连不上 Kimi Work");
  assert.match(rosterNote({ available: false, reason: "offline", members: [person({})] })!, /^暂时连不上 Kimi Work：下面是上次取到的同事名单。$/);
  assert.match(syncNotice("unreachable")!.text, /^暂时连不上 Kimi Work：/);
  assert.match(relayErrorText("connect_timeout")!, /^暂时连不上 Kimi Work：/);
  for (const c of ["credential_no_seat", "credential_seat_revoked", "seat_revoked"]) assert.match(relayErrorText(c)!, /^你还没有分配到 AI 使用名额/, c);
  for (const t of [rosterNote({ available: false, reason: "offline", members: [] })!, syncNotice("unreachable")!.text]) assert.doesNotMatch(t, /联不上|同步服务/);
  // 提示两种样式：37 没加上的人用灰底说明条（提醒图标），38 名单说明条在名单上方
  const tm = code("components/TeamMatter.tsx");
  assert.match(tm, /<div className="mm-notice mm-notice-warn" role="status">\s*<Icon\.alert \/>/);
  assert.doesNotMatch(tm, /mm-msg is-warn/);
  assert.match(tm, /\{note && <p className="cp-note cp-note-bar" role="note">\{note\}<\/p>\}\s*\{variant === "inline" && !open && \(/);
  const css = src("styles-team-matters.css");
  assert.match(css, /\.cp-note\.cp-note-bar \{[^}]*background: var\(--bg-subtle\);/);
  assert.match(css, /\.cp-search \{ -webkit-appearance: none; appearance: none;[^}]*border-radius: var\(--r-sm\);/, "搜索同事框不是浏览器原生方框");
  // 复选框：全库产品样式（不用系统原生），选中 Kimi 蓝
  const base = src("styles.css");
  assert.match(base, /input\[type="checkbox"\] \{ appearance: none; -webkit-appearance: none;/);
  assert.match(base, /input\[type="checkbox"\]:checked \{ background: var\(--accent\); border-color: var\(--accent\); \}/);
  assert.doesNotMatch(base, /input\[type="checkbox"\], input\[type="radio"\] \{ accent-color/);
  // 叫法：律师层正文不再用“和同事一起办”（注释除外）；内核原句里的旧叫法换掉
  for (const f of ["lib/team-matters.ts", "lib/workspace.ts", "lib/authorization.ts", "lib/guide-checklist.ts", "lib/relay-text.ts", "lib/offboarding.ts", "components/TeamMatter.tsx", "components/ShareRelayRow.tsx", "components/Consent.tsx", "components/RunSheet.tsx", "pages/Matter.tsx"]) {
    const lines = code(f).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l));
    assert.ok(!lines.some((l) => /和同事一起办/.test(l.replace(/\/\/.*$/, "").replace(/replace\(\/[^/]*\//g, ""))), f);
  }
  assert.equal(SCOPE_OPTIONS[1]!.label, "团队共享");
  assert.equal(teamFaultText({ code: "validation", message: "已改为和同事一起办：加进来的同事会收到这个事项" }), "已改为团队共享：加进来的同事会收到这个事项");
  assert.equal(teamFaultText({ code: "validation", message: "这个事项已是团队共享，经同步服务转送" }), "这个事项已是团队共享，经同步服务转送");
});
