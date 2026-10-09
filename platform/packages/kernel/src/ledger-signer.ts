/**
 * 签名事件 hash 链（方案 v5.0 第 4 篇 §5.2 事件头 + §6.4 审计链）。
 * 每台主机一条链：业务行（run_events/audit_events/egress_records/approvals）仍是权威投影，
 * 本模块在同事务内追加签名见证行（payload_hash 重算可检测业务行被改；prev_hash 断链可检测
 * 删除/重排；签名可检测见证行被改）。内核每日对链头签名形成检查点（时间戳锚定后续阶段）。
 *
 * 事件头（§5.2 最小化）：matter_id、type、作者设备（signer_device_id + 签名）、Lamport 时钟、
 * 密钥纪元、作者所见最近一次吊销检查点 hash（rev_checkpoint_hash）、prev_hash、event_hash、签名。
 * 撤权校验不依赖时钟：见 assertIncomingEventAcceptable（§5.2）。
 */
import { createHash, randomUUID } from "node:crypto";
import { canonicalJson, sha256B64, signBytes, verifyBytes, type DeviceCertificate } from "@zr-legal/keys";
import { DomainError, newId } from "@zr-legal/domain";
import { egressRecordEnvelopeHash } from "@zr-legal/egress";
import type { KernelDb } from "./db.ts";

export type SignedKind = "run_event" | "audit_event" | "egress_record" | "approval";

export interface LedgerSigner {
  readonly deviceId: string;
  /** 追加签名见证（须在业务行插入的同一事务内调用；payloadHash 由调用方按种类规则算好）。 */
  append(input: { kind: SignedKind; refId: string; matterId: string | null; type: string; payloadHash: string }): void;
  /** 对当前链头签名写检查点；链为空或链头未变返回 null。 */
  checkpoint(kind: "daily" | "manual"): { checkpointId: string; uptoSeq: number; headHash: string } | null;
  /** 全量重放校验（见 verifyChain 返回）。 */
  verifyChain(): ChainVerifyResult;
}

export interface ChainFailure {
  seq: number;
  reason: string;
}

export interface ChainVerifyResult {
  ok: boolean;
  checked: number;
  first_bad_seq: number | null;
  failures: ChainFailure[];
  checkpoints: { checkpoint_id: string; upto_seq: number; kind: string; ok: boolean; reason: string | null }[];
  /** 链中出现过的、当前已吊销的签名设备（历史签名仍验签通过，状态如实单列）。 */
  revoked_signers: string[];
}

interface SignedEventRow {
  seq: number;
  kind: SignedKind;
  ref_id: string;
  matter_id: string | null;
  type: string;
  payload_hash: string;
  lamport: number;
  key_epoch: number;
  rev_checkpoint_hash: string;
  prev_hash: string | null;
  event_hash: string;
  signature: string;
  signer_device_id: string;
}

export function createLedgerSigner(deps: { db: KernelDb; deviceId: string; signPrivateKeyPem: string; tenantId: string }): LedgerSigner {
  const { db, deviceId, signPrivateKeyPem, tenantId } = deps;

  function head(): { seq: number; event_hash: string; lamport: number } | undefined {
    return db.get<{ seq: number; event_hash: string; lamport: number }>(`SELECT seq, event_hash, lamport FROM signed_events ORDER BY seq DESC LIMIT 1`, []);
  }

  function tenantEpoch(): number {
    const r = db.get<{ e: number | null }>(`SELECT MAX(epoch) AS e FROM key_epochs WHERE scope = 'tenant' AND scope_id = ?`, [tenantId]);
    return r?.e ?? 1;
  }

  function revCheckpointHash(): string {
    const row = db.get(`SELECT scope, scope_id, epoch, reason, created_at FROM key_epochs WHERE scope = 'tenant' AND scope_id = ? ORDER BY epoch DESC LIMIT 1`, [tenantId]);
    return row ? sha256B64(canonicalJson(row)) : "";
  }

  return {
    deviceId,

    append(input) {
      const last = head();
      const lamport = (last?.lamport ?? 0) + 1;
      const keyEpoch = tenantEpoch();
      const revHash = revCheckpointHash();
      const prevHash = last?.event_hash ?? null;
      const eventHash = sha256B64(
        canonicalJson({
          kind: input.kind,
          ref_id: input.refId,
          matter_id: input.matterId,
          type: input.type,
          payload_hash: input.payloadHash,
          lamport,
          key_epoch: keyEpoch,
          rev_checkpoint_hash: revHash,
          prev_hash: prevHash,
        }),
      );
      const signature = signBytes(signPrivateKeyPem, new TextEncoder().encode(eventHash));
      db.run(
        `INSERT INTO signed_events (kind, ref_id, matter_id, type, payload_hash, lamport, key_epoch, rev_checkpoint_hash, prev_hash, event_hash, signature, signer_device_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [input.kind, input.refId, input.matterId, input.type, input.payloadHash, lamport, keyEpoch, revHash, prevHash, eventHash, signature, deviceId],
      );
    },

    checkpoint(kind) {
      const last = head();
      if (!last) return null;
      const existing = db.get<{ head_hash: string }>(`SELECT head_hash FROM chain_checkpoints ORDER BY created_at DESC, rowid DESC LIMIT 1`, []);
      if (existing?.head_hash === last.event_hash) return null; // 链头未变则跳过
      const checkpointId = `ckp_${randomUUID()}`;
      db.run(`INSERT INTO chain_checkpoints (checkpoint_id, upto_seq, head_hash, kind, signer_device_id, signature) VALUES (?,?,?,?,?,?)`, [
        checkpointId,
        last.seq,
        last.event_hash,
        kind,
        deviceId,
        signBytes(signPrivateKeyPem, new TextEncoder().encode(last.event_hash)),
      ]);
      return { checkpointId, uptoSeq: last.seq, headHash: last.event_hash };
    },

    verifyChain(): ChainVerifyResult {
      const rows = db.all<SignedEventRow>(`SELECT * FROM signed_events ORDER BY seq`, []);
      const failures: ChainFailure[] = [];
      const revokedSigners = new Set<string>();
      let prevHash: string | null = null;
      const firmRow = db.get<{ root_public_key_pem: string }>(`SELECT root_public_key_pem FROM firm_identity WHERE tenant_id = ?`, [tenantId]);
      const rootPub = firmRow?.root_public_key_pem ?? null;
      const deviceCache = new Map<string, { cert: DeviceCertificate; status: string } | null>();

      const deviceOf = (deviceId2: string): { cert: DeviceCertificate; status: string } | null => {
        if (!deviceCache.has(deviceId2)) {
          const d = db.get<{ cert_json: string; status: string }>(`SELECT cert_json, status FROM devices WHERE device_id = ?`, [deviceId2]);
          let parsed: { cert: DeviceCertificate; status: string } | null = null;
          if (d) {
            try {
              parsed = { cert: JSON.parse(d.cert_json) as DeviceCertificate, status: d.status };
            } catch {
              parsed = null;
            }
          }
          deviceCache.set(deviceId2, parsed);
        }
        return deviceCache.get(deviceId2) ?? null;
      };

      // 证书链与归属核对（每条签名/检查点共用）：证书须被律所根密钥签出且 cert.deviceId 与签名设备一致
      const certProblems = (dev: { cert: DeviceCertificate; status: string }, expectedDeviceId: string): string | null => {
        if (!rootPub) return "firm_identity 缺失，无法验证书链";
        if (!verifyCertSignature(dev.cert, rootPub)) return "证书链验签失败";
        if (dev.cert.deviceId !== expectedDeviceId) return "证书与签名设备不符";
        return null;
      };

      for (const row of rows) {
        const fail = (reason: string) => failures.push({ seq: row.seq, reason });
        // 1. 业务行重算 payload_hash（检测业务行被改/被删）
        const recomputed = recomputePayloadHash(db, row.kind, row.ref_id);
        if (recomputed === null) fail(`业务行缺失或不可解析（${row.kind} ${row.ref_id}）`);
        else if (recomputed !== row.payload_hash) fail(`payload 不匹配：业务行内容与签名见证不符（疑似被改）`);
        // 2. 重算 event_hash（检测见证行字段被改；用库存 payload_hash 以隔离两类故障）
        const expectHash = sha256B64(
          canonicalJson({
            kind: row.kind,
            ref_id: row.ref_id,
            matter_id: row.matter_id,
            type: row.type,
            payload_hash: row.payload_hash,
            lamport: row.lamport,
            key_epoch: row.key_epoch,
            rev_checkpoint_hash: row.rev_checkpoint_hash,
            prev_hash: row.prev_hash,
          }),
        );
        if (expectHash !== row.event_hash) fail("event_hash 不符：见证行字段被改");
        // 3. prev 链接（检测删除/插入/重排）
        if (row.prev_hash !== prevHash) fail("prev_hash 断链：前行被删除、插入或重排");
        // 4. 验签（吊销设备的历史签名仍应验签通过；吊销状态单列报告）+ 证书链与归属核对
        const dev = deviceOf(row.signer_device_id);
        if (!dev) {
          fail(`签名设备 ${row.signer_device_id} 未登记`);
        } else {
          if (dev.status === "revoked") revokedSigners.add(row.signer_device_id);
          const certProblem = certProblems(dev, row.signer_device_id);
          if (certProblem) fail(certProblem);
          if (!verifyBytes(dev.cert.signPublicKeyPem, new TextEncoder().encode(row.event_hash), row.signature)) fail("签名验签失败");
        }
        prevHash = row.event_hash;
      }

      // 5. 检查点：签名有效且 head_hash 与对应 seq 的 event_hash 一致（证书链同样核对）
      const bySeq = new Map(rows.map((r) => [r.seq, r.event_hash]));
      const checkpoints = db
        .all<{ checkpoint_id: string; upto_seq: number; head_hash: string; kind: string; signer_device_id: string; signature: string }>(
          `SELECT checkpoint_id, upto_seq, head_hash, kind, signer_device_id, signature FROM chain_checkpoints ORDER BY created_at, rowid`,
          [],
        )
        .map((cp) => {
          let reason: string | null = null;
          const dev = deviceOf(cp.signer_device_id);
          const headAt = bySeq.get(cp.upto_seq);
          if (headAt === undefined) reason = `检查点指向的 seq ${cp.upto_seq} 不在链上`;
          else if (headAt !== cp.head_hash) reason = "检查点 head_hash 与链上该 seq 的 event_hash 不一致";
          else if (!dev) reason = `检查点签名设备 ${cp.signer_device_id} 未登记`;
          else {
            const certProblem = certProblems(dev, cp.signer_device_id);
            if (certProblem) reason = certProblem;
            else if (!verifyBytes(dev.cert.signPublicKeyPem, new TextEncoder().encode(cp.head_hash), cp.signature)) reason = "检查点签名验签失败";
          }
          return { checkpoint_id: cp.checkpoint_id, upto_seq: cp.upto_seq, kind: cp.kind, ok: reason === null, reason };
        });

      const firstBad = failures.length > 0 ? failures[0]!.seq : null;
      return { ok: failures.length === 0 && checkpoints.every((c) => c.ok), checked: rows.length, first_bad_seq: firstBad, failures, checkpoints, revoked_signers: [...revokedSigners] };
    },
  };
}

/** payload_hash 重算规则（与追加侧一一对应；改规则须两侧同改）。 */
export function recomputePayloadHash(db: KernelDb, kind: SignedKind, refId: string): string | null {
  if (kind === "run_event") {
    const row = db.get<{ run_id: string; attempt_id: string | null; seq: number; type: string; payload: string }>(
      `SELECT run_id, attempt_id, seq, type, payload FROM run_events WHERE event_id = ?`,
      [Number(refId)],
    );
    if (!row) return null;
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      return null;
    }
    return sha256B64(canonicalJson({ run_id: row.run_id, attempt_id: row.attempt_id, seq: row.seq, type: row.type, payload }));
  }
  if (kind === "audit_event") {
    const row = db.get(`SELECT * FROM audit_events WHERE audit_event_id = ?`, [Number(refId)]);
    return row ? sha256B64(canonicalJson(row)) : null;
  }
  if (kind === "egress_record") {
    // 签名信封口径（与 egress insertRecord 的 onRecord 一一对应，同改须同步）：
    // request_id 回填与 outcome 失败标记是生命周期列，在签名信封之外；
    // 目的地、事项归属、字符数、化名统计等数据去向关键事实在信封内。
    const row = db.get(`SELECT * FROM egress_records WHERE record_id = ?`, [refId]);
    return row ? egressRecordEnvelopeHash(row) : null;
  }
  // approval：payload_hash = sha256B64(signed_payload)
  const row = db.get<{ signed_payload: string | null }>(`SELECT signed_payload FROM approvals WHERE approval_id = ?`, [refId]);
  if (!row || typeof row.signed_payload !== "string") return null;
  return sha256B64(row.signed_payload);
}

/** run_event 追加侧的 payload_hash（与 recomputePayloadHash 的 run_event 分支同规则）。 */
export function runEventPayloadHash(runId: string, attemptId: string | null, seq: number, type: string, payload: Record<string, unknown>): string {
  return sha256B64(canonicalJson({ run_id: runId, attempt_id: attemptId, seq, type, payload }));
}

/** audit_event 追加侧的 payload_hash：整行 canonical（先插入再读回计算）。 */
export function rowPayloadHash(row: Record<string, unknown>): string {
  return sha256B64(canonicalJson(row));
}

/**
 * 审计事件签名漏斗（§6.4 统一路径）：audit_events 插入 + signed_events 见证在同一事务——
 * api 的 audit()、sync-engine 冲突事件、node-service 定时任务事件都走这里（直插不上链的路径不存在）。
 */
export function appendAuditEvent(
  db: KernelDb,
  signer: LedgerSigner,
  input: { tenantId: string; actorId: string; action: string; kind: string; objectId: string; matterId: string | null; detailHash?: string | undefined },
): void {
  db.tx(() => {
    const r = db.run(`INSERT INTO audit_events (tenant_id, actor_id, action, object_kind, object_id, detail_hash) VALUES (?,?,?,?,?,?)`, [
      input.tenantId,
      input.actorId,
      input.action,
      input.kind,
      input.objectId,
      input.detailHash ?? null,
    ]);
    const row = db.get<Record<string, unknown>>(`SELECT * FROM audit_events WHERE audit_event_id = ?`, [Number(r.lastInsertRowid)]);
    signer.append({ kind: "audit_event", refId: String(r.lastInsertRowid), matterId: input.matterId, type: input.action, payloadHash: rowPayloadHash(row ?? {}) });
  });
}

/**
 * IM 收发的数据去向记录（§8.3：IM 入站/出站也写入 egress_records——文件名、hash、
 * 发送对象（im_user_id 哈希化）、所在平台；与模型外发同一张表、同一签名信封口径）。
 */
export function recordImEgress(
  db: KernelDb,
  signer: LedgerSigner,
  input: {
    tenantId: string;
    matterId: string;
    kind: "im_inbound" | "im_outbound";
    platform: string;
    filename: string;
    bytes: Buffer;
    peerImId: string;
    note?: string | undefined;
    runId?: string | undefined;
  },
): string {
  const recordId = newId("egressRecord");
  const stored = {
    record_id: recordId,
    tenant_id: input.tenantId,
    matter_id: input.matterId,
    run_id: input.runId ?? null,
    attempt_id: null,
    destination_kind: input.kind,
    destination_host: input.platform,
    request_id: null,
    client_idempotency_id: `im-${recordId}`,
    chars: input.bytes.length,
    segments: 1,
    pseudonym_findings: 0,
    pseudonym_counts: "{}",
    doc_refs: JSON.stringify([{ filename: input.filename, chars: input.bytes.length }]),
    note: `IM ${input.kind === "im_inbound" ? "入站" : "出站"}：sha256=${sha256B64(new Uint8Array(input.bytes))}；对象=im:${sha256B64(input.peerImId).slice(0, 16)}；平台=${input.platform}${input.note ? `；${input.note}` : ""}`,
    outcome: "sent",
    created_at: new Date().toISOString(),
  };
  db.tx(() => {
    db.run(
      `INSERT INTO egress_records (record_id, tenant_id, matter_id, run_id, attempt_id, destination_kind, destination_host,
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
    signer.append({ kind: "egress_record", refId: recordId, matterId: input.matterId, type: `im.${input.kind === "im_inbound" ? "inbound" : "outbound"}`, payloadHash: egressRecordEnvelopeHash(stored) });
  });
  return recordId;
}
/**
 * 撤权校验不依赖时钟（§5.2）：被吊销设备引用「吊销后纪元之前」纪元的事件一律拒收——
 * 被吊销设备离线回填的事件无论时钟值多小都无效。供将来同步入口调用（本阶段自测）。
 */
export function assertIncomingEventAcceptable(db: KernelDb, input: { signerDeviceId: string; keyEpoch: number }): void {
  const dev = db.get<{ status: string; revoked_epoch: number | null }>(`SELECT status, revoked_epoch FROM devices WHERE device_id = ?`, [input.signerDeviceId]);
  if (!dev) throw new DomainError("revoked_device_event", `签名设备 ${input.signerDeviceId} 未登记，事件拒收`, 403);
  if (dev.status === "revoked" && input.keyEpoch < (dev.revoked_epoch ?? Number.MAX_SAFE_INTEGER)) {
    throw new DomainError(
      "revoked_device_event",
      `设备 ${input.signerDeviceId} 已吊销：其引用密钥纪元 ${input.keyEpoch} 早于吊销后纪元 ${dev.revoked_epoch} 的事件一律拒收（撤权校验不依赖时钟）`,
      403,
    );
  }
}

/** 证书链校验：根公钥对证书字段（除 signature）的 Ed25519 签名有效；有效期由调用方按业务时点判断。 */
export function verifyCertSignature(cert: DeviceCertificate, rootPublicKeyPem: string): boolean {
  const { signature, ...unsigned } = cert;
  return verifyBytes(rootPublicKeyPem, new TextEncoder().encode(canonicalJson(unsigned)), signature);
}

export function sha256HexOf(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}
