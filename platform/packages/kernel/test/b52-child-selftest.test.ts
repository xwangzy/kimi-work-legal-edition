/**
 * 随包子进程自检（第 52 批；偏离 D-215 的验证缺口）：安装冒烟以前只看 kernel.status 的“闸门对象存在”，闸门进程从未拉起也报 true，
 * 抓不到“安装包里子进程全部拉不起来”。kernel.childSelftest 经产品同一代码路径真拉起闸门、解析进程、Agent 宿主与 W 执行域：
 *
 * - 开发形态下四项都是 ok，而且进程真在运行（闸门 running、宿主有进程号）；
 * - 任一子进程拉不起来（随包 Node 路径失效、摘要不符）都报对应的原因码，内核本身不崩；
 * - 结果只有结果码（不含路径与报错原文）；
 * - 只经主进程专用消息调用：不在内核方法表里，界面调不到。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { LAWDB_FIXTURE, makeKernel } from "./helpers.ts";
import { parseSelftestFailure, runChildSelftest, selftestPdf, PARSE_SELFTEST_TEXT } from "../src/services/child-selftest.ts";
import { kapStartFailure } from "../src/executor/kap-agent-client.ts";

const CODE = /^[a-z][a-z0-9_]{0,39}$/;
const BAD_NODE = join(tmpdir(), "kwl-no-such-dir", process.platform === "win32" ? "node.exe" : "node");
const ALL_OK = { gate: "ok", parse: "ok", kap: "ok", w: "ok" };

test("开发形态：四个随包子进程经产品路径真拉起，结果全是 ok；闸门与宿主确在运行", { timeout: 240_000 }, async () => {
  const k = await makeKernel({}, "b52-selftest-ok");
  try {
    assert.equal(k.kernel.gate.running, false, "闸门按需拉起：自检前不在运行（这正是旧冒烟 egress_gate: true 证明不了的）");
    const r = await k.kernel.childSelftest();
    assert.deepEqual(r, ALL_OK);
    assert.equal(k.kernel.gate.running, true);
    assert.ok(k.kernel.agentClient.hostPid(), "Agent 宿主在运行");
    // 再跑一次复用已在运行的闸门与宿主（执行域每次新拉起、自检后关闭）
    assert.deepEqual(await k.kernel.childSelftest(), ALL_OK);
  } finally {
    await k.kernel.close();
  }
});

test("全新安装（待激活、落盘加密 required，与 CI 冒烟时的安装包同一形态）：四项同样真拉起、全是 ok", { timeout: 240_000 }, async () => {
  const { createKernel } = await import("../src/index.ts");
  const dir = mkdtempSync(join(tmpdir(), "kwl-b52-onboarding-"));
  const env: Record<string, string | undefined> = { ...process.env, ZR_MODEL_PROVIDER: "mock", ZR_LAWDB_FILE: process.env.ZR_LAWDB_FILE ?? LAWDB_FIXTURE, ZR_LAWDB_ALLOW_TEST_FIXTURE: "1", ZR_KERNEL_TCP: "off", ZR_ONBOARDING: "1", ZR_AT_REST: "required", ZR_CONTROL_PLANE_SYNC_MS: "off" };
  delete env.ZR_FIRM_SLUG;
  delete env.ZR_USER_SLUG;
  const kernel = await createKernel({ dataDir: dir, env: env as NodeJS.ProcessEnv });
  try {
    assert.equal(kernel.config.onboarding, true);
    assert.deepEqual(await kernel.childSelftest(), ALL_OK);
  } finally {
    await kernel.close();
  }
});

test("闸门与解析进程的运行时路径失效：gate=runtime_missing、宿主因闸门不可用不启动、parse=spawn_failed；内核不崩", { timeout: 240_000 }, async () => {
  const k = await makeKernel({ KWL_GATE_NODE: BAD_NODE, KWL_PARSE_NODE: BAD_NODE }, "b52-selftest-bad-gate");
  try {
    const r = await k.kernel.childSelftest();
    assert.deepEqual(r, { gate: "runtime_missing", parse: "spawn_failed", kap: "gate_unavailable", w: "host_unavailable" });
    for (const v of Object.values(r)) assert.match(v, CODE);
    assert.equal(k.kernel.agentClient.hostPid(), null);
  } finally {
    await k.kernel.close();
  }
});

test("Agent 宿主的运行时路径失效：kap=runtime_missing（拉起失败不再成为内核的未捕获异常），闸门与解析不受影响", { timeout: 240_000 }, async () => {
  const k = await makeKernel({ KWL_AGENT_HOST_NODE: BAD_NODE }, "b52-selftest-bad-kap");
  try {
    const r = await k.kernel.childSelftest();
    assert.deepEqual(r, { gate: "ok", parse: "ok", kap: "runtime_missing", w: "host_unavailable" });
    // 内核仍可用
    assert.equal(((await k.inv("kernel.status")) as { version: string }).version.startsWith("v"), true);
  } finally {
    await k.kernel.close();
  }
});

test("W 执行域的随包 Node 摘要不符：宿主握手通过、w=node_digest", { timeout: 240_000 }, async () => {
  const k = await makeKernel({ KWL_RUNTIME_NODE_SHA256: "0".repeat(64) }, "b52-selftest-bad-w");
  try {
    const r = await k.kernel.childSelftest();
    assert.deepEqual(r, { gate: "ok", parse: "ok", kap: "ok", w: "node_digest" });
  } finally {
    await k.kernel.close();
  }
});

test("自检编排：超时与异常都落成结果码；解析读不回约定文字记 wrong_output；不把报错原文带出来", async () => {
  const never = new Promise<never>(() => {});
  const r1 = await runChildSelftest({
    gate: { ensure: () => never, running: false },
    parse: async () => ({ text: "别的文字" }),
    kap: { selftest: async () => ({ kap: "ok", w: "C:\\Users\\某律师\\秘密" }) },
    timeouts: { gate: 50, parse: 1_000, kap: 6_000 },
  });
  assert.deepEqual(r1, { gate: "timeout", parse: "wrong_output", kap: "ok", w: "other" });
  const r2 = await runChildSelftest({
    gate: { ensure: async () => Promise.reject(Object.assign(new Error("spawn /x/node ENOENT"), { code: "ENOENT" })), running: false },
    parse: async () => Promise.reject(new Error("解析进程单页超时（30s 无产出），已终止")),
    kap: { selftest: () => never },
    timeouts: { gate: 1_000, parse: 1_000, kap: 5_100 },
  });
  assert.deepEqual(r2, { gate: "runtime_missing", parse: "timeout", kap: "timeout", w: "timeout" });
  assert.equal(parseSelftestFailure(new Error("解析进程连续异常（重建 1 次仍失败）：解析进程启动失败：spawn x ENOENT")), "spawn_failed");
  assert.equal(parseSelftestFailure(new Error("解析进程连续异常（重建 1 次仍失败）：解析进程异常退出（code=1 signal=null）")), "exited_early");
  assert.equal(kapStartFailure(new Error("kap-host 初始化超时")), "init_timeout");
  assert.equal(kapStartFailure(Object.assign(new Error("spawn x EACCES"), { code: "EACCES" })), "spawn_denied");
  assert.equal(kapStartFailure(new Error("kap-host 握手前退出（1）")), "exited_early");
  // 解析自检用的 PDF 只有 ASCII 文本层，文字可读回
  assert.ok(selftestPdf().toString("latin1").includes(PARSE_SELFTEST_TEXT));
});

test("只经主进程专用消息调用：electron-entry 处理 kernel.child_selftest；内核方法表里没有；冒烟在摘要核验之后调用并逐项判定", () => {
  const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  const entry = src("../src/electron-entry.ts");
  assert.match(entry, /type === "kernel\.child_selftest"[\s\S]{0,600}kernelRef\.childSelftest\(\)/);
  assert.doesNotMatch(src("../src/api/index.ts"), /child_selftest|childSelftest/);
  const main = src("../../../apps/desktop/electron/main.cjs");
  const at = (s: string) => main.indexOf(s);
  assert.ok(at('result.checks.runtime_digests = ') > 0 && at('type: "kernel.child_selftest"') > at('result.checks.runtime_digests = '), "摘要核验（runtime_verified 已发）之后再拉起子进程");
  assert.ok(at("childrenFailure(result.checks.children)") > at('type: "kernel.child_selftest"'));
  assert.ok(at("result.ok = true") > at("childrenFailure(result.checks.children)"), "子进程自检在判定通过之前");
});
