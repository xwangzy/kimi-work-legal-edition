/**
 * Z3 §8.2 P2 余项：#16 卡片去掉逐张“试用”、#18 提醒说明按连接各一句、#19 问答示例整句、#20 数据去向顶边与律所名、
 * #21 执行页标题、#29 时间线措辞与左栏、#30 版本号显示，以及 I2 遗留的执行位置徽标。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { displayVersion } from "../src/lib/labels.ts";
import { reminderLine } from "../src/lib/reminders.ts";
import { buildSteps, mergeRepeatSteps, toolLabel } from "../src/lib/timeline.ts";
import { currentBadges } from "../src/lib/badges.ts";

const src = (p: string) => readFileSync(join(import.meta.dirname, "..", "src", p), "utf8");
const css = src("styles.css");

test("#16 首页场景卡不再逐张标“试用”，场景区标题旁统一一行", () => {
  const home = src("pages/Home.tsx");
  assert.doesNotMatch(home, /tag-beta">试用/);
  assert.match(home, /全部场景试用中 · 结果须律师复核/);
});

test("#17 设置里的分段选择选中态为黑底白字", () => {
  assert.match(css, /\.settings-choice \.q-option\.on[^{]*\{[^}]*background: var\(--btn-primary\)/);
});

test("#18 期限提醒说明：已连接与未连接各一句", () => {
  assert.equal(reminderLine(false), "到时在这台电脑上提醒；电脑关机时不会提醒。");
  assert.match(reminderLine(true), /电脑关机时也会送到/);
  assert.match(src("pages/Reminders.tsx"), /<summary>提醒是怎么送到的<\/summary>/);
});

test("#19 问答示例整句显示、居中、最多两行", () => {
  assert.match(css, /\.chip\.chat-example \{[^}]*white-space: normal[^}]*-webkit-line-clamp: 2/);
  assert.match(css, /\.chat-examples \{[^}]*align-items: center/);
});

test("#20 数据去向说明：顶边同一灰色由浅到深（不再有紫色），页头写律所名称而不是内部代号", () => {
  assert.doesNotMatch(css, /\.vis-[a-z]+ \{[^}]*status-purple/);
  assert.match(src("pages/Connections.tsx"), /firm=\{status\?\.firm_name \?\? null\}/);
});

test("#30 版本号：律师层显示“5.0.0”，内部构建标记只在诊断页", () => {
  assert.equal(displayVersion("5.0.0", "v5.0.0-g0"), "5.0.0");
  assert.equal(displayVersion(null, "v5.0.0-g0"), "5.0.0（开发版）");
  assert.equal(displayVersion(null, null), "—");
  assert.match(src("pages/Connections.tsx"), /版本标记/);
});

test("#21 执行页标题：只截前 30 个字，并允许折行", () => {
  assert.match(src("pages/RunView.tsx"), /goal\.length > 30 \? `\$\{goal\.slice\(0, 30\)\}…`/);
  assert.match(css, /\.exec-head \.page-title \{ white-space: normal;/);
});

test("#29 时间线：看目录与读原文合成“阅读材料”，风险卡提交合成“找出 n 处风险”；左栏不再有“在哪里处理”", () => {
  assert.equal(toolLabel("mcp__legal__materials_list"), "阅读材料");
  assert.equal(toolLabel("mcp__legal__materials_read_excerpt"), "阅读材料");
  let id = 0;
  const ev = (type: string, payload: any) => ({ event_id: ++id, seq: id, type, payload, created_at: "2026-10-21T10:00:00+08:00" }) as any;
  const events = [
    ev("agent.tool_started", { tool: "mcp__legal__materials_list", tool_call_id: "a" }),
    ev("agent.tool_result", { tool_call_id: "a" }),
    ev("agent.tool_started", { tool: "mcp__legal__materials_read_excerpt", tool_call_id: "b" }),
    ev("agent.tool_result", { tool_call_id: "b" }),
    ev("agent.tool_started", { tool: "mcp__legal__riskcards_submit", tool_call_id: "c" }),
    ev("agent.tool_result", { tool_call_id: "c" }),
    ev("agent.tool_started", { tool: "mcp__legal__riskcards_submit", tool_call_id: "d" }),
    ev("agent.tool_result", { tool_call_id: "d", is_error: true }),
  ];
  const merged = mergeRepeatSteps(buildSteps(events), 4).filter((s) => s.level === "lawyer");
  assert.deepEqual(merged.map((s) => [s.title, s.icon]), [["阅读材料", "ok"], ["找出 4 处风险", "fail"]]);
  assert.deepEqual(mergeRepeatSteps(buildSteps(events)).filter((s) => s.level === "lawyer").map((s) => s.title), ["阅读材料", "找出风险"], "没有总数时不编数字");
  assert.doesNotMatch(src("pages/RunView.tsx"), /pane-title">在哪里处理/);
});

test("I2 遗留：执行位置徽标不出现“运行时隔离（W）”", () => {
  const labels = currentBadges({ status: "running", openTools: ["Bash"], execOpen: false } as any).map((b) => b.label);
  assert.ok(!labels.some((l) => /（W）|运行时隔离/.test(l)), labels.join("、"));
});
