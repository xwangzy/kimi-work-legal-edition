/**
 * 运营账号密码登录（网页运营控制台）：凭据库、会话（闲置 / 绝对时限、退出、改密码吊销其他会话）、按登录名锁定与按来源限频，
 * 以及守卫：会话请求每次仍按名册核验（吊销即时生效）、名册要求双因素的人密码登录一律拒绝、私钥签名路径不受影响。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOpsGuard,
  createOpsPasswordSessions,
  emptyOpsCredentials,
  fileOpsCredentialSource,
  fileRosterSource,
  generateOpsPassword,
  hashOpsPassword,
  memoryNonceStore,
  memoryOpsCredentialSource,
  normalizeOpsLogin,
  OpsAuthError,
  opsPasswordProblems,
  readOpsCredentialsFile,
  setOpsCredential,
  setOpsCredentialDisabled,
  validateOpsCredentials,
  verifyOpsPassword,
  writeOpsCredentialsFile,
  type OpsGuard,
  type OpsRejectRecord,
} from "../src/index.ts";
import { devOpsRoster } from "../src/testing.ts";

const PW1 = "Ops-console-2026a";
const PW2 = "Another-pass-2026b";
const err = (fn: () => unknown): OpsAuthError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof OpsAuthError) return e;
    throw e;
  }
  throw new Error("没有抛错");
};

test("密码规则与哈希：至少 12 位、字母 + 数字、不含登录名、不收常见弱口令；scrypt 恒定时间比对；初始密码合规且不重复", () => {
  assert.deepEqual(opsPasswordProblems("short1"), ["至少 12 位"]);
  assert.ok(opsPasswordProblems("abcdefghijklmn").includes("同时包含字母和数字"));
  assert.ok(opsPasswordProblems("zhangsan-2026-x", "zhangsan").includes("不要包含登录名"));
  assert.ok(opsPasswordProblems("password1234").includes("太常见，换一个"));
  assert.deepEqual(opsPasswordProblems(PW1, "op_0001"), []);
  const h = hashOpsPassword(PW1);
  assert.equal(verifyOpsPassword(PW1, h), true);
  assert.equal(verifyOpsPassword(PW1.normalize("NFKD"), h), true, "NFKC 规范化");
  assert.equal(verifyOpsPassword("wrong-pass-2026", h), false);
  assert.equal(verifyOpsPassword(PW1, null), false, "没有凭据也算一次、结果一律不通过");
  const a = generateOpsPassword();
  const b = generateOpsPassword();
  assert.match(a, /^[A-Za-z0-9]{5}(-[A-Za-z0-9]{5}){3}$/);
  assert.notEqual(a, b);
  assert.deepEqual(opsPasswordProblems(a), []);
  assert.equal(normalizeOpsLogin("  ZhangSan@Example.COM "), "zhangsan@example.com");
  assert.equal(normalizeOpsLogin("张三"), null);
  assert.equal(normalizeOpsLogin("ab"), null);
});

test("凭据库：逐项校验（编号、登录名唯一、登录名不能是别人的运营编号、scrypt 参数有上下限）；原子写 0600；没有文件 = 空库", () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-ops-cred-"));
  const file = join(dir, "credentials.json");
  assert.deepEqual(readOpsCredentialsFile(file), emptyOpsCredentials());
  let doc = setOpsCredential(emptyOpsCredentials(), { operator: "op_0001", login: "Admin", password: PW1, mustChange: true });
  doc = setOpsCredential(doc, { operator: "op_0002", login: "auditor", password: PW2, mustChange: false });
  assert.equal(validateOpsCredentials(doc), null);
  assert.throws(() => setOpsCredential(doc, { operator: "op_0003", login: "admin", password: PW1, mustChange: true }), /已被占用/);
  assert.throws(() => setOpsCredential(doc, { operator: "op_0003", login: "op_0001", password: PW1, mustChange: true }), /已被占用/);
  assert.throws(() => setOpsCredential(doc, { operator: "zhangsan", login: "zs", password: PW1, mustChange: true }), /运营编号/);
  writeOpsCredentialsFile(file, doc);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readOpsCredentialsFile(file).credentials[0]!.login, "admin");
  assert.doesNotMatch(readFileSync(file, "utf8"), new RegExp(PW1), "库里没有明文密码");
  const bad = structuredClone(doc);
  bad.credentials[0]!.hash.n = 1 << 22;
  assert.equal(validateOpsCredentials(bad), "credentials_malformed", "scrypt 参数过大不收（被改坏的库不能拖垮服务）");
  const dup = structuredClone(doc);
  dup.credentials[1]!.login = "admin";
  assert.equal(validateOpsCredentials(dup), "credentials_login_invalid");
  assert.throws(() => writeOpsCredentialsFile(file, dup), /不合规/);
  const off = setOpsCredentialDisabled(doc, "op_0002", true, Date.now() + 5);
  assert.equal(off.credentials.find((c) => c.operator === "op_0002")!.disabled, true);
  assert.equal(setOpsCredentialDisabled(off, "op_0002", false).credentials.find((c) => c.operator === "op_0002")!.disabled, undefined);
});

test("文件凭据库被命令行改写后自动重读；读不出或不合规时密码登录 503（不回退到空库）", () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-ops-cred-src-"));
  const file = join(dir, "credentials.json");
  let t = 1_000_000;
  const src = fileOpsCredentialSource(file, { now: () => t });
  assert.deepEqual(src.current(), { ok: true, doc: emptyOpsCredentials() });
  writeOpsCredentialsFile(file, setOpsCredential(emptyOpsCredentials(), { operator: "op_0001", login: "admin", password: PW1, mustChange: true }));
  t += 1;
  const cur = src.current();
  assert.ok(cur.ok && cur.doc.credentials.length === 1, "文件变了即重读");
  writeFileSync(file, "{ not json");
  t += 1;
  assert.deepEqual(src.current(), { ok: false, reason: "credentials_unavailable" });
});

function rig(o: { second_factor?: string; mustChange?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kwl-ops-pw-"));
  let t = Date.parse("2026-11-15T02:00:00Z");
  const k = devOpsRoster([
    { id: "op_0001", perms: ["tenant.read", "tenant.manage"], ...(o.second_factor ? { second_factor: o.second_factor } : {}) },
    { id: "op_0002", perms: ["tenant.read"] },
  ], { issuedAt: t - 60_000 });
  writeFileSync(join(dir, "roster.json"), JSON.stringify(k.roster));
  const now = () => t;
  let doc = setOpsCredential(emptyOpsCredentials(), { operator: "op_0001", login: "admin", password: PW1, mustChange: o.mustChange ?? false, now: t - 1000 });
  doc = setOpsCredential(doc, { operator: "op_0002", login: "auditor", password: PW2, mustChange: false, now: t - 1000 });
  const credFile = join(dir, "credentials.json");
  writeOpsCredentialsFile(credFile, doc);
  const creds = fileOpsCredentialSource(credFile, { now, maxAgeMs: 0 });
  const sessions = createOpsPasswordSessions({ credentials: creds, now });
  void statSync;
  const rejects: OpsRejectRecord[] = [];
  const guard = createOpsGuard({ audience: "control-plane", roster: fileRosterSource({ file: join(dir, "roster.json"), keys: k.rosterKeys, deployment: "test", now }), nonces: memoryNonceStore(), now, sessions, onReject: (r) => void rejects.push(r) });
  return { dir, k, guard, sessions, creds, credFile, rejects, advance: (ms: number) => (t += ms), now };
}
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const R = { method: "GET", path: "/v1/ops/tenants" };

test("守卫：密码登录 → 会话令牌；每个请求按名册核权限（via=password、密钥编号记为 password）；私钥签名路径照常（via=key）", () => {
  const { guard, k, rejects, now } = rig();
  const r = guard.login!({ login: " ADMIN ", password: PW1, source: "10.0.0.1" });
  assert.match(r.token, /^kwlops_[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(r.operator, "op_0001");
  assert.equal(r.must_change, false);
  assert.deepEqual(r.perms, ["tenant.read", "tenant.manage"]);
  const who = guard.authorize(bearer(r.token), R, "tenant.manage");
  assert.equal(who.via, "password");
  assert.equal(who.kid, "password");
  assert.equal(who.operator, "op_0001");
  assert.equal(who.session, r.session);
  // 运营编号也能当登录名用
  assert.equal(guard.login!({ login: "op_0002", password: PW2, source: "10.0.0.1" }).operator, "op_0002");
  const ro = guard.login!({ login: "auditor", password: PW2, source: "10.0.0.1" });
  assert.equal(err(() => guard.authorize(bearer(ro.token), R, "tenant.manage")).code, "ops_permission_denied");
  // 篡改令牌、乱写令牌
  assert.equal(err(() => guard.authorize(bearer(`${r.token.slice(0, -1)}A`), R, "tenant.read")).code, "ops_session_invalid");
  assert.equal(err(() => guard.authorize({ authorization: "Bearer kwlops_xxx" }, R, "tenant.read")).code, "ops_session_invalid");
  // 私钥签名路径不受影响
  const signed = guard.authorize(k.sign("op_0002", "control-plane", R, now()), R, "tenant.read");
  assert.equal(signed.via, "key");
  assert.equal(signed.kid, "k1");
  assert.ok(rejects.some((x) => x.reason === "ops_permission_denied" && x.verified && x.claimed === "op_0002"));
});

test("对外不区分“没有这个账号 / 密码错 / 已停用 / 不在名册”；被拒记录里有细分原因；密码只给控制面守卫", () => {
  const { guard, rejects, creds } = rig();
  const codes = [
    err(() => guard.login!({ login: "nobody", password: PW1, source: "s" })),
    err(() => guard.login!({ login: "admin", password: "Wrong-pass-2026", source: "s" })),
  ];
  creds.update((d) => setOpsCredentialDisabled(d, "op_0002", true));
  codes.push(err(() => guard.login!({ login: "auditor", password: PW2, source: "s" })));
  for (const e of codes) {
    assert.equal(e.status, 401);
    assert.equal(e.code, "ops_login_invalid");
    assert.equal(e.info, undefined, "对外没有附加信息");
  }
  assert.deepEqual(
    rejects.map((x) => x.reason),
    ["ops_login_login_unknown", "ops_login_password_wrong", "ops_login_credential_disabled"],
  );
  assert.equal(rejects[1]!.claimed, "op_0001");
  assert.doesNotMatch(JSON.stringify(rejects), /Wrong-pass|Ops-console/, "被拒记录里没有密码");
  assert.throws(() => createOpsGuard({ audience: "support", roster: { current: () => ({ ok: false, reason: "x" }) }, nonces: memoryNonceStore(), sessions: createOpsPasswordSessions({ credentials: memoryOpsCredentialSource() }) }), /只给控制面/);
  const plain = createOpsGuard({ audience: "control-plane", roster: { current: () => ({ ok: false, reason: "x" }) }, nonces: memoryNonceStore() }) as OpsGuard;
  assert.equal(plain.login, undefined, "没配会话 = 不开密码登录");
});

test("锁定：同一登录名 15 分钟内失败 5 次锁 15 分钟（不存在的登录名同样锁，锁定期间密码对了也不放行）；成功清零；按来源每分钟限 10 次", () => {
  const { guard, advance } = rig();
  for (let i = 0; i < 4; i++) assert.equal(err(() => guard.login!({ login: "admin", password: `Wrong-pass-${i}000`, source: `s${i}` })).code, "ops_login_invalid");
  const fifth = err(() => guard.login!({ login: "admin", password: "Wrong-pass-5000", source: "s5" }));
  assert.equal(fifth.code, "ops_login_locked");
  assert.equal(fifth.status, 429);
  assert.equal(fifth.info?.retry_after_ms, 15 * 60_000);
  assert.equal(err(() => guard.login!({ login: "admin", password: PW1, source: "s6" })).code, "ops_login_locked", "锁定期间密码对了也不放行");
  for (let i = 0; i < 5; i++) err(() => guard.login!({ login: "ghost", password: "Wrong-pass-0000", source: `g${i}` }));
  assert.equal(err(() => guard.login!({ login: "ghost", password: "Wrong-pass-0000", source: "g9" })).code, "ops_login_locked", "不存在的登录名同样锁（不泄露是否存在）");
  advance(15 * 60_000 + 1);
  assert.equal(guard.login!({ login: "admin", password: PW1, source: "s7" }).operator, "op_0001");
  // 成功后清零：再错 4 次不锁
  for (let i = 0; i < 4; i++) assert.equal(err(() => guard.login!({ login: "admin", password: `Wrong-pass-${i}111`, source: `t${i}` })).code, "ops_login_invalid");
  // 同一来源每分钟至多 10 次
  advance(60_000);
  for (let i = 0; i < 10; i++) err(() => guard.login!({ login: `user${i}x`, password: "Wrong-pass-0000", source: "flood" }));
  assert.equal(err(() => guard.login!({ login: "auditor", password: PW2, source: "flood" })).code, "ops_login_throttled");
  assert.equal(guard.login!({ login: "auditor", password: PW2, source: "elsewhere" }).operator, "op_0002");
});

test("会话时限：闲置 30 分钟失效、有请求即续；绝对 8 小时到期；退出即吊销；只在内存（另起一套会话即全部失效）", () => {
  const { guard, advance, creds, now } = rig();
  const r = guard.login!({ login: "admin", password: PW1, source: "s" });
  advance(29 * 60_000);
  assert.equal(guard.authorize(bearer(r.token), R, "tenant.read").operator, "op_0001");
  advance(29 * 60_000);
  assert.equal(guard.authorize(bearer(r.token), R, "tenant.read").operator, "op_0001", "有请求即续闲置时限");
  advance(30 * 60_000);
  assert.equal(err(() => guard.authorize(bearer(r.token), R, "tenant.read")).code, "ops_session_invalid", "闲置 30 分钟失效");
  const r2 = guard.login!({ login: "admin", password: PW1, source: "s" });
  for (let i = 0; i < 16; i++) {
    advance(29 * 60_000);
    guard.authorize(bearer(r2.token), R, "tenant.read");
  }
  advance(29 * 60_000);
  assert.equal(err(() => guard.authorize(bearer(r2.token), R, "tenant.read")).code, "ops_session_invalid", "绝对 8 小时到期");
  const r3 = guard.login!({ login: "admin", password: PW1, source: "s" });
  assert.deepEqual(guard.logout!(bearer(r3.token)), { operator: "op_0001", session: r3.session });
  assert.equal(guard.logout!(bearer(r3.token)), null, "退出幂等");
  assert.equal(err(() => guard.authorize(bearer(r3.token), R, "tenant.read")).code, "ops_session_invalid");
  // 服务重启（新的会话表）：旧令牌全部失效
  const r4 = guard.login!({ login: "admin", password: PW1, source: "s" });
  const restarted = createOpsPasswordSessions({ credentials: creds, now });
  assert.equal(restarted.verify(r4.token).ok, false);
});

test("名册吊销、改权限、要求双因素即时生效；命令行重置或停用凭据即令已有登录失效", () => {
  const { guard, k, dir, creds, advance } = rig();
  const r = guard.login!({ login: "admin", password: PW1, source: "s" });
  writeFileSync(join(dir, "roster.json"), JSON.stringify(k.resign(2, [{ id: "op_0001", perms: ["tenant.read"] }, { id: "op_0002", perms: ["tenant.read"] }])));
  advance(1);
  assert.equal(err(() => guard.authorize(bearer(r.token), R, "tenant.manage")).code, "ops_permission_denied", "改权限即时生效");
  writeFileSync(join(dir, "roster.json"), JSON.stringify(k.resign(3, [{ id: "op_0001", perms: ["tenant.read"], status: "revoked" }, { id: "op_0002", perms: ["tenant.read"] }])));
  advance(1);
  assert.equal(err(() => guard.authorize(bearer(r.token), R, "tenant.read")).code, "ops_session_invalid", "吊销即时生效");
  assert.equal(err(() => guard.login!({ login: "admin", password: PW1, source: "s" })).code, "ops_login_invalid", "已吊销的人密码对了也登不进");
  // 命令行重置（凭据更新时刻变了）：已有登录失效
  const r2 = guard.login!({ login: "auditor", password: PW2, source: "s" });
  creds.update((d) => setOpsCredential(d, { operator: "op_0002", password: "Reset-by-cli-2026", mustChange: true, now: Date.now() + 10 }));
  assert.equal(err(() => guard.authorize(bearer(r2.token), R, "tenant.read")).code, "ops_session_invalid");
  const r3 = guard.login!({ login: "auditor", password: "Reset-by-cli-2026", source: "s" });
  assert.equal(r3.must_change, true);
  assert.equal(guard.authorize(bearer(r3.token), R, "tenant.read").must_change, true);
  creds.update((d) => setOpsCredentialDisabled(d, "op_0002", true, Date.now() + 20));
  assert.equal(err(() => guard.authorize(bearer(r3.token), R, "tenant.read")).code, "ops_session_invalid", "停用即失效");
  // 名册要求双因素：密码登录一律拒绝（失败关闭）
  const sf = rig({ second_factor: "totp" });
  assert.equal(err(() => sf.guard.login!({ login: "admin", password: PW1, source: "s" })).code, "ops_login_invalid");
  assert.ok(sf.rejects.some((x) => x.reason === "ops_second_factor_unavailable" && x.verified));
});

test("本人改密码：核当前密码（错了计入锁定）、新密码合规且不同于旧的；成功后须改标记清除、此人其他会话全部吊销、本会话继续可用", () => {
  const { guard, credFile } = rig({ mustChange: true });
  const a = guard.login!({ login: "admin", password: PW1, source: "s" });
  const b = guard.login!({ login: "admin", password: PW1, source: "s" });
  assert.equal(a.must_change, true);
  assert.equal(err(() => guard.changePassword!(bearer(a.token), "Wrong-pass-2026", "Brand-new-pass-2026")).code, "ops_password_current_wrong");
  const weak = err(() => guard.changePassword!(bearer(a.token), PW1, "short"));
  assert.equal(weak.code, "ops_password_weak");
  assert.deepEqual(weak.info?.rules, ["至少 12 位", "同时包含字母和数字"]);
  assert.ok((err(() => guard.changePassword!(bearer(a.token), PW1, PW1)).info?.rules as string[]).includes("不能与当前密码相同"));
  assert.equal(err(() => guard.changePassword!({}, PW1, "Brand-new-pass-2026")).code, "ops_session_invalid");
  const r = guard.changePassword!(bearer(a.token), PW1, "Brand-new-pass-2026");
  assert.equal(r.other_sessions_revoked, 1);
  const me = guard.authorize(bearer(a.token), R, []);
  assert.equal(me.must_change, false, "改完即可正常使用");
  assert.equal(err(() => guard.authorize(bearer(b.token), R, [])).code, "ops_session_invalid", "其他会话被吊销");
  assert.equal(err(() => guard.login!({ login: "admin", password: PW1, source: "s2" })).code, "ops_login_invalid");
  assert.equal(guard.login!({ login: "admin", password: "Brand-new-pass-2026", source: "s2" }).must_change, false);
  assert.doesNotMatch(readFileSync(credFile, "utf8"), /Brand-new-pass/);
  // 改密码时当前密码连错 5 次：锁定
  const c = guard.login!({ login: "auditor", password: PW2, source: "s3" });
  for (let i = 0; i < 4; i++) err(() => guard.changePassword!(bearer(c.token), `Wrong-pass-${i}222`, "Brand-new-pass-2027"));
  assert.equal(err(() => guard.changePassword!(bearer(c.token), "Wrong-pass-9222", "Brand-new-pass-2027")).code, "ops_login_locked");
});
