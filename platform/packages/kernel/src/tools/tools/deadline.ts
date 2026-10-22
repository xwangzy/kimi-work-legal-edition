/**
 * calc.deadline — 法定期间计算（确定性；v9.4 评审 S1 §6.2 第 9 项）。
 *
 * 规则 civil（民法典第二百条至第二百零四条；民事诉讼法期间条文同一口径）：
 * - 开始的当日不计入，自下一日开始计算（第二百零一条第一款）；
 * - 按日计算：起算事实发生日 + N 日为名义末日；
 * - 按月、年计算：到期月的对应日为最后一日；没有对应日的，月末日为最后一日（第二百零二条）。
 *   “对应日”取起算事实发生日的日序（如 3 月 10 日知道权利受损，三年时效名义末日为三年后的 3 月 10 日）；
 * - 最后一日是法定休假日的，以法定休假日结束的次日为最后一日（第二百零三条第一款）；按日计算的期间同样适用。
 *   “法定休假日”= 周六周日公休日 + 法定节假日；调休上班的周六周日不是休假日（实务通说，待核：个别法院对调休日
 *   是否顺延有不同把握，律师对关键期限应以不依赖调休日为宜）。
 * 规则 workday（法律明确规定按工作日计算的期间，如行政处罚法第六十四条“告知后五日内”、第八十五条）：
 * - 开始的当日不计入（参照期间计算的一般规则，待核）；自次日起逐日计数，跳过周末与法定节假日、计入调休上班日；
 *   第 N 个工作日即为最后一日（工作日本身不是休假日，无需再顺延）。
 *
 * 不处理：诉讼时效中止、中断，在途时间、扣除期间、按小时计算的期间、当事人约定的特别计算方法（第二百零四条），
 * 民族自治地方的地方性假日——发生这些事由时由律师给出新的起算事实或改按约定后重算。
 * 只到月的起算事实不补成某月 1 日：只给区间（最早 = 按该月 1 日算，最晚 = 按该月末日算）。
 */
import { DomainError } from "@zr-legal/domain";
import { dayStatus, holidaySource, holidayYear, isRestDay, weekdayOf } from "./cn-holidays.ts";

export type DeadlineUnit = "day" | "month" | "year" | "workday";
export type DeadlineRule = "civil" | "workday";

export interface CalcDeadlineParams {
  start: string; // YYYY-MM-DD 或 YYYY-MM
  period: { unit: DeadlineUnit; n: number };
  rule: DeadlineRule;
}

export interface DeadlineRuleRef {
  law: string;
  article: string;
  point: string;
}

export interface HolidayYearUse {
  year: number;
  status: "verified" | "not_collected";
  title?: string;
  doc_no?: string;
  url?: string;
  verified_on?: string;
}

export interface CalcDeadlineResult {
  rule: DeadlineRule;
  start: string;
  start_precision: "day" | "month";
  period: { unit: DeadlineUnit; n: number };
  /** 日精度起算时给出；只到月时为 null（看 range）。 */
  deadline: string | null;
  range: { earliest: string; latest: string } | null;
  steps: string[];
  rules: DeadlineRuleRef[];
  holiday_source: {
    table: string;
    years_covered: number[];
    years_used: HolidayYearUse[];
  };
  warnings: string[];
  not_handled: string;
}

const UNITS: readonly DeadlineUnit[] = ["day", "month", "year", "workday"];
const MAX_N: Record<DeadlineUnit, number> = { day: 36_600, month: 1_200, year: 100, workday: 1_000 };
const WEEKDAY = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;
const MS_DAY = 86_400_000;

function bad(msg: string): never {
  throw new DomainError("validation", `calc.deadline: ${msg}`, 422);
}

function ymd(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * MS_DAY).toISOString().slice(0, 10);
}

function wd(date: string): string {
  return `${date}（${WEEKDAY[weekdayOf(date)]}）`;
}

function cnMonth(y: number, m: number): string {
  return `${y} 年 ${m} 月`;
}

/** 一天为何是休假日（写进过程，律师可复核）。 */
/** 未收录年份的警告（v9.4 复核 Q1-01、Q1-03：按规则区分“顺延”与“计数”，写明已按固定日期假日处理、哪些仍未知）。 */
export function notCollectedWarning(year: number, rule: DeadlineRule): string {
  const how = rule === "workday" ? "只跳过周末与放假办法规定的固定日期假日（元旦、劳动节、国庆）计数" : "只按周末与放假办法规定的固定日期假日（元旦、劳动节、国庆）顺延";
  return `${year} 年放假安排未收录：${how}，春节、清明、端午、中秋与调休未知，须律师按当年国务院办公厅放假通知核对`;
}

function restReason(date: string): string {
  const s = dayStatus(date);
  if (s.kind === "holiday") return `${s.name}假期 ${s.span!.from} 至 ${s.span!.to}`;
  if (s.kind === "weekend") return `${WEEKDAY[weekdayOf(date)]}公休日${s.covered ? "" : "（该年节假日安排未收录）"}`;
  return "";
}

interface OneRun {
  deadline: string;
  steps: string[];
  years: Set<number>;
}

function runCivil(start: string, unit: Exclude<DeadlineUnit, "workday">, n: number): OneRun {
  const steps: string[] = [];
  const years = new Set<number>();
  steps.push(`起算事实发生日 ${wd(start)}：开始的当日不计入，自次日 ${addDays(start, 1)} 起算（民法典第二百零一条第一款）`);
  let nominal: string;
  if (unit === "day") {
    nominal = addDays(start, n);
    steps.push(`按日计算 ${n} 日：${addDays(start, 1)} 为第 1 日，第 ${n} 日为 ${wd(nominal)}，即名义末日（期间内的休假日照常计入）`);
  } else {
    const months = unit === "year" ? n * 12 : n;
    const sy = Number(start.slice(0, 4));
    const sm = Number(start.slice(5, 7));
    const sd = Number(start.slice(8, 10));
    const idx = sy * 12 + (sm - 1) + months;
    const ty = Math.floor(idx / 12);
    const tm = (idx % 12) + 1;
    const last = daysInMonth(ty, tm);
    const label = unit === "year" ? `${n} 年` : `${n} 个月`;
    if (sd <= last) {
      nominal = ymd(ty, tm, sd);
      steps.push(`按${unit === "year" ? "年" : "月"}计算 ${label}：到期月为 ${cnMonth(ty, tm)}，对应日为 ${sd} 日，名义末日 ${wd(nominal)}（民法典第二百零二条）`);
    } else {
      nominal = ymd(ty, tm, last);
      steps.push(`按${unit === "year" ? "年" : "月"}计算 ${label}：到期月为 ${cnMonth(ty, tm)}，该月没有 ${sd} 日（只有 ${last} 日），以月末日 ${wd(nominal)}为名义末日（民法典第二百零二条）`);
    }
  }
  years.add(Number(nominal.slice(0, 4)));
  let d = nominal;
  if (!isRestDay(d)) {
    const s = dayStatus(d);
    steps.push(
      s.kind === "adjusted_workday"
        ? `名义末日 ${wd(d)}是调休上班日（${s.name}），不是法定休假日，不顺延`
        : `名义末日 ${wd(d)}是工作日${s.covered ? "" : "（该年节假日安排未收录，只按周末与放假办法固定日期假日判断）"}，不顺延`,
    );
  } else {
    const reasons: string[] = [];
    while (isRestDay(d)) {
      const r = restReason(d);
      if (!reasons.includes(r)) reasons.push(r);
      d = addDays(d, 1);
      years.add(Number(d.slice(0, 4)));
    }
    steps.push(`名义末日 ${wd(nominal)}是法定休假日（${reasons.join("；")}）`);
    steps.push(`顺延：休假日至 ${addDays(d, -1)} 结束，以次日 ${wd(d)}为期间最后一日（民法典第二百零三条第一款）`);
    // 顺延后落在调休上班的周末：写明不再顺延（v9.4 复核 Q1-02；调用方另给警告）
    if (dayStatus(d).kind === "adjusted_workday") steps.push(`${wd(d)}是调休上班日（${dayStatus(d).name}），不是法定休假日，不再顺延`);
  }
  steps.push(`期间届满日：${wd(d)}，当日二十四时截止；有业务时间的，以停止业务活动的时间为截止时间（民法典第二百零三条第二款）`);
  return { deadline: d, steps, years };
}

function runWorkday(start: string, n: number): OneRun {
  const steps: string[] = [];
  const years = new Set<number>();
  steps.push(`起算事实发生日 ${wd(start)}：开始的当日不计入，自次日 ${addDays(start, 1)} 起逐日计数`);
  const counted: string[] = [];
  const skipped: string[] = [];
  const adjusted: string[] = [];
  let d = start;
  while (counted.length < n) {
    d = addDays(d, 1);
    years.add(Number(d.slice(0, 4)));
    const s = dayStatus(d);
    if (s.kind === "holiday" || s.kind === "weekend") {
      skipped.push(`${d} ${s.kind === "holiday" ? s.name : WEEKDAY[weekdayOf(d)]}`);
      continue;
    }
    counted.push(d);
    if (s.kind === "adjusted_workday") adjusted.push(`${d}（${WEEKDAY[weekdayOf(d)]}，${s.name}）`);
  }
  if (n <= 15) steps.push(`计入的工作日：${counted.map((x, i) => `第 ${i + 1} 日 ${wd(x)}`).join("、")}`);
  else steps.push(`计入的工作日共 ${n} 日：第 1 日 ${wd(counted[0]!)}，第 ${n} 日 ${wd(counted[n - 1]!)}`);
  if (skipped.length) steps.push(`跳过的休假日（周末与法定节假日）${skipped.length} 天：${skipped.length <= 20 ? skipped.join("、") : `${skipped.slice(0, 20).join("、")} 等`}`);
  if (adjusted.length) steps.push(`计入的调休上班日：${adjusted.join("、")}`);
  steps.push(`第 ${n} 个工作日 ${wd(d)}为期间最后一日（工作日本身不是休假日，无需顺延）`);
  return { deadline: d, steps, years };
}

const CIVIL_RULES = (unit: DeadlineUnit): DeadlineRuleRef[] => [
  { law: "中华人民共和国民法典", article: "第二百条", point: "期间按照公历年、月、日、小时计算" },
  { law: "中华人民共和国民法典", article: "第二百零一条第一款", point: "按照年、月、日计算期间的，开始的当日不计入，自下一日开始计算" },
  ...(unit === "month" || unit === "year"
    ? [{ law: "中华人民共和国民法典", article: "第二百零二条", point: "按照年、月计算期间的，到期月的对应日为期间的最后一日；没有对应日的，月末日为期间的最后一日" }]
    : []),
  { law: "中华人民共和国民法典", article: "第二百零三条", point: "最后一日是法定休假日的，以法定休假日结束的次日为最后一日；最后一日截止时间为二十四时，有业务时间的为停止业务活动的时间" },
  { law: "中华人民共和国民法典", article: "第二百零四条", point: "法律另有规定或者当事人另有约定的除外" },
  { law: "中华人民共和国民事诉讼法", article: "第八十五条（2023 修正，2024-01-01 施行；2026-10-22 对照政府网站转载的修正文本核实）", point: "期间开始的时和日不计算在期间内；期间届满的最后一日是法定休假日的，以法定休假日后的第一日为期间届满的日期；期间不包括在途时间，诉讼文书在期满前交邮的，不算过期" },
];

const WORKDAY_RULES: DeadlineRuleRef[] = [
  { law: "中华人民共和国行政处罚法", article: "第八十五条", point: "本法中“二日”“三日”“五日”“七日”的规定是指工作日，不含法定节假日" },
  { law: "中华人民共和国行政处罚法", article: "第六十四条", point: "例：当事人要求听证的，应当在行政机关告知后五日内提出" },
  { law: "中华人民共和国民法典", article: "第二百零一条第一款", point: "开始的当日不计入（参照期间计算的一般规则；待核）" },
];

const NOT_HANDLED =
  "不处理诉讼时效中止、中断，在途时间与扣除期间，按小时计算的期间，当事人约定的特别计算方法（民法典第二百零四条），以及民族自治地方的地方性假日；发生这些事由时，由律师给出新的起算事实后重算。工作日规则只用于法律明确规定按工作日计算的期间。";

export function calcDeadline(params: CalcDeadlineParams): CalcDeadlineResult {
  const p = params ?? ({} as CalcDeadlineParams);
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(typeof p.start === "string" ? p.start : "");
  if (!m) bad("start 须为 YYYY-MM-DD 或 YYYY-MM（只到月时给区间）");
  const sy = Number(m[1]);
  const sm = Number(m[2]);
  if (sy < 1900 || sy > 2199) bad("start 年份须在 1900—2199 之间");
  if (sm < 1 || sm > 12) bad(`start 月份 ${m[2]} 不存在`);
  const dayPrecision = m[3] !== undefined;
  if (dayPrecision) {
    const sd = Number(m[3]);
    if (sd < 1 || sd > daysInMonth(sy, sm)) bad(`start 日期 ${p.start} 不存在`);
  }
  const unit = p.period?.unit as DeadlineUnit;
  const n = p.period?.n as number;
  if (!UNITS.includes(unit)) bad("period.unit 须为 day / month / year / workday");
  if (!Number.isInteger(n) || n < 1) bad("period.n 须为正整数");
  if (n > MAX_N[unit]) bad(`period.n 超出上限（${unit} 最多 ${MAX_N[unit]}）`);
  if (p.rule !== "civil" && p.rule !== "workday") bad("rule 须为 civil 或 workday");
  if ((p.rule === "workday") !== (unit === "workday")) {
    bad("工作日期间须同时写 rule=workday 与 period.unit=workday；其他期间用 rule=civil 与 day / month / year");
  }

  const run = (s: string): OneRun => (unit === "workday" ? runWorkday(s, n) : runCivil(s, unit, n));
  const warnings: string[] = [];
  let deadline: string | null;
  let range: { earliest: string; latest: string } | null = null;
  let steps: string[];
  const years = new Set<number>();
  if (dayPrecision) {
    const r = run(p.start);
    deadline = r.deadline;
    steps = r.steps;
    for (const y of r.years) years.add(y);
  } else {
    const first = ymd(sy, sm, 1);
    const last = ymd(sy, sm, daysInMonth(sy, sm));
    const a = run(first);
    const b = run(last);
    deadline = null;
    range = { earliest: a.deadline, latest: b.deadline };
    steps = [
      `起算事实只到月（${p.start}），不补成某日：分别按该月第一日与最后一日起算，给出区间`,
      ...a.steps.map((x) => `［最早，按 ${first} 起算］${x}`),
      ...b.steps.map((x) => `［最晚，按 ${last} 起算］${x}`),
      `届满日区间：${range.earliest} 至 ${range.latest}`,
    ];
    for (const y of [...a.years, ...b.years]) years.add(y);
    warnings.push(`起算事实只到月，届满日只能给区间（${range.earliest} 至 ${range.latest}）；须律师查明起算事实的具体日期后重算，不得以区间内某日作为确定的届满日`);
  }

  const used: HolidayYearUse[] = [...years].sort((x, y) => x - y).map((y) => {
    const h = holidayYear(y);
    return h
      ? { year: y, status: "verified" as const, title: h.title, doc_no: h.doc_no, url: h.url, verified_on: h.verified_on }
      : { year: y, status: "not_collected" as const };
  });
  for (const u of used) {
    if (u.status === "not_collected") warnings.push(notCollectedWarning(u.year, p.rule));
  }
  // 届满日是调休上班的周末（v9.4 复核 Q1-02）：实务通说不顺延，但个别法院把握不同——稳妥起见提示以前一个工作日为准
  if (deadline && dayStatus(deadline).kind === "adjusted_workday") {
    warnings.push(`届满日 ${deadline} 是调休上班的周末：按通说不顺延，但个别法院把握不同，稳妥起见以前一个工作日为准`);
  }

  return {
    rule: p.rule,
    start: p.start,
    start_precision: dayPrecision ? "day" : "month",
    period: { unit, n },
    deadline,
    range,
    steps,
    rules: p.rule === "workday" ? WORKDAY_RULES : CIVIL_RULES(unit),
    holiday_source: { ...holidaySource(), years_used: used },
    warnings,
    not_handled: NOT_HANDLED,
  };
}
