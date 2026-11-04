/**
 * V12 真实界面走查（用例 1）：处理细节里出现“Searching for '技术开发|技术合同|委托开发' in /…/kwl-data/demo-firm/kap-trusted/…/contract-types.md”——
 * 引擎英文自述夹着中文检索词就通过了“含中文”过滤，本机路径与内部目录名露给律师。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSteps } from "../src/lib/timeline.ts";

const ev = (type: string, payload: Record<string, unknown>, seq: number) => ({ event_id: `e${seq}`, seq, type, payload, created_at: "2026-11-04T05:10:00Z" }) as any;

test("引擎英文自述与本机路径不进时间线；律师话的说明照常显示", () => {
  const steps = buildSteps([
    ev("agent.tool_started", { tool: "Grep", tool_call_id: "g1", description: "Searching for '技术开发|技术合同|委托开发' in /tmp/x/kwl-data/demo-firm/kap-trusted/abc/skills/contract-review/references/contract-types.md" }, 1),
    ev("agent.tool_started", { tool: "Read", tool_call_id: "r1", description: "读取 C:\\Users\\律师\\案卷\\合同.docx" }, 2),
    ev("agent.tool_started", { tool: "mcp__legal__law_search", tool_call_id: "l1", description: "检索技术开发合同成果归属的规定" }, 3),
  ]);
  const details = steps.map((s) => s.detail ?? "");
  assert.ok(!details.some((d) => /kap-trusted|\/tmp\/|C:\\/.test(d)), JSON.stringify(details));
  assert.ok(details.includes("检索技术开发合同成果归属的规定"));
});
