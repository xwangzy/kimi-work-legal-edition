/**
 * 事项待办的说法（v9.4 第 20 批，C1 §3.2）：一条待办写清做什么、谁做、谁复核、期限。
 * 推出的待办（等你确认、AI 已完成待你复核、待签发）与手工待办用同一种写法。
 */
import type { DerivedTodo, TodoRow } from "../api.ts";

export const ASSIGNEE_LABELS: Record<TodoRow["assignee_kind"], string> = { me: "我", assistant: "助理", colleague: "同事", ai: "AI" };

/** 推出的待办：一句话 + 谁做。 */
export function derivedTodoText(d: DerivedTodo, labelOf: (scenario: string) => string): { title: string; who: string } {
  const what = d.goal || (d.scenario ? labelOf(d.scenario) : "任务");
  if (d.kind === "run_waiting") return { title: `回答任务里的确认：${what}`, who: "我" };
  if (d.kind === "drafts_to_review") return { title: `复核 ${d.count} 份草稿：${what}`, who: "AI 已完成 · 待你复核" };
  return { title: `签发：${d.filename ?? "成果"}`, who: "待签发" };
}

/** 手工待办的附注：“助理小王做 · 张律师复核”；只写填了的。 */
export function todoMeta(t: Pick<TodoRow, "assignee_kind" | "assignee_name" | "reviewer_name">): string {
  const who = t.assignee_kind === "me" ? "" : `${t.assignee_name ? `${ASSIGNEE_LABELS[t.assignee_kind]}${t.assignee_name}` : ASSIGNEE_LABELS[t.assignee_kind]}做`;
  const rv = t.reviewer_name ? `${t.reviewer_name}复核` : "";
  return [who, rv].filter(Boolean).join(" · ");
}
