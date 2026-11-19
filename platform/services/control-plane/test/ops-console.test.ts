/**
 * 第 37 批：网页运营控制台与部署工具。
 * - 控制台的浏览器签名（apps/console/ops-sign.js，WebCrypto）与控制面运营守卫逐字节兼容：明文与口令加密的 PKCS#8 私钥都能用；
 * - 新增只读接口：租户列表、按租户用量（按席位只给席位编号，不给成员标识与姓名；律所设的上限只给“律所管理员”）；
 * - 生产入口的 ops.console_origins：只对列出的来源回 CORS 头与预检；配置不合规拒绝启动；运维网段以外照样 404；
 * - 部署工具：cloud-init-secrets 生成的密钥能直接拉起签名服务与控制面；make-release-config 生成的 release.json 过客户端校验；
 *   meter-report 按网关同一规则重算点数、按 requestId 去重。
 * 第 44 批：控制台重做为原生 ES 模块（app.js + api.js + ui.js + pages/*.js）与 dist 打包（scripts/build-console.mjs）；
 *   门禁不放松：CSP 原样、无内联脚本与样式、不引外部资源、不拼 HTML、动态样式只经 el.style.cssText、不用 window.confirm；
 *   样式只用 tokens.css 的语义令牌；上游密钥在浏览器里按主文 §3.2 加密；“记住 8 小时”只收不可导出的密钥对象。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateOpsKeyPair } from "@zr-legal/ops-auth";
import { devOpsRoster, fileOpsGuard } from "@zr-legal/ops-auth/testing";
import { createControlPlane, devControlPlaneKeys, type ControlPlane } from "../src/index.ts";
// @ts-expect-error 浏览器模块（纯 JS，无类型声明）
import { importOpsKey, signOpsRequest } from "../../../apps/console/ops-sign.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "kwl-ops-console-"));
const OPS = devOpsRoster([
  { id: "op_0001", perms: ["tenant.read", "tenant.manage", "quota.manage", "quota.cap"] },
  { id: "op_0003", perms: ["activation.issue"] },
]);
let cp: ControlPlane;
let base = "";
const kids: ChildProcess[] = [];

before(async () => {
  cp = createControlPlane({ keys: devControlPlaneKeys(), serviceSecret: "ops-console-test-service-secret", opsGuard: fileOpsGuard({ dir: join(dir, "g"), audience: "control-plane", roster: OPS.roster, rosterKeys: OPS.rosterKeys }), opsAccessLog: () => {} });
  await new Promise<void>((r) => cp.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(cp.server.address() as AddressInfo).port}`;
});
after(async () => {
  for (const k of kids) k.kill("SIGTERM");
  cp.server.closeAllConnections();
  await new Promise<void>((r) => cp.server.close(() => r()));
});

/** 和控制台页面同一条路：浏览器模块签名后发请求。 */
const browserCall = async (who: string, method: string, path: string, body?: unknown, at = base, extra: Record<string, string> = {}) => {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const key = await importOpsKey(OPS.keyOf(who).privateKeyPem);
  const headers = await signOpsRequest({ deployment: OPS.deployment, audience: "control-plane", operator: who, kid: "k1", key, method, path, body: raw });
  const r = await fetch(`${at}${path}`, { method, headers: { ...headers, ...extra, ...(raw ? { "content-type": "application/json" } : {}) }, ...(raw ? { body: raw } : {}) });
  return { status: r.status, json: (await r.json()) as any, headers: r.headers };
};

test("浏览器签名与控制面运营守卫兼容；口令加密私钥可导入、错口令与公钥文件如实拒绝", async () => {
  const created = await browserCall("op_0001", "POST", "/v1/ops/tenants", { tid: "ten_console", edition: "team", seats: 3, name: "控制台测试所" });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const kp = generateOpsKeyPair("口令-测试-2026");
  const k = await importOpsKey(kp.privateKeyPem, "口令-测试-2026");
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, k, new TextEncoder().encode("x")));
  const { verify } = await import("node:crypto");
  assert.equal(verify(null, Buffer.from("x"), createPublicKey(kp.publicKeyPem), sig), true);
  await assert.rejects(importOpsKey(kp.privateKeyPem, "错的"), /口令不对/);
  await assert.rejects(importOpsKey(kp.privateKeyPem), /有口令保护/);
  await assert.rejects(importOpsKey(kp.publicKeyPem), /公钥文件/);
  assert.equal((k as CryptoKey).extractable, false, "私钥导入为不可导出");
  // 篡改请求体：签名不符
  const key = await importOpsKey(OPS.keyOf("op_0001").privateKeyPem);
  const h = await signOpsRequest({ deployment: OPS.deployment, audience: "control-plane", operator: "op_0001", kid: "k1", key, method: "POST", path: "/v1/ops/tenants/ten_console/boost", body: JSON.stringify({ pct: 1 }) });
  const r = await fetch(`${base}/v1/ops/tenants/ten_console/boost`, { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ pct: 999 }) });
  assert.equal(r.status, 401);
});

test("租户列表与用量明细（第 44 批 v2）：只读权限；用量从账本出、按对外单位与比例；没有账号的成员不外露成员标识；律所设的上限只标“律所管理员”", async () => {
  await browserCall("op_0001", "POST", "/v1/ops/tenants", { tid: "ten_second", edition: "firm", seats: 10, name: "第二所" });
  const list = await browserCall("op_0001", "GET", "/v1/ops/tenants");
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.tenants.map((t: any) => t.tid).sort(), ["ten_console", "ten_second"]);
  const row = list.json.tenants.find((t: any) => t.tid === "ten_console");
  assert.deepEqual([row.used_ratio, row.unit, row.plan.id, row.total], [0, "tokens", "standard", 3 * 50_000_000]);
  assert.equal((await browserCall("op_0003", "GET", "/v1/ops/tenants")).status, 403, "只能发码的人不能看租户列表");
  // 席位与律所管理员设的上限（设备编号里含成员标识）
  const t = cp.ops.tenant("ten_console")!;
  t.seatsByUser.set("zhang.lawyer", { sid: "seat_aaa", uid: "zhang.lawyer", assigned_at: new Date().toISOString(), revoked_at: null });
  t.quota.cap_pct = 90;
  t.quota.cap_set_by = "dev_zhang.lawyer_01";
  const u = await browserCall("op_0001", "GET", "/v1/ops/tenants/ten_console/usage");
  assert.equal(u.status, 200, JSON.stringify(u.json));
  assert.deepEqual([u.json.unit, u.json.used, u.json.total, u.json.used_ratio], ["tokens", 0, 150_000_000, 0]);
  assert.equal(u.json.daily.length, 30);
  assert.equal(u.json.cap_set_by, "firm_admin");
  assert.deepEqual(u.json.by_account, []);
  const d = await browserCall("op_0001", "GET", "/v1/ops/tenants/ten_console");
  assert.equal(JSON.stringify(u.json).includes("lawyer") || JSON.stringify(d.json.members).includes("zhang"), false, "没有账号的成员不外露成员标识");
  assert.equal((await browserCall("op_0001", "GET", "/v1/ops/tenants/ten_nobody/usage")).status, 404);
  assert.equal((await browserCall("op_0003", "GET", "/v1/ops/tenants/ten_console/usage")).status, 403);
});

// ─── 生产入口：cloud-init-secrets 生成的密钥 + console_origins ───────────────
const script = join(root, "scripts/cloud-serve.mjs");
const write = (name: string, content: string) => {
  const p = join(dir, name);
  writeFileSync(p, content, { mode: 0o600 });
  return p;
};
const cfgFile = (cfg: unknown) => write(`c-${Math.random().toString(36).slice(2)}.json`, JSON.stringify(cfg));
function start(cfg: unknown): Promise<{ port: number }> {
  const proc = spawn(process.execPath, [script, "--config", cfgFile(cfg)], { stdio: ["ignore", "pipe", "pipe"] });
  kids.push(proc);
  return new Promise((ok, no) => {
    let out = "";
    proc.stdout!.on("data", (d) => {
      out += d;
      const m = /已就绪（http 仅测试 [^:]+:(\d+)/.exec(out);
      if (m) ok({ port: Number(m[1]) });
    });
    proc.stderr!.on("data", (d) => (out += d));
    proc.on("exit", (c) => no(new Error(`退出 ${c}：${out}`)));
  });
}

test("cloud-init-secrets 的密钥直接拉起签名服务与控制面；console_origins 只对列出的来源回 CORS 头与预检；不合规的来源拒绝启动", { timeout: 120_000 }, async () => {
  const out = join(dir, "init");
  const g = spawnSync(process.execPath, [join(root, "scripts/cloud-init-secrets.mjs"), "--env", "test", "--out", out, "--id", "t1", "--mount", join(out, "secrets")], { encoding: "utf8" });
  assert.equal(g.status, 0, g.stderr);
  assert.equal(spawnSync(process.execPath, [join(root, "scripts/cloud-init-secrets.mjs"), "--env", "test", "--out", out], { encoding: "utf8" }).status, 1, "不覆盖已有目录");
  const cpKeys = JSON.parse(readFileSync(join(out, "public/cp-public-keys.json"), "utf8"));
  assert.deepEqual(Object.keys(cpKeys), ["cp-test-t1", "cp-test-t2"], "控制面公钥表含当前与下一把");
  assert.equal(readFileSync(join(out, "public/seat-public-keys.json"), "utf8").includes("PRIVATE"), false);

  const signer = await start({ role: "cp-signer", environment: "test", init_ledger: true, listen: { host: "127.0.0.1", port: 0 }, insecure_loopback_for_test: true, data_dir: join(dir, "signer"), keys: JSON.parse(readFileSync(join(out, "public/signer-keys.json"), "utf8")) });
  const rosterFile = write("roster.json", JSON.stringify(OPS.roster));
  const rosterKeys = write("roster-keys.json", JSON.stringify(Object.fromEntries(OPS.rosterKeys)));
  const sec = (f: string) => join(out, "secrets", f);
  const cpCfg = (consoleOrigins?: unknown, tag = "cp") => ({
    role: "control-plane",
    listen: { host: "127.0.0.1", port: 0 },
    insecure_loopback_for_test: true,
    service_secret_file: sec("service-secret"),
    data_dir: join(dir, tag),
    signer: { url: `http://127.0.0.1:${signer.port}` },
    state_key_file: sec("cp-state.key"),
    code_pepper_file: sec("cp-code-pepper.key"),
    ops: { deployment: OPS.deployment, roster_file: rosterFile, roster_keys_file: rosterKeys, allow_cidrs: ["127.0.0.1/32"], ...(consoleOrigins === undefined ? {} : { console_origins: consoleOrigins }) },
  });
  for (const bad of [["*"], ["https://ops.example/"], ["https://ops.example/console"], ["http://ops.example"], []])
    assert.match(spawnSync(process.execPath, [script, "--config", cfgFile(cpCfg(bad, "bad"))], { encoding: "utf8", timeout: 30_000 }).stderr, /console_origins/, `拒绝 ${JSON.stringify(bad)}`);

  const ORIGIN = "http://127.0.0.1:4173";
  const { port } = await start(cpCfg([ORIGIN]));
  const at = `http://127.0.0.1:${port}`;
  const pre = await fetch(`${at}/v1/ops/tenants`, { method: "OPTIONS", headers: { origin: ORIGIN, "access-control-request-method": "GET", "access-control-request-headers": "x-kwl-op,x-kwl-op-sig" } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), ORIGIN);
  assert.match(pre.headers.get("access-control-allow-headers") ?? "", /x-kwl-op-sig/);
  assert.equal(pre.headers.get("access-control-allow-credentials"), null, "不带凭据");
  const ok = await browserCall("op_0001", "GET", "/v1/ops/tenants", undefined, at, { origin: ORIGIN });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.tenants, []);
  assert.equal(ok.headers.get("access-control-allow-origin"), ORIGIN);
  const denied = await browserCall("op_0003", "GET", "/v1/ops/tenants", undefined, at, { origin: ORIGIN });
  assert.equal(denied.status, 403, JSON.stringify(denied.json));
  assert.equal(denied.headers.get("access-control-allow-origin"), ORIGIN, "错误回复也带允许头（页面要读到原因）");
  const other = await browserCall("op_0001", "GET", "/v1/ops/tenants", undefined, at, { origin: "http://127.0.0.1:9999" });
  assert.equal(other.headers.get("access-control-allow-origin"), null, "没列出的来源不回允许头");
  const otherPre = await fetch(`${at}/v1/ops/tenants`, { method: "OPTIONS", headers: { origin: "http://127.0.0.1:9999", "access-control-request-method": "GET" } });
  assert.notEqual(otherPre.status, 204);
  // 非运营路径不回 CORS 头
  const health = await fetch(`${at}/healthz`, { headers: { origin: ORIGIN } });
  assert.equal(health.headers.get("access-control-allow-origin"), null);
});

test("make-release-config：备份钉住、公钥表填好并过客户端校验；少于两把钉住或缺公钥表即不写文件", () => {
  const out = join(dir, "init");
  const backup = (n: string) => {
    const p = join(dir, `${n}.pub.pem`);
    writeFileSync(p, String(generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" })));
    return p;
  };
  const cur = { control_plane: [backup("cp")], gateway: [backup("gw")], search: [backup("se")] };
  const spec = {
    control_plane_base: "https://cp.kwl.example.com",
    gateway_base: "https://gw.kwl.example.com/v1",
    search_base: "https://search.kwl.example.com/v1/search",
    pins: cur,
    backup_pins: [backup("bk")],
    cp_public_keys_file: join(out, "public/cp-public-keys.json"),
    seat_public_keys_file: join(out, "public/seat-public-keys.json"),
    test_build: true,
  };
  const target = join(dir, "release.json");
  const run = (s: unknown) => spawnSync(process.execPath, [join(root, "scripts/make-release-config.mjs"), "--offline", "--spec", write(`spec-${Math.random()}.json`, JSON.stringify(s)), "--out", target], { encoding: "utf8" });
  const r = run(spec);
  assert.equal(r.status, 0, r.stderr);
  const rel = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(rel.gateway_pins.length, 2);
  assert.match(rel.gateway_pins[0], /^sha256\/[A-Za-z0-9+/]{43}=$/);
  assert.deepEqual(Object.keys(rel.control_plane_keys), ["cp-test-t1", "cp-test-t2"]);
  assert.equal(rel.test_build, true);
  assert.match(run({ ...spec, backup_pins: [] }).stderr, /至少要当前 \+ 备份两把/);
  assert.match(run({ ...spec, seat_public_keys_file: undefined }).stderr, /seat_public_keys_file/);
  assert.match(run({ ...spec, pins: { ...cur, gateway: [join(out, "secrets/seat.pem")] } }).stderr, /是私钥/);
});

test("meter-report（第 44 批）：读网关预写日志里的逐请求记录，按租户 × 月份（北京时间）× 席位 × 模型 × 单位汇总；多实例文件按请求编号去重；旧行单列", () => {
  const rec = (id: string, at: string, sid: string, unit: string, extra: Record<string, unknown>) => ({ at, kind: "settle", requestId: id, tid: "ten_a", sid, model: "legal/k3", status: 200, unit, record: { request_id: id, tid: "ten_a", sid, alias: "legal/k3", provider: "maas", upstream_model: "kimi-k3.1-pro", outcome: "ok", usage_source: "upstream", usage: { input: 9000, cached: 2000, output: 1000, reasoning: 0 }, charge_units: 10_000, ...extra } });
  const lines = [
    rec("r1", "2026-10-31T16:30:00.000Z", "seat_1", "tokens", {}),
    rec("r2", "2026-11-02T02:00:00.000Z", "seat_1", "tokens", { outcome: "client_gone", usage_source: "estimated", usage: { input: 100, cached: 0, output: 50, reasoning: 0 }, charge_units: 150 }),
    rec("r3", "2026-11-02T03:00:00.000Z", "seat_2", "tokens", { outcome: "timeout", usage_source: "none", usage: null, charge_units: 0 }),
    { at: "2026-11-02T03:00:00.000Z", kind: "reserve", requestId: "r4", tid: "ten_a", sid: "seat_2", model: "legal/k3", status: null, reserved: 40 },
    { at: "2026-10-15T03:00:00.000Z", kind: "settle", requestId: "r5", tid: "ten_b", sid: "seat_9", model: "legal/k2.6", status: 200, reserved: 10, inputTokens: 1500, outputTokens: 0, cachedTokens: 0, reason: null },
  ];
  const f1 = write("meter-1.jsonl", lines.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const f2 = write("meter-2.jsonl", `${JSON.stringify(lines[0])}\nnot json\n`);
  const r = spawnSync(process.execPath, [join(root, "scripts/meter-report.mjs"), f1, f2, "--format", "json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  const row = (tid: string, period: string, sid: string) => out.rows.find((x: any) => x.tid === tid && x.period === period && x.sid === sid);
  // r1：UTC 10-31 16:30 = 北京 11-01 00:30 → 11 月；重复的 r1 去重
  const s1 = row("ten_a", "2026-11", "seat_1");
  assert.deepEqual([s1.requests, s1.ok, s1.client_gone, s1.estimated, s1.input_tokens, s1.charge_units], [2, 1, 1, 1, 9100, 10_150]);
  const s2 = row("ten_a", "2026-11", "seat_2");
  assert.deepEqual([s2.requests, s2.timeouts, s2.charge_units], [1, 1, 0], "上游超时不扣");
  const old = row("ten_b", "2026-10", "seat_9");
  assert.deepEqual([old.unit, old.legacy_rows, old.charge_units], ["legacy", 1, 0], "第 44 批之前的旧行不估单位");
  assert.equal(out.bad_lines, 1);
  assert.match(r.stderr, /跳过 1 行/);
  const t = spawnSync(process.execPath, [join(root, "scripts/meter-report.mjs"), f1, "--by", "provider", "--month", "2026-11"], { encoding: "utf8" });
  assert.equal(t.status, 0, t.stderr);
  assert.match(t.stdout.split("\n")[0]!, /^period,provider,upstream_model,unit,requests,/);
  assert.match(t.stdout, /2026-11,maas,kimi-k3\.1-pro,tokens,3,/);
});

test("套餐与律所额度（第 44 批）：目录含试用套餐；改套餐与席位（不得少于在用席位）即刻改本期总额度；加量包按百分比；旧的点数接口 410、旧上限字段拒绝；Kimi 账号绑定接口已撤下", async () => {
  const plans = await browserCall("op_0001", "GET", "/v1/ops/plans");
  assert.equal(plans.status, 200);
  assert.deepEqual(plans.json.plans.map((p: any) => p.id), ["standard", "pro", "max", "trial"]);
  assert.ok(plans.json.plans.every((p: any) => p.quota_unit === "tokens" && Number.isSafeInteger(p.seat_quota)));
  assert.equal((await browserCall("op_0003", "GET", "/v1/ops/plans")).status, 403, "只能发码的人看不到目录");
  const t = cp.ops.tenant("ten_second")!;
  const ch = await browserCall("op_0001", "POST", "/v1/ops/tenants/ten_second/plan", { plan: "max" });
  assert.equal(ch.status, 200, JSON.stringify(ch.json));
  assert.equal(ch.json.tenant.total, 10 * 300_000_000);
  assert.equal((await browserCall("op_0001", "POST", "/v1/ops/tenants/ten_second/plan", { plan: "gold" })).json.error.code, "plan_unknown");
  assert.equal((await browserCall("op_0001", "POST", "/v1/ops/tenants/ten_second/plan", {})).json.error.code, "plan_invalid");
  t.seatsByUser.set("a", { sid: "seat_s1", uid: "a", assigned_at: new Date().toISOString(), revoked_at: null });
  t.seatsByUser.set("b", { sid: "seat_s2", uid: "b", assigned_at: new Date().toISOString(), revoked_at: null });
  const low = await browserCall("op_0001", "POST", "/v1/ops/tenants/ten_second/plan", { seats: 1 });
  assert.deepEqual([low.status, low.json.error.code], [409, "seats_in_use"]);
  assert.equal((await browserCall("op_0001", "POST", "/v1/ops/tenants/ten_second/plan", { seats: 4 })).status, 200);
  assert.equal(t.license.seats, 4, "许可随席位数重签");
  const b = await browserCall("op_0001", "POST", "/v1/ops/tenants/ten_second/boost", { pct: 50 });
  assert.equal(b.status, 200);
  assert.deepEqual([b.json.tenant.boost_pct, b.json.tenant.total], [50, 4 * 300_000_000 * 1.5]);
  const u = await browserCall("op_0001", "GET", "/v1/ops/tenants/ten_second/usage");
  assert.deepEqual(u.json.boosts.map((x: any) => [x.pct, x.by]), [[50, "op_0001"]]);
  const d = await browserCall("op_0001", "GET", "/v1/ops/tenants/ten_second");
  assert.deepEqual([d.json.bill.seat_fee_cny, d.json.bill.revenue_cny], [null, null], "缺省目录没有价格");
  assert.equal((await browserCall("op_0001", "POST", "/v1/ops/tenants/ten_second/points", { points: 1 })).status, 410);
  assert.equal((await browserCall("op_0001", "POST", "/v1/ops/tenants/ten_second/cap", { cap: 1 })).json.error.code, "cap_invalid");
  assert.equal((await browserCall("op_0001", "POST", "/v1/ops/tenants/ten_second/kimi-policy", { required: true })).status, 404, "Kimi 账号绑定已撤下");
});

// ─── 第 44 批：运营控制台重做后的门禁（静态页约束不放松）与浏览器侧密码学 ─────────────────
const consoleDir = join(root, "apps/console");
const CONSOLE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https: http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'none'; form-action 'none'";
const consoleModules = () => [
  ...readdirSync(consoleDir).filter((f) => f.endsWith(".js")),
  ...readdirSync(join(consoleDir, "pages")).filter((f) => f.endsWith(".js")).map((f) => `pages/${f}`),
];

test("第 44 批控制台门禁：CSP 不变、无内联脚本与样式、不引外部资源、不拼 HTML、不用 style 属性与 window.confirm", () => {
  const html = readFileSync(join(consoleDir, "index.html"), "utf8");
  assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="${CONSOLE_CSP}" />`), "页内兜底 CSP 原样不变");
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 1, "只有一个入口脚本");
  assert.match(scripts[0]![1]!, /type="module"/);
  assert.match(scripts[0]![1]!, /src="app\.js"/);
  assert.equal(scripts[0]![2]!.trim(), "", "无内联脚本");
  assert.doesNotMatch(html, /<style\b/i, "无内联样式块");
  assert.doesNotMatch(html, /\sstyle\s*=/i, "无 style 属性");
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, "无内联事件");
  assert.doesNotMatch(html, /\b(?:src|href)\s*=\s*"(?:https?:)?\/\//i, "不引外部资源");
  assert.deepEqual([...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]), ["tokens.css", "console.css"], "先令牌、后控制台样式");

  const mods = consoleModules();
  for (const need of ["app.js", "api.js", "ui.js", "ops-sign.js", "seal-key.js", "keystore.js", "domain.js"]) assert.ok(mods.includes(need), `缺 ${need}`);
  assert.equal(mods.filter((f) => f.startsWith("pages/")).length, 9, "九个页面各一个模块");
  assert.equal(existsSync(join(consoleDir, "console.js")), false, "旧的单文件 console.js 已拆分");
  const bad = (f: string, src: string, re: RegExp, why: string) => assert.ok(!re.test(src), `${f} ${why}：${re.exec(src)?.[0] ?? ""}`);
  for (const f of mods) {
    const src = readFileSync(join(consoleDir, f), "utf8");
    bad(f, src, /\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write|\beval\s*\(|new Function\b|createContextualFragment|DOMParser/, "不拼 HTML、不动态求值");
    bad(f, src, /setAttribute\(\s*["']style["']/, "不写 style 属性");
    bad(f, src, /\.style\.(?!cssText\b)/, "动态样式只经 el.style.cssText");
    bad(f, src, /\bwindow\.(?:confirm|alert|prompt)\b|(?<![\w.$])(?:confirm|alert|prompt)\s*\(/, "不用 window.confirm / alert / prompt");
    bad(f, src, /\bfrom\s+["'](?!\.\.?\/)|\bimport\s*\(\s*["'](?!\.\.?\/)|\bimport\s+["'](?!\.\.?\/)/, "只引本地相对模块");
    bad(f, src, /fetch\(\s*["'`](?:https?:)?\/\/|\.(?:src|href|action)\s*=\s*["'`](?:https?:)?\/\/|\b(?:src|href|action):\s*["'`](?:https?:)?\/\/|new (?:WebSocket|EventSource|Worker)\(/, "不从外部取资源、不开别的连接");
    if (f !== "app.js") bad(f, src, /localStorage\s*\.|localStorage\s*\[/, "不碰 localStorage（只有 app.js 记主题与运营编号）");
    if (f !== "seal-key.js") bad(f, src, /exportKey\s*\(/, "不导出任何密钥（只有 seal-key.js 导出临时公钥）");
  }
  const ks = readFileSync(join(consoleDir, "keystore.js"), "utf8");
  assert.match(ks, /indexedDB/);
  assert.match(ks, /extractable !== false/, "记住前核对不可导出");

  const css = readFileSync(join(consoleDir, "console.css"), "utf8");
  const tokens = readFileSync(join(root, "packages/design-tokens/src/tokens.css"), "utf8");
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i, "控制台样式不写颜色字面量");
  assert.doesNotMatch(css, /@import|url\(/i, "不引外部样式与资源");
  assert.doesNotMatch(css, /var\(--p-/, "不直接用基础色板");
  const defined = new Set([...tokens.matchAll(/(--[a-z0-9-]+)\s*:/g), ...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const used = [...new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))];
  // --w / --l / --h 由 cssVars() 在运行时写入（带缺省值）
  assert.deepEqual(used.filter((v) => !defined.has(v) && !["--w", "--l", "--h"].includes(v!)), [], "引用的令牌都已定义");
  const own = [...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]);
  assert.ok(own.every((v) => v!.startsWith("--console-")), `控制台自加的令牌须以 --console- 开头：${own.join(",")}`);
});

test("build-console：dist 含 tokens.css（与桌面端同一份）、页面与全部模块；引用都在 dist 内", async () => {
  // @ts-expect-error 构建脚本（纯 JS，无类型声明）
  const { buildConsole, verifyDist } = await import("../../../scripts/build-console.mjs");
  const out = join(dir, "dist-check");
  const files = buildConsole(out).map((f: { path: string }) => f.path);
  assert.deepEqual(files, ["config.example.json", "console.css", "index.html", "tokens.css", ...consoleModules()].sort());
  assert.ok(readFileSync(join(out, "tokens.css")).equals(readFileSync(join(root, "packages/design-tokens/src/tokens.css"))));
  assert.deepEqual(verifyDist(out), []);
  const ex = JSON.parse(readFileSync(join(out, "config.example.json"), "utf8"));
  assert.ok("routing_public_key" in ex && "routing_key_id" in ex, "示例配置写明网关路由公钥两项");
});

test("上游密钥浏览器加密与主文 §3.2 一致：网关私钥能解开；换上游编号（aad / info）解不开；只出尾号", async () => {
  // @ts-expect-error 浏览器模块（纯 JS，无类型声明）
  const { sealUpstreamKey, keyHint, SEAL_ALG } = await import("../../../apps/console/seal-key.js");
  const { createDecipheriv, diffieHellman, hkdfSync } = await import("node:crypto");
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const plain = "sk-upstream-test-0123456789abcd";
  const sealed = await sealUpstreamKey({ publicKey: spki, kid: "rk-test", providerId: "csi-maas", plaintext: plain });
  assert.deepEqual(Object.keys(sealed).sort(), ["alg", "ct", "epk", "iv", "kid"]);
  assert.equal(sealed.alg, "ECDH-P256+HKDF-SHA256+A256GCM");
  assert.equal(SEAL_ALG, sealed.alg);
  assert.equal(sealed.kid, "rk-test");
  assert.equal(JSON.stringify(sealed).includes(plain), false, "密文里没有明文");
  const open = (providerId: string) => {
    const epk = Buffer.from(sealed.epk, "base64url");
    assert.equal(epk.length, 65);
    assert.equal(epk[0], 4, "未压缩点");
    const pub = createPublicKey({ key: { kty: "EC", crv: "P-256", x: epk.subarray(1, 33).toString("base64url"), y: epk.subarray(33).toString("base64url") }, format: "jwk" });
    const shared = diffieHellman({ privateKey: pair.privateKey, publicKey: pub });
    const key = Buffer.from(hkdfSync("sha256", shared, Buffer.from("kwl-upstream-key/1"), Buffer.from(providerId), 32));
    const iv = Buffer.from(sealed.iv, "base64url");
    assert.equal(iv.length, 12);
    const ct = Buffer.from(sealed.ct, "base64url");
    const d = createDecipheriv("aes-256-gcm", key, iv);
    d.setAAD(Buffer.from(`kwl-upstream-key/1\n${providerId}`));
    d.setAuthTag(ct.subarray(ct.length - 16));
    return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString("utf8");
  };
  assert.equal(open("csi-maas"), plain);
  assert.throws(() => open("other-maas"), "换了上游编号就解不开");
  assert.equal(keyHint(plain), "…abcd");
  await assert.rejects(sealUpstreamKey({ publicKey: spki, kid: "rk-test", providerId: "csi-maas", plaintext: "short" }), /太短/);
  await assert.rejects(sealUpstreamKey({ publicKey: "bm90LWEta2V5", kid: "rk-test", providerId: "csi-maas", plaintext: plain }), /P-256/);
});

test("记住 8 小时只收不可导出的私钥对象；签名路径含查询串（URLSearchParams 生成一次，签名与请求共用）", async () => {
  // @ts-expect-error 浏览器模块（纯 JS，无类型声明）
  const { rememberKey } = await import("../../../apps/console/keystore.js");
  // @ts-expect-error 浏览器模块（纯 JS，无类型声明）
  const { qs } = await import("../../../apps/console/api.js");
  const extractable = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as unknown as { privateKey: CryptoKey; publicKey: CryptoKey };
  await assert.rejects(rememberKey({ operator: "op_0001", kid: "k1", key: extractable.privateKey, deployment: "x", base: "https://cp" }), /不可导出/);
  const k = await importOpsKey(OPS.keyOf("op_0001").privateKeyPem);
  assert.equal(await rememberKey({ operator: "op_0001", kid: "k1", key: k, deployment: "x", base: "https://cp" }), false, "没有标签页存储（Node）时静默不记");

  assert.equal(qs("/v1/ops/accounts", { q: "张 三", tid: "", status: undefined, limit: 50 }), "/v1/ops/accounts?q=%E5%BC%A0+%E4%B8%89&limit=50");
  assert.equal(qs("/v1/ops/plans", {}), "/v1/ops/plans");
  const r = await browserCall("op_0001", "GET", qs("/v1/ops/accounts", { q: "张 三", limit: 5 }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(Array.isArray(r.json.accounts));
});
