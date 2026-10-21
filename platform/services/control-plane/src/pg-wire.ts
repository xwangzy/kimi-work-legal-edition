/**
 * 最小 PostgreSQL 客户端（v9.3 A-7；协议 v3）。本产品依赖极少，控制面只需要几条固定语句，不为此引入第三方驱动：
 * - 连接：TCP 或 Unix 套接字；生产形态必须 TLS（先发 SSLRequest，服务端不支持即拒绝），按给定 CA 核验证书与主机名；
 * - 认证：SCRAM-SHA-256（核对服务端签名）与 trust；明文口令与 MD5 一律拒绝（明文口令只在 TLS 下可接受，这里干脆不支持）；
 * - 查询：只用扩展查询协议（Parse/Bind/Describe/Execute/Sync），参数一律按文本单独传，不拼进 SQL；结果按文本返回。
 * 同一连接上的查询按顺序执行；连接断了即全部失败（调用方重连）。
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

export interface PgConnOptions {
  host?: string;
  port?: number;
  /** Unix 套接字目录（与 host 二选一；测试用临时集群）。 */
  socketDir?: string;
  user: string;
  password?: string;
  database: string;
  /** TLS：生产必填（只信这个 CA；servername 缺省为 host）。 */
  tls?: { ca: string; servername?: string };
  connectTimeoutMs?: number;
  applicationName?: string;
}

export interface PgResult {
  fields: string[];
  rows: (string | null)[][];
  command: string;
}

export class PgError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface PgConn {
  query(sql: string, params?: (string | number | bigint | null)[]): Promise<PgResult>;
  close(): Promise<void>;
  readonly closed: boolean;
  /** 连接断开时回调（读到 EOF 或出错）。 */
  onClose(fn: (err?: Error) => void): void;
}

const int32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};
const int16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n);
  return b;
};
const cstr = (s: string) => Buffer.concat([Buffer.from(s, "utf8"), Buffer.from([0])]);
const msg = (type: string, payload: Buffer) => Buffer.concat([Buffer.from(type, "ascii"), int32(payload.length + 4), payload]);

/** 读服务端消息的缓冲：按“类型 + 长度”切出完整消息。 */
class Reader {
  private buf: Buffer = Buffer.alloc(0);
  push(c: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, c]) : c;
  }
  next(): { type: string; body: Buffer } | null {
    if (this.buf.length < 5) return null;
    const len = this.buf.readInt32BE(1);
    if (len < 4 || len > 256 * 1024 * 1024) throw new PgError("protocol", "消息长度不合法");
    if (this.buf.length < 1 + len) return null;
    const type = String.fromCharCode(this.buf[0]!);
    const body = this.buf.subarray(5, 1 + len);
    this.buf = this.buf.subarray(1 + len);
    return { type, body };
  }
}

function parseError(body: Buffer): PgError {
  const f: Record<string, string> = {};
  let i = 0;
  while (i < body.length && body[i] !== 0) {
    const code = String.fromCharCode(body[i]!);
    const end = body.indexOf(0, i + 1);
    f[code] = body.subarray(i + 1, end).toString("utf8");
    i = end + 1;
  }
  return new PgError(f.C ?? "XX000", f.M ?? "数据库错误");
}

async function openSocket(o: PgConnOptions): Promise<Socket> {
  const timeout = o.connectTimeoutMs ?? 10_000;
  const raw: Socket = await new Promise((resolve, reject) => {
    const s = o.socketDir ? netConnect(`${o.socketDir.replace(/\/+$/, "")}/.s.PGSQL.${o.port ?? 5432}`) : netConnect({ host: o.host ?? "127.0.0.1", port: o.port ?? 5432 });
    const t = setTimeout(() => s.destroy(new PgError("timeout", "连接数据库超时")), timeout);
    s.once("connect", () => {
      clearTimeout(t);
      resolve(s);
    });
    s.once("error", (e) => {
      clearTimeout(t);
      reject(e instanceof PgError ? e : new PgError("unreachable", "连不上数据库"));
    });
  });
  if (!o.tls) return raw;
  // SSLRequest：服务端回 'S' 才升级；回 'N'（不支持 TLS）即拒绝——不降级为明文
  raw.write(Buffer.concat([int32(8), int32(80877103)]));
  const answer: string = await new Promise((resolve, reject) => {
    raw.once("data", (d: Buffer) => resolve(String.fromCharCode(d[0]!)));
    raw.once("error", () => reject(new PgError("unreachable", "连不上数据库")));
  });
  if (answer !== "S") {
    raw.destroy();
    throw new PgError("tls_refused", "数据库不支持 TLS：拒绝以明文连接");
  }
  return new Promise((resolve, reject) => {
    const s = tlsConnect({ socket: raw, ca: o.tls!.ca, servername: o.tls!.servername ?? o.host, minVersion: "TLSv1.2" }, () => resolve(s));
    s.once("error", () => reject(new PgError("tls_failed", "数据库证书核验不通过")));
  });
}

export async function connectPg(o: PgConnOptions): Promise<PgConn> {
  const sock = await openSocket(o);
  const reader = new Reader();
  type Waiter = { resolve: (m: { type: string; body: Buffer }) => void; reject: (e: Error) => void };
  const inbox: { type: string; body: Buffer }[] = [];
  let waiter: Waiter | null = null;
  let dead: Error | null = null;
  const closeHandlers: ((e?: Error) => void)[] = [];
  const fail = (e: Error) => {
    if (dead) return;
    dead = e;
    waiter?.reject(e);
    waiter = null;
    for (const h of closeHandlers) h(e);
  };
  sock.on("data", (c: Buffer) => {
    try {
      reader.push(c);
      for (let m = reader.next(); m; m = reader.next()) {
        if (m.type === "N" || m.type === "S" || m.type === "K" || m.type === "A") continue; // 通知、参数状态、取消键、异步通知
        if (waiter) {
          const w = waiter;
          waiter = null;
          w.resolve(m);
        } else inbox.push(m);
      }
    } catch (e) {
      fail(e as Error);
      sock.destroy();
    }
  });
  sock.on("close", () => fail(new PgError("closed", "数据库连接已断开")));
  sock.on("error", () => fail(new PgError("closed", "数据库连接已断开")));
  const recv = (): Promise<{ type: string; body: Buffer }> => {
    if (inbox.length) return Promise.resolve(inbox.shift()!);
    if (dead) return Promise.reject(dead);
    return new Promise((resolve, reject) => (waiter = { resolve, reject }));
  };

  // ─── 启动与认证 ───
  const params = Buffer.concat([cstr("user"), cstr(o.user), cstr("database"), cstr(o.database), cstr("application_name"), cstr(o.applicationName ?? "kwl-control-plane"), cstr("client_encoding"), cstr("UTF8"), Buffer.from([0])]);
  sock.write(Buffer.concat([int32(params.length + 8), int32(196608), params]));
  let scram: { clientFirstBare: string; nonce: string; password: string; authMessage?: string; saltedPassword?: Buffer } | null = null;
  for (;;) {
    const m = await recv();
    if (m.type === "E") {
      sock.destroy();
      throw parseError(m.body);
    }
    if (m.type === "Z") break;
    if (m.type !== "R") continue;
    const code = m.body.readInt32BE(0);
    if (code === 0) continue; // AuthenticationOk
    if (code === 3 || code === 5) {
      sock.destroy();
      throw new PgError("auth_method_refused", "数据库要求明文或 MD5 口令：只接受 SCRAM-SHA-256");
    }
    if (code === 10) {
      const mechs = m.body.subarray(4).toString("utf8").split("\0").filter(Boolean);
      if (!mechs.includes("SCRAM-SHA-256") || o.password === undefined) {
        sock.destroy();
        throw new PgError("auth_method_refused", "数据库没有提供 SCRAM-SHA-256，或没有配置口令");
      }
      const nonce = randomBytes(18).toString("base64");
      const clientFirstBare = `n=,r=${nonce}`;
      scram = { clientFirstBare, nonce, password: o.password };
      const first = Buffer.from(`n,,${clientFirstBare}`, "utf8");
      sock.write(msg("p", Buffer.concat([cstr("SCRAM-SHA-256"), int32(first.length), first])));
      continue;
    }
    if (code === 11 && scram) {
      const serverFirst = m.body.subarray(4).toString("utf8");
      const attrs = Object.fromEntries(serverFirst.split(",").map((kv) => [kv.slice(0, 1), kv.slice(2)]));
      const iter = Number(attrs.i);
      if (!attrs.r?.startsWith(scram.nonce) || !attrs.s || !Number.isSafeInteger(iter) || iter < 4096) {
        sock.destroy();
        throw new PgError("auth_failed", "数据库的 SCRAM 回应不合格");
      }
      const salted = pbkdf2Sync(scram.password.normalize("NFKC"), Buffer.from(attrs.s, "base64"), iter, 32, "sha256");
      const clientKey = createHmac("sha256", salted).update("Client Key").digest();
      const storedKey = createHash("sha256").update(clientKey).digest();
      const finalNoProof = `c=biws,r=${attrs.r}`;
      const authMessage = `${scram.clientFirstBare},${serverFirst},${finalNoProof}`;
      const sig = createHmac("sha256", storedKey).update(authMessage).digest();
      const proof = Buffer.from(clientKey.map((b, i) => b ^ sig[i]!));
      scram.authMessage = authMessage;
      scram.saltedPassword = salted;
      sock.write(msg("p", Buffer.from(`${finalNoProof},p=${proof.toString("base64")}`, "utf8")));
      continue;
    }
    if (code === 12 && scram?.saltedPassword) {
      // 核对服务端签名：防止假冒的数据库骗取连接（服务端也得知道口令派生的密钥）
      const v = /(?:^|,)v=([^,]+)/.exec(m.body.subarray(4).toString("utf8"))?.[1] ?? "";
      const serverKey = createHmac("sha256", scram.saltedPassword).update("Server Key").digest();
      const want = createHmac("sha256", serverKey).update(scram.authMessage!).digest();
      const got = Buffer.from(v, "base64");
      if (got.length !== want.length || !timingSafeEqual(got, want)) {
        sock.destroy();
        throw new PgError("auth_failed", "数据库的 SCRAM 服务端签名不符");
      }
      continue;
    }
    sock.destroy();
    throw new PgError("auth_method_refused", `不支持的认证方式（${code}）`);
  }
  if (o.password !== undefined && !scram) {
    // 配了口令却被 trust 放行：生产配置错误（任何人都能连）。只在测试的 Unix 套接字临时集群上可以不配口令
    sock.destroy();
    throw new PgError("auth_method_refused", "数据库没有要求口令（trust）：拒绝连接");
  }

  let chain: Promise<unknown> = Promise.resolve();
  const run = async (sql: string, ps: (string | number | bigint | null)[]): Promise<PgResult> => {
    const vals = ps.map((p) => (p === null ? null : Buffer.from(String(p), "utf8")));
    const bind = Buffer.concat([cstr(""), cstr(""), int16(0), int16(vals.length), ...vals.map((v) => (v === null ? int32(-1) : Buffer.concat([int32(v.length), v]))), int16(0)]);
    sock.write(Buffer.concat([msg("P", Buffer.concat([cstr(""), cstr(sql), int16(0)])), msg("B", bind), msg("D", Buffer.concat([Buffer.from("P"), cstr("")])), msg("E", Buffer.concat([cstr(""), int32(0)])), msg("S", Buffer.alloc(0))]));
    const out: PgResult = { fields: [], rows: [], command: "" };
    let err: PgError | null = null;
    for (;;) {
      const m = await recv();
      if (m.type === "E") err = parseError(m.body);
      else if (m.type === "T") {
        const n = m.body.readInt16BE(0);
        let i = 2;
        for (let k = 0; k < n; k++) {
          const end = m.body.indexOf(0, i);
          out.fields.push(m.body.subarray(i, end).toString("utf8"));
          i = end + 1 + 18;
        }
      } else if (m.type === "D") {
        const n = m.body.readInt16BE(0);
        let i = 2;
        const row: (string | null)[] = [];
        for (let k = 0; k < n; k++) {
          const len = m.body.readInt32BE(i);
          i += 4;
          if (len < 0) row.push(null);
          else {
            row.push(m.body.subarray(i, i + len).toString("utf8"));
            i += len;
          }
        }
        out.rows.push(row);
      } else if (m.type === "C") out.command = m.body.subarray(0, m.body.length - 1).toString("utf8");
      else if (m.type === "Z") break;
    }
    if (err) throw err;
    return out;
  };
  return {
    query(sql, ps = []) {
      const p = chain.then(() => (dead ? Promise.reject(dead) : run(sql, ps)));
      chain = p.catch(() => undefined);
      return p;
    },
    async close() {
      if (dead) return;
      sock.end(msg("X", Buffer.alloc(0)));
      await new Promise<void>((r) => {
        sock.once("close", () => r());
        setTimeout(() => {
          sock.destroy();
          r();
        }, 2_000).unref();
      });
    },
    get closed() {
      return dead !== null;
    },
    onClose(fn) {
      closeHandlers.push(fn);
    },
  };
}

/** 连接串解析：postgres://用户:口令@主机:端口/库（口令另可从文件给，见生产入口）。 */
export function parsePgUrl(url: string): Omit<PgConnOptions, "tls"> {
  const u = new URL(url);
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") throw new Error("数据库地址须为 postgres://…");
  return {
    host: decodeURIComponent(u.hostname),
    port: u.port ? Number(u.port) : 5432,
    user: decodeURIComponent(u.username),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    database: decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres",
  };
}
