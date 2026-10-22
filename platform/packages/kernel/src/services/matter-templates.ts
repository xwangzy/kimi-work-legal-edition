/**
 * 事项模板（v9.4 第 22 批；评审 C1 §1 #20，借鉴 Harvey Space Templates）：新建事项时选类型，预置阶段、待办与推荐的方法。
 * 同类案件每次从零建清单容易漏步骤；模板只在创建那一刻起作用——之后阶段、待办都由律师改，模板不再管。
 *
 * 期限：模板要一个起算事实的日期（例如收到起诉状副本之日）时，届满日由 calc.deadline 同一计算推出，写进事项关键日期与一条带期限的待办；
 * 不自动设提醒——提醒要交 Kimi Work 提醒服务送达，由律师在“期限提醒”页从事项导入（与关键日期的导入同一条路）。
 * 期间与条号只写已核过原文的（民事诉讼法 2023 修正第一百二十八、一百三十、一百七十一、二百五十条，劳动争议调解仲裁法第二十七、三十条）；
 * 起算事实由律师确认，涉外、分期履行等另有规定的写在提示里，不替律师判断。
 */
import { DomainError } from "@zr-legal/domain";
import type { KernelDb } from "../db.ts";
import { calcDeadline, type DeadlineUnit } from "../tools/tools/deadline.ts";
import type { MatterStage } from "./matter-facts.ts";
import { createTodo, type AssigneeKind } from "./matter-todos.ts";

export interface MatterTemplate {
  id: string;
  title: string;
  /** 诉讼仲裁 / 非诉 / 企业法务：新建事项时分组。 */
  line: "litigation" | "transactional" | "inhouse";
  /** 一句话：适合什么事项。 */
  hint: string;
  /** 常见的我方立场（第一个为缺省）；律师可另选。 */
  stances: string[];
  stage: MatterStage | null;
  todos: { title: string; assignee_kind?: AssigneeKind }[];
  /** 推荐的方法（首页场景卡 id，概览里一行）。 */
  scenarios: string[];
  /** 起算事实：律师填日期后推出届满日。 */
  start_fact?: {
    /** 填写框的说明。 */
    label: string;
    /** 写进关键日期的名字（起算日）。 */
    start_key: string;
    /** 写进关键日期的名字（届满日）。 */
    deadline_key: string;
    period: { unit: DeadlineUnit; n: number };
    /** 届满日那条待办。 */
    todo: string;
    /** 依据与例外（律师看）。 */
    basis: string;
  };
}

export const MATTER_TEMPLATES: readonly MatterTemplate[] = [
  {
    id: "lit-contract-plaintiff",
    title: "合同纠纷一审（起诉）",
    line: "litigation",
    hint: "买卖、借款、服务等合同纠纷，我方准备起诉",
    stances: ["原告"],
    stage: "pre_filing",
    todos: [
      { title: "整理案卷：证据目录与事实时间线" },
      { title: "核对管辖与诉讼时效" },
      { title: "测算诉讼请求金额与诉讼费" },
      { title: "起草起诉状（先确认论点与依据）" },
      { title: "评估是否申请财产保全" },
    ],
    scenarios: ["casefile", "procedure", "amount", "pleading", "preservation"],
  },
  {
    id: "lit-contract-defendant",
    title: "合同纠纷一审（应诉）",
    line: "litigation",
    hint: "收到起诉状，我方是被告",
    stances: ["被告"],
    stage: "first_instance",
    todos: [
      { title: "整理对方证据，准备质证意见" },
      { title: "核对管辖：有异议须在提交答辩状期间提出" },
      { title: "整理我方证据与事实时间线" },
    ],
    scenarios: ["defense", "cross-exam", "procedure", "casefile"],
    start_fact: {
      label: "收到起诉状副本的日期",
      start_key: "收到起诉状",
      deadline_key: "答辩期届满",
      period: { unit: "day", n: 15 },
      todo: "提交答辩状（管辖异议也在此前提出）",
      basis: "《民事诉讼法》第一百二十八条：被告在收到起诉状副本之日起十五日内提出答辩状；第一百三十条：对管辖权有异议的，应当在提交答辩状期间提出。被告在境内没有住所的期间另有规定，请自行核对。",
    },
  },
  {
    id: "lit-appeal",
    title: "不服一审判决上诉",
    line: "litigation",
    hint: "一审判决已送达，我方上诉",
    stances: ["上诉人"],
    stage: "second_instance",
    todos: [
      { title: "分析一审判决，确定上诉请求与理由" },
      { title: "测算上诉费" },
      { title: "起草上诉状（先确认论点与依据）" },
    ],
    scenarios: ["appeal", "case-analysis", "amount"],
    start_fact: {
      label: "收到一审判决书的日期",
      start_key: "收到一审判决",
      deadline_key: "上诉期届满",
      period: { unit: "day", n: 15 },
      todo: "递交上诉状",
      basis: "《民事诉讼法》第一百七十一条：不服第一审判决的，有权在判决书送达之日起十五日内上诉（不服裁定的为十日）。在境内没有住所的当事人期间另有规定，请自行核对。",
    },
  },
  {
    id: "lit-enforcement",
    title: "申请强制执行",
    line: "litigation",
    hint: "判决或调解书已生效，对方不履行",
    stances: ["申请人"],
    stage: "enforcement",
    todos: [
      { title: "整理执行依据与生效证明" },
      { title: "整理被执行人财产线索" },
      { title: "起草强制执行申请书" },
    ],
    scenarios: ["enforcement", "preservation"],
    start_fact: {
      label: "生效文书规定的履行期间的最后一日",
      start_key: "履行期间最后一日",
      deadline_key: "申请执行期间届满",
      period: { unit: "year", n: 2 },
      todo: "提交强制执行申请",
      basis: "《民事诉讼法》第二百五十条：申请执行的期间为二年，从法律文书规定履行期间的最后一日起计算；分期履行的从最后一期履行期限届满之日起计算；没有规定履行期间的从法律文书生效之日起计算。申请执行时效的中止、中断适用诉讼时效的规定，请按事实另算。",
    },
  },
  {
    id: "arbitration-commercial",
    title: "商事仲裁（申请）",
    line: "litigation",
    hint: "合同约定仲裁，我方提出仲裁申请",
    stances: ["申请人"],
    stage: "arbitration",
    todos: [
      { title: "核对仲裁协议效力与约定的仲裁机构" },
      { title: "整理证据与事实时间线" },
      { title: "测算仲裁请求金额" },
      { title: "起草仲裁申请书（先确认论点与依据）" },
    ],
    scenarios: ["arbitration-app", "casefile", "amount", "procedure"],
  },
  {
    id: "labor-employee",
    title: "劳动仲裁（劳动者申请）",
    line: "litigation",
    hint: "代理劳动者主张经济补偿、赔偿金、工资等",
    stances: ["劳动者"],
    stage: "pre_filing",
    todos: [
      { title: "整理劳动合同、工资流水、解除通知等材料" },
      { title: "测算请求金额（经济补偿、赔偿金、工资差额）" },
      { title: "起草劳动仲裁申请书" },
    ],
    scenarios: ["labor-apply", "amount", "casefile"],
    start_fact: {
      label: "知道或应当知道权利被侵害的日期（如收到解除通知之日）",
      start_key: "权利被侵害之日",
      deadline_key: "仲裁时效届满",
      period: { unit: "year", n: 1 },
      todo: "提交劳动仲裁申请",
      basis: "《劳动争议调解仲裁法》第二十七条：仲裁时效期间为一年，从当事人知道或者应当知道其权利被侵害之日起计算；时效可因主张权利、对方同意履行等中断。劳动关系存续期间因拖欠劳动报酬发生争议的，不受一年限制（劳动关系终止的，自终止之日起一年内提出）。",
    },
  },
  {
    id: "labor-employer",
    title: "劳动仲裁应诉（用人单位）",
    line: "inhouse",
    hint: "员工申请了劳动仲裁，公司应诉",
    stances: ["用人单位"],
    stage: "arbitration",
    todos: [
      { title: "收集劳动合同、考勤、工资发放与解除材料" },
      { title: "测算对方请求金额（经济补偿、赔偿金、加班费）" },
      { title: "起草答辩意见与证据清单" },
    ],
    scenarios: ["labor-response", "amount", "casefile"],
    start_fact: {
      label: "收到仲裁申请书副本的日期",
      start_key: "收到仲裁申请书",
      deadline_key: "仲裁答辩期届满",
      period: { unit: "day", n: 10 },
      todo: "提交仲裁答辩书",
      basis: "《劳动争议调解仲裁法》第三十条：被申请人收到仲裁申请书副本后，应当在十日内向劳动争议仲裁委员会提交答辩书；未提交答辩书的，不影响仲裁程序的进行。",
    },
  },
  {
    id: "dd-equity",
    title: "股权收购尽调",
    line: "transactional",
    hint: "收购或投资目标公司，先做尽调",
    stances: ["受让方", "投资方"],
    stage: "due_diligence",
    todos: [
      { title: "发出尽调清单与访谈提纲" },
      { title: "收集材料，在材料页用表格审阅做合同台账" },
      { title: "尽调发现与报告（内部稿）" },
      { title: "交易文件起草与审查" },
      { title: "整理交割清单" },
    ],
    scenarios: ["dd-list", "dd-findings", "contract-draft", "closing-checklist", "corporate-resolutions"],
  },
  {
    id: "deal-contract",
    title: "合同审查与谈判",
    line: "transactional",
    hint: "审对方的合同、出修订稿、跟进回稿",
    stances: ["买方", "卖方", "委托方", "服务方", "出租人", "承租人", "发包人", "承包人"],
    stage: "negotiation",
    todos: [
      { title: "写下本事项的审查要点（客户的审查标准、底线）" },
      { title: "审查对方合同，出修订稿" },
      { title: "整理修订说明与谈判要点" },
      { title: "对方回稿：比对与重审" },
    ],
    scenarios: ["contract-review", "redline-notes", "redraft"],
  },
  {
    id: "advisory",
    title: "常年法律顾问",
    line: "inhouse",
    hint: "顾问单位的日常合同、制度与咨询",
    stances: ["常年顾问"],
    stage: "advisory",
    todos: [
      { title: "在材料页用表格审阅建合同台账" },
      { title: "审查规章制度" },
      { title: "整理常见合规问答" },
    ],
    scenarios: ["contract-review-inhouse", "policy-review", "compliance-qa"],
  },
];

export function templateById(id: string | null | undefined): MatterTemplate | null {
  return (id && MATTER_TEMPLATES.find((t) => t.id === id)) || null;
}

/** 模板起算日的校验：只收 YYYY-MM-DD（届满日要精确到日）。 */
function startDateOf(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const ok = !!m && Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[3]) >= 1 && Number(m[3]) <= new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
  if (!ok) throw new DomainError("validation", "起算日期须为 YYYY-MM-DD", 422);
  return s;
}

export interface TemplatePlan {
  template: MatterTemplate;
  key_dates: Record<string, string>;
  deadline: { date: string; steps: string[]; warnings: string[] } | null;
}

/** 创建事项之前算好：模板与起算日的校验、届满日（失败即拒绝创建，不留半个事项）。 */
export function planTemplate(templateId: unknown, start: unknown): TemplatePlan | null {
  if (templateId === undefined || templateId === null || templateId === "") {
    if (start !== undefined && start !== null && start !== "") throw new DomainError("validation", "没有选事项类型，不能填起算日期", 422);
    return null;
  }
  const t = templateById(String(templateId));
  if (!t) throw new DomainError("validation", "事项类型不存在", 422);
  const s = startDateOf(start);
  if (s && !t.start_fact) throw new DomainError("validation", `“${t.title}”不需要起算日期`, 422);
  if (!s || !t.start_fact) return { template: t, key_dates: {}, deadline: null };
  const r = calcDeadline({ start: s, period: t.start_fact.period, rule: "civil" });
  if (!r.deadline) throw new DomainError("validation", "届满日没有算出来：请检查起算日期", 422);
  return {
    template: t,
    key_dates: { [t.start_fact.start_key]: s, [t.start_fact.deadline_key]: r.deadline },
    deadline: { date: r.deadline, steps: r.steps, warnings: (r as { warnings?: string[] }).warnings ?? [] },
  };
}

/** 在创建事项的同一事务里写入模板的待办（届满日那条在最前）。 */
export function applyTemplateTodos(db: KernelDb, plan: TemplatePlan, scope: { tenant_id: string; matter_id: string; created_by: string }): number {
  const rows: { title: string; assignee_kind?: AssigneeKind; due_date?: string }[] = [];
  if (plan.deadline && plan.template.start_fact) rows.push({ title: `${plan.template.start_fact.todo}（${plan.template.start_fact.deadline_key}）`, due_date: plan.deadline.date });
  rows.push(...plan.template.todos);
  for (const r of rows) createTodo(db, { ...scope, title: r.title, assignee_kind: r.assignee_kind ?? "me", due_date: r.due_date ?? null });
  return rows.length;
}

/** 给界面的模板清单。 */
export function templatesView(): MatterTemplate[] {
  return MATTER_TEMPLATES.map((t) => ({ ...t, stances: [...t.stances], todos: t.todos.map((x) => ({ ...x })), scenarios: [...t.scenarios], ...(t.start_fact ? { start_fact: { ...t.start_fact, period: { ...t.start_fact.period } } } : {}) }));
}
