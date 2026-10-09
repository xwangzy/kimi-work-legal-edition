/**
 * 内核 API（方案 v5.0 第 4 篇 §15.2：界面、加载项、节点共用的本机内核接口）。
 * 由 v4.0 BFF HTTP 路由平移为进程内方法；桌面（IPC）、Office 加载项（命名管道/本机端口）、
 * 所内节点都走这同一份方法表。签发已接入设备签名（§6.3）；审计事件入签名 hash 链（§6.4）；
 * 策略事件的签发人角色签名在同步阶段接入（当前经审计事件上链留痕）。
 */
import { readFileSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  ConsentStatus,
  CollabScope,
  DomainError,
  ModelEndpoint,
  RunStatus,
  assertIdempotencyKey,
  forbidden,
  newId,
  notFound,
  sha256Hex,
  validation,
} from "@zr-legal/domain";
import type { EgressGate } from "@zr-legal/egress";
import type { ModelBroker } from "@zr-legal/model-broker";
import type { Lawdb } from "@zr-legal/lawdb";
import { ocrModelsAvailable, type OcrModelPaths } from "@zr-legal/parse-ocr";
import {
  b64urlDecode,
  canonicalJson,
  combineRecoveryPrivateKey,
  createBreakGlassRecord,
  generateMatterKey,
  hashBreakGlassRecord,
  sha256B64,
  signBytes,
  unwrapMatterKey,
  unwrapPrivateKeyScrypt,
  verifyBytes,
  wrapMatterKey,
  wrapPrivateKeyScrypt,
  type DeviceCertificate,
} from "@zr-legal/keys";
import type { KernelDb } from "../db.ts";
import { nowIso } from "../db.ts";
import type { BlobStore } from "../blobs.ts";
import type { TaskQueue } from "../queue.ts";
import type { KernelConfig } from "../config.ts";
import type { Identity } from "../identity.ts";
import type { AsyncMutex } from "../mutex.ts";
import { currentTenantEpoch, ensureNodeDevice, type KernelKeyContext } from "../devices.ts";
import { rowPayloadHash, verifyCertSignature } from "../ledger-signer.ts";
import { syncExport, syncImport, syncStatus } from "../sync-engine.ts";
import { parseDocument } from "../services/parser.ts";
import { isImage, isPdf, ocrReady, parseWithPipeline } from "../services/parse-pipeline.ts";
import { estimatePoints, scenarioCap } from "../services/estimate.ts";
import { docxRenderReport } from "../tools/tools/docx.ts";

export interface ApiDeps {
  db: KernelDb;
  blobs: BlobStore;
  broker: ModelBroker;
  egress: EgressGate;
  queue: TaskQueue;
  config: KernelConfig;
  /** 签名法规库包（§9：法条核验全部离线；Source Registry 运行时强制）。 */
  lawdb: Lawdb;
  /** Agent 与 OCR 互斥锁（§4.5：8GB 笔记本互斥排队，内核级）。 */
  ioMutex: AsyncMutex;
  /** OCR 模型路径（缺失时 OCR 路径如实报不可用，文本层照常）。 */
  ocrModelPaths: OcrModelPaths;
  /** 开发/测试 mock OCR（ZR_PARSE_OCR_MOCK=1）。 */
  parseMock: boolean;
  /** 探针 2：本机端点非白名单路径请求计数（遥测/更新/远程控制零外连的行为证据）。 */
  localStats: { rejectedPathRequests: number; rejectedPaths: string[]; rejectedToolCalls: number };
  /** 密钥体系上下文（§5.3：签名事件链、本机设备证书、律所公钥）。 */
  keyctx: KernelKeyContext;
  /** 急停撤销任务令牌（§15.2 runs.cancel）。 */
  revokeRun?: (runId: string) => void;
}

type Handler = (params: any, id: Identity) => unknown | Promise<unknown>;

const SCENARIOS = new Set(["s1.contract_review", "s1b.draft_compare", "s2.case_file", "s6.redaction", "a1.agent_task"]);
const MAX_BYTES = 100 * 1024 * 1024; // 与 IM 100MB 口径一致

interface EstimateRec {
  estimate_id: string;
  matter_id: string;
  scenario: string;
  points: number;
  expires: number;
  input: any;
}
const estimates = new Map<string, EstimateRec>();

function parseJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== "string") return (v as T) ?? fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

function matterOut(m: any): any {
  return m ? { ...m, key_dates: parseJson(m.key_dates, {}) } : m;
}

function runOut(r: any): any {
  return r ? { ...r, input_snapshot: parseJson(r.input_snapshot, {}) } : r;
}

function artifactOut(a: any): any {
  return a ? { ...a, open_items: parseJson(a.open_items, []), manifest: parseJson(a.manifest, {}) } : a;
}

function requireMatterAccess(db: KernelDb, matterId: string, id: Identity): any {
  // 成员校验（§15.2：不泄露无权事项是否存在——不存在与非成员统一 404；
  // 密钥级伦理墙已就位于密钥分发层：非成员设备拿不到事项密钥（matter_keys）；按密钥过滤检索在同步/索引阶段）
  const m = db.get(
    `SELECT m.* FROM matters m JOIN matter_members mm ON mm.matter_id = m.matter_id AND mm.user_id = ? AND mm.removed_at IS NULL
      WHERE m.matter_id = ? AND m.tenant_id = ?`,
    [id.userId, matterId, id.tenantId],
  );
  if (!m) throw new DomainError("not_found", "事项不存在或无权查看", 404);
  return m;
}

function requireRunAccess(db: KernelDb, runId: string, id: Identity): any {
  const r = db.get(
    `SELECT r.* FROM runs r JOIN matter_members mm ON mm.matter_id = r.matter_id AND mm.user_id = ? AND mm.removed_at IS NULL
      WHERE r.run_id = ? AND r.tenant_id = ?`,
    [id.userId, runId, id.tenantId],
  );
  if (!r) throw new DomainError("not_found", "任务不存在或无权查看", 404);
  return r;
}

function requireArtifact(db: KernelDb, artifactVersionId: string, id: Identity): any {
  const a = db.get(
    `SELECT av.* FROM artifact_versions av JOIN matter_members mm ON mm.matter_id = av.matter_id AND mm.user_id = ? AND mm.removed_at IS NULL
      WHERE av.artifact_version_id = ? AND av.tenant_id = ?`,
    [id.userId, artifactVersionId, id.tenantId],
  );
  if (!a) throw notFound("成果");
  return a;
}

function audit(db: KernelDb, id: Identity, action: string, kind: string, objectId: string, detailHash: string | undefined, keyctx: KernelKeyContext): void {
  db.tx(() => {
    const r = db.run(`INSERT INTO audit_events (tenant_id, actor_id, action, object_kind, object_id, detail_hash) VALUES (?,?,?,?,?,?)`, [
      id.tenantId,
      id.userId,
      action,
      kind,
      objectId,
      detailHash ?? null,
    ]);
    // 同事务追加签名见证（§5.2/§6.4：审计事件入签名 hash 链；payload_hash 为整行 canonical 哈希）
    const row = db.get<Record<string, unknown>>(`SELECT * FROM audit_events WHERE audit_event_id = ?`, [Number(r.lastInsertRowid)]);
    keyctx.signer.append({ kind: "audit_event", refId: String(r.lastInsertRowid), matterId: auditMatterId(db, kind, objectId), type: action, payloadHash: rowPayloadHash(row ?? {}) });
  });
}

/** 审计事件关联事项（能解析则带上，便于按事项导出与校验；设备类事件无事项）。 */
function auditMatterId(db: KernelDb, kind: string, objectId: string): string | null {
  if (kind === "matter") return objectId;
  if (kind === "artifact") return db.get<{ matter_id: string }>(`SELECT matter_id FROM artifact_versions WHERE artifact_version_id = ?`, [objectId])?.matter_id ?? null;
  if (kind === "document") return db.get<{ matter_id: string }>(`SELECT matter_id FROM document_versions WHERE document_version_id = ?`, [objectId])?.matter_id ?? null;
  return null;
}

function registerParsedDocumentRemoved(): void {
  // （已移除：解析登记在 insertDocumentWithParse 内完成）
}
void registerParsedDocumentRemoved;

export function createApi(deps: ApiDeps): Record<string, Handler> {
  const { db, blobs, broker, egress, queue, config, lawdb, keyctx, ioMutex, ocrModelPaths, parseMock, localStats, revokeRun } = deps;

  /** 统一解析入口：PDF/JPG/PNG 走隔离进程管线（持互斥锁，§4.5）；DOCX/TXT 维持 v0 粗解析。 */
  async function parseAny(buf: Buffer, filename: string, mime: string): Promise<{ text: string; pageCount: number | null; qualityFlags: string[]; parser: string; parserVersion: string; pages?: { pageNo: number; kind: string; quality: string; note?: string | undefined; charCount: number; meanScore?: number | undefined }[] }> {
    if (isPdf(filename, mime) || isImage(filename, mime)) {
      const r = await ioMutex.runExclusive(() => parseWithPipeline(buf, filename, mime, { ocrModelPaths, mockOcr: parseMock }));
      return r;
    }
    return parseDocument(filename, mime, buf);
  }

  async function insertDocumentWithParse(args: {
    matterId: string;
    tenantId: string;
    filename: string;
    bytes: Buffer;
    mime: string;
    storageMode: "mount" | "import";
    storageUri: string;
    sha256: string;
    uploadedBy: string;
  }): Promise<{ document_version_id: string; parse_version_id: string; quality_flags: string[]; chars: number }> {
    const parsed = await parseAny(args.bytes, args.filename, args.mime);
    const docId = newId("documentVersion");
    const psvId = newId("parseVersion");
    db.tx(() => {
      db.run(
        `INSERT INTO document_versions (document_version_id, matter_id, tenant_id, filename, sha256, size_bytes, mime, storage_mode, storage_uri, uploaded_by)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [docId, args.matterId, args.tenantId, args.filename, args.sha256, args.bytes.length, args.mime, args.storageMode, args.storageUri, args.uploadedBy],
      );
      db.run(
        `INSERT INTO parse_versions (parse_version_id, document_version_id, parser, parser_version, page_count, quality_flags, text_uri)
         VALUES (?,?,?,?,?,?,?)`,
        [psvId, docId, parsed.parser, parsed.parserVersion, parsed.pageCount, JSON.stringify(parsed.qualityFlags), `db://parse_texts/${psvId}`],
      );
      db.run(`INSERT INTO parse_texts (parse_version_id, content) VALUES (?,?)`, [psvId, parsed.text]);
      insertParsePages(psvId, parsed.pages);
    });
    return { document_version_id: docId, parse_version_id: psvId, quality_flags: parsed.qualityFlags, chars: parsed.text.length };
  }

  function insertParsePages(psvId: string, pages?: { pageNo: number; kind: string; quality: string; note?: string | undefined; charCount: number; meanScore?: number | undefined }[]): void {
    for (const pg of pages ?? []) {
      db.run(`INSERT INTO parse_pages (parse_version_id, page_no, kind, quality, note, char_count, mean_score) VALUES (?,?,?,?,?,?,?)`, [
        psvId,
        pg.pageNo,
        pg.kind,
        pg.quality,
        pg.note ?? null,
        pg.charCount,
        pg.meanScore ?? null,
      ]);
    }
  }

  const api: Record<string, Handler> = {
    // ─── 事项（§15.2 matters.create/update） ───
    "matters.create": (body, id) => {
      if (!body?.title || typeof body.title !== "string") throw validation("需要 title");
      if (!body?.stance || typeof body.stance !== "string") throw validation("需要 stance（我方立场）");
      const endpoint = body.model_endpoint ?? ModelEndpoint.standard;
      if (!Object.values(ModelEndpoint).includes(endpoint)) throw validation(`model_endpoint 须为 ${Object.values(ModelEndpoint).join("/")}`);
      const scope = body.collab_scope ?? CollabScope.personal;
      if (!Object.values(CollabScope).includes(scope)) throw validation(`collab_scope 须为 personal/team`);
      const consent = body.consent_status ?? ConsentStatus.pending;
      if (!Object.values(ConsentStatus).includes(consent)) throw validation(`consent_status 须为 ${Object.values(ConsentStatus).join("/")}`);
      const matterId = newId("matter");
      db.tx(() => {
        db.run(
          `INSERT INTO matters (matter_id, tenant_id, title, client_name, counterparty, stance, jurisdiction,
                                key_dates, confidentiality, model_endpoint, collab_scope, consent_status, created_by)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            matterId,
            id.tenantId,
            body.title,
            body.client_name ?? null,
            body.counterparty ?? null,
            body.stance,
            body.jurisdiction ?? "内地民商事",
            JSON.stringify(body.key_dates ?? {}),
            body.confidentiality ?? "normal",
            endpoint,
            scope,
            consent,
            id.userId,
          ],
        );
        db.run(
          `INSERT INTO matter_members (matter_id, user_id, matter_role, added_by, removed_at, removed_lamport, author_device, row_lamport) VALUES (?,?,'owner',?,NULL,NULL,?,?)`,
          [matterId, id.userId, id.userId, keyctx.device.deviceId, nextLocalLamport(db)],
        );
        // 事项密钥（§5.3 伦理墙由密钥分发实现）：epoch=1，包裹给创建者当前设备 + 恢复托管公钥；
        // 律所根密钥不解事项密钥——恢复只走 recovery 包裹行（M-of-N 重组后解）
        const matterKey = generateMatterKey();
        db.run(`INSERT INTO matter_keys (matter_id, epoch, wrapped_for, wrapped_key) VALUES (?,1,?,?)`, [
          matterId,
          keyctx.device.deviceId,
          wrapMatterKey(matterKey, keyctx.device.keys.encPublicKeyPem),
        ]);
        db.run(`INSERT INTO matter_keys (matter_id, epoch, wrapped_for, wrapped_key) VALUES (?,1,'recovery',?)`, [
          matterId,
          wrapMatterKey(matterKey, keyctx.firm.recoveryPublicKeyPem),
        ]);
      });
      audit(db, id, "matter.create", "matter", matterId, undefined, keyctx);
      return { matter: matterOut(db.get(`SELECT * FROM matters WHERE matter_id = ?`, [matterId])) };
    },

    "matters.list": (_p, id) => {
      const rows = db.all(
        `SELECT m.matter_id, m.title, m.client_name, m.counterparty, m.stance, m.jurisdiction, m.confidentiality,
                m.model_endpoint, m.collab_scope, m.consent_status, m.status, m.created_at
           FROM matters m JOIN matter_members mm ON mm.matter_id = m.matter_id AND mm.user_id = ? AND mm.removed_at IS NULL
          WHERE m.tenant_id = ? AND m.status = 'active' ORDER BY m.created_at DESC LIMIT 100`,
        [id.userId, id.tenantId],
      );
      return { matters: rows };
    },

    "matters.get": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      const docs = db.all(
        `SELECT document_version_id, filename, sha256, size_bytes, mime, storage_mode, created_at
           FROM document_versions WHERE matter_id = ? ORDER BY created_at DESC`,
        [matter.matter_id],
      );
      return { matter: matterOut(matter), documents: docs };
    },

    "matters.update": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterWriter(db, matter.matter_id, id);
      const body = p?.patch ?? {};
      const fields: string[] = [];
      const values: unknown[] = [];
      const simple = ["title", "client_name", "counterparty", "stance", "jurisdiction", "confidentiality"] as const;
      for (const f of simple) {
        if (body[f] !== undefined) {
          fields.push(`${f} = ?`);
          values.push(body[f]);
        }
      }
      if (body.key_dates !== undefined) {
        fields.push(`key_dates = ?`);
        values.push(JSON.stringify(body.key_dates));
      }
      // 模型端点 / 协作范围 / 当事人同意：策略类变更（审计事件入签名链留痕；签发人角色签名在同步阶段接入）
      for (const [f, allowed] of [
        ["model_endpoint", Object.values(ModelEndpoint)],
        ["collab_scope", Object.values(CollabScope)],
        ["consent_status", Object.values(ConsentStatus)],
      ] as const) {
        if (body[f] !== undefined) {
          if (!(allowed as readonly string[]).includes(body[f])) throw validation(`${f} 非法值 ${body[f]}`);
          fields.push(`${f} = ?`);
          values.push(body[f]);
        }
      }
      if (fields.length === 0) throw validation("无可更新字段");
      fields.push(`policy_version = policy_version + 1`);
      db.run(`UPDATE matters SET ${fields.join(", ")} WHERE matter_id = ?`, [...values, matter.matter_id]);
      audit(db, id, "matter.update", "matter", matter.matter_id, sha256Hex(JSON.stringify(body)), keyctx);
      return { matter: matterOut(db.get(`SELECT * FROM matters WHERE matter_id = ?`, [matter.matter_id])), note: "关键口径变更已记录（审计事件已入签名链）；策略事件的签发人角色签名在同步阶段接入" };
    },

    // ─── 材料（§15.2 materials.mount/import：原件不修改；变化即新版本） ───
    "materials.import": async (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterWriter(db, matter.matter_id, id);
      let bytes: Buffer;
      let filename: string;
      if (p?.path) {
        // Electron 桌面：按路径读取（不经过 IPC 传字节）；符号链接不跟随（探针 3：防快照外目标逃逸）
        const st = lstatSync(String(p.path));
        if (st.isSymbolicLink()) throw validation("符号链接不跟随：请导入真实文件本身（防越界引用）");
        bytes = readFileSync(String(p.path));
        filename = String(p.filename ?? basename(String(p.path)));
      } else if (p?.data_base64) {
        bytes = Buffer.from(String(p.data_base64), "base64");
        filename = String(p.filename ?? "未命名");
      } else {
        throw validation("需要 path 或 data_base64");
      }
      if (bytes.length === 0 || bytes.length > MAX_BYTES) throw validation(`文件大小非法（上限 ${MAX_BYTES}）`);
      const sha256 = sha256Hex(bytes);
      if (p?.sha256 && p.sha256 !== sha256) throw new DomainError("hash_mismatch", "内核复算 hash 与声明不符，已拒收", 422);
      const stored = blobs.put(bytes, matter.matter_id);
      const result = await insertDocumentWithParse({
        matterId: matter.matter_id,
        tenantId: id.tenantId,
        filename,
        bytes,
        mime: String(p?.mime ?? "application/octet-stream"),
        storageMode: "import",
        storageUri: stored.storage_uri,
        sha256,
        uploadedBy: id.userId,
      });
      audit(db, id, "materials.import", "document", result.document_version_id, sha256, keyctx);
      return { ...result, sha256, note: "导入副本进入内容寻址块（不可变）；纠错请上传新版本" };
    },

    "materials.mount": async (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterWriter(db, matter.matter_id, id);
      const path = String(p?.path ?? "");
      if (!path) throw validation("需要 path（挂载本机或共享位置的文件）");
      const st = lstatSync(path); // 符号链接不跟随（探针 3）
      if (st.isSymbolicLink()) throw validation("符号链接不跟随：请挂载真实文件本身（防越界引用）");
      if (!st.isFile()) throw validation("path 不是文件（目录挂载在 W6 接入）");
      if (st.size > MAX_BYTES) throw validation(`文件大小超限（${MAX_BYTES}）`);
      const bytes = readFileSync(path); // 只读引用：不复制、不修改
      const sha256 = sha256Hex(bytes);
      const filename = String(p?.filename ?? basename(path));
      const result = await insertDocumentWithParse({
        matterId: matter.matter_id,
        tenantId: id.tenantId,
        filename,
        bytes,
        mime: String(p?.mime ?? "application/octet-stream"),
        storageMode: "mount",
        storageUri: `file://${path}`,
        sha256,
        uploadedBy: id.userId,
      });
      audit(db, id, "materials.mount", "document", result.document_version_id, sha256, keyctx);
      return { ...result, sha256, note: "挂载为只读引用：原件不复制、不修改；读取时复算 hash，变化即生成新文档版本" };
    },

    /**
     * 重新解析（§8.1：低质量页可重扫、可人工纠正）——对既有文档版本重跑解析管线，
     * 生成新 parse_version（原件永不修改；旧解析版本保留供溯源；后续任务取最新解析版本）。
     */
    "materials.reparse": async (p, id) => {
      const docId = String(p?.document_version_id ?? "");
      const doc = db.get<any>(
        `SELECT dv.* FROM document_versions dv JOIN matter_members mm ON mm.matter_id = dv.matter_id AND mm.user_id = ? AND mm.removed_at IS NULL
         WHERE dv.document_version_id = ? AND dv.tenant_id = ?`,
        [id.userId, docId, id.tenantId],
      );
      if (doc) requireMatterWriter(db, doc.matter_id, id);
      if (!doc) throw notFound("文档");
      let bytes: Buffer;
      try {
        bytes = doc.storage_mode === "import" ? blobs.read(String(doc.storage_uri)) : readFileSync(String(doc.storage_uri).replace(/^file:\/\//, ""));
      } catch (e) {
        throw new DomainError("not_found", `原件不可读（${(e as Error)?.message ?? e}），无法重解析`, 404);
      }
      if (sha256Hex(bytes) !== doc.sha256) {
        throw new DomainError("hash_mismatch", "原件 hash 与登记不符（文件已变化）：请按新文档版本导入，不覆盖重解析", 422);
      }
      const parsed = await parseAny(bytes, String(doc.filename), String(doc.mime));
      const psvId = newId("parseVersion");
      db.tx(() => {
        db.run(
          `INSERT INTO parse_versions (parse_version_id, document_version_id, parser, parser_version, page_count, quality_flags, text_uri)
           VALUES (?,?,?,?,?,?,?)`,
          [psvId, docId, parsed.parser, parsed.parserVersion, parsed.pageCount, JSON.stringify(parsed.qualityFlags), `db://parse_texts/${psvId}`],
        );
        db.run(`INSERT INTO parse_texts (parse_version_id, content) VALUES (?,?)`, [psvId, parsed.text]);
        insertParsePages(psvId, parsed.pages);
      });
      audit(db, id, "materials.reparse", "document", docId, sha256Hex(bytes), keyctx);
      const low = (parsed.pages ?? []).filter((x) => x.quality !== "ok");
      return {
        parse_version_id: psvId,
        quality_flags: parsed.qualityFlags,
        chars: parsed.text.length,
        page_count: parsed.pageCount,
        pages_with_issues: low.length,
        note: `已生成新解析版本（原件未修改，hash 一致；旧解析版本保留）。${ocrReady({ ocrModelPaths, mockOcr: parseMock }) ? "" : "本机 OCR 未就绪：扫描/图片页按 unreadable 标记，未伪造文本。"}`,
      };
    },

    // ─── 当事人告知函（第 2 篇 §4.2：「待取得」状态的内置告知——一键生成告知函，回执由律师线下取得后改状态） ───
    "matters.consent_notice": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      const client = matter.client_name ?? "（当事人）";
      const report = docxRenderReport(blobs, {
        title: "关于使用人工智能辅助工具处理委托事项的告知函",
        sections: [
          {
            heading: "一、拟使用的工具与处理方式",
            paragraphs: [
              `尊敬的 ${client}：`,
              `就「${matter.title}」事项，本所拟使用 Kimi Work 法律行业发行版（人工智能辅助工具）协助处理相关材料。`,
              "材料默认在本所律师电脑或所内节点处理，不上传至第三方云平台托管；仅经化名校验（替换直接标识符）的必要片段会发送至模型服务（中软 MaaS 法律通道 → Kimi 大模型）用于分析推理。",
            ],
          },
          {
            heading: "二、数据去向与您的选择",
            paragraphs: [
              "每一次向模型发送的内容均有逐段记录（数据去向卡），本所可应您要求出示。",
              "您可以拒绝云端处理：本所将仅使用本机能力（整理、比对、脱敏、法条核验、文书生成）或（如已部署）所内私有模型处理您的事项，可能带来质量与时效差异，本所将如实说明。",
            ],
          },
          {
            heading: "三、回执",
            paragraphs: [
              "请勾选并签署：□ 同意按上述方式处理；□ 拒绝云端处理（仅本机能力/私有模型）。",
              "签署人：＿＿＿＿＿＿＿＿　日期：＿＿＿＿年＿＿月＿＿日",
              "（本函由系统按模板生成，发出前须经经办律师复核；模板版本 consent-notice-v0，批量告知与回执管理在 G1 管理控制台提供）",
            ],
          },
        ],
      }, matter.matter_id);
      const artifactId = newId("artifactVersion");
      const v = db.get<{ next: number }>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM artifact_versions WHERE matter_id = ? AND kind = 'consent_notice' AND audience = 'internal'`,
        [matter.matter_id],
      )!;
      db.run(
        `INSERT INTO artifact_versions
          (artifact_version_id, tenant_id, matter_id, run_id, kind, version, baseline_id, audience, status,
           filename, sha256, storage_uri, open_items, manifest, created_by)
         VALUES (?,?,?,NULL,'consent_notice',?,NULL,'internal','draft',?,?,?,?,?,?)`,
        [
          artifactId,
          id.tenantId,
          matter.matter_id,
          v.next,
          `当事人告知函-${matter.title.slice(0, 20)}-v${v.next}.docx`,
          report.sha256,
          report.storage_uri,
          "[]",
          JSON.stringify({ template: "consent-notice-v0", note: "模板生成，发出前须律师复核；回执取得后请在事项中更新当事人同意状态" }),
          id.userId,
        ],
      );
      audit(db, id, "matter.consent_notice", "matter", matter.matter_id, report.sha256, keyctx);
      return { artifact_version_id: artifactId, filename: `当事人告知函-${matter.title.slice(0, 20)}-v${v.next}.docx`, sha256: report.sha256, note: "告知函已生成（草稿）；回执取得后请在事项头部将当事人同意改为「已同意」" };
    },

    // ─── 任务（§15.2 runs.estimate/start/events/cancel：先预估、后确认；同键同内容返回原任务） ───
    "runs.estimate": (p, id) => {
      const matterId = String(p?.matter_id ?? "");
      const matter = requireMatterAccess(db, matterId, id);
      requireMatterWriter(db, matter.matter_id, id);
      if (!SCENARIOS.has(p?.scenario)) throw validation(`scenario 须为 ${[...SCENARIOS].join(" / ")}`);
      const docIds: string[] = p?.document_version_ids ?? [];
      let pages = 0;
      for (const docId of docIds) {
        const r = db.get<{ page_count: number | null }>(
          `SELECT page_count FROM parse_versions WHERE document_version_id = ? ORDER BY created_at DESC LIMIT 1`,
          [docId],
        );
        pages += r?.page_count ?? 0;
      }
      const est = estimatePoints({ scenario: p.scenario, material_count: docIds.length, total_pages: pages });
      if (est.points === 0) throw validation(est.assumptions[0] ?? "不可估价");
      const estimateId = newId("estimate");
      estimates.set(estimateId, { estimate_id: estimateId, matter_id: matterId, scenario: p.scenario, points: est.points, expires: Date.now() + est.valid_seconds * 1000, input: p });
      // 数据去向预览（§15.2：先预估、后确认——预计点数与数据去向同时展示）
      const endpointLabels: Record<string, string> = {
        standard: "Kimi 模型（经中软 MaaS 法律通道）",
        byok: "Kimi 模型（律所自带密钥，不经中软）",
        private: "律所内私有模型",
        none: "不使用模型（仅本机能力）",
      };
      const usesModel = p.scenario === "s1.contract_review" || p.scenario === "a1.agent_task";
      const consentBlocked =
        matter.consent_status === "pending" ||
        (matter.consent_status === "refused" && matter.model_endpoint !== "private") ||
        (matter.confidentiality === "strict" && matter.model_endpoint !== "private") ||
        matter.model_endpoint === "none";
      const dataWhere = {
        model_endpoint: matter.model_endpoint,
        consent_status: matter.consent_status,
        preview:
          usesModel && matter.model_endpoint !== "none"
            ? `将发送：${docIds.length} 份文档的片段（经化名校验）→ ${endpointLabels[matter.model_endpoint] ?? matter.model_endpoint}；每次发送记入数据去向卡`
            : usesModel
              ? "该事项「不使用模型」：本场景模型步骤将被拦截（仅本机能力可用）"
              : "本场景全部步骤在本机完成，不调用模型、无外发",
        warning:
          usesModel && consentBlocked
            ? matter.consent_status === "pending"
              ? "当事人同意「待取得」：模型步骤将被出站闸门拦截（只用本机能力）；可一键生成告知函，或改为「无需/已同意」"
              : matter.model_endpoint === "none"
                ? "该事项「不使用模型」：S1/A1 的模型步骤将被拦截"
                : matter.confidentiality === "strict"
                  ? "保密等级 strict（v0 视为「拒绝云端」）：只允许私有模型端点"
                  : "当事人「已拒绝」：只能使用律所内私有模型或不使用模型"
            : null,
        caps: { per_request_chars: 200_000, per_task_chars: 1_000_000 },
      };
      return { estimate_id: estimateId, ...est, points_display: `预计 ${est.points} 点`, data_where: dataWhere };
    },

    "runs.start": (p, id) => {
      const matterId = String(p?.matter_id ?? "");
      const matter = requireMatterAccess(db, matterId, id);
      requireMatterWriter(db, matter.matter_id, id);
      if (!p?.estimate_id) throw validation("需要 estimate_id");
      assertIdempotencyKey(String(p?.idempotency_key ?? ""));
      // 决定分析方向的关键项缺失时先补齐，不自动猜测（§2.1）
      if (!matter.stance || matter.stance.startsWith("待定")) {
        throw validation("请先在事项中确认我方立场（决定分析方向的关键项，不自动猜测）", { field: "stance" });
      }
      if (!matter.jurisdiction) {
        throw validation("请先确认法域与地域（香港法和跨境案件不能默默套内地规则）", { field: "jurisdiction" });
      }
      const est = estimates.get(String(p.estimate_id));
      if (!est || est.matter_id !== matterId || est.expires < Date.now()) throw validation("估算单不存在或已过期，请重新估价");
      const budgetCap = Number(p?.budget_points ?? est.points);
      const cap = scenarioCap(est.scenario);
      if (budgetCap <= 0 || budgetCap > cap) throw validation(`budget_points 超出单任务上限 ${cap}`);

      // 幂等：同键同内容返回原任务（§15.2）
      const existing = db.get(`SELECT run_id, status, input_snapshot FROM runs WHERE tenant_id = ? AND idempotency_key = ?`, [id.tenantId, String(p.idempotency_key)]);
      if (existing) {
        const same = parseJson<any>((existing as any).input_snapshot, {})?.estimate_id === est.estimate_id;
        if (!same) throw new DomainError("conflict", "幂等键已用于其他任务内容", 409);
        return { run_id: (existing as any).run_id, status: (existing as any).status, idempotent_replay: true };
      }

      const runId = newId("run");
      db.run(
        `INSERT INTO runs (run_id, tenant_id, matter_id, scenario, workflow_version, status, idempotency_key,
                           input_snapshot, budget_points, points_reserved, estimate_id, created_by)
         VALUES (?,?,?,?,'v5.0.0-g0','queued',?,?,?,?,?,?)`,
        [
          runId,
          id.tenantId,
          matterId,
          est.scenario,
          String(p.idempotency_key),
          JSON.stringify({ ...est.input, estimate_id: est.estimate_id, goal: p?.goal, topic_hint: p?.topic_hint ?? est.input.topic_hint }),
          Math.min(est.points, budgetCap),
          Math.min(est.points, budgetCap),
          est.estimate_id,
          id.userId,
        ],
      );
      queue.enqueue(runId);
      return { run_id: runId, status: "queued", points_reserved: Math.min(est.points, budgetCap) };
    },

    "runs.get": (p, id) => {
      const run = requireRunAccess(db, String(p?.run_id ?? ""), id);
      const artifacts = db.all(
        `SELECT artifact_version_id, kind, version, audience, status, filename, sha256, created_at
           FROM artifact_versions WHERE run_id = ? ORDER BY created_at`,
        [run.run_id],
      );
      return { run: runOut(run), artifacts };
    },

    "runs.events": (p, id) => {
      const run = requireRunAccess(db, String(p?.run_id ?? ""), id);
      const cursor = Number(p?.cursor ?? 0);
      const limit = Math.min(Number(p?.limit ?? 100), 500);
      const rows = db.all(
        `SELECT event_id, seq, type, payload, created_at FROM run_events
          WHERE run_id = ? AND event_id > ? ORDER BY event_id LIMIT ?`,
        [run.run_id, Number.isFinite(cursor) ? cursor : 0, limit],
      );
      const events = rows.map((e: any) => ({ ...e, payload: parseJson(e.payload, {}) }));
      const nextCursor = events.length > 0 ? (events.at(-1) as any).event_id : cursor;
      return { events, next_cursor: nextCursor, run_status: run.status };
    },

    /**
     * 转到所内节点执行（§5.1：律师电脑离线时由节点继续执行已转交的任务；仅限已授权事项）。
     * 入队即校验（硬门禁第一处）：node_allowed=1 且非 strict——未授权/strict/伦理墙事项零字节到节点。
     */
    "runs.node_enqueue": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterWriter(db, matter.matter_id, id);
      const scenario = String(p?.scenario ?? "");
      if (!SCENARIOS.has(scenario)) throw validation(`scenario 须为 ${[...SCENARIOS].join(" / ")}`);
      if (matter.confidentiality === "strict") throw forbidden("保密等级 strict 的事项不得转交节点（§5.3：只在成员电脑上运行）");
      if (matter.node_allowed !== 1) throw forbidden("该事项未授权节点执行：请先由事项负责人 matters.node_authorize");
      const idem = String(p?.idempotency_key ?? "");
      assertIdempotencyKey(idem);
      // 幂等：task_id 由 (tenant, idempotency_key) 确定性派生——同键同内容返回原任务
      const taskId = `nt_${sha256Hex(`${id.tenantId}|${idem}`).slice(0, 24)}`;
      const existing = db.get<any>(`SELECT task_id, status FROM node_tasks WHERE task_id = ? AND tenant_id = ?`, [taskId, id.tenantId]);
      if (existing) return { task_id: existing.task_id, status: existing.status, idempotent_replay: true };
      const input = { scenario, ...(p?.input ?? {}) };
      db.run(`INSERT INTO node_tasks (task_id, tenant_id, matter_id, scenario, input_json, status, created_by) VALUES (?,?,?,?,?,'queued',?)`, [
        taskId,
        id.tenantId,
        matter.matter_id,
        scenario,
        JSON.stringify(input),
        id.userId,
      ]);
      audit(db, id, "run.node_enqueue", "matter", matter.matter_id, scenario, keyctx);
      // 同步收敛窗口收窄：配置了共享目录时内联导出一次（幂等；失败不阻断转交）
      let inlineExported = false;
      if (config.syncShareDir) {
        try {
          syncExport({ db, blobs, keyctx, tenantId: id.tenantId }, { shareDir: config.syncShareDir, matterId: matter.matter_id });
          inlineExported = true;
        } catch (e) {
          console.warn(`[kernel] node_enqueue 内联导出失败（不阻断转交）：${(e as Error)?.message ?? e}`);
        }
      }
      return {
        task_id: taskId,
        status: "queued",
        inline_sync_exported: inlineExported,
        note: "已转交节点执行（节点服务环拾取后走同一内核链路，结果经同步回来）；执行前节点侧将再校验授权（授权撤销则拒跑）",
      };
    },

    "node_tasks.list": (p, id) => {
      const matterId = String(p?.matter_id ?? "");
      if (matterId) requireMatterAccess(db, matterId, id);
      // 执行状态经 runs 行收敛：节点侧 start 的 idempotency_key 形如 node-task-<task_id>-att<N>
      // （node_tasks 登记行插入同步不回写 run_id——任务级状态双向收敛在 G1）
      const sql = `SELECT nt.task_id, nt.matter_id, nt.scenario, nt.status, nt.run_id, nt.error, nt.attempt_count, nt.created_at, nt.started_at, nt.ended_at,
                          r.run_id AS exec_run_id, r.status AS run_status
                     FROM node_tasks nt
                     LEFT JOIN runs r ON r.idempotency_key LIKE 'node-task-' || nt.task_id || '-att%'
                    ORDER BY nt.created_at DESC`;
      const rows = matterId
        ? db.all(
            `SELECT nt.task_id, nt.matter_id, nt.scenario, nt.status, nt.run_id, nt.error, nt.attempt_count, nt.created_at, nt.started_at, nt.ended_at,
                    r.run_id AS exec_run_id, r.status AS run_status
               FROM node_tasks nt
               LEFT JOIN runs r ON r.idempotency_key LIKE 'node-task-' || nt.task_id || '-att%'
              WHERE nt.matter_id = ? ORDER BY nt.created_at DESC LIMIT 100`,
            [matterId],
          )
        : db.all(
            `SELECT nt.task_id, nt.matter_id, nt.scenario, nt.status, nt.run_id, nt.error, nt.attempt_count, nt.created_at, nt.started_at, nt.ended_at,
                    r.run_id AS exec_run_id, r.status AS run_status
               FROM node_tasks nt
               LEFT JOIN runs r ON r.idempotency_key LIKE 'node-task-' || nt.task_id || '-att%'
              WHERE nt.tenant_id = ? ORDER BY nt.created_at DESC LIMIT 100`,
            [id.tenantId],
          );
      void sql;
      return { tasks: rows };
    },

    // ─── 定时与批量任务登记（§5.1：期限提醒/事项周报/法规观察；只限授权事项） ───
    "jobs.create": (p, id) => {
      const kind = String(p?.kind ?? "");
      if (!["deadline_reminder", "matter_weekly_report", "lawdb_watch"].includes(kind)) throw validation("kind 须为 deadline_reminder/matter_weekly_report/lawdb_watch");
      const matterId = p?.matter_id ? String(p.matter_id) : null;
      if (matterId) {
        const matter = requireMatterAccess(db, matterId, id);
        requireMatterWriter(db, matter.matter_id, id);
        requireMatterOwner(db, matter.matter_id, id);
        if (matter.confidentiality === "strict") throw forbidden("strict 事项不得配置节点定时任务");
        if (matter.node_allowed !== 1) throw forbidden("该事项未授权节点执行：定时与批量只限授权事项（§5.1）");
      }
      const interval = Number(p?.interval_seconds ?? p?.cron_expr ?? 86_400);
      if (!Number.isInteger(interval) || interval < 60) throw validation("interval_seconds 须为 ≥60 的整数（v0 以间隔秒替代 cron 表达式，cron 解析 G1）");
      const jobId = `job_${newId("run").slice(4)}`;
      db.run(`INSERT INTO scheduled_jobs (job_id, tenant_id, kind, matter_id, cron_expr, params_json, enabled, created_by) VALUES (?,?,?,?,?,?,1,?)`, [
        jobId,
        id.tenantId,
        kind,
        matterId,
        String(interval),
        JSON.stringify(p?.params ?? {}),
        id.userId,
      ]);
      audit(db, id, "job.create", matterId ? "matter" : "tenant", matterId ?? id.tenantId, kind, keyctx);
      return { job_id: jobId, kind, interval_seconds: interval, note: "已登记（由节点服务环按租约执行；产物为草稿事件/成果，IM 通知投递属阶段 6）" };
    },

    "jobs.list": (_p, id) => {
      const rows = db.all(`SELECT job_id, kind, matter_id, cron_expr, enabled, last_run_at, last_result, created_at FROM scheduled_jobs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100`, [id.tenantId]);
      return { jobs: rows };
    },

    "runs.cancel": (p, id) => {      const runId = String(p?.run_id ?? "");
      requireRunAccess(db, runId, id);
      requireMatterWriter(db, db.get(`SELECT matter_id FROM runs WHERE run_id = ?`, [runId]).matter_id, id);
      const expected = Number(p?.expected_version);
      if (!Number.isInteger(expected)) throw validation("需要 expected_version（乐观并发）");
      // 乐观并发：版本不符即拒绝，不静默覆盖（§4.4）
      const r = db.run(
        `UPDATE runs SET status = 'cancelled', cancel_reason = ?, status_version = status_version + 1, updated_at = ?
          WHERE run_id = ? AND status_version = ? AND status NOT IN ('succeeded','failed','cancelled')`,
        [String(p?.reason ?? "用户取消"), new Date().toISOString(), runId, expected],
      );
      if (r.changes === 0) {
        const cur = db.get(`SELECT status, status_version FROM runs WHERE run_id = ?`, [runId]) as any;
        throw new DomainError("conflict", `版本或状态已变化（当前 ${cur?.status} v${cur?.status_version}），请刷新后重试`, 409);
      }
      // 急停：立即撤销任务令牌（工具端点与模型代理即刻拒绝），Agent 宿主由协作式取消传播杀进程
      revokeRun?.(runId);
      return { run_id: runId, status: "cancelled", note: "已立即生效：任务令牌已撤销，工具端点与模型代理即刻拒绝；已发生的动作在事件中可见" };
    },

    // ─── 成果（§15.2 artifacts.revisions：冲突返回冲突状态，不静默覆盖） ───
    "artifacts.list": (p, id) => {
      const matterId = String(p?.matter_id ?? "");
      requireMatterAccess(db, matterId, id);
      const rows = db.all(
        `SELECT artifact_version_id, run_id, kind, version, audience, status, filename, sha256, created_at
           FROM artifact_versions WHERE matter_id = ? ORDER BY kind, version DESC`,
        [matterId],
      );
      return { artifacts: rows };
    },

    "artifacts.download": (p, id) => {
      const art = requireArtifact(db, String(p?.artifact_version_id ?? ""), id);
      const buf = blobs.read(String(art.storage_uri));
      const actual = sha256Hex(buf);
      if (actual !== art.sha256) throw new DomainError("hash_mismatch", "成果文件 hash 与登记不符（完整性校验失败）", 500);
      return { filename: art.filename, sha256: art.sha256, size_bytes: buf.length, data_base64: buf.toString("base64") };
    },

    "artifacts.revisionOps": (p, id) => {
      const art = artifactOut(requireArtifact(db, String(p?.artifact_version_id ?? ""), id));
      const ops = art.manifest?.revision_ops;
      const baseline = art.manifest?.baseline;
      if (!ops || !baseline) throw new DomainError("not_found", "该成果不含修订指令（非修订稿）", 404);
      return {
        baselineHash: baseline,
        ops,
        writeback_contract: {
          on_anchor_mismatch: "停止并转人工，不覆盖原件",
          author_marking: "修订作者区分 AI 建议与律师批准（§2.3）",
        },
      };
    },

    // ─── 复核与签发（§2.4/§2.5：三态分明；签发绑定最终字节 hash） ───
    "review.submit": (p, id) => {
      const art = requireArtifact(db, String(p?.artifact_version_id ?? ""), id);
      requireMatterWriter(db, art.matter_id, id);
      if (art.status !== "draft") throw new DomainError("conflict", `当前状态 ${art.status} 不能提交复核`, 409);
      db.run(`UPDATE artifact_versions SET status = 'pending_review' WHERE artifact_version_id = ? AND status = 'draft'`, [art.artifact_version_id]);
      audit(db, id, "artifact.submit_review", "artifact", art.artifact_version_id, undefined, keyctx);
      return { artifact_version_id: art.artifact_version_id, status: "pending_review" };
    },

    "review.completeness": (p, id) => {
      const art = artifactOut(requireArtifact(db, String(p?.artifact_version_id ?? ""), id));
      // 完整性单（§5.3）：材料覆盖 / 建议处理 / 引用核验 / 未决项 / 受众 / 确切文件 hash / 数据去向
      let materials: Record<string, unknown> = { note: "非任务产出" };
      let citations: Record<string, unknown> = { note: "无引用核验记录" };
      let unverifiedOffline = 0;
      if (art.run_id) {
        const evs = db.all(
          `SELECT type, payload FROM run_events WHERE run_id = ? AND type IN ('materials.loaded','citations.verified') ORDER BY seq`,
          [art.run_id],
        );
        for (const e of evs as any[]) {
          const payload = parseJson<any>(e.payload, {});
          if (e.type === "materials.loaded") materials = { loaded: payload.loaded, requested: payload.requested, failed: payload.failed };
          if (e.type === "citations.verified") {
            citations = { total: payload.total, intercepted: payload.intercepted, unverified_offline: payload.unverified_offline ?? 0, as_of: payload.as_of };
            unverifiedOffline = Number(payload.unverified_offline ?? 0);
          }
        }
      }
      let fileOk = false;
      try {
        fileOk = sha256Hex(blobs.read(String(art.storage_uri))) === art.sha256;
      } catch {
        fileOk = false;
      }
      const openItems = Array.isArray(art.open_items) ? art.open_items : [];
      const latest = db.get<{ v: number }>(
        `SELECT COALESCE(MAX(version), 0) AS v FROM artifact_versions WHERE matter_id = ? AND kind = ? AND audience = ?`,
        [art.matter_id, art.kind, art.audience],
      )!;
      const egressSummary = art.run_id ? egressSummaryOf(art.run_id) : null;
      return {
        artifact_version_id: art.artifact_version_id,
        filename: art.filename,
        sha256: art.sha256,
        status: art.status,
        audience: art.audience,
        kind: art.kind,
        version: art.version,
        is_latest_version: art.version === latest.v,
        completeness: {
          materials,
          citations,
          open_items: openItems,
          file_integrity: fileOk ? "ok" : "FAILED",
          audience_check: art.audience === "internal" ? "内部稿（不得外发）" : "受众净化待确认",
          ai_marking: "显式（文档属性含 AI 辅助起草标识）",
          egress: egressSummary,
        },
        blockers: [
          ...(fileOk ? [] : ["文件完整性校验失败"]),
          ...(openItems.length > 0 ? ["存在未决项，签发人须逐项确认"] : []),
          ...(unverifiedOffline > 0 ? [`存在 ${unverifiedOffline} 条未核实（离线）的引用（案号离线未核），不得签发，联网补核或改引后再提交`] : []),
          ...(art.version === latest.v ? [] : ["已有更新版本，本版不得签发（批准不跨版本）"]),
        ],
      };
    },

    "review.approve": (p, id) => {
      const art = requireArtifact(db, String(p?.artifact_version_id ?? ""), id);
      const decision = p?.decision;
      if (decision !== "approved" && decision !== "rejected") throw validation("decision 须为 approved/rejected");
      // hash 绑定：批准必须指向确切版本
      if (p?.expected_sha256 !== art.sha256) {
        throw new DomainError("approval_invalidated", "批准未绑定当前文件 hash（内容已变化或版本不符）", 409);
      }
      if (art.status !== "pending_review") throw new DomainError("conflict", `当前状态 ${art.status} 不能批准（须先提交复核）`, 409);
      const latest = db.get<{ v: number }>(
        `SELECT COALESCE(MAX(version), 0) AS v FROM artifact_versions WHERE matter_id = ? AND kind = ? AND audience = ?`,
        [art.matter_id, art.kind, art.audience],
      )!;
      if (art.version !== latest.v) {
        throw new DomainError("approval_invalidated", "已有更新版本：批准 A 版不能用于 B 版（§4.4）", 409);
      }
      const role = requireIssuerRole(db, art.matter_id, id);
      const approvalId = newId("approval");
      const checklistObj = (p?.checklist ?? {}) as Record<string, unknown>;
      const checklist = JSON.stringify(checklistObj);

      if (decision === "approved") {
        // 未核实（离线）的引用不得进入签发版（§9/第 5 篇 §2.1：案号离线未核 → 阻断签发）
        const unverified = unverifiedOfflineCount(db, art.run_id);
        if (unverified > 0) {
          throw new DomainError("unverified_citations", `存在 ${unverified} 条未核实（离线）的引用（案号离线未核）：该引用不得进入签发版。联网补核或改引后再签发`, 409, {
            unverified_offline: unverified,
          });
        }
        // 设备签名签发（§6.3）：绑定最终字节 hash——重算成果内容，与登记不符即拒签
        let actual: string;
        try {
          actual = sha256Hex(blobs.read(String(art.storage_uri)));
        } catch {
          throw new DomainError("artifact_changed", "成果内容不可读，无法签发（存储缺失）", 409);
        }
        if (actual !== art.sha256) {
          throw new DomainError("artifact_changed", "成果最终字节与登记 hash 不符（内容已变化），签发已阻止", 409);
        }
        // 保证等级（§6.3）：本机只产生 device_signature；im_witnessed 只由所内节点 IM 见证产生，本机不可自证
        const level = p?.assurance_level ?? "device_signature";
        if (level !== "device_signature") {
          throw validation("assurance_level 只接受 device_signature；im_witnessed 由所内节点 IM 见证产生，本机不可自证", { assurance_level: level });
        }
        const completenessHash = sha256B64(canonicalJson(checklistObj));
        const keyEpoch = currentTenantEpoch(db, id.tenantId);
        const signedPayload = canonicalJson({
          approval_id: approvalId,
          artifact_version_id: art.artifact_version_id,
          artifact_sha256: art.sha256,
          audience: art.audience,
          completeness_hash: completenessHash,
          signer: { member_id: id.userId, device_id: keyctx.device.deviceId, cert_id: keyctx.device.cert.certId },
          key_epoch: keyEpoch,
          assurance_level: "device_signature",
          signed_at: new Date().toISOString(),
        });
        const signature = signBytes(keyctx.device.keys.signPrivateKeyPem, new TextEncoder().encode(signedPayload));
        db.tx(() => {
          db.run(
            `INSERT INTO approvals (approval_id, artifact_version_id, artifact_sha256, approver_id, decision, audience, assurance_level, checklist,
                                   signer_device_id, signature, completeness_hash, key_epoch, signed_payload)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [approvalId, art.artifact_version_id, art.sha256, id.userId, decision, art.audience, "device_signature", checklist, keyctx.device.deviceId, signature, completenessHash, keyEpoch, signedPayload],
          );
          db.run(`UPDATE artifact_versions SET status = 'approved' WHERE artifact_version_id = ?`, [art.artifact_version_id]);
          keyctx.signer.append({ kind: "approval", refId: approvalId, matterId: art.matter_id, type: "approval.signed", payloadHash: sha256B64(signedPayload) });
        });
        audit(db, id, `artifact.${decision}`, "artifact", art.artifact_version_id, art.sha256, keyctx);
        return {
          approval_id: approvalId,
          decision,
          status: "approved",
          approver_role: role,
          bound_sha256: art.sha256,
          assurance_level: "device_signature",
          signer_device_id: keyctx.device.deviceId,
          note: "设备签名签发：绑定最终字节 hash 与完整性单 hash；批准后任何实质编辑生成新版本（原签发不带到新版本）",
        };
      }

      // 退回：维持批准记录形态（不签名）
      db.run(
        `INSERT INTO approvals (approval_id, artifact_version_id, artifact_sha256, approver_id, decision, audience, assurance_level, checklist)
         VALUES (?,?,?,?,?,?,?,?)`,
        [approvalId, art.artifact_version_id, art.sha256, id.userId, decision, art.audience, "approval_record", checklist],
      );
      db.run(`UPDATE artifact_versions SET status = 'draft' WHERE artifact_version_id = ?`, [art.artifact_version_id]);
      audit(db, id, `artifact.${decision}`, "artifact", art.artifact_version_id, art.sha256, keyctx);
      return {
        approval_id: approvalId,
        decision,
        status: "draft",
        approver_role: role,
        bound_sha256: art.sha256,
        note: "已退回，修改后生成新版本重新提交",
      };
    },

    "approvals.verify": (p, id) => {
      const ap = db.get<any>(`SELECT * FROM approvals WHERE approval_id = ?`, [String(p?.approval_id ?? "")]);
      if (!ap) throw notFound("批准记录");
      const art = db.get<any>(`SELECT * FROM artifact_versions WHERE artifact_version_id = ?`, [ap.artifact_version_id]);
      if (!art) throw notFound("成果");
      requireMatterAccess(db, art.matter_id, id);
      if (ap.decision !== "approved" || typeof ap.signed_payload !== "string") {
        return { approval_id: ap.approval_id, overall: "invalid", reason: "非设备签名签发（批准记录形态，无签名可验）" };
      }
      // 重算成果字节 hash（内容被改即不符）
      let artifactHashMatch = false;
      try {
        artifactHashMatch = sha256Hex(blobs.read(String(art.storage_uri))) === ap.artifact_sha256;
      } catch {
        artifactHashMatch = false;
      }
      const device = db.get<any>(`SELECT cert_json, status, revoked_at FROM devices WHERE device_id = ?`, [ap.signer_device_id]);
      const firmRow = db.get<{ root_public_key_pem: string }>(`SELECT root_public_key_pem FROM firm_identity WHERE tenant_id = ?`, [art.tenant_id]);
      let cert: DeviceCertificate | null = null;
      try {
        cert = device ? (JSON.parse(device.cert_json) as DeviceCertificate) : null;
      } catch {
        cert = null;
      }
      const signatureValid = cert ? verifyBytes(cert.signPublicKeyPem, new TextEncoder().encode(ap.signed_payload), ap.signature) : false;
      const certChainValid = cert && firmRow ? verifyCertSignature(cert, firmRow.root_public_key_pem) : false;
      const signedAt = parseJson<any>(ap.signed_payload, {})?.signed_at ?? ap.created_at;
      let signerStatus: string = "unknown";
      if (device) {
        if (device.status !== "revoked") signerStatus = "active";
        else signerStatus = Date.parse(device.revoked_at) <= Date.parse(signedAt) ? "revoked_before_signing" : "revoked_after_signing";
      }
      const latest = db.get<{ v: number }>(
        `SELECT COALESCE(MAX(version), 0) AS v FROM artifact_versions WHERE matter_id = ? AND kind = ? AND audience = ?`,
        [art.matter_id, art.kind, art.audience],
      )!;
      const bindingStillCurrent = art.version === latest.v && art.sha256 === ap.artifact_sha256;
      // IM 确认（节点见证）附加校验：受众必须在 internal/client（法院版/对方版必须设备签名）
      const isImWitnessed = ap.assurance_level === "im_witnessed";
      const imAudienceOk = !isImWitnessed || ["internal", "client"].includes(String(ap.audience ?? ""));
      const overall = artifactHashMatch && signatureValid && certChainValid && signerStatus !== "revoked_before_signing" && bindingStillCurrent && imAudienceOk ? "valid" : "invalid";
      return {
        approval_id: ap.approval_id,
        overall,
        assurance_level: ap.assurance_level,
        artifact_hash_match: artifactHashMatch,
        signature_valid: signatureValid,
        cert_chain_valid: certChainValid,
        signer_status: signerStatus,
        binding_still_current: bindingStillCurrent,
        ...(isImWitnessed
          ? {
              assurance_note:
                "IM 确认（节点见证）：节点服务密钥签名记录「谁在何时确认了哪个文件 hash」，保证等级低于设备签名；仅适用于 internal/client 受众与已授权节点事项；法院版/对方版必须设备签名（§6.3）",
              im_audience_ok: imAudienceOk,
            }
          : {}),
        // 证明包：第三方可不依赖本数据库离线验签（signed_payload + signature + 设备证书 + 律所根公钥）
        proof: {
          signed_payload: ap.signed_payload,
          signature: ap.signature,
          cert_json: device?.cert_json ?? null,
          root_public_key_pem: firmRow?.root_public_key_pem ?? null,
        },
      };
    },

    "deliveries.create": (p, id) => {
      const art = requireArtifact(db, String(p?.artifact_version_id ?? ""), id);
      const action = p?.action;
      if (!["download", "external_send", "archive"].includes(action)) throw validation("action 须为 download/external_send/archive");
      const audience = p?.audience ?? art.audience;
      // 导出动作的来源许可校验（Source Registry §2.2 运行时强制：导出离开平台前逐来源核对）
      if (action === "download" || action === "external_send") assertExportAllowed(lawdb, db, art.run_id);
      // 外发须已批准；内部稿不得外发（§2.4 受众边界）；外发只认设备签名签发（§6.3）
      let linkedApprovalId: string | null = null;
      if (action === "external_send") {
        if (art.status !== "approved") throw new DomainError("conflict", "未经批准的成果不得外发", 409);
        if (art.audience === "internal") throw forbidden("内部稿不得外发；请先生成受众版本并签发");
        const ap = db.get(
          `SELECT approval_id FROM approvals WHERE artifact_version_id = ? AND decision = 'approved' AND artifact_sha256 = ? AND assurance_level = 'device_signature'
           ORDER BY created_at DESC LIMIT 1`,
          [art.artifact_version_id, art.sha256],
        );
        if (!ap) throw new DomainError("approval_invalidated", "外发须设备签名签发（assurance_level=device_signature）且批准与当前文件 hash 相符", 409);
        db.run(`UPDATE artifact_versions SET status = 'issued' WHERE artifact_version_id = ?`, [art.artifact_version_id]);
        linkedApprovalId = (ap as any).approval_id;
      }
      const deliveryId = newId("delivery");
      db.run(
        `INSERT INTO deliveries (delivery_id, artifact_version_id, tenant_id, matter_id, audience, package_sha256, action, approval_id, actor_id, note)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [deliveryId, art.artifact_version_id, id.tenantId, art.matter_id, audience, art.sha256, action, linkedApprovalId, id.userId, String(p?.note ?? "")],
      );
      return { delivery_id: deliveryId, action, package_sha256: art.sha256, status: action === "external_send" ? "issued" : art.status };
    },

    "pending.list": (_p, id) => {
      const rows = db.all(
        `SELECT av.artifact_version_id, av.kind, av.filename, av.version, av.status, av.created_at,
                m.matter_id, m.title AS matter_title
           FROM artifact_versions av JOIN matters m ON m.matter_id = av.matter_id
           JOIN matter_members mm ON mm.matter_id = av.matter_id AND mm.user_id = ? AND mm.removed_at IS NULL
          WHERE av.tenant_id = ? AND av.status = 'pending_review'
          ORDER BY av.created_at ASC LIMIT 100`,
        [id.userId, id.tenantId],
      );
      return { pending: rows, count: rows.length };
    },

    // ─── 数据去向（§15.2 egress.records：只读） ───
    "egress.records": (p, id) => {
      if (p?.run_id) {
        requireRunAccess(db, String(p.run_id), id);
        return { records: egress.listRecords({ runId: String(p.run_id) }) };
      }
      if (p?.matter_id) {
        requireMatterAccess(db, String(p.matter_id), id);
        return { records: egress.listRecords({ matterId: String(p.matter_id) }) };
      }
      throw validation("需要 run_id 或 matter_id");
    },

    // ─── 内核状态（「连接」页与底栏：模型通道、存储位置、队列） ───
    "kernel.status": (_p, id) => {
      const endpoints = {
        standard: !!config.env.ZR_MAAS_BASE && !!config.env.ZR_MAAS_TOKEN,
        byok: !!(config.env.ZR_BYOK_API_KEY ?? config.env.ZR_MOONSHOT_API_KEY),
        private: !!config.env.ZR_PRIVATE_BASE,
      };
      return {
        version: "v5.0.0-g0",
        workspace_dir: config.workspaceDir,
        firm: config.firmSlug,
        user: config.userSlug,
        tenant_id: id.tenantId,
        user_id: id.userId,
        model_routes: broker.routeAliases(),
        model_provider: config.env.ZR_MODEL_PROVIDER ?? "mock",
        endpoints_configured: endpoints,
        queue: queue.stats(),
        local_server: {
          // 探针 2「遥测/更新/远程控制零外连」：落在端点白名单（/healthz、/v1/models、/mcp、/v1/chat/completions）之外的请求计数
          rejected_path_requests: localStats.rejectedPathRequests,
          rejected_paths: localStats.rejectedPaths,
          rejected_tool_calls: localStats.rejectedToolCalls,
        },
        ocr: {
          available: ocrReady({ ocrModelPaths, mockOcr: parseMock }),
          mock_engine: parseMock,
          note: ocrReady({ ocrModelPaths, mockOcr: parseMock }) ? "本机 OCR 就绪（PP-OCRv5 mobile，全程本机零外发）" : "本机 OCR 未就绪（模型缺失：npm run fetch:ocr-models）；扫描/图片页将按 unreadable 如实标记，不伪造文本",
        },
        lawdb_package: lawdb.packageVersion,
        note: config.env.ZR_MODEL_PROVIDER === "mock" || !config.env.ZR_MODEL_PROVIDER ? "当前为离线 mock 提供方：模型推理在本机模拟，无网络外发" : "真实模型链路：出站一律经出站闸门",
      };
    },

    // ─── 设备与密钥纪元（§5.3：吊销设备证书 → tenant 纪元递增；撤权校验不依赖时钟） ───
    "devices.list": (_p, id) => {
      const rows = db.all(
        `SELECT device_id, member_id, role, status, revoked_at, revoked_epoch, key_epoch_at_issue, created_at
           FROM devices WHERE tenant_id = ? ORDER BY created_at`,
        [id.tenantId],
      );
      return { devices: rows, tenant_epoch: currentTenantEpoch(db, id.tenantId) };
    },

    "devices.revoke": (p, id) => {
      const role = db.get<{ role: string }>(`SELECT role FROM memberships WHERE tenant_id = ? AND user_id = ?`, [id.tenantId, id.userId])?.role;
      if (role !== "firm_admin" && role !== "partner") throw forbidden("吊销设备需要管理员或合伙人角色");
      const deviceId = String(p?.device_id ?? "");
      const dev = db.get<any>(`SELECT device_id, status FROM devices WHERE device_id = ? AND tenant_id = ?`, [deviceId, id.tenantId]);
      if (!dev) throw notFound("设备");
      if (dev.status === "revoked") return { device_id: deviceId, status: "revoked", tenant_epoch: currentTenantEpoch(db, id.tenantId), note: "设备此前已吊销" };
      const reason = String(p?.reason ?? "管理员吊销");
      db.tx(() => {
        const next = currentTenantEpoch(db, id.tenantId) + 1;
        db.run(`UPDATE devices SET status = 'revoked', revoked_at = ?, revoked_epoch = ? WHERE device_id = ?`, [new Date().toISOString(), next, deviceId]);
        db.run(`INSERT INTO key_epochs (scope, scope_id, epoch, reason) VALUES ('tenant', ?, ?, ?)`, [id.tenantId, next, `device.revoke ${deviceId}：${reason}`]);
      });
      audit(db, id, "device.revoke", "device", deviceId, undefined, keyctx);
      return {
        device_id: deviceId,
        status: "revoked",
        tenant_epoch: currentTenantEpoch(db, id.tenantId),
        note: "已吊销并推进密钥纪元：该设备引用旧纪元的（离线回填）事件一律拒收；其历史签名仍可验签（状态如实单列）；已解密、已导出的明文无法远程收回",
      };
    },

    // ─── 事项成员与密钥分发（§5.3：加入补包裹、移出轮换密钥） ───
    "matters.members.add": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterOwner(db, matter.matter_id, id);
      const userId = String(p?.user_id ?? "");
      if (!userId) throw validation("需要 user_id");
      const matterRole = String(p?.matter_role ?? "editor");
      if (!["owner", "editor", "reviewer", "issuer", "viewer"].includes(matterRole)) throw validation("matter_role 非法");
      const epoch = currentMatterEpoch(db, matter.matter_id);
      const devices = db.all<{ device_id: string; enc_pub_pem: string }>(
        `SELECT device_id, enc_pub_pem FROM devices WHERE tenant_id = ? AND member_id = ? AND status = 'active'`,
        [id.tenantId, userId],
      );
      const rowLamport = nextLocalLamport(db);
      db.tx(() => {
        db.run(`INSERT OR IGNORE INTO users (user_id, tenant_id, display_name) VALUES (?,?,?)`, [userId, id.tenantId, userId]);
        db.run(`INSERT OR IGNORE INTO memberships (membership_id, tenant_id, user_id, role) VALUES (?,?,?,'lawyer')`, [newId("membership"), id.tenantId, userId]);
        // 曾墓碑的行：复活须显式授权动作（清除墓碑并刷新作者权威/行 lamport），不是同步副作用
        db.run(
          `INSERT INTO matter_members (matter_id, user_id, matter_role, added_by, removed_at, removed_lamport, author_device, row_lamport)
           VALUES (?,?,?,?,NULL,NULL,?,?)
           ON CONFLICT(matter_id, user_id) DO UPDATE SET matter_role = excluded.matter_role, removed_at = NULL, removed_lamport = NULL,
             author_device = excluded.author_device, row_lamport = excluded.row_lamport`,
          [matter.matter_id, userId, matterRole, id.userId, keyctx.device.deviceId, rowLamport],
        );
        if (devices.length > 0) {
          // 解出当前纪元事项密钥（本机设备包裹行），为对方每台 active 设备补包裹
          const myWrapped = db.get<{ wrapped_key: string }>(`SELECT wrapped_key FROM matter_keys WHERE matter_id = ? AND epoch = ? AND wrapped_for = ?`, [
            matter.matter_id,
            epoch,
            keyctx.device.deviceId,
          ]);
          if (!myWrapped) throw new DomainError("internal", "本机缺少当前纪元事项密钥包裹，无法为新成员补包裹", 500);
          const matterKey = unwrapMatterKey(myWrapped.wrapped_key, keyctx.device.keys.encPrivateKeyPem);
          for (const d of devices) {
            db.run(`INSERT OR IGNORE INTO matter_keys (matter_id, epoch, wrapped_for, wrapped_key) VALUES (?,?,?,?)`, [matter.matter_id, epoch, d.device_id, wrapMatterKey(matterKey, d.enc_pub_pem)]);
          }
        }
      });
      audit(db, id, "matter.member_add", "matter", matter.matter_id, userId, keyctx);
      return {
        matter_id: matter.matter_id,
        user_id: userId,
        epoch,
        devices_wrapped: devices.length,
        note: devices.length > 0 ? "已按当前密钥纪元为对方 active 设备补包裹（对方设备方可解事项密钥）" : "对方尚无登记设备：其设备登记后需重新执行补包裹",
      };
    },

    "matters.members.remove": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterOwner(db, matter.matter_id, id);
      const userId = String(p?.user_id ?? "");
      const target = db.get<{ matter_role: string }>(`SELECT matter_role FROM matter_members WHERE matter_id = ? AND user_id = ? AND removed_at IS NULL`, [matter.matter_id, userId]);
      if (!target) throw notFound("事项成员");
      if (target.matter_role === "owner") throw validation("不能移出事项负责人（须先移交负责人）");
      let newEpoch = 0;
      let wrapped = 0;
      const removeLamport = nextLocalLamport(db);
      db.tx(() => {
        // 墓碑（阻断项修复：行级 DELETE 会被同步回灌复活——removed_* + 作者权威 + 较新者胜）
        db.run(`UPDATE matter_members SET removed_at = ?, removed_lamport = ?, author_device = ?, row_lamport = ? WHERE matter_id = ? AND user_id = ? AND removed_at IS NULL`, [
          nowIso(),
          removeLamport,
          keyctx.device.deviceId,
          removeLamport,
          matter.matter_id,
          userId,
        ]);
        // 移出即轮换（§5.3）：新事项密钥只包裹给「有效成员（墓碑过滤）」的 active 设备 + 恢复托管；
        // 旧纪元行保留——旧内容对原持有者可读、新内容不可读
        newEpoch = currentMatterEpoch(db, matter.matter_id) + 1;
        const newKey = generateMatterKey();
        const remaining = db.all<{ device_id: string; enc_pub_pem: string }>(
          `SELECT d.device_id, d.enc_pub_pem FROM devices d
             JOIN matter_members mm ON mm.user_id = d.member_id AND mm.matter_id = ? AND mm.removed_at IS NULL
           WHERE d.tenant_id = ? AND d.status = 'active'`,
          [matter.matter_id, id.tenantId],
        );
        for (const d of remaining) {
          db.run(`INSERT OR IGNORE INTO matter_keys (matter_id, epoch, wrapped_for, wrapped_key) VALUES (?,?,?,?)`, [matter.matter_id, newEpoch, d.device_id, wrapMatterKey(newKey, d.enc_pub_pem)]);
        }
        db.run(`INSERT OR IGNORE INTO matter_keys (matter_id, epoch, wrapped_for, wrapped_key) VALUES (?,?,'recovery',?)`, [matter.matter_id, newEpoch, wrapMatterKey(newKey, keyctx.firm.recoveryPublicKeyPem)]);
        db.run(`INSERT INTO key_epochs (scope, scope_id, epoch, reason) VALUES ('matter', ?, ?, ?)`, [matter.matter_id, newEpoch, `member.remove ${userId}`]);
        wrapped = remaining.length;
      });
      audit(db, id, "matter.member_remove", "matter", matter.matter_id, userId, keyctx);
      return {
        matter_id: matter.matter_id,
        removed: userId,
        new_epoch: newEpoch,
        devices_wrapped: wrapped,
        note: "已轮换事项密钥（新纪元）：移出成员的设备拿不到新密钥；其历史签名与旧纪元包裹行保留",
      };
    },

    // ─── 开放导出（§7.3：事件 JSON Lines + 证书与签发证明，可离线验签，不靠数据锁定续费） ───
    "matters.exportLedger": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      const events = db.all<any>(`SELECT * FROM signed_events WHERE matter_id = ? ORDER BY seq`, [matter.matter_id]);
      const deviceIds = [...new Set(events.map((e) => e.signer_device_id as string))];
      const deviceRows = deviceIds
        .map((d) => db.get(`SELECT device_id, member_id, role, status, cert_json FROM devices WHERE device_id = ?`, [d]))
        .filter(Boolean);
      const approvalProofs = db.all<any>(
        `SELECT a.approval_id, a.artifact_version_id, a.artifact_sha256, a.signed_payload, a.signature, a.signer_device_id, a.key_epoch
           FROM approvals a JOIN artifact_versions av ON av.artifact_version_id = a.artifact_version_id
          WHERE av.matter_id = ? AND a.signed_payload IS NOT NULL ORDER BY a.created_at`,
        [matter.matter_id],
      );
      const lines = [
        JSON.stringify({
          type: "header",
          firm_root_public_key: keyctx.firm.rootPublicKeyPem,
          tenant_id: id.tenantId,
          matter_id: matter.matter_id,
          exported_at: new Date().toISOString(),
          format: "kwl-ledger-export-v1",
          note: "开放导出（§7.3）：签名事件 JSON Lines + 设备证书 + 签发证明包；第三方可不依赖本数据库离线验签",
        }),
        ...events.map((e) => JSON.stringify({ type: "signed_event", ...e })),
        ...deviceRows.map((d) => JSON.stringify({ type: "device_cert", ...d })),
        ...approvalProofs.map((a) => JSON.stringify({ type: "approval_proof", ...a })),
      ];
      audit(db, id, "matter.export_ledger", "matter", matter.matter_id, undefined, keyctx);
      return {
        filename: `ledger-${matter.matter_id}-${new Date().toISOString().slice(0, 10)}.jsonl`,
        content: lines.join("\n") + "\n",
        signed_events: events.length,
        approval_proofs: approvalProofs.length,
      };
    },

    // ─── 法规库状态（§9：界面显示「法规库最后更新日」；签名无效时内核已拒载，不会走到这里） ───
    "lawdb.status": (_p, _id) => {
      const st = lawdb.status();
      return {
        ...st,
        display: `法规库最后更新 ${st.built_at.slice(0, 10)} · ${st.laws_count} 部 / ${st.versions_count} 版本 · 签名有效（${st.signer_key_id}）`,
      };
    },

    // ─── 共享文件夹同步（§7.1/§7.2：段式导出/摄取/状态；个人事项与无权限事项不出本机） ───
    "sync.export": (p, id) => {
      const shareDir = String(p?.share_dir ?? "");
      if (!shareDir) throw validation("需要 share_dir（律所自有共享目录，§7.2）");
      const r = syncExport({ db, blobs, keyctx, tenantId: id.tenantId }, { shareDir, ...(p?.matter_id ? { matterId: String(p.matter_id) } : {}) });
      audit(db, id, "sync.export", "tenant", id.tenantId, `${r.segments.length} 段 / ${r.rowsExported} 行`, keyctx);
      return {
        ...r,
        note: "已封口写段（临时名→原子改名）；只同步团队事项，个人事项已跳过；共享目录只是介质，本机 SQLite 即权威",
      };
    },

    "sync.import": (p, id) => {
      const shareDir = String(p?.share_dir ?? "");
      if (!shareDir) throw validation("需要 share_dir");
      const r = syncImport({ db, blobs, keyctx, tenantId: id.tenantId }, { shareDir });
      audit(db, id, "sync.import", "tenant", id.tenantId, `${r.segmentsApplied} 段应用 / ${r.rowsApplied} 行 / 冲突 ${r.conflicts.length}`, keyctx);
      return {
        ...r,
        note: "只认已封口段；忽略半成品与冲突副本命名（见 warnings）；无权限事项与被吊销设备旧纪元段已跳过",
      };
    },

    "sync.status": (p, id) => {
      return syncStatus({ db, blobs, keyctx, tenantId: id.tenantId }, { ...(p?.share_dir ? { shareDir: String(p.share_dir) } : {}) });
    },

    // ─── 节点逐事项授权（§5.3 服务成员；v0 同机节点设备，跨机器加入流程 G1） ───
    "matters.node_authorize": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterOwner(db, matter.matter_id, id);
      // strict 保密等级事项强制不授权节点（§5.3：伦理墙与高敏事项只在成员电脑上运行）
      if (matter.confidentiality === "strict") {
        throw forbidden("保密等级 strict 的事项不允许授权节点（§5.3：只在成员电脑上运行）");
      }
      // v0 同机形态默认 node_<firm>（5a）；跨工作区节点可显式指定已登记的节点设备（其证书须已在库）
      const nodeDeviceId = String(p?.node_device_id ?? "");
      let node: { deviceId: string; encPublicKeyPem?: string; keys?: { encPublicKeyPem: string }; memberId?: string };
      if (nodeDeviceId) {
        const row = db.get<{ device_id: string; enc_pub_pem: string; status: string; member_id: string }>(`SELECT device_id, enc_pub_pem, status, member_id FROM devices WHERE device_id = ? AND tenant_id = ?`, [nodeDeviceId, id.tenantId]);
        if (!row || row.status !== "active") throw validation(`节点设备 ${nodeDeviceId} 未登记或已吊销（须先登记其证书）`);
        node = { deviceId: row.device_id, encPublicKeyPem: row.enc_pub_pem, memberId: row.member_id };
      } else {
        const nd = ensureNodeDevice(db, keyctx.keysDir, id, { firmSlug: config.firmSlug });
        node = { deviceId: nd.deviceId, keys: nd.keys, memberId: nd.memberId };
      }
      const nodeEncPub = node.encPublicKeyPem ?? node.keys!.encPublicKeyPem;
      const epoch = currentMatterEpoch(db, matter.matter_id);
      const myWrap = db.get<{ wrapped_key: string }>(`SELECT wrapped_key FROM matter_keys WHERE matter_id = ? AND epoch = ? AND wrapped_for = ?`, [
        matter.matter_id,
        epoch,
        keyctx.device.deviceId,
      ]);
      if (!myWrap) throw new DomainError("internal", "本机缺少当前纪元事项密钥，无法为节点授权", 500);
      const matterKey = unwrapMatterKey(myWrap.wrapped_key, keyctx.device.keys.encPrivateKeyPem);
      db.tx(() => {
        db.run(`INSERT OR IGNORE INTO matter_keys (matter_id, epoch, wrapped_for, wrapped_key) VALUES (?,?,?,?)`, [matter.matter_id, epoch, node.deviceId, wrapMatterKey(matterKey, nodeEncPub)]);
        // 节点是显式的「服务成员」（§5.3）：节点内核身份须为事项成员方可走同一访问校验链路
        if (node.memberId) {
          db.run(`INSERT OR IGNORE INTO users (user_id, tenant_id, display_name) VALUES (?,?,?)`, [node.memberId, id.tenantId, node.memberId]);
          db.run(
            `INSERT INTO matter_members (matter_id, user_id, matter_role, added_by, removed_at, removed_lamport, author_device, row_lamport) VALUES (?,?,'viewer',?,NULL,NULL,?,?)
             ON CONFLICT(matter_id, user_id) DO UPDATE SET removed_at = NULL, removed_lamport = NULL, author_device = excluded.author_device, row_lamport = excluded.row_lamport`,
            [matter.matter_id, node.memberId, id.userId, keyctx.device.deviceId, nextLocalLamport(db)],
          );
        }
        db.run(`UPDATE matters SET node_allowed = 1 WHERE matter_id = ?`, [matter.matter_id]);
      });
      audit(db, id, "matter.node_authorize", "matter", matter.matter_id, node.deviceId, keyctx);
      return {
        matter_id: matter.matter_id,
        node_device_id: node.deviceId,
        epoch,
        note: "已把当前纪元事项密钥包裹给节点设备（节点由此可解本事项新内容；伦理墙事项与 strict 事项不可授权）",
      };
    },

    "matters.node_revoke": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterOwner(db, matter.matter_id, id);
      const node = db.get<{ device_id: string }>(`SELECT device_id FROM devices WHERE device_id = ?`, [`node_${config.firmSlug}`]);
      db.tx(() => {
        if (node) {
          const epoch = currentMatterEpoch(db, matter.matter_id);
          db.run(`DELETE FROM matter_keys WHERE matter_id = ? AND epoch = ? AND wrapped_for = ?`, [matter.matter_id, epoch, node.device_id]);
        }
        db.run(`UPDATE matters SET node_allowed = 0 WHERE matter_id = ?`, [matter.matter_id]);
      });
      audit(db, id, "matter.node_revoke", "matter", matter.matter_id, undefined, keyctx);
      return {
        matter_id: matter.matter_id,
        note: "已删除节点当前纪元的密钥包裹（节点不再能解新内容；其曾持有的旧纪元密钥无法远程收回，如实告知）",
      };
    },

    // ─── 恢复演练（§16.3 探针 11：M-of-N 破窗与单机口令） ───
    "recovery.restore_matter": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      const shareFiles: string[] = Array.isArray(p?.share_files) ? p.share_files.map(String) : [];
      if (shareFiles.length === 0) throw validation("需要 share_files（恢复份额文件路径列表，3-of-5 至少 3 份）");
      const shares: { x: number; y: Uint8Array }[] = [];
      let privateKeyHash = "";
      for (const f of shareFiles) {
        const s = JSON.parse(readFileSync(f, "utf8")) as { x: number; y: string; privateKeyHash: string };
        shares.push({ x: s.x, y: b64urlDecode(s.y) });
        privateKeyHash = s.privateKeyHash;
      }
      const combined = combineRecoveryPrivateKey(shares, privateKeyHash);
      if (!combined.ok) {
        return { ok: false as const, reason: `份额重组托管私钥失败：${combined.reason}` };
      }
      const epoch = currentMatterEpoch(db, matter.matter_id);
      const recWrap = db.get<{ wrapped_key: string }>(`SELECT wrapped_key FROM matter_keys WHERE matter_id = ? AND epoch = ? AND wrapped_for = 'recovery'`, [matter.matter_id, epoch]);
      if (!recWrap) throw notFound("该事项的恢复托管包裹行");
      const matterKey = unwrapMatterKey(recWrap.wrapped_key, combined.privateKeyPem);
      const rotate = p?.rotate === true;
      const revokeDeviceIds: string[] = Array.isArray(p?.revoke_device_ids) ? p.revoke_device_ids.map(String) : [];
      db.tx(() => {
        db.run(`INSERT OR REPLACE INTO matter_keys (matter_id, epoch, wrapped_for, wrapped_key) VALUES (?,?,?,?)`, [
          matter.matter_id,
          epoch,
          keyctx.device.deviceId,
          wrapMatterKey(matterKey, keyctx.device.keys.encPublicKeyPem),
        ]);
        if (rotate) {
          // 设备丢失场景的推荐路径：先吊销旧设备并 rotate——新纪元密钥只包裹给
          // 「有效成员（墓碑过滤）减去 revoke_device_ids」的 active 设备 + recovery（旧设备解不开新内容）
          const newEpoch = epoch + 1;
          const newKey = generateMatterKey();
          const remaining = db.all<{ device_id: string; enc_pub_pem: string }>(
            `SELECT d.device_id, d.enc_pub_pem FROM devices d
               JOIN matter_members mm ON mm.user_id = d.member_id AND mm.matter_id = ? AND mm.removed_at IS NULL
             WHERE d.tenant_id = ? AND d.status = 'active'`,
            [matter.matter_id, id.tenantId],
          ).filter((d) => !revokeDeviceIds.includes(d.device_id));
          for (const d of remaining) {
            db.run(`INSERT OR IGNORE INTO matter_keys (matter_id, epoch, wrapped_for, wrapped_key) VALUES (?,?,?,?)`, [matter.matter_id, newEpoch, d.device_id, wrapMatterKey(newKey, d.enc_pub_pem)]);
          }
          db.run(`INSERT OR IGNORE INTO matter_keys (matter_id, epoch, wrapped_for, wrapped_key) VALUES (?,?,'recovery',?)`, [matter.matter_id, newEpoch, wrapMatterKey(newKey, keyctx.firm.recoveryPublicKeyPem)]);
          db.run(`INSERT INTO key_epochs (scope, scope_id, epoch, reason) VALUES ('matter', ?, ?, ?)`, [matter.matter_id, newEpoch, `recovery.restore rotate${revokeDeviceIds.length > 0 ? `（吊销候选 ${revokeDeviceIds.join("/")}）` : ""}`]);
        }
      });
      // 破窗事件（§5.3「动用即破窗」：须 M 名持有人签名、写审计链并通知成员——通知界面/IM 在 G1）
      const record = createBreakGlassRecord({
        matterId: matter.matter_id,
        keyEpoch: rotate ? epoch + 1 : epoch,
        shareHolderIds: shareFiles.map((f) => basename(f)),
        actorId: id.userId,
        at: nowIso(),
      });
      audit(db, id, "recovery.break_glass", "matter", matter.matter_id, hashBreakGlassRecord(record), keyctx);
      return {
        ok: true as const,
        matter_id: matter.matter_id,
        epoch: rotate ? epoch + 1 : epoch,
        rotated: rotate,
        break_glass: { record_id: record.record_id, hash: hashBreakGlassRecord(record) },
        note: rotate
          ? "已恢复并轮换到新纪元：revoke_device_ids 中的设备与未列名的设备都解不开新内容（请随后 devices.revoke 吊销丢失设备）"
          : "已用 M-of-N 份额重组托管私钥并把事项密钥包裹给当前设备；注意：若系设备丢失场景，应先 devices.revoke 吊销旧设备并以 rotate=true 重新执行（否则旧设备仍可解历史与新内容）；破窗已写审计",
      };
    },

    "recovery.export_device": (p, id) => {
      const password = String(p?.password ?? "");
      const outPath = String(p?.path ?? join(config.workspaceDir, "recovery", "device-export.json"));
      const deviceJson = JSON.parse(readFileSync(join(keyctx.keysDir, "device.json"), "utf8")) as Record<string, unknown>;
      const blob = wrapPrivateKeyScrypt(
        JSON.stringify({ signPrivateKeyPem: deviceJson.signPrivateKeyPem, encPrivateKeyPem: deviceJson.encPrivateKeyPem }),
        password,
      );
      mkdirSync(join(outPath, ".."), { recursive: true });
      writeFileSync(outPath, JSON.stringify({ v: 1, kind: "kwl-device-recovery", device_id: keyctx.device.deviceId, cert: keyctx.device.cert, wrapped: blob }, null, 2), { mode: 0o600 });
      audit(db, id, "recovery.export_device", "device", keyctx.device.deviceId, undefined, keyctx);
      return {
        path: outPath,
        device_id: keyctx.device.deviceId,
        note: "设备私钥已用恢复口令（scrypt 派生）包裹导出；口令遗失则该备份不可恢复（§5.3 单机与专业版形态；请离线妥善保管）",
      };
    },

    "recovery.import_device": (p, id) => {
      const file = String(p?.file ?? "");
      const password = String(p?.password ?? "");
      const doc = JSON.parse(readFileSync(file, "utf8")) as { kind?: string; device_id?: string; cert?: unknown; wrapped?: string };
      if (doc.kind !== "kwl-device-recovery" || typeof doc.wrapped !== "string") throw validation("不是有效的设备恢复文件");
      const secrets = JSON.parse(unwrapPrivateKeyScrypt(doc.wrapped, password)) as { signPrivateKeyPem: string; encPrivateKeyPem: string };
      // 解开后即恢复设备身份：重写 device.json（0600），devices 行按文件内证书登记
      const cur = JSON.parse(readFileSync(join(keyctx.keysDir, "device.json"), "utf8")) as Record<string, unknown>;
      writeFileSync(
        join(keyctx.keysDir, "device.json"),
        JSON.stringify({ ...cur, signPrivateKeyPem: secrets.signPrivateKeyPem, encPrivateKeyPem: secrets.encPrivateKeyPem }, null, 2),
        { mode: 0o600 },
      );
      if (doc.cert) {
        db.run(`UPDATE devices SET cert_json = ?, status = 'active', revoked_at = NULL WHERE device_id = ?`, [JSON.stringify(doc.cert), keyctx.device.deviceId]);
      }
      audit(db, id, "recovery.import_device", "device", keyctx.device.deviceId, undefined, keyctx);
      return {
        device_id: keyctx.device.deviceId,
        note: "设备私钥已自口令备份恢复（单机与专业版恢复路径，§5.3）；请立即吊销旧设备证书（如设备实际丢失）",
      };
    },

    "recovery.status": (_p, id) => {
      const drills = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'recovery.break_glass' AND tenant_id = ?`, [id.tenantId])!.n;
      const exports_ = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'recovery.export_device' AND tenant_id = ?`, [id.tenantId])!.n;
      const imports_ = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'recovery.import_device' AND tenant_id = ?`, [id.tenantId])!.n;
      return {
        break_glass_drills: drills,
        device_exports: exports_,
        device_imports: imports_,
        drill_completed: drills > 0,
        note: "「开通流程强制完成一次恢复演练」的产品要求在 G1 激活流落实（此处如实报告演练计数）",
      };
    },

    // ─── IM 绑定（§11.2：发送人↔成员；绑定操作只在本机/控制台） ───
    "im.bind": (p, id) => {
      const platform = String(p?.platform ?? "");
      const imUserId = String(p?.im_user_id ?? "");
      const memberId = String(p?.member_id ?? "");
      if (!platform || !imUserId || !memberId) throw validation("需要 platform / im_user_id / member_id");
      if (!db.get(`SELECT 1 AS x FROM users WHERE user_id = ? AND tenant_id = ?`, [memberId, id.tenantId])) throw validation(`成员 ${memberId} 不存在`);
      db.run(
        `INSERT INTO im_bindings (tenant_id, platform, im_user_id, member_id, bound_by) VALUES (?,?,?,?,?)
         ON CONFLICT(tenant_id, platform, im_user_id) DO UPDATE SET member_id = excluded.member_id, bound_by = excluded.bound_by`,
        [id.tenantId, platform, imUserId, memberId, id.userId],
      );
      audit(db, id, "im.bind", "member", memberId, `${platform}:${imUserId}`, keyctx);
      return { platform, im_user_id: imUserId, member_id: memberId, note: "已绑定（机器人消息将按此归属成员；仅律所内部人员，群转发不扩权）" };
    },

    "im.list": (_p, id) => {
      const bindings = db.all(`SELECT platform, im_user_id, member_id, bound_by, created_at FROM im_bindings WHERE tenant_id = ? ORDER BY created_at DESC`, [id.tenantId]);
      return { bindings };
    },

    "im.unbind": (p, id) => {
      const platform = String(p?.platform ?? "");
      const imUserId = String(p?.im_user_id ?? "");
      db.run(`DELETE FROM im_bindings WHERE tenant_id = ? AND platform = ? AND im_user_id = ?`, [id.tenantId, platform, imUserId]);
      audit(db, id, "im.unbind", "member", String(p?.member_id ?? imUserId), platform, keyctx);
      return { ok: true };
    },

    // ─── IM 确认请求（§6.3：签发人手机卡片确认 → 节点见证签名；低于设备签名） ───
    "approvals.request_im": (p, id) => {
      const art = requireArtifact(db, String(p?.artifact_version_id ?? ""), id);
      requireMatterWriter(db, art.matter_id, id);
      const audience = String(p?.audience ?? art.audience);
      // 受众门禁（§6.3：IM 确认只能用于律所策略允许的受众——内部稿/客户版；法院版与对方版必须设备签名）
      if (!["internal", "client"].includes(audience)) {
        throw validation("IM 确认只适用于 internal/client 受众；court/counterparty 必须到电脑上以设备签名签发（§6.3）", { audience });
      }
      // 事项门禁：只适用于已授权节点的事项
      const matter = db.get<any>(`SELECT node_allowed, confidentiality FROM matters WHERE matter_id = ?`, [art.matter_id]);
      if (matter?.node_allowed !== 1) throw forbidden("IM 确认只适用于已授权节点的事项（先 matters.node_authorize）");
      if (art.status !== "pending_review") throw new DomainError("conflict", `当前状态 ${art.status} 不能请求 IM 确认（须先提交复核）`, 409);
      const intentId = `imi_${newId("run").slice(4)}`;
      db.run(
        `INSERT INTO im_intents (intent_id, tenant_id, kind, platform, status, payload, created_by) VALUES (?,?,?,?,'pending',?,?)`,
        [
          intentId,
          id.tenantId,
          "approval_request",
          String(p?.platform ?? "dingtalk"),
          JSON.stringify({ artifact_version_id: art.artifact_version_id, audience, issuer_member_id: id.userId, artifact_sha256: art.sha256 }),
          id.userId,
        ],
      );
      audit(db, id, "approval.request_im", "artifact", art.artifact_version_id, audience, keyctx);
      return {
        intent_id: intentId,
        note: "已提交 IM 确认请求：节点将把确切待交付文件经律所自有 IM 单独发给签发人；签发人手机确认后节点见证签名（assurance_level=im_witnessed，低于设备签名）",
      };
    },

    // ─── 审计链（§6.4：全量重放校验；手动检查点。只记元数据与 hash，不存正文） ───
    "audit.verifyChain": (_p, _id) => keyctx.signer.verifyChain(),

    "audit.checkpoint": (p, _id) => {
      const kind = p?.kind === "daily" ? ("daily" as const) : ("manual" as const);
      const cp = keyctx.signer.checkpoint(kind);
      return cp
        ? { checkpoint: cp, note: "已对当前链头签名写检查点（时间戳锚定在后续阶段；采用哈希校验技术，不宣称司法存证效力）" }
        : { checkpoint: null, note: "链为空或链头未变，未重复检查点" };
    },
  };

  function egressSummaryOf(runId: string): Record<string, unknown> {
    const recs = egress.listRecords({ runId });
    const totalChars = recs.reduce((n, r) => n + r.chars, 0);
    const external = recs.filter((r) => r.destination_kind !== "mock_local");
    return {
      records: recs.length,
      external_sends: external.length,
      total_chars: totalChars,
      note: external.length === 0 ? "本任务未向律所侧之外发送任何内容" : `本任务外发 ${external.length} 次（详见数据去向卡）`,
    };
  }

  function requireIssuerRole(db2: KernelDb, matterId: string, id: Identity): string {
    const row = db2.get<{ matter_role: string }>(`SELECT matter_role FROM matter_members WHERE matter_id = ? AND user_id = ?`, [matterId, id.userId]);
    const role = row?.matter_role;
    if (!role) throw forbidden("你不是该事项成员");
    if (!["owner", "issuer"].includes(role)) throw forbidden("签发需要事项签发人/负责人角色（经办律师可申请签发）");
    return role;
  }

  function requireMatterOwner(db2: KernelDb, matterId: string, id: Identity): void {
    const row = db2.get<{ matter_role: string }>(`SELECT matter_role FROM matter_members WHERE matter_id = ? AND user_id = ? AND removed_at IS NULL`, [matterId, id.userId]);
    if (row?.matter_role !== "owner") throw forbidden("成员变更需要事项负责人角色");
  }

  /** 成员写操作门禁（viewer 最小权限）：有效成员（墓碑过滤）且非 viewer；节点身份例外见下。 */
  function requireMatterWriter(db2: KernelDb, matterId: string, id: Identity): void {
    // 节点执行权限来自 node_allowed 授权而非成员角色（§5.3 服务成员：节点行是 viewer 但被授权执行）
    const dev = db2.get<{ role: string }>(`SELECT role FROM devices WHERE device_id = ?`, [keyctx.device.deviceId]);
    if (dev?.role === "node") {
      const m = db2.get<{ node_allowed: number; confidentiality: string }>(`SELECT node_allowed, confidentiality FROM matters WHERE matter_id = ?`, [matterId]);
      if (m?.node_allowed === 1 && m.confidentiality !== "strict") return;
    }
    const row = db2.get<{ matter_role: string }>(`SELECT matter_role FROM matter_members WHERE matter_id = ? AND user_id = ? AND removed_at IS NULL`, [matterId, id.userId]);
    if (!row) throw forbidden("你不是该事项成员（或已被移出）");
    if (row.matter_role === "viewer") throw forbidden("viewer 角色只读：该操作需要编辑及以上角色（最小权限）");
  }

  /** 本机 lamport 递增（墓碑/成员行的行级时钟，与签名链同源）。 */
  function nextLocalLamport(db2: KernelDb): number {
    const r = db2.get<{ l: number | null }>(`SELECT MAX(lamport) AS l FROM signed_events`, []);
    return (r?.l ?? 0) + 1;
  }

  /** 成果引用面板中「未核实（离线）」的引用数（citations.verified 事件 payload；案号离线未核 → 签发门禁）。 */
  function unverifiedOfflineCount(db2: KernelDb, runId: string | null): number {
    if (!runId) return 0;
    const evs = db2.all(`SELECT payload FROM run_events WHERE run_id = ? AND type = 'citations.verified'`, [runId]);
    let n = 0;
    for (const e of evs as any[]) {
      const payload = parseJson<any>(e.payload, {});
      n += Number(payload.unverified_offline ?? 0);
    }
    return n;
  }

  /** 导出前逐来源校验 export 动作（§2.2：权限不足时停止相应动作）。 */
  function assertExportAllowed(lawdb2: Lawdb, db2: KernelDb, runId: string | null): void {
    if (!runId) return;
    const evs = db2.all(`SELECT payload FROM run_events WHERE run_id = ? AND type = 'citations.verified'`, [runId]);
    const sources = new Set<string>();
    for (const e of evs as any[]) {
      for (const v of parseJson<any>(e.payload, {})?.verdicts ?? []) {
        if (v?.lsv_id) {
          const s = lawdb2.sourceOfVersion(String(v.lsv_id));
          if (s) sources.add(s);
        }
      }
    }
    for (const s of sources) lawdb2.assertAction(s, "export");
  }

  /** 当前事项密钥纪元（matter_keys 最大 epoch，无记录为 1）。 */
  function currentMatterEpoch(db2: KernelDb, matterId: string): number {
    const r = db2.get<{ e: number | null }>(`SELECT MAX(epoch) AS e FROM matter_keys WHERE matter_id = ?`, [matterId]);
    return r?.e ?? 1;
  }

  return api;
}
