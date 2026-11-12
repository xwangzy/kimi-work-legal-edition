// 把一轮评分（每个标签一份 <标签>.json，同名 .md 是评分报告）汇总成验收矩阵，并按《质量评估标准》重新判定是否通过。
// 用法：node eval/matrix.mjs <评分目录> [--prev <上一轮评分目录>] [--json]
//
// 通过口径只有一个（eval/grading/质量评估标准.md 第三节，“可交付”）：
//   未命中一票否决项 且 总分 ≥ 20 且 8 个维度都 ≥ 2 且 成果文件全部能打开。
// 评分人自己写的“已通过 / 未通过”只作对照：两者不一致的逐条列出（V16 及以前各轮口头上按“21 分”“≥20 分”混着说，这里固定下来）。
// 各维度分数优先取 json 里的 dims（8 个数），没有时从同名 .md 的打分表里读；读不到 8 个维度的标“维度缺失”，不算通过。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PASS_SCORE = 20;
export const DIM_FLOOR = 2;

export function dimsFromMarkdown(md) {
  const dims = {};
  for (const m of md.matchAll(/^\|\s*(?:维度\s*)?([1-8])\s*[.、·]?\s*[^|\d][^|]*\|\s*\**([0-3])\**\s*(?:\/\s*3)?\s*\|/gm)) dims[m[1]] ??= Number(m[2]);
  return Object.keys(dims).length === 8 ? [1, 2, 3, 4, 5, 6, 7, 8].map((k) => dims[k]) : null;
}

export function loadGrades(dir) {
  const out = new Map();
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    let j;
    try {
      j = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch {
      continue;
    }
    const tag = j.tag ?? f.slice(0, -5);
    const mdFile = join(dir, f.slice(0, -5) + ".md");
    const dims = Array.isArray(j.dims) && j.dims.length === 8 ? j.dims.map(Number) : existsSync(mdFile) ? dimsFromMarkdown(readFileSync(mdFile, "utf8")) : null;
    out.set(tag, { ...j, tag, dims });
  }
  return out;
}

/** 按标准判定：返回 { pass, why }。 */
export function judge(g) {
  const veto = (g.veto ?? []).length > 0;
  const score = Number(g.score);
  if (veto) return { pass: false, why: `否决 ${g.veto.join("、")}` };
  if (!Number.isFinite(score)) return { pass: false, why: "没有分数" };
  if (g.open_ok === false) return { pass: false, why: "有文件打不开" };
  if (!g.dims) return { pass: false, why: "维度缺失" };
  if (g.dims.reduce((a, b) => a + b, 0) !== score) return { pass: false, why: `各维度之和 ${g.dims.reduce((a, b) => a + b, 0)} ≠ 总分 ${score}` };
  if (score < PASS_SCORE) return { pass: false, why: `总分 ${score} < ${PASS_SCORE}` };
  const low = g.dims.map((d, i) => (d < DIM_FLOOR ? `维度 ${i + 1}＝${d}` : null)).filter(Boolean);
  if (low.length) return { pass: false, why: low.join("、") };
  return { pass: true, why: "" };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("matrix.mjs")) {
  const args = process.argv.slice(2);
  const dir = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--prev");
  if (!dir) throw new Error("用法：node eval/matrix.mjs <评分目录> [--prev <上一轮评分目录>] [--json]");
  const prev = args.includes("--prev") ? loadGrades(args[args.indexOf("--prev") + 1]) : new Map();
  const cur = loadGrades(dir);
  const rows = [...cur.values()].map((g) => {
    const v = judge(g);
    const said = g.status === "已通过" ? true : g.status === "未通过" ? false : null;
    return { tag: g.tag, card: g.card ?? "", veto: (g.veto ?? []).join("、") || "无", score: g.score, dims: g.dims, pass: v.pass, why: v.why, grader_status: g.status ?? "", mismatch: said !== null && said !== v.pass, prev: prev.get(g.tag)?.score ?? g.prev_score ?? null, top: String((g.top_issues ?? [""])[0]).slice(0, 70) };
  });
  const scored = rows.filter((r) => Number.isFinite(Number(r.score)));
  const stats = {
    cards: rows.length,
    pass: rows.filter((r) => r.pass).length,
    mean: scored.reduce((n, r) => n + Number(r.score), 0) / Math.max(1, scored.length),
    veto: rows.filter((r) => r.veto !== "无").length,
    score_at_least_20: scored.filter((r) => r.score >= PASS_SCORE).length,
    grader_said_pass: rows.filter((r) => r.grader_status === "已通过").length,
    mismatches: rows.filter((r) => r.mismatch).map((r) => `${r.tag}（评分人：${r.grader_status}；按标准：${r.pass ? "通过" : "未通过，" + r.why}）`),
    dim_means: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => { const v = rows.filter((r) => r.dims).map((r) => r.dims[i]); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; }),
  };
  if (args.includes("--json")) console.log(JSON.stringify({ stats, rows }, null, 1));
  else {
    console.log("| 标签 | 卡片 | 否决 | 总分 | 各维度 | 按标准 | 未通过原因 | 上一轮 | 最主要的问题 |");
    console.log("|---|---|---|---|---|---|---|---|---|");
    for (const r of rows) console.log(`| ${r.tag} | ${r.card} | ${r.veto} | ${r.score ?? ""} | ${r.dims ? r.dims.join(" ") : "缺"} | ${r.pass ? "通过" : "未通过"} | ${r.why} | ${r.prev ?? ""} | ${r.top} |`);
    console.log(`\n合计 ${stats.cards} 张：按标准通过 ${stats.pass} 张（总分 ≥ ${PASS_SCORE}、各维度 ≥ ${DIM_FLOOR}、无否决、文件能打开）；平均 ${stats.mean.toFixed(2)} 分；否决 ${stats.veto} 张；总分 ≥ ${PASS_SCORE} 的 ${stats.score_at_least_20} 张；评分人自己写“已通过”的 ${stats.grader_said_pass} 张`);
    console.log(`各维度平均（1～8）：${stats.dim_means.map((x) => (x == null ? "—" : x.toFixed(2))).join(" ")}`);
    if (stats.mismatches.length) console.log(`评分人结论与标准不一致 ${stats.mismatches.length} 张：\n  ` + stats.mismatches.join("\n  "));
  }
}
