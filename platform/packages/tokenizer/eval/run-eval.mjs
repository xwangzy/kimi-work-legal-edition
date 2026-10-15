/**
 * 令牌化召回评测命令行（S8）：node packages/tokenizer/eval/run-eval.mjs <gold.jsonl> [--out report] [--full-pseudonym] [--case-numbers]
 *   [--locked locked-manifest.json] [--gate thresholds.json]
 * 同时报告“有当事人词典”与“只靠规则”两种情形；输出 report.json / report.md（只含计数与比例）。
 * --locked：先核对金标准文件与锁定清单一致（不一致即退出 1）；--gate：按“只靠规则”的结果逐来源检查阈值——
 * 阈值文件 status 为 approved 时不过即退出 1（发布门禁），draft 时只打印结论（阈值待产品与法务拍板）。
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const { MatterTokenizer } = await import("../src/index.ts");
const { aggregateBySource, evaluateDoc, reportMarkdown, validateGold } = await import("./evaluate.ts");
const { checkGate, validateThresholds, verifyLocked } = await import("./gate.ts");

const argv = process.argv.slice(2);
const VALUED = ["--out", "--locked", "--gate"];
const file = argv.find((a, i) => !a.startsWith("--") && !VALUED.includes(argv[i - 1]));
if (!file) {
  console.error("用法：node packages/tokenizer/eval/run-eval.mjs <gold.jsonl> [--out report] [--full-pseudonym] [--case-numbers]");
  process.exit(2);
}
const out = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : "report";
const fullPseudonym = argv.includes("--full-pseudonym");
const caseNumbers = argv.includes("--case-numbers");
const lockedPath = argv.includes("--locked") ? argv[argv.indexOf("--locked") + 1] : null;
const gatePath = argv.includes("--gate") ? argv[argv.indexOf("--gate") + 1] : null;
// 门禁必须对锁定集运行（复核 S6A-06）：给了 --gate 就必须同时给 --locked
if (gatePath && !lockedPath) {
  console.error("--gate 必须与 --locked 一起使用（门禁只对锁定集运行）");
  process.exit(2);
}
const bytes = readFileSync(file);
const docs = bytes.toString("utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
if (lockedPath) {
  const problems = verifyLocked(bytes, docs, JSON.parse(readFileSync(lockedPath, "utf8")));
  if (problems.length) {
    console.error(`锁定集核对失败：\n${problems.join("\n")}`);
    process.exit(1);
  }
}
const bad = docs.flatMap((d) => validateGold(d).map((p) => `${d.doc_id}: ${p}`));
if (bad.length) {
  console.error(`金标准不合格（${bad.length} 处）：\n${bad.slice(0, 20).join("\n")}`);
  process.exit(1);
}
const key = randomBytes(32);
const make = (useDict) => (parties) => new MatterTokenizer({ matterKey: key, parties: useDict ? parties : [], fullPseudonym, caseNumbers });
// 按来源分节（复核 B4-R07）：公开文书、律所进所、合成集各自报告，不合并成一个数
const withDict = aggregateBySource(docs.map((d) => evaluateDoc(d, make(true))));
const rulesOnly = aggregateBySource(docs.map((d) => evaluateDoc(d, make(false))));
// 按事项类型分节（复核 S6A-07；Y5 §4.4“按来源与事项类型分别报告”）：抽样脚本写入的 stratum 与来源组合成分组键
const hasStrata = docs.some((d) => typeof d.stratum === "string" && d.stratum);
const byStratum = hasStrata ? aggregateBySource(docs.map((d) => evaluateDoc({ ...d, source: `${d.source} · ${typeof d.stratum === "string" && d.stratum ? d.stratum : "未分类"}` }, make(false)))) : null;
writeFileSync(`${out}.json`, JSON.stringify({ fullPseudonym, caseNumbers, withDictionary: withDict, rulesOnly, ...(byStratum ? { rulesOnlyByStratum: byStratum } : {}) }, null, 2));
const md = [];
for (const src of Object.keys(withDict)) {
  md.push(reportMarkdown(`令牌化召回评测 · ${src}（有当事人词典）`, withDict[src]), "", reportMarkdown(`令牌化召回评测 · ${src}（只靠规则）`, rulesOnly[src]), "");
}
if (byStratum) for (const k of Object.keys(byStratum)) md.push(reportMarkdown(`令牌化召回评测 · ${k}（只靠规则，按事项类型）`, byStratum[k]), "");
let gateFailed = false;
if (gatePath) {
  const t = JSON.parse(readFileSync(gatePath, "utf8"));
  const bad = validateThresholds(t);
  if (bad.length) {
    console.error(`阈值文件不合格：\n${bad.join("\n")}`);
    process.exit(2);
  }
  const g = checkGate(rulesOnly, t);
  md.push("## 门禁（只靠规则）", "", `阈值状态：${g.approved ? "已批准" : "草案（待产品与法务拍板，只作提示）"}；结论：${g.ok ? "通过" : "未通过"}`, "");
  md.push("| 来源 | 指标 | 结论 | 区间端点 | 阈值 |", "|---|---|---|---|---|");
  for (const f of g.findings) md.push(`| ${f.source} | ${f.metric} | ${f.verdict} | ${f.bound === null ? "—" : f.bound.toFixed(4)} | ${f.threshold} |`);
  gateFailed = g.approved && !g.ok;
}
writeFileSync(`${out}.md`, md.join("\n"));
console.log(`[run-eval] ${docs.length} 份文书 → ${out}.json / ${out}.md${gatePath ? (gateFailed ? "；门禁未通过" : "；门禁见报告") : ""}`);
if (gateFailed) process.exit(1);
