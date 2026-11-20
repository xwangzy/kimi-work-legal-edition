import { SCENARIO_LABELS } from "./labels.ts";
import { scenarioOfRun } from "./scenarios.ts";

/** 交付件列表按事项分组（Z3 评审 #2）：保持传入顺序（新的在前），每个事项一组，组按其中最新一份的先后排列。纯函数。 */
export function groupDeliverables<T extends { matter_id: string; matter_title: string }>(rows: T[]): { matter_id: string; matter_title: string; rows: T[] }[] {
  const out: { matter_id: string; matter_title: string; rows: T[] }[] = [];
  const at = new Map<string, number>();
  for (const r of rows) {
    let i = at.get(r.matter_id);
    if (i === undefined) {
      i = out.length;
      at.set(r.matter_id, i);
      out.push({ matter_id: r.matter_id, matter_title: r.matter_title, rows: [] });
    }
    out[i]!.rows.push(r);
  }
  return out;
}

export interface TaskGroupRow {
  run_id?: string | null;
  run_scenario?: string | null;
  run_skill?: string | null;
  run_created_at?: string | null;
  created_at: string;
}

/**
 * 一个事项里的交付件再按“一次任务”分组（Astra M-3）：同一任务生成的修订稿、意见书、清单成组列出；组按其中最新一份的先后排列，
 * 组名由调用方给（场景卡名称 + 开始时刻）。没有所属任务的（工作台直接生成、示例事项、手工登记）归入一组 run_id = null。纯函数。
 */
export function groupByTask<T extends TaskGroupRow>(rows: T[]): { run_id: string | null; scenario: string | null; skill: string | null; started_at: string | null; rows: T[] }[] {
  const out: { run_id: string | null; scenario: string | null; skill: string | null; started_at: string | null; rows: T[] }[] = [];
  const at = new Map<string, number>();
  for (const r of rows) {
    const k = r.run_id ?? "";
    let i = at.get(k);
    if (i === undefined) {
      i = out.length;
      at.set(k, i);
      out.push({ run_id: r.run_id ?? null, scenario: r.run_scenario ?? null, skill: r.run_skill ?? null, started_at: r.run_created_at ?? null, rows: [] });
    }
    out[i]!.rows.push(r);
  }
  return out;
}

/** 任务组的名称：场景卡名称（审合同、整理案卷……）+ 开始时刻；没有所属任务的（工作台直接生成的修订稿、示例、手工登记）归“其他”。 */
export function taskGroupLabel(g: { run_id: string | null; scenario: string | null; skill: string | null; started_at: string | null }, fmt: (iso: string) => string): string {
  if (!g.run_id) return "其他（工作台生成、示例或手工登记）";
  const card = scenarioOfRun({ scenario: g.scenario, input_snapshot: { skill: g.skill } });
  const name = card?.title ?? (g.scenario ? SCENARIO_LABELS[g.scenario] : undefined) ?? "任务";
  return g.started_at ? `${name} · ${fmt(g.started_at)}` : name;
}

/** 任务组的主交付物（场景卡定义的文件名）；取不到返回 null，排序时按 文书 → 表格。 */
export function taskPrimary(g: { run_id: string | null; scenario: string | null; skill: string | null }): string | null {
  if (!g.run_id) return null;
  return scenarioOfRun({ scenario: g.scenario, input_snapshot: { skill: g.skill } })?.primary ?? null;
}

/** 组头的份数：筛选后只显示一部分时写“本次 N 份，此处显示 M 份”（复核 RB16B-11）。 */
export function taskCountText(shown: number, total: number): string {
  return total > shown ? `本次 ${total} 份，此处显示 ${shown} 份` : `${shown} 份`;
}

/**
 * V18 A2：一次任务的成果分成“交付文件”与“过程文件”，每份文件只列最新版、旧版收进版本记录。
 * 任务页、事项成果页、全局成果页三处共用（不各算各的）。只改显示，不改内核数据与状态：签发、提交复核、交付包仍对着具体那一个版本。
 */
/** 过程文件：任务的答复摘要（最终回复草稿）与独立复核意见。它们是给律师看的过程记录，不是要交出去的文件。 */
export const PROCESS_KINDS: ReadonlySet<string> = new Set(["a1_agent_draft", "a1_agent_draft_partial", "a1_review_note"]);

export interface VersionedRow {
  artifact_version_id: string;
  kind: string;
  filename: string;
  audience?: string | null;
  /** 成果状态；superseded = 重新运行前那一次留下的、已被这一次取代（第 44 批）。 */
  status?: string;
  /** 这份文件里的第几版（内核 withFileVersions 换算后的）。 */
  version?: number | string;
  /** 内核原编号（按种类递增）；比先后时优先用它。 */
  kind_version?: number | string;
  /** 内核按“同一份文件”（lineage）给的是否最新版。 */
  is_latest?: boolean;
  created_at?: string;
}

export interface FileEntry<T> {
  /** 同一份文件的判定键：种类 + 受众 + 文件名（去掉末尾日期与“部分完成”）。 */
  key: string;
  /** 这组里最新的一版（签发、提交复核、预览都对着它）。 */
  latest: T;
  /** 旧版，新的在前。 */
  older: T[];
  /** 这一版在本组里最新，但内核说它已被更新的版本取代（更新的那版在后面的追问任务里）。 */
  replaced: boolean;
  /** 这一组全是重新运行前那一次留下的文件（第 44 批：已被这一次重新运行取代，不算本次成果）。 */
  earlier: boolean;
}

/** 文件名末尾的日期与“部分完成”不算文件身份（与内核 artifact-lineage.ts 的 docNameKey 同一规则）。 */
export function fileNameKey(filename: string): string {
  return filename.replace(/-\d{4}-\d{2}-\d{2}(-部分完成)?(?=(\.[A-Za-z0-9]{1,8})?$)/, "").trim();
}

/** 文件类型（行首标签）：按扩展名。 */
export function fileTypeLabel(filename: string): string {
  if (/\.docx?$/i.test(filename)) return "Word";
  if (/\.xlsx?$/i.test(filename)) return "Excel";
  if (/\.pdf$/i.test(filename)) return "PDF";
  if (/\.csv$/i.test(filename)) return "表格";
  return "文本";
}

const ver = (a: VersionedRow) => Number(a.kind_version ?? a.version ?? 0);
const stem = (s: string) =>
  fileNameKey(s)
    .replace(/\.[A-Za-z0-9]{1,8}$/, "")
    .replace(/[（(]\s*(草稿|初稿)\s*[）)]/g, "")
    .trim();
/** 文书在前、表格其次、其他最后（取不到主交付物时的顺序）。 */
const rank = (a: VersionedRow) => (/\.(docx?|md|markdown|txt|pdf)$/i.test(a.filename) ? 0 : /\.(xlsx?|csv)$/i.test(a.filename) ? 1 : 2);

/** 是不是这次任务的主交付物（场景卡或方法定义的文件名，如“法律意见书（草稿）.docx”；实际文件名常带事项后缀）。 */
export function isPrimaryFile(filename: string, primary: string | null | undefined): boolean {
  if (!primary) return false;
  const p = stem(primary);
  return !!p && stem(filename).startsWith(p);
}

function entries<T extends VersionedRow>(rows: readonly T[]): FileEntry<T>[] {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    // 部分完成的答复与完整答复是同一份答复
    const kind = r.kind === "a1_agent_draft_partial" ? "a1_agent_draft" : r.kind;
    const k = `${kind}\u0000${r.audience ?? "internal"}\u0000${fileNameKey(r.filename ?? "")}`;
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  return [...groups.entries()].map(([key, g]) => {
    const sorted = [...g].sort((a, b) => ver(b) - ver(a) || String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
    // 重新运行前那一次留下的版本（第 44 批）不当最新版：同名文件这一次又出了的，旧的收进旧版；这一次没再出的，整组归“上一次运行的文件”
    const live = sorted.filter((a) => !isEarlierRun(a));
    if (live.length === 0) return { key, latest: sorted[0]!, older: sorted.slice(1), replaced: false, earlier: true };
    // 内核给了 is_latest 就用它：本组里标了最新的那版排第一；本组没有一版是最新（更新的在别的任务里）时取本组最新的一版
    const flagged = live.find((a) => a.is_latest === true);
    const latest = flagged ?? live[0]!;
    return { key, latest, older: sorted.filter((a) => a !== latest), replaced: latest.is_latest === false, earlier: false };
  });
}

/** 重新运行前那一次留下的、已被这一次取代的成果（内核在 Agent 从头重跑时标成 superseded；第 44 批）。 */
export function isEarlierRun(r: { status?: string | null }): boolean {
  return r.status === "superseded";
}

/**
 * 把一次任务的成果分成交付文件与过程文件（纯函数）。交付文件：主交付物第一，其余文书在前、表格其次，同类按首次出现的顺序；
 * 过程文件：答复摘要在前、独立复核意见其次。earlier：重新运行前那一次留下、这一次没再出的文件（第 44 批），不算交付文件也不算过程文件，
 * 按生成先后列出，只给预览与下载。
 */
export function splitTaskFiles<T extends VersionedRow>(rows: readonly T[], opts: { primary?: string | null } = {}): { files: FileEntry<T>[]; process: FileEntry<T>[]; earlier: FileEntry<T>[] } {
  const every = entries(rows);
  const all = every.filter((e) => !e.earlier);
  const files = all.filter((e) => !PROCESS_KINDS.has(e.latest.kind));
  const order = new Map(files.map((e, i) => [e, i]));
  // 同类按这份文件第一次生成的先后（任务页按登记顺序、成果页按新到旧传入，排出来一样）
  const born = (e: FileEntry<T>) => [e.latest, ...e.older].reduce((m, r) => (r.created_at && (!m || r.created_at < m) ? r.created_at : m), "");
  files.sort((a, b) => {
    const pa = isPrimaryFile(a.latest.filename, opts.primary) ? 0 : 1;
    const pb = isPrimaryFile(b.latest.filename, opts.primary) ? 0 : 1;
    return pa - pb || rank(a.latest) - rank(b.latest) || born(a).localeCompare(born(b)) || order.get(a)! - order.get(b)!;
  });
  const process = all.filter((e) => PROCESS_KINDS.has(e.latest.kind)).sort((a, b) => (a.latest.kind === "a1_review_note" ? 1 : 0) - (b.latest.kind === "a1_review_note" ? 1 : 0));
  const earlier = every.filter((e) => e.earlier).sort((a, b) => (PROCESS_KINDS.has(a.latest.kind) ? 1 : 0) - (PROCESS_KINDS.has(b.latest.kind) ? 1 : 0) || born(a).localeCompare(born(b)));
  return { files, process, earlier };
}

/** 一组成果里有几份文件（交付文件，不算旧版与过程文件；已被后面任务取代的不重复计）。 */
export function fileCount<T extends VersionedRow & { status?: string }>(files: readonly FileEntry<T>[], status?: string): number {
  return files.filter((e) => !e.replaced && (!status || e.latest.status === status)).length;
}

/**
 * 预览交付包（v9.4 第 21 批；Astra Demo“预览交付包”，主文 §8 并入交付件）：一次任务的成果里，哪些能交出去、哪些不随包、为什么。
 * 能交出去 = 已签发 + 是同类成果的最新版本 + 受众不是内部；其余按原因分开写，律师一眼看清“交给客户的是哪几份”。
 */
export interface PackageRow {
  artifact_version_id: string;
  kind: string;
  version: number;
  audience?: string | null;
  status: string;
  /** 内核按“同一份文件”判断的是否最新版（v9.4 第 25 批）；旧内核没有这一项时按种类推算。 */
  is_latest?: boolean;
}
export type PackageReason = "internal" | "not_signed" | "superseded" | "earlier_run" | "rejected";
export const PACKAGE_REASON_TEXT: Record<PackageReason, string> = {
  internal: "内部稿，不随包（对外请用对外版或客户版）",
  not_signed: "还没签发",
  superseded: "已有更新版本",
  earlier_run: "重新运行前那一次的文件，已被这一次取代",
  rejected: "已退回",
};
export function deliveryPackage<T extends PackageRow>(rows: readonly T[]): { ready: T[]; held: { row: T; reason: PackageReason }[] } {
  const latest = new Map<string, number>();
  for (const r of rows) {
    const k = `${r.kind}\u0000${r.audience ?? ""}`;
    latest.set(k, Math.max(latest.get(k) ?? 0, r.version));
  }
  const ready: T[] = [];
  const held: { row: T; reason: PackageReason }[] = [];
  for (const r of rows) {
    const isLatest = typeof r.is_latest === "boolean" ? r.is_latest : latest.get(`${r.kind}\u0000${r.audience ?? ""}`) === r.version;
    const reason: PackageReason | null = r.status === "superseded" ? "earlier_run" : !isLatest ? "superseded" : r.status === "rejected" ? "rejected" : r.status !== "approved" ? "not_signed" : (r.audience ?? "internal") === "internal" ? "internal" : null;
    if (reason) held.push({ row: r, reason });
    else ready.push(r);
  }
  return { ready, held };
}

/* ── 第 49 批：成果页“待处理 / 已签发 / 全部”、名称差异强调、页首摘要 ── */

/** 成果页的筛选（第 49 批）：律师的工作清单是“待处理”（草稿、待复核、退回），已签发是归档。 */
export type DeliverableFilter = "todo" | "approved" | "all";
/** 算“待处理”的状态：草稿（还没复核）、待复核（等人签发）、退回（要改）。 */
export const TODO_STATUSES: ReadonlySet<string> = new Set(["draft", "pending_review", "rejected"]);

/** 一份文件是否落在这个筛选里（按最新版状态；被后面任务取代的不算）。 */
export function inFilter(status: string, f: DeliverableFilter): boolean {
  if (f === "all") return true;
  if (f === "approved") return status === "approved";
  return TODO_STATUSES.has(status);
}

/**
 * 页首一句话（第 49 批）：先说“等你处理的是什么”，再说规则；没有成果时说成果从哪来。
 * 例：“2 份等你复核签发，4 份草稿还没复核” / “6 份草稿还没复核” / “都已签发，共 5 份”。
 */
export function deliverablesSummary(n: { pending_review: number; draft: number; rejected: number; approved: number }): string {
  const parts: string[] = [];
  if (n.pending_review > 0) parts.push(`${n.pending_review} 份等你复核签发`);
  if (n.draft > 0) parts.push(`${n.draft} 份草稿还没复核`);
  if (n.rejected > 0) parts.push(`${n.rejected} 份被退回待修改`);
  if (parts.length > 0) return parts.join("，");
  if (n.approved > 0) return `都已签发，共 ${n.approved} 份`;
  return "还没有成果：任务完成后，生成的文件会出现在这里";
}

/** 名称里可以断开的位置（断在这些字符之前）：括号、连接符、间隔号、空格。 */
const NAME_BREAK = /[（(【\[—\-·\s_]/;

/** 两个名称的共同前缀，退到最后一个可断开处（断点字符留给差异部分）；不足 6 个字或会吃掉整名时为 0。 */
function sharedHead(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  for (let k = i; k >= 6; k--) {
    if (NAME_BREAK.test(a[k] ?? "") && NAME_BREAK.test(b[k] ?? "") && k < a.length && k < b.length) return k;
  }
  return 0;
}

/**
 * 同一次任务里常有几份文件共用一长串前缀（如“冷链智能分拣系统采购与实施合同（棠溪智能提供稿）（修订稿）/（清洁稿）/（修改对照表）”），
 * 旁边还有名称完全不同的“审查意见书”“问题清单”。逐份找它与同组其他文件最长的共同前缀（断在括号、连接符处、≥ 6 个字、
 * 留得下差异），把这段淡化、差异部分加粗：律师一眼看出几个版本的区别，又不丢原名（第 49 批）。没有同族文件的名称 head 为空。纯函数。
 */
export function nameParts(names: readonly string[]): Map<string, { head: string; tail: string }> {
  const uniq = [...new Set(names)];
  const out = new Map<string, { head: string; tail: string }>();
  for (const n of uniq) {
    let best = 0;
    for (const m of uniq) if (m !== n) best = Math.max(best, sharedHead(n, m));
    out.set(n, { head: n.slice(0, best), tail: n.slice(best) });
  }
  return out;
}
