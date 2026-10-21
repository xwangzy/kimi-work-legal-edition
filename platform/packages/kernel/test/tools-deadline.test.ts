/**
 * calc.deadline 边界样本（v9.4 评审 S1 §6.2 第 9 项验收：与人工基准 100% 一致；只到月精度时 0 个精确日期）。
 * 每个样本的预期值均为人工推算，依据写在 why 里；节假日以 cn-holidays.ts 收录的国务院办公厅通知原文为准：
 * 2024 国办发明电〔2023〕7号；2025 国办发明电〔2024〕12号；2026 国办发明电〔2025〕7号。
 * 星期：2023-01-01 周日；2024-01-01 周一；2025-01-01 周三；2026-01-01 周四；2027-01-01 周五。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { calcDeadline, type CalcDeadlineParams } from "../src/tools/tools/deadline.ts";
import { CN_HOLIDAYS, dayStatus, isRestDay } from "../src/tools/tools/cn-holidays.ts";
import { findTool, validateParams } from "../src/tools/registry.ts";
import { LEGAL_MCP_TOOLS } from "@zr-legal/domain";

interface Sample {
  name: string;
  input: CalcDeadlineParams;
  expect: string;
  why: string;
  warnYears?: number[];
}

const civil = (start: string, unit: "day" | "month" | "year", n: number): CalcDeadlineParams => ({ start, period: { unit, n }, rule: "civil" });
const work = (start: string, n: number): CalcDeadlineParams => ({ start, period: { unit: "workday", n }, rule: "workday" });

const SAMPLES: Sample[] = [
  { name: "01 普通 15 日", input: civil("2026-03-02", "day", 15), expect: "2026-03-17", why: "03-02（周一）不计入，03-03 为第 1 日，第 15 日 03-17（周二），工作日" },
  { name: "02 普通 30 日", input: civil("2026-03-02", "day", 30), expect: "2026-04-01", why: "03-02 + 30 日 = 04-01（周三），工作日" },
  { name: "03 1 日期间：开始当日不计入", input: civil("2026-03-02", "day", 1), expect: "2026-03-03", why: "民法典第 201 条：自次日起算，第 1 日即 03-03（周二）" },
  { name: "04 末日落在周六", input: civil("2026-03-06", "day", 15), expect: "2026-03-23", why: "03-06 + 15 = 03-21（周六），休假日连续至 03-22（周日），顺延至 03-23（周一）" },
  { name: "05 末日落在周日", input: civil("2026-03-07", "day", 15), expect: "2026-03-23", why: "03-07 + 15 = 03-22（周日），顺延至 03-23（周一）" },
  { name: "06 末日落在春节长假（2026）", input: civil("2026-02-06", "day", 15), expect: "2026-02-24", why: "02-06 + 15 = 02-21（周六），春节 02-15 至 02-23 放假，顺延至 02-24（周二）" },
  { name: "07 末日落在国庆长假（2026）", input: civil("2026-09-18", "day", 15), expect: "2026-10-08", why: "09-18 + 15 = 10-03（周六），国庆 10-01 至 10-07，顺延至 10-08（周四）" },
  { name: "08 末日为长假最后一天（2025 国庆中秋八天）", input: civil("2025-09-23", "day", 15), expect: "2025-10-09", why: "09-23 + 15 = 10-08（周三），国庆中秋 10-01 至 10-08，顺延至 10-09（周四）" },
  { name: "09 末日落在端午（2026）", input: civil("2026-06-05", "day", 15), expect: "2026-06-22", why: "06-05 + 15 = 06-20（周六），端午 06-19 至 06-21，顺延至 06-22（周一）" },
  { name: "10 末日为调休上班的周六（不顺延）", input: civil("2026-02-13", "day", 15), expect: "2026-02-28", why: "02-13 + 15 = 02-28（周六），春节调休上班日，不是法定休假日" },
  { name: "11 末日为调休上班的周日（不顺延）", input: civil("2025-09-13", "day", 15), expect: "2025-09-28", why: "09-13 + 15 = 09-28（周日），国庆中秋调休上班日，不是法定休假日" },
  { name: "12 境内无住所三十日，跨年落入春节（2025）", input: civil("2024-12-30", "day", 30), expect: "2025-02-05", why: "12-30 + 30 = 2025-01-29（春节 01-28 至 02-04），顺延至 02-05（周三）" },
  { name: "13 1 月 31 日加 1 个月（平年）", input: civil("2025-01-31", "month", 1), expect: "2025-02-28", why: "到期月 2025-02 没有 31 日，取月末 02-28（周五），工作日" },
  { name: "14 1 月 31 日加 1 个月（闰年）", input: civil("2024-01-31", "month", 1), expect: "2024-02-29", why: "到期月 2024-02 没有 31 日，取月末 02-29（周四），工作日（春节 02-10 至 02-17 已过）" },
  { name: "15 2024-02-29 加 1 年", input: civil("2024-02-29", "year", 1), expect: "2025-02-28", why: "到期月 2025-02 没有 29 日，取月末 02-28（周五）" },
  { name: "16 3 月 31 日加 1 个月（小月取月末）", input: civil("2026-03-31", "month", 1), expect: "2026-04-30", why: "到期月 2026-04 没有 31 日，取 04-30（周四）；劳动节自 05-01 起，不受影响" },
  { name: "17 三年时效名义末日落在国庆", input: civil("2023-10-01", "year", 3), expect: "2026-10-08", why: "对应日 2026-10-01（周四，国庆 10-01 至 10-07），顺延至 10-08（周四）；起算年 2023 不影响末日判断" },
  { name: "18 按月计算：末日落在周日顺延", input: civil("2025-12-01", "month", 2), expect: "2026-02-02", why: "对应日 2026-02-01（周日），顺延至 02-02（周一）" },
  { name: "19 五个工作日跨周末", input: work("2026-03-05", 5), expect: "2026-03-12", why: "03-05（周四）不计入：03-06 周五①，跳过 07–08，03-09②、03-10③、03-11④、03-12⑤" },
  { name: "20 五个工作日跨劳动节并计入调休上班日", input: work("2026-04-30", 5), expect: "2026-05-11", why: "05-01 至 05-05 放假；05-06①、05-07②、05-08③、05-09（周六调休上班）④，05-10 周日跳过，05-11⑤" },
  { name: "21 五个工作日跨春节并计入调休上班日", input: work("2026-02-11", 5), expect: "2026-02-25", why: "02-12①、02-13②、02-14（周六调休上班）③，02-15 至 02-23 放假，02-24④、02-25⑤" },
  { name: "22 五个工作日跨国庆", input: work("2026-09-29", 5), expect: "2026-10-12", why: "09-30①，10-01 至 10-07 放假，10-08②、10-09③、10-10（周六调休上班）④，10-11 周日跳过，10-12⑤" },
  { name: "23 末日所在年份未收录（2027）→ warning，只按周末", input: civil("2026-12-17", "day", 15), expect: "2027-01-01", why: "12-17 + 15 = 2027-01-01（周五）；2027 年节假日未收录，只按周末判断，不顺延（实际可能是元旦假期，须律师核对）", warnYears: [2027] },
  { name: "24 未收录年份（2023）末日周六按周末顺延 → warning", input: civil("2023-03-03", "day", 15), expect: "2023-03-20", why: "03-03 + 15 = 03-18（周六），只按周末顺延至 03-20（周一）", warnYears: [2023] },
  { name: "25 工作日跨入未收录年份 → warning", input: work("2026-12-30", 5), expect: "2027-01-06", why: "12-31①，2027-01-01（周五，未收录只按周末）②，01-02–03 周末跳过，01-04③、01-05④、01-06⑤", warnYears: [2027] },
];

for (const s of SAMPLES) {
  test(`calc.deadline 样本 ${s.name}`, () => {
    const r = calcDeadline(s.input);
    assert.equal(r.deadline, s.expect, `${s.name}：${s.why}；过程：${r.steps.join(" / ")}`);
    assert.equal(r.range, null);
    assert.equal(r.start_precision, "day");
    const notCollected = r.holiday_source.years_used.filter((u) => u.status === "not_collected").map((u) => u.year);
    assert.deepEqual(notCollected, s.warnYears ?? [], "未收录年份如实列出");
    assert.equal(r.warnings.length, (s.warnYears ?? []).length);
    for (const y of s.warnYears ?? []) {
      assert.ok(r.warnings.some((w) => w === `${y} 年法定节假日未收录，只按周末顺延，须律师按当年国务院办公厅放假通知核对`), `缺少 ${y} 年 warning`);
    }
    // 过程可复核：起算日、名义末日或计数、届满日都写在过程里
    assert.ok(r.steps[0]!.includes(s.input.start), "过程第一步写起算日");
    assert.ok(r.steps.at(-1)!.includes(s.expect), "过程最后一步写届满日");
    assert.ok(r.rules.length > 0 && r.not_handled.includes("中止、中断"));
  });
}

test("calc.deadline 过程：春节顺延写明名义末日、假期区间与顺延依据", () => {
  const r = calcDeadline(civil("2026-02-06", "day", 15));
  const text = r.steps.join("\n");
  assert.match(text, /名义末日/);
  assert.match(text, /2026-02-21（周六）是法定休假日/);
  assert.match(text, /春节假期 2026-02-15 至 2026-02-23/);
  assert.match(text, /顺延：休假日至 2026-02-23 结束，以次日 2026-02-24（周二）为期间最后一日（民法典第二百零三条第一款）/);
  assert.deepEqual(r.rules.map((x) => `${x.law}${x.article}`).filter((x) => x.includes("民法典")), [
    "中华人民共和国民法典第二百条",
    "中华人民共和国民法典第二百零一条第一款",
    "中华人民共和国民法典第二百零三条",
    "中华人民共和国民法典第二百零四条",
  ]);
  const used = r.holiday_source.years_used;
  assert.equal(used.length, 1);
  assert.equal(used[0]!.status, "verified");
  assert.equal(used[0]!.doc_no, "国办发明电〔2025〕7号");
  assert.match(used[0]!.url!, /^https:\/\/www\.gov\.cn\//);
});

test("calc.deadline 过程：调休上班日写明不顺延；按月计算无对应日写明取月末并引第二百零二条", () => {
  const a = calcDeadline(civil("2026-02-13", "day", 15));
  assert.match(a.steps.join("\n"), /调休上班日（春节调休上班），不是法定休假日，不顺延/);
  const b = calcDeadline(civil("2025-01-31", "month", 1));
  assert.match(b.steps.join("\n"), /该月没有 31 日（只有 28 日），以月末日 2025-02-28（周五）为名义末日（民法典第二百零二条）/);
  assert.ok(b.rules.some((x) => x.article === "第二百零二条"));
  const c = calcDeadline(work("2026-04-30", 5));
  assert.match(c.steps.join("\n"), /计入的调休上班日：2026-05-09（周六，劳动节调休上班）/);
  assert.ok(c.rules.some((x) => x.law === "中华人民共和国行政处罚法" && x.article === "第八十五条"));
});

test("calc.deadline 只到月精度：deadline 为 null，只给区间（不补成 1 日）", () => {
  // 2026-03 + 15 日：最早按 03-01 起算 → 03-16（周一）；最晚按 03-31 起算 → 04-15（周三）
  const r = calcDeadline(civil("2026-03", "day", 15));
  assert.equal(r.deadline, null);
  assert.equal(r.start_precision, "month");
  assert.deepEqual(r.range, { earliest: "2026-03-16", latest: "2026-04-15" });
  assert.ok(r.warnings.some((w) => w.includes("起算事实只到月")));
  // 2026-01 + 1 个月：最早 01-01 → 02-01（周日）顺延 02-02；最晚 01-31 → 02 月无 31 日取 02-28（周六调休上班，不顺延）
  const m = calcDeadline(civil("2026-01", "month", 1));
  assert.equal(m.deadline, null);
  assert.deepEqual(m.range, { earliest: "2026-02-02", latest: "2026-02-28" });
  // 工作日规则同样只给区间：2026-09 + 5 个工作日
  // 最早按 09-01（周二）起算：09-02①、09-03②、09-04③，09-05–06 周末跳过，09-07④、09-08⑤
  // 最晚按 09-30（周三）起算：10-01 至 10-07 放假，10-08①、10-09②、10-10（调休上班）③，10-11 跳过，10-12④、10-13⑤
  const w = calcDeadline(work("2026-09", 5));
  assert.deepEqual(w.range, { earliest: "2026-09-08", latest: "2026-10-13" });
  assert.equal(w.deadline, null);
});

test("calc.deadline 非法输入报 validation", () => {
  const bad: unknown[] = [
    civil("2026-02-30", "day", 15), // 日期不存在
    civil("2026-13", "day", 15), // 月份不存在
    civil("2026/03/01", "day", 15), // 格式
    civil("2026", "day", 15), // 只到年不支持
    civil("2026-03-01", "day", 0), // n 非正
    civil("2026-03-01", "day", 1.5), // n 非整数
    { start: "2026-03-01", period: { unit: "week", n: 1 }, rule: "civil" }, // 单位
    { start: "2026-03-01", period: { unit: "day", n: 5 }, rule: "workday" }, // 规则与单位不一致
    { start: "2026-03-01", period: { unit: "workday", n: 5 }, rule: "civil" },
    { start: "2026-03-01", period: { unit: "day", n: 5 } }, // 缺 rule
    { start: "2026-03-01", period: { unit: "year", n: 101 }, rule: "civil" }, // 超上限
  ];
  for (const p of bad) {
    assert.throws(() => calcDeadline(p as CalcDeadlineParams), (e: any) => e.code === "validation" && e.httpStatus === 422, JSON.stringify(p));
  }
  // 注册表 schema：多余字段、缺字段、类型不符在调用前即被拒
  const schema = findTool("calc.deadline")!.inputSchema;
  validateParams(schema, civil("2026-03-01", "day", 15));
  validateParams(schema, civil("2026-03", "month", 1));
  assert.throws(() => validateParams(schema, { ...civil("2026-03-01", "day", 15), extra: 1 }), /不在 schema/);
  assert.throws(() => validateParams(schema, { start: "2026-03-01", period: { unit: "day", n: 15 } }), /rule 缺失/);
  assert.throws(() => validateParams(schema, civil("20260301", "day", 15)), /格式不符/);
  assert.throws(() => validateParams(schema, { start: "2026-03-01", period: { unit: "day", n: "15" }, rule: "civil" }), /须为整数/);
});

test("cn-holidays：收录年份均有官方来源，区间与调休日自洽", () => {
  assert.deepEqual(CN_HOLIDAYS.map((y) => y.year), [2024, 2025, 2026]);
  for (const y of CN_HOLIDAYS) {
    assert.match(y.url, /^https:\/\/www\.gov\.cn\//);
    assert.match(y.doc_no, /^国办发明电〔\d{4}〕\d+号$/);
    assert.match(y.title, new RegExp(`^国务院办公厅关于${y.year}年部分节假日安排的通知$`));
    for (const o of y.off) {
      assert.ok(o.from <= o.to && o.from.startsWith(String(y.year)) && o.to.startsWith(String(y.year)));
      assert.ok(isRestDay(o.from) && isRestDay(o.to));
    }
    for (const w of y.workdays) {
      const wd = new Date(`${w.date}T00:00:00Z`).getUTCDay();
      assert.ok(wd === 0 || wd === 6, `${w.date} 调休上班日应为周末`);
      assert.equal(dayStatus(w.date).kind, "adjusted_workday");
      assert.equal(isRestDay(w.date), false);
    }
  }
  // 通知原文合计天数核对：2025 春节 8 天、国庆中秋 8 天；2026 春节 9 天、国庆 7 天
  const days = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
  const get = (y: number, name: string) => CN_HOLIDAYS.find((x) => x.year === y)!.off.find((o) => o.name === name)!;
  assert.equal(days(get(2025, "春节").from, get(2025, "春节").to), 8);
  assert.equal(days(get(2025, "国庆节、中秋节").from, get(2025, "国庆节、中秋节").to), 8);
  assert.equal(days(get(2026, "春节").from, get(2026, "春节").to), 9);
  assert.equal(days(get(2026, "国庆节").from, get(2026, "国庆节").to), 7);
});

test("calc.deadline 在对 Agent 开放的工具清单内", () => {
  assert.ok((LEGAL_MCP_TOOLS as readonly string[]).includes("calc.deadline"));
  const t = findTool("calc.deadline")!;
  assert.equal(t.sideEffect, "read");
  assert.equal(t.resource, "pure");
  assert.equal(t.version, "1");
});
