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

/** 组头的份数：筛选后只显示一部分时写“本次 N 份，此处显示 M 份”（复核 RB16B-11）。 */
export function taskCountText(shown: number, total: number): string {
  return total > shown ? `本次 ${total} 份，此处显示 ${shown} 份` : `${shown} 份`;
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
export type PackageReason = "internal" | "not_signed" | "superseded" | "rejected";
export const PACKAGE_REASON_TEXT: Record<PackageReason, string> = {
  internal: "内部稿，不随包（对外请用对外版或客户版）",
  not_signed: "还没签发",
  superseded: "已有更新版本",
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
    const reason: PackageReason | null = !isLatest || r.status === "superseded" ? "superseded" : r.status === "rejected" ? "rejected" : r.status !== "approved" ? "not_signed" : (r.audience ?? "internal") === "internal" ? "internal" : null;
    if (reason) held.push({ row: r, reason });
    else ready.push(r);
  }
  return { ready, held };
}

/** 内核估价回传的交付要求（与发起时写进快照、结算时核对的是同一个纯函数，V11 deliverableRequest）。 */
export interface DeliverableRequestView {
  formats: ("docx" | "xlsx" | "pdf")[];
  not: ("docx" | "xlsx" | "pdf")[];
  document: "revise" | "draft" | null;
}

/**
 * 发起确认里的“交付”一行（V12 D11：律师写了“出 Word”，确认卡上看不到会交什么，交错了只能事后发现）。
 * `deliverables` 是内核估价按结算同一规则算出的应交清单（方法主交付物 + 律师点名的格式 + 文书意图），界面只负责写成律师话。
 * 非 AI 任务返回 null（不显示）；什么都没指定时如实写“未指定”。纯函数。
 */
export function deliverSheetLine(o: { agent: boolean; deliverables?: readonly string[] | null; req?: DeliverableRequestView | null }): string | null {
  if (!o.agent) return null;
  const name = (x: string) => {
    if (x === "Word 文书.docx") return o.req?.document === "revise" ? "在原件上的修订稿与清洁稿（Word）" : "Word 文书";
    if (x === "Excel 表.xlsx") return "Excel 表";
    return /\.docx$/i.test(x) ? `《${x.replace(/\.docx$/i, "")}》（Word）` : /\.xlsx$/i.test(x) ? `《${x.replace(/\.xlsx$/i, "")}》（Excel）` : x;
  };
  const items = (o.deliverables ?? []).map(name);
  if (o.req?.formats.includes("pdf")) items.push("PDF 在定稿后从成果导出");
  const nots = (o.req?.not ?? []).map((f) => ({ docx: "Word", xlsx: "Excel", pdf: "PDF" })[f]);
  if (items.length === 0) return nots.length ? `不要 ${nots.join("、")}；其余按任务需要` : "未指定：按任务需要（要 Word 或 Excel 请在说明里写明）";
  return `${items.join("；")}${nots.length ? `（不要 ${nots.join("、")}）` : ""}——没交出会记“部分完成”`;
}
