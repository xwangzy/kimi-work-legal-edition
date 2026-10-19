#!/usr/bin/env node
/**
 * 云端服务生产入口（第 13 批；评审 Z4 P0-4“云端七个服务只有开发脚本、无 TLS”、P0-7“生产形态可以不接吊销订阅”）。
 *
 *   node scripts/cloud-serve.mjs --config /etc/kwl/<服务>.json
 *
 * 与开发脚本 dev-cloud-v0.mjs 的区别（没有任何开发缺省）：
 * - 只接受 HTTPS（TLS ≥ 1.2；证书与私钥从文件读）；唯一例外是测试用的 `"insecure_loopback_for_test": true` 且只许监听 127.0.0.1；
 * - 签名密钥、服务间凭据、上游密钥、状态封装密钥一律从文件读（生产由 KMS / 密钥管理服务挂载为只读文件），不生成、不打印；
 * - 网关、检索、分发、支持、通知、中继**必须**订阅控制面吊销集（否则拒绝启动）；控制面状态**必须**封装、运营审计必须落盘；
 * - 不放行开发 mock 上游：网关与检索只接真实上游。
 * 启动日志只有角色、端口与“已就绪”，不含任何密钥、租户或请求内容。
 *
 * 配置（JSON）：
 * { "role": "control-plane|gateway|search|dist|support|notify|relay",
 *   "listen": { "host": "0.0.0.0", "port": 8443 },
 *   "tls": { "cert_file": "...", "key_file": "..." },
 *   "service_secret_file": "...",                         // 服务间凭据（G1 改 mTLS）
 *   "control_plane": { "url": "https://cp...", "keys_file": "cp-public-keys.json" },   // 订阅吊销集（控制面以外的角色）
 *   "seat_keys_file": "seat-public-keys.json",          // 席位令牌验签公钥（控制面以外的角色）
 *   "data_dir": "...",                                  // 分发、支持、通知、中继的存储根；控制面的状态与审计也放这里
 *   // 控制面：
 *   "envelope_key": { "kid": "cp-prod-1", "private_key_file": "..." }, "seat_key": { "kid": "seat-prod-1", "private_key_file": "..." },
 *   "state_key_file": "...",                             // 32 字节十六进制
 *   // 网关 / 检索：
 *   "upstream": { "base_url": "https://api.moonshot.cn/v1", "api_key_file": "..." },
 *   "content_safety_policy_file": "...",                 // 网关可选
 *   // 支持：
 *   "ops_secret_file": "...", "meter_key_file": "..." }
 */
import { createPrivateKey, createPublicKey } from "node:crypto";
import { createServer as createHttpsServer } from "node:https";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const i = process.argv.indexOf("--config");
const fail = (msg) => {
  console.error(`[cloud-serve] 拒绝启动：${msg}`);
  process.exit(2);
};
if (i < 0 || !process.argv[i + 1]) fail("缺少 --config <配置文件>");
let cfg;
try {
  cfg = JSON.parse(readFileSync(process.argv[i + 1], "utf8"));
} catch {
  fail("配置文件读不出或不是 JSON");
}
const ROLES = ["control-plane", "gateway", "search", "dist", "support", "notify", "relay"];
if (!ROLES.includes(cfg.role)) fail(`role 须为 ${ROLES.join(" / ")}`);
const read = (f, what) => {
  if (typeof f !== "string" || !f) fail(`缺少 ${what}`);
  try {
    return readFileSync(f, "utf8").trim();
  } catch {
    fail(`${what} 读不出`);
  }
};
const host = String(cfg.listen?.host ?? "0.0.0.0");
const port = Number(cfg.listen?.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) fail("listen.port 不合法（0 = 系统分配，只用于测试）");
const insecure = cfg.insecure_loopback_for_test === true;
if (insecure && host !== "127.0.0.1") fail("insecure_loopback_for_test 只许监听 127.0.0.1");
if (!insecure && !cfg.tls) fail("生产入口只接受 HTTPS：缺少 tls.cert_file / tls.key_file");
const tls = insecure ? null : { cert: read(cfg.tls.cert_file, "tls.cert_file"), key: read(cfg.tls.key_file, "tls.key_file"), minVersion: "TLSv1.2" };
const pubMap = (file, what) => {
  const raw = JSON.parse(read(file, what));
  const m = new Map();
  for (const [kid, pem] of Object.entries(raw)) m.set(kid, createPublicKey(String(pem)));
  if (m.size === 0) fail(`${what} 为空`);
  return m;
};
const dataDir = (sub) => {
  if (typeof cfg.data_dir !== "string" || !cfg.data_dir) fail("缺少 data_dir");
  const d = join(cfg.data_dir, sub);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
};

let svc;
let feed = null;
const serviceSecret = () => read(cfg.service_secret_file, "service_secret_file");

if (cfg.role === "control-plane") {
  const cpMod = await import(join(root, "services/control-plane/src/index.ts"));
  const pair = (k, what) => {
    if (!k?.kid || !k?.private_key_file) fail(`缺少 ${what}.kid / ${what}.private_key_file`);
    const privateKey = createPrivateKey(read(k.private_key_file, `${what}.private_key_file`));
    return { kid: String(k.kid), privateKey, publicKey: createPublicKey(privateKey) };
  };
  const stateKey = read(cfg.state_key_file, "state_key_file");
  if (!/^[0-9a-f]{64}$/i.test(stateKey)) fail("state_key_file 须为 32 字节十六进制");
  const dir = dataDir("control-plane");
  svc = cpMod.createControlPlane({
    keys: { envelope: pair(cfg.envelope_key, "envelope_key"), seat: pair(cfg.seat_key, "seat_key") },
    serviceSecret: serviceSecret(),
    stateStore: cpMod.fileStateStore(join(dir, "state"), { key: Buffer.from(stateKey, "hex"), requireKey: true }),
    auditLog: cpMod.createAuditLog({ file: join(dir, "audit.jsonl") }),
  }).server;
} else {
  // 控制面以外的角色：必须订阅控制面吊销集（评审 Z4 P0-7）
  if (!cfg.control_plane?.url || !String(cfg.control_plane.url).startsWith(insecure ? "http" : "https://")) fail("必须配置 control_plane.url（https）以订阅吊销集");
  const cpMod = await import(join(root, "services/control-plane/src/index.ts"));
  feed = new cpMod.GatewayFeedSubscriber({ url: `${String(cfg.control_plane.url).replace(/\/+$/, "")}/v1/feed/gateway`, serviceSecret: serviceSecret(), keys: pubMap(cfg.control_plane.keys_file, "control_plane.keys_file") });
  // 首次必须取到并核验通过（refresh 失败不抛错，只是不更新 lastOk）：之前不对外服务
  await feed.refresh().catch(() => {});
  if (!feed.lastOk) fail("首次取不到控制面吊销集（控制面不可达或签名不符）");
  feed.start(15_000);
  const seatKeys = pubMap(cfg.seat_keys_file, "seat_keys_file");
  if (cfg.role === "gateway") {
    const gw = await import(join(root, "services/legal-gateway/src/index.ts"));
    if (!cfg.upstream?.api_key_file) fail("网关只接真实上游：缺少 upstream.api_key_file");
    const provider = new gw.MoonshotProvider({ apiKey: read(cfg.upstream.api_key_file, "upstream.api_key_file"), ...(cfg.upstream.base_url ? { baseUrl: String(cfg.upstream.base_url) } : {}) });
    const quota = new gw.LeaseQuota({ ledger: gw.httpLedger({ baseUrl: String(cfg.control_plane.url).replace(/\/+$/, ""), serviceSecret: serviceSecret() }), holder: `gw-${host}-${port}` });
    const contentSafety = cfg.content_safety_policy_file ? new gw.ContentSafety(JSON.parse(read(cfg.content_safety_policy_file, "content_safety_policy_file"))) : undefined;
    svc = gw.createLegalGateway({ keys: seatKeys, provider, routes: gw.DEFAULT_ROUTES, meter: gw.fileMeter(join(dataDir("gateway"), "meter.jsonl")), quota, feed, ...(contentSafety ? { contentSafety } : {}) });
  } else if (cfg.role === "search") {
    const ss = await import(join(root, "services/search-service/src/index.ts"));
    if (!cfg.upstream?.api_key_file) fail("检索服务只接真实上游：缺少 upstream.api_key_file");
    const provider = new ss.MoonshotToolsSearchProvider({ apiKey: read(cfg.upstream.api_key_file, "upstream.api_key_file"), ...(cfg.upstream.base_url ? { baseUrl: String(cfg.upstream.base_url) } : {}) });
    svc = ss.createSearchService({ keys: seatKeys, provider, meter: { append() {} }, feed });
  } else if (cfg.role === "dist") {
    const da = await import(join(root, "services/dist-api/src/index.ts"));
    svc = da.createDistApi({ dir: dataDir("dist"), keys: seatKeys, feed });
  } else if (cfg.role === "support") {
    const sa = await import(join(root, "services/support-api/src/index.ts"));
    const meterKey = read(cfg.meter_key_file, "meter_key_file");
    if (!/^[0-9a-f]{64}$/i.test(meterKey)) fail("meter_key_file 须为 32 字节十六进制");
    svc = sa.createSupportApi({ dir: dataDir("support"), keys: seatKeys, meterKey: Buffer.from(meterKey, "hex"), opsSecret: read(cfg.ops_secret_file, "ops_secret_file"), feed });
  } else if (cfg.role === "notify") {
    const na = await import(join(root, "services/notify-api/src/index.ts"));
    svc = na.createNotifyApi({ dir: dataDir("notify"), keys: seatKeys, feed });
  } else {
    const ra = await import(join(root, "services/relay-api/src/index.ts"));
    svc = ra.createRelayApi({ dir: dataDir("relay"), keys: seatKeys, feed, opsSecret: read(cfg.ops_secret_file, "ops_secret_file") });
  }
}

// 同一个请求处理函数挂到 HTTPS 服务上（服务模块不变；定时器随原服务对象的 close 事件清理）
const handlers = svc.listeners("request");
const server = tls ? createHttpsServer(tls, (req, res) => handlers.forEach((h) => h(req, res))) : svc;
await new Promise((ok, no) => {
  server.once("error", no);
  server.listen(port, host, ok);
});
console.log(`[cloud-serve] ${cfg.role} 已就绪（${tls ? "https" : "http 仅测试"} ${host}:${server.address().port}）`);
const stop = () => {
  feed?.stop?.();
  server.close(() => {
    if (server !== svc) svc.emit("close");
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
