/**
 * 执行页右栏（Z3 #11、IA-5）：标签收成至多 4 个；没有任何成果时收成窄条，出现首份成果后自动展开。纯函数。
 * “文件历史”并入“成果”（版本下拉 + 版本记录折叠），“记录”并入“数据去向”底部折叠。
 */
import { splitTaskFiles, type FileEntry, type VersionedRow } from "./deliverables.ts";

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
 * 完成后结果区列哪些文件（第 31 批真实走查；V18 A1/A2 起与成果页共用 splitTaskFiles）：同一份文件只列最新一版，
 * 主交付物第一，其余文书在前、表格其次；答复摘要与独立复核意见是过程文件，不进 current。
 * older = 交付文件被取代的旧版份数（右栏“成果”里仍可看）。纯函数。
 */
export function currentFiles<T extends VersionedRow>(artifacts: readonly T[], opts: { primary?: string | null } = {}): { current: T[]; older: number; process: T[]; files: FileEntry<T>[] } {
  const s = splitTaskFiles(artifacts, opts);
  return { current: s.files.map((e) => e.latest), older: s.files.reduce((n, e) => n + e.older.length, 0), process: s.process.map((e) => e.latest), files: s.files };
}

/**
 * 右栏“成果”下拉的顺序（V18 A1 #4）：交付文件最新版 → 交付文件旧版 → 过程文件（各自最新在前）。默认选中第一项（主交付物的最新版）。纯函数。
 */
export function artifactOptionOrder<T extends VersionedRow>(artifacts: readonly T[], opts: { primary?: string | null } = {}): { row: T; group: "file" | "older" | "process"; old: boolean }[] {
  const s = splitTaskFiles(artifacts, opts);
  return [
    ...s.files.map((e) => ({ row: e.latest, group: "file" as const, old: false })),
    ...s.files.flatMap((e) => e.older.map((row) => ({ row, group: "older" as const, old: true }))),
    ...s.process.flatMap((e) => [{ row: e.latest, group: "process" as const, old: false }, ...e.older.map((row) => ({ row, group: "process" as const, old: true }))]),
  ];
}

/**
 * 排队中的说明（V18 第 43 批）：被“等你确认或回答”的任务挡住时明说，律师去处理那几个任务，这一个才会开始。
 * 助手在等律师期间仍占着这台电脑的处理名额（内存有限），所以不会自己越过去。纯函数。
 */
export function queuedText(waitingAhead: number): string {
  return waitingAhead > 0
    ? `排队中：前面有 ${waitingAhead} 个任务在等你确认或回答，处理完它们这个任务才会开始。`
    : "排队中：本机同时处理的任务有上限，前面的任务完成后自动开始，不用重新发起。";
}
