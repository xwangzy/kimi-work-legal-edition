#!/usr/bin/env node
/**
 * 运营控制台本机开发（第 44 批）：先打包 dist/（scripts/build-console.mjs），再一条命令拉起“进程内控制面 + 控制台静态页”。
 * **只用于开发**：运营名册、运营私钥、网关路由密钥都是临时生成的；价格是示例价格；律所、账号是虚构的演示数据。
 *
 *   node scripts/dev-console.mjs [--port 5480] [--empty]
 *
 * - 控制台与控制面同源（/v1/* 反向代理到进程内的控制面），不必配 CORS；静态页只发 dist/ 里的文件，CSP 与生产同口径；
 * - 登录：账号 + 密码（第 45 批）——admin（op_0001，可直接用）与 issuer（op_0002，首次登录须改密码，用来走一遍改密码流程），
 *   密码每次启动随机生成并打印；运营私钥也写到临时目录（启动时打印路径），登录页“使用运营私钥登录”拖进去即可；
 * - 演示数据**只经控制面的真实运营接口写入**（用 op_0001 / op_0002 的私钥签名，与浏览器同一个 ops-sign.js）：开通律所、代建账号、
 *   套餐、上游（密钥用临时路由公钥在本机加密）、别名路由、价目、加量与上限、停用一个账号、发一个开通码。
 *   逐请求用量**不造**：控制面要求真实席位（设备登记后才有），没有真实设备时用量页显示空状态。
 *   页面顶栏标“开发演示数据”（config.json 的 demo: true）；--empty 不造任何数据，也不标。
 */
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildConsole } from "./build-console.mjs";

const args = process.argv.slice(2);
const PORT = Number(args[args.indexOf("--port") + 1]) || 5480;
const EMPTY = args.includes("--empty");

const { createControlPlane, devControlPlaneKeys, UsageBook } = await import("../services/control-plane/src/index.ts");
const { devOpsRoster, fileOpsGuard } = await import("../packages/ops-auth/src/testing.ts");
const { createOpsPasswordSessions, emptyOpsCredentials, generateOpsPassword, memoryOpsCredentialSource, setOpsCredential } = await import("../packages/ops-auth/src/index.ts");
const { importOpsKey, signOpsRequest } = await import("../apps/console/ops-sign.js");
const { sealUpstreamKey, keyHint } = await import("../apps/console/seal-key.js");

// ─── 打包 ───
const DIST = fileURLToPath(new URL("../apps/console/dist", import.meta.url));
buildConsole(DIST);

// ─── 临时运营名册（含第 44 批新增的 account.manage / route.manage / plan.manage） ───
const dir = mkdtempSync(join(tmpdir(), "kwl-ops-console-dev-"));
// tenant.manage 与 activation.issue 职责分离（名册拒收同一人兼有）：发开通码用 op_0002
const FULL = ["tenant.read", "tenant.manage", "tenant.terminate", "quota.manage", "quota.cap", "device.revoke", "account.manage", "route.manage", "plan.manage"];
const OPS = devOpsRoster(
  [
    { id: "op_0001", perms: FULL },
    { id: "op_0002", perms: ["tenant.read", "activation.issue"] },
  ],
  { deployment: "dev" },
);
for (const id of ["op_0001", "op_0002"]) writeFileSync(join(dir, `${id}.k1.key.pem`), OPS.keyOf(id).privateKeyPem, { mode: 0o600 });
// 控制台账号（只在本进程内存）：admin 直接可用；issuer 首次登录须改密码
const PASSWORDS = { admin: generateOpsPassword(), issuer: generateOpsPassword() };
let creds = setOpsCredential(emptyOpsCredentials(), { operator: "op_0001", login: "admin", password: PASSWORDS.admin, mustChange: false });
creds = setOpsCredential(creds, { operator: "op_0002", login: "issuer", password: PASSWORDS.issuer, mustChange: true });
const sessions = createOpsPasswordSessions({ credentials: memoryOpsCredentialSource(creds) });

// ─── 临时网关路由密钥（P-256）：公钥进 config.json，编号 = SPKI 字节 sha256 前 16 位十六进制 ───
const routingPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const spki = routingPair.publicKey.export({ format: "der", type: "spki" });
const ROUTING_PUB = Buffer.from(spki).toString("base64");
const ROUTING_KID = createHash("sha256").update(spki).digest("hex").slice(0, 16);

const cp = createControlPlane({
  keys: devControlPlaneKeys(),
  serviceSecret: "dev-console-service-secret-000",
  opsGuard: fileOpsGuard({ dir: join(dir, "guard"), audience: "control-plane", roster: OPS.roster, rosterKeys: OPS.rosterKeys, sessions }),
  opsAccessLog: () => {},
  opsInfo: { deployment: "dev", roster: () => OPS.roster.body },
  usageBook: new UsageBook({ dir: join(dir, "usage") }),
  routing: {
    key_id: ROUTING_KID,
    bootstrap: EMPTY
      ? undefined
      : {
          provider: { id: "csi-maas", label: "中软 MaaS（演示地址）", vendor: "csi-maas", base_url: "https://maas.example.invalid/v1" },
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
          // 旧版计量（单位）套餐：控制面按 × 250 换算为 token 额度、标“待商务确认”（主文 §4.6）
          { id: "legacy-std", label: "旧标准", seat_monthly_units: 200_000, seat_price_cny: 399 },
        ],
        default_plan: "standard",
      },
});
await new Promise((r) => cp.server.listen(0, "127.0.0.1", () => r()));
const cpPort = cp.server.address().port;
const cpBase = `http://127.0.0.1:${cpPort}`;

// ─── 演示数据：只经真实运营接口 ───
const opKeys = { op_0001: await importOpsKey(OPS.keyOf("op_0001").privateKeyPem), op_0002: await importOpsKey(OPS.keyOf("op_0002").privateKeyPem) };
async function ops(method, path, body, operator = "op_0001") {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const headers = await signOpsRequest({ deployment: "dev", audience: "control-plane", operator, kid: "k1", key: opKeys[operator], method, path, body: raw });
  const r = await fetch(cpBase + path, { method, headers: { ...headers, ...(raw ? { "content-type": "application/json" } : {}) }, ...(raw ? { body: raw } : {}) });
  const json = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${json?.error?.code ?? ""} ${json?.error?.message ?? ""}`);
  return json;
}
const skipped = [];
const tryOps = async (label, fn) => {
  try {
    return await fn();
  } catch (e) {
    skipped.push(`${label}：${e.message}`);
    return null;
  }
};

if (!EMPTY) {
  // 律所（虚构名称；邮箱用保留域名 .example）。每家只代建负责人账号：控制面要求先完成创始开通（founder_first）才能建成员账号
  const firms = [
    { tid: "ten_chengming", name: "澄明律师事务所", plan: "pro", seats: 40, edition: "firm", boost: 25, members: [["chen.yu", "陈雨", "admin"]] },
    { tid: "ten_hengshi", name: "衡石律师事务所", plan: "max", seats: 120, edition: "firm", members: [["sun.li", "孙立", "admin"]] },
    { tid: "ten_qinghe", name: "青禾律师事务所", plan: "standard", seats: 8, edition: "team", cap: 60, members: [["feng.xi", "冯溪", "admin"]] },
    { tid: "ten_yuanlan", name: "远澜律师事务所", plan: "legacy-std", seats: 15, edition: "team", accounts_required: false, members: [["luo.jin", "罗瑾", "admin"]] },
    { tid: "ten_zhizhi", name: "知止律师事务所", plan: "standard", seats: 25, edition: "team", pending: true, members: [] },
  ];
  for (const f of firms) {
    const ok = await tryOps(`开通 ${f.tid}`, () => ops("POST", "/v1/ops/tenants", { tid: f.tid, name: f.name, plan: f.plan, seats: f.seats, subscription_days: f.tid === "ten_qinghe" ? 20 : 365, edition: f.edition, accounts_required: f.accounts_required ?? true }));
    if (!ok) continue;
    const T = `/v1/ops/tenants/${f.tid}`;
    if (f.boost) await tryOps(`加量 ${f.tid}`, () => ops("POST", `${T}/boost`, { pct: f.boost }));
    if (f.cap) await tryOps(`上限 ${f.tid}`, () => ops("POST", `${T}/cap`, { cap_pct: f.cap }));
    if (f.pending) await tryOps(`开通码 ${f.tid}`, () => ops("POST", `${T}/activation-codes`, {}, "op_0002"));
    for (const [slug, name, role] of f.members) {
      const domain = `${f.tid.slice(4)}.example`;
      const a = await tryOps(`账号 ${slug}@${domain}`, () => ops("POST", "/v1/ops/accounts", { tid: f.tid, email: `${slug}@${domain}`, name, role }));
      if (a && slug === "luo.jin") await tryOps("停用演示账号", () => ops("POST", `/v1/ops/accounts/${encodeURIComponent(a.account.aid)}/disable`, { reason: "演示：离职交接中" }));
    }
  }
  // 第二个上游：密钥用临时路由公钥在本机加密（与浏览器同一个 seal-key.js），控制面只见密文与尾号
  const demoKey = `sk-demo-${createHash("sha256").update(dir).digest("hex").slice(0, 24)}`;
  await tryOps("上游 csi-maas-b", async () =>
    ops("PUT", "/v1/ops/routing/providers/csi-maas-b", {
      label: "中软 MaaS 备线（演示地址）",
      vendor: "csi-maas",
      base_url: "https://maas-b.example.invalid/v1",
      enabled: true,
      max_concurrency: 32,
      key_sealed: await sealUpstreamKey({ publicKey: ROUTING_PUB, kid: ROUTING_KID, providerId: "csi-maas-b", plaintext: demoKey }),
      key_hint: keyHint(demoKey),
    }),
  );
  await tryOps("路由 legal/k3", () => ops("PUT", `/v1/ops/routing/models/${encodeURIComponent("legal/k3")}`, { label: "主任务模型", enabled: true, is_default: true, targets: [{ provider: "csi-maas", model: "kimi-k3.1-pro", priority: 1 }, { provider: "csi-maas-b", model: "kimi-k3.1-pro", priority: 2 }], allow_cross_vendor: false, default_max_tokens: 8192 }));
}

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
    return void res.end(
      JSON.stringify({
        control_plane_base: /^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host ?? "") ? `http://${req.headers.host}` : origin,
        deployment: "dev",
        label: "本机开发",
        routing_public_key: ROUTING_PUB,
        routing_key_id: ROUTING_KID,
        demo: !EMPTY,
      }),
    );
  }
  if (!STATIC.has(name)) return void (res.writeHead(404), res.end());
  res.writeHead(200, { "content-type": TYPES[extname(name)] ?? "application/octet-stream", "content-security-policy": CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store" });
  res.end(readFileSync(join(DIST, name)));
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", () => r()));
console.log(`运营控制台（本机开发）：${origin}`);
console.log(`  账号密码：admin / ${PASSWORDS.admin}（op_0001：除发开通码外的全部权限）`);
console.log(`            issuer / ${PASSWORDS.issuer}（op_0002：只读 + 发开通码；首次登录须改密码）`);
console.log(`  运营私钥：${join(dir, "op_0001.k1.key.pem")}（op_0001，密钥编号 k1，无口令；登录页“使用运营私钥登录”）`);
console.log(`            ${join(dir, "op_0002.k1.key.pem")}（op_0002）`);
console.log(`  网关路由公钥编号：${ROUTING_KID}（临时生成，私钥只在本进程内存）`);
console.log(`  控制面（进程内）：${cpBase}`);
if (skipped.length) console.log(`  演示数据有 ${skipped.length} 项没写入（接口未就绪或被拒）：\n    ${skipped.join("\n    ")}`);
const stop = () => {
  server.close();
  cp.server.closeAllConnections();
  cp.server.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
