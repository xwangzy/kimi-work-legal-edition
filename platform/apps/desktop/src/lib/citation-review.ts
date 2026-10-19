/**
 * 复核页的引用核对（第 13 批复核 B13-U01/U02/U03）：内核按成果文字核验后的结果 → 分组列给律师、算出要勾哪几项、能不能签发。
 * 与内核 services/artifact-citations.ts 的签发门禁同一判定（勾选键相同）。
 */
export interface CitationItem {
  raw: string;
  kind: "wrong" | "case" | "outside" | "ok";
  reason: string | null;
}

export interface ArtifactCitations {
  checked: boolean;
  unchecked_reason?: "format" | "error";
  wrong: number;
  unverified_offline: number;
  outside_registry: number;
  items: CitationItem[];
}

export interface CitationNeeds {
  wrong: CitationItem[];
  cases: CitationItem[];
  outside: CitationItem[];
  /** 各类条数按内核计数（复核 A-13：条目列表最多 200 条，判断要不要勾选不能只看截断后的列表）。 */
  counts: { wrong: number; cases: number; outside: number };
  /** 系统没有核对这份文件（格式不认识、读取出错）。 */
  unchecked: boolean;
}

export interface CitationTicks {
  cases: boolean;
  outside: boolean;
  unchecked: boolean;
}

/** runCases：本次运行在材料里核到的离线案号（与成果里的案号同一个勾选，复核 R2B-27）。 */
export function citationNeeds(ac: ArtifactCitations | null | undefined, runCases = 0): CitationNeeds {
  const rc = Number.isFinite(runCases) && runCases > 0 ? runCases : 0;
  const none = { wrong: 0, cases: rc, outside: 0 };
  if (!ac) return { wrong: [], cases: [], outside: [], counts: none, unchecked: false };
  if (!ac.checked) return { wrong: [], cases: [], outside: [], counts: none, unchecked: true };
  const items = Array.isArray(ac.items) ? ac.items : [];
  const wrong = items.filter((i) => i.kind === "wrong");
  const cases = items.filter((i) => i.kind === "case");
  const outside = items.filter((i) => i.kind === "outside");
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    wrong,
    cases,
    outside,
    counts: { wrong: Math.max(n(ac.wrong), wrong.length), cases: Math.max(n(ac.unverified_offline), cases.length) + rc, outside: Math.max(n(ac.outside_registry), outside.length) },
    unchecked: false,
  };
}

/** 交给内核的勾选键（只放需要的；与内核门禁同名）。 */
export function citationChecklist(n: CitationNeeds, t: CitationTicks): Record<string, boolean> {
  return {
    ...(n.counts.cases > 0 ? { citations_cases_checked: t.cases } : {}),
    ...(n.counts.outside > 0 ? { citations_outside_registry_checked: t.outside } : {}),
    ...(n.unchecked ? { citations_unverifiable_checked: t.unchecked } : {}),
  };
}

/** 引用这一项是否允许签发：有核对不通过的不行；其余各类都须勾选。 */
export function citationsAllowSign(n: CitationNeeds, t: CitationTicks): boolean {
  if (n.counts.wrong > 0) return false;
  return (n.counts.cases === 0 || t.cases) && (n.counts.outside === 0 || t.outside) && (!n.unchecked || t.unchecked);
}
