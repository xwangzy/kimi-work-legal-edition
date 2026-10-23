/**
 * 任务所用的方法模板与版本（Z3 §8.2 #26；余项续复核 RC-A-09、RC-B-14）：版本取任务开始时写进快照的那一版（skill_version），
 * 老任务没有记录时写“版本未记录（当前所用为 vX）”；模板已不在本机时用场景卡名或“已下架的方法模板”，不显示内部编号。
 */
import { SCENARIOS } from "./scenarios.ts";
import { methodName } from "./labels.ts";

function snapOf(run: { input_snapshot?: unknown } | null): any {
  let snap: any = run?.input_snapshot;
  if (typeof snap === "string") {
    try {
      snap = JSON.parse(snap);
    } catch {
      snap = null;
    }
  }
  return snap && typeof snap === "object" ? snap : null;
}

function method(run: { input_snapshot?: unknown } | null, titles: Record<string, string>, versions: Record<string, string>): { title: string; version: string | null; recorded: boolean; current: string | null } | null {
  const snap = snapOf(run);
  const id = typeof snap?.skill === "string" ? snap.skill : null;
  if (!id) return null;
  const title = (typeof snap.skill_title === "string" && snap.skill_title) || titles[id] || SCENARIOS.find((c) => c.skill === id)?.title || "已下架的方法模板";
  const recorded = typeof snap.skill_version === "string" && !!snap.skill_version;
  return { title: methodName(title), version: recorded ? snap.skill_version : null, recorded, current: versions[id] ?? null };
}

/** 方法模板名称与版本，如“合同审查（风险卡） v1.1.1”；不是方法模板任务返回 null（工作台协议条用，Z3 #22）。 */
export function methodShort(run: { input_snapshot?: unknown } | null, titles: Record<string, string>, versions: Record<string, string>): string | null {
  const m = method(run, titles, versions);
  if (!m) return null;
  const v = m.version ?? m.current;
  return `${m.title}${v ? ` v${v}` : ""}`;
}

/** 本次任务所用的方法模板与版本：“方法：合同审查（风险卡） · v1.1.1（任务开始时的版本）”；不是方法模板任务返回 null。 */
export function methodLine(run: { input_snapshot?: unknown } | null, titles: Record<string, string>, versions: Record<string, string>): string | null {
  const m = method(run, titles, versions);
  if (!m) return null;
  if (m.recorded) return `方法：${m.title} · v${m.version}（任务开始时的版本）`;
  return `方法：${m.title} · 版本未记录${m.current ? `（本所当前使用的是 v${m.current}）` : ""}`;
}
