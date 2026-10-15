/**
 * S8 双人标注一致性（标注规范 v1 §5）：
 *   node packages/tokenizer/eval/agreement.mjs <甲.jsonl> <乙.jsonl> [--out agreement]
 * 输出 <out>.json / <out>.md（只含计数与比例，文书以序号表示）与 <out>-groups.local.json（分歧组：文书编号与区间位置，不含原文；文书编号可能是文件名，只供本机裁决）。
 */
import { readFileSync, writeFileSync } from "node:fs";

const { compareAnnotations, agreementMarkdown } = await import("./agreement.ts");
const { validateGold } = await import("./evaluate.ts");

const argv = process.argv.slice(2);
const files = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--out");
const out = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : "agreement";
if (files.length !== 2) {
  process.stderr.write("用法：node packages/tokenizer/eval/agreement.mjs <甲.jsonl> <乙.jsonl> [--out agreement]\n");
  process.exit(2);
}
const load = (f) => readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const [a, b] = files.map(load);
const bad = [...a, ...b].flatMap((d) => validateGold(d).map((p) => `${d.doc_id}: ${p}`));
if (bad.length) {
  process.stderr.write(`标注不合格（${bad.length} 处）：\n${bad.slice(0, 20).join("\n")}\n`);
  process.exit(1);
}
const { report, groups } = compareAnnotations(a, b);
// 一致性报告只含计数（复核 S6A-15）：文书编号可能就是文书文件名，报告里改为序号；带编号的分歧组单独成文件、只供本机裁决
writeFileSync(`${out}.json`, JSON.stringify({ ...report, per_doc: report.per_doc.map(({ doc_id: _d, ...r }, i) => ({ doc: i + 1, ...r })) }, null, 2));
writeFileSync(`${out}.md`, agreementMarkdown(report));
writeFileSync(`${out}-groups.local.json`, JSON.stringify(groups.map((g) => ({ doc_id: g.doc_id, group: g.group, start: g.start, end: g.end, a: g.a.map((s) => s.category), b: g.b.map((s) => s.category) })), null, 2));
process.stdout.write(`[agreement] 成对 ${report.paired} 份；κ ${report.pooled_kappa?.toFixed(3) ?? "—"}；F1 ${report.pooled_f1?.toFixed(3) ?? "—"}；分歧组 ${groups.length} → ${out}.json / ${out}.md；${out}-groups.local.json 含文书编号，只供本机裁决、不要外传\n`);
