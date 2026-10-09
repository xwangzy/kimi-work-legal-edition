import type { RouteDef } from "../config.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  [k: string]: unknown;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatRequest {
  model: string; // 路由别名
  messages: ChatMessage[];
  stream?: boolean | undefined;
  reasoning_effort?: "low" | "high" | "max" | undefined;
  response_format?: Record<string, unknown> | undefined;
  temperature?: number | undefined;
  max_tokens?: number | undefined;
  tools?: unknown[] | undefined;
  tool_choice?: unknown;
  [k: string]: unknown;
}

export interface UsageBuckets {
  uncached_input: number;
  cached_input: number;
  cache_write: number;
  output: number;
  reasoning: number;
  tool_calls: number;
}

export interface ProviderResult {
  requestId: string;
  content: string | null;
  toolCalls?: ToolCall[] | undefined;
  finishReason: string;
  usage: UsageBuckets;
  raw?: unknown;
}

export interface ProviderStream {
  requestId: string;
  chunks: AsyncIterable<string>; // SSE data 负载（不含 "data: " 前缀），含终止 [DONE]
  finalUsage: Promise<UsageBuckets>;
}

/** 上游附加请求头（由 broker 注入：模型真实性校验 nonce 与客户端幂等 ID）。 */
export interface UpstreamMeta {
  nonce: string;
  clientIdempotencyId: string;
}

export interface Provider {
  name: string;
  chat(route: RouteDef, req: ChatRequest, meta?: UpstreamMeta): Promise<ProviderResult>;
  chatStream(route: RouteDef, req: ChatRequest, meta?: UpstreamMeta): Promise<ProviderStream>;
}

export function emptyUsage(): UsageBuckets {
  return { uncached_input: 0, cached_input: 0, cache_write: 0, output: 0, reasoning: 0, tool_calls: 0 };
}

/** 估算 token（无官方 tokenizer 时的保守近似：中文按字、英文按 ~4 字符）。 */
export function estimateTokens(text: string): number {
  let n = 0;
  for (const ch of text) {
    n += /[⺀-鿿豈-﫿　-〿＀-￯]/.test(ch) ? 1 : 0.25;
  }
  return Math.max(1, Math.ceil(n));
}
