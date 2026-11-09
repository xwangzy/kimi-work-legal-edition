/**
 * 第 9 批界面纯函数：用量与上限（S3）、中软侧操作记录（S14）的显示文字。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { auditDetailLabel, diagSectionLabels, auditActionLabel, auditActorLabel, auditFetchErrorText, auditResultLabel, auditTargetLabel, fmtPct, kimiAccountLabel, periodLabel, quotaLawyerLine, resetLabel, usageTone } from "../src/lib/firm-usage.ts";
import { SAVE_METHODS } from "../electron/file-dialogs.cjs";

const JARGON = /租约|lease|序号|seq|签名|哈希|hash|席位|控制面|token/i;

test("律师一句话（第 40 批：百分比）：本人占个人份额、本所占本月额度与上限、重置日；到上限 80% 提示即将用完，到上限或 100% 写明暂停；不出现点数与工程用语", () => {
  const base = { mode: "control_plane" as const, period: "2026-10", resets_at: "2026-10-31T16:00:00.000Z", used_ratio: 0.4, in_flight_ratio: 0, own: { used_ratio: 0.3, firm_ratio: 0.06, requests: 3 }, history: [] };
  const lines = [
    quotaLawyerLine({ ...base, cap_pct: null }),
    quotaLawyerLine({ ...base, cap_pct: 90 }),
    quotaLawyerLine({ ...base, cap_pct: 45 }),
    quotaLawyerLine({ ...base, cap_pct: 40 }),
    quotaLawyerLine({ ...base, own: null, cap_pct: null }),
    quotaLawyerLine({ mode: "local_dev" }),
    quotaLawyerLine(null),
  ];
  for (const l of lines) assert.doesNotMatch(l, JARGON, l);
  for (const l of lines) assert.doesNotMatch(l, /点/, `不再出现点数：${l}`);
  assert.equal(lines[0], "你本月已用个人份额的 30%；本所已用 40%；11 月 1 日重置");
  assert.match(lines[1]!, /本所已用 40%（上限 90%）；11 月 1 日重置$/);
  assert.match(lines[2]!, /即将用完/);
  assert.match(lines[3]!, /已到律所设的上限，AI 处理暂停/);
  assert.match(lines[4]!, /你本月还没有用量/);
  // 本月额度用完（100%）同样写明暂停（复核 S9A-13）
  const full = quotaLawyerLine({ ...base, used_ratio: 1, cap_pct: null, paused: "allowance" });
  assert.match(full, /本月 AI 额度已用完，AI 处理暂停/);
  assert.doesNotMatch(full, JARGON);
});

test("百分比文字与水位：<0.1% 不写 0；10% 以下一位小数；上限按百分比折算水位；重置日与月份写成中文", () => {
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
  assert.equal(resetLabel("2026-11-30T16:00:00.000Z"), "12 月 1 日重置");
  assert.equal(kimiAccountLabel({ nickname: "张**", phone_tail: "0000" }), "张**（尾号 0000）");
  assert.equal(kimiAccountLabel(null), "未绑定");
  assert.equal(periodLabel("2026-03"), "2026 年 3 月");
  assert.equal(periodLabel(undefined), "本月");
});

test("操作记录：动作、执行者、对象、结果都有中文；未知动作原样显示；取回失败分“被改写/验不过”与“暂时取不到”", () => {
  assert.equal(auditDetailLabel({ cap_pct: 80 }), "上限 80%");
  assert.equal(auditDetailLabel({ uncapped: 1 }), "不设上限");
  assert.equal(auditDetailLabel({ pct: 50 }), "本月额度 +50%");
  assert.equal(auditDetailLabel({ seats: 5 }), "席位 5");
  assert.equal(auditDetailLabel({ required: 1 }), "要求用 Kimi 账号登录");
  // 第 39 批之前的流水是点数（不可改），照原样标“旧版计量”
  assert.equal(auditDetailLabel({ cap: 5000 }), "上限 5,000（旧版计量）");
  assert.equal(auditDetailLabel({ seats: 5, points: 0 }), "席位 5");
  assert.equal(auditDetailLabel(undefined), "");
  for (const a of ["seat.assign", "support_token.issue", "tenant.create", "tenant.enroll_root", "device.register", "seat_token.issue", "anon_summary.update", "draft.create", "draft.sign", "draft.publish", "connector.remove", "device.revoke", "seat.revoke", "quota.grant", "quota.boost", "plan.change", "kimi.policy", "kimi.bind", "kimi.unbind", "quota.cap_set", "license.renew", "license.terminate"]) {
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
