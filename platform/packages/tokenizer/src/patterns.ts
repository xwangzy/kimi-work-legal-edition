import { shapeFold } from "./variants.ts";
/**
 * 证件、账户与联系方式类标识符的确定性识别（第 02 篇 §8.3：身份证/护照号、手机号、银行卡与账号、统一社会信用代码、详细住址、车牌等）。
 *
 * 只做“发现”，不做替换；每个命中给出类别、区间与原文。识别按优先级进行，已被高优先级占用的区间不再参与低优先级识别。
 * 校验位不通过的身份证号与卡号仍然命中（宁可多替换：交付件由文书引擎还原，代号不丢信息）。
 */

export type IdentifierCategory = "id_number" | "phone" | "account" | "uscc" | "address" | "plate" | "email" | "case_no" | "birth_date";

/** 识别选项（审计 P1-3）。 */
export interface IdentifierOptions {
  /**
   * 案号（“（2026）京0105民初1234号”）也识别为标识符。缺省 false：L3a 或全部化名时开启
   * （审计 P1-3：案号可在裁判文书网反查当事人；L2 默认保留以免损害法律研究）。
   */
  caseNumbers?: boolean;
}

export interface Hit {
  category: IdentifierCategory | "person" | "org";
  start: number;
  end: number;
  value: string;
  source: "pattern" | "dictionary" | "recognizer";
}

const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2] as const;
const ID_CHECK = ["1", "0", "X", "9", "8", "7", "6", "5", "4", "3", "2"] as const;

export function idCardValid(s: string): boolean {
  if (!/^\d{17}[\dXx]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(s[i]) * ID_WEIGHTS[i]!;
  return ID_CHECK[sum % 11] === s[17]!.toUpperCase();
}

export function luhnValid(s: string): boolean {
  if (!/^\d{12,19}$/.test(s)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = Number(s[i]);
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

interface Rule {
  category: IdentifierCategory;
  re: RegExp;
  /** 取命中组（缺省整个匹配）。 */
  group?: number;
  accept?: (value: string, text: string, start: number) => boolean;
}

/** 数字串两侧不得紧邻数字或字母（避免截取更长编号的一部分）。 */
const NB = "(?<![0-9A-Za-z])";
const NA = "(?![0-9A-Za-z])";

/** 个人编号的提示词（“工号”前不得是“施/加/开/竣……”，排除“施工号段”之类）。 */
const PERSONAL_ID_HINT = [
  "社会保障(?:卡)?(?:号码|卡号|号)", "社保(?:卡)?(?:号码|卡号|账号|号)", "医保(?:卡)?(?:号码|卡号|账号|号)", "医疗保险(?:卡)?(?:号码|卡号|号)",
  "病历(?:号码|号)", "病案(?:号码|号)", "住院(?:号码|号)", "门诊(?:号码|号)", "就诊卡号", "员工(?:编号|号)", "职工(?:编号|号)",
  "(?<![施加开竣停复分手人动化完赶])工号", "学籍号", "学号", "档案(?:编号|号码|号)",
].join("|");

/** 日期写法：1985年3月2日 / 1985年3月 / 1985-03-02 / 1985.3.2 / 1985/3/2 / 1985-03（年月）。 */
const Y4 = "(?:19|20)\\d{2}";
const MM = "(?:1[0-2]|0?[1-9])";
const DD = "(?:3[01]|[12]\\d|0?[1-9])";
const DATE_SRC = `${Y4}\\s*年\\s*${MM}\\s*月(?:\\s*${DD}\\s*[日号])?|${Y4}-${MM}-${DD}(?!\\d)|${Y4}\\.${MM}\\.${DD}(?!\\d)|${Y4}/${MM}/${DD}(?!\\d)|${Y4}[-./]${MM}(?![-./]?\\d)`;
/** “生于”：排除“发生于/产生于/先生于/学生于/医生于”等（“王先生于2020年3月2日签订”不是出生日期）。 */
const BORN_AT = "(?<![发产诞滋派衍寄共新重再先学医考师门书后众卫民人终一平余此今天野写接偷苟群丛营谋摄])生于";

/**
 * 案号（审计 P1-3，按选项开启）：（2026）京0105民初1234号、(2025)最高法民终12号、（2024）沪74民初5号之一、〔2023〕粤03执456号、
 * （2015）朝民初字第12345号；仲裁文号“京劳人仲字〔2023〕第123号”。年份括号内外的中间段必须含案件类型字（民/刑/行/执/赔/破/知/商/海/仲……），
 * 因而“国发〔2020〕5号”“法释〔2020〕17号”这类文件文号不算案号。
 */
const CASE_OPEN = "[(\\[〔【﹝［]";
const CASE_CLOSE = "[)\\]〕】﹞］]";
const CASE_RE = new RegExp(
  `${CASE_OPEN}\\s*(?:19|20)\\d{2}\\s*${CASE_CLOSE}\\s*([\\u4e00-\\u9fa5\\d]{1,16}?)(?:字第|第)?\\s*\\d{1,7}\\s*号(?:之[一二三四五六七八九十\\d]{1,3})?` +
    `|[\\u4e00-\\u9fa5]{0,8}仲[\\u4e00-\\u9fa5]{0,3}字?${CASE_OPEN}\\s*(?:19|20)\\d{2}\\s*${CASE_CLOSE}\\s*第?\\s*\\d{1,7}\\s*号`,
  "g",
);
const CASE_TYPE = /[民刑行执赔破知商海仲认督催监清强特协请保救惩移调]/;

const RULES: readonly Rule[] = [
  // 邮箱最先（其中的数字不得再被当作手机号或账号）
  { category: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  // 居民身份证号（18 位；15 位旧号按上下文）
  { category: "id_number", re: new RegExp(`${NB}\\d{6}(?:19|20)\\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01])\\d{3}[\\dXx]${NA}`, "g") },
  { category: "id_number", re: /(?:身份证(?:号码?|号)?|公民身份号码|证件号码?)[：:\s]*(\d{15})(?![0-9A-Za-z])/g, group: 1 },
  // 护照、港澳台通行证、军官证等：按上下文（避免误伤合同编号）
  {
    category: "id_number",
    re: /(?:护照(?:号码?)?|通行证(?:号码?)?|台胞证(?:号码?)?|回乡证(?:号码?)?|军官证(?:号码?)?|证件号码?)[：:\s]*([A-Za-z]{1,2}\d{7,9})(?![0-9A-Za-z])/g,
    group: 1,
  },
  // 带提示词的个人编号（审计 P1-3）：社保/医保号、病历号、住院号、门诊号、工号、学号、档案号 → 证件号。
  // 必须紧跟提示词（只隔冒号、空白或“为/是”），且含数字——不认“合同编号”“案卷编号”之类的业务编号
  {
    category: "id_number",
    re: new RegExp(`(?:${PERSONAL_ID_HINT})(?:[：:\\s]|为|是)*([A-Za-z0-9][A-Za-z0-9-]{1,28}[A-Za-z0-9])(?![0-9A-Za-z])`, "g"),
    group: 1,
    accept: (v) => /\d/.test(v),
  },
  // 微信号（字母开头 6–20 位字母、数字、下划线、短横；必须有“微信号/微信账号/微信ID”或“微信：”提示）与 QQ 号（5–11 位数字）→ 账号
  { category: "account", re: /(?:微信(?:号码?|账号|ID|id)[：:\s]*|微信[：:]\s*|(?<![A-Za-z])(?:WeChat|Wechat|wechat)\s?(?:ID|id)[：:\s]*)([A-Za-z][A-Za-z0-9_-]{5,19})(?![0-9A-Za-z_-])/g, group: 1 },
  { category: "account", re: /(?<![A-Za-z])[Qq]{2}(?:(?:号码?|账号)[：:\s]*|[：:\s]+)([1-9]\d{4,10})(?![0-9A-Za-z])/g, group: 1 },
  // 出生日期（审计 P1-3）：只在有上下文时识别——“出生日期：/出生年月/出生于/生于/生日：”之后，或“……出生/……生，”之前（判决书当事人段）
  { category: "birth_date", re: new RegExp(`(?:出生日期|出生年月日|出生年月|出生时间|出生于|${BORN_AT}|生日[：:])(?:[：:\\s]|为|是)*(${DATE_SRC})`, "g"), group: 1 },
  { category: "birth_date", re: new RegExp(`(?<!\\d)(${DATE_SRC})\\s*(?:出生(?!率|人口|证明|医学)|生(?=[，,。；;、\\s）)]|$))`, "g"), group: 1 },
  // 统一社会信用代码（18 位，第 1 位登记管理部门、第 2 位机构类别、3–8 位行政区划）
  { category: "uscc", re: new RegExp(`${NB}[0-9A-HJ-NPQRTUWXY]{2}\\d{6}[0-9A-HJ-NPQRTUWXY]{10}${NA}`, "g") },
  // 手机号（含 +86 / 0086 前缀与分隔）
  { category: "phone", re: /(?<![0-9A-Za-z])(?:(?:\+|00)86[-\s]?)?1[3-9]\d(?:[-\s]?\d{4}){2}(?![0-9A-Za-z])/g },
  // 固定电话（区号-号码，可带分机）
  { category: "phone", re: /(?<![0-9A-Za-z])0\d{2,3}-\d{7,8}(?:-\d{1,6})?(?![0-9A-Za-z])/g },
  { category: "phone", re: /(?:电话|联系电话|座机|传真|Tel|TEL|tel)[：:\s]*((?:\(?0\d{2,3}\)?[-\s]?)?\d{7,8})(?![0-9A-Za-z])/g, group: 1 },
  // 银行卡号（16–19 位，Luhn；允许 4 位一组的空格或短横）
  {
    category: "account",
    re: /(?<![0-9A-Za-z])\d{4}(?:[\s-]?\d{4}){2,3}(?:[\s-]?\d{1,3})?(?![0-9A-Za-z])/g,
    accept: (v) => {
      const d = v.replace(/[\s-]/g, "");
      return d.length >= 16 && d.length <= 19 && luhnValid(d);
    },
  },
  // 账号（上下文：账号/账户/卡号/开户行账号 之后 8–30 位数字，可含空格或短横）
  {
    category: "account",
    re: /(?:银行账号|账号|帐号|账户|帐户|卡号|收款账号|付款账号|对公账户)[：:\s]*(\d[\d\s-]{6,34}\d)(?![0-9A-Za-z])/g,
    group: 1,
  },
  // 车牌（含新能源 8 位）
  { category: "plate", re: /[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼][A-HJ-NP-Z]·?[A-HJ-NP-Z0-9]{4,5}[A-HJ-NP-Z0-9挂学警港澳](?![0-9A-Za-z])/g },
];

/** 详细住址：行政区划 + 道路/小区 + 门牌（以“号/室/栋/幢/单元/楼”收尾，可续接“院、3号楼、1201室”等）。只认带门牌的详细地址，不替换“北京市朝阳区”这类区域名。 */
const ADDR_HEAD = "(?:[\\u4e00-\\u9fa5]{2,8}(?:省|自治区|特别行政区))?(?:[\\u4e00-\\u9fa5]{2,8}(?:市|自治州|盟|地区))?(?:[\\u4e00-\\u9fa5]{1,8}(?:区|县|旗|市))?(?:[\\u4e00-\\u9fa5]{1,10}(?:镇|乡|街道))?";
const ADDR_ROAD = "[\\u4e00-\\u9fa5A-Za-z0-9]{1,16}(?:路|街|大道|巷|弄|胡同|道|里|村|组|小区|花园|公寓|大厦|广场|家园|苑)";
const ADDR_NUM = "[\\u4e00-\\u9fa5A-Za-z0-9]{0,12}?\\d{1,5}(?:号院|号楼|号|弄|栋|幢|座|单元|楼|层|室|户)(?:之\\d{1,3})?";
const ADDR_TAIL = "(?:院|[A-Za-z]座|[-—]?\\d{1,5}(?:号院|号楼|号|弄|栋|幢|座|单元|楼|层|室|户)|[-—]\\d{1,5})*";
const ADDRESS_RE = new RegExp(`${ADDR_HEAD}${ADDR_ROAD}${ADDR_NUM}${ADDR_TAIL}`, "g");
/** 地址前常见的引导词（“住北京市……”“住所地：……”）：不属于地址本身。 */
const ADDRESS_LEAD = /^(?:住所地|住所|住址|地址|现住址?|户籍地址?|户籍地|经常居住地|居住地?|家住|住|位于|在|于|至|到|往)[：:]?/;

/** 无门牌地址只在这些位置起算（句首、标点或“住/住址/户籍地/位于……”之后），不吞前面的姓名与动词。 */
const ADDR_START = "(?<=^|[\\s，。；;：:、,（(“\"‘〕]|住|住址|住所|住所地|地址|户籍地|户籍|位于|居住地|现住|现住址|经常居住地|家住|系|在|于|至|到|往)";
/**
 * 到村、组为止、无门牌的农村地址（审计 §2.1）：“某某镇某某村”“某某县某某乡某某村三组”。须有县/区/旗或乡/镇/街道/苏木一级，
 * 村名至少 2 字；“村委会/村民/村庄/村里”不算；“北京市朝阳区”这类区域名没有村一级，不受影响。
 */
const VILLAGE_RE = new RegExp(
  `${ADDR_START}((?:[\\u4e00-\\u9fa5]{2,8}(?:省|自治区))?(?:[\\u4e00-\\u9fa5]{2,8}(?:市|自治州|盟|地区))?(?:[\\u4e00-\\u9fa5]{1,8}(?:区|县|旗|市))?(?:[\\u4e00-\\u9fa5]{1,10}(?:镇|乡|街道|苏木))?)` +
    `([\\u4e00-\\u9fa5]{2,8}?(?:村|嘎查|屯))((?:[一二三四五六七八九十百零〇\\d]{1,4}(?:组|社|队))?)(?![委民集干支级务办庄子里落])`,
  "g",
);
/** 起点被“^/标点”放宽后，地址段前部可能带上“被告系……”“原告王某住……”：从最后一个强引导词之后起算。 */
const STRONG_LEAD = /住所地|住址|住所|地址|户籍地|户籍|位于|居住地|现住|家住|住|系/g;
function afterStrongLead(s: string): number {
  let at = 0;
  STRONG_LEAD.lastIndex = 0;
  for (const m of s.matchAll(STRONG_LEAD)) at = m.index! + m[0].length;
  return at;
}
const VILLAGE_BAD = /^(?:城中|新农|美丽乡|[各该本此其邻我他全每周附那这])/;
/**
 * 无道路词、有小区名 + 楼栋的写法（审计 §2.1）：“某某小区5栋”“某某花园3幢2单元”“某某家园二期3号楼1201室”。
 * 小区名至少 2 字且不以“该/本/此/涉案/上述……”开头（“本小区5栋”不是住址）。
 */
const COMPLEX_RE = new RegExp(
  `${ADDR_START}([\\u4e00-\\u9fa5A-Za-z0-9]{2,14}?(?:小区|花园|公寓|大厦|家园|苑|新村|山庄|华庭|府邸|社区|广场))` +
    `((?:[一二三四五六七八九十\\d]{1,3}期)?(?:\\d{1,4}|[一二三四五六七八九十]{1,3}|[A-Za-z])(?:号楼|栋|幢|座)` +
    `(?:[-—]?(?:\\d{1,5}|[一二三四五六七八九十]{1,3})(?:单元|号|室|层|楼|户)|[-—]\\d{1,5})*)`,
  "g",
);
const COMPLEX_BAD = /^(?:该|本|此|其|涉案|案涉|上述|前述|所在|同一|附近|周边|整个|全|各|每|那|这|某)/;

const ADDRESS_ADMIN = /(?:省|自治区|特别行政区|市|自治州|盟|地区|区|县|旗|镇|乡|街道)/;

/**
 * 全角 ASCII（U+FF01–U+FF5E）折成半角、全角空格折成空格：**逐个 UTF-16 码元一一对应、长度不变**，识别在折叠视图上进行，
 * 区间直接用于原文（文书与 OCR 输出里常见全角数字，`\d` 不认它们）。
 */
export function foldWidth(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xff01 && c <= 0xff5e) out += String.fromCharCode(c - 0xfee0);
    else if (c === 0x3000) out += " ";
    else out += text[i];
  }
  return out;
}

function overlaps(taken: readonly { start: number; end: number }[], s: number, e: number): boolean {
  return taken.some((t) => s < t.end && e > t.start);
}

/** 找出全部标识符命中（按优先级，互不重叠）。`skip` 为不得识别的区间（例如已有的代号）。 */
export function findIdentifiers(original: string, skip: readonly { start: number; end: number }[] = [], options: IdentifierOptions = {}): Hit[] {
  const text = foldWidth(original);
  const hits: Hit[] = [];
  const taken: { start: number; end: number }[] = [...skip];
  const push = (category: IdentifierCategory, start: number, value: string) => {
    const end = start + value.length;
    if (value.length === 0 || overlaps(taken, start, end)) return;
    // 值取原文（还原时原样恢复全角写法）
    hits.push({ category, start, end, value: original.slice(start, end), source: "pattern" });
    taken.push({ start, end });
  };
  // 案号（按选项）：先于其他规则——案号中的数字段不再被当作别的编号
  if (options.caseNumbers) {
    CASE_RE.lastIndex = 0;
    for (const m of text.matchAll(CASE_RE)) {
      if (m[1] !== undefined) {
        if (!CASE_TYPE.test(m[1])) continue;
        push("case_no", m.index!, m[0]);
        continue;
      }
      // 仲裁文号：前缀只取“仲”之前的地区与机构简称（最多 6 字，且在“为/是/号/见/即/及/和/与/的/在”之后起算）
      const k = m[0].indexOf("仲");
      let cut = 0;
      for (let i = 0; i < k; i++) if ("为是号见即及和与的在".includes(m[0][i]!)) cut = i + 1;
      cut = Math.max(cut, k - 6);
      push("case_no", m.index! + cut, m[0].slice(cut));
    }
  }
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      const full = m[0];
      const value = rule.group !== undefined ? (m[rule.group] ?? "") : full;
      const start = m.index! + (rule.group !== undefined ? full.lastIndexOf(value) : 0);
      if (rule.accept && !rule.accept(value, text, start)) continue;
      push(rule.category, start, value);
    }
  }
  ADDRESS_RE.lastIndex = 0;
  for (const m of text.matchAll(ADDRESS_RE)) {
    const lead = ADDRESS_LEAD.exec(m[0])?.[0] ?? "";
    const v = m[0].slice(lead.length);
    // 必须含行政区划或道路 + 门牌；过短的“3号楼”之类不算详细住址
    if (v.length < 6 || !ADDRESS_ADMIN.test(v)) continue;
    push("address", m.index! + lead.length, v);
  }
  // 无门牌的村、组地址
  VILLAGE_RE.lastIndex = 0;
  for (const m of text.matchAll(VILLAGE_RE)) {
    const lead = Math.max((ADDRESS_LEAD.exec(m[0])?.[0] ?? "").length, afterStrongLead(m[1] ?? ""));
    const head = (m[1] ?? "").slice(lead);
    const village = m[2] ?? "";
    if (!/(?:区|县|旗|镇|乡|街道|苏木)$/.test(head) || !/^[\u4e00-\u9fa5]{2}/.test(head)) continue;
    const name = village.replace(/(?:村|嘎查|屯)$/, "");
    if (name.length < 2 || VILLAGE_BAD.test(name)) continue;
    push("address", m.index! + lead, m[0].slice(lead));
  }
  // 小区名 + 楼栋（无道路词）
  COMPLEX_RE.lastIndex = 0;
  for (const m of text.matchAll(COMPLEX_RE)) {
    const lead = { length: Math.max((ADDRESS_LEAD.exec(m[0])?.[0] ?? "").length, afterStrongLead(m[1] ?? "")) };
    const v = m[0].slice(lead.length);
    const name = (m[1] ?? "").slice(lead.length).replace(/(?:小区|花园|公寓|大厦|家园|苑|新村|山庄|华庭|府邸|社区|广场)$/, "");
    if (name.length < 2 || COMPLEX_BAD.test(name) || !/[\u4e00-\u9fa5]/.test(name)) continue;
    push("address", m.index! + lead.length, v);
  }
  return hits.sort((a, b) => a.start - b.start);
}

/** 规范化：同一标识符的不同书写（空格、短横、+86、全角）得到同一个代号。 */
export function normalizeValue(category: Hit["category"], value: string): string {
  const v = value.normalize("NFKC");
  switch (category) {
    case "id_number":
    case "uscc":
    case "plate":
      return v.replace(/[\s·-]/g, "").toUpperCase();
    case "phone": {
      let d = v.replace(/[^\d+]/g, "");
      d = d.replace(/^(?:\+86|0086)/, "");
      return d;
    }
    case "account":
      return v.replace(/\D/g, "");
    case "email":
      return v.trim().toLowerCase();
    case "person":
    case "org":
      // 保形规范化（终核 S4-25）：插入空白、零宽、全角与大小写写法得到同一代号；繁体与简体写法各自有代号（还原逐字等于原文字形，不会还原成另一个字）
      return shapeFold(v.replace(/[（]/g, "(").replace(/[）]/g, ")"));
    case "address":
      return v.replace(/\s+/g, "");
    case "case_no":
      // 括号写法（全角/半角/六角/方头）与空白折叠：（2026）京0105民初1234号 = (2026)京0105民初1234号 = 〔2026〕京0105民初1234号
      return v.replace(/[〔【﹝［\[（(]/g, "(").replace(/[〕】﹞］\]）)]/g, ")").replace(/\s+/g, "");
    case "birth_date": {
      // 统一为 YYYY-MM-DD（只有年月时 YYYY-MM）
      const d = /((?:19|20)\d{2})\D+(\d{1,2})(?:\D+(\d{1,2}))?/.exec(v);
      if (!d) return v.replace(/\s+/g, "");
      const mm = d[2]!.padStart(2, "0");
      return d[3] ? `${d[1]}-${mm}-${d[3].padStart(2, "0")}` : `${d[1]}-${mm}`;
    }
    default:
      return v;
  }
}
