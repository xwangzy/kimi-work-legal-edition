/**
 * PostgreSQL 状态存储的工作线程（pg-state-store.ts 的另一半）：持有唯一一条数据库连接——同一条连接上持主实例咨询锁、读写状态行。
 * 主线程的 load/save 是同步的（与原文件存储“回复之前写盘”的语义一致）：经 SharedArrayBuffer + Atomics.wait 等这里做完。
 * 连接一断即视为失去主实例身份：之后的写一律失败（不重连——重连后锁可能已在别的实例手里；由进程退出后重新参加选主）。
 */
import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import { connectPg, type PgConn, type PgConnOptions } from "./pg-wire.ts";

interface Init {
  sab: SharedArrayBuffer;
  syncPort: MessagePort;
  pg: PgConnOptions;
  holder: string;
  lockId: string;
}

const { sab, syncPort, pg, holder, lockId } = workerData as Init;
const flag = new Int32Array(sab);
let conn: PgConn | null = null;
let leader = false;
let lost: string | null = null;
let probe: ReturnType<typeof setInterval> | null = null;
let probing = false;

const SCHEMA = [
  `CREATE SCHEMA IF NOT EXISTS kwl_cp`,
  // 整份控制面状态一行（封装：AES-256-GCM，附加数据 = 格式名 + 序号）；序号只增，写入按序号围栏
  `CREATE TABLE IF NOT EXISTS kwl_cp.state (
     id smallint PRIMARY KEY CHECK (id = 1),
     seq bigint NOT NULL CHECK (seq > 0),
     holder text NOT NULL,
     format text NOT NULL,
     iv text NOT NULL,
     tag text NOT NULL,
     data text NOT NULL,
     saved_at timestamptz NOT NULL DEFAULT now())`,
  // 初始化标记（复核 RB16A-10）：与第一次写状态同一条语句写入；有标记而没有状态行即拒绝启动（库被清空或错指向）
  `CREATE TABLE IF NOT EXISTS kwl_cp.meta (
     id smallint PRIMARY KEY CHECK (id = 1),
     initialized_at timestamptz NOT NULL DEFAULT now(),
     initialized_by text NOT NULL)`,
  // 主实例交接记录（只有实例标识与事件）
  `CREATE TABLE IF NOT EXISTS kwl_cp.leader_log (
     at timestamptz NOT NULL DEFAULT now(),
     holder text NOT NULL,
     event text NOT NULL)`,
];

const handlers: Record<string, (...a: any[]) => Promise<unknown>> = {
  /** 连上并等成为主实例（同一时刻只有一个实例持锁）；拿到锁后建表。 */
  async acquire(pollMs: number, maxWaitMs: number) {
    conn = await connectPg(pg);
    conn.onClose(() => {
      if (leader) lost = "connection_lost";
      leader = false;
    });
    const until = Date.now() + maxWaitMs;
    for (;;) {
      const r = await conn.query(`SELECT pg_try_advisory_lock($1::bigint)`, [lockId]);
      if (r.rows[0]?.[0] === "t") break;
      if (Date.now() > until) throw Object.assign(new Error("等待成为主实例超时"), { code: "leader_wait_timeout" });
      await new Promise((ok) => setTimeout(ok, pollMs));
    }
    leader = true;
    for (const s of SCHEMA) await conn.query(s);
    await conn.query(`INSERT INTO kwl_cp.leader_log (holder, event) VALUES ($1, 'acquired')`, [holder]);
    // 主实例探测（复核 RB16A-07）：每 2 秒确认连接还在、锁还在本会话手里；查询带超时，静默断连时置 lost（入口据此退出重选）
    probe = setInterval(() => {
      if (!conn || !leader || probing) return;
      probing = true;
      conn
        .query(`SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted`)
        .then((r) => {
          if (r.rows[0]?.[0] === "0") {
            lost = "lock_lost";
            leader = false;
          }
        })
        .catch(() => {
          lost = lost ?? "probe_failed";
          leader = false;
        })
        .finally(() => (probing = false));
    }, 2_000);
    return true;
  },
  async load() {
    if (!conn || !leader) throw Object.assign(new Error(lost ?? "不是主实例"), { code: lost ?? "not_leader" });
    const r = await conn.query(`SELECT seq, format, iv, tag, data FROM kwl_cp.state WHERE id = 1`);
    if (!r.rows.length) {
      const m = await conn.query(`SELECT 1 FROM kwl_cp.meta WHERE id = 1`);
      return { empty: true, initialized: m.rows.length > 0 };
    }
    const [seq, format, iv, tag, data] = r.rows[0]!;
    return { seq: Number(seq), format, iv, tag, data };
  },
  /** 写下一代：只有库里仍是 prevSeq 时才写（别的实例写过即围栏失败）。 */
  async save(prevSeq: number, seq: number, format: string, iv: string, tag: string, data: string) {
    if (!conn || !leader) throw Object.assign(new Error(lost ?? "不是主实例"), { code: lost ?? "not_leader" });
    // 初始化标记与状态同一条语句写入（数据修改型 CTE，原子）
    const r = await conn.query(
      `WITH m AS (INSERT INTO kwl_cp.meta (id, initialized_by) VALUES (1, $2) ON CONFLICT (id) DO NOTHING)
       INSERT INTO kwl_cp.state AS s (id, seq, holder, format, iv, tag, data, saved_at) VALUES (1, $1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (id) DO UPDATE SET seq = EXCLUDED.seq, holder = EXCLUDED.holder, format = EXCLUDED.format, iv = EXCLUDED.iv, tag = EXCLUDED.tag, data = EXCLUDED.data, saved_at = now()
       WHERE s.seq = $7`,
      [seq, holder, format, iv, tag, data, prevSeq],
    );
    if (r.command !== "INSERT 0 1") {
      lost = "fenced";
      leader = false;
      throw Object.assign(new Error("状态已被另一个实例写过（围栏）"), { code: "fenced" });
    }
    return true;
  },
  async status() {
    return { leader, lost };
  },
  async release() {
    if (probe) clearInterval(probe);
    probe = null;
    if (conn && leader) {
      try {
        await conn.query(`INSERT INTO kwl_cp.leader_log (holder, event) VALUES ($1, 'released')`, [holder]);
      } catch {
        // 连接已断：锁随之释放
      }
    }
    leader = false;
    await conn?.close();
    conn = null;
    return true;
  },
};

parentPort!.on("message", (m: { id: number; mode: "sync" | "async"; op: string; args: unknown[] }) => {
  const h = handlers[m.op];
  const reply = (v: { id: number; ok: boolean; result?: unknown; code?: string; message?: string }) => {
    if (m.mode === "sync") {
      syncPort.postMessage(v);
      Atomics.store(flag, 0, 1);
      Atomics.notify(flag, 0);
    } else parentPort!.postMessage(v);
  };
  if (!h) return reply({ id: m.id, ok: false, code: "unknown_op", message: m.op });
  h(...m.args).then(
    (result) => reply({ id: m.id, ok: true, result }),
    (e: any) => reply({ id: m.id, ok: false, code: typeof e?.code === "string" ? e.code : "error", message: String(e?.message ?? e) }),
  );
});
