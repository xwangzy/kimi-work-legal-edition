/**
 * P12 注入红队框架（v9 阶段 7）：测试用云端（复核 S7-A03、S7-B03、S7-B04）。
 *
 * - 法律模型网关 v0 与检索服务 v0（与 cloud-v0 相同的模拟上游），外加 HTTP 层的原始访问日志：每一个到达的请求都记下
 *   （含鉴权失败与被拒绝的），连同闸门写入的 `x-kwl-request-id`——判定按编号与闸门去向记录逐条对账，不再按条数；
 * - 回环“攻击者站点”（蜜罐）：出站闸门拒绝私网地址，产品路径不可能访问它；任何一次命中都只能来自绕开闸门的连接。
 * 全部在测试进程内的回环端口上，不访问外部主机。
 */
import type { AddressInfo } from "node:net";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { devSeatKeyPair, issueSeatToken } from "@zr-legal/seat-token";
import { createLegalGateway, DEFAULT_ROUTES, memoryMeter, MockProvider, type MeterRecord } from "@zr-legal/legal-gateway";
import { createSearchService, MockSearchProvider, type SearchMeterRecord } from "@zr-legal/search-service";

export interface UpstreamHit {
  at: number;
  server: "gateway" | "search";
  method: string;
  path: string;
  /** 闸门写入的请求编号（`x-kwl-request-id`）；绕开闸门的请求没有。 */
  requestId: string | null;
  hasSeat: boolean;
  status: number | null;
}

export interface HoneypotHit {
  at: number;
  method: string;
  url: string;
  ua: string | null;
}

export interface P12Cloud {
  env: Record<string, string>;
  model: MockProvider;
  search: MockSearchProvider;
  gatewayMeter: MeterRecord[];
  searchMeter: SearchMeterRecord[];
  /** 到达网关与检索服务的全部请求（HTTP 层）。 */
  upstreamHits: UpstreamHit[];
  /** 蜜罐（攻击者站点）收到的全部请求。 */
  honeypotHits: HoneypotHit[];
  /** 蜜罐地址（供 `{{attacker_url}}` 占位符）。 */
  attackerUrl: string;
  /** 网关地址（供端到端自检：直接向网关发一个不经闸门的请求）。 */
  gatewayUrl: string;
  /** 席位令牌（只用于用例金丝雀与端到端自检，不写进报告）。 */
  seatToken: string;
  close(): Promise<void>;
}

function logged(server: Server, name: UpstreamHit["server"], hits: UpstreamHit[]): void {
  const handlers = server.listeners("request") as ((req: IncomingMessage, res: ServerResponse) => void)[];
  server.removeAllListeners("request");
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const hit: UpstreamHit = {
      at: Date.now(),
      server: name,
      method: req.method ?? "?",
      path: (req.url ?? "").split("?")[0]!,
      requestId: typeof req.headers["x-kwl-request-id"] === "string" ? req.headers["x-kwl-request-id"] : null,
      hasSeat: typeof req.headers.authorization === "string" && req.headers.authorization.length > 10,
      status: null,
    };
    hits.push(hit);
    res.on("finish", () => {
      hit.status = res.statusCode;
    });
    for (const h of handlers) h(req, res);
  });
}

export async function startP12Cloud(o: { tenant: string }): Promise<P12Cloud> {
  const { privateKey, publicKey } = devSeatKeyPair();
  const keys = new Map([["dev1", publicKey]]);
  const model = new MockProvider();
  const meter = memoryMeter();
  const upstreamHits: UpstreamHit[] = [];
  const honeypotHits: HoneypotHit[] = [];
  const gateway: Server = createLegalGateway({ keys, provider: model, routes: DEFAULT_ROUTES, meter, budgets: new Map([[o.tenant, 50_000_000]]), tenantConcurrency: 4 });
  const search = new MockSearchProvider();
  const searchMeter: SearchMeterRecord[] = [];
  const searchSvc: Server = createSearchService({ keys, provider: search, meter: { append: (r) => void searchMeter.push(r) } });
  logged(gateway, "gateway", upstreamHits);
  logged(searchSvc, "search", upstreamHits);
  const honeypot = createServer((req, res) => {
    honeypotHits.push({ at: Date.now(), method: req.method ?? "?", url: req.url ?? "", ua: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null });
    req.resume();
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("ok");
  });
  for (const s of [gateway, searchSvc, honeypot]) await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s: Server) => (s.address() as AddressInfo).port;
  const seatToken = issueSeatToken({ tid: o.tenant, uid: "u-test", sid: `seat-${o.tenant}`, dev: "dev-test", kid: "dev1" }, privateKey);
  const gatewayUrl = `http://127.0.0.1:${port(gateway)}/v1`;
  return {
    env: {
      ZR_GATEWAY_BASE: gatewayUrl,
      ZR_SEARCH_BASE: `http://127.0.0.1:${port(searchSvc)}/search`,
      ZR_SEAT_TOKEN: seatToken,
    },
    model,
    search,
    gatewayMeter: (meter as unknown as { records: MeterRecord[] }).records,
    searchMeter,
    upstreamHits,
    honeypotHits,
    attackerUrl: `http://127.0.0.1:${port(honeypot)}/p12`,
    gatewayUrl,
    seatToken,
    async close() {
      for (const s of [gateway, searchSvc, honeypot]) {
        s.closeAllConnections();
        await new Promise<void>((r) => s.close(() => r()));
      }
    },
  };
}
