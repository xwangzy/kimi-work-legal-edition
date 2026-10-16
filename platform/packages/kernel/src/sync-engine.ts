/**
 * 共享文件夹同步引擎（方案 §7.1/§7.2）：导出封口段 + 摄取合并。
 *
 * 合并规则（红线：不「最后写入者获胜」）：
 * - append-only 表（run_events/audit_events/egress_records/key_epochs/matter_keys）INSERT OR IGNORE；
 * - 状态类投影（matters/matter_members/runs/document_versions/parse_versions/approvals/devices）
 *   按「归属设备权威 + (lamport, device) 较新者胜」（sync_row_origin 追踪行来源）；
 *   runs 由发起主机权威（§6.1 任务归属：他机只读应用其事实）；
 * - 版本类（artifact_versions）：同一 (matter, kind, audience, version) 并发 → 双版本都保留
 *   （入段行以 max+1 版本落库）+ sync_conflicts 旗标 + conflict.detected 审计事件；
 * - 撤权回填拒收：assertIncomingEventAcceptable（§5.2 不依赖时钟）；
 * - 只同步「团队」事项：个人事项导出跳过、摄取整段跳过；无本机密钥的事项段跳过记告警——
 *   个人事项与无权限事项零字节出/入本机（红线）。
 *
 * 介质（第 11 批 S11）：律所共享文件夹（folder），或中软共享中继（relay，services/share-relay.ts 负责上传与取回）。
 * 中继介质的导出：段写进本机发件目录（不复制块——上传时直接读本机块库）；导出水位另记（relay_export_state，与共享文件夹互不影响）；
 * 段体（按事项密钥加密）内另附 `_relay_blob` 行——引用的每个密文块的封装摘要、大小与切块摘要，供接收方取块与核对
 * （块在中继上按**密文**摘要寻址，明文内容摘要只在加密的段体里）；事项没有新内容时不出段（总是附带的用户、设备等行另按摘要比对）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { canonicalJson, signSyncWith, unwrapMatterKey, verifyBytes, type DeviceCertificate } from "@zr-legal/keys";
import { checkSealed, keyRowsSigned, openSegmentBody, parseSegment, scanSegments, sealSegment, writeSegment, writeShareBlob, type KeyRow, type SegmentFile, type SyncRow } from "@zr-legal/sync";
import type { KernelDb } from "./db.ts";
import type { BlobStore } from "./blobs.ts";
import { assertIncomingEventAcceptable, appendAuditEvent, deviceTombstoned, verifyCertSignature } from "./ledger-signer.ts";
import type { KernelKeyContext } from "./devices.ts";

export interface SyncDeps {
  db: KernelDb;
  blobs: BlobStore;
  keyctx: KernelKeyContext;
  tenantId: string;
}

export interface SyncExportResult {
  segments: string[];
  skippedPersonal: string[];
  rowsExported: number;
}

/** 中继介质：每块大小（与中继服务的单块上限一致）。 */
export const RELAY_CHUNK_BYTES = 4 * 1024 * 1024;
/** 段体内的块清单行（只在中继介质的段里；接收方据此取块，摄取时不落库）。 */
export const RELAY_BLOB_TABLE = "_relay_blob";
export interface RelayBlobRef {
  /** 封装（密文）字节的 SHA-256。 */
  sha256: string;
  size: number;
  /** 按 RELAY_CHUNK_BYTES 切开后每块的 SHA-256。 */
  chunks: string[];
}

/** 把字节按固定大小切块并给出各块摘要（中继介质的上传与核对共用）。 */
export function relayChunks(buf: Buffer): { cid: string; bytes: Buffer }[] {
  const out: { cid: string; bytes: Buffer }[] = [];
  for (let off = 0; off < buf.length; off += RELAY_CHUNK_BYTES) {
    const bytes = buf.subarray(off, Math.min(buf.length, off + RELAY_CHUNK_BYTES));
    out.push({ cid: createHash("sha256").update(bytes).digest("hex"), bytes });
  }
  return out;
}

/** 摄取时每一段的去向（第 11 批：中继收件据此决定删除、保留待钥或丢弃）。 */
export type SegmentOutcome = "applied" | "own" | "seen" | "purged" | "personal" | "invalid" | "revoked" | "no_key" | "deferred";

export interface SyncImportResult {
  segmentsApplied: number;
  segmentsSkipped: number;
  rowsApplied: number;
  conflicts: { matter_id: string; kind: string; detail: string }[];
  skippedNoKey: string[];
  skippedPersonal: string[];
  /** 本机已删除的事项：其段不再导入（迁移 0021）。 */
  skippedPurged: string[];
  rejectedRevoked: string[];
  /** 归属冲突（应当-3：非归属设备试图覆盖归属设备状态，已保留本机行）。 */
  originConflicts: string[];
  warnings: { tmpFiles: string[]; conflictCopies: string[] };
  /** 每段的去向（按段编号）。 */
  dispositions: { segment_id: string; matter_id: string; path: string; outcome: SegmentOutcome }[];
}

/** 每段都会附带的行（与事项内容是否变化无关）：中继介质按它们的摘要判断是否需要出段。 */
const ALWAYS_TABLES = new Set(["users", "matters", "devices", "im_bindings", "matter_members"]);

/** 摄取时记来源设备（sync_row_origin）的表：中继介质只发来源是本机的行。 */
const ORIGIN_TABLES = new Set(["runs", "document_versions", "artifact_versions"]);

const APPEND_ONLY_TABLES = new Set(["run_events", "audit_events", "egress_records", "key_epochs", "matter_keys"]);

/** 各表的主键列（单行主键）。 */
const TABLE_PK: Record<string, string> = {
  matters: "matter_id",
  matter_members: "member_key", // 合成 matter_id|user_id
  runs: "run_id",
  run_events: "event_id",
  audit_events: "audit_event_id",
  egress_records: "record_id",
  document_versions: "document_version_id",
  parse_versions: "parse_version_id",
  artifact_versions: "artifact_version_id",
  approvals: "approval_id",
  devices: "device_id",
  users: "user_id",
  node_tasks: "task_id",
  scheduled_jobs: "job_id",
  im_intents: "intent_id",
  im_bindings: "binding_key", // 合成 platform|im_user_id
  matter_keys: "key_key", // 合成 matter_id|epoch|wrapped_for
  key_epochs: "epoch_key", // 合成 scope|scope_id|epoch
};

function nowIso(): string {
  return new Date().toISOString();
}

/** 当前事项密钥纪元：本机持有面向自己包裹的最高纪元（第 11 批复核 S11A-02：没有本机包裹的纪元不改变本机的加密密钥）。 */
function currentMatterEpoch(db: KernelDb, matterId: string, deviceId: string): number {
  const r = db.get<{ e: number | null }>(`SELECT MAX(epoch) AS e FROM matter_keys WHERE matter_id = ? AND wrapped_for = ?`, [matterId, deviceId]);
  return r?.e ?? 1;
}

function resolveMatterKey(db: KernelDb, matterId: string, epoch: number, deviceId: string, encPrivateKeyPem: string): Uint8Array | null {
  const row = db.get<{ wrapped_key: string }>(`SELECT wrapped_key FROM matter_keys WHERE matter_id = ? AND epoch = ? AND wrapped_for = ?`, [matterId, epoch, deviceId]);
  if (!row) return null;
  try {
    return unwrapMatterKey(row.wrapped_key, encPrivateKeyPem);
  } catch {
    return null;
  }
}

/** 可同步行收集（watermark：created_at > since；since 为空则全量）。 */
function collectRows(db: KernelDb, matterId: string, deviceId: string, lamport: number, since: string | null): SyncRow[] {
  const rows: SyncRow[] = [];
  const w = since ?? "0000";
  const push = (t: string, pk: string, row: Record<string, unknown>) => rows.push({ t, pk, src_device: deviceId, src_lamport: lamport, row });

  const tenantId = db.get<{ tenant_id: string }>(`SELECT tenant_id FROM matters WHERE matter_id = ?`, [matterId])!.tenant_id;
  // users 先行（matter_members.user_id 外键依赖；身份行是公开元数据）
  for (const r of db.all(`SELECT * FROM users WHERE tenant_id = ?`, [tenantId])) push("users", (r as any).user_id, r as Record<string, unknown>);
  const matter = db.get(`SELECT * FROM matters WHERE matter_id = ?`, [matterId]);
  if (matter) push("matters", matterId, matter as Record<string, unknown>);
  // 成员行每段都附带全部（第三轮复核 S11A-28：迟到加入的成员由此认出负责人与在册成员；原作者随行保留）
  for (const r of db.all(`SELECT * FROM matter_members WHERE matter_id = ?`, [matterId])) {
    const m = r as any;
    push("matter_members", `${matterId}|${m.user_id}`, m);
  }
  for (const r of db.all(`SELECT * FROM devices WHERE tenant_id = ?`, [tenantId])) {
    push("devices", (r as any).device_id, r as Record<string, unknown>);
  }
  for (const r of db.all(`SELECT * FROM document_versions WHERE matter_id = ? AND created_at > ?`, [matterId, w])) push("document_versions", (r as any).document_version_id, r as Record<string, unknown>);
  for (const r of db.all(
    `SELECT pv.* FROM parse_versions pv JOIN document_versions dv ON dv.document_version_id = pv.document_version_id WHERE dv.matter_id = ? AND pv.created_at > ?`,
    [matterId, w],
  )) {
    push("parse_versions", (r as any).parse_version_id, r as Record<string, unknown>);
  }
  // parse_texts（解析正文，随加密 body；否则对端只有版本行没有文本，任务无法读材料）
  for (const r of db.all(
    `SELECT pt.* FROM parse_texts pt JOIN parse_versions pv ON pv.parse_version_id = pt.parse_version_id JOIN document_versions dv ON dv.document_version_id = pv.document_version_id
     WHERE dv.matter_id = ? AND pt.created_at > ?`,
    [matterId, w],
  )) {
    push("parse_texts", (r as any).parse_version_id, r as Record<string, unknown>);
  }
  for (const r of db.all(`SELECT * FROM runs WHERE matter_id = ? AND updated_at > ?`, [matterId, w])) push("runs", (r as any).run_id, r as Record<string, unknown>);
  for (const r of db.all(`SELECT re.* FROM run_events re JOIN runs rn ON rn.run_id = re.run_id WHERE rn.matter_id = ? AND re.created_at > ?`, [matterId, w])) {
    push("run_events", String((r as any).event_id), r as Record<string, unknown>);
  }
  for (const r of db.all(`SELECT * FROM artifact_versions WHERE matter_id = ? AND created_at > ?`, [matterId, w])) push("artifact_versions", (r as any).artifact_version_id, r as Record<string, unknown>);
  for (const r of db.all(
    `SELECT a.* FROM approvals a JOIN artifact_versions av ON av.artifact_version_id = a.artifact_version_id WHERE av.matter_id = ? AND a.created_at > ?`,
    [matterId, w],
  )) {
    push("approvals", (r as any).approval_id, r as Record<string, unknown>);
  }
  for (const r of db.all(`SELECT * FROM audit_events WHERE object_id = ? AND created_at > ?`, [matterId, w])) push("audit_events", String((r as any).audit_event_id), r as Record<string, unknown>);
  for (const r of db.all(`SELECT * FROM egress_records WHERE matter_id = ? AND created_at > ?`, [matterId, w])) push("egress_records", (r as any).record_id, r as Record<string, unknown>);
  for (const r of db.all(`SELECT * FROM key_epochs WHERE scope = 'matter' AND scope_id = ? AND created_at > ?`, [matterId, w])) {
    const k = r as any;
    push("key_epochs", `${k.scope}|${k.scope_id}|${k.epoch}`, k);
  }
  // 节点队列与定时任务行（状态回传桌面：结果经同步回来可见）
  for (const r of db.all(`SELECT * FROM node_tasks WHERE matter_id = ? AND created_at > ?`, [matterId, w])) push("node_tasks", (r as any).task_id, r as Record<string, unknown>);
  for (const r of db.all(`SELECT * FROM scheduled_jobs WHERE matter_id = ? AND created_at > ?`, [matterId, w])) push("scheduled_jobs", (r as any).job_id, r as Record<string, unknown>);
  // IM 意向（审批请求到节点执行）；IM 绑定（发送人↔成员，跨工作区同构）
  for (const r of db.all(`SELECT * FROM im_intents WHERE tenant_id = ? AND created_at > ?`, [tenantId, w])) push("im_intents", (r as any).intent_id, r as Record<string, unknown>);
  for (const r of db.all(`SELECT * FROM im_bindings WHERE tenant_id = ?`, [tenantId])) push("im_bindings", `${(r as any).platform}|${(r as any).im_user_id}`, r as Record<string, unknown>);
  return rows;
}

/** 中继介质单段的段体目标上限（按行的 JSON 估算；超出即拆成按顺序的多段，复核 S11B-08）。 */
export const RELAY_PART_BYTES = 96 * 1024 * 1024;
/** 中继介质单段引用的新材料（密文块）字节上限：中继“每设备未登记字节”缺省 2 GiB 的一半（第二轮复核 S11B-21）。 */
export const RELAY_PART_BLOB_BYTES = 1024 * 1024 * 1024;

export function syncExport(
  deps: SyncDeps,
  args: { shareDir: string; matterId?: string; medium?: "folder" | "relay"; partBytes?: number; partBlobBytes?: number; relayJoinedAt?: (matterId: string) => string | null; relayFullResend?: (matterId: string) => boolean },
): SyncExportResult {
  const relay = args.medium === "relay";
  const stateTable = relay ? "relay_export_state" : "sync_state";
  const { db, keyctx, tenantId } = deps;
  const matters = args.matterId
    ? db.all<any>(`SELECT * FROM matters WHERE matter_id = ? AND tenant_id = ?`, [args.matterId, tenantId])
    : db.all<any>(`SELECT * FROM matters WHERE tenant_id = ? AND status = 'active'`, [tenantId]);
  const result: SyncExportResult = { segments: [], skippedPersonal: [], rowsExported: 0 };
  const deviceCertJson = JSON.stringify(keyctx.device.cert);
  const writeState = (matterId: string, toLamport: number, exportAt: string, alwaysDigest: string | null) => {
    if (relay) {
      db.run(
        `INSERT INTO relay_export_state (matter_id, last_export_lamport, last_export_at, last_always_digest, updated_at) VALUES (?,?,?,?,?)
         ON CONFLICT(matter_id) DO UPDATE SET last_export_lamport = excluded.last_export_lamport, last_export_at = excluded.last_export_at,
           last_always_digest = excluded.last_always_digest, updated_at = excluded.updated_at`,
        [matterId, toLamport, exportAt, alwaysDigest, nowIso()],
      );
      return;
    }
    db.run(
      `INSERT INTO sync_state (matter_id, last_export_lamport, last_export_at, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(matter_id) DO UPDATE SET last_export_lamport = excluded.last_export_lamport, last_export_at = excluded.last_export_at, updated_at = excluded.updated_at`,
      [matterId, toLamport, exportAt, nowIso()],
    );
  };

  for (const m of matters) {
    // 已删除的事项（迁移 0021）：不再导出任何段（本机已无密钥与内容）
    if (m.lifecycle === "purged") continue;
    // 只同步「团队」事项（红线：个人事项零字节出本机）
    if (m.collab_scope !== "team") {
      result.skippedPersonal.push(m.matter_id);
      continue;
    }
    const epoch = currentMatterEpoch(db, m.matter_id, keyctx.device.deviceId);
    const matterKey = resolveMatterKey(db, m.matter_id, epoch, keyctx.device.deviceId, keyctx.device.keys.encPrivateKeyPem);
    if (!matterKey) continue; // 本机不持钥（理论上不发生：成员设备才导得出）
    const state = db.get<{ last_export_lamport: number; last_export_at: string | null; last_always_digest?: string | null }>(`SELECT * FROM ${stateTable} WHERE matter_id = ?`, [m.matter_id]);
    const head = db.get<{ l: number | null }>(`SELECT MAX(lamport) AS l FROM signed_events WHERE matter_id = ?`, [m.matter_id]);
    const toLamport = head?.l ?? 1;
    const exportAt = nowIso();
    // 中继介质第一次导出：只有事项负责人的设备导出全部历史；其他成员的设备从“本机第一次在中继上见到这个事项”起导出
    // （经中继取得的事项：收到之后本机写入的照常发出）；没见过（事项先经共享文件夹到了本机）则从此刻起——
    // 律所刚开启时不让每台成员设备各上传一份全量历史，行只经共享文件夹到过本机的由负责人那份全量覆盖（复核 S11B-03）
    let since = state?.last_export_at ?? null;
    if (relay && !state) {
      const owner = !!db.get(`SELECT 1 AS x FROM matter_members WHERE matter_id = ? AND user_id = ? AND matter_role = 'owner' AND removed_at IS NULL`, [m.matter_id, keyctx.device.cert.memberId]);
      // 中继上的事项被运营重置或中继重建之后：本机写入的行全量重发（收到过的仍不回传；第四轮复核 S11A-36）
      if (!owner && !args.relayFullResend?.(m.matter_id)) {
        const joined = args.relayJoinedAt?.(m.matter_id) ?? null;
        if (!joined) {
          writeState(m.matter_id, toLamport, exportAt, null);
          continue;
        }
        // 起点减 1 毫秒：与本机写入落在同一毫秒的行也收进来（第三轮复核 S11B-31）
        since = new Date(Date.parse(joined) - 1).toISOString();
      }
    }
    const fromLamport = (state?.last_export_lamport ?? 0) + 1;
    signOwnMemberRows(deps, m.matter_id, deviceCertJson);
    let rows = collectRows(db, m.matter_id, keyctx.device.deviceId, toLamport, since);
    // 中继介质（第三轮复核 S11B-28/29/30 后的规则，取代按内容摘要比对）：
    // ①“总是附带的行”（事项行、全部成员行、用户行、IM 绑定、本机设备行）每段都带、不过滤——迟到成员与新设备据此引导事项、认出负责人；
    // ② 其余行凡是经同步（中继或共享文件夹）收下的，一律不经中继发回；状态类表另要求来源是本机（只发本机写入的，第四轮复核 S11B-34）；
    // ③ 设备行只发本机自己的（接收方只认设备自己写的设备行）；
    // ④ 是否需要出段只看本机写的“总是附带的行”：本机是来源设备的事项行、本机设备写的成员行、本人用户行、本机设备行、IM 绑定
    if (relay) {
      rows = rows.filter((r) => ALWAYS_TABLES.has(r.t) || !db.get(`SELECT 1 AS x FROM relay_imported WHERE t = ? AND pk = ?`, [r.t, String(r.pk)]));
      // 状态类表另按来源设备判断（第四轮复核 S11B-34/39①：不依赖摄取时有没有记下——升级前经共享文件夹收到的也不回传）
      rows = rows.filter((r) => !ORIGIN_TABLES.has(r.t) || originOf(db, r.t, String(r.pk), keyctx.device.deviceId).device === keyctx.device.deviceId);
      rows = rows.filter((r) => r.t !== "devices" || String(r.pk) === keyctx.device.deviceId);
    }
    const ownUser = keyctx.device.cert.memberId;
    const triggers = (r: SyncRow) => {
      if (!ALWAYS_TABLES.has(r.t)) return false;
      if (r.t === "users") return String(r.pk) === ownUser;
      if (r.t === "matters") return originOf(db, "matters", String(r.pk), keyctx.device.deviceId).device === keyctx.device.deviceId;
      if (r.t === "matter_members") return (r.row as { author_device?: unknown }).author_device === keyctx.device.deviceId;
      return true;
    };
    // 中继介质：只有总是附带的行、且其中会触发出段的与上次出段时相同 → 不出段（否则每个周期都会给每个团队事项写一段）
    const alwaysDigest = relay ? createHash("sha256").update(canonicalJson(rows.filter(triggers).map((r) => [r.t, r.pk, r.row]))).digest("hex") : null;
    // 非负责人第一次导出、只有总是附带的行：记为基线，不出段（这些行由负责人与控制面目录传播）
    const baseline = relay && !state && !!since && rows.every((r) => ALWAYS_TABLES.has(r.t));
    const unchanged = baseline || (relay && rows.every((r) => ALWAYS_TABLES.has(r.t)) && state?.last_always_digest === alwaysDigest);
    if (rows.length === 0 || unchanged) {
      writeState(m.matter_id, toLamport, exportAt, relay ? (baseline ? alwaysDigest : (state?.last_always_digest ?? alwaysDigest)) : null);
      continue;
    }
    // 引用的密文块（同一份密文，不经二次加解密）：共享文件夹介质**先**复制块、后写段——接收方看到段时块已在（否则摄取到没有块的行）；
    // 中继介质不复制，在引用它的行之后附一行块清单（上传时读本机块库）
    // 每行与它引用的块清单行为一个单元（拆段时不分开）；单元记引用的新材料字节
    // “总是附带的行”合成一个单元放在最前（第四轮：首同步要在同一段里同时看到事项行与全部成员行，拆开会让引导失败）
    const units: { rows: SyncRow[]; blobBytes: number }[] = [{ rows: rows.filter((r) => ALWAYS_TABLES.has(r.t)), blobBytes: 0 }];
    const seenRel = new Set<string>();
    for (const r of rows) {
      if (ALWAYS_TABLES.has(r.t)) continue;
      const unit = { rows: [r] as SyncRow[], blobBytes: 0 };
      units.push(unit);
      const uri = (r.row as any).storage_uri as string | undefined;
      if (typeof uri !== "string" || !uri.startsWith("blob://")) continue;
      const rel = uri.slice("blob://".length);
      if (seenRel.has(rel)) continue;
      seenRel.add(rel);
      const src = join(deps.blobs.dir, ...rel.split("/"));
      if (!existsSync(src)) continue;
      const [scope, sha] = rel.split("/");
      if (!relay) {
        writeShareBlob(args.shareDir, tenantId, scope!, sha!, readFileSync(src));
        continue;
      }
      const env = readFileSync(src);
      const ref: RelayBlobRef = { sha256: createHash("sha256").update(env).digest("hex"), size: env.length, chunks: relayChunks(env).map((c) => c.cid) };
      unit.rows.push({ t: RELAY_BLOB_TABLE, pk: rel, src_device: keyctx.device.deviceId, src_lamport: toLamport, row: ref as unknown as Record<string, unknown> });
      unit.blobBytes += env.length;
    }
    // 中继介质按段体大小与引用的新材料字节拆成按顺序的多段（第二轮复核 S11B-21：一段引用的材料不超过中继
    // “每设备未登记字节”上限的一半，否则永远登记不上）；段编号里的时间递增，摄取按编号先后，依赖的行总在被依赖的行之后
    const parts: SyncRow[][] = [];
    if (relay) {
      const limit = args.partBytes ?? RELAY_PART_BYTES;
      const blobLimit = args.partBlobBytes ?? RELAY_PART_BLOB_BYTES;
      let cur: SyncRow[] = [];
      let size = 0;
      let blobBytes = 0;
      for (const u of units) {
        const n = u.rows.reduce((acc, r) => acc + Buffer.byteLength(JSON.stringify(r)), 0);
        if (cur.length > 0 && (size + n > limit || blobBytes + u.blobBytes > blobLimit)) {
          parts.push(cur);
          cur = [];
          size = 0;
          blobBytes = 0;
        }
        cur.push(...u.rows);
        size += n;
        blobBytes += u.blobBytes;
      }
      if (cur.length > 0) parts.push(cur);
    } else parts.push(units.flatMap((u) => u.rows));
    const keyRows = db.all<KeyRow>(`SELECT matter_id, epoch, wrapped_for, wrapped_key, created_at FROM matter_keys WHERE matter_id = ?`, [m.matter_id]);
    const t0 = Date.now();
    parts.forEach((partRows, i) => {
      const segmentId = `seg_${keyctx.device.deviceId}_${(t0 + i).toString(36)}_${randomUUID().slice(0, 8)}`;
      const sealed = sealSegment({
        header: {
          segment_id: segmentId,
          device_id: keyctx.device.deviceId,
          matter_id: m.matter_id,
          from_lamport: fromLamport,
          to_lamport: toLamport,
          key_epoch: epoch,
          event_count: partRows.length,
          created_at: nowIso(),
          device_cert_json: deviceCertJson,
        },
        keyRows,
        rows: partRows,
        matterKey,
        signer: keyctx.device.signer,
      });
      result.segments.push(writeSegment(args.shareDir, tenantId, keyctx.device.deviceId, segmentId, sealed));
      result.rowsExported += partRows.length;
    });
    // 水位取收集之前的时刻（墙钟水位的局限见进度文档：时钟回拨、对端时钟超前时可能漏收或重复，合并规则幂等）
    writeState(m.matter_id, toLamport, exportAt, alwaysDigest);
  }
  return result;
}

// ─── 摄取 ───

function originOf(db: KernelDb, table: string, pk: string, ownDeviceId: string): { device: string; lamport: number } {
  const r = db.get<{ origin_device: string; origin_lamport: number }>(`SELECT origin_device, origin_lamport FROM sync_row_origin WHERE table_name = ? AND row_pk = ?`, [table, pk]);
  return r ? { device: r.origin_device, lamport: r.origin_lamport } : { device: ownDeviceId, lamport: 0 };
}

function stampOrigin(db: KernelDb, table: string, pk: string, device: string, lamport: number): void {
  db.run(`INSERT INTO sync_row_origin (table_name, row_pk, origin_device, origin_lamport, updated_at) VALUES (?,?,?,?,?)
          ON CONFLICT(table_name, row_pk) DO UPDATE SET origin_device = excluded.origin_device, origin_lamport = excluded.origin_lamport, updated_at = excluded.updated_at`, [
    table,
    pk,
    device,
    lamport,
    nowIso(),
  ]);
}


function applyRow(deps: SyncDeps, r: SyncRow, ctx: { conflicts: SyncImportResult["conflicts"]; warnings: string[]; matterId: string; segDeviceId: string; bodyRows: SyncRow[]; bootstrap: boolean }): boolean {
  const { db, keyctx } = deps;
  const table = r.t;
  const row = r.row as any;
  if (APPEND_ONLY_TABLES.has(table)) {
    if (table === "matter_keys") return false; // matter_keys 走 key_rows 通道
    const cols = Object.keys(row);
    const res = db.run(`INSERT OR IGNORE INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, cols.map((c) => row[c]));
    return res.changes > 0;
  }
  if (table === "users") {
    const res = db.run(`INSERT OR IGNORE INTO users (user_id, tenant_id, display_name, created_at) VALUES (?,?,?,?)`, [row.user_id, row.tenant_id, row.display_name, row.created_at]);
    return res.changes > 0;
  }
  if (table === "artifact_versions") return applyArtifact(deps, r, ctx);
  // 成员行由 applyMemberRows 按因果顺序整批处理（第四轮复核 S11A-35/S11B-35）
  if (table === "matter_members") return false;
  // 这些表只做插入（不可变/行级删除随轮换语义在 G1）：存在即跳过
  if (["approvals", "parse_versions", "parse_texts", "node_tasks", "scheduled_jobs", "im_intents", "im_bindings"].includes(table)) {
    const pkCol = table === "parse_texts" ? "parse_version_id" : TABLE_PK[table]!;
    const exists =
      table === "im_bindings"
        ? db.get(`SELECT 1 AS x FROM im_bindings WHERE tenant_id = ? AND platform = ? AND im_user_id = ?`, [row.tenant_id, row.platform, row.im_user_id])
        : db.get(`SELECT 1 AS x FROM ${table} WHERE ${pkCol} = ?`, [row[pkCol]]);
    if (exists) return false;
    const cols = Object.keys(row);
    db.run(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, cols.map((c) => row[c]));
    return true;
  }
  // devices：归属设备自证——只有设备自己的行由它自己更新（其余设备对它无可写权）；已吊销的设备行冻结，同步不能把它改回有效（复核 S6-C08）
  if (table === "devices") {
    if (r.src_device !== row.device_id) return false;
    const existing = db.get<{ device_id: string; status: string }>(`SELECT device_id, status FROM devices WHERE device_id = ?`, [row.device_id]);
    if (existing?.status === "revoked" || deviceTombstoned(db, String(row.device_id))) return false;
    if (!existing) {
      const cols = Object.keys(row);
      db.run(`INSERT INTO devices (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, cols.map((c) => row[c]));
      return true;
    }
    const origin = originOf(db, "devices", row.device_id, keyctx.device.deviceId);
    if (r.src_lamport <= origin.lamport) return false;
    const cols = Object.keys(row).filter((c) => c !== "device_id");
    db.run(`UPDATE devices SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE device_id = ?`, [...cols.map((c) => row[c]), row.device_id]);
    stampOrigin(db, "devices", row.device_id, r.src_device, r.src_lamport);
    return true;
  }

  // 状态类投影（matters/runs/document_versions/node_tasks/scheduled_jobs）：行级 origin 归属权威——
  // (a) 本机无该行 → 应用并记 origin；(b) 同一 origin 设备且较新 → 应用；
  // (c) origin 不同 → 保留本机行并记 origin_conflict（非归属设备不再能覆盖归属设备状态，§7.1）
  if (["matters", "runs", "document_versions", "node_tasks", "scheduled_jobs"].includes(table)) {
    const pkCol = TABLE_PK[table];
    if (!pkCol) return false;
    const pk = String(row[pkCol]);
    const existing = db.get(`SELECT * FROM ${table} WHERE ${pkCol} = ?`, [row[pkCol]]);
    if (!existing) {
      const cols = Object.keys(row);
      db.run(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, cols.map((c) => row[c]));
      stampOrigin(db, table, pk, r.src_device, r.src_lamport);
      return true;
    }
    const origin = originOf(db, table, pk, keyctx.device.deviceId);
    if (origin.device !== r.src_device) {
      // 回波免告警（应当-3：合法 A→B→A 回流行与本机逐字段一致时不记冲突，仅跳过）
      if (canonicalJson(existing) === canonicalJson(row)) return false;
      ctx.warnings.push(`origin_conflict:${table}/${pk}（本机归属 ${origin.device}，入段来自 ${r.src_device}，已保留本机行）`);
      return false;
    }
    if (r.src_lamport <= origin.lamport) return false;
    // 本机权威的列不随归属设备的行覆盖（复核 C-A02）：事项的结案、保留期与法律保全是本机律师在本机做的决定，
    // 被归属设备的旧状态静默改回会让保全失效、结案后又能写入（团队范围的生命周期指令随 G1 删除与撤权指令下发）；
    // 材料隔离单向生效：对端已隔离则本机跟随，本机已隔离不被对端改回
    const localOnly = LOCAL_AUTHORITATIVE[table] ?? [];
    const keepLocalQuarantine = table === "document_versions" && (existing as Record<string, unknown>).quarantined_at != null;
    const cols = Object.keys(row).filter((c) => c !== pkCol && !localOnly.includes(c) && !(keepLocalQuarantine && (c === "quarantined_at" || c === "quarantine_reason")));
    db.run(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE ${pkCol} = ?`, [...cols.map((c) => row[c]), row[pkCol]]);
    stampOrigin(db, table, pk, r.src_device, r.src_lamport);
    return true;
  }
  return false;
}

/** 同步时保留本机值、不被入段行覆盖的列（复核 C-A02）。 */
const LOCAL_AUTHORITATIVE: Readonly<Record<string, readonly string[]>> = {
  matters: ["lifecycle", "closed_at", "retention_until", "legal_hold", "legal_hold_reason", "purged_at"],
};

function applyArtifact(deps: SyncDeps, r: SyncRow, ctx: { conflicts: SyncImportResult["conflicts"]; warnings: string[]; matterId: string; segDeviceId: string; bodyRows: SyncRow[]; bootstrap: boolean }): boolean {
  const { db } = deps;
  const row = r.row as any;
  const existing = db.get(`SELECT artifact_version_id FROM artifact_versions WHERE artifact_version_id = ?`, [row.artifact_version_id]);
  if (existing) return false; // 成果不可变
  const holder = db.get<{ artifact_version_id: string }>(`SELECT artifact_version_id FROM artifact_versions WHERE matter_id = ? AND kind = ? AND audience = ? AND version = ?`, [
    row.matter_id,
    row.kind,
    row.audience,
    row.version,
  ]);
  if (!holder) {
    const cols = Object.keys(row);
    db.run(`INSERT INTO artifact_versions (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, cols.map((c) => row[c]));
    stampOrigin(db, "artifact_versions", String(row.artifact_version_id), r.src_device, r.src_lamport);
    return true;
  }
  // 并发冲突（§7.1：同一成果的并发修改保留两个版本 + 旗标 + conflict.detected 审计）
  const maxV = db.get<{ v: number }>(`SELECT COALESCE(MAX(version), 0) AS v FROM artifact_versions WHERE matter_id = ? AND kind = ? AND audience = ?`, [row.matter_id, row.kind, row.audience])!.v;
  const cols = Object.keys(row);
  db.run(`INSERT INTO artifact_versions (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, cols.map((c) => (c === "version" ? maxV + 1 : row[c])));
  stampOrigin(db, "artifact_versions", String(row.artifact_version_id), r.src_device, r.src_lamport);
  const conflictId = `conf_${randomUUID()}`;
  const detail = JSON.stringify({ artifact_version_id: row.artifact_version_id, concurrent_with: holder.artifact_version_id, kind: row.kind, audience: row.audience, kept_version: maxV + 1 });
  db.run(`INSERT INTO sync_conflicts (conflict_id, matter_id, kind, detail) VALUES (?,?,?,?)`, [conflictId, ctx.matterId, "concurrent_artifact_versions", detail]);
  appendAuditEvent(db, deps.keyctx.signer, {
    tenantId: (db.get<{ tenant_id: string }>(`SELECT tenant_id FROM matters WHERE matter_id = ?`, [ctx.matterId])!).tenant_id,
    actorId: `device:${r.src_device}`,
    action: "conflict.detected",
    kind: "matter",
    objectId: ctx.matterId,
    matterId: ctx.matterId,
    detailHash: detail.slice(0, 200),
  });
  ctx.conflicts.push({ matter_id: ctx.matterId, kind: "concurrent_artifact_versions", detail });
  return true;
}

/** 成员行作者签名覆盖的内容（第四轮复核 S11A-35/S11B-35）：成员关系的全部语义字段，带域分隔与租户。 */
function memberRowPayload(tenantId: string, r: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(
    canonicalJson({
      v: "kwl-member-row/1",
      tenant: tenantId,
      matter_id: r.matter_id ?? null,
      user_id: r.user_id ?? null,
      matter_role: r.matter_role ?? null,
      added_by: r.added_by ?? null,
      removed_at: r.removed_at ?? null,
      removed_lamport: r.removed_lamport ?? null,
      author_device: r.author_device ?? null,
      row_lamport: r.row_lamport ?? null,
    }),
  );
}

/**
 * 导出前给本机写的成员行签名（两种介质；签名与本机证书存在行上，随行转发）：同事转发这些行时，接收方能核验作者。
 * 已有签名且仍对得上（行没改过、证书没换）的不重签——设备签名可能不是确定性的，重签会让每段内容都变。
 */
function signOwnMemberRows(deps: SyncDeps, matterId: string, certJson: string): void {
  const { db, keyctx, tenantId } = deps;
  for (const m of db.all<Record<string, unknown>>(`SELECT * FROM matter_members WHERE matter_id = ? AND author_device = ?`, [matterId, keyctx.device.deviceId])) {
    const payload = memberRowPayload(tenantId, m);
    if (typeof m.author_sig === "string" && m.author_cert === certJson && verifyBytes(keyctx.device.cert.signPublicKeyPem, payload, m.author_sig)) continue;
    db.run(`UPDATE matter_members SET author_sig = ?, author_cert = ? WHERE matter_id = ? AND user_id = ?`, [signSyncWith(keyctx.device.signer, payload), certJson, matterId, m.user_id]);
  }
}

type MemberOutcome = "applied" | "same" | "pending" | "rejected";

/**
 * 一条成员行（墓碑 + 作者权威 + 较新者胜；第四轮复核 S11A-35/S11B-35 起别人写的行凭作者签名也收）：
 * 1. 不比本机新（含逐字段相同的转发）→ 静默跳过（复核 S11A-40/S11B-38：转发不告警）；
 * 2. 作者设备 = 段签名设备 → 作者即段证书的成员；否则须带作者签名与作者设备证书（律所根签发、设备编号对得上、签名核验通过、
 *    作者设备未被吊销），作者取证书里的成员——转发的成员行与作者亲自发出的同等对待；
 * 3. 作者资格：作者是该事项未墓碑的负责人（按本机库，含本段已应用的行），或首同步时它是事项创建者、且创建者自己的成员行还没处理（引导的起点）；
 *    暂不满足返回 pending（同段后面的行可能使它满足），由调用方按因果顺序重试；
 * 4. 满足后落库（签名与证书随行存，之后本机转发时原样带上）。
 * 残余如实声明：在任负责人的合法权限（包括重新加回被移出的成员）防不了；首同步设备看不到签发者没有转发的成员行（段内选择由签发者决定，创世与成员日志的见证在 G1）。
 */
function applyMemberRow(deps: SyncDeps, r: SyncRow, ctx: { warnings: string[]; matterId: string; segDeviceId: string; segCert: DeviceCertificate; bootstrap: boolean; creator: string | null }): MemberOutcome {
  const { db, keyctx, tenantId } = deps;
  const row = r.row as Record<string, unknown>;
  const key = [String(row.matter_id ?? ""), String(row.user_id ?? "")] as const;
  const author = String(row.author_device ?? "");
  const reject = (reason: string): MemberOutcome => {
    ctx.warnings.push(`member_row_rejected:${key[0]}|${key[1]}（作者 ${author || "（空）"}：${reason}）`);
    return "rejected";
  };
  if (key[0] !== ctx.matterId || !key[1] || !author) return reject("成员行不属于本段事项或缺作者");
  const local = db.get<{ row_lamport: number | null; author_device: string | null }>(`SELECT row_lamport, author_device FROM matter_members WHERE matter_id = ? AND user_id = ?`, [key[0], key[1]]);
  const incomingL = Number(row.row_lamport ?? 0);
  if (local) {
    const localL = local.row_lamport ?? 0;
    const localA = local.author_device ?? "";
    if (!(incomingL > localL || (incomingL === localL && author > localA))) return "same";
  }
  let authorMember: string;
  let sig: string | null = null;
  let certJson: string | null = null;
  if (author === ctx.segDeviceId) {
    authorMember = ctx.segCert.memberId;
    if (typeof row.author_sig === "string" && typeof row.author_cert === "string") {
      sig = row.author_sig;
      certJson = row.author_cert;
    }
  } else {
    if (typeof row.author_sig !== "string" || typeof row.author_cert !== "string") return reject("别人写的成员行没有作者签名，无法核验（借名伪造拒收）");
    let ac: DeviceCertificate | null = null;
    try {
      ac = JSON.parse(row.author_cert) as DeviceCertificate;
    } catch {
      ac = null;
    }
    if (!ac || ac.deviceId !== author || !verifyCertSignature(ac, keyctx.firm.rootPublicKeyPem) || !verifyBytes(ac.signPublicKeyPem, memberRowPayload(tenantId, row), row.author_sig)) {
      return reject("作者签名或作者设备证书核验不通过（拒收）");
    }
    if (deviceTombstoned(db, author) || db.get(`SELECT 1 AS x FROM devices WHERE device_id = ? AND status = 'revoked'`, [author])) return reject("作者设备已被吊销（拒收）");
    authorMember = ac.memberId;
    sig = row.author_sig;
    certJson = row.author_cert;
  }
  const ownerNow = !!db.get(`SELECT 1 AS x FROM matter_members WHERE matter_id = ? AND user_id = ? AND matter_role = 'owner' AND removed_at IS NULL`, [key[0], authorMember]);
  // 首同步的起点：事项创建者在它自己的成员行被处理之前视为负责人（成员行按先后处理——创建者先加人、后把自己改为成员的移交也成立）
  const seed = ctx.bootstrap && !!ctx.creator && authorMember === ctx.creator && !db.get(`SELECT 1 AS x FROM matter_members WHERE matter_id = ? AND user_id = ?`, [key[0], ctx.creator]);
  if (!ownerNow && !seed) return "pending";
  const vals = [row.matter_role ?? "viewer", row.added_by ?? "", row.removed_at ?? null, row.removed_lamport ?? null, author, incomingL, sig, certJson];
  if (local) {
    db.run(`UPDATE matter_members SET matter_role = ?, added_by = ?, removed_at = ?, removed_lamport = ?, author_device = ?, row_lamport = ?, author_sig = ?, author_cert = ? WHERE matter_id = ? AND user_id = ?`, [...vals, key[0], key[1]]);
  } else {
    db.run(`INSERT INTO matter_members (matter_id, user_id, matter_role, added_by, removed_at, removed_lamport, author_device, row_lamport, author_sig, author_cert) VALUES (?,?,?,?,?,?,?,?,?,?)`, [key[0], key[1], ...vals]);
  }
  return "applied";
}

/**
 * 一段里的成员行按 row_lamport 先后整批处理，暂不满足作者资格的反复重试到不再有进展（同段里先有“加为负责人”、后有“该负责人加人”）。
 * 返回应用的行数，以及签发设备自己写的行是否有被应用的（说明签发者当时是负责人：移交与加人在同一段时据此收包裹、引导）。
 */
function applyMemberRows(deps: SyncDeps, rows: SyncRow[], ctx: Parameters<typeof applyMemberRow>[2]): { applied: number; signerActed: boolean } {
  let pending = rows.filter((r) => r.t === "matter_members").sort((a, b) => Number((a.row as any).row_lamport ?? 0) - Number((b.row as any).row_lamport ?? 0));
  let applied = 0;
  let signerActed = false;
  for (;;) {
    const next: SyncRow[] = [];
    let progress = false;
    for (const r of pending) {
      const res = applyMemberRow(deps, r, ctx);
      if (res === "pending") next.push(r);
      else if (res === "applied") {
        progress = true;
        applied += 1;
        if (String((r.row as any).author_device ?? "") === ctx.segDeviceId) signerActed = true;
      }
    }
    pending = next;
    if (!progress || pending.length === 0) break;
  }
  for (const r of pending) ctx.warnings.push(`member_row_rejected:${(r.row as any).matter_id}|${(r.row as any).user_id}（作者 ${(r.row as any).author_device}：作者设备不是该事项未墓碑的负责人（无成员变更权））`);
  return { applied, signerActed };
}

/**
 * 摄取前的核验（第 11 批复核 S11A-01：中继收件在取块、写盘之前先做同一套核验）：本机自产、已摄取、本机已删除、个人事项、
 * 证书链与封口签名（含 key_rows 摘要）、撤权（本机已知该设备或它在吊销墓碑里时）。通过只说明“这一段确由所内在用的设备签发”。
 */
export function preverifySegment(deps: SyncDeps, seg: SegmentFile): { ok: true; cert: DeviceCertificate } | { ok: false; outcome: SegmentOutcome } {
  const { db, keyctx } = deps;
  const h = seg.header;
  if (h.device_id === keyctx.device.deviceId) return { ok: false, outcome: "own" };
  if (db.get(`SELECT 1 AS x FROM sync_segments_seen WHERE segment_id = ?`, [h.segment_id])) return { ok: false, outcome: "seen" };
  const localMatter = db.get<{ collab_scope: string; lifecycle: string }>(`SELECT collab_scope, lifecycle FROM matters WHERE matter_id = ?`, [h.matter_id]);
  // 本机已删除的事项（迁移 0021）：成员设备的段不再导入——否则会把密钥包裹与内容带回本机（删除复活）
  if (localMatter?.lifecycle === "purged") return { ok: false, outcome: "purged" };
  // 只同步「团队」事项（个人事项整段跳过）
  if (localMatter?.collab_scope && localMatter.collab_scope !== "team") return { ok: false, outcome: "personal" };
  // 证书链 + 归属 + 封口验签
  let cert: DeviceCertificate | null = null;
  try {
    cert = JSON.parse(h.device_cert_json) as DeviceCertificate;
  } catch {
    cert = null;
  }
  if (!cert || cert.deviceId !== h.device_id || !verifyCertSignature(cert, keyctx.firm.rootPublicKeyPem) || checkSealed(seg, cert.signPublicKeyPem).ok !== true) return { ok: false, outcome: "invalid" };
  // 段体的纪元字段不在签名范围内：必须等于已签名的段头纪元（第二轮复核 S11A-24）
  if (seg.body.epoch !== h.key_epoch) return { ok: false, outcome: "invalid" };
  // 撤权回填拒收（§5.2 不依赖时钟）：本机已有该设备登记、或它在吊销墓碑里（复核 S6-B28）即可即判；
  // 设备首见于本段的情形在摄取时应用 devices 行后再判一次
  if (db.get(`SELECT 1 AS x FROM devices WHERE device_id = ?`, [h.device_id]) || deviceTombstoned(db, h.device_id)) {
    try {
      assertIncomingEventAcceptable(db, { signerDeviceId: h.device_id, keyEpoch: h.key_epoch });
    } catch {
      return { ok: false, outcome: "revoked" };
    }
  }
  return { ok: true, cert };
}

export function syncImport(deps: SyncDeps, args: { shareDir: string; bootstrapController?: (matterId: string) => string | null }): SyncImportResult {
  const { db, keyctx, tenantId } = deps;
  const result: SyncImportResult = {
    segmentsApplied: 0,
    segmentsSkipped: 0,
    rowsApplied: 0,
    conflicts: [],
    skippedNoKey: [],
    skippedPersonal: [],
    skippedPurged: [],
    rejectedRevoked: [],
    originConflicts: [],
    warnings: { tmpFiles: [], conflictCopies: [] },
    dispositions: [],
  };
  const rootPub = keyctx.firm.rootPublicKeyPem;
  const { candidates, warnings } = scanSegments(args.shareDir, tenantId);
  result.warnings = warnings;

  // 确定全序（§7.1：按 (lamport, device) 合并）
  const all = candidates.map((c: (typeof candidates)[number]) => ({ ...c, seg: parseSegment(c.content) }));
  for (const c of all) if (!c.seg) result.dispositions.push({ segment_id: "", matter_id: "", path: c.path, outcome: "invalid" });
  const parsed = all
    .filter((c): c is (typeof candidates)[number] & { seg: SegmentFile } => c.seg !== null)
    // 同一设备、同一序号区间的分段（中继介质大段拆分）按段编号先后（编号里的时间递增）
    .sort((a, b) => a.seg.header.from_lamport - b.seg.header.from_lamport || a.seg.header.device_id.localeCompare(b.seg.header.device_id) || a.seg.header.segment_id.localeCompare(b.seg.header.segment_id));

  for (const cand of parsed) {
    const seg = cand.seg;
    const h = seg.header;
    const out = (outcome: SegmentOutcome) => result.dispositions.push({ segment_id: String(h.segment_id), matter_id: String(h.matter_id), path: cand.path, outcome });
    const pre = preverifySegment(deps, seg);
    if (!pre.ok) {
      result.segmentsSkipped += 1;
      if (pre.outcome === "purged") result.skippedPurged.push(h.matter_id);
      if (pre.outcome === "personal") result.skippedPersonal.push(h.matter_id);
      if (pre.outcome === "revoked") result.rejectedRevoked.push(h.segment_id);
      out(pre.outcome);
      continue;
    }
    const cert = pre.cert;
    // 摄取中途抛错（例如依赖的行还没到、外键不满足）：只影响这一段，记为延后（复核 S11B-06④），不让整批失败
    try {
    // 解 body 的密钥：先查本机 matter_keys；没有则从本段 key_rows 中找面向本机的包裹（内存中解，不落库——
    // matter_keys 行外键依赖 matters 行，须随事务在 matters 行之后落库）
    let matterKey = resolveMatterKey(db, h.matter_id, seg.body.epoch, keyctx.device.deviceId, keyctx.device.keys.encPrivateKeyPem);
    if (!matterKey) {
      const forUs = (seg.key_rows ?? []).find((kr) => kr.wrapped_for === keyctx.device.deviceId && kr.epoch === seg.body.epoch);
      if (forUs) {
        try {
          matterKey = unwrapMatterKey(forUs.wrapped_key, keyctx.device.keys.encPrivateKeyPem);
        } catch {
          matterKey = null;
        }
      }
    }
    if (!matterKey) {
      result.skippedNoKey.push(h.matter_id);
      result.segmentsSkipped += 1;
      out("no_key");
      continue;
    }
    let rows: SyncRow[];
    try {
      rows = openSegmentBody(seg, matterKey);
    } catch {
      result.segmentsSkipped += 1;
      out("invalid");
      continue;
    }
    // 个人事项双保险（body 内 matters 行若标 personal 也跳）
    const bodyMatter = rows.find((r) => r.t === "matters");
    if (bodyMatter && (bodyMatter.row as any).collab_scope !== "team") {
      result.skippedPersonal.push(h.matter_id);
      result.segmentsSkipped += 1;
      out("personal");
      continue;
    }
    // 首次收到事项（本机还没有）：中继介质只从中继上的控制成员签发的段引导（第三轮复核 S11A-29：同所成员伪造的首段不被采信）；
    // 两种介质都要求签发成员按核验过的成员行是负责人（在事务里判，见下）。其他段延后，等负责人的段
    if (args.bootstrapController && !db.get(`SELECT 1 AS x FROM matters WHERE matter_id = ?`, [h.matter_id]) && args.bootstrapController(h.matter_id) !== cert.memberId) {
      result.segmentsSkipped += 1;
      out("deferred");
      continue;
    }
    // 撤权回填拒收（§5.2 不依赖时钟；devices 行可能就在本段——先应用 devices 行再判）
    for (const r of rows.filter((x) => x.t === "devices")) applyRow(deps, r, { conflicts: result.conflicts, warnings: result.originConflicts, matterId: h.matter_id, segDeviceId: h.device_id, bodyRows: rows, bootstrap: !db.get(`SELECT 1 AS x FROM matters WHERE matter_id = ?`, [h.matter_id]) });
    try {
      assertIncomingEventAcceptable(db, { signerDeviceId: h.device_id, keyEpoch: h.key_epoch });
    } catch {
      result.rejectedRevoked.push(h.segment_id);
      result.segmentsSkipped += 1;
      out("revoked");
      continue;
    }

    const ctx = {
      conflicts: result.conflicts,
      warnings: result.originConflicts,
      matterId: h.matter_id,
      segDeviceId: h.device_id,
      bodyRows: rows,
      // 首同步判定以本段之前的本机状态为准（段内 matters 行落地不改变引导口径）
      bootstrap: !db.get(`SELECT 1 AS x FROM matters WHERE matter_id = ?`, [h.matter_id]),
    };
    db.tx(() => {
      const applied: SyncRow[] = [];
      for (const r of rows) {
        // 中继介质的块清单行只供取块，不落库；成员行在下面按因果顺序整批处理
        if (r.t === "devices" || r.t === RELAY_BLOB_TABLE || r.t === "matter_members") continue;
        if (applyRow(deps, r, ctx)) {
          result.rowsApplied += 1;
          applied.push(r);
        }
      }
      const creator = ctx.bootstrap ? String((rows.find((x) => x.t === "matters")?.row as any)?.created_by ?? "") || null : null;
      const mem = applyMemberRows(deps, rows, { warnings: ctx.warnings, matterId: h.matter_id, segDeviceId: h.device_id, segCert: cert, bootstrap: ctx.bootstrap, creator });
      result.rowsApplied += mem.applied;
      const signerOwner = !!db.get(`SELECT 1 AS x FROM matter_members WHERE matter_id = ? AND user_id = ? AND matter_role = 'owner' AND removed_at IS NULL`, [h.matter_id, cert.memberId]);
      // 首同步：签发成员按核验过的成员行须是负责人，或本段里有它以负责人身份做的成员变更（同一段里移交）；否则整段回滚、延后
      // （第三轮复核 S11A-28 的闸门移到这里——按能落库的行判，不按段里写了什么判，第四轮复核 S11A-35）
      if (ctx.bootstrap && !signerOwner && !mem.signerActed) throw new BootstrapDeferred();
      // key_rows 随事务落库（matters 行已在库，外键满足）——只收被签名覆盖、属于本事项、由负责人签发的（复核 S11A-02）；
      // 签发者本段里以负责人身份做过成员变更的也收（移交与加人在同一段，第四轮复核 S11A-35③）
      const keyRowsOk = keyRowsSigned(seg) && (signerOwner || mem.signerActed);
      for (const kr of keyRowsOk ? (seg.key_rows ?? []) : []) {
        if (kr.matter_id !== h.matter_id || !Number.isSafeInteger(kr.epoch) || kr.epoch < 1) continue;
        db.run(`INSERT OR IGNORE INTO matter_keys (matter_id, epoch, wrapped_for, wrapped_key, created_at) VALUES (?,?,?,?,?)`, [
          kr.matter_id,
          kr.epoch,
          kr.wrapped_for,
          kr.wrapped_key,
          kr.created_at,
        ]);
      }
      // 引用的密文块：从介质复制进本机块库（同一份密文）。复制前核对“解开后的明文摘要 = 块名”（密钥已随本事务落库）：
      // 不符的不复制；本机已有同名块但核对不符（被预先放入）的，用核对通过的这一份替换（第 11 批复核 S11A-01，两种介质都适用）
      for (const r of rows) {
        const uri = (r.row as any).storage_uri as string | undefined;
        if (typeof uri !== "string" || !/^blob:\/\/[A-Za-z0-9_.-]{1,128}\/[0-9a-f]{64}$/.test(uri)) continue;
        const rel = uri.slice("blob://".length);
        // 块只能落在本段事项自己的块目录（或无归属的共享明文块）
        if (rel.split("/")[0] !== h.matter_id) continue;
        const src = join(args.shareDir, tenantId, "blobs", ...rel.split("/"));
        if (!existsSync(src)) continue;
        const dst = join(deps.blobs.dir, ...rel.split("/"));
        if (existsSync(dst) && deps.blobs.matches(rel, readFileSync(dst))) continue;
        const bytes = readFileSync(src);
        if (!deps.blobs.matches(rel, bytes)) {
          ctx.warnings.push(`blob_mismatch:${rel.split("/")[1]!.slice(0, 12)}（介质上的块与名称不符，未复制）`);
          continue;
        }
        mkdirSync(join(dst, ".."), { recursive: true });
        copyFileSync(src, dst);
      }
      // 经同步（中继或共享文件夹）收下的行另记（复核 S11B-03、第三轮 S11B-30）：中继介质导出时不把它们发回中继；
      // 只记本机实际应用了的（第四轮复核 S11B-34：共享文件夹回声送回的本机自己的行已存在、不应用，不记）；
      // “总是附带的行”不记（每段都带）；按事项记，删除事项时清理（S11B-24）
      for (const r of applied) {
        if (ALWAYS_TABLES.has(r.t)) continue;
        db.run(`INSERT OR IGNORE INTO relay_imported (t, pk, matter_id) VALUES (?, ?, ?)`, [r.t, String(r.pk), h.matter_id]);
      }
      db.run(`INSERT INTO sync_segments_seen (segment_id, from_device, matter_id) VALUES (?,?,?)`, [h.segment_id, h.device_id, h.matter_id]);
      // 归属冲突计数透出（应当-2：编辑机可经 sync.status 看到被拒规模；界面只读化与 NACK 提示在 G1）
      db.run(
        `INSERT INTO sync_state (matter_id, last_export_lamport, last_import_at, last_import_origin_conflicts, updated_at) VALUES (?,0,?,?,?)
         ON CONFLICT(matter_id) DO UPDATE SET last_import_at = excluded.last_import_at, last_import_origin_conflicts = excluded.last_import_origin_conflicts, updated_at = excluded.updated_at`,
        [h.matter_id, nowIso(), ctx.warnings.length, nowIso()],
      );
    });
    result.segmentsApplied += 1;
    out("applied");
    } catch {
      // BootstrapDeferred 与其他摄取异常一样：整段回滚、延后
      result.segmentsSkipped += 1;
      out("deferred");
    }
  }
  return result;
}

/** 首同步的段不满足引导条件：整段回滚、延后。 */
class BootstrapDeferred extends Error {}

/**
 * 用本机密钥解开一段的段体（先查本机 matter_keys，没有再找段内面向本机的包裹；第 11 批中继收发件用）。
 * 不验签、不落库——只用来读出段体里的块清单；摄取仍按 syncImport 的全部核验。解不开返回 null。
 */
export function openSegmentRows(deps: SyncDeps, seg: SegmentFile): SyncRow[] | null {
  const { db, keyctx } = deps;
  let key = resolveMatterKey(db, seg.header.matter_id, seg.body.epoch, keyctx.device.deviceId, keyctx.device.keys.encPrivateKeyPem);
  if (!key) {
    const forUs = (seg.key_rows ?? []).find((kr) => kr.wrapped_for === keyctx.device.deviceId && kr.epoch === seg.body.epoch);
    if (forUs) {
      try {
        key = unwrapMatterKey(forUs.wrapped_key, keyctx.device.keys.encPrivateKeyPem);
      } catch {
        key = null;
      }
    }
  }
  if (!key) return null;
  try {
    return openSegmentBody(seg, key);
  } catch {
    return null;
  }
}

export function syncStatus(deps: SyncDeps, args: { shareDir?: string }): Record<string, unknown> {
  const { db, tenantId } = deps;
  const matters = db.all<any>(`SELECT matter_id, title, collab_scope FROM matters WHERE tenant_id = ?`, [tenantId]);
  const items = matters.map((m) => {
    const head = db.get<{ l: number | null }>(`SELECT MAX(lamport) AS l FROM signed_events WHERE matter_id = ?`, [m.matter_id]);
    const state = db.get<any>(`SELECT * FROM sync_state WHERE matter_id = ?`, [m.matter_id]);
    const conflicts = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_conflicts WHERE matter_id = ? AND resolved = 0`, [m.matter_id])!.n;
    return {
      matter_id: m.matter_id,
      title: m.title,
      collab_scope: m.collab_scope,
      lamport_head: head?.l ?? 0,
      last_export_lamport: state?.last_export_lamport ?? 0,
      last_export_at: state?.last_export_at ?? null,
      last_import_origin_conflicts: state?.last_import_origin_conflicts ?? 0,
      unresolved_conflicts: conflicts,
    };
  });
  let pendingSegments = 0;
  let warnings = { tmpFiles: [] as string[], conflictCopies: [] as string[] };
  if (args.shareDir) {
    const scan = scanSegments(args.shareDir, tenantId);
    const seen = new Set(db.all<{ segment_id: string }>(`SELECT segment_id FROM sync_segments_seen`, []).map((r) => r.segment_id));
    pendingSegments = scan.candidates.filter((c) => {
      const seg = parseSegment(c.content);
      return seg !== null && !seen.has(seg.header.segment_id) && seg.header.device_id !== deps.keyctx.device.deviceId;
    }).length;
    warnings = scan.warnings;
  }
  return {
    matters: items,
    pending_segments: pendingSegments,
    warnings,
    unresolved_conflicts: db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sync_conflicts WHERE resolved = 0`, [])!.n,
    note: "共享文件夹只是介质（§7.2）；本机 SQLite 即权威。由共享目录全量重放生成本机库为 G1 项。",
  };
}
