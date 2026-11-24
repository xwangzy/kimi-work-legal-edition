/**
 * 第 61 批（V35，D-258）案号溯源：产品没有案例库，案号的存在性离线核不了；但律师引用的案例来自他上传到事项里的裁判文书——
 * 成果里的案号须能在本事项材料（或任务说明、律师作答）里找到，找不到的当场报回；占位案号报回；归到判决名下的引文须能在材料里逐字找到。
 * 签发门禁语义不变（仍须律师勾选“已逐个核对案号”），签发页只多告诉律师每个案号该对照哪份材料、哪些在材料里根本没有。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openLawdb } from "@zr-legal/lawdb";
import { createDocx } from "@zr-legal/docx-engine";
import { buildCaseIndex, caseProvenance, caseQuoteIssues, caseRefsIn, normalizeCaseNo, placeholderCaseRefs, CASE_NOT_IN_MATERIALS_FIX, CASE_PLACEHOLDER_FIX, CASE_QUOTE_FIX } from "../src/services/case-provenance.ts";
import { checkDeliverable } from "../src/services/deliverable-check.ts";
import { artifactCitationBlock, checkArtifactCitations } from "../src/services/artifact-citations.ts";
import { LAWDB_SHIPPED } from "./helpers.ts";

const signerPub = JSON.parse(readFileSync(fileURLToPath(new URL("../../../content/keys/content-signing-dev.pub.json", import.meta.url)), "utf8")).publicKeyPem;
const lawdb = openLawdb(LAWDB_SHIPPED, { expectedSignerPubPem: signerPub });

const JUDGMENT = [
  "江苏省苏州市中级人民法院",
  "民事判决书",
  "（2025）苏05民终6612号",
  "本院认为，买受人在约定的检验期限内未就产能提出异议，又签署验收单，应视为标的物质量符合约定。买受人主张减价，应当举证证明标的物存在隐蔽瑕疵。",
].join("\n");
const OLD = "最高人民法院民事判决书（2015）民二终字第00123号 本院认为，……";
const INDEX = buildCaseIndex(
  [
    { filename: "类案1-（2025）苏05民终6612号判决书.docx", text: JUDGMENT },
    { filename: "类案2-旧判决.pdf", text: OLD },
  ],
  ["本案一审案号（2026）苏0505民初4417号"],
);

test("案号提取：法院与仲裁两种写法；文号、非案号不算", () => {
  const t = "参见（2025）苏05民终6612号、(2023)最高法民申1234号与京劳人仲字[2026]第1234号；依据法释〔2020〕17号；见（2024）年度报告第3号。";
  const raws = caseRefsIn(t).map((r) => r.raw);
  assert.ok(raws.includes("（2025）苏05民终6612号"));
  assert.ok(raws.includes("(2023)最高法民申1234号"));
  assert.ok(raws.some((r) => r.endsWith("[2026]第1234号") && r.includes("仲")));
  assert.ok(!raws.some((r) => r.includes("17号")), "司法解释文号不是案号");
  assert.ok(!raws.some((r) => r.includes("年度报告")), "没有案件类型代字的不是案号");
});

test("归一化：全半角括号、空白、“第”“字”不计", () => {
  assert.equal(normalizeCaseNo("（2015）民二终字第123号"), normalizeCaseNo("(2015) 民二终123号"));
  assert.equal(normalizeCaseNo("（２０２５）苏０５民终６６１２号"), normalizeCaseNo("(2025)苏05民终6612号"));
});

test("溯源：材料里有的写明出处；任务说明里律师给的算有出处；凭记忆写的报找不到", () => {
  const text = "可参照（2025）苏05民终6612号判决；本案一审（2026）苏0505民初4417号；另有（2024）最高法民终888号持相同观点。";
  const items = caseProvenance(text, INDEX);
  assert.equal(items.length, 3);
  assert.match(items[0]!.source ?? "", /类案1/);
  assert.equal(items[1]!.source, "任务说明或你的回答");
  assert.equal(items[2]!.source, null);
  // 旧式写法：材料“第00123号”，成果写“第00123号”的半角版本
  assert.match(caseProvenance("（2015）民二终字第00123号", INDEX)[0]!.source ?? "", /旧判决/);
});

test("占位案号报回；【待填】不报", () => {
  assert.equal(placeholderCaseRefs("撤销（20××）苏0505民初××号民事判决").length, 1);
  assert.equal(placeholderCaseRefs("撤销（2026）某中院民终XX号民事判决").length, 1);
  assert.equal(placeholderCaseRefs("案号：【待填】；（2026）苏0505民初4417号").length, 0);
});

test("引文比对：归到判决名下的引文须能在材料里逐字找到（标点空白不计）", () => {
  const ok = "（2025）苏05民终6612号判决认为：“买受人在约定的检验期限内未就产能提出异议，又签署验收单，应视为标的物质量符合约定”。";
  assert.equal(caseQuoteIssues(ok, INDEX).length, 0);
  const bad = "（2025）苏05民终6612号判决认为：“买受人签署验收单后，出卖人对产能不再承担任何责任，买受人不得主张减价”。";
  const issues = caseQuoteIssues(bad, INDEX);
  assert.equal(issues.length, 1);
  assert.match(issues[0]!.quote, /出卖人对产能不再承担/);
  // 省略号分段，每段都在原文里
  const ellipsis = "（2025）苏05民终6612号判决指出：“买受人在约定的检验期限内未就产能提出异议……买受人主张减价，应当举证证明标的物存在隐蔽瑕疵”。";
  assert.equal(caseQuoteIssues(ellipsis, INDEX).length, 0);
  // 没有引出语的引号（例如紧接着引的是法条）不核
  assert.equal(caseQuoteIssues("（2025）苏05民终6612号。民法典第六百二十一条规定“当事人约定检验期限的，买受人应当在检验期限内将标的物的数量或者质量不符合约定的情形通知出卖人”。", INDEX).length, 0);
});

test("交付前检查：对外文书里材料中没有的案号、占位案号、对不上原文的引文都报回；有出处的不报", () => {
  const sections = [
    {
      heading: "上诉理由",
      paragraphs: [
        "一审判决（2026）苏0505民初4417号认定事实错误。",
        "同类案件（2025）苏05民终6612号判决认为：“买受人在约定的检验期限内未就产能提出异议，又签署验收单，应视为标的物质量符合约定”。",
        "最高人民法院（2024）最高法民终888号判决亦持相同观点。",
        "（2025）苏05民终6612号判决还认为：“出卖人对产能不再承担任何责任，买受人不得主张减价”。",
        "撤销（20××）苏0505民初××号判决。",
      ],
    },
  ];
  const r = checkDeliverable("民事上诉状", sections, { caseIndex: INDEX });
  const cites = r.issues.filter((i) => i.kind === "citation");
  assert.ok(cites.some((i) => i.text.includes("最高法民终888号") && i.fix === CASE_NOT_IN_MATERIALS_FIX));
  assert.ok(cites.some((i) => i.fix === CASE_QUOTE_FIX && i.text.includes("出卖人对产能")));
  assert.ok(cites.some((i) => i.fix === CASE_PLACEHOLDER_FIX));
  assert.ok(!cites.some((i) => i.text.includes("4417号") && i.fix === CASE_NOT_IN_MATERIALS_FIX), "律师在任务说明里给的本案案号不报");
  assert.ok(!cites.some((i) => i.text.startsWith("（2025）苏05民终6612号") && i.fix === CASE_NOT_IN_MATERIALS_FIX), "材料里有的案号不报");
  // 没给索引（例如问答、无事项）时不做溯源，占位案号照报
  const r2 = checkDeliverable("民事上诉状", sections);
  assert.ok(!r2.issues.some((i) => i.fix === CASE_NOT_IN_MATERIALS_FIX));
  assert.ok(r2.issues.some((i) => i.fix === CASE_PLACEHOLDER_FIX));
});

test("签发页：案号逐个写明对照哪份材料、材料里没有的单独计数；签发门禁不变（仍须勾选已核对案号）", () => {
  const docx = createDocx("类案检索报告", [{ heading: "类案", paragraphs: ["（2025）苏05民终6612号判决可资参照。", "（2024）最高法民终888号判决亦可参照。"] }] as any);
  const c = checkArtifactCitations(lawdb, "类案检索报告.docx", docx, "2026-11-24", {}, INDEX);
  const cases = c.items.filter((i) => i.kind === "case");
  assert.equal(cases.length, 2);
  assert.match(cases.find((i) => i.raw.includes("6612"))!.reason ?? "", /类案1/);
  assert.match(cases.find((i) => i.raw.includes("888"))!.reason ?? "", /材料里没有这个案号/);
  assert.equal(c.cases_unsourced, 1);
  assert.equal(artifactCitationBlock(c, {})?.code, "case");
  assert.equal(artifactCitationBlock(c, { citations_cases_checked: true }), null);
  // 不传索引时与改动前一致
  const c0 = checkArtifactCitations(lawdb, "类案检索报告.docx", docx, "2026-11-24");
  assert.equal(c0.cases_unsourced, undefined);
  assert.match(c0.items.find((i) => i.kind === "case")!.reason ?? "", /离线/);
});

test("法院名下的引文：本院认为、一审判决认定后加引号的，须能在材料里逐字找到；隐私代号当作通配", async () => {
  const { courtQuoteIssues, quoteInMaterials } = await import("../src/services/case-provenance.ts");
  const idx = buildCaseIndex([{ filename: "一审判决书.docx", text: "本院认为，锐川公司虽对该报告有异议，但未申请司法鉴定，应当承担举证不能的不利后果。苏州锐川精密机械有限公司负担1,500.00元。" }]);
  assert.equal(courtQuoteIssues("一审法院认为“锐川公司虽对该报告有异议，但未申请司法鉴定，应当承担举证不能的不利后果”，属举证责任分配错误。", idx).length, 0);
  assert.equal(courtQuoteIssues("一审判决认定“锐川公司已经认可检测报告的全部结论，应当承担不利后果”。", idx).length, 1);
  assert.equal(courtQuoteIssues("双方在合同中约定“验收合格后60日内支付尾款”。", idx).length, 0, "不是归到法院名下的引文不核");
  assert.ok(quoteInMaterials("〔机构·KX92PA〕负担1,500.00元", { byKey: new Map(), texts: [{ filename: "x", norm: "苏州锐川精密机械有限公司负担1500.00元".replace(/[，,。．.]/g, "") }] }), "代号处切开后各段在材料里");
});

test("法院名下引文的续写：“判决原文：‘……’又认定：‘……’”“同段：‘……’”逐段核对（第 61 批真实验收 v35-L2-caselaw-r3 语序改动未被核到）", async () => {
  const { courtQuoteIssues } = await import("../src/services/case-provenance.ts");
  const idx = buildCaseIndex([{ filename: "（2025）苏05民终1234号.docx", text: "本院认为，该确认单不能证明设备性能已经检验合格。恒睿公司在签署确认单后第二十三日即书面提出异议，此后再次书面催告。" }]);
  // 真实成果原文（Word 与 Excel 两处）：第二段把“签署确认单后”写成“确认单签署后”
  const word = "决定性理由：判决原文：“该确认单不能证明设备性能已经检验合格。”又认定：“恒睿公司在确认单签署后第二十三日即书面提出异议，此后再次书面催告。”";
  const cell = "“本院认为—关于焦点一”段：“该确认单不能证明设备性能已经检验合格。”同段：“恒睿公司在确认单签署后第二十三日即书面提出异议，此后再次书面催告。”";
  for (const x of [word, cell]) {
    const got = courtQuoteIssues(x, idx);
    assert.equal(got.length, 1, x);
    assert.match(got[0]!.quote, /^恒睿公司在确认单签署后/);
  }
  // 两段都照原文的不报；续写的不是引号（转述）不核
  assert.equal(courtQuoteIssues("判决原文：“该确认单不能证明设备性能已经检验合格。”又认定：“恒睿公司在签署确认单后第二十三日即书面提出异议，此后再次书面催告。”", idx).length, 0);
  assert.equal(courtQuoteIssues("判决原文：“该确认单不能证明设备性能已经检验合格。”又认为买受人在合理期限内提出了异议。", idx).length, 0);
  // 前一段不是法院名下的引文，后面的“又……”不跟着核
  assert.equal(courtQuoteIssues("合同约定：“验收合格后六十日内支付尾款百分之三十。”又约定：“质保期为确认单签署后十二个月整。”", idx).length, 0);
});

test("表格“原文摘录”类列逐格核对：去掉条款编号与位置说明后须在材料里；写“未见”“未约定……条款”的不核；“摘录”列（法条要点）不核", async () => {
  const { quoteColumnIssues } = await import("../src/services/case-provenance.ts");
  const idx = buildCaseIndex([{ filename: "增资协议.docx", text: "乙方应在全部先决条件满足之日起3个工作日内向甲方交付交割确认函及相应证明文件。\n乙方应在交割日起30日内完成本次增资的市场监督管理部门变更登记。" }]);
  const t = (col: string, cells: string[]) => [{ name: "交割清单", columns: ["序号", col], rows: cells.map((c, i) => [i + 1, c]) }];
  assert.equal(quoteColumnIssues(t("原文", ["4.2 乙方应在全部先决条件满足之日起3个工作日内向甲方交付交割确认函及相应证明文件。", "第7.1条：乙方应在交割日起30日内完成本次增资的市场监督管理部门变更登记。", "未见", "合同未约定知识产权侵权保障条款。"]), idx).length, 0);
  const bad = quoteColumnIssues(t("原文摘录（逐字）", ["市场监督管理部门变更登记（注册资本、章程、董事备案） | 乙方 | 交割日后20个工作日内"]), idx);
  assert.equal(bad.length, 1);
  assert.equal(quoteColumnIssues(t("摘录", ["连带债务由法律规定或当事人约定"]), idx).length, 0);
});
