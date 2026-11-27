/**
 * 按新身份重启内核的编排（复核 B13-K03）：关闭期间开始退出/安装更新 → 不再拉起；拉起抛错 → 广播 stopped、不拒绝；并发请求合并。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createIdentityRestart } = require("../electron/identity-restart.cjs");

function harness(o: { failStart?: boolean; exitDuringStop?: boolean; onStart?: () => void } = {}) {
  const log: string[] = [];
  let exiting = false;
  const r = createIdentityRestart({
    stop: async () => {
      log.push("stop");
      if (o.exitDuringStop) exiting = true;
      await new Promise((res) => setTimeout(res, 5));
    },
    start: async () => {
      log.push("start");
      o.onStart?.();
      await new Promise((res) => setTimeout(res, 5));
      if (o.failStart) throw new Error("随包运行时缺少 node.exe");
    },
    exiting: () => exiting,
    broadcast: (p: { status: string }) => log.push(`status:${p.status}`),
    onError: () => log.push("error"),
  });
  return { r, log, setExiting: () => (exiting = true) };
}

test("正常：restarting → stop → start → running", async () => {
  const h = harness();
  assert.equal(await h.r.restart(), "restarted");
  assert.deepEqual(h.log, ["status:restarting", "stop", "start", "status:running"]);
});

test("关闭期间开始退出或安装更新：不再拉起内核", async () => {
  const h = harness({ exitDuringStop: true });
  assert.equal(await h.r.restart(), "skipped");
  assert.deepEqual(h.log, ["status:restarting", "stop"]);
});

test("已在退出：什么都不做", async () => {
  const h = harness();
  h.setExiting();
  assert.equal(await h.r.restart(), "skipped");
  assert.deepEqual(h.log, []);
});

test("拉起抛错：记错误并广播 stopped，Promise 不拒绝", async () => {
  const h = harness({ failStart: true });
  assert.equal(await h.r.restart(), "failed");
  assert.deepEqual(h.log, ["status:restarting", "stop", "start", "error", "status:stopped"]);
});

// 第 72 批（A1 H4）：原期望“并发请求合并为一次”（第二个请求直接拿正在跑的那次的结果）。在拉起之前到的请求由本次满足，这一条不变；
// 新增：拉起开始之后才到的请求（新激活记录、换账号交接是之后才写的）不再被吞掉，本次结束后补跑一次
test("拉起之前到达的并发请求合并为一次", async () => {
  const h = harness();
  const [a, b] = await Promise.all([h.r.restart(), h.r.restart()]);
  assert.equal(a, "restarted");
  assert.equal(b, "restarted");
  assert.equal(h.log.filter((x) => x === "start").length, 1);
});

test("拉起开始之后才到的请求不丢：本次结束后补跑一次（多次合并为一次）", async () => {
  let later: Promise<string>[] = [];
  const h = harness({
    onStart: () => {
      if (later.length === 0) later = [h.r.restart("正在切换账号…"), h.r.restart()];
    },
  });
  assert.equal(await h.r.restart(), "restarted");
  assert.deepEqual(await Promise.all(later), ["restarted", "restarted"]);
  assert.equal(h.log.filter((x) => x === "start").length, 2, "补跑一次");
  assert.deepEqual(h.log, ["status:restarting", "stop", "start", "status:running", "status:restarting", "stop", "start", "status:running"]);
  assert.equal(h.r.busy(), false);
  assert.equal(h.r.stats().done, 2);
});

test("补跑时应用已在退出：补跑跳过", async () => {
  let later: Promise<string> | null = null;
  let exitNow = () => {};
  const h = harness({
    onStart: () => {
      if (!later) {
        later = h.r.restart();
        exitNow();
      }
    },
  });
  exitNow = h.setExiting;
  assert.equal(await h.r.restart(), "skipped");
  assert.equal(await later, "skipped");
  assert.equal(h.log.filter((x) => x === "start").length, 1);
});

test("激活门禁取不到内核状态：退避重试、第 20 次失败才放弃（不当作已激活；复核 B13-K01）", async () => {
  const { bootRetryDelay, BOOT_MAX_ATTEMPTS } = await import("../src/lib/boot-gate.ts");
  assert.deepEqual([1, 2, 3, 4, 5, 19].map(bootRetryDelay), [1000, 2000, 4000, 8000, 8000, 8000]);
  assert.equal(bootRetryDelay(BOOT_MAX_ATTEMPTS), null);
  let total = 0;
  for (let i = 1; i < BOOT_MAX_ATTEMPTS; i++) total += bootRetryDelay(i)!;
  assert.ok(total >= 120_000, `放弃前至少等两分钟（首次启动内核较慢），实际 ${total} 毫秒`);
});
