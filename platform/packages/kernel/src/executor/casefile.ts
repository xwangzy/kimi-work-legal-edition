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
  /** 与 conflict 同时写：这一对大写、小写各自的原文与数额（给 materials.list 列给助手；V16 第 41 批） */
  conflict_pair?: AmountWordsPair;
}

export interface AmountWordsPair {
  upper: { text: string; amount_yuan: number };
  lower: { text: string; amount_yuan: number };
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
/**
 * 主体的角色词（第 58 批根因复盘 m01：买卖合同写“卖方（出卖人）：××有限公司”“买方（买受人）：××”，送货单写“收货单位：××”，
 * 原规则只认“甲方／乙方／委托方……＋冒号”，整套案卷主体 0 条）。长的排在前面；角色词后可跟一段括注（“卖方（出卖人）”“买方（盖章）”）再接冒号。
 */
const PARTY_ROLES = [
  "甲方", "乙方", "丙方", "丁方", "委托方", "受托方", "委托人", "受托人",
  "卖方", "买方", "出卖人", "买受人", "供方", "需方", "供货方", "采购方", "供货单位", "收货单位", "发货单位",
  "出租人", "承租人", "出租方", "承租方", "发包人", "承包人", "分包人", "发包方", "承包方", "分包方",
  "借款人", "出借人", "贷款人", "担保人", "保证人", "抵押人", "抵押权人", "出质人", "质权人",
  "转让方", "受让方", "转让人", "受让人", "许可方", "被许可方",
  "原告", "被告", "第三人", "申请人", "被申请人", "上诉人", "被上诉人", "申请执行人", "被执行人",
].sort((a, b) => b.length - a.length);
/** 名称只取冒号后同一行的内容（换行后是下一栏，原规则跨行把“甲方：（空）↵乙方”读成“甲方＝乙方”）；表格单元格之间的“|”可以隔开冒号与名称。 */
const PARTY_RE = new RegExp(`(${PARTY_ROLES.join("|")})(?:[（(][^（）()\\n]{1,12}[)）])?[ \\t　]*[:：][ \\t　]*(?:[|｜][ \\t　]*)?([^\\s，。；、：:|｜（）()【】\\[\\]《》“”"]{2,40}(?:[（(](?:有限合伙|普通合伙|特殊普通合伙)[)）])?)`, "g");
/**
 * 冒号后不是名称的：签字盖章栏、日期栏、下划线占位、纯数字，或又是一个角色词；
 * 通知送达条款里“甲方：浙江省宁波市××路366号……”是地址，不是主体。
 */
const NOT_PARTY = /^(?:[_＿\-—…·.]+|[\d\s.,，]+)$|签字|签章|盖章|日期|年月日|待填|(?:省|市|区|县|镇|乡|村|路|街|道|巷|弄).*\d+\s*号|\d+\s*(?:号|室|层|楼|幢)$/;
/**
 * 落款盖章的单位（“嘉兴禾丰包装科技有限公司（公章）”“××有限公司设备部（部门章）”）：函件、确认单是谁出具的看落款（同批 m01：
 * 质量异议函是对方出具的，证据目录分不出来）。名称前面须是行首、空白、表格竖线或冒号，免得从句子中间截一段。
 */
const SEAL_RE = /(?<![^\s|｜：:])([^\s，。；、：:|｜（）()【】《》“”"]{2,40}(?:有限责任公司|股份有限公司|有限公司|合伙企业(?:[（(]有限合伙[)）])?|事务所|分公司|支行|分行|银行|集团|研究院|研究所|委员会|人民法院|中心|厂))(?:[^\s，。；（）()|｜]{0,10})?[（(](?:公章|合同专用章|财务专用章|业务专用章|部门章|盖章|印章|章)[)）]/g;

/** 材料里落款盖章的单位（去重，按出现先后）。证据目录“来源”一栏据此写出形成方。 */
export function sealsIn(text: string): { name: string; start: number; end: number }[] {
  const out: { name: string; start: number; end: number }[] = [];
  for (const m of text.matchAll(SEAL_RE)) out.push({ name: m[1]!, start: m.index!, end: m.index! + m[0].length });
  return out;
}

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
        a.conflict_pair = b.conflict_pair = pairOf(up, low);
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
    up.fact.conflict_pair = lowFact.conflict_pair = pairOf(up.fact, lowFact);
  }
  const partySpans: [number, number][] = [];
  for (const m of text.matchAll(PARTY_RE)) {
    const name = m[2]!;
    if (NOT_PARTY.test(name) || PARTY_ROLES.some((r) => name.startsWith(r))) continue;
    partySpans.push([m.index!, m.index! + m[0].length]);
    out.push({
      kind: "party",
      text: m[0],
      normalized: `${m[1]}=${name}`,
      document_version_id: doc.document_version_id,
      parse_version_id: doc.parse_version_id,
      filename: doc.filename,
      char_start: m.index!,
      file_page: filePageOf(text, m.index!),
      char_end: m.index! + m[0].length,
      assertion: "material_record",
    });
  }
  // 落款盖章的单位；已经被“卖方：××有限公司（合同专用章）”这类角色行摘过的不重复记
  for (const s of sealsIn(text)) {
    if (partySpans.some(([a, b]) => s.start < b && s.end > a)) continue;
    out.push({
      kind: "party",
      text: text.slice(s.start, s.end),
      normalized: `落款盖章=${s.name}`,
      document_version_id: doc.document_version_id,
      parse_version_id: doc.parse_version_id,
      filename: doc.filename,
      char_start: s.start,
      file_page: filePageOf(text, s.start),
      char_end: s.end,
      assertion: "material_record",
    });
  }
  return out;
}

const pairOf = (up: FactRow, low: FactRow): AmountWordsPair => ({
  upper: { text: up.text, amount_yuan: Number.parseFloat(up.normalized) },
  lower: { text: low.text, amount_yuan: Number.parseFloat(low.normalized) },
});

/** 材料内部大写与小写金额对不上的各处（同一对只列一次）。整理案卷与 materials.list 共用。 */
export function amountWordsConflicts(facts: readonly FactRow[]): (AmountWordsPair & { document_version_id: string; filename: string; note: string; fact: FactRow })[] {
  const seen = new Map<string, AmountWordsPair & { document_version_id: string; filename: string; note: string; fact: FactRow }>();
  for (const f of facts) {
    if (f.kind !== "amount" || !f.conflict || !f.conflict_pair) continue;
    const k = `${f.document_version_id}|${f.conflict}`;
    if (!seen.has(k)) seen.set(k, { ...f.conflict_pair, document_version_id: f.document_version_id, filename: f.filename, note: f.conflict, fact: f });
  }
  return [...seen.values()];
}

/** 不同材料对同一天的付款写了不同的金额：哪一天、哪几份各写多少（只提示可能是同一笔，不判断以哪个为准）。 */
export interface PayDayConflict {
  date: string;
  amounts: { amount_yuan: number; filenames: string[] }[];
}

/**
 * 不同材料对同一天的付款写了不同金额（V16 第 41 批真实走查 E1：2023-08-10 那笔，台账、纪要、情况说明写 500,000，对方回函写 600,000，没有任何提示）：
 * 只看同一句里既有日期、又有金额的，且这一句或同一段里它前面的话有付款字眼（回函里“已支付……明细为：某日某元；某日某元”是一段里用分号隔开的清单）；
 * 一句里有几个日期、几个金额的，每个日期只配它后面、下一个日期之前的第一个金额（纪要写“8月10日一笔为500,000元，原账误记为600,000元”，这一天记 500,000）。
 * 同一天有两个金额、且没有哪一份材料同时写了这两个金额的（同时写的多半是两笔），列出来请律师核对。
 * 整理案卷与 materials.list 共用。sentences 是要在时间轴上就地标注的句子（材料编号|句首位置|日期或金额）。
 */
export function payDayConflicts(materials: readonly { document_version_id: string; text: string }[], facts: readonly FactRow[]): { conflicts: PayDayConflict[]; sentences: Set<string> } {
  const textOf = new Map(materials.map((m) => [m.document_version_id, m.text] as const));
  const dates = facts.filter((f) => f.kind === "date");
  const amounts = facts.filter((f) => f.kind === "amount");
  const PAY = /付款|支付|已付|实付|转账|汇款|汇入|到账|收到|收款|付至|付清|打款/;
  const payOn = new Map<string, Map<number, Set<string>>>();
  const paySentences = new Map<string, string[]>();
  const sentences = new Set<string>();
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
  const conflicts: PayDayConflict[] = [];
  for (const [day, byAmount] of [...payOn.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const list = [...byAmount.entries()];
    const loose = list.filter(([, files], i) => list.some(([, other], j) => j !== i && [...files].every((f) => !other.has(f)) && [...other].every((f) => !files.has(f))));
    if (loose.length < 2) continue;
    for (const k of paySentences.get(day) ?? []) sentences.add(k);
    conflicts.push({ date: day, amounts: loose.map(([v, files]) => ({ amount_yuan: v, filenames: [...files] })) });
  }
  return { conflicts, sentences };
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
  // 只认文件名表明是一方自己写的说明、陈述、访谈、笔记的；函件不按文件名定性（第二次复评 M1、M2：按“函”字标“发函一方所述”，把对方盖章的对账确认函、
  // EMS 妥投记录、对方自认“催款函收悉”都标成了待印证）。其余一律写明本机流程没有判断证明力，免得“材料记载”读起来比“一方陈述”更可信
  /情况说明|陈述|访谈|笔记|口述|自述|备忘（内部）/.test(filename) ? "一方陈述，待其他材料印证" : "材料记载（证明力未作判断）";

/** 材料里自己提到“还没提供、原件在别处、待补”的句子（同批：情况说明写着“回单原件在财务部，尚未提供给律师”，待补材料一栏却是空的）。 */
const MISSING_RE = /尚未提供|未提供给|暂未提供|没有提供|待补充|待补交|另行提供|后续提供|未找到|找不到|已遗失|遗失|未能调取|待调取|未留存/;

/*
 * 第 58 批根因复盘 m01（整理案卷 15 分）：补证清单只认“尚未提供”字样，合同附件写着“技术协议（摘录）”、微信是“摘录”、合同约定了律师费却没有票据，
 * 清单却写“这次没有发现”。下面三类只看材料文字与文件名就能判断，不推断争点：
 * ① 摘录件、节选、截图、复印件 → 完整件或原件；② 正文引用了、材料里却没有的文件；③ 约定由一方承担、要凭票据主张的费用。
 */
/** 文件名表明只是一部分或不是原件（“扫描件”“摘要”不算：扫描件多半就是原件的电子版，“摘要”常是律师或一方自己写的概述）。 */
const EXCERPT_NAME_RE = /摘录|节选|摘抄|截图|截屏|复印件|影印件/;
/** 正文里括注的“（摘录）（节选）（复印件）”（“（部分）”不算：收款表里“60%验收款（部分）”说的是部分付款）。 */
const EXCERPT_MARK_RE = /[（(](?:摘录|节选|摘抄|复印件|影印件|截图)[)）]/;
/** 标题行（不超过 30 字、没有句中标点）里写着“摘录、节选”的。 */
const EXCERPT_HEAD_RE = /摘录|节选|摘抄/;
/** 法律法规、司法解释、标准与规范性文件：书名号里的这些不是“要调取的材料”。 */
const LAW_TITLE_RE = /^(?:中华人民共和国|最高人民法院|最高人民检察院|国务院|全国人民代表大会|关于)|(?:法|法典|条例|细则|解释|办法|规定|规则|公约|标准|规范|指引|批复|意见)$/;
/**
 * 要凭票据主张的维权费用（诉讼费、保全费由法院核定、裁判时一并处理，不单列）；句子里还要有违约、争议一类的语境，
 * 免得把服务合同里的“代理费”、劳动合同里的报销费用当成维权费用。
 */
const FEE_RE = /律师代理费|律师费|代理费|保全担保费|保全保险费|鉴定费|评估费|检测费|公证费|调查取证费|调查费/g;
const FEE_BEAR_RE = /承担|负担|赔偿|支付|补偿|偿付/;
const FEE_CONTEXT_RE = /违约|守约|实现债权|追索|维权|争议|纠纷|诉讼|仲裁|败诉|追偿/;
const FEE_NOT_BEAR_RE = /各自承担|自行承担|各自负担|自行负担|不承担|不予承担|无需承担|无须承担/;
/** 已有票据或委托合同的：文件名同时写了费用名目与票据、合同字样。 */
const FEE_STEM: [RegExp, RegExp][] = [
  [/律师费|律师代理费|代理费/, /律师|代理|法律服务/],
  [/保全担保费|保全保险费/, /担保|保险|保函/],
  [/鉴定费/, /鉴定/],
  [/评估费/, /评估/],
  [/检测费/, /检测/],
  [/公证费/, /公证/],
  [/调查取证费|调查费/, /调查/],
];
const RECEIPT_RE = /发票|收据|凭证|回单|委托合同|委托代理合同|服务合同|服务协议|付款记录|转账记录/;
const CN_NUM: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const attachmentNo = (s: string): number | null => (/^\d+$/.test(s) ? Number(s) : (CN_NUM[s] ?? null));
/** 文件名去掉编号前缀、扩展名与括注，用来判断“这份材料是不是被引用的那份”。 */
const stemOf = (filename: string): string => filename.replace(/\.[A-Za-z0-9]{2,5}$/, "").replace(/^[\dA-Za-z]{1,4}[-_.、\s]+/, "");
/** 标题行：不超过 30 字、没有句中标点（“附件一　技术协议（摘录）”“设备验收单”）。 */
const headingLines = (text: string): string[] =>
  text
    .split("\n")
    .map((l) => l.replace(/^[|｜\s]+|[|｜\s]+$/g, "").trim())
    .filter((l) => l.length > 0 && l.length <= 30 && !/[。，；;！？]/.test(l));

export interface RuleGaps {
  /** ① 摘录件、截图、复印件 → 完整件或原件 */
  excerpts: string[];
  /** ② 正文引用了、材料里没有的文件 */
  references: string[];
  /** ③ 约定由一方承担、要凭票据主张的费用 */
  fees: string[];
}

/** 补证清单里按规则判得出的三类缺口（第 58 批）。只看材料文字与文件名，同一缺口只列一次。 */
export function ruleGaps(materials: readonly { filename: string; text: string }[]): RuleGaps {
  const excerpts: string[] = [];
  const references: string[] = [];
  const fees: string[] = [];
  const stems = materials.map((m) => stemOf(m.filename));
  const heads = materials.map((m) => headingLines(m.text));
  for (const m of materials) {
    const name = EXCERPT_NAME_RE.exec(m.filename)?.[0];
    if (name) {
      const what = /复印件|影印件/.test(name) ? "复印件——请核对或调取原件" : /截图|截屏/.test(name) ? "截图——请调取原始载体或完整导出记录（含时间、对方账号等信息）" : "摘录件——请调取完整件（原始载体或完整导出记录）与原件";
      excerpts.push(`《${m.filename}》是${what}`);
      continue; // 整份是摘录的，里面的“摘录”字样不再逐处列
    }
    const seen = new Set<string>();
    for (const line of m.text.split("\n")) {
      const t = line.replace(/^[|｜\s]+|[|｜\s]+$/g, "").replace(/\s*[|｜]\s*/g, " ").trim();
      if (!t || seen.has(t)) continue;
      const head = t.length <= 30 && !/[。，；;！？]/.test(t) && EXCERPT_HEAD_RE.test(t);
      if (!head && !EXCERPT_MARK_RE.test(t)) continue;
      if (t.length > 80) continue;
      seen.add(t);
      if (seen.size <= 3) excerpts.push(`《${m.filename}》里的“${t}”只是摘录或复制件——请调取完整件与原件`);
    }
  }
  // ② 引用了、材料里没有：书名号里的文件名，和“附件×”
  const listed = new Set<string>();
  materials.forEach((m, i) => {
    const missing: string[] = [];
    for (const r of m.text.matchAll(/《([^《》\n]{2,30})》/g)) {
      const title = r[1]!.replace(/\s+/g, "");
      if (LAW_TITLE_RE.test(title) || listed.has(title)) continue;
      const found = stems.some((s) => s.includes(title)) || heads.some((hs) => hs.some((h) => h.includes(title) && !h.includes(`《${title}》`)));
      if (found) continue;
      listed.add(title);
      missing.push(`《${title}》`);
    }
    for (const r of m.text.matchAll(/附件\s*([一二三四五六七八九十]|\d{1,2})(?![\d一二三四五六七八九十])/g)) {
      const no = attachmentNo(r[1]!);
      if (no === null) continue;
      const key = `${m.filename}|附件${no}`;
      if (listed.has(key)) continue;
      const isHead = (h: string) => {
        const x = /^附件\s*([一二三四五六七八九十]|\d{1,2})(?![\d一二三四五六七八九十])/.exec(h);
        return x !== null && attachmentNo(x[1]!) === no;
      };
      // 本份材料里有“附件×”开头的标题行，或另有一份文件名写着附件×，就算已提供
      const found = heads[i]!.some(isHead) || stems.some((s, j) => j !== i && new RegExp(`附件\\s*(?:${no}|${Object.keys(CN_NUM).find((k) => CN_NUM[k] === no) ?? no})(?![\\d一二三四五六七八九十])`).test(s));
      listed.add(key);
      if (!found) missing.push(`附件${r[1]}`);
    }
    if (missing.length > 0) references.push(`《${m.filename}》提到${missing.slice(0, 6).join("、")}${missing.length > 6 ? `等 ${missing.length} 份` : ""}，本次材料里没有——与争议有关的，请调取`);
  });
  // ③ 约定由一方承担的费用：每类费用只在第一次出现的那份材料下列一次
  const feeSeen = new Set<string>();
  for (const m of materials) {
    const mine: string[] = [];
    let quote = "";
    for (const sentence of m.text.split(/(?<=[。；;！？\n])/)) {
      const t = sentence.replace(/\s+/g, " ").trim();
      if (t.length < 6 || !FEE_BEAR_RE.test(t) || !FEE_CONTEXT_RE.test(t) || FEE_NOT_BEAR_RE.test(t)) continue;
      for (const f of t.matchAll(FEE_RE)) {
        const fee = f[0] === "律师代理费" ? "律师费" : f[0];
        if (feeSeen.has(fee)) continue;
        const stem = FEE_STEM.find(([re]) => re.test(fee));
        if (stem && materials.some((x) => stem[1].test(x.filename) && RECEIPT_RE.test(x.filename))) continue;
        feeSeen.add(fee);
        mine.push(fee);
        if (!quote) quote = t.length > 60 ? `${t.slice(0, 60)}……` : t;
      }
    }
    if (mine.length > 0) fees.push(`《${m.filename}》约定由一方承担${mine.join("、")}（“${quote}”）——要一并主张的，请备齐委托合同或费用协议、发票与付款凭证；尚未发生的，发生后补齐`);
  }
  return { excerpts, references, fees };
}

/*
 * 第 58 批复测（m01 17 分）独立评分指出的规则缺陷：时间轴“事件”把表格行、签署栏原样搬进来（带“|”、“405000.0”），同一句话重复几行；
 * 证据目录没有形成日期、页数写“未知”、名称带扩展名；没有年份的日期写成“年份不明-07-15”。下面几个函数只看材料文字与解析结果。
 */
interface LineSpan {
  start: number;
  end: number;
  text: string;
}
function linesOf(text: string): LineSpan[] {
  let at = 0;
  return text.split("\n").map((t) => {
    const l = { start: at, end: at + t.length, text: t };
    at += t.length + 1;
    return l;
  });
}
function lineIndexAt(lines: readonly LineSpan[], pos: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lines[mid]!.start <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
const DOCX_ROW_RE = /^\s*\|.*\|\s*$/;
const isTableLine = (l: string): boolean => DOCX_ROW_RE.test(l) || l.includes("\t");
const cellsOf = (l: string): string[] =>
  DOCX_ROW_RE.test(l)
    ? l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim())
    : l.split("\t").map((c) => c.trim());
const AMOUNT_HEAD = /金额|价款|价税|合计|余额|元|费|额/;
const NOT_AMOUNT_HEAD = /账|号|码|编|日期|时间|电话|数量/;
/** 表格里的数：Excel 读出的“405000.0”写成“405,000”；金额栏的整数加千分位；账号、发票号、编号原样。 */
export function tidyNumber(v: string, head = ""): string {
  const amountHead = AMOUNT_HEAD.test(head) && !NOT_AMOUNT_HEAD.test(head);
  if (/^-?\d{4,12}\.\d+$/.test(v) || (/^-?\d{4,12}$/.test(v) && amountHead)) {
    const n = Number(v);
    if (Number.isFinite(n)) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
  return v;
}
/** 句子里夹带的“310000.0”这类浮点写法（四位以上整数、小数全是 0）。 */
const tidyFloats = (s: string): string => s.replace(/(?<![\d.,])(\d{4,12})\.0+(?![\d.])/g, (_m, d: string) => Number(d).toLocaleString("en-US"));
/** 表头行：至少两格有字、每格不超过 12 字、不含数字（“RC-1”“2025年”这类是内容不是表头）。 */
const looksLikeHeader = (cells: readonly string[]): boolean => cells.filter((c) => c).length >= 2 && cells.every((c) => c.length <= 12 && !/\d/.test(c));

/** 表格行 → 可读的事件句：“收款记录：到账日期：2025-09-16；付款单位：……；金额（元）：405,000”。不是表格行的返回 null。 */
export function tableRowEvent(lines: readonly LineSpan[], i: number): string | null {
  const l = lines[i]!.text;
  if (!isTableLine(l)) return null;
  const docx = DOCX_ROW_RE.test(l);
  const same = (x: string) => (docx ? DOCX_ROW_RE.test(x) : x.includes("\t"));
  let j = i;
  while (j > 0 && same(lines[j - 1]!.text)) j -= 1;
  const headCells = j < i ? cellsOf(lines[j]!.text) : null;
  const header = headCells && looksLikeHeader(headCells) ? headCells : null;
  const sheet = j > 0 ? (/^【(.{1,30})】$/.exec(lines[j - 1]!.text.trim())?.[1] ?? null) : null;
  const cells = cellsOf(l);
  // 两栏的表多是“名目｜内容”（送货单、对账函、信息表）：写成“名目：内容”，不按首行配表头
  if (cells.length === 2) {
    const [a, b] = cells.map((c, k) => tidyNumber(c, k === 1 ? cells[0]! : "")) as [string, string];
    return (sheet ? `${sheet}：` : "") + (a && b ? `${a}：${b}` : a || b);
  }
  let lead = "";
  const parts: string[] = [];
  cells.forEach((c, k) => {
    if (!c) return;
    const h = (header?.[k] ?? "").replace(/\s+/g, "");
    if (/^(?:序号|编号|No\.?)$/i.test(h) && /^\d{1,4}$/.test(c)) return;
    if (/^(?:合计|小计|总计)/.test(c)) {
      lead = c;
      return;
    }
    const v = tidyNumber(c, h);
    parts.push(h && h !== c ? `${h}：${v}` : v);
  });
  const body = lead ? `${lead}——${parts.join("；")}` : parts.join("；");
  return (sheet ? `${sheet}：` : "") + body;
}

/**
 * 签署栏、落款：有单位名＋（××章）的，签字盖章栏（“（签字）”“盖章：”“授权代表”），或整行只有一个日期（函件落款日期）。
 * 句子里的“签字确认”“在对账函上盖章”是事件，不算签署栏。
 */
const SIGN_FIELD_RE = /[（(](?:签字|签名|签章|盖章|签字盖章|签字或盖章|签名或盖章|公章)[)）]|(?:签字|签名|签章|盖章)[:：]|授权代表/;
const DATE_ONLY_RE = /^[\s|｜]*(?:日期[:：]\s*)?(?:\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|[〇零○一二三四五六七八九]{4}年[元一二三四五六七八九十]{1,2}月[一二三四五六七八九十]{1,3}日)[\s|｜]*$/;
/** 页眉页脚里的页码行。 */
const PAGE_MARK_RE = /^\s*(?:第\s*\d+\s*页(?:\s*[,，/／]?\s*共\s*\d+\s*页)?|共\s*\d+\s*页|-\s*\d+\s*-|Page\s+\d+(?:\s+of\s+\d+)?)\s*$/i;
const ORG_TAIL_RE = /(?:有限责任公司|股份有限公司|有限公司|合伙企业（有限合伙）|合伙企业|事务所|委员会|人民法院|分公司|支行|分行)$/;
/** 第 i 行是不是签署栏或落款；是的话返回落款单位（看得出的）。 */
export function signLine(lines: readonly LineSpan[], i: number): { names: string[] } | null {
  const t = lines[i]!.text;
  const seals = [...new Set(sealsIn(t).map((s) => s.name))];
  if (seals.length > 0 || SIGN_FIELD_RE.test(t)) return { names: seals };
  if (!DATE_ONLY_RE.test(t)) return null;
  for (let k = i - 1; k >= Math.max(0, i - 3); k -= 1) {
    const p = lines[k]!.text.trim();
    if (!p) continue;
    const names = [...new Set(sealsIn(p).map((s) => s.name))];
    if (names.length > 0) return { names };
    if (ORG_TAIL_RE.test(p) && p.length <= 40) return { names: [p] };
    break;
  }
  return { names: [] };
}

/** 截止类日期（“2026年8月31日前”“届满”）、期间的终点（“至2027年2月28日”，“截至”除外）不当作文件形成日期。 */
const DEADLINE_AFTER_RE = /^\s*(?:前|之前|以前|止|届满|到期)/;
const PERIOD_END_BEFORE_RE = /(?:(?<!截)至|直至|到)\s*$/;
/** 文件形成日期：落款或签署日期优先，其次文中最晚的明确日期（截止日期除外）；写明取法。 */
export function formationDate(text: string, docDates: readonly FactRow[]): { iso: string; how: string; label: string } | null {
  const full = docDates.filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f.normalized));
  if (full.length === 0) return null;
  const lines = linesOf(text);
  const signed = [...new Set(full.filter((f) => signLine(lines, lineIndexAt(lines, f.char_start)) !== null).map((f) => f.normalized))].sort();
  if (signed.length > 0) {
    const iso = signed[signed.length - 1]!;
    const others = signed.slice(0, -1);
    return { iso, how: "落款日期", label: `${iso}（落款日期${others.length > 0 ? `；另有落款 ${others.join("、")}` : ""}）` };
  }
  // 截止日（“……前”“届满”）、期间的终点（“至 2027 年 2 月 28 日”）和晚于今天的日期都不是文件形成的日子
  const today = fileDay();
  const plain = full
    .filter((f) => !DEADLINE_AFTER_RE.test(text.slice(f.char_end, f.char_end + 4)) && !PERIOD_END_BEFORE_RE.test(text.slice(Math.max(0, f.char_start - 3), f.char_start)) && f.normalized <= today)
    .map((f) => f.normalized)
    .sort();
  if (plain.length === 0) return null;
  const iso = plain[plain.length - 1]!;
  return { iso, how: "文中最晚的明确日期", label: `${iso}（文中最晚的明确日期）` };
}

/**
 * 没写年份的日期（“7月15日”“次年3月5日”）按同一份材料里的明确日期推定年份：
 * 相对年份（同年、次年、去年……）以前面最近的明确日期或形成日期为基准；只写月日的，依次看：区间的后一端跟前一端同年；
 * 聊天记录、台账这类一行一条的按这一行的时间戳取最近的一年；本份材料只出现一个年份就用它；出现几个年份的取离形成日期最近的一年；
 * 都没有的取原文位置最近的明确日期的年份。推定不了返回 null。
 */
export function inferYear(f: FactRow, docDates: readonly FactRow[], anchorIso: string | null, text?: string): string | null {
  const m = /年份不明-(\d{2})-(\d{2})$/.exec(f.normalized);
  if (!m) return null;
  const md = `${m[1]}-${m[2]}`;
  const full = docDates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.normalized));
  const yearOf = (iso: string) => Number(iso.slice(0, 4));
  const anchorYear = anchorIso ? yearOf(anchorIso) : null;
  const rel = /^(同年|当年|本年|次年|翌年|今年|去年|上年|前年)/.exec(f.text)?.[1];
  if (rel) {
    const before = full.filter((d) => d.char_start < f.char_start).sort((a, b) => b.char_start - a.char_start)[0];
    const base = before ? yearOf(before.normalized) : anchorYear;
    if (base === null) return null;
    const y = /同年|当年|本年/.test(rel) ? base : /次年|翌年/.test(rel) ? base + 1 : rel === "今年" ? (anchorYear ?? base) : rel === "前年" ? (anchorYear ?? base) - 2 : (anchorYear ?? base) - 1;
    return `${y}-${md}`;
  }
  const years = [...new Set(full.map((d) => yearOf(d.normalized)))].sort((a, b) => a - b);
  if (years.length === 0) return null;
  const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
  const closest = (ref: string) => {
    const y = yearOf(ref);
    return [y - 1, y, y + 1].map((c) => `${c}-${md}`).filter((iso) => Number.isFinite(day(iso))).sort((a, b) => Math.abs(day(a) - day(ref)) - Math.abs(day(b) - day(ref)))[0] ?? `${y}-${md}`;
  };
  // 区间的后一端（“2026年9月5日至10月31日”）：跟前一端同一年，月日比前一端早的算下一年
  const head = full.find((d) => d.char_end <= f.char_start && f.char_start - d.char_end <= 3 && /^\s*(?:至|到|—|－|-|～|~)\s*$/.test(text?.slice(d.char_end, f.char_start) ?? ""));
  if (head) {
    const y = yearOf(head.normalized);
    return `${y}-${md}` >= head.normalized ? `${y}-${md}` : `${y + 1}-${md}`;
  }
  // 出现几个年份的：聊天记录、台账这类一行一条的（行首是日期，或是表格行），按这一行的时间戳（或“2026-09”“2026年9月”这样的年月）取离它最近的一年。
  // 普通段落里前面提到的日期不算（“2025年12月26日付款。7月15日来函……”的 7月15日 多半在其后）
  if (text !== undefined) {
    const ls = text.lastIndexOf("\n", f.char_start - 1) + 1;
    const le = text.indexOf("\n", f.char_end) < 0 ? text.length : text.indexOf("\n", f.char_end);
    const line = text.slice(ls, le);
    const rowLike = isTableLine(line);
    const stamp = full.find((d) => d.char_start >= ls && d.char_start < le && (rowLike || /^[\s|｜\d]{0,3}$/.test(text.slice(ls, d.char_start))));
    const ym = rowLike || /^\s*\d{4}/.test(line) ? /(\d{4})\s*(?:年\s*(\d{1,2})\s*月|-(\d{1,2})(?![\d-]))/.exec(line) : null;
    const ref = stamp?.normalized ?? (ym ? `${ym[1]}-${String(Number(ym[2] ?? ym[3])).padStart(2, "0")}-15` : null);
    if (ref) return closest(ref);
  }
  if (years.length === 1) return `${years[0]}-${md}`;
  // 出现几个年份的普通段落：按形成日期（落款或文中最晚的明确日期），取离它最近的一年（函件回指几天前的来函、预告下月的期限都对得上）
  if (anchorIso) return closest(anchorIso);
  const near = [...full].sort((a, b) => Math.abs(a.char_start - f.char_start) - Math.abs(b.char_start - f.char_start))[0]!;
  return `${yearOf(near.normalized)}-${md}`;
}

/** 页数：解析结果有页数的用它；文字里有换页符的数页；Excel 写工作表；Word 与文本按字数估一个约数并写明。 */
export function pageLabel(m: { filename: string; text: string; page_count?: number | null | undefined }): string | number {
  if (m.page_count != null) return m.page_count;
  if (m.text.includes("\f")) return (m.text.match(/\f/g) ?? []).length + 1;
  if (/\.xlsx?$/i.test(m.filename)) {
    const sheets = [...m.text.matchAll(/^【(.{1,30})】$/gm)].map((x) => x[1]!);
    return sheets.length > 0 ? `${sheets.length} 个工作表（${sheets.join("、")}）` : "表格文件不分页";
  }
  if (/\.(?:docx|txt|md)$/i.test(m.filename)) return `约 ${Math.max(1, Math.ceil(m.text.length / 700))} 页（按字数估算，以打印为准）`;
  return "未计页";
}
const EXT_RE = /\.(?:docx?|pdf|xlsx?|txt|md|csv|jpe?g|png|tiff?|bmp|heic|wps|et|ofd)$/i;

/** 律师填写的争点点名了某类事实时，补证清单列这类争点常用的证据（只看争点原文，不凭空推）。 */
const ISSUE_EVIDENCE: [RegExp, string][] = [
  [/含水率|含水量|湿度/, "含水率的原始检测记录（检测时间、方法与仪器、在场人员签字）"],
  [/质量异议|质量问题|质量瑕疵|不合格|故障|缺陷/, "质量问题的原始检测或检验记录，维修、服务记录的签字原件"],
  [/违约金[^；;]*(?:过高|调整|调减|减少)|过分高于/, "我方实际损失的证据（资金占用成本、融资利息、催收支出），用于回应违约金调减"],
  [/时效/, "时效中断的凭证（催款函及送达记录、对账确认、对方承诺付款的记录）"],
  [/到期|届满/, "到期起算事实的凭证（交付、验收、质保期起算与顺延的书面记录）"],
  [/送达/, "送达凭证（邮寄单、妥投记录、签收回执）"],
  [/旷工|违纪|解除劳动/, "所依规章制度的各版本及其民主程序、公示或签收材料，考勤原始记录"],
  [/加班/, "考勤原始记录与加班审批记录"],
];
export function issueEvidenceRows(issues: readonly string[]): string[] {
  const out: string[] = [];
  const used = new Set<string>();
  for (const issue of issues.flatMap((s) => s.split(/[；;\n]/)).map((s) => s.trim()).filter(Boolean)) {
    for (const [re, ev] of ISSUE_EVIDENCE) {
      if (!re.test(issue) || used.has(ev)) continue;
      used.add(ev);
      out.push(`争点“${issue}”：${ev}——这类争点常用的证据，材料里已有的请核对是否原件、是否完整，是否需要由律师判断`);
    }
  }
  return out;
}

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
      pageLabel(m),
      "电子复制件",
      readingLabel(m),
      qualityRemark(m.quality_flags ?? []),
    ] as (string | number | null)[]),
  ];

  // 不同材料对同一天的付款写了不同金额（判断规则见 payDayConflicts，与 materials.list 同一函数）
  const pay = payDayConflicts(input.materials, facts);
  /** 时间轴上要就地标一句“各份材料写的金额不一样”的句子（复评 N5：大小写不一致在时间轴行内有标注，这一类原先只写在补证清单里） */
  const crossSentences = pay.sentences;
  const yuan = (v: number) => `${v.toLocaleString("en-US")} 元`;
  const crossRows: string[] = pay.conflicts.map(
    (c) => `${c.date} 的付款，各份材料写的金额不一样：${c.amounts.map((x) => `${x.filenames.map((f) => `《${f}》`).join("、")}写 ${yuan(x.amount_yuan)}`).join("；")}——可能是同一笔，请对照银行回单或收款凭证核对；也可能是当天的两笔，仅凭材料文字无法区分`,
  );

  // 事实时间轴（按发生日排序；保留来源与锚点）。V14 第 39 批：“事件”写日期所在的那句话。
  // 第 58 批复测：表格行按列写成可读的事件句（不再搬“|”与“405000.0”）；签署栏、落款写成“落款：××”，同一份材料同一天另有事件的不再单列；
  // 页码行不进；同一日期、同一事件（文字相同或一句包含另一句）合并成一行，出处合并
  const linesByDoc = new Map(input.materials.map((m) => [m.document_version_id, linesOf(m.text)] as const));
  const datesByDoc = new Map<string, FactRow[]>();
  for (const d of dates) datesByDoc.set(d.document_version_id, [...(datesByDoc.get(d.document_version_id) ?? []), d]);
  const formed = new Map(input.materials.map((m) => [m.document_version_id, formationDate(m.text, datesByDoc.get(m.document_version_id) ?? [])] as const));
  interface TRow { sortKey: string; date: string; event: string; kind: "日期" | "金额"; amounts: string[]; flags: Set<string>; sign: boolean; doc: string; src: { filename: string; text: string; pos: string; nature: string }[] }
  /** 金额写千分位、去掉“.0”：1350000 → 1,350,000 元。 */
  const money = (v: number) => `${v.toLocaleString("en-US", { maximumFractionDigits: 2 })} 元`;
  const eventOf = (f: FactRow): { event: string; sign: boolean; lineStart: number } | null => {
    const t = textOf.get(f.document_version_id) ?? f.text;
    const lines = linesByDoc.get(f.document_version_id) ?? linesOf(t);
    const i = lineIndexAt(lines, f.char_start);
    const line = lines[i]!;
    if (PAGE_MARK_RE.test(line.text)) return null;
    const sign = signLine(lines, i);
    if (sign) return { event: sign.names.length > 0 ? `落款：${sign.names.join("、")}` : "落款日期", sign: true, lineStart: line.start };
    const table = tableRowEvent(lines, i);
    if (table !== null) return { event: table, sign: false, lineStart: line.start };
    const sp = sentenceAround(t, f.char_start, f.char_end);
    // 句子只剩日期加两三个字的（“李国栋 2025年11月12日”），写整行，读得出是谁、做了什么
    const short = t.slice(sp.start, sp.end).replace(f.text, "").replace(/\s+/g, "").length < 6 && line.text.length <= 200;
    const piece = short ? line.text.trim() : t.slice(sp.start, sp.end);
    return { event: tidyFloats(piece.replace(/\s+/g, " ")) || f.text, sign: false, lineStart: short ? line.start : sp.start };
  };
  const rawRows: TRow[] = [];
  const pushRow = (f: FactRow, date: string, sortKey: string, kind: "日期" | "金额") => {
    const e = eventOf(f);
    if (!e) return;
    // “类型”栏只写一句短的提示，详情在补证清单（复评 N1：原先把整段不一致说明塞进这一栏，两行各写一遍）
    const t = textOf.get(f.document_version_id) ?? f.text;
    const sp = sentenceAround(t, f.char_start, f.char_end);
    const flags = new Set<string>();
    if (f.conflict) flags.add("（大写与小写不一致，见补证清单）");
    if (crossSentences.has(`${f.document_version_id}|${sp.start}|${kind === "日期" ? f.normalized : Number.parseFloat(f.normalized)}`)) flags.add("（各份材料对这一天的付款写的金额不一样，见补证清单）");
    // 金额行的提示跟着那一笔金额写（同一句几笔合成一行时，不把这一笔的提示挂到别的金额上）
    const amountsOf = kind === "金额" ? [money(Number.parseFloat(f.normalized)) + [...flags].join("")] : [];
    if (kind === "金额") flags.clear();
    rawRows.push({ sortKey, date, event: e.event, kind, amounts: amountsOf, flags, sign: e.sign, doc: f.document_version_id, src: [{ filename: f.filename, text: f.text, pos: charPos(f.char_start, f.char_end), nature: natureOf(f.filename) }] });
  };
  for (const f of dates) {
    if (!f.normalized.startsWith("年份不明")) {
      pushRow(f, f.normalized, f.normalized, "日期");
      continue;
    }
    // 没写年份的：按本份材料其他日期推定；推定不了的写“X月X日（年份待核）”，排在最后
    const iso = inferYear(f, datesByDoc.get(f.document_version_id) ?? [], formed.get(f.document_version_id)?.iso ?? null, textOf.get(f.document_version_id));
    const [mo, d] = f.normalized.slice(-5).split("-").map(Number);
    if (iso) pushRow(f, `${iso}（年份按本文其他日期推定）`, iso, "日期");
    else pushRow(f, `${mo}月${d}日（年份待核）`, `9999-${f.normalized.slice(-5)}`, "日期");
  }
  // 金额按材料顺序、原文先后排（大写、小写、混写各条规则摘出的顺序不是原文顺序）
  const docOrder = new Map(input.materials.map((m, i) => [m.document_version_id, i] as const));
  for (const f of [...amounts].sort((a, b) => (docOrder.get(a.document_version_id) ?? 0) - (docOrder.get(b.document_version_id) ?? 0) || a.char_start - b.char_start)) pushRow(f, "（日期未明）", "（日期未明）", "金额");
  // 签署栏、落款：同一份材料同一天另有事件的，不再单列一行
  const hasOther = new Set(rawRows.filter((r) => !r.sign).map((r) => `${r.doc}|${r.sortKey}`));
  const norm = (s: string) => s.replace(/[\s|｜]+/g, "");
  const merged: TRow[] = [];
  for (const r of rawRows.filter((x) => !(x.sign && hasOther.has(`${x.doc}|${x.sortKey}`)))) {
    const n = norm(r.event);
    // 金额行：同一句里的几笔金额合成一行（“金额：386,000 元、115,800 元”）
    const same = merged.find((k) => k.sortKey === r.sortKey && k.kind === r.kind && (norm(k.event) === n || (!k.sign && !r.sign && (norm(k.event).includes(n) || n.includes(norm(k.event))))));
    if (!same) {
      merged.push(r);
      continue;
    }
    if (n.length > norm(same.event).length) same.event = r.event; // 留文字最全的一条
    for (const fl of r.flags) same.flags.add(fl);
    for (const a of r.amounts) if (!same.amounts.includes(a)) same.amounts.push(a);
    same.src.push(...r.src);
  }
  const uniq = (xs: string[]) => [...new Set(xs)];
  const posOf = (src: TRow["src"]) => {
    const files = uniq(src.map((s) => s.filename));
    return files.length > 1 ? uniq(src.map((s) => `《${s.filename}》${s.pos}`)).join("；") : uniq(src.map((s) => s.pos)).join("；");
  };
  const timelineRows: (string | number | null)[][] = [
    ["发生日期", "事件（所在原句）", "类型", "来源文件", "原文", "原文位置", "陈述性质"],
    ...merged
      .filter((r) => r.kind === "日期")
      // 推定不了年份的排在最后
      .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
      .map((r) => [r.date, r.event, (r.kind === "日期" ? "日期" : `金额：${r.amounts.join("、")}`) + [...r.flags].join(""), uniq(r.src.map((s) => s.filename)).join("、"), uniq(r.src.map((s) => s.text)).join("；"), posOf(r.src), uniq(r.src.map((s) => s.nature)).join("；")] as (string | number | null)[]),
    ...merged
      .filter((r) => r.kind !== "日期")
      .map((r) => [r.date, r.event, (r.kind === "日期" ? "日期" : `金额：${r.amounts.join("、")}`) + [...r.flags].join(""), uniq(r.src.map((s) => s.filename)).join("、"), uniq(r.src.map((s) => s.text)).join("；"), posOf(r.src), uniq(r.src.map((s) => s.nature)).join("；")] as (string | number | null)[]),
  ];

  // 证据目录（证明目的留空待律师填写——不擅自认定证明力）。第 58 批复测：名称去掉扩展名，写形成日期（写明取法）与页数
  const evidenceRows: (string | number | null)[][] = [
    ["编号", "证据名称", "形成日期", "来源", "页数", "原件状态", "证明目的（律师填写）", "待证事实（律师填写）"],
    // 来源：落款盖章的单位写出来（第 58 批 m01：对方出具的质量异议函与我方函件分不出来）；看不出落款的照旧写“待确认”
    ...input.materials.map((m, i) => {
      const seals = [...new Set(sealsIn(m.text).map((s) => s.name))];
      const source = seals.length > 0 ? `委托人提供（待确认）；落款盖章：${seals.slice(0, 3).join("、")}` : "委托人提供（待确认）";
      return [`E${i + 1}`, m.filename.replace(EXT_RE, ""), formed.get(m.document_version_id)?.label ?? "未见明确日期", source, pageLabel(m), "电子复制件", "", ""] as (string | number | null)[];
    }),
  ];

  // 争点—证据矩阵框架：按律师给的争点列行；拆要件、挂证据是第二段“争点与证据分析”（Agent）的事
  const matrixRows: (string | number | null)[][] = [
    ["争点", "要件", "举证责任", "支持证据（原文位置）", "反对证据", "缺口", "证明力意见（律师填写）"],
    ...(input.issues.length > 0
      ? input.issues.map((issue) => [issue, "（要件待拆解）", "（待确认）", "", "", "", ""] as (string | number | null)[])
      : [["（争点待填写：按确认的事实拆分要件、对应证据）", "", "", "", "", "", ""]] as (string | number | null)[][]),
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
        supplementRows.push(`《${m.filename}》第 ${pg.pageNo} 页：识别不清——建议重新扫描，或手工更正识别出的文字（原件不变）`);
      }
    }
  }

  // 材料内部不一致（本机规则只认得出大写与小写金额对不上；同一处两条只列一次）
  const conflictRows = amountWordsConflicts(amounts).map(
    ({ fact: f }) => `《${f.filename}》${charPos(f.char_start, f.char_end)}：${f.conflict}——请核对原件与其他材料（对账函、收付款记录），以哪一个为准由律师判断`,
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
  const gaps = ruleGaps(input.materials);
  missingRows.push(...gaps.excerpts, ...gaps.references, ...gaps.fees);
  // 律师填写的争点点名了的（如“原纸含水率”），列这类争点常用的证据（第 58 批复测）
  const issueRows = issueEvidenceRows(input.issues);
  missingRows.push(...issueRows);

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
              ? [...conflictRows, ...crossRows, "以上只比对了两类：成对写的大写与小写金额、不同材料对同一天付款写的金额；其他矛盾尚待结合争点逐项分析。"]
              : ["本清单只比对两类：成对写的大写与小写金额（紧挨着写，或表格里分别标了“大写”“小写”的），以及不同材料对同一天付款写的金额。这两类本次没有发现不一致——不等于材料之间没有矛盾，其他矛盾（如不同材料对同一事实说法不同）尚待结合争点逐项分析。"],
        },
        {
          heading: "三、待补材料",
          paragraphs:
            missingRows.length > 0
              ? [
                  ...missingRows,
                  issueRows.length > 0
                    ? "以上按材料文字列出四类：材料自己提到还没拿到的，摘录件、截图与复印件，正文引用了但材料里没有的文件，约定由一方承担、要凭票据主张的费用；以“争点”开头的几项按律师填写的争点列出这类争点常用的证据。每个争点具体还缺什么，尚待结合争点逐项梳理。"
                    : "以上按材料文字列出四类：材料自己提到还没拿到的，摘录件、截图与复印件，正文引用了但材料里没有的文件，约定由一方承担、要凭票据主张的费用；按争点还缺什么（如原始检测记录、完整的往来记录），尚待结合争点逐项梳理。",
                ]
              : ["本清单按材料文字列四类：材料里明说“尚未提供、未留存、待补”之类的，摘录件、截图与复印件，正文引用了但材料里没有的文件，约定由一方承担、要凭票据主张的费用。这四类这次都没有发现——不等于材料齐了：按争点还缺什么，尚待结合争点逐项梳理。"],
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
            "本报告只按材料文字摘出日期、金额与主体，未对行为与法律关系作分析，相关判断须结合争点另行分析并由律师确认。读不出的文件只列入目录，不进入任何结论。",
            "原件不会被修改；手工更正识别文字会另存一版。",
          ],
        },
      ]),
      manifest: { anchors: facts.length },
    },
  ];

  return { files, factsCount, qualityNotes };
}
