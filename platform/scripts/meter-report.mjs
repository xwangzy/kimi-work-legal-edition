/**
 * 网关计量对账（第 37 批）：把法律模型网关的预写计量日志（<data_dir>/gateway/meter.jsonl）按“租户 × 月份（北京时间）× 席位 × 模型”汇总，
 * 供月度计费与控制面额度账本对账（调研 Y2 §3.3 三方对账：网关计量 ↔ 控制面账本 ↔ 上游 MaaS 账单）。
 *
 * 点数按网关同一规则重算：有 usage → ceil((输入 + 输出) / 1000 × 每千 token 点数)；没有 usage 而 200 且未超时 → 预占点数；其余 0。
 * 只读计量日志，不含请求内容（计量记录本来就只有编号与 token 数）。
 *
 * 用法：
 *   node scripts/meter-report.mjs <meter.jsonl> [更多文件…] [--month 2026-11] [--tid ten_xxx] [--by seat|tenant] [--format csv|json] [--out 文件]
 *   多个网关实例的计量文件一并给出即可（按 requestId 去重）。
 */
import { createReadStream, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { DEFAULT_ROUTES } from "../services/legal-gateway/src/gateway.ts";

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
if (!files.length || !["seat", "tenant"].includes(by) || !["csv", "json"].includes(format) || (month && !/^\d{4}-\d{2}$/.test(month))) {
  console.error("用法：node scripts/meter-report.mjs <meter.jsonl> [更多文件…] [--month YYYY-MM] [--tid ten_xxx] [--by seat|tenant] [--format csv|json] [--out 文件]");
  process.exit(2);
}

// 北京时间自然月（与控制面额度账本 periodOf 同一口径）
const periodOf = (iso) => new Date(Date.parse(iso) + 8 * 3600_000).toISOString().slice(0, 7);
const pointsOf = (r) => {
  const route = DEFAULT_ROUTES[r.model];
  if (r.inputTokens !== null && r.inputTokens !== undefined && route) return Math.ceil((((r.inputTokens ?? 0) + (r.outputTokens ?? 0)) / 1000) * route.pointsPer1k);
  const timedOut = typeof r.reason === "string" && /^upstream_.*_timeout$/.test(r.reason);
  return r.status === 200 && !timedOut ? (r.reserved ?? 0) : 0;
};

const seen = new Set();
const rows = new Map();
let bad = 0;
let unknownModel = 0;
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
    if (r.requestId) {
      if (seen.has(r.requestId)) continue;
      seen.add(r.requestId);
    }
    const period = periodOf(r.at);
    if (month && period !== month) continue;
    if (onlyTid && r.tid !== onlyTid) continue;
    if (!DEFAULT_ROUTES[r.model]) unknownModel += 1;
    const key = by === "seat" ? `${r.tid}\u0000${period}\u0000${r.sid ?? ""}\u0000${r.model ?? ""}` : `${r.tid}\u0000${period}`;
    const acc = rows.get(key) ?? { tid: r.tid, period, ...(by === "seat" ? { sid: r.sid ?? "", model: r.model ?? "" } : {}), requests: 0, ok: 0, errors: 0, timeouts: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0, points: 0 };
    acc.requests += 1;
    if (r.status === 200) acc.ok += 1;
    else acc.errors += 1;
    if (typeof r.reason === "string" && /timeout/.test(r.reason)) acc.timeouts += 1;
    acc.input_tokens += r.inputTokens ?? 0;
    acc.output_tokens += r.outputTokens ?? 0;
    acc.cached_tokens += r.cachedTokens ?? 0;
    acc.points += pointsOf(r);
    rows.set(key, acc);
  }
}
const list = [...rows.values()].sort((a, b) => a.tid.localeCompare(b.tid) || a.period.localeCompare(b.period) || String(a.sid ?? "").localeCompare(String(b.sid ?? "")));
let text;
if (format === "json") text = `${JSON.stringify({ generated_at: new Date().toISOString(), files: files.length, rows: list, bad_lines: bad, unknown_model: unknownModel }, null, 2)}\n`;
else {
  const cols = by === "seat" ? ["tid", "period", "sid", "model", "requests", "ok", "errors", "timeouts", "input_tokens", "output_tokens", "cached_tokens", "points"] : ["tid", "period", "requests", "ok", "errors", "timeouts", "input_tokens", "output_tokens", "cached_tokens", "points"];
  text = `${[cols.join(","), ...list.map((r) => cols.map((c) => r[c]).join(","))].join("\n")}\n`;
}
if (out) writeFileSync(out, text);
else process.stdout.write(text);
if (bad || unknownModel) console.error(`[meter-report] 跳过 ${bad} 行无法解析；${unknownModel} 条模型别名不在缺省路由表（点数按预占计）`);
