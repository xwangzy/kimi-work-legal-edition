/**
 * Agent 宿主进程（方案 v5.0 第 4 篇 §3/§4：每任务一个，短生命周期；由内核拉起，任务结束即退出）。
 *
 * 五道约束（§4.2）在本进程内的落点：
 * 2. 网络层：宿主不使用网络栈访问内核——进程内全局 HTTP 调度器把模型代理与法律工具
 *    端点（broker.kwl / tools.kwl）的请求路由到内核命名管道（Unix socket / Windows 命名管道）；
 *    其余一切 HTTP 请求也落到同一管道并 404——本进程事实上无对外网络能力。
 * 4. 执行环境层：ZP-5/6 种子（拒绝式进程服务 + 受限文件系统），见 sandbox.ts。
 * 3. 工具层：[tools] enabled 只放行法律工具与四个交互工具（config-template.ts）。
 *
 * 协议（NDJSON，与内核管理器约定）：
 *   stdout: {t:"ready"} / {t:"event", event} / {t:"approval", id, request} / {t:"done"|"error", ...}
 *   stdin:  {t:"approval_result", id, decision} / {t:"cancel"}
 * 本进程不持有任何长期凭据；任务令牌只在本机有效，急停即被内核撤销（端点拒绝 + 杀进程）。
 */
import { Agent, setGlobalDispatcher } from "undici";
import { createKimiHarness } from "../vendor/kimi-code-sdk/index.mjs";
import { legalSandboxSeeds, ensureSandboxDirs } from "./sandbox.ts";
import { prepareWorkerHome, LEGAL_MCP_TOOLS } from "./config-template.ts";

interface TaskSpec {
  taskId: string;
  homeDir: string;
  workDir: string;
  skillDirs: string[];
  goal: string;
  pipePath: string; // 内核命名管道（模型代理与法律工具的唯一通道）
  agentFile?: string; // 签名法律 Agent profile（§4.3；缺省即失败关闭）
}

function send(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

const spec = JSON.parse(process.env.ZR_TASK_SPEC ?? "{}") as TaskSpec;
if (!spec.taskId || !spec.homeDir || !spec.workDir || !spec.pipePath) {
  send({ t: "error", message: "bad task spec" });
  process.exit(2);
}
// 双层失败关闭（探针 1）：缺签名法律 Agent profile 即拒绝启动——不静默用引擎默认 agent
if (typeof spec.agentFile !== "string" || spec.agentFile.length === 0) {
  send({ t: "error", message: "agent_profile_invalid：task spec 缺 agentFile（签名法律 Agent profile 未注入，失败关闭）" });
  process.exit(2);
}

// 纵深防御：该变量在任何情况下不得出现（升级闸门：rebase 前先 revert #4059）
delete process.env.KIMI_CODE_TRUST_WORKSPACE;

// 网络层：全局调度器把一切 HTTP 请求路由到内核命名管道（broker.kwl/tools.kwl 由此到达内核；
// 其余主机名的请求同样落管并被内核 404——探针 2 验证宿主不依赖回环网络）
setGlobalDispatcher(
  new Agent({
    connect: { socketPath: spec.pipePath },
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 60_000,
  }),
);

let cancelled = false;
let sessionRef: { cancel: () => Promise<void> } | null = null;
const pendingApprovals = new Map<string, (decision: "approved" | "rejected" | "cancelled") => void>();
let approvalSeq = 0;

await ensureSandboxDirs({ homeDir: spec.homeDir, workDir: spec.workDir, skillDirs: spec.skillDirs ?? [] });
prepareWorkerHome({ homeDir: spec.homeDir, enabledMcpTools: [...LEGAL_MCP_TOOLS] });

const harness = createKimiHarness({
  homeDir: spec.homeDir,
  identity: { productName: "KimiWorkLegal", version: "5.0.0-g0", platform: "kwl_agent_host" },
  skillDirs: spec.skillDirs ?? [], // 只加载本次任务解密出的签发方法包（任务结束清除）；空 = 不加载
  uiCapabilities: [],
  extraSeeds: legalSandboxSeeds({ homeDir: spec.homeDir, workDir: spec.workDir, skillDirs: spec.skillDirs ?? [] }),
});

process.stdin.setEncoding("utf8");
let stdinBuf = "";
process.stdin.on("data", (chunk) => {
  stdinBuf += chunk;
  const lines = stdinBuf.split("\n");
  stdinBuf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.t === "cancel") {
      cancelled = true;
      void sessionRef?.cancel().catch(() => {});
      setTimeout(() => void shutdown(3), 5000).unref();
    } else if (msg.t === "approval_result" && typeof msg.id === "string") {
      pendingApprovals.get(msg.id)?.(msg.decision === "approved" ? "approved" : "rejected");
      pendingApprovals.delete(msg.id);
    }
  }
});

async function shutdown(code: number): Promise<void> {
  try {
    await harness.close();
  } catch {
    // 忽略关闭异常
  }
  process.exit(code);
}

const session = await harness.createSession({
  workDir: spec.workDir, // 只含派生文本（ZP-6 只读）
  permission: "manual",
  metadata: { taskId: spec.taskId, edition: "kimi-work-legal" },
  agentFiles: [spec.agentFile!], // 签名法律 Agent profile（§4.3；验签在管理器侧完成）
});
sessionRef = session;

session.setApprovalHandler(async (request: any) => {
  if (cancelled) return { decision: "cancelled" };
  const id = `apr_${++approvalSeq}`;
  send({
    t: "approval",
    id,
    request: {
      toolName: request.toolName,
      action: request.action,
      display: request.display,
      toolCallId: request.toolCallId,
      agentId: request.agentId ?? null,
    },
  });
  const decision = await new Promise<"approved" | "rejected" | "cancelled">((resolve) => {
    pendingApprovals.set(id, resolve);
    setTimeout(() => resolve("rejected"), 120_000);
  });
  return { decision };
});

// 事件流：先转发内核（先落账本再推界面，§1.1 约束 3）
let settleResolve: ((status: "completed" | "aborted") => void) | null = null;
const settled = new Promise<"completed" | "aborted">((resolve) => (settleResolve = resolve));

session.onEvent((event: any) => {
  const type = event?.type ?? "unknown";
  send({ t: "event", event: sanitizeEvent(type, event) });
  // turn.ended 是可靠的回合结束信号（prompt.completed 在 onEvent 通道不一定出现）
  if (type === "turn.ended" || type === "prompt.completed") settleResolve?.("completed");
  if (type === "prompt.aborted") settleResolve?.("aborted");
});

send({ t: "ready", sessionId: session.id });

try {
  await session.prompt(spec.goal);
  const status = await Promise.race([
    settled,
    new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 570_000)),
  ]);
  if (cancelled || status === "aborted") {
    send({ t: "done", status: "cancelled" });
    await shutdown(3);
  }
  send({ t: "done", status: status === "completed" ? "succeeded" : "timeout" });
  await shutdown(status === "completed" ? 0 : 1);
} catch (err) {
  send({ t: "error", message: (err as Error).message });
  await shutdown(1);
}

function sanitizeEvent(type: string, event: any): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: type };
  try {
    const p = event?.payload ?? event;
    if (typeof p?.delta === "string") out.delta = p.delta.slice(0, 2000);
    if (typeof p?.text === "string") out.text = p.text.slice(0, 4000);
    if (typeof p?.content === "string") out.content = p.content.slice(0, 4000);
    if (p?.toolName) out.toolName = p.toolName;
    if (p?.toolCallId) out.toolCallId = p.toolCallId;
    if (p?.agentId) out.agentId = p.agentId;
    if (p?.turnId !== undefined) out.turnId = p.turnId;
    if (p?.isError !== undefined) out.isError = p.isError;
    if (type === "tool.result" && p?.result !== undefined) {
      out.resultPreview = JSON.stringify(p.result)?.slice(0, 2000);
    }
    if (p?.message) out.message = String(p.message).slice(0, 1000);
    // 引擎重试/失败事件的原因字段（turn.step.retrying 等）：红队与排障证据
    if (p?.errorName) out.errorName = String(p.errorName).slice(0, 200);
    if (p?.errorMessage) out.errorMessage = String(p.errorMessage).slice(0, 1000);
    if (p?.statusCode !== undefined) out.statusCode = p.statusCode;
  } catch {
    out.note = "unserializable";
  }
  return out;
}
