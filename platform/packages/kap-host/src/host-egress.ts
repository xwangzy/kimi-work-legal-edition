/**
 * Agent 宿主的 HTTP 出口（v9 第 04 篇 §1.2 第 3 条、§5.1 第②级：宿主与 kap-server 的网络调用全部配置到闸门）。
 *
 * 宿主进程的全局调度器只认两个伪主机名，其余一律在本进程内失败（不发起任何连接）：
 * - `gate.kwl/m/<事项>/v1/…`：模型请求。按请求体里引擎写入的 `prompt_cache_key`（= 会话 ID，`profileService.ts:471`）
 *   找到会话绑定的任务，换上**该任务的令牌**（绑定尝试与纪元，闸门逐次向内核复核活性），路径中的事项必须与会话绑定事项一致；
 *   会话未绑定、任务已结束、事项不符、请求体读不出会话 → 拒绝。转发到出站闸门时保留 `/m/<事项>` 前缀（闸门按事项取出站上下文）。
 * - `gate.kwl/m/<事项>/search`、`/fetch`：联网检索与网页抓取（WebSearch、FetchURL）。按 `X-Msh-Tool-Call-Id` 找到本事项活动运行里
 *   **宿主策略刚放行的那一次**调用，且请求体的查询或 URL 与裁决时的参数摘要一致，才换上该运行的令牌；对不上、歧义或已用过 → 拒绝。
 * - `tools.kwl/m/<事项>/mcp`：法律 MCP。换上该事项的工具令牌（租户/用户/事项三重范围；方案能力账本 MCP 行）。
 *
 * 这是**应用层路由**，不是隔离：同进程代码若直接使用原生 `net` 仍可直连（第 04 篇 §5.1 第②级的如实口径；
 * 强制版本是第⑤级 OS 出站规则）。宿主进程同时以 `NODE_USE_ENV_PROXY=1` + 黑洞代理拉起，使遵守代理的客户端失败关闭。
 */
import { Agent, Dispatcher } from "undici";
import { egressDigest } from "./policy.ts";

export const MODEL_HOST = "gate.kwl";
export const TOOLS_HOST = "tools.kwl";

export interface ModelBinding {
  matterId: string;
  runId: string;
  /** 任务令牌（绑定 rid/aid/fence；闸门/内核逐次复核活性）。 */
  token: string;
  /** 检索/抓取所依据的宿主裁决（“裁决:原因”，ASCII；闸门写进去向记录作关联，不作授权依据；审查 S4-03）。 */
  decision?: string;
}

export interface EgressAuthority {
  /** 会话 → 任务绑定；null = 未绑定或任务已不在执行（失败关闭）。 */
  modelBinding(sessionId: string): ModelBinding | null;
  /** 事项 → 工具令牌；null = 该事项没有可用的工具令牌。 */
  toolsToken(matterId: string): string | null;
  /**
   * 检索/抓取 → 任务绑定：本事项活动运行中，宿主策略已放行、工具调用 ID 与参数摘要都一致、尚未用过的那一次 WebSearch/FetchURL 裁决；
   * 找不到、歧义或已用过返回 null（失败关闭）。每次裁决只能换取一次。
   */
  toolEgressBinding?(matterId: string, tool: "WebSearch" | "FetchURL", toolCallId: string, digest: string): ModelBinding | null;
}

export interface EgressRecord {
  at: string;
  route: "model" | "search" | "fetch" | "tools" | "denied";
  host: string;
  path: string;
  matterId: string | null;
  runId: string | null;
  sessionId: string | null;
  reason: string | null;
}

export interface HostEgressOptions {
  /** 出站闸门（模型、检索、抓取）的本机套接字/命名管道；null = 闸门未配置：模型、检索、抓取一律拒绝（失败关闭，不改为别的通道）。 */
  modelSocket: string | null;
  /** 内核法律 MCP 的本机套接字/命名管道。 */
  toolsSocket: string;
  authority: EgressAuthority;
}

/** 模型请求的首包头超时（毫秒）：与 undici 缺省值相同，显式写出，作为唯一设置点（Z2 评审 N-1）。 */
export const MODEL_HEADERS_TIMEOUT_MS = 300_000;

const MATTER_PREFIX = /^\/m\/([A-Za-z0-9_.-]{1,128})(\/.*)$/;
const STRIPPED_HEADERS = new Set(["authorization", "x-api-key", "api-key", "host", "proxy-authorization", "cookie"]);

class EgressDenied extends Error {
  readonly code = "KWL_EGRESS_DENIED";
  constructor(reason: string) {
    super(`宿主出口拒绝：${reason}`);
    this.name = "EgressDenied";
  }
}

/** 拒绝调度器：连接阶段即失败，不产生任何套接字。 */
function denyAgent(reason: string): Agent {
  return new Agent({
    connect: (_opts: unknown, cb: (err: Error | null, socket: null) => void) => cb(new EgressDenied(reason), null),
  } as unknown as Agent.Options);
}

function normalizeHeaders(h: Dispatcher.DispatchOptions["headers"], strip: ReadonlySet<string> = STRIPPED_HEADERS): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (k: string, v: unknown) => {
    if (v === undefined) return;
    const key = k.toLowerCase();
    if (strip.has(key)) return;
    out[key] = Array.isArray(v) ? v.join(", ") : String(v);
  };
  if (!h) return out;
  if (Array.isArray(h)) {
    // 扁平数组 [k, v, k, v]，或 [[k, v], …]
    if (h.length > 0 && Array.isArray(h[0])) for (const [k, v] of h as unknown as [string, string][]) put(k, v);
    else for (let i = 0; i + 1 < h.length; i += 2) put(String(h[i]), h[i + 1]);
    return out;
  }
  const proto = Object.getPrototypeOf(h);
  if (proto !== Object.prototype && proto !== null && typeof (h as Iterable<unknown>)[Symbol.iterator] === "function") {
    for (const [k, v] of h as Iterable<[string, string | string[] | undefined]>) put(k, v);
    return out;
  }
  for (const [k, v] of Object.entries(h as Record<string, unknown>)) put(k, v);
  return out;
}

/** 模型请求换了请求体缓冲：长度与分块头由 undici 按新请求体重新计算。 */
const MODEL_STRIPPED_HEADERS = new Set([...STRIPPED_HEADERS, "content-length", "transfer-encoding"]);

async function collectBody(body: unknown): Promise<Buffer | null> {
  if (body == null) return null;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of body as AsyncIterable<unknown>) {
      const b = typeof c === "string" ? Buffer.from(c) : Buffer.from(c as Uint8Array);
      size += b.length;
      if (size > 64 * 1024 * 1024) throw new EgressDenied("request_body_too_large");
      chunks.push(b);
    }
    return Buffer.concat(chunks);
  }
  throw new EgressDenied("unsupported_request_body");
}

function sessionKeyOf(body: Buffer | null): string | null {
  if (!body || body.length === 0) return null;
  try {
    const j = JSON.parse(body.toString("utf8")) as { prompt_cache_key?: unknown; metadata?: { user_id?: unknown } };
    if (typeof j.prompt_cache_key === "string" && j.prompt_cache_key.length > 0) return j.prompt_cache_key;
    if (typeof j.metadata?.user_id === "string" && j.metadata.user_id.length > 0) return j.metadata.user_id;
  } catch {
    return null;
  }
  return null;
}

export class HostEgressDispatcher extends Dispatcher {
  readonly records: EgressRecord[] = [];
  private readonly modelAgent: Agent | null;
  private readonly toolsAgent: Agent;
  private readonly authority: EgressAuthority;

  constructor(opts: HostEgressOptions) {
    super();
    this.authority = opts.authority;
    // 首包头超时只在宿主出口设（ZP-23 封闭了引擎按 KIMI_CODE_LLM_HEADERS_TIMEOUT_MS 自建调度器的路径）
    this.modelAgent = opts.modelSocket
      ? new Agent({ connect: { socketPath: opts.modelSocket }, keepAliveTimeout: 10_000, keepAliveMaxTimeout: 60_000, headersTimeout: MODEL_HEADERS_TIMEOUT_MS })
      : null;
    this.toolsAgent = new Agent({ connect: { socketPath: opts.toolsSocket }, keepAliveTimeout: 10_000, keepAliveMaxTimeout: 60_000 });
  }

  private record(r: Omit<EgressRecord, "at">): void {
    this.records.push({ at: new Date().toISOString(), ...r });
    if (this.records.length > 5000) this.records.splice(0, 1000);
  }

  private deny(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler, host: string, path: string, reason: string, sessionId: string | null = null): boolean {
    this.record({ route: "denied", host, path: path.slice(0, 200), matterId: null, runId: null, sessionId, reason });
    // 去掉请求体后交给拒绝调度器：在连接阶段失败，按 undici 自身的错误路径通知调用方
    return denyAgent(reason).dispatch({ ...opts, body: null }, handler);
  }

  override dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    let url: URL;
    try {
      url = new URL(opts.path, opts.origin ?? "http://invalid.kwl");
    } catch {
      return this.deny(opts, handler, "?", String(opts.path), "bad_url");
    }
    const host = url.hostname.toLowerCase();
    const path = `${url.pathname}${url.search}`;
    if (url.protocol !== "http:" || (host !== MODEL_HOST && host !== TOOLS_HOST)) {
      return this.deny(opts, handler, host, path, `host_not_allowed`);
    }
    const m = MATTER_PREFIX.exec(url.pathname);
    if (!m) return this.deny(opts, handler, host, path, "matter_prefix_missing");
    const matterId = m[1]!;
    const innerPath = `${m[2]}${url.search}`;
    const headers = normalizeHeaders(opts.headers, host === MODEL_HOST ? MODEL_STRIPPED_HEADERS : STRIPPED_HEADERS);

    if (host === TOOLS_HOST) {
      const token = this.authority.toolsToken(matterId);
      if (!token) return this.deny(opts, handler, host, path, "tools_token_unavailable");
      this.record({ route: "tools", host, path: innerPath.slice(0, 200), matterId, runId: null, sessionId: null, reason: null });
      return this.toolsAgent.dispatch({ ...opts, origin: `http://${TOOLS_HOST}`, path: innerPath, headers: { ...headers, authorization: `Bearer ${token}` } }, handler);
    }

    const gateAgent = this.modelAgent;
    if (!gateAgent) return this.deny(opts, handler, host, path, "egress_gate_not_configured");
    // 引擎自带的 x-kwl-* 请求头一律剥掉（复核 S5A-12）：这类头只由宿主写入（关联用的裁决与调用编号），不能被引擎伪造而错配时间线
    for (const k of Object.keys(headers)) if (k.toLowerCase().startsWith("x-kwl-")) delete headers[k];
    // 检索与抓取：按工具调用 ID 与参数摘要对到宿主策略刚放行的那一次调用（每次裁决只换一次运行令牌）
    if (m[2] === "/search" || m[2] === "/fetch") {
      const tool = m[2] === "/search" ? ("WebSearch" as const) : ("FetchURL" as const);
      const callId = headers["x-msh-tool-call-id"];
      delete headers["x-msh-tool-call-id"];
      if (!callId) return this.deny(opts, handler, host, path, "tool_call_id_missing");
      if (url.search) return this.deny(opts, handler, host, path, "query_string_not_allowed");
      void collectBody(opts.body)
        .then((body) => {
          let value: unknown;
          try {
            const j = JSON.parse(body?.toString("utf8") ?? "") as { text_query?: unknown; url?: unknown };
            value = tool === "WebSearch" ? j.text_query : j.url;
          } catch {
            value = undefined;
          }
          if (typeof value !== "string") return this.deny(opts, handler, host, path, "egress_body_unreadable");
          const binding = this.authority.toolEgressBinding?.(matterId, tool, callId, egressDigest(tool, value)) ?? null;
          if (!binding) return this.deny(opts, handler, host, path, "tool_call_not_approved_or_args_mismatch");
          if (binding.matterId !== matterId) return this.deny(opts, handler, host, path, "matter_mismatch");
          this.record({ route: tool === "WebSearch" ? "search" : "fetch", host, path: m[2]!, matterId, runId: binding.runId, sessionId: null, reason: null });
          const decisionHeader = binding.decision ? { "x-kwl-host-decision": binding.decision.replace(/[^\x20-\x7e]/g, "").slice(0, 120) } : {};
          // 工具调用编号只作去向记录与时间线步骤的关联（界面据此在该步骤显示实际发出的内容；v9.2 Y4 P0-A），不作授权依据
          const callHeader = /^[A-Za-z0-9_:.-]{1,128}$/.test(callId) ? { "x-kwl-tool-call": callId } : {};
          return gateAgent.dispatch({ ...opts, origin: `http://${MODEL_HOST}`, path: url.pathname, body, headers: { ...headers, ...decisionHeader, ...callHeader, authorization: `Bearer ${binding.token}` } }, handler);
        })
        .catch((err: unknown) => this.deny(opts, handler, host, path, err instanceof EgressDenied ? err.message : "request_body_unreadable"));
      return true;
    }

    // 模型请求：读出请求体中的会话键再决定（异步读取不阻塞调用方；读取失败按拒绝处理）
    void collectBody(opts.body)
      .then((body) => {
        const sessionId = sessionKeyOf(body);
        if (!sessionId) return this.deny(opts, handler, host, path, "session_key_missing");
        const binding = this.authority.modelBinding(sessionId);
        if (!binding) return this.deny(opts, handler, host, path, "session_not_bound_or_run_not_live", sessionId);
        if (binding.matterId !== matterId) return this.deny(opts, handler, host, path, "matter_mismatch", sessionId);
        this.record({ route: "model", host, path: innerPath.slice(0, 200), matterId, runId: binding.runId, sessionId, reason: null });
        // 出站闸门按事项取上下文：保留 /m/<事项> 前缀
        return gateAgent.dispatch(
          {
            ...opts,
            origin: `http://${MODEL_HOST}`,
            path: `${url.pathname}${url.search}`,
            body,
            headers: { ...headers, authorization: `Bearer ${binding.token}` },
          },
          handler,
        );
      })
      .catch((err: unknown) => this.deny(opts, handler, host, path, err instanceof EgressDenied ? err.message : "request_body_unreadable"));
    return true;
  }

  override async close(): Promise<void> {
    await Promise.allSettled([this.modelAgent?.close(), this.toolsAgent.close()]);
  }

  override async destroy(): Promise<void> {
    await Promise.allSettled([this.modelAgent?.destroy(), this.toolsAgent.destroy()]);
  }
}
