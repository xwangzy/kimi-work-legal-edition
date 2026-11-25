/**
 * 期限表届满日复算（第 65 批）：交付件里期限表的“届满日”是模型把 calc.deadline 的结果抄进表的，内核此前不复算——
 * 抄错一天（尤其跨节假日顺延、把开始当日算进去）就是执业事故，复核模型又看不出来。金额已有整单勾稽（D-229），
 * 期限是同等级别的风险，这里补上对称的确定性核对：在本任务最新版的 Word 表格与 Excel 表上运行，
 * 查出的作为“必须改”并入独立复核意见，修改后由内核重跑同一项核对判断是否落实（与 amount-reconcile 同一接法）。
 *
 * 两条规则（纯函数，宁可漏报，不可误报）：
 *   D1 依据为空：表头有“届满日 / 截止日 / 到期日 / 最后一日”类列、同表有“依据 / 条号 / 条款”类列的，
 *      届满日写了日期而依据为空——这个日子按哪条规定或哪项约定算出来无从核对。
 *   D2 届满日复算：起算事实里能取出唯一确定的日期，期间能从“期间 / 时效类型 / 期限类型”等列的文字（十五日、15 日、
 *      六个月、10 个工作日……）或依据命中程序期间目录的条号（民诉法第一百七十一条第一款 → 上诉期 15 日等）唯一确定的，
 *      用 calc.deadline 的纯函数 calcDeadline 重算，与写的届满日不一致的报出。
 *
 * 期间计算规则（库内原文 2026-11-25 核对）：民法典第二百零一条第一款“开始的当日不计入，自下一日开始计算”；
 * 第二百零三条第一款“期间的最后一日是法定休假日的，以法定休假日结束的次日为期间的最后一日”；
 * 第二百零四条“法律另有规定或者当事人另有约定的除外”；民事诉讼法第八十五条第二、三款（期间开始的日不计算在期间内；
 * 最后一日是法定休假日的，以法定休假日后的第一日为期间届满的日期）。
 *
 * 不报（误报边界，见研究报告 R4 第 11.4 节、R2 第 5 节 X4）：
 *   - 法院、仲裁机构指定的期限（法院指定、通知书 / 传票 / 判项载明、以……为准）——第八十五条第一款的“指定的期间”由通知书定；
 *   - 起算日写“待确认 / 待核 / 不明 / 推定”的，起算事实里有两个以上日期的，计算过程写明的起算日与起算事实对不上的；
 *   - 届满日写“待核算 / 分支 / 不适用”的，带时刻的（开庭时间）；
 *   - 约定期限（依据不是法律条文）没写明“开始当日不计入 / 次日起算 / 某日为第 1 日”的——起算规则不清，民法典第二百零四条允许另行约定；
 *     约定期限也不强求节假日顺延（名义末日与顺延后的日子都算对上）；
 *   - 向前数的期限（届满七日前）、按小时或周计算的、一行里有几个期间（质保期 12 个月 + 届满后 10 日付款）的；
 *   - 同一行并列几种口径（自然日与工作日）的，各自对上即可；
 *   - 起算或届满落在放假安排尚未公布的年份、且前后两周内有法定节日的，复算只按周末与法定节日顺延，不一致降为提示（must=false）。
 */
import type { BlobStore } from "../blobs.ts";
import type { KernelDb } from "../db.ts";
import { latestAmountDocs, MACHINE_BASIS, MACHINE_FINDINGS_MAX } from "../executor/amount-reconcile.ts";
import { dayStatus, holidayYear } from "../tools/tools/cn-holidays.ts";
import { calcDeadline, proceduralPeriod, type DeadlineRule, type DeadlineUnit, type ProceduralPeriodType } from "../tools/tools/deadline.ts";
import type { AmountDoc, AmountRow } from "./amount-check.ts";
import type { ReviewFinding } from "./independent-review.ts";

export interface DeadlineIssue {
  /** 同一处问题的标识：修改后重跑核对，这个标识还在就是没落实（不含行号，插行不影响）。 */
  key: string;
  filename: string;
  where: string;
  /** 这一行的摘录（至多 80 字）。 */
  text: string;
  problem: string;
  fix: string;
  must: boolean;
}

// ───────────────────────── 文字与日期 ─────────────────────────

const MS_DAY = 86_400_000;
const addDays = (iso: string, n: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + n * MS_DAY).toISOString().slice(0, 10);
const dayDiff = (a: string, b: string): number => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / MS_DAY);
const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n: number): string => String(n).padStart(2, "0");

/** 全角数字、连字符归一。 */
function norm(s: string): string {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[－–‐]/g, "-").replace(/　/g, " ");
}

/** 完整日期（年月日）：2026-11-18、2026年11月3日、2026.11.03。 */
const FULL_DATE = /(?<!\d)(\d{4})\s*(?:[-./]|年)\s*(\d{1,2})\s*(?:[-./]|月)\s*(\d{1,2})(?!\d)\s*日?/g;
/** 不完整的日期：只到月（2026年9月、2026-09）、没写年的月日（11月3日、09-05）。 */
const YEAR_MONTH = /(?<!\d)\d{4}\s*(?:年\s*\d{1,2}\s*月(?!\s*\d)|-\d{1,2}(?![\d-]))/g;
const MD_CN = /(?<![\d年])\d{1,2}\s*月\s*\d{1,2}\s*日/g;
const MD_DASH = /(?<![\d\-./])(\d{1,2})-(\d{1,2})(?![\d\-])/g;
/** 条款号（第 4.2 条、第一百二十八条第一款、第二项）：先遮住，免得其中的数字被当成日期或期间。 */
const ARTICLE = /第\s*[\d.零〇一二两三四五六七八九十百千、，,和及至—~～-]+\s*(?:条|款|项|目|期)/g;

function validDate(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2199 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

interface DateHit {
  iso: string;
  index: number;
  end: number;
}

function fullDates(text: string): DateHit[] {
  const out: DateHit[] = [];
  for (const m of norm(text).matchAll(FULL_DATE)) {
    const iso = validDate(Number(m[1]), Number(m[2]), Number(m[3]));
    if (iso) out.push({ iso, index: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

/** 去掉完整日期后，还有没有别的（不完整的）日期。 */
function hasPartialDate(text: string): boolean {
  const t = norm(text).replace(FULL_DATE, " ").replace(ARTICLE, " ");
  if (t.search(YEAR_MONTH) >= 0 || t.search(MD_CN) >= 0) return true;
  for (const m of t.matchAll(MD_DASH)) {
    const mo = Number(m[1]);
    const d = Number(m[2]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return true;
  }
  return false;
}

const serialToIso = (n: number): string => new Date(Date.parse("1899-12-30T00:00:00Z") + Math.round(n) * MS_DAY).toISOString().slice(0, 10);

/** 单元格转文字；日期列里没被还原的 Excel 日期序号（2000—2099 年）还原成 YYYY-MM-DD。 */
function cellText(v: string | number | null | undefined, dateCol: boolean): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return dateCol && Number.isInteger(v) && v >= 36_526 && v <= 73_050 ? serialToIso(v) : String(v);
  return String(v);
}

// ───────────────────────── 中文数字与期间 ─────────────────────────

const CN_DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 一百七十一 → 171；十五 → 15；二百零四 → 204；阿拉伯数字原样。 */
export function cnNumber(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s);
  let section = 0;
  let digit = 0;
  let seen = false;
  for (const ch of s) {
    const d = CN_DIGIT[ch];
    if (d !== undefined) {
      digit = d;
      seen = true;
    } else if (ch === "十" || ch === "百" || ch === "千") {
      section += (seen ? digit : 1) * (ch === "十" ? 10 : ch === "百" ? 100 : 1000);
      digit = 0;
      seen = false;
    } else return null;
  }
  return section + digit;
}

export interface PeriodSpec {
  unit: DeadlineUnit;
  n: number;
  rule: DeadlineRule;
}

const periodKey = (p: PeriodSpec): string => `${p.unit}:${p.n}`;
const UNIT_CN: Record<DeadlineUnit, string> = { day: "日", workday: "个工作日", month: "个月", year: "年" };
const periodLabel = (p: PeriodSpec): string => `${p.n} ${UNIT_CN[p.unit]}`;

const NUM = "(\\d{1,4}|[零〇一二两三四五六七八九十百]{1,6})";
/** 期间：15 日、十五日内、10 个工作日、60 个自然日、六个月、1 年。前面是“第 / 每 / 月 / 余 / 剩”的不是期间（第 15 日、每月 15 日、余 766 天）。 */
const PERIOD_RE = new RegExp(`(?<![第每月余剩距差同某逐任\\d零〇一二两三四五六七八九十百])${NUM}\\s*(个\\s*)?(工作日|自然日|日历日|日|天|月|年|周|星期|小时)`, "g");

interface PeriodScan {
  periods: PeriodSpec[];
  /** 向前数（届满七日前）、按小时或周计算：不复算。 */
  unsupported: boolean;
}

/** 从文字里找期间。日期、年份与条款号先遮住。 */
export function scanPeriods(text: string): PeriodScan {
  const t = norm(text).replace(FULL_DATE, " ").replace(YEAR_MONTH, " ").replace(/\d{4}\s*年(?:度)?/g, " ").replace(ARTICLE, " ").replace(MD_CN, " ");
  const out = new Map<string, PeriodSpec>();
  let unsupported = false;
  for (const m of t.matchAll(PERIOD_RE)) {
    const n = cnNumber(m[1]!);
    const unitWord = m[3]!;
    const after = t.slice(m.index! + m[0].length, m.index! + m[0].length + 3);
    if (unitWord === "月" && !m[2]) continue; // “3月”是月份，不是期间
    if (unitWord === "年" && /^度/.test(after)) continue;
    if (n === null || n < 1) continue;
    if (unitWord === "周" || unitWord === "星期" || unitWord === "小时") {
      unsupported = true;
      continue;
    }
    const before = t.slice(Math.max(0, m.index! - 3), m.index!);
    if (/^\s*(?:前|以前|之前)/.test(after) || /提前\s*$|前\s*$/.test(before)) {
      unsupported = true; // 届满七日前、截止日前五日：向前数，不顺延，不在复算范围内
      continue;
    }
    const p: PeriodSpec =
      unitWord === "工作日"
        ? { unit: "workday", n, rule: "workday" }
        : unitWord === "月"
          ? { unit: "month", n, rule: "civil" }
          : unitWord === "年"
            ? { unit: "year", n, rule: "civil" }
            : { unit: "day", n, rule: "civil" };
    out.set(periodKey(p), p);
  }
  return { periods: [...out.values()], unsupported };
}

// ───────────────────────── 依据条号 → 程序期间目录 ─────────────────────────

type Law = "MS" | "MSJ" | "LD" | "MFD" | "ZCF";
interface StatuteRef {
  law: Law;
  article: number;
  para: number | null;
}

/** 民诉法解释单独认（第一百七十一条是保全、先予执行裁定复议五日，与民诉法第一百七十一条上诉期同号）。 */
const MSJ_NAME = /(?:最高人民法院关于)?适用《?(?:中华人民共和国)?民事诉讼法》?的解释|(?:中华人民共和国)?民事诉讼法》?的解释|民诉法解释|民事诉讼法解释/g;
/** 其他司法解释、规定等与法律同名的部分：先遮住，免得被当成法律本身。 */
const INTERP = /(?:民事诉讼法|民诉法|民法典|调解仲裁法|仲裁法)》?[^第；;。，,、《]{0,16}?(?:解释|规定|规则|意见|批复|纪要)/g;
const LAW_NAME = /(民诉解释|劳动争议调解仲裁法|调解仲裁法|民事诉讼法|民诉法|民法典|仲裁法)/g;
const LAW_OF: Record<string, Law> = { 民诉解释: "MSJ", 劳动争议调解仲裁法: "LD", 调解仲裁法: "LD", 民事诉讼法: "MS", 民诉法: "MS", 民法典: "MFD", 仲裁法: "ZCF" };

export function statuteRefs(text: string): StatuteRef[] {
  const t = norm(text).replace(MSJ_NAME, "民诉解释").replace(INTERP, "〔解释〕");
  const out: StatuteRef[] = [];
  const hits = [...t.matchAll(LAW_NAME)];
  hits.forEach((h, i) => {
    const from = h.index! + h[0].length;
    const next = i + 1 < hits.length ? hits[i + 1]!.index! : t.length;
    let tail = t.slice(from, Math.min(next, from + 80));
    const stop = tail.search(/[；;。《〔]/);
    if (stop >= 0) tail = tail.slice(0, stop);
    for (const m of tail.matchAll(/第\s*([^条；;。]{1,40}?)\s*条(?:\s*第\s*([一二三四五六七八九十\d]+)\s*款)?/g)) {
      const items = m[1]!.split(/[、，,和及]/).map((x) => x.replace(/^第/, "").trim()).filter(Boolean);
      const para = m[2] ? cnNumber(m[2]) : null;
      items.forEach((it, k) => {
        const range = it.split(/[—~～至-]/).map((x) => cnNumber(x.replace(/^第/, "").trim()));
        const isLast = k === items.length - 1;
        if (range.length === 2 && range[0] !== null && range[1] !== null && range[1]! >= range[0]! && range[1]! - range[0]! <= 30) {
          for (let a = range[0]!; a <= range[1]!; a++) out.push({ law: LAW_OF[h[0]]!, article: a, para: null });
        } else if (range.length === 1 && range[0] !== null) {
          out.push({ law: LAW_OF[h[0]]!, article: range[0]!, para: isLast ? para : null });
        }
      });
    }
  });
  return out;
}

/** 依据命中程序期间目录的哪一类；同一行命中两类、或有境外当事人的条文，返回 "ambiguous"。 */
function catalogOf(refs: readonly StatuteRef[], hay: string, start: string | null): ProceduralPeriodType | "ambiguous" | null {
  const types = new Set<ProceduralPeriodType>();
  let ambiguous = false;
  for (const r of refs) {
    if (r.law === "MS") {
      if (r.article === 171) {
        if (r.para === 1) types.add("appeal_judgment");
        else if (r.para === 2) types.add("appeal_ruling");
        else if (/裁定/.test(hay) && !/判决/.test(hay)) types.add("appeal_ruling");
        else if (/判决/.test(hay) && !/裁定/.test(hay)) types.add("appeal_judgment");
        else ambiguous = true;
      } else if (r.article === 128) types.add("defense_first_instance");
      else if (r.article === 174) types.add("defense_appeal");
      else if (r.article === 250) types.add("enforcement_application");
      else if (r.article === 216) types.add("retrial_application");
      else if (r.article === 104 && r.para === 3) types.add("pre_action_preservation_suit");
      else if (r.article === 111) types.add("preservation_reconsideration");
      else if (r.article === 236) types.add("enforcement_objection_review");
      else if (r.article === 238) types.add("third_party_objection_suit");
      else if (r.article === 227 && (r.para === 2 || (r.para === null && /异议/.test(hay)))) types.add("payment_order_objection");
      else if (r.article === 59 && r.para === 3) types.add("third_party_revocation_suit");
      else if (r.article === 285 || r.article === 286) ambiguous = true; // 境内没有住所的当事人：三十日
    } else if (r.law === "MSJ") {
      if (r.article === 171) types.add("preservation_reconsideration");
    } else if (r.law === "LD") {
      if (r.article === 30) types.add("labor_arbitration_defense");
      else if (r.article === 48 || r.article === 50) types.add("labor_award_suit");
      else if (r.article === 49) types.add("labor_award_setaside_employer");
      else if (r.article === 27) types.add("labor_arbitration_limitation");
    } else if (r.law === "MFD") {
      if (r.article === 188) types.add("civil_limitation");
    } else if (r.law === "ZCF") {
      // 新旧仲裁法以收到裁决书的日子分界（2026-03-01）；条号与起算日对不上的不复算（跨施行日的时间效力由律师判断）
      if (start && ((r.article === 72 && start >= "2026-03-01") || (r.article === 59 && start < "2026-03-01"))) types.add("arbitration_award_setaside");
      else if (r.article === 72 || r.article === 59) ambiguous = true;
    }
  }
  if (ambiguous || types.size > 1) return "ambiguous";
  return types.size === 1 ? [...types][0]! : null;
}

/**
 * 只靠依据条号定期间时，这一行须是在说这一类期限（防止依据里顺带引的条文被当成本行的期间）。
 * 目录以后新增的类型没有登记在这里的，不单凭条号复算（要求文字里写出期间）。
 */
const CATALOG_WORD: Partial<Record<ProceduralPeriodType, RegExp>> = {
  appeal_judgment: /上诉/,
  appeal_ruling: /上诉/,
  defense_first_instance: /答辩/,
  defense_appeal: /答辩/,
  labor_arbitration_defense: /答辩/,
  labor_award_suit: /起诉|诉讼/,
  labor_award_setaside_employer: /撤销/,
  arbitration_award_setaside: /撤销/,
  pre_action_preservation_suit: /保全/,
  enforcement_application: /执行/,
  retrial_application: /再审/,
  preservation_expiry: /(?!)/,
  preservation_renewal: /(?!)/,
  civil_limitation: /时效/,
  labor_arbitration_limitation: /时效/,
  preservation_reconsideration: /复议/,
  enforcement_objection_review: /复议/,
  third_party_objection_suit: /起诉|之诉|诉讼/,
  payment_order_objection: /支付令/,
  third_party_revocation_suit: /撤销之诉/,
};

// ───────────────────────── 表头角色 ─────────────────────────

interface Roles {
  deadline: number[];
  start: number[];
  precision: number[];
  interrupt: number[];
  basis: number[];
  period: number[];
  name: number[];
  calc: number[];
}

const h = (c: unknown): string => (c === null || c === undefined ? "" : String(c)).replace(/\s+/g, "");

function rolesOf(columns: readonly (string | number | null)[]): Roles | null {
  const hs = columns.map(h);
  // 分段计算表（起算日（含）/ 截止日（含）/ 日数）是利息、违约金的计算区间，不是期限表
  if (hs.some((x) => /^(?:日数|天数|计息天数)$/.test(x) || /（含/.test(x))) return null;
  const r: Roles = { deadline: [], start: [], precision: [], interrupt: [], basis: [], period: [], name: [], calc: [] };
  hs.forEach((x, i) => {
    if (!x) return;
    if (/届满日|期满日|到期日|最后一日|^截止日/.test(x) && !/起算/.test(x)) r.deadline.push(i);
    if (/起算/.test(x) && !/精度/.test(x)) r.start.push(i);
    if (/精度/.test(x)) r.precision.push(i);
    if (/中断|中止/.test(x) && !/起算/.test(x)) r.interrupt.push(i);
    if (/依据|条号|^(?:合同|依据|适用)?条款$/.test(x)) r.basis.push(i);
    if (/期间|时效类型|期限类型|计算规则|期限口径|履行期限|期限或条件|起算及期间|类别与起算/.test(x)) r.period.push(i);
    if (/^(?:期限|期限或事项|节点|事项|期间名称|期限类型|请求|类别|权利或请求|义务内容|决策事项|类别与请求|权利|项目|期限名称|程序节点)$/.test(x)) r.name.push(i);
    if (/计算过程|计算说明|计算/.test(x) && !r.deadline.includes(i)) r.calc.push(i);
  });
  return r.deadline.length > 0 ? r : null;
}

// ───────────────────────── 不报的情形 ─────────────────────────

/** 法院、仲裁机构指定的期限（通知书、传票、判项载明的）：期间由指定的文书定，不按法定期间复算。 */
const COURT_SET =
  /法院指定|(?:仲裁庭|仲裁委员会|仲裁委|人民法院|法院)(?:另行)?(?:指定|确定|通知)|指定(?:的)?(?:期限|期间|日期)|以[^；;。]{0,14}(?:通知书?|传票|裁定书?|决定书?|载明)[^；;。]{0,4}为准|传票|举证通知|应诉通知|开庭通知|受理通知|缴费通知|判决第|裁定第|判项|调解书|开庭|庭审/;
/** 起算事实不确定。 */
const START_UNSURE = /待确认|待核|待补|待查|待证|不明|推定|未知|不确定|只到月|大约|左右|前后|大概/;
/** 届满日本身是待定、分支或不适用。 */
const DEADLINE_UNSURE = /待核|待确认|待定|分支|暂定|不适用|尚未起算|无固定|另行/;
/** 一行写明了按“开始当日不计入”计算（约定期限只有写明了才复算，民法典第二百零四条允许另行约定）。 */
const CIVIL_STATED = /不计入|次日起|次日开始|为第\s*[1一]\s*日|起算日不计入|对应日/;
/** 引了法律、法规或司法解释的条文。 */
const STATUTE_CITED = /(?:法|条例|规定|解释|规则|办法)》?\s*第\s*[\d零〇一二两三四五六七八九十百千]+\s*条/;

interface Computed {
  start: string;
  period: PeriodSpec;
  label: string;
  deadline: string;
  nominal: string;
}

function nominalOf(start: string, p: PeriodSpec): string {
  if (p.unit === "day") return addDays(start, p.n);
  if (p.unit === "workday") return "";
  const months = p.unit === "year" ? p.n * 12 : p.n;
  const sy = Number(start.slice(0, 4));
  const sm = Number(start.slice(5, 7));
  const sd = Number(start.slice(8, 10));
  const idx = sy * 12 + (sm - 1) + months;
  const ty = Math.floor(idx / 12);
  const tm = (idx % 12) + 1;
  return `${ty}-${pad(tm)}-${pad(Math.min(sd, daysInMonth(ty, tm)))}`;
}

/** 复算结论是否确定：涉及的年份放假安排都已收录；或前后两周内没有法定节日（只受周末影响）；或写的日子比名义末日还早。 */
function certain(c: Computed, written: string): boolean {
  const lo = c.period.unit === "workday" ? c.start : [c.nominal, written].sort()[0]!;
  const hi = [c.deadline, written].sort()[1]!;
  const years = new Set<number>();
  for (let y = Number(c.start.slice(0, 4)); y <= Number(hi.slice(0, 4)); y++) years.add(y);
  if ([...years].every((y) => holidayYear(y) !== undefined)) return true;
  if (c.period.unit !== "workday" && written < c.nominal) return true;
  for (let d = addDays(lo, -14); d <= addDays(hi, 14); d = addDays(d, 1)) {
    if (holidayYear(Number(d.slice(0, 4))) === undefined && dayStatus(d).kind === "holiday") return false;
  }
  return true;
}

// ───────────────────────── 主检查 ─────────────────────────

const WEEKDAY = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;
/** 名义末日为何是休假日：周末写周几，节日写节日名。 */
function restWhy(date: string): string {
  const s = dayStatus(date);
  if (s.kind === "holiday") return s.name ? `（${s.name}）` : "";
  if (s.kind === "weekend") return `（${WEEKDAY[new Date(`${date}T00:00:00Z`).getUTCDay()]}）`;
  return "";
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const EMPTY_BASIS = /^[\s—\-－/／、无暂空缺]*$/;

function compute(start: string, opt: { type?: ProceduralPeriodType; period?: PeriodSpec }): Computed[] {
  if (opt.type) {
    const spec = proceduralPeriod(opt.type, { start });
    if (!spec) return [];
    const r = calcDeadline({ start, type: opt.type });
    const out: Computed[] = [];
    const main: PeriodSpec = { unit: spec.period.unit, n: spec.period.n, rule: "civil" };
    const basis = spec.basis.map((b) => `${b.law.replace(/^中华人民共和国/, "")}${b.article.replace(/（.*$/, "")}`).join("、");
    if (r.deadline) out.push({ start, period: main, label: `${periodLabel(main)}（${spec.label.replace(/（(.*?)）/g, "，$1")}；${basis}）`, deadline: r.deadline, nominal: nominalOf(start, main) });
    if (spec.alt && r.alt_deadline?.deadline) {
      const alt: PeriodSpec = { unit: "workday", n: spec.alt.period.n, rule: "workday" };
      out.push({ start, period: alt, label: `${periodLabel(alt)}（${spec.alt.label}）`, deadline: r.alt_deadline.deadline, nominal: "" });
    }
    return out;
  }
  const p = opt.period!;
  const r = calcDeadline({ start, period: { unit: p.unit, n: p.n }, rule: p.rule });
  return r.deadline ? [{ start, period: p, label: periodLabel(p), deadline: r.deadline, nominal: nominalOf(start, p) }] : [];
}

interface RowCtx {
  doc: AmountDoc;
  row: AmountRow;
  roles: Roles;
  cells: string[];
  prevBasisFilled: boolean | null;
}

function labelOf(ctx: RowCtx): string {
  for (const i of ctx.roles.name) if (ctx.cells[i]?.trim()) return oneLine(ctx.cells[i]!);
  for (const c of ctx.cells) if (c.trim() && !/^\d+(?:\.\d+)?$/.test(c.trim()) && fullDates(c).length === 0) return oneLine(c);
  return "";
}

function checkRow(ctx: RowCtx, out: DeadlineIssue[]): void {
  const { roles, cells, row, doc } = ctx;
  const join = (idx: number[]): string => idx.map((i) => cells[i] ?? "").filter((s) => s.trim()).join("；");
  const label = labelOf(ctx);
  const startIdx = roles.start.some((i) => /起算日/.test(h(row.columns?.[i]))) ? roles.start.filter((i) => /起算日/.test(h(row.columns?.[i]))) : roles.start;
  const startText = join(startIdx);
  const calcText = join(roles.calc);
  const basisText = join(roles.basis);
  const nameText = join(roles.name);
  const periodText = join(roles.period.filter((i) => !startIdx.includes(i) || /期间|时效类型|期限类型/.test(h(row.columns?.[i]))));
  // 法院指定的期限看起算、计算过程以外的各栏
  const courtHay = cells.filter((_, i) => !startIdx.includes(i) && !roles.calc.includes(i)).join("｜");
  if (COURT_SET.test(courtHay)) return;

  for (const di of roles.deadline) {
    const dCell = cells[di] ?? "";
    const dHead = h(row.columns?.[di]);
    const written = fullDates(dCell);
    if (written.length === 0) continue;
    if (DEADLINE_UNSURE.test(dCell) || /\d{1,2}\s*[:：]\s*\d{2}/.test(dCell)) continue;
    const where = `${row.where}“${dHead}”栏`;
    const text = clip(oneLine([label, startText && `起算：${startText}`, `${dHead}：${dCell}`].filter(Boolean).join("｜")), 80);

    // D1 依据为空
    if (roles.basis.length > 0 && roles.basis.every((i) => EMPTY_BASIS.test(cells[i] ?? ""))) {
      const bHead = h(row.columns?.[roles.basis[0]!]);
      out.push({
        key: `deadline-basis|${doc.filename}|${clip(label.replace(/\s+/g, ""), 30)}|${written.map((w) => w.iso).join(",")}`,
        filename: doc.filename,
        where,
        text,
        problem: `届满日写了 ${written.map((w) => w.iso).join("、")}，同一行“${bHead}”栏是空的：这个日子按哪条规定或哪项约定算出来无从核对`,
        fix: `在“${bHead}”栏写明期间的依据（法律名称与条款号，或合同条款）；法院、仲裁机构指定的期限写明“以××通知书载明为准”`,
        // Word 表格的纵向合并单元格读出来是空的：上一行有依据的，可能是合并，只列提示
        must: !(doc.kind === "docx" && ctx.prevBasisFilled === true),
      });
    }

    // D2 复算
    if (roles.deadline.length > 1 || startIdx.length === 0) continue;
    const startDates = fullDates(startText);
    if (startDates.length === 0) continue;
    const uniq = [...new Set(startDates.map((d) => d.iso))];
    if (uniq.length !== 1 || hasPartialDate(startText)) continue;
    if (START_UNSURE.test(startText) || START_UNSURE.test(join(roles.precision))) continue;
    const d = uniq[0]!;
    // 中断事由一栏写了别的日子：起算日应是中断日，这一行的起算事实不是计算起点
    if (fullDates(join(roles.interrupt)).some((x) => x.iso !== d)) continue;
    // 计算过程写明的起算点与起算事实差一天以上：起算事实里的日子不是计算起点（例如维修完成日推出的付款期）
    const anchors: string[][] = [];
    const ct = norm(calcText);
    for (const m of ct.matchAll(new RegExp(`${FULL_DATE.source}\\s*(?:当日)?\\s*(不计入|的?次日(?:起|开始)|起算|为第\\s*[1一]\\s*日)`, "g"))) {
      const iso = validDate(Number(m[1]), Number(m[2]), Number(m[3]));
      if (!iso) continue;
      const how = m[4]!;
      anchors.push(/不计入|次日/.test(how) ? [iso] : /第/.test(how) ? [addDays(iso, -1)] : [iso, addDays(iso, -1)]);
    }
    if (anchors.some((cands) => cands.every((e) => Math.abs(dayDiff(e, d)) > 1))) continue;

    const nameHay = `${row.where}｜${nameText}｜${periodText}｜${basisText}`;
    // 向前数的期限（提前五日通知、届满七日前申请续行、交割日倒排）：不顺延、方向相反，不在复算范围内
    if (/倒排|倒推|向前数|往前数|提前/.test(`${nameHay}｜${startText}｜${calcText}`)) continue;
    const scan = scanPeriods(`${nameText}；${periodText}`);
    if (scan.unsupported) continue;
    const refs = statuteRefs(`${nameText}；${periodText}；${basisText}`);
    const cat = catalogOf(refs, `${nameHay}｜${startText}`, d);
    // 时效期间由法律规定、约定无效（民法典第一百九十七条第一款），时效表里的行一律按法定期间对待
    const statutory = refs.length > 0 || STATUTE_CITED.test(`${nameText}；${periodText}；${basisText}`) || /时效/.test(nameHay);

    const opts: { type?: ProceduralPeriodType; period?: PeriodSpec }[] = [];
    if (cat && cat !== "ambiguous") {
      const spec = proceduralPeriod(cat, { start: d });
      if (!spec) continue;
      const allowed = new Set([periodKey({ unit: spec.period.unit, n: spec.period.n, rule: "civil" }), ...(spec.alt ? [periodKey({ unit: "workday", n: spec.alt.period.n, rule: "workday" })] : [])]);
      if (scan.periods.some((p) => !allowed.has(periodKey(p)))) continue; // 文字写的期间与目录不一致：不猜
      if (scan.periods.length === 0 && !CATALOG_WORD[cat]?.test(nameHay)) continue;
      opts.push({ type: cat });
    } else {
      if (cat === "ambiguous" && scan.periods.length === 0) continue;
      if (scan.periods.length === 1) opts.push({ period: scan.periods[0]! });
      else if (scan.periods.length === 2 && scan.periods[0]!.n === scan.periods[1]!.n && new Set(scan.periods.map((p) => p.unit)).size === 2 && scan.periods.some((p) => p.unit === "workday") && scan.periods.some((p) => p.unit === "day")) {
        opts.push({ period: scan.periods[0]! }, { period: scan.periods[1]! });
      } else continue;
      // 约定期限：没写明“开始当日不计入”的不复算
      if (!statutory && !CIVIL_STATED.test(cells.join("｜"))) continue;
    }
    // 起算事实写成“自某日起算”的，某日可能是第 1 日：两种读法都算对上
    const starts = new RegExp(`(?:自\\s*)?${FULL_DATE.source}\\s*(?:起算|起计)`).test(norm(startText)) && !/次日/.test(startText) ? [d, addDays(d, -1)] : [d];
    let comps: Computed[];
    try {
      comps = starts.flatMap((s) => opts.flatMap((o) => compute(s, o)));
    } catch {
      continue;
    }
    if (comps.length === 0) continue;
    const primary = comps.find((c) => c.start === d) ?? comps[0]!;
    // 约定期限不强求顺延（民法典第二百零四条）：没写“顺延”的，名义末日也算对上
    const lenient = !statutory && !(/顺延/.test(cells.join("｜")) && !/不顺延/.test(cells.join("｜")));
    const accepted = (c: Computed): string[] => (lenient && c.nominal ? [c.deadline, c.nominal] : [c.deadline]);

    const report = (w: string, cs: Computed[], segment: string): void => {
      const c = cs.find((x) => x.start === d) ?? cs[0]!;
      const sure = cs.every((x) => certain(x, w));
      const ext = c.nominal && c.nominal !== c.deadline ? `（名义末日 ${c.nominal} 是法定休假日${restWhy(c.nominal)}，顺延至休假日结束的次日 ${c.deadline}，民法典第二百零三条第一款）` : "";
      const alts = cs.filter((x) => x !== c && x.start === c.start).map((x) => `；${x.label}复算是 ${x.deadline}`).join("");
      const pending = sure ? "" : `；其中涉及放假安排尚未公布的年份，复算只按周末与法定节日顺延，以当年国务院办公厅放假通知为准`;
      out.push({
        key: `deadline|${doc.filename}|${clip(label.replace(/\s+/g, ""), 30)}|${w}`,
        filename: doc.filename,
        where,
        text: segment === dCell ? text : clip(oneLine(`${label}｜${segment}`), 80),
        problem: `写的是 ${w}，按起算日 ${c.start}、期间 ${c.label}${c.label.endsWith("）") ? "" : " "}复算是 ${c.deadline}${ext}${alts}${pending}`,
        fix: `届满日改为 ${c.deadline}：用 calc.deadline 以起算日 ${c.start}、期间 ${c.label} 重算，计算过程与提醒里的日子一并改正；如果是起算事实或期间写错了，先改正再重算，三处保持一致`,
        must: sure,
      });
    };

    const writtenUniq = [...new Set(written.map((w) => w.iso))];
    if (writtenUniq.length === 1) {
      const w = writtenUniq[0]!;
      if (!comps.some((c) => accepted(c).includes(w))) report(w, comps, dCell);
      continue;
    }
    // 一格并列几种口径：只核对写明“工作日 / 自然日 / 日历日”的那几段，各自对上即可
    for (const seg of norm(dCell).split(/[；;。\n]/)) {
      const ds = fullDates(seg);
      if (ds.length !== 1) continue;
      const isWork = /工作日/.test(seg);
      const isCal = /自然日|日历日/.test(seg);
      if (isWork === isCal) continue;
      const cs = comps.filter((c) => (isWork ? c.period.unit === "workday" : c.period.unit !== "workday"));
      if (cs.length === 0) continue;
      if (!cs.some((c) => accepted(c).includes(ds[0]!.iso))) report(ds[0]!.iso, cs, oneLine(seg));
    }
  }
}

/** 对一组文书与表格做期限复算。纯函数；读不懂的行跳过。 */
export function checkDeadlines(docs: AmountDoc[]): DeadlineIssue[] {
  const out: DeadlineIssue[] = [];
  for (const doc of docs) {
    let prevSig = "";
    let prevBasisFilled: boolean | null = null;
    for (const row of doc.rows ?? []) {
      const columns = row.columns ?? [];
      const sig = `${row.where.replace(/\s*(?:表格)?第\s*\d+\s*行$/, "")}|${columns.map(h).join("|")}`;
      if (sig !== prevSig) prevBasisFilled = null;
      prevSig = sig;
      const roles = rolesOf(columns);
      if (!roles) continue;
      const dateCols = new Set([...roles.deadline, ...roles.start]);
      const cells = columns.map((_, i) => cellText(row.cells[i], dateCols.has(i)));
      try {
        checkRow({ doc, row, roles, cells, prevBasisFilled }, out);
      } catch {
        // 单行读不懂不影响其他行
      }
      prevBasisFilled = roles.basis.length > 0 ? roles.basis.some((i) => !EMPTY_BASIS.test(cells[i] ?? "")) : null;
    }
  }
  const seen = new Set<string>();
  return out.filter((i) => (seen.has(i.key) ? false : (seen.add(i.key), true)));
}

/** 对本任务最新版成果做期限复算（取文件的口径与金额勾稽相同）。出错时返回空（不因核对本身的缺陷拦住交付）。 */
export function runDeadlineIssues(deps: { db: KernelDb; blobs: BlobStore }, runId: string, matterId: string): DeadlineIssue[] {
  try {
    const docs = latestAmountDocs(deps, runId, matterId);
    return docs.length === 0 ? [] : checkDeadlines(docs);
  } catch {
    return [];
  }
}

/** 期限复算结果写成复核意见（接在模型意见之后编号；依据一栏与金额勾稽同为 MACHINE_BASIS，回看时由内核重跑）。纯函数。 */
export function deadlineFindings(issues: readonly DeadlineIssue[], startNo: number): (ReviewFinding & { machine_key: string })[] {
  const ordered = [...issues].sort((a, b) => Number(b.must) - Number(a.must));
  return ordered.slice(0, MACHINE_FINDINGS_MAX).map((i, k) => ({
    no: startNo + k,
    where: `《${i.filename}》${i.where}`,
    problem: i.problem,
    basis: MACHINE_BASIS,
    fix: i.fix,
    must: i.must,
    level: i.must ? ("must" as const) : ("recheck" as const),
    machine_key: i.key,
  }));
}
