/**
 * 第 66 批（V40）：网关租约里先判套餐权限、后判价格——金额套餐下“既不在套餐里、又没定价”的别名应报 model_not_allowed（403），
 * 不是 price_unconfigured（503）：客户端据前者说“本所套餐不含这个模型”并刷新模型目录、提示换缺省模型。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { LeaseQuota, type LedgerClient } from "../src/index.ts";

const ledger = (allowed: string[] | null): LedgerClient => ({
  lease: async () => ({ ok: true, lease_id: "ls_1", unit: "cny", units: 1_000_000, expires_at: new Date(Date.now() + 600_000).toISOString(), limited_by: null, price_version: 1, allowed_aliases: allowed }),
  settle: async () => ({ ok: true, accepted: 0, duplicates: 0, closed: false }),
});

test("租约：套餐不含且未定价 → model_not_allowed（先权限后价格）；套餐含但未定价 → price_unconfigured；都定价 → 通过", async () => {
  const q = new LeaseQuota({ ledger: ledger(["legal/k3"]), holder: "gw-b66", flushMs: 60_000 });
  const req = (alias: string) => ({ tid: "ten_b66", sid: "s1", alias, estimate: { input: 100, output: 100 } });
  const unpriced = () => null;
  const r1 = await q.reserve(req("legal/k3-fast"), unpriced);
  assert.deepEqual([r1.ok, !r1.ok && r1.code, !r1.ok && r1.status], [false, "model_not_allowed", 403]);
  const r2 = await q.reserve(req("legal/k3"), unpriced);
  assert.deepEqual([r2.ok, !r2.ok && r2.code], [false, "price_unconfigured"]);
  const r3 = await q.reserve(req("legal/k3"), () => 10);
  assert.equal(r3.ok, true);
  await q.close();
});
