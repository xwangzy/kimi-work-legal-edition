/**
 * 身份与工作区（v0 开发形态）：律所工作区 + 当前成员，slug 即确定性 ID（稳定、可读）。
 * 生产（§5.4）：团队版/律所版身份来自律所 IM 组织扫码认证，本机生成设备密钥对，
 * 管理员签发设备证书——接口语义保持：每次调用解析出 tenant（律所工作区）+ user（成员设备）。
 * 本机缓存不构成有效授权：授权判定全部在内核。
 */
import { randomBytes } from "node:crypto";
import { newId } from "@zr-legal/domain";
import { issueToken } from "@zr-legal/service-auth";
import type { KernelDb } from "./db.ts";

export interface Identity {
  tenantId: string;
  userId: string;
}

export function resolveIdentity(db: KernelDb, firmSlug: string, userSlug: string): Identity {
  const tenantId = `ten_${firmSlug}`;
  const userId = `usr_${firmSlug}_${userSlug}`;
  db.run(`INSERT OR IGNORE INTO tenants (tenant_id, name) VALUES (?, ?)`, [tenantId, firmSlug]);
  db.run(`INSERT OR IGNORE INTO users (user_id, tenant_id, display_name) VALUES (?, ?, ?)`, [userId, tenantId, userSlug]);
  db.run(
    `INSERT OR IGNORE INTO memberships (membership_id, tenant_id, user_id, role) VALUES (?, ?, ?, 'lawyer')`,
    [newId("membership"), tenantId, userId],
  );
  return { tenantId, userId };
}

/**
 * 任务令牌密钥（复审 N-03）：内核进程启动时在内存中随机生成——不来自环境变量、不落盘、不下发给任何子进程。
 * 同用户进程可以读到内核的环境变量（macOS KERN_PROCARGS2 / Linux /proc/<pid>/environ），所以签发与验证任务令牌
 * 都不再使用 ZR_INTERNAL_SECRET。任务令牌只由本进程的本机端点验证；内核重启后旧令牌全部失效
 * （与“恢复即新尝试、新纪元”一致）。
 */
const TASK_TOKEN_KEY = randomBytes(32).toString("base64url");

/** 本机端点验证任务令牌用的密钥（只在本进程内存中）。 */
export function taskTokenKey(): string {
  return TASK_TOKEN_KEY;
}

/**
 * 为 Agent 宿主等签发短期任务令牌（绑定工作区/成员/事项/任务/尝试与纪元；只在本机有效）。
 * v9 第 04 篇 §8：模型与工具令牌必须带 aid + fen（尝试与纪元），端点每次调用都按当前尝试行复核——
 * 尝试结束（任何终态）、被新尝试取代、或按 jti 撤销后立即失效（阶段 1 审查 R-01/R-06）。
 */
export function mintTaskToken(
  claims: { tid: string; uid: string; mid?: string; rid?: string; aid?: string; fen?: number; jti?: string; fx?: string[]; pur?: string; scope: string[] },
  ttl = 900,
): string {
  return issueToken(claims, TASK_TOKEN_KEY, ttl);
}

/** 尝试仍在执行的任务状态（终态与 reconciling、recovering 之外）。 */
export const LIVE_RUN_STATUSES = ["running", "waiting_input", "waiting_approval", "waiting_device", "budget_paused"] as const;

/**
 * 任务记录派生的能力（复审 N-03：服务端不采信令牌里的用途与副作用类别，按任务记录派生）。
 * A1 开放任务的意图是法律分析，只开放读类工具；其余场景走确定性工作流，不经本机端点调用工具。
 */
export function runCapabilities(scenario: string, mode?: string | null): { purpose: string; fx: readonly string[] } {
  // 问答档（chat）只读（复核 B3-B01）：不论场景，派生能力只留 read——端点据此独立拒绝写类工具，不只靠宿主
  if (mode === "chat") return { purpose: runCapabilities(scenario).purpose, fx: ["read"] };
  switch (scenario) {
    case "a1.agent_task":
      // 读 + 写本事项草稿（风险卡、事实行、文书与表格成果；2026-10-13 审计 D2）——不含执行、网络、对外
      return { purpose: "legal_analysis", fx: ["read", "write_draft"] };
    case "a1.drafting":
      // 起草类任务意图（阶段 2 起由 kap-host 承载；runs.create 尚未开放该场景）：读 + 写草稿（不含执行、网络、对外）
      return { purpose: "drafting", fx: ["read", "write_draft"] };
    default:
      return { purpose: "legal_analysis", fx: ["read"] };
  }
}

/** 任务记录里律师选择的运行档位（runs.start 写入 input_snapshot.run_options.mode；缺省为默认档）。 */
export function runModeOf(inputSnapshot: string | null | undefined): "chat" | "manual" | "default" | "auto" {
  try {
    const m = (JSON.parse(inputSnapshot ?? "{}") as { run_options?: { mode?: unknown } })?.run_options?.mode;
    return m === "chat" || m === "manual" || m === "auto" ? m : "default";
  } catch {
    // 解析失败按最严档位处理
    return "chat";
  }
}

export interface LiveRun {
  runId: string;
  attemptId: string;
  matterId: string;
  tenantId: string;
  scenario: string;
  /** 派生能力与令牌声明的交集（令牌只能更窄，不能更宽）。 */
  fx: readonly string[];
  purpose: string;
  /** 任务记录里的运行档位（端点据此独立裁决，不采信宿主）。 */
  mode: "chat" | "manual" | "default" | "auto";
}

/**
 * 令牌活性检查（独立强制，不依赖宿主配合）：jti 未撤销、任务未被取消、尝试仍在执行且纪元一致、任务处于活动状态，
 * 且令牌中的租户、事项与任务记录一致（复审 N-03）。返回 null 表示有效；否则返回拒绝原因。
 */
export function tokenLiveness(
  db: KernelDb,
  claims: { tid?: string | undefined; mid?: string | undefined; rid?: string | undefined; aid?: string | undefined; fen?: number | undefined; jti?: string | undefined },
  revoked: { rids: ReadonlySet<string>; jtis: ReadonlySet<string> },
): string | null {
  const r = liveRunForClaims(db, claims, revoked);
  return typeof r === "string" ? r : null;
}

/** 同 tokenLiveness，但有效时返回任务记录派生的上下文（端点据此裁决，不采信令牌里的 mid/pur/fx）。 */
export function liveRunForClaims(
  db: KernelDb,
  claims: {
    tid?: string | undefined;
    mid?: string | undefined;
    rid?: string | undefined;
    aid?: string | undefined;
    fen?: number | undefined;
    jti?: string | undefined;
    fx?: string[] | undefined;
    pur?: string | undefined;
  },
  revoked: { rids: ReadonlySet<string>; jtis: ReadonlySet<string> },
): LiveRun | string {
  if (claims.jti && revoked.jtis.has(claims.jti)) return "token_revoked";
  if (!claims.rid || !claims.aid || typeof claims.fen !== "number") return "token_not_attempt_bound";
  if (revoked.rids.has(claims.rid)) return "run_cancelled";
  const row = db.get<{ status: string; fence_token: number; run_status: string; matter_id: string; tenant_id: string; scenario: string; input_snapshot: string | null }>(
    `SELECT a.status, a.fence_token, r.status AS run_status, r.matter_id, r.tenant_id, r.scenario, r.input_snapshot
       FROM attempts a JOIN runs r ON r.run_id = a.run_id WHERE a.attempt_id = ? AND a.run_id = ?`,
    [claims.aid, claims.rid],
  );
  if (!row) return "attempt_unknown";
  if (row.status !== "running") return "attempt_not_running";
  if (row.fence_token !== claims.fen) return "fence_mismatch";
  if (!(LIVE_RUN_STATUSES as readonly string[]).includes(row.run_status)) return "run_not_live";
  if (claims.mid !== undefined && claims.mid !== row.matter_id) return "claims_mismatch";
  if (claims.tid !== undefined && claims.tid !== row.tenant_id) return "claims_mismatch";
  const mode = runModeOf(row.input_snapshot);
  const caps = runCapabilities(row.scenario, mode);
  const granted = claims.fx ?? ["read"];
  return {
    runId: claims.rid,
    attemptId: claims.aid,
    matterId: row.matter_id,
    tenantId: row.tenant_id,
    scenario: row.scenario,
    fx: caps.fx.filter((x) => granted.includes(x)),
    purpose: caps.purpose,
    mode,
  };
}
