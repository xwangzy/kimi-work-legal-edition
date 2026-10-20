/**
 * v9.3 A-10 运营按人鉴权：控制面运营接口（/v1/ops/…）的最小集。
 * 按人签名、按接口授权；写操作进律所可见的运营审计流水、执行者为运营编号；每个运营请求另记内部访问审计（先记后做）；
 * 共享口令、无权限、被吊销的人、路径变形一律拒绝，且都不在律所流水里留记录。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devOpsRoster, fileOpsGuard, type OpsRejectRecord } from "@zr-legal/ops-auth";
import { createAuditLog, createControlPlane, devControlPlaneKeys, type ControlPlane, type CpOpsAccessRecord } from "../src/index.ts";

const OPS = devOpsRoster([
  { id: "op_0001", perms: ["tenant.read", "tenant.manage", "activation.issue", "quota.manage", "device.revoke"] },
  { id: "op_0002", perms: ["tenant.read"] },
  { id: "op_0003", perms: ["activation.issue"] },
]);
const opsDir = mkdtempSync(join(tmpdir(), "kwl-cp-ops-"));
const rejects: OpsRejectRecord[] = [];
const access: CpOpsAccessRecord[] = [];
let accessBroken = false;
const auditLog = createAuditLog();
let cp: ControlPlane;
let bare: ControlPlane;
let base = "";
let bareBase = "";

before(async () => {
  cp = createControlPlane({
    keys: devControlPlaneKeys(),
    serviceSecret: "ops-route-test-service-secret",
    auditLog,
    opsGuard: fileOpsGuard({ dir: opsDir, audience: "control-plane", roster: OPS.roster, rosterKeys: OPS.rosterKeys, onReject: (r) => void rejects.push(r) }),
    opsAccessLog: (r) => {
      if (accessBroken) throw new Error("disk full");
      access.push(r);
    },
  });
  bare = createControlPlane({ keys: devControlPlaneKeys(), serviceSecret: "ops-route-test-service-secret" });
  for (const s of [cp.server, bare.server]) await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(cp.server.address() as AddressInfo).port}`;
  bareBase = `http://127.0.0.1:${(bare.server.address() as AddressInfo).port}`;
});
after(async () => {
  for (const s of [cp.server, bare.server]) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

const call = async (who: string, method: string, path: string, body?: unknown, o: { at?: string; headers?: Record<string, string>; signPath?: string } = {}) => {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const headers = { ...OPS.sign(who, "control-plane", { method, path: o.signPath ?? path, body: raw }), ...(raw ? { "content-type": "application/json" } : {}), ...(o.headers ?? {}) };
  const r = await fetch(`${o.at ?? base}${path}`, { method, headers, ...(raw ? { body: raw } : {}) });
  return { status: r.status, json: (await r.json()) as any };
};
const chain = (tid: string) => auditLog.list(tid, 0, 1000);

test("开通、发码、加量、续订、吊销：执行者记为运营编号（律所可见的流水）；访问审计先记“已请求”再记结果，带密钥编号", async () => {
  const created = await call("op_0001", "POST", "/v1/ops/tenants", { tid: "ten_alpha", edition: "team", seats: 5, points: 1000, name: "阿尔法律师事务所" });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  assert.equal(created.json.tenant.activation_required, true, "经运营接口开通的租户一律要求开通码");
  assert.equal(cp.ops.tenant("ten_alpha")!.activation_required, true);
  const code = await call("op_0001", "POST", "/v1/ops/tenants/ten_alpha/activation-codes", { slug: "admin", name: "张管理员", ttl_hours: 48 });
  assert.equal(code.status, 200);
  assert.match(code.json.code, /\S{10,}/);
  assert.equal(cp.ops.tenant("ten_alpha")!.activations.get(code.json.activation_id)!.created_by, "op_0001", "发码者是具体的运营人员");
  assert.equal((await call("op_0001", "POST", "/v1/ops/tenants/ten_alpha/points", { points: 500 })).status, 200);
  assert.equal((await call("op_0001", "POST", "/v1/ops/tenants/ten_alpha/cap", { cap: 800 })).status, 200);
  assert.equal((await call("op_0001", "POST", "/v1/ops/tenants/ten_alpha/renew", { days: 30 })).status, 200);
  assert.equal((await call("op_0003", "POST", `/v1/ops/tenants/ten_alpha/activation-codes/${code.json.activation_id}/revoke`)).status, 200);
  const summary = await call("op_0002", "GET", "/v1/ops/tenants/ten_alpha");
  assert.equal(summary.status, 200);
  assert.equal(summary.json.tenant.quota.pool_remaining, 1500);
  assert.equal(summary.json.tenant.activations[0].status, "revoked");
  assert.equal(JSON.stringify(summary.json).includes("张管理员"), false, "概要不给成员姓名");
  assert.equal(JSON.stringify(summary.json).includes("admin"), false, "概要不给成员标识");
  // 律所可见的流水：每条写操作的执行者都是具体的运营编号
  const recs = chain("ten_alpha");
  assert.deepEqual(
    recs.map((r) => [r.action, r.actor.kind, r.actor.id, r.result]),
    [
      ["tenant.create", "ops", "op_0001", "ok"],
      ["activation.issue", "ops", "op_0001", "ok"],
      ["quota.grant", "ops", "op_0001", "ok"],
      ["quota.cap_set", "ops", "op_0001", "ok"],
      ["license.renew", "ops", "op_0001", "ok"],
      ["activation.revoke", "ops", "op_0003", "ok"],
    ],
  );
  // 内部访问审计：每个请求“已请求 → 结果”，读操作也有
  const mine = access.filter((r) => r.tid === "ten_alpha").map((r) => `${r.operator}/${r.op_key}:${r.action}:${r.result}`);
  assert.deepEqual(mine.slice(0, 2), ["op_0001/k1:tenant.create:requested", "op_0001/k1:tenant.create:ok"]);
  assert.ok(mine.includes("op_0002/k1:tenant.read:requested") && mine.includes("op_0002/k1:tenant.read:ok"));
  // 进程内调用（开发脚本与测试）仍记笼统的 "ops"
  cp.ops.grantPoints("ten_alpha", 1);
  assert.deepEqual(chain("ten_alpha").at(-1)!.actor, { kind: "ops", id: "ops" });
});

test("权限按接口：只读的人不能加量、只能发码的人不能开通；被拒的不进律所流水；共享口令与无签名一律 401", async () => {
  const before = chain("ten_alpha").length;
  const ro = await call("op_0002", "POST", "/v1/ops/tenants/ten_alpha/points", { points: 1 });
  assert.deepEqual([ro.status, ro.json.error.code], [403, "ops_permission_denied"]);
  const issuer = await call("op_0003", "POST", "/v1/ops/tenants", { tid: "ten_beta", edition: "team", seats: 1 });
  assert.deepEqual([issuer.status, issuer.json.error.code], [403, "ops_permission_denied"]);
  assert.equal(cp.ops.tenant("ten_beta"), undefined);
  const shared = await fetch(`${base}/v1/ops/tenants/ten_alpha/points`, { method: "POST", headers: { authorization: "Bearer ops-secret-0123456789", "x-kwl-operator": "ops.zhang", "content-type": "application/json" }, body: '{"points":1}' });
  assert.deepEqual([shared.status, ((await shared.json()) as any).error.code], [401, "ops_auth_missing"]);
  // 签名绑定请求体：改了点数即失效
  const tampered = await call("op_0001", "POST", "/v1/ops/tenants/ten_alpha/points", { points: 999999 }, { headers: OPS.sign("op_0001", "control-plane", { method: "POST", path: "/v1/ops/tenants/ten_alpha/points", body: '{"points":1}' }) });
  assert.deepEqual([tampered.status, tampered.json.error.code], [401, "ops_auth_signature_invalid"]);
  // 签给支持服务的请求拿到控制面用
  const cross = await fetch(`${base}/v1/ops/tenants/ten_alpha`, { headers: OPS.sign("op_0001", "support", { method: "GET", path: "/v1/ops/tenants/ten_alpha" }) });
  assert.equal(cross.status, 401);
  assert.equal(chain("ten_alpha").length, before, "被拒的运营请求不撑大律所的流水");
  assert.ok(rejects.some((r) => r.claimed === "op_0002" && r.reason === "ops_permission_denied" && r.audience === "control-plane"));
});

test("路径按原样匹配：带查询串、点段的运营请求一律 404（入口按原样路径判断来源网段，不能绕过）；未配置运营守卫时整组 404", async () => {
  // fetch 会在本地规范化点段，这里用 http.request 原样发出（签名也按原样路径签，排除“签名不符”）
  const rawPath = "/v1/x/../ops/tenants/ten_alpha";
  const dot = await new Promise<number>((done, no) => {
    const req = request(`${base}${rawPath}`, { method: "GET", path: rawPath, headers: OPS.sign("op_0001", "control-plane", { method: "GET", path: rawPath }) }, (res) => {
      res.resume();
      done(res.statusCode ?? 0);
    });
    req.on("error", no);
    req.end();
  });
  assert.equal(dot, 404);
  const q = await call("op_0001", "GET", "/v1/ops/tenants/ten_alpha?x=1");
  assert.equal(q.status, 404);
  const none = await call("op_0001", "POST", "/v1/ops/tenants", { tid: "ten_gamma", edition: "team", seats: 1 }, { at: bareBase });
  assert.equal(none.status, 404);
  assert.equal(bare.ops.tenant("ten_gamma"), undefined);
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
  assert.deepEqual((await call("op_0001", "POST", "/v1/ops/tenants/ten_nope/points", { points: 1 })).json.error.code, "tenant_unknown");
  const seat = await call("op_0001", "POST", "/v1/ops/tenants/ten_alpha/seats/u-nobody/revoke");
  assert.deepEqual([seat.status, seat.json.error.code], [404, "seat_unknown"]);
  const dev = await call("op_0001", "POST", "/v1/ops/tenants/ten_alpha/devices/dev_alpha_x/revoke", {});
  assert.deepEqual([dev.status, dev.json.error.code], [400, "cert_required"], "尚未登记的设备须附证书（与运维操作同一口径）");
  assert.deepEqual(chain("ten_alpha").at(-1)!.actor, { kind: "ops", id: "op_0001" });
  assert.equal(chain("ten_alpha").at(-1)!.result, "rejected:cert_required");
  // 访问审计不可用：不执行（失败关闭）
  accessBroken = true;
  try {
    const r = await call("op_0001", "POST", "/v1/ops/tenants", { tid: "ten_epsilon", edition: "team", seats: 1 });
    assert.deepEqual([r.status, r.json.error.code], [503, "ops_access_log_unavailable"]);
    assert.equal(cp.ops.tenant("ten_epsilon"), undefined);
  } finally {
    accessBroken = false;
  }
});

test("按人吊销即时生效：新版本名册把 op_0001 标为吊销后其请求被拒，其他人照常；回滚到旧名册整组失败关闭", async () => {
  const file = join(opsDir, "roster.json");
  const put = (doc: unknown) => {
    writeFileSync(`${file}.tmp`, JSON.stringify(doc));
    renameSync(`${file}.tmp`, file);
  };
  put(
    OPS.resign(2, [
      { id: "op_0001", perms: ["tenant.read", "tenant.manage", "activation.issue", "quota.manage", "device.revoke"], status: "revoked" },
      { id: "op_0002", perms: ["tenant.read"] },
      { id: "op_0003", perms: ["activation.issue"] },
    ]),
  );
  const gone = await call("op_0001", "GET", "/v1/ops/tenants/ten_alpha");
  assert.deepEqual([gone.status, gone.json.error.code], [401, "ops_operator_unknown_or_revoked"]);
  assert.equal((await call("op_0002", "GET", "/v1/ops/tenants/ten_alpha")).status, 200);
  put(OPS.roster);
  const rolled = await call("op_0002", "GET", "/v1/ops/tenants/ten_alpha");
  assert.deepEqual([rolled.status, rolled.json.error.code], [503, "ops_roster_unavailable"]);
});
