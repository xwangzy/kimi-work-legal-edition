/**
 * 自写 PostgreSQL / Redis 客户端的加固（第 16 批复核 RB16A-06/07/09/17），用本机假服务端复现：
 * - 假数据库收到 SCRAM 第一条消息后直接回“认证成功”（不出示服务端签名）：拒绝连接；
 * - 假数据库认证正常、查询永不回复：查询按超时失败并断开（不永远挂住）；
 * - Redis 启动时就连不上：随机数镜像照常可用（降级），计失败；Redis 连接在但不回复：命令按超时失败、计失败。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { connectPg, connectRedis, openRedisNonceMirror } from "../src/index.ts";

const msg = (type: string, payload: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeInt32BE(payload.length + 4);
  return Buffer.concat([Buffer.from(type), len, payload]);
};
const int32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};
const auth = (code: number, extra = Buffer.alloc(0)) => msg("R", Buffer.concat([int32(code), extra]));
const ready = () => msg("Z", Buffer.from("I"));

async function fakePg(onMessage: (sock: Socket, n: number, data: Buffer) => void): Promise<number> {
  const srv = createServer((sock) => {
    let n = 0;
    sock.on("data", (d) => onMessage(sock, n++, Buffer.from(d)));
    sock.on("error", () => {});
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  srv.unref();
  return (srv.address() as AddressInfo).port;
}

test("SCRAM：数据库不出示服务端签名就回“认证成功”——拒绝连接（复核 RB16A-06）", async () => {
  const port = await fakePg((sock, n) => {
    if (n === 0) sock.write(auth(10, Buffer.from("SCRAM-SHA-256\0\0")));
    else if (n === 1) sock.write(Buffer.concat([auth(0), ready()]));
  });
  await assert.rejects(connectPg({ host: "127.0.0.1", port, user: "u", password: "p".repeat(40), database: "d" }), (e: any) => e.code === "auth_failed");
});

test("查询永不回复：按超时失败并断开（复核 RB16A-07）", async () => {
  // 不要求口令的假库（trust）：连接时不给 password，模拟用例集群的 Unix 套接字形态
  const port = await fakePg((sock, n) => {
    if (n === 0) sock.write(Buffer.concat([auth(0), ready()]));
    // 之后的查询一律不回复
  });
  const c = await connectPg({ host: "127.0.0.1", port, user: "u", database: "d", queryTimeoutMs: 200 });
  const t0 = Date.now();
  await assert.rejects(c.query("SELECT 1"), (e: any) => e.code === "closed" || e.code === "timeout");
  assert.ok(Date.now() - t0 < 2_000);
  assert.equal(c.closed, true);
});

test("Redis：启动时连不上照常可用（降级、计失败）；连接在但不回复，命令按超时失败（复核 RB16A-09/17）", async () => {
  const dead = createServer();
  await new Promise<void>((r) => dead.listen(0, "127.0.0.1", () => r()));
  const deadPort = (dead.address() as AddressInfo).port;
  await new Promise<void>((r) => dead.close(() => r()));
  const m = await openRedisNonceMirror({ redis: { host: "127.0.0.1", port: deadPort, connectTimeoutMs: 300 }, hmacKey: Buffer.alloc(32, 1) });
  assert.equal(m.stats().connected, false);
  assert.ok(m.stats().failures >= 1);
  assert.equal(m.seen("ten\0dev\0n"), false);
  m.record("ten\0dev\0n", Date.now() + 60_000);
  assert.ok(m.stats().failures >= 2, "写不进计失败、不抛错");
  m.close();
  const mute = createServer((s) => s.on("error", () => {}));
  await new Promise<void>((r) => mute.listen(0, "127.0.0.1", () => r()));
  mute.unref();
  const c = await connectRedis({ host: "127.0.0.1", port: (mute.address() as AddressInfo).port, commandTimeoutMs: 200 });
  await assert.rejects(c.command("PING"), /超时/);
  assert.equal(c.closed, true);
});
