/**
 * 开发用“云端 v0”（v9 第 04 篇 §5.2、§5.3 的本机部署模拟）：在回环端口拉起法律模型网关 v0 与检索服务 v0，打印内核需要的环境变量。
 *
 * - 缺省用 mock 上游（确定性、离线）；设置 KWL_MOONSHOT_API_KEY 时网关改为直连月之暗面开放平台（真实额度，P7 联调用）；
 *   设置 KWL_MOONSHOT_SEARCH=1 时检索服务改为 /v1/tools/search(_pro)（P4 联调用）。主密钥只在本进程内存。
 * - 席位令牌用开发密钥签发（生产由控制面签发，网关离线验签 ≥ 72 小时）。
 * - KWL_CONTROL_PLANE=1（阶段 6）：同时拉起控制面 v0 并开通租户（KWL_EDITION=firm 为律所版，管理员签名门限 2）；网关与检索服务订阅控制面
 *   （吊销集、事项匿名摘要）；席位令牌由控制面签发给内核——本脚本不再输出任何令牌，只输出地址与控制面公钥。
 * - 计量只写元数据（网关预写日志在 KWL_CLOUD_DIR，缺省会话临时目录）。
 * - KWL_SAFETY_POLICY=<策略 JSON>：网关启用内容安全（按类别计数或拦截，计量只记类别与次数）。
 * - KWL_CP_STATE_FILE / KWL_CP_STATE_KEY：控制面状态持久化（两代交替文件、可封装；生产形态必须封装）。
 * - KWL_DIST_DIR=<分发存储根>（第 8 批 S6/S7）：同时拉起内容分发服务 v0（法规库与方法模板的签名清单与包；发布用 scripts/dist-publish.mjs）。
 * - 控制面形态（第 9 批 S3）：网关的额度改由控制面额度账本发放租约（开通时注入 KWL_POINTS 点，缺省 1 亿）；律所管理员可在客户端设月度上限。
 *   KWL_CP_AUDIT_FILE：运营审计流水落盘（JSON Lines，启动时验链）。
 * - KWL_SUPPORT_DIR=<目录>（第 9 批 S13）：同时拉起支持与诊断服务 v0（诊断包上传；运营凭据 KWL_SUPPORT_OPS_SECRET，缺省随机且不输出）。
 * - KWL_NOTIFY_DIR=<目录>（第 10 批 S9）：同时拉起通知与提醒服务 v0（期限提醒：只存触发时刻、接收设备与密文；凭据由控制面签发，须 KWL_CONTROL_PLANE=1）。
 * - KWL_ACTIVATION=1（第 13 批开通与成员入组；须 KWL_CONTROL_PLANE=1）：租户要求开通码，开发用创始开通码写进 <KWL_CLOUD_DIR>/founder-code.txt。
 * - KWL_RELAY_DIR=<目录>（第 11 批 S11）：同时拉起共享中继服务 v0（团队事项密文同步；按订阅核对律所策略 share_relay，须 KWL_CONTROL_PLANE=1）。
 *
 * 用法：node scripts/dev-cloud-v0.mjs   → 按输出设置环境变量后启动内核 / 桌面
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
let quota;
if (withCp) {
  const cpMod = await import("../services/control-plane/src/index.ts");
  const ft = await import("../packages/firm-trust/src/index.ts");
  const serviceSecret = randomBytes(24).toString("base64url");
  // 状态持久化（复核 B4-R14）：KWL_CP_STATE_FILE 指定状态文件（两代交替写），KWL_CP_STATE_KEY 为 64 位十六进制封装密钥；
  // NODE_ENV=production 时没有封装密钥拒绝启动。注意：开发形态的控制面签名密钥每次运行新生成，重启后客户端须重新取回签名文档
  const statePath = process.env.KWL_CP_STATE_FILE;
  const stateKey = process.env.KWL_CP_STATE_KEY;
  if (stateKey && !/^[0-9a-f]{64}$/i.test(stateKey)) throw new Error("KWL_CP_STATE_KEY 须为 64 位十六进制（32 字节）");
  const stateStore = statePath
    ? cpMod.fileStateStore(statePath, { ...(stateKey ? { key: Buffer.from(stateKey, "hex") } : {}), requireKey: process.env.NODE_ENV === "production" })
    : undefined;
  // 给了状态文件就要有审计文件（复核 S9A-15：否则重启后租户还在、审计链从零开始，律所侧误报“云端改写了历史”）：缺省放在状态文件旁边
  const auditFile = process.env.KWL_CP_AUDIT_FILE ?? (statePath ? `${statePath}.audit.jsonl` : undefined);
  const auditLog = auditFile ? cpMod.createAuditLog({ file: auditFile }) : undefined;
  cp = cpMod.createControlPlane({ keys: cpMod.devControlPlaneKeys(), serviceSecret, ...(stateStore ? { stateStore } : {}), ...(auditLog ? { auditLog } : {}) });
  await new Promise((r) => cp.server.listen(Number(process.env.KWL_CP_PORT ?? 0), "127.0.0.1", r));
  // 第 13 批开通与成员入组：KWL_ACTIVATION=1 时租户要求开通码，开发用创始开通码写进 <KWL_CLOUD_DIR>/founder-code.txt（0600，不输出到终端）
  const activation = process.env.KWL_ACTIVATION === "1";
  if (!cp.ops.tenant(tenant)) {
    cp.ops.createTenant({ tid: tenant, edition: process.env.KWL_EDITION === "firm" ? "firm" : "team", seats: 20, points: Number(process.env.KWL_POINTS ?? 100_000_000), ...(activation ? { name: process.env.KWL_FIRM_NAME ?? "示例律师事务所", activationRequired: true } : { activationRequired: false }) });
    if (activation) {
      const { writeFileSync } = await import("node:fs");
      const issued = cp.ops.issueActivationCode(tenant, { member: { slug: process.env.KWL_FOUNDER_SLUG ?? "admin", name: process.env.KWL_FOUNDER_NAME ?? "管理员" } });
      writeFileSync(join(dir, "founder-code.txt"), `${issued.code}\n`, { mode: 0o600 });
      console.log(`# 开发用创始开通码已写入 ${join(dir, "founder-code.txt")}（客户端须以待激活形态启动：ZR_ONBOARDING=1 且不设 ZR_FIRM_SLUG）`);
    }
  }
  quota = new gw.LeaseQuota({ ledger: gw.httpLedger({ baseUrl: `http://127.0.0.1:${cp.server.address().port}`, serviceSecret }), holder: "gw-dev-1" });
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
// 内容安全（v9.2 R11）：KWL_SAFETY_POLICY 指向策略 JSON（{version, categories:[{id, action, terms}]}）时启用；生产词库由内容安全团队签名下发
const { readFileSync } = await import("node:fs");
const contentSafety = process.env.KWL_SAFETY_POLICY ? new gw.ContentSafety(JSON.parse(readFileSync(process.env.KWL_SAFETY_POLICY, "utf8"))) : undefined;
const gateway = gw.createLegalGateway({ keys, provider, routes: gw.DEFAULT_ROUTES, meter: gw.fileMeter(join(dir, "gateway-meter.jsonl")), ...(quota ? { quota } : { budgets: new Map([[tenant, 100_000_000]]) }), ...(feed ? { feed } : {}), ...(contentSafety ? { contentSafety } : {}) });
const searchProvider =
  process.env.KWL_MOONSHOT_SEARCH === "1" && process.env.KWL_MOONSHOT_API_KEY
    ? new ss.MoonshotToolsSearchProvider({ apiKey: process.env.KWL_MOONSHOT_API_KEY, baseUrl: process.env.KWL_MOONSHOT_BASE })
    : new ss.MockSearchProvider();
const search = ss.createSearchService({ keys, provider: searchProvider, meter: { append() {} }, ...(feed ? { feed } : {}) });

await new Promise((r) => gateway.listen(Number(process.env.KWL_GATEWAY_PORT ?? 0), "127.0.0.1", r));
await new Promise((r) => search.listen(Number(process.env.KWL_SEARCH_PORT ?? 0), "127.0.0.1", r));
let dist;
if (process.env.KWL_DIST_DIR) {
  const da = await import("../services/dist-api/src/index.ts");
  dist = da.createDistApi({ dir: process.env.KWL_DIST_DIR, keys, ...(feed ? { feed } : {}) });
  await new Promise((r) => dist.listen(Number(process.env.KWL_DIST_PORT ?? 0), "127.0.0.1", r));
}
let support;
if (process.env.KWL_SUPPORT_DIR) {
  const sa = await import("../services/support-api/src/index.ts");
  // 设备编号 HMAC 密钥：开发形态由目录派生固定值（复核 S9B-08：重启不换，待上传工单与访问审计跨重启可关联）；生产由 KMS 下发
  const { createHash } = await import("node:crypto");
  const meterKey = process.env.KWL_SUPPORT_METER_KEY ? Buffer.from(process.env.KWL_SUPPORT_METER_KEY, "hex") : createHash("sha256").update(`kwl-dev-support-meter\n${process.env.KWL_SUPPORT_DIR}`).digest();
  support = sa.createSupportApi({ dir: process.env.KWL_SUPPORT_DIR, keys, meterKey, opsSecret: process.env.KWL_SUPPORT_OPS_SECRET ?? randomBytes(24).toString("base64url"), ...(feed ? { feed } : {}) });
  await new Promise((r) => support.listen(Number(process.env.KWL_SUPPORT_PORT ?? 0), "127.0.0.1", r));
}
let notify;
if (process.env.KWL_NOTIFY_DIR) {
  const na = await import("../services/notify-api/src/index.ts");
  notify = na.createNotifyApi({ dir: process.env.KWL_NOTIFY_DIR, keys, ...(feed ? { feed } : {}) });
  await new Promise((r) => notify.listen(Number(process.env.KWL_NOTIFY_PORT ?? 0), "127.0.0.1", r));
}
let relay;
if (process.env.KWL_RELAY_DIR) {
  if (!feed) throw new Error("KWL_RELAY_DIR 须与 KWL_CONTROL_PLANE=1 一起使用（中继按控制面订阅核对律所策略）");
  const ra = await import("../services/relay-api/src/index.ts");
  relay = ra.createRelayApi({ dir: process.env.KWL_RELAY_DIR, keys, feed });
  await new Promise((r) => relay.listen(Number(process.env.KWL_RELAY_PORT ?? 0), "127.0.0.1", r));
}
console.log("# 云端 v0 已启动（本机模拟部署；上游：" + provider.name + " / 检索：" + searchProvider.name + (withCp ? " / 控制面 v0" : "") + "）");
console.log(`export ZR_GATEWAY_BASE=http://127.0.0.1:${gateway.address().port}/v1`);
console.log(`export ZR_SEARCH_BASE=http://127.0.0.1:${search.address().port}/search`);
if (dist) console.log(`export ZR_DIST_BASE=http://127.0.0.1:${dist.address().port}`);
if (support) console.log(`export ZR_SUPPORT_BASE=http://127.0.0.1:${support.address().port}`);
if (notify) console.log(`export ZR_NOTIFY_BASE=http://127.0.0.1:${notify.address().port}`);
if (relay) console.log(`export ZR_RELAY_BASE=http://127.0.0.1:${relay.address().port}`);
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
