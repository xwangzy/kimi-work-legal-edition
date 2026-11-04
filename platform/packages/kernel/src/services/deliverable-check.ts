/**
 * 交付前检查（第 35 批）：docx.render_report 生成文书后，按文书文字做一次确定性检查（不调用模型），结果随工具返回给助手，
 * 让它在同一任务里改正后重新生成——此前文书工具只核对表格格数，正文里的问题要等律师自己读出来。
 *
 * 真实走查依据：N1 股权转让协议正文出现“著作权登记在转让方一 personal名下”；第 34 批律师验收指出交付件里有“amount_yuan”
 * “返回正文为演示数据”“未经金额工具复算”等工具用语；起草、修订后的条款编号与互引要靠律师逐条核对。
 *
 * 只报能确定的问题（宁可漏报不误报），每条给出位置、原文片段与改法；纯函数（法规核验经传入的法规库离线完成）。
 */
import type { Lawdb } from "@zr-legal/lawdb";
import { isCourtFiling, isPartyDocument, isSignMarker } from "@zr-legal/docx-engine";
import { cnToInt } from "../tools/tools/cn-numerals.ts";
import { checkArtifactCitations } from "./artifact-citations.ts";

export interface DeliverableSection {
  heading?: string;
  paragraphs?: string[];
  table?: { columns?: unknown[]; rows?: unknown[][] } | null;
}

export type DeliverableIssueKind = "internal_term" | "foreign_word" | "markdown" | "numbering" | "cross_ref" | "amount_words" | "citation";

export interface DeliverableIssue {
  kind: DeliverableIssueKind;
  /** 位置：节标题或“第 n 节第 m 段”“表格第 r 行”。 */
  where: string;
  /** 原文片段（至多 60 字）。 */
  text: string;
  /** 怎么改（一句话）。 */
  fix: string;
}

export interface DeliverableCheck {
  ok: boolean;
  /** 占位计数：律师复核时要逐个处理的“【待填】【待确认】【待定】”。 */
  placeholders: { 待填: number; 待确认: number; 待定: number };
  issues: DeliverableIssue[];
  note: string;
}

interface Para {
  where: string;
  text: string;
  /** 所在节的序号（从 0 起）与节标题。 */
  section: number;
  heading: string;
}

const MAX_ISSUES = 30;

/** 工具名、内部编号、工具参数名与系统用语：不该出现在给律师、客户或法院的文书里。 */
const INTERNAL_PATTERNS: { re: RegExp; fix: string }[] = [
  { re: /mcp__legal__\w+/g, fix: "删去工具名，改用律师的说法" },
  { re: /\b(?:riskcards|facts|outline|materials|citations|law|calc|docx|xlsx|table|rules)[._](?:submit|list|get|search|get_version|get_article|verify|interest|deadline|labor|court_fee|render_report|render_table|revise|read_excerpt|fill|propose)\b/g, fix: "删去工具名，改用律师的说法（如“经法规库核验”“经计算复核”）" },
  // V12：补齐内核实际签发的编号前缀（真实走查用例 6：《案卷总目录》“关联事实编号”一列写满 fct_… 事实编号）
  { re: /\b(?:docv|psv|artv|art|run|att|mat|est|approval|apr|usr|ten|pv|fct|rkc|otl|rtb|rtc|tdo|anc|lsv|tplv|rev|dlv|qac|qam|syn|ftp|rrs|cbt|drc|conf|ckp|qa)_[0-9a-f][0-9a-f-]{5,}/g, fix: "删去内部编号，用文件名、条款号或时间线序号称呼" },
  { re: /\b[a-z]{2,}(?:_[a-z]{2,})+\b/g, fix: "删去工具参数名（如 amount_yuan），改写成中文说明" },
  { re: /演示数据|演示库|演示法规|SKILL\.md|rubric|quality=ok/gi, fix: "删去系统内部用语" },
  { re: /(?:金额|计算|法律|文书|表格|检索|修订)工具/g, fix: "改用律师的说法（如“经核算”“经法规库核验”）" },
];

/**
 * 只对 Word 文书报的界面与环境用语（V13 真实走查 N2 独立律师评分：《审查意见书（内部稿）》第一、六、七节写着“识别质量正常、无被替代版本”
 * “核验状态”“已在受限命令行复算”“请在审查工作台处理……生成”，交付形式 1 分）。Excel 问题清单按方法本就有“风险卡序号”“核验状态”列，不报。
 */
const WORD_INTERFACE_RE = /审查工作台|风险卡|受限命令行|核验状态|识别质量|被替代版本/g;

/** 夹在中文之间的英文单词（如“转让方一 personal名下”）；全大写缩写（LPR、SLA）与常见外来词不报。 */
const FOREIGN_RE = /(?<=[一-鿿])[  ]?([A-Za-z][a-z]{2,})[  ]?(?=[一-鿿])/g;
const FOREIGN_OK = new Set(["app", "email", "wifi", "word", "excel", "pdf", "saas", "paas", "iaas", "logo", "html", "java", "python", "linux", "windows", "android", "ios", "web", "wechat", "pos", "erp", "crm", "api", "sdk", "led", "usb", "gps", "vip", "ceo", "cfo", "cto", "coo"]);

/** Markdown 残留：Word 里会原样显示成星号、井号。 */
const MARKDOWN_PATTERNS: { re: RegExp; fix: string }[] = [
  { re: /\*\*[^*\n]{1,40}\*\*/g, fix: "去掉星号（Word 里会原样显示）；要强调的写成独立一句或放进标题" },
  { re: /^#{1,6}\s+\S/g, fix: "去掉行首井号，标题放进该节的 heading" },
  { re: /\|\s*-{3,}\s*\|/g, fix: "表格用该节的 table 画，不要写 Markdown 表格" },
  { re: /`[^`\n]{1,40}`/g, fix: "去掉反引号" },
];

/** 条款标题：“第 N 条 标题”（阿拉伯或中文数字）。 */
const ARTICLE_HEADING_RE = /^\s*第\s*([0-9]{1,3}|[一二三四五六七八九十百零〇]{1,6})\s*条(?:\s|$|[^款项之])/;
/** 段首款号“N.M”（不含 N.M.K 的第三级）。 */
const CLAUSE_RE = /^\s*([0-9]{1,3})\.([0-9]{1,3})(?![.\d])/;

export function checkDeliverable(title: string, sections: readonly DeliverableSection[], opts: { lawdb?: Lawdb; asOf?: string; docx?: Buffer } = {}): DeliverableCheck {
  const paras = flatten(title, sections);
  const issues: DeliverableIssue[] = [];
  const push = (i: DeliverableIssue) => {
    if (issues.length < MAX_ISSUES && !issues.some((x) => x.kind === i.kind && x.text === i.text && x.where === i.where && x.fix === i.fix)) issues.push(i);
  };
  const all = paras.map((p) => p.text).join("\n");
  const placeholders = {
    待填: (all.match(/【待填/g) ?? []).length,
    待确认: (all.match(/【[^】]{0,20}待确认/g) ?? []).length,
    待定: (all.match(/【待定/g) ?? []).length,
  };

  for (const p of paras) {
    for (const { re, fix } of INTERNAL_PATTERNS) {
      re.lastIndex = 0;
      for (const m of p.text.matchAll(re)) {
        // 邮箱、网址里的下划线不是参数名
        if (/[@/]/.test(p.text.slice(Math.max(0, m.index! - 30), m.index! + m[0].length + 30)) && /_/.test(m[0]) && !/\./.test(m[0])) continue;
        push({ kind: "internal_term", where: p.where, text: m[0], fix });
      }
    }
    if (opts.docx) {
      WORD_INTERFACE_RE.lastIndex = 0;
      for (const m of p.text.matchAll(WORD_INTERFACE_RE)) {
        push({ kind: "internal_term", where: p.where, text: snippet(p.text, m.index!, m[0].length), fix: `文书里不写工具与界面用语“${m[0]}”：删去或改成律师的说法（如“已审阅全文”“经核算”）；要律师在界面上做的事写进最终答复` });
      }
    }
    FOREIGN_RE.lastIndex = 0;
    for (const m of p.text.matchAll(FOREIGN_RE)) {
      if (FOREIGN_OK.has(m[1]!.toLowerCase())) continue;
      push({ kind: "foreign_word", where: p.where, text: snippet(p.text, m.index!, m[0].length), fix: `正文夹杂英文“${m[1]}”：改成中文` });
    }
    for (const { re, fix } of MARKDOWN_PATTERNS) {
      re.lastIndex = 0;
      for (const m of p.text.matchAll(re)) push({ kind: "markdown", where: p.where, text: m[0].slice(0, 40), fix });
    }
    for (const a of amountMismatches(p.text)) push({ kind: "amount_words", where: p.where, text: a.text, fix: `小写 ${a.figure} 与大写（折合 ${a.words}）不一致：按核对后的金额统一大小写` });
  }

  // 当事人文书（合同、协议等，要发给对方）：正文不写内部说明、签署页之后不再有条款（第 35 批真实走查 R1）
  if (isPartyDocument(`${title}.docx`)) for (const i of partyDocumentIssues(paras)) push(i);
  // 递交法院、客户的文书（起诉状、答辩状、法律意见书、律师函）：给律师的提示不进正文（第 35 批真实走查 R3、R4）
  else if (isOutward(title)) for (const i of outwardIssues(paras)) push(i);
  for (const i of numberingIssues(sections)) push(i);
  for (const i of crossRefIssues(sections, paras)) push(i);

  // 法条核验：条号超出范围、已改号、适用时点没有有效版本（编造或记错的条号）——与签发前的引用核验同一套判定
  if (opts.lawdb && opts.docx && opts.asOf) {
    try {
      const c = checkArtifactCitations(opts.lawdb, `${title}.docx`, opts.docx, opts.asOf);
      for (const it of c.items) if (it.kind === "wrong") push({ kind: "citation", where: "引用", text: it.raw.slice(0, 60), fix: `${it.reason ?? "条号或版本不对"}：用法规库查准后改正，查不准的删去条号` });
    } catch {
      // 核验失败不影响文书生成；签发前还会再核
    }
  }

  const ok = issues.length === 0;
  return {
    ok,
    placeholders,
    issues,
    note: ok
      ? "交付前检查未发现问题（只查工具用语、夹杂英文、条款编号、互引、大小写金额、法条号这几类，不代替律师复核）"
      : `交付前检查发现 ${issues.length} 处问题：Word 文书用 docx.edit_draft 在这份文书上逐处改正（不要整份重新生成），表格改正后重新生成；确实不需要改的（如律师要求保留），在最终答复里说明理由`,
  };
}

/** 合同正文里写给律师或客户的内部说明（发给对方前要人工删）。 */
const PARTY_INTERNAL_RE = /首稿方案|待客户确认|待对方(?:书面)?确认|材料未(?:明确)?(?:约定|载明|提供)|见起草说明|起草说明(?:与待定事项)?》?中|本所|律师复核|经律师确认|请律师|手工计算|请复核|代号(?:记载|形式|表示|替代)|以(?:合同)?代号/;

/**
 * 写给律师的提示（第 35 批真实走查 R3、R4）：计算工具的提示“请律师按当地公布的数据核对”、手工计算的“请复核”、材料的“识别质量”、
 * 隐私代号的说法（“以代号记载”）原样进了意见书正文与递交法院的附件。律所对外文书里的“本所律师”是正常写法，不报。
 */
// V10 真实走查 V3 律师评分：对外意见书里出现“本意见不写尚未核实的具体救济天数”“不以电子文本长度代替页数”这类写作说明——讲的是本文怎么写，不是对客户的意见
const OUTWARD_INTERNAL_RE = /请律师|律师(?:核对|复核)|经律师确认|手工计算|请复核|识别质量|代号(?:记载|形式|表示|替代)|以(?:合同)?代号|未经你确认|本(?:意见|文|函)(?:书)?不(?:写|列|作|对)[^。；]{0,12}(?:未核实|尚未核实|未采集|未收录)|不以电子文本|法规库(?:未收录|没有)|原文未(?:采集|收录)/;
/** 对外文书：递交法院、仲裁机构的文书与律所出具给客户或对方的意见书、律师函；内部稿、备忘录、清单、说明不算。 */
function isOutward(title: string): boolean {
  if (/内部|备忘录|清单|起草说明|对照表|底稿|研究/.test(title)) return false;
  return isCourtFiling(`${title}.docx`) || /法律意见|意见书|律师函|答复函|顾问答复/.test(title);
}

function outwardIssues(paras: readonly Para[]): DeliverableIssue[] {
  const out: DeliverableIssue[] = [];
  for (const p of paras) {
    const m = OUTWARD_INTERNAL_RE.exec(p.text);
    if (m) out.push({ kind: "internal_term", where: p.where, text: snippet(p.text, m.index, m[0].length), fix: "这份文书要交给客户或法院，正文不写给律师的提示：删去这句；影响结论的限制改写成对客户的专业表述（如“上述金额尚未按当地上年度职工月平均工资三倍封顶复核”），原话写进最终答复" });
  }
  return out;
}

function partyDocumentIssues(paras: readonly Para[]): DeliverableIssue[] {
  const out: DeliverableIssue[] = [];
  for (const p of paras) {
    // 每段报一次（同一句里“首稿方案”“待客户确认”常一起出现）
    const m = PARTY_INTERNAL_RE.exec(p.text);
    if (m) out.push({ kind: "internal_term", where: p.where, text: snippet(p.text, m.index, m[0].length), fix: "合同正文要发给对方，不写内部说明：删去这句（或整条），口径说明写进《起草说明》" });
  }
  // 签署页之后接着正文最后一条往下编的款（正文最后是 20.7，签署页、附件之后又冒出“20.8 ……”），或紧接其后的新条：落错了位置。附件自己的编号不算
  // 签署页标记（V10：“（以下为《增资协议》签署页，无正文）”“（本页无正文，为……签署页）”同样认，与文书引擎同一规则）
  const sign = paras.findIndex((p) => isSignMarker(p.text));
  if (sign >= 0) {
    let last = 0;
    const maxClause = new Map<number, number>();
    for (const p of paras.slice(0, sign)) {
      const h = ARTICLE_HEADING_RE.exec(p.heading);
      const hn = h ? cnToInt(h[1]!) : null;
      if (hn !== null) last = Math.max(last, hn);
      const c = /^(\d{1,2})\.(\d{1,2})\s/.exec(p.text.trim());
      if (c) maxClause.set(Number(c[1]), Math.max(maxClause.get(Number(c[1])) ?? 0, Number(c[2])));
    }
    if (last > 0) {
      for (const p of paras.slice(sign + 1)) {
        const c = /^(\d{1,2})\.(\d{1,2})\s/.exec(p.text.trim());
        const a = /^第([一二三四五六七八九十百零〇\d]+)条/.exec(p.text.trim()) ?? ARTICLE_HEADING_RE.exec(p.heading === p.text ? p.text : "");
        const stray = c ? Number(c[1]) === last && Number(c[2]) > (maxClause.get(last) ?? 0) : a ? cnToInt(a[1]!) === last + 1 : false;
        if (stray) out.push({ kind: "numbering", where: p.where, text: p.text.slice(0, 40), fix: "这一款接着正文最后一条往下编，却落在“以下无正文”与签署页之后：移回签署页之前的对应条款里" });
      }
    }
  }
  return out;
}

function flatten(title: string, sections: readonly DeliverableSection[]): Para[] {
  const out: Para[] = [{ where: "标题", text: String(title ?? ""), section: -1, heading: "" }];
  sections.forEach((s, si) => {
    const heading = String(s?.heading ?? "").trim();
    const name = heading || `第 ${si + 1} 节`;
    if (heading) out.push({ where: `${name}（标题）`, text: heading, section: si, heading });
    (Array.isArray(s?.paragraphs) ? s.paragraphs : []).forEach((t, pi) => out.push({ where: `${name}第 ${pi + 1} 段`, text: String(t ?? ""), section: si, heading }));
    const cols = Array.isArray(s?.table?.columns) ? s.table!.columns! : [];
    if (cols.length > 0) out.push({ where: `${name}表头`, text: cols.map((c) => String(c ?? "")).join(" | "), section: si, heading });
    const rows = Array.isArray(s?.table?.rows) ? s.table!.rows! : [];
    rows.forEach((r, ri) => out.push({ where: `${name}表格第 ${ri + 1} 行`, text: (Array.isArray(r) ? r : []).map((c) => String(c ?? "")).join(" | "), section: si, heading }));
  });
  return out;
}

function snippet(text: string, at: number, len: number): string {
  const s = Math.max(0, at - 12);
  return text.slice(s, Math.min(text.length, at + len + 12));
}

/** 条款编号：“第 N 条”连续不重复；节内段首款号“N.M”的 N 与本条一致、M 从 1 起连续。只在文书有“第 N 条”标题时检查。 */
function numberingIssues(sections: readonly DeliverableSection[]): DeliverableIssue[] {
  const out: DeliverableIssue[] = [];
  const arts: { n: number; heading: string; si: number }[] = [];
  sections.forEach((s, si) => {
    const h = String(s?.heading ?? "");
    const m = ARTICLE_HEADING_RE.exec(h);
    const n = m ? cnToInt(m[1]!) : null;
    if (n !== null) arts.push({ n, heading: h.trim(), si });
  });
  if (arts.length < 3) return out;
  for (let i = 1; i < arts.length; i++) {
    const prev = arts[i - 1]!.n;
    const cur = arts[i]!.n;
    if (cur === prev) out.push({ kind: "numbering", where: arts[i]!.heading, text: arts[i]!.heading.slice(0, 40), fix: `条号与上一条重复（都是第 ${cur} 条）：顺延后面的条号并同步互引` });
    else if (cur !== prev + 1) out.push({ kind: "numbering", where: arts[i]!.heading, text: arts[i]!.heading.slice(0, 40), fix: `条号不连续（上一条是第 ${prev} 条）：补齐或顺延条号并同步互引` });
  }
  // 节内款号：表后接着写的节（标题为空）仍属上一条
  let current: number | null = null;
  let expect = 1;
  sections.forEach((s, si) => {
    const art = arts.find((a) => a.si === si);
    if (art) {
      current = art.n;
      expect = 1;
    } else if (String(s?.heading ?? "").trim()) current = null;
    if (current === null) return;
    for (const t of Array.isArray(s?.paragraphs) ? s.paragraphs : []) {
      const m = CLAUSE_RE.exec(String(t ?? ""));
      if (!m) continue;
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (a !== current) out.push({ kind: "numbering", where: art?.heading ?? `第 ${current} 条`, text: String(t).slice(0, 40), fix: `款号“${a}.${b}”写在第 ${current} 条下：改成 ${current}.${b === expect ? b : expect}` });
      else if (b !== expect) out.push({ kind: "numbering", where: art?.heading ?? `第 ${current} 条`, text: String(t).slice(0, 40), fix: `款号不连续（应为 ${current}.${expect}）：顺延款号并同步互引` });
      expect = (a === current ? b : expect) + 1;
    }
  });
  return out;
}

/** 互引：“本协议第 X 条”“第 X.Y 款”指向本文书里不存在的条款（只在文书有“第 N 条”标题时检查；法律条文的引用不在此列）。 */
function crossRefIssues(sections: readonly DeliverableSection[], paras: readonly Para[]): DeliverableIssue[] {
  const out: DeliverableIssue[] = [];
  const arts = new Set<number>();
  const clauses = new Set<string>();
  let current: number | null = null;
  for (const s of sections) {
    const m = ARTICLE_HEADING_RE.exec(String(s?.heading ?? ""));
    const n = m ? cnToInt(m[1]!) : null;
    if (n !== null) {
      arts.add(n);
      current = n;
    } else if (String(s?.heading ?? "").trim()) current = null;
    for (const t of Array.isArray(s?.paragraphs) ? s.paragraphs : []) {
      const c = CLAUSE_RE.exec(String(t ?? ""));
      if (c && current !== null) clauses.add(`${c[1]}.${c[2]}`);
    }
  }
  if (arts.size < 3) return out;
  const max = Math.max(...arts);
  for (const p of paras) {
    // 条：前面 12 字内有书名号或“法”“解释”“规定”的是法律条文，不算互引
    for (const m of p.text.matchAll(/第\s*([0-9]{1,3}|[一二三四五六七八九十百零〇]{1,6})\s*条/g)) {
      const before = p.text.slice(Math.max(0, m.index! - 12), m.index!);
      if (/[》法则例定释]|规定|办法|纪要|意见/.test(before)) continue;
      const n = cnToInt(m[1]!);
      if (n !== null && !arts.has(n) && n > max) out.push({ kind: "cross_ref", where: p.where, text: snippet(p.text, m.index!, m[0].length), fix: `本文书只有 ${max} 条，“${m[0]}”指向不存在的条款：改成正确条号` });
    }
    // 款：“第 X.Y 款”“X.Y款”
    for (const m of p.text.matchAll(/第?\s*([0-9]{1,3})\.([0-9]{1,3})\s*款/g)) {
      const key = `${m[1]}.${m[2]}`;
      const before = p.text.slice(Math.max(0, m.index! - 12), m.index!);
      if (/[》法则例定释]|规定|办法/.test(before)) continue;
      if (clauses.size > 0 && arts.has(Number(m[1])) && !clauses.has(key)) out.push({ kind: "cross_ref", where: p.where, text: snippet(p.text, m.index!, m[0].length), fix: `本文书第 ${m[1]} 条下没有 ${key} 款：改成正确款号` });
    }
  }
  return out;
}

const CN_DIGIT: Record<string, number> = { 零: 0, 〇: 0, 壹: 1, 一: 1, 贰: 2, 二: 2, 两: 2, 叁: 3, 三: 3, 肆: 4, 四: 4, 伍: 5, 五: 5, 陆: 6, 六: 6, 柒: 7, 七: 7, 捌: 8, 八: 8, 玖: 9, 九: 9 };
const CN_SMALL: Record<string, number> = { 拾: 10, 十: 10, 佰: 100, 百: 100, 仟: 1000, 千: 1000 };

/** 大写金额 → 数值（元，保留到分）：支持 亿 / 万 / 仟佰拾、元（圆）角分、整；认不出返回 null。纯函数。 */
export function cnAmountToNumber(text: string): number | null {
  const s = text.replace(/^人民币/, "").replace(/[整正]$/, "").trim();
  const m = /^([^元圆]*)[元圆]?(?:([^角分]*)角)?(?:([^分]*)分)?$/.exec(s);
  if (!m) return null;
  const intPart = m[1] ?? "";
  let total = 0;
  let section = 0;
  let digit = 0;
  let seen = false;
  for (const ch of intPart) {
    if (ch in CN_DIGIT) {
      digit = CN_DIGIT[ch]!;
      seen = true;
    } else if (ch in CN_SMALL) {
      section += (digit === 0 && !seen ? 1 : digit) * CN_SMALL[ch]!;
      digit = 0;
      seen = true;
    } else if (ch === "万") {
      total += (section + digit) * 10_000;
      section = 0;
      digit = 0;
    } else if (ch === "亿") {
      total = (total + section + digit) * 100_000_000;
      section = 0;
      digit = 0;
    } else return null;
  }
  let yuan = total + section + digit;
  const jiao = m[2] ? CN_DIGIT[m[2].replace(/零/g, "").trim()] : 0;
  const fen = m[3] ? CN_DIGIT[m[3].replace(/零/g, "").trim()] : 0;
  if (jiao === undefined || fen === undefined) return null;
  if (!seen && !m[2] && !m[3]) return null;
  yuan += (jiao ?? 0) / 10 + (fen ?? 0) / 100;
  return Math.round(yuan * 100) / 100;
}

/** 同一段里“小写金额（大写：……）”前后不一致的地方。只认紧挨着的写法，不跨句猜。 */
function amountMismatches(text: string): { text: string; figure: string; words: string }[] {
  const out: { text: string; figure: string; words: string }[] = [];
  const re = /([0-9][0-9,，]*(?:\.[0-9]{1,2})?)\s*(万元|元)[^（(]{0,6}[（(]\s*(?:大写|大写金额)\s*[:：]?\s*((?:人民币)?[零〇壹贰叁肆伍陆柒捌玖拾佰仟万亿元圆角分整正一二三四五六七八九十百千两]+)\s*[）)]/g;
  for (const m of text.matchAll(re)) {
    const fig = Number(m[1]!.replace(/[,，]/g, "")) * (m[2] === "万元" ? 10_000 : 1);
    const words = cnAmountToNumber(m[3]!);
    if (words === null || !Number.isFinite(fig)) continue;
    if (Math.abs(fig - words) > 0.005) out.push({ text: m[0].slice(0, 60), figure: m[1]! + m[2]!, words: `${words.toLocaleString("zh-CN", { minimumFractionDigits: 2 })}元` });
  }
  return out;
}
