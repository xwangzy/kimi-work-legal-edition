/**
 * 首页“推荐”一组（第 47 批，Kimi 首页“推荐”胶囊同位）。纯函数。
 */
import { SCENARIOS, type BusinessLine, type ScenarioCard } from "./scenarios.ts";

/** 每组先列几行。 */
const LIMIT = 6;

/** “推荐”的缺省组合：三条业务线各自最常用的一类工作（整理案卷、审合同、律师函、起草诉状、合规答复、金额测算），不放两张相近的卡。 */
export const RECOMMENDED_DEFAULT = ["casefile", "contract-review", "demand-lit", "pleading", "compliance-qa", "amount"] as const;
/**
 * “推荐”一组（纯函数）：最近用过的场景在前（按最近任务的方法匹配，去重，至多 3 个），其余按缺省组合补齐到 6 个。
 * 只用本机真实的最近任务，不编造“热门”。
 */
export function recommendedCards(recent: { scenario: string; skill?: string | null }[], all: readonly ScenarioCard[] = SCENARIOS): ScenarioCard[] {
  const out: ScenarioCard[] = [];
  const add = (c: ScenarioCard | undefined) => {
    if (c && !out.some((x) => x.id === c.id)) out.push(c);
  };
  for (const r of recent) {
    if (out.length >= 3) break;
    add(all.find((c) => (r.skill ? c.skill === r.skill : c.scenario !== "a1.agent_task" && c.scenario === r.scenario)));
  }
  for (const id of RECOMMENDED_DEFAULT) if (out.length < LIMIT) add(all.find((c) => c.id === id));
  // 缺省组合里的卡被改名或下线时，按各业务线的头几个补齐
  const lines: BusinessLine[] = ["litigation", "transactional", "inhouse"];
  for (let i = 0; i < 3 && out.length < LIMIT; i++) for (const l of lines) if (out.length < LIMIT) add(all.filter((c) => c.line === l && !c.general)[i]);
  return out.slice(0, LIMIT);
}
