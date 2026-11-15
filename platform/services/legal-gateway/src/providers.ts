/**
 * 网关上游（第 04 篇 §5.2；V19 第 44 批：多上游，每个上游一个实例，由路由表按 id 选用）。
 *
 * 透传语义：请求体只改 `model`（路由到上游模型 ID）与流式时的 `stream_options.include_usage`（计量需要）；成功的响应原样返回（字节流）；
 * 非 2xx 的响应体由网关规范化，不透传上游原文。上游密钥只在实例的私有字段里（`#apiKey`：不进 JSON、日志、错误信息）。
 */

export interface UpstreamResponse {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
}

export interface ChatProvider {
  readonly name: string;
  chat(body: Record<string, unknown>, o: { requestId: string; signal: AbortSignal }): Promise<UpstreamResponse>;
  /** 主动探测（`GET {base}/models`，带密钥）：只返回状态，不读正文。没有实现 = 不探测。 */
  probe?(signal: AbortSignal): Promise<{ status: number }>;
}

/** 上游响应里网关会读取的头：内容类型、上游请求编号（计量对账）、限流的 Retry-After。 */
const KEEP_HEADERS = ["content-type", "x-request-id", "x-oneapi-request-id", "retry-after"] as const;

/** 通用 OpenAI 兼容上游（月之暗面开放平台、中软 MaaS 等）。 */
export class OpenAICompatProvider implements ChatProvider {
  readonly name: string;
  readonly baseUrl: string;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  constructor(o: { baseUrl?: string; apiKey: string; fetchImpl?: typeof fetch; name?: string }) {
    if (!o.apiKey) throw new Error("上游主密钥未配置");
    this.name = o.name ?? "openai-compat";
    this.baseUrl = (o.baseUrl ?? "https://api.moonshot.cn/v1").replace(/\/+$/, "");
    this.#apiKey = o.apiKey;
    this.#fetch = o.fetchImpl ?? globalThis.fetch;
  }
  async chat(body: Record<string, unknown>, o: { requestId: string; signal: AbortSignal }): Promise<UpstreamResponse> {
    const r = await this.#fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.#apiKey}`, "x-request-id": o.requestId },
      body: JSON.stringify(body),
      signal: o.signal,
      redirect: "error",
    });
    const headers: Record<string, string> = {};
    for (const k of KEEP_HEADERS) {
      const v = r.headers.get(k);
      if (v) headers[k] = v;
    }
    return { status: r.status, headers, body: (r.body ?? (async function* () {})()) as AsyncIterable<Uint8Array> };
  }
  async probe(signal: AbortSignal): Promise<{ status: number }> {
    const r = await this.#fetch(`${this.baseUrl}/models`, { headers: { authorization: `Bearer ${this.#apiKey}` }, signal, redirect: "error" });
    await r.body?.cancel().catch(() => {});
    return { status: r.status };
  }
  toJSON(): Record<string, string> {
    return { name: this.name, baseUrl: this.baseUrl };
  }
}

/** 兼容旧名（第 44 批之前叫 MoonshotProvider；实为通用 OpenAI 兼容客户端）。 */
export { OpenAICompatProvider as MoonshotProvider };

/**
 * 确定性离线上游（开发、测试与探针）：同一请求 → 同一回答；流式与非流式都给 usage；明确标识为 mock，不冒充真实供应商。
 * `script` 只供测试注入（返回 null 用缺省回答）。
 */
export class MockProvider implements ChatProvider {
  readonly name = "mock";
  script: ((body: Record<string, unknown>) => { content?: string; status?: number; toolCalls?: { id: string; name: string; args: unknown }[]; headers?: Record<string, string> } | null) | null = null;
  /** 最近收到的请求体（测试核对令牌化后的正文；生产网关不保留正文）。 */
  readonly seen: Record<string, unknown>[] = [];
  async chat(body: Record<string, unknown>): Promise<UpstreamResponse> {
    this.seen.push(body);
    if (this.seen.length > 50) this.seen.shift();
    const s = this.script?.(body) ?? null;
    const status = s?.status ?? 200;
    const messages = (Array.isArray(body.messages) ? body.messages : []) as { content?: unknown }[];
    const promptChars = JSON.stringify(messages).length;
    const content = s?.content ?? `（示例回复）已收到 ${messages.length} 条消息。`;
    const usage = { prompt_tokens: Math.ceil(promptChars / 2), completion_tokens: Math.ceil(content.length / 2), total_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } };
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    const enc = new TextEncoder();
    if (status !== 200) {
      return { status, headers: { "content-type": "application/json", ...(s?.headers ?? {}) }, body: (async function* () { yield enc.encode(JSON.stringify({ error: { message: "mock upstream error", type: "upstream_error" } })); })() };
    }
    const toolCalls = s?.toolCalls?.map((t, i) => ({ index: i, id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } }));
    if (body.stream === true) {
      const chunks = [
        { id: "mock-1", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: null }] },
        { id: "mock-1", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: toolCalls ? "tool_calls" : "stop" }], usage },
      ];
      return {
        status,
        headers: { "content-type": "text/event-stream", ...(s?.headers ?? {}) },
        body: (async function* () {
          for (const c of chunks) yield enc.encode(`data: ${JSON.stringify(c)}\n\n`);
          yield enc.encode("data: [DONE]\n\n");
        })(),
      };
    }
    const json = { id: "mock-1", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls ? "tool_calls" : "stop" }], usage };
    return { status, headers: { "content-type": "application/json", ...(s?.headers ?? {}) }, body: (async function* () { yield enc.encode(JSON.stringify(json)); })() };
  }
}
