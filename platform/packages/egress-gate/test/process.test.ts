/**
 * 闸门进程形态（第 04 篇 §1.1）：由内核 fork、只经 IPC 取授权、只监听本机套接字；内核不回答或断开即失败关闭；内核断开闸门即退出。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));

function post(socket: string, path: string, body: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request({ socketPath: socket, path, method: "POST", headers: { authorization: "Bearer tok", "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

test("闸门进程：fork 后经 IPC 取授权；内核拒绝即拒绝、内核不回答即超时拒绝（失败关闭）；去向记录回送内核；内核断开即退出并清理套接字", { timeout: 60_000 }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kwl-gatep-")));
  const socketPath = join(dir, "g.sock");
  const child = fork(entry, [], { stdio: ["ignore", "ignore", "pipe", "ipc"], env: {} });
  const records: unknown[] = [];
  let mode: "deny" | "silent" = "deny";
  child.on("message", (m: any) => {
    if (m?.t === "call" && m.method === "authorize") {
      if (mode === "deny") child.send({ t: "result", id: m.id, ok: true, result: { ok: false, status: 403, reason: "run_not_live" } });
      // silent：不回答
    }
    if (m?.t === "record") records.push(m.rec);
  });
  await new Promise<void>((resolve, reject) => {
    child.on("message", (m: any) => {
      if (m?.t === "ready") resolve();
      if (m?.t === "fatal") reject(new Error(m.message));
    });
    child.send({ t: "init", config: { socketPath, upstreams: { model: null, search: null, fetch: "disabled" }, authorizeTimeoutMs: 800 } });
  });
  assert.ok(existsSync(socketPath));
  const denied = await post(socketPath, "/m/m1/v1/chat/completions", { messages: [] });
  assert.equal(denied.status, 403);
  assert.equal(JSON.parse(denied.text).error.code, "run_not_live");
  mode = "silent";
  const t0 = Date.now();
  const timeout = await post(socketPath, "/m/m1/search", { text_query: "x" });
  assert.equal(timeout.status, 503);
  assert.equal(JSON.parse(timeout.text).error.code, "authorize_timeout");
  assert.ok(Date.now() - t0 < 3_000);
  const exited = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
  child.disconnect();
  assert.equal(await exited, 0);
  assert.equal(existsSync(socketPath), false, "退出时清理套接字");
});
