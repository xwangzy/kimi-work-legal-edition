/**
 * 控制面运营接口（/v1/ops/…）的最小集；第 46 批起鉴权为平台人员会话 → 角色 → 权限 → 危险操作复核（契约 §2.2、§3.4）。
 * 写操作进律所可见的运营审计流水、执行者为人员编号（stf_…）；每个运营请求另记内部访问审计（先记后做，带人员编号与邮箱）；
 * 无会话、律师会话、无权限、未复核、网段外、路径变形一律拒绝，且都不在律所流水里留记录；复核 A/B 处置：
 * 运营只作废创始开通码、代设上限只能调低、被拒记录限量、概要不带成员标识。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { createAuditLog, createControlPlane, devControlPlaneKeys, type ControlPlane, type CpOpsAccessRecord } from "../src/index.ts";
import { call as rawCall, devStaffOf, STAFF_PW, staffEmail, staffToken } from "./staff-fixture.ts";

// op_0001 / op_0004 客户运营（op_0004 登录后不复核）；op_0002 只读；op_0003 开通专员
const PEOPLE = { op_0001: ["operator"], op_0002: ["viewer"], op_0003: ["issuer"], op_0004: ["operator"] } as const;
const access: CpOpsAccessRecord[] = [];
let accessBroken = false;
const auditLog = createAuditLog();
let cp: ControlPlane;
let base = "";
const tokens = new Map<string, string>();
const aidOf = (who: string) => cp.ops.staff(staffEmail(who))!.aid;

before(async () => {
  cp = createControlPlane({
    keys: devControlPlaneKeys(),
    serviceSecret: "ops-route-test-service-secret",
    auditLog,
    devStaff: devStaffOf(Object.fromEntries(Object.entries(PEOPLE).map(([k, v]) => [k, [...v]]))),
    // 第 53 批（D-218）起来源 IP 判定已废弃：传了“谁都不许”的旧判定也不再生效（只提示一次）
    staffSourceAllowed: () => false,
    opsAccessLog: (r) => {
      if (accessBroken) throw new Error("disk full");
      access.push(r);
    },
  });
  await new Promise<void>((r) => cp.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(cp.server.address() as AddressInfo).port}`;
  for (const who of Object.keys(PEOPLE)) tokens.set(who, await staffToken(base, staffEmail(who), { reauth: who !== "op_0004" }));
});
after(async () => {
  cp.server.closeAllConnections();
  await new Promise<void>((r) => cp.server.close(() => r()));
});

const call = async (who: string, method: string, path: string, body?: unknown, o: { at?: string; headers?: Record<string, string> } = {}) => {
  const r = await rawCall(o.at ?? base, method, path, body, { authorization: `Bearer ${tokens.get(who)}`, ...(o.headers ?? {}) });
  return { status: r.status, json: r.json };
};
const chain = (tid: string) => auditLog.list(tid, 0, 1000);

test("开通、发码、加量、续订、终止：执行者记为人员编号（律所可见的流水）；访问审计先记“已请求”再记结果，带人员编号与邮箱；终止须复核", async () => {
  const created = await call("op_0001", "POST", "/v1/ops/tenants", { tid: "ten_alpha", edition: "team", seats: 5, plan: "pro", name: "阿尔法律师事务所" });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  assert.equal(created.json.tenant.accounts_required, true, "经运营接口开通的租户缺省要求账号登录（第 44 批）");
  assert.equal(cp.ops.tenant("ten_alpha")!.activation_required, true);
  const code = await call("op_0003", "POST", "/v1/ops/tenants/ten_alpha/activation-codes", { slug: "admin", name: "张管理员", ttl_hours: 48 });
  assert.equal(code.status, 200);
  assert.match(code.json.code, /\S{10,}/);
  assert.equal(cp.ops.tenant("ten_alpha")!.activations.get(code.json.activation_id)!.created_by, aidOf("op_0003"), "发码者是具体的平台人员");
  assert.equal((await call("op_0001", "POST", "/v1/ops/tenants/ten_alpha/boost", { pct: 50 })).status, 200);
  assert.equal((await call("op_0001", "POST", "/v1/ops/tenants/ten_alpha/cap", { cap_pct: 80 })).status, 200);
  assert.equal(cp.ops.tenant("ten_alpha")!.quota.cap_set_by, aidOf("op_0001"), "代设上限记到人员编号（复核 RA10A-16）");
  assert.equal((await call("op_0001", "POST", "/v1/ops/tenants/ten_alpha/renew", { days: 30 })).status, 200);
  assert.equal((await call("op_0003", "POST", `/v1/ops/tenants/ten_alpha/activation-codes/${code.json.activation_id}/revoke`)).status, 200);
  const summary = await call("op_0002", "GET", "/v1/ops/tenants/ten_alpha");
  assert.equal(summary.status, 200);
  assert.equal(summary.json.tenant.activation_required, true, "经运营接口开通的租户一律要求开通码");
  assert.equal(summary.json.tenant.boost_pct, 50);
  assert.equal(summary.json.tenant.cap_pct, 80);
  assert.deepEqual(summary.json.tenant.plan, { id: "pro", label: "专业" });
  assert.deepEqual([summary.json.tenant.unit, summary.json.tenant.total, summary.json.tenant.used], ["tokens", 5 * 125_000_000 * 1.5, 0], "专业套餐 5 席 × 1.25 亿 token + 加量 50%");
  assert.deepEqual(summary.json.activation_codes.map((a: any) => [a.status, a.issued_by]), [["revoked", aidOf("op_0003")]]);
  assert.equal(JSON.stringify(summary.json).includes("张管理员"), false, "概要不给成员姓名");
  // 终止订阅是危险操作：本会话 10 分钟内没复核过 → 401 reauth_required；复核后可以
  const noReauth = await call("op_0004", "POST", "/v1/ops/tenants/ten_alpha/terminate");
  assert.deepEqual([noReauth.status, noReauth.json.error.code], [401, "reauth_required"]);
  assert.equal(access.at(-1)!.result, "rejected:reauth_required");
  assert.equal((await rawCall(base, "POST", "/v1/auth/reauth", { password: "Wrong2026password" }, { authorization: `Bearer ${tokens.get("op_0004")}` })).json.error.code, "reauth_invalid");
  const re = await rawCall(base, "POST", "/v1/auth/reauth", { password: STAFF_PW }, { authorization: `Bearer ${tokens.get("op_0004")}` });
  assert.equal(re.status, 200);
  assert.ok(Date.parse(re.json.reauth_until) > Date.now() + 9 * 60_000);
  assert.equal((await call("op_0004", "POST", "/v1/ops/tenants/ten_alpha/terminate")).status, 200);
  const recs = chain("ten_alpha");
  const [a1, a3, a4] = [aidOf("op_0001"), aidOf("op_0003"), aidOf("op_0004")];
  assert.deepEqual(
    recs.map((r) => [r.action, r.actor.kind, r.actor.id, r.result]),
    [
      ["tenant.create", "ops", a1, "ok"],
      ["activation.issue", "ops", a3, "ok"],
      ["quota.boost", "ops", a1, "ok"],
      ["quota.cap_set", "ops", a1, "ok"],
      ["license.renew", "ops", a1, "ok"],
      ["activation.revoke", "ops", a3, "ok"],
      ["license.terminate", "ops", a4, "ok"],
    ],
  );
  const mine = access.filter((r) => r.tid === "ten_alpha").map((r) => `${r.operator}/${r.email}/${r.via}:${r.action}:${r.result}`);
  assert.deepEqual(mine.slice(0, 2), [`${a1}/${staffEmail("op_0001")}/session:tenant.create:requested`, `${a1}/${staffEmail("op_0001")}/session:tenant.create:ok`]);
  assert.ok(mine.includes(`${aidOf("op_0002")}/${staffEmail("op_0002")}/session:tenant.read:ok`));
  assert.equal(JSON.stringify(access).includes(STAFF_PW) || JSON.stringify(access).includes(tokens.get("op_0001")!), false, "访问审计不含密码与会话令牌");
  cp.ops.boostQuota("ten_alpha", 1);
  assert.deepEqual(chain("ten_alpha").at(-1)!.actor, { kind: "ops", id: "ops" }, "进程内调用（开发脚本与测试）仍记笼统的 ops");
});

test("权限按角色：只读的人不能加量、开通专员不能开通（职责分离）；开通附点数拒绝；被拒的不进律所流水；没有会话、律师会话、旧的共享口令一律拒绝", async () => {
  const before = chain("ten_alpha").length;
  const ro = await call("op_0002", "POST", "/v1/ops/tenants/ten_alpha/boost", { pct: 1 });
  assert.deepEqual([ro.status, ro.json.error.code, ro.json.error.need], [403, "perm_denied", "quota.manage"]);
  const issuer = await call("op_0003", "POST", "/v1/ops/tenants", { tid: "ten_beta", edition: "team", seats: 1 });
  assert.deepEqual([issuer.status, issuer.json.error.code], [403, "perm_denied"]);
  assert.equal((await call("op_0003", "GET", "/v1/ops/tenants/ten_alpha/usage")).status, 403, "开通专员没有用量权限（读权限按域拆分）");
  assert.equal((await call("op_0003", "GET", "/v1/ops/billing")).status, 403);
  // 第 40 批取消点数：开通时附带点数一律拒绝
  const preload = await call("op_0004", "POST", "/v1/ops/tenants", { tid: "ten_beta", edition: "team", seats: 1, points: 1_000_000_000 });
  assert.deepEqual([preload.status, preload.json.error.code], [400, "points_removed"]);
  assert.equal(cp.ops.tenant("ten_beta"), undefined);
  assert.equal((await call("op_0004", "POST", "/v1/ops/tenants", { tid: "ten_beta", edition: "team", seats: 1 })).status, 200, "不附点数可以开通（不是危险操作，不要求复核）");
  const shared = await rawCall(base, "POST", "/v1/ops/tenants/ten_alpha/boost", { pct: 1 }, { authorization: "Bearer ops-secret-0123456789", "x-kwl-operator": "ops.zhang" });
  assert.deepEqual([shared.status, shared.json.error.code], [401, "session_required"]);
  const forged = await rawCall(base, "GET", "/v1/ops/tenants", undefined, { authorization: `Bearer kws1.ses_${"A".repeat(16)}.${"B".repeat(43)}` });
  assert.deepEqual([forged.status, forged.json.error.code], [401, "session_invalid"]);
  // 律师账号的会话不能调运营接口
  cp.ops.createTenant({ tid: "ten_lawyer", edition: "team", seats: 2, name: "律师所" });
  const c = cp.ops.issueActivationCode("ten_lawyer", { member: { slug: "boss" } });
  const reg = await rawCall(base, "POST", "/v1/auth/register", { email: "boss@lawyer.cn", password: "Lawyer2026secure", name: "王", code: c.code, client: { platform: "web" } });
  assert.equal(reg.status, 200, reg.text);
  const member = await rawCall(base, "GET", "/v1/ops/tenants", undefined, { authorization: `Bearer ${reg.json.session_token}` });
  assert.deepEqual([member.status, member.json.error.code], [403, "staff_required"]);
  assert.equal(chain("ten_alpha").length, before, "被拒的运营请求不撑大律所的流水");
  assert.ok(access.some((r) => r.operator === aidOf("op_0002") && r.result === "rejected:perm_denied"), "被拒记录在内部访问审计里");
  // 未带会话的畸形请求体：先鉴权，得到 401（不是 400 body_not_json；复核 RA10B-21）
  const junk = await fetch(`${base}/v1/ops/tenants`, { method: "POST", body: "{not json" });
  assert.equal(junk.status, 401);
});

test("运营只作废创始开通码、代设上限只能调低（复核 RA10B-06、RA10A-17）；被拒记录按分钟限量（复核 RA10B-08）", async () => {
  const t = cp.ops.tenant("ten_beta")!;
  // 律所管理员发的成员邀请码（这里直接改状态，模拟管理员设备发码）
  const invite = cp.ops.issueActivationCode("ten_beta", { member: { slug: "founder" } });
  t.activations.get(invite.activation_id)!.kind = "member";
  t.activations.get(invite.activation_id)!.created_by = "dev_beta_zhangsan";
  const r = await call("op_0003", "POST", `/v1/ops/tenants/ten_beta/activation-codes/${invite.activation_id}/revoke`);
  assert.deepEqual([r.status, r.json.error.code], [404, "activation_unknown"]);
  assert.equal(t.activations.get(invite.activation_id)!.status, "open", "成员邀请码不动");
  const summary = await call("op_0002", "GET", "/v1/ops/tenants/ten_beta");
  assert.deepEqual(summary.json.activation_codes, [], "概要不列成员邀请码");
  assert.deepEqual(summary.json.member_invitations, { total: 1, open: 1 });
  assert.equal(JSON.stringify(summary.json).includes("zhangsan"), false, "设备编号里的成员标识不外露（复核 RA10B-05）");
  // 代设上限（百分比）：无上限 → 设 50%（调低）可以；50% → 80%（调高）、50% → 不设（取消）须律所自己
  assert.equal((await call("op_0001", "POST", "/v1/ops/tenants/ten_beta/cap", { cap_pct: 50 })).status, 200);
  for (const cap_pct of [80, null]) {
    const up = await call("op_0001", "POST", "/v1/ops/tenants/ten_beta/cap", { cap_pct });
    assert.deepEqual([up.status, up.json.error.code], [409, "cap_raise_by_firm_only"], String(cap_pct));
  }
  assert.equal((await call("op_0001", "POST", "/v1/ops/tenants/ten_beta/cap", { cap_pct: 30 })).status, 200);
  assert.equal(t.quota.cap_pct, 30);
  // 已认证的运营连发 30 次被拒的加量：律所流水里被拒的记录限量（每分钟 10 条；跨分钟至多 20 条）
  const n0 = chain("ten_beta").filter((x) => x.result.startsWith("rejected:")).length;
  for (let i = 0; i < 30; i++) await call("op_0001", "POST", "/v1/ops/tenants/ten_beta/boost", { pct: -1 });
  const n1 = chain("ten_beta").filter((x) => x.result.startsWith("rejected:boost_invalid")).length - n0;
  assert.ok(n1 >= 10 && n1 <= 20, `被拒记录应限量（得到 ${n1}）`);
});

test("路径按原样匹配：点段的运营请求一律 404；查询串只许 GET；旧运营登录 410；不按来源 IP 限制（旧的来源判定传了也不生效）；未登录 401、越权 403、律师 403", async () => {
  const rawPath = "/v1/x/../ops/tenants/ten_alpha";
  const dot = await new Promise<number>((done, no) => {
    const req = request(`${base}${rawPath}`, { method: "GET", path: rawPath, headers: { authorization: `Bearer ${tokens.get("op_0002")}` } }, (res) => {
      res.resume();
      done(res.statusCode ?? 0);
    });
    req.on("error", no);
    req.end();
  });
  assert.equal(dot, 404);
  assert.equal((await call("op_0002", "GET", "/v1/ops/tenants/ten_alpha?x=1")).status, 200);
  assert.equal((await call("op_0001", "POST", "/v1/ops/tenants/ten_alpha/renew?x=1", { days: 1 })).status, 404);
  for (const p of ["/v1/ops/login", "/v1/ops/logout", "/v1/ops/password"]) assert.equal((await rawCall(base, "POST", p, { login: "x", password: "y" })).json.error.code, "ops_login_removed", p);
  const me = await call("op_0002", "GET", "/v1/ops/me");
  assert.deepEqual([me.json.kind, me.json.account.email, me.json.account.roles], ["staff", staffEmail("op_0002"), ["viewer"]]);
  // 不按来源 IP 限制（D-218）：上面传了“谁都不许”的旧来源判定，运营接口与平台人员登录照样可用；鉴权只看会话与角色
  assert.equal((await call("op_0002", "GET", "/v1/ops/tenants")).status, 200);
  const login = await rawCall(base, "POST", "/v1/auth/login", { email: staffEmail("op_0002"), password: STAFF_PW, client: { platform: "web" } });
  assert.deepEqual([login.status, typeof login.json.session_token, "mfa_required" in login.json], [200, "string", false]);
  const wrong = await rawCall(base, "POST", "/v1/auth/login", { email: staffEmail("op_0002"), password: "Wrong2026password", client: { platform: "web" } });
  assert.deepEqual([wrong.status, wrong.json.error.code], [401, "auth_invalid"], "密码不对时不透露是不是平台人员");
  // 未登录：运营接口 401；只读角色做写操作：403
  assert.equal((await rawCall(base, "GET", "/v1/ops/tenants")).status, 401);
  assert.equal((await call("op_0002", "POST", "/v1/ops/tenants/ten_alpha/renew", { days: 1 })).status, 403);
  // 律师账号不能用运营接口
  const lw = await rawCall(base, "POST", "/v1/auth/login", { email: "boss@lawyer.cn", password: "Lawyer2026secure", client: { platform: "web" } });
  assert.equal(lw.status, 200);
  const lwOps = await rawCall(base, "GET", "/v1/ops/tenants", undefined, { authorization: `Bearer ${lw.json.session_token}` });
  assert.deepEqual([lwOps.status, lwOps.json.error.code], [403, "staff_required"]);
  // 没给 devStaff / 引导的控制面：没有人员，运营接口只能 401（没有会话）
  const bare = createControlPlane({ keys: devControlPlaneKeys(), serviceSecret: "x".repeat(32), opsGuard: {} });
  await new Promise<void>((r) => bare.server.listen(0, "127.0.0.1", () => r()));
  const bareBase = `http://127.0.0.1:${(bare.server.address() as AddressInfo).port}`;
  assert.equal((await rawCall(bareBase, "POST", "/v1/ops/tenants", { tid: "ten_gamma", edition: "team", seats: 1 })).status, 401, "传了旧的 opsGuard 也不再认（只提示一次）");
  assert.equal(bare.ops.tenant("ten_gamma"), undefined);
  bare.server.closeAllConnections();
  await new Promise<void>((r) => bare.server.close(() => r()));
});

test("输入校验与已有租户；吊销设备与席位走运维包装；访问审计写不进去即不执行", async () => {
  const dup = await call("op_0001", "POST", "/v1/ops/tenants", { tid: "ten_alpha", edition: "team", seats: 5 });
  assert.deepEqual([dup.status, dup.json.error.code], [409, "tenant_exists"]);
  for (const [body, codeWant] of [
    [{ tid: "alpha", edition: "team", seats: 1 }, "tid_not_activatable"],
    [{ tid: "ten_delta", edition: "solo", seats: 1 }, "edition_invalid"],
    [{ tid: "ten_delta", edition: "team", seats: 0 }, "seats_invalid"],
    [{ tid: "ten_delta", edition: "team", seats: 1, subscription_days: 99999 }, "days_invalid"],
  ] as const) {
    const r = await call("op_0001", "POST", "/v1/ops/tenants", body);
    assert.deepEqual([r.status, r.json.error.code], [400, codeWant], JSON.stringify(body));
  }
  assert.equal(cp.ops.tenant("ten_delta"), undefined);
  assert.deepEqual((await call("op_0001", "POST", "/v1/ops/tenants/ten_nope/boost", { pct: 1 })).json.error.code, "tenant_unknown");
  const seat = await call("op_0001", "POST", "/v1/ops/tenants/ten_alpha/seats/u-nobody/revoke");
  assert.deepEqual([seat.status, seat.json.error.code], [404, "seat_unknown"]);
  const dev = await call("op_0001", "POST", "/v1/ops/tenants/ten_alpha/devices/dev_alpha_x/revoke", {});
  assert.deepEqual([dev.status, dev.json.error.code], [400, "cert_required"], "尚未登记的设备须附证书（与运维操作同一口径）");
  assert.deepEqual(chain("ten_alpha").at(-1)!.actor, { kind: "ops", id: aidOf("op_0001") });
  assert.equal(chain("ten_alpha").at(-1)!.result, "rejected:cert_required");
  accessBroken = true;
  try {
    const r = await call("op_0001", "POST", "/v1/ops/tenants", { tid: "ten_epsilon", edition: "team", seats: 1 });
    assert.deepEqual([r.status, r.json.error.code], [503, "ops_access_log_unavailable"]);
    assert.equal(cp.ops.tenant("ten_epsilon"), undefined);
  } finally {
    accessBroken = false;
  }
});

test("停用人员即时生效：会话吊销、再登录被拒；启用后可以再登录", async () => {
  cp.ops.staff(staffEmail("op_0002"))!.status = "disabled";
  const r = await call("op_0002", "GET", "/v1/ops/tenants/ten_alpha");
  assert.deepEqual([r.status, r.json.error.code], [403, "account_disabled"]);
  cp.ops.staff(staffEmail("op_0002"))!.status = "active";
  assert.equal((await call("op_0002", "GET", "/v1/ops/tenants/ten_alpha")).status, 200);
});
