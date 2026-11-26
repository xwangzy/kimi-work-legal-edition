/**
 * 业务场景目录（用户拍板：首页按律师业务线组织——诉讼仲裁 / 非诉 / 企业法务；历史 Demo 融合方案 §4.2 首页 15 张卡、§4.4 保留字段；
 * UIUX 评审 P0-2 意图建议）。
 *
 * 场景是入口，方法是 Skill：同一方法在不同业务线用不同卡名与默认口径。每张卡写清“你给什么 → 你得到什么”。
 *
 * 开工前收什么（第 55 批改，原则取代“只留 ≤ 3 个字段，其余由 Agent 追问”）：原来起草起诉状只收“拟受理法院”，案情、诉讼请求、
 * 当事人信息都没有入口，助手要先把空事项读一遍再回头问，律师白等几分钟（真实基线：空事项 2 分 10 秒后拿合同违约的条文去套著作权侵权案）。
 *  1. 律师开工前就知道、又决定文书怎么写的，开始面板直接收：案情（没有材料时）、逐项请求、不可逆期限的起算日、只有律师能定的取舍；
 *  2. 读完材料才知道的（材料之间的矛盾、合同里几种计息口径取哪种）才在任务中问，并且和论点确认并成一次；
 *  3. 事项里已有的（立场、当事人名称、阶段、事件时点）不重复收；
 *  4. 不给每张卡堆大表单：必填项与两三个高频项直接显示，其余收进“更多选项”。
 * 档位如实标注：所有场景都还没有通过法律质量门槛，统一为“试用”（结果是草稿，须律师复核）。
 */

export type BusinessLine = "litigation" | "transactional" | "inhouse";

export const LINE_LABELS: Record<BusinessLine, string> = { litigation: "诉讼仲裁", transactional: "非诉", inhouse: "企业法务" };

export interface ScenarioField {
  key: string;
  label: string;
  /**
   * long：多行文字（V10 第 36 批：律师贴进来的逐条修改意见、问题常有好几段，单行输入框看不全也不好改）。
   * list：逐项填写（第 55 批：诉讼请求、仲裁请求一项一行，可增删；拼进任务说明时自动编号）。值是 string[]。
   */
  kind: "select" | "text" | "long" | "date" | "multi" | "list";
  options?: string[];
  /**
   * 选项 → 拼进任务说明的话（V16 F4）：没有这一项时直接拼选项原文；对应空串的选项让这一句整句省略（与空字段同一机制）。
   */
  goalText?: Record<string, string>;
  placeholder?: string;
  required?: boolean;
  /** 选了某个选项时改用别的卡（第 26 批）：选项 → 卡 id 与一句说明；开始面板据此提示并给“改用”按钮。 */
  redirect?: Record<string, { card: string; text: string }>;
  /** 只拼进任务说明、不作为方法参数（第 55 批）：长文字与逐项请求——方法参数每项至多 300 字，放进去会被截断，助手会看到一份完整、一份截断的同一段话。 */
  goalOnly?: boolean;
  /** 收进“更多选项”（第 55 批）：不是每次都要定的事；填过的自动展开。 */
  more?: boolean;
  /** 输入框下面的一句说明（第 55 批）：怎么填、不填会怎样。 */
  help?: string;
}

/**
 * 案情入口（第 55 批）：这张卡可以由律师直接写案情——没有材料也能开始。
 * 写下的内容存成本事项的一份材料《案情说明（律师口述）日期.txt》（用途“我方”），助手按“律师陈述、待确认”对待，后面的任务可以接着用。
 * 没有材料、事项里也没有事实时必须写（否则助手只能凭事项名称猜）；有材料时是可选的“材料里没有的情况”。
 */
export interface ScenarioBrief {
  label: string;
  placeholder: string;
}

export interface ScenarioCard {
  id: string;
  line: BusinessLine;
  title: string;
  /** 你给什么（材料要求）。 */
  gives: string;
  /** 你得到什么（交付件）。 */
  gets: string[];
  /** 发起方式：确定性工作流场景，或 Agent + 方法模板。 */
  scenario: "a1.agent_task" | "s1b.draft_compare" | "s2.case_file" | "s6.redaction";
  skill?: string;
  /** 主按钮动词（“开始审查”“开始整理”……）。 */
  verb: string;
  /** 任务说明模板：{字段} 按律师填写替换；空字段整句省略。 */
  goal: string;
  fields: ScenarioField[];
  /** 需要材料的最少份数（0 = 可无材料）。 */
  minMaterials: number;
  /** 可以直接写案情（见 ScenarioBrief）。 */
  brief?: ScenarioBrief;
  /**
   * 材料不齐时能否“先开始，缺的稍后补”（Z3 评审 #4）：只有起草类与整理访谈这几张卡可以；审合同等“没有材料就没法做”的卡不行。
   * 只对 Agent 场景生效（确定性流程须选够材料）。
   */
  allowPartial?: boolean;
  /** “这个方法会怎么做”（折叠显示）。 */
  steps: string[];
  /** 意图建议的关键词（命中即建议；词组内全部出现才算）。 */
  intents: string[][];
  /** 命中这些词时不建议本卡（方法模板明确不支持的情形，例如答辩状卡不接二审、仲裁、行政、劳动答辩；复核 RB16B-16）。 */
  notFor?: string[];
  /** 三条业务线都常用（v9.4 S1 §5.5）：首页放在业务线卡片下方的“通用”一行，不在每条线各复制一张。line 仍用于挑默认事项。 */
  general?: boolean;
  /**
   * 本卡的主交付物（第 29 批）：方法前言 outputs 里的一项，缺省为第一项。同一方法的不同卡交付不同时写明（尽调“发现与报告”的主交付物是报告，不是清单），
   * 内核据此核对任务有没有交出这份文书，没有就不记“完成”。
   */
  primary?: string;
  /**
   * 主交付物随律师选的字段变（第 31 批）：例如“修订说明”选“致对方”时主交付物是致对方版，“全体股东书面决定”不开会、没有会议通知。
   * 选项不在 map 里时用 primary（或方法 outputs 第一项）。
   */
  primaryBy?: { field: string; map: Record<string, string> };
  /** 卡片固定的方法参数（v9.4：同一方法的不同卡，例如劳动争议的“仲裁应对 / 解除前评估”）；与律师填写的字段一起作为方法参数传给 Agent。 */
  args?: Record<string, string>;
  /**
   * 这份文书要写当事人身份首部（D-224）：法定首部（起诉状、答辩状、上诉状、仲裁申请书、保全、执行、劳动仲裁申请书与答辩书）
   * 与惯例首部（律师函、合同、决议、代理词）。开始面板显示本事项《当事人信息（律师填写）》已填 / 未填，发起时自动计入可读材料。
   */
  needsParties?: boolean;
}

/** 要写当事人身份首部的卡（D-224，证据报告 D2 第 4 题逐张核对）。用例核对它与卡片上的 needsParties 一致。 */
export const NEEDS_PARTIES_CARDS = [
  "pleading",
  "defense",
  "appeal",
  "arbitration-app",
  "preservation",
  "enforcement",
  "labor-arb-application",
  "labor-arb-defense-lit",
  "labor-arb-defense",
  "demand-lit",
  "demand-inhouse",
  "contract-draft",
  "corporate-resolutions",
  "agency",
] as const;

/**
 * 即将推出（v9.4 第 20 批；评审 S1 §5.1 第 4 条：没有方法的业务不挂到相近的方法上，宁可灰显）。只展示、不能发起。
 * v9.4 第 21 批：原来灰显的八项（上诉状、仲裁申请书、庭审提纲、财产保全申请、强制执行申请、股东会与董事会文件、交割清单、规章制度审查）
 * 都有了自己的方法与场景卡，清空；首页与“方法与模板”页在为空时不显示这一行或分区。以后再有没有方法的业务，照样加在这里。
 */
export const COMING_SOON: readonly { line: BusinessLine; title: string }[] = [];

/** 卡片上的交付件一行（v9.4）：去掉扩展名与括注，用“ · ”连接；完整名称在开始面板与 aria-label 里。 */
export function cardGets(c: Pick<ScenarioCard, "gets">): string {
  return c.gets.map((g) => g.replace(/（[^）]*）/g, "").replace(/\.(docx|xlsx|pptx|md|pdf)\b/gi, "").trim()).filter(Boolean).join(" · ");
}

/** 交付件的律师写法（第 26 批，评审 U2-26②）：去掉扩展名，保留括注（开始面板、意图建议、输入框菜单用）。 */
export function getsPlain(c: Pick<ScenarioCard, "gets">): string[] {
  return c.gets.map((g) => g.replace(/\.(docx|xlsx|pptx|md|pdf)\b/gi, "").trim()).filter(Boolean);
}

/** 卡片上的“需要”一行（v9.4）：去掉括注里的先后顺序说明（开始面板里有）。 */
export function cardGives(c: Pick<ScenarioCard, "gives">): string {
  return c.gives.replace(/（[^）]*）/g, "").trim();
}

// 与 contract-review/references/contract-types.md 的十类一致（v9.4 合同审查补六类）；其他类型只按通用必查点审
const CONTRACT_TYPES = ["股权转让", "买卖", "服务 / 技术服务", "借款与担保", "租赁", "建设工程施工", "保密与竞业限制", "技术开发", "劳动合同（用人单位）", "投资协议（增资 / 股权收购）", "其他（通用辅助）"];

/** 选项指向别的卡时的提示（第 26 批）：第一个命中的字段；没有命中返回 null。 */
export function fieldRedirect(card: Pick<ScenarioCard, "fields">, values: Record<string, string | string[]>): { card: ScenarioCard; text: string } | null {
  for (const f of card.fields) {
    const v = values[f.key];
    const hit = typeof v === "string" ? f.redirect?.[v] : undefined;
    const to = hit ? SCENARIOS.find((c) => c.id === hit.card) : undefined;
    if (hit && to) return { card: to, text: hit.text };
  }
  return null;
}

/** 函件类型（与方法 demand-letter 的 references/letter-types.md 六类一致，第 26 批）。 */
const LETTER_TYPES = ["催款律师函", "履行催告函", "解除前催告函", "解除通知", "向保证人主张权利通知", "停止侵权函"];

/** 按文件名与事项名预选合同类型的关键词（第 26 批）：先具体后宽泛；猜不出不选，律师自己选。 */
const CONTRACT_TYPE_HINTS: [RegExp, string][] = [
  [/增资|投资协议|股权收购|认购协议/, "投资协议（增资 / 股权收购）"],
  [/股权转让|股份转让/, "股权转让"],
  [/保密协议|竞业/, "保密与竞业限制"],
  [/技术开发|软件开发|开发合同/, "技术开发"],
  [/劳动合同|聘用合同/, "劳动合同（用人单位）"],
  [/施工|建设工程|工程承包/, "建设工程施工"],
  [/借款|贷款|担保|保证合同|抵押|质押/, "借款与担保"],
  // SaaS、云服务、数据处理（第 34 批真实走查：“SaaS 订阅与数据处理协议”原先没有对应规则，被事项名里的“采购方”猜成买卖）
  [/SaaS|软件即服务|订阅服务|云服务|数据处理协议|委托处理|软件许可|系统服务/i, "服务 / 技术服务"],
  [/租赁|出租|承租/, "租赁"],
  [/采购|买卖|购销|供货|销售合同/, "买卖"],
  [/服务合同|服务协议|技术服务|委托合同|咨询/, "服务 / 技术服务"],
];

/**
 * 从所选合同的文件名（优先）、律师写的任务说明与事项名猜合同类型；都猜不出返回 null。
 * 事项名末尾括注的立场（“（采购方）”“（受让方）”）不参与——第 34 批：“……数据处理协议（采购方）”的“采购”被猜成买卖。
 */
export function guessContractType(filenames: readonly string[], matterTitle = "", request = ""): string | null {
  for (const text of [...filenames, request, matterTitle.replace(/[（(][^（()）]*[）)]\s*$/, "")]) {
    const hit = CONTRACT_TYPE_HINTS.find(([re]) => re.test(text));
    if (hit) return hit[1];
  }
  return null;
}

/** 案情入口的几种写法（第 55 批）。 */
const CASE_BRIEF: ScenarioBrief = { label: "案情经过", placeholder: "谁和谁、什么时候签了什么、我方做了什么、对方怎么违约、涉及多少钱、催过没有。想到哪写到哪，不用整理。" };
const INTERVIEW_BRIEF: ScenarioBrief = { label: "访谈要点", placeholder: "客户说了什么：当事人是谁、发生了什么、想达到什么结果、手里有哪些材料、有没有马上到期的期限。" };
const HEARING_BRIEF: ScenarioBrief = { label: "庭审要点", placeholder: "法庭归纳了哪些焦点、对方当庭说了什么、我方举了哪些证据、还有什么要庭后补充。没有笔录时写在这里。" };
const AMOUNT_BRIEF: ScenarioBrief = { label: "本金与付款情况", placeholder: "本金多少、什么时候到期、已经付了几笔（日期与金额）、合同约定的利率或违约金怎么写的。" };

/** 逐项请求（起诉状、仲裁申请书共用）：一项一行，金额没算好的写“待测算”。 */
const claimsField = (label: string, sample: string, help = "一项一行；金额没算好写“待测算”；可不填，起草前会问你"): ScenarioField => ({
  key: "claims",
  label,
  kind: "list",
  goalOnly: true,
  placeholder: sample,
  help,
});
/** 劳动关系要素（劳动三张卡共用）：补偿金、赔偿金、二倍工资都按这几项算；不填的助手从材料里找，找不到再问。 */
const LABOR_BASICS: ScenarioField[] = [
  { key: "hired_on", label: "入职日期", kind: "date" },
  { key: "left_on", label: "离职日期", kind: "date", help: "还在职的不填" },
  { key: "leave_type", label: "离职方式", kind: "select", options: ["被辞退", "协商解除", "主动辞职", "合同到期终止", "仍在职"] },
  { key: "monthly_wage", label: "月工资", kind: "text", placeholder: "例如：12,000 元", help: "离职前 12 个月的平均工资" },
];
const more = (f: ScenarioField): ScenarioField => ({ ...f, more: true });
/** 发函名义（两张函件卡共用）。 */
const SENDER: ScenarioField = { key: "sender", label: "发函名义", kind: "select", goalOnly: true, options: ["本所受委托发函", "当事人自己发函", "先问我"], more: true };

/*
 * 当事人信息（D-224）：原来起诉状、仲裁申请书两张卡各有一栏“当事人信息”自由文字，每份文书重填。现在改成事项里存一次的
 * 材料《当事人信息（律师填写）.txt》（lib/parties.ts），要写身份首部的卡标 needsParties，开始面板显示已填 / 未填并自动带入。
 */

export const SCENARIOS: ScenarioCard[] = [
  // ── 诉讼仲裁 ──
  {
    id: "casefile",
    line: "litigation",
    title: "整理案卷",
    gives: "起诉材料、证据、往来函件（可多份）",
    // 第一段（B-5）：在这台电脑上按规则整理，不调用 AI；争点矩阵只按你给的争点列框架，拆要件、挂证据接着做“争点与证据分析”
    // 与实际文件名一致（复核 R15B-17）
    gets: ["证据目录.xlsx", "事实时间轴.xlsx", "争点证据矩阵.xlsx（框架）", "补证清单.docx"],
    scenario: "s2.case_file",
    verb: "开始整理",
    goal: "",
    fields: [{ key: "issues", label: "已知争点", kind: "text", placeholder: "例如：货款是否已付清；违约金是否过高", help: "多个用“；”隔开；争点矩阵按它列框架" }],
    minMaterials: 1,
    steps: ["逐份读取材料，标出识别不全的页", "按时间整理日期、金额与主体（不调用 AI）", "列证据目录；争点矩阵按你给的争点列框架", "列出缺口与待补证据"],
    intents: [["证据", "目录"], ["证据", "清单"], ["整理", "证据"], ["整理", "案卷"], ["时间线"], ["时间轴"]],
    // 本机规则整理不调用 AI、不做分析与计算（第 34 批真实走查：“整理成证据目录，并写证据分析、说明能主张的本金和利息”被引到这张卡，
    // 分析与金额部分被静默丢掉）——请求里还要分析、计算、意见的不建议本卡，交给助手按描述编排
    notFor: ["分析", "能主张", "本金", "利息", "测算", "计算", "意见", "评估", "风险", "起草"],
  },
  // 整理案卷的 AI 精读版（v9.4 第 20 批，V9.4 主文 §3.2“精读版入口”）：本机规则版之外，逐份读、逐条提交带引文的事实给你确认
  {
    id: "casefile-deep",
    line: "litigation",
    title: "整理案卷（精读版）",
    gives: "起诉材料、证据、往来函件（可多份）",
    gets: ["案卷总目录.xlsx", "事实时间线.xlsx", "缺口清单.xlsx", "带引文的事实（待你确认）"],
    scenario: "a1.agent_task",
    skill: "casefile-organize",
    verb: "开始精读",
    goal: "请逐份精读本事项的案卷材料，编目、按时间整理事实（每条附原文）并列出缺口。时间线按“{perspective}”排列。案由或争议类型：{case_type}。",
    fields: [
      { key: "case_type", label: "案件类型", kind: "select", options: ["买卖合同", "借款与担保", "建设工程", "股权与公司", "劳动争议", "侵权", "知识产权", "其他"] },
      { key: "perspective", label: "时间线视角", kind: "text", placeholder: "例如：按付款线索", help: "不填按时间先后排", more: true }],
    minMaterials: 1,
    steps: ["列出全部材料与读取情况", "逐份阅读、编目，标出提供方与形成日期", "事实一事一行、附逐字引文，交你在“事实”里确认", "生成目录、时间线与缺口清单"],
    intents: [["精读", "案卷"], ["整理", "事实", "引文"]],
  },
  {
    id: "issues",
    line: "litigation",
    title: "争点与证据分析",
    gives: "案卷材料，或“整理案卷”的成果（事实未确认也能先做）",
    gets: ["争点—证据矩阵.xlsx", "补证清单"],
    scenario: "a1.agent_task",
    skill: "issue-evidence-matrix",
    verb: "开始分析",
    goal: "请梳理争点与证据：拟主张或需应对的请求为{claims}；我方诉讼地位：{side}；已知的对方抗辩：{defenses}。有我确认过的事实时只用确认的事实；还没有确认的，用材料载明的事实并标【未确认】，评估写“初步判断”。不评估胜诉率。",
    fields: [
      { key: "claims", label: "涉及的请求", kind: "text", required: true, placeholder: "例如：支付货款 120 万元及逾期利息", help: "我方要主张的，或要应对的对方请求" },
      { key: "side", label: "我方地位", kind: "select", options: ["原告 / 申请人", "被告 / 被申请人", "第三人"] },
      { key: "defenses", label: "已知的对方抗辩", kind: "text", placeholder: "例如：已付清；质量有问题；超过诉讼时效", more: true },
    ],
    minMaterials: 0,
    steps: ["先用你确认过的事实，未确认的标【未确认】", "按请求拆成要件，标出一般由哪一方举证", "事实与证据挂到要件下，标出薄弱与缺证", "列出对方可能的抗辩和补证动作"],
    intents: [["争点"], ["证据", "支撑"], ["补证"], ["要件"]],
  },
  // Z3 评审 §2.4、§8 P2 #28：诉讼线原来没有“案情分析 / 诉讼策略”，律师动笔写文书之前要先看清争点、证据强弱与风险
  {
    id: "case-analysis",
    line: "litigation",
    title: "案情分析与诉讼策略",
    gives: "案卷材料或“整理案卷”的成果；新案可直接写案情",
    gets: ["案情分析备忘录（内部稿）.docx"],
    scenario: "a1.agent_task",
    skill: "case-analysis",
    verb: "开始分析",
    goal: "请分析案情并提出诉讼策略建议：我方目标为{goal}；我方地位：{side}。未确认的事实请标出，不评估胜诉率。",
    fields: [
      { key: "goal", label: "我方目标", kind: "text", required: true, placeholder: "例如：追回货款 120 万元及违约金" },
      { key: "side", label: "我方地位", kind: "select", options: ["原告 / 申请人", "被告 / 被申请人", "第三人", "尚未起诉（我方拟起诉）", "尚未起诉（对方可能起诉）"] },
    ],
    // 第 55 批：新案常常只有口头案情——没有材料时可以直接写案情（原来至少要一份材料才能开始）
    minMaterials: 0,
    brief: CASE_BRIEF,
    steps: ["读材料与已整理的事实，未确认的标出", "归纳争点，逐个写出双方证据的强弱和理由", "列出诉讼风险与等级（只做定性，不给胜诉率）", "按优先级给出下一步：补证、程序、文书、发函"],
    // “诉讼风险”须同时说到案子本身（复核 RC-B-12：“审查这份合同的诉讼风险”是审合同；劳动争议走劳动仲裁应对）
    intents: [["案情", "分析"], ["诉讼策略"], ["怎么打"], ["案件", "诉讼", "风险"], ["起诉", "风险"], ["被诉", "风险"], ["案子", "风险"]],
    notFor: ["劳动", "审查这份", "审合同", "签了", "签订后"],
  },
  {
    id: "amount",
    line: "litigation",
    title: "金额测算",
    gives: "合同与付款记录；也可直接写本金与付款情况",
    gets: ["计算明细.xlsx"],
    scenario: "a1.agent_task",
    skill: "amount-calc",
    verb: "开始测算",
    // 第 27 批（评审 S3-07/S3-16）：方法新参数 mode——复核对方计算时对方原数与复算数并列，不改写对方请求
    goal: "请测算以下金额：{items}；模式：{mode}；计算截止日：{as_of}；利率口径：{rate}。",
    fields: [
      // 第 66 批（V40-C）：计算项目是唯一必填；模式不选时方法按“我方测算”（amount-calc 方法正文），利率口径缺省从合同里找、找不到先问
      { key: "items", label: "计算项目", kind: "multi", options: ["本金利息", "逾期违约金", "资金占用费", "劳动经济补偿（N / 2N）", "诉讼费用预估"], required: true },
      { key: "mode", label: "测算模式", kind: "select", options: ["我方测算", "复核对方计算"], help: "不选按“我方测算”" },
      { key: "as_of", label: "计算截止日", kind: "date" },
      { key: "rate", label: "利率口径", kind: "select", options: ["按合同约定", "LPR 加点", "LPR 倍数（如上浮 50%）", "待确认（先问我）"], help: "不选按合同约定，找不到会先问你", more: true },
    ],
    minMaterials: 0,
    // 第 55 批：“或直接告诉我本金与日期”原来没有地方写
    brief: AMOUNT_BRIEF,
    steps: ["从合同中找出计息约定（找不到会先问你）", "按本金变动分段，每段由计算工具算出", "列出抵扣、互斥项与调整风险", "生成可复算的计算明细表"],
    intents: [["利息"], ["违约金", "计算"], ["违约金", "算"], ["测算"], ["欠款", "多少"]],
  },
  // 第 65 批（V39，D-279）：诉讼成本与回收测算——客户问“打下来能拿回多少、值不值得打、给多少可以和解”（外部 billing-and-litigation-budget 的诉讼经济性分析，改为情景并列、不给概率）
  {
    id: "litigation-budget",
    line: "litigation",
    title: "诉讼成本与回收测算",
    gives: "起诉状或请求清单（或直接告诉我请求金额），委托合同、保全材料、和解提议有的一并勾选",
    gets: ["测算说明.docx（给客户或管理层，结论在前）", "诉讼成本与回收测算.xlsx（情景测算、费用明细、和解持平点）"],
    scenario: "a1.agent_task",
    skill: "litigation-budget",
    verb: "开始测算",
    goal: "请做诉讼成本与回收测算。我方是{side}；案件阶段：{stage}；律师费安排：{fee_arrangement}；拟比较的和解金额：{offer}；执行回收：{recovery}。按本案决定金额的争点设几个情景（法院支持哪几项、各支持多少），算出各情景的净回收或总支出、和解持平点与和解方案比较；不给胜诉率或期望值，和不和解由客户决定。",
    fields: [
      { key: "side", label: "我方是", kind: "select", options: ["原告 / 申请人", "被告 / 被申请人"], required: true },
      { key: "stage", label: "案件阶段", kind: "select", options: ["尚未起诉", "已立案，一审中", "一审判决后（考虑上诉）"], required: true },
      { key: "fee_arrangement", label: "我方律师费", kind: "text", placeholder: "例如：一审 3 万元、二审 2 万元；或基础费 1 万元 + 收回金额的 8%", help: "按委托合同写；不填的不估，测算里不计律师费并会提示。" },
      { key: "offer", label: "和解金额", kind: "text", placeholder: "例如：对方提出一次性付 28 万元", help: "对方提议或客户拟提的金额，可写几个；没有的只算持平点。" },
      { key: "recovery", label: "执行回收", kind: "select", options: ["已保全足额或对方明显有能力履行", "不确定（并列全部与一半）", "对方财产状况不好（并列全部、一半与收不回）"], goalText: { 已保全足额或对方明显有能力履行: "按全部收回测算", "不确定（并列全部与一半）": "并列全部收回与收回一半", "对方财产状况不好（并列全部、一半与收不回）": "并列全部收回、收回一半与收不回" }, more: true },
    ],
    minMaterials: 0,
    brief: CASE_BRIEF,
    steps: ["读请求、合同里的律师费与违约金约定、委托合同和保全材料", "按决定金额的争点设几个情景：法院支持哪几项、各支持多少", "诉讼费、保全费由工具按《诉讼费用交纳办法》算出，连同律师费算出各情景净额与和解持平点", "写测算说明：结论在前，写明假设与还缺的数，不给胜诉率"],
    intents: [["值不值得", "打"], ["诉讼", "成本"], ["能拿回", "多少"], ["和解", "底线"], ["要不要", "和解"], ["和解", "多少"], ["打官司", "花"], ["诉讼", "预算"], ["回收", "测算"]],
    notFor: ["工时", "账单", "律师费发票"],
  },
  {
    id: "pleading",
    line: "litigation",
    title: "起草起诉状",
    gives: "合同、往来函件、付款凭证等证据；没有材料可直接写案情",
    gets: ["民事起诉状（草稿）.docx", "证据目录.xlsx（附件）", "提交前核对清单.xlsx（附件）"],
    scenario: "a1.agent_task",
    skill: "pleading-draft",
    allowPartial: true,
    needsParties: true,
    verb: "开始起草",
    goal: "请起草民事起诉状。诉讼请求（按我列的顺序与取舍写）：{claims}。拟受理法院：{court}。管辖依据：{forum_basis}。财产保全：{preserve}。",
    // 第 35 批真实走查 R4：卡片自带的“补充要求”与面板通用的“补充要求（可选）”同名并列，律师写在哪栏都一样——只留通用栏
    // 第 55 批：补上案情、逐项诉讼请求、当事人信息、管辖依据与保全（原来只有“拟受理法院”一栏）
    fields: [
      claimsField("诉讼请求", "例如：判令被告支付货款 1,000,000 元"),
      { key: "court", label: "拟受理法院", kind: "text", placeholder: "例如：上海市浦东新区人民法院" },
      { key: "forum_basis", label: "管辖依据", kind: "select", options: ["协议管辖", "被告住所地", "合同履行地", "不动产所在地（专属）", "待核"], more: true },
      { key: "preserve", label: "财产保全", kind: "select", options: ["不申请", "同时申请", "先问我"], more: true },
    ],
    minMaterials: 0,
    brief: CASE_BRIEF,
    steps: ["确认过的事实与金额照写，未确认的写得保守", "写出诉讼请求、事实与理由", "核对引用的法条", "列出提交前核对清单（含待确认事项）"],
    // 模板只做民商事起诉状（复核 B3-B24）：答辩状另有卡（defense），仲裁申请书不引到这里
    // 第 28 批：带“起草”的说法更具体——“根据时间线起草起诉状”不再被同分的“整理案卷”抢走
    intents: [["起诉状"], ["起诉", "写"], ["起草", "起诉状"], ["写", "起诉状"]],
    notFor: ["改一下", "帮我改", "修改"],
  },
  // 诉讼线文书（v9.3 主文 §5.3）：答辩状、质证意见、代理词
  {
    id: "defense",
    line: "litigation",
    title: "起草答辩状",
    gives: "对方起诉状与证据、我方证据",
    gets: ["民事答辩状（草稿）.docx", "答辩要点与证据对照表.xlsx（附件）", "提交前核对清单.xlsx（附件）"],
    scenario: "a1.agent_task",
    skill: "defense-draft",
    needsParties: true,
    verb: "开始起草",
    goal: "请起草民事答辩状（一审）。收到起诉状副本的日期：{received_on}；被告在境内有无住所：{domicile}；总体意见：{stance}。拟提的程序抗辩与反诉：{procedural}。我确认过的事实照写；材料载明但我还没确认的，正文照材料写并注明证据、或用附条件写法，待确认事项列进提交前核对清单（正文不留【待确认】）；非填不可、材料没有的写【待填】，不要推测。",
    fields: [
      // 第 55 批：收到日期改必填——答辩期、管辖权异议的期限都从这一天起算，过了不可补
      { key: "received_on", label: "收到起诉状日期", kind: "date", required: true, help: "答辩期与管辖权异议期限从这天起算" },
      { key: "stance", label: "总体意见", kind: "select", options: ["全部不认可", "部分认可", "待确认（先问我）"] },
      // 只有律师能定、又会写进对外文书的取舍：开始时定下，不留到任务中途问
      { key: "procedural", label: "程序抗辩与反诉", kind: "multi", options: ["管辖权异议", "诉讼时效抗辩", "主体不适格", "反诉", "先问我"] },
      // 被告在境内没有住所的，答辩期为三十日（复核 RB16B-13）
      { key: "domicile", label: "被告境内住所", kind: "select", options: ["有", "没有（答辩期三十日）"], more: true },
    ],
    minMaterials: 1,
    steps: ["读起诉状，拆出每项诉讼请求与主张的事实", "提示：管辖权异议须在答辩期内、实体答辩前提出", "逐项写我方意见与理由，未确认的写得保守", "列出答辩期届满日、时效抗辩、反诉等核对项"],
    intents: [["答辩状"], ["答辩", "写"], ["准备", "答辩"], ["起草", "答辩状"], ["写", "答辩状"]],
    // 模板只做民商事一审答辩（复核 RB16B-16）
    notFor: ["二审", "上诉", "仲裁", "行政", "劳动", "再审", "员工"],
  },
  // v9.4 第 21 批：原“即将推出”的五项诉讼线文书转正（appeal-draft、arbitration-application、hearing-outline、preservation-application、enforcement-application）
  {
    id: "appeal",
    line: "litigation",
    title: "起草上诉状",
    gives: "一审判决书或裁定书；本案诉辩材料可一并勾选",
    gets: ["民事上诉状（草稿）.docx", "上诉理由与一审认定对照表.xlsx（附件）", "提交前核对清单.xlsx（附件）"],
    scenario: "a1.agent_task",
    skill: "appeal-draft",
    needsParties: true,
    verb: "开始起草",
    goal: "请起草民事上诉状（不服一审{ruling}）。判决书或裁定书的送达日期：{served_on}；上诉范围：{scope}；不服的判项：{disputed}；上诉请求：{appeal_claim}；上诉人在境内有无住所：{domicile}。我确认过的事实照写，材料载明但未确认的正文用附条件或保守写法、列进提交前核对清单（正文不留【待确认】），不预测二审结果。",
    fields: [
      { key: "ruling", label: "不服的是", kind: "select", options: ["判决", "裁定"], required: true },
      // 第 55 批：送达日期改必填——上诉期（判决十五日、裁定十日）从这一天起算，过了不可补
      { key: "served_on", label: "文书送达日期", kind: "date", required: true, help: "上诉期从这天起算：判决 15 日，裁定 10 日" },
      { key: "appeal_claim", label: "上诉请求", kind: "select", options: ["改判", "发回重审", "撤销原裁定", "先问我"] },
      // 第 66 批（V40-C）：上诉范围与不服的判项是一对，多数案件全部上诉，收进更多选项
      { key: "scope", label: "上诉范围", kind: "select", options: ["全部判项", "部分判项（先问我）"], more: true },
      { key: "disputed", label: "不服的判项", kind: "text", placeholder: "例如：第二项违约金、第四项诉讼费负担", help: "只对部分判项不服时写", more: true },
      { key: "domicile", label: "上诉人境内住所", kind: "select", options: ["有", "没有（上诉期三十日）"], more: true },
    ],
    minMaterials: 1,
    steps: ["拆出一审查明的事实、本院认为与判决主文", "先列对照表：逐处一审认定写错在哪里", "上诉请求与判项逐项对应，未确认的写得保守", "上诉期届满日由期限工具算出，列入核对清单"],
    intents: [["上诉状"], ["上诉", "写"], ["准备", "上诉"], ["提起", "上诉"], ["不服", "判决"], ["不服", "一审"], ["起草", "上诉状"]],
    // 方法只做一审判决、裁定的上诉：被上诉人答辩、再审、撤销仲裁裁决、行政与刑事不引过来
    notFor: ["被上诉人", "二审答辩", "再审", "仲裁裁决", "行政", "刑事"],
  },
  // 第 61 批（V35，D-265）：收到裁判文书后的研读与救济评估（外部评估 R2 legal-document-summarization：产品此前没有这一环）
  {
    id: "ruling-digest",
    line: "litigation",
    title: "裁判文书研读与上诉评估",
    gives: "收到的判决书、裁定书或仲裁裁决；诉辩材料可一并勾选",
    gets: ["裁判文书研读报告.docx", "判项与期限核对表.xlsx"],
    scenario: "a1.agent_task",
    skill: "ruling-digest",
    verb: "开始研读",
    goal: "请研读这份裁判文书，目的是{purpose}。我方在本案中是{side}；文书送达我方的日期：{served_on}。逐项拆出裁判结果并与我方请求对照，复算受理费，按法定期间算出上诉、申请撤销或申请执行等期限，梳理争点与裁判理由、核验所引条文；评估救济的理由强弱与成本，不预测二审结果。",
    fields: [
      { key: "purpose", label: "研读目的", kind: "select", options: ["上诉评估", "给客户汇报结果", "准备履行或申请执行"], goalText: { 上诉评估: "评估是否上诉（或申请撤销）", 给客户汇报结果: "给客户或管理层汇报结果", 准备履行或申请执行: "准备履行或申请执行" } },
      { key: "side", label: "我方地位", kind: "select", options: ["原告", "被告", "第三人", "申请人", "被申请人"] },
      { key: "served_on", label: "文书送达日期", kind: "date", help: "上诉等期限从这天起算；不填从送达回证里找" },
    ],
    minMaterials: 1,
    steps: ["拆出裁判结果与理由，判项与我方请求逐项对照", "用工具复算受理费、算出上诉等期限", "梳理争点与裁判理由，核验判决所引条文", "评估救济理由强弱、对方上诉点与成本"],
    intents: [["判决书"], ["裁定书"], ["仲裁裁决书"], ["判决", "出来"], ["研读", "判决"], ["要不要", "上诉"], ["是否", "上诉"], ["上诉", "评估"], ["判决", "汇报"]],
    notFor: ["起草上诉状", "写上诉状", "上诉状草稿"],
  },
  {
    id: "arbitration-app",
    line: "litigation",
    title: "起草仲裁申请书",
    gives: "含仲裁条款的合同、证据",
    gets: ["仲裁申请书（草稿）.docx", "证据目录.xlsx（附件）", "提交前核对清单.xlsx（附件）"],
    scenario: "a1.agent_task",
    skill: "arbitration-application",
    needsParties: true,
    verb: "开始起草",
    goal: "请起草商事仲裁申请书，先核对仲裁协议。仲裁机构：{institution}；仲裁请求（按我列的顺序与取舍写）：{claims}。我确认过的事实与金额照写，材料载明但未确认的正文用附条件或保守写法、列进提交前核对清单（正文不留【待确认】），仲裁规则与收费以我提供的机构文件为准。",
    fields: [
      claimsField("仲裁请求", "例如：裁决被申请人支付货款 500,000 元"),
      { key: "institution", label: "仲裁机构", kind: "text", placeholder: "例如：上海国际仲裁中心", help: "不填按合同仲裁条款认定" },
    ],
    minMaterials: 1,
    brief: CASE_BRIEF,
    steps: ["摘出仲裁条款，核对仲裁事项与选定机构", "仲裁请求与金额逐项单列，算不出的标待测算", "按时间顺序写事实与理由，每段注明证据", "列出提交前核对：规则与收费以你给的为准"],
    intents: [["仲裁申请书"], ["申请", "仲裁"], ["提起", "仲裁"], ["商事仲裁"], ["起草", "仲裁申请书"]],
    // 劳动仲裁另有方法；收到仲裁申请、仲裁答辩、撤销或执行裁决都不是起草申请书
    // “执行”只挡申请执行、执行裁决（复核 Q3 建议：“对方不执行合同，要申请仲裁”不该被挡）
    notFor: ["劳动", "员工", "收到", "答辩", "撤销", "申请执行", "执行裁决", "强制执行"],
  },
  {
    id: "hearing-outline",
    line: "litigation",
    title: "庭审提纲",
    gives: "诉辩文书与双方证据（缺几份也能先做，会标明缺什么）",
    gets: ["庭审提纲.docx", "举证质证顺序表.xlsx（附件）"],
    scenario: "a1.agent_task",
    skill: "hearing-outline",
    verb: "开始准备",
    goal: "请准备开庭用的庭审提纲（陈述要点、举证质证顺序、发问提纲、辩论要点），事实分清“律师确认”与“材料记载”，不预测庭审结果。开庭日期：{hearing_on}；程序：{procedure}；我方地位：{side}；争议焦点：{focus_points}。",
    fields: [
      { key: "side", label: "我方地位", kind: "select", options: ["原告 / 申请人", "被告 / 被申请人", "第三人", "上诉人", "被上诉人"], required: true },
      { key: "procedure", label: "程序", kind: "select", options: ["一审开庭", "二审开庭", "证据交换 / 庭前会议", "仲裁开庭"] },
      { key: "hearing_on", label: "开庭日期", kind: "date" },
      { key: "focus_points", label: "争议焦点", kind: "text", placeholder: "例如：货款是否已付清；违约金是否过高", help: "不填会和开庭信息一起问你一次" },
    ],
    minMaterials: 1,
    steps: ["按争点列我方主张、事实与证据", "排出举证顺序，写每份证据的证明目的", "对对方证据列质证要点；发问提纲不设诱导问题", "整理辩论要点和法庭可能问的问题（内部工作稿）"],
    intents: [["庭审提纲"], ["开庭", "提纲"], ["发问提纲"], ["开庭", "准备"], ["庭审", "准备"]],
    // 劳动仲裁开庭走劳动争议应对
    notFor: ["劳动"],
  },
  {
    id: "preservation",
    line: "litigation",
    title: "财产保全申请",
    gives: "诉讼或仲裁材料、你掌握的对方财产线索与担保安排",
    gets: ["财产保全申请书（草稿）.docx", "保全财产线索与担保核对表.xlsx（附件）"],
    scenario: "a1.agent_task",
    skill: "preservation-application",
    needsParties: true,
    verb: "开始起草",
    goal: "请起草财产保全申请书：保全阶段为{stage}；请求保全数额：{amount}；担保方式：{guarantee}。财产线索：{assets}。财产线索与担保只用我提供的，不联网查询对方财产。",
    fields: [
      { key: "stage", label: "保全阶段", kind: "select", options: ["诉前（尚未起诉或申请仲裁）", "诉讼中", "仲裁中", "判决生效后、执行前"], required: true },
      { key: "amount", label: "请求保全数额", kind: "text", placeholder: "例如：50 万元", help: "不填会先问你" },
      { key: "assets", label: "财产线索", kind: "long", goalOnly: true, placeholder: "例如：对方在某银行的基本户；名下一处厂房", help: "一条一行；只用你写的和材料里的，不联网查" },
      { key: "guarantee", label: "担保方式", kind: "select", options: ["保险公司保函", "现金担保", "财产担保", "第三人保证", "待定"], more: true },
    ],
    minMaterials: 1,
    steps: ["确认保全阶段、受理法院与请求保全数额", "写需要保全的理由，只写有证据的事实", "逐项列你给的财产线索与担保（不联网查）", "列出担保、诉前保全 30 日内起诉等提示"],
    intents: [["财产保全"], ["诉前保全"], ["申请", "保全"], ["保全", "申请书"], ["查封", "财产"], ["冻结", "账户"]],
    // 方法只做财产保全
    notFor: ["行为保全", "证据保全", "禁令"],
  },
  {
    id: "enforcement",
    line: "litigation",
    title: "强制执行申请",
    gives: "生效判决、裁定、调解书或仲裁裁决，及对方已付款记录",
    gets: ["强制执行申请书（草稿）.docx", "执行标的计算表.xlsx（含迟延履行利息）", "申请执行核对清单.xlsx（附件）"],
    scenario: "a1.agent_task",
    skill: "enforcement-application",
    needsParties: true,
    verb: "开始起草",
    goal: "请起草强制执行申请书，并计算执行标的（金额由计算工具算出，算不了的标待算）。法律文书生效日期：{effective_on}；文书规定的履行期限最后一日：{due_on}；对方已履行情况：{paid}。此前是否已保全：{preserved}。",
    fields: [
      // 第 26 批（评审 S2-17）：申请执行期间从履行期限最后一日起算（分期的从最后一期）
      // 第 55 批：改必填——申请执行的二年期间从这一天起算；第 66 批（V40-C）：放第一个，生效日期能从文书里读到，收进更多选项
      { key: "due_on", label: "履行期最后一日", kind: "date", required: true, help: "分期的写最后一期；申请执行期间从这天起算" },
      { key: "paid", label: "对方已履行情况", kind: "text", placeholder: "例如：2026 年 5 月付过 10 万元；没有付过" },
      { key: "effective_on", label: "文书生效日期", kind: "date", more: true },
      { key: "preserved", label: "此前是否已保全", kind: "select", options: ["已保全", "没有", "不清楚"], more: true },
    ],
    minMaterials: 1,
    steps: ["逐项摘出判决主文或裁决的给付内容", "申请执行期间（二年）届满日由期限工具计算", "扣除已履行部分，迟延履行利息由工具算出", "列出执行法院、财产线索（你提供的）与提交材料"],
    intents: [["强制执行"], ["申请执行"], ["申请", "执行"], ["执行", "申请书"], ["迟延履行"], ["执行", "时效"]],
    notFor: ["不予执行", "执行异议", "撤销仲裁"],
  },
  {
    id: "cross-exam",
    line: "litigation",
    title: "质证意见",
    gives: "对方证据目录与证据材料",
    gets: ["质证意见（草稿）.docx", "质证意见表.xlsx（三性逐项）"],
    scenario: "a1.agent_task",
    skill: "cross-exam-opinion",
    verb: "开始起草",
    goal: "请对对方证据逐项起草质证意见。我方诉讼地位：{side}；举证期限届满日：{proof_deadline}；开庭或证据交换日期：{hearing_on}；争议焦点：{issues}；原件核对情况：{originals}。{extra}",
    fields: [
      // 质证对象是“对方”，开头不写死原告（复核 RB16B-14）；鉴定、证人出庭、调查取证申请以举证期限为准
      { key: "side", label: "我方地位", kind: "select", options: ["原告 / 申请人", "被告 / 被申请人", "第三人"], required: true },
      { key: "hearing_on", label: "开庭或交换日期", kind: "date" },
      { key: "issues", label: "争议焦点", kind: "text", placeholder: "例如：货款是否已付清；违约金是否过高" },
      // 第 66 批（V40-C）：举证期限、已知疑点不是每次都有，收进更多选项
      { key: "proof_deadline", label: "举证期限届满日", kind: "date", help: "申请鉴定、证人出庭以此为限", more: true },
      { key: "extra", label: "已知疑点", kind: "text", placeholder: "例如：证据 3 的签章与合同不一致", more: true },
      { key: "originals", label: "原件核对情况", kind: "select", options: ["已核对原件", "只见过复印件", "还没见过"], more: true },
    ],
    minMaterials: 1,
    steps: ["逐份读对方证据，核对编号与页数", "逐份写真实性、合法性、关联性与证明目的意见", "列出需要核对原件、申请鉴定或补充反证的", "写成质证意见与意见表"],
    intents: [["质证"], ["对方", "证据"]],
  },
  {
    id: "agency",
    line: "litigation",
    title: "代理词",
    gives: "庭审笔录；没有笔录可直接写庭审要点",
    gets: ["代理词（草稿）.docx", "争点与依据对照表.xlsx（附件）"],
    scenario: "a1.agent_task",
    skill: "agency-statement",
    needsParties: true,
    verb: "开始起草",
    goal: "请起草代理词。法庭归纳的争议焦点：{focus_points}。提交期限：{deadline}。事实以我确认过的与已质证的证据为准，未确认的正文用附条件或保守写法、列进提交前核对清单（正文不留【待确认】），不评估胜诉率。",
    fields: [
      { key: "focus_points", label: "争议焦点", kind: "text", required: true, placeholder: "例如：货款是否已付清；违约金是否过高", help: "按法庭归纳的写，用“；”隔开" },
      { key: "deadline", label: "提交期限", kind: "date", more: true },
    ],
    minMaterials: 0,
    // 第 55 批：没有庭审笔录时的“庭审要点”原来没有地方写
    brief: HEARING_BRIEF,
    steps: ["按法庭归纳的焦点逐个论证", "证据只用已质证的；未确认的事实写得保守", "核对引用的法条；案例只用你提供的", "写成代理词与对照表"],
    intents: [["代理词"], ["代理意见"]],
  },
  {
    // v9.4（S1 §5.2 #1）：接案第一步——访谈纪要、材料清单，加紧急期限与利益冲突待核主体（intake-notes v1.2）
    id: "intake-lit",
    line: "litigation",
    title: "新案受理与访谈",
    gives: "访谈记录、客户初步材料；也可直接写访谈要点",
    gets: ["访谈纪要.docx", "材料收集清单.xlsx（附件）", "紧急期限与冲突待核清单.xlsx（附件）"],
    scenario: "a1.agent_task",
    skill: "intake-notes",
    allowPartial: true,
    verb: "开始整理",
    goal: "请根据访谈记录整理访谈纪要与材料收集清单，并列出紧急期限与需要做利益冲突检索的主体；案件类型：{case_type}。",
    fields: [{ key: "case_type", label: "案件类型", kind: "select", options: ["买卖合同", "借款与担保", "建设工程", "股权与公司", "劳动争议", "侵权", "其他"] }],
    // 第 55 批：接案时常常只有电话里听到的情况——可以直接写访谈要点
    minMaterials: 0,
    brief: INTERVIEW_BRIEF,
    steps: ["整理客户陈述的事实（一律标“客户陈述”）", "列出需要客户提供的材料", "找出可能紧急的期限（只列起算事实，不推算日期）", "列出全部主体供冲突检索（不判断有无冲突）"],
    intents: [["新案"], ["接案"], ["受理", "访谈"]],
  },
  {
    // v9.4 新增（S1 §5.2 #5）：管辖与时效（procedure-check）；届满日交 calc.deadline，起算不明只给分支
    id: "procedure",
    line: "litigation",
    title: "管辖与时效核查",
    gives: "争议解决条款、催告 / 对账 / 确认函等带日期的材料",
    gets: ["管辖与时效核查表.xlsx"],
    scenario: "a1.agent_task",
    skill: "procedure-check",
    verb: "开始核查",
    goal: "请核查管辖与诉讼时效：拟主张的请求为{claims}；我方：{side}；标的额：{amount}；收到诉状或仲裁申请书的日期：{received_on}。",
    fields: [
      { key: "claims", label: "拟主张的请求", kind: "text", required: true, placeholder: "例如：支付货款 50 万元及逾期利息" },
      // 第 26 批（评审 S2 §3 第 9 条）：方法参数本来就有 side
      { key: "side", label: "我方是", kind: "select", options: ["拟起诉", "已被诉"] },
      { key: "amount", label: "标的额", kind: "text", placeholder: "例如：120 万元", help: "定级别管辖要用" },
      { key: "received_on", label: "收到诉状日期", kind: "date", help: "已被诉时填：答辩与管辖异议期限从这天起算", more: true },
    ],
    minMaterials: 1,
    steps: ["摘出争议解决条款，核对是否有效", "列出法定连接点与候选法院或机构", "整理时效起算、中断的事实与证据", "期限届满日由期限工具计算；起算不明时只给分支"],
    intents: [["管辖"], ["诉讼时效"], ["时效", "过了"], ["时效", "核查"]],
    // 第 31 批（审查 B-07、B-16）：劳动仲裁时效、申请执行期间不按民法典诉讼时效，本方法不做
    notFor: ["劳动仲裁", "劳动争议", "员工", "执行时效", "申请执行"],
  },
  {
    // v9.4 新增：劳动者一方的仲裁申请（labor-dispute，模式 = 仲裁申请）
    id: "labor-apply",
    line: "litigation",
    // V16 F2：与“劳动仲裁申请书”卡名几乎一样却不出申请书，改名
    title: "劳动者请求梳理与金额测算",
    gives: "劳动合同、工资与考勤记录、解除通知等",
    // 第 27 批（评审 S3-15）：与方法实际产出同名；要成文用“劳动仲裁申请书”卡
    // 第 31 批（审查 B-03）：与方法实际交付同名、主交付物（应对方案）在前
    gets: ["劳动争议应对方案.docx", "请求项与敞口表.xlsx（附件）", "举证责任与证据清单.xlsx"],
    scenario: "a1.agent_task",
    skill: "labor-dispute",
    args: { mode: "仲裁申请", side: "劳动者" },
    allowPartial: true,
    verb: "开始梳理",
    goal: "请为劳动者梳理应主张的全部仲裁请求、时效与证据：{situation}。入职日期：{hired_on}；离职日期：{left_on}；离职方式：{leave_type}；月工资：{monthly_wage}。",
    fields: [
      { key: "situation", label: "基本情况", kind: "long", required: true, placeholder: "例如：2026 年 8 月被口头辞退，未签书面合同，有加班" },
      ...LABOR_BASICS.map(more),
    ],
    minMaterials: 1,
    steps: ["按事实逐项核对应主张的请求，避免漏项", "时效分两类列出（劳动报酬与其他）", "按法定规则列举证责任与要补的证据", "测算金额并写明公式与基数（草稿，待复核）"],
    // 第 31 批（审查 B-15）：律师代理劳动者最常说“申请劳动仲裁”“员工被辞退要申请仲裁”，原先被引到用人单位的应诉卡
    intents: [["劳动者", "仲裁"], ["代理", "劳动者"], ["替员工", "仲裁"], ["申请劳动仲裁"], ["被辞退", "仲裁"]],
    notFor: ["应对", "员工告", "员工申请劳动仲裁", "收到"],
  },
  {
    // 第 27 批（评审 S2-19、S3-04）：劳动仲裁申请书成文（labor-arbitration-draft，先确认论点再成文）
    id: "labor-arb-application",
    line: "litigation",
    title: "劳动仲裁申请书",
    gives: "劳动合同、工资与考勤记录、解除通知；梳理成果可一并勾选",
    gets: ["劳动仲裁申请书（草稿）.docx", "证据目录.xlsx（附件）", "提交前核对清单.xlsx（附件）"],
    scenario: "a1.agent_task",
    skill: "labor-arbitration-draft",
    args: { doc_kind: "申请书" },
    needsParties: true,
    verb: "开始起草",
    goal: "请起草劳动仲裁申请书：我方为{side}；拟主张的请求：{claims}。入职日期：{hired_on}；离职日期：{left_on}；离职方式：{leave_type}；月工资：{monthly_wage}。",
    fields: [
      { key: "side", label: "我方是", kind: "select", options: ["劳动者", "用人单位"], required: true },
      claimsField("仲裁请求", "例如：支付违法解除劳动合同赔偿金", "一项一行；金额可留空，助手按工资与工龄算"),
      // 第 66 批（V40-C）：入职、离职、月工资助手先从劳动合同与工资记录里找，收进更多选项
      ...LABOR_BASICS.map(more),
    ],
    minMaterials: 1,
    steps: ["先确认文书、立场与关键日期", "请求一次提全，逐项单列金额与口径", "论点与依据先交你确认再成文", "生成申请书、证据目录与提交前核对清单"],
    intents: [["劳动仲裁", "申请书"], ["劳动", "仲裁申请书"], ["替员工", "申请书"]],
    // 第 31 批（审查 B-06）：“收到劳动仲裁申请书”是被申请人一方，要的是答辩书
    notFor: ["商事仲裁", "仲裁委员会规则", "收到", "答辩", "被申请"],
  },
  {
    // 复核 Q8-09：律所诉讼律师代理用人单位答辩是常见业务，诉讼线也放一张（同一方法；企业法务线另有一张固定用人单位）
    id: "labor-arb-defense-lit",
    line: "litigation",
    title: "劳动仲裁答辩书",
    gives: "仲裁申请书副本与送达记录、劳动合同、工资考勤、解除文件、规章制度",
    gets: ["劳动仲裁答辩书（草稿）.docx", "证据目录.xlsx（附件）", "提交前核对清单.xlsx（附件）"],
    scenario: "a1.agent_task",
    skill: "labor-arbitration-draft",
    args: { doc_kind: "答辩书" },
    // 第 31 批：方法前言 outputs 第一项是申请书，不写 primary 时提示词会把“主交付物”说成申请书
    primary: "劳动仲裁答辩书（草稿）.docx",
    needsParties: true,
    verb: "开始起草",
    goal: "请起草劳动仲裁答辩书：我方为{side}；收到仲裁申请书副本的日期：{received_on}；请算出答辩期届满日，管辖异议与反申请须在期满前提出；对方请求：{claims}。",
    fields: [
      { key: "side", label: "我方是", kind: "select", options: ["用人单位", "劳动者"], required: true },
      { key: "received_on", label: "收到申请书日期", kind: "date", required: true, help: "答辩期与管辖异议、反申请期限从这天起算" },
      { key: "claims", label: "对方请求", kind: "text", placeholder: "例如：违法解除赔偿金 12 万元、加班费" },
    ],
    minMaterials: 1,
    steps: ["先算答辩期届满日，提示管辖异议与反申请的截止", "按程序、事实、法律三层逐项回应对方请求", "复核对方的计算，原数与复算并列", "论点交你确认后生成答辩书与附件"],
    intents: [["劳动仲裁", "答辩书"], ["代理", "用人单位", "仲裁"], ["收到", "劳动仲裁"]],
    notFor: ["商事仲裁"],
  },
  {
    id: "research-lit",
    line: "litigation",
    general: true,
    // v9.4（S1 §0 第 6 条）：案例库尚未开通，卡名不再写“类案”
    title: "法规研究备忘录",
    gives: "研究问题（可附材料）",
    gets: ["研究备忘录.docx", "来源目录（来源较多时）"],
    scenario: "a1.agent_task",
    skill: "legal-research-memo",
    verb: "开始研究",
    goal: "研究问题：{question}。事件发生时点：{when}。",
    fields: [
      { key: "question", label: "研究问题", kind: "long", required: true, placeholder: "例如：股东未实缴出资时对公司债务的责任" },
      { key: "when", label: "事件时点", kind: "text", placeholder: "例如：2023 年 5 月", help: "定适用哪一版法律；事项里填过的不用再填", more: true },
    ],
    minMaterials: 0,
    steps: ["拆解问题与适用时点", "检索法规（联网检索会先去掉当事人信息）", "逐条核对引用是否现行有效", "写成研究备忘录（案例库尚未开通：只做法规研究）"],
    intents: [["研究"], ["检索"], ["法规", "研究"], ["现行有效", "法规"], ["现行有效", "规定"], ["查", "规定"], ["法律", "规定"], ["法条", "规定"], ["怎么", "规定"]],
    // 案例库尚未开通：说“类案、案例”时不建议本卡，免得律师以为能检索案例
    notFor: ["类案", "案例"],
  },
  // 第 61 批（V35，D-266）：类案比对——只用律师提供的裁判文书；系统核对报告里的案号能否在材料里找到、归到判决名下的引文能否逐字找到
  {
    id: "case-law",
    line: "litigation",
    general: true,
    title: "类案检索报告（用你提供的判决）",
    gives: "你下载的判决书、裁定书（至少 2 份）；本案材料可一并勾选",
    gets: ["类案检索报告.docx", "类案对比表.xlsx"],
    scenario: "a1.agent_task",
    skill: "legal-research-memo",
    args: { mode: "类案比对" },
    primary: "类案检索报告.docx",
    verb: "开始比对",
    goal: "请用我提供的裁判文书做类案比对：{question}。我方立场：{side}。逐案抽取要素、与本案比对并分为支持、对立、可区分，归纳裁判规则（写明样本边界），只引用材料里的判决，不凭记忆补案例。",
    fields: [
      { key: "question", label: "要回答的问题", kind: "long", required: true, goalOnly: true, placeholder: "例如：买受人签署验收单后以性能不达标主张减价，质量瑕疵的举证责任如何分配" },
      { key: "side", label: "我方立场", kind: "text", goalOnly: true, placeholder: "例如：出卖人（一审原告），拟上诉" },
    ],
    minMaterials: 2,
    steps: ["逐份抽取案号、法院、争点、理由与结果", "与本案逐项比对，分出支持、对立与可区分的裁判", "归纳裁判规则并写明样本边界，对立裁判单列", "写出哪几份可提交法院、怎么引用"],
    intents: [["类案"], ["类似", "案例"], ["案例", "检索"], ["这几份", "判决"], ["判例"], ["裁判", "规则"]],
    notFor: ["起诉状", "答辩状"],
  },
  {
    // V16 F1：正式法律意见书单独一张卡（原由“合规问答 / 顾问答复”在点名时兼出）；同一方法 client-advice，主交付物是意见书
    id: "legal-opinion",
    line: "transactional",
    general: true,
    title: "出具法律意见书",
    gives: "要回答的问题；相关合同、章程、函件等材料",
    gets: ["法律意见书（草稿）.docx（签署栏留空）"],
    scenario: "a1.agent_task",
    skill: "client-advice",
    primary: "法律意见书（草稿）.docx",
    allowPartial: true,
    verb: "开始起草",
    goal: "请就以下问题出具正式的法律意见书（Word），签署栏留空：{question}。致送对象：{addressee}。用途：{purpose}。",
    fields: [
      { key: "question", label: "要回答的问题", kind: "long", required: true, placeholder: "例如：目标公司为股东提供担保，是否须经股东会决议" },
      { key: "addressee", label: "致送对象", kind: "text", placeholder: "例如：某公司董事会" },
      { key: "purpose", label: "用途", kind: "select", options: ["内部决策参考", "对外出示", "监管或审计报送"], help: "对外出示的，限制条款与假设会写得更完整。" },
    ],
    minMaterials: 0,
    steps: ["读材料、明确每个问题", "检索并逐条核对法律依据（核对不了的标出来）", "先把论点与依据交你确认", "按意见书体例成文并自查"],
    intents: [["法律意见书"], ["出具", "意见书"], ["正式意见"]],
  },
  {
    // v9.4 新增（S1 §6.1 第 1 项）：“核对起诉状里的引用”不再被引到研究备忘录——那个方法自己写明不核已有文稿
    id: "citation-audit",
    line: "litigation",
    general: true,
    title: "文稿体检：引用与论证",
    gives: "一份文稿（我方、对方或助手起草的）",
    gets: ["引用核验表.xlsx", "改引建议（待你确认）"],
    scenario: "a1.agent_task",
    skill: "citation-check",
    verb: "开始核对",
    goal: "请核对这份文稿里的法律引用与论证；事件发生时点：{when}。",
    fields: [{ key: "when", label: "事件时点", kind: "text", placeholder: "例如：2023 年 5 月", help: "定适用哪一版法律；事项里填过的不用再填", more: true }],
    minMaterials: 1,
    steps: ["逐条抽出文稿里的法条、司法解释与案例引用", "核对是否存在、按事件时点是否适用", "对照条文原文看能否支持结论", "列出改引建议，由你确认"],
    intents: [["核对", "引用"], ["核验", "引用"], ["引用", "法条"], ["法条", "有效", "这份"], ["现行有效", "这份"], ["现行有效", "文书"], ["现行有效", "代理词"], ["现行有效", "起诉状"], ["文稿", "体检"]],
  },
  {
    // 第 28 批：在原件上改（修订稿 + 清洁稿）。此前“按我的意见改这份 Word”没有入口——自由描述时助手按合同审查做，只出风险卡与表格
    id: "doc-revise",
    line: "transactional",
    general: true,
    title: "按你的意见修改文书",
    gives: "要修改的 Word 文书（.docx）；修改意见写在下面",
    gets: ["修订稿.docx（修订痕迹）", "清洁稿.docx", "修改对照表.docx（附件）"],
    scenario: "a1.agent_task",
    skill: "doc-revise",
    verb: "开始修改",
    goal: "修改范围：{scope}。请按以下意见直接在原文上修改这份文书，给我修订稿和清洁稿：{opinion}",
    fields: [
      { key: "opinion", label: "修改意见", kind: "long", placeholder: "例如：付款改为 3-4-3 分期；验收期改为 15 个工作日；争议解决改为我方所在地法院", required: true, help: "一处一条；你没提的风险只提示、不擅自改" },
      { key: "scope", label: "修改范围", kind: "select", options: ["只改意见点到的条款", "连带调整定义与互相引用的条款"] },
    ],
    minMaterials: 1,
    steps: ["把你的意见拆成逐处修改（含定义、互引）", "在原件副本上逐处修改，保留原版式、编号与表格", "生成带修订痕迹的修订稿和接受全部修订的清洁稿", "按实际修改生成对照表；你没提的风险只提示"],
    intents: [["修改", "合同"], ["修改", "这份"], ["修订稿"], ["清洁稿"], ["清洁版"], ["修订痕迹"], ["按", "意见", "修改"], ["帮我", "改"]],
    // 第 34 批路由体检：“对方改了几处，帮我看看改了什么”是审对方的回稿，不是我方改文书
    // 第 35 批真实走查（N3）：“审查……出一份审查意见书，并给出建议的修改条款”被引到这里——要的是审查成果里的修改建议，不是我方改原件
    notFor: ["起草", "比对", "回稿", "对方改了", "改了什么", "改了哪些", "给出修改建议", "提出修改建议", "给出建议的修改", "提出建议的修改", "出具修改建议", "审查意见书", "审核意见书"],
  },
  {
    id: "demand-lit",
    line: "litigation",
    general: true,
    title: "律师函 / 催告函",
    gives: "合同与往来记录；没有材料时直接写案情",
    gets: ["律师函或催告函（草稿）.docx", "依据与发送前核对.xlsx"],
    scenario: "a1.agent_task",
    skill: "demand-letter",
    allowPartial: true,
    needsParties: true,
    verb: "开始起草",
    // 第 26 批（评审 S2-12）：字段键与方法参数 letter_type 一致（原来叫 purpose，方法收不到）；类型与方法的六类函件一致
    // 第 55 批：补上案情、要求对方做什么、发函名义（原来没有事实入口，方法只能任务中途问“以谁的名义、要求什么”）
    goal: "请起草：{letter_type}；要求对方：{demand}；期限要求：{deadline}；发函名义：{sender}。",
    fields: [
      { key: "letter_type", label: "函件类型", kind: "select", options: LETTER_TYPES, required: true },
      { key: "demand", label: "要求对方做什么", kind: "text", goalOnly: true, placeholder: "例如：支付货款 1,000,000 元及逾期利息" },
      { key: "deadline", label: "期限要求", kind: "text", placeholder: "例如：收函后 7 日内" },
      SENDER,
    ],
    minMaterials: 0,
    brief: CASE_BRIEF,
    steps: ["从材料中整理事实与依据", "起草函件正文", "核对引用", "列出发送前核对（收件人、送达方式、期限）"],
    intents: [["律师函"], ["催告"], ["催款函"], ["解除通知"], ["保证人", "主张"], ["保证期间"]],
  },
  // ── 非诉 ──
  {
    id: "contract-review",
    line: "transactional",
    title: "审合同",
    gives: "一份合同（Word 最佳）",
    gets: ["审查意见书（内部稿）.docx", "逐条审查意见（审查工作台）", "问题清单.xlsx（附件）", "建议修订稿与清洁稿（可选）"],
    scenario: "a1.agent_task",
    skill: "contract-review",
    verb: "开始审查",
    goal: "请审查这份{type}合同，我方立场以事项为准；重点关注：{focus}。{redline}。交易背景：{background}。文本由谁提供：{paper}。",
    fields: [
      { key: "type", label: "合同类型", kind: "select", options: CONTRACT_TYPES, required: true },
      { key: "focus", label: "重点关注", kind: "multi", options: ["付款", "交割 / 验收", "违约责任", "知识产权", "保密", "争议解决"] },
      { key: "redline", label: "建议修订稿", kind: "select", options: ["不用，先看审查意见", "要：按审查意见直接在原件上写修订"], goalText: { "不用，先看审查意见": "", "要：按审查意见直接在原件上写修订": "审查意见出完后，按必须修改与建议修改的意见在原件上写一份建议修订稿（修订痕迹）" } },
      { key: "background", label: "交易背景", kind: "text", placeholder: "例如：对方强势、金额 300 万元、打算长期合作", help: "决定意见写得多激进。", more: true },
      { key: "paper", label: "文本由谁提供", kind: "select", options: ["对方的格式文本", "我方范本", "双方共同起草", "不清楚"], more: true },
    ],
    minMaterials: 1,
    steps: ["通读合同、标出结构", "按我方立场逐条找出风险，引用原文", "给出修改建议与可退让方案，核对依据", "把每项意见放进审查工作台，由你逐项决定"],
    // 第 28 批：“修改合同”引到“按你的意见修改文书”（律师要的是改好的稿子，不是风险清单）
    // 第 35 批：审查成果的说法（“出一份审查意见书”“提出修改建议”“把关”“审一下”）也认作审合同
    intents: [["审查", "合同"], ["审合同"], ["审查", "协议"], ["审核", "合同"], ["风险", "合同"], ["审查意见书"], ["审核意见书"], ["修改建议", "合同"], ["修改建议", "协议"], ["把关", "合同"], ["审一下", "合同"], ["审一下", "协议"]],
    notFor: ["解除劳动合同"],
  },
  {
    // v9.4（S1 §0 第 5 条）：原“回稿比对”卡走本机比对、不重审，卡上却写“只对改动部分重新审查”——拆成两张，名实相符
    id: "redraft",
    line: "transactional",
    title: "对方回稿：比对与重审",
    gives: "依次勾选我方上一稿、对方回稿（两份 Word）",
    gets: ["变更清单.xlsx（含静默改动）", "新问题进审查工作台", "回稿审查意见（内部稿）.docx（需要时）"],
    scenario: "a1.agent_task",
    skill: "redraft-review",
    verb: "开始重审",
    goal: "请比对我方上一稿与对方回稿，并只对改动部分重新审查（材料按勾选顺序：第一份是我方上一稿，第二份是对方回稿）；重点关注：{focus}。",
    fields: [{ key: "focus", label: "重点关注", kind: "multi", options: ["付款", "交割 / 验收", "违约责任", "知识产权", "保密", "争议解决"] }],
    minMaterials: 2,
    steps: ["逐段比对两稿，标出对方没用修订标记的改动", "核对我方上一轮的修改有没有被采纳", "只对改动部分重新审查，新问题放进审查工作台", "写回稿意见"],
    intents: [["回稿"], ["对方", "修改"], ["对方", "回稿"], ["对方", "改了"], ["改了什么"], ["改了哪些"]],
  },
  {
    id: "redraft-local",
    line: "transactional",
    title: "回稿比对（不用 AI）",
    gives: "依次勾选我方基线稿、对方回稿（两份 Word）",
    gets: ["回稿比对报告", "差异表（含静默改动）"],
    scenario: "s1b.draft_compare",
    verb: "开始比对",
    goal: "",
    fields: [],
    minMaterials: 2,
    steps: ["在这台电脑上逐段比对两稿（不用 AI）", "标出对方未用修订标记的改动", "列出差异表（要重审请用“比对与重审”）"],
    intents: [["比对"], ["对比", "版本"]],
  },
  {
    // v9.4 新增（S1 §6.1 第 2 项）：审完合同的最后一公里——给客户和对方的修订说明、内部谈判要点
    id: "redline-notes",
    line: "transactional",
    title: "修订说明与谈判要点",
    gives: "已在审查工作台处理过的意见",
    gets: ["修订说明（致客户 / 致对方）.docx", "谈判要点（内部）"],
    scenario: "a1.agent_task",
    skill: "contract-redline",
    verb: "开始撰写",
    goal: "请根据审查工作台里已接受或修改后接受的意见，写{audience}的修订说明，并整理内部谈判要点。",
    fields: [{ key: "audience", label: "给谁看", kind: "select", options: ["致客户", "致对方", "致客户与致对方两版"], required: true }],
    // 第 31 批：不写时主交付物恒为方法 outputs 第一项“致客户”，选“致对方”提示词也要求出致客户版（误发对方即露底线）
    primaryBy: { field: "audience", map: { 致对方: "修订说明（致对方）.docx" } },
    minMaterials: 0,
    steps: ["只取你接受或改后接受的意见", "写修订说明（致对方版不写底线与内部评估）", "整理内部谈判要点：首选、可退让、需客户决定"],
    intents: [["修订说明"], ["谈判要点"], ["修改说明"]],
  },
  // v9.4 第 22 批（评审 C1 §1 #22）：从范本整理本事项的审查要点（review-rules-draft）——只出草稿，律师在概览“审查要点”里审定启用后才用于审查
  {
    id: "rules-from-template",
    line: "transactional",
    title: "从范本整理审查要点",
    gives: "本所或客户的范本、标准、已签定稿",
    gets: ["审查要点草稿（审定后启用）"],
    scenario: "a1.agent_task",
    skill: "review-rules-draft",
    verb: "开始整理",
    goal: "请从本事项的范本里整理审查要点草稿：每条写条款、我方标准、可退让、不可谈，并写明出处。范本是：{basis}。",
    fields: [{ key: "basis", label: "范本是什么", kind: "text", placeholder: "例如：客户的采购标准；我们的服务合同范本" }],
    minMaterials: 1,
    steps: ["找出范本类文件并读完", "逐条概括条款、我方标准、可退让、不可谈，写明出处", "范本之间不一致的并列给你选", "存为草稿，等你审定启用"],
    intents: [["审查要点"], ["范本", "标准"], ["审查", "标准", "整理"]],
  },
  {
    id: "audience-pack",
    line: "transactional",
    general: true,
    title: "客户版与对外脱敏",
    gives: "要发出的文件",
    gets: ["脱敏件（无修订痕迹）", "脱敏报告"],
    scenario: "s6.redaction",
    verb: "开始处理",
    goal: "",
    fields: [],
    minMaterials: 1,
    steps: ["扫描证件、账户、联系方式等个人信息", "生成脱敏件", "列出替换统计与未覆盖的类别"],
    intents: [["脱敏"], ["对外版"], ["客户版"], ["去掉", "批注"]],
  },
  {
    // v9.4 新增（S1 §5.3 #4）：起草合同（contract-draft）
    id: "contract-draft",
    line: "transactional",
    title: "起草合同",
    gives: "交易要点或条款清单；本所范本（可选）",
    gets: ["合同草稿.docx", "起草说明与待定事项.docx（附件）"],
    scenario: "a1.agent_task",
    skill: "contract-draft",
    allowPartial: true,
    needsParties: true,
    verb: "开始起草",
    goal: "请起草一份{type}合同，我方立场以事项为准；交易要点：{points}。争议解决：{dispute}。",
    fields: [
      { key: "type", label: "合同类型", kind: "select", options: CONTRACT_TYPES, required: true },
      // V13 第 38 批真实走查 W1：律师把 323 字的委托说明贴进交易要点，单行框只看得到末尾一截（第 36 批其他卡的主栏已改多行，这张漏了）
      { key: "points", label: "交易要点", kind: "long", placeholder: "例如：甲方采购设备 200 台，总价 300 万元，分三期付款，验收期 15 日", help: "写主体、标的、价款、交付验收、期限；缺的列为待定事项" },
      { key: "dispute", label: "争议解决", kind: "select", options: ["我方所在地法院", "对方所在地法院", "仲裁", "待定"], more: true },
    ],
    minMaterials: 0,
    steps: ["确认交易要点，缺的列为“待定事项”，不编造", "有本所范本先用范本", "起草后核对定义、金额、日期与互引是否一致", "写起草说明：关键条款为什么这样写、对方可能怎么改"],
    intents: [["起草", "合同"], ["拟", "合同"], ["起草", "协议"]],
  },
  {
    // v9.4 新增（S1 §5.3 #5、#6）：尽职调查两阶段（due-diligence）
    id: "dd-list",
    line: "transactional",
    title: "尽调清单与访谈提纲",
    gives: "已有的目标公司资料（可选）；交易简况写进补充要求",
    gets: ["尽调清单.xlsx（内部用）", "资料清单（致目标公司）.xlsx（可直接发对方）", "访谈提纲.docx"],
    scenario: "a1.agent_task",
    skill: "due-diligence",
    args: { stage: "清单" },
    verb: "开始列清单",
    goal: "请为这笔{deal_type}交易列出尽调清单、可直接发给对方的资料清单与访谈提纲；目标公司行业：{industry}；关注重点：{focus}。",
    fields: [
      { key: "deal_type", label: "交易类型", kind: "select", options: ["股权收购", "增资", "资产收购", "其他"], required: true },
      { key: "industry", label: "目标公司行业", kind: "text", placeholder: "例如：医疗器械", help: "有特殊资质的行业会多列一组" },
      { key: "focus", label: "关注重点", kind: "text", placeholder: "例如：出资是否实缴、核心资质、未决诉讼" },
    ],
    minMaterials: 0,
    steps: ["先写交易保护问题：买什么、怕什么、靠什么保护", "红旗问题放在最前", "分模块列核查事项，每项落到具体文件", "访谈提纲只问书面查不到的"],
    intents: [["尽调"], ["尽职调查"], ["尽调", "清单"]],
  },
  {
    id: "dd-findings",
    line: "transactional",
    title: "尽调发现与报告（内部稿）",
    gives: "数据室材料、访谈纪要、外部查询结果（工商、涉诉、执行）",
    gets: ["尽调报告（内部稿）.docx", "尽调发现表.xlsx（附件）", "交易文件条款建议"],
    scenario: "a1.agent_task",
    skill: "due-diligence",
    args: { stage: "发现" },
    primary: "尽调报告（内部稿）.docx",
    verb: "开始整理",
    goal: "请根据数据室材料、访谈纪要和导入的外部查询结果整理尽调发现与内部报告；交易类型：{deal_type}；目标公司行业：{industry}；关注重点：{focus}。",
    fields: [
      { key: "deal_type", label: "交易类型", kind: "select", options: ["股权收购", "增资", "资产收购", "其他"], required: true },
      { key: "focus", label: "关注重点", kind: "text", placeholder: "例如：核心资质、重大合同的控制权变更条款、未决诉讼" },
      { key: "industry", label: "目标公司行业", kind: "text", placeholder: "例如：医疗器械", help: "有特殊资质的行业会多列一组", more: true },
    ],
    minMaterials: 1,
    steps: ["每个发现写事实出处、法律后果、交易影响与处理", "处理方案落到交易文件条款（先决条件、陈述保证等）", "“核查受限”的事项单独列出", "客户与目标公司的陈述标“陈述”，不写成已核实"],
    intents: [["尽调", "报告"], ["尽调", "发现"], ["尽职调查", "报告"]],
  },
  // v9.4 第 21 批：原“即将推出”的两项非诉转正（corporate-resolutions、closing-checklist）
  {
    id: "corporate-resolutions",
    line: "transactional",
    title: "股东会与董事会文件",
    gives: "公司章程、拟议事项的材料（股东名册、交易文件等）",
    // V16 F5：决议在前（方法 outputs 首项已改成决议）
    gets: ["决议（草稿）.docx", "会议通知（草稿）.docx（开会时才出）", "签署页（草稿）.docx", "召集与表决核对表.xlsx"],
    scenario: "a1.agent_task",
    skill: "corporate-resolutions",
    needsParties: true,
    verb: "开始起草",
    goal: "请起草{meeting}的文件（{company_type}）：开会的出会议通知、决议与签署页，书面决定不开会的只出决定与签署页；拟议事项：{matters}。会议日期：{meeting_on}；召开方式：{meeting_mode}。以公司章程为准，没有章程的逐项标出待核，表决结果留空。",
    // 第 31 批：全体股东书面决定、一人公司股东决定不开会，主交付物是决定本身（原先恒为《会议通知》）
    primaryBy: { field: "meeting", map: { 全体股东书面决定: "决议（草稿）.docx", 一人公司股东决定: "决议（草稿）.docx" } },
    fields: [
      { key: "meeting", label: "会议", kind: "select", options: ["股东会", "临时股东会", "董事会", "临时董事会", "全体股东书面决定", "一人公司股东决定"], required: true },
      { key: "company_type", label: "公司类型", kind: "select", options: ["有限责任公司", "股份有限公司（非上市）"], required: true },
      { key: "matters", label: "拟议事项", kind: "text", required: true, placeholder: "例如：增资 500 万元；修改章程；选举董事" },
      { key: "meeting_on", label: "会议日期", kind: "date", more: true },
      { key: "meeting_mode", label: "召开方式", kind: "select", options: ["现场", "通讯（视频或电话）", "书面传签"], more: true },
    ],
    minMaterials: 0,
    steps: ["逐字摘出章程里召集、通知、表决的规定（章程优先）", "逐项判断普通决议还是特别决议、要不要回避", "起草会议通知、决议与签署页（出席与表决结果留空）", "列出召集与表决核对表和可能影响决议效力的情形"],
    intents: [["股东会", "决议"], ["董事会", "决议"], ["股东会", "通知"], ["董事会", "通知"], ["股东会", "文件"], ["董事会", "文件"], ["股东大会"], ["股东决定"]],
  },
  {
    id: "closing-checklist",
    line: "transactional",
    title: "交割清单",
    gives: "已签署或定稿的交易文件（含附件、补充协议）",
    gets: ["交割清单.xlsx", "交割清单说明.docx（附件）"],
    scenario: "a1.agent_task",
    skill: "closing-checklist",
    verb: "开始整理",
    goal: "请从交易文件中逐条整理交割清单（先决条件、交割文件与动作、交割后义务），每条附原文与出处。预计交割日：{closing_date}。",
    fields: [{ key: "closing_date", label: "预计交割日", kind: "date" }],
    minMaterials: 1,
    steps: ["读全部交易文件（含附件与补充协议）", "一条约定一行，逐字摘原文并写明文件与条号", "期限届满日由期限工具计算；约定的算法优先", "不同文件约定不一致的并列写出，交你判断"],
    intents: [["交割清单"], ["交割", "清单"], ["先决条件"], ["交割", "文件"], ["交割后", "义务"]],
  },
  {
    id: "research-deal",
    line: "transactional",
    title: "交易法规研究",
    gives: "研究问题（可附交易文件）",
    gets: ["研究备忘录.docx", "来源目录.xlsx（附件）"],
    scenario: "a1.agent_task",
    skill: "legal-research-memo",
    verb: "开始研究",
    goal: "研究问题：{question}。",
    fields: [{ key: "question", label: "研究问题", kind: "long", required: true, placeholder: "例如：外资并购中的经营者集中申报门槛" }],
    minMaterials: 0,
    steps: ["拆解问题", "检索法规并核对效力", "写成研究备忘录"],
    intents: [["监管"], ["审批", "要求"], ["申报"]],
  },
  {
    id: "intake",
    line: "transactional",
    title: "访谈纪要与材料清单",
    gives: "访谈录音转写或笔记；也可直接写访谈要点",
    gets: ["访谈纪要.docx", "材料收集清单.xlsx（附件）", "紧急期限与冲突待核清单.xlsx（附件）"],
    scenario: "a1.agent_task",
    skill: "intake-notes",
    allowPartial: true,
    verb: "开始整理",
    goal: "请根据访谈记录整理访谈纪要与材料收集清单；访谈对象：{who}。",
    fields: [{ key: "who", label: "访谈对象角色", kind: "text", placeholder: "例如：公司财务负责人" }],
    minMaterials: 0,
    brief: INTERVIEW_BRIEF,
    steps: ["整理访谈要点与待核实事项", "列出需要客户提供的材料", "生成纪要与清单"],
    intents: [["访谈"], ["纪要"], ["材料清单"]],
  },
  // ── 企业法务 ──
  {
    id: "contract-review-inhouse",
    line: "inhouse",
    title: "合同审核",
    gives: "一份合同（Word 最佳）",
    gets: ["审查意见书（内部稿）.docx", "逐条审核意见（审查工作台）", "问题清单.xlsx（附件）", "建议修订稿与清洁稿（可选）"],
    scenario: "a1.agent_task",
    skill: "contract-review",
    verb: "开始审核",
    goal: "请从公司角度审核这份{type}合同；重点关注：{focus}。{redline}。交易背景：{background}。文本由谁提供：{paper}。",
    fields: [
      { key: "type", label: "合同类型", kind: "select", options: CONTRACT_TYPES, required: true },
      { key: "focus", label: "重点关注", kind: "multi", options: ["付款", "验收", "违约责任", "知识产权", "保密", "数据合规"] },
      { key: "redline", label: "建议修订稿", kind: "select", options: ["不用，先看审查意见", "要：按审查意见直接在原件上写修订"], goalText: { "不用，先看审查意见": "", "要：按审查意见直接在原件上写修订": "审查意见出完后，按必须修改与建议修改的意见在原件上写一份建议修订稿（修订痕迹）" } },
      { key: "background", label: "交易背景", kind: "text", placeholder: "例如：对方强势、金额 300 万元、打算长期合作", help: "决定意见写得多激进。", more: true },
      { key: "paper", label: "文本由谁提供", kind: "select", options: ["对方的格式文本", "我方范本", "双方共同起草", "不清楚"], more: true },
    ],
    minMaterials: 1,
    steps: ["通读合同", "从公司立场逐条找出风险", "给出修改建议并核对依据", "放进审查工作台由你决定"],
    intents: [],
  },
  // v9.4 第 22 批（评审 C1 §1 #22）：从范本整理本事项的审查要点（review-rules-draft）——只出草稿，律师在概览“审查要点”里审定启用后才用于审查
  {
    id: "rules-from-template-inhouse",
    line: "inhouse",
    title: "从公司范本整理审核标准",
    gives: "公司的合同范本、采购或销售标准",
    gets: ["审查要点草稿（审定后启用）"],
    scenario: "a1.agent_task",
    skill: "review-rules-draft",
    verb: "开始整理",
    goal: "请从公司的范本与标准里整理本事项的审查要点草稿：每条写条款、我方标准、可退让、不可谈，并写明出处。范本是：{basis}。",
    fields: [{ key: "basis", label: "范本是什么", kind: "text", placeholder: "例如：公司采购合同范本；销售标准条款" }],
    minMaterials: 1,
    steps: ["找出范本类文件并读完", "逐条概括条款、我方标准、可退让、不可谈，写明出处", "范本之间不一致的并列给你选", "存为草稿，等你审定启用"],
    intents: [["审核标准"], ["公司", "范本"]],
  },
  // 第 61 批（V35，D-268）：个人信息保护合规审查（外部评估 R4 internal-compliance：企业法务高频需求，法规库已备个保法、出境规章）
  {
    id: "privacy",
    line: "inhouse",
    title: "个人信息保护合规审查",
    gives: "隐私政策或个人信息处理规则、数据处理说明、SDK 与第三方共享清单",
    gets: ["个人信息保护合规审查意见.docx", "合规义务对照表.xlsx"],
    scenario: "a1.agent_task",
    skill: "privacy-compliance",
    verb: "开始审查",
    goal: "请做个人信息保护合规审查，目的是{purpose}。审查对象：{scope}；用户群体：{audience}；委托方在处理活动中的身份：{role}。先判断各项义务是否触发再判断是否履行，法定告知事项逐项判定并附原文，区分法定义务与管理建议；隐私政策的逐条修改建议{cards}。",
    fields: [
      { key: "purpose", label: "审查目的", kind: "select", options: ["上线前审查", "年度体检", "监管或整改排查", "融资上市自查"] },
      { key: "scope", label: "审查对象", kind: "multi", options: ["隐私政策", "数据处理说明", "SDK与第三方共享", "数据出境", "员工个人信息"] },
      { key: "audience", label: "用户群体", kind: "select", options: ["一般公众", "含未成年人", "主要面向未成年人", "企业员工"] },
      { key: "role", label: "委托方的身份", kind: "select", options: ["个人信息处理者", "受托人", "共同处理者", "接收方"], more: true },
      { key: "cards", label: "逐条修改建议", kind: "select", options: ["不要", "要"], goalText: { 不要: "不提交风险卡", 要: "作为风险卡提交到审查工作台" }, more: true },
    ],
    minMaterials: 1,
    steps: ["先列触发清单：敏感信息、未成年人、共享、出境等", "法定告知事项逐项判定，附逐字原文", "核对政策声明与数据处理说明是否一致", "区分法定义务与管理建议，排出整改优先级"],
    intents: [["隐私政策"], ["个人信息", "合规"], ["个人信息保护"], ["数据", "合规"], ["App", "合规"], ["数据出境"], ["个保法"]],
    notFor: ["数据处理协议", "委托处理协议", "合同"],
  },
  // 第 61 批（V35，D-267）：已签合同的履约体检（外部评估 R4 dispute-and-performance-risk：拟签审查已有，履约阶段是空白）
  {
    id: "performance",
    line: "inhouse",
    title: "合同履约体检",
    gives: "已签合同（含订单、补充协议）与履约记录（函件、签收、验收、付款）",
    gets: ["合同履约体检意见.docx", "义务与期限台账.xlsx"],
    scenario: "a1.agent_task",
    skill: "performance-check",
    verb: "开始体检",
    goal: "请对这份已签合同做履约体检，我方是{side}，侧重{focus}，客户的目的是{goal}。材料之后的最新进展：{latest}。抽出双方义务与期限成台账、期限届满日用工具算，判定违约形态并挂事实出处，列对方可能的抗辩与可选的救济路径和时间节点，金额用工具算；需要我定的取舍合并成一次提问。",
    fields: [
      { key: "side", label: "我方是", kind: "select", options: ["买方", "卖方", "发包人", "承包人", "出租人", "承租人", "委托方", "受托方", "其他"] },
      { key: "focus", label: "体检侧重", kind: "select", options: ["全面体检", "对方违约与救济", "我方自身履约风险", "指定订单或条款"] },
      { key: "goal", label: "处理目的", kind: "select", options: ["继续合作并追究", "尽快退出或更换合作方", "先评估再定"] },
      { key: "latest", label: "最新进展", kind: "long", goalOnly: true, placeholder: "例如：对方 11 月 20 日电话说下周补货，没有书面答复", help: "材料之后的电话、口头承诺等；不填按材料截止日分析" },
    ],
    minMaterials: 1,
    steps: ["抽出双方义务与期限，逐字摘录并挂出处", "异议、检验、解除等期限用工具算届满日", "判定违约形态，写对方最可能的抗辩与应对", "并列各救济路径与时间节点，金额用工具算"],
    intents: [["履约"], ["合同", "履行"], ["对方", "违约"], ["能不能", "解除"], ["逾期", "交货"], ["质量", "异议"], ["履约", "风险"]],
    notFor: ["审合同", "审查合同", "修改合同", "起草合同", "催告函", "律师函"],
  },
  {
    id: "compliance-qa",
    line: "inhouse",
    title: "合规问答 / 顾问答复",
    gives: "问题（可附业务材料）",
    // V16 F1：正式法律意见书改由“出具法律意见书”卡承接
    gets: ["顾问答复.docx（结论、假设、限制）"],
    scenario: "a1.agent_task",
    skill: "client-advice",
    verb: "开始答复",
    goal: "请答复以下问题：{question}。业务背景：{background}。",
    fields: [
      { key: "question", label: "问题", kind: "long", required: true, placeholder: "例如：员工离职后，竞业限制补偿能否按月支付" },
      { key: "background", label: "业务背景", kind: "long", goalOnly: true, placeholder: "例如：公司拟在 App 上线预付费会员卡", more: true },
    ],
    minMaterials: 0,
    steps: ["明确问题与前提", "检索并核对依据", "写出结论、假设与需客户确认的事项"],
    intents: [["合规"], ["能不能"], ["是否合法"], ["是否违法"], ["顾问"]],
  },
  {
    id: "demand-inhouse",
    line: "inhouse",
    title: "履约问题与催告函",
    gives: "合同与履约记录",
    // v9.4（S1 §0 第 6 条）：方法只出函件与依据核对，不出“风险提示”——卡上不承诺方法没有的东西
    gets: ["律师函或催告函（草稿）.docx（按所选路径）", "依据与发送前核对.xlsx"],
    scenario: "a1.agent_task",
    skill: "demand-letter",
    needsParties: true,
    verb: "开始处理",
    goal: "请就以下履约问题梳理履约事实与依据，并起草函件：{issue}。函件类型：{letter_type}。要求对方：{demand}；发函名义：{sender}。",
    fields: [
      { key: "issue", label: "履约问题", kind: "long", required: true, placeholder: "例如：对方应于 10 月 31 日交第二批货，至今未交" },
      // 第 26 批（评审 S2-12）：可不选，方法会问
      { key: "letter_type", label: "函件类型", kind: "select", options: ["先帮我判断该走哪条路径", ...LETTER_TYPES] },
      { key: "demand", label: "要求对方做什么", kind: "text", goalOnly: true, placeholder: "例如：十日内付清到期货款 80 万元" },
      SENDER,
    ],
    minMaterials: 1,
    steps: ["对照合同条款梳理履约事实", "核对依据，列出发送前要确认的事项", "起草催告函（期限按合同或你给的写，不自行推算）"],
    intents: [["履约"], ["逾期", "交货"], ["对方", "违约"]],
  },
  {
    // 第 27 批（评审 S2-18）：诉讼律师给客户的阶段报告是高频事；同一方法、诉讼线的卡名与汇报对象
    id: "case-report-lit",
    line: "litigation",
    title: "案件进展汇报（给客户）",
    gives: "案件材料与最新进展（开庭、裁判、对方新提交的材料）",
    // 复核 Q8-06：与方法实际产出同名；读者按方法定位是客户方的非诉讼专业人士，不给“所内合伙人”选项
    gets: ["案件进展汇报.docx", "进展与风险附表.xlsx（附件）"],
    scenario: "a1.agent_task",
    skill: "case-report",
    verb: "开始撰写",
    goal: "请给客户写案件进展汇报，汇报对象：{audience}；截至：{as_of}。材料之外的最新进展：{updates}。需要对方决定的事项：{pending}。",
    fields: [
      { key: "audience", label: "汇报对象", kind: "select", options: ["客户决策人", "客户管理层", "客户法务"], required: true },
      { key: "as_of", label: "截至日期", kind: "date" },
      { key: "updates", label: "最新进展", kind: "long", goalOnly: true, help: "只写材料里没有的", placeholder: "例如：上周收到开庭传票，开庭日 12 月 9 日；对方代理人电话里提过愿意调解" },
      { key: "pending", label: "需要决定的事", kind: "text", placeholder: "例如：是否接受分期付款的调解方案", more: true },
    ],
    minMaterials: 1,
    steps: ["整理到截至日的程序进展与关键事实（每条注明出处）", "列出主要风险、应对与金额口径", "写成一页报告与附表，需要客户决定的事单列"],
    intents: [["进展", "客户"], ["案件", "报告"], ["给客户", "汇报"]],
  },
  {
    id: "case-report",
    line: "inhouse",
    title: "重大案件进展汇报",
    gives: "案件材料与最新进展",
    gets: ["案件进展汇报.docx（一页，给管理层）", "进展与风险附表.xlsx（附件）"],
    scenario: "a1.agent_task",
    skill: "case-report",
    verb: "开始撰写",
    goal: "请撰写案件进展汇报，汇报对象：{audience}；截至：{as_of}。材料之外的最新进展：{updates}。需要对方决定的事项：{pending}。",
    fields: [
      { key: "audience", label: "汇报对象", kind: "select", options: ["管理层", "董事会", "业务部门"], required: true },
      { key: "as_of", label: "截至日期", kind: "date" },
      { key: "updates", label: "最新进展", kind: "long", goalOnly: true, help: "只写材料里没有的", placeholder: "例如：上周收到开庭传票，开庭日 12 月 9 日；对方代理人电话里提过愿意调解" },
      { key: "pending", label: "需要决定的事", kind: "text", placeholder: "例如：是否接受分期付款的调解方案", more: true },
    ],
    minMaterials: 1,
    steps: ["整理程序进展与关键事实", "列出主要风险与已确认的金额口径", "写成一页汇报与附表"],
    intents: [["汇报"], ["进展", "报告"]],
  },
  {
    // v9.4（S1 §0 第 6 条）：原来挂在通用案卷整理上，名不副实；改用劳动争议方法（模式 = 仲裁应对，立场 = 用人单位）
    id: "labor-response",
    line: "inhouse",
    title: "劳动仲裁应对",
    gives: "仲裁申请书、劳动合同、工资与考勤、解除文件、规章制度",
    gets: ["劳动争议应对方案.docx", "请求项与敞口表.xlsx（附件）", "举证责任与证据清单.xlsx（附件）"],
    scenario: "a1.agent_task",
    skill: "labor-dispute",
    args: { mode: "仲裁应对", side: "用人单位" },
    verb: "开始准备",
    // 第 26 批（评审 S2-14）：问收到申请书副本的日期——劳动仲裁答辩期十日（调解仲裁法第三十条）
    // 第 27 批（评审 S3-01/S3-17）：答辩期是十个工作日（办案规则第八十条），卡上直接写明
    // 第 41 批（V16 回归）：委托原话会被助手当成律师已定的口径，只给工作日一种日期、不给按日历日的保守日期；
    // 改为只写收到日期、请助手算届满日，按工作准则第 4 条并列各口径、最早届满的写在最前
    goal: "请为劳动仲裁应诉做应对方案：员工请求为{claim}；收到仲裁申请书副本的日期：{received_on}；请算出答辩期届满日；开庭日：{hearing}。入职日期：{hired_on}；离职日期：{left_on}；月工资：{monthly_wage}。",
    fields: [
      { key: "claim", label: "员工请求", kind: "text", required: true, placeholder: "例如：违法解除赔偿金 12 万元、加班费" },
      // 第 55 批：改必填——答辩期、管辖异议、反申请都以这一天为限
      { key: "received_on", label: "收到申请书日期", kind: "date", required: true, help: "答辩期与管辖异议、反申请期限从这天起算" },
      { key: "hearing", label: "仲裁开庭日", kind: "date" },
      ...LABOR_BASICS.filter((f) => f.key !== "leave_type").map(more),
    ],
    minMaterials: 1,
    steps: ["逐项回应员工请求，核对漏项", "时效分两类列出；举证责任按法定规则分配", "逐条查解除是否合法（理由、程序、公示、送达）", "测算敞口并写明公式（草稿，待复核）"],
    intents: [["劳动", "仲裁"], ["员工", "仲裁"], ["劳动争议"], ["员工", "主张"], ["员工", "要求", "赔偿"]],
    notFor: ["替员工", "代理劳动者", "被辞退"],
  },
  {
    // 第 27 批（评审 S2-19、S3-04）：劳动仲裁答辩书成文；收到日期必填——答辩期十个工作日，管辖异议与反申请都以它为限
    // 第 41 批（V16 回归）：委托原话与步骤不再写“十个工作日”——那会被当成律师已定的唯一口径；按工作准则第 4 条由助手并列各口径
    id: "labor-arb-defense",
    line: "inhouse",
    title: "劳动仲裁答辩书",
    gives: "员工的仲裁申请书副本、劳动合同、工资考勤、解除文件、规章制度",
    gets: ["劳动仲裁答辩书（草稿）.docx", "证据目录.xlsx（附件）", "提交前核对清单.xlsx（附件）"],
    scenario: "a1.agent_task",
    skill: "labor-arbitration-draft",
    args: { doc_kind: "答辩书", side: "用人单位" },
    primary: "劳动仲裁答辩书（草稿）.docx",
    needsParties: true,
    verb: "开始起草",
    goal: "请起草劳动仲裁答辩书：收到仲裁申请书副本的日期：{received_on}；请算出答辩期届满日，管辖异议与反申请须在期满前提出；员工请求：{claims}。",
    fields: [
      { key: "received_on", label: "收到申请书日期", kind: "date", required: true, help: "答辩期与管辖异议、反申请期限从这天起算" },
      { key: "claims", label: "员工请求", kind: "text", placeholder: "例如：违法解除赔偿金 12 万元、加班费" },
    ],
    minMaterials: 1,
    steps: ["先算答辩期届满日，提示管辖异议与反申请的截止", "按程序、事实、法律三层逐项回应员工请求", "复核员工的计算，原数与复算并列", "论点交你确认后生成答辩书与附件"],
    intents: [["劳动仲裁", "答辩"], ["员工", "仲裁", "答辩书"], ["收到", "员工", "劳动仲裁"], ["员工告", "答辩"]],
    notFor: ["商事仲裁"],
  },
  {
    id: "labor-termination",
    line: "inhouse",
    title: "解除员工前的风险评估",
    gives: "拟解除的理由与证据、规章制度及其制定公示材料",
    gets: ["解除风险评估.docx", "解除程序核对清单.xlsx（附件）", "请求项与敞口表.xlsx（附件，敞口情景）"],
    scenario: "a1.agent_task",
    skill: "labor-dispute",
    args: { mode: "解除前评估", side: "用人单位" },
    // 第 31 批：方法 outputs 第一项是《劳动争议应对方案》；解除前评估要的是《解除风险评估》
    primary: "解除风险评估.docx",
    verb: "开始评估",
    goal: "请评估拟解除这名员工的风险与程序：解除理由为{reason}。入职日期：{hired_on}；月工资：{monthly_wage}。",
    fields: [
      { key: "reason", label: "解除理由", kind: "select", options: ["严重违反规章制度", "试用期间被证明不符合录用条件", "不能胜任工作", "医疗期满不能工作", "客观情况重大变化", "经济性裁员", "劳动合同期满终止（不续签）", "协商一致解除", "其他"], required: true },
      ...LABOR_BASICS.filter((f) => f.key === "hired_on" || f.key === "monthly_wage").map(more),
    ],
    minMaterials: 1,
    steps: ["核对解除理由与法定依据是否对得上", "检查规章制度是否经民主程序并公示", "列出通知工会、送达等程序步骤", "列出两种情景的敞口（不替公司定金额）"],
    intents: [["解除", "员工"], ["辞退"], ["开除", "员工"], ["解除劳动合同前"], ["解除劳动合同", "风险"], ["解除通知", "员工"]],
    // 第 34 批路由体检：员工已经主张、已经申请仲裁或起诉的是应诉，不是“解除前”的评估
    notFor: ["员工主张", "员工要求", "员工已", "申请仲裁", "仲裁申请", "起诉"],
  },
  {
    // v9.4 第 21 批：原“即将推出”的规章制度审查转正（policy-review）
    id: "policy-review",
    line: "inhouse",
    title: "规章制度审查",
    gives: "规章制度或员工手册；制定与公示的材料（如有）",
    gets: ["规章制度审查意见.docx", "逐条审查表.xlsx"],
    scenario: "a1.agent_task",
    skill: "policy-review",
    verb: "开始审查",
    goal: "请审查这份{policy_type}：逐条看内容是否合法、是否与劳动合同冲突，并核对民主程序与公示材料；所在地：{place}。审查目的：{purpose}。",
    fields: [
      { key: "policy_type", label: "制度类型", kind: "select", options: ["员工手册", "考勤与工时制度", "薪酬与绩效制度", "奖惩与违纪处理制度", "休假制度", "其他规章制度"], required: true },
      { key: "purpose", label: "审查目的", kind: "select", options: ["新制定", "修改现有制度", "例行体检", "拟据此处理或解除员工"] },
      { key: "place", label: "所在地", kind: "text", placeholder: "例如：上海市", help: "核对地方规定用；事项里填过地域的不用再填", more: true },
    ],
    minMaterials: 1,
    steps: ["逐条审查内容是否合法、是否与劳动合同冲突", "核对制定时的讨论、协商与公示材料，缺什么写什么", "逐条给修改建议与补正步骤（不补造历史记录）", "地方规定列入待核，按你提供的文件再写"],
    intents: [["规章制度"], ["员工手册"], ["制度", "审查"], ["民主程序"], ["公示", "制度"]],
  },
  {
    // v9.4 新增（S1 §5.4 #2）：企业收到起诉状或仲裁申请后的第一步——程序期限与管辖（procedure-check）
    id: "suit-received",
    line: "inhouse",
    title: "收到起诉或仲裁：第一步",
    gives: "起诉状或仲裁申请书、相关合同（商事仲裁的附该机构现行仲裁规则）",
    gets: ["管辖与时效核查表.xlsx（含各项期限）", "内部通报要点（写在答复里）"],
    scenario: "a1.agent_task",
    skill: "procedure-check",
    verb: "开始核查",
    // 第 26 批（评审 S2-03、S2-14）：先分清收到的是哪种文书——民诉、商事仲裁、劳动仲裁三套期限不互相套用
    args: { side: "已被诉" },
    goal: "公司收到了{doc_kind}（收到日期：{received_on}）：请列出答辩、举证、管辖异议等程序期限并核查管辖。",
    fields: [
      { key: "doc_kind", label: "收到的是", kind: "select", options: ["民事起诉状", "商事仲裁申请书", "劳动仲裁申请书"], required: true, redirect: { "劳动仲裁申请书": { card: "labor-response", text: "劳动仲裁的答辩期、时效与举证规则不同，请改用“劳动仲裁应对”" } } },
      { key: "received_on", label: "收到日期", kind: "date", required: true, help: "答辩、举证与管辖异议期限从这天起算" },
    ],
    minMaterials: 1,
    steps: ["确认收到日期与文书类型", "期限届满日由期限工具计算，附计算过程", "核查管辖与是否有仲裁条款", "列出内部通报与需要外部律师的事项"],
    intents: [["收到", "起诉状"], ["收到", "仲裁申请"], ["收到", "传票"]],
  },
];

/** “已知争点”文本 → 争点列表（“；”、分号或换行隔开；去空、去重，至多 20 条、每条 200 字）。 */
export function splitIssues(text: string): string[] {
  return [...new Set(text.split(/[；;\n]+/).map((x) => x.trim().slice(0, 200)).filter(Boolean))].slice(0, 20);
}

/** 按律师填写生成任务说明：空字段所在的分句省略。 */
/**
 * 完成后“接着做”（UIUX 增量评审 D-4）：场景 → 下一步常做的场景（诉讼链：整理案卷 → 金额测算 → 起草起诉状；审合同 → 给不同受众的版本……）。
 * 只列已有的场景卡；点开的是下一场景的开始面板（同一事项），材料在面板里照常勾选。
 */
export const NEXT_STEPS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  casefile: ["issues", "case-analysis", "amount"],
  "case-analysis": ["issues", "pleading", "defense", "litigation-budget"],
  issues: ["pleading", "defense", "amount"],
  defense: ["cross-exam", "hearing-outline", "agency"],
  "cross-exam": ["hearing-outline", "agency"],
  // 诉讼线的下一步指向诉讼线的进展报告卡（第 27 批，S2-18）
  agency: ["case-report-lit"],
  appeal: ["hearing-outline", "case-report-lit"],
  "arbitration-app": ["preservation", "hearing-outline"],
  "hearing-outline": ["agency", "cross-exam"],
  preservation: ["pleading", "arbitration-app"],
  enforcement: ["case-report-lit"],
  "corporate-resolutions": ["closing-checklist", "contract-draft"],
  "closing-checklist": ["corporate-resolutions"],
  "policy-review": ["labor-termination", "compliance-qa"],
  "labor-response": ["labor-arb-defense", "research-lit", "citation-audit"],
  "labor-termination": ["policy-review", "labor-response"],
  "labor-apply": ["labor-arb-application", "amount", "research-lit"],
  "labor-arb-application": ["amount", "citation-audit"],
  "intake-lit": ["casefile", "procedure"],
  procedure: ["amount", "pleading"],
  "suit-received": ["case-analysis", "defense", "litigation-budget"],
  "contract-draft": ["contract-review", "audience-pack"],
  "dd-list": ["dd-findings"],
  "dd-findings": ["contract-draft", "closing-checklist", "research-deal"],
  amount: ["pleading", "demand-lit"],
  // 第 31 批（审查 B-18）：诉讼线的起诉状、律师函之后也指向诉讼线的进展汇报卡（原指向企业法务的“重大案件进展汇报”）
  pleading: ["preservation", "hearing-outline", "case-report-lit"],
  "research-lit": ["citation-audit", "pleading", "demand-lit"],
  "citation-audit": ["pleading", "agency"],
  "demand-lit": ["case-report-lit"],
  intake: ["research-lit", "casefile"],
  "contract-review": ["redline-notes", "redraft", "audience-pack"],
  "redline-notes": ["redraft", "audience-pack"],
  redraft: ["redline-notes", "audience-pack"],
  "contract-review-inhouse": ["audience-pack", "compliance-qa"],
  "research-deal": ["contract-review"],
  "compliance-qa": ["demand-inhouse"],
  "legal-opinion": ["audience-pack"],
  // 第 61 批：研读裁判文书之后上诉、执行或汇报；类案比对之后写上诉状、代理词
  "ruling-digest": ["appeal", "litigation-budget", "enforcement"],
  // 第 65 批：测算之后起诉、汇报或发函
  "litigation-budget": ["pleading", "case-report-lit", "demand-lit"],
  "case-law": ["appeal", "agency", "research-lit"],
  performance: ["demand-inhouse", "procedure", "amount"],
  privacy: ["compliance-qa", "contract-review-inhouse"],
});

/** 本次任务对应的场景卡：按方法模板（Agent 场景）或工作流场景找第一张；找不到返回 null。 */
export function scenarioOfRun(run: { scenario?: string | null; input_snapshot?: any } | null | undefined, preferLine?: BusinessLine | null): ScenarioCard | null {
  if (!run) return null;
  let snap: any = run.input_snapshot;
  if (typeof snap === "string") {
    try {
      snap = JSON.parse(snap);
    } catch {
      snap = null;
    }
  }
  const skill = typeof snap?.skill === "string" ? snap.skill : null;
  // 同一方法模板在不同业务线有不同卡（复核 S6B-05）：优先律师当前所在的业务线
  const pick = (cands: ScenarioCard[]) => (preferLine ? cands.find((c) => c.line === preferLine) : undefined) ?? cands[0] ?? null;
  if (run.scenario === "a1.agent_task") {
    if (!skill) return null;
    const same = SCENARIOS.filter((c) => c.skill === skill);
    // 同一方法的不同模式（第 61 批：法规研究 / 类案比对）：按任务快照里的方法参数找固定参数一致的那张卡
    const args = snap?.skill_args && typeof snap.skill_args === "object" ? (snap.skill_args as Record<string, unknown>) : null;
    const byArgs = args ? same.filter((c) => c.args && Object.entries(c.args).every(([k, v]) => args[k] === v)) : [];
    if (byArgs.length > 0) return pick(byArgs);
    // 没有固定参数对得上的：先找不带固定参数的通用卡，没有再按原来的顺序
    const plain = same.filter((c) => !c.args);
    return pick(plain.length > 0 ? plain : same);
  }
  return pick(SCENARIOS.filter((c) => c.scenario === run.scenario));
}

export function nextScenarios(card: ScenarioCard | null): ScenarioCard[] {
  if (!card) return [];
  return (NEXT_STEPS[card.id] ?? []).flatMap((id) => SCENARIOS.filter((c) => c.id === id)).slice(0, 3);
}

/** 卡片字段 → 方法参数（v9.4：显式传给 Agent，不只拼进任务说明）。空值不传；多选用“、”连接；每项至多 300 字。纯函数。 */
export function skillArgsOf(card: Pick<ScenarioCard, "fields" | "args">, values: Record<string, string | string[]>): Record<string, string> {
  const out: Record<string, string> = { ...(card.args ?? {}) };
  for (const f of card.fields) {
    const v = values[f.key];
    const s = (Array.isArray(v) ? v.join("、") : (v ?? "")).trim();
    // 选了“不用”这类空说法的选项（V16 F4）不作为方法参数
    if (f.goalText && f.goalText[s] === "") continue;
    // 长文字与逐项请求只拼进任务说明（第 55 批）
    if (f.goalOnly) continue;
    if (s && /^[a-z][a-z_]{0,31}$/.test(f.key)) out[f.key] = [...s].slice(0, 300).join("");
  }
  return out;
}

/**
 * 按勾选的材料补的方法参数（第 31 批，审查 B-13、B-21）：回稿重审的“上一稿 / 回稿”原先只写在任务说明的“按勾选顺序”里，
 * 助手看到的材料目录按导入时间排序，先导入回稿时会把两稿弄反；文稿体检只核一份时把这份的文件名写明。参数值是文件名。
 */
export function docArgsFor(card: Pick<ScenarioCard, "skill">, names: readonly string[]): Record<string, string> {
  if (card.skill === "redraft-review" && names.length >= 2) return { baseline: names[0]!.slice(0, 120), current: names[1]!.slice(0, 120) };
  if (card.skill === "citation-check" && names.length === 1) return { document: names[0]!.slice(0, 120) };
  return {};
}

/** 本次发起的主交付物（第 31 批）：primaryBy 按律师选的值取，没有对应时取 primary；都没有返回 undefined（内核取方法 outputs 第一项）。 */
export function primaryOutputOf(card: Pick<ScenarioCard, "primary" | "primaryBy">, values: Record<string, string | string[]>): string | undefined {
  const v = card.primaryBy ? values[card.primaryBy.field] : undefined;
  const picked = typeof v === "string" ? card.primaryBy!.map[v] : undefined;
  return picked ?? card.primary;
}

/**
 * 开始面板的初值（第 35 批真实走查 R3）：卡片有必填的“问题 / 研究问题”时，律师在输入框里写的整段话就是问题——预填进该栏、补充要求留空。
 * 原先整段进了“补充要求”，必填的“问题”为空、开始按钮点不了，律师只好在问题栏写“见补充要求中的三个问题”。其余卡片照旧作为补充要求。
 */
/** 承载律师主要请求的必填栏：问题、修改意见、基本情况、履约问题（第 35 批 R7：修改意见整段进了“补充要求”，开始按钮点不了，与 R3 的“问题”栏同一类）。 */
const PRIMARY_FIELDS = new Set(["question", "opinion", "situation", "issue"]);

export function startPanelInitial(card: ScenarioCard, request: string | null | undefined): { values: Record<string, string>; extra: string } {
  const text = (request ?? "").trim();
  const q = card.fields.find((f) => PRIMARY_FIELDS.has(f.key) && f.required && (f.kind === "text" || f.kind === "long"));
  if (q && text) return { values: { [q.key]: text }, extra: "" };
  // 第 55 批：整段话进了案情栏的（见 startPanelBrief），补充要求留空
  return { values: {}, extra: startPanelBrief(card, request) ? "" : (request ?? "") };
}

/**
 * 案情栏的初值（第 55 批）：可以直接写案情的卡，律师在输入框里写的长段话就是案情——原来进了标着“可选”的补充要求。
 * 一两句的要求（不足 40 字）仍作补充要求；卡片有必填的“问题 / 意见”主栏时归主栏。
 */
export function startPanelBrief(card: ScenarioCard, request: string | null | undefined): string {
  const text = (request ?? "").trim();
  if (!card.brief || [...text].length < 40) return "";
  if (card.fields.some((f) => PRIMARY_FIELDS.has(f.key) && f.required && (f.kind === "text" || f.kind === "long"))) return "";
  return text;
}

/** 逐项请求拼成“1. …；2. …”（第 55 批）：去掉空行与每项末尾的标点；只有一项时不编号。纯函数。 */
export function numbered(items: readonly string[]): string {
  const rows = items.map((x) => x.trim().replace(/[。；;，,]+$/, "")).filter(Boolean);
  return rows.length <= 1 ? (rows[0] ?? "") : rows.map((x, i) => `${i + 1}. ${x}`).join("；");
}

/** 案情说明存成材料时的文件名（第 55 批）：固定前缀，方法与工作准则按这个名字认它是“律师陈述”。 */
export function briefFilename(day: string): string {
  return `案情说明（律师口述）${day}.txt`;
}
/** 案情说明至少写这么多字才算数（几个字的“见附件”不算案情）。 */
export const BRIEF_MIN_CHARS = 15;

/**
 * 这张卡现在缺不缺“案情”（第 55 批）：可以直接写案情的卡，在本事项没有材料、没有任何事实、律师也没写案情时不能开始——
 * 否则助手只能凭事项名称猜。facts 为 null（还没读到）时不拦。纯函数。
 */
export function caseGap(card: Pick<ScenarioCard, "brief" | "scenario">, s: { matterDocs: number; facts: number | null; brief: string }): boolean {
  if (!card.brief || card.scenario !== "a1.agent_task") return false;
  return s.matterDocs === 0 && s.facts === 0 && [...s.brief.trim()].length < BRIEF_MIN_CHARS;
}

/** 任务说明里指向案情说明的一句（写了案情才有）。 */
export function briefGoalLine(card: Pick<ScenarioCard, "brief">, brief: string, day: string): string {
  if (!card.brief || !brief.trim()) return "";
  return `${card.brief.label}见材料《${briefFilename(day)}》：这是我对情况的陈述，先读它；其中的事实按“待我确认”处理，不列进证据目录。`;
}

/**
 * 企业法务线的读者口径（第 57 批全量验收，合同审核一单）：同一个审合同方法给律所和企业法务两条线用，企业法务写给本公司采购与分管领导的意见书里
 * 出现“需客户决定”十余处、“本所覆盖规则”“不得直接发送客户或对方”，也没有致送对象和落款。方法是共用的，口径差别由发起任务的这一句交代。
 */
export const INHOUSE_READER_LINE = "读者是本公司的业务部门与管理层：按企业法务的口径写，称“我方”“公司”，需要别人拍板的写“需业务部门决定”或“需管理层决定”，不写“客户”“本所”“律师处理”；给业务部门或管理层看的文书留出致送对象、出具部门与日期。";

export function buildGoal(card: ScenarioCard, values: Record<string, string | string[]>, extra: string): string {
  const parts = card.goal.split(/(?<=[。；])/);
  const out = parts
    .map((seg) => {
      let empty = false;
      const filled = seg.replace(/\{(\w+)\}/g, (_m, k: string) => {
        const v = values[k];
        const field = card.fields.find((f) => f.key === k);
        const raw = Array.isArray(v) ? (field?.kind === "list" ? numbered(v) : v.join("、")) : (v ?? "").trim();
        const map = field?.goalText;
        const s = map && typeof v === "string" && v in map ? map[v]!.trim() : raw;
        if (!s) empty = true;
        return s;
      });
      // 填进来的话自己已带句末标点（第 35 批 R3：输入框里的问题预填进“问题”栏，任务说明成了“……法律意见书。。”）：不再叠模板的句号
      return empty ? "" : filled.replace(/([。！？!?；;.])\s*[。；]$/, "$1");
    });
  // 第 55 批：一句话末尾的几段没填、被整段省略时，把留下来的最后一段的“；”改回“。”
  // （“…我方：原告；标的额：{amount}。”没填标的额时原来成了“…我方：原告；”，分号后面直接接下一句）
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== "" || !parts[i]!.endsWith("。")) continue;
    let j = i - 1;
    while (j >= 0 && out[j] === "") j--;
    if (j >= 0 && out[j]!.endsWith("；")) out[j] = `${out[j]!.slice(0, -1)}。`;
  }
  return [out.join("").trim(), card.line === "inhouse" ? INHOUSE_READER_LINE : "", extra.trim()].filter(Boolean).join("\n");
}

/**
 * 律师说“要什么”的句子（第 34 批真实走查）：带“帮 / 请 / 起草 / 写一份……”的句子。律师常把案情一并写进来，
 * 事实里的“违约金……分段计算”“对方要求修改”会和请求句里的“起草起诉状”同分甚至排除它——“帮我起草一份民事起诉状。基本事实：……
 * 违约金分段计算……”原先被建议成“金额测算”（只出 Excel）。
 */
const ASK_RE = /帮|(?<![申诉提报])请(?!求)|麻烦|给我|我要|我想|想要|需要你|起草|草拟|拟一份|拟个|写一份|写个|出一份|出个|做一份|做个/;
function askSentences(goal: string): string {
  return goal
    .split(/[。！？!?；;\n]/)
    .filter((s) => ASK_RE.test(s))
    .join("。")
    .replace(/\s+/g, "");
}

function bestScenarioIn(g: string): ScenarioCard | null {
  // 取命中最具体的一张（命中词的总字数最多；复核 B3-B24：“核对起诉状里的引用”应引向引用核验，而不是起草起诉状）
  let best: ScenarioCard | null = null;
  let bestScore = 0;
  // 与最高分同分的审合同卡（第 35 批真实走查 N3：“审查……合同”与“修改……合同”同分时原先按卡片顺序取了“按你的意见修改文书”，
  // 律师要的审查意见书不会出）：同分时看动作——有明确的改写动作才是我方改原件，否则是审查
  let reviewTie: ScenarioCard | null = null;
  for (const c of SCENARIOS) {
    if (c.notFor?.some((w) => g.includes(w))) continue;
    for (const words of c.intents) {
      if (!words.every((w) => g.includes(w))) continue;
      const score = words.join("").length;
      if (score > bestScore) {
        best = c;
        bestScore = score;
        reviewTie = null;
      } else if (score === bestScore && best?.skill === "doc-revise" && c.skill === "contract-review") reviewTie = c;
    }
  }
  if (best?.skill === "doc-revise" && reviewTie && !REVISE_ACTION_RE.test(g)) return reviewTie;
  return best;
}

/** 我方直接改原件的动作（第 35 批）：“改成 / 改为 / 删去 / 增加一款 / 出修订稿 / 在原件上 / 按……意见改”。 */
const REVISE_ACTION_RE = /改成|改为|修改为|改到|删去|删除|删掉|增加一款|加一款|增加一条|加一条|修订稿|清洁稿|清洁版|修订痕迹|原件上|直接改|直接修改|按[^，。；]{0,12}意见[^，。；]{0,6}(?:修改|改)/;

/** 意图建议：根据律师输入的任务描述建议一个业务场景（本机关键词规则，不联网；不自动切换）。先只看请求句，请求句里认不出再看全文。 */
export function suggestScenario(goal: string): ScenarioCard | null {
  const g = goal.replace(/\s+/g, "");
  if (g.length < 4) return null;
  const ask = askSentences(goal);
  // 一句话要几种成果（“整理成证据目录，并写一份证据分析”）：任何一张卡都给不全，不建议，交给助手按描述分步做（第 34 批 T6 真实走查）
  if (ask && COMPOUND_RE.test(ask) && matchedCards(ask).size >= 2) return null;
  // 要交付的东西是“出 / 写 / 起草 + 一份”后面那个名词（第 34 批：“结合章程、董事会决议和保证合同，出一份法律意见书”里的“董事会决议”是材料）
  const wanted = deliverablePhrase(ask || g);
  return (wanted ? bestScenarioIn(wanted) : null) ?? (ask && ask !== g ? bestScenarioIn(ask) : null) ?? bestScenarioIn(g);
}

const DELIVER_VERB_RE = /(?:出具|起草|草拟|撰写|拟|写|出|做|准备|形成)(?:一份|一个|一封|一套|份|个|封)/g;
/** 请求里最后一个“出 / 写 / 起草 + 一份”之后、到标点为止的短语；没有返回 null。 */
function deliverablePhrase(text: string): string | null {
  let last: RegExpExecArray | null = null;
  for (let m = DELIVER_VERB_RE.exec(text); m; m = DELIVER_VERB_RE.exec(text)) last = m;
  DELIVER_VERB_RE.lastIndex = 0;
  if (!last) return null;
  const rest = text.slice(last.index + last[0].length).split(/[，。；;！？!?,\n（(]/)[0]!.replace(/\s+/g, "");
  return rest.length >= 2 ? rest : null;
}

const COMPOUND_RE = /并(?:且)?(?:写|出|起草|做|附|算|整理|列|核|分析|准备)|同时(?:写|出|起草|做|算|整理|列)|还要(?:写|出|起草|做|算|整理)|另(?:写|出)|再(?:写|出)一份/;
/** 请求句点到的卡（不看排除词：排除词挡掉的卡，它的成果也是律师点名要的）。 */
function matchedCards(g: string): Set<string> {
  const ids = new Set<string>();
  for (const c of SCENARIOS) if (c.intents.some((words) => words.every((w) => g.includes(w)))) ids.add(c.id);
  return ids;
}

/** 材料不齐时能否先开始（Z3 评审 #4）：卡片声明允许、且是 Agent 场景。 */
export function canStartPartial(card: Pick<ScenarioCard, "allowPartial" | "scenario">): boolean {
  return card.allowPartial === true && card.scenario === "a1.agent_task";
}

/** 缺材料时的一句提示：审合同类写“请先添加合同”，回稿比对写清要哪两份，其余写还差几份。 */
export function missingMaterialsText(card: Pick<ScenarioCard, "scenario" | "skill">, need: number): string {
  if (card.scenario === "s1b.draft_compare") return "请依次勾选基线稿与对方回稿";
  if (card.skill === "contract-review") return "请先添加合同";
  if (card.skill === "doc-revise") return "请先添加要修改的 Word 文书";
  if (card.skill === "redraft-review") return "请依次勾选我方上一稿与对方回稿";
  return `还需要选择 ${need} 份材料`;
}

const LITIGATION_STANCES = new Set(["原告", "被告", "申请人", "被申请人", "第三人", "上诉人", "被上诉人", "劳动者", "plaintiff", "defendant"]);
const TRANSACTIONAL_STANCES = new Set(["受让方", "转让方", "买方", "卖方", "出租人", "承租人", "出租方", "承租方", "投资方", "目标公司", "出借人", "借款人", "保证人", "委托方", "服务方", "发包人", "承包人", "创始股东", "buyer", "seller", "lessee", "lessor"]);
// 用人单位立场多是企业法务线（劳动仲裁应对、解除前评估）；劳动者一方归诉讼仲裁线（v9.4 新增立场）
const INHOUSE_STANCES = new Set(["常年顾问", "用人单位"]);

/**
 * 事项属于哪条业务线（Z3 评审 #1）：事项本身没有业务线字段，按立场推断（诉讼立场 → 诉讼仲裁；交易立场 → 非诉；常年顾问 → 企业法务）；
 * 立场为“其他”等看不出时返回 null（不判定为不一致）。
 */
export function matterLine(m: { stance?: string | null } | null | undefined): BusinessLine | null {
  // 立场带括注（“申请人（劳动者）”“原告（反诉被告）”，旧数据或接口写入）按括注前的词判断
  const st = String(m?.stance ?? "").trim().replace(/[（(].*$/, "").trim();
  if (LITIGATION_STANCES.has(st)) return "litigation";
  if (TRANSACTIONAL_STANCES.has(st)) return "transactional";
  if (INHOUSE_STANCES.has(st)) return "inhouse";
  return null;
}

/**
 * “我方是”按事项立场预选（第 31 批真实走查：事项立场已是“劳动者”，开始面板仍要再选一次）：
 * 立场（含括注里的词，“申请人（劳动者）”）与选项或选项的一半（“原告 / 申请人”）相同才预选；对不上返回 null，留给律师选。
 */
export function sideOptionFor(options: readonly string[] | undefined, stance: string | null | undefined): string | null {
  const st = String(stance ?? "").trim();
  if (!options || !st) return null;
  const words = [st.replace(/[（(].*$/, "").trim(), ...[...st.matchAll(/[（(]([^）)]+)[）)]/g)].map((m) => m[1]!.trim())].filter(Boolean);
  for (const w of words) {
    const hit = options.find((o) => o === w || o.split(/\s*\/\s*/).includes(w));
    if (hit) return hit;
  }
  return null;
}

type PickableMatter = { matter_id: string; stance?: string | null; created_at?: string | null; activity?: { last_at?: string } | null };

/**
 * 开始面板的默认事项（Z3 评审 #1）：业务线与卡片一致的事项里，优先当前事项，其次最近用过的；
 * 没有一致的，退到看不出业务线的事项；都没有就返回 null（默认“新建事项”）。不会把非诉卡默认挂到诉讼事项上。
 * 当前事项看不出业务线（立场“其他”等）时照用当前事项——它不算不一致（lineMismatchText 也不提醒）；
 * 原先会被任意一件业务线一致的事项（常是示例事项）抢走，连同那件事项的材料一起默认勾选（第 31 批真实走查）。
 */
export function pickMatterForCard(card: Pick<ScenarioCard, "line">, matters: PickableMatter[], currentId: string | null): string | null {
  const current = matters.find((m) => m.matter_id === currentId);
  if (current && matterLine(current) === null) return current.matter_id;
  const recency = (m: PickableMatter) => String(m.activity?.last_at ?? m.created_at ?? "");
  const byRecent = [...matters].sort((a, b) => recency(b).localeCompare(recency(a)));
  for (const want of [card.line, null] as (BusinessLine | null)[]) {
    const cands = byRecent.filter((m) => matterLine(m) === want);
    if (cands.length === 0) continue;
    return (cands.find((m) => m.matter_id === currentId) ?? cands[0]!).matter_id;
  }
  return null;
}

/**
 * 开始面板挂哪个事项（复核 B13-U05）：指定了事项（深链 #/start/<场景>/<事项>、事项页“/ 方法”）就只用它——
 * 它不在列表里（已结案，或不在最近的 100 个里）时返回 null 并标 missing，**不**自动换成别的事项（误挂会让材料与成果进错案卷）；
 * 没指定才按卡片业务线挑。
 */
export function startMatterFor(keep: string | undefined, matters: PickableMatter[], currentId: string | null, card: Pick<ScenarioCard, "line">, chosen = false): { matterId: string | null; missing: boolean } {
  if (keep) return matters.some((m) => m.matter_id === keep) ? { matterId: keep, missing: false } : { matterId: null, missing: true };
  // 律师在首页亲手选了事项、或在输入框里对着这个事项写了任务（chosen）：照用，业务线不一致只在面板里提醒（lineMismatchText），
  // 不换成别的事项（第 34 批 T1b 真实走查：选了“承包人”立场的工程款事项，点“起草起诉状”后面板换成了另一件诉讼事项）
  if (chosen && currentId && matters.some((m) => m.matter_id === currentId)) return { matterId: currentId, missing: false };
  return { matterId: pickMatterForCard(card, matters, currentId), missing: false };
}

/** 所选事项与卡片业务线不一致时的一行提醒（不阻断）；一致或看不出时返回 null。 */
export function lineMismatchText(card: Pick<ScenarioCard, "line" | "title">, matter: { stance?: string | null } | null | undefined): string | null {
  const l = matterLine(matter);
  if (!l || l === card.line) return null;
  return `这是${LINE_LABELS[l]}事项。确定在这里做「${card.title}」吗？`;
}

/**
 * 示例事项顶部的说明（Z3 #27：非诉、诉讼两件示例各写各的试法）。诉讼示例按本机“整理案卷”任务的状态写（余项续复核 RC-B-13）：
 * done 已整理 / running 正在整理 / failed 或没有任务时写“整理未完成”。
 */
export function sampleBannerText(m: { stance?: string | null } | null | undefined, casefile: "done" | "running" | "failed" | null = "done"): string {
  // v9.4（U1 §3.5 #2）：一行说完——材料是虚构的、现在到哪一步、下一步去哪（原来 121 字）
  if (matterLine(m) === "litigation") {
    const head = "示例事项：材料虚构，只在这台电脑上。";
    if (casefile === "done") return `${head}已在这台电脑上按规则整理出证据目录和时间轴：去“事实”逐条确认，再试“争点与证据分析”或“案情分析与诉讼策略”。`;
    if (casefile === "running") return `${head}正在这台电脑上按规则整理证据目录和时间轴，稍候去“事实”逐条确认。`;
    return `${head}本机整理还没有完成：可在“任务”里重试，或重新用“整理案卷”。`;
  }
  return "示例事项：合同与审查意见是虚构的，只在这台电脑上。去“材料”打开审查意见，逐条决定后生成修订稿。";
}

/**
 * 开始面板默认勾哪些材料。documents 按导入时间新的在前（matters.get：ORDER BY created_at DESC）。
 * V14 第 39 批真实走查 T2R2：针对一份文书的方法原写“只预选最近一份 Word”，却把列表反过来取，勾上的是最早那份——
 * 律师在成果页点“作为底稿继续修改”后，开始面板勾的是原件而不是刚加进来的上一轮清洁稿，直接开始就在原件上改了第二轮。
 */
export function preselectDocs(card: Pick<ScenarioCard, "minMaterials" | "scenario" | "skill">, all: readonly { document_version_id: string; filename: string; supersedes?: string | null }[]): string[] {
  if (card.minMaterials === 0) return [];
  // 第 48 批：案卷文件夹同步后，同一文件的旧版本仍在材料里（标“旧版本”）——缺省只选最新版，旧版本要律师自己勾
  const old = new Set(all.map((d) => d.supersedes).filter((x): x is string => typeof x === "string" && x.length > 0));
  const docs = all.filter((d) => !old.has(d.document_version_id));
  // 回稿重审要按“上一稿、回稿”的顺序勾两份（第 31 批：原先全选，案卷里有第三份稿时顺序就不是律师心里那两份）
  if (card.scenario === "s1b.draft_compare" || card.skill === "redraft-review") return [];
  // 针对一份文书的方法（审合同、按意见修改、文稿体检）只预选最近一份 Word（第 31 批：后两张原先把案卷里的证据也全勾上）
  if (card.skill === "contract-review" || card.skill === "doc-revise" || card.skill === "citation-check") {
    const word = docs.find((d) => d.filename.toLowerCase().endsWith(".docx"));
    // V16 A4：“按你的意见修改文书”只在 Word 原件上改——没有 .docx 时不预选别的文件（此前会勾上一份 .txt）
    if (card.skill === "doc-revise") return word ? [word.document_version_id] : [];
    return word ? [word.document_version_id] : docs.slice(0, 1).map((d) => d.document_version_id);
  }
  return docs.map((d) => d.document_version_id);
}

/**
 * 只能在 Word 原件上做的方法（V16 A4：按你的意见修改文书）还缺 Word 文书时的一句话；不缺或不是这类方法时返回 null。
 * 事项里没有 .docx 时请律师先添加；有但没勾时请勾选。纯函数。
 */
export function wordDocGap(card: Pick<ScenarioCard, "skill">, docs: readonly { document_version_id: string; filename: string }[], picked: readonly string[]): string | null {
  if (card.skill !== "doc-revise") return null;
  const isWord = (d: { filename: string }) => d.filename.toLowerCase().endsWith(".docx");
  if (!docs.some(isWord)) return "本事项还没有 Word 文书，请先添加要修改的那份（.docx）";
  if (!docs.some((d) => isWord(d) && picked.includes(d.document_version_id))) return "请勾选要修改的那份 Word 文书（.docx）";
  return null;
}

/**
 * 开始面板勾选框下面的一句话（V18 第 43 批）：勾选就是边界。勾了的只读勾的；一份都没勾时助手可读本事项全部材料。纯函数。
 */
export function materialScopeText(picked: number, total: number): string {
  if (picked === 0) return `没有勾选材料：助手可以读本事项的全部 ${total} 份材料。只想让它看其中几份，就勾上那几份。`;
  if (picked >= total) return `助手只读勾选的材料（本事项 ${total} 份都勾了）。`;
  return `助手只读勾选的 ${picked} 份；没勾的 ${total - picked} 份这次不会读取，也不会发给 AI。`;
}

/**
 * 追问框“补充材料”下面的一句话（V18 第 43 批续三）：追问沿用上一轮勾选的材料，可以补、不能减；补了几份、还有几份不会读。纯函数。
 * prev：上一轮勾选的份数；added：这一轮补勾的份数；rest：本事项里上一轮没勾的份数（含这一轮补勾的）。
 */
export function followUpMaterialsText(prev: number, added: number, rest: number): string {
  const left = Math.max(0, rest - added);
  if (added === 0) return `沿用上一轮的 ${prev} 份材料。本事项另有 ${rest} 份没给助手：需要它看的，勾上再追问。`;
  return `沿用上一轮的 ${prev} 份，这一轮补充 ${added} 份${left > 0 ? `；其余 ${left} 份仍不会读取，也不会发给 AI` : ""}。`;
}
