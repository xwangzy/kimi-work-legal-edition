/**
 * 开发用“云端 v0”（v9 第 04 篇 §5.2、§5.3 的本机部署模拟）：在回环端口拉起法律模型网关 v0 与检索服务 v0，打印内核需要的环境变量。
 *
 * - 缺省用 mock 上游（确定性、离线）；设置 KWL_MOONSHOT_API_KEY 时网关改为直连月之暗面开放平台（真实额度，P7 联调用）；
 *   设置 KWL_MOONSHOT_SEARCH=1 时检索服务改为 /v1/tools/search(_pro)（P4 联调用）。主密钥只在本进程内存。
 * - 席位令牌用开发密钥签发（生产由控制面签发，网关离线验签 ≥ 72 小时）。
 * - KWL_CONTROL_PLANE=1（阶段 6）：同时拉起控制面 v0 并开通租户（KWL_EDITION=firm 为律所版，管理员签名门限 2）；网关与检索服务订阅控制面
 *   （吊销集、事项匿名摘要）；席位令牌由控制面签发给内核——本脚本不再输出任何令牌，只输出地址与控制面公钥。
 * - 计量只写元数据（网关预写日志在 KWL_CLOUD_DIR，缺省会话临时目录）。
 *
 * 用法：node scripts/dev-cloud-v0.mjs   → 按输出设置环境变量后启动内核 / 桌面（ZR_AGENT_ENGINE=kap）
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { devSeatKeyPair, issueSeatToken } = await import("../packages/seat-token/src/index.ts");
const gw = await import("../services/legal-gateway/src/index.ts");
const ss = await import("../services/search-service/src/index.ts");

const tenant = process.env.KWL_TENANT ?? "ten_demo-firm";
const dir = process.env.KWL_CLOUD_DIR ?? mkdtempSync(join(tmpdir(), "kwl-cloud-v0-"));
const withCp = process.env.KWL_CONTROL_PLANE === "1";
const { privateKey, publicKey } = devSeatKeyPair();
let keys = new Map([["dev1", publicKey]]);
let feed;
let cp;
if (withCp) {
  const cpMod = await import("../services/control-plane/src/index.ts");
  const ft = await import("../packages/firm-trust/src/index.ts");
  const serviceSecret = randomBytes(24).toString("base64url");
  cp = cpMod.createControlPlane({ keys: cpMod.devControlPlaneKeys(), serviceSecret });
  await new Promise((r) => cp.server.listen(Number(process.env.KWL_CP_PORT ?? 0), "127.0.0.1", r));
  cp.ops.createTenant({ tid: tenant, edition: process.env.KWL_EDITION === "firm" ? "firm" : "team", seats: 20 });
  keys = ft.publicKeyMap(cp.publicKeys.seat);
  feed = new cpMod.GatewayFeedSubscriber({ url: `http://127.0.0.1:${cp.server.address().port}/v1/feed/gateway`, serviceSecret, keys: ft.publicKeyMap(cp.publicKeys.envelope) });
  feed.start(15_000);
}

const provider = process.env.KWL_MOONSHOT_API_KEY
  ? new gw.MoonshotProvider({ apiKey: process.env.KWL_MOONSHOT_API_KEY, baseUrl: process.env.KWL_MOONSHOT_BASE })
  : new gw.MockProvider();
// 界面联调用的脚本化 mock（只在 mock 上游时生效）：KWL_MOCK_SCRIPT 指向导出 default (body) => {content|toolCalls}|null 的模块
if (process.env.KWL_MOCK_SCRIPT && provider instanceof gw.MockProvider) {
  const { pathToFileURL } = await import("node:url");
  provider.script = (await import(pathToFileURL(process.env.KWL_MOCK_SCRIPT).href)).default;
}
const gateway = gw.createLegalGateway({ keys, provider, routes: gw.DEFAULT_ROUTES, meter: gw.fileMeter(join(dir, "gateway-meter.jsonl")), budgets: new Map([[tenant, 100_000_000]]), ...(feed ? { feed } : {}) });
const searchProvider =
  process.env.KWL_MOONSHOT_SEARCH === "1" && process.env.KWL_MOONSHOT_API_KEY
    ? new ss.MoonshotToolsSearchProvider({ apiKey: process.env.KWL_MOONSHOT_API_KEY, baseUrl: process.env.KWL_MOONSHOT_BASE })
    : new ss.MockSearchProvider();
const search = ss.createSearchService({ keys, provider: searchProvider, meter: { append() {} }, ...(feed ? { feed } : {}) });

await new Promise((r) => gateway.listen(Number(process.env.KWL_GATEWAY_PORT ?? 0), "127.0.0.1", r));
await new Promise((r) => search.listen(Number(process.env.KWL_SEARCH_PORT ?? 0), "127.0.0.1", r));
console.log("# 云端 v0 已启动（本机模拟部署；上游：" + provider.name + " / 检索：" + searchProvider.name + (withCp ? " / 控制面 v0" : "") + "）");
console.log(`export ZR_GATEWAY_BASE=http://127.0.0.1:${gateway.address().port}/v1`);
console.log(`export ZR_SEARCH_BASE=http://127.0.0.1:${search.address().port}/search`);
if (withCp) {
  // 控制面形态：地址与控制面公钥随客户端构建固定（这里经环境变量给出）；席位令牌由控制面签发给内核，不输出
  console.log(`export ZR_CONTROL_PLANE_BASE=http://127.0.0.1:${cp.server.address().port}`);
  console.log(`export ZR_CONTROL_PLANE_KEYS='${JSON.stringify(cp.publicKeys.envelope)}'`);
  console.log(`export ZR_SEAT_KEYS='${JSON.stringify(cp.publicKeys.seat)}'`);
  console.log(`# 租户 ${tenant}（${process.env.KWL_EDITION === "firm" ? "律所版：放宽须 2 名管理员签名" : "团队版：放宽须 1 名管理员签名"}）；ZR_FIRM_SLUG 须与租户一致（ten_<firm>）`);
} else {
  const seat = issueSeatToken({ tid: tenant, uid: "u-dev", sid: `seat-${tenant}`, dev: "dev-local", kid: "dev1" }, privateKey);
  console.log(`export ZR_SEAT_TOKEN=${seat}`);
}
console.log(`# 计量（只含元数据）：${join(dir, "gateway-meter.jsonl")}`);
