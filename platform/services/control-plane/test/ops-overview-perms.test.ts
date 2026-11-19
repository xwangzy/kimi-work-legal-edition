/**
 * 第 46 批复核：总览（GET /v1/ops/overview）只要求 tenant.read——金额只给有 billing.read 的角色，请求与 token 只给有 usage.read 的角色；
 * 裁掉的字段整块不给，hidden 写明（控制台据此不画对应卡片）。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createControlPlane, devControlPlaneKeys, type ControlPlane } from "../src/index.ts";
import { call, devStaffOf, staffEmail, staffToken } from "./staff-fixture.ts";

let cp: ControlPlane;
let base = "";
before(async () => {
  cp = createControlPlane({ keys: devControlPlaneKeys(), serviceSecret: "ops-overview-perms-secret-000", staffMfa: "optional", devStaff: devStaffOf({ op_0101: ["finance"], op_0102: ["issuer"], op_0103: ["support"], op_0104: ["operator"] }), opsAccessLog: () => {} });
  await new Promise<void>((r) => cp.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(cp.server.address() as AddressInfo).port}`;
});
after(async () => {
  cp.server.closeAllConnections();
  await new Promise<void>((r) => cp.server.close(() => r()));
});

const overview = async (who: string) => (await call(base, "GET", "/v1/ops/overview", undefined, { authorization: `Bearer ${await staffToken(base, staffEmail(who), { reauth: false })}` })).json;

test("总览按权限裁剪：财务看金额与用量；开通专员两样都不给；客服给用量不给金额；客户运营都给", async () => {
  const fin = await overview("op_0101");
  assert.deepEqual(fin.hidden, []);
  assert.ok("revenue_cny" in fin.totals && "requests" in fin.totals);

  const iss = await overview("op_0102");
  assert.deepEqual(iss.hidden.sort(), ["billing", "usage"]);
  for (const k of ["revenue_cny", "margin_cny", "cost_cny", "value_cny", "requests", "tokens_in"]) assert.ok(!(k in iss.totals), `开通专员不该拿到 ${k}`);
  assert.deepEqual([iss.daily, iss.by_model], [[], []]);
  assert.ok(iss.tenants && iss.accounts, "规模（律所、账号数）照常给");

  const sup = await overview("op_0103");
  assert.deepEqual(sup.hidden, ["billing"]);
  assert.ok(!("revenue_cny" in sup.totals) && "requests" in sup.totals);
  assert.ok(sup.daily.every((d: Record<string, unknown>) => !("value_cny" in d) && !("cost_cny" in d)));

  const op = await overview("op_0104");
  assert.deepEqual(op.hidden, []);
});
