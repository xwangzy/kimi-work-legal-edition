// 第 57 批：金额勾稽检查（amount-check.ts）——算式复核、跨成果金额对账、组合。
// 真实依据：V30 劳动仲裁应对（m24）Word 工资口径表 6×34,886.49×2 写成 421,948.32、年休假追加额 8,563.23 与敞口表 8,487.12 不一致。
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAmounts, equationIssues, orphanAmountIssues, blocksOfSections, blocksOfSheets, type AmountDoc } from "../src/services/amount-check.ts";

const para = (text: string, where = "正文") => ({ paragraphs: [{ where, text }] });
const eqOf = (text: string) => equationIssues(para(text));

// ───────── A. 行内算式：该报的 ─────────

test("行内算式：乘法写错报出，expected / actual / fix 齐全", () => {
  const r = eqOf("第一段违约金为810,000×0.0005×22＝8,901元。");
  assert.equal(r.length, 1);
  assert.equal(r[0]!.kind, "equation");
  assert.equal(r[0]!.expected, 8910);
  assert.equal(r[0]!.actual, 8901);
  assert.match(r[0]!.text, /810,000×0\.0005×22＝8,901/);
  assert.match(r[0]!.fix, /左边算出来是 8,910，写的是 8,901/);
});

test("行内算式：受理费分段（加法与百分比）写错报出，写对不报", () => {
  assert.equal(eqOf("受理费50＋90,000×2.5%＋100,000×2%＋179,010×1.5%＝6,985.15元。").length, 0);
  const r = eqOf("受理费50＋90,000×2.5%＋100,000×2%＋179,010×1.5%＝7,985.15元。");
  assert.equal(r.length, 1);
  assert.equal(r[0]!.expected, 6985.15);
});

test("行内算式：加法连加写错报出（带空格与“元”）", () => {
  assert.equal(eqOf("合计192,768.32＋4,009.58＋12,768.35＝209,546.25 元。").length, 0);
  assert.equal(eqOf("合计192,768.32＋4,009.58＋12,768.35＝209,564.25 元。").length, 1);
});

test("行内算式：半角运算符、* 与 x（两数之间）都认", () => {
  assert.equal(eqOf("即 300000*0.0005*10=1,600元").length, 1);
  assert.equal(eqOf("即 300000x0.0005x10=1,500元").length, 0);
  assert.equal(eqOf("即 300000x0.0005x10=1,600元").length, 1);
  assert.equal(eqOf("差额 (510,000 - 300,000) × 2 = 420,000 元").length, 0);
  assert.equal(eqOf("差额（510,000－300,000）×2＝402,000元").length, 1);
});

test("行内算式：连等逐段比，后一段与前一段不等就报", () => {
  assert.equal(eqOf("赔偿金6×34,886.49×2＝418,637.88＝418,637.88元").length, 0);
  const r = eqOf("赔偿金6×34,886.49×2＝418,637.88＝421,948.32元");
  assert.equal(r.length, 1);
  assert.equal(r[0]!.expected, 418637.88);
  assert.equal(r[0]!.actual, 421948.32);
});

test("行内算式：单位剥掉、万元换算", () => {
  assert.equal(eqOf("6个月×34,886.49元×2＝418,637.88元").length, 0);
  assert.equal(eqOf("按50万元×2%＝10,000元计").length, 0);
  assert.equal(eqOf("按50万元×2%＝1,000元计").length, 1);
  assert.equal(eqOf("计算为2,829.04元×3天＝8,487.12元").length, 0);
  assert.equal(eqOf("计算为2,829.04元×3天＝8,563.23元").length, 1);
});

test("行内算式：除法与百分比放宽到结果的 0.5%，分位舍入不报", () => {
  assert.equal(eqOf("月均418,637.93÷12＝34,886.49元").length, 0);
  assert.equal(eqOf("日工资24,000÷21.75×3＝3,310.34元").length, 0);
  assert.equal(eqOf("30,765.805÷21.75×200%×7＝19,803.28元").length, 0);
  assert.equal(eqOf("1,103.45×3＝3,310.35元").length, 0);
  // 无除法：差 0.05 也报
  assert.equal(eqOf("6×34,886.49×2＝418,637.93元").length, 1);
  // 有除法但差得远
  assert.equal(eqOf("月均418,637.93÷12＝35,162.36元").length, 1);
});

// ───────── A. 行内算式：不该报的 ─────────

test("不报：日期、区间、条款号、比例、电话、型号、版本号", () => {
  for (const t of [
    "截止日2026-11-30，起算日2026-03-10。",
    "期间2026-11-30=2026-11-01+29日。",
    "见第1—8项，共8项。",
    "依合同第3.2条、第6.1条。",
    "双方按1:2分担。",
    "联系电话021-58881234。",
    "设备型号RC-XS-2025-118，共3台。",
    "版本1.2.3=1.2.3。",
    "按2026/11/30=2026/11/30口径。",
  ]) assert.equal(eqOf(t).length, 0, t);
});

test("不报：中文比例（万分之五）认不出整条跳过", () => {
  assert.equal(eqOf("810,000×万分之五×22＝8,000元").length, 0);
  assert.equal(eqOf("按日万分之一点七五，810,000×万分之一点七五＝100元").length, 0);
});

test("不报：带文字的混合式（月工资×2×3＝…、…÷21.75×未休天数）", () => {
  assert.equal(eqOf("赔偿金＝月工资×2×3＝6").length, 0);
  assert.equal(eqOf("月工资÷21.75×未休天数×200%＝24,196.20元").length, 0);
  assert.equal(eqOf("247个日历日÷365×全年10天－已休2天＝4.767天").length, 0);
  assert.equal(eqOf("每天2,829.04元/天×3＝9,000元/天").length, 0);
});

test("不报：约、余、不足、以上等近似词", () => {
  assert.equal(eqOf("约810,000×0.0005×22＝9,000元").length, 0);
  assert.equal(eqOf("810,000×0.0005×22＝8,900余元").length, 0);
  assert.equal(eqOf("合计不足810,000×0.0005×22＝9,000元").length, 0);
  assert.equal(eqOf("810,000×0.0005×22＝8,900元以上").length, 0);
  assert.equal(eqOf("受理费分别约50＋90,000×2.5%＝3,000元").length, 0);
});

test("不报：负数结果、左边只有一个数、右边是“万”", () => {
  assert.equal(eqOf("差额300,000－310,000＝－10,000元").length, 0);
  assert.equal(eqOf("差额300,000－310,000＝10,000元").length, 0);
  assert.equal(eqOf("本金＝310,000元").length, 0);
  assert.equal(eqOf("即12×5＝60万元的上限").length, 0);
  assert.equal(eqOf("即6×10＝60万").length, 0);
});

test("不报：千分位不规范（“1,2,3”列举）", () => {
  assert.equal(eqOf("第1,2,3×2＝5项").length, 0);
});

// ───────── A. 表格行 ─────────

test("表格行：整格算式与右邻纯数字格不符报出（m24 真实一行）", () => {
  const rows = [
    { where: "工资口径表第 1 行", cells: ["员工申请口径", "451,086.24", "37,590.52", "6×37,590.52×2", "451,086.24"] },
    { where: "工资口径表第 2 行", cells: ["台账扣款后含加班费及年终奖", "418,637.93", "35,162.36", "6×34,886.49×2", "421,948.32"] },
  ];
  const r = equationIssues({ rows });
  assert.equal(r.length, 1);
  assert.equal(r[0]!.where, "工资口径表第 2 行");
  assert.equal(r[0]!.expected, 418637.88);
  assert.equal(r[0]!.actual, 421948.32);
  assert.match(r[0]!.text, /6×34,886\.49×2｜421,948\.32/);
});

test("表格行：Excel 公式列（数字格）与结果格", () => {
  assert.equal(equationIssues({ rows: [{ where: "A1", cells: ["A1", 810000, "810000×0.0005×22", 8910] }] }).length, 0);
  assert.equal(equationIssues({ rows: [{ where: "A1", cells: ["A1", 810000, "810000×0.0005×22", 8901] }] }).length, 1);
  // 中间隔空格也认右边最近的非空格
  assert.equal(equationIssues({ rows: [{ where: "A1", cells: ["810000×0.0005×22", "", null, "8,901元"] }] }).length, 1);
});

test("表格行不报：右邻格不是纯数字、区间连字符、纯加法计数、算式在最后一格", () => {
  const rows = [
    { where: "1", cells: ["6×34,886.49×2", "见说明", "421,948.32"] },
    { where: "2", cells: ["1-8", "9"] },
    { where: "3", cells: ["3+2", "6"] },
    { where: "4", cells: ["金额", "6×34,886.49×2"] },
    { where: "5", cells: ["6个月×月工资×2", "421,948.32"] },
    { where: "6", cells: ["2026-11-30", "5"] },
    { where: "7", cells: ["6×34,886.49×2", "30%"] },
  ];
  assert.equal(equationIssues({ rows }).length, 0);
});

test("表格行：格里写了等号的按行内算式查", () => {
  assert.equal(equationIssues({ rows: [{ where: "r", cells: ["违约金", "810,000×0.0005×22＝8,901"] }] }).length, 1);
});

// ───────── B. 跨成果金额对账 ─────────

const xlsx = (rows: (string | number | null)[][], filename = "计算表.xlsx"): AmountDoc => ({ filename, kind: "xlsx", ...blocksOfSheets([{ name: "汇总", rows }]) });
const docx = (paragraphs: string[], rows: AmountDoc["rows"] = [], filename = "方案.docx"): AmountDoc => ({ filename, kind: "docx", paragraphs: paragraphs.map((text, i) => ({ where: `第 ${i + 1} 段`, text })), rows });

test("对账：没有计算表时不查", () => {
  assert.deepEqual(orphanAmountIssues({ docs: [docx(["年休假追加额8,563.23元。"])] }), []);
});

test("对账：旧数留在 Word（8,563.23 对 Excel 8,487.12）报出", () => {
  const r = orphanAmountIssues({ docs: [docx(["若认定旷工，追加敞口8,563.23元。"]), xlsx([["项目", "金额（元）"], ["年休假追加", 8487.12]])] });
  assert.equal(r.length, 1);
  assert.equal(r[0]!.kind, "orphan_amount");
  assert.equal(r[0]!.amount, 8563.23);
  assert.equal(r[0]!.where, "第 1 段");
  assert.match(r[0]!.fix, /找不到出处/);
});

test("对账：计算表、材料、本文书成立的算式里有同一个数就不报", () => {
  const sheet = xlsx([["项目", "金额（元）"], ["年休假追加", "8,487.12"]]);
  assert.equal(orphanAmountIssues({ docs: [docx(["追加敞口8,487.12元。"]), sheet] }).length, 0);
  assert.equal(orphanAmountIssues({ docs: [docx(["申请合计518,213.47元。"]), sheet], sources: ["请求合计518,213.47元"] }).length, 0);
  assert.equal(orphanAmountIssues({ docs: [docx(["加班差额为91,862.06÷3＝30,620.69元，已付合计91,862.06元。"]), sheet] }).length, 0);
});

test("对账：万元换算后比", () => {
  const sheet = xlsx([["项目", "金额（元）"], ["本息", 123456]]);
  assert.equal(orphanAmountIssues({ docs: [docx(["本息合计12.3456万元。"]), sheet] }).length, 0);
  assert.equal(orphanAmountIssues({ docs: [docx(["本息合计12.3457万元。"]), sheet] }).length, 1);
});

test("对账：整百整千、小于 1,000 的不查（约定数不是算出来的）", () => {
  const sheet = xlsx([["项目", "金额（元）"], ["x", 1]]);
  assert.equal(orphanAmountIssues({ docs: [docx(["违约金500,000元，律师费30,000元，补偿2,500元，零头999.99元。"]), sheet] }).length, 0);
});

test("对账：段内可推（连续几项之和、乘除段内整数）与全文两数加减不报", () => {
  const sheet = xlsx([["项目", "金额（元）"], ["x", 1]]);
  assert.equal(orphanAmountIssues({ docs: [docx(["本金310,000元及违约金64,205元，基数为374,205元。"]), sheet], sources: ["暂计违约金64,205元"] }).length, 0);
  assert.equal(orphanAmountIssues({ docs: [docx(["固定工资288,000元、绩效48,500元、加班费49,448.27元、年终奖36,000元，合计421,948.27元。"]), sheet], sources: ["加班费 49448.27"] }).length, 0);
  // 段内连加对不上的仍报
  assert.equal(orphanAmountIssues({ docs: [docx(["本金310,000元及违约金64,205元，基数为374,250元。"]), sheet], sources: ["暂计违约金64,205元"] }).length, 1);
  assert.equal(orphanAmountIssues({ docs: [docx(["每天2,829.04元，追加3天共8,487.12元。"]), xlsx([["项目", "金额（元）"], ["追加", 8487.12]])] }).length, 0);
  assert.equal(orphanAmountIssues({ docs: [docx(["365日口径本息6,372,493.15元。", "360日口径本息6,377,666.67元。", "两种口径差额为5,173.52元。"]), xlsx([["口径", "合计"], ["365", 6372493.15], ["360", 6377666.67]])] }).length, 0);
});

test("对账：分项之和对不上的合计仍报（v4 敞口表 474,041.45）", () => {
  const sheet = xlsx([["项目", "金额（元）"], ["赔偿金", 418637.88], ["加班", 30620.69], ["年休假", 19803.28], ["合计", 474061.85]]);
  const r = orphanAmountIssues({ docs: [docx([], [{ where: "敞口表第 2 行", columns: ["情景", "金额（元）", "前提"], cells: ["公司台账全口径", "474,041.45", "赔偿金418,637.88；加班差额30,620.69；年休假19,803.28；竞业5,000.00。"] }]), sheet] });
  assert.equal(r.length, 1);
  assert.equal(r[0]!.amount, 474041.45);
});

test("对账：不是金额的数不报（日期、案号、编号、电话、条款号、百分比、无单位的非金额列）", () => {
  const sheet = xlsx([["项目", "金额（元）"], ["x", 1]]);
  const doc = docx(
    ["（2026）沪0115民初12345号案，合同编号RC-XS-2025-118，电话021-58881234，2026年11月30日，第3.2条，年利率12.35%。", "工作年限为5年6个月4天，共1,234天。"],
    [{ where: "表第 1 行", columns: ["序号", "天数", "日期", "利率"], cells: ["1", "1,234", "2026-11-30", "12.35%"] }],
  );
  assert.equal(orphanAmountIssues({ docs: [doc, sheet] }).length, 0);
});

test("对账：表格金额列里不带“元”的纯数字格也查；非金额列不查", () => {
  const sheet = xlsx([["项目", "金额（元）"], ["x", 1]]);
  const rows = [
    { where: "表第 1 行", columns: ["情景", "金额（元）"], cells: ["追加", "8,563.23"] },
    { where: "表第 2 行", columns: ["情景", "工时"], cells: ["追加", "1,563.25"] },
  ];
  const r = orphanAmountIssues({ docs: [docx([], rows), sheet] });
  assert.equal(r.length, 1);
  assert.equal(r[0]!.where, "表第 1 行");
});

test("对账：约数不追出处", () => {
  const sheet = xlsx([["项目", "金额（元）"], ["x", 1]]);
  assert.equal(orphanAmountIssues({ docs: [docx(["案件受理费约7,975.37元；保全申请费分别约2,391.03元、3,216.03元；3,123.45元左右。"]), sheet] }).length, 0);
});

test("对账：同一金额只报一次并注明共几处；每份文书至多 12 条", () => {
  const sheet = xlsx([["项目", "金额（元）"], ["x", 1]]);
  const r = orphanAmountIssues({ docs: [docx(["追加8,563.23元。", "另见8,563.23元。"]), sheet] });
  assert.equal(r.length, 1);
  assert.match(r[0]!.where, /第 1 段（全文共 2 处）/);
  const many = Array.from({ length: 20 }, (_, i) => `第${i + 1}项${(10001.11 + i * 1013.07).toFixed(2)}元。`);
  assert.equal(orphanAmountIssues({ docs: [docx(many), sheet] }).length, 12);
});

test("对账：已有不成立算式的表格行，同行其它格不再另报", () => {
  const sheet = xlsx([["项目", "金额（元）"], ["x", 1]]);
  const rows = [{ where: "工资表第 2 行", columns: ["口径", "总额（元）", "月平均工资（元）", "公式", "赔偿金（元）"], cells: ["台账", "418,637.93", "35,162.36", "6×34,886.49×2", "421,948.32"] }];
  const r = checkAmounts({ docs: [docx([], rows), sheet] });
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0]!.kind, "equation");
});

// ───────── C. 组合与端到端 ─────────

test("组合：stats 计数与 filename", () => {
  const r = checkAmounts({
    docs: [docx(["810,000×0.0005×22＝8,910元；510,000×0.0005×74＝18,780元。", "追加8,563.23元。"]), xlsx([["项目", "金额（元）"], ["违约金", 8910]])],
  });
  assert.equal(r.stats.equations_checked, 2);
  assert.equal(r.stats.equations_failed, 1);
  assert.equal(r.stats.orphans, 1);
  assert.ok(r.stats.amounts_checked >= 2);
  assert.ok(r.issues.every((i) => i.filename === "方案.docx"));
});

test("端到端：m24 劳动仲裁应对最新版片段——抓到工资表一行与年休假旧数，不误报其余", () => {
  const sections = [
    {
      heading: "三、敞口情景与使用方式",
      paragraphs: ["以下金额均不含尚未提出的请求。"],
      table: {
        columns: ["情景", "金额（元）", "前提"],
        rows: [
          ["员工全部请求", "518,213.47", "完全按申请书五项金额。"],
          ["公司台账全口径", "474,061.85", "赔偿金418,637.88；加班差额30,620.69；年休假19,803.28；8月两项0元；竞业5,000.00。"],
          ["竞业限制解除成本（仅该项目）", "12,500.00", "以本期两个月补偿5,000.00为基础，另加三个月补偿7,500.00。"],
          ["2026年年休假可能追加部分", "8,563.23", "若8月17日至19日认定为旷工，2026年未休天数由员工主张1天变为4天；另增3天，不计入上述合计。"],
        ],
      },
    },
    {
      heading: "（一）违法解除劳动合同赔偿金",
      paragraphs: [],
      table: {
        columns: ["工资口径", "前十二个月总额（元）", "月平均工资（元）", "赔偿金公式", "赔偿金（元）"],
        rows: [
          ["员工申请口径", "451,086.24", "37,590.52", "6×37,590.52×2", "451,086.24"],
          ["台账扣款后含加班费及年终奖", "418,637.93", "35,162.36", "6×34,886.49×2", "421,948.32"],
        ],
      },
    },
    {
      heading: "赔偿金口径说明",
      paragraphs: [
        "台账构成为固定工资288,000元、绩效48,500元、加班费49,448.27元、年终奖36,000元；逐月应发合计已扣除8月旷工扣款3,310.34元，故扣款后总额为418,637.93元。仅加回该扣款时才使用421,948.27元，再加回绩效4,000元则为425,948.27元。",
        "现有二十四个月已付加班费合计91,862.06元。差额为91,862.06÷3＝30,620.69元，与申请金额一致。",
        "员工可能增加3天请求；按台账扣款后口径每天2,829.04元，追加敞口8,487.12元。",
        "9月部分如按日历天折算，金额为2,500×26÷30＋2,500＝4,666.67元。",
      ],
    },
  ];
  const sheet = xlsx([
    ["请求项", "申请金额（元）", "复核敞口（元）"],
    ["违法解除赔偿金", 451086.24, "台账扣款后418,637.88；仅加回扣款421,948.32；加回两项425,948.28"],
    ["未休年休假工资", 24196.2, "台账扣款后19,803.28；可能追加3天8,487.12"],
    ["加班费差额", 30620.69, null],
    ["公司台账全口径", 474061.85, null],
  ]);
  const doc: AmountDoc = { filename: "v5-劳动争议应对方案.docx", kind: "docx", ...blocksOfSections(sections) };
  const r = checkAmounts({ docs: [doc, sheet], sources: ["申请合计518,213.47元", "基本工资18,000元＋岗位津贴6,000元", "加班费合计 49,448.27"] });
  const eq = r.issues.filter((i) => i.kind === "equation");
  const orphans = r.issues.filter((i) => i.kind === "orphan_amount");
  assert.equal(eq.length, 1, JSON.stringify(r.issues));
  assert.equal(eq[0]!.where, "（一）违法解除劳动合同赔偿金 表格第 2 行");
  assert.deepEqual(orphans.map((o) => o.amount), [8563.23], JSON.stringify(orphans));
  assert.equal(orphans[0]!.where, "三、敞口情景与使用方式 表格第 4 行");
});

test("端到端：m05 金额测算核对清单——写对的算式都不报", () => {
  const doc = docx([
    "三段违约金：810,000×0.0005×22＝8,910元，510,000×0.0005×74＝18,870元，310,000×0.0005×266＝41,230元，合计69,010.00元。",
    "质保金未顺延时单列135,000×0.0005×17＝1,147.50元。",
    "受理费50＋90,000×2.5%＋100,000×2%＋179,010×1.5%＝6,985.15元，减半3,492.58元。",
  ]);
  const sheet = xlsx([["段", "本金", "公式", "违约金"], ["A1", 810000, "810000×0.0005×22", 8910], ["A2", 510000, "510000×0.0005×74", 18870], ["A3", 310000, "310000×0.0005×266", 41230], ["合计", null, null, 69010], ["受理费", null, null, 6985.15], ["减半", null, null, 3492.58]]);
  const r = checkAmounts({ docs: [doc, sheet] });
  assert.deepEqual(r.issues, []);
  assert.equal(r.stats.equations_checked, 8);
});

// ---- 第 57 批全量验收：开工信息与核验内部结论不进交付件 ----
import { checkDeliverable as checkDoc57 } from "../src/services/deliverable-check.ts";

test("交付前检查：【开工前已知】的份数条数、逐段挂的核验状态写进交付件时报出；正常说法不报", () => {
  const bad = checkDoc57("研究备忘录", [{ heading: "一、范围", paragraphs: ["本次指定材料为0份，本事项已确认事实为0条。", "结论一。来源与适用版本已核，条文原文已对照。", "本事项现有律师确认事实0条，以下均出自材料。"] }]);
  const kinds = bad.issues.filter((i) => i.kind === "internal_term").map((i) => i.text);
  assert.ok(kinds.some((t) => /指定材料为0份/.test(t)), JSON.stringify(bad.issues));
  assert.ok(kinds.some((t) => /确认事实/.test(t)), JSON.stringify(bad.issues));
  assert.ok(kinds.some((t) => /来源与适用版本已核/.test(t)), JSON.stringify(bad.issues));
  const ok = checkDoc57("案件进展汇报", [{ heading: "一、材料", paragraphs: ["本次收到合同、对账函等材料 4 份。", "以下事实出自材料，尚待确认。", "所引条文原文已核。"] }]);
  assert.equal(ok.issues.filter((i) => i.kind === "internal_term").length, 0, JSON.stringify(ok.issues));
});

test("交付前检查：界面动作、系统状态与填表指令进成果时报出", () => {
  const bad = checkDoc57("尽调清单", [{ heading: "清单", paragraphs: ["章程：需补勾并核对内容。", "名单为律师导入的外部查询结果。", "代号按材料原样保留。"], table: { columns: ["事项", "届满日（工具结果 · 区间 · 待律师计算）", "条文原文（三类语义失配必填）"], rows: [["排他期", "2026-11-07", "—"]] } }]);
  const n = bad.issues.filter((i) => i.kind === "internal_term").length;
  assert.ok(n >= 3, JSON.stringify(bad.issues));
  const ok = checkDoc57("尽调清单", [{ heading: "清单", paragraphs: ["章程：尚未提供。", "名单来自全国企业信用信息公示系统查询结果（2026-10-16）。"] }]);
  assert.equal(ok.issues.filter((i) => i.kind === "internal_term").length, 0, JSON.stringify(ok.issues));
});
