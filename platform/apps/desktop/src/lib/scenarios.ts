/**
 * 业务场景目录（用户拍板：首页按律师业务线组织——诉讼仲裁 / 非诉 / 企业法务；历史 Demo 融合方案 §4.2 首页 15 张卡、§4.4 保留字段；
 * UIUX 评审 P0-2 意图建议）。
 *
 * 场景是入口，方法是 Skill：同一方法在不同业务线用不同卡名与默认口径。每张卡写清“你给什么 → 你得到什么”，
 * 只保留事项头之外、本方法必需的 ≤ 3 个字段；其余由 Agent 在计划阶段追问。
 * 档位如实标注：所有场景都还没有通过法律质量门槛，统一为“试用”（结果是草稿，须律师复核）。
 */

export type BusinessLine = "litigation" | "transactional" | "inhouse";

export const LINE_LABELS: Record<BusinessLine, string> = { litigation: "诉讼仲裁", transactional: "非诉", inhouse: "企业法务" };

export interface ScenarioField {
  key: string;
  label: string;
  kind: "select" | "text" | "date" | "multi";
  options?: string[];
  placeholder?: string;
  required?: boolean;
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
  /** 卡片固定的方法参数（v9.4：同一方法的不同卡，例如劳动争议的“仲裁应对 / 解除前评估”）；与律师填写的字段一起作为方法参数传给 Agent。 */
  args?: Record<string, string>;
}

/**
 * 即将推出（v9.4 第 20 批；评审 S1 §5.1 第 4 条：没有方法的业务不挂到相近的方法上，宁可灰显）。只展示、不能发起。
 */
export const COMING_SOON: readonly { line: BusinessLine; title: string }[] = [
  { line: "litigation", title: "上诉状" },
  { line: "litigation", title: "仲裁申请书" },
  { line: "litigation", title: "庭审提纲" },
  { line: "litigation", title: "财产保全申请" },
  { line: "litigation", title: "强制执行申请" },
  { line: "transactional", title: "股东会与董事会文件" },
  { line: "transactional", title: "交割清单" },
  { line: "inhouse", title: "规章制度审查" },
];

/** 卡片上的交付件一行（v9.4）：去掉扩展名与括注，用“ · ”连接；完整名称在开始面板与 aria-label 里。 */
export function cardGets(c: Pick<ScenarioCard, "gets">): string {
  return c.gets.map((g) => g.replace(/（[^）]*）/g, "").replace(/\.(docx|xlsx|pptx|md|pdf)\b/gi, "").trim()).filter(Boolean).join(" · ");
}

/** 卡片上的“需要”一行（v9.4）：去掉括注里的先后顺序说明（开始面板里有）。 */
export function cardGives(c: Pick<ScenarioCard, "gives">): string {
  return c.gives.replace(/（[^）]*）/g, "").trim();
}

// 与 contract-review/references/contract-types.md 的十类一致（v9.4 合同审查补六类）；其他类型只按通用必查点审
const CONTRACT_TYPES = ["股权转让", "买卖", "服务 / 技术服务", "借款与担保", "租赁", "建设工程施工", "保密与竞业限制", "技术开发", "劳动合同（用人单位）", "投资协议（增资 / 股权收购）", "其他（通用辅助）"];

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
    fields: [{ key: "issues", label: "已知争点（可空，用“；”或换行隔开）", kind: "text", placeholder: "例如：货款是否已付清；违约金是否过高" }],
    minMaterials: 1,
    steps: [
      "逐份读取材料并标出识别不全的页",
      "按时间整理日期、金额与主体并标出处（在这台电脑上按规则整理，不调用 AI）",
      "列出证据目录；争点—证据矩阵按你给的争点列框架",
      "列出缺口与待补证据；接着可做“争点与证据分析”",
    ],
    intents: [["证据", "目录"], ["整理", "案卷"], ["时间线"], ["时间轴"]],
  },
  // 整理案卷的 AI 精读版（v9.4 第 20 批，V9.4 主文 §3.2“精读版入口”）：本机规则版之外，逐份读、逐条提交带引文的事实给你确认
  {
    id: "casefile-deep",
    line: "litigation",
    title: "整理案卷（精读版）",
    gives: "起诉材料、证据、往来函件（可多份）",
    gets: ["案卷总目录.xlsx", "事实时间线.xlsx（材料载明、推论、待确认分列）", "缺口清单.xlsx", "带引文的事实（待你确认）"],
    scenario: "a1.agent_task",
    skill: "casefile-organize",
    verb: "开始精读",
    goal: "请逐份精读本事项的案卷材料，编目、按时间整理事实（每条附原文）并列出缺口。时间线按“{perspective}”排列。",
    fields: [{ key: "perspective", label: "时间线的视角（可空）", kind: "text", placeholder: "例如：按付款线索；按对方的履约行为" }],
    minMaterials: 1,
    steps: ["列出全部材料与读取情况", "逐份阅读、编目，标出提供方与形成日期", "事实一事一行、附逐字引文，交你在“事实”里确认", "生成目录、时间线与缺口清单"],
    intents: [["精读", "案卷"], ["整理", "事实", "引文"]],
  },
  {
    id: "issues",
    line: "litigation",
    title: "争点与证据分析",
    gives: "经你确认的事实（先做“整理案卷”，再到事项页“事实”里逐条确认）",
    gets: ["争点—证据矩阵.xlsx（要件、证据、缺口、对方抗辩）", "补证清单（动作、责任人）"],
    scenario: "a1.agent_task",
    skill: "issue-evidence-matrix",
    verb: "开始分析",
    goal: "请梳理争点与证据：拟主张或需应对的请求为{claims}；我方诉讼地位：{side}。只采用我已确认的事实，不评估胜诉率。",
    fields: [
      { key: "claims", label: "拟主张或需应对的请求", kind: "text", required: true, placeholder: "例如：支付货款 120 万元及逾期利息" },
      { key: "side", label: "我方地位", kind: "select", options: ["原告 / 申请人", "被告 / 被申请人", "第三人"] },
    ],
    minMaterials: 0,
    steps: ["只用你在事实表里确认过的事实（没有确认的单列出来请你确认）", "按请求拆成要件，标出一般由哪一方举证", "把事实与证据挂到要件下，标出证据薄弱和没有证据的", "列出对方可能的抗辩和补证动作"],
    intents: [["争点"], ["证据", "支撑"], ["补证"], ["要件"]],
  },
  // Z3 评审 §2.4、§8 P2 #28：诉讼线原来没有“案情分析 / 诉讼策略”，律师动笔写文书之前要先看清争点、证据强弱与风险
  {
    id: "case-analysis",
    line: "litigation",
    title: "案情分析与诉讼策略",
    gives: "案卷材料或“整理案卷”的成果（证据目录、事实时间轴）",
    gets: ["案情分析备忘录（内部稿）.docx（争点、证据强弱、诉讼风险、下一步建议）"],
    scenario: "a1.agent_task",
    skill: "case-analysis",
    verb: "开始分析",
    goal: "请分析案情并提出诉讼策略建议：我方目标为{goal}；我方地位：{side}。未确认的事实请标出，不评估胜诉率。",
    fields: [
      { key: "goal", label: "我方目标", kind: "text", required: true, placeholder: "例如：追回货款 120 万元及违约金" },
      { key: "side", label: "我方地位", kind: "select", options: ["原告 / 申请人", "被告 / 被申请人", "第三人", "尚未起诉（我方拟起诉）", "尚未起诉（对方可能起诉）"] },
    ],
    minMaterials: 1,
    steps: ["读案卷材料与已整理的事实（没有确认的事实会标出）", "归纳争点，逐个写出双方证据的强弱和理由", "列出诉讼风险与等级（只做定性，不给胜诉率）", "按优先级给出下一步：补证、程序动作、文书、是否发函或协商"],
    // “诉讼风险”须同时说到案子本身（复核 RC-B-12：“审查这份合同的诉讼风险”是审合同；劳动争议走劳动仲裁应对）
    intents: [["案情", "分析"], ["诉讼策略"], ["怎么打"], ["案件", "诉讼", "风险"], ["起诉", "风险"], ["被诉", "风险"], ["案子", "风险"]],
    notFor: ["劳动", "审查这份", "审合同", "签了", "签订后"],
  },
  {
    id: "amount",
    line: "litigation",
    title: "金额测算",
    gives: "合同与付款记录（或直接告诉我本金与日期）",
    gets: ["计算明细.xlsx（分段、公式、起止日）"],
    scenario: "a1.agent_task",
    skill: "amount-calc",
    verb: "开始测算",
    goal: "请测算以下金额：{items}；计算截止日：{as_of}；利率口径：{rate}。",
    fields: [
      { key: "items", label: "计算项目", kind: "multi", options: ["本金利息", "逾期违约金", "资金占用费", "劳动经济补偿（N / 2N）"], required: true },
      { key: "as_of", label: "计算截止日", kind: "date" },
      { key: "rate", label: "利率口径", kind: "select", options: ["按合同约定", "LPR 加点", "LPR 倍数（如上浮 50%）", "待确认（先问我）"] },
    ],
    minMaterials: 0,
    steps: ["从合同中找出计息约定（找不到会先问你）", "按本金变动分段，每段由计算工具算出", "列出抵扣、互斥项与调整风险", "生成可复算的计算明细表"],
    intents: [["利息"], ["违约金", "计算"], ["违约金", "算"], ["测算"], ["欠款", "多少"]],
  },
  {
    id: "pleading",
    line: "litigation",
    title: "起草起诉状",
    gives: "已整理的事实与金额（建议先做“整理案卷”“金额测算”）",
    gets: ["民事起诉状（草稿）.docx", "提交前核对清单"],
    scenario: "a1.agent_task",
    skill: "pleading-draft",
    allowPartial: true,
    verb: "开始起草",
    goal: "请起草民事起诉状。拟受理法院：{court}。{extra}",
    fields: [
      { key: "court", label: "拟受理法院", kind: "text", placeholder: "可空，待确认" },
      { key: "extra", label: "补充要求", kind: "text", placeholder: "可选" },
    ],
    minMaterials: 0,
    steps: ["只采用你确认过的事实与金额", "写出诉讼请求、事实与理由", "核对引用的法条", "列出提交前核对清单"],
    // 模板只做民商事起诉状（复核 B3-B24）：答辩状另有卡（defense），仲裁申请书不引到这里
    intents: [["起诉状"], ["起诉", "写"]],
  },
  // 诉讼线文书（v9.3 主文 §5.3）：答辩状、质证意见、代理词
  {
    id: "defense",
    line: "litigation",
    title: "起草答辩状",
    gives: "对方起诉状 + 已确认的事实（建议先做“整理案卷”并确认事实）",
    gets: ["民事答辩状（草稿）.docx", "答辩要点与证据对照表.xlsx", "提交前核对清单（答辩期、管辖异议、反诉）"],
    scenario: "a1.agent_task",
    skill: "defense-draft",
    verb: "开始起草",
    goal: "请起草民事答辩状（一审）。收到起诉状副本的日期：{received_on}；被告在境内有无住所：{domicile}；总体意见：{stance}。只采用我已确认的事实。",
    fields: [
      { key: "received_on", label: "收到起诉状副本的日期", kind: "date" },
      // 被告在境内没有住所的，答辩期为三十日（复核 RB16B-13）
      { key: "domicile", label: "被告在境内有无住所", kind: "select", options: ["有", "没有（答辩期三十日）"] },
      { key: "stance", label: "总体意见", kind: "select", options: ["全部不认可", "部分认可", "待确认（先问我）"] },
    ],
    minMaterials: 1,
    steps: ["读起诉状，拆出每项诉讼请求与主张的事实", "先提示：要提管辖权异议的，须在答辩期内、实体答辩之前提出", "逐项写出我方意见与理由，只用你确认过的事实", "列出答辩期届满日、时效抗辩、反诉等核对项"],
    intents: [["答辩状"], ["答辩", "写"], ["准备", "答辩"]],
    // 模板只做民商事一审答辩（复核 RB16B-16）
    notFor: ["二审", "上诉", "仲裁", "行政", "劳动", "再审"],
  },
  {
    id: "cross-exam",
    line: "litigation",
    title: "质证意见",
    gives: "对方证据目录与证据材料",
    gets: ["质证意见（草稿）.docx", "质证意见表.xlsx（三性逐项、待办）"],
    scenario: "a1.agent_task",
    skill: "cross-exam-opinion",
    verb: "开始起草",
    goal: "请对对方证据逐项起草质证意见。我方诉讼地位：{side}；举证期限届满日：{proof_deadline}；开庭或证据交换日期：{hearing_on}。{extra}",
    fields: [
      // 质证对象是“对方”，开头不写死原告（复核 RB16B-14）；鉴定、证人出庭、调查取证申请以举证期限为准
      { key: "side", label: "我方地位", kind: "select", options: ["原告 / 申请人", "被告 / 被申请人", "第三人"], required: true },
      { key: "proof_deadline", label: "举证期限届满日", kind: "date" },
      { key: "hearing_on", label: "开庭或证据交换日期", kind: "date" },
      { key: "extra", label: "已知疑点", kind: "text", placeholder: "可选，例如：证据 3 的签章与合同不一致" },
    ],
    minMaterials: 1,
    steps: ["逐份读对方证据，核对编号与页数", "逐份写真实性、合法性、关联性与证明目的意见", "列出需要核对原件、申请鉴定或补充反证的", "写成质证意见与意见表"],
    intents: [["质证"], ["对方", "证据"]],
  },
  {
    id: "agency",
    line: "litigation",
    title: "代理词",
    gives: "庭审笔录或庭审要点 + 已确认的事实",
    gets: ["代理词（草稿）.docx", "争点与依据对照表.xlsx"],
    scenario: "a1.agent_task",
    skill: "agency-statement",
    verb: "开始起草",
    goal: "请起草代理词。法庭归纳的争议焦点：{focus_points}。只采用我已确认的事实与已质证的证据，不评估胜诉率。",
    fields: [{ key: "focus_points", label: "争议焦点", kind: "text", required: true, placeholder: "用“；”隔开，例如：货款是否已付清；违约金是否过高" }],
    minMaterials: 0,
    steps: ["按法庭归纳的焦点逐个论证", "事实只用你确认的、证据只用已质证的，注明出处", "核对引用的法条；案例只用你提供的", "写成代理词与对照表"],
    intents: [["代理词"], ["代理意见"]],
  },
  {
    // v9.4（S1 §5.2 #1）：接案第一步——访谈纪要、材料清单，加紧急期限与利益冲突待核主体（intake-notes v1.2）
    id: "intake-lit",
    line: "litigation",
    title: "新案受理与访谈",
    gives: "访谈记录或笔记、客户初步材料",
    gets: ["访谈纪要.docx", "材料收集清单.xlsx", "紧急期限与冲突待核清单.xlsx"],
    scenario: "a1.agent_task",
    skill: "intake-notes",
    allowPartial: true,
    verb: "开始整理",
    goal: "请根据访谈记录整理访谈纪要与材料收集清单，并列出紧急期限与需要做利益冲突检索的主体；案件类型：{case_type}。",
    fields: [{ key: "case_type", label: "案件类型", kind: "select", options: ["买卖合同", "借款与担保", "建设工程", "股权与公司", "劳动争议", "侵权", "其他"] }],
    minMaterials: 1,
    steps: ["整理客户陈述的事实（一律标“客户陈述”）", "列出需要客户提供的材料", "找出可能紧急的期限（只列起算事实，不推算日期）", "列出全部主体，供本所做利益冲突检索（系统不判断有无冲突）"],
    intents: [["新案"], ["接案"], ["受理", "访谈"]],
  },
  {
    // v9.4 新增（S1 §5.2 #5）：管辖与时效（procedure-check）；届满日交 calc.deadline，起算不明只给分支
    id: "procedure",
    line: "litigation",
    title: "管辖与时效核查",
    gives: "争议解决条款、催告 / 对账 / 确认函等带日期的材料",
    gets: ["管辖与时效核查表.xlsx（候选法院或机构、时效与程序期限、待核分支）"],
    scenario: "a1.agent_task",
    skill: "procedure-check",
    verb: "开始核查",
    goal: "请核查管辖与诉讼时效：拟主张的请求为{claims}。",
    fields: [{ key: "claims", label: "拟主张的请求", kind: "text", required: true, placeholder: "例如：支付货款 50 万元及逾期利息" }],
    minMaterials: 1,
    steps: ["逐字摘出争议解决条款，核对协议管辖或仲裁条款是否有效", "列出法定连接点与候选法院或机构", "整理时效起算、中断的事实与证据", "期限届满日由期限工具计算；起算不明时只给分支"],
    intents: [["管辖"], ["诉讼时效"], ["时效", "过了"], ["时效", "核查"]],
  },
  {
    // v9.4 新增：劳动者一方的仲裁申请（labor-dispute，模式 = 仲裁申请）
    id: "labor-apply",
    line: "litigation",
    title: "劳动仲裁申请（劳动者一方）",
    gives: "劳动合同、工资与考勤记录、解除通知等",
    gets: ["应主张的请求与金额表.xlsx", "举证责任与证据清单.xlsx", "仲裁申请要点.docx"],
    scenario: "a1.agent_task",
    skill: "labor-dispute",
    args: { mode: "仲裁申请", side: "劳动者" },
    allowPartial: true,
    verb: "开始梳理",
    goal: "请为劳动者梳理应主张的全部仲裁请求、时效与证据：{situation}。",
    fields: [{ key: "situation", label: "基本情况", kind: "text", required: true, placeholder: "例如：2026 年 8 月被口头辞退，未签书面合同，有加班" }],
    minMaterials: 1,
    steps: ["按事实逐项核对应主张的请求，避免漏项", "时效分两类列出（劳动报酬与其他）", "按法定规则列举证责任与要补的证据", "测算金额并写明公式与基数（草稿，待复核）"],
    intents: [["劳动者", "仲裁"], ["代理", "劳动者"], ["替员工", "仲裁"]],
  },
  {
    id: "research-lit",
    line: "litigation",
    general: true,
    // v9.4（S1 §0 第 6 条）：案例库尚未开通，卡名不再写“类案”
    title: "法规研究备忘录",
    gives: "研究问题（可附材料）",
    gets: ["研究备忘录.docx", "来源目录（来源多于 10 条时）"],
    scenario: "a1.agent_task",
    skill: "legal-research-memo",
    verb: "开始研究",
    goal: "研究问题：{question}。事件发生时点：{when}。",
    fields: [
      { key: "question", label: "研究问题", kind: "text", required: true, placeholder: "例如：股东未实缴出资时对公司债务的责任" },
      { key: "when", label: "事件时点", kind: "text", placeholder: "用于判断适用哪一版法律，可空" },
    ],
    minMaterials: 0,
    steps: ["拆解问题与适用时点", "检索法规（联网检索会先去掉当事人信息）", "逐条核对引用是否现行有效", "写成研究备忘录（案例库尚未开通：只做法规研究）"],
    intents: [["研究"], ["检索"], ["法规", "研究"], ["现行有效", "法规"]],
    // 案例库尚未开通：说“类案、案例”时不建议本卡，免得律师以为能检索案例
    notFor: ["类案", "案例"],
  },
  {
    // v9.4 新增（S1 §6.1 第 1 项）：“核对起诉状里的引用”不再被引到研究备忘录——那个方法自己写明不核已有文稿
    id: "citation-audit",
    line: "litigation",
    general: true,
    title: "文稿体检：引用与论证",
    gives: "一份文稿（我方、对方或助手起草的）",
    gets: ["引用核验表.xlsx（存在、适用、支持三项）", "改引建议（待你确认）"],
    scenario: "a1.agent_task",
    skill: "citation-check",
    verb: "开始核对",
    goal: "请核对这份文稿里的法律引用与论证；事件发生时点：{when}。",
    fields: [{ key: "when", label: "事件时点", kind: "text", placeholder: "用于判断适用哪一版法律，可空" }],
    minMaterials: 1,
    steps: ["逐条抽出文稿里的法条、司法解释与案例引用", "核对是否存在、按事件时点是否适用", "对照条文原文看能否支持结论（库外的标“支持待判”）", "列出改引建议，由你确认"],
    intents: [["核对", "引用"], ["核验", "引用"], ["引用", "法条"], ["法条", "有效"], ["现行有效"], ["文稿", "体检"]],
  },
  {
    id: "demand-lit",
    line: "litigation",
    general: true,
    title: "律师函 / 催告函",
    gives: "合同与往来记录",
    gets: ["函件草稿.docx", "发送前核对清单"],
    scenario: "a1.agent_task",
    skill: "demand-letter",
    allowPartial: true,
    verb: "开始起草",
    goal: "请起草{purpose}函件；期限要求：{deadline}。",
    fields: [
      { key: "purpose", label: "函件目的", kind: "select", options: ["催款", "催告履行", "解除通知", "其他"], required: true },
      { key: "deadline", label: "期限要求", kind: "text", placeholder: "例如：收函后 7 日内" },
    ],
    minMaterials: 0,
    steps: ["从材料中整理事实与依据", "起草函件正文", "核对引用", "列出发送前核对（收件人、送达方式、期限）"],
    intents: [["律师函"], ["催告"], ["催款函"], ["解除通知"]],
  },
  // ── 非诉 ──
  {
    id: "contract-review",
    line: "transactional",
    title: "审合同",
    gives: "一份合同（Word 最佳）",
    gets: ["逐条审查意见（在审查工作台逐项决定）", "带修订痕迹的 Word 修订稿", "审查意见书（内部稿）"],
    scenario: "a1.agent_task",
    skill: "contract-review",
    verb: "开始审查",
    goal: "请审查这份{type}合同，我方立场以事项为准；重点关注：{focus}。",
    fields: [
      { key: "type", label: "合同类型", kind: "select", options: CONTRACT_TYPES, required: true },
      { key: "focus", label: "重点关注", kind: "multi", options: ["付款", "交割 / 验收", "违约责任", "知识产权", "保密", "争议解决"] },
    ],
    minMaterials: 1,
    steps: ["通读合同、标出结构", "按我方立场逐条找出风险，引用原文", "给出修改建议与可退让方案，核对依据", "把每项意见放进审查工作台，由你逐项决定"],
    intents: [["审查", "合同"], ["审合同"], ["审查", "协议"], ["审核", "合同"], ["修改", "合同"], ["风险", "合同"]],
  },
  {
    // v9.4（S1 §0 第 5 条）：原“回稿比对”卡走本机比对、不重审，卡上却写“只对改动部分重新审查”——拆成两张，名实相符
    id: "redraft",
    line: "transactional",
    title: "对方回稿：比对与重审",
    gives: "我方上一稿 + 对方回稿（两份 Word）",
    gets: ["变更清单.xlsx（含没标修订的静默改动、我方修改采纳情况）", "新问题进审查工作台", "回稿意见（草稿）"],
    scenario: "a1.agent_task",
    skill: "redraft-review",
    verb: "开始重审",
    goal: "请比对我方上一稿与对方回稿，并只对改动部分重新审查（材料按勾选顺序：第一份是我方上一稿，第二份是对方回稿）；重点关注：{focus}。",
    fields: [{ key: "focus", label: "重点关注", kind: "multi", options: ["付款", "交割 / 验收", "违约责任", "知识产权", "保密", "争议解决"] }],
    minMaterials: 2,
    steps: ["逐段比对两稿，标出对方没用修订标记的改动", "核对我方上一轮的修改有没有被采纳", "只对改动部分重新审查，新问题放进审查工作台", "写回稿意见"],
    intents: [["回稿"], ["对方", "修改"], ["对方", "回稿"]],
  },
  {
    id: "redraft-local",
    line: "transactional",
    title: "回稿比对（不用 AI）",
    gives: "我方基线稿 + 对方回稿（两份 Word）",
    gets: ["回稿比对报告", "差异表（含未标修订的静默改动）"],
    scenario: "s1b.draft_compare",
    verb: "开始比对",
    goal: "",
    fields: [],
    minMaterials: 2,
    steps: ["在这台电脑上逐段比对两稿（不用 AI）", "标出对方未用修订标记的改动", "列出差异表；要重审改动请用“对方回稿：比对与重审”"],
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
    minMaterials: 0,
    steps: ["只取你接受或修改后接受的意见（修改过的用你的文字）", "写致客户或致对方的修订说明（致对方版不写底线与内部评估）", "整理内部谈判要点：首选、可退让、需客户决定"],
    intents: [["修订说明"], ["谈判要点"], ["修改说明"]],
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
    gets: ["合同草稿.docx", "起草说明与待定事项.xlsx"],
    scenario: "a1.agent_task",
    skill: "contract-draft",
    allowPartial: true,
    verb: "开始起草",
    goal: "请起草一份{type}合同，我方立场以事项为准；交易要点：{points}。",
    fields: [
      { key: "type", label: "合同类型", kind: "select", options: CONTRACT_TYPES, required: true },
      { key: "points", label: "交易要点", kind: "text", placeholder: "主体、标的、价款与支付、交付验收、期限……缺的会列为待定事项" },
    ],
    minMaterials: 0,
    steps: ["确认交易要点，缺的列为“待定事项”，不编造", "有本所范本先用范本", "起草后做一致性检查（定义、金额大小写、日期、互引、附件）", "写起草说明：关键条款为什么这样写、对方可能怎么改"],
    intents: [["起草", "合同"], ["拟", "合同"], ["起草", "协议"]],
  },
  {
    // v9.4 新增（S1 §5.3 #5、#6）：尽职调查两阶段（due-diligence）
    id: "dd-list",
    line: "transactional",
    title: "尽调清单与访谈提纲",
    gives: "交易简介；已有的目标公司资料（可选）",
    gets: ["尽调清单.xlsx（红旗问题在前）", "可直接发对方的资料清单", "访谈提纲.docx"],
    scenario: "a1.agent_task",
    skill: "due-diligence",
    args: { stage: "清单" },
    verb: "开始列清单",
    goal: "请为这笔{deal_type}交易列出尽调清单、可直接发给对方的资料清单与访谈提纲；关注重点：{focus}。",
    fields: [
      { key: "deal_type", label: "交易类型", kind: "select", options: ["股权收购", "增资", "资产收购", "其他"], required: true },
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
    gives: "数据室材料、访谈纪要、你在外部系统查到的工商 / 涉诉 / 执行结果",
    gets: ["尽调发现表.xlsx", "尽调报告（内部稿）.docx", "交易文件条款建议"],
    scenario: "a1.agent_task",
    skill: "due-diligence",
    args: { stage: "发现" },
    verb: "开始整理",
    goal: "请根据数据室材料、访谈纪要和导入的外部查询结果整理尽调发现与内部报告；交易类型：{deal_type}。",
    fields: [{ key: "deal_type", label: "交易类型", kind: "select", options: ["股权收购", "增资", "资产收购", "其他"], required: true }],
    minMaterials: 1,
    steps: ["每个发现写四要素：事实与材料位置、法律后果、对交易的影响、处理方案", "处理方案落到交易文件条款（先决条件、陈述保证、特别赔偿、价款调整）", "“核查受限”的事项单独列出", "客户与目标公司的陈述标“陈述”，不写成已核实"],
    intents: [["尽调", "报告"], ["尽调", "发现"]],
  },
  {
    id: "research-deal",
    line: "transactional",
    title: "交易法规研究",
    gives: "研究问题（可附交易文件）",
    gets: ["研究备忘录.docx", "来源与引用核验表"],
    scenario: "a1.agent_task",
    skill: "legal-research-memo",
    verb: "开始研究",
    goal: "研究问题：{question}。",
    fields: [{ key: "question", label: "研究问题", kind: "text", required: true, placeholder: "例如：外资并购中的经营者集中申报门槛" }],
    minMaterials: 0,
    steps: ["拆解问题", "检索法规并核对效力", "写成研究备忘录"],
    intents: [["监管"], ["审批", "要求"], ["申报"]],
  },
  {
    id: "intake",
    line: "transactional",
    title: "访谈纪要与材料清单",
    gives: "访谈录音转写或笔记",
    gets: ["访谈纪要.docx", "材料收集清单.xlsx"],
    scenario: "a1.agent_task",
    skill: "intake-notes",
    allowPartial: true,
    verb: "开始整理",
    goal: "请根据访谈记录整理访谈纪要与材料收集清单；访谈对象：{who}。",
    fields: [{ key: "who", label: "访谈对象角色", kind: "text", placeholder: "例如：公司财务负责人" }],
    minMaterials: 1,
    steps: ["整理访谈要点与待核实事项", "列出需要客户提供的材料", "生成纪要与清单"],
    intents: [["访谈"], ["纪要"], ["材料清单"]],
  },
  // ── 企业法务 ──
  {
    id: "contract-review-inhouse",
    line: "inhouse",
    title: "合同审核",
    gives: "一份合同（Word 最佳）",
    gets: ["逐条审核意见（审查工作台）", "带修订痕迹的 Word 修订稿"],
    scenario: "a1.agent_task",
    skill: "contract-review",
    verb: "开始审核",
    goal: "请从公司角度审核这份{type}合同；重点关注：{focus}。",
    fields: [
      { key: "type", label: "合同类型", kind: "select", options: CONTRACT_TYPES, required: true },
      { key: "focus", label: "重点关注", kind: "multi", options: ["付款", "验收", "违约责任", "知识产权", "保密", "数据合规"] },
    ],
    minMaterials: 1,
    steps: ["通读合同", "从公司立场逐条找出风险", "给出修改建议并核对依据", "放进审查工作台由你决定"],
    intents: [],
  },
  {
    id: "compliance-qa",
    line: "inhouse",
    title: "合规问答 / 顾问答复",
    gives: "问题（可附业务材料）",
    gets: ["顾问答复.docx（结论、假设、限制）"],
    scenario: "a1.agent_task",
    skill: "client-advice",
    verb: "开始答复",
    goal: "请答复以下问题：{question}。业务背景：{background}。",
    fields: [
      { key: "question", label: "问题", kind: "text", required: true },
      { key: "background", label: "业务背景", kind: "text", placeholder: "可选" },
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
    gets: ["履约事实与依据核对表", "催告函（草稿）.docx"],
    scenario: "a1.agent_task",
    skill: "demand-letter",
    verb: "开始处理",
    goal: "请就以下履约问题梳理履约事实与依据，并起草催告函：{issue}。",
    fields: [{ key: "issue", label: "履约节点或违约事项", kind: "text", required: true }],
    minMaterials: 1,
    steps: ["对照合同条款梳理履约事实", "核对依据，列出发送前要确认的事项", "起草催告函（期限按合同或你给的写，不自行推算）"],
    intents: [["履约"], ["逾期", "交货"], ["对方", "违约"]],
  },
  {
    id: "case-report",
    line: "inhouse",
    title: "重大案件进展汇报",
    gives: "案件材料与最新进展",
    gets: ["管理层一页汇报.docx", "进展与风险附表.xlsx"],
    scenario: "a1.agent_task",
    skill: "case-report",
    verb: "开始撰写",
    goal: "请撰写案件进展汇报，汇报对象：{audience}；截至：{as_of}。",
    fields: [
      { key: "audience", label: "汇报对象", kind: "select", options: ["管理层", "董事会", "业务部门"], required: true },
      { key: "as_of", label: "截至日期", kind: "date" },
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
    gets: ["劳动争议应对方案.docx", "请求项与敞口表.xlsx", "举证责任与证据清单.xlsx"],
    scenario: "a1.agent_task",
    skill: "labor-dispute",
    args: { mode: "仲裁应对", side: "用人单位" },
    verb: "开始准备",
    goal: "请为劳动仲裁应诉做应对方案：员工请求为{claim}；开庭日：{hearing}。",
    fields: [
      { key: "claim", label: "员工请求", kind: "text", required: true, placeholder: "一句话即可" },
      { key: "hearing", label: "仲裁开庭日", kind: "date" },
    ],
    minMaterials: 1,
    steps: ["逐项回应员工请求，核对漏项", "时效分两类列出；举证责任按法定规则分配", "逐条查解除是否合法（理由、制度程序与公示、通知工会、送达）", "测算敞口并写明公式（草稿，待复核）"],
    intents: [["劳动", "仲裁"], ["员工", "仲裁"], ["劳动争议"]],
  },
  {
    id: "labor-termination",
    line: "inhouse",
    title: "解除员工前的风险评估",
    gives: "拟解除的理由与证据、规章制度及其制定公示材料",
    gets: ["解除风险评估.docx", "解除程序核对清单.xlsx", "敞口情景表.xlsx"],
    scenario: "a1.agent_task",
    skill: "labor-dispute",
    args: { mode: "解除前评估", side: "用人单位" },
    verb: "开始评估",
    goal: "请评估拟解除这名员工的风险与程序：解除理由为{reason}。",
    fields: [{ key: "reason", label: "解除理由", kind: "select", options: ["严重违反规章制度", "不能胜任工作", "医疗期满不能工作", "客观情况重大变化", "经济性裁员", "其他"], required: true }],
    minMaterials: 1,
    steps: ["核对解除理由与法定依据是否对得上", "检查规章制度是否经民主程序并公示", "列出通知工会、送达等程序步骤", "列出合法与违法解除两种情景的敞口（不替公司定金额）"],
    intents: [["解除", "员工"], ["辞退"], ["开除", "员工"]],
  },
  {
    // v9.4 新增（S1 §5.4 #2）：企业收到起诉状或仲裁申请后的第一步——程序期限与管辖（procedure-check）
    id: "suit-received",
    line: "inhouse",
    title: "收到起诉或仲裁：第一步",
    gives: "起诉状或仲裁申请书、相关合同",
    gets: ["程序期限表（答辩、举证、管辖异议）", "管辖核查", "内部通报要点"],
    scenario: "a1.agent_task",
    skill: "procedure-check",
    verb: "开始核查",
    goal: "公司收到了起诉状或仲裁申请书（收到日期：{received_on}）：请列出答辩、举证、管辖异议等程序期限并核查管辖。",
    fields: [{ key: "received_on", label: "收到日期", kind: "date", required: true }],
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
  "case-analysis": ["issues", "pleading", "defense"],
  issues: ["pleading", "defense", "amount"],
  defense: ["cross-exam", "agency"],
  "cross-exam": ["agency"],
  agency: ["case-report"],
  "labor-response": ["research-lit", "citation-audit"],
  "labor-termination": ["labor-response"],
  "labor-apply": ["amount", "research-lit"],
  "intake-lit": ["casefile", "procedure"],
  procedure: ["amount", "pleading"],
  "suit-received": ["case-analysis", "defense"],
  "contract-draft": ["contract-review", "audience-pack"],
  "dd-list": ["dd-findings"],
  "dd-findings": ["contract-draft", "research-deal"],
  amount: ["pleading", "demand-lit"],
  pleading: ["case-report"],
  "research-lit": ["citation-audit", "pleading", "demand-lit"],
  "citation-audit": ["pleading", "agency"],
  "demand-lit": ["case-report"],
  intake: ["research-lit", "casefile"],
  "contract-review": ["redline-notes", "redraft", "audience-pack"],
  "redline-notes": ["redraft", "audience-pack"],
  redraft: ["redline-notes", "audience-pack"],
  "contract-review-inhouse": ["audience-pack", "compliance-qa"],
  "research-deal": ["contract-review"],
  "compliance-qa": ["demand-inhouse"],
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
  if (run.scenario === "a1.agent_task") return skill ? pick(SCENARIOS.filter((c) => c.skill === skill)) : null;
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
    if (s && /^[a-z][a-z_]{0,31}$/.test(f.key)) out[f.key] = [...s].slice(0, 300).join("");
  }
  return out;
}

export function buildGoal(card: ScenarioCard, values: Record<string, string | string[]>, extra: string): string {
  const parts = card.goal.split(/(?<=[。；])/);
  const out = parts
    .map((seg) => {
      let empty = false;
      const filled = seg.replace(/\{(\w+)\}/g, (_m, k: string) => {
        const v = values[k];
        const s = Array.isArray(v) ? v.join("、") : (v ?? "").trim();
        if (!s) empty = true;
        return s;
      });
      return empty ? "" : filled;
    })
    .join("");
  return [out.trim(), extra.trim()].filter(Boolean).join("\n");
}

/** 意图建议：根据律师输入的任务描述建议一个业务场景（本机关键词规则，不联网；不自动切换）。 */
export function suggestScenario(goal: string): ScenarioCard | null {
  const g = goal.replace(/\s+/g, "");
  if (g.length < 4) return null;
  // 取命中最具体的一张（命中词的总字数最多；复核 B3-B24：“核对起诉状里的引用”应引向引用核验，而不是起草起诉状）
  let best: ScenarioCard | null = null;
  let bestScore = 0;
  for (const c of SCENARIOS) {
    if (c.notFor?.some((w) => g.includes(w))) continue;
    for (const words of c.intents) {
      if (!words.every((w) => g.includes(w))) continue;
      const score = words.join("").length;
      if (score > bestScore) {
        best = c;
        bestScore = score;
      }
    }
  }
  return best;
}

/** 材料不齐时能否先开始（Z3 评审 #4）：卡片声明允许、且是 Agent 场景。 */
export function canStartPartial(card: Pick<ScenarioCard, "allowPartial" | "scenario">): boolean {
  return card.allowPartial === true && card.scenario === "a1.agent_task";
}

/** 缺材料时的一句提示：审合同类写“请先添加合同”，回稿比对写清要哪两份，其余写还差几份。 */
export function missingMaterialsText(card: Pick<ScenarioCard, "scenario" | "skill">, need: number): string {
  if (card.scenario === "s1b.draft_compare") return "请依次勾选基线稿与对方回稿";
  if (card.skill === "contract-review") return "请先添加合同";
  return `还需要选择 ${need} 份材料`;
}

const LITIGATION_STANCES = new Set(["原告", "被告", "申请人", "被申请人", "第三人", "上诉人", "被上诉人", "劳动者", "plaintiff", "defendant"]);
const TRANSACTIONAL_STANCES = new Set(["受让方", "转让方", "买方", "卖方", "出租人", "承租人", "出租方", "承租方", "投资方", "目标公司", "出借人", "借款人", "保证人", "委托方", "服务方", "发包人", "承包人", "buyer", "seller", "lessee", "lessor"]);
// 用人单位立场多是企业法务线（劳动仲裁应对、解除前评估）；劳动者一方归诉讼仲裁线（v9.4 新增立场）
const INHOUSE_STANCES = new Set(["常年顾问", "用人单位"]);

/**
 * 事项属于哪条业务线（Z3 评审 #1）：事项本身没有业务线字段，按立场推断（诉讼立场 → 诉讼仲裁；交易立场 → 非诉；常年顾问 → 企业法务）；
 * 立场为“其他”等看不出时返回 null（不判定为不一致）。
 */
export function matterLine(m: { stance?: string | null } | null | undefined): BusinessLine | null {
  const st = String(m?.stance ?? "").trim();
  if (LITIGATION_STANCES.has(st)) return "litigation";
  if (TRANSACTIONAL_STANCES.has(st)) return "transactional";
  if (INHOUSE_STANCES.has(st)) return "inhouse";
  return null;
}

type PickableMatter = { matter_id: string; stance?: string | null; created_at?: string | null; activity?: { last_at?: string } | null };

/**
 * 开始面板的默认事项（Z3 评审 #1）：业务线与卡片一致的事项里，优先当前事项，其次最近用过的；
 * 没有一致的，退到看不出业务线的事项；都没有就返回 null（默认“新建事项”）。不会把非诉卡默认挂到诉讼事项上。
 */
export function pickMatterForCard(card: Pick<ScenarioCard, "line">, matters: PickableMatter[], currentId: string | null): string | null {
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
export function startMatterFor(keep: string | undefined, matters: PickableMatter[], currentId: string | null, card: Pick<ScenarioCard, "line">): { matterId: string | null; missing: boolean } {
  if (keep) return matters.some((m) => m.matter_id === keep) ? { matterId: keep, missing: false } : { matterId: null, missing: true };
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
