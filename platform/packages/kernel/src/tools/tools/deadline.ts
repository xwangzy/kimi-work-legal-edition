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
import { dayStatus, holidaySource, holidayYear, isRestDay, lunarHolidaysKnown, weekdayOf } from "./cn-holidays.ts";

export type DeadlineUnit = "day" | "month" | "year" | "workday";
export type DeadlineRule = "civil" | "workday";

export interface CalcDeadlineParams {
  start: string; // YYYY-MM-DD 或 YYYY-MM
  /** 写了 type（程序期间目录）时由目录给出，不必写；写了须与目录一致。 */
  period?: { unit: DeadlineUnit; n: number };
  rule?: DeadlineRule;
  /** 程序期间类型（第 61 批，D-260）：期间长度、起算事实与依据条号由目录给出，不由调用方填写。 */
  type?: ProceduralPeriodType;
  /** 目录变体：境内没有住所（上诉、答辩 30 日）；保全财产类型（存款 1 年、动产 2 年、不动产与其他财产权 3 年）。 */
  foreign_domicile?: boolean;
  asset?: "deposit" | "movable" | "immovable_or_rights";
}

/** 程序期间目录的一项（第 61 批，D-260；条文 2026-11-24 逐条对照法规库原文）。 */
export interface ProceduralPeriodSpec {
  label: string;
  /** start 应当填写的起算事实。 */
  start_means: string;
  period: { unit: Exclude<DeadlineUnit, "workday">; n: number };
  basis: DeadlineRuleRef[];
  /** 给律师的提醒（例如简易程序答辩期由法院确定、逾期后果）。 */
  notes?: string[];
  /** 另一种计算口径（劳动仲裁答辩期：法律写“十日”，办案规则规定“10日”指工作日）：并列算出，deadline 取较早的保守口径。 */
  alt?: { label: string; period: { unit: "workday"; n: number }; basis: DeadlineRuleRef[] };
}

export type ProceduralPeriodType =
  | "appeal_judgment"
  | "appeal_ruling"
  | "defense_first_instance"
  | "defense_appeal"
  | "labor_arbitration_defense"
  | "labor_award_suit"
  | "labor_award_setaside_employer"
  | "arbitration_award_setaside"
  | "pre_action_preservation_suit"
  | "enforcement_application"
  | "retrial_application"
  | "preservation_expiry"
  | "preservation_renewal"
  | "civil_limitation"
  | "labor_arbitration_limitation";

const MS = "中华人民共和国民事诉讼法";
const MSJ = "最高人民法院关于适用《中华人民共和国民事诉讼法》的解释";
const BQ = "最高人民法院关于人民法院办理财产保全案件若干问题的规定";
const LD = "中华人民共和国劳动争议调解仲裁法";
const FOREIGN_APPEAL: DeadlineRuleRef = { law: MS, article: "第二百八十六条", point: "在中华人民共和国领域内没有住所的当事人，不服第一审判决、裁定的，自判决书、裁定书送达之日起三十日内上诉；被上诉人收到上诉状副本后三十日内答辩" };

/** 程序期间目录。期间长度、起算事实与依据都由这里给，模型只给起算日（与变体）。纯数据。 */
export function proceduralPeriod(type: ProceduralPeriodType, v: { start?: string | undefined; foreign_domicile?: boolean | undefined; asset?: CalcDeadlineParams["asset"] | undefined } = {}): ProceduralPeriodSpec | null {
  const foreign = v.foreign_domicile === true;
  switch (type) {
    case "appeal_judgment":
      return foreign
        ? { label: "上诉期（判决，当事人在境内没有住所）", start_means: "判决书送达之日", period: { unit: "day", n: 30 }, basis: [FOREIGN_APPEAL] }
        : { label: "上诉期（判决）", start_means: "判决书送达之日（以送达回证或电子送达记录为准；各方收到日不同的分别计算）", period: { unit: "day", n: 15 }, basis: [{ law: MS, article: "第一百七十一条第一款", point: "不服地方人民法院第一审判决的，在判决书送达之日起十五日内上诉" }] };
    case "appeal_ruling":
      return foreign
        ? { label: "上诉期（裁定，当事人在境内没有住所）", start_means: "裁定书送达之日", period: { unit: "day", n: 30 }, basis: [FOREIGN_APPEAL] }
        : { label: "上诉期（裁定）", start_means: "裁定书送达之日", period: { unit: "day", n: 10 }, basis: [{ law: MS, article: "第一百七十一条第二款", point: "不服地方人民法院第一审裁定的，在裁定书送达之日起十日内上诉" }] };
    case "defense_first_instance":
      return foreign
        ? { label: "答辩期（一审，被告在境内没有住所）", start_means: "收到起诉状副本之日", period: { unit: "day", n: 30 }, basis: [{ law: MS, article: "第二百八十五条", point: "被告在中华人民共和国领域内没有住所的，收到起诉状副本后三十日内提出答辩状" }] }
        : {
            label: "答辩期（一审普通程序）",
            start_means: "收到起诉状副本之日",
            period: { unit: "day", n: 15 },
            basis: [{ law: MS, article: "第一百二十八条第一款", point: "被告应当在收到起诉状副本之日起十五日内提出答辩状" }],
            notes: ["简易程序、小额诉讼的答辩期间可由法院确定或当事人放弃（民诉法解释第二百六十六条、第二百七十五条）：以应诉通知书为准"],
          };
    case "defense_appeal":
      return foreign
        ? { label: "二审答辩期（被上诉人在境内没有住所）", start_means: "收到上诉状副本之日", period: { unit: "day", n: 30 }, basis: [FOREIGN_APPEAL] }
        : { label: "二审答辩期", start_means: "收到上诉状副本之日", period: { unit: "day", n: 15 }, basis: [{ law: MS, article: "第一百七十四条第一款", point: "对方当事人在收到上诉状副本之日起十五日内提出答辩状" }] };
    case "labor_arbitration_defense":
      return {
        label: "劳动仲裁答辩期",
        start_means: "收到仲裁申请书副本之日",
        period: { unit: "day", n: 10 },
        basis: [{ law: LD, article: "第三十条第二款", point: "被申请人收到仲裁申请书副本后，应当在十日内向劳动争议仲裁委员会提交答辩书" }],
        alt: {
          label: "按办案规则的工作日口径",
          period: { unit: "workday", n: 10 },
          basis: [
            { law: "劳动人事争议仲裁办案规则", article: "第三十三条第二款", point: "被申请人收到仲裁申请书副本后，应当在10日内向仲裁委员会提交答辩书" },
            { law: "劳动人事争议仲裁办案规则", article: "第八十条", point: "本规则规定的“3日”“5日”“10日”指工作日，“15日”“45日”指自然日" },
          ],
        },
        notes: ["法律写“十日”，办案规则规定“10日”指工作日：两种口径并列，deadline 取较早的日历日口径作保守控制日；管辖异议、反申请须在答辩期满前提出；未提交答辩书不影响仲裁程序进行"],
      };
    case "labor_award_suit":
      return {
        label: "不服劳动仲裁裁决起诉期",
        start_means: "收到仲裁裁决书之日",
        period: { unit: "day", n: 15 },
        basis: [
          { law: LD, article: "第四十八条", point: "劳动者对终局裁决不服的，自收到仲裁裁决书之日起十五日内起诉" },
          { law: LD, article: "第五十条", point: "对终局裁决以外的裁决不服的，自收到裁决书之日起十五日内起诉；期满不起诉的，裁决书发生法律效力" },
        ],
        notes: ["用人单位对第四十七条终局裁决不能起诉，只能在三十日内申请撤销（type 用 labor_award_setaside_employer）"],
      };
    case "labor_award_setaside_employer":
      return { label: "用人单位申请撤销终局裁决期限", start_means: "收到仲裁裁决书之日", period: { unit: "day", n: 30 }, basis: [{ law: LD, article: "第四十九条第一款", point: "用人单位有证据证明第四十七条终局裁决有法定情形的，自收到裁决书之日起三十日内向仲裁委员会所在地的中级人民法院申请撤销" }] };
    case "arbitration_award_setaside": {
      const newLaw = !v.start || v.start >= "2026-03-01";
      return newLaw
        ? { label: "申请撤销仲裁裁决期限", start_means: "收到裁决书之日", period: { unit: "month", n: 3 }, basis: [{ law: "中华人民共和国仲裁法", article: "第七十二条（2025 年修订，2026-03-01 施行）", point: "当事人申请撤销裁决的，应当自收到裁决书之日起三个月内提出" }] }
        : {
            label: "申请撤销仲裁裁决期限（修订前仲裁法）",
            start_means: "收到裁决书之日",
            period: { unit: "month", n: 6 },
            basis: [{ law: "中华人民共和国仲裁法", article: "第五十九条（2017 年修正文本；法规库只收现行文本，原文须律师核对）", point: "当事人申请撤销裁决的，应当自收到裁决书之日起六个月内提出" }],
            notes: ["收到裁决书在 2026-03-01 新法施行之前：按修订前的六个月计算，跨新法施行日的是否改按三个月须律师核对新法的时间效力规定；稳妥起见按三个月（较早者）准备"],
          };
    }
    case "pre_action_preservation_suit":
      return {
        label: "诉前（仲裁前）保全后起诉或申请仲裁期限",
        start_means: "人民法院采取保全措施之日",
        period: { unit: "day", n: 30 },
        basis: [
          { law: MS, article: "第一百零四条第三款", point: "申请人在人民法院采取保全措施后三十日内不依法提起诉讼或者申请仲裁的，人民法院应当解除保全" },
          { law: BQ, article: "第十七条", point: "三十日内起诉或申请仲裁的，诉前保全自动转为诉讼或仲裁中的保全，期限连续计算" },
        ],
      };
    case "enforcement_application":
      return {
        label: "申请执行期间",
        start_means: "法律文书规定履行期间的最后一日（分期履行的为最后一期履行期限届满之日；未规定履行期间的为法律文书生效之日）",
        period: { unit: "year", n: 2 },
        basis: [{ law: MS, article: "第二百五十条", point: "申请执行的期间为二年，中止、中断适用诉讼时效的规定；自法律文书规定履行期间的最后一日起计算" }],
        notes: ["超过期间申请的，法院仍应受理，由被执行人提出异议后审查：不要据此告诉客户“过期就不能申请”"],
      };
    case "retrial_application":
      return {
        label: "申请再审期限",
        start_means: "判决、裁定发生法律效力之日（以第二百一十一条第一、三、十二、十三项为由的，为知道或者应当知道之日）",
        period: { unit: "month", n: 6 },
        basis: [{ law: MS, article: "第二百一十六条", point: "当事人申请再审，应当在判决、裁定发生法律效力后六个月内提出" }],
      };
    case "preservation_expiry": {
      const years = v.asset === "deposit" ? 1 : v.asset === "movable" ? 2 : v.asset === "immovable_or_rights" ? 3 : null;
      if (!years) return null;
      return {
        label: `保全期限（${v.asset === "deposit" ? "冻结银行存款" : v.asset === "movable" ? "查封、扣押动产" : "查封不动产、冻结其他财产权"}，最长 ${years} 年）`,
        start_means: "保全措施实施之日（以法院裁定或协助执行通知载明的起始日为准）",
        period: { unit: "year", n: years },
        basis: [
          { law: MSJ, article: "第四百八十五条第一款", point: "冻结银行存款不得超过一年，查封、扣押动产不得超过两年，查封不动产、冻结其他财产权不得超过三年" },
          { law: BQ, article: "第十八条第一款", point: "申请续行财产保全的，应当在保全期限届满七日前向人民法院提出；逾期申请或者不申请的，自行承担不能续行保全的法律后果" },
        ],
        notes: ["这里按最长期限推算；法院裁定或通知书载明了届满日的，以载明的为准，并用 type=preservation_renewal 按载明的届满日重算续行截止日"],
      };
    }
    case "preservation_renewal":
      return {
        label: "申请续行保全截止日",
        start_means: "保全期限届满日（法院书面告知的届满日）",
        period: { unit: "day", n: 7 },
        basis: [{ law: BQ, article: "第十八条", point: "申请续行财产保全的，应当在保全期限届满七日前提出；法院进行保全时应书面告知届满日与续行事项" }],
      };
    case "civil_limitation":
      return {
        label: "诉讼时效（一般三年）",
        start_means: "权利人知道或者应当知道权利受到损害以及义务人之日（分期履行的，为最后一期履行期限届满之日）",
        period: { unit: "year", n: 3 },
        basis: [{ law: "中华人民共和国民法典", article: "第一百八十八条", point: "诉讼时效期间为三年，自知道或者应当知道权利受到损害以及义务人之日起计算；自权利受到损害之日起超过二十年的不予保护" }],
        notes: ["中止、中断（催告、对方同意履行、起诉等）由律师给出新的起算事实后重算；起算事实有争议的按各口径分别计算，取最早届满日准备"],
      };
    case "labor_arbitration_limitation":
      return {
        label: "劳动仲裁时效（一年）",
        start_means: "知道或者应当知道权利被侵害之日（劳动报酬争议：劳动关系终止之日）",
        period: { unit: "year", n: 1 },
        basis: [{ law: LD, article: "第二十七条", point: "仲裁时效期间为一年；劳动关系存续期间拖欠劳动报酬的不受一年限制，但劳动关系终止的应当自终止之日起一年内提出" }],
      };
  }
  return null;
}

export const PROCEDURAL_PERIOD_TYPES: readonly ProceduralPeriodType[] = [
  "appeal_judgment", "appeal_ruling", "defense_first_instance", "defense_appeal", "labor_arbitration_defense", "labor_award_suit", "labor_award_setaside_employer",
  "arbitration_award_setaside", "pre_action_preservation_suit", "enforcement_application", "retrial_application", "preservation_expiry", "preservation_renewal",
  "civil_limitation", "labor_arbitration_limitation",
];

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
  /** 程序期间目录（第 61 批）：写了 type 时给出期间名称、起算事实的含义与依据条号。 */
  procedural?: { type: ProceduralPeriodType; label: string; start_means: string; basis: DeadlineRuleRef[]; notes: string[] };
  /** 保全期限（preservation_expiry）：推算的届满日与续行申请截止日；续行（preservation_renewal）：截止日在 deadline。 */
  renewal_deadline?: string | null;
  /** 另一口径的届满日（劳动仲裁答辩期的工作日口径）。 */
  alt_deadline?: { label: string; deadline: string | null; basis: DeadlineRuleRef[] };
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
/**
 * 未收录年份的警告（v9.4 复核 Q1-01、Q1-03：按规则区分“顺延”与“计数”，写明已按固定日期假日处理、哪些仍未知）。
 * 第 42 批：措辞改成律师的说法——V16 第二轮 57 张卡里 20 张把“某年放假通知未收录……须律师……核对”抄或改写进了成果，
 * “未收录”说的是本产品的表，读者看不懂；现在这句话即使被照抄进内部底稿也说得通（对外文书正文仍不写，见工作准则第 4 条）。
 */
export function notCollectedWarning(year: number, rule: DeadlineRule): string {
  if (lunarHolidaysKnown(year)) {
    const how = rule === "workday" ? "已跳过周末与放假办法规定的法定假日（元旦，春节除夕至初三，清明、劳动节、端午、中秋、国庆）计数" : "已按周末与放假办法规定的法定假日（元旦，春节除夕至初三，清明、劳动节、端午、中秋、国庆）顺延";
    return `${year} 年的调休安排尚未纳入测算：${how}；调休上班日与周末补假以当年国务院办公厅放假通知为准，届时按通知复核`;
  }
  const how = rule === "workday" ? "只跳过周末与放假办法规定的固定日期假日（元旦、劳动节、国庆）计数" : "只按周末与放假办法规定的固定日期假日（元旦、劳动节、国庆）顺延";
  return `${year} 年的放假安排尚未纳入测算：${how}；春节、清明、端午、中秋假期与调休以当年国务院办公厅放假通知为准，届时按通知复核`;
}

function restReason(date: string): string {
  const s = dayStatus(date);
  if (s.kind === "holiday") return `${s.name}假期 ${s.span!.from} 至 ${s.span!.to}`;
  if (s.kind === "weekend") return `${WEEKDAY[weekdayOf(date)]}公休日${s.covered ? "" : "（该年放假安排尚未纳入测算）"}`;
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
        : `名义末日 ${wd(d)}是工作日${s.covered ? "" : "（该年放假安排尚未纳入测算，只按周末与放假办法固定日期假日判断）"}，不顺延`,
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
  const p0 = params ?? ({} as CalcDeadlineParams);
  if (p0.type !== undefined) return calcProcedural(p0);
  return calcPlain(p0);
}

/** 按程序期间目录计算（第 61 批，D-260）：期间长度与依据由目录给出，模型只给起算日与变体。 */
function calcProcedural(p: CalcDeadlineParams): CalcDeadlineResult {
  const type = p.type as ProceduralPeriodType;
  if (!PROCEDURAL_PERIOD_TYPES.includes(type)) bad(`type 须为程序期间目录中的一项：${PROCEDURAL_PERIOD_TYPES.join(" / ")}`);
  if (type === "preservation_expiry" && !p.asset) bad("type=preservation_expiry 须写 asset：deposit（银行存款）/ movable（动产）/ immovable_or_rights（不动产或其他财产权）");
  const spec = proceduralPeriod(type, { start: p.start, foreign_domicile: p.foreign_domicile, asset: p.asset });
  if (!spec) bad("目录里没有这一类期间");
  if (p.period && (p.period.unit !== spec.period.unit || p.period.n !== spec.period.n)) {
    bad(`type=${type} 的期间由目录给出（${spec.period.n} ${spec.period.unit}，${spec.basis.map((b) => `《${b.law}》${b.article}`).join("、")}）：不要另写 period；确实适用别的期间的，不写 type，按 period 与 rule 计算并写明依据`);
  }
  const notes = [...(spec.notes ?? [])];
  if (type === "preservation_renewal") {
    // 续行：届满日往前数七日（“届满七日前”提出），再往前留出准备时间的提醒由律师在期限提醒里设
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof p.start === "string" ? p.start : "");
    if (!m) bad("type=preservation_renewal 的 start 须为法院告知的保全期限届满日（YYYY-MM-DD）");
    const latest = addDays(p.start, -7);
    const steps = [
      `保全期限届满日：${p.start}（${wd(p.start)}）`,
      `续行申请须在届满七日前提出：最迟 ${latest}（${wd(latest)}）；稳妥起见在此之前提交，并把提醒设在更早（例如届满前十五日 ${addDays(p.start, -15)}）`,
    ];
    if (isRestDay(latest)) notes.push(`最迟日 ${latest} 是休息日：“届满七日前”是向前数的期限，不顺延，应在此前最后一个工作日提交`);
    return {
      procedural: { type, label: spec.label, start_means: spec.start_means, basis: spec.basis, notes },
      renewal_deadline: latest,
      rule: "civil",
      start: p.start,
      start_precision: "day",
      period: spec.period,
      deadline: latest,
      range: null,
      steps,
      rules: spec.basis,
      holiday_source: { ...holidaySource(), years_used: [] },
      warnings: notes,
      not_handled: NOT_HANDLED,
    };
  }
  const r = calcPlain({ start: p.start, period: spec.period, rule: "civil" });
  let renewal: string | null | undefined;
  const steps = [`期间类型：${spec.label}；起算事实：${spec.start_means}；依据：${spec.basis.map((b) => `《${b.law}》${b.article}`).join("、")}`, ...r.steps];
  let alt: { label: string; deadline: string | null; basis: DeadlineRuleRef[] } | undefined;
  if (spec.alt) {
    const a = calcPlain({ start: p.start, period: spec.alt.period, rule: "workday" });
    alt = { label: spec.alt.label, deadline: a.deadline, basis: spec.alt.basis };
    steps.push(`［${spec.alt.label}，${spec.alt.basis.map((b) => `《${b.law}》${b.article}`).join("、")}］`, ...a.steps.map((x) => `［工作日口径］${x}`));
    if (a.deadline && r.deadline) steps.push(`两种口径：日历日 ${r.deadline}（保守控制日）；工作日 ${a.deadline}`);
  }
  if (type === "preservation_expiry") {
    // 法院“自某日至某日”的写法含首尾两日，按“开始当日不计入”推出的届满日可能晚一日：取早一日的口径，续行截止日再往前七日
    const expiry = r.deadline ? addDays(r.deadline, -1) : null;
    renewal = expiry ? addDays(expiry, -7) : null;
    if (expiry) steps.push(`按法院“自起始日至届满日”含首尾的写法，届满日稳妥取 ${expiry}（${wd(expiry)}）；续行申请最迟 ${renewal}（届满七日前，财产保全规定第十八条）`);
    notes.push("届满日以法院裁定或通知书载明的为准；载明的与这里推算的不同，用 type=preservation_renewal 按载明的届满日重算续行截止日");
  }
  return {
    ...r,
    ...(alt ? { alt_deadline: alt } : {}),
    procedural: { type, label: spec.label, start_means: spec.start_means, basis: spec.basis, notes },
    ...(renewal !== undefined ? { renewal_deadline: renewal } : {}),
    steps,
    rules: [...spec.basis, ...r.rules],
    warnings: [...r.warnings, ...notes],
  };
}

function calcPlain(params: CalcDeadlineParams): CalcDeadlineResult {
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
