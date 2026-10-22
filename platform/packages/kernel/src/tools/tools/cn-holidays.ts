/**
 * 全国法定节假日与调休上班日（calc.deadline 用；v9.4 评审 S1 §6.2 第 9 项）。
 *
 * 只收录能用官方来源逐字核实的年份：国务院办公厅关于 20XX 年部分节假日安排的通知（中国政府网原文）。
 * 每一年写明来源 URL、发文字号、发布日期与核实日期；未收录的年份由工具给出 warning（只按周末计），
 * 不得凭记忆补录。新增一年时：抓取 www.gov.cn 原文 → 逐条录入 off / workdays → 补测试 → 更新本表。
 *
 * 口径（复核要点）：
 * - off 区间内每一天都是法定休假日（通知写“放假调休，共 N 天”的整段，含其中的周末）；
 * - workdays 是调休上班的周六、周日：这一天不是休假日（期间末日落在这天不顺延；工作日规则计入）；
 * - 只适用于部分公民的节日（妇女节、青年节、儿童节、建军节等）不是全体公民放假日，不收录；
 * - 全国性表格：民族自治地方按当地规定放假的少数民族节日不在此表（须律师按当地规定核对，见 calc.deadline 说明）。
 */

export interface HolidayYear {
  year: number;
  title: string;
  doc_no: string;
  published: string;
  url: string;
  verified_on: string;
  verified_how: string;
  /** 放假区间（含首尾），name 为节日名。 */
  off: readonly { name: string; from: string; to: string }[];
  /** 调休上班的周六、周日。 */
  workdays: readonly { date: string; name: string }[];
}

const VERIFIED_ON = "2026-10-21";
const HOW = "抓取中国政府网原文逐条核对（curl www.gov.cn）";

export const CN_HOLIDAYS: readonly HolidayYear[] = [
  {
    year: 2024,
    title: "国务院办公厅关于2024年部分节假日安排的通知",
    doc_no: "国办发明电〔2023〕7号",
    published: "2023-10-25",
    url: "https://www.gov.cn/zhengce/zhengceku/202310/content_6911528.htm",
    verified_on: VERIFIED_ON,
    verified_how: HOW,
    off: [
      { name: "元旦", from: "2024-01-01", to: "2024-01-01" },
      { name: "春节", from: "2024-02-10", to: "2024-02-17" },
      { name: "清明节", from: "2024-04-04", to: "2024-04-06" },
      { name: "劳动节", from: "2024-05-01", to: "2024-05-05" },
      { name: "端午节", from: "2024-06-10", to: "2024-06-10" },
      { name: "中秋节", from: "2024-09-15", to: "2024-09-17" },
      { name: "国庆节", from: "2024-10-01", to: "2024-10-07" },
    ],
    workdays: [
      { date: "2024-02-04", name: "春节调休上班" },
      { date: "2024-02-18", name: "春节调休上班" },
      { date: "2024-04-07", name: "清明节调休上班" },
      { date: "2024-04-28", name: "劳动节调休上班" },
      { date: "2024-05-11", name: "劳动节调休上班" },
      { date: "2024-09-14", name: "中秋节调休上班" },
      { date: "2024-09-29", name: "国庆节调休上班" },
      { date: "2024-10-12", name: "国庆节调休上班" },
    ],
  },
  {
    year: 2025,
    title: "国务院办公厅关于2025年部分节假日安排的通知",
    doc_no: "国办发明电〔2024〕12号",
    published: "2024-11-12",
    url: "https://www.gov.cn/gongbao/2024/issue_11726/202411/content_6989767.html",
    verified_on: VERIFIED_ON,
    verified_how: `${HOW}；该页为国务院公报 2024 年第 33 号刊载件`,
    off: [
      { name: "元旦", from: "2025-01-01", to: "2025-01-01" },
      { name: "春节", from: "2025-01-28", to: "2025-02-04" },
      { name: "清明节", from: "2025-04-04", to: "2025-04-06" },
      { name: "劳动节", from: "2025-05-01", to: "2025-05-05" },
      { name: "端午节", from: "2025-05-31", to: "2025-06-02" },
      { name: "国庆节、中秋节", from: "2025-10-01", to: "2025-10-08" },
    ],
    workdays: [
      { date: "2025-01-26", name: "春节调休上班" },
      { date: "2025-02-08", name: "春节调休上班" },
      { date: "2025-04-27", name: "劳动节调休上班" },
      { date: "2025-09-28", name: "国庆节、中秋节调休上班" },
      { date: "2025-10-11", name: "国庆节、中秋节调休上班" },
    ],
  },
  {
    year: 2026,
    title: "国务院办公厅关于2026年部分节假日安排的通知",
    doc_no: "国办发明电〔2025〕7号",
    published: "2025-11-04",
    url: "https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm",
    verified_on: VERIFIED_ON,
    verified_how: HOW,
    off: [
      { name: "元旦", from: "2026-01-01", to: "2026-01-03" },
      { name: "春节", from: "2026-02-15", to: "2026-02-23" },
      { name: "清明节", from: "2026-04-04", to: "2026-04-06" },
      { name: "劳动节", from: "2026-05-01", to: "2026-05-05" },
      { name: "端午节", from: "2026-06-19", to: "2026-06-21" },
      { name: "中秋节", from: "2026-09-25", to: "2026-09-27" },
      { name: "国庆节", from: "2026-10-01", to: "2026-10-07" },
    ],
    workdays: [
      { date: "2026-01-04", name: "元旦调休上班" },
      { date: "2026-02-14", name: "春节调休上班" },
      { date: "2026-02-28", name: "春节调休上班" },
      { date: "2026-05-09", name: "劳动节调休上班" },
      { date: "2026-09-20", name: "国庆节调休上班" },
      { date: "2026-10-10", name: "国庆节调休上班" },
    ],
  },
];

const byYear = new Map<number, HolidayYear>(CN_HOLIDAYS.map((y) => [y.year, y]));

/**
 * 随法规库包签名分发的节假日表（v9.4 第 21 批，主文 §3.2）：法规库包打开或更新换用时由内核装入，同一年以包里的为准
 * （国办每年 10—11 月发布次年安排，靠内容更新就能补上，不必等应用升级）。逐年校验形状，不合格的那一年不用、照旧用内置的。
 */
let signed = new Map<number, HolidayYear>();
let signedFrom: string | null = null;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function validYear(x: any): x is HolidayYear {
  if (!x || !Number.isInteger(x.year) || x.year < 2000 || x.year > 2100) return false;
  if (![x.title, x.doc_no, x.published, x.url, x.verified_on].every((v) => typeof v === "string" && v)) return false;
  if (!Array.isArray(x.off) || x.off.length === 0 || !Array.isArray(x.workdays)) return false;
  const inYear = (d: unknown) => typeof d === "string" && DAY_RE.test(d) && Math.abs(Number(d.slice(0, 4)) - x.year) <= 1;
  return x.off.every((o: any) => typeof o?.name === "string" && inYear(o.from) && inYear(o.to) && o.from <= o.to) && x.workdays.every((w: any) => typeof w?.name === "string" && inYear(w.date));
}
export function useSignedHolidays(docs: readonly unknown[], source: string): { used: number[]; rejected: number } {
  const next = new Map<number, HolidayYear>();
  let rejected = 0;
  for (const d of docs) {
    if (validYear(d)) next.set(d.year, Object.freeze({ ...d, verified_how: d.verified_how ?? "" }));
    else rejected += 1;
  }
  signed = next;
  signedFrom = next.size > 0 ? source : null;
  return { used: [...next.keys()].sort((a, b) => a - b), rejected };
}
/** 当前节假日表的出处与收录年份（内置与法规库包合并）。 */
export function holidaySource(): { table: string; years_covered: number[] } {
  const years = [...new Set([...byYear.keys(), ...signed.keys()])].sort((a, b) => a - b);
  return {
    table: signedFrom
      ? `全国法定节假日与调休表（随法规库包 ${signedFrom} 签名分发；逐年按国务院办公厅部分节假日安排通知的中国政府网原文核对）`
      : "全国法定节假日与调休表（内核内置；逐年按国务院办公厅部分节假日安排通知的中国政府网原文核对）",
    years_covered: years,
  };
}

export function holidayYear(year: number): HolidayYear | undefined {
  return signed.get(year) ?? byYear.get(year);
}

export type DayKind = "holiday" | "weekend" | "adjusted_workday" | "workday";

export interface DayStatus {
  /** holiday 法定节假日放假；weekend 周六周日公休；adjusted_workday 调休上班的周末；workday 普通工作日。 */
  kind: DayKind;
  /** 节日或调休名称。 */
  name?: string;
  /** 放假区间（holiday 时）。 */
  span?: { from: string; to: string };
  /** 该年节假日表是否已收录（未收录时只按周末与放假办法的固定日期假日判断）。 */
  covered: boolean;
  /** 未收录年份里按《全国年节及纪念日放假办法》认定的固定日期假日（v9.4 复核 Q1-01）。 */
  fixed?: boolean;
}

/**
 * 《全国年节及纪念日放假办法》规定日期固定（公历）的全体公民假日：未收录当年放假通知的年份至少认这些天是休假日（v9.4 复核 Q1-01：
 * 原来只按周末判断，跨年期间会把 1 月 1 日当成届满日）。2025 年起劳动节 2 天（5 月 1、2 日）；此前 1 天。
 * 春节（含除夕）、清明、端午、中秋按农历或节气，日期不固定；调休安排也只能看当年通知——未收录年份里这些一律未知，由调用方写警告。
 */
function fixedHoliday(date: string): string | null {
  const y = Number(date.slice(0, 4));
  const md = date.slice(5);
  if (md === "01-01") return "元旦";
  if (md === "05-01" || (y >= 2025 && md === "05-02")) return "劳动节";
  if (md === "10-01" || md === "10-02" || md === "10-03") return "国庆节";
  return null;
}

/** 0=周日 … 6=周六（UTC 计算，日期字符串无时区）。 */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function dayStatus(date: string): DayStatus {
  const y = holidayYear(Number(date.slice(0, 4)));
  const wd = weekdayOf(date);
  const weekend = wd === 0 || wd === 6;
  if (y) {
    const off = y.off.find((o) => o.from <= date && date <= o.to);
    if (off) return { kind: "holiday", name: off.name, span: { from: off.from, to: off.to }, covered: true };
    const w = y.workdays.find((x) => x.date === date);
    if (w) return { kind: "adjusted_workday", name: w.name, covered: true };
  } else {
    const f = fixedHoliday(date);
    if (f) return { kind: "holiday", name: `${f}（放假办法固定日期）`, span: { from: date, to: date }, covered: false, fixed: true };
  }
  return { kind: weekend ? "weekend" : "workday", covered: !!y };
}

/** 是否法定休假日（周六周日公休 + 法定节假日；调休上班的周末不是）。 */
export function isRestDay(date: string): boolean {
  const k = dayStatus(date).kind;
  return k === "holiday" || k === "weekend";
}
