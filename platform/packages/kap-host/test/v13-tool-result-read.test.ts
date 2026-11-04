// V13 真实走查 N1（整理案卷，K3.1-Pro）：facts.list 返回 102 条事实，引擎把超长结果存进本会话的 tool-results 并提示“用 Read 按 output_path 翻页”；
// 宿主策略以“路径不在本事项”拒绝了这次 Read，助手只好把 102 条事实凭记忆重写成 JSON，40 分钟工作时限用完、三张表一张没出。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBroker } from "@zr-legal/file-broker";
import { ManifestRegistry } from "@zr-legal/host-policy";
import { HostPolicy, type RunPolicyContext } from "../src/policy.ts";

const ctx: RunPolicyContext = {
  runId: "r1",
  matterId: "m1",
  mode: "auto",
  channel: "desktop",
  purpose: "legal_analysis",
  dataLevel: "L2",
  basisComplete: true,
  preauthorized: new Set(),
  fetchAllowlist: [],
  budget: { maxToolCalls: 100, maxSubagents: 2 },
  planFirst: false,
};

test("本会话、本 Agent 的工具结果存档可以 Read；别的会话、别的 Agent、写入、其他引擎内部文件照旧拒绝", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "v13-tr-")));
  const work = join(root, "work");
  const engine = join(root, "home", "sessions");
  const dir = (sid: string, agent: string) => join(engine, "wd_work_1", sid, "agents", agent, "tool-results");
  for (const [sid, agent] of [["s1", "main"], ["s2", "main"], ["s1", "sub_1"]] as const) {
    mkdirSync(dir(sid, agent), { recursive: true });
    writeFileSync(join(dir(sid, agent), "mcp__legal__facts_list-call_61.txt"), "[...]");
  }
  mkdirSync(work, { recursive: true });
  writeFileSync(join(engine, "wd_work_1", "s1", "state.json"), "{}");
  const broker = new FileBroker([
    { name: "work", root: work, access: "rw" },
    { name: "engine", root: engine, access: "rw" },
  ]);
  const p = new HostPolicy({ broker, workDir: work, manifests: new ManifestRegistry([]), execDomainAvailable: () => false });
  p.bindSession("s1", ctx);
  const ev = (tool: string, args: unknown, agentId = "main") =>
    p.evaluate({ sessionId: "s1", agentId, turnId: 1, toolCallId: `c_${tool}_${Math.random()}`, toolName: tool, args, description: undefined, display: undefined });
  const kind = (r: { kind: string; reason?: Record<string, unknown> }) => `${r.kind}:${String(r.reason?.host_policy ?? "")}`;
  const own = join(dir("s1", "main"), "mcp__legal__facts_list-call_61.txt");
  assert.equal(ev("Read", { path: own }).kind, "approve", "自己的工具结果存档可读");
  assert.equal(kind(ev("Read", { path: join(dir("s2", "main"), "mcp__legal__facts_list-call_61.txt") })), "deny:path_outside_matter", "别的会话的不可读");
  assert.equal(kind(ev("Read", { path: join(dir("s1", "sub_1"), "mcp__legal__facts_list-call_61.txt") })), "deny:path_outside_matter", "别的 Agent 的不可读");
  assert.equal(kind(ev("Read", { path: join(dir("s1", "sub_1"), "mcp__legal__facts_list-call_61.txt") }, "main")), "deny:path_outside_matter");
  assert.equal(kind(ev("Write", { path: own, content: "x" })), "deny:path_outside_matter", "不可写");
  assert.equal(kind(ev("Edit", { path: own, old_string: "[", new_string: "{" })), "deny:path_outside_matter", "不可改");
  assert.equal(kind(ev("Read", { path: join(engine, "wd_work_1", "s1", "state.json") })), "deny:path_outside_matter", "引擎其他内部文件照旧不可读");
  assert.equal(kind(ev("Read", { path: dir("s1", "main") })), "deny:path_outside_matter", "目录本身不在放行范围");
});
