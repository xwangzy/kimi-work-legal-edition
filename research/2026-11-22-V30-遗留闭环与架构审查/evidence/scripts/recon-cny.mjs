// 金额计费真实对账：律所换到金额套餐 → 真实问答 N 次（真实模型）→ 账本逐行按价目手算 ↔ 账本金额 ↔ 额度视图 ↔ 账单 ↔ 网关计量
import { ops, inv, sleep, DIR } from "./lib.mjs";
import { readFileSync, readdirSync, existsSync } from "node:fs";
const TID = "ten_b56-firm";
const out = (k, v) => console.log(k.padEnd(28), typeof v === "string" ? v : JSON.stringify(v));
const chg = await ops("operator", "POST", `/v1/ops/tenants/${TID}/plan`, { plan: process.argv[2] ?? "b56-cny" });
out("换套餐", [chg.status, chg.json?.tenant?.plan?.id ?? chg.text.slice(0, 120)]);
const routing = (await ops("sysadmin", "GET", "/v1/ops/routing")).json;
out("价目版本", routing.prices.version);
const before = (await ops("finance", "GET", `/v1/ops/usage/records?tid=${TID}&limit=200`)).json.records;
const seen = new Set(before.map((r) => r.request_id));
const qs = process.argv.slice(3).length ? process.argv.slice(3) : ["买卖合同里约定“逾期付款按日万分之五计违约金”，法院一般会支持吗？请用三句话回答。", "劳动者被违法解除劳动合同，赔偿金怎么算？请用三句话回答。", "民事案件一审判决的上诉期是多少天？从哪天起算？请用两句话回答。"];
await sleep(2000);
for (const q of qs) {
  const t0 = Date.now();
  try {
    const r = await inv("admin", "chat.send", { text: q, stream_id: `recon_${Date.now()}` });
    const last = r.messages.at(-1);
    out("问答", `${((Date.now() - t0) / 1000).toFixed(1)}s ${r.blocked ? "被拦：" + r.blocked.reason : (last?.text ?? last?.content ?? "").replace(/\s+/g, " ").slice(0, 60)}`);
  } catch (e) { out("问答失败", `${e.code} ${e.message.slice(0, 160)}`); }
}
await sleep(12000); // 网关成批结算：等齐
// 对账范围：本所本期全部按金额计的行（不只这次新增的）
const after = (await ops("finance", "GET", `/v1/ops/usage/records?tid=${TID}&limit=200`)).json.records.filter((r) => r.unit === "cny");
const hist = Object.fromEntries((await ops("sysadmin", "GET", "/v1/ops/routing")).json.price_history.map((h) => [h.version, h]));
let sumLedger = 0, sumHand = 0, bad = 0;
for (const r of after) {
  const u = { input: r.tokens_in ?? r.usage?.input, cached: r.tokens_cached ?? r.usage?.cached, output: r.tokens_out ?? r.usage?.output };
  const p = routing.prices.version === r.price_version ? routing.prices.items[r.alias] : null;
  const hand = p && u.input != null ? Math.round((u.input - u.cached) * p.input + u.cached * (p.cached_input ?? p.input) + u.output * p.output) : null;
  const ledger = r.charge; // 精确微元；value_cny 是按 0.0001 元取整后的显示值
  if (r.outcome === "ok") { sumLedger += ledger; sumHand += hand ?? 0; if (hand !== ledger) bad++; }
  out("账本行", { id: r.request_id.slice(-8), alias: r.alias, outcome: r.outcome, in: u.input, cached: u.cached, out: u.output, pv: r.price_version, unit: r.unit, charge: r.charge, ledger_micro: ledger, hand_micro: hand, same: hand === ledger });
}
out("新增行数", after.length);
out("手算合计(微元)", sumHand);
out("账本合计(微元)", sumLedger);
out("逐行不一致", bad);
const q = await inv("admin", "quota.status");
out("客户端额度视图", { unit: q.unit, firm_used: q.firm?.used, firm_total: q.firm?.total, ratio: q.firm?.used_ratio, own_used: q.own?.used, own_value: q.own?.value_cny });
const month = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7);
const bill = (await ops("finance", "GET", `/v1/ops/billing?period=${month}`)).json.rows.find((x) => x.tid === TID);
out("账单", { value_cny: bill?.value_cny, requests: bill?.requests, tokens: bill?.tokens, unpriced_rows: bill?.unpriced_rows });
// 网关计量（预写日志）：settle 行的上游 usage
const gdir = `${DIR}/data/gw/gateway`;
if (existsSync(gdir)) {
  const ids = new Set(after.map((r) => r.request_id));
  let n = 0, gin = 0, gout = 0, gc = 0;
  for (const f of readdirSync(gdir).filter((x) => /\.jsonl$/.test(x))) for (const l of readFileSync(`${gdir}/${f}`, "utf8").split("\n").filter(Boolean)) { let j; try { j = JSON.parse(l); } catch { continue; } const rec = j.record ?? j; if (ids.has(rec.request_id) && rec.usage) { n++; gin += rec.usage.input; gc += rec.usage.cached; gout += rec.usage.output; } }
  out("网关计量", { rows: n, input: gin, cached: gc, output: gout, files: readdirSync(gdir) });
}
const ok = after.filter((r) => r.outcome === "ok");
out("账本token合计", { input: ok.reduce((s, r) => s + (r.tokens_in ?? 0), 0), cached: ok.reduce((s, r) => s + (r.tokens_cached ?? 0), 0), output: ok.reduce((s, r) => s + (r.tokens_out ?? 0), 0) });
