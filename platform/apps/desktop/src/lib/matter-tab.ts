/**
 * 事项页默认标签（Z3 评审 IA-4、#10；复核 B13-U04）：每个事项只在首次拿到材料列表时定一次——有材料停在“概览”，
 * 还没有材料停在“材料”；律师点过标签、或已经定过，就不再自动切换（新事项拖入第一份材料后不跳走）。
 */
export function decideMatterTab(decidedFor: string | null, matterId: string | null, docCount: number, touched: boolean): { tab: "board" | "materials" | null; decidedFor: string | null } {
  if (!matterId || decidedFor === matterId) return { tab: null, decidedFor };
  if (touched) return { tab: null, decidedFor: matterId };
  return { tab: docCount > 0 ? "board" : "materials", decidedFor: matterId };
}
