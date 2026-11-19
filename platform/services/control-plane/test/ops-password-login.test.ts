/**
 * 网页运营控制台的账号 + 密码登录（控制面 /v1/ops/login、logout、me、password）：
 * 登录返回会话令牌；对外不区分没有这个账号 / 密码错；连错 5 次锁定；初始密码须先改（其余运营接口 403）；改密码吊销其他会话；
 * 退出即失效；名册吊销即时生效；内部访问审计记登录、失败、改密码、退出（不记密码与令牌）；私钥签名路径照常。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpsGuard, createOpsPasswordSessions, emptyOpsCredentials, fileNonceStore, fileOpsCredentialSource, fileRosterSource, setOpsCredential, writeOpsCredentialsFile } from "@zr-legal/ops-auth";
import { devOpsRoster } from "@zr-legal/ops-auth/testing";
import { createAuditLog, createControlPlane, devControlPlaneKeys, type ControlPlane, type CpOpsAccessRecord } from "../src/index.ts";

const PEOPLE = [
  { id: "op_2001", perms: ["tenant.read", "tenant.manage"] as const },
  { id: "op_2002", perms: ["tenant.read"] as const },
];
const OPS = devOpsRoster(PEOPLE.map((p) => ({ id: p.id, perms: [...p.perms] })));
const PW_ADMIN = "Initial-admin-2026";
const PW_READ = "Reader-pass-2026x";
const dir = mkdtempSync(join(tmpdir(), "kwl-ops-pw-cp-"));
const rosterFile = join(dir, "roster.json");
const credFile = join(dir, "credentials.json");
const access: CpOpsAccessRecord[] = [];
let cp: ControlPlane;
let base = "";

before(async () => {
  writeFileSync(rosterFile, JSON.stringify(OPS.roster));
  let doc = setOpsCredential(emptyOpsCredentials(), { operator: "op_2001", login: "zhang.ops", password: PW_ADMIN, mustChange: true });
  doc = setOpsCredential(doc, { operator: "op_2002", login: "reader", password: PW_READ, mustChange: false });
  writeOpsCredentialsFile(credFile, doc);
  // 本文件的请求都来自 127.0.0.1：按来源限频放宽（限频本身在 ops-auth 用例里验）
  const sessions = createOpsPasswordSessions({ credentials: fileOpsCredentialSource(credFile, { maxAgeMs: 0 }), perSourcePerMinute: 100 });
  const opsGuard = createOpsGuard({ audience: "control-plane", roster: fileRosterSource({ file: rosterFile, keys: OPS.rosterKeys, deployment: OPS.deployment, maxAgeMs: 0 }), nonces: fileNonceStore(join(dir, "nonces.jsonl")), sessions });
  cp = createControlPlane({ keys: devControlPlaneKeys(), serviceSecret: "ops-password-login-test-secret-0123456789", auditLog: createAuditLog(), opsGuard, opsAccessLog: (r) => void access.push(r), opsInfo: { deployment: OPS.deployment, roster: () => OPS.roster.body } });
  await new Promise<void>((r) => cp.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(cp.server.address() as AddressInfo).port}`;
});
after(async () => {
  cp.server.closeAllConnections();
  await new Promise<void>((r) => cp.server.close(() => r()));
});

const req = async (method: string, path: string, o: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
  const raw = o.body === undefined ? undefined : JSON.stringify(o.body);
  const r = await fetch(`${base}${path}`, { method, headers: { ...(raw ? { "content-type": "application/json" } : {}), ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.headers ?? {}) }, ...(raw ? { body: raw } : {}) });
  return { status: r.status, json: (await r.json().catch(() => null)) as any };
};
const login = (l: string, password: string) => req("POST", "/v1/ops/login", { body: { login: l, password } });

test("登录 → 初始密码须先改（其余运营接口 403）→ 改密码后可用、其他会话吊销；退出即失效", async () => {
  const a = await login("Zhang.Ops", PW_ADMIN);
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.match(a.json.token, /^kwlops_/);
  assert.equal(a.json.operator, "op_2001");
  assert.equal(a.json.login, "zhang.ops");
  assert.equal(a.json.must_change, true);
  assert.equal(a.json.idle_ms, 30 * 60_000);
  assert.deepEqual(a.json.perms, ["tenant.read", "tenant.manage"]);
  const b = await login("zhang.ops", PW_ADMIN);
  const me = await req("GET", "/v1/ops/me", { token: a.json.token });
  assert.deepEqual([me.status, me.json.operator, me.json.via, me.json.must_change, me.json.kid, me.json.password_login], [200, "op_2001", "password", true, null, true]);
  const blocked = await req("GET", "/v1/ops/tenants", { token: a.json.token });
  assert.deepEqual([blocked.status, blocked.json.error.code], [403, "password_change_required"]);
  const weak = await req("POST", "/v1/ops/password", { token: a.json.token, body: { current: PW_ADMIN, next: "abc" } });
  assert.deepEqual([weak.status, weak.json.error.code], [400, "ops_password_weak"]);
  assert.match(weak.json.error.message, /至少 12 位/);
  assert.deepEqual(weak.json.rules, ["至少 12 位", "同时包含字母和数字"]);
  const wrong = await req("POST", "/v1/ops/password", { token: a.json.token, body: { current: "Not-the-pass-2026", next: "Changed-admin-2026" } });
  assert.deepEqual([wrong.status, wrong.json.error.code, wrong.json.error.message], [400, "ops_password_current_wrong", "当前密码不正确"]);
  const ok = await req("POST", "/v1/ops/password", { token: a.json.token, body: { current: PW_ADMIN, next: "Changed-admin-2026" } });
  assert.deepEqual([ok.status, ok.json.other_sessions_revoked], [200, 1]);
  assert.equal((await req("GET", "/v1/ops/tenants", { token: a.json.token })).status, 200, "改完即可用");
  assert.equal((await req("POST", "/v1/ops/tenants", { token: a.json.token, body: { tid: "ten_pw", edition: "team", seats: 2, name: "密码登录律所" } })).status, 200);
  const other = await req("GET", "/v1/ops/tenants", { token: b.json.token });
  assert.deepEqual([other.status, other.json.error.code], [401, "ops_session_invalid"]);
  assert.match(other.json.error.message, /登录已失效/);
  assert.equal((await login("zhang.ops", PW_ADMIN)).status, 401, "旧密码不能再用");
  assert.equal((await req("POST", "/v1/ops/logout", { token: a.json.token })).status, 200);
  assert.equal((await req("POST", "/v1/ops/logout", { token: a.json.token })).status, 200, "退出幂等");
  assert.equal((await req("GET", "/v1/ops/tenants", { token: a.json.token })).status, 401);
  // 律所可见的流水：执行者是运营编号（与私钥签名同一口径）
  const acc = access.filter((r) => r.operator === "op_2001");
  assert.deepEqual(
    [...new Set(acc.map((r) => `${r.action}:${r.result}`))].filter((x) => /ops\.|tenant\.create/.test(x)),
    ["ops.login:ok", "ops.password_change:rejected:ops_password_weak", "ops.password_change:rejected:ops_password_current_wrong", "ops.password_change:ok", "tenant.create:requested", "tenant.create:ok", "ops.login:rejected:ops_login_invalid", "ops.logout:ok"],
  );
  assert.ok(acc.every((r) => r.op_key === "password" && r.via === "password"));
  assert.ok(acc.some((r) => r.action === "tenant.list" && r.result === "rejected:password_change_required"));
  const dump = JSON.stringify(access);
  for (const secret of [PW_ADMIN, "Changed-admin-2026", a.json.token.slice(7)]) assert.equal(dump.includes(secret), false, "访问审计不记密码与令牌");
});

test("对外不区分没有这个账号 / 密码错；连错 5 次锁定 15 分钟（429，带剩余时间）；锁定期间密码对了也不放行", async () => {
  const unknown = await login("nobody", PW_READ);
  const wrong = await login("reader", "Wrong-reader-2026");
  for (const r of [unknown, wrong]) assert.deepEqual([r.status, r.json.error.code, r.json.error.message], [401, "ops_login_invalid", "账号或密码不对"]);
  assert.equal(JSON.stringify(unknown.json).includes("op_"), false, "错误应答里没有运营编号");
  for (let i = 0; i < 3; i++) assert.equal((await login("reader", `Wrong-reader-${i}026`)).status, 401);
  const locked = await login("reader", "Wrong-reader-9026");
  assert.deepEqual([locked.status, locked.json.error.code], [429, "ops_login_locked"]);
  assert.match(locked.json.error.message, /15 分钟后再试/);
  assert.equal(locked.json.retry_after_ms, 15 * 60_000);
  assert.equal((await login("reader", PW_READ)).json.error.code, "ops_login_locked");
  const rej = access.filter((r) => r.action === "ops.login" && r.result.startsWith("rejected:"));
  assert.ok(rej.some((r) => r.operator === "op_2002" && r.result === "rejected:ops_login_invalid"));
  assert.ok(rej.some((r) => r.operator === "-" && r.result === "rejected:ops_login_invalid"), "没有这个账号：审计记 -");
  assert.ok(rej.some((r) => r.result === "rejected:ops_login_locked"));
  assert.equal(JSON.stringify(access).includes("Wrong-reader"), false);
});

test("私钥签名路径照常（/me 也认，via=key）；名册吊销即时让密码会话失效；请求同时乱带令牌一律 401", async () => {
  const signed = OPS.sign("op_2002", "control-plane", { method: "GET", path: "/v1/ops/me", body: "" });
  const me = await req("GET", "/v1/ops/me", { headers: signed });
  assert.deepEqual([me.status, me.json.via, me.json.kid, me.json.operator], [200, "key", "k1", "op_2002"]);
  const a = await login("zhang.ops", "Changed-admin-2026");
  assert.equal(a.status, 200);
  assert.equal((await req("GET", "/v1/ops/tenants", { token: a.json.token })).status, 200);
  writeFileSync(rosterFile, JSON.stringify(OPS.resign(2, [{ id: "op_2001", perms: ["tenant.read"], status: "revoked" }, { id: "op_2002", perms: ["tenant.read"] }])));
  const after = await req("GET", "/v1/ops/tenants", { token: a.json.token });
  assert.deepEqual([after.status, after.json.error.code], [401, "ops_session_invalid"]);
  assert.equal((await login("zhang.ops", "Changed-admin-2026")).json.error.code, "ops_login_invalid", "已吊销：密码对了也登不进");
  assert.equal((await req("GET", "/v1/ops/tenants", { headers: { authorization: "Bearer kwlops_bad" } })).json.error.code, "ops_session_invalid");
  assert.equal(readFileSync(credFile, "utf8").includes("Changed-admin-2026"), false);
});

test("没配会话的控制面：登录与改密码 404，退出幂等 200，me 只认私钥签名", async () => {
  const plain = createControlPlane({ keys: devControlPlaneKeys(), serviceSecret: "ops-password-plain-secret-0123456789", auditLog: createAuditLog(), opsGuard: createOpsGuard({ audience: "control-plane", roster: fileRosterSource({ file: rosterFile, keys: OPS.rosterKeys, deployment: OPS.deployment }), nonces: fileNonceStore(join(dir, "plain-nonces.jsonl")) }) });
  await new Promise<void>((r) => plain.server.listen(0, "127.0.0.1", () => r()));
  const b = `http://127.0.0.1:${(plain.server.address() as AddressInfo).port}`;
  try {
    const l = await fetch(`${b}/v1/ops/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: "reader", password: PW_READ }) });
    assert.equal(l.status, 404);
    assert.equal((await fetch(`${b}/v1/ops/password`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 404);
    assert.equal((await fetch(`${b}/v1/ops/logout`, { method: "POST" })).status, 200);
    const me = await fetch(`${b}/v1/ops/me`, { headers: { authorization: "Bearer kwlops_AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } });
    assert.equal(me.status, 401);
  } finally {
    plain.server.closeAllConnections();
    await new Promise<void>((r) => plain.server.close(() => r()));
  }
});
