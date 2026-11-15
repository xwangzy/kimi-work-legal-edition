/**
 * 网关计量对账（第 37 批；V19 第 44 批改为读记录里的字段）：把法律模型网关的预写计量日志（<data_dir>/gateway/meter.jsonl）
 * 按“租户 × 月份（北京时间）× 席位 × 模型 × 单位”汇总，供月度计费与控制面用量账本对账（网关计量 ↔ 控制面账本 ↔ 上游 MaaS 账单）。
 *
 * 第 44 批起 settle 行带整条逐请求记录（`record`）：单位数直接用记录里网关算好的 `charge_units`（单位见行上的 `unit`：tokens 或 cny 微元），
 * 不再按代码里的常量重算——价目可在控制台改，按常量重算会和网关实际扣的不一致。控制面结算时按价目版本重算，账本以控制面为准；
 * 本报表用于发现差异（估算行、上游错误、没送达的记录）。第 44 批之前的旧行没有 `record`：只汇总 token，单位数记 0 并计入 legacy_rows。
 * 只读计量日志，不含请求内容（计量记录本来就只有编号与 token 数）。
 *
 * 用法：
 *   node scripts/meter-report.mjs <meter.jsonl> [更多文件…] [--month 2026-11] [--tid ten_xxx] [--by seat|tenant|provider] [--format csv|json] [--out 文件]
 *   多个网关实例的计量文件一并给出即可（按请求编号去重）。--by provider：按上游 × 上游型号汇总（与上游账单对账）。
 */
import { createReadStream, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const files = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
const month = opt("--month");
const onlyTid = opt("--tid");
const by = opt("--by") ?? "seat";
const format = opt("--format") ?? "csv";
const out = opt("--out");
if (!files.length || !["seat", "tenant", "provider"].includes(by) || !["csv", "json"].includes(format) || (month && !/^\d{4}-\d{2}$/.test(month))) {
  console.error("用法：node scripts/meter-report.mjs <meter.jsonl> [更多文件…] [--month YYYY-MM] [--tid ten_xxx] [--by seat|tenant|provider] [--format csv|json] [--out 文件]");
  process.exit(2);
}

// 北京时间自然月（与控制面用量账本同一口径）
const periodOf = (iso) => new Date(Date.parse(iso) + 8 * 3600_000).toISOString().slice(0, 7);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const seen = new Set();
const rows = new Map();
let bad = 0;
let legacy = 0;
for (const f of files) {
  const rl = createInterface({ input: createReadStream(f, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      bad += 1;
      continue;
    }
    if (r.kind !== "settle" || typeof r.at !== "string" || typeof r.tid !== "string") continue;
    const rec = r.record && typeof r.record === "object" ? r.record : null;
    const id = rec?.request_id ?? r.requestId;
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    const period = periodOf(r.at);
    if (month && period !== month) continue;
    if (onlyTid && r.tid !== onlyTid) continue;
    const unit = rec ? String(r.unit ?? "unknown") : "legacy";
    const model = r.model ?? rec?.alias ?? "";
    const provider = rec?.provider ?? "";
    const upstreamModel = rec?.upstream_model ?? r.upstreamModel ?? "";
    const key =
      by === "seat" ? [r.tid, period, r.sid ?? "", model, unit] : by === "tenant" ? [r.tid, period, unit] : [period, provider, upstreamModel, unit];
    const k = key.join("\u0000");
    const acc =
      rows.get(k) ??
      {
        ...(by === "provider" ? { period, provider, upstream_model: upstreamModel } : { tid: r.tid, period, ...(by === "seat" ? { sid: r.sid ?? "", model } : {}) }),
        unit,
        requests: 0,
        ok: 0,
        errors: 0,
        timeouts: 0,
        client_gone: 0,
        estimated: 0,
        input_tokens: 0,
        cached_tokens: 0,
        output_tokens: 0,
        reasoning_tokens: 0,
        charge_units: 0,
        legacy_rows: 0,
      };
    acc.requests += 1;
    if (rec) {
      const outcome = rec.outcome;
      if (outcome === "ok") acc.ok += 1;
      else acc.errors += 1;
      if (outcome === "timeout") acc.timeouts += 1;
      if (outcome === "client_gone") acc.client_gone += 1;
      if (rec.usage_source === "estimated") acc.estimated += 1;
      const u = rec.usage ?? {};
      acc.input_tokens += num(u.input);
      acc.cached_tokens += num(u.cached);
      acc.output_tokens += num(u.output);
      acc.reasoning_tokens += num(u.reasoning);
      acc.charge_units += num(rec.charge_units);
    } else {
      // 第 44 批之前的旧行：没有逐请求记录，只汇总 token；单位数不重算
      legacy += 1;
      acc.legacy_rows += 1;
      if (r.status === 200) acc.ok += 1;
      else acc.errors += 1;
      if (typeof r.reason === "string" && /timeout/.test(r.reason)) acc.timeouts += 1;
      acc.input_tokens += num(r.inputTokens);
      acc.output_tokens += num(r.outputTokens);
      acc.cached_tokens += num(r.cachedTokens);
    }
    rows.set(k, acc);
  }
}
const sortKey = (r) => [r.tid ?? "", r.period, r.provider ?? "", r.sid ?? "", r.model ?? r.upstream_model ?? "", r.unit].join("\u0000");
const list = [...rows.values()].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
let text;
if (format === "json") text = `${JSON.stringify({ generated_at: new Date().toISOString(), files: files.length, rows: list, bad_lines: bad, legacy_rows: legacy }, null, 2)}\n`;
else {
  const head = by === "seat" ? ["tid", "period", "sid", "model", "unit"] : by === "tenant" ? ["tid", "period", "unit"] : ["period", "provider", "upstream_model", "unit"];
  const cols = [...head, "requests", "ok", "errors", "timeouts", "client_gone", "estimated", "input_tokens", "cached_tokens", "output_tokens", "reasoning_tokens", "charge_units", "legacy_rows"];
  text = `${[cols.join(","), ...list.map((r) => cols.map((c) => r[c]).join(","))].join("\n")}\n`;
}
if (out) writeFileSync(out, text);
else process.stdout.write(text);
if (bad || legacy) console.error(`[meter-report] 跳过 ${bad} 行无法解析；${legacy} 条为第 44 批之前的旧行（没有逐请求记录，单位数记 0）`);
