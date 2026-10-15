/**
 * S8 双人标注一致性与裁决（调研 Y5 §4.4“双人标注”；标注规范 v1 §5）。纯函数，不读写文件。
 *
 * - 字符级 Cohen κ：每个 UTF-16 码元的标签 = 覆盖它的标注类别，未标注为 "O"；按文书计算，并给全部文书合并计算的值；
 * - 提及级 F1：两人标注的区间与类别完全一致才算一致（自然人编号不参与，编号的一致另行由裁决人核对）；
 * - 冻结条件（规范 v1）：κ ≥ 0.85 且 F1 ≥ 0.90；不达标的文书退回重标，不进入评测集；
 * - 分歧：两人不一致的标注按“相互重叠”聚成分歧组，裁决人逐组选“采用甲 / 采用乙 / 都不对（手工）”。
 *
 * 一致性报告只含计数与比例；分歧清单含区间位置（不含原文），供本机裁决界面定位。
 */
import { GOLD_CATEGORIES, validateGold, type GoldDoc, type GoldSpan } from "./evaluate.ts";

export const KAPPA_MIN = 0.85;
export const F1_MIN = 0.9;

function labels(d: GoldDoc): string[] {
  const out = new Array<string>(d.text.length).fill("O");
  for (const s of d.spans) for (let i = Math.max(0, s.start); i < Math.min(d.text.length, s.end); i++) out[i] = s.category;
  return out;
}

/** Cohen κ（两组等长标签）。两人全部一致且只有一种标签时 κ 定义为 1。 */
export function cohenKappa(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 1;
  let agree = 0;
  const ca = new Map<string, number>();
  const cb = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) agree += 1;
    ca.set(a[i]!, (ca.get(a[i]!) ?? 0) + 1);
    cb.set(b[i]!, (cb.get(b[i]!) ?? 0) + 1);
  }
  const po = agree / n;
  let pe = 0;
  for (const [k, x] of ca) pe += (x / n) * ((cb.get(k) ?? 0) / n);
  if (pe >= 1) return po >= 1 ? 1 : 0;
  return (po - pe) / (1 - pe);
}

const key = (s: GoldSpan) => `${s.start}:${s.end}:${s.category}`;

export interface DocAgreement {
  doc_id: string;
  kappa: number;
  f1: number | null;
  agreed: number;
  only_a: number;
  only_b: number;
  /** 两份标注的正文不一致（不是同一份文书）：不计算，直接判不合格。 */
  text_mismatch: boolean;
  passes: boolean;
}

export interface DisagreementGroup {
  doc_id: string;
  /** 文书内序号（从 0 起），裁决决定按 (doc_id, group) 引用。 */
  group: number;
  start: number;
  end: number;
  a: GoldSpan[];
  b: GoldSpan[];
}

export interface AgreementReport {
  docs: number;
  /** 两边都有的文书数（只在一边出现的文书单列）。 */
  paired: number;
  missing_in_a: number;
  missing_in_b: number;
  pooled_kappa: number | null;
  /** 全部文书合并的提及级 F1。 */
  pooled_f1: number | null;
  kappa_min: number | null;
  kappa_median: number | null;
  docs_passing: number;
  docs_failing: number;
  per_doc: DocAgreement[];
  thresholds: { kappa: number; f1: number };
}

function f1Of(agreed: number, na: number, nb: number): number | null {
  if (na + nb === 0) return null;
  return (2 * agreed) / (na + nb);
}

export function compareDoc(a: GoldDoc, b: GoldDoc): { agreement: DocAgreement; groups: DisagreementGroup[] } {
  if (a.text !== b.text) {
    return { agreement: { doc_id: a.doc_id, kappa: 0, f1: null, agreed: 0, only_a: a.spans.length, only_b: b.spans.length, text_mismatch: true, passes: false }, groups: [] };
  }
  const ka = new Set(a.spans.map(key));
  const kb = new Set(b.spans.map(key));
  const agreed = a.spans.filter((s) => kb.has(key(s))).length;
  const onlyA = a.spans.filter((s) => !kb.has(key(s)));
  const onlyB = b.spans.filter((s) => !ka.has(key(s)));
  const kappa = cohenKappa(labels(a), labels(b));
  const f1 = f1Of(agreed, a.spans.length, b.spans.length);
  // 分歧组：把只在一边出现的标注按区间相互重叠聚类（区间并查集，按起点扫描）
  const items = [...onlyA.map((s) => ({ s, side: "a" as const })), ...onlyB.map((s) => ({ s, side: "b" as const }))].sort((x, y) => x.s.start - y.s.start || x.s.end - y.s.end);
  const groups: DisagreementGroup[] = [];
  for (const it of items) {
    const last = groups[groups.length - 1];
    if (last && it.s.start < last.end) {
      last.end = Math.max(last.end, it.s.end);
      last[it.side].push(it.s);
    } else {
      groups.push({ doc_id: a.doc_id, group: groups.length, start: it.s.start, end: it.s.end, a: it.side === "a" ? [it.s] : [], b: it.side === "b" ? [it.s] : [] });
    }
  }
  return { agreement: { doc_id: a.doc_id, kappa, f1, agreed, only_a: onlyA.length, only_b: onlyB.length, text_mismatch: false, passes: kappa >= KAPPA_MIN && (f1 === null || f1 >= F1_MIN) }, groups };
}

export function compareAnnotations(docsA: GoldDoc[], docsB: GoldDoc[]): { report: AgreementReport; groups: DisagreementGroup[] } {
  const byB = new Map(docsB.map((d) => [d.doc_id, d]));
  const byA = new Map(docsA.map((d) => [d.doc_id, d]));
  const per: DocAgreement[] = [];
  const groups: DisagreementGroup[] = [];
  const la: string[] = [];
  const lb: string[] = [];
  let agreed = 0;
  let na = 0;
  let nb = 0;
  for (const a of docsA) {
    const b = byB.get(a.doc_id);
    if (!b) continue;
    const r = compareDoc(a, b);
    per.push(r.agreement);
    groups.push(...r.groups);
    if (!r.agreement.text_mismatch) {
      // 逐个追加（复核 S6A-08：展开参数对几十万字的文书会超出参数上限）
      for (const x of labels(a)) la.push(x);
      for (const x of labels(b)) lb.push(x);
      agreed += r.agreement.agreed;
      na += a.spans.length;
      nb += b.spans.length;
    }
  }
  const ks = per.filter((p) => !p.text_mismatch).map((p) => p.kappa).sort((x, y) => x - y);
  const report: AgreementReport = {
    docs: new Set([...byA.keys(), ...byB.keys()]).size,
    paired: per.length,
    missing_in_a: docsB.filter((d) => !byA.has(d.doc_id)).length,
    missing_in_b: docsA.filter((d) => !byB.has(d.doc_id)).length,
    pooled_kappa: la.length ? cohenKappa(la, lb) : null,
    pooled_f1: f1Of(agreed, na, nb),
    kappa_min: ks.length ? ks[0]! : null,
    kappa_median: ks.length ? ks[Math.floor((ks.length - 1) / 2)]! : null,
    docs_passing: per.filter((p) => p.passes).length,
    docs_failing: per.filter((p) => !p.passes).length,
    per_doc: per,
    thresholds: { kappa: KAPPA_MIN, f1: F1_MIN },
  };
  return { report, groups };
}

/** 裁决决定：采用甲 / 采用乙 / 都不采用 / 手工给出该组的标注。 */
export type Decision = "a" | "b" | "none" | { spans: GoldSpan[] };

export interface AdjudicationResult {
  doc: GoldDoc;
  /** 合成结果的格式问题（手工标注越界、重叠、缺编号等；非空即不能冻结）。 */
  problems: string[];
  /** 未裁决的分歧组序号（非空即不能冻结）。 */
  undecided: number[];
  /** 自然人编号映射问题：乙的同一编号在一致的标注里对应了甲的多个编号（须裁决人手工统一）。 */
  person_id_conflicts: string[];
}

/**
 * 合成金标准：两人一致的标注直接采用（编号取甲的）；分歧组按决定取用。
 * 乙的自然人编号经“一致标注”映射到甲的编号；映射不到的加前缀 "b:"，映射冲突列出。
 */
export function adjudicate(a: GoldDoc, b: GoldDoc, decisions: ReadonlyMap<number, Decision>): AdjudicationResult {
  // 正文不同不是同一份文书：拒绝合成（复核 S6A-05：否则会静默丢掉乙的全部标注）
  if (a.text !== b.text) throw new Error("两份标注的正文不一致，不是同一份文书，不能裁决");
  const { groups } = compareDoc(a, b);
  const kb = new Map(b.spans.map((s) => [key(s), s]));
  const agreed = a.spans.filter((s) => kb.has(key(s)));
  const bToA = new Map<string, Set<string>>();
  for (const s of agreed) {
    const t = kb.get(key(s))!;
    if (s.person_id && t.person_id) bToA.set(t.person_id, (bToA.get(t.person_id) ?? new Set()).add(s.person_id));
  }
  // 编号冲突两个方向都查（复核 S6A-05）：乙的一个编号对应甲的多个，或甲的一个编号对应乙的多个
  const aToB = new Map<string, Set<string>>();
  for (const [bid, as] of bToA) for (const aid of as) aToB.set(aid, (aToB.get(aid) ?? new Set()).add(bid));
  const conflicts = [...[...bToA].filter(([, v]) => v.size > 1).map(([k]) => `乙:${k}`), ...[...aToB].filter(([, v]) => v.size > 1).map(([k]) => `甲:${k}`)];
  const mapB = (s: GoldSpan): GoldSpan => {
    if (!s.person_id) return { ...s };
    const m = bToA.get(s.person_id);
    return { ...s, person_id: m && m.size === 1 ? [...m][0]! : `b:${s.person_id}` };
  };
  const spans: GoldSpan[] = agreed.map((s) => ({ ...s }));
  const undecided: number[] = [];
  for (const g of groups) {
    const dcs = decisions.get(g.group);
    if (dcs === undefined) {
      undecided.push(g.group);
      continue;
    }
    if (dcs === "a") spans.push(...g.a.map((s) => ({ ...s })));
    else if (dcs === "b") spans.push(...g.b.map(mapB));
    else if (dcs !== "none") spans.push(...dcs.spans.filter((s) => GOLD_CATEGORIES.includes(s.category)).map((s) => ({ ...s })));
  }
  spans.sort((x, y) => x.start - y.start || x.end - y.end);
  const { spans: _drop, ...rest } = a;
  const doc = { ...rest, spans };
  return { doc, problems: validateGold(doc), undecided, person_id_conflicts: conflicts };
}

export function agreementMarkdown(r: AgreementReport): string {
  const f = (x: number | null, d = 3) => (x === null ? "—" : x.toFixed(d));
  return [
    "# 双人标注一致性",
    "",
    `成对文书 ${r.paired} 份（只在甲方有 ${r.missing_in_b}、只在乙方有 ${r.missing_in_a}）。`,
    "",
    `字符级 Cohen κ：合并 ${f(r.pooled_kappa)}，最低 ${f(r.kappa_min)}，中位 ${f(r.kappa_median)}；提及级 F1：${f(r.pooled_f1)}。`,
    "",
    `冻结条件 κ ≥ ${r.thresholds.kappa} 且 F1 ≥ ${r.thresholds.f1}：达标 ${r.docs_passing} 份，未达标 ${r.docs_failing} 份（退回重标，不进入评测集）。`,
    "",
    "本报告只含计数与比例，不含原文。",
  ].join("\n");
}
