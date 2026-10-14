/**
 * Agent 宿主进程（SDK 形态；v9 第 04 篇 §9：保留为确定性工作流与回归测试宿主，开放任务改由 packages/kap-host 承载）。
 * 每任务一个，短生命周期；由内核拉起，任务结束即退出。
 *
 * 本进程内的约束落点：
 * - 工具层：[tools] enabled 只放行法律工具与四个交互工具（config-template.ts）；内置 Bash/Read/Write 等不可见；
 * - 执行环境：ZP-5 拒绝式进程服务（不产生任何子进程）+ ZP-6 文件系统经文件 broker（F2：逐级 lstat、
 *   O_NOFOLLOW、句柄身份核对，不再用字符串前缀判路径），见 sandbox.ts；
 * - 网络（F4 如实口径）：全局 HTTP 调度器把请求路由到内核命名管道——这是**路由**，不是隔离：它挡不住显式
 *   dispatcher、子进程、原生 socket。隔离依据是 v9 的“出站闸门唯一出口 + 执行域无网”；本宿主另设
 *   HTTP(S)_PROXY 指向不可达黑洞，使绕过调度器但遵守代理变量的客户端失败关闭；
 * - 可信配置（F7）：签名法律 Agent profile 位于只读可信目录（与可写 homeDir 分区）；config.toml / mcp.json
 *   只能在 homeDir（上游约束），由内核写入、登记为 broker 只读文件；三者启动前都按内核下发的 hash 复核，
 *   不一致即拒绝启动；
 * - 终态（F1/F5）：只以 turn.ended 的 reason 与最后一步的 finishReason 为准；最终回答写成成果文件并计算
 *   sha256，经结构化 artifact 事件 + done 完成记录上报，由内核校验——不再拼接事件文本当作成果。
 *
 * 协议（NDJSON）：
 *   stdout: {t:"ready"} / {t:"event", event} / {t:"approval", id, request} / {t:"artifact", ...}
 *           / {t:"done", status, turn_end_reason, finish_reason, interrupt_reason, artifacts} / {t:"error", ...}
 *   stdin:  {t:"approval_result", id, decision} / {t:"cancel"}；stdin 关闭（内核已退出）即自行退出
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Agent, setGlobalDispatcher } from "undici";
import { createKimiHarness } from "../vendor/kimi-code-sdk/index.mjs";
import { legalSandboxSeeds, ensureSandboxDirs } from "./sandbox.ts";


interface TaskSpec {
  taskId: string;
  homeDir: string;
  workDir: string;
  skillDirs: string[];
  goal: string;
  pipePath: string; // 内核命名管道（模型代理与法律工具的通道）
  agentFile?: string; // 签名法律 Agent profile（只读可信目录内；缺省即失败关闭）
  trustedDir?: string; // F7：只读可信目录（签名 profile）
  trustedHashes?: Record<string, string>; // F7：可信文件 sha256（内核验签后下发，宿主启动前复核）
  outDir?: string; // F5：成果目录（只由本宿主写入；内核按 hash 校验后入库）
  timeoutMs?: number;
}

/** 宿主自身的退出码约定（内核按退出码 + 完成记录裁定终态）。 */
const EXIT = { ok: 0, failed: 1, badSpec: 2, cancelled: 3, timedOut: 124 } as const;

function send(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function sha256Hex(buf: Uint8Array | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

const spec = JSON.parse(process.env.ZR_TASK_SPEC ?? "{}") as TaskSpec;
if (!spec.taskId || !spec.homeDir || !spec.workDir || !spec.pipePath) {
  send({ t: "error", message: "bad task spec" });
  process.exit(EXIT.badSpec);
}
// 双层失败关闭（探针 1）：缺签名法律 Agent profile 即拒绝启动——不静默用引擎默认 agent
if (typeof spec.agentFile !== "string" || spec.agentFile.length === 0) {
  send({ t: "error", message: "agent_profile_invalid：task spec 缺 agentFile（签名法律 Agent profile 未注入，失败关闭）" });
  process.exit(EXIT.badSpec);
}
// F5：成果目录必须由内核指定（成果只经该目录 + hash 上报）
if (!spec.outDir) {
  send({ t: "error", message: "bad task spec：缺 outDir（成果目录）" });
  process.exit(EXIT.badSpec);
}
// F7：可信文件复核（内核验签 → 下发 hash → 宿主读取时再核一次；目录只读，与可写 homeDir 分区）。
// 审查 R-10：hash 表必须覆盖 config.toml、mcp.json 与签名 profile，缺任何一项即拒绝启动（失败即拒绝）
const requiredTrusted = [join(spec.homeDir, "config.toml"), join(spec.homeDir, "mcp.json"), spec.agentFile];
const missingTrusted = requiredTrusted.filter((f) => !(f in (spec.trustedHashes ?? {})));
if (missingTrusted.length > 0) {
  send({ t: "error", message: `trusted_config_unverifiable：任务规格缺可信文件 hash（${missingTrusted.join(", ")}），失败关闭` });
  process.exit(EXIT.badSpec);
}
for (const [file, expected] of Object.entries(spec.trustedHashes ?? {})) {
  let actual = "";
  try {
    actual = sha256Hex(readFileSync(file));
  } catch {
    actual = "missing";
  }
  if (actual !== expected) {
    send({ t: "error", message: `trusted_config_tampered：可信配置 ${file} 与内核下发的 hash 不一致（失败关闭）` });
    process.exit(EXIT.badSpec);
  }
}

// 纵深防御：该变量在任何情况下不得出现（升级闸门：rebase 前先 revert #4059）
delete process.env.KIMI_CODE_TRUST_WORKSPACE;
// F4：绕过全局调度器但遵守代理变量的 HTTP 客户端一律落到不可达黑洞（失败关闭，不形成第二出口）
process.env.HTTP_PROXY = process.env.HTTPS_PROXY = process.env.ALL_PROXY = "http://127.0.0.1:9";
process.env.http_proxy = process.env.https_proxy = process.env.all_proxy = "http://127.0.0.1:9";
delete process.env.NO_PROXY;
delete process.env.no_proxy;

// 路由（非隔离，见文件头 F4）：一切 HTTP 请求落到内核命名管道；非白名单路径由内核 404 并计数（探针 2 取证）
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

await ensureSandboxDirs({ homeDir: spec.homeDir, workDir: spec.workDir, skillDirs: spec.skillDirs ?? [], trustedDir: spec.trustedDir, outDir: spec.outDir });
// F7：config.toml / mcp.json 只能在 homeDir（上游从 homeDir 读取）——由内核写入、宿主已按 hash 复核，并登记为 broker 只读文件
const readOnlyFiles = [join(spec.homeDir, "config.toml"), join(spec.homeDir, "mcp.json")];

const harness = createKimiHarness({
  homeDir: spec.homeDir,
  identity: { productName: "KimiWorkLegal", version: "9.0.0-g0", platform: "kwl_agent_host" },
  skillDirs: spec.skillDirs ?? [], // 只加载本次任务解密出的签发方法包（任务结束清除）；空 = 不加载
  uiCapabilities: [],
  extraSeeds: legalSandboxSeeds({
    homeDir: spec.homeDir,
    workDir: spec.workDir,
    skillDirs: spec.skillDirs ?? [],
    trustedDir: spec.trustedDir,
    readOnlyFiles,
  }),
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
      setTimeout(() => void shutdown(EXIT.cancelled), 5000).unref();
    } else if (msg.t === "approval_result" && typeof msg.id === "string") {
      pendingApprovals.get(msg.id)?.(msg.decision === "approved" ? "approved" : "rejected");
      pendingApprovals.delete(msg.id);
    }
  }
});
// F6：内核退出（管道关闭）即自行退出——宿主运行在独立进程组里，不能成为孤儿继续消耗令牌与算力
process.stdin.on("end", () => void shutdown(EXIT.cancelled));

async function shutdown(code: number): Promise<void> {
  try {
    await harness.close();
  } catch {
    // 忽略关闭异常
  }
  process.exit(code);
}

const session = await harness.createSession({
  workDir: spec.workDir, // 只含派生文本（broker 只读区域）
  permission: "manual",
  metadata: { taskId: spec.taskId, edition: "kimi-work-legal" },
  agentFiles: [spec.agentFile!], // 签名法律 Agent profile（只读可信目录）
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

// 回合跟踪（F1/F5）：只认结构化事件，不从拼接文本推断终态
let finalText = ""; // 只累计 assistant.delta（不含 thinking、工具结果）
let lastFinishReason: string | undefined;
let lastProviderFinishReason: string | undefined;
let turnEndReason: string | undefined;
let interruptReason: string | undefined;
let settleResolve: ((s: "ended" | "aborted") => void) | null = null;
const settled = new Promise<"ended" | "aborted">((resolve) => (settleResolve = resolve));

session.onEvent((event: any) => {
  const type = event?.type ?? "unknown";
  const p = event?.payload ?? event;
  send({ t: "event", event: sanitizeEvent(type, event) });
  if (type === "turn.started") {
    finalText = ""; // 新回合：成果只取最后一个回合的回答
    lastFinishReason = undefined;
    lastProviderFinishReason = undefined;
  } else if (type === "assistant.delta" && typeof p?.delta === "string") {
    finalText += p.delta;
  } else if (type === "turn.step.completed") {
    // 审查 R-03：归一化结束原因与 provider 上报值分别上报（上游会把缺失的 provider 结束原因默认成 completed）
    lastFinishReason = typeof p?.finishReason === "string" && p.finishReason ? p.finishReason : undefined;
    lastProviderFinishReason = typeof p?.providerFinishReason === "string" && p.providerFinishReason ? p.providerFinishReason : undefined;
  } else if (type === "turn.ended") {
    turnEndReason = typeof p?.reason === "string" ? p.reason : "unknown";
    interruptReason = typeof p?.interruptReason === "string" ? p.interruptReason : undefined;
    settleResolve?.("ended");
  } else if (type === "prompt.aborted") {
    turnEndReason ??= "cancelled";
    settleResolve?.("aborted");
  }
});

send({ t: "ready", sessionId: session.id });

/** F5：把最终回答写成成果文件（只由宿主写入 outDir），上报路径、大小与 sha256。 */
function emitArtifacts(): { kind: string; file: string; sha256: string; bytes: number }[] {
  const out: { kind: string; file: string; sha256: string; bytes: number }[] = [];
  if (finalText.trim().length === 0) return out;
  const bytes = Buffer.from(finalText, "utf8");
  mkdirSync(spec.outDir!, { recursive: true });
  writeFileSync(join(spec.outDir!, "final_message.md"), bytes, { flag: "w" });
  const art = { kind: "final_message", file: "final_message.md", sha256: sha256Hex(bytes), bytes: bytes.length };
  send({ t: "artifact", ...art });
  out.push(art);
  return out;
}

const timeoutMs = Math.max(10_000, spec.timeoutMs ?? 570_000);
try {
  await session.prompt(spec.goal);
  const outcome = await Promise.race([settled, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), timeoutMs).unref())]);
  if (outcome === "timeout") {
    send({ t: "done", status: "timed_out", turn_end_reason: turnEndReason ?? null, finish_reason: lastFinishReason ?? null, artifacts: [] });
    void session.cancel().catch(() => {});
    await shutdown(EXIT.timedOut);
  }
  if (cancelled || outcome === "aborted" || turnEndReason === "cancelled") {
    send({ t: "done", status: "cancelled", turn_end_reason: turnEndReason ?? null, finish_reason: lastFinishReason ?? null, artifacts: [] });
    await shutdown(EXIT.cancelled);
  }
  if (turnEndReason !== "completed") {
    send({ t: "done", status: "failed", turn_end_reason: turnEndReason ?? null, interrupt_reason: interruptReason ?? null, finish_reason: lastFinishReason ?? null, artifacts: [] });
    await shutdown(EXIT.failed);
  }
  const artifacts = emitArtifacts();
  // 宿主只声明“回合正常结束”；截断、缺成果、hash 不符由内核按完成记录裁定（resolveAgentOutcome）
  send({
    t: "done",
    status: "succeeded",
    turn_end_reason: turnEndReason,
    finish_reason: lastFinishReason ?? null,
    provider_finish_reason: lastProviderFinishReason ?? null,
    artifacts,
  });
  await shutdown(EXIT.ok);
} catch (err) {
  send({ t: "error", message: (err as Error).message });
  await shutdown(EXIT.failed);
}

/** 界面预览事件：截断的字段标 preview（F5：预览不是成果，成果只来自 artifact + hash）。 */
function sanitizeEvent(type: string, event: any): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: type };
  const clip = (v: string, n: number): string => {
    if (v.length > n) out.preview_truncated = true;
    return v.slice(0, n);
  };
  try {
    const p = event?.payload ?? event;
    if (typeof p?.delta === "string") out.delta = clip(p.delta, 2000);
    if (typeof p?.text === "string") out.text = clip(p.text, 4000);
    if (typeof p?.content === "string") out.content = clip(p.content, 4000);
    if (p?.toolName) out.toolName = p.toolName;
    if (p?.toolCallId) out.toolCallId = p.toolCallId;
    if (p?.agentId) out.agentId = p.agentId;
    if (p?.turnId !== undefined) out.turnId = p.turnId;
    if (p?.isError !== undefined) out.isError = p.isError;
    if (typeof p?.reason === "string") out.reason = p.reason;
    if (typeof p?.finishReason === "string") out.finishReason = p.finishReason;
    if (type === "tool.result" && p?.result !== undefined) {
      out.resultPreview = clip(JSON.stringify(p.result) ?? "", 2000);
    }
    if (p?.message) out.message = clip(String(p.message), 1000);
    // 引擎重试/失败事件的原因字段（turn.step.retrying 等）：红队与排障证据
    if (p?.errorName) out.errorName = clip(String(p.errorName), 200);
    if (p?.errorMessage) out.errorMessage = clip(String(p.errorMessage), 1000);
    if (p?.statusCode !== undefined) out.statusCode = p.statusCode;
  } catch {
    out.note = "unserializable";
  }
  return out;
}
