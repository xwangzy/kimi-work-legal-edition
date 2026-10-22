/**
 * 开始面板的补全提示（v9.4 第 22 批；评审 C1 §1 #24：命中方法时，缺立场 / 法域 / 截止日等再提示补全）。
 * 立场与法域在发起时由内核强制（没有不能开始）；这里只提示“填了结果更准”的事项信息——事件时点、地域、阶段，不拦着开始。
 * 只按方法列：这个方法确实用得到的才提示，免得每张卡都催律师填表。
 */
import type { Matter } from "../api.ts";

export type HintField = "event_date" | "region" | "stage";

export interface FactHint {
  field: HintField;
  label: string;
  /** 为什么要填（一句话）。 */
  why: string;
}

const EVENT = (why: string): FactHint => ({ field: "event_date", label: "事件时点", why });
const REGION = (why: string): FactHint => ({ field: "region", label: "地域", why });
const STAGE = (why: string): FactHint => ({ field: "stage", label: "当前阶段", why });
const CITE = EVENT("签发前按事件发生时的版本核对引用");

export const HINTS_BY_SKILL: Readonly<Record<string, readonly FactHint[]>> = {
  "procedure-check": [EVENT("时效从何时起算、适用哪一版法律，都看事情发生的时间")],
  "labor-dispute": [REGION("经济补偿基数、加班费等按当地口径"), EVENT("仲裁时效与适用的规定看事情发生的时间")],
  "policy-review": [REGION("地方性规定按当地核对")],
  "case-analysis": [STAGE("分析的重点随所处阶段不同"), CITE],
  "pleading-draft": [CITE],
  "defense-draft": [CITE],
  "appeal-draft": [CITE],
  "agency-statement": [STAGE("代理词按一审、二审写法不同"), CITE],
  "legal-research-memo": [CITE],
  "citation-check": [CITE],
};

/** 这个方法用得到、而事项还没填的信息。 */
export function matterFactHints(skill: string | null | undefined, matter: Pick<Matter, "event_date" | "region" | "stage"> | null | undefined): FactHint[] {
  if (!skill || !matter) return [];
  return (HINTS_BY_SKILL[skill] ?? []).filter((h) => !String(matter[h.field] ?? "").trim());
}

/** 用审查要点的方法（与内核 services/review-rules.ts 的 RULES_SKILLS 一致）。 */
export const RULES_SKILLS: readonly string[] = ["contract-review", "redraft-review", "contract-draft"];
