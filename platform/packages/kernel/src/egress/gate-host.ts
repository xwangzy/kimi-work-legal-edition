/**
 * 出站闸门的内核侧（v9 第 04 篇 §1.1、§5.1）：内核拉起闸门进程（独立进程、唯一出口），并且是闸门的唯一授权来源——
 *
 * - authorize：任务令牌验签（内核进程内存密钥）→ 活性（尝试仍在执行、纪元一致、未撤销；复审 N-01/N-03）→ 用途须在令牌 scope 内 →
 *   由**任务记录与事项记录**派生出站上下文（数据级别、四项依据、模型端点、令牌化上下文），不采信令牌或请求方的自报；
 * - record：闸门的去向记录写入本机事项账本（egress_records；检索查询原文与发出的查询只在这里）；
 * - tokens：闸门新识别的令牌条目写入事项令牌表（界面与文书引擎还原需要）；
 * - revoke：撤销任务时通知闸门中止该任务的在途上游请求。
 */
import { fork, type ChildProcess } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { verifyToken, type CapabilityClaims } from "@zr-legal/service-auth";
import { newId } from "@zr-legal/domain";
import { egressContentDigest } from "@zr-legal/egress";
import type { PartyEntry, TokenEntry } from "@zr-legal/tokenizer";
import type { AuthorizeResult, CpRelayRequest, CpRelayResult, DistRelayResult, GateEgressRecord, GatePurpose, GateUpstreams, MatterEgressContext, SignedApproval } from "@zr-legal/egress-gate";
import type { KernelDb } from "../db.ts";
import { liveRunForClaims } from "../identity.ts";
import { HIDE_WINDOW, parentHeartbeatEnv, runtimeReady, startParentHeartbeat, windowsSystemEnv } from "../executor/child-env.ts";
import { errFields, relayChildStderr, slog } from "@zr-legal/safe-log";

/** 用途 → 任务令牌须带的 scope。 */
export const GATE_SCOPES: Readonly<Record<GatePurpose, string>> = Object.freeze({ model: "model:chat", search: "egress:search", fetch: "egress:fetch", qa: "qa:chat" });

export type DataLevel = MatterEgressContext["dataLevel"];

/**
 * 保密级别 → 数据级别（与 kap-host 的事项运行策略同一口径：strict = 当事人限制 L3b；high = 敏感 L3a；其余 L2）。
 * 当事人拒绝云端处理的记录同样按当事人限制（L3b）处理（第 02 篇 §8.1 L3b“当事人书面要求不上云或不用 AI”、§8.2 L3b 行：
 * 联网检索与法源查询禁止，只有“当事人只拒绝云端时”可用律所私有端点推理——复核 S5-A15）。
 */
export function dataLevelOf(confidentiality: string | undefined | null, consentStatus?: string | null): DataLevel {
  if (consentStatus === "refused") return "L3b";
  return confidentiality === "strict" ? "L3b" : confidentiality === "high" ? "L3a" : confidentiality ? "L2" : "L3b";
}

const ORG_SUFFIX = /(有限责任公司|股份有限公司|有限公司|公司|集团|事务所|银行|支行|分行|医院|学校|大学|学院|研究院|委员会|政府|法院|中心|合作社|厂|店)$/;

/** 四项依据（第 02 篇 §8.1；W1 收敛偏离 D-21）。 */
export interface MatterBasis {
  engagement: "confirmed" | "pending" | "not_applicable";
  personal_info: "confirmed" | "pending" | "not_applicable";
  sensitive: "confirmed" | "pending" | "not_applicable";
  subprocessor: "confirmed" | "pending" | "not_applicable";
}
export const BASIS_KEYS = ["engagement", "personal_info", "sensitive", "subprocessor"] as const;

export function parseBasis(s: string | null | undefined): MatterBasis | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s) as Record<string, unknown>;
    const ok = (x: unknown) => x === "confirmed" || x === "pending" || x === "not_applicable";
    if (BASIS_KEYS.every((k) => ok(v[k]))) return v as unknown as MatterBasis;
  } catch {
    // 不规范：按未记录处理
  }
  return null;
}

/**
 * 依据是否齐备：记录了四项依据时按四项判定（任一“待确认”即不齐备）；旧事项未记录四项时按 consent_status（agreed / not_required 视为齐备）。
 */
export function basisCompleteOf(m: { basis?: string | null; consent_status?: string | null; model_endpoint?: string | null }): boolean {
  // 当事人拒绝云端处理的记录优先（复核 S5-A09：补录四项依据不得静默推翻拒绝记录；须由律师核实后清除）——
  // 只允许律所私有端点（第 02 篇 §8.2 L3b 行“推理（私有）✓ 当事人只拒绝云端时”）；私有端点下按四项判定，旧记录按拒绝云端处理
  if (m.consent_status === "refused") {
    if (m.model_endpoint !== "private") return false;
    const rb = parseBasis(m.basis);
    return rb ? BASIS_KEYS.every((k) => rb[k] !== "pending") : true;
  }
  const b = parseBasis(m.basis);
  if (b) return BASIS_KEYS.every((k) => b[k] !== "pending");
  return m.consent_status === "agreed" || m.consent_status === "not_required";
}

/**
 * 审批策略指纹（复核 S5-B02/B18）：只由与批准有关的事项字段算出——密级、同意状态、四项依据、模型端点、全部化名、协作范围；
 * 批准凭据带签发时的指纹，闸门与当前指纹比对。当事人词典的增改不在其中（只影响令牌化，出站时按当前词典重筛）。
 */
export function approvalPolicyOf(m: { confidentiality?: string | null; consent_status?: string | null; basis?: string | null; model_endpoint?: string | null; full_pseudonym?: number | boolean | null; collab_scope?: string | null }): string {
  const basis = parseBasis(m.basis);
  const fields = [m.confidentiality ?? "", m.consent_status ?? "", basis ? BASIS_KEYS.map((k) => basis[k]).join(",") : "", m.model_endpoint ?? "", m.full_pseudonym ? 1 : 0, m.collab_scope ?? ""];
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex").slice(0, 16);
}

/** 事项头的当事人与相对方 → 当事人词典（G0：按名称判定主体类型；G1 由事项当事人表显式维护）。 */
export function partiesFromMatter(m: { client_name?: string | null; counterparty?: string | null }, extra: readonly PartyEntry[] = []): PartyEntry[] {
  const out: PartyEntry[] = [...extra];
  for (const raw of [m.client_name, m.counterparty]) {
    for (const name of String(raw ?? "").split(/[、,，;；]/).map((s) => s.trim()).filter((s) => s.length >= 2)) {
      // 词典中已有同名条目（律师维护的别名、停用的派生字号）时以词典为准（复核 S4-20）
      if (out.some((p) => p.name === name)) continue;
      out.push({ name, kind: headerPartyKind(name) });
    }
  }
  return out;
}

/** 事项头名称的主体类型（G0：按名称判定；G1 由事项当事人表显式维护）。 */
export function headerPartyKind(name: string): "person" | "org" {
  return ORG_SUFFIX.test(name) || name.length > 6 ? "org" : "person";
}

export interface GateAuthorizerDeps {
  db: KernelDb;
  /** 任务令牌验证密钥（内核进程内存，identity.ts taskTokenKey）。 */
  secret: string;
  revoked: { rids: ReadonlySet<string>; jtis: ReadonlySet<string> };
  /** 匿名事项编号的租户盐（网关二次检查用；不能还原事项）。 */
  anonSalt(tenantId: string): Buffer;
  /** 事项令牌上下文（密钥材料、当事人、令牌表与版本）；由内核事项账本提供。 */
  tokenizerContext(matterId: string, matter: { client_name?: string | null; counterparty?: string | null }): MatterEgressContext["tokenizer"];
  /** 本任务的预授权（G0：A1 不给预授权）。 */
  preauth?(runId: string): MatterEgressContext["preauth"];
  /** 抓取域名白名单（公开官方站点基线 + 律所策略）。 */
  fetchAllowlist(matterId: string): readonly string[];
  /** L3a 事项经标准端点推理是否已由律所管理员放开（律所策略：控制面下发且经管理员设备签名；开发形态为本机配置项）。 */
  l3aStandardAllowed(): boolean;
  /** 退出模式（许可到期或未取得、本设备被吊销；阶段 6）：一切出站拒绝。 */
  exitMode?(): { code: string; message: string } | null;
}

/** 匿名事项编号：HMAC-SHA256(租户盐, 租户‖事项) 截 22 字符（闸门出站与事项匿名摘要上报同一口径；不能还原事项）。 */
export function anonMatterIdOf(salt: Buffer, tenantId: string, matterId: string): string {
  return createHmac("sha256", salt).update(`${tenantId}\u0000${matterId}`).digest("base64url").slice(0, 22);
}

export function createGateAuthorizer(d: GateAuthorizerDeps): (req: { token: string; matterId: string; purpose: GatePurpose; light?: boolean }) => AuthorizeResult {
  return (req) => {
    let claims: CapabilityClaims;
    try {
      claims = verifyToken(req.token, d.secret, GATE_SCOPES[req.purpose]);
    } catch {
      return { ok: false, status: 401, reason: "token_invalid_or_scope" };
    }
    // 退出模式（第 02 篇 §10）：模型、联网检索与抓取一律不出站（在途任务在下一次出站时停止）
    const exit = d.exitMode?.();
    if (exit) return { ok: false, status: 403, reason: exit.code };
    if (req.purpose === "qa") return authorizeQa(d, claims, req);
    const live = liveRunForClaims(d.db, claims, d.revoked);
    if (typeof live === "string") return { ok: false, status: 403, reason: live };
    if (live.matterId !== req.matterId) return { ok: false, status: 403, reason: "matter_mismatch" };
    const m = d.db.get<{ tenant_id: string; client_name: string | null; counterparty: string | null; confidentiality: string; consent_status: string; basis: string | null; model_endpoint: string; policy_version: number; full_pseudonym: number; collab_scope: string }>(
      `SELECT tenant_id, client_name, counterparty, confidentiality, consent_status, basis, model_endpoint, policy_version, full_pseudonym, collab_scope FROM matters WHERE matter_id = ?`,
      [live.matterId],
    );
    if (!m) return { ok: false, status: 403, reason: "matter_unknown" };
    const basisComplete = basisCompleteOf(m) && m.model_endpoint !== "none";
    return {
      ok: true,
      ctx: {
        tenantId: live.tenantId,
        matterId: live.matterId,
        runId: live.runId,
        userId: claims.uid,
        anonMatterId: anonMatterIdOf(d.anonSalt(live.tenantId), live.tenantId, live.matterId),
        dataLevel: dataLevelOf(m.confidentiality, m.consent_status),
        basisComplete,
        modelEndpoint: m.model_endpoint as MatterEgressContext["modelEndpoint"],
        preauth: d.preauth?.(live.runId) ?? { searchGeneralized: false, images: false },
        l3aStandardAllowed: d.l3aStandardAllowed(),
        fetchAllowlist: d.fetchAllowlist(live.matterId),
        policyVersion: m.policy_version,
        approvalPolicy: approvalPolicyOf(m),
        // 在途复核（light）只核对活性与归属：不下发密钥材料与令牌表
        tokenizer: req.light ? { keyB64: "", parties: [], table: [], fullPseudonym: true, tableVersion: -1 } : d.tokenizerContext(live.matterId, m),
      },
    };
  };
}

/**
 * 无事项问答的授权（第 04 篇 §5.3；W1）：问答令牌（scope qa:chat，rid = 会话编号）+ 会话须属于令牌里的租户与用户；
 * 出站上下文固定为 L1、依据齐备、标准端点（网关问答专门路由，不带事项编号）；令牌化器用会话自己的密钥与令牌表，不含任何事项的当事人词典
 * （当事人词典检查在内核发送前完成：命中即拦截，不会走到这里）。
 */
function authorizeQa(d: GateAuthorizerDeps, claims: CapabilityClaims, req: { matterId: string; light?: boolean }): AuthorizeResult {
  if (claims.mid !== "qa" || !claims.rid || claims.rid !== req.matterId) return { ok: false, status: 403, reason: "matter_mismatch" };
  if (claims.jti && d.revoked.jtis.has(claims.jti)) return { ok: false, status: 403, reason: "token_revoked" };
  const conv = d.db.get<{ tenant_id: string; user_id: string; token_key_b64: string }>(`SELECT tenant_id, user_id, token_key_b64 FROM qa_conversations WHERE conversation_id = ?`, [claims.rid]);
  if (!conv || conv.tenant_id !== claims.tid || conv.user_id !== claims.uid) return { ok: false, status: 403, reason: "qa_conversation_unknown" };
  const table = req.light
    ? []
    : d.db.all<TokenEntry>(`SELECT token, category, value, normalized, source FROM qa_tokens WHERE conversation_id = ? ORDER BY seq`, [claims.rid]);
  return {
    ok: true,
    ctx: {
      tenantId: claims.tid,
      matterId: claims.rid,
      runId: claims.rid,
      userId: claims.uid,
      qa: true,
      anonMatterId: "qa",
      dataLevel: "L1",
      basisComplete: true,
      modelEndpoint: "standard",
      preauth: { searchGeneralized: false, images: false },
      l3aStandardAllowed: false,
      fetchAllowlist: [],
      policyVersion: 0,
      tokenizer: req.light ? { keyB64: "", parties: [], table: [], fullPseudonym: true, tableVersion: -1 } : { keyB64: conv.token_key_b64, parties: [], table, fullPseudonym: false, tableVersion: table.length },
    },
  };
}

/** 闸门去向记录 → egress_records 行（检索查询与 URL 写在 note 的 JSON 里，只在本机事项账本）。 */
const DESTINATION_KIND: Readonly<Record<GateEgressRecord["destination"], string>> = Object.freeze({
  legal_gateway: "legal_gateway",
  byok_model: "byok_model",
  private_model: "private_model",
  search_service: "search_service",
  public_web: "public_web",
  none: "gate_blocked",
});

export function egressRowFromGate(rec: GateEgressRecord): Record<string, unknown> {
  const kind = DESTINATION_KIND[rec.destination] ?? "gate_blocked";
  const interruptedModel = rec.purpose === "model" && rec.phase === "end" && rec.outcome === "failed" && !rec.usage;
  const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);
  const suspects = { high: count(rec.suspectedNames?.high), medium: count(rec.suspectedNames?.medium) };
  const note = {
    ...(rec.phase ? { phase: rec.phase } : {}),
    purpose: rec.purpose,
    reason: rec.reason,
    ...(rec.query ? { query: rec.query } : {}),
    ...(rec.url ? { url: rec.url } : {}),
    ...(rec.media.length ? { media: rec.media } : {}),
    ...(rec.model ? { model: rec.model } : {}),
    ...(rec.hostDecision ? { host_decision: rec.hostDecision } : {}),
    ...(typeof rec.toolCallId === "string" && /^[A-Za-z0-9_:.-]{1,128}$/.test(rec.toolCallId) ? { tool_call_id: rec.toolCallId } : {}),
    ...(rec.replacedAtGate && Object.keys(rec.replacedAtGate).length ? { replaced_at_gate: rec.replacedAtGate } : {}),
    // 发送前二次检测（v9.2 R7）：只有计数（高、中两档的不同值个数，规整为非负整数），不含值
    ...(suspects.high + suspects.medium > 0 ? { suspected_names: suspects } : {}),
    ...(rec.usage ? { usage: rec.usage } : {}),
    // 中断的流式请求：本机没有尾部用量，计费以网关结算为准（复核 S4-21）
    ...(interruptedModel ? { usage_note: "中断的流式请求：本机未收到用量，计费以网关结算为准" } : {}),
    ...(rec.approvalId ? { approval_id: rec.approvalId } : {}),
    upstream_status: rec.upstreamStatus,
    duration_ms: rec.durationMs,
    policy_version: rec.policyVersion,
  };
  const replaced = Object.values(rec.tokenized).reduce((n, c) => n + (c ?? 0), 0);
  const row: Record<string, unknown> = {
    record_id: newId("egressRecord"),
    tenant_id: rec.tenantId,
    matter_id: rec.matterId,
    run_id: rec.runId,
    attempt_id: null,
    destination_kind: kind,
    destination_host: rec.destinationHost ?? "（未外发）",
    request_id: rec.requestId,
    client_idempotency_id: rec.requestId,
    chars: rec.chars,
    segments: rec.segments,
    pseudonym_findings: replaced,
    pseudonym_counts: JSON.stringify(rec.tokenized),
    doc_refs: "[]",
    note: JSON.stringify(note),
    outcome: rec.outcome,
    created_at: rec.at,
    completed: rec.phase === "start" ? 0 : 1,
  };
  row.content_digest = egressContentDigest({ destination_kind: kind, destination_host: String(row.destination_host), note: String(row.note) });
  return row;
}

export interface GateHandle {
  readonly socketPath: string;
  /** 闸门进程仍在运行（退出后为 false：唯一出口不可用，模型与联网步骤排队；下次使用时由调用方重新拉起）。 */
  readonly alive: boolean;
  revoke(runId: string): void;
  /** 席位令牌续期下发（阶段 6）。 */
  updateSeat(token: string): void;
  /** 控制面请求经闸门代发（阶段 6；目的地为 init 下发的固定地址；闸门退出即失败）。 */
  cp(req: CpRelayRequest, timeoutMs?: number): Promise<CpRelayResult>;
  /** 内容分发请求经闸门代取（第 8 批；只许 GET 白名单路径，席位令牌由闸门附上；闸门退出即失败）。 */
  dist(path: string, timeoutMs?: number): Promise<DistRelayResult>;
  close(): Promise<void>;
  readonly process: ChildProcess;
}

export interface StartGateOptions {
  entryPath: string;
  socketPath: string;
  upstreams: GateUpstreams;
  authorize: (req: { token: string; matterId: string; purpose: GatePurpose; light?: boolean }) => AuthorizeResult;
  onRecord: (rec: GateEgressRecord) => void;
  onTokens: (matterId: string, entries: TokenEntry[]) => void;
  /** 闸门进程退出（含崩溃）。 */
  onExit?: (code: number | null) => void;
  runtime?: string;
  startTimeoutMs?: number;
  /** 闸门取律师的批准凭据（W1）：内核核验任务令牌后原子地取出；没有即 null。 */
  approval?: (req: { token: string; matterId: string; purpose: "search" | "fetch" | "media"; digest: string; dest: string }) => SignedApproval | null;
  /** 批准凭据验签公钥（设备 ID → PEM），随 init 下发闸门。 */
  approvalKeys?: Record<string, string>;
}

/** 拉起闸门进程（环境变量不继承内核；只经 IPC）。闸门退出时调用方应视为“唯一出口不可用”：模型与联网步骤排队。 */
export async function startEgressGate(o: StartGateOptions): Promise<GateHandle> {
  // 随包运行时全量摘要核验通过之前不拉起（复核 B4-R15）
  await runtimeReady();
  return startEgressGateNow(o);
}

function startEgressGateNow(o: StartGateOptions): Promise<GateHandle> {
  const child = fork(o.entryPath, [], { execPath: o.runtime ?? process.execPath, execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"], env: { PATH: process.env.PATH ?? "", ...windowsSystemEnv(), ...parentHeartbeatEnv() }, ...HIDE_WINDOW });
  startParentHeartbeat(child);
  // stderr 只认日志器 JSON 行（按登记表重新核验后写入本机日志），其余行只计数（v9.2 §3.6）
  relayChildStderr(child.stderr, "gate");
  let alive = true;
  child.on("message", (m: any) => {
    if (m?.t === "call" && m.method === "authorize") {
      let result: AuthorizeResult;
      try {
        result = o.authorize(m.params);
      } catch {
        result = { ok: false, status: 503, reason: "kernel_authorize_error" };
      }
      if (child.connected) child.send({ t: "result", id: m.id, ok: true, result });
    } else if (m?.t === "call" && m.method === "approval") {
      let result: SignedApproval | null = null;
      try {
        const p = m.params ?? {};
        const purpose = p.purpose === "search" || p.purpose === "fetch" || p.purpose === "media" ? p.purpose : null;
        result = purpose && o.approval ? o.approval({ token: String(p.token ?? ""), matterId: String(p.matterId ?? ""), purpose, digest: String(p.digest ?? ""), dest: String(p.dest ?? "") }) : null;
      } catch {
        result = null;
      }
      if (child.connected) child.send({ t: "result", id: m.id, ok: true, result });
    } else if (m?.t === "record") {
      try {
        o.onRecord(m.rec as GateEgressRecord);
      } catch (e) {
        slog.event("GATE_RECORD_WRITE_FAILED", errFields(e));
      }
    } else if (m?.t === "tokens") {
      try {
        o.onTokens(String(m.matterId), m.entries as TokenEntry[]);
      } catch (e) {
        slog.event("GATE_TOKEN_WRITE_FAILED", errFields(e));
      }
    }
  });
  // 控制面请求（阶段 6）：IPC 往返；闸门退出时一律按不可达返回
  let cpSeq = 1;
  const cpPending = new Map<number, { resolve: (r: CpRelayResult) => void; timer: NodeJS.Timeout }>();
  child.on("message", (m: any) => {
    if (m?.t !== "cp_result") return;
    const p = cpPending.get(Number(m.id));
    if (!p) return;
    cpPending.delete(Number(m.id));
    clearTimeout(p.timer);
    const r = m.result as CpRelayResult | undefined;
    p.resolve(r && typeof r === "object" && (r.ok === true ? typeof r.status === "number" && typeof r.body === "string" : typeof r.reason === "string") ? r : { ok: false, reason: "cp_bad_reply" });
  });
  // 内容分发（第 8 批）：同上
  let distSeq = 1;
  const distPending = new Map<number, { resolve: (r: DistRelayResult) => void; timer: NodeJS.Timeout }>();
  child.on("message", (m: any) => {
    if (m?.t !== "dist_result") return;
    const p = distPending.get(Number(m.id));
    if (!p) return;
    distPending.delete(Number(m.id));
    clearTimeout(p.timer);
    const r = m.result as DistRelayResult | undefined;
    p.resolve(r && typeof r === "object" && (r.ok === true ? typeof r.status === "number" && typeof r.body_b64 === "string" : typeof r.reason === "string") ? r : { ok: false, reason: "dist_bad_reply" });
  });
  child.on("exit", (code, signal) => {
    alive = false;
    slog.event("CHILD_EXIT", { proc: "gate", code: Number.isInteger(code) ? code! : undefined, signal: signal ?? undefined });
    for (const [, p] of cpPending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, reason: "gate_exited" });
    }
    cpPending.clear();
    for (const [, p] of distPending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, reason: "gate_exited" });
    }
    distPending.clear();
    o.onExit?.(code);
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("出站闸门启动超时"));
    }, o.startTimeoutMs ?? 20_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`出站闸门进程退出（${code}）`));
    });
    child.on("message", (m: any) => {
      if (m?.t === "fatal") {
        clearTimeout(timer);
        reject(new Error(String(m.message)));
      }
      if (m?.t !== "ready") return;
      clearTimeout(timer);
      resolve({
        socketPath: o.socketPath,
        process: child,
        get alive() {
          return alive && child.connected;
        },
        revoke: (runId: string) => {
          if (child.connected) child.send({ t: "revoke", runId });
        },
        updateSeat: (token: string) => {
          if (child.connected) child.send({ t: "seat", token });
        },
        cp: (req: CpRelayRequest, timeoutMs = 20_000) =>
          new Promise<CpRelayResult>((res) => {
            if (!child.connected) return res({ ok: false, reason: "gate_exited" });
            const id = cpSeq++;
            const timer = setTimeout(() => {
              cpPending.delete(id);
              res({ ok: false, reason: "cp_timeout" });
            }, timeoutMs);
            cpPending.set(id, { resolve: res, timer });
            child.send({ t: "cp", id, req });
          }),
        dist: (path: string, timeoutMs = 150_000) =>
          new Promise<DistRelayResult>((res) => {
            if (!child.connected) return res({ ok: false, reason: "gate_exited" });
            const id = distSeq++;
            const timer = setTimeout(() => {
              distPending.delete(id);
              res({ ok: false, reason: "dist_timeout" });
            }, timeoutMs);
            distPending.set(id, { resolve: res, timer });
            child.send({ t: "dist", id, path });
          }),
        close: () =>
          new Promise<void>((r) => {
            if (!child.connected) return r();
            child.once("exit", () => r());
            child.send({ t: "shutdown" });
            setTimeout(() => {
              child.kill("SIGKILL");
              r();
            }, 2_000).unref();
          }),
      });
    });
    child.send({ t: "init", config: { socketPath: o.socketPath, upstreams: o.upstreams, ...(o.approvalKeys ? { approvalKeys: o.approvalKeys } : {}) } });
  });
}

/** 事项令牌密钥（每事项 32 字节随机；内核数据库页级加密保存；G1 随端到端加密共享同步给成员设备）。 */
export function newMatterTokenKey(): Buffer {
  return randomBytes(32);
}
