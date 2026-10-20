// v9.3 第 15 批 B-7（评审 Z1 P1-6：引用提取覆盖款、编、无书名号、司法解释全称；验收线“引用提取语料召回 ≥ 95%”）。
// 语料是律师文书里常见的写法；每句给出应提取的（法名、条、款、项）。另有不应提取的句子（合同条款号、合同标题、“公司法务部”）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openLawdb } from "@zr-legal/lawdb";
import { CitationState } from "@zr-legal/domain";
import { articleStructure, citationsVerify, extractCitations } from "../src/tools/tools/citations.ts";
import { lawNameCandidates } from "../src/tools/tools/law-names.ts";

type Want = [law: string, article: number, paragraph?: number, item?: number];
const CORPUS: [string, Want[]][] = [
  ["依据《民法典》第五百零九条的规定", [["民法典", 509]]],
  ["《中华人民共和国民法典》第585条第2款规定了违约金调整", [["中华人民共和国民法典", 585, 2]]],
  ["符合《民法典》第五百六十三条第一款第（四）项规定的情形", [["民法典", 563, 1, 4]]],
  ["《民法典》合同编第五百七十七条", [["民法典", 577]]],
  ["《民法典》第三编第一分编第四百六十四条", [["民法典", 464]]],
  ["按照民法典第585条，违约金可以调整", [["民法典", 585]]],
  ["依照公司法第二十条的规定，股东不得滥用权利", [["公司法", 20]]],
  ["根据《中华人民共和国公司法》第二十条、第二十一条", [["中华人民共和国公司法", 20], ["中华人民共和国公司法", 21]]],
  ["《民法典》第五百七十七条至第五百八十四条规定了违约责任", [["民法典", 577], ["民法典", 584]]],
  ["《最高人民法院关于适用〈中华人民共和国民法典〉合同编通则若干问题的解释》第十条", [["最高人民法院关于适用〈中华人民共和国民法典〉合同编通则若干问题的解释", 10]]],
  ["《最高人民法院关于适用《中华人民共和国民事诉讼法》的解释》第九十条", [["最高人民法院关于适用〈中华人民共和国民事诉讼法〉的解释", 90]]],
  ["《民诉法解释》第一百零八条规定的高度可能性标准", [["民诉法解释", 108]]],
  ["参照《九民纪要》第三十条的精神", [["九民纪要", 30]]],
  ["构成《刑法》第一百二十条之一规定的犯罪", [["刑法", 120]]],
  ["《劳动合同法》第四十七条第三款所称月工资", [["劳动合同法", 47, 3]]],
  ["劳动合同法第四十七条规定的经济补偿", [["劳动合同法", 47]]],
  ["《民法典》第５８５条", [["民法典", 585]]],
  ["《民法典》第五百零九条和第五百八十五条", [["民法典", 509], ["民法典", 585]]],
  ["《民法典》第五百八十五条规定了违约金，同法第五百八十七条规定了定金", [["民法典", 585], ["民法典", 587]]],
  ["《最高人民法院关于审理民间借贷案件适用法律若干问题的规定》第二十五条", [["最高人民法院关于审理民间借贷案件适用法律若干问题的规定", 25]]],
  ["《公司法解释（三）》第十三条", [["公司法解释（三）", 13]]],
  ["《民事诉讼法》第一百二十二条规定的起诉条件", [["民事诉讼法", 122]]],
  ["违反中华人民共和国合同法第一百零七条", [["合同法", 107]]],
  ["《民法典》第一千一百六十五条第一款", [["民法典", 1165, 1]]],
  ["《担保制度解释》第十七条第一款第（一）项", [["担保制度解释", 17, 1, 1]]],
  ["依据《律师法》第三十八条，律师应当保密", [["律师法", 38]]],
  ["《民法典》第五百条、第五百零一条及第五百零二条", [["民法典", 500], ["民法典", 501], ["民法典", 502]]],
  ["《民法典》 第五百零九条", [["民法典", 509]]],
  ["《中华人民共和国劳动争议调解仲裁法》第二十七条第一款", [["中华人民共和国劳动争议调解仲裁法", 27, 1]]],
  ["《民法典》物权编第二百零九条", [["民法典", 209]]],
  ["《民法典》第四百九十六条第二款、第四百九十七条", [["民法典", 496, 2], ["民法典", 497]]],
  ["其行为违反了刑法第二百六十四条", [["刑法", 264]]],
  ["《行政诉讼法》第四十六条第一款", [["行政诉讼法", 46, 1]]],
  ["《最高人民法院关于审理买卖合同纠纷案件适用法律问题的解释》第二条", [["最高人民法院关于审理买卖合同纠纷案件适用法律问题的解释", 2]]],
  ["《中华人民共和国民事诉讼法》第二百四十四条第一款第（六）项", [["中华人民共和国民事诉讼法", 244, 1, 6]]],
  ["依据民法典第一百五十三条第一款，合同无效", [["民法典", 153, 1]]],
  ["《个人信息保护法》第十三条第一款第（二）项", [["个人信息保护法", 13, 1, 2]]],
  ["参照《九民纪要》第九十二条", [["九民纪要", 92]]],
  ["《民法典》第584条", [["民法典", 584]]],
  ["根据《公司法》第七十一条，该法第七十二条另有规定", [["公司法", 71], ["公司法", 72]]],
  ["《建设工程施工合同解释（一）》第三十八条", [["建设工程施工合同解释（一）", 38]]],
  ["《证券法》第八十五条", [["证券法", 85]]],
  ["《消费者权益保护法》第五十五条第一款", [["消费者权益保护法", 55, 1]]],
  ["《民法典》总则编第一百四十三条", [["民法典", 143]]],
  ["《民法典》第563条第1款第（4）项", [["民法典", 563, 1, 4]]],
];
const NEGATIVE = ["公司法务部第三条意见已收到", "第五条 保密", "根据合同第三条约定", "本协议第七条另有约定", "《股权转让协议》第七条", "《公司章程》第十二条", "合同法律顾问第二次会议"];

const key = (law: string, a: number, p?: number | null, i?: number | null) => `${law}|${a}|${p ?? ""}|${i ?? ""}`;

test("B-7 引用提取语料召回 ≥ 95%（款、项、编章、无书名号、司法解释全称与简称、列举与区间、该法 / 同法）", () => {
  let want = 0;
  let hit = 0;
  const misses: string[] = [];
  for (const [text, exp] of CORPUS) {
    const got = new Set(extractCitations(text).map((c) => key(c.law, c.article, c.paragraph, c.item)));
    for (const w of exp) {
      want += 1;
      if (got.has(key(...w))) hit += 1;
      else misses.push(`${text} → ${key(...w)}（提到 ${[...got].join("；") || "无"}）`);
    }
  }
  const recall = hit / want;
  assert.ok(recall >= 0.95, `召回 ${(recall * 100).toFixed(1)}%（${hit}/${want}）；漏：\n${misses.join("\n")}`);
  // 现在这份语料应当全中：防止日后改正则时悄悄退步
  assert.deepEqual(misses, []);
});

test("B-7 不该提取的不提取：合同条款号、合同标题、“公司法务部”这类词", () => {
  for (const t of NEGATIVE) assert.deepEqual(extractCitations(t).map((c) => c.raw), [], t);
  // 原文位置与原样文字：书名号与编章名保留在 raw 里（复核页逐条列出）
  const [c] = extractCitations("此外，《民法典》合同编第五百七十七条");
  assert.equal(c!.raw, "《民法典》合同编第五百七十七条");
  assert.equal(c!.offset, 3);
});

test("B-7 名称归一：简称、去或加“中华人民共和国”、标题里的〈〉都能在法规库查到", () => {
  assert.ok(lawNameCandidates("民诉法").includes("中华人民共和国民事诉讼法"));
  assert.ok(lawNameCandidates("中华人民共和国律师法").includes("律师法"));
  assert.ok(lawNameCandidates("公司法").includes("中华人民共和国公司法"));
  assert.ok(lawNameCandidates("公司法解释（三）").includes("最高人民法院关于适用《中华人民共和国公司法》若干问题的规定（三）"));
  assert.ok(lawNameCandidates("最高人民法院关于适用〈中华人民共和国民事诉讼法〉的解释").includes("最高人民法院关于适用《中华人民共和国民事诉讼法》的解释"));
});

test("B-7 款项核对：正文已采集的按段落与列项核对，没采集的只核到条并如实注明", () => {
  assert.deepEqual(articleStructure("第一款。\n（一）甲；\n（二）乙；\n第二款。"), [2, 0]);
  assert.deepEqual(articleStructure("只有一款。\n（G0 演示演绎文本：说明。）"), [0], "整段括号里的编者注不算款");
  const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
  const signerPub = (JSON.parse(readFileSync(repo("content/keys/content-signing-dev.pub.json"), "utf8")) as { publicKeyPem: string }).publicKeyPem;
  const lawdb = openLawdb(repo("content/lawdb/dist/lawdb.sqlite"), { expectedSignerPubPem: signerPub });
  const v = (text: string) => citationsVerify(lawdb, { text, as_of: "2026-10-01" }).verdicts[0]!;
  // 《民法典》第五百八十五条正文已采集（三款）
  assert.equal(v("《民法典》第五百八十五条第二款").state, CitationState.supportPending);
  const p4 = v("《民法典》第五百八十五条第四款");
  assert.equal(p4.state, CitationState.intercepted);
  assert.match(p4.reasons[0]!, /paragraph_out_of_range:第 585 条只有 3 款/);
  const it = v("《民法典》第五百八十五条第一款第（二）项");
  assert.equal(it.state, CitationState.intercepted);
  assert.match(it.reasons[0]!, /item_out_of_range/);
  // 第五百零一条正文没采集：只核到条，如实注明款项没核
  const un = v("《民法典》第五百零一条第二款");
  assert.equal(un.state, CitationState.supportPending);
  assert.ok(un.reasons.some((r) => r.startsWith("subdivision_unchecked:")));
  // 无书名号与全称都能查到法规库里的“民法典”
  assert.equal(v("依照中华人民共和国民法典第五百零九条").matched_law_name, "中华人民共和国民法典");
  assert.equal(v("刑法第一百二十条之一").state, CitationState.intercepted, "刑法不在演示法规库：法规库外");
  const suffix = citationsVerify(lawdb, { citations: [], text: "《民法典》第五百零九条之一", as_of: "2026-10-01" }).verdicts[0]!;
  assert.ok(suffix.reasons.some((r) => r.startsWith("suffix_unchecked:")));
});
