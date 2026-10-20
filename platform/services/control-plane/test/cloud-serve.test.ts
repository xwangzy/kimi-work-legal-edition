/**
 * 云端生产入口（第 13 批；评审 Z4 P0-4、P0-7）：scripts/cloud-serve.mjs 没有开发缺省——
 * 无 TLS、无吊销订阅、无真实上游密钥、控制面状态未封装一律拒绝启动；按配置起控制面与检索服务（HTTPS），检索服务从控制面
 * 取到签名的吊销集后才就绪，未带席位令牌的请求被拒（处理函数确实挂在 HTTPS 服务上）。证书为本用例临时生成的自签名证书。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../../scripts/cloud-serve.mjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "kwl-cloud-serve-"));
const kids: ChildProcess[] = [];
after(() => {
  for (const k of kids) k.kill("SIGTERM");
});

const write = (name: string, content: string) => {
  const p = join(dir, name);
  writeFileSync(p, content, { mode: 0o600 });
  return p;
};
const cfgFile = (name: string, cfg: unknown) => write(name, JSON.stringify(cfg));
const runOnce = (cfg: unknown) => spawnSync(process.execPath, [script, "--config", cfgFile(`c-${Math.random().toString(36).slice(2)}.json`, cfg)], { encoding: "utf8", timeout: 30_000 });

function start(cfg: unknown, env: NodeJS.ProcessEnv = {}): Promise<{ port: number; proc: ChildProcess; out: () => string }> {
  const proc = spawn(process.execPath, [script, "--config", cfgFile(`s-${Math.random().toString(36).slice(2)}.json`, cfg)], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  kids.push(proc);
  return new Promise((ok, no) => {
    let out = "";
    proc.stdout!.on("data", (d) => {
      out += d;
      const m = /已就绪（https [^:]+:(\d+)/.exec(out);
      if (m) ok({ port: Number(m[1]), proc, out: () => out });
    });
    proc.stderr!.on("data", (d) => (out += d));
    proc.on("exit", (c) => no(new Error(`退出 ${c}：${out}`)));
  });
}

function httpsGet(port: number, path: string, ca: string): Promise<{ status: number; body: string }> {
  return new Promise((ok, no) => {
    const req = request({ host: "127.0.0.1", port, path, method: "POST", ca, headers: { "content-type": "application/json" } }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => ok({ status: res.statusCode ?? 0, body: b }));
    });
    req.on("error", no);
    req.end("{}");
  });
}

function httpsCall(port: number, method: string, path: string, ca: string): Promise<{ status: number; body: string }> {
  return new Promise((ok, no) => {
    const req = request({ host: "127.0.0.1", port, path, method, ca }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => ok({ status: res.statusCode ?? 0, body: b }));
    });
    req.on("error", no);
    req.end();
  });
}

function httpGet(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((ok, no) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => ok({ status: res.statusCode ?? 0, body: b }));
    });
    req.on("error", no);
    req.end();
  });
}

const haveOpenssl = spawnSync("openssl", ["version"]).status === 0;

test("密钥文件强度（复核 A-15 余项）：真随机的值都通过；重复、递增、单一字符类、占位词、字节过于集中一律拒绝", async () => {
  // @ts-expect-error 脚本工具模块（.mjs，无类型声明）
  const { weakSecretReason } = await import("../../../scripts/lib/secret-strength.mjs");
  for (let i = 0; i < 3000; i++) {
    assert.equal(weakSecretReason(randomBytes(32).toString("hex"), "hex32"), null);
    assert.equal(weakSecretReason(randomBytes(32).toString("hex"), "random32"), null);
    assert.equal(weakSecretReason(randomBytes(32).toString("base64url"), "random32"), null);
    assert.equal(weakSecretReason(randomBytes(48).toString("base64url"), "random32"), null);
  }
  const weak: [string, "hex32" | "random32", RegExp][] = [
    ["0".repeat(64), "hex32", /重复/],
    ["0123456789abcdef".repeat(4), "random32", /重复/],
    ["deadbeef".repeat(8), "hex32", /重复/],
    ["a1".repeat(32), "hex32", /重复/],
    [`0123456789${randomBytes(27).toString("hex")}`, "hex32", /连续递增/],
    ["1234567890".repeat(6) + "1234", "hex32", /连续递增|重复/],
    ["9".repeat(30) + "8".repeat(34), "hex32", /只有数字/],
    ["abcdef".repeat(10) + "abcd", "hex32", /只有字母/],
    ["changeme-changeme-changeme-changeme-changeme", "random32", /占位词/],
    ["my-service-secret-for-kimi-work-legal-prod-2026", "random32", /占位词/],
    ["thisisalowercaseonlyphrasewithnouppercaseatall", "random32", /大写与小写/],
    // 只从 8 个字节值里随机挑（不重复成段、数字字母都有）：取值过于集中
    [Array.from(randomBytes(32), (b) => ["1a", "2b", "3c", "4d", "5e", "6f", "70", "81"][b & 7]).join(""), "hex32", /集中/],
    ["short", "random32", /至少 32 字节/],
    ["g".repeat(64), "hex32", /32 字节十六进制/],
  ];
  for (const [v, kind, why] of weak) assert.match(String(weakSecretReason(v, kind)), why, `${v.slice(0, 24)}… 应被拒绝`);
});

test("拒绝启动：缺 TLS、缺吊销订阅、缺真实上游密钥、角色不对；测试例外只许回环", () => {
  const noTls = runOnce({ role: "dist", listen: { host: "0.0.0.0", port: 18443 } });
  assert.notEqual(noTls.status, 0);
  assert.match(noTls.stderr, /只接受 HTTPS/);
  const badLoop = runOnce({ role: "dist", listen: { host: "0.0.0.0", port: 18443 }, insecure_loopback_for_test: true });
  assert.match(badLoop.stderr, /只许监听 127\.0\.0\.1/);
  const noFeed = runOnce({ role: "gateway", listen: { host: "127.0.0.1", port: 18443 }, insecure_loopback_for_test: true, service_secret_file: write("ss0", "x") });
  assert.match(noFeed.stderr, /control_plane\.url/);
  assert.match(runOnce({ role: "nope", listen: { port: 1 } }).stderr, /role 须为/);
});

test("按配置起控制面与检索服务（HTTPS）：检索服务取到签名吊销集后就绪；未带席位令牌的请求被拒", { skip: !haveOpenssl && "本机没有 openssl", timeout: 90_000 }, async () => {
  const r = spawnSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", join(dir, "tls.key"), "-out", join(dir, "tls.crt"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const ca = readFileSync(join(dir, "tls.crt"), "utf8");
  const pem = (k: { privateKey: { export(o: object): string | Buffer } }) => String(k.privateKey.export({ format: "pem", type: "pkcs8" }));
  const env1 = generateKeyPairSync("ed25519");
  const seat1 = generateKeyPairSync("ed25519");
  const secret = write("service-secret", randomBytes(32).toString("hex"));
  const tls = { cert_file: join(dir, "tls.crt"), key_file: join(dir, "tls.key") };
  // 控制面状态未封装：拒绝
  const unsealed = runOnce({ role: "control-plane", listen: { host: "127.0.0.1", port: 0 }, tls, service_secret_file: secret, data_dir: dir, envelope_key: { kid: "cp-t1", private_key_file: write("env.pem", pem(env1)) }, seat_key: { kid: "seat-t1", private_key_file: write("seat.pem", pem(seat1)) } });
  assert.match(unsealed.stderr, /state_key_file/);
  // 开通码胡椒缺失、服务间凭据太弱：拒绝（复核 A-15）
  const cpBase = { role: "control-plane", listen: { host: "127.0.0.1", port: 0 }, tls, data_dir: dir, envelope_key: { kid: "cp-t1", private_key_file: join(dir, "env.pem") }, seat_key: { kid: "seat-t1", private_key_file: join(dir, "seat.pem") }, state_key_file: write("state0.key", randomBytes(32).toString("hex")) };
  assert.match(runOnce({ ...cpBase, service_secret_file: secret }).stderr, /code_pepper_file/);
  assert.match(runOnce({ ...cpBase, service_secret_file: write("weak", "short-secret"), code_pepper_file: write("pep0", randomBytes(32).toString("hex")) }).stderr, /service_secret_file 须为至少 32 字节/);
  // 格式对、但明显是手填的低熵值：服务间凭据、胡椒、状态封装密钥一律拒绝（第 14 批第二轮复核 A 余项）
  assert.match(runOnce({ ...cpBase, service_secret_file: write("weak2", "0123456789abcdef".repeat(4)), code_pepper_file: join(dir, "pep0") }).stderr, /service_secret_file 由同一片段重复而成/);
  assert.match(runOnce({ ...cpBase, service_secret_file: secret, code_pepper_file: write("pep-weak", "0".repeat(64)) }).stderr, /code_pepper_file 由同一片段重复而成/);
  assert.match(runOnce({ ...cpBase, state_key_file: write("state-weak", "9".repeat(32) + "8".repeat(32)), service_secret_file: secret, code_pepper_file: join(dir, "pep0") }).stderr, /state_key_file .*不是随机生成/);
  const cp = await start({
    role: "control-plane",
    listen: { host: "127.0.0.1", port: 0 },
    tls,
    service_secret_file: secret,
    data_dir: dir,
    envelope_key: { kid: "cp-t1", private_key_file: join(dir, "env.pem") },
    seat_key: { kid: "seat-t1", private_key_file: join(dir, "seat.pem") },
    state_key_file: write("state.key", randomBytes(32).toString("hex")),
    code_pepper_file: write("pepper.key", randomBytes(32).toString("hex")),
  });
  const cpKeys = write("cp-keys.json", JSON.stringify({ "cp-t1": String(env1.publicKey.export({ format: "pem", type: "spki" })) }));
  const seatKeys = write("seat-keys.json", JSON.stringify({ "seat-t1": String(seat1.publicKey.export({ format: "pem", type: "spki" })) }));
  // 检索服务：控制面公钥不对 → 首次取不到吊销集 → 拒绝启动
  const wrongKeys = write("cp-keys-wrong.json", JSON.stringify({ "cp-t1": String(generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" })) }));
  const noLogs = { role: "search", listen: { host: "127.0.0.1", port: 0 }, tls, service_secret_file: secret, control_plane: { url: `https://127.0.0.1:${cp.port}`, keys_file: cpKeys }, seat_keys_file: seatKeys, upstream: { api_key_file: write("upstream.key", "sk-test-not-used") } };
  // 可观测性（A-9）：没有日志位置拒绝启动；指标监听在回环以外又没有令牌也拒绝
  assert.match(spawnSync(process.execPath, [script, "--config", cfgFile("search-nolog.json", noLogs)], { encoding: "utf8", env: { ...process.env, NODE_EXTRA_CA_CERTS: join(dir, "tls.crt") }, timeout: 30_000 }).stderr, /log_dir 或 data_dir/);
  const logDir = join(dir, "search-obs");
  const metricsToken = randomBytes(32).toString("hex");
  const base = { ...noLogs, log_dir: logDir, metrics: { host: "127.0.0.1", port: 0, token_file: write("metrics.token", metricsToken) } };
  assert.match(spawnSync(process.execPath, [script, "--config", cfgFile("search-metrics-open.json", { ...base, metrics: { host: "0.0.0.0", port: 0 } })], { encoding: "utf8", env: { ...process.env, NODE_EXTRA_CA_CERTS: join(dir, "tls.crt") }, timeout: 30_000 }).stderr, /metrics\.token_file/);
  const bad = spawnSync(process.execPath, [script, "--config", cfgFile("search-bad.json", { ...base, control_plane: { ...base.control_plane, keys_file: wrongKeys } })], { encoding: "utf8", env: { ...process.env, NODE_EXTRA_CA_CERTS: join(dir, "tls.crt") }, timeout: 30_000 });
  assert.match(bad.stderr, /首次取不到控制面吊销集/);
  const search = await start(base, { NODE_EXTRA_CA_CERTS: join(dir, "tls.crt") });
  const res = await httpsGet(search.port, `/search?q=${encodeURIComponent("张三借款")}`, ca);
  assert.equal(res.status, 401, res.body);
  // 健康检查由入口应答；指标在单独的监听上、要令牌
  assert.deepEqual(await httpsCall(search.port, "GET", "/healthz", ca), { status: 200, body: '{"ok":true}' });
  assert.equal((await httpsCall(search.port, "GET", "/readyz", ca)).status, 200);
  const metricsPort = Number(/指标 (\d+)/.exec(search.out())?.[1]);
  assert.ok(metricsPort > 0, search.out());
  assert.equal((await httpGet(metricsPort, "/metrics")).status, 401);
  const m = await httpGet(metricsPort, "/metrics", { authorization: `Bearer ${metricsToken}` });
  assert.equal(m.status, 200);
  assert.match(m.body, /kwl_requests_total\{role="search",code_class="4xx"\} 1/);
  assert.match(m.body, /kwl_feed_age_seconds\{role="search"\}/);
  assert.match(m.body, /kwl_tls_cert_expiry_seconds\{role="search"\} \d+/);
  // 访问日志：只有白名单字段，查询串里的内容不落盘
  await new Promise((r) => setTimeout(r, 100));
  const accessFile = readdirSync(logDir).find((f) => f.startsWith("access-"))!;
  const lines = readFileSync(join(logDir, accessFile), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.path === "/search" && l.status === 401));
  assert.ok(!readFileSync(join(logDir, accessFile), "utf8").includes(encodeURIComponent("张三")) && !readFileSync(join(logDir, accessFile), "utf8").includes("q="), "查询串不落盘");
});
