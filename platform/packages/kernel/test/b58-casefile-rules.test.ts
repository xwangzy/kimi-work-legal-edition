/**
 * 第 58 批根因复盘 m01（整理案卷·本机规则，独立评分 15/24）：
 * - 主体 0 条：合同写“卖方（出卖人）：××有限公司”“买方（买受人）：××”，送货单写“收货单位：××”，主体规则只认“甲方／乙方／委托方……＋冒号”；
 * - 补证清单为空：只认“尚未提供”字样——合同附件“技术协议（摘录）”、微信“摘录”、合同约定的律师费都没列出来。
 * 本用例覆盖扩展后的角色词与落款盖章、三类补证缺口（摘录件／复印件、引用了却没有的文件、约定由一方承担的维权费用），正反例都写，防误报。
 * 同批也核对方法正文与独立复核清单里的通用规则（复算结论约束论证、规章制度多版本比对、披露与事实勾稽、起草前先列身份关系）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractParagraphs, readZipEntries } from "@zr-legal/docx-engine";
import { buildS2Deliverables, extractFacts, ruleGaps, sealsIn } from "../src/executor/casefile.ts";
import { reviewMessages } from "../src/services/independent-review.ts";

const parties = (text: string) => extractFacts({ document_version_id: "d", parse_version_id: "p", filename: "f.docx", text }).filter((f) => f.kind === "party").map((f) => f.normalized);
const mat = (id: string, filename: string, text: string) => ({ document_version_id: id, parse_version_id: `p${id}`, filename, sha256: "0".repeat(64), chars: text.length, quality_flags: [], text });
const build = (materials: ReturnType<typeof mat>[]) => buildS2Deliverables({ runId: "run_b58", matter: { title: "示例", client_name: null, counterparty: null, stance: "原告" }, materials, issues: [] });
const supplement = (b: ReturnType<typeof build>) => extractParagraphs(Buffer.from(b.files.find((x) => x.filename.startsWith("补证清单"))!.bytes)).map((p) => p.text).join("\n");
const sheetText = (b: ReturnType<typeof build>, prefix: string) =>
  [...readZipEntries(Buffer.from(b.files.find((x) => x.filename.startsWith(prefix))!.bytes)).entries()].filter(([k]) => /\.xml$/.test(k)).map(([, v]) => v.toString("utf8")).join("\n");
const repo = (p: string) => new URL(`../../../${p}`, import.meta.url);

const CONTRACT =
  "设备买卖合同\n卖方（出卖人）：苏州锐川精密机械有限公司\n住所：江苏省苏州市高新区鹿山路369号\n买方（买受人）：嘉兴禾丰包装科技有限公司\n" +
  "设备的技术参数、性能指标以附件一《技术协议》为准。买方应按《使用说明书》使用合格原纸。双方根据《中华人民共和国民法典》订立本合同。\n" +
  "6.3 违约方应承担守约方为实现债权而支出的律师费、诉讼费、保全费、保全担保费、鉴定费等合理费用。\n" +
  "卖方：苏州锐川精密机械有限公司（合同专用章）\n卖方代表（签字）：韩启明\n附件一　技术协议（摘录）\n| 项目 | 约定指标 |";

test("主体：买卖、租赁、委托、承揽、借款、担保等角色词都认，括注写法“卖方（出卖人）：”也认", () => {
  assert.deepEqual(parties("卖方（出卖人）：苏州锐川精密机械有限公司\n买方（买受人）：嘉兴禾丰包装科技有限公司"), ["卖方=苏州锐川精密机械有限公司", "买方=嘉兴禾丰包装科技有限公司"]);
  assert.deepEqual(
    parties("出租人：甲房产公司\n承租人：乙餐饮公司\n委托人：丙公司\n受托人：丁公司\n发包人：戊置业公司\n承包人：己建设公司\n借款人：庚某\n出借人：辛某\n保证人：壬担保公司\n出卖人：癸公司\n买受人：子公司"),
    ["出租人=甲房产公司", "承租人=乙餐饮公司", "委托人=丙公司", "受托人=丁公司", "发包人=戊置业公司", "承包人=己建设公司", "借款人=庚某", "出借人=辛某", "保证人=壬担保公司", "出卖人=癸公司", "买受人=子公司"],
  );
  assert.deepEqual(parties("收货单位：嘉兴禾丰包装科技有限公司　　收货地址：嘉兴市南湖区亚太路1288号"), ["收货单位=嘉兴禾丰包装科技有限公司"], "全角空格后的下一栏不并进名称");
  assert.deepEqual(parties("| 甲方： | 北京甲科技有限公司 |"), ["甲方=北京甲科技有限公司"], "表格里冒号与名称隔着单元格竖线");
  assert.deepEqual(parties("甲方：上海澜屹创业投资合伙企业（有限合伙）"), ["甲方=上海澜屹创业投资合伙企业（有限合伙）"], "合伙企业的“（有限合伙）”是名称的一部分");
  assert.deepEqual(parties("原告（反诉被告）：苏州锐川精密机械有限公司\n被申请人：上海澜栖智能科技有限公司"), ["原告=苏州锐川精密机械有限公司", "被申请人=上海澜栖智能科技有限公司"]);
  assert.deepEqual(parties("甲方：张三"), ["甲方=张三"], "原来认的照旧认");
});

test("主体反例：签字栏、验收人、委托代理人、跨行的空栏、通知条款里的地址都不当成主体", () => {
  assert.deepEqual(parties("卖方代表（签字）：钱志强\n买方验收人（签字）：李国栋（设备部）\n委托代理人：张律师"), []);
  assert.deepEqual(parties("甲方（盖章）：\n乙方（盖章）：\n日期："), [], "冒号后是空的，不跨行把下一栏“乙方”读成名称");
  assert.deepEqual(parties("甲方：浙江省宁波市海曙区望京路366号禾郢大厦15层\n乙方：＿＿＿＿"), [], "通知送达条款里的地址、下划线占位");
  assert.deepEqual(parties("买方应于验收后30日内支付验收款810,000元。买卖双方协商一致。"), [], "没有冒号的叙述");
});

test("落款盖章：认出函件、确认单是谁盖的章；已由角色行摘过的不重复记；证据目录“来源”写出落款", () => {
  assert.deepEqual(parties("请贵司于收到本函之日起15日内书面回复。\n嘉兴禾丰包装科技有限公司（公章）\n2026年7月15日"), ["落款盖章=嘉兴禾丰包装科技有限公司"]);
  assert.deepEqual(sealsIn("回执：以上金额属实。\n嘉兴禾丰包装科技有限公司（财务专用章）　经办：朱丽").map((s) => s.name), ["嘉兴禾丰包装科技有限公司"]);
  assert.deepEqual(sealsIn("买方（盖章）：嘉兴禾丰包装科技有限公司设备部（部门章）").map((s) => s.name), ["嘉兴禾丰包装科技有限公司"], "部门章取到公司名");
  assert.deepEqual(parties("卖方：苏州锐川精密机械有限公司（合同专用章）"), ["卖方=苏州锐川精密机械有限公司"], "角色行已摘出的不再记一条落款");
  assert.deepEqual(sealsIn("（公章）\n本合同自双方签字盖章之日起生效。我司已加盖（合同专用章见附件）"), [], "没有单位名称的章、句中提到盖章，都不算");
  const b = build([mat("d1", "05-质量异议函（对方）.docx", "关于设备质量问题的函\n嘉兴禾丰包装科技有限公司（公章）\n2026年7月15日"), mat("d2", "07-聊天记录.txt", "2025-11-20 09:12 周：3号机老卡纸。")]);
  const ev = sheetText(b, "证据目录");
  assert.match(ev, /委托人提供（待确认）；落款盖章：嘉兴禾丰包装科技有限公司/);
  assert.match(ev, /委托人提供（待确认）</, "看不出落款的照旧写待确认");
});

test("补证①：摘录件、截图、复印件列出完整件或原件；扫描件、摘要、“（部分）”付款不算", () => {
  const g = ruleGaps([
    { filename: "07-微信聊天摘录（韩启明与周宏亮）.txt", text: "微信聊天记录摘录（由韩启明手机导出，按时间排列；“韩”为韩启明）\n2025-11-20 周：3号机老卡纸。" },
    { filename: "10-项目经理任命书（复印件文字）.txt", text: "任命书" },
    { filename: "12-朋友圈截图.png.txt", text: "截图文字" },
    { filename: "01-设备买卖合同.docx", text: CONTRACT },
    { filename: "扫描件.pdf", text: "对账确认" },
    { filename: "诉讼与执行查询结果摘要.docx", text: "未发现被执行记录。" },
    { filename: "03-收款记录.xlsx", text: "| 2 | 2025-12-26 | 300000.0 | 60%验收款（部分） |\n双方同意本合同摘录部分条款作为备忘，具体以正式文本为准，本条不另行约定其他事项，特此说明。" },
  ]);
  assert.equal(g.excerpts.length, 4, g.excerpts.join("\n"));
  assert.match(g.excerpts[0]!, /《07-微信聊天摘录（韩启明与周宏亮）\.txt》是摘录件——请调取完整件（原始载体或完整导出记录）与原件/);
  assert.match(g.excerpts[1]!, /《10-项目经理任命书（复印件文字）\.txt》是复印件——请核对或调取原件/);
  assert.match(g.excerpts[2]!, /是截图——请调取原始载体或完整导出记录/);
  assert.match(g.excerpts[3]!, /《01-设备买卖合同\.docx》里的“附件一　技术协议（摘录）”只是摘录或复制件——请调取完整件与原件/);
  assert.ok(!g.excerpts.some((r) => /扫描件|查询结果摘要|收款记录/.test(r)), "扫描件、摘要、部分付款、正文长句里的“摘录”不算");
});

test("补证②：正文引用了、材料里没有的文件与附件；法律法规、文件名对得上的、本份里有附件标题的不列", () => {
  const g = ruleGaps([
    { filename: "01-设备买卖合同.docx", text: CONTRACT + "\n报价明细见附件二。验收按附件三执行。" },
    { filename: "02-送货单、验收单.docx", text: "送货单\n设备验收单\n验收结论：合格" },
    { filename: "03-合同附件三-验收标准.docx", text: "验收标准" },
    { filename: "05-质量异议函.docx", text: "我司于2025年9月12日与贵司签订《设备买卖合同》，依据《最高人民法院关于审理买卖合同纠纷案件适用法律问题的解释》，现提出《设备验收单》所载问题。" },
  ]);
  assert.equal(g.references.length, 1, g.references.join("\n"));
  assert.match(g.references[0]!, /^《01-设备买卖合同\.docx》提到《使用说明书》、附件二，本次材料里没有——与争议有关的，请调取$/);
  assert.ok(!/技术协议|民法典|附件一|附件三/.test(g.references[0]!), "附件一有标题行、附件三另有文件、法律名称都不列");
});

test("补证③：约定由一方承担的维权费用要票据；各自承担、服务费、已有发票的不列；同一费用只列一次", () => {
  const g = ruleGaps([
    { filename: "01-设备买卖合同.docx", text: CONTRACT },
    { filename: "06-催款函.docx", text: "逾期未付的，我司将要求贵司按合同第六条支付逾期付款违约金及律师费等费用。" },
  ]);
  assert.equal(g.fees.length, 1, g.fees.join("\n"));
  assert.match(g.fees[0]!, /《01-设备买卖合同\.docx》约定由一方承担律师费、保全担保费、鉴定费（“6\.3 违约方应承担守约方为实现债权而支出的律师费/);
  assert.match(g.fees[0]!, /请备齐委托合同或费用协议、发票与付款凭证/);
  assert.ok(!/诉讼费、|保全费、/.test(g.fees[0]!.split("（")[0]!), "诉讼费、保全费由法院核定，不单列");

  assert.deepEqual(ruleGaps([{ filename: "a.docx", text: "因本合同发生争议的，律师费、鉴定费由双方各自承担。" }]).fees, [], "各自承担的不列");
  assert.deepEqual(ruleGaps([{ filename: "a.docx", text: "甲方应按月向乙方支付代理费5,000元。" }]).fees, [], "没有违约、争议语境的服务费不列");
  const paid = ruleGaps([
    { filename: "01-合同.docx", text: "违约方应赔偿守约方因此支出的律师费、鉴定费。" },
    { filename: "08-律师费发票及委托代理合同.pdf", text: "发票" },
  ]).fees;
  assert.equal(paid.length, 1);
  assert.match(paid[0]!, /约定由一方承担鉴定费（/, "律师费已有发票与委托合同，只列鉴定费");
});

test("补证清单：四类合进“三、待补材料”，原有“尚未提供”一类照旧；都没有时写清只按四类查、不等于材料齐了", () => {
  const b = build([
    mat("d1", "01-设备买卖合同.docx", CONTRACT),
    mat("d7", "07-微信聊天摘录.txt", "2025-12-10 周：先付30万。"),
    mat("d9", "09-情况说明（我方）.docx", "回单原件在财务部，尚未提供给律师。"),
  ]);
  const text = supplement(b);
  assert.match(text, /《09-情况说明（我方）\.docx》提到：“回单原件在财务部，尚未提供给律师。”/);
  assert.match(text, /技术协议（摘录）/);
  assert.match(text, /《07-微信聊天摘录\.txt》是摘录件/);
  assert.match(text, /提到《使用说明书》/);
  assert.match(text, /约定由一方承担律师费/);
  assert.match(text, /以上按材料文字列出四类/);
  assert.equal(/本机|接着做|系统/.test(text), false, "不写产品用语");

  const none = supplement(build([mat("d1", "01-合同.docx", "本合同于2025年9月12日签订。买方应于验收后30日内支付验收款810,000元。")]));
  assert.match(none, /这四类这次都没有发现——不等于材料齐了/);
  assert.equal(/本机|接着做|系统/.test(none), false);
});

test("独立复核（意见类，含尽调）清单有“披露与事实勾稽”一条", () => {
  const m = reviewMessages({ kind: "opinion", stance: "投资方", jurisdiction: "中国大陆", asOf: "2026-11-09", goal: "尽调发现与报告", materials: [], docs: [] });
  const all = m.map((x) => x.content).join("\n");
  assert.match(all, /披露与事实勾稽：材料里的概括性说法（财务报表附注的或有事项与关联方披露/);
  assert.match(all, /矛盾而交付件没有指出的，写出两处原文与出处，列为必须改/);
});

test("方法正文：劳动两条、尽调勾稽、起草身份关系的通用规则写了适用前提", () => {
  const read = (p: string) => readFileSync(repo(`content/skills/${p}`), "utf8");
  for (const id of ["labor-arbitration-draft", "labor-dispute"]) {
    const body = read(`${id}/SKILL.md`);
    assert.match(body, /规章制度多版本逐版比对/, id);
    assert.match(body, /并列条件逐支拆开/, id);
    assert.match(body, /劳动争议解释（一）第(?:五十| 50 )条/, id);
    assert.match(body, /复算结论约束/, id);
    assert.match(body, /只差尾数取整的也算一致/, id);
    assert.ok((body.match(/\*\*适用前提\*\*/g) ?? []).length >= 2, `${id}：两条规则都写了适用前提`);
  }
  const dd = read("due-diligence/SKILL.md");
  assert.match(dd, /\*\*披露与事实勾稽\*\*/);
  assert.match(dd, /“披露勾稽”：对照组/);
  assert.match(dd, /一组两边的材料本次都有才比/);
  assert.match(read("due-diligence/references/dd-modules.md"), /## 四、披露与事实勾稽对照组/);
  const cd = read("contract-draft/SKILL.md");
  assert.match(cd, /先列各方身份关系，再选清单行/);
  const ck = read("contract-draft/references/drafting-checklist.md");
  assert.match(ck, /\*\*适用前提：各方是相互独立的当事人\*\*/);
  assert.match(ck, /创始人、董事、高管或关联方把资产（专利、技术、软件、商标、股权）转入公司/);
  assert.match(ck, /民法典第六百五十八条第一款/);
});
