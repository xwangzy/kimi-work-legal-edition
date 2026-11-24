/**
 * 案号溯源（第 61 批，D-258）：产品没有案例库，案号的“存在性”离线核不了（citations.verify 一律“未核实（离线）”）；
 * 但律师引用的案例几乎都来自他自己下载、上传到事项里的裁判文书——能不能在本事项材料里找到出处，是代码可以判定的。
 *
 * - 成果里的每个案号与本事项材料（解析文字）、任务说明、律师作答逐一比对：找到的写明见哪份材料；找不到的，交付前检查当场报回助手，
 *   签发页写“材料里没有这个案号”（凭记忆写出的案号最容易是编造的，评分标准一票否决项 V1）。
 * - 占位案号（“（20××）……号”“XX号”“某中院”）报回：案号不知道的按工作准则写“【待填】”。
 * - 紧跟案号、以“认为 / 指出 / 裁判要旨 / 载明”引出的引号内文字，须能在材料里逐字找到（标点与空白不计），对不上的报回。
 *
 * 只读、纯函数为主；materialCaseIndex 读本事项材料的最新解析文字。签发门禁的语义不变（D-98：案号仍须律师勾选“已逐个核对”），
 * 这里只让律师知道每个案号该对照哪份文书、哪些在材料里根本没有。
 */
import type { KernelDb } from "../db.ts";

/** 法院案号：（2026）苏0505民初4417号、(2015)民二终字第123号；年份 19xx～20xx。 */
const COURT_CASE_RE = /[（(]\s*(?:19|20)\d{2}\s*[）)]\s*[0-9A-Za-z０-９Ａ-Ｚａ-ｚ一-龥]{1,20}?号/g;
/** 仲裁机构案号：京劳人仲字[2026]第1234号、沪劳人仲（2026）办字第88号（前缀须含“仲”，以免把“法释〔2020〕17号”这类文号当案号）。 */
const ARB_CASE_RE = /(?:(?![号与和及或的为是在见、])[一-龥]){0,8}仲[一-龥]{0,6}[（(〔［\[【]\s*(?:19|20)\d{2}\s*[）)〕］\]】][0-9A-Za-z０-９一-龥]{0,14}?号/g;
/** 占位写法：括号里年份不全或为 X、×、*，或案号主体里有 ××、XX、某。 */
const PLACEHOLDER_CASE_RE = /[（(〔]\s*(?:20[XxＸｘ×*＊]{2}|[XxＸｘ×*＊]{2,4}|\s{0,3})\s*[）)〕][^。；，、\n]{0,16}?(?:[XxＸｘ×*＊]{2,}|某)[^。；，、\n]{0,10}?号|[（(〔]\s*20\d{2}\s*[）)〕][^。；，、\n]{0,16}?(?:[XxＸｘ×*＊]{2,}|某)[^。；，、\n]{0,10}?号/g;
/** 法院案号的类型代字（2016 年起的案号规则与此前的“××字第”写法都含其一）。 */
const CASE_TYPE_RE = /[民刑行执赔破知商终初再审监申督清诉调仲]/;
/** 案号之后到引文之前的引出语（只核“某案认为：‘……’”这类把话算到判决头上的引文）。 */
const QUOTE_CUE_RE = /(?:认为|指出|裁判要旨|裁判观点|要旨|载明|写明|明确|阐明|表述为)/;

export interface CaseRef {
  raw: string;
  offset: number;
  key: string;
}

export interface CaseIndex {
  /** 归一化案号 → 出现在哪份材料（文件名）；任务说明与作答里出现的记“任务说明”。 */
  byKey: Map<string, string>;
  /** 各份材料的归一化全文（引文比对用）。 */
  texts: { filename: string; norm: string }[];
}

function toHalfWidth(s: string): string {
  return s.replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/** 案号归一化：全半角、各式括号、空白、“第”“字”不计（材料与成果写法常有这些出入）。 */
export function normalizeCaseNo(raw: string): string {
  return toHalfWidth(raw)
    .replace(/[（〔［\[【]/g, "(")
    .replace(/[）〕］\]】]/g, ")")
    .replace(/\s+/g, "")
    .replace(/[第字]/g, "");
}

/** 文字里的案号（法院与仲裁两种写法，按出现位置排序、同一位置不重复）。 */
export function caseRefsIn(text: string): CaseRef[] {
  const out: CaseRef[] = [];
  const taken: [number, number][] = [];
  for (const re of [ARB_CASE_RE, COURT_CASE_RE]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      // 法院案号的类型代字（民、刑、行、执、赔、破、知……）必有其一：“（2024）年度报告第3号”这类不是案号
      if (re === COURT_CASE_RE && !CASE_TYPE_RE.test(m[0].replace(/^[（(]\s*\d{4}\s*[）)]/, ""))) continue;
      // 仲裁写法的前缀可能把前面的汉字带进来：比对只用年份括号起的部分（caseKey）
      const end = start + m[0].length;
      if (taken.some(([a, b]) => start < b && end > a)) continue;
      taken.push([start, end]);
      out.push({ raw: m[0], offset: start, key: caseKey(m[0]) });
    }
  }
  return out.sort((a, b) => a.offset - b.offset);
}

/** 比对用的键：从年份括号起（仲裁前缀写法各异，只比括号起的部分，再加上前缀里“仲”字之后的机构简称不比）。 */
function caseKey(raw: string): string {
  const n = normalizeCaseNo(raw);
  const at = n.search(/\((?:19|20)\d{2}\)/);
  return at >= 0 ? n.slice(at) : n;
}

/** 占位案号（“（20××）……号”“（2026）某中院……号”）。 */
export function placeholderCaseRefs(text: string): CaseRef[] {
  PLACEHOLDER_CASE_RE.lastIndex = 0;
  return [...text.matchAll(PLACEHOLDER_CASE_RE)]
    .filter((m) => /[民刑行执商终初仲知破赔再审监申]/.test(m[0]))
    .map((m) => ({ raw: m[0], offset: m.index ?? 0, key: normalizeCaseNo(m[0]) }));
}

/** 引文比对用的归一化：去掉标点、空白与引号，全角数字字母转半角。 */
export function normalizeQuoteText(s: string): string {
  return toHalfWidth(s).replace(/[\s　"'“”‘’「」『』《》〈〉（）()【】\[\]〔〕，,。．.、；;：:！!？?—\-…·]/g, "");
}

/** 由材料文字（和任务说明、律师作答）建索引。纯函数。 */
export function buildCaseIndex(materials: readonly { filename: string; text: string }[], extra: readonly string[] = []): CaseIndex {
  const byKey = new Map<string, string>();
  const texts: CaseIndex["texts"] = [];
  for (const m of materials) {
    for (const r of caseRefsIn(m.text)) if (!byKey.has(r.key)) byKey.set(r.key, m.filename);
    texts.push({ filename: m.filename, norm: normalizeQuoteText(m.text) });
  }
  for (const t of extra) for (const r of caseRefsIn(t)) if (!byKey.has(r.key)) byKey.set(r.key, "任务说明或你的回答");
  return { byKey, texts };
}

export interface CaseProvenanceItem extends CaseRef {
  /** 在哪份材料里找到；null = 本事项材料、任务说明与作答里都没有。 */
  source: string | null;
}

/** 一个案号（任意写法）在索引里的出处；null = 找不到。 */
export function caseSource(raw: string, index: CaseIndex): string | null {
  return index.byKey.get(caseKey(raw)) ?? null;
}

export function caseProvenance(text: string, index: CaseIndex): CaseProvenanceItem[] {
  return caseRefsIn(text).map((r) => ({ ...r, source: index.byKey.get(r.key) ?? null }));
}

export interface CaseQuoteIssue {
  caseNo: string;
  quote: string;
  offset: number;
}

/**
 * 归到某个判决名下的引文（案号之后 80 字内有“认为 / 指出 / 裁判要旨 / 载明”等引出语，再接引号）：去掉标点空白后，
 * 引文（按省略号切开，每段 ≥ 8 字）须能在某份材料里逐字找到。只核案号能在材料里找到的那些——找不到的案号另有一条报告。
 */
export function caseQuoteIssues(text: string, index: CaseIndex): CaseQuoteIssue[] {
  const out: CaseQuoteIssue[] = [];
  if (index.texts.length === 0) return out;
  for (const r of caseRefsIn(text)) {
    if (!index.byKey.has(r.key)) continue;
    const after = text.slice(r.offset + r.raw.length, r.offset + r.raw.length + 80);
    const q = /[“「"]([^”」"]{12,600})[”」"]/.exec(after);
    if (!q || q.index === undefined) continue;
    const lead = after.slice(0, q.index);
    if (!QUOTE_CUE_RE.test(lead) || /[。；]/.test(lead)) continue;
      if (!quoteInMaterials(q[1]!, index)) out.push({ caseNo: r.raw, quote: q[1]!.slice(0, 60), offset: r.offset + r.raw.length + q.index });
  }
  return out;
}

/** 把话算到法院、仲裁庭或裁判文书头上的引出语（第 61 批：裁判文书研读、上诉状、代理词转述判决时最容易“改写后仍加引号”）。 */
const COURT_CUE_RE = /(?:本院认为|(?:一审|原审|二审|再审)?法院(?:经审理)?(?:认为|认定|查明)|(?:一审|原审)?判决(?:书)?(?:认为|认定|载明|写明|查明|原文)|裁定(?:书)?(?:认为|认定|载明|原文)|仲裁庭(?:认为|认定)|裁决书?(?:认为|认定|载明))[^“「"。；\n]{0,12}[“「"]([^”」"]{12,600})[”」"]/g;

/**
 * 紧接在一段法院名下引文之后、用“又认定 / 另认为 / 同段 / 该段”续写的下一段引文（第 61 批真实验收 v35-L2-caselaw-r3：
 * “判决原文：‘……’又认定：‘……’”“同段：‘……’”，续写的那段把“签署确认单后”改成“确认单签署后”仍加引号，没被核到）。
 */
const COURT_CONT_RE = /^[^“「"。；\n]{0,4}?(?:又|另|并|还|同段|该段|同时|进而|随后|后文|下文)[^“「"。；\n]{0,8}?[“「"]([^”」"]{12,600})[”」"]/;

export interface QuoteIssue {
  quote: string;
  offset: number;
}

/** 引文是否能在材料里逐字找到（标点空白不计；按省略号切开，每段 ≥ 8 字都要找到）。 */
/** 隐私代号（〔自然人·KX92PA〕等）：交付件里是代号、材料解析文字是原文，比对时当作通配——在代号处切开、各段分别核对。 */
const TOKEN_SPLIT_RE = /〔[^〔〕·]{1,8}·[0-9A-Z]{4,16}〕/g;

export function quoteInMaterials(quote: string, index: CaseIndex): boolean {
  const pieces = quote.split(TOKEN_SPLIT_RE).flatMap((x) => x.split(/……|\.{3,}|…/)).map(normalizeQuoteText).filter((p) => p.length >= 8);
  if (pieces.length === 0) return true;
  return pieces.every((p) => index.texts.some((t) => t.norm.includes(p)));
}

/** 归到法院、仲裁庭或裁判文书名下的引文（“本院认为：‘……’”“一审判决认定‘……’”）须能在本事项材料里逐字找到。 */
export function courtQuoteIssues(text: string, index: CaseIndex): QuoteIssue[] {
  if (index.texts.length === 0) return [];
  const out: QuoteIssue[] = [];
  COURT_CUE_RE.lastIndex = 0;
  for (const m of text.matchAll(COURT_CUE_RE)) {
    if (!quoteInMaterials(m[1]!, index)) out.push({ quote: m[1]!.slice(0, 60), offset: (m.index ?? 0) + m[0].indexOf(m[1]!) });
    // 续写的引文逐段跟着核（最多 6 段，防病态长文）
    let end = (m.index ?? 0) + m[0].length;
    for (let k = 0; k < 6; k++) {
      const c = COURT_CONT_RE.exec(text.slice(end, end + 640));
      if (!c) break;
      if (!quoteInMaterials(c[1]!, index)) out.push({ quote: c[1]!.slice(0, 60), offset: end + c[0].indexOf(c[1]!) });
      end += c[0].length;
    }
  }
  return out;
}

/** 表格里写逐字原文的列（“原文摘录”“逐字引文”“条款原文”“原文”）。 */
// 只认明确要求“逐字”的列名；研究备忘录《来源目录》的“摘录”列放的是法条要点，不在此列（第 58 批 48 卡回放：m34 二十余处全是法条概括）
export const QUOTE_COLUMN_RE = /^(?:.*(?:原文摘录|逐字引文|逐字摘录|条款原文|原话|引文)|原文|合同原文|材料原文)(?:[（(].*[）)])?$/;
/** 这些写法表示“没有找到”，不是引文。 */
const NOT_FOUND_RE = /^(?:无|未见|没找到|未找到|全文未见|材料未载明|不适用|—|-|\/|待补|见[^，。]{0,20})$|未见|没有找到|未找到|未约定|没有约定|未作约定|未写明|未规定|未载明|未检出|缺少|没有[^，。]{0,10}条款|^无[^，。]{0,16}$|无[^，。]{0,12}专门条款/;

/** 去掉开头的位置说明与条款编号（“第 5.2 条：”“插入位置原文：”“4.2 ”“（一）”——自动编号在材料解析文字里没有）与结尾的出处括注。 */
function stripLead(q: string): string {
  let t = q.trim().replace(/^[^：:“"]{1,14}原文[：:]\s*/, "").replace(/^(?:\d{4}\s*年?版|[^：:“"]{1,8}版)[：:]\s*/, "").replace(/^(?:第[^：:，]{1,16}[条款项页段]|[^：:]{1,12}第[^：:]{1,8}[条款项页段])[：:]\s*/, "");
  for (let i = 0; i < 3; i++) t = t.replace(/^\s*(?:\d+(?:\.\d+)*[.、．]?\s+|\d+(?:\.\d+)+\s*|[（(][一二三四五六七八九十\d]{1,3}[)）]\s*|[一二三四五六七八九十]{1,3}、\s*|第[一二三四五六七八九十百零\d.]+[条款项]\s*)/, "");
  return t.replace(/[（(][^（）()]{0,20}(?:页|条|段)[）)]\s*$/, "");
}

/**
 * 表格“原文摘录”类列逐格核对（第 61 批）：格里有引号的核引号里的每段，没有引号的去掉开头的位置说明（“第 5.2 条：”“第3页：”）后整格核对；
 * 写“未见 / 没找到 / 不适用”的不核；去掉标点后不足 8 字的不核。返回（工作表或节名、行号、列名、格内容）。纯函数。
 */
export function quoteColumnIssues(tables: readonly { name: string; columns: readonly unknown[]; rows: readonly (readonly unknown[])[] }[], index: CaseIndex): { where: string; text: string }[] {
  if (index.texts.length === 0) return [];
  const out: { where: string; text: string }[] = [];
  for (const t of tables) {
    const cols = t.columns.map((c, i) => ({ i, name: String(c ?? "").trim() })).filter((c) => QUOTE_COLUMN_RE.test(c.name));
    if (cols.length === 0) continue;
    t.rows.forEach((r, ri) => {
      for (const c of cols) {
        const raw = String(r[c.i] ?? "").trim();
        if (!raw || NOT_FOUND_RE.test(raw)) continue;
        const quoted = [...raw.matchAll(/[“「"]([^”」"]{4,600})[”」"]/g)].map((m) => m[1]!);
        const parts = (quoted.length > 0 ? quoted : [raw]).map(stripLead);
        if (parts.some((q) => !quoteInMaterials(q, index))) out.push({ where: `${t.name}第 ${ri + 1} 行“${c.name}”列`, text: raw.slice(0, 60) });
        if (out.length >= 12) return;
      }
    });
  }
  return out;
}

export const COURT_QUOTE_FIX = "引号里的话归到法院、仲裁庭或裁判文书名下，但在本事项材料里逐字找不到（标点与空白已不计）：照文书原文改正；是概括或转述的，去掉引号并写明出处段落";
export const QUOTE_COLUMN_FIX = "这一格放在“原文摘录”类列里，但在本事项材料里逐字找不到（标点与空白已不计）：照材料原文逐字摘录（可用省略号截取），或者写“未见”；概括的话放到其他列";

/**
 * 本事项材料的案号索引：每份未隔离材料的最新解析文字；再加上本任务（及其追问链）的任务说明与律师作答。
 * 读不到任何材料时返回空索引（调用方据 texts.length 判断是否核对）。
 */
export function materialCaseIndex(db: KernelDb, matterId: string, runId?: string | null): CaseIndex {
  const docs = db.all<{ document_version_id: string; filename: string }>(
    `SELECT document_version_id, filename FROM document_versions WHERE matter_id = ? AND quarantined_at IS NULL ORDER BY created_at`,
    [matterId],
  );
  const materials: { filename: string; text: string }[] = [];
  for (const d of docs) {
    const row = db.get<{ content: string }>(
      `SELECT pt.content FROM parse_versions pv JOIN parse_texts pt ON pt.parse_version_id = pv.parse_version_id
        WHERE pv.document_version_id = ? ORDER BY pv.created_at DESC LIMIT 1`,
      [d.document_version_id],
    );
    if (row?.content) materials.push({ filename: d.filename, text: row.content.slice(0, 2_000_000) });
  }
  const extra: string[] = [];
  if (runId) {
    try {
      const snap = db.get<{ input_snapshot: string }>(`SELECT input_snapshot FROM runs WHERE run_id = ?`, [runId])?.input_snapshot;
      const goal = snap ? JSON.parse(snap)?.goal : null;
      if (typeof goal === "string") extra.push(goal);
    } catch {
      // 任务快照读不出不影响材料比对
    }
    for (const r of db.all<{ payload: string }>(
      `SELECT payload FROM run_events WHERE run_id = ? AND type IN ('agent.question_answered','agent.approval_decided')`,
      [runId],
    )) {
      try {
        const lines = JSON.parse(r.payload)?.answer_lines;
        if (Array.isArray(lines)) extra.push(lines.filter((l: unknown) => typeof l === "string").join("\n"));
      } catch {
        // 同上
      }
    }
  }
  return buildCaseIndex(materials, extra);
}

/** 交付前检查与签发页共用的说法。 */
export const CASE_NOT_IN_MATERIALS_FIX =
  "本事项材料里找不到这个案号，系统无法核实它是否存在（凭记忆写出的案号最容易出错或根本不存在）：只引用律师提供的裁判文书里的案号；确有其案而律师没有提供的，删去案号，把要找的案例写进最终答复的“待检索”事项，请律师补充判决后再引用";
export const CASE_PLACEHOLDER_FIX = "案号用了占位写法：不知道的案号按工作准则写“【待填】”，不要写“20××”“XX号”“某中院”这类看起来像案号的占位";
export const CASE_QUOTE_FIX = "引号里的话归在这个判决名下，但在本事项材料里逐字找不到（标点与空白已不计）：照判决原文改正，或去掉引号改为概括并写明出处段落";
