/**
 * 上游 provider：OpenAI 兼容端点（标准=中软 MaaS 法律分组 / 自带密钥=月之暗面企业接口 / 私有=律所内推理）。
 *
 * - 每请求携带 `X-Msh-Request-Nonce`（模型真实性校验，§10.1：证明请求到达 Kimi 且模型未被替换；
 *   不证明中转层未留存——后者靠 DPA 与配置审计）与 `X-ZR-Client-Idempotency`（客户端幂等 ID，
 *   MaaS 侧记录供「结果不明先对账」，§6.1）；
 * - 密钥只在本机内核进程内存与操作系统凭据库；Agent、界面、加载项都拿不到（§10.1 凭据）；
 * - 供应商故障显式报错，不静默切换（§10.1 故障）；429/5xx 交编排层有界退避；
 * - `max_completion_tokens` 上限由调用方按任务设置，避免按模型上限预占配额（§10.1 计量与容量）。
 */
import { DomainError } from "@zr-legal/domain";
import type { ChatRequest, Provider, ProviderResult, ProviderStream, UpstreamMeta, UsageBuckets } from "./types.ts";
import { emptyUsage } from "./types.ts";
import type { EndpointConfig, RouteDef } from "../config.ts";

function upstreamBody(route: RouteDef, req: ChatRequest, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: route.providerModel,
    messages: req.messages,
    temperature: route.temperature, // 固定 1.0
    stream,
  };
  if (route.supportsEffort && req.reasoning_effort) body.reasoning_effort = req.reasoning_effort;
  if (req.response_format) body.response_format = req.response_format;
  if (req.max_tokens) body.max_completion_tokens = req.max_tokens;
  if (req.tools) body.tools = req.tools;
  if (req.tool_choice !== undefined) body.tool_choice = req.tool_choice;
  if (stream) body.stream_options = { include_usage: true };
  return body;
}

function mapUsage(u: any): UsageBuckets {
  const out = emptyUsage();
  if (!u) return out;
  out.cached_input = u.prompt_cache_hit_tokens ?? u.cached_tokens ?? 0;
  out.uncached_input = u.prompt_cache_miss_tokens ?? Math.max(0, (u.prompt_tokens ?? 0) - out.cached_input);
  out.cache_write = u.prompt_cache_write_tokens ?? 0;
  out.reasoning = u.completion_tokens_details?.reasoning_tokens ?? 0;
  out.output = u.completion_tokens ?? 0;
  return out;
}

export function createUpstreamProvider(endpoint: EndpointConfig): Provider {
  async function upstreamFetch(path: string, body: Record<string, unknown>, meta?: UpstreamMeta): Promise<Response> {
    if (!endpoint.baseUrl || !endpoint.apiKey) {
      throw new DomainError("provider_unavailable", `模型端点不可用：${endpoint.missingNote ?? "未配置"}（不会静默降级到其他提供方）`, 503);
    }
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${endpoint.apiKey}`,
    };
    if (meta) {
      headers["X-Msh-Request-Nonce"] = meta.nonce;
      headers["X-ZR-Client-Idempotency"] = meta.clientIdempotencyId;
    }
    let res: Response;
    try {
      res = await fetch(`${endpoint.baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    } catch (e) {
      throw new DomainError("provider_unavailable", `模型通道连接失败: ${(e as Error).message}`, 503);
    }
    if (res.status === 429 || res.status >= 500) {
      const retry = res.headers.get("retry-after");
      throw new DomainError("provider_unavailable", `模型通道 ${res.status}（限流/故障，交编排层有界退避）`, 503, {
        status: res.status,
        retry_after: retry,
      });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new DomainError("internal", `模型通道错误 ${res.status}: ${text.slice(0, 300)}`, 502);
    }
    return res;
  }

  return {
    name: `upstream:${endpoint.kind}`,
    async chat(route: RouteDef, req: ChatRequest, meta?: UpstreamMeta): Promise<ProviderResult> {
      const res = await upstreamFetch("/v1/chat/completions", upstreamBody(route, req, false), meta);
      const data = (await res.json()) as any;
      const choice = data.choices?.[0];
      return {
        requestId: data.id ?? `up_${Date.now()}`,
        content: choice?.message?.content ?? null,
        toolCalls: choice?.message?.tool_calls,
        finishReason: choice?.finish_reason ?? "stop",
        usage: mapUsage(data.usage),
        raw: { id: data.id, model: data.model },
      };
    },
    async chatStream(route: RouteDef, req: ChatRequest, meta?: UpstreamMeta): Promise<ProviderStream> {
      const res = await upstreamFetch("/v1/chat/completions", upstreamBody(route, req, true), meta);
      if (!res.body) throw new DomainError("provider_unavailable", "模型通道流响应无 body", 503);
      const requestId = `up_${Date.now()}`;
      let usageResolve!: (u: UsageBuckets) => void;
      const finalUsage = new Promise<UsageBuckets>((resolve) => (usageResolve = resolve));
      const captured = emptyUsage();
      async function* chunks(): AsyncIterable<string> {
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            for (const line of lines) {
              const t = line.trim();
              if (!t.startsWith("data:")) continue;
              const payload = t.slice(5).trim();
              if (payload !== "[DONE]") {
                try {
                  const j = JSON.parse(payload);
                  if (j.usage) Object.assign(captured, mapUsage(j.usage));
                } catch {
                  // 忽略非 JSON 行
                }
              }
              yield payload;
            }
          }
        } finally {
          usageResolve(captured);
        }
      }
      return { requestId, chunks: chunks(), finalUsage };
    },
  };
}
