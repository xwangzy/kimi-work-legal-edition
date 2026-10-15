/**
 * 内核侧出站闸门管理（v9 第 04 篇 §1.1、§1.2 第 3 条“出站闸门是唯一出口”、§5.1）：
 *
 * - 按需拉起闸门进程（第一次需要出站时）；闸门退出即视为“唯一出口不可用”，下次使用时重新拉起；闸门只监听本机套接字/命名管道；
 * - 上游与凭据经 IPC 下发（闸门不继承内核环境变量）：标准端点 = 法律模型网关（席位凭据）；自带密钥与律所私有端点直连；
 *   检索服务（席位凭据，不带事项编号）；抓取本机直连。G0 的“控制面下发”以本机配置项代替（见进度文档）；
 * - 授权（gate-host.ts）：任务令牌验签 + 活性（尝试、纪元、撤销）+ 用途 scope + 由任务与事项记录派生的出站上下文；
 * - 去向记录写入事项账本并上签名事件链；模型请求的用量写入计量账本（与 broker 同一请求 ID，INSERT OR IGNORE 去重）；
 * - 闸门新识别的令牌条目写回事项令牌表（按事项密钥重算校验）。
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { EGRESS_CONTENT_FIELDS, egressRecordEnvelopeHash } from "@zr-legal/egress";
import type { DirectModelEndpoint, GateEgressRecord, GateUpstreams } from "@zr-legal/egress-gate";
import { MatterTokenizer, type TokenEntry } from "@zr-legal/tokenizer";
import { recordUsage, type RouteDef } from "@zr-legal/model-broker";
import type { KernelDb } from "../db.ts";
import { appendAuditEvent, type LedgerSigner } from "../ledger-signer.ts";
import { canonicalJson, sha256B64 } from "@zr-legal/keys";
import { createGateAuthorizer, egressRowFromGate, startEgressGate, type GateHandle } from "./gate-host.ts";
import type { MatterTokenStore } from "./matter-tokens.ts";
import type { EgressApprovalStore } from "../services/egress-approvals.ts";
import type { FirmGovernance } from "../control-plane/governance.ts";
import { checkUpstream, type CpRelayRequest, type CpRelayResult, type DistRelayResult, type SupportRelayRequest, type SupportRelayResult, type NotifyRelayRequest, type NotifyRelayResult, type TransportCheck } from "@zr-legal/egress-gate";

export interface KernelGateDeps {
  db: KernelDb;
  env: NodeJS.ProcessEnv;
  socketPath: string;
  entryPath: string;
  runtime?: string;
  /**
   * 闸门运行时的 sha256（审查 S4-11；与 W 执行域 D-12 同一机制）：给出即在拉起前核对（PATH 中解析出的或绝对路径的可执行文件），
   * 不符即不拉起（失败关闭）。产品构建随包运行时并必须给出；G0 开发形态可不给（D-19 如实登记）。
   */
  runtimeSha256?: string;
  /** 任务令牌验证密钥（内核进程内存）。 */
  secret: string;
  revoked: { rids: ReadonlySet<string>; jtis: ReadonlySet<string> };
  tokens: MatterTokenStore;
  signer: LedgerSigner;
  /** 模型别名 → 路由（计量定价）；未知别名返回 null。 */
  resolveRoute: (alias: string) => RouteDef | null;
  /** 律师的出站批准凭据（W1）：闸门在原本要拒绝时来取；未提供 = 闸门不受理确认。 */
  approvals?: EgressApprovalStore;
  /** 运行的预授权（自动档开始时律师选择、经事项策略钳制）。 */
  preauth?: (runId: string) => { searchGeneralized: boolean; images: boolean };
  /**
   * 律所治理（阶段 6）：生效的律所策略（抓取白名单、L3a 放开）、席位令牌、租户盐、退出模式。
   * 未配置控制面时为开发形态（策略取本机配置项，D-17）。
   */
  governance: FirmGovernance;
}

/**
 * 本机配置 → 闸门上游（凭据只经 IPC 到闸门进程）。网关、检索服务与控制面的地址随客户端构建固定（第 04 篇 §5.1“目的地固定”；
 * 不由控制面下发——被攻破的控制面不能把推理流量改投他处）。
 * 席位令牌：配置了控制面时由控制面签发、内核续期（初始可能为空：闸门不发出，直到取得）；开发形态取本机配置项 ZR_SEAT_TOKEN（D-17）。
 */
/** 逗号或空白分隔的钉住集（`sha256/…`）；未配置为空。 */
function pinsFrom(v: string | undefined): string[] {
  return (v ?? "").split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
}

export function gateUpstreamsFromEnv(env: NodeJS.ProcessEnv, cp?: { seatToken: string | null } | null): GateUpstreams {
  const seat = cp ? (cp.seatToken ?? "") : env.ZR_SEAT_TOKEN?.trim() || null;
  const models = { "legal/k3": env.ZR_MODEL_K3 || "kimi-k3", "legal/k2.6": env.ZR_MODEL_K26 || "kimi-k2.6" };
  const direct = (base: string | undefined, key: string | undefined, caFile?: string): DirectModelEndpoint | null => {
    if (!base || !key) return null;
    const b = base.replace(/\/+$/, "");
    let caPem: string | undefined;
    if (caFile) {
      try {
        caPem = readFileSync(caFile, "utf8");
      } catch {
        caPem = undefined; // 读不到律所内部 CA：按系统证书校验（多半失败关闭，设备页可见）
      }
    }
    return { baseUrl: /\/v\d+$/.test(b) ? b : `${b}/v1`, apiKey: key, models, ...(caPem ? { caPem } : {}) };
  };
  const hasSeat = cp ? true : !!seat;
  const gatewayPins = pinsFrom(env.ZR_GATEWAY_PINS);
  // 检索服务与网关同属中软云：未单独配置时沿用网关的钉住集
  const searchPins = env.ZR_SEARCH_PINS !== undefined ? pinsFrom(env.ZR_SEARCH_PINS) : gatewayPins;
  const pin = (p: string[]) => (p.length > 0 ? { pins: p } : {});
  return {
    model: env.ZR_GATEWAY_BASE && hasSeat ? { baseUrl: env.ZR_GATEWAY_BASE, seatToken: seat ?? "", ...pin(gatewayPins) } : null,
    byok: direct(env.ZR_BYOK_BASE ?? env.ZR_MOONSHOT_BASE ?? "https://api.moonshot.cn", env.ZR_BYOK_API_KEY ?? env.ZR_MOONSHOT_API_KEY),
    private: direct(env.ZR_PRIVATE_BASE, env.ZR_PRIVATE_API_KEY, env.ZR_PRIVATE_CA_FILE),
    search: env.ZR_SEARCH_BASE && hasSeat ? { baseUrl: env.ZR_SEARCH_BASE, seatToken: seat ?? "", ...pin(searchPins) } : null,
    fetch: env.ZR_GATE_FETCH === "disabled" ? "disabled" : "local",
    controlPlane: env.ZR_CONTROL_PLANE_BASE ? { baseUrl: env.ZR_CONTROL_PLANE_BASE, ...pin(pinsFrom(env.ZR_CONTROL_PLANE_PINS)) } : null,
    // 内容分发（第 8 批）：法规库与方法模板的签名清单与包；钉住集同其他中软上游（安装包形态必须带）
    dist: env.ZR_DIST_BASE && hasSeat ? { baseUrl: env.ZR_DIST_BASE, seatToken: seat ?? "", ...pin(pinsFrom(env.ZR_DIST_PINS)) } : null,
    // 支持服务（第 9 批 S13）：律师确认上传的脱敏诊断包；席位令牌由闸门附上
    support: env.ZR_SUPPORT_BASE && hasSeat ? { baseUrl: env.ZR_SUPPORT_BASE, ...pin(pinsFrom(env.ZR_SUPPORT_PINS)) } : null,
    // 通知服务（第 10 批 S9）：期限提醒的登记与到时取回；凭据为内核交来的通知专用凭据
    notify: env.ZR_NOTIFY_BASE && hasSeat ? { baseUrl: env.ZR_NOTIFY_BASE, ...pin(pinsFrom(env.ZR_NOTIFY_PINS)) } : null,
    // 传输策略（审计 S5）：安装包形态（ZR_UPSTREAM_TLS=strict）不允许回环 http，中软网关、检索与控制面必须带内置钉住集
    tls: env.ZR_UPSTREAM_TLS === "strict" ? { allowLoopbackHttp: false, requirePins: true } : { allowLoopbackHttp: true, requirePins: false },
  };
}

/** 各上游的传输状态（设备页“连接加密”；纯检查，不联网）。 */
export function upstreamTransport(u: GateUpstreams): Record<"model" | "byok" | "private" | "search" | "control_plane" | "dist" | "support" | "notify", TransportCheck> {
  const tls = u.tls ?? { allowLoopbackHttp: true, requirePins: false };
  const c = (base: string | undefined, pins: readonly string[] | undefined, requirePins: boolean) => checkUpstream(base, { allowLoopbackHttp: tls.allowLoopbackHttp, pins: pins ?? [], requirePins });
  return {
    model: c(u.model?.baseUrl, u.model?.pins, tls.requirePins),
    byok: c(u.byok?.baseUrl, undefined, false),
    private: c(u.private?.baseUrl, undefined, false),
    search: c(u.search?.baseUrl, u.search?.pins, tls.requirePins),
    control_plane: c(u.controlPlane?.baseUrl, u.controlPlane?.pins, tls.requirePins),
    dist: c(u.dist?.baseUrl, u.dist?.pins, tls.requirePins),
    support: c(u.support?.baseUrl, u.support?.pins, tls.requirePins),
    notify: c(u.notify?.baseUrl, u.notify?.pins, tls.requirePins),
  };
}

/** 可执行文件的实际路径：绝对路径原样；否则按 PATH 解析（与 child_process 的查找一致）。 */
function resolveExecutable(cmd: string): string | null {
  if (isAbsolute(cmd)) return cmd;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of process.platform === "win32" ? [`${cmd}.exe`, cmd] : [cmd]) {
      const p = join(dir, name);
      try {
        if (statSync(p).isFile()) return p;
      } catch {
        // 下一个
      }
    }
  }
  return null;
}

/** 任务输入快照里的材料（04 §8 EgressRecord“来源对象”）：版本 ID 与文件名（只在本机账本）。 */
function docRefsOf(db: KernelDb, snapshot: string): { document_version_id: string; filename: string }[] {
  let ids: unknown = [];
  try {
    ids = (JSON.parse(snapshot || "{}") as { document_version_ids?: unknown }).document_version_ids ?? [];
  } catch {
    ids = [];
  }
  if (!Array.isArray(ids)) return [];
  return ids
    .slice(0, 200)
    .map((id) => db.get<{ document_version_id: string; filename: string }>(`SELECT document_version_id, filename FROM document_versions WHERE document_version_id = ?`, [String(id)]))
    .filter((x): x is { document_version_id: string; filename: string } => !!x);
}

export class KernelGate {
  private readonly d: KernelGateDeps;
  private handle: GateHandle | null = null;
  private starting: Promise<GateHandle> | null = null;
  private closed = false;
  /** 意外退出后的自动重拉（退避 1 s 起、指数到 30 s；成功拉起即复位）。 */
  private restartTimer: NodeJS.Timeout | null = null;
  private restartBackoffMs = 0;
  readonly upstreams: GateUpstreams;
  /** 匿名事项编号的租户盐缓存（控制面固定新盐时清空）。 */
  private readonly salts = new Map<string, Buffer>();
  /** 统计（测试与设备页）：闸门进程拉起次数、去向记录与令牌条目写入数、写入失败数。 */
  readonly stats = { starts: 0, exits: 0, records: 0, recordFailures: 0, tokenEntries: 0 };

  constructor(d: KernelGateDeps) {
    this.d = d;
    this.upstreams = gateUpstreamsFromEnv(d.env, d.governance.mode === "control_plane" ? { seatToken: d.governance.seatToken() } : null);
    // 席位令牌续期：更新下次拉起闸门时的上游，并经 IPC 下发给在运行的闸门
    d.governance.onSeatChange((token) => {
      if (this.upstreams.model) this.upstreams.model = { ...this.upstreams.model, seatToken: token };
      if (this.upstreams.search) this.upstreams.search = { ...this.upstreams.search, seatToken: token };
      if (this.upstreams.dist) this.upstreams.dist = { ...this.upstreams.dist, seatToken: token };
      if (this.handle?.alive) this.handle.updateSeat(token);
    });
    d.governance.onSaltChange(() => this.salts.clear());
    // 内核启动时闸门不在运行：上次留下的未补全预写都已无人补全
    this.sweepUnresolved();
  }

  /**
   * 未补全的预写（复核 S4-21）：闸门或内核在两阶段之间中断，结果不明——标为 unknown 并进入人工对账（不重发、不当作成功或失败）。
   * 只在没有存活闸门进程时调用（内核启动、闸门重拉之前），此时所有未补全的记录都已不可能再补全。
   */
  sweepUnresolved(): number {
    const { db, signer } = this.d;
    const open = db.all<{ record_id: string; tenant_id: string; matter_id: string; note: string | null }>(
      `SELECT record_id, tenant_id, matter_id, note FROM egress_records WHERE completed = 0`,
      [],
    );
    for (const r of open) {
      let note: Record<string, unknown> = {};
      try {
        note = JSON.parse(r.note ?? "{}") as Record<string, unknown>;
      } catch {
        note = {};
      }
      db.tx(() => {
        db.run(`UPDATE egress_records SET outcome = 'unknown', completed = 1, note = ? WHERE record_id = ? AND completed = 0`, [
          JSON.stringify({ ...note, phase: "unresolved", reconcile: "pending" }),
          r.record_id,
        ]);
        appendAuditEvent(db, signer, {
          tenantId: r.tenant_id,
          actorId: "kernel",
          action: "egress.unresolved",
          kind: "egress_record",
          objectId: r.record_id,
          matterId: r.matter_id,
          detailHash: sha256B64(canonicalJson({ record_id: r.record_id, outcome: "unknown" })),
        });
      });
    }
    return open.length;
  }

  get socketPath(): string {
    return this.d.socketPath;
  }

  /** 闸门进程当前是否在运行（按需拉起：没有出站任务时可以未运行，下一次出站时拉起）。 */
  get running(): boolean {
    return !!this.handle?.alive;
  }

  /** kap-host 引擎配置用：闸门检索与抓取路由是否可用（未配置即不注册对应工具——ZP-11）。 */
  routes(): { search: boolean; fetch: boolean } {
    return { search: this.upstreams.search !== null, fetch: this.upstreams.fetch === "local" };
  }

  /** 抓取白名单 = 公开官方站点基线 + 生效的律所策略追加（每次读取：策略更新、过期回退即时生效）。 */
  get fetchAllowlist(): readonly string[] {
    return this.d.governance.fetchAllowlist();
  }

  /** 控制面请求经闸门代发（阶段 6；闸门按需拉起）。 */
  async cp(req: CpRelayRequest): Promise<CpRelayResult> {
    if (!this.upstreams.controlPlane) return { ok: false, reason: "cp_not_configured" };
    let h: GateHandle;
    try {
      h = await this.ensure();
    } catch {
      return { ok: false, reason: "gate_unavailable" };
    }
    return h.cp(req);
  }

  /** 内容分发是否已配置（未配置 = 不检查在线更新）。 */
  get distConfigured(): boolean {
    return !!this.upstreams.dist;
  }

  /** 内容分发请求经闸门代取（第 8 批；闸门按需拉起）。 */
  async dist(path: string): Promise<DistRelayResult> {
    if (!this.upstreams.dist) return { ok: false, reason: "dist_not_configured" };
    let h: GateHandle;
    try {
      h = await this.ensure();
    } catch {
      return { ok: false, reason: "gate_unavailable" };
    }
    return h.dist(path);
  }

  /** 支持服务是否已配置（未配置 = 诊断包只能导出文件）。 */
  get supportConfigured(): boolean {
    return !!this.upstreams.support;
  }

  /** 支持通道（第 9 批 S13；闸门按需拉起）。 */
  async support(req: SupportRelayRequest): Promise<SupportRelayResult> {
    if (!this.upstreams.support) return { ok: false, reason: "support_not_configured" };
    let h: GateHandle;
    try {
      h = await this.ensure();
    } catch {
      return { ok: false, reason: "gate_unavailable" };
    }
    return h.support(req);
  }

  /** 通知服务是否已配置（未配置 = 提醒只在本机响）。 */
  get notifyConfigured(): boolean {
    return !!this.upstreams.notify;
  }

  /** 通知通道（第 10 批 S9；闸门按需拉起）。 */
  async notify(req: NotifyRelayRequest): Promise<NotifyRelayResult> {
    if (!this.upstreams.notify) return { ok: false, reason: "notify_not_configured" };
    let h: GateHandle;
    try {
      h = await this.ensure();
    } catch {
      return { ok: false, reason: "gate_unavailable" };
    }
    return h.notify(req);
  }

  /** 确保闸门进程在运行（单飞；退出后重新拉起）。 */
  async ensure(): Promise<GateHandle> {
    if (this.closed) throw new Error("出站闸门已关闭");
    if (this.handle?.alive) return this.handle;
    if (this.starting) return this.starting;
    if (this.d.runtimeSha256) {
      const bin = resolveExecutable(this.d.runtime ?? process.execPath);
      const digest = bin ? createHash("sha256").update(readFileSync(bin)).digest("hex") : null;
      if (digest !== this.d.runtimeSha256.toLowerCase()) throw new Error(`出站闸门运行时摘要不符（${bin ?? this.d.runtime}）：不拉起闸门，模型与联网步骤不可用`);
    }
    const { db, secret, revoked, tokens } = this.d;
    // 上一个闸门进程留下的未补全预写：结果不明，进入对账（复核 S4-21）
    this.sweepUnresolved();
    if (process.platform !== "win32") mkdirSync(dirname(this.d.socketPath), { recursive: true });
    const gov = this.d.governance;
    const authorize = createGateAuthorizer({
      db,
      secret,
      revoked,
      anonSalt: (tid) => {
        let salt = this.salts.get(tid);
        if (!salt) {
          salt = gov.anonSalt(tid);
          this.salts.set(tid, salt);
        }
        return salt;
      },
      tokenizerContext: (mid) => tokens.gateContext(mid),
      fetchAllowlist: () => gov.fetchAllowlist(),
      l3aStandardAllowed: () => gov.l3aStandardAllowed(),
      exitMode: () => gov.exitMode(),
      ...(this.d.preauth ? { preauth: this.d.preauth } : {}),
    });
    const approvals = this.d.approvals;
    this.starting = startEgressGate({
      entryPath: this.d.entryPath,
      socketPath: this.d.socketPath,
      upstreams: this.upstreams,
      ...(this.d.runtime ? { runtime: this.d.runtime } : {}),
      authorize,
      ...(approvals
        ? {
            approvalKeys: approvals.publicKeys(),
            // 闸门取凭据：先按同一授权器核验任务令牌（活性与归属），再按（运行、用途、摘要、目的地）原子地取出
            approval: (req: { token: string; matterId: string; purpose: "search" | "fetch" | "media"; digest: string; dest: string }) => {
              const r = authorize({ token: req.token, matterId: req.matterId, purpose: req.purpose === "media" ? "model" : req.purpose, light: true });
              if (!r.ok) return null;
              return approvals.take({ tenantId: r.ctx.tenantId, matterId: r.ctx.matterId, runId: r.ctx.runId, purpose: req.purpose, digest: req.digest, dest: req.dest });
            },
          }
        : {}),
      onRecord: (rec) => this.onRecord(rec),
      onTokens: (mid, entries) => {
        // 无事项问答的会话（qac_ 前缀）：写会话令牌表；其余写事项令牌表（内核按事项密钥重算校验）
        this.stats.tokenEntries += mid.startsWith("qac_") ? persistQaTokens(db, mid, entries) : tokens.persist(mid, entries);
      },
      onExit: () => {
        this.stats.exits += 1;
        this.scheduleRestart();
      },
    })
      .then((h) => {
        this.stats.starts += 1;
        this.restartBackoffMs = 0;
        this.handle = h;
        // 启动窗口内发生的席位续期或清除（init 之后、句柄就绪之前）不会丢：就绪后再下发一次当前令牌（复核 S6-B25）
        if (gov.mode === "control_plane") h.updateSeat(this.upstreams.model?.seatToken ?? this.upstreams.search?.seatToken ?? this.upstreams.dist?.seatToken ?? "");
        return h;
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  /** 闸门意外退出：唯一出口不可用，按退避自动重拉（期间模型与联网请求失败、按调用方的排队与重试处理；不改为直连）。 */
  private scheduleRestart(): void {
    if (this.closed || this.restartTimer) return;
    this.restartBackoffMs = this.restartBackoffMs > 0 ? Math.min(this.restartBackoffMs * 2, 30_000) : 1_000;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.closed || this.handle?.alive) return;
      void this.ensure().catch(() => this.scheduleRestart());
    }, this.restartBackoffMs);
    this.restartTimer.unref();
  }

  /** 撤销任务：通知闸门立即中止该任务的在途上游请求（之后的请求由授权拒绝）。 */
  revoke(runId: string): void {
    if (this.handle?.alive) this.handle.revoke(runId);
  }

  /**
   * 去向记录（审查 S4-03）：预写阶段（start）插入并上签名事件链；结束阶段（end）按请求 ID 更新生命周期列（结果、备注）并入账用量；
   * 一次写全的记录（被拦截的请求）直接插入。模型请求的“来源对象”取自任务输入快照（本机账本，文件名不出律所侧）。
   */
  private onRecord(rec: GateEgressRecord): void {
    const { db, signer } = this.d;
    try {
      const run = db.get<{ matter_id: string; tenant_id: string; created_by: string; input_snapshot: string }>(
        `SELECT matter_id, tenant_id, created_by, input_snapshot FROM runs WHERE run_id = ?`,
        [rec.runId],
      );
      const attempt = db.get<{ attempt_id: string }>(`SELECT attempt_id FROM attempts WHERE run_id = ? AND status = 'running' ORDER BY seq DESC LIMIT 1`, [rec.runId]);
      const row = egressRowFromGate(rec);
      // 记录归属以任务记录为准（闸门回送的事项与租户须一致；不一致按任务记录写并在备注中标出）
      if (run && (run.matter_id !== rec.matterId || run.tenant_id !== rec.tenantId)) {
        row.matter_id = run.matter_id;
        row.tenant_id = run.tenant_id;
        row.note = JSON.stringify({ ...JSON.parse(String(row.note)), attribution_mismatch: true });
      }
      if (rec.phase === "end") {
        const existing = db.get<{ record_id: string; matter_id: string; tenant_id: string; note: string | null }>(
          `SELECT record_id, matter_id, tenant_id, note FROM egress_records WHERE request_id = ? AND run_id IS ? LIMIT 1`,
          [rec.requestId, rec.runId],
        );
        if (existing) {
          // 生命周期列（结果、备注、完成标记）在签名信封之外：补全另追加一条签名审计事件（复核 S4-21），信封内的事实不改写——
          // 备注里的内容字段（检索原文、URL、裁决、载荷、模型）保持预写时的值（内容摘要据此可复算）
          const startNote = safeNote(existing.note);
          const endNote = { ...safeNote(String(row.note)), ...Object.fromEntries(EGRESS_CONTENT_FIELDS.filter((k) => k in startNote).map((k) => [k, startNote[k]])) };
          for (const k of EGRESS_CONTENT_FIELDS) if (!(k in startNote)) delete endNote[k];
          row.note = JSON.stringify(endNote);
          db.tx(() => {
            db.run(`UPDATE egress_records SET outcome = ?, note = ?, completed = 1 WHERE record_id = ?`, [row.outcome, row.note, existing.record_id]);
            appendAuditEvent(db, signer, {
              tenantId: existing.tenant_id,
              actorId: "egress-gate",
              action: "egress.completed",
              kind: "egress_record",
              objectId: existing.record_id,
              matterId: existing.matter_id,
              detailHash: sha256B64(
                canonicalJson({ record_id: existing.record_id, outcome: row.outcome, reason: rec.reason, upstream_status: rec.upstreamStatus, duration_ms: rec.durationMs, usage: rec.usage ?? null }),
              ),
            });
          });
          this.stats.records += 1;
          this.recordUsage(rec, row, run, attempt);
          return;
        }
        // 预写丢失（例如内核在两阶段之间重启）：按完整记录插入
        row.completed = 1;
      }
      row.attempt_id = attempt?.attempt_id ?? null;
      if (rec.purpose === "model" && run) row.doc_refs = JSON.stringify(docRefsOf(db, run.input_snapshot));
      db.tx(() => {
        db.run(
          `INSERT INTO egress_records
            (record_id, tenant_id, matter_id, run_id, attempt_id, destination_kind, destination_host,
             request_id, client_idempotency_id, chars, segments, pseudonym_findings, pseudonym_counts, doc_refs, note, outcome, created_at,
             completed, content_digest)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            row.record_id,
            row.tenant_id,
            row.matter_id,
            row.run_id,
            row.attempt_id,
            row.destination_kind,
            row.destination_host,
            row.request_id,
            row.client_idempotency_id,
            row.chars,
            row.segments,
            row.pseudonym_findings,
            row.pseudonym_counts,
            row.doc_refs,
            row.note,
            row.outcome,
            row.created_at,
            row.completed,
            row.content_digest,
          ],
        );
        signer.append({ kind: "egress_record", refId: String(row.record_id), matterId: String(row.matter_id), type: "egress.record", payloadHash: egressRecordEnvelopeHash(row as Parameters<typeof egressRecordEnvelopeHash>[0]) });
      });
      this.stats.records += 1;
      if (rec.phase !== "start") this.recordUsage(rec, row, run, attempt);
    } catch (e) {
      this.stats.recordFailures += 1;
      throw e;
    }
  }

  private recordUsage(rec: GateEgressRecord, row: Record<string, unknown>, run: { created_by: string } | undefined, attempt: { attempt_id: string } | undefined): void {
    if ((rec.purpose !== "model" && rec.purpose !== "qa") || !rec.usage) return;
    const route = (rec.model ? this.d.resolveRoute(rec.model) : null) ?? {
      alias: rec.model ?? "unknown",
      provider: "upstream" as const,
      providerModel: rec.model ?? "unknown",
      supportsEffort: false,
      defaultEffort: null,
      allowedEfforts: [],
      temperature: 1,
      priceKey: "",
    };
    recordUsage(
      { run: (sql, params) => void this.d.db.run(sql, params) },
      {
        requestId: rec.requestId,
        task: { tid: String(row.tenant_id), uid: run?.created_by ?? "unknown", mid: String(row.matter_id), rid: rec.runId, aid: attempt?.attempt_id },
        route,
        usage: {
          uncached_input: Math.max(0, rec.usage.input - rec.usage.cached),
          cached_input: rec.usage.cached,
          cache_write: rec.usage.cacheWrite,
          output: rec.usage.output,
          reasoning: rec.usage.reasoning,
          tool_calls: 0,
        },
        clientIdempotencyId: rec.requestId,
        latencyMs: rec.durationMs,
      },
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const h = this.handle ?? (this.starting ? await this.starting.catch(() => null) : null);
    this.handle = null;
    await h?.close().catch(() => {});
  }
}

function safeNote(s: string | null): Record<string, unknown> {
  try {
    const v = JSON.parse(s ?? "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 问答会话的新令牌条目（闸门在请求里新识别的标识符或姓名）：按会话密钥重算校验后只增写入。 */
function persistQaTokens(db: KernelDb, conversationId: string, entries: readonly TokenEntry[]): number {
  const conv = db.get<{ token_key_b64: string }>(`SELECT token_key_b64 FROM qa_conversations WHERE conversation_id = ?`, [conversationId]);
  if (!conv) return 0;
  const table = db.all<TokenEntry>(`SELECT token, category, value, normalized, source FROM qa_tokens WHERE conversation_id = ? ORDER BY seq`, [conversationId]);
  const check = new MatterTokenizer({ matterKey: Buffer.from(conv.token_key_b64, "base64"), table });
  let seq = db.get<{ n: number }>(`SELECT COALESCE(MAX(seq), 0) AS n FROM qa_tokens WHERE conversation_id = ?`, [conversationId])?.n ?? 0;
  let added = 0;
  for (const e of entries) {
    if (!e || typeof e.token !== "string" || typeof e.value !== "string") continue;
    if (check.tokenFor(e.category, e.value, e.source).token !== e.token) continue;
    seq += 1;
    added += db.run(`INSERT OR IGNORE INTO qa_tokens (conversation_id, seq, token, category, value, normalized, source) VALUES (?,?,?,?,?,?,?)`, [
      conversationId,
      seq,
      e.token,
      e.category,
      e.value,
      e.normalized,
      e.source,
    ]).changes;
  }
  return added;
}
