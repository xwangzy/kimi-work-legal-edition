/**
 * 首页“继续工作”的状态胶囊写“下一步”，不写系统状态（Z3 评审 #3、历史 Demo D-1）：
 * 有未处理的审查意见 → “n 项意见待处理”（橙）；有待复核成果 → “待你复核”（蓝）；还有没提交复核的草稿 → “草稿待提交复核”（蓝，复核 B13-U09：
 * 未签发的草稿不标绿色“可以下载”）；有已签发的文件 → “可以下载”（绿）；出错 → “需要重试”（红）。纯函数。
 */
import { RUN_STATUS_LABELS } from "./labels.ts";

export type NextStepTone = "pill-orange" | "pill-blue" | "pill-green" | "pill-red" | "pill-gray";

export interface RunFacts {
  status: string;
  /** 未处理的审查意见数（没有审查意见时为 0 或缺省）。 */
  openOpinions?: number;
  /** 本任务成果里待复核的份数。 */
  pendingReview?: number;
  /** 本任务的成果份数。 */
  artifacts?: number;
  /** 其中还是草稿（未提交复核）的份数。 */
  drafts?: number;
  /** 其中已签发的份数（给出时“可以下载”只看它）。 */
  approved?: number;
}

const BASE_TONE: Record<string, NextStepTone> = {
  waiting_approval: "pill-orange",
  waiting_input: "pill-orange",
  reconciling: "pill-orange",
  queued: "pill-blue",
  running: "pill-blue",
  succeeded: "pill-green",
  partial: "pill-orange",
  failed: "pill-red",
  timed_out: "pill-red",
  expired: "pill-gray",
  cancelled: "pill-gray",
};

export function nextStepPill(r: RunFacts): { text: string; tone: NextStepTone } {
  if (r.status === "failed" || r.status === "timed_out") return { text: "需要重试", tone: "pill-red" };
  if (r.status === "succeeded" || r.status === "partial") {
    if ((r.openOpinions ?? 0) > 0) return { text: `${r.openOpinions} 项意见待处理`, tone: "pill-orange" };
    if ((r.pendingReview ?? 0) > 0) return { text: "待你复核", tone: "pill-blue" };
    if ((r.drafts ?? 0) > 0) return { text: "草稿待提交复核", tone: "pill-blue" };
    if ((r.approved ?? r.artifacts ?? 0) > 0) return { text: "可以下载", tone: "pill-green" };
  }
  return { text: RUN_STATUS_LABELS[r.status] ?? r.status, tone: BASE_TONE[r.status] ?? "pill-gray" };
}
