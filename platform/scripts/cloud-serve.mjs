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
 * { "role": "control-plane|cp-signer|gateway|search|dist|support|notify|relay",
 *   "listen": { "host": "0.0.0.0", "port": 8443 },
 *   "tls": { "cert_file": "...", "key_file": "..." },
 *   "service_secret_file": "...",                         // 服务间凭据（G1 改 mTLS）；至少 32 字节随机：64 位以上十六进制或 43 位以上 base64url
 *   "max_connections": 10000,                             // 可选：并发连接上限（缺省 10000）
 *   "control_plane": { "url": "https://cp...", "keys_file": "cp-public-keys.json" },   // 订阅吊销集（控制面以外的角色）
 *   "seat_keys_file": "seat-public-keys.json",          // 席位令牌验签公钥（控制面以外的角色）
 *   "data_dir": "...",                                  // 分发、支持、通知、中继的存储根；控制面的状态与审计也放这里
 *   // 控制面（v9.3 A-8：控制面进程不持签名私钥，配了 envelope_key / seat_key 即拒绝启动；一律经签名服务）：
 *   "signer": { "url": "https://cp-signer:8443", "client_cert_file": "...", "client_key_file": "...", "ca_file": "...", "servername": "cp-signer" },
 *   "state_key_file": "...",                             // 32 字节十六进制
 *   // 可选（A-7 一主多备）：状态存 PostgreSQL、防重放随机数存 Redis；不配即单实例文件（<data_dir>/control-plane/state.1/.2）
 *   "state_store": { "kind": "postgres", "url": "postgres://kwl_cp@db.internal:5432/kwl", "password_file": "...", "ca_file": "...", "init": true },   // init 只在首次部署（空库）
 *   "nonce_store": { "kind": "redis", "url": "rediss://cache.internal:6379", "password_file": "...", "ca_file": "..." },
 *   "code_pepper_file": "...",                           // 开通码 HMAC 胡椒，32 字节十六进制（与签名密钥分开，KMS 挂载；复核 A-15 起必填）
 *   // 签名服务 cp-signer（A-8；签名区、无公网，只收控制面的 mTLS）：
 *   "environment": "prod",                              // 密钥编号须为 <用途>-<环境>-<编号>（cp-prod-2612a、seat-prod-2612a、seat-relay-prod-2612a）
 *   "init_ledger": true,                                // 只在首次部署：签名账不存在时新建；之后账本不在即拒绝启动
 *   "ledger_archive": { "kind": "s3", ... , "kms_key_id": "..." },   // 可选：签名账外送 WORM 桶（外部锚点；字段同 blob_store，prefix 缺省 signer-ledger）
 *   "tls": { "cert_file": "...", "key_file": "...", "client_ca_file": "..." },   // 只认这个 CA 签发的客户端证书
 *   "allowed_callers": ["spiffe://kwl/prod/cp-api"],    // 客户端证书的 URI SAN（或 CN）
 *   "keys": { "envelope": { "kid": "cp-prod-2612a", "private_key_file": "..." }, "seat": { "kid": "seat-prod-2612a", "private_key_file": "..." },
 *             "seat_audiences": { "support": { ... }, "notify": { ... }, "relay": { ... } } },   // 席位密钥按受众拆分；缺的受众用通用席位密钥
 *   // 网关 / 检索：
 *   "upstream": { "base_url": "https://api.moonshot.cn/v1", "api_key_file": "..." },
 *   "content_safety_policy_file": "...",                 // 网关可选
 *   // 支持：
 *   "meter_key_file": "...",
 *   "blob_store": { "kind": "s3", "endpoint": "https://obs.cn-north-4.myhuaweicloud.com", "bucket": "kwl-prod-support", "region": "cn-north-4", "prefix": "support",
 *                   "access_key_id_file": "...", "secret_access_key_file": "...", "kms_key_id": "...", "ca_file": "..." },   // 可选（A-11）：诊断包本体进对象存储，每个对象 SSE-KMS
 *   // 运营接口（控制面、支持、中继、通知可选；v9.3 A-10 按人鉴权，共享运营口令 ops_secret_file 已停用、配了即拒绝启动）：
 *   "ops": { "deployment": "prod",                              // 部署标识：名册与运营请求签名都绑定它
 *            "roster_file": "/etc/kwl/ops-roster.json",          // 安全管理员签名的运营名册（每人的签名公钥、权限、状态；换文件即生效，至多 31 天须重签）
 *            "roster_keys_file": "/etc/kwl/ops-roster-keys.json", // 名册签名公钥 { kid: PEM }（只收公钥）
 *            "allow_cidrs": ["10.20.0.0/24"],                     // 运维网段（堡垒机出口）：来源不在其中的运营请求一律 404
 *            "min_roster_version": 12 } }                         // 可选：新实例或数据目录重建时的名册版本下限
 * 没有 ops：运营路径一律 404。名册版本记录、换版记录、随机数与被拒记录在 <data_dir>/<角色>/ops/；名册不可用时业务照常、运营接口 503。
 * 全部密钥文件除格式外还核“是不是随机生成的”（scripts/lib/secret-strength.mjs：拒绝重复、递增、单一字符类、占位词）；服务间凭据同一要求。
 *
 * 可观测性（v9.3 A-9；scripts/lib/obs.mjs）：每个角色都写访问日志与错误日志（按白名单、不记内容，`log_dir` 缺省为 `<data_dir>/obs`，必须有其一），
 * 保留 `log_retention_days` 天（缺省 190）；/healthz 与 /readyz 由入口应答；指标另起监听 `metrics`：
 *   "metrics": { "host": "127.0.0.1", "port": 9464, "token_file": "..." }   // 监听回环以外的地址必须给令牌（至少 32 字节随机）
 */
import { createPrivateKey, createPublicKey, hkdfSync, randomBytes } from "node:crypto";
import { hostname } from "node:os";
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
const ROLES = ["control-plane", "cp-signer", "gateway", "search", "dist", "support", "notify", "relay"];
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
// 签名服务只收 mTLS：客户端证书必须由 client_ca_file 签发（握手层拒绝），再按 allowed_callers 核对身份（A-8）
if (cfg.role === "cp-signer" && tls) Object.assign(tls, { ca: read(cfg.tls.client_ca_file, "tls.client_ca_file"), requestCert: true, rejectUnauthorized: true });
// 公钥表 { kid: PEM }：只收公钥（复核 RA10A-01 / RA10B-01：createPublicKey 也接受私钥 PEM，私钥放错位置要拒绝）；读不出、不是 JSON、PEM 不合法一律拒绝启动（RA10B-21）
const pubMap = (file, what) => {
  let raw;
  try {
    raw = JSON.parse(read(file, what));
  } catch {
    fail(`${what} 不是 JSON`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`${what} 须为 { 密钥编号: 公钥 PEM }`);
  const m = new Map();
  for (const [kid, pem] of Object.entries(raw)) {
    const s = String(pem);
    if (/PRIVATE/i.test(s) || !/-----BEGIN PUBLIC KEY-----/.test(s)) fail(`${what} 里的 ${kid} 不是公钥（只能放公钥，私钥不得放到服务上）`);
    try {
      m.set(kid, createPublicKey(s));
    } catch {
      fail(`${what} 里的 ${kid} 不是合法的公钥`);
    }
  }
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
/** 启动时名册不可用的原因（不拒绝启动，只让运营接口 503；可观测性建好后记一条错误日志）。 */
let opsStartupProblem = null;
/** 运营网段的合理性（复核 RA10A-10）：前缀不短于 IPv4 /8、IPv6 /32，合计覆盖不超过一个 /8（/32）；生产形态不许回环、未指定与链路本地地址。 */
const FORBIDDEN_V4 = [["127.0.0.0", 8], ["0.0.0.0", 8], ["169.254.0.0", 16]];
const FORBIDDEN_V6 = [["::1", 128], ["::", 128], ["fe80::", 10]];
if (cfg.ops !== undefined) {
  if (!OPS_AUDIENCE[cfg.role]) fail(`${cfg.role} 没有运营接口，不要配置 ops`);
  const c = cfg.ops ?? {};
  if (typeof c.roster_file !== "string" || !c.roster_file) fail("缺少 ops.roster_file（运营名册）");
  if (typeof c.deployment !== "string" || !opsMod.OPS_DEPLOYMENT_RE.test(c.deployment)) fail("缺少 ops.deployment（部署标识，例如 prod；名册与运营请求都绑定它）");
  if (c.min_roster_version !== undefined && !(Number.isSafeInteger(c.min_roster_version) && c.min_roster_version >= 1)) fail("ops.min_roster_version 须为正整数");
  const rosterKeys = pubMap(c.roster_keys_file, "ops.roster_keys_file");
  if (!Array.isArray(c.allow_cidrs) || c.allow_cidrs.length === 0) fail("ops.allow_cidrs 须列出运维网段（堡垒机出口地址）");
  opsSources = new BlockList();
  const forbidden = new BlockList();
  for (const [a, n] of FORBIDDEN_V4) forbidden.addSubnet(a, n, "ipv4");
  for (const [a, n] of FORBIDDEN_V6) forbidden.addSubnet(a, n, "ipv6");
  let cover4 = 0n;
  let cover6 = 0n;
  for (const x of c.allow_cidrs) {
    const [addr, bits, extra] = String(x).split("/");
    const v4 = isIPv4(addr ?? "");
    if (!v4 && !isIPv6(addr ?? "")) fail(`ops.allow_cidrs 里的 ${x} 不是网段`);
    const max = v4 ? 32 : 128;
    const min = v4 ? 8 : 32;
    const n = bits === undefined ? max : Number(bits);
    // 不许“全部来源”及过宽的网段（含用两个 /1 拼出全部来源）：运营接口只对运维网段开放
    if (extra !== undefined || !Number.isInteger(n) || n < min || n > max) fail(`ops.allow_cidrs 里的 ${x} 前缀长度不合法（${min}–${max}）`);
    const one = new BlockList();
    one.addSubnet(addr, n, v4 ? "ipv4" : "ipv6");
    const hitsForbidden = forbidden.check(addr, v4 ? "ipv4" : "ipv6") || (v4 ? FORBIDDEN_V4 : FORBIDDEN_V6).some(([fa]) => one.check(fa, v4 ? "ipv4" : "ipv6"));
    if (hitsForbidden && !insecure) fail(`ops.allow_cidrs 里的 ${x} 含回环、未指定或链路本地地址（前置代理、边车的地址都不得列入）`);
    if (v4) cover4 += 1n << BigInt(32 - n);
    else cover6 += 1n << BigInt(128 - n);
    opsSources.addSubnet(addr, n, v4 ? "ipv4" : "ipv6");
  }
  if (cover4 > 1n << 24n || cover6 > 1n << 96n) fail("ops.allow_cidrs 合计覆盖过宽（IPv4 不超过一个 /8，IPv6 不超过一个 /32）");
  const opsDir = join(dataDir(cfg.role), "ops");
  mkdirSync(opsDir, { recursive: true, mode: 0o700 });
  // 名册状态（缺失、签名不符、回滚、过期、版本记录损坏）不拒绝启动：业务照常，运营接口 503（复核 RA10A-03：回滚保护不能成为停服开关）
  const roster = opsMod.fileRosterSource({ file: c.roster_file, keys: rosterKeys, deployment: c.deployment, seenFile: join(opsDir, "roster-seen.json"), historyFile: join(opsDir, "roster-history.jsonl"), ...(c.min_roster_version !== undefined ? { minVersion: c.min_roster_version } : {}) });
  const first = roster.current();
  if (!first.ok) {
    opsStartupProblem = first.reason;
    console.error(`[cloud-serve] 运营名册不可用（${first.reason}）：运营接口暂停，业务照常`);
  }
  opsGuard = opsMod.createOpsGuard({
    audience: OPS_AUDIENCE[cfg.role],
    roster,
    nonces: opsMod.fileNonceStore(join(opsDir, "nonces.jsonl")),
    // 被拒的运营请求：签名核验通过之后的一律记，未核验的每分钟至多 60 条（超出的补记条数）；claimed 未经核验
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

/** 对象存储配置（S3 兼容；每对象 SSE-KMS，kms_key_id 必填）：启动时列一次，连不上即拒绝启动。 */
async function blobStoreFrom(bs, what, defaultPrefix) {
  if (bs?.kind !== "s3") fail(`${what}.kind 只支持 s3`);
  if (typeof bs.kms_key_id !== "string" || !bs.kms_key_id) fail(`${what}.kms_key_id 必填（每个对象服务端加密 SSE-KMS）`);
  const blobMod = await import(join(root, "packages/blob-store/src/index.ts"));
  let store;
  try {
    store = blobMod.s3BlobStore({
      endpoint: String(bs.endpoint ?? ""),
      bucket: String(bs.bucket ?? ""),
      region: String(bs.region ?? ""),
      prefix: typeof bs.prefix === "string" && bs.prefix ? bs.prefix : defaultPrefix,
      credentials: { accessKeyId: read(bs.access_key_id_file, `${what}.access_key_id_file`), secretAccessKey: read(bs.secret_access_key_file, `${what}.secret_access_key_file`) },
      sse: { kmsKeyId: bs.kms_key_id },
      ...(bs.ca_file ? { ca: read(bs.ca_file, `${what}.ca_file`) } : {}),
      allowInsecureForTest: insecure,
    });
  } catch (e) {
    fail(`${what} 配置不合规（${e?.message ?? "格式"}）`);
  }
  // 连通性探测只列一个不存在的前缀（不全量列举，复核 RC-A-07）
  try {
    await store.list("__probe__/");
  } catch (e) {
    fail(`连不上对象存储（${e?.code ?? "unreachable"}）`);
  }
  return store;
}

let serviceMetrics = null;
let readyCheck = null;
/** 停机前要做完的事（限时；如签名账外送补送尾巴，复核 RC-A-02）。 */
const stopHooks = [];
let cpInstance = null;
if (cfg.role === "cp-signer") {
  // ─── 签名服务（A-8）：私钥只在这里；只签登记过的种类与合格的文档，签名账记不进去就不签 ───
  const env = String(cfg.environment ?? "");
  if (!/^(prod|stg|dev|test)$/.test(env)) fail("environment 须为 prod / stg / dev / test（密钥编号按环境区分）");
  if (cfg.control_plane || cfg.service_secret_file || cfg.ops) fail("签名服务不订阅吊销集、不用服务间凭据、没有运营接口：删去 control_plane / service_secret_file / ops");
  const callers = Array.isArray(cfg.allowed_callers) ? cfg.allowed_callers.map(String).filter((x) => /^(spiffe:\/\/[A-Za-z0-9._\/-]{1,200}|[A-Za-z0-9._-]{1,64})$/.test(x)) : [];
  if (!insecure && (callers.length === 0 || callers.length !== cfg.allowed_callers.length)) fail("allowed_callers 须列出控制面的客户端证书身份（spiffe://… 或 CN）");
  const kidRe = new RegExp(`^(cp|seat|seat-support|seat-notify|seat-relay)-${env}-[0-9a-z]{1,16}$`);
  const seen = new Set();
  const signPair = (k, what, use) => {
    if (!k?.kid || !k?.private_key_file) fail(`缺少 ${what}.kid / ${what}.private_key_file`);
    const kid = String(k.kid);
    if (!kidRe.test(kid) || !kid.startsWith(`${use}-`)) fail(`${what}.kid 须为 ${use}-${env}-<编号>（密钥编号按用途与环境区分，云端持久化与 KMS 设计 §4.5）`);
    if (seen.has(kid)) fail(`密钥编号重复：${kid}`);
    seen.add(kid);
    let privateKey;
    try {
      privateKey = createPrivateKey(read(k.private_key_file, `${what}.private_key_file`));
    } catch {
      fail(`${what}.private_key_file 不是合法的私钥`);
    }
    if (privateKey.asymmetricKeyType !== "ed25519") fail(`${what} 须为 Ed25519 私钥`);
    return { kid, privateKey, publicKey: createPublicKey(privateKey) };
  };
  const ks = cfg.keys ?? {};
  const audiences = {};
  for (const a of ["support", "notify", "relay"]) if (ks.seat_audiences?.[a]) audiences[a] = signPair(ks.seat_audiences[a], `keys.seat_audiences.${a}`, `seat-${a}`);
  const signerMod = await import(join(root, "services/cp-signer/src/index.ts"));
  // 签名账外送（复核 RB16A-01 余项）：配了 ledger_archive 即启动时与已外送的比对（本机账本被截尾、换成旧副本或改过即拒绝启动），之后按批外送
  const ledgerFile = join(dataDir("cp-signer"), "ledger.jsonl");
  let archiver;
  // 生产形态必须配外送（复核 RC-A-03：漏配即没有外部锚点，截尾发现不了）
  if (env === "prod" && cfg.ledger_archive === undefined) fail("生产形态（environment = prod）必须配置 ledger_archive（签名账外送）");
  if (cfg.ledger_archive !== undefined) {
    if (cfg.blob_store !== undefined && cfg.ledger_archive.bucket === cfg.blob_store.bucket) fail("ledger_archive 不得与 blob_store 共用一个桶（诊断包桶有到期规则）");
    const store = await blobStoreFrom(cfg.ledger_archive, "ledger_archive", "signer-ledger");
    // 外送桶须开版本控制与对象锁、没有作用于外送前缀的到期规则（复核 RC-A-01）；读不到配置也拒绝启动
    // 只有本机回环测试形态（假对象存储）可以跳过这一步
    let guards = null;
    try {
      guards = await store.guards();
    } catch (e) {
      if (!insecure) fail(`读不到签名账外送桶的配置（${e?.code ?? "unreachable"}）`);
    }
    if (guards) {
      const blobMod = await import(join(root, "packages/blob-store/src/index.ts"));
      const problems = blobMod.archiveGuardProblems(guards, `${store.keyPrefix ?? ""}signer-ledger/`);
      if (problems.length && !insecure) fail(`签名账外送桶不合要求：${problems.join("；")}`);
    }
    const { existsSync } = await import("node:fs");
    const text = existsSync(ledgerFile) ? readFileSync(ledgerFile, "utf8") : "";
    let chk;
    try {
      chk = await signerMod.checkLedgerAgainstArchive(text, store);
    } catch (e) {
      fail(`签名账外送位置读不出（${e?.code ?? "unreachable"}）`);
    }
    if (!chk.ok) fail(`签名账与已外送的对不上：${chk.reason}`);
    // 从账本文件读待外送的行：上次没送出去的尾巴启动即补送（复核 RC-A-02）
    const maxPending = Number.isInteger(cfg.ledger_archive.max_pending) && cfg.ledger_archive.max_pending > 0 ? cfg.ledger_archive.max_pending : undefined;
    archiver = signerMod.startLedgerArchiver({ archive: store, ledgerFile, start: { seq: chk.archivedSeq, hash: chk.archivedHash, offset: chk.archivedOffset }, headSeq: chk.localSeq, ...(maxPending ? { maxPending } : {}) });
  }
  stopHooks.push(() => archiver?.stop(5_000));
  const signer = signerMod.createSignerService({
    ...(archiver ? { archiver } : {}),
    keys: { envelope: signPair(ks.envelope, "keys.envelope", "cp"), seat: signPair(ks.seat, "keys.seat", "seat"), seatAudiences: audiences },
    ledgerFile,
    // 首次部署显式初始化签名账（"init_ledger": true）；之后账本不在即拒绝启动（复核 RB16A-01：整本删除也能发现）
    initLedger: cfg.init_ledger === true,
    allowedCallers: callers,
    insecureForTest: insecure,
  });
  svc = signer.server;
  // 签名速率（A-9 余项）：按操作、种类、结果计数；告警规则对照 7 日基线
  serviceMetrics = () => {
    const values = Object.entries(signer.metrics().counts).map(([k, n]) => {
      const [op, kind = "-", result = "-"] = k.split("/");
      return [{ op, kind, result }, n];
    });
    const lg = signer.metrics().ledger;
    return [
      { name: "kwl_signer_requests_total", help: "签名与拒签次数（按操作、种类、结果）", type: "counter", values },
      // 签名账末行序号（外部锚点：监控系统记下的序号只增不减，变小即账本被截尾；复核 RB16A-01）与是否已损坏
      { name: "kwl_signer_ledger_seq", help: "签名账末行序号（只增不减；变小即被截尾）", type: "gauge", values: [[{}, lg.seq]] },
      { name: "kwl_signer_ledger_broken", help: "签名账写入失败且截不回去（1 = 已停签）", type: "gauge", values: [[{}, lg.broken ? 1 : 0]] },
      { name: "kwl_signer_ledger_archive_configured", help: "签名账外送是否配置（0 = 没有外部锚点）", type: "gauge", values: [[{}, signer.metrics().archive ? 1 : 0]] },
      ...(signer.metrics().archive
        ? [
            { name: "kwl_signer_ledger_archived_seq", help: "签名账已外送到的序号", type: "gauge", values: [[{}, signer.metrics().archive.archived_seq]] },
            { name: "kwl_signer_ledger_archive_pending", help: "签名账待外送行数（积压过多即停签）", type: "gauge", values: [[{}, signer.metrics().archive.pending]] },
            { name: "kwl_signer_ledger_archive_conflict", help: "外送位置的对象与本机账本不符（1 = 已停签待查）", type: "gauge", values: [[{}, signer.metrics().archive.conflict ? 1 : 0]] },
          ]
        : []),
    ];
  };
} else if (cfg.role === "control-plane") {
  const cpMod = await import(join(root, "services/control-plane/src/index.ts"));
  // 控制面进程不持签名私钥（A-8）：信封与席位令牌一律经签名服务；ops.seal 在这一形态下不可用
  if (cfg.envelope_key || cfg.seat_key) fail("控制面进程不得持有签名私钥（v9.3 A-8）：删去 envelope_key / seat_key，改为配置 signer 指向签名服务 cp-signer");
  const sc = cfg.signer ?? fail("缺少 signer（签名服务地址与 mTLS 客户端证书）");
  if (!insecure && !String(sc.url ?? "").startsWith("https://")) fail("signer.url 须为 https://（mTLS）");
  let signer;
  try {
    signer = await cpMod.connectRemoteSigner({
      url: String(sc.url),
      ...(insecure && String(sc.url).startsWith("http://127.0.0.1")
        ? { insecureLoopbackForTest: true }
        : { tls: { cert: read(sc.client_cert_file, "signer.client_cert_file"), key: read(sc.client_key_file, "signer.client_key_file"), ca: read(sc.ca_file, "signer.ca_file"), ...(sc.servername ? { servername: String(sc.servername) } : {}) } }),
    });
  } catch (e) {
    fail(`连不上签名服务或它的公钥表不合格（${e?.code ?? "unreachable"}）`);
  }
  const stateKey = secretFile(cfg.state_key_file, "state_key_file", "hex32");
  const dir = dataDir("control-plane");
  // 状态库（A-7）：PostgreSQL 一主多备——等成为主实例之后才对外服务；不配即单实例文件
  let stateStore;
  let nonceMirror;
  if (cfg.state_store !== undefined) {
    const ss = cfg.state_store;
    if (ss?.kind !== "postgres") fail("state_store.kind 只支持 postgres");
    const pw = secretFile(ss.password_file, "state_store.password_file", "random32");
    let conn;
    if (insecure && typeof ss.socket_dir === "string") conn = { socketDir: ss.socket_dir, port: Number(ss.port ?? 5432), user: String(ss.user ?? ""), database: String(ss.database ?? "postgres"), password: pw };
    else {
      let u;
      try {
        u = cpMod.parsePgUrl(String(ss.url ?? ""));
      } catch {
        fail("state_store.url 须为 postgres://用户@主机:端口/库（口令放 password_file）");
      }
      if (u.password) fail("state_store.url 里不要写口令（放 password_file）");
      conn = { ...u, password: pw, tls: { ca: read(ss.ca_file, "state_store.ca_file") } };
    }
    console.log(`[cloud-serve] control-plane 正在等待成为主实例（状态库 PostgreSQL）`);
    try {
      stateStore = await cpMod.openPgStateStore({ pg: conn, key: Buffer.from(stateKey, "hex"), holder: `${hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`, initEmpty: ss.init === true });
    } catch (e) {
      fail(`连不上状态库或等待主实例失败（${e?.code ?? "unreachable"}）`);
    }
    if (cfg.nonce_store !== undefined) {
      const ns = cfg.nonce_store;
      if (ns?.kind !== "redis") fail("nonce_store.kind 只支持 redis");
      const rpw = secretFile(ns.password_file, "nonce_store.password_file", "random32");
      let ro;
      if (insecure && typeof ns.socket_path === "string") ro = { socketPath: ns.socket_path, password: rpw };
      else {
        let u;
        try {
          u = cpMod.parseRedisUrl(String(ns.url ?? ""));
        } catch {
          fail("nonce_store.url 须为 rediss://主机:端口（口令放 password_file）");
        }
        if (!u.tls) fail("nonce_store.url 须为 rediss://（TLS）");
        if (u.password) fail("nonce_store.url 里不要写口令（放 password_file）");
        ro = { host: u.host, port: u.port, ...(u.username ? { username: u.username } : {}), password: rpw, tls: { ca: read(ns.ca_file, "nonce_store.ca_file") } };
      }
      // Redis 连不上不拒绝启动（复核 RB16A-09）：照常服务、降级为状态快照里的随机数，计失败并按需重连；键名为 HMAC（密钥由状态封装密钥派生）
      nonceMirror = await cpMod.openRedisNonceMirror({ redis: ro, hmacKey: Buffer.from(hkdfSync("sha256", Buffer.from(stateKey, "hex"), Buffer.alloc(0), "kwl-cp-nonce-mirror/1", 32)) });
      if (!nonceMirror.stats().connected) console.error("[cloud-serve] 防重放随机数镜像（Redis）暂时连不上：照常服务，按需重连");
    }
  } else {
    if (cfg.nonce_store !== undefined) fail("nonce_store 只用于一主多备（须同时配置 state_store）");
    stateStore = cpMod.fileStateStore(join(dir, "state"), { key: Buffer.from(stateKey, "hex"), requireKey: true });
  }
  if (stateStore.healthy) {
    // 失去主实例身份（连接断、被围栏）：退出进程，由编排重启后重新参加选主（不在不确定的状态上继续服务）
    readyCheck = () => (stateStore.healthy() ? true : "state_store_lost");
    setInterval(() => {
      if (!stateStore.healthy()) {
        console.error("[cloud-serve] 控制面失去主实例身份或状态库连接，退出");
        process.exit(1);
      }
    }, 5_000).unref();
    serviceMetrics = () => {
      const st = stateStore.stats();
      const nm = nonceMirror?.stats();
      return [
        { name: "kwl_cp_state_saves_total", help: "控制面状态写入次数（按结果）", type: "counter", values: [[{ result: "ok" }, st.saves], [{ result: "failed" }, st.failures]] },
        ...(nm ? [{ name: "kwl_cp_nonce_mirror_total", help: "防重放随机数写入 Redis（按结果）", type: "counter", values: [[{ result: "ok" }, nm.recorded], [{ result: "failed" }, nm.failures]] }] : []),
      ];
    };
  }
  const storeMetrics = serviceMetrics;
  cpInstance = cpMod.createControlPlane({
    signer,
    serviceSecret: serviceSecret(),
    stateStore,
    ...(nonceMirror ? { nonceMirror } : {}),
    // 开通码 HMAC 的胡椒（复核 A-06/A-15）：与签名密钥分开，由 KMS 挂载；生产入口必填（按信封私钥派生会让信封密钥轮换时在途码全部失效）
    codePepper: Buffer.from(secretFile(cfg.code_pepper_file, "code_pepper_file", "hex32"), "hex"),
    auditLog: cpMod.createAuditLog({ file: join(dir, "audit.jsonl") }),
    // 运营接口（A-10）：写操作照常进律所可见的运营审计流水（执行者为运营编号）；每个运营请求另记内部访问审计
    ...(opsGuard ? { opsGuard, opsAccessLog: (r) => opsMod.appendLineSynced(join(dir, "ops", "access.jsonl"), r) } : {}),
  });
  svc = cpInstance.server;
  // 额度租约指标（A-9 余项）与状态库指标并列
  serviceMetrics = () => [
    ...(storeMetrics ? storeMetrics() : []),
    { name: "kwl_cp_quota_leases_total", help: "额度租约（按结果：发放、受限、拒发原因、回报）", type: "counter", values: Object.entries(cpInstance.metrics().quota).map(([k, n]) => [{ result: k.replace(":", "_") }, n]) },
    // 客户端版本分布（v9.3 P3）：30 天内报到过、未吊销的设备数；轮换签名密钥前看旧版本占比
    { name: "kwl_cp_client_devices", help: "活跃设备按客户端版本（30 天内报到、未吊销）", type: "gauge", values: Object.entries(cpInstance.metrics().client_versions).map(([v, n]) => [{ version: v }, n]) },
  ];
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
  // 席位公钥表按角色只放该受众的密钥（复核 RB16A-16）：通用服务（网关、检索、分发）不许放受众密钥；支持、通知、中继不许放别的受众的密钥——
  // 否则一把受众密钥泄露后可签出被别的服务接受的令牌，按受众拆分就失去意义（密钥编号形如 seat-<受众>-<环境>-<编号>，签名服务强制）
  const ROLE_AUD = { support: "support", notify: "notify", relay: "relay" };
  for (const kid of seatKeys.keys()) {
    const aud = /^seat-(support|notify|relay)-/.exec(kid)?.[1] ?? null;
    if (aud && aud !== ROLE_AUD[cfg.role]) fail(`seat_keys_file 里的 ${kid} 是“${aud}”受众的席位公钥，${cfg.role} 不能信任它（每个服务只放自己受众的公钥）`);
  }
  if (cfg.role === "gateway") {
    const gw = await import(join(root, "services/legal-gateway/src/index.ts"));
    if (!cfg.upstream?.api_key_file) fail("网关只接真实上游：缺少 upstream.api_key_file");
    const provider = new gw.MoonshotProvider({ apiKey: read(cfg.upstream.api_key_file, "upstream.api_key_file"), ...(cfg.upstream.base_url ? { baseUrl: String(cfg.upstream.base_url) } : {}) });
    const quota = new gw.LeaseQuota({ ledger: gw.httpLedger({ baseUrl: String(cfg.control_plane.url).replace(/\/+$/, ""), serviceSecret: serviceSecret() }), holder: `gw-${host}-${port}` });
    const contentSafety = cfg.content_safety_policy_file ? new gw.ContentSafety(JSON.parse(read(cfg.content_safety_policy_file, "content_safety_policy_file"))) : undefined;
    const gateway = gw.createLegalGateway({ keys: seatKeys, provider, routes: gw.routesFromEnv(process.env), meter: gw.fileMeter(join(dataDir("gateway"), "meter.jsonl")), quota, feed, ...(contentSafety ? { contentSafety } : {}) });
    svc = gateway;
    // 上游状态（429 单列）与网关自己的拒绝原因（额度、排队超时等）（A-9 余项）
    serviceMetrics = () => {
      const m = gateway.metrics();
      return [
        { name: "kwl_gateway_upstream_responses_total", help: "上游回复（按状态类别，429 单列；error = 没有回复）", type: "counter", values: Object.entries(m.upstream).map(([c, n]) => [{ code_class: c }, n]) },
        { name: "kwl_gateway_rejects_total", help: "网关拒绝（按原因代码）", type: "counter", values: Object.entries(m.rejects).map(([c, n]) => [{ reason: c }, n]) },
      ];
    };
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
    // 诊断包本体进对象存储（A-11）：每个对象 SSE-KMS（不带密钥编号即拒绝启动）；启动时列一次，连不上即不服务
    let blobs;
    let lifecycleOk = null;
    if (cfg.blob_store !== undefined) {
      blobs = await blobStoreFrom(cfg.blob_store, "blob_store", "support");
      // 桶的生命周期规则是 7 天删除承诺的兜底（复核 RB16A-12）：须真有覆盖诊断包前缀、≤ 8 天到期（版本化桶还要删非当前版本）的规则（复核 RC-A-04）；没有就告警，不拒绝启动
      const blobMod = await import(join(root, "packages/blob-store/src/index.ts"));
      try {
        const g = await blobs.guards?.();
        lifecycleOk = !!g && blobMod.supportLifecycleOk(g, `${blobs.keyPrefix ?? ""}support/`, 8);
      } catch {
        lifecycleOk = false;
      }
      if (!lifecycleOk) console.error("[cloud-serve] 诊断包桶没有覆盖诊断包、8 天内到期的生命周期规则：7 天删除只靠服务清扫，请在 IaC 里配置");
    }
    const support = sa.createSupportApi({ dir: dataDir("support"), keys: seatKeys, meterKey: Buffer.from(meterKey, "hex"), feed, ...(blobs ? { blobs } : {}), ...(opsGuard ? { opsGuard } : {}) });
    svc = support;
    // 到期清扫（复核 RB16A-12）：删不掉的计失败；7 天删除承诺靠它与桶生命周期规则兜底
    serviceMetrics = () => {
      const m = support.metrics();
      return [
        { name: "kwl_support_sweep_failures_total", help: "诊断包到期清扫删不掉的次数", type: "counter", values: [[{}, m.sweep_failures]] },
        { name: "kwl_support_expired_total", help: "到期删除的诊断包", type: "counter", values: [[{}, m.expired]] },
        ...(lifecycleOk === null ? [] : [{ name: "kwl_support_bucket_lifecycle_ok", help: "诊断包桶有覆盖诊断包前缀、8 天内到期的生命周期规则（0 = 没有兜底删除）", type: "gauge", values: [[{}, lifecycleOk ? 1 : 0]] }]),
      ];
    };
  } else if (cfg.role === "notify") {
    const na = await import(join(root, "services/notify-api/src/index.ts"));
    const notify = na.createNotifyApi({ dir: dataDir("notify"), keys: seatKeys, feed, ...(opsGuard ? { opsGuard } : {}) });
    svc = notify;
    // 提醒投递（A-9 余项）：确认、暂缓次数；过触发时刻 15 分钟仍未确认的份数（投递积压告警）
    serviceMetrics = () => {
      const m = notify.metrics();
      return [
        { name: "kwl_notify_acks_total", help: "提醒确认收到的份数", type: "counter", values: [[{}, m.acks]] },
        { name: "kwl_notify_defers_total", help: "提醒暂缓的份数", type: "counter", values: [[{}, m.defers]] },
        { name: "kwl_notify_overdue_targets", help: "过触发时刻 15 分钟仍未确认的份数（含离线电脑，看趋势）", type: "gauge", values: [[{}, m.overdue_targets]] },
        { name: "kwl_notify_overdue_online_targets", help: "设备近 10 分钟拉取过却仍未确认的份数（投递积压告警用）", type: "gauge", values: [[{}, m.overdue_online_targets]] },
        { name: "kwl_notify_scheduled_targets", help: "尚未到时的接收设备份数", type: "gauge", values: [[{}, m.scheduled_targets]] },
      ];
    };
  } else {
    const ra = await import(join(root, "services/relay-api/src/index.ts"));
    svc = ra.createRelayApi({ dir: dataDir("relay"), keys: seatKeys, feed, ...(opsGuard ? { opsGuard } : {}) });
  }
}

// 可观测性（A-9）：访问日志与指标包住服务的请求处理；健康检查由入口应答；进程级异常只记代码
const logDir = typeof cfg.log_dir === "string" && cfg.log_dir ? cfg.log_dir : typeof cfg.data_dir === "string" && cfg.data_dir ? join(cfg.data_dir, "obs") : null;
if (!logDir) fail("缺少 log_dir 或 data_dir（访问日志与错误日志的位置）");
mkdirSync(logDir, { recursive: true, mode: 0o700 });
const obs = createObs({ role: cfg.role, dir: logDir, retentionDays: Number.isInteger(cfg.log_retention_days) ? cfg.log_retention_days : 190, feed, certPem: tls?.cert ?? null, serviceMetrics, ready: readyCheck });
obs.prune();
setInterval(() => obs.prune(), 6 * 3600_000).unref();
if (opsStartupProblem) obs.recordError("ops_roster", { code: opsStartupProblem });
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
const stop = async () => {
  feed?.stop?.();
  // 先限时做完停机前的事（签名账外送补送尾巴），再关服务
  await Promise.allSettled(stopHooks.map((h) => h()));
  metricsServer?.close();
  server.close(() => {
    if (server !== svc) svc.emit("close");
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
