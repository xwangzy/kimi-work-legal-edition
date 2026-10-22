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
  /** 论断—依据（v9.4 C-03）：本处引用的稳定编号、论断原句（令牌形态）、法规名、版本施行日、条文原文、律师的逐条决定。 */
  key?: string;
  claim?: string;
  law_name?: string | null;
  effective?: string | null;
  article_text?: string | null;
  decision?: "supported" | "unsupported" | "acknowledged" | null;
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
  support_pending?: number;
  unsupported?: number;
  total?: number;
  items: CitationItem[];
}

export interface CitationNeeds {
  wrong: CitationItem[];
  cases: CitationItem[];
  outside: CitationItem[];
  /** 按事件时点或地域须核对的引用（v9.4 S-08）。 */
  timing: CitationItem[];
  /** 各类条数按内核计数（复核 A-13：条目列表最多 200 条，判断要不要勾选不能只看截断后的列表）。 */
  counts: { wrong: number; cases: number; outside: number; timing: number; supportPending: number; unsupported: number };
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
  const none = { wrong: 0, cases: rc, outside: 0, timing: 0, supportPending: 0, unsupported: 0 };
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
    counts: { wrong: Math.max(n(ac.wrong), wrong.length), cases: Math.max(n(ac.unverified_offline), cases.length) + rc, outside: Math.max(n(ac.outside_registry), outside.length), timing: Math.max(n(ac.timing), timing.length), supportPending: n(ac.support_pending), unsupported: n(ac.unsupported) },
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
  // 支持性（C-03）：标为不支持的须改正；系统核到的每条都要逐条决定（内核同一判定）
  if (n.counts.unsupported > 0 || n.counts.supportPending > 0) return false;
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

/**
 * 论断—依据对照（v9.4 第 20 批 C-03；评审 C1 §4）：每处引用的三层状态（来源 / 版本 / 支持）与颜色。
 * 颜色取三层里最弱的一层：红 = 核对不通过或律师标为不支持；灰 = 系统没法核对（库外、案号离线、读不出）；橙 = 支持待判；
 * 紫 = 律师确认支持（沿用“律师已确认”的颜色）；“我已知悉”用细边（律师看过但没有确认支持，不显示成认可的绿色）。
 */
export type CiteTone = "red" | "gray" | "orange" | "confirmed" | "ack";
export function citeTone(i: CitationItem): CiteTone {
  if (i.kind === "wrong" || i.decision === "unsupported") return "red";
  if (i.kind !== "ok") return "gray";
  if (i.decision === "supported") return "confirmed";
  if (i.decision === "acknowledged") return "ack";
  return "orange";
}

export function citeLayers(i: CitationItem): { source: string; version: string; support: string } {
  if (i.kind === "case") return { source: "未核（案号离线）", version: "—", support: "待判" };
  if (i.kind === "outside") return { source: "未核（法规库没有）", version: "—", support: "待判" };
  if (i.kind === "wrong") return { source: "不通过", version: "不通过", support: "—" };
  return {
    source: "已核",
    version: i.timing ? "须按事件时点核对" : i.effective ? `已核（${i.effective} 施行版）` : "已核",
    support: i.decision === "supported" ? "律师确认支持" : i.decision === "unsupported" ? "律师标为不支持" : i.decision === "acknowledged" ? "律师已知悉" : "待判",
  };
}

const TONE_RANK: Record<CiteTone, number> = { red: 0, orange: 1, gray: 2, ack: 3, confirmed: 4 };
/** 排序：已拦截与不支持 → 支持待判 → 系统没法核对 → 已知悉 → 确认支持（C1 §4.2 ③）。 */
export function sortClaims(items: CitationItem[]): CitationItem[] {
  return items.map((x, i) => [x, i] as const).sort((a, b) => TONE_RANK[citeTone(a[0])] - TONE_RANK[citeTone(b[0])] || a[1] - b[1]).map(([x]) => x);
}

/** 顶部汇总：“5 处引用：律师已确认 1 · 支持待判 2 · 系统没法核对 1 · 不通过 1”。只写不为 0 的。 */
export function claimsSummary(items: CitationItem[]): string {
  const c: Record<CiteTone, number> = { red: 0, orange: 0, gray: 0, ack: 0, confirmed: 0 };
  for (const i of items) c[citeTone(i)] += 1;
  const parts = [
    c.confirmed ? `律师已确认 ${c.confirmed}` : "",
    c.ack ? `律师已知悉 ${c.ack}` : "",
    c.orange ? `支持待判 ${c.orange}` : "",
    c.gray ? `系统没法核对 ${c.gray}` : "",
    c.red ? `不通过或不支持 ${c.red}` : "",
  ].filter(Boolean);
  return `${items.length} 处引用${parts.length ? "：" + parts.join(" · ") : ""}`;
}

/** 角标序号 ①②③…（超过 20 用数字）。 */
export function markOf(n: number): string {
  return n >= 1 && n <= 20 ? String.fromCharCode(0x2460 + n - 1) : `[${n}]`;
}

/** 预览角标：按条目顺序（成果里出现的先后）编号；悬停写三层状态与条文原文开头。 */
export function previewCites(items: CitationItem[], plain: (t: string) => string = (t) => t): import("./safe-preview.ts").PreviewCite[] {
  return items
    .map((i, idx) => ({ i, idx }))
    .filter(({ i }) => !!i.key)
    .map(({ i, idx }) => {
      const l = citeLayers(i);
      const nth = Number(/#(\d+)$/.exec(i.key!)?.[1] ?? 1);
      const head = `${i.law_name ?? i.raw}${i.effective ? ` · ${i.effective} 施行` : ""}`;
      const body = i.article_text ? `\n原文：${i.article_text.replace(/\s+/g, " ").slice(0, 80)}…` : "";
      return { raw: i.raw, nth, mark: markOf(idx + 1), tone: citeTone(i), title: plain(`${head}\n来源 ${l.source} · 版本 ${l.version} · 支持 ${l.support}${body}`) };
    });
}
