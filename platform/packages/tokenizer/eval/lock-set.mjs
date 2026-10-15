/**
 * S8 锁定集清单（调研 Y5 §4.4“切分”）：
 *   node packages/tokenizer/eval/lock-set.mjs <locked.jsonl> --version 2026Q4-v1 [--out locked-manifest.json]
 * 清单只含摘要与计数，可以入库；锁定集原文不入库（由评测负责人另行保管，CI 以机密方式取用）。
 */
import { readFileSync, writeFileSync } from "node:fs";

const { lockManifest } = await import("./gate.ts");
const { validateGold } = await import("./evaluate.ts");

const argv = process.argv.slice(2);
const file = argv.find((a, i) => !a.startsWith("--") && !["--version", "--out"].includes(argv[i - 1]));
const version = argv.includes("--version") ? argv[argv.indexOf("--version") + 1] : "";
const out = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : "locked-manifest.json";
if (!file || !version) {
  process.stderr.write("用法：node packages/tokenizer/eval/lock-set.mjs <locked.jsonl> --version <版本> [--out locked-manifest.json]\n");
  process.exit(2);
}
const bytes = readFileSync(file);
const docs = bytes.toString("utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const bad = docs.flatMap((d) => validateGold(d).map((p) => `${d.doc_id}: ${p}`));
if (bad.length) {
  process.stderr.write(`金标准不合格（${bad.length} 处）：\n${bad.slice(0, 20).join("\n")}\n`);
  process.exit(1);
}
const m = lockManifest(bytes, docs, version);
writeFileSync(out, JSON.stringify(m, null, 2) + "\n");
process.stdout.write(`[lock-set] ${m.docs} 份、摘要 ${m.sha256.slice(0, 16)}… → ${out}\n`);
