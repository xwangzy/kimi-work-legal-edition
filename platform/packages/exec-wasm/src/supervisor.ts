/**
 * W 监督进程（v9 第 04 篇 §4.1，每事项一个）。由 Agent 宿主（host.ts）以如下方式拉起：
 *
 *   node --permission --allow-fs-read=<运行时目录>/* --allow-fs-read=<材料快照>/* --allow-fs-read=<事项工作区>/* \
 *        --allow-fs-write=<任务临时目录>/* --allow-worker supervisor.ts <just-bash 入口> <并发数> <内存上限 MB>
 *
 * 不授予 --allow-net、--allow-child-process、--allow-addons、--allow-wasi、--allow-ffi。本进程不写工作区——工作区写入留在
 * worker 的内存层，由宿主经文件 broker 校验后提交。与宿主只经 IPC 通信；宿主断开即退出。
 * 资源：每个 worker 的 JS 堆有上限；每次调用有**硬计时器**（时长上限 + 15 秒宽限，到点 terminate——just-bash 的时长上限是协作式的，
 * worker 卡在同步代码里时连 abort 也收不到：审查 S3-14）；排队有上限；进程常驻内存超限时先终止**最近启动**的 worker，
 * 冷却 750 ms 再复核，仍超限才继续（审查 S3-11：just-bash 的 python3 在嵌套 worker 中运行，无法按 worker 计量 WASM 内存，
 * 只能逐个终止并复核——如实登记）。
 *
 * 如实标注：这是“运行时隔离”（语言运行时 + Node 权限模型 + 进程资源限制），不是操作系统强制的沙箱；
 * Node 对 --allow-worker 给出“可能削弱权限模型”的安全警告——worker 内运行的是 just-bash 与零 JS 桥 CPython，不运行模型提供的 JS（js-exec 未开启）。
 */
import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Worker } from "node:worker_threads";
import type { ExecChunk, ExecRequest, ExecResult, SelftestResult, SupervisorRequest } from "./protocol.ts";

const [, , jbEntry = "", maxConcurrentArg = "2", rssLimitArg = "2048", hardGraceArg = "15000"] = process.argv;
const maxConcurrent = Math.max(1, Math.min(8, Number(maxConcurrentArg) || 2));
const rssLimitBytes = Math.max(256, Number(rssLimitArg) || 2048) * 1024 * 1024;

interface Job {
  req: ExecRequest;
  worker: Worker | null;
  done: boolean;
  graceTimer: NodeJS.Timeout | null;
  hardTimer: NodeJS.Timeout | null;
  startedAt: number;
}

/** 监督进程内的排队上限（宿主侧另有同一事项的排队上限）。 */
const MAX_QUEUE = 32;
/** 硬计时器在时长上限之外的宽限（缺省 15 秒；测试可调小）。 */
const HARD_TIMER_GRACE_MS = Math.max(100, Number(hardGraceArg) || 15_000);

const jobs = new Map<number, Job>();
const queue: Job[] = [];
let running = 0;

const send = (m: unknown): void => {
  if (process.connected) process.send?.(m);
};

function finish(job: Job, r: ExecResult): void {
  if (job.done) return;
  job.done = true;
  if (job.graceTimer) clearTimeout(job.graceTimer);
  if (job.hardTimer) clearTimeout(job.hardTimer);
  jobs.delete(job.req.id);
  const qi = queue.indexOf(job);
  if (qi >= 0) queue.splice(qi, 1);
  if (job.worker) {
    running -= 1;
    void job.worker.terminate().catch(() => {});
  }
  send(r);
  pump();
}

/** worker 入口：开发形态为同目录源码 worker.ts；随包运行时（scripts/build-runtime.mjs）为同目录 worker.mjs。 */
const WORKER_URL = new URL(import.meta.url.endsWith(".mjs") ? "./worker.mjs" : "./worker.ts", import.meta.url);

function startJob(job: Job): void {
  running += 1;
  job.startedAt = Date.now();
  job.hardTimer = setTimeout(
    () => kill(job, `执行超过硬时限（${(job.req.limits.maxExecutionTimeMs / 1000).toFixed(job.req.limits.maxExecutionTimeMs < 10_000 ? 1 : 0)} 秒），已强制终止`, "timeout"),
    job.req.limits.maxExecutionTimeMs + HARD_TIMER_GRACE_MS,
  );
  job.hardTimer.unref();
  const w = new Worker(WORKER_URL, {
    workerData: { req: job.req, jbEntry },
    // JS 堆上限（WASM 线性内存不受此约束——由进程看门狗兜底）
    resourceLimits: { maxOldGenerationSizeMb: 768 },
    stdout: true,
    stderr: true,
  });
  job.worker = w;
  w.on("message", (m: ExecChunk | ExecResult) => {
    if (job.done) return;
    if (m?.t === "chunk") send(m);
    else if (m?.t === "result") finish(job, m);
  });
  w.on("error", (e: Error) =>
    finish(job, { t: "result", id: job.req.id, stdout: "", stderr: `执行域错误：${e.message}\n`, exitCode: 1, reason: "error", changes: [], error: e.message }),
  );
  w.on("exit", (code: number) => {
    if (!job.done) finish(job, { t: "result", id: job.req.id, stdout: "", stderr: `执行域 worker 已终止（${code}）\n`, exitCode: 137, reason: "killed", changes: [] });
  });
}

function pump(): void {
  while (running < maxConcurrent && queue.length > 0) {
    const job = queue.shift()!;
    if (!job.done) startJob(job);
  }
  queue.forEach((j, i) => send({ t: "queued", id: j.req.id, position: i + 1 }));
}

function kill(job: Job, why: string, reason: "killed" | "timeout" = "killed"): void {
  // 强杀：worker.terminate()——Python 死循环也能终止；不殃及同事项其他命令；内存层改动丢弃
  finish(job, { t: "result", id: job.req.id, stdout: "", stderr: `${why}\n`, exitCode: reason === "timeout" ? 124 : 137, reason, changes: [] });
}

/** 授权范围外的系统文件（自检读它必须被权限模型拒绝）。 */
const SYSTEM_FILE = process.platform === "win32" ? `${process.env.SystemRoot ?? "C:\\Windows"}\\win.ini` : "/etc/passwd";

async function selftest(id: number): Promise<SelftestResult> {
  const perm = (process as unknown as { permission?: { has(scope: string, ref?: string): boolean } }).permission;
  let dns = "allowed";
  try {
    await lookup("example.com");
  } catch (e) {
    dns = (e as { code?: string }).code ?? "error";
  }
  let readEtc = "allowed";
  try {
    readFileSync(SYSTEM_FILE);
  } catch (e) {
    readEtc = (e as { code?: string }).code ?? "error";
  }
  return {
    t: "selftest",
    id,
    permission: {
      fsReadEtc: perm?.has("fs.read", SYSTEM_FILE) ?? true,
      fsWriteHome: perm?.has("fs.write", homedir()) ?? true,
      net: perm?.has("net") ?? true,
      child: perm?.has("child") ?? true,
      addon: perm?.has("addon") ?? true,
      wasi: perm?.has("wasi") ?? true,
      worker: perm?.has("worker") ?? false,
    },
    dns,
    readEtc,
    rss: process.memoryUsage().rss,
    node: process.version,
  };
}

process.on("message", (raw: unknown) => {
  const m = raw as SupervisorRequest;
  if (m?.t === "exec") {
    if (jobs.has(m.id)) return;
    if (queue.length >= MAX_QUEUE) {
      send({ t: "result", id: m.id, stdout: "", stderr: `执行域排队已满（${MAX_QUEUE} 条），请稍后再试\n`, exitCode: 1, reason: "error", changes: [] } satisfies ExecResult);
      return;
    }
    const job: Job = { req: m, worker: null, done: false, graceTimer: null, hardTimer: null, startedAt: 0 };
    jobs.set(m.id, job);
    queue.push(job);
    pump();
    return;
  }
  if (m?.t === "abort") {
    const job = jobs.get(m.id);
    if (!job) return;
    if (!job.worker) {
      finish(job, { t: "result", id: m.id, stdout: "", stderr: "已取消（排队中，未开始执行）\n", exitCode: 143, reason: "aborted", changes: [] });
      return;
    }
    // SIGTERM：协作式停止（下一语句边界）；宽限 5 秒后强杀
    job.worker.postMessage({ t: "abort" });
    if (!job.graceTimer) {
      job.graceTimer = setTimeout(() => kill(job, "取消宽限已过，执行已强制终止"), 5_000);
      job.graceTimer.unref();
    }
    return;
  }
  if (m?.t === "kill") {
    const job = jobs.get(m.id);
    if (job) kill(job, "执行已强制终止");
    return;
  }
  if (m?.t === "selftest") {
    void selftest(m.id).then(send);
    return;
  }
  if (m?.t === "shutdown") {
    for (const job of [...jobs.values()]) kill(job, "执行域关闭");
    process.exit(0);
  }
});

// 看门狗：常驻内存超限 → 先终止最近启动的 worker，冷却后复核（WASM 线性内存不受 worker resourceLimits 约束）
let cooldownUntil = 0;
const watchdog = setInterval(() => {
  if (Date.now() < cooldownUntil) return;
  if (process.memoryUsage().rss <= rssLimitBytes) return;
  const runningJobs = [...jobs.values()].filter((j) => j.worker && !j.done).sort((a, b) => b.startedAt - a.startedAt);
  const victim = runningJobs[0];
  if (!victim) return;
  kill(victim, "执行域内存超限，本命令已终止（请缩小数据规模或分批处理）");
  cooldownUntil = Date.now() + 750;
}, 250);
watchdog.unref();

process.on("disconnect", () => process.exit(0));
// 父进程看门狗（Kimi Code 增量核查 WR-3；第 4 批复核 B4-A13）：IPC 断开事件是主信号；看门狗只补“断开事件永远不来”的情形
// （例如管道句柄被子孙进程继承而保持打开）。父进程按 KWL_PARENT_HEARTBEAT_MS 每隔一段发 {t:"hb"}：
// - Windows：ppid 不随父进程退出而变、PID 复用很快，kill(pid,0) 判不了存活——改看心跳，30 秒（至少 5 个周期）没收到即退出；
// - 其他平台：父进程退出后 ppid 变为 1，沿用 ppid 判断（有心跳时同样检查心跳）；
// - 本进程事件循环自身卡顿（本次检查比预期晚 4 秒以上）时跳过一次：先让排队的心跳消息被处理，避免主线程忙时误判父进程已退出。
{
  const parentPid = process.ppid;
  const hbEvery = Number(process.env.KWL_PARENT_HEARTBEAT_MS ?? 0);
  const hbLimit = hbEvery > 0 ? Math.max(30_000, hbEvery * 5) : 0;
  let lastHb = Date.now();
  let lastTick = Date.now();
  process.on("message", (m: unknown) => {
    if ((m as { t?: unknown } | null)?.t === "hb") lastHb = Date.now();
  });
  const parentWatch = setInterval(() => {
    const now = Date.now();
    const lagged = now - lastTick > 6_000;
    lastTick = now;
    if (lagged) return;
    let alive = hbLimit > 0 ? now - lastHb <= hbLimit : true;
    if (alive && process.platform !== "win32" && process.ppid !== parentPid) alive = false;
    if (alive && hbLimit === 0) {
      try {
        process.kill(parentPid, 0);
      } catch (e) {
        alive = (e as NodeJS.ErrnoException).code === "EPERM";
      }
    }
    if (!alive) {
      clearInterval(parentWatch);
      process.exit(0);
    }
  }, 2_000);
  parentWatch.unref();
}

send({ t: "ready", pid: process.pid });
