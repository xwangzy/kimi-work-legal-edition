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
  /** “这个方法会怎么做”（折叠显示）。 */
  steps: string[];
  /** 意图建议的关键词（命中即建议；词组内全部出现才算）。 */
  intents: string[][];
}

const CONTRACT_TYPES = ["股权转让", "买卖", "服务 / 技术服务", "借款与担保", "其他（通用辅助）"];

export const SCENARIOS: ScenarioCard[] = [
  // ── 诉讼仲裁 ──
  {
    id: "casefile",
    line: "litigation",
    title: "整理案卷",
    gives: "起诉材料、证据、往来函件（可多份）",
    gets: ["证据目录.xlsx", "事实时间线.xlsx", "争点—证据矩阵.xlsx"],
    scenario: "s2.case_file",
    verb: "开始整理",
    goal: "",
    fields: [],
    minMaterials: 1,
    steps: ["逐份读取材料并标出识别不全的页", "按时间整理事实并标出处", "列出证据目录与争点—证据对应", "列出缺口与待补证据"],
    intents: [["证据", "目录"], ["整理", "案卷"], ["时间线"], ["时间轴"], ["争点"]],
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
      { key: "items", label: "计算项目", kind: "multi", options: ["本金利息", "逾期违约金", "资金占用费"], required: true },
      { key: "as_of", label: "计算截止日", kind: "date" },
      { key: "rate", label: "利率口径", kind: "select", options: ["按合同约定", "LPR 加点", "待确认（先问我）"] },
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
    verb: "开始起草",
    goal: "请起草民事起诉状。拟受理法院：{court}。{extra}",
    fields: [
      { key: "court", label: "拟受理法院", kind: "text", placeholder: "可空，待确认" },
      { key: "extra", label: "补充要求", kind: "text", placeholder: "可选" },
    ],
    minMaterials: 0,
    steps: ["只采用你确认过的事实与金额", "写出诉讼请求、事实与理由", "核对引用的法条", "列出提交前核对清单"],
    // 模板只做民商事起诉状（复核 B3-B24）：答辩状、仲裁申请书不引到这里
    intents: [["起诉状"], ["起诉", "写"]],
  },
  {
    id: "research-lit",
    line: "litigation",
    title: "类案与法律研究",
    gives: "研究问题（可附材料）",
    gets: ["研究备忘录.docx", "来源与引用核验表"],
    scenario: "a1.agent_task",
    skill: "legal-research-memo",
    verb: "开始研究",
    goal: "研究问题：{question}。事件发生时点：{when}。",
    fields: [
      { key: "question", label: "研究问题", kind: "text", required: true, placeholder: "例如：股东未实缴出资时对公司债务的责任" },
      { key: "when", label: "事件时点", kind: "text", placeholder: "用于判断适用哪一版法律，可空" },
    ],
    minMaterials: 0,
    steps: ["拆解问题与适用时点", "检索法规（联网检索会先去掉当事人信息）", "逐条核对引用是否现行有效", "写成研究备忘录"],
    intents: [["研究"], ["检索"], ["类案"], ["法条", "有效"], ["现行有效"], ["核对", "引用"], ["核验", "引用"], ["引用", "法条"]],
  },
  {
    id: "demand-lit",
    line: "litigation",
    title: "律师函 / 催告函",
    gives: "合同与往来记录",
    gets: ["函件草稿.docx", "发送前核对清单"],
    scenario: "a1.agent_task",
    skill: "demand-letter",
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
    id: "redraft",
    line: "transactional",
    title: "回稿比对",
    gives: "我方基线稿 + 对方回稿（两份 Word）",
    gets: ["回稿比对报告", "差异表（含未标修订的静默改动）"],
    scenario: "s1b.draft_compare",
    verb: "开始比对",
    goal: "",
    fields: [],
    minMaterials: 2,
    steps: ["逐段比对两稿", "标出对方未用修订标记的改动", "只对改动部分重新审查"],
    intents: [["回稿"], ["对方", "修改"], ["比对"], ["对比", "版本"]],
  },
  {
    id: "audience-pack",
    line: "transactional",
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
    verb: "开始整理",
    goal: "请根据访谈记录整理访谈纪要与材料收集清单；访谈对象：{who}。",
    fields: [{ key: "who", label: "访谈对象角色", kind: "text", placeholder: "例如：公司财务负责人" }],
    minMaterials: 1,
    steps: ["整理访谈要点与待核实事项", "列出需要客户提供的材料", "生成纪要与清单"],
    intents: [["访谈"], ["纪要"], ["材料清单"], ["尽调", "清单"]],
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
    goal: "请从公司角度审核这份{type}合同，结合公司常见管理要求提示风险；重点关注：{focus}。",
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
    title: "履约风险与催告函",
    gives: "合同与履约记录",
    gets: ["风险提示", "催告函草稿.docx"],
    scenario: "a1.agent_task",
    skill: "demand-letter",
    verb: "开始处理",
    goal: "请就以下履约问题提示风险并起草催告函：{issue}。",
    fields: [{ key: "issue", label: "履约节点或违约事项", kind: "text", required: true }],
    minMaterials: 1,
    steps: ["对照合同条款梳理履约事实", "提示风险与可采取的措施", "起草催告函"],
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
    steps: ["整理程序进展与关键事实", "评估风险与金额区间", "写成一页汇报与附表"],
    intents: [["汇报"], ["进展", "报告"]],
  },
  {
    id: "labor-response",
    line: "inhouse",
    title: "劳动争议应诉准备",
    gives: "仲裁申请书与员工档案材料",
    gets: ["事实时间线.xlsx", "证据与材料缺口清单"],
    scenario: "a1.agent_task",
    skill: "casefile-organize",
    verb: "开始准备",
    goal: "请为劳动争议应诉整理材料：员工请求为{claim}；开庭日：{hearing}。",
    fields: [
      { key: "claim", label: "员工请求", kind: "text", required: true, placeholder: "一句话即可" },
      { key: "hearing", label: "仲裁开庭日", kind: "date" },
    ],
    minMaterials: 1,
    steps: ["整理劳动关系与争议事实", "对照请求列出公司需要的证据", "列出缺口与时间要求"],
    intents: [["劳动", "仲裁"], ["员工", "仲裁"], ["劳动争议"]],
  },
];

/** 按律师填写生成任务说明：空字段所在的分句省略。 */
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
