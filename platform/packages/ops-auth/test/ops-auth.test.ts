import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOpsGuard,
  devOpsRoster,
  fileNonceStore,
  fileRosterSource,
  generateOpsKeyPair,
  memoryNonceStore,
  OPS_PATH_RE,
  OpsAuthError,
  signOpsRequest,
  signOpsRoster,
  validateOpsRosterBody,
  verifyOpsRoster,
  type OpsGuard,
  type OpsRejectRecord,
  type SignedOpsRoster,
} from "../src/index.ts";

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

test("运营名册：安全管理员签名；改内容、换签名密钥、未知签名者一律不认；编号、权限、共用公钥逐项校验", () => {
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
  assert.equal(validateOpsRosterBody({ ...base, operators: [{ ...op, id: "zhangsan" }] }), "roster_operator_invalid", "运营编号须为 op_ 工号形态");
  assert.equal(validateOpsRosterBody({ ...base, operators: [{ ...op, perms: ["root.everything"] }] }), "roster_perms_invalid");
  assert.equal(validateOpsRosterBody({ ...base, operators: [op, { ...op, id: "op_0002" }] }), "roster_key_shared", "同一把公钥不能登记给两个人");
  assert.equal(validateOpsRosterBody({ ...base, operators: [op, { ...op }] }), "roster_operator_invalid", "运营编号不能重复");
  assert.equal(validateOpsRosterBody({ ...base, extra: 1 }), "roster_malformed");
  assert.throws(() => signOpsRoster({ ...base, version: 0 }, k.rosterSigner), /不合规/);
});

test("运营请求：按人签名、绑定服务 / 方法 / 路径 / 请求体；共享口令、过期、重放、换服务、改内容一律拒绝；权限按接口", () => {
  const k = devOpsRoster([
    { id: "op_0001", perms: ["support.read"] },
    { id: "op_0002", perms: ["support.read", "support.delete"] },
  ]);
  let t = Date.now();
  const dir = mkdtempSync(join(tmpdir(), "kwl-opsauth-"));
  writeFileSync(join(dir, "roster.json"), JSON.stringify(k.roster));
  const rejects: OpsRejectRecord[] = [];
  const guard = createOpsGuard({ audience: "support", roster: fileRosterSource({ file: join(dir, "roster.json"), keys: k.rosterKeys }), nonces: memoryNonceStore(), now: () => t, onReject: (r) => void rejects.push(r) });
  const req = { method: "GET", path: "/v1/support/ops/packages" };
  assert.deepEqual(guard.authorize(k.sign("op_0001", "support", req, t), req, "support.read"), { operator: "op_0001", kid: "k1" });
  // 旧形态：共享口令 + 自报操作人 → 不再接受
  assert.equal(code(() => guard.authorize({ authorization: "Bearer ops-secret-0123456789", "x-kwl-operator": "ops.zhang" }, req, "support.read")), "401:ops_auth_missing");
  // 重放同一请求
  const h = k.sign("op_0001", "support", req, t);
  guard.authorize(h, req, "support.read");
  assert.equal(code(() => guard.authorize(h, req, "support.read")), "401:ops_auth_replayed");
  // 签给中继的请求拿到支持服务用
  assert.equal(code(() => guard.authorize(k.sign("op_0001", "relay", req, t), req, "support.read")), "401:ops_auth_signature_invalid");
  // 改方法、路径、请求体
  const del = { method: "DELETE", path: "/v1/support/ops/packages/SUP-AAAA-BBBB" };
  const hd = k.sign("op_0002", "support", del, t);
  assert.equal(code(() => guard.authorize(hd, { ...del, path: "/v1/support/ops/packages/SUP-CCCC-DDDD" }, "support.delete")), "401:ops_auth_signature_invalid");
  assert.equal(code(() => guard.authorize(hd, { ...del, method: "GET" }, "support.delete")), "401:ops_auth_signature_invalid");
  assert.equal(code(() => guard.authorize(hd, { ...del, body: "{}" }, "support.delete")), "401:ops_auth_signature_invalid");
  // 冒用别人的编号（用自己的私钥签、声称是别人）
  const forged = signOpsRequest({ ...req, audience: "support", operator: "op_0002", kid: "k1", privateKey: k.keyOf("op_0001").privateKeyPem, now: t });
  assert.equal(code(() => guard.authorize(forged, req, "support.read")), "401:ops_auth_signature_invalid");
  // 时刻偏差
  assert.equal(code(() => guard.authorize(k.sign("op_0001", "support", req, t - 6 * 60_000), req, "support.read")), "401:ops_auth_stale");
  // 权限：op_0001 只有查看，不能删除
  assert.equal(code(() => guard.authorize(k.sign("op_0001", "support", del, t), del, "support.delete")), "403:ops_permission_denied");
  assert.deepEqual(guard.authorize(k.sign("op_0002", "support", del, t), del, "support.delete"), { operator: "op_0002", kid: "k1" });
  // 被拒记录：只有声称的编号（格式合规才记）、原因、路径（去掉查询串）
  assert.ok(rejects.some((r) => r.claimed === "op_0001" && r.reason === "ops_permission_denied" && r.path === "/v1/support/ops/packages/SUP-AAAA-BBBB"));
  assert.ok(rejects.some((r) => r.claimed === null && r.reason === "ops_auth_missing"));
  for (const r of rejects) assert.deepEqual(Object.keys(r).sort(), ["at", "audience", "claimed", "method", "path", "reason"]);
  t += 1;
});

test("按人吊销：新版本名册把某人标为吊销即生效（不重启）；只删丢失的那把密钥时同一人的其他密钥照常；旧版本名册不能回滚", () => {
  const k = devOpsRoster([
    { id: "op_0001", perms: ["tenant.purge"] },
    { id: "op_0002", perms: ["tenant.purge"] },
  ]);
  const dir = mkdtempSync(join(tmpdir(), "kwl-opsauth-rv-"));
  const file = join(dir, "roster.json");
  const seenFile = join(dir, "seen", "roster-seen.json");
  put(file, k.roster);
  const mk = () => createOpsGuard({ audience: "relay", roster: fileRosterSource({ file, keys: k.rosterKeys, seenFile }), nonces: memoryNonceStore() });
  const guard = mk();
  const req = { method: "DELETE", path: "/v1/relay/ops/tenants/ten_a" };
  assert.equal(guard.authorize(k.sign("op_0001", "relay", req), req, "tenant.purge").operator, "op_0001");
  // v2：吊销 op_0001
  const v2 = k.resign(2, [{ id: "op_0001", perms: ["tenant.purge"], status: "revoked" }, { id: "op_0002", perms: ["tenant.purge"] }]);
  put(file, v2);
  assert.equal(code(() => guard.authorize(k.sign("op_0001", "relay", req), req, "tenant.purge")), "401:ops_operator_unknown_or_revoked", "被吊销的人立即被拒");
  assert.equal(guard.authorize(k.sign("op_0002", "relay", req), req, "tenant.purge").operator, "op_0002", "其他人不受影响");
  // 回滚到 v1（被吊销者仍有效的那一版）：运营接口整体失败关闭
  put(file, k.roster);
  assert.equal(code(() => guard.authorize(k.sign("op_0001", "relay", req), req, "tenant.purge")), "503:ops_roster_unavailable");
  assert.equal(code(() => guard.authorize(k.sign("op_0002", "relay", req), req, "tenant.purge")), "503:ops_roster_unavailable");
  // 重启（新的名册来源，同一份版本记录）同样不认 v1
  assert.deepEqual(fileRosterSource({ file, keys: k.rosterKeys, seenFile }).current(), { ok: false, reason: "roster_rollback" });
  // 同版本不同内容
  put(file, k.resign(2, [{ id: "op_0001", perms: ["tenant.purge"] }, { id: "op_0002", perms: ["tenant.purge"] }]));
  assert.deepEqual(fileRosterSource({ file, keys: k.rosterKeys, seenFile }).current(), { ok: false, reason: "roster_conflict" });
  // 只删一把密钥：op_0002 有两把，删 k1 后 k2 照常
  const extra = generateOpsKeyPair();
  const v3body = structuredClone(v2.body);
  v3body.version = 3;
  v3body.operators[1]!.keys.push({ kid: "k2", public_key_pem: extra.publicKeyPem, added_at: v3body.issued_at });
  put(file, signOpsRoster(v3body, k.rosterSigner));
  const g3 = mk();
  const viaK2 = signOpsRequest({ ...req, audience: "relay", operator: "op_0002", kid: "k2", privateKey: extra.privateKeyPem });
  assert.equal(g3.authorize(viaK2, req, "tenant.purge").kid, "k2");
  const v4body = structuredClone(v3body);
  v4body.version = 4;
  v4body.operators[1]!.keys = v4body.operators[1]!.keys.filter((x) => x.kid !== "k1");
  put(file, signOpsRoster(v4body, k.rosterSigner));
  assert.equal(code(() => g3.authorize(k.sign("op_0002", "relay", req), req, "tenant.purge")), "401:ops_operator_unknown_or_revoked", "丢失的那把密钥被拒");
  assert.equal(g3.authorize(signOpsRequest({ ...req, audience: "relay", operator: "op_0002", kid: "k2", privateKey: extra.privateKeyPem }), req, "tenant.purge").kid, "k2");
  // 版本记录损坏：拒绝启动（不能悄悄丢掉回滚保护）
  writeFileSync(seenFile, "{broken");
  assert.throws(() => fileRosterSource({ file, keys: k.rosterKeys, seenFile }), /版本记录读不出/);
});

test("名册文件缺失或签名不符：运营接口失败关闭；版本记录写不进去时不认新名册", () => {
  const k = devOpsRoster([{ id: "op_0001", perms: ["support.read"] }]);
  const dir = mkdtempSync(join(tmpdir(), "kwl-opsauth-miss-"));
  const file = join(dir, "roster.json");
  const src = fileRosterSource({ file, keys: k.rosterKeys });
  assert.deepEqual(src.current(), { ok: false, reason: "roster_unavailable" });
  const bad = structuredClone(k.roster);
  bad.sig = k.resign(1).sig.replace(/^./, (c) => (c === "A" ? "B" : "A"));
  put(file, bad);
  assert.equal(src.current().ok, false);
  put(file, k.roster);
  assert.equal(src.current().ok, true);
  // 版本记录所在目录不可写
  const ro = join(dir, "ro");
  const src2 = fileRosterSource({ file, keys: k.rosterKeys, seenFile: join(ro, "x", "seen.json") });
  writeFileSync(ro, "not a directory");
  assert.deepEqual(src2.current(), { ok: false, reason: "roster_seen_unwritable" });
});

test("双因素只留接口：名册标了非 none 的人，服务没接核验器即拒绝；接了按核验结果", () => {
  const k = devOpsRoster([{ id: "op_0001", perms: ["support.read"], second_factor: "totp" }]);
  const dir = mkdtempSync(join(tmpdir(), "kwl-opsauth-2fa-"));
  writeFileSync(join(dir, "roster.json"), JSON.stringify(k.roster));
  const roster = fileRosterSource({ file: join(dir, "roster.json"), keys: k.rosterKeys });
  const req = { method: "GET", path: "/v1/support/ops/packages" };
  const none = createOpsGuard({ audience: "support", roster, nonces: memoryNonceStore() });
  assert.equal(code(() => none.authorize(k.sign("op_0001", "support", req), req, "support.read")), "401:ops_second_factor_unavailable");
  const no = createOpsGuard({ audience: "support", roster, nonces: memoryNonceStore(), secondFactor: () => false });
  assert.equal(code(() => no.authorize(k.sign("op_0001", "support", req), req, "support.read")), "401:ops_second_factor_failed");
  const yes = createOpsGuard({ audience: "support", roster, nonces: memoryNonceStore(), secondFactor: (op, h) => op.id === "op_0001" && h["x-kwl-op-2fa"] === "123456" });
  assert.equal(yes.authorize({ ...k.sign("op_0001", "support", req), "x-kwl-op-2fa": "123456" }, req, "support.read").operator, "op_0001");
});

test("随机数落盘：服务重启后时间窗内截获的运营请求仍不能重放；记不下来即拒绝", () => {
  const k = devOpsRoster([{ id: "op_0001", perms: ["relay.reset"] }]);
  const dir = mkdtempSync(join(tmpdir(), "kwl-opsauth-nonce-"));
  writeFileSync(join(dir, "roster.json"), JSON.stringify(k.roster));
  const roster = fileRosterSource({ file: join(dir, "roster.json"), keys: k.rosterKeys });
  const mk = (): OpsGuard => createOpsGuard({ audience: "relay", roster, nonces: fileNonceStore(join(dir, "ops", "nonces.jsonl")) });
  const req = { method: "DELETE", path: "/v1/relay/ops/tenants/ten_a/matters/mat_x" };
  const h = k.sign("op_0001", "relay", req);
  mk().authorize(h, req, "relay.reset");
  assert.equal(code(() => mk().authorize(h, req, "relay.reset")), "401:ops_auth_replayed", "重启后同一请求被拒");
  // 末尾半行（写到一半断电）不影响读回
  writeFileSync(join(dir, "ops", "nonces.jsonl"), `${'{"k":"x","e":1}\n'}{"k":"hal`, { flag: "a" });
  assert.equal(code(() => mk().authorize(h, req, "relay.reset")), "401:ops_auth_replayed");
  // 随机数文件不可写：拒绝（503），不放行
  const ro = join(dir, "ro");
  writeFileSync(ro, "");
  chmodSync(ro, 0o400);
  const g = createOpsGuard({ audience: "relay", roster, nonces: fileNonceStore(ro) });
  assert.equal(code(() => g.authorize(k.sign("op_0001", "relay", req), req, "relay.reset")), process.getuid?.() === 0 ? "ok" : "503:ops_nonce_store_unavailable");
});

test("被拒记录按分钟限量；运营路径识别（入口按来源网段收紧用）", () => {
  const k = devOpsRoster([{ id: "op_0001", perms: ["support.read"] }]);
  const dir = mkdtempSync(join(tmpdir(), "kwl-opsauth-cap-"));
  writeFileSync(join(dir, "roster.json"), JSON.stringify(k.roster));
  const n: OpsRejectRecord[] = [];
  const g = createOpsGuard({ audience: "support", roster: fileRosterSource({ file: join(dir, "roster.json"), keys: k.rosterKeys }), nonces: memoryNonceStore(), onReject: (r) => void n.push(r), rejectLogPerMinute: 5 });
  for (let i = 0; i < 20; i++) code(() => g.authorize({}, { method: "GET", path: "/v1/support/ops/packages" }, "support.read"));
  assert.ok(n.length <= 10 && n.length >= 5, `被拒记录应限量（得到 ${n.length}）`);
  for (const p of ["/v1/ops/tenants", "/v1/ops", "/v1/support/ops/packages", "/v1/relay/ops/tenants/t", "/v1/notify/ops/tenants/t"]) assert.match(p, OPS_PATH_RE, p);
  for (const p of ["/v1/support/tickets", "/v1/opsx", "/v1/relay/matters/x/ops", "/healthz", "/v1/support/opsx/1", "/v1/reminders/ops"]) assert.doesNotMatch(p, OPS_PATH_RE, p);
});

test("门禁：云端服务源码里的每一条运营路径都被 OPS_PATH_RE 认出（新服务加运营接口而入口不知道即失败）；运营路由都经运营守卫", () => {
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
      // 路由里的运营路径（正则字面量里是 \/，字符串里是 /）
      for (const m of src.matchAll(/\/v1(?:\\\/|\/)(?:([a-z]+)(?:\\\/|\/))?ops(?:\\\/|\/|")/g)) {
        const canon = m[1] ? `/v1/${m[1]}/ops/x` : "/v1/ops/x";
        found.add(canon);
        assert.match(canon, OPS_PATH_RE, `${svc}/${f} 里的运营路径 ${m[0]} 没有被生产入口认出`);
      }
      // 有运营路由的源文件必须经运营守卫（authorize）
      if (/\/v1(?:\\\/|\/)(?:[a-z]+(?:\\\/|\/))?ops(?:\\\/|\/)/.test(src) && /createServer/.test(src)) assert.match(src, /opsGuard\.authorize\(/, `${svc}/${f} 有运营路由却没有经运营守卫`);
    }
  }
  assert.deepEqual([...found].sort(), ["/v1/notify/ops/x", "/v1/ops/x", "/v1/relay/ops/x", "/v1/support/ops/x"]);
  // 反向对照：新服务的运营路径不在列表里即认不出
  assert.doesNotMatch("/v1/billing/ops/x", OPS_PATH_RE);
});

test("门禁：律师电脑上的代码（内核、闸门、客户端等）不引用本包——驻留面清单把本包列为云端（out_of_scope）的前提", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "vendor" || e.name === "dist" || e.name === "test") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs|cjs|js)$/.test(e.name) && readFileSync(p, "utf8").includes("@zr-legal/ops-auth")) hits.push(p.slice(root.length));
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
});
