/**
 * citations.verify — 引用四态核验（方案第 2 篇 §5.3、第 4 篇 §9 全部离线完成）。
 *
 * 四态：来源已核 / 版本已核 / 支持待判 / 律师已确认；无法核实 → 拦截（不静默删除）。
 * 生成器无权标记“律师已确认”（§4.3），本工具永远不会返回该状态。
 * 支持性判断不在确定性工具内完成：内容支持一律“支持待判”，交后续模型与律师。
 * 数据源为签名法规库包（@zr-legal/lawdb）：名称归一、条号存在性、按适用时点取版本、
 * 效力状态、条号迁移表；每次核验对来源做 Source Registry 展示动作校验（§2.2）。
 * 案号类引用：存在性核验需授权数据商在线接口，离线一律「未核实（离线）」——不得进入签发版。
 */
import { CitationState, DomainError, type CitationState as CitationStateT } from "@zr-legal/domain";
import { versionAt, type Lawdb } from "@zr-legal/lawdb";
import { cnToInt, intToCn } from "./cn-numerals.ts";
import { BARE_NAMES, lawNameCandidates } from "./law-names.ts";

export interface RawCitation {
  raw: string;
  law: string;
  articleText: string;
  article: number;
  offset: number;
  /** 款、项（B-7）：有正文时核对是否存在，正文未采集时如实写“款项未核”。 */
  paragraph?: number | null;
  item?: number | null;
  /** “第X条之一”的“之一”：法规库按条号计数，之X条只核到基础条号。 */
  suffix?: string | null;
}

/**
 * 引用提取（v9.3 第 15 批 B-7；评审 Z1 P1-6：此前只认“《法名》第X条”，款、编、无书名号、司法解释全称都漏）：
 * - 书名号标题至多 80 字，标题里套的书名号（〈〉或误写的《》）都认；标题与条号之间可以有“合同编”“第三编第一分编”这类编章名；
 * - 条号后可带“之一”“第X款”“第X项 / 第（X）项”；同一法名后的“、第Y条”“至第Y条”“和第Y条”逐条提取；
 * - 没有书名号的“民法典第585条”“依照公司法第二十条”按简称表提取（只限“××法”“民法典”）；“该法 / 同法第X条”指上一部被引的法。
 * 覆盖边界如实：英美 citation、地方性法规无书名号的写法、只写“第二款”不写条号的回指不提取。
 */
const NUM = "[零〇一二两三四五六七八九十百千\\d]{1,12}";
const SMALL = "[一二三四五六七八九十\\d]{1,4}";
// 数字两侧允许空白（“第 585 条”，复核 R15B-02）
const REF = `第\\s*(${NUM})\\s*条(之[一二三四五六七八九十]{1,3})?(?:\\s*第\\s*(${SMALL})\\s*款)?(?:\\s*第\\s*(${SMALL})\\s*项|\\s*第?[（(](${SMALL})[)）]项)?`;
const PART = "([^，。；：、,;:《》〈〉\\n]{0,40}?)";
const TITLE_RE = new RegExp(`《((?:[^《》〈〉\\n]|〈[^〈〉\\n]{1,40}〉){2,80}?)》${PART}${REF}`, "g");
const LIST_RE = new RegExp(`^\\s*(?:、|，|,|和|及|以及|与|或者|或|至|到|—|－|-|～|~)\\s*${REF}`);
const BARE_RE = BARE_NAMES.length > 0 ? new RegExp(`((?:中华人民共和国)?(?:${BARE_NAMES.join("|")}))${PART}${REF}`, "g") : null;
// 回指词前面须是标点、空白或句首（复核 R15B-04：否则“劳动合同法第X条”里的“同法第X条”会再提一次）
const SAME_LAW_RE = new RegExp(`(?<![一-鿿])(?:该法|同法|上述法律|前述法律)${REF}`, "g");
/** 被引的法名（不论带不带条号），供“该法 / 同法”回指（复核 R15B-04：取最近提到的那部，不取最近带条号的那处）。 */
const TITLE_MENTION_RE = /《((?:[^《》〈〉\n]|〈[^〈〉\n]{1,40}〉){2,80}?)》/g;
const BARE_MENTION_RE = BARE_NAMES.length > 0 ? new RegExp(`(?:中华人民共和国)?(?:${BARE_NAMES.join("|")})`, "g") : null;

/**
 * 书名号里是合同、章程、函件、内部文件这类（《股权转让协议》第七条、《员工手册》第十五条）不是法：不当引用提取，免得都落到“须人工核对”。
 * 末尾的括注（《补充协议（二）》《公司章程（2021年修订）》）先去掉再比；“纪要”不排除（《九民纪要》要核）。复核 R15B-13。
 */
const DOC_TITLE_RE = /(协议|协议书|合同|合同书|章程|意向书|承诺函|确认函|通知书|备忘录|说明书|报告|清单|附件|手册|制度|规程|决议|委托书|起诉状|答辩状|申请书|意见书|招标文件|投标文件|文件)$/;
const isDocTitle = (title: string) => DOC_TITLE_RE.test(title.replace(/\s*[（(][^（）()]{1,30}[)）]\s*$/, ""));

/** 标题后面可以带的括注：版本（“（2023年修订）”）或文号（“（法释〔2020〕17号）”），复核 R15B-02。 */
const VERSION_NOTE_RE = /[（(][^（）()]{0,30}(?:年|修订|修正|法释|〔|号)[^（）()]{0,20}[）)]/g;

/** 编章名只许出现“编、分编、章、节、总则、分则、附则”与序号（否则多半是正文里别的话，宁可不提取也不张冠李戴）；版本或文号括注先去掉。 */
function partOk(part: string): boolean {
  const p = part.replace(VERSION_NOTE_RE, "").replace(/\s+/g, "");
  return p === "" || (/(编|章|节|总则|分则|附则|通则)/.test(p) && !/[条款项]/.test(p) && p.length <= 20);
}

/** 标题里误写的嵌套书名号改成〈〉、全角数字改半角（都是等长替换，位置不变）：《最高人民法院关于适用《中华人民共和国民事诉讼法》的解释》。 */
function foldNestedTitles(text: string): string {
  let depth = 0;
  let out = "";
  for (const ch of text) {
    if (ch === "《") {
      out += depth >= 1 ? "〈" : ch;
      depth += 1;
    } else if (ch === "》" && depth > 0) {
      depth -= 1;
      out += depth >= 1 ? "〉" : ch;
    } else if (ch >= "０" && ch <= "９") {
      out += String.fromCharCode(ch.charCodeAt(0) - 0xfee0);
    } else {
      if (ch === "\n") depth = 0;
      out += ch;
    }
  }
  return out;
}

const smallInt = (s: string | undefined): number | null => (s ? cnToInt(s) : null);

function refOf(m: RegExpMatchArray | RegExpExecArray, at: number): Omit<RawCitation, "raw" | "law" | "offset"> | null {
  const articleText = m[at]!;
  const article = cnToInt(articleText.replace(/〇/g, "零").replace(/两/g, "二"));
  if (article === null) return null;
  return { articleText, article, suffix: m[at + 1] ?? null, paragraph: smallInt(m[at + 2]), item: smallInt(m[at + 3] ?? m[at + 4]) };
}

/** 一处引用之后紧跟的“、第Y条 / 至第Y条”（同一部法）。 */
function followers(text: string, from: number, law: string, titleRaw: string, out: RawCitation[]): void {
  let pos = from;
  for (let i = 0; i < 50; i += 1) {
    const m = LIST_RE.exec(text.slice(pos, pos + 120));
    if (!m) return;
    const r = refOf(m, 1);
    if (r) out.push({ raw: `${titleRaw}${m[0].replace(/^\s*(?:、|，|,|和|及|以及|与|或者|或|至|到|—|－|-|～|~)\s*/, "")}`, law, offset: pos + m.index!, ...r });
    pos += m[0].length;
  }
}

/** 逐个匹配；被判不通过的匹配只跳过一个字再找（复核 R15B-04：不吞掉后面的真引用）。 */
function* scan(re: RegExp, text: string): Generator<RegExpExecArray, void, boolean | undefined> {
  const g = new RegExp(re.source, "g");
  let m: RegExpExecArray | null;
  while ((m = g.exec(text))) {
    const accepted = yield m;
    if (!accepted) g.lastIndex = m.index + 1;
  }
}

export function extractCitations(text: string): RawCitation[] {
  const t = foldNestedTitles(text);
  const out: RawCitation[] = [];
  const covered: [number, number][] = [];
  const titles = scan(TITLE_RE, t);
  for (let it = titles.next(); !it.done; ) {
    const m = it.value;
    let ok = false;
    if (partOk(m[2]!) && !isDocTitle(m[1]!)) {
      const r = refOf(m, 3);
      if (r) {
        const start = m.index;
        const end = start + m[0].length;
        out.push({ raw: text.slice(start, end), law: m[1]!, offset: start, ...r });
        covered.push([start, end]);
        followers(t, end, m[1]!, `《${m[1]!}》`, out);
        ok = true;
      }
    }
    it = titles.next(ok);
  }
  const inTitle = (i: number) => covered.some(([a, b]) => i >= a && i < b);
  // 没有书名号的“民法典第585条”（不在已提取的书名号引用里、前一个字不是书名号）
  if (BARE_RE) {
    const bare = scan(BARE_RE, t);
    for (let it = bare.next(); !it.done; ) {
      const m = it.value;
      const start = m.index;
      let ok = false;
      if (!inTitle(start) && t[start - 1] !== "《" && t[start - 1] !== "〈" && partOk(m[2]!)) {
        const r = refOf(m, 3);
        if (r) {
          const end = start + m[0].length;
          const law = `${m[1]!}`.replace(/^中华人民共和国/, "");
          out.push({ raw: text.slice(start, end), law, offset: start, ...r });
          covered.push([start, end]);
          followers(t, end, law, law, out);
          ok = true;
        }
      }
      it = bare.next(ok);
    }
  }
  // “该法 / 同法第X条”：指在它之前最近提到的那部法（带不带条号都算；合同等文件标题不算）
  const mentions: { at: number; law: string }[] = [];
  for (const m of t.matchAll(TITLE_MENTION_RE)) if (!isDocTitle(m[1]!)) mentions.push({ at: m.index ?? 0, law: m[1]! });
  if (BARE_MENTION_RE) for (const m of t.matchAll(BARE_MENTION_RE)) if (!inTitleMention(t, m.index ?? 0)) mentions.push({ at: m.index ?? 0, law: m[0].replace(/^中华人民共和国/, "") });
  for (const m of t.matchAll(SAME_LAW_RE)) {
    const start = m.index ?? 0;
    const prev = mentions.filter((x) => x.at < start).sort((a, b) => b.at - a.at)[0];
    if (!prev) continue;
    const r = refOf(m, 1);
    if (r) out.push({ raw: text.slice(start, start + m[0].length), law: prev.law, offset: start, ...r });
  }
  return out.sort((a, b) => a.offset - b.offset);
}

/** 这个位置是不是在某个书名号标题里面（无书名号法名的“提到”不算书名号里的字）。 */
function inTitleMention(t: string, at: number): boolean {
  const open = t.lastIndexOf("《", at);
  if (open < 0) return false;
  const close = t.lastIndexOf("》", at);
  return close < open;
}

/**
 * 写了“第X条”却没被认出是哪部法的地方（复核 R15B-02 兜底）：问答与复核页如实说“有 N 处没认出，请自行核对”，不显示成“没有引用”。
 * 前面紧挨着合同、协议、章程、“本 / 该 / 前”等的（“本合同第七条”）是文件内部条款，不算。
 */
export function unrecognizedArticleRefs(text: string, found: RawCitation[]): number {
  const t = foldNestedTitles(text);
  const spans = found.map((c) => [c.offset, c.offset + c.raw.length] as const);
  let n = 0;
  for (const m of t.matchAll(/第\s*[零〇一二两三四五六七八九十百千\d]{1,12}\s*条/g)) {
    const at = m.index ?? 0;
    if (spans.some(([a, b]) => at >= a && at < b)) continue;
    const before = t.slice(Math.max(0, at - 10), at);
    if (/(合同|协议|章程|细则|手册|制度|决议|办法|规则|本|该|前|上|下|其|此)[^，。；\n]{0,4}$/.test(before)) continue;
    n += 1;
  }
  return n;
}

/**
 * 案号粗粒度提取（如实说明覆盖边界）：只覆盖「(20xx 或 （20xx 开头、以「号」收尾」的中文案号形态，
 * 如（2023）最高法民终123号、(2024）京01民终1234号；年份与主体间允许全半角括号与数字字母混排。
 * 不覆盖：无「号」收尾的引用、英美 citation、非诉讼编号变体、括号内非 20xx 年份——未覆盖形态按未提取处理（不伪造核验结论）。
 */
const CASE_NO_RE = /[（(]20\d{2}[）)][0-9A-Za-z一-龥]{1,15}?号/g;

export function extractCaseNumbers(text: string): string[] {
  return [...text.matchAll(CASE_NO_RE)].map((m) => m[0]);
}

/** 案号在文字里的位置（与 extractCaseNumbers 同序；成果的论断—依据对照取原句用）。 */
export function caseNumberOffsets(text: string): number[] {
  return [...text.matchAll(CASE_NO_RE)].map((m) => m.index ?? -1);
}

export interface CitationVerifyParams {
  text?: string;
  citations?: { law: string; article: number }[];
  as_of: string; // 适用时点（分析截止日）
  topic_hint?: string; // 该引用在上下文中的主题（如“保密义务”），用于改引核验
}

export interface CitationVerdict {
  raw: string;
  kind: "statute" | "case";
  law_input: string;
  article: number | null;
  matched_law_name: string | null;
  lsv_id: string | null;
  effectiveness: string | null;
  state: CitationStateT;
  reasons: string[];
  suggestion: string | null;
  historical_note: string | null;
  checked_at: string;
}

export interface CitationVerifyResult {
  verdicts: CitationVerdict[];
  summary: {
    total: number;
    source_verified: number;
    version_verified: number;
    support_pending: number;
    intercepted: number;
    /** 案号离线未核实数量（不得进入签发版）。 */
    unverified_offline: number;
  };
  intercepted: CitationVerdict[]; // 拦截可见：单独列出，不静默删除
  /** 签名法规库包版本（§9「法规库最后更新日」数据源）。 */
  registry_coverage: string;
}

export function citationsVerify(lawdb: Lawdb, params: CitationVerifyParams): CitationVerifyResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(params.as_of ?? "")) {
    throw new DomainError("validation", "citations.verify 需要 as_of(YYYY-MM-DD)", 422);
  }
  const raws: RawCitation[] = [];
  if (params.text) raws.push(...extractCitations(params.text));
  for (const c of params.citations ?? []) {
    if (!c.law || !Number.isInteger(c.article)) throw new DomainError("validation", "citations[] 需要 law 与整数 article", 422);
    raws.push({ raw: `《${c.law}》第${intToCn(c.article)}条`, law: c.law, articleText: String(c.article), article: c.article, offset: -1 });
  }
  const checkedAt = new Date().toISOString();
  const verdicts: CitationVerdict[] = raws.map((rc) => verifyOne(lawdb, rc, params.as_of, params.topic_hint, checkedAt));
  // 案号：离线一律「未核实（离线）」（§9：存在性核验需授权数据商在线接口）
  if (params.text) {
    for (const caseNo of extractCaseNumbers(params.text)) {
      verdicts.push({
        raw: caseNo,
        kind: "case",
        law_input: caseNo,
        article: null,
        matched_law_name: null,
        lsv_id: null,
        effectiveness: null,
        state: CitationState.unverifiedOffline,
        reasons: ["case_offline_unverified:案例存在性与摘录核验需授权数据商在线接口（§9），离线显示「未核实（离线）」；该引用不得进入签发版，联网后补核"],
        suggestion: "联网后经授权数据商补核（只发案号等去标识查询）；在此之前改用可离线核验的法条引用或人工核验链接",
        historical_note: null,
        checked_at: checkedAt,
      });
    }
  }
  const intercepted = verdicts.filter((v) => v.state === CitationState.intercepted);
  return {
    verdicts,
    summary: {
      total: verdicts.length,
      // 口径：「来源已核」只计非拦截且非离线未核实；案号离线未核实独立计数，不冒充已核
      source_verified: verdicts.filter((v) => v.state !== CitationState.intercepted && v.state !== CitationState.unverifiedOffline).length,
      version_verified: verdicts.filter((v) => v.state === CitationState.versionVerified || v.state === CitationState.supportPending).length,
      support_pending: verdicts.filter((v) => v.state === CitationState.supportPending).length,
      intercepted: intercepted.length,
      unverified_offline: verdicts.filter((v) => v.state === CitationState.unverifiedOffline).length,
    },
    intercepted,
    registry_coverage: lawdb.packageVersion,
  };
}

function verifyOne(lawdb: Lawdb, rc: RawCitation, asOf: string, topicHint: string | undefined, checkedAt: string): CitationVerdict {
  const base: CitationVerdict = {
    raw: rc.raw,
    kind: "statute",
    law_input: rc.law,
    article: rc.article,
    matched_law_name: null,
    lsv_id: null,
    effectiveness: null,
    state: CitationState.intercepted,
    reasons: [],
    suggestion: null,
    historical_note: null,
    checked_at: checkedAt,
  };
  let rows = lawdb.findLawVersions(rc.law);
  // 简称、去或加“中华人民共和国”、标题里的〈〉（B-7）：原样查不到再按候选写法查
  for (const name of lawNameCandidates(rc.law)) {
    if (rows.length > 0) break;
    rows = lawdb.findLawVersions(name);
  }
  if (rows.length === 0) {
    base.reasons.push("unknown_source:注册库中不存在该法源，无法核实来源");
    return base;
  }
  base.matched_law_name = rows[0]!.law_name;
  const v = versionAt(rows, asOf);
  if (!v) {
    base.reasons.push(`no_applicable_version:适用时点 ${asOf} 无适用版本`);
    return base;
  }
  base.lsv_id = v.lsv_id;
  base.effectiveness = v.effectiveness;
  // Source Registry 运行时强制（§2.2）：展示动作未授权即停（不让模型补全未获授权的全文）
  lawdb.assertAction(v.source_license_id, "display");
  if (rc.article < 1 || rc.article > v.total_articles) {
    base.reasons.push(`article_out_of_range:第 ${rc.article} 条超出该版本总条数 ${v.total_articles}`);
    return base;
  }
  // 改引核验：上下文主题在迁移映射中有登记，且条号与所引不一致 → 拦截并提示改引
  if (topicHint) {
    const correct = lawdb.topicArticle(v.lsv_id, topicHint);
    if (correct !== null && correct !== rc.article) {
      base.reasons.push(`renumbered:${asOf} 起施行的版本（${v.lsv_id}）中，“${topicHint}”为第 ${correct} 条，所引第 ${rc.article} 条已不对应`);
      base.suggestion = `改引《${v.law_name}》第${intToCn(correct)}条（${v.effective} 施行版本）`;
      const older = lawdb.topicArticleInOtherVersion(v.law_id, v.lsv_id, topicHint, rc.article);
      if (older) {
        base.historical_note = `第 ${rc.article} 条系 ${older.effective} 施行版本（${older.lsv_id}，${older.effectiveness === "amended" ? "已修改" : "已废止"}）的条号`;
      }
      return base;
    }
  }
  // 款、项（B-7）：有条文正文时按正文的段落与“（一）”列项核对是否存在；正文未采集只核到条，如实注明（只在本机计数，正文不出本函数）
  const notes: string[] = [];
  // “第X条之一”：法规库按条号计数，款项只能拿基础条比——不比，如实写“只核到条”（复核 R15B-03）
  if (rc.suffix && (rc.paragraph || rc.item)) notes.push(`subdivision_unchecked:“第${intToCn(rc.article)}条${rc.suffix}”的款项没有核对`);
  if (!rc.suffix && (rc.paragraph || rc.item)) {
    const body = lawdb.getArticle(v.lsv_id, rc.article);
    const where = `第${intToCn(rc.article)}条${rc.paragraph ? `第${intToCn(rc.paragraph)}款` : ""}${rc.item ? `第（${intToCn(rc.item)}）项` : ""}`;
    if (!body) notes.push(`subdivision_unchecked:法规库只收了条号、没有${where}的正文，款项没有核对`);
    else {
      const st = articleStructure(body);
      if (rc.paragraph && rc.paragraph > st.length) {
        base.reasons.push(`paragraph_out_of_range:第 ${rc.article} 条只有 ${st.length} 款，没有第 ${rc.paragraph} 款`);
        return base;
      }
      if (rc.item) {
        const items = rc.paragraph ? st[rc.paragraph - 1]! : (st.find((n) => n > 0) ?? 0);
        if (rc.item > items) {
          base.reasons.push(`item_out_of_range:${rc.paragraph ? `第 ${rc.article} 条第 ${rc.paragraph} 款` : `第 ${rc.article} 条`}${items > 0 ? `只有 ${items} 项` : "没有分项"}，没有第 ${rc.item} 项`);
          return base;
        }
      }
    }
  }
  if (rc.suffix) notes.push(`suffix_unchecked:法规库按条号计数，“第${intToCn(rc.article)}条${rc.suffix}”只核到第${intToCn(rc.article)}条`);
  // 来源与版本均已核；内容是否支持命题不由确定性工具判断
  base.state = CitationState.supportPending;
  base.reasons.push("source_and_version_verified:来源与适用版本已核，内容支持待判", ...notes);
  return base;
}

/**
 * 条文结构：每款下有几项。款 = 不以“（一）”这类序号开头的段落；项 = 跟在某款后面、以“（一）”开头的段落。
 * 整段在全角括号里、括号里不是序号的是编者注（例如演示文本说明），不算款。
 */
export function articleStructure(body: string): number[] {
  const out: number[] = [];
  for (const line of body.split(/\n+/).map((x) => x.trim()).filter(Boolean)) {
    if (/^（[一二三四五六七八九十]{1,3}）/.test(line)) {
      if (out.length === 0) out.push(0);
      out[out.length - 1]! += 1;
      continue;
    }
    if (/^（[^）]*）$/.test(line)) continue;
    out.push(0);
  }
  return out;
}
