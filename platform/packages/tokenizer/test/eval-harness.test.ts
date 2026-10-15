/**
 * S8 评测器自检（eval/evaluate.ts）：只验证计量口径（提及召回、人级泄露、误替换、簇自助区间、格式校验），
 * 不评价识别质量——这里的样本是手写的合成样本，结果不得对外引用。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MatterTokenizer, type PartyEntry } from "../src/index.ts";
import { aggregate, evaluateDoc, reportMarkdown, validateGold, type GoldDoc } from "../eval/evaluate.ts";

const span = (text: string, value: string, category: any, person_id?: string, from = 0) => {
  const start = text.indexOf(value, from);
  return { start, end: start + value.length, category, ...(person_id ? { person_id } : {}) };
};

const t1 = "原告：王建国，身份证号 110101199003071234，电话 13900001111。王建国主张借款。证人李某某出庭。";
const t2 = "甲方：赵明，乙方：钱塘江贸易有限公司。赵明与对方约定。";
const DOCS: GoldDoc[] = [
  { doc_id: "d1", source: "synthetic", text: t1, known_parties: [{ name: "王建国", kind: "person" }], spans: [span(t1, "王建国", "person", "P1"), span(t1, "王建国", "person", "P1", 30), span(t1, "110101199003071234", "id_number"), span(t1, "13900001111", "phone")] },
  { doc_id: "d2", source: "synthetic", text: t2, known_parties: [], spans: [span(t2, "赵明", "person", "Q1"), span(t2, "赵明", "person", "Q1", 10), span(t2, "钱塘江贸易有限公司", "org")] },
];
const make = (parties: PartyEntry[]) => new MatterTokenizer({ matterKey: Buffer.alloc(32, 3), parties });

test("S8 评测器：格式校验能发现越界、非法类别与缺 person_id", () => {
  assert.deepEqual(validateGold(DOCS[0]!), []);
  const bad = validateGold({ doc_id: "x", source: "s", text: "短", spans: [{ start: 0, end: 5, category: "person" as any }, { start: 0, end: 1, category: "nope" as any }] });
  assert.ok(bad.some((p) => p.includes("越界")) && bad.some((p) => p.includes("类别不合法")) && bad.some((p) => p.includes("person_id")));
});

test("S8 评测器：提及召回、人级泄露、机构在默认模式下按设计不替换、报告只含计数", () => {
  const o1 = evaluateDoc(DOCS[0]!, make);
  assert.deepEqual(o1.mentions.person, [2, 2], "词典里的姓名两处都替换");
  assert.deepEqual(o1.mentions.id_number, [1, 1]);
  assert.deepEqual(o1.mentions.phone, [1, 1]);
  assert.equal(o1.persons.P1, false);
  const o2 = evaluateDoc(DOCS[1]!, make);
  // 机构名称在默认模式（非全部化名）下保留——按设计计为“未替换”，报告里如实体现
  assert.deepEqual(o2.mentions.org, [1, 0]);
  const r = aggregate([o1, o2]);
  assert.equal(r.docs, 2);
  assert.equal(r.recallByCategory.id_number!.value, 1);
  assert.equal(r.recallByCategory.org!.value, 0);
  assert.ok(r.personLeakRate.denominator === 2);
  const md = reportMarkdown("自检", r);
  for (const s of ["王建国", "赵明", "13900001111", "钱塘江"]) assert.ok(!md.includes(s), "报告不得含原文");
  assert.match(md, /不得对外引用/);
});

test("S8 评测器：簇自助区间可复现、落在 [0,1] 且包含点估计", () => {
  const outcomes = Array.from({ length: 30 }, (_, i) => ({ doc_id: `d${i}`, source: "s", mentions: { person: [4, i % 5 === 0 ? 2 : 4] as [number, number] }, persons: { [`p${i}`]: i % 5 === 0 }, falseReplacements: {}, partial: {}, overReplacements: {} }));
  const a = aggregate(outcomes);
  const b = aggregate(outcomes);
  assert.deepEqual(a.recallByCategory.person!.ci95, b.recallByCategory.person!.ci95, "固定种子可复现");
  const m = a.recallByCategory.person!;
  assert.ok(m.ci95![0] <= m.value! && m.value! <= m.ci95![1] && m.ci95![0] >= 0 && m.ci95![1] <= 1);
  assert.equal(a.personLeakRate.numerator, 6);
});

test("按区间判定（复核 B4-R02）：姓名嵌在未标注的字号里、输出仍留着这个写法——判泄露、不算已替换", async () => {
  const { evaluateDoc } = await import("../eval/evaluate.ts");
  const { MatterTokenizer, deriveOrgAliases } = await import("../src/index.ts");
  const text = "上海李四贸易有限公司与上海李四贸易有限公司的股东李四发生争议。";
  const at = text.lastIndexOf("李四");
  const org = "上海李四贸易有限公司";
  const gold = { doc_id: "r02", source: "probe", text, known_parties: [], spans: [{ start: at, end: at + 2, category: "person" as const, person_id: "P1" }] };
  // 只替换机构全称（全部化名、不派生字号别名）且不认这个人名：两处机构名被换掉，股东“李四”留在输出里——
  // 旧口径按写法计数分摊（输入 3 次、输出 1 次）会把它记成“已替换、未泄露”
  const make = () => new MatterTokenizer({ matterKey: Buffer.alloc(32, 2), parties: [{ name: org, kind: "org", exclude: deriveOrgAliases(org) }], fullPseudonym: true, recognizeNames: false });
  assert.equal(make().tokenize(text).text.split("李四").length - 1, 1, "前提：输出里只剩股东那一处“李四”");
  const o = evaluateDoc(gold, make);
  assert.deepEqual(o.mentions.person, [1, 0], "股东李四没有被替换");
  assert.equal(o.persons.P1, true, "人级泄露");
  // 同名的两个人各自独立判定：一人替换（词典），另一人的写法不同且未替换
  const t2 = "原告张伟与被告张大伟签订协议。";
  const g2 = { doc_id: "r02b", source: "probe", text: t2, spans: [
    { start: t2.indexOf("张伟"), end: t2.indexOf("张伟") + 2, category: "person" as const, person_id: "A" },
    { start: t2.indexOf("张大伟"), end: t2.indexOf("张大伟") + 3, category: "person" as const, person_id: "B" },
  ] };
  const o2 = evaluateDoc(g2, () => new MatterTokenizer({ matterKey: Buffer.alloc(32, 2), parties: [{ name: "张伟", kind: "person" }], recognizeNames: false }));
  assert.equal(o2.persons.A, false);
  assert.equal(o2.persons.B, true);
});

test("部分替换与过度替换（复核 B4-R08）：只替换了一部分计部分替换且泄露；吞掉标注之外的字计过度替换；与标注不相交的计误替换", async () => {
  const { evaluateDoc } = await import("../eval/evaluate.ts");
  const { MatterTokenizer } = await import("../src/index.ts");
  const text = "原告王五于当日到场，证人赵六作证。";
  const g = { doc_id: "r08", source: "probe", text, spans: [
    { start: text.indexOf("王五"), end: text.indexOf("王五") + 2, category: "person" as const, person_id: "W" },
    { start: text.indexOf("赵六"), end: text.indexOf("赵六") + 2, category: "person" as const, person_id: "Z" },
  ] };
  // 词典里登记了“王五于当日”（过度替换）与“赵”（部分替换）以及与标注无关的“到场”（误替换）
  const o = evaluateDoc(g, () => new MatterTokenizer({ matterKey: Buffer.alloc(32, 2), parties: [{ name: "王五于当日", kind: "person" }, { name: "赵六作", kind: "person" }, { name: "证人", kind: "person" }], recognizeNames: false }));
  assert.equal(o.overReplacements.person, 2, "王五于当日、赵六作：覆盖了标注但超出");
  assert.equal(o.falseReplacements.person, 1, "证人：与标注不相交");
  assert.deepEqual(o.mentions.person, [2, 2]);
  const o2 = evaluateDoc(g, () => new MatterTokenizer({ matterKey: Buffer.alloc(32, 2), parties: [{ name: "王五", kind: "person" as const }, { name: "六作", kind: "person" as const }], recognizeNames: false }));
  assert.equal(o2.partial.person, 1, "赵六只被替换了“六”：部分替换");
  assert.equal(o2.persons.Z, true, "部分替换计入泄露");
});

test("区间（复核 B4-R07）：全部替换时泄露区间上界大于 0、不给零宽区间；只有一份文书也不给零宽区间；按来源分节", async () => {
  const { aggregate, aggregateBySource, clopperPearson } = await import("../eval/evaluate.ts");
  const all = Array.from({ length: 20 }, (_, i) => ({ doc_id: `d${i}`, source: i < 10 ? "public_judgment" : "synthetic", mentions: { person: [5, 5] as [number, number] }, partial: {}, persons: { [`p${i}`]: false }, falseReplacements: {}, overReplacements: {} }));
  const r = aggregate(all);
  assert.equal(r.recallByCategory.person!.method, "clopper_pearson");
  assert.ok(r.recallByCategory.person!.ci95![0] < 1, "召回 100% 时区间下界小于 1");
  assert.ok(r.personLeakRate.ci95![1] > 0, "零泄露时上界大于 0");
  const one = aggregate(all.slice(0, 1));
  assert.ok(one.recallByCategory.person!.ci95![0] < one.recallByCategory.person!.ci95![1]);
  const by = aggregateBySource(all);
  assert.deepEqual(Object.keys(by), ["public_judgment", "synthetic"]);
  assert.equal(by.public_judgment!.docs, 10);
  // 精确区间的已知值：0/20 → [0, 0.1684]；10/20 → [0.272, 0.728]
  const [lo0, hi0] = clopperPearson(0, 20);
  assert.equal(lo0, 0);
  assert.ok(Math.abs(hi0 - 0.1684) < 0.001, String(hi0));
  const [lo, hi] = clopperPearson(10, 20);
  assert.ok(Math.abs(lo - 0.272) < 0.002 && Math.abs(hi - 0.728) < 0.002, `${lo} ${hi}`);
});
