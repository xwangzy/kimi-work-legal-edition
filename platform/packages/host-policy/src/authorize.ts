/**
 * 单次工具调用裁决（v9 第 02 篇 §9.2 强制点①、§9.3 运行模式、§9.4 工具分级；F3 修复）。
 *
 * 裁决永远是 approve / ask / deny 之一（宿主策略“永不弃权”，第 04 篇 ZP-4）；任何不认识、对不上、
 * 越过事项或用途的调用一律 deny。阶段 1 只承接清单式授权，运行模式与跨边界动作的完整语义在阶段 2 扩展。
 */
import type { ManifestRegistry, ToolManifest } from "./manifest.ts";
import { argsHash } from "./manifest.ts";

export type Decision = "approve" | "ask" | "deny";

/** 运行模式（第 02 篇 §9.3：对齐 Kimi Work）：Chat 问答 / Work·手动 / Work·默认 / Work·自动；没有“完全访问”。 */
export type RunMode = "chat" | "manual" | "default" | "auto";

export interface ToolCallContext {
  /** 引擎看到的工具名。 */
  toolId: string;
  /** 任务绑定的事项（令牌 claims.mid）；无事项任务为 null。 */
  boundMatterId: string | null;
  /** 本次调用实际指向的事项（能从参数确定时提供）；与绑定事项不同即越界。 */
  requestedMatterId?: string | null;
  /** 任务用途（任务意图，例如 legal_analysis）。 */
  purpose: string;
  mode: RunMode;
  /** “自动”档在任务开始时预授权的工具 ID（第 02 篇 §9.3）。 */
  preauthorized?: ReadonlySet<string>;
  /** 执行域是否可用（第 02 篇 §9.10：W 不可用时代码执行关闭；缺省视为不可用——失败即拒绝，审查 R-10）。 */
  execDomainAvailable?: boolean;
}

export interface ToolDecision {
  decision: Decision;
  /** 机器可读原因，进入审计与界面。 */
  reason: string;
  manifest: ToolManifest | null;
  /** 参数摘要（批准绑定用，不含明文）。 */
  argsHash: string;
}

const MATTER_BOUND_RESOURCES = new Set(["matter_materials", "matter_documents", "matter_work"]);

export function authorizeToolCall(registry: ManifestRegistry, ctx: ToolCallContext, args?: unknown): ToolDecision {
  const hash = argsHash(args ?? {});
  const deny = (reason: string, manifest: ToolManifest | null = null): ToolDecision => ({ decision: "deny", reason, manifest, argsHash: hash });
  const manifest = registry.get(ctx.toolId);
  if (!manifest) return deny("unknown_tool");

  if (manifest.sideEffect === "external" || manifest.sideEffect === "irreversible") {
    // X1–X4（对外发送与提交、签发、删改原件、改权限与策略）永远不是工具：清单里出现即配置错误，拒绝
    return deny("not_a_tool", manifest);
  }
  if (MATTER_BOUND_RESOURCES.has(manifest.resource) && !ctx.boundMatterId) return deny("unbound_matter", manifest);
  if (ctx.requestedMatterId != null && ctx.boundMatterId != null && ctx.requestedMatterId !== ctx.boundMatterId) {
    return deny("cross_matter", manifest);
  }
  if (!manifest.purposes.includes(ctx.purpose)) return deny("purpose_not_allowed", manifest);

  const approve = (reason: string): ToolDecision => ({ decision: "approve", reason, manifest, argsHash: hash });
  const ask = (reason: string): ToolDecision => ({ decision: "ask", reason, manifest, argsHash: hash });

  switch (manifest.sideEffect) {
    case "read":
      return ctx.mode === "manual" ? ask("manual_mode") : approve("read_within_matter");
    case "write_draft":
      if (ctx.mode === "chat") return deny("chat_read_only", manifest);
      return ctx.mode === "manual" ? ask("manual_mode") : approve("draft_within_workspace");
    case "exec":
      if (ctx.mode === "chat") return deny("chat_read_only", manifest);
      if (ctx.execDomainAvailable !== true) return deny("execution_domain_unavailable", manifest);
      return ctx.mode === "manual" ? ask("manual_mode") : approve("exec_within_domain");
    case "network":
      // 跨边界动作（第 02 篇 §9.5）：默认档逐项确认；自动档只在任务开始时预授权的范围内自动
      if (ctx.mode === "auto" && ctx.preauthorized?.has(manifest.id)) return approve("preauthorized_network");
      return ask("cross_boundary_network");
    default:
      return deny("unknown_side_effect", manifest);
  }
}
