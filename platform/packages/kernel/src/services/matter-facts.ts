/**
 * 事项的程序阶段、事件时点与地域（v9.4 第 20 批 S-08；评审 S1 §6.2 第 10 项后半、C1 §3.2，迁移 0057）。
 * - 阶段由律师点选，不由 AI 推断；Agent 在“事项口径”里读到它，用来选对文书与期间（一审答辩、二审上诉、执行申请）。
 * - 事件时点是主要法律事实发生的时间：实体法按它取适用版本（法不溯及既往），程序法按审理时的现行版本（程序从新）。
 * - 地域用于核对地方性法规、地方口径是否适用于本事项。
 */
export const MATTER_STAGES = ["pre_filing", "first_instance", "second_instance", "retrial", "enforcement", "arbitration", "due_diligence", "negotiation", "signing", "closing", "performance", "advisory"] as const;
export type MatterStage = (typeof MATTER_STAGES)[number];

export const STAGE_LABELS: Record<MatterStage, string> = {
  pre_filing: "立案前",
  first_instance: "一审",
  second_instance: "二审",
  retrial: "再审",
  enforcement: "执行",
  arbitration: "仲裁",
  due_diligence: "尽调",
  negotiation: "谈判",
  signing: "签约",
  closing: "交割",
  performance: "履约",
  advisory: "顾问",
};

/** 给 Agent 的事项口径附加段（没填的不写）。 */
export function matterFactsLine(m: { stage?: string | null; event_date?: string | null; region?: string | null; client_name?: string | null; counterparty?: string | null }): string {
  const parts: string[] = [];
  // 委托人与相对方（第 28 批）：起草合同、诉状时首部要用；真实走查里空白事项起草的合同首部写成【待填】。随整段提示词经事项令牌化器（自然人姓名换代号）
  const name = (v: string | null | undefined) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 100) : "");
  if (name(m.client_name)) parts.push(`委托人=${name(m.client_name)}`);
  if (name(m.counterparty)) parts.push(`相对方=${name(m.counterparty)}`);
  if (m.stage && m.stage in STAGE_LABELS) parts.push(`程序阶段=${STAGE_LABELS[m.stage as MatterStage]}`);
  if (m.event_date) parts.push(`事件时点=${m.event_date}（实体法按此时点取适用版本，程序法按现行版本）`);
  if (m.region) parts.push(`地域=${m.region}`);
  return parts.length > 0 ? `；${parts.join("；")}` : "";
}

/**
 * 程序法（程序从新：按审理时的现行版本适用，不按事件时点核）。只认法名，覆盖诉讼、仲裁、调解与执行的程序性法律和司法解释；
 * 实体与程序混合的（劳动争议调解仲裁法里的时效）按程序法处理——宁可少核也不误拦，时效问题由方法单独提示。
 */
const PROCEDURAL_RE = /(民事诉讼法|刑事诉讼法|行政诉讼法|仲裁法|调解仲裁法|人民调解法|诉讼费用交纳办法|强制执行|执行程序|民事执行|证据的若干规定|证据规定|海事诉讼特别程序法|企业破产法|民诉法)/;
export function isProceduralLaw(name: string): boolean {
  return PROCEDURAL_RE.test(name);
}

/**
 * 事件时点 → 用于取版本的日期区间：只到月的取当月首日与末日（两头版本不同时如实说“当月内版本有变化”）。
 * 返回 null 表示没有有效的事件时点。
 */
export function eventDateRange(v: string | null | undefined): { from: string; to: string; monthOnly: boolean } | null {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(v);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return null;
  const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
  if (m[3]) return Number(m[3]) >= 1 && Number(m[3]) <= last ? { from: v, to: v, monthOnly: false } : null;
  return { from: `${m[1]}-${m[2]}-01`, to: `${m[1]}-${m[2]}-${String(last).padStart(2, "0")}`, monthOnly: true };
}
