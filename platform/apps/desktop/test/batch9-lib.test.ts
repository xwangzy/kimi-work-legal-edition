/**
 * 第 9 批界面纯函数：用量与上限（S3）、中软侧操作记录（S14）的显示文字。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { auditDetailLabel, diagSectionLabels, auditActionLabel, auditActorLabel, auditFetchErrorText, auditResultLabel, auditTargetLabel, capRatio, periodLabel, quotaLawyerLine } from "../src/lib/firm-usage.ts";
import { SAVE_METHODS } from "../electron/file-dialogs.cjs";

const JARGON = /租约|lease|序号|seq|签名|哈希|hash|席位|控制面|token/i;

test("律师一句话：本人与本所用量、上限；到 80% 提示即将用完，到上限写明暂停；不出现租约、序号、签名、席位等工程用语", () => {
  const base = { mode: "control_plane" as const, period: "2026-10", period_used: 800, in_flight: 0, own: { points: 120, requests: 3 }, history: [] };
  const lines = [
    quotaLawyerLine({ ...base, cap_monthly: null }),
    quotaLawyerLine({ ...base, cap_monthly: 2000 }),
    quotaLawyerLine({ ...base, cap_monthly: 900 }),
    quotaLawyerLine({ ...base, cap_monthly: 800 }),
    quotaLawyerLine({ ...base, own: null, cap_monthly: null }),
    quotaLawyerLine({ mode: "local_dev" }),
    quotaLawyerLine(null),
  ];
  for (const l of lines) assert.doesNotMatch(l, JARGON, l);
  assert.match(lines[0]!, /你本月用了 120 点；本所 800 点（未设上限）/);
  assert.match(lines[1]!, /本所 800 \/ 2,000 点$/);
  assert.match(lines[2]!, /即将用完/);
  assert.match(lines[3]!, /已用完，AI 处理暂停/);
  assert.match(lines[4]!, /你本月还没有用量/);
  // 购买额度用完同样写明暂停（复核 S9A-13）
  const pool = quotaLawyerLine({ ...base, cap_monthly: null, paused: "pool" });
  assert.match(pool, /购买的 AI 额度已用完，AI 处理暂停/);
  assert.doesNotMatch(pool, JARGON);
});

test("上限比例只按已结算用量（网关预领的不算已用）；上限为 0 即满；不设上限为 null；月份写成中文", () => {
  assert.equal(capRatio({ mode: "control_plane", cap_monthly: 1000, period_used: 500, in_flight: 300 }), 0.5);
  assert.equal(capRatio({ mode: "control_plane", cap_monthly: 1000, period_used: 0, in_flight: 1000 }), 0, "刚预领、尚未使用不显示用完");
  assert.equal(capRatio({ mode: "control_plane", cap_monthly: 0, period_used: 0 }), 1);
  assert.equal(capRatio({ mode: "control_plane", cap_monthly: null, period_used: 10 }), null);
  assert.equal(capRatio({ mode: "control_plane", cap_monthly: 100, period_used: 500 }), 1);
  assert.equal(periodLabel("2026-03"), "2026 年 3 月");
  assert.equal(periodLabel(undefined), "本月");
});

test("操作记录：动作、执行者、对象、结果都有中文；未知动作原样显示；取回失败分“被改写/验不过”与“暂时取不到”", () => {
  assert.equal(auditDetailLabel({ cap: 5000 }), "上限 5,000 点");
  assert.equal(auditDetailLabel({ uncapped: 1 }), "不设上限");
  assert.equal(auditDetailLabel({ points: 1000 }), "1,000 点");
  assert.equal(auditDetailLabel({ seats: 5, points: 0 }), "席位 5、点数 0");
  assert.equal(auditDetailLabel(undefined), "");
  for (const a of ["seat.assign", "support_token.issue", "tenant.create", "tenant.enroll_root", "device.register", "seat_token.issue", "anon_summary.update", "draft.create", "draft.sign", "draft.publish", "connector.remove", "device.revoke", "seat.revoke", "quota.grant", "quota.cap_set", "license.renew", "license.terminate"]) {
    assert.doesNotMatch(auditActionLabel(a), /\./, a);
  }
  assert.equal(auditActionLabel("x.unknown"), "x.unknown");
  assert.equal(auditActorLabel({ actor: { kind: "device", id: "dev_firm_zhang" }, actor_name: "张律师" }), "张律师（设备 dev_firm_zhang）");
  assert.equal(auditActorLabel({ actor: { kind: "ops", id: "ops" }, actor_name: null }), "中软运营");
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
