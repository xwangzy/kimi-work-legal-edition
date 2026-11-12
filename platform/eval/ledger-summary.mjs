// 从测试栈的账本汇总一轮回归的耗时、用量、成本与工具调用（V16 两轮报告里这些都写“未统计”，其实账本里都有）。
// 用法：node eval/ledger-summary.mjs [--json] <ledger.db | 含 ledger.db 的目录>…　不给参数时取 stacks.json 里各栈的账本。
// 账本须未加密（测试栈以 ZR_AT_REST=off 起）。只读打开。
//
// 口径：
// - 工作时间＝任务首末事件间隔 − 等律师的时间（计划确认、论点提纲、提问到作答）
// - 模型时延＝各次模型调用 latency_ms 之和；成本＝usage_records.cost_microcny 之和（元）
// - “只更新工作清单的往返”＝一次模型调用之后、下一次模型调用之前，只发起了 TodoList 这一种工具
// - 工具质量＝tool_operations.result_summary（第 42 批起才有；旧账本没有这一列时略过）
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
let paths = args.filter((a) => !a.startsWith("--"));
if (paths.length === 0) {
  const { stacks, ledgerOf } = await import("./lib.mjs");
  paths = stacks().map(ledgerOf);
}
function findDb(p) {
  if (!existsSync(p)) return [];
  if (statSync(p).isFile()) return [p];
  const out = [];
  const walk = (d, depth) => {
    for (const f of readdirSync(d)) {
      const x = join(d, f);
      if (f === "ledger.db") out.push(x);
      else if (depth < 4 && statSync(x).isDirectory() && f !== "blobs" && f !== "node_modules") walk(x, depth + 1);
    }
  };
  walk(p, 0);
  return out;
}
const dbs = paths.flatMap(findDb);
if (dbs.length === 0) throw new Error("没有找到 ledger.db");

const ts = (s) => Date.parse(s.endsWith("Z") ? s : s + "Z");
const runs = [];
const toolCounts = {};
const quality = {};
const attribution = {};
let totalLatency = 0;
const perCallInput = [];

for (const file of dbs) {
  const db = new DatabaseSync(file, { readOnly: true });
  const hasSummary = db.prepare(`SELECT 1 AS x FROM pragma_table_info('tool_operations') WHERE name = 'result_summary'`).get();
  for (const r of db.prepare(`SELECT run_id, scenario, status, input_snapshot FROM runs`).all()) {
    const ev = db.prepare(`SELECT type, created_at, payload FROM run_events WHERE run_id = ? ORDER BY event_id`).all(r.run_id);
    if (ev.length === 0) continue;
    let wait = 0, ws = null, review = 0, rs = null, fix = 0, fs = null;
    const toolStarts = [];
    for (const e of ev) {
      const t = ts(e.created_at);
      if (e.type === "agent.approval_requested" || e.type === "agent.question") ws ??= t;
      if ((e.type === "agent.approval_decided" || e.type === "agent.question_answered") && ws !== null) { wait += t - ws; ws = null; }
      if (e.type === "review.started") rs = t;
      if (e.type === "review.completed" && rs !== null) { review += t - rs; rs = null; }
      if (e.type === "review.fix_started") fs = t;
      if (e.type === "review.fix_outcome" && fs !== null) { fix += t - fs; fs = null; }
      if (e.type === "agent.tool_started") {
        let name = "?";
        try { name = String(JSON.parse(e.payload).tool ?? "?").replace("mcp__legal__", ""); } catch {}
        toolStarts.push({ t, name });
        toolCounts[name] = (toolCounts[name] ?? 0) + 1;
      }
    }
    const us = db.prepare(`SELECT created_at, provider_model, tokens_uncached_input AS unc, tokens_cached_input AS cached, tokens_output AS out, tokens_reasoning AS reas, latency_ms AS lat, cost_microcny AS cost FROM usage_records WHERE run_id = ? ORDER BY created_at`).all(r.run_id);
    let todoOnly = 0, todoOnlyLat = 0;
    us.forEach((u, i) => {
      const t = ts(u.created_at);
      const next = i + 1 < us.length ? ts(us[i + 1].created_at) : t + 600_000;
      const names = [...new Set(toolStarts.filter((x) => x.t >= t - 2000 && x.t < next).map((x) => x.name))].sort();
      const key = names.join("+") || "(无工具：答复或思考)";
      const a = (attribution[key] ??= { calls: 0, out: 0, lat: 0 });
      a.calls++; a.out += u.out ?? 0; a.lat += u.lat ?? 0;
      totalLatency += u.lat ?? 0;
      perCallInput.push((u.unc ?? 0) + (u.cached ?? 0));
      if (key === "TodoList") { todoOnly++; todoOnlyLat += u.lat ?? 0; }
    });
    const sum = (k) => us.reduce((n, u) => n + (u[k] ?? 0), 0);
    let skill = "";
    try { const s = JSON.parse(r.input_snapshot ?? "{}"); skill = s.skill ?? s.skill_id ?? ""; } catch {}
    const wall = ts(ev[ev.length - 1].created_at) - ts(ev[0].created_at);
    runs.push({
      run_id: r.run_id, scenario: r.scenario, skill, status: r.status, model: us[0]?.provider_model ?? null,
      work_min: (wall - wait) / 60000, wait_min: wait / 60000, review_min: review / 60000, fix_min: fix / 60000,
      model_min: sum("lat") / 60000, calls: us.length, tools: toolStarts.length, out: sum("out"), reasoning: sum("reas"),
      input: sum("unc") + sum("cached"), cached: sum("cached"), cost_yuan: sum("cost") / 1e6, todo_only_calls: todoOnly, todo_only_min: todoOnlyLat / 60000,
      renders: { docx: toolStarts.filter((x) => x.name === "docx_render_report").length, xlsx: toolStarts.filter((x) => x.name === "xlsx_render_table").length },
    });
    if (hasSummary) {
      for (const o of db.prepare(`SELECT tool, status, result_summary FROM tool_operations WHERE run_id = ?`).all(r.run_id)) {
        const q = (quality[o.tool] ??= { n: 0, failed: 0, status: {}, conflict_reasons: {}, quality_checked: 0, quality_not_ok: 0, quality_kinds: {}, auto_cleaned: 0, shrink: 0 });
        q.n++;
        if (o.status !== "succeeded") q.failed++;
        if (!o.result_summary) continue;
        let s;
        try { s = JSON.parse(o.result_summary); } catch { continue; }
        if (s.status) q.status[s.status] = (q.status[s.status] ?? 0) + 1;
        for (const [k, n] of Object.entries(s.conflict_reasons ?? {})) q.conflict_reasons[k] = (q.conflict_reasons[k] ?? 0) + n;
        if (typeof s.quality_ok === "boolean") { q.quality_checked++; if (!s.quality_ok) q.quality_not_ok++; }
        for (const [k, n] of Object.entries(s.quality_kinds ?? {})) q.quality_kinds[k] = (q.quality_kinds[k] ?? 0) + n;
        if (s.auto_cleaned) q.auto_cleaned++;
        if (s.shrink) q.shrink++;
      }
    }
  }
  db.close();
}

const withModel = runs.filter((r) => r.calls > 0);
const q = (k, rs = withModel) => {
  const v = rs.map((r) => r[k]).sort((a, b) => a - b);
  const n = v.length;
  return n === 0 ? null : { min: v[0], median: v[Math.floor(n / 2)], p90: v[Math.min(n - 1, Math.floor(n * 0.9))], max: v[n - 1], sum: v.reduce((a, b) => a + b, 0) };
};
const total = (k) => withModel.reduce((n, r) => n + r[k], 0);
const byModel = {};
for (const r of withModel) (byModel[r.model ?? "?"] ??= []).push(r);
const summary = {
  ledgers: dbs.length,
  runs: runs.length,
  runs_with_model: withModel.length,
  status: runs.reduce((c, r) => ((c[r.status] = (c[r.status] ?? 0) + 1), c), {}),
  work_min: q("work_min"), wait_min: q("wait_min"), calls: q("calls"), tool_calls: q("tools"), out_tokens: q("out"), reasoning_tokens: q("reasoning"), cost_yuan: q("cost_yuan"),
  over_30_min: withModel.filter((r) => r.work_min > 30).length,
  over_40_min: withModel.filter((r) => r.work_min > 40).length,
  model_share_of_work: total("model_min") / Math.max(1e-9, total("work_min")),
  review_fix_share_of_work: (total("review_min") + total("fix_min")) / Math.max(1e-9, total("work_min")),
  cached_input_share: total("cached") / Math.max(1, total("input")),
  out_tokens_per_second: total("out") / Math.max(1e-9, total("model_min") * 60),
  input_per_call: (() => { const v = perCallInput.sort((a, b) => a - b); return v.length ? { median: v[Math.floor(v.length / 2)], p90: v[Math.floor(v.length * 0.9)] } : null; })(),
  todo_only: { calls: total("todo_only_calls"), share_of_model_time: total("todo_only_min") / Math.max(1e-9, total("model_min")) },
  rerender: { docx_runs_2plus: withModel.filter((r) => r.renders.docx >= 2).length, xlsx_runs_2plus: withModel.filter((r) => r.renders.xlsx >= 2).length },
  by_model: Object.fromEntries(Object.entries(byModel).map(([m, rs]) => [m, { runs: rs.length, work_min_median: q("work_min", rs).median, cost_yuan_median: q("cost_yuan", rs).median, out_tokens_per_second: rs.reduce((n, r) => n + r.out, 0) / Math.max(1e-9, rs.reduce((n, r) => n + r.model_min, 0) * 60) }])),
  attribution: Object.entries(attribution).sort((a, b) => b[1].lat - a[1].lat).slice(0, 15).map(([k, v]) => ({ after_call: k, calls: v.calls, out_tokens: v.out, share_of_model_time: v.lat / Math.max(1, totalLatency) })),
  tools: Object.entries(toolCounts).sort((a, b) => b[1] - a[1]).slice(0, 25),
  tool_quality: quality,
};

if (asJson) console.log(JSON.stringify({ summary, runs }, null, 1));
else {
  const f1 = (x) => (x == null ? "—" : x.toFixed(1));
  const pct = (x) => (x * 100).toFixed(1) + "%";
  const line = (name, o, unit = "") => console.log(`${name}：中位 ${f1(o?.median)}${unit}，p90 ${f1(o?.p90)}${unit}，最大 ${f1(o?.max)}${unit}，合计 ${f1(o?.sum)}${unit}`);
  console.log(`账本 ${summary.ledgers} 个；任务 ${summary.runs} 个（调用过模型的 ${summary.runs_with_model} 个）；状态 ${JSON.stringify(summary.status)}`);
  line("工作时间", summary.work_min, " 分钟");
  console.log(`  超过 30 分钟 ${summary.over_30_min} 个，超过 40 分钟 ${summary.over_40_min} 个；模型时延占 ${pct(summary.model_share_of_work)}；独立复核加修改轮占 ${pct(summary.review_fix_share_of_work)}`);
  line("等律师", summary.wait_min, " 分钟");
  line("模型调用次数", summary.calls);
  line("工具调用次数", summary.tool_calls);
  line("输出 token", summary.out_tokens);
  line("推理 token", summary.reasoning_tokens);
  line("成本", summary.cost_yuan, " 元");
  console.log(`输出速度 ${f1(summary.out_tokens_per_second)} token/秒；输入命中缓存 ${pct(summary.cached_input_share)}；每次调用输入上下文中位 ${summary.input_per_call?.median}、p90 ${summary.input_per_call?.p90}`);
  console.log(`只更新工作清单的往返 ${summary.todo_only.calls} 次，占模型时延 ${pct(summary.todo_only.share_of_model_time)}`);
  console.log(`整份重出：文书重出 2 次以上的任务 ${summary.rerender.docx_runs_2plus} 个，表格 ${summary.rerender.xlsx_runs_2plus} 个`);
  console.log("\n按型号（账本记的是路由到的型号名；网关把它改写成哪个上游型号看各栈的 stacks.json）：");
  for (const [m, v] of Object.entries(summary.by_model)) console.log(`  ${m}：${v.runs} 个，工作时间中位 ${f1(v.work_min_median)} 分钟，成本中位 ${f1(v.cost_yuan_median)} 元，${f1(v.out_tokens_per_second)} token/秒`);
  console.log("\n模型时延花在哪（按一次模型调用之后发起的工具归因）：");
  for (const a of summary.attribution) console.log(`  ${pct(a.share_of_model_time).padStart(6)}  ${String(a.calls).padStart(4)} 次  ${a.after_call.slice(0, 80)}`);
  console.log("\n工具调用次数：" + summary.tools.map(([k, n]) => `${k} ${n}`).join("，"));
  const tq = Object.entries(summary.tool_quality).filter(([, v]) => Object.keys(v.status).length || v.quality_checked || Object.keys(v.conflict_reasons).length);
  if (tq.length) {
    console.log("\n工具结果（状态摘要）：");
    for (const [t, v] of tq) console.log(`  ${t}：${v.n} 次，失败 ${v.failed}；状态 ${JSON.stringify(v.status)}；退回原因 ${JSON.stringify(v.conflict_reasons)}；交付前检查 ${v.quality_checked} 次、未通过 ${v.quality_not_ok} 次 ${JSON.stringify(v.quality_kinds)}；系统自动清理 ${v.auto_cleaned} 次；缩水提示 ${v.shrink} 次`);
  } else console.log("\n工具结果的状态摘要：这些账本里没有（第 42 批之前的版本不记）");
}
