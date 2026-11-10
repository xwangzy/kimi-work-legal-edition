/**
 * S2 案卷整理（第 3 篇 S2）：入库 → 事实抽取（带锚点）→ 时间轴 → 目录/矩阵/补证/质量报告。
 *
 * 诚实边界（v0 确定性版）：
 * - 事实抽取只覆盖规则可判的日期/金额/主体，类型标签一律“材料记载”（不推断）；v9.3 第 15 批 B-5 补：中文数字日期（二〇二三年三月五日）、
 *   大写与中文数字金额（人民币壹拾万元整、十万元）、没有年份的日期（3月5日：不猜年份，时间线上排在最后并写明“年份不明”）；
 * - 争点的拆解与证据对应是第二段（“争点与证据分析”，Agent + issue-evidence-matrix 方法），这里只按律师给的争点列框架；
 * - 争点矩阵为骨架（争点由律师填写/确认），不擅自认定证明力（专项零违例）；
 * - 同日同额不自动合并（专项零违例）；
 * - 原件永不修改；解析失败只交目录与缺口，停止实体结论（§2.6）。
 */
import { sha256Hex, newId } from "@zr-legal/domain";
import { createDocx, createXlsx } from "@zr-legal/docx-engine";
import type { KernelDb } from "../db.ts";

export interface FactRow {
  kind: "date" | "amount" | "party";
  text: string; // 原文
  normalized: string; // 归一化（ISO 日期 / 金额数值）
  document_version_id: string;
  parse_version_id: string;
  filename: string;
  char_start: number;
  char_end: number;
  /** 文件页码（parse_texts 以 \f 换页分隔时由字符区间换算；无 \f 的非 PDF 材料为 null）。 */
  file_page: number | null;
  assertion: "material_record"; // 只标材料记载
  /** 同一处大写与小写金额对不上（如“肆拾伍万伍仟元整（¥445,000.00）”）：写明两处数额，补证清单列为待核（V14 第 39 批） */
  conflict?: string;
}

/** 字符区间 → 文件页码（\f 换页符计数；无 \f 即无页码映射，如实返回 null）。 */
export function filePageOf(text: string, charStart: number): number | null {
  if (!text.includes("\f")) return null;
  let page = 1;
  for (let i = 0; i < charStart && i < text.length; i++) if (text.charCodeAt(i) === 0x0c) page += 1;
  return page;
}

// 年月日之间允许空白（PDF、OCR 文本常见“2023 年 3 月 5 日”，复核 R15B-17）
const DATE_RES = [
  /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g,
  /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/g,
];
/** 中文数字日期：二〇二三年三月五日、二零二三年十二月三十一日、二〇二三年元月五日。 */
const CN_DATE_RE = /([〇零○一二三四五六七八九]{4})年(元|[一二三四五六七八九十]{1,2})月([一二三四五六七八九十]{1,3})日/g;
/** 没有年份的日期：3月5日、三月五日、元月八日（前面紧挨着“年”或数字的不算，那是完整日期的一部分）。 */
const NO_YEAR_RE = /(?<![年\d〇零○一二三四五六七八九十\s])(\d{1,2}|元|[一二三四五六七八九十]{1,2})月(\d{1,2}|[一二三四五六七八九十]{1,3})日/g;
/** 相对年份的日期：同年 / 次年 / 当年 / 今年 / 去年……3月5日——年份不明，原文里带着相对年份（复核 R15B-17）。 */
const RELATIVE_DATE_RE = /(同年|次年|当年|今年|去年|上年|翌年|前年|本年)\s*(\d{1,2}|元|[一二三四五六七八九十]{1,2})\s*月\s*(\d{1,2}|[一二三四五六七八九十]{1,3})\s*日/g;
const AMOUNT_RE = /(人民币|￥|¥)?\s*(?<![\d.])([\d,]+(?:\.\d+)?)\s*(万元|元)/g;
/** 阿拉伯数字与千、百、万、亿混写：5千元、3万5千元、3百万元、2千万元（复核 R15B-06）。 */
/** 只有货币符号、没写“元”的小写金额（“（¥445,000.00）”）：V14 第 39 批真实走查，催款函里这类小写金额原先摘不出，大小写不一致也就发现不了。 */
const SYMBOL_AMOUNT_RE = /(￥|¥)\s*([\d,]+(?:\.\d+)?)(?!\s*(?:万元|元|[\d.,]))/g;
const MIXED_AMOUNT_RE = /(人民币|￥|¥)?\s*(?<![\d.])((?:\d+(?:\.\d+)?[千百万亿])+\d*)\s*元/g;
/**
 * 大写或中文数字金额：人民币壹拾万元整、壹佰贰拾叁万肆仟伍佰元、十万元、三千五百元（须以“元 / 圆”结尾，可带角分与“整”）。
 * 前面紧挨着数字、“数 / 几 / 上 / 近 / 逾 / 余 / 约”或别的数字的不算（“5千元”“数千万元”，复核 R15B-06）。
 */
const CN_AMOUNT_RE = /(人民币)?(?<![\d.数几上近逾余约零〇壹贰叁肆伍陆柒捌玖拾佰仟萬万亿億两一二三四五六七八九十百千])([零〇壹贰叁肆伍陆柒捌玖拾佰仟萬万亿億两一二三四五六七八九十百千]{1,20})[元圆](?:([零〇壹贰叁肆伍陆柒捌玖一二三四五六七八九])角)?(?:([零〇壹贰叁肆伍陆柒捌玖一二三四五六七八九])分)?(整|正)?/g;
/** 只有一个小写数字加“元”（“一元”“二元”）时要有金额语境，免得“统一元”“二元结构”“三元食品”被当成金额。 */
const MONEY_CONTEXT = /(人民币|金额|价款|货款|借款|款项|支付|共计|合计|计|赔偿|费用|租金|利息|罚款)\s*$/;

/** 阿拉伯数字与单位混写 → 元：3万5千 = 35000、2千万 = 20000000。 */
export function mixedAmountToNumber(s: string): number | null {
  let total = 0;
  let section = 0;
  let current: number | null = null;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)|([千百万亿])/g)) {
    if (m[1]) {
      current = Number(m[1]);
      continue;
    }
    const u = m[2]!;
    if (u === "千" || u === "百") {
      section += (current ?? 1) * (u === "千" ? 1000 : 100);
      current = null;
    } else {
      total += (section + (current ?? 0)) * (u === "万" ? 1e4 : 1e8);
      section = 0;
      current = null;
    }
  }
  const v = total + section + (current ?? 0);
  return Number.isFinite(v) && v > 0 ? v : null;
}

const CN_DIGIT: Record<string, number> = { 零: 0, 〇: 0, "○": 0, 壹: 1, 一: 1, 贰: 2, 二: 2, 两: 2, 叁: 3, 三: 3, 肆: 4, 四: 4, 伍: 5, 五: 5, 陆: 6, 六: 6, 柒: 7, 七: 7, 捌: 8, 八: 8, 玖: 9, 九: 9 };
const CN_UNIT: Record<string, number> = { 拾: 10, 十: 10, 佰: 100, 百: 100, 仟: 1000, 千: 1000 };
const CN_BIG: Record<string, number> = { 万: 1e4, 萬: 1e4, 亿: 1e8, 億: 1e8 };

/** 中文数字（大写或小写，含万、亿）→ 整数；认不出返回 null。 */
export function cnAmountToInt(s: string): number | null {
  let total = 0;
  let section = 0;
  let digit = 0;
  let seen = false;
  for (const ch of s) {
    if (ch in CN_DIGIT) {
      digit = CN_DIGIT[ch]!;
      seen = true;
    } else if (ch in CN_UNIT) {
      // “十二”“一万零十”：单位前没有数字（或只有零）按一计
      section += (digit === 0 ? 1 : digit) * CN_UNIT[ch]!;
      digit = 0;
      seen = true;
    } else if (ch in CN_BIG) {
      total += (section + digit) * CN_BIG[ch]!;
      section = 0;
      digit = 0;
    } else return null;
  }
  const v = total + section + digit;
  return seen ? v : null;
}

/** 年份逐位：二〇二三 → 2023。 */
function cnYear(s: string): number | null {
  let y = 0;
  for (const ch of s) {
    const d = CN_DIGIT[ch];
    if (d === undefined) return null;
    y = y * 10 + d;
  }
  return y;
}

const smallCn = (s: string): number | null => (/^\d+$/.test(s) ? Number(s) : cnAmountToInt(s));
const PARTY_RE = /(甲方|乙方|丙方|委托方|受托方|借款人|出借人|担保人)[:：]\s*([^\s，。；、（）()]{2,30})/g;

export function extractFacts(doc: { document_version_id: string; parse_version_id: string; filename: string; text: string }): FactRow[] {
  const out: FactRow[] = [];
  const { text } = doc;
  const push = (kind: FactRow["kind"], m: RegExpMatchArray, normalized: string) =>
    out.push({
      kind,
      text: m[0],
      normalized,
      document_version_id: doc.document_version_id,
      parse_version_id: doc.parse_version_id,
      filename: doc.filename,
      char_start: m.index!,
      file_page: filePageOf(text, m.index!),
      char_end: m.index! + m[0].length,
      assertion: "material_record",
    });
  for (const re of DATE_RES) {
    for (const m of text.matchAll(re)) {
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
      const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      out.push({
        kind: "date",
        text: m[0],
        normalized: iso,
        document_version_id: doc.document_version_id,
        parse_version_id: doc.parse_version_id,
        filename: doc.filename,
        char_start: m.index!,
        file_page: filePageOf(text, m.index!),
        char_end: m.index! + m[0].length,
        assertion: "material_record",
      });
    }
  }
  const monthOf = (t: string) => (t === "元" ? 1 : /^\d+$/.test(t) ? Number(t) : cnAmountToInt(t));
  for (const m of text.matchAll(CN_DATE_RE)) {
    const [y, mo, d] = [cnYear(m[1]!), monthOf(m[2]!), cnAmountToInt(m[3]!)];
    if (y === null || mo === null || d === null || mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    push("date", m, `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  }
  for (const m of text.matchAll(RELATIVE_DATE_RE)) {
    const [mo, d] = [monthOf(m[2]!), smallCn(m[3]!)];
    if (mo === null || d === null || mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    push("date", m, `年份不明-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  }
  for (const m of text.matchAll(NO_YEAR_RE)) {
    const [mo, d] = [monthOf(m[1]!), smallCn(m[2]!)];
    if (mo === null || d === null || mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    // 不猜年份：归一值以“年份不明”开头，时间线上排在有年份的事实之后
    push("date", m, `年份不明-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  }
  for (const m of text.matchAll(MIXED_AMOUNT_RE)) {
    if (!/[千百]|万\d/.test(m[2]!)) continue; // 纯“数字 + 万元 / 元”由下面的规则处理
    const v = mixedAmountToNumber(m[2]!);
    if (v !== null) push("amount", m, `${v} 元`);
  }
  for (const m of text.matchAll(CN_AMOUNT_RE)) {
    const yuan = cnAmountToInt(m[2]!);
    if (yuan === null || yuan === 0) continue;
    if (m[2]!.length === 1 && !m[1] && !MONEY_CONTEXT.test(text.slice(Math.max(0, m.index! - 8), m.index!))) continue;
    const jiao = m[3] ? (CN_DIGIT[m[3]] ?? 0) : 0;
    const fen = m[4] ? (CN_DIGIT[m[4]] ?? 0) : 0;
    push("amount", m, `${Math.round((yuan + jiao / 10 + fen / 100) * 100) / 100} 元`);
  }
  for (const m of text.matchAll(AMOUNT_RE)) {
    const value = Number(m[2]!.replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    const yuan = m[3] === "万元" ? value * 10000 : value;
    out.push({
      kind: "amount",
      text: m[0],
      normalized: `${yuan} 元`,
      document_version_id: doc.document_version_id,
      parse_version_id: doc.parse_version_id,
      filename: doc.filename,
      char_start: m.index!,
      file_page: filePageOf(text, m.index!),
      char_end: m.index! + m[0].length,
      assertion: "material_record",
    });
  }
  for (const m of text.matchAll(SYMBOL_AMOUNT_RE)) {
    const value = Number(m[2]!.replace(/,/g, ""));
    if (!Number.isFinite(value) || value === 0) continue;
    push("amount", m, `${value} 元`);
  }
  // 同一笔金额的大写与小写（“人民币壹拾万元整（小写：100,000元）”）是一件事：相距 20 字以内且金额相等的合并成一条，原文涵盖两处（复核 R15B-17）。
  // 相距 20 字以内、一处大写一处小写而数额不同的，不合并，两条都记下“大写与小写不一致”（V14 第 39 批：催款函大写 455,000、小写 445,000）
  const UPPER = /[壹贰叁肆伍陆柒捌玖拾佰仟]/;
  const amounts = out.filter((f) => f.kind === "amount").sort((a, b) => a.char_start - b.char_start);
  const drop = new Set<FactRow>();
  for (let i = 0; i < amounts.length; i += 1) {
    const a = amounts[i]!;
    if (drop.has(a)) continue;
    for (let j = i + 1; j < amounts.length; j += 1) {
      const b = amounts[j]!;
      if (b.char_start - a.char_end > 20) break;
      if (!drop.has(b) && b.normalized === a.normalized) {
        a.char_end = Math.max(a.char_end, b.char_end);
        a.text = text.slice(a.char_start, a.char_end);
        drop.add(b);
      } else if (!drop.has(b) && UPPER.test(a.text) !== UPPER.test(b.text) && /^[\s　]*[（(]?\s*(?:小写|大写)?\s*[：:]?\s*$/.test(text.slice(a.char_end, b.char_start))) {
        // 只认“大写（小写）”紧挨着写的一对（V14 第 39 批复测：前一句的付款额 200,000 元与下一句的大写 455,000 元被配成“不一致”）
        const [up, low] = UPPER.test(a.text) ? [a, b] : [b, a];
        const note = `大写“${up.text}”（${up.normalized}）与小写“${low.text}”（${low.normalized}）不一致`;
        a.conflict = note;
        b.conflict = note;
      }
    }
  }
  for (let i = out.length - 1; i >= 0; i -= 1) if (drop.has(out[i]!)) out.splice(i, 1);
  // 表格或分行写的“××（小写）｜9,135,420.00”“××（大写）｜人民币玖佰……元整”（V16 第 41 批真实走查 E1：结算书里大写、小写各占一行，
  // 小写没带“元”摘不出来，两行也不挨着，9,135,420 与大写 9,135,240 不一致没有查出，补证清单却写“没有发现”）：
  // 按行找标了“小写”“大写”的金额，同一名目（标注前面的字相同）且相隔不超过两行的配成一对比对
  // 小写一行有几个数的（“结算总价（小写）｜送审 9,372,760.00｜审定 9,135,420.00｜核减 237,340.00”）：有一个与大写相等就算一致；都不相等时拿最接近大写的那个来比，
  // 并写明这一行还有哪几个数——不能拿第一个数就说“不一致”（同批修复后复测：把送审金额当成了小写）
  type Cand = { text: string; value: number; start: number; fact?: FactRow };
  const labelled: { kind: "upper" | "lower"; name: string; line: number; fact?: FactRow; cands: Cand[] }[] = [];
  let lineStart = 0;
  text.split("\n").forEach((line, lineNo) => {
    const at = lineStart;
    lineStart += line.length + 1;
    const lab = /([^\s|｜（(：:]{0,16})\s*[（(]?\s*(小写|大写)\s*[)）]?/.exec(line);
    if (!lab) return;
    const name = lab[1]!.replace(/^(?:人民币|金额)$/, "");
    const inLine = (f: FactRow) => f.kind === "amount" && f.char_start >= at && f.char_start < at + line.length;
    if (lab[2] === "大写") {
      const f = out.find((x) => inLine(x) && UPPER.test(x.text));
      if (f) labelled.push({ kind: "upper", name, line: lineNo, fact: f, cands: [] });
      return;
    }
    const cands: Cand[] = out.filter((x) => inLine(x) && !UPPER.test(x.text)).map((x) => ({ text: x.text, value: Number.parseFloat(x.normalized), start: x.char_start, fact: x }));
    // 小写一栏常常只有数字，没有“元”：标注之后像金额的数（至少四位或带千分位、小数）
    const from = lab.index + lab[0].length;
    for (const num of line.slice(from).matchAll(/(?<![\d.,])((?:\d{1,3}(?:,\d{3})+|\d{4,})(?:\.\d{1,2})?)(?![\d,]|\.\d)/g)) {
      const value = Number(num[1]!.replace(/,/g, ""));
      const numAt = at + from + num.index;
      // 这个数已经在摘出的某条金额里（“人民币壹拾万元整（小写：100,000元）”合并成的一条）：不重复摘，也不再配对
      if (out.some((x) => x.kind === "amount" && x.char_start <= numAt && x.char_end >= numAt + num[1]!.length)) continue;
      if (Number.isFinite(value) && value > 0) cands.push({ text: num[1]!, value, start: numAt });
    }
    if (cands.length > 0) labelled.push({ kind: "lower", name, line: lineNo, cands: cands.sort((x, y) => x.start - y.start) });
  });
  const factOf = (c: Cand): FactRow => {
    if (c.fact) return c.fact;
    const f: FactRow = { kind: "amount", text: c.text, normalized: `${c.value} 元`, document_version_id: doc.document_version_id, parse_version_id: doc.parse_version_id, filename: doc.filename, char_start: c.start, char_end: c.start + c.text.length, file_page: filePageOf(text, c.start), assertion: "material_record" };
    out.push(f);
    c.fact = f;
    return f;
  };
  for (const low of labelled.filter((x) => x.kind === "lower")) {
    const up = labelled.filter((x) => x.kind === "upper" && x.name === low.name && Math.abs(x.line - low.line) <= 2).sort((a, b) => Math.abs(a.line - low.line) - Math.abs(b.line - low.line))[0];
    if (!up?.fact) {
      factOf(low.cands[0]!);
      continue;
    }
    const upValue = Number.parseFloat(up.fact.normalized);
    const same = low.cands.find((c) => c.value === upValue);
    const pick = same ?? [...low.cands].sort((x, y) => Math.abs(x.value - upValue) - Math.abs(y.value - upValue))[0]!;
    const lowFact = factOf(pick);
    if (same || up.fact.conflict || lowFact.conflict) continue;
    const others = low.cands.filter((c) => c !== pick).map((c) => c.text);
    const note =
      `${low.name ? `“${low.name}”的` : ""}大写“${up.fact.text}”（${up.fact.normalized}）与小写“${lowFact.text}”（${lowFact.normalized}）不一致` +
      (others.length > 0 ? `（小写这一行共 ${low.cands.length} 个数：${low.cands.map((c) => c.text).join("、")}，各是什么名目请看原表；没有一个与大写相等，这里拿数额最接近大写的 ${pick.text} 来比）` : "");
    up.fact.conflict = note;
    lowFact.conflict = note;
  }
  for (const m of text.matchAll(PARTY_RE)) {
    out.push({
      kind: "party",
      text: m[0],
      normalized: `${m[1]}=${m[2]}`,
      document_version_id: doc.document_version_id,
      parse_version_id: doc.parse_version_id,
      filename: doc.filename,
      char_start: m.index!,
      file_page: filePageOf(text, m.index!),
      char_end: m.index! + m[0].length,
      assertion: "material_record",
    });
  }
  return out;
}

/** S2 抽出的事实交给事实表（v9.3 复核 R15B-01）：按“同一份材料的同一句”合并，句子原文作引文，日期、金额、主体作字段；类型一律“材料记载”。 */
export interface FactSubmission {
  statement: string;
  kind: "claimed";
  occurred_on: string | null;
  amount_yuan: number | null;
  party: string | null;
  document_version_id: string;
  quote: string;
}

const SENTENCE_END = /[。；！？\n]/;

/** 事实所在的句子（不超过 200 字：过长时取命中处前后各 80 字）。 */
function sentenceAround(text: string, start: number, end: number): { start: number; end: number } {
  let a = start;
  while (a > 0 && !SENTENCE_END.test(text[a - 1]!)) a -= 1;
  let b = end;
  while (b < text.length && !SENTENCE_END.test(text[b]!)) b += 1;
  if (b < text.length && text[b] !== "\n") b += 1;
  if (b - a > 200) {
    a = Math.max(a, start - 80);
    b = Math.min(b, end + 80);
  }
  while (a < b && /\s/.test(text[a]!)) a += 1;
  while (b > a && /\s/.test(text[b - 1]!)) b -= 1;
  return { start: a, end: b };
}

export function factSubmissions(materials: { document_version_id: string; text: string }[], facts: FactRow[]): FactSubmission[] {
  const byKey = new Map<string, FactSubmission & { order: number }>();
  const textOf = new Map(materials.map((m) => [m.document_version_id, m.text]));
  for (const f of facts.slice().sort((x, y) => x.char_start - y.char_start)) {
    const text = textOf.get(f.document_version_id);
    if (text === undefined) continue;
    const s = sentenceAround(text, f.char_start, f.char_end);
    const key = `${f.document_version_id}\u0000${s.start}`;
    const quote = text.slice(s.start, s.end);
    if (!quote.trim()) continue;
    let row = byKey.get(key);
    if (!row) {
      row = { statement: quote, kind: "claimed", occurred_on: null, amount_yuan: null, party: null, document_version_id: f.document_version_id, quote, order: byKey.size };
      byKey.set(key, row);
    }
    if (f.kind === "date" && !row.occurred_on && /^\d{4}-\d{2}-\d{2}$/.test(f.normalized)) row.occurred_on = f.normalized;
    if (f.kind === "amount" && row.amount_yuan === null) row.amount_yuan = Number.parseFloat(f.normalized);
    if (f.kind === "party" && !row.party) row.party = f.normalized.split("=")[1] ?? null;
  }
  return [...byKey.values()].sort((x, y) => x.order - y.order).map(({ order: _o, ...r }) => r);
}

/** 锚点入库（§4.3 EvidenceAnchor：关键事实可定位——锚点错误为阻断项的验收基础；file_page 为文件页码）。 */
export function persistAnchors(db: KernelDb, facts: FactRow[]): number {
  // 同一事务写入（大案卷十几万条锚点：逐条自动提交要几秒，且中途失败会留下半截锚点）
  return db.tx(() => {
    let n = 0;
    for (const f of facts) {
      db.run(
        `INSERT INTO evidence_anchors (anchor_id, parse_version_id, page, paragraph, char_start, char_end, text_hash, file_page)
         VALUES (?,?,NULL,NULL,?,?,?,?)`,
        [newId("evidenceAnchor"), f.parse_version_id, f.char_start, f.char_end, sha256Hex(f.text), f.file_page],
      );
      n++;
    }
    return n;
  });
}

export interface S2DeliverableInput {
  runId: string;
  matter: { title: string; client_name: string | null; counterparty: string | null; stance: string };
  materials: {
    document_version_id: string;
    parse_version_id: string;
    filename: string;
    sha256: string;
    chars: number;
    quality_flags: string[];
    text: string;
    created_at?: string;
    page_count?: number | null | undefined;
    pages?: { pageNo: number; quality: string; note?: string | undefined }[] | undefined;
  }[];
  issues: string[]; // 用户提供的争点（可空）
}

export interface BuiltS2 {
  files: { kind: string; filename: string; bytes: Buffer; manifest: Record<string, unknown> }[];
  factsCount: { dates: number; amounts: number; parties: number };
  qualityNotes: string[];
}

/** 交付件文件名里的日期（v9.4：原来是任务编号尾巴“-b35186”，律师看不懂；同一天重复生成时由下载对话框处理重名）。 */
export function fileDay(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 原文位置：Word 与纯文本没有页码时按“第几字”标注——按读取后的文字计数（表格按行展开、空白归并），与 Word 的字数统计可能略有出入（复核 Q1-21）。 */
function charPos(start: number, end: number): string {
  return `第 ${start + 1}–${end} 字`;
}

/** 读取情况（律师话）：有读不出或识别不清的页时写出页数。 */
function readingLabel(m: { pages?: { pageNo: number; quality?: string }[] | undefined }): string {
  const bad = (m.pages ?? []).filter((p) => p.quality === "unreadable").length;
  const low = (m.pages ?? []).filter((p) => p.quality === "low").length;
  if (bad > 0) return `有 ${bad} 页读不出`;
  if (low > 0) return `有 ${low} 页识别不清`;
  return "已读取";
}

/** 解析器内部标记 → 律师看得懂的备注（与界面 lib/labels.ts 的读取说明同口径；未知标记不显示）。 */
function qualityRemark(flags: string[]): string {
  const notes: string[] = [];
  if (flags.includes("v0_crude_docx_parser") || flags.includes("comments_revisions_ignored")) notes.push("只读了正文文字（批注、修订痕迹未读）");
  if (flags.includes("tables_as_rows")) notes.push("表格按行读取");
  if (flags.some((f) => /ocr/i.test(f))) notes.push("扫描件经文字识别");
  return notes.join("；") || "—";
}

/** 文件名自然排序（“02-…”在“10-…”之前）：律师给材料编号，本机整理按编号列，不按勾选先后（V14 第 39 批：目录与证据目录原先是倒序）。 */
const byFilename = <T extends { filename: string }>(xs: readonly T[]): T[] => [...xs].sort((a, b) => a.filename.localeCompare(b.filename, "zh-Hans-CN", { numeric: true }));

/**
 * 陈述性质（V16 第 41 批真实走查 E1：全表 95 行都写“材料记载”，只有我方项目负责人一面之词的竣工验收日看不出来）：
 * 文件名表明是当事人一方自己的说明、陈述、访谈或笔记的，标“一方陈述，待其他材料印证”；其余照旧。只按文件名判断，不读内容定性。
 */
const natureOf = (filename: string): string =>
  /情况说明|陈述|访谈|笔记|口述|自述|备忘（内部）/.test(filename)
    ? "一方陈述，待其他材料印证"
    : // 一方发出的函件（催款函、回复函、律师函、通知）同样只是发函一方的说法（复评 N2：我方情况说明标了“一方陈述”，对方回函却是“材料记载”，对方的数字反而显得更可信）
      /函|通知书|告知书|声明/.test(filename)
      ? "发函一方所述，待其他材料印证"
      : "材料记载";

/** 材料里自己提到“还没提供、原件在别处、待补”的句子（同批：情况说明写着“回单原件在财务部，尚未提供给律师”，待补材料一栏却是空的）。 */
const MISSING_RE = /尚未提供|未提供给|暂未提供|没有提供|待补充|待补交|另行提供|后续提供|未找到|找不到|已遗失|遗失|未能调取|待调取|未留存/;

export function buildS2Deliverables(input0: S2DeliverableInput): BuiltS2 {
  const input = { ...input0, materials: byFilename(input0.materials) };
  const textOf = new Map(input.materials.map((m) => [m.document_version_id, m.text] as const));
  const facts = input.materials.flatMap((m) =>
    extractFacts({ document_version_id: m.document_version_id, parse_version_id: m.parse_version_id, filename: m.filename, text: m.text }),
  );
  const dates = facts.filter((f) => f.kind === "date");
  const amounts = facts.filter((f) => f.kind === "amount");
  const parties = facts.filter((f) => f.kind === "party");

  // 案卷总目录（编号/文件名/页数/读取情况；页数未知显式写出，不编造）。v9.4：律师要把它交给合伙人或客户——
  // 不再出现 sha256、字符数与解析器内部标记（完整性信息留在成果清单 manifest 里）
  const catalogRows: (string | number | null)[][] = [
    ["编号", "文件名", "页数", "原件/复制件", "读取情况", "备注"],
    ...input.materials.map((m, i) => [
      `D${i + 1}`,
      m.filename,
      m.page_count != null ? m.page_count : /\.docx$/i.test(m.filename) ? "Word 文件不分页" : "未计页",
      "电子复制件",
      readingLabel(m),
      qualityRemark(m.quality_flags ?? []),
    ] as (string | number | null)[]),
  ];

  // 不同材料对同一天的付款写了不同金额（V16 第 41 批真实走查 E1：2023-08-10 那笔，台账、纪要、情况说明写 500,000，对方回函写 600,000，没有任何提示）：
  // 只看同一句里既有日期、又有金额的，且这一句或同一段里它前面的话有付款字眼（回函里“已支付……明细为：某日某元；某日某元”是一段里用分号隔开的清单）；
  // 一句里有几个日期、几个金额的，每个日期只配它后面、下一个日期之前的第一个金额（纪要写“8月10日一笔为500,000元，原账误记为600,000元”，这一天记 500,000）。
  // 同一天有两个金额、且没有哪一份材料同时写了这两个金额的（同时写的多半是两笔），列出来请律师核对。只提示“可能是同一笔”，不判断以哪个为准
  const PAY = /付款|支付|已付|实付|转账|汇款|汇入|到账|收到|收款|付至|付清|打款/;
  const payOn = new Map<string, Map<number, Set<string>>>();
  const paySentences = new Map<string, string[]>();
  /** 时间轴上要就地标一句“各份材料写的金额不一样”的句子（复评 N5：大小写不一致在时间轴行内有标注，这一类原先只写在补证清单里） */
  const crossSentences = new Set<string>();
  for (const d of dates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.normalized)) continue;
    const t = textOf.get(d.document_version_id) ?? "";
    const sp = sentenceAround(t, d.char_start, d.char_end);
    const lineStart = t.lastIndexOf("\n", sp.start) + 1;
    if (!PAY.test(t.slice(lineStart, sp.end))) continue;
    const nextDate = Math.min(sp.end, ...dates.filter((o) => o.document_version_id === d.document_version_id && o.char_start >= d.char_end && o.char_start < sp.end).map((o) => o.char_start));
    const a = amounts.filter((x) => x.document_version_id === d.document_version_id && x.char_start >= d.char_end && x.char_start < nextDate).sort((x, y) => x.char_start - y.char_start)[0];
    if (!a) continue;
    const v = Number.parseFloat(a.normalized);
    if (!Number.isFinite(v) || v <= 0) continue;
    const byAmount = payOn.get(d.normalized) ?? new Map<number, Set<string>>();
    byAmount.set(v, (byAmount.get(v) ?? new Set<string>()).add(d.filename));
    payOn.set(d.normalized, byAmount);
    paySentences.set(d.normalized, [...(paySentences.get(d.normalized) ?? []), `${d.document_version_id}|${sp.start}|${d.normalized}`, `${d.document_version_id}|${sp.start}|${v}`]);
  }
  const crossRows: string[] = [];
  for (const [day, byAmount] of [...payOn.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const list = [...byAmount.entries()];
    const loose = list.filter(([, files], i) => list.some(([, other], j) => j !== i && [...files].every((f) => !other.has(f)) && [...other].every((f) => !files.has(f))));
    if (loose.length < 2) continue;
    for (const k of paySentences.get(day) ?? []) crossSentences.add(k);
    const yuan = (v: number) => `${v.toLocaleString("en-US")} 元`;
    crossRows.push(`${day} 的付款，各份材料写的金额不一样：${loose.map(([v, files]) => `${[...files].map((f) => `《${f}》`).join("、")}写 ${yuan(v)}`).join("；")}——可能是同一笔，请对照银行回单或收款凭证核对；也可能是当天的两笔，本机规则分不出来`);
  }

  // 事实时间轴（按发生日排序；保留来源与锚点）。V14 第 39 批：“事件”写日期所在的那句话；同一份材料里同一句话里的同一日期只列一次
  const seen = new Set<string>();
  const row = (f: (typeof facts)[number], date: string, kind: string): (string | number | null)[] | null => {
    // “事件”写日期或金额所在的那句话（V14 第 39 批真实走查：原先只写日期本身——“2025年9月12日｜日期”，同一日期出现几次列几行，看不出那天发生了什么）
    const t = textOf.get(f.document_version_id) ?? f.text;
    const sp = sentenceAround(t, f.char_start, f.char_end);
    const key = `${f.document_version_id}|${date}|${sp.start}`;
    if (seen.has(key)) return null;
    seen.add(key);
    // “类型”栏只写一句短的提示，详情在补证清单（复评 N1：原先把整段不一致说明塞进这一栏，两行各写一遍）
    const flag = (f.conflict ? "（大写与小写不一致，见补证清单）" : "") + (crossSentences.has(`${f.document_version_id}|${sp.start}|${kind === "日期" ? date : Number.parseFloat(f.normalized)}`) ? "（各份材料对这一天的付款写的金额不一样，见补证清单）" : "");
    return [date, t.slice(sp.start, sp.end).replace(/\s+/g, " ") || f.text, (kind === "日期" ? "日期" : `金额：${f.normalized}`) + flag, f.filename, f.text, charPos(f.char_start, f.char_end), natureOf(f.filename)];
  };
  const timelineRows: (string | number | null)[][] = [
    ["发生日期", "事件（所在原句）", "类型", "来源文件", "原文", "原文位置", "陈述性质"],
    ...dates
      .slice()
      // 年份不明的排在最后（不猜年份）
      .sort((a, b) => Number(a.normalized.startsWith("年份不明")) - Number(b.normalized.startsWith("年份不明")) || a.normalized.localeCompare(b.normalized))
      .map((f) => row(f, f.normalized, "日期"))
      .filter((r): r is (string | number | null)[] => r !== null),
    ...amounts.map((f) => row(f, "（日期未明）", "金额")).filter((r): r is (string | number | null)[] => r !== null),
  ];

  // 证据目录（证明目的留空待律师填写——不擅自认定证明力）
  const evidenceRows: (string | number | null)[][] = [
    ["编号", "证据名称", "来源", "页码", "原件状态", "证明目的（律师填写）", "待证事实（律师填写）"],
    ...input.materials.map((m, i) => [`E${i + 1}`, m.filename, "委托人提供（待确认）", "未知", "电子复制件", "", ""] as (string | number | null)[]),
  ];

  // 争点—证据矩阵框架：按律师给的争点列行；拆要件、挂证据是第二段“争点与证据分析”（Agent）的事
  const matrixRows: (string | number | null)[][] = [
    ["争点", "要件", "举证责任", "支持证据（原文位置）", "反对证据", "缺口", "证明力意见（律师填写）"],
    ...(input.issues.length > 0
      ? input.issues.map((issue) => [issue, "（待拆解：可接着做“争点与证据分析”）", "（待确认）", "", "", "", ""] as (string | number | null)[])
      : [["（争点待填写：可接着做“争点与证据分析”，由 AI 按你确认的事实拆要件、挂证据）", "", "", "", "", "", ""]] as (string | number | null)[][]),
  ];

  // 补证清单（质量缺陷 → 补证动作；页级 OCR 质量如实列出——低质量页可见、可重扫、可人工纠正）
  const qualityNotes: string[] = [];
  const supplementRows: string[] = [];
  for (const m of input.materials) {
    const flags = m.quality_flags ?? [];
    if (flags.includes("no_page_anchors")) {
      qualityNotes.push(`《${m.filename}》：Word 文件不分页，引用位置按“第几字”标注（按读取后的文字计数，与 Word 字数统计可能略有出入）`);
    }
    for (const pg of m.pages ?? []) {
      if (pg.quality === "unreadable") {
        qualityNotes.push(`《${m.filename}》第 ${pg.pageNo} 页：读不出（${pg.note ?? "文字识别失败或未就绪"}）`);
        supplementRows.push(`《${m.filename}》第 ${pg.pageNo} 页：不可读——请重扫或人工誊录后重新导入（不伪造文本）`);
      } else if (pg.quality === "low") {
        qualityNotes.push(`《${m.filename}》第 ${pg.pageNo} 页：识别不清（${pg.note ?? "文字识别把握不高"}）`);
        supplementRows.push(`《${m.filename}》第 ${pg.pageNo} 页：识别不清——建议重新扫描，或在材料页手工更正识别出的文字（原件不变）`);
      }
    }
  }

  // 材料内部不一致（本机规则只认得出大写与小写金额对不上；同一处两条只列一次）
  const conflictRows = [...new Map(amounts.filter((f) => f.conflict).map((f) => [`${f.document_version_id}|${f.conflict}`, f] as const)).values()].map(
    (f) => `《${f.filename}》${charPos(f.char_start, f.char_end)}：${f.conflict}——请核对原件与其他材料（对账函、收付款记录），以哪一个为准由律师判断`,
  );

  const missingRows: string[] = [];
  for (const m of input.materials) {
    const hit = new Set<string>();
    for (const sentence of m.text.split(/(?<=[。；;！？\n])/)) {
      const t = sentence.replace(/\s+/g, " ").trim();
      if (t.length < 6 || t.length > 160 || !MISSING_RE.test(t) || hit.has(t)) continue;
      hit.add(t);
      if (hit.size <= 5) missingRows.push(`《${m.filename}》提到：“${t}”——还没到手，请确认在谁手里后调取`);
    }
  }

  const factsCount = { dates: dates.length, amounts: amounts.length, parties: parties.length };

  const files: BuiltS2["files"] = [
    {
      kind: "s2_catalog",
      filename: `案卷总目录-${fileDay()}.xlsx`,
      bytes: createXlsx([{ name: "案卷总目录", rows: catalogRows }]),
      manifest: { files: input.materials.length },
    },
    {
      kind: "s2_timeline",
      filename: `事实时间轴-${fileDay()}.xlsx`,
      bytes: createXlsx([{ name: "事实时间轴", rows: timelineRows }]),
      manifest: { dates: dates.length, amounts: amounts.length, note: "同日同额不自动合并；每条独立行" },
    },
    {
      kind: "s2_evidence_catalog",
      filename: `证据目录-${fileDay()}.xlsx`,
      bytes: createXlsx([{ name: "证据目录", rows: evidenceRows }]),
      manifest: { note: "证明目的/待证事实由律师填写（不擅自认定证明力）" },
    },
    {
      kind: "s2_matrix",
      filename: `争点证据矩阵-${fileDay()}.xlsx`,
      bytes: createXlsx([{ name: "争点证据矩阵", rows: matrixRows }]),
      manifest: { issues: input.issues.length, note: "骨架：争点/要件/举证责任由律师确认" },
    },
    {
      kind: "s2_supplement",
      filename: `补证清单-${fileDay()}.docx`,
      bytes: createDocx("补证清单（草稿）", [
        {
          heading: "一、材料质量缺陷与建议",
          paragraphs: supplementRows.length > 0 ? supplementRows : ["本次材料没有发现需要重扫或补正的页。"],
        },
        {
          heading: "二、材料内部与材料之间的不一致",
          paragraphs:
            conflictRows.length + crossRows.length > 0
              ? [...conflictRows, ...crossRows, "以上是本机规则能比出来的两类（成对写的大写与小写金额、不同材料对同一天付款写的金额）；其他矛盾要接着做“争点与证据分析”。"]
              : ["本机规则只比对两类：成对写的大写与小写金额（紧挨着写，或表格里分别标了“大写”“小写”的），以及不同材料对同一天付款写的金额。这两类本次没有比出不一致——不等于材料之间没有矛盾，其他矛盾（如不同材料对同一事实说法不同）要接着做“争点与证据分析”。"],
        },
        {
          heading: "三、待补材料",
          paragraphs: missingRows.length > 0 ? [...missingRows, "以上是材料里自己提到还没拿到的；按争点还缺什么，由律师补充，或接着做“争点与证据分析”。"] : ["本机规则只找材料里明说“尚未提供、未留存、待补”之类的话，这次没有找到——不等于材料齐了：摘录件、复印件对应的完整件与原件，以及按争点还缺什么，由律师补充，或接着做“争点与证据分析”。"],
        },
      ]),
      manifest: {},
    },
    {
      kind: "s2_quality_report",
      filename: `材料质量报告-${fileDay()}.docx`,
      bytes: createDocx("材料质量报告", [
        {
          heading: "一、入库概况",
          paragraphs: [
            `文件 ${input.materials.length} 份；摘出日期 ${dates.length} 条、金额 ${amounts.length} 条、主体 ${parties.length} 条（每条都标了原文位置）。`,
            `事项：${input.matter.title}；立场：${input.matter.stance}。`,
          ],
        },
        {
          heading: "二、质量与降级说明",
          paragraphs: [
            ...(qualityNotes.length > 0 ? qualityNotes : ["无"]),
            "这一步在这台电脑上按规则摘出日期、金额与主体，不调用 AI；行为与法律关系要接着做“争点与证据分析”并由律师确认。读不出的文件只列入目录，不进入任何结论。",
            "原件不会被修改；手工更正识别文字会另存一版。",
          ],
        },
      ]),
      manifest: { anchors: facts.length },
    },
  ];

  return { files, factsCount, qualityNotes };
}
