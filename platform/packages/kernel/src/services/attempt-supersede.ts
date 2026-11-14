/**
 * 重新运行时，上一次运行留下的成果“已被取代”（第 44 批真实验收发现，催款律师函任务）。
 *
 * “重新运行”沿用同一个任务编号：助手从头再做一遍，会重新问律师、重新定计划。原先上一次运行登记的文件（成果行按任务编号挂着）
 * 仍算在本次成果里——第一次运行出了按 10 日付款期限算的《依据与发送前核对》，额度拦下后重新运行，律师这次选了“送达后 7 日”，
 * 新出的核对表与律师函都是 7 日；独立复核把旧表也当复核对象、列为“必须改”，修改轮只改了标题，回看判“未落实”，任务记部分完成；
 * 任务页“本次交付的文件”里两张核对表并列，律师分不清用哪张。
 *
 * 做法：Agent 要从头重跑的那一刻（没有成果检查点；对账后重试按检查点结算的那条路不经过这里），
 * - 本任务此前登记、仍是草稿的成果标成 superseded（界面“已被替代”，收进“上一次运行的文件”，只给预览与下载；不能再提交复核）；
 *   律师已提交复核、已签发的不动——那是律师对那一份文件的决定，不由重新运行替律师撤回；
 * - 此前的论点提纲（待确认的与已确认的）标成 withdrawn：新的一次按律师这次确认的论点起草，旧的确认不再放行文书工具；
 * - 除材料快照（同一组材料）外的步骤检查点清掉：Agent 之后的各步（系统生成的事实时间线、修订稿、独立复核与修改轮）跟着重做。
 * 内核里凡是“本任务这一次的成果”（复核对象、修改轮的文件、文件清单、最终答复、主交付物核对、到时限已交出、同名缩水检查、追问可改的文件）
 * 都带 LIVE_ARTIFACT 条件，不再把被取代的旧文件算进来。
 */
import type { KernelDb } from "../db.ts";

/** 成果行条件：已被重新运行取代的不算（SQL 片段，可带表别名前缀用 liveArtifact("a")）。 */
export const LIVE_ARTIFACT = "status <> 'superseded'";
export const liveArtifact = (alias: string): string => `${alias}.status <> 'superseded'`;

export interface SupersededFiles {
  /** 标成“已被取代”的成果（此前登记、仍是草稿）。 */
  files: { artifact_version_id: string; kind: string; filename: string }[];
  /** 律师已提交复核或已签发、保留不动的成果。 */
  kept: { artifact_version_id: string; filename: string; status: string }[];
  /** 撤回的论点提纲份数。 */
  outlines: number;
  /** 清掉的步骤检查点个数（不含材料快照）。 */
  checkpoints: number;
}

/**
 * Agent 从头重跑前调用：把本任务此前各次运行的草稿成果标成已被取代、撤回旧提纲、清掉 Agent 之后各步的检查点。
 * 第一次运行时什么都没有，返回全空。调用方须已确认没有成果检查点（agent_store_draft）——有检查点时不重跑，按检查点结算。同一事务。
 */
export function supersedeEarlierAttempts(db: KernelDb, runId: string): SupersededFiles {
  return db.tx(() => {
    const rows = db.all<{ artifact_version_id: string; kind: string; filename: string; status: string }>(
      `SELECT artifact_version_id, kind, filename, status FROM artifact_versions WHERE run_id = ? AND ${LIVE_ARTIFACT} ORDER BY created_at, version`,
      [runId],
    );
    const files = rows.filter((r) => r.status === "draft").map(({ artifact_version_id, kind, filename }) => ({ artifact_version_id, kind, filename }));
    const kept = rows.filter((r) => r.status !== "draft").map(({ artifact_version_id, filename, status }) => ({ artifact_version_id, filename, status }));
    if (files.length > 0) db.run(`UPDATE artifact_versions SET status = 'superseded' WHERE run_id = ? AND status = 'draft'`, [runId]);
    const outlines = db.run(`UPDATE argument_outlines SET status = 'withdrawn' WHERE run_id = ? AND status IN ('proposed','confirmed')`, [runId]).changes;
    const checkpoints = db.run(`DELETE FROM step_checkpoints WHERE run_id = ? AND step_name <> 'load_materials'`, [runId]).changes;
    return { files, kept, outlines, checkpoints };
  });
}

/**
 * 按内容去重命中的成果行已被取代（新的一次生成了与上一次字节相同的文件）：这一份就是这一次的成果，恢复成草稿。
 * 只动 superseded 的行；返回是否恢复。
 */
export function reviveSuperseded(db: KernelDb, artifactVersionId: string): boolean {
  return db.run(`UPDATE artifact_versions SET status = 'draft' WHERE artifact_version_id = ? AND status = 'superseded'`, [artifactVersionId]).changes > 0;
}
