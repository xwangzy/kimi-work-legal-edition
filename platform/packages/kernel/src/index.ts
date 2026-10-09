/**
 * 本机法律内核（方案 v5.0 第 4 篇 §1：律所侧单一内核——桌面内嵌 / 所内节点无界面同一代码）。
 *
 * 组装：加密 SQLite 事项账本（页级加密已接线：主密钥经 safeStorage 解封一次性交付，§5.1）+
 * 本地持久任务队列 + 签名事件 hash 链（§5.2/§6.4）+ 密钥体系（§5.3：律所根密钥/设备证书/
 * 事项密钥分发/恢复托管分持）+ 法律工具（内核内模块）+ 本机模型代理 + 出站闸门 +
 * 内核 API（§15.2）+ 本机端点（MCP / OpenAI 兼容，供 Agent 宿主）。
 */
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { EgressGate, type DestinationKind } from "@zr-legal/egress";
import { ModelBroker } from "@zr-legal/model-broker";
import { requireSecret } from "@zr-legal/service-auth";
import { DomainError, LEGAL_MCP_TOOLS } from "@zr-legal/domain";
import { openLawdb } from "@zr-legal/lawdb";
import { loadConfig, defaultPipePath, type KernelConfig, type KernelOptions } from "./config.ts";
import { KernelDb } from "./db.ts";
import { BlobStore } from "./blobs.ts";
import { TaskQueue } from "./queue.ts";
import { createApi } from "./api/index.ts";
import { resolveIdentity, type Identity } from "./identity.ts";
import { ensureFirmIdentity, ensureDevice, keysDirOf } from "./devices.ts";
import { createLedgerSigner, rowPayloadHash } from "./ledger-signer.ts";
import { AsyncMutex } from "./mutex.ts";
import { createBlobCipher } from "./blob-cipher.ts";
import { syncExport, syncImport } from "./sync-engine.ts";
import { createLegalWorkflow } from "./executor/executor.ts";
import { createLocalAgentClient } from "./executor/agent-host-manager.ts";
import type { AgentClient } from "./executor/agent-client.ts";
import { startLocalServer, localServerPort, type LocalServers } from "./local-server.ts";

export interface Kernel {
  invoke(method: string, params?: unknown): Promise<unknown>;
  identity: Identity;
  config: KernelConfig;
  localPort: number;
  pipePath: string;
  /** 内部（测试与本进程内模块用）：账本与块存储句柄；UI/加载项不得使用。 */
  db: KernelDb;
  blobs: BlobStore;
  /** 内部（本进程内模块用，如 firm-node 定时任务上链）：签名事件链签名器。 */
  signer: ReturnType<typeof createLedgerSigner>;
  /** 内部（测试用）：Agent 宿主客户端（任务状态/进程句柄）。 */
  agentClient: ReturnType<typeof createLocalAgentClient>;
  onBroadcast(cb: (msg: Record<string, unknown>) => void): void;
  close(): Promise<void>;
}

function hostOf(url: string | undefined | null): string[] {
  if (!url) return [];
  try {
    return [new URL(url).host];
  } catch {
    return [];
  }
}

export async function createKernel(opts: KernelOptions = {}): Promise<Kernel> {
  const config = loadConfig(opts);
  const env = config.env;

  const db = new KernelDb(config.dbFile, { key: config.dbKey });
  db.migrate();
  const identity = resolveIdentity(db, config.firmSlug, config.userSlug);

  // 法规库包（§9：签名只读 SQLite 包；验签/哈希不符即拒绝加载，不静默降级到任何种子）
  if (!config.lawdbSignerPub) {
    throw new DomainError("lawdb_invalid", "未找到内容签名公钥：请先运行 npm run build:lawdb 生成法规库包与签名公钥（或设置 ZR_LAWDB_SIGNER_PUB）", 422);
  }
  const lawdb = openLawdb(config.lawdbFile, { expectedSignerPubPem: config.lawdbSignerPub });

  // 密钥体系引导（§5.3）：律所身份（只存公钥）+ 本机设备证书 + 签名事件链
  const keysDir = keysDirOf(config.workspaceDir);
  const firm = ensureFirmIdentity(db, keysDir, identity.tenantId);
  const device = ensureDevice(db, keysDir, identity, { firmSlug: config.firmSlug, userSlug: config.userSlug });
  const signer = createLedgerSigner({ db, deviceId: device.deviceId, signPrivateKeyPem: device.keys.signPrivateKeyPem, tenantId: identity.tenantId });

  // 材料块按事项密钥加密（§5.1 收尾：hash 按明文寻址、落盘密文、读路径透明解密）
  const blobs = new BlobStore(config.blobDir, createBlobCipher({ db, deviceId: device.deviceId, encPrivateKeyPem: device.keys.encPrivateKeyPem }));

  // 法规库加载留痕（§6.4 审计只记元数据：版本与签名状态，不记正文）
  {
    const st = lawdb.status();
    db.tx(() => {
      const r = db.run(`INSERT INTO audit_events (tenant_id, actor_id, action, object_kind, object_id, detail_hash) VALUES (?,?,?,?,?,?)`, [
        identity.tenantId,
        identity.userId,
        "lawdb.load",
        "lawdb",
        st.package_version,
        null,
      ]);
      const row = db.get<Record<string, unknown>>(`SELECT * FROM audit_events WHERE audit_event_id = ?`, [Number(r.lastInsertRowid)]);
      signer.append({ kind: "audit_event", refId: String(r.lastInsertRowid), matterId: null, type: "lawdb.load", payloadHash: rowPayloadHash(row ?? {}) });
    });
  }

  const store = {
    run: (sql: string, params: unknown[]) => void db.run(sql, params),
    all: <T,>(sql: string, params: unknown[]) => db.all<T>(sql, params),
    tx: <T,>(fn: () => T): T => db.tx(fn),
    // 去向记录落库后同事务上链（§5.2/§6.4）
    onRecord: (rec: { recordId: string; matterId: string; payloadHash: string }) =>
      signer.append({ kind: "egress_record", refId: rec.recordId, matterId: rec.matterId, type: "egress.record", payloadHash: rec.payloadHash }),
  };

  // 出站白名单（§8.3：按主机分列；清单与「连接」页、合规材料包同源）
  const byokBase = env.ZR_BYOK_BASE ?? env.ZR_MOONSHOT_BASE ?? "https://api.moonshot.cn";
  const allowedHosts: Record<DestinationKind, readonly string[]> = {
    maas_model: hostOf(env.ZR_MAAS_BASE),
    byok_model: hostOf(byokBase),
    private_model: hostOf(env.ZR_PRIVATE_BASE),
    moonshot_verify: hostOf(env.ZR_MOONSHOT_VERIFY_BASE ?? "https://api.moonshot.cn"),
    law_source: hostOf(env.ZR_LAW_SOURCE_BASE),
    timestamp: hostOf(env.ZR_TIMESTAMP_BASE),
    content_update: hostOf(env.ZR_CONTENT_CDN_BASE),
    support_upload: hostOf(env.ZR_SUPPORT_BASE),
    im_inbound: [], // 律所自有 IM 路径（非白名单主机语义；仅作数据去向记录类别）
    im_outbound: [],
    mock_local: [],
  };
  const egress = new EgressGate(store, {
    allowedHosts,
    pseudonymPolicy: (env.ZR_PSEUDONYM_POLICY ?? "block") as "block" | "replace",
  });

  const broker = new ModelBroker(store, egress, env);
  const queue = new TaskQueue(db, { concurrency: Number(env.ZR_KERNEL_CONCURRENCY ?? 2) });
  const ioMutex = new AsyncMutex(); // §4.5：Agent 宿主与 OCR 批次共享一把互斥锁
  const localStats = { rejectedPathRequests: 0, rejectedPaths: [] as string[], rejectedToolCalls: 0 }; // 探针 2：管道非白名单请求/工具调用取证

  // 急停撤销集（§15.2 runs.cancel：立即撤销任务令牌 → 工具端点与模型代理立即拒绝）
  const revokedRids = new Set<string>(
    db.all<{ run_id: string }>(`SELECT run_id FROM runs WHERE status = 'cancelled'`, []).map((r) => r.run_id),
  );
  const isRevoked = (rid: string | undefined): boolean => !!rid && revokedRids.has(rid);
  const revokeRun = (rid: string) => revokedRids.add(rid);

  // Agent 宿主（每任务一进程；宿主与内核只经命名管道通信，§4.2 网络层）
  const pipePath = defaultPipePath(config);
  let defaultEntry = "apps/agent-host/src/host.ts";
  try {
    defaultEntry = fileURLToPath(new URL("../../../apps/agent-host/src/host.ts", import.meta.url));
  } catch {
    // CJS 制品（Electron）下 import.meta.url 为空：由 ZR_AGENT_HOST_ENTRY 指定打包宿主
  }
  const agentClient = createLocalAgentClient({
    entryPath: env.ZR_AGENT_HOST_ENTRY ?? defaultEntry,
    pipePath,
    workspaceRoot: join(config.workspaceDir, "agent-tasks"),
    runtime: env.KWL_AGENT_HOST_NODE ?? ((process as any).versions?.electron ? "node" : process.execPath),
    ioMutex, // §4.5：Agent 宿主与 OCR 互斥排队（8GB 笔记本内存预算）
    agentProfile: { file: config.agentProfileFile, signerPub: config.lawdbSignerPub }, // §4.3：同一内容签名公钥验签
  });
  queue.register("legalRun", createLegalWorkflow({ db, blobs, broker, agentClient, lawdb, signer }));

  const ocrModelPaths = {
    det: join(config.ocrModelDir, "ch_PP-OCRv5_det_mobile.onnx"),
    rec: join(config.ocrModelDir, "ch_PP-OCRv5_rec_mobile.onnx"),
    dict: join(config.ocrModelDir, "ppocrv5_dict.txt"),
  };
  const keyctx = { signer, device, firm, keysDir };
  const api = createApi({
    db,
    blobs,
    broker,
    egress,
    queue,
    config,
    lawdb,
    keyctx,
    ioMutex,
    ocrModelPaths,
    parseMock: env.ZR_PARSE_OCR_MOCK === "1",
    localStats,
    revokeRun,
  });

  const listeners = new Set<(msg: Record<string, unknown>) => void>();
  const broadcast = (msg: Record<string, unknown>) => {
    for (const cb of listeners) {
      try {
        cb(msg);
      } catch {
        // 忽略监听器异常
      }
    }
  };
  queue.setOnSettle((runId) => broadcast({ type: "run.settled", run_id: runId }));

  const recovered = queue.recover();
  if (recovered > 0) console.warn(`[kernel] 恢复 ${recovered} 个中断任务（从最后检查点继续）`);

  // 每日链头检查点（§6.4）：启动时链非空且无当日检查点则补一个；之后每 24h（链头未变自动跳过）
  const checkpointDaily = (): void => {
    try {
      signer.checkpoint("daily");
    } catch (e) {
      console.warn(`[kernel] 每日检查点失败：${(e as Error)?.message ?? e}`);
    }
  };
  const today = new Date().toISOString().slice(0, 10);
  const hasEvents = db.get(`SELECT 1 AS x FROM signed_events LIMIT 1`, []);
  const hasTodayCheckpoint = db.get(`SELECT 1 AS x FROM chain_checkpoints WHERE kind = 'daily' AND created_at >= ? LIMIT 1`, [`${today}T00:00:00.000Z`]);
  if (hasEvents && !hasTodayCheckpoint) checkpointDaily();
  const dailyTimer = setInterval(checkpointDaily, 24 * 3600 * 1000);
  dailyTimer.unref();

  // 共享文件夹同步定时器（ZR_SYNC_SHARE_DIR 配置后启用；audit 只记异常、不记每次成功，避免事件膨胀）
  let syncTimer: ReturnType<typeof setInterval> | null = null;
  let lastSyncTickError = "";
  if (config.syncShareDir) {
    const shareDir = config.syncShareDir;
    const intervalMs = Math.max(5_000, Number(env.ZR_SYNC_INTERVAL_MS ?? 30_000));
    syncTimer = setInterval(() => {
      try {
        syncExport({ db, blobs, keyctx, tenantId: identity.tenantId }, { shareDir });
        syncImport({ db, blobs, keyctx, tenantId: identity.tenantId }, { shareDir });
        lastSyncTickError = "";
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        if (msg !== lastSyncTickError) {
          lastSyncTickError = msg;
          console.warn(`[kernel] 同步定时器异常：${msg}`);
          try {
            db.tx(() => {
              const r = db.run(`INSERT INTO audit_events (tenant_id, actor_id, action, object_kind, object_id, detail_hash) VALUES (?,?,?,?,?,?)`, [
                identity.tenantId,
                identity.userId,
                "sync.tick_error",
                "tenant",
                identity.tenantId,
                msg.slice(0, 200),
              ]);
              const row = db.get<Record<string, unknown>>(`SELECT * FROM audit_events WHERE audit_event_id = ?`, [Number(r.lastInsertRowid)]);
              signer.append({ kind: "audit_event", refId: String(r.lastInsertRowid), matterId: null, type: "sync.tick_error", payloadHash: rowPayloadHash(row ?? {}) });
            });
          } catch {
            // 记账失败只告警
          }
        }
      }
    }, intervalMs);
    syncTimer.unref();
  }

  // 本机端点：回环 TCP（开发/桥接；ZR_KERNEL_TCP=off 关闭以验证纯管道模式）+ 命名管道（Agent 宿主通道）
  const tcpOff = env.ZR_KERNEL_TCP === "off";
  const servers: LocalServers = await startLocalServer(
    { db, blobs, broker, lawdb, secret: requireSecret("ZR_INTERNAL_SECRET"), isRevoked, stats: localStats, mcpToolsAllowlist: LEGAL_MCP_TOOLS },
    { port: tcpOff ? -1 : Number(env.ZR_KERNEL_LOCAL_PORT ?? 0), pipePath },
  );
  const localPort = localServerPort(servers.tcp);

  return {
    identity,
    config,
    localPort,
    pipePath,
    db,
    blobs,
    agentClient,
    signer,
    async invoke(method: string, params: unknown = {}): Promise<unknown> {
      const handler = api[method];
      if (!handler) throw new DomainError("not_found", `未知内核方法 ${method}`, 404);
      return handler(params, identity);
    },
    onBroadcast(cb) {
      listeners.add(cb);
    },
    async close() {
      clearInterval(dailyTimer);
      if (syncTimer) clearInterval(syncTimer);
      await queue.shutdown();
      for (const s of [servers.tcp, servers.pipe]) {
        if (s) await new Promise<void>((r) => s.close(() => r()));
      }
      lawdb.close();
      db.close();
    },
  };
}

export * from "./config.ts";
export { KernelDb } from "./db.ts";
export { BlobStore } from "./blobs.ts";
export { TaskQueue } from "./queue.ts";
export * from "./devices.ts";
export * from "./ledger-signer.ts";
export { EgressGate } from "@zr-legal/egress";
export { ModelBroker } from "@zr-legal/model-broker";
