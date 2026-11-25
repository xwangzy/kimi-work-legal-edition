/**
 * 第 65 批（V39）外部第二轮评估查出的几处小缺陷：六角括号年份的案号不提取、证据规定第九十四条公证与平台混为一条、研读表逐字列认不出。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { caseRefsIn, QUOTE_COLUMN_RE } from "../src/services/case-provenance.ts";
import { evidenceRulesCheck } from "../src/tools/tools/evidence-rules.ts";

test("案号年份写在六角括号里也提取；文号（无类型代字）不算案号", () => {
  const r = caseRefsIn("参见〔2024〕沪01民终1234号判决与法释〔2020〕17号。");
  assert.deepEqual(r.map((x) => x.raw), ["〔2024〕沪01民终1234号"]);
  assert.equal(r[0]!.key, caseRefsIn("（2024）沪01民终1234号")[0]!.key, "与圆括号写法同一个比对键");
});

test("电子数据：公证（第九十四条第二款，应当确认、足以推翻）与第三方平台（第一款第（二）项，可以确认、足以反驳）分开", () => {
  const r = evidenceRulesCheck({ rows: [{ name: "公证保全的聊天记录", kind: "电子数据", carrier: "公证保全" }, { name: "平台出具的交易记录", kind: "电子数据", carrier: "第三方平台" }] });
  assert.match(r.rows[0]!.hints[0]!.article, /第九十四条第二款/);
  assert.match(r.rows[0]!.hints[0]!.rule, /应当确认/);
  assert.match(r.rows[1]!.hints[0]!.article, /第九十四条第一款第（二）项/);
  assert.match(r.rows[1]!.hints[0]!.rule, /可以确认/);
});

test("研读表的“判项原文（逐字）”“一审原文（逐字）”列按逐字引文核对", () => {
  for (const c of ["判项原文（逐字）", "一审原文（逐字）", "判项原文", "原文摘录"]) assert.ok(QUOTE_COLUMN_RE.test(c), c);
  assert.ok(!QUOTE_COLUMN_RE.test("摘录"), "来源目录的“摘录”列不在此列");
});

test("条号与主题对照：照抄司法解释里的民诉法旧条号、修订后改号的法律写旧号报出；写明旧版本或讲别的事不报", async () => {
  const { topicArticleIssues } = await import("../src/services/topic-article.ts");
  assert.equal(topicArticleIssues("申请人依照《中华人民共和国民事诉讼法》第一百条的规定提供担保，申请财产保全。").length, 1);
  assert.match(topicArticleIssues("依照民事诉讼法第一百条申请保全")[0]!.fix, /第一百零三条/);
  assert.equal(topicArticleIssues("调解达成协议的，依照民事诉讼法第一百条制作调解书。").length, 0, "讲的就是调解书");
  assert.equal(topicArticleIssues("依照民事诉讼法第一百零三条申请保全。").length, 0);
  assert.equal(topicArticleIssues("民诉法解释第一百条规定的保全担保……").length, 0, "解释不在此列");
  assert.match(topicArticleIssues("被告的行为构成商业贿赂，违反《反不正当竞争法》第七条。")[0]!.fix, /第八条/);
  assert.equal(topicArticleIssues("被告的行为构成商业贿赂，违反《反不正当竞争法》（2019年修正）第七条。").length, 0, "写明旧版本的不报");
  assert.match(topicArticleIssues("公司未依公司法第三十一条签发出资证明书。")[0]!.fix, /第五十五条/);
  assert.equal(topicArticleIssues("被执行人未履行的，依民事诉讼法第二百五十三条加倍支付迟延履行期间的债务利息。").length, 1);
});

test("law.get_article 取到嵌着母法旧条号的司法解释条文时附注现行条号", async () => {
  const { openLawdb } = await import("@zr-legal/lawdb");
  const { lawGetArticle } = await import("../src/tools/tools/law.ts");
  const { LAWDB_SHIPPED } = await import("./helpers.ts");
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const pub = JSON.parse(readFileSync(fileURLToPath(new URL("../../../content/keys/content-signing-dev.pub.json", import.meta.url)), "utf8")).publicKeyPem;
  const lawdb = openLawdb(LAWDB_SHIPPED, { expectedSignerPubPem: pub });
  const r: any = lawGetArticle(lawdb, { law: "最高人民法院关于人民法院办理财产保全案件若干问题的规定", article: 5, as_of: "2026-11-25" });
  assert.match(r.embedded_ref_note, /第一百零三条/);
  const r2: any = lawGetArticle(lawdb, { law: "民法典", article: 585, as_of: "2026-11-25" });
  assert.equal(r2.embedded_ref_note, undefined);
});

test("程序期间目录新增五类：保全裁定复议五日（不能上诉）、执行异议复议十日、案外人异议后起诉十五日、支付令异议十五日、第三人撤销之诉六个月", async () => {
  const { calcDeadline, proceduralPeriod } = await import("../src/tools/tools/deadline.ts");
  const r: any = calcDeadline({ start: "2026-11-20", type: "preservation_reconsideration" } as any);
  assert.equal(r.deadline, "2026-11-25");
  assert.ok(r.procedural.basis.some((b: any) => /第一百七十一条/.test(b.article)));
  assert.match(proceduralPeriod("appeal_ruling")!.notes!.join(""), /保全、先予执行裁定不能上诉/);
  assert.equal(proceduralPeriod("enforcement_objection_review")!.period.n, 10);
  assert.equal(proceduralPeriod("third_party_objection_suit")!.period.n, 15);
  assert.equal(proceduralPeriod("payment_order_objection")!.period.n, 15);
  assert.deepEqual(proceduralPeriod("third_party_revocation_suit")!.period, { unit: "month", n: 6 });
});

test("事实日期告警：没填发生日期、陈述日期与字段不一致、几件事写在一条里；期限类的第二个日期不报", async () => {
  const { factDateWarning } = await import("../src/services/review-cards.ts");
  assert.match(factDateWarning("禾丰于2026年7月15日致函要求更换3号机", null)!, /occurred_on 却没填/);
  assert.match(factDateWarning("禾丰于2026年7月15日致函要求更换3号机", "2026-07-17")!, /核对哪个对/);
  assert.equal(factDateWarning("禾丰于2026年7月15日致函要求更换3号机", "2026-07-15"), null);
  assert.match(factDateWarning("2026年6月21日报修，2026年7月28日更换链条", "2026-06-21")!, /拆成几条/);
  assert.equal(factDateWarning("2026年7月15日禾丰致函，要求2026年7月30日前更换", "2026-07-15"), null, "第二个日期是期限");
  assert.equal(factDateWarning("买方未付验收款余额", null), null);
});

test("law.get_article 交出位阶（法规库的 level 字段）", async () => {
  const { openLawdb } = await import("@zr-legal/lawdb");
  const { lawGetArticle } = await import("../src/tools/tools/law.ts");
  const { LAWDB_SHIPPED } = await import("./helpers.ts");
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const pub = JSON.parse(readFileSync(fileURLToPath(new URL("../../../content/keys/content-signing-dev.pub.json", import.meta.url)), "utf8")).publicKeyPem;
  const lawdb = openLawdb(LAWDB_SHIPPED, { expectedSignerPubPem: pub });
  assert.equal((lawGetArticle(lawdb, { law: "民法典", article: 585, as_of: "2026-11-25" }) as any).level, "法律");
  assert.equal((lawGetArticle(lawdb, { law: "最高人民法院关于人民法院办理财产保全案件若干问题的规定", article: 5, as_of: "2026-11-25" }) as any).level, "司法解释");
  assert.equal((lawGetArticle(lawdb, { law: "全国法院民商事审判工作会议纪要", article: 31, as_of: "2026-11-25" }) as any).level, "司法指导性文件");
});

test("签发页时点提示：司法解释按审理状态适用，不因事件早于施行日就说“没有有效版本”；合同编通则解释只用于民法典施行后的事实", async () => {
  const { openLawdb } = await import("@zr-legal/lawdb");
  const { timingNote } = await import("../src/services/artifact-citations.ts");
  const { LAWDB_SHIPPED } = await import("./helpers.ts");
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const pub = JSON.parse(readFileSync(fileURLToPath(new URL("../../../content/keys/content-signing-dev.pub.json", import.meta.url)), "utf8")).publicKeyPem;
  const lawdb = openLawdb(LAWDB_SHIPPED, { expectedSignerPubPem: pub });
  const CG = "最高人民法院关于适用《中华人民共和国民法典》合同编通则若干问题的解释";
  assert.equal(timingNote(lawdb, CG, 65, "2026-11-25", "2022-06-01", null), null, "2022 年的事实、现在审理：适用");
  assert.match(timingNote(lawdb, CG, 65, "2026-11-25", "2020-06-01", null)!, /民法典施行后/);
  assert.equal(timingNote(lawdb, "最高人民法院关于适用《中华人民共和国民法典》时间效力的若干规定", 1, "2026-11-25", "2019-06-01", null), null);
  const pl = timingNote(lawdb, "最高人民法院关于审理民间借贷案件适用法律若干问题的规定", 25, "2026-11-25", "2018-06-01", null);
  assert.ok(pl === null || /审理状态/.test(pl), String(pl));
  assert.match(timingNote(lawdb, "民法典", 585, "2026-11-25", "2019-06-01", null)!, /没有有效版本|时间效力/, "法律仍按事件时点提示");
});

test("断句残留（v39-m25-r4 修改轮拼接留下的“。。”“。，”）报回；省略号与正常标点不报", async () => {
  const { checkDeliverable } = await import("../src/services/deliverable-check.ts");
  const bad = checkDeliverable("劳动仲裁答辩书", [{ heading: "一、答辩意见", paragraphs: ["申请人主张不构成旷工，不能成立。。（证据2、证据5）", "第二项作为解除的实体依据。，以申请人连续三日旷工构成严重违纪。"] }]);
  assert.equal(bad.issues.filter((i) => /断句/.test(i.fix)).length, 2);
  const ok = checkDeliverable("劳动仲裁答辩书", [{ heading: "一、答辩意见", paragraphs: ["申请人称其已获批准……但人事部门未审批。", "据此，答辩人请求驳回第一项请求。"] }]);
  assert.equal(ok.issues.filter((i) => /断句/.test(i.fix)).length, 0);
});
