/** 事实表的计数与出处一句话（复核 R15B-01）。纯函数。 */
import type { FactRow } from "../api.ts";

export function factCounts(facts: Pick<FactRow, "status">[]): { proposed: number; confirmed: number; rejected: number } {
  const out = { proposed: 0, confirmed: 0, rejected: 0 };
  for (const f of facts) out[f.status] += 1;
  return out;
}

/** 出处：材料名 + 能否在材料里定位到原文。 */
export function factSourceText(f: Pick<FactRow, "document_version_id" | "anchor_status">, fileOf: Map<string, string>): string {
  if (!f.document_version_id) return "没有关联材料";
  const name = fileOf.get(f.document_version_id) ?? "材料";
  if (f.anchor_status === "located") return name;
  if (f.anchor_status === "ambiguous") return `${name}（原文出现多处）`;
  return `${name}（没有找到原文，确认前请核对）`;
}
