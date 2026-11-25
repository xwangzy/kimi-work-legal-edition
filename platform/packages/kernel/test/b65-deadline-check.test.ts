/**
 * 第 65 批：期限表届满日复算（services/deadline-check.ts）。
 * - 跨国庆写早一天的研读表（Excel 与 Word 两种）报出，改对后不再报（回看时重跑即据此判断落实）；
 * - 依据列为空的履约台账报出；
 * - 法院指定的举证期限、起算日待确认、向前数的期限、起算规则不清的约定期限都不报；
 * - 正确的行不报；同一格并列自然日与工作日两种口径的，各自对上即可；
 * - 放假安排尚未公布的年份：只受周末影响的仍是必须改，前后两周有法定节日的降为提示。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AmountDoc, AmountRow } from "../src/services/amount-check.ts";
import { blocksOfSections } from "../src/services/amount-check.ts";
import { checkDeadlines, deadlineFindings, runDeadlineIssues, scanPeriods, statuteRefs } from "../src/services/deadline-check.ts";
import { MACHINE_BASIS } from "../src/executor/amount-reconcile.ts";

const sheet = (filename: string, name: string, columns: string[], rows: string[][]): AmountDoc => ({
  filename,
  kind: "xlsx",
  rows: rows.map((cells, i): AmountRow => ({ where: `${name} 第 ${i + 2} 行`, columns, cells })),
});

const RULING_COLS = ["期限", "起算事实与出处", "届满日", "依据", "要做的动作", "提醒"];
const APPEAL_BASIS = "《中华人民共和国民事诉讼法》第一百七十一条第一款";

test("研读表：上诉期名义末日落在国庆假期，届满日写早一天 → 必须改；改对后不再报", () => {
  const wrong = sheet("判项与期限核对表.xlsx", "期限", RULING_COLS, [
    ["我方上诉期", "2026-09-18 判决书电子送达我方代理人", "2026-10-07", APPEAL_BASIS, "向一审法院递交上诉状", "送达当日不计入"],
    ["对方上诉期", "2026-09-20 判决书邮寄送达对方", "2026-10-08", APPEAL_BASIS, "跟踪对方是否上诉", ""],
    ["裁定上诉期", "2026-09-25 收到驳回管辖异议的裁定书", "2026-10-08", "民事诉讼法第一百七十一条第二款", "递交上诉状", ""],
  ]);
  const issues = checkDeadlines([wrong]);
  assert.equal(issues.length, 1, JSON.stringify(issues, null, 1));
  const i = issues[0]!;
  assert.equal(i.must, true);
  assert.equal(i.filename, "判项与期限核对表.xlsx");
  assert.match(i.where, /期限 第 2 行“届满日”栏/);
  assert.match(i.problem, /写的是 2026-10-07，按起算日 2026-09-18、期间 15 日（上诉期，判决；民事诉讼法第一百七十一条第一款）复算是 2026-10-08/);
  assert.match(i.problem, /名义末日 2026-10-03 是法定休假日（国庆节）/);
  assert.match(i.fix, /届满日改为 2026-10-08/);
  assert.match(i.key, /^deadline\|判项与期限核对表\.xlsx\|我方上诉期\|2026-10-07$/);
  // 修改后重跑：标识消失即落实
  const fixed = sheet("判项与期限核对表.xlsx", "期限", RULING_COLS, [["我方上诉期", "2026-09-18 判决书电子送达我方代理人", "2026-10-08", APPEAL_BASIS, "向一审法院递交上诉状", ""]]);
  assert.deepEqual(checkDeadlines([fixed]), []);
});

test("研读报告 Word 表格（中文日期写法）同样报出", () => {
  const blocks = blocksOfSections([
    { heading: "一、裁判要旨", paragraphs: ["一审判决支持原告全部诉讼请求。"] },
    {
      heading: "六、期限与下一步",
      table: {
        columns: ["期限或事项", "起算事实与出处", "届满日", "依据与动作", "提醒"],
        rows: [
          ["我方上诉期", "判决于2026年9月18日电子送达我方代理人；送达当日不计入", "2026年10月7日", `${APPEAL_BASIS}；向一审法院递交上诉状`, "预留交费时间"],
          ["申请执行期间（条件测算）", "如以2026年11月30日为判决规定履行期间的最后一日", "2028年11月30日（仅条件示例）", "《中华人民共和国民事诉讼法》第二百五十条；准备执行申请", "临近届满复核"],
        ],
      },
    },
  ]);
  const issues = checkDeadlines([{ filename: "裁判文书研读报告.docx", kind: "docx", ...blocks }]);
  assert.equal(issues.length, 1, JSON.stringify(issues, null, 1));
  assert.equal(issues[0]!.must, true);
  assert.match(issues[0]!.where, /六、期限与下一步 表格第 1 行/);
  assert.match(issues[0]!.problem, /写的是 2026-10-07.*复算是 2026-10-08/);
});

test("履约台账：届满日有日期而依据一栏为空 → 必须改；依据齐全且算对的行不报", () => {
  const ledger = sheet("义务与期限台账.xlsx", "义务与期限台账", ["序号", "义务方", "义务内容", "履行期限或条件", "依据", "起算事实", "届满日", "计算过程"], [
    ["1", "买方", "支付第一期货款", "验收合格且收到发票之日起60日内", "", "2026-10-23验收合格", "2026-12-22", "10月24日为第1日，12月22日为第60日"],
    ["2", "买方", "到货检验并书面提出异议", "到货之日起7日内", "第5.1款", "2026-10-20到货", "2026-10-27", "10月21日为第1日，10月27日为第7日"],
    ["3", "卖方", "收到退货通知后更换", "收到通知之日起10日内", "第5.2款", "2026-10-27通知到达指定邮箱", "2026-11-06", "10月28日为第1日，11月6日为第10日"],
  ]);
  const issues = checkDeadlines([ledger]);
  assert.equal(issues.length, 1, JSON.stringify(issues, null, 1));
  const i = issues[0]!;
  assert.equal(i.must, true);
  assert.match(i.where, /义务与期限台账 第 2 行“届满日”栏/);
  assert.match(i.problem, /届满日写了 2026-12-22，同一行“依据”栏是空的/);
  assert.match(i.key, /^deadline-basis\|/);
});

test("法院指定的举证期限、开庭时间不复算", () => {
  const t = sheet("管辖与时效核查表.xlsx", "程序期限", ["节点", "起算事实", "期间", "依据", "届满日", "计算过程", "以何为准"], [
    // 故意写成与“次日起 15 日”不同的日子：由通知书定，不报
    ["提交证据材料", "2026年11月3日签收举证通知书", "收到通知书之次日起15日内", "举证通知书第二项（法院指定）", "2026-11-17", "按通知书载明计算", "法院举证通知书"],
    ["开庭审理", "传票指定2026年12月9日9时30分", "法院指定开庭时点", "传票", "2026-12-09 09:30", "直接采用传票载明日期", "传票"],
  ]);
  assert.deepEqual(checkDeadlines([t]), []);
});

test("起算日待确认、向前数、起算规则不清的约定期限：不报", () => {
  const t = sheet("期限表.xlsx", "程序期限", ["节点", "起算事实", "期间", "依据", "届满日", "计算过程"], [
    ["提交答辩状", "起诉状副本送达日待确认（暂按2026-11-03）", "收到之日起15日内", "《中华人民共和国民事诉讼法》第一百二十八条", "2026-11-17", "暂按11月3日"],
    ["预计迟延的书面通知", "2026-10-10交货日向前数5日", "提前5日书面通知", "第3.2款", "2026-10-05", "向前数不顺延"],
    ["供货商补货", "2026-11-02收到补货要求", "15日内补货", "合同第8.1条", "2026-11-16", "按合同约定"],
  ]);
  assert.deepEqual(checkDeadlines([t]), []);
});

test("同一格并列日历日与工作日两种口径：各自对上不报，工作日口径写错的报出", () => {
  const cols = ["事项", "起算事实", "届满日或支付日", "申请或处理情况", "依据"];
  const basis = "调解仲裁法第三十条；办案规则第三十三、八十条";
  const ok = sheet("提交前核对清单.xlsx", "期限与时效", cols, [["答辩期", "2026-10-30收到申请书副本", "日历日保守口径2026-11-09；工作日口径2026-11-13", "立即提交", basis]]);
  assert.deepEqual(checkDeadlines([ok]), []);
  const bad = sheet("提交前核对清单.xlsx", "期限与时效", cols, [["答辩期", "2026-10-30收到申请书副本", "日历日保守口径2026-11-09；工作日口径2026-11-12", "立即提交", basis]]);
  const issues = checkDeadlines([bad]);
  assert.equal(issues.length, 1, JSON.stringify(issues, null, 1));
  assert.match(issues[0]!.problem, /写的是 2026-11-12.*10 个工作日.*复算是 2026-11-13/);
});

test("放假安排尚未公布的年份：只受周末影响的仍必须改；前后两周有法定节日的降为提示", () => {
  const cols = ["请求", "时效类型", "起算事实", "精度", "期间规则", "届满日", "计算过程"];
  const t = sheet("管辖与时效核查表.xlsx", "诉讼时效", cols, [
    // 名义末日 2028-12-03 是周日，应顺延至 12-04；写成名义末日
    ["验收款余额", "一般三年", "2025-12-03验收款付款期届满", "具体日", "《中华人民共和国民法典》第188、200—204条", "2028-12-03", "2025-12-03不计入，自次日起算三年"],
  ]);
  const a = checkDeadlines([t]);
  assert.equal(a.length, 1, JSON.stringify(a, null, 1));
  assert.equal(a[0]!.must, true);
  assert.match(a[0]!.problem, /复算是 2028-12-04（名义末日 2028-12-03 是法定休假日（周日）/);

  // 2027 年国庆：名义末日 10-02 落在法定节日，复算只按法定节日与周末顺延到 10-04，实际放假安排可能更长——写 10-08 只列提示
  const r = sheet("判项与期限核对表.xlsx", "期限", RULING_COLS, [["我方上诉期", "2027-09-17 判决书送达", "2027-10-08", APPEAL_BASIS, "", ""]]);
  const b = checkDeadlines([r]);
  assert.equal(b.length, 1, JSON.stringify(b, null, 1));
  assert.equal(b[0]!.must, false);
  assert.match(b[0]!.problem, /放假安排尚未公布/);
});

test("分段计算表（起算日（含）/ 截止日（含）/ 日数）不是期限表", () => {
  const calc = sheet("计算明细.xlsx", "分段计算", ["序号", "款项", "起算日（含）", "截止日（含）", "日数", "金额（元）"], [["1", "验收款违约金", "2025-12-04", "2026-11-30", "362", "56,115.00"]]);
  assert.deepEqual(checkDeadlines([calc]), []);
});

test("条号与期间的识别：民诉法解释不当成民诉法；日期、年份、条款号里的数字不当成期间", () => {
  assert.deepEqual(statuteRefs("最高人民法院关于适用《中华人民共和国民事诉讼法》的解释第一百七十一条"), [{ law: "MSJ", article: 171, para: null }]);
  assert.deepEqual(statuteRefs(APPEAL_BASIS), [{ law: "MS", article: 171, para: 1 }]);
  assert.deepEqual(scanPeriods("第三项2025年年休假；每月15日前付上一月度；10月竞业补偿").periods, []);
  assert.deepEqual(scanPeriods("收到之日起十五日内").periods, [{ unit: "day", n: 15, rule: "civil" }]);
  assert.equal(scanPeriods("届满七日前申请续行").unsupported, true);
});

test("复核意见：依据一栏为系统复算、带 machine_key；读库出错时返回空", () => {
  const wrong = sheet("判项与期限核对表.xlsx", "期限", RULING_COLS, [["我方上诉期", "2026-09-18 判决书送达", "2026-10-07", APPEAL_BASIS, "", ""]]);
  const issues = checkDeadlines([wrong]);
  const f = deadlineFindings(issues, 4);
  assert.equal(f.length, 1);
  assert.equal(f[0]!.no, 4);
  assert.equal(f[0]!.basis, MACHINE_BASIS);
  assert.equal(f[0]!.machine_key, issues[0]!.key);
  assert.equal(f[0]!.level, "must");
  assert.match(f[0]!.where, /^《判项与期限核对表\.xlsx》期限 第 2 行/);
  const broken = { db: { all: () => { throw new Error("db closed"); } }, blobs: {} } as unknown as Parameters<typeof runDeadlineIssues>[0];
  assert.deepEqual(runDeadlineIssues(broken, "run_x", "mat_x"), []);
});
