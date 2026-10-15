/**
 * 跨边界确认卡由内核按待决审批重算（第 03 篇 §8.2）——超预算卡（复核 B4-B06；Y3 §3.1）：宿主策略记下本次要派出的子任务数与余额，
 * 卡片标题写“这一步要同时派出 n 个子任务”、正文写剩余额度；非编排类的超预算（成员数 0）与旧宿主（无此字段）保持原文案；非法数值不进卡片。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApprovalCard, type PendingApproval } from "../src/services/interaction-cards.ts";

const ctx = { dataLevel: "L2", budget: { maxToolCalls: 100, maxSubagents: 3 }, screenSearch: () => ({ decision: "pass" as const }) };
const base: PendingApproval = { approval_id: "ap", tool: "AgentSwarm", object_hash: "h", nonce: "n", expires_at: "2099-01-01T00:00:00.000Z", reason: "over_budget", cross_boundary: "budget", scope_options: ["once"] };

test("复核 B4-B06 超预算卡写明本次成员数与余额：“这一步要同时派出 5 个子任务”、还剩 1 个（上限 3）；非编排类与缺字段保持原文案", () => {
  const swarm = buildApprovalCard({ ...base, budget: { members: 5, tool_calls_left: 98, subagents_left: 1 } }, ctx).card;
  assert.equal(swarm.kind, "budget");
  assert.equal(swarm.title, "这一步要同时派出 5 个子任务");
  assert.match(swarm.why, /子任务额度还剩 1 个（上限 3 个），这一步要派出 5 个/);
  assert.match(swarm.why, /之后再超出仍会逐次问你/);
  assert.ok(swarm.cost);
  const read = buildApprovalCard({ ...base, tool: "Read", budget: { members: 0, tool_calls_left: 0, subagents_left: 3 } }, ctx).card;
  assert.equal(read.title, "读取材料");
  assert.match(read.why, /工具调用已达预算上限（工具调用 100 次、子任务 3 个）/);
  const legacy = buildApprovalCard({ ...base, tool: "Agent" }, ctx).card;
  assert.equal(legacy.title, "启动子任务");
  for (const bad of [{ members: "5" }, { members: Number.NaN }, { members: -1 }, null]) {
    assert.equal(buildApprovalCard({ ...base, budget: bad }, ctx).card.title, "启动子任务集群", JSON.stringify(bad));
  }
  // 非超预算原因不看该字段
  assert.equal(buildApprovalCard({ ...base, reason: "manual_mode", budget: { members: 5 } }, ctx).card.title, "启动子任务集群");
});
