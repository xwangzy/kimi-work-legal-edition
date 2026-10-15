/**
 * S8 第二部分自检：困难负例与隐名写法、精确率与每千字误替换、双人一致性（κ、F1、分歧组、裁决合成）、锁定清单与门禁。
 * 只验证计量口径；样本为手写合成样本，结果不得对外引用。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MatterTokenizer, type PartyEntry } from "../src/index.ts";
import { aggregate, aggregateBySource, evaluateDoc, reportMarkdown, validateGold, type GoldDoc, type GoldSpan } from "../eval/evaluate.ts";
import { adjudicate, cohenKappa, compareAnnotations, compareDoc, agreementMarkdown } from "../eval/agreement.ts";
import { checkGate, lockManifest, verifyLocked } from "../eval/gate.ts";

const at = (text: string, value: string, category: GoldSpan["category"], person_id?: string, from = 0): GoldSpan => {
  const start = text.indexOf(value, from);
  assert.ok(start >= 0, value);
  return { start, end: start + value.length, category, ...(person_id ? { person_id } : {}) };
};
const make = (parties: PartyEntry[]) => new MatterTokenizer({ matterKey: Buffer.alloc(32, 5), parties, recognizeNames: false });

test("金标准：person_partial 与 negative 合法；区间重叠被拒", () => {
  const t = "被告张某某到王府井。";
  assert.deepEqual(validateGold({ doc_id: "x", source: "s", text: t, spans: [at(t, "张某某", "person_partial"), at(t, "王府井", "negative")] }), []);
  const bad = validateGold({ doc_id: "y", source: "s", text: t, spans: [{ start: 2, end: 5, category: "person_partial" }, { start: 4, end: 6, category: "negative" }] });
  assert.ok(bad.some((p) => p.includes("区间重叠")));
});

test("困难负例被替换计“负例误替换”且计入误替换；精确率与每千字误替换", () => {
  const t = "原告王平在王府井工作。王平主张权利。";
  const gold: GoldDoc = { doc_id: "n1", source: "public_judgment", text: t, spans: [at(t, "王平", "person", "P1"), at(t, "王平", "person", "P1", 8), at(t, "王府井", "negative")] };
  // 词典把“王府井”也当成人名（模拟误判），“王平”正确
  const o = evaluateDoc(gold, () => make([{ name: "王平", kind: "person" }, { name: "王府井", kind: "person" }]));
  assert.deepEqual(o.negatives, [1, 1]);
  assert.equal(o.falseReplacements.person, 1);
  assert.deepEqual(o.precision, [2, 3]);
  assert.equal(o.chars, t.length);
  const r = aggregate([o]);
  assert.equal(r.negativeHitRate.numerator, 1);
  assert.equal(r.precision.denominator, 3);
  assert.ok(r.falsePerKChars !== null && Math.abs(r.falsePerKChars - 1000 / t.length) < 1e-9);
  const md = reportMarkdown("负例", r);
  assert.match(md, /困难负例被替换/);
  assert.match(md, /每千字/);
  assert.ok(!md.includes("王平") && !md.includes("王府井"));
});

test("隐名写法单独报告召回、不计入人级泄露", () => {
  const t = "证人李某某出庭，原告赵敏到庭。";
  const gold: GoldDoc = { doc_id: "p1", source: "public_judgment", text: t, spans: [at(t, "李某某", "person_partial"), at(t, "赵敏", "person", "Z")] };
  const o = evaluateDoc(gold, () => make([{ name: "赵敏", kind: "person" }]));
  assert.deepEqual(o.mentions.person_partial, [1, 0]);
  assert.deepEqual(Object.keys(o.persons), ["Z"]);
  assert.equal(o.persons.Z, false);
});

test("Cohen κ：完全一致为 1；已知值；只有一种标签且一致为 1", () => {
  assert.equal(cohenKappa(["a", "b", "O"], ["a", "b", "O"]), 1);
  assert.equal(cohenKappa(["O", "O"], ["O", "O"]), 1);
  // 经典例：po = 0.7，pe = 0.5 → κ = 0.4
  const a = [..."YYYYYNNNNN"];
  const b = [..."YYYNNNNNYY"];
  assert.ok(Math.abs(cohenKappa(a, b) - (0.6 - 0.5) / 0.5) < 1e-12);
});

test("一致性：F1 与 κ、分歧组按重叠聚类、正文不同判不合格；报告不含原文", () => {
  const t = "甲方张三，住北京市海淀区中关村大街1号，电话13800001111。";
  const A: GoldDoc = { doc_id: "d", source: "s", text: t, spans: [at(t, "张三", "person", "P1"), at(t, "北京市海淀区中关村大街1号", "address"), at(t, "13800001111", "phone")] };
  const B: GoldDoc = { doc_id: "d", source: "s", text: t, spans: [at(t, "张三", "person", "X"), at(t, "海淀区中关村大街1号", "address"), at(t, "13800001111", "phone")] };
  const { agreement, groups } = compareDoc(A, B);
  assert.equal(agreement.agreed, 2, "人名（编号不参与比较）与电话一致");
  assert.ok(Math.abs(agreement.f1! - 4 / 6) < 1e-12);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.a.length, 1);
  assert.equal(groups[0]!.b.length, 1);
  assert.equal(agreement.passes, false, "F1 < 0.90");
  const C: GoldDoc = { ...B, text: t + "x" };
  assert.equal(compareDoc(A, C).agreement.text_mismatch, true);
  const { report } = compareAnnotations([A, { ...A, doc_id: "only-a" }], [B]);
  assert.equal(report.paired, 1);
  assert.equal(report.missing_in_b, 1);
  const md = agreementMarkdown(report);
  assert.ok(!md.includes("张三") && !md.includes("海淀"));
});

test("裁决：一致的直接采用、分歧按决定取用；乙的编号经一致标注映射到甲；未裁决的列出", () => {
  const t = "原告张三与被告李四，张三住上海市徐汇区漕溪北路2号。";
  const A: GoldDoc = { doc_id: "d", source: "s", text: t, spans: [at(t, "张三", "person", "A1"), at(t, "李四", "person", "A2"), at(t, "上海市徐汇区漕溪北路2号", "address")] };
  const B: GoldDoc = { doc_id: "d", source: "s", text: t, spans: [at(t, "张三", "person", "B1"), at(t, "李四", "person", "B2"), at(t, "张三", "person", "B1", 8), at(t, "徐汇区漕溪北路2号", "address")] };
  const { groups } = compareDoc(A, B);
  assert.equal(groups.length, 2, "第二个“张三”只在乙；地址边界不同");
  const pending = adjudicate(A, B, new Map());
  assert.deepEqual(pending.undecided, [0, 1]);
  const done = adjudicate(A, B, new Map([[0, "b" as const], [1, "a" as const]]));
  assert.deepEqual(done.undecided, []);
  const zs = done.doc.spans.filter((s) => t.slice(s.start, s.end) === "张三");
  assert.equal(zs.length, 2);
  assert.deepEqual(zs.map((s) => s.person_id), ["A1", "A1"], "乙的 B1 映射为甲的 A1");
  assert.ok(done.doc.spans.some((s) => s.category === "address" && t.slice(s.start, s.end) === "上海市徐汇区漕溪北路2号"));
  assert.deepEqual(validateGold(done.doc), []);
});

test("锁定清单：摘要与文书数一致才通过；门禁按区间端点、样本不足判 insufficient、草案阈值不阻断", () => {
  const docs: GoldDoc[] = [{ doc_id: "a", source: "public_judgment", text: "王五", spans: [{ start: 0, end: 2, category: "person", person_id: "W" }] }];
  const bytes = Buffer.from(docs.map((d) => JSON.stringify(d)).join("\n"));
  const m = lockManifest(bytes, docs, "test-v1", new Date(0));
  assert.deepEqual(verifyLocked(bytes, docs, m), []);
  assert.ok(verifyLocked(Buffer.concat([bytes, Buffer.from(" ")]), docs, m).some((p) => p.includes("摘要")));
  const many: GoldDoc[] = Array.from({ length: 40 }, (_, i) => {
    const t = `原告王${"甲乙丙丁戊己庚辛壬癸"[i % 10]}到庭。`;
    return { doc_id: `g${i}`, source: "public_judgment", text: t, known_parties: [], spans: [{ start: 2, end: 4, category: "person", person_id: `P${i}` }] };
  });
  const by = aggregateBySource(many.map((d) => evaluateDoc(d, () => make([{ name: d.text.slice(2, 4), kind: "person" }]))));
  const draft = checkGate(by, { status: "draft", recall_lower_bound: { person: 0.9, id_number: 0.99 }, person_leak_upper_bound: 0.2 });
  assert.equal(draft.approved, false);
  const person = draft.findings.find((f) => f.metric === "recall.person")!;
  assert.equal(person.verdict, "pass", `下界 ${person.bound}`);
  assert.equal(draft.findings.find((f) => f.metric === "recall.id_number")!.verdict, "insufficient");
  assert.equal(draft.ok, false, "有样本不足的项即不算通过");
  const strict = checkGate(by, { status: "approved", recall_lower_bound: { person: 0.99 } });
  assert.equal(strict.findings[0]!.verdict, "fail", "40 份全对的 Clopper–Pearson 下界约 0.91，低于 0.99");
});

test("命令行：lock-set → run-eval --locked --gate（草案不阻断、改动锁定集即退出 1）；agreement 输出不含原文", () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-s8-"));
  const evalDir = fileURLToPath(new URL("../eval/", import.meta.url));
  const t = "原告王建国，电话13900001111。";
  const docs: GoldDoc[] = [{ doc_id: "c1", source: "public_judgment", text: t, known_parties: [{ name: "王建国", kind: "person" }], spans: [at(t, "王建国", "person", "P1"), at(t, "13900001111", "phone")] }];
  const gold = join(dir, "locked.jsonl");
  writeFileSync(gold, docs.map((d) => JSON.stringify(d)).join("\n") + "\n");
  execFileSync(process.execPath, [join(evalDir, "lock-set.mjs"), gold, "--version", "t1", "--out", join(dir, "m.json")], { stdio: "pipe" });
  writeFileSync(join(dir, "th.json"), JSON.stringify({ status: "draft", recall_lower_bound: { person: 0.95 } }));
  execFileSync(process.execPath, [join(evalDir, "run-eval.mjs"), gold, "--out", join(dir, "r"), "--locked", join(dir, "m.json"), "--gate", join(dir, "th.json")], { stdio: "pipe" });
  const md = readFileSync(join(dir, "r.md"), "utf8");
  assert.match(md, /门禁（只靠规则）/);
  assert.ok(!md.includes("王建国") && !md.includes("13900001111"));
  writeFileSync(join(dir, "th2.json"), JSON.stringify({ status: "approved", recall_lower_bound: { person: 0.95 } }));
  assert.throws(() => execFileSync(process.execPath, [join(evalDir, "run-eval.mjs"), gold, "--out", join(dir, "r2"), "--locked", join(dir, "m.json"), "--gate", join(dir, "th2.json")], { stdio: "pipe" }), "已批准阈值未过（样本不足）即退出 1");
  assert.throws(() => execFileSync(process.execPath, [join(evalDir, "run-eval.mjs"), gold, "--out", join(dir, "r2b"), "--gate", join(dir, "th.json")], { stdio: "pipe" }), "--gate 不带 --locked 即拒绝");
  writeFileSync(join(dir, "th3.json"), JSON.stringify({ status: "aproved", recall_lower_bound: { persn: 0.95 } }));
  assert.throws(() => execFileSync(process.execPath, [join(evalDir, "run-eval.mjs"), gold, "--out", join(dir, "r2c"), "--locked", join(dir, "m.json"), "--gate", join(dir, "th3.json")], { stdio: "pipe" }), "status 拼错、类别名写错即拒绝（不静默当作草案）");
  writeFileSync(gold, readFileSync(gold, "utf8") + "\n");
  assert.throws(() => execFileSync(process.execPath, [join(evalDir, "run-eval.mjs"), gold, "--out", join(dir, "r3"), "--locked", join(dir, "m.json")], { stdio: "pipe" }), "锁定集改动即退出 1");
  const b = join(dir, "b.jsonl");
  writeFileSync(b, JSON.stringify({ ...docs[0], spans: [at(t, "王建国", "person", "X")] }) + "\n");
  execFileSync(process.execPath, [join(evalDir, "agreement.mjs"), gold, b, "--out", join(dir, "ag")], { stdio: "pipe" });
  assert.ok(!readFileSync(join(dir, "ag.json"), "utf8").includes("c1"), "一致性报告不含文书编号");
  for (const f of ["ag.json", "ag.md", "ag-groups.local.json"]) {
    const s = readFileSync(join(dir, f), "utf8");
    assert.ok(!s.includes("王建国") && !s.includes("13900001111"), f);
  }
});

test("裁决的边界（复核 S6A-05）：正文不同拒绝合成；编号冲突两个方向都报；手工标注不合格列入 problems", () => {
  const t = "原告张三与张三丰到庭。";
  const A: GoldDoc = { doc_id: "d", source: "s", text: t, spans: [at(t, "张三", "person", "A1"), at(t, "张三丰", "person", "A2")] };
  const B: GoldDoc = { doc_id: "d", source: "s", text: t, spans: [at(t, "张三", "person", "B1"), at(t, "张三丰", "person", "B1")] };
  assert.throws(() => adjudicate(A, { ...B, text: t + "。" }, new Map()), /正文不一致/);
  const r = adjudicate(A, B, new Map());
  assert.deepEqual(r.person_id_conflicts, ["乙:B1"], "乙的一个编号对应甲的两个");
  const r2 = adjudicate(B, A, new Map());
  assert.deepEqual(r2.person_id_conflicts, ["甲:B1"], "反过来：甲的一个编号对应乙的两个");
  const t3 = "被告李四到庭。";
  const A3: GoldDoc = { doc_id: "e", source: "s", text: t3, spans: [] };
  const B3: GoldDoc = { doc_id: "e", source: "s", text: t3, spans: [at(t3, "李四", "person", "X")] };
  const bad = adjudicate(A3, B3, new Map([[0, { spans: [{ start: 2, end: 4, category: "person" as const }, { start: 3, end: 6, category: "org" as const }] }]]));
  assert.ok(bad.problems.some((p) => p.includes("person_id")) && bad.problems.some((p) => p.includes("区间重叠")), JSON.stringify(bad.problems));
});
