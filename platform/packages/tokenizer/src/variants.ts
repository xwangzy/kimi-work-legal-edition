/**
 * 写法变体（阶段 4 审查 S4-02、复核 S4-18）：当事人词典匹配要容忍同一名称的常见写法变化——
 * 全角/半角（NFKC）、大小写、插入的空白与不可见字符、名字中的间隔号、繁体与简体。
 *
 * 做法：把文本折叠成“比较视图”（去掉插入字符、逐字 NFKC → 繁转简 → 小写），同时保留每个视图字符在原文中的位置；
 * 在比较视图里按词典的折叠写法做长者优先的不重叠匹配，再映射回原文区间。同一行内插入字符的个数不设上限。
 *
 * - 插入字符：空格类（含全角空格、不换行空格）、控制字符、格式字符（零宽、方向控制与隔离符、标签字符等）、组合与变体选择符、
 *   Unicode “默认可忽略”字符（韩文填充符等）与各种间隔号；**换行、段落分隔与制表不是插入字符**——它们是硬边界，
 *   跨行、跨段落、跨表格单元的文字不会被拼成名称（终核 S4-23：“主张\n三、”不得命中“张三”）；
 * - 繁转简：ICU “Hant-Hans” 单字表（t2s-data.ts，约 3,050 对，Unihan 数据，生成脚本见 scripts/）+ 两条人工覆盖；
 *   **本身就是现行规范字的字不折叠**（乾、於、著、藉、俱、姊、跤、瞭……；终核 S4-25：否则“主张干预”会命中“张乾”）；
 * - 两种规范化各司其职：**比较折叠**（foldText，含繁转简）只用于判定“文本里有没有这个当事人”（检索、URL、令牌化的命中）；
 *   **保形规范化**（shapeFold，只做插入字符、宽度与大小写折叠，不做繁转简）用于分配代号——繁体写法的命中得到它自己的代号，
 *   还原逐字等于原文的字形（只可能丢失名称内部的插入字符），不会把一个人的名字还原成另一个写法或另一个人（终核 S4-25）。
 */
import { T2S_PAIRS } from "./t2s-data.ts";

/** 折叠规则版本：规则（插入字符集、繁简表、规范化）变化会改变规范值，进而改变代号；持久化的令牌表按此版本区分（复核 S4-22）。 */
export const FOLD_VERSION = 3;

const T2S = new Map<string, string>();
const S2T = new Map<string, Set<string>>();

function addPair(t: string, s: string): void {
  if (t === s) return;
  T2S.set(t, s);
  let set = S2T.get(s);
  if (!set) {
    set = new Set();
    S2T.set(s, set);
  }
  set.add(t);
}

{
  const cps = Array.from(T2S_PAIRS);
  for (let i = 0; i + 1 < cps.length; i += 2) addPair(cps[i]!, cps[i + 1]!);
  // 人工覆盖：现行规范用字（諮詢 → 咨询；滙 为 匯 的异体）
  addPair("諮", "咨");
  addPair("滙", "汇");
}

/** 名称中可被忽略的插入字符（单个码点）；换行、段落分隔与制表除外（见 HARD_BREAK）。 */
export const SEPARATOR_SRC =
  "[\\p{Zs}\\p{Cc}\\p{Cf}\\p{Mn}\\p{Me}\\p{Default_Ignorable_Code_Point}\\u00B7\\u0387\\u2022\\u2027\\u2219\\u22C5\\u2E31\\u30FB\\uFF65\\u16EB\\u2800]";
const SEPARATOR_ONE = new RegExp(`^${SEPARATOR_SRC}$`, "u");
/** 硬边界：换行、段落与行分隔、制表、信息分隔符——不可跨越（终核 S4-23）。 */
const HARD_BREAK = /^[\t\n\v\f\r\u001c-\u001f\u0085\u2028\u2029]$/u;

function isSeparator(ch: string): boolean {
  return !HARD_BREAK.test(ch) && SEPARATOR_ONE.test(ch);
}

/** 编号开头（“三、”“（三）”“3.”“①”）：其前的换行是列表结构，不是折行。 */
const NUMBERING_RE = /^[ \u3000]*(?:[一二三四五六七八九十百千]+[、．.]|[（(][一二三四五六七八九十百0-9]+[）)]|[0-9]+[.、．)）]|[\u2460-\u2473\u2474-\u2487])/u;
const BREAKISH = /[\n\r\u2028\u2029\u0085\f\v\t\u001c-\u001f]/;

/**
 * 令牌化用（终核 S4-27）：把**单个折行**换成等长空格（位置不变），使被版面折行断开的名称（“张⏎三”、“张\r\n三”）照常命中；
 * 空行、制表、换页、文本首尾的换行，以及其后紧跟编号（“三、”“（三）”“3.”）的换行仍是硬边界（终核 S4-23：不吞列表结构）。
 * 命中的原文片段含换行时按原文片段分配代号（字形不同），还原逐字保留换行。
 */
export function softenSingleBreaks(text: string): string {
  if (!/[\n\r\u2028\u0085]/.test(text)) return text;
  return text.replace(/\r\n|[\n\r\u2028\u0085]/g, (m: string, offset: number) => {
    let i = offset - 1;
    while (i >= 0 && (text[i] === " " || text[i] === "\u3000")) i--;
    let j = offset + m.length;
    while (j < text.length && (text[j] === " " || text[j] === "\u3000")) j++;
    if (i < 0 || j >= text.length) return m;
    if (BREAKISH.test(text[i]!) || BREAKISH.test(text[j]!)) return m;
    if (NUMBERING_RE.test(text.slice(offset + m.length, offset + m.length + 12))) return m;
    return " ".repeat(m.length);
  });
}

/**
 * 筛查用（检索式、URL 的当事人检查）：硬边界逐字换成空格（位置不变）。对抗场景下“张⏎三”“%0A”插在名称中间同样要命中；
 * 令牌化材料时不用它（跨行拼接会吞掉换行与列表序号，终核 S4-23）。
 */
export function softenBreaks(text: string): string {
  return text.replace(/[\t\n\v\f\r\u001c-\u001f\u0085\u2028\u2029]/g, " ");
}

/** 单字规范化：NFKC → 繁体转简体 → 小写。 */
export function foldChar(ch: string): string {
  const n = ch.normalize("NFKC");
  let out = "";
  for (const c of n) out += (T2S.get(c) ?? c).toLowerCase();
  return out;
}

/** 文本规范化（比较用）：去掉插入字符后逐字规范化（含繁转简）。只用于判定命中，不用于分配代号。 */
export function foldText(s: string): string {
  return foldWithMap(s).folded;
}

/**
 * 保形规范化（分配代号用）：去掉插入字符、NFKC（全角/半角）与小写——**不做繁转简**。
 * 同一字形的不同排版（插空格、零宽、全角）得到同一代号；繁体与简体写法各自有代号，还原逐字等于原文字形（终核 S4-25）。
 */
export function shapeFold(s: string): string {
  let out = "";
  for (const ch of s) {
    if (isSeparator(ch)) continue;
    for (const c of ch.normalize("NFKC")) if (!isSeparator(c)) out += c.toLowerCase();
  }
  return out;
}

/** 比较视图：折叠后的文本，以及视图中每个 UTF-16 单元对应的原文区间 [starts[i], ends[i])。 */
export interface FoldedView {
  folded: string;
  starts: number[];
  ends: number[];
}

export function foldWithMap(text: string): FoldedView {
  let folded = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  for (const ch of text) {
    const len = ch.length;
    if (!isSeparator(ch)) {
      for (const c of foldChar(ch)) {
        if (isSeparator(c)) continue;
        folded += c;
        for (let k = 0; k < c.length; k++) {
          starts.push(i);
          ends.push(i + len);
        }
      }
    }
    i += len;
  }
  return { folded, starts, ends };
}

export interface VariantMatch {
  start: number;
  end: number;
  /** 规范写法（词典里的写法）。 */
  value: string;
}

/** 多个规范写法一次扫描（长者优先、不重叠）；命中按折叠后相等判定。 */
export class VariantMatcher {
  /** 折叠写法的首个 UTF-16 单元 → 以它开头的折叠写法（长者在前）。 */
  private readonly byFirst = new Map<string, string[]>();
  private readonly byFold = new Map<string, string>();

  constructor(values: readonly string[]) {
    const uniq = [...new Set(values.map((v) => v.trim()).filter((v) => v.length > 0))];
    // 词典里先出现、更长的写法优先作为规范写法
    uniq.sort((a, b) => b.length - a.length);
    for (const v of uniq) {
      const f = foldText(v);
      if ([...f].length < 2 || this.byFold.has(f)) continue;
      this.byFold.set(f, v);
      const first = f[0]!;
      const list = this.byFirst.get(first) ?? [];
      list.push(f);
      this.byFirst.set(first, list);
    }
    for (const list of this.byFirst.values()) list.sort((a, b) => b.length - a.length);
  }

  find(text: string): VariantMatch[] {
    if (!text || this.byFold.size === 0) return [];
    const { folded, starts, ends } = foldWithMap(text);
    const out: VariantMatch[] = [];
    for (let i = 0; i < folded.length; ) {
      const cands = this.byFirst.get(folded[i]!);
      let hit: string | undefined;
      if (cands) for (const f of cands) if (folded.startsWith(f, i)) { hit = f; break; }
      if (!hit) {
        i += 1;
        continue;
      }
      out.push({ start: starts[i]!, end: ends[i + hit.length - 1]!, value: this.byFold.get(hit)! });
      i += hit.length;
    }
    return out;
  }
}

// ── 常用词：不作派生或学得的别名（复核 S4-20：“明天”“本人”“张某”被学成别名，造成误替换与误拒） ──

const COMMON_WORDS = new Set([
  // 时间
  "今天", "明天", "昨天", "后天", "前天", "今年", "明年", "去年", "今日", "明日", "昨日", "未来", "现在", "当前", "目前", "近期", "将来", "以后", "以前", "当时", "同期",
  // 人称与指代
  "本人", "我方", "对方", "他方", "本方", "其他", "他人", "我们", "你们", "他们", "她们", "自己", "大家", "双方", "各方", "该方", "该公司", "本公司", "贵方", "贵司", "我司", "本司",
  // 泛称
  "中国", "国际", "中华", "华夏", "东方", "西方", "世纪", "环球", "全球", "世界", "天下", "宇宙", "时代", "天地", "大众", "人民", "公共", "国家", "社会", "城市", "地方",
  "发展", "合作", "联合", "先锋", "新星", "阳光", "光明", "希望", "和平", "美好", "幸福", "快乐", "健康", "生活", "安全", "长城", "长江", "黄河", "中心", "总部",
]);

/** 不可作别名的写法：“X某/X某某”、“X氏”、含“某”的泛称、人称与时间等常用词、角色词（令牌化器与词典接口共用）。 */
export function isGenericAlias(alias: string): boolean {
  const a = foldText(alias);
  if ([...a].length < 2) return true;
  if (/某/.test(a) || /^.氏$/.test(a)) return true;
  return COMMON_WORDS.has(a) || ROLE_WORDS.has(a);
}

// ── 机构字号别名（S4-02：Agent 与律师按惯例用简称写检索式与 URL） ──

const ORG_FORMS = /(股份有限公司|有限责任公司|有限公司|股份公司|集团公司|分公司|公司|集团|律师事务所|会计师事务所|事务所|合伙企业|普通合伙|有限合伙|合作社)$/;
const INDUSTRY_WORDS = new RegExp(
  "(" +
    [
      "计算机系统", "计算机", "信息技术", "信息科技", "网络科技", "网络技术", "电子商务", "国际贸易", "融资租赁", "资产管理", "文化传媒", "新能源", "供应链",
      "科技", "技术", "信息", "网络", "系统", "数码", "电子", "软件", "通信", "投资", "控股", "实业", "发展", "贸易", "商贸", "国际", "咨询", "管理", "服务", "传媒",
      "文化", "教育", "医疗", "医药", "生物", "能源", "环保", "建设", "建筑", "工程", "房地产", "置业", "物业", "物流", "金融", "保理", "基金", "商务", "餐饮",
      "食品", "农业", "设计", "制造", "机械", "汽车", "材料", "化工", "保险", "银行", "证券", "信托", "期货", "租赁", "人寿", "财产", "健康", "传播", "广告",
    ].join("|") +
    ")$",
);
const REGIONS = [
  "北京", "上海", "天津", "重庆", "河北", "山西", "辽宁", "吉林", "黑龙江", "江苏", "浙江", "安徽", "福建", "江西", "山东", "河南", "湖北", "湖南",
  "广东", "海南", "四川", "贵州", "云南", "陕西", "甘肃", "青海", "台湾", "内蒙古", "广西", "西藏", "宁夏", "新疆", "香港", "澳门",
  "深圳", "广州", "杭州", "南京", "苏州", "武汉", "成都", "西安", "厦门", "宁波", "青岛", "大连", "无锡", "长沙", "郑州", "济南", "合肥",
  "福州", "昆明", "沈阳", "哈尔滨", "长春", "石家庄", "太原", "南昌", "南宁", "贵阳", "兰州", "海口", "东莞", "佛山", "珠海", "中国",
];
const GENERIC = new Set([
  "中国", "国际", "科技", "技术", "信息", "网络", "投资", "控股", "实业", "发展", "贸易", "咨询", "管理", "服务", "集团", "公司", "有限", "股份",
  "华夏", "中华", "东方", "华东", "华南", "华北", "银行", "证券", "保险", "信托", "基金", "期货", "租赁", "医院", "学校", "大学", "学院", "研究院",
  "酒店", "超市", "商场", "中心", "律师", "事务所", "合作社", "工厂", "商店", "门店", "分行", "支行", "分公司", "人寿", "财产",
]);

/**
 * 机构全称 → 字号别名：去括注（“（集团）”等，任意位置）、组织形式、行业用语与行政区划前缀；
 * 只返回 ≥ 2 字、非通用词与常用词的写法（复核 S4-20：“明天”不派生；“平安”“腾讯”可派生）。
 */
export function deriveOrgAliases(name: string): string[] {
  const out = new Set<string>();
  const full = name.trim();
  let core = full.replace(/[（(][^）)]*[）)]/g, "");
  core = core.replace(ORG_FORMS, "");
  const keep = (v: string) => {
    if (v.length >= 2 && v !== full && !GENERIC.has(v) && !isGenericAlias(v)) out.add(v);
  };
  keep(core);
  let prev = "";
  while (prev !== core) {
    prev = core;
    for (const r of REGIONS) {
      if (core.startsWith(r) && core.length - r.length >= 2) core = core.slice(r.length).replace(/^(省|市|自治区|特别行政区)/, "");
    }
    core = core.replace(INDUSTRY_WORDS, "");
  }
  keep(core);
  return [...out];
}

// ── 合同中的简称定义（“（以下简称“华为”）”） ──

const ROLE_WORDS = new Set([
  "甲方", "乙方", "丙方", "丁方", "戊方", "本公司", "公司", "出借人", "借款人", "原告", "被告", "申请人", "被申请人", "上诉人", "被上诉人", "第三人",
  "买方", "卖方", "出卖人", "买受人", "出租人", "承租人", "委托人", "受托人", "发包人", "承包人", "转让方", "受让方", "目标公司", "标的公司", "合营公司",
  "担保人", "保证人", "债权人", "债务人", "抵押人", "抵押权人", "质押人", "质权人", "许可方", "被许可方", "投资方", "被投资方", "各方", "双方", "一方",
  "本人", "我方", "对方", "当事人", "乙方一", "乙方二", "甲方一", "甲方二",
]);
const DEFINED_RE = /([^\s，。；、：（(“”"]{2,40}?)\s*[（(]\s*(?:以下|下文)?\s*(?:简称|简称为|称)\s*[：:]?\s*[“"「『]([^”"」』]{2,20})[”"」』]\s*[）)]/gu;

function sharesHan(a: string, b: string): boolean {
  const fb = new Set(foldText(b));
  for (const c of foldText(a)) if (/\p{Script=Han}/u.test(c) && fb.has(c)) return true;
  return false;
}

/**
 * 在文本中找“全称（以下简称“简称”）”，全称须是已知当事人（容忍写法变体）。
 * 不作别名：角色词、人称代词、“X某/X氏”、时间等常用词；中文简称须与全称至少共用一个汉字（拉丁字母简称除外）——复核 S4-20。
 * 学得的别名由调用方标“待确认”，界面提示律师确认或删除。
 */
export function extractDefinedAliases(text: string, partyNames: readonly string[]): { name: string; alias: string }[] {
  if (!text || partyNames.length === 0) return [];
  const known = new Map(partyNames.map((n) => [foldText(n), n]));
  const out: { name: string; alias: string }[] = [];
  DEFINED_RE.lastIndex = 0;
  for (const m of text.matchAll(DEFINED_RE)) {
    const full = m[1]!;
    const alias = m[2]!.trim();
    if (isGenericAlias(alias)) continue;
    // 全称可能连着前文（“出借人孙悦”）：取以已知当事人结尾的那一段
    const ff = foldText(full);
    for (const [fold, name] of known) {
      if (!ff.endsWith(fold) || foldText(alias) === fold) continue;
      const latin = /^[A-Za-z][A-Za-z0-9&.\- ]{1,19}$/.test(alias.normalize("NFKC"));
      if (!latin && !sharesHan(alias, name)) break;
      out.push({ name, alias });
      break;
    }
  }
  return out;
}
