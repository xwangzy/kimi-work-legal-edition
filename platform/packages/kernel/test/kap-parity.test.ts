/**
 * SDK 宿主退役（Kimi Code 增量核查 K9-1）：旧宿主管理器（agent-host-manager）的测试所守的不变量，在 kap 适配器上逐条复核（桩宿主稳定复现）。
 * - R-01 任何退出路径都撤销任务令牌：正常结束、失败、取消、启动失败、宿主异常退出；
 * - M-01 只认第一条终态：之后再来的终态与成果被忽略；
 * - F1 未登记的事件类型不是终态（“结束原因未知”不能当成功）；宿主报的工作时限与总时长原因记为超时。
 * 不再适用、未迁移的（kap 宿主是长驻进程、控制只经 IPC）：每任务进程组与孙进程清理（R-02、F6 宽限终止）、stdout 被逃逸进程持有（N-06）、
 * stdout 事件协议的结束原因白名单（F1 管理器部分）——由 IPC 通道、W 执行域每调用 worker 与父进程心跳覆盖（见 kap-host 与 exec-wasm 用例）。
 */
process.env.ZR_INTERNAL_SECRET = process.env.ZR_INTERNAL_SECRET ?? "kap-parity-test-secret-0123456789a";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createKapAgentClient } from "../src/executor/kap-agent-client.ts";
import { Semaphore } from "../src/mutex.ts";

const STUB = fileURLToPath(new URL("./stub-kap-host.ts", import.meta.url));

function stubClient() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kwl-kapparity-")));
  const revoked: string[] = [];
  const client = createKapAgentClient({
    entryPath: STUB,
    dataRoot: root,
    kernelSocket: join(root, "k.sock"),
    trustedRgPath: null,
    manifests: () => [],
    legalMcpTools: [],
    matterPolicy: () => ({ dataLevel: "L2", basisComplete: true, fetchAllowlist: [], allowedPreauthorizations: [], budget: { maxToolCalls: 10, maxSubagents: 0 }, maxMode: "default", purpose: "legal_analysis" }),
    ioMutex: new Semaphore(4),
    revokeToken: (jti) => revoked.push(jti),
  });
  const setMode = (m: Record<string, unknown>) => writeFileSync(join(root, "stub-mode.json"), JSON.stringify(m));
  const id = (mid: string, rid: string) => ({ tid: "t", uid: "u", mid, rid, aid: "a1", fence: 1 });
  const start = async (mid: string, rid: string) => {
    mkdirSync(join(root, mid, "work"), { recursive: true });
    return client.start(id(mid, rid), { goal: "x", materials: [] });
  };
  const settle = async (taskId: string, ms = 10_000) => {
    const until = Date.now() + ms;
    for (;;) {
      const p = await client.poll(id("", ""), taskId, 0);
      if (p.status !== "starting" && p.status !== "running") return p;
      if (Date.now() > until) return p;
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  return { root, client, setMode, id, start, settle, revoked };
}

test("K9-1/R-01 任何退出路径都撤销任务令牌：成功、失败、取消、启动失败、宿主异常退出", { timeout: 60_000 }, async () => {
  const s = stubClient();
  try {
    s.setMode({ after_start: [{ type: "run.succeeded", payload: { final_text: "结论" } }] });
    const t1 = await s.start("m1", "r1");
    assert.equal((await s.settle(t1)).status, "succeeded");
    assert.ok(s.revoked.includes(t1), "成功收尾撤销令牌");

    s.setMode({ after_start: [{ type: "run.failed", payload: { reason: "provider_error", error: "x" } }] });
    const t2 = await s.start("m2", "r2");
    assert.equal((await s.settle(t2)).status, "failed");
    assert.ok(s.revoked.includes(t2), "失败收尾撤销令牌");

    s.setMode({});
    const t3 = await s.start("m3", "r3");
    await s.client.cancel(s.id("m3", "r3"), t3, "用户取消");
    assert.ok(s.revoked.includes(t3), "取消撤销令牌");

    s.setMode({ start: "fail" });
    await assert.rejects(s.start("m4", "r4"), /启动失败/);
    assert.ok(s.revoked.includes("kap_r4_a1"), "启动失败撤销令牌");

    s.setMode({ after_start: ["crash"] });
    const t5 = await s.start("m5", "r5");
    const p5 = await s.settle(t5);
    assert.equal(p5.status, "failed");
    assert.equal(p5.reason, "host_exited");
    assert.ok(s.revoked.includes(t5), "宿主异常退出也撤销令牌");
  } finally {
    await s.client.close();
  }
});

test("K9-1/M-01 只认第一条终态：之后的终态与成果被忽略；F1 未登记的事件类型不是终态；宿主报的时限原因记为超时", { timeout: 60_000 }, async () => {
  const s = stubClient();
  try {
    s.setMode({
      after_start: [
        { type: "run.partial", payload: { final_text: "第一份结论" } },
        { type: "run.succeeded", payload: { final_text: "伪造的第二份结论" } },
        { type: "run.failed", payload: { reason: "x" } },
      ],
    });
    const t1 = await s.start("m1", "r1");
    const p1 = await s.settle(t1);
    // 等后续事件也送达，再断言没有被改写
    await new Promise((r) => setTimeout(r, 300));
    const again = await s.client.poll(s.id("", ""), t1, 0);
    assert.equal(p1.status, "partial");
    assert.equal(again.status, "partial");
    assert.equal(again.artifacts.length, 1);
    assert.equal(Buffer.from(again.artifacts[0]!.bytes).toString("utf8"), "第一份结论");

    s.setMode({ after_start: [{ type: "run.done", payload: { final_text: "未登记的结束" } }, { type: "run.completed" }] });
    const t2 = await s.start("m2", "r2");
    await new Promise((r) => setTimeout(r, 500));
    const p2 = await s.client.poll(s.id("", ""), t2, 0);
    assert.equal(p2.status, "running", "未登记的事件类型不改变状态");
    assert.equal(p2.artifacts.length, 0);
    assert.ok(!s.revoked.includes(t2));
    await s.client.cancel(s.id("m2", "r2"), t2, "收尾");

    s.setMode({ after_start: [{ type: "run.failed", payload: { reason: "run_deadline_exceeded" } }] });
    const t3 = await s.start("m3", "r3");
    assert.equal((await s.settle(t3)).status, "timed_out");
    s.setMode({ after_start: [{ type: "run.failed", payload: { reason: "run_wall_deadline_exceeded" } }] });
    const t4 = await s.start("m4", "r4");
    assert.equal((await s.settle(t4)).status, "timed_out");
  } finally {
    await s.client.close();
  }
});
