// V11 引用核验对抗性审计（离线确定性）：编造、过时、无法核实的引用不得得到“已核”结论，也不得被提取器静默漏掉。
// 每条用例都走签发门禁同一判定（checkArtifactCitations）或工具入口（citationsVerify）；期望值按律师执业常识与法规库实际收录写定。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openLawdb } from "@zr-legal/lawdb";
import { CitationState } from "@zr-legal/domain";
import { createDocx } from "@zr-legal/docx-engine";
import { checkArtifactCitations } from "../src/services/artifact-citations.ts";
import { citationsVerify, extractCaseNumbers, extractCitations } from "../src/tools/tools/citations.ts";

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const signerPub = (JSON.parse(readFileSync(repo("content/keys/content-signing-dev.pub.json"), "utf8")) as { publicKeyPem: string }).publicKeyPem;
const lawdb = openLawdb(repo("content/lawdb/dist/lawdb.sqlite"), { expectedSignerPubPem: signerPub });
const AS_OF = "2026-10-01";
const kinds = (text: string, asOf = AS_OF) => checkArtifactCitations(lawdb, "备忘录.md", Buffer.from(text), asOf).items.map((i) => i.kind);
const items = (text: string, asOf = AS_OF) => checkArtifactCitations(lawdb, "备忘录.md", Buffer.from(text), asOf).items;

test("V11-1 版本括注：明写旧版（2018 年公司法、2021 年民事诉讼法）不得按现行版本判“已核”；写对版本的照常已核", () => {
  for (const t of [
    "依据《中华人民共和国公司法（2018年修正）》第十六条，担保须经决议。",
    "依据《公司法》（2018年修正）第十六条，担保须经决议。",
    "依据《民事诉讼法》（2021年修正）第二百四十六条，申请执行的期间为二年。",
    "依据公司法（2018年修正）第七十一条，股权转让须经其他股东过半数同意。",
  ]) {
    const it = items(t);
    assert.equal(it.length, 1, t);
    assert.notEqual(it[0]!.kind, "ok", `${t} → ${it[0]!.kind}`);
  }
  const v = citationsVerify(lawdb, { text: "依据《公司法》（2018年修正）第十六条", as_of: AS_OF }).verdicts[0]!;
  assert.equal(v.state, CitationState.intercepted);
  assert.ok(v.reasons.some((r) => /2018/.test(r) && /2024-07-01/.test(r)), v.reasons.join("；"));
  // 写对版本的不受影响
  assert.deepEqual(kinds("依据《中华人民共和国公司法》（2023年修订）第十五条，公司对外担保须经决议。"), ["ok"]);
  assert.deepEqual(kinds("《民法典（2020年）》第五百零九条"), ["ok"]);
  assert.deepEqual(kinds("《民事诉讼法》（2023年修正）第二百五十条"), ["ok"]);
  // 分析时点在旧版施行期间：库里没有该旧版，按“无适用版本”人工核对（不是已核）
  assert.notEqual(kinds("《公司法》（2018年修正）第十六条", "2023-05-01")[0], "ok");
});

test("V11-2 司法解释文号：文号与所引解释不符的拦截；只写文号的引用能提取并核到；编造的文号不得已核", () => {
  // 文号属于另一部解释（法释〔2020〕28号是担保制度解释）
  assert.deepEqual(kinds("依《合同编通则解释》（法释〔2020〕28号）第六十五条，违约金可以调整。"), ["wrong"]);
  // 法规库登记了该解释的文号，所引文号对不上
  assert.notEqual(kinds("《最高人民法院关于适用〈中华人民共和国民法典〉有关担保制度的解释》（法释〔2021〕8号）第十七条")[0], "ok");
  // 文号正确
  assert.deepEqual(kinds("《最高人民法院关于适用〈中华人民共和国民法典〉有关担保制度的解释》（法释〔2020〕28号）第十七条"), ["ok"]);
  // 只写文号
  assert.deepEqual(kinds("根据法释〔2020〕28号第十七条，担保人承担不超过二分之一的责任。"), ["ok"]);
  assert.deepEqual(kinds("根据法释〔2020〕99号第三条，应认定合同有效。"), ["outside"]);
  // 文号写在书名号引用的括注里，不重复提取，也不被当成案号
  assert.equal(extractCitations("《民间借贷规定》（法释〔2020〕17号）第二十五条").length, 1);
  assert.deepEqual(extractCaseNumbers("《民间借贷规定》（法释〔2020〕17号）第二十五条"), []);
});

test("V11-3 案号：空格、全角数字、〔〕括号、跨行、指导案例都要提取为“未核实（离线）”，不得静默漏掉", () => {
  for (const t of [
    "参见（2023）最高法民终 123 号判决。",
    "参见（２０２３）最高法民终１２３号判决。",
    "参见〔2023〕最高法民终88号判决。",
    "参见（2023）最高法\n民终123号判决。",
    "参照最高人民法院指导案例第166号的裁判要点。",
    "参照指导性案例24号。",
  ]) {
    const r = citationsVerify(lawdb, { text: t, as_of: AS_OF });
    assert.equal(r.summary.unverified_offline, 1, t);
    assert.equal(r.verdicts.filter((v) => v.kind === "case").every((v) => v.state === CitationState.unverifiedOffline), true);
    assert.deepEqual(kinds(t), ["case"], t);
  }
  // 原有形态不变
  assert.deepEqual(extractCaseNumbers("参见（2023）最高法民终123号、(2022)京01民终4567号"), ["（2023）最高法民终123号", "(2022)京01民终4567号"]);
});

test("V11-4 换行与表格：书名号跨行、法名与条号分行、条号数字被折行、表格里法名与条号分列，都要核到", () => {
  assert.deepEqual(kinds("依据《中华人民共和国\n民法典》第一千三百条，合同无效。"), ["wrong"]);
  assert.deepEqual(kinds("依据《民法典》第一千\n三百条，合同无效。"), ["wrong"]);
  assert.deepEqual(kinds("依据《民法典》\n第一千三百条，合同无效。"), ["wrong"]);
  assert.deepEqual(kinds("| 法律 | 条文 | 要旨 |\n| --- | --- | --- |\n| 《民法典》 | 第一千三百条 | 合同无效 |"), ["wrong"]);
  const docx = createDocx("法律依据表", [{ heading: "依据", paragraphs: [], table: { columns: ["法律", "条文"], rows: [["《民法典》", "第一千三百条"], ["《劳动合同法》", "第一百零一条"]] } }]);
  const d = checkArtifactCitations(lawdb, "依据表.docx", docx, AS_OF);
  assert.deepEqual(d.items.map((i) => i.kind), ["wrong", "wrong"]);
  // 正确引用跨行同样核到为已核
  assert.deepEqual(kinds("依据《中华人民共和国\n民法典》第五百八十五条第二款"), ["ok"]);
});

test("V11-5 简写列举：“第577、1300条”“第五百七十七条、一千三百条”“第二款、第五款”逐个核对", () => {
  assert.deepEqual(kinds("依据《民法典》第577、1300条，违约方应承担责任。"), ["ok", "wrong"]);
  assert.deepEqual(kinds("依据《民法典》第五百七十七条、一千三百条，违约方应承担责任。"), ["ok", "wrong"]);
  assert.deepEqual(kinds("《民法典》第五百八十五条第二款、第五款对违约金调整作了规定。"), ["ok", "outside"]);
  const c = extractCitations("《民法典》第五百八十五条第二款、第三款");
  assert.deepEqual(c.map((x) => [x.article, x.paragraph]), [[585, 2], [585, 3]]);
});

test("V11-6 简称：《公司法司法解释三》《民诉法司法解释》能查到法规库；民法通则无书名号也提取", () => {
  assert.deepEqual(kinds("参照《公司法司法解释三》第十三条，未出资股东应承担补充赔偿责任。"), ["ok"]);
  assert.deepEqual(kinds("依《民诉法司法解释》第九十条，当事人应对其主张提供证据。"), ["ok"]);
  assert.deepEqual(kinds("根据民法通则第一百三十五条，诉讼时效期间为二年。"), ["outside"]);
});

test("V11-7 已废止的法律：适用时点在废止之后，说明已废止并提示改引民法典（须人工核对，不说成“法规库没收录”）", () => {
  for (const t of ["依据《中华人民共和国合同法》第一百一十四条，违约金可调整。", "保证人的责任依《担保法》第十八条确定。", "《物权法》第一百零六条", "侵权责任法第六条", "《最高人民法院关于适用〈中华人民共和国担保法〉若干问题的解释》第七条"]) {
    const v = citationsVerify(lawdb, { text: t, as_of: AS_OF }).verdicts[0]!;
    assert.equal(v.state, CitationState.intercepted, t);
    assert.ok(v.reasons.some((r) => /废止/.test(r) && /2021-01-01/.test(r)), `${t} → ${v.reasons.join("；")}`);
    assert.match(v.suggestion ?? "", /民法典/);
    const it = items(t)[0]!;
    assert.equal(it.kind, "outside");
    assert.doesNotMatch(it.reason ?? "", /没有收录/);
  }
  // 废止前的时点：不说已废止（法规库确实没收旧法）
  const old = citationsVerify(lawdb, { text: "《合同法》第一百一十四条", as_of: "2019-06-01" }).verdicts[0]!;
  assert.ok(old.reasons.some((r) => r.startsWith("unknown_source:")));
});

test("V11-8 适用时点须为真实日期", () => {
  assert.throws(() => citationsVerify(lawdb, { text: "《民法典》第五百八十五条", as_of: "2026-13-45" }), /as_of/);
});

test("V11-9 回归护栏：正确引用仍为已核，合同条款与内部文件仍不提取", () => {
  for (const t of [
    "根据《中华人民共和国民法典》第五百八十五条第二款，约定的违约金过分高于造成的损失的，当事人可以请求适当减少。",
    "依据《民法典》第563条第1款第4项，甲方有权解除合同。",
    "《民法典》第５８５条第２款规定了违约金的调整。",
    "依《 民法典 》第 585 条，违约金可以调整。",
    "《最高人民法院关于审理民间借贷案件适用法律若干问题的规定》（法释〔2020〕17号）第二十五条第一款规定了利率保护上限。",
    "公司以严重违纪为由，依《劳动合同法》第三十九条第（二）项解除劳动合同。",
    "依据《民法典》第三编合同第一分编通则第五百零九条，当事人应全面履行。",
  ])
    assert.deepEqual(kinds(t), ["ok"], t);
  for (const t of ["依据《股权转让协议》第七条第二款，受让方应支付价款。", "本合同第十条约定的违约金为合同总额的20%。", "《劳动合同》第三条约定了工作地点。", "根据《公司章程（2021年修订）》第五条，董事会由五人组成。", "第一条 定义\n本协议中，下列用语含义如下：", "（2023年度）工作报告第3号"])
    assert.deepEqual(kinds(t), [], t);
});

test("V11-10 law.get_version / law.get_article 与 citations.verify 同一名称归一；已废止的法写明废止事实", async () => {
  const { lawGetArticle, lawGetVersion } = await import("../src/tools/tools/law.ts");
  for (const law of ["劳动争议解释一", "公司法司法解释三", "《民诉法司法解释》"]) assert.equal(lawGetVersion(lawdb, { law, as_of: AS_OF }).found, true, law);
  const rep = lawGetVersion(lawdb, { law: "担保法", as_of: AS_OF });
  assert.equal(rep.found, false);
  assert.equal(rep.repealed?.repealed, "2021-01-01");
  assert.match(rep.repealed?.successor ?? "", /民法典/);
  assert.match(lawGetArticle(lawdb, { law: "合同法", article: 114, as_of: AS_OF }).note, /已于 2021-01-01 废止/);
  assert.match(lawGetArticle(lawdb, { law: "合同法", article: 114, as_of: "2019-06-01" }).note, /未收录/);
});

test("V11-11 逗号后不带“第”的数字、“第二款”不当作同一部法的条款（合同条款与正文数字不误提）", () => {
  assert.deepEqual(extractCitations("依据《民法典》第五百八十五条，第五款约定的违约金过高。").map((c) => [c.article, c.paragraph ?? null]), [[585, null]]);
  assert.deepEqual(extractCitations("《民法典》第五百八十五条，三十日内通知对方。").map((c) => c.article), [585]);
});

test("V11-12 签发门禁：编造的“之一”条不得判已核（须人工核对）；文号对不上给律师看得懂的理由", () => {
  for (const t of ["依据《民法典》第五百八十五条之一，违约金不得超过合同总额百分之二十。", "《民法典》第五百零九条之二第一款"]) {
    const it = items(t)[0]!;
    assert.equal(it.kind, "outside", t);
    assert.match(it.reason ?? "", /之一|之二/, t);
  }
  const dn = items("依《合同编通则解释》（法释〔2020〕28号）第六十五条").find((i) => i.kind === "wrong");
  assert.ok(dn, "文号属于另一部解释：定性错误");
  assert.match(dn!.reason ?? "", /文号/);
  assert.doesNotMatch(dn!.reason ?? "", /^核对不通过$/);
});
