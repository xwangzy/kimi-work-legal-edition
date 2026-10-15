/**
 * 令牌化召回独立评测器（S8；格式与指标见同目录 README.md）。纯函数：输入金标准文书与令牌化器工厂，输出只含计数与比例的报告。
 */
import { type MatterTokenizer, type PartyEntry, type TokenCategory } from "../src/index.ts";

export interface GoldSpan {
  start: number;
  end: number;
  category: TokenCategory;
  person_id?: string;
}

export interface GoldDoc {
  doc_id: string;
  source: string;
  text: string;
  known_parties?: PartyEntry[];
  spans: GoldSpan[];
}

export interface DocOutcome {
  doc_id: string;
  source: string;
  /** 类别 → [标注提及数, 完全替换数]（区间被某一处替换完全覆盖才算；部分覆盖不算）。 */
  mentions: Record<string, [number, number]>;
  /** 类别 → 部分替换数（替换只覆盖了提及的一部分：剩下的字仍以原文发出，计入泄露）。 */
  partial: Record<string, number>;
  /** 自然人编号 → 是否泄露（保守口径：任一提及没有被完全覆盖，或其任一写法仍出现在输出里）。 */
  persons: Record<string, boolean>;
  /** 类别 → 误替换次数（替换区间与任何标注都不相交）。 */
  falseReplacements: Record<string, number>;
  /** 类别 → 过度替换次数（覆盖了标注，但还吞掉了标注之外的字——会改变法律含义）。 */
  overReplacements: Record<string, number>;
}

function count(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n += 1;
  return n;
}

/** 校验一份金标准文书：区间在正文内、类别合法、自然人带编号。返回问题列表（空 = 合格）。 */
export function validateGold(d: GoldDoc): string[] {
  const problems: string[] = [];
  if (!d.doc_id || typeof d.text !== "string") problems.push("缺 doc_id 或 text");
  const cats = new Set(["person", "org", "id_number", "phone", "account", "uscc", "address", "plate", "email", "case_no", "birth_date"]);
  for (const s of d.spans ?? []) {
    if (!(Number.isInteger(s.start) && Number.isInteger(s.end) && s.start >= 0 && s.end > s.start && s.end <= d.text.length)) problems.push(`区间越界 ${s.start}-${s.end}`);
    if (!cats.has(s.category)) problems.push(`类别不合法 ${s.category}`);
    if (s.category === "person" && !s.person_id) problems.push(`自然人提及缺 person_id（${s.start}-${s.end}）`);
  }
  return problems;
}

/**
 * 评一份文书（复核 B4-R02、R08：按区间判定，不按写法计数）：
 * - 完全替换：某一处替换区间完全覆盖标注区间；只覆盖一部分记“部分替换”，不算已替换（剩下的字以原文发出）；
 * - 过度替换：覆盖了标注、但区间超出标注（例如把“原告王五于当日”整段换掉）；
 * - 误替换：替换区间与任何标注都不相交（按替换的类别计）；
 * - 人级泄露（保守）：该人任一提及没有被完全覆盖，或其任一标注写法仍出现在输出里（例如嵌在未标注的字号“上海李四贸易有限公司”里）。
 */
export function evaluateDoc(d: GoldDoc, makeTokenizer: (parties: PartyEntry[]) => MatterTokenizer): DocOutcome {
  const tz = makeTokenizer(d.known_parties ?? []);
  const r = tz.tokenize(d.text);
  const out = r.text;
  const mentions: Record<string, [number, number]> = {};
  const partial: Record<string, number> = {};
  const persons: Record<string, boolean> = {};
  const overReplacements: Record<string, number> = {};
  const falseReplacements: Record<string, number> = {};
  const personForms = new Map<string, Set<string>>();
  const usedOver = new Set<number>();
  for (const g of d.spans) {
    const m = (mentions[g.category] ??= [0, 0]);
    m[0] += 1;
    const covering = r.spans.findIndex((x) => x.start <= g.start && x.end >= g.end);
    const overlapping = r.spans.some((x) => x.start < g.end && x.end > g.start);
    if (covering >= 0) {
      m[1] += 1;
      const x = r.spans[covering]!;
      if ((x.start < g.start || x.end > g.end) && !usedOver.has(covering)) {
        usedOver.add(covering);
        overReplacements[g.category] = (overReplacements[g.category] ?? 0) + 1;
      }
    } else if (overlapping) partial[g.category] = (partial[g.category] ?? 0) + 1;
    if (g.person_id) {
      persons[g.person_id] ??= false;
      if (covering < 0) persons[g.person_id] = true;
      const forms = personForms.get(g.person_id) ?? new Set<string>();
      forms.add(d.text.slice(g.start, g.end));
      personForms.set(g.person_id, forms);
    }
  }
  // 写法仍出现在输出里（含嵌在未标注处、未被替换的出现）：判泄露
  for (const [pid, forms] of personForms) if ([...forms].some((f) => count(out, f) > 0)) persons[pid] = true;
  for (const x of r.spans) {
    if (d.spans.some((g) => x.start < g.end && x.end > g.start)) continue;
    falseReplacements[x.category] = (falseReplacements[x.category] ?? 0) + 1;
  }
  return { doc_id: d.doc_id, source: d.source, mentions, partial, persons, falseReplacements, overReplacements };
}

/** 确定性 PRNG（mulberry32）：自助法可复现。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface MetricWithCi {
  value: number | null;
  ci95: [number, number] | null;
  /** 区间方法：按文书簇自助（百分位）；比例在 0 或 1、自助区间零宽或有效文书不足 30 份时改用 Clopper–Pearson 精确区间（复核 B4-R07）。 */
  method: "cluster_bootstrap" | "clopper_pearson" | null;
  numerator: number;
  denominator: number;
  /** 有该指标分母（例如有该类别提及）的文书数。 */
  docsWithData: number;
}

/** 二项分布 P(X ≤ k | n, p)（对数空间求和，n 到十万量级可用）。 */
function binomCdf(k: number, n: number, p: number): number {
  if (k < 0) return 0;
  if (k >= n) return 1;
  if (p <= 0) return 1;
  if (p >= 1) return 0;
  const lp = Math.log(p);
  const lq = Math.log1p(-p);
  let logC = 0; // log C(n, 0)
  let sum = 0;
  for (let i = 0; i <= k; i++) {
    if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
    sum += Math.exp(logC + i * lp + (n - i) * lq);
  }
  return Math.min(1, sum);
}

/** Clopper–Pearson 双侧 95% 区间（二分求根）。 */
export function clopperPearson(x: number, n: number): [number, number] {
  if (n <= 0) return [0, 1];
  const solve = (f: (p: number) => number) => {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (f(mid) > 0) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  // 下界：P(X ≥ x | p) = 0.025，即 1 − cdf(x−1) = 0.025；上界：cdf(x | p) = 0.025
  const lower = x === 0 ? 0 : solve((p) => 0.025 - (1 - binomCdf(x - 1, n, p)));
  const upper = x === n ? 1 : solve((p) => binomCdf(x, n, p) - 0.025);
  return [lower, upper];
}

function ratioCi(docs: DocOutcome[], pick: (d: DocOutcome) => [number, number], iterations = 1000, seed = 20261014): MetricWithCi {
  const totals = docs.map(pick);
  const num = totals.reduce((s, x) => s + x[0], 0);
  const den = totals.reduce((s, x) => s + x[1], 0);
  const docsWithData = totals.filter((x) => x[1] > 0).length;
  if (den === 0) return { value: null, ci95: null, method: null, numerator: num, denominator: den, docsWithData };
  const r = rng(seed);
  const samples: number[] = [];
  for (let it = 0; it < iterations; it++) {
    let a = 0;
    let b = 0;
    for (let i = 0; i < docs.length; i++) {
      const x = totals[Math.floor(r() * docs.length)]!;
      a += x[0];
      b += x[1];
    }
    if (b > 0) samples.push(a / b);
  }
  samples.sort((x, y) => x - y);
  const q = (p: number) => samples[Math.min(samples.length - 1, Math.max(0, Math.floor(p * samples.length)))]!;
  const value = num / den;
  const boot: [number, number] | null = samples.length ? [q(0.025), q(0.975)] : null;
  // 自助区间在比例为 0 或 1、样本文书少或区间零宽时没有意义（报出“100%（100%–100%）”会误导）：改报精确区间
  const degenerate = !boot || boot[0] === boot[1] || value === 0 || value === 1 || docsWithData < 30;
  if (degenerate) return { value, ci95: clopperPearson(num, den), method: "clopper_pearson", numerator: num, denominator: den, docsWithData };
  return { value, ci95: boot, method: "cluster_bootstrap", numerator: num, denominator: den, docsWithData };
}

export interface EvalReport {
  docs: number;
  sources: Record<string, number>;
  recallByCategory: Record<string, MetricWithCi>;
  /** 类别 → 部分替换数（计入泄露，不计入召回）。 */
  partialByCategory: Record<string, number>;
  personLeakRate: MetricWithCi;
  falseReplacements: Record<string, number>;
  overReplacements: Record<string, number>;
}

export function aggregate(outcomes: DocOutcome[]): EvalReport {
  const cats = new Set<string>();
  for (const o of outcomes) for (const c of Object.keys(o.mentions)) cats.add(c);
  const recallByCategory: Record<string, MetricWithCi> = {};
  for (const c of [...cats].sort()) recallByCategory[c] = ratioCi(outcomes, (o) => [o.mentions[c]?.[1] ?? 0, o.mentions[c]?.[0] ?? 0]);
  const personLeakRate = ratioCi(outcomes, (o) => [Object.values(o.persons).filter(Boolean).length, Object.keys(o.persons).length]);
  const sum = (pick: (o: DocOutcome) => Record<string, number>) => {
    const out: Record<string, number> = {};
    for (const o of outcomes) for (const [c, n] of Object.entries(pick(o))) out[c] = (out[c] ?? 0) + n;
    return out;
  };
  const sources: Record<string, number> = {};
  for (const o of outcomes) sources[o.source] = (sources[o.source] ?? 0) + 1;
  return { docs: outcomes.length, sources, recallByCategory, partialByCategory: sum((o) => o.partial), personLeakRate, falseReplacements: sum((o) => o.falseReplacements), overReplacements: sum((o) => o.overReplacements) };
}

/** 按来源分别汇总（复核 B4-R07：来源不同的评测集不合并成一个数；合成来源只用于回归）。 */
export function aggregateBySource(outcomes: DocOutcome[]): Record<string, EvalReport> {
  const groups = new Map<string, DocOutcome[]>();
  for (const o of outcomes) groups.set(o.source, [...(groups.get(o.source) ?? []), o]);
  return Object.fromEntries([...groups].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => [k, aggregate(v)]));
}

const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);

const ci = (m: MetricWithCi) => (m.ci95 ? `${pct(m.ci95[0])}–${pct(m.ci95[1])}${m.method === "clopper_pearson" ? "（精确）" : ""}` : "—");
const kv = (r: Record<string, number>) => Object.entries(r).map(([k, v]) => `${k} ${v}`).join("、") || "0";

export function reportMarkdown(title: string, r: EvalReport): string {
  const synthetic = Object.keys(r.sources).some((s) => s === "synthetic");
  const lines = [
    `# ${title}`,
    "",
    `文书 ${r.docs} 份；来源：${Object.entries(r.sources).map(([k, v]) => `${k} ${v}`).join("、")}${synthetic ? "（含合成来源：只用于回归，不得对外引用）" : ""}`,
    "",
    "| 类别 | 提及召回 | 95% 区间 | 已替换/标注 | 有提及的文书 | 部分替换 |",
    "|---|---|---|---|---|---|",
  ];
  for (const [c, m] of Object.entries(r.recallByCategory)) lines.push(`| ${c} | ${pct(m.value)} | ${ci(m)} | ${m.numerator}/${m.denominator} | ${m.docsWithData} | ${r.partialByCategory[c] ?? 0} |`);
  const pl = r.personLeakRate;
  lines.push("", `人级泄露率（保守口径）：${pct(pl.value)}（95% 区间 ${ci(pl)}；${pl.numerator}/${pl.denominator} 人）`);
  lines.push("", `误替换：${kv(r.falseReplacements)}；过度替换：${kv(r.overReplacements)}`);
  lines.push("", "本报告只含计数与比例，不含原文。区间注“精确”者为 Clopper–Pearson（比例在 0 或 1、或有效文书不足 30 份时采用）。");
  return lines.join("\n");
}
