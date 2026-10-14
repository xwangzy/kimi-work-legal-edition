/**
 * 检索服务 v0（第 04 篇 §5.3；第 02 篇 §7.3 #31、§12“中软看得到什么”）：
 *
 * - 协议：Kimi Code 的托管检索协议 `POST {"text_query"}` → `{"search_results":[{title,url,snippet,site_name,date}]}`；
 * - 鉴权：席位令牌（离线验签）；**不接收、不记录事项编号**（只按席位计量）；
 * - 上游：月之暗面 `/v1/tools/search_pro`（`sites` ≤ 5、`time_window`）与 `/v1/tools/search`；真实协议与计费待中软组织测试额度核验（P4）；
 * - 法律官方站点集：每组 ≤ 5 个站点扇出，与一次通用检索合并、按 URL 去重，官方站点在前；
 * - 留存：查询原文不落盘、不进日志（计量只记席位、上游调用次数、结果数、耗时）；结果是公开信息，可按 URL 短期缓存（v0 不缓存）。
 */
import { createServer, type Server } from "node:http";
import type { KeyObject } from "node:crypto";
import { verifySeatToken, SeatTokenError, type SeatClaims } from "@zr-legal/seat-token";
import type { GatewayFeedView } from "@zr-legal/firm-trust";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  site_name?: string;
  date?: string;
}

export interface SearchProvider {
  readonly name: string;
  search(q: { query: string; sites?: readonly string[]; timeWindow?: string }, o: { signal: AbortSignal }): Promise<SearchResult[]>;
}

/** 法律官方站点集（规划初稿；由法律内容工程维护，签名下发）：每组 ≤ 5 个站点（search_pro 的 sites 上限）。 */
export const LEGAL_SITE_GROUPS: readonly (readonly string[])[] = Object.freeze([
  Object.freeze(["flk.npc.gov.cn", "www.npc.gov.cn", "www.court.gov.cn", "www.moj.gov.cn", "www.gov.cn"]),
  Object.freeze(["www.spp.gov.cn", "www.samr.gov.cn", "www.csrc.gov.cn", "www.pbc.gov.cn", "www.nfra.gov.cn"]),
]);

export interface SearchMeterRecord {
  at: string;
  tid: string;
  sid: string;
  upstreamCalls: number;
  results: number;
  latencyMs: number;
  status: number;
}

/** HTTP 层访问记录（含 401/404/400；只有元数据，不含查询）。 */
export interface SearchAccessRecord {
  at: string;
  method: string;
  path: string;
  status: number;
  clientRequestId: string | null;
}

export interface SearchServiceOptions {
  /** HTTP 层访问日志（阶段 7 复核 S7-B03）：每个请求一条。 */
  accessLog?: (r: SearchAccessRecord) => void;
  keys: ReadonlyMap<string, KeyObject>;
  revokedDevices?: ReadonlySet<string>;
  /** 吊销的席位（与网关同一吊销检查；审查 S4-15）。 */
  revokedSeats?: ReadonlySet<string>;
  /** 控制面订阅（阶段 6）：只用吊销集（检索调用不携带事项编号）。 */
  feed?: Pick<GatewayFeedView, "revokedDevice" | "revokedSeat">;
  provider: SearchProvider;
  meter: { append(r: SearchMeterRecord): void };
  /** 法律站点组扇出（缺省开）。 */
  legalFanout?: boolean;
  maxResults?: number;
}

const MAX_QUERY = 500;

export function createSearchService(o: SearchServiceOptions): Server {
  return createServer((req, res) => {
    const started = Date.now();
    if (o.accessLog) {
      const at = new Date().toISOString();
      const path = new URL(req.url ?? "/", "http://s").pathname.slice(0, 200);
      const rid = req.headers["x-kwl-request-id"];
      const clientRequestId = typeof rid === "string" && /^[A-Za-z0-9_-]{1,96}$/.test(rid) ? rid : null;
      res.once("close", () => o.accessLog!({ at, method: String(req.method ?? ""), path, status: res.statusCode, clientRequestId }));
    }
    const send = (status: number, body: unknown) => {
      const s = JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(s) });
      res.end(s);
    };
    // 客户端断开（闸门撤销、宿主取消）：响应未写完即中止上游检索（审查 S4-01）
    const ac = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) ac.abort();
    });
    void (async () => {
      const tok = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ""))?.[1];
      let seat: SeatClaims;
      try {
        if (!tok) throw new SeatTokenError("missing");
        seat = verifySeatToken(tok, o.keys, { ...(o.revokedDevices ? { revokedDevices: o.revokedDevices } : {}), ...(o.revokedSeats ? { revokedSeats: o.revokedSeats } : {}) });
        // 控制面订阅的吊销集（阶段 6）
        if (o.feed?.revokedDevice(seat.tid, seat.dev)) throw new SeatTokenError("device_revoked");
        if (o.feed?.revokedSeat(seat.sid)) throw new SeatTokenError("seat_revoked");
      } catch (e) {
        return send(401, { error: { code: `seat_${e instanceof SeatTokenError ? e.reason : "invalid"}`, message: "席位令牌无效" } });
      }
      if (req.method !== "POST" || new URL(req.url ?? "/", "http://s").pathname !== "/search") return send(404, { error: { code: "not_found", message: "没有这条路由" } });
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > 16 * 1024) return send(413, { error: { code: "body_too_large", message: "请求体过大" } });
        chunks.push(c as Buffer);
      }
      let query = "";
      try {
        query = String((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { text_query?: unknown }).text_query ?? "").trim();
      } catch {
        return send(400, { error: { code: "body_not_json", message: "请求体不是 JSON" } });
      }
      if (query.length === 0 || query.length > MAX_QUERY) return send(400, { error: { code: "query_invalid", message: `查询为空或超过 ${MAX_QUERY} 字` } });
      if (ac.signal.aborted) return;
      const calls: Promise<SearchResult[]>[] = [];
      if (o.legalFanout !== false) for (const sites of LEGAL_SITE_GROUPS) calls.push(o.provider.search({ query, sites }, { signal: ac.signal }));
      calls.push(o.provider.search({ query }, { signal: ac.signal }));
      const settled = await Promise.allSettled(calls);
      if (settled.every((s) => s.status === "rejected")) {
        o.meter.append({ at: new Date().toISOString(), tid: seat.tid, sid: seat.sid, upstreamCalls: calls.length, results: 0, latencyMs: Date.now() - started, status: 502 });
        return send(502, { error: { code: "upstream_failed", message: "检索上游不可用" } });
      }
      const seen = new Set<string>();
      const merged: SearchResult[] = [];
      for (const s of settled) {
        if (s.status !== "fulfilled") continue;
        for (const r of s.value) {
          const key = r.url.replace(/#.*$/, "").replace(/\/$/, "");
          if (!r.url || seen.has(key)) continue;
          seen.add(key);
          merged.push(r);
        }
      }
      const results = merged.slice(0, o.maxResults ?? 10);
      o.meter.append({ at: new Date().toISOString(), tid: seat.tid, sid: seat.sid, upstreamCalls: calls.length, results: results.length, latencyMs: Date.now() - started, status: 200 });
      send(200, { search_results: results });
    })().catch(() => {
      if (!res.headersSent) send(500, { error: { code: "search_error", message: "检索服务错误" } });
    });
  });
}

/** 月之暗面开放平台检索工具（协议按开放平台文档的 search / search_pro 草拟；真实请求与响应字段待组织测试额度核验）。 */
export class MoonshotToolsSearchProvider implements SearchProvider {
  readonly name = "moonshot-tools";
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  constructor(o: { baseUrl?: string; apiKey: string; fetchImpl?: typeof fetch }) {
    if (!o.apiKey) throw new Error("检索上游密钥未配置");
    this.baseUrl = (o.baseUrl ?? "https://api.moonshot.cn/v1").replace(/\/+$/, "");
    this.apiKey = o.apiKey;
    this.fetchImpl = o.fetchImpl ?? globalThis.fetch;
  }
  async search(q: { query: string; sites?: readonly string[]; timeWindow?: string }, o: { signal: AbortSignal }): Promise<SearchResult[]> {
    const pro = (q.sites?.length ?? 0) > 0 || q.timeWindow !== undefined;
    const r = await this.fetchImpl(`${this.baseUrl}/tools/${pro ? "search_pro" : "search"}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ query: q.query, ...(q.sites?.length ? { sites: q.sites.slice(0, 5) } : {}), ...(q.timeWindow ? { time_window: q.timeWindow } : {}) }),
      signal: o.signal,
    });
    if (!r.ok) throw new Error(`upstream ${r.status}`);
    const j = (await r.json()) as { search_results?: SearchResult[]; results?: SearchResult[]; data?: SearchResult[] };
    return (j.search_results ?? j.results ?? j.data ?? []).filter((x) => x && typeof x.url === "string");
  }
}

/** 确定性离线检索上游（开发与测试）：按站点组返回固定的官方站点结果，通用检索返回一条普通结果；明确标识为 mock。 */
export class MockSearchProvider implements SearchProvider {
  readonly name = "mock";
  readonly calls: { query: string; sites?: readonly string[] }[] = [];
  /** 测试用：按查询给出结果（v9 阶段 7 红队框架的“网页”载体）；返回 null 用缺省结果。生产没有这个提供方。 */
  script: ((q: { query: string; sites?: readonly string[] }) => SearchResult[] | null) | null = null;
  async search(q: { query: string; sites?: readonly string[] }): Promise<SearchResult[]> {
    this.calls.push({ query: q.query, ...(q.sites ? { sites: q.sites } : {}) });
    const scripted = this.script?.(q) ?? null;
    if (scripted) return scripted;
    if (q.sites?.length) {
      return q.sites.slice(0, 2).map((s, i) => ({ title: `（mock）${s} 关于“${q.query.slice(0, 20)}”的结果 ${i + 1}`, url: `https://${s}/mock/${i}`, snippet: "（mock 摘要）", site_name: s }));
    }
    return [
      { title: "（mock）通用结果", url: "https://example.org/mock", snippet: "（mock 摘要）" },
      { title: "（mock）与官方站点重复的结果", url: "https://flk.npc.gov.cn/mock/0", snippet: "重复" },
    ];
  }
}
