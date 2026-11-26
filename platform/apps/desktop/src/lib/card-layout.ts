/**
 * 开始面板的业务形态（第 67 批，V41 工作线 B）：律师点开一张卡时，输入的重心随业务不同——
 * 起草看“要写什么 + 当事人”，审查看“那份文件 + 立场”，比对看“两稿的先后”，研究看“要回答的问题”，整理看“材料本身”。
 * 原来 52 张卡同一个模板（材料 → 要定的事 → 当事人，右栏交付 / 用量 / 去向），这里按形态决定段的顺序与段名；
 * 字段、校验、发起逻辑不变（仍由 ScenarioCard 声明）。
 */
import type { ScenarioCard } from "./scenarios.ts";

export type CardForm = "draft" | "review" | "compare" | "analyze" | "organize";
export type SectionKey = "materials" | "decide" | "parties";

/** 审查类：先有那份文件，再定立场与重点。 */
const REVIEW_SKILLS = new Set([
  "contract-review",
  "privacy-compliance",
  "performance-check",
  "policy-review",
  "due-diligence",
  "closing-checklist",
  "review-rules-draft",
  "citation-check",
  "doc-revise",
  "ruling-digest",
]);
/** 整理类：材料是主角，选项很少。 */
const ORGANIZE_SKILLS = new Set(["casefile-organize", "intake-notes", "case-report"]);
/** 研究分析类：先写清要回答的问题。 */
// 第 69 批（V43，融合审查 F-01）：第 65 批的“诉讼成本与回收测算”（litigation-budget）原来不在这里，落到起草形态——段名“文书要点”、
// 示例是原告口吻的“突出对方逾期付款”；它与金额测算同是测算类，先写测算口径、再给材料
const ANALYZE_SKILLS = new Set(["issue-evidence-matrix", "case-analysis", "amount-calc", "litigation-budget", "legal-research-memo", "client-advice", "procedure-check", "labor-dispute"]);
/** 测算类（金额测算、诉讼成本与回收测算）：要定的一段叫“测算口径”。 */
const CALC_SKILLS = new Set(["amount-calc", "litigation-budget"]);
export function isCalcCard(card: Pick<ScenarioCard, "skill">): boolean {
  return CALC_SKILLS.has(card.skill ?? "");
}

export function cardForm(card: Pick<ScenarioCard, "id" | "scenario" | "skill" | "needsParties" | "fields">): CardForm {
  if (card.scenario === "s1b.draft_compare" || card.skill === "redraft-review") return "compare";
  if (card.scenario === "s2.case_file" || card.scenario === "s6.redaction") return "organize";
  if (card.needsParties) return "draft";
  const skill = card.skill ?? "";
  if (REVIEW_SKILLS.has(skill)) return "review";
  // 收到起诉 / 仲裁、劳动仲裁应对：先看收到的文书（审查形态）；劳动者请求梳理、解除前评估：先写情况（分析形态）
  if (card.id === "suit-received" || card.id === "labor-response") return "review";
  if (ORGANIZE_SKILLS.has(skill)) return "organize";
  if (ANALYZE_SKILLS.has(skill) || skill === "due-diligence") return "analyze";
  // 其余起草类（庭审提纲、质证意见、修订说明、尽调清单……）
  return "draft";
}

/** 各段的顺序：没有的段（例如不写当事人首部）由调用方跳过。 */
export function sectionOrder(form: CardForm): SectionKey[] {
  switch (form) {
    case "draft":
      return ["decide", "parties", "materials"];
    case "analyze":
      return ["decide", "materials", "parties"];
    case "review":
    case "compare":
    case "organize":
      return ["materials", "decide", "parties"];
  }
}

/** 段名：同一段在不同业务里叫法不同（律师读到的是“这一段要我给什么”）。 */
export function sectionTitle(form: CardForm, key: SectionKey, o: { hasBrief: boolean; hasDecide: boolean; hasQuestion?: boolean; hasSide?: boolean; calc?: boolean }): string {
  if (key === "parties") return "当事人";
  if (key === "decide") {
    if (!o.hasDecide) return "补充要求";
    // 研究分析类：有“问题”栏的叫“要回答的问题”，其余（测算、争点、核查）叫“分析要点”
    if (form === "analyze") return o.hasQuestion ? "要回答的问题" : o.calc ? "测算口径" : "分析要点";
    // 审查类：卡上有“我方是”一栏才叫“立场与重点”；立场取自事项的（审合同）叫“审查重点”，立场写在事项一行
    if (form === "review") return o.hasSide ? "立场与重点" : "审查重点";
    return { draft: "文书要点", compare: "比对重点", organize: "整理方式" }[form];
  }
  if (o.hasBrief) return "案情与材料";
  return { draft: "依据材料", review: "要审的文件", compare: "两稿", analyze: "材料", organize: "案卷材料" }[form];
}

/**
 * 页脚一行“去向”（第 67 批）：开工按钮旁只说发给谁、哪些先换成代号；按原文发送的类别、检索、留存在“去向详情”里逐条列出。
 * bullets / kinds 来自内核 runs.estimate（与开始前确认同一份）。
 */
export function sendLine(bullets: readonly string[] | undefined, kinds: readonly string[] | undefined, blockKind?: string | null): { text: string; tone: "normal" | "local" | "blocked" } | null {
  if (!bullets || bullets.length === 0) return null;
  const k0 = kinds?.[0];
  // 第 69 批（独立评审）：本事项第一次用 AI、客户授权依据还没记录（block_kind = consent）——这不是“不会发送”，下一步“开始前确认”里记下即可。
  // 原来整行红字“不会发送：四项依据有‘待确认’（委托 / 保密授权、个人信息处理依据……”且被截断，律师以为这张卡不能用
  if (k0 === "blocked" && blockKind === "consent") return { text: "本事项第一次用 AI：下一步记录客户授权依据", tone: "normal" };
  if (k0 === "blocked") return { text: bullets[0]!, tone: "blocked" };
  if (k0 === "local") return { text: bullets[0]!, tone: "local" };
  const route = bullets[kinds?.indexOf("route") ?? 0] ?? bullets[0]!;
  const dest = route.split("：")[0]!.replace("（经中软转发）", "（经中软）").replace("发给律所自己的 Kimi 账号", "发给本所 Kimi 账号").replace("发给律所自己的 AI", "发给本所的 AI");
  const pi = kinds?.indexOf("protect") ?? -1;
  // 一行里只说到“等”：完整类别在“详情”里逐条列出（同一句内核原文）
  const protect = pi >= 0 ? bullets[pi]!.replace(/^(姓名(?:、公司名)?)、[^先]*先换成代号$/, "$1等先换成代号") : "";
  return { text: protect ? `${dest} · ${protect}` : dest, tone: "normal" };
}

/** 比对形态两个位置的叫法（勾选顺序即先后）：回稿重审是“上一稿 / 回稿”，不用 AI 的回稿比对是“基线稿 / 对方回稿”。 */
export function compareSlots(card: Pick<ScenarioCard, "skill">): [string, string] {
  return card.skill === "redraft-review" ? ["上一稿", "回稿"] : ["基线稿", "对方回稿"];
}

/**
 * 材料段的一句说明（第 67 批第二轮，独立评审 R1-5）：研究类卡的 gives 写的是“研究问题（可附交易文件）”——问题在上面一段，
 * 材料段只说材料：“可附交易文件，不附也能开始”。其余卡照用 gives。
 */
export function materialsHint(card: Pick<ScenarioCard, "gives" | "minMaterials">, form: CardForm): string {
  if (form !== "analyze") return card.gives;
  const m = /（可附([^）]+)）/.exec(card.gives);
  if (m) return card.minMaterials > 0 ? `附${m[1]}` : `可附${m[1]}，不附也能开始`;
  const parts = card.gives.split("；");
  if (parts.length > 1 && /问题/.test(parts[0]!)) return parts.slice(1).join("；");
  return card.gives;
}

/**
 * “补充要求”的示例逐卡写（第 67 批第三轮，独立评审 R2：形态级示例在卡之间串用——答辩状沿用了原告口吻“突出对方逾期付款”）。
 * 没列的卡按形态给一句。
 */
const CARD_EXTRA: Record<string, string> = {
  pleading: "例如：语气克制；突出对方逾期付款的事实",
  defense: "例如：重点抗辩质量异议，主张已过检验期",
  appeal: "例如：主攻一审认定事实错误，其次是适用法律",
  "arbitration-app": "例如：写明仲裁协议条款，请求与合同约定逐项对应",
  preservation: "例如：优先冻结银行账户，再查封不动产",
  enforcement: "例如：一并申请迟延履行期间的债务利息",
  "labor-arb-application": "例如：加班费按考勤记录逐月列明",
  "labor-arb-defense-lit": "例如：主张已足额支付经济补偿，附工资流水",
  "labor-arb-defense": "例如：主张已足额支付经济补偿，附工资流水",
  agency: "例如：围绕第二个争点重点展开，篇幅控制在 5 页内",
  "demand-lit": "例如：语气正式但留协商余地，付款期限 7 日",
  "demand-inhouse": "例如：先礼后兵，写明逾期的后果",
  "contract-draft": "例如：以我方范本为底稿，付款按里程碑分期",
  "corporate-resolutions": "例如：同时出具股东会决议与董事会决议",
  "hearing-outline": "例如：发问提纲单列，质证意见按证据编号排",
  "cross-exam": "例如：重点质疑证据 3 的真实性与关联性",
  "redline-notes": "例如：只列对方必须接受的 3 条底线",
  casefile: "例如：证据按时间顺序编号，复印件标注来源",
  "casefile-deep": "例如：证据按时间顺序编号，复印件标注来源",
  intake: "例如：标出需要客户补充的材料与截止时间",
  "intake-lit": "例如：标出需要客户补充的材料与截止时间",
  "case-report": "例如：控制在一页，先写结论与下一步",
  "case-report-lit": "例如：控制在一页，先写结论与下一步",
  "audience-pack": "例如：客户版保留金额，对外版隐去联系方式",
  issues: "例如：每个争点列出我方证据与缺口",
  "case-analysis": "例如：先给胜诉可能性判断，再列风险",
  amount: "例如：利息自起诉之日起算；违约金不超过损失的 130%",
  "litigation-budget": "例如：律师费按一审、二审分别列；和解方案比较一次付清与分期",
  "research-lit": "例如：只看 2021 年以后的规定与判例",
  "research-deal": "例如：重点看外资准入与经营者集中申报",
  "case-law": "例如：只看最近三年、本省法院的判决",
  "legal-opinion": "例如：先给结论，再列依据、假设与限制",
  "compliance-qa": "例如：先给结论，再列依据与可行做法",
  procedure: "例如：一并核查诉讼时效是否中断",
  "labor-apply": "例如：按月列明加班费与未休年假工资",
  "labor-termination": "例如：重点评估严重违纪的证据是否充分",
  "labor-response": "例如：先列答辩期限，再给应对要点",
  "suit-received": "例如：先算答辩期与管辖异议期",
  "contract-review": "例如：违约责任上限与交割前提条件要重点看",
  // 第 69 批：原来借用审合同的形态示例（“交割前提条件”），与裁判文书研读无关
  "ruling-digest": "例如：先算上诉期，再看事实认定与法律适用有无错误",
  "contract-review-inhouse": "例如：付款条件与验收标准要重点看",
  privacy: "例如：重点看跨境传输与单独同意",
  performance: "例如：列出对方已逾期的义务与证据",
  "policy-review": "例如：重点看与劳动合同法冲突的条款",
  "dd-findings": "例如：重大问题放在前面，按风险等级排序",
  "dd-list": "例如：交易是收购 51% 股权，目标公司做医疗器械",
  "closing-checklist": "例如：交割日前 3 天的事项单独列出",
  "rules-from-template": "例如：只整理付款与违约两章的审查要点",
  "rules-from-template-inhouse": "例如：只整理付款与违约两章的审核标准",
  "citation-audit": "例如：重点核对引用的法条版本是否有效",
  "doc-revise": "例如：只改第三部分，其余不动",
  redraft: "例如：只看实质性修改，格式调整不用列",
  "redraft-local": "例如：只看实质性修改，格式调整不用列",
};

export function extraPlaceholder(form: CardForm, isAgent: boolean, cardId?: string): string {
  if (cardId && CARD_EXTRA[cardId]) return CARD_EXTRA[cardId]!;
  if (!isAgent) return "例如：只看实质性修改，格式调整不用列";
  return {
    draft: "例如：语气克制；突出对方逾期付款的事实",
    review: "例如：违约责任上限与交割前提条件要重点看",
    compare: "例如：只看实质性修改，格式调整不用列",
    analyze: "例如：先给结论，再列依据与风险",
    organize: "例如：按时间顺序整理，标出缺的证据",
  }[form];
}

/** 下拉框“不选按 X”时把缺省写进占位（第 67 批第二轮，独立评审 R1-7：原来只写“请选择”，缺省值藏在下面的小字里）。 */
export function selectDefaultPlaceholder(help: string | undefined): string | undefined {
  const m = help ? /不选(?:时)?按[“"]?([^”"，,；。]+)[”"]?/.exec(help) : null;
  return m ? `${m[1]}（缺省）` : undefined;
}

/** 开工前（估算出来之前）先按事项设置写出去向（与内核 runs.estimate 的口径相同），估算到了再换成内核给的那一句。 */
export function provisionalSendLine(m: { model_endpoint?: string | null; data_level?: string | null; full_pseudonym?: boolean | null } | null): string | null {
  if (!m || !m.model_endpoint) return null;
  if (m.model_endpoint === "none") return "全部在这台电脑上完成，不发送任何内容";
  const dest = { standard: "发给 Kimi AI（经中软）", byok: "发给本所 Kimi 账号（不经中软）", private: "发给本所的 AI（不经中软）" }[m.model_endpoint as "standard" | "byok" | "private"] ?? "发给 AI";
  const full = m.data_level === "L3a" || !!m.full_pseudonym;
  return `${dest} · ${full ? "姓名、公司名等先换成代号" : "姓名等先换成代号"}`;
}

/** 帮助小字只是“不选按 X”时，缺省已写进占位，下面不再重复（第 67 批第三轮，独立评审 R2-7）。 */
export function helpOnlyRestatesDefault(help: string | undefined): boolean {
  return !!help && /^不选(?:时)?按[“"]?[^”"，,；。]+[”"]?。?$/.test(help.trim());
}

/**
 * 立场与文书方向对不上（第 67 批第四轮，独立评审 R3：起草答辩状挂在“我方 原告”的事项上，面板没有任何提醒）。
 * 只提醒、不拦：同一事项里也可能有反诉、交叉请求。
 */
const DEFENDANT_SIDE_CARDS = new Set(["defense", "labor-arb-defense", "labor-arb-defense-lit"]);
const PLAINTIFF_SIDE_CARDS = new Set(["pleading", "arbitration-app", "labor-arb-application", "preservation", "enforcement"]);
export function stanceMismatchText(cardId: string, stance: string | null | undefined): string | null {
  if (DEFENDANT_SIDE_CARDS.has(cardId) && stance === "plaintiff") return "这个事项我方是原告；答辩状通常由被告一方提交（有反诉时除外）。";
  if (PLAINTIFF_SIDE_CARDS.has(cardId) && stance === "defendant") return "这个事项我方是被告；这份文书通常由原告 / 申请人一方提交（有反诉时除外）。";
  return null;
}
