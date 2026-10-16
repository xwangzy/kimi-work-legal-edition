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
import { canonicalJson, unwrapMatterKey, type DeviceCertificate } from "@zr-legal/keys";
import { checkSealed, openSegmentBody, parseSegment, scanSegments, sealSegment, writeSegment, writeShareBlob, type KeyRow, type SegmentFile, type SyncRow } from "@zr-legal/sync";
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
export type SegmentOutcome = "applied" | "own" | "seen" | "purged" | "personal" | "invalid" | "revoked" | "no_key";

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
const ALWAYS_TABLES = new Set(["users", "matters", "devices", "im_bindings"]);

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

function currentMatterEpoch(db: KernelDb, matterId: string): number {
  const r = db.get<{ e: number | null }>(`SELECT MAX(epoch) AS e FROM matter_keys WHERE matter_id = ?`, [matterId]);
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
  for (const r of db.all(`SELECT * FROM matter_members WHERE matter_id = ? AND (added_at > ? OR removed_at > ?)`, [matterId, w, w])) {
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

export function syncExport(deps: SyncDeps, args: { shareDir: string; matterId?: string; medium?: "folder" | "relay" }): SyncExportResult {
  const relay = args.medium === "relay";
  const stateTable = relay ? "relay_export_state" : "sync_state";
  const { db, keyctx, tenantId } = deps;
  const matters = args.matterId
    ? db.all<any>(`SELECT * FROM matters WHERE matter_id = ? AND tenant_id = ?`, [args.matterId, tenantId])
    : db.all<any>(`SELECT * FROM matters WHERE tenant_id = ? AND status = 'active'`, [tenantId]);
  const result: SyncExportResult = { segments: [], skippedPersonal: [], rowsExported: 0 };
  const deviceCertJson = JSON.stringify(keyctx.device.cert);

  for (const m of matters) {
    // 已删除的事项（迁移 0021）：不再导出任何段（本机已无密钥与内容）
    if (m.lifecycle === "purged") continue;
    // 只同步「团队」事项（红线：个人事项零字节出本机）
    if (m.collab_scope !== "team") {
      result.skippedPersonal.push(m.matter_id);
      continue;
    }
    const epoch = currentMatterEpoch(db, m.matter_id);
    const matterKey = resolveMatterKey(db, m.matter_id, epoch, keyctx.device.deviceId, keyctx.device.keys.encPrivateKeyPem);
    if (!matterKey) continue; // 本机不持钥（理论上不发生：成员设备才导得出）
    const state = db.get<{ last_export_lamport: number; last_export_at: string | null; last_always_digest?: string | null }>(`SELECT * FROM ${stateTable} WHERE matter_id = ?`, [m.matter_id]);
    const since = state?.last_export_at ?? null;
    const head = db.get<{ l: number | null }>(`SELECT MAX(lamport) AS l FROM signed_events WHERE matter_id = ?`, [m.matter_id]);
    const toLamport = head?.l ?? 1;
    const fromLamport = (state?.last_export_lamport ?? 0) + 1;
    const exportAt = nowIso();
    const rows = collectRows(db, m.matter_id, keyctx.device.deviceId, toLamport, since);
    // 中继介质：只有总是附带的行、且它们与上次出段时相同 → 不出段（否则每个周期都会给每个团队事项写一段）
    const alwaysDigest = relay ? createHash("sha256").update(canonicalJson(rows.filter((r) => ALWAYS_TABLES.has(r.t)).map((r) => [r.t, r.pk, r.row]))).digest("hex") : null;
    const unchanged = relay && rows.every((r) => ALWAYS_TABLES.has(r.t)) && state?.last_always_digest === alwaysDigest;
    if (rows.length === 0 || unchanged) {
      db.run(`INSERT INTO ${stateTable} (matter_id, last_export_lamport, last_export_at, updated_at) VALUES (?,?,?,?)
              ON CONFLICT(matter_id) DO UPDATE SET last_export_lamport = excluded.last_export_lamport, last_export_at = excluded.last_export_at, updated_at = excluded.updated_at`, [
        m.matter_id,
        toLamport,
        exportAt,
        nowIso(),
      ]);
      continue;
    }
    // 引用的密文块（同一份密文，不经二次加解密）：共享文件夹介质**先**复制块、后写段——接收方看到段时块已在（否则摄取到没有块的行）；
    // 中继介质不复制，只在段体里附块清单（上传时读本机块库）
    const blobRels = new Set<string>();
    for (const r of rows) {
      const uri = (r.row as any).storage_uri as string | undefined;
      if (typeof uri === "string" && uri.startsWith("blob://")) blobRels.add(uri.slice("blob://".length));
    }
    for (const rel of blobRels) {
      const src = join(deps.blobs.dir, ...rel.split("/"));
      if (!existsSync(src)) continue;
      const [scope, sha] = rel.split("/");
      if (!relay) {
        writeShareBlob(args.shareDir, tenantId, scope!, sha!, readFileSync(src));
        continue;
      }
      const env = readFileSync(src);
      const ref: RelayBlobRef = { sha256: createHash("sha256").update(env).digest("hex"), size: env.length, chunks: relayChunks(env).map((c) => c.cid) };
      rows.push({ t: RELAY_BLOB_TABLE, pk: rel, src_device: keyctx.device.deviceId, src_lamport: toLamport, row: ref as unknown as Record<string, unknown> });
    }
    const keyRows = db.all<KeyRow>(`SELECT matter_id, epoch, wrapped_for, wrapped_key, created_at FROM matter_keys WHERE matter_id = ?`, [m.matter_id]);
    const segmentId = `seg_${keyctx.device.deviceId}_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    const sealed = sealSegment({
      header: {
        segment_id: segmentId,
        device_id: keyctx.device.deviceId,
        matter_id: m.matter_id,
        from_lamport: fromLamport,
        to_lamport: toLamport,
        key_epoch: epoch,
        event_count: rows.length,
        created_at: nowIso(),
        device_cert_json: deviceCertJson,
      },
      keyRows,
      rows,
      matterKey,
      signer: keyctx.device.signer,
    });
    const path = writeSegment(args.shareDir, tenantId, keyctx.device.deviceId, segmentId, sealed);
    result.segments.push(path);
    result.rowsExported += rows.length;
    // 水位取收集之前的时刻（收集与写段期间新建的行下次仍会被收进来）
    if (relay) {
      db.run(
        `INSERT INTO relay_export_state (matter_id, last_export_lamport, last_export_at, last_always_digest, updated_at) VALUES (?,?,?,?,?)
         ON CONFLICT(matter_id) DO UPDATE SET last_export_lamport = excluded.last_export_lamport, last_export_at = excluded.last_export_at,
           last_always_digest = excluded.last_always_digest, updated_at = excluded.updated_at`,
        [m.matter_id, toLamport, exportAt, alwaysDigest, nowIso()],
      );
      continue;
    }
    db.run(`INSERT INTO sync_state (matter_id, last_export_lamport, last_export_at, updated_at) VALUES (?,?,?,?)
            ON CONFLICT(matter_id) DO UPDATE SET last_export_lamport = excluded.last_export_lamport, last_export_at = excluded.last_export_at, updated_at = excluded.updated_at`, [
      m.matter_id,
      toLamport,
      exportAt,
      nowIso(),
    ]);
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
  // 成员行（阻断-C 修复：墓碑 + 作者权威 + 较新者胜）——摄取三道检查：
  // 1. row.author_device 必须等于段签名设备（防借名：拿别人设备名写大 lamport 的伪造行直接拒）；
  // 2. 作者资格：既有事项——作者设备须为该事项 owner 角色且未墓碑的成员设备（非 owner 成员不得变更成员集）；
  //    首同步引导例外——本机尚无该事项时，仅当成员行与 matters 行同批到达且 author == matters 行 origin
  //    （创建者即初始 owner；事项首同步只从创建设备的段接受成员行，多跳转发不扩成员）；
  // 3. 不满足即整行拒收记 member_row_rejected（含作者/原因）；满足后按 (row_lamport, author_device) 较新者胜。
  // 残余如实声明：恶意 owner 重新 add 被移出成员是合法管理动作（墓碑清除本就要求显式 add）——
  // 伦理墙防的是非 owner 成员与「管理员单人」，防不了在任 owner 的合法权限。
  if (table === "matter_members") {
    const key = [row.matter_id, row.user_id];
    const author = String(row.author_device ?? "");
    const reject = (reason: string): boolean => {
      ctx.warnings.push(`member_row_rejected:${key[0]}|${key[1]}（作者 ${author || "（空）"}：${reason}）`);
      return false;
    };
    if (!author || author !== ctx.segDeviceId) return reject("author_device 与段签名设备不一致（借名伪造拒收）");
    if (ctx.bootstrap) {
      // 首同步引导：须与 matters 行同批且作者即创建设备（matters 行 src；多跳转发不扩成员）
      const mattersRow = ctx.bodyRows.find((x) => x.t === "matters");
      if (!mattersRow || String(mattersRow.src_device) !== author) return reject("首同步须由创建设备的段携带成员行（多跳转发不扩成员）");
    } else {
      // 既有事项：作者资格以本机库（本段之前）的 owner 成员为准——段内自封 owner 不算数
      const authorMember = db.get<{ member_id: string }>(`SELECT member_id FROM devices WHERE device_id = ?`, [author]);
      const qualified =
        authorMember &&
        db.get(`SELECT 1 AS x FROM matter_members WHERE matter_id = ? AND user_id = ? AND matter_role = 'owner' AND removed_at IS NULL`, [ctx.matterId, authorMember.member_id]);
      if (!qualified) return reject("作者设备不是该事项未墓碑的 owner 成员设备（无成员变更权）");
    }
    const local = db.get<{ row_lamport: number | null; author_device: string | null }>(
      `SELECT row_lamport, author_device FROM matter_members WHERE matter_id = ? AND user_id = ?`,
      key,
    );
    const incomingL = Number(row.row_lamport ?? 0);
    if (local) {
      const localL = local.row_lamport ?? 0;
      const localA = local.author_device ?? "";
      const newer = incomingL > localL || (incomingL === localL && author > localA);
      if (!newer) return false;
      db.run(
        `UPDATE matter_members SET matter_role = ?, added_by = ?, removed_at = ?, removed_lamport = ?, author_device = ?, row_lamport = ? WHERE matter_id = ? AND user_id = ?`,
        [row.matter_role ?? "viewer", row.added_by ?? "", row.removed_at ?? null, row.removed_lamport ?? null, author, incomingL, key[0], key[1]],
      );
      return true;
    }
    db.run(
      `INSERT INTO matter_members (matter_id, user_id, matter_role, added_by, removed_at, removed_lamport, author_device, row_lamport) VALUES (?,?,?,?,?,?,?,?)`,
      [key[0], key[1], row.matter_role ?? "viewer", row.added_by ?? "", row.removed_at ?? null, row.removed_lamport ?? null, author, incomingL],
    );
    return true;
  }
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

export function syncImport(deps: SyncDeps, args: { shareDir: string }): SyncImportResult {
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
    .sort((a, b) => a.seg.header.from_lamport - b.seg.header.from_lamport || a.seg.header.device_id.localeCompare(b.seg.header.device_id));

  for (const cand of parsed) {
    const seg = cand.seg;
    const h = seg.header;
    const out = (outcome: SegmentOutcome) => result.dispositions.push({ segment_id: String(h.segment_id), matter_id: String(h.matter_id), path: cand.path, outcome });
    if (h.device_id === keyctx.device.deviceId) {
      result.segmentsSkipped += 1;
      out("own");
      continue; // 本机自产段
    }
    if (db.get(`SELECT 1 AS x FROM sync_segments_seen WHERE segment_id = ?`, [h.segment_id])) {
      result.segmentsSkipped += 1;
      out("seen");
      continue;
    }
    // 只同步「团队」事项（个人事项整段跳过）
    const localMatter = db.get<{ collab_scope: string; lifecycle: string }>(`SELECT collab_scope, lifecycle FROM matters WHERE matter_id = ?`, [h.matter_id]);
    // 本机已删除的事项（迁移 0021）：成员设备的段不再导入——否则会把密钥包裹与内容带回本机（删除复活）
    if (localMatter?.lifecycle === "purged") {
      result.skippedPurged.push(h.matter_id);
      result.segmentsSkipped += 1;
      out("purged");
      continue;
    }
    const matterRowInBody = localMatter?.collab_scope;
    if (matterRowInBody && matterRowInBody !== "team") {
      result.skippedPersonal.push(h.matter_id);
      result.segmentsSkipped += 1;
      out("personal");
      continue;
    }
    // 证书链 + 归属 + 封口验签
    let cert: DeviceCertificate | null = null;
    try {
      cert = JSON.parse(h.device_cert_json) as DeviceCertificate;
    } catch {
      cert = null;
    }
    if (!cert || cert.deviceId !== h.device_id || !verifyCertSignature(cert, rootPub) || checkSealed(seg, cert.signPublicKeyPem).ok !== true) {
      result.segmentsSkipped += 1;
      out("invalid");
      continue;
    }
    // 撤权回填拒收（§5.2 不依赖时钟）：本机已有该设备登记、或它在吊销墓碑里（复核 S6-B28：本机设备表里可能没有它——
    // 不得先按段内它自己的设备行插入再判）即可即判（不必能解 body）；设备首见于本段的情形在应用 devices 行后再判一次
    if (db.get(`SELECT 1 AS x FROM devices WHERE device_id = ?`, [h.device_id]) || deviceTombstoned(db, h.device_id)) {
      try {
        assertIncomingEventAcceptable(db, { signerDeviceId: h.device_id, keyEpoch: h.key_epoch });
      } catch {
        result.rejectedRevoked.push(h.segment_id);
        result.segmentsSkipped += 1;
        out("revoked");
        continue;
      }
    }
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
      for (const r of rows) {
        // 中继介质的块清单行只供取块，不落库
        if (r.t === "devices" || r.t === RELAY_BLOB_TABLE) continue;
        if (applyRow(deps, r, ctx)) result.rowsApplied += 1;
      }
      // key_rows 随事务落库（matters 行已在库，外键满足）
      for (const kr of seg.key_rows ?? []) {
        db.run(`INSERT OR IGNORE INTO matter_keys (matter_id, epoch, wrapped_for, wrapped_key, created_at) VALUES (?,?,?,?,?)`, [
          kr.matter_id,
          kr.epoch,
          kr.wrapped_for,
          kr.wrapped_key,
          kr.created_at,
        ]);
      }
      // 引用的密文块：从共享 blobs 复制进本机块库（同一份密文）
      for (const r of rows) {
        const uri = (r.row as any).storage_uri as string | undefined;
        if (typeof uri === "string" && uri.startsWith("blob://")) {
          const rel = uri.slice("blob://".length);
          const src = join(args.shareDir, tenantId, "blobs", ...rel.split("/"));
          if (existsSync(src)) {
            const dst = join(deps.blobs.dir, ...rel.split("/"));
            if (!existsSync(dst)) {
              mkdirSync(join(dst, ".."), { recursive: true });
              copyFileSync(src, dst);
            }
          }
        }
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
  }
  return result;
}

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
