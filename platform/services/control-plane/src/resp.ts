/**
 * 最小 Redis 客户端（v9.3 A-7；RESP2）：控制面只用几条命令（AUTH、SET … NX PX、SCAN、PTTL、PING），不为此引入第三方驱动。
 * TCP、Unix 套接字或 TLS（生产：只信给定 CA）；命令按顺序流水执行；连接断了即全部失败（调用方重连或降级）。
 */
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

export interface RedisOptions {
  host?: string;
  port?: number;
  socketPath?: string;
  username?: string;
  password?: string;
  tls?: { ca: string; servername?: string };
  connectTimeoutMs?: number;
}

export type RespValue = string | number | null | RespValue[] | RespError;

export class RespError extends Error {}

export interface RedisConn {
  command(...args: (string | number)[]): Promise<RespValue>;
  close(): void;
  readonly closed: boolean;
}

/** 解析一个 RESP2 值；数据不够返回 undefined。 */
function parse(buf: Buffer, at: number): { v: RespValue; next: number } | undefined {
  if (at >= buf.length) return undefined;
  const line = buf.indexOf("\r\n", at);
  if (line < 0) return undefined;
  const head = String.fromCharCode(buf[at]!);
  const text = buf.subarray(at + 1, line).toString("utf8");
  const after = line + 2;
  switch (head) {
    case "+":
      return { v: text, next: after };
    case "-":
      return { v: new RespError(text), next: after };
    case ":":
      return { v: Number(text), next: after };
    case "$": {
      const n = Number(text);
      if (n < 0) return { v: null, next: after };
      if (buf.length < after + n + 2) return undefined;
      return { v: buf.subarray(after, after + n).toString("utf8"), next: after + n + 2 };
    }
    case "*": {
      const n = Number(text);
      if (n < 0) return { v: null, next: after };
      const arr: RespValue[] = [];
      let p = after;
      for (let i = 0; i < n; i++) {
        const r = parse(buf, p);
        if (!r) return undefined;
        arr.push(r.v);
        p = r.next;
      }
      return { v: arr, next: p };
    }
    default:
      throw new RespError("协议错误");
  }
}

const encode = (args: (string | number)[]) => {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const a of args) {
    const b = Buffer.from(String(a), "utf8");
    parts.push(Buffer.from(`$${b.length}\r\n`), b, Buffer.from("\r\n"));
  }
  return Buffer.concat(parts);
};

export async function connectRedis(o: RedisOptions): Promise<RedisConn> {
  const timeout = o.connectTimeoutMs ?? 5_000;
  const sock: Socket = await new Promise((resolve, reject) => {
    const s: Socket = o.tls
      ? tlsConnect({ host: o.host ?? "127.0.0.1", port: o.port ?? 6379, ca: o.tls.ca, servername: o.tls.servername ?? o.host, minVersion: "TLSv1.2" })
      : o.socketPath
        ? netConnect(o.socketPath)
        : netConnect({ host: o.host ?? "127.0.0.1", port: o.port ?? 6379 });
    const t = setTimeout(() => s.destroy(new RespError("连接 Redis 超时")), timeout);
    s.once(o.tls ? "secureConnect" : "connect", () => {
      clearTimeout(t);
      resolve(s);
    });
    s.once("error", (e) => {
      clearTimeout(t);
      reject(e instanceof RespError ? e : new RespError("连不上 Redis"));
    });
  });
  sock.setNoDelay(true);
  let buf: Buffer = Buffer.alloc(0);
  const pending: { resolve: (v: RespValue) => void; reject: (e: Error) => void }[] = [];
  let dead: Error | null = null;
  const fail = (e: Error) => {
    if (dead) return;
    dead = e;
    for (const p of pending.splice(0)) p.reject(e);
  };
  sock.on("data", (c: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, c]) : c;
    try {
      for (;;) {
        const r = parse(buf, 0);
        if (!r) break;
        buf = buf.subarray(r.next);
        const p = pending.shift();
        if (!p) continue;
        if (r.v instanceof RespError) p.reject(r.v);
        else p.resolve(r.v);
      }
    } catch (e) {
      fail(e as Error);
      sock.destroy();
    }
  });
  sock.on("close", () => fail(new RespError("Redis 连接已断开")));
  sock.on("error", () => fail(new RespError("Redis 连接已断开")));
  const conn: RedisConn = {
    command(...args) {
      if (dead) return Promise.reject(dead);
      return new Promise((resolve, reject) => {
        pending.push({ resolve, reject });
        sock.write(encode(args));
      });
    },
    close() {
      sock.destroy();
      fail(new RespError("Redis 连接已关闭"));
    },
    get closed() {
      return dead !== null;
    },
  };
  if (o.password !== undefined) await conn.command("AUTH", ...(o.username ? [o.username] : []), o.password);
  return conn;
}

/** redis://[:口令@]主机:端口 或 rediss://（TLS）；口令另可从文件给。 */
export function parseRedisUrl(url: string): Omit<RedisOptions, "tls"> & { tls: boolean } {
  const u = new URL(url);
  if (u.protocol !== "redis:" && u.protocol !== "rediss:") throw new Error("Redis 地址须为 redis:// 或 rediss://");
  return {
    host: decodeURIComponent(u.hostname),
    port: u.port ? Number(u.port) : 6379,
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    tls: u.protocol === "rediss:",
  };
}
