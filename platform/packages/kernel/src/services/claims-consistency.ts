/**
 * 诉讼请求“并用 / 择一”交付前检查（第 65 批；V39 第二轮研究 R3 第 10 节 formal-legal-consequence 的 C1～C14，R1 第 6 节 N2、N3）。
 *
 * 起诉状、反诉状、仲裁申请书（含劳动人事争议仲裁申请书、仲裁反请求申请书）、上诉状的请求节里，两项请求依法只能选择其一、
 * 或者互相矛盾的，交付前报回（kind: "claims"），由助手按 fix 改正；律师函、催告函只在列出了“要求事项”的情况下查
 * C1 定金与违约金、C4 解除与继续履行、C12 赔偿金与经济补偿、C13 恢复劳动关系与赔偿金四条（函件写法松散，其余几条误报风险高）。
 *
 * 只看请求节：节标题（或单独成段的“诉讼请求：”）是“诉讼请求 / 反诉请求 / 仲裁请求 / 仲裁反请求 / 上诉请求 / 请求事项”，
 * 到下一节标题或“事实与理由”“此致”为止；函件是“完成以下事项：”“现要求贵司：”之后连续的列项。找不到请求节的不报。
 * 规则的依据都用法规库原文逐条核对过（条号与要点写在各规则旁）。误报宁少勿多：
 * - 写了“择一 / 选择 / 备位 / 先位 / 或者…… / 如……不予支持（不能、被认定），则……”的不报（本项、对方那一项或请求节的说明段里有即可）；
 * - 否定语境不算请求（“不要求继续履行”“驳回……违约金”“撤销一审判决……违约金的部分”“无需双倍返还定金”）；
 * - 两项点名了不同的具体当事人（被告一与被告二、第三人）、书名号里是不同合同的，不按同一责任判；“解除前 / 解除后”是时间点，
 *   劳动合同的解除不是民事合同的解除；
 * - 同一份文书同一条规则只报一次（第一处）。
 * - 两条“不报”规则（防止把合法的并用当成重复）：迟延履行违约金与继续履行可以并用（民法典第五百八十五条第三款），
 *   合同解除与违约金、赔偿损失可以并用（民法典第五百六十六条第二款；买卖合同解释第二十条）——本检查不设这两种组合；
 * - 借贷案件的逾期利息、违约金可以一并主张（民间借贷规定第二十九条，合计不超过合同成立时一年期 LPR 四倍），不报择一。
 * 研究表里有、本检查不做的（判定不可靠）：C3 定金超过主合同标的额 20%（请求节里取不到标的额）；C8 确认无效而没请求返还
 * （律师可以只做确认之诉，不是错误）；C10 违约金与赔偿损失并请（是否同一违约、同一损失要看事实；真实催告函里“违约金不足部分另赔差额”
 * 是合法写法），这三条交独立复核。纯函数。
 */

export interface ClaimsIssue {
  kind: "claims";
  /** 位置：请求所在段（两项不在同一段时写两处）。 */
  where: string;
  /** 原文片段（至多 60 字）。 */
  text: string;
  /** 怎么改（一句话，带法条）。 */
  fix: string;
}

interface Para {
  where: string;
  text: string;
}

type DocType = "filing" | "letter";

/** 要递交的请求类文书（按标题判断）；说明、要点、审查意见、答辩等标题里带这些字的不是请求文书本身。 */
const FILING_TITLE = /起诉状|反诉状|仲裁申请书|反请求申请书|上诉状/;
const LETTER_TITLE = /律师函|催告函|催款函|催收函/;
const NOT_REQUEST_DOC = /答辩|意见|说明|要点|分析|审查|清单|对照|模板|指引|备忘|报告|提纲|笔记|摘要|评估|核对|批注/;

function docType(title: string): DocType | null {
  const t = String(title ?? "");
  if (NOT_REQUEST_DOC.test(t)) return null;
  if (FILING_TITLE.test(t)) return "filing";
  if (LETTER_TITLE.test(t)) return "letter";
  return null;
}

/** 请求节标题：可带“一、”“（一）”序号；“诉讼请求：1. 判令……”同段写请求的，冒号后的部分当作第一项。 */
const REQ_HEAD = /^\s*(?:[一二三四五六七八九十]+[、.．]\s*|[（(][一二三四五六七八九十]+[）)]\s*)?(?:诉讼请求|反诉请求|仲裁请求事项|仲裁请求|仲裁反请求|反请求事项|反请求|上诉请求|请求事项|要求事项)(?:如下)?\s*(?:[:：]\s*(.*))?$/;
/** 请求节到此为止（没排成节标题、写成普通段的“事实与理由：”“此致”、落款）。 */
const END_PARA = /^\s*(?:[一二三四五六七八九十]+[、.．]\s*)?(?:事实(?:与|和|及)理由|事实(?:与|和)依据|理由如下|此致|证据(?:和证据来源|清单|目录)?\s*[:：]?\s*$|附\s*[:：]|附件|具状人|上诉人\s*[:：（(]|申请人\s*[:：（(]|原告\s*[:：（(]|反诉原告\s*[:：（(])/;
/** 函件的要求列项引导句（“自本函送达之日起3日内完成以下全部事项：”“现要求贵司：”）。 */
const LETTER_LEAD = /(?:以下|如下)(?:全部|各项)?(?:事项|要求)\s*[:：]\s*$|(?:要求|请求|敦促|催告|促请)贵(?:司|方|单位|公司)[^。；]{0,24}[:：]\s*$/;
/** 一项请求的序号：“1.”“1、”“一、”“（一）”“（1）”；“第1、2项”“310,000.00”这类数字不算。 */
const ITEM_START = /^\s*(?:[一二三四五六七八九十]+[、.．]|[（(](?:[一二三四五六七八九十]+|\d{1,2})[）)]|\d{1,2}[.、．](?!\d))/;
/** 一段里写了几项（“1.……；2.……”）的拆分点：句末标点后紧跟序号。 */
const ITEM_SPLIT = /(?<=[；;。])\s*(?=(?:[一二三四五六七八九十]+、|[（(](?:[一二三四五六七八九十]+|\d{1,2})[）)]|\d{1,2}[.、．](?!\d)))/;

/**
 * 择一、备位的写法：同一项、对方那一项或请求节的说明段里有即不报。
 * “或者”只认后面跟着请求动词、责任形式的（“解除或者终止劳动合同”先去掉，不算选择）。
 */
const ALT = /择一|二选一|选择(?:适用|主张|其一|其中)?|备位|先位|预备(?:性)?请求|退一步|择高|取其高|较高者|(?:如|若|如果|倘若|假如)[^。；]{0,40}?(?:不予支持|未获支持|不被支持|不能|无法|被认定|认定|不成立|驳回)[^。；]{0,40}?则|(?:或者|或)[^，。；]{0,8}?(?:支付|返还|赔偿|判令|裁令|裁决|主张|适用|违约金|定金|经济补偿|赔偿金|继续履行|恢复)/;
const ALT_MASK = /(?:解除|终止|无效|撤销)或者?(?:被)?(?:终止|解除|撤销)/g;

/** 否定语境：这处字样所在分句（上一个逗号、分号、冒号之后到字样之前）有这些词的，不算提出了这项请求。 */
const NEG = /不要求|不再要求|不主张|不再主张|放弃|无需|无须|不予|不应|不得|不承担|不再支付|免除|驳回|无法|不能|不同意|无义务|并非|不属于|撤销|不包括|不含|不适用|无权|否认|不存在/;

// —— 责任形式的识别（每类一条正则；ok 是额外的排除条件）——

/** 定金罚则（民法典第五百八十七条：收受方双倍返还、给付方无权请求返还）。单倍“返还定金”是解除后的返还，不算。 */
const DEPOSIT = /双倍返还(?:其?已?(?:收取|收受|交付|支付|收到)的)?定金|定金[^，。；]{0,10}?(?:双倍|两倍|二倍)(?:返还|退还)|(?:返还|退还|支付)(?:双倍|两倍|二倍)(?:的)?定金|定金罚则|无权(?:请求|要求)?(?:返还|退还|收回)[^，。；]{0,10}?定金|(?:不予|无需|不再)(?:返还|退还)[^，。；]{0,10}?定金|没收[^，。；]{0,6}?定金/;
/** 违约金。“超过定金数额的损失”（第五百八十八条第二款）不含这三个字，不会被当成违约金。 */
const PENALTY = /违约金/;
/** 没有约定定金性质的款项主张双倍返还（合同编通则解释第六十七条第一款列举：留置金、担保金、保证金、订约金、押金、订金）。 */
const DEPOSIT_LIKE = /(?:订金|押金|保证金|诚意金|意向金|订约金|留置金|担保金)[^，。；]{0,15}?(?:(?:双倍|两倍|二倍)(?:返还|退还)|定金罚则)|(?:(?:双倍|两倍|二倍)(?:返还|退还)|适用定金罚则)[^，。；]{0,15}?(?:订金|押金|保证金|诚意金|意向金|订约金|留置金|担保金)/;
const DEPOSIT_NATURE = /定金性质|具有定金|作为定金|视为定金|即定金|性质为定金/;
/** 金钱债务迟延的违约金（逾期付款违约金；或违约金与欠付款项同项、且不是交货、工期一类的违约金）。 */
const MONEY_PENALTY = /(?:逾期|迟延|延迟|延期)(?:付款|支付|还款|缴纳|缴付|给付)[^，。；]{0,6}?违约金/;
const DEBT_WORD = /(?:欠付|拖欠|未付|尚欠|应付)[^，。；]{0,15}?(?:款|金|费)/;
const NOT_MONEY = /交货|交付货物|供货|发货|竣工|工期|办证|过户|交房|搬离|腾退|返还房屋/;
/** 逾期付款的利息、资金占用损失。民事诉讼法规定的“迟延履行期间的债务利息”（执行阶段）先去掉，不算。 */
const INTEREST = /逾期(?:付款|还款|支付)?(?:的)?利息|资金占用(?:损失|费|利息)|利息损失|逾期付款(?:的)?损失|(?:欠款|货款|价款|工程款|租金|款项|本金)(?:的)?(?:逾期)?利息|(?:及|并|和|以及)(?:其)?(?:逾期)?利息/;
const ENFORCEMENT_INTEREST = /(?:加倍支付)?迟延履行期间的?(?:债务)?利息/g;
/** 借贷案件（民间借贷规定第二十九条：逾期利息、违约金可以一并主张）：全文任一处出现即按借贷处理。 */
const LOAN = /民间借贷|借款合同|借贷合同|借款协议|借条|借据|欠条|出借人|借款人|金融借款|借款本金|归还借款|偿还借款|借款纠纷/;
/** 继续履行（民事合同；劳动合同的继续履行归 REINSTATE）。 */
const PERFORM = /继续履行|继续履约|继续供货|继续交货|强制履行|实际履行/;
const LABOR_OBJ = /^(?:[^，。；]{0,16}?的|双方(?:签订的|之间的)?|原)?(?:劳动合同|劳动关系)/;
/** 解除合同（劳动合同、解除查封等不算；“确认解除通知无效”是要求继续履行，不算解除）。 */
const RESCIND = /解除(?!权)[^，。；]{0,30}?(?:合同|协议)|(?:合同|协议)》?[^，。；]{0,24}?解除(?!权)/;
const RESCIND_VOID = /无效|不发生|不成立|违法|错误|不当|不符合/;
/** “合同解除后”“解除之日”是时间点，不是解除请求。 */
const RESCIND_TIME = /^(?:后|之后|以后|前|之前|时|期间|之日)/;
const NOT_RESCIND = /劳动|聘用|解除(?:查封|冻结|扣押|保全|抵押|质押|限制|婚姻|收养)/;
/** 部分解除、其余继续履行（研究 C4 的边界）。 */
const PARTIAL = /部分|其余|剩余|其他|第[一二三四五六七八九十\d]+(?:批|期|笔)|订单/;
/** 确认合同无效、撤销合同（民法典第一百五十七条）。只认合同整体：确认某一条款无效、确认解除通知无效不算。 */
const INVALID = /确认([^，。；]{0,30}?)《[^》]{1,40}?(?:合同|协议|契约)[^》]{0,12}》(?:为|系)?(?:自始)?无效|确认([^，。；]{0,24}?)(?:合同|协议)(?:为|系)?(?:自始)?无效|撤销(?:原告与被告|原被告|双方)?[^，。；《]{0,20}?《[^》]{1,40}?(?:合同|协议)[^》]{0,12}》|宣告[^，。；]{0,30}?(?:合同|协议)》?(?:为)?无效/;
const INVALID_NOT_WHOLE = /解除|通知|行为|条款|决定|第[^条]{1,6}条|判决|裁定|裁决|调解书/;
/** 违约责任、侵权责任（民法典第一百八十六条竞合，只认请求里明写两种责任的）。 */
const BREACH_RESP = /违约责任/;
const TORT_RESP = /侵权(?:责任|损害赔偿|赔偿责任)/;
/** 惩罚性赔偿（三倍、十倍、退一赔三）。 */
const PUNITIVE = /惩罚性赔偿|退一赔(?:三|十|3|10)|(?:三|3|十|10)倍(?:的)?赔偿|(?:价款|货款|损失|服务费用?|费用|购房款|房款|购车款)的?(?:三|3|十|10)倍/;
const PUNITIVE_MENTION = /惩罚性|(?:三|十|3|10)倍|退一赔/;
const ARTICLE_CITE = /第[一二三四五六七八九十百千零〇两\d]+条/;
/** 违法解除、终止劳动合同赔偿金（劳动合同法第八十七条，经济补偿标准的二倍）；“加付赔偿金”（第八十五条）不算。 */
const COMP_2N = /违法(?:解除|终止)[^，。；]{0,14}?赔偿金|(?:解除|终止)劳动(?:合同|关系)(?:的)?赔偿金/;
/** 经济补偿（劳动合同法第四十六条、第四十七条）。写成赔偿金计算口径的（“经济补偿标准的二倍”）、竞业限制经济补偿不算。 */
const COMP_N = /经济补偿(?:金)?(?!(?:的)?(?:标准|二倍|2倍|两倍|计算|年限|基数|月数|为基数|×|x|\*))/;
const COMP_N_JOINED = /(?:及|和|并|、|以及|并支付|另行支付|另支付)(?:解除劳动合同的?)?经济补偿/;
/** 恢复劳动关系、继续履行劳动合同、撤销解除决定（劳动合同法第四十八条）。 */
const REINSTATE = /恢复(?:[^，。；]{0,16}?的|双方的?|原)?劳动(?:关系|合同)|恢复(?:原)?工作岗位|继续履行(?:[^，。；]{0,16}?的|双方(?:签订的|之间的)?|原)?(?:劳动合同|劳动关系)|撤销[^，。；]{0,12}?解除劳动(?:合同|关系)(?:的)?(?:决定|通知)/;

type Cat = "deposit" | "penalty" | "depositLike" | "moneyPenalty" | "interest" | "perform" | "rescind" | "invalid" | "breachResp" | "tortResp" | "punitive" | "comp2n" | "compN" | "reinstate";

interface Item {
  where: string;
  text: string;
  tags: Partial<Record<Cat, RegExpMatchArray>>;
}

/** 字样所在分句（上一个逗号、分号、冒号之后）到字样之前的文字。 */
function clauseBefore(t: string, at: number): string {
  let i = at - 1;
  while (i >= 0 && !"，,。；;：:".includes(t[i]!)) i--;
  return t.slice(i + 1, at);
}

/** 字样之后到本分句结束的文字。 */
function clauseAfter(t: string, end: number): string {
  let i = end;
  while (i < t.length && !"，,。；;".includes(t[i]!)) i++;
  return t.slice(end, i);
}

/** 第一处不在否定语境里、又满足 ok 的命中。 */
function find(t: string, re: RegExp, ok?: (m: RegExpMatchArray) => boolean): RegExpMatchArray | null {
  for (const m of t.matchAll(new RegExp(re.source, "g"))) {
    if (NEG.test(clauseBefore(t, m.index!))) continue;
    if (ok && !ok(m)) continue;
    return m;
  }
  return null;
}

function tagItem(where: string, raw: string): Item {
  // 执行阶段的“迟延履行期间的债务利息”换成等长空白再识别，下标与原文一致，片段仍取原文
  const text = raw.replace(ENFORCEMENT_INTEREST, (s) => "　".repeat(s.length));
  const tags: Item["tags"] = {};
  const set = (c: Cat, m: RegExpMatchArray | null) => {
    if (m) tags[c] = m;
  };
  set("deposit", find(text, DEPOSIT));
  set("penalty", find(text, PENALTY));
  // “返还保证金并双倍返还定金”“双倍返还定金及保证金”是定金加倍，不是保证金加倍
  if (!DEPOSIT_NATURE.test(text)) set("depositLike", find(text, DEPOSIT_LIKE, (m) => !/定金/.test(m[0]) && !/^(?:的|其)?(?:已付|已交付|所收|收取的)?定金/.test(text.slice(m.index! + m[0].length))));
  set("moneyPenalty", find(text, MONEY_PENALTY) ?? (DEBT_WORD.test(text) && !NOT_MONEY.test(text) ? find(text, PENALTY) : null));
  set("interest", find(text, INTEREST));
  set("perform", find(text, PERFORM, (m) => !LABOR_OBJ.test(text.slice(m.index! + m[0].length, m.index! + m[0].length + 16))));
  // 劳动合同的解除看前面几个字（“劳动合同于9月4日解除”的命中从“合同”起）
  set("rescind", find(text, RESCIND, (m) => !NOT_RESCIND.test(text.slice(Math.max(0, m.index! - 4), m.index! + m[0].length)) && !RESCIND_VOID.test(clauseAfter(text, m.index! + m[0].length)) && !RESCIND_TIME.test(text.slice(m.index! + m[0].length))));
  set("invalid", find(text, INVALID, (m) => !INVALID_NOT_WHOLE.test(m[1] ?? m[2] ?? "") && !/判决|裁定|裁决|调解书/.test(m[0])));
  set("breachResp", find(text, BREACH_RESP));
  set("tortResp", find(text, TORT_RESP));
  set("punitive", find(text, PUNITIVE));
  const c2n = find(text, COMP_2N, (m) => !/加付/.test(m[0]));
  set("comp2n", c2n);
  // 同一项里既写赔偿金又写经济补偿的，只有用“及、并、另行支付”连着另提一笔经济补偿才算（否则多半是赔偿金的计算口径）
  set("compN", find(text, COMP_N, (m) => !/竞业/.test(clauseBefore(text, m.index!) + text.slice(Math.max(0, m.index! - 8), m.index!)) && (!c2n || COMP_N_JOINED.test(text.slice(Math.max(0, m.index! - 12), m.index! + m[0].length)))));
  set("reinstate", find(text, REINSTATE));
  return { where, text: raw, tags };
}

/** 文书里的请求节（可能不止一个：本诉、反诉）。每节是连续的段落。 */
function requestBlocks(paras: readonly Para[], type: DocType): Para[][] {
  const blocks: Para[][] = [];
  let cur: Para[] | null = null;
  let listOnly = false;
  const close = () => {
    if (cur && cur.length > 0) blocks.push(cur);
    cur = null;
    listOnly = false;
  };
  for (const p of paras) {
    const where = String(p?.where ?? "");
    const text = String(p?.text ?? "").trim();
    if (!text || where === "标题") continue;
    if (/表头$|表格第\s*\d+\s*行$/.test(where)) continue;
    const head = REQ_HEAD.exec(text);
    if (head) {
      close();
      cur = [];
      const rest = (head[1] ?? "").trim();
      if (rest) cur.push({ where, text: rest });
      continue;
    }
    if (cur) {
      if (/（标题）$/.test(where) || END_PARA.test(text) || (listOnly && !ITEM_START.test(text))) {
        close();
        continue;
      }
      (cur as Para[]).push({ where, text });
      if ((cur as Para[]).length >= 30) close();
      continue;
    }
    if (type === "letter" && LETTER_LEAD.test(text)) {
      cur = [];
      listOnly = true;
    }
  }
  close();
  return blocks;
}

/** 请求节拆成单项请求（有序号的）与说明段（“以上合计……”“上述第2、3项择一主张”）；整节都没序号的，每段算一项。 */
function itemsOf(block: readonly Para[]): { items: Item[]; notes: string[] } {
  const segs: { where: string; text: string; numbered: boolean }[] = [];
  for (const p of block) {
    for (const s of p.text.split(ITEM_SPLIT)) {
      const t = s.trim();
      if (t) segs.push({ where: p.where, text: t, numbered: ITEM_START.test(t) });
    }
  }
  const numbered = segs.some((s) => s.numbered);
  return {
    items: segs.filter((s) => !numbered || s.numbered).map((s) => tagItem(s.where, s.text)),
    notes: numbered ? segs.filter((s) => !s.numbered).map((s) => s.text) : [],
  };
}

function hasAlt(t: string): boolean {
  return ALT.test(t.replace(ALT_MASK, ""));
}

/** 两项请求里的合同名称（书名号）都写了、又没有一个相同的：指向不同合同，不按同一合同判。 */
function differentContracts(a: string, b: string): boolean {
  const names = (t: string) => new Set([...t.matchAll(/《([^》]{1,40})》/g)].map((m) => m[1]!));
  const x = names(a);
  const y = names(b);
  return x.size > 0 && y.size > 0 && ![...x].some((n) => y.has(n));
}

/** 请求里点名的具体当事人（多被告、第三人）。 */
const PARTY = /被告[一二三四五六\d甲乙丙丁]|第[一二三四五六]被告|被申请人[一二三四五六\d]|第[一二三四五六]被申请人|第三人|案外人/g;

/** 两项请求点名了不同的具体当事人（如向卖方主张违约责任、向生产者主张侵权责任）：不是同一责任，不按择一判。 */
function differentParties(a: string, b: string): boolean {
  const x = new Set(a.match(PARTY) ?? []);
  const y = new Set(b.match(PARTY) ?? []);
  return (x.size > 0 || y.size > 0) && ![...x].some((n) => y.has(n));
}

/** 确认无效、撤销的是他人之间的合同（一房二卖确认被告与第三人的合同无效、债权人撤销权）：与本方合同的违约金、继续履行不矛盾。 */
function othersContract(t: string): boolean {
  return /第三人|案外人|被告[一二三四五六\d甲乙丙丁]|第[一二三四五六]被告|被申请人[一二三四五六\d]/.test(t) && !/原告|(?<!被)申请人|上诉人|我方|双方/.test(t);
}

/** 计算基数（“以 310,000.00 元为基数”）。 */
function bases(t: string): Set<string> {
  return new Set([...t.matchAll(/以(?:人民币)?\s*([\d,，]+(?:\.\d+)?)\s*(万)?元?(?:为|作为)(?:计算)?基数/g)].map((m) => String(Number(m[1]!.replace(/[,，]/g, "")) * (m[2] ? 10000 : 1))));
}

/** 计息期间（取最早的“自……起”到最晚的“至……”；写“至实际清偿之日”或没写止日的算到无穷）。 */
function period(t: string): [number, number] | null {
  const day = (y: string, m: string, d: string) => Date.UTC(Number(y), Number(m) - 1, Number(d));
  const starts = [...t.matchAll(/自\s*(\d{4})年(\d{1,2})月(\d{1,2})日/g)].map((m) => day(m[1]!, m[2]!, m[3]!));
  if (starts.length === 0) return null;
  const ends = [...t.matchAll(/(?:至|到)\s*(\d{4})年(\d{1,2})月(\d{1,2})日/g)].map((m) => day(m[1]!, m[2]!, m[3]!));
  const open = /至(?:实际)?(?:清偿|付清|给付|支付|履行)[^，。；]{0,6}?之?日|至(?:款项)?(?:全部)?(?:付清|清偿)/.test(t);
  return [Math.min(...starts), open || ends.length === 0 ? Infinity : Math.max(...ends)];
}

function around(t: string, m: RegExpMatchArray, budget: number): string {
  const at = m.index ?? 0;
  const len = m[0].length;
  if (len >= budget) return t.slice(at, at + budget);
  const s = Math.max(0, Math.min(at - Math.floor((budget - len) / 2), t.length - budget));
  return t.slice(s, s + budget);
}

/** 原文片段（至多 60 字）：同一项里取两处字样之间；不同项各取 29 字，用“……”连接。 */
function pairText(x: Item, mx: RegExpMatchArray, y: Item, my: RegExpMatchArray): string {
  if (x === y) {
    const s = Math.min(mx.index!, my.index!);
    const e = Math.max(mx.index! + mx[0].length, my.index! + my[0].length);
    if (e - s > 60) return `${around(x.text, mx, 29)}……${around(x.text, my, 29)}`;
    const st = Math.max(0, Math.min(s - Math.floor((60 - (e - s)) / 2), x.text.length - 60));
    return x.text.slice(st, st + 60);
  }
  return `${around(x.text, mx, 29)}……${around(y.text, my, 29)}`;
}

interface Ctx {
  items: Item[];
  notes: string[];
  loan: boolean;
  punitiveBasis: boolean;
}

interface Rule {
  id: string;
  /** 函件也查（只开误报最低的四条）。 */
  letter: boolean;
  a: Cat;
  b: Cat;
  fix: string;
  /** 这对请求另有不报的理由（部分解除、不同合同、不同基数或期间）。 */
  skip?: (x: Item, y: Item, ctx: Ctx) => boolean;
  /** 整条规则不适用（借贷案件不查 C11）。 */
  off?: (ctx: Ctx) => boolean;
}

/**
 * 成对规则（a 与 b 两类请求同时出现，且没写择一、备位的报）。依据均为法规库原文：
 * - C1 民法典第五百八十八条第一款“对方可以选择适用违约金或者定金条款”；第二款“定金不足以弥补……可以请求赔偿超过定金数额的损失”
 *   ——后者不是违约金，不触发；单倍“返还定金”不触发。
 * - C4 民法典第五百六十六条第一款“合同解除后，尚未履行的，终止履行”；部分解除、指向不同合同的不报。
 *   （同条第二款“合同因违约解除的，解除权人可以请求违约方承担违约责任”——解除与违约金、赔偿损失并用合法，不设规则，即 C6。）
 * - C7 民法典第一百五十七条（无效、被撤销后返还财产、折价补偿、赔偿损失）、第五百零七条（不影响的只有解决争议方法的条款）：
 *   确认合同无效（撤销合同）又请求违约金或继续履行，自相矛盾；写了“如合同被认定无效，则……”的备位不报。
 * - C9 民法典第一百八十六条“受损害方有权选择请求其承担违约责任或者侵权责任”：只在请求里明写两种责任时报。
 * - C11 非借贷案件，同一期间的逾期付款违约金与逾期利息（资金占用损失）：违约金低于损失的按民法典第五百八十五条第二款请求增加；
 *   买卖合同解释第十八条第四款，没有约定逾期付款违约金的才按 LPR 加计 30%～50% 计逾期付款损失。基数不同、期间不重叠的不报；
 *   借贷案件按民间借贷规定第二十九条可以一并主张，整条不查。
 * - C12 劳动合同法实施条例第二十五条“依照劳动合同法第八十七条的规定支付了赔偿金的，不再支付经济补偿”。
 * - C13 劳动合同法第四十八条：劳动者要求继续履行的应当继续履行；不要求或者不能继续履行的，依照第八十七条支付赔偿金。
 * 迟延履行违约金与继续履行并用合法（民法典第五百八十五条第三款“违约方支付违约金后，还应当履行债务”），不设规则，即 C5。
 */
const PAIR_RULES: readonly Rule[] = [
  {
    id: "C1",
    letter: true,
    a: "deposit",
    b: "penalty",
    fix: "定金与违约金只能选择适用（民法典第五百八十八条第一款）：两项请求留一项，或写明择一、先位备位（如“如第X项不予支持，则请求……”）；定金不足以弥补损失的，另行请求的是超过定金数额的损失（同条第二款），不是违约金",
  },
  {
    id: "C4",
    letter: true,
    a: "rescind",
    b: "perform",
    fix: "合同解除后尚未履行的终止履行（民法典第五百六十六条第一款），同一合同不能既请求解除又请求继续履行：两项留一项，或写明先位备位；只解除部分订单、批次的，在请求里写明解除范围（解除后请求违约金、赔偿损失可以并用，不用改）",
    skip: (x, y) => PARTIAL.test(x.text) || PARTIAL.test(y.text) || differentContracts(x.text, y.text),
  },
  {
    id: "C7",
    letter: false,
    a: "invalid",
    b: "penalty",
    fix: "合同无效、被撤销后按返还财产、折价补偿、赔偿损失处理（民法典第一百五十七条），违约金条款随之不适用（第五百零七条只保留解决争议方法的条款）：改为无效后果的请求，或写明先位备位（如“如合同被认定无效，则请求……”）",
    skip: (x, y) => differentContracts(x.text, y.text) || othersContract(x.text),
  },
  {
    id: "C7",
    letter: false,
    a: "invalid",
    b: "perform",
    fix: "合同无效、被撤销后按返还财产、折价补偿、赔偿损失处理（民法典第一百五十七条），不能同时请求继续履行：两项留一项，或写明先位备位（如“先位请求继续履行；如合同被认定无效，则请求返还……”）",
    skip: (x, y) => differentContracts(x.text, y.text) || othersContract(x.text),
  },
  {
    id: "C9",
    letter: false,
    a: "breachResp",
    b: "tortResp",
    fix: "违约与侵权竞合的，受损害方只能选择请求一种责任（民法典第一百八十六条）：请求里选定一种并统一依据，或写明先位备位",
  },
  {
    id: "C11",
    letter: false,
    a: "moneyPenalty",
    b: "interest",
    fix: "非借贷案件同一期间的逾期付款违约金与逾期利息（资金占用损失）弥补的是同一损失，只主张一项：约定了违约金的按违约金主张、低于损失的请求增加（民法典第五百八十五条第二款），没约定的才按 LPR 加计主张逾期付款损失（买卖合同解释第十八条第四款）；两项基数或期间不同的，在请求里分别写明",
    off: (ctx) => ctx.loan,
    skip: (x, y) => {
      if (x === y) return false;
      const bx = bases(x.text);
      const by = bases(y.text);
      if (bx.size > 0 && by.size > 0 && ![...bx].some((b) => by.has(b))) return true;
      const px = period(x.text);
      const py = period(y.text);
      return !!px && !!py && (px[1] < py[0] || py[1] < px[0]);
    },
  },
  {
    id: "C12",
    letter: true,
    a: "comp2n",
    b: "compN",
    fix: "支付了违法解除赔偿金的不再支付经济补偿（劳动合同法实施条例第二十五条；赔偿金按劳动合同法第八十七条为经济补偿标准的二倍）：两项留一项，或写明先位备位（如“如解除被认定合法，则请求支付经济补偿”）",
  },
  {
    id: "C13",
    letter: true,
    a: "reinstate",
    b: "comp2n",
    fix: "劳动者要求继续履行劳动合同的应当继续履行，不要求或者不能继续履行的才支付赔偿金（劳动合同法第四十八条、第八十七条）：恢复劳动关系与违法解除赔偿金二选一，或写明“如劳动合同不能继续履行，则请求支付赔偿金”",
  },
];

/** C2 订金、押金、保证金主张双倍返还（合同编通则解释第六十七条第一款：没有约定定金性质的，主张定金罚则不予支持）。 */
const DEPOSIT_LIKE_FIX = "订金、押金、保证金等没有约定定金性质的不适用定金罚则（合同编通则解释第六十七条第一款）：核对合同是否约定了定金性质——约定了的写“定金”并写明约定条款，没约定的改为请求返还该款项";
/** C14 惩罚性赔偿须有法律明文（民法典第一百七十九条第二款“法律规定惩罚性赔偿的，依照其规定”）。 */
const PUNITIVE_FIX = "惩罚性赔偿须有法律明文规定（民法典第一百七十九条第二款）：在请求或事实与理由里写明所依条文（如民法典第一千一百八十五条、第一千二百零七条、第一千二百三十二条；消费者权益保护法、食品安全法的条文法规库未收录，须核对原文），找不到法定依据的删去该项";

function pairOf(ctx: Ctx, r: Rule): { x: Item; y: Item } | null {
  for (const x of ctx.items) {
    if (!x.tags[r.a]) continue;
    for (const y of ctx.items) {
      if (!y.tags[r.b]) continue;
      if (x !== y && differentParties(x.text, y.text)) continue;
      if (r.skip?.(x, y, ctx)) continue;
      if (hasAlt(x.text) || hasAlt(y.text) || ctx.notes.some(hasAlt)) continue;
      return { x, y };
    }
  }
  return null;
}

export function claimsConsistencyIssues(title: string, paras: readonly { where: string; text: string }[]): ClaimsIssue[] {
  const type = docType(title);
  if (!type) return [];
  const blocks = requestBlocks(paras, type);
  if (blocks.length === 0) return [];
  const all = [String(title ?? ""), ...paras.map((p) => String(p?.text ?? ""))].join("\n");
  const loan = LOAN.test(all);
  // 惩罚性赔偿的法定依据：文书任一段同时提到惩罚性赔偿（三倍、十倍）又写了条号的，视为写了依据（是否满足要件、条文对不对交律师与引用核验）
  const punitiveBasis = paras.some((p) => p.where !== "标题" && PUNITIVE_MENTION.test(String(p?.text ?? "")) && ARTICLE_CITE.test(String(p?.text ?? "")));
  const out: ClaimsIssue[] = [];
  const done = new Set<string>();
  for (const block of blocks) {
    const { items, notes } = itemsOf(block);
    const ctx: Ctx = { items, notes, loan, punitiveBasis };
    for (const r of PAIR_RULES) {
      if (done.has(r.id) || (type === "letter" && !r.letter) || r.off?.(ctx)) continue;
      const hit = pairOf(ctx, r);
      if (!hit) continue;
      done.add(r.id);
      // 按请求的先后写位置与片段
      const a = { item: hit.x, m: hit.x.tags[r.a]! };
      const b = { item: hit.y, m: hit.y.tags[r.b]! };
      const [p, q] = items.indexOf(a.item) <= items.indexOf(b.item) ? [a, b] : [b, a];
      const where = p.item.where === q.item.where ? p.item.where : `${p.item.where}、${q.item.where}`;
      out.push({ kind: "claims", where, text: pairText(p.item, p.m, q.item, q.m), fix: r.fix });
    }
    if (type !== "filing") continue;
    if (!done.has("C2")) {
      const x = items.find((i) => i.tags.depositLike);
      if (x) {
        done.add("C2");
        out.push({ kind: "claims", where: x.where, text: around(x.text, x.tags.depositLike!, 60), fix: DEPOSIT_LIKE_FIX });
      }
    }
    if (!done.has("C14") && !punitiveBasis) {
      const x = items.find((i) => i.tags.punitive);
      if (x) {
        done.add("C14");
        out.push({ kind: "claims", where: x.where, text: around(x.text, x.tags.punitive!, 60), fix: PUNITIVE_FIX });
      }
    }
  }
  return out;
}
