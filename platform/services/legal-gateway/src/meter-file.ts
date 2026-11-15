/**
 * 计量预写日志（JSON Lines，只追加）：只写元数据（第 04 篇 §5.2 留存口径）。写入前按白名单字段重建对象——
 * 即便调用方误塞了正文字段，也不会落盘。
 *
 * 第 44 批：settle 行另带整条 UsageRecord（`record`，同样按白名单重建）与租约持有者（`holder`），这个文件同时是回报控制面的发件箱：
 * 追加后返回该行的字节范围，LeaseQuota 据此维护检查点 meter.ack（已确认送达的字节偏移）。
 */
import { appendFileSync, closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import type { MeterRecord, MeterSink } from "./gateway.ts";
import type { MeterPos } from "./quota.ts";
import { cleanUsageRecord } from "./usage.ts";

const FIELDS: readonly (keyof MeterRecord)[] = ["at", "kind", "requestId", "clientRequestId", "tid", "sid", "anonMatter", "model", "status", "reserved", "inputTokens", "outputTokens", "cachedTokens", "latencyMs", "reason", "safety", "finishReason", "upstreamModel", "provider", "unit", "priceVersion", "holder", "record"];

/** 计量文件里允许出现的字段（用例据此核对“只有元数据”）。 */
export const METER_FIELDS: readonly string[] = FIELDS;

export function cleanMeterRecord(rec: MeterRecord): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const k of FIELDS) {
    if (k === "record") clean.record = rec.record ? cleanUsageRecord(rec.record) : null;
    else clean[k] = rec[k] ?? null;
  }
  return clean;
}

function endsWithNewline(path: string, size: number): boolean {
  if (size === 0) return true;
  const fd = openSync(path, "r");
  try {
    const b = Buffer.alloc(1);
    readSync(fd, b, 0, 1, size - 1);
    return b[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}

export function fileMeter(path: string): MeterSink & { readonly path: string } {
  // 上次崩溃留下半行：下一条先补换行，不与半行粘成一条
  let checkedAt = -1;
  return {
    path,
    append(rec: MeterRecord): MeterPos {
      const size = existsSync(path) ? statSync(path).size : 0;
      const lead = size !== checkedAt && !endsWithNewline(path, size) ? "\n" : "";
      const line = `${lead}${JSON.stringify(cleanMeterRecord(rec))}\n`;
      appendFileSync(path, line, { mode: 0o600 });
      const end = size + Buffer.byteLength(line);
      checkedAt = end;
      return { start: size + lead.length, end };
    },
  };
}

export function memoryMeter(): MeterSink & { records: MeterRecord[] } {
  const records: MeterRecord[] = [];
  return { records, append: (r) => void records.push({ ...r }) };
}
