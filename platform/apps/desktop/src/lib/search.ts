/**
 * 全局搜索（Z3 评审 §8.2 #31）：匹配在内核里做（search.titles；余项续复核 RC-A-05、RC-B-06/07/09），这里只把结果排成三组。纯函数。
 * 任务用目标作标题（同一事项的几次任务分得清），成果标题后带“第 N 版”，副标题写所在事项与时刻。
 */
import { artifactName, ARTIFACT_LABELS, fmtWhen, SCENARIO_LABELS } from "./labels.ts";
import { SCENARIOS, scenarioOfRun } from "./scenarios.ts";
import { teamPrefix } from "./team-matters.ts";

export type SearchKind = "matter" | "run" | "deliverable" | "material";
export interface SearchItem {
  kind: SearchKind;
  title: string;
  sub: string;
  href: string;
  /** 材料（第 49 批）：打开事项后切到“材料”并用这个词筛选。 */
  focus?: { matterId: string; q: string };
}

/**
 * 从全局搜索跳到某事项材料页的交接（第 49 批）：只放在渲染进程内存里（同一页面上下文，换页不刷新），不用浏览器存储
 * （渲染存储门禁只许登记过的本机偏好键）。设下后 5 秒内有效：事项页首次载入时可能重挂载几次，同一事项都拿到同一个词。
 */
let held: { matterId: string; q: string; at: number } | null = null;
const HOLD_MS = 5000;
export function setMatterFocus(f: { matterId: string; q: string }, now = Date.now()): void {
  held = { matterId: f.matterId, q: f.q, at: now };
}
/** 事项页据此切到“材料”，材料搜索框据此初始化输入框；过期或别的事项为 null。 */
export function peekMatterFocus(matterId: string, now = Date.now()): string | null {
  return held && held.matterId === matterId && now - held.at < HOLD_MS ? held.q : null;
}
/** 与 peek 相同（保留名称给材料搜索框用，读的是同一份交接）。 */
export const takeMatterFocus = peekMatterFocus;

const LEGACY_SCENARIO_NAMES: Record<string, string> = { "s2.case_file": "材料整理" };

/** 给内核的标签：场景卡名（按方法模板与场景）与成果名（按种类），任务与成果也能按这些名称搜到。 */
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
  // 旧叫法仍能搜到（v9.4 起任务表统一用卡片名“整理案卷”）
  for (const [k, v] of Object.entries(LEGACY_SCENARIO_NAMES)) if (!out[`scenario:${k}`]!.includes(v)) out[`scenario:${k}`] += ` ${v}`;
  for (const [k, v] of Object.entries(ARTIFACT_LABELS)) out[`kind:${k}`] = v;
  return out;
}

export function searchGroups(
  r: {
    matters: { matter_id: string; title: string; sub: string }[];
    runs: { run_id: string; matter_id: string; matter_title: string; scenario: string; skill: string | null; goal: string; title?: string | null; updated_at: string }[];
    deliverables: { artifact_version_id: string; matter_id: string; matter_title: string; kind: string; version: number; filename: string; title: string | null; created_at: string }[];
    /** 材料（第 49 批；旧内核没有）。 */
    materials?: { document_version_id: string; matter_id: string; matter_title: string; filename: string; rel_path: string | null; created_at: string }[];
  },
  now = Date.now(),
  /** 第 73 批（D-310）：团队共享事项的编号（界面按事项列表拼“团队共享 · ”前缀，不改内核）；个人空间传空集。 */
  teamIds: ReadonlySet<string> = new Set(),
): { kind: SearchKind; items: SearchItem[] }[] {
  const groups: { kind: SearchKind; items: SearchItem[] }[] = [
    { kind: "matter", items: r.matters.map((m) => ({ kind: "matter" as const, title: m.title, sub: teamPrefix(m.sub, teamIds.has(m.matter_id)), href: `/matter/${m.matter_id}` })) },
    {
      kind: "run",
      items: r.runs.map((x) => {
        const card = scenarioOfRun({ scenario: x.scenario, input_snapshot: { skill: x.skill } });
        const label = card?.title ?? SCENARIO_LABELS[x.scenario] ?? "任务";
        return { kind: "run" as const, title: x.title ? x.title : x.goal ? `${label}：${x.goal}` : label, sub: `${x.matter_title} · ${fmtWhen(x.updated_at, now)}`, href: `/run/${x.run_id}/${x.matter_id}` };
      }),
    },
    {
      kind: "deliverable",
      items: r.deliverables.map((x) => ({ kind: "deliverable" as const, title: `${artifactName(x)} · 第 ${x.version} 版`, sub: `${x.matter_title} · ${fmtWhen(x.created_at, now)}`, href: `/review/${x.artifact_version_id}` })),
    },
    {
      // 材料（第 49 批）：跨事项按文件名找，点开进该事项的“材料”并筛出这份；副标题写所在事项与在案卷文件夹里的位置
      kind: "material",
      items: (r.materials ?? []).map((x) => {
        const dir = x.rel_path && x.rel_path.includes("/") ? x.rel_path.slice(0, x.rel_path.lastIndexOf("/")) : "";
        return { kind: "material" as const, title: x.filename, sub: [x.matter_title, dir].filter(Boolean).join(" · "), href: `/matter/${x.matter_id}`, focus: { matterId: x.matter_id, q: x.filename } };
      }),
    },
  ];
  return groups.filter((g) => g.items.length > 0);
}

export const SEARCH_KIND_LABEL: Readonly<Record<SearchKind, string>> = { matter: "事项", run: "任务", deliverable: "成果", material: "材料" };
