// 评分一致性：同一批成果由两位（两次）评分人各评一遍，比较两份评分差多少——分数差、通过与否是否一致、否决是否一致、各维度的差。
// 评分是 AI 预验收，本身有波动：两轮回归之间差多少分才算真的变了，要先知道同一份成果评两次会差多少。
// 用法：node eval/agreement.mjs <评分目录甲> <评分目录乙> [--json]　只比两边都有的标签。
import { judge, loadGrades } from "./matrix.mjs";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (args.length < 2) throw new Error("用法：node eval/agreement.mjs <评分目录甲> <评分目录乙> [--json]");
const A = loadGrades(args[0]);
const B = loadGrades(args[1]);
const rows = [];
for (const [tag, a] of A) {
  const b = B.get(tag);
  if (!b || !Number.isFinite(Number(a.score)) || !Number.isFinite(Number(b.score))) continue;
  const ja = judge(a);
  const jb = judge(b);
  rows.push({ tag, a: Number(a.score), b: Number(b.score), diff: Number(b.score) - Number(a.score), pass_a: ja.pass, pass_b: jb.pass, veto_a: (a.veto ?? []).join("、"), veto_b: (b.veto ?? []).join("、"), dims_a: a.dims, dims_b: b.dims });
}
if (rows.length === 0) throw new Error("两个目录没有共同的标签");
const n = rows.length;
const abs = rows.map((r) => Math.abs(r.diff)).sort((x, y) => x - y);
const mean = (v) => v.reduce((x, y) => x + y, 0) / Math.max(1, v.length);
const sd = (v) => Math.sqrt(mean(v.map((x) => (x - mean(v)) ** 2)));
const both = rows.filter((r) => r.dims_a && r.dims_b);
const stats = {
  cards: n,
  mean_a: mean(rows.map((r) => r.a)),
  mean_b: mean(rows.map((r) => r.b)),
  mean_diff: mean(rows.map((r) => r.diff)),
  sd_diff: sd(rows.map((r) => r.diff)),
  mean_abs_diff: mean(abs),
  median_abs_diff: abs[Math.floor(n / 2)],
  max_abs_diff: abs[n - 1],
  within_1: rows.filter((r) => Math.abs(r.diff) <= 1).length,
  within_2: rows.filter((r) => Math.abs(r.diff) <= 2).length,
  pass_agree: rows.filter((r) => r.pass_a === r.pass_b).length,
  pass_a: rows.filter((r) => r.pass_a).length,
  pass_b: rows.filter((r) => r.pass_b).length,
  veto_agree: rows.filter((r) => (r.veto_a !== "") === (r.veto_b !== "")).length,
  dim_mean_abs_diff: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => (both.length ? mean(both.map((r) => Math.abs(r.dims_a[i] - r.dims_b[i]))) : null)),
};
if (process.argv.includes("--json")) console.log(JSON.stringify({ stats, rows }, null, 1));
else {
  console.log("| 标签 | 甲 | 乙 | 差 | 甲按标准 | 乙按标准 | 甲否决 | 乙否决 |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const r of rows) console.log(`| ${r.tag} | ${r.a} | ${r.b} | ${r.diff > 0 ? "+" : ""}${r.diff} | ${r.pass_a ? "通过" : "未通过"} | ${r.pass_b ? "通过" : "未通过"} | ${r.veto_a || "无"} | ${r.veto_b || "无"} |`);
  console.log(`\n共同标签 ${n} 个：甲平均 ${stats.mean_a.toFixed(2)}，乙平均 ${stats.mean_b.toFixed(2)}，平均差 ${stats.mean_diff.toFixed(2)}（标准差 ${stats.sd_diff.toFixed(2)}）`);
  console.log(`分数差的绝对值：平均 ${stats.mean_abs_diff.toFixed(2)}，中位 ${stats.median_abs_diff}，最大 ${stats.max_abs_diff}；差 1 分以内 ${stats.within_1}/${n}，差 2 分以内 ${stats.within_2}/${n}`);
  console.log(`通过与否一致 ${stats.pass_agree}/${n}（甲通过 ${stats.pass_a}，乙通过 ${stats.pass_b}）；有无否决一致 ${stats.veto_agree}/${n}`);
  console.log(`各维度分差绝对值的平均（1～8）：${stats.dim_mean_abs_diff.map((x) => (x == null ? "—" : x.toFixed(2))).join(" ")}`);
}
