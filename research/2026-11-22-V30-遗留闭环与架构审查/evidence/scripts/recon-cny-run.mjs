// KWL_STACK 指向金额计费全链路栈的目录。参数：本机 ledger.db、run_id、北京时间账期（YYYY-MM）。
// 关联键：内核 request_id → 控制面 client_request_id → 网关 request_id。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DIR, inv, ops, sleep } from "./lib.mjs";

const [ledger, runId, month] = process.argv.slice(2);
assert.ok(ledger && runId && /^\d{4}-\d{2}$/.test(month ?? ""), "参数：ledger.db run_id YYYY-MM");
const db = new DatabaseSync(ledger, { readOnly: true });
const run = db.prepare("SELECT status FROM runs WHERE run_id = ?").get(runId);
assert.match(run?.status ?? "", /^(succeeded|partial|failed|cancelled|timed_out)$/);
const local = db.prepare(`
  SELECT request_id AS client_id,
         tokens_uncached_input + tokens_cached_input AS input,
         tokens_cached_input AS cached,
         tokens_output AS output
  FROM usage_records WHERE run_id = ? ORDER BY created_at
`).all(runId);
db.close();
assert.ok(local.length > 0, "该任务没有模型用量");
assert.equal(new Set(local.map((r) => r.client_id)).size, local.length, "客户端请求标识应唯一");

const tid = "ten_b56-firm";
const jsonl = (file) => readFileSync(join(DIR, file), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const cpRows = () => jsonl(`data/cp/control-plane/usage/${month}.jsonl`).filter((r) => r.tid === tid);
let cp;
for (let i = 0; i < 25; i++) {
  cp = cpRows();
  const ids = new Set(cp.map((r) => r.client_request_id));
  if (local.every((r) => ids.has(r.client_id))) break;
  await sleep(2000);
}
const byClient = new Map(cp.map((r) => [r.client_request_id, r]));
const settles = jsonl("data/gw/gateway/meter.jsonl").filter((r) => r.kind === "settle" && r.record?.tid === tid).map((r) => r.record);
const byGateway = new Map(settles.map((r) => [r.request_id, r]));
const routing = await ops("sysadmin", "GET", "/v1/ops/routing");
assert.equal(routing.status, 200);
const prices = routing.json.prices;
const rows = local.map((l) => {
  const c = byClient.get(l.client_id);
  assert.ok(c, `控制面缺少 ${l.client_id}`);
  const g = byGateway.get(c.request_id);
  assert.ok(g, `网关缺少 ${c.request_id}`);
  assert.equal(cp.filter((r) => r.client_request_id === l.client_id).length, 1, `客户端请求在控制面不唯一：${l.client_id}`);
  assert.equal(settles.filter((r) => r.request_id === c.request_id).length, 1, `网关结算行不唯一：${c.request_id}`);
  assert.equal(c.outcome, "ok");
  assert.equal(c.unit, "cny");
  assert.equal(c.usage_source, "upstream");
  for (const key of ["input", "cached", "output"]) {
    assert.equal(l[key], g.usage[key], `内核 / 网关 ${c.request_id} ${key}`);
    assert.equal(g.usage[key], c.usage[key], `网关 / 控制面 ${c.request_id} ${key}`);
  }
  assert.equal(g.price_version, c.price_version);
  assert.equal(c.price_version, prices.version, "请求价目版本须与本轮保存的价目一致");
  const p = prices.items[c.alias];
  assert.ok(Number.isFinite(p?.input) && Number.isFinite(p?.output), `价目缺失：${c.alias}`);
  const handMicro = Math.round((l.input - l.cached) * p.input + l.cached * (p.cached_input ?? p.input) + l.output * p.output);
  assert.equal(handMicro, g.charge_units, `网关微元 ${g.request_id}`);
  assert.equal(handMicro, c.charge, `额度扣减微元 ${g.request_id}`);
  assert.equal(handMicro, c.value_micro, `账本微元 ${g.request_id}`);
  return { client_id: l.client_id, request_id: g.request_id, input: l.input, cached: l.cached, output: l.output, micro: handMicro, price_version: c.price_version };
});
assert.ok(rows.some((r) => r.cached > 0), "该任务缺少缓存命中");
const sum = (key) => rows.reduce((n, r) => n + r[key], 0);
const tenantRows = cp.filter((r) => r.outcome === "ok" && r.unit === "cny");
const tenantMicro = tenantRows.reduce((n, r) => n + r.charge, 0);
const tenantYuan = Math.round(tenantMicro / 100) / 10000;
const bill = (await ops("finance", "GET", `/v1/ops/billing?period=${month}`)).json.rows.find((r) => r.tid === tid);
const quota = await inv("admin", "quota.status");
assert.equal(bill.value_cny, tenantYuan);
assert.equal(quota.firm.used, tenantYuan);
assert.equal(bill.requests, tenantRows.length);
assert.equal(bill.tokens, tenantRows.reduce((n, r) => n + r.usage.input + r.usage.output, 0));

console.log(JSON.stringify({
  runId,
  status: run.status,
  month,
  task: { requests: rows.length, cached_requests: rows.filter((r) => r.cached > 0).length, input: sum("input"), cached: sum("cached"), output: sum("output"), micro: sum("micro") },
  tenant: { former_micro: tenantMicro - sum("micro"), ledger_micro: tenantMicro, quota_yuan: quota.firm.used, bill_yuan: bill.value_cny, bill_requests: bill.requests, bill_tokens: bill.tokens },
  rows,
}, null, 2));
