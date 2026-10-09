/**
 * 本机模型代理（方案 v5.0 第 4 篇 §10.1）：内核内的本机服务，工作流与 Agent 都只连它。
 *
 * 职责：路由（只在经评测等价的模型之间切换，不为可用率静默降级）、推理档位、预算、
 * 计量、模型真实性校验 nonce、客户端幂等 ID；出站一律经出站闸门（§1.1 约束 2）。
 */
import { randomUUID } from "node:crypto";
import { DomainError, type Matter, type ModelEndpoint } from "@zr-legal/domain";
import type { EgressGate, EgressTaskRef } from "@zr-legal/egress";
import { buildRoutes, resolveEndpoint, PRICE_VERSION, type BrokerEnv, type RouteDef } from "./config.ts";
import { recordUsage, type MeterStore } from "./meter.ts";
import { mockProvider } from "./providers/mock.ts";
import { createUpstreamProvider } from "./providers/upstream.ts";
import type { ChatMessage, ChatRequest, Provider, ToolCall, UsageBuckets } from "./providers/types.ts";

export interface BrokerChatArgs {
  matter: Matter;
  task: EgressTaskRef;
  route: string;
  messages: ChatMessage[];
  effort?: "low" | "high" | "max";
  /** §10.1：max 档位只在律师显式选择时置 true（界面勾选）。 */
  allowMax?: boolean;
  responseFormat?: Record<string, unknown>;
  maxTokens?: number;
  tools?: unknown[];
  toolChoice?: unknown;
  clientIdempotencyId?: string;
  /** 数据去向记录备注（如全流程化名统计）。 */
  note?: string | undefined;
}

export interface BrokerChatResult {
  content: string | null;
  toolCalls?: ToolCall[] | undefined;
  finishReason: string;
  usage: UsageBuckets;
  costMicroCny: number | null;
  requestId: string;
  route: string;
  provider: string;
  endpointKind: ModelEndpoint | "mock";
  egressRecordId: string;
  latencyMs: number;
}

export interface BrokerStore extends MeterStore {
  run(sql: string, params: unknown[]): void;
}

export class ModelBroker {
  private readonly routes: Record<string, RouteDef>;
  private readonly upstreamCache = new Map<string, Provider>();
  private readonly store: BrokerStore;
  private readonly egress: EgressGate;
  private readonly env: BrokerEnv;

  constructor(store: BrokerStore, egress: EgressGate, env: BrokerEnv = process.env) {
    this.store = store;
    this.egress = egress;
    this.env = env;
    this.routes = buildRoutes(env);
  }

  routeAliases(): string[] {
    return Object.keys(this.routes);
  }

  resolveRoute(alias: string | undefined): RouteDef {
    const route = alias ? this.routes[alias] : undefined;
    if (!route) throw new DomainError("validation", `未知模型路由 "${alias}"；可用: ${this.routeAliases().join(", ")}`, 422);
    return route;
  }

  private upstreamFor(endpointKind: "standard" | "byok" | "private"): { provider: Provider; baseUrl: string | null } {
    const endpoint = resolveEndpoint(endpointKind, this.env);
    let provider = this.upstreamCache.get(endpointKind);
    if (!provider) {
      provider = createUpstreamProvider(endpoint);
      this.upstreamCache.set(endpointKind, provider);
    }
    return { provider, baseUrl: endpoint.baseUrl };
  }

  private buildRequest(route: RouteDef, args: BrokerChatArgs): ChatRequest {
    if (args.effort === "max" && args.allowMax !== true) {
      // §10.1 推理档位：max 只在律师显式选择时使用；其余一律按默认分档
      throw new DomainError("validation", "推理档位 max 需律师在界面显式选择后方可使用（默认 high，按步骤下调 low）", 422);
    }
    return {
      model: route.alias,
      messages: args.messages,
      reasoning_effort: args.effort ?? route.defaultEffort ?? undefined,
      response_format: args.responseFormat,
      // §10.1 计量与容量：每个请求设置合理的 max_completion_tokens 上限，避免按模型上限预占配额
      max_tokens: args.maxTokens ?? 32_000,
      tools: args.tools,
      tool_choice: args.toolChoice,
    };
  }

  /** 把闸门（可能补替换后的）文本回写到消息序列（只替换字符串内容的消息，顺序一致）。 */
  private applyEgressTexts(messages: ChatMessage[], texts: string[]): ChatMessage[] {
    const out: ChatMessage[] = [];
    let i = 0;
    for (const m of messages) {
      if (typeof m.content === "string" && m.content.length > 0) {
        out.push({ ...m, content: texts[i++] ?? m.content });
      } else {
        out.push(m);
      }
    }
    return out;
  }

  async chat(args: BrokerChatArgs): Promise<BrokerChatResult> {
    const route = this.resolveRoute(args.route);
    if (args.effort && !route.allowedEfforts.includes(args.effort)) {
      throw new DomainError("validation", `路由 ${route.alias} 不支持 reasoning_effort=${args.effort}`, 422);
    }
    const clientIdempotencyId = args.clientIdempotencyId ?? `idem_${randomUUID()}`;
    const req = this.buildRequest(route, args);
    const texts = args.messages.map((m) => (typeof m.content === "string" ? m.content : "")).filter((t) => t.length > 0);
    const started = Date.now();

    if (route.provider === "mock") {
      // 事项策略先于提供方选择：mock 也是模型（演示语义一致），「待取得/已拒绝/不使用模型/strict」一律拦截
      this.egress.assertMatterAllowsModel(args.matter, args.matter.model_endpoint);
      const egressRecordId = this.egress.recordMock({
        matter: args.matter,
        task: args.task,
        texts,
        requestId: clientIdempotencyId,
        clientIdempotencyId,
        note: args.note,
      });
      const result = await mockProvider.chat(route, req);
      const { costMicro } = recordUsage(this.store, {
        requestId: result.requestId,
        task: args.task,
        route,
        usage: result.usage,
        clientIdempotencyId,
        latencyMs: Date.now() - started,
      });
      return {
        content: result.content,
        toolCalls: result.toolCalls,
        finishReason: result.finishReason,
        usage: result.usage,
        costMicroCny: costMicro,
        requestId: result.requestId,
        route: route.alias,
        provider: "mock",
        endpointKind: "mock",
        egressRecordId,
        latencyMs: Date.now() - started,
      };
    }

    // 真实链路：端点按事项选定（标准 MaaS / 自带密钥 / 私有模型），出站一律经出站闸门
    const endpointKind = args.matter.model_endpoint;
    if (endpointKind === "none") {
      throw new DomainError("egress_blocked", "该事项设置为「不使用模型」：只用本机确定性工具与人工。", 422);
    }
    // 顺序：先事项策略（人话拦截）→ 端点配置核查 → 白名单与化名校验 → 发送
    this.egress.assertMatterAllowsModel(args.matter, endpointKind);
    const endpoint = resolveEndpoint(endpointKind, this.env);
    if (!endpoint.baseUrl || !endpoint.apiKey) {
      throw new DomainError("provider_unavailable", `模型端点不可用：${endpoint.missingNote ?? "未配置"}（不会静默降级到其他提供方）`, 503);
    }
    const { provider } = this.upstreamFor(endpointKind);
    const host = new URL(endpoint.baseUrl).host;
    const send = this.egress.beforeModelSend({
      matter: args.matter,
      task: args.task,
      endpoint: endpointKind,
      destinationHost: host,
      texts,
      requestId: null,
      clientIdempotencyId,
      note: args.note,
    });
    const egressRecordId = send.recordId;
    const nonce = randomUUID();
    let result;
    try {
      // 发送闸门返回的文本（replace 策略下为补替换后文本，绝不发送原文）
      result = await provider.chat(route, { ...req, messages: this.applyEgressTexts(req.messages, send.texts) }, { nonce, clientIdempotencyId });
    } catch (e) {
      this.egress.markFailed(egressRecordId, (e as Error).message);
      throw e;
    }
    const latencyMs = Date.now() - started;
    const { costMicro } = recordUsage(this.store, {
      requestId: result.requestId,
      task: args.task,
      route,
      usage: result.usage,
      clientIdempotencyId,
      latencyMs,
    });
    // 回填上游请求 ID（数据去向记录与 MaaS 消费日志对账的键）
    this.store.run(`UPDATE egress_records SET request_id = ? WHERE record_id = ?`, [result.requestId, egressRecordId]);
    return {
      content: result.content,
      toolCalls: result.toolCalls,
      finishReason: result.finishReason,
      usage: result.usage,
      costMicroCny: costMicro,
      requestId: result.requestId,
      route: route.alias,
      provider: provider.name,
      endpointKind,
      egressRecordId,
      latencyMs,
    };
  }

  /** 流式（Agent 宿主经本机 HTTP 端点使用；工作流用非流式）。 */
  async chatStream(args: BrokerChatArgs): Promise<{ requestId: string; chunks: AsyncIterable<string>; finalize: () => Promise<void> }> {
    const route = this.resolveRoute(args.route);
    const clientIdempotencyId = args.clientIdempotencyId ?? `idem_${randomUUID()}`;
    const req: ChatRequest = { ...this.buildRequest(route, args), stream: true };
    const texts = args.messages.map((m) => (typeof m.content === "string" ? m.content : "")).filter((t) => t.length > 0);
    const started = Date.now();

    if (route.provider === "mock") {
      this.egress.assertMatterAllowsModel(args.matter, args.matter.model_endpoint);
      this.egress.recordMock({ matter: args.matter, task: args.task, texts, requestId: clientIdempotencyId, clientIdempotencyId, note: args.note });
      const s = await mockProvider.chatStream(route, req);
      return {
        requestId: s.requestId,
        chunks: s.chunks,
        finalize: async () => {
          const usage = await s.finalUsage;
          recordUsage(this.store, { requestId: s.requestId, task: args.task, route, usage, clientIdempotencyId, latencyMs: Date.now() - started });
        },
      };
    }
    const endpointKind = args.matter.model_endpoint;
    if (endpointKind === "none") {
      throw new DomainError("egress_blocked", "该事项设置为「不使用模型」", 422);
    }
    this.egress.assertMatterAllowsModel(args.matter, endpointKind);
    const endpoint = resolveEndpoint(endpointKind, this.env);
    if (!endpoint.baseUrl || !endpoint.apiKey) {
      throw new DomainError("provider_unavailable", `模型端点不可用：${endpoint.missingNote ?? "未配置"}`, 503);
    }
    const { provider } = this.upstreamFor(endpointKind);
    const host = new URL(endpoint.baseUrl).host;
    const send = this.egress.beforeModelSend({
      matter: args.matter,
      task: args.task,
      endpoint: endpointKind,
      destinationHost: host,
      texts,
      requestId: null,
      clientIdempotencyId,
    });
    let s;
    try {
      s = await provider.chatStream(route, { ...req, messages: this.applyEgressTexts(req.messages, send.texts) }, { nonce: randomUUID(), clientIdempotencyId });
    } catch (e) {
      this.egress.markFailed(send.recordId, (e as Error).message);
      throw e;
    }
    return {
      requestId: s.requestId,
      chunks: s.chunks,
      finalize: async () => {
        const usage = await s.finalUsage;
        recordUsage(this.store, { requestId: s.requestId, task: args.task, route, usage, clientIdempotencyId, latencyMs: Date.now() - started });
        this.store.run(`UPDATE egress_records SET request_id = ? WHERE record_id = ?`, [s.requestId, send.recordId]);
      },
    };
  }
}

export { PRICE_VERSION };
