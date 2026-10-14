/**
 * 测试用“云端（含控制面）”（v9 阶段 6）：控制面 v0、订阅控制面的法律模型网关 v0 与检索服务 v0，都在测试进程内的回环端口上运行。
 * 内核按控制面形态配置：控制面地址与控制面公钥（产品随客户端构建固定）、网关与检索服务地址；席位令牌由控制面签发、内核续期。
 * 生产形态里三者在中软云端；这里只是部署形态的本机模拟，不是旁路。
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { issueSeatToken } from "@zr-legal/seat-token";
import { publicKeyMap, signDeviceRequest } from "@zr-legal/firm-trust";
import { createControlPlane, devControlPlaneKeys, GatewayFeedSubscriber, type ControlPlane } from "@zr-legal/control-plane";
import { createLegalGateway, DEFAULT_ROUTES, memoryMeter, MockProvider, type MeterRecord } from "@zr-legal/legal-gateway";
import { createSearchService, MockSearchProvider, type SearchMeterRecord } from "@zr-legal/search-service";
import type { DeviceCertificate } from "@zr-legal/keys";

export interface CloudCp {
  /** 传给 makeKernel 的环境变量（控制面形态；不含席位令牌——由控制面签发）。 */
  env: Record<string, string>;
  cp: ControlPlane;
  base: string;
  model: MockProvider;
  search: MockSearchProvider;
  gatewayMeter: MeterRecord[];
  searchMeter: SearchMeterRecord[];
  feed: GatewayFeedSubscriber;
  gatewayUrl: string;
  /** 直接向网关发请求用（模拟误配置或旧客户端）：用控制面的席位密钥签一枚席位令牌。 */
  seatFor(c: { tid: string; uid: string; sid: string; dev: string }): string;
  /** 以某台设备的身份向控制面发设备签名请求（模拟同事的客户端登记）。 */
  deviceCall(tid: string, device: { cert: DeviceCertificate; signPrivateKeyPem: string }, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }>;
  /**
   * 模拟控制面不可达（复核 S6-B32）：不可达期间直接断开连接；端口始终由控制面占着（不关闭再重新监听，避免被同时运行的其他测试占用）。
   */
  setControlPlaneAvailable(on: boolean): void;
  close(): Promise<void>;
}

export async function startCloudCp(o: { tenant: string; edition?: "team" | "firm"; seats?: number }): Promise<CloudCp> {
  const keys = devControlPlaneKeys();
  const serviceSecret = `svc-${Math.random().toString(36).slice(2)}`;
  const cp = createControlPlane({ keys, serviceSecret });
  let available = true;
  const handlers = cp.server.listeners("request") as ((req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void)[];
  cp.server.removeAllListeners("request");
  cp.server.on("request", (req, res) => {
    if (!available) {
      req.socket.destroy();
      return;
    }
    for (const h of handlers) h(req, res);
  });
  await new Promise<void>((r) => cp.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(cp.server.address() as AddressInfo).port}`;
  cp.ops.createTenant({ tid: o.tenant, edition: o.edition ?? "team", seats: o.seats ?? 10 });

  const cpKeys = publicKeyMap(cp.publicKeys.envelope);
  const seatKeys = publicKeyMap(cp.publicKeys.seat);
  const feed = new GatewayFeedSubscriber({ url: `${base}/v1/feed/gateway`, serviceSecret, keys: cpKeys, minRefreshMs: 0 });
  const model = new MockProvider();
  const meter = memoryMeter();
  const gateway: Server = createLegalGateway({ keys: seatKeys, provider: model, routes: DEFAULT_ROUTES, meter, budgets: new Map([[o.tenant, 50_000_000]]), tenantConcurrency: 4, feed });
  const search = new MockSearchProvider();
  const searchMeter: SearchMeterRecord[] = [];
  const searchSvc: Server = createSearchService({ keys: seatKeys, provider: search, meter: { append: (r) => void searchMeter.push(r) }, feed });
  await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", () => r()));
  await new Promise<void>((r) => searchSvc.listen(0, "127.0.0.1", () => r()));
  const gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`;
  return {
    env: {
      ZR_CONTROL_PLANE_BASE: base,
      ZR_CONTROL_PLANE_KEYS: JSON.stringify(cp.publicKeys.envelope),
      ZR_SEAT_KEYS: JSON.stringify(cp.publicKeys.seat),
      ZR_CONTROL_PLANE_SYNC_MS: "off",
      ZR_GATEWAY_BASE: gatewayUrl,
      ZR_SEARCH_BASE: `http://127.0.0.1:${(searchSvc.address() as AddressInfo).port}/search`,
    },
    cp,
    base,
    model,
    search,
    gatewayMeter: (meter as unknown as { records: MeterRecord[] }).records,
    searchMeter,
    feed,
    gatewayUrl,
    seatFor: (c) => issueSeatToken({ ...c, kid: keys.seat.kid }, keys.seat.privateKey),
    setControlPlaneAvailable(on) {
      available = on;
      if (!on) cp.server.closeAllConnections();
    },
    async deviceCall(tid, device, method, path, body) {
      const raw = body === undefined ? "" : JSON.stringify(body);
      const h = signDeviceRequest({ method, path, body: raw, tid, deviceId: device.cert.deviceId, signPrivateKeyPem: device.signPrivateKeyPem });
      const r = await fetch(`${base}${path}`, { method, headers: { ...h, ...(raw ? { "content-type": "application/json" } : {}) }, ...(raw ? { body: raw } : {}) });
      return { status: r.status, json: await r.json() };
    },
    async close() {
      feed.stop();
      for (const s of [cp.server, gateway, searchSvc]) {
        s.closeAllConnections();
        await new Promise<void>((r) => s.close(() => r()));
      }
    },
  };
}
