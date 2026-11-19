/**
 * 第 37 批：网页运营控制台与部署工具。
 * - 新增只读接口：租户列表、按租户用量（按席位只给席位编号，不给成员标识与姓名；律所设的上限只给“律所管理员”）；
 * - 生产入口的 ops.console_origins：只对列出的来源回 CORS 头与预检；配置不合规拒绝启动；运维网段以外照样 404；
 * - 部署工具：cloud-init-secrets 生成的密钥能直接拉起签名服务与控制面；
 *   meter-report 按网关同一规则重算点数、按 requestId 去重。
 * 第 46 批：控制台重做为统一云端控制台（apps/console），静态页门禁、打包、浏览器内加密与 QR 的用例在 console-ui.test.ts；
 *   make-release-config（客户端 release.json 生成工具，依赖桌面端校验代码）的用例挪到 apps/desktop/test/release-config-tool.test.ts。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createControlPlane, devControlPlaneKeys, type ControlPlane } from "../src/index.ts";
import { devStaffOf, staffClient } from "./staff-fixture.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "kwl-ops-console-"));
let cp: ControlPlane;
let base = "";
const kids: ChildProcess[] = [];

before(async () => {
  // 第 46 批：控制面运营接口用平台人员会话（op_0001 客户运营、op_0003 开通专员）
  cp = createControlPlane({ keys: devControlPlaneKeys(), serviceSecret: "ops-console-test-service-secret", staffMfa: "optional", devStaff: devStaffOf({ op_0001: ["operator"], op_0003: ["issuer"] }), opsAccessLog: () => {} });
  cp.ops.createTenant({ tid: "ten_console", edition: "team", seats: 3 });
  await new Promise<void>((r) => cp.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(cp.server.address() as AddressInfo).port}`;
});
after(async () => {
  for (const k of kids) k.kill("SIGTERM");
  cp.server.closeAllConnections();
  await new Promise<void>((r) => cp.server.close(() => r()));
});

/** 和控制台页面同一条路：Bearer 会话调运营接口（第 46 批起不再用浏览器私钥签名）。 */
const staffOps = staffClient(() => base);
const browserCall = async (who: string, method: string, path: string, body?: unknown, at = base, extra: Record<string, string> = {}) => {
  const tok = await staffOps.tokenOf(who);
  const raw = body === undefined ? "" : JSON.stringify(body);
  const r = await fetch(`${at}${path}`, { method, headers: { authorization: `Bearer ${tok}`, ...extra, ...(raw ? { "content-type": "application/json" } : {}) }, ...(raw ? { body: raw } : {}) });
  return { status: r.status, json: (await r.json()) as any, headers: r.headers };
};

test("租户列表与用量明细（第 44 批 v2）：只读权限；用量从账本出、按对外单位与比例；没有账号的成员不外露成员标识；律所设的上限只标“律所管理员”", async () => {
  await browserCall("op_0001", "POST", "/v1/ops/tenants", { tid: "ten_second", edition: "firm", seats: 10, name: "第二所" });
  const list = await browserCall("op_0001", "GET", "/v1/ops/tenants");
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.tenants.map((t: any) => t.tid).sort(), ["ten_console", "ten_second"]);
  const row = list.json.tenants.find((t: any) => t.tid === "ten_console");
  assert.deepEqual([row.used_ratio, row.unit, row.plan.id, row.total], [0, "tokens", "standard", 3 * 50_000_000]);
  assert.equal((await browserCall("op_0003", "POST", "/v1/ops/tenants", { tid: "ten_third", edition: "team", seats: 1 })).status, 403, "开通专员不能开通（职责分离）");
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

test("cloud-init-secrets 的密钥直接拉起签名服务与控制面；console.origins（ops.console_origins 为别名）只对列出的来源、只对控制台用到的路径回 CORS；不合规的来源拒绝启动", { timeout: 120_000 }, async () => {
  const out = join(dir, "init");
  const g = spawnSync(process.execPath, [join(root, "scripts/cloud-init-secrets.mjs"), "--env", "test", "--out", out, "--id", "t1", "--mount", join(out, "secrets")], { encoding: "utf8" });
  assert.equal(g.status, 0, g.stderr);
  assert.equal(spawnSync(process.execPath, [join(root, "scripts/cloud-init-secrets.mjs"), "--env", "test", "--out", out], { encoding: "utf8" }).status, 1, "不覆盖已有目录");
  const cpKeys = JSON.parse(readFileSync(join(out, "public/cp-public-keys.json"), "utf8"));
  assert.deepEqual(Object.keys(cpKeys), ["cp-test-t1", "cp-test-t2"], "控制面公钥表含当前与下一把");
  assert.equal(readFileSync(join(out, "public/seat-public-keys.json"), "utf8").includes("PRIVATE"), false);

  const signer = await start({ role: "cp-signer", environment: "test", init_ledger: true, listen: { host: "127.0.0.1", port: 0 }, insecure_loopback_for_test: true, data_dir: join(dir, "signer"), keys: JSON.parse(readFileSync(join(out, "public/signer-keys.json"), "utf8")) });
  const sec = (f: string) => join(out, "secrets", f);
  const ADMIN = "boot@csi.example.cn";
  const cpCfg = (o: { origins?: unknown; alias?: unknown }, tag = "cp") => ({
    role: "control-plane",
    listen: { host: "127.0.0.1", port: 0 },
    insecure_loopback_for_test: true,
    service_secret_file: sec("service-secret"),
    data_dir: join(dir, tag),
    signer: { url: `http://127.0.0.1:${signer.port}` },
    state_key_file: sec("cp-state.key"),
    code_pepper_file: sec("cp-code-pepper.key"),
    ops: { deployment: "test", allow_cidrs: ["127.0.0.1/32"], ...(o.alias === undefined ? {} : { console_origins: o.alias }) },
    console: { bootstrap_admin: { email: ADMIN, name: "引导" }, staff_mfa: "optional", ...(o.origins === undefined ? {} : { origins: o.origins }) },
  });
  for (const bad of [["*"], ["https://ops.example/"], ["https://ops.example/console"], ["http://ops.example"], []]) {
    assert.match(spawnSync(process.execPath, [script, "--config", cfgFile(cpCfg({ origins: bad }, "bad"))], { encoding: "utf8", timeout: 30_000 }).stderr, /console\.origins/, `拒绝 ${JSON.stringify(bad)}`);
    assert.match(spawnSync(process.execPath, [script, "--config", cfgFile(cpCfg({ alias: bad }, "bad"))], { encoding: "utf8", timeout: 30_000 }).stderr, /ops\.console_origins/, `别名同样拒绝 ${JSON.stringify(bad)}`);
  }

  const ORIGIN = "http://127.0.0.1:4173";
  const { port } = await start(cpCfg({ origins: [ORIGIN] }));
  const at = `http://127.0.0.1:${port}`;
  const pre = (path: string, origin = ORIGIN) => fetch(`${at}${path}`, { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" } });
  for (const path of ["/v1/auth/login", "/v1/auth/mfa/verify", "/v1/auth/me", "/v1/me/usage", "/v1/firm/overview", "/v1/meta", "/v1/ops/tenants"]) {
    const r = await pre(path);
    assert.equal(r.status, 204, path);
    assert.equal(r.headers.get("access-control-allow-origin"), ORIGIN, path);
    assert.equal(r.headers.get("access-control-allow-headers"), "content-type, authorization", path);
    assert.equal(r.headers.get("access-control-allow-credentials"), null, "不带凭据");
  }
  // 设备签名接口、订阅、额度租约与入账、健康检查：不回 CORS
  for (const path of ["/v1/seat-token", "/v1/feed/gateway", "/v1/quota/lease", "/v1/quota/settle", "/v1/directory", "/healthz"]) {
    const r = await pre(path);
    assert.notEqual(r.status, 204, path);
    assert.equal(r.headers.get("access-control-allow-origin"), null, path);
  }
  assert.notEqual((await pre("/v1/auth/login", "http://127.0.0.1:9999")).status, 204, "没列出的来源不放行预检");
  const meta = await fetch(`${at}/v1/meta`, { headers: { origin: ORIGIN } });
  assert.equal(meta.headers.get("access-control-allow-origin"), ORIGIN);
  assert.match(meta.headers.get("access-control-expose-headers") ?? "", /content-disposition/);
  assert.equal(((await meta.json()) as any).registration, "code", "生产入口新状态的注册缺省 code");
  // 引导的系统管理员设密码、登录；运营接口的错误回复也带允许头（页面要读到原因）
  const boot = /setup_code: (\S+)/.exec(readFileSync(join(dir, "cp", "control-plane", "bootstrap-admin.txt"), "utf8"))![1];
  const json = (b: unknown) => ({ method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(b) });
  assert.equal((await fetch(`${at}/v1/auth/password-reset/confirm`, json({ email: ADMIN, code: boot, password: "Console2026secure" }))).status, 200);
  const login = await fetch(`${at}/v1/auth/login`, json({ email: ADMIN, password: "Console2026secure", client: { platform: "web" } }));
  assert.equal(login.headers.get("access-control-allow-origin"), ORIGIN);
  const tok = ((await login.json()) as any).session_token as string;
  const ok = await fetch(`${at}/v1/ops/tenants`, { headers: { origin: ORIGIN, authorization: `Bearer ${tok}` } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("access-control-allow-origin"), ORIGIN);
  const denied = await fetch(`${at}/v1/ops/tenants`, { headers: { origin: ORIGIN } });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get("access-control-allow-origin"), ORIGIN, "错误回复也带允许头");
  const other = await fetch(`${at}/v1/ops/tenants`, { headers: { origin: "http://127.0.0.1:9999", authorization: `Bearer ${tok}` } });
  assert.equal(other.headers.get("access-control-allow-origin"), null, "没列出的来源不回允许头");
  const health = await fetch(`${at}/healthz`, { headers: { origin: ORIGIN } });
  assert.equal(health.headers.get("access-control-allow-origin"), null);
  // 旧名 ops.console_origins 仍认作别名（同样覆盖账号路径）
  const ORIGIN2 = "http://127.0.0.1:4174";
  const alias = await start(cpCfg({ alias: [ORIGIN2] }, "cp-alias"));
  const ar = await fetch(`http://127.0.0.1:${alias.port}/v1/auth/login`, { method: "OPTIONS", headers: { origin: ORIGIN2, "access-control-request-method": "POST" } });
  assert.deepEqual([ar.status, ar.headers.get("access-control-allow-origin")], [204, ORIGIN2]);
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
  assert.equal((await browserCall("op_0003", "POST", "/v1/ops/tenants/ten_second/plan", { plan: "max" })).status, 403, "开通专员不能改套餐");
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
  assert.deepEqual(u.json.boosts.map((x: any) => [x.pct, x.by]), [[50, cp.ops.staff("op0001@csi.example.cn")!.aid]]);
  const d = await browserCall("op_0001", "GET", "/v1/ops/tenants/ten_second");
  assert.deepEqual([d.json.bill.seat_fee_cny, d.json.bill.revenue_cny], [null, null], "缺省目录没有价格");
  assert.equal((await browserCall("op_0001", "POST", "/v1/ops/tenants/ten_second/points", { points: 1 })).status, 410);
  assert.equal((await browserCall("op_0001", "POST", "/v1/ops/tenants/ten_second/cap", { cap: 1 })).json.error.code, "cap_invalid");
  assert.equal((await browserCall("op_0001", "POST", "/v1/ops/tenants/ten_second/kimi-policy", { required: true })).status, 404, "Kimi 账号绑定已撤下");
});
