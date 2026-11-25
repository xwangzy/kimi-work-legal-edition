/**
 * 本机模型代理（方案 v5.0 第 4 篇 §10.1；v9 第 04 篇 §1.2 第 3 条）：内核内的本机服务，确定性工作流与（旧）SDK 宿主经它调用模型。
 *
 * 职责：路由（只在经评测等价的模型之间切换，不为可用率静默降级）、推理档位、预算、计量、客户端幂等 ID。
 * 出站一律经出站闸门进程（v9 阶段 4）：本进程不持有任何上游地址或密钥，不直连上游；mock 只在本机（无网络）。
 */
import { randomUUID } from "node:crypto";
import { DomainError, type Matter, type ModelEndpoint } from "@zr-legal/domain";
import type { EgressGate, EgressTaskRef } from "@zr-legal/egress";
import { buildRoutes, PRICE_VERSION, type BrokerEnv, type RouteDef } from "./config.ts";
import { recordUsage, type MeterStore } from "./meter.ts";
import { mockProvider } from "./providers/mock.ts";
import { createGateProvider, type GateMeta, type GateProvider, type GateTransport } from "./providers/gate.ts";
import type { ChatMessage, ChatRequest, ToolCall, UsageBuckets } from "./providers/types.ts";

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
  /** 中止在途请求（任务令牌失效；复审 N-01）。 */
  signal?: AbortSignal | undefined;
  /** 调用方已持有的任务令牌（本机端点转发宿主请求时原样交给闸门再验；缺省由闸门传输按任务签发）。 */
  bearer?: string | undefined;
  /**
   * 内核自己发起、内容已按来源分别处理过的请求（独立复核；V16 第 41 批）：闸门整段只替换已知名单。
   * 只在闸门传输按任务签发令牌时生效（令牌带 model:known_only）；带着 bearer 转发的请求用的是调用方自己的令牌，不受此项影响。
   */
  knownOnly?: boolean | undefined;
}

export interface BrokerChatResult {
  content: string | null;
  toolCalls?: ToolCall[] | undefined;
  /** 上游未给出时为 null（复审 N-07）。 */
  finishReason: string | null;
  usage: UsageBuckets;
  costMicroCny: number | null;
  requestId: string;
  route: string;
  provider: string;
  endpointKind: ModelEndpoint | "mock";
  /** mock：本机去向记录 ID；经闸门：闸门请求 ID（事项账本里该去向记录的 request_id）。 */
  egressRecordId: string;
  latencyMs: number;
}

export interface BrokerStore extends MeterStore {
  run(sql: string, params: unknown[]): void;
}

/**
 * 云端模型目录里的一项（第 66 批，V40）：只有别名与能力——上游型号、地址与密钥不在客户端（网关按别名路由）。
 * 内核的模型目录服务（kernel services/model-catalog.ts）验签后交给 setCatalog。
 */
export interface CatalogRouteSpec {
  id: string;
  thinking: "effort" | "toggle" | "none";
  efforts: ("low" | "high" | "max")[];
  available: boolean;
}

/** 内置别名（旧客户端与子 Agent 写死；云端不可删）。 */
export const BUILTIN_ROUTE_ALIASES: readonly string[] = ["legal/k3", "legal/k2.6"];

export class ModelBroker {
  /** 内置两项（本机配置；mock 与自带密钥 / 私有端点时 providerModel 才有意义）。 */
  private readonly builtin: Record<string, RouteDef>;
  /** 第 66 批：云端目录里可用的其余别名（setCatalog 整表替换）。标准端点下别名原样发给网关，由网关换成上游型号。 */
  private dynamic: Record<string, RouteDef> = {};
  private readonly store: BrokerStore;
  private readonly egress: EgressGate;
  private readonly gate: GateProvider | null;

  constructor(store: BrokerStore, egress: EgressGate, env: BrokerEnv = process.env, opts: { gate?: GateTransport } = {}) {
    this.store = store;
    this.egress = egress;
    this.builtin = buildRoutes(env);
    this.gate = opts.gate ? createGateProvider(opts.gate) : null;
  }

  private get routes(): Record<string, RouteDef> {
    return { ...this.dynamic, ...this.builtin };
  }

  /**
   * 按云端目录补别名（第 66 批）：只收 available 的非内置项；内置两项始终在（子 Agent、独立复核与旧调用写死了它们）。
   * 思考控制取目录（effort / toggle / none），替代按别名写死；提供方随内置 K3（mock 形态仍在本机模拟）。
   */
  setCatalog(list: readonly CatalogRouteSpec[]): void {
    const base = this.builtin["legal/k3"]!;
    const next: Record<string, RouteDef> = {};
    for (const m of list) {
      if (!m.available || BUILTIN_ROUTE_ALIASES.includes(m.id) || !/^[a-z0-9][a-z0-9._/-]{1,47}$/.test(m.id)) continue;
      const effort = m.thinking === "effort";
      const efforts = effort ? m.efforts.filter((e) => e === "low" || e === "high" || e === "max") : [];
      next[m.id] = {
        alias: m.id,
        provider: base.provider,
        providerModel: m.id,
        supportsEffort: effort,
        defaultEffort: effort ? (efforts.includes("high") ? "high" : (efforts[0] ?? null)) : null,
        allowedEfforts: efforts,
        temperature: null,
        thinkingControl: m.thinking,
        priceKey: effort ? "k3" : "k26",
        maxOutputTokens: base.maxOutputTokens ?? 32_000,
      };
    }
    this.dynamic = next;
  }

  /** 是不是内置别名（自带密钥 / 私有端点只映射内置别名）。 */
  isBuiltinRoute(alias: string): boolean {
    return BUILTIN_ROUTE_ALIASES.includes(alias);
  }

  routeAliases(): string[] {
    return Object.keys(this.routes);
  }

  resolveRoute(alias: string | undefined): RouteDef {
    const route = alias ? this.routes[alias] : undefined;
    if (!route) throw new DomainError("validation", `未知模型路由 "${alias}"；可用: ${this.routeAliases().join(", ")}`, 422);
    return route;
  }

  /** 真实链路的前置：事项策略（人话拦截）→ 闸门已接入。返回闸门 provider 与调用元数据。 */
  private gateCall(args: BrokerChatArgs, clientIdempotencyId: string): { gate: GateProvider; meta: GateMeta; endpointKind: ModelEndpoint } {
    const endpointKind = args.matter.model_endpoint;
    if (endpointKind === "none") {
      throw new DomainError("egress_blocked", "该事项设置为「不使用模型」：只用本机确定性工具与人工。", 422);
    }
    // 先事项策略（人话拦截；闸门另行独立裁决）→ 再经闸门（唯一出口）
    this.egress.assertMatterAllowsModel(args.matter, endpointKind);
    // 第 66 批：自带密钥 / 私有端点只把内置两项映射到上游型号；云端新增的别名原样发过去必然失败——在这里说清楚，不发出
    if (endpointKind !== "standard" && !this.isBuiltinRoute(args.route)) {
      throw new DomainError("validation", `本事项用的是${endpointKind === "byok" ? "律所自带密钥" : "私有模型"}端点，只能用内置的 K3 或 K2.6；所选模型只在中软标准端点可用：请换成 K3，或把事项改用标准端点`, 422);
    }
    if (!this.gate) throw new DomainError("provider_unavailable", "出站闸门未接入：内核不直连上游（模型步骤已排队）", 503);
    return {
      gate: this.gate,
      endpointKind,
      meta: {
        nonce: randomUUID(),
        clientIdempotencyId,
        signal: args.signal,
        task: { tid: args.task.tid, uid: args.task.uid, mid: args.task.mid, rid: args.task.rid, aid: args.task.aid, ...(args.knownOnly ? { knownOnly: true } : {}) },
        bearer: args.bearer,
      },
    };
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
      max_tokens: args.maxTokens ?? route.maxOutputTokens ?? 32_000,
      tools: args.tools,
      tool_choice: args.toolChoice,
    };
  }

  async chat(args: BrokerChatArgs): Promise<BrokerChatResult> {
    if (args.signal?.aborted) throw new DomainError("cancelled", "任务令牌已失效：不调用上游", 401);
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

    // 真实链路：一律经出站闸门进程（端点按事项选定，由闸门转发；令牌化与去向记录在闸门）
    const { gate, meta, endpointKind } = this.gateCall(args, clientIdempotencyId);
    const result = await gate.chat(route, req, meta);
    const latencyMs = Date.now() - started;
    const { costMicro } = recordUsage(this.store, {
      requestId: result.requestId,
      task: args.task,
      route,
      usage: result.usage,
      clientIdempotencyId,
      latencyMs,
    });
    return {
      content: result.content,
      toolCalls: result.toolCalls,
      finishReason: result.finishReason,
      usage: result.usage,
      costMicroCny: costMicro,
      requestId: result.requestId,
      route: route.alias,
      provider: gate.name,
      endpointKind,
      egressRecordId: result.requestId,
      latencyMs,
    };
  }

  /** 流式（Agent 宿主经本机 HTTP 端点使用；工作流用非流式）。 */
  async chatStream(args: BrokerChatArgs): Promise<{ requestId: string; chunks: AsyncIterable<string>; finalize: () => Promise<void> }> {
    if (args.signal?.aborted) throw new DomainError("cancelled", "任务令牌已失效：不调用上游", 401);
    const route = this.resolveRoute(args.route);
    const clientIdempotencyId = args.clientIdempotencyId ?? `idem_${randomUUID()}`;
    const req: ChatRequest = { ...this.buildRequest(route, args), stream: true };
    const texts = args.messages.map((m) => (typeof m.content === "string" ? m.content : "")).filter((t) => t.length > 0);
    const started = Date.now();

    if (route.provider === "mock") {
      this.egress.assertMatterAllowsModel(args.matter, args.matter.model_endpoint);
      this.egress.recordMock({ matter: args.matter, task: args.task, texts, requestId: clientIdempotencyId, clientIdempotencyId, note: args.note });
      const s = await mockProvider.chatStream(route, req, { nonce: "mock", clientIdempotencyId, signal: args.signal });
      return {
        requestId: s.requestId,
        chunks: s.chunks,
        finalize: async () => {
          const usage = await s.finalUsage;
          recordUsage(this.store, { requestId: s.requestId, task: args.task, route, usage, clientIdempotencyId, latencyMs: Date.now() - started });
        },
      };
    }
    const { gate, meta } = this.gateCall(args, clientIdempotencyId);
    const s = await gate.chatStream(route, req, meta);
    return {
      requestId: s.requestId,
      chunks: s.chunks,
      finalize: async () => {
        const usage = await s.finalUsage;
        recordUsage(this.store, { requestId: s.requestId, task: args.task, route, usage, clientIdempotencyId, latencyMs: Date.now() - started });
      },
    };
  }
}

export { PRICE_VERSION };
