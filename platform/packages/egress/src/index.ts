/**
 * 出站闸门 v0（方案 v5.0 第 4 篇 §8.3 与 §1.1 约束 2：离开律所侧之前检查并记录）。
 *
 * 内核里唯一可以发起外部网络请求的通道；工作流、Agent 工具、法源连接器都只能调用它：
 * - 目的地白名单（按主机分列，清单即第 6 篇 §14 的“出站域名、IP 与进程清单”数据源）；
 * - 事项策略：当事人告知同意状态、模型端点、保密等级（v0：strict=拒绝云端）；
 * - 化名校验：对模型请求逐段扫描直接标识符，发现未替换即拦截或补替换（按策略），并记录；
 * - 逐段数据去向记录：目的地、字符数、化名统计、请求 ID——“数据去向卡”的数据源。
 *
 * v0 边界：IM 收发与云盘同步不经本闸门（由节点连接器与同步模块写入数据去向记录，G0 第 5–6 周）。
 */
import { DomainError, newId, type ConsentStatus, type Matter, type ModelEndpoint } from "@zr-legal/domain";
import { canonicalJson, sha256B64 } from "@zr-legal/keys";
import { scanDirectIdentifiers, replaceDirectIdentifiers } from "@zr-legal/pseudonym";

/** 外发目的地类别（数据去向卡以此分组；IM 收发与同步介质记录在同一张表）。 */
export type DestinationKind =
  | "maas_model" // 中软 MaaS 法律专用分组（标准端点）
  | "byok_model" // 律所自带密钥（直签月之暗面，不经中软）
  | "private_model" // 律所内私有模型端点
  | "moonshot_verify" // Kimi 模型真实性校验接口
  | "law_source" // 授权法源数据商（去标识查询）
  | "timestamp" // RFC 3161 时间戳服务（只发 hash）
  | "content_update" // 中软许可与内容分发（只下行）
  | "support_upload" // 工单与诊断包（律师预览后手动）
  | "im_inbound" // 律所自有 IM 入站（机器人收文件/消息，§11.2 写入数据去向记录）
  | "im_outbound" // 律所自有 IM 出站（卡片/文件回执与审批投递）
  | "mock_local"; // 本机 mock 提供方：无网络外发，如实记录

export interface EgressRecord {
  record_id: string;
  tenant_id: string;
  matter_id: string;
  run_id: string | null;
  attempt_id: string | null;
  destination_kind: DestinationKind;
  destination_host: string;
  request_id: string | null;
  client_idempotency_id: string | null;
  chars: number;
  segments: number;
  pseudonym_findings: number;
  pseudonym_counts: Record<string, number>;
  doc_refs: { document_version_id?: string; filename?: string; chars: number }[];
  note: string | null;
  outcome: "sent" | "blocked" | "failed" | "mock";
  created_at: string;
}

/** 最小存储接口（由内核账本实现；避免 egress → kernel 反向依赖）。 */
export interface EgressStore {
  run(sql: string, params: unknown[]): void;
  all<T>(sql: string, params: unknown[]): T[];
  /** 可选事务包装（内核提供：去向记录插入与签名事件链 append 同事务提交）。 */
  tx?<T>(fn: () => T): T;
  /** 可选：记录落库后回调（内核接入签名事件 hash 链；payloadHash 为整行 canonical JSON 的 sha256）。 */
  onRecord?(rec: { recordId: string; matterId: string; payloadHash: string }): void;
}

export interface EgressPolicy {
  /** 目的地类别 → 允许的主机名（白名单按主机分列；空数组 = 该类别一律拒绝）。 */
  allowedHosts: Record<DestinationKind, readonly string[]>;
  /** 化名校验策略：block = 发现未替换直接标识符即拦截；replace = 补替换并记录。 */
  pseudonymPolicy: "block" | "replace";
}

export interface EgressTaskRef {
  tid: string;
  uid: string;
  mid: string;
  rid?: string | undefined;
  aid?: string | undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class EgressBlockedError extends DomainError {
  constructor(message: string, detail?: Record<string, unknown>) {
    super("egress_blocked", message, 422, detail);
    this.name = "EgressBlockedError";
  }
}

const BASIS_LABELS: Readonly<Record<string, string>> = {
  engagement: "委托/保密授权",
  personal_info: "个人信息处理依据",
  sensitive: "敏感信息特别条件",
  subprocessor: "转委托与次处理者",
};

/** 四项依据中“待确认”的项目名（未记录四项或记录不规范时返回 null，按旧口径判定）。 */
export function pendingBasisLabels(basis: string | null | undefined): string[] | null {
  if (!basis) return null;
  try {
    const v = JSON.parse(basis) as Record<string, unknown>;
    const ok = (x: unknown) => x === "confirmed" || x === "pending" || x === "not_applicable";
    if (!Object.keys(BASIS_LABELS).every((k) => ok(v[k]))) return null;
    return Object.keys(BASIS_LABELS).filter((k) => v[k] === "pending").map((k) => BASIS_LABELS[k]!);
  } catch {
    return null;
  }
}

export class EgressGate {
  private readonly store: EgressStore;
  private readonly policy: EgressPolicy;

  constructor(store: EgressStore, policy: EgressPolicy) {
    this.store = store;
    this.policy = policy;
  }

  /** 目的地白名单：按主机名列；不在清单一律拒绝（§8.3：其他一律拒绝）。 */
  assertHostAllowed(kind: DestinationKind, host: string): void {
    if (kind === "mock_local") return; // 无网络
    const allowed = this.policy.allowedHosts[kind] ?? [];
    if (!allowed.includes(host)) {
      throw new EgressBlockedError(`出站目的地 ${host} 不在白名单（类别 ${kind}）；清单见「连接」页与合规材料包`, {
        kind,
        host,
        allowed,
      });
    }
  }

  /**
   * 事项策略的前置检查（人话拦截；出站闸门另行独立裁决——v9 第 02 篇 §8.1、§8.2）：
   * - 四项依据（委托/保密授权、个人信息处理依据、敏感信息特别条件、转委托与次处理者）分项记录时按四项判定，任一“待确认”只用本机能力
   *   （复核 S5-A09：与闸门、宿主同一口径）；未记录四项的旧事项按当事人同意状态（「待取得」= 只用本机能力）；
   * - 当事人拒绝云端处理（记录）= 只能私有模型或不使用模型；模型端点 none = 不使用模型；当事人限制（L3b）= 只允许律所私有端点；
   * - 后台不得自动切换；本方法只负责在给定策略下裁决。
   */
  assertMatterAllowsModel(matter: Pick<Matter, "consent_status" | "model_endpoint" | "confidentiality"> & { basis?: string | null }, endpoint: ModelEndpoint): void {
    if (matter.model_endpoint !== endpoint) {
      throw new EgressBlockedError(
        `任务请求的模型端点（${endpoint}）与事项当前端点（${matter.model_endpoint}）不一致；变更端点须本人在事项中确认`,
      );
    }
    if (endpoint === "none") {
      throw new EgressBlockedError("该事项设置为「不使用模型」：只用本机确定性工具与人工。");
    }
    const consent: ConsentStatus = matter.consent_status;
    if (consent === "refused" && endpoint !== "private") {
      throw new EgressBlockedError("当事人已拒绝云端处理（记录）：只能使用律所私有模型端点或不使用模型。", { consent_status: consent });
    }
    const LOCAL_ONLY = "本任务只能使用本机能力（解析、检索、法条核验、比对、计算、脱敏、文书生成）";
    const pending = pendingBasisLabels(matter.basis);
    if (pending !== null) {
      if (pending.length > 0) {
        throw new EgressBlockedError(`四项依据有“待确认”（${pending.join("、")}）：${LOCAL_ONLY}。请在事项头补录依据，或一键生成告知函。`, { basis_pending: pending });
      }
    } else if (consent === "pending") {
      throw new EgressBlockedError(`依据待确认（旧事项记录的当事人同意为「待取得」）：${LOCAL_ONLY}。请在事项头补录四项依据，或一键生成告知函。`, { consent_status: consent });
    }
    if (matter.confidentiality === "strict" && endpoint !== "private") {
      throw new EgressBlockedError("当事人限制（L3b）：不使用云端模型，只允许律所私有模型端点。", {
        confidentiality: matter.confidentiality,
      });
    }
  }

  /** 单请求 200K 字符、单任务累计 1M 字符（v0 上限；G0 实测校准）。 */
  static readonly MAX_CHARS_PER_REQUEST = 200_000;
  static readonly MAX_CHARS_PER_TASK = 1_000_000;

  private assertByteCaps(task: EgressTaskRef, texts: string[]): void {
    const chars = texts.reduce((n, t) => n + (t?.length ?? 0), 0);
    if (chars > EgressGate.MAX_CHARS_PER_REQUEST) {
      throw new EgressBlockedError(`单请求外发 ${chars.toLocaleString()} 字符超出上限 ${EgressGate.MAX_CHARS_PER_REQUEST.toLocaleString()}（§8.3 范围）：请缩小发送范围或拆分任务`, {
        chars,
        cap: EgressGate.MAX_CHARS_PER_REQUEST,
      });
    }
    if (task.rid) {
      const row = this.store.all<{ total: number }>(`SELECT COALESCE(SUM(chars), 0) AS total FROM egress_records WHERE run_id = ? AND outcome IN ('sent','mock')`, [task.rid]);
      const used = row[0]?.total ?? 0;
      if (used + chars > EgressGate.MAX_CHARS_PER_TASK) {
        throw new EgressBlockedError(
          `单任务累计外发将超上限 ${EgressGate.MAX_CHARS_PER_TASK.toLocaleString()} 字符（已发 ${used.toLocaleString()} + 本次 ${chars.toLocaleString()}，§8.3 范围）：请拆分任务或转人工`,
          { used, chars, cap: EgressGate.MAX_CHARS_PER_TASK },
        );
      }
    }
  }

  /** 单请求 200K、单任务 1M（常量导出供界面提示）。 */
  static caps(): { perRequest: number; perTask: number } {
    return { perRequest: EgressGate.MAX_CHARS_PER_REQUEST, perTask: EgressGate.MAX_CHARS_PER_TASK };
  }

  /**
   * 模型请求出站：化名校验（逐段扫描）→ 白名单 → 范围上限 → 写入数据去向记录。
   * 化名校验两策略（§8.3：发现未替换即补替换或拦截，并记录）：
   * - block：发现未替换直接标识符即拦截（记录真实 findings，outcome=blocked）；
   * - replace：就地补替换并返回替换后文本——**调用方必须发送返回的 texts，绝不发送原文**。
   * 范围（§8.3）：单请求与单任务字节上限（只计已发出 outcome=sent/mock）。
   */
  beforeModelSend(args: {
    matter: Matter;
    task: EgressTaskRef;
    endpoint: ModelEndpoint;
    destinationHost: string;
    texts: string[];
    requestId: string | null;
    clientIdempotencyId: string;
    docRefs?: EgressRecord["doc_refs"];
    note?: string | undefined;
  }): { recordId: string; pseudonymFindings: number; texts: string[] } {
    const kind: DestinationKind =
      args.endpoint === "standard" ? "maas_model" : args.endpoint === "byok" ? "byok_model" : args.endpoint === "private" ? "private_model" : "mock_local";
    this.assertMatterAllowsModel(args.matter, args.endpoint);
    this.assertHostAllowed(kind, args.destinationHost);
    this.assertByteCaps(args.task, args.texts);

    let findings = 0;
    const counts: Record<string, number> = {};
    let outTexts = args.texts;
    if (this.policy.pseudonymPolicy === "replace") {
      // 补替换：逐段替换直接标识符（§8.3），发送方使用返回文本
      outTexts = [];
      for (const text of args.texts) {
        if (!text) {
          outTexts.push(text);
          continue;
        }
        const r = replaceDirectIdentifiers(text);
        if (r.replaced > 0) {
          findings += r.replaced;
          for (const [k, v] of Object.entries(r.counts)) counts[k] = (counts[k] ?? 0) + v;
        }
        outTexts.push(r.text);
      }
    } else {
      for (const text of args.texts) {
        if (!text) continue;
        const scan = scanDirectIdentifiers(text);
        if (scan.findings.length === 0) continue;
        findings += scan.findings.length;
        for (const [k, v] of Object.entries(scan.counts)) counts[k] = (counts[k] ?? 0) + v;
      }
      if (findings > 0) {
        const recordId = this.insertRecord(args, kind, args.destinationHost, findings, counts, "已拦截：外发内容含未替换的直接标识符", "blocked");
        throw new EgressBlockedError(
          `化名校验拦截：外发片段含 ${findings} 处未替换的直接标识符（${Object.keys(counts).join("/")}），已阻止发送并记录（去向记录 ${recordId}）。请先执行全流程化名。`,
          { counts, record_id: recordId },
        );
      }
    }

    const recordId = this.insertRecord(args, kind, args.destinationHost, findings, counts, args.note ?? null, "sent");
    return { recordId, pseudonymFindings: findings, texts: outTexts };
  }

  /** mock 提供方：无网络外发，也如实写去向记录；扫描照做、如实标记（mock 链路未经化名校验）。 */
  recordMock(args: { matter: Matter; task: EgressTaskRef; texts: string[]; requestId: string; clientIdempotencyId: string; note?: string | undefined }): string {
    let findings = 0;
    const counts: Record<string, number> = {};
    for (const text of args.texts) {
      if (!text) continue;
      const scan = scanDirectIdentifiers(text);
      if (scan.findings.length === 0) continue;
      findings += scan.findings.length;
      for (const [k, v] of Object.entries(scan.counts)) counts[k] = (counts[k] ?? 0) + v;
    }
    const base =
      findings > 0
        ? `mock 提供方：模型推理在本机模拟，无任何网络外发；本机扫描发现 ${findings} 处直接标识符（mock 链路未经化名校验；真实链路在出站闸门强制校验）`
        : "mock 提供方：模型推理在本机模拟，无任何网络外发";
    return this.insertRecord(args, "mock_local", "（本机，未外发）", findings, counts, args.note ? `${base}；${args.note}` : base, "mock");
  }

  /** 发送失败：把已写入的记录标记为失败（去向卡不把「未发出」记为外发）。 */
  markFailed(recordId: string, message: string): void {
    this.store.run(`UPDATE egress_records SET outcome = 'failed', note = COALESCE(note || '；', '') || ? WHERE record_id = ?`, [
      `发送失败：${message.slice(0, 200)}`,
      recordId,
    ]);
  }

  private insertRecord(
    args: { matter: Matter; task: EgressTaskRef; texts: string[]; requestId: string | null; clientIdempotencyId: string; docRefs?: EgressRecord["doc_refs"] },
    kind: DestinationKind,
    destinationHost: string,
    pseudonymFindings: number,
    pseudonymCounts: Record<string, number>,
    note: string | null,
    outcome: "sent" | "blocked" | "mock",
  ): string {
    const recordId = newId("egressRecord");
    const chars = args.texts.reduce((n, t) => n + (t?.length ?? 0), 0);
    // 落库行（对象形态与 SELECT * 同构：内核签名链按整行 canonical JSON 重算 payload_hash）
    const stored = {
      record_id: recordId,
      tenant_id: args.task.tid,
      matter_id: args.task.mid,
      run_id: args.task.rid ?? null,
      attempt_id: args.task.aid ?? null,
      destination_kind: kind,
      destination_host: destinationHost,
      request_id: args.requestId,
      client_idempotency_id: args.clientIdempotencyId,
      chars,
      segments: args.texts.filter((t) => t && t.length > 0).length,
      pseudonym_findings: pseudonymFindings,
      pseudonym_counts: JSON.stringify(pseudonymCounts),
      doc_refs: JSON.stringify(args.docRefs ?? []),
      note,
      outcome,
      created_at: nowIso(),
    };
    const write = () => {
      this.store.run(
        `INSERT INTO egress_records
          (record_id, tenant_id, matter_id, run_id, attempt_id, destination_kind, destination_host,
           request_id, client_idempotency_id, chars, segments, pseudonym_findings, pseudonym_counts, doc_refs, note, outcome, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          stored.record_id,
          stored.tenant_id,
          stored.matter_id,
          stored.run_id,
          stored.attempt_id,
          stored.destination_kind,
          stored.destination_host,
          stored.request_id,
          stored.client_idempotency_id,
          stored.chars,
          stored.segments,
          stored.pseudonym_findings,
          stored.pseudonym_counts,
          stored.doc_refs,
          stored.note,
          stored.outcome,
          stored.created_at,
        ],
      );
      this.store.onRecord?.({ recordId, matterId: stored.matter_id, payloadHash: egressRecordEnvelopeHash(stored) });
    };
    if (this.store.tx) this.store.tx(write);
    else write();
    return recordId;
  }

  /** 数据去向卡数据源：按任务或事项列出（界面与审计导出共用，只读；事项级最多 200 条并给出截断标记）。 */
  listRecords(args: { runId?: string; matterId?: string }): EgressRecord[] {
    if (args.runId) {
      return this.store.all<EgressRecord>(`SELECT * FROM egress_records WHERE run_id = ? ORDER BY created_at`, [args.runId]).map(deserialize);
    }
    if (args.matterId) {
      return this.store.all<EgressRecord>(`SELECT * FROM egress_records WHERE matter_id = ? ORDER BY created_at DESC LIMIT 200`, [args.matterId]).map(deserialize);
    }
    return [];
  }

}

function deserialize(r: any): EgressRecord {
  return {
    ...r,
    pseudonym_counts: typeof r.pseudonym_counts === "string" ? JSON.parse(r.pseudonym_counts) : (r.pseudonym_counts ?? {}),
    doc_refs: typeof r.doc_refs === "string" ? JSON.parse(r.doc_refs) : (r.doc_refs ?? []),
  };
}

/** 出站内容关键事实在备注中的字段（预写时确定；补全、清扫与对账都不改写它们）。 */
export const EGRESS_CONTENT_FIELDS = ["purpose", "query", "url", "host_decision", "approval_id", "media", "model"] as const;

/**
 * 出站内容摘要（阶段 4 复核 S4-21、终核残余）：由去向列与备注中的内容字段计算——插入时写入 content_digest 并计入签名信封；
 * 校验签名链时按当前备注重算，备注里的检索原文、URL、裁决等被改即校验失败。
 */
export function egressContentDigest(r: { destination_kind: string; destination_host: string; note: string | null }): string {
  let note: Record<string, unknown> = {};
  try {
    note = JSON.parse(r.note ?? "{}") as Record<string, unknown>;
  } catch {
    note = {};
  }
  const url = note.url as { requested?: unknown; final?: unknown } | undefined;
  return sha256B64(
    canonicalJson({
      destination_kind: r.destination_kind,
      destination_host: r.destination_host,
      purpose: note.purpose ?? null,
      query: note.query ?? null,
      url: url ? { requested: url.requested ?? null, final: url.final ?? null } : null,
      host_decision: note.host_decision ?? null,
      approval: note.approval_id ?? null,
      media: note.media ?? [],
      model: note.model ?? null,
    }),
  );
}

/**
 * 签名信封哈希（§6.4）：只含插入时确定、之后不变的数据去向关键事实——
 * 目的地、事项/任务归属、字符数、化名统计、文档引用、客户端幂等 ID、时间，以及出站内容摘要 content_digest
 * （闸门记录：检索原文与发出的查询、URL、裁决、载荷摘要、模型；阶段 4 复核 S4-21。为空时不入信封，旧记录的哈希不变）。
 * 排除插入后可变的生命周期列：request_id（broker 回填）、outcome、note 与 completed（两阶段补全另记签名审计事件）。
 * 该口径与内核 ledger-signer recomputePayloadHash 的 egress_record 分支一一对应（同改须同步）。
 */
export function egressRecordEnvelopeHash(r: {
  record_id: string;
  tenant_id: string;
  matter_id: string;
  run_id: string | null;
  attempt_id: string | null;
  destination_kind: string;
  destination_host: string;
  client_idempotency_id: string;
  chars: number;
  segments: number;
  pseudonym_findings: number;
  pseudonym_counts: string;
  doc_refs: string;
  created_at: string;
  content_digest?: string | null;
}): string {
  return sha256B64(
    canonicalJson({
      ...(r.content_digest ? { content_digest: r.content_digest } : {}),
      record_id: r.record_id,
      tenant_id: r.tenant_id,
      matter_id: r.matter_id,
      run_id: r.run_id,
      attempt_id: r.attempt_id,
      destination_kind: r.destination_kind,
      destination_host: r.destination_host,
      client_idempotency_id: r.client_idempotency_id,
      chars: r.chars,
      segments: r.segments,
      pseudonym_findings: r.pseudonym_findings,
      pseudonym_counts: r.pseudonym_counts,
      doc_refs: r.doc_refs,
      created_at: r.created_at,
    }),
  );
}
