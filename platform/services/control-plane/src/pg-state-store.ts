/**
 * 控制面状态存 PostgreSQL（v9.3 A-7 第一段；云端持久化与 KMS 设计 v1 §2 的过渡形态，偏离登记 D-108）。
 *
 * 与文件存储同一接口（StateStore：整份 JSON，同步 load/save）——控制面“回复之前写成、写不成即回滚并 500”的语义一字不改：
 * - **多实例 = 一主多备**：每个实例启动时等 PostgreSQL 咨询锁（`openPgStateStore` 异步等，等到之前不对外服务，负载均衡的就绪检查不通过）；
 *   拿到锁的是主实例，读回最新状态后才开始服务；主实例进程或连接断掉，锁随会话释放，备实例接手。
 * - **围栏**：每次写都带上一代序号（`WHERE seq = 上一代`），别的实例写过即失败，本实例随即失去主实例身份、之后的写全部失败；
 *   连接一断同样如此（不悄悄重连）。生产入口据 `healthy()` 退出进程，由编排重启后重新参加选主。
 * - **RPO**：每个改变状态的回复之前已提交（同步提交 + 云数据库的同步复制）；状态不会因换实例而回退。
 * - 封装与文件存储相同：AES-256-GCM，附加数据 = 格式名 + 序号；库里只有密文（租户盐等不明文落库）。
 * - 同步调用经工作线程 + Atomics.wait（与原先同步写盘 + fsync 一样会阻塞事件循环几毫秒；超时即按写失败处理）。
 *
 * 残余（如实）：整份状态一行，状态大时每次写入量大（试点规模可接受，G2 按设计 §2 拆成按租户的关系表 + 行级安全）；
 * 有库写权限的人把整行换成更旧的一代（序号与密文一起换）挡不住——与文件存储同一残余，靠客户端拒收回退的目录版本。
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";
import type { PgConnOptions } from "./pg-wire.ts";
import type { StateStore } from "./state-store.ts";

const FORMAT = "kwl-cp-state/1";
/** 咨询锁编号（"kwlcp" 的十六进制）：同一库里只有一个控制面主实例。 */
const DEFAULT_LOCK_ID = String(0x6b776c6370);

export interface PgStateStoreOptions {
  pg: PgConnOptions;
  /** 32 字节封装密钥（与文件存储同一把：生产由 KMS 下发）。 */
  key: Uint8Array;
  /** 本实例标识（主机名-进程号-随机；只进交接记录）。 */
  holder: string;
  lockId?: string;
  /** 单次同步调用的上限（缺省 10 秒）。 */
  callTimeoutMs?: number;
  /** 备实例轮询锁的间隔（缺省 2 秒）与最长等待（缺省不限）。 */
  pollMs?: number;
  maxWaitMs?: number;
}

export interface PgStateStore extends StateStore {
  readonly holder: string;
  /** 仍是主实例且连接正常；false 时生产入口应退出进程。 */
  healthy(): boolean;
  /** 保存次数与失败次数（指标）。 */
  stats(): { saves: number; failures: number; lost: string | null };
  close(): Promise<void>;
}

export async function openPgStateStore(o: PgStateStoreOptions): Promise<PgStateStore> {
  if (o.key.byteLength !== 32) throw new Error("控制面状态封装密钥须为 32 字节");
  const key = Buffer.from(o.key);
  const sab = new SharedArrayBuffer(4);
  const flag = new Int32Array(sab);
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(new URL("./pg-state-worker.ts", import.meta.url), {
    workerData: { sab, syncPort: port2, pg: o.pg, holder: o.holder, lockId: o.lockId ?? DEFAULT_LOCK_ID },
    transferList: [port2],
  });
  let seq = 0;
  let saves = 0;
  let failures = 0;
  let lost: string | null = null;
  let nextId = 1;
  const asyncWaiters = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  worker.on("message", (m: { id: number; ok: boolean; result?: unknown; code?: string; message?: string }) => {
    const w = asyncWaiters.get(m.id);
    if (!w) return;
    asyncWaiters.delete(m.id);
    if (m.ok) w.resolve(m.result);
    else w.reject(Object.assign(new Error(m.message ?? "数据库错误"), { code: m.code }));
  });
  worker.on("error", () => (lost = lost ?? "worker_failed"));
  worker.on("exit", () => (lost = lost ?? "worker_exited"));
  const callAsync = (op: string, ...args: unknown[]): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      asyncWaiters.set(id, { resolve, reject });
      worker.postMessage({ id, mode: "async", op, args });
    });
  const callSync = (op: string, ...args: unknown[]): any => {
    if (lost) throw Object.assign(new Error(`控制面状态库不可用（${lost}）`), { code: lost });
    const id = nextId++;
    Atomics.store(flag, 0, 0);
    worker.postMessage({ id, mode: "sync", op, args });
    const w = Atomics.wait(flag, 0, 0, o.callTimeoutMs ?? 10_000);
    for (;;) {
      const got = receiveMessageOnPort(port1);
      if (!got) break;
      const m = got.message as { id: number; ok: boolean; result?: unknown; code?: string; message?: string };
      if (m.id !== id) continue; // 之前超时的调用晚到的回复
      if (m.ok) return m.result;
      if (m.code === "fenced" || m.code === "connection_lost" || m.code === "not_leader") lost = m.code;
      throw Object.assign(new Error(m.message ?? "数据库错误"), { code: m.code });
    }
    // 超时：写有没有成功不得而知——按失去主实例处理（宁可停服重选，也不在不确定的序号上接着写）
    lost = w === "timed-out" ? "timeout" : "no_reply";
    throw Object.assign(new Error("控制面状态库没有及时回应"), { code: lost });
  };

  // 等锁期间工作线程让进程保持运行（此时还没有监听端口）；成为主实例后不再拖住进程退出
  try {
    await callAsync("acquire", o.pollMs ?? 2_000, o.maxWaitMs ?? Number.MAX_SAFE_INTEGER);
  } catch (e) {
    await worker.terminate();
    throw e;
  }
  worker.unref();
  const aad = (n: number) => Buffer.from(`${FORMAT}\u0000${n}`);
  return {
    holder: o.holder,
    load() {
      const row = callSync("load") as { seq: number; format: string; iv: string; tag: string; data: string } | null;
      if (!row) {
        seq = 0;
        return null;
      }
      if (row.format !== FORMAT || !Number.isSafeInteger(row.seq) || row.seq < 1) throw new Error("控制面状态行格式不认识，拒绝启动");
      try {
        const d = createDecipheriv("aes-256-gcm", key, Buffer.from(row.iv, "base64"));
        d.setAAD(aad(row.seq));
        d.setAuthTag(Buffer.from(row.tag, "base64"));
        const json = Buffer.concat([d.update(Buffer.from(row.data, "base64")), d.final()]).toString("utf8");
        seq = row.seq;
        return json;
      } catch {
        // 不静默从空状态开始（那等于撤销全部吊销）
        throw new Error("控制面状态行无法校验（密钥不符或被改动），拒绝启动");
      }
    },
    save(json) {
      const next = seq + 1;
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      c.setAAD(aad(next));
      const ct = Buffer.concat([c.update(json, "utf8"), c.final()]);
      try {
        callSync("save", seq, next, FORMAT, iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64"));
      } catch (e) {
        failures += 1;
        throw e;
      }
      seq = next;
      saves += 1;
    },
    healthy: () => {
      if (lost) return false;
      try {
        const st = callSync("status") as { leader: boolean; lost: string | null };
        if (st.lost) lost = st.lost;
        return st.leader && !st.lost;
      } catch {
        return false;
      }
    },
    stats: () => ({ saves, failures, lost }),
    async close() {
      try {
        await callAsync("release");
      } catch {
        // 已断开
      }
      await worker.terminate();
      port1.close();
    },
  };
}
