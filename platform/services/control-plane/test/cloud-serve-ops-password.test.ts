/**
 * 账号 + 密码登录经生产入口（scripts/cloud-serve.mjs）与运营命令行（scripts/ops-cli.mjs）端到端：
 * 安全管理员把人登记进名册（--password-only 不带公钥）→ 控制面启动后再用 `password set` 发初始密码（凭据库改写即生效、不重启）→
 * 控制台跨源预检放行 Authorization 头 → 登录、须先改密码、改后可用 → `password reset` 让已有登录失效；
 * 密码登录配到别的服务上拒绝启动；password_login: false 时登录 404。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../../scripts/cloud-serve.mjs", import.meta.url));
const cliScript = fileURLToPath(new URL("../../../scripts/ops-cli.mjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "kwl-cloud-ops-pw-"));
const kids: ChildProcess[] = [];
after(() => {
  for (const k of kids) k.kill("SIGTERM");
});
const write = (name: string, content: string) => {
  const p = join(dir, name);
  writeFileSync(p, content, { mode: 0o600 });
  return p;
};
const cfgFile = (cfg: unknown) => write(`c-${Math.random().toString(36).slice(2)}.json`, JSON.stringify(cfg));
const runOnce = (cfg: unknown) => spawnSync(process.execPath, [script, "--config", cfgFile(cfg)], { encoding: "utf8", timeout: 30_000 });
const cli = (...args: string[]) => {
  const r = spawnSync(process.execPath, [cliScript, ...args], { encoding: "utf8", timeout: 40_000 });
  let json: any = null;
  try {
    json = JSON.parse(r.stdout.trim().startsWith("{\n") ? r.stdout : (r.stdout.trim().split("\n").at(-1) ?? ""));
  } catch {
    json = null;
  }
  return { status: r.status, json, stderr: r.stderr };
};
function start(cfg: unknown): Promise<{ port: number; proc: ChildProcess; out: () => string }> {
  const proc = spawn(process.execPath, [script, "--config", cfgFile(cfg)], { stdio: ["ignore", "pipe", "pipe"] });
  kids.push(proc);
  return new Promise((ok, no) => {
    let out = "";
    proc.stdout!.on("data", (d) => {
      out += d;
      const m = /已就绪（http 仅测试 [^:]+:(\d+)/.exec(out);
      if (m) ok({ port: Number(m[1]), proc, out: () => out });
    });
    proc.stderr!.on("data", (d) => (out += d));
    proc.on("exit", (c) => no(new Error(`退出 ${c}：${out}`)));
  });
}
const once = (name: string) => (existsSync(join(dir, name)) ? join(dir, name) : write(name, randomBytes(32).toString("hex")));

test("账号密码登录端到端：名册登记（不带公钥）→ 启动后发初始密码即生效 → 跨源预检放行 Authorization → 首次改密码 → 重置使已有登录失效", { timeout: 180_000 }, async () => {
  const keysFile = join(dir, "pub", "ops-roster-keys.json");
  assert.equal(cli("roster-keygen", "--kid", "sec-1", "--out", join(dir, "sec"), "--keys-file", keysFile).status, 0);
  const roster = join(dir, "ops-roster.json");
  const signArgs = ["--sign-key", join(dir, "sec", "sec-1.key.pem"), "--sign-kid", "sec-1"];
  assert.equal(cli("roster", "init", "--deployment", "e2e", ...signArgs, "--out", roster).status, 0);
  const add = cli("roster", "add", "--roster", roster, "--id", "op_0101", "--perms", "tenant.read,tenant.manage", "--password-only", ...signArgs, "--out", roster);
  assert.equal(add.status, 0, add.stderr);
  assert.deepEqual(add.json.changes, ["add op_0101 password-only"]);
  assert.equal(cli("roster", "add", "--roster", roster, "--id", "op_0102", "--perms", "tenant.read", "--password-only", ...signArgs, "--out", roster).status, 0);

  const pem = (k: { privateKey: { export(o: object): string | Buffer } }) => String(k.privateKey.export({ format: "pem", type: "pkcs8" }));
  const env1 = generateKeyPairSync("ed25519");
  const seat1 = generateKeyPairSync("ed25519");
  const secret = write("ss", randomBytes(32).toString("hex"));
  const signer = await start({ role: "cp-signer", environment: "test", init_ledger: true, listen: { host: "127.0.0.1", port: 0 }, insecure_loopback_for_test: true, data_dir: join(dir, "signer"), keys: { envelope: { kid: "cp-test-t1", private_key_file: write("env.pem", pem(env1)) }, seat: { kid: "seat-test-t1", private_key_file: write("seat.pem", pem(seat1)) } } });
  const cpCfg = (dataDir: string, ops: Record<string, unknown>) => ({ role: "control-plane", listen: { host: "127.0.0.1", port: 0 }, insecure_loopback_for_test: true, service_secret_file: secret, data_dir: join(dir, dataDir), signer: { url: `http://127.0.0.1:${signer.port}` }, state_key_file: once(`state-${dataDir}.key`), code_pepper_file: once(`pep-${dataDir}.key`), ops });
  const CONSOLE = "http://127.0.0.1:5999";
  const ops = { deployment: "e2e", roster_file: roster, roster_keys_file: keysFile, allow_cidrs: ["127.0.0.1/32"], console_origins: [CONSOLE] };
  // 密码登录只开在控制面
  const cpKeysFile = write("cp-keys.json", JSON.stringify({ "cp-test-t1": String(env1.publicKey.export({ format: "pem", type: "spki" })) }));
  const seatKeysFile = write("seat-keys.json", JSON.stringify({ "seat-test-t1": String(seat1.publicKey.export({ format: "pem", type: "spki" })) }));
  assert.match(runOnce({ role: "notify", listen: { host: "127.0.0.1", port: 0 }, insecure_loopback_for_test: true, service_secret_file: secret, control_plane: { url: "http://127.0.0.1:1", keys_file: cpKeysFile }, seat_keys_file: seatKeysFile, data_dir: join(dir, "nf"), ops: { ...ops, console_origins: undefined, password_login: true } }).stderr, /密码登录只开在控制面/);
  assert.match(runOnce(cpCfg("bad", { ...ops, password_login: "yes" })).stderr, /password_login 须为 true \/ false/);

  const cp = await start(cpCfg("cp", ops));
  assert.match(cp.out(), /运营凭据库为空/);
  const credFile = join(dir, "cp", "control-plane", "ops", "credentials.json");
  const url = `http://127.0.0.1:${cp.port}`;
  const post = async (path: string, body: unknown, token?: string) => {
    const r = await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: CONSOLE, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as any, cors: r.headers.get("access-control-allow-origin") };
  };
  const get = async (path: string, token: string) => {
    const r = await fetch(`${url}${path}`, { headers: { origin: CONSOLE, authorization: `Bearer ${token}` } });
    return { status: r.status, json: (await r.json()) as any };
  };
  assert.equal((await post("/v1/ops/login", { login: "zhang", password: "Whatever-2026-x" })).status, 401, "还没发密码：一律账号或密码不对");

  // 启动后再发初始密码：凭据库改写即生效（不重启）
  const set = cli("password", "set", "--credentials", credFile, "--id", "op_0101", "--login", "zhang", "--roster", roster, "--keys", keysFile);
  assert.equal(set.status, 0, set.stderr);
  assert.equal(set.json.roster_checked, true);
  assert.match(set.json.initial_password, /^[A-Za-z0-9]{5}(-[A-Za-z0-9]{5}){3}$/);
  assert.equal(statSync(credFile).mode & 0o777, 0o600);
  assert.equal(readFileSync(credFile, "utf8").includes(set.json.initial_password), false);
  assert.equal(cli("password", "set", "--credentials", credFile, "--id", "op_0999", "--login", "ghost", "--roster", roster, "--keys", keysFile).status, 1, "不在名册的人不发密码");

  // 跨源预检：放行 Authorization 头
  const pre = await fetch(`${url}/v1/ops/login`, { method: "OPTIONS", headers: { origin: CONSOLE, "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" } });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get("access-control-allow-headers") ?? "", /\bauthorization\b/);
  assert.equal(pre.headers.get("access-control-allow-origin"), CONSOLE);

  const a = await post("/v1/ops/login", { login: "zhang", password: set.json.initial_password });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal(a.cors, CONSOLE);
  assert.equal(a.json.must_change, true);
  assert.equal((await get("/v1/ops/tenants", a.json.token)).json.error.code, "password_change_required");
  assert.equal((await post("/v1/ops/password", { current: set.json.initial_password, next: "Ops-new-secret-2026x" }, a.json.token)).status, 200);
  assert.equal((await get("/v1/ops/tenants", a.json.token)).status, 200);
  const created = await post("/v1/ops/tenants", { tid: "ten_pwe2e", edition: "team", seats: 2, name: "账号密码律所" }, a.json.token);
  assert.equal(created.status, 200, JSON.stringify(created.json) + " ");
  const cpDir = join(dir, "cp", "control-plane");
  const lines = (p: string) => readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines(join(cpDir, "audit.jsonl")).filter((r) => r.tid === "ten_pwe2e").map((r) => [r.action, r.actor.id]), [["tenant.create", "op_0101"]], "律所可见的流水记运营编号");
  const acc = lines(join(cpDir, "ops", "access.jsonl"));
  assert.ok(acc.some((r) => r.action === "ops.login" && r.operator === "op_0101" && r.result === "ok" && r.via === "password"));
  assert.ok(acc.some((r) => r.action === "tenant.create" && r.op_key === "password" && r.result === "ok"));
  assert.equal(readFileSync(join(cpDir, "ops", "access.jsonl"), "utf8").includes("Ops-new-secret"), false);

  // 安全管理员重置：已有登录即失效；新初始密码须再改
  const reset = cli("password", "reset", "--credentials", credFile, "--id", "op_0101");
  assert.equal(reset.status, 0, reset.stderr);
  const gone = await get("/v1/ops/tenants", a.json.token);
  assert.deepEqual([gone.status, gone.json.error.code], [401, "ops_session_invalid"]);
  const b = await post("/v1/ops/login", { login: "zhang", password: reset.json.initial_password });
  assert.deepEqual([b.status, b.json.must_change], [200, true]);
  assert.equal(cli("password", "disable", "--credentials", credFile, "--id", "op_0101").status, 0);
  assert.equal((await get("/v1/ops/me", b.json.token)).status, 401, "停用即失效");
  assert.equal((await post("/v1/ops/login", { login: "zhang", password: reset.json.initial_password })).json.error.code, "ops_login_invalid");

  // 关掉密码登录：只认私钥签名
  const off = await start(cpCfg("cp-off", { ...ops, password_login: false }));
  const r = await fetch(`http://127.0.0.1:${off.port}/v1/ops/login`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 404);
});
