/**
 * 随包运行时全量摘要核验的闸口（第 4 批复核 B4-R15）：主进程设 KWL_RUNTIME_VERIFY_PENDING=1 时，内核拉起任何随包子进程
 * （闸门、Agent 宿主、解析进程）之前都要等主进程发来 kernel.runtime_verified；开发形态与测试不设该变量，不等待。
 */
process.env.KWL_RUNTIME_VERIFY_PENDING = "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("核验未完成时闸口挡住；收到核验通过后放行；三处随包子进程的拉起点都先过闸口", async () => {
  const { runtimeReady, markRuntimeVerified } = await import("../src/executor/child-env.ts");
  let passed = false;
  void runtimeReady().then(() => (passed = true));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(passed, false, "核验未完成：不放行");
  markRuntimeVerified();
  await runtimeReady();
  assert.equal(passed, true);
  const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
  assert.match(src("egress/gate-host.ts"), /export async function startEgressGate[\s\S]{0,200}await runtimeReady\(\)/);
  assert.match(src("executor/kap-agent-client.ts"), /ready = \(async \(\) => \{\s*\/\/[^\n]*\n\s*await runtimeReady\(\);/);
  assert.match(src("services/parse-pipeline.ts"), /await runtimeReady\(\);\s*const r = await runParseBatch\(/);
  assert.match(src("electron-entry.ts"), /kernel\.runtime_verified[\s\S]{0,80}markRuntimeVerified\(\)/);
});
