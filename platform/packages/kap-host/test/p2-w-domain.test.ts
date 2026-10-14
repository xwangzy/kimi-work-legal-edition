/**
 * 探针 P2（v9 第 04 篇 §4.1、第 06 篇 P2）：Kimi Code 的 Bash 经 DI（IHostProcessService 种子 → 执行域路由）进入 W-core。
 *
 * 宿主（KapRuntime + 事项引擎 + W 执行域工厂）在本进程内运行；模型是 Unix 套接字上的假 OpenAI 兼容服务。
 * 覆盖：Bash 端到端（标准库 Python 数据任务）；单一路径命名空间（Bash ⇄ Read/Write/Grep 同一路径）；系统提示中的受限 bash 说明；
 * cwd 越界与超时档位的策略拒绝；前台超时转后台；运行取消传播到执行域；执行域起不来时失败关闭。
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import { ManifestRegistry } from "@zr-legal/host-policy";
import { configureTrustedRipgrep } from "../vendor/kap-embed/kap-embed.mjs";
import { KapRuntime, type RuntimeRunStatus } from "../src/runtime.ts";
import { HostEgressDispatcher } from "../src/host-egress.ts";
import { wCoreFactory } from "../src/w-domain.ts";
import { placeholderShellPath } from "../src/seeds.ts";
import type { ExecDomainFactory } from "../src/exec-router.ts";
import { startFakeModel, type FakeModel, type FakeStep } from "./fake-model.ts";

/** 检索入口（审计 S3 第 2 步：Grep/Glob 由宿主内检索完成；入口只是已存在的占位文件，路由按字面匹配、从不执行）。 */
function searchEntry(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kh-search-")));
  const p = join(dir, ".kwl-host-search");
  writeFileSync(p, "entry\n");
  return p;
}

const DESKTOP = { channel: "desktop" as const, userId: "u_lawyer" };
const POLICY = {
  dataLevel: "L2" as const,
  basisComplete: true,
  fetchAllowlist: [] as string[],
  allowedPreauthorizations: [] as never[],
  budget: { maxToolCalls: 200, maxSubagents: 4 },
  maxMode: "auto" as const,
  purpose: "legal_analysis",
};
const TERMINAL: RuntimeRunStatus[] = ["succeeded", "partial", "failed", "cancelled"];

let base: string;
let model: FakeModel;
let egress: HostEgressDispatcher;
let prevDispatcher: Dispatcher;
const rg: string | null = searchEntry();

function newRuntime(factory: ExecDomainFactory, tag: string): KapRuntime {
  return new KapRuntime({
    matterLayout: (mid) => ({ homeDir: join(base, tag, mid, "home"), materialsDir: join(base, tag, mid, "materials"), workDir: join(base, tag, mid, "work") }),
    matterPolicy: () => POLICY,
    modelToken: (r) => `tok-${r.runId}`,
    toolsToken: () => null,
    manifests: new ManifestRegistry([]),
    trustedRgPath: rg,
    execDomainFactory: factory,
    logLevel: "silent",
  });
}

let runtime: KapRuntime;

before(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "kh-p2-")));
  model = await startFakeModel(join(base, "m.sock"));
  configureTrustedRipgrep(rg ?? undefined);
  runtime = newRuntime(wCoreFactory(), "w");
  egress = new HostEgressDispatcher({ modelSocket: model.socket, toolsSocket: join(base, "t.sock"), authority: runtime.authority });
  prevDispatcher = getGlobalDispatcher();
  setGlobalDispatcher(egress);
});

after(async () => {
  await runtime.close();
  setGlobalDispatcher(prevDispatcher);
  await egress.close();
  await model.close();
});

async function waitStatus(rt: KapRuntime, runId: string, want: (s: RuntimeRunStatus) => boolean, ms = 30_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const r = rt.events(runId, 0, DESKTOP);
    if (want(r.status)) return r;
    if (Date.now() > deadline) throw new Error(`运行 ${runId} 未到达期望状态（当前 ${r.status}）：${JSON.stringify(r.events.map((e) => e.type))}`);
    await new Promise((x) => setTimeout(x, 50));
  }
}

const toolText = (body: any, id: string): string => {
  const m = (body.messages ?? []).find((x: any) => x.role === "tool" && x.tool_call_id === id);
  return m ? (typeof m.content === "string" ? m.content : JSON.stringify(m.content)) : "";
};
const answeredIds = (body: any): Set<string> => new Set((body.messages ?? []).filter((m: any) => m.role === "tool").map((m: any) => m.tool_call_id));
const firstUser = (body: any): string => JSON.stringify((body.messages ?? []).find((x: any) => x.role === "user")?.content ?? "");

/** 按顺序发出工具调用（每步一个），全部有结果后回文本。 */
function sequence(marker: string, calls: [string, unknown][], done = "完成。"): (body: any) => FakeStep {
  return (body) => {
    if (!firstUser(body).includes(marker)) return { text: "（无关请求）" };
    const answered = answeredIds(body);
    const i = calls.findIndex((_, k) => !answered.has(`${marker}_${k}`));
    if (i === -1) return { text: done };
    const [name, args] = calls[i]!;
    return { toolCalls: [{ id: `${marker}_${i}`, name, args }] };
  };
}

const lastRequestFor = (marker: string) => [...model.requests].reverse().find((q) => firstUser(q.body).includes(marker))!;

describe("P2：Bash 经 DI 进入 W-core", () => {
  test("端到端：Bash 在 W 内跑标准库数据任务；Bash 写的文件 Read/Grep 同路径可见，Write 写的文件 Bash 同路径可读；系统提示含受限 bash 说明", { timeout: 120_000 }, async () => {
    const mid = "m_bash";
    const engine = await runtime.matterEngine(mid);
    assert.equal(engine.router.currentDomain().id, "W-core", engine.execDomainError ?? "");
    const W = engine.workDir;
    const M = "P2BASH";
    model.setScript(
      sequence(M, [
        [
          "Bash",
          {
            command: `mkdir -p 统计 && printf '月份,金额\\n2026-01,100\\n2026-02,250\\n' > 统计/流水.csv && python3 -c "import csv; rows=list(csv.DictReader(open('统计/流水.csv', encoding='utf-8'))); print('合计', sum(int(r['金额']) for r in rows))"`,
          },
        ],
        ["Read", { path: join(W, "统计", "流水.csv") }],
        ["Write", { path: join(W, "宿主写入.md"), content: "由 Write 工具写入" }],
        ["Bash", { command: `cat '${join(W, "宿主写入.md")}' && wc -l 统计/流水.csv` }],
        ...(rg ? ([["Grep", { pattern: "2026-02" }]] as [string, unknown][]) : []),
      ]),
    );
    const r = await runtime.startRun({ matter_id: mid, goal: `${M} 汇总流水`, mode: "auto", plan_first: false }, DESKTOP);
    const done = await waitStatus(runtime, r.run_id, (s) => TERMINAL.includes(s));
    assert.equal(done.status, "succeeded", JSON.stringify(done.events.map((e) => [e.type, e.payload.reason ?? ""])));
    const last = lastRequestFor(M).body;
    assert.match(toolText(last, `${M}_0`), /合计 350/);
    assert.match(toolText(last, `${M}_1`), /2026-02,250/);
    assert.match(toolText(last, `${M}_3`), /由 Write 工具写入/);
    assert.match(toolText(last, `${M}_3`), /3 .*流水\.csv|3\s+统计\/流水\.csv/);
    if (rg) assert.match(toolText(last, `${M}_4`), /流水\.csv/);
    assert.equal(readFileSync(join(W, "统计", "流水.csv"), "utf8"), "月份,金额\n2026-01,100\n2026-02,250\n");
    // 系统提示：受限 bash 的环境说明（可信指令通道）
    const sys = JSON.stringify(model.requests.find((q) => firstUser(q.body).includes(M))!.body.messages.find((m: any) => m.role === "system")?.content ?? "");
    assert.match(sys, /执行环境说明（宿主提供）/);
    assert.match(sys, /受限 bash/);
    // 执行域事件进入运行事件流（界面显示排队与提交摘要）
    assert.ok(done.events.some((e) => e.type === "exec.finished" && e.payload.exitCode === 0));
  });

  test("策略：Bash 的 cwd 只能在工作区；disable_timeout 与超过 60 分钟的后台时限被拒绝", { timeout: 120_000 }, async () => {
    const mid = "m_bash_policy";
    const engine = await runtime.matterEngine(mid);
    const M = "P2POLICY";
    model.setScript(
      sequence(M, [
        ["Bash", { command: "ls", cwd: engine.materialsDir }],
        ["Bash", { command: "ls", cwd: "/etc" }],
        ["Bash", { command: "sleep 1", run_in_background: true, description: "长任务", disable_timeout: true }],
        ["Bash", { command: "sleep 1", run_in_background: true, description: "长任务", timeout: 7200 }],
      ]),
    );
    const r = await runtime.startRun({ matter_id: mid, goal: `${M} 试探边界`, mode: "auto", plan_first: false }, DESKTOP);
    const done = await waitStatus(runtime, r.run_id, (s) => TERMINAL.includes(s));
    assert.equal(done.status, "succeeded");
    const last = lastRequestFor(M).body;
    assert.match(toolText(last, `${M}_0`), /宿主策略拒绝|bash_cwd_outside_workspace/);
    assert.match(toolText(last, `${M}_1`), /宿主策略拒绝|path_outside_matter/);
    assert.match(toolText(last, `${M}_2`), /disable_timeout/);
    assert.match(toolText(last, `${M}_3`), /60 分钟/);
  });

  test("前台超时转后台（上游语义）：命令在 W 内继续，完成后文件经提交落盘；运行等后台任务结束才收尾", { timeout: 120_000 }, async () => {
    const mid = "m_bash_bg";
    const engine = await runtime.matterEngine(mid);
    const M = "P2BG";
    model.setScript(sequence(M, [["Bash", { command: "sleep 3; echo 后台完成 > 后台.txt", timeout: 1 }]]));
    const r = await runtime.startRun({ matter_id: mid, goal: `${M} 长命令`, mode: "auto", plan_first: false }, DESKTOP);
    const done = await waitStatus(runtime, r.run_id, (s) => TERMINAL.includes(s), 60_000);
    assert.equal(done.status, "succeeded", JSON.stringify(done.events.map((e) => e.type)));
    const first = [...model.requests].find((q) => firstUser(q.body).includes(M) && toolText(q.body, `${M}_0`))!.body;
    assert.match(toolText(first, `${M}_0`), /moved to background|task_id/i);
    assert.equal(readFileSync(join(engine.workDir, "后台.txt"), "utf8"), "后台完成\n");
  });

  test("取消传播到执行域：取消运行即终止本事项在途的后台 Bash，内存层改动丢弃不提交", { timeout: 120_000 }, async () => {
    const mid = "m_bash_cancel";
    const engine = await runtime.matterEngine(mid);
    const M = "P2CANCEL";
    model.setScript(sequence(M, [["Bash", { command: "echo 中间 > 中间.txt; sleep 20; echo 不应写入 > 迟到.txt", run_in_background: true, description: "长任务" }]]));
    const r = await runtime.startRun({ matter_id: mid, goal: `${M} 后台任务`, mode: "auto", plan_first: false }, DESKTOP);
    // 主回合结束后运行等待后台任务（settle）：此时取消
    const deadline = Date.now() + 30_000;
    for (;;) {
      const tasks = (await engine.kap.tasks(r.session_id)).items as { status?: string }[];
      if (tasks.some((t) => t.status === "running")) break;
      if (Date.now() > deadline) throw new Error("后台任务未出现");
      await new Promise((x) => setTimeout(x, 100));
    }
    const ev = runtime.events(r.run_id, 0, DESKTOP);
    await runtime.cancel(r.run_id, { reason: "律师取消", expected_state_version: ev.state_version }, DESKTOP);
    const t0 = Date.now();
    for (;;) {
      const tasks = (await engine.kap.tasks(r.session_id)).items as { status?: string }[];
      if (!tasks.some((t) => t.status === "running")) break;
      if (Date.now() - t0 > 10_000) throw new Error(`后台任务未被终止：${JSON.stringify(tasks)}`);
      await new Promise((x) => setTimeout(x, 100));
    }
    assert.ok(Date.now() - t0 < 8_000);
    await new Promise((x) => setTimeout(x, 500));
    assert.equal(existsSync(join(engine.workDir, "迟到.txt")), false);
    assert.equal(existsSync(join(engine.workDir, "中间.txt")), false, "被终止的命令的内存层改动不提交");
  });
});

describe("P2：审查 S3-06 / S3-07 的运行层回归", () => {
  test("S3-07 运行终态之后到达的进程启动被执行域路由拒绝（fencing）；运行进行中照常路由", { timeout: 120_000 }, async () => {
    const mid = "m_fence";
    const engine = await runtime.matterEngine(mid);
    const shell = placeholderShellPath(process.platform === "win32" ? "win32" : "posix");
    const W = engine.workDir;
    // 没有任何运行：拒绝
    await assert.rejects(engine.router.spawn(shell, ["-c", `cd '${W}' && echo early > early.txt`]), /没有进行中的运行/);
    const M = "P2FENCE";
    model.setScript(sequence(M, [["Bash", { command: "echo 运行中 > 运行中.txt" }]]));
    const r = await runtime.startRun({ matter_id: mid, goal: `${M} 写一个文件`, mode: "auto", plan_first: false }, DESKTOP);
    const done = await waitStatus(runtime, r.run_id, (s) => TERMINAL.includes(s));
    assert.equal(done.status, "succeeded");
    assert.equal(readFileSync(join(W, "运行中.txt"), "utf8"), "运行中\n");
    // 终态之后晚到的 spawn：拒绝，且不落盘
    await assert.rejects(engine.router.spawn(shell, ["-c", `cd '${W}' && echo late > late.txt`]), /没有进行中的运行/);
    assert.equal(existsSync(join(W, "late.txt")), false);
    assert.equal(existsSync(join(W, "early.txt")), false);
  });

  test("S3-06 本运行中有执行域提交被整体拒绝：Bash 退出码 75，运行收尾为 partial（不判成功）", { timeout: 120_000 }, async () => {
    const mid = "m_commitfail";
    await runtime.matterEngine(mid);
    const M = "P2COMMITFAIL";
    model.setScript(sequence(M, [["Bash", { command: "echo x > .kwl-trash-evil; echo y > 合法.txt" }]]));
    const r = await runtime.startRun({ matter_id: mid, goal: `${M} 写文件`, mode: "auto", plan_first: false }, DESKTOP);
    const done = await waitStatus(runtime, r.run_id, (s) => TERMINAL.includes(s));
    assert.equal(done.status, "partial", JSON.stringify(done.events.map((e) => [e.type, e.payload.reason ?? ""])));
    const fin = done.events.find((e) => e.type === "run.partial")!;
    assert.equal(fin.payload.reason, "workspace_commit_incomplete");
    assert.match(toolText(lastRequestFor(M).body, `${M}_0`), /75|未提交/);
    const ex = done.events.find((e) => e.type === "exec.finished")!;
    assert.equal(ex.payload.exitCode, 75);
  });
});

describe("P2：复核 S3-16 / S3-23", () => {
  test("S3-16 同一事项已有进行中的运行：再启动返回 conflict（执行域的取消、fencing 与事件都按事项）；前一运行收尾后可以再启动", { timeout: 120_000 }, async () => {
    const mid = "m_onerun";
    await runtime.matterEngine(mid);
    const M = "P2ONERUN";
    model.setScript(sequence(M, [["Bash", { command: "sleep 1.5; echo 完成 > 一.txt" }]]));
    const r1 = await runtime.startRun({ matter_id: mid, goal: `${M} 第一个`, mode: "auto", plan_first: false }, DESKTOP);
    await assert.rejects(runtime.startRun({ matter_id: mid, goal: `${M} 第二个`, mode: "auto", plan_first: false }, DESKTOP), (e: unknown) => (e as { code?: string }).code === "conflict");
    // 并发两个启动：只有一个能成功
    const done1 = await waitStatus(runtime, r1.run_id, (s) => TERMINAL.includes(s));
    assert.equal(done1.status, "succeeded");
    const M2 = "P2ONERUN2";
    model.setScript(sequence(M2, [["Bash", { command: "echo 二 > 二.txt" }]]));
    const both = await Promise.allSettled([
      runtime.startRun({ matter_id: mid, goal: `${M2} 甲`, mode: "auto", plan_first: false }, DESKTOP),
      runtime.startRun({ matter_id: mid, goal: `${M2} 乙`, mode: "auto", plan_first: false }, DESKTOP),
    ]);
    assert.equal(both.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(both.filter((x) => x.status === "rejected" && (x.reason as { code?: string }).code === "conflict").length, 1);
    const ok = both.find((x) => x.status === "fulfilled") as PromiseFulfilledResult<{ run_id: string }>;
    await waitStatus(runtime, ok.value.run_id, (s) => TERMINAL.includes(s));
  });

  test("S3-23 设备执行域自检失败的结果有时效：过期后重试，工厂恢复后账本恢复为 W-core", { timeout: 120_000 }, async () => {
    let fail = true;
    const flaky: ExecDomainFactory = {
      id: "W-core",
      label: "运行时隔离：W-core（测试：先失败后恢复）",
      async create(ctx) {
        if (fail) throw new Error("执行域启动超时（测试注入：冷启动）");
        return wCoreFactory().create(ctx);
      },
    };
    const rt = new KapRuntime({
      matterLayout: (mid) => ({ homeDir: join(base, "flaky", mid, "home"), materialsDir: join(base, "flaky", mid, "materials"), workDir: join(base, "flaky", mid, "work") }),
      matterPolicy: () => POLICY,
      modelToken: (r) => `tok-${r.runId}`,
      toolsToken: () => null,
      manifests: new ManifestRegistry([]),
      trustedRgPath: rg,
      execDomainFactory: flaky,
      deviceSelftestRetryMs: 100,
      logLevel: "silent",
    });
    try {
      const row1 = (await rt.capabilities()).find((x) => x.family === "Shell 与代码执行")!;
      assert.equal(row1.current, "disabled");
      assert.match(String(row1.note), /冷启动/);
      fail = false;
      const row2 = (await rt.capabilities()).find((x) => x.family === "Shell 与代码执行")!;
      assert.equal(row2.current, "disabled", "时效未到不重试");
      await new Promise((x) => setTimeout(x, 150));
      const row3 = (await rt.capabilities()).find((x) => x.family === "Shell 与代码执行")!;
      assert.equal(row3.current, "pending", JSON.stringify(row3));
      assert.match(String(row3.note), /运行时隔离：W-core/);
    } finally {
      await rt.close();
    }
  });
});

describe("P2：第二轮复核 S3-28", () => {
  test("S3-28 执行域运行中不可用 → 宿主策略拒绝 Bash；退避后经健康查询自行恢复，下一次运行的 Bash 经宿主策略成功（不直接调用执行域）", { timeout: 120_000 }, async () => {
    const rt = newRuntime(wCoreFactory({ recoveryRetryMs: 200 }), "recover");
    const prev = getGlobalDispatcher();
    const eg = new HostEgressDispatcher({ modelSocket: model.socket, toolsSocket: join(base, "t.sock"), authority: rt.authority });
    setGlobalDispatcher(eg);
    try {
      const mid = "m_recover";
      const engine = await rt.matterEngine(mid);
      assert.equal(engine.router.currentDomain().id, "W-core", engine.execDomainError ?? "");
      const domain = engine.router.currentDomain() as unknown as { supervisor: { pid(): number | null; opts: { nodePath?: string | undefined } } };
      const saved = domain.supervisor.opts.nodePath;
      domain.supervisor.opts.nodePath = "/nonexistent/kwl-node26/bin/node";
      process.kill(domain.supervisor.pid()!, "SIGKILL");
      await new Promise((x) => setTimeout(x, 200));
      const M1 = "P2RECOVER1";
      model.setScript(sequence(M1, [["Bash", { command: "echo 一" }], ["Bash", { command: "echo 二" }]]));
      const r1 = await rt.startRun({ matter_id: mid, goal: `${M1} 不可用`, mode: "auto", plan_first: false }, DESKTOP);
      await waitStatus(rt, r1.run_id, (s) => TERMINAL.includes(s));
      const last1 = lastRequestFor(M1).body;
      assert.match(toolText(last1, `${M1}_0`), /执行域不可用/);
      assert.match(toolText(last1, `${M1}_1`), /宿主策略拒绝/, "健康非空时宿主策略拒绝 Bash");
      // 恢复：随包 Node 回来了；不运行任何命令，只经产品路径查询健康（能力账本），退避到期后由执行域自行探测
      domain.supervisor.opts.nodePath = saved;
      await new Promise((x) => setTimeout(x, 300));
      const deadline = Date.now() + 20_000;
      for (;;) {
        await rt.capabilities();
        if (engine.execDomainError === null) break;
        if (Date.now() > deadline) throw new Error(`执行域未自行恢复：${engine.execDomainError}`);
        await new Promise((x) => setTimeout(x, 100));
      }
      const M2 = "P2RECOVER2";
      model.setScript(sequence(M2, [["Bash", { command: "echo 恢复 > 恢复.txt && cat 恢复.txt" }]]));
      const r2 = await rt.startRun({ matter_id: mid, goal: `${M2} 恢复后`, mode: "auto", plan_first: false }, DESKTOP);
      const done2 = await waitStatus(rt, r2.run_id, (s) => TERMINAL.includes(s));
      assert.equal(done2.status, "succeeded");
      assert.match(toolText(lastRequestFor(M2).body, `${M2}_0`), /恢复/);
      assert.equal(readFileSync(join(engine.workDir, "恢复.txt"), "utf8"), "恢复\n");
    } finally {
      setGlobalDispatcher(prev);
      await eg.close();
      await rt.close();
    }
  });
});

describe("P2：执行域起不来时失败关闭", () => {
  test("工厂失败 → Bash 对模型不可见、宿主策略拒绝；失败原因如实记录；能力账本标“待实现/关闭”", { timeout: 120_000 }, async () => {
    const broken: ExecDomainFactory = {
      id: "W-core",
      label: "W-core（测试：拉起失败）",
      async create() {
        throw new Error("执行域自检未通过：网络未关闭（测试注入）");
      },
    };
    const rt = newRuntime(broken, "broken");
    const prev = getGlobalDispatcher();
    const eg = new HostEgressDispatcher({ modelSocket: model.socket, toolsSocket: join(base, "t.sock"), authority: rt.authority });
    setGlobalDispatcher(eg);
    try {
      const engine = await rt.matterEngine("m_broken");
      assert.equal(engine.router.currentDomain().id, "none");
      assert.match(engine.execDomainError ?? "", /网络未关闭/);
      const M = "P2BROKEN";
      model.setScript(sequence(M, [["Bash", { command: "echo hi" }]]));
      const r = await rt.startRun({ matter_id: "m_broken", goal: `${M} 试运行`, mode: "auto", plan_first: false }, DESKTOP);
      const done = await waitStatus(rt, r.run_id, (s) => TERMINAL.includes(s));
      assert.equal(done.status, "succeeded");
      const req = lastRequestFor(M).body;
      const toolNames = (req.tools ?? []).map((t: any) => t.function?.name ?? t.name);
      assert.ok(!toolNames.includes("Bash"), "执行域不可用时 Bash 对模型不可见");
      assert.doesNotMatch(toolText(req, `${M}_0`), /^hi/);
      const sys = JSON.stringify(req.messages.find((m: any) => m.role === "system")?.content ?? "");
      assert.doesNotMatch(sys, /执行环境说明（宿主提供）/);
      // 能力账本如实（审查 S3-08）：设备自检不通过 → 代码执行“关闭”，标注“未隔离：不运行代码”并给出原因，不再标 W-core
      const shellRow = (await rt.capabilities()).find((x) => x.family === "Shell 与代码执行")!;
      assert.equal(shellRow.current, "disabled");
      assert.match(String(shellRow.note), /未隔离：不运行代码/);
      assert.match(String(shellRow.note), /网络未关闭/);
      assert.doesNotMatch(String(shellRow.note), /运行时隔离：W-core/);
    } finally {
      await rt.close();
      setGlobalDispatcher(prev);
      await eg.close();
    }
  });
});
