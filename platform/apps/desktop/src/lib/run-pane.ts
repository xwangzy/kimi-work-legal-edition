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
