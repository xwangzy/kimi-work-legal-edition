/**
 * 法律模型网关（v9 第 04 篇 §5.2；第 02 篇 §9.2⑤ 能力网关；§10 凭据表；V19 第 44 批动态路由与逐请求计量）：
 *
 * - 鉴权：席位令牌（Ed25519，离线验签 ≥ 72 小时；吊销按设备/席位，含控制面订阅的吊销集）；账号闸：订阅的“暂停设备”（退出登录、
 *   会话过期、账号停用）→ 401 `seat_session_inactive`；
 * - 二次检查（阶段 6，收敛偏离 D-20）：控制面订阅下发的**事项匿名摘要**（数据级别、端点、四项依据是否齐备）与律所策略（L3a 放开）——
 *   已知事项：请求自报的级别比摘要宽即拒绝；L3b/L4、非标准端点、依据未齐备、律所未放开的 L3a 一律拒绝；
 *   摘要尚未到达的事项：按请求头自报的级别检查（与阶段 6 之前相同），计量记“缺摘要”供事后异常检测；
 *   没有匿名事项编号的模型请求拒绝（无事项问答另走专门路由）；
 * - 路由（第 44 批）：别名 → 路由表里按优先级排列的目标（上游 + 型号）；只在还没给客户端写出任何字节之前切换（连接失败、5xx、429、头超时 →
 *   下一个目标，至多 3 次）；跨供应商只在别名允许时；其他 4xx 不切换；被动熔断与每上游并发上限见 upstreams.ts；
 * - 额度：按席位的租约（quota.ts）：预估按租户单位（tokens / cny）预占 → 按实际 usage 结算；额度不足即拒绝；
 * - 并发：按租户排队与限流（避免一个律所的 Swarm 挤占全平台）；
 * - 计量：逐请求一条 UsageRecord（编号、token、单位数、尝试、结果），先写预写日志再回报控制面；客户端断开不立即中止上游，
 *   继续读（不再转发）至多 60 秒 / 8 MiB 以拿到 usage；
 * - 留存：**正文与错误体不落盘**；上游非 2xx 的响应体规范化后再回客户端（不透传上游原文：可能带令牌片段）；
 * - 内容安全（v9.2 R11）：配置了内容安全策略时，请求文字与模型输出按类别匹配，计量只记“类别:次数”；动作为 block 的类别
 *   拒绝请求或截断输出（以一条错误事件结束流）。
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { KeyObject } from "node:crypto";
import { verifySeatToken, SeatTokenError, type SeatClaims } from "@zr-legal/seat-token";
import type { GatewayFeedView } from "@zr-legal/firm-trust";
import type { ChatProvider, UpstreamResponse } from "./providers.ts";
import { completionTexts, OutputTextTap, requestTexts, safetySummary, type ContentSafety, type SafetyVerdict } from "./content-safety.ts";
import { LeaseQuota, MapQuota, type MeterPos, type QuotaHold, type QuotaSource } from "./quota.ts";
import { DEFAULT_ROUTES, LOCAL_PROVIDER, staticRouting, type ModelRoute, type ProviderEntry, type RoutingSnapshot, type RoutingView } from "./routing.ts";
import { UpstreamHealth, type UpstreamTicket } from "./upstreams.ts";
import { estimateInputTokens, estimateOutputTokens, extractFinishReason, extractUsage, unitsOf, upstreamRequestIdOf, type QuotaUnit, type UsageAttempt, type UsageOutcome, type UsageRecord, type UsageSource, type UsageTokens } from "./usage.ts";

export * from "./usage.ts";

export interface MeterRecord {
  at: string;
  kind: "reserve" | "settle" | "reject";
  requestId: string;
  tid: string;
  sid: string;
  anonMatter: string | null;
  model: string | null;
  /** 回给客户端的状态（settle：成功即上游状态；失败为网关规范化后的状态）。 */
  status: number | null;
  /** 预占的单位数（租户单位：tokens 或 cny 微元）。 */
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
  /** 上游的结束原因（stop / tool_calls / length …；复核 B13-C01：length 即输出被上限截断，验收报告据此给截断次数）。 */
  finishReason?: string | null;
  /** 实际转发的上游型号（第 28 批：别名 legal/k3 背后是哪个 MaaS 型号，验收与对账据此核对）。 */
  upstreamModel?: string | null;
  /** 第 44 批：实际服务的上游编号、额度单位、价目版本、租约持有者（重放时按它回报）。 */
  provider?: string | null;
  unit?: QuotaUnit | null;
  priceVersion?: string | number | null;
  holder?: string | null;
  /** 第 44 批：settle 行带整条逐请求记录（发件箱：启动时据此重放未确认送达的部分）。 */
  record?: UsageRecord | null;
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

/** 只追加的计量日志（预写日志）；实现须只写元数据。文件实现返回该行的字节范围（发件箱检查点用）。 */
export interface MeterSink {
  append(rec: MeterRecord): void | MeterPos;
}

/** 网关订阅视图；`suspendedDevice` 为第 44 批账号闸（没有实现 = 不检查）。 */
export type GatewayFeed = GatewayFeedView & { suspendedDevice?(tid: string, deviceId: string): boolean };

export interface GatewayOptions {
  keys: ReadonlyMap<string, KeyObject>;
  revokedDevices?: ReadonlySet<string>;
  revokedSeats?: ReadonlySet<string>;
  /** 控制面订阅（阶段 6）：吊销集、暂停设备、事项匿名摘要、律所策略中网关执行的项。未给出 = 开发形态（只按请求头自报，D-20）。 */
  feed?: GatewayFeed;
  /** 动态路由（第 44 批：订阅或静态表）；给出即不用 provider / routes。 */
  routing?: RoutingView;
  /** 静态单上游（开发、试用版本机网关、既有用例）：路由表里的 `local` 上游。 */
  provider?: ChatProvider;
  /** 静态路由（与 provider 一起用；缺省 DEFAULT_ROUTES）。 */
  routes?: Readonly<Record<string, ModelRoute>>;
  /** 上游健康（熔断、并发、探测）；缺省新建：配了 routing 即启用熔断，静态单上游不启用。 */
  health?: UpstreamHealth;
  meter: MeterSink;
  /** HTTP 层访问日志（每个请求一条，含鉴权失败与未知路由；只有元数据）。 */
  accessLog?: (r: AccessRecord) => void;
  /** 租户剩余额度（tokens；内存账本）。与 quota 二选一。 */
  budgets?: Map<string, number>;
  /** 额度来源（控制面额度账本租约 LeaseQuota）；给出即不用 budgets。 */
  quota?: QuotaSource;
  tenantConcurrency?: number;
  queueTimeoutMs?: number;
  /**
   * 上游超时（V10 第 36 批真实走查 V17）：收到响应头前（流式缺省 120 秒、非流式 600 秒）与流式两块之间（缺省 120 秒）没有动静即中止上游。
   * 头超时可切换到下一个目标；都不行即 504。路由表里上游自带的 header_timeout_ms / idle_timeout_ms 优先。
   */
  upstreamHeaderTimeoutMs?: number;
  upstreamIdleTimeoutMs?: number;
  maxBodyBytes?: number;
  /** 内容安全（v9.2 R11）：未给出 = 不检查。 */
  contentSafety?: ContentSafety;
  /** 客户端断开后继续读上游以拿 usage 的时限与字节上限（缺省 60 秒、8 MiB）。 */
  drainMs?: number;
  drainMaxBytes?: number;
  /** 切换次数上限（缺省 3，即至多 4 次尝试）。 */
  maxSwitches?: number;
  /** 计量 settle 行里的租约持有者（缺省取 LeaseQuota 的 holder）。 */
  holder?: string;
}

class GwError extends Error {
  readonly status: number;
  readonly code: string;
  readonly headers: Record<string, string>;
  constructor(status: number, code: string, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
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

/** 网关的服务内部指标（v9.3 A-9 余项）：只有计数——上游按状态类别（429 单列，每次尝试计一次）、网关自己拒绝的原因代码。 */
export interface GatewayMetrics {
  upstream: Record<"2xx" | "429" | "4xx" | "5xx" | "error", number>;
  rejects: Record<string, number>;
}

/** Retry-After：只回整数秒（0～3600）；HTTP 日期折成秒；其他形状不回。 */
function retryAfterOf(v: string | undefined): number | null {
  if (!v) return null;
  const s = v.trim();
  if (/^\d{1,7}$/.test(s)) return Math.min(3600, Number(s));
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.max(0, Math.min(3600, Math.ceil((t - Date.now()) / 1000))) : null;
}

/** 转发给客户端的上游响应头（其余一律不转发）。 */
function forwardHeaders(h: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  if (h["content-type"]) out["content-type"] = h["content-type"];
  if (h["x-request-id"] && /^[A-Za-z0-9_.:-]{1,128}$/.test(h["x-request-id"])) out["x-request-id"] = h["x-request-id"];
  return out;
}

/** 丢弃上游响应体（不读入、不转发）。 */
function discard(up: UpstreamResponse): void {
  void (async () => {
    try {
      await (up.body as AsyncIterable<Uint8Array> & { [Symbol.asyncIterator](): AsyncIterator<Uint8Array> })[Symbol.asyncIterator]().return?.();
    } catch {
      // 忽略
    }
  })();
}

export function createLegalGateway(o: GatewayOptions): Server & { metrics(): GatewayMetrics } {
  const quota: QuotaSource = o.quota ?? new MapQuota(o.budgets ?? new Map());
  if (!o.routing && !o.provider) throw new Error("网关缺少上游：给出 routing（路由订阅）或 provider（静态单上游）");
  const routing: RoutingView = o.routing ?? staticRouting({ providers: { [LOCAL_PROVIDER]: o.provider! }, routes: o.routes ?? DEFAULT_ROUTES });
  const health = o.health ?? new UpstreamHealth({ breaker: !!o.routing });
  const holder = o.holder ?? (quota instanceof LeaseQuota ? quota.holder : null);
  const drainMs = o.drainMs ?? 60_000;
  const drainMaxBytes = o.drainMaxBytes ?? 8 * 1024 * 1024;
  const maxAttempts = 1 + (o.maxSwitches ?? 3);
  const queueTimeoutMs = o.queueTimeoutMs ?? 30_000;
  const upstreamCounts: GatewayMetrics["upstream"] = { "2xx": 0, "429": 0, "4xx": 0, "5xx": 0, error: 0 };
  const rejectCounts: Record<string, number> = {};
  const countReject = (code: string) => {
    // 原因代码是本模块里的固定标识；超出预期形状的归为 other（指标标签不能承载任意值）
    const k = /^[a-z0-9_]{1,48}$/.test(code) ? code : "other";
    rejectCounts[k] = (rejectCounts[k] ?? 0) + 1;
  };
  const countUpstream = (status: number | null) => {
    if (status === null) upstreamCounts.error += 1;
    else if (status === 429) upstreamCounts["429"] += 1;
    else if (status >= 200 && status < 300) upstreamCounts["2xx"] += 1;
    else if (status >= 400 && status < 500) upstreamCounts["4xx"] += 1;
    else upstreamCounts["5xx"] += 1;
  };
  const gates = new Map<string, TenantGate>();
  const gateFor = (tid: string) => {
    let g = gates.get(tid);
    if (!g) {
      g = new TenantGate(o.tenantConcurrency ?? 4);
      gates.set(tid, g);
    }
    return g;
  };
  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    const s = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(s), ...headers });
    res.end(s);
  };

  const auth = (req: IncomingMessage): SeatClaims => {
    const h = req.headers.authorization;
    const tok = typeof h === "string" ? /^Bearer\s+(.+)$/i.exec(h)?.[1] : undefined;
    if (!tok) throw new GwError(401, "seat_token_missing", "缺少席位令牌");
    let claims: SeatClaims;
    try {
      claims = verifySeatToken(tok, o.keys, { audience: "gateway", ...(o.revokedDevices ? { revokedDevices: o.revokedDevices } : {}), ...(o.revokedSeats ? { revokedSeats: o.revokedSeats } : {}) });
    } catch (e) {
      throw new GwError(401, `seat_${e instanceof SeatTokenError ? e.reason : "invalid"}`, "席位令牌无效或已吊销");
    }
    // 控制面订阅的吊销集（离职、丢机：在线即拒绝，第 02 篇 §9.13）
    if (o.feed?.revokedDevice(claims.tid, claims.dev)) throw new GwError(401, "seat_device_revoked", "席位令牌无效或已吊销");
    if (o.feed?.revokedSeat(claims.sid)) throw new GwError(401, "seat_seat_revoked", "席位令牌无效或已吊销");
    // 账号闸（第 44 批）：本设备没有有效会话（退出登录、会话过期、账号停用）
    if (o.feed?.suspendedDevice?.(claims.tid, claims.dev)) throw new GwError(401, "seat_session_inactive", "登录已失效，请重新登录");
    return claims;
  };

  const LEVEL_RANK: Readonly<Record<string, number>> = { L0: 0, L1: 1, L2: 2, L3a: 3, L3b: 4, L4: 5 };

  /** 别名的候选目标（按优先级）：路由表里不存在的上游跳过；跨供应商只在别名允许时（基准 = 第一个存在的目标的供应商）。 */
  const candidatesOf = (route: ModelRoute, snap: RoutingSnapshot): { entry: ProviderEntry; model: string }[] => {
    const out: { entry: ProviderEntry; model: string }[] = [];
    let vendor: string | null = null;
    for (const t of route.targets) {
      const entry = snap.providers.get(t.provider);
      if (!entry) continue;
      if (vendor === null) vendor = entry.vendor;
      else if (entry.vendor !== vendor && !route.allowCrossVendor) continue;
      out.push({ entry, model: t.model });
    }
    return out;
  };

  async function handleChat(req: IncomingMessage, res: ServerResponse, seat: SeatClaims, qa = false): Promise<void> {
    const requestId = `kwlgw_${randomUUID()}`;
    const clientRequestId = clientRequestIdOf(req.headers["x-kwl-request-id"]);
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    // 无事项问答（第 04 篇 §5.3）：专门路由，不带事项编号；计量只记席位与“qa”；只接受 L0/L1（问题经闸门令牌化与当事人词典检查）
    const anon = qa ? "qa" : typeof req.headers["x-kwl-anon-matter"] === "string" ? req.headers["x-kwl-anon-matter"] : null;
    const level = String(req.headers["x-kwl-data-level"] ?? "");
    let safetyIn: SafetyVerdict | null = null;
    const safetyField = (out: SafetyVerdict | null = null): string | null => {
      const parts = [safetyIn && safetySummary(safetyIn) ? `in:${safetySummary(safetyIn)}` : null, out && safetySummary(out) ? `out:${safetySummary(out)}` : null].filter(Boolean);
      return parts.length ? parts.join(";") : null;
    };
    const base = { clientRequestId, requestId, tid: seat.tid, sid: seat.sid, anonMatter: anon };
    const reject = (status: number, code: string, message: string, model: string | null = null): never => {
      countReject(code);
      o.meter.append({ at: new Date().toISOString(), ...base, kind: "reject", model, status, reserved: 0, inputTokens: null, outputTokens: null, cachedTokens: null, latencyMs: Date.now() - started, reason: code, safety: safetyField() });
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
    const reqChunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > (o.maxBodyBytes ?? 32 * 1024 * 1024)) reject(413, "body_too_large", "请求体过大");
      reqChunks.push(c as Buffer);
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(Buffer.concat(reqChunks).toString("utf8")) as Record<string, unknown>;
    } catch {
      return reject(400, "body_not_json", "请求体不是 JSON");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return reject(400, "body_not_json", "请求体不是 JSON 对象");
    // 路由表取一次快照：本请求从头到尾用同一版（换表是原子的）
    const snap = routing.current();
    const alias = String(body.model ?? "");
    const route = snap.models.get(alias);
    // 网关从未取到路由、本机也没有兜底：不是“模型未登记”，是路由尚未就绪
    if (!route && snap.source === "none") return reject(503, "routing_unavailable", "模型路由尚未就绪，请稍后再试", alias);
    if (!route) return reject(400, "model_not_routed", "模型未登记（不静默跨供应商路由）", alias);
    if (!route.enabled) return reject(400, "model_disabled", "该模型已停用：请联系平台运营", alias);
    const cs = o.contentSafety && !o.contentSafety.empty ? o.contentSafety : null;
    if (cs) {
      safetyIn = cs.check(requestTexts(body));
      if (safetyIn.blocked) reject(422, "content_blocked_input", `请求内容命中内容安全策略（${safetyIn.blocked}），已拒绝`, alias);
    }
    const stream = body.stream === true;
    const est = { input: estimateInputTokens(body), output: estimateOutputTokens(body, route.defaultMaxTokens) };
    const priceItem = snap.prices?.items[alias] ?? null;
    const priceVersion = snap.prices?.version ?? null;
    // 客户端断开（闸门撤销、宿主取消）：响应未写完即算断开（审查 S4-01：req 'close' 在读完请求体后已触发，不能用它判断）。
    // 监听在预占之前注册（复核 S9A-07：预占可能要等账本，等待期间断开也要察觉，不再发往上游、不按预占计费）
    let clientGone = false;
    let onGone: (() => void) | null = null;
    const goneAc = new AbortController();
    res.on("close", () => {
      if (res.writableFinished) return;
      clientGone = true;
      goneAc.abort();
      onGone?.();
    });
    const rr = await quota.reserve({ tid: seat.tid, sid: seat.sid, alias, estimate: est }, (unit) => unitsOf(unit, { input: est.input, cached: 0, output: est.output }, priceItem));
    if (!rr.ok) return reject(rr.status, rr.code, rr.message, alias);
    const hold: QuotaHold = rr.hold;
    let releaseTenant: () => void;
    try {
      releaseTenant = await gateFor(seat.tid).acquire(queueTimeoutMs);
    } catch (e) {
      quota.refund(hold);
      if (e instanceof GwError) countReject(e.code);
      throw e;
    }
    if (clientGone) {
      releaseTenant();
      quota.refund(hold);
      o.meter.append({ at: new Date().toISOString(), ...base, kind: "reject", model: alias, status: null, reserved: 0, inputTokens: null, outputTokens: null, cachedTokens: null, latencyMs: Date.now() - started, reason: "client_gone_before_upstream" });
      return;
    }
    // 预写计量失败（磁盘满、目录不可写）：退还预占并释放并发槽后失败关闭（第 6 批联调发现）
    try {
      o.meter.append({ at: new Date().toISOString(), ...base, kind: "reserve", model: alias, status: null, reserved: hold.units, inputTokens: null, outputTokens: null, cachedTokens: null, latencyMs: null, reason: summaryMissing ? "summary_missing_header_checked" : null, unit: hold.unit });
    } catch {
      releaseTenant();
      quota.refund(hold);
      throw new GwError(503, "meter_unavailable", "计量记录写入失败：本次请求未发往上游");
    }

    const attempts: UsageAttempt[] = [];
    let chosen: { entry: ProviderEntry; model: string } | null = null;
    let ticket: UpstreamTicket | null = null;
    let attemptMs = 0;
    let up: UpstreamResponse | null = null;
    let upAc: AbortController | null = null;
    let upTimer: ReturnType<typeof setTimeout> | undefined;
    let finalStatus: number | null = null;
    let failure: { status: number; code: string; message: string; headers: Record<string, string>; timeout: boolean } | null = null;
    let timedOut = null as "header" | "idle" | null;
    let draining = false;
    let drainCut = false;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let streamError = false;
    let usage: ReturnType<typeof extractUsage> = null;
    let finishReason: string | null = null;
    let upstreamReqId: string | null = null;
    let outChars = 0;
    let safetyOut: SafetyVerdict | null = null;
    let blockedOut: string | null = null;
    let lastTried: { entry: ProviderEntry; model: string } | null = null;
    // 客户端断开或输出被拦截后：不再转发，继续读上游至多 drainMs / drainMaxBytes 以拿到 usage
    const startDrain = () => {
      if (draining) return;
      draining = true;
      drainTimer = setTimeout(() => {
        drainCut = true;
        upAc?.abort();
      }, drainMs);
    };
    onGone = startDrain;
    try {
      // ─── 选上游与切换（只在还没给客户端写出任何字节之前） ───
      const cands = candidatesOf(route, snap);
      const tried = new Set<number>();
      const retryAfters: number[] = [];
      let all429 = true;
      let busy = false;
      while (attempts.length < maxAttempts && !clientGone) {
        // 可用的候选：上游可用、熔断放行；优先有空余并发名额的
        const usable = cands.map((c, i) => ({ ...c, i })).filter((c) => !tried.has(c.i) && c.entry.state === "ok" && c.entry.client && health.admits(c.entry));
        if (!usable.length) break;
        const pick = usable.find((c) => health.hasCapacity(c.entry)) ?? usable[0]!;
        tried.add(pick.i);
        const tk = await health.acquire(pick.entry, queueTimeoutMs, goneAc.signal);
        if (!tk) {
          busy = true;
          continue;
        }
        if (clientGone) {
          tk.cancel();
          break;
        }
        lastTried = pick;
        const t0 = Date.now();
        const ac = new AbortController();
        upAc = ac;
        let headerTimedOut = false;
        const headerMs = pick.entry.headerTimeoutMs ?? o.upstreamHeaderTimeoutMs ?? (stream ? 120_000 : 600_000);
        upTimer = setTimeout(() => {
          headerTimedOut = true;
          ac.abort();
        }, headerMs);
        const upstreamBody = { ...body, model: pick.model, ...(stream ? { stream_options: { ...(body.stream_options as object | undefined), include_usage: true } } : {}) };
        let r: UpstreamResponse;
        try {
          r = await pick.entry.client!.chat(upstreamBody, { requestId, signal: ac.signal });
        } catch {
          clearTimeout(upTimer);
          const ms = Date.now() - t0;
          countUpstream(null);
          all429 = false;
          if (headerTimedOut) {
            attempts.push({ provider: pick.entry.id, status: null, error: "header_timeout", ms });
            tk.failure("header_timeout");
            failure = { status: 504, code: "upstream_timeout", message: `模型服务 ${Math.round(headerMs / 1000)} 秒内没有响应，已中止本次请求（可重试）`, headers: {}, timeout: true };
          } else if (drainCut) {
            attempts.push({ provider: pick.entry.id, status: null, error: "client_gone", ms });
            tk.cancel();
            break;
          } else {
            attempts.push({ provider: pick.entry.id, status: null, error: "connect", ms });
            tk.failure("connect");
            failure = { status: 502, code: "upstream_unreachable", message: "模型服务连接失败（可重试）", headers: {}, timeout: false };
          }
          continue;
        }
        const ms = Date.now() - t0;
        countUpstream(r.status);
        if (r.status >= 200 && r.status < 300) {
          attempts.push({ provider: pick.entry.id, status: r.status, error: null, ms });
          up = r;
          chosen = pick;
          ticket = tk;
          attemptMs = ms;
          break;
        }
        // 非 2xx：不透传上游原文（可能带令牌片段），规范化后再回
        clearTimeout(upTimer);
        discard(r);
        ac.abort();
        const code = `upstream_${r.status}`;
        attempts.push({ provider: pick.entry.id, status: r.status, error: code, ms });
        failure = { status: r.status, code, message: `模型服务返回 ${r.status}`, headers: {}, timeout: false };
        if (r.status === 429) {
          const ra = retryAfterOf(r.headers["retry-after"]);
          if (ra !== null) retryAfters.push(ra);
        } else all429 = false;
        if (r.status === 429 || r.status >= 500) tk.failure(code);
        else {
          // 其他 4xx（请求本身的问题、上游密钥被拒）：不切换
          tk.neutral(code);
          break;
        }
      }
      if (!up) {
        if (!failure) failure = busy ? { status: 429, code: "upstream_busy", message: "模型通道繁忙，请稍后重试", headers: {}, timeout: false } : { status: 503, code: "upstream_unavailable", message: "模型服务暂不可用（没有可用的上游），请稍后再试", headers: {}, timeout: false };
        // 全部 429：把上游的 Retry-After（取最短的）回给客户端
        if (all429 && failure.status === 429 && retryAfters.length) failure.headers["retry-after"] = String(Math.min(...retryAfters));
        if (failure.timeout) timedOut = "header";
        finalStatus = failure.status;
        if (!clientGone && !res.headersSent) send(res, failure.status, { error: { type: "kwl_gateway", code: failure.code, message: failure.message } }, { ...failure.headers, "x-kwl-gateway-request-id": requestId });
        return;
      }

      // ─── 成功：透传（流式逐块），同时在内存中取 usage（不落盘） ───
      const upr = up;
      const entry = chosen!.entry;
      const ac = upAc!;
      finalStatus = upr.status;
      const idleMs = entry.idleTimeoutMs ?? o.upstreamIdleTimeoutMs ?? 120_000;
      const bumpIdle = () => {
        clearTimeout(upTimer);
        upTimer = setTimeout(() => {
          timedOut = "idle";
          ac.abort();
        }, idleMs);
      };
      if (stream) bumpIdle();
      else clearTimeout(upTimer);
      const fwd = { ...forwardHeaders(upr.headers), "x-kwl-gateway-request-id": requestId };
      // 内容安全：非流式响应先在内存里检查再发出；流式逐块检查，命中拦截类别即以错误事件结束
      const holdForCheck = !!cs && !stream;
      if (!holdForCheck && !clientGone) res.writeHead(upr.status, fwd);
      if (clientGone) startDrain();
      let tail = "";
      let head = "";
      let drained = 0;
      const dec = new TextDecoder();
      const tap = cs && stream ? new OutputTextTap() : null;
      // 已转发的输出文字（正文、推理、工具参数）计数：拿不到 usage 时据此估算
      const countTap = stream ? new OutputTextTap() : null;
      // 按通道（正文、推理文字、各工具调用参数）分别累积全文与跨块窗口（复核 B4-R05）
      const outTexts = new Map<string, string>();
      const windows = new Map<string, string>();
      const blockedEvent = (cat: string, why = "模型输出命中内容安全策略") =>
        new TextEncoder().encode(`data: ${JSON.stringify({ error: { type: "kwl_gateway", code: "content_blocked_output", message: `${why}（${cat}），已中止` } })}\n\n`);
      const held: Uint8Array[] = [];
      let heldBytes = 0;
      const chunks = async function* (): AsyncGenerator<Uint8Array> {
        try {
          for await (const c of upr.body) {
            if (stream) bumpIdle();
            yield c;
          }
        } catch (e) {
          // 块间隔超时、读够了（客户端已断开）：上游流被中止，按原因记
          if (timedOut === "idle" || drainCut) return;
          throw e;
        }
      };
      try {
        for await (const c of chunks()) {
          const piece = dec.decode(c, { stream: true });
          tail = (tail + piece).slice(-65_536);
          if (head.length < 4096) head += piece.slice(0, 4096 - head.length);
          if (clientGone || blockedOut) {
            startDrain();
            drained += c.byteLength;
            if (drained > drainMaxBytes) {
              drainCut = true;
              ac.abort();
              break;
            }
            continue;
          }
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
            // 一行超长：无法检查即不放行（失败关闭）
            if (!hit && tap.overflow) hit = "uncheckable";
            if (hit) {
              safetyOut = cs!.check([...outTexts.values()]);
              blockedOut = hit;
              await writeChunk(res, hit === "uncheckable" ? blockedEvent(hit, "模型输出无法完成内容安全检查") : blockedEvent(hit), goneAc.signal);
              if (!res.destroyed) res.end();
              startDrain();
              continue;
            }
          }
          if (!(await writeChunk(res, c, goneAc.signal))) {
            clientGone = true;
            startDrain();
            continue;
          }
          if (countTap) for (const p of countTap.feedChannels(piece)) outChars += p.text.length;
        }
      } catch (e) {
        streamError = true;
        throw e;
      }
      if (holdForCheck && !clientGone) {
        const whole = Buffer.concat(held).toString("utf8");
        safetyOut = cs!.check(completionTexts(whole));
        if (safetyOut.blocked) {
          blockedOut = safetyOut.blocked;
          finalStatus = 422;
          const s = JSON.stringify({ error: { type: "kwl_gateway", code: "content_blocked_output", message: `模型输出命中内容安全策略（${safetyOut.blocked}），已拒绝` } });
          res.writeHead(422, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(s), "x-kwl-gateway-request-id": requestId });
          res.write(s);
        } else {
          res.writeHead(upr.status, fwd);
          for (const c of held) res.write(c);
        }
      } else if (tap && !blockedOut) safetyOut = cs!.check([...outTexts.values()]);
      if (!clientGone) {
        // 块间隔超时：断开客户端流（客户端读到中断而不是挂住）
        if (timedOut === "idle" && !blockedOut) res.destroy();
        else if (!res.writableEnded) res.end();
      }
      usage = extractUsage(tail);
      finishReason = extractFinishReason(tail);
      upstreamReqId = upstreamRequestIdOf(upr.headers, head);
    } finally {
      clearTimeout(upTimer);
      clearTimeout(drainTimer);
      onGone = null;
      if (ticket) {
        if (streamError) ticket.failure("stream_error");
        else if (timedOut === "idle") ticket.cancel("idle_timeout");
        else ticket.success(attemptMs);
      }
      releaseTenant();
      // ─── 逐请求记录 ───
      let outcome: UsageOutcome;
      let source: UsageSource = "none";
      let u: UsageTokens | null = null;
      const estimated = (): UsageTokens => ({ input: est.input, cached: 0, output: Math.ceil(outChars / 2), reasoning: 0 });
      if (!up) outcome = clientGone ? "client_gone" : failure?.timeout ? "timeout" : "upstream_error";
      else if (streamError) outcome = "upstream_error";
      else if (clientGone || blockedOut) {
        outcome = blockedOut ? "blocked" : "client_gone";
        if (usage) {
          source = draining ? "drained" : "upstream";
          u = usage;
        } else {
          source = "estimated";
          u = estimated();
        }
      } else if (timedOut) outcome = "timeout";
      else {
        outcome = "ok";
        if (usage) {
          source = "upstream";
          u = usage;
        } else {
          source = "estimated";
          u = estimated();
        }
      }
      // 上游错误、超时：不扣（成本可能已由上游计费，控制面另记）
      const charge = u && source !== "none" ? (unitsOf(hold.unit, u, priceItem) ?? 0) : 0;
      const served = chosen ?? lastTried;
      const record: UsageRecord = {
        request_id: requestId,
        client_request_id: clientRequestId,
        upstream_request_id: upstreamReqId,
        started_at: startedAt,
        at: new Date().toISOString(),
        tid: seat.tid,
        sid: seat.sid,
        uid: seat.uid,
        dev: seat.dev,
        alias,
        provider: served?.entry.id ?? null,
        upstream_model: served?.model ?? null,
        stream,
        qa,
        status: finalStatus,
        outcome,
        usage: u,
        usage_source: source,
        reserved_units: hold.units,
        charge_units: charge,
        latency_ms: Date.now() - started,
        attempts,
        finish_reason: finishReason,
        lease_id: hold.leaseId ?? null,
        price_version: priceVersion ?? hold.priceVersion ?? null,
      };
      const reason = timedOut
        ? `upstream_${timedOut}_timeout`
        : blockedOut
          ? `content_blocked_output:${blockedOut}`
          : !up
            ? clientGone
              ? "client_gone_no_response"
              : attempts.length
                ? "upstream_error_released"
                : (failure?.code ?? "upstream_unavailable")
            : streamError
              ? "upstream_stream_error"
              : clientGone
                ? usage
                  ? "client_gone_drained"
                  : "client_gone_estimated"
                : usage
                  ? null
                  : "usage_missing_estimated";
      // 先写预写日志（发件箱），再结算并排进回报队列；预写失败照常结算（记录仍外送，审计 §2 的顺序问题）
      let pos: MeterPos | null = null;
      try {
        pos =
          (o.meter.append({
            at: record.at,
            ...base,
            kind: "settle",
            model: alias,
            status: finalStatus,
            reserved: hold.units,
            inputTokens: usage?.input ?? null,
            outputTokens: usage?.output ?? null,
            cachedTokens: usage?.cached ?? null,
            latencyMs: record.latency_ms,
            finishReason,
            upstreamModel: record.upstream_model,
            provider: record.provider,
            unit: hold.unit,
            priceVersion: hold.priceVersion ?? priceVersion,
            holder,
            reason,
            safety: safetyField(safetyOut),
            record,
          }) as MeterPos | undefined) ?? null;
      } catch {
        pos = null;
      }
      quota.settle(hold, record, pos);
    }
  }

  /** 写一块到客户端；缓冲满时等 drain，但与客户端断开竞争。返回 false = 不可再写。 */
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

  const server = createServer((req, res) => {
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
        const data = [...routing.current().models].filter(([, m]) => m.enabled).map(([id, m]) => ({ id, object: "model", owned_by: "zr-legal-gateway", label: m.label, is_default: m.isDefault }));
        send(res, 200, { object: "list", data });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") return handleChat(req, res, seat);
      if (req.method === "POST" && url.pathname === "/v1/qa/chat/completions") return handleChat(req, res, seat, true);
      throw new GwError(404, "not_found", "没有这条路由");
    })().catch((e: unknown) => {
      const ge = e instanceof GwError ? e : new GwError(502, "gateway_error", "网关错误");
      if (res.headersSent) res.destroy();
      else send(res, ge.status, { error: { type: "kwl_gateway", code: ge.code, message: ge.message } }, ge.headers);
    });
  });
  return Object.assign(server, { metrics: (): GatewayMetrics => ({ upstream: { ...upstreamCounts }, rejects: { ...rejectCounts } }) });
}
