/**
 * 交付件按“事项 → 一次任务”分组（v9.3 P2 / Astra M-3）：同一任务的成果成组列出，组按最新一份的先后；组名为场景卡名称 + 开始时刻；
 * 没有所属任务的归“其他（工作台生成、示例或手工登记）”。内核的成果列表带上任务的场景、方法模板与开始时刻（源码对照）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { groupByTask, taskCountText, taskGroupLabel } from "../src/lib/deliverables.ts";

test("同一任务成组、保持新的在前；没有任务的单独一组", () => {
  const rows = [
    { id: 1, run_id: "run_b", run_scenario: "a1.agent_task", run_skill: "contract-review", run_created_at: "2026-10-21T02:00:00Z", created_at: "2026-10-21T02:10:00Z" },
    { id: 2, run_id: "run_a", run_scenario: "s2.case_file", run_skill: null, run_created_at: "2026-10-20T02:00:00Z", created_at: "2026-10-20T02:05:00Z" },
    { id: 3, run_id: "run_b", run_scenario: "a1.agent_task", run_skill: "contract-review", run_created_at: "2026-10-21T02:00:00Z", created_at: "2026-10-21T02:09:00Z" },
    { id: 4, run_id: null, created_at: "2026-10-19T00:00:00Z" },
  ];
  const g = groupByTask(rows);
  assert.deepEqual(g.map((x) => [x.run_id, x.rows.map((r) => r.id)]), [["run_b", [1, 3]], ["run_a", [2]], [null, [4]]]);
  const fmt = (iso: string) => iso.slice(5, 16).replace("T", " ");
  assert.match(taskGroupLabel(g[0]!, fmt), /审.*合同.* · 10-21 02:00$/, "方法模板任务按场景卡名称");
  assert.match(taskGroupLabel(g[1]!, fmt), / · 10-20 02:00$/);
  assert.equal(taskGroupLabel(g[2]!, fmt), "其他（工作台生成、示例或手工登记）");
  assert.equal(taskGroupLabel({ run_id: "run_x", scenario: "unknown", skill: null, started_at: null }, fmt), "任务");
  assert.deepEqual(groupByTask([]), []);
});

test("交付件页与事项页都按任务分组；内核成果列表带任务的场景、方法模板与开始时刻", () => {
  const page = readFileSync(fileURLToPath(new URL("../src/pages/Deliverables.tsx", import.meta.url)), "utf8");
  assert.equal(page.split("groupByTask(").length - 1, 2, "交付件页与事项页“交付件”标签");
  assert.match(page, /看这次任务/);
  const kernel = readFileSync(fileURLToPath(new URL("../../../packages/kernel/src/api/index.ts", import.meta.url)), "utf8");
  assert.match(kernel, /r\.scenario AS run_scenario, json_extract\(.*'\$\.skill'\) AS run_skill, r\.created_at AS run_created_at/);
});

test("组头份数：筛选后只显示一部分时说清本次一共几份（复核 RB16B-11）", () => {
  assert.equal(taskCountText(1, 3), "本次 3 份，此处显示 1 份");
  assert.equal(taskCountText(2, 2), "2 份");
});
