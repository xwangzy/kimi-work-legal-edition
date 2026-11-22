/**
 * 金额勾稽检查（第 57 批）：文书和计算表里的数字都是模型手填的，此前交付前检查的算术类只有“带合计行的表逐列求和”一项。
 * V30 十三张卡真实验收里的金额错误一处都没被拦住：
 *   - 劳动仲裁应对：Word 工资口径表同一行“总额 418,637.93｜月均 35,162.36｜公式 6×34,886.49×2｜结果 421,948.32”，
 *     6×34,886.49×2＝418,637.88，结果格是另一种口径的数；
 *   - 同一份方案第三部分年休假追加额写 8,563.23，第四部分与最新版敞口表是 8,487.12——旧数留在了 Word 里。
 *
 * 两项检查，均为纯函数（输入是已经抽好的段落与表格行），宁可漏报不误报：
 *   A. 算式复核：写出来的算式（行内“a×b＝c”、表格里整格是算式、右邻格是结果）逐条复算；
 *   B. 跨成果金额对账：本单有计算表（xlsx）时，文书里“算出来的金额”在计算表、材料、本文书成立的算式里都找不到出处的，报出。
 */

export interface AmountPara {
  where: string;
  text: string;
}
export interface AmountRow {
  where: string;
  cells: (string | number | null)[];
  /** 表头（可选）：用来判断不带“元”的纯数字格是不是金额格。 */
  columns?: (string | number | null)[];
}
export interface AmountBlocks {
  paragraphs?: AmountPara[];
  rows?: AmountRow[];
}
export interface AmountDoc extends AmountBlocks {
  filename: string;
  kind: "docx" | "xlsx";
}
export interface AmountCheckInput {
  docs: AmountDoc[];
  /** 可作为数字出处的文字：材料原文、律师的委托与回答等。 */
  sources?: string[];
}

export interface EquationIssue {
  kind: "equation";
  where: string;
  /** 算式原文（至多 80 字）。 */
  text: string;
  /** 左边复算的结果。 */
  expected: number;
  /** 写出来的结果。 */
  actual: number;
  fix: string;
  /** 所在文件（checkAmounts 填）。 */
  filename?: string;
}
export interface OrphanAmountIssue {
  kind: "orphan_amount";
  where: string;
  text: string;
  amount: number;
  fix: string;
  filename?: string;
}
export type AmountIssue = EquationIssue | OrphanAmountIssue;

export interface AmountCheckResult {
  issues: AmountIssue[];
  stats: { equations_checked: number; equations_failed: number; amounts_checked: number; orphans: number };
}

// ───────────────────────── 公共：归一化与数字 ─────────────────────────

/** 逐字替换（长度不变，位置一一对应）：全角数字、括号、运算符、等号、百分号统一成半角。 */
function normalize(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const code = c.charCodeAt(0);
    if (code >= 0xff10 && code <= 0xff19) out += String.fromCharCode(code - 0xff10 + 48);
    else if (c === "（") out += "(";
    else if (c === "）") out += ")";
    else if (c === "×" || c === "✕" || c === "＊" || c === "*" || c === "·") out += "*";
    else if ((c === "x" || c === "X") && /\d/.test(s[i - 1] ?? "") && /\d/.test(s[i + 1] ?? "")) out += "*";
    else if (c === "÷" || c === "／") out += "/";
    else if (c === "＋") out += "+";
    else if (c === "－" || c === "−") out += "-";
    else if (c === "＝") out += "=";
    else if (c === "％") out += "%";
    else out += c;
  }
  return out;
}

const NUM_SRC = String.raw`\d+(?:,\d+)*(?:\.\d+)?`;
/** 千分位必须规范（“1,2,3”这类列举不当数）。 */
function parseNum(raw: string): number | null {
  if (raw.includes(",") && !/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(raw)) return null;
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

const cents = (n: number) => Math.round(n * 100);
function fmt(n: number): string {
  const s = (Math.round(n * 100) / 100).toFixed(2).replace(/\.00$/, "");
  const [i, d] = s.split(".");
  return i!.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (d ? `.${d}` : "");
}
const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n)}…` : s);

// ───────────────────────── A. 算式复核 ─────────────────────────

const UNIT_SRC = String.raw`(?:万元|元|天|日|个月|年|倍|件)`;
const TERM_SRC = String.raw`\(*${NUM_SRC}[%‰]?${UNIT_SRC}?\)*`;
const OP_SRC = String.raw`\s*[*/+\-]\s*`;
const EXPR_SRC = String.raw`${TERM_SRC}(?:${OP_SRC}${TERM_SRC})*`;
const CHAIN_RE = new RegExp(String.raw`${EXPR_SRC}(?:\s*=\s*${EXPR_SRC})+`, "g");
const EXPR_ONLY_RE = new RegExp(String.raw`^\s*${EXPR_SRC}\s*$`);

type Tok = { t: "num"; v: number } | { t: "op"; v: string } | { t: "(" } | { t: ")" };
interface Parsed {
  value: number;
  nums: number[];
  ops: number;
  /** 含除法或百分比（舍入误差放宽）。 */
  lossy: boolean;
  /** 有数带“万元”。 */
  wan: boolean;
}

const TOKEN_RE = new RegExp(String.raw`\s*(?:(${NUM_SRC})([%‰])?(${UNIT_SRC})?|([*/+\-])|(\()|(\)))`, "y");

/** 解析一边（无等号）的算式；任何含糊（千分位不规范、括号不配、一元负号、两个数挨着）返回 null。 */
function parseExpr(src: string): Parsed | null {
  const toks: Tok[] = [];
  const nums: number[] = [];
  let lossy = false;
  let wan = false;
  let pos = 0;
  const s = src.trim();
  while (pos < s.length) {
    TOKEN_RE.lastIndex = pos;
    const m = TOKEN_RE.exec(s);
    if (!m || TOKEN_RE.lastIndex === pos) return null;
    pos = TOKEN_RE.lastIndex;
    if (m[1] !== undefined) {
      let v = parseNum(m[1]);
      if (v === null) return null;
      if (m[2] === "%") (v /= 100), (lossy = true);
      else if (m[2] === "‰") (v /= 1000), (lossy = true);
      if (m[3] === "万元") (v *= 10000), (wan = true);
      toks.push({ t: "num", v });
      nums.push(v);
    } else if (m[4]) {
      if (m[4] === "/") lossy = true;
      toks.push({ t: "op", v: m[4] });
    } else if (m[5]) toks.push({ t: "(" });
    else if (m[6]) toks.push({ t: ")" });
  }
  // 递归下降：expr := term (('+'|'-') term)*；term := factor (('*'|'/') factor)*；factor := num | '(' expr ')'
  let i = 0;
  let ops = 0;
  const factor = (): number | null => {
    const t = toks[i];
    if (!t) return null;
    if (t.t === "num") return i++, t.v;
    if (t.t === "(") {
      i++;
      const v = expr();
      if (v === null || toks[i]?.t !== ")") return null;
      i++;
      return v;
    }
    return null;
  };
  const term = (): number | null => {
    let v = factor();
    if (v === null) return null;
    for (;;) {
      const t = toks[i];
      if (t?.t !== "op" || (t.v !== "*" && t.v !== "/")) return v;
      i++, ops++;
      const r = factor();
      if (r === null) return null;
      if (t.v === "/") {
        if (r === 0) return null;
        v /= r;
      } else v *= r;
    }
  };
  const expr = (): number | null => {
    let v = term();
    if (v === null) return null;
    for (;;) {
      const t = toks[i];
      if (t?.t !== "op" || (t.v !== "+" && t.v !== "-")) return v;
      i++, ops++;
      const r = term();
      if (r === null) return null;
      v = t.v === "+" ? v + r : v - r;
    }
  };
  const value = expr();
  if (value === null || i !== toks.length) return null;
  return { value, nums, ops, lossy, wan };
}

/** 去掉两头多出来的括号（“（＝8,910元）”的右括号、“（1）810,000×…”的左括号）。 */
function trimParens(s: string): string {
  let t = s;
  const count = (x: string, c: string) => x.split(c).length - 1;
  while (t.startsWith("(") && count(t, "(") > count(t, ")")) t = t.slice(1);
  while (t.endsWith(")") && count(t, ")") > count(t, "(")) t = t.slice(0, -1);
  return t;
}

/** 整条跳过的含糊情形：日期、版本号或条款号（a.b.c）、两个数之间是“-”的日期区间或型号。 */
const AMBIGUOUS_RE = /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d+\.\d+\.\d+|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}/;
const APPROX_BEFORE_RE = /(?:约|大约|近|将近|约合|约为|不足|超过|逾|不低于|不高于|不超过|最高|最低|至少|至多|上限|下限)\s*$/;
const APPROX_AFTER_RE = /^\s*(?:余(?![额款下])|多|左右|以上|以下|以内|不等|上下|许)/;
/** 同一分句里在它前面出现过“约 / 大约 / 估算 / 预估”（“申请费分别约 2,391.03 元、3,216.03 元”）：整句都是估算。“约定”“违约”“合约”里的“约”不算。 */
const APPROX_CLAUSE_RE = /(?:^|[^违合契签履解缔毁公条规盟制特节集要预])约(?![定束谈见请])|大约|估算|预估|估计|概算/;
function approxInClause(s: string, at: number): boolean {
  let i = at - 1;
  // 半角逗号后面紧跟数字的是千分位，不是分句
  while (i >= 0 && !(/[，；;。！？!?\n]/.test(s[i]!) || (s[i] === "," && !/\d/.test(s[i + 1] ?? "")))) i--;
  return APPROX_CLAUSE_RE.test(s.slice(i + 1, at));
}
/**
 * 比较的容差：分位舍入 0.011；含除法或百分比的，中间结果可能先取到分再往下乘（日工资 ÷21.75 后 × 天数 × 倍数），放宽到 0.10 元与结果的十万分之一中较大的。
 * 初版放宽到结果的 0.5%：418,637.93÷12 写成 35,000 也放过了，这正是要抓的那一类错。
 */
function tolerance(left: Parsed, result: number): number {
  return left.lossy ? Math.max(0.1, 1e-5 * Math.abs(result)) : 0.011;
}

const EQ_FIX = (x: number, y: number) => `这道算式左边算出来是 ${fmt(x)}，写的是 ${fmt(y)}：核对后改正有错的一边，文书和表格里引用同一个数的地方一并改`;

interface EqOutcome {
  /** 复算成立的算式：结果与左边出现的数（金额对账可引为出处）。 */
  okNums: number[];
  /** 不成立的算式里出现的数（已由算式复核报出，金额对账不再重复报）。 */
  badNums: number[];
  /** 有不成立算式的表格行（同一行其它格的金额不再另报“无出处”）。 */
  badRows: Set<string>;
  checked: number;
  issues: EquationIssue[];
}

/** 一段文字里的行内算式。 */
function inlineEquations(where: string, text: string, out: EqOutcome): void {
  const s = normalize(text);
  CHAIN_RE.lastIndex = 0;
  for (const m of s.matchAll(CHAIN_RE)) {
    const start = m.index!;
    const end = start + m[0].length;
    const before = s.slice(Math.max(0, start - 6), start);
    const after = s.slice(end, end + 6);
    const prev = before.slice(-1);
    // 算式与文字混在一起（“月工资×2×3＝…”“…＝8,487.12元/天”）、数字被截断、日期等：整条跳过
    // 全角冒号（“计算：a×b＝c”）可以；半角冒号多是比例或时刻（“1:2”“10:30”）
    if (/[\dA-Za-z.,_#\-/*+=%‰:]/.test(prev)) continue;
    if (/^\s*[\dA-Za-z*/+\-=%‰:：万千百亿兆]/.test(after)) continue;
    if (/^\s*[.,]\d/.test(after)) continue;
    if (APPROX_BEFORE_RE.test(before) || APPROX_AFTER_RE.test(after) || approxInClause(s, start)) continue;
    const raw = trimParens(m[0].trim());
    if (AMBIGUOUS_RE.test(raw)) continue;
    const sides = raw.split("=").map((x) => x.trim());
    const parsed = sides.map(parseExpr);
    if (parsed.some((p) => p === null)) continue;
    const ps = parsed as Parsed[];
    if (ps[0]!.nums.length < 2 || ps[0]!.ops < 1) continue;
    if (ps.some((p) => p.value < 0)) continue;
    // 量级只写在结果一边（“12×5＝60万元”）：左边可能是以万元计的数，整条跳过
    if (ps.slice(1).some((p) => p.wan) && !ps[0]!.wan) continue;
    out.checked++;
    let failed: { exp: number; act: number } | null = null;
    for (let k = 0; k + 1 < ps.length; k++) {
      const l = ps[k]!;
      const r = ps[k + 1]!;
      if (Math.abs(l.value - r.value) > tolerance(l, r.value)) {
        failed = { exp: l.value, act: r.value };
        break;
      }
    }
    const nums = ps.flatMap((p) => [p.value, ...p.nums]);
    if (failed) {
      out.badNums.push(...nums);
      out.issues.push({ kind: "equation", where, text: clip(text.slice(start, end).trim()), expected: round2(failed.exp), actual: round2(failed.act), fix: EQ_FIX(failed.exp, failed.act) });
    } else out.okNums.push(...nums);
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** 纯数字格（可带“人民币 / ¥”与“元 / 万元”）；返回元。 */
const AMOUNT_CELL_RE = /^\s*(?:人民币|RMB|￥|¥)?\s*(\d+(?:,\d+)*(?:\.\d+)?)\s*(元|万元)?\s*$/;
function cellAmount(v: unknown): { n: number; unit: string } | null {
  if (typeof v === "number") return Number.isFinite(v) ? { n: v, unit: "" } : null;
  const m = AMOUNT_CELL_RE.exec(String(v ?? ""));
  if (!m) return null;
  const n = parseNum(m[1]!);
  if (n === null) return null;
  return { n: m[2] === "万元" ? n * 10000 : n, unit: m[2] ?? "" };
}

/** 表格行：某格整格是没有等号的算式，同一行右边紧挨着的非空格是纯数字结果。 */
function rowEquations(row: AmountRow, out: EqOutcome): void {
  const cells = row.cells.map((c) => (c === null || c === undefined ? "" : String(c)));
  cells.forEach((c, j) => {
    if (/[=＝]/.test(c)) return inlineEquations(row.where, c, out);
    const s = normalize(c).trim();
    if (!s || !EXPR_ONLY_RE.test(s)) return;
    // 表格里的“-”多是区间、日期或编号（“1-8”“2021-03”）：只认全角减号，半角连字符整格跳过
    if (/-/.test(c)) return;
    if (AMBIGUOUS_RE.test(s)) return;
    const p = parseExpr(trimParens(s));
    if (!p || p.nums.length < 2 || p.ops < 1 || p.value < 0) return;
    // 只认乘除式或带括号的式子：纯加法格常是“3+2 天”之类的计数说明
    if (!/[*/]/.test(s)) return;
    let k = j + 1;
    while (k < cells.length && cells[k]!.trim() === "") k++;
    if (k >= cells.length) return;
    const r = cellAmount(row.cells[k]);
    if (!r || r.n < 0) return;
    out.checked++;
    const nums = [p.value, ...p.nums, r.n];
    if (Math.abs(p.value - r.n) > tolerance(p, r.n)) {
      out.badNums.push(...nums);
      out.badRows.add(row.where);
      out.issues.push({ kind: "equation", where: row.where, text: clip(`${c.trim()}｜${String(row.cells[k]).trim()}`), expected: round2(p.value), actual: round2(r.n), fix: EQ_FIX(p.value, r.n) });
    } else out.okNums.push(...nums);
  });
}

function runEquations(blocks: AmountBlocks): EqOutcome {
  const out: EqOutcome = { okNums: [], badNums: [], badRows: new Set(), checked: 0, issues: [] };
  for (const p of blocks.paragraphs ?? []) inlineEquations(p.where, p.text, out);
  for (const r of blocks.rows ?? []) rowEquations(r, out);
  return out;
}

/** 算式复核：写出来的算式复算不成立的，逐条报出。 */
export function equationIssues(blocks: AmountBlocks): EquationIssue[] {
  return runEquations(blocks).issues;
}

// ───────────────────────── B. 跨成果金额对账 ─────────────────────────

/** 文字里所有的数（出处集合用）：带“万 / 万元”的另存换算值。 */
function allNumbers(text: string, into: Set<number>): void {
  const s = normalize(text);
  for (const m of s.matchAll(/(\d+(?:,\d+)*(?:\.\d+)?)(\s*万)?/g)) {
    const n = parseNum(m[1]!);
    if (n === null) {
      // 不规范的千分位：拆开逐段收
      for (const part of m[1]!.split(",")) {
        const v = Number(part);
        if (Number.isFinite(v)) into.add(cents(v));
      }
      continue;
    }
    into.add(cents(n));
    if (m[2]) into.add(cents(n * 10000));
  }
}
function cellNumbers(v: unknown, into: Set<number>): void {
  if (typeof v === "number") {
    if (Number.isFinite(v)) into.add(cents(v)), into.add(cents(Number(v.toFixed(2))));
    return;
  }
  if (v !== null && v !== undefined) allNumbers(String(v), into);
}

/** 金额列的表头：不带“元”的纯数字格只在这种列里算金额。 */
const MONEY_COL_RE = /金额|（元）|\(元\)|元）|万元|价款|价格|总价|费用|费$|赔偿|补偿|工资|薪|合计|小计|总计|本金|利息|违约金|敞口|数额|余额|应付|已付|未付|欠款|标的|款项|罚息|损失|报酬/;
const NOT_MONEY_COL_RE = /率|比例|天数|日数|日期|期限|编号|序号|月数|年限|时间|数量|件数|次数|%|％|号/;

/** 算出来的金额：≥1,000，且有非零角分或不是 100 的整数倍（整百整千的多是约定数，不是算的）。 */
const isComputed = (n: number) => n >= 1000 && cents(n) % 10000 !== 0;

interface Found {
  amount: number;
  where: string;
  text: string;
  /** 所在段落或表格行里出现的全部数（按出现顺序，元）：用来认“就地算出来的”金额。 */
  local: number[];
}

/** 一段文字里按出现顺序的全部数（带“万 / 万元”的换算成元；百分比不收）。 */
function numbersInOrder(text: string): number[] {
  const out: number[] = [];
  const s = normalize(text);
  for (const m of s.matchAll(/(\d+(?:,\d+)*(?:\.\d+)?)(\s*万元?)?(?![\d%‰])/g)) {
    const n = parseNum(m[1]!);
    if (n !== null) out.push(m[2] ? n * 10000 : n);
  }
  return out;
}

/** 文字里带“元 / 万元”的金额。 */
function textAmounts(where: string, text: string, into: Found[], local?: number[]): void {
  const s = normalize(text);
  const nums = local ?? numbersInOrder(text);
  for (const m of s.matchAll(/(\d+(?:,\d+)*(?:\.\d+)?)\s*(万元|元)/g)) {
    const at = m.index!;
    const prev = s.slice(Math.max(0, at - 1), at);
    // 数字被截断（前面还是数字、字母、小数点、连字符）、编号、号码：不是金额
    if (/[\dA-Za-z.,_#\-/:：]/.test(prev)) continue;
    const n0 = parseNum(m[1]!);
    if (n0 === null) continue;
    const n = m[2] === "万元" ? n0 * 10000 : n0;
    const before = s.slice(Math.max(0, at - 6), at);
    if (/(?:案号|编号|证号|电话|手机|账号|卡号|号码)[:：\s]*$/.test(before)) continue;
    // 估算的数（“约 7,975 元”“3,000 元左右”）：本来就不是逐分算的，不追出处
    if (APPROX_BEFORE_RE.test(before) || APPROX_AFTER_RE.test(s.slice(at + m[0].length, at + m[0].length + 4)) || approxInClause(s, at)) continue;
    into.push({ amount: n, where, text: clip(text.slice(Math.max(0, at - 16), at + m[0].length + 8).trim(), 60), local: nums });
  }
}

function docAmounts(doc: AmountDoc): Found[] {
  const found: Found[] = [];
  for (const p of doc.paragraphs ?? []) textAmounts(p.where, p.text, found);
  for (const r of doc.rows ?? []) {
    const local = r.cells.flatMap((c) => (typeof c === "number" ? [c] : numbersInOrder(String(c ?? ""))));
    r.cells.forEach((c, j) => {
      const col = String(r.columns?.[j] ?? "");
      const a = typeof c === "string" ? cellAmount(c) : null;
      if (a && (a.unit || (MONEY_COL_RE.test(col) && !NOT_MONEY_COL_RE.test(col)))) {
        found.push({ amount: a.n, where: r.where, text: clip(`${col ? `${col}：` : ""}${String(c).trim()}`, 60), local });
        return;
      }
      if (typeof c === "string" && !a) textAmounts(r.where, c, found, local);
    });
  }
  return found;
}

/** 全文书的数（出处推导用）。 */
function docNumbers(doc: AmountDoc): number[] {
  const out: number[] = [];
  for (const p of doc.paragraphs ?? []) out.push(...numbersInOrder(p.text));
  for (const r of doc.rows ?? []) for (const c of r.cells) out.push(...(typeof c === "number" ? [c] : numbersInOrder(String(c ?? ""))));
  return out;
}

/**
 * 金额“就地可推”：同一段（或同一表格行）里连续几个数之和，或段内另一个数乘除段内一个整数；
 * 或者全文书、计算表里两个（与它不同的）金额之和、之差。这些数虽然计算表里没有，但读者能从上下文算出来，不算无出处。
 */
function derivable(f: Found, pool: number[]): boolean {
  const k = cents(f.amount);
  const loc = f.local.filter((x) => cents(x) !== k && x > 0);
  for (let i = 0; i < loc.length; i++) {
    let sum = 0;
    for (let j = i; j < loc.length; j++) {
      sum += loc[j]!;
      if (j > i && cents(sum) === k) return true;
    }
  }
  const ints = loc.filter((x) => Number.isInteger(x) && x >= 2 && x <= 1000);
  for (const y of loc) for (const t of ints) if (y !== t && (cents(y * t) === k || cents(y / t) === k)) return true;
  const amounts = [...new Set(pool.filter((x) => x >= 100).map(cents))].filter((c) => c !== k).sort((a, b) => a - b);
  const has = new Set(amounts);
  for (const a of amounts) {
    if (a >= k) break;
    if (has.has(k - a) && k - a !== a) return true;
  }
  for (const a of amounts) if (a > k && has.has(a - k)) return true;
  return false;
}

const ORPHAN_FIX = "这个金额在本任务最新的计算表和材料里都找不到出处：是旧数就改成计算表里的数；是新算出来的，把它补进计算表，或在文书里写出算式";
const MAX_ORPHANS_PER_DOC = 12;

interface OrphanOutcome {
  issues: OrphanAmountIssue[];
  checked: number;
}

function runOrphans(input: AmountCheckInput, eqByDoc: Map<AmountDoc, EqOutcome>): OrphanOutcome {
  const out: OrphanOutcome = { issues: [], checked: 0 };
  const sheets = input.docs.filter((d) => d.kind === "xlsx");
  if (sheets.length === 0) return out;
  const known = new Set<number>();
  const sheetNums: number[] = [];
  for (const x of sheets) {
    for (const p of x.paragraphs ?? []) allNumbers(p.text, known), sheetNums.push(...numbersInOrder(p.text));
    for (const r of x.rows ?? []) for (const c of [...r.cells, ...(r.columns ?? [])]) cellNumbers(c, known), sheetNums.push(...(typeof c === "number" ? [c] : numbersInOrder(String(c ?? ""))));
  }
  for (const s of input.sources ?? []) allNumbers(s, known);
  for (const doc of input.docs) {
    if (doc.kind !== "docx") continue;
    const eq = eqByDoc.get(doc) ?? runEquations(doc);
    const own = new Set(eq.okNums.map(cents));
    const covered = new Set(eq.badNums.map(cents));
    const pool = [...docNumbers(doc), ...sheetNums];
    const groups = new Map<number, Found[]>();
    const cleared = new Set<number>();
    for (const f of docAmounts(doc)) {
      if (!isComputed(f.amount)) continue;
      out.checked++;
      const k = cents(f.amount);
      if (known.has(k) || own.has(k) || covered.has(k) || cleared.has(k)) continue;
      // 同一行已有不成立的算式：那一行已经报了，不再逐格另报
      if (eq.badRows.has(f.where)) continue;
      if (derivable(f, pool)) {
        cleared.add(k);
        groups.delete(k);
        continue;
      }
      const g = groups.get(k) ?? [];
      g.push(f);
      groups.set(k, g);
    }
    let n = 0;
    for (const [, g] of groups) {
      if (n++ >= MAX_ORPHANS_PER_DOC) break;
      const f = g[0]!;
      out.issues.push({ kind: "orphan_amount", filename: doc.filename, where: g.length > 1 ? `${f.where}（全文共 ${g.length} 处）` : f.where, text: f.text, amount: round2(f.amount), fix: ORPHAN_FIX });
    }
  }
  return out;
}

/** 跨成果金额对账：只在这一单有计算表（xlsx）时检查文书里算出来的金额有没有出处。 */
export function orphanAmountIssues(input: AmountCheckInput): OrphanAmountIssue[] {
  return runOrphans(input, new Map()).issues;
}

// ───────────────────────── C. 组合 ─────────────────────────

export function checkAmounts(input: AmountCheckInput): AmountCheckResult {
  const eqByDoc = new Map<AmountDoc, EqOutcome>();
  const issues: AmountIssue[] = [];
  let checked = 0;
  for (const d of input.docs) {
    const eq = runEquations(d);
    eqByDoc.set(d, eq);
    checked += eq.checked;
    issues.push(...eq.issues.map((i) => ({ ...i, filename: d.filename })));
  }
  const failed = issues.length;
  const orphans = runOrphans(input, eqByDoc);
  issues.push(...orphans.issues);
  return { issues, stats: { equations_checked: checked, equations_failed: failed, amounts_checked: orphans.checked, orphans: orphans.issues.length } };
}

// ───────────────────────── 接线帮手：从现有结构转成段落与表格行 ─────────────────────────

/** 由 docx.render_report / sectionsOfDocx 的节转成段落与表格行（where 用节标题）。 */
export function blocksOfSections(sections: readonly { heading?: string; paragraphs?: string[]; table?: { columns?: unknown[]; rows?: unknown[][] } | null }[]): AmountBlocks {
  const paragraphs: AmountPara[] = [];
  const rows: AmountRow[] = [];
  sections.forEach((sec, si) => {
    const name = sec.heading?.trim() || `第 ${si + 1} 节`;
    (sec.paragraphs ?? []).forEach((t, pi) => paragraphs.push({ where: `${name} 第 ${pi + 1} 段`, text: t }));
    const t = sec.table;
    if (t && Array.isArray(t.rows)) {
      const columns = (t.columns ?? []).map((c) => (c === null || c === undefined ? null : typeof c === "number" ? c : String(c)));
      t.rows.forEach((r, ri) => {
        if (!Array.isArray(r)) return;
        rows.push({ where: `${name} 表格第 ${ri + 1} 行`, columns, cells: r.map((c) => (c === null || c === undefined ? null : typeof c === "number" ? c : String(c))) });
      });
    }
  });
  return { paragraphs, rows };
}

/** 由 readCreatedXlsx 的工作表转成表格行（首行作表头）。 */
const colLetters = (i: number): string => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
const serialToIso = (n: number): string => new Date(Date.parse("1899-12-30T00:00:00Z") + Math.round(n) * 86_400_000).toISOString().slice(0, 10);

export function blocksOfSheets(sheets: readonly { name: string; rows: unknown[][]; dates?: readonly string[] }[]): AmountBlocks {
  const rows: AmountRow[] = [];
  for (const sh of sheets) {
    const columns = (sh.rows[0] ?? []).map((c) => (c === null || c === undefined ? null : typeof c === "number" ? c : String(c)));
    // 日期格（calc.ledger 的计算表，第 58 批）存的是日期序号：还原成“2026-11-30”，不当作金额出处
    const dates = new Set(sh.dates ?? []);
    sh.rows.forEach((r, ri) => {
      if (ri === 0) return;
      rows.push({ where: `${sh.name} 第 ${ri + 1} 行`, columns, cells: (r ?? []).map((c, ci) => (c === null || c === undefined ? null : typeof c === "number" ? (dates.has(`${colLetters(ci)}${ri + 1}`) ? serialToIso(c) : c) : String(c))) });
    });
  }
  return { rows };
}
