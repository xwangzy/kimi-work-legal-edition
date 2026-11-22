/**
 * V32（第 58 批）法规库与引用核验修复——第 57 批全量验收暴露的五个问题（C4 第三点、C5）与主会话根因复盘三项：
 * A. 数据出境三部规章与《个人信息出境认证办法》入库（官方全文、两处官方来源逐字比对）；《律师法》两版补全文；法规目录（只登记条数）一档；
 * B. 库里有这部法、条号超出条数的报“该法共 N 条，没有第 M 条”，交付前检查列为必须改；“第六至八、十五条”省略写法逐条核；
 *    库里查不到却写了条号的，交付前检查报必须改（律师把官方文本作为材料导入的不报）；
 * C. 检索：“民诉解释 举证责任”、全称带书名号、法名后写条号都能找到民诉法解释第九十、九十一条；
 * D. 复核附的法条原文按“法名＋条号”取，简称先归一，取不到就不给、不拿同条号的别的法凑；
 * E. 材料里引用的已废止规定：给起草方的提示与复核输入各加说明（“请核对现行效力”）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openLawdb } from "@zr-legal/lawdb";
import { createDocx } from "@zr-legal/docx-engine";
import { CitationState } from "@zr-legal/domain";
import { citationsVerify, extractCitations, UNKNOWN_SOURCE_FIX } from "../src/tools/tools/citations.ts";
import { lawGetArticle, lawSearch, expandLawAliases } from "../src/tools/tools/law.ts";
import { checkDeliverable } from "../src/services/deliverable-check.ts";
import { checkArtifactCitations } from "../src/services/artifact-citations.ts";
import { lawExcerptLines, lawRefsIn, reviewMessages } from "../src/services/independent-review.ts";
import { materialRepealedPromptLine, materialRepealedReviewLines, repealedInMaterials } from "../src/services/material-repealed.ts";
import { LAWDB_SHIPPED } from "./helpers.ts";

const signerPub = JSON.parse(readFileSync(fileURLToPath(new URL("../../../content/keys/content-signing-dev.pub.json", import.meta.url)), "utf8")).publicKeyPem;
const lawdb = openLawdb(LAWDB_SHIPPED, { expectedSignerPubPem: signerPub });
const AS_OF = "2026-11-22";
const SCC = "个人信息出境标准合同办法";
const CPI = "最高人民法院关于适用《中华人民共和国民事诉讼法》的解释";
const CGI = "最高人民法院关于适用《中华人民共和国民法典》合同编通则若干问题的解释";

test("A 入库：数据出境三部规章、出境认证办法全文；律师法两版全文；法规目录只登记条数", () => {
  for (const [name, n, eff] of [
    [SCC, 13, "2023-06-01"],
    ["数据出境安全评估办法", 20, "2022-09-01"],
    ["促进和规范数据跨境流动规定", 14, "2024-03-22"],
    ["个人信息出境认证办法", 19, "2026-01-01"],
  ] as const) {
    const r = lawGetArticle(lawdb, { law: name, article: n, as_of: AS_OF });
    assert.equal(r.found, true, name);
    assert.equal(r.effective, eff, name);
    assert.equal(r.reliability, "official_text_collected", name);
    assert.equal(lawGetArticle(lawdb, { law: name, article: n + 1, as_of: AS_OF }).reason, "article_not_exist", name);
  }
  assert.match(lawGetArticle(lawdb, { law: "标准合同办法", article: 7, as_of: AS_OF }).text!, /10个工作日内向所在地省级网信部门备案/);
  assert.match(lawGetArticle(lawdb, { law: SCC, article: 13, as_of: AS_OF }).text!, /^本办法自2023年6月1日起施行/);
  // 被令第16号限定的条：核验与取原文都带合读提示
  const a4: any = lawGetArticle(lawdb, { law: "数据出境安全评估办法", article: 14, as_of: AS_OF });
  assert.match(a4.read_with.join(""), /促进和规范数据跨境流动规定.*第九条/);
  // 《律师法》：2026 修正本 65 条、2017 修正本 60 条都有正文，不再是演示数据
  const l41 = lawGetArticle(lawdb, { law: "律师法", article: 41, as_of: AS_OF });
  assert.equal(l41.reliability, "official_text_collected");
  assert.match(l41.text!, /不愿泄露的有关情况和信息/);
  assert.match(lawGetArticle(lawdb, { law: "律师法", article: 62, as_of: AS_OF }).text!, /粤港澳大湾区律师执业考试/);
  assert.equal(lawGetArticle(lawdb, { law: "律师法", article: 66, as_of: AS_OF }).reason, "article_not_exist");
  assert.match(lawGetArticle(lawdb, { law: "律师法", article: 38, as_of: "2025-01-01" }).text!, /^律师应当保守在执业活动中知悉的国家秘密/);
  // 个人信息保护法全文 74 条
  assert.equal(lawGetArticle(lawdb, { law: "个人信息保护法", article: 74, as_of: AS_OF }).found, true);
  // 法规目录：网络数据安全管理条例只登记了 64 条，没有正文——“有没有这一条”能核，内容不给
  const meta = lawGetArticle(lawdb, { law: "网络数据安全管理条例", article: 40, as_of: AS_OF });
  assert.equal(meta.reason, "text_not_collected");
  assert.match(meta.note, /法规目录.*共 64 条.*查官方文本/);
  const over = citationsVerify(lawdb, { text: "《网络数据安全管理条例》第六十五条", as_of: AS_OF }).verdicts[0]!;
  assert.match(over.reasons[0]!, /共 64 条，没有第六十五条/);
  assert.match(lawdb.status().source_coverage_note, /只登记了目录信息/);
  // V32 追加：九民纪要 130 条（不是司法解释，每条带“不作裁判依据援引”的提示）；法释〔2014〕8号 7 条
  const jm: any = lawGetArticle(lawdb, { law: "九民纪要", article: 36, as_of: AS_OF });
  assert.match(jm.text, /^【合同无效时的释明问题】/);
  assert.match(jm.read_with.join(""), /不是司法解释，不能作为裁判依据援引/);
  assert.equal(lawGetArticle(lawdb, { law: "九民会纪要", article: 131, as_of: AS_OF }).reason, "article_not_exist");
  const v9 = citationsVerify(lawdb, { text: "九民纪要第一百三十一条；《九民纪要》第6条", as_of: AS_OF }).verdicts;
  assert.deepEqual(v9.map((v) => v.state), [CitationState.intercepted, CitationState.supportPending]);
  assert.match(lawGetArticle(lawdb, { law: "法释〔2014〕8号", article: 4, as_of: AS_OF }).text!, /先清偿生效法律文书确定的金钱债务，再清偿加倍部分债务利息/);
  assert.match(lawGetArticle(lawdb, { law: "迟延履行利息解释", article: 1, as_of: AS_OF }).text!, /日万分之一点七五/);
  assert.equal(lawGetArticle(lawdb, { law: "迟延履行利息解释", article: 8, as_of: AS_OF }).reason, "article_not_exist");
  // V32 第三次追加：财产保全规定 2020 修正本（原文本 + 修正决定第十二项改第六条，标“依据修改决定”）；2021 年前按 2016 原文本
  const bq6: any = lawGetArticle(lawdb, { law: "财产保全规定", article: 6, as_of: AS_OF });
  assert.equal(bq6.lsv_id, "lsv_jud_property_preservation_2020");
  assert.match(bq6.text, /违反民法典、公司法等有关法律禁止性规定/);
  assert.equal(bq6.reliability, "inferred_from_amendment_decision");
  assert.equal((lawGetArticle(lawdb, { law: "保全规定", article: 6, as_of: "2020-06-01" }) as any).lsv_id, "lsv_jud_property_preservation_2016");
  assert.equal(lawGetArticle(lawdb, { law: "财产保全规定", article: 30, as_of: AS_OF }).reason, "article_not_exist");
  assert.match(lawGetArticle(lawdb, { law: "技术合同解释", article: 1, as_of: AS_OF }).text!, /^技术成果，是指利用科学技术知识/);
  assert.equal(lawGetArticle(lawdb, { law: "技术合同解释", article: 48, as_of: AS_OF }).reason, "article_not_exist");
  // 检索与复核原文：库里有《诉讼费用交纳办法》第十六条（简易程序减半），按说法、按“法名＋条号”、不加书名号写进文书都能取到
  for (const q of ["简易程序 减半 受理费", "诉讼费用交纳办法第十六条", "诉讼费 简易程序 减半"]) assert.equal(lawSearch(lawdb, { query: q }).articles[0]?.article_no, 16, q);
  const fee = lawRefsIn(["依照诉讼费用交纳办法第十六条，适用简易程序的减半交纳。"]);
  assert.deepEqual(fee.map((r) => [r.law, r.article]), [["诉讼费用交纳办法", 16]]);
  assert.match(lawExcerptLines(lawdb, fee, AS_OF).join(""), /减半交纳案件受理费/);
  // “……实施办法”前面紧挨母法名，照旧不加书名号不提取
  assert.equal(extractCitations("依据企业职工带薪年休假实施办法第十条").length, 0);
});

test("B 条号越界：省略写法“第六至八、十五条”逐条核，第十五条报“该法共 13 条，没有第十五条”，交付前检查列为必须改", () => {
  const cites = extractCitations(`依据《${SCC}》第六至八、十五条，标准合同生效后方可出境。`);
  assert.deepEqual(cites.map((c) => [c.law, c.article]), [[SCC, 6], [SCC, 8], [SCC, 15]]);
  assert.deepEqual(extractCitations("《民法典》第五百七十七、五百八十五条").map((c) => c.article), [577, 585]);
  const vs = citationsVerify(lawdb, { text: `《${SCC}》第六至八、十五条`, as_of: AS_OF }).verdicts;
  assert.equal(vs.filter((v) => v.state === CitationState.supportPending).length, 2);
  const bad = vs.find((v) => v.article === 15)!;
  assert.equal(bad.state, CitationState.intercepted);
  assert.match(bad.reasons[0]!, /^article_out_of_range:.*共 13 条，没有第十五条/);
  const sections = [{ heading: "四、依据", paragraphs: [`《${SCC}》第六至八、十五条；《促进和规范数据跨境流动规定》第八条。`] }];
  const c = checkDeliverable("合规意见", sections, { lawdb, asOf: AS_OF, docx: createDocx("合规意见", sections) });
  const issue = c.issues.find((i) => i.kind === "citation");
  assert.ok(issue, JSON.stringify(c.issues));
  assert.match(issue!.fix, /共 13 条，没有第十五条/);
  assert.equal(c.issues.filter((i) => i.kind === "citation").length, 1, "第六、八条与促进规定第八条不报");
  // 司法解释的条号不归到母法：民诉法解释第五百条（共 550 条）不按民事诉讼法（306 条）判越界
  const interp = citationsVerify(lawdb, { text: "民诉法解释第五百条、合同编通则解释第六十五条", as_of: AS_OF }).verdicts;
  assert.deepEqual(interp.map((v) => [v.matched_law_name, v.state]), [[CPI, CitationState.supportPending], [CGI, CitationState.supportPending]]);
});

test("B 库里查不到、却写了条号：交付前检查报必须改（库内法的简称不误报；律师导入了官方文本作材料的不报）", () => {
  const sections = [{ heading: "依据", paragraphs: ["《个人信息保护合规审计管理办法》第五条要求定期审计；民诉解释第九十条规定了举证责任；《民法典》第五百八十五条。"] }];
  const docx = createDocx("意见", sections);
  const c = checkDeliverable("意见", sections, { lawdb, asOf: AS_OF, docx });
  const cites = c.issues.filter((i) => i.kind === "citation");
  assert.equal(cites.length, 1, JSON.stringify(cites));
  assert.match(cites[0]!.text, /合规审计管理办法/);
  assert.equal(cites[0]!.fix, UNKNOWN_SOURCE_FIX);
  const v = citationsVerify(lawdb, { text: "《个人信息保护合规审计管理办法》第五条", as_of: AS_OF }).verdicts[0]!;
  assert.equal(v.suggestion, UNKNOWN_SOURCE_FIX);
  const exempt = checkDeliverable("意见", sections, { lawdb, asOf: AS_OF, docx, materialTitles: ["个人信息保护合规审计管理办法（官方文本）.pdf"] });
  assert.equal(exempt.issues.filter((i) => i.kind === "citation").length, 0);
  // 已废止的不按“库外”报，仍按已废止报
  const old = checkArtifactCitations(lawdb, "a.md", Buffer.from("《合同法》第九十六条"), AS_OF);
  assert.match(old.items[0]!.reason!, /已于 2021-01-01 废止/);
});

test("C 检索：简称、全称带书名号、法名后写条号，都能找到民诉法解释第九十、九十一条", () => {
  const top = (q: string, n = 5) => lawSearch(lawdb, { query: q }).articles.slice(0, n).map((a) => `${a.law_name === CPI ? "民诉解释" : a.law_name}#${a.article_no}`);
  for (const q of ["民诉解释 举证责任", "民诉法解释 举证责任", "民事诉讼法解释 举证责任", "民诉法司法解释 举证责任", `${CPI} 举证责任`, "《最高人民法院关于适用〈中华人民共和国民事诉讼法〉的解释》 举证责任"]) {
    const t = top(q);
    assert.ok(t.includes("民诉解释#90") && t.includes("民诉解释#91"), `${q} → ${t.join(" ")}`);
  }
  assert.deepEqual(top("民诉法解释第九十条", 1), ["民诉解释#90"]);
  assert.deepEqual(top("民事诉讼法司法解释第九十条 第九十一条", 2), ["民诉解释#90", "民诉解释#91"]);
  assert.deepEqual(top("民诉解释第90、91条", 2), ["民诉解释#90", "民诉解释#91"]);
  // 不带法名的“举证责任”也命中写作“举证证明责任”的条文
  assert.ok(lawSearch(lawdb, { query: "举证责任 不利后果" }).articles.some((a) => a.law_name === CPI && a.article_no === 90));
  // “公司法定代表人”不当作公司法的法名
  assert.equal(expandLawAliases("公司法定代表人 变更"), "公司法定代表人 变更");
  assert.equal(expandLawAliases("民诉解释第九十条"), `${CPI}第九十条`);
  // 新入库的规章按关键词能找到
  assert.ok(lawSearch(lawdb, { query: "标准合同 备案" }).articles.some((a) => a.law_name === SCC && a.article_no === 7));
});

test("D 复核附的法条原文按“法名＋条号”取：合同编通则解释、民诉法解释、民法典混在一段里各取各的", () => {
  const para = "依据合同编通则解释第六十五条、民诉法解释第九十条及民法典第五百八十五条，违约金调整由主张方举证。";
  const refs = lawRefsIn([para]);
  const names = refs.map((r) => `${r.law.replace(/^中华人民共和国/, "")}#${r.article}`);
  assert.deepEqual(names, [`${CGI}#65`, `${CPI}#90`, "民法典#585"]);
  const lines = lawExcerptLines(lawdb, refs, AS_OF).join("\n");
  assert.match(lines, /合同编通则若干问题的解释》第六十五条】[^【]*约定的违约金超过/);
  assert.match(lines, /的解释》第九十条】[^【]*当事人对自己提出的诉讼请求所依据的事实/);
  assert.match(lines, /《民法典》第五百八十五条】/);
  assert.doesNotMatch(lines, /《民法典》第六十五条/);
  // 复核意见里“合同编通则解释第六十四条、第六十五条”：后一个条号不归到前面的民法典
  const finding = ["《民法典》第五百八十五条第二款可请求调整，合同编通则解释第六十四条、第六十五条规定了举证与酌减。"];
  const fr = lawRefsIn(finding, { followBare: true }).map((r) => `${r.law.replace(/^中华人民共和国/, "")}#${r.article}`);
  assert.deepEqual(fr, ["民法典#585", `${CGI}#64`, `${CGI}#65`]);
  // 书名号法名后面跟着别的文件名（认不出的）：不拿这部法同条号的原文凑
  const odd = lawRefsIn(["《民法典》某某规范性文件解释第六十五条"]).map((r) => `${r.law}#${r.article}`);
  assert.equal(odd.some((x) => /民法典#65/.test(x)), false, odd.join(","));
  // 意见里两个条号之间提到了别的法规：后一个条号不归到前面的法
  const mixed = lawRefsIn(["《民法典》第五百八十五条与《宇宙规范》规定不同，见第六十五条"], { followBare: true }).map((r) => `${r.law}#${r.article}`);
  assert.equal(mixed.some((x) => /民法典#65/.test(x)), false, mixed.join(","));
});

test("E 材料里引用的已废止规定：起草提示与复核输入各加说明，口径是“请核对现行效力”", () => {
  const materials = [
    "答辩意见：根据《最高人民法院关于适用〈中华人民共和国合同法〉若干问题的解释（二）》第二十四条，对方未在三个月内提出异议，解除通知已生效。",
    "原合同第九条：本合同未尽事宜依照《中华人民共和国合同法》处理。另依合同法解释（二）第二十四条。双方的合同法律关系自签订时成立。",
  ];
  const hits = repealedInMaterials(materials, AS_OF);
  assert.deepEqual(hits.map((h) => [h.articles, h.on]), [[[24], "2021-01-01"], [[], "2021-01-01"]]);
  const line = materialRepealedPromptLine(materials, AS_OF);
  assert.match(line, /^【材料中的已废止规定】材料里引用的《最高人民法院关于适用《中华人民共和国合同法》若干问题的解释（二）》第二十四条已于 2021-01-01 废止（最高人民法院法释〔2020〕16 号废止决定），现行对应规定见《民法典》合同编与《合同编通则解释》/);
  assert.match(line, /《合同法》已于 2021-01-01 废止（《民法典》第一千二百六十条），现行对应规定见《民法典》合同编/);
  assert.match(line, /请核对现行效力/);
  assert.doesNotMatch(line, /错误/);
  assert.equal(materialRepealedPromptLine(materials, "2020-06-01"), "", "分析截止日在废止之前：不提示");
  assert.equal(materialRepealedPromptLine(["双方的合同法律关系成立；《民法典》第五百零九条。"], AS_OF), "", "现行法与“合同法律关系”不报");
  const review = materialRepealedReviewLines(materials, AS_OF);
  assert.equal(review.length, 2);
  const msgs = reviewMessages({ kind: "drafting" as any, stance: "原告", jurisdiction: "中国大陆", asOf: AS_OF, today: AS_OF, goal: "写案件汇报", materials: [{ filename: "答辩意见.docx", text: materials[0]! }], docs: [{ filename: "汇报.docx", text: "汇报正文" }], diff: [], inventory: [], reply: "", answers: [], laws: [], materialNotes: review } as any);
  const body = msgs.map((m) => m.content).join("\n");
  assert.match(body, /=== 材料中引用的已废止规定/);
  assert.match(body, /【材料】《最高人民法院关于适用《中华人民共和国合同法》若干问题的解释（二）》第二十四条已于 2021-01-01 废止/);
});

// 第 58 批真实复测（争点矩阵）：表格里法名与条号分两格，条号被归到名称里套着的《民法典》
import { joinCitationCells } from "../src/tools/tools/citations.ts";
import { lawRefsIn as lawRefsInB58 } from "../src/services/independent-review.ts";
test("表格分格的引用：接起名称与条号，归到司法解释而不是民法典", () => {
  const row = "［第 22 行］最高人民法院关于适用《中华人民共和国民法典》合同编通则若干问题的解释 | 第64条 | 2023-12-05施行 | 已核";
  assert.ok(joinCitationCells(row).includes("若干问题的解释第64条"));
  const refs = lawRefsInB58([row]);
  assert.equal(refs.length, 1, JSON.stringify(refs));
  assert.match(refs[0]!.law, /合同编通则若干问题的解释/);
  assert.equal(refs[0]!.article, 64);
  assert.equal(joinCitationCells("序号 | 第3条"), "序号 | 第3条", "前一格不是法规名称的不接");
});
