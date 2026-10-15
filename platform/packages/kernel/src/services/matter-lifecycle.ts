/**
 * 事项数据生命周期（用户 10-13 指令第 1 条“数据生命周期管理”；隐私安全审查 P1-1；v9 第 02 篇 §9.13 撤权与删除；迁移 0021）。
 *
 *   active ──结案──▶ closed ──（保留期届满，或提前删除并写明原因）──▶ purged
 *                     ▲  │                         法律保全期间不得删除
 *                     └重新打开
 *
 * - 结案：不再发起任务与导入材料；清理本机 Agent 数据（会话、工作区、材料快照）与工作区密钥——交付件已作为成果登记，不受影响；
 * - 删除（密码学擦除）：先删除本机持有的该事项全部密钥包裹（各纪元、各设备、恢复托管），使任何残留块无法解密；再删除块文件与
 *   含内容的数据行（解析文本、令牌表、当事人词典、风险卡、事实行、成果正文、步骤检查点、检索原文、文件名、任务目标与律师填写的文字）；
 *   事项名称与当事人改为占位。全库逐表扫描的回归测试见 test/matter-lifecycle.test.ts；
 *   审计与签名事件链的元数据保留（可证明做过什么，不再含内容）；挂载原件属律师自己的文件夹，不删除；
 * - 删除回执：本机设备签名的 JSON，逐项写明各副本状态——本机已删除；其他成员设备与共享文件夹里的密文副本须经同步删除指令（G1），
 *   当前状态如实为“待处理”；已外发（模型、检索）的内容不可撤回。回执可离线验签。
 */
import { createHash, randomUUID } from "node:crypto";
import { DomainError, notFound } from "@zr-legal/domain";
import { canonicalJson, verifyBytes, type DeviceSyncSigner } from "@zr-legal/keys";
import type { KernelDb } from "../db.ts";
import { redactedRowHash, redactionListDigest } from "../ledger-signer.ts";

export const RETENTION_YEARS = { min: 1, max: 30, default: 10 } as const;

export interface LifecycleDeps {
  db: KernelDb;
  /** 删除该事项的块目录并清除内存里的事项密钥（BlobStore.purgeMatter）。 */
  purgeBlobs: (matterId: string) => void;
  deviceId: string;
  /** 设备签名者（删除回执对外可验证：将来由 TPM 直签；回执在事务内签，今天同步，随 W8 改异步——偏离 D-71）。 */
  signer: DeviceSyncSigner;
  signPublicKeyPem: string;
  /** 清理本机 Agent 数据（关闭引擎、删除 kap/<事项>、删除工作区密钥）；有进行中任务时抛错。 */
  purgeAgentData: (matterId: string) => Promise<void>;
}

interface MatterRow {
  matter_id: string;
  tenant_id: string;
  title: string;
  lifecycle: string;
  closed_at: string | null;
  retention_until: string | null;
  legal_hold: number;
  legal_hold_reason: string | null;
  purged_at: string | null;
}

const OPEN_RUN = `SELECT COUNT(*) AS n FROM runs WHERE matter_id = ? AND status NOT IN ('succeeded','partial','failed','cancelled','expired','timed_out')`;

function row(db: KernelDb, matterId: string): MatterRow {
  const r = db.get<MatterRow>(`SELECT matter_id, tenant_id, title, lifecycle, closed_at, retention_until, legal_hold, legal_hold_reason, purged_at FROM matters WHERE matter_id = ?`, [matterId]);
  if (!r) throw notFound("事项");
  return r;
}

function addYears(iso: string, years: number): string {
  const d = new Date(iso);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString();
}

export function lifecycleOf(db: KernelDb, matterId: string): { lifecycle: string; closed_at: string | null; retention_until: string | null; legal_hold: boolean; legal_hold_reason: string | null; purged_at: string | null; purge_eligible: boolean } {
  const r = row(db, matterId);
  return {
    lifecycle: r.lifecycle,
    closed_at: r.closed_at,
    retention_until: r.retention_until,
    legal_hold: r.legal_hold === 1,
    legal_hold_reason: r.legal_hold_reason,
    purged_at: r.purged_at,
    purge_eligible: r.lifecycle === "closed" && r.legal_hold === 0 && !!r.retention_until && r.retention_until <= new Date().toISOString(),
  };
}

/** 运行与导入前的门禁：只有进行中的事项可以发起任务、导入材料。 */
export function requireActiveMatter(db: KernelDb, matterId: string): void {
  const r = db.get<{ lifecycle: string }>(`SELECT lifecycle FROM matters WHERE matter_id = ?`, [matterId]);
  if (r && r.lifecycle !== "active") {
    throw new DomainError("conflict", r.lifecycle === "closed" ? "事项已结案（只读）：如需继续工作，请先在事项页“重新打开”" : "事项数据已删除", 409, { lifecycle: r.lifecycle });
  }
}

export async function closeMatter(d: LifecycleDeps, matterId: string, retentionYears?: unknown): Promise<{ lifecycle: ReturnType<typeof lifecycleOf>; agent_data_purged: boolean }> {
  const r = row(d.db, matterId);
  if (r.lifecycle !== "active") throw new DomainError("conflict", "事项不在进行中，无法结案", 409);
  if (d.db.get<{ n: number }>(OPEN_RUN, [matterId])!.n > 0) throw new DomainError("conflict", "事项还有进行中的任务：请等它们结束或取消后再结案", 409);
  const years = retentionYears === undefined ? RETENTION_YEARS.default : Number(retentionYears);
  if (!Number.isInteger(years) || years < RETENTION_YEARS.min || years > RETENTION_YEARS.max) throw new DomainError("validation", `保留期须为 ${RETENTION_YEARS.min}–${RETENTION_YEARS.max} 年`, 422);
  const now = new Date().toISOString();
  d.db.run(`UPDATE matters SET lifecycle = 'closed', closed_at = ?, retention_until = ? WHERE matter_id = ? AND lifecycle = 'active'`, [now, addYears(now, years), matterId]);
  // 结案后不再有 Agent 工作：本机的会话、工作区与材料快照一并清理（交付件已登记为成果，不受影响）；
  // 宿主忙（例如尚有收尾中的会话）时不阻断结案，由启动与同步后的清扫补做（kernel index purgeLocalAgentData）
  let purged = true;
  try {
    await d.purgeAgentData(matterId);
  } catch {
    purged = false;
  }
  return { lifecycle: lifecycleOf(d.db, matterId), agent_data_purged: purged };
}

export function reopenMatter(d: LifecycleDeps, matterId: string): ReturnType<typeof lifecycleOf> {
  const r = row(d.db, matterId);
  if (r.lifecycle !== "closed") throw new DomainError("conflict", r.lifecycle === "purged" ? "事项数据已删除，无法重新打开" : "事项未结案", 409);
  d.db.run(`UPDATE matters SET lifecycle = 'active', closed_at = NULL, retention_until = NULL WHERE matter_id = ? AND lifecycle = 'closed'`, [matterId]);
  return lifecycleOf(d.db, matterId);
}

export function setLegalHold(d: LifecycleDeps, matterId: string, on: boolean, reason: unknown): ReturnType<typeof lifecycleOf> {
  const r = row(d.db, matterId);
  if (r.lifecycle === "purged") throw new DomainError("conflict", "事项数据已删除", 409);
  const why = typeof reason === "string" ? reason.trim().slice(0, 300) : "";
  if (on && !why) throw new DomainError("validation", "设置法律保全须写明原因（例如诉讼保全、监管调查、客户要求）", 422);
  d.db.run(`UPDATE matters SET legal_hold = ?, legal_hold_reason = ? WHERE matter_id = ?`, [on ? 1 : 0, on ? why : null, matterId]);
  return lifecycleOf(d.db, matterId);
}

export interface DeletionReceipt {
  kind: "kwl-deletion-receipt/1";
  receipt_id: string;
  tenant_id: string;
  matter_id: string;
  closed_at: string | null;
  retention_until: string | null;
  purged_at: string;
  early: boolean;
  reason: string | null;
  by: string;
  device_id: string;
  inventory: Record<string, number>;
  /** deleted 已删除；pending 待处理；irrevocable 不可撤回；kept 保留（未删除）；none 不涉及（该处没有本事项内容）。 */
  copies: { where: string; status: "deleted" | "pending" | "irrevocable" | "kept" | "none"; note: string }[];
}

/**
 * 删除（密码学擦除 + 删除内容 + 签名回执）。调用方已核对事项负责人。
 * 先删本机密钥包裹（之后即使块文件删除中途失败，残留块也无法解密），再删块与内容行，最后写回执。
 */
export async function purgeMatter(
  d: LifecycleDeps,
  matterId: string,
  input: {
    by: string;
    confirm_title?: unknown;
    early?: unknown;
    reason?: unknown;
    /** 在删除事务内追加签名的 matter.purged 审计事件（detail_hash = 删除清单摘要）：清单与事件同生同灭，链复核据此核对。 */
    audit: (redactionDigest: string) => void;
  },
): Promise<{ receipt: DeletionReceipt; signature: string; public_key_pem: string; redaction_digest: string }> {
  const r = row(d.db, matterId);
  if (r.lifecycle !== "closed") throw new DomainError("conflict", r.lifecycle === "purged" ? "事项数据已删除" : "须先结案，进入保留期后才能删除", 409);
  if (r.legal_hold === 1) throw new DomainError("conflict", `事项处于法律保全（${r.legal_hold_reason ?? ""}）：解除保全前不得删除`, 409);
  if (String(input.confirm_title ?? "") !== r.title) throw new DomainError("validation", "请输入事项名称以确认删除（删除不可恢复）", 422);
  const now = new Date().toISOString();
  const early = !!r.retention_until && r.retention_until > now;
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 300) : "";
  if (early && (input.early !== true || !reason)) throw new DomainError("validation", `保留期至 ${r.retention_until?.slice(0, 10)}：提前删除须勾选“提前删除”并写明原因（例如客户书面要求）`, 422);
  if (d.db.get<{ n: number }>(OPEN_RUN, [matterId])!.n > 0) throw new DomainError("conflict", "事项还有进行中的任务", 409);

  const count = (sql: string) => d.db.get<{ n: number }>(sql, [matterId])?.n ?? 0;
  const inventory: Record<string, number> = {
    document_versions_imported: count(`SELECT COUNT(*) AS n FROM document_versions WHERE matter_id = ? AND storage_mode = 'import'`),
    document_versions_mounted: count(`SELECT COUNT(*) AS n FROM document_versions WHERE matter_id = ? AND storage_mode = 'mount'`),
    parse_texts: count(`SELECT COUNT(*) AS n FROM parse_texts WHERE parse_version_id IN (SELECT pv.parse_version_id FROM parse_versions pv JOIN document_versions dv ON dv.document_version_id = pv.document_version_id WHERE dv.matter_id = ?)`),
    artifacts: count(`SELECT COUNT(*) AS n FROM artifact_versions WHERE matter_id = ?`),
    tokens: count(`SELECT COUNT(*) AS n FROM matter_tokens WHERE matter_id = ?`),
    risk_cards: count(`SELECT COUNT(*) AS n FROM risk_cards WHERE matter_id = ?`),
    facts: count(`SELECT COUNT(*) AS n FROM matter_facts WHERE matter_id = ?`),
    key_wrappings: count(`SELECT COUNT(*) AS n FROM matter_keys WHERE matter_id = ?`),
    egress_records: count(`SELECT COUNT(*) AS n FROM egress_records WHERE matter_id = ?`),
    egress_sent: count(`SELECT COUNT(*) AS n FROM egress_records WHERE matter_id = ? AND outcome = 'sent'`),
  };
  // 已导出或下载过的文件（成果下载、账本导出、结案归档）：在律师自己保存的位置，本产品无法删除（复核 C-A10；第 02 篇 §9.13“导出临时包”）
  inventory.exports = count(
    `SELECT COUNT(*) AS n FROM signed_events WHERE matter_id = ? AND kind = 'audit_event' AND type IN ('artifact.exported','matter.export_ledger','matter.archive_exported')`,
  );
  const otherDevices = d.db.all<{ device_id: string }>(
    `SELECT DISTINCT wrapped_for AS device_id FROM matter_keys WHERE matter_id = ? AND wrapped_for NOT IN (?, 'recovery')`,
    [matterId, d.deviceId],
  );
  const team = d.db.get<{ collab_scope: string }>(`SELECT collab_scope FROM matters WHERE matter_id = ?`, [matterId])?.collab_scope === "team";

  // 1. 本机 Agent 数据（会话、工作区、材料快照）与工作区密钥
  await d.purgeAgentData(matterId);
  // 2. 密码学擦除 + 内容删除 + 签名回执（同一事务）；块文件在事务之后删除（密钥已不在，残留块不可解）
  let receipt!: DeletionReceipt;
  let signature = "";
  d.db.tx(() => {
    d.db.run(`DELETE FROM matter_keys WHERE matter_id = ?`, [matterId]);
    d.db.run(`DELETE FROM parse_texts WHERE parse_version_id IN (SELECT pv.parse_version_id FROM parse_versions pv JOIN document_versions dv ON dv.document_version_id = pv.document_version_id WHERE dv.matter_id = ?)`, [matterId]);
    d.db.run(`DELETE FROM matter_tokens WHERE matter_id = ?`, [matterId]);
    d.db.run(`DELETE FROM matter_token_keys WHERE matter_id = ?`, [matterId]);
    d.db.run(`DELETE FROM matter_parties WHERE matter_id = ?`, [matterId]);
    d.db.run(`DELETE FROM matter_suspect_reviews WHERE matter_id = ?`, [matterId]);
    d.db.run(`DELETE FROM document_roles WHERE matter_id = ?`, [matterId]);
    d.db.run(`DELETE FROM risk_cards WHERE matter_id = ?`, [matterId]);
    d.db.run(`DELETE FROM matter_facts WHERE matter_id = ?`, [matterId]);
    d.db.run(`DELETE FROM artifact_payloads WHERE artifact_version_id IN (SELECT artifact_version_id FROM artifact_versions WHERE matter_id = ?)`, [matterId]);
    // 签名业务行（运行事件、去向记录）里的内容：登记删除清单后清除（链复核按清单报告“已清除”，清单摘要进签名的删除审计事件）；
    // 去向记录保留目的地、时间、结果、字数与代号计数，去掉备注（检索原文、URL、裁决）与材料文件名
    d.db.run(`INSERT OR IGNORE INTO redacted_rows (kind, ref_id, matter_id) SELECT 'run_event', CAST(e.event_id AS TEXT), ? FROM run_events e JOIN runs r ON r.run_id = e.run_id WHERE r.matter_id = ?`, [matterId, matterId]);
    d.db.run(`UPDATE run_events SET payload = '{"redacted":true}' WHERE run_id IN (SELECT run_id FROM runs WHERE matter_id = ?)`, [matterId]);
    d.db.run(`INSERT OR IGNORE INTO redacted_rows (kind, ref_id, matter_id) SELECT 'egress_record', record_id, ? FROM egress_records WHERE matter_id = ?`, [matterId, matterId]);
    d.db.run(`UPDATE egress_records SET note = NULL, doc_refs = '[]' WHERE matter_id = ?`, [matterId]);
    // 清除后形态的行摘要（复核 C-A08）：保留的元数据同样进签名的清单摘要
    for (const rr of d.db.all<{ kind: string; ref_id: string }>(`SELECT kind, ref_id FROM redacted_rows WHERE matter_id = ?`, [matterId])) {
      d.db.run(`UPDATE redacted_rows SET row_hash = ? WHERE kind = ? AND ref_id = ?`, [redactedRowHash(d.db, rr.kind, rr.ref_id), rr.kind, rr.ref_id]);
    }
    // 任务的其余内容：步骤检查点（含步骤结果）、尝试错误、取消与终止原因、节点任务输入、定时任务参数
    const RUNS = `SELECT run_id FROM runs WHERE matter_id = ?`;
    d.db.run(`DELETE FROM step_checkpoints WHERE run_id IN (${RUNS})`, [matterId]);
    d.db.run(`UPDATE attempts SET error = NULL WHERE run_id IN (${RUNS})`, [matterId]);
    d.db.run(`UPDATE runs SET input_snapshot = '{"redacted":true}', cancel_reason = NULL, terminal_reason = NULL WHERE matter_id = ?`, [matterId]);
    d.db.run(`UPDATE node_tasks SET input_json = '{}', error = NULL WHERE matter_id = ?`, [matterId]);
    d.db.run(`DELETE FROM scheduled_jobs WHERE matter_id = ?`, [matterId]);
    // 解析侧：页面备注与证据锚点（锚点只存 hash 与区间，随解析文本一并删除）
    const PVS = `SELECT pv.parse_version_id FROM parse_versions pv JOIN document_versions dv ON dv.document_version_id = pv.document_version_id WHERE dv.matter_id = ?`;
    d.db.run(`DELETE FROM parse_pages WHERE parse_version_id IN (${PVS})`, [matterId]);
    d.db.run(`DELETE FROM evidence_anchors WHERE parse_version_id IN (${PVS})`, [matterId]);
    // 交付与审批里律师填写的文字（审批签名载荷只含 hash，保留）；出站批准凭据；同步冲突详情；匿名摘要待推送行；代号冲突
    d.db.run(`UPDATE deliveries SET note = NULL WHERE matter_id = ?`, [matterId]);
    d.db.run(`UPDATE approvals SET checklist = '{}' WHERE artifact_version_id IN (SELECT artifact_version_id FROM artifact_versions WHERE matter_id = ?)`, [matterId]);
    d.db.run(`DELETE FROM egress_approvals WHERE matter_id = ?`, [matterId]);
    d.db.run(`DELETE FROM sync_conflicts WHERE matter_id = ?`, [matterId]);
    d.db.run(`DELETE FROM anon_matter_outbox WHERE matter_id = ?`, [matterId]);
    d.db.run(`DELETE FROM matter_token_conflicts WHERE matter_id = ?`, [matterId]);
    // IM 意图（所内节点；载荷里写有事项编号的）
    d.db.run(`UPDATE im_intents SET payload = '{"redacted":true}', result = NULL WHERE instr(payload, ?) > 0 OR instr(COALESCE(result, ''), ?) > 0`, [matterId, matterId]);
    // 挂载材料登记的是律师电脑上的完整路径（常含当事人命名的目录与文件名；复核 C-A04）：一并清除
    d.db.run(`UPDATE document_versions SET filename = '（已删除）', storage_uri = 'purged://' || document_version_id WHERE matter_id = ?`, [matterId]);
    d.db.run(`UPDATE artifact_versions SET filename = '（已删除）', manifest = '{}', open_items = '[]' WHERE matter_id = ?`, [matterId]);
    d.db.run(
      `UPDATE matters SET lifecycle = 'purged', purged_at = ?, title = ?, client_name = NULL, counterparty = NULL, basis = NULL, key_dates = '{}' WHERE matter_id = ?`,
      [now, `已删除的事项 ${matterId.slice(-8)}`, matterId],
    );
    input.audit(redactionDigest(d.db, matterId));
    inventory.redacted_signed_rows = d.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM redacted_rows WHERE matter_id = ?`, [matterId])!.n;
    // 回执与删除同一事务（复核 C-A09）：不会出现“已删除却没有回执”；块目录在事务之后删除，中途中断由启动清扫补做
    receipt = {
      kind: "kwl-deletion-receipt/1",
      receipt_id: `drc_${randomUUID()}`,
      tenant_id: r.tenant_id,
      matter_id: matterId,
      closed_at: r.closed_at,
      retention_until: r.retention_until,
      purged_at: now,
      early,
      reason: reason || null,
      by: input.by,
      device_id: d.deviceId,
      inventory,
      copies: [
        { where: "本机（本设备）", status: "deleted", note: "密钥包裹已删除（密码学擦除）；导入副本块、解析文本、令牌表、当事人词典、风险卡、事实行、成果正文、挂载路径与 Agent 会话及工作区已删除；审计与签名事件链保留元数据" },
        {
          where: "其他成员设备",
          status: otherDevices.length > 0 ? "pending" : "none",
          note: otherDevices.length > 0 ? `${otherDevices.length} 台成员设备持有本事项密钥：须经同步删除指令在其上线后执行（G1），在此之前那些设备上的副本仍可读` : "没有其他成员设备持有本事项密钥",
        },
        {
          where: "律所共享文件夹（同步段）",
          status: team ? "pending" : "none",
          note: team ? "同步段为密文；本机密钥已删除，但持有密钥的成员设备仍可解密——待同步删除指令（G1）" : "个人事项不同步，共享文件夹中没有本事项内容",
        },
        // 复核 C-A03：团队事项的恢复托管包裹已随同步段写入共享文件夹、也在其他成员设备上——只有本机那份已删
        team
          ? { where: "律所恢复托管", status: "pending", note: "本机保存的恢复托管包裹行已删除；同步段与其他成员设备上的托管包裹待同步删除指令（G1）" }
          : { where: "律所恢复托管", status: "deleted", note: "本机保存的恢复托管包裹行已删除（个人事项不同步，没有其他副本）" },
        {
          where: "已外发的内容（模型推理、联网检索）",
          status: inventory.egress_sent! > 0 ? "irrevocable" : "none",
          note: `共有 ${inventory.egress_sent} 次已发出的请求（令牌化后的内容）：不可撤回；上游留存以模型服务企业协议为准`,
        },
        {
          where: "已导出或下载的文件（成果下载、账本导出、结案归档）",
          status: inventory.exports! > 0 ? "kept" : "none",
          note: inventory.exports! > 0 ? `${inventory.exports} 次导出或下载：文件在律师自己选择的位置，本产品无法删除，请按律所档案制度处理` : "没有导出或下载记录",
        },
        {
          // 第 02 篇 §9.13“备份待到期”：系统备份在律所自有系统中，本产品不控制（D-52）
          where: "电脑与律所的系统备份（Windows 系统还原点与卷影副本、文件历史、NAS 快照、备份软件）",
          status: "pending",
          note: "不在本次删除范围：备份与快照里的块文件是密文，但旧的密钥包裹与解封所需材料可能一并留在快照中，同一 Windows 账户可以取回并解开（隐私安全增量评审 F9）——按律所备份保留期到期删除；恢复旧备份前须先核对本回执",
        },
        { where: "挂载原件（律师文件夹中的原文件）", status: inventory.document_versions_mounted! > 0 ? "kept" : "none", note: `${inventory.document_versions_mounted} 份挂载原件属律师自己的文件夹，本产品未删除` },
      ],
    };
    signature = d.signer.signSync(new TextEncoder().encode(canonicalJson(receipt)));
    d.db.run(`INSERT INTO deletion_receipts (receipt_id, tenant_id, matter_id, created_by, signer_device_id, receipt_json, signature) VALUES (?,?,?,?,?,?,?)`, [
      receipt.receipt_id,
      r.tenant_id,
      matterId,
      input.by,
      d.deviceId,
      canonicalJson(receipt),
      signature,
    ]);
  });
  d.purgeBlobs(matterId);
  // 删除前的页面映像还在 WAL 里：写回并截断（主库空闲页由 secure_delete 清零）
  try {
    d.db.checkpointTruncate();
  } catch {
    // 有并发读者时 checkpoint 可能不完整：下次自动 checkpoint 时补上
  }
  return { receipt: receipt!, signature, public_key_pem: d.signPublicKeyPem, redaction_digest: redactionDigest(d.db, matterId) };
}

/** 删除清单摘要：该事项被清除内容的签名业务行（按种类与编号排序，含清除后行摘要）。写进签名的 matter.purged 审计事件，链复核时核对。 */
export function redactionDigest(db: KernelDb, matterId: string): string {
  return redactionListDigest(db.all<{ kind: string; ref_id: string; row_hash: string | null }>(`SELECT kind, ref_id, row_hash FROM redacted_rows WHERE matter_id = ? ORDER BY kind, ref_id`, [matterId]));
}

/** 回执离线验签（同一签名公钥）。 */
export function verifyDeletionReceipt(receipt: DeletionReceipt, signature: string, publicKeyPem: string): boolean {
  return verifyBytes(publicKeyPem, new TextEncoder().encode(canonicalJson(receipt)), signature);
}

/** 读取事项的删除回执（事项负责人与成员可读；内容不含名称与案卷内容）。 */
export function deletionReceiptOf(db: KernelDb, matterId: string): { receipt: DeletionReceipt; signature: string } | null {
  const r = db.get<{ receipt_json: string; signature: string }>(`SELECT receipt_json, signature FROM deletion_receipts WHERE matter_id = ? ORDER BY created_at DESC LIMIT 1`, [matterId]);
  return r ? { receipt: JSON.parse(r.receipt_json) as DeletionReceipt, signature: r.signature } : null;
}

