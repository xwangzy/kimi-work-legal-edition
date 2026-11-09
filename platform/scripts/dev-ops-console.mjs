#!/usr/bin/env node
/**
 * 额度台本机演示（第 40 批）：一条命令拉起“控制面 + 模拟 Kimi 账号中心 + 控制台静态页”，并造好几家示例律所的用量，
 * 用于看界面、走查与截图。**只用于开发**：运营名册、签名私钥都是临时生成的，价格是示例价格。
 *
 *   node scripts/dev-ops-console.mjs [--port 5480] [--empty]
 *
 * - 控制台与控制面同源（本脚本把 /v1/* 反向代理到进程内的控制面），不必配 CORS；
 * - 运营私钥写到临时目录（启动时打印路径），在登录页拖进去即可（运营编号 op_0001，密钥编号 k1，无口令）；
 * - --empty：不造示例数据（从空平台开始）。
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const PORT = Number(args[args.indexOf("--port") + 1]) || 5480;
const EMPTY = args.includes("--empty");

const { createControlPlane, devControlPlaneKeys } = await import("../services/control-plane/src/index.ts");
const { devOpsRoster, fileOpsGuard } = await import("../packages/ops-auth/src/testing.ts");
const { startMockKimi } = await import("./lib/dev-kimi-oauth.mjs");

const dir = mkdtempSync(join(tmpdir(), "kwl-ops-console-dev-"));
const OPS = devOpsRoster(
  [
    { id: "op_0001", perms: ["tenant.read", "tenant.manage", "quota.manage", "quota.cap", "tenant.terminate", "device.revoke"] },
    { id: "op_0002", perms: ["tenant.read", "activation.issue"] },
  ],
  { deployment: "dev" },
);
for (const id of ["op_0001", "op_0002"]) writeFileSync(join(dir, `${id}.k1.key.pem`), OPS.keyOf(id).privateKeyPem, { mode: 0o600 });

const kimi = await startMockKimi({ port: PORT + 1 });
const cp = createControlPlane({
  keys: devControlPlaneKeys(),
  serviceSecret: "dev-ops-console-service-secret-000",
  opsGuard: fileOpsGuard({ dir: join(dir, "guard"), audience: "control-plane", roster: OPS.roster, rosterKeys: OPS.rosterKeys }),
  opsAccessLog: () => {},
  // 示例价格（正式价格由商务写进控制面配置的 billing 段）
  billing: {
    plans: [
      { id: "standard", label: "标准", seat_monthly_units: 200_000, seat_price_cny: 399, note: "每席每月约 80 单常规任务" },
      { id: "pro", label: "专业", seat_monthly_units: 500_000, seat_price_cny: 799, note: "每席每月约 200 单常规任务" },
      { id: "max", label: "旗舰", seat_monthly_units: 1_200_000, seat_price_cny: 1599, note: "每席每月约 480 单常规任务" },
    ],
    default_plan: "standard",
    unit_cost_cny: 0.0008,
    boost_price_factor: 1,
  },
  kimiAccount: { config: { oauth_host: kimi.base, client_id: "kwl-legal-dev", api_base: kimi.base } },
});
await new Promise((r) => cp.server.listen(0, "127.0.0.1", () => r()));
const cpPort = cp.server.address().port;

// ─── 示例律所（虚构名称）：覆盖正常、偏快、用完、近上限、待开通、快到期六种状态 ───
if (!EMPTY) {
  const now = Date.now();
  const DAY = 86_400_000;
  const nicks = ["陈**", "林**", "周**", "吴**", "郑**", "孙**", "赵**", "钱**", "冯**", "何**", "罗**", "高**"];
  const seed = (n) => {
    let x = n * 9301 + 49297;
    return () => ((x = (x * 9301 + 49297) % 233280) / 233280);
  };
  const firms = [
    { tid: "ten_chengming", name: "澄明律师事务所", plan: "pro", seats: 40, used: 0.58, boost: 25, members: 34, kimiShare: 0.85, hist: [0.62, 0.71, 0.8, 0.88, 0.93, 1.04] },
    { tid: "ten_hengshi", name: "衡石律师事务所", plan: "max", seats: 120, used: 0.21, members: 96, kimiShare: 0.6, hist: [0.55, 0.61, 0.58, 0.66, 0.7, 0.72] },
    { tid: "ten_qinghe", name: "青禾律师事务所", plan: "standard", seats: 8, used: 1, members: 8, kimiShare: 1, hist: [0.9, 1, 1, 0.97, 1, 1] },
    { tid: "ten_yuanlan", name: "远澜律师事务所", plan: "standard", seats: 15, used: 0.31, cap: 40, members: 12, kimiShare: 0.5, hist: [0.3, 0.34, 0.38, 0.36, 0.4, 0.39] },
    { tid: "ten_zhizhi", name: "知止律师事务所", plan: "pro", seats: 25, used: 0, members: 0, pending: true, created: now - 10 * DAY, hist: [] },
    { tid: "ten_nanqiang", name: "南樯律师事务所", plan: "standard", seats: 5, used: 0.12, members: 5, kimiShare: 0.4, kimiRequired: true, expires: now + 12 * DAY, hist: [0.2, 0.18, 0.25] },
  ];
  for (const [fi, f] of firms.entries()) {
    const t = cp.ops.createTenant({ tid: f.tid, name: f.name, edition: f.seats > 30 ? "firm" : "team", seats: f.seats, plan: f.plan, subscriptionDays: 365, activationRequired: true, kimiRequired: !!f.kimiRequired });
    if (f.created) t.created_at = new Date(f.created).toISOString();
    if (f.expires) t.subscription_until = new Date(f.expires).toISOString();
    if (f.boost) cp.ops.boostQuota(f.tid, f.boost);
    if (f.cap) cp.ops.setQuotaCap(f.tid, f.cap);
    if (f.pending) {
      cp.ops.issueActivationCode(f.tid, { member: { slug: "admin", name: "管理员" }, ttlHours: 72 });
      continue;
    }
    t.root_public_key_pem = "-----BEGIN PUBLIC KEY-----\n（本机演示，未登记）\n-----END PUBLIC KEY-----";
    const q = t.quota;
    const total = q.allowance + q.boost;
    const usedUnits = Math.round(total * f.used);
    // 成员用量：长尾分布（少数人用得多）
    const rnd = seed(fi + 1);
    const weights = Array.from({ length: f.members }, (_, i) => Math.pow(0.82, i) * (0.6 + rnd()));
    const wsum = weights.reduce((s, w) => s + w, 0);
    let left = usedUnits;
    for (let i = 0; i < f.members; i++) {
      const uid = `usr_${f.tid.slice(4)}_${String(i + 1).padStart(3, "0")}`;
      const sid = `seat_${f.tid}_${i + 1}`;
      t.seatsByUser.set(uid, { sid, uid, assigned_at: new Date(now - 60 * DAY).toISOString(), revoked_at: null });
      const units = i === f.members - 1 ? left : Math.min(left, Math.round((usedUnits * weights[i]) / wsum));
      left -= units;
      if (units > 0) q.period_by_seat[sid] = { points: units, requests: Math.max(1, Math.round(units / 2400)) };
      if (rnd() < f.kimiShare) t.kimiAccounts.set(uid, { ref: `kimi_${(fi * 1000 + i).toString(16).padStart(20, "0")}`, nickname: nicks[(i + fi) % nicks.length], phone_tail: String(1000 + Math.floor(rnd() * 8999)), level: ["Allegro", "Moderato", "Vivace"][i % 3], bound_at: new Date(now - (20 - (i % 20)) * DAY).toISOString() });
    }
    t.seatCounter = f.members;
    q.period_used = usedUnits;
    // 在途：用得多的所有一点网关在途
    if (f.used > 0.1 && f.used < 1) q.leases.ls_demo = { lease_id: "ls_demo", holder: "gw-demo", points: Math.round(total * 0.03), granted_at: new Date().toISOString(), expires_at: new Date(now + 5 * 60_000).toISOString(), by_seat: {}, used: 0, closed_at: null, unreconciled: false };
    // 历史月份
    const [y, m] = q.period.split("-").map(Number);
    q.history = f.hist.map((r, i) => {
      const k = new Date(Date.UTC(y, m - 1 - (f.hist.length - i), 1));
      return { period: `${k.getUTCFullYear()}-${String(k.getUTCMonth() + 1).padStart(2, "0")}`, used: Math.round(q.allowance * r), total: q.allowance, boost_pct: r > 1 ? Math.round((r - 1) * 100 / 25) * 25 || 25 : 0 };
    });
  }
}

// ─── 静态页 + /v1 反向代理 ───
const STATIC = new Set(["index.html", "console.js", "console.css", "ops-sign.js"]);
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
  const name = url.pathname === "/" ? "index.html" : normalize(url.pathname.slice(1));
  if (name === "config.json") {
    res.writeHead(200, { "content-type": TYPES[".json"], "cache-control": "no-store" });
    return void res.end(JSON.stringify({ control_plane_base: /^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host ?? "") ? `http://${req.headers.host}` : origin, deployment: "dev", label: "本机演示 · 示例价格" }));
  }
  if (!STATIC.has(name)) return void (res.writeHead(404), res.end());
  res.writeHead(200, { "content-type": TYPES[extname(name)] ?? "application/octet-stream", "content-security-policy": CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store" });
  res.end(readFileSync(join(root, "apps/ops-console", name)));
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", () => r()));
console.log(`额度台（本机演示）：${origin}`);
console.log(`  运营私钥：${join(dir, "op_0001.k1.key.pem")}（运营编号 op_0001，密钥编号 k1，无口令；op_0002 只能看与发码）`);
console.log(`  模拟 Kimi 账号中心：${kimi.base}`);
console.log(`  控制面（进程内）：http://127.0.0.1:${cpPort}`);
const stop = async () => {
  server.close();
  cp.server.closeAllConnections();
  cp.server.close();
  await kimi.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
