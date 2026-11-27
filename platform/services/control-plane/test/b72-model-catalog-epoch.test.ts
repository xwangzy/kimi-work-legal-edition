/**
 * 第 72 批（D-299，契约 §5；A1 M1 / M2 / M7）：模型目录只给真的选择。
 * - 内置别名真实映射：legal/k3 → kimi-k3.1-pro、legal/k2.6 → kimi-k2.6（原先两个都指 kimi-k3.1-pro，问答里切 K2.6 实际仍是 K3.1 Pro）；K2.6 问答 + 任务都可选；
 * - 防伪切换：非缺省别名的主上游型号与缺省别名相同 → 照列但置灰（same_upstream + 说明），运营视图出告警 routing.same_upstream；
 * - 目录信封带 epoch：路由状态首次建立 / 迁移（之前没有）时随机生成，运营修改不换；读回定型即写盘，重启不变；
 * - 存量租户读回时按 personal（personalOf 口径）定型 kind 一次，存量团队成员电脑策略写定 approve、存量停用账号回填 disabled_by = platform（安全审查 P1-1 / P2-1），即时写盘。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { bootstrapRouting, migrateRouting, modelCatalogBody, routingView, sameUpstreamAliases, upsertModel } from "../src/routing.ts";
import { createAuditLog, createControlPlane, devControlPlaneKeys } from "../src/index.ts";
import { devStaffOf, staffEmail, staffToken, call } from "./staff-fixture.ts";

const T0 = Date.parse("2026-11-27T02:00:00Z");
const EPOCH_RE = /^[A-Za-z0-9_-]{22}$/;
const plan = { models: null, quota_unit: "tokens" as const };
const routing = () => bootstrapRouting(T0, { provider: { base_url: "https://maas.example.test/v1" } });

test("内置别名真实映射：legal/k3 → kimi-k3.1-pro、legal/k2.6 → kimi-k2.6；K2.6 问答 + 任务、说明写实；目录带 epoch 与 reason_text", () => {
  const r = routing();
  assert.deepEqual(r.models.map((m) => [m.alias, m.targets[0]!.model]), [["legal/k3", "kimi-k3.1-pro"], ["legal/k2.6", "kimi-k2.6"]]);
  assert.match(r.epoch!, EPOCH_RE);
  const doc = modelCatalogBody(r, plan, T0, { tid: "ten_x", uid: "usr_x" });
  assert.equal(doc.epoch, r.epoch);
  const k26 = doc.models.find((m) => m.id === "legal/k2.6")!;
  const k3 = doc.models.find((m) => m.id === "legal/k3")!;
  assert.deepEqual([k26.available, k26.reason, k26.reason_text, k26.scopes, k26.thinking, k26.description], [true, null, null, ["qa", "task"], "toggle", "更快、更省额度，适合整理与摘要"]);
  assert.deepEqual([k3.available, k3.scopes, k3.thinking, k3.description], [true, ["qa", "task"], "effort", "最强，复杂审查与起草"]);
  assert.deepEqual(sameUpstreamAliases(r), []);
  assert.deepEqual(routingView(r, null).warnings, []);
  // 首次部署未配上游（没有目标）：网关用本机兜底（两个别名不同型号），不算同上游
  const bare = bootstrapRouting(T0);
  assert.deepEqual(sameUpstreamAliases(bare), []);
});

test("防伪切换：运营把 K2.6 改指与 K3 相同的型号 → 目录置灰 same_upstream（说明“运营尚未给它配置独立的模型”）、运营视图告警 routing.same_upstream；版本升、纪元不换；改回即恢复", () => {
  const r = routing();
  const epoch = r.epoch;
  const v0 = r.version;
  upsertModel(r, "legal/k2.6", { targets: [{ provider: "maas", model: "kimi-k3.1-pro", priority: 1 }] }, T0, "op");
  assert.ok(r.version > v0);
  assert.equal(r.epoch, epoch, "运营修改不换纪元");
  const k26 = modelCatalogBody(r, plan, T0, { tid: "ten_x", uid: null }).models.find((m) => m.id === "legal/k2.6")!;
  assert.deepEqual([k26.available, k26.reason, k26.reason_text], [false, "same_upstream", "运营尚未给它配置独立的模型"]);
  const w = routingView(r, null).warnings;
  assert.deepEqual(w.map((x) => [x.code, x.alias, x.default_alias, x.model]), [["routing.same_upstream", "legal/k2.6", "legal/k3", "kimi-k3.1-pro"]]);
  // 停用的别名：原因是 disabled（优先），也不出同上游告警
  upsertModel(r, "legal/k2.6", { enabled: false }, T0, "op");
  assert.equal(modelCatalogBody(r, plan, T0, { tid: "ten_x", uid: null }).models.find((m) => m.id === "legal/k2.6")!.reason, "disabled");
  assert.deepEqual(routingView(r, null).warnings, []);
  upsertModel(r, "legal/k2.6", { enabled: true, targets: [{ provider: "maas", model: "kimi-k2.6", priority: 1 }] }, T0, "op");
  assert.equal(modelCatalogBody(r, plan, T0, { tid: "ten_x", uid: null }).models.find((m) => m.id === "legal/k2.6")!.available, true);
});

test("纪元迁移：之前的路由状态没有 epoch → 生成一个；已有的原样保留；不合格的换新", () => {
  const r = routing();
  const old = JSON.parse(JSON.stringify(r));
  delete old.epoch;
  const m1 = migrateRouting(old, T0);
  assert.match(m1.epoch!, EPOCH_RE);
  assert.equal(migrateRouting(JSON.parse(JSON.stringify(r)), T0).epoch, r.epoch);
  assert.notEqual(migrateRouting({ ...JSON.parse(JSON.stringify(r)), epoch: "bad" }, T0).epoch, "bad");
});

test("读回定型（真实控制面 + 状态存储）：存量租户按 personal（且仍是个人形状）定型 kind、长大了的定为 team；路由补纪元；启动即写盘，再次重启纪元不变；运营视图带 epoch 与告警", async () => {
  let saved: string | null = null;
  let saves = 0;
  const store = { load: () => saved, save: (j: string) => ((saved = j), (saves += 1)) };
  const keys = devControlPlaneKeys({ accountCa: true });
  const opts = { keys, serviceSecret: "b72-epoch-secret-0123456789abcdef01", stateStore: store, devStaff: devStaffOf({ op_7291: ["sysadmin"] }) };
  const c1 = createControlPlane({ ...opts, auditLog: createAuditLog() });
  await new Promise<void>((r) => c1.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(c1.server.address() as AddressInfo).port}`;
  try {
    const reg = (email: string) => call(base, "POST", "/v1/auth/register", { email, password: "Lawyer2026secure", name: "某律师", client: { platform: "web" } });
    const r1 = await reg("solo-b72e@example.cn");
    const r2 = await reg("grow-b72e@example.cn");
    assert.deepEqual([r1.status, r2.status], [200, 200]);
    const tok = await staffToken(base, staffEmail("op_7291"));
    const rv = await call(base, "GET", "/v1/ops/routing", undefined, { authorization: `Bearer ${tok}` });
    assert.match(rv.json.epoch, EPOCH_RE);
    assert.deepEqual(rv.json.warnings, []);
  } finally {
    c1.server.closeAllConnections();
    await new Promise<void>((r) => c1.server.close(() => r()));
  }
  // 改成“第 72 批之前”的样子：租户没有 kind、路由没有 epoch；“长大”的那家多一个成员账号（personal 仍为 true）
  const st = JSON.parse(saved!);
  const tSolo = st.tenants.find((t: any) => st.accounts.some((a: any) => a.tid === t.tid && a.email === "solo-b72e@example.cn"));
  const tGrow = st.tenants.find((t: any) => st.accounts.some((a: any) => a.tid === t.tid && a.email === "grow-b72e@example.cn"));
  for (const t of st.tenants) delete t.kind;
  const grower = st.accounts.find((a: any) => a.email === "grow-b72e@example.cn");
  // 这名成员 1.7.0 之前已被停用（没有 disabled_by）
  st.accounts.push({ ...grower, aid: "acc_b72growmember0001", email: "member-b72e@example.cn", member_slug: "mem2", role: "lawyer", phone: null, status: "disabled", disabled_reason: "旧版停用" });
  for (const a of st.accounts) delete a.disabled_by;
  assert.equal(tGrow.personal, true);
  delete st.routing.epoch;
  saved = JSON.stringify(st);
  const n0 = saves;
  const c2 = createControlPlane({ ...opts, auditLog: createAuditLog() });
  assert.ok(saves > n0, "读回定型即写盘");
  assert.deepEqual([c2.ops.tenant(tSolo.tid)!.kind, c2.ops.tenant(tSolo.tid)!.personal], ["personal", true]);
  assert.deepEqual([c2.ops.tenant(tGrow.tid)!.kind, c2.ops.tenant(tGrow.tid)!.personal], ["team", false], "形状不再是个人的：定为团队（之后不再翻转）");
  // 安全审查 P1-1：存量团队显式保持“新电脑要管理员批准”（由管理员自己改成 auto）；个人空间不写
  assert.deepEqual([c2.ops.tenant(tGrow.tid)!.member_device_policy, c2.ops.tenant(tSolo.tid)!.member_device_policy], ["approve", undefined]);
  // 安全审查 P2-1：存量停用账号回填 disabled_by = platform（团队侧不能启用）
  assert.equal(c2.ops.account("member-b72e@example.cn")!.disabled_by, "platform");
  assert.equal(JSON.parse(saved!).accounts.find((a: any) => a.aid === "acc_b72growmember0001").disabled_by, "platform", "已写盘");
  const e2 = JSON.parse(saved!).routing.epoch;
  assert.match(e2, EPOCH_RE);
  assert.ok(JSON.parse(saved!).tenants.every((t: any) => t.kind === "personal" || t.kind === "team"));
  c2.server.close();
  const n1 = saves;
  const c3 = createControlPlane({ ...opts, auditLog: createAuditLog() });
  assert.equal(saves, n1, "已定型的状态读回不再写盘");
  assert.equal(JSON.parse(saved!).routing.epoch, e2, "重启纪元不变");
  assert.equal(c3.ops.tenant(tSolo.tid)!.kind, "personal");
  c3.server.close();
});
