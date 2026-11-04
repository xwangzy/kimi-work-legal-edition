/**
 * 交付前独立复核（V12）：助手交出 Word 文书后、结算之前，内核另起一次全新上下文的模型调用，由“复核律师”逐条对照律师的指令与方法的质量自检清单
 * 审读文书，给出“指令要点—条款”对照与按严重程度分级的缺陷；有否决类或重要缺陷、或指令要点没落实的，内核把复核意见作为下一轮交给同一会话的助手，
 * 在原文书上逐处修正（docx.edit_draft，不整份重出），律师看到的是修正后的版本与复核记录。
 *
 * 根因（V12 用例 1 独立律师评分 22/30“大改”）：律师在指令里写明的“性能不达标的违约责任要有约束力”没有被追踪到任何条款，20% 违约金只挂在
 * “整体不能实现”的分句上；助手自己的“集中自查”只查格式、金额与互引，起草人复核自己的文书看不出立场与结构上的缺口。一次独立的、带对抗视角的
 * 复核是流程步骤，不是提示词措辞：由内核强制执行、留痕、可关闭（ZR_INDEPENDENT_REVIEW=off）。
 *
 * 本文件只放纯函数（提示组装、结果解析、是否要修、修正轮的话），便于确定性测试；调用模型与续跑会话在 executor.ts。
 */

export type ReviewSeverity = "veto" | "major" | "minor";
export type ReviewIssueKind =
  | "fabricated_basis"
  | "missing_clause"
  | "logic_conflict"
  | "wrong_deliverable"
  | "unauthorized_change"
  | "instruction_gap"
  | "calculation"
  | "drafting"
  | "other";

export interface ReviewIssue {
  severity: ReviewSeverity;
  kind: ReviewIssueKind;
  /** 文书名与位置（条款号或标题）。 */
  where: string;
  /** 原文片段（至多 80 字）。 */
  quote: string;
  problem: string;
  fix: string;
}

export interface ReviewTraceRow {
  /** 律师指令里的一项要求（原话或概括）。 */
  point: string;
  /** 落实在哪一条（没有写“无”）。 */
  clause: string;
  status: "covered" | "partial" | "missing";
  note?: string;
}

export interface IndependentReview {
  trace: ReviewTraceRow[];
  issues: ReviewIssue[];
  /** 复核律师一句话结论。 */
  summary: string;
  /** 模型输出解析不了（不阻断交付，只记录）。 */
  unparsed?: boolean;
}

export const REVIEW_LIMITS = Object.freeze({ docChars: 60_000, perDocChars: 40_000, issues: 20, trace: 30, text: 300 });

const SEVERITIES = new Set<ReviewSeverity>(["veto", "major", "minor"]);
const KINDS = new Set<ReviewIssueKind>(["fabricated_basis", "missing_clause", "logic_conflict", "wrong_deliverable", "unauthorized_change", "instruction_gap", "calculation", "drafting", "other"]);

/** 复核提示（系统 + 用户两条）。文字均已令牌化（调用方负责）；规则写死，不随材料变化。纯函数。 */
export function reviewMessages(o: {
  goal: string;
  stance: string;
  jurisdiction: string;
  asOf: string;
  method: string | null;
  checklist: readonly string[];
  docs: readonly { name: string; text: string }[];
}): { role: "system" | "user"; content: string }[] {
  const system = [
    "你是律所的复核合伙人，独立审读一份由同事（起草人）交来的文书草稿。你不是起草人，不替起草人辩护；要像对方律师那样找它的漏洞，像客户那样追问指令有没有落实。",
    `我方立场：${o.stance || "未写明"}；法域：${o.jurisdiction || "中国大陆"}；分析截止日：${o.asOf}。`,
    "按以下顺序审读并只输出一个 JSON 对象（不要输出其他文字）：",
    '{"trace":[{"point":"律师指令里的一项要求","clause":"落实在哪一条（没有写“无”）","status":"covered|partial|missing","note":"为什么是部分落实或没落实"}],',
    ' "issues":[{"severity":"veto|major|minor","kind":"fabricated_basis|missing_clause|logic_conflict|wrong_deliverable|unauthorized_change|instruction_gap|calculation|drafting|other","where":"文书名·条款号","quote":"原文片段","problem":"问题","fix":"具体怎么改（给出可直接写进文书的文字或计算）"}],',
    ' "summary":"一句话结论"}',
    "规则：",
    "1. trace：把律师指令逐项拆开（每个金额、比例、期限、权利、义务、责任、争议解决、交付格式都是一项），逐项找到落实它的条款；只写了一半（例如违约责任只在解除时适用、只约定了义务没有约定后果）的记 partial。",
    "2. veto 只用于：虚构或引错法律依据、虚构重大事实（指令与材料里没有的当事人、金额、日期、承诺）、遗漏该类文书的关键条款或重要风险、重大法律逻辑矛盾（条款互相冲突、立场写反、计算基数前后不一）、交付类型错误、未经授权的重大改写。",
    "3. major：会让我方在履约或争议中明显吃亏、或律师必须改了才能发出的问题（违约责任结构失衡、触发条件与计算基数不清、与指令不符、对方最可能的抗辩没有应对）。minor：措辞、格式、可以更好但不改也能用的。",
    "4. 只报你能指出原文位置并说清改法的问题；材料里没有的信息不要求起草人编造，应写成【待填】或【待定】的不算缺陷；不重复报同一问题；最多 20 条，按严重程度排序。",
    "5. 法律依据只判断你确有把握的；拿不准的写进 problem 说“需核实”，不要定为 veto。",
    "6. 不评论排版细节与文风偏好；不要求增加与本交易无关的条款。",
  ].join("\n");
  const docBlocks = o.docs.map((d) => `【文书：${d.name}】\n${d.text}`).join("\n\n");
  const user = [
    `【律师的指令】\n${o.goal}`,
    o.method ? `【起草人所用方法】${o.method}` : "",
    o.checklist.length ? `【该方法的质量自检清单（起草人应已逐项自检，请独立复核）】\n${o.checklist.map((c, i) => `${i + 1}. ${c}`).join("\n")}` : "",
    docBlocks,
  ]
    .filter(Boolean)
    .join("\n\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

const clip = (v: unknown, n: number = REVIEW_LIMITS.text): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");

/** 解析复核结果：容忍代码块包裹、前后多余文字；字段不合法的条目丢弃。解析不了返回 unparsed。纯函数。 */
export function parseReview(content: string): IndependentReview {
  const t = String(content ?? "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  let obj: any = null;
  if (start >= 0 && end > start) {
    try {
      obj = JSON.parse(t.slice(start, end + 1));
    } catch {
      obj = null;
    }
  }
  if (!obj || typeof obj !== "object") return { trace: [], issues: [], summary: "", unparsed: true };
  const trace: ReviewTraceRow[] = (Array.isArray(obj.trace) ? obj.trace : [])
    .map((r: any) => ({ point: clip(r?.point, 200), clause: clip(r?.clause, 120), status: r?.status, ...(clip(r?.note) ? { note: clip(r?.note) } : {}) }))
    .filter((r: ReviewTraceRow) => r.point && (r.status === "covered" || r.status === "partial" || r.status === "missing"))
    .slice(0, REVIEW_LIMITS.trace);
  const issues: ReviewIssue[] = (Array.isArray(obj.issues) ? obj.issues : [])
    .map((r: any) => ({
      severity: r?.severity,
      kind: KINDS.has(r?.kind) ? r.kind : "other",
      where: clip(r?.where, 120),
      quote: clip(r?.quote, 80),
      problem: clip(r?.problem),
      fix: clip(r?.fix, 400),
    }))
    .filter((r: ReviewIssue) => SEVERITIES.has(r.severity) && r.problem)
    .slice(0, REVIEW_LIMITS.issues);
  const rank = { veto: 0, major: 1, minor: 2 } as const;
  issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return { trace, issues, summary: clip(obj.summary, 200) };
}

/** 是否交回起草人修正：有否决类或重要缺陷，或指令要点没落实 / 只落实一半。只有轻微问题的不再占用一轮（宁可少改不多跑）。纯函数。 */
export function reviewNeedsFix(r: IndependentReview): boolean {
  if (r.unparsed) return false;
  return r.issues.some((i) => i.severity === "veto" || i.severity === "major") || r.trace.some((t) => t.status !== "covered");
}

/** 复核计数（时间线与事件载荷用）。纯函数。 */
export function reviewCounts(r: IndependentReview): { veto: number; major: number; minor: number; trace_total: number; trace_gaps: number } {
  return {
    veto: r.issues.filter((i) => i.severity === "veto").length,
    major: r.issues.filter((i) => i.severity === "major").length,
    minor: r.issues.filter((i) => i.severity === "minor").length,
    trace_total: r.trace.length,
    trace_gaps: r.trace.filter((t) => t.status !== "covered").length,
  };
}

const SEV_LABEL: Record<ReviewSeverity, string> = { veto: "否决类", major: "重要", minor: "轻微" };

/**
 * 修正轮交给助手的话：复核意见不是律师的新指令——律师明确给出的交易要点、金额与立场不因复核而改变；逐条判断，成立的在原文书上逐处改，
 * 不成立的在最终答复里说明理由；不整份重出。纯函数。
 */
export function reviewFixPrompt(r: IndependentReview): string {
  const gaps = r.trace.filter((t) => t.status !== "covered");
  const lines: string[] = [
    "【独立复核意见】你交出的文书已由另一位复核律师独立审读（这不是律师本人的新指令）。请逐条判断：",
    "- 成立的：在本任务已生成的文书上逐处修正（用 docx.edit_draft 在最新一版上改，不整份重出；改动涉及的定义、互引、金额与附件一并核对）；",
    "- 不成立或需要客户决定的：不改正文，在最终答复里写明理由或列为待客户决定事项；",
    "- 律师在指令里明确给出的交易要点、金额、比例、期限与立场一律以律师为准，复核意见与之冲突的不采纳；",
    "- 不要另起新文书、不要重复做已经做完的检索；改完后给出简短最终答复：采纳了哪几条、改在哪里，没采纳哪几条、为什么。",
  ];
  if (gaps.length) {
    lines.push("", "指令要点没有落实或只落实一半：");
    gaps.forEach((g, i) => lines.push(`${i + 1}. ${g.point}——${g.status === "missing" ? "没有落实" : "只落实一半"}（${g.clause || "无"}）${g.note ? `：${g.note}` : ""}`));
  }
  const issues = r.issues.filter((i) => i.severity !== "minor");
  if (issues.length) {
    lines.push("", "缺陷（按严重程度）：");
    issues.forEach((x, i) => lines.push(`${i + 1}. 【${SEV_LABEL[x.severity]}】${x.where}${x.quote ? `「${x.quote}」` : ""}：${x.problem}。改法：${x.fix}`));
  }
  const minors = r.issues.filter((i) => i.severity === "minor");
  if (minors.length) lines.push("", `另有 ${minors.length} 处轻微问题，顺手能改的一并改：${minors.map((m) => `${m.where}：${m.problem}`).join("；")}`.slice(0, 1200));
  return lines.join("\n");
}

/** 律师看的复核摘要（时间线、事件载荷；已还原代号的文字由调用方传入）。纯函数。 */
export function reviewSummaryLine(r: IndependentReview, fixRequested: boolean): string {
  if (r.unparsed) return "独立复核没有给出可用结果，按助手交出的文书结算（请律师照常复核）";
  const c = reviewCounts(r);
  const found = [c.veto ? `否决类 ${c.veto} 处` : "", c.major ? `重要 ${c.major} 处` : "", c.minor ? `轻微 ${c.minor} 处` : ""].filter(Boolean).join("、");
  const trace = c.trace_total ? `指令要点 ${c.trace_total} 项${c.trace_gaps ? `，${c.trace_gaps} 项没有落实或只落实一半` : "全部落实"}` : "";
  const head = [trace, found ? `发现${found}` : "没有发现需要修改的问题"].filter(Boolean).join("；");
  return `${head}${fixRequested ? "；已交助手在原文书上逐处修正" : ""}`;
}
