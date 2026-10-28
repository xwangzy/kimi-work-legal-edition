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
import type { MatterTokenStore } from "./egress/matter-tokens.ts";
import { createHash } from "node:crypto";
import { argsHash, canonicalJson } from "@zr-legal/host-policy";
import { newId } from "@zr-legal/domain";
import { liveRunForClaims, tokenLiveness, type LiveRun } from "./identity.ts";
import { authorizeToolCall } from "@zr-legal/host-policy";
import { READBACK_MODEL_FIELDS, tokenizeByField, type ModelFieldRule } from "@zr-legal/egress-gate";
import { TOOLS, findTool, invokeTool, legalToolLockProblems, legalToolManifests, manifestFor, validateParams } from "./tools/registry.ts";

const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface LocalServerDeps {
  db: KernelDb;
  blobs: BlobStore;
  broker: ModelBroker;
  lawdb: Lawdb;
  /** 任务令牌验证密钥（内核进程内存中的随机密钥，identity.ts `taskTokenKey()`；复审 N-03）。 */
  secret: string;
  /**
   * 撤销集（v9 第 04 篇 §8；阶段 1 审查 R-01/R-06）：取消的任务（rid）与已撤销的令牌（jti，宿主退出、超时等）。
   * 另外每次调用都按 attempts 行复核尝试仍在执行且纪元一致（tokenLiveness）——尝试结束即令牌失效。
   */
  revoked?: { rids: ReadonlySet<string>; jtis: ReadonlySet<string> };
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
  /**
   * 事项令牌存储（v9 第 02 篇 §8.4“Agent、工作区与模型上下文一律只见令牌”）：法律工具的结果交回 Agent 之前按事项令牌化
   * （材料片段、比对段落、文件名等）；工具自己需要原文时在内核内还原（例如按令牌形态的锚点核对材料）。未配置时原样返回（测试形态）。
   */
  tokens?: MatterTokenStore;
}

/** 结构性字段（ID、摘要、地址、版本、枚举）：不做令牌化（避免把编号误当标识符替换）。 */
const STRUCTURAL_KEY = /(?:^|_)(?:id|ids|hash|sha256|uri|version|kind|status|code|type|mime|as_of|date|severity|decision|state)$/i;

/**
 * 工具结果按事项令牌化（深度遍历字符串值；结构性字段原样）。读回工具（riskcards.list 等）的结果里模型自己写的字段
 * 只替换已知名单（`tokenize` 第二个参数为 true；规则见 @zr-legal/egress-gate READBACK_MODEL_FIELDS，D-157 第二步）。
 */
export function tokenizeToolResult(value: unknown, tokenize: (s: string, knownOnly: boolean) => string, rule: ModelFieldRule | null = null): unknown {
  return tokenizeByField(value, (s, modelWritten, key) => (key && STRUCTURAL_KEY.test(key) ? s : tokenize(s, modelWritten)), rule);
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

/** 统一的“不存在”口径（复审 N-02）：越界与真不存在、各工具自带的 not_found 文案一律相同，不形成存在性探测。 */
export const UNIFORM_NOT_FOUND = "对象不存在或无权查看";

/** 在途副作用调用（tool_operation_id）：执行尚未返回的调用不能人工对账（复审 R-07）。 */
const inflightOperations = new Set<string>();

export function isToolOperationInFlight(toolOperationId: string): boolean {
  return inflightOperations.has(toolOperationId);
}

export async function startLocalServer(deps: LocalServerDeps, opts: { host?: string; port?: number; pipePath?: string } = {}): Promise<LocalServers> {
  const { db, blobs, broker, lawdb, secret } = deps;
  const revoked = deps.revoked ?? { rids: new Set<string>(), jtis: new Set<string>() };
  /** 活性 + 令牌与任务记录一致；有效时返回任务记录派生的上下文（复审 N-01/N-03）。 */
  const requireLive = (claims: CapabilityClaims): LiveRun => {
    const r = liveRunForClaims(db, claims, revoked);
    if (typeof r === "string") throw new DomainError("cancelled", `任务令牌已失效：${r}`, 401);
    return r;
  };
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 0;

  /**
   * 在途请求（复审 N-01）：每个已通过鉴权、尚未结束的工具调用与模型请求都登记在此，周期复核活性；
   * 令牌失效（取消、尝试被取代、任务终止、按 jti/rid 撤销）即中止——上游流与工具执行收到中止信号，
   * 失效之后不再送出任何结果。窗口上限 = 复核周期（200 ms），另可由撤销方立即触发（sweepNow）。
   */
  const inflight = new Set<{ claims: CapabilityClaims; controller: AbortController }>();
  const sweepNow = (): void => {
    for (const f of inflight) {
      if (f.controller.signal.aborted) continue;
      const why = tokenLiveness(db, f.claims, revoked);
      if (why) f.controller.abort(new DomainError("cancelled", `任务令牌已失效：${why}`, 401));
    }
  };
  const sweepTimer = setInterval(sweepNow, 200);
  sweepTimer.unref();
  const track = (claims: CapabilityClaims, res?: ServerResponse) => {
    const f = { claims, controller: new AbortController() };
    inflight.add(f);
    // 客户端断开（宿主取消、超时、退出）：响应未写完即中止上游（闸门）请求与工具执行（阶段 4 审查 S4-01 同一模式）
    if (res) {
      if (res.destroyed) f.controller.abort();
      else
        res.on("close", () => {
          if (!res.writableFinished) f.controller.abort();
        });
    }
    return { signal: f.controller.signal, done: () => inflight.delete(f) };
  };

  function auth(req: IncomingMessage, scope: string): CapabilityClaims {
    return verifyToken(bearerToken(req.headers.authorization), secret, scope);
  }

  // F3（审查 R-08）：清单来自验签后的锁文件；实现与锁文件不一致、未登记或锁文件不可用的工具不暴露、不可调用
  const manifestProblems = legalToolLockProblems();

  /**
   * 端点独立裁决（审查 R-09；第 04 篇 §1.2 第 6 条“每处独立校验”）：不信任宿主送来的“已批准”，
   * 也不采信令牌里的事项、用途与副作用类别——按任务记录派生（复审 N-03），再核对参数实际指向的事项。
   */
  function endpointAuthorize(name: string, args: unknown, run: LiveRun): void {
    const manifest = manifestFor(name);
    if (!manifest) throw new DomainError("forbidden", `工具 ${name} 不在验签清单内`, 403);
    if (!run.fx.includes(manifest.sideEffect)) throw new DomainError("forbidden", `本任务未授予副作用类别 ${manifest.sideEffect}`, 403);
    const d = authorizeToolCall(
      legalToolManifests(),
      {
        toolId: manifest.id,
        boundMatterId: run.matterId,
        requestedMatterId: requestedMatterOf(args),
        purpose: run.purpose,
        // 档位按任务记录（复核 B3-B01）：问答档在端点独立拒绝写类；手动档的“询问”已由宿主完成，端点按默认档裁决
        mode: run.mode === "chat" ? "chat" : "default",
      },
      args,
    );
    if (d.decision === "deny") {
      // 跨事项：与“对象不存在”逐字同一口径（不形成存在性探测）；真实原因只进本机取证计数
      if (d.reason === "cross_matter") {
        if (deps.stats) deps.stats.rejectedToolCalls += 1;
        throw new DomainError("not_found", UNIFORM_NOT_FOUND, 404);
      }
      throw new DomainError("forbidden", `端点裁决拒绝：${d.reason}`, 403);
    }
  }

  /** 参数实际指向的事项（文档版本、解析版本）；多个指向不同事项时返回哨兵值（必然与绑定事项不符）。 */
  function requestedMatterOf(args: unknown): string | null {
    if (!args || typeof args !== "object") return null;
    const a = args as Record<string, unknown>;
    const found = new Set<string>();
    for (const k of ["document_version_id", "baseline_document_version_id", "current_document_version_id"]) {
      if (typeof a[k] === "string") {
        const r = db.get<{ matter_id: string }>(`SELECT matter_id FROM document_versions WHERE document_version_id = ?`, [a[k]]);
        if (r) found.add(r.matter_id);
      }
    }
    if (typeof a.parse_version_id === "string") {
      const r = db.get<{ matter_id: string }>(
        `SELECT dv.matter_id FROM parse_versions pv JOIN document_versions dv ON dv.document_version_id = pv.document_version_id WHERE pv.parse_version_id = ?`,
        [a.parse_version_id],
      );
      if (r) found.add(r.matter_id);
    }
    if (found.size === 0) return null;
    if (found.size > 1) return "__multiple_matters__";
    return [...found][0]!;
  }

  /** 工具上下文用任务记录派生的事项（不采信令牌 mid；复审 N-03）。 */
  const toolClaims = (claims: CapabilityClaims, run: LiveRun): CapabilityClaims => ({ ...claims, tid: run.tenantId, mid: run.matterId, rid: run.runId, aid: run.attemptId });

  /**
   * F6：工具调用记账。读类工具执行后记一行（审计）；非读类（产出草稿等副作用）走 outbox：
   * 预留 pending（与活性复核同一事务）→ 执行 → 提交点在同一事务内复核尝试与纪元后写 succeeded（复审 N-01/R-06）。
   * 同一幂等键已成功：直接返回存档结果，不重复执行；pending/unknown：拒绝重放，交人工对账。
   * 执行期间失去租约：副作用可能已发生 → 记 unknown（附结果位置），不交付结果。
   */
  async function invokeWithOutbox(name: string, args: unknown, claims: CapabilityClaims, run: LiveRun, signal: AbortSignal): Promise<unknown> {
    const manifest = manifestFor(name);
    if (!manifest) throw new DomainError("forbidden", `工具 ${name} 不在验签清单内`, 403);
    endpointAuthorize(name, args, run);
    const sideEffect = manifest.sideEffect;
    const rid = run.runId;
    const aid = run.attemptId;
    const paramsHash = argsHash(args);
    const ctxClaims = toolClaims(claims, run);
    if (sideEffect === "read") {
      let result: unknown;
      try {
        result = await invokeTool(name, args, { claims: ctxClaims, db, blobs, lawdb, ...(deps.tokens ? { tokens: deps.tokens } : {}) });
      } catch (e) {
        db.tx(() => {
          if (!tokenLiveness(db, claims, revoked)) recordOp(rid, aid, name, paramsHash, "failed", sideEffect, null, null);
        });
        throw e;
      }
      // 失去租约后不得读新材料（第 04 篇 §8）：交付结果前再复核一次；失效则不交付，并留一行审计（复核 M-02：rejected = 已执行、未交付）
      const why = signal.aborted ? "aborted" : tokenLiveness(db, claims, revoked);
      if (why) {
        recordOp(rid, aid, name, paramsHash, "rejected", sideEffect, null, resultDigest(result));
        throw new DomainError("cancelled", `任务令牌已失效：${why}（读取结果未交付）`, 401);
      }
      return db.tx(() => {
        requireLive(claims);
        recordOp(rid, aid, name, paramsHash, "succeeded", sideEffect, null, resultDigest(result));
        return result;
      });
    }
    // 幂等键与尝试无关：同一任务内同一工具同一参数只产生一次副作用（恢复后的新尝试不重复执行）
    const idem = createHash("sha256").update(canonicalJson({ rid, tool: name, params: paramsHash })).digest("hex");
    const reserved = db.tx((): { replayUri: string | null; opId: string } => {
      requireLive(claims);
      const prior = db.get<{ tool_operation_id: string; status: string; result_uri: string | null }>(
        `SELECT tool_operation_id, status, result_uri FROM tool_operations WHERE run_id = ? AND idempotency_key = ?`,
        [rid, idem],
      );
      if (prior?.status === "succeeded" && prior.result_uri) return { replayUri: prior.result_uri, opId: prior.tool_operation_id };
      if (prior?.status === "pending" || prior?.status === "unknown") {
        throw new DomainError("conflict", "同一副作用调用正在执行或上次结果不明（outbox），不重放；结果不明的调用须经人工对账（runs.reconcile）后才能再次执行", 409);
      }
      if (prior) {
        // 上次确定失败（未产生副作用）：由当前尝试重新执行，行改记到当前尝试名下（执行者即当前尝试）
        db.run(`UPDATE tool_operations SET status = 'pending', attempt_id = ?, completed_at = NULL WHERE tool_operation_id = ? AND status = 'failed'`, [aid, prior.tool_operation_id]);
        return { replayUri: null, opId: prior.tool_operation_id };
      }
      const opId = newId("toolOperation");
      db.run(
        `INSERT INTO tool_operations (tool_operation_id, run_id, attempt_id, tool, operation, params_hash, status, idempotency_key, side_effect)
         VALUES (?,?,?,?,?,?,'pending',?,?)`,
        [opId, rid, aid, name, "mcp_call", paramsHash, idem, sideEffect],
      );
      return { replayUri: null, opId };
    });
    if (reserved.replayUri) {
      const archived = JSON.parse(blobs.read(reserved.replayUri).toString("utf8"));
      requireLive(claims);
      return archived;
    }
    const opId = reserved.opId;
    inflightOperations.add(opId);
    let result: unknown;
    try {
      result = await invokeTool(name, args, { claims: ctxClaims, db, blobs, lawdb, ...(deps.tokens ? { tokens: deps.tokens } : {}) });
    } catch (e) {
      // 审查 R-07：只有“执行前就被拒”的错误（参数校验、不存在、无权、前置条件冲突）确定没有副作用 → failed（可重试）；
      // 其余异常可能发生在副作用之后 → unknown（结果不明，转人工对账，不重放）。写回只覆盖本尝试的 pending 行
      const code = (e as DomainError)?.code;
      const definitelyNoEffect = code === "validation" || code === "not_found" || code === "forbidden" || code === "conflict";
      db.run(`UPDATE tool_operations SET status = ?, completed_at = ? WHERE tool_operation_id = ? AND attempt_id = ? AND status = 'pending'`, [
        definitelyNoEffect ? "failed" : "unknown",
        new Date().toISOString(),
        opId,
        aid,
      ]);
      inflightOperations.delete(opId);
      throw e;
    }
    const stored = blobs.put(Buffer.from(JSON.stringify(result ?? null), "utf8"), run.matterId);
    // 提交点（复审 N-01/R-06）：同一事务内复核尝试与纪元；失去租约则记 unknown（副作用可能已发生，附结果位置供对账），不交付结果
    const lost = db.tx((): string | null => {
      const why = tokenLiveness(db, claims, revoked);
      const now = new Date().toISOString();
      if (why || signal.aborted) {
        db.run(
          `UPDATE tool_operations SET status = 'unknown', result_uri = ?, result_hash = ?, completed_at = ? WHERE tool_operation_id = ? AND attempt_id = ? AND status = 'pending'`,
          [stored.storage_uri, stored.sha256, now, opId, aid],
        );
        return why ?? "aborted";
      }
      const r = db.run(
        `UPDATE tool_operations SET status = 'succeeded', result_uri = ?, result_hash = ?, completed_at = ? WHERE tool_operation_id = ? AND attempt_id = ? AND status = 'pending'`,
        [stored.storage_uri, stored.sha256, now, opId, aid],
      );
      return r.changes === 1 ? null : "outbox_row_changed";
    });
    inflightOperations.delete(opId);
    if (lost) throw new DomainError("cancelled", `任务令牌已失效：${lost}（副作用结果已记为待人工对账）`, 401);
    return result;
  }

  function resultDigest(result: unknown): string | null {
    try {
      return createHash("sha256").update(canonicalJson(result ?? null)).digest("hex");
    } catch {
      return null;
    }
  }

  function recordOp(rid: string, aid: string, tool: string, paramsHash: string, status: string, sideEffect: string, resultUri: string | null, resultHash: string | null): void {
    db.run(
      `INSERT INTO tool_operations (tool_operation_id, run_id, attempt_id, tool, operation, params_hash, status, side_effect, result_uri, result_hash, completed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [newId("toolOperation"), rid, aid, tool, "mcp_call", paramsHash, status, sideEffect, resultUri, resultHash, new Date().toISOString()],
    );
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let claims: CapabilityClaims;
    try {
      claims = auth(req, "tool:legal");
      requireLive(claims);
    } catch (e) {
      return sendJson(res, 401, jsonrpcError(null, -32001, (e as Error).message));
    }
    const msg = await readBody(req);
    // 复审 N-01：读完请求体之后、执行之前再复核一次（预开请求不能跨越取消、尝试被取代与终态）
    let run: LiveRun;
    try {
      run = requireLive(claims);
    } catch (e) {
      return sendJson(res, 401, jsonrpcError(msg?.id ?? null, -32001, (e as Error).message));
    }
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
        // F3：只暴露清单自检通过（有清单、schema hash 一致）的工具
        const allow = deps.mcpToolsAllowlist ? new Set(deps.mcpToolsAllowlist) : null;
        const tools = (allow ? TOOLS.filter((t) => allow.has(t.name)) : TOOLS).filter((t) => !manifestProblems.has(t.name));
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
        if (!findTool(name) || manifestProblems.has(name)) {
          return sendJson(res, 200, { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `not_found: 工具 ${name} 不存在` }], isError: true } });
        }
        const t = track(claims);
        try {
          const raw = await invokeWithOutbox(name, args ?? {}, claims, run, t.signal);
          // 交回 Agent 之前令牌化（工作区与会话只见令牌；闸门出站时另行复扫，幂等）
          const result = deps.tokens
            ? tokenizeToolResult(raw, (s, knownOnly) => deps.tokens!.tokenize(run.matterId, s, knownOnly ? { knownOnly: true } : {}).text, READBACK_MODEL_FIELDS[name] ?? null)
            : raw;
          return sendJson(res, 200, {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: false },
          });
        } catch (e) {
          const err = e as DomainError;
          if (err?.code === "cancelled") return sendJson(res, 401, jsonrpcError(id, -32001, err.message));
          // 复审 N-02：一切“不存在”（越界、真不存在、各工具自带文案）统一口径
          const text = err?.code === "not_found" ? `not_found: ${UNIFORM_NOT_FOUND}` : `${err.code ?? "error"}: ${err.message}`;
          return sendJson(res, 200, { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } });
        } finally {
          t.done();
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
      requireLive(claims);
    } catch (e) {
      return sendJson(res, 401, { error: { message: (e as Error).message } });
    }
    const body = await readBody(req);
    // 复审 N-01：读完请求体之后、调用上游之前再复核；事项按任务记录派生（N-03）
    let run: LiveRun;
    try {
      run = requireLive(claims);
    } catch (e) {
      return sendJson(res, 401, { error: { message: (e as Error).message } });
    }
    const matter = loadMatterForClaims(db, { ...claims, tid: run.tenantId, mid: run.matterId });
    const task = { tid: run.tenantId, uid: claims.uid, mid: run.matterId, rid: run.runId, aid: run.attemptId };
    const t = track(claims, res);
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
          signal: t.signal,
          // 经出站闸门时把宿主请求的任务令牌原样交给闸门再验（活性、事项、用途独立复核）
          bearer: bearerToken(req.headers.authorization),
        });
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "x-kwl-request-id": s.requestId,
        });
        try {
          for await (const chunk of s.chunks) {
            // 令牌失效即停止转发并断开（上游流同时收到中止信号）
            if (t.signal.aborted) break;
            res.write(`data: ${chunk}\n\n`);
          }
        } catch {
          // 上游流被中止或出错：断开连接（客户端得到不完整的流，不会被当作正常结束）
        } finally {
          await s.finalize().catch(() => {});
        }
        if (t.signal.aborted) {
          res.destroy();
          return;
        }
        res.end();
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
        signal: t.signal,
        bearer: bearerToken(req.headers.authorization),
      });
      // 失效之后不交付结果（第 04 篇 §8“失去租约后不得调上游”的对应面：已发生的调用不再交给尝试使用）
      requireLive(claims);
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
      if (res.headersSent) {
        res.destroy();
        return;
      }
      return sendJson(res, status, b);
    } finally {
      t.done();
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
            requireLive(auth(req, "model:chat")); // 复审 N-04：与其他端点同样做活性检查
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
  const servers: LocalServers = { tcp: null, pipe: null, sweepNow };
  const listens: Promise<void>[] = [];
  // 复审 N-01：请求头与请求体都必须在秒级内到达（Node 默认 300 s 会把预开请求的窗口拉到 5 分钟）；
  // 流式响应不受 requestTimeout 约束（只计接收请求的时间）
  const harden = (srv: Server): Server => {
    srv.headersTimeout = 5_000;
    srv.requestTimeout = 10_000;
    srv.keepAliveTimeout = 5_000;
    srv.on("close", () => clearInterval(sweepTimer));
    return srv;
  };
  if (port >= 0) {
    const tcp = harden(createServer(handler));
    servers.tcp = tcp;
    listens.push(new Promise((r) => tcp.listen(port, host, () => r())));
  }
  if (opts.pipePath) {
    const { mkdirSync, rmSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(opts.pipePath), { recursive: true });
    rmSync(opts.pipePath, { force: true });
    const pipe = harden(createServer(handler));
    servers.pipe = pipe;
    listens.push(new Promise((r) => pipe!.listen(opts.pipePath as string, () => r())));
  }
  await Promise.all(listens);
  return servers;
}

export interface LocalServers {
  tcp: Server | null;
  pipe: Server | null;
  /** 立即复核在途请求并中止已失效者（撤销方调用；否则由 200 ms 周期复核兜底）。 */
  sweepNow: () => void;
}

export function localServerPort(server: Server | null): number {
  if (!server) return 0;
  return (server.address() as AddressInfo).port;
}
