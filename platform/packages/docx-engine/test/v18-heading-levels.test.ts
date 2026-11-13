/**
 * V18 首轮 B11：出文书的节标题支持二、三级（sections[].level，缺省 1）。原先每节标题一律按一级排，
 * 备忘录里“（一）……”“争点二：”与“五、诉讼风险”同为一级，导航窗格与目录看不出层次。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createDocx, headingKindOf, readZipEntries } from "../src/index.ts";

const doc = (buf: Buffer) => readZipEntries(buf).get("word/document.xml")!.toString("utf8");
const styleOf = (buf: Buffer, text: string) => {
  const p = doc(buf).match(/<w:p\b[\s\S]*?<\/w:p>/g)!.find((x) => (x.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, "")).join("") === text);
  return p ? (/<w:pStyle w:val="([^"]+)"/.exec(p)?.[1] ?? null) : null;
};

test("层级取值：2、3 为二、三级；缺省、1、越界、非整数一律按一级", () => {
  assert.equal(headingKindOf(undefined), "h1");
  assert.equal(headingKindOf(1), "h1");
  assert.equal(headingKindOf(2), "h2");
  assert.equal(headingKindOf(3), "h3");
  assert.equal(headingKindOf("2"), "h2");
  for (const bad of [0, 4, 2.5, -1, null, "二", {}]) assert.equal(headingKindOf(bad), "h1", String(bad));
});

test("三级标题各一节：样式依次是一、二、三级标题；三级节下的小标题排三级", () => {
  const buf = createDocx("案情分析备忘录", [
    { heading: "四、争点与证据强弱", paragraphs: ["本部分按争点逐一分析。"] },
    { heading: "（一）付款条件是否成就", level: 2, paragraphs: ["合同约定验收合格后付款。"] },
    { heading: "1. 验收是否完成", level: 3, paragraphs: ["材料显示已签署验收单。", "（一）验收单的效力"] },
    { heading: "五、诉讼风险", level: 1, paragraphs: ["风险较低。"] },
  ]);
  assert.equal(styleOf(buf, "四、争点与证据强弱"), "KwlHeading1");
  assert.equal(styleOf(buf, "（一）付款条件是否成就"), "KwlHeading2");
  assert.equal(styleOf(buf, "1. 验收是否完成"), "KwlHeading3");
  assert.equal(styleOf(buf, "五、诉讼风险"), "KwlHeading1");
  assert.equal(styleOf(buf, "（一）验收单的效力"), "KwlHeading3", "二三级节下段落里的小标题排三级");
  assert.equal(styleOf(buf, "材料显示已签署验收单。"), "KwlBody");
  // 三级标题样式确实在样式表里（大纲级别 2）
  const styles = readZipEntries(buf).get("word/styles.xml")!.toString("utf8");
  assert.match(styles, /w:styleId="KwlHeading3"[\s\S]*?<w:outlineLvl w:val="2"\/>/);
});

test("缺省层级与旧入参：正文 XML 逐字节相同（level 1 与不写 level 也相同）；一级节下的段落小标题仍排二级", () => {
  const sections = [
    { heading: "一、基本事实", paragraphs: ["双方于2026年3月1日签订合同。", "（一）合同的签订"] },
    { heading: "二、分析意见", paragraphs: ["被告应当付款。"], table: { columns: ["项目", "金额"], rows: [["本金", "100,000.00"]] } },
  ];
  const a = createDocx("研究备忘录-付款", sections);
  const b = createDocx("研究备忘录-付款", sections.map((s) => ({ ...s, level: 1 })));
  assert.equal(doc(a), doc(b));
  assert.equal(styleOf(a, "（一）合同的签订"), "KwlHeading2");
  assert.equal(styleOf(a, "二、分析意见"), "KwlHeading1");
});

test("应用内预览认本产品的标题样式：标题居中、一二三级标题各有层级（此前都排成普通段落）", async () => {
  const { renderDocxHtml } = await import("../src/render-html.ts");
  const buf = createDocx("案情分析备忘录", [
    { heading: "四、争点与证据强弱", paragraphs: ["本部分按争点逐一分析。"] },
    { heading: "（一）付款条件是否成就", level: 2, paragraphs: ["合同约定验收合格后付款。"] },
    { heading: "1. 验收是否完成", level: 3, paragraphs: ["材料显示已签署验收单。"] },
  ]);
  const { html } = renderDocxHtml(buf);
  assert.match(html, /<h2 class="kwl-title">[^<]*案情分析备忘录/);
  assert.match(html, /<h2>[^<]*四、争点与证据强弱<\/h2>/);
  assert.match(html, /<h3>[^<]*（一）付款条件是否成就<\/h3>/);
  assert.match(html, /<h4>[^<]*1\. 验收是否完成<\/h4>/);
  assert.match(html, /<p>[^<]*本部分按争点逐一分析。<\/p>/);
});

test("落款后接附页（标题 + 一段说明 + 表）：落款照样右对齐，附页另起一页（V18 第 43 批真实回归：起诉状落款被排成正文）", () => {
  const buf = createDocx("民事起诉状", [
    { heading: "事实与理由", paragraphs: ["被告未按约付款。", "此致", "宁波市鄞州区人民法院", "附：本诉状副本1份。", "具状人：杭州某某幕墙工程有限公司（盖章）", "法定代表人：（签名）", "日期：      年    月    日"] },
    { heading: "违约金计算明细", paragraphs: ["下列金额均暂计至2026年11月10日（含当日），此后按同一标准计算至实际清偿之日止。"], table: { columns: ["项目", "金额"], rows: [["结算款违约金", "270,861.33"]] } },
  ]);
  assert.equal(styleOf(buf, "具状人：杭州某某幕墙工程有限公司（盖章）"), "KwlRight");
  assert.equal(styleOf(buf, "法定代表人：（签名）"), "KwlRight");
  assert.equal(styleOf(buf, "此致"), "KwlBody");
  const h = doc(buf).match(/<w:p\b[\s\S]*?<\/w:p>/g)!.find((x) => x.includes("违约金计算明细"))!;
  assert.match(h, /<w:pageBreakBefore\/>/, "附页另起一页");
});

test("没有落款的文书：文末的“小标题 + 说明 + 表”不加分页（照旧）", () => {
  const buf = createDocx("尽调报告", [
    { heading: "一、结论", paragraphs: ["目标公司存在三项重大风险。"] },
    { heading: "二、发现汇总", paragraphs: ["下表按严重程度排列。"], table: { columns: ["序号", "发现"], rows: [["1", "关联担保未披露"]] } },
  ]);
  const h = doc(buf).match(/<w:p\b[\s\S]*?<\/w:p>/g)!.find((x) => x.includes("二、发现汇总"))!;
  assert.equal(/<w:pageBreakBefore\/>/.test(h), false);
});

test("落款后接“附：……”清单再接附页：落款照样右对齐（V18 第 43 批真实回归：强制执行申请书）", () => {
  const buf = createDocx("强制执行申请书", [
    { heading: "事实与理由", paragraphs: ["被执行人至今未履行。", "此致", "江苏省苏州市虎丘区人民法院", "申请执行人：苏州某某精密机械有限公司（盖章）", "法定代表人：________________", "日期：______年____月____日", "附：执行依据副本【待填】份；生效证明【待填】份；身份证明与授权材料【待填】份；付款凭证复印件【待填】份。"] },
    { heading: "执行标的计算", paragraphs: ["计算截止日：2026年11月30日。计息采用算头不算尾口径。", "逾期付款损失依判决第二项计算。"], table: { columns: ["序号", "项目"], rows: [["1", "货款本金"]] } },
  ]);
  for (const t of ["申请执行人：苏州某某精密机械有限公司（盖章）", "法定代表人：________________", "日期：______年____月____日"]) assert.equal(styleOf(buf, t), "KwlRight", t);
  assert.equal(styleOf(buf, "江苏省苏州市虎丘区人民法院"), "KwlBody");
  assert.equal(styleOf(buf, "附：执行依据副本【待填】份；生效证明【待填】份；身份证明与授权材料【待填】份；付款凭证复印件【待填】份。"), "KwlBody");
});

test("落款行的两种常见写法也认：“法定代表人或授权代理人：”“委托诉讼代理人（签名）：”（V18 第 43 批真实回归：答辩状、代理词）", () => {
  const a = createDocx("民事答辩状", [{ heading: "答辩意见", paragraphs: ["请求驳回原告全部诉讼请求。", "此致", "嘉兴市南湖区人民法院", "答辩人：苏州某某精密机械有限公司（盖章）", "法定代表人或授权代理人：（签名）", "年　月　日", "附：答辩状副本1份；证据目录及证据1套。"] }]);
  for (const t of ["答辩人：苏州某某精密机械有限公司（盖章）", "法定代表人或授权代理人：（签名）", "年　月　日"]) assert.equal(styleOf(a, t), "KwlRight", t);
  const b = createDocx("代理词", [{ heading: "代理意见", paragraphs: ["综上，请依法支持原告诉讼请求。", "此致", "苏州市虎丘区人民法院", "委托诉讼代理人（签名）：____________", "年　　月　　日"] }]);
  for (const t of ["委托诉讼代理人（签名）：____________", "年　　月　　日"]) assert.equal(styleOf(b, t), "KwlRight", t);
  assert.equal(styleOf(b, "苏州市虎丘区人民法院"), "KwlBody");
});
