/**
 * v9.3 A-10 运营按人鉴权，经生产入口（scripts/cloud-serve.mjs）与最小运营命令行（scripts/ops-cli.mjs）端到端：
 * 安全管理员生成名册签名密钥、运营人员各自生成密钥 → 名册登记 → 运营用自己的私钥开通租户、发开通码 → 律所可见的流水记到运营编号；
 * 吊销某人即时生效、回滚旧名册失败关闭（重启后仍不认）；共享运营口令配置、/0 网段、被改过的名册一律拒绝启动；运维网段以外的来源 404。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../../scripts/cloud-serve.mjs", import.meta.url));
const cliScript = fileURLToPath(new URL("../../../scripts/ops-cli.mjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "kwl-cloud-ops-"));
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
  const r = spawnSync(process.execPath, [cliScript, ...args], { encoding: "utf8", timeout: 30_000 });
  const last = r.stdout.trim().split("\n").at(-1) ?? "";
  let json: any = null;
  try {
    json = JSON.parse(r.stdout.trim().startsWith("{\n") ? r.stdout : last);
  } catch {
    json = null;
  }
  return { status: r.status, json, stderr: r.stderr };
};
function start(cfg: unknown): Promise<{ port: number; proc: ChildProcess }> {
  const proc = spawn(process.execPath, [script, "--config", cfgFile(cfg)], { stdio: ["ignore", "pipe", "pipe"] });
  kids.push(proc);
  return new Promise((ok, no) => {
    let out = "";
    proc.stdout!.on("data", (d) => {
      out += d;
      const m = /已就绪（http 仅测试 [^:]+:(\d+)/.exec(out);
      if (m) ok({ port: Number(m[1]), proc });
    });
    proc.stderr!.on("data", (d) => (out += d));
    proc.on("exit", (c) => no(new Error(`退出 ${c}：${out}`)));
  });
}
const stop = (p: ChildProcess) => new Promise<void>((r) => (p.exitCode !== null ? r() : (p.once("exit", () => r()), p.kill("SIGTERM"))));
const httpGet = (port: number, path: string) =>
  new Promise<number>((ok, no) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      res.resume();
      ok(res.statusCode ?? 0);
    });
    req.on("error", no);
    req.end();
  });
const lines = (p: string) => (existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

test("运营按人鉴权端到端：命令行生成密钥与名册 → 生产入口按人核验 → 流水记运营编号；吊销即时、回滚失败关闭；配置不对拒绝启动", { timeout: 120_000 }, async () => {
  // ─── 安全管理员与两位运营人员各自生成密钥 ───
  const sec = cli("roster-keygen", "--kid", "sec-1", "--out", join(dir, "sec"));
  assert.equal(sec.status, 0, sec.stderr);
  assert.match(sec.json.fingerprint, /^[A-Za-z0-9_-]{16}$/);
  assert.equal(readFileSync(sec.json.private_key, "utf8").includes("PRIVATE KEY"), true);
  assert.equal(cli("keygen", "--id", "zhangsan", "--kid", "k1", "--out", join(dir, "x")).status, 2, "运营编号须为工号形态，不用姓名");
  for (const id of ["op_0001", "op_0002"]) assert.equal(cli("keygen", "--id", id, "--kid", "k1", "--out", join(dir, id)).status, 0);
  assert.equal(cli("keygen", "--id", "op_0001", "--kid", "k1", "--out", join(dir, "op_0001")).status, 2, "不覆盖已有私钥");
  const roster = join(dir, "ops-roster.json");
  const signArgs = ["--sign-key", join(dir, "sec", "sec-1.key.pem"), "--sign-kid", "sec-1", "--out", roster];
  assert.equal(cli("roster", "add", "--roster", roster, "--id", "op_0001", "--perms", "tenant.read,tenant.manage,activation.issue", "--pub", join(dir, "op_0001", "op_0001.k1.pub.pem"), ...signArgs).status, 0);
  assert.equal(cli("roster", "add", "--roster", roster, "--id", "op_0002", "--perms", "tenant.read", "--pub", join(dir, "op_0002", "op_0002.k1.pub.pem"), ...signArgs).status, 0);
  const rosterKeys = join(dir, "sec", "ops-roster-keys.json");
  const shown = cli("roster", "show", "--roster", roster, "--keys", rosterKeys);
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.json.version, 2);
  assert.deepEqual(shown.json.operators.map((o: any) => [o.id, o.status, o.perms.length]), [["op_0001", "active", 3], ["op_0002", "active", 1]]);
  assert.equal(JSON.stringify(shown.json).includes("PRIVATE"), false);
  // 用别的名册签名密钥改名册：命令行拒绝在来历不明的名册上修改
  const other = cli("roster-keygen", "--kid", "sec-x", "--out", join(dir, "secx"));
  assert.equal(cli("roster", "perms", "--roster", roster, "--id", "op_0002", "--perms", "tenant.manage", "--sign-key", other.json.private_key, "--sign-kid", "sec-1", "--out", join(dir, "evil.json")).status, 1);
  const v2 = join(dir, "ops-roster-v2.json");
  copyFileSync(roster, v2);

  // ─── 生产入口配置 ───
  const pem = (k: { privateKey: { export(o: object): string | Buffer } }) => String(k.privateKey.export({ format: "pem", type: "pkcs8" }));
  const cpCfg = (dataDir: string, ops: unknown) => ({
    role: "control-plane",
    listen: { host: "127.0.0.1", port: 0 },
    insecure_loopback_for_test: true,
    service_secret_file: write(`ss-${dataDir}`, randomBytes(32).toString("hex")),
    data_dir: join(dir, dataDir),
    envelope_key: { kid: "cp-t1", private_key_file: write(`env-${dataDir}.pem`, pem(generateKeyPairSync("ed25519"))) },
    seat_key: { kid: "seat-t1", private_key_file: write(`seat-${dataDir}.pem`, pem(generateKeyPairSync("ed25519"))) },
    state_key_file: write(`state-${dataDir}.key`, randomBytes(32).toString("hex")),
    code_pepper_file: write(`pep-${dataDir}.key`, randomBytes(32).toString("hex")),
    ...(ops === undefined ? {} : { ops }),
  });
  const ops = { roster_file: roster, roster_keys_file: rosterKeys, allow_cidrs: ["127.0.0.1/32"] };
  // 拒绝启动：共享运营口令配置、没有运营接口的角色配 ops、/0 网段、被改过的名册
  assert.match(runOnce({ ...cpCfg("r1", ops), ops_secret_file: write("ops-secret", randomBytes(32).toString("hex")) }).stderr, /ops_secret_file 已停用/);
  assert.match(runOnce({ role: "dist", listen: { host: "127.0.0.1", port: 0 }, insecure_loopback_for_test: true, ops }).stderr, /dist 没有运营接口/);
  assert.match(runOnce(cpCfg("r2", { ...ops, allow_cidrs: ["0.0.0.0/0"] })).stderr, /不许 \/0/);
  assert.match(runOnce(cpCfg("r3", { ...ops, allow_cidrs: [] })).stderr, /运维网段/);
  const tampered = JSON.parse(readFileSync(roster, "utf8"));
  tampered.body.operators[1].perms = ["tenant.read", "tenant.manage"];
  assert.match(runOnce(cpCfg("r4", { ...ops, roster_file: write("tampered.json", JSON.stringify(tampered)) })).stderr, /运营名册不可用（roster_signature_invalid）/);

  const cp = await start(cpCfg("cp", ops));
  const url = `http://127.0.0.1:${cp.port}`;
  const call = (id: string, method: string, path: string, body?: unknown) =>
    cli("call", "--url", url, "--aud", "control-plane", "--id", id, "--kid", "k1", "--key", join(dir, id, `${id}.k1.key.pem`), "--method", method, "--path", path, ...(body === undefined ? [] : ["--body", JSON.stringify(body)]));
  const created = call("op_0001", "POST", "/v1/ops/tenants", { tid: "ten_e2e", edition: "team", seats: 3, name: "端到端律师事务所" });
  assert.equal(created.json?.status, 200, JSON.stringify(created));
  const code = call("op_0001", "POST", "/v1/ops/tenants/ten_e2e/activation-codes", { slug: "admin" });
  assert.equal(code.json.status, 200);
  assert.match(code.json.body.code, /\S{10,}/);
  const denied = call("op_0002", "POST", "/v1/ops/tenants/ten_e2e/renew", { days: 10 });
  assert.deepEqual([denied.status, denied.json.status, denied.json.body.error.code], [1, 403, "ops_permission_denied"]);
  assert.equal(call("op_0002", "GET", "/v1/ops/tenants/ten_e2e").json.status, 200);
  // 律所可见的运营审计流水：执行者为运营编号；内部访问审计与被拒记录在 ops/
  const cpDir = join(dir, "cp", "control-plane");
  assert.deepEqual(lines(join(cpDir, "audit.jsonl")).filter((r) => r.tid === "ten_e2e").map((r) => [r.action, r.actor.id]), [["tenant.create", "op_0001"], ["activation.issue", "op_0001"]]);
  const acc = lines(join(cpDir, "ops", "access.jsonl"));
  assert.ok(acc.some((r) => r.operator === "op_0002" && r.op_key === "k1" && r.action === "tenant.read" && r.result === "ok"));
  assert.ok(lines(join(cpDir, "ops", "rejects.jsonl")).some((r) => r.claimed === "op_0002" && r.reason === "ops_permission_denied"));
  assert.equal(readFileSync(join(cpDir, "ops", "access.jsonl"), "utf8").includes(code.json.body.code), false, "访问审计不记开通码");

  // ─── 吊销 op_0001（不重启即生效）───
  assert.equal(cli("roster", "revoke", "--roster", roster, "--id", "op_0001", ...signArgs).status, 0);
  const gone = call("op_0001", "GET", "/v1/ops/tenants/ten_e2e");
  assert.deepEqual([gone.json.status, gone.json.body.error.code], [401, "ops_operator_unknown_or_revoked"]);
  assert.equal(call("op_0002", "GET", "/v1/ops/tenants/ten_e2e").json.status, 200);
  // 回滚到 v2（op_0001 仍有效的那一版）：整组失败关闭；重启后同样不认
  const v3 = join(dir, "ops-roster-v3.json");
  copyFileSync(roster, v3);
  copyFileSync(v2, roster);
  assert.deepEqual([call("op_0001", "GET", "/v1/ops/tenants/ten_e2e").json.status, call("op_0002", "GET", "/v1/ops/tenants/ten_e2e").json.status], [503, 503]);
  await stop(cp.proc);
  assert.match(runOnce(cpCfg("cp", ops)).stderr, /运营名册不可用（roster_rollback）/, "重启后回滚保护仍在");
  copyFileSync(v3, roster);

  // ─── 运维网段以外的来源：运营路径在入口就 404（不进服务），其他路径照常 ───
  const far = await start(cpCfg("far", { ...ops, allow_cidrs: ["10.20.0.0/24", "fd00::/8"] }));
  const r = cli("call", "--url", `http://127.0.0.1:${far.port}`, "--aud", "control-plane", "--id", "op_0002", "--kid", "k1", "--key", join(dir, "op_0002", "op_0002.k1.key.pem"), "--method", "GET", "--path", "/v1/ops/tenants/ten_e2e");
  assert.equal(r.json.status, 404);
  assert.equal(lines(join(dir, "far", "control-plane", "ops", "rejects.jsonl")).length, 0, "被入口挡下，没有进到运营守卫");
  assert.equal(await httpGet(far.port, "/healthz"), 200);
  // 没有配置 ops 的控制面：运营路径一律 404
  const plain = await start(cpCfg("plain", undefined));
  assert.equal(await httpGet(plain.port, "/v1/ops/tenants/ten_e2e"), 404);
});
