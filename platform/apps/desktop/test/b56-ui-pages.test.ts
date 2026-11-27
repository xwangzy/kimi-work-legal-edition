/**
 * 第 56 批四页精修的纯函数：期限提醒（日程分组、日历叶、标题去重、倒计时胶囊、提醒安排人话、小月历）、
 * 备份与安全（一条状态 + 纵向三步）、操作记录（一句话记录、界面不含编号、筛选分档）、技术支持（运行状态来自真实数据）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { agendaGroups, bjToday, countPill, dayMarks, entryTitle, leafParts, monthGrid, monthsFrom, scheduleHuman } from "../src/lib/reminders.ts";
import { auditFilter, auditResultShort, auditSentence, auditTime, auditWho, type AuditRowLike } from "../src/lib/firm-usage.ts";
import { backupPlan } from "../src/lib/device-status.ts";
import { supportChecks, supportSummary } from "../src/lib/support-status.ts";

const src = (p: string) => readFileSync(fileURLToPath(new URL(`../src/${p}`, import.meta.url)), "utf8");
// 2026-11-22 是周日；北京时间中午
const NOW = Date.parse("2026-11-22T04:00:00Z");

test("小月历：周一开头、每月首日星期正确、跨月跨年", () => {
  const nov = monthGrid(2026, 11);
  assert.equal(nov.label, "2026 年 11 月");
  // 11 月 1 日是周日：前面补 6 格
  assert.deepEqual(nov.weeks[0]!.slice(0, 6), [null, null, null, null, null, null]);
  assert.equal(nov.weeks[0]![6]!.date, "2026-11-01");
  assert.equal(nov.weeks.flat().filter(Boolean).length, 30);
  assert.ok(nov.weeks.every((w) => w.length === 7));
  // 2027 年 2 月 1 日是周一：不补格；28 天正好 4 行
  const feb = monthGrid(2027, 2);
  assert.equal(feb.weeks[0]![0]!.date, "2027-02-01");
  assert.equal(feb.weeks.length, 4);
  // 2026 年 12 月 1 日是周二：补 1 格
  assert.equal(monthGrid(2026, 12).weeks[0]![0], null);
  assert.equal(monthGrid(2026, 12).weeks[0]![1]!.day, 1);
  // 闰年 2028 年 2 月有 29 天
  assert.equal(monthGrid(2028, 2).weeks.flat().filter(Boolean).length, 29);
  assert.deepEqual(monthsFrom("2026-11-22"), [{ year: 2026, month: 11 }, { year: 2026, month: 12 }]);
  assert.deepEqual(monthsFrom("2026-12-05"), [{ year: 2026, month: 12 }, { year: 2027, month: 1 }], "12 月的下月是次年 1 月");
});

test("北京时间的“今天”：UTC 前一天 16:30 已是北京次日", () => {
  assert.equal(bjToday(Date.parse("2026-11-21T16:30:00Z")), "2026-11-22");
  assert.equal(bjToday(Date.parse("2026-11-21T15:59:00Z")), "2026-11-21");
});

test("日程分组：已过期 / 本周（今天起 7 天，跨月也算）/ 本月 / 以后；空组不返回", () => {
  const list = ["2026-11-20", "2026-11-22", "2026-11-24", "2026-11-29", "2026-11-30", "2026-12-08", "2027-01-15"].map((d) => ({ due_date: d }));
  const g = agendaGroups(list, NOW);
  assert.deepEqual(g.map((x) => [x.label, x.items.map((i) => i.due_date)]), [
    ["已过期", ["2026-11-20"]],
    ["本周", ["2026-11-22", "2026-11-24", "2026-11-29"]],
    ["本月", ["2026-11-30"]],
    ["以后", ["2026-12-08", "2027-01-15"]],
  ]);
  // 月底看：12 月 3 日在 7 天内，归“本周”而不是“以后”
  const end = Date.parse("2026-11-28T04:00:00Z");
  assert.equal(agendaGroups([{ due_date: "2026-12-03" }], end)[0]!.key, "week");
  assert.deepEqual(agendaGroups([], NOW), []);
  assert.deepEqual(agendaGroups([{ due_date: "2026-11-24", cloud_state: "cancelled" }], NOW), [], "已撤销的不列");
});

test("日历叶：今年写“11月”，跨年写“2027 · 1月”；周几", () => {
  assert.deepEqual(leafParts("2026-11-24", NOW), { top: "11月", day: "24", week: "周二" });
  assert.deepEqual(leafParts("2027-01-15", NOW), { top: "2027 · 1月", day: "15", week: "周五" });
});

test("标题去重：备注以类型开头时不重复类型", () => {
  assert.equal(entryTitle("hearing", "开庭：朝阳法院第 12 法庭"), "开庭 · 朝阳法院第 12 法庭");
  assert.equal(entryTitle("hearing", "朝阳法院第 12 法庭"), "开庭 · 朝阳法院第 12 法庭");
  assert.equal(entryTitle("evidence", "举证期限届满"), "举证期限届满");
  assert.equal(entryTitle("appeal", "上诉期届满"), "上诉期届满", "以类型词干开头");
  assert.equal(entryTitle("other", "申请执行时效提醒"), "其他期限 · 申请执行时效提醒");
  assert.equal(entryTitle("hearing", ""), "开庭");
  assert.equal(entryTitle("hearing", "开庭"), "开庭");
  assert.doesNotMatch(entryTitle("hearing", "开庭：朝阳法院"), /开庭.*开庭/);
});

test("倒计时胶囊：今天、明天、3 天内红、7 天内橙、其余中性灰、已过 n 天", () => {
  assert.deepEqual(countPill("2026-11-22", NOW), { text: "今天", tone: "red" });
  assert.deepEqual(countPill("2026-11-23", NOW), { text: "明天", tone: "red" });
  assert.deepEqual(countPill("2026-11-24", NOW), { text: "还有 2 天", tone: "red" });
  assert.deepEqual(countPill("2026-11-27", NOW), { text: "还有 5 天", tone: "orange" });
  assert.deepEqual(countPill("2026-12-08", NOW), { text: "还有 16 天", tone: "neutral" });
  assert.deepEqual(countPill("2026-11-19", NOW), { text: "已过 3 天", tone: "past" });
});

test("提醒安排写成人话：提前 3 天 9:00 提醒 / 已提醒 / 已提醒（设置时已不足 3 天）", () => {
  const base = { due_date: "2026-12-08", days_before: 3, remind_time: "09:00" };
  assert.equal(scheduleHuman({ ...base, remind_at: "2026-12-05T01:00:00.000Z" }, NOW), "提前 3 天 9:00 提醒");
  assert.equal(scheduleHuman({ ...base, days_before: 0, remind_at: "2026-12-08T01:00:00.000Z" }, NOW), "当天 9:00 提醒");
  // 期限临近：设好时已过“提前 3 天 9 点”，内核改为立即提醒
  assert.equal(scheduleHuman({ due_date: "2026-11-24", days_before: 3, remind_time: "09:00", remind_at: "2026-11-22T00:03:00.000Z" }, NOW), "已提醒（设置时已不足 3 天）");
  assert.equal(scheduleHuman({ ...base, remind_at: "2026-12-05T01:00:00.000Z", fired: true }, NOW), "已提醒");
  assert.equal(scheduleHuman({ due_date: "2026-11-23", days_before: 1, remind_time: "09:00", remind_at: "2026-11-22T01:00:00.000Z" }, NOW), "已提醒", "到点已过");
  assert.doesNotMatch(scheduleHuman({ ...base, remind_at: "2026-12-05T01:00:00.000Z" }, NOW), /（\d+月/, "不再在括号里重复提醒时刻");
});

test("月历上的点：同一天取最近的一档", () => {
  const m = dayMarks([{ due_date: "2026-11-24" }, { due_date: "2026-11-27" }, { due_date: "2026-12-08" }, { due_date: "2026-11-20" }], NOW);
  assert.equal(m.get("2026-11-24"), "red");
  assert.equal(m.get("2026-11-27"), "orange");
  assert.equal(m.get("2026-12-08"), "plain");
  assert.equal(m.get("2026-11-20"), "past");
});

test("期限提醒页：两栏（日程 + 月历）、功能一个不少", () => {
  const page = src("pages/Reminders.tsx");
  for (const s of ["从事项导入", "设提醒", "api.computeDeadline", "用这个日期", "提醒谁", "cloudStateText(", "onRetry(r!.reminder_id)", "撤销提醒", "全部标为已读", "知道了"]) assert.ok(page.includes(s), s);
  assert.match(page, /<aside className="rm-aside" aria-label="月历">/);
  assert.match(page, /monthsFrom\(bjToday\(\)\)/);
  assert.match(page, /scrollIntoView/);
});

// ─── 操作记录 ───

const row = (action: string, o: Partial<AuditRowLike> = {}): AuditRowLike => ({ actor: { kind: "device", id: "dev_b56-firm_admin" }, actor_name: "王主任", action, target: null, target_name: null, result: "ok", ...o });
/** 控制面会记进律所审计的操作全集（services/control-plane/src/server.ts 里的 OPS_AUDIT、mark(…)、accountMark、auditCtx 入口逐一核对）+ 本机相关。 */
const ALL_ACTIONS = [
  "tenant.create", "tenant.enroll_root", "tenant.read", "tenant.usage",
  "activation.issue", "activation.revoke", "activation.redeem",
  "device.register", "device.revoke", "account.device_unbind",
  "seat.assign", "seat.revoke", "seat_token.issue", "support_token.issue", "notify_token.issue", "relay_token.issue",
  "anon_summary.update", "invitation.create", "invitation.revoke", "join.request", "join.withdraw", "join.approve", "join.reject",
  "account.create", "account.register", "account.read", "account.disable", "account.enable", "account.limits", "account.reset_code", "account.sessions_revoke", "account.session_revoke",
  "account.login", "account.logout", "account.password_change", "account.password_reset", "account.password_setup",
  "accounts.policy", "quota.cap_set", "quota.boost", "quota.grant", "plan.change", "license.renew", "license.terminate",
  "draft.create", "draft.sign", "draft.publish", "connector.remove",
];

test("一句话记录：全部操作都有人话，界面文本不含任何内部编号", () => {
  const ID = /(dev|seat|acc|stf|ses|usr|ten|act|jr|inv)_[A-Za-z0-9-]|[A-Za-z0-9]{12,}/;
  for (const a of ALL_ACTIONS) {
    for (const kind of ["device", "ops", "root", "account", "claimant", "service"] as const) {
      const r = row(a, { actor: { kind, id: kind === "ops" ? "stf_f8LEabcdefT0spZB" : "acc_zfCeakIuv0CDFQSt" }, actor_name: kind === "device" ? "王主任" : null, target: "seat_ten_b56-firm_1" });
      const s = auditSentence(r);
      assert.ok(s.known, a);
      assert.notEqual(s.what, "做了一项操作", a);
      assert.doesNotMatch(`${s.who} ${s.what}`, ID, `${a}/${kind}：${s.who} ${s.what}`);
      assert.doesNotMatch(s.what, /\./, a);
    }
  }
  // 第 72 批评分 C10：不认识的动作写出原始事件名，不再笼统写“做了一项操作”
  assert.deepEqual(auditSentence(row("x.unknown")), { who: "王主任", what: "执行了“x.unknown”", important: true, known: false });
});

test("“谁”：成员姓名 / 本所成员 / 本所（开通时）/ Kimi Work 运营人员（不显示工号）/ 系统", () => {
  assert.equal(auditWho({ actor: { kind: "device", id: "dev_x" }, actor_name: "王主任" }), "王主任");
  // 第 72 批评分 C10：解析不到姓名时写编号后 4 位（同一个人的几条记录能对得上），不再笼统写“本所成员”
  assert.equal(auditWho({ actor: { kind: "device", id: "dev_x1a2b" }, actor_name: null }), "成员（编号 1a2b）");
  assert.equal(auditWho({ actor: { kind: "account", id: "acc_9z8y7x" }, actor_name: null }), "成员（编号 8y7x）");
  // 第 72 批（设计评分第四轮）：律所根那一条写成人话
  assert.equal(auditWho({ actor: { kind: "root", id: "ten_x" }, actor_name: null }), "开通团队时");
  assert.equal(auditWho({ actor: { kind: "ops", id: "stf_f8LE…T0spZB" }, actor_name: null }), "Kimi Work 运营人员");
  assert.equal(auditWho({ actor: { kind: "service", id: "x" }, actor_name: null }), "系统");
});

test("对象融进句子：××的电脑 / 第 2 台电脑 / ××的席位 / ××的账号 / 解析不到的通用说法；detail 里的数值", () => {
  assert.equal(auditSentence(row("tenant.create", { actor: { kind: "ops", id: "ops" }, actor_name: null, detail: { seats: 5 } })).what, "开通本所（5 个席位）");
  assert.equal(auditSentence(row("quota.cap_set", { detail: { cap_pct: 80 } })).what, "把本所用量上限设为 80%");
  assert.equal(auditSentence(row("quota.cap_set", { detail: { uncapped: 1 } })).what, "取消了本所用量上限");
  assert.equal(auditSentence(row("quota.boost", { detail: { pct: 20 } })).what, "给本所本期加量 20%");
  assert.equal(auditSentence(row("plan.change", { detail: { seats: 8 } })).what, "把本所席位调整为 8 个");
  assert.equal(auditSentence(row("license.renew", { detail: { days: 365 } })).what, "给本所续订 365 天");
  assert.equal(auditSentence(row("accounts.policy", { detail: { required: 1 } })).what, "要求成员必须登录账号才能使用");
  assert.equal(auditSentence(row("device.register", { target: "dev_a", target_name: "王主任", target_ordinal: { n: 1, of: 1 } })).what, "登记了一台电脑");
  assert.equal(auditSentence(row("device.register", { target: "dev_b", target_name: "王主任", target_ordinal: { n: 2, of: 2 } })).what, "登记了第 2 台电脑");
  assert.equal(auditSentence(row("device.revoke", { target: "dev_b", target_name: "李律师", target_ordinal: { n: 1, of: 1 } })).what, "停用了李律师的电脑");
  assert.equal(auditSentence(row("device.revoke", { target: "dev_b", target_name: "李律师", target_ordinal: { n: 2, of: 3 } })).what, "停用了李律师的第 2 台电脑");
  assert.equal(auditSentence(row("device.revoke", { target: "dev_z" })).what, "停用了一台电脑");
  assert.equal(auditSentence(row("seat.assign", { target: "seat_1", target_name: "王主任" })).what, "领取了一个席位", "给自己分配");
  assert.equal(auditSentence(row("seat.assign", { target: "seat_1", target_name: "李律师" })).what, "给李律师分配了席位");
  // 第 72 批：席位动作统一叫“释放”
  assert.equal(auditSentence(row("seat.revoke", { target: "seat_1" })).what, "释放了一个席位");
  assert.equal(auditSentence(row("account.disable", { actor: { kind: "ops", id: "stf_1" }, actor_name: null, target: "acc_1", target_name: "李律师" })).what, "停用了李律师的账号");
  // 第 72 批评分 C10：账号对象解析不到姓名时写编号后 4 位，不再笼统写“一个成员账号”；没有对象编号时仍是通用说法
  assert.equal(auditSentence(row("account.disable", { target: "acc_1" })).what, "停用了成员（编号 acc1）的账号");
  assert.equal(auditSentence(row("account.disable", { target: null })).what, "停用了一个成员账号");
  assert.equal(auditSentence(row("account.limits", { target: "acc_1" })).what, "调整了成员（编号 acc1）的个人上限或电脑数");
});

test("筛选分档：重要改动（默认）不含日常凭据与摘要；运营人员的一切操作都算重要；失败的两档都列", () => {
  const rows = [
    row("seat_token.issue"),
    row("anon_summary.update"),
    row("account.login"),
    row("device.register"),
    row("tenant.read", { actor: { kind: "ops", id: "stf_1" }, actor_name: null }),
    row("seat_token.issue", { result: "denied:no_seat" }),
  ];
  const imp = auditFilter(rows, "important");
  assert.deepEqual(imp.rows.map((r) => `${r.action}/${r.result}`), ["device.register/ok", "tenant.read/ok", "seat_token.issue/denied:no_seat"]);
  assert.deepEqual(imp.counts, { important: 3, all: 6 });
  assert.equal(auditFilter(rows, "all").rows.length, 6);
  assert.equal(auditSentence(row("seat_token.issue", { actor: { kind: "ops", id: "x" } })).important, true, "运营人员的操作一律重要");
});

test("时间：北京时间“11 月 22 日 08:02”，今年不写年", () => {
  assert.equal(auditTime("2026-11-22T00:02:17.049Z", NOW), "11 月 22 日 08:02");
  assert.equal(auditTime("2025-12-31T16:30:00Z", NOW), "1 月 1 日 00:30", "北京已是 2026 年，今年不写年");
  assert.equal(auditTime("2025-06-01T00:00:00Z", NOW), "2025 年 6 月 1 日 08:00");
});

test("操作记录页：列是 时间 | 谁 | 做了什么 | 结果；详情给 IT（操作代码、对象编号、设备编号、序号）；取回最新、导出全部保留", () => {
  const page = src("pages/FirmUsage.tsx");
  for (const s of ["时间", "谁", "做了什么", "结果", "操作代码", "对象编号", "设备编号", "序号", "取回最新", "导出全部", "重要改动", "全部"]) assert.ok(page.includes(s), s);
  assert.doesNotMatch(page, /auditActorLabel\(r\)|auditTargetLabel\(r\)/, "界面不再显示带编号的执行者 / 对象");
  // 内核：姓名与成员名册同源（displayNameOf），字段向后兼容地扩充
  const kernel = readFileSync(fileURLToPath(new URL("../../../packages/kernel/src/api/index.ts", import.meta.url)), "utf8");
  const seg = kernel.slice(kernel.indexOf('"control_plane.audit": async'), kernel.indexOf('"control_plane.audit_export"'));
  assert.match(seg, /displayNameOf\(memberId, null\)/);
  assert.match(seg, /target_kind, target_is_me, target_ordinal/);
  assert.doesNotMatch(seg, /"你的席位"/);
});

// ─── 备份与安全 ───

test("备份：一条状态 + 纵向三步（当前一步 now、做完 done、没轮到 todo）", () => {
  const none = backupPlan({ packages_created: 0, configured: false }, NOW);
  assert.equal(none.tone, "warn");
  assert.equal(none.headline, "还没有备份");
  assert.match(none.consequence, /无法找回/);
  assert.deepEqual(none.action, { kind: "create", label: "生成恢复包" });
  assert.deepEqual(none.steps.map((s) => s.state), ["now", "todo", "todo"]);

  const created = backupPlan({ packages_created: 1, packages_verified: 0, latest_package_verified: false, recent_packages: ["2026-11-22T01:00:00Z"], configured: false }, NOW);
  assert.equal(created.action?.kind, "verify");
  assert.deepEqual(created.steps.map((s) => s.state), ["done", "now", "todo"]);
  assert.equal(created.steps[0]!.summary, "已生成 · 11 月 22 日");

  const verified = backupPlan({ packages_created: 1, latest_package_verified: true, configured: false }, NOW);
  assert.equal(verified.action?.kind, "folder");
  assert.equal(verified.headline, "还没开每天自动备份");

  const ok = backupPlan({ packages_created: 1, latest_package_verified: true, configured: true, last_ok_at: "2026-11-21T01:00:00Z", stale_days: 1 }, NOW);
  assert.equal(ok.tone, "ok");
  assert.equal(ok.headline, "备份正常 · 上次自动备份 11 月 21 日 09:00");
  assert.equal(ok.action, null);
  assert.deepEqual(ok.steps.map((s) => s.state), ["done", "done", "done"]);

  const stale = backupPlan({ packages_created: 1, latest_package_verified: true, configured: true, last_ok_at: "2026-11-17T01:00:00Z", stale_days: 5 }, NOW);
  assert.equal(stale.tone, "warn");
  assert.equal(stale.action?.kind, "run");
  assert.match(stale.headline, /5 天没有成功/);

  assert.equal(backupPlan({ packages_created: 1, revoked: true }, NOW).tone, "bad");
  assert.equal(backupPlan(null).tone, "info");
});

test("备份与安全页：状态 + 三步 + “遇到问题时”两行；功能一个不少", () => {
  const page = src("pages/Connections.tsx");
  const comp = src("components/RecoveryBackup.tsx");
  assert.match(page, /<BackupTrack safe=\{safe\} \/>/);
  assert.match(page, /遇到问题时/);
  assert.match(page, /<ConnectionCheck \/>/);
  for (const s of ["生成恢复包", "试着恢复一次", "每天自动备份", "恢复包和恢复码要分开放", "选择备份位置", "立即备份", "先完成上一步", "重新生成"]) assert.ok(comp.includes(s), s);
  assert.doesNotMatch(page, /status-tiles status-tiles-2/, "不再有两张等大的状态卡");
  // 首次引导（Welcome）仍用三格呈现
  assert.match(src("pages/Welcome.tsx"), /<RecoveryBackup /);
});

// ─── 技术支持 ───

const CAPS = {
  customer_rows: [
    { feature: "AI 起草、审查与问答", status: "未知", note: "" },
    { feature: "读写本事项的材料与草稿", status: "可用", note: "" },
    { feature: "联网检索", status: "可用", note: "" },
    { feature: "打开网页", status: "可用", note: "" },
    { feature: "操作网页与电脑", status: "本版本没有", note: "" },
  ],
  execution_domain: { available: null, label: "", status: "未知", detail: "" },
  sole_exit: "",
  gate: { running: true, routes: { search: true, fetch: true }, search_configured: true, fetch: "local" },
  rows: [],
} as never;
const GATE = { running: true, routes: { search: true, fetch: true } };
const diag = (tone: "ok" | "error", modelClass = "ok") =>
  ({
    checked_at: "2026-11-22T00:10:21.431Z",
    gate: "running",
    tone,
    conclusion: tone === "ok" ? "连接正常" : "连接云端的证书校验未通过（AI 服务）",
    rows: [
      { upstream: "control_plane", name: "账号与授权", class: "ok", label: "正常", host: "h", port: 1, elapsed_ms: 2, detail: null, pins: [], presented: [], cloud_ca: false },
      { upstream: "model", name: "AI 服务", class: modelClass, label: modelClass === "ok" ? "正常" : "证书公钥与安装包内置的不符", host: "h", port: 2, elapsed_ms: 2, detail: null, pins: [], presented: [], cloud_ca: false },
      { upstream: "support", name: "技术支持", class: "not_configured", label: "未配置", host: null, port: null, elapsed_ms: 0, detail: null, pins: [], presented: [], cloud_ca: false },
    ],
  }) as never;

test("运行状态：没检测过写“尚未检测”（不写“未知”、不写死“正常”）；检测后逐行更新；有问题给“怎么办”", () => {
  const before = supportChecks({ caps: CAPS, gate: GATE, diag: null });
  const by = (rs: typeof before, k: string) => rs.find((r) => r.key === k)!;
  assert.equal(by(before, "service").state, "尚未检测");
  assert.equal(by(before, "service").tone, "idle");
  assert.equal(by(before, "ai").state, "尚未检测");
  assert.equal(by(before, "exec").state, "尚未检测");
  assert.equal(by(before, "files").state, "正常");
  assert.equal(before.at(-1)!.state, "本版本没有");
  assert.ok(before.every((r) => r.state !== "未知"));
  assert.equal(supportSummary(before), "3 项正常，3 项尚未检测");

  const after = supportChecks({ caps: CAPS, gate: GATE, diag: diag("ok") });
  assert.equal(by(after, "service").state, "正常");
  assert.equal(by(after, "ai").state, "正常");

  const bad = supportChecks({ caps: CAPS, gate: GATE, diag: diag("error", "tls_pin_mismatch") });
  assert.equal(by(bad, "service").tone, "bad");
  assert.ok(by(bad, "service").fix);
  assert.equal(by(bad, "ai").tone, "bad");
  assert.equal(supportSummary(bad), "2 项有问题");

  const noGate = supportChecks({ caps: CAPS, gate: null, diag: null });
  assert.equal(by(noGate, "ai").state, "未开通");
  assert.equal(by(noGate, "search").state, "未开通");
  const exec = supportChecks({ caps: { ...(CAPS as object), execution_domain: { available: false, label: "", status: "", detail: "" } } as never, gate: GATE, diag: null });
  assert.equal(by(exec, "exec").state, "不可用");
  assert.ok(by(exec, "exec").fix);
});

test("技术支持页：三节（运行状态 / 联系支持前 / 给 IT 的技术信息），两个折叠原样在最后", () => {
  const page = src("pages/Connections.tsx");
  const i1 = page.indexOf(">\n            运行状态");
  const i2 = page.indexOf("联系支持前</h2>");
  const i3 = page.indexOf("给 IT 的技术信息</h2>");
  assert.ok(i1 > 0 && i2 > i1 && i3 > i2, "三节顺序");
  for (const s of ["立即检测", "导出诊断信息", "开启 24 小时", "复制版本信息", "技术信息（给 IT）", "加密保存的局限（给 IT）", "没能确认是否发出的内容"]) assert.ok(page.includes(s), s);
  assert.ok(page.indexOf("加密保存的局限（给 IT）") > i3);
  assert.doesNotMatch(page, /本机功能一览<\/div>/, "不再是一张写“未知”的功能表");
});

test("结果列只写“成功 / 被拒绝 / 未生效”，原因写人话、不认得的不显示（代码只在详情）", () => {
  assert.deepEqual(auditResultShort("ok"), { text: "成功", why: null, tone: "ok" });
  assert.deepEqual(auditResultShort("denied:session_member_mismatch"), { text: "被拒绝", why: "登录的账号与这台电脑的成员不符", tone: "bad" });
  assert.deepEqual(auditResultShort("rolled_back:state_persist_failed"), { text: "未生效", why: "写盘失败", tone: "warn" });
  assert.deepEqual(auditResultShort("denied:some_new_code"), { text: "被拒绝", why: null, tone: "bad" });
});
