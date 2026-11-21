/**
 * 第 55 批 K4（审计 B 2.3）：任务状态集合只有一份权威表（packages/domain/src/states.ts）。渲染层不引用 domain 包，
 * 桌面端 labels.ts 保留的一份须与它逐项相等；徽标与任务页各自对 reconciling 的处理在这里一并固定。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NEEDS_LAWYER_RUN_STATUSES, SETTLED_RUN_STATUSES, TERMINAL_RUN_STATUSES, isSettledRun, isTerminalRun, needsLawyerRun } from "../../../packages/domain/src/states.ts";
import { RUN_NEEDS_LAWYER_STATUSES, RUN_TERMINAL_STATUSES, TERMINAL_STATUSES } from "../src/lib/labels.ts";
import { currentBadges } from "../src/lib/badges.ts";

const sorted = (xs: readonly string[]) => [...xs].sort();

test("桌面端的状态集合与 domain 权威表逐项相等", () => {
  assert.deepEqual(sorted(RUN_TERMINAL_STATUSES), sorted(TERMINAL_RUN_STATUSES));
  assert.deepEqual(sorted(RUN_NEEDS_LAWYER_STATUSES), sorted(NEEDS_LAWYER_RUN_STATUSES));
  assert.deepEqual(sorted(TERMINAL_STATUSES), sorted(SETTLED_RUN_STATUSES));
});

test("reconciling：不是终态、需要律师处理、不会再自动推进", () => {
  assert.equal(isTerminalRun("reconciling"), false);
  assert.equal(needsLawyerRun("reconciling"), true);
  assert.equal(isSettledRun("reconciling"), true);
  for (const s of TERMINAL_RUN_STATUSES) assert.equal(isSettledRun(s), true, s);
  for (const s of ["queued", "running", "waiting_input", "waiting_approval", "recovering"]) assert.equal(isSettledRun(s), false, s);
});

test("侧栏徽标：终态不出徽标；reconciling 出“待核实”（橙色），不当成进行中", () => {
  const base = { scenario: "a1.agent_task", endpoint: "standard", fullPseudonym: false, openTools: [], execOpen: false } as any;
  for (const s of RUN_TERMINAL_STATUSES) assert.deepEqual(currentBadges({ ...base, status: s }), [], s);
  const b = currentBadges({ ...base, status: "reconciling" });
  assert.equal(b.length, 1);
  assert.equal(b[0]!.label, "待核实");
  assert.equal(b[0]!.tone, "orange");
});
