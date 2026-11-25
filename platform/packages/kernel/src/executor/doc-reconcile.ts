/**
 * 整单期限复算与跨交付件核对（第 65 批，V39，D-285、D-287）：与整单金额勾稽（D-229）同一层——独立复核之前，内核对本任务最新版的
 * 文书与表格做确定性核对，查出的不一致作为“必须改”（或“须核”）并入复核意见交回修改；修改后由内核重跑同一项核对判断是否落实。
 *
 * - 期限复算（services/deadline-check.ts）：期限表的届满日要有依据，能复算的按期限工具重算——届满日抄错一天就是执业事故，复核模型看不出来；
 * - 跨交付件（services/cross-deliverable-check.ts）：同一编号指向不同证据（必须改）；同一份文件在一份成果里当依据、在另一份里写“不作为依据”（须核，交修改轮与律师判断）。
 *   第 61 批劳动仲裁答辩卡四次没通过，最后两次就是答辩书、证据目录、核对清单对《员工手册（2021版）》的口径相反。
 */
import type { KernelDb } from "../db.ts";
import type { BlobStore } from "../blobs.ts";
import { runCrossIssues } from "../services/cross-deliverable-check.ts";
import { runDeadlineIssues } from "../services/deadline-check.ts";
import type { ReviewFinding } from "../services/independent-review.ts";
import { MACHINE_BASIS } from "./amount-reconcile.ts";

export interface DocIssue {
  key: string;
  filename: string;
  where: string;
  text: string;
  problem: string;
  fix: string;
  must: boolean;
}

/** 一次并入复核意见的期限与跨交付件核对条数上限（与金额勾稽的 8 条分开计；复核意见总数上限 15 条）。 */
export const DOC_FINDINGS_MAX = 4;

/** 对本任务最新版成果做期限复算与跨交付件核对；任一项出错只丢那一项（不因核对本身的缺陷拦住交付）。 */
export function runDocIssues(deps: { db: KernelDb; blobs: BlobStore }, runId: string, matterId: string): DocIssue[] {
  const out: DocIssue[] = [];
  // 两项核对的 key 自带前缀（deadline|、deadline-basis|、role|、evid|……），与金额勾稽的 eq|、orphan| 不会撞
  for (const f of [runDeadlineIssues, runCrossIssues]) {
    try {
      for (const i of f(deps, runId, matterId) as DocIssue[]) out.push(i);
    } catch {
      // 单项核对出错不影响其他项
    }
  }
  return out;
}

/** 写成复核意见（接在金额勾稽之后编号）：必须改的排前面。纯函数。 */
export function docFindings(issues: readonly DocIssue[], startNo: number): (ReviewFinding & { machine_key: string })[] {
  const ordered = [...issues].sort((a, b) => Number(b.must) - Number(a.must));
  return ordered.slice(0, DOC_FINDINGS_MAX).map((i, k) => ({
    no: startNo + k,
    where: `《${i.filename || "交付件"}》${i.where}`,
    problem: i.problem,
    basis: MACHINE_BASIS,
    fix: i.fix,
    must: i.must,
    level: i.must ? ("must" as const) : ("recheck" as const),
    machine_key: i.key,
  }));
}
