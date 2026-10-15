/**
 * 闸门内存驻留（Y5 P1-12）与发送前二次检测的去向记录（v9.2 R7）：
 * - 事项令牌化器空闲超时即逐出并清零令牌密钥；版本更替下来的旧实例宽限 60 秒后释放（在途检索、抓取可能还持有它）；逐出后下一次请求照常重建；
 * - 已释放的令牌化器不能再用（失败关闭）；
 * - 模型请求的去向记录带可疑姓名计数，任何值都不进记录。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import { mkdtempSync, realpathSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MatterTokenizer } from "@zr-legal/tokenizer";
import { EgressGateServer } from "../src/server.ts";
import type { AuthorizeResult, GateAuthority, GateEgressRecord, MatterEgressContext } from "../src/types.ts";

const KEY = Buffer.alloc(32, 7).toString("base64");
const ctx = (tableVersion = 1): MatterEgressContext => ({
  tenantId: "t1", matterId: "m1", runId: "r1", userId: "u1", anonMatterId: "anon-1", dataLevel: "L2", basisComplete: true, modelEndpoint: "standard",
  preauth: { searchGeneralized: false, images: false }, l3aStandardAllowed: false, fetchAllowlist: [], policyVersion: 3,
  tokenizer: { keyB64: KEY, parties: [{ name: "陈建国", kind: "person" }], table: [], fullPseudonym: false, tableVersion },
});
class Authority implements GateAuthority {
  current = ctx();
  readonly records: GateEgressRecord[] = [];
  async authorize(): Promise<AuthorizeResult> {
    return { ok: true, ctx: this.current };
  }
  record(rec: GateEgressRecord): void {
    this.records.push(rec);
  }
  tokens(): void {}
}
const call = (socket: string, body: unknown) =>
  new Promise<number>((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request({ socketPath: socket, path: "/m/m1/v1/chat/completions", method: "POST", headers: { "content-type": "application/json", authorization: "Bearer t", "content-length": Buffer.byteLength(data) } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end(data);
  });

let upstream: Server;
let gate: EgressGateServer;
let socket: string;
const authority = new Authority();
before(async () => {
  upstream = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"choices":[{"message":{"content":"好"}}]}');
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  socket = join(realpathSync(mkdtempSync(join(tmpdir(), "kwl-gate-res-"))), "gate.sock");
  gate = new EgressGateServer({ authority, tokenizerIdleMs: 50, upstreams: { model: { baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`, seatToken: "s" }, search: null, fetch: "disabled" } });
  await gate.listen(socket);
});
after(async () => {
  await gate.close();
  upstream.close();
});

test("令牌化器驻留：空闲逐出、版本更替宽限释放、逐出后照常重建", async () => {
  assert.equal(await call(socket, { model: "k", messages: [{ role: "user", content: "陈建国借款五万元。" }] }), 200);
  assert.equal(gate.residentTokenizers, 1);
  authority.current = ctx(2); // 内核有新条目：版本更替
  assert.equal(await call(socket, { model: "k", messages: [{ role: "user", content: "陈建国还款。" }] }), 200);
  assert.equal(gate.residentTokenizers, 1);
  assert.equal(gate.evictTokenizers(50, Date.now() + 100), 1, "空闲超时：逐出当前实例");
  assert.equal(gate.residentTokenizers, 0);
  gate.evictTokenizers(50, Date.now() + 61_000); // 宽限期过后释放更替下来的旧实例
  assert.equal(await call(socket, { model: "k", messages: [{ role: "user", content: "陈建国再次还款。" }] }), 200, "逐出后照常重建");
  assert.equal(gate.residentTokenizers, 1);
  const sent = authority.records.filter((r) => r.outcome === "sent");
  assert.ok(sent.length >= 3);
});

test("已释放的令牌化器不能再用（失败关闭）", () => {
  const tz = new MatterTokenizer({ matterKey: Buffer.alloc(32, 1), parties: [], table: [] });
  tz.dispose();
  assert.throws(() => tz.tokenize("陈建国"), /已释放/);
});

test("去向记录带可疑姓名计数、不带值", async () => {
  authority.records.length = 0;
  assert.equal(await call(socket, { model: "k", messages: [{ role: "user", content: "尚文琳和汪英波在餐厅见面并签署了协议。" }] }), 200);
  const rec = authority.records.find((r) => r.phase === "start")!;
  assert.deepEqual(rec.suspectedNames, { high: 0, medium: 2 });
  const all = JSON.stringify(authority.records);
  assert.equal(all.includes("尚文琳") || all.includes("汪英波"), false, "值不进记录");
});
