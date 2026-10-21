/** 方法模板名称与版本，如“合同审查（风险卡） v1.1.1”；不是方法模板任务返回 null（工作台协议条用，Z3 #22）。 */
export function methodShort(run: { input_snapshot?: unknown } | null, titles: Record<string, string>, versions: Record<string, string>): string | null {
  const id = skillOf(run);
  return id ? `${titles[id] ?? id}${versions[id] ? ` v${versions[id]}` : ""}` : null;
}

function skillOf(run: { input_snapshot?: unknown } | null): string | null {
  let snap: any = run?.input_snapshot;
  if (typeof snap === "string") {
    try {
      snap = JSON.parse(snap);
    } catch {
      snap = null;
    }
  }
  return typeof snap?.skill === "string" ? snap.skill : null;
}

/** 本次任务所用的方法模板与版本（Z3 §8.2 #26）：“方法：合同审查（风险卡） · v1.1.1”；不是方法模板任务返回 null。 */
export function methodLine(run: { input_snapshot?: unknown } | null, titles: Record<string, string>, versions: Record<string, string>): string | null {
  const id = skillOf(run);
  if (!id) return null;
  return `方法：${titles[id] ?? id}${versions[id] ? ` · v${versions[id]}` : ""}（本所当前分发的版本）`;
}
