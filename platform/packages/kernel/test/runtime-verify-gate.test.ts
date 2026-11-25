/**
 * 随包运行时全量摘要核验的闸口（第 4 批复核 B4-R15）：主进程设 KWL_RUNTIME_VERIFY_PENDING=1 时，内核拉起任何随包子进程
 * （闸门、Agent 宿主、解析进程）之前都要等主进程发来 kernel.runtime_verified；开发形态与测试不设该变量，不等待。
 * 第 64 批：出站闸门只等它自己的 Node 与入口核对通过（scope = gate）——登录页的注册策略与验证码都经闸门取，
 * 此前闸门要等全量核对（Windows 约 680 MB、3,665 个文件），首启的验证码登录因此迟迟不出现。其余子进程照旧等全量。
 */
process.env.KWL_RUNTIME_VERIFY_PENDING = "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("核验未完成时闸口挡住；闸门闭包核完只放行闸门；全量核完全部放行；各拉起点都先过各自的闸口", async () => {
  const { runtimeReady, markRuntimeVerified } = await import("../src/executor/child-env.ts");
  let all = false;
  let gate = false;
  void runtimeReady().then(() => (all = true));
  void runtimeReady("gate").then(() => (gate = true));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual([all, gate], [false, false], "核验未完成：都不放行");
  markRuntimeVerified("gate");
  await runtimeReady("gate");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual([all, gate], [false, true], "闸门闭包核完：只放行闸门");
  markRuntimeVerified();
  await runtimeReady();
  assert.equal(all, true);
  const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
  assert.match(src("egress/gate-host.ts"), /export async function startEgressGate[\s\S]{0,300}await runtimeReady\("gate"\)/);
  assert.match(src("executor/kap-agent-client.ts"), /ready = \(async \(\) => \{\s*\/\/[^\n]*\n\s*await runtimeReady\(\);/);
  assert.match(src("services/parse-pipeline.ts"), /await runtimeReady\(\);\s*const r = await runParseBatch\(/);
  assert.match(src("electron-entry.ts"), /kernel\.runtime_verified[\s\S]{0,200}markRuntimeVerified\(\(raw as \{ scope\?: unknown \}\)\.scope === "gate" \? "gate" : "all"\)/);
});

test("全量核对完成前收到全量放行（没有先发 gate）：闸门也一并放行", async () => {
  // 同一模块实例已在上一个用例里放行；这里只核对源码的写法：gate 的闸口是 race(全量, gate)
  const s = readFileSync(new URL("../src/executor/child-env.ts", import.meta.url), "utf8");
  assert.match(s, /Promise\.race\(\[verified, new Promise<void>\(\(resolve\) => \(gateResolve = resolve\)\)\]\)/);
});
