/**
 * 网关上游（第 04 篇 §5.2：网关直连月之暗面企业账户，主密钥只在服务端；不静默跨供应商路由）。
 *
 * 透传语义：请求体只改 `model`（路由到上游模型 ID）与流式时的 `stream_options.include_usage`（计量需要）；响应原样返回（字节流）。
 */

export interface UpstreamResponse {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
}

export interface ChatProvider {
  readonly name: string;
  chat(body: Record<string, unknown>, o: { requestId: string; signal: AbortSignal }): Promise<UpstreamResponse>;
}

/** 月之暗面开放平台（OpenAI 兼容）：主密钥只在网关进程内（来自服务端 KMS / 环境）。真实调用需中软组织测试额度验证（P7）。 */
export class MoonshotProvider implements ChatProvider {
  readonly name = "moonshot";
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  constructor(o: { baseUrl?: string; apiKey: string; fetchImpl?: typeof fetch }) {
    if (!o.apiKey) throw new Error("上游主密钥未配置");
    this.baseUrl = (o.baseUrl ?? "https://api.moonshot.cn/v1").replace(/\/+$/, "");
    this.apiKey = o.apiKey;
    this.fetchImpl = o.fetchImpl ?? globalThis.fetch;
  }
  async chat(body: Record<string, unknown>, o: { requestId: string; signal: AbortSignal }): Promise<UpstreamResponse> {
    const r = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}`, "x-request-id": o.requestId },
      body: JSON.stringify(body),
      signal: o.signal,
    });
    const headers: Record<string, string> = {};
    for (const k of ["content-type", "x-request-id"]) {
      const v = r.headers.get(k);
      if (v) headers[k] = v;
    }
    return { status: r.status, headers, body: (r.body ?? (async function* () {})()) as AsyncIterable<Uint8Array> };
  }
}

/**
 * 确定性离线上游（开发、测试与探针）：同一请求 → 同一回答；流式与非流式都给 usage；明确标识为 mock，不冒充真实供应商。
 * `script` 只供测试注入（返回 null 用缺省回答）。
 */
export class MockProvider implements ChatProvider {
  readonly name = "mock";
  script: ((body: Record<string, unknown>) => { content?: string; status?: number; toolCalls?: { id: string; name: string; args: unknown }[] } | null) | null = null;
  /** 最近收到的请求体（测试核对令牌化后的正文；生产网关不保留正文）。 */
  readonly seen: Record<string, unknown>[] = [];
  async chat(body: Record<string, unknown>): Promise<UpstreamResponse> {
    this.seen.push(body);
    if (this.seen.length > 50) this.seen.shift();
    const s = this.script?.(body) ?? null;
    const status = s?.status ?? 200;
    const messages = (Array.isArray(body.messages) ? body.messages : []) as { content?: unknown }[];
    const promptChars = JSON.stringify(messages).length;
    const content = s?.content ?? `（mock）已收到 ${messages.length} 条消息。`;
    const usage = { prompt_tokens: Math.ceil(promptChars / 2), completion_tokens: Math.ceil(content.length / 2), total_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } };
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    const enc = new TextEncoder();
    if (status !== 200) {
      return { status, headers: { "content-type": "application/json" }, body: (async function* () { yield enc.encode(JSON.stringify({ error: { message: "mock upstream error", type: "upstream_error" } })); })() };
    }
    const toolCalls = s?.toolCalls?.map((t, i) => ({ index: i, id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } }));
    if (body.stream === true) {
      const chunks = [
        { id: "mock-1", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: null }] },
        { id: "mock-1", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: toolCalls ? "tool_calls" : "stop" }], usage },
      ];
      return {
        status,
        headers: { "content-type": "text/event-stream" },
        body: (async function* () {
          for (const c of chunks) yield enc.encode(`data: ${JSON.stringify(c)}\n\n`);
          yield enc.encode("data: [DONE]\n\n");
        })(),
      };
    }
    const json = { id: "mock-1", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls ? "tool_calls" : "stop" }], usage };
    return { status, headers: { "content-type": "application/json" }, body: (async function* () { yield enc.encode(JSON.stringify(json)); })() };
  }
}
