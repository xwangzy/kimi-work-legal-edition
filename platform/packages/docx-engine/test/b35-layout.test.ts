/**
 * 第 35 批：文书版式与文件属性（文档工程审查 A-02～A-05，逐条回查源码后修复）。
 * - A-05：Markdown 转 Word 时单个星号被当成斜体记号删掉，“7*24小时”变成“724小时”、算式里的乘号消失；
 * - A-04：文件作者属性写“AI 辅助起草，经律师复核”——生成时律师并未复核；
 * - A-03：意见书方法的“致送对象与事由”“签署栏”只是分段，却印成小标题；
 * - A-02：意见书落款“日期：【待签发】”不在落款识别范围内，整块不右对齐；合同签署页不另起一页、签署行按正文首行缩进。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDocx, extractParagraphs, inlineRuns, markdownToBlocks, readZipEntries } from "../src/index.ts";

const docXml = (buf: Buffer) => readZipEntries(buf).get("word/document.xml")!.toString("utf8");
const paras = (xml: string) => [...xml.matchAll(/<w:p\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].map((m) => m[0]);
const textOf = (p: string) => [...p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("");

test("A-05：单个星号只在外侧不是字母、数字、汉字时才当强调记号；乘号、7*24 原样保留", () => {
  assert.equal(inlineRuns("提供7*24小时服务，5*8小时响应").map((r) => r.text).join(""), "提供7*24小时服务，5*8小时响应");
  assert.equal(markdownToBlocks("违约金=本金*0.05%*逾期天数").flatMap((b) => (b.kind === "p" ? b.runs.map((r) => r.text) : [])).join(""), "违约金=本金*0.05%*逾期天数");
  assert.equal(inlineRuns("*注意* 以上为草稿").map((r) => r.text).join(""), "注意 以上为草稿", "独立的强调记号照常去掉");
  assert.deepEqual(inlineRuns("**重点**内容").map((r) => [r.text, !!r.bold]), [["重点", true], ["内容", false]], "加粗不受影响");
});

test("A-04：生成文件的作者属性不声称“经律师复核”", () => {
  const core = readZipEntries(createDocx("设备买卖合同", [{ heading: "第一条 标的", paragraphs: ["1.1 设备一台。"] }])).get("docProps/core.xml")!.toString("utf8");
  assert.match(core, /<dc:creator>Kimi Work 法律行业发行版（AI 辅助生成，须经律师复核）<\/dc:creator>/);
  assert.doesNotMatch(core, /（AI 辅助起草，经律师复核）/);
});

test("A-03、A-02：意见书的“致送对象与事由”“签署栏”不印成小标题；落款（律所、经办律师、日期：【待签发】）整块右对齐", () => {
  const xml = docXml(
    createDocx("关于晟澜公司对外担保效力的法律意见书（草稿）", [
      { heading: "致送对象与事由", paragraphs: ["致华嘉银行苏州分行：本所接受贵行委托，就下述事项出具本法律意见书。"] },
      { heading: "一、审阅文件", paragraphs: ["1. 保证合同。"] },
      { heading: "签署栏", paragraphs: ["江苏衡定律师事务所", "经办律师：【待签发】", "日期：【待签发】"] },
    ]),
  );
  const ps = paras(xml);
  const headings = ps.filter((p) => /KwlHeading1/.test(p)).map(textOf);
  assert.deepEqual(headings, ["一、审阅文件"], "结构标签不印成小标题");
  for (const t of ["江苏衡定律师事务所", "经办律师：【待签发】", "日期：【待签发】"]) {
    const p = ps.find((x) => textOf(x) === t)!;
    assert.match(p, /KwlRight/, `“${t}”右对齐`);
  }
  assert.ok(ps.some((p) => /KwlTitle/.test(p) && textOf(p) === "关于晟澜公司对外担保效力的法律意见书"), "标题去掉“（草稿）”");
});

test("A-02：合同签署页另起一页，签署行左对齐不缩进、各方之间空一行；附件另起一页；“以下无正文”留在上一页", () => {
  const xml = docXml(
    createDocx("股权转让协议", [
      { heading: "第二十条 生效及其他", paragraphs: ["20.1 本协议自各方签署之日起生效。"] },
      { heading: "", paragraphs: ["（以下无正文，为《股权转让协议》签署页）", "受让方：上海澄远科技集团有限公司（盖章）", "法定代表人或授权代表（签字）：________________", "签署日期：________年____月____日", "转让方一：周牧之（签字）", "签署日期：________年____月____日"] },
      { heading: "附件", paragraphs: [], table: { columns: ["附件编号", "附件名称"], rows: [["附件一", "披露函"]] } },
    ]),
  );
  const ps = paras(xml);
  const at = (t: string) => ps.find((p) => textOf(p) === t)!;
  assert.doesNotMatch(at("（以下无正文，为《股权转让协议》签署页）"), /pageBreakBefore/, "以下无正文留在上一页");
  const first = at("受让方：上海澄远科技集团有限公司（盖章）");
  assert.match(first, /<w:pageBreakBefore\/>/, "签署页另起一页");
  for (const t of ["受让方：上海澄远科技集团有限公司（盖章）", "法定代表人或授权代表（签字）：________________", "转让方一：周牧之（签字）"]) assert.match(at(t), /w:firstLine="0"/, `“${t}”不缩进`);
  assert.doesNotMatch(at("签署日期：________年____月____日"), /KwlRight/, "合同签署行不右对齐（各方签署栏左对齐）");
  const iFirstParty = ps.indexOf(at("转让方一：周牧之（签字）"));
  assert.equal(ps[iFirstParty - 1], "<w:p/>", "各方之间空一行");
  assert.match(ps.find((p) => /KwlHeading1/.test(p) && textOf(p) === "附件")!, /<w:pageBreakBefore\/>/, "附件另起一页");
  assert.ok(extractParagraphs(Buffer.from(createDocx("x", [{ heading: "", paragraphs: ["a"] }]))).length > 0);
});

test("段内换行拆成独立段落：首部各方信息与签署块一项一行（第 35 批真实走查 R1）", async () => {
  const { createDocx, extractParagraphs, readZipEntries } = await import("../src/index.ts");
  const buf = createDocx("股权转让协议", [
    { heading: "", paragraphs: ["受让方：上海澄远科技集团有限公司\n统一社会信用代码：91310000MA1K8C7X2Q\n\n住所：上海市浦东新区"] },
    { heading: "", paragraphs: ["（以下无正文，为签署页）", "受让方：上海澄远科技集团有限公司（盖章）\n法定代表人或授权代表（签字）：________\n签署日期：____年__月__日"] },
  ]);
  const xml = readZipEntries(buf).get("word/document.xml")!.toString("utf8");
  assert.equal(/<w:t[^>]*>[^<]*\n[^<]*<\/w:t>/.test(xml), false, "文字节点里不留换行");
  const ps = extractParagraphs(buf).map((p) => p.text).filter((t) => t.trim());
  assert.deepEqual(ps.slice(1, 4), ["受让方：上海澄远科技集团有限公司", "统一社会信用代码：91310000MA1K8C7X2Q", "住所：上海市浦东新区"], "空行不另起空段");
  assert.ok(ps.includes("法定代表人或授权代表（签字）：________"));
});
