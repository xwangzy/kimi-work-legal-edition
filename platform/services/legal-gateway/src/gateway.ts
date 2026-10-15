/**
 * 法律模型网关 v0（v9 第 04 篇 §5.2；第 02 篇 §9.2⑤ 能力网关；§10 凭据表）：
 *
 * - 鉴权：席位令牌（Ed25519，离线验签 ≥ 72 小时；吊销按设备/席位，含控制面订阅的吊销集）；
 * - 二次检查（阶段 6，收敛偏离 D-20）：控制面订阅下发的**事项匿名摘要**（数据级别、端点、四项依据是否齐备）与律所策略（L3a 放开）——
 *   已知事项：请求自报的级别比摘要宽即拒绝；L3b/L4、非标准端点、依据未齐备、律所未放开的 L3a 一律拒绝；
 *   摘要尚未到达的事项：按请求头自报的级别检查（与阶段 6 之前相同），计量记“缺摘要”供事后异常检测——
 *   这样控制面不可达时推理照常（第 02 篇 §10），被篡改终端冒报的情形本来就只能事后检测（第 02 篇 §9.2 ⑤）；
 *   没有匿名事项编号的模型请求拒绝（无事项问答另走专门路由）；
 * - 路由：只认登记的模型别名（主任务 K3、子 Agent K2.6 级），不静默跨供应商；
 * - 额度：按租户的点数预占 → 结算（预写日志：先记预占、再记结算；只记元数据）；额度不足即拒绝；
 * - 并发：按租户排队与限流（上游 Tier5 仅 100 并发 / 300 RPM，避免一个律所的 Swarm 挤占全平台）；
 * - 留存：**正文与错误体不落盘**——计量日志只有请求 ID、租户、席位、匿名事项编号、模型、token、耗时、状态；
 * - 响应：原样透传（流式逐块），同时从 usage 字段取计量；
 * - 内容安全（v9.2 R11）：配置了内容安全策略时，请求文字与模型输出按类别匹配，计量只记“类别:次数”；动作为 block 的类别
 *   拒绝请求或截断输出（以一条错误事件结束流）。
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { KeyObject } from "node:crypto";
import { verifySeatToken, SeatTokenError, type SeatClaims } from "@zr-legal/seat-token";
import type { GatewayFeedView } from "@zr-legal/firm-trust";
import type { ChatProvider } from "./providers.ts";
import { completionTexts, OutputTextTap, requestTexts, safetySummary, type ContentSafety, type SafetyVerdict } from "./content-safety.ts";

export interface MeterRecord {
  at: string;
  kind: "reserve" | "settle" | "reject";
  requestId: string;
  tid: string;
  sid: string;
  anonMatter: string | null;
  model: string | null;
  status: number | null;
  reserved: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  latencyMs: number | null;
  reason: string | null;
  /** 闸门的请求编号（请求头 x-kwl-request-id）：网关与闸门去向记录按它双向对账（阶段 7 复核 S7-B03）。 */
  clientRequestId?: string | null;
  /** 内容安全命中（只有类别编号与次数，如 `in:cat-a:2;out:cat-b:1`；不含命中的文字）。 */
  safety?: string | null;
}

/** HTTP 层访问记录（含 401/404/400 等未进入计量的请求；只有元数据，不含请求体）。 */
export interface AccessRecord {
  at: string;
  method: string;
  path: string;
  status: number;
  clientRequestId: string | null;
}

/** 闸门请求编号的形状（不合格的不采信，记 null）。 */
export function clientRequestIdOf(v: unknown): string | null {
  return typeof v === "string" && /^[A-Za-z0-9_-]{1,96}$/.test(v) ? v : null;
}

/** 只追加的计量日志（预写日志）；实现须只写元数据。 */
export interface MeterSink {
  append(rec: MeterRecord): void;
}

export interface ModelRoute {
  /** 上游模型 ID。 */
  upstreamModel: string;
  /** 每千 token 的点数（结算用；规划假设）。 */
  pointsPer1k: number;
  /** 未给 max_tokens 时的预占输出 token。 */
  defaultMaxTokens: number;
}

export interface GatewayOptions {
  keys: ReadonlyMap<string, KeyObject>;
  revokedDevices?: ReadonlySet<string>;
  revokedSeats?: ReadonlySet<string>;
  /** 控制面订阅（阶段 6）：吊销集、事项匿名摘要、律所策略中网关执行的项。未给出 = 开发形态（只按请求头自报，D-20）。 */
  feed?: GatewayFeedView;
  provider: ChatProvider;
  routes: Readonly<Record<string, ModelRoute>>;
  meter: MeterSink;
  /** HTTP 层访问日志（每个请求一条，含鉴权失败与未知路由；只有元数据）。 */
  accessLog?: (r: AccessRecord) => void;
  /** 租户剩余点数（v0：内存账本；生产为控制面的权威账本）。 */
  budgets: Map<string, number>;
  tenantConcurrency?: number;
  queueTimeoutMs?: number;
  maxBodyBytes?: number;
  /** 内容安全（v9.2 R11）：未给出 = 不检查。 */
  contentSafety?: ContentSafety;
}

export const DEFAULT_ROUTES: Readonly<Record<string, ModelRoute>> = Object.freeze({
  "legal/k3": { upstreamModel: "kimi-k3", pointsPer1k: 4, defaultMaxTokens: 8192 },
  "legal/k2.6": { upstreamModel: "kimi-k2.6", pointsPer1k: 2, defaultMaxTokens: 8192 },
});

class GwError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

class TenantGate {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  private readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  async acquire(timeoutMs: number): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return this.releaser();
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(go);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new GwError(429, "tenant_queue_timeout", "本所并发已满，排队超时（模型通道繁忙，请稍后重试）"));
      }, timeoutMs);
      const go = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.push(go);
    });
    return this.releaser();
  }
  private releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.active -= 1;
    };
  }
}

function estimateTokens(body: Record<string, unknown>, route: ModelRoute): number {
  const input = Math.ceil(JSON.stringify(body.messages ?? []).length / 2);
  const out = typeof body.max_tokens === "number" ? body.max_tokens : typeof body.max_completion_tokens === "number" ? body.max_completion_tokens : route.defaultMaxTokens;
  return input + out;
}

function points(tokens: number, route: ModelRoute): number {
  return Math.ceil((tokens / 1000) * route.pointsPer1k);
}

/** 从 OpenAI 兼容的 JSON 或 SSE 文本中取 usage（顶层或 choices[].usage）。 */
export function extractUsage(text: string): { input: number; output: number; cached: number } | null {
  const pick = (o: any) => {
    const u = o?.usage ?? o?.choices?.find?.((c: any) => c?.usage)?.usage;
    if (!u || typeof u.prompt_tokens !== "number") return null;
    return { input: u.prompt_tokens, output: u.completion_tokens ?? 0, cached: u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens ?? 0 };
  };
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      return pick(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }
  let found: { input: number; output: number; cached: number } | null = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    try {
      found = pick(JSON.parse(line.slice(6))) ?? found;
    } catch {
      // 非 JSON 行
    }
  }
  return found;
}

export function createLegalGateway(o: GatewayOptions): Server {
  const gates = new Map<string, TenantGate>();
  const gateFor = (tid: string) => {
    let g = gates.get(tid);
    if (!g) {
      g = new TenantGate(o.tenantConcurrency ?? 4);
      gates.set(tid, g);
    }
    return g;
  };
  const send = (res: ServerResponse, status: number, body: unknown) => {
    const s = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(s) });
    res.end(s);
  };

  const auth = (req: IncomingMessage): SeatClaims => {
    const h = req.headers.authorization;
    const tok = typeof h === "string" ? /^Bearer\s+(.+)$/i.exec(h)?.[1] : undefined;
    if (!tok) throw new GwError(401, "seat_token_missing", "缺少席位令牌");
    let claims: SeatClaims;
    try {
      claims = verifySeatToken(tok, o.keys, { ...(o.revokedDevices ? { revokedDevices: o.revokedDevices } : {}), ...(o.revokedSeats ? { revokedSeats: o.revokedSeats } : {}) });
    } catch (e) {
      throw new GwError(401, `seat_${e instanceof SeatTokenError ? e.reason : "invalid"}`, "席位令牌无效或已吊销");
    }
    // 控制面订阅的吊销集（离职、丢机：在线即拒绝，第 02 篇 §9.13）
    if (o.feed?.revokedDevice(claims.tid, claims.dev)) throw new GwError(401, "seat_device_revoked", "席位令牌无效或已吊销");
    if (o.feed?.revokedSeat(claims.sid)) throw new GwError(401, "seat_seat_revoked", "席位令牌无效或已吊销");
    return claims;
  };

  const LEVEL_RANK: Readonly<Record<string, number>> = { L0: 0, L1: 1, L2: 2, L3a: 3, L3b: 4, L4: 5 };

  async function handleChat(req: IncomingMessage, res: ServerResponse, seat: SeatClaims, qa = false): Promise<void> {
    const requestId = `kwlgw_${randomUUID()}`;
    const clientRequestId = clientRequestIdOf(req.headers["x-kwl-request-id"]);
    const started = Date.now();
    // 无事项问答（第 04 篇 §5.3）：专门路由，不带事项编号；计量只记席位与“qa”；只接受 L0/L1（问题经闸门令牌化与当事人词典检查）
    const anon = qa ? "qa" : typeof req.headers["x-kwl-anon-matter"] === "string" ? req.headers["x-kwl-anon-matter"] : null;
    const level = String(req.headers["x-kwl-data-level"] ?? "");
    let safetyIn: SafetyVerdict | null = null;
    const safetyField = (out: SafetyVerdict | null = null): string | null => {
      const parts = [safetyIn && safetySummary(safetyIn) ? `in:${safetySummary(safetyIn)}` : null, out && safetySummary(out) ? `out:${safetySummary(out)}` : null].filter(Boolean);
      return parts.length ? parts.join(";") : null;
    };
    const reject = (status: number, code: string, message: string, model: string | null = null): never => {
      o.meter.append({ at: new Date().toISOString(), clientRequestId, kind: "reject", requestId, tid: seat.tid, sid: seat.sid, anonMatter: anon, model, status, reserved: 0, inputTokens: null, outputTokens: null, cachedTokens: null, latencyMs: Date.now() - started, reason: code, safety: safetyField() });
      throw new GwError(status, code, message);
    };
    if (!anon) reject(400, "anon_matter_missing", "缺少匿名事项编号（无事项问答走专门路由）");
    if (!(qa ? ["L0", "L1"] : ["L0", "L1", "L2", "L3a"]).includes(level)) reject(403, "data_level_not_allowed", "该数据级别不允许经标准端点推理");
    // 二次检查（阶段 6）：按控制面订阅的事项匿名摘要与律所策略
    let summaryMissing = false;
    if (o.feed && !qa) {
      let sum = o.feed.matter(seat.tid, anon!);
      if (!sum || LEVEL_RANK[level]! < LEVEL_RANK[sum.level]!) {
        await o.feed.refresh();
        sum = o.feed.matter(seat.tid, anon!);
      }
      if (sum) {
        // 摘要的级别不认识即拒绝（纵深防御，复核 S6-B19）
        if (LEVEL_RANK[sum.level] === undefined) reject(403, "summary_invalid", "事项摘要不合法：已拒绝");
        if (LEVEL_RANK[level]! < LEVEL_RANK[sum.level]!) reject(403, "data_level_mismatch", "请求自报的数据级别低于事项摘要（误配置或旧客户端）：已拒绝");
        const effective = LEVEL_RANK[level]! >= LEVEL_RANK[sum.level]! ? level : sum.level;
        if (effective === "L3b" || effective === "L4") reject(403, "data_level_not_allowed", "该数据级别不允许经标准端点推理");
        if (sum.endpoint !== "standard") reject(403, "endpoint_not_permitted", "该事项未选用标准端点（不经中软网关）");
        if (!sum.basis_complete && effective !== "L0" && effective !== "L1") reject(403, "basis_incomplete", "事项四项依据未齐备：不经网关推理");
        if (effective === "L3a" && !o.feed.l3aStandardAllowed(seat.tid)) reject(403, "l3a_not_permitted", "律所未放开敏感事项（L3a）经标准端点推理");
      } else {
        // 摘要尚未到达（D-34）：按请求头检查；律所策略里的 L3a 放开不依赖摘要，照常判（复核 S6-A07）
        summaryMissing = true;
        if (level === "L3a" && !o.feed.l3aStandardAllowed(seat.tid)) reject(403, "l3a_not_permitted", "律所未放开敏感事项（L3a）经标准端点推理");
      }
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > (o.maxBodyBytes ?? 32 * 1024 * 1024)) reject(413, "body_too_large", "请求体过大");
      chunks.push(c as Buffer);
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    } catch {
      return reject(400, "body_not_json", "请求体不是 JSON");
    }
    const alias = String(body.model ?? "");
    const route = o.routes[alias];
    if (!route) reject(400, "model_not_routed", "模型未登记（不静默跨供应商路由）", alias);
    const cs = o.contentSafety && !o.contentSafety.empty ? o.contentSafety : null;
    if (cs) {
      safetyIn = cs.check(requestTexts(body));
      if (safetyIn.blocked) reject(422, "content_blocked_input", `请求内容命中内容安全策略（${safetyIn.blocked}），已拒绝`, alias);
    }
    const reserved = points(estimateTokens(body, route!), route!);
    // 预占原子化（审查 S4-15）：检查与扣减在同一同步段内完成，再排队；排队失败退回
    const left = o.budgets.get(seat.tid) ?? 0;
    if (left < reserved) reject(402, "quota_exhausted", "本所点数不足（预占失败）", alias);
    o.budgets.set(seat.tid, left - reserved);
    // 客户端断开（闸门撤销、宿主取消）：响应未写完即中止上游（审查 S4-01：req 'close' 在读完请求体后已触发，不能用它判断）
    const ac = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) ac.abort();
    });
    let release: () => void;
    try {
      release = await gateFor(seat.tid).acquire(o.queueTimeoutMs ?? 30_000);
    } catch (e) {
      o.budgets.set(seat.tid, (o.budgets.get(seat.tid) ?? 0) + reserved);
      throw e;
    }
    if (ac.signal.aborted) {
      release();
      o.budgets.set(seat.tid, (o.budgets.get(seat.tid) ?? 0) + reserved);
      o.meter.append({ at: new Date().toISOString(), clientRequestId, kind: "reject", requestId, tid: seat.tid, sid: seat.sid, anonMatter: anon, model: alias, status: null, reserved: 0, inputTokens: null, outputTokens: null, cachedTokens: null, latencyMs: Date.now() - started, reason: "client_gone_before_upstream" });
      return;
    }
    o.meter.append({ at: new Date().toISOString(), clientRequestId, kind: "reserve", requestId, tid: seat.tid, sid: seat.sid, anonMatter: anon, model: alias, status: null, reserved, inputTokens: null, outputTokens: null, cachedTokens: null, latencyMs: null, reason: summaryMissing ? "summary_missing_header_checked" : null });
    let status: number | null = null;
    let usage: { input: number; output: number; cached: number } | null = null;
    let interrupted = false;
    let safetyOut: SafetyVerdict | null = null;
    let blockedOut: string | null = null;
    try {
      const upstreamBody = { ...body, model: route!.upstreamModel, ...(body.stream === true ? { stream_options: { ...(body.stream_options as object | undefined), include_usage: true } } : {}) };
      const up = await o.provider.chat(upstreamBody, { requestId, signal: ac.signal });
      status = up.status;
      const streaming = body.stream === true;
      // 内容安全：非流式响应先在内存里检查再发出；流式逐块检查，命中拦截类别即以错误事件结束
      const holdForCheck = !!cs && !streaming && up.status === 200;
      if (!holdForCheck) res.writeHead(up.status, { ...up.headers, "x-kwl-gateway-request-id": requestId });
      // 透传并在内存中取 usage（不落盘）；流式只保留最后 64 KiB 用于取 usage；写回与客户端断开竞争（不会永久等待 drain）
      let tail = "";
      const dec = new TextDecoder();
      const tap = cs && streaming ? new OutputTextTap() : null;
      // 按通道（正文、推理文字、各工具调用参数）分别累积全文与跨块窗口（复核 B4-R05）
      const outTexts = new Map<string, string>();
      const windows = new Map<string, string>();
      const blockedEvent = (cat: string, why = "模型输出命中内容安全策略") =>
        new TextEncoder().encode(`data: ${JSON.stringify({ error: { type: "kwl_gateway", code: "content_blocked_output", message: `${why}（${cat}），已中止` } })}\n\n`);
      const held: Uint8Array[] = [];
      let heldBytes = 0;
      for await (const c of up.body) {
        const piece = dec.decode(c, { stream: true });
        tail = (tail + piece).slice(-65_536);
        if (holdForCheck) {
          heldBytes += c.byteLength;
          if (heldBytes > 16 * 1024 * 1024) throw new GwError(502, "upstream_response_too_large", "上游响应过大");
          held.push(c);
          continue;
        }
        if (tap) {
          let hit: string | null = null;
          for (const { channel, text } of tap.feedChannels(piece)) {
            const all = outTexts.get(channel) ?? "";
            if (all.length < 2_000_000) outTexts.set(channel, all + text);
            // 只看“本通道上一段末尾 + 新文字”，跨块的词也能命中；拦截判定不重复计数（计数在结束时对全文一次完成）
            const w = windows.get(channel) ?? "";
            const v = cs!.check([w + text]);
            windows.set(channel, (w + text).slice(-256));
            if (v.blocked) {
              hit = v.blocked;
              break;
            }
          }
          if (hit) {
            safetyOut = cs!.check([...outTexts.values()]);
            blockedOut = hit;
            await writeChunk(res, blockedEvent(hit), ac.signal);
            break;
          }
          // 一行超长：无法检查即不放行（失败关闭）
          if (tap.overflow) {
            safetyOut = cs!.check([...outTexts.values()]);
            blockedOut = "uncheckable";
            await writeChunk(res, blockedEvent("uncheckable", "模型输出无法完成内容安全检查"), ac.signal);
            break;
          }
        }
        if (!(await writeChunk(res, c, ac.signal))) {
          interrupted = true;
          ac.abort();
          break;
        }
      }
      if (holdForCheck) {
        const whole = Buffer.concat(held).toString("utf8");
        safetyOut = cs!.check(completionTexts(whole));
        if (safetyOut.blocked) {
          blockedOut = safetyOut.blocked;
          const s = JSON.stringify({ error: { type: "kwl_gateway", code: "content_blocked_output", message: `模型输出命中内容安全策略（${safetyOut.blocked}），已拒绝` } });
          res.writeHead(422, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(s), "x-kwl-gateway-request-id": requestId });
          res.write(s);
        } else {
          res.writeHead(up.status, { ...up.headers, "x-kwl-gateway-request-id": requestId });
          for (const c of held) res.write(c);
        }
      } else if (tap && !blockedOut) safetyOut = cs!.check([...outTexts.values()]);
      // 上游因中止而提前结束（没有走 break）同样算客户端断开
      if (ac.signal.aborted) interrupted = true;
      if (interrupted) res.destroy();
      else res.end();
      if (up.status === 200) usage = extractUsage(tail);
    } finally {
      release();
      const actual = usage ? points(usage.input + usage.output, route!) : status === 200 ? reserved : 0;
      o.budgets.set(seat.tid, (o.budgets.get(seat.tid) ?? 0) + reserved - actual);
      o.meter.append({
        at: new Date().toISOString(),
        kind: "settle",
        requestId,
        clientRequestId,
        tid: seat.tid,
        sid: seat.sid,
        anonMatter: anon,
        model: alias,
        status,
        reserved,
        inputTokens: usage?.input ?? null,
        outputTokens: usage?.output ?? null,
        cachedTokens: usage?.cached ?? null,
        latencyMs: Date.now() - started,
        reason: blockedOut
          ? `content_blocked_output:${blockedOut}`
          : usage
            ? interrupted
              ? "client_gone_partial_usage"
              : null
            : status === 200
              ? interrupted
                ? "client_gone_charged_reserved"
                : "usage_missing_charged_reserved"
              : "upstream_error_released",
        safety: safetyField(safetyOut),
      });
    }
  }

  /** 写一块到客户端；缓冲满时等 drain，但与客户端断开、中止竞争。返回 false = 不可再写。 */
  function writeChunk(res: ServerResponse, chunk: Uint8Array, signal: AbortSignal): Promise<boolean> | boolean {
    if (res.destroyed || signal.aborted) return false;
    if (res.write(chunk)) return true;
    return new Promise<boolean>((resolve) => {
      const finish = (ok: boolean) => {
        res.off("drain", onDrain);
        res.off("close", onClose);
        signal.removeEventListener("abort", onAbort);
        resolve(ok);
      };
      const onDrain = () => finish(true);
      const onClose = () => finish(false);
      const onAbort = () => finish(false);
      res.once("drain", onDrain);
      res.once("close", onClose);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  return createServer((req, res) => {
    // HTTP 层访问日志（阶段 7 复核 S7-B03/B04）：每个请求一条，含鉴权失败与未知路由——红队判定以它为准，不只看计量
    if (o.accessLog) {
      const at = new Date().toISOString();
      const path = new URL(req.url ?? "/", "http://gateway").pathname.slice(0, 200);
      const clientRequestId = clientRequestIdOf(req.headers["x-kwl-request-id"]);
      res.once("close", () => o.accessLog!({ at, method: String(req.method ?? ""), path, status: res.statusCode, clientRequestId }));
    }
    void (async () => {
      const url = new URL(req.url ?? "/", "http://gateway");
      const seat = auth(req);
      if (req.method === "GET" && url.pathname === "/v1/models") {
        send(res, 200, { object: "list", data: Object.keys(o.routes).map((id) => ({ id, object: "model", owned_by: "zr-legal-gateway" })) });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") return handleChat(req, res, seat);
      if (req.method === "POST" && url.pathname === "/v1/qa/chat/completions") return handleChat(req, res, seat, true);
      throw new GwError(404, "not_found", "没有这条路由");
    })().catch((e: unknown) => {
      const ge = e instanceof GwError ? e : new GwError(502, "gateway_error", "网关错误");
      if (res.headersSent) res.destroy();
      else send(res, ge.status, { error: { type: "kwl_gateway", code: ge.code, message: ge.message } });
    });
  });
}
