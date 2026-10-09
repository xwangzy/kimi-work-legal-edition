/**
 * Agent 宿主管理器（方案 v5.0 第 4 篇 §3/§4.5，内核侧）：
 * 每任务一个宿主子进程（apps/agent-host）；控制面审批裁决（工具白名单 + 记录）；
 * 事件缓冲供工作流轮询；取消 = 通知子进程退出 → 超时强杀。
 *
 * 与 v4.0 agent-runtime 的差别（§15 迁移表 + §4.2）：
 * - 宿主与内核只经命名管道通信（模型代理与法律工具端点都走管道，不回环网络）；
 * - 宿主带 ZP-5/6 沙箱种子（拒绝式进程服务 + 受限文件系统）——ZP-5 使宿主无孙进程，
 *   急停杀单进程即可，不需要杀进程树；
 * - 每任务令牌由内核签发（scope: model:chat / tool:legal，绑定事项与任务），
 *   撤销语义 = 令牌过期 + 端点按令牌鉴权 + 杀宿主进程（不依赖引擎配合）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newId } from "@zr-legal/domain";
import { sha256B64, verifyBytes } from "@zr-legal/keys";
import { mintTaskToken } from "../identity.ts";
import type { AsyncMutex } from "../mutex.ts";
import type { AgentClient, AgentTaskPoll } from "./agent-client.ts";

export interface AgentHostOptions {
  /** 宿主入口（开发：apps/agent-host/src/host.ts；生产：打包制品路径）。 */
  entryPath: string;
  /** 内核命名管道（模型代理与法律工具端点监听于此）。 */
  pipePath: string;
  /** 每任务工作目录根（<工作区>/agent-tasks）。 */
  workspaceRoot: string;
  /** 拉起宿主的运行时（开发为本机 Node；生产为随包附带并改名签名的 Node 24 运行时）。 */
  runtime?: string;
  /** 每任务预算（秒），默认 600。 */
  defaultTimeoutMs?: number;
  /** Agent 与 OCR 互斥锁（§4.5：8GB 笔记本互斥排队；宿主存活期间持锁）。 */
  ioMutex?: AsyncMutex;
  /**
   * 签名法律 Agent profile（§4.3/探针 1 失败关闭）：每任务组装时验签——
   * 内容 hash + Ed25519 签名（同一内容签名公钥）均通过才把副本注入任务 homeDir；
   * 验签失败/文件缺失 → 任务直接失败 agent_profile_invalid，不静默用引擎默认 agent。
   */
  agentProfile?: { file: string; signerPub: string };
}

export interface AgentEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  at: string;
}

export interface AgentTask {
  taskId: string;
  status: "starting" | "running" | "succeeded" | "failed" | "cancelled";
  events: AgentEvent[];
  outputText: string;
  error: string | null;
}

interface TaskFull extends AgentTask {
  child?: ChildProcess;
  workDir?: string;
  homeDir?: string;
  /** §4.5 互斥锁释放函数（宿主退出时调用）。 */
  releaseLock?: () => void;
}

export function createLocalAgentClient(opts: AgentHostOptions): AgentClient & { getTask(id: string): AgentTask | undefined } {
  const tasks = new Map<string, TaskFull>();
  const runtime = opts.runtime ?? process.env.KWL_AGENT_HOST_NODE ?? process.execPath;

  function getTask(taskId: string): AgentTask | undefined {
    return tasks.get(taskId);
  }

  function push(task: TaskFull, type: string, payload: Record<string, unknown>): void {
    task.events.push({ seq: task.events.length + 1, type, payload, at: new Date().toISOString() });
  }

  function handleChildMessage(task: TaskFull, child: ChildProcess, msg: any): void {
    switch (msg.t) {
      case "ready":
        task.status = "running";
        push(task, "agent.ready", { sessionId: msg.sessionId });
        break;
      case "event":
        push(task, "engine.event", msg.event ?? {});
        if (typeof msg.event?.delta === "string") task.outputText += msg.event.delta;
        else if (typeof msg.event?.text === "string") task.outputText += msg.event.text;
        else if (typeof msg.event?.content === "string") task.outputText += msg.event.content;
        break;
      case "approval": {
        // 控制面审批裁决（§6.2 三分级 v0）：法律工具在事项与工具白名单内 → 自主执行；
        // 其余一律拒绝（外发/签发/删除类动作根本不做成工具，到不了这里）
        const toolName = String(msg.request?.toolName ?? "");
        const approved = toolName.startsWith("mcp__legal__");
        push(task, "agent.approval", {
          id: msg.id,
          tool: toolName,
          agentId: msg.request?.agentId ?? null,
          decision: approved ? "approved" : "rejected",
          policy: "three-tier-v0",
        });
        child.stdin!.write(JSON.stringify({ t: "approval_result", id: msg.id, decision: approved ? "approved" : "rejected" }) + "\n");
        break;
      }
      case "done":
        task.status = msg.status === "cancelled" ? "cancelled" : "succeeded";
        push(task, "agent.done", { status: task.status });
        break;
      case "error":
        task.status = "failed";
        task.error = String(msg.message ?? "unknown");
        push(task, "agent.error", { message: task.error });
        break;
      default:
        break;
    }
  }

  function cleanup(task: TaskFull): void {
    // 任务结束销毁工作目录（§4.2：任务结束销毁；权威状态在事项账本）
    const dir = task.workDir ? join(task.workDir, "..") : undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
  }

  /**
   * 验签法律 Agent profile 并把副本落到任务 homeDir（探针 1 失败关闭）：
   * 返回注入路径；验签失败/缺失返回 null（调用方使任务失败，不启动宿主）。
   */
  function prepareAgentProfile(homeDir: string): string | null {
    const p = opts.agentProfile;
    if (!p) return null;
    try {
      const content = readFileSync(p.file);
      const manifest = JSON.parse(readFileSync(p.file.replace(/\.md$/, ".manifest.json"), "utf8")) as { content_sha256?: string; signature?: string };
      const hash = sha256B64(new Uint8Array(content));
      if (manifest.content_sha256 !== hash) return null;
      if (typeof manifest.signature !== "string" || !verifyBytes(p.signerPub, new TextEncoder().encode(hash), manifest.signature)) return null;
      const dest = join(homeDir, "legal-agent.md");
      writeFileSync(dest, content, { mode: 0o444 }); // 只读副本（ZP-6 下 homeDir 可写，引擎须可读）
      return dest;
    } catch {
      return null;
    }
  }

  function start(
    id: { tid: string; uid: string; mid: string; rid: string; aid: string },
    req: { goal: string; materials: { filename: string; text: string }[]; timeout_ms?: number },
  ): Promise<string> {
    const taskId = `agt_${newId("run").slice(4)}`;
    const base = join(opts.workspaceRoot, taskId);
    const homeDir = join(base, "home");
    const workDir = join(base, "snapshot");
    mkdirSync(homeDir, { recursive: true });

    // 签名法律 Agent profile 验签（§4.3 失败关闭）：不过即任务失败，不启动宿主、不静默降级
    const agentFile = opts.agentProfile ? prepareAgentProfile(homeDir) : null;
    if (opts.agentProfile && !agentFile) {
      const task: TaskFull = { taskId, status: "failed", events: [], outputText: "", error: "agent_profile_invalid：法律 Agent profile 验签失败或文件缺失（失败关闭，未启动宿主）", workDir, homeDir };
      tasks.set(taskId, task);
      push(task, "agent.error", { message: task.error, code: "agent_profile_invalid" });
      return Promise.resolve(taskId);
    }

    // §4.5 互斥：宿主存活期间持锁（与 OCR 批次互斥排队）；宿主退出即释放
    const releaseP = opts.ioMutex ? opts.ioMutex.acquire() : Promise.resolve(() => {});
    return releaseP.then((rel) => {
      try {
        mkdirSync(workDir, { recursive: true });
        // 只放本次任务的派生文本快照（不放原件、不挂律师文件夹，§4.2 进程层）
        for (const m of req.materials) {
          writeFileSync(join(workDir, sanitize(m.filename)), m.text, "utf8");
        }
        const spec = {
          taskId,
          homeDir,
          workDir,
          skillDirs: [],
          goal: req.goal,
          pipePath: opts.pipePath,
          agentFile, // 签名法律 Agent profile 副本（双层失败关闭：宿主侧缺省即拒启动）
        };
        const child = spawn(runtime, [opts.entryPath], {
          env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? base,
            KIMI_CODE_HOME: homeDir,
            ZR_TASK_SPEC: JSON.stringify(spec),
            KWL_TASK_TOKEN: mintTaskToken({ ...id, scope: ["model:chat"] }, 1800),
            KWL_TOOL_TOKEN: mintTaskToken({ ...id, scope: ["tool:legal"] }, 1800),
            NODE_ENV: "production",
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        const task: TaskFull = { taskId, status: "starting", events: [], outputText: "", error: null, child, workDir, homeDir, releaseLock: rel };
        tasks.set(taskId, task);
        push(task, "agent.spawned", { pid: child.pid, workDir, transport: "pipe" });
        wireChild(task, child, req.timeout_ms ?? opts.defaultTimeoutMs ?? 600_000);
        return taskId;
      } catch (e) {
        rel();
        throw e;
      }
    });
  }

  function wireChild(task: TaskFull, child: ChildProcess, timeoutMs: number): void {
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
        handleChildMessage(task, child, msg);
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
        cancel({ tid: "", uid: "" }, task.taskId, "timeout");
      }
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      task.releaseLock?.(); // §4.5：宿主退出即释放互斥锁
      if (task.status === "running" || task.status === "starting") {
        if (code === 0) task.status = "succeeded";
        else if (code === 3) task.status = "cancelled";
        else {
          task.status = "failed";
          task.error = errBuf.slice(-2000) || `exit ${code}`;
        }
      }
      push(task, "agent.exited", { code, status: task.status, error: task.error });
      cleanup(task);
    });
  }

  function poll(_id: { tid: string; uid: string }, taskId: string, cursor: number): Promise<AgentTaskPoll> {
    const task = tasks.get(taskId);
    if (!task) return Promise.resolve({ status: "failed", events: [], next_cursor: cursor, output_text: "", error: "任务不存在" });
    const events = task.events.filter((e) => e.seq > cursor);
    return Promise.resolve({
      status: task.status,
      events,
      next_cursor: events.length > 0 ? events.at(-1)!.seq : cursor,
      output_text: task.outputText.slice(-20_000),
      error: task.error,
    });
  }

  function cancel(_id: { tid: string; uid: string }, taskId: string, reason: string): Promise<void> {
    const task = tasks.get(taskId);
    if (!task || !task.child) return Promise.resolve();
    task.status = "cancelled";
    push(task, "agent.cancel_requested", { reason });
    try {
      task.child.stdin!.write(JSON.stringify({ t: "cancel" }) + "\n");
    } catch {
      // 已退出
    }
    // ZP-5 下宿主无孙进程：超时强杀单进程（不依赖引擎配合）
    setTimeout(() => {
      if (task.child && !task.child.killed) task.child.kill("SIGKILL");
    }, 10_000).unref();
    return Promise.resolve();
  }

  return { start, poll, cancel, getTask };
}

function sanitize(name: string): string {
  return name.replace(/[^\w.一-鿿-]/g, "_").slice(0, 80) || "material.txt";
}
