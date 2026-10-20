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
 *   "service_secret_file": "...",                         // 服务间凭据（G1 改 mTLS）；至少 32 字节随机：64 位以上十六进制或 43 位以上 base64url
 *   "max_connections": 10000,                             // 可选：并发连接上限（缺省 10000）
 *   "control_plane": { "url": "https://cp...", "keys_file": "cp-public-keys.json" },   // 订阅吊销集（控制面以外的角色）
 *   "seat_keys_file": "seat-public-keys.json",          // 席位令牌验签公钥（控制面以外的角色）
 *   "data_dir": "...",                                  // 分发、支持、通知、中继的存储根；控制面的状态与审计也放这里
 *   // 控制面：
 *   "envelope_key": { "kid": "cp-prod-1", "private_key_file": "..." }, "seat_key": { "kid": "seat-prod-1", "private_key_file": "..." },
 *   "state_key_file": "...",                             // 32 字节十六进制
 *   "code_pepper_file": "...",                           // 开通码 HMAC 胡椒，32 字节十六进制（与签名密钥分开，KMS 挂载；复核 A-15 起必填）
 *   // 网关 / 检索：
 *   "upstream": { "base_url": "https://api.moonshot.cn/v1", "api_key_file": "..." },
 *   "content_safety_policy_file": "...",                 // 网关可选
 *   // 支持：
 *   "meter_key_file": "...",
 *   // 运营接口（控制面、支持、中继、通知可选；v9.3 A-10 按人鉴权，共享运营口令 ops_secret_file 已停用、配了即拒绝启动）：
 *   "ops": { "roster_file": "/etc/kwl/ops-roster.json",          // 安全管理员签名的运营名册（每人的签名公钥、权限、状态；换文件即生效）
 *            "roster_keys_file": "/etc/kwl/ops-roster-keys.json", // 名册签名公钥 { kid: PEM }
 *            "allow_cidrs": ["10.20.0.0/24"] } }                  // 运维网段（堡垒机出口）：来源不在其中的运营请求一律 404
 * 没有 ops：运营路径一律 404。名册版本记录、随机数与被拒记录在 <data_dir>/<角色>/ops/。
 * 全部密钥文件除格式外还核“是不是随机生成的”（scripts/lib/secret-strength.mjs：拒绝重复、递增、单一字符类、占位词）；服务间凭据同一要求。
 *
 * 可观测性（v9.3 A-9；scripts/lib/obs.mjs）：每个角色都写访问日志与错误日志（按白名单、不记内容，`log_dir` 缺省为 `<data_dir>/obs`，必须有其一），
 * 保留 `log_retention_days` 天（缺省 190）；/healthz 与 /readyz 由入口应答；指标另起监听 `metrics`：
 *   "metrics": { "host": "127.0.0.1", "port": 9464, "token_file": "..." }   // 监听回环以外的地址必须给令牌（至少 32 字节随机）
 */
import { createPrivateKey, createPublicKey } from "node:crypto";
import { createServer as createHttpsServer } from "node:https";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { BlockList, isIPv4, isIPv6 } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createHttpServer } from "node:http";
import { weakSecretReason } from "./lib/secret-strength.mjs";
import { createObs } from "./lib/obs.mjs";

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
// 密钥文件强度（复核 A-15；第 14 批第二轮复核 A 余项）：格式与长度之外，拒绝重复、递增、只有一类字符、占位词等明显手填的值
const secretFile = (f, what, kind) => {
  const s = read(f, what);
  const why = weakSecretReason(s, kind);
  if (why) fail(`${what} ${why}（建议用 openssl rand -hex 32 生成）`);
  return s;
};
// 服务间凭据：至少 32 字节随机——64 位以上十六进制或 43 位以上 base64url
const serviceSecret = () => secretFile(cfg.service_secret_file, "service_secret_file", "random32");

// ─── 运营按人鉴权（v9.3 A-10）：安全管理员签名的运营名册 + 每人自己的签名密钥；只接受运维网段来的运营请求 ───
if (cfg.ops_secret_file !== undefined) fail("ops_secret_file 已停用（v9.3 A-10 运营按人鉴权）：改为配置 ops.roster_file、ops.roster_keys_file、ops.allow_cidrs（见 docs/部署-云端生产入口.md）");
const OPS_AUDIENCE = { "control-plane": "control-plane", support: "support", relay: "relay", notify: "notify" };
const opsMod = await import(join(root, "packages/ops-auth/src/index.ts"));
let opsGuard = null;
/** 运维网段（null = 没有配置运营接口：运营路径一律 404）。 */
let opsSources = null;
if (cfg.ops !== undefined) {
  if (!OPS_AUDIENCE[cfg.role]) fail(`${cfg.role} 没有运营接口，不要配置 ops`);
  const c = cfg.ops ?? {};
  if (typeof c.roster_file !== "string" || !c.roster_file) fail("缺少 ops.roster_file（运营名册）");
  const rosterKeys = pubMap(c.roster_keys_file, "ops.roster_keys_file");
  if (!Array.isArray(c.allow_cidrs) || c.allow_cidrs.length === 0) fail("ops.allow_cidrs 须列出运维网段（堡垒机出口地址）");
  opsSources = new BlockList();
  for (const x of c.allow_cidrs) {
    const [addr, bits, extra] = String(x).split("/");
    const v4 = isIPv4(addr ?? "");
    if (!v4 && !isIPv6(addr ?? "")) fail(`ops.allow_cidrs 里的 ${x} 不是网段`);
    const max = v4 ? 32 : 128;
    const n = bits === undefined ? max : Number(bits);
    // 不许“全部来源”（/0）：运营接口只对运维网段开放
    if (extra !== undefined || !Number.isInteger(n) || n < 1 || n > max) fail(`ops.allow_cidrs 里的 ${x} 前缀长度不合法（1–${max}，不许 /0）`);
    opsSources.addSubnet(addr, n, v4 ? "ipv4" : "ipv6");
  }
  const opsDir = join(dataDir(cfg.role), "ops");
  mkdirSync(opsDir, { recursive: true, mode: 0o700 });
  let roster;
  try {
    roster = opsMod.fileRosterSource({ file: c.roster_file, keys: rosterKeys, seenFile: join(opsDir, "roster-seen.json") });
  } catch {
    fail("运营名册的版本记录读不出（ops/roster-seen.json）");
  }
  const first = roster.current();
  if (!first.ok) fail(`运营名册不可用（${first.reason}）`);
  opsGuard = opsMod.createOpsGuard({
    audience: OPS_AUDIENCE[cfg.role],
    roster,
    nonces: opsMod.fileNonceStore(join(opsDir, "nonces.jsonl")),
    // 被拒的运营请求（按分钟限量）：只有声称的运营编号、原因与路径
    onReject: (r) => appendFileSync(join(opsDir, "rejects.jsonl"), `${JSON.stringify(r)}\n`, { mode: 0o600 }),
  });
}
/** 运营路径（原样与规范化后任一命中即算）只放行运维网段来的请求。 */
const opsPathBlocked = (req) => {
  const raw = String(req.url ?? "/").split("?")[0];
  let norm = raw;
  try {
    norm = new URL(String(req.url ?? "/"), "http://entry").pathname;
  } catch {
    // 解析不了：按原样判
  }
  if (!opsMod.OPS_PATH_RE.test(raw) && !opsMod.OPS_PATH_RE.test(norm)) return false;
  if (!opsSources) return true;
  let a = String(req.socket?.remoteAddress ?? "");
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(a);
  if (mapped) a = mapped[1];
  if (isIPv4(a)) return !opsSources.check(a, "ipv4");
  if (isIPv6(a)) return !opsSources.check(a, "ipv6");
  return true;
};

if (cfg.role === "control-plane") {
  const cpMod = await import(join(root, "services/control-plane/src/index.ts"));
  const pair = (k, what) => {
    if (!k?.kid || !k?.private_key_file) fail(`缺少 ${what}.kid / ${what}.private_key_file`);
    const privateKey = createPrivateKey(read(k.private_key_file, `${what}.private_key_file`));
    return { kid: String(k.kid), privateKey, publicKey: createPublicKey(privateKey) };
  };
  const stateKey = secretFile(cfg.state_key_file, "state_key_file", "hex32");
  const dir = dataDir("control-plane");
  svc = cpMod.createControlPlane({
    keys: { envelope: pair(cfg.envelope_key, "envelope_key"), seat: pair(cfg.seat_key, "seat_key") },
    serviceSecret: serviceSecret(),
    stateStore: cpMod.fileStateStore(join(dir, "state"), { key: Buffer.from(stateKey, "hex"), requireKey: true }),
    // 开通码 HMAC 的胡椒（复核 A-06/A-15）：与签名密钥分开，由 KMS 挂载；生产入口必填（按信封私钥派生会让信封密钥轮换时在途码全部失效）
    codePepper: Buffer.from(secretFile(cfg.code_pepper_file, "code_pepper_file", "hex32"), "hex"),
    auditLog: cpMod.createAuditLog({ file: join(dir, "audit.jsonl") }),
    // 运营接口（A-10）：写操作照常进律所可见的运营审计流水（执行者为运营编号）；每个运营请求另记内部访问审计
    ...(opsGuard ? { opsGuard, opsAccessLog: (r) => appendFileSync(join(dir, "ops", "access.jsonl"), `${JSON.stringify(r)}\n`, { mode: 0o600 }) } : {}),
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
    const meterKey = secretFile(cfg.meter_key_file, "meter_key_file", "hex32");
    svc = sa.createSupportApi({ dir: dataDir("support"), keys: seatKeys, meterKey: Buffer.from(meterKey, "hex"), feed, ...(opsGuard ? { opsGuard } : {}) });
  } else if (cfg.role === "notify") {
    const na = await import(join(root, "services/notify-api/src/index.ts"));
    svc = na.createNotifyApi({ dir: dataDir("notify"), keys: seatKeys, feed, ...(opsGuard ? { opsGuard } : {}) });
  } else {
    const ra = await import(join(root, "services/relay-api/src/index.ts"));
    svc = ra.createRelayApi({ dir: dataDir("relay"), keys: seatKeys, feed, ...(opsGuard ? { opsGuard } : {}) });
  }
}

// 可观测性（A-9）：访问日志与指标包住服务的请求处理；健康检查由入口应答；进程级异常只记代码
const logDir = typeof cfg.log_dir === "string" && cfg.log_dir ? cfg.log_dir : typeof cfg.data_dir === "string" && cfg.data_dir ? join(cfg.data_dir, "obs") : null;
if (!logDir) fail("缺少 log_dir 或 data_dir（访问日志与错误日志的位置）");
mkdirSync(logDir, { recursive: true, mode: 0o700 });
const obs = createObs({ role: cfg.role, dir: logDir, retentionDays: Number.isInteger(cfg.log_retention_days) ? cfg.log_retention_days : 190, feed, certPem: tls?.cert ?? null });
obs.prune();
setInterval(() => obs.prune(), 6 * 3600_000).unref();
for (const ev of ["uncaughtException", "unhandledRejection"]) {
  process.on(ev, (e) => {
    obs.recordError(ev === "uncaughtException" ? "uncaught" : "unhandled_rejection", e);
    process.exit(1);
  });
}

// 同一个请求处理函数挂到 HTTPS 服务上（服务模块不变；定时器随原服务对象的 close 事件清理）
const handlers = svc.listeners("request");
const handle = obs.wrap((req, res) => {
  // 运营路径只对运维网段开放（A-10；堡垒机本身依赖云选型，D-106）：其他来源与未配置运营接口时一律 404，不进服务
  if (opsPathBlocked(req)) {
    res.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end('{"error":"not_found"}');
    return;
  }
  handlers.forEach((h) => h(req, res));
});
let server = svc;
if (tls) server = createHttpsServer(tls, handle);
else {
  svc.removeAllListeners("request");
  svc.on("request", handle);
}
// 服务器级参数（复核 A-15）：不再全用 Node 缺省——压低慢速连接与连接耗尽的风险；大包上传的角色放宽整请求时限
server.headersTimeout = 20_000;
server.requestTimeout = ["relay", "dist", "support"].includes(cfg.role) ? 300_000 : 60_000;
server.keepAliveTimeout = 5_000;
server.maxConnections = Number.isInteger(cfg.max_connections) && cfg.max_connections > 0 ? cfg.max_connections : 10_000;
// 畸形请求：回 400 后断开，不打印请求内容
server.on("clientError", (_err, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  else socket.destroy();
});
await new Promise((ok, no) => {
  server.once("error", no);
  server.listen(port, host, ok);
});
// 指标监听（A-9）：只有计数与时效；监听回环以外的地址必须带令牌
let metricsServer = null;
if (cfg.metrics) {
  const mHost = String(cfg.metrics.host ?? "127.0.0.1");
  const mPort = Number(cfg.metrics.port);
  if (!Number.isInteger(mPort) || mPort < 0 || mPort > 65535) fail("metrics.port 不合法");
  const loopback = mHost === "127.0.0.1" || mHost === "::1" || mHost === "localhost";
  const token = cfg.metrics.token_file ? secretFile(cfg.metrics.token_file, "metrics.token_file", "random32") : null;
  if (!loopback && !token) fail("指标监听在回环以外的地址时必须配置 metrics.token_file");
  metricsServer = createHttpServer(obs.metricsHandler(token));
  await new Promise((ok, no) => {
    metricsServer.once("error", no);
    metricsServer.listen(mPort, mHost, ok);
  });
}
console.log(`[cloud-serve] ${cfg.role} 已就绪（${tls ? "https" : "http 仅测试"} ${host}:${server.address().port}${metricsServer ? `；指标 ${metricsServer.address().port}` : ""}）`);
const stop = () => {
  feed?.stop?.();
  metricsServer?.close();
  server.close(() => {
    if (server !== svc) svc.emit("close");
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
