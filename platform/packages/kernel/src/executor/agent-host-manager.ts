/**
 * Agent 宿主管理器（内核侧；SDK 形态宿主，v9 第 04 篇 §9：保留为确定性工作流与回归测试宿主）。
 * 每任务一个宿主子进程（apps/agent-host）；每次工具调用按清单裁决；事件缓冲供工作流轮询。
 *
 * v9 缺陷修复落点：
 * - F1 终态枚举化：宿主的 done 记录只是“声明”；进程退出后由 resolveAgentOutcome 结合退出码、回合结束原因、
 *   最后一步结束原因与成果校验结果裁定。超时、截断、非零退出、缺成果、未知状态都不能成功；
 * - F3 清单式授权：不再按 `mcp__legal__` 前缀放行，改为 工具 ID + 副作用 + 资源 + 用途 + schema hash（host-policy）；
 * - F5 结构化成果：成果只来自宿主上报的 artifact（文件 + sha256），由本管理器从只读成果目录读取并校验 hash；
 *   事件文本只作界面预览（outputText 更名 previewText，执行器不得以其为成果）；
 * - F6 取消：先撤销任务令牌（端点立即拒绝），再通知宿主，宽限后终止整个进程组（宿主在独立进程组中运行；
 *   Windows 用 taskkill /T）；宿主在内核退出时自行退出（stdin 关闭），不会成为孤儿；
 * - F7 可信配置（如实口径：权限位保护，非只读挂载）：签名 profile 写入只读可信目录（不在可写 homeDir 内）；
 *   config.toml / mcp.json 上游只从 homeDir 读取，写入后设 0444 并由宿主登记为 broker 只读文件（按对象身份保护）；
 *   三者 hash 随任务规格下发，宿主启动前复核。不经 broker 的同用户进程仍可改名替换——kap-host 以内存种子提供可信配置。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { newId, resolveAgentOutcome, LEGAL_MCP_TOOLS, type AgentOutcome } from "@zr-legal/domain";
import { sha256B64, verifyBytes } from "@zr-legal/keys";
import { authorizeToolCall, type RunMode } from "@zr-legal/host-policy";
import { mintTaskToken } from "../identity.ts";
import type { AsyncMutex } from "../mutex.ts";
import { legalToolManifests } from "../tools/registry.ts";
import { writeHomeConfig } from "../../../../apps/agent-host/src/config-template.ts";
import type { AgentArtifact, AgentClient, AgentTaskPoll } from "./agent-client.ts";

export interface AgentHostOptions {
  /** 宿主入口（开发：apps/agent-host/src/host.ts；生产：打包制品路径）。 */
  entryPath: string;
  /** 内核命名管道（模型代理与法律工具端点监听于此）。 */
  pipePath: string;
  /** 每任务工作目录根（<工作区>/agent-tasks）。 */
  workspaceRoot: string;
  /** 拉起宿主的运行时（开发为本机 Node；生产为随包附带并改名签名的 Node 运行时）。 */
  runtime?: string;
  /** 每任务预算（毫秒），默认 600 000。 */
  defaultTimeoutMs?: number;
  /** Agent 与 OCR 互斥锁（8GB 笔记本互斥排队；宿主存活期间持锁）。 */
  ioMutex?: AsyncMutex;
  /** 签名法律 Agent profile（每任务组装时验签；失败关闭）。 */
  agentProfile?: { file: string; signerPub: string };
  /**
   * F6（审查 R-01）：按 jti（= Agent 任务 ID）撤销任务令牌。取消、超时、宿主退出（含正常结束与失败）都会调用；
   * 另外端点每次调用都按尝试行复核纪元——尝试结束即失效，不依赖本回调。
   */
  revokeToken?: (jti: string) => void;
  /** 宿主运行模式（SDK 形态宿主没有人工审批界面：询问类裁决失败关闭为拒绝）。 */
  mode?: RunMode;
}

export interface AgentEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  at: string;
}

export interface AgentTask {
  taskId: string;
  status: "starting" | "running" | AgentOutcome;
  events: AgentEvent[];
  /** 界面预览（截断、拼接、不可作为成果）。 */
  previewText: string;
  error: string | null;
  /** 终态原因（resolveAgentOutcome 的 reason）。 */
  reason: string | null;
  artifacts: AgentArtifact[];
}

interface DeclaredArtifact {
  kind: string;
  file: string;
  sha256: string;
  bytes: number;
}

interface TaskFull extends AgentTask {
  child?: ChildProcess;
  pid?: number | undefined;
  /** 任务用途（运行意图；审批与端点都按它校验）。 */
  purpose: string;
  rid?: string;
  base?: string;
  /** 诊断字段（测试与排障）：任务快照目录、homeDir、成果目录。 */
  workDir?: string;
  homeDir?: string;
  outDir?: string;
  declared: DeclaredArtifact[];
  doneRecord: Record<string, any> | null;
  /** 内核侧发起的终止原因（覆盖宿主声明）。 */
  forced: "cancelled" | "timed_out" | null;
  releaseLock?: () => void;
}

const sha256Hex = (buf: Uint8Array | string): string => createHash("sha256").update(buf).digest("hex");

/**
 * F6（审查 R-02）：终止宿主所在的整个进程组。宿主自己退出之后照样执行（不再以宿主 exitCode 作为跳过条件）——
 * 同组遗留的孙进程按 pgid 一并终止。
 * 如实的残余：POSIX 上调用 setsid 的孙进程会离开进程组（ZP-5 拒绝式进程服务与 ZP-17 封闭直接子进程后，
 * 宿主本身不应产生任何子进程）；Windows 需要 KILL_ON_JOB_CLOSE 作业对象（原生扩展，列入 Windows 实机探针），
 * 目前以 taskkill /T 尽力而为（宿主已退出时它找不到孤儿进程）。
 */
/**
 * 终止宿主进程树。POSIX：宿主在独立进程组中，按 -pgid 发 SIGKILL（宿主退出后照样执行，清理同组遗留进程；
 * setsid/双 fork 逃出进程组的进程不在其内——如实残余，随执行域的作业对象/cgroup 消除）。
 * Windows（复审 N-05）：只在宿主**仍在运行**时按 PID 执行 `taskkill /T /F`；宿主退出后 PID 可能已被复用，
 * 不再按裸 PID 杀树（会误杀无关进程，例如律师正在使用的 Word）——遗留进程由作业对象 KILL_ON_JOB_CLOSE 清理
 * （随执行域与 Windows 探针落地；在此之前如实列为残余）。
 */
function killProcessGroup(pid: number | undefined, alive: boolean): void {
  if (!pid) return;
  if (process.platform === "win32") {
    if (!alive) return;
    try {
      const k = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      k.on("error", () => {
        // taskkill 不可用：不抛出（不让内核进程因未捕获异常退出）
      });
    } catch {
      // 同上
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // ESRCH：进程组已不存在
  }
}

const hostAlive = (child: ChildProcess | null | undefined): boolean => !!child && child.exitCode === null && child.signalCode === null;

/** 宿主退出后等待 stdio 排空的上限（复审 N-06）：到时强制断开并裁定终态，不让持有 stdout 的逃逸进程拖住任务与互斥锁。 */
const STDIO_DRAIN_MS = 2_000;

export function createLocalAgentClient(opts: AgentHostOptions): AgentClient & { getTask(id: string): AgentTask | undefined } {
  const tasks = new Map<string, TaskFull>();
  const runtime = opts.runtime ?? process.env.KWL_AGENT_HOST_NODE ?? process.execPath;
  const manifests = legalToolManifests();
  const mode: RunMode = opts.mode ?? "default";

  function getTask(taskId: string): AgentTask | undefined {
    return tasks.get(taskId);
  }

  function push(task: TaskFull, type: string, payload: Record<string, unknown>): void {
    task.events.push({ seq: task.events.length + 1, type, payload, at: new Date().toISOString() });
  }

  function handleChildMessage(task: TaskFull, child: ChildProcess, msg: any, boundMatterId: string): void {
    switch (msg.t) {
      case "ready":
        if (task.status === "starting") task.status = "running";
        push(task, "agent.ready", { sessionId: msg.sessionId });
        break;
      case "event":
        push(task, "engine.event", msg.event ?? {});
        if (typeof msg.event?.delta === "string" && msg.event?.kind === "assistant.delta" && task.previewText.length < 20_000) {
          task.previewText += msg.event.delta;
        }
        break;
      case "approval": {
        // F3（审查 R-09）：清单式授权，绑定工具 ID + 参数摘要 + 事项 + 用途（来自运行意图）；
        // SDK 形态宿主无人工审批界面——“询问”失败关闭为拒绝
        const toolName = String(msg.request?.toolName ?? "");
        const args = msg.request?.display?.detail ?? msg.request?.display?.input ?? null;
        const d = authorizeToolCall(manifests, { toolId: toolName, boundMatterId, requestedMatterId: requestedMatterOfArgs(args), purpose: task.purpose, mode }, args ?? {});
        const approved = d.decision === "approve";
        push(task, "agent.approval", {
          id: msg.id,
          tool: toolName,
          tool_call_id: msg.request?.toolCallId ?? null,
          agentId: msg.request?.agentId ?? null,
          decision: approved ? "approved" : "rejected",
          policy: "host-policy/manifest-lock-v1",
          reason: d.decision === "ask" ? `${d.reason}（无人工审批通道，失败关闭）` : d.reason,
          side_effect: d.manifest?.sideEffect ?? null,
          schema_hash: d.manifest?.schemaHash ?? null,
          args_hash: d.argsHash,
          purpose: task.purpose,
        });
        child.stdin!.write(JSON.stringify({ t: "approval_result", id: msg.id, decision: approved ? "approved" : "rejected" }) + "\n");
        break;
      }
      case "artifact":
        // 复核 M-01：完成记录之后的成果声明一律忽略（继承了 stdout 的进程不能在宿主上报完成之后追加或替换成果）
        if (task.doneRecord) {
          push(task, "agent.record_ignored", { record: "artifact", why: "after_done" });
          break;
        }
        task.declared.push({ kind: String(msg.kind ?? ""), file: String(msg.file ?? ""), sha256: String(msg.sha256 ?? ""), bytes: Number(msg.bytes ?? -1) });
        break;
      case "done":
        // F1：只记录宿主声明；终态在进程退出后裁定。复核 M-01：只认第一条完成记录（之后的不能把截断改判为成功）
        if (task.doneRecord) {
          push(task, "agent.record_ignored", { record: "done", why: "duplicate_done" });
          break;
        }
        task.doneRecord = msg;
        push(task, "agent.done_declared", { status: msg.status ?? null, turn_end_reason: msg.turn_end_reason ?? null, finish_reason: msg.finish_reason ?? null });
        break;
      case "error":
        task.error = String(msg.message ?? "unknown");
        push(task, "agent.error", { message: task.error });
        break;
      default:
        break;
    }
  }

  /**
   * F5：校验宿主声明的成果——只接受成果目录下的普通文件名（无路径分量、非链接、nlink=1），
   * 大小与 sha256 必须与声明一致；校验通过的成果按字节交给执行器入库。
   */
  function verifyArtifacts(task: TaskFull): { verified: AgentArtifact[]; invalid: number } {
    const verified: AgentArtifact[] = [];
    let invalid = 0;
    const listed = new Set<string>();
    for (const a of (task.doneRecord?.artifacts as DeclaredArtifact[] | undefined) ?? []) listed.add(`${a.file}|${a.sha256}`);
    for (const a of task.declared) {
      try {
        if (!task.outDir || a.file !== basename(a.file) || a.file.startsWith(".") || !listed.has(`${a.file}|${a.sha256}`)) throw new Error("bad name");
        const p = join(task.outDir, a.file);
        const st = lstatSync(p);
        if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) throw new Error("bad file");
        const bytes = readFileSync(p);
        if (bytes.length !== a.bytes || sha256Hex(bytes) !== a.sha256) throw new Error("hash mismatch");
        verified.push({ kind: a.kind, filename: a.file, sha256: a.sha256, bytes: new Uint8Array(bytes) });
      } catch {
        invalid += 1;
      }
    }
    return { verified, invalid };
  }

  function finalize(task: TaskFull, exitCode: number | null): void {
    const { verified, invalid } = verifyArtifacts(task);
    const decision = resolveAgentOutcome({
      hostStatus: task.forced ?? task.doneRecord?.status,
      exitCode,
      turnEndReason: task.doneRecord?.turn_end_reason ?? undefined,
      finishReason: task.doneRecord?.finish_reason ?? undefined,
      providerFinishReason: task.doneRecord?.provider_finish_reason ?? undefined,
      verifiedArtifacts: verified.length,
      invalidArtifacts: invalid,
    });
    task.status = decision.outcome;
    task.reason = decision.reason;
    task.artifacts = decision.outcome === "succeeded" || decision.outcome === "partial" ? verified : [];
    if (decision.outcome !== "succeeded" && !task.error) task.error = decision.reason;
  }

  function cleanup(task: TaskFull): void {
    // 任务结束销毁工作目录（成果已按字节交给执行器；权威状态在事项账本）。可信目录为只读，先恢复可写再删除
    if (!task.base) return;
    try {
      chmodSync(join(task.base, "trusted"), 0o755);
    } catch {
      // 目录不存在
    }
    rmSync(task.base, { recursive: true, force: true });
  }

  /**
   * 验签法律 Agent profile 并把副本落到只读可信目录（F7）：返回路径；验签失败/缺失返回 null（任务失败，不启动宿主）。
   */
  function prepareAgentProfile(trustedDir: string): string | null {
    const p = opts.agentProfile;
    if (!p) return null;
    try {
      const content = readFileSync(p.file);
      const manifest = JSON.parse(readFileSync(p.file.replace(/\.md$/, ".manifest.json"), "utf8")) as { content_sha256?: string; signature?: string };
      const hash = sha256B64(new Uint8Array(content));
      if (manifest.content_sha256 !== hash) return null;
      if (typeof manifest.signature !== "string" || !verifyBytes(p.signerPub, new TextEncoder().encode(hash), manifest.signature)) return null;
      const dest = join(trustedDir, "legal-agent.md");
      writeFileSync(dest, content, { mode: 0o444 });
      return dest;
    } catch {
      return null;
    }
  }

  function start(
    id: { tid: string; uid: string; mid: string; rid: string; aid: string; fence: number },
    req: { goal: string; materials: { filename: string; text: string }[]; timeout_ms?: number; wall_ms?: number; purpose?: string },
  ): Promise<string> {
    const taskId = `agt_${newId("run").slice(4)}`;
    const base = join(opts.workspaceRoot, taskId);
    const homeDir = join(base, "home");
    const workDir = join(base, "snapshot");
    const trustedDir = join(base, "trusted");
    const outDir = join(base, "out");
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(trustedDir, { recursive: true });
    const newTask = (status: TaskFull["status"]): TaskFull => ({
      taskId,
      status,
      events: [],
      previewText: "",
      error: null,
      reason: null,
      artifacts: [],
      declared: [],
      doneRecord: null,
      forced: null,
      purpose: req.purpose ?? "legal_analysis",
      rid: id.rid,
      base,
      workDir,
      homeDir,
      outDir,
    });

    // 签名法律 Agent profile 验签（失败关闭）：不过即任务失败，不启动宿主、不静默降级
    const agentFile = opts.agentProfile ? prepareAgentProfile(trustedDir) : null;
    if (opts.agentProfile && !agentFile) {
      const task = newTask("failed");
      task.error = "agent_profile_invalid：法律 Agent profile 验签失败或文件缺失（失败关闭，未启动宿主）";
      task.reason = "agent_profile_invalid";
      tasks.set(taskId, task);
      push(task, "agent.error", { message: task.error, code: "agent_profile_invalid" });
      cleanup(task);
      return Promise.resolve(taskId);
    }

    // F7：签名 profile 在只读可信目录；config.toml / mcp.json 只能在 homeDir（上游约束）——0444 + broker 只读文件 + hash 下发
    const { configFile, mcpFile } = writeHomeConfig(homeDir, { homeDir, enabledMcpTools: [...LEGAL_MCP_TOOLS] });
    const trustedHashes: Record<string, string> = {};
    for (const f of [configFile, mcpFile, ...(agentFile ? [agentFile] : [])]) trustedHashes[f] = sha256Hex(readFileSync(f));
    chmodSync(trustedDir, 0o555);

    // 互斥：宿主存活期间持锁（与 OCR 批次互斥排队）；宿主退出即释放
    const releaseP = opts.ioMutex ? opts.ioMutex.acquire() : Promise.resolve(() => {});
    return releaseP.then((rel) => {
      try {
        // 只放本次任务的派生文本快照（不放原件、不挂律师文件夹）。材料一律放在 materials/ 子目录：
        // 会话工作目录（快照根）里不出现任何以用户文件名命名的文件——锁版引擎会从工作目录加载 AGENTS.md 等指令文件，
        // 名为 AGENTS.md 的材料不能因此变成指令（ZP-18 同类风险；kap-host 引擎已由补丁关闭）
        const materialsDir = join(workDir, "materials");
        mkdirSync(materialsDir, { recursive: true });
        req.materials.forEach((m, i) => {
          writeFileSync(join(materialsDir, `${String(i + 1).padStart(3, "0")}-${sanitize(m.filename)}`), m.text, "utf8");
        });
        const timeoutMs = req.timeout_ms ?? opts.defaultTimeoutMs ?? 600_000;
        // 令牌（审查 R-01/R-06/R-09）：绑定尝试与纪元（fen）、令牌 ID（jti = 任务 ID）、只授予 read 副作用、用途来自运行意图；
        // 有效期取任务时限（而不是固定 30 分钟）
        const { fence, ...ids } = id;
        const ttl = Math.ceil(timeoutMs / 1000) + 60;
        const tokenClaims = { ...ids, fen: fence, jti: taskId, fx: ["read"], pur: req.purpose ?? "legal_analysis" };
        const spec = {
          taskId,
          homeDir,
          workDir,
          skillDirs: [],
          goal: req.goal,
          pipePath: opts.pipePath,
          agentFile,
          trustedDir,
          trustedHashes,
          outDir,
          timeoutMs: Math.max(10_000, timeoutMs - 5_000), // 宿主自身先于管理器超时，留出上报完成记录的时间
        };
        const child = spawn(runtime, [opts.entryPath], {
          env: {
            PATH: process.env.PATH ?? "",
            // OS home 指向任务目录：锁版引擎会读取 ~/.agents/AGENTS.md 等用户级指令与技能——不让律师电脑上的任何未签名指令进入任务
            HOME: base,
            USERPROFILE: base,
            KIMI_CODE_HOME: homeDir,
            ZR_TASK_SPEC: JSON.stringify(spec),
            KWL_TASK_TOKEN: mintTaskToken({ ...tokenClaims, scope: ["model:chat"] }, ttl),
            KWL_TOOL_TOKEN: mintTaskToken({ ...tokenClaims, scope: ["tool:legal"] }, ttl),
            NODE_ENV: "production",
            // F4（审查 R-14）：Node 只在启动时读取代理变量——在拉起时就让 node:http/https 遵守代理、代理指向不可达黑洞；
            // fetch 走宿主内全局调度器（内核管道）；原生 net socket 仍需 OS 出站规则（第 04 篇 §5.1 第⑤级），如实残余
            NODE_USE_ENV_PROXY: "1",
            HTTP_PROXY: "http://127.0.0.1:9",
            HTTPS_PROXY: "http://127.0.0.1:9",
            ALL_PROXY: "http://127.0.0.1:9",
            NO_PROXY: "",
          },
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32", // F6：独立进程组，取消时整组终止
        });
        const task = newTask("starting");
        task.child = child;
        task.pid = child.pid;
        task.releaseLock = rel;
        tasks.set(taskId, task);
        push(task, "agent.spawned", { pid: child.pid, transport: "pipe", process_group: process.platform !== "win32" });
        wireChild(task, child, timeoutMs, id.mid);
        return taskId;
      } catch (e) {
        rel();
        throw e;
      }
    });
  }

  function wireChild(task: TaskFull, child: ChildProcess, timeoutMs: number, boundMatterId: string): void {
    let buf = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        handleChildMessage(task, child, msg, boundMatterId);
      }
    });
    child.stderr!.setEncoding("utf8");
    let errBuf = "";
    child.stderr!.on("data", (chunk: string) => {
      errBuf += chunk;
      if (errBuf.length > 8000) errBuf = errBuf.slice(-8000);
    });
    const timeout = setTimeout(() => {
      if (task.status === "running" || task.status === "starting") {
        push(task, "agent.timeout", { timeout_ms: timeoutMs });
        void terminate(task, "timed_out", "timeout");
      }
    }, timeoutMs);
    // 审查 R-15：在 'close'（stdio 全部读完）而不是 'exit' 时裁定终态，并处理缓冲区里没有换行的最后一行；
    // 复审 N-06：'exit' 之后最多再等 STDIO_DRAIN_MS，stdio 仍未关闭（例如逃逸的孙进程继承并持有 stdout）即强制断开并收尾
    let settled = false;
    let exitCode: number | null = null;
    const settle = (code: number | null, drainTimedOut: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (buf.trim()) {
        try {
          handleChildMessage(task, child, JSON.parse(buf), boundMatterId);
        } catch {
          // 残行不是完整记录：忽略（缺完成记录即不成功）
        }
        buf = "";
      }
      // 审查 R-01：任何退出路径（正常结束、失败、自行超时、取消）都撤销本任务令牌
      opts.revokeToken?.(task.taskId);
      // 审查 R-02：宿主退出后照样按 pgid 终止同组遗留进程（Windows 不按裸 PID 杀树，见 killProcessGroup）
      killProcessGroup(task.pid, false);
      task.releaseLock?.(); // 宿主退出即释放互斥锁
      if (!task.doneRecord && !task.error && code !== 0) task.error = errBuf.slice(-2000) || `exit ${code}`;
      finalize(task, code);
      push(task, "agent.exited", {
        code,
        status: task.status,
        reason: task.reason,
        error: task.error,
        artifacts: task.artifacts.length,
        token_revoked: !!opts.revokeToken,
        ...(drainTimedOut ? { stdio_drain_timed_out: true } : {}),
      });
      cleanup(task);
    };
    child.on("exit", (code) => {
      exitCode = code;
      // 复核：宿主一退出就撤销令牌（不等 stdio 排空）
      opts.revokeToken?.(task.taskId);
      setTimeout(() => {
        if (settled) return;
        try {
          child.stdout?.destroy();
          child.stderr?.destroy();
        } catch {
          // 已关闭
        }
        settle(exitCode, true);
      }, STDIO_DRAIN_MS).unref();
    });
    child.on("close", (code) => settle(code, false));
  }

  /** F6：先撤销令牌，再通知宿主，宽限后终止整个进程组（宿主是否已退出都执行）。 */
  function terminate(task: TaskFull, kind: "cancelled" | "timed_out", reason: string): Promise<void> {
    if (!task.child) return Promise.resolve();
    opts.revokeToken?.(task.taskId);
    if (!hostAlive(task.child)) {
      // 宿主已退出：按 pgid 清理遗留（POSIX）；终态由 close 或有界排空（STDIO_DRAIN_MS）裁定
      killProcessGroup(task.pid, false);
      return Promise.resolve();
    }
    task.forced = kind;
    push(task, kind === "cancelled" ? "agent.cancel_requested" : "agent.timeout_kill", { reason, token_revoked: !!opts.revokeToken });
    try {
      task.child.stdin!.write(JSON.stringify({ t: "cancel" }) + "\n");
    } catch {
      // 已退出
    }
    const pid = task.pid;
    const child = task.child;
    // 宽限后仍在运行才强杀（复审 N-05：宿主已自行退出的，不在 5 s 后按可能已被复用的 PID/pgid 动手）
    setTimeout(() => {
      if (hostAlive(child)) killProcessGroup(pid, true);
    }, 5_000).unref();
    return Promise.resolve();
  }

  function poll(_id: { tid: string; uid: string }, taskId: string, cursor: number): Promise<AgentTaskPoll> {
    const task = tasks.get(taskId);
    if (!task) return Promise.resolve({ status: "failed", events: [], next_cursor: cursor, preview_text: "", error: "任务不存在", reason: "unknown_task", artifacts: [] });
    const events = task.events.filter((e) => e.seq > cursor);
    return Promise.resolve({
      status: task.status,
      events,
      next_cursor: events.length > 0 ? events.at(-1)!.seq : cursor,
      preview_text: task.previewText.slice(-20_000),
      error: task.error,
      reason: task.reason,
      artifacts: task.artifacts,
    });
  }

  function cancel(_id: { tid: string; uid: string }, taskId: string, reason: string): Promise<void> {
    const task = tasks.get(taskId);
    if (!task) return Promise.resolve();
    return terminate(task, "cancelled", reason);
  }

  return { start, poll, cancel, getTask };
}

/**
 * 参数中显式声明的事项（审查 R-09）：SDK 宿主的审批请求只带展示用参数，文档/解析版本归属由内核端点按数据库复核
 * （local-server endpointAuthorize）；这里只处理显式 matter_id 字段。
 */
function requestedMatterOfArgs(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const m = (args as Record<string, unknown>).matter_id;
  return typeof m === "string" ? m : null;
}

function sanitize(name: string): string {
  return name.replace(/[^\w.一-鿿-]/g, "_").slice(0, 80) || "material.txt";
}
