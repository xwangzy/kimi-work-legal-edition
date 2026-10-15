/**
 * 本机法律内核（方案 v5.0 第 4 篇 §1：律所侧单一内核——桌面内嵌 / 所内节点无界面同一代码）。
 *
 * 组装：加密 SQLite 事项账本（页级加密已接线：主密钥经 safeStorage 解封一次性交付，§5.1）+
 * 本地持久任务队列 + 签名事件 hash 链（§5.2/§6.4）+ 密钥体系（§5.3：律所根密钥/设备证书/
 * 事项密钥分发/恢复托管分持）+ 法律工具（内核内模块）+ 本机模型代理 + 出站闸门 +
 * 内核 API（§15.2）+ 本机端点（MCP / OpenAI 兼容，供 Agent 宿主）。
 */
import { excludeFromContentIndex } from "./services/not-indexed.ts";
import { purgeWsKeys } from "./ws-keys.ts";
import { zoneKeysFor } from "./ws-keys.ts";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { EgressGate, type DestinationKind } from "@zr-legal/egress";
import { ModelBroker } from "@zr-legal/model-broker";
import { DomainError, LEGAL_MCP_TOOLS } from "@zr-legal/domain";
import { loadConfig, defaultGatePath, defaultPipePath, type KernelConfig, type KernelOptions } from "./config.ts";
import { KernelDb } from "./db.ts";
import { BlobStore } from "./blobs.ts";
import { TaskQueue } from "./queue.ts";
import { createApi } from "./api/index.ts";
import { resolveIdentity, taskTokenKey, type Identity } from "./identity.ts";
import { applyStagedRecovery, configureSecretSealing, ensureFirmIdentity, ensureDevice, getFirmRootPrivateKey, keysDirOf } from "./devices.ts";
import { FirmGovernance, localDevPolicyBody, firmPolicyInputOf, type FirmPolicyInput } from "./control-plane/governance.ts";
import { ControlPlaneClient } from "./control-plane/client.ts";
import { parsePublicKeyMap } from "@zr-legal/firm-trust";
import { appendAuditEvent, createLedgerSigner, rowPayloadHash } from "./ledger-signer.ts";
import { AsyncMutex, Semaphore } from "./mutex.ts";
import { materializeSkillsBundle } from "./skills-bundle.ts";
import { ContentUpdater, LawdbHolder, contentKeyTable, contentKeysFromEnv, markProblem, selectLawdb, selectSkills } from "./services/content-updates.ts";
import { totalmem } from "node:os";
import { createBlobCipher } from "./blob-cipher.ts";
import { syncExport, syncImport } from "./sync-engine.ts";
import { createLegalWorkflow, expireOrphanedAgentWaits } from "./executor/executor.ts";
import { createKapAgentClient, type KapAgentClient, type KapMatterPolicy } from "./executor/kap-agent-client.ts";
import type { AgentClient } from "./executor/agent-client.ts";
import { startLocalServer, localServerPort, type LocalServers } from "./local-server.ts";
import { legalToolManifests, setLegalToolLock } from "./tools/registry.ts";
import { MatterTokenStore } from "./egress/matter-tokens.ts";
import { createHash, randomUUID } from "node:crypto";
import { KernelGate } from "./egress/kernel-gate.ts";
import { basisCompleteOf, dataLevelOf } from "./egress/gate-host.ts";
import { EgressApprovalStore } from "./services/egress-approvals.ts";
import { screenSearchQuery } from "@zr-legal/egress-gate";
import { createGateProvider, mockProvider } from "@zr-legal/model-broker";
import { QaChatService } from "./services/qa-chat.ts";
import { ReminderService } from "./services/reminders.ts";
import { mintTaskToken } from "./identity.ts";
import { FileSink, errFields, loadOrCreateSalt, slog } from "@zr-legal/safe-log";

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
  /** 内部（测试用）：Agent 宿主客户端（kap-host；任务状态与宿主进程号）。 */
  agentClient: KapAgentClient;
  /** 内部（测试用）：任务队列（退出模式下的暂停与恢复，复核 S6-C14）。 */
  queue: TaskQueue;
  /** 内部（测试与设备页用）：出站闸门的内核侧（拉起、授权、去向记录）。 */
  gate: KernelGate;
  /** 撤权擦除（审计 S3 1-4）：清理本机律师已不是成员的事项的 Agent 数据与工作区密钥；返回处理的事项。同步后与启动时自动执行。 */
  purgeRevokedAgentData(): Promise<string[]>;
  onBroadcast(cb: (msg: Record<string, unknown>) => void): void;
  close(): Promise<void>;
}

export async function createKernel(opts: KernelOptions = {}): Promise<Kernel> {
  const config = loadConfig(opts);
  const env = config.env;
  // 统一脱敏日志（v9.2 §3.6）：内核单写数据根下 logs/；记录编号按本机盐 hash（盐与日志分开存放）
  const logSink = new FileSink({ dir: join(config.workspaceDir, "logs"), salt: loadOrCreateSalt(join(config.workspaceDir, ".log-salt")) });
  slog.setSink(logSink);

  const db = new KernelDb(config.dbFile, { key: config.dbKey });
  db.migrate();
  const identity = resolveIdentity(db, config.firmSlug, config.userSlug);

  // 法规库包（§9：签名只读 SQLite 包；验签/哈希不符即拒绝加载，不静默降级到任何种子）
  if (!config.lawdbSignerPub) {
    throw new DomainError("lawdb_invalid", "未找到内容签名公钥：请先运行 npm run build:lawdb 生成法规库包与签名公钥（或设置 ZR_LAWDB_SIGNER_PUB）", 422);
  }
  // 内容签名公钥表（随包公钥 + release.json 的 content_keys；kid 由公钥算出）与分发通道（第 8 批 S6/S7）
  const contentKeys = contentKeyTable([config.lawdbSignerPub, ...contentKeysFromEnv(env.ZR_CONTENT_KEYS)], contentKeysFromEnv(env.ZR_CONTENT_KEYS_REVOKED));
  const distChannel = env.ZR_DIST_CHANNEL === "beta" ? "beta" : "stable";
  // 选用法规库：在线已装（账本登记、seq 高于随包）且本机核验通过才用，否则随包（只核验一次，返回已打开实例）；之后在线更新经 LawdbHolder 换用
  const lawdbChoice = selectLawdb({ db, workspaceDir: config.workspaceDir, channel: distChannel, keys: contentKeys, bundledFile: config.lawdbFile, bundledReleaseFile: join(dirname(config.lawdbFile), "lawdb.release.json") });
  const lawdbHolder = new LawdbHolder(lawdbChoice.lawdb);
  const lawdb = lawdbHolder.proxy;

  // 密钥体系引导（§5.3）：律所身份（只存公钥）+ 本机设备证书 + 签名事件链
  const keysDir = keysDirOf(config.workspaceDir);
  // 方法模板包（核查 P0-5）：用法规库同一把内容签名公钥验签，物化为只读可信区
  const skillsChoice = selectSkills({
    db,
    workspaceDir: config.workspaceDir,
    channel: distChannel,
    keys: contentKeys,
    bundledManifest: config.skillsManifestFile,
    bundledReleaseFile: config.skillsManifestFile ? join(dirname(config.skillsManifestFile), "skills.release.json") : null,
  });
  let skillsBundle = materializeSkillsBundle(skillsChoice.active?.file ?? null, contentKeys, config.workspaceDir);
  // 在线已装的方法模板物化失败（选用之后被改动、磁盘满）：标记问题、回到随包（复核 S8A-08）
  if (!skillsBundle.ok && skillsChoice.active?.source === "installed") {
    markProblem(db, "skills", distChannel, skillsChoice.active.seq, "物化失败");
    skillsChoice.active = skillsChoice.bundled;
    skillsBundle = materializeSkillsBundle(skillsChoice.bundled?.file ?? null, contentKeys, config.workspaceDir);
  }
  if (!skillsBundle.ok) slog.event("KERNEL_SKILLS_UNAVAILABLE", {});
  // 密钥文件按数据库主密钥派生的密钥封装（隐私安全审查 P0-1）；开发与测试形态无主密钥时为明文
  configureSecretSealing(keysDir, config.dbKey);
  const firm = ensureFirmIdentity(db, keysDir, identity.tenantId);
  // 暂存的设备恢复在任何组件装载设备密钥之前生效（复核 B4-R09）
  const recovery = applyStagedRecovery(db, keysDir, { firmSlug: config.firmSlug, userSlug: config.userSlug }, firm.rootPublicKeyPem);
  if (recovery.rejected) slog.event("KERNEL_RECOVERY_REJECTED", {});
  const device = ensureDevice(db, keysDir, identity, { firmSlug: config.firmSlug, userSlug: config.userSlug });
  const signer = createLedgerSigner({ db, deviceId: device.deviceId, signer: device.signer, tenantId: identity.tenantId });
  if (recovery.applied || recovery.rejected) {
    // 恢复生效或被拒：记审计（只记结果与计数）
    const action = recovery.applied ? "recovery.applied" : "recovery.rejected";
    const detail = createHash("sha256").update(JSON.stringify({ rewrapped: recovery.rewrapped, unreadable: recovery.unreadable, rejected: recovery.rejected ?? null })).digest("hex");
    db.tx(() => {
      const r = db.run(`INSERT INTO audit_events (tenant_id, actor_id, action, object_kind, object_id, detail_hash) VALUES (?,?,?,?,?,?)`, [identity.tenantId, identity.userId, action, "device", device.deviceId, detail]);
      const row = db.get<Record<string, unknown>>(`SELECT * FROM audit_events WHERE audit_event_id = ?`, [Number(r.lastInsertRowid)]);
      signer.append({ kind: "audit_event", refId: String(r.lastInsertRowid), matterId: null, type: action, payloadHash: rowPayloadHash(row ?? {}) });
    });
  }

  // 律所治理（v9 阶段 6：控制面最小集的本机一侧）。控制面地址与控制面公钥随客户端构建固定（G0 开发形态经本机配置给出）；
  // 未配置控制面 = 开发形态：律所策略沿用本机配置项（D-17），不检查许可
  const governance = new FirmGovernance({
    db,
    tenantId: identity.tenantId,
    userId: identity.userId,
    deviceId: device.deviceId,
    rootPublicKeyPem: firm.rootPublicKeyPem,
    signer,
    env,
    controlPlaneBase: env.ZR_CONTROL_PLANE_BASE || null,
    cpKeys: parsePublicKeyMap(env.ZR_CONTROL_PLANE_KEYS),
    seatKeys: parsePublicKeyMap(env.ZR_SEAT_KEYS),
  });
  /** 生效的律所策略（每次读取：控制面下发、过期回退与签名人吊销即时生效）。 */
  const firmPolicy = (): FirmPolicyInput => firmPolicyInputOf(governance.effectivePolicy().body);

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

  // 内核本身不发起任何外连（v9 第 04 篇 §1.2 第 3 条：模型、检索、抓取一律经出站闸门进程；上游地址与凭据只经 IPC 到闸门）。
  // v5 进程内闸门库只保留事项策略裁决、mock 链路与 IM 收发的去向记录：主机白名单一律为空（任何直连都会被拒绝）
  const allowedHosts: Record<DestinationKind, readonly string[]> = {
    maas_model: [],
    byok_model: [],
    private_model: [],
    moonshot_verify: [],
    law_source: [],
    timestamp: [],
    content_update: [],
    support_upload: [],
    im_inbound: [],
    im_outbound: [],
    mock_local: [],
  };
  const egress = new EgressGate(store, {
    allowedHosts,
    pseudonymPolicy: (env.ZR_PSEUDONYM_POLICY ?? "block") as "block" | "replace",
  });

  // 工具清单锁文件（审查 R-08）：验签失败或缺失 → 法律工具一律不暴露（失败关闭）
  setLegalToolLock(config.toolManifestFile, config.lawdbSignerPub);

  // 令牌化工作区（v9 第 02 篇 §8.3–§8.4）：事项令牌密钥与令牌表在本机事项账本
  const tokens = new MatterTokenStore(db);

  // 出站闸门（v9 第 04 篇 §1.1、§5.1：独立进程、唯一出口；按需拉起）。模型代理与 Agent 宿主的模型、检索、抓取都只经闸门
  let gateEntry = "packages/egress-gate/src/main.ts";
  try {
    gateEntry = fileURLToPath(new URL("../../egress-gate/src/main.ts", import.meta.url));
  } catch {
    // CJS 制品：由 ZR_EGRESS_GATE_ENTRY 指定（产品形态为独立签名二进制）
  }
  // 撤销集在闸门授权里使用（声明在前，下面填充）
  const revokedRids = new Set<string>(
    db.all<{ run_id: string }>(`SELECT run_id FROM runs WHERE status = 'cancelled'`, []).map((r) => r.run_id),
  );
  const revokedJtis = new Set<string>();
  let resolveRouteForGate: (alias: string) => ReturnType<ModelBroker["resolveRoute"]> | null = () => null;
  // 出站批准凭据（W1，收敛偏离 D-16）：本机设备签名密钥签发，闸门按设备公钥独立核验
  const approvals = new EgressApprovalStore(db, { deviceId: device.deviceId, signer: device.signer });
  const gate = new KernelGate({
    db,
    env,
    socketPath: defaultGatePath(config),
    entryPath: env.ZR_EGRESS_GATE_ENTRY ?? gateEntry,
    ...(env.KWL_GATE_NODE ? { runtime: env.KWL_GATE_NODE } : (process as any).versions?.electron ? { runtime: "node" } : {}),
    ...(env.KWL_GATE_NODE_SHA256 ? { runtimeSha256: env.KWL_GATE_NODE_SHA256 } : {}),
    secret: taskTokenKey(),
    revoked: { rids: revokedRids, jtis: revokedJtis },
    tokens,
    signer,
    resolveRoute: (alias) => resolveRouteForGate(alias),
    approvals,
    // 自动档开始时的预授权（经事项策略钳制）：泛化后的检索；图像原样送模型不能预授权（逐次确认）
    preauth: (rid) => ({ searchGeneralized: runOptionsOf(db, rid, firmPolicy()).preauthorized.includes("search_generalized"), images: false }),
    governance,
  });
  // 控制面客户端（只在配置了控制面时）：请求经闸门代发，内核本身不联网
  const controlPlane =
    governance.mode === "control_plane"
      ? new ControlPlaneClient({
          gov: governance,
          relay: (req) => gate.cp(req),
          tenantId: identity.tenantId,
          device: { deviceId: device.deviceId, cert: device.cert, signer: device.signer },
          // G0 开发形态：创始工作区持律所根私钥（devices.ts 文件头声明）；开通时登记根公钥用
          firmRoot: () => {
            try {
              const r = getFirmRootPrivateKey(keysDir);
              return { publicKeyPem: r.publicKeyPem, privateKeyPem: r.privateKeyPem };
            } catch {
              return null;
            }
          },
          // 退出模式下启动时暂停的任务：退出模式解除后（同步取得许可）入队（复核 S6-B34）
          onSynced: () => {
            if (governance.exitMode()) return;
            const n = queue.resumeParked();
            if (n > 0) slog.event("KERNEL_EXIT_MODE_LIFTED", { resumed: n });
          },
        })
      : null;
  /** 确定性工作流经闸门的任务令牌：绑定当前执行中的尝试与纪元（尝试已结束 → 令牌不绑定纪元 → 闸门拒绝）。 */
  const gateTokenFor = (task: { tid: string; uid: string; mid: string; rid?: string | undefined; aid?: string | undefined }): string => {
    const a = task.rid && task.aid ? db.get<{ fence_token: number }>(`SELECT fence_token FROM attempts WHERE attempt_id = ? AND run_id = ? AND status = 'running'`, [task.aid, task.rid]) : undefined;
    return mintTaskToken(
      { tid: task.tid, uid: task.uid, mid: task.mid, ...(task.rid ? { rid: task.rid } : {}), ...(task.aid ? { aid: task.aid } : {}), ...(a ? { fen: a.fence_token } : {}), scope: ["model:chat"] },
      600,
    );
  };
  const broker = new ModelBroker(store, egress, env, { gate: { socket: async () => (await gate.ensure()).socketPath, token: gateTokenFor } });
  resolveRouteForGate = (alias) => {
    try {
      return broker.resolveRoute(alias);
    } catch {
      return null;
    }
  };
  const queue = new TaskQueue(db, { concurrency: Number(env.ZR_KERNEL_CONCURRENCY ?? 2) });
  const ioMutex = new AsyncMutex(); // §4.5：材料解析与 OCR 批次排队（8 GB 笔记本内存预算；Agent 运行另有独立槽位）
  const localStats = { rejectedPathRequests: 0, rejectedPaths: [] as string[], rejectedToolCalls: 0 }; // 探针 2：管道非白名单请求/工具调用取证

  // 急停撤销集（§15.2 runs.cancel：立即撤销任务令牌 → 工具端点与模型代理立即拒绝）
  // 令牌撤销（v9 第 04 篇 §8；阶段 1 审查 R-01/R-06）：
  // - 取消的任务按 rid 撤销（用户急停即时生效）；宿主退出、超时、取消按 jti（Agent 任务 ID）撤销；
  // - 此外端点每次调用都按 attempts 行复核“尝试仍在执行且纪元一致”——任何终态、被新尝试取代、重启中断都使令牌立即失效，
  //   不依赖内存撤销集（重启后内存集为空也不影响）。
  // 撤销即中止在途请求（复审 N-01）：本机端点启动后接上 sweepNow；之前的撤销由 200 ms 周期复核兜底；闸门在途请求同时中止
  let sweepInflight: () => void = () => {};
  const revokeRun = (rid: string) => {
    revokedRids.add(rid);
    sweepInflight();
    gate.revoke(rid);
  };
  const revokeToken = (jti: string) => {
    revokedJtis.add(jti);
    sweepInflight();
  };

  // 内核本机端点的命名管道（法律 MCP 与模型代理；Agent 宿主只经它与内核的 IPC 通信，§4.2 网络层）
  const pipePath = defaultPipePath(config);
  const broadcastRef: { current: ((msg: Record<string, unknown>) => void) | null } = { current: null };
  // v9：开放任务由 kap-host（Kimi Code kap-server 私有嵌入）承载——唯一引擎（K9-1：v5 SDK 宿主已退役，ZR_AGENT_ENGINE 不再有效）
  let kapEntry = "packages/kap-host/src/main.ts";
  try {
    kapEntry = fileURLToPath(new URL("../../kap-host/src/main.ts", import.meta.url));
  } catch {
    // CJS 制品：由 ZR_KAP_HOST_ENTRY 指定
  }
  // K9-1：v5 SDK 宿主曾把材料快照以明文写进 <工作区>/agent-tasks（只在开发形态出现过）——退役后启动即删除遗留目录
  // 删除失败（文件被占用等）不阻断启动：下次启动再删（复核 S7A-01）
  try {
    rmSync(join(config.workspaceDir, "agent-tasks"), { recursive: true, force: true });
  } catch {
    // 下次启动重试
  }
  // 数据根不进 Windows 搜索的内容索引（Y5 P1-7）：后台进行，不阻塞启动
  void excludeFromContentIndex(config.workspaceDir).then((outcome) => slog.event("KERNEL_INDEX_EXCLUDE", { outcome }));
  slog.event("KERNEL_STARTED", {
    engine: "kap",
    at_rest: env.ZR_AT_REST === "required" ? "required" : env.ZR_AT_REST === "off" ? "off" : "on",
    control_plane: env.ZR_CONTROL_PLANE_BASE ? "configured" : "dev",
  });
  const kapAgentClient = createKapAgentClient({
    entryPath: env.ZR_KAP_HOST_ENTRY ?? kapEntry,
    dataRoot: join(config.workspaceDir, "kap"),
    kernelSocket: pipePath,
    gate: { socket: async () => (await gate.ensure()).socketPath, routes: gate.routes() },
    // Grep/Glob 由 kap-host 宿主内检索完成（审计 S3 第 2 步：工作区是密文，不再使用原生 rg）；字段只为兼容旧宿主
    trustedRgPath: null,
    // 方法模板（Kimi Code Skills）：验签物化后的可信区；校验失败即不加载任何技能（不降级加载部分）
    trustedDir: skillsBundle.ok ? skillsBundle.dir : null,
    // 只供测试（上下文压缩验收 K7-3）：ZR_KAP_TEST_CONTEXT 缩小引擎上下文窗口；安装包形态（落盘加密 required、控制面必需）不传
    ...(env.ZR_KAP_TEST_CONTEXT && env.ZR_AT_REST !== "required" && env.ZR_REQUIRE_CONTROL_PLANE !== "1" ? { testMaxContextSize: Number(env.ZR_KAP_TEST_CONTEXT) } : {}),
    // 安装包形态：主进程按随包运行时清单给出（apps/desktop/electron/runtime-paths.cjs）
    ...(env.KWL_W_RUNTIME_DIR || env.KWL_RUNTIME_NODE_SHA256 || env.KWL_RUNTIME_NODE_VERSION
      ? {
          wRuntime: {
            ...(env.KWL_W_RUNTIME_DIR ? { dir: env.KWL_W_RUNTIME_DIR } : {}),
            ...(env.KWL_RUNTIME_NODE_SHA256 ? { nodeSha256: env.KWL_RUNTIME_NODE_SHA256 } : {}),
            ...(env.KWL_RUNTIME_NODE_VERSION ? { nodeVersion: env.KWL_RUNTIME_NODE_VERSION } : {}),
          },
        }
      : {}),
    manifests: () => legalToolManifests().list(),
    legalMcpTools: [...LEGAL_MCP_TOOLS],
    // 落盘加密（审计 S3 第 1 步）：每次运行下发本事项的区密钥；安装包形态（ZR_AT_REST=required）宿主缺密钥即拒绝运行
    // ZR_AT_REST=off 只供开发对照（安装包形态由主进程固定为 required，环境变量不可覆盖）
    ...(env.ZR_AT_REST === "off" && env.ZR_REQUIRE_CONTROL_PLANE !== "1"
      ? {}
      : {
          atRest: {
            mode: env.ZR_AT_REST === "required" ? ("required" as const) : ("optional" as const),
            keys: (mid: string) => zoneKeysFor({ db, deviceId: device.deviceId, encPublicKeyPem: device.keys.encPublicKeyPem, encPrivateKeyPem: device.keys.encPrivateKeyPem }, mid),
          },
        }),
    matterPolicy: (mid) => kapMatterPolicy(db, mid, firmPolicy()),
    // 不与材料导入/OCR 共用 ioMutex（核查 P0-3）：独立的运行槽位，≤ 8 GB 设备 1 个、其余 2 个（每事项另限 1 个）
    ioMutex: new Semaphore(Number(env.ZR_KAP_CONCURRENCY ?? (totalmem() <= 8 * 1024 ** 3 ? 1 : 2))),
    revokeToken,
    // Electron 内核（utilityProcess）里 process.execPath 是 Electron：宿主用随包/系统 Node（与 SDK 宿主同一口径）
    ...(env.KWL_AGENT_HOST_NODE ? {} : (process as any).versions?.electron ? { runtime: "node" } : {}),
    // W1：运行模式与先出计划（界面请求经事项策略钳制）、检索式预筛、等待律师的状态
    runOptions: (rid) => runOptionsOf(db, rid, firmPolicy()),
    screenSearch: ({ runId, matterId, query }) => {
      const run = db.get<{ matter_id: string }>(`SELECT matter_id FROM runs WHERE run_id = ?`, [runId]);
      if (!run || run.matter_id !== matterId) throw new Error("运行与事项不符");
      const pol = kapMatterPolicy(db, matterId, firmPolicy());
      const v = screenSearchQuery(query, { dataLevel: pol.dataLevel, basisComplete: pol.basisComplete, preauthorizedGeneralize: false, tokenizer: tokens.tokenizer(matterId) });
      return { needsConfirmation: v.decision === "deny" && (v.reason === "search_entity_requires_confirmation" || v.reason === "search_l3a_each_query") };
    },
    onWaiting: (rid, kind) => {
      setWaiting(db, rid, kind);
      broadcastRef.current?.({ type: "run.updated", run_id: rid, waiting: kind });
    },
    ...(env.KWL_AGENT_HOST_NODE ? { runtime: env.KWL_AGENT_HOST_NODE } : {}),
  });
  const agentClient = kapAgentClient;
  // A1 工作时限（不含等待律师的时间；W1）：缺省 10 分钟，本机配置可调
  const workLimit = Number(env.ZR_AGENT_WORK_LIMIT_MS);
  const agentWorkLimitMs = Number.isFinite(workLimit) && workLimit >= 1000 ? workLimit : undefined;
  // 总时长上限（含等待律师）：缺省 8 小时，本机配置可调（测试与律所策略）
  const wall = Number(env.ZR_AGENT_WALL_MS);
  const agentWallMs = Number.isFinite(wall) && wall >= 2000 ? wall : undefined;
  const workflowDeps = { db, blobs, broker, agentClient, lawdb, signer, tokens, agentWorkLimitMs, agentWallMs };
  queue.register("legalRun", createLegalWorkflow(workflowDeps));

  const ocrModelPaths = {
    det: join(config.ocrModelDir, "ch_PP-OCRv5_det_mobile.onnx"),
    rec: join(config.ocrModelDir, "ch_PP-OCRv5_rec_mobile.onnx"),
    dict: join(config.ocrModelDir, "ppocrv5_dict.txt"),
  };
  const keyctx = { signer, device, firm, keysDir };
  // 无事项问答（第 04 篇 §5.3；W1）：当事人词典检查在本机；问题经出站闸门的问答路由（/q/<会话>）发往网关，不带事项编号；
  // 离线 mock 提供方时在本机模拟（不出站）
  const qaGate = createGateProvider({
    socket: async () => (await gate.ensure()).socketPath,
    token: (task) => mintTaskToken({ tid: task.tid, uid: task.uid, mid: "qa", ...(task.rid ? { rid: task.rid } : {}), jti: `qa_${randomUUID()}`, scope: ["qa:chat"] }, 300),
  });
  const qa = new QaChatService({
    db,
    tokens,
    ask: async (input) => {
      const route = broker.resolveRoute(env.ZR_QA_ROUTE ?? "legal/k3");
      const req = { model: route.alias, messages: input.messages };
      if (route.provider === "mock") return (await mockProvider.chat(route, req)).content ?? "";
      const meta = { nonce: randomUUID(), clientIdempotencyId: `qa_${randomUUID()}`, task: { tid: input.tenantId, uid: input.userId, mid: "qa", rid: input.conversationId }, routePrefix: `/q/${encodeURIComponent(input.conversationId)}` };
      return (await qaGate.chat(route, req, meta)).content ?? "";
    },
  });

  /** 清理一个事项的本机 Agent 数据（关闭引擎、删除会话、事件日志、工作区与材料快照），再删除本机的事项工作区密钥。有进行中任务时抛错。 */
  const purgeAgentDataFor = async (matterId: string): Promise<void> => {
    await kapAgentClient.purgeMatter(matterId);
    purgeWsKeys(db, matterId);
  };

  // 在线内容更新（第 8 批 S6/S7）：经闸门分发通道取签名清单与包；未配置分发地址即不检查
  const contentUpdater = new ContentUpdater({
    db,
    workspaceDir: config.workspaceDir,
    channel: distChannel,
    keys: contentKeys,
    deviceId: device.deviceId,
    fetch: (path) => gate.dist(path),
    configured: () => gate.distConfigured,
    suspended: () => governance.exitMode() !== null,
    busy: () => {
      const st = queue.stats();
      return st.running + st.pending > 0;
    },
    bundledStamped: { lawdb: lawdbChoice.bundledStamped, skills: skillsChoice.bundledStamped },
    lawdb: lawdbHolder,
    active: { lawdb: lawdbChoice.active, skills: skillsChoice.active },
    bundled: { lawdb: lawdbChoice.bundled, skills: skillsChoice.bundled },
    audit: (action, objectId) => appendAuditEvent(db, signer, { tenantId: identity.tenantId, actorId: identity.userId, action, kind: "content", objectId, matterId: null }),
  });
  // 定时检查：启动 2～12 分钟内随机一次（复核 S8A-19），之后每天；ZR_CONTENT_CHECK_MS=off 只在“检查更新”时检查（测试）
  let contentTimer: NodeJS.Timeout | null = null;
  let contentFirst: NodeJS.Timeout | null = null;
  if (gate.distConfigured && env.ZR_CONTENT_CHECK_MS !== "off") {
    const every = Math.min(Math.max(Number(env.ZR_CONTENT_CHECK_MS ?? 86_400_000) || 86_400_000, 600_000), 7 * 86_400_000);
    const tick = () => {
      void contentUpdater.check("lawdb").then(() => contentUpdater.check("skills"));
    };
    contentFirst = setTimeout(tick, ContentUpdater.firstDelayMs());
    contentFirst.unref();
    contentTimer = setInterval(tick, every);
    contentTimer.unref();
  }

  // 期限提醒（第 10 批 S9）：本机到时即提醒；配置了通知服务与控制面时另交中软通知服务调度（只见触发时刻、设备编号与密文）
  const reminders = new ReminderService({
    db,
    tenantId: identity.tenantId,
    userId: identity.userId,
    deviceId: device.deviceId,
    encPrivateKeyPem: device.keys.encPrivateKeyPem,
    signer: device.signer,
    cloudConfigured: () => gate.notifyConfigured && !!controlPlane,
    suspended: () => governance.exitMode() !== null,
    credential: () => {
      if (!controlPlane) return Promise.reject(new Error("control_plane_not_configured"));
      return controlPlane.notifyToken();
    },
    relay: (req) => gate.notify(req),
    onDue: (count) => broadcastRef.current?.({ type: "reminder.due", count }),
    audit: (action, objectId, matterId) => appendAuditEvent(db, signer, { tenantId: identity.tenantId, actorId: identity.userId, action, kind: "reminder", objectId, matterId }),
  });
  // 巡检：缺省每分钟（本机到时 + 云端登记与取回）；ZR_NOTIFY_POLL_MS=off 只在显式调用 reminders.sync 时巡检（测试）
  let reminderTimer: NodeJS.Timeout | null = null;
  if (env.ZR_NOTIFY_POLL_MS !== "off") {
    const every = Math.min(Math.max(Number(env.ZR_NOTIFY_POLL_MS ?? 60_000) || 60_000, 15_000), 600_000);
    reminderTimer = setInterval(() => {
      void reminders.tick().catch((e) => slog.event("KERNEL_REMINDER_TICK_FAILED", errFields(e)));
    }, every);
    reminderTimer.unref();
  }

  const shutdownHooks: (() => void)[] = [];
  const api = createApi({
    purgeAgentData: purgeAgentDataFor,
    onShutdown: (fn) => shutdownHooks.push(fn),
    skills: skillsBundle,
    content: contentUpdater,
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
    // W6：安装包里解析进程用随包 Node 运行（runtime-paths.cjs 给出），不借 Electron 自身 fork
    parseWorker: { execPath: env.KWL_PARSE_NODE || undefined, entry: env.KWL_PARSE_WORKER_ENTRY || undefined },
    localStats,
    revokeRun,
    tokens,
    gate,
    approvals,
    qa,
    kap: kapAgentClient,
    matterPolicy: (mid) => kapMatterPolicy(db, mid, firmPolicy()),
    governance,
    controlPlane,
    reminders,
  });

  // 本设备被吊销（第 02 篇 §9.13；复核 S6-A02、S6-B01）：终止进行中的任务（闸门在退出模式下已拒绝一切出站）；
  // 取消失败的记告警（其本机步骤可能继续运行；复核 S6-B34）
  const cancelOpenRuns = (): void => {
    const failed = (runId: string, e: unknown) =>
      governance.alert("revocation", "run_cancel_failed", runId, `本设备被吊销后未能终止任务 ${runId}（${String((e as Error)?.message ?? e).slice(0, 120)}）：其本机步骤可能继续运行，出站已由闸门拒绝`);
    for (const r of db.all<{ run_id: string; status_version: number }>(
      `SELECT run_id, status_version FROM runs WHERE tenant_id = ? AND status NOT IN ('succeeded','partial','failed','cancelled','expired','timed_out','reconciling')`,
      [identity.tenantId],
    )) {
      try {
        void Promise.resolve(api["runs.cancel"]!({ run_id: r.run_id, expected_version: r.status_version, reason: "本设备已被吊销" }, identity)).catch((e) => failed(r.run_id, e));
      } catch (e) {
        failed(r.run_id, e);
      }
    }
  };
  governance.onSelfRevoked(cancelOpenRuns);

  /**
   * 撤权擦除（审计 S3 1-4；第 02 篇 §9.13“在线设备收到后终止任务并清理缓存”）：本机律师已不是某事项的成员（被移出，经同步收到墓碑）
   * 或本设备被吊销 → 关闭该事项的 Agent 引擎、删除其会话、事件日志、工作区与材料快照，再删除本机的事项工作区密钥（加密擦除）。
   * 有进行中任务的事项跳过、下次再试。启动时、每次同步后与吊销时执行。
   */
  const membershipAlerted = new Set<string>();
  const purgeLocalAgentData = async (all: boolean): Promise<string[]> => {
    // 只凭正向证据擦除（复核 B3-A19）：本人在该事项的成员行已墓碑（removed_at 非空）且没有有效行、事项已结案或删除、或本设备被吊销；
    // “本机根本没有本人的成员行”（同步未到、本机数据重建、换了登录律师）不擦除，只告警——擦除不可逆
    const rows = all
      ? db.all<{ matter_id: string }>(`SELECT DISTINCT matter_id FROM matter_ws_keys WHERE device_id = ?`, [device.deviceId])
      : db.all<{ matter_id: string }>(
          `SELECT DISTINCT k.matter_id FROM matter_ws_keys k
            WHERE k.device_id = ?
              AND ((EXISTS (SELECT 1 FROM matter_members m WHERE m.matter_id = k.matter_id AND m.user_id = ? AND m.removed_at IS NOT NULL)
                    AND NOT EXISTS (SELECT 1 FROM matter_members m WHERE m.matter_id = k.matter_id AND m.user_id = ? AND m.removed_at IS NULL))
                   OR EXISTS (SELECT 1 FROM matters x WHERE x.matter_id = k.matter_id AND x.lifecycle <> 'active'))`,
          [device.deviceId, identity.userId, identity.userId],
        );
    if (!all) {
      for (const { matter_id } of db.all<{ matter_id: string }>(
        `SELECT DISTINCT k.matter_id FROM matter_ws_keys k WHERE k.device_id = ? AND NOT EXISTS (SELECT 1 FROM matter_members m WHERE m.matter_id = k.matter_id AND m.user_id = ?)`,
        [device.deviceId, identity.userId],
      )) {
        if (membershipAlerted.has(matter_id)) continue;
        membershipAlerted.add(matter_id);
        governance.alert("membership", "member_row_missing", matter_id, `本机持有事项 ${matter_id} 的 Agent 工作区，但没有本人的成员记录（不是移出记录）：未擦除，请核对同步状态或登录身份`);
      }
    }
    const done: string[] = [];
    for (const { matter_id } of rows) {
      try {
        // 先终止该事项进行中的任务（复核 B3-A20：被移出或被吊销后不能继续运行、继续写会话与工作区），再擦除；
        // 任务收尾需要片刻，本轮擦除若因“仍在运行”失败，下一次同步或启动时再试
        // 内核自身的终止（不经成员校验：被移出的律师已过不了 runs.cancel 的成员门禁）：标为已取消并立即撤销任务令牌
        for (const r of db.all<{ run_id: string }>(
          `SELECT run_id FROM runs WHERE matter_id = ? AND status NOT IN ('succeeded','partial','failed','cancelled','expired','timed_out','reconciling')`,
          [matter_id],
        )) {
          const why = all ? "本设备已被吊销" : "你已被移出该事项";
          const changed = db.run(
            `UPDATE runs SET status = 'cancelled', cancel_reason = ?, status_version = status_version + 1, updated_at = ?
              WHERE run_id = ? AND status NOT IN ('succeeded','partial','failed','cancelled','expired','timed_out','reconciling')`,
            [why, new Date().toISOString(), r.run_id],
          ).changes;
          revokeRun(r.run_id);
          // 内核自身的终止上签名链（复核 C-A20：不经状态机接口，也要留痕）
          if (changed > 0) {
            appendAuditEvent(db, keyctx.signer, { tenantId: identity.tenantId, actorId: identity.userId, action: "run.cancelled_by_kernel", kind: "run", objectId: r.run_id, matterId: matter_id, detailHash: createHash("sha256").update(why).digest("hex") });
          }
        }
        await purgeAgentDataFor(matter_id);
        appendAuditEvent(db, keyctx.signer, { tenantId: identity.tenantId, actorId: identity.userId, action: "matter.local_agent_data_purged", kind: "matter", objectId: matter_id, matterId: matter_id, detailHash: createHash("sha256").update(all ? "device_revoked" : "membership_removed").digest("hex") });
        done.push(matter_id);
      } catch {
        // 有进行中的任务等：下次再试
      }
    }
    return done;
  };
  governance.onSelfRevoked(() => void purgeLocalAgentData(true).catch(() => {}));
  // 删除中途中断（复核 C-A09）：已删除事项残留的块目录在启动时补删（密钥早已删除，残留块本就不可解）
  for (const { matter_id } of db.all<{ matter_id: string }>(`SELECT matter_id FROM matters WHERE lifecycle = 'purged'`, [])) {
    try {
      if (existsSync(join(blobs.dir, matter_id))) blobs.purgeMatter(matter_id);
    } catch {
      // 下次启动再试
    }
  }
  // 启动时：上次运行期间经同步收到的移出（或本机库里已无成员资格的事项）
  void purgeLocalAgentData(false).catch(() => {});

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
  queue.setOnSettle((runId) => {
    approvals.revokeRun(runId);
    broadcast({ type: "run.settled", run_id: runId });
  });
  broadcastRef.current = broadcast;

  // 退出模式下启动（复核 S6-B34）：中断与排队的任务不重新拉起（暂停）；退出模式解除后由同步回调恢复。本设备已被吊销则终止它们
  // 运行中进入退出模式时，排队的任务同样暂停、不拉起（复核 S6-C12）
  queue.setStartGate(() => !governance.exitMode());
  const exitAtStart = governance.exitMode();
  const recovered = queue.recover({ start: !exitAtStart });
  if (exitAtStart) {
    if (exitAtStart.code === "device_revoked") cancelOpenRuns();
    if (recovered > 0) slog.event("KERNEL_RUNS_RECOVERED", { count: recovered, parked: true });
  } else if (recovered > 0) slog.event("KERNEL_RUNS_RECOVERED", { count: recovered, parked: false });
  // 等待律师中的开放任务：待决项只在宿主内存，重启后按“过期”收尾并作废其批准（复核 S5-B03）
  for (const rid of await expireOrphanedAgentWaits(workflowDeps)) approvals.revokeRun(rid);

  // 每日链头检查点（§6.4）：启动时链非空且无当日检查点则补一个；之后每 24h（链头未变自动跳过）
  const checkpointDaily = (): void => {
    try {
      signer.checkpoint("daily");
    } catch (e) {
      slog.event("KERNEL_CHECKPOINT_FAILED", errFields(e));
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
      // 退出模式（许可到期或未取得、本设备被吊销；第 02 篇 §10）：同步不可用
      if (governance.exitMode()) return;
      try {
        syncExport({ db, blobs, keyctx, tenantId: identity.tenantId }, { shareDir });
        syncImport({ db, blobs, keyctx, tenantId: identity.tenantId }, { shareDir });
        void purgeLocalAgentData(false).catch(() => {});
        lastSyncTickError = "";
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        if (msg !== lastSyncTickError) {
          lastSyncTickError = msg;
          slog.event("KERNEL_SYNC_TIMER_FAILED", errFields(e));
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
    { db, blobs, broker, lawdb, secret: taskTokenKey(), revoked: { rids: revokedRids, jtis: revokedJtis }, stats: localStats, mcpToolsAllowlist: LEGAL_MCP_TOOLS, tokens },
    { port: tcpOff ? -1 : Number(env.ZR_KERNEL_LOCAL_PORT ?? 0), pipePath },
  );
  const localPort = localServerPort(servers.tcp);
  sweepInflight = servers.sweepNow;

  // 控制面同步（阶段 6）：启动即同步一次，之后定时（缺省 10 分钟，钳在 10 秒～1 小时——复核 S6-A21）；
  // ZR_CONTROL_PLANE_SYNC_MS=off 时只在显式调用 control_plane.sync 时同步（测试）
  if (controlPlane && env.ZR_CONTROL_PLANE_SYNC_MS !== "off") controlPlane.start(Number(env.ZR_CONTROL_PLANE_SYNC_MS ?? 600_000) || 600_000);

  return {
    identity,
    config,
    localPort,
    pipePath,
    db,
    blobs,
    agentClient,
    queue,
    signer,
    gate,
    purgeRevokedAgentData: () => purgeLocalAgentData(false),
    async invoke(method: string, params: unknown = {}): Promise<unknown> {
      const handler = api[method];
      if (!handler) throw new DomainError("not_found", `未知内核方法 ${method}`, 404);
      return handler(params, identity);
    },
    onBroadcast(cb) {
      listeners.add(cb);
    },
    async close() {
      // 关闭前冲刷（未到期的还原审计窗口等）：数据库还开着
      for (const fn of shutdownHooks.splice(0)) {
        try {
          fn();
        } catch {
          // 冲刷失败不阻断关闭
        }
      }
      controlPlane?.stop();
      await kapAgentClient.close().catch(() => {});
      await gate.close().catch(() => {});
      clearInterval(dailyTimer);
      if (syncTimer) clearInterval(syncTimer);
      if (contentTimer) clearInterval(contentTimer);
      if (reminderTimer) clearInterval(reminderTimer);
      if (contentFirst) clearTimeout(contentFirst);
      await contentUpdater.close();
      await queue.shutdown();
      for (const s of [servers.tcp, servers.pipe]) {
        if (s) await new Promise<void>((r) => s.close(() => r()));
      }
      lawdbHolder.current.close();
      db.close();
      slog.event("KERNEL_CLOSED", {});
      if (slog.getSink() === logSink) slog.setSink(null);
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
export { FirmGovernance, localDevPolicyBody, firmPolicyInputOf, type FirmPolicyInput, type EffectiveFirmPolicy } from "./control-plane/governance.ts";
export { ControlPlaneClient } from "./control-plane/client.ts";

/**
 * 事项运行策略（kap-host 的策略输入由内核按事项记录派生，不来自请求方——阶段 2 审查 S2-04）：
 * 保密级别 → 数据级别；同意状态与模型端点 → 四项依据是否齐备；A1 开放任务的模式上限为默认档，不给预授权。
 */
export function kapMatterPolicy(db: KernelDb, matterId: string, firm: FirmPolicyInput = firmPolicyInputOf(localDevPolicyBody(process.env))): KapMatterPolicy {
  const m = db.get<{ confidentiality: string; consent_status: string; basis: string | null; model_endpoint: string }>(
    `SELECT confidentiality, consent_status, basis, model_endpoint FROM matters WHERE matter_id = ?`,
    [matterId],
  );
  // 数据级别与闸门同一口径（dataLevelOf：拒绝云端处理的记录按当事人限制 L3b——复核 S5-A15）；事项不存在按最严
  const lv = m ? dataLevelOf(m.confidentiality, m.consent_status) : "L3b";
  const dataLevel = lv === "L4" ? "L3b" : lv;
  // 四项依据（W1，收敛偏离 D-21）：记录了四项时按四项判定，旧事项按 consent_status
  const basisComplete = !!m && basisCompleteOf(m) && m.model_endpoint !== "none";
  // 律所策略的档位上限（阶段 6：控制面下发、放宽须管理员设备签名、过期回退最严模板；开发形态为本机配置项 ZR_FIRM_MAX_MODE，D-17）；
  // L3a/L3b 最高“默认”且不得预授权；自动档的预授权只取律所策略允许的范围
  const firmMax = firm.maxMode;
  const sensitive = dataLevel === "L3a" || dataLevel === "L3b";
  const maxMode = sensitive && firmMax === "auto" ? "default" : firmMax;
  const allowedPreauthorizations: KapMatterPolicy["allowedPreauthorizations"] =
    sensitive || maxMode !== "auto" ? [] : firm.autoPreauthorizations.filter((p): p is "search_generalized" => p === "search_generalized");
  // 抓取白名单 = 公开官方站点基线 + 律所策略（与闸门同一份；闸门逐跳独立强制）
  return { dataLevel, basisComplete, fetchAllowlist: [...firm.fetchAllowlist], allowedPreauthorizations, budget: { maxToolCalls: 200, maxSubagents: 2 }, maxMode, purpose: "legal_analysis" };
}

const MODE_RANK = { chat: 0, manual: 1, default: 2, auto: 3 } as const;

/**
 * 运行选项（W1）：界面请求的运行模式、先出计划与预授权（存于任务输入快照 run_options），按事项策略钳制——
 * 模式取 min(请求, 事项上限)，预授权只在“自动”档且与事项允许范围取交集。宿主再按渠道上限钳制一次（第 02 篇 §9.6）。
 */
export function runOptionsOf(db: KernelDb, runId: string, firm: FirmPolicyInput = firmPolicyInputOf(localDevPolicyBody(process.env))): { mode: KapMatterPolicy["maxMode"]; plan_first: boolean; preauthorized: KapMatterPolicy["allowedPreauthorizations"] } {
  const run = db.get<{ matter_id: string; input_snapshot: string }>(`SELECT matter_id, input_snapshot FROM runs WHERE run_id = ?`, [runId]);
  const pol = run ? kapMatterPolicy(db, run.matter_id, firm) : null;
  let ro: { mode?: unknown; plan_first?: unknown; preauthorized?: unknown } = {};
  try {
    ro = (JSON.parse(run?.input_snapshot ?? "{}") as { run_options?: typeof ro }).run_options ?? {};
  } catch {
    ro = {};
  }
  const max = pol?.maxMode ?? "manual";
  // 未带选项的调用（测试、所内节点等非界面渠道）：默认档、不先出计划；桌面界面总是显式给出（“先出计划”在界面上默认开启）
  const req = (["chat", "manual", "default", "auto"] as const).find((x) => x === ro.mode) ?? "default";
  const mode = MODE_RANK[req] <= MODE_RANK[max] ? req : max;
  const preauthorized = mode === "auto" && Array.isArray(ro.preauthorized) ? (pol?.allowedPreauthorizations ?? []).filter((x) => (ro.preauthorized as unknown[]).includes(x)) : [];
  return { mode, plan_first: mode === "chat" ? false : ro.plan_first === true, preauthorized };
}

/** 运行进入或离开“等待律师”（审批 > 提问 > 无）：按状态机迁移（waiting_* 之间经 running），版本号递增。 */
function setWaiting(db: KernelDb, runId: string, kind: "approval" | "input" | null): void {
  const to = kind === "approval" ? "waiting_approval" : kind === "input" ? "waiting_input" : "running";
  const cur = db.get<{ status: string }>(`SELECT status FROM runs WHERE run_id = ?`, [runId])?.status;
  if (!cur || cur === to || !["running", "waiting_approval", "waiting_input"].includes(cur)) return;
  const now = new Date().toISOString();
  if (cur !== "running" && to !== "running") {
    db.run(`UPDATE runs SET status = 'running', status_version = status_version + 1, updated_at = ? WHERE run_id = ? AND status = ?`, [now, runId, cur]);
  }
  db.run(`UPDATE runs SET status = ?, status_version = status_version + 1, updated_at = ? WHERE run_id = ? AND status IN ('running','waiting_approval','waiting_input')`, [to, now, runId]);
}
