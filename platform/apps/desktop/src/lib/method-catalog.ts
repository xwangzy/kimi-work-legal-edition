/**
 * 方法库目录（第 55 批）：把场景卡按“业务线 → 办案阶段”排成目录，供方法库页分组、筛选与搜索。
 * 原先四十多张卡按业务线平铺成一面卡片墙，律师要逐张读标题才找得到；律师想的是“案子到了哪一步”，所以按阶段分组。
 * 分组只是展示顺序，不改卡片本身（数据源仍是 lib/scenarios.ts）；没列进任何阶段的卡自动落到该线末尾的“其他”，新加卡片不会丢。
 * 纯函数，无界面依赖。
 */
import { cardGets, cardGives, LINE_LABELS, SCENARIOS, type BusinessLine, type ScenarioCard } from "./scenarios.ts";

export type CatalogLine = BusinessLine | "general";
export const CATALOG_LINES: readonly CatalogLine[] = ["litigation", "transactional", "inhouse", "general"];
export const CATALOG_LINE_LABELS: Record<CatalogLine, string> = { ...LINE_LABELS, general: "通用" };

/** 各业务线下的阶段与卡片顺序（卡片 id）。 */
const STAGES: Record<CatalogLine, readonly { stage: string; ids: readonly string[] }[]> = {
  litigation: [
    { stage: "接案与案情", ids: ["intake-lit", "casefile", "casefile-deep", "issues", "case-analysis", "procedure", "amount"] },
    { stage: "起诉与应诉", ids: ["pleading", "defense", "appeal", "arbitration-app", "preservation"] },
    { stage: "庭审", ids: ["cross-exam", "hearing-outline", "agency"] },
    { stage: "执行与汇报", ids: ["enforcement", "case-report-lit"] },
    { stage: "劳动争议", ids: ["labor-apply", "labor-arb-application", "labor-arb-defense-lit"] },
  ],
  transactional: [
    { stage: "合同", ids: ["contract-review", "redraft", "redraft-local", "redline-notes", "contract-draft", "rules-from-template"] },
    { stage: "交易与尽调", ids: ["intake", "dd-list", "dd-findings", "corporate-resolutions", "closing-checklist", "research-deal"] },
  ],
  inhouse: [
    { stage: "合同与合规", ids: ["contract-review-inhouse", "rules-from-template-inhouse", "compliance-qa", "policy-review"] },
    { stage: "纠纷应对", ids: ["suit-received", "demand-inhouse", "case-report"] },
    { stage: "劳动用工", ids: ["labor-response", "labor-arb-defense", "labor-termination"] },
  ],
  general: [
    { stage: "研究与意见", ids: ["research-lit", "legal-opinion"] },
    { stage: "文书加工", ids: ["demand-lit", "doc-revise", "citation-audit", "audience-pack"] },
  ],
};

export interface CatalogGroup {
  stage: string;
  cards: ScenarioCard[];
}
export interface CatalogSection {
  line: CatalogLine;
  label: string;
  groups: CatalogGroup[];
  count: number;
}

/** 卡片归哪条线：三条线通用的卡归“通用”，其余按卡片自己的业务线。 */
export function catalogLineOf(c: Pick<ScenarioCard, "line" | "general">): CatalogLine {
  return c.general ? "general" : c.line;
}

/** 搜索用的文字：标题、交付件、需要的材料、意图关键词；全部小写、去空白。 */
function haystack(c: ScenarioCard): string {
  return [c.title, cardGets(c), cardGives(c), ...c.intents.flat()].join(" ").toLowerCase().replace(/\s+/g, "");
}

/** 搜索词按空白拆开，每个词都要命中（“起诉 金额”= 同时含两者）。空词 = 不筛。 */
export function matchesQuery(c: ScenarioCard, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const h = haystack(c);
  return words.every((w) => h.includes(w));
}

/**
 * 目录：按业务线、阶段排好；可按业务线与搜索词筛。空的阶段与空的业务线不返回。
 * cards 缺省为全部场景卡（测试可传自己的）。
 */
export function buildCatalog(opts: { line?: CatalogLine | "all"; query?: string } = {}, cards: readonly ScenarioCard[] = SCENARIOS): CatalogSection[] {
  const want = opts.line ?? "all";
  const q = opts.query ?? "";
  const out: CatalogSection[] = [];
  for (const line of CATALOG_LINES) {
    if (want !== "all" && want !== line) continue;
    const mine = cards.filter((c) => catalogLineOf(c) === line);
    const placed = new Set<string>();
    const groups: CatalogGroup[] = [];
    for (const g of STAGES[line]) {
      const list = g.ids.flatMap((id) => mine.filter((c) => c.id === id));
      for (const c of list) placed.add(c.id);
      const hit = list.filter((c) => matchesQuery(c, q));
      if (hit.length > 0) groups.push({ stage: g.stage, cards: hit });
    }
    const rest = mine.filter((c) => !placed.has(c.id) && matchesQuery(c, q));
    if (rest.length > 0) groups.push({ stage: "其他", cards: rest });
    const count = groups.reduce((n, g) => n + g.cards.length, 0);
    if (count > 0) out.push({ line, label: CATALOG_LINE_LABELS[line], groups, count });
  }
  return out;
}

/** 每条线有几张卡（筛选胶囊上的数字）；all = 总数。 */
export function catalogCounts(cards: readonly ScenarioCard[] = SCENARIOS): Record<CatalogLine | "all", number> {
  const n: Record<CatalogLine | "all", number> = { all: cards.length, litigation: 0, transactional: 0, inhouse: 0, general: 0 };
  for (const c of cards) n[catalogLineOf(c)]++;
  return n;
}

/** 没有列进任何阶段的卡（用例据此提醒：新加卡片要排进目录）。 */
export function unplacedCards(cards: readonly ScenarioCard[] = SCENARIOS): string[] {
  const ids = new Set(Object.values(STAGES).flatMap((gs) => gs.flatMap((g) => g.ids)));
  return cards.filter((c) => !ids.has(c.id)).map((c) => c.id);
}
