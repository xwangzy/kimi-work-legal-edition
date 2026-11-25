/**
 * 第 65 批（V39，D-290）复核意见推翻律师已确认论点所依据的文件时降为“建议改”、交律师决定。
 * 用例取自真实运行 v39-m25 的复核第 1 条（三批同一模式：要求删去律师已确认的“以 2021 版手册为主依据”）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { confirmedDocuments, downgradeAgainstConfirmed } from "../src/services/review-vs-outline.ts";
import type { ReviewFinding } from "../src/services/independent-review.ts";

const args = [
  {
    claim: "申请人连续旷工三日，符合《员工手册（2021版）》第5.3条第（5）项规定的解除情形，解除合法",
    texts: ["中华人民共和国劳动合同法", "规章制度须履行民主程序并公示或告知；2021版的程序与签收记录符合该路径。", "2023版未经民主程序，不作为本案旷工解除的直接依据", "《员工手册（2021版）》经职工大会讨论、与工会协商后发布"],
  },
];
const f = (no: number, problem: string, fix: string, extra: Partial<ReviewFinding> = {}): ReviewFinding => ({ no, where: "答辩书", problem, basis: "材料", fix, must: true, level: "must", ...extra });

test("已确认论点所依据的非法规文件只取书名号里的文件名，法律法规不算", () => {
  assert.deepEqual(confirmedDocuments([...args, { claim: "依据《中华人民共和国劳动合同法》第三十九条", texts: ["《最高人民法院关于审理劳动争议案件适用法律问题的解释（一）》"] }]), ["员工手册（2021版）"]);
});

test("复核要求删除律师已确认的依据（v39-m25 原文）：降为建议改、写明交律师决定", () => {
  const r = downgradeAgainstConfirmed(
    [f(1, "以《员工手册（2021版）》作为2026年旷工解除的主依据，未处理该版已被明确废止及解除通知未援引该版的问题，现有论证不能成立", "删除“本案旷工解除的主依据为2021版”及可直接适用该版的表述，围绕解除通知已经载明的理由和现有证据重新组织合法解除论证，不得以已废止的2021版为依据")],
    args,
  );
  assert.deepEqual(r.downgraded, [1]);
  const x = r.findings[0]!;
  assert.equal(x.must, false);
  assert.equal(x.level, "should");
  assert.match(x.problem, /与律师已确认的论点冲突/);
  assert.match(x.fix, /员工手册（2021版）/);
});

test("不降级：条号或引文更正、金额问题、没有推翻依据取舍的意见、机器核对出的意见", () => {
  const r = downgradeAgainstConfirmed(
    [
      f(1, "《员工手册（2021版）》第5.3条第（5）项引文与材料不一致", "按材料02原文逐字改正引文"),
      f(2, "依据写成劳动合同法第三十八条，应为第三十九条", "改为劳动合同法第三十九条第（二）项"),
      f(3, "赔偿金按13个月平均工资计算错误", "按前十二个月平均工资重算"),
      f(4, "员工手册（2021版）在这里作为依据，核对清单写不作为依据", "统一口径", { machine_key: "role|手册@2021|答辩书", basis: "系统复算（确定性核对，不是模型判断）" }),
    ],
    args,
  );
  assert.deepEqual(r.downgraded, []);
  assert.ok(r.findings.every((x) => x.must));
});

test("没有确认过的提纲（或提纲里没有文件依据）时原样返回", () => {
  const one = [f(1, "不得以《员工手册（2021版）》为依据", "删除该依据")];
  assert.deepEqual(downgradeAgainstConfirmed(one, []).downgraded, []);
  assert.deepEqual(downgradeAgainstConfirmed(one, [{ claim: "被告应支付货款", texts: ["中华人民共和国民法典"] }]).downgraded, []);
});

test("v39-m25-r3 原文：写成“2021版手册”也认出；要求先补足论证的仍为必须改，但修改轮不得自行换依据", () => {
  const r = downgradeAgainstConfirmed(
    [f(1, "将2021版手册作为2026年解除的主依据，却未处理该版已被明确废止的问题，续订合同中的“确认已阅知”也不能直接推出该版仍属现行规章制度", "补足2021版在行为时仍可适用或已被续订合同具体纳入的法律依据与事实链条，并说明其与解除通知援引2023版的关系；不能补强的，不再将2021版作为独立主依据，改用在行为时有效且构成要件能够落实的解除依据。")],
    args,
  );
  assert.deepEqual(r.downgraded, []);
  assert.equal(r.findings[0]!.must, true);
  assert.match(r.findings[0]!.fix, /不改变依据的取舍/);
});

test("写成“2021版手册”的无条件推翻同样降级", () => {
  const r = downgradeAgainstConfirmed([f(2, "2021版手册已废止，不能作为本案依据", "不再将2021版手册作为解除依据，改依2023版第5.3条")], args);
  assert.deepEqual(r.downgraded, [2]);
});

test("v39-m25-r4 原文：确认卡写“2021版手册”（无书名号）也认出；改法先要求删除依据的降为建议改、交律师决定", () => {
  const r4args = [{ claim: "解除合法", texts: ["直接适用第三十九条第（二）项；连续三日旷工满足2021版条款的第一支，不以2023版作为直接依据。", "2021版手册规定连续旷工3日以上（含）属于严重违纪", "2021版员工手册规定，连续旷工3日以上（含）或一年内累计旷工5日以上属于可解除情形。"] }];
  assert.ok(confirmedDocuments(r4args).some((d) => /手册（2021版）/.test(d)));
  const r = downgradeAgainstConfirmed(
    [f(1, "将已经废止的2021版员工手册作为2026年解除行为的直接、主要制度依据，且解除通知当时援引的是2023版手册，现有论证不能由“2021版曾经民主制定并签收”直接推出其在争议行为发生时仍是有效解除依据", "删除以2021版作为行为时现行、直接解除依据及由此得出的当然合法结论，同步调整清单第9项和证据2的证明目的；继续坚持连续三日旷工成立，围绕未经完整审批、收到否决通知后仍连续三日不到岗补强论证。若仍主张2021版在2023版废止后仍可适用，须核验依据并补足论证；无法补强的，删去该论点")],
    r4args,
  );
  assert.deepEqual(r.downgraded, [1]);
  assert.equal(r.findings[0]!.must, false);
});

test("v39-m25-r5 评分：推翻部分交律师、补强部分拆出来照常必须改（不整条降级）", () => {
  const r4args = [{ claim: "解除合法", texts: ["2021版员工手册规定，连续旷工3日以上（含）属于可解除情形。"] }];
  const r = downgradeAgainstConfirmed(
    [f(1, "将已经废止的2021版员工手册作为解除依据，未回应废止与解除通知援引2023版的问题", "删除以2021版作为行为时现行、直接解除依据的结论；继续坚持连续三日旷工成立，围绕收到否决通知后仍连续三日不到岗补强论证。若仍主张2021版在2023版废止后仍可适用，须核验依据并补足论证；无法补强的，删去该论点")],
    r4args,
  );
  assert.deepEqual(r.downgraded, [1]);
  assert.equal(r.findings.length, 2);
  const kept = r.findings[1]!;
  assert.equal(kept.no, 2);
  assert.equal(kept.must, true);
  assert.match(kept.fix, /不改变依据/);
  assert.match(kept.fix, /补强论证/);
  assert.match(kept.fix, /补足论证/);
  assert.doesNotMatch(kept.fix, /删除以2021版|删去该论点/);
});
