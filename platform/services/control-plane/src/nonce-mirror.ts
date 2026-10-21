/**
 * 防重放随机数存 Redis（v9.3 A-7；云端持久化与 KMS 设计 v1 §3 的过渡形态）。
 *
 * 一主多备形态下，随机数表仍在主实例内存里判定（同步、快）；每见到一个新随机数即异步写一份到 Redis（`SET … PX <剩余有效期> NX`）。
 * 换主实例时新主实例先把 Redis 里未过期的随机数读进来再开始服务——不再像只靠状态快照那样丢掉最近 30 秒的随机数（重放窗口）。
 * Redis 不可用（含启动时就连不上，复核 RB16A-09）时降级回状态快照里的随机数（原有行为）：只计数、不影响请求；之后自动重连。
 * 键名是 HMAC-SHA256（密钥由状态封装密钥派生）——判重只需等值比较，Redis 与它的快照里读不出租户与设备编号（复核 RB16A-08）。
 */
import { createHmac } from "node:crypto";
import { connectRedis, type RedisConn, type RedisOptions } from "./resp.ts";

export interface NonceMirror {
  /** 打开时从 Redis 读回、尚未过期的随机数里有没有这一个（按 HMAC 比较）。 */
  seen(key: string): boolean;
  record(key: string, exp: number): void;
  stats(): { recorded: number; failures: number; connected: boolean; loaded: number };
  close(): void;
}

export async function openRedisNonceMirror(o: { redis: RedisOptions; hmacKey: Uint8Array; prefix?: string; now?: () => number }): Promise<NonceMirror> {
  if (o.hmacKey.byteLength < 32) throw new Error("随机数镜像的 HMAC 密钥至少 32 字节");
  const prefix = o.prefix ?? "kwl:cp:nonce:";
  const now = o.now ?? Date.now;
  const mac = (key: string) => createHmac("sha256", o.hmacKey).update(key, "utf8").digest("hex");
  let conn: RedisConn | null = null;
  let reconnecting = false;
  let recorded = 0;
  let failures = 0;
  const initial = new Map<string, number>();
  const load = async (c: RedisConn) => {
    let cursor = "0";
    do {
      const r = (await c.command("SCAN", cursor, "MATCH", `${prefix}*`, "COUNT", 1000)) as [string, string[]];
      cursor = r[0];
      const keys = r[1];
      const ttls = (await Promise.all(keys.map((k) => c.command("PTTL", k)))) as number[];
      const t = now();
      keys.forEach((k, i) => {
        const ttl = ttls[i]!;
        if (ttl > 0) initial.set(k.slice(prefix.length), t + ttl);
      });
    } while (cursor !== "0");
  };
  try {
    conn = await connectRedis(o.redis);
    await load(conn);
  } catch {
    // 启动时连不上或读不全：照常服务（降级为状态快照里的随机数），计一次失败，之后按需重连
    conn?.close();
    conn = null;
    failures += 1;
  }

  const reconnect = () => {
    if (reconnecting) return;
    reconnecting = true;
    connectRedis(o.redis)
      .then((c) => {
        conn = c;
      })
      .catch(() => {
        conn = null;
      })
      .finally(() => {
        // 下一次失败再重试（不在这里循环，避免 Redis 长时间不可用时空转）
        setTimeout(() => (reconnecting = false), 5_000).unref();
      });
  };
  return {
    seen(key) {
      const exp = initial.get(mac(key));
      return exp !== undefined && exp > now();
    },
    record(key, exp) {
      const ttl = Math.ceil(exp - now());
      if (ttl <= 0) return;
      const c = conn;
      if (!c || c.closed) {
        failures += 1;
        reconnect();
        return;
      }
      c.command("SET", `${prefix}${mac(key)}`, "1", "PX", ttl, "NX").then(
        () => (recorded += 1),
        () => {
          failures += 1;
          reconnect();
        },
      );
    },
    stats: () => ({ recorded, failures, connected: !!conn && !conn.closed, loaded: initial.size }),
    close() {
      conn?.close();
      conn = null;
    },
  };
}
