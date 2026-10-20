/**
 * 业务运行时 API（v9 第 04 篇 §3.3：界面、App、IM 只见这一层；kap-server 只由宿主经 KapClient 访问）。
 *
 *   POST /runtime/runs                 startRun   {matter_id, goal, mode, plan_first, preauthorized}   + 网关注入的来源
 *   GET  /runtime/runs/{id}/events     events     断线续读（after=seq）
 *   POST /runtime/runs/{id}/answers    answer     {question_id, answers, expected_state_version}         + 网关注入的来源
 *   POST /runtime/approvals/{id}       approve    {decision, object_hash, nonce, scope: once|task}       + 网关注入的批准人
 *   POST /runtime/runs/{id}/cancel     cancel     {reason, expected_state_version}                       + 网关注入的来源
 *   GET  /runtime/runs/{id}/artifacts  artifacts  文件历史（映射 ArtifactVersion 由内核负责）
 *   POST /runtime/runs/{id}/rollback   rollback   （G1：引擎 undo 映射为业务版本回滚——未开放）
 *   GET  /runtime/capabilities         capabilities 本设备执行域与已开放能力（能力账本视图）
 *
 * 信任边界（审查 S2-04/S2-05）：
 * - 运行的策略输入（数据级别、四项依据、抓取白名单、可预授权范围、预算上限、律所模式上限、用途）由内核按事项与策略版本提供
 *   （`matterPolicy`），**不取自请求体**；缺失时按最严处理（L3b、依据未齐、无白名单、无预授权、手动档）；
 * - 渠道与批准人由业务网关依据传输层身份注入（`RequestOrigin`），不取自请求体；
 * - 实际模式 = min(界面请求, 律所上限, 渠道上限)；引擎侧权限模式固定 manual（engine-config.ts）。
 *
 * 运行生命周期（审查 S2-01）：主 Agent 回合结束后，只有当会话空闲、没有运行中的后台任务、没有活动的目标时才判终态；
 * 终态之后若引擎再起回合（后台通知等），宿主立即中止它（会话已解绑，不允许再出站）。
 * 运行记录在宿主内存中；持久化与“重启后不丢问题”由内核侧任务记录承担（引擎内审批与提问队列是进程级内存）。
 */
import type { MatterKeyRing } from "@zr-legal/at-rest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgentOutcome } from "@zr-legal/domain";
import { FileBroker } from "@zr-legal/file-broker";
import { argsHash, type ManifestRegistry, type RunMode } from "@zr-legal/host-policy";
import type { EventEnvelope } from "../vendor/kap-embed/kap-embed.mjs";
import { capabilityLedger, type CapabilityRow, type DeviceFacts } from "./capabilities.ts";
import { MAIN_MODEL } from "./engine-config.ts";
import { UNAVAILABLE_DOMAIN, type ExecDomainFactory, type ExecutionDomain } from "./exec-router.ts";
import type { EgressAuthority, ModelBinding } from "./host-egress.ts";
import { KapError, type KapAnswer } from "./kap-client.ts";
import { MatterEngine } from "./matter-engine.ts";
import { HostPolicy, ONCE_ONLY_REASONS, effectiveMode, type Channel, type DataLevel, type PolicyDecisionRecord, type Preauthorization } from "./policy.ts";
import { ProgressTracker, type RunProgress } from "./progress.ts";

export class RuntimeError extends Error {
  readonly code: "validation" | "not_found" | "conflict" | "forbidden" | "unavailable";
  constructor(code: RuntimeError["code"], message: string) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
  }
}

export interface MatterLayout {
  homeDir: string;
  materialsDir: string;
  workDir: string;
  trustedDir?: string | undefined;
  legalMcpTools?: readonly string[];
  /** 落盘加密的事项密钥环（审计 S3 第 1 步；开发形态可缺省）。 */
  keyring?: MatterKeyRing | undefined;
}

/** 内核按事项记录与律所策略版本给出的运行策略输入（不来自请求方）。 */
export interface MatterPolicy {
  dataLevel: DataLevel;
  basisComplete: boolean;
  fetchAllowlist: readonly string[];
  /** 律所策略允许律师在“自动”档开始时预授权的范围。 */
  allowedPreauthorizations: readonly Preauthorization[];
  budget: { maxToolCalls: number; maxSubagents: number };
  maxMode: RunMode;
  /** 运行用途（由方法包/任务意图决定）。 */
  purpose: string;
}

/** 缺少事项策略时的最严默认（失败关闭）。 */
export const STRICTEST_MATTER_POLICY: MatterPolicy = Object.freeze({
  dataLevel: "L3b",
  basisComplete: false,
  fetchAllowlist: [],
  allowedPreauthorizations: [],
  budget: { maxToolCalls: 50, maxSubagents: 0 },
  maxMode: "manual",
  purpose: "legal_analysis",
});

/** 业务网关依据传输层身份注入的请求来源（不取自请求体）。 */
export interface RequestOrigin {
  channel: Channel;
  userId: string;
  deviceId?: string | undefined;
  /** 远程渠道批准时的设备签名（对审批载荷签名）。 */
  deviceSignature?: string | undefined;
}

export interface RuntimeDeps {
  /** 落盘加密（审计 S3）：宿主是否按事项下发的密钥加密引擎会话与事件日志（能力账本如实显示）。 */
  atRestActive?: () => boolean;
  /** 事项目录（内核给定；宿主不自行决定路径）。 */
  matterLayout(matterId: string): MatterLayout;
  /** 事项的运行策略输入（内核按事项与策略版本给出）；null = 最严默认。 */
  matterPolicy?(matterId: string): MatterPolicy | null;
  /** 为运行签发模型令牌（绑定任务、尝试与纪元；闸门/内核逐次复核）。 */
  modelToken(run: { runId: string; matterId: string; sessionId: string }): string;
  /** 事项工具令牌；null = 本事项不提供法律 MCP。 */
  toolsToken(matterId: string): string | null;
  /** 远程渠道批准的设备签名验证（G2 设备中继接入）；未提供 = 远程渠道一律不能批准。 */
  verifyDeviceApproval?(
    approver: RequestOrigin,
    payload: { approvalId: string; objectHash: string; nonce: string; decision: "approve" | "reject"; scope: "once" | "task" },
  ): boolean;
  manifests: ManifestRegistry;
  trustedRgPath: string | null;
  /** 固定执行域（测试用）；与 execDomainFactory 二选一。 */
  execDomain?: ExecutionDomain | undefined;
  /** 设备执行域自检失败后的重试基数（毫秒，指数退避至 10 分钟；缺省 30 秒）。 */
  deviceSelftestRetryMs?: number;
  /** 按事项创建执行域（W-core 默认）。 */
  execDomainFactory?: ExecDomainFactory | undefined;
  egressLevel?: DeviceFacts["egress"];
  searchConfigured?: boolean;
  /** 只供测试（上下文压缩验收）：缩小引擎上下文窗口（宿主入口在安装包形态不传）。 */
  testMaxContextSize?: number;
  fetchConfigured?: boolean;
  /** 运行事件出口（内核落库、界面推送）；宿主内另保留内存副本供断线续读。 */
  onRunEvent?: (runId: string, e: RuntimeEvent) => void;
  /**
   * 正在生成的回复（流式，Kimi Code 集成核查 P1-3 / UIUX P0-3）：主 Agent 当前一步的文字尾部（≤ 4,000 字，令牌形态），
   * 至多每 300 ms 一次。只给可信界面实时显示，不进运行事件与事项账本（最终答复另以终态事件交付）。
   */
  onRunText?: (runId: string, text: string) => void;
  /**
   * 过程快照（Kimi Code 增量核查 K7-P）：至多每 300 ms 一次，交内核内存（与流式文字同一口径，不落账本）；里程碑另作运行事件。
   */
  onRunProgress?: (runId: string, progress: RunProgress) => void;
  /** 单次运行的工作时限（含主回合结束后等待会话空闲；**不含**等待律师确认或回答的时间——W1）；内核在 startRun 中下发时以下发值为准，否则缺省 30 分钟。 */
  maxRunMs?: number;
  /** 单次运行的总时长上限（含等待律师）；缺省 8 小时 5 分钟（内核在 8 小时判“过期”，宿主为兜底）。 */
  maxWallMs?: number;
  /** 审批卡有效期；缺省 30 分钟。 */
  approvalTtlMs?: number;
  /** 检索式预筛（内核按事项令牌化器与当事人词典计算；W1）。 */
  screenSearch?: (run: { runId: string; matterId: string }, query: string) => Promise<{ needsConfirmation: boolean }>;
  logLevel?: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
}

export interface StartRunRequest {
  run_id?: string;
  matter_id: string;
  goal: string;
  /** 界面请求的运行模式（实际模式取 min(请求, 律所上限, 渠道上限)）。 */
  mode: RunMode;
  /** “先出计划”（第 02 篇 §9.3：新用户与开放任务默认开启）；缺省为开启：会话以计划模式开始，计划经业务审批卡确认。 */
  plan_first?: boolean;
  /** 律师在“自动”档开始时选择的预授权范围（与律所允许范围取交集）。 */
  preauthorized?: Preauthorization[];
  /** 本次运行的工作时限（毫秒，不含等待律师；由内核按任务给出，不超过宿主上限 maxRunMs）。 */
  time_limit_ms?: number;
  /** 本次运行的总时长上限（毫秒，含等待律师；由内核按任务给出——宿主另加 5 分钟宽限，让内核先判“过期”）。 */
  wall_limit_ms?: number;
  /**
   * 追问（Kimi Code 集成核查 P1-1）：在本事项引擎里已有的会话上继续（上下文连续），不新建会话。
   * 会话须属于本事项的引擎、当前没有进行中的运行；缺省不进入计划模式。会话编号由内核按上一次运行的记录给出。
   */
  continue_session_id?: string;
}

export type RuntimeRunStatus = "running" | "waiting_approval" | "waiting_input" | "succeeded" | "partial" | "failed" | "cancelled";
const TERMINAL: ReadonlySet<RuntimeRunStatus> = new Set(["succeeded", "partial", "failed", "cancelled"]);

export interface RuntimeEvent {
  seq: number;
  at: string;
  type: string;
  payload: Record<string, unknown>;
}

interface PendingApproval {
  approvalId: string;
  runId: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  toolInput: unknown;
  objectHash: string;
  nonce: string;
  expiresAt: number;
  reason: string | null;
  crossBoundary: string | null;
  /** 宿主策略给出的工具分级（渠道确认范围按分级判定：手机只能确认 T4/T5 类）。 */
  grade: string | null;
  taskAllowable: boolean;
  /** 发起调用的 Agent（裁决按（会话, Agent, 调用）存取）。 */
  agentId: string;
  /** 该调用的宿主策略裁决（律师批准后据此放行闸门请求）。 */
  decision: PolicyDecisionRecord | null;
}

/** kap-server 任务列表的线上形态（只取这里用到的字段）。 */
interface WireTask {
  status?: string;
  run_in_background?: boolean;
  completed_at?: string;
}

/**
 * 后台命令的完成通知还没开回合（复核 B13-C03 的竞态；v9.3 合并后全量在负载下复现）：引擎先把任务记为完成，
 * 再在几次异步之后把通知送进会话、开一个新的主回合——两者之间会话不忙、也没有在跑的任务，不能在这个空档里落定终态
 * （否则运行按第一个回合的文字收尾，通知回合落在运行之外被中止）。
 * - 后台任务在最近一个主回合结束之后才完成：通知回合必然要来，最多等 15 秒；
 * - 在回合进行中完成：通知多半已并进那个回合，只给回合结束后 1 秒的余量（防两者几乎同时）。
 * 线上形态不带“通知被压下”的标记，所以都设了上限；被取消的任务不等（取消多由宿主发起，运行已有终态）。
 */
export function backgroundNoticeDue(tasks: readonly WireTask[], turnStartedAt: number, turnEndedAt: number, now: number): boolean {
  return tasks.some((t) => {
    if (t.run_in_background === false || (t.status !== "completed" && t.status !== "failed") || !t.completed_at) return false;
    const endedAt = Date.parse(t.completed_at);
    if (!Number.isFinite(endedAt) || endedAt < turnStartedAt) return false;
    return endedAt > turnEndedAt ? now < endedAt + 15_000 : now < turnEndedAt + 1_000;
  });
}

interface RunRecord {
  runId: string;
  matterId: string;
  sessionId: string;
  promptId: string;
  userId: string;
  status: RuntimeRunStatus;
  stateVersion: number;
  mode: RunMode;
  channel: Channel;
  events: RuntimeEvent[];
  approvals: Map<string, PendingApproval>;
  questions: Set<string>;
  turnId: number | null;
  mainTurnOpen: boolean;
  /** 最近一个主回合开始、结束的时刻（宿主时钟；判断后台命令的完成通知是否还没开回合）。 */
  lastTurnStartedAt: number;
  lastTurnEndedAt: number;
  /** 最近一个主回合结束时裁定的结果（会话空闲后才落定为终态）。 */
  pendingOutcome: { status: RuntimeRunStatus; payload: Record<string, unknown> } | null;
  settling: boolean;
  /** 工作时限：进入等待律师时冻结，离开等待时顺延等待时长（W1）。 */
  deadline: number;
  /** 进入等待律师（确认或回答）的时刻；不在等待时为 null。 */
  waitingSince: number | null;
  /** 总时长上限（含等待）。 */
  wallDeadline: number;
  finishReason: string | undefined;
  providerFinishReason: string | undefined;
  assistantText: string;
  /** 当前步骤的文本与最近一个有文本的步骤（最终答复取后者：工具调用前的过程性文字不算作答复；W1 界面联调发现）。 */
  stepText: string;
  lastStepText: string;
  modelToken: string;
  watchdog: NodeJS.Timeout | null;
  /** 流式文字的节流定时器（onRunText）。 */
  textTimer: NodeJS.Timeout | null;
  /** 过程快照（K7-P：工作清单、子任务、后台任务、上下文整理、方法模板、模型重试）与其节流定时器（onRunProgress）。 */
  progress: ProgressTracker;
  progressTimer: NodeJS.Timeout | null;
  /** 执行域提交中“被整体拒绝或写入失败”的次数（审查 S3-06：有则运行不得判 succeeded）。 */
  commitFailures: number;
}

/**
 * 渠道权限（第 02 篇 §9.6 渠道权限表）：桌面可确认本人事项内全部；Word/WPS 加载项只确认当前文档相关（G0：由加载项发起的运行）；
 * 手机（G2）可回答提问、对跨边界动作作答、确认 T4/T5 类、查看进度与只读预览，且确认须附已登记设备签名；
 * IM、定时、执行器、云端：不能确认、不能作答（转 App 或电脑）。
 */
const CAN_ANSWER: ReadonlySet<Channel> = new Set(["desktop", "office", "mobile"]);
const CAN_VIEW_ARTIFACTS: ReadonlySet<Channel> = new Set(["desktop", "office", "mobile"]);
const CAN_CANCEL: ReadonlySet<Channel> = new Set(["desktop", "office"]);
const MOBILE_CONFIRMABLE_GRADES: ReadonlySet<string> = new Set(["T4", "T5"]);

const decisionKey = (sessionId: string, agentId: string, toolCallId: string) => `${sessionId}\u0000${agentId}\u0000${toolCallId}`;

export class KapRuntime {
  private readonly deps: RuntimeDeps;
  private readonly engines = new Map<string, Promise<MatterEngine>>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly runBySession = new Map<string, string>();
  private readonly approvalIndex = new Map<string, string>();
  /** 宿主策略裁决：按（会话, Agent, 调用 ID）存取（审查 S2-03：不按模型给出的调用 ID 全局查）。 */
  private readonly decisions = new Map<string, PolicyDecisionRecord>();
  private readonly unsubscribers: (() => void)[] = [];
  /** 会话 → 当前订阅（追问在同一会话上开新运行时，先摘掉上一运行的订阅：其终态保护会中止新回合）。 */
  private readonly sessionSubs = new Map<string, () => void>();
  /** 正在启动运行的事项（启动过程中有异步步骤：预占防止两个并发启动都通过“一事项一运行”检查）。 */
  private readonly starting = new Set<string>();
  /** 律师已批准的“询问”裁决（检索与抓取经闸门时按此放行）。 */
  private readonly grantedAsks = new WeakSet<PolicyDecisionRecord>();
  /** 已换取过闸门令牌的检索/抓取裁决（每次裁决只换一次）。 */
  private readonly egressConsumed = new WeakSet<PolicyDecisionRecord>();

  constructor(deps: RuntimeDeps) {
    this.deps = deps;
  }

  /** 宿主 HTTP 出口的授权来源（host-egress.ts）：会话 → 运行令牌；事项 → 工具令牌。 */
  readonly authority: EgressAuthority = {
    modelBinding: (sessionId: string): ModelBinding | null => {
      const runId = this.runBySession.get(sessionId);
      const run = runId ? this.runs.get(runId) : undefined;
      if (!run || TERMINAL.has(run.status)) return null;
      return { matterId: run.matterId, runId: run.runId, token: run.modelToken };
    },
    toolsToken: (matterId: string): string | null => this.deps.toolsToken(matterId),
    /**
     * 检索/抓取（第 04 篇 §5.1）：本事项活动运行中、宿主策略已放行（或律师已批准）、工具调用 ID 与参数摘要都一致、尚未用过的那一次裁决
     * → 该运行的令牌；跨运行歧义即拒绝。模型给出的调用 ID 可能跨回合重复（例如 `functions.WebSearch:0`），所以必须连同参数摘要一起核对。
     */
    toolEgressBinding: (matterId, tool, toolCallId, digest): ModelBinding | null => {
      let pick: { rec: PolicyDecisionRecord; run: RunRecord } | null = null;
      for (const rec of this.decisions.values()) {
        if (rec.toolCallId !== toolCallId || rec.toolName !== tool || rec.egressDigest !== digest || this.egressConsumed.has(rec)) continue;
        if (!(rec.decision === "approve" || (rec.decision === "ask" && this.grantedAsks.has(rec)))) continue;
        const runId = this.runBySession.get(rec.sessionId);
        const run = runId ? this.runs.get(runId) : undefined;
        if (!run || TERMINAL.has(run.status) || run.matterId !== matterId) continue;
        if (pick && pick.run.runId !== run.runId) return null; // 跨运行歧义
        pick ??= { rec, run };
      }
      if (!pick) return null;
      this.egressConsumed.add(pick.rec);
      const decision = `${pick.rec.decision === "ask" ? "ask+approved" : "approve"}:${pick.rec.reason}`;
      return { matterId: pick.run.matterId, runId: pick.run.runId, token: pick.run.modelToken, decision };
    },
  };

  private engine(matterId: string): Promise<MatterEngine> {
    let e = this.engines.get(matterId);
    if (!e) {
      const layout = this.deps.matterLayout(matterId);
      e = MatterEngine.open({
        matterId,
        homeDir: layout.homeDir,
        materialsDir: layout.materialsDir,
        workDir: layout.workDir,
        trustedDir: layout.trustedDir,
        ...(layout.keyring ? { keyring: layout.keyring } : {}),
        manifests: this.deps.manifests,
        legalMcpTools: layout.legalMcpTools ?? [],
        trustedRgPath: this.deps.trustedRgPath,
        execDomain: this.deps.execDomain,
        execDomainFactory: this.deps.execDomainFactory,
        onExecEvent: (e) => this.onExecEvent(matterId, e),
        execAllowed: () => (this.hasLiveRun(matterId) ? null : "no_live_run"),
        searchConfigured: this.deps.searchConfigured ?? false,
        fetchConfigured: this.deps.fetchConfigured ?? false,
        ...(this.deps.testMaxContextSize ? { testMaxContextSize: this.deps.testMaxContextSize } : {}),
        onDecision: (r) => this.decisions.set(decisionKey(r.sessionId, r.agentId, r.toolCallId), r),
        ...(this.deps.screenSearch ? { screenSearch: this.deps.screenSearch } : {}),
        ...(this.deps.logLevel ? { logLevel: this.deps.logLevel } : {}),
      });
      this.engines.set(matterId, e);
      e.catch(() => this.engines.delete(matterId));
    }
    return e;
  }

  /** 本事项是否有进行中的运行（执行域路由的 fencing：审查 S3-07）。 */
  private hasLiveRun(matterId: string): boolean {
    for (const run of this.runs.values()) if (run.matterId === matterId && !TERMINAL.has(run.status)) return true;
    return false;
  }

  /** 执行域事件（排队位置、结束与提交摘要）→ 本事项活动运行的事件流（界面显示排队；G0 同一事项只有一个活动运行）。 */
  private onExecEvent(matterId: string, e: { type: string } & Record<string, unknown>): void {
    if (e.type !== "exec.queued" && e.type !== "exec.finished") return;
    for (const run of this.runs.values()) {
      if (run.matterId !== matterId || TERMINAL.has(run.status)) continue;
      const { type, ...payload } = e;
      const commit = (payload as { commit?: { rejected?: number; failed?: number } }).commit;
      if (type === "exec.finished" && commit && ((commit.rejected ?? 0) > 0 || (commit.failed ?? 0) > 0)) run.commitFailures += 1;
      this.push(run, type, payload);
      return;
    }
  }

  private push(run: RunRecord, type: string, payload: Record<string, unknown> = {}): void {
    const e: RuntimeEvent = { seq: run.events.length + 1, at: new Date().toISOString(), type, payload };
    run.events.push(e);
    this.deps.onRunEvent?.(run.runId, e);
  }

  private setStatus(run: RunRecord, status: RuntimeRunStatus): void {
    if (run.status === status || TERMINAL.has(run.status)) return;
    // 等待律师确认或回答的时间不计入工作时限（W1）：进入等待时记下时刻，离开等待时把工作时限顺延等待时长
    const now = Date.now();
    const waiting = status === "waiting_approval" || status === "waiting_input";
    if (waiting && run.waitingSince === null) run.waitingSince = now;
    if (!waiting && run.waitingSince !== null) {
      run.deadline += now - run.waitingSince;
      run.waitingSince = null;
    }
    run.status = status;
    run.stateVersion += 1;
  }

  /** 超时判定：工作时限（等待期间冻结）或总时长上限（含等待）。 */
  private overdue(run: RunRecord, now: number): "run_deadline_exceeded" | "run_wall_deadline_exceeded" | null {
    if (now > run.wallDeadline) return "run_wall_deadline_exceeded";
    const active = run.waitingSince == null ? run.deadline : run.deadline + (now - run.waitingSince);
    return now > active ? "run_deadline_exceeded" : null;
  }

  async startRun(
    req: StartRunRequest,
    origin: RequestOrigin,
  ): Promise<{ run_id: string; session_id: string; status: RuntimeRunStatus; mode: RunMode; state_version: number }> {
    if (!req.matter_id || typeof req.goal !== "string" || req.goal.trim().length === 0) throw new RuntimeError("validation", "需要 matter_id 与 goal");
    if (!origin?.channel || !origin.userId) throw new RuntimeError("forbidden", "缺少网关注入的请求来源");
    const policy = this.deps.matterPolicy?.(req.matter_id) ?? STRICTEST_MATTER_POLICY;
    const runId = req.run_id ?? `krun_${randomUUID()}`;
    const prev = this.runs.get(runId);
    if (prev) {
      // 内核重试同一任务（runs.retry 沿用任务编号）：上一次运行已终结（finish 已解绑会话、清理审批与裁决）即换下旧记录；
      // 仍在进行或正在收尾的照旧拒绝（第 4 批复核 B 范围外发现：此前宿主不重启就无法重试失败的任务）
      if (!TERMINAL.has(prev.status) || prev.settling) throw new RuntimeError("conflict", "运行已存在");
      if (prev.textTimer) clearTimeout(prev.textTimer);
      if (prev.progressTimer) clearTimeout(prev.progressTimer);
      this.runs.delete(runId);
    }
    // 审查 S3-16：G0 同一事项同时只运行一个任务——执行域的取消范围、路由 fencing 与事件归属都按事项，入口必须强制
    if (this.hasLiveRun(req.matter_id) || this.starting.has(req.matter_id)) throw new RuntimeError("conflict", "这个事项里还有一个任务在进行，请等它完成或取消后再开始（同一事项同时只运行一个任务）");
    this.starting.add(req.matter_id);
    try {
      return await this.startRunReserved(req, origin, policy, runId);
    } finally {
      this.starting.delete(req.matter_id);
    }
  }

  private async startRunReserved(
    req: StartRunRequest,
    origin: RequestOrigin,
    policy: MatterPolicy,
    runId: string,
  ): Promise<{ run_id: string; session_id: string; status: RuntimeRunStatus; mode: RunMode; state_version: number }> {
    const engine = await this.engine(req.matter_id);
    const mode = effectiveMode(req.mode, policy.maxMode, origin.channel);
    const allowed = new Set(policy.allowedPreauthorizations);
    const preauthorized = new Set((req.preauthorized ?? []).filter((p) => allowed.has(p)));
    let session: { id: string };
    if (req.continue_session_id) {
      const sid = req.continue_session_id;
      if (this.runBySession.has(sid)) throw new RuntimeError("conflict", "该会话还有进行中的运行，请等它结束后再追问");
      // 会话只在本事项的引擎里查找（每事项一个引擎与数据根：别的事项的会话在这里不存在）；宿主重启后先恢复
      const found = await engine.kap.getSession(sid).catch(async () => {
        await engine.kap.sessionAction(sid, "restore").catch(() => null);
        return engine.kap.getSession(sid).catch(() => null);
      });
      if (!found) throw new RuntimeError("not_found", "上一次的对话记录不存在（可能已清理），请新建任务");
      session = { id: sid };
    } else session = await engine.kap.createSession(engine.workDir, `任务 ${runId.replace(/^[a-z]+_/, "").slice(0, 8)}`); // 会话标题不含任务内容（审计 S3 1-10：标题落盘）
    const run: RunRecord = {
      runId,
      matterId: req.matter_id,
      sessionId: session.id,
      promptId: `p_${randomUUID().replace(/-/g, "")}`,
      userId: origin.userId,
      status: "running",
      stateVersion: 1,
      mode,
      channel: origin.channel,
      events: [],
      approvals: new Map(),
      questions: new Set(),
      turnId: null,
      mainTurnOpen: false,
      lastTurnStartedAt: 0,
      lastTurnEndedAt: 0,
      pendingOutcome: null,
      settling: false,
      // 工作时限以内核下发为准（复核 S5-B08：内核可调的时限不被宿主缺省值截短）；未下发时用宿主缺省（30 分钟）；上限不超过总时长
      deadline: Date.now() + (typeof req.time_limit_ms === "number" && req.time_limit_ms > 0 ? Math.min(req.time_limit_ms, this.deps.maxWallMs ?? 8 * 60 * 60_000) : (this.deps.maxRunMs ?? 30 * 60_000)),
      waitingSince: null,
      wallDeadline: Date.now() + (typeof req.wall_limit_ms === "number" && req.wall_limit_ms > 0 ? req.wall_limit_ms + 5 * 60_000 : (this.deps.maxWallMs ?? 8 * 60 * 60_000 + 5 * 60_000)),
      finishReason: undefined,
      providerFinishReason: undefined,
      assistantText: "",
      stepText: "",
      lastStepText: "",
      modelToken: this.deps.modelToken({ runId, matterId: req.matter_id, sessionId: session.id }),
      watchdog: null,
      textTimer: null,
      progress: new ProgressTracker(engine.skillNames),
      progressTimer: null,
      commitFailures: 0,
    };
    const planFirst = req.plan_first ?? !req.continue_session_id;
    // 先绑定（宿主策略与出口都按会话识别运行），再订阅事件，最后提交提示——不漏事件、不出现未绑定的工具调用
    engine.policy.bindSession(session.id, {
      runId,
      matterId: req.matter_id,
      mode,
      channel: origin.channel,
      purpose: policy.purpose,
      dataLevel: policy.dataLevel,
      basisComplete: policy.basisComplete,
      preauthorized,
      fetchAllowlist: policy.fetchAllowlist,
      budget: { maxToolCalls: policy.budget.maxToolCalls, maxSubagents: policy.budget.maxSubagents },
      planFirst,
    });
    this.runs.set(runId, run);
    this.runBySession.set(session.id, runId);
    this.sessionSubs.get(session.id)?.();
    const rawUnsub = await engine.subscribe(session.id, (e) => this.onEngineEvent(run, engine, e));
    let unsubscribed = false;
    const unsub = () => {
      if (unsubscribed) return;
      unsubscribed = true;
      rawUnsub();
    };
    this.sessionSubs.set(session.id, unsub);
    this.unsubscribers.push(unsub);
    this.push(run, "run.started", { session_id: session.id, mode, requested_mode: req.mode, channel: origin.channel, model: MAIN_MODEL, data_level: policy.dataLevel, plan_first: planFirst });
    // 看门狗（审查 S2-15）：总时限与审批有效期主动执行，不依赖主回合结束或有人调用审批接口
    run.watchdog = setInterval(() => void this.watch(run, engine), 1_000);
    run.watchdog.unref();
    try {
      if (planFirst) await engine.kap.enterPlanMode(session.id);
      await engine.kap.prompt(session.id, { text: req.goal, model: MAIN_MODEL, promptId: run.promptId });
    } catch (e) {
      this.finish(run, engine, "failed", { reason: "prompt_rejected", error: (e as Error).message });
      throw e instanceof KapError ? new RuntimeError("unavailable", e.message) : e;
    }
    return { run_id: runId, session_id: session.id, status: run.status, mode, state_version: run.stateVersion };
  }

  private onEngineEvent(run: RunRecord, engine: MatterEngine, e: EventEnvelope): void {
    const p = (e.payload ?? {}) as Record<string, any>;
    const agentId = typeof p.agentId === "string" ? p.agentId : "main";
    // 终态之后：引擎若再起回合（后台子 Agent 通知、目标续跑、定时触发等），立即中止——会话已解绑，不再出站（审查 S2-01）
    if (TERMINAL.has(run.status)) {
      if (e.type === "turn.started") void engine.kap.sessionAction(run.sessionId, "abort").catch(() => {});
      return;
    }
    // 过程快照（K7-P）：工作清单、子任务、后台任务、上下文整理、方法模板、模型重试；里程碑进时间线
    const progressed = run.progress.apply(e.type, p);
    if (progressed.milestone) this.push(run, progressed.milestone.type, progressed.milestone.payload);
    if ((progressed.changed || progressed.beat) && this.deps.onRunProgress && !run.progressTimer) {
      run.progressTimer = setTimeout(() => {
        run.progressTimer = null;
        if (TERMINAL.has(run.status)) return;
        this.deps.onRunProgress?.(run.runId, run.progress.snapshot());
      }, 300);
      run.progressTimer.unref();
    }
    // 回合生命周期只认主 Agent：子 Agent 与集群成员在同一会话内有自己的回合
    const lifecycle = e.type === "turn.started" || e.type === "turn.ended" || e.type === "assistant.delta" || e.type === "turn.step.completed";
    if (lifecycle && agentId !== "main") return;
    switch (e.type) {
      case "turn.started":
        run.mainTurnOpen = true;
        run.lastTurnStartedAt = Date.now();
        if (run.turnId === null && typeof p.turnId === "number") run.turnId = p.turnId;
        this.push(run, "run.turn_started", { turn_id: p.turnId });
        break;
      case "assistant.delta":
        if (typeof p.delta === "string") {
          run.assistantText += p.delta;
          run.stepText += p.delta;
          if (this.deps.onRunText && !run.textTimer) {
            run.textTimer = setTimeout(() => {
              run.textTimer = null;
              if (TERMINAL.has(run.status)) return;
              const text = run.stepText.trim() ? run.stepText : run.lastStepText;
              this.deps.onRunText?.(run.runId, text.slice(-4_000));
            }, 300);
            run.textTimer.unref();
          }
        }
        break;
      case "tool.call.started":
        this.push(run, "run.tool_started", { tool_call_id: p.toolCallId, tool: p.name, description: p.description ?? null, agent_id: agentId });
        break;
      case "tool.result":
        this.push(run, "run.tool_result", { tool_call_id: p.toolCallId, is_error: p.isError === true || p.output?.isError === true, agent_id: agentId });
        break;
      case "permission.approval.requested":
        this.onApprovalRequested(run, engine, p, agentId);
        break;
      case "permission.approval.resolved": {
        const id = p.id ?? p.approvalId;
        if (run.approvals.delete(id)) this.approvalIndex.delete(id);
        this.push(run, "run.approval_resolved", { approval_id: id, decision: p.decision ?? null });
        if (run.approvals.size === 0 && run.questions.size === 0) this.setStatus(run, "running");
        break;
      }
      case "event.question.requested":
        run.questions.add(p.question_id);
        this.setStatus(run, "waiting_input");
        this.push(run, "run.question", { question_id: p.question_id, questions: p.questions ?? [] });
        break;
      case "event.question.answered":
        run.questions.delete(p.question_id);
        this.push(run, "run.question_answered", { question_id: p.question_id });
        if (run.approvals.size === 0 && run.questions.size === 0) this.setStatus(run, "running");
        break;
      case "turn.step.completed":
        if (run.stepText.trim()) run.lastStepText = run.stepText;
        run.stepText = "";
        run.finishReason = typeof p.finishReason === "string" ? p.finishReason : undefined;
        run.providerFinishReason = typeof p.providerFinishReason === "string" ? p.providerFinishReason : undefined;
        break;
      case "error":
        this.push(run, "run.error", { code: p.code ?? null, message: String(p.message ?? "").slice(0, 500), retryable: p.retryable ?? null });
        break;
      case "turn.ended": {
        run.mainTurnOpen = false;
        run.lastTurnEndedAt = Date.now();
        const reason = String(p.reason ?? "");
        const decision = resolveAgentOutcome({
          hostStatus: reason === "completed" ? "succeeded" : reason === "cancelled" ? "cancelled" : "failed",
          exitCode: 0,
          turnEndReason: reason,
          finishReason: run.finishReason,
          providerFinishReason: run.providerFinishReason,
          verifiedArtifacts: run.assistantText.trim().length > 0 ? 1 : 0,
          invalidArtifacts: 0,
        });
        const status: RuntimeRunStatus = decision.outcome === "timed_out" || decision.outcome === "expired" ? "failed" : decision.outcome;
        run.pendingOutcome = {
          status,
          payload: {
            reason: decision.reason,
            turn_end_reason: reason,
            finish_reason: run.finishReason ?? null,
            provider_finish_reason: run.providerFinishReason ?? null,
            error: p.error ?? null,
            final_text: (run.stepText.trim() ? run.stepText : run.lastStepText.trim() ? run.lastStepText : run.assistantText).slice(-20_000),
          },
        };
        this.push(run, "run.turn_ended", { turn_id: p.turnId ?? null, reason });
        void this.settleWhenIdle(run, engine);
        break;
      }
      default:
        break;
    }
  }

  private onApprovalRequested(run: RunRecord, engine: MatterEngine, p: Record<string, any>, agentId: string): void {
    const objectHash = argsHash(p.toolInput ?? {});
    // 审查 S2-03：只认同一会话、同一 Agent、同一调用的裁决，且工具名与参数摘要一致；否则视为无裁决（必须由律师确认）
    const raw = this.decisions.get(decisionKey(run.sessionId, agentId, String(p.toolCallId)));
    const d = raw && raw.toolName === p.toolName && raw.argsHash === objectHash ? raw : undefined;
    // 宿主策略已批准、却仍有审批请求 = 工具自身发起的确认（计划确认、目标确认）。
    // 只有“自动档未开先出计划”的 ExitPlanMode 计划确认由宿主代为批准；其余工具确认一律呈现给律师
    if (d?.decision === "approve" && d.reason === "plan_auto_approved" && p.toolName === "ExitPlanMode" && d.toolName === "ExitPlanMode") {
      this.push(run, "run.approval_auto", { approval_id: p.id, tool: p.toolName, reason: d.reason, object_hash: objectHash });
      void engine.kap.resolveApproval(run.sessionId, p.id, "approved").catch(() => {});
      return;
    }
    const reason = d ? (d.decision === "approve" ? `tool_confirmation:${d.reason}` : d.reason) : "unattributed";
    const pending: PendingApproval = {
      approvalId: p.id,
      runId: run.runId,
      sessionId: run.sessionId,
      toolCallId: String(p.toolCallId),
      toolName: String(p.toolName),
      toolInput: p.toolInput,
      objectHash,
      nonce: randomBytes(16).toString("hex"),
      expiresAt: Date.now() + (this.deps.approvalTtlMs ?? 30 * 60_000),
      reason,
      crossBoundary: d?.crossBoundary ?? null,
      grade: d?.grade ?? null,
      // 工具自身的确认、无裁决归属的请求、每次都须确认的原因：都只能逐次批准；手动档“每一步确认、逐项确认”，不提供“本任务内允许”（第 02 篇 §9.3；复核 S5-B11）
      taskAllowable: d?.decision === "ask" && !ONCE_ONLY_REASONS.has(d.reason) && run.mode !== "manual",
      agentId,
      decision: d ?? null,
    };
    run.approvals.set(pending.approvalId, pending);
    this.approvalIndex.set(pending.approvalId, run.runId);
    this.setStatus(run, "waiting_approval");
    this.push(run, "run.approval_requested", {
      approval_id: pending.approvalId,
      tool: pending.toolName,
      action: p.action ?? null,
      display: p.display ?? null,
      // 确认卡所需的参数摘要（W1）：检索式、URL、文件路径、命令开头——内核据此重算卡片内容与出站摘要；令牌形态，只在本机
      input: approvalInputSummary(pending.toolName, p.toolInput),
      object_hash: pending.objectHash,
      nonce: pending.nonce,
      expires_at: new Date(pending.expiresAt).toISOString(),
      reason: pending.reason,
      cross_boundary: pending.crossBoundary,
      scope_options: pending.taskAllowable ? ["once", "task"] : ["once"],
      // 超预算卡（复核 B4-B06）：本次要派出的子任务数与询问时的余额（内核据此写卡片标题与正文）
      budget: d?.overBudget ? { members: d.overBudget.members, tool_calls_left: d.overBudget.toolCallsLeft, subagents_left: d.overBudget.subagentsLeft } : null,
      agent_id: agentId,
      // Agent 在这一步给出的说明（模型自述，令牌形态；确认卡标注“仅供参考”——第 03 篇 §8.2“为什么”；复核 S5-A06）
      agent_note: ((run.stepText ?? "").trim() || (run.lastStepText ?? "").trim()).slice(-300) || null,
    });
  }

  /**
   * 主回合结束后等待会话真正空闲再落定终态（审查 S2-01）：会话不忙、没有运行中的后台任务、没有活动的目标。
   * 期间若主 Agent 又起新回合，交给新回合结束时再判；超过运行总时限即失败收尾并中止会话。
   */
  private async settleWhenIdle(run: RunRecord, engine: MatterEngine): Promise<void> {
    if (run.settling) return;
    run.settling = true;
    try {
      for (;;) {
        if (TERMINAL.has(run.status) || run.mainTurnOpen) return;
        const late = this.overdue(run, Date.now());
        if (late) {
          this.finish(run, engine, "failed", { reason: late });
          await engine.kap.sessionAction(run.sessionId, "abort").catch(() => {});
          return;
        }
        const [status, tasks, goal] = await Promise.all([
          engine.kap.status(run.sessionId).catch(() => null),
          engine.kap.tasks(run.sessionId).catch(() => ({ items: [] as unknown[] })),
          engine.kap.goal(run.sessionId).catch(() => null),
        ]);
        if (TERMINAL.has(run.status) || run.mainTurnOpen) return;
        const backgroundRunning = (tasks.items as { status?: string }[]).some((t) => t.status === "running");
        const goalActive = !!goal && (goal as { status?: string }).status === "active";
        const noticeDue = backgroundNoticeDue(tasks.items as WireTask[], run.lastTurnStartedAt, run.lastTurnEndedAt, Date.now());
        if (status && !status.busy && !backgroundRunning && !goalActive && !noticeDue && run.pendingOutcome) {
          this.finish(run, engine, run.pendingOutcome.status, run.pendingOutcome.payload);
          return;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
    } finally {
      run.settling = false;
    }
  }

  /** 看门狗：超过工作时限（等待律师的时间不计）或总时长上限即失败收尾并中止会话；审批卡过期即按拒绝处理（解除引擎等待）。 */
  private async watch(run: RunRecord, engine: MatterEngine): Promise<void> {
    if (TERMINAL.has(run.status)) return;
    const now = Date.now();
    const late = this.overdue(run, now);
    if (late) {
      this.finish(run, engine, "failed", { reason: late });
      await engine.kap.sessionAction(run.sessionId, "abort").catch(() => {});
      return;
    }
    for (const p of [...run.approvals.values()]) {
      if (now <= p.expiresAt) continue;
      run.approvals.delete(p.approvalId);
      this.approvalIndex.delete(p.approvalId);
      this.push(run, "run.approval_expired", { approval_id: p.approvalId, tool: p.toolName });
      await engine.kap.resolveApproval(run.sessionId, p.approvalId, "rejected", "审批已过期").catch(() => {});
    }
  }

  private finish(run: RunRecord, engine: MatterEngine, status: RuntimeRunStatus, payload: Record<string, unknown>): void {
    if (TERMINAL.has(run.status)) return;
    // 审查 S3-06：本运行中有执行域提交被整体拒绝或写入失败，不得判成功（第 04 篇 §8：缺成果不能成功）
    if (status === "succeeded" && run.commitFailures > 0) {
      payload = { ...payload, reason: "workspace_commit_incomplete", original_reason: payload.reason ?? null, commit_failures: run.commitFailures };
      status = "partial";
    }
    if (run.watchdog) clearInterval(run.watchdog);
    run.watchdog = null;
    run.status = status;
    run.stateVersion += 1;
    // 终态：宿主策略与出口立即解绑（之后同一会话的工具调用与模型请求一律拒绝）；清理本会话的裁决与审批
    engine.policy.unbindSession(run.sessionId);
    this.runBySession.delete(run.sessionId);
    for (const id of run.approvals.keys()) this.approvalIndex.delete(id);
    run.approvals.clear();
    run.questions.clear();
    for (const k of this.decisions.keys()) if (k.startsWith(`${run.sessionId}\u0000`)) this.decisions.delete(k);
    // 取消传播到执行域（审查 S3-07）：任何终态都终止本事项在途与排队中的 Bash（含后台任务；内存层改动丢弃、不提交）；
    // 成功收尾时按理已无在途命令（会话空闲、无后台任务才落定），这里兜底排队中与晚到的调用
    engine.router?.currentDomain().abortAll?.(`run_${status}`);
    this.push(run, `run.${status}`, payload);
  }

  private runOrThrow(runId: string): RunRecord {
    const r = this.runs.get(runId);
    if (!r) throw new RuntimeError("not_found", "运行不存在");
    return r;
  }

  private requireOwner(run: RunRecord, origin: RequestOrigin): void {
    if (!origin?.userId || origin.userId !== run.userId) throw new RuntimeError("forbidden", "只有发起该运行的律师可以操作");
  }

  /** 断线续读（审查 S2-17：只有运行发起人可读；各渠道都可查进度）。 */
  events(runId: string, after: number, origin: RequestOrigin): { events: RuntimeEvent[]; next_seq: number; status: RuntimeRunStatus; state_version: number } {
    const run = this.runOrThrow(runId);
    this.requireOwner(run, origin);
    const events = run.events.filter((e) => e.seq > after);
    return { events, next_seq: run.events.length, status: run.status, state_version: run.stateVersion };
  }

  async answer(runId: string, req: { question_id: string; answers: Record<string, KapAnswer>; expected_state_version: number }, origin: RequestOrigin): Promise<{ ok: true }> {
    const run = this.runOrThrow(runId);
    this.requireOwner(run, origin);
    if (!CAN_ANSWER.has(origin.channel)) throw new RuntimeError("forbidden", `渠道 ${origin.channel} 不能作答（转 App 或电脑）`);
    if (req.expected_state_version !== run.stateVersion) throw new RuntimeError("conflict", `状态已变化（当前 v${run.stateVersion}），请刷新后重试`);
    if (!run.questions.has(req.question_id)) throw new RuntimeError("not_found", "问题不存在或已处理");
    const engine = await this.engine(run.matterId);
    await engine.kap.answerQuestion(run.sessionId, req.question_id, req.answers);
    return { ok: true };
  }

  /**
   * 审批（审查 S2-05）：批准人由网关注入——按**批准人所在渠道**判定，不按运行的发起渠道。
   * 桌面（可信界面认证）可以批准；远程渠道须附已登记设备签名并经验证（G2 设备中继接入前一律不能批准，失败关闭）。
   * 审批卡带 nonce 与有效期，一次性消费；批准对象以参数摘要绑定。
   */
  async approve(
    approvalId: string,
    req: { decision: "approve" | "reject"; object_hash: string; nonce: string; scope?: "once" | "task"; feedback?: string },
    approver: RequestOrigin,
  ): Promise<{ ok: true; scope: "once" | "task" }> {
    const runId = this.approvalIndex.get(approvalId);
    const run = runId ? this.runs.get(runId) : undefined;
    const pending = run?.approvals.get(approvalId);
    if (!run || !pending) throw new RuntimeError("not_found", "审批不存在或已处理");
    this.requireOwner(run, approver);
    if (req.nonce !== pending.nonce) throw new RuntimeError("conflict", "审批卡已失效（nonce 不符），请刷新后重新确认");
    if (req.object_hash !== pending.objectHash) throw new RuntimeError("conflict", "批准对象与待执行的调用不一致（参数已变化），请刷新后重新确认");
    const engine = await this.engine(run.matterId);
    if (Date.now() > pending.expiresAt) {
      // 过期：按拒绝处理，解除引擎等待
      run.approvals.delete(approvalId);
      this.approvalIndex.delete(approvalId);
      await engine.kap.resolveApproval(run.sessionId, approvalId, "rejected", "审批已过期").catch(() => {});
      throw new RuntimeError("conflict", "审批已过期，已按拒绝处理");
    }
    const scope = req.scope ?? "once";
    // 渠道确认范围（第 02 篇 §9.6）：桌面全部；加载项只确认由加载项发起的运行；手机只确认 T4/T5 类且须设备签名；其余渠道不能确认
    if (approver.channel === "office" && run.channel !== "office") throw new RuntimeError("forbidden", "加载项只能确认当前文档相关的运行");
    if (approver.channel === "mobile") {
      if (req.decision === "approve" && !MOBILE_CONFIRMABLE_GRADES.has(pending.grade ?? "")) throw new RuntimeError("forbidden", "手机只能确认检索与抓取类跨边界动作（T4/T5）");
      const ok =
        this.deps.verifyDeviceApproval?.(approver, { approvalId, objectHash: pending.objectHash, nonce: pending.nonce, decision: req.decision, scope }) ?? false;
      if (!ok) throw new RuntimeError("forbidden", "远程渠道的作答须附已登记设备签名并验证通过（设备中继接入前不开放）");
    }
    if (approver.channel !== "desktop" && approver.channel !== "office" && approver.channel !== "mobile") {
      throw new RuntimeError("forbidden", `渠道 ${approver.channel} 不能确认（转 App 或电脑）`);
    }
    if (scope === "task" && !pending.taskAllowable) throw new RuntimeError("validation", "该动作每次都须确认，不能“本任务内允许”");
    // 一次性消费
    run.approvals.delete(approvalId);
    this.approvalIndex.delete(approvalId);
    if (req.decision === "approve" && scope === "task" && pending.reason) {
      engine.policy.allowForTask(run.sessionId, HostPolicy.allowanceKey(pending.toolName, pending.toolInput, pending.reason));
    }
    // 律师批准了宿主策略“询问”的那次调用：检索与抓取经闸门时据此换取运行令牌（仍须工具调用 ID 与参数摘要一致）；
    // 超预算询问获批即按该次调用补记预算（复核 B4-B05：否则之后的调用在“名义余额”内被自动放行）
    if (req.decision === "approve" && pending.decision?.decision === "ask") {
      this.grantedAsks.add(pending.decision);
      engine.policy.chargeApprovedOverBudget(run.sessionId, pending.decision);
    }
    this.push(run, "run.approval_decided", { approval_id: approvalId, decision: req.decision, scope, approver_channel: approver.channel });
    await engine.kap.resolveApproval(run.sessionId, approvalId, req.decision === "approve" ? "approved" : "rejected", req.feedback);
    return { ok: true, scope };
  }

  async cancel(runId: string, req: { reason?: string; expected_state_version: number }, origin: RequestOrigin): Promise<{ status: RuntimeRunStatus }> {
    const run = this.runOrThrow(runId);
    this.requireOwner(run, origin);
    if (!CAN_CANCEL.has(origin.channel)) throw new RuntimeError("forbidden", `渠道 ${origin.channel} 不能停止任务（在电脑上操作）`);
    if (TERMINAL.has(run.status)) throw new RuntimeError("conflict", `运行已结束（${run.status}）`);
    if (req.expected_state_version !== run.stateVersion) throw new RuntimeError("conflict", `状态已变化（当前 v${run.stateVersion}），请刷新后重试`);
    const engine = await this.engine(run.matterId);
    // 先解绑（模型请求与工具调用立即失败），再通知引擎中止当前回合
    this.finish(run, engine, "cancelled", { reason: req.reason ?? "用户取消", by_channel: origin.channel });
    await engine.kap.sessionAction(run.sessionId, "abort").catch(() => {});
    return { status: run.status };
  }

  /**
   * 内核强制取消（N-1）：内核按状态版本取消、遇版本冲突重试仍失败时调用；不校验状态版本与渠道（方法只在内核 IPC 方法表中，
   * 远程渠道经内核 API 到不了这里；内核 API 已按律师看到的版本校验过）。已结束的运行原样返回。
   */
  async forceCancel(runId: string, reason: string): Promise<{ status: RuntimeRunStatus }> {
    const run = this.runOrThrow(runId);
    if (TERMINAL.has(run.status)) return { status: run.status };
    const engine = await this.engine(run.matterId);
    this.finish(run, engine, "cancelled", { reason, by_channel: "kernel" });
    await engine.kap.sessionAction(run.sessionId, "abort").catch(() => {});
    return { status: run.status };
  }

  async artifacts(
    runId: string,
    origin: RequestOrigin,
  ): Promise<{ turn_id: number | null; changes: { path: string; status: string; additions: number; deletions: number; binary?: boolean }[] }> {
    const run = this.runOrThrow(runId);
    this.requireOwner(run, origin);
    if (!CAN_VIEW_ARTIFACTS.has(origin.channel)) throw new RuntimeError("forbidden", `渠道 ${origin.channel} 不能查看成果`);
    if (run.turnId === null) return { turn_id: null, changes: [] };
    const engine = await this.engine(run.matterId);
    const r = await engine.kap.fileChanges(run.sessionId, run.turnId);
    return { turn_id: run.turnId, changes: r.changes };
  }

  async rollback(): Promise<never> {
    throw new RuntimeError("unavailable", "回滚（引擎 undo 映射为业务版本回滚）在 G1 开放");
  }

  private deviceExecCheck: Promise<{ ok: boolean; error: string | null }> | null = null;
  /** 自检失败的结果只缓存一段时间（复核 S3-23：冷启动、杀软首次扫描造成的偶发失败可以恢复）；退避到最长 10 分钟。 */
  private deviceExecRetryAt = 0;
  private deviceExecFailures = 0;

  /**
   * 设备执行域自检（审查 S3-08）：用工厂在临时目录建一次执行域（含真实 worker 往返），结果缓存。不通过即“未隔离：不运行代码”。
   * 事项引擎各自的创建失败另行汇总（execDomainError）。
   */
  deviceExecStatus(): Promise<{ ok: boolean; error: string | null }> {
    if (this.deps.execDomain) return Promise.resolve({ ok: this.deps.execDomain.id !== "none", error: this.deps.execDomain.id === "none" ? "执行域未配置" : null });
    const factory = this.deps.execDomainFactory;
    if (!factory) return Promise.resolve({ ok: false, error: "执行域未配置" });
    if (this.deviceExecCheck && this.deviceExecRetryAt > 0 && Date.now() >= this.deviceExecRetryAt) {
      // 失败结果过期：发起新一轮自检；在途期间清零重试时刻，避免每次查询再起一轮（第二轮复核 S3-28）
      this.deviceExecCheck = null;
      this.deviceExecRetryAt = 0;
    }
    this.deviceExecCheck ??= (async () => {
      const base = realpathSync(mkdtempSync(join(tmpdir(), "kwl-w-selftest-")));
      try {
        const work = join(base, "work");
        const materials = join(base, "materials");
        mkdirSync(work, { recursive: true });
        mkdirSync(materials, { recursive: true });
        const broker = new FileBroker([
          { name: "materials", root: materials, access: "ro" },
          { name: "work", root: work, access: "rw" },
        ]);
        const d = await factory.create({
          matterId: "_device_selftest",
          broker,
          workZone: "work",
          workDir: work,
          readOnlyRoots: [materials],
          homeDir: base,
          pathClass: process.platform === "win32" ? "win32" : "posix",
        });
        await d.close?.().catch(() => {});
        this.deviceExecFailures = 0;
        this.deviceExecRetryAt = 0;
        return { ok: true, error: null };
      } catch (e) {
        this.deviceExecFailures += 1;
        const baseMs = this.deps.deviceSelftestRetryMs ?? 30_000;
        this.deviceExecRetryAt = Date.now() + Math.min(600_000, baseMs * 2 ** (this.deviceExecFailures - 1));
        return { ok: false, error: (e as Error)?.message ?? String(e) };
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    })();
    return this.deviceExecCheck;
  }

  async capabilities(): Promise<CapabilityRow[]> {
    const domain = this.deps.execDomain ?? this.deps.execDomainFactory;
    const dev = await this.deviceExecStatus();
    const matterErrors: string[] = [];
    for (const r of await Promise.allSettled([...this.engines.values()])) {
      if (r.status === "fulfilled" && r.value.execDomainError) matterErrors.push(`${r.value.matterId}：${r.value.execDomainError}`);
    }
    return capabilityLedger({
      execDomain: dev.ok ? (domain?.id ?? "none") : "none",
      execDomainLabel: dev.ok && domain ? domain.label : UNAVAILABLE_DOMAIN.label,
      execDomainError: dev.ok ? (matterErrors.length > 0 ? `部分事项的执行域不可用（这些事项代码运行关闭）：${matterErrors.join("；")}` : null) : dev.error,
      hostSearch: this.deps.trustedRgPath !== null,
      egress: this.deps.egressLevel ?? "app_level",
      searchConfigured: this.deps.searchConfigured ?? false,
      fetchConfigured: this.deps.fetchConfigured ?? false,
      legalMcp: false,
      encryptedStorage: this.deps.atRestActive?.() ?? false,
    });
  }

  /**
   * 取证与测试专用（审查 S2-13）：返回可直接操作策略与引擎的内部对象。宿主进程入口（main.ts）只经 IPC 暴露列明的业务方法，
   * 本方法不在其中——业务网关与远端渠道够不到它。
   */
  matterEngine(matterId: string): Promise<MatterEngine> {
    return this.engine(matterId);
  }

  /** 关闭某事项的引擎（撤权擦除前；有进行中的运行即拒绝）。 */
  async closeMatterEngine(matterId: string): Promise<void> {
    if (this.hasLiveRun(matterId)) throw new RuntimeError("conflict", "该事项有进行中的任务，结束后再清理");
    const e = this.engines.get(matterId);
    if (!e) return;
    this.engines.delete(matterId);
    const engine = await e.catch(() => null);
    await engine?.close().catch(() => {});
  }

  async close(): Promise<void> {
    for (const run of this.runs.values()) if (run.watchdog) clearInterval(run.watchdog);
    for (const u of this.unsubscribers.splice(0)) {
      try {
        u();
      } catch {
        // 已关闭
      }
    }
    const engines = await Promise.allSettled([...this.engines.values()]);
    for (const e of engines) if (e.status === "fulfilled") await e.value.close().catch(() => {});
    this.engines.clear();
  }
}

/** 确认卡的参数摘要：只取卡片需要的字段（不含写入内容等大字段）。 */
function approvalInputSummary(tool: string, input: unknown): Record<string, string> | null {
  if (!input || typeof input !== "object") return null;
  const a = input as Record<string, unknown>;
  const pick = (k: string, max = 2000): Record<string, string> => (typeof a[k] === "string" ? { [k]: (a[k] as string).slice(0, max) } : {});
  switch (tool) {
    case "WebSearch":
      return pick("query");
    case "FetchURL":
      return pick("url");
    case "ReadMediaFile":
    case "Read":
    case "Write":
    case "Edit":
      return { ...pick("path"), ...pick("file_path") };
    case "Bash":
      return pick("command", 400);
    case "Glob":
    case "Grep":
      return { ...pick("pattern", 200), ...pick("path") };
    default:
      return null;
  }
}
