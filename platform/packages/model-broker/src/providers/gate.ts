/**
 * 闸门 provider（v9 第 04 篇 §1.2 第 3 条“出站闸门是唯一出口”、§5.1 `/v1` 行）：内核的确定性工作流与本机模型代理不再直连任何上游，
 * 一律经出站闸门进程的本机套接字（`/m/<事项>/v1/chat/completions`，带本任务的闸门令牌）；闸门按事项端点转发到法律模型网关、
 * 律所自带密钥端点或私有端点，令牌化、图像载荷与去向记录都在闸门完成。
 *
 * - 请求体的 `model` 是路由别名（网关/闸门映射到上游模型 ID）；温度、推理档位、`max_completion_tokens` 由本侧按路由设置；
 * - 结束原因缺失时如实为 null（复审 N-07）；中止信号贯通到闸门请求与流（复审 N-01）；
 * - 闸门拒绝（`kwl_gate_denied`）按“出站被拦截”报告；闸门或上游不可达 / 429 / 5xx 交编排层有界退避，不切换端点；
 * - 请求 ID 取闸门的 `x-kwl-gate-request-id`：计量账本与闸门回送的用量按同一请求 ID 去重。
 */
import { Agent, fetch as undiciFetch, type Response as UResponse } from "undici";
import { DomainError } from "@zr-legal/domain";
import type { ChatRequest, ProviderResult, ProviderStream, UpstreamMeta, UsageBuckets } from "./types.ts";
import { emptyUsage } from "./types.ts";
import type { RouteDef } from "../config.ts";

/** 闸门传输：套接字（确保闸门进程在运行）与本任务的闸门令牌。 */
export interface GateTransport {
  /** 闸门套接字/命名管道；闸门不可用即抛错（唯一出口不可用：模型步骤排队，不改为直连）。 */
  socket(): Promise<string>;
  /** 本任务的闸门令牌（绑定尝试与纪元；scope model:chat）。 */
  token(task: GateTask): string;
}

export interface GateTask {
  tid: string;
  uid: string;
  mid: string;
  rid?: string | undefined;
  aid?: string | undefined;
}

export interface GateMeta extends UpstreamMeta {
  task: GateTask;
  /** 调用方已持有的任务令牌（本机端点转发 Agent 宿主的请求时，原样交给闸门再验）。 */
  bearer?: string | undefined;
  /** 闸门路由前缀（缺省 /m/<事项>；无事项问答为 /q/<会话>）。 */
  routePrefix?: string | undefined;
}

export interface GateProvider {
  name: string;
  chat(route: RouteDef, req: ChatRequest, meta: GateMeta): Promise<ProviderResult>;
  chatStream(route: RouteDef, req: ChatRequest, meta: GateMeta): Promise<ProviderStream>;
}

function gateBody(route: RouteDef, req: ChatRequest, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: route.alias,
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

export function mapUsage(u: any): UsageBuckets {
  const out = emptyUsage();
  if (!u) return out;
  out.cached_input = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens ?? 0;
  out.uncached_input = u.prompt_cache_miss_tokens ?? Math.max(0, (u.prompt_tokens ?? 0) - out.cached_input);
  out.cache_write = u.prompt_cache_write_tokens ?? 0;
  out.reasoning = u.completion_tokens_details?.reasoning_tokens ?? 0;
  out.output = u.completion_tokens ?? 0;
  return out;
}

export function createGateProvider(t: GateTransport): GateProvider {
  const agents = new Map<string, Agent>();
  const agentFor = (socket: string): Agent => {
    let a = agents.get(socket);
    if (!a) {
      a = new Agent({ connect: { socketPath: socket }, keepAliveTimeout: 10_000, keepAliveMaxTimeout: 60_000 });
      agents.set(socket, a);
    }
    return a;
  };

  async function gateFetch(body: Record<string, unknown>, meta: GateMeta): Promise<UResponse> {
    if (meta.signal?.aborted) throw new DomainError("cancelled", "任务令牌已失效：在途模型请求已中止", 401);
    let socket: string;
    try {
      socket = await t.socket();
    } catch (e) {
      throw new DomainError("provider_unavailable", `出站闸门不可用（模型步骤已排队，不会改为直连）：${(e as Error).message}`, 503);
    }
    const token = meta.bearer ?? t.token(meta.task);
    let res: UResponse;
    try {
      res = await undiciFetch(`http://gate.kwl${meta.routePrefix ?? `/m/${encodeURIComponent(meta.task.mid)}`}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: body.stream === true ? "text/event-stream" : "application/json",
          authorization: `Bearer ${token}`,
          "x-kwl-client-idempotency": meta.clientIdempotencyId,
        },
        body: JSON.stringify(body),
        dispatcher: agentFor(socket),
        ...(meta.signal ? { signal: meta.signal } : {}),
      });
    } catch (e) {
      if (meta.signal?.aborted) throw new DomainError("cancelled", "任务令牌已失效：在途模型请求已中止", 401);
      throw new DomainError("provider_unavailable", `出站闸门连接失败：${(e as Error).message}`, 503);
    }
    if (res.ok) return res;
    const text = await res.text().catch(() => "");
    let err: { type?: string; code?: string; message?: string } = {};
    try {
      err = (JSON.parse(text) as { error?: typeof err }).error ?? {};
    } catch {
      // 上游非 JSON 错误体
    }
    if (err.type === "kwl_gate_denied" && (res.status === 401 || res.status === 403)) {
      throw new DomainError("egress_blocked", `出站闸门拦截：${err.message ?? err.code ?? res.status}`, 422, { code: err.code ?? null });
    }
    if (res.status === 429 || res.status >= 500) {
      throw new DomainError("provider_unavailable", `模型通道 ${res.status}（${err.message ?? "限流/故障"}；交编排层有界退避，不切换端点）`, 503, {
        status: res.status,
        retry_after: res.headers.get("retry-after"),
        code: err.code ?? null,
      });
    }
    throw new DomainError("internal", `模型通道错误 ${res.status}：${(err.message ?? text).slice(0, 300)}`, 502);
  }

  return {
    name: "gate",
    async chat(route, req, meta) {
      const res = await gateFetch(gateBody(route, req, false), meta);
      const data = (await res.json()) as any;
      const choice = data.choices?.[0];
      return {
        requestId: res.headers.get("x-kwl-gate-request-id") ?? data.id ?? `gate_${Date.now()}`,
        content: choice?.message?.content ?? null,
        toolCalls: choice?.message?.tool_calls,
        finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
        usage: mapUsage(data.usage),
        raw: { id: data.id, model: data.model },
      };
    },
    async chatStream(route, req, meta) {
      const res = await gateFetch(gateBody(route, req, true), meta);
      if (!res.body) throw new DomainError("provider_unavailable", "模型通道流响应无 body", 503);
      const requestId = res.headers.get("x-kwl-gate-request-id") ?? `gate_${Date.now()}`;
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
              const tline = line.trim();
              if (!tline.startsWith("data:")) continue;
              const payload = tline.slice(5).trim();
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
