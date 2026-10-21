/**
 * 防重放随机数存 Redis（v9.3 A-7；云端持久化与 KMS 设计 v1 §3 的过渡形态）。
 *
 * 一主多备形态下，随机数表仍在主实例内存里判定（同步、快）；每见到一个新随机数即异步写一份到 Redis（`SET … PX <剩余有效期> NX`）。
 * 换主实例时新主实例先把 Redis 里未过期的随机数读进内存再开始服务——不再像只靠状态快照那样丢掉最近 30 秒的随机数（重放窗口）。
 * Redis 不可用时降级回状态快照里的随机数（原有行为）：只计数、不影响请求；恢复后自动重连。
 * 存的只是请求的租户、设备编号与随机数（与控制面状态同一类元数据），键名 base64url，按剩余有效期自动过期。
 */
import { connectRedis, type RedisConn, type RedisOptions } from "./resp.ts";

export interface NonceMirror {
  /** 打开时读回的未过期随机数（[键, 到期毫秒]）。 */
  readonly initial: [string, number][];
  record(key: string, exp: number): void;
  stats(): { recorded: number; failures: number; connected: boolean };
  close(): void;
}

export async function openRedisNonceMirror(o: { redis: RedisOptions; prefix?: string; now?: () => number }): Promise<NonceMirror> {
  const prefix = o.prefix ?? "kwl:cp:nonce:";
  const now = o.now ?? Date.now;
  let conn: RedisConn | null = await connectRedis(o.redis);
  let reconnecting: Promise<void> | null = null;
  let recorded = 0;
  let failures = 0;
  const initial: [string, number][] = [];
  // 读回：SCAN 前缀 + 每个键的剩余有效期
  let cursor = "0";
  do {
    const r = (await conn.command("SCAN", cursor, "MATCH", `${prefix}*`, "COUNT", 1000)) as [string, string[]];
    cursor = r[0];
    const keys = r[1];
    const ttls = (await Promise.all(keys.map((k) => conn!.command("PTTL", k)))) as number[];
    const t = now();
    keys.forEach((k, i) => {
      const ttl = ttls[i]!;
      if (ttl > 0) initial.push([Buffer.from(k.slice(prefix.length), "base64url").toString("utf8"), t + ttl]);
    });
  } while (cursor !== "0");

  const reconnect = () => {
    if (reconnecting) return;
    reconnecting = connectRedis(o.redis)
      .then((c) => {
        conn = c;
      })
      .catch(() => {
        conn = null;
      })
      .finally(() => {
        // 下一次失败再重试（不在这里循环，避免 Redis 长时间不可用时空转）
        setTimeout(() => (reconnecting = null), 5_000).unref();
      });
  };
  return {
    initial,
    record(key, exp) {
      const ttl = Math.ceil(exp - now());
      if (ttl <= 0) return;
      const c = conn;
      if (!c || c.closed) {
        failures += 1;
        reconnect();
        return;
      }
      c.command("SET", `${prefix}${Buffer.from(key, "utf8").toString("base64url")}`, "1", "PX", ttl, "NX").then(
        () => (recorded += 1),
        () => {
          failures += 1;
          reconnect();
        },
      );
    },
    stats: () => ({ recorded, failures, connected: !!conn && !conn.closed }),
    close() {
      conn?.close();
      conn = null;
    },
  };
}
