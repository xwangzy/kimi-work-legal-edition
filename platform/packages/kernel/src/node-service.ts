/**
 * 所内节点服务逻辑（方案 §5.1/§7.4）：节点执行队列拾取（租约防双跑）与定时/批量任务。
 * 硬门禁（红线：未授权/strict/伦理墙事项零字节到节点——入队、同步、执行三处独立校验，
 * 本模块承担「执行」一处）：claimNodeTask 拾取后、执行前必须再过 assertNodeTaskAllowed。
 * v0 边界：定时任务以间隔秒替代 cron 表达式（cron 解析 G1）；MaaS 席位令牌在 G1 许可流落实
 * （v0 节点用本机 mock/同配端点，与桌面同一模型代理形态）。
 */
import { randomUUID } from "node:crypto";
import { DomainError } from "@zr-legal/domain";
import type { KernelDb } from "./db.ts";
import type { BlobStore } from "./blobs.ts";
import { appendAuditEvent, type LedgerSigner } from "./ledger-signer.ts";
import { dataLevelOf } from "./egress/gate-host.ts";

/** 定时任务审计统一上链（§6.4；signer 未注入的纯函数测试形态降级为直插并注释）。 */
function auditJob(db: KernelDb, signer: LedgerSigner | undefined, job: ScheduledJobRow, action: string, kind: string, objectId: string, matterId: string | null, detailHash: string): void {
  if (signer) {
    appendAuditEvent(db, signer, { tenantId: job.tenant_id, actorId: `job:${job.job_id}`, action, kind, objectId, matterId, detailHash });
  } else {
    db.run(`INSERT INTO audit_events (tenant_id, actor_id, action, object_kind, object_id, detail_hash) VALUES (?,?,?,?,?,?)`, [job.tenant_id, `job:${job.job_id}`, action, kind, objectId, detailHash]);
  }
}

export interface NodeTaskRow {
  task_id: string;
  tenant_id: string;
  matter_id: string;
  scenario: string;
  input_json: string;
  status: string;
  lease_owner: string | null;
  lease_until: string | null;
  attempt_count: number;
  run_id: string | null;
  error: string | null;
  created_by: string;
  created_at: string;
}

export interface ScheduledJobRow {
  job_id: string;
  tenant_id: string;
  kind: "deadline_reminder" | "matter_weekly_report" | "lawdb_watch";
  matter_id: string | null;
  cron_expr: string;
  params_json: string;
  enabled: number;
  lease_owner: string | null;
  lease_until: string | null;
  last_run_at: string | null;
  last_result: string | null;
  created_by: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 执行前硬门禁：node_allowed=1 且非当事人限制（L3b：strict 或当事人拒绝云端处理的记录；授权撤销后的队列残留在此被拦）。 */
export function assertNodeTaskAllowed(db: KernelDb, matterId: string): void {
  const m = db.get<{ node_allowed: number; confidentiality: string; consent_status: string }>(`SELECT node_allowed, confidentiality, consent_status FROM matters WHERE matter_id = ?`, [matterId]);
  if (!m) throw new DomainError("not_found", "事项不存在", 404);
  if (dataLevelOf(m.confidentiality, m.consent_status) === "L3b") throw new DomainError("forbidden", "当事人限制（L3b）的事项不得由节点执行（只在成员电脑上运行）", 403);
  if (m.node_allowed !== 1) throw new DomainError("forbidden", "该事项未授权节点执行（matters.node_authorize 后方可转交）", 403);
}

/**
 * 租约拾取（§7.4 防双跑 v0）：同一时刻最多一个 owner 抢到——UPDATE 带条件原子生效，
 * changes===1 者得；并发抢跑断言：N 个 owner 同时抢恰好 1 胜。lease 过期后可被接管（节点死亡语义）。
 */
export function claimNodeTask(db: KernelDb, owner: string, leaseMs: number): NodeTaskRow | null {
  const now = nowIso();
  const until = new Date(Date.now() + leaseMs).toISOString();
  const next = db.get<{ task_id: string }>(
    `SELECT task_id FROM node_tasks WHERE status = 'queued' AND (lease_until IS NULL OR lease_until < ?) ORDER BY created_at LIMIT 1`,
    [now],
  );
  if (!next) return null;
  const r = db.run(`UPDATE node_tasks SET lease_owner = ?, lease_until = ?, status = 'running', started_at = ?, attempt_count = attempt_count + 1, updated_at = ? WHERE task_id = ? AND status = 'queued' AND (lease_until IS NULL OR lease_until < ?)`, [
    owner,
    until,
    now,
    now,
    next.task_id,
    now,
  ]);
  if (r.changes !== 1) return null; // 被别的节点抢走
  return db.get<NodeTaskRow>(`SELECT * FROM node_tasks WHERE task_id = ?`, [next.task_id])!;
}

export function finishNodeTask(db: KernelDb, taskId: string, patch: { status: "succeeded" | "failed" | "cancelled"; run_id?: string | null; error?: string | null }): void {
  db.run(`UPDATE node_tasks SET status = ?, run_id = COALESCE(?, run_id), error = ?, ended_at = ?, updated_at = ? WHERE task_id = ?`, [
    patch.status,
    patch.run_id ?? null,
    patch.error ?? null,
    nowIso(),
    nowIso(),
    taskId,
  ]);
}

/** 租约到期判定：enabled 且（last_run_at 为空或距今 ≥ interval 秒）且租约过期。 */
export function claimScheduledJob(db: KernelDb, owner: string, leaseMs: number): ScheduledJobRow | null {
  const now = nowIso();
  const until = new Date(Date.now() + leaseMs).toISOString();
  // 结案或已删除事项的定时任务不再执行（复核 C-A05）
  const due = db.all<ScheduledJobRow>(
    `SELECT * FROM scheduled_jobs WHERE enabled = 1 AND (lease_until IS NULL OR lease_until < ?)
        AND (matter_id IS NULL OR matter_id IN (SELECT matter_id FROM matters WHERE lifecycle = 'active')) ORDER BY created_at`,
    [now],
  );
  for (const job of due) {
    const intervalSec = Number(job.cron_expr) || 86_400; // v0：cron_expr 即间隔秒（cron 解析 G1）
    if (job.last_run_at && Date.now() - Date.parse(job.last_run_at) < intervalSec * 1000) continue;
    const r = db.run(`UPDATE scheduled_jobs SET lease_owner = ?, lease_until = ? WHERE job_id = ? AND (lease_until IS NULL OR lease_until < ?)`, [owner, until, job.job_id, now]);
    if (r.changes === 1) return db.get<ScheduledJobRow>(`SELECT * FROM scheduled_jobs WHERE job_id = ?`, [job.job_id])!;
  }
  return null;
}

export function finishScheduledJob(db: KernelDb, jobId: string, result: Record<string, unknown>): void {
  db.run(`UPDATE scheduled_jobs SET last_run_at = ?, last_result = ?, lease_owner = NULL, lease_until = NULL WHERE job_id = ?`, [nowIso(), JSON.stringify(result), jobId]);
}

// ─── 三种定时任务处理器（只限授权事项；产物为草稿事件/成果，IM 通知投递属阶段 6） ───

/** 期限提醒：事项 key_dates 中 N 天内到期的日期 → 提醒审计事件（按 job+事项+日期去重，不重复生成）。 */
export function runDeadlineReminder(db: KernelDb, job: ScheduledJobRow, signer?: LedgerSigner): { created: number } {
  if (!job.matter_id) return { created: 0 };
  assertNodeTaskAllowed(db, job.matter_id); // 执行处硬门禁（授权撤销即不产出）
  const params = JSON.parse(job.params_json || "{}") as { days_before?: number };
  const daysBefore = params.days_before ?? 7;
  const m = db.get<any>(`SELECT matter_id, title, key_dates FROM matters WHERE matter_id = ?`, [job.matter_id]);
  if (!m) return { created: 0 };
  const keyDates = typeof m.key_dates === "string" ? JSON.parse(m.key_dates || "{}") : (m.key_dates ?? {});
  const now = Date.now();
  let created = 0;
  for (const [k, v] of Object.entries(keyDates)) {
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) continue;
    const days = Math.ceil((Date.parse(v) - now) / 86_400_000);
    if (days < 0 || days > daysBefore) continue;
    const marker = `${job.job_id}:${m.matter_id}:${k}:${v}`;
    const dup = db.get(`SELECT 1 AS x FROM audit_events WHERE action = 'job.deadline_reminder' AND detail_hash = ?`, [marker]);
    if (dup) continue;
    auditJob(db, signer, job, "job.deadline_reminder", "matter", m.matter_id, m.matter_id, marker);
    created += 1;
  }
  return { created };
}

/** 事项周报（v0 简文本草稿；S13 进度报告正式路径在 W12 规则包）：近 7 日事件摘要 → draft 成果。 */
export function runMatterWeeklyReport(db: KernelDb, blobs: BlobStore, job: ScheduledJobRow, signer?: LedgerSigner): { artifact_version_id: string | null } {
  if (!job.matter_id) return { artifact_version_id: null };
  assertNodeTaskAllowed(db, job.matter_id); // 执行处硬门禁
  const m = db.get<any>(`SELECT * FROM matters WHERE matter_id = ?`, [job.matter_id]);
  if (!m) return { artifact_version_id: null };
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const events = db.all<any>(`SELECT type, created_at FROM run_events WHERE run_id IN (SELECT run_id FROM runs WHERE matter_id = ?) AND created_at > ? ORDER BY created_at DESC LIMIT 100`, [
    job.matter_id,
    since,
  ]);
  const audits = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_events WHERE object_id = ? AND created_at > ?`, [job.matter_id, since])!;
  const runs = db.all<any>(`SELECT run_id, scenario, status, created_at FROM runs WHERE matter_id = ? AND created_at > ? ORDER BY created_at DESC`, [job.matter_id, since]);
  const lines = [
    `事项周报（v0 简文本草稿；正式 S13 进度报告路径在 W12）`,
    `事项：${m.title}（${m.matter_id}）`,
    `统计区间：${since.slice(0, 10)} 至今`,
    `本周任务 ${runs.length} 个（${runs.filter((r) => r.status === "succeeded").length} 成功）、事件 ${events.length} 条、审计 ${audits.n} 条。`,
    ...runs.slice(0, 10).map((r) => `- ${r.created_at.slice(0, 16)} ${r.scenario} → ${r.status}`),
  ];
  const text = lines.join("\n");
  const stored = blobs.put(Buffer.from(text, "utf8"), job.matter_id);
  const artifactId = `artv_${randomUUID()}`;
  const v = db.get<{ next: number }>(`SELECT COALESCE(MAX(version), 0) + 1 AS next FROM artifact_versions WHERE matter_id = ? AND kind = 'matter_weekly_report' AND audience = 'internal'`, [job.matter_id])!;
  db.run(
    `INSERT INTO artifact_versions (artifact_version_id, tenant_id, matter_id, run_id, kind, version, baseline_id, audience, status, filename, sha256, storage_uri, open_items, manifest, created_by)
     VALUES (?,?,?,NULL,'matter_weekly_report',?,NULL,'internal','draft',?,?,?,?,?,?)`,
    [
      artifactId,
      job.tenant_id,
      job.matter_id,
      v.next,
      `事项周报-${m.title.slice(0, 16)}-${new Date().toISOString().slice(0, 10)}.md`,
      stored.sha256,
      stored.storage_uri,
      "[]",
      JSON.stringify({ job_id: job.job_id, note: "定时任务产物（草稿）；通知投递（IM）属阶段 6" }),
      `job:${job.job_id}`,
    ],
  );
  auditJob(db, signer, job, "job.matter_weekly_report", "matter", job.matter_id, job.matter_id, artifactId);
  return { artifact_version_id: artifactId };
}

/** 法规库变更观察（占位实现：包版本变化 → 提示事件；法律之星变更提示属签约后工作，§2.1）。 */
export function runLawdbWatch(db: KernelDb, job: ScheduledJobRow, currentPackageVersion: string, signer?: LedgerSigner): { changed: boolean } {
  const last = job.last_result ? (JSON.parse(job.last_result) as { package_version?: string }).package_version : null;
  if (last === currentPackageVersion) return { changed: false };
  auditJob(db, signer, job, "job.lawdb_watch", "lawdb", currentPackageVersion, null, `lawdb 包版本 ${last ?? "（首次记录）"} → ${currentPackageVersion}；法规变更人工复核提示（法律之星变更追踪属签约后工作，第 5 篇 §2.1）`);
  return { changed: true };
}
