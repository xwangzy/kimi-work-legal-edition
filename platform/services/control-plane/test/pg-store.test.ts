/**
 * 控制面状态存 PostgreSQL、防重放随机数存 Redis（v9.3 A-7 第一段；偏离 D-108）。用例临时起一个独立的 PostgreSQL 集群
 * （SCRAM 口令、只开 Unix 套接字）与一个 Redis（只开 Unix 套接字、要口令），跑完即停；本机没有 initdb / redis-server 时跳过。
 * - 线协议：SCRAM 认证、口令错误、参数不拼进 SQL、错误码；
 * - 状态存储：封装落库、重开读回、密钥不符拒绝；一主多备（备实例等锁、主实例走后接手并读到最新状态）；围栏（别的实例写过、连接被断）；
 * - 端到端：主实例“崩溃”（连接被断、没有正常关闭）后备实例接手：吊销仍在；只读请求的随机数只在内存与 Redis 里——
 *   接 Redis 的新主实例拒绝重放，不接 Redis 的对照实例放行（反向对照）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, sign } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDeviceKeys, generateFirmRoot, issueDeviceCertificate } from "@zr-legal/keys";
import { enrollProofBytes, openEnvelope, publicKeyMap, signDeviceRequest, type DirectoryBody } from "@zr-legal/firm-trust";
import {
  connectPg,
  connectRedis,
  createControlPlane,
  devControlPlaneKeys,
  openPgStateStore,
  openRedisNonceMirror,
  type ControlPlane,
  type PgConnOptions,
} from "../src/index.ts";

const which = (bin: string) => [process.env.PG_BIN ? join(process.env.PG_BIN, bin) : "", `/opt/homebrew/opt/postgresql@17/bin/${bin}`, `${process.env.HOME}/homebrew/opt/postgresql@17/bin/${bin}`, `/usr/lib/postgresql/17/bin/${bin}`]
  .filter(Boolean)
  .find((p) => existsSync(p)) ?? (spawnSync("which", [bin], { encoding: "utf8" }).stdout.trim() || null);
const initdb = which("initdb");
const pgCtl = which("pg_ctl");
const redisBin = spawnSync("which", ["redis-server"], { encoding: "utf8" }).stdout.trim() || null;
const skip = !initdb || !pgCtl || !redisBin ? "本机没有 PostgreSQL（initdb/pg_ctl）或 redis-server" : false;

const dir = mkdtempSync(join(tmpdir(), "kp-"));
// 生产入口要求口令至少 32 字节随机（与其他密钥文件同一检查）
const pgPassword = randomBytes(32).toString("hex");
const redisPassword = randomBytes(32).toString("hex");
const port = 20000 + Math.floor(Math.random() * 20000);
let redis: ChildProcess | null = null;
const pg = (database = "postgres"): PgConnOptions => ({ socketDir: dir, port, user: "kwl", password: pgPassword, database });
/** 每个用例一个库（同一库里只有一个控制面状态行）。 */
async function freshDb(name: string): Promise<string> {
  const c = await connectPg(pg());
  await c.query(`CREATE DATABASE ${name}`);
  await c.close();
  return name;
}
const redisOpts = () => ({ socketPath: join(dir, "r.sock"), password: redisPassword });

before(async () => {
  if (skip) return;
  writeFileSync(join(dir, "pw"), pgPassword);
  const init = spawnSync(initdb!, ["-D", join(dir, "data"), "-U", "kwl", "--auth=scram-sha-256", `--pwfile=${join(dir, "pw")}`, "-E", "UTF8", "--no-locale", "--no-instructions"], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", LANG: "C" } });
  assert.equal(init.status, 0, init.stderr);
  const st = spawnSync(pgCtl!, ["-D", join(dir, "data"), "-o", `-k ${dir} -p ${port} -c listen_addresses=''`, "-l", join(dir, "pg.log"), "-w", "start"], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", LANG: "C" } });
  assert.equal(st.status, 0, st.stderr);
  redis = spawn(redisBin!, ["--port", "0", "--unixsocket", join(dir, "r.sock"), "--save", "", "--appendonly", "no", "--requirepass", redisPassword], { stdio: "ignore" });
  for (let i = 0; i < 100 && !existsSync(join(dir, "r.sock")); i++) await new Promise((r) => setTimeout(r, 50));
});
after(() => {
  if (skip) return;
  spawnSync(pgCtl!, ["-D", join(dir, "data"), "-m", "immediate", "stop"], { encoding: "utf8" });
  redis?.kill("SIGTERM");
});

test("线协议：SCRAM-SHA-256 认证；口令错误被拒；参数单独传、不拼进 SQL；错误带 SQLSTATE", { skip }, async () => {
  const c = await connectPg(pg());
  try {
    const evil = "x'); DROP TABLE t; --";
    await c.query("CREATE TABLE IF NOT EXISTS t (v text)");
    await c.query("INSERT INTO t (v) VALUES ($1)", [evil]);
    const r = await c.query("SELECT v, $1::int + 1 AS n, NULL AS z FROM t", [41]);
    assert.deepEqual(r.fields, ["v", "n", "z"]);
    assert.deepEqual(r.rows[0], [evil, "42", null]);
    await assert.rejects(c.query("SELECT * FROM no_such_table"), (e: any) => e.code === "42P01");
    assert.equal((await c.query("SELECT 1")).rows[0]![0], "1", "出错之后连接仍可用");
  } finally {
    await c.close();
  }
  await assert.rejects(connectPg({ ...pg(), password: "wrong-password" }), (e: any) => e.code === "28P01");
  await assert.rejects(connectRedis({ ...redisOpts(), password: "wrong" }), /WRONGPASS|invalid/i);
});

test("状态存储：只存密文；重开读回最新一代；密钥不符拒绝启动", { skip }, async () => {
  const key = randomBytes(32);
  const db = await freshDb("t101");
  const a = await openPgStateStore({ pg: pg(db), key, holder: "inst-a", lockId: "101" });
  assert.equal(a.load(), null);
  a.save(JSON.stringify({ v: 1, n: 1, salt: "租户盐-明文不应落库" }));
  a.save(JSON.stringify({ v: 1, n: 2, salt: "租户盐-明文不应落库" }));
  assert.equal(a.stats().saves, 2);
  await a.close();
  const admin = await connectPg(pg(db));
  const row = (await admin.query("SELECT seq, data FROM kwl_cp.state")).rows[0]!;
  assert.equal(row[0], "2");
  assert.ok(!Buffer.from(row[1]!, "base64").toString("utf8").includes("租户盐"), "库里只有密文");
  await admin.close();
  const b = await openPgStateStore({ pg: pg(db), key, holder: "inst-b", lockId: "101" });
  assert.equal(JSON.parse(b.load()!).n, 2);
  await b.close();
  const wrong = await openPgStateStore({ pg: pg(db), key: randomBytes(32), holder: "inst-c", lockId: "101" });
  assert.throws(() => wrong.load(), /无法校验/);
  await wrong.close();
});

test("一主多备：备实例等锁；主实例正常退出后接手并读到最新状态；别的实例写过即围栏，之后的写全部失败", { skip }, async () => {
  const key = randomBytes(32);
  const db = await freshDb("t202");
  const a = await openPgStateStore({ pg: pg(db), key, holder: "inst-a", lockId: "202" });
  a.load();
  let bReady = false;
  const bp = openPgStateStore({ pg: pg(db), key, holder: "inst-b", lockId: "202", pollMs: 100 }).then((s) => ((bReady = true), s));
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(bReady, false, "主实例在时备实例拿不到锁");
  a.save(JSON.stringify({ v: 1, revoked: ["dev_x"] }));
  assert.equal(a.healthy(), true);
  await a.close();
  const b = await bp;
  assert.deepEqual(JSON.parse(b.load()!).revoked, ["dev_x"], "接手后读到主实例最后写成的状态");
  b.save(JSON.stringify({ v: 1, revoked: ["dev_x", "dev_y"] }));
  // 有人绕过锁直接改了状态行（模拟另一实例写过）：本实例下一次写围栏失败、失去主实例身份
  const admin = await connectPg(pg(db));
  await admin.query("UPDATE kwl_cp.state SET seq = seq + 1");
  assert.throws(() => b.save(JSON.stringify({ v: 1 })), (e: any) => e.code === "fenced");
  assert.equal(b.healthy(), false);
  assert.throws(() => b.save(JSON.stringify({ v: 1 })), /不可用（fenced）/);
  const log = (await admin.query("SELECT holder, event FROM kwl_cp.leader_log ORDER BY at")).rows.map((r) => r.join(":"));
  assert.ok(log.includes("inst-a:acquired") && log.includes("inst-a:released") && log.includes("inst-b:acquired"));
  await admin.close();
  await b.close();
});

test("端到端：主实例崩溃（连接被断、未正常关闭）后备实例接手——吊销仍在；接 Redis 的新主实例拒绝重放，不接的对照实例放行", { skip, timeout: 60_000 }, async () => {
  const key = randomBytes(32);
  const db = await freshDb("t303");
  const keys = devControlPlaneKeys();
  const listen = async (cp: ControlPlane) => {
    await new Promise<void>((r) => cp.server.listen(0, "127.0.0.1", () => r()));
    return `http://127.0.0.1:${(cp.server.address() as AddressInfo).port}`;
  };
  // 主实例 A（状态在 PostgreSQL、随机数另写 Redis）
  const storeA = await openPgStateStore({ pg: pg(db), key, holder: "cp-a", lockId: "303" });
  const mirrorA = await openRedisNonceMirror({ redis: redisOpts(), prefix: "t303:" });
  const cpA = createControlPlane({ keys, serviceSecret: "s".repeat(40), stateStore: storeA, nonceMirror: mirrorA });
  const baseA = await listen(cpA);
  const tid = "ten_pg";
  cpA.ops.createTenant({ activationRequired: false, tid, edition: "team", seats: 3 });
  const root = generateFirmRoot();
  const ts = Date.now();
  const proof = sign(null, enrollProofBytes(tid, root.publicKeyPem, ts), root.privateKeyPem).toString("base64url");
  assert.equal((await fetch(`${baseA}/v1/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tid, root_public_key_pem: root.publicKeyPem, ts, proof }) })).status, 200);
  const dev = (id: string, role: "admin" | "lawyer") => {
    const k = generateDeviceKeys();
    const cert = issueDeviceCertificate(root.privateKeyPem, { certId: `cert_${id}`, memberId: `usr_${id}`, deviceId: id, role, signPublicKeyPem: k.signPublicKeyPem, encPublicKeyPem: k.encPublicKeyPem, issuedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 86400_000).toISOString() });
    const headers = (method: string, path: string, raw = "") => signDeviceRequest({ method, path, body: raw, tid, deviceId: id, signPrivateKeyPem: k.signPrivateKeyPem });
    return { cert, headers };
  };
  const admin = dev("dev_pg_admin", "admin");
  const lawyer = dev("dev_pg_lawyer", "lawyer");
  for (const d of [admin, lawyer]) {
    const raw = JSON.stringify({ tid, cert: d.cert });
    assert.equal((await fetch(`${baseA}/v1/devices/register`, { method: "POST", headers: { ...d.headers("POST", "/v1/devices/register", raw), "content-type": "application/json" }, body: raw })).status, 200);
  }
  cpA.ops.revokeDevice(tid, "dev_pg_lawyer");
  // 只读请求：不改状态 → 不写库；它的随机数只在 A 的内存与 Redis 里
  const replayHeaders = admin.headers("GET", "/v1/directory");
  assert.equal((await fetch(`${baseA}/v1/directory`, { headers: replayHeaders })).status, 200);
  await new Promise((r) => setTimeout(r, 200)); // 等异步写 Redis
  // A“崩溃”：管理员断开 A 的数据库会话（锁随之释放），A 不做正常关闭
  const pgAdmin = await connectPg(pg());
  await pgAdmin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'kwl-control-plane' AND pid <> pg_backend_pid()");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(storeA.healthy(), false, "连接断了即失去主实例身份");
  const failed = await fetch(`${baseA}/v1/license`, { headers: admin.headers("GET", "/v1/license") });
  assert.equal(failed.status, 500, "旧主实例不能再写（许可签发要写状态）");
  // 对照：不接 Redis 的新主实例——重放的只读请求被放行（随机数丢了）
  const storeC = await openPgStateStore({ pg: pg(db), key, holder: "cp-c", lockId: "303" });
  const cpC = createControlPlane({ keys, serviceSecret: "s".repeat(40), stateStore: storeC });
  const baseC = await listen(cpC);
  const dirC = await fetch(`${baseC}/v1/directory`, { headers: replayHeaders });
  assert.equal(dirC.status, 200, "对照：没有 Redis 时重放成功（这正是要补的窗口）");
  const opened = openEnvelope<DirectoryBody>(await dirC.json(), "kwl-device-directory", publicKeyMap(cpC.publicKeys.envelope));
  assert.ok(opened.ok && opened.body.revoked_devices.some((d) => d.device_id === "dev_pg_lawyer"), "吊销在换实例后仍在");
  cpC.server.closeAllConnections();
  await new Promise<void>((r) => cpC.server.close(() => r()));
  await storeC.close();
  // 接 Redis 的新主实例 B：同一个重放被拒
  const storeB = await openPgStateStore({ pg: pg(db), key, holder: "cp-b", lockId: "303" });
  const mirrorB = await openRedisNonceMirror({ redis: redisOpts(), prefix: "t303:" });
  assert.ok(mirrorB.initial.length >= 1);
  const cpB = createControlPlane({ keys, serviceSecret: "s".repeat(40), stateStore: storeB, nonceMirror: mirrorB });
  const baseB = await listen(cpB);
  try {
    const replay = await fetch(`${baseB}/v1/directory`, { headers: replayHeaders });
    assert.equal(replay.status, 401);
    assert.equal(((await replay.json()) as any).error.code, "device_auth_replayed");
    assert.equal((await fetch(`${baseB}/v1/directory`, { headers: admin.headers("GET", "/v1/directory") })).status, 200, "新请求照常");
    assert.equal(mirrorA.stats().failures, 0);
  } finally {
    for (const cp of [cpA, cpB]) {
      cp.server.closeAllConnections();
      await new Promise<void>((r) => cp.server.close(() => r()));
    }
    mirrorA.close();
    mirrorB.close();
    await storeA.close();
    await storeB.close();
    await pgAdmin.close();
  }
});

test("生产入口一主多备：第二个控制面进程等锁、不监听；主进程被杀（SIGKILL）后接手并就绪（换实例后状态与随机数见上一条端到端用例）", { skip, timeout: 90_000 }, async () => {
  const { fileURLToPath } = await import("node:url");
  const { generateKeyPairSync } = await import("node:crypto");
  const script = fileURLToPath(new URL("../../../scripts/cloud-serve.mjs", import.meta.url));
  const db = await freshDb("t404");
  const w = (name: string, content: string) => {
    const p = join(dir, name);
    writeFileSync(p, content, { mode: 0o600 });
    return p;
  };
  const pem = (k: { privateKey: { export(o: object): string | Buffer } }) => String(k.privateKey.export({ format: "pem", type: "pkcs8" }));
  const procs: ChildProcess[] = [];
  const run = (name: string, cfg: unknown, ready = /已就绪（http 仅测试 [^:]+:(\d+)/) => {
    const proc = spawn(process.execPath, [script, "--config", w(`${name}.json`, JSON.stringify(cfg))], { stdio: ["ignore", "pipe", "pipe"] });
    procs.push(proc);
    let out = "";
    const port = new Promise<number>((ok, no) => {
      proc.stdout!.on("data", (d) => {
        out += d;
        const m = ready.exec(out);
        if (m) ok(Number(m[1]));
      });
      proc.stderr!.on("data", (d) => (out += d));
      proc.on("exit", (c) => no(new Error(`退出 ${c}：${out}`)));
    });
    port.catch(() => {});
    return { proc, port, out: () => out };
  };
  try {
    const signer = run("signer404", { role: "cp-signer", environment: "test", listen: { host: "127.0.0.1", port: 0 }, insecure_loopback_for_test: true, data_dir: join(dir, "s404"), keys: { envelope: { kid: "cp-test-a", private_key_file: w("e404.pem", pem(generateKeyPairSync("ed25519"))) }, seat: { kid: "seat-test-a", private_key_file: w("s404.pem", pem(generateKeyPairSync("ed25519"))) } } });
    const signerPort = await signer.port;
    const stateKey = w("sk404", randomBytes(32).toString("hex"));
    const cpCfg = (n: string) => ({
      role: "control-plane",
      listen: { host: "127.0.0.1", port: 0 },
      insecure_loopback_for_test: true,
      service_secret_file: w(`ss404`, randomBytes(32).toString("hex")),
      data_dir: join(dir, `cp404-${n}`),
      signer: { url: `http://127.0.0.1:${signerPort}` },
      state_key_file: stateKey,
      code_pepper_file: w(`pep404`, randomBytes(32).toString("hex")),
      state_store: { kind: "postgres", socket_dir: dir, port, user: "kwl", database: db, password_file: w("pgpw404", pgPassword) },
      nonce_store: { kind: "redis", socket_path: join(dir, "r.sock"), password_file: w("rpw404", redisPassword) },
    });
    const a = run("cpa", cpCfg("a"));
    const aPort = await a.port;
    assert.equal((await fetch(`http://127.0.0.1:${aPort}/readyz`)).status, 200);
    // 主进程写一点状态：开通一个律所（经运营接口之外的路径只有设备请求；这里直接看状态行的序号增长）
    const enroll = await fetch(`http://127.0.0.1:${aPort}/v1/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(enroll.status, 404, "未开通的租户");
    const b = run("cpb", cpCfg("b"));
    await new Promise((r) => setTimeout(r, 2_500));
    assert.match(b.out(), /正在等待成为主实例/);
    assert.doesNotMatch(b.out(), /已就绪/, "备进程拿不到锁时不监听");
    a.proc.kill("SIGKILL");
    const bPort = await b.port;
    assert.equal((await fetch(`http://127.0.0.1:${bPort}/readyz`)).status, 200);
    const admin = await connectPg(pg(db));
    const log = (await admin.query("SELECT event FROM kwl_cp.leader_log ORDER BY at")).rows.map((r) => r[0]);
    assert.deepEqual(log, ["acquired", "acquired"], "两次成为主实例（第一个是被杀的，没有 released）");
    await admin.close();
  } finally {
    for (const p of procs) p.kill("SIGKILL");
  }
});
