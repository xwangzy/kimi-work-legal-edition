#!/usr/bin/env node
/**
 * 统一云端控制台本机开发（第 46 批）：先打包 dist/（scripts/build-console.mjs），再一条命令拉起“进程内控制面 + 控制台静态页”。
 * **只用于开发**：平台人员、律所、成员账号、套餐、上游都是本脚本经真实接口造的开发数据；价格是示例价格；网关路由密钥临时生成。
 *
 *   node scripts/dev-console.mjs [--port 5480] [--empty] [--no-usage]
 *
 * - 控制台与控制面同源（/v1/* 反向代理到进程内的控制面），不必配 CORS；静态页只发 dist/ 里的文件，CSP 与生产同口径；
 * - 平台人员用控制面的 devStaff 选项建（系统管理员、客户运营、财务），与生产同口径：邮箱 + 密码即登录（D-218 起没有第二步验证），
 *   密码每次启动随机生成并打印；不再有运营私钥与名册；危险操作的复核只要密码；
 * - 开发数据**只经控制面的真实接口写入**（客户运营与系统管理员的会话令牌，与浏览器同一条路）：开通律所、代建负责人账号
 *   （拿设置码经 /v1/auth/password-reset/confirm 设好密码，用来以律所管理员身份登录“本所”）、上游（密钥用临时路由公钥在本机加密）、
 *   别名路由、加量与上限、停用一个账号；第 62 批起另模拟网关回报近 30 日逐请求用量与上游健康（走网关同一条服务间接口，见
 *   seedGatewayReports；--no-usage 不造，用量页显示空状态）。--empty 只建平台人员。
 */
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildConsole } from "./build-console.mjs";

const args = process.argv.slice(2);
const PORT = Number(args[args.indexOf("--port") + 1]) || 5480;
const EMPTY = args.includes("--empty");
const NO_USAGE = args.includes("--no-usage");
const SERVICE_SECRET = "dev-console-service-secret-000";

const { createControlPlane, devControlPlaneKeys, UsageBook } = await import("../services/control-plane/src/index.ts");
const { sealUpstreamKey, keyHint } = await import("../apps/console/seal-key.js");

// ─── 打包 ───
const DIST = fileURLToPath(new URL("../apps/console/dist", import.meta.url));
buildConsole(DIST);

const dir = mkdtempSync(join(tmpdir(), "kwl-console-dev-"));
const pw = () => `Dev-${randomBytes(9).toString("base64url")}9`;
const STAFF = [
  { email: "admin@kwl-dev.example", name: "系统管理员（开发）", roles: ["sysadmin"], password: pw() },
  { email: "ops@kwl-dev.example", name: "客户运营（开发）", roles: ["operator"], password: pw() },
  { email: "finance@kwl-dev.example", name: "财务（开发）", roles: ["finance"], password: pw() },
];

// ─── 临时网关路由密钥（P-256）：公钥交给控制面随 GET /v1/ops/routing 下发；编号 = SPKI 字节 sha256 前 16 位十六进制 ───
const routingPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const spki = routingPair.publicKey.export({ format: "der", type: "spki" });
const ROUTING_PUB = Buffer.from(spki).toString("base64");
const ROUTING_KID = createHash("sha256").update(spki).digest("hex").slice(0, 16);

const cp = createControlPlane({
  keys: devControlPlaneKeys(),
  serviceSecret: SERVICE_SECRET,
  devStaff: STAFF,
  dataDir: join(dir, "cp"),
  opsAccessLog: () => {},
  opsInfo: { deployment: "dev" },
  usageBook: new UsageBook({ dir: join(dir, "usage") }),
  routing: {
    key_id: ROUTING_KID,
    public_key_spki: ROUTING_PUB,
    bootstrap: EMPTY
      ? undefined
      : {
          provider: { id: "csi-maas", label: "中软 MaaS（开发地址）", vendor: "csi-maas", base_url: "https://maas.example.invalid/v1" },
          models: { "legal/k3": "kimi-k3.1-pro", "legal/k2.6": "kimi-k3.1-pro-highspeed" },
          prices: { "legal/k3": { input: 8, cached_input: 2, output: 32, cost_input: 4, cost_cached_input: 1, cost_output: 16 } },
        },
  },
  // 示例套餐（正式套餐由商务写进控制面配置的 billing 段，或在控制台“套餐与额度”里改）
  billing: EMPTY
    ? undefined
    : {
        plans: [
          { id: "standard", label: "标准", quota_unit: "tokens", seat_quota: 20_000_000, period: "month", seat_price_cny: 399, boost_price_factor: 1, device_limit: 2, alert_thresholds: [80, 100], enforce_seat_quota: false, models: null, burst: null },
          { id: "pro", label: "专业", quota_unit: "cny", seat_quota: 300, period: "month", seat_price_cny: 799, boost_price_factor: 1, device_limit: 3, alert_thresholds: [80, 100], enforce_seat_quota: false, models: null, burst: { hours: 5, pct: 20 } },
          { id: "max", label: "旗舰", quota_unit: "tokens", seat_quota: 100_000_000, period: "month", seat_price_cny: 1599, boost_price_factor: 1.2, device_limit: 3, alert_thresholds: [50, 80, 100], enforce_seat_quota: true, models: null, burst: null },
        ],
        default_plan: "standard",
      },
});
await new Promise((r) => cp.server.listen(0, "127.0.0.1", () => r()));
const cpPort = cp.server.address().port;
const cpBase = `http://127.0.0.1:${cpPort}`;

// ─── 开发数据：只经真实接口（会话令牌 Bearer，与浏览器同一条路） ───
async function http(method, path, body, token) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const r = await fetch(cpBase + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(raw ? { "content-type": "application/json" } : {}) }, ...(raw ? { body: raw } : {}) });
  const json = await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error(`${method} ${path} → ${r.status} ${json?.error?.code ?? ""} ${json?.error?.message ?? ""}`), { code: json?.error?.code });
  return json;
}
const sessions = {};
async function login(who) {
  const r = await http("POST", "/v1/auth/login", { email: who.email, password: who.password, client: { platform: "web", version: "dev" } });
  if (!r.session_token) throw new Error(`${who.email} 登录没有拿到会话`);
  return r.session_token;
}
/** 危险操作要复核：遇 reauth_required 先 POST /v1/auth/reauth（只要密码）再重试一次 */
async function as(who, method, path, body) {
  sessions[who.email] ??= await login(who);
  try {
    return await http(method, path, body, sessions[who.email]);
  } catch (e) {
    if (e.code !== "reauth_required") throw e;
    await http("POST", "/v1/auth/reauth", { password: who.password }, sessions[who.email]);
    return http(method, path, body, sessions[who.email]);
  }
}
const [SYS, OPS] = STAFF;
const skipped = [];
const tryDo = async (label, fn) => {
  try {
    return await fn();
  } catch (e) {
    skipped.push(`${label}：${e.message}`);
    return null;
  }
};
const members = [];

if (!EMPTY) {
  // 律所（虚构名称；邮箱用保留域名 .example）。每家只代建负责人账号：控制面要求先完成创始开通才能建成员账号
  const firms = [
    { tid: "ten_chengming", name: "澄明律师事务所", plan: "pro", seats: 40, edition: "firm", boost: 25, members: [["chen.yu", "陈雨", "admin"]] },
    { tid: "ten_hengshi", name: "衡石律师事务所", plan: "max", seats: 120, edition: "firm", members: [["sun.li", "孙立", "admin"]] },
    { tid: "ten_qinghe", name: "青禾律师事务所", plan: "standard", seats: 8, edition: "team", cap: 60, members: [["feng.xi", "冯溪", "admin"]] },
    { tid: "ten_yuanlan", name: "远澜律师事务所", plan: "standard", seats: 15, edition: "team", accounts_required: false, members: [["luo.jin", "罗瑾", "admin"]] },
    { tid: "ten_zhizhi", name: "知止律师事务所", plan: "standard", seats: 25, edition: "team", members: [] },
  ];
  for (const f of firms) {
    const ok = await tryDo(`开通 ${f.tid}`, () => as(OPS, "POST", "/v1/ops/tenants", { tid: f.tid, name: f.name, plan: f.plan, seats: f.seats, subscription_days: f.tid === "ten_qinghe" ? 20 : 365, edition: f.edition, accounts_required: f.accounts_required ?? true }));
    if (!ok) continue;
    const T = `/v1/ops/tenants/${f.tid}`;
    if (f.boost) await tryDo(`加量 ${f.tid}`, () => as(OPS, "POST", `${T}/boost`, { pct: f.boost }));
    if (f.cap) await tryDo(`上限 ${f.tid}`, () => as(OPS, "POST", `${T}/cap`, { cap_pct: f.cap }));
    for (const [slug, name, role] of f.members) {
      const email = `${slug}@${f.tid.slice(4)}.example`;
      const a = await tryDo(`账号 ${email}`, () => as(OPS, "POST", "/v1/ops/accounts", { tid: f.tid, email, name, role }));
      if (!a) continue;
      if (slug === "luo.jin") {
        await tryDo("停用一个开发账号", () => as(OPS, "POST", `/v1/ops/accounts/${encodeURIComponent(a.account.aid)}/disable`, { reason: "开发数据：离职交接中" }));
        continue;
      }
      if (a.setup_code) {
        const password = pw();
        const set = await tryDo(`设密码 ${email}`, () => http("POST", "/v1/auth/password-reset/confirm", { email, code: a.setup_code, password }));
        if (set) members.push({ email, password, name, firm: f.name, role });
      }
    }
  }
  // 第二个上游：密钥用临时路由公钥在本机加密（与浏览器同一个 seal-key.js），控制面只见密文与尾号；route.manage 是危险操作，系统管理员复核后写
  const devKey = `sk-dev-${createHash("sha256").update(dir).digest("hex").slice(0, 24)}`;
  await tryDo("上游 csi-maas-b", async () =>
    as(SYS, "PUT", "/v1/ops/routing/providers/csi-maas-b", {
      label: "中软 MaaS 备线（开发地址）",
      vendor: "csi-maas",
      base_url: "https://maas-b.example.invalid/v1",
      enabled: true,
      max_concurrency: 32,
      key_sealed: await sealUpstreamKey({ publicKey: ROUTING_PUB, kid: ROUTING_KID, providerId: "csi-maas-b", plaintext: devKey }),
      key_hint: keyHint(devKey),
    }),
  );
  await tryDo("路由 legal/k3", () => as(SYS, "PUT", `/v1/ops/routing/models/${encodeURIComponent("legal/k3")}`, { label: "主任务模型", enabled: true, is_default: true, targets: [{ provider: "csi-maas", model: "kimi-k3.1-pro", priority: 1 }, { provider: "csi-maas-b", model: "kimi-k3.1-pro", priority: 2 }], allow_cross_vendor: false, default_max_tokens: 8192 }));
  if (!NO_USAGE) await seedGatewayReports(firms);
}

/**
 * 第 62 批（界面走查用）：模拟网关回报近 30 日的逐请求用量与上游健康——走网关同一条服务间接口
 * （POST /v1/quota/settle、POST /v1/feed/routing-health，服务凭据），控制面照常按请求编号去重、按价目版本重算、触发告警。
 * 数字是虚构的开发数据（固定随机种子，截图可复现）；--no-usage 不造。
 */
async function seedGatewayReports(firms) {
  const svc = (path, body) => http("POST", path, body, SERVICE_SECRET);
  let seed = 20261124;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const DAY = 86_400_000;
  const nowMs = Date.now();
  // 每家：近 30 日请求数、平均输入、成员（有账号的 + 未建账号的）、legal/k2.6（未定价）占比
  const plan = {
    ten_chengming: { n: 2600, input: 82_000, uids: ["chenyu", "lawyer-02", "lawyer-03", "lawyer-04"], sub: 0.18 },
    ten_hengshi: { n: 1500, input: 118_000, uids: ["sunli", "lawyer-02", "lawyer-05"], sub: 0.1 },
    ten_qinghe: { n: 760, input: 116_000, uids: ["fengxi", "lawyer-02"], sub: 0.05 },
  };
  for (const f of firms) {
    const p = plan[f.tid];
    if (!p) continue;
    const records = [];
    for (let i = 0; i < p.n; i++) {
      // 越近的日子越多（产品在推开），工作日比周末多
      const back = Math.floor(Math.pow(rnd(), 1.35) * 30);
      const at = nowMs - back * DAY - Math.floor(rnd() * 10 * 3600_000);
      const wd = new Date(at + 8 * 3600_000).getUTCDay();
      if ((wd === 0 || wd === 6) && rnd() < 0.6) continue;
      const sub = rnd() < p.sub;
      const input = Math.round(p.input * (0.35 + rnd() * 1.3));
      const roll = rnd();
      const outcome = roll < 0.012 ? "upstream_error" : roll < 0.02 ? "timeout" : roll < 0.035 ? "client_gone" : "ok";
      const failed = outcome === "upstream_error" || outcome === "timeout";
      const uid = `usr_${f.tid.slice(4)}_${p.uids[Math.floor(rnd() * p.uids.length)]}`;
      const switched = !failed && rnd() < 0.02;
      records.push({
        request_id: `dev-${f.tid.slice(4)}-${i.toString(36)}-${Math.floor(rnd() * 1e9).toString(36)}`,
        at: new Date(at).toISOString(),
        started_at: new Date(at - 4000 - Math.floor(rnd() * 40_000)).toISOString(),
        uid,
        sid: `seat_dev_${uid.slice(-8)}`,
        alias: sub ? "legal/k2.6" : "legal/k3",
        provider: switched ? "csi-maas-b" : "csi-maas",
        upstream_model: sub ? "kimi-k3.1-pro-highspeed" : "kimi-k3.1-pro",
        stream: true,
        status: failed ? (outcome === "timeout" ? 504 : 502) : 200,
        outcome,
        usage: failed ? null : { input, cached: Math.round(input * (0.2 + rnd() * 0.35)), output: Math.round(1200 + rnd() * 5200), reasoning: 0 },
        usage_source: failed ? "none" : outcome === "client_gone" ? "estimated" : "upstream",
        latency_ms: Math.round(failed ? 30_000 + rnd() * 30_000 : 6000 + rnd() * 50_000),
        attempts: switched ? [{ provider: "csi-maas", status: 503, error: "upstream_5xx", ms: 1200 }, { provider: "csi-maas-b", status: 200, ms: 22_000 }] : [],
      });
    }
    records.sort((a, b) => a.at.localeCompare(b.at));
    for (let i = 0; i < records.length; i += 200) await tryDo(`用量回报 ${f.tid}`, () => svc("/v1/quota/settle", { tid: f.tid, holder: "gw-dev-01", records: records.slice(i, i + 200) }));
  }
  const at = new Date().toISOString();
  await tryDo("上游健康回报", () =>
    svc("/v1/feed/routing-health", {
      holder: "gw-dev-01",
      providers: {
        "csi-maas": { state: "up", latency_ms: 820, last_ok_at: at, consecutive_failures: 0, inflight: 6, probed_at: at },
        "csi-maas-b": { state: "degraded", latency_ms: 2900, last_ok_at: at, last_error: "upstream_429", consecutive_failures: 2, inflight: 1, probed_at: at },
      },
    }),
  );
}
// 开发数据写完：脚本自己的会话退出（浏览器里重新登录）
for (const [email, t] of Object.entries(sessions)) await http("POST", "/v1/auth/logout", {}, t).catch(() => skipped.push(`退出 ${email}`));

// ─── 静态页（只发 dist/）+ /v1 反向代理 ───
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const STATIC = new Set(walk(DIST).map((f) => relative(DIST, f).split(sep).join("/")));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8" };
const origin = `http://127.0.0.1:${PORT}`;
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", origin);
  if (url.pathname.startsWith("/v1/")) {
    const up = request({ host: "127.0.0.1", port: cpPort, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${cpPort}` } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => (res.writeHead(502), res.end()));
    return void req.pipe(up);
  }
  const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  if (name === "config.json") {
    res.writeHead(200, { "content-type": TYPES[".json"], "cache-control": "no-store" });
    return void res.end(JSON.stringify({ control_plane_base: /^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host ?? "") ? `http://${req.headers.host}` : origin, deployment: "dev", label: "本机开发" }));
  }
  if (!STATIC.has(name)) return void (res.writeHead(404), res.end());
  res.writeHead(200, { "content-type": TYPES[extname(name)] ?? "application/octet-stream", "content-security-policy": CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store" });
  res.end(readFileSync(join(DIST, name)));
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", () => r()));
console.log(`统一云端控制台（本机开发）：${origin}`);
console.log("  平台人员（邮箱 + 密码即登录；密码每次启动随机生成）：");
for (const s of STAFF) console.log(`    ${s.name.padEnd(12)} ${s.email} / ${s.password}`);
if (members.length) {
  console.log("  律所成员（网页“我的”“本所”）：");
  for (const m of members) console.log(`    ${m.firm} · ${m.name}（${m.role}） ${m.email} / ${m.password}`);
}
console.log(`  网关路由公钥编号：${ROUTING_KID}（临时生成，私钥只在本进程内存）`);
console.log(`  控制面（进程内）：${cpBase}；数据目录 ${dir}`);
console.log(`DEV_CONSOLE_JSON ${JSON.stringify({ origin, staff: STAFF, members })}`);
if (skipped.length) console.log(`  开发数据有 ${skipped.length} 项没写入（接口未就绪或被拒）：\n    ${skipped.join("\n    ")}`);
const stop = () => {
  server.close();
  cp.server.closeAllConnections();
  cp.server.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
