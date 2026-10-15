/**
 * 统一脱敏日志器（v9.2 §3.6、调研 Y5 §5.2 / P1-1）：登记表外的事件码、字段与自由文本一律被拒；异常只取构造器名与错误码；
 * 记录编号写盘前加盐 hash；子进程 stderr 只认日志器 JSON 行；轮转与保留。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { FileSink, SafeLog, errFields, loadOrCreateSalt, readLogs, relayChildStderr, validateEvent, type LogRecord } from "../src/index.ts";

const CANARY = "张三丰金丝雀";

function memLog(): { log: SafeLog; out: LogRecord[] } {
  const log = new SafeLog();
  const out: LogRecord[] = [];
  log.setSink({ write: (r) => out.push(r) });
  return { log, out };
}

test("登记表：未登记的事件码、字段、自由文本、路径、中文与超出枚举的值一律被拒，只留一条不含原值的拒绝记录", () => {
  const { log, out } = memLog();
  const bad: [unknown, unknown][] = [
    ["NOT_REGISTERED", {}],
    ["TOOLS_TOOL_HIDDEN", { tool: CANARY }],
    ["TOOLS_TOOL_HIDDEN", { tool: "/Users/x/材料.docx" }],
    ["TOOLS_TOOL_HIDDEN", { tool: "materials list" }],
    ["TOOLS_TOOL_HIDDEN", { tool: "materials.list", note: "额外字段" }],
    ["TOOLS_TOOL_HIDDEN", {}],
    ["KERNEL_RUNS_RECOVERED", { count: "3", parked: false }],
    ["KERNEL_RUNS_RECOVERED", { count: 1.5, parked: false }],
    ["KERNEL_STARTED", { engine: "kap", at_rest: "maybe", control_plane: "dev" }],
    ["KERNEL_CHECKPOINT_FAILED", { err_code: `ENOENT: ${CANARY}` }],
    ["QUEUE_WORKFLOW_ERROR", { run: "run_1 张三" }],
    ["KERNEL_CLOSED", "自由文本"],
  ];
  for (const [code, f] of bad) assert.equal(log.ingest("kernel", code, f), false, JSON.stringify([code, f]));
  assert.equal(log.rejected, bad.length);
  const text = JSON.stringify(out);
  assert.ok(!text.includes(CANARY) && !text.includes("/Users") && !text.includes("NOT_REGISTERED") && !text.includes("额外字段"));
  assert.ok(out.every((r) => r.code === "SAFE_LOG_REJECTED"));
  assert.deepEqual(new Set(out.map((r) => r.f.cause)), new Set(["unknown_code", "bad_value", "bad_field", "missing_field", "malformed"]));
});

test("合规事件按登记的级别写出；低于当前级别的不写；debug 临时开启到期自动回 info", () => {
  const { log, out } = memLog();
  log.event("TOOLS_TOOL_HIDDEN", { tool: "materials.list" });
  log.event("CHILD_STDERR_UNSTRUCTURED", { proc: "gate", lines: 3 }); // debug：缺省不写
  assert.deepEqual(out.map((r) => [r.code, r.lvl, r.proc]), [["TOOLS_TOOL_HIDDEN", "error", "kernel"]]);
  log.setLevel("debug", 50);
  log.event("CHILD_STDERR_UNSTRUCTURED", { proc: "gate", lines: 3 });
  assert.equal(out.at(-1)!.code, "CHILD_STDERR_UNSTRUCTURED");
  const until = Date.now() + 80;
  while (Date.now() < until) {
    // 等过期
  }
  assert.equal(log.currentLevel(), "info");
  const n = out.length;
  log.event("CHILD_STDERR_UNSTRUCTURED", { proc: "gate", lines: 3 });
  assert.equal(out.length, n);
});

test("异常只取构造器名与错误码：message 与栈不进日志", () => {
  const e = Object.assign(new TypeError(`读取 ${CANARY} 的文件 /Users/x/a.docx 失败`), { code: "ENOENT" });
  assert.deepEqual(errFields(e), { err_name: "TypeError", err_code: "ENOENT" });
  assert.deepEqual(errFields(Object.assign(new Error("x"), { code: `坏码 ${CANARY}` })), { err_name: "Error" });
  assert.deepEqual(errFields("字符串异常"), {});
  assert.ok(validateEvent("KERNEL_CHECKPOINT_FAILED", errFields(e)).ok);
});

test("写盘：记录编号按本机盐 hash 成 12 位；同盐稳定、换盐不同；读回只认合规行", () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-slog-"));
  try {
    const salt = loadOrCreateSalt(join(dir, ".salt"));
    assert.deepEqual(loadOrCreateSalt(join(dir, ".salt")), salt, "盐稳定");
    const sink = new FileSink({ dir: join(dir, "logs"), salt });
    const log = new SafeLog();
    log.setSink(sink);
    log.event("QUEUE_WORKFLOW_ERROR", { run: "run_secret_123", err_name: "Error" });
    const files = readdirSync(join(dir, "logs"));
    assert.equal(files.length, 1);
    assert.match(files[0]!, /^kwl-\d{8}\.jsonl$/);
    const raw = readFileSync(join(dir, "logs", files[0]!), "utf8");
    assert.ok(!raw.includes("run_secret_123"));
    const rec = JSON.parse(raw.trim());
    assert.equal(rec.f.run, sink.hashId("run_secret_123"));
    assert.match(rec.f.run, /^[a-p]{12}$/);
    const other = new FileSink({ dir: join(dir, "logs2"), salt: Buffer.alloc(32, 7) });
    assert.notEqual(other.hashId("run_secret_123"), rec.f.run);
    // 读回：手工追加的非法行被跳过
    writeFileSync(join(dir, "logs", files[0]!), raw + `{"t":"2026-10-14T00:00:00Z","lvl":"info","code":"TOOLS_TOOL_HIDDEN","proc":"kernel","f":{"tool":"${CANARY}"}}\nnot json\n`);
    const back = readLogs(join(dir, "logs"), Date.now() - 86400_000);
    assert.equal(back.records.length, 1);
    assert.equal(back.skipped, 2);
    // 复核 S5A-08：多出的顶层键不带出；级别与登记表不符的行跳过
    const line = JSON.parse(raw.trim());
    writeFileSync(join(dir, "logs", files[0]!), `${JSON.stringify({ ...line, extra: CANARY })}\n${JSON.stringify({ ...line, lvl: "debug" })}\n`);
    const back2 = readLogs(join(dir, "logs"), Date.now() - 86400_000);
    assert.equal(back2.records.length, 1);
    assert.equal(back2.skipped, 1);
    assert.ok(!JSON.stringify(back2.records).includes(CANARY));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("轮转与保留：单文件上限换序号；超过保留期删除；总量超限从最旧删起", () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-slog-rot-"));
  try {
    let t = Date.parse("2026-10-14T08:00:00Z");
    writeFileSync(join(dir, "kwl-20260901.jsonl"), "x\n"); // 超过 14 天
    writeFileSync(join(dir, "kwl-20261010.jsonl"), "y".repeat(3000)); // 保留期内、最旧
    writeFileSync(join(dir, "unrelated.txt"), "keep");
    const sink = new FileSink({ dir, salt: Buffer.alloc(32, 1), maxFileBytes: 400, maxTotalBytes: 2500, now: () => t });
    assert.ok(!readdirSync(dir).includes("kwl-20260901.jsonl"), "超期删除");
    assert.ok(!readdirSync(dir).includes("kwl-20261010.jsonl"), "总量超限删最旧");
    assert.ok(readdirSync(dir).includes("unrelated.txt"), "不认识的文件不动");
    const log = new SafeLog();
    log.setSink(sink);
    for (let i = 0; i < 12; i++) log.event("EXECUTOR_PROVIDER_RETRY", { step: "draft", attempt: i, delay_ms: 500 });
    const today = readdirSync(dir).filter((n) => n.startsWith("kwl-20261014")).sort();
    assert.ok(today.length >= 3, `按大小换序号：${today.join(",")}`);
    t += 86400_000;
    log.event("KERNEL_CLOSED", {});
    assert.ok(readdirSync(dir).includes("kwl-20261015.jsonl"), "跨日换文件");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("子进程 stderr：只认日志器 JSON 行并重新核验；进程名由内核标注；其余行只计数不保存", async () => {
  const { log, out } = memLog();
  const s = new PassThrough();
  const relay = relayChildStderr(s, "gate", log);
  s.write(`${JSON.stringify({ kwl: 1, lvl: "error", code: "GATE_RECORD_WRITE_FAILED", f: { err_code: "EIO" } })}\n`);
  s.write(`(node:123) Warning: ${CANARY}\n`);
  s.write(`${JSON.stringify({ kwl: 1, code: "TOOLS_TOOL_HIDDEN", f: { tool: CANARY } })}\n`); // 合 JSON 不合登记表
  s.write(`{"kwl":1,"code":"KAP_SEALED_LOG_QUARANTINED","f":{}}`); // 无换行，结束时处理
  s.end();
  await new Promise((r) => setImmediate(r));
  assert.equal(relay.unstructured(), 1);
  assert.ok(!JSON.stringify(out).includes(CANARY));
  const codes = out.map((r) => `${r.proc}:${r.code}`);
  assert.deepEqual(codes, ["gate:GATE_RECORD_WRITE_FAILED", "kernel:SAFE_LOG_REJECTED", "gate:KAP_SEALED_LOG_QUARANTINED"]);
  // 计数事件是 debug 级：缺省不写，但计数可取
  log.setLevel("debug");
  const s2 = new PassThrough();
  relayChildStderr(s2, "parse", log);
  s2.end("一行非结构化输出\n");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(out.at(-1)!.f, { proc: "parse", lines: 1 });
});

test("复核 S5A-10：同一进程同一事件码每分钟最多 120 条，超出只计数", () => {
  const { log, out } = memLog();
  for (let i = 0; i < 200; i++) log.event("TOOLS_TOOL_HIDDEN", { tool: "materials.list" });
  assert.equal(out.length, 120);
  assert.equal(log.dropped, 80);
});

