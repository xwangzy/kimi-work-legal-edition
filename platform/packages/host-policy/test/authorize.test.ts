/**
 * 清单式授权（v9 第 04 篇 §9 F3）：不再按 `mcp__legal__` 前缀放行；工具 ID + 副作用 + 资源 + 用途 + schema hash。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ManifestRegistry, authorizeToolCall, canonicalJson, mcpManifest, qualifyMcpToolName, schemaHash } from "../src/index.ts";

const readSchema = { type: "object", additionalProperties: false, required: ["law"], properties: { law: { type: "string" } } };
const writeSchema = { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string" } } };

const registry = new ManifestRegistry([
  mcpManifest("legal", { name: "law.get_version", inputSchema: readSchema, sideEffect: "read", resource: "lawdb", version: "1", purposes: ["legal_analysis"] }),
  mcpManifest("legal", { name: "materials.read_excerpt", inputSchema: readSchema, sideEffect: "read", resource: "matter_materials", version: "1", purposes: ["legal_analysis"] }),
  mcpManifest("legal", { name: "draft.write", inputSchema: writeSchema, sideEffect: "write_draft", resource: "matter_work", version: "1", purposes: ["legal_analysis"] }),
  mcpManifest("legal", { name: "web.search", inputSchema: readSchema, sideEffect: "network", resource: "pure", version: "1", purposes: ["legal_analysis"] }),
  mcpManifest("legal", { name: "mail.send", inputSchema: writeSchema, sideEffect: "external", resource: "pure", version: "1", purposes: ["legal_analysis"] }),
]);

const base = { boundMatterId: "mat_1", purpose: "legal_analysis", mode: "default" as const };

test("引擎工具名与 Kimi Code qualifyMcpToolName 逐字节一致", () => {
  assert.equal(qualifyMcpToolName("legal", "materials.read_excerpt"), "mcp__legal__materials_read_excerpt");
  assert.equal(qualifyMcpToolName("legal", "law.get_version"), "mcp__legal__law_get_version");
  assert.equal(qualifyMcpToolName("le gal", "a..b"), "mcp__le_gal__a_b");
  // 上游 stableHash8 用 Math.trunc(Math.imul(...))，结果可能为负，toString(16) 带负号——逐字节复刻该行为
  const long = qualifyMcpToolName("legal", "x".repeat(80));
  assert.equal(long, "mcp__legal__xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx_-56d8318c");
});

test("前缀相同但未登记的工具一律拒绝（旧实现会自动批准）", () => {
  const d = authorizeToolCall(registry, { ...base, toolId: "mcp__legal__admin_delete_all" });
  assert.equal(d.decision, "deny");
  assert.equal(d.reason, "unknown_tool");
});

test("读工具在默认档自动；手动档询问；Chat 只读", () => {
  assert.equal(authorizeToolCall(registry, { ...base, toolId: "mcp__legal__law_get_version" }).decision, "approve");
  assert.equal(authorizeToolCall(registry, { ...base, mode: "manual", toolId: "mcp__legal__law_get_version" }).decision, "ask");
  assert.equal(authorizeToolCall(registry, { ...base, mode: "chat", toolId: "mcp__legal__law_get_version" }).decision, "approve");
  assert.equal(authorizeToolCall(registry, { ...base, mode: "chat", toolId: "mcp__legal__draft_write" }).decision, "deny");
});

test("事项绑定、跨事项、用途、对外发送类", () => {
  assert.equal(authorizeToolCall(registry, { ...base, boundMatterId: null, toolId: "mcp__legal__materials_read_excerpt" }).reason, "unbound_matter");
  assert.equal(authorizeToolCall(registry, { ...base, requestedMatterId: "mat_2", toolId: "mcp__legal__materials_read_excerpt" }).reason, "cross_matter");
  assert.equal(authorizeToolCall(registry, { ...base, purpose: "marketing", toolId: "mcp__legal__law_get_version" }).reason, "purpose_not_allowed");
  assert.equal(authorizeToolCall(registry, { ...base, toolId: "mcp__legal__mail_send" }).reason, "not_a_tool");
});

test("联网类是跨边界动作：默认档询问；自动档只在预授权范围内自动", () => {
  assert.equal(authorizeToolCall(registry, { ...base, toolId: "mcp__legal__web_search" }).decision, "ask");
  assert.equal(authorizeToolCall(registry, { ...base, mode: "auto", toolId: "mcp__legal__web_search" }).decision, "ask");
  assert.equal(
    authorizeToolCall(registry, { ...base, mode: "auto", preauthorized: new Set(["mcp__legal__web_search"]), toolId: "mcp__legal__web_search" }).decision,
    "approve",
  );
});

test("schema 变化即视为另一个工具：服务端自检列出不一致项", () => {
  const problems = registry.verifyServerSchemas("legal", [
    { name: "law.get_version", inputSchema: readSchema },
    { name: "materials.read_excerpt", inputSchema: { ...readSchema, properties: { law: { type: "string" }, extra: { type: "string" } } } },
    { name: "unlisted.tool", inputSchema: readSchema },
  ]);
  assert.deepEqual(problems, ["materials.read_excerpt: schema hash 与清单不一致", "unlisted.tool: 无清单"]);
});

test("canonicalJson 键序无关、参数摘要稳定", () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
  assert.equal(schemaHash({ b: 1, a: 2 }), schemaHash({ a: 2, b: 1 }));
  const d1 = authorizeToolCall(registry, { ...base, toolId: "mcp__legal__law_get_version" }, { law: "民法典", as_of: "2026-01-01" });
  const d2 = authorizeToolCall(registry, { ...base, toolId: "mcp__legal__law_get_version" }, { as_of: "2026-01-01", law: "民法典" });
  assert.equal(d1.argsHash, d2.argsHash);
});
