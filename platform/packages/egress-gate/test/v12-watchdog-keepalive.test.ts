/**
 * V12：闸门模型看门狗“第三次未截断”（V10 第 36 批遗留）。
 *
 * 第 35 批的看门狗按“收到响应头”解除首字计时、按“收到任何字节”重置断档计时。上游（或其前置代理）先回 200 响应头、
 * 之后只发 SSE 注释保活（`: keep-alive`）、空行或不带任何输出的空增量块时，两个计时器都永远到不了点——请求挂到上游自己放弃为止
 * （V10 真实走查 V17：375 秒、965 秒；网关侧 undici 缺省的 300 秒头/体超时也没触发，说明期间一直有字节到达）。
 * 现在只有“模型确有输出”的数据（正文、思考、工具调用、结束原因、用量、错误、[DONE]，或非流式响应体的非空白字节）才算进展。
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, realpathSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EgressGateServer } from "../src/server.ts";
import { modelStreamProgress } from "../src/stream-progress.ts";
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

type Mode = "keepalive_only" | "content_then_keepalive" | "empty_delta_heartbeat" | "json_whitespace" | "alive_with_keepalive" | "reasoning_only";

function call(socket: string, stream = true): Promise<{ status: number; text: string; aborted: boolean; ms: number }> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const data = JSON.stringify({ model: "legal/k3", stream, messages: [{ role: "user", content: "你好" }] });
    const req = request({ socketPath: socket, path: "/m/m1/v1/chat/completions", method: "POST", headers: { "content-type": "application/json", authorization: "Bearer task-token-ok", "content-length": Buffer.byteLength(data) } }, (res) => {
      const chunks: Buffer[] = [];
      const done = (aborted: boolean) => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8"), aborted, ms: Date.now() - t0 });
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => done(false));
      res.on("aborted", () => done(true));
      res.on("error", () => done(true));
    });
    req.on("error", () => resolve({ status: 0, text: "", aborted: true, ms: Date.now() - t0 }));
    req.end(data);
  });
}

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

describe("V12 模型看门狗：保活与空增量不算进展", () => {
  let dir: string;
  let socket: string;
  let gate: EgressGateServer;
  let authority: Authority;
  let up: Server;
  let mode: Mode = "keepalive_only";
  const open = new Set<ServerResponse>();
  const timers = new Set<NodeJS.Timeout>();

  before(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "kwl-gate-dog12-")));
    socket = join(dir, "gate.sock");
    authority = new Authority();
    up = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        open.add(res);
        const every = (ms: number, f: (n: number) => boolean | void) => {
          let n = 0;
          const t = setInterval(() => {
            n += 1;
            if (res.destroyed || f(n) === false) {
              clearInterval(t);
              timers.delete(t);
            }
          }, ms);
          timers.add(t);
          res.on("close", () => {
            clearInterval(t);
            timers.delete(t);
          });
        };
        res.on("close", () => open.delete(res));
        if (mode === "json_whitespace") {
          // 非流式：先回响应头，之后只写空白保活（部分平台排队时的做法），永远不给响应体
          res.writeHead(200, { "content-type": "application/json" });
          res.write("\n");
          every(30, () => void res.write("\n"));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (mode === "keepalive_only") {
          // 先回响应头，之后只有注释保活（前置代理常见做法）——一个字也不出
          res.write(": keep-alive\n\n");
          every(30, () => void res.write(": keep-alive\n\n"));
          return;
        }
        if (mode === "content_then_keepalive") {
          res.write(sse({ choices: [{ index: 0, delta: { role: "assistant", content: "第一段" }, finish_reason: null }] }));
          every(30, () => void res.write(": keep-alive\n\n"));
          return;
        }
        if (mode === "empty_delta_heartbeat") {
          res.write(sse({ choices: [{ index: 0, delta: { role: "assistant", content: "第一段" }, finish_reason: null }] }));
          // 不带任何输出的空增量块（content 为空串、无思考、无工具调用、无结束原因）作心跳
          every(30, () => void res.write(sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "" }, finish_reason: null }] })));
          return;
        }
        if (mode === "reasoning_only") {
          // 思考模型：长时间只有 reasoning_content（确有输出），总时长超过断档上限也不能截断
          every(40, (n) => {
            if (n <= 8) res.write(sse({ choices: [{ index: 0, delta: { reasoning_content: `想${n}` }, finish_reason: null }] }));
            else {
              res.write(sse({ choices: [{ index: 0, delta: { content: "答" }, finish_reason: "stop" }] }));
              res.end("data: [DONE]\n\n");
              return false;
            }
          });
          return;
        }
        // alive_with_keepalive：保活与正常数据交替，正常数据间隔小于断档上限——不受影响
        every(40, (n) => {
          if (n <= 8) res.write(`: keep-alive\n\n${sse({ choices: [{ index: 0, delta: { content: `段${n}` }, finish_reason: null }] })}`);
          else {
            res.end("data: [DONE]\n\n");
            return false;
          }
        });
      });
    });
    await new Promise<void>((r) => up.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(up.address() as AddressInfo).port}/v1`;
    gate = new EgressGateServer({ authority, upstreams: { model: { baseUrl: url, seatToken: "seat-xyz" }, search: null, fetch: "off" } as any, modelWatchdog: { firstByteMs: 200, idleMs: 150 } });
    await gate.listen(socket);
  });

  after(async () => {
    for (const t of timers) clearInterval(t);
    for (const r of open) r.destroy();
    await gate.close();
    up.close();
  });

  const lastEnd = () => authority.records.filter((x) => x.phase === "end").at(-1)!;

  test("响应头之后只有注释保活：按首字超时截断（不等上游自己放弃）", async () => {
    mode = "keepalive_only";
    const r = await call(socket);
    assert.equal(r.aborted, true, "连接被断开，引擎按连接类错误重试");
    assert.ok(r.ms < 2_000, `应在首字上限附近截断，实际 ${r.ms} ms`);
    assert.equal(lastEnd().outcome, "failed");
    assert.equal(lastEnd().reason, "first_byte_timeout");
  });

  test("出过一段之后只有注释保活：按断档截断", async () => {
    mode = "content_then_keepalive";
    const r = await call(socket);
    assert.equal(r.aborted, true);
    assert.ok(r.text.includes("第一段") && !r.text.includes("[DONE]"));
    assert.ok(r.ms < 2_000, `实际 ${r.ms} ms`);
    assert.equal(lastEnd().reason, "stream_idle_timeout");
  });

  test("空增量心跳块（无正文、无思考、无工具调用、无结束原因）不算进展：按断档截断", async () => {
    mode = "empty_delta_heartbeat";
    const r = await call(socket);
    assert.equal(r.aborted, true);
    assert.ok(r.ms < 2_000, `实际 ${r.ms} ms`);
    assert.equal(lastEnd().reason, "stream_idle_timeout");
  });

  test("非流式：响应头之后只写空白保活，按首字超时截断", async () => {
    mode = "json_whitespace";
    const r = await call(socket, false);
    assert.equal(r.aborted, true);
    assert.ok(r.ms < 2_000, `实际 ${r.ms} ms`);
    assert.equal(lastEnd().reason, "first_byte_timeout");
  });

  test("保活与正常数据交替（正常数据间隔小于上限）：完整返回", async () => {
    mode = "alive_with_keepalive";
    const r = await call(socket);
    assert.equal(r.aborted, false);
    assert.ok(r.text.includes("段8") && r.text.includes("[DONE]"));
    assert.equal(lastEnd().outcome, "sent");
  });

  test("只有思考内容的长时间输出是进展：总时长超过断档上限仍完整返回", async () => {
    mode = "reasoning_only";
    const r = await call(socket);
    assert.equal(r.aborted, false);
    assert.ok(r.text.includes("想8") && r.text.includes("[DONE]"));
    assert.equal(lastEnd().outcome, "sent");
  });
});

describe("V12 进展判定（逐块、跨块拼行）", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  test("注释、空行、event/id 行、空增量不算；正文、思考、工具调用、结束原因、用量、错误、[DONE]、非 JSON 数据算", () => {
    const p = modelStreamProgress("text/event-stream");
    assert.equal(p(enc(": keep-alive\n\n")), false);
    assert.equal(p(enc("\n\n\r\n")), false);
    assert.equal(p(enc("event: ping\nid: 3\nretry: 1000\n\n")), false);
    assert.equal(p(enc(sse({ choices: [{ index: 0, delta: {}, finish_reason: null }] }))), false);
    assert.equal(p(enc(sse({ choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }))), false);
    assert.equal(p(enc(sse({ choices: [] }))), false);
    assert.equal(p(enc(sse({ choices: [{ index: 0, delta: { content: "甲" } }] }))), true);
    assert.equal(p(enc(sse({ choices: [{ index: 0, delta: { reasoning_content: "想" } }] }))), true);
    assert.equal(p(enc(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{" } }] } }] }))), true);
    assert.equal(p(enc(sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }))), true);
    assert.equal(p(enc(sse({ choices: [], usage: { prompt_tokens: 1 } }))), true);
    assert.equal(p(enc(sse({ error: { message: "x" } }))), true);
    assert.equal(p(enc("data: [DONE]\n\n")), true);
    assert.equal(p(enc("data: 不是 JSON\n\n")), true);
  });
  test("一行被拆成几块：拼完再判；行尾之前的半行不算", () => {
    const p = modelStreamProgress("text/event-stream");
    const line = sse({ choices: [{ index: 0, delta: { content: "甲乙丙" } }] });
    assert.equal(p(enc(line.slice(0, 20))), false);
    assert.equal(p(enc(line.slice(20))), true);
    const ka = ": keep-alive\n\n";
    assert.equal(p(enc(ka.slice(0, 5))), false);
    assert.equal(p(enc(ka.slice(5))), false);
  });
  test("非流式响应：非空白字节算进展，纯空白不算", () => {
    const p = modelStreamProgress("application/json");
    assert.equal(p(enc("\n \r\n\t")), false);
    assert.equal(p(enc('{"id":"x"')), true);
  });
});
