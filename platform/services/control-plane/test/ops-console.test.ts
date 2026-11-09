/**
 * 第 37 批：网页运营控制台与部署工具。
 * - 控制台的浏览器签名（apps/ops-console/ops-sign.js，WebCrypto）与控制面运营守卫逐字节兼容：明文与口令加密的 PKCS#8 私钥都能用；
 * - 新增只读接口：租户列表、按租户用量（按席位只给席位编号，不给成员标识与姓名；律所设的上限只给“律所管理员”）；
 * - 生产入口的 ops.console_origins：只对列出的来源回 CORS 头与预检；配置不合规拒绝启动；运维网段以外照样 404；
 * - 部署工具：cloud-init-secrets 生成的密钥能直接拉起签名服务与控制面；make-release-config 生成的 release.json 过客户端校验；
 *   meter-report 按网关同一规则重算点数、按 requestId 去重。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateOpsKeyPair } from "@zr-legal/ops-auth";
import { devOpsRoster, fileOpsGuard } from "@zr-legal/ops-auth/testing";
import { createControlPlane, devControlPlaneKeys, type ControlPlane } from "../src/index.ts";
// @ts-expect-error 浏览器模块（纯 JS，无类型声明）
import { importOpsKey, signOpsRequest } from "../../../apps/ops-console/ops-sign.js";

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

test("租户列表与用量明细：只读权限；按席位只给席位编号，不给成员标识与姓名；律所设的上限只标“律所管理员”", async () => {
  await browserCall("op_0001", "POST", "/v1/ops/tenants", { tid: "ten_second", edition: "firm", seats: 10, name: "第二所" });
  const list = await browserCall("op_0001", "GET", "/v1/ops/tenants");
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.tenants.map((t: any) => t.tid), ["ten_console", "ten_second"]);
  assert.equal(list.json.tenants[0].quota.used_ratio, 0);
  assert.deepEqual(list.json.tenants[0].quota.plan, { id: "standard", label: "标准", custom: false });
  assert.equal((await browserCall("op_0003", "GET", "/v1/ops/tenants")).status, 403, "只能发码的人不能看租户列表");

  // 造一点用量：两个席位（一个已收回），律所管理员设的上限（设备编号里含成员标识）
  const t = cp.ops.tenant("ten_console")!;
  t.seatsByUser.set("zhang.lawyer", { sid: "seat_aaa", uid: "zhang.lawyer", assigned_at: new Date().toISOString(), revoked_at: null });
  t.seatsByUser.set("li.lawyer", { sid: "seat_bbb", uid: "li.lawyer", assigned_at: new Date().toISOString(), revoked_at: new Date().toISOString() });
  t.quota.period_by_seat = { seat_aaa: { points: 120, requests: 3 }, seat_bbb: { points: 400, requests: 9 } };
  t.quota.period_used = 520;
  t.quota.cap_pct = 90;
  t.quota.cap_set_by = "dev_zhang.lawyer_01";
  const u = await browserCall("op_0001", "GET", "/v1/ops/tenants/ten_console/usage");
  assert.equal(u.status, 200, JSON.stringify(u.json));
  // 第 40 批：比例为主（标准套餐 3 席 = 600000 单位，个人份额 200000）；单位只为对账
  assert.deepEqual(u.json.units, { total: 600_000, used: 520 });
  assert.equal(u.json.used_ratio, 0.0009);
  assert.deepEqual(u.json.by_seat, [
    { sid: "seat_bbb", status: "revoked", used_ratio: 0.002, firm_ratio: 0.0007, requests: 9, kimi: null },
    { sid: "seat_aaa", status: "active", used_ratio: 0.0006, firm_ratio: 0.0002, requests: 3, kimi: null },
  ]);
  assert.deepEqual(u.json.seats, { total: 3, assigned: 1 });
  assert.equal(u.json.cap_set_by, "firm_admin");
  assert.equal(JSON.stringify(u.json).includes("lawyer"), false, "用量明细不带成员标识");
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

test("meter-report：按租户 × 月份（北京时间）× 席位汇总，点数按网关规则重算，多实例文件按 requestId 去重", () => {
  const recs = [
    { at: "2026-10-31T16:30:00.000Z", kind: "settle", requestId: "r1", tid: "ten_a", sid: "seat_1", model: "legal/k3", status: 200, reserved: 40, inputTokens: 9000, outputTokens: 1000, cachedTokens: 2000, reason: null },
    { at: "2026-11-02T02:00:00.000Z", kind: "settle", requestId: "r2", tid: "ten_a", sid: "seat_1", model: "legal/k3", status: 200, reserved: 40, inputTokens: null, outputTokens: null, cachedTokens: null, reason: null },
    { at: "2026-11-02T03:00:00.000Z", kind: "settle", requestId: "r3", tid: "ten_a", sid: "seat_2", model: "legal/k3", status: 504, reserved: 40, inputTokens: null, outputTokens: null, cachedTokens: null, reason: "upstream_header_timeout" },
    { at: "2026-11-02T03:00:00.000Z", kind: "reserve", requestId: "r4", tid: "ten_a", sid: "seat_2", model: "legal/k3", status: null, reserved: 40 },
    { at: "2026-10-15T03:00:00.000Z", kind: "settle", requestId: "r5", tid: "ten_b", sid: "seat_9", model: "legal/k2.6", status: 200, reserved: 10, inputTokens: 1500, outputTokens: 0, cachedTokens: 0, reason: null },
  ];
  const f1 = write("meter-1.jsonl", recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const f2 = write("meter-2.jsonl", `${JSON.stringify(recs[0])}\nnot json\n`);
  const r = spawnSync(process.execPath, [join(root, "scripts/meter-report.mjs"), f1, f2, "--format", "json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const rows = JSON.parse(r.stdout).rows;
  const row = (tid: string, period: string, sid: string) => rows.find((x: any) => x.tid === tid && x.period === period && x.sid === sid);
  // r1：UTC 10-31 16:30 = 北京 11-01 00:30 → 11 月；(9000+1000)/1000×4 = 40 点
  assert.equal(row("ten_a", "2026-11", "seat_1").points, 40 + 40, "r1 按 usage 40 点 + r2 无 usage 而 200 按预占 40 点");
  assert.equal(row("ten_a", "2026-11", "seat_1").requests, 2, "重复的 r1 去重");
  assert.equal(row("ten_a", "2026-11", "seat_2").points, 0, "上游超时不扣");
  assert.equal(row("ten_a", "2026-11", "seat_2").timeouts, 1);
  assert.equal(row("ten_b", "2026-10", "seat_9").points, 3, "1500/1000×2 向上取整");
  assert.match(r.stderr, /跳过 1 行/);
  const t = spawnSync(process.execPath, [join(root, "scripts/meter-report.mjs"), f1, "--by", "tenant", "--month", "2026-11"], { encoding: "utf8" });
  assert.equal(t.stdout.trim(), "tid,period,requests,ok,errors,timeouts,input_tokens,output_tokens,cached_tokens,points\nten_a,2026-11,3,2,1,1,9000,1000,2000,80");
});


test("第 40 批运营接口：套餐目录；改套餐与席位（不得少于在用席位）；加量包按百分比、计入账单；旧的点数接口 410；没配 Kimi 对接不能要求绑定", async () => {
  const plans = await browserCall("op_0001", "GET", "/v1/ops/plans");
  assert.equal(plans.status, 200);
  assert.deepEqual(plans.json.plans.map((p: any) => p.id), ["standard", "pro", "max"]);
  assert.equal(plans.json.kimi_account, false);
  assert.equal((await browserCall("op_0003", "GET", "/v1/ops/plans")).status, 403, "只能发码的人看不到目录");

  const t = cp.ops.tenant("ten_second")!;
  // 改套餐：标准 → 旗舰，额度即刻按新套餐算
  const ch = await browserCall("op_0001", "POST", "/v1/ops/tenants/ten_second/plan", { plan: "max" });
  assert.equal(ch.status, 200, JSON.stringify(ch.json));
  assert.deepEqual(ch.json.tenant.quota.units, { total: 10 * 1_200_000, used: 0 });
  assert.equal((await browserCall("op_0001", "POST", "/v1/ops/tenants/ten_second/plan", { plan: "gold" })).json.error.code, "plan_unknown");
  assert.equal((await browserCall("op_0001", "POST", "/v1/ops/tenants/ten_second/plan", {})).json.error.code, "plan_invalid");
  // 席位数不得少于在用席位
  t.seatsByUser.set("a", { sid: "seat_s1", uid: "a", assigned_at: new Date().toISOString(), revoked_at: null });
  t.seatsByUser.set("b", { sid: "seat_s2", uid: "b", assigned_at: new Date().toISOString(), revoked_at: null });
  const low = await browserCall("op_0001", "POST", "/v1/ops/tenants/ten_second/plan", { seats: 1 });
  assert.deepEqual([low.status, low.json.error.code], [409, "seats_in_use"]);
  assert.equal((await browserCall("op_0001", "POST", "/v1/ops/tenants/ten_second/plan", { seats: 4 })).status, 200);
  assert.equal(t.license.seats, 4, "许可随席位数重签");
  // 加量包
  const b = await browserCall("op_0001", "POST", "/v1/ops/tenants/ten_second/boost", { pct: 50 });
  assert.equal(b.status, 200);
  assert.equal(b.json.quota.boost_pct, 50);
  assert.deepEqual(b.json.quota.units, { total: 4 * 1_200_000 * 1.5, used: 0 });
  const u = await browserCall("op_0001", "GET", "/v1/ops/tenants/ten_second/usage");
  assert.deepEqual(u.json.boosts.map((x: any) => [x.pct, x.by]), [[50, "op_0001"]]);
  assert.deepEqual(u.json.bill, { seat_fee_cny: null, boost_fee_cny: null, revenue_cny: null, cost_cny: null, margin_cny: null }, "缺省目录没有价格");
  assert.equal(u.json.by_seat.length, 2, "没有用量的在用席位也列出");
  // 旧接口与旧字段
  assert.deepEqual([(await browserCall("op_0001", "POST", "/v1/ops/tenants/ten_second/points", { points: 1 })).status], [410]);
  assert.equal((await browserCall("op_0001", "POST", "/v1/ops/tenants/ten_second/cap", { cap: 1 })).json.error.code, "cap_invalid");
  // 没配 Kimi 对接：不能要求绑定；可以设为不强制
  assert.equal((await browserCall("op_0001", "POST", "/v1/ops/tenants/ten_second/kimi-policy", { required: true })).json.error.code, "kimi_account_disabled");
  assert.equal((await browserCall("op_0001", "POST", "/v1/ops/tenants/ten_second/kimi-policy", { required: false })).status, 200);
});
