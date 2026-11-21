/** 事实表的计数与出处一句话（复核 R15B-01）。纯函数。 */
import type { FactRow } from "../api.ts";

export function factCounts(facts: Pick<FactRow, "status">[]): { proposed: number; confirmed: number; rejected: number } {
  const out = { proposed: 0, confirmed: 0, rejected: 0 };
  for (const f of facts) out[f.status] += 1;
  return out;
}

/** 事实序号的写法（V16 第 41 批）：与交付件里的“事实 12”一致，律师按序号在事实页找到它。旧内核没有序号时为空。 */
export function factRef(f: Partial<Pick<FactRow, "no">>): string {
  return typeof f.no === "number" && f.no > 0 ? `事实 ${f.no}` : "";
}

/** 出处：材料名 + 能否在材料里定位到原文。 */
export function factSourceText(f: Pick<FactRow, "document_version_id" | "anchor_status" | "page">, fileOf: Map<string, string>): string {
  if (!f.document_version_id) return "没有关联材料";
  const name = fileOf.get(f.document_version_id) ?? "材料";
  // 按页解析的材料（PDF 等）带页码（v9.4 第 22 批）；Word 没有版面页码
  if (f.anchor_status === "located") return f.page ? `${name} 第 ${f.page} 页` : name;
  if (f.anchor_status === "ambiguous") return `${name}（原文出现多处）`;
  return `${name}（没有找到原文，确认前请核对）`;
}

/**
 * 按发生日期排（第 55 批：事实页是一条时间线）。日期不明的排在最后；同一天的按序号。不改原数组。
 * 日期可能只到月或年（“2025-03”），按字符串比较即可（ISO 写法）。
 */
export function sortFactsByDate<T extends Pick<FactRow, "occurred_on"> & Partial<Pick<FactRow, "no">>>(facts: readonly T[]): T[] {
  return [...facts].sort((a, b) => {
    if (a.occurred_on && b.occurred_on) return a.occurred_on < b.occurred_on ? -1 : a.occurred_on > b.occurred_on ? 1 : (a.no ?? 0) - (b.no ?? 0);
    if (a.occurred_on) return -1;
    if (b.occurred_on) return 1;
    return (a.no ?? 0) - (b.no ?? 0);
  });
}
