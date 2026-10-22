/**
 * 事项的程序阶段、事件时点与地域（v9.4 第 20 批 S-08；评审 C1 §3.2 阶段条）：阶段由律师点选，不由 AI 推断。
 * 阶段条按我方立场给一条线：诉讼、仲裁与劳动（劳动争议仲裁前置）、交易；顾问与其他给全部。与内核 services/matter-facts.ts 同一组取值。
 */
export type Stage = "pre_filing" | "first_instance" | "second_instance" | "retrial" | "enforcement" | "arbitration" | "due_diligence" | "negotiation" | "signing" | "closing" | "performance" | "advisory";

export const STAGE_LABELS: Record<Stage, string> = {
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

const LITIGATION: Stage[] = ["pre_filing", "first_instance", "second_instance", "retrial", "enforcement"];
const ARBITRATION: Stage[] = ["pre_filing", "arbitration", "first_instance", "second_instance", "enforcement"];
const TRANSACTION: Stage[] = ["due_diligence", "negotiation", "signing", "closing", "performance"];

const LITIGATION_STANCES = ["原告", "被告", "上诉人", "被上诉人", "第三人"];
const ARBITRATION_STANCES = ["申请人", "被申请人", "用人单位", "劳动者"];

/** 我方立场 → 阶段条；当前阶段不在这条线上时补在末尾（律师从“其他阶段”里选过）。 */
export function stagesFor(stance: string | null | undefined, current?: string | null): Stage[] {
  const s = stance ?? "";
  const line = LITIGATION_STANCES.includes(s) ? LITIGATION : ARBITRATION_STANCES.includes(s) ? ARBITRATION : ["常年顾问", "其他", ""].includes(s) ? (["advisory", ...LITIGATION] as Stage[]) : TRANSACTION;
  return current && current in STAGE_LABELS && !line.includes(current as Stage) ? [...line, current as Stage] : line;
}

export const ALL_STAGES = Object.keys(STAGE_LABELS) as Stage[];

/** 事件时点：YYYY-MM-DD 或只到月 YYYY-MM（按日历核，2 月 30 日不算）。空串表示不填。 */
export function eventDateProblem(v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(s);
  if (!m) return "写成 2023-05 或 2023-05-06";
  const month = Number(m[2]);
  if (month < 1 || month > 12) return "月份不对";
  if (m[3]) {
    const last = new Date(Date.UTC(Number(m[1]), month, 0)).getUTCDate();
    if (Number(m[3]) < 1 || Number(m[3]) > last) return "日期不对";
  }
  return null;
}
