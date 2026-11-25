/**
 * 第 9 批界面纯函数：用量与上限（S3）、中软侧操作记录（S14）的显示文字。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { auditDetailLabel, diagSectionLabels, auditActionLabel, auditActorLabel, auditFetchErrorText, auditResultLabel, auditTargetLabel, fmtPct, periodLabel, quotaLawyerLine, resetLabel, usageTone } from "../src/lib/firm-usage.ts";
import { SAVE_METHODS } from "../electron/file-dialogs.cjs";

const JARGON = /租约|lease|序号|seq|签名|哈希|hash|席位|控制面|token/i;

test("律师一句话（第 44 批 v2）：本人占分母（个人上限 / 每人额度）、本所占本期额度与上限、重置时刻；到上限 80% 提示即将用完，到上限或 100% 写明暂停；不出现点数与工程用语", () => {
  const firm = { used_ratio: 0.4, remaining_ratio: 0.6, in_flight_ratio: 0, paused: null, cap_pct: null, boost_pct: 0, legacy_used_ratio: null, used: null, total: null, seats: 3 };
  const own = { used_ratio: 0.3, denominator: "seat_quota" as const, enforced: false, used: 300, total: 1000, requests: 3, tokens: 300, value_cny: null, estimated_rows: 0 };
  const base = { mode: "control_plane" as const, unit: "tokens" as const, unit_label: "tokens", period: { kind: "month" as const, key: "2026-10", start: "2026-09-30T16:00:00.000Z", resets_at: "2026-10-31T16:00:00.000Z" }, firm, own, history: [] };
  const lines = [
    quotaLawyerLine({ ...base }),
    quotaLawyerLine({ ...base, firm: { ...firm, cap_pct: 90 } }),
    quotaLawyerLine({ ...base, firm: { ...firm, cap_pct: 45 } }),
    quotaLawyerLine({ ...base, firm: { ...firm, cap_pct: 40 } }),
    quotaLawyerLine({ ...base, own: null }),
    quotaLawyerLine({ mode: "local_dev" }),
    quotaLawyerLine(null),
  ];
  for (const l of lines) assert.doesNotMatch(l, JARGON, l);
  for (const l of lines) assert.doesNotMatch(l, /点|积分/, `不出现点数：${l}`);
  // 第 66 批（V40）：个人口径——“你已用 / 剩余”，不再出现“本所已用”；旧控制面（没有 personal）回退到 own 与本所剩余
  assert.equal(lines[0], "你本期已用 30%，剩余 60%；将于 11 月 1 日 0:00 重置");
  for (const l of lines) assert.doesNotMatch(l, /本所/, l);
  assert.match(lines[3]!, /已到设定的用量上限，AI 处理暂停/);
  assert.match(lines[4]!, /还没有用量/);
  // 有 personal 时按它（真正卡住你的那一项）：剩余 5% → 即将用完；暂停按 limited_by 说原因
  assert.equal(quotaLawyerLine({ ...base, personal: { used_ratio: 0.5, remaining_ratio: 0.05, limited_by: "burst", paused: null } }), "你本期已用 50%，剩余 5%；将于 11 月 1 日 0:00 重置；你的额度即将用完");
  assert.match(quotaLawyerLine({ ...base, personal: { used_ratio: 0.5, remaining_ratio: 0, limited_by: "burst", paused: "burst" } }), /最近 5 小时用得太快/);
  // 本期额度用完（100%）同样写明暂停（复核 S9A-13）
  const full = quotaLawyerLine({ ...base, firm: { ...firm, used_ratio: 1, paused: "allowance" } });
  assert.match(full, /AI 额度已用完，AI 处理暂停/);
  assert.doesNotMatch(full, JARGON);
});

test("百分比文字与水位：<0.1% 不写 0；10% 以下一位小数；上限按百分比折算水位；重置时刻与月份写成中文", () => {
  assert.equal(fmtPct(0), "0%");
  assert.equal(fmtPct(0.0004), "<0.1%");
  assert.equal(fmtPct(0.0123), "1.2%");
  assert.equal(fmtPct(0.05), "5%");
  assert.equal(fmtPct(0.456), "46%");
  assert.equal(fmtPct(1.2), "120%");
  assert.equal(fmtPct(undefined), "—");
  assert.equal(usageTone({ used_ratio: 0.5, cap_pct: null, paused: null }), "ok");
  assert.equal(usageTone({ used_ratio: 0.81, cap_pct: null, paused: null }), "high");
  assert.equal(usageTone({ used_ratio: 0.41, cap_pct: 50, paused: null }), "high", "上限 50% 的 80% 即偏高");
  assert.equal(usageTone({ used_ratio: 0.5, cap_pct: 50, paused: null }), "full");
  assert.equal(usageTone({ used_ratio: 0.1, cap_pct: null, paused: "allowance" }), "full");
  assert.equal(resetLabel("2026-11-30T16:00:00.000Z"), "将于 12 月 1 日 0:00 重置");
  assert.equal(periodLabel("2026-03"), "2026 年 3 月");
  assert.equal(periodLabel(undefined), "本期");
});

test("操作记录：动作、执行者、对象、结果都有中文；未知动作原样显示；取回失败分“被改写/验不过”与“暂时取不到”", () => {
  assert.equal(auditDetailLabel({ cap_pct: 80 }), "上限 80%");
  assert.equal(auditDetailLabel({ uncapped: 1 }), "不设上限");
  assert.equal(auditDetailLabel({ pct: 50 }), "本月额度 +50%");
  assert.equal(auditDetailLabel({ seats: 5 }), "席位 5");
  assert.equal(auditDetailLabel({ required: 1 }), "要求登录账号");
  // 第 39 批之前的流水带旧计量的数（不可改）：第 44 批起只写“改上限”“加量”，不再显示旧单位的数
  assert.equal(auditDetailLabel({ cap: 5000 }), "改上限");
  assert.equal(auditDetailLabel({ points: 2000 }), "加量");
  assert.equal(auditActionLabel("quota.grant"), "加量");
  assert.equal(auditDetailLabel({ seats: 5, points: 0 }), "席位 5");
  assert.equal(auditDetailLabel(undefined), "");
  for (const a of ["seat.assign", "support_token.issue", "tenant.create", "tenant.enroll_root", "device.register", "seat_token.issue", "anon_summary.update", "draft.create", "draft.sign", "draft.publish", "connector.remove", "device.revoke", "seat.revoke", "quota.grant", "quota.boost", "plan.change", "account.register", "account.login", "account.logout", "account.device_unbind", "quota.cap_set", "license.renew", "license.terminate"]) {
    assert.doesNotMatch(auditActionLabel(a), /\./, a);
  }
  assert.equal(auditActionLabel("x.unknown"), "x.unknown");
  assert.equal(auditActorLabel({ actor: { kind: "device", id: "dev_firm_zhang" }, actor_name: "张律师" }), "张律师（设备 dev_firm_zhang）");
  assert.equal(auditActorLabel({ actor: { kind: "ops", id: "ops" }, actor_name: null }), "中软运营");
  assert.equal(auditActorLabel({ actor: { kind: "ops", id: "op_0001" }, actor_name: null }), "中软运营（op_0001）", "运营按人鉴权（A-10）：记到具体的运营人员");
  assert.equal(auditActorLabel({ actor: { kind: "root", id: "ten_x" }, actor_name: null }), "律所根密钥（开通）");
  assert.equal(auditTargetLabel({ target: null, target_name: null }), "—");
  assert.match(auditTargetLabel({ target: "dev_firm_a_very_long_device_identifier", target_name: null }), /…/);
  assert.deepEqual(auditResultLabel("ok"), { text: "成功", tone: "ok" });
  assert.deepEqual(auditResultLabel("rejected:admin_required"), { text: "被拒绝（需要管理员设备）", tone: "bad" });
  assert.deepEqual(auditResultLabel("rejected:some_new_code"), { text: "被拒绝（some_new_code）", tone: "bad" }, "不认识的代码原样");
  assert.equal(auditResultLabel("rolled_back:state_persist_failed").tone, "warn");
  assert.match(auditFetchErrorText("cp_audit_rewritten"), /改写或删除.*本机留存的原记录不变/);
  assert.match(auditFetchErrorText("cp_unreachable"), /暂时取不到/);
});

test("诊断包分节写成中文：格式与时间不列，不认识的合并为“其他统计”", () => {
  const out = diagSectionLabels(["format", "created_at", "kernel", "runs_30d", "logs_7d", "x_new", "y_new"]);
  assert.deepEqual(out, ["后台服务状态", "近 30 天任务计数", "近 7 天运行记录（事件代码、时间与次数，最多 200 条）", "其他统计"]);
  for (const l of out) assert.doesNotMatch(l, /[a-z_]{3,}/);
});

test("导出操作记录经主进程一次性保存句柄（页面给的路径一律剥掉）", () => {
  assert.equal(SAVE_METHODS.get("control_plane.audit_export"), "save_path");
});
