/**
 * 时间线显示实际发出的内容（v9.2 Y4 #2 / P0-A；复核 B4-B22）：联网步骤按工具调用编号关联本机去向记录，
 * 显示改写后实际发出的查询或打开的网址；没有去向记录时只提示去“数据去向”看；不显示 Agent 自述的检索式。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSteps, sentByToolCall } from "../src/lib/timeline.ts";

const ev = (type: string, payload: Record<string, unknown>, i: number) => ({ event_id: `e${i}`, run_id: "r", seq: i, type, payload, created_at: "2026-10-14T08:00:00.000Z" }) as any;
const note = (o: Record<string, unknown>) => JSON.stringify(o);

test("去向记录按调用编号取实际发出的内容：补全优先于预写；被拦截的不当作已发出", () => {
  const m = sentByToolCall([
    { note: note({ phase: "start", purpose: "search", tool_call_id: "c1", query: { original: "滨江置业 违约", sent: "某公司 违约", decision: "generalized" } }), outcome: "sent" },
    { note: note({ phase: "end", purpose: "search", tool_call_id: "c1", query: { original: "滨江置业 违约", sent: "某公司 违约", decision: "generalized" } }), outcome: "sent" },
    { note: note({ purpose: "fetch", tool_call_id: "c2", url: { requested: "https://x.test/?q=张三", final: null } }), outcome: "blocked" },
    { note: note({ purpose: "model" }), outcome: "sent" },
    { note: "不是 JSON", outcome: "sent" },
  ]);
  assert.deepEqual(m.get("c1"), { kind: "search", text: "某公司 违约", decision: "generalized", outcome: "sent" });
  assert.deepEqual(m.get("c2"), { kind: "fetch", text: null, decision: null, outcome: "blocked" });
  assert.equal(m.size, 2);
});

test("时间线：联网步骤显示改写后的查询并注明；不显示 Agent 自述；没有去向记录时提示去“数据去向”", () => {
  const events = [
    ev("agent.tool_started", { tool: "WebSearch", tool_call_id: "c1", description: "Searching: 滨江置业有限公司 违约" }, 1),
    ev("agent.tool_result", { tool_call_id: "c1" }, 2),
    ev("agent.tool_started", { tool: "WebSearch", tool_call_id: "c3", description: "Searching: 滨江置业有限公司 判例" }, 3),
    ev("agent.tool_started", { tool: "WebSearch", tool_call_id: "c4", description: "Searching: 滨江置业" }, 4),
    ev("agent.tool_result", { tool_call_id: "c4" }, 5),
    ev("agent.tool_started", { tool: "Read", tool_call_id: "r1", description: "Reading file /x/001.txt" }, 6),
  ];
  const sent = sentByToolCall([{ note: note({ purpose: "search", tool_call_id: "c1", query: { original: "滨江置业有限公司 违约", sent: "某公司 违约", decision: "generalized" } }), outcome: "sent" }]);
  const steps = buildSteps(events, {}, sent).filter((s) => s.title === "联网查资料");
  assert.equal(steps.length, 3);
  assert.equal(steps[0]!.detail, "发出：某公司 违约（已去掉当事人名称）");
  assert.equal(steps[0]!.icon, "ok");
  assert.equal(steps[1]!.detail, undefined, "没有去向记录：不显示自述");
  assert.match(steps[1]!.meta ?? "", /数据去向/);
  assert.equal(steps[2]!.detail, "这一步没有联网发出", "已结束、没有去向记录：不再指向数据去向");
  assert.ok(!(steps[2]!.meta ?? "").includes("数据去向"));
  assert.ok(!JSON.stringify(steps).includes("滨江置业"), "时间线不出现改写前的当事人名称");
  const read = buildSteps(events, {}, sent).find((s) => s.title !== "联网查资料" && s.level === "lawyer");
  assert.equal(read?.detail, undefined, "英文自述不显示");
});
