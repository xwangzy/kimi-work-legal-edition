/**
 * 测试用桩宿主（复核 B4-B07/B4-B08/B4-B11）：按 kap-host 的 IPC 协议只实现取消路径需要的方法（startRun / events / cancel / forceCancel），
 * 用来稳定复现真实引擎难以卡准的时刻——取消与确认卡同时到达（状态版本持续变化）、强制取消失败、发起人不一致、宿主已先收尾。
 * 行为由数据根下的 stub-mode.json 决定（每次调用现读）；收到的调用按顺序记入 calls.log。同一事项同时只允许一个运行（与真实宿主同口径）。
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface StubRun {
  matterId: string;
  status: string;
  version: number;
  seq: number;
  cancelCalls: number;
}

let dataRoot = "";
const runs = new Map<string, StubRun>();
const active = new Map<string, string>();
const TERMINAL = new Set(["succeeded", "partial", "failed", "cancelled"]);

const mode = (): { cancel?: "ok" | "conflict" | "conflict_once" | "forbidden"; force?: "ok" | "fail"; events?: "live" | "settled"; shutdown_delay_ms?: number } => {
  try {
    return JSON.parse(readFileSync(join(dataRoot, "stub-mode.json"), "utf8"));
  } catch {
    return {};
  }
};
const send = (m: unknown): void => {
  if (process.connected) process.send?.(m);
};
const fail = (code: string, message: string) => Object.assign(new Error(message), { code });
const runOf = (id: unknown): StubRun => {
  const r = runs.get(String(id));
  if (!r) throw fail("not_found", "运行不存在");
  return r;
};
const finish = (runId: string, by: string): void => {
  const r = runs.get(runId)!;
  if (TERMINAL.has(r.status)) return;
  r.status = "cancelled";
  r.version += 1;
  if (active.get(r.matterId) === runId) active.delete(r.matterId);
  send({ t: "event", run_id: runId, event: { seq: ++r.seq, at: new Date().toISOString(), type: "run.cancelled", payload: { reason: by } } });
};

const methods: Record<string, (p: any) => unknown> = {
  startRun(p) {
    const mid = String(p.request.matter_id);
    if (active.has(mid)) throw fail("conflict", "这个事项里还有一个任务在进行，请等它完成或取消后再开始（同一事项同时只运行一个任务）");
    runs.set(String(p.request.run_id), { matterId: mid, status: "running", version: 1, seq: 0, cancelCalls: 0 });
    active.set(mid, String(p.request.run_id));
    return { run_id: p.request.run_id, session_id: "s", status: "running", mode: "default", state_version: 1 };
  },
  events(p) {
    const r = runOf(p.run_id);
    const m = mode();
    const v = r.version;
    // 确认卡恰在读取版本之后到达：每次读取后版本都变（持续的版本冲突）
    if (m.cancel === "conflict") r.version += 1;
    return { events: [], next_seq: r.seq, status: m.events === "settled" ? "succeeded" : r.status, state_version: v };
  },
  cancel(p) {
    const r = runOf(p.run_id);
    const m = mode();
    r.cancelCalls += 1;
    if (m.cancel === "forbidden") throw fail("forbidden", "只有发起该运行的律师可以操作");
    if (m.cancel === "conflict_once" && r.cancelCalls === 1) {
      r.version += 1;
      throw fail("conflict", "状态已变化，请刷新后重试");
    }
    if (TERMINAL.has(r.status)) throw fail("conflict", `运行已结束（${r.status}）`);
    if (p.request?.expected_state_version !== r.version) throw fail("conflict", "状态已变化，请刷新后重试");
    finish(String(p.run_id), "用户取消");
    return { status: r.status };
  },
  forceCancel(p) {
    const r = runOf(p.run_id);
    if (mode().force === "fail") throw fail("internal", "模拟：引擎没有响应中止");
    finish(String(p.run_id), "kernel");
    return { status: r.status };
  },
  capabilities: () => [],
};

process.on("message", (m: any) => {
  if (m?.t === "init") {
    dataRoot = String(m.config?.dataRoot ?? "");
    send({ t: "ready", capabilities: [] });
    return;
  }
  if (m?.t === "call") {
    appendFileSync(join(dataRoot, "calls.log"), `${m.method}\n`);
    const fn = Object.hasOwn(methods, m.method) ? methods[m.method] : undefined;
    try {
      if (!fn) throw fail("not_found", `未知方法：${m.method}`);
      send({ t: "result", id: m.id, ok: true, result: fn(m.params ?? {}) });
    } catch (e) {
      send({ t: "result", id: m.id, ok: false, error: { code: (e as { code?: string }).code ?? "internal", message: (e as Error).message } });
    }
    return;
  }
  if (m?.t === "shutdown") {
    // 模拟宿主收尾需要时间（复核 B4-R11：内核的 close 须等它真正退出）
    const ms = Number(mode().shutdown_delay_ms ?? 0);
    if (ms > 0) setTimeout(() => process.exit(0), ms);
    else process.exit(0);
  }
});
process.on("disconnect", () => process.exit(0));
