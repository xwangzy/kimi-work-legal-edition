/**
 * 全局搜索（Z3 评审 §8.2 #31）：匹配在内核里做（search.titles；余项续复核 RC-A-05、RC-B-06/07/09），这里只把结果排成三组。纯函数。
 * 任务用目标作标题（同一事项的几次任务分得清），交付件标题后带“第 N 版”，副标题写所在事项与时刻。
 */
import { artifactName, ARTIFACT_LABELS, fmtWhen, SCENARIO_LABELS } from "./labels.ts";
import { SCENARIOS, scenarioOfRun } from "./scenarios.ts";

export type SearchKind = "matter" | "run" | "deliverable";
export interface SearchItem {
  kind: SearchKind;
  title: string;
  sub: string;
  href: string;
}

/** 给内核的标签：场景卡名（按方法模板与场景）与交付件名（按种类），任务与交付件也能按这些名称搜到。 */
export function searchLabels(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of SCENARIOS) {
    if (c.skill && !out[`skill:${c.skill}`]) out[`skill:${c.skill}`] = c.title;
    if (c.scenario !== "a1.agent_task" && !out[`scenario:${c.scenario}`]) out[`scenario:${c.scenario}`] = c.title;
  }
  // 同一流程在卡片与任务表里叫法不同（“整理案卷” / “材料整理”）：两个名字都能搜到（只用于匹配，显示由界面另算）
  for (const [k, v] of Object.entries(SCENARIO_LABELS)) {
    const cur = out[`scenario:${k}`];
    out[`scenario:${k}`] = cur && !cur.includes(v) ? `${cur} ${v}` : (cur ?? v);
  }
  for (const [k, v] of Object.entries(ARTIFACT_LABELS)) out[`kind:${k}`] = v;
  return out;
}

export function searchGroups(
  r: {
    matters: { matter_id: string; title: string; sub: string }[];
    runs: { run_id: string; matter_id: string; matter_title: string; scenario: string; skill: string | null; goal: string; updated_at: string }[];
    deliverables: { artifact_version_id: string; matter_id: string; matter_title: string; kind: string; version: number; filename: string; title: string | null; created_at: string }[];
  },
  now = Date.now(),
): { kind: SearchKind; items: SearchItem[] }[] {
  const groups: { kind: SearchKind; items: SearchItem[] }[] = [
    { kind: "matter", items: r.matters.map((m) => ({ kind: "matter" as const, title: m.title, sub: m.sub, href: `/matter/${m.matter_id}` })) },
    {
      kind: "run",
      items: r.runs.map((x) => {
        const card = scenarioOfRun({ scenario: x.scenario, input_snapshot: { skill: x.skill } });
        const label = card?.title ?? SCENARIO_LABELS[x.scenario] ?? "任务";
        return { kind: "run" as const, title: x.goal ? `${label}：${x.goal}` : label, sub: `${x.matter_title} · ${fmtWhen(x.updated_at, now)}`, href: `/run/${x.run_id}/${x.matter_id}` };
      }),
    },
    {
      kind: "deliverable",
      items: r.deliverables.map((x) => ({ kind: "deliverable" as const, title: `${artifactName(x)} · 第 ${x.version} 版`, sub: `${x.matter_title} · ${fmtWhen(x.created_at, now)}`, href: `/review/${x.artifact_version_id}` })),
    },
  ];
  return groups.filter((g) => g.items.length > 0);
}

export const SEARCH_KIND_LABEL: Readonly<Record<SearchKind, string>> = { matter: "事项", run: "任务", deliverable: "交付件" };
