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
  /** 第 61 批（D-263）：适用方式、要件—事实对照、但书与例外（旧提纲没有）。 */
  mode?: "direct" | "referral" | "extensive" | "analogy" | null;
  elements?: { element: string; status: "fact" | "to_prove" | "undisputed" | "opponent_burden"; facts: { fact_id: string | null; statement: string; confirmed: boolean }[] }[];
  exceptions?: string | null;
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

/** 留下的论点引用的、还没经律师确认的事实（去重；没有事实编号的不算——那是助手的转述，不能在这里确认）。纯函数。 */
export function unconfirmedFactsOf(o: Pick<OutlineView, "items">, d: OutlineDraft): { fact_id: string; statement: string }[] {
  const seen = new Map<string, string>();
  for (const x of o.items) if (!d.drop[x.arg_id]) for (const f of x.facts) if (f.fact_id && !f.confirmed && !seen.has(f.fact_id)) seen.set(f.fact_id, f.statement);
  return [...seen].map(([fact_id, statement]) => ({ fact_id, statement }));
}

/** 至少留一条（与内核一致）。 */
export const keptCount = (o: Pick<OutlineView, "items">, d: OutlineDraft) => o.items.filter((x) => !d.drop[x.arg_id]).length;

const CONFIRM = /^已确认/;
const STOP = /^先不起草/;

/**
 * 找到 Agent 为这份提纲提的那道确认题：题干含“论点”、选项里有“已确认……”。返回作答所需的编号；找不到为 null。
 * others = 同一张提问卡里另外还有几道题（第 31 批真实走查：助手把论点确认和“赔偿基数”“欠薪范围”放在同一张卡里，
 * 原先只认单题卡，律师在论点卡确认后还得在提问卡上再确认一遍）。
 */
export function outlineQuestion(questions: readonly QuestionCard[]): { question_id: string; qid: string; confirm: string; stop: string | null; others: number } | null {
  for (const q of questions) {
    for (const one of q.questions) {
      const yes = one.options.find((o) => CONFIRM.test(o.label.trim()));
      if (!yes || !/论点/.test(one.question)) continue;
      const no = one.options.find((o) => STOP.test(o.label.trim()));
      return { question_id: q.question_id, qid: one.id, confirm: yes.id, stop: no?.id ?? null, others: q.questions.length - 1 };
    }
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
export function basisStateText(b: Pick<OutlineBasisView, "check" | "article_text" | "demo"> & { matched?: string | null }): string {
  // V23：法规库未收录（核验没匹配到法名，matched 为 null）与条号不对分开说——未收录不等于条文不存在
  if (b.check === "intercepted" && b.matched === null) return "法规库未收录这部法规，系统没法核对：须你查官方文本";
  if (b.check === "intercepted") return "核对未通过（条号不存在、已改号或该时点没有有效版本）";
  if (b.check === "unverified_offline" || b.check === "unchecked") return "未核实，须你查官方文本";
  const text = b.article_text ? "条文原文见下" : "法规库没有这条的原文";
  return `${b.check === "version_verified" ? "版本已核" : b.check === "source_verified" ? "来源已核" : "已核到条"} · 是否撑得住论点由你判断 · ${text}${b.demo ? "（演示数据，不得作为正式引用）" : ""}`;
}

/** 适用方式的说法（第 61 批）：直接适用不标；其余写明，类推写“无直接依据”。 */
export function modeText(mode: OutlineBasisView["mode"]): string | null {
  return mode === "referral" ? "参照适用（依转介条款）" : mode === "extensive" ? "扩张解释" : mode === "analogy" ? "类推适用 · 无直接依据" : null;
}

/** 要件的状态说法（第 61 批）：有事实的写确认与否，没有事实的写待证、无争议或对方举证。 */
export function elementStateText(e: NonNullable<OutlineBasisView["elements"]>[number]): { text: string; tone: "ok" | "warn" | "gray" } {
  if (e.status === "fact") {
    if (e.facts.length === 0) return { text: "标了有事实，但没挂事实", tone: "warn" };
    return e.facts.every((f) => f.confirmed) ? { text: "有事实 · 已确认", tone: "ok" } : { text: "有事实 · 未经你确认", tone: "warn" };
  }
  if (e.status === "to_prove") return { text: "待证", tone: "warn" };
  if (e.status === "undisputed") return { text: "双方无争议", tone: "gray" };
  return { text: "对方举证", tone: "gray" };
}

/* ── 第 66 批（V40 P0-1）：确认卡重构——先给结论与要你判断的事，细节按需展开 ── */

export type OutlineTone = "ok" | "warn" | "risk" | "gray";

/** 依据的短标（卡上一眼看的徽标）与完整说法（展开后看）。完整说法仍是 basisStateText，口径不变。纯函数。 */
export function basisBadge(b: Pick<OutlineBasisView, "check" | "article_text" | "demo"> & { matched?: string | null }): { label: string; tone: OutlineTone; detail: string } {
  const detail = basisStateText(b);
  if (b.check === "intercepted" && b.matched === null) return { label: "法规库未收录", tone: "risk", detail };
  if (b.check === "intercepted") return { label: "核对未通过", tone: "risk", detail };
  if (b.check === "unverified_offline" || b.check === "unchecked") return { label: "未核实", tone: "warn", detail };
  if (b.demo) return { label: "演示数据", tone: "warn", detail };
  return { label: b.check === "version_verified" ? "版本已核" : b.check === "source_verified" ? "来源已核" : "已核到条", tone: "ok", detail };
}

/** 一处要律师判断的地方（卡顶“需要你判断”逐条列出，点了展开对应论点）。 */
export interface OutlineAttention {
  arg_id: string;
  /** 论点序号（从 1 起）。 */
  n: number;
  kind: "fact" | "basis" | "analogy" | "to_prove" | "element_gap";
  tone: "warn" | "risk";
  text: string;
}

const clip = (s: string, n = 28) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * 留下的论点里要律师判断的地方（去掉的论点、去掉的依据不算）。顺序：按论点，再按“依据核对 → 类推 → 要件待证 → 事实未确认”。
 * 同一条事实挂在多处只报一次（第一次出现的论点）。纯函数。
 */
export function outlineAttention(o: Pick<OutlineView, "items">, d: OutlineDraft, plain: (s: string) => string = (s) => s): OutlineAttention[] {
  const out: OutlineAttention[] = [];
  const seenFacts = new Set<string>();
  o.items.forEach((x, i) => {
    if (d.drop[x.arg_id]) return;
    const n = i + 1;
    const off = new Set(d.dropBasis[x.arg_id] ?? []);
    x.basis.forEach((b, bi) => {
      if (off.has(bi)) return;
      const name = `《${b.matched ?? b.law}》${b.article ? `第 ${b.article} 条` : ""}`;
      const badge = basisBadge(b);
      if (badge.tone !== "ok") out.push({ arg_id: x.arg_id, n, kind: "basis", tone: badge.tone === "risk" ? "risk" : "warn", text: `${name}：${badge.label}，须你查官方文本` });
      if (b.mode === "analogy") out.push({ arg_id: x.arg_id, n, kind: "analogy", tone: "warn", text: `${name}：类推适用，无直接依据` });
      for (const e of b.elements ?? []) {
        if (e.status === "to_prove") out.push({ arg_id: x.arg_id, n, kind: "to_prove", tone: "warn", text: `要件「${clip(plain(e.element))}」待证` });
        else if (e.status === "fact" && e.facts.length === 0) out.push({ arg_id: x.arg_id, n, kind: "element_gap", tone: "warn", text: `要件「${clip(plain(e.element))}」标了有事实，但没挂事实` });
      }
    });
    // 论点直接挂的与要件里挂的事实：只报未确认的
    const pending = [
      ...x.facts.filter((f) => !f.confirmed).map((f) => ({ id: f.fact_id, statement: f.statement })),
      ...x.basis.flatMap((b, bi) => (off.has(bi) ? [] : (b.elements ?? []).flatMap((e) => e.facts.filter((f) => !f.confirmed).map((f) => ({ id: f.fact_id, statement: f.statement }))))),
    ];
    for (const f of pending) {
      const key = f.id ?? `s:${f.statement}`;
      if (seenFacts.has(key)) continue;
      seenFacts.add(key);
      out.push({ arg_id: x.arg_id, n, kind: "fact", tone: "warn", text: `事实「${clip(plain(f.statement))}」未经你确认` });
    }
  });
  return out;
}

/** 一条论点的概况（折叠时那一行）：依据几条、要件里有事实的几条、要判断的几处。纯函数。 */
export function argSummary(x: OutlineItemView, d: OutlineDraft, attention: readonly OutlineAttention[]): { basis: number; elements: number; elementsWithFacts: number; attention: number } {
  const off = new Set(d.dropBasis[x.arg_id] ?? []);
  const kept = x.basis.filter((_, i) => !off.has(i));
  const els = kept.flatMap((b) => b.elements ?? []);
  return {
    basis: kept.length,
    elements: els.length,
    elementsWithFacts: els.filter((e) => e.status !== "to_prove" && !(e.status === "fact" && e.facts.length === 0)).length,
    attention: attention.filter((a) => a.arg_id === x.arg_id).length,
  };
}

/**
 * “需要你判断”的汇总（第 66 批真实走查：起诉状一张卡 31 处，多数是原告本就要举证的“要件待证”，逐条列出又成了堆叠）。
 * 规则：依据核对问题与类推逐条列（少而要紧）；待证要件、没挂事实的要件按论点各合成一行；未确认事实合成一行（底部可一并确认）。
 * 顺序：风险（依据核对不过）→ 类推 → 各论点的要件 → 事实。纯函数。
 */
export function attentionDigest(list: readonly OutlineAttention[]): OutlineAttention[] {
  const out: OutlineAttention[] = [];
  const risk = list.filter((a) => a.kind === "basis");
  const analogy = list.filter((a) => a.kind === "analogy");
  out.push(...risk.filter((a) => a.tone === "risk"), ...risk.filter((a) => a.tone !== "risk"), ...analogy);
  const byArg = new Map<string, { n: number; toProve: number; gap: number }>();
  for (const a of list) {
    if (a.kind !== "to_prove" && a.kind !== "element_gap") continue;
    const g = byArg.get(a.arg_id) ?? { n: a.n, toProve: 0, gap: 0 };
    if (a.kind === "to_prove") g.toProve++;
    else g.gap++;
    byArg.set(a.arg_id, g);
  }
  for (const [arg_id, g] of byArg) {
    const parts = [g.toProve > 0 ? `${g.toProve} 个要件待证` : "", g.gap > 0 ? `${g.gap} 个要件标了有事实但没挂事实` : ""].filter(Boolean).join("，");
    out.push({ arg_id, n: g.n, kind: g.gap > 0 ? "element_gap" : "to_prove", tone: "warn", text: `${parts}：看证据是否够` });
  }
  const facts = list.filter((a) => a.kind === "fact");
  if (facts.length > 0) out.push({ arg_id: facts[0]!.arg_id, n: facts[0]!.n, kind: "fact", tone: "warn", text: `${facts.length} 条事实未经你确认（底部可一并确认）` });
  return out;
}
