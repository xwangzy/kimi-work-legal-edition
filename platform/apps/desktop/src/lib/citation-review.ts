/**
 * 复核页的引用核对（第 13 批复核 B13-U01/U02/U03）：内核按成果文字核验后的结果 → 分组列给律师、算出要勾哪几项、能不能签发。
 * 与内核 services/artifact-citations.ts 的签发门禁同一判定（勾选键相同）。
 */
export interface CitationItem {
  raw: string;
  kind: "wrong" | "case" | "outside" | "ok";
  reason: string | null;
  partial?: boolean;
  /** 按事件时点或地域须核对的一句话（v9.4 S-08）。 */
  timing?: string;
}

export interface ArtifactCitations {
  checked: boolean;
  unchecked_reason?: "format" | "error";
  wrong: number;
  unverified_offline: number;
  outside_registry: number;
  partial?: number;
  unrecognized?: number;
  timing?: number;
  event_date?: string | null;
  items: CitationItem[];
}

export interface CitationNeeds {
  wrong: CitationItem[];
  cases: CitationItem[];
  outside: CitationItem[];
  /** 按事件时点或地域须核对的引用（v9.4 S-08）。 */
  timing: CitationItem[];
  /** 各类条数按内核计数（复核 A-13：条目列表最多 200 条，判断要不要勾选不能只看截断后的列表）。 */
  counts: { wrong: number; cases: number; outside: number; timing: number };
  eventDate: string | null;
  /** 系统没有核对这份文件（格式不认识、读取出错）。 */
  unchecked: boolean;
  /** 只核到条号的条数、没认出是哪部法的“第X条”处数（只提示，复核 R15B-02/05）。 */
  partial: number;
  unrecognized: number;
}

export interface CitationTicks {
  cases: boolean;
  outside: boolean;
  unchecked: boolean;
  timing?: boolean;
}

/** runCases：本次运行在材料里核到的离线案号（与成果里的案号同一个勾选，复核 R2B-27）。 */
export function citationNeeds(ac: ArtifactCitations | null | undefined, runCases = 0): CitationNeeds {
  const rc = Number.isFinite(runCases) && runCases > 0 ? runCases : 0;
  const none = { wrong: 0, cases: rc, outside: 0, timing: 0 };
  if (!ac) return { wrong: [], cases: [], outside: [], timing: [], counts: none, eventDate: null, unchecked: false, partial: 0, unrecognized: 0 };
  if (!ac.checked) return { wrong: [], cases: [], outside: [], timing: [], counts: none, eventDate: null, unchecked: true, partial: 0, unrecognized: 0 };
  const items = Array.isArray(ac.items) ? ac.items : [];
  const wrong = items.filter((i) => i.kind === "wrong");
  const cases = items.filter((i) => i.kind === "case");
  const outside = items.filter((i) => i.kind === "outside");
  const timing = items.filter((i) => typeof i.timing === "string" && i.timing !== "");
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    wrong,
    cases,
    outside,
    timing,
    counts: { wrong: Math.max(n(ac.wrong), wrong.length), cases: Math.max(n(ac.unverified_offline), cases.length) + rc, outside: Math.max(n(ac.outside_registry), outside.length), timing: Math.max(n(ac.timing), timing.length) },
    eventDate: typeof ac.event_date === "string" ? ac.event_date : null,
    unchecked: false,
    partial: n(ac.partial),
    unrecognized: n(ac.unrecognized),
  };
}

/** 交给内核的勾选键（只放需要的；与内核门禁同名）。 */
export function citationChecklist(n: CitationNeeds, t: CitationTicks): Record<string, boolean> {
  return {
    ...(n.counts.cases > 0 ? { citations_cases_checked: t.cases } : {}),
    ...(n.counts.outside > 0 ? { citations_outside_registry_checked: t.outside } : {}),
    ...(n.unchecked ? { citations_unverifiable_checked: t.unchecked } : {}),
    ...(n.counts.timing > 0 ? { citations_event_time_checked: t.timing === true } : {}),
  };
}

/** 引用这一项是否允许签发：有核对不通过的不行；其余各类都须勾选。 */
export function citationsAllowSign(n: CitationNeeds, t: CitationTicks): boolean {
  if (n.counts.wrong > 0) return false;
  return (n.counts.cases === 0 || t.cases) && (n.counts.outside === 0 || t.outside) && (!n.unchecked || t.unchecked) && (n.counts.timing === 0 || t.timing === true);
}

/** 页级读不清的一句话：“2 份共 5 页（合同.pdf 第 3、4 页；…）”。页号连成区间，最多列 3 份。 */
export function partialPagesText(all: { filename: string; pages: number[]; total: number }[]): string {
  // 只数识别不清、读不出的页（几乎没有文字的页另写一句，余项续复核 RC-B-04）
  const list = all.filter((x) => x.total > 0);
  const total = list.reduce((n, x) => n + x.total, 0);
  const span = (ps: number[]) => {
    const out: string[] = [];
    for (let i = 0; i < ps.length; ) {
      let j = i;
      while (j + 1 < ps.length && ps[j + 1] === ps[j]! + 1) j++;
      out.push(i === j ? `${ps[i]}` : `${ps[i]}–${ps[j]}`);
      i = j + 1;
    }
    return out.join("、");
  };
  const shown = list.slice(0, 3).map((x) => `${x.filename} 第 ${span(x.pages)} 页${x.total > x.pages.length ? " 等" : ""}`);
  return `${list.length} 份共 ${total} 页（${shown.join("；")}${list.length > 3 ? "；另有 " + (list.length - 3) + " 份" : ""}）`;
}

/** 几乎没有文字的页（空白页、印章页、签署页）：只写总数，不算“读不清”（余项续复核 RC-B-04）；没有返回空串。 */
export function blankPagesText(list: { blank?: number }[]): string {
  const n = list.reduce((k, x) => k + (x.blank ?? 0), 0);
  return n > 0 ? `另有 ${n} 页几乎没有文字（多为空白页、印章页或签署页），没有算作读不清` : "";
}
