/**
 * 事项待办的说法（v9.4 第 20 批，C1 §3.2）：一条待办写清做什么、谁做、谁复核、期限。
 * 推出的待办（等你确认、AI 已完成待你复核、待签发）与手工待办用同一种写法。
 */
import type { DerivedTodo, TodoRow } from "../api.ts";
import { ARTIFACT_LABELS } from "./labels.ts";

export const ASSIGNEE_LABELS: Record<TodoRow["assignee_kind"], string> = { me: "我", assistant: "助理", colleague: "同事", ai: "AI" };

/** 推出的待办：一句话 + 谁做。 */
export function derivedTodoText(d: DerivedTodo, labelOf: (scenario: string) => string): { title: string; who: string } {
  const what = d.goal || (d.scenario ? labelOf(d.scenario) : "任务");
  if (d.kind === "run_waiting") return { title: `回答任务里的确认：${what}`, who: "我" };
  if (d.kind === "drafts_to_review") return { title: `复核 ${d.count} 份草稿：${what}`, who: "AI 已完成 · 待你复核" };
  // 第 27 批（评审 U3-10）：成果名不带扩展名与日期，后面括上是哪次任务——“签发：修订稿（审合同）”
  return { title: `签发：${signName(d)}${d.goal ? `（${d.goal}）` : ""}`, who: "待签发" };
}

const NAMED_BY_FILE = ["a1_workspace_file", "agent_table", "agent_report", "review_table", "review_grid", "review_table_docx", "evidence_index", "dd_findings"];
function signName(d: Pick<DerivedTodo, "filename" | "artifact_kind">): string {
  const bare = (d.filename ?? "").replace(/\.(docx|xlsx|md|txt|csv|pdf)$/i, "");
  if (d.artifact_kind && !NAMED_BY_FILE.includes(d.artifact_kind) && ARTIFACT_LABELS[d.artifact_kind]) return ARTIFACT_LABELS[d.artifact_kind]!;
  return bare || "成果";
}

/** 手工待办的附注：“助理小王做 · 张律师复核”；只写填了的。 */
export function todoMeta(t: Pick<TodoRow, "assignee_kind" | "assignee_name" | "reviewer_name">): string {
  const who = t.assignee_kind === "me" ? "" : `${t.assignee_name ? `${ASSIGNEE_LABELS[t.assignee_kind]}${t.assignee_name}` : ASSIGNEE_LABELS[t.assignee_kind]}做`;
  const rv = t.reviewer_name ? `${t.reviewer_name}复核` : "";
  return [who, rv].filter(Boolean).join(" · ");
}
