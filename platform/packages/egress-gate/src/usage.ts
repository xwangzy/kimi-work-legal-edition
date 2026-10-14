/**
 * 从 OpenAI 兼容的 JSON 或 SSE 文本中读取用量（闸门只在内存里看响应尾部，响应流原样交给调用方）。
 * 字段口径与内核计量一致：缓存命中 / 未命中 / 缓存写入 / 输出（含推理）/ 推理。
 */
import type { GateUsage } from "./types.ts";

function pick(o: unknown): GateUsage | null {
  const obj = o as { usage?: unknown; choices?: { usage?: unknown }[] } | null;
  const u = (obj?.usage ?? obj?.choices?.find?.((c) => c?.usage)?.usage) as Record<string, any> | undefined;
  if (!u || typeof u.prompt_tokens !== "number") return null;
  const cached = Number(u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens ?? 0) || 0;
  return {
    input: u.prompt_tokens,
    output: Number(u.completion_tokens ?? 0) || 0,
    cached,
    cacheWrite: Number(u.prompt_cache_write_tokens ?? 0) || 0,
    reasoning: Number(u.completion_tokens_details?.reasoning_tokens ?? 0) || 0,
  };
}

export function extractUsage(text: string): GateUsage | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      return pick(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }
  let found: GateUsage | null = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    try {
      found = pick(JSON.parse(line.slice(6))) ?? found;
    } catch {
      // 非 JSON 行（或尾部截断的首行）
    }
  }
  return found;
}
