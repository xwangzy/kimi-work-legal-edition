/**
 * Word 自动编号的显示文字（第 29 批）：“第一条”“1.1”“（一）”这类由 numbering.xml 生成的编号不在段落文字里，
 * 只取可见文字时整份合同没有条款号——Agent 审查时只能猜条款号，修改时也说不清改的是哪一条（真实走查：自动编号的合同）。
 *
 * 这里按 numbering.xml（与 styles.xml 里样式自带的编号）把每个段落的编号算出来，段落顺序与 mapParagraphs 一致：
 * - 段落 numPr 优先，没有则取段落样式（含 basedOn 链）的 numPr；numId 为 0 表示不编号；
 * - 计数按抽象编号（abstractNum）累计（同一抽象编号的不同 num 接着编，带 startOverride 的 num 第一次出现时从覆盖值起）；
 *   某一级加一时更深的级别归零；上级从未出现时按该级起始值显示；
 * - lvlText 里的 %n 按第 n 级的编号格式写出；本级带 isLgl 时一律写阿拉伯数字；
 * - 不认识的格式按阿拉伯数字写，项目符号写“•”。
 * 只用于让文字视图带上编号（解析文本、定位提示），不改文件。
 */
import { escapeXml, unescapeXml } from "./textmap.ts";
import { readZipText } from "./zip.ts";

interface Level {
  start: number;
  fmt: string;
  text: string;
  isLgl: boolean;
  pStyle: string | null;
}

interface NumDef {
  abstractId: string;
  overrides: Map<number, { start?: number; level?: Level }>;
}

const P_RE = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
const attr = (xml: string, name: string): string | null => new RegExp(`<w:${name}\\b[^>]*\\bw:val="([^"]*)"`).exec(xml)?.[1] ?? null;

function parseLevel(xml: string): Level {
  return {
    start: Number(attr(xml, "start") ?? 1) || 0,
    fmt: attr(xml, "numFmt") ?? "decimal",
    text: unescapeXml(attr(xml, "lvlText") ?? ""),
    isLgl: /<w:isLgl\b(?![^>]*w:val="(?:0|false)")/.test(xml),
    pStyle: attr(xml, "pStyle"),
  };
}

function parseNumbering(xml: string): { abstracts: Map<string, Map<number, Level>>; nums: Map<string, NumDef> } {
  const abstracts = new Map<string, Map<number, Level>>();
  for (const m of xml.matchAll(/<w:abstractNum\b[^>]*w:abstractNumId="([^"]+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g)) {
    const levels = new Map<number, Level>();
    for (const l of m[2]!.matchAll(/<w:lvl\b[^>]*w:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvl>/g)) levels.set(Number(l[1]), parseLevel(l[2]!));
    abstracts.set(m[1]!, levels);
  }
  const nums = new Map<string, NumDef>();
  for (const m of xml.matchAll(/<w:num\b[^>]*w:numId="([^"]+)"[^>]*>([\s\S]*?)<\/w:num>/g)) {
    const abstractId = attr(m[2]!, "abstractNumId");
    if (abstractId === null) continue;
    const overrides = new Map<number, { start?: number; level?: Level }>();
    for (const o of m[2]!.matchAll(/<w:lvlOverride\b[^>]*w:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvlOverride>/g)) {
      const so = attr(o[2]!, "startOverride");
      const lvl = /<w:lvl\b[\s\S]*?<\/w:lvl>/.exec(o[2]!)?.[0];
      overrides.set(Number(o[1]), { ...(so !== null ? { start: Number(so) || 0 } : {}), ...(lvl ? { level: parseLevel(lvl) } : {}) });
    }
    nums.set(m[1]!, { abstractId, overrides });
  }
  return { abstracts, nums };
}

/** 样式的编号（含 basedOn 链）：styleId → { numId, ilvl }。 */
function parseStyleNumbering(xml: string | null): Map<string, { numId: string | null; ilvl: number | null; basedOn: string | null }> {
  const out = new Map<string, { numId: string | null; ilvl: number | null; basedOn: string | null }>();
  if (!xml) return out;
  for (const m of xml.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    const numPr = /<w:numPr>([\s\S]*?)<\/w:numPr>/.exec(m[2]!)?.[1] ?? null;
    out.set(m[1]!, {
      numId: numPr ? attr(numPr, "numId") : null,
      ilvl: numPr && attr(numPr, "ilvl") !== null ? Number(attr(numPr, "ilvl")) : null,
      basedOn: attr(m[2]!, "basedOn"),
    });
  }
  return out;
}

const CN_DIGITS = "零一二三四五六七八九";
const CN_LEGAL = "零壹贰叁肆伍陆柒捌玖";

/** 中文计数（1–9999）：10–19 写“十X”，中间缺位写“零”。 */
function chineseCount(n: number, digits = CN_DIGITS, units = ["", "十", "百", "千"]): string {
  if (n <= 0 || n > 9999) return String(n);
  const s = String(n);
  let out = "";
  let zero = false;
  for (let i = 0; i < s.length; i++) {
    const d = Number(s[i]);
    const unit = units[s.length - 1 - i]!;
    if (d === 0) {
      zero = out.length > 0;
      continue;
    }
    if (zero) out += digits[0];
    zero = false;
    out += digits[d] + unit;
  }
  return digits === CN_DIGITS && n >= 10 && n < 20 ? out.replace(/^一十/, "十") : out;
}

const letters = (n: number, upper: boolean): string => {
  const ch = String.fromCharCode((upper ? 65 : 97) + ((n - 1) % 26));
  return n <= 0 ? String(n) : ch.repeat(Math.floor((n - 1) / 26) + 1);
};

function roman(n: number): string {
  if (n <= 0 || n >= 4000) return String(n);
  const table: [number, string][] = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
  let out = "";
  for (const [v, s] of table) while (n >= v) (out += s), (n -= v);
  return out;
}

/** 按 Word 编号格式写出一个计数。 */
export function formatListNumber(n: number, fmt: string): string {
  switch (fmt) {
    case "decimal":
      return String(n);
    case "decimalZero":
      return n < 10 ? `0${n}` : String(n);
    case "upperRoman":
      return roman(n);
    case "lowerRoman":
      return roman(n).toLowerCase();
    case "upperLetter":
      return letters(n, true);
    case "lowerLetter":
      return letters(n, false);
    case "chineseCounting":
    case "chineseCountingThousand":
    case "japaneseCounting":
    case "taiwaneseCounting":
    case "taiwaneseCountingThousand":
    case "ideographDigital":
      return chineseCount(n);
    case "chineseLegalSimplified":
      return chineseCount(n, CN_LEGAL, ["", "拾", "佰", "仟"]);
    case "ideographTraditional":
      return n >= 1 && n <= 10 ? "甲乙丙丁戊己庚辛壬癸"[n - 1]! : String(n);
    case "ideographZodiac":
      return n >= 1 && n <= 12 ? "子丑寅卯辰巳午未申酉戌亥"[n - 1]! : String(n);
    case "decimalEnclosedCircle":
    case "decimalEnclosedCircleChinese":
      return n >= 1 && n <= 20 ? String.fromCharCode(0x2460 + n - 1) : String(n);
    case "decimalFullWidth":
    case "decimalFullWidth2":
      return String(n).replace(/\d/g, (d) => String.fromCharCode(0xff10 + Number(d)));
    case "bullet":
      return "•";
    case "none":
      return "";
    default:
      return String(n);
  }
}

/**
 * 每个段落（与 mapParagraphs 同一顺序）的自动编号文字；不编号的段落为 null。
 * numberingXml 为空（文件没有自动编号）时全部为 null。
 */
export function paragraphListLabels(documentXml: string, numberingXml: string | null, stylesXml: string | null): (string | null)[] {
  const paras = [...documentXml.matchAll(P_RE)].map((m) => m[0]);
  if (!numberingXml) return paras.map(() => null);
  const { abstracts, nums } = parseNumbering(numberingXml);
  const styles = parseStyleNumbering(stylesXml);
  const styleNum = (styleId: string | null): { numId: string | null; ilvl: number | null } => {
    for (let id = styleId, guard = 0; id && guard < 20; guard++) {
      const s = styles.get(id);
      if (!s) break;
      if (s.numId !== null) return { numId: s.numId, ilvl: s.ilvl };
      id = s.basedOn;
    }
    return { numId: null, ilvl: null };
  };
  const counters = new Map<string, number[]>();
  const startedNums = new Set<string>();
  return paras.map((p) => {
    const pPr = /<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(p)?.[1] ?? "";
    const numPr = /<w:numPr>([\s\S]*?)<\/w:numPr>/.exec(pPr)?.[1] ?? null;
    const pStyle = attr(pPr.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, ""), "pStyle");
    const fromStyle = styleNum(pStyle);
    const numId = (numPr ? attr(numPr, "numId") : null) ?? fromStyle.numId;
    if (!numId || numId === "0") return null;
    const def = nums.get(numId);
    const levels = def ? abstracts.get(def.abstractId) : undefined;
    if (!def || !levels) return null;
    // 级别：段落 ilvl → 样式 ilvl → 抽象编号里链接本样式的那一级 → 0
    const linked = pStyle ? [...levels.entries()].find(([, l]) => l.pStyle === pStyle)?.[0] : undefined;
    const ilvlAttr = numPr ? attr(numPr, "ilvl") : null;
    const ilvl = Math.min(8, Math.max(0, ilvlAttr !== null ? Number(ilvlAttr) : (fromStyle.ilvl ?? linked ?? 0)));
    const levelOf = (k: number): Level | undefined => def.overrides.get(k)?.level ?? levels.get(k);
    const startOf = (k: number): number => def.overrides.get(k)?.start ?? levelOf(k)?.start ?? 1;
    const lvl = levelOf(ilvl);
    if (!lvl) return null;
    let c = counters.get(def.abstractId);
    if (!c || (!startedNums.has(numId) && [...def.overrides.values()].some((o) => o.start !== undefined))) {
      c = Array.from({ length: 9 }, () => 0);
      counters.set(def.abstractId, c);
    }
    startedNums.add(numId);
    c[ilvl] = c[ilvl]! === 0 ? startOf(ilvl) : c[ilvl]! + 1;
    for (let k = ilvl + 1; k < 9; k++) c[k] = 0;
    if (lvl.fmt === "bullet") return "•";
    const label = lvl.text.replace(/%([1-9])/g, (_m, d: string) => {
      const k = Number(d) - 1;
      const n = c![k]! === 0 ? startOf(k) : c![k]!;
      return formatListNumber(n, lvl.isLgl && k < ilvl ? "decimal" : (levelOf(k)?.fmt ?? "decimal"));
    });
    return label.trim() || null;
  });
}

/** 从 DOCX 字节算每个段落的自动编号文字（读不出 numbering.xml 时全部为 null）。 */
export function docxListLabels(docx: Buffer): (string | null)[] {
  const documentXml = readZipText(docx, "word/document.xml") ?? "";
  return paragraphListLabels(documentXml, readZipText(docx, "word/numbering.xml"), readZipText(docx, "word/styles.xml"));
}

/**
 * 把自动编号写进文字视图（只给解析文本用，不改文件）：编号段落的 pPr 之后插入一段“编号 + 空格”的文字。
 * 修订删除掉的段落仍按 Word 的口径计号（与 Word 打开时显示一致）。
 */
export function documentXmlWithListLabels(documentXml: string, labels: readonly (string | null)[]): string {
  let i = 0;
  return documentXml.replace(P_RE, (p) => {
    const label = labels[i++];
    if (!label) return p;
    const run = `<w:r><w:t xml:space="preserve">${escapeXml(label)} </w:t></w:r>`;
    const at = p.indexOf("</w:pPr>");
    if (at >= 0) return p.slice(0, at + 8) + run + p.slice(at + 8);
    const open = /^<w:p\b[^>]*>/.exec(p)![0];
    return open + run + p.slice(open.length);
  });
}

/**
 * 去掉锚点或引文开头抄进来的自动编号（Agent 看到的材料文字带编号，原件段落文字不带）：
 * 只在开头恰好是本文件某个编号、后面跟空白时去掉，返回去掉后的文字；不是则原样返回。
 */
export function stripListLabel(text: string, labels: Iterable<string | null>): string {
  let best = "";
  for (const l of labels) if (l && l.length > best.length && text.startsWith(l) && /^[\s　]/.test(text.slice(l.length))) best = l;
  return best ? text.slice(best.length).replace(/^[\s　]+/, "") : text;
}
