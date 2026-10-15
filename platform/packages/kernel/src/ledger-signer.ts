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
import { egressContentDigest, egressRecordEnvelopeHash } from "@zr-legal/egress";
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
  /** 同一校验，每 2,000 行让出一次事件循环（复核 B4-R12：长链同步校验会挡住子进程心跳与界面请求）。界面与节点调用走它。 */
  verifyChainAsync(): Promise<ChainVerifyResult>;
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
  /** 事项删除时按删除清单清除了内容的签名业务行（不判篡改；清单摘要与签名的 matter.purged 审计事件核对）。 */
  redacted?: number;
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

  const signer: LedgerSigner = {
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
      const it = verifySteps();
      let r = it.next();
      while (!r.done) r = it.next();
      return r.value;
    },

    async verifyChainAsync(): Promise<ChainVerifyResult> {
      const it = verifySteps();
      let r = it.next();
      while (!r.done) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        r = it.next();
      }
      return r.value;
    },
  };

  /** 校验的步骤：逐行核对，每 2,000 行暂停一次（同步调用方直接跑完，异步调用方在暂停处让出事件循环）。 */
  function* verifySteps(): Generator<void, ChainVerifyResult> {
      const rows = db.all<SignedEventRow>(`SELECT * FROM signed_events ORDER BY seq`, []);
      const failures: ChainFailure[] = [];
      const revokedSigners = new Set<string>();
      let prevHash: string | null = null;
      const firmRow = db.get<{ root_public_key_pem: string }>(`SELECT root_public_key_pem FROM firm_identity WHERE tenant_id = ?`, [tenantId]);
      const rootPub = firmRow?.root_public_key_pem ?? null;
      type Dev = { cert: DeviceCertificate; archived: ArchivedCert[]; status: string };
      const deviceCache = new Map<string, Dev | null>();

      const deviceOf = (deviceId2: string): Dev | null => {
        if (!deviceCache.has(deviceId2)) {
          const d = db.get<{ cert_json: string; status: string }>(`SELECT cert_json, status FROM devices WHERE device_id = ?`, [deviceId2]);
          let parsed: Dev | null = null;
          if (d) {
            try {
              parsed = { cert: JSON.parse(d.cert_json) as DeviceCertificate, archived: archivedCertsOf(db, deviceId2), status: d.status };
            } catch {
              parsed = null;
            }
          }
          deviceCache.set(deviceId2, parsed);
        }
        return deviceCache.get(deviceId2) ?? null;
      };

      // 证书链与归属核对（每条签名/检查点共用）：证书须被律所根密钥签出且 cert.deviceId 与签名设备一致
      const certProblem = (cert: DeviceCertificate, expectedDeviceId: string): string | null => {
        if (!rootPub) return "firm_identity 缺失，无法验证书链";
        if (!verifyCertSignature(cert, rootPub)) return "证书链验签失败";
        if (cert.deviceId !== expectedDeviceId) return "证书与签名设备不符";
        return null;
      };
      // 按当前证书核对；不通过再试同一设备编号的留档证书（换新密钥与恢复之间签出的历史，迁移 0024）——留档证书只对不晚于其
      // 留档时链上最大序号的行有效（复核 B4-R10，迁移 0025）：被替换下来的旧私钥即使泄露，也签不出被判为有效的新见证。都不通过报当前证书的问题
      const signatureProblem = (dev: Dev, expectedDeviceId: string, data: string, sig: string, badSig: string, seq: number): string | null => {
        const bytes = new TextEncoder().encode(data);
        const cur = certProblem(dev.cert, expectedDeviceId) ?? (verifyBytes(dev.cert.signPublicKeyPem, bytes, sig) ? null : badSig);
        if (cur === null) return null;
        return dev.archived.some((a) => seq <= a.supersededSeq && certProblem(a.cert, expectedDeviceId) === null && verifyBytes(a.cert.signPublicKeyPem, bytes, sig)) ? null : cur;
      };

      // 事项删除（迁移 0021）：清单内的行按“已清除”计、不判篡改——须同时满足（复核 C-A01）：
      //   ① 事项的删除审计事件 matter.purged 有签名见证（signed_events 里该审计行的见证，属于该事项），且其摘要等于当前清单摘要；
      //   ② 见证行本身属于该事项（signed_events.matter_id）；③ 业务行确为清除形态（运行事件 payload 为 {"redacted":true}；去向记录无备注、无文档引用）。
      // 任一不满足就照常核对——清单不能用来掩盖对其他事项或其他内容的改动；没有签名私钥就造不出①。
      const exempt = new Map<string, { mid: string; rowHash: string | null }>();
      try {
        for (const { matter_id: mid } of db.all<{ matter_id: string }>(`SELECT matter_id FROM matters WHERE lifecycle = 'purged'`, [])) {
          const list = db.all<{ kind: string; ref_id: string; row_hash: string | null }>(`SELECT kind, ref_id, row_hash FROM redacted_rows WHERE matter_id = ? ORDER BY kind, ref_id`, [mid]);
          if (list.length === 0) continue;
          const digest = redactionListDigest(list);
          const ev = db.get<{ detail_hash: string | null }>(
            `SELECT ae.detail_hash FROM audit_events ae
               JOIN signed_events se ON se.kind = 'audit_event' AND se.ref_id = CAST(ae.audit_event_id AS TEXT) AND se.matter_id = ae.object_id
              WHERE ae.action = 'matter.purged' AND ae.object_id = ? ORDER BY ae.audit_event_id DESC LIMIT 1`,
            [mid],
          );
          if (!ev || ev.detail_hash !== digest) {
            failures.push({ seq: -1, reason: `事项 ${mid} 的删除清单没有签名的删除审计事件背书，或与之不符（清单被改动）` });
            continue;
          }
          for (const r of list) exempt.set(`${r.kind}\u0000${r.ref_id}`, { mid, rowHash: r.row_hash });
        }
      } catch {
        // 迁移 0021 之前的库：没有删除清单
      }
      const isRedactedForm = (kind: string, refId: string): boolean => {
        if (kind === "run_event") return db.get<{ payload: string }>(`SELECT payload FROM run_events WHERE event_id = ?`, [Number(refId)])?.payload === '{"redacted":true}';
        if (kind === "egress_record") {
          const r = db.get<{ note: string | null; doc_refs: string }>(`SELECT note, doc_refs FROM egress_records WHERE record_id = ?`, [refId]);
          return !!r && r.note === null && r.doc_refs === "[]";
        }
        return false;
      };
      let redacted = 0;
      let stepped = 0;
      for (const row of rows) {
        if (++stepped % 2000 === 0) yield;
        const fail = (reason: string) => failures.push({ seq: row.seq, reason });
        // 1. 业务行重算 payload_hash（检测业务行被改/被删）
        const recomputed = recomputePayloadHash(db, row.kind, row.ref_id);
        const ex = exempt.get(`${row.kind}\u0000${row.ref_id}`);
        // 清除后形态的行摘要须与删除时记下的一致（复核 C-A08：保留的元数据同样防篡改）
        const listed = ex !== undefined && row.matter_id === ex.mid && isRedactedForm(row.kind, row.ref_id) && ex.rowHash !== null && redactedRowHash(db, row.kind, row.ref_id) === ex.rowHash;
        if (listed) redacted++;
        if (listed && recomputed !== row.payload_hash) {
          // 按删除清单清除了内容：不判篡改（见证行本身的 event_hash、链接与签名仍照常核对）
        } else if (recomputed === null) fail(`业务行缺失或不可解析（${row.kind} ${row.ref_id}）`);
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
          const problem = signatureProblem(dev, row.signer_device_id, row.event_hash, row.signature, "签名验签失败", row.seq);
          if (problem) fail(problem);
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
          else reason = signatureProblem(dev, cp.signer_device_id, cp.head_hash, cp.signature, "检查点签名验签失败", cp.upto_seq);
          return { checkpoint_id: cp.checkpoint_id, upto_seq: cp.upto_seq, kind: cp.kind, ok: reason === null, reason };
        });

      // 6. 删除清单完整性在第 0 步（豁免前）已核对：清单摘要须等于有签名见证的 matter.purged 审计事件里的摘要
      const firstBad = failures.length > 0 ? failures[0]!.seq : null;
      return { ok: failures.length === 0 && checkpoints.every((c) => c.ok), checked: rows.length, first_bad_seq: firstBad, failures, checkpoints, revoked_signers: [...revokedSigners], redacted };
  }
  return signer;
}

/**
 * 清除后形态的行摘要（复核 C-A08）：运行事件按 payload_hash 同一口径（payload 已是 {"redacted":true}）；去向记录取签名信封
 * （目的地、事项、字数、化名统计等元数据），不含已清除的备注。删除时记入 redacted_rows.row_hash，链复核逐行重算核对。
 */
export function redactedRowHash(db: KernelDb, kind: string, refId: string): string | null {
  if (kind === "run_event") return recomputePayloadHash(db, "run_event", refId);
  if (kind === "egress_record") {
    const row = db.get<Parameters<typeof egressRecordEnvelopeHash>[0]>(`SELECT * FROM egress_records WHERE record_id = ?`, [refId]);
    return row ? egressRecordEnvelopeHash(row) : null;
  }
  return null;
}

/** 删除清单摘要：按种类、编号排序的 [种类, 编号, 清除后行摘要]。写进签名的 matter.purged 审计事件。 */
export function redactionListDigest(list: readonly { kind: string; ref_id: string; row_hash: string | null }[]): string {
  return createHash("sha256").update(canonicalJson(list.map((r) => [r.kind, r.ref_id, r.row_hash]))).digest("hex");
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
    const row = db.get<Parameters<typeof egressRecordEnvelopeHash>[0] & { note: string | null }>(`SELECT * FROM egress_records WHERE record_id = ?`, [refId]);
    if (!row) return null;
    // 内容摘要按当前备注复算（阶段 4 终核：备注里的检索原文、URL、裁决被改即不匹配）
    if (row.content_digest && egressContentDigest(row) !== row.content_digest) return "content_digest_mismatch";
    return egressRecordEnvelopeHash(row);
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
 * 吊销墓碑（v9 阶段 6；控制面目录或本机吊销记下，含本机设备表里没有的设备）：墓碑里的设备，其事件一律拒收（复核 S6-B28）。
 */
export function deviceTombstoned(db: KernelDb, deviceId: string): boolean {
  return !!db.get(`SELECT 1 AS x FROM cp_revoked_devices WHERE device_id = ?`, [deviceId]);
}

/**
 * 撤权校验不依赖时钟（§5.2）：被吊销设备的事件一律拒收——不论段头自报的纪元（纪元写在签名设备自己签的段头里，
 * 且各设备的租户纪元是本机计数，不能作为放行依据；阶段 3 只拒“吊销后纪元之前”的事件，复核 S6-B28、S6-C08 收紧）。
 * 吊销墓碑里的设备（控制面目录或本机吊销记下，含本机设备表里没有的）同样一律拒收。
 */
export function assertIncomingEventAcceptable(db: KernelDb, input: { signerDeviceId: string; keyEpoch: number }): void {
  if (deviceTombstoned(db, input.signerDeviceId)) {
    throw new DomainError("revoked_device_event", `设备 ${input.signerDeviceId} 已吊销（吊销记录粘滞）：其事件一律拒收`, 403);
  }
  const dev = db.get<{ status: string; revoked_epoch: number | null }>(`SELECT status, revoked_epoch FROM devices WHERE device_id = ?`, [input.signerDeviceId]);
  if (!dev) throw new DomainError("revoked_device_event", `签名设备 ${input.signerDeviceId} 未登记，事件拒收`, 403);
  if (dev.status === "revoked") {
    throw new DomainError("revoked_device_event", `设备 ${input.signerDeviceId} 已吊销（吊销后纪元 ${dev.revoked_epoch ?? "?"}）：其事件一律拒收（撤权校验不依赖时钟）`, 403);
  }
}

export interface ArchivedCert {
  cert: DeviceCertificate;
  /** 留档时签名事件链的最大序号：只对不晚于它的见证有效（迁移 0025）。 */
  supersededSeq: number;
}

/** 某设备编号下被替换掉的证书（迁移 0024/0025，新替换的在前）；调用方逐张做证书链、编号与序号上界核对后再用。 */
export function archivedCertsOf(db: KernelDb, deviceId: string): ArchivedCert[] {
  const out: ArchivedCert[] = [];
  for (const r of db.all<{ cert_json: string; superseded_seq: number }>(`SELECT cert_json, superseded_seq FROM device_cert_history WHERE device_id = ? ORDER BY superseded_at DESC, rowid DESC`, [deviceId])) {
    try {
      out.push({ cert: JSON.parse(r.cert_json) as DeviceCertificate, supersededSeq: Number(r.superseded_seq) || 0 });
    } catch {
      // 不可解析的留档不参与验签
    }
  }
  return out;
}

/**
 * 用某设备的证书验一段签名：先当前证书、再留档证书；每张都须律所根签发且设备编号一致，留档证书另须见证序号不晚于其上界
 * （witnessSeq 为该签名在签名事件链上的见证行序号；没有见证即不用留档证书，复核 B4-R10）。
 * 返回验签通过的那张证书（null = 都不通过）。成果审批与删除回执共用（复核 B4-A11）。
 */
export function certVerifying(
  db: KernelDb,
  deviceId: string,
  current: DeviceCertificate | null,
  rootPublicKeyPem: string | null,
  data: Uint8Array,
  signature: string,
  witnessSeq: number | null,
): DeviceCertificate | null {
  if (!rootPublicKeyPem) return null;
  const ok = (c: DeviceCertificate) => c.deviceId === deviceId && verifyCertSignature(c, rootPublicKeyPem) && verifyBytes(c.signPublicKeyPem, data, signature);
  if (current && ok(current)) return current;
  if (witnessSeq === null) return null;
  for (const a of archivedCertsOf(db, deviceId)) if (witnessSeq <= a.supersededSeq && ok(a.cert)) return a.cert;
  return null;
}

/** 证书链校验：根公钥对证书字段（除 signature）的 Ed25519 签名有效；有效期由调用方按业务时点判断。 */
export function verifyCertSignature(cert: DeviceCertificate, rootPublicKeyPem: string): boolean {
  const { signature, ...unsigned } = cert;
  return verifyBytes(rootPublicKeyPem, new TextEncoder().encode(canonicalJson(unsigned)), signature);
}

export function sha256HexOf(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}
