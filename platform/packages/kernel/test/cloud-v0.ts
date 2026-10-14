/**
 * 测试用“云端 v0”（v9 第 04 篇 §5.2、§5.3）：法律模型网关 v0（MockProvider）与检索服务 v0（MockSearchProvider）在测试进程内的回环端口上运行，
 * 席位令牌用开发密钥签发。内核经出站闸门进程访问它们——测试覆盖“宿主/内核 → 闸门 → 网关 → 上游（mock）”整条链路。
 * 生产形态里两者在中软云端；这里只是部署形态的本机模拟，不是旁路。
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { devSeatKeyPair, issueSeatToken } from "@zr-legal/seat-token";
import { createLegalGateway, DEFAULT_ROUTES, memoryMeter, MockProvider, type AccessRecord, type MeterRecord } from "@zr-legal/legal-gateway";
import { createSearchService, MockSearchProvider, type SearchAccessRecord, type SearchMeterRecord } from "@zr-legal/search-service";

export interface CloudV0 {
  /** 传给 makeKernel 的环境变量（网关、检索服务与席位令牌）。 */
  env: Record<string, string>;
  model: MockProvider;
  search: MockSearchProvider;
  gatewayMeter: MeterRecord[];
  searchMeter: SearchMeterRecord[];
  /** HTTP 层访问日志（含鉴权失败与未知路由；阶段 7 复核 S7-B03）。 */
  gatewayAccess: AccessRecord[];
  searchAccess: SearchAccessRecord[];
  close(): Promise<void>;
}

export async function startCloudV0(o: { tenant: string }): Promise<CloudV0> {
  const { privateKey, publicKey } = devSeatKeyPair();
  const keys = new Map([["dev1", publicKey]]);
  const model = new MockProvider();
  const meter = memoryMeter();
  const gatewayAccess: AccessRecord[] = [];
  const searchAccess: SearchAccessRecord[] = [];
  const gateway: Server = createLegalGateway({ keys, provider: model, routes: DEFAULT_ROUTES, meter, budgets: new Map([[o.tenant, 50_000_000]]), tenantConcurrency: 4, accessLog: (r) => void gatewayAccess.push(r) });
  const search = new MockSearchProvider();
  const searchMeter: SearchMeterRecord[] = [];
  const searchSvc: Server = createSearchService({ keys, provider: search, meter: { append: (r) => void searchMeter.push(r) }, accessLog: (r) => void searchAccess.push(r) });
  await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", () => r()));
  await new Promise<void>((r) => searchSvc.listen(0, "127.0.0.1", () => r()));
  const seat = issueSeatToken({ tid: o.tenant, uid: "u-test", sid: `seat-${o.tenant}`, dev: "dev-test", kid: "dev1" }, privateKey);
  return {
    env: {
      ZR_GATEWAY_BASE: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`,
      ZR_SEARCH_BASE: `http://127.0.0.1:${(searchSvc.address() as AddressInfo).port}/search`,
      ZR_SEAT_TOKEN: seat,
    },
    model,
    search,
    gatewayMeter: (meter as unknown as { records: MeterRecord[] }).records,
    searchMeter,
    gatewayAccess,
    searchAccess,
    async close() {
      gateway.closeAllConnections();
      searchSvc.closeAllConnections();
      await Promise.all([new Promise<void>((r) => gateway.close(() => r())), new Promise<void>((r) => searchSvc.close(() => r()))]);
    },
  };
}
