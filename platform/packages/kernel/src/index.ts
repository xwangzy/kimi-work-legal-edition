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
import { existsSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { signSyncWith, SoftwareSigner, verifyBytes, verifyDeviceCertificate } from "@zr-legal/keys";
import { collectRecoveryContent, openRecoveryPackage, peekRecoveryPackage, sealRecoveryPackage } from "./services/recovery-package.ts";
import { cleanupRestoreStaging, configureBackup, markPrunePending, readBackupState, RESTORED_MARKER, restoreFromBackup, runBackup, type BackupDeps } from "./services/backup.ts";
import { writeExportFile } from "./services/export-file.ts";

import { EgressGate, type DestinationKind } from "@zr-legal/egress";
import { ModelBroker } from "@zr-legal/model-broker";
import { DomainError, LEGAL_MCP_TOOLS } from "@zr-legal/domain";
import { activationFilePath, loadConfig, defaultGatePath, defaultPipePath, validActivation, type KernelConfig, type KernelOptions } from "./config.ts";
import { KernelDb } from "./db.ts";
import { BlobStore } from "./blobs.ts";
import { TaskQueue } from "./queue.ts";
import { createApi } from "./api/index.ts";
import { parseWithPipeline } from "./services/parse-pipeline.ts";
import { runChildSelftest, type ChildSelftestResult } from "./services/child-selftest.ts";
import { resolveIdentity, taskTokenKey, type Identity } from "./identity.ts";
import { accountMetaOf, readAccountMeta, writeAccountMeta, type AccountMeta } from "./services/workspaces.ts";
import { applyStagedJoin, applyStagedRecovery, configureSecretSealing, ensureFirmIdentity, ensureDevice, getFirmRootPrivateKey, keysDirOf } from "./devices.ts";
import { onboardingStateText } from "./account-session.ts";
import { accountErrorText, dropAccountSession, dropLoginRequired, maskedPhoneOrNull, modelRejectionProblem, readAccountSession, readLoginRequired, writeAccountSession, writeLoginRequired, type AccountSessionFile } from "./account-session.ts";
import { allocateWorkspace, findProfile, listProfiles, profileScopeId, validHandoff, writeProfile, type ProfileHandoff } from "./profiles.ts";
import { writeActivationFile } from "./services/onboarding.ts";
import { activationInfo, dropActivationClaim, membersApi, OnboardingService, ONBOARDING_METHODS, readActivationClaim, reconcilePendingRestore, removePendingWorkspace, writeJoinFailure, writePendingActivation } from "./services/onboarding.ts";
import { FirmGovernance, localDevPolicyBody, firmPolicyInputOf, type FirmPolicyInput } from "./control-plane/governance.ts";
import { ControlPlaneClient } from "./control-plane/client.ts";
import { firmBundleBytes, parsePublicKeyMap } from "@zr-legal/firm-trust";
import { appendAuditEvent, createLedgerSigner, rowPayloadHash } from "./ledger-signer.ts";
import { AsyncMutex, Semaphore } from "./mutex.ts";
import { materializeSkillsBundle } from "./skills-bundle.ts";
import { ContentUpdater, LawdbHolder, contentKeyTable, contentKeysFromEnv, markProblem, selectLawdb, selectSkills } from "./services/content-updates.ts";
import { totalmem } from "node:os";
import { createBlobCipher } from "./blob-cipher.ts";
import { syncExport, syncImport } from "./sync-engine.ts";
import { chainEncryptEpoch, hasChain } from "./member-log.ts";
import { createLegalWorkflow, expireOrphanedAgentWaits } from "./executor/executor.ts";
import { createKapAgentClient, type KapAgentClient, type KapMatterPolicy } from "./executor/kap-agent-client.ts";
import type { AgentClient } from "./executor/agent-client.ts";
import { startLocalServer, localServerPort, type LocalServers } from "./local-server.ts";
import { legalToolManifests, setLegalToolLock } from "./tools/registry.ts";
import { MatterTokenStore } from "./egress/matter-tokens.ts";
import { createHash, randomUUID } from "node:crypto";
import { KernelGate } from "./egress/kernel-gate.ts";
import { aiAuthorizedOf, dataLevelOf, GATE_KNOWN_ONLY_SCOPE } from "./egress/gate-host.ts";
import { EgressApprovalStore } from "./services/egress-approvals.ts";
import { screenSearchQuery } from "@zr-legal/egress-gate";
import { createGateProvider, mockProvider, thinkingParams, thinkingControlOf } from "@zr-legal/model-broker";
import { abortableChunks, collectStreamText, QaChatService } from "./services/qa-chat.ts";
import { isModelRejection, ModelCatalogService } from "./services/model-catalog.ts";
import { selectedModelOf } from "./services/model-prefs.ts";
import { ReminderService } from "./services/reminders.ts";
import { ShareRelaySync } from "./services/share-relay.ts";
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
  /** 内部（测试用）：是否挂了在线内容更新的定时检查（复核 B13-K04：待激活模式不挂）。 */
  contentCheckScheduled: boolean;
  /** 撤权擦除（审计 S3 1-4）：清理本机律师已不是成员的事项的 Agent 数据与工作区密钥；返回处理的事项。同步后与启动时自动执行。 */
  purgeRevokedAgentData(): Promise<string[]>;
  /**
   * 随包子进程自检（第 52 批，安装冒烟用；偏离 D-215 的验证缺口）：经产品同一代码路径逐个真拉起出站闸门、隔离解析进程、Agent 宿主与 W 执行域，
   * 只回结果码。不发网络请求、不调用模型。主进程经专用消息 kernel.child_selftest 调用，不在内核方法表里。
   */
  childSelftest(): Promise<ChildSelftestResult>;
  onBroadcast(cb: (msg: Record<string, unknown>) => void): void;
  close(): Promise<void>;
}

/**
 * 关闭本机 HTTP 端点而不被长连接拖住（第 72 批，A1 S7）：先断空闲连接，500 毫秒后仍没关完就断开全部连接，2 秒封顶。
 * 关闭时 Agent 宿主、闸门已先关掉，剩下的只可能是空闲的 keep-alive 连接或已无人等待的请求。
 */
export function closeServerPromptly(s: import("node:http").Server, graceMs = 500, capMs = 2_000): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const timers: NodeJS.Timeout[] = [];
    const finish = () => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      resolve();
    };
    try {
      s.close(() => finish());
    } catch {
      finish();
      return;
    }
    s.closeIdleConnections?.();
    timers.push(setTimeout(() => s.closeAllConnections?.(), graceMs));
    timers.push(setTimeout(finish, capMs));
    for (const t of timers) t.unref?.();
  });
}

/** 用当前主密钥试开账本（从备份恢复后确认主进程已采用旧主密钥；复核 R2A-15）。 */
function canOpenLedger(file: string, key: string | undefined): boolean {
  if (!existsSync(file)) return false;
  try {
    const d = new KernelDb(file, { key });
    try {
      d.get(`SELECT COUNT(*) AS n FROM sqlite_master`, []);
    } finally {
      d.close();
    }
    return true;
  } catch {
    return false;
  }
}

export async function createKernel(opts: KernelOptions = {}): Promise<Kernel> {
  // 第 72 批（A1 §2.4 T1）：启动各阶段耗时（毫秒）。进程启动到这里（装载 bundle + 等 kernel.init）记为 init_wait
  const bootSinceProc = Math.round(process.uptime() * 1000);
  const bootStartedAt = Date.now();
  let bootMarkAt = bootStartedAt;
  let config = loadConfig(opts);
  // 从备份恢复的收尾（第 14 批第二轮复核 R2A-15）：清掉复制中途留下的暂存；待生效的激活记录在主密钥已被采用时生效，否则回滚
  cleanupRestoreStaging(config.dataRoot);
  if (config.onboarding && reconcilePendingRestore(config.dataRoot, (f) => canOpenLedger(f, config.dbKey), validActivation) === "promoted") config = loadConfig(opts);
  const env = config.env;
  // 统一脱敏日志（v9.2 §3.6）：内核单写数据根下 logs/；记录编号按本机盐 hash（盐与日志分开存放）
  const logSink = new FileSink({ dir: join(config.workspaceDir, "logs"), salt: loadOrCreateSalt(join(config.workspaceDir, ".log-salt")) });
  slog.setSink(logSink);
  const bootOnboarding = config.onboarding === true;
  const bootPhase = (phase: "db_open_migrate" | "lawdb" | "skills" | "identity_device" | "endpoints" | "ready"): void => {
    const now = Date.now();
    slog.event("KERNEL_BOOT_PHASE", { phase, ms: now - bootMarkAt, onboarding: bootOnboarding });
    bootMarkAt = now;
  };
  slog.event("KERNEL_BOOT_PHASE", { phase: "init_wait", ms: bootSinceProc, onboarding: bootOnboarding });

  const db = new KernelDb(config.dbFile, { key: config.dbKey });
  db.migrate();
  bootPhase("db_open_migrate");
  const identity = resolveIdentity(db, config.firmSlug, config.userSlug);
  // 经开通码激活（第 13 批）：成员角色以开通码 / 邀请码为准；占位工作区已无用
  if (config.activation) {
    // 角色只在创始设备首次按真实身份启动时取自 activation.json（复核 A-08 / B13-K05：之后改 activation.json 不再生效）；
    // 成员设备的角色由管理员签发的证书决定（applyStagedJoin）
    const firstBoot = !db.get(`SELECT 1 AS x FROM firm_identity WHERE tenant_id = ?`, [identity.tenantId]);
    if (firstBoot && config.activation.kind === "founder") {
      db.run(`UPDATE memberships SET role = 'firm_admin' WHERE tenant_id = ? AND user_id = ?`, [identity.tenantId, identity.userId]);
    }
    removePendingWorkspace(config.dataRoot);
  }

  // 法规库包（§9：签名只读 SQLite 包；验签/哈希不符即拒绝加载，不静默降级到任何种子）
  if (config.contentKeyRefused) {
    slog.event("KERNEL_CONTENT_KEY_DEV_REFUSED", {});
    throw new DomainError("lawdb_invalid", "这个安装包带的是测试用的内容签名公钥，正式安装包不能使用：请向中软索取正式安装包", 422);
  }
  if (!config.lawdbSignerPub) {
    throw new DomainError("lawdb_invalid", "未找到内容签名公钥：请先运行 npm run build:lawdb 生成法规库包与签名公钥（或设置 ZR_LAWDB_SIGNER_PUB）", 422);
  }
  if (config.contentKeysRefused > 0) slog.event("KERNEL_CONTENT_KEYS_DEV_DROPPED", { n: config.contentKeysRefused });
  // 内容签名公钥表（随包公钥 + release.json 的 content_keys〔正式安装包已剔除开发公钥〕；kid 由公钥算出）与分发通道（第 8 批 S6/S7）
  const contentKeys = contentKeyTable([config.lawdbSignerPub, ...config.contentKeysExtra], contentKeysFromEnv(env.ZR_CONTENT_KEYS_REVOKED));
  const distChannel = env.ZR_DIST_CHANNEL === "beta" ? "beta" : "stable";
  // 选用法规库：在线已装（账本登记、seq 高于随包）且本机核验通过才用，否则随包（只核验一次，返回已打开实例）；之后在线更新经 LawdbHolder 换用
  const lawdbChoice = selectLawdb({ db, workspaceDir: config.workspaceDir, channel: distChannel, keys: contentKeys, bundledFile: config.lawdbFile, bundledReleaseFile: join(dirname(config.lawdbFile), "lawdb.release.json"), ...(config.lawdbAllowTestFixture ? { allowTestFixture: true } : {}) });
  const lawdbHolder = new LawdbHolder(lawdbChoice.lawdb);
  const lawdb = lawdbHolder.proxy;
  bootPhase("lawdb");

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
  bootPhase("skills");
  // 密钥文件按数据库主密钥派生的密钥封装（隐私安全审查 P0-1）；开发与测试形态无主密钥时为明文
  configureSecretSealing(keysDir, config.dbKey);
  // 第 68 批（D-294）：已激活档案补一份 profile.json（升级前的工作区没有；同一台电脑多个账号时据此找回这个档案）
  if (config.activation && !config.onboarding) {
    try {
      writeProfile(config.dataRoot, config.activation);
    } catch (e) {
      slog.event("KERNEL_PROFILE_WRITE_FAILED", errFields(e));
    }
  }
  // 第 68 批：从别的档案切换过来、这次登录的会话随交接到达——只认属于本档案（同一律所编号、同一成员）的会话，写进本档案（本档案密钥封装）
  const handoff: ProfileHandoff | null = validHandoff(opts.handoff);
  if (handoff?.kind === "session" && config.activation && !config.onboarding) {
    if (handoff.tid === config.activation.tid && handoff.member_slug === config.activation.member_slug && handoff.session.tid === config.activation.tid) {
      try {
        writeAccountSession(keysDir, handoff.session);
        dropLoginRequired(keysDir);
        slog.event("KERNEL_PROFILE_SESSION_HANDOFF", {});
      } catch (e) {
        slog.event("KERNEL_PROFILE_SESSION_HANDOFF_FAILED", errFields(e));
      }
    } else slog.event("KERNEL_PROFILE_SESSION_HANDOFF_FAILED", { reason: "mismatch" });
  }
  // 成员设备（第 13 批）：律所身份来自管理员批准时送达的证书与律所公钥包，本机不生成律所根
  if (config.activation?.kind === "member") {
    let sj: { applied: boolean; rejected?: string };
    try {
      sj = applyStagedJoin(db, keysDir, identity, { firmSlug: config.firmSlug, userSlug: config.userSlug, ...(config.activation?.device_id ? { deviceId: config.activation.device_id } : {}) });
    } catch {
      // 暂存文件损坏或解封不了（复核 B13-K02）：按“被拒”处理，不让未捕获异常把内核卡在每次启动都失败
      sj = { applied: false, rejected: "unreadable" };
    }
    if (sj.rejected) slog.event("KERNEL_JOIN_STAGED_REJECTED", {});
    if (!db.get(`SELECT 1 AS x FROM firm_identity WHERE tenant_id = ?`, [identity.tenantId])) {
      // 入组没有生效（复核 A-09 / B13-K02）：清掉暂存与激活记录，下次启动回到待激活页面重新输入邀请码（主进程会自动重启内核）
      rmSync(join(keysDir, "join-approved.json"), { force: true });
      rmSync(activationFilePath(config.dataRoot), { force: true });
      writeJoinFailure(config.dataRoot, sj.rejected ?? "missing");
      db.close();
      // 这次启动新建的工作区一并删除（复核 R2B-26）：它没有律所身份（只有本次建的空账本），留着会被当成“以前留下的数据”、也挡住对同一律所的“从备份恢复”
      try {
        rmSync(config.workspaceDir, { recursive: true, force: true });
      } catch {
        // 日志文件还开着（Windows）：留到下次，内容只有空账本
      }
      throw new DomainError("conflict", "入组没有完成：管理员批准的结果核对不通过。请重新打开应用，用邀请码再申请一次", 409);
    }
  }
  const firm = ensureFirmIdentity(db, keysDir, identity.tenantId);
  // 暂存的设备恢复在任何组件装载设备密钥之前生效（复核 B4-R09）
  const recovery = applyStagedRecovery(db, keysDir, { firmSlug: config.firmSlug, userSlug: config.userSlug, ...(config.activation?.device_id ? { deviceId: config.activation.device_id } : {}) }, firm.rootPublicKeyPem);
  if (recovery.rejected) slog.event("KERNEL_RECOVERY_REJECTED", {});
  const device = ensureDevice(db, keysDir, identity, { firmSlug: config.firmSlug, userSlug: config.userSlug, ...(config.activation?.device_id ? { deviceId: config.activation.device_id } : {}) }, { promoteSole: !config.activation });
  const signer = createLedgerSigner({ db, deviceId: device.deviceId, signer: device.signer, tenantId: identity.tenantId });
  bootPhase("identity_device");
  // 从备份恢复后的第一次正常启动（复核 R2A-14）：在恢复出的账本里记一条审计（本设备何时从备份恢复），界面据此提醒“原电脑丢失请联系管理员”
  {
    const marker = join(config.workspaceDir, RESTORED_MARKER);
    if (existsSync(marker)) {
      appendAuditEvent(db, signer, { tenantId: identity.tenantId, actorId: identity.userId, action: "device.restored_from_backup", kind: "device", objectId: device.deviceId, matterId: null });
      rmSync(marker, { force: true });
    }
  }
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
  // 链模式按链上已声明的纪元（第 12 批复核 S12B-31/32）：keyctx 在后面才建好，这里延迟取
  const chainEpochRef: { fn: ((mid: string) => number | null | undefined) | null } = { fn: null };
  const blobs = new BlobStore(
    config.blobDir,
    createBlobCipher({ db, deviceId: device.deviceId, encPrivateKeyPem: device.keys.encPrivateKeyPem, chainEpoch: (mid) => chainEpochRef.fn?.(mid) }),
  );

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
  // 第 44 批：账号会话（令牌在 keys/account-session.json，封装；只在内核与闸门之间流转）与“要重新登录”的原因
  let accountSession: AccountSessionFile | null = config.onboarding ? null : readAccountSession(keysDir);
  // 第 64 批：“要重新登录”落在本机（keys/account-login-required.json，封装、不含令牌）——重启应用、内核自动恢复、断网时都停在登录页，
  // 不再要等下一次同步撞上 session_required 才补上（此前这段时间里界面会把工作区露出来）
  // 会话文件比记录新（例如旧版本登录过、没删记录）：以会话为准，记录作废
  const persistedProblem = (() => {
    const p = config.onboarding ? null : readLoginRequired(keysDir);
    if (p && accountSession && Date.parse(accountSession.saved_at) > Date.parse(p.at)) {
      try {
        dropLoginRequired(keysDir);
      } catch {
        // 删不掉也不采用
      }
      return null;
    }
    return p;
  })();
  let accountProblem: string | null = persistedProblem?.reason ?? null;
  /** 上次重新登录成功（清掉 accountProblem）的时刻：刚登录后网关可能还按旧的暂停名单拒绝（见 SESSION_REJECTION_GRACE_MS）。 */
  let accountClearedAt = Number.NEGATIVE_INFINITY;
  /** 第 66 批：云端模型目录（下面建好后填入；登录成功、网关按模型拒绝时据此刷新）。 */
  const modelCatalogRef: { current: ModelCatalogService | null } = { current: null };
  /** 第 71 批：控制面客户端的引用（会话核对在客户端建好之前就要定义）。 */
  const controlPlaneRef: { current: ControlPlaneClient | null } = { current: null };
  /** 退出登录后仍记住上次的邮箱与姓名（不含令牌）：重新登录页预填与称呼；第 64 批起重启后也记得（读本机记录）。 */
  // 第 71 批：另记打码手机号（重新登录页称呼本人、只填验证码的那一行显示用）
  let lastAccount: { email: string; name: string; role: string; phone?: string } | null = accountSession
    ? { email: accountSession.email, name: accountSession.name, role: accountSession.role, ...(maskedPhoneOrNull(accountSession.phone) ? { phone: accountSession.phone! } : {}) }
    : persistedProblem && persistedProblem.email
      ? { email: persistedProblem.email, name: persistedProblem.name, role: persistedProblem.role, ...(maskedPhoneOrNull(persistedProblem.phone) ? { phone: persistedProblem.phone! } : {}) }
      : null;
  /** 记下“要重新登录”（内存 + 本机记录）；写不进去只影响重启后的表现，不影响这次。 */
  const persistProblem = (code: string): void => {
    try {
      writeLoginRequired(keysDir, { reason: code, email: lastAccount?.email ?? accountSession?.email ?? null, name: lastAccount?.name ?? accountSession?.name ?? null, role: lastAccount?.role ?? accountSession?.role ?? null, phone: lastAccount?.phone ?? accountSession?.phone ?? null });
    } catch (e) {
      slog.event("KERNEL_ACCOUNT_MARK_FAILED", errFields(e));
    }
  };
  const accountDeps = {
    session: () => accountSession,
    last: () => lastAccount,
    save: (x: Omit<AccountSessionFile, "v" | "saved_at">) => {
      writeAccountSession(keysDir, x);
      accountSession = readAccountSession(keysDir);
      lastAccount = { email: x.email, name: x.name, role: x.role, ...(maskedPhoneOrNull(x.phone) ? { phone: x.phone! } : {}) };
      // 第 66 批：登录成功后取一次模型目录（会话换了，套餐可能也不同）；不阻塞登录
      setTimeout(() => void modelCatalogRef.current?.refresh("login"), 0).unref?.();
    },
    drop: () => {
      dropAccountSession(keysDir);
      accountSession = null;
    },
    problem: () => accountProblem,
    clearProblem: () => {
      accountProblem = null;
      accountClearedAt = Date.now();
      // 删不掉（Windows 上文件被占用）不让登录报失败：下次启动时会话比记录新，记录作废
      try {
        dropLoginRequired(keysDir);
      } catch (e) {
        slog.event("KERNEL_ACCOUNT_MARK_FAILED", errFields(e));
      }
    },
    setProblem: (code: string) => {
      accountProblem = code;
      persistProblem(code);
      // 退出登录也通知界面（此前只有同步与模型调用发现问题时才广播，界面要等 30 秒轮询）
      broadcastRef.current?.({ type: "account.login_required", reason: code, source: "logout", message: accountErrorText(code) });
    },
    // ─── 第 68 批（D-294）：同一台电脑上换账号 ───
    current: () => ({ tid: config.activation?.tid ?? identity.tenantId, member_slug: config.activation?.member_slug ?? config.userSlug }),
    signedLogin: async () => {
      const now = Date.now();
      if (cloudSwitch && now - cloudSwitch.at < 60_000) return cloudSwitch.ok;
      let m: Awaited<ReturnType<NonNullable<typeof controlPlane>["meta"]>> | null = null;
      try {
        m = (await controlPlane?.meta()) ?? null;
      } catch {
        m = null;
      }
      // 安全复核 U-2：取不到 /v1/meta（网络抖动、云端 5xx）不当作旧云端——照常带签名登录、不记缓存；只有云端答了而没有 account_switch 才是旧云端
      if (!m || !m.ok) return true;
      const features = Array.isArray((m.json as { features?: unknown }).features) ? ((m.json as { features: unknown[] }).features.filter((x) => typeof x === "string") as string[]) : [];
      cloudSwitch = { at: now, ok: (m.json as { account_switch?: unknown }).account_switch === true, unbind: features.includes("device_limit_unbind"), signout: features.includes("device_signout"), features };
      return cloudSwitch.ok;
    },
    // ─── 第 72 批（契约 02 §7）：工作空间与团队 ───
    // 云端能力（/v1/meta.features，与 signedLogin 同一份 60 秒缓存）；取不到 = null（按旧云端降级，不抛错）
    features: async (): Promise<string[] | null> => {
      await accountDeps.signedLogin();
      return cloudSwitch && Date.now() - cloudSwitch.at < 120_000 ? cloudSwitch.features : null;
    },
    // 这台电脑上已有的账号档案（只给编号，界面据此标“切过去不用再登记这台电脑”）
    localProfiles: (): { tid: string; member_slug: string }[] => {
      try {
        return listProfiles(config.dataRoot).map((x) => ({ tid: x.tid, member_slug: x.member_slug }));
      } catch {
        return [];
      }
    },
    meta: () => accountMeta,
    noteMeta: (j: unknown): void => {
      const m = accountMetaOf(j);
      if (m) accountMeta = writeAccountMeta(config.workspaceDir, accountMeta, m);
    },
    switchTo: (j: Record<string, unknown>): Record<string, unknown> => {
      const acc = (j.account ?? {}) as Record<string, any>;
      const onb = (j.onboarding ?? {}) as Record<string, any>;
      const tid = String(acc.tid ?? "");
      const memberSlug = String(acc.member_slug ?? "");
      if (!/^ten_[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(tid) || !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(memberSlug) || typeof j.session_token !== "string") throw new DomainError("provider_unavailable", "中软服务的答复格式不对，请稍后重试", 502);
      const view = { email: String(acc.email ?? ""), name: String(acc.name ?? ""), role: String(acc.role ?? "") };
      const here = config.activation;
      const keepHere = () => {
        // 当前档案留一份记录（升级前的工作区可能还没有），切回来时据此找到它
        if (here) writeProfile(config.dataRoot, here);
        // 安全复核 P-2：切走前把本档案的会话删掉、记“要重新登录”——切回本档案必须再登录这个账号（只改 activation.json 指针打不开已登录的工作区）
        if (accountSession) {
          try {
            dropAccountSession(keysDir);
          } catch {
            // 删不掉：会话仍按云端有效期失效
          }
          accountSession = null;
        }
        persistProblem("session_required");
      };
      const prof = findProfile(config.dataRoot, tid, memberSlug);
      if (prof) {
        keepHere();
        writeActivationFile(config.dataRoot, prof);
        slog.event("KERNEL_PROFILE_SWITCH", { to: "existing" });
        const h: ProfileHandoff = { v: 1, kind: "session", tid, member_slug: memberSlug, session: { token: j.session_token, aid: String(acc.aid ?? ""), email: view.email, name: view.name || (prof.member_name ?? ""), tid, role: view.role || prof.role } };
        setTimeout(() => broadcastRef.current?.({ type: "kernel.switch_profile", handoff: h }), 300).unref?.();
        return { ok: true, switched: true, account: view, firm: { name: prof.firm_name } };
      }
      const state = String(onb.state ?? "");
      if (state === "needs_device_auto" || state === "needs_device_join" || state === "needs_founder_setup") {
        keepHere();
        // 当前档案原样留在它的工作区里（含退出登录的状态）；这台电脑换到待激活，按这次登录的答复为新账号登记
        rmSync(activationFilePath(config.dataRoot), { force: true });
        slog.event("KERNEL_PROFILE_SWITCH", { to: "enroll" });
        const h: ProfileHandoff = { v: 1, kind: "auth", tid, member_slug: memberSlug, auth: j };
        setTimeout(() => broadcastRef.current?.({ type: "kernel.switch_profile", handoff: h }), 300).unref?.();
        return { ok: true, switched: true, enrolling: true, account: view, firm: { name: String(onb.firm?.name ?? acc.org?.name ?? "") } };
      }
      // 不能在这台电脑上继续（设备数已满、律所未开通等）：不切换，就地说明原因（设备数已满时带上已登记的电脑，可就地移除一台再继续）
      const reason = /^[a-z_]{1,40}$/.test(state) ? state : "unknown";
      const devices = Array.isArray(onb.devices) ? onb.devices.slice(0, 20) : [];
      if (state === "device_limit" && devices.length > 0) limitSession = { token: j.session_token, at: Date.now() };
      const limitN = Number.isSafeInteger(onb.device_limit) && (onb.device_limit as number) > 0 && (onb.device_limit as number) <= 99 ? (onb.device_limit as number) : null;
      throw new DomainError("conflict", onboardingStateText(state, { admin: acc.role === "admin" }), 409, { reason, devices, ...(limitN ? { device_limit: limitN } : {}), ...(state === "device_limit" && devices.length > 0 && cloudSwitch?.unbind ? { can_unbind: true } : {}), ...(state === "device_limit" && devices.length > 0 && cloudSwitch?.signout ? { can_signout: true } : {}), ...(onb.limit_kind === "registered" || onb.limit_kind === "signed_in" ? { limit_kind: onb.limit_kind } : {}), account: { name: typeof acc.name === "string" ? acc.name.slice(0, 80) : null, phone: typeof acc.phone === "string" && /^[0-9*+ ]{7,20}$/.test(acc.phone) ? acc.phone : null } });
    },
    // ─── 第 71 批（V45，D-298）：同时登录已满时就地让一台退出登录（或移除）再继续 ───
    holdLimitSession: (token: string, same: boolean) => {
      limitSession = { token, at: Date.now(), same };
    },
    limitSessionPeek: () => (limitSession && Date.now() - limitSession.at <= 9 * 60_000 ? { token: limitSession.token, at: limitSession.at, same: limitSession.same === true } : null),
    clearLimitSession: () => {
      limitSession = null;
    },
    cloudDeviceFeatures: () => ({ unbind: cloudSwitch?.unbind === true, signout: cloudSwitch?.signout === true }),
    // 第 71 批：这台电脑上别的账号的工作空间个数（不列姓名；共用电脑的人看不到彼此是谁）
    otherProfiles: () => {
      try {
        const here = config.activation;
        return listProfiles(config.dataRoot).filter((x) => !(here && x.tid === here.tid && x.member_slug === here.member_slug)).length;
      } catch {
        return 0;
      }
    },
    unbindForLogin: async (deviceId: string): Promise<Record<string, unknown>> => {
      const ls = limitSession;
      if (!ls || Date.now() - ls.at > 9 * 60_000) throw new DomainError("conflict", "这次登录已超过 10 分钟：请重新登录后再移除", 409);
      if (!controlPlane) throw new DomainError("validation", "这台电脑没有连接中软账号服务", 400);
      await controlPlane.accountUnsigned("POST", `/v1/auth/devices/${deviceId}/unbind`, {}, ls.token);
      let o: Record<string, unknown>;
      try {
        o = await controlPlane.accountUnsigned("POST", "/v1/auth/onboarding", {}, ls.token);
      } catch (e) {
        // 安全复核 O-2：与待激活模式同口径——那台电脑已经移除了，不要让律师再移除一台
        const code = String((e as { code?: unknown })?.code ?? "error");
        throw new DomainError("provider_unavailable", `已移除那台电脑；${accountErrorText(code)}`, 502, { reason: code, removed: true });
      }
      limitSession = null;
      return accountDeps.switchTo({ ...o, session_token: ls.token });
    },
  };
  /** 第 68 批：云端是否支持带签名登录别的账号（/v1/meta 取一次记 60 秒）。 */
  let cloudSwitch: { at: number; ok: boolean; unbind: boolean; signout: boolean; features: string[] } | null = null;
  /** 第 72 批：当前工作空间的类型与账号级上手状态（工作区里 account-meta.json；取自登录 / me 应答）。 */
  let accountMeta: AccountMeta | null = config.onboarding ? null : readAccountMeta(config.workspaceDir);
  /** 第 68 批：换到的账号电脑数已满时那次登录的会话（只在内存、10 分钟内），就地移除一台后继续。第 71 批：same = 本档案账号重新登录满额 */
  let limitSession: { token: string; at: number; same?: boolean } | null = null;
  /**
   * 记下“要重新登录”（第 44 批同步口径；第 47 批起模型调用被网关确定地按身份拒绝时也走这里，不等下一次同步）：
   * 原因写进同一个 accountProblem（kernel.status 的 account.login_required / reason、发起前检查的拦截都读它）；
   * 第一次出问题时清掉本机席位令牌（AI 停用）；原因第一次出现或变了（如先“登录已失效”、同步后得知“账号已停用”）都广播
   * account.login_required，界面出登录框。重新登录成功由 account.login 清掉原因。
   */
  const markAccountProblem = (code: string, source: "sync" | "model"): void => {
    const prev = accountProblem;
    if (prev === code) return;
    accountProblem = code;
    persistProblem(code);
    if (prev === null) governance.seatDroppedForSession("session");
    const reason = /^[a-z_]{1,40}$/.test(code) ? code : "other";
    slog.event("KERNEL_ACCOUNT_LOGIN_REQUIRED", { reason, source });
    broadcastRef.current?.({ type: "account.login_required", reason: code, source, message: accountErrorText(code) });
  };
  /**
   * 模型网关拒绝了内核发出的一次模型请求（问答、确定性工作流、独立复核：闸门 provider 的 onRejection；Agent 任务：执行器的失败回调）。
   * 只有账号停用、登录失效这类确定的身份拒绝才切到“要重新登录”；额度、限流、5xx、网络错误不动登录状态（identityRejectionOf）。
   * 只在接入控制面（有账号）时；本机开发形态没有账号。
   */
  /** 第 71 批（D-298）：问一次云端这台电脑的登录会话还在不在（要重新登录的原因由 ControlPlaneClient 的 onSessionProblem 记下并广播）；网络失败不动登录状态。 */
  let sessionCheckTimer: ReturnType<typeof setInterval> | null = null;
  let sessionChecking: Promise<unknown> | null = null;
  const checkSessionNow = (): Promise<unknown> => {
    if (!controlPlaneRef.current || !accountSession) return Promise.resolve();
    sessionChecking ??= controlPlaneRef.current
      .account("GET", "/v1/auth/me")
      // 第 72 批：顺带记下当前工作空间的类型与账号级上手状态
      .then((j) => accountDeps.noteMeta(j))
      .catch(() => undefined)
      .finally(() => {
        sessionChecking = null;
      });
    return sessionChecking;
  };
  const onModelRejection = (codeOrMessage: string | null | undefined): void => {
    if (!controlPlane) return;
    // 第 66 批：所选模型被网关按模型拒绝（套餐不含、停用、未登记、未定价、无可用上游）→ 刷新一次模型目录（至多 30 秒一次），界面随之置灰并说明
    if (isModelRejection(codeOrMessage)) void modelCatalogRef.current?.refresh("model_rejection", { minIntervalMs: 30_000 });
    const code = modelRejectionProblem(codeOrMessage, Date.now() - accountClearedAt);
    if (code) {
      markAccountProblem(code, "model");
      // 第 71 批（V45，D-298）：网关只说“这台电脑被暂停”（会话失效），说不出是不是本人在别的电脑上让它退出了——问一次云端，取准确原因（session_signed_out 等）
      if (code === "session_invalid") void checkSessionNow();
    }
  };
  // 控制面客户端（只在配置了控制面时）：请求经闸门代发，内核本身不联网
  const controlPlane =
    governance.mode === "control_plane" && !config.onboarding
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
          // 第 66 批（V40，D-292）：创始设备的律所公钥包（公开数据）随登记上传——控制面据此给个人账号的新电脑直接登记（存量律所由此回填）
          firmBundle: () => {
            if (!firm.recoveryPublicKeyPem) return null;
            try {
              const r = getFirmRootPrivateKey(keysDir);
              return { recovery_public_key_pem: firm.recoveryPublicKeyPem, sig: new SoftwareSigner(r.privateKeyPem).signSync(firmBundleBytes(identity.tenantId, r.publicKeyPem, firm.recoveryPublicKeyPem)) };
            } catch {
              return null;
            }
          },
          // 客户端版本（主进程从安装包取，经 ZR_APP_VERSION 给内核）：随登记请求上报，控制面只做版本分布统计
          clientVersion: env.ZR_APP_VERSION ?? null,
          // 第 13 批：经开通码激活的创始设备首次登记根公钥时出示认领凭据，登记成功即删除暂存
          activationClaim: () => readActivationClaim(keysDir),
          onEnrolled: () => dropActivationClaim(keysDir),
          // 第 44 批：控制面请求附账号会话；控制面说要重新登录 → 记原因、清掉本机席位令牌（AI 停用）、通知界面出登录框
          sessionToken: () => accountSession?.token ?? null,
          // 第 72 批（A1 H2）：首次同步没成的退避重试间隔（缺省 2/4/8/16/30 秒；ZR_CP_FIRST_RETRY_MS="50,100" 供用例调短，"off" 关）
          ...(env.ZR_CP_FIRST_RETRY_MS ? { firstSyncRetryMs: env.ZR_CP_FIRST_RETRY_MS === "off" ? [] : env.ZR_CP_FIRST_RETRY_MS.split(",").map((x) => Number(x)).filter((x) => Number.isSafeInteger(x) && x >= 10 && x <= 600_000) } : {}),
          // 第 64 批：只认“这次请求带的会话就是现在的会话”——退出登录时发出的同步，答复在重新登录之后才回来，不能把刚登录的人再踢回登录页
          onSessionProblem: (code, sent) => {
            if ((accountSession?.token ?? null) !== sent) return;
            markAccountProblem(code, "sync");
          },
          // 退出模式下启动时暂停的任务：退出模式解除后（同步取得许可）入队（复核 S6-B34）
          onSynced: () => {
            if (governance.exitMode()) return;
            const n = queue.resumeParked();
            if (n > 0) slog.event("KERNEL_EXIT_MODE_LIFTED", { resumed: n });
          },
        })
      : null;
  controlPlaneRef.current = controlPlane;
  /** 确定性工作流经闸门的任务令牌：绑定当前执行中的尝试与纪元（尝试已结束 → 令牌不绑定纪元 → 闸门拒绝）。 */
  // 内核自己发起的独立复核（knownOnly）另带 model:known_only：闸门整段只替换已知名单（V16 第 41 批）。这个函数只在内核进程里由 broker 调用，
  // 交给助手宿主的运行令牌另由 kap-agent-client 按固定 scope 签发，宿主拿不到带这一项的令牌
  const gateTokenFor = (task: { tid: string; uid: string; mid: string; rid?: string | undefined; aid?: string | undefined; knownOnly?: boolean | undefined }): string => {
    const a = task.rid && task.aid ? db.get<{ fence_token: number }>(`SELECT fence_token FROM attempts WHERE attempt_id = ? AND run_id = ? AND status = 'running'`, [task.aid, task.rid]) : undefined;
    return mintTaskToken(
      { tid: task.tid, uid: task.uid, mid: task.mid, ...(task.rid ? { rid: task.rid } : {}), ...(task.aid ? { aid: task.aid } : {}), ...(a ? { fen: a.fence_token } : {}), scope: task.knownOnly ? ["model:chat", GATE_KNOWN_ONLY_SCOPE] : ["model:chat"] },
      600,
    );
  };
  const broker = new ModelBroker(store, egress, env, { gate: { socket: async () => (await gate.ensure()).socketPath, token: gateTokenFor, onRejection: (r) => onModelRejection(r.code) } });
  resolveRouteForGate = (alias) => {
    try {
      return broker.resolveRoute(alias);
    } catch {
      return null;
    }
  };
  // 第 66 批（V40）：云端模型目录——经控制面通道拉取、验签、只进不退、缓存；没有控制面（开发形态、试用版、待激活）只用内置两项。
  // 采用新目录即更新本机模型路由（broker 只认目录里可用的与内置两项）
  const modelCatalog = new ModelCatalogService({
    pull: controlPlane ? () => controlPlane.modelCatalogEnvelope() : null,
    open: (envelope) => governance.openSigned(envelope, "kwl-model-catalog"),
    tenantId: identity.tenantId,
    cacheFile: controlPlane ? join(config.workspaceDir, "model-catalog.json") : null,
    onChange: (doc) => broker.setCatalog(doc?.models ?? []),
    log: (event, fields) => {
      const outcome = event.endsWith("FETCH_FAILED") ? "fetch_failed" : event.endsWith("INVALID") ? "invalid" : event.endsWith("STALE") ? "stale" : "cache_failed";
      slog.event("KERNEL_MODEL_CATALOG", { outcome, trigger: typeof fields.reason === "string" && /^[a-z_]{1,40}$/.test(fields.reason) ? fields.reason : "other" });
    },
  });
  broker.setCatalog(modelCatalog.models());
  modelCatalogRef.current = modelCatalog;
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
  // A1 工作时限（不含等待律师的时间；W1）：缺省 40 分钟（第 35 批 D-159；第 27 批 D-152 为 25 分钟，原 10 分钟），本机配置可调
  const workLimit = Number(env.ZR_AGENT_WORK_LIMIT_MS);
  const agentWorkLimitMs = Number.isFinite(workLimit) && workLimit >= 1000 ? workLimit : undefined;
  // 总时长上限（含等待律师）：缺省 8 小时，本机配置可调（测试与律所策略）
  const wall = Number(env.ZR_AGENT_WALL_MS);
  const agentWallMs = Number.isFinite(wall) && wall >= 2000 ? wall : undefined;
  // 主交付物（第 34 批）：读当时生效的方法模板包（内容更新后 skillsBundle 会换）
  const skillPrimaryOf = (skill: string) => (skillsBundle.ok ? (skillsBundle.skills.find((x) => x.id === skill)?.primary_output ?? null) : null);
  // 独立复核（V13 第 38 批）：缺省开；ZR_INDEPENDENT_REVIEW=off 关闭；复核与交回修改各自的时限可调（毫秒）
  const independentReview = !/^(off|0|false)$/i.test(String(env.ZR_INDEPENDENT_REVIEW ?? ""));
  const msEnv = (v: string | undefined) => (Number.isFinite(Number(v)) && Number(v) >= 1000 ? Number(v) : undefined);
  const reviewLimitMs = msEnv(env.ZR_REVIEW_LIMIT_MS);
  const reviewFixLimitMs = msEnv(env.ZR_REVIEW_FIX_LIMIT_MS);
  const reviewRetryWaitMs = env.ZR_REVIEW_RETRY_WAIT_MS !== undefined && /^\d+$/.test(env.ZR_REVIEW_RETRY_WAIT_MS) ? Number(env.ZR_REVIEW_RETRY_WAIT_MS) : undefined;
  const redlineLimitMs = msEnv(env.ZR_REDLINE_LIMIT_MS);
  // 第 58 批（D-235）：独立复核与回看缺省高强度推理（第 57 批两卡对照：high 都抓到评分认定的头号问题，low 都漏了；每单多约 1.5～5.5 分钟、0.1～0.15 元）。
  // ZR_REVIEW_EFFORT=low 可调回低强度（例如额度紧张时）
  const reviewEffort = env.ZR_REVIEW_EFFORT === "low" ? ("low" as const) : ("high" as const);
  const workflowDeps = { db, blobs, broker, agentClient, lawdb, signer, tokens, agentWorkLimitMs, agentWallMs, skillPrimaryOf, independentReview, reviewLimitMs, reviewRetryWaitMs, reviewFixLimitMs, redlineLimitMs, reviewEffort, vouchKnownOnly: (rid: string, text: string) => gate.vouchKnownOnly(rid, text), onAgentFailure: (error: string | null) => onModelRejection(error), modelSpecOf: (id: string) => { const m = modelCatalog.find(id); return m ? { capabilities: [...m.capabilities], max_context: m.max_context, thinking: m.thinking } : null; } };
  queue.register("legalRun", createLegalWorkflow(workflowDeps));

  const ocrModelPaths = {
    det: join(config.ocrModelDir, "ch_PP-OCRv5_det_mobile.onnx"),
    rec: join(config.ocrModelDir, "ch_PP-OCRv5_rec_mobile.onnx"),
    dict: join(config.ocrModelDir, "ppocrv5_dict.txt"),
  };
  const keyctx = { signer, device, firm, keysDir };
  chainEpochRef.fn = (mid) => (config.legacyMemberRows || !hasChain(db, mid) ? undefined : chainEncryptEpoch({ db, keyctx, tenantId: identity.tenantId }, mid));
  // 无事项问答（第 04 篇 §5.3；W1）：当事人词典检查在本机；问题经出站闸门的问答路由（/q/<会话>）发往网关，不带事项编号；
  // 离线 mock 提供方时在本机模拟（不出站）；回答流式取回，部分内容经 chat.delta 广播给界面
  const qaGate = createGateProvider({
    socket: async () => (await gate.ensure()).socketPath,
    token: (task) => mintTaskToken({ tid: task.tid, uid: task.uid, mid: "qa", ...(task.rid ? { rid: task.rid } : {}), jti: `qa_${randomUUID()}`, scope: ["qa:chat"] }, 300),
    onRejection: (r) => onModelRejection(r.code),
  });
  const qa = new QaChatService({
    db,
    tokens,
    lawdb,
    // 第 47 批：律师按次选模型（K3 / K2.6）；QaChatService 已按可选列表核过，这里只按别名取路由
    routes: () => broker.routeAliases(),
    thinkingOf: (alias) => thinkingControlOf(broker.resolveRoute(alias)),
    // 第 66 批：可选模型、显示名与缺省读云端模型目录（ZR_QA_ROUTE 只作开发覆盖）；律师在问答里记住的模型按本人存在本机
    catalog: () => modelCatalog.models(),
    selectedRoute: (tid, uid) => selectedModelOf(db, tid, uid, "qa"),
    defaultRoute: () => env.ZR_QA_ROUTE ?? modelCatalog.defaultFor("qa"),
    ask: async (input) => {
      const route = broker.resolveRoute(input.route);
      // 深度思考开关 → 上游参数（第 49 批按官方参数表改）：K3 系列用 reasoning_effort（深度 max / 快速 low，K3 不支持 thinking 参数），
      // K2.6 用 thinking.type（enabled / disabled）；温度不发。映射在 model-broker thinkingParams，出口由 gateBody 再按路由能力过滤一遍
      const req = { model: route.alias, messages: input.messages, stream: true, ...thinkingParams(route, input.deep) };
      // 第 71 批第三轮：律师点“停止”时不再产出，并关闭上游连接（abortableChunks 调用源迭代器 return()）
      if (route.provider === "mock") return collectStreamText(abortableChunks((await mockProvider.chatStream(route, req)).chunks, input.signal), input.onDelta, input.onReasoning);
      const meta = { nonce: randomUUID(), clientIdempotencyId: `qa_${randomUUID()}`, task: { tid: input.tenantId, uid: input.userId, mid: "qa", rid: input.conversationId }, routePrefix: `/q/${encodeURIComponent(input.conversationId)}` };
      return collectStreamText(abortableChunks((await qaGate.chatStream(route, req, meta)).chunks, input.signal), input.onDelta, input.onReasoning);
    },
    onPartial: (streamId, text, conversationId) => broadcastRef.current?.({ type: "chat.delta", stream_id: streamId, text, ...(conversationId ? { conversation_id: conversationId } : {}) }),
    // 回答进度（第 48 批）：思考中 / 撰写中，界面显示等待状态用；只含阶段与字数
    onProgress: (streamId, p, conversationId) => broadcastRef.current?.({ type: "chat.progress", stream_id: streamId, phase: p.phase, thought_chars: p.thought_chars, ...(conversationId ? { conversation_id: conversationId } : {}) }),
    // 不选时用不用深度思考：缺省快速回答；ZR_QA_THINKING=on 恢复为深度思考
    defaultDeep: env.ZR_QA_THINKING === "on",
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
  // 待激活模式不检查内容更新（复核 B13-K04：此时没有席位，也没有律所）
  if (gate.distConfigured && env.ZR_CONTENT_CHECK_MS !== "off" && !config.onboarding) {
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

  // 团队事项经中软共享中继同步（第 11 批 S11）：只在律所策略允许、中继已配置且接入控制面时收发；段与块都是密文
  const shareRelay = new ShareRelaySync({
    db,
    blobs,
    keyctx,
    tenantId: identity.tenantId,
    legacyMemberRows: config.legacyMemberRows,
    root: join(config.workspaceDir, "relay"),
    configured: () => gate.relayConfigured && !!controlPlane,
    allowed: () => governance.shareRelayAllowed(),
    relayExplicitlyOff: () => governance.effectivePolicy().source !== "strictest_fallback" && !governance.shareRelayAllowed(),
    exitMode: () => governance.exitMode() !== null,
    credential: () => {
      if (!controlPlane) return Promise.reject(new Error("control_plane_not_configured"));
      return controlPlane.relayToken();
    },
    relay: (req) => gate.relay(req),
    onApplied: (n) => broadcastRef.current?.({ type: "sync.applied", segments: n }),
    // 开发与测试：小值验证大段拆分（下限 4 KiB）
    ...(env.ZR_RELAY_PART_BYTES ? { partBytes: Math.max(4096, Number(env.ZR_RELAY_PART_BYTES) || 0) } : {}),
    ...(env.ZR_RELAY_PART_BLOB_BYTES ? { partBlobBytes: Math.max(1024, Number(env.ZR_RELAY_PART_BLOB_BYTES) || 0) } : {}),
  });
  // 发件每 5 秒（导出没有新内容时不出段）；收件长轮询（有新段即返回，约 5 秒内可见）；出错或不能收发时 30 秒后再试。
  // ZR_RELAY_SYNC_MS=off 只在显式调用 relay.sync 时收发（测试）
  let relayPushTimer: NodeJS.Timeout | null = null;
  let relayClosed = false;
  let relayPause: { timer: NodeJS.Timeout; done: () => void } | null = null;
  if (env.ZR_RELAY_SYNC_MS !== "off") {
    const every = Math.min(Math.max(Number(env.ZR_RELAY_SYNC_MS ?? 5_000) || 5_000, 2_000), 600_000);
    relayPushTimer = setInterval(() => {
      if (!shareRelay.blocked()) void shareRelay.push().catch((e) => slog.event("KERNEL_RELAY_PUSH_FAILED", errFields(e)));
    }, every);
    relayPushTimer.unref();
    void (async () => {
      while (!relayClosed) {
        const r = shareRelay.blocked() ? null : await shareRelay.pull(true).catch(() => null);
        if (relayClosed) break;
        const wait = !r || r.errors.length > 0 ? 30_000 : r.reason === "idle_fast" ? 5_000 : 200;
        await new Promise<void>((done) => {
          const timer = setTimeout(done, wait);
          timer.unref();
          relayPause = { timer, done };
        });
        relayPause = null;
      }
    })();
  }

  const shutdownHooks: (() => void)[] = [];
  const api = createApi({
    purgeAgentData: purgeAgentDataFor,
    backupConfigured: () => !!readBackupState(join(config.workspaceDir, "backup.json")).dir,
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
    modelCatalog,
    kap: kapAgentClient,
    matterPolicy: (mid) => kapMatterPolicy(db, mid, firmPolicy()),
    governance,
    controlPlane,
    ...(controlPlane ? { account: accountDeps } : {}),
    reminders,
    shareRelay,
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
        const relayControl = { foreign: (mid: string) => shareRelay.foreignController(mid), controller: (mid: string) => shareRelay.controllerOf(mid) };
        const ex = syncExport({ db, blobs, keyctx, tenantId: identity.tenantId, relayControl, legacyMemberRows: config.legacyMemberRows }, { shareDir });
        // 成员链自动处置失败（第三轮复核 S12B-40）：记运行事件（只有事项编号与原因代码）
        if (ex.chainErrors.length > 0) slog.event("KERNEL_MEMBER_LOG_MAINTAIN_FAILED", { count: ex.chainErrors.length });
        syncImport({ db, blobs, keyctx, tenantId: identity.tenantId, relayControl, legacyMemberRows: config.legacyMemberRows }, { shareDir });
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
    { db, blobs, broker, lawdb, secret: taskTokenKey(), revoked: { rids: revokedRids, jtis: revokedJtis }, stats: localStats, mcpToolsAllowlist: LEGAL_MCP_TOOLS, tokens, firmName: config.activation?.firm_name ?? null },
    { port: tcpOff ? -1 : Number(env.ZR_KERNEL_LOCAL_PORT ?? 0), pipePath },
  );
  const localPort = localServerPort(servers.tcp);
  sweepInflight = servers.sweepNow;
  bootPhase("endpoints");

  // 控制面同步（阶段 6）：启动即同步一次，之后定时（缺省 10 分钟，钳在 10 秒～1 小时——复核 S6-A21）；
  // ZR_CONTROL_PLANE_SYNC_MS=off 时只在显式调用 control_plane.sync 时同步（测试）
  // ─── 开通与成员入组（第 13 批；docs/design/开通与成员入组设计-v1.md） ───
  // 待激活模式：只开放 onboarding.*（见 invoke 的门禁）；激活完成后请主进程按 activation.json 重启内核
  const onboarding = config.onboarding
    ? new OnboardingService({ config, relay: (req) => gate.cp(req), requestRestart: () => broadcast({ type: "kernel.restart_for_identity" }), requestSwitch: (h) => broadcast({ type: "kernel.switch_profile", handoff: h }) })
    : null;
  // 第 68 批：上一个档案里登录了一个这台电脑上还没有档案的账号——按那次登录的答复继续登记（结果经 onboarding.status 给激活页）
  if (onboarding && handoff?.kind === "auth") void onboarding.resumeHandoff(handoff);
  // 第 64 批：开通页首屏要用注册 / 登录策略——内核一启动就预取（顺带拉起出站闸门），界面第一次调用接上这个请求
  if (onboarding && env.ZR_PREFETCH_META !== "0") onboarding.prefetchRegistrationMeta();
  if (onboarding) {
    onboarding.start();
    api["onboarding.status"] = () => onboarding.status();
    api["onboarding.redeem"] = (p) => onboarding.redeem((p ?? {}) as { code?: unknown });
    api["onboarding.check"] = () => onboarding.check();
    api["onboarding.reset"] = () => onboarding.reset();
    // 第 66 批（V40，D-292）：个人账号新电脑自动登记被风控暂停后，用短信验证码确认再登记
    api["onboarding.device_confirm"] = (p) => onboarding.deviceConfirm((p ?? {}) as { phone?: unknown; sms_code?: unknown });
    // 第 68 批（V42，D-295）：电脑数已满时就地移除一台再继续
    api["onboarding.unbind_device"] = (p) => onboarding.unbindForLogin((p ?? {}) as { device_id?: unknown });
    // 第 71 批（V45，D-298）：同时登录已满时就地让一台退出登录（可逆）再继续；等批准期间改用另一个账号（放弃那个申请）
    api["onboarding.signout_device"] = (p) => onboarding.signoutForLogin((p ?? {}) as { device_id?: unknown });
    api["onboarding.abandon_pending"] = () => onboarding.abandonPendingAndContinue();
    // 第 44 批：账号注册与登录（这台电脑还没有身份）；找回密码两种模式都可用
    api["account.register"] = (p) => onboarding.accountRegister((p ?? {}) as Record<string, unknown>);
    api["account.login"] = (p) => onboarding.accountLogin((p ?? {}) as Record<string, unknown>);
    api["account.reset_request"] = (p) => onboarding.resetRequest((p ?? {}) as Record<string, unknown>);
    api["account.reset_confirm"] = (p) => onboarding.resetConfirm((p ?? {}) as Record<string, unknown>);
    // 第 62 批：注册策略（按云端能力字段决定注册页显示手机号与邀请码；旧云端回 legacy）与短信验证码
    api["account.registration_meta"] = () => onboarding.registrationMeta();
    api["account.sms_send"] = (p) => onboarding.smsSend((p ?? {}) as Record<string, unknown>);
    // 从备份恢复（第 14 批；设计 docs/design/恢复与备份设计-v1.md §3.4）：恢复包 + 恢复码 + 备份位置 → 与原机相同的身份与数据
    api["onboarding.restore"] = async (p) => {
      const done = onboarding.exclusive();
      try {
        const file = String(p?.file ?? "");
        const dir = String(p?.dir ?? "");
        if (!file || !dir) throw new DomainError("validation", "请选择恢复包文件和备份位置", 400);
        if (statSync(file).size > 1024 * 1024) throw new DomainError("validation", "选的不是恢复包（文件太大）", 400);
        const c = openRecoveryPackage(readFileSync(file), String(p?.code ?? ""));
        const cert = c.device.cert;
        // 证书按当前时刻核验（复核 R2A-17）：过期的证书恢复后也登记不上控制面
        const vr = verifyDeviceCertificate(cert, c.root_public_key_pem, new Date());
        if (!vr.ok || cert.signPublicKeyPem !== c.device.keys.signPublicKeyPem || cert.encPublicKeyPem !== c.device.keys.encPublicKeyPem) {
          throw new DomainError("validation", "恢复包里的设备身份核对不通过（证书可能已过期）：请联系律所管理员重新办理入组", 400);
        }
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(c.firm_slug) || c.firm_slug === "pending-activation") throw new DomainError("validation", "恢复包里的律所标识不合法", 400);
        if (!c.db_master_key) throw new DomainError("validation", "这份恢复包不含数据库主密钥（旧格式），不能用来从备份恢复：请在原电脑上重新生成恢复包", 400);
        // 本机已有以前留下的数据（复核 R2A-05）：恢复会换掉本机主密钥，那些数据此后在本应用里打不开——须律师确认
        // 第 68 批（D-294）：这台电脑上已有别的账号档案时，待激活用的是另起的一把密钥（keySlot = pending）——恢复只换这一把，别的数据不受影响
        const legacy = config.keySlot === "pending" ? [] : ((onboarding.status() as { legacy_workspaces?: string[] }).legacy_workspaces ?? []).filter((w) => w !== c.firm_slug);
        if (legacy.length > 0 && p?.legacy_ack !== true) {
          throw new DomainError("conflict", `这台电脑上还有以前留下的数据（${legacy.join("、")}）。从备份恢复后它们在本应用里将打不开（不会删除）。若确认，请勾选后再恢复；要保留它们，请先联系所内 IT`, 409, { code: "legacy_present", legacy_workspaces: legacy });
        }
        const roleOf: Record<string, "admin" | "partner" | "lawyer" | "assistant"> = { admin: "admin", partner: "partner", assistant: "assistant" };
        const role = roleOf[cert.role] ?? "lawyer";
        // 激活记录与恢复包、证书逐项一致（复核 R2A-17）；角色以证书为准
        if (c.activation && (c.activation.tid !== c.tid || c.activation.firm_slug !== c.firm_slug || c.activation.member_slug !== c.member_slug)) {
          throw new DomainError("validation", "恢复包里的激活记录与设备身份不一致", 400);
        }
        // 第 68 批：恢复到这个账号自己的工作区目录（同一律所已有别的成员档案时为 <律所>.<成员>），并记下密钥格
        const restoreWs = allocateWorkspace(config.dataRoot, c.tid, c.firm_slug, c.member_slug);
        const act = {
          v: 1 as const,
          ...(restoreWs !== c.firm_slug ? { workspace: restoreWs } : {}),
          ...(config.keySlot === "pending" ? { key_slot: restoreWs } : {}),
          tid: c.tid,
          firm_slug: c.firm_slug,
          firm_name: c.activation?.firm_name ?? c.firm_slug,
          member_slug: c.member_slug,
          member_name: c.activation?.member_name ?? null,
          role,
          kind: c.firm_root ? ("founder" as const) : ("member" as const),
          activated_at: new Date().toISOString(),
          // 第 44 批：同一账号的第 2～9 台按证书上的编号恢复
          ...(cert.deviceId !== `dev_${c.firm_slug}_${c.member_slug}` ? { device_id: cert.deviceId } : {}),
        };
        rmSync(join(config.dataRoot, "onboarding-failed.json"), { force: true }); // 复核 R2B-08：残留的失败记录不让这次恢复误报
        const r = await restoreFromBackup({
          backupDir: dir,
          dbKey: c.db_master_key,
          tenantId: c.tid,
          deviceId: c.device.device_id,
          dataRoot: config.dataRoot,
          firmSlug: restoreWs,
          verifySig: (bytes, sig) => verifyBytes(cert.signPublicKeyPem, bytes, sig),
          minSeq: c.backup?.seq ?? null,
          olderAck: p?.older_ack === true,
          // 激活记录先写成“待生效”：主进程采用主密钥、内核重启后试开账本成功才生效（复核 R2A-15）
          beforeCommit: () => writePendingActivation(config.dataRoot, act),
        });
        slog.event("KERNEL_RESTORED_FROM_BACKUP", { files: r.files });
        onboarding.markRestarting();
        // 恢复的账本与密钥文件都由旧电脑的数据库主密钥保护：请主进程用本机 DPAPI 重新包裹它（只在待激活模式下接受），再按新身份重启
        const key = c.db_master_key;
        setTimeout(() => broadcast({ type: "kernel.adopt_master_key", key }), 300).unref();
        return { ok: true, firm: { name: act.firm_name }, member: { name: act.member_name, role: act.role }, backup_at: r.manifest.at, files: r.files, skipped_newer: r.skipped_newer, next: "restart" };
      } finally {
        done();
      }
    };
  } else {
    api["onboarding.status"] = () => ({ mode: "activated", activation: activationInfo(config, firm, identity) });
    // 待批准页的轮询与内核自动取回会赛跑：自动取回先拿到批准、内核已按新身份重启时，界面的这次查询照样得到“已批准”并刷新
    api["onboarding.check"] = () => ({ mode: "activated", last_check: "approved" });
  }
  const members = membersApi({
    db,
    identity,
    config,
    firm,
    keysDir,
    call: controlPlane ? (m, p, b) => controlPlane.request(m, p, b) : null,
    audit: (action, kind, objectId) => appendAuditEvent(db, signer, { tenantId: identity.tenantId, actorId: identity.userId, action, kind, objectId, matterId: null }),
  });
  api["members.invite"] = (p) => members.invite(p ?? {});
  api["members.list"] = () => members.list();
  api["members.attention"] = () => members.attention();
  api["members.approve"] = (p) => members.approve(p ?? {});
  api["members.reject"] = (p) => members.reject(p ?? {});
  api["members.revoke_invitation"] = (p) => members.revokeInvitation(p ?? {});

  // ─── 恢复包与备份（第 14 批；设计 docs/design/恢复与备份设计-v1.md） ───
  if (!config.onboarding) {
    // 数据根按原样与解析链接后的真实路径各比一次（复核 R2A-11：备份位置经链接指进数据根也算）
    const dataRoots = [config.dataRoot, ...(() => {
      try {
        return [realpathSync(config.dataRoot)];
      } catch {
        return [];
      }
    })()];
    const insideDataRoot = (p: string) => {
      const a = (x: string) => x.replace(/[\\/]+$/, "").toLowerCase();
      return dataRoots.some((root) => a(p) === a(root) || a(p).startsWith(`${a(root)}/`) || a(p).startsWith(`${a(root)}\\`));
    };
    const backupDeps: BackupDeps = {
      db,
      workspaceDir: config.workspaceDir,
      dbFile: config.dbFile,
      dbKey: config.dbKey,
      tenantId: identity.tenantId,
      deviceId: device.deviceId,
      sign: (bytes) => signSyncWith(device.signer, bytes),
      stateFile: join(config.workspaceDir, "backup.json"),
      indexFile: join(config.workspaceDir, "backup-index.json"),
      insideDataRoot,
    };
    // 被吊销的设备不再备份、不再生成恢复包（复核 R2A-16：否则吊销后仍能把律所事项复制出任意多份可离线恢复的副本）
    const revoked = () => governance.exitMode()?.code === "device_revoked";
    const notRevoked = () => {
      if (revoked()) throw new DomainError("conflict", "本设备已被吊销：不能再备份或生成恢复包", 409);
    };
    const auditLocal = (action: string, objectId: string, detailHash?: string) => {
      appendAuditEvent(db, signer, { tenantId: identity.tenantId, actorId: identity.userId, action, kind: "device", objectId, matterId: null, detailHash });
      if (action.startsWith("recovery.")) pkgStats = null;
    };
    // 恢复包生成与试解的次数、最近几次生成的时刻：只在启动后第一次与每次生成/试解之后数一遍审计表（复核 R2B-23：界面每次换页都查
    // backup.status，原先每次对 audit_events 做三次按动作的扫描）。最近几次的时刻供律师对照手里的纸销毁不用的那份（R2A-01）
    // 审计里记恢复包的套号摘要（不记套号本身）：开通向导的“试一下”要对上最新生成的那一份（复核 R15B-25：重新生成后要再试一次）
    const packageMark = (setId: string) => createHash("sha256").update(`kwl-recovery-set:${setId}`).digest("hex");
    let pkgStats: { created: number; verified: number; latestVerified: boolean; recent: string[] } | null = null;
    const packageStats = () =>
      (pkgStats ??= (() => {
        const last = db.get<{ id: number; h: string | null }>(
          `SELECT audit_event_id AS id, detail_hash AS h FROM audit_events WHERE action = 'recovery.package_created' AND tenant_id = ? ORDER BY audit_event_id DESC LIMIT 1`,
          [identity.tenantId],
        );
        // 升级前生成的恢复包没有摘要：退回按先后判断（最近一次生成之后试过）
        const latestVerified = !last
          ? false
          : !!db.get(
              last.h
                ? `SELECT 1 FROM audit_events WHERE action = 'recovery.package_verified' AND tenant_id = ? AND detail_hash = ?`
                : `SELECT 1 FROM audit_events WHERE action = 'recovery.package_verified' AND tenant_id = ? AND audit_event_id > ?`,
              [identity.tenantId, last.h ?? last.id],
            );
        return {
          created: db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'recovery.package_created' AND tenant_id = ?`, [identity.tenantId])!.n,
          verified: db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'recovery.package_verified' AND tenant_id = ?`, [identity.tenantId])!.n,
          latestVerified,
          recent: db.all<{ at: string }>(`SELECT created_at AS at FROM audit_events WHERE action = 'recovery.package_created' AND tenant_id = ? ORDER BY audit_event_id DESC LIMIT 5`, [identity.tenantId]).map((r) => r.at),
        };
      })());
    api["recovery.create_package"] = (p) => {
      notRevoked();
      const target = String(p?.path ?? "");
      if (!target) throw new DomainError("validation", "请选择恢复包的保存位置", 400);
      const content = collectRecoveryContent({
        keysDir,
        activation: config.activation,
        tenantId: identity.tenantId,
        firmSlug: config.firmSlug,
        userSlug: config.userSlug,
        dbKey: config.dbKey,
        device: { deviceId: device.deviceId, cert: device.cert },
        firm,
        backup: (() => {
          const b = readBackupState(backupDeps.stateFile);
          return b.seq > 0 ? { seq: b.seq, at: b.last_ok_at } : null;
        })(),
      });
      const sealed = sealRecoveryPackage(content, config.activation?.firm_name ?? config.firmSlug);
      const w = writeExportFile(target, sealed.bytes, config.dataRoot);
      auditLocal("recovery.package_created", device.deviceId, packageMark(sealed.setId));
      return { file_name: w.name, code_text: sealed.codeText, set_id: sealed.setId, includes_firm_root: !!content.firm_root, created_at: content.created_at, firm_name: config.activation?.firm_name ?? config.firmSlug };
    };
    api["recovery.verify_package"] = (p) => {
      const file = String(p?.file ?? "");
      if (!file) throw new DomainError("validation", "请选择恢复包文件", 400);
      if (statSync(file).size > 1024 * 1024) throw new DomainError("validation", "选的不是恢复包（文件太大）", 400);
      const bytes = readFileSync(file);
      const outer = peekRecoveryPackage(bytes);
      const c = openRecoveryPackage(bytes, String(p?.code ?? ""));
      const sameDevice = c.device.device_id === device.deviceId && c.device.keys.signPublicKeyPem === device.cert.signPublicKeyPem;
      auditLocal("recovery.package_verified", device.deviceId, packageMark(outer.set_id));
      return { ok: true, same_device: sameDevice, created_at: outer.created_at, includes_db_key: !!c.db_master_key, includes_firm_root: !!c.firm_root };
    };
    // 同一时刻只跑一次备份（定时器、“立即备份”、删除事项后的补备份共用）；退出时取消（复核 R2B-04）
    let backupRun: Promise<Awaited<ReturnType<typeof runBackup>>> | null = null;
    let backupProgress: { done: number; total: number } | null = null;
    const backupAbort = new AbortController();
    const startBackup = () => {
      if (!backupRun) {
        backupProgress = { done: 0, total: 0 };
        backupRun = runBackup({ ...backupDeps, signal: backupAbort.signal, onProgress: (x) => (backupProgress = x) }).finally(() => {
          backupRun = null;
          backupProgress = null;
        });
      }
      return backupRun;
    };
    const backgroundBackup = () => {
      void startBackup().catch((e) => slog.event("KERNEL_BACKUP_FAILED", errFields(e)));
    };
    api["backup.status"] = () => {
      const st = readBackupState(backupDeps.stateFile);
      const { created: pk, verified: pv, latestVerified, recent } = packageStats();
      const staleDays = st.last_ok_at ? Math.floor((Date.now() - Date.parse(st.last_ok_at)) / 86400_000) : null;
      return { configured: !!st.dir, last_ok_at: st.last_ok_at, last_error: st.last_error, stale_days: staleDays, running: backupProgress, files: st.last_files, bytes: st.last_bytes, packages_created: pk, packages_verified: pv, latest_package_verified: latestVerified, recent_packages: recent, revoked: revoked() };
    };
    api["backup.configure"] = (p) => {
      notRevoked();
      const st = configureBackup(backupDeps, String(p?.dir ?? ""));
      auditLocal("backup.configured", device.deviceId);
      return { configured: !!st.dir };
    };
    api["backup.run"] = async () => {
      notRevoked();
      const r = await startBackup();
      slog.event("KERNEL_BACKUP_DONE", { files: r.last_files, copied: r.copied });
      return { ok: true, last_ok_at: r.last_ok_at, files: r.last_files, copied: r.copied };
    };
    // 每天自动一次：启动后 5～15 分钟先看一次（复核 R2B-05：每次只开一会儿的律师也能备份上），之后每小时看一次——
    // 配置了位置且上次成功已超过 24 小时即备份；失败只记事件码，界面看 backup.status
    const backupDue = () => {
      const st = readBackupState(backupDeps.stateFile);
      if (revoked() || !st.dir || (st.last_ok_at && Date.now() - Date.parse(st.last_ok_at) < 24 * 3600_000)) return;
      backgroundBackup();
    };
    let backupTimer: ReturnType<typeof setInterval> | null = null;
    const backupFirst =
      env.ZR_BACKUP_TIMER === "off"
        ? null
        : setTimeout(() => {
            backupDue();
            backupTimer = setInterval(backupDue, 3600_000);
            backupTimer.unref();
          }, (5 + Math.random() * 10) * 60_000);
    backupFirst?.unref();
    // 删除事项后（复核 R2A-10）：记“待清旧代”并立即再备份一次——这次成功后备份位置上只留新的一代，旧几代账本快照（仍有该事项的密钥包裹）
    // 与该事项的块随之删除；正有一次备份在跑（它的账本快照是删除之前的），等它结束再备份一次；备份位置不可用时标记留到下次成功
    const purge = api["matters.purge"];
    if (purge) {
      api["matters.purge"] = async (p, id) => {
        const r = await purge(p, id);
        if (markPrunePending(backupDeps.stateFile) && !revoked()) {
          const inFlight = backupRun;
          if (inFlight) void inFlight.catch(() => {}).finally(backgroundBackup);
          else backgroundBackup();
        }
        return r;
      };
    }
    shutdownHooks.push(() => {
      if (backupFirst) clearTimeout(backupFirst);
      if (backupTimer) clearInterval(backupTimer);
      // 退出、安装更新：取消进行中的备份（不写新清单，上一代不受影响）
      backupAbort.abort();
    });
  }
  {
    const baseStatus = api["kernel.status"]!;
    api["kernel.status"] = async (p, id) => ({
      ...((await baseStatus(p, id)) as Record<string, unknown>),
      onboarding: onboarding ? onboarding.status() : null,
      // 内容签名公钥来源（第 13 批，评审 Z4 P0-3）：dev = 开发公钥（测试构建），release = 正式公钥
      content_key: config.contentKeyDev ? "dev" : "release",
      // 正式安装包从 content_keys 剔除的开发公钥把数（复核 A-14 余项）
      ...(config.contentKeysRefused > 0 ? { content_keys_refused: config.contentKeysRefused } : {}),
      activation: config.onboarding ? null : activationInfo(config, firm, identity),
      // 第 68 批：当前账号档案的标识（摘要，不含身份）：界面按它分开本机偏好、切换账号后据此确认已换到新档案
      profile: config.onboarding || !config.activation ? null : { id: profileScopeId(config.activation) },
      // 第 72 批（契约 §7）：当前工作空间是个人还是团队（取自登录 / me 应答；还没取到为 null，界面按旧推断）；
      // 这台电脑的证书是谁签的：firm_root = 律所根（能接收团队共享事项），account_ca = 云端账号签发钥（D-304：能登录、用 AI、处理自己的事项，
      // 还不能接收团队共享事项——团队共享处提示“请管理员确认这台电脑”）
      workspace_kind: config.onboarding ? null : (accountMeta?.workspace_kind ?? null),
      device_issuer: config.onboarding ? null : (device.cert as { issuer?: unknown }).issuer === "account_ca" ? "account_ca" : "firm_root",
      // 这台电脑何时从备份恢复（复核 R2A-14 / R2B-22：界面据此提醒“原电脑丢了请找管理员”）
      restored_from_backup_at: config.onboarding ? null : (db.get<{ at: string }>(`SELECT created_at AS at FROM audit_events WHERE action = 'device.restored_from_backup' AND tenant_id = ? ORDER BY audit_event_id DESC LIMIT 1`, [identity.tenantId])?.at ?? null),
    });
  }

  if (controlPlane && env.ZR_CONTROL_PLANE_SYNC_MS !== "off") controlPlane.start(Number(env.ZR_CONTROL_PLANE_SYNC_MS ?? 600_000) || 600_000);
  // 第 71 批（V45，D-298）：登录会话的轻量核对（缺省每 2 分钟一次，一个 GET /v1/auth/me）——本人在别的电脑上选了“让这台退出登录”、
  // 运营或管理员让它退出、账号被停用时，这台电脑约 2 分钟内转到重新登录页并写明原因；不等 10 分钟一次的同步，也不等下一次用 AI 才被网关挡下
  if (controlPlane && env.ZR_SESSION_CHECK_MS !== "off") {
    const ms = Math.max(15_000, Number(env.ZR_SESSION_CHECK_MS ?? 120_000) || 120_000);
    sessionCheckTimer = setInterval(() => {
      if (accountSession && !accountProblem) void checkSessionNow();
    }, ms);
    sessionCheckTimer.unref();
  }
  // 第 66 批：模型目录每 10 分钟取一次（启动即取；ZR_MODEL_CATALOG_MS=off 关，开发联调可调短）
  if (controlPlane && env.ZR_MODEL_CATALOG_MS !== "off" && (env.ZR_CONTROL_PLANE_SYNC_MS !== "off" || env.ZR_MODEL_CATALOG_MS)) modelCatalog.start(Number(env.ZR_MODEL_CATALOG_MS ?? 600_000) || 600_000);
  bootPhase("ready");

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
    contentCheckScheduled: contentTimer !== null,
    purgeRevokedAgentData: () => purgeLocalAgentData(false),
    childSelftest: () =>
      runChildSelftest({
        gate,
        kap: kapAgentClient,
        // 与材料导入同一入口与同一解析进程配置（KWL_PARSE_NODE / KWL_PARSE_WORKER_ENTRY：安装包为随包运行时）
        parse: (pdf, filename) =>
          parseWithPipeline(pdf, filename, "application/pdf", {
            ocrModelPaths,
            mockOcr: env.ZR_PARSE_OCR_MOCK === "1",
            worker: { execPath: env.KWL_PARSE_NODE || undefined, entry: env.KWL_PARSE_WORKER_ENTRY || undefined },
          }),
      }),
    async invoke(method: string, params: unknown = {}): Promise<unknown> {
      if (config.onboarding && !ONBOARDING_METHODS.has(method)) throw new DomainError("not_activated", "这台电脑还没有激活：请先输入中软给的开通码或律所发的邀请码", 409);
      const handler = api[method];
      if (!handler) throw new DomainError("not_found", `未知内核方法 ${method}`, 404);
      return handler(params, identity);
    },
    onBroadcast(cb) {
      listeners.add(cb);
    },
    async close() {
      const closeStartedAt = Date.now();
      // 关闭前冲刷（未到期的还原审计窗口等）：数据库还开着
      for (const fn of shutdownHooks.splice(0)) {
        try {
          fn();
        } catch {
          // 冲刷失败不阻断关闭
        }
      }
      controlPlane?.stop();
      modelCatalog.stop();
      onboarding?.stop();
      relayClosed = true;
      if (relayPushTimer) clearInterval(relayPushTimer);
      // 等进行中的收发结束（至多 5 秒；复核 S11B-07），之后才关闭闸门与数据库
      await shareRelay.close(5_000).catch(() => {});
      if (relayPause) {
        clearTimeout((relayPause as { timer: NodeJS.Timeout }).timer);
        (relayPause as { done: () => void }).done();
      }
      await kapAgentClient.close().catch(() => {});
      await gate.close().catch(() => {});
      clearInterval(dailyTimer);
      if (syncTimer) clearInterval(syncTimer);
      if (sessionCheckTimer) clearInterval(sessionCheckTimer);
      if (contentTimer) clearInterval(contentTimer);
      if (reminderTimer) clearInterval(reminderTimer);
      if (contentFirst) clearTimeout(contentFirst);
      await contentUpdater.close();
      await queue.shutdown();
      // 第 72 批（A1 S7）：server.close() 要等现存连接全部断开——空闲的长连接（keep-alive）先断，半秒后仍没关完就断开全部连接，
      // 2 秒封顶；此前偶发等满主进程的 8 秒才被强杀（换账号、激活后的重启都要经过这里）
      for (const s of [servers.tcp, servers.pipe]) {
        if (s) await closeServerPromptly(s);
      }
      lawdbHolder.current.close();
      db.close();
      slog.event("KERNEL_CLOSED", { ms: Date.now() - closeStartedAt });
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
export { AI_SUBPROCESSORS, AI_NOTICE_VERSION } from "./services/ai-authorization.ts";
export { FirmGovernance, localDevPolicyBody, firmPolicyInputOf, type FirmPolicyInput, type EffectiveFirmPolicy } from "./control-plane/governance.ts";
export { ControlPlaneClient } from "./control-plane/client.ts";

/**
 * 事项运行策略（kap-host 的策略输入由内核按事项记录派生，不来自请求方——阶段 2 审查 S2-04）：
 * 保密级别 → 数据级别；同意状态与模型端点 → 四项依据是否齐备；A1 开放任务的模式上限为默认档，不给预授权。
 */
export function kapMatterPolicy(db: KernelDb, matterId: string, firm: FirmPolicyInput = firmPolicyInputOf(localDevPolicyBody(process.env))): KapMatterPolicy {
  const m = db.get<{ confidentiality: string; consent_status: string; basis: string | null; basis_source: string | null; basis_ref: string | null; basis_notice_version: string | null; model_endpoint: string }>(
    `SELECT confidentiality, consent_status, basis, basis_source, basis_ref, basis_notice_version, model_endpoint FROM matters WHERE matter_id = ?`,
    [matterId],
  );
  // 数据级别与闸门同一口径（dataLevelOf：拒绝云端处理的记录按当事人限制 L3b——复核 S5-A15）；事项不存在按最严
  const lv = m ? dataLevelOf(m.confidentiality, m.consent_status) : "L3b";
  const dataLevel = lv === "L4" ? "L3b" : lv;
  // 四项依据（W1，收敛偏离 D-21）：记录了四项时按四项判定，旧事项按 consent_status
  // 第 51 批（D-216）、D-225：授权有效须有出处与当前次处理者清单版本（与闸门、内核前置检查、网关摘要同一函数）
  const basisComplete = !!m && aiAuthorizedOf(m);
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
