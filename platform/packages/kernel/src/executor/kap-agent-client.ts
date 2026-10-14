/**
 * kap-host 适配器（v9 第 04 篇 §1.1、§3.3）：内核以与 SDK 宿主相同的 AgentClient 接口驱动 Agent 宿主（kap-server 私有嵌入），
 * 执行器的检查点、成果入库、提交点纪元与结算原样复用。
 *
 * - 宿主是长驻子进程（开发与测试：child_process.fork；Electron：utilityProcess），与内核只经 IPC 通信——不经 stdout，
 *   继承输出的进程无法伪造控制消息（阶段 1 复核 M-01）；内核退出时宿主随 IPC 断开而退出；
 * - 每次运行由内核签发模型令牌与工具令牌（绑定任务、尝试与纪元；端点逐次复核活性），并按事项记录给出运行策略（数据级别、依据、模式上限）；
 * - 审批与提问（W1，收敛偏离 D-03/D-04）：宿主的待决审批与提问保存在这里，经内核 API（runs.interactions / runs.approve / runs.answer）
 *   交给可信界面；批准人由内核按调用来源注入（桌面渠道 = 本机已登录用户），不来自模型参数；无人作答时由宿主按有效期过期拒绝；
 * - 宿主策略的只读查询（kcall）：检索式预筛由内核按事项令牌化器与当事人词典作答。
 */
import type { ZoneKeysWire } from "../ws-keys.ts";
import { MatterKeyRing, ZoneCodec } from "@zr-legal/at-rest";
import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { ToolManifest } from "@zr-legal/host-policy";
import { mintTaskToken } from "../identity.ts";
import type { AgentArtifact, AgentClient, AgentTaskPoll } from "./agent-client.ts";
import { diffWorkspace, snapshotWorkspace, type WorkspaceSnapshot } from "./workspace-artifacts.ts";

export interface KapMatterPolicy {
  dataLevel: "L0" | "L1" | "L2" | "L3a" | "L3b";
  basisComplete: boolean;
  fetchAllowlist: string[];
  allowedPreauthorizations: ("search_generalized" | "fetch_allowlisted" | "connector_readonly")[];
  budget: { maxToolCalls: number; maxSubagents: number };
  maxMode: "chat" | "manual" | "default" | "auto";
  purpose: string;
}

export interface KapAgentOptions {
  /** 宿主入口（开发：packages/kap-host/src/main.ts）。 */
  entryPath: string;
  /** 宿主数据根（每事项 <dataRoot>/<matterId>/{home,materials,work}）。 */
  dataRoot: string;
  /** 内核本机端点的命名管道/套接字（法律 MCP）。 */
  kernelSocket: string;
  /** 出站闸门（模型、检索、抓取的唯一出口）：套接字（确保闸门在运行）与检索/抓取路由是否可用。 */
  gate?: { socket: () => Promise<string>; routes: { search: boolean; fetch: boolean } };
  trustedRgPath: string | null;
  manifests: () => ToolManifest[];
  legalMcpTools: string[];
  /** 事项运行策略（内核按事项记录派生）。 */
  matterPolicy(matterId: string): KapMatterPolicy;
  /** 运行槽位（acquire 返回 release）：内核给独立信号量，不与材料导入共用。 */
  ioMutex?: { acquire(): Promise<() => void> };
  revokeToken?: (jti: string) => void;
  runtime?: string;
  /** 验签物化后的可信区（AGENTS.md + skills/）：交给宿主作为每个事项的只读可信区；缺省不加载任何技能。 */
  trustedDir?: string | null;
  /** 随包 W 运行时（安装包形态，收敛偏离 D-05/D-23）：目录与随包 Node 的摘要、锁定版本；缺省开发形态。 */
  wRuntime?: { dir?: string; nodeSha256?: string; nodeVersion?: string };
  /** 检索式预筛（宿主策略经 kcall 调用；见 kap-host HostPolicyDeps.screenSearch）。 */
  screenSearch?: (p: { runId: string; matterId: string; query: string }) => { needsConfirmation: boolean };
  /** 运行进入或离开“等待律师”状态（审批 > 提问 > 无）；内核据此更新任务状态并通知界面。 */
  onWaiting?: (runId: string, kind: "approval" | "input" | null) => void;
  /** 运行选项（界面请求的模式、先出计划、预授权；内核按事项策略钳制后给出）。 */
  runOptions?: (runId: string) => { mode?: KapMatterPolicy["maxMode"]; plan_first?: boolean; preauthorized?: KapMatterPolicy["allowedPreauthorizations"] };
  /**
   * 落盘加密（审计 S3 第 1 步）：按事项派生的区密钥（随每次运行下发，宿主只在内存持有）；required = 宿主没有密钥即拒绝运行（安装包形态）。
   */
  atRest?: { mode: "required" | "optional"; keys: (matterId: string) => ZoneKeysWire };
}

/** 宿主的待决审批（run.approval_requested 载荷）。 */
export type KapPendingApproval = Record<string, unknown> & { approval_id: string; object_hash: string; nonce: string; tool: string; reason: string };
/** 宿主的待决提问（run.question 载荷）。 */
export type KapPendingQuestion = Record<string, unknown> & { question_id: string; questions: unknown[] };

interface TaskState {
  taskId: string;
  runId: string;
  matterId: string;
  uid: string;
  status: AgentTaskPoll["status"];
  events: { seq: number; type: string; payload: Record<string, unknown>; at: string }[];
  previewText: string;
  /** 正在生成的回复尾部（流式，内存）。 */
  liveText?: string;
  error: string | null;
  reason: string | null;
  artifacts: AgentArtifact[];
  release: (() => void) | null;
  approvals: Map<string, KapPendingApproval>;
  questions: Map<string, KapPendingQuestion>;
  waiting: "approval" | "input" | null;
  /** 事项工作区（<dataRoot>/<事项>/work）与运行开始时的快照：终态比对得出本次产物（核查 P0-1）。 */
  workDir: string;
  workBefore: WorkspaceSnapshot;
  /** 工作区区编解码器（审计 S3 第 2 步：工作区是密文；按事项工作区密钥派生，只在本任务期间留在内存，终态比对后清零）。 */
  workCodec: ZoneCodec | null;
  /** 本任务工作区是否加密（编解码器被提前清零时据此不登记工作区产物，绝不把密文当明文登记）。 */
  workSealed: boolean;
}

const TERMINAL_TYPES: Record<string, AgentTaskPoll["status"]> = {
  "run.succeeded": "succeeded",
  "run.partial": "partial",
  "run.failed": "failed",
  "run.cancelled": "cancelled",
};

export interface KapAgentClient extends AgentClient {
  close(): Promise<void>;
  getTask(taskId: string): TaskState | undefined;
  /** 某运行的待决审批与提问（界面渲染确认卡与提问卡）。 */
  interactions(runId: string): { approvals: KapPendingApproval[]; questions: KapPendingQuestion[] } | null;
  /** 正在生成的回复（流式；令牌形态；运行结束后为 null）。 */
  liveText(runId: string): string | null;
  /** 撤权擦除：关闭该事项的引擎并删除其全部 Agent 数据（宿主未运行时直接删除目录）。 */
  purgeMatter(matterId: string): Promise<void>;
  /** 律师的审批决定（批准人由内核注入）。 */
  decide(runId: string, approvalId: string, req: { decision: "approve" | "reject"; object_hash: string; nonce: string; scope: "once" | "task"; feedback?: string }, approver: { channel: string; userId: string }): Promise<void>;
  /** 律师回答提问。 */
  answer(runId: string, questionId: string, answers: Record<string, unknown>, origin: { channel: string; userId: string }, expectedStateVersion?: number): Promise<void>;
  /** 宿主运行的状态版本（界面作答时带回，乐观并发）。 */
  stateVersion(runId: string): Promise<number | null>;
  /** 能力账本：宿主在运行即现取（自检结果最新）；未启动时返回启动时上报的快照或 null（不为设备页而拉起宿主）。 */
  capabilities(): Promise<unknown[] | null>;
  /** 诊断与测试：宿主进程号（未运行为 null）。 */
  hostPid(): number | null;
}

export function createKapAgentClient(opts: KapAgentOptions): KapAgentClient {
  let child: ChildProcess | null = null;
  let ready: Promise<void> | null = null;
  let ledger: unknown[] | null = null;
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  const tasks = new Map<string, TaskState>();
  const taskByRun = new Map<string, TaskState>();

  function onMessage(raw: unknown): void {
    const msg = raw as any;
    if (msg?.t === "result") {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(Object.assign(new Error(msg.error?.message ?? "kap-host error"), { code: msg.error?.code }));
      return;
    }
    if (msg?.t === "event") {
      const task = taskByRun.get(String(msg.run_id));
      if (task) onRunEvent(task, msg.event);
      return;
    }
    if (msg?.t === "text") {
      // 流式文字：只保留最新一份（内存，不落库）；任务结束后由最终答复取代
      const task = taskByRun.get(String(msg.run_id));
      if (task && (task.status === "running" || task.status === "starting") && typeof msg.text === "string") task.liveText = msg.text.slice(-4_000);
      return;
    }
    if (msg?.t === "kcall") {
      // 宿主策略的只读查询：只认已知方法、只回答本运行（运行须属于本客户端的进行中任务）
      const reply = (ok: boolean, result?: unknown, message?: string) => {
        if (child?.connected) child.send({ t: "kresult", id: msg.id, ok, ...(ok ? { result } : { error: { message } }) });
      };
      try {
        if (msg.method === "screenSearch" && opts.screenSearch) {
          const runId = String(msg.params?.run_id ?? "");
          const task = taskByRun.get(runId);
          if (!task || (task.status !== "running" && task.status !== "starting")) return reply(false, undefined, "运行不存在或已结束");
          return reply(true, opts.screenSearch({ runId, matterId: String(msg.params?.matter_id ?? ""), query: String(msg.params?.query ?? "") }));
        }
        reply(false, undefined, `未知查询：${String(msg.method)}`);
      } catch (e) {
        reply(false, undefined, (e as Error).message);
      }
    }
  }

  function syncWaiting(task: TaskState): void {
    const kind = task.approvals.size > 0 ? "approval" : task.questions.size > 0 ? "input" : null;
    if (kind === task.waiting) return;
    task.waiting = kind;
    opts.onWaiting?.(task.runId, kind);
  }

  function ensureHost(): Promise<void> {
    if (child && child.connected && ready) return ready;
    ready = (async () => {
      // 闸门先就绪（宿主的模型、检索、抓取只经闸门；闸门起不来即宿主不启动——失败关闭，不改为直连）
      const gateSocket = opts.gate ? await opts.gate.socket() : undefined;
      const c = fork(opts.entryPath, [], {
        execPath: opts.runtime ?? process.execPath,
        execArgv: [],
        // 控制通道只有 IPC；stdout 丢弃，stderr 只用于诊断
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        env: {
          // 不透传内核环境（内核密钥、模型凭据都不进宿主）；宿主出口另有进程级调度器
          PATH: process.env.PATH ?? "",
          NODE_USE_ENV_PROXY: "1",
          HTTP_PROXY: "http://127.0.0.1:9",
          HTTPS_PROXY: "http://127.0.0.1:9",
          ALL_PROXY: "http://127.0.0.1:9",
          NO_PROXY: "",
        },
      });
      child = c;
      c.stderr?.on("data", () => {});
      c.on("message", onMessage);
      c.on("exit", () => {
        for (const [, p] of pending) {
          clearTimeout(p.timer);
          p.reject(new Error("kap-host 已退出"));
        }
        pending.clear();
        for (const t of tasks.values()) {
          if (t.status === "starting" || t.status === "running") {
            // 待决的确认卡与提问只在宿主内存：宿主退出即作废，任务离开“等待律师”后按失败收尾（复核 S5-B03）
            t.approvals.clear();
            t.questions.clear();
            syncWaiting(t);
            t.status = "failed";
            t.reason = "host_exited";
            t.error = "Agent 宿主进程退出";
            t.workCodec?.wipe();
            t.workCodec = null;
            t.release?.();
            t.release = null;
          }
        }
        if (child === c) {
          child = null;
          ready = null;
        }
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("kap-host 初始化超时")), 60_000);
        const onReady = (raw: unknown) => {
          if ((raw as any)?.t === "ready") {
            if (Array.isArray((raw as any).capabilities)) ledger = (raw as any).capabilities;
            clearTimeout(timer);
            c.off("message", onReady);
            resolve();
          }
        };
        c.on("message", onReady);
        c.send({
          t: "init",
          config: {
            dataRoot: opts.dataRoot,
            kernelSocket: opts.kernelSocket,
            ...(opts.atRest ? { atRest: opts.atRest.mode } : {}),
            ...(gateSocket ? { gateSocket, gateRoutes: opts.gate!.routes } : {}),
            trustedRgPath: opts.trustedRgPath,
            ...(opts.trustedDir ? { trustedDir: opts.trustedDir } : {}),
            ...(opts.wRuntime?.dir ? { wRuntimeDir: opts.wRuntime.dir } : {}),
            ...(opts.wRuntime?.nodeSha256 ? { wNodeSha256: opts.wRuntime.nodeSha256 } : {}),
            ...(opts.wRuntime?.nodeVersion ? { wNodeVersion: opts.wRuntime.nodeVersion } : {}),
            manifests: opts.manifests(),
            legalMcpTools: opts.legalMcpTools,
          },
        });
      });
    })();
    ready.catch(() => {
      ready = null;
    });
    return ready;
  }

  async function call<T>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
    await ensureHost();
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`kap-host 调用超时：${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child!.send({ t: "call", id, method, params });
    });
  }

  function onRunEvent(task: TaskState, e: { seq: number; type: string; payload: Record<string, any>; at: string }): void {
    task.events.push({ seq: task.events.length + 1, type: `agent.${e.type.replace(/^run\./, "")}`, payload: e.payload, at: e.at });
    // 审批与提问（W1）：保存待决项，交给可信界面；决定与回答经内核 API 回到宿主
    switch (e.type) {
      case "run.approval_requested":
        task.approvals.set(String(e.payload.approval_id), e.payload as KapPendingApproval);
        syncWaiting(task);
        return;
      case "run.approval_resolved":
      case "run.approval_decided":
      case "run.approval_expired":
      case "run.approval_auto":
        task.approvals.delete(String(e.payload.approval_id));
        syncWaiting(task);
        return;
      case "run.question":
        task.questions.set(String(e.payload.question_id), e.payload as KapPendingQuestion);
        syncWaiting(task);
        return;
      case "run.question_answered":
        task.questions.delete(String(e.payload.question_id));
        syncWaiting(task);
        return;
      default:
        break;
    }
    const terminal = TERMINAL_TYPES[e.type];
    if (!terminal) return;
    // 终态幂等（复核 S3B-B18）：已收尾的任务不再处理第二个终态事件（编解码器已清零，再比对会把密文当明文登记）
    if (task.status !== "starting" && task.status !== "running") return;
    task.approvals.clear();
    task.questions.clear();
    syncWaiting(task);
    task.reason = (e.payload.reason as string | null) ?? null;
    // 宿主按工作时限或总时长收尾时报 failed + 原因：内核按原因记为超时（与内核兜底一致；复核 S5-B08）
    task.status = terminal === "failed" && (task.reason === "run_deadline_exceeded" || task.reason === "run_wall_deadline_exceeded") ? "timed_out" : terminal;
    task.error = terminal === "failed" ? String(e.payload.error ?? e.payload.reason ?? "failed") : null;
    const text = String(e.payload.final_text ?? "");
    task.previewText = text.slice(-20_000);
    if ((terminal === "succeeded" || terminal === "partial") && text.trim()) {
      const bytes = Buffer.from(text, "utf8");
      task.artifacts = [{ kind: "final_message", filename: "final_message.md", sha256: createHash("sha256").update(bytes).digest("hex"), bytes: new Uint8Array(bytes) }];
    }
    if ((terminal === "succeeded" || terminal === "partial") && task.workSealed && !task.workCodec) {
      // 编解码器已清零（律师取消与完成同时发生）：不登记工作区产物，如实交给时间线
      task.events.push({ seq: task.events.length + 1, type: "agent.workspace_skipped", payload: { files: [{ path: "*", reason: "unreadable" }] }, at: new Date().toISOString() });
    } else if (terminal === "succeeded" || terminal === "partial") {
      // 工作区产物：与开始时的快照比对，新增或改动的文件作为草稿成果（核查 P0-1）
      let diff: ReturnType<typeof diffWorkspace>;
      try {
        diff = diffWorkspace(task.workDir, task.workBefore, task.workCodec);
      } finally {
        task.workCodec?.wipe();
        task.workCodec = null;
      }
      for (const w of diff.artifacts) {
        task.artifacts.push({ kind: "workspace_file", filename: w.path, sha256: w.sha256, bytes: new Uint8Array(w.bytes) });
      }
      if (diff.skipped.length) task.events.push({ seq: task.events.length + 1, type: "agent.workspace_skipped", payload: { files: diff.skipped.slice(0, 20) }, at: new Date().toISOString() });
    }
    task.workCodec?.wipe();
    task.workCodec = null;
    opts.revokeToken?.(task.taskId);
    task.release?.();
    task.release = null;
  }

  return {
    async start(id, req) {
      const taskId = `kap_${id.rid}_${id.aid}`;
      const release = opts.ioMutex ? await opts.ioMutex.acquire() : () => {};
      const task: TaskState = {
        taskId,
        runId: id.rid,
        matterId: id.mid,
        uid: id.uid,
        status: "starting",
        events: [],
        previewText: "",
        error: null,
        reason: null,
        artifacts: [],
        release,
        approvals: new Map(),
        questions: new Map(),
        waiting: null,
        workDir: join(opts.dataRoot, id.mid, "work"),
        workBefore: new Map(),
        workCodec: null,
        workSealed: false,
      };
      let atRestKeys: ZoneKeysWire | null = null;
      try {
        // 落盘加密：本次运行下发的区密钥同时用于内核读工作区（快照与终态比对解封）；只取 work 用途。
        // 取密钥、派生、快照都在 try 内：任何一步抛错都要释放运行槽位（复核 S3B-B06）
        atRestKeys = opts.atRest ? opts.atRest.keys(id.mid) : null;
        if (atRestKeys) {
          task.workSealed = true;
          const ring = MatterKeyRing.fromWire(atRestKeys);
          try {
            task.workCodec = ZoneCodec.fromWire(ring.zone("work").toWire());
          } finally {
            ring.wipe();
          }
        }
        task.workBefore = snapshotWorkspace(task.workDir, task.workCodec);
      } catch (e) {
        task.workCodec?.wipe();
        task.workCodec = null;
        release();
        throw e;
      }
      tasks.set(taskId, task);
      taskByRun.set(id.rid, task);
      try {
        // 运行令牌有效期 = 任务总时长上限（含等待律师；W1）+ 宽限（覆盖宿主冷启动与 startRun，复核 S5-B08）：等待期间令牌不过期；
        // 活性由端点与闸门逐次复核，任务终止即失效（偏离 D-26：方案为 5 分钟短期令牌 + 续租）
        const ttl = Math.ceil((req.wall_ms ?? req.timeout_ms ?? 600_000) / 1000) + 300;
        const claims = { tid: id.tid, uid: id.uid, mid: id.mid, rid: id.rid, aid: id.aid, fen: id.fence, jti: taskId };
        const policy = opts.matterPolicy(id.mid);
        // 运行模式与“先出计划”（W1，收敛偏离 D-03）：界面请求经内核钳制（runOptionsOf 总给出确定值：未带运行选项的非界面调用为默认档、不先出计划）
        const ro = opts.runOptions?.(id.rid) ?? {};
        const preauthorized = (ro.preauthorized ?? []).filter((x) => policy.allowedPreauthorizations.includes(x));
        await call(
          "startRun",
          {
            request: {
              run_id: id.rid,
              matter_id: id.mid,
              goal: req.goal,
              mode: ro.mode ?? policy.maxMode,
              plan_first: ro.plan_first ?? true,
              ...(preauthorized.length ? { preauthorized } : {}),
              // 工作时限（不含等待律师）：宿主按此判“超过工作时限”，内核另有带宽限的兜底
              ...(req.timeout_ms ? { time_limit_ms: req.timeout_ms } : {}),
              // 总时长上限随内核配置（宿主另加宽限，让内核先判“过期”；复核 B 第二次复核遗留）
              ...(req.wall_ms ? { wall_limit_ms: req.wall_ms } : {}),
              // 追问：在上一次运行的会话上继续（会话编号由内核按任务记录给出）
              ...(req.continue_session_id ? { continue_session_id: req.continue_session_id } : {}),
            },
            origin: { channel: "desktop", userId: id.uid },
            matter_policy: { ...policy, purpose: req.purpose ?? policy.purpose },
            // 运行令牌：模型 + 闸门可用的检索/抓取（闸门按用途逐次复核 scope 与活性）
            model_token: mintTaskToken(
              { ...claims, scope: ["model:chat", ...(opts.gate?.routes.search ? ["egress:search"] : []), ...(opts.gate?.routes.fetch ? ["egress:fetch"] : [])] },
              ttl,
            ),
            // 工具令牌的副作用类别取任务记录派生的能力（端点再与派生能力取交集，令牌只能更窄；2026-10-13 审计 D2：A1 读 + 写本事项草稿）
            tools_token: mintTaskToken({ ...claims, fx: [...(req.fx ?? ["read"])], scope: ["tool:legal"] }, ttl),
            materials: req.materials,
            ...(atRestKeys ? { at_rest: atRestKeys } : {}),
          },
          120_000,
        );
        if (task.status === "starting") task.status = "running";
        return taskId;
      } catch (e) {
        task.status = "failed";
        task.reason = "start_failed";
        task.error = (e as Error).message;
        task.workCodec?.wipe();
        task.workCodec = null;
        opts.revokeToken?.(taskId);
        task.release?.();
        task.release = null;
        throw e;
      }
    },
    async poll(_id, taskId, cursor) {
      const t = tasks.get(taskId);
      if (!t) return { status: "failed", events: [], next_cursor: cursor, preview_text: "", error: "任务不存在", reason: "unknown_task", artifacts: [] };
      const events = t.events.filter((e) => e.seq > cursor);
      return {
        status: t.status,
        events,
        next_cursor: events.length > 0 ? events.at(-1)!.seq : cursor,
        preview_text: t.previewText,
        error: t.error,
        reason: t.reason,
        artifacts: t.artifacts,
      };
    },
    async cancel(id, taskId, reason) {
      const t = tasks.get(taskId);
      if (!t) return;
      opts.revokeToken?.(taskId);
      if (t.status !== "starting" && t.status !== "running") return;
      // 取消的任务不登记工作区产物：区编解码器立即清零（复核 S3B-A09：宿主没有回终态事件时也不会长期留在内存）
      t.workCodec?.wipe();
      t.workCodec = null;
      const st = await call<{ state_version: number }>("events", { run_id: t.runId, after: 1e9, origin: { channel: "desktop", userId: id.uid } }).catch(() => null);
      await call("cancel", { run_id: t.runId, request: { reason, expected_state_version: st?.state_version ?? 0 }, origin: { channel: "desktop", userId: id.uid } }).catch(() => {});
    },
    getTask: (taskId) => tasks.get(taskId),
    hostPid() {
      return child?.pid ?? null;
    },
    async capabilities() {
      if (child?.connected && ready) {
        try {
          const fresh = await call<unknown[]>("capabilities", {}, 10_000);
          if (Array.isArray(fresh)) ledger = fresh;
        } catch {
          // 宿主忙或已退出：返回最近一次快照
        }
      }
      return ledger;
    },
    async purgeMatter(matterId) {
      if (!/^[A-Za-z0-9_.-]{1,128}$/.test(matterId)) throw new Error("非法事项 ID");
      for (const t of tasks.values()) {
        if (t.matterId === matterId && (t.status === "running" || t.status === "starting")) throw Object.assign(new Error("该事项有进行中的任务，结束后再清理"), { code: "conflict" });
      }
      if (child?.connected && ready) {
        await call("purgeMatter", { matter_id: matterId });
        return;
      }
      rmSync(join(opts.dataRoot, matterId), { recursive: true, force: true });
    },
    liveText(runId) {
      const t = taskByRun.get(runId);
      if (!t || (t.status !== "running" && t.status !== "starting")) return null;
      return t.liveText || null;
    },
    interactions(runId) {
      const t = taskByRun.get(runId);
      if (!t) return null;
      return { approvals: [...t.approvals.values()], questions: [...t.questions.values()] };
    },
    async decide(runId, approvalId, req, approver) {
      const t = taskByRun.get(runId);
      if (!t || !t.approvals.has(approvalId)) throw Object.assign(new Error("审批不存在或已处理"), { code: "not_found" });
      await call("approve", { approval_id: approvalId, request: req, approver });
    },
    async answer(runId, questionId, answers, origin, expectedStateVersion) {
      const t = taskByRun.get(runId);
      if (!t || !t.questions.has(questionId)) throw Object.assign(new Error("问题不存在或已处理"), { code: "not_found" });
      // 乐观并发（第 04 篇 §3.3）：界面带回它看到的状态版本；未带（旧调用方）时取宿主当前版本
      const version = expectedStateVersion ?? (await call<{ state_version: number }>("events", { run_id: runId, after: 1e9, origin })).state_version;
      await call("answer", { run_id: runId, request: { question_id: questionId, answers, expected_state_version: version }, origin });
    },
    async stateVersion(runId) {
      const t = taskByRun.get(runId);
      if (!t) return null;
      const st = await call<{ state_version: number }>("events", { run_id: runId, after: 1e9, origin: { channel: "desktop", userId: t.uid } });
      return st.state_version;
    },
    async close() {
      if (child?.connected) child.send({ t: "shutdown" });
      child = null;
      ready = null;
    },
  };
}
