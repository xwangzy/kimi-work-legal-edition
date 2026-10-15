/**
 * 父进程心跳看门狗（第 4 批复核 B4-A13）：Windows 上父进程退出后子进程的 ppid 不变、PID 复用很快，kill(pid,0) 判不了存活；
 * 子进程在 KWL_PARENT_HEARTBEAT_MS 存在时改看父进程心跳——收不到心跳（至少 30 秒）即退出，按时收到则继续运行。
 * 用出站闸门进程验证（另两处子进程——Agent 宿主与 W 监督进程——是同一段实现）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PARENT_HEARTBEAT_MS, parentHeartbeatEnv, startParentHeartbeat } from "../src/executor/child-env.ts";

const GATE = fileURLToPath(new URL("../../egress-gate/src/main.ts", import.meta.url));

test("父进程心跳：收不到心跳的子进程在限期内退出；按时收到心跳的子进程继续运行", { timeout: 90_000 }, async () => {
  const env = { PATH: process.env.PATH ?? "", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...parentHeartbeatEnv() };
  const starved = fork(GATE, [], { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"], env });
  const fed = fork(GATE, [], { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"], env });
  startParentHeartbeat(fed);
  const exited = new Promise<number>((resolve) => starved.once("exit", () => resolve(Date.now())));
  const t0 = Date.now();
  try {
    const at = await Promise.race([exited, new Promise<number>((r) => setTimeout(() => r(-1), 45_000))]);
    assert.ok(at > 0, "收不到心跳的子进程应在 45 秒内退出");
    assert.ok(at - t0 >= 28_000, `不应过早退出（${at - t0} ms；限期至少 30 秒，留出主线程忙的余地）`);
    assert.equal(fed.exitCode, null, "按时收到心跳的子进程应继续运行");
    assert.equal(fed.connected, true);
    assert.equal(PARENT_HEARTBEAT_MS, 2_000);
  } finally {
    starved.kill();
    fed.kill();
  }
});
