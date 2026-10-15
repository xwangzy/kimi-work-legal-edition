/**
 * 令牌化召回评测命令行（S8）：node packages/tokenizer/eval/run-eval.mjs <gold.jsonl> [--out report] [--full-pseudonym] [--case-numbers]
 * 同时报告“有当事人词典”与“只靠规则”两种情形；输出 report.json / report.md（只含计数与比例）。
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const { MatterTokenizer } = await import("../src/index.ts");
const { aggregateBySource, evaluateDoc, reportMarkdown, validateGold } = await import("./evaluate.ts");

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("用法：node packages/tokenizer/eval/run-eval.mjs <gold.jsonl> [--out report] [--full-pseudonym] [--case-numbers]");
  process.exit(2);
}
const out = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : "report";
const fullPseudonym = argv.includes("--full-pseudonym");
const caseNumbers = argv.includes("--case-numbers");
const docs = readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
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
writeFileSync(`${out}.json`, JSON.stringify({ file: file.split(/[\\/]/).pop(), fullPseudonym, caseNumbers, withDictionary: withDict, rulesOnly }, null, 2));
const md = [];
for (const src of Object.keys(withDict)) {
  md.push(reportMarkdown(`令牌化召回评测 · ${src}（有当事人词典）`, withDict[src]), "", reportMarkdown(`令牌化召回评测 · ${src}（只靠规则）`, rulesOnly[src]), "");
}
writeFileSync(`${out}.md`, md.join("\n"));
console.log(`[run-eval] ${docs.length} 份文书 → ${out}.json / ${out}.md`);
