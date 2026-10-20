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
  // 同一笔金额的大写与小写（“人民币壹拾万元整（小写：100,000元）”）是一件事：相距 20 字以内且金额相等的合并成一条，原文涵盖两处（复核 R15B-17）
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
      }
    }
  }
  for (let i = out.length - 1; i >= 0; i -= 1) if (drop.has(out[i]!)) out.splice(i, 1);
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

export function buildS2Deliverables(input: S2DeliverableInput): BuiltS2 {
  const facts = input.materials.flatMap((m) =>
    extractFacts({ document_version_id: m.document_version_id, parse_version_id: m.parse_version_id, filename: m.filename, text: m.text }),
  );
  const dates = facts.filter((f) => f.kind === "date");
  const amounts = facts.filter((f) => f.kind === "amount");
  const parties = facts.filter((f) => f.kind === "party");

  // 案卷总目录（文件 ID/原名/hash/页数/可读状态；页数未知显式写出，不编造）
  const catalogRows: (string | number | null)[][] = [
    ["文件ID", "原名", "sha256(前16)", "大小(字符)", "页数", "原件/复制件", "可读状态", "质量标记"],
    ...input.materials.map((m, i) => [
      `D${i + 1}`,
      m.filename,
      m.sha256.slice(0, 16),
      m.chars,
      m.page_count != null ? m.page_count : "未知（v0 解析未计页）",
      "电子复制件",
      "已解析",
      (m.quality_flags ?? []).join(";") || "无",
    ] as (string | number | null)[]),
  ];

  // 事实时间轴（按发生日排序；同一事实不合并；保留来源与锚点）
  const timelineRows: (string | number | null)[][] = [
    ["发生日期", "事件/金额", "类型", "来源文件", "原文", "锚点(字符区间)", "陈述性质"],
    ...dates
      .slice()
      // 年份不明的排在最后（不猜年份）
      .sort((a, b) => Number(a.normalized.startsWith("年份不明")) - Number(b.normalized.startsWith("年份不明")) || a.normalized.localeCompare(b.normalized))
      .map((f) => [f.normalized, f.text, "日期", f.filename, f.text, `${f.char_start}-${f.char_end}`, "材料记载"] as (string | number | null)[]),
    ...amounts.map((f) => ["（日期未明）", f.normalized, "金额", f.filename, f.text, `${f.char_start}-${f.char_end}`, "材料记载"] as (string | number | null)[]),
  ];

  // 证据目录（证明目的留空待律师填写——不擅自认定证明力）
  const evidenceRows: (string | number | null)[][] = [
    ["编号", "证据名称", "来源", "页码", "原件状态", "证明目的（律师填写）", "待证事实（律师填写）"],
    ...input.materials.map((m, i) => [`E${i + 1}`, m.filename, "委托人提供（待确认）", "未知", "电子复制件", "", ""] as (string | number | null)[]),
  ];

  // 争点—证据矩阵框架：按律师给的争点列行；拆要件、挂证据是第二段“争点与证据分析”（Agent）的事
  const matrixRows: (string | number | null)[][] = [
    ["争点", "要件", "举证责任", "支持证据（锚点）", "反对证据", "缺口", "证明力意见（律师填写）"],
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
      qualityNotes.push(`《${m.filename}》：v0 解析无页锚点，引用定位以字符区间代替`);
    }
    if (flags.includes("v0_crude_docx_parser")) {
      supplementRows.push(`《${m.filename}》：建议以文档服务重解析生成页锚点（正式版）`);
    }
    for (const pg of m.pages ?? []) {
      if (pg.quality === "unreadable") {
        qualityNotes.push(`《${m.filename}》第 ${pg.pageNo} 页：不可读（${pg.note ?? "OCR 失败/未就绪"}）`);
        supplementRows.push(`《${m.filename}》第 ${pg.pageNo} 页：不可读——请重扫或人工誊录后重新导入（不伪造文本）`);
      } else if (pg.quality === "low") {
        qualityNotes.push(`《${m.filename}》第 ${pg.pageNo} 页：低质量（${pg.note ?? "OCR 置信度低"}）`);
        supplementRows.push(`《${m.filename}》第 ${pg.pageNo} 页：OCR 质量低——建议重扫或用 materials.reparse 重解析/人工纠正（生成新解析版本）`);
      }
    }
  }

  const factsCount = { dates: dates.length, amounts: amounts.length, parties: parties.length };

  const files: BuiltS2["files"] = [
    {
      kind: "s2_catalog",
      filename: `案卷总目录-${input.runId.slice(-6)}.xlsx`,
      bytes: createXlsx([{ name: "案卷总目录", rows: catalogRows }]),
      manifest: { files: input.materials.length },
    },
    {
      kind: "s2_timeline",
      filename: `事实时间轴-${input.runId.slice(-6)}.xlsx`,
      bytes: createXlsx([{ name: "事实时间轴", rows: timelineRows }]),
      manifest: { dates: dates.length, amounts: amounts.length, note: "同日同额不自动合并；每条独立行" },
    },
    {
      kind: "s2_evidence_catalog",
      filename: `证据目录-${input.runId.slice(-6)}.xlsx`,
      bytes: createXlsx([{ name: "证据目录", rows: evidenceRows }]),
      manifest: { note: "证明目的/待证事实由律师填写（不擅自认定证明力）" },
    },
    {
      kind: "s2_matrix",
      filename: `争点证据矩阵-${input.runId.slice(-6)}.xlsx`,
      bytes: createXlsx([{ name: "争点证据矩阵", rows: matrixRows }]),
      manifest: { issues: input.issues.length, note: "骨架：争点/要件/举证责任由律师确认" },
    },
    {
      kind: "s2_supplement",
      filename: `补证清单-${input.runId.slice(-6)}.docx`,
      bytes: createDocx("补证清单（草稿）", [
        {
          heading: "一、材料质量缺陷与建议",
          paragraphs: supplementRows.length > 0 ? supplementRows : ["本次材料未发现需补正的质量缺陷（按 v0 解析口径）。"],
        },
        { heading: "二、待补材料", paragraphs: ["（由律师按争点矩阵缺口补充）"] },
      ]),
      manifest: {},
    },
    {
      kind: "s2_quality_report",
      filename: `材料质量报告-${input.runId.slice(-6)}.docx`,
      bytes: createDocx("材料质量报告", [
        {
          heading: "一、入库概况",
          paragraphs: [
            `文件 ${input.materials.length} 份；抽取事实：日期 ${dates.length} 条、金额 ${amounts.length} 条、主体 ${parties.length} 条（全部带字符锚点入库）。`,
            `事项：${input.matter.title}；立场：${input.matter.stance}。`,
          ],
        },
        {
          heading: "二、质量与降级说明",
          paragraphs: [
            ...(qualityNotes.length > 0 ? qualityNotes : ["无"]),
            "事实抽取 v0 为确定性规则（日期/金额/主体），行为与法律关系抽取待真实模型与律师确认；解析失败的文件只进目录不进实体结论。",
            "原件永不修改；OCR 纠正将生成新解析版本。",
          ],
        },
      ]),
      manifest: { anchors: facts.length },
    },
  ];

  return { files, factsCount, qualityNotes };
}
