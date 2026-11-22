// 离线回放金额勾稽检查（第 57 批，amount-check.ts）：对一批已取回的成果（每个标签一个子目录，文件名 v<版本>-<文件名>），
// 用产品当前的代码做算式复核与跨成果金额对账，逐条列出报了什么，供人工判定真假阳性。
// 材料原文按题库（eval/cards/cards16.json）该标签的 files 从 eval/materials 读（docx / xlsx / txt；其它类型跳过并注明），
// 委托文字取该卡的 extra、fields、answers。
// 用法：node eval/replay-amount-check.mjs <成果目录> [--all-versions] [--tag <标签>] [--cards <题库>]
//   缺省只看每个文件名的最高版本（最终交付）；--all-versions 把每个版本当作“当时的最新版”各回放一次
//   （该版本之前或同时生成的其它文件取当时的最高版本）。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PLATFORM } from "./lib.mjs";

const { checkAmounts, blocksOfSections, blocksOfSheets } = await import(join(PLATFORM, "packages/kernel/src/services/amount-check.ts"));
const { sectionsOfDocx } = await import(join(PLATFORM, "packages/kernel/src/tools/tools/edit-draft.ts"));
const { readCreatedXlsx, xlsxToText, extractParagraphs } = await import(join(PLATFORM, "packages/docx-engine/src/index.ts"));

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const R = args.find((a, i) => !a.startsWith("--") && !["--tag", "--cards"].includes(args[i - 1]));
if (!R) throw new Error("用法：node eval/replay-amount-check.mjs <成果目录> [--all-versions] [--tag <标签>] [--cards <题库>]");
const allVersions = args.includes("--all-versions");
const onlyTag = opt("--tag");
const cards = JSON.parse(readFileSync(opt("--cards") ?? join(PLATFORM, "eval/cards/cards16.json"), "utf8"));
const cardOf = new Map((Array.isArray(cards) ? cards : cards.cards ?? []).map((c) => [c.tag, c]));

function materialText(rel) {
  const f = join(PLATFORM, "eval/materials", rel);
  if (!existsSync(f)) return { text: "", note: `缺文件 ${rel}` };
  const buf = readFileSync(f);
  try {
    if (rel.endsWith(".docx")) return { text: extractParagraphs(buf).map((p) => p.text).join("\n") };
    if (rel.endsWith(".xlsx")) return { text: xlsxToText(buf).text };
    if (/\.(txt|md|csv)$/.test(rel)) return { text: buf.toString("utf8") };
  } catch (e) {
    return { text: "", note: `读不出 ${rel}：${e.message}` };
  }
  return { text: "", note: `跳过 ${rel}（类型不抽文字）` };
}

function sourcesOf(tag) {
  const card = cardOf.get(tag) ?? cardOf.get(tag.replace(/-review-apply$/, "-compliance-qa"));
  if (!card) return { sources: [], notes: ["题库里没有这张卡"] };
  const notes = [];
  const sources = [];
  for (const rel of card.files ?? []) {
    const m = materialText(rel);
    if (m.note) notes.push(m.note);
    if (m.text) sources.push(m.text);
  }
  sources.push(card.extra ?? "", JSON.stringify(card.fields ?? {}), ...(card.answers ?? []), JSON.stringify(card.matter ?? {}));
  return { sources, notes };
}

function docOf(name, buf) {
  if (name.endsWith(".docx")) return { filename: name, kind: "docx", ...blocksOfSections(sectionsOfDocx(buf).sections) };
  const specs = readCreatedXlsx(buf);
  if (specs) return { filename: name, kind: "xlsx", ...blocksOfSheets(specs) };
  return { filename: name, kind: "xlsx", paragraphs: [{ where: "全表", text: xlsxToText(buf).text }] };
}

const total = { cards: 0, runs: 0, eq: 0, eqFail: 0, amounts: 0, orphans: 0 };
for (const tag of readdirSync(R).sort()) {
  if (onlyTag && tag !== onlyTag) continue;
  const d = join(R, tag);
  if (!statSync(d).isDirectory()) continue;
  const files = readdirSync(d).map((f) => /^v(\d+)-(.+\.(docx|xlsx))$/.exec(f)).filter(Boolean).map((m) => ({ v: +m[1], name: m[2], f: m[0] }));
  if (files.length === 0) continue;
  total.cards++;
  const { sources, notes } = sourcesOf(tag);
  // 回放点：缺省只有“全部最高版本”；--all-versions 时每出现一个文书版本回放一次
  const points = allVersions ? [...new Set(files.filter((x) => x.name.endsWith(".docx")).map((x) => x.v))].sort((a, b) => a - b) : [Infinity];
  for (const upto of points) {
    const latest = new Map();
    for (const x of files) if (x.v <= upto && (!latest.has(x.name) || latest.get(x.name).v < x.v)) latest.set(x.name, x);
    if (allVersions && ![...latest.values()].some((x) => x.v === upto && x.name.endsWith(".docx"))) continue;
    const docs = [];
    for (const x of latest.values()) {
      try { docs.push({ ...docOf(x.name, readFileSync(join(d, x.f))), filename: x.f }); } catch (e) { notes.push(`读不出 ${x.f}：${e.message}`); }
    }
    const r = checkAmounts({ docs, sources });
    total.runs++;
    total.eq += r.stats.equations_checked; total.eqFail += r.stats.equations_failed; total.amounts += r.stats.amounts_checked; total.orphans += r.stats.orphans;
    console.log(`\n=== ${tag}${allVersions ? ` · 截至 v${upto}` : ""}：${docs.map((x) => x.filename).join("、")}`);
    console.log(`    算式 ${r.stats.equations_checked} 道（不成立 ${r.stats.equations_failed}）；金额 ${r.stats.amounts_checked} 处（无出处 ${r.stats.orphans}）${notes.length ? `；注：${[...new Set(notes)].join("；")}` : ""}`);
    for (const i of r.issues) {
      if (i.kind === "equation") console.log(`  [算式] ${i.filename} · ${i.where} · ${i.text} · 复算 ${i.expected} 写 ${i.actual}`);
      else console.log(`  [无出处] ${i.filename} · ${i.where} · ${i.amount} · ${i.text}`);
    }
  }
}
console.log(`\n合计：${total.cards} 张卡、${total.runs} 次回放；算式 ${total.eq} 道不成立 ${total.eqFail}；金额 ${total.amounts} 处无出处 ${total.orphans}`);
