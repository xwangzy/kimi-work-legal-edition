/**
 * 内核本机端点（方案 v5.0 第 4 篇 §3/§10.1）：只监听 127.0.0.1，供 Agent 宿主进程使用。
 *   POST /mcp                     法律工具 MCP（JSON-RPC 单响应形态），scope=tool:legal
 *   POST /v1/chat/completions     模型代理 OpenAI 兼容（stream / 非 stream），scope=model:chat
 *   GET  /v1/models、/healthz
 *
 * 身份只信任务令牌 claims（§4.2：拒绝模型或客户端自报身份）；每任务令牌由内核签发，
 * 急停即撤销（令牌过期 + 宿主进程树被杀）。阶段 2 迁移为命名管道传输（协议不变）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { DomainError } from "@zr-legal/domain";
import { bearerToken, verifyToken, type CapabilityClaims } from "@zr-legal/service-auth";
import type { ModelBroker } from "@zr-legal/model-broker";
import type { Lawdb } from "@zr-legal/lawdb";
import type { KernelDb } from "./db.ts";
import type { BlobStore } from "./blobs.ts";
import { TOOLS, findTool, invokeTool, validateParams } from "./tools/registry.ts";

const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface LocalServerDeps {
  db: KernelDb;
  blobs: BlobStore;
  broker: ModelBroker;
  lawdb: Lawdb;
  secret: string;
  /** 急停撤销集：任务令牌绑定已取消任务时即刻拒绝（§15.2 runs.cancel / §6.1 取消与急停）。 */
  isRevoked?: (rid: string | undefined) => boolean;
  /**
   * 非白名单路径请求计数（探针 2「遥测/更新/远程控制零外连」行为证据）：
   * 一切落在 {/healthz, /v1/models, /mcp, /v1/chat/completions} 之外的请求计数于此——
   * 宿主的任何遥测/更新/插件市场外呼都会经全局调度器落到管道 404 并计数。
   * rejectedPaths 保留前 N 条（方法与路径）供取证，不含请求体。
   * rejectedToolCalls：MCP 工具白名单外的 tools/call 拒绝计数（纵深一致性，同一取证风格）。
   */
  stats?: { rejectedPathRequests: number; rejectedPaths: string[]; rejectedToolCalls: number };
  /**
   * MCP 工具白名单（§4.2 工具层纵深一致性：tools/list 只返回白名单内工具，
   * tools/call 对白名单外一律 -32601 拒绝并计数——不依赖引擎侧单层 enabledTools）。
   * 未配置时不过滤（独立部署/测试形态，注释说明）。
   */
  mcpToolsAllowlist?: readonly string[];
}

function jsonrpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new DomainError("validation", "请求体须为 JSON", 400);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(data);
}

function errBody(e: unknown): { status: number; body: any } {
  if (e instanceof DomainError) return { status: e.httpStatus, body: { error: { message: e.message, code: e.code } } };
  const msg = (e as Error)?.message ?? "内部错误";
  return { status: 500, body: { error: { message: msg, code: "internal" } } };
}

function loadMatterForClaims(db: KernelDb, claims: CapabilityClaims): any {
  if (!claims.mid) throw new DomainError("forbidden", "任务令牌未绑定事项", 403);
  const m = db.get(`SELECT * FROM matters WHERE matter_id = ? AND tenant_id = ?`, [claims.mid, claims.tid]);
  if (!m) throw new DomainError("forbidden", "事项不存在或令牌不匹配", 403);
  const keyDates = typeof (m as any).key_dates === "string" ? JSON.parse((m as any).key_dates) : ((m as any).key_dates ?? {});
  return { ...m, key_dates: keyDates };
}

export async function startLocalServer(deps: LocalServerDeps, opts: { host?: string; port?: number; pipePath?: string } = {}): Promise<LocalServers> {
  const { db, blobs, broker, lawdb, secret, isRevoked } = deps;
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 0;

  function auth(req: IncomingMessage, scope: string): CapabilityClaims {
    return verifyToken(bearerToken(req.headers.authorization), secret, scope);
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let claims: CapabilityClaims;
    try {
      claims = auth(req, "tool:legal");
      if (isRevoked?.(claims.rid)) throw new DomainError("cancelled", "任务已取消：任务令牌已撤销", 401);
    } catch (e) {
      return sendJson(res, 401, jsonrpcError(null, -32001, (e as Error).message));
    }
    const msg = await readBody(req);
    if (msg?.jsonrpc !== "2.0" || !msg.method) return sendJson(res, 400, jsonrpcError(msg?.id ?? null, -32600, "Invalid Request"));
    const id = msg.id ?? null;
    switch (msg.method) {
      case "initialize":
        return sendJson(res, 200, {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "kwl-kernel-legal-tools", version: "5.0.0-g0", title: "Kimi Work 法律发行版本机法律工具" },
            instructions: "受控法律工具集；外发、签发、删除类能力不在此暴露。",
          },
        });
      case "ping":
        return sendJson(res, 200, { jsonrpc: "2.0", id, result: {} });
      case "notifications/initialized":
      case "notifications/cancelled":
        res.writeHead(202);
        res.end();
        return;
      case "tools/list": {
        // 白名单收窄（纵深一致性：声明子集之外的工具在 MCP 面同样不可见）；未配置时保持全量
        const allow = deps.mcpToolsAllowlist ? new Set(deps.mcpToolsAllowlist) : null;
        const tools = allow ? TOOLS.filter((t) => allow.has(t.name)) : TOOLS;
        return sendJson(res, 200, {
          jsonrpc: "2.0",
          id,
          result: { tools: tools.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema })) },
        });
      }
      case "tools/call": {
        const { name, arguments: args } = msg.params ?? {};
        if (typeof name !== "string") return sendJson(res, 200, jsonrpcError(id, -32602, "tools/call 需要 name"));
        if (deps.mcpToolsAllowlist && !deps.mcpToolsAllowlist.includes(name)) {
          if (deps.stats) deps.stats.rejectedToolCalls += 1; // 白名单外调用取证（与路径计数同一风格）
          return sendJson(res, 200, jsonrpcError(id, -32601, `工具 ${name} 不在本机法律工具白名单（A1 工具面声明子集），已拒绝`));
        }
        if (!findTool(name)) return sendJson(res, 200, { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `not_found: 工具 ${name} 不存在` }], isError: true } });
        try {
          const result = await invokeTool(name, args ?? {}, { claims, db, blobs, lawdb });
          return sendJson(res, 200, {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: false },
          });
        } catch (e) {
          const err = e as DomainError;
          return sendJson(res, 200, {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: `${err.code ?? "error"}: ${err.message}` }], isError: true },
          });
        }
      }
      default:
        return sendJson(res, 200, jsonrpcError(id, -32601, `Method not found: ${msg.method}`));
    }
  }

  async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let claims: CapabilityClaims;
    try {
      claims = auth(req, "model:chat");
      if (isRevoked?.(claims.rid)) throw new DomainError("cancelled", "任务已取消：任务令牌已撤销", 401);
    } catch (e) {
      return sendJson(res, 401, { error: { message: (e as Error).message } });
    }
    const body = await readBody(req);
    const matter = loadMatterForClaims(db, claims);
    const task = { tid: claims.tid, uid: claims.uid, mid: claims.mid!, rid: claims.rid, aid: claims.aid };
    try {
      if (body?.stream === true) {
        const s = await broker.chatStream({
          matter,
          task,
          route: String(body?.model ?? ""),
          messages: body?.messages,
          effort: body?.reasoning_effort,
          responseFormat: body?.response_format,
          maxTokens: body?.max_tokens,
          tools: body?.tools,
          toolChoice: body?.tool_choice,
        });
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "x-kwl-request-id": s.requestId,
        });
        for await (const chunk of s.chunks) {
          res.write(`data: ${chunk}\n\n`);
        }
        res.end();
        await s.finalize();
        return;
      }
      const r = await broker.chat({
        matter,
        task,
        route: String(body?.model ?? ""),
        messages: body?.messages,
        effort: body?.reasoning_effort,
        responseFormat: body?.response_format,
        maxTokens: body?.max_tokens,
        tools: body?.tools,
        toolChoice: body?.tool_choice,
      });
      return sendJson(res, 200, {
        id: r.requestId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: r.route,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: r.content, ...(r.toolCalls && r.toolCalls.length > 0 ? { tool_calls: r.toolCalls } : {}) },
            finish_reason: r.finishReason,
          },
        ],
        usage: {
          prompt_tokens: r.usage.uncached_input + r.usage.cached_input,
          completion_tokens: r.usage.output,
          total_tokens: r.usage.uncached_input + r.usage.cached_input + r.usage.output,
          prompt_cache_hit_tokens: r.usage.cached_input,
          prompt_cache_miss_tokens: r.usage.uncached_input,
          prompt_cache_write_tokens: r.usage.cache_write,
          completion_tokens_details: { reasoning_tokens: r.usage.reasoning },
        },
        x_kwl: { route: r.route, provider: r.provider, endpoint: r.endpointKind, cost_microcny: r.costMicroCny, egress_record_id: r.egressRecordId },
      });
    } catch (e) {
      const { status, body: b } = errBody(e);
      return sendJson(res, status, b);
    }
  }

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (req.method === "GET" && url.pathname === "/healthz") {
          return sendJson(res, 200, { ok: true, service: "kwl-kernel-local", routes: broker.routeAliases() });
        }
        if (req.method === "GET" && url.pathname === "/v1/models") {
          try {
            auth(req, "model:chat");
          } catch (e) {
            return sendJson(res, 401, { error: { message: (e as Error).message } });
          }
          return sendJson(res, 200, { object: "list", data: broker.routeAliases().map((a) => ({ id: a, object: "model", owned_by: "kwl-kernel" })) });
        }
        if (req.method === "POST" && url.pathname === "/mcp") return await handleMcp(req, res);
        // MCP 法律通道的 GET 探测（Streamable HTTP 会话握手/SSE 探测，客户端随即回退 POST）——
        // 按协议回 405 并计入白名单（非遥测/更新类请求；探针 2 取证实证为 GET /mcp）
        if (req.method === "GET" && url.pathname === "/mcp") return sendJson(res, 405, { error: { message: "MCP 端点仅支持 POST（JSON-RPC）" } });
        if (req.method === "POST" && url.pathname === "/v1/chat/completions") return await handleChat(req, res);
        if (deps.stats) {
          deps.stats.rejectedPathRequests += 1; // 探针 2：非白名单路径计数 + 取证
          if (deps.stats.rejectedPaths.length < 10) deps.stats.rejectedPaths.push(`${req.method} ${url.pathname}`);
        }
        return sendJson(res, 404, { error: { message: "not found" } });
      } catch (e) {
        const { status, body } = errBody(e);
        return sendJson(res, status, body);
      }
    })();
  };

  // 同一处理器挂两个监听：回环 TCP（开发/桥接；可用 ZR_KERNEL_TCP=off 关闭验证纯管道模式）
  // 与命名管道（Agent 宿主的唯一通道；§4.2 网络层）。
  const servers: LocalServers = { tcp: null, pipe: null };
  const listens: Promise<void>[] = [];
  if (port >= 0) {
    const tcp = createServer(handler);
    servers.tcp = tcp;
    listens.push(new Promise((r) => tcp.listen(port, host, () => r())));
  }
  if (opts.pipePath) {
    const { mkdirSync, rmSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(opts.pipePath), { recursive: true });
    rmSync(opts.pipePath, { force: true });
    const pipe = createServer(handler);
    servers.pipe = pipe;
    listens.push(new Promise((r) => pipe!.listen(opts.pipePath as string, () => r())));
  }
  await Promise.all(listens);
  return servers;
}

export interface LocalServers {
  tcp: Server | null;
  pipe: Server | null;
}

export function localServerPort(server: Server | null): number {
  if (!server) return 0;
  return (server.address() as AddressInfo).port;
}
