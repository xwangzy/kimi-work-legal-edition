// 离线回放（第 61 批）：对一批已取回的成果，用当前代码按“该卡当时的材料”重做案号溯源、法院名下引文与“原文摘录”列核对，
// 量化新规则在真实成果上会报什么（误报靠人工逐条看）。用法：node eval/replay-provenance.mjs <成果目录> [--list]
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PLATFORM } from "./lib.mjs";

const { checkDeliverable } = await import(join(PLATFORM, "packages/kernel/src/services/deliverable-check.ts"));
const { buildCaseIndex } = await import(join(PLATFORM, "packages/kernel/src/services/case-provenance.ts"));
const { sectionsOfDocx } = await import(join(PLATFORM, "packages/kernel/src/tools/tools/edit-draft.ts"));
const { readCreatedXlsx } = await import(join(PLATFORM, "packages/docx-engine/src/xlsx.ts"));
const { extractParagraphs } = await import(join(PLATFORM, "packages/docx-engine/src/compare.ts"));
const { xlsxToText } = await import(join(PLATFORM, "packages/docx-engine/src/render-html.ts"));

const R = process.argv[2];
const list = process.argv.includes("--list");
const cards = ["cards16.json", "cards-v35.json"].flatMap((f) => JSON.parse(readFileSync(join(PLATFORM, "eval/cards", f), "utf8")));
const MAT = join(PLATFORM, "eval/materials");
const textOf = (f) => {
  const b = readFileSync(f);
  if (/\.docx$/i.test(f)) return extractParagraphs(b).map((p) => p.text).join("\n");
  if (/\.xlsx$/i.test(f)) return xlsxToText(b).text;
  return b.toString("utf8");
};
const kinds = {};
let files = 0;
for (const tag of readdirSync(R).sort()) {
  const d = join(R, tag);
  if (!statSync(d).isDirectory()) continue;
  const card = cards.find((c) => c.tag === tag || tag.startsWith(c.tag));
  const mats = (card?.files ?? []).map((f) => join(MAT, f)).filter((f) => existsSync(f)).map((f) => ({ filename: f.split("/").pop(), text: textOf(f) }));
  const index = buildCaseIndex(mats, [card?.extra ?? "", JSON.stringify(card?.fields ?? {})]);
  const latest = new Map();
  for (const f of readdirSync(d)) {
    const m = /^v(\d+)-(.+\.(docx|xlsx))$/.exec(f);
    if (m && (!latest.has(m[2]) || latest.get(m[2]).v < +m[1])) latest.set(m[2], { v: +m[1], f });
  }
  for (const [name, { f }] of latest) {
    const buf = readFileSync(join(d, f));
    let title, sections, table = false;
    try {
      if (f.endsWith(".docx")) ({ title, sections } = sectionsOfDocx(buf));
      else { table = true; title = name.replace(/\.xlsx$/, ""); sections = readCreatedXlsx(buf).map((s) => ({ heading: s.name, paragraphs: [], table: { columns: s.rows[0] ?? [], rows: s.rows.slice(1) } })); }
    } catch { continue; }
    files += 1;
    const r = checkDeliverable(title || name, sections, { table, caseIndex: index });
    for (const i of r.issues.filter((x) => /案号|原文摘录|法院、仲裁庭|占位/.test(x.fix))) {
      const k = /原文摘录/.test(i.fix) ? "quote_column" : /法院、仲裁庭/.test(i.fix) ? "court_quote" : /占位/.test(i.fix) ? "placeholder" : /判决名下/.test(i.fix) ? "case_quote" : "case_no";
      kinds[k] = (kinds[k] ?? 0) + 1;
      if (list) console.log(`${k} | ${tag} | ${name} | ${i.where} | ${i.text}`);
    }
  }
}
console.log(`成果 ${files} 份；新规则报出：${JSON.stringify(kinds)}`);
