/**
 * 材料初判（v9.4 第 22 批；评审 C1 §1 #28）：内核按规则认出文书类型、合同类型与篇幅（materials.triage），这里写成材料表里的一句话，
 * 并按我方立场与业务线给一个建议的方法卡。只做建议：不改文件、不自动发起。
 */
import type { Matter, MaterialTriage } from "../api.ts";
import { matterLine, SCENARIOS, type ScenarioCard } from "./scenarios.ts";

/** “合同 · 买卖 · 约 1.2 万字”。 */
export function triageText(t: MaterialTriage): string {
  const size = t.pages ? `${t.pages} 页` : t.chars >= 10_000 ? `约 ${(t.chars / 10_000).toFixed(1)} 万字` : `约 ${Math.max(100, Math.round(t.chars / 100) * 100)} 字`;
  return [t.label, t.contract_type?.replace(/（[^）]*）/g, ""), size].filter(Boolean).join(" · ");
}

/** 建议的方法卡（认不出或没有合适方法的不建议）。 */
export function triageSuggestion(t: MaterialTriage, matter: Pick<Matter, "stance"> | null): ScenarioCard | null {
  const stance = matter?.stance ?? "";
  const pick = (id: string) => SCENARIOS.find((c) => c.id === id) ?? null;
  switch (t.kind) {
    case "contract":
    case "supplement":
      return pick(matterLine(matter) === "inhouse" ? "contract-review-inhouse" : "contract-review");
    case "complaint":
      return stance === "被告" ? pick("defense") : null;
    case "labor_application":
      return stance === "用人单位" ? pick("labor-response") : null;
    // 判决、裁决类只在诉讼事项里建议（非诉、企业法务事项里它们多是参考材料；走查发现在采购合同审查事项里建议“起草上诉状”不合适）
    case "judgment_first":
      return matterLine(matter) === "litigation" ? pick("appeal") : null;
    case "judgment_final":
    case "award":
    case "mediation":
      return matterLine(matter) !== "litigation" || stance === "被告" || stance === "被申请人" || stance === "被上诉人" ? null : pick("enforcement");
    case "policy":
      return pick("policy-review");
    // 证据目录（复核 Q4-04 新增的类型）：诉讼事项里建议整理案卷
    case "evidence_list":
      return matterLine(matter) === "litigation" ? pick("casefile") : null;
    default:
      return null;
  }
}
