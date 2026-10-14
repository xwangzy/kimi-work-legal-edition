/**
 * 席位令牌在闸门处的失效判断（阶段 6 复核 S6-A05、S6-B06）：令牌缺失、已清除或载荷里的到期时刻已过，模型与检索请求一律不发出
 * （`seat_unavailable`，上游零请求）；内核经 IPC 热更新为有效令牌后恢复。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import { mkdtempSync, realpathSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EgressGateServer, seatUsable } from "../src/server.ts";
import type { AuthorizeResult, GateAuthority, GateEgressRecord, MatterEgressContext } from "../src/types.ts";

const seat = (expSecondsFromNow: number) =>
  `zst1.${Buffer.from(JSON.stringify({ tid: "t1", uid: "u1", sid: "s1", dev: "d1", kid: "k", iat: 0, exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })).toString("base64url")}.sig`;

const ctx: MatterEgressContext = {
  tenantId: "t1",
  matterId: "m1",
  runId: "r1",
  userId: "u1",
  anonMatterId: "anon-1",
  dataLevel: "L2",
  basisComplete: true,
  modelEndpoint: "standard",
  preauth: { searchGeneralized: false, images: false },
  l3aStandardAllowed: false,
  fetchAllowlist: [],
  policyVersion: 1,
  tokenizer: { keyB64: Buffer.alloc(32, 3).toString("base64"), parties: [], table: [], fullPseudonym: false, tableVersion: 1 },
};

const records: GateEgressRecord[] = [];
const authority: GateAuthority = {
  async authorize(): Promise<AuthorizeResult> {
    return { ok: true, ctx };
  },
  record(rec) {
    records.push(rec);
  },
  tokens() {},
};

let upstream: Server;
let hits = 0;
let gate: EgressGateServer;
let socket = "";

before(async () => {
  upstream = createServer((req, res) => {
    hits += 1;
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "好" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  gate = new EgressGateServer({ authority, upstreams: { model: { baseUrl: `${url}/v1`, seatToken: seat(-60) }, search: { baseUrl: `${url}/search`, seatToken: seat(-60) }, fetch: "disabled" } });
  socket = join(realpathSync(mkdtempSync(join(tmpdir(), "kwl-seat-"))), "gate.sock");
  await gate.listen(socket);
});
after(async () => {
  await gate.close();
  upstream.close();
});

function post(path: string, body: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request({ socketPath: socket, path, method: "POST", headers: { "content-type": "application/json", authorization: "Bearer task", "content-length": Buffer.byteLength(data) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

test("seatUsable：空令牌与已过期不可用；未过期可用；无法解析载荷的（开发形态的本机配置）按可用", () => {
  assert.equal(seatUsable(""), false);
  assert.equal(seatUsable(seat(-1)), false);
  assert.equal(seatUsable(seat(3600)), true);
  assert.equal(seatUsable("dev-seat"), true);
});

test("过期的席位令牌：模型与检索请求不发出（seat_unavailable，上游零请求）；热更新为有效令牌后恢复", async () => {
  const before = hits;
  const m = await post("/m/m1/v1/chat/completions", { model: "legal/k3", messages: [{ role: "user", content: "测试" }] });
  assert.equal(m.status, 503);
  assert.match(m.text, /seat_unavailable/);
  const s = await post("/m/m1/search", { text_query: "民法典 违约金 调整" });
  assert.equal(s.status, 503);
  assert.match(s.text, /seat_unavailable/);
  assert.equal(hits, before, "上游零请求");
  assert.ok(records.some((r) => r.reason === "seat_unavailable" && r.outcome === "blocked"), "拦截留有去向记录");
  gate.updateSeat(seat(3600));
  const ok = await post("/m/m1/v1/chat/completions", { model: "legal/k3", messages: [{ role: "user", content: "测试" }] });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(hits, before + 1);
});
