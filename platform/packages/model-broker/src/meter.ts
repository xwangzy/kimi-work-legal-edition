/**
 * 计量（§10.1）：模型、token 分类、耗时、客户端幂等 ID、任务归属写入账本；每日与 MaaS 消费记录对账。
 * 客户点数与真实人民币成本分账——此处只记真实成本账；失败退点不抹掉真实成本。
 */
import { newId } from "@zr-legal/domain";
import type { UsageBuckets } from "./providers/types.ts";
import { PRICES, PRICE_VERSION, type RouteDef } from "./config.ts";
import { errFields, slog } from "@zr-legal/safe-log";

export interface MeterStore {
  run(sql: string, params: unknown[]): void;
  /** 可选事务包装（与内核账本的 EgressStore 对齐；本包当前不主动使用）。 */
  tx?<T>(fn: () => T): T;
}

export function costMicroCny(priceKey: string, u: UsageBuckets): number | null {
  const p = PRICES[priceKey];
  if (!p) return null;
  return Math.round(u.uncached_input * p.uncached_input + u.cached_input * p.cached_input + u.cache_write * p.cache_write + u.output * p.output);
}

export interface MeterRow {
  requestId: string;
  task: { tid: string; uid: string; mid?: string | undefined; rid?: string | undefined; aid?: string | undefined };
  route: RouteDef;
  usage: UsageBuckets;
  clientIdempotencyId: string;
  latencyMs: number;
}

export function recordUsage(store: MeterStore, row: MeterRow): { costMicro: number | null } {
  const costMicro = costMicroCny(row.route.priceKey, row.usage);
  try {
    store.run(
      `INSERT OR IGNORE INTO usage_records
        (usage_id, request_id, tenant_id, user_id, matter_id, run_id, attempt_id,
         route, provider_model, tokens_uncached_input, tokens_cached_input, tokens_cache_write,
         tokens_output, tokens_reasoning, tool_calls, cost_microcny, client_idempotency_id, latency_ms, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        newId("usage"),
        row.requestId,
        row.task.tid,
        row.task.uid,
        row.task.mid ?? null,
        row.task.rid ?? null,
        row.task.aid ?? null,
        row.route.alias,
        row.route.providerModel,
        row.usage.uncached_input,
        row.usage.cached_input,
        row.usage.cache_write,
        row.usage.output,
        row.usage.reasoning,
        row.usage.tool_calls,
        costMicro,
        row.clientIdempotencyId,
        row.latencyMs,
        new Date().toISOString(),
      ],
    );
  } catch (err) {
    // 计量失败不阻断服务，但必须显式可见（对账时发现缺口）
    slog.event("METER_INSERT_FAILED", errFields(err));
  }
  return { costMicro };
}

export { PRICE_VERSION };
