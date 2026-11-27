/**
 * 第 72 批客户端（impl-U2：个人 / 团队工作空间界面；D-304、D-305，契约 02 §7，A3 D1～D4）：纯函数 + 渲染判定 + 关键接线。
 * 端到端（真实控制面 + 两个数据根）见 packages/kernel/test/b72-workspaces.test.ts；界面走查截图见研究目录 evidence/after-team/。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  dueLabel,
  formatInviteCode,
  leftNoticeText,
  parseLeftNotice,
  inviteCodeComplete,
  leaveLines,
  resolveKind,
  roleOfMember,
  shareIssuerNote,
  teamErrorText,
  teamNameOk,
  templatesLabel,
  upgradeLines,
  workspaceFeatures,
  workspaceLabel,
  workspaceMenuMeta,
  workspaceRoleTag,
} from "../src/lib/workspace.ts";
import { adminErrorText, devicesCell, memberActions, memberMenu, memberStatus, removeLines, seatSummary, splitInvites, type TeamMemberRow } from "../src/lib/team-admin.ts";
import { deviceLimitOf, switchOutcome, waitForProfileSwitch } from "../src/lib/account-switch.ts";

const src = (p: string) => readFileSync(fileURLToPath(new URL(`../src/${p}`, import.meta.url)), "utf8");
const code = (p: string) => src(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

test("类型判定（A3 D1）：内核状态 workspace_kind 优先，其次列表当前一项；证书角色只作角色的兜底", () => {
  assert.equal(resolveKind("personal", { kind: "team" }), "personal");
  assert.equal(resolveKind(null, { kind: "team" }), "team");
  assert.equal(resolveKind(undefined, null), null);
  assert.equal(resolveKind("bogus", { kind: "x" }), null);
  assert.equal(roleOfMember("firm_admin"), "admin");
  assert.equal(roleOfMember("partner"), "partner");
  assert.equal(roleOfMember("member"), null);
});

test("显示哪些功能（渲染判定）：个人空间没有“团队”“管理”、有升级与技术支持折叠；团队按角色分；取不到类型时不出团队功能", () => {
  // 个人账号在内核里证书角色是管理员——按旧推断会出“管理”“团队与离所”（A3 2.5）；现在不会
  const personal = workspaceFeatures("personal", "admin");
  assert.deepEqual([personal.teamTab, personal.teamAdmin, personal.teamRead, personal.adminTab, personal.upgrade, personal.supportInBackup], [false, false, false, false, true, true]);
  const admin = workspaceFeatures("team", "admin");
  assert.deepEqual([admin.teamTab, admin.teamAdmin, admin.teamRead, admin.adminTab, admin.upgrade], [true, true, true, true, false]);
  const partner = workspaceFeatures("team", "partner");
  assert.deepEqual([partner.teamTab, partner.teamAdmin, partner.teamRead, partner.adminTab], [true, false, true, true], "合伙人只读成员");
  const lawyer = workspaceFeatures("team", "lawyer");
  assert.deepEqual([lawyer.teamTab, lawyer.teamAdmin, lawyer.teamRead, lawyer.adminTab], [true, false, false, false]);
  const unknown = workspaceFeatures(null, "admin");
  assert.deepEqual([unknown.teamTab, unknown.upgrade, unknown.adminTab], [false, false, true], "开发形态 / 试用版：没有团队页签与升级，管理员仍有技术支持等");
});

test("名称与标签：侧栏一行“名称 · 个人 / 团队”，团队带角色；个人空间“我的范本”", () => {
  assert.equal(workspaceLabel({ kind: "personal", name: "王律师的工作室" }), "王律师的工作室 · 个人");
  assert.equal(workspaceLabel({ kind: "team", name: "某某律师事务所" }), "某某律师事务所 · 团队");
  assert.equal(workspaceLabel({ kind: "personal", name: " " }), "个人工作室 · 个人", "没有名称时写类型");
  assert.equal(workspaceRoleTag({ kind: "team", role: "admin" }), "管理员");
  assert.equal(workspaceRoleTag({ kind: "personal", role: "admin" }), null, "个人空间不写角色");
  assert.equal(templatesLabel("personal").short, "我的范本");
  assert.equal(templatesLabel("personal").library, "我的范本库");
  assert.equal(templatesLabel("team").short, "本所范本");
  assert.equal(templatesLabel(null).short, "本所范本");
  assert.equal(workspaceMenuMeta({ aid: "a", kind: "team", name: "x", role: "lawyer", current: false, local_profile: false, status: "active" }), "首次在这台电脑打开");
  assert.equal(workspaceMenuMeta({ aid: "a", kind: "team", name: "x", role: "lawyer", current: false, local_profile: true, status: "disabled" }), "已停用或已移出");
  assert.equal(workspaceMenuMeta({ aid: "a", kind: "personal", name: "x", role: null, current: true, local_profile: true, status: "active" }), null);
});

test("邀请码输入：去空白、转大写、4 位一组加横线、16 位封顶；完整才可提交；团队名 2～40 字", () => {
  assert.equal(formatInviteCode("abcd efgh-ijkl mnop"), "ABCD-EFGH-IJKL-MNOP");
  assert.equal(formatInviteCode("abcdefghijklmnopqrst"), "ABCD-EFGH-IJKL-MNOP");
  assert.equal(formatInviteCode("ab"), "AB");
  assert.equal(formatInviteCode("abcd"), "ABCD", "满一组不先加横线");
  assert.equal(formatInviteCode("abcde"), "ABCD-E");
  assert.ok(inviteCodeComplete("ABCD-EFGH-IJKL-MNOP"));
  assert.ok(!inviteCodeComplete("ABCD-EFGH-IJKL-MNO"));
  assert.ok(teamNameOk("某所"));
  assert.ok(!teamNameOk("某"));
  assert.ok(!teamNameOk("某".repeat(41)));
});

test("危险操作的后果写清（D-305）：升级四件事（不可撤回在最后）、退出团队、移出成员；四个动作不混用", () => {
  const up = upgradeLines("某某律师事务所");
  assert.equal(up.length, 4);
  assert.match(up[0]!, /同一个工作空间.*「某某律师事务所」.*原地不动/);
  assert.match(up[1]!, /仍只属于你/);
  assert.match(up[2]!, /邀请同事/);
  assert.match(up[3]!, /不能撤回/);
  const lv = leaveLines("某某所", "王律师的工作室");
  assert.match(lv.join(""), /先交接给同事/);
  assert.match(lv.join(""), /重新启用，或重新邀请/, "C12：与列表里的“重新启用”同一口径");
  assert.match(lv.join(""), /切到「王律师的工作室」/);
  assert.match(lv.join(""), /不能自己撤回/);
  const rm = removeLines("张律师");
  assert.match(rm.join(""), /2 分钟内退出这个团队/);
  assert.match(rm.join(""), /管理员也看不到/);
  assert.match(rm.join(""), /离所交接/);
  assert.match(rm.join(""), /可在成员列表里重新启用，或重新邀请/);
  // 律师层不说“席位”，说“AI 使用名额”
  assert.doesNotMatch([...up, ...lv].join(""), /席位/);
  for (const l of [...up, ...lv, ...rm]) assert.doesNotMatch(l, /律所根|签发钥|租户|证书/);
});

test("团队共享提示（D-304）：只在团队空间、账号直接登记的电脑上出现；管理员与成员说法不同；个人空间不出现", () => {
  // 第 72 批（U-2）：直接登录的电脑本批不能事后确认——提示只说现状与找谁，不承诺“管理员确认一下就行”
  assert.match(shareIssuerNote("account_ca", "team", false)!, /^这台电脑是直接登录的，暂不能接收团队共享事项，其它功能不受影响。团队需要共享事项时，请联系管理员。$/);
  assert.doesNotMatch(shareIssuerNote("account_ca", "team", false)!, /确认/);
  assert.match(shareIssuerNote("account_ca", "team", true)!, /团队开通时用的那台电脑/);
  assert.equal(shareIssuerNote("firm_root", "team", false), null);
  assert.equal(shareIssuerNote("account_ca", "personal", false), null);
  assert.equal(shareIssuerNote(null, "team", false), null);
});

test("成员行（管理员）：状态、电脑数、可用操作——不能停用 / 移出自己；被中软停用的不能启用；席位摘要", () => {
  const m = (o: Partial<TeamMemberRow>): TeamMemberRow => ({ aid: "acc_a", name: "张律师", role: "lawyer", status: "active", ...o });
  assert.deepEqual(memberStatus(m({})), { text: "正常", tone: "ok" });
  assert.deepEqual(memberStatus(m({ status: "disabled", disabled_by: "team" })), { text: "已停用或移出", tone: "off" });
  assert.deepEqual(memberStatus(m({ status: "disabled", disabled_by: "platform" })), { text: "被中软停用", tone: "bad" });
  assert.equal(devicesCell({ signed_in: 1, limit: 3 }), "1 / 3 台");
  assert.equal(devicesCell(null), "—");
  assert.deepEqual(memberActions(m({ seat: { sid: "s", assigned_at: "t" } }), "acc_me"), { role: true, seat: "release", disable: true, enable: false, remove: true });
  assert.deepEqual(memberActions(m({ seat: null, seat_used: false }), "acc_me"), { role: true, seat: "assign", disable: true, enable: false, remove: true });
  assert.deepEqual(memberActions(m({ aid: "acc_me" }), "acc_me"), { role: true, seat: "assign", disable: false, enable: false, remove: false }, "自己");
  assert.deepEqual(memberActions(m({ status: "disabled", disabled_by: "platform" }), "acc_me"), { role: false, seat: null, disable: false, enable: false, remove: false });
  assert.equal(memberActions(m({ status: "disabled", disabled_by: "team" }), "acc_me").enable, true);
  assert.equal(seatSummary({ total: 5, used: 3 }), "席位（AI 使用名额）3 / 5 已分配，空 2 个", "管理员层说“席位”，首次出现括注");
  assert.equal(seatSummary({ total: 3, used: 3 }), "席位（AI 使用名额）3 / 3 已分配，已满");
  // C12：停用 / 移出 / 退出分开（云端 disabled_kind）；旧云端没有字段时如实合写
  assert.equal(memberStatus(m({ status: "disabled", disabled_by: "team", disabled_kind: "disabled" })).text, "已停用");
  assert.equal(memberStatus(m({ status: "disabled", disabled_by: "team", disabled_kind: "removed" })).text, "已移出");
  assert.equal(memberStatus(m({ status: "disabled", disabled_by: "team", disabled_kind: "left" })).text, "已退出");
  // C10：行尾菜单每项一句后果，危险项（移出）置底
  const menu = memberMenu(memberActions(m({ seat: { sid: "s", assigned_at: "t" } }), "acc_me"));
  assert.deepEqual(menu.map((x) => x.key), ["release", "disable", "remove"]);
  assert.ok(menu.every((x) => x.hint.length > 0));
  assert.equal(menu.at(-1)!.danger, true);
  assert.deepEqual(memberMenu(memberActions(m({ status: "disabled", disabled_by: "team" }), "acc_me")).map((x) => x.key), ["enable"]);
  assert.equal(seatSummary(null), null);
  const inv = splitInvites([
    { id: "1", name: "a", role: "lawyer", status: "open", created_at: "", expires_at: "" },
    { id: "2", name: "b", role: "lawyer", status: "accepted", created_at: "", expires_at: "" },
  ]);
  assert.deepEqual([inv.open.map((x) => x.id), inv.done.map((x) => x.id)], [["1"], ["2"]]);
});

test("错误人话：内核已映射的原样用；内核没映射的原因码补上（退出无处可去、席位满、不能移出自己）", () => {
  const e = (reason: string, message = "中软服务暂时不可用，请稍后重试") => Object.assign(new Error(message), { detail: { reason } });
  assert.match(teamErrorText(e("no_other_workspace")), /唯一的工作空间/);
  assert.equal(teamErrorText(e("invite_invalid", "邀请码不正确、已过期或已被使用：请向团队管理员重新获取")), "邀请码不正确、已过期或已被使用：请向团队管理员重新获取");
  assert.match(adminErrorText(e("seats_full")), /席位已用满/);
  assert.match(adminErrorText(e("cannot_remove_self")), /退出团队/);
  assert.match(adminErrorText(e("no_other_workspace")), /唯一的工作空间/, "管理员层也认律师层的补充");
  assert.equal(teamErrorText({}), "没有完成，请稍后重试");
});

test("切换流程复用第 68 批（D-305 第 4 条）：结果归类、满额选择卡数据、两分钟没换过来先重拉一次内核", async () => {
  assert.equal(switchOutcome({ ok: true, switched: true }), "switched");
  assert.equal(switchOutcome({ ok: true, switched: false, same: true }), "same");
  assert.equal(switchOutcome({ supported: false }), "unsupported");
  assert.equal(switchOutcome({ ok: true, switched: false, left: true }), "none");
  const lim = deviceLimitOf({ detail: { reason: "device_limit", devices: [{ device_id: "d1" }], can_signout: true, device_limit: 2, limit_kind: "signed_in", this_device: "d0" } }, "某所");
  assert.deepEqual(lim && [lim.canSignout, lim.canUnbind, lim.limit, lim.limitKind, lim.thisDevice, lim.who, lim.devices.length], [true, false, 2, "signed_in", "d0", "某所", 1]);
  assert.equal(deviceLimitOf({ detail: { reason: "invite_invalid" } }), null);
  assert.equal(deviceLimitOf({ detail: { reason: "device_limit", devices: [] } }), null);
  // 两分钟没换过来：先重拉一次内核（restartKernel），成功后再等两分钟；仍不行才给出说明（时钟用假的 sleep 推进）
  const realNow = Date.now;
  let t = 1_000_000;
  Date.now = () => t;
  const g = globalThis as unknown as { window?: unknown };
  const hadWindow = "window" in g;
  g.window = { zrKernel: { invoke: async () => ({ profile: { id: "p" } }) } };
  try {
    let restarts = 0;
    let stuck = "";
    await waitForProfileSwitch(
      "p|active",
      (s) => (stuck = s),
      async (ms) => void (t += ms * 50),
      async () => (restarts++, { ok: true }),
    );
    assert.equal(restarts, 1, "只自动重拉一次");
    assert.match(stuck, /已自动重新打开一次仍未完成/);
  } finally {
    Date.now = realNow;
    if (!hadWindow) delete g.window;
  }
});

test("接线：设置按工作空间显示（不再有 inFirm / ADMIN_ROLES 推断）；团队页签与“管理”分工；个人空间技术支持收进备份页", () => {
  const c = code("pages/Connections.tsx");
  assert.doesNotMatch(c, /ADMIN_ROLES|const inFirm/);
  assert.match(c, /const ws = useWorkspace\(\);\s*const f = ws\.features;\s*const isAdmin = f\.adminTab;/);
  assert.match(c, /t\[0\] === "account" && f\.teamTab \? \[t, \["team", "团队"\]/, "团队页签紧跟“账号”");
  // 评分 C10 第 3 条：团队空间里叫“审计与支持”（团队策略并进“团队”）；开发形态仍叫“管理”
  assert.match(c, /if \(isAdmin\) tabs\.push\(\["admin", f\.teamTab \? "审计与支持" : "管理"\]\);/);
  assert.match(c, /withPolicy=\{!f\.teamTab\}/);
  const team = c.slice(c.indexOf("function TeamTab("), c.indexOf("function BackupTab("));
  assert.match(team, /<MemberDevicePolicy \/>/);
  assert.match(team, /<PolicyTab \/>/);
  assert.match(c, /support=\{f\.supportInBackup \? <DiagnosticsTab /);
  assert.match(c, /<WorkspaceSection ws=\{ws\} \/>/);
  assert.match(c, /\{f\.teamRead && <TeamAdmin canEdit=\{f\.teamAdmin\} myAid=\{ws\.list\?\.current\?\.aid \?\? null\} \/>\}/);
  assert.match(c, /<LeaveTeam ws=\{ws\} \/>/);
  const admin = c.slice(c.indexOf("function AdminTab("), c.indexOf("function DiagnosticsTab("));
  assert.match(admin, /withPolicy \? \(\[\["policy", "团队策略"\]\] as const\) : \[\]/);
  assert.match(admin, /legacyMembers \? \(\[\["members", "成员"\]\] as const\) : \[\]/, "成员只在取不到工作空间类型时留在“管理”");
  assert.match(src("App.tsx"), /a === "team"/);
});

test("接线：侧栏工作空间菜单走同一条切换流程；旧云端只有原有内容；个人空间不问入组申请", () => {
  const s = code("components/Sidebar.tsx");
  assert.match(s, /const wsList = props\.ws\.list\?\.supported \? props\.ws\.list : null;/);
  assert.match(s, /flow\.run\(\(\) => workspaces\.switch\(w\.aid\), w\.name\)/);
  assert.match(s, /openJoinTeam\(\);/);
  assert.match(s, /role="menuitemradio"/);
  assert.match(s, /<small className="user-ws">\{workspaceLabel\(wsCur\)\}<\/small>/);
  assert.match(s, /s\.member_role === "firm_admin" && s\.workspace_kind !== "personal"/);
  const w = code("components/WorkspaceSwitch.tsx");
  assert.match(w, /waitForProfileSwitch\(before,/);
  assert.match(w, /<DeviceLimitList/);
  assert.match(w, /account\.signoutForLogin\(id\)/);
  assert.match(w, /account\.unbindForLogin\(id\)/);
  // 加入团队、退出团队都走同一个流程
  const t = code("components/TeamSpace.tsx");
  assert.match(t, /flow\.run\(\(\) => workspaces\.join\(code\), "团队空间"\)/);
  assert.match(t, /flow\.run\(\(\) => workspaces\.leave\(\), back\?\.name \?\? null\)/);
  assert.match(t, /window\.dispatchEvent\(new Event\(OPEN_OFFBOARDING\)\)/, "退出前引导到离所交接");
  assert.match(src("components/Offboarding.tsx"), /addEventListener\("kwl:open-offboarding"/);
});

test("接线：团队共享提示、范本库名称、团队管理的危险操作都有确认；邀请码只显示一次", () => {
  assert.match(code("components/TeamShare.tsx"), /note = null \}: \{ admin\?: boolean; note\?: string \| null \}/);
  assert.match(code("components/FirmTemplates.tsx"), /templatesLabel\(ws\.kind\)/);
  assert.match(code("pages/Methods.tsx"), /\{tplLabel\.short\}/);
  const a = code("components/TeamAdmin.tsx");
  // 评分 C10：停用 / 释放 / 移出收进行尾菜单，各有确认框（释放可逆，用中性按钮；停用、移出红色）
  assert.match(a, /<RowMenu/);
  assert.match(a, /ask\?\.kind === "release"[\s\S]{0,600}className="btn-primary btn-sm"/);
  assert.match(a, /ask\?\.kind === "disable"[\s\S]{0,700}className="btn-danger-solid btn-sm"/);
  assert.match(a, /\{dueLabel\(x\.expires_at\)\} 前有效/, "C10 第 4 条：日期通用写法");
  assert.match(a, /<ConfirmButton label="撤回"/);
  assert.match(a, /disabled=\{!ask\.ack \|\| busy !== null\} onClick=\{\(\) => void run\(`rm-/, "移出要勾选“已交接完”");
  assert.match(a, /事项内容只在成员自己的电脑上，这里只管谁能用、能用几台。/, "C10 第 5 条：一行");
  assert.match(a, /if \(data && data\.supported === false\) return canEdit \? <MembersAdmin \/> : null;/, "旧云端退回原成员页");
  assert.match(a, /只显示这一次/);
  const ts = code("components/TeamSpace.tsx");
  assert.match(ts, /我知道升级后不能撤回/);
  assert.match(ts, /disabled=\{!ok \|\| !ack \|\| busy\}/);
});

test("文案：设置与侧栏的新界面不出现内部术语；四个动作的按钮名各不相同", () => {
  for (const f of ["components/TeamSpace.tsx", "components/TeamAdmin.tsx", "components/WorkspaceSwitch.tsx", "lib/workspace.ts", "lib/team-admin.ts"]) {
    const visible = [...code(f).matchAll(/"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`|>([^<>{}]*[一-鿿][^<>{}]*)</g)].map((m) => m[0]).filter((t) => /[一-鿿]/.test(t)).join("\n");
    assert.doesNotMatch(visible, /律所根|签发钥|租户|证书|account_ca|firm_root/, f);
  }
  const all = ["components/TeamSpace.tsx", "components/TeamAdmin.tsx", "components/Sidebar.tsx", "components/AccountPanel.tsx"].map(code).join("\n");
  for (const label of ["退出登录", "移除", "移出团队", "退出团队"]) assert.ok(all.includes(label), label);
  // 不再说“新电脑登录要管理员批准”（D-304）
  assert.doesNotMatch(code("components/AccountPanel.tsx"), /新电脑登录需律所管理员批准|需重新登录并由管理员批准/);
});

test("评分第一轮：日期通用写法、被移出后的一次性提示、重新登录页按真实原因", async () => {
  const now = Date.parse("2026-11-27T04:00:00Z");
  assert.equal(dueLabel("2026-12-04T04:49:00Z", now), "12 月 4 日 12:49", "北京时间，同年不写年");
  assert.equal(dueLabel("2027-01-02T00:00:00Z", now), "2027 年 1 月 2 日 08:00");
  assert.equal(dueLabel(null, now), "—");
  assert.equal(leftNoticeText({ team: "陈氏律师事务所", how: "removed" }, "李律师的工作室"), "你已不在「陈氏律师事务所」，已切到「李律师的工作室」。团队空间里的事项仍在这台电脑上。");
  assert.match(leftNoticeText({ team: "某所", how: "left" }, null), /^你已退出「某所」。/);
  assert.equal(parseLeftNotice(JSON.stringify({ team: "某所", how: "removed", at: Date.now() }))?.team, "某所");
  assert.equal(parseLeftNotice(JSON.stringify({ team: "某所", how: "removed", at: Date.now() - 2 * 86_400_000 })), null, "过时不提");
  assert.equal(parseLeftNotice("{bad"), null);
  const { reloginView } = await import("../src/lib/account.ts");
  assert.equal(reloginView("session_team_removed", "陈氏律师事务所").title, "你已不在「陈氏律师事务所」");
  assert.match(reloginView("session_team_removed").lead, /团队管理员把你移出了这个团队/);
  assert.match(reloginView("session_team_left", "某所").lead, /你已退出这个团队/);
  assert.equal(reloginView(null).title, "需要重新登录", "取不到原因时不说过期、不说安全");
  assert.doesNotMatch(reloginView(null).lead + reloginView("x").lead, /过期|安全/);
  const r = code("pages/Relogin.tsx");
  assert.match(r, /reloginView\(p\.reason, teamGone \? p\.firm : null\)/);
  assert.match(r, /\[teamGone \? "" : p\.firm \? p\.firm : ""/, "账号卡不把刚离开的团队当身份");
  const sb = code("components/Sidebar.tsx");
  assert.match(sb, /leftNoticeText\(leftNote!, wsCur!\.name\)/);
  assert.match(sb, /localStorage\.removeItem\(LEFT_NOTICE_KEY\)/, "显示一次即清");
});
