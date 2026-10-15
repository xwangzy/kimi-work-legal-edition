/**
 * W1 桌面的业务运行时接口（v9 第 04 篇 §3.3：界面只见这一层；第 03 篇 §8）：
 *   runs.interactions   待决的确认卡与提问卡（卡片内容由内核按待决审批与事项记录重算）
 *   runs.approve        律师的审批决定（批准人 = 调用来源的本机用户；跨边界动作签发设备签名的出站批准凭据）
 *   runs.answer         律师回答 Agent 的提问（自由文本先令牌化：Agent 与模型上下文只见代号）
 *   egress.summary      数据去向卡
 *   chat.list / chat.get / chat.send   无事项问答（历史只在本机）
 *   kernel.capabilities 设备页（执行域如实标注、唯一出口强度、能力账本）
 */
import { DomainError, sha256Hex } from "@zr-legal/domain";
import { screenSearchQuery } from "@zr-legal/egress-gate";
import { approvalPolicyOf } from "../egress/gate-host.ts";
import type { KernelDb } from "../db.ts";
import type { Identity } from "../identity.ts";
import type { MatterTokenStore } from "../egress/matter-tokens.ts";
import type { KapAgentClient, KapMatterPolicy } from "../executor/kap-agent-client.ts";
import type { EgressApprovalStore } from "../services/egress-approvals.ts";
import { buildApprovalCard, type PendingApproval } from "../services/interaction-cards.ts";
import { summarizeEgress } from "../services/egress-summary.ts";
import type { QaChatService } from "../services/qa-chat.ts";

type Handler = (params: any, id: Identity) => unknown;

export interface W1Deps {
  db: KernelDb;
  tokens: MatterTokenStore | null;
  approvals: EgressApprovalStore | null;
  qa: QaChatService | null;
  /** kap 引擎（开放任务）；SDK 宿主形态下为 null（没有确认卡通道，如实返回空）。 */
  kap: KapAgentClient | null;
  matterPolicy(matterId: string): KapMatterPolicy;
  requireRunAccess(runId: string, id: Identity): { run_id: string; matter_id: string; created_by: string; status: string };
  requireMatterWriter(matterId: string, id: Identity): void;
  audit(id: Identity, action: string, kind: string, objectId: string, detailHash: string): void;
  deviceFacts(): Promise<Record<string, unknown> | null>;
  gateFacts(): { running: boolean; routes: { search: boolean; fetch: boolean }; search_configured: boolean; fetch: string } | null;
}

const invalid = (msg: string) => new DomainError("validation", msg, 422);

/**
 * 内核已判终态（或转人工对账）的任务：确认卡与提问不再呈现、不再受理（复核 B4-B07 取消竞态补强）——律师取消后到宿主收尾之间
 * （执行器轮询发现并取消宿主，约 1 秒）宿主内存里的卡片仍在，此时批准会让已取消任务的工具照常执行。
 */
const SETTLED_RUN_STATUSES: ReadonlySet<string> = new Set(["succeeded", "partial", "failed", "cancelled", "expired", "timed_out", "reconciling"]);

export function createW1Api(d: W1Deps): Record<string, Handler> {
  const cardsFor = (runId: string, matterId: string) => {
    const pending = d.kap?.interactions(runId);
    if (!pending) return { approvals: [], questions: [], built: new Map<string, ReturnType<typeof buildApprovalCard>>() };
    const pol = d.matterPolicy(matterId);
    const tz = d.tokens?.tokenizer(matterId) ?? null;
    const endpoint = d.db.get<{ model_endpoint: string }>(`SELECT model_endpoint FROM matters WHERE matter_id = ?`, [matterId])?.model_endpoint;
    const ctx = {
      dataLevel: pol.dataLevel,
      ...(endpoint ? { modelEndpoint: endpoint } : {}),
      budget: pol.budget,
      screenSearch: (query: string, variant?: "original" | "generalized") => {
        if (!tz) return { decision: "deny" as const, reason: "tokenizer_unavailable" };
        const v = screenSearchQuery(query, { dataLevel: pol.dataLevel, basisComplete: pol.basisComplete, preauthorizedGeneralize: false, tokenizer: tz, ...(variant ? { confirmed: variant } : {}) });
        return v.decision === "deny" ? { decision: "deny" as const, reason: v.reason } : { decision: v.decision === "pass" ? ("pass" as const) : ("generalized" as const), sent: v.sent };
      },
    };
    const built = new Map(pending.approvals.map((p) => [p.approval_id, buildApprovalCard(p as unknown as PendingApproval, ctx)] as const));
    return { approvals: [...built.values()].map((b) => b.card), questions: pending.questions, built };
  };

  return {
    "runs.interactions": async (p, id) => {
      const run = d.requireRunAccess(String(p?.run_id ?? ""), id);
      if (SETTLED_RUN_STATUSES.has(run.status)) return { approvals: [], questions: [], state_version: null, live_text: null, progress: null };
      const { approvals, questions } = cardsFor(run.run_id, run.matter_id);
      // 状态版本：界面作答时带回（第 04 篇 §3.3 answers 的 expected_state_version；版本已变 = 期间有新的提问或决定，须按最新卡片作答）
      const state_version = questions.length > 0 && d.kap ? await d.kap.stateVersion(run.run_id).catch(() => null) : null;
      // 正在生成的回复（流式，令牌形态；界面还原显示）：随轮询一起取，运行结束后为 null
      return { approvals, questions, state_version, live_text: d.kap?.liveText(run.run_id) ?? null, progress: d.kap?.liveProgress(run.run_id) ?? null };
    },

    "runs.approve": async (p, id) => {
      const run = d.requireRunAccess(String(p?.run_id ?? ""), id);
      d.requireMatterWriter(run.matter_id, id);
      // 第 02 篇 §9.6：桌面渠道能确认“本人事项内全部”——运行须是本人发起的
      if (run.created_by !== id.userId) throw new DomainError("forbidden", "只能确认本人发起的任务", 403);
      if (SETTLED_RUN_STATUSES.has(run.status)) throw new DomainError("conflict", "任务已结束，这张确认卡已失效", 409);
      if (!d.kap) throw new DomainError("not_found", "当前引擎没有确认卡通道", 404);
      const approvalId = String(p?.approval_id ?? "");
      const decision = p?.decision === "approve" ? "approve" : p?.decision === "reject" ? "reject" : null;
      if (!decision) throw invalid("decision 须为 approve 或 reject");
      const scope: "once" | "task" = p?.scope === "task" ? "task" : "once";
      const { built } = cardsFor(run.run_id, run.matter_id);
      const b = built.get(approvalId);
      if (!b) throw new DomainError("not_found", "确认卡不存在或已处理", 404);
      // 绑定对象：界面看到的对象摘要与 nonce 必须与待决审批一致（对象、参数变化须重新确认）
      if (String(p?.object_hash ?? "") !== b.card.object_hash || String(p?.nonce ?? "") !== b.card.nonce) throw new DomainError("conflict", "确认卡已变化：请按最新的卡片重新确认", 409);
      if (Date.parse(b.card.expires_at) <= Date.now()) throw new DomainError("conflict", "确认卡已过期", 409);
      if (decision === "approve" && scope === "task" && !b.card.scope_options.includes("task")) throw invalid("这一类确认只能逐次允许");
      let approvalRecord: string | null = null;
      if (decision === "approve" && b.credential && d.approvals) {
        const variants = b.credential.variants;
        // 变体缺省为改写后（复核 S5-B06：不默认原文放行）
        const requested = p?.variant === "generalized" || p?.variant === "original" ? (p.variant as "original" | "generalized") : null;
        const variant = variants.length === 0 ? null : (requested ?? (variants.includes("generalized") ? "generalized" : variants[0]!));
        if (variant && !variants.includes(variant)) throw invalid("该变体不可用");
        if (scope === "task" && !b.credential.taskAllowed) throw invalid("这一类确认只能逐次允许");
        // 检索的“本任务内允许”只能是改写后放行（第 02 篇 §8.3；复核 S5-A02/B01）；原文放行只能逐条
        if (b.credential.purpose === "search" && scope === "task" && variant !== "generalized") throw invalid("检索的“本任务内允许”只能按改写后的一般性查询放行；原文放行只能逐条确认");
        const mrow = d.db.get<{ confidentiality: string; consent_status: string; basis: string | null; model_endpoint: string; full_pseudonym: number; collab_scope: string }>(
          `SELECT confidentiality, consent_status, basis, model_endpoint, full_pseudonym, collab_scope FROM matters WHERE matter_id = ?`,
          [run.matter_id],
        );
        const policy = mrow ? approvalPolicyOf(mrow) : "";
        const signed = d.approvals.issue({
          approvalId,
          tenantId: id.tenantId,
          matterId: run.matter_id,
          runId: run.run_id,
          userId: id.userId,
          channel: "desktop",
          purpose: b.credential.purpose,
          reason: b.card.reason,
          digest: b.credential.purpose === "media" ? null : scope === "once" ? b.credential.onceDigest : null,
          dest: b.credential.dest,
          variant,
          scope: b.credential.purpose === "media" ? "once" : scope,
          policy,
        });
        approvalRecord = signed.credential.approval_id;
      }
      // 退回意见进入 Agent 上下文：先令牌化（工作区与模型只见代号）
      const feedback = typeof p?.feedback === "string" && p.feedback.trim() ? (d.tokens ? d.tokens.tokenize(run.matter_id, p.feedback.trim().slice(0, 2000)).text : p.feedback.trim().slice(0, 2000)) : undefined;
      try {
        await d.kap.decide(run.run_id, approvalId, { decision, object_hash: b.card.object_hash, nonce: b.card.nonce, scope, ...(feedback ? { feedback } : {}) }, { channel: "desktop", userId: id.userId });
      } catch (e) {
        // 宿主拒收（卡片在宿主侧已过期、宿主退出等）：已签发的凭据立即作废，不留可用的批准（复核 S5-B06）
        if (approvalRecord) d.approvals?.revoke(approvalRecord);
        throw e;
      }
      // 审计：动作、卡片类别、范围与是否签发凭据（不含查询原文或网址）
      d.audit(id, decision === "approve" ? "run.approval_granted" : "run.approval_rejected", "run", run.run_id, sha256Hex(JSON.stringify({ approval_id: approvalId, kind: b.card.kind, scope, credential: approvalRecord !== null })));
      return { ok: true, credential_issued: approvalRecord !== null };
    },

    "runs.answer": async (p, id) => {
      const run = d.requireRunAccess(String(p?.run_id ?? ""), id);
      d.requireMatterWriter(run.matter_id, id);
      if (run.created_by !== id.userId) throw new DomainError("forbidden", "只能回答本人发起的任务", 403);
      if (SETTLED_RUN_STATUSES.has(run.status)) throw new DomainError("conflict", "任务已结束：这个问题已失效或已处理，不再受理", 409);
      if (!d.kap) throw new DomainError("not_found", "当前引擎没有提问通道", 404);
      const raw = (p?.answers ?? {}) as Record<string, any>;
      const answers: Record<string, unknown> = {};
      for (const [k, a] of Object.entries(raw)) {
        if (!a || typeof a !== "object") continue;
        if (a.kind === "single" && typeof a.option_id === "string") answers[k] = { kind: "single", option_id: a.option_id };
        else if (a.kind === "multi" && Array.isArray(a.option_ids)) answers[k] = { kind: "multi", option_ids: a.option_ids.filter((x: unknown) => typeof x === "string") };
        else if (a.kind === "other" && typeof a.text === "string") {
          // 律师输入的自由文本：令牌化后才进入 Agent 上下文
          const text = a.text.slice(0, 4000);
          answers[k] = { kind: "other", text: d.tokens ? d.tokens.tokenize(run.matter_id, text).text : text };
        } else answers[k] = { kind: "skipped" };
      }
      const expected = typeof p?.expected_state_version === "number" ? p.expected_state_version : undefined;
      await d.kap.answer(run.run_id, String(p?.question_id ?? ""), answers, { channel: "desktop", userId: id.userId }, expected);
      d.audit(id, "run.question_answered", "run", run.run_id, sha256Hex(JSON.stringify({ question_id: String(p?.question_id ?? ""), n: Object.keys(answers).length })));
      return { ok: true };
    },

    "egress.summary": (p, id) => {
      const run = d.requireRunAccess(String(p?.run_id ?? ""), id);
      return summarizeEgress(d.db, run.run_id);
    },

    "chat.list": (_p, id) => {
      if (!d.qa) return { conversations: [] };
      return { conversations: d.qa.list(id.tenantId, id.userId) };
    },
    "chat.get": (p, id) => {
      if (!d.qa) throw new DomainError("not_found", "问答未启用", 404);
      try {
        return { conversation_id: String(p?.conversation_id ?? ""), messages: d.qa.get(String(p?.conversation_id ?? ""), id.tenantId, id.userId) };
      } catch (e) {
        throw new DomainError("not_found", (e as Error).message, 404);
      }
    },
    "chat.send": async (p, id) => {
      if (!d.qa) throw new DomainError("not_found", "问答未启用", 404);
      try {
        return await d.qa.send({ ...(typeof p?.conversation_id === "string" && p.conversation_id ? { conversationId: p.conversation_id } : {}), text: String(p?.text ?? "") }, id.tenantId, id.userId);
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === "validation") throw invalid((e as Error).message);
        if (code === "not_found") throw new DomainError("not_found", (e as Error).message, 404);
        throw e;
      }
    },

    "kernel.capabilities": async () => {
      const facts = await d.deviceFacts().catch(() => null);
      const gate = d.gateFacts();
      const ledger = Array.isArray((facts as { ledger?: unknown } | null)?.ledger)
        ? (facts as { ledger: { family?: string; entity?: string; current?: string; stage?: string; note?: string; evidence?: string }[] }).ledger
        : [];
      const STATUS: Record<string, string> = { native: "原生接通", adapted: "适配替代", policy_limited: "受策略约束", pending: "待实现", not_entitled: "不在已购权益", disabled: "本设备关闭" };
      const rows = ledger.map((r) => ({
        capability: `${r.family ?? ""}${r.entity ? `（${r.entity}）` : ""}`,
        status: `${STATUS[String(r.current)] ?? String(r.current ?? "")}${r.stage && r.stage !== "—" ? ` · ${r.stage}` : ""}`,
        note: String(r.note ?? r.evidence ?? ""),
      }));
      const exec = ledger.find((r) => r.family === "Shell 与代码执行");
      // 执行域标注由能力账本推出（复核 S5-A10）：W 可用 → 运行时隔离；本设备关闭 → 未隔离、不运行代码；宿主未启动 → 未知
      const available = exec ? exec.current !== "disabled" : null;
      return {
        execution_domain: {
          available,
          label: available === false ? "未隔离：不运行代码（只运行可信工具）" : "运行时隔离（W）",
          status:
            available === null
              ? "未知（Agent 宿主尚未启动；首次运行任务时自检）"
              : available
                ? "可用：设备自检通过（P2 本机通过；正式验收待 Windows 真机与杀软矩阵）"
                : `本设备关闭：${String(exec?.note ?? "").split(/[。；]/)[0]}`,
          detail: available === false ? "执行域不可用时不在执行域之外运行模型生成的代码" : "无网络、只见本事项、原件只读、工作区可回滚；非操作系统沙箱",
        },
        sole_exit: "应用层约束",
        gate: gate ?? { running: false, routes: { search: false, fetch: false }, search_configured: false, fetch: "disabled" },
        rows,
      };
    },
  };
}
