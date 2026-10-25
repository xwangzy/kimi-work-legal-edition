/**
 * 第 7 批界面纯函数：执行页步骤时刻（Y4 R-12）与子任务折叠（Y4 #33）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fmtShortTime, stepTime } from "../src/lib/labels.ts";
import { buildSteps, groupSubtaskSteps, keyStepKeys, type Step } from "../src/lib/timeline.ts";

test("R-12 步骤时刻：律师层相对时间、处理细节时分秒，悬停完整时间；时间不再拼进说明文字", () => {
  const now = Date.parse("2026-10-15T10:00:00+08:00");
  const at = "2026-10-15T09:58:00+08:00";
  const lawyer = stepTime(at, "lawyer", now)!;
  assert.equal(lawyer.text, "2 分钟前");
  assert.match(lawyer.title, /2026/);
  assert.equal(stepTime(at, "detail", now)!.text, fmtShortTime(at), "处理细节：本地时区的时分秒（不依赖测试机时区，复核 S7B-11）");
  assert.equal(stepTime("2026-10-15T09:59:40+08:00", "lawyer", now)!.text, "刚刚");
  assert.equal(stepTime(undefined, "lawyer", now), null);
  assert.equal(stepTime("不是时间", "lawyer", now), null);
  const steps = buildSteps([
    { event_id: 1, seq: 1, type: "run.started", payload: {}, created_at: at },
    { event_id: 2, seq: 2, type: "agent.started", payload: { mode: "default", data_level: "L2" }, created_at: at },
  ] as never);
  assert.equal(steps[0]!.at, at);
  // 第 27 批（评审 U3-02）：处理细节不再写“数据级别 L2”，做法与输入框胶囊同名
  assert.equal(steps[1]!.title, "做法：直接做");
  assert.equal(steps[1]!.meta, undefined, "说明文字里没有时分秒，也没有数据级别");
  assert.ok(steps.every((s) => !/\d{1,2}:\d{2}:\d{2}/.test(s.meta ?? "")));
});

test("#33 子任务折叠（复核 S7B-05）：同一子任务的步骤归为一组（交错也归到一起），只有一步的不成组，联网步骤不折叠，按出现顺序称子任务 1、2", () => {
  const st = (key: string, agent?: string, icon: Step["icon"] = "ok", title = `步骤 ${key}`): Step => ({ key, level: "lawyer", icon, title, ...(agent ? { agent } : {}) });
  const items = groupSubtaskSteps([st("1"), st("2", "ag_x"), st("3", "ag_y", "wait"), st("4", "ag_x", "fail"), st("5", "ag_x", "ok", "联网查资料"), st("6"), st("7", "ag_x"), st("8", "ag_z")]);
  const view = items.map((i) => (i.kind === "step" ? `${i.label ? `${i.label}/` : ""}${i.step.key}` : `${i.label}:${i.steps.map((s) => s.key).join(",")}`));
  assert.deepEqual(view, ["1", "子任务 1:2,4,7", "子任务 2/3", "子任务 1/5", "6", "子任务 3/8"]);
  const g = items[1]!;
  assert.ok(g.kind === "sub" && g.failed && g.done, "组内有失败即标失败；没有在等待的步骤即已结束");
  assert.ok(!JSON.stringify(items.map((i) => (i.kind === "sub" ? i.label : i.label ?? ""))).includes("ag_"), "不显示引擎内部编号");
  const running = groupSubtaskSteps([st("a", "ag_q"), st("b", "ag_q", "wait")])[0]!;
  assert.ok(running.kind === "sub" && !running.done && !running.failed);
});

test("R-12 关键步骤（复核 S7B-06）：律师层只有第一步、最后一步、等你处理和没有完成的步骤显示时刻", () => {
  const st = (key: string, icon: Step["icon"] = "ok", level: Step["level"] = "lawyer"): Step => ({ key, level, icon, title: key });
  assert.deepEqual([...keyStepKeys([st("d1", "ok", "detail"), st("a"), st("b"), st("c", "wait"), st("e", "fail"), st("f"), st("g")])].sort(), ["a", "c", "e", "g"]);
});
