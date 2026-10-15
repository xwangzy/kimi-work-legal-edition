/**
 * 姓名识别规则改动的前后比对（研发自用；复核 S6A-04 要求证据可复现）：用两份 names.ts（旧版目录、新版目录）对同一批 Markdown 语料
 * 逐段调用 recognizeNames，列出新增与消失的识别结果及次数。语料几乎不含真实人名时只能证明“没有新增误认”，不能证明召回。
 *   node packages/tokenizer/eval/names-diff.mjs <旧版 src 目录> <新版 src 目录> <语料目录…>
 * 旧版目录可用 `git show <提交>:platform/packages/tokenizer/src/<文件>` 导出 names.ts 及其依赖（surnames.ts、variants.ts、patterns.ts、t2s-data.ts）。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const [oldDir, newDir, ...roots] = process.argv.slice(2);
const o = await import(join(oldDir, "names.ts"));
const n = await import(join(newDir, "names.ts"));
const files = [];
const walk = (d) => { for (const x of readdirSync(d)) { const p = join(d, x); if (statSync(p).isDirectory()) { if (!/node_modules|ui-shots|\.git/.test(x)) walk(p); } else if (p.endsWith(".md")) files.push(p); } };
for (const r of roots) walk(r);
const A = new Map(), B = new Map();
for (const f of files) for (const para of readFileSync(f, "utf8").split(/\n+/)) {
  for (const x of o.recognizeNames(para)) A.set(x, (A.get(x) ?? 0) + 1);
  for (const x of n.recognizeNames(para)) B.set(x, (B.get(x) ?? 0) + 1);
}
const added = [...B].filter(([k]) => !A.has(k)), removed = [...A].filter(([k]) => !B.has(k));

process.stdout.write(`文件 ${files.length} 个；旧版识别 ${A.size} 个不同的名字，新版 ${B.size} 个；新增 ${added.length}，消失 ${removed.length}\n`);
process.stdout.write(`新增：${added.map(([k, v]) => `${k}×${v}`).join(" ")}\n`);
process.stdout.write(`消失：${removed.map(([k, v]) => `${k}×${v}`).join(" ")}\n`);
