/**
 * v9.3 A-10 运营按人鉴权，经生产入口（scripts/cloud-serve.mjs）与最小运营命令行（scripts/ops-cli.mjs）端到端：
 * 安全管理员生成名册签名密钥、运营人员各自生成密钥 → 名册登记（只收公钥、核对指纹）→ 运营用自己的私钥开通租户、发开通码 →
 * 律所可见的流水记到运营编号；吊销即时生效、回滚旧名册运营接口 503（重启后仍不认，但业务照常启动）；
 * 共享运营口令配置、过宽网段、名册签名公钥表里放私钥一律拒绝启动；运维网段以外的来源在入口 404；通知服务经入口挂运营守卫。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
const PASS = "e2e-passphrase-for-op1";
const cli = (...args: string[]) => {
  const r = spawnSync(process.execPath, [cliScript, ...args], { encoding: "utf8", timeout: 40_000, env: { ...process.env, KWL_E2E_PASS: PASS } });
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
const stop = (p: ChildProcess) => new Promise<void>((r) => (p.exitCode !== null ? r() : (p.once("exit", () => r()), p.kill("SIGTERM"))));
/** 原样发出（不经 fetch 的规范化）：路径可以是点段或绝对形式。 */
const rawGet = (port: number, path: string, headers: Record<string, string> = {}) =>
  new Promise<{ status: number; body: string }>((ok, no) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => ok({ status: res.statusCode ?? 0, body: b }));
    });
    req.on("error", no);
    req.end();
  });
const once = (name: string) => (existsSync(join(dir, name)) ? join(dir, name) : write(name, randomBytes(32).toString("hex")));
const lines = (p: string) => (existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

test("运营按人鉴权端到端：命令行生成密钥与名册 → 生产入口按人核验 → 流水记运营编号；吊销即时、回滚运营接口 503 而业务照常；配置不对拒绝启动", { timeout: 180_000 }, async () => {
  // ─── 安全管理员与三位运营人员各自生成密钥 ───
  const keysFile = join(dir, "pub", "ops-roster-keys.json");
  const sec = cli("roster-keygen", "--kid", "sec-1", "--out", join(dir, "sec"), "--keys-file", keysFile);
  assert.equal(sec.status, 0, sec.stderr);
  assert.match(sec.json.fingerprint, /^[A-Za-z0-9_-]{16}$/);
  assert.equal(readFileSync(sec.json.private_key, "utf8").includes("PRIVATE KEY"), true);
  assert.equal(readFileSync(keysFile, "utf8").includes("PRIVATE"), false, "公钥表与离线私钥分开放");
  assert.equal(cli("keygen", "--id", "op_zhangsan", "--kid", "k1", "--out", join(dir, "x")).status, 2, "运营编号须为 op_ 加数字工号");
  const fp: Record<string, string> = {};
  for (const id of ["op_0001", "op_0002", "op_0003"]) {
    const r = cli("keygen", "--id", id, "--kid", "k1", "--out", join(dir, id), ...(id === "op_0001" ? ["--passphrase-env", "KWL_E2E_PASS"] : []));
    assert.equal(r.status, 0, r.stderr);
    fp[id] = r.json.fingerprint;
  }
  assert.match(readFileSync(join(dir, "op_0001", "op_0001.k1.key.pem"), "utf8"), /ENCRYPTED PRIVATE KEY/, "带口令的私钥加密落盘");
  assert.equal(cli("keygen", "--id", "op_0001", "--kid", "k1", "--out", join(dir, "op_0001")).status, 2, "不覆盖已有私钥");
  const roster = join(dir, "ops-roster.json");
  const signArgs = ["--sign-key", join(dir, "sec", "sec-1.key.pem"), "--sign-kid", "sec-1"];
  assert.equal(cli("roster", "add", "--roster", roster, "--id", "op_0001", "--perms", "tenant.read", "--pub", join(dir, "op_0001", "op_0001.k1.pub.pem"), "--fingerprint", fp.op_0001!, ...signArgs, "--out", roster).status, 2, "没有名册时不能 add（须先 init）");
  assert.equal(cli("roster", "init", "--deployment", "e2e", ...signArgs, "--out", roster).status, 0);
  assert.equal(cli("roster", "init", "--deployment", "e2e", ...signArgs, "--out", roster).status, 2, "init 不覆盖已有名册");
  const add = (id: string, perms: string, extra: string[] = []) => cli("roster", "add", "--roster", roster, "--id", id, "--perms", perms, "--pub", join(dir, id, `${id}.k1.pub.pem`), "--fingerprint", fp[id]!, ...signArgs, "--out", roster, ...extra);
  // 只收公钥、指纹须一致（复核 RA10A-01 / RA10B-01）
  const leaked = cli("roster", "add", "--roster", roster, "--id", "op_0002", "--perms", "tenant.read", "--pub", join(dir, "op_0002", "op_0002.k1.key.pem"), "--kid", "k1", "--fingerprint", fp.op_0002!, ...signArgs, "--out", roster);
  assert.equal(leaked.status, 2);
  assert.match(leaked.stderr, /不是公钥/);
  assert.equal(readFileSync(roster, "utf8").includes("PRIVATE"), false);
  assert.match(add("op_0002", "tenant.read", []).stderr, /^$/);
  assert.equal(cli("roster", "add", "--roster", roster, "--id", "op_0003", "--perms", "activation.issue", "--pub", join(dir, "op_0003", "op_0003.k1.pub.pem"), "--fingerprint", "AAAAAAAAAAAAAAAA", ...signArgs, "--out", roster).status, 2, "指纹不符");
  assert.equal(add("op_0003", "activation.issue,tenant.purge").status, 0);
  assert.equal(add("op_0001", "tenant.read,tenant.manage,activation.issue").status, 2, "开通与发码不能是同一人（职责冲突）");
  assert.equal(add("op_0001", "tenant.read,tenant.manage").status, 0);
  // --out 指向别的已有文件：不覆盖
  writeFileSync(join(dir, "other.json"), "{}");
  assert.equal(cli("roster", "renew", "--roster", roster, ...signArgs, "--out", join(dir, "other.json")).status, 2);
  const shown = cli("roster", "show", "--roster", roster, "--keys", keysFile);
  assert.equal(shown.status, 0, shown.stderr);
  assert.deepEqual([shown.json.deployment, shown.json.version], ["e2e", 4]);
  assert.deepEqual(shown.json.operators.map((o: any) => [o.id, o.status, o.keys[0].fingerprint]), [["op_0002", "active", fp.op_0002], ["op_0003", "active", fp.op_0003], ["op_0001", "active", fp.op_0001]]);
  // 用别的名册签名密钥改名册：命令行拒绝在来历不明的名册上修改
  const other = cli("roster-keygen", "--kid", "sec-x", "--out", join(dir, "secx"), "--keys-file", join(dir, "secx", "keys.json"));
  assert.equal(cli("roster", "perms", "--roster", roster, "--id", "op_0002", "--perms", "tenant.manage", "--sign-key", other.json.private_key, "--sign-kid", "sec-1", "--out", roster).status, 1);
  const v4 = join(dir, "ops-roster-v4.json");
  copyFileSync(roster, v4);

  // ─── 生产入口配置 ───
  const pem = (k: { privateKey: { export(o: object): string | Buffer } }) => String(k.privateKey.export({ format: "pem", type: "pkcs8" }));
  const env1 = generateKeyPairSync("ed25519");
  const seat1 = generateKeyPairSync("ed25519");
  const secret = write("ss", randomBytes(32).toString("hex"));
  const cpKeysFile = write("cp-keys.json", JSON.stringify({ "cp-t1": String(env1.publicKey.export({ format: "pem", type: "spki" })) }));
  const seatKeysFile = write("seat-keys.json", JSON.stringify({ "seat-t1": String(seat1.publicKey.export({ format: "pem", type: "spki" })) }));
  const cpCfg = (dataDir: string, ops: unknown) => ({
    role: "control-plane",
    listen: { host: "127.0.0.1", port: 0 },
    insecure_loopback_for_test: true,
    service_secret_file: secret,
    data_dir: join(dir, dataDir),
    envelope_key: { kid: "cp-t1", private_key_file: write("env.pem", pem(env1)) },
    seat_key: { kid: "seat-t1", private_key_file: write("seat.pem", pem(seat1)) },
    // 同一数据目录重启时沿用同一把状态封装密钥与胡椒
    state_key_file: once(`state-${dataDir}.key`),
    code_pepper_file: once(`pep-${dataDir}.key`),
    ...(ops === undefined ? {} : { ops }),
  });
  const ops = { deployment: "e2e", roster_file: roster, roster_keys_file: keysFile, allow_cidrs: ["127.0.0.1/32"] };
  // 拒绝启动：共享运营口令配置、没有运营接口的角色配 ops、过宽网段、缺部署标识、名册签名公钥表里放私钥（复核 RA10A-01、RA10A-10）
  assert.match(runOnce({ ...cpCfg("r1", ops), ops_secret_file: write("ops-secret", randomBytes(32).toString("hex")) }).stderr, /ops_secret_file 已停用/);
  assert.match(runOnce({ role: "dist", listen: { host: "127.0.0.1", port: 0 }, insecure_loopback_for_test: true, ops }).stderr, /dist 没有运营接口/);
  for (const bad of [["0.0.0.0/0"], ["0.0.0.0/1", "128.0.0.0/1"], ["10.0.0.0/7"]]) assert.match(runOnce(cpCfg("r2", { ...ops, allow_cidrs: bad })).stderr, /前缀长度不合法/, bad.join(","));
  assert.match(runOnce(cpCfg("r2", { ...ops, allow_cidrs: ["10.0.0.0/8", "11.0.0.0/8"] })).stderr, /合计覆盖过宽/);
  assert.match(runOnce(cpCfg("r3", { ...ops, allow_cidrs: [] })).stderr, /运维网段/);
  // 生产形态（TLS，不是回环测试例外）：回环、链路本地地址不能列为运维网段（前置代理、边车多在这些地址上）
  const tlsCfg = (allow: string[]) => ({ ...cpCfg("r6", { ...ops, allow_cidrs: allow }), insecure_loopback_for_test: undefined, listen: { host: "0.0.0.0", port: 0 }, tls: { cert_file: write("fake.crt", "x"), key_file: write("fake.key", "x") } });
  for (const bad of [["127.0.0.1/32"], ["169.254.1.0/24"], ["10.20.0.0/24", "::1"]]) assert.match(runOnce(tlsCfg(bad)).stderr, /含回环、未指定或链路本地地址/, bad.join(","));
  assert.match(runOnce(cpCfg("r3", { ...ops, deployment: undefined })).stderr, /ops\.deployment/);
  const privKeys = write("priv-keys.json", JSON.stringify({ "sec-1": readFileSync(join(dir, "sec", "sec-1.key.pem"), "utf8") }));
  assert.match(runOnce(cpCfg("r4", { ...ops, roster_keys_file: privKeys })).stderr, /不是公钥/);
  assert.match(runOnce(cpCfg("r4", { ...ops, roster_keys_file: write("not-json", "{") })).stderr, /不是 JSON/);
  // 被改过的名册：业务照常启动，运营接口 503（复核 RA10A-03），错误日志记一条
  const tampered = JSON.parse(readFileSync(roster, "utf8"));
  tampered.body.operators[0].perms = ["tenant.read", "tenant.manage"];
  const t5 = await start(cpCfg("r5", { ...ops, roster_file: write("tampered.json", JSON.stringify(tampered)) }));
  assert.match(t5.out(), /运营名册不可用（roster_signature_invalid）：运营接口暂停，业务照常/);
  assert.equal((await rawGet(t5.port, "/healthz")).status, 200);
  const errLog = readdirSync(join(dir, "r5", "obs")).find((f) => f.startsWith("error-"));
  assert.ok(errLog && lines(join(dir, "r5", "obs", errLog)).some((r) => r.kind === "ops_roster" && r.code === "roster_signature_invalid"));
  await stop(t5.proc);

  const cp = await start(cpCfg("cp", ops));
  const url = `http://127.0.0.1:${cp.port}`;
  const call = (id: string, method: string, path: string, body?: unknown, o: { aud?: string; at?: string } = {}) =>
    cli("call", "--url", o.at ?? url, "--deployment", "e2e", "--aud", o.aud ?? "control-plane", "--id", id, "--kid", "k1", "--key", join(dir, id, `${id}.k1.key.pem`), "--method", method, "--path", path, ...(body === undefined ? [] : ["--body", JSON.stringify(body)]), ...(id === "op_0001" ? ["--passphrase-env", "KWL_E2E_PASS"] : []));
  const created = call("op_0001", "POST", "/v1/ops/tenants", { tid: "ten_e2e", edition: "team", seats: 3, name: "端到端律师事务所" });
  assert.equal(created.json?.status, 200, JSON.stringify(created));
  const code = call("op_0003", "POST", "/v1/ops/tenants/ten_e2e/activation-codes", { slug: "admin" });
  assert.equal(code.json.status, 200);
  assert.match(code.json.body.code, /\S{10,}/);
  const denied = call("op_0002", "POST", "/v1/ops/tenants/ten_e2e/renew", { days: 10 });
  assert.deepEqual([denied.status, denied.json.status, denied.json.body.error.code], [1, 403, "ops_permission_denied"]);
  assert.equal(call("op_0002", "GET", "/v1/ops/tenants/ten_e2e").json.status, 200);
  assert.equal(cli("call", "--url", url, "--deployment", "e2e", "--aud", "billing", "--id", "op_0002", "--kid", "k1", "--key", join(dir, "op_0002", "op_0002.k1.key.pem"), "--path", "/v1/ops/tenants/ten_e2e").status, 2, "--aud 写错直接报错");
  assert.equal(cli("call", "--url", url, "--deployment", "e2e", "--aud", "control-plane", "--id", "op_0002", "--kid", "k1", "--key", join(dir, "op_0002", "op_0002.k1.key.pem"), "--method", "DELETE", "--path", "/v1/ops/x", "--body", "{}").status, 2, "DELETE 不带请求体");
  const cpDir = join(dir, "cp", "control-plane");
  assert.deepEqual(lines(join(cpDir, "audit.jsonl")).filter((r) => r.tid === "ten_e2e").map((r) => [r.action, r.actor.id]), [["tenant.create", "op_0001"], ["activation.issue", "op_0003"]]);
  const acc = lines(join(cpDir, "ops", "access.jsonl"));
  assert.ok(acc.some((r) => r.operator === "op_0002" && r.op_key === "k1" && r.roster_version === 4 && r.action === "tenant.read" && r.result === "ok"));
  assert.ok(lines(join(cpDir, "ops", "rejects.jsonl")).some((r) => r.claimed === "op_0002" && r.reason === "ops_permission_denied" && r.verified === true));
  assert.equal(readFileSync(join(cpDir, "ops", "access.jsonl"), "utf8").includes(code.json.body.code), false, "访问审计不记开通码");
  assert.deepEqual(lines(join(cpDir, "ops", "roster-history.jsonl")).map((r) => [r.event, r.version]), [["roster_accepted", 4]]);
  // 允许网段里发点段与绝对形式：入口认出是运营路径、放行，控制面按原样路径不认（404）
  for (const p of ["/v1/x/../ops/tenants/ten_e2e", `http://127.0.0.1:${cp.port}/v1/ops/tenants/ten_e2e`]) assert.equal((await rawGet(cp.port, p)).status, 404, p);

  // ─── 通知服务经生产入口挂运营守卫（复核 RA10B-12）───
  const notify = await start({ role: "notify", listen: { host: "127.0.0.1", port: 0 }, insecure_loopback_for_test: true, service_secret_file: secret, control_plane: { url, keys_file: cpKeysFile }, seat_keys_file: seatKeysFile, data_dir: join(dir, "nf"), ops });
  const nurl = `http://127.0.0.1:${notify.port}`;
  assert.equal(call("op_0002", "DELETE", "/v1/notify/ops/tenants/ten_e2e", undefined, { aud: "notify", at: nurl }).json.status, 403);
  assert.equal(call("op_0003", "DELETE", "/v1/notify/ops/tenants/ten_e2e", undefined, { aud: "control-plane", at: nurl }).json.status, 401, "签给控制面的不能拿到通知服务用");
  const purged = call("op_0003", "DELETE", "/v1/notify/ops/tenants/ten_e2e", undefined, { aud: "notify", at: nurl });
  assert.deepEqual([purged.json.status, purged.json.body], [200, { ok: true, removed: 0 }]);
  assert.deepEqual(lines(join(dir, "nf", "notify", "access.jsonl")).map((r) => [r.action, r.operator, r.roster_version]), [["tenant_purge", "op_0003", 4]]);
  await stop(notify.proc);

  // ─── 吊销 op_0001（不重启即生效）───
  assert.equal(cli("roster", "revoke", "--roster", roster, "--id", "op_0001", ...signArgs, "--out", roster).status, 0);
  assert.equal(cli("roster", "revoke", "--roster", roster, "--id", "op_0001", ...signArgs, "--out", roster).status, 2, "已吊销的不能再改（不覆盖吊销时刻）");
  const gone = call("op_0001", "GET", "/v1/ops/tenants/ten_e2e");
  assert.deepEqual([gone.json.status, gone.json.body.error.code], [401, "ops_auth_invalid"]);
  assert.equal(call("op_0002", "GET", "/v1/ops/tenants/ten_e2e").json.status, 200);
  // 回滚到 v4（op_0001 仍有效的那一版）：运营接口 503；重启后业务照常启动、运营接口仍 503
  const v5 = join(dir, "ops-roster-v5.json");
  copyFileSync(roster, v5);
  copyFileSync(v4, roster);
  assert.deepEqual([call("op_0001", "GET", "/v1/ops/tenants/ten_e2e").json.status, call("op_0002", "GET", "/v1/ops/tenants/ten_e2e").json.status], [503, 503]);
  await stop(cp.proc);
  const again = await start(cpCfg("cp", ops));
  assert.match(again.out(), /运营名册不可用（roster_rollback）/, "重启后回滚保护仍在");
  assert.equal(call("op_0001", "GET", "/v1/ops/tenants/ten_e2e", undefined, { at: `http://127.0.0.1:${again.port}` }).json.status, 503);
  copyFileSync(v5, roster);
  assert.equal(call("op_0002", "GET", "/v1/ops/tenants/ten_e2e", undefined, { at: `http://127.0.0.1:${again.port}` }).json.status, 200, "换回新名册即恢复");
  await stop(again.proc);

  // ─── 运维网段以外的来源：运营路径在入口就 404（不进服务），其他路径照常 ───
  const far = await start(cpCfg("far", { ...ops, allow_cidrs: ["10.20.0.0/24", "fd00::/32"] }));
  const r = call("op_0002", "GET", "/v1/ops/tenants/ten_e2e", undefined, { at: `http://127.0.0.1:${far.port}` });
  assert.deepEqual([r.json.status, r.json.body], [404, { error: "not_found" }], "入口的 404（不是控制面的“租户未开通”）");
  assert.equal(lines(join(dir, "far", "control-plane", "ops", "rejects.jsonl")).length, 0, "被入口挡下，没有进到运营守卫");
  assert.equal(lines(join(dir, "far", "control-plane", "ops", "access.jsonl")).length, 0, "也没有进到控制面的运营路由");
  assert.equal((await rawGet(far.port, `http://127.0.0.1:${far.port}/v1/ops/tenants/ten_e2e`)).body, '{"error":"not_found"}', "绝对形式同样在入口挡下");
  assert.equal((await rawGet(far.port, "/healthz")).status, 200);
  // 没有配置 ops 的控制面：运营路径一律 404
  const plain = await start(cpCfg("plain", undefined));
  assert.equal((await rawGet(plain.port, "/v1/ops/tenants/ten_e2e")).status, 404);
});
