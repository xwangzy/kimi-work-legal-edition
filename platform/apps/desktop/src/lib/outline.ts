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

/* ── 第 67 批（V41 工作线 A）：按律师的判断路径重排——每条论点一个结论信号（绿 / 橙 / 红），细节按“法律依据 → 事实依据 → 风险提示”展开 ──
 * 取代第 66 批的“需要你判断”清单（outlineAttention / attentionDigest / argSummary）：那份清单把同一句“n 个要件待证：看证据是否够”
 * 按论点重复五遍，论点行上又再写一遍“n 处待你看”，计数口径两套。现在每条论点只有一句结论，卡顶最多一行汇总，数字由同一个函数算出。 */

export type VerdictTone = "ok" | "warn" | "risk";

type FactRef = { fact_id: string | null; statement: string; confirmed: boolean };

/**
 * 事实的现状。内核确认事实后只刷新论点直接挂的事实（argument-outlines.ts refreshOutlineFacts），要件里挂的是提纲提交那一刻的快照——
 * 同一事实编号以论点上那份为准，否则律师确认过的事实在要件行里仍显示“待你确认”。纯函数。
 */
export function liveFactState(o: Pick<OutlineView, "items">): Map<string, boolean> {
  const m = new Map<string, boolean>();
  for (const x of o.items) for (const f of x.facts) if (f.fact_id) m.set(f.fact_id, (m.get(f.fact_id) ?? false) || f.confirmed);
  return m;
}
const confirmedNow = (f: FactRef, live: ReadonlyMap<string, boolean>) => (f.fact_id && live.has(f.fact_id) ? live.get(f.fact_id)! : f.confirmed);
const factKey = (f: FactRef) => f.fact_id ?? `s:${f.statement}`;

/** 《法名》第 n 条（卡上的全称）。 */
export const basisName = (b: Pick<OutlineBasisView, "law" | "matched" | "article">) => `《${b.matched ?? b.law}》${b.article ? `第 ${b.article} 条` : ""}`;

/** 短称（事实依据、风险提示里分组用）：去掉“中华人民共和国”，司法解释写成“××法解释”。 */
export function basisShort(b: Pick<OutlineBasisView, "law" | "matched" | "article">): string {
  const law = (b.matched ?? b.law).trim();
  const interp = /^最高人民法院关于适用《(?:中华人民共和国)?(.+?)》的解释$/.exec(law);
  const name = interp ? `${interp[1]}解释` : law.replace(/^中华人民共和国/, "");
  return `${name}${b.article ? `第 ${b.article} 条` : ""}`;
}

/** 一条论点引用的事实（论点直接挂的在前，要件里挂的补在后；同一事实只列一次，编号从 1 起）。去掉的依据里的不算。纯函数。 */
export interface ArgFact {
  n: number;
  fact_id: string | null;
  statement: string;
  confirmed: boolean;
}
export function argFacts(x: OutlineItemView, d: OutlineDraft, live: ReadonlyMap<string, boolean>): ArgFact[] {
  const off = new Set(d.dropBasis[x.arg_id] ?? []);
  const seen = new Map<string, ArgFact>();
  const add = (f: FactRef) => {
    const k = factKey(f);
    if (!seen.has(k)) seen.set(k, { n: seen.size + 1, fact_id: f.fact_id, statement: f.statement, confirmed: confirmedNow(f, live) });
  };
  x.facts.forEach(add);
  x.basis.forEach((b, i) => {
    if (!off.has(i)) for (const e of b.elements ?? []) e.facts.forEach(add);
  });
  return [...seen.values()];
}

/** 一个要件有没有证据（事实依据一栏的右侧）：refs = 引用的事实编号（argFacts 的 n）。 */
export function elementEvidence(
  e: NonNullable<OutlineBasisView["elements"]>[number],
  facts: readonly ArgFact[],
  live: ReadonlyMap<string, boolean>,
): { tone: "ok" | "warn" | "gray"; text: string; refs: number[] } {
  if (e.status === "to_prove") return { tone: "warn", text: "缺证据", refs: [] };
  if (e.status === "undisputed") return { tone: "gray", text: "双方无争议", refs: [] };
  if (e.status === "opponent_burden") return { tone: "gray", text: "对方举证", refs: [] };
  if (e.facts.length === 0) return { tone: "warn", text: "缺证据（标了有事实，但没挂上）", refs: [] };
  const refs = e.facts.map((f) => facts.find((a) => (f.fact_id ? a.fact_id === f.fact_id : a.statement === f.statement))?.n ?? 0).filter((n) => n > 0).sort((a, b) => a - b);
  return e.facts.every((f) => confirmedNow(f, live)) ? { tone: "ok", text: "已确认", refs } : { tone: "warn", text: "待你确认", refs };
}

/** 一条论点的结论信号（折叠时那一行）。 */
export interface ArgVerdict {
  tone: VerdictTone;
  /** 依据已核 / 有疑点 / 依据有问题 */
  label: string;
  /** 最要紧的一件事（一句话）。 */
  issue: string;
  /** 另外还有的（至多一句），没有为 null。 */
  more: string | null;
  basis: number;
  elements: number;
  /** 缺证据的要件（待证 + 标了有事实却没挂事实）。 */
  missing: number;
  /** 条文需核对的依据（核对不过、未收录、未核实、演示数据、类推）。 */
  basisIssues: number;
  basisRisk: number;
  /** 本条论点引用的待确认事实（论点上与要件里的合并去重）。 */
  pendingFacts: number;
  /** 其中也被别的（留下的）论点引用的条数。 */
  pendingShared: number;
}

/**
 * 被两条以上留下的论点引用、且还没确认的事实（事实键）。第 67 批第二轮（独立评审）：卡顶写“共 13 条”、各行写 6/4/6/2/2，
 * 加起来 20，律师以为数据错了——各行要写明“其中 n 条与其他论点共用”。纯函数。
 */
export function sharedPendingFacts(o: Pick<OutlineView, "items">, d: OutlineDraft, live: ReadonlyMap<string, boolean>): Set<string> {
  const count = new Map<string, number>();
  for (const x of o.items) {
    if (d.drop[x.arg_id]) continue;
    for (const f of argFacts(x, d, live)) if (!f.confirmed) count.set(factKey(f), (count.get(factKey(f)) ?? 0) + 1);
  }
  return new Set([...count].filter(([, n]) => n > 1).map(([k]) => k));
}

const clip = (s: string, n = 16) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * 一条论点的结论：红 = 条文核对不过或法规库未收录；橙 = 条文未核实 / 类推 / 要件缺证据 / 事实待你确认；绿 = 都没有。
 * 只说最要紧的一件事，顺序：依据有问题 → 条文须核 → 类推 → 要件缺证据 → 事实待确认。去掉的依据不算。纯函数。
 */
export function argVerdict(x: OutlineItemView, d: OutlineDraft, live: ReadonlyMap<string, boolean>, plain: (s: string) => string = (s) => s, shared: ReadonlySet<string> = new Set()): ArgVerdict {
  const off = new Set(d.dropBasis[x.arg_id] ?? []);
  const kept = x.basis.filter((_, i) => !off.has(i));
  const risk = kept.filter((b) => basisBadge(b).tone === "risk");
  const warn = kept.filter((b) => basisBadge(b).tone === "warn");
  const analogy = kept.filter((b) => b.mode === "analogy");
  const els = kept.flatMap((b) => b.elements ?? []);
  const missing = els.filter((e) => e.status === "to_prove" || (e.status === "fact" && e.facts.length === 0));
  const pending = argFacts(x, d, live).filter((f) => !f.confirmed);
  // [完整一句, 简称]：信号行写第一件事的完整一句，其余用简称接在后面
  const issues: [string, string][] = [];
  if (risk.length > 0) issues.push([risk.length === 1 ? `${basisName(risk[0]!)}${basisBadge(risk[0]!).label}` : `${risk.length} 条依据核对未通过或法规库未收录`, `${risk.length} 条依据有问题`]);
  if (warn.length > 0) issues.push([warn.length === 1 ? `${basisName(warn[0]!)}${basisBadge(warn[0]!).label}，须查官方文本` : `${warn.length} 条依据未核实，须查官方文本`, `${warn.length} 条依据未核实`]);
  if (analogy.length > 0) issues.push([`${analogy.length === 1 ? basisName(analogy[0]!) : `${analogy.length} 条依据`}为类推适用，无直接依据`, "类推适用"]);
  if (missing.length > 0) issues.push([`${missing.length} 个要件缺证据，如「${clip(plain(missing[0]!.element))}」`, `${missing.length} 个要件缺证据`]);
  const pendingShared = pending.filter((f) => shared.has(factKey(f))).length;
  if (pending.length > 0) issues.push([`引用 ${pending.length} 条待确认事实${pendingShared > 0 ? `，其中 ${pendingShared} 条与其他论点共用` : ""}`, `${pending.length} 条待确认事实`]);
  const tone: VerdictTone = risk.length > 0 ? "risk" : issues.length > 0 ? "warn" : "ok";
  const okText = kept.length === 0 ? "没有引用依据" : els.length > 0 ? "条文已核，要件都有事实" : "条文已核";
  return {
    tone,
    label: tone === "risk" ? "依据有问题" : tone === "warn" ? "有疑点" : "依据已核",
    issue: issues[0]?.[0] ?? okText,
    more: issues.length > 1 ? `另有 ${issues.slice(1).map((i) => i[1]).join("、")}` : null,
    basis: kept.length,
    elements: els.length,
    missing: missing.length,
    basisIssues: risk.length + warn.length + analogy.length,
    basisRisk: risk.length,
    pendingFacts: pending.length,
    pendingShared,
  };
}

/** 卡顶唯一的一行汇总：每项写明涉及哪些论点（点了展开这些论点）。facts = 底部可一并确认的事实数（与底部同一口径）。纯函数。 */
export interface OverviewItem {
  key: "risk" | "basis" | "missing" | "facts";
  tone: "warn" | "risk";
  text: string;
  args: string[];
}
export function outlineOverview(o: Pick<OutlineView, "items">, d: OutlineDraft, live: ReadonlyMap<string, boolean>): OverviewItem[] {
  const kept = o.items.filter((x) => !d.drop[x.arg_id]).map((x) => ({ x, v: argVerdict(x, d, live) }));
  const pick = (f: (v: ArgVerdict) => number) => kept.filter((k) => f(k.v) > 0);
  const sum = (ks: typeof kept, f: (v: ArgVerdict) => number) => ks.reduce((n, k) => n + f(k.v), 0);
  const out: OverviewItem[] = [];
  const risk = pick((v) => v.basisRisk);
  if (risk.length > 0) out.push({ key: "risk", tone: "risk", text: `${sum(risk, (v) => v.basisRisk)} 条依据有问题`, args: risk.map((k) => k.x.arg_id) });
  const basis = pick((v) => v.basisIssues - v.basisRisk);
  if (basis.length > 0) out.push({ key: "basis", tone: "warn", text: `${sum(basis, (v) => v.basisIssues - v.basisRisk)} 条依据需核对`, args: basis.map((k) => k.x.arg_id) });
  const missing = pick((v) => v.missing);
  if (missing.length > 0) out.push({ key: "missing", tone: "warn", text: `${missing.length === kept.length && kept.length > 1 ? `${missing.length} 条论点都有` : `${missing.length} 条论点有`}要件缺证据`, args: missing.map((k) => k.x.arg_id) });
  const facts = unconfirmedFactsOf(o, d);
  // 与底部“同时确认这 n 条事实”同一个数（内核 confirm_facts 实际确认的那些）
  if (facts.length > 0) out.push({ key: "facts", tone: "warn", text: `共 ${facts.length} 条事实待你确认（论点之间共用的只算一次）`, args: [] });
  return out;
}

/** 底部“一并确认”的事实各被哪几条论点引用（序号从 1 起），给律师勾选前逐条看。纯函数。 */
export function pendingFactUses(o: Pick<OutlineView, "items">, d: OutlineDraft): { fact_id: string; statement: string; args: number[] }[] {
  return unconfirmedFactsOf(o, d).map((f) => ({ ...f, args: o.items.flatMap((x, i) => (!d.drop[x.arg_id] && x.facts.some((g) => g.fact_id === f.fact_id) ? [i + 1] : [])) }));
}

/** 一条论点的风险提示条数（留下的依据里的但书与例外 + 对方可能的反驳）；折叠行右侧显示，让风险层不用展开也看得到（第三轮评审）。纯函数。 */
export function argRiskCount(x: Pick<OutlineItemView, "arg_id" | "basis" | "counter">, d: OutlineDraft): number {
  const off = new Set(d.dropBasis[x.arg_id] ?? []);
  return x.basis.filter((b, i) => !off.has(i) && !!b.exceptions?.trim()).length + (x.counter?.trim() ? 1 : 0);
}
