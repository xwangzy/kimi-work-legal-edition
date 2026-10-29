/**
 * 执行页右栏（Z3 #11、IA-5）：标签收成至多 4 个；没有任何成果时收成窄条，出现首份成果后自动展开。纯函数。
 * “文件历史”并入“成果”（版本下拉 + 版本记录折叠），“记录”并入“数据去向”底部折叠。
 */
export type RightTab = "review" | "artifact" | "citations" | "egress";

export function rightTabs(p: { hasRisk: boolean; intercepted: number }): [RightTab, string][] {
  return [
    ...(p.hasRisk ? ([["review", "审查摘要"]] as [RightTab, string][]) : []),
    ["artifact", "成果"],
    ["citations", p.intercepted > 0 ? `引用 · ${p.intercepted} 条无法核实` : "引用"],
    ["egress", "数据去向"],
  ];
}

/**
 * 右栏是否收起：成果已读完且为 0、没有审查意见、没有引用核验结果时收起；律师点开过就不再自动收起。
 * 成果还在读取时不收（避免先收后展开的闪动）。
 */
export function rightCollapsed(p: { artifactsLoaded: boolean; artifactCount: number; hasRisk: boolean; hasCitations: boolean; userExpanded: boolean }): boolean {
  if (p.userExpanded) return false;
  return p.artifactsLoaded && p.artifactCount === 0 && !p.hasRisk && !p.hasCitations;
}

/**
 * 完成卡上列哪些文件（第 31 批真实走查）：同一任务多次调用文书 / 表格工具时同名文件登记为第 1、2 版，
 * 原先两行一模一样（劳动仲裁申请书、证据目录各两份），律师分不出哪份是改正后的。每个“类型 + 文件名”只列最新一版，
 * 按首次出现的顺序；older = 被取代的旧版份数（右栏“成果”里仍可看历史版本）。纯函数。
 */
export function currentFiles<T extends { kind?: string; filename?: string; version?: number | string; kind_version?: number | string }>(artifacts: readonly T[]): { current: T[]; older: number } {
  const ver = (a: T) => Number(a.kind_version ?? a.version ?? 0);
  const latest = new Map<string, T>();
  const order: string[] = [];
  for (const a of artifacts) {
    const k = `${a.kind ?? ""}\u0000${a.filename ?? ""}`;
    const cur = latest.get(k);
    if (!cur) order.push(k);
    if (!cur || ver(a) > ver(cur)) latest.set(k, a);
  }
  const current = order.map((k) => latest.get(k)!);
  return { current, older: artifacts.length - current.length };
}
