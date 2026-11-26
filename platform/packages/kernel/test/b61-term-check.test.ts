/**
 * 第 61 批（V35，D-262）法律用语与胜诉率预测的确定性检查：低误报规则（外部评估 R1 legal-terminology、R4 legal-judgment-prediction），
 * 每条有正反两例；引号、书名号里的原话不报。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { termIssues, docTypeOf } from "../src/services/term-check.ts";
import { checkDeliverable } from "../src/services/deliverable-check.ts";

const P = (...ts: string[]) => ts.map((text, i) => ({ where: `第 ${i + 1} 段`, text }));
const fixes = (title: string, ...ts: string[]) => termIssues(title, P(...ts), { asOf: "2026-11-24" });

test("文书类型识别", () => {
  assert.equal(docTypeOf("民事起诉状"), "complaint");
  assert.equal(docTypeOf("劳动仲裁申请书"), "labor_arbitration");
  assert.equal(docTypeOf("仲裁申请书"), "arbitration");
  assert.equal(docTypeOf("民事上诉状"), "appeal");
  assert.equal(docTypeOf("强制执行申请书"), "enforcement");
  assert.equal(docTypeOf("法律研究备忘录"), null);
});

test("T1 法人代表：报；法定代表人、引号里的原话不报", () => {
  assert.equal(fixes("法律意见书", "公司法人代表张某签字确认。").length, 1);
  assert.equal(fixes("法律意见书", "公司法定代表人张某签字确认。").length, 0);
  assert.equal(fixes("质证意见", "对方证据载明“法人代表签字”字样。").length, 0);
});

test("T2 首部称谓与文书类型：起诉状写申请人、仲裁写原告、上诉状写不带原审的原告报；正确写法与正文叙述不报", () => {
  assert.equal(fixes("民事起诉状", "申请人：苏州锐川精密机械有限公司", "被申请人：常州恒岳纸品有限公司", "诉讼请求：").filter((i) => i.fix.includes("称谓")).length, 2);
  assert.equal(fixes("仲裁申请书", "原告：苏州锐川精密机械有限公司", "仲裁请求：").filter((i) => i.fix.includes("称谓")).length, 1);
  assert.equal(fixes("民事上诉状", "上诉人（原审原告）：苏州锐川精密机械有限公司", "被上诉人（原审被告）：常州恒岳纸品有限公司", "上诉请求：").length, 0);
  assert.equal(fixes("民事上诉状", "原告：苏州锐川精密机械有限公司", "上诉请求：").filter((i) => i.fix.includes("称谓")).length, 1);
  assert.equal(fixes("民事起诉状", "原告：甲公司", "被告：乙公司", "诉讼请求：", "被告在仲裁中作为申请人提出过反请求。").length, 0, "请求之后的叙述不查");
});

test("T3 仲裁文书写判令、诉状写裁决被告：报", () => {
  assert.equal(fixes("劳动仲裁申请书", "申请人：韩某", "仲裁请求：", "一、判令被申请人支付经济补偿金。").filter((i) => i.fix.includes("裁决")).length, 1);
  assert.equal(fixes("劳动仲裁申请书", "仲裁请求：", "一、请求裁决被申请人支付经济补偿金。").length, 0);
  assert.equal(fixes("民事起诉状", "诉讼请求：", "一、裁决被告支付货款。").length, 1);
});

test("T4 劳动仲裁写诉讼时效：报；写仲裁时效不报", () => {
  assert.equal(fixes("劳动仲裁答辩书", "申请人的请求已超过诉讼时效。").length, 1);
  assert.equal(fixes("劳动仲裁答辩书", "申请人的请求已超过仲裁时效（劳动争议调解仲裁法第二十七条）。").length, 0);
});

test("T5 分公司、合伙企业首部写法定代表人：报；公司写法定代表人不报", () => {
  assert.equal(fixes("民事起诉状", "被告：上海某贸易有限公司苏州分公司，住所地苏州市。", "法定代表人：王某，总经理。", "诉讼请求：").filter((i) => i.fix.includes("负责人")).length, 1);
  assert.equal(fixes("民事起诉状", "被告：某某咨询中心（有限合伙），法定代表人：李某。", "诉讼请求：").filter((i) => i.fix.includes("执行事务合伙人")).length, 1);
  assert.equal(fixes("民事起诉状", "被告：上海某贸易有限公司，住所地上海市。", "法定代表人：王某，执行董事。", "诉讼请求：").length, 0);
});

test("T6 已废止法只写法名：报；写原《》或时间效力说明不报", () => {
  assert.equal(fixes("法律意见书", "依据《中华人民共和国合同法》的规定，违约方应当赔偿损失。").length, 1);
  assert.equal(fixes("法律意见书", "合同签订于 2019 年，行为发生时有效的原《中华人民共和国合同法》对此有规定。").length, 0);
});

test("T7 递交法院的文书以九民纪要为依据：报；内部稿不查", () => {
  assert.equal(fixes("民事起诉状", "诉讼请求：", "根据《全国法院民商事审判工作会议纪要》第36条，请求判令被告返还。").length, 1);
  assert.equal(fixes("研究备忘录", "根据《全国法院民商事审判工作会议纪要》第36条，法院应当释明。").length, 0);
});

test("P1 胜诉率与概率：报；风险高低的定性评估不报", () => {
  assert.equal(fixes("案情分析备忘录", "本案胜诉率约为70%。").filter((i) => i.kind === "prediction").length, 1);
  assert.equal(fixes("案情分析备忘录", "法院大概率支持违约金调减。").filter((i) => i.kind === "prediction").length, 1);
  assert.equal(fixes("案情分析备忘录", "有八成把握获得支持。").filter((i) => i.kind === "prediction").length, 1);
  assert.equal(fixes("案情分析备忘录", "违约金调减的风险较高，主要理由是约定日万分之五超过损失的百分之三十。").filter((i) => i.kind === "prediction").length, 0);
  assert.equal(fixes("案情分析备忘录", "利率按年 3.45% 计算。").length, 0);
  // 第 58 批 48 卡回放的 4 处误报：否定句声明边界
  assert.equal(fixes("案情分析备忘录", "本稿不评估胜诉率，不预测裁判结果。").length, 0);
  assert.equal(fixes("案情分析备忘录", "仅提出建议，不评估胜诉率。").length, 0);
});

test("接入交付前检查：kind 为 term / prediction", () => {
  const r = checkDeliverable("案情分析备忘录", [{ heading: "风险", paragraphs: ["本案胜诉率约为70%。", "公司法人代表张某签字。"] }]);
  assert.ok(r.issues.some((i) => i.kind === "prediction"));
  assert.ok(r.issues.some((i) => i.kind === "term"));
});

test("T8 中文日期前导零；内部用语“任务说明所述”“本机离线法规库”（第 61 批真实验收 m08、m20 评分）", () => {
  assert.equal(fixes("民事上诉状", "暂计至2026年11月09日。").filter((i) => i.fix.includes("前导零")).length, 1);
  assert.equal(fixes("民事上诉状", "2026年03月起。").filter((i) => i.fix.includes("前导零")).length, 1);
  assert.equal(fixes("民事上诉状", "暂计至2026年11月9日，合同编号RC-2025-0901。").length, 0);
  const r = checkDeliverable("研究备忘录-检验期", [{ heading: "范围", paragraphs: ["按任务说明所述的时点研究。", "资料范围为本机离线法规库。"] }]);
  assert.ok(r.issues.filter((i) => i.kind === "internal_term").length >= 2, JSON.stringify(r.issues));
});

test("第 65 批：期望收益、胜率、概率加权、盖然性百分比、“很可能（70%）”都拦；成本测算的支持比例、回收比例不拦", async () => {
  const { termIssues } = await import("../src/services/term-check.ts");
  const hit = (t: string) => termIssues("测算说明", [{ where: "第 1 段", text: t }]).filter((i) => i.kind === "prediction").length;
  assert.equal(hit("期望收益 = 500,000 × 70% − 152,600 = 197,400 元。"), 1);
  assert.equal(hit("经评估胜率较高。"), 1);
  assert.equal(hit("按概率加权后的回收约 30 万元。"), 1);
  assert.equal(hit("法院支持的盖然性约 80%。"), 1);
  assert.equal(hit("法院很可能（70%）支持本金。"), 1);
  assert.equal(hit("如只支持本金（支持比例 69.66%）、回收比例 50%，净回收 120,000 元。"), 0);
  assert.equal(hit("本测算不给胜率或期望值。"), 0);
});

test("第 65 批：撤销仲裁裁决申请书写“判令”按法院裁定改；劳动关系存续期间不受时效限制须限定劳动报酬；特殊普通合伙不写法定代表人", async () => {
  const { termIssues } = await import("../src/services/term-check.ts");
  const a = termIssues("撤销仲裁裁决申请书", [{ where: "第 3 段", text: "请求判令撤销上海仲裁委员会（2026）沪仲案字第88号裁决。" }]);
  assert.ok(a.some((i) => /裁定/.test(i.fix) && !/改为“裁决”/.test(i.fix)));
  const b = termIssues("劳动争议研究备忘录", [{ where: "第 2 段", text: "劳动关系存续期间发生的争议，劳动者申请仲裁不受仲裁时效期间的限制。" }]);
  assert.equal(b.filter((i) => /第二十七条第四款/.test(i.fix)).length, 1);
  const c = termIssues("劳动争议研究备忘录", [{ where: "第 2 段", text: "劳动关系存续期间因拖欠劳动报酬发生争议的，不受一年仲裁时效期间的限制。" }]);
  assert.equal(c.filter((i) => /第二十七条第四款/.test(i.fix)).length, 0);
  const d = termIssues("民事起诉状", [{ where: "第 1 段", text: "原告：上海某某律师事务所（特殊普通合伙），住所地上海市。" }, { where: "第 2 段", text: "法定代表人：张三，主任。" }, { where: "第 3 段", text: "诉讼请求：" }]);
  assert.ok(d.some((i) => /执行事务合伙人|负责人/.test(i.fix)));
});

test("第 65 批：效力性 / 管理性二分不配第十六条报回；此致后的机构与文书类型不符报回", async () => {
  const { termIssues } = await import("../src/services/term-check.ts");
  const a = termIssues("研究备忘录", [{ where: "第 1 段", text: "该规定属于管理性强制性规定，违反不导致合同无效。" }]);
  assert.equal(a.filter((i) => /第十六条/.test(i.fix)).length, 1);
  assert.equal(termIssues("研究备忘录", [{ where: "第 1 段", text: "按合同编通则解释第十六条，该规定属于管理性规定的传统分类已不再单独决定效力。" }]).filter((i) => /第十六条/.test(i.fix)).length, 0);
  const paras = (to: string) => [{ where: "第 1 段", text: "请求事项" }, { where: "第 9 段", text: "此致" }, { where: "第 10 段", text: to }];
  assert.equal(termIssues("劳动仲裁申请书", paras("上海市浦东新区人民法院")).filter((i) => /此致/.test(i.fix)).length, 1);
  assert.equal(termIssues("劳动仲裁申请书", paras("上海市浦东新区劳动人事争议仲裁委员会")).filter((i) => /此致/.test(i.fix)).length, 0);
  assert.equal(termIssues("民事起诉状", paras("苏州市虎丘区人民法院")).filter((i) => /此致/.test(i.fix)).length, 0);
  assert.equal(termIssues("民事起诉状", paras("苏州仲裁委员会")).filter((i) => /此致/.test(i.fix)).length, 1);
  assert.equal(termIssues("仲裁申请书", paras("宁波仲裁委员会")).filter((i) => /此致/.test(i.fix)).length, 0);
});
