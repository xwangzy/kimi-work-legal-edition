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
  /** 系统没有核对这份文件（格式不认识、读取出错）。 */
  unchecked: boolean;
}

export interface CitationTicks {
  cases: boolean;
  outside: boolean;
  unchecked: boolean;
}

export function citationNeeds(ac: ArtifactCitations | null | undefined): CitationNeeds {
  if (!ac) return { wrong: [], cases: [], outside: [], unchecked: false };
  if (!ac.checked) return { wrong: [], cases: [], outside: [], unchecked: true };
  const items = Array.isArray(ac.items) ? ac.items : [];
  return { wrong: items.filter((i) => i.kind === "wrong"), cases: items.filter((i) => i.kind === "case"), outside: items.filter((i) => i.kind === "outside"), unchecked: false };
}

/** 交给内核的勾选键（只放需要的；与内核门禁同名）。 */
export function citationChecklist(n: CitationNeeds, t: CitationTicks): Record<string, boolean> {
  return {
    ...(n.cases.length > 0 ? { citations_cases_checked: t.cases } : {}),
    ...(n.outside.length > 0 ? { citations_outside_registry_checked: t.outside } : {}),
    ...(n.unchecked ? { citations_unverifiable_checked: t.unchecked } : {}),
  };
}

/** 引用这一项是否允许签发：有核对不通过的不行；其余各类都须勾选。 */
export function citationsAllowSign(n: CitationNeeds, t: CitationTicks): boolean {
  if (n.wrong.length > 0) return false;
  return (n.cases.length === 0 || t.cases) && (n.outside.length === 0 || t.outside) && (!n.unchecked || t.unchecked);
}
