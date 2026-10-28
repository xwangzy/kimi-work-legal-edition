/**
 * 提问卡的作答（第 03 篇 §8.2；复核 B4-B16）：选项与“其他”互斥——上游答复只有 single / multi / other / skipped 四种，
 * “其他”不能与选项并存，界面上也不能两者同时呈选中而实际只交“其他”。纯函数，可单测。
 */
import type { QuestionAnswer, QuestionCard } from "../api.ts";

type Q = QuestionCard["questions"][number];
export interface AnswerDraft {
  sel: Record<string, string[]>;
  other: Record<string, string>;
}

/** 点选一个选项：单选替换、多选切换；同一题的“其他”文字随之清空。 */
export function pickOption(d: AnswerDraft, q: Q, optionId: string): AnswerDraft {
  const cur = d.sel[q.id] ?? [];
  const on = cur.includes(optionId);
  const next = q.multi_select ? (on ? cur.filter((x) => x !== optionId) : [...cur, optionId]) : [optionId];
  const other = { ...d.other };
  delete other[q.id];
  return { sel: { ...d.sel, [q.id]: next }, other };
}

/** 在“其他”里写字：有文字即清空同一题已选的选项（写空则只是清空文字）。 */
export function typeOther(d: AnswerDraft, q: Q, text: string): AnswerDraft {
  const sel = { ...d.sel };
  if (text.trim()) delete sel[q.id];
  return { sel, other: { ...d.other, [q.id]: text } };
}

/** 每一题都选了选项或写了“其他”。 */
export function isAnswered(questions: readonly Q[], d: AnswerDraft): boolean {
  return questions.every((q) => (d.sel[q.id] ?? []).length > 0 || (d.other[q.id] ?? "").trim().length > 0);
}

/** 还没作答的题数（界面写明“还有 N 题未选”，不只放在按钮的悬停提示里）。 */
export function unansweredCount(questions: readonly Q[], d: AnswerDraft): number {
  return questions.filter((q) => (d.sel[q.id] ?? []).length === 0 && !(d.other[q.id] ?? "").trim()).length;
}

/** 交给内核的答复：“其他”有文字 → other；否则按选项；都没有 → skipped。 */
export function buildAnswers(questions: readonly Q[], d: AnswerDraft): Record<string, QuestionAnswer> {
  return Object.fromEntries(
    questions.map((q): [string, QuestionAnswer] => {
      const o = (d.other[q.id] ?? "").trim();
      const s = d.sel[q.id] ?? [];
      if (o) return [q.id, { kind: "other", text: o }];
      if (q.multi_select) return [q.id, s.length ? { kind: "multi", option_ids: s } : { kind: "skipped" }];
      return [q.id, s[0] ? { kind: "single", option_id: s[0] } : { kind: "skipped" }];
    }),
  );
}

/** 选项文字的律师写法（第 28 批）：引擎的提问工具要求推荐项后缀英文“(Recommended)”，界面改写成“（推荐）”。纯函数。 */
export function optionLabelText(label: string): string {
  return label.replace(/\s*[（(]\s*recommended\s*[)）]\s*$/i, "（推荐）");
}
