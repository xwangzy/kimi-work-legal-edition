/**
 * 起草前的“论点与依据”确认（v9.4 第 19 批 C-04；评审 C1 §1、§4）。纯函数，供任务页与用例共用。
 *
 * Agent 提交提纲后会用提问工具问“论点与依据已列在任务页，请确认后选择”（选项“已确认，按确认的论点起草”“先不起草”）；
 * 任务页把这道题并进提纲卡：律师在卡上逐条确认后点“确认并开始起草”，界面先记下决定、再替律师选第一项——不用再答一遍。
 */
import type { QuestionAnswer, QuestionCard } from "../api.ts";

export interface OutlineBasisView {
  law: string;
  article: number | null;
  note: string | null;
  check: string;
  matched: string | null;
  article_text: string | null;
  demo: boolean;
}
export interface OutlineItemView {
  arg_id: string;
  claim: string;
  basis: OutlineBasisView[];
  facts: { fact_id: string | null; statement: string; confirmed: boolean }[];
  counter: string | null;
}
export interface OutlineView {
  outline_id: string;
  run_id: string | null;
  doc_kind: string;
  title: string | null;
  items: OutlineItemView[];
  status: "proposed" | "confirmed" | "withdrawn";
  decisions: { arg_id: string; keep: boolean; claim: string | null; basis_keep: number[] | null }[] | null;
  lawyer_note: string | null;
}

/** 律师在卡上的草稿：每条论点留不留、改写后的文字（空 = 不改）、去掉了哪些依据。 */
export interface OutlineDraft {
  drop: Record<string, boolean>;
  claim: Record<string, string>;
  dropBasis: Record<string, number[]>;
}

export const emptyDraft = (): OutlineDraft => ({ drop: {}, claim: {}, dropBasis: {} });

/** 交给内核的逐条决定。原样的论点不传 claim（改写的才传，且与原文不同才算改写）。纯函数。 */
export function decisionsOf(o: Pick<OutlineView, "items">, d: OutlineDraft, plainClaim: (s: string) => string): { arg_id: string; keep: boolean; claim?: string; basis_keep?: number[] }[] {
  return o.items.map((x) => {
    const edited = (d.claim[x.arg_id] ?? "").trim();
    const dropped = new Set(d.dropBasis[x.arg_id] ?? []);
    return {
      arg_id: x.arg_id,
      keep: !d.drop[x.arg_id],
      ...(edited && edited !== plainClaim(x.claim).trim() ? { claim: edited } : {}),
      ...(dropped.size > 0 ? { basis_keep: x.basis.map((_, i) => i).filter((i) => !dropped.has(i)) } : {}),
    };
  });
}

/** 至少留一条（与内核一致）。 */
export const keptCount = (o: Pick<OutlineView, "items">, d: OutlineDraft) => o.items.filter((x) => !d.drop[x.arg_id]).length;

const CONFIRM = /^已确认/;
const STOP = /^先不起草/;

/** 找到 Agent 为这份提纲提的那道确认题：单题、选项里有“已确认……”。返回作答所需的编号；找不到为 null。 */
export function outlineQuestion(questions: readonly QuestionCard[]): { question_id: string; qid: string; confirm: string; stop: string | null } | null {
  for (const q of questions) {
    if (q.questions.length !== 1) continue;
    const one = q.questions[0]!;
    const yes = one.options.find((o) => CONFIRM.test(o.label.trim()));
    if (!yes || !/论点/.test(one.question)) continue;
    const no = one.options.find((o) => STOP.test(o.label.trim()));
    return { question_id: q.question_id, qid: one.id, confirm: yes.id, stop: no?.id ?? null };
  }
  return null;
}

/** 作答内容：确认 → 第一项；先不起草 → 第二项（没有该选项时写“其他”）。 */
export function outlineAnswer(m: NonNullable<ReturnType<typeof outlineQuestion>>, go: boolean): Record<string, QuestionAnswer> {
  if (go) return { [m.qid]: { kind: "single", option_id: m.confirm } };
  return { [m.qid]: m.stop ? { kind: "single", option_id: m.stop } : { kind: "other", text: "先不起草" } };
}

/**
 * 任务页“确认并开始起草”的先后（复核 Q2-20）：先记下律师的逐条决定，再替律师答 Agent 的确认题。
 * 代答失败时决定已经记下（提纲为已确认），错误照常抛给界面——Agent 下次读取 outline.get 即得确认版，律师也可以在提问卡上自己答。
 */
export async function confirmAndAnswer(o: { decide: () => Promise<unknown>; answer: (() => Promise<unknown>) | null }): Promise<"decided_and_answered" | "decided_only"> {
  await o.decide();
  if (!o.answer) return "decided_only";
  await o.answer();
  return "decided_and_answered";
}

/** 依据的核验说法（律师层）：库外与拦截的写明，系统核过的不说成“律师认可”。 */
export function basisStateText(b: Pick<OutlineBasisView, "check" | "article_text" | "demo">): string {
  if (b.check === "intercepted") return "核对未通过（条号或法名不对，或法规库里没有）";
  if (b.check === "unverified_offline" || b.check === "unchecked") return "未核实，须你查官方文本";
  const text = b.article_text ? "条文原文见下" : "法规库没有这条的原文";
  return `${b.check === "version_verified" ? "版本已核" : b.check === "source_verified" ? "来源已核" : "已核到条"} · 是否撑得住论点由你判断 · ${text}${b.demo ? "（演示数据，不得作为正式引用）" : ""}`;
}
