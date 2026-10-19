/**
 * 计量预写日志（JSON Lines，只追加）：只写元数据（第 04 篇 §5.2 留存口径）。写入前按白名单字段重建对象——
 * 即便调用方误塞了正文字段，也不会落盘。
 */
import { appendFileSync } from "node:fs";
import type { MeterRecord, MeterSink } from "./gateway.ts";

const FIELDS: readonly (keyof MeterRecord)[] = ["at", "kind", "requestId", "clientRequestId", "tid", "sid", "anonMatter", "model", "status", "reserved", "inputTokens", "outputTokens", "cachedTokens", "latencyMs", "reason", "safety", "finishReason"];

export function fileMeter(path: string): MeterSink {
  return {
    append(rec: MeterRecord): void {
      const clean: Record<string, unknown> = {};
      for (const k of FIELDS) clean[k] = rec[k] ?? null;
      appendFileSync(path, `${JSON.stringify(clean)}\n`, { mode: 0o600 });
    },
  };
}

export function memoryMeter(): MeterSink & { records: MeterRecord[] } {
  const records: MeterRecord[] = [];
  return { records, append: (r) => void records.push({ ...r }) };
}
