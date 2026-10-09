/**
 * 所内节点（headless 形态，方案 v5.0 §2/§5.1/§7.4）：同一 createKernel 的无界面运行形态。
 * 四种拓扑是「同一个安装包 + 不同配置」——本进程 = 同一内核制品 + 服务环 + 只读控制台。
 *
 * 服务环（unref 定时器）：sync.export → sync.import（共享文件夹介质）→ 节点执行队列 → 到期定时任务；
 * 异常只告警不退出。硬门禁：未授权/strict/伦理墙事项零字节到节点（入队在桌面、同步在摄取、
 * 执行在本进程的 assertNodeTaskAllowed——三处独立校验）。
 *
 * v0 边界（如实声明）：LAN 部署与双向证书认证 G1（控制台默认 bind 127.0.0.1 + bearer token）；
 * MaaS 席位令牌在 G1 许可流落实（v0 用与桌面同配的本机模型代理/mock）；主备仅租约语义 v0
 * （IM 双活、飞书钉钉主备、节点故障 15 分钟接管属 G1）；跨机器节点加入流程 G1。
 */
import { createServer, type Server } from "node:http";
import { hostname } from "node:os";
import { readFileSync } from "node:fs";
import { DomainError } from "@zr-legal/domain";
import { createKernel, type Kernel } from "@zr-legal/kernel";
import {
  assertNodeTaskAllowed,
  claimNodeTask,
  claimScheduledJob,
  finishNodeTask,
  finishScheduledJob,
  runDeadlineReminder,
  runLawdbWatch,
  runMatterWeeklyReport,
  type NodeTaskRow,
} from "@zr-legal/kernel/node-service";
import { startImRuntime, type ImRuntimeConfig, type ImRuntimeHandle } from "./im-runtime.ts";

export interface FirmNodeConfig {
  dataDir: string;
  firmSlug: string;
  userSlug?: string;
  shareDir: string;
  syncIntervalMs?: number;
  leaseMs?: number;
  consoleBind?: string;
  consolePort?: number;
  consoleToken: string;
  /** IM 连接器配置（§11.2：平台端点或本机模拟器；不配则不启用 IM）。 */
  im?: ImRuntimeConfig;
  env?: NodeJS.ProcessEnv;
}

export interface FirmNodeHandle {
  kernel: Kernel;
  console: { port: number; close(): Promise<void> };
  stop(): Promise<void>;
  /** 手动跑一轮服务环（测试与调试用；服务环定时器也会按间隔触发）。 */
  tick(): Promise<void>;
}

const SCENARIO_SCENES = new Set(["s1.contract_review", "s1b.draft_compare", "s2.case_file", "s6.redaction", "a1.agent_task"]);

async function waitRun(kernel: Kernel, runId: string, timeoutMs = 600_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const d = (await kernel.invoke("runs.get", { run_id: runId })) as any;
    if (["succeeded", "failed", "cancelled"].includes(d.run.status)) return d;
    if (Date.now() > deadline) throw new Error(`run ${runId} 超时`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function startFirmNode(cfg: FirmNodeConfig): Promise<FirmNodeHandle> {
  const leaseMs = cfg.leaseMs ?? 120_000;
  const owner = `firm-node:${hostname()}:${process.pid}`;
  const kernel = await createKernel({
    dataDir: cfg.dataDir,
    firmSlug: cfg.firmSlug,
    userSlug: cfg.userSlug ?? "node",
    ...(cfg.env ? { env: cfg.env } : {}),
  });
  const db = kernel.db;
  const lawdbPkg = (await kernel.invoke("lawdb.status")) as any;

  // IM 连接器（§11.2：租约选主后启动；不配 im 则不启用）
  let im: ImRuntimeHandle | null = null;
  if (cfg.im) {
    try {
      im = await startImRuntime(kernel, cfg.im, { leaseMs: Math.max(cfg.leaseMs ?? 120_000, 30_000) });
      console.log(`[firm-node] IM 连接器已启动（${cfg.im.platform}，租约选主；离线行为说明见控制台 /status）`);
    } catch (e) {
      console.warn(`[firm-node] IM 连接器未启动：${(e as Error)?.message ?? e}`);
    }
  }

  async function executeTask(task: NodeTaskRow): Promise<void> {
    try {
      // 执行处硬门禁（红线第三处：授权撤销后的队列残留在此被拦）
      assertNodeTaskAllowed(db, task.matter_id);
      const input = JSON.parse(task.input_json || "{}") as Record<string, unknown>;
      const scenario = String(input.scenario ?? task.scenario);
      if (!SCENARIO_SCENES.has(scenario)) throw new DomainError("validation", `未知场景 ${scenario}`, 422);
      const est = (await kernel.invoke("runs.estimate", { matter_id: task.matter_id, scenario, document_version_ids: input.document_version_ids ?? [], topic_hint: input.topic_hint })) as any;
      const run = (await kernel.invoke("runs.start", {
        matter_id: task.matter_id,
        estimate_id: est.estimate_id,
        idempotency_key: `node-task-${task.task_id}-att${task.attempt_count}`,
        goal: input.goal,
        topic_hint: input.topic_hint,
      })) as any;
      const done = await waitRun(kernel, run.run_id);
      finishNodeTask(db, task.task_id, { status: done.run.status === "succeeded" ? "succeeded" : "failed", run_id: run.run_id, error: done.run.status === "succeeded" ? null : `run ${done.run.status}` });
    } catch (e) {
      finishNodeTask(db, task.task_id, { status: "failed", error: (e as Error)?.message ?? String(e) });
    }
  }

  async function tick(): Promise<void> {
    try {
      await kernel.invoke("sync.export", { share_dir: cfg.shareDir });
    } catch (e) {
      console.warn(`[firm-node] sync.export 告警：${(e as Error)?.message ?? e}`);
    }
    try {
      await kernel.invoke("sync.import", { share_dir: cfg.shareDir });
    } catch (e) {
      console.warn(`[firm-node] sync.import 告警：${(e as Error)?.message ?? e}`);
    }
    try {
      for (;;) {
        const task = claimNodeTask(db, owner, leaseMs);
        if (!task) break;
        await executeTask(task);
      }
    } catch (e) {
      console.warn(`[firm-node] node_tasks 处理告警：${(e as Error)?.message ?? e}`);
    }
    if (im) {
      try {
        await im.processApprovals();
      } catch (e) {
        console.warn(`[firm-node] IM 审批意向处理告警：${(e as Error)?.message ?? e}`);
      }
    }
    try {
      for (;;) {
        const job = claimScheduledJob(db, owner, leaseMs);
        if (!job) break;
        try {
          let result: Record<string, unknown>;
          if (job.kind === "deadline_reminder") result = runDeadlineReminder(db, job, kernel.signer);
          else if (job.kind === "matter_weekly_report") result = runMatterWeeklyReport(db, kernel.blobs, job, kernel.signer);
          else result = runLawdbWatch(db, job, lawdbPkg.package_version, kernel.signer);
          finishScheduledJob(db, job.job_id, result);
        } catch (e) {
          finishScheduledJob(db, job.job_id, { error: (e as Error)?.message ?? String(e) });
        }
      }
    } catch (e) {
      console.warn(`[firm-node] scheduled_jobs 处理告警：${(e as Error)?.message ?? e}`);
    }
  }

  // ─── 局域网管理控制台 v0（只读；写操作仍走桌面内核 API；零正文） ───
  const token = cfg.consoleToken;
  const server = createServer((req, res) => {
    void (async () => {
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(body));
      };
      if (req.method !== "GET") return json(405, { error: "控制台 v0 只读（无写端点；写操作请走桌面内核 API）" });
      const auth = String(req.headers.authorization ?? "");
      if (auth !== `Bearer ${token}`) return json(401, { error: "控制台令牌不符" });
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      try {
        if (url.pathname === "/status") {
          const sync = (await kernel.invoke("sync.status", { share_dir: cfg.shareDir })) as any;
          return json(200, {
            service: "kwl-firm-node",
            firm: cfg.firmSlug,
            owner,
            uptime_s: Math.round(process.uptime()),
            lawdb_package: lawdbPkg.package_version,
            tasks: db.get(`SELECT status, COUNT(*) AS n FROM node_tasks GROUP BY status`, []) ?? [],
            sync,
            ...(im ? { im: im.status() } : {}),
          });
        }
        if (url.pathname === "/matters") {
          // 仅授权给本节点的事项（脱敏字段：不含当事人/对方/立场/关键日期/标题——LAN 化（双向证书认证 G1）前复核脱敏清单）
          const rows = db.all(`SELECT matter_id, confidentiality, collab_scope, status, node_allowed, created_at FROM matters WHERE tenant_id = ? AND node_allowed = 1 ORDER BY created_at DESC`, [kernel.identity.tenantId]);
          return json(200, { matters: rows, note: "仅 node_allowed=1 的事项（字段已脱敏；标题不外露）" });
        }
        if (url.pathname === "/audit/tail") {
          const rows = db.all(`SELECT audit_event_id, actor_id, action, object_kind, object_id, created_at FROM audit_events WHERE tenant_id = ? ORDER BY audit_event_id DESC LIMIT 50`, [kernel.identity.tenantId]);
          return json(200, { events: rows, note: "只记元数据，不含正文" });
        }
        if (url.pathname === "/jobs") {
          const rows = db.all(`SELECT job_id, kind, matter_id, cron_expr, enabled, last_run_at, last_result, created_at FROM scheduled_jobs WHERE tenant_id = ? ORDER BY created_at DESC`, [kernel.identity.tenantId]);
          return json(200, { jobs: rows });
        }
        return json(404, { error: "not found" });
      } catch (e) {
        return json(500, { error: (e as Error)?.message ?? String(e) });
      }
    })();
  });
  const bind = cfg.consoleBind ?? "127.0.0.1"; // LAN 部署与双向证书认证属 G1（方案 §2 部署前提）
  const port = cfg.consolePort ?? 0;
  await new Promise<void>((r) => server.listen(port, bind, () => r()));
  const actualPort = (server.address() as { port: number }).port;

  const interval = setInterval(() => void tick(), cfg.syncIntervalMs ?? 15_000);
  interval.unref();
  console.log(`[firm-node] up：firm=${cfg.firmSlug} owner=${owner} console=http://${bind}:${actualPort}（只读）share=${cfg.shareDir}`);

  return {
    kernel,
    console: {
      port: actualPort,
      close: () => new Promise<void>((r) => server.close(() => r())),
    },
    tick,
    async stop() {
      clearInterval(interval);
      if (im) await im.stop();
      await new Promise<void>((r) => server.close(() => r()));
      await kernel.close();
    },
  };
}

/** 直接执行入口（bundle/CLI 形态）：ZR_NODE_CONFIG 指向 JSON 配置文件。 */
async function main(): Promise<void> {
  const cfgFile = process.env.ZR_NODE_CONFIG ?? "";
  if (!cfgFile) {
    console.error("用法：ZR_NODE_CONFIG=<node.config.json>（含 dataDir/firmSlug/shareDir/consoleToken 等）");
    process.exit(2);
  }
  const cfg = JSON.parse(readFileSync(cfgFile, "utf8")) as FirmNodeConfig;
  await startFirmNode(cfg);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => process.exit(0));
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  void main();
}
