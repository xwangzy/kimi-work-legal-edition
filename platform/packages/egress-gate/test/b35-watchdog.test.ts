/**
 * 模型请求看门狗（第 35 批真实走查 N3/N4：上游一次调用挂住 12～16 分钟不出一个字，引擎不设超时，任务被拖到工作时限）：
 * 等响应头超时回 504（引擎按可重试状态码重发）；流式输出中途断档即断开连接（引擎按连接类错误重试）；持续有数据的慢流不受影响。
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, realpathSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EgressGateServer } from "../src/server.ts";
import type { AuthorizeResult, GateAuthority, GateEgressRecord, MatterEgressContext } from "../src/types.ts";

const KEY = Buffer.alloc(32, 7).toString("base64");
const CTX: MatterEgressContext = {
  tenantId: "t1",
  matterId: "m1",
  runId: "r1",
  userId: "u1",
  anonMatterId: "anon-7f3a",
  dataLevel: "L2",
  basisComplete: true,
  modelEndpoint: "standard",
  preauth: { searchGeneralized: false, images: false },
  l3aStandardAllowed: false,
  fetchAllowlist: [],
  policyVersion: 3,
  tokenizer: { keyB64: KEY, parties: [], table: [], fullPseudonym: false, tableVersion: 1 },
};

class Authority implements GateAuthority {
  readonly records: GateEgressRecord[] = [];
  async authorize(): Promise<AuthorizeResult> {
    return { ok: true, ctx: CTX };
  }
  record(rec: GateEgressRecord): void {
    this.records.push(rec);
  }
  tokens(): void {}
}

type Mode = "silent" | "stall_after_first" | "slow_alive";

function call(socket: string): Promise<{ status: number; text: string; aborted: boolean }> {
  return new Promise((resolve) => {
    const data = JSON.stringify({ model: "legal/k3", stream: true, messages: [{ role: "user", content: "你好" }] });
    const req = request({ socketPath: socket, path: "/m/m1/v1/chat/completions", method: "POST", headers: { "content-type": "application/json", authorization: "Bearer task-token-ok", "content-length": Buffer.byteLength(data) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8"), aborted: false }));
      res.on("aborted", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8"), aborted: true }));
      res.on("error", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8"), aborted: true }));
    });
    req.on("error", () => resolve({ status: 0, text: "", aborted: true }));
    req.end(data);
  });
}

describe("模型请求看门狗（第 35 批）", () => {
  let dir: string;
  let socket: string;
  let gate: EgressGateServer;
  let authority: Authority;
  let up: Server;
  let mode: Mode = "silent";
  const open = new Set<ServerResponse>();

  before(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "kwl-gate-dog-")));
    socket = join(dir, "gate.sock");
    authority = new Authority();
    up = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        open.add(res);
        res.on("close", () => open.delete(res));
        if (mode === "silent") return; // 一个字节也不回
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (mode === "stall_after_first") {
          res.write('data: {"choices":[{"delta":{"content":"第一段"}}]}\n\n');
          return; // 之后断档
        }
        // 慢但一直有数据：每 40 毫秒一段，共 8 段（总时长超过断档上限，单段间隔不超过）
        let n = 0;
        const t = setInterval(() => {
          n += 1;
          if (n <= 8) res.write(`data: {"choices":[{"delta":{"content":"段${n}"}}]}\n\n`);
          else {
            clearInterval(t);
            res.end("data: [DONE]\n\n");
          }
        }, 40);
      });
    });
    await new Promise<void>((r) => up.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(up.address() as AddressInfo).port}/v1`;
    gate = new EgressGateServer({ authority, upstreams: { model: { baseUrl: url, seatToken: "seat-xyz" }, search: null, fetch: "off" } as any, modelWatchdog: { firstByteMs: 150, idleMs: 120 } });
    await gate.listen(socket);
  });

  after(async () => {
    for (const r of open) r.destroy();
    await gate.close();
    up.close();
  });

  test("上游一直不回响应头：到点回 504（引擎按可重试状态码重发），去向记录写明原因", async () => {
    mode = "silent";
    const t0 = Date.now();
    const r = await call(socket);
    assert.equal(r.status, 504);
    assert.equal(JSON.parse(r.text).error.code, "first_byte_timeout");
    assert.ok(Date.now() - t0 < 2_000, "不等上游自己超时");
    const rec = authority.records.filter((x) => x.phase === "end").at(-1)!;
    assert.equal(rec.outcome, "failed");
    assert.equal(rec.reason, "first_byte_timeout");
  });

  test("流式输出中途断档：断开连接（客户端拿到不完整的流，不会当作正常结束），去向记录写明断档", async () => {
    mode = "stall_after_first";
    const r = await call(socket);
    assert.equal(r.status, 200);
    assert.equal(r.aborted, true, "连接被断开");
    assert.ok(r.text.includes("第一段") && !r.text.includes("[DONE]"));
    const rec = authority.records.filter((x) => x.phase === "end").at(-1)!;
    assert.equal(rec.reason, "stream_idle_timeout");
  });

  test("慢但持续有数据的流不受影响：总时长超过断档上限仍完整返回", async () => {
    mode = "slow_alive";
    const r = await call(socket);
    assert.equal(r.status, 200);
    assert.equal(r.aborted, false);
    assert.ok(r.text.includes("段8") && r.text.includes("[DONE]"));
    assert.equal(authority.records.filter((x) => x.phase === "end").at(-1)!.outcome, "sent");
  });
});
