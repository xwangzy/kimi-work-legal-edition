// 离线回放：对一批已取回的成果（grab.mjs 的输出目录，每个标签一个子目录），用产品当前的代码重做两件事——
//   1. 质量说明清理（scrubQualityLine）：会删掉哪些文字、涉及几份文件几张卡；逐条列出被删的原文，供人工核对有没有误删；
//   2. 交付前检查（checkDeliverable）：清理之后还会报哪些问题（各类几处）。
// 改检查规则前后各跑一遍，就知道新规则在真实成果上会多拦什么、会不会误拦，不必等下一轮真实回归。
// 只看每个文件名的最高版本（最终交付）。用法：node eval/replay-deliverable-check.mjs <成果目录> [--list]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PLATFORM } from "./lib.mjs";

const { checkDeliverable, scrubQualitySections, scrubQualityRows } = await import(join(PLATFORM, "packages/kernel/src/services/deliverable-check.ts"));
const { sectionsOfDocx } = await import(join(PLATFORM, "packages/kernel/src/tools/tools/edit-draft.ts"));
const { readCreatedXlsx } = await import(join(PLATFORM, "packages/docx-engine/src/xlsx.ts"));

const args = process.argv.slice(2);
const R = args.find((a) => !a.startsWith("--"));
if (!R) throw new Error("用法：node eval/replay-deliverable-check.mjs <成果目录> [--list]");
const list = args.includes("--list");

/** 清理前后各段、各格的文字，用来列出“删了什么”。 */
const flat = (sections) => sections.flatMap((s) => [s.heading ?? "", ...(s.paragraphs ?? []), ...(s.table?.columns ?? []).map(String), ...(s.table?.rows ?? []).flatMap((r) => r.map((c) => String(c ?? "")))]);

let files = 0, unread = 0;
const scrub = { files: 0, tags: new Set(), places: 0, removed: {} };
const residual = { files: 0, tags: new Set(), kinds: {}, texts: {} };
for (const tag of readdirSync(R).sort()) {
  const d = join(R, tag);
  if (!statSync(d).isDirectory()) continue;
  const latest = new Map();
  for (const f of readdirSync(d)) {
    const m = /^v(\d+)-(.+\.(docx|xlsx))$/.exec(f);
    if (m && (!latest.has(m[2]) || latest.get(m[2]).v < +m[1])) latest.set(m[2], { v: +m[1], f });
  }
  for (const [name, { f }] of latest) {
    files++;
    let sections, table = false;
    try {
      const buf = readFileSync(join(d, f));
      if (name.endsWith(".docx")) sections = sectionsOfDocx(buf).sections;
      else {
        const specs = readCreatedXlsx(buf);
        if (!specs) { unread++; continue; }
        table = true;
        sections = specs.map((s) => ({ heading: s.name, paragraphs: [], table: { columns: s.rows[0] ?? [], rows: s.rows.slice(1) } }));
      }
    } catch { unread++; continue; }
    // 与产品同一条路：文书走 scrubQualitySections；表格的表头只清格、数据行可删行
    const before = flat(sections);
    const cleaned = table
      ? (() => { let n = 0; const out = sections.map((s) => { const h = scrubQualityRows([s.table.columns], true); const b = scrubQualityRows(s.table.rows); n += h.removed + b.removed; return { ...s, table: { columns: h.rows[0], rows: b.rows } }; }); return { sections: out, removed: n }; })()
      : scrubQualitySections(sections);
    if (cleaned.removed > 0) {
      scrub.files++; scrub.tags.add(tag); scrub.places += cleaned.removed;
      const after = new Map();
      for (const t of flat(cleaned.sections)) after.set(t, (after.get(t) ?? 0) + 1);
      for (const t of before) {
        if (after.get(t) > 0) { after.set(t, after.get(t) - 1); continue; }
        if (t.trim()) scrub.removed[t.slice(0, 120)] = (scrub.removed[t.slice(0, 120)] ?? 0) + 1;
      }
    }
    const chk = checkDeliverable(name.replace(/\.(docx|xlsx)$/, ""), cleaned.sections, table ? { table: true } : {});
    if (!chk.ok) { residual.files++; residual.tags.add(tag); }
    for (const i of chk.issues) {
      residual.kinds[i.kind] = (residual.kinds[i.kind] ?? 0) + 1;
      const k = `${i.kind} | ${i.text.replace(/\s+/g, " ").slice(0, 50)}`;
      residual.texts[k] = (residual.texts[k] ?? 0) + 1;
    }
  }
}
console.log(`最终成果 ${files} 份（读不出 ${unread} 份）`);
console.log(`质量说明清理：会改 ${scrub.files} 份文件、${scrub.tags.size} 张卡、${scrub.places} 处`);
console.log("被改动的段落或单元格原文（清理前；逐条核对有没有误删）：");
for (const [t, n] of Object.entries(scrub.removed).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${t}`);
console.log(`\n清理之后交付前检查仍报问题的：${residual.files} 份文件、${residual.tags.size} 张卡；各类 ${JSON.stringify(residual.kinds)}`);
if (list) for (const [t, n] of Object.entries(residual.texts).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${t}`);
