import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createOpsGuard,
  fileNonceStore,
  fileRosterSource,
  generateOpsKeyPair,
  isPublicKeyPem,
  memoryNonceStore,
  OPS_PATH_RE,
  OPS_REQUEST_MAX_SKEW_MS,
  OpsAuthError,
  opsKeyFingerprint,
  signOpsRequest,
  signOpsRoster,
  validateOpsRosterBody,
  verifyOpsRoster,
  type OpsGuard,
  type OpsRejectRecord,
  type SignedOpsRoster,
} from "../src/index.ts";
import { devOpsRoster } from "../src/testing.ts";

const code = (fn: () => unknown): string => {
  try {
    fn();
    return "ok";
  } catch (e) {
    return e instanceof OpsAuthError ? `${e.status}:${e.code}` : `other:${(e as Error).message}`;
  }
};
/** 原子换名册文件（与部署换挂载文件同一形态）。 */
const put = (file: string, doc: SignedOpsRoster) => {
  writeFileSync(`${file}.tmp`, JSON.stringify(doc));
  renameSync(`${file}.tmp`, file);
};
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const lines = (p: string) => (existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

test("运营名册：安全管理员签名；改内容、换签名密钥、未知签名者一律不认；编号（数字工号）、权限、职责冲突、共用公钥逐项校验", () => {
  const k = devOpsRoster([{ id: "op_0001", perms: ["support.read"] }]);
  assert.equal(verifyOpsRoster(k.roster, k.rosterKeys).ok, true);
  const tampered = structuredClone(k.roster);
  tampered.body.operators[0]!.perms = ["support.read", "tenant.purge"];
  assert.deepEqual(verifyOpsRoster(tampered, k.rosterKeys), { ok: false, reason: "roster_signature_invalid" }, "运营人员不能给自己加权限");
  assert.deepEqual(verifyOpsRoster({ ...k.roster, kid: "sec-other" }, k.rosterKeys), { ok: false, reason: "roster_signer_unknown" });
  const other = generateOpsKeyPair();
  assert.deepEqual(verifyOpsRoster(signOpsRoster(k.roster.body, { kid: "sec-dev", privateKey: other.privateKeyPem }), k.rosterKeys), { ok: false, reason: "roster_signature_invalid" });
  const base = k.roster.body;
  const op = base.operators[0]!;
  for (const id of ["zhangsan", "op_zhangsan", "op_wang-wei", "op_12"]) assert.equal(validateOpsRosterBody({ ...base, operators: [{ ...op, id }] }), "roster_operator_invalid", `${id}：运营编号须为 op_ 加数字工号（复核 RA10A-04）`);
  assert.equal(validateOpsRosterBody({ ...base, operators: [{ ...op, perms: ["root.everything"] }] }), "roster_perms_invalid");
  assert.equal(validateOpsRosterBody({ ...base, operators: [{ ...op, perms: ["tenant.manage", "activation.issue"] }] }), "roster_perms_conflict", "一个人不能既开通租户又发创始开通码（复核 RA10A-17）");
  assert.equal(validateOpsRosterBody({ ...base, operators: [op, { ...op, id: "op_0002" }] }), "roster_key_shared", "同一把公钥不能登记给两个人");
  assert.equal(validateOpsRosterBody({ ...base, operators: [op, { ...op }] }), "roster_operator_invalid", "运营编号不能重复");
  assert.equal(validateOpsRosterBody({ ...base, extra: 1 }), "roster_malformed");
  assert.equal(validateOpsRosterBody({ ...base, expires_at: new Date(Date.parse(base.issued_at) + 32 * 86400_000).toISOString() }), "roster_ttl_invalid", "有效期至多 31 天");
  assert.equal(validateOpsRosterBody({ ...base, deployment: "Prod!" }), "roster_malformed");
  assert.throws(() => signOpsRoster({ ...base, version: 0 }, k.rosterSigner), /不合规/);
});

test("只收公钥（复核 RA10A-01 / RA10B-01）：运营公钥写成私钥 PEM、名册签名公钥表里放私钥，一律不认；指纹相同也挡得住", () => {
  const k = devOpsRoster([{ id: "op_0001", perms: ["support.read"] }]);
  const mine = k.keyOf("op_0001");
  assert.equal(isPublicKeyPem(mine.publicKeyPem), true);
  assert.equal(isPublicKeyPem(mine.privateKeyPem), false);
  assert.equal(opsKeyFingerprint(mine.privateKeyPem), opsKeyFingerprint(mine.publicKeyPem), "指纹相同：只靠核对指纹挡不住");
  const leaked = structuredClone(k.roster.body);
  leaked.operators[0]!.keys[0]!.public_key_pem = mine.privateKeyPem;
  assert.equal(validateOpsRosterBody(leaked), "roster_keys_invalid");
  assert.throws(() => signOpsRoster(leaked, k.rosterSigner), /roster_keys_invalid/);
  assert.equal(isPublicKeyPem(generateOpsKeyPair("pass-phrase-1").privateKeyPem), false, "加密的私钥同样不收");
  // 名册签名公钥表里放了私钥（“签名私钥离线”落空）
  const privKeys = new Map([["sec-dev", k.rosterSigner.privateKey]]);
  assert.deepEqual(verifyOpsRoster(k.roster, privKeys), { ok: false, reason: "roster_signer_key_not_public" });
});

test("运营请求：按人签名、绑定部署 / 服务 / 方法 / 路径 / 请求体；共享口令、过期、重放、换服务、换部署、改内容一律拒绝；对外不区分未登记与签名不符", () => {
  const k = devOpsRoster([
    { id: "op_0001", perms: ["support.read"] },
    { id: "op_0002", perms: ["support.read", "support.delete"] },
  ]);
  let t = Date.now();
  const dir = tmp("kwl-opsauth-");
  writeFileSync(join(dir, "roster.json"), JSON.stringify(k.roster));
  const rejects: OpsRejectRecord[] = [];
  const guard = createOpsGuard({ audience: "support", roster: fileRosterSource({ file: join(dir, "roster.json"), keys: k.rosterKeys, deployment: "test" }), nonces: memoryNonceStore(), now: () => t, onReject: (r) => void rejects.push(r) });
  const req = { method: "GET", path: "/v1/support/ops/packages" };
  const ok = guard.authorize(k.sign("op_0001", "support", req, t), req, "support.read");
  assert.deepEqual([ok.operator, ok.kid, ok.roster_version, ok.perms], ["op_0001", "k1", 1, ["support.read"]]);
  // 旧形态：共享口令 + 自报操作人 → 不再接受
  assert.equal(code(() => guard.authorize({ authorization: "Bearer ops-secret-0123456789", "x-kwl-operator": "ops.zhang" }, req, "support.read")), "401:ops_auth_missing");
  const h = k.sign("op_0001", "support", req, t);
  guard.authorize(h, req, "support.read");
  assert.equal(code(() => guard.authorize(h, req, "support.read")), "401:ops_auth_replayed");
  // 签给中继、签给另一套部署（预发）的请求拿到这里用
  assert.equal(code(() => guard.authorize(k.sign("op_0001", "relay", req, t), req, "support.read")), "401:ops_auth_invalid");
  assert.equal(code(() => guard.authorize(k.sign("op_0001", "support", req, t, "staging"), req, "support.read")), "401:ops_auth_invalid", "签名绑定部署（复核 RA10A-09）");
  const del = { method: "DELETE", path: "/v1/support/ops/packages/SUP-AAAA-BBBB" };
  const hd = k.sign("op_0002", "support", del, t);
  assert.equal(code(() => guard.authorize(hd, { ...del, path: "/v1/support/ops/packages/SUP-CCCC-DDDD" }, "support.delete")), "401:ops_auth_invalid");
  assert.equal(code(() => guard.authorize(hd, { ...del, method: "GET" }, "support.delete")), "401:ops_auth_invalid");
  assert.equal(code(() => guard.authorize(hd, { ...del, body: "{}" }, "support.delete")), "401:ops_auth_invalid");
  // 冒用别人的编号；未登记的编号——对外同一个原因（复核 RA10A-12），细分原因只进被拒记录
  const forged = signOpsRequest({ ...req, deployment: "test", audience: "support", operator: "op_0002", kid: "k1", privateKey: k.keyOf("op_0001").privateKeyPem, now: t });
  assert.equal(code(() => guard.authorize(forged, req, "support.read")), "401:ops_auth_invalid");
  const nobody = signOpsRequest({ ...req, deployment: "test", audience: "support", operator: "op_9999", kid: "k1", privateKey: k.keyOf("op_0001").privateKeyPem, now: t });
  assert.equal(code(() => guard.authorize(nobody, req, "support.read")), "401:ops_auth_invalid");
  assert.deepEqual(rejects.filter((r) => r.claimed === "op_0002" || r.claimed === "op_9999").slice(-2).map((r) => [r.claimed, r.reason, r.verified]), [["op_0002", "ops_auth_signature_invalid", false], ["op_9999", "ops_operator_unknown_or_revoked", false]]);
  assert.equal(code(() => guard.authorize(k.sign("op_0001", "support", req, t - 6 * 60_000), req, "support.read")), "401:ops_auth_stale");
  // 权限：op_0001 只有查看，不能删除；数组即须全有
  assert.equal(code(() => guard.authorize(k.sign("op_0001", "support", del, t), del, "support.delete")), "403:ops_permission_denied");
  assert.equal(code(() => guard.authorize(k.sign("op_0001", "support", req, t), req, ["support.read", "support.delete"])), "403:ops_permission_denied");
  assert.equal(guard.authorize(k.sign("op_0002", "support", del, t), del, ["support.read", "support.delete"]).operator, "op_0002");
  const denied = rejects.find((r) => r.reason === "ops_permission_denied")!;
  assert.deepEqual([denied.claimed, denied.verified, denied.roster_version, denied.path], ["op_0001", true, 1, "/v1/support/ops/packages/SUP-AAAA-BBBB"]);
  for (const r of rejects) for (const f of Object.keys(r)) assert.ok(["at", "audience", "claimed", "verified", "reason", "roster_reason", "roster_version", "method", "path", "dropped"].includes(f), f);
  t += 1;
});

test("按人吊销：新版本名册把某人标为吊销即生效（不重启）；只删丢失的那把密钥时同一人的其他密钥照常；旧版本名册不能回滚；换版留记录", () => {
  const k = devOpsRoster([
    { id: "op_0001", perms: ["tenant.purge"] },
    { id: "op_0002", perms: ["tenant.purge"] },
  ]);
  const dir = tmp("kwl-opsauth-rv-");
  const file = join(dir, "roster.json");
  const seenFile = join(dir, "seen", "roster-seen.json");
  const historyFile = join(dir, "seen", "roster-history.jsonl");
  put(file, k.roster);
  const src = () => fileRosterSource({ file, keys: k.rosterKeys, deployment: "test", seenFile, historyFile });
  const mk = () => createOpsGuard({ audience: "relay", roster: src(), nonces: memoryNonceStore() });
  const guard = mk();
  const req = { method: "DELETE", path: "/v1/relay/ops/tenants/ten_a" };
  assert.equal(guard.authorize(k.sign("op_0001", "relay", req), req, "tenant.purge").operator, "op_0001");
  const v2 = k.resign(2, [{ id: "op_0001", perms: ["tenant.purge"], status: "revoked" }, { id: "op_0002", perms: ["tenant.purge"] }]);
  put(file, v2);
  assert.equal(code(() => guard.authorize(k.sign("op_0001", "relay", req), req, "tenant.purge")), "401:ops_auth_invalid", "被吊销的人立即被拒");
  assert.equal(guard.authorize(k.sign("op_0002", "relay", req), req, "tenant.purge").roster_version, 2, "其他人不受影响，记到名册版本");
  // 回滚到 v1：整组失败关闭；重启（新的名册来源）同样不认
  put(file, k.roster);
  assert.equal(code(() => guard.authorize(k.sign("op_0002", "relay", req), req, "tenant.purge")), "503:ops_roster_unavailable");
  assert.deepEqual(src().current(), { ok: false, reason: "roster_rollback" });
  put(file, k.resign(2, [{ id: "op_0001", perms: ["tenant.purge"] }, { id: "op_0002", perms: ["tenant.purge"] }]));
  assert.deepEqual(src().current(), { ok: false, reason: "roster_conflict" });
  put(file, k.resign(2000));
  assert.deepEqual(src().current(), { ok: false, reason: "roster_version_jump" }, "版本跳幅过大（复核 RA10A-02）");
  // 只删一把密钥：op_0002 有两把，删 k1 后 k2 照常
  const extra = generateOpsKeyPair();
  const v3body = structuredClone(v2.body);
  v3body.version = 3;
  v3body.operators[1]!.keys.push({ kid: "k2", public_key_pem: extra.publicKeyPem, added_at: v3body.issued_at });
  put(file, signOpsRoster(v3body, k.rosterSigner));
  const g3 = mk();
  const viaK2 = () => signOpsRequest({ ...req, deployment: "test", audience: "relay", operator: "op_0002", kid: "k2", privateKey: extra.privateKeyPem });
  assert.equal(g3.authorize(viaK2(), req, "tenant.purge").kid, "k2");
  const v4body = structuredClone(v3body);
  v4body.version = 4;
  v4body.operators[1]!.keys = v4body.operators[1]!.keys.filter((x) => x.kid !== "k1");
  put(file, signOpsRoster(v4body, k.rosterSigner));
  assert.equal(code(() => g3.authorize(k.sign("op_0002", "relay", req), req, "tenant.purge")), "401:ops_auth_invalid", "丢失的那把密钥被拒");
  assert.equal(g3.authorize(viaK2(), req, "tenant.purge").kid, "k2");
  // 换版记录（复核 RA10A-07）：每接受一版一条
  assert.deepEqual(lines(historyFile).filter((r) => r.event === "roster_accepted").map((r) => [r.version, r.signer, r.active]), [[1, "sec-dev", 2], [2, "sec-dev", 1], [3, "sec-dev", 1], [4, "sec-dev", 1]]);
  // 版本记录损坏：运营接口整组不可用（不抛错、不自动重置、业务不受影响；复核 RA10A-03）
  writeFileSync(seenFile, "{broken");
  assert.deepEqual(src().current(), { ok: false, reason: "roster_seen_corrupt" });
});

test("名册绑定部署、有有效期、新实例可给版本下限（复核 RA10A-02）；名册签名公钥不能同时是运营公钥；名册签名公钥换了留记录", () => {
  const k = devOpsRoster([{ id: "op_0001", perms: ["support.read"] }]);
  const dir = tmp("kwl-opsauth-dep-");
  const file = join(dir, "roster.json");
  let t = Date.now();
  put(file, k.roster);
  assert.deepEqual(fileRosterSource({ file, keys: k.rosterKeys, deployment: "prod" }).current(), { ok: false, reason: "roster_deployment_mismatch" }, "预发 / 测试名册拷到生产不认");
  // 有效期：到期即不认（缓存里的同样到期）
  const src = fileRosterSource({ file, keys: k.rosterKeys, deployment: "test", now: () => t });
  assert.equal(src.current().ok, true);
  t += 31 * 86400_000;
  assert.deepEqual(src.current(), { ok: false, reason: "roster_expired" });
  t = Date.now();
  put(file, k.resign(3, undefined, { issuedAt: t + 3600_000 }));
  assert.deepEqual(fileRosterSource({ file, keys: k.rosterKeys, deployment: "test" }).current(), { ok: false, reason: "roster_not_yet_valid" });
  // 新实例（没有版本记录）给了版本下限：低于下限的旧名册不认
  put(file, k.resign(3));
  assert.deepEqual(fileRosterSource({ file, keys: k.rosterKeys, deployment: "test", minVersion: 5 }).current(), { ok: false, reason: "roster_rollback" });
  assert.equal(fileRosterSource({ file, keys: k.rosterKeys, deployment: "test", minVersion: 3 }).current().ok, true);
  // 名册签名公钥同时是某位运营的公钥
  const opPub = k.keyOf("op_0001").publicKeyPem;
  assert.deepEqual(fileRosterSource({ file, keys: new Map([...k.rosterKeys, ["sec-x", opPub]]), deployment: "test" }).current(), { ok: false, reason: "roster_signer_is_operator" });
  // 名册签名公钥换了（轮换）：记一条 roster_keys_changed
  const seenFile = join(dir, "seen.json");
  const historyFile = join(dir, "history.jsonl");
  assert.equal(fileRosterSource({ file, keys: k.rosterKeys, deployment: "test", seenFile, historyFile }).current().ok, true);
  const extra = generateOpsKeyPair();
  assert.equal(fileRosterSource({ file, keys: new Map([...k.rosterKeys, ["sec-2", extra.publicKeyPem]]), deployment: "test", seenFile, historyFile }).current().ok, true);
  assert.deepEqual(lines(historyFile).map((r) => r.event), ["roster_accepted", "roster_keys_changed"]);
});

test("名册文件缺失或签名不符：运营接口失败关闭；版本记录写不进去时不认新名册", () => {
  const k = devOpsRoster([{ id: "op_0001", perms: ["support.read"] }]);
  const dir = tmp("kwl-opsauth-miss-");
  const file = join(dir, "roster.json");
  const src = fileRosterSource({ file, keys: k.rosterKeys, deployment: "test" });
  assert.deepEqual(src.current(), { ok: false, reason: "roster_unavailable" });
  const bad = structuredClone(k.roster);
  bad.sig = (bad.sig[0] === "A" ? "B" : "A") + bad.sig.slice(1);
  put(file, bad);
  assert.equal(src.current().ok, false);
  put(file, k.roster);
  assert.equal(src.current().ok, true);
  const ro = join(dir, "ro");
  const src2 = fileRosterSource({ file, keys: k.rosterKeys, deployment: "test", seenFile: join(ro, "x", "seen.json") });
  writeFileSync(ro, "not a directory");
  assert.deepEqual(src2.current(), { ok: false, reason: "roster_seen_unwritable" });
});

test("双因素只留接口：名册标了非 none 的人，服务没接核验器即拒绝；接了按核验结果", () => {
  const k = devOpsRoster([{ id: "op_0001", perms: ["support.read"], second_factor: "totp" }]);
  const dir = tmp("kwl-opsauth-2fa-");
  writeFileSync(join(dir, "roster.json"), JSON.stringify(k.roster));
  const roster = fileRosterSource({ file: join(dir, "roster.json"), keys: k.rosterKeys, deployment: "test" });
  const req = { method: "GET", path: "/v1/support/ops/packages" };
  const rejects: OpsRejectRecord[] = [];
  const none = createOpsGuard({ audience: "support", roster, nonces: memoryNonceStore(), onReject: (r) => void rejects.push(r) });
  assert.equal(code(() => none.authorize(k.sign("op_0001", "support", req), req, "support.read")), "401:ops_auth_invalid");
  assert.equal(rejects.at(-1)!.reason, "ops_second_factor_unavailable");
  const no = createOpsGuard({ audience: "support", roster, nonces: memoryNonceStore(), secondFactor: () => false });
  assert.equal(code(() => no.authorize(k.sign("op_0001", "support", req), req, "support.read")), "401:ops_auth_invalid");
  const yes = createOpsGuard({ audience: "support", roster, nonces: memoryNonceStore(), secondFactor: (op, h) => op.id === "op_0001" && h["x-kwl-op-2fa"] === "123456" });
  assert.equal(yes.authorize({ ...k.sign("op_0001", "support", req), "x-kwl-op-2fa": "123456" }, req, "support.read").operator, "op_0001");
});

test("随机数落盘：服务重启后时间窗内截获的运营请求仍不能重放；窗口最后一毫秒也不能（复核 RA10B-17）；记不下来即拒绝", () => {
  const k = devOpsRoster([{ id: "op_0001", perms: ["relay.reset"] }]);
  const dir = tmp("kwl-opsauth-nonce-");
  writeFileSync(join(dir, "roster.json"), JSON.stringify(k.roster));
  const roster = fileRosterSource({ file: join(dir, "roster.json"), keys: k.rosterKeys, deployment: "test" });
  const mk = (): OpsGuard => createOpsGuard({ audience: "relay", roster, nonces: fileNonceStore(join(dir, "ops", "nonces.jsonl")) });
  const req = { method: "DELETE", path: "/v1/relay/ops/tenants/ten_a/matters/mat_x" };
  const h = k.sign("op_0001", "relay", req);
  mk().authorize(h, req, "relay.reset");
  assert.equal(code(() => mk().authorize(h, req, "relay.reset")), "401:ops_auth_replayed", "重启后同一请求被拒");
  writeFileSync(join(dir, "ops", "nonces.jsonl"), `${'{"k":"x","e":1}\n'}{"k":"hal`, { flag: "a" });
  assert.equal(code(() => mk().authorize(h, req, "relay.reset")), "401:ops_auth_replayed");
  // 边界：请求时刻 = 首次见到 + 5 分钟；到“首次见到 + 10 分钟”那一毫秒仍在时刻窗口内，随机数也须仍在
  const t0 = Date.now();
  let t = t0;
  const g = createOpsGuard({ audience: "relay", roster, nonces: memoryNonceStore(), now: () => t });
  const edge = k.sign("op_0001", "relay", req, t0 + OPS_REQUEST_MAX_SKEW_MS);
  g.authorize(edge, req, "relay.reset");
  t = t0 + 2 * OPS_REQUEST_MAX_SKEW_MS;
  assert.equal(code(() => g.authorize(edge, req, "relay.reset")), "401:ops_auth_replayed");
  const fileEdge = fileNonceStore(join(dir, "edge.jsonl"));
  assert.equal(fileEdge.seen("x", t0), false);
  assert.equal(fileEdge.seen("x", t0 + 2 * OPS_REQUEST_MAX_SKEW_MS), true);
  const ro = join(dir, "ro");
  writeFileSync(ro, "");
  chmodSync(ro, 0o400);
  const bad = createOpsGuard({ audience: "relay", roster, nonces: fileNonceStore(ro) });
  assert.equal(code(() => bad.authorize(k.sign("op_0001", "relay", req), req, "relay.reset")), process.getuid?.() === 0 ? "ok" : "503:ops_nonce_store_unavailable");
});

test("被拒记录：未核验的按分钟限量、超出的下一分钟补记条数；签名核验通过之后的拒绝一律记（复核 RA10A-05 / RA10B-16）；名册故障带具体原因", () => {
  const k = devOpsRoster([{ id: "op_0001", perms: ["support.read"] }]);
  const dir = tmp("kwl-opsauth-cap-");
  const file = join(dir, "roster.json");
  writeFileSync(file, JSON.stringify(k.roster));
  let t = Date.parse(k.roster.body.issued_at) + 1000;
  const n: OpsRejectRecord[] = [];
  const g = createOpsGuard({ audience: "support", roster: fileRosterSource({ file, keys: k.rosterKeys, deployment: "test", now: () => t }), nonces: memoryNonceStore(), now: () => t, onReject: (r) => void n.push(r), rejectLogPerMinute: 5 });
  const req = { method: "GET", path: "/v1/support/ops/packages" };
  t = Math.ceil(t / 60_000) * 60_000 + 1000;
  for (let i = 0; i < 20; i++) code(() => g.authorize({}, req, "support.read"));
  assert.equal(n.length, 5, "未核验的限量");
  // 同一分钟里，持有效密钥的越权照样记
  const del = { method: "DELETE", path: "/v1/support/ops/packages/SUP-AAAA-BBBB" };
  for (let i = 0; i < 3; i++) code(() => g.authorize(k.sign("op_0001", "support", del, t), del, "support.delete"));
  assert.equal(n.filter((r) => r.verified && r.reason === "ops_permission_denied").length, 3);
  t += 60_000;
  code(() => g.authorize({}, req, "support.read"));
  assert.equal(n.find((r) => r.reason === "ops_rejects_dropped")?.dropped, 15, "下一分钟开头补记省略了多少条");
  // 名册不可用：被拒记录带具体原因
  t += 31 * 86400_000;
  code(() => g.authorize(k.sign("op_0001", "support", req, t), req, "support.read"));
  assert.deepEqual([n.at(-1)!.reason, n.at(-1)!.roster_reason], ["ops_roster_unavailable", "roster_expired"]);
  for (const p of ["/v1/ops/tenants", "/v1/ops", "/v1/support/ops/packages", "/v1/relay/ops/tenants/t1", "/v1/notify/ops/tenants/t1"]) assert.match(p, OPS_PATH_RE, p);
  for (const p of ["/v1/support/tickets", "/v1/opsx", "/v1/relay/matters/x/ops", "/healthz", "/v1/support/opsx/1", "/v1/reminders/ops"]) assert.doesNotMatch(p, OPS_PATH_RE, p);
});

/** 服务源码里的运营路径：引号三种、正则字面量的 \/、连字符与数字、模板变量都认（复核 RA10B-09）。 */
export function opsPathsIn(src: string): { canon: string; index: number }[] {
  const out: { canon: string; index: number }[] = [];
  for (const m of src.matchAll(/\/v1(?:\\\/|\/)(?:([A-Za-z0-9_-]+|\$\{[^}]*\})(?:\\\/|\/))?ops(?=\\\/|\/|["'`$)?(]|\\b)/g)) out.push({ canon: m[1] ? `/v1/${m[1]}/ops/x` : "/v1/ops/x", index: m.index! });
  return out;
}

test("门禁：云端服务源码里的每一条运营路径都被 OPS_PATH_RE 认出；每条运营路由附近都经运营守卫（复核 RA10B-09）", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const found = new Set<string>();
  for (const svc of readdirSync(join(root, "services"))) {
    const srcDir = join(root, "services", svc, "src");
    let files: string[] = [];
    try {
      files = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
    } catch {
      continue;
    }
    for (const f of files) {
      const src = readFileSync(join(srcDir, f), "utf8");
      const srcLines = src.split("\n");
      // 控制面的运营路由是一张表（opsSpec），只经 opsRoute 进入：opsRoute 先鉴权、opsSpec 只在 opsRoute 里调用一次
      const specAt = src.indexOf("const opsSpec = ");
      const routeAt = src.indexOf("const opsRoute = ");
      const routeBody = routeAt >= 0 ? src.slice(routeAt, src.indexOf("\n  };\n", routeAt)) : "";
      const specViaRoute = specAt >= 0 && routeAt > specAt && (src.match(/opsSpec\(/g) ?? []).length === 1 && /opsSpec\(/.test(routeBody) && routeBody.indexOf(".authorize(") >= 0 && routeBody.indexOf(".authorize(") < routeBody.indexOf("spec.run(");
      for (const { canon, index } of opsPathsIn(src)) {
        found.add(canon);
        assert.match(canon, OPS_PATH_RE, `${svc}/${f} 里的运营路径 ${canon} 没有被生产入口认出`);
        // 路由匹配（这一行里有 exec / === / startsWith）之后 12 行内须经运营守卫，或位于只经 opsRoute 进入的 opsSpec 表里
        const line = src.slice(0, index).split("\n").length;
        if (!/\.exec\(|===|startsWith/.test(srcLines[line - 1] ?? "")) continue;
        if (specViaRoute && index > specAt && index < routeAt) continue;
        assert.match(srcLines.slice(line - 1, line + 12).join("\n"), /opsAuth\(|opsRoute\(|\.authorize\(/, `${svc}/${f}:${line} 的运营路由没有经运营守卫`);
      }
    }
  }
  assert.deepEqual([...found].sort(), ["/v1/notify/ops/x", "/v1/ops/x", "/v1/relay/ops/x", "/v1/support/ops/x"]);
  // 反向对照：既往漏网的写法都能认出
  for (const s of ["'/v1/billing/ops'", "`/v1/billing/ops/x`", "/^\\/v1\\/anon-matters\\/ops\\/x$/", "/^\\/v1\\/dist2\\/ops\\/x$/", "`/v1/${PREFIX}/ops/`", '"/v1/ops"']) assert.equal(opsPathsIn(s).length, 1, s);
  for (const s of ["/v1/billing/ops/x", "/v1/anon-matters/ops/x", "/v1/dist2/ops/x"]) assert.doesNotMatch(s, OPS_PATH_RE);
});

test("门禁：律师电脑上的代码（内核、闸门、客户端等）不引用本包（含相对路径与拼接路径）——驻留面清单把本包列为云端的前提", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "vendor" || e.name === "dist" || e.name === "test") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs|cjs|js)$/.test(e.name) && /ops-auth/.test(readFileSync(p, "utf8"))) hits.push(p.slice(root.length));
    }
  };
  for (const pkg of readdirSync(join(root, "packages"))) if (pkg !== "ops-auth") walk(join(root, "packages", pkg, "src"));
  for (const app of readdirSync(join(root, "apps"))) for (const sub of ["src", "electron"]) {
    try {
      walk(join(root, "apps", app, sub));
    } catch {
      // 没有这个目录
    }
  }
  assert.deepEqual(hits, []);
  // 生产入口导出里没有测试辅助（在 @zr-legal/ops-auth/testing）
  assert.doesNotMatch(readFileSync(join(root, "packages", "ops-auth", "src", "index.ts"), "utf8"), /export function (devOpsRoster|fileOpsGuard)/);
});
