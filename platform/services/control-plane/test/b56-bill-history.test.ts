/**
 * 第 56 批（云端审计 1-A）：历史月份的账单按该月结束时的套餐、席位、单价与加量算。
 * 改前：`billRow` 对历史月份一律用“现在”的套餐与席位，加量费恒为 0——11 月加量 50%、12 月换了套餐并加了席位，再查 11 月账单全不对。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createControlPlane, devControlPlaneKeys, type ControlPlane } from "../src/index.ts";
import { devStaffOf, staffClient } from "./staff-fixture.ts";

let clock = Date.parse("2026-11-10T02:00:00Z");
let cp: ControlPlane;
let base = "";
let ops = staffClient(() => base);

before(async () => {
  cp = createControlPlane({ keys: devControlPlaneKeys(), serviceSecret: "b56-bill-history-secret-000000", now: () => clock, devStaff: devStaffOf({ op_1: ["operator"], fin_1: ["finance"] }) });
  await new Promise<void>((r) => cp.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(cp.server.address() as AddressInfo).port}`;
});
after(async () => {
  cp.server.closeAllConnections();
  await new Promise<void>((r) => cp.server.close(() => r()));
});

test("历史月份账单：按当月结束时的套餐、席位、单价、加量；没有记录的更早月份标“按当前估算”", async () => {
  const tid = "ten_b56-bill";
  // 11 月：专业版（席位单价 300）3 席，加量 50%
  assert.equal((await ops("op_1", "PUT", "/v1/ops/plans/b56-pro", { label: "专业", quota_unit: "tokens", seat_quota: 1_000_000, seat_price_cny: 300, boost_price_factor: 1 })).status, 200);
  assert.equal((await ops("op_1", "PUT", "/v1/ops/plans/b56-max", { label: "旗舰", quota_unit: "tokens", seat_quota: 5_000_000, seat_price_cny: 800, boost_price_factor: 1 })).status, 200);
  const mk = await ops("op_1", "POST", "/v1/ops/tenants", { tid, edition: "team", seats: 3, name: "账单历史律所", plan: "b56-pro" });
  assert.equal(mk.status, 200, mk.text);
  assert.equal((await ops("op_1", "POST", `/v1/ops/tenants/${tid}/boost`, { pct: 50 })).status, 200);
  const nov = async () => (await ops("fin_1", "GET", "/v1/ops/billing?period=2026-11")).json.rows.find((x: any) => x.tid === tid);
  let b = await nov();
  assert.deepEqual([b.basis, b.plan.id, b.seats, b.seat_fee_cny, b.boost_pct, b.boost_fee_cny, b.revenue_cny], ["current", "b56-pro", 3, 900, 50, 450, 1350]);
  // 进入 12 月：换旗舰版、加到 5 席（12 月自己的账单按新的算）
  clock = Date.parse("2026-12-03T02:00:00Z");
  ops = staffClient(() => base); // 钟拨了三周：原会话已过闲置时限，重新登录
  assert.equal((await ops("op_1", "POST", `/v1/ops/tenants/${tid}/plan`, { plan: "b56-max", seats: 5 })).status, 200);
  const dec = (await ops("fin_1", "GET", "/v1/ops/billing?period=2026-12")).json.rows.find((x: any) => x.tid === tid);
  assert.deepEqual([dec.basis, dec.plan.id, dec.seats, dec.seat_fee_cny, dec.boost_pct, dec.revenue_cny], ["current", "b56-max", 5, 4000, 0, 4000]);
  // 再查 11 月：仍是专业版 3 席、加量 50%（改前：旗舰版 5 席 4,000 元、加量费 0）
  b = await nov();
  assert.deepEqual([b.basis, b.plan.id, b.seats, b.seat_price_cny, b.seat_fee_cny, b.boost_pct, b.boost_fee_cny, b.revenue_cny], ["period_end", "b56-pro", 3, 300, 900, 50, 450, 1350]);
  // 没有留下记录的更早月份：按当前值估，并标明
  const oct = (await ops("fin_1", "GET", "/v1/ops/billing?period=2026-10")).json.rows.find((x: any) => x.tid === tid);
  assert.equal(oct.basis, "current_estimate");
});
