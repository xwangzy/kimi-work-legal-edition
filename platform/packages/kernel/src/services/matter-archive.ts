/**
 * 结案归档导出（v9 第 02 篇 §9.13“结案导出开放格式（事件 JSON Lines + 原始文件 + 签名证明包）”；审计 P1-2；用户 10-13 指令第 1 条“数据生命周期管理”）。
 *
 * 一个 ZIP，第三方不依赖本产品与本数据库即可核对：
 *   manifest.json        事项概况、导出人与设备、每个文件的 sha256 与字节数、计数
 *   manifest.sig         本机设备签名（Ed25519，对 manifest.json 的规范 JSON）
 *   signer-cert.json     签名设备证书（律所根签发）；firm-root.pem 律所根公钥
 *   ledger.jsonl         签名事件（含链接与签名）+ 每个签名事件对应的业务行原样（可按第 02 篇 §6.4 的口径重算 payload_hash）
 *                        + 设备证书 + 签发证明包
 *   materials/           导入的原件（解密后的原始字节，hash 与登记一致）；挂载的原件可读且 hash 一致时一并收入，否则在清单中标明
 *   artifacts/           成果（导出即还原代号，与“下载”同口径；清单同时记登记 hash 与导出 hash）
 *   review/              风险卡与事实行（代号已还原为原文）
 *   README.txt           目录说明与核对步骤
 *
 * 归档含案卷原文：只由事项负责人发起，记审计（只记文件数与总 hash），界面提示保存位置由律师决定。已删除的事项不能导出。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DomainError } from "@zr-legal/domain";
import { writeZip } from "@zr-legal/docx-engine";
import { canonicalJson, type DeviceCertificate, type DeviceSyncSigner } from "@zr-legal/keys";
import type { BlobStore } from "../blobs.ts";
import type { KernelDb } from "../db.ts";
import type { MatterTokenStore } from "../egress/matter-tokens.ts";
import { restoreArtifactBytes } from "./export-restore.ts";

export const ARCHIVE_FORMAT = "kwl-matter-archive/1";
/** 单个归档的上限（解密后的原件与成果合计）。超出请律师分批（按材料）导出——v0 在内存里组包。 */
export const ARCHIVE_MAX_BYTES = 512 * 1024 * 1024;

export interface ArchiveDeps {
  db: KernelDb;
  blobs: BlobStore;
  tokens?: MatterTokenStore | null;
  deviceId: string;
  /** 归档清单签名（今天同步；改为 TPM 直签时随 W8 改异步，偏离 D-71）。 */
  signer: DeviceSyncSigner;
  deviceCert: DeviceCertificate;
  firmRootPublicKeyPem: string;
}

export interface ArchiveManifest {
  format: typeof ARCHIVE_FORMAT;
  matter: Record<string, unknown>;
  exported_at: string;
  exported_by: string;
  device_id: string;
  files: { path: string; sha256: string; bytes: number; note?: string }[];
  counts: Record<string, number>;
  /** 未能收入的材料（挂载原件不可读或已变化）。 */
  missing: { document_version_id: string; filename: string; reason: string }[];
}

const sha256Hex = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** ZIP 内的安全文件名：去掉路径分隔与控制字符，限长，保留扩展名。 */
function safeName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "_").trim() || "未命名";
  if (cleaned.length <= 80) return cleaned;
  const m = /(\.[A-Za-z0-9]{1,8})$/.exec(cleaned);
  return `${cleaned.slice(0, 80 - (m?.[1]?.length ?? 0))}${m?.[1] ?? ""}`;
}

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** 签名事件对应的业务行原样（与 ledger-signer.ts recomputePayloadHash 同一取数口径）。 */
function businessRow(db: KernelDb, kind: string, refId: string): Record<string, unknown> | null {
  if (kind === "run_event") return db.get(`SELECT run_id, attempt_id, seq, type, payload FROM run_events WHERE event_id = ?`, [Number(refId)]) ?? null;
  if (kind === "audit_event") return db.get(`SELECT * FROM audit_events WHERE audit_event_id = ?`, [Number(refId)]) ?? null;
  if (kind === "egress_record") return db.get(`SELECT * FROM egress_records WHERE record_id = ?`, [refId]) ?? null;
  if (kind === "approval") return db.get(`SELECT approval_id, signed_payload FROM approvals WHERE approval_id = ?`, [refId]) ?? null;
  return null;
}

const README = `本归档由 Kimi Work 法律行业发行版在律师电脑上生成（格式 ${ARCHIVE_FORMAT}）。

目录
  manifest.json      事项概况、导出人与设备、每个文件的 sha256 与字节数
  manifest.sig       导出设备对 manifest.json 规范 JSON 的 Ed25519 签名（base64）
  signer-cert.json   导出设备的证书（由律所根密钥签发）
  firm-root.pem      律所根公钥
  ledger.jsonl       签名事件链（每行一条 JSON）：signed_event 为见证行（事件类型在 event_type），business_row 为它见证的业务行原样，
                     device_cert 为签名设备证书，approval_proof 为签发证明包
  materials/         导入的原件（与登记 hash 一致的原始字节）
  artifacts/         成果文件（代号已还原为原文）
  review/            风险卡与事实行（代号已还原为原文）

核对步骤
  1. 用 firm-root.pem 核对 signer-cert.json 的签发签名；再用证书里的签名公钥核对 manifest.sig；
  2. 逐个文件计算 sha256，与 manifest.json 的 files 一致；
  3. ledger.jsonl：按 seq 顺序核对 prev_hash 链接与每行签名；对每个 business_row 按第 02 篇 §6.4 的口径重算 payload_hash，与对应 signed_event 一致。
  4. 已按删除清单清除内容的行（如有）只在事项删除后出现；本归档在删除前生成，不含清除行。

本归档含案卷原文与当事人信息，请按律所档案与保密制度保管。
`;

export function buildMatterArchive(d: ArchiveDeps, matterId: string, opts: { by: string }): { filename: string; zip: Buffer; manifest: ArchiveManifest; signature: string } {
  const m = d.db.get<Record<string, any>>(`SELECT * FROM matters WHERE matter_id = ?`, [matterId]);
  if (!m) throw new DomainError("not_found", "事项不存在", 404);
  if (m.lifecycle === "purged") throw new DomainError("conflict", "事项数据已删除，不能导出归档", 409);
  const restoreText = (s: string | null | undefined): string | null => (s == null ? null : d.tokens ? d.tokens.restore(matterId, s).text : s);

  const entries: { name: string; data: Buffer; note?: string }[] = [];
  const missing: ArchiveManifest["missing"] = [];
  let total = 0;
  const add = (name: string, data: Buffer, note?: string) => {
    total += data.length;
    if (total > ARCHIVE_MAX_BYTES) throw new DomainError("validation", `归档超过 ${Math.round(ARCHIVE_MAX_BYTES / 1024 / 1024)} MB：请分批导出（例如先导出成果与记录，原件另行归档）`, 422);
    entries.push({ name, data, ...(note ? { note } : {}) });
  };

  // 1. 材料原件
  const docs = d.db.all<{ document_version_id: string; filename: string; sha256: string; storage_mode: string; storage_uri: string; quarantined_at: string | null; created_at: string }>(
    `SELECT document_version_id, filename, sha256, storage_mode, storage_uri, quarantined_at, created_at FROM document_versions WHERE matter_id = ? ORDER BY created_at`,
    [matterId],
  );
  docs.forEach((doc, i) => {
    if (doc.quarantined_at) {
      missing.push({ document_version_id: doc.document_version_id, filename: doc.filename, reason: "已隔离（带国家秘密标志），不收入归档" });
      return;
    }
    let bytes: Buffer | null = null;
    try {
      bytes = doc.storage_mode === "import" ? d.blobs.read(doc.storage_uri) : readFileSync(doc.storage_uri.replace(/^file:\/\//, ""));
    } catch {
      bytes = null;
    }
    if (!bytes) {
      missing.push({ document_version_id: doc.document_version_id, filename: doc.filename, reason: doc.storage_mode === "mount" ? "挂载的原件不可读（已移动或删除）" : "导入副本不可读" });
      return;
    }
    if (sha256Hex(bytes) !== doc.sha256) {
      missing.push({ document_version_id: doc.document_version_id, filename: doc.filename, reason: "原件已变化（hash 与登记不符），未收入" });
      return;
    }
    add(`materials/${String(i + 1).padStart(3, "0")}-${safeName(doc.filename)}`, bytes, doc.storage_mode === "mount" ? "挂载原件" : undefined);
  });

  // 2. 成果（导出即还原，与下载同口径）
  const arts = d.db.all<{ artifact_version_id: string; kind: string; version: number; filename: string; sha256: string; storage_uri: string; status: string }>(
    `SELECT artifact_version_id, kind, version, filename, sha256, storage_uri, status FROM artifact_versions WHERE matter_id = ? ORDER BY created_at`,
    [matterId],
  );
  let unresolved = 0;
  for (const a of arts) {
    let raw: Buffer;
    try {
      raw = d.blobs.read(a.storage_uri);
    } catch {
      missing.push({ document_version_id: a.artifact_version_id, filename: a.filename, reason: "成果文件不可读" });
      continue;
    }
    const out = d.tokens ? restoreArtifactBytes(a.filename, raw, (t) => d.tokens!.restore(matterId, t)) : { bytes: raw, restored: 0, unresolved: [] as string[], changed: false };
    unresolved += out.unresolved.length;
    add(`artifacts/${safeName(`${a.kind}-v${a.version}-${a.filename}`)}`, out.bytes, `登记 hash ${a.sha256}（代号形态）；状态 ${a.status}`);
  }

  // 3. 风险卡与事实行（代号还原）
  const cards = d.db.all<Record<string, any>>(`SELECT * FROM risk_cards WHERE matter_id = ? ORDER BY document_version_id, seq`, [matterId]).map((c) => ({
    card_id: c.card_id,
    run_id: c.run_id,
    document_version_id: c.document_version_id,
    clause_ref: c.clause_ref,
    anchor_text: restoreText(c.anchor_text),
    anchor_status: c.anchor_status,
    severity: c.severity,
    category: c.category,
    issue: restoreText(c.issue),
    basis: parseJson(c.basis, []),
    nature: c.nature ?? null,
    suggestion: restoreText(c.suggestion),
    fallback: restoreText(c.fallback),
    bottom_line: restoreText(c.bottom_line),
    needs_client_decision: c.needs_client_decision === 1,
    status: c.status,
    final_text: c.final_text,
    decided_by: c.decided_by,
    decided_at: c.decided_at,
  }));
  const facts = d.db.all<Record<string, any>>(`SELECT * FROM matter_facts WHERE matter_id = ? ORDER BY seq`, [matterId]).map((f) => ({
    fact_id: f.fact_id,
    run_id: f.run_id,
    statement: restoreText(f.statement),
    kind: f.kind,
    occurred_on: f.occurred_on,
    amount_yuan: f.amount_yuan,
    party: restoreText(f.party),
    document_version_id: f.document_version_id,
    quote: restoreText(f.quote),
    status: f.status,
    decided_by: f.decided_by,
    decided_at: f.decided_at,
  }));
  add("review/risk-cards.json", Buffer.from(JSON.stringify(cards, null, 2), "utf8"));
  add("review/facts.json", Buffer.from(JSON.stringify(facts, null, 2), "utf8"));

  // 4. 签名事件链 + 业务行原样 + 设备证书 + 签发证明包
  const events = d.db.all<Record<string, any>>(`SELECT * FROM signed_events WHERE matter_id = ? ORDER BY seq`, [matterId]);
  const ledger: string[] = [JSON.stringify({ type: "header", format: "kwl-ledger-export-v1", matter_id: matterId, tenant_id: m.tenant_id, firm_root_public_key: d.firmRootPublicKeyPem })];
  for (const e of events) {
    // 见证行自带 type 列（事件类型）：改名 event_type，行类型标记放最后，不被覆盖
    ledger.push(JSON.stringify({ ...e, event_type: e.type, type: "signed_event" }));
    const row = businessRow(d.db, String(e.kind), String(e.ref_id));
    if (row) ledger.push(JSON.stringify({ type: "business_row", kind: e.kind, ref_id: e.ref_id, row }));
  }
  for (const dev of new Set(events.map((e) => String(e.signer_device_id)))) {
    const r = d.db.get(`SELECT device_id, member_id, role, status, cert_json FROM devices WHERE device_id = ?`, [dev]);
    if (r) ledger.push(JSON.stringify({ type: "device_cert", ...r }));
  }
  for (const a of d.db.all<Record<string, any>>(
    `SELECT a.approval_id, a.artifact_version_id, a.artifact_sha256, a.signed_payload, a.signature, a.signer_device_id, a.key_epoch
       FROM approvals a JOIN artifact_versions av ON av.artifact_version_id = a.artifact_version_id
      WHERE av.matter_id = ? AND a.signed_payload IS NOT NULL ORDER BY a.created_at`,
    [matterId],
  )) {
    ledger.push(JSON.stringify({ type: "approval_proof", ...a }));
  }
  add("ledger.jsonl", Buffer.from(`${ledger.join("\n")}\n`, "utf8"));
  add("README.txt", Buffer.from(README, "utf8"));
  add("signer-cert.json", Buffer.from(JSON.stringify(d.deviceCert, null, 2), "utf8"));
  add("firm-root.pem", Buffer.from(d.firmRootPublicKeyPem, "utf8"));

  const manifest: ArchiveManifest = {
    format: ARCHIVE_FORMAT,
    matter: {
      matter_id: m.matter_id,
      title: m.title,
      client_name: m.client_name,
      counterparty: m.counterparty,
      stance: m.stance,
      jurisdiction: m.jurisdiction,
      confidentiality: m.confidentiality,
      lifecycle: m.lifecycle ?? "active",
      closed_at: m.closed_at ?? null,
      retention_until: m.retention_until ?? null,
      legal_hold: m.legal_hold === 1,
      created_at: m.created_at,
    },
    exported_at: new Date().toISOString(),
    exported_by: opts.by,
    device_id: d.deviceId,
    files: entries.map((e) => ({ path: e.name, sha256: sha256Hex(e.data), bytes: e.data.length, ...(e.note ? { note: e.note } : {}) })),
    counts: {
      materials: entries.filter((e) => e.name.startsWith("materials/")).length,
      artifacts: entries.filter((e) => e.name.startsWith("artifacts/")).length,
      risk_cards: cards.length,
      facts: facts.length,
      signed_events: events.length,
      unresolved_tokens: unresolved,
    },
    missing,
  };
  const manifestJson = canonicalJson(manifest);
  const signature = d.signer.signSync(new TextEncoder().encode(manifestJson));
  const zip = writeZip([
    { name: "manifest.json", data: Buffer.from(manifestJson, "utf8") },
    { name: "manifest.sig", data: Buffer.from(signature, "utf8") },
    ...entries.map((e) => ({ name: e.name, data: e.data })),
  ]);
  const day = manifest.exported_at.slice(0, 10);
  return { filename: `${safeName(String(m.title))}-归档-${day}.zip`, zip, manifest, signature };
}
