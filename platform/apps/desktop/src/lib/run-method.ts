/** 本次任务所用的方法模板与版本（Z3 §8.2 #26）：“方法：合同审查（风险卡） · v1.1.1”；不是方法模板任务返回 null。 */
export function methodLine(run: { input_snapshot?: unknown } | null, titles: Record<string, string>, versions: Record<string, string>): string | null {
  let snap: any = run?.input_snapshot;
  if (typeof snap === "string") {
    try {
      snap = JSON.parse(snap);
    } catch {
      snap = null;
    }
  }
  const id = typeof snap?.skill === "string" ? snap.skill : null;
  if (!id) return null;
  return `方法：${titles[id] ?? id}${versions[id] ? ` · v${versions[id]}` : ""}（本所当前分发的版本）`;
}
