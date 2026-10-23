/**
 * 内核 API（方案 v5.0 第 4 篇 §15.2：界面、加载项、节点共用的本机内核接口）。
 * 由 v4.0 BFF HTTP 路由平移为进程内方法；桌面（IPC）、Office 加载项（命名管道/本机端口）、
 * 所内节点都走这同一份方法表。签发已接入设备签名（§6.3）；审计事件入签名 hash 链（§6.4）；
 * 策略事件的签发人角色签名在同步阶段接入（当前经审计事件上链留痕）。
 */
import { calcDeadline } from "../tools/tools/deadline.ts";
import { localToday } from "../services/local-date.ts";
import { createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { errFields, slog } from "@zr-legal/safe-log";
import { readFileSync, lstatSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { writeExportFile } from "../services/export-file.ts";
import type { CpAuditRecord } from "@zr-legal/firm-trust";
import { SUPPORT_MAX_UPLOAD_BYTES } from "@zr-legal/egress-gate";
import { supportErrorText } from "../services/support-errors.ts";
import { parseReminderInput, type ReminderService } from "../services/reminders.ts";
import { syncAlertsView, type ShareRelaySync } from "../services/share-relay.ts";
import { recordSuspectReview, sendPreview, summarizeSend, type SendSummary, type SuspectView } from "../services/send-preview.ts";
import {
  ConsentStatus,
  CollabScope,
  DomainError,
  ModelEndpoint,
  RunStatus,
  TERMINAL_RUN_STATUSES,
  assertIdempotencyKey,
  forbidden,
  newId,
  notFound,
  sha256Hex,
  validation,
} from "@zr-legal/domain";
import { pendingBasisLabels, type EgressGate } from "@zr-legal/egress";
import { countTokens, MatterTokenizer } from "@zr-legal/tokenizer";
import { skillQualityChecklist, skillSnapshot, type SkillsBundleStatus } from "../skills-bundle.ts";
import type { ContentUpdater } from "../services/content-updates.ts";
import type { ModelBroker } from "@zr-legal/model-broker";
import type { Lawdb } from "@zr-legal/lawdb";
import { ocrModelsAvailable, type OcrModelPaths } from "@zr-legal/parse-ocr/client";
import {
  b64urlDecode,
  canonicalJson,
  combineRecoveryPrivateKey,
  createBreakGlassRecord,
  generateMatterKey,
  hashBreakGlassRecord,
  sha256B64,
  unwrapMatterKey,
  unwrapPrivateKeyScrypt,
  verifyBytes,
  verifyDeviceCertificate,
  wrapMatterKey,
  wrapPrivateKeyScrypt,
  type DeviceCertificate,
} from "@zr-legal/keys";
import type { KernelDb } from "../db.ts";
import type { MatterTokenStore } from "../egress/matter-tokens.ts";
import { upstreamTransport, type KernelGate } from "../egress/kernel-gate.ts";
import { applyStructuredPatches } from "../services/structured-patch.ts";
import { basisCompleteOf, dataLevelOf, parseBasis, BASIS_KEYS } from "../egress/gate-host.ts";
import type { EgressApprovalStore } from "../services/egress-approvals.ts";
import type { QaChatService } from "../services/qa-chat.ts";
import type { KapAgentClient, KapMatterPolicy } from "../executor/kap-agent-client.ts";
import { createW1Api } from "./w1.ts";
import { buildDiagnostics } from "../services/diagnostics.ts";
import { nowIso } from "../db.ts";
import type { BlobStore } from "../blobs.ts";
import type { TaskQueue } from "../queue.ts";
import type { KernelConfig } from "../config.ts";
import { runModeOf, type Identity } from "../identity.ts";
import type { AsyncMutex } from "../mutex.ts";
import { currentTenantEpoch, ensureNodeDevice, getDeviceKeys, getFirmRootPrivateKey, stageDeviceRecovery, type KernelKeyContext } from "../devices.ts";
import { archivedCertsOf, certVerifying, rowPayloadHash, verifyCertSignature } from "../ledger-signer.ts";
import { syncExport, syncImport, syncStatus, type SyncDeps } from "../sync-engine.ts";
import { addOrUpdateMember, chainSummary, chainView, hasChain, keyFingerprint, rebootstrapMatter, refreshChain, rotateChainKey, writeEvent, writeGenesis } from "../member-log.ts";
import { docxHeaderFooterTexts, parseDocument } from "../services/parser.ts";
import { detectClassifiedMarking, type ClassifiedFinding } from "../services/classified-marking.ts";
import { restoreArtifactBytes } from "../services/export-restore.ts";
import { decideOutline, hasOutlineUnconfirmed, listOutlines, outlineUnconfirmedReason, scrubOutlineFacts } from "../services/argument-outlines.ts";
import { addColumn, cellContext, createTable, decideCell, draftFromTable, exportTable, getTable, ledgerReminderCandidates, listTables, pushCellsToFacts, removeColumn, TABLE_TEMPLATES } from "../services/review-tables.ts";
import { createTodo, deleteTodo, derivedTodos, listTodos, updateTodo } from "../services/matter-todos.ts";
import { triageMatter } from "../services/material-triage.ts";
import { findHits, getTemplate, HIT_KIND_TEXT, listTemplates, matchClauses, prepareTemplate, removeTemplate, replaceHits, saveTemplate, TEMPLATE_CONTRACT_TYPES } from "../services/firm-templates.ts";
import { holidaySource } from "../tools/tools/cn-holidays.ts";
import { planTemplate, applyTemplateTodos, templatesView } from "../services/matter-templates.ts";
import { activeRules, discardDraft, listRuleSets, retireRules, RULES_SKILLS, saveRules, snapshotOf, scrubRulesFromRuns, type RulesSnapshot } from "../services/review-rules.ts";
import { clearWritingPrefs, getWritingPrefs, hasPrefs, setWritingPrefs } from "../services/writing-prefs.ts";
import { pendingChecks, unsignedLatestArtifacts } from "../services/pending-checks.ts";
import { buildMatterArchive } from "../services/matter-archive.ts";
import { closeMatter, deletionReceiptOf, lifecycleOf, purgeMatter, reopenMatter, requireActiveMatter, RETENTION_YEARS, setLegalHold, verifyDeletionReceipt, type LifecycleDeps } from "../services/matter-lifecycle.ts";
import { buildRedlineFromCards, counterChanges, decideBatch, rejectMissingCard, cardCells, cardPages, quotePages, exportReviewTable, previewRedlineFromCards, decideFact, decideRiskCard, setRiskCardNature, listFacts, listRiskCards, riskCardProgress, scrubRelatedQuotes, submitRiskCards } from "../services/review-cards.ts";
import { LIT_SAMPLE_ISSUES, LIT_SAMPLE_TITLE, SAMPLE_CARDS, SAMPLE_FILENAME, SAMPLE_TITLE, assertNotSample, litigationSampleMaterials, sampleContract } from "../services/sample-matter.ts";
import { probeEnvironment, type EnvProbeResult } from "../services/env-probe.ts";
import { firstLineTitle, isTitledFilename } from "../services/artifact-title.ts";
import { adjudicate, compareAnnotations, normalizeDocs, openEvalBytes, openEvalFile, parseDecisions, reportFileText, runRecallEval, workFileText } from "../services/recall-eval.ts";
import { isImage, isPdf, ocrReady, parseWithPipeline } from "../services/parse-pipeline.ts";
import { estimatePoints, scenarioCap } from "../services/estimate.ts";
import { docxRenderReport } from "../tools/tools/docx.ts";
import { createStyledDocx, extractParagraphs, isHouseStyled, markdownToBlocks, renderDocxHtml, renderXlsxHtml, restyleDocx } from "@zr-legal/docx-engine";
import { redlineAuthorOf, docStyleView, houseStyleFor, setDocStyle, setDocTemplate } from "../services/doc-style.ts";
import { isToolOperationInFlight } from "../local-server.ts";
import { MATTER_STAGES } from "../services/matter-facts.ts";
import { artifactFactMarks, type FactMark } from "../services/artifact-facts.ts";
import { artifactCitationBlock, artifactText, checkArtifactCitations, CITATIONS_CASES_CHECK_KEY, uncheckedCitations, withDecisions, type ArtifactCitationCheck, type CitationDecision } from "../services/artifact-citations.ts";
import { rankTitles, type TitleCandidate } from "../services/title-search.ts";

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
  /** 隔离解析进程的 Node 与入口（W6：安装包为随包运行时；缺省当前进程）。 */
  parseWorker?: { execPath?: string | undefined; entry?: string | undefined } | undefined;
  /** 开发/测试 mock OCR（ZR_PARSE_OCR_MOCK=1）。 */
  parseMock: boolean;
  /** 探针 2：本机端点非白名单路径请求计数（遥测/更新/远程控制零外连的行为证据）。 */
  localStats: { rejectedPathRequests: number; rejectedPaths: string[]; rejectedToolCalls: number };
  /** 密钥体系上下文（§5.3：签名事件链、本机设备证书、律所公钥）。 */
  keyctx: KernelKeyContext;
  /** W1：出站批准凭据、无事项问答、kap 引擎（确认卡与提问通道）与事项运行策略。 */
  approvals?: EgressApprovalStore | null;
  qa?: QaChatService | null;
  kap?: KapAgentClient | null;
  matterPolicy?: (matterId: string) => KapMatterPolicy;
  /** 急停撤销任务令牌（§15.2 runs.cancel）。 */
  revokeRun?: (runId: string) => void;
  /** 事项令牌存储（令牌化工作区；还原只给可信界面）。 */
  tokens?: MatterTokenStore;
  /** 出站闸门（状态与上游配置，“连接”页与设备页）。 */
  gate?: KernelGate;
  /** 律所治理（阶段 6：生效的律所策略、许可与退出模式、告警、公钥变更核对、事项匿名摘要）。 */
  governance?: FirmGovernance;
  /** 控制面客户端（配置了控制面时；请求经闸门代发）。 */
  controlPlane?: ControlPlaneClient | null;
  /** 方法模板包（Kimi Code Skills）验签结果：方法库页展示可用的方法模板，校验失败如实显示原因。 */
  skills?: SkillsBundleStatus;
  /** 在线内容更新（第 8 批 S6/S7：法规库增量包与方法模板包）。 */
  content?: ContentUpdater;
  /** 清理一个事项的本机 Agent 数据与工作区密钥（结案、删除时调用；有进行中任务时抛错）。 */
  purgeAgentData?: (matterId: string) => Promise<void>;
  /** 是否设置了本应用的自动备份位置（删除回执用）。 */
  backupConfigured?: () => boolean;
  /** 登记内核关闭前要执行的冲刷（例如未到期的还原审计窗口）。 */
  onShutdown?: (fn: () => void) => void;
  /** 期限提醒（第 10 批 S9）。 */
  reminders?: ReminderService;
  /** 团队事项经中软共享中继同步（第 11 批 S11）。 */
  shareRelay?: ShareRelaySync;
}

type Handler = (params: any, id: Identity) => unknown | Promise<unknown>;
/** 离所交接清单的一件事项（members.offboarding）。 */
interface OffboardingMatterRow {
  matter_id: string;
  title: string;
  collab_scope: string;
  created_at: string;
  lifecycle?: string;
}
type FirmGovernance = import("../control-plane/governance.ts").FirmGovernance;
type ControlPlaneClient = import("../control-plane/client.ts").ControlPlaneClient;

/** 文书版式样张（虚构内容）。 */
const DOC_STYLE_SAMPLE = [
  "# 关于某某公司股权转让事项的法律意见书（样张）",
  "## 一、基本事实",
  "根据委托人提供的材料，甲公司持有乙公司 60% 的股权。以下内容为虚构，仅用于查看版式。",
  "## 二、法律分析",
  "### （一）转让限制",
  "依据《中华人民共和国公司法》的有关规定，股东向股东以外的人转让股权，应当书面通知其他股东。",
  "| 事项 | 结论 |",
  "|---|---|",
  "| 优先购买权 | 需取得其他股东书面放弃 |",
  "## 三、结论",
  "建议在签署前完成上述程序。",
  "",
  "某某律师事务所",
  "承办律师：某某",
  "2026年10月20日",
].join("\n");

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

/** 阶段、事件时点（YYYY-MM-DD 或只到月 YYYY-MM）、地域的入参校验；undefined 表示没给，null 或空串表示清空。 */
function matterFactsFrom(body: any): { stage?: string | null; event_date?: string | null; region?: string | null } {
  const out: { stage?: string | null; event_date?: string | null; region?: string | null } = {};
  if (body?.stage !== undefined) {
    const v = body.stage === null || body.stage === "" ? null : body.stage;
    if (v !== null && !(MATTER_STAGES as readonly string[]).includes(v)) throw validation(`stage 须为 ${MATTER_STAGES.join("/")}`);
    out.stage = v;
  }
  if (body?.event_date !== undefined) {
    const v = body.event_date === null || body.event_date === "" ? null : String(body.event_date);
    if (v !== null) {
      const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(v);
      const month = m ? Number(m[2]) : 0;
      const day = m?.[3] ? Number(m[3]) : 1;
      if (!m || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(Number(m[1]), month, 0)).getUTCDate()) throw validation("event_date 须为 YYYY-MM-DD 或只到月 YYYY-MM");
    }
    out.event_date = v;
  }
  if (body?.region !== undefined) {
    const v = body.region === null ? null : String(body.region).trim();
    if (v !== null && v.length > 20) throw validation("region 至多 20 字");
    out.region = v || null;
  }
  return out;
}

function matterOut(m: any): any {
  // W1：事项头常显的数据级别、四项依据与全部化名（四项未记录的旧事项按 consent_status 推出）
  return m
    ? {
        ...m,
        key_dates: parseJson(m.key_dates, {}),
        data_level: dataLevelOf(m.confidentiality, m.consent_status),
        basis: parseBasis(m.basis) ?? legacyBasis(m.consent_status),
        basis_complete: basisCompleteOf(m),
        full_pseudonym: m.full_pseudonym === 1 || dataLevelOf(m.confidentiality) === "L3a",
        // 数据生命周期（迁移 0021）：进行中 / 已结案（保留期）/ 已删除；法律保全
        lifecycle: m.lifecycle ?? "active",
        legal_hold: m.legal_hold === 1,
        purge_eligible: m.lifecycle === "closed" && m.legal_hold !== 1 && !!m.retention_until && m.retention_until <= new Date().toISOString(),
      }
    : m;
}

function legacyBasis(consent: string | null | undefined): Record<string, string> {
  const v = consent === "agreed" || consent === "not_required" ? "confirmed" : "pending";
  return { engagement: v, personal_info: v, sensitive: "not_applicable", subprocessor: v };
}

/** 四项依据的入参校验（第 02 篇 §8.1）：四项都须是 confirmed / pending / not_applicable。 */
/**
 * 四项依据（第 02 篇 §8.1）。“不适用”的约束（复核 S5-A09）：委托/保密授权在任何端点都适用（使用 AI 与第三方服务须经授权）；
 * 转委托与次处理者只在不经第三方处理时（律所私有模型或不使用模型）可为“不适用”。个人信息与敏感信息按材料实际情况可为“不适用”。
 */
function basisFrom(v: unknown, endpoint: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "object") throw new DomainError("validation", "basis 须为对象", 422);
  const o = v as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const k of BASIS_KEYS) {
    const x = o[k];
    if (x !== "confirmed" && x !== "pending" && x !== "not_applicable") throw new DomainError("validation", `basis.${k} 须为 confirmed / pending / not_applicable`, 422);
    out[k] = x;
  }
  if (out.engagement === "not_applicable") throw new DomainError("validation", "委托/保密授权不能为“不适用”：使用 AI 与第三方服务须经委托或保密授权", 422);
  if (out.subprocessor === "not_applicable" && endpoint !== "private" && endpoint !== "none") {
    throw new DomainError("validation", "转委托与次处理者只在使用律所私有模型或不使用模型时可为“不适用”（标准端点与自带密钥都有第三方处理者）", 422);
  }
  return JSON.stringify(out);
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
  if (kind === "egress_record") return db.get<{ matter_id: string }>(`SELECT matter_id FROM egress_records WHERE record_id = ?`, [objectId])?.matter_id ?? null;
  return null;
}

function safeJson(s: string | null | undefined): Record<string, any> {
  try {
    const v = JSON.parse(s ?? "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {};
  } catch {
    return {};
  }
}

function registerParsedDocumentRemoved(): void {
  // （已移除：解析登记在 insertDocumentWithParse 内完成）
}
void registerParsedDocumentRemoved;

/**
 * 本事项正在进行或排队中的 Agent 任务（Agent 宿主在同一事项同时只运行一个任务——执行域取消范围与路由 fencing 按事项，审查 S3-16）。
 * 发起前就如实告诉律师，而不是先受理、排队后再以“已有运行中的任务”失败（2026-10-14 联调发现）。对账中的任务宿主已不在运行，不计入。
 * 复核 B4-B11：崩溃恢复中的任务（recovering）会重新入队并再次拉起宿主，计入；waiting_device 目前没有任何代码路径会让开放任务进入，不列。
 */
function liveAgentRunOf(db: KernelDb, matterId: string): { run_id: string; goal: string } | null {
  const rows = db.all<{ run_id: string; status: string; input_snapshot: string | null }>(
    `SELECT run_id, status, input_snapshot FROM runs WHERE matter_id = ? AND scenario = 'a1.agent_task' AND status IN ('queued','running','recovering','waiting_input','waiting_approval','budget_paused') ORDER BY created_at DESC LIMIT 1`,
    [matterId],
  );
  const r = rows[0];
  if (!r) return null;
  const goal = String(parseJson<any>(r.input_snapshot, {})?.goal ?? "").replace(/\s+/g, " ").slice(0, 24);
  return { run_id: r.run_id, goal };
}

/** 成果里的事实角标（v9.4 第 21 批，C1 §4.3）：按日期对到事项的事实行；读不出文字的成果没有角标。 */
function artifactFactsFor(db: KernelDb, blobs: BlobStore, art: { matter_id: string; filename: string; storage_uri: string }): FactMark[] {
  try {
    const text = artifactText(String(art.filename), blobs.read(String(art.storage_uri)));
    return text === "format" || text === "error" ? [] : artifactFactMarks(db, art.matter_id, text.slice(0, 2_000_000));
  } catch {
    return [];
  }
}

/** 成果文件的引用核验（第 13 批）：适用时点取事项的分析截止日，缺省今天。 */
function artifactCitationsFor(db: KernelDb, blobs: BlobStore, lawdb: Lawdb, art: { artifact_version_id: string; matter_id: string; filename: string; storage_uri: string }): ArtifactCitationCheck | null {
  try {
    const m = db.get<{ key_dates: string | null; event_date: string | null; region: string | null }>(`SELECT key_dates, event_date, region FROM matters WHERE matter_id = ?`, [art.matter_id]);
    const kd = parseJson<Record<string, unknown>>(m?.key_dates ?? "{}", {});
    const asOf = typeof kd.analysis_as_of === "string" && /^\d{4}-\d{2}-\d{2}$/.test(kd.analysis_as_of) ? kd.analysis_as_of : localToday();
    // 事件时点与地域（v9.4 S-08）：实体法按事件时点复核适用版本、地方性规定按地域复核
    const c = checkArtifactCitations(lawdb, String(art.filename), blobs.read(String(art.storage_uri)), asOf, { event_date: m?.event_date ?? null, region: m?.region ?? null });
    // 律师对每处引用支持性的逐条决定（C-03）：只认本成果版本的
    const decisions = new Map(db.all<{ cite_key: string; decision: CitationDecision }>(`SELECT cite_key, decision FROM citation_decisions WHERE artifact_version_id = ?`, [art.artifact_version_id]).map((r) => [r.cite_key, r.decision] as const));
    return withDecisions(c, decisions);
  } catch {
    // 出错不放行（复核 B13-U02）：按“系统没有核对”处理，须人工核对勾选
    return uncheckedCitations("error", lawdb.packageVersion, localToday());
  }
}

export function createApi(deps: ApiDeps): Record<string, Handler> {
  const { db, blobs, broker, egress, queue, config, lawdb, keyctx, ioMutex, ocrModelPaths, parseMock, parseWorker, localStats, revokeRun, tokens, gate } = deps;
  const MODE_RANK: Record<string, number> = { chat: 0, manual: 1, default: 2, auto: 3 };
  const titleCache = new Map<string, string | null>();
  /** Markdown/文本成果的第一行标题（去掉 # 与强调符号，至多 40 字）；读不到或不是文本返回 null。 */
  const artifactTitle = (id: string, filename: string, uri: string): string | null => {
    if (titleCache.has(id)) return titleCache.get(id)!;
    let title: string | null = null;
    if (isTitledFilename(filename)) {
      try {
        title = firstLineTitle(blobs.read(uri));
      } catch {
        title = null;
      }
    }
    if (titleCache.size > 2000) titleCache.clear();
    titleCache.set(id, title);
    return title;
  };
  /** 界面用的运行策略视图（模式选择器只显示允许的档位；第 03 篇 §8.1）。 */
  const runPolicyView = (matterId: string) => {
    if (!deps.matterPolicy) return null;
    const pol = deps.matterPolicy(matterId);
    const allowed = (["chat", "manual", "default", "auto"] as const).filter((m) => MODE_RANK[m]! <= MODE_RANK[pol.maxMode]!);
    return {
      allowed_modes: allowed,
      default_mode: allowed.includes("default") ? "default" : allowed[allowed.length - 1],
      plan_first_default: true,
      preauthorizations: pol.allowedPreauthorizations,
      budget: { max_tool_calls: pol.budget.maxToolCalls, max_subagents: pol.budget.maxSubagents },
      data_level: pol.dataLevel,
      basis_complete: pol.basisComplete,
      execution_location: "本机",
    };
  };

  const lifecycleDeps = (): LifecycleDeps => ({
    db,
    purgeBlobs: (matterId) => {
      blobs.purgeMatter(matterId);
      // 本机中继收发件目录里该事项的段（第 11 批 S11）
      deps.shareRelay?.purgeMatter(matterId);
    },
    deviceId: keyctx.device.deviceId,
    signer: keyctx.device.signer,
    signPublicKeyPem: keyctx.device.cert.signPublicKeyPem,
    purgeAgentData: deps.purgeAgentData ?? (async () => {}),
    ...(deps.backupConfigured ? { backupConfigured: deps.backupConfigured } : {}),
  });
  /** 删除回执（含签名与签名设备证书，可离线验签：证书由律所根公钥签发）。 */
  const receiptView = (matterId: string) => {
    const r = deletionReceiptOf(db, matterId);
    if (!r) return null;
    const certJson = db.get<{ cert_json: string }>(`SELECT cert_json FROM devices WHERE device_id = ?`, [r.receipt.device_id])?.cert_json;
    const current = certJson ? (JSON.parse(certJson) as DeviceCertificate) : r.receipt.device_id === keyctx.device.deviceId ? keyctx.device.cert : null;
    // 当前证书验不过时再试同一设备编号的留档证书（复核 B4-A11）
    // 留档证书只对见证序号不晚于其上界的回执有效（复核 B4-R10）：回执由签名的 matter.purged 审计事件见证
    const witness = db.get<{ seq: number }>(
      `SELECT se.seq FROM signed_events se JOIN audit_events ae ON se.kind = 'audit_event' AND se.ref_id = CAST(ae.audit_event_id AS TEXT)
        WHERE ae.action = 'matter.purged' AND ae.object_id = ? ORDER BY se.seq DESC LIMIT 1`,
      [matterId],
    )?.seq ?? null;
    let cert = current;
    if (!(current && verifyDeletionReceipt(r.receipt, r.signature, current.signPublicKeyPem)) && witness !== null) {
      const archived = archivedCertsOf(db, r.receipt.device_id).find(
        (a) => witness <= a.supersededSeq && a.cert.deviceId === r.receipt.device_id && verifyCertSignature(a.cert, keyctx.firm.rootPublicKeyPem) && verifyDeletionReceipt(r.receipt, r.signature, a.cert.signPublicKeyPem),
      );
      if (archived) cert = archived.cert;
    }
    return { ...r, signer_cert: cert, signature_valid: cert ? verifyDeletionReceipt(r.receipt, r.signature, cert.signPublicKeyPem) : false };
  };

  /** 模型推理的阻断原因（与闸门、宿主、内核前置检查同一口径）；没有阻断返回 null。估价与发起共用（复核 C-B13）。 */
  function modelBlockReason(matter: any): string | null {
    const level = dataLevelOf(matter.confidentiality, matter.consent_status);
    const pendingLabels = pendingBasisLabels(matter.basis);
    // 律所策略（阶段 6：控制面下发、放宽须管理员设备签名；开发形态为本机配置项，D-17）
    const l3aAllowed = deps.governance ? deps.governance.l3aStandardAllowed() : config.env.ZR_FIRM_L3A_STANDARD_MODEL === "allow";
    if (matter.model_endpoint === "none") return "该事项设置为「不使用模型」";
    if (matter.consent_status === "refused" && matter.model_endpoint !== "private") return "当事人拒绝云端处理（记录）：只能使用律所私有模型或不使用模型";
    if (level === "L3b" && matter.model_endpoint !== "private") return "当事人限制（L3b）：不使用云端模型与联网检索，只允许律所私有模型端点";
    if (!basisCompleteOf(matter)) {
      return pendingLabels && pendingLabels.length
        ? `四项依据有“待确认”（${pendingLabels.join("、")}）：模型推理与联网都不会发生，只运行本机能力`
        : "四项依据待确认：模型推理与联网都不会发生，只运行本机能力";
    }
    if (level === "L3a" && matter.model_endpoint === "standard" && !l3aAllowed) return "敏感事项（L3a）经标准端点推理须由律所管理员放开（或改用律所私有端点）";
    if (matter.model_endpoint === "standard" && deps.governance?.mode === "control_plane" && !deps.governance.seatToken()) {
      return "席位令牌未取得或已失效（联网后自动续期）：经标准端点的推理与联网检索暂不可用";
    }
    return null;
  }

  /** 统一解析入口：PDF/JPG/PNG 走隔离进程管线（持互斥锁，§4.5）；DOCX/TXT 维持 v0 粗解析。 */
  async function parseAny(buf: Buffer, filename: string, mime: string): Promise<{ text: string; pageCount: number | null; qualityFlags: string[]; parser: string; parserVersion: string; pages?: { pageNo: number; kind: string; quality: string; note?: string | undefined; charCount: number; meanScore?: number | undefined }[] }> {
    if (isPdf(filename, mime) || isImage(filename, mime)) {
      const r = await ioMutex.runExclusive(() => parseWithPipeline(buf, filename, mime, { ocrModelPaths, mockOcr: parseMock, worker: parseWorker }));
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
    /** 导入副本的块存储在密级检测通过之后才写入（命中即不留任何副本；审计 S6）。 */
    storageUri: string | (() => string);
    sha256: string;
    uploadedBy: string;
    identity: Identity;
  }): Promise<{ document_version_id: string; parse_version_id: string; quality_flags: string[]; chars: number; marking_notice: string | null }> {
    const parsed = await parseAny(args.bytes, args.filename, args.mime);
    const notice = classifiedGate(args.matterId, args.filename, args.mime, args.bytes, parsed.text, args.sha256, args.identity);
    const storageUri = typeof args.storageUri === "function" ? args.storageUri() : args.storageUri;
    const docId = newId("documentVersion");
    const psvId = newId("parseVersion");
    db.tx(() => {
      db.run(
        `INSERT INTO document_versions (document_version_id, matter_id, tenant_id, filename, sha256, size_bytes, mime, storage_mode, storage_uri, uploaded_by)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [docId, args.matterId, args.tenantId, args.filename, args.sha256, args.bytes.length, args.mime, args.storageMode, storageUri, args.uploadedBy],
      );
      db.run(
        `INSERT INTO parse_versions (parse_version_id, document_version_id, parser, parser_version, page_count, quality_flags, text_uri)
         VALUES (?,?,?,?,?,?,?)`,
        [psvId, docId, parsed.parser, parsed.parserVersion, parsed.pageCount, JSON.stringify(parsed.qualityFlags), `db://parse_texts/${psvId}`],
      );
      db.run(`INSERT INTO parse_texts (parse_version_id, content) VALUES (?,?)`, [psvId, parsed.text]);
      insertParsePages(psvId, parsed.pages);
    });
    return { document_version_id: docId, parse_version_id: psvId, quality_flags: parsed.qualityFlags, chars: parsed.text.length, marking_notice: notice };
  }

  /**
   * 密级标志检测（第 02 篇 §8.1 L4；审计 S6）：国家秘密标志即拒绝（不入库、不留副本，审计只记命中类别与文件 hash）；
   * “内部★”“工作秘密”照常导入并返回提示。扫描件在 OCR 未就绪时没有文字可查，导入结果另行说明。
   */
  function classifiedGate(matterId: string, filename: string, mime: string, bytes: Buffer, text: string, sha256: string, identity: Identity): string | null {
    const findings: ClassifiedFinding[] = detectClassifiedMarking({ filename, text, headerFooter: docxHeaderFooterTexts(filename, mime, bytes) });
    const secret = findings.find((f) => f.kind === "state_secret");
    if (secret) {
      audit(db, identity, "materials.classified_refused", "matter", matterId, sha256Hex(JSON.stringify({ level: secret.level, where: secret.where, file_sha256: sha256 })), keyctx);
      throw new DomainError(
        "classified_material",
        `该文件带有国家秘密标志（${secret.level}★），按规定不能导入本产品或交给 AI 处理，请按涉密载体管理规定线下处理。文件未保存任何副本。`,
        422,
        { level: secret.level, where: secret.where },
      );
    }
    const internal = findings.find((f) => f.kind === "internal");
    return internal ? `文件带有“${internal.level}”标志：请确认这份材料可以使用 AI 辅助处理（不属于国家秘密，已照常导入）` : null;
  }

  /**
   * 隔离一份材料（复核 B3-A05）：删除解析文本、页面与证据锚点、据此产生的风险卡与事实行；导入副本块在没有其他登记引用时删除；
   * 本事项的 Agent 会话与工作区一并清理（里面可能有该材料的摘录）；有进行中的任务时这一步跳过，隔离本身照常生效（材料已不能再被读取）。
   */
  async function quarantineDocument(doc: { document_version_id: string; matter_id: string; sha256: string; storage_mode: string; storage_uri: string }, reason: string, identity: Identity): Promise<void> {
    const PVS = `SELECT parse_version_id FROM parse_versions WHERE document_version_id = ?`;
    // 同一事项里内容相同的其他登记一并隔离（复核 C-A05 部分：同一份文件导入或挂载过多次）
    const same = db.all<{ document_version_id: string; storage_mode: string; storage_uri: string }>(
      `SELECT document_version_id, storage_mode, storage_uri FROM document_versions WHERE matter_id = ? AND (document_version_id = ? OR sha256 = ?) AND quarantined_at IS NULL`,
      [doc.matter_id, doc.document_version_id, doc.sha256],
    );
    const ids = same.map((x) => x.document_version_id);
    db.tx(() => {
      for (const id of ids) {
        db.run(`DELETE FROM parse_texts WHERE parse_version_id IN (${PVS})`, [id]);
        db.run(`DELETE FROM parse_pages WHERE parse_version_id IN (${PVS})`, [id]);
        db.run(`DELETE FROM evidence_anchors WHERE parse_version_id IN (${PVS})`, [id]);
        db.run(`DELETE FROM risk_cards WHERE document_version_id = ?`, [id]);
        // 别的合同的卡上跨文件引用了这份材料的原文（v9.4 第 21 批，复核 Q3-01）：抹去原文，只留“来源已隔离”
        scrubRelatedQuotes(db, doc.matter_id, id);
        // 审阅表里这份材料的格子（逐字引文与提取的值，复核 Q2-02）；论点提纲里抄过来的、据此材料的事实文字一并抹去
        db.run(`DELETE FROM review_cells WHERE document_version_id = ?`, [id]);
        scrubOutlineFacts(db, doc.matter_id, db.all<{ fact_id: string }>(`SELECT fact_id FROM matter_facts WHERE document_version_id = ?`, [id]).map((f) => f.fact_id));
        db.run(`DELETE FROM matter_facts WHERE document_version_id = ?`, [id]);
        db.run(`UPDATE document_versions SET quarantined_at = ?, quarantine_reason = ? WHERE document_version_id = ?`, [nowIso(), reason, id]);
      }
      // 隔离前已生成的成果：用过这些材料的任务的成果标出“待处置”（不自动删除——律师须决定成果是否含有涉密内容）
      const usedRuns: string[] = [];
      for (const run of db.all<{ run_id: string; input_snapshot: string | null }>(`SELECT run_id, input_snapshot FROM runs WHERE matter_id = ?`, [doc.matter_id])) {
        const used = parseJson<any>(run.input_snapshot, {})?.document_version_ids;
        if (!Array.isArray(used) || !used.some((x: unknown) => ids.includes(String(x)))) continue;
        usedRuns.push(run.run_id);
        for (const a of db.all<{ artifact_version_id: string; open_items: string }>(`SELECT artifact_version_id, open_items FROM artifact_versions WHERE run_id = ?`, [run.run_id])) {
          const items = parseJson<unknown[]>(a.open_items, []);
          items.push({ kind: "quarantined_source", note: "本成果引用的材料带国家秘密标志、已隔离：请按涉密载体规定核查本成果，确认前不得交付" });
          db.run(`UPDATE artifact_versions SET open_items = ? WHERE artifact_version_id = ?`, [JSON.stringify(items), a.artifact_version_id]);
        }
      }
      // 从这些任务起草的审查要点（复核 Q4-02）：草稿删除，审定启用的版本清除内容、在用的停用——否则据涉密范本概括的条款会随之后每次审合同发出
      scrubRulesFromRuns(db, doc.matter_id, usedRuns);
    });
    for (const s of same) {
      if (s.storage_mode !== "import") continue;
      const others = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM document_versions WHERE storage_uri = ? AND quarantined_at IS NULL`, [s.storage_uri])!.n;
      if (others === 0) blobs.remove(s.storage_uri);
    }
    try {
      await deps.purgeAgentData?.(doc.matter_id);
    } catch {
      // 有进行中的任务：会话里的摘录留到任务结束后由律师处理（隔离本身已生效：材料不能再被读取）
    }
    audit(db, identity, "materials.quarantined", "document", doc.document_version_id, sha256Hex(reason), keyctx);
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

  /** 令牌还原计量（隐私安全审查 P1-5）：（成员, 事项）→ 本分钟的调用次数与还原条数。 */
  const RESTORE_MAX_CALLS_PER_MIN = 600;
  const RESTORE_MAX_TOKENS_PER_MIN = 50_000;
  type RestoreWindow = { windowStart: number; calls: number; restored: number; started: boolean; throttled: boolean; closed: boolean; identity: Identity; matterId: string };
  const restoreMeter = new Map<string, RestoreWindow>();
  function safeAudit(identity: Identity, action: string, matterId: string, detail: Record<string, unknown>): void {
    try {
      audit(db, identity, action, "matter", matterId, sha256Hex(JSON.stringify(detail)), keyctx);
    } catch {
      // 审计写入失败不影响界面渲染（签名链另有告警）
    }
  }
  /** 窗口收尾：有还原就记一条带条数的审计（到期、内核关闭时各调用一次，只记一次）。 */
  function closeRestoreWindow(m: RestoreWindow): void {
    if (m.closed) return;
    m.closed = true;
    if (m.restored > 0 || m.throttled) safeAudit(m.identity, "matter.tokens_restored", m.matterId, { calls: m.calls, restored: m.restored, throttled: m.throttled, window_start: new Date(m.windowStart).toISOString() });
  }
  /**
   * 本分钟的计量窗口（复核 B3-A15）：窗口内第一次还原即预写一条“开始还原”审计（进程中途退出也留有记录）；
   * 到期（定时器，不阻止进程退出）或内核关闭时补记条数。
   */
  function restoreWindow(identity: Identity, matterId: string): RestoreWindow {
    const key = `${identity.userId}\u0000${matterId}`;
    const cur = restoreMeter.get(key);
    if (cur && Date.now() - cur.windowStart < 60_000) return cur;
    if (cur) closeRestoreWindow(cur);
    const m: RestoreWindow = { windowStart: Date.now(), calls: 0, restored: 0, started: false, throttled: false, closed: false, identity, matterId };
    restoreMeter.set(key, m);
    const t = setTimeout(() => {
      if (restoreMeter.get(key) === m) restoreMeter.delete(key);
      closeRestoreWindow(m);
    }, 60_000);
    t.unref?.();
    return m;
  }
  deps.onShutdown?.(() => {
    for (const m of restoreMeter.values()) closeRestoreWindow(m);
    restoreMeter.clear();
  });
  /** 全局搜索的还原计量（余项续复核 RC-A-05）：每人每分钟一条 search.titles_restored（次数、条数、涉及几个事项），不按事项记“取原文”。 */
  type SearchWindow = { start: number; calls: number; restored: number; matters: Set<string>; identity: Identity; closed: boolean };
  const searchMeter = new Map<string, SearchWindow>();
  const closeSearchWindow = (w: SearchWindow) => {
    if (w.closed) return;
    w.closed = true;
    if (w.restored > 0) {
      try {
        audit(db, w.identity, "search.titles_restored", "user", w.identity.userId, sha256Hex(JSON.stringify({ calls: w.calls, restored: w.restored, matters: w.matters.size, window_start: new Date(w.start).toISOString() })), keyctx);
      } catch {
        // 审计写入失败不影响搜索（签名链另有告警）
      }
    }
  };
  function searchRestoreWindow(identity: Identity): SearchWindow {
    const cur = searchMeter.get(identity.userId);
    if (cur && Date.now() - cur.start < 60_000) return cur;
    if (cur) closeSearchWindow(cur);
    const w: SearchWindow = { start: Date.now(), calls: 0, restored: 0, matters: new Set(), identity, closed: false };
    searchMeter.set(identity.userId, w);
    const t = setTimeout(() => {
      if (searchMeter.get(identity.userId) === w) searchMeter.delete(identity.userId);
      closeSearchWindow(w);
    }, 60_000);
    t.unref?.();
    return w;
  }
  deps.onShutdown?.(() => {
    for (const w of searchMeter.values()) closeSearchWindow(w);
    searchMeter.clear();
  });

  /**
   * 这台电脑（本律所）放过诉讼示例没有（含已移除的；放过就不再提示）。删除后事项名会被擦除，所以也按条数认：
   * 诉讼示例上线后两件示例一起放入，放过两件即放过诉讼示例。
   */
  const litigationSampleOffered = (id: Identity): boolean => {
    const r = db.get<{ n: number; lit: number }>(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN m.title = ? THEN 1 ELSE 0 END) AS lit FROM sample_matters s JOIN matters m ON m.matter_id = s.matter_id WHERE m.tenant_id = ?`,
      [LIT_SAMPLE_TITLE, id.tenantId],
    );
    return !!r && (r.n >= 2 || (r.lit ?? 0) > 0);
  };
  /**
   * 诉讼线示例（Z3 #27）：四份合成材料，再在本机按规则跑一次“整理案卷”（确定性流程，不调用 AI、不联网）；
   * 整理失败不影响放入——材料还在，律师可以自己点“整理案卷”（示例说明按整理任务的状态写，余项续复核 RC-B-13）。
   */
  async function installLitigationSample(id: Identity): Promise<string> {
    const lit = (await api["matters.create"]!({ title: LIT_SAMPLE_TITLE, stance: "原告", client_name: "丁贸易有限公司（示例）", counterparty: "戊制造有限公司（示例）", consent_status: "not_required" }, id)) as { matter: { matter_id: string } };
    const litId = lit.matter.matter_id;
    db.run(`INSERT INTO sample_matters (matter_id) VALUES (?)`, [litId]);
    const litDocs: string[] = [];
    for (const f of litigationSampleMaterials()) {
      const d = (await api["materials.import"]!({ matter_id: litId, filename: f.filename, data_base64: f.data.toString("base64"), mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }, id)) as { document_version_id: string };
      db.run(`INSERT INTO document_roles (document_version_id, matter_id, role, set_by) VALUES (?,?,?,?)`, [d.document_version_id, litId, "ours", id.userId]);
      litDocs.push(d.document_version_id);
    }
    try {
      const est = (await api["runs.estimate"]!({ matter_id: litId, scenario: "s2.case_file", document_version_ids: litDocs, issues: LIT_SAMPLE_ISSUES }, id)) as { estimate_id?: string };
      if (est.estimate_id) await api["runs.start"]!({ matter_id: litId, estimate_id: est.estimate_id, idempotency_key: `sample-casefile-${litId}` }, id);
    } catch {
      // 见上
    }
    audit(db, id, "sample.installed", "matter", litId, undefined, keyctx);
    return litId;
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
      const basisJson = basisFrom(body.basis, endpoint);
      // 四项依据给出时由四项派生 consent_status（“已拒绝”保留：当事人限制另由密级表达）
      let consent = body.consent_status ?? ConsentStatus.pending;
      if (basisJson && consent !== "refused") consent = basisCompleteOf({ basis: basisJson }) ? "agreed" : "pending";
      if (!Object.values(ConsentStatus).includes(consent)) throw validation(`consent_status 须为 ${Object.values(ConsentStatus).join("/")}`);
      if (body.confidentiality !== undefined && !["normal", "high", "strict"].includes(body.confidentiality)) throw validation("confidentiality 须为 normal / high / strict");
      const facts = matterFactsFrom(body);
      // 事项模板（v9.4 第 22 批，C1 #20）：先校验并算好届满日，失败即不创建；阶段没给时用模板的
      const plan = planTemplate(body.template_id, body.template_start, body.stance);
      if (plan && facts.stage === undefined && plan.template.stage) facts.stage = plan.template.stage;
      const keyDates = { ...(plan?.key_dates ?? {}), ...(body.key_dates ?? {}) };
      const matterId = newId("matter");
      let todosAdded = 0;
      db.tx(() => {
        db.run(
          `INSERT INTO matters (matter_id, tenant_id, title, client_name, counterparty, stance, jurisdiction,
                                key_dates, confidentiality, model_endpoint, collab_scope, consent_status, created_by, basis, stage, event_date, region, template_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            matterId,
            id.tenantId,
            body.title,
            body.client_name ?? null,
            body.counterparty ?? null,
            body.stance,
            body.jurisdiction ?? "内地民商事",
            JSON.stringify(keyDates),
            body.confidentiality ?? "normal",
            endpoint,
            scope,
            consent,
            id.userId,
            basisJson,
            facts.stage ?? null,
            facts.event_date ?? null,
            facts.region ?? null,
            plan?.template.id ?? null,
          ],
        );
        db.run(
          `INSERT INTO matter_members (matter_id, user_id, matter_role, added_by, removed_at, removed_lamport, author_device, row_lamport) VALUES (?,?,'owner',?,NULL,NULL,?,?)`,
          [matterId, id.userId, id.userId, keyctx.device.deviceId, nextMemberLamport(db, matterId)],
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
        // 团队事项的成员链起点（第 12 批；个人事项不同步、不写链）
        if (scope === "team" && !config.legacyMemberRows) writeGenesis({ db, keyctx, tenantId: id.tenantId }, matterId, id.userId, matterKey);
        if (plan) todosAdded = applyTemplateTodos(db, plan, { tenant_id: id.tenantId, matter_id: matterId, created_by: id.userId });
      });
      audit(db, id, "matter.create", "matter", matterId, plan ? sha256Hex(JSON.stringify({ template: plan.template.id, todos: todosAdded, deadline: !!plan.deadline })) : undefined, keyctx);
      // 事项匿名摘要（阶段 6；经控制面下发网关做二次检查，收敛 D-20）：只有匿名编号与数据级别、端点、依据是否齐备
      deps.governance?.enqueueSummary(matterId);
      void deps.controlPlane?.pushSummaries().catch(() => {});
      return {
        matter: matterOut(db.get(`SELECT * FROM matters WHERE matter_id = ?`, [matterId])),
        ...(plan ? { template_applied: { template_id: plan.template.id, todos: todosAdded, deadline: plan.deadline, stance_mismatch: plan.stance_mismatch } } : {}),
      };
    },
    // 事项模板清单（v9.4 第 22 批）：新建事项时选类型；概览里“推荐的方法”按模板的场景卡 id
    "matters.templates": () => ({ templates: templatesView() }),

    "matters.list": (_p, id) => {
      const rows = db.all(
        `SELECT m.matter_id, m.title, m.client_name, m.counterparty, m.stance, m.jurisdiction, m.confidentiality,
                m.model_endpoint, m.collab_scope, m.consent_status, m.basis, m.full_pseudonym, m.key_dates, m.status, m.created_at, m.stage, m.event_date, m.region,
                m.lifecycle, m.closed_at, m.retention_until, m.legal_hold, m.legal_hold_reason, m.purged_at
           FROM matters m JOIN matter_members mm ON mm.matter_id = m.matter_id AND mm.user_id = ? AND mm.removed_at IS NULL
          WHERE m.tenant_id = ? AND m.status = 'active' AND (m.lifecycle <> 'purged' OR ? = 1) ORDER BY m.created_at DESC LIMIT 100`,
        [id.userId, id.tenantId, _p?.include_purged === true ? 1 : 0],
      );
      // 进行中与等你确认的任务（UIUX 增量评审 P0-F：侧栏状态点、窗口标题与系统通知，离开执行页也知道有任务在等你）
      const act = new Map<string, { waiting: number; running: number; waiting_run_id: string | null }>();
      for (const r of db.all<{ matter_id: string; run_id: string; status: string }>(
        `SELECT matter_id, run_id, status FROM runs WHERE tenant_id = ? AND status IN ('queued','running','waiting_approval','waiting_input') ORDER BY created_at DESC`,
        [id.tenantId],
      )) {
        const a = act.get(r.matter_id) ?? { waiting: 0, running: 0, waiting_run_id: null };
        if (r.status === "waiting_approval" || r.status === "waiting_input") {
          a.waiting += 1;
          a.waiting_run_id ??= r.run_id;
        } else a.running += 1;
        act.set(r.matter_id, a);
      }
      // 事项列表“进展”与“最近活动”（v9.2 §4.4；Y4 M-1）：待签发的成果数、最近一次任务/材料/成果的时间
      const pendingReview = new Map<string, number>();
      for (const r of db.all<{ matter_id: string; n: number }>(`SELECT matter_id, COUNT(*) AS n FROM artifact_versions WHERE tenant_id = ? AND status = 'pending_review' GROUP BY matter_id`, [id.tenantId])) pendingReview.set(r.matter_id, r.n);
      const samples = new Set(db.all<{ matter_id: string }>(`SELECT matter_id FROM sample_matters WHERE removed_at IS NULL`, []).map((r) => r.matter_id));
      const lastAt = new Map<string, string>();
      const bump = (mid: string, at: string | null) => {
        if (at && (!lastAt.has(mid) || at > lastAt.get(mid)!)) lastAt.set(mid, at);
      };
      for (const r of db.all<{ matter_id: string; at: string | null }>(`SELECT matter_id, MAX(updated_at) AS at FROM runs WHERE tenant_id = ? GROUP BY matter_id`, [id.tenantId])) bump(r.matter_id, r.at);
      for (const r of db.all<{ matter_id: string; at: string | null }>(`SELECT matter_id, MAX(created_at) AS at FROM document_versions WHERE tenant_id = ? GROUP BY matter_id`, [id.tenantId])) bump(r.matter_id, r.at);
      for (const r of db.all<{ matter_id: string; at: string | null }>(`SELECT matter_id, MAX(created_at) AS at FROM artifact_versions WHERE tenant_id = ? GROUP BY matter_id`, [id.tenantId])) bump(r.matter_id, r.at);
      // 列表同样经 matterOut：数据级别（L2/L3a/L3b）、四项依据与全部化名常显（第 03 篇 §4.1；复核 S5-A05）
      return {
        matters: rows.map((m: any) => ({
          ...matterOut(m),
          ...(samples.has(m.matter_id) ? { is_sample: true } : {}),
          activity: { ...(act.get(m.matter_id) ?? { waiting: 0, running: 0, waiting_run_id: null }), pending_review: pendingReview.get(m.matter_id) ?? 0, last_at: lastAt.get(m.matter_id) ?? m.created_at },
        })),
      };
    },

    // ─── 示例事项（v9.2 §4.4；Y4 §5 D-6、#24）：虚构内容、本机生成、不联网；每台设备只自动放入一次，移除后不再放入 ───
    "samples.status": (_p, id) => {
      // 非诉、诉讼两件示例（Z3 #27）：matter_id 为第一件还在的（兼容旧调用方），matter_ids 为全部还在的
      const rows = db.all<{ matter_id: string; removed_at: string | null }>(
        `SELECT s.matter_id, s.removed_at FROM sample_matters s JOIN matters m ON m.matter_id = s.matter_id WHERE m.tenant_id = ? ORDER BY s.installed_at, s.rowid`,
        [id.tenantId],
      );
      const live = rows.filter((r) => !r.removed_at).map((r) => r.matter_id);
      return { installed: live.length > 0, removed: rows.some((r) => !!r.removed_at), matter_id: live[0] ?? null, matter_ids: live, litigation_offered: litigationSampleOffered(id) };
    },
    "samples.install": async (p, id) => {
      // 只放诉讼示例（余项续复核 RC-B-13）：诉讼示例上线前已经放过非诉示例的电脑，从设置里补放一次
      if (p?.kind === "litigation") {
        if (litigationSampleOffered(id)) return { matter_id: null, matter_ids: [], installed: false };
        const litId = await installLitigationSample(id);
        return { matter_id: litId, matter_ids: [litId], installed: true };
      }
      const prior = db.get<{ matter_id: string; removed_at: string | null }>(
        `SELECT s.matter_id, s.removed_at FROM sample_matters s JOIN matters m ON m.matter_id = s.matter_id WHERE m.tenant_id = ? LIMIT 1`,
        [id.tenantId],
      );
      // 只要放过任何一件示例（含已移除的）就不再放入（两件示例同时放入，见下）
      if (prior) return { matter_id: prior.removed_at ? null : prior.matter_id, installed: false };
      const created = (await api["matters.create"]!({ title: SAMPLE_TITLE, stance: "受让方", client_name: "乙投资有限公司（示例）", counterparty: "甲科技有限公司（示例）", consent_status: "not_required" }, id)) as { matter: { matter_id: string } };
      const mid = created.matter.matter_id;
      db.run(`INSERT INTO sample_matters (matter_id) VALUES (?)`, [mid]);
      const doc = (await api["materials.import"]!({ matter_id: mid, filename: SAMPLE_FILENAME, data_base64: sampleContract().toString("base64"), mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }, id)) as { document_version_id: string };
      db.run(`INSERT INTO document_roles (document_version_id, matter_id, role, set_by) VALUES (?,?,?,?)`, [doc.document_version_id, mid, "theirs", id.userId]);
      submitRiskCards({ db, blobs, ...(tokens ? { tokens } : {}) }, { tenantId: id.tenantId, matterId: mid, runId: null }, { document_version_id: doc.document_version_id, cards: SAMPLE_CARDS.map((c) => ({ ...c })) });
      audit(db, id, "sample.installed", "matter", mid, undefined, keyctx);
      const litId = await installLitigationSample(id);
      return { matter_id: mid, matter_ids: [mid, litId], installed: true };
    },
    "samples.remove": async (p, id) => {
      const mid = String(p?.matter_id ?? "");
      const row = db.get<{ removed_at: string | null }>(`SELECT removed_at FROM sample_matters WHERE matter_id = ?`, [mid]);
      if (!row) throw validation("这不是示例事项");
      if (row.removed_at) return { removed: true };
      const m = requireMatterAccess(db, mid, id);
      // 走正常的结案与删除流程（密码学擦除 + 签名回执），只是不要求律师输入名称与原因
      if ((m.lifecycle ?? "active") === "active") await api["matters.close"]!({ matter_id: mid, retention_years: 1 }, id);
      await api["matters.purge"]!({ matter_id: mid, confirm_title: m.title, early: true, reason: "移除示例事项" }, id);
      db.run(`UPDATE sample_matters SET removed_at = CURRENT_TIMESTAMP WHERE matter_id = ?`, [mid]);
      return { removed: true };
    },

    "matters.get": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      const docs = db.all(
        `SELECT dv.document_version_id, dv.filename, dv.sha256, dv.size_bytes, dv.mime, dv.storage_mode, dv.created_at, dv.quarantined_at, dr.role
           FROM document_versions dv LEFT JOIN document_roles dr ON dr.document_version_id = dv.document_version_id
          WHERE dv.matter_id = ? ORDER BY dv.created_at DESC`,
        [matter.matter_id],
      );
      const runs = db.all(
        `SELECT run_id, scenario, status, created_at, input_snapshot FROM runs WHERE matter_id = ? ORDER BY created_at DESC LIMIT 50`,
        [matter.matter_id],
      ).map((r: any) => {
        const snap = parseJson<any>(r.input_snapshot, {});
        return { run_id: r.run_id, scenario: r.scenario, status: r.status, created_at: r.created_at, mode: snap?.run_options?.mode ?? null, goal: typeof snap?.goal === "string" ? snap.goal.slice(0, 120) : null };
      });
      const myRole = db.get<{ matter_role: string }>(`SELECT matter_role FROM matter_members WHERE matter_id = ? AND user_id = ? AND removed_at IS NULL`, [matter.matter_id, id.userId])?.matter_role ?? null;
      const isSample = !!db.get(`SELECT 1 AS x FROM sample_matters WHERE matter_id = ? AND removed_at IS NULL`, [matter.matter_id]);
      return { matter: { ...matterOut(matter), my_role: myRole, ...(isSample ? { is_sample: true } : {}) }, documents: docs, runs, run_policy: runPolicyView(matter.matter_id) };
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
        // 关键日期就是概览“期限”里显示的：示例事项同样不改（复核 Q5-09）
        assertNotSample(db, matter.matter_id, "改关键日期");
        fields.push(`key_dates = ?`);
        values.push(JSON.stringify(body.key_dates));
      }
      const factPatch = Object.entries(matterFactsFrom(body));
      // 阶段、事件时点、地域：示例事项不改（界面只读，内核同样拦；复核 Q4 建议 3）
      if (factPatch.length > 0) assertNotSample(db, matter.matter_id, "改阶段、事件时点或地域");
      for (const [k, v] of factPatch) {
        fields.push(`${k} = ?`);
        values.push(v);
      }
      // 四项依据（W1，收敛偏离 D-21；复核 S5-A09）：分项记录时 consent_status 只由四项派生（显式给出的同意状态不覆盖派生值）；
      // 当事人拒绝云端处理的记录保留——须律师核实后单独清除（consent_status: pending），不随补录四项而静默翻转
      const hasBasis = body.basis !== undefined ? body.basis !== null : !!parseBasis(matter.basis);
      if (body.basis !== undefined) {
        const bj = basisFrom(body.basis, String(body.model_endpoint ?? matter.model_endpoint));
        fields.push(`basis = ?`);
        values.push(bj);
        if (matter.consent_status !== "refused") {
          fields.push(`consent_status = ?`);
          values.push(bj && basisCompleteOf({ basis: bj }) ? "agreed" : "pending");
        }
      }
      // 只改端点（不同时给四项）：按新端点复核“不适用”的约束——转委托与次处理者在标准端点或自带密钥下不能“不适用”，自动改为“待确认”（失败关闭，复核 S5-A16）
      let basisReopened = false;
      if (body.model_endpoint !== undefined && body.basis === undefined) {
        const cur = parseBasis(matter.basis);
        if (cur && cur.subprocessor === "not_applicable" && body.model_endpoint !== "private" && body.model_endpoint !== "none") {
          const bj = JSON.stringify({ ...cur, subprocessor: "pending" });
          fields.push(`basis = ?`);
          values.push(bj);
          if (matter.consent_status !== "refused") {
            fields.push(`consent_status = ?`);
            values.push("pending");
          }
          basisReopened = true;
        }
      }
      if (body.consent_status !== undefined && hasBasis) {
        const clearRefusal = matter.consent_status === "refused" && body.consent_status === "pending";
        if (body.consent_status !== "refused" && !clearRefusal) {
          // 已分项记录四项依据：同意状态由四项派生，界面无需（也不能）直接改写
          delete body.consent_status;
        } else if (clearRefusal) {
          // 清除拒绝记录后按（本次给出的或现有的）四项重新派生
          const bj = body.basis !== undefined ? basisFrom(body.basis, String(body.model_endpoint ?? matter.model_endpoint)) : matter.basis;
          body.consent_status = bj && basisCompleteOf({ basis: bj }) ? "agreed" : "pending";
        }
      }
      // 全部化名（第 02 篇 §8.3：L3a 强制；L2 可由事项负责人开启——机构名称也替换为代号）
      if (body.full_pseudonym !== undefined) {
        if (typeof body.full_pseudonym !== "boolean") throw validation("full_pseudonym 须为布尔值");
        fields.push(`full_pseudonym = ?`);
        values.push(body.full_pseudonym ? 1 : 0);
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
      // 策略类变更（密级、四项依据、同意状态、端点、协作范围、全部化名、当事人）递增策略版本，并作废该事项尚未作废的出站批准——
      // 进行中的运行须按新策略重新确认（复核 S5-B02；闸门另按凭据里的策略版本独立核对）
      const POLICY_FIELDS = ["confidentiality", "basis", "consent_status", "model_endpoint", "collab_scope", "full_pseudonym", "client_name", "counterparty"];
      const policyChange = POLICY_FIELDS.some((f) => body[f] !== undefined) || basisReopened;
      if (policyChange) fields.push(`policy_version = policy_version + 1`);
      db.run(`UPDATE matters SET ${fields.join(", ")} WHERE matter_id = ?`, [...values, matter.matter_id]);
      // 审批相关字段（审批策略指纹的组成）变化才作废批准；当事人（词典）变化只影响令牌化，不作废（复核 S5-B18）
      const APPROVAL_FIELDS = ["confidentiality", "basis", "consent_status", "model_endpoint", "collab_scope", "full_pseudonym"];
      if (APPROVAL_FIELDS.some((f) => body[f] !== undefined) || basisReopened) deps.approvals?.revokeMatter(matter.matter_id);
      // 事项匿名摘要随策略变化重新上报（摘要不变不排队）
      if (policyChange) {
        deps.governance?.enqueueSummary(matter.matter_id);
        void deps.controlPlane?.pushSummaries().catch(() => {});
      }
      // 审计只记变更了哪些字段（当事人名称等低熵内容不进摘要；同阶段 4 审查 S4-14 口径）
      // 只改端点触发的四项依据自动改写同样记入审计（复核 A 第二次复核建议）
      audit(db, id, "matter.update", "matter", matter.matter_id, sha256Hex(JSON.stringify({ fields: Object.keys(body).sort(), ...(basisReopened ? { basis_reopened: "subprocessor" } : {}) })), keyctx);
      return {
        matter: matterOut(db.get(`SELECT * FROM matters WHERE matter_id = ?`, [matter.matter_id])),
        note: `关键口径变更已记录（审计事件已入签名链）；策略事件的签发人角色签名在同步阶段接入${basisReopened ? "。改用有第三方处理者的端点后，“转委托与次处理者”已改为待确认，请核实后补录" : ""}`,
      };
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
      const result = await insertDocumentWithParse({
        matterId: matter.matter_id,
        tenantId: id.tenantId,
        filename,
        bytes,
        mime: String(p?.mime ?? "application/octet-stream"),
        storageMode: "import",
        storageUri: () => blobs.put(bytes, matter.matter_id).storage_uri,
        sha256,
        uploadedBy: id.userId,
        identity: id,
      });
      audit(db, id, "materials.import", "document", result.document_version_id, sha256, keyctx);
      return { ...result, sha256, note: "导入副本进入内容寻址块（不可变）；纠错请上传新版本" };
    },

    /** 材料用途（v9.2 Y4 §5 D-4）：我方 / 对方 / 参考，或清除；写入 A1 材料快照清单。审计只记用途类别。 */
    "materials.set_role": (p, id) => {
      const docId = String(p?.document_version_id ?? "");
      const doc = db.get<{ matter_id: string }>(`SELECT matter_id FROM document_versions WHERE document_version_id = ?`, [docId]);
      if (!doc) throw notFound("材料");
      requireMatterAccess(db, doc.matter_id, id);
      requireMatterWriter(db, doc.matter_id, id);
      const role = p?.role ?? null;
      if (role !== null && role !== "ours" && role !== "theirs" && role !== "reference") throw validation("用途须为 ours / theirs / reference 或 null");
      if (role === null) db.run(`DELETE FROM document_roles WHERE document_version_id = ?`, [docId]);
      else
        db.run(
          `INSERT INTO document_roles (document_version_id, matter_id, role, set_by) VALUES (?,?,?,?)
           ON CONFLICT (document_version_id) DO UPDATE SET role = excluded.role, set_by = excluded.set_by, set_at = CURRENT_TIMESTAMP`,
          [docId, doc.matter_id, role, id.userId],
        );
      audit(db, id, "materials.set_role", "document", docId, sha256Hex(JSON.stringify({ role })), keyctx);
      return { document_version_id: docId, role };
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
        identity: id,
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
      if (doc.quarantined_at) throw new DomainError("conflict", "该材料已隔离（带国家秘密标志），不能重新解析", 409);
      const parsed = await parseAny(bytes, String(doc.filename), String(doc.mime));
      // 重新解析（例如 OCR 就绪后）才看到密级标志（复核 B3-A05）：不只拒绝新解析版本——隔离该材料：删除导入副本块、全部解析文本与派生内容，
      // 登记行标为已隔离（不能再被选入任务、交给工具或预览）；挂载原件在律师自己的文件夹里，由律师按涉密载体规定线下处理
      let reparseNotice: string | null;
      try {
        reparseNotice = classifiedGate(doc.matter_id, String(doc.filename), String(doc.mime), bytes, parsed.text, String(doc.sha256), id);
      } catch (e) {
        if ((e as DomainError)?.code !== "classified_material") throw e;
        await quarantineDocument(doc, "state_secret_marking", id);
        throw new DomainError(
          "classified_material",
          `重新解析发现该文件带有国家秘密标志（${(e as DomainError).detail?.level ?? ""}★）：已隔离——本产品保存的副本、解析文本与据此产生的风险卡和事实已删除，不能再用于任务。` +
            (doc.storage_mode === "mount" ? "挂载的原件仍在你的文件夹里，请按涉密载体管理规定线下处理。" : "请按涉密载体管理规定线下处理原件。"),
          422,
          { ...((e as DomainError).detail ?? {}), quarantined: true },
        );
      }
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
        marking_notice: reparseNotice,
        note: `已生成新解析版本（原件未修改，hash 一致；旧解析版本保留）。${ocrReady({ ocrModelPaths, mockOcr: parseMock }) ? "" : "本机 OCR 未就绪：扫描/图片页按 unreadable 标记，未伪造文本。"}`,
      };
    },

    // ─── 当事人告知函（v9 第 05 篇“四项依据”：任一项待确认时可一键生成告知函；措辞按第 02 篇 §12 对外口径；回执由律师线下取得后在事项头更新四项依据） ───
    // —— 事项数据生命周期（用户 10-13 指令“数据生命周期管理”；迁移 0021）——
    // 结案 → 保留期（默认 10 年，可设 1–30 年）→ 删除（密码学擦除 + 签名回执）；法律保全期间不得删除。均须事项负责人。
    "matters.lifecycle": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      const lc = lifecycleOf(db, matter.matter_id);
      return { lifecycle: lc, retention_years: RETENTION_YEARS, receipt: lc.lifecycle === "purged" ? receiptView(matter.matter_id) : null };
    },

    "matters.close": async (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterOwner(db, matter.matter_id, id, "结案需要事项负责人角色");
      const out = await closeMatter(lifecycleDeps(), matter.matter_id, p?.retention_years);
      audit(db, id, "matter.closed", "matter", matter.matter_id, sha256Hex(String(out.lifecycle.retention_until)), keyctx);
      return out;
    },

    "matters.reopen": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterOwner(db, matter.matter_id, id, "重新打开需要事项负责人角色");
      const lc = reopenMatter(lifecycleDeps(), matter.matter_id);
      audit(db, id, "matter.reopened", "matter", matter.matter_id, undefined, keyctx);
      return { lifecycle: lc };
    },

    "matters.hold": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterOwner(db, matter.matter_id, id, "设置或解除法律保全需要事项负责人角色");
      const on = p?.on === true;
      const lc = setLegalHold(lifecycleDeps(), matter.matter_id, on, p?.reason);
      audit(db, id, on ? "matter.legal_hold_set" : "matter.legal_hold_cleared", "matter", matter.matter_id, on ? sha256Hex(String(lc.legal_hold_reason)) : undefined, keyctx);
      return { lifecycle: lc };
    },

    "matters.purge": async (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterOwner(db, matter.matter_id, id, "删除事项数据需要事项负责人角色");
      await purgeMatter(lifecycleDeps(), matter.matter_id, {
        by: id.userId,
        confirm_title: p?.confirm_title,
        early: p?.early,
        reason: p?.reason,
        // 删除清单摘要进签名的删除审计事件（同一事务）：链复核据此区分“按清单清除”与篡改
        audit: (digest) => audit(db, id, "matter.purged", "matter", matter.matter_id, digest, keyctx),
      });
      return { lifecycle: lifecycleOf(db, matter.matter_id), receipt: receiptView(matter.matter_id) };
    },

    // 结案归档导出（第 02 篇 §9.13 开放格式；services/matter-archive.ts）：含案卷原文，只由事项负责人发起并记审计
    "matters.archive": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterOwner(db, matter.matter_id, id, "导出结案归档需要事项负责人角色");
      assertNotRevokedForExport("导出归档");
      const out = buildMatterArchive(
        {
          db,
          blobs,
          tokens: tokens ?? null,
          deviceId: keyctx.device.deviceId,
          signer: keyctx.device.signer,
          deviceCert: keyctx.device.cert,
          firmRootPublicKeyPem: keyctx.firm.rootPublicKeyPem,
        },
        matter.matter_id,
        { by: id.userId },
      );
      // 桌面客户端：内核直接写到律师在系统对话框里选定的位置（不经渲染进程与浏览器下载；Y5 P1-4）
      // 写成功之后才记“已导出归档”（复核 R15A-06：离所交接清单按这条审计判定，写失败不能显示成已导出）
      const saved = p?.save_path ? writeExportFile(String(p.save_path), out.zip, config.workspaceDir) : null;
      audit(db, id, "matter.archive_exported", "matter", matter.matter_id, sha256Hex(out.zip), keyctx);
      return {
        filename: saved?.name ?? out.filename,
        ...(saved ? { saved: true } : { data_base64: out.zip.toString("base64") }),
        bytes: out.zip.length,
        sha256: sha256Hex(out.zip),
        counts: out.manifest.counts,
        missing: out.manifest.missing,
      };
    },

    "matters.deletion_receipt": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      const r = receiptView(matter.matter_id);
      if (!r) throw notFound("删除回执");
      return r;
    },

    "matters.consent_notice": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      // 写入告知函成果：须有写权限，结案事项只读（复核 C-B12）
      requireMatterWriter(db, matter.matter_id, id);
      const client = matter.client_name ?? "（当事人）";
      const report = docxRenderReport(blobs, {
        title: "关于使用人工智能辅助工具处理委托事项的告知函",
        sections: [
          {
            heading: "一、拟使用的工具与处理方式",
            paragraphs: [
              `尊敬的 ${client}：`,
              `就「${matter.title}」事项，本所拟使用 Kimi Work 法律行业发行版（人工智能辅助工具）协助处理相关材料。`,
              "案卷默认在本所律师的电脑上处理和保存。调用模型时，模型会收到任务涉及的文档内容，其中证件号、账号、手机号、住址和自然人姓名在发送前替换为代号，机构名称保留（可应您要求对本事项开启全部化名）；请求经中软国际法律模型网关转至 Kimi 大模型（月之暗面），网关不落盘，上游留存以企业协议为准。",
              "联网检索默认只发出令牌化并去除已知当事人名称的查询；含当事人名称的查询须经办律师逐条确认，确认后可按原文发出（保留机构当事人名称；已识别的自然人姓名与证件、账号不发出）。识别可能遗漏，每一次出站均有记录可查。",
            ],
          },
          {
            heading: "二、处理者、数据去向与您的选择",
            paragraphs: [
              "受托与转委托：中软国际作为受托方处理推理与检索的过境数据，Kimi 大模型由月之暗面提供（转委托）；次处理者清单可应您要求提供。",
              "每一次向外发送均有逐条记录（数据去向卡），本所可应您要求出示。",
              "如事项涉及敏感个人信息（如医疗健康、金融账户、行踪轨迹、未满十四周岁未成年人的信息），本所将在处理前另行取得您的单独同意，并对该事项启用全部化名与逐条确认的检索。",
              "您可以拒绝云端处理或拒绝使用人工智能：本所将仅使用本机能力（整理、比对、脱敏、法条核验、文书生成）或（如已部署）本所私有模型处理您的事项，可能带来质量与时效差异，本所将如实说明。",
            ],
          },
          {
            heading: "三、回执",
            paragraphs: [
              "请勾选并签署：□ 同意按上述方式处理；□ 同意，但要求全部化名（机构名称同样替换为代号）；□ 拒绝云端处理（仅本机能力或本所私有模型）；□ 不同意使用人工智能处理本事项。",
              "签署人：＿＿＿＿＿＿＿＿　日期：＿＿＿＿年＿＿月＿＿日",
              "（本函由系统按模板生成，发出前须经经办律师复核；模板版本 consent-notice-v9.2，批量告知与回执管理在 G1 管理控制台提供）",
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
          JSON.stringify({ template: "consent-notice-v9.2", note: "模板生成，发出前须律师复核；回执取得后请在事项头更新四项依据" }),
          id.userId,
        ],
      );
      audit(db, id, "matter.consent_notice", "matter", matter.matter_id, report.sha256, keyctx);
      return { artifact_version_id: artifactId, filename: `当事人告知函-${matter.title.slice(0, 20)}-v${v.next}.docx`, sha256: report.sha256, note: "告知函已生成（草稿）；回执取得后请在事项头的四项依据中更新（客户已同意的，将“委托/保密授权”与“转委托与次处理者”改为已确认）" };
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
        const q = db.get<{ quarantined_at: string | null }>(`SELECT quarantined_at FROM document_versions WHERE document_version_id = ?`, [docId]);
        if (q?.quarantined_at) throw new DomainError("conflict", "所选材料中有已隔离的材料（带国家秘密标志），不能用于任务", 409, { document_version_id: docId });
        const r = db.get<{ page_count: number | null }>(
          `SELECT page_count FROM parse_versions WHERE document_version_id = ? ORDER BY created_at DESC LIMIT 1`,
          [docId],
        );
        pages += r?.page_count ?? 0;
      }
      const est = estimatePoints({ scenario: p.scenario, material_count: docIds.length, total_pages: pages });
      if (est.points === 0 && !est.local) throw validation(est.assumptions[0] ?? "不可估价");
      const estimateId = newId("estimate");
      estimates.set(estimateId, { estimate_id: estimateId, matter_id: matterId, scenario: p.scenario, points: est.points, expires: Date.now() + est.valid_seconds * 1000, input: p });
      // 数据去向预览（§15.2：先预估、后确认——预计点数与数据去向同时展示）。按强制点的实际结果生成（复核 S5-A08）：不会发送时写“不会发送：原因”
      const endpointLabels: Record<string, string> = {
        standard: "Kimi AI（经中软安全通道）",
        byok: "Kimi AI（律所自己的账号，直连月之暗面，不经中软）",
        private: "律所自己的 AI（不经中软）",
        none: "不用 AI（只用本机功能）",
      };
      const usesModel = p.scenario === "s1.contract_review" || p.scenario === "a1.agent_task";
      const level = dataLevelOf(matter.confidentiality, matter.consent_status);
      // 退出模式（许可到期或未取得、本设备被吊销；第 02 篇 §10）：新任务不可用
      const exitMode = deps.governance?.exitMode() ?? null;
      const blockReason = modelBlockReason(matter);
      const busy = p.scenario === "a1.agent_task" ? liveAgentRunOf(db, matterId) : null;
      const busyMessage = busy ? `这个事项里还有一个任务在进行${busy.goal ? `（“${busy.goal}”）` : ""}。请等它完成，或在它的执行页取消后再开始；也可以先在其他事项里开始任务` : null;
      // 如实写明按原文发送的类别与上游留存口径（隐私安全增量评审 §3 P0-3：预览不能只说“替换了什么”）
      const plainNote =
        level === "L3a" || matter.full_pseudonym === 1
          ? "以原文发送的有：案情事实、金额、日期与条款文字（未能识别的姓名也会以原文发送）"
          : "以原文发送的有：机构名称、案情事实、金额、日期、条款文字与案号（未能识别的姓名也会以原文发送）";
      const retentionNote =
        matter.model_endpoint === "private"
          ? "律所自己的 AI，是否保存由律所决定"
          : matter.model_endpoint === "byok"
            ? "AI 服务方是否保存，以律所与厂商的协议为准"
            : "AI 服务方是否保存，以其企业协议为准（协议状态见“设置 → 数据去向说明”）";
      const pseudonymScope =
        level === "L3a" || matter.full_pseudonym === 1
          ? "证件、账户、联系方式、自然人姓名与机构名称在发送前全部替换为代号（全部化名）"
          : "证件、账户、联系方式与自然人姓名在发送前替换为代号，机构名称保留";
      const searchNote =
        p.scenario !== "a1.agent_task"
          ? ""
          : level === "L3b"
            ? "；不联网检索（客户要求不上云）"
            : level === "L3a"
            ? "；联网检索只发改写后的一般性查询，每一条都先问你"
            : "；联网检索默认先把姓名证件换成代号、去掉已知当事人名称再发出；要带当事人名称查时须你逐条确认，确认后可按原文发出（保留机构当事人名称；已识别的自然人姓名与证件、账号不发出）";
      // “将发送什么”（v9.2 §3.3–3.4；P1-10、P1-11 ③）：同一套事项令牌化器离线预跑（不出站、不写回令牌表），给出替换计数与疑似未替换的姓名；
      // L3a 事项还有未核对的疑似姓名时不能发起（发起时内核再核一次）
      let sendSummary: SendSummary | null = null;
      if (usesModel && !exitMode && !blockReason && tokens && level !== "L3b") {
        sendSummary = summarizeSend(db, tokens, matterId, docIds, String(p?.goal ?? ""), level === "L3a" || matter.full_pseudonym === 1, { fullScan: level === "L3a", extraTexts: [String(matter.stance ?? ""), String(matter.jurisdiction ?? "")] }).summary;
      }
      const suspectsBlock = level === "L3a" && (sendSummary?.suspects.unreviewed ?? 0) > 0;
      // 律师先看的几句短话（v9.4 认知减负：确认卡默认只显示要点，完整说明 preview 收进“完整说明”）。口径与 preview 一致，不另立规则；
      // 复核 Q1-11：要点不能只说“替换了什么”——按原文发送的类别、没认出的姓名按原文发、服务方是否保存，都要在要点里（隐私安全增量评审 P0-3）
      const route: Record<string, string> = { standard: "发给 Kimi AI（经中软转发）", byok: "发给律所自己的 Kimi 账号（不经中软）", private: "发给律所自己的 AI（不经中软）", none: "不使用 AI" };
      const fullPseudonym = level === "L3a" || matter.full_pseudonym === 1;
      const bullets: string[] = exitMode
        ? [`不会发送：${exitMode.message}`]
        : !usesModel
          ? ["全部在这台电脑上完成，不发送任何内容"]
          : blockReason
            ? [`不会发送：${blockReason}`]
            : [
                `${route[matter.model_endpoint] ?? "发给 AI"}：${docIds.length ? `${docIds.length} 份材料里用到的内容` : "任务说明和用到的材料"}`,
                fullPseudonym ? "姓名、公司名、证件号、账号先换成代号" : "姓名、证件号、账号、电话先换成代号",
                fullPseudonym ? "案情、金额、日期、条款按原文；没认出的姓名也按原文" : "公司名、案情、金额、日期、条款按原文；没认出的姓名也按原文",
                ...(p.scenario !== "a1.agent_task" ? [] : level === "L3b" ? ["不联网检索"] : level === "L3a" ? ["联网检索每一条都先问你"] : ["联网检索先去掉当事人名称；要带名称查时逐条问你"]),
                `${matter.model_endpoint === "private" ? "是否保存由律所决定" : "服务方是否保存，以其企业协议为准"}；每次发送都有记录`,
              ];
      const dataWhere = {
        model_endpoint: matter.model_endpoint,
        consent_status: matter.consent_status,
        bullets,
        ...(sendSummary ? { send_summary: sendSummary } : {}),
        preview: exitMode
          ? `不会发送：${exitMode.message}`
          : !usesModel
            ? "全部在这台电脑上完成：不用 AI，不发送任何内容"
            : blockReason
              ? `不会发送：${blockReason}`
              : `将发送：${docIds.length ? `${docIds.length} 份文档中任务涉及的内容` : "任务说明与按需读取的材料内容"}→ ${endpointLabels[matter.model_endpoint] ?? matter.model_endpoint}；${pseudonymScope}；${plainNote}${searchNote}；${retentionNote}；每一次发送都记在本任务的“数据去向”里`,
        warning: exitMode
          ? exitMode.message
          : busyMessage
            ? busyMessage
          : suspectsBlock
            ? `这是敏感事项：发送前还有 ${sendSummary!.suspects.unreviewed} 处像姓名的文字没有换成代号，请先逐个核对（是姓名的加入当事人名单）再开始`
          : usesModel && blockReason
            ? p.scenario === "a1.agent_task"
              ? `${blockReason}。开放任务离不开模型：补齐后才能发起`
              : `${blockReason}；可在事项头补录依据，或一键生成告知函`
            : null,
        // 开放任务在模型被拦截时无法运行；退出模式下任何新任务都不能发起：界面据此禁用“确认发起”
        start_blocked: !!exitMode || !!busy || suspectsBlock || (usesModel && !!blockReason && p.scenario === "a1.agent_task"),
        // 阻断原因的类别：界面据此给出对应的修复入口（只有 consent 才是“记录客户同意”）
        block_kind: exitMode ? "exit_mode" : busy ? "busy" : usesModel && !!blockReason && p.scenario === "a1.agent_task" ? "consent" : suspectsBlock ? "suspects" : null,
        ...(busy ? { busy_run_id: busy.run_id } : {}),
        caps: { per_request_chars: 200_000, per_task_chars: 1_000_000 },
      };
      return { estimate_id: estimateId, ...est, points_display: est.local ? "不调用 AI，不计点" : `预计 ${est.points} 点`, data_where: dataWhere };
    },

    "runs.start": async (p, id) => {
      const matterId = String(p?.matter_id ?? "");
      const matter = requireMatterAccess(db, matterId, id);
      requireMatterWriter(db, matter.matter_id, id);
      // 退出模式（第 02 篇 §10：许可到期或未取得、本设备被吊销）：阅读与导出照常，新任务不可用
      const exitMode = deps.governance?.exitMode();
      if (exitMode) throw new DomainError("exit_mode", exitMode.message, 403);
      if (!p?.estimate_id) throw validation("需要 estimate_id");
      // 网关二次检查需要该事项的匿名摘要（阶段 6）：发起前尽量送达（短超时；失败不阻断——摘要尚未到达的事项网关按请求头检查，D-34）
      if (deps.controlPlane) await deps.controlPlane.ensureSummary(matterId).catch(() => false);
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
      const cap = scenarioCap(est.scenario);
      // 本机流程不计点（10-23 拍板）：预留与实扣都是 0，忽略界面带来的 budget_points
      const budgetCap = cap === 0 ? 0 : Number(p?.budget_points ?? est.points);
      if (cap > 0 && (budgetCap <= 0 || budgetCap > cap)) throw validation(`budget_points 超出单任务上限 ${cap}`);

      // 幂等：同键同内容返回原任务（§15.2）
      const existing = db.get(`SELECT run_id, status, input_snapshot FROM runs WHERE tenant_id = ? AND idempotency_key = ?`, [id.tenantId, String(p.idempotency_key)]);
      if (existing) {
        const same = parseJson<any>((existing as any).input_snapshot, {})?.estimate_id === est.estimate_id;
        if (!same) throw new DomainError("conflict", "幂等键已用于其他任务内容", 409);
        return { run_id: (existing as any).run_id, status: (existing as any).status, idempotent_replay: true };
      }

      // 运行模式、先出计划与预授权（W1；第 02 篇 §9.3）：只接受事项策略允许的档位与预授权（界面只显示允许的档位）；宿主再按渠道上限钳制
      let runOptions: Record<string, unknown> | undefined;
      // null 与未给出同义（复核 C-B01：null 曾绕过“追问沿用上一轮档位”）
      if (p && p.mode === null) delete p.mode;
      if (p?.mode !== undefined || p?.plan_first !== undefined || p?.preauthorizations !== undefined) {
        const pol = deps.matterPolicy?.(matterId);
        const mode = p?.mode ?? "default";
        if (!["chat", "manual", "default", "auto"].includes(mode)) throw validation("mode 须为 chat / manual / default / auto");
        if (pol && MODE_RANK[mode]! > MODE_RANK[pol.maxMode]!) throw validation(`该档位超出律所或事项策略的上限（最高：${pol.maxMode}）`);
        const pre = Array.isArray(p?.preauthorizations) ? p.preauthorizations.map(String) : [];
        if (pre.length > 0 && mode !== "auto") throw validation("只有“自动”档可以在开始时预授权");
        if (pol && pre.some((x: string) => !pol.allowedPreauthorizations.includes(x as never))) throw validation("预授权超出事项策略允许的范围");
        runOptions = { mode, plan_first: mode === "chat" ? false : p?.plan_first !== false, preauthorized: pre };
      }

      // 方法模板（首页业务场景卡；UIUX P0-2 / Demo 融合 §4）：只接受已验签安装的模板，Agent 按模板执行
      let skill: string | undefined;
      if (p?.skill !== undefined && p?.skill !== null && p?.skill !== "") {
        if (est.scenario !== "a1.agent_task") throw validation("方法模板只用于 Agent 任务");
        const installed = deps.skills?.ok ? deps.skills.skills.map((x) => x.id) : [];
        if (typeof p.skill !== "string" || !installed.includes(p.skill)) throw validation("方法模板不存在或未安装（请在“方法与模板”页查看可用模板）");
        skill = p.skill;
      }
      // 场景卡字段作为方法参数显式传给 Agent（v9.4 S1 §6.2 第 10 项：原来只拼进任务说明的文字里，真实模型可能读不到）。
      // 只收简单键值：≤ 8 项，键为小写字母与下划线，值为字符串（多选用“、”连接），每项 ≤ 300 字
      let skillArgs: Record<string, string> | undefined;
      if (p?.skill_args !== undefined && p?.skill_args !== null) {
        if (!skill) throw validation("方法参数只能和方法模板一起使用");
        if (typeof p.skill_args !== "object" || Array.isArray(p.skill_args)) throw validation("skill_args 须为对象");
        const entries = Object.entries(p.skill_args as Record<string, unknown>);
        if (entries.length > 8) throw validation("方法参数至多 8 项");
        skillArgs = {};
        for (const [k, v] of entries) {
          if (!/^[a-z][a-z_]{0,31}$/.test(k)) throw validation(`方法参数名不合法：${k}`);
          const val = Array.isArray(v) ? v.map(String).join("、") : typeof v === "string" ? v : null;
          if (val === null) throw validation(`方法参数 ${k} 须为文字`);
          if ([...val].length > 300) throw validation(`方法参数 ${k} 超过 300 字`);
          if (val.trim()) skillArgs[k] = val.trim();
        }
        if (Object.keys(skillArgs).length === 0) skillArgs = undefined;
      }

      // 示例事项不能存审查要点：从范本整理的任务在开始前就拒绝，免得跑完才在最后一步失败（复核 Q5-03）
      if (skill === "review-rules-draft") assertNotSample(db, matter.matter_id, "从范本整理审查要点");
      // 本事项的审查要点（v9.4 第 22 批，C1 #21）：审合同、回稿重审、起草合同的任务缺省按在用的那一版（快照，之后改要点不影响本任务）；
      // review_rules:false 为本次不用。我的写作偏好（C1 #29）：Agent 任务都带上（快照）
      if (p?.review_rules !== undefined && p?.review_rules !== null && typeof p.review_rules !== "boolean") throw validation("review_rules 须为 true / false");
      // 追问在原会话上继续，模型已看过原任务的要点：一律沿用原任务的快照，不能另选（复核 Q4-08）
      if (typeof p?.followup_of === "string" && p.followup_of && p?.review_rules !== undefined && p?.review_rules !== null) throw validation("追问沿用原任务的审查要点，不能另选；要换要点请重新发起任务");
      const rulesActive = skill && RULES_SKILLS.includes(skill) && p?.review_rules !== false ? activeRules(db, matter.matter_id) : null;
      if (p?.review_rules === true && !rulesActive) throw validation(skill && RULES_SKILLS.includes(skill) ? "这个事项还没有在用的审查要点" : "这个方法不按审查要点审");
      let rulesSnap: RulesSnapshot | null = rulesActive ? snapshotOf(rulesActive) : null;
      const prefsNow = est.scenario === "a1.agent_task" ? getWritingPrefs(db, id.tenantId, id.userId) : null;
      const prefsSnap = prefsNow && hasPrefs(prefsNow) ? prefsNow : null;

      // 追问（集成核查 P1-1）：在本事项、本人发起、已完成的上一次 Agent 运行的会话上继续
      let followup: { followup_of: string; continue_session_id: string } | undefined;
      let followupModeRaised: string | null = null;
      if (typeof p?.followup_of === "string" && p.followup_of) {
        if (est.scenario !== "a1.agent_task") throw validation("只有 Agent 任务可以追问");
        const prev = db.get<{ run_id: string; matter_id: string; scenario: string; status: string; created_by: string; input_snapshot: string | null }>(
          `SELECT run_id, matter_id, scenario, status, created_by, input_snapshot FROM runs WHERE run_id = ?`,
          [p.followup_of],
        );
        if (!prev || prev.matter_id !== matterId) throw notFound("上一次任务");
        if (prev.scenario !== "a1.agent_task" || !["succeeded", "partial"].includes(prev.status)) throw validation("只能在已完成的 Agent 任务上追问");
        if (prev.created_by !== id.userId) throw forbidden("只能追问自己发起的任务");
        const started = db.all<{ payload: string }>(`SELECT payload FROM run_events WHERE run_id = ? AND type = 'agent.started' ORDER BY seq DESC LIMIT 1`, [prev.run_id])[0];
        const sid = started ? parseJson<any>(started.payload, {})?.session_id : null;
        if (typeof sid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(sid)) throw validation("上一次任务没有可继续的对话记录，请新建任务");
        followup = { followup_of: prev.run_id, continue_session_id: sid };
        // 追问在原会话上继续，模型看到的是原任务那一版要点：沿用原任务的快照（之后改过要点也不换），“要点 n”的核对才对得上
        const prevRules = parseJson<any>(prev.input_snapshot, {})?.review_rules;
        rulesSnap = !prevRules || typeof prevRules !== "object" ? null : (prevRules as RulesSnapshot);
        // 档位沿用上一轮（复核 B3-B09）：律师选过“问答（只读）”，追问不能静默变成可写；要提高档位须明确选择（mode_raise_confirmed）并留痕
        const prevMode = runModeOf(prev.input_snapshot);
        if (p?.mode === undefined) {
          // 沿用上一轮档位，但不高于事项策略当前的上限（复核 C-B02：策略在两轮之间收紧时取更严者）
          const pol = deps.matterPolicy?.(matterId);
          const inherited = pol && MODE_RANK[prevMode]! > MODE_RANK[pol.maxMode]! ? pol.maxMode : prevMode;
          runOptions = { mode: inherited, plan_first: false, preauthorized: [] };
        } else if (MODE_RANK[String(p.mode)]! > MODE_RANK[prevMode]!) {
          if (p?.mode_raise_confirmed !== true) {
            throw validation(`追问默认沿用上一轮的档位（${prevMode}）；要提高到 ${p.mode} 请在追问框旁明确选择`, { previous_mode: prevMode, requested_mode: p.mode });
          }
          followupModeRaised = `${prevMode}->${p.mode}`;
        }
      }

      // 开放任务离不开模型：发起时按当前事项状态再核一次（复核 C-B13：估价之后依据可能变了，界面的禁用也可能被绕过）。
      // 放在请求参数校验（档位、预授权、模板、追问）之后：参数错先报参数错
      if (est.scenario === "a1.agent_task") {
        const br = modelBlockReason(matter);
        if (br) throw validation(`${br}。开放任务离不开模型：补齐后才能发起`, { start_blocked: true });
      }
      // 同一事项同时只运行一个 Agent 任务（宿主按事项划定执行域取消与路由，审查 S3-16）：发起前如实拒绝，不受理后再失败。
      // 放在幂等重放与参数、追问条件校验之后：更具体的原因先报
      // L3a 事项：疑似未替换的姓名核对完才能发起（估价之后材料或名单可能变了，界面的禁用也可能被绕过）
      if ((est.scenario === "a1.agent_task" || est.scenario === "s1.contract_review") && tokens && dataLevelOf(matter.confidentiality, matter.consent_status) === "L3a") {
        // 方法参数也会发给模型（v9.4 复核 Q1-08）：一并核对，不假设前端已把它们拼进任务说明
        const s = summarizeSend(db, tokens, matterId, (est.input.document_version_ids as string[] | undefined) ?? [], String(p?.goal ?? est.input.goal ?? ""), true, { fullScan: true, extraTexts: [String(matter.stance ?? ""), String(matter.jurisdiction ?? ""), ...Object.values(skillArgs ?? {})] }).summary;
        if (s.suspects.unreviewed > 0) throw validation(`这是敏感事项：还有 ${s.suspects.unreviewed} 处像姓名的文字没有核对，核对完才能开始`, { start_blocked: true, block_kind: "suspects" });
      }
      if (est.scenario === "a1.agent_task") {
        const busy = liveAgentRunOf(db, matterId);
        if (busy) throw new DomainError("conflict", `这个事项里还有一个任务在进行${busy.goal ? `（“${busy.goal}”）` : ""}。请等它完成，或在它的执行页取消后再开始`, 409, { run_id: busy.run_id });
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
          JSON.stringify({ ...est.input, estimate_id: est.estimate_id, goal: p?.goal, topic_hint: p?.topic_hint ?? est.input.topic_hint, ...(runOptions ? { run_options: runOptions } : {}), ...(skill ? { skill, ...skillSnapshot(deps.skills, skill) } : {}), ...(skillArgs ? { skill_args: skillArgs } : {}), ...(rulesSnap ? { review_rules: rulesSnap } : {}), ...(prefsSnap ? { writing_prefs: prefsSnap } : {}), ...(followup ?? {}) }),
          Math.min(est.points, budgetCap),
          Math.min(est.points, budgetCap),
          est.estimate_id,
          id.userId,
        ],
      );
      queue.enqueue(runId);
      if (followupModeRaised) audit(db, id, "run.followup_mode_raised", "run", runId, sha256Hex(followupModeRaised), keyctx);
      return { run_id: runId, status: "queued", points_reserved: Math.min(est.points, budgetCap) };
    },

    "runs.get": (p, id) => {
      const run = requireRunAccess(db, String(p?.run_id ?? ""), id);
      const artifacts = db
        .all<Record<string, unknown>>(
          `SELECT artifact_version_id, kind, version, audience, status, filename, sha256, created_at, storage_uri
             FROM artifact_versions WHERE run_id = ? ORDER BY created_at`,
          [run.run_id],
        )
        .map(({ storage_uri, ...r }) => ({ ...r, title: artifactTitle(String(r.artifact_version_id), String(r.filename), String(storage_uri)) }));
      // 在途出站（闸门已预写、尚未补全的去向记录）：执行位置徽标据此显示“模型推理中/联网检索中”，不靠推断（复核 S5-A04）
      const open = db.all<{ destination_kind: string; n: number }>(
        `SELECT destination_kind, COUNT(*) AS n FROM egress_records WHERE run_id = ? AND completed = 0 AND outcome = 'sent' GROUP BY destination_kind`,
        [run.run_id],
      );
      const inflight = { model: 0, search: 0, fetch: 0 };
      for (const o of open) {
        if (o.destination_kind === "search_service") inflight.search += o.n;
        else if (o.destination_kind === "public_web") inflight.fetch += o.n;
        else inflight.model += o.n;
      }
      // 结果不明的副作用调用（对账中/失败后）：界面逐项让律师确认“已完成 / 未完成”（runs.reconcile），再“重新运行”（runs.retry）
      const unresolved_operations =
        run.status === "reconciling" || run.status === "failed"
          ? db.all(`SELECT tool_operation_id, tool, operation, status, created_at FROM tool_operations WHERE run_id = ? AND status IN ('pending','unknown') ORDER BY created_at`, [run.run_id])
          : [];
      // is_mine：追问只对发起人显示（复核 B3-B13；内核同样只接受发起人追问）
      return { run: { ...runOut(run), is_mine: run.created_by === id.userId }, artifacts, inflight, unresolved_operations };
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
      assertNotExitMode("转交节点");
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterWriter(db, matter.matter_id, id);
      const scenario = String(p?.scenario ?? "");
      if (!SCENARIOS.has(scenario)) throw validation(`scenario 须为 ${[...SCENARIOS].join(" / ")}`);
      if (dataLevelOf(matter.confidentiality, matter.consent_status) === "L3b") throw forbidden("当事人限制（L3b）的事项不得转交节点（只在成员电脑上运行）");
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
          syncExport(syncDepsOf(id), { shareDir: config.syncShareDir, matterId: matter.matter_id });
          inlineExported = true;
        } catch (e) {
          slog.event("KERNEL_NODE_ENQUEUE_EXPORT_FAILED", errFields(e));
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
        if (dataLevelOf(matter.confidentiality, matter.consent_status) === "L3b") throw forbidden("当事人限制（L3b）的事项不得配置节点定时任务");
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

    /**
     * 人工对账（v9 第 04 篇 §8“副作用结果不明进入人工对账，不盲目重发”；阶段 1 审查 R-07）：
     * 律师逐项确认结果不明（pending/unknown）的副作用工具调用“已生效 / 未生效”。已生效 → 记为 succeeded（重放时不再执行）；
     * 未生效 → 记为 failed（重试时可再次执行）。全部对账完毕后，任务由 reconciling 经 CAS 迁到 failed（可经 runs.retry 重新排队），
     * 已生效的调用在重试中按幂等键直接返回——不重复产生副作用。
     */
    "runs.reconcile": (p, id) => {
      const runId = String(p?.run_id ?? "");
      requireRunAccess(db, runId, id);
      requireMatterWriter(db, db.get(`SELECT matter_id FROM runs WHERE run_id = ?`, [runId]).matter_id, id, { allowClosed: true });
      const opId = String(p?.tool_operation_id ?? "");
      const resolution = String(p?.resolution ?? "");
      if (resolution !== "applied" && resolution !== "not_applied") throw validation("resolution 须为 applied 或 not_applied");
      // 只在没有尝试执行时对账：执行中的 pending 可能是正在进行的合法调用，人工结论会与真实结果打架
      const before = (db.get(`SELECT status FROM runs WHERE run_id = ?`, [runId]) as any).status as string;
      if (before !== "reconciling" && !TERMINAL_RUN_STATUSES.includes(before as RunStatus)) {
        throw new DomainError("conflict", `任务当前为 ${before}，执行中不能人工对账（待其进入 reconciling 或终态）`, 409);
      }
      // 调用结论与任务迁移同一事务（reconciling → failed 用 CAS）
      return db.tx(() => {
        const op = db.get<{ status: string; tool: string }>(`SELECT status, tool FROM tool_operations WHERE tool_operation_id = ? AND run_id = ?`, [opId, runId]);
        if (!op) throw new DomainError("not_found", "工具调用记录不存在", 404);
        // 复审 R-07：执行尚未返回的调用不能人工对账（人工结论会与真实结果打架）
        if (isToolOperationInFlight(opId)) throw new DomainError("conflict", "该调用仍在执行中，待其返回或被中止后再对账", 409);
        if (op.status !== "pending" && op.status !== "unknown") throw new DomainError("conflict", `该调用状态为 ${op.status}，无需对账`, 409);
        db.run(`UPDATE tool_operations SET status = ?, completed_at = ? WHERE tool_operation_id = ? AND status IN ('pending','unknown')`, [
          resolution === "applied" ? "succeeded" : "failed",
          new Date().toISOString(),
          opId,
        ]);
        audit(db, id, "tool_operation.reconciled", "run", runId, `${op.tool}:${resolution}`, keyctx);
        const remaining = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tool_operations WHERE run_id = ? AND status IN ('pending','unknown')`, [runId])!.n;
        let runStatus = (db.get(`SELECT status FROM runs WHERE run_id = ?`, [runId]) as any).status as string;
        if (remaining === 0 && runStatus === "reconciling") {
          const r = db.run(
            `UPDATE runs SET status = 'failed', status_version = status_version + 1, updated_at = ?, points_reserved = 0, terminal_reason = ? WHERE run_id = ? AND status = 'reconciling'`,
            [new Date().toISOString(), "人工对账完成：已生效的调用重试时按幂等键返回存档结果，不重复执行；可经 runs.retry 重新排队", runId],
          );
          if (r.changes > 0) runStatus = "failed";
        }
        return { run_id: runId, tool_operation_id: opId, resolution, remaining_unresolved: remaining, run_status: runStatus };
      });
    },

    /**
     * 重试失败的任务（状态机 failed → queued；新尝试取得新纪元，旧尝试令牌随之失效）。
     * 只允许 failed（含人工对账完成后的 failed）；仍有结果不明的副作用调用时拒绝——先对账（runs.reconcile）。
     */
    "runs.retry": (p, id) => {
      assertNotExitMode("重新发起任务");
      const runId = String(p?.run_id ?? "");
      requireRunAccess(db, runId, id);
      requireMatterWriter(db, db.get(`SELECT matter_id FROM runs WHERE run_id = ?`, [runId]).matter_id, id);
      const unresolved = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tool_operations WHERE run_id = ? AND status IN ('pending','unknown')`, [runId])!.n;
      if (unresolved > 0) throw new DomainError("conflict", `仍有 ${unresolved} 个副作用调用结果不明，须先人工对账（runs.reconcile）`, 409);
      const expected = Number(p?.expected_version);
      if (!Number.isInteger(expected)) throw validation("需要 expected_version（乐观并发）");
      // 同一事项同时只运行一个 Agent 任务（复核 B4-B12）：重试与发起同一口径——事项里另有进行中的任务即如实拒绝并给出那个任务，
      // 不先改回排队、再在宿主失败
      const retried = db.get<{ matter_id: string; scenario: string }>(`SELECT matter_id, scenario FROM runs WHERE run_id = ?`, [runId]);
      if (retried?.scenario === "a1.agent_task") {
        const busy = liveAgentRunOf(db, retried.matter_id);
        if (busy && busy.run_id !== runId) {
          throw new DomainError("conflict", `这个事项里还有一个任务在进行${busy.goal ? `（“${busy.goal}”）` : ""}。请等它完成，或在它的执行页取消后再重新运行`, 409, { run_id: busy.run_id });
        }
      }
      const r = db.run(
        `UPDATE runs SET status = 'queued', status_version = status_version + 1, updated_at = ?, terminal_reason = NULL, points_reserved = budget_points WHERE run_id = ? AND status = 'failed' AND status_version = ?`,
        [new Date().toISOString(), runId, expected],
      );
      if (r.changes === 0) {
        const cur = db.get(`SELECT status, status_version FROM runs WHERE run_id = ?`, [runId]) as any;
        throw new DomainError("conflict", `只有失败的任务可以重试（当前 ${cur?.status} v${cur?.status_version}）`, 409);
      }
      audit(db, id, "run.retry", "run", runId, undefined, keyctx);
      queue.enqueue(runId);
      return { run_id: runId, status: "queued" };
    },

    "runs.cancel": (p, id) => {      const runId = String(p?.run_id ?? "");
      requireRunAccess(db, runId, id);
      requireMatterWriter(db, db.get(`SELECT matter_id FROM runs WHERE run_id = ?`, [runId]).matter_id, id, { allowClosed: true });
      const expected = Number(p?.expected_version);
      if (!Number.isInteger(expected)) throw validation("需要 expected_version（乐观并发）");
      // 乐观并发：版本不符即拒绝，不静默覆盖（§4.4）
      const r = db.run(
        `UPDATE runs SET status = 'cancelled', cancel_reason = ?, status_version = status_version + 1, updated_at = ?
          WHERE run_id = ? AND status_version = ? AND status NOT IN ('succeeded','partial','failed','cancelled','expired','timed_out','reconciling')`,
        [String(p?.reason ?? "用户取消"), new Date().toISOString(), runId, expected],
      );
      if (r.changes === 0) {
        const cur = db.get(`SELECT status, status_version FROM runs WHERE run_id = ?`, [runId]) as any;
        if (cur?.status === "reconciling") {
          throw new DomainError("conflict", "任务在人工对账中：须先对结果不明的调用逐项确认（runs.reconcile），不能直接取消", 409);
        }
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
      // 带上所属任务的场景、方法模板与开始时刻（Astra M-3：交付件按“事项 → 一次任务”分组，律师关心的是这次要交出去的那几份）
      const rows = db.all<Record<string, unknown>>(
        `SELECT a.artifact_version_id, a.run_id, a.kind, a.version, a.audience, a.status, a.filename, a.sha256, a.created_at, a.storage_uri,
                r.scenario AS run_scenario, json_extract(CASE WHEN json_valid(r.input_snapshot) THEN r.input_snapshot ELSE '{}' END, '$.skill') AS run_skill, r.created_at AS run_created_at
           FROM artifact_versions a LEFT JOIN runs r ON r.run_id = a.run_id
          WHERE a.matter_id = ? ORDER BY a.kind, a.version DESC`,
        [matterId],
      );
      // 交付件按内容命名（UIUX 增量评审 D-2）：Markdown/文本成果取第一行标题（令牌形态，界面还原代号）；成果不可变，按版本缓存
      return {
        artifacts: rows.map(({ storage_uri, ...r }) => ({ ...r, title: artifactTitle(String(r.artifact_version_id), String(r.filename), String(storage_uri)) })),
      };
    },

    /**
     * 下载（导出）成果：先核对登记的字节 hash（令牌形态），再按事项令牌表还原代号（第 02 篇 §8.4“导出时还原”；export-restore.ts）。
     * 返回的是还原后的文件；登记 hash 仍指令牌形态的字节，还原后的 hash 另行给出。导出记审计（只记次数与条数）。
     */
    "artifacts.download": (p, id) => {
      const art = requireArtifact(db, String(p?.artifact_version_id ?? ""), id);
      // 应用内预览（restore:false，只显示代号形态）照常；还原真名的导出在被停用的电脑上不再提供（复核 R15A-04）
      if (p?.restore !== false) assertNotRevokedForExport("下载成果");
      const buf = blobs.read(String(art.storage_uri));
      const actual = sha256Hex(buf);
      if (actual !== art.sha256) throw new DomainError("hash_mismatch", "成果文件 hash 与登记不符（完整性校验失败）", 500);
      const r = tokens && p?.restore !== false ? restoreArtifactBytes(String(art.filename), buf, (t) => tokens.restore(art.matter_id, t)) : null;
      if (r?.changed || (r && r.unresolved.length > 0)) {
        audit(db, id, "artifact.exported", "artifact", art.artifact_version_id, sha256Hex(JSON.stringify({ restored: r.restored, unresolved: r.unresolved.length })), keyctx);
      }
      let out = r?.changed ? r.bytes : buf;
      let filename = String(art.filename);
      // 文书版式（B-4）：导出时套本机的函头、字体与律所模板——本产品生成的 Word 重新套版式；Markdown / 文本成果可“下载 Word”。预览不套
      if (p?.restore !== false) {
        const { style, template, digest } = houseStyleFor(db, id.tenantId, config.activation?.firm_name ?? null);
        let styled = false;
        if (/\.docx$/i.test(filename) && isHouseStyled(out)) {
          out = restyleDocx(out, style, template);
          styled = true;
        } else if (p?.as === "docx" && /\.(md|markdown|txt)$/i.test(filename)) {
          out = createStyledDocx(markdownToBlocks(out.toString("utf8")), style, template);
          filename = filename.replace(/\.(md|markdown|txt)$/i, ".docx");
          styled = true;
        }
        if (styled) audit(db, id, "artifact.styled", "artifact", art.artifact_version_id, digest, keyctx);
      }
      const changed = !out.equals(buf);
      // 桌面客户端：导出直写到律师选定的位置（还原真名的明文只落在那里；Y5 P1-4）；预览（restore:false）不接受保存位置
      const saved = p?.save_path && p?.restore !== false ? writeExportFile(String(p.save_path), out, config.workspaceDir) : null;
      if (saved) audit(db, id, "artifact.saved", "artifact", art.artifact_version_id, sha256Hex(out), keyctx);
      return {
        filename: saved?.name ?? filename,
        sha256: art.sha256,
        exported_sha256: changed ? sha256Hex(out) : art.sha256,
        tokens_restored: r?.restored ?? 0,
        unresolved_tokens: r?.unresolved.length ?? 0,
        size_bytes: out.length,
        ...(saved ? { saved: true } : { data_base64: out.toString("base64") }),
      };
    },

    // ─── 文书版式（v9.3 第 15 批 B-4）：本机导出 Word 时的函头、字体字号、页码与律所模板 ───
    "doc_style.get": (_p, id) => docStyleView(db, id.tenantId, config.activation?.firm_name ?? null),
    "doc_style.set": (p, id) => {
      setDocStyle(db, id.tenantId, p ?? {});
      audit(db, id, "doc_style.set", "tenant", id.tenantId, undefined, keyctx);
      return docStyleView(db, id.tenantId, config.activation?.firm_name ?? null);
    },
    // 上传律所模板：桌面客户端经系统对话框（主进程把句柄换成 file），开发形态传 data_base64
    "doc_style.set_template": (p, id) => {
      let bytes: Buffer;
      let name: string;
      if (p?.file) {
        const file = String(p.file);
        if (statSync(file).size > 5 * 1024 * 1024) throw new DomainError("validation", "模板文件过大（上限 5 MB）：请去掉模板里的大图片后再上传", 422);
        bytes = readFileSync(file);
        name = String(p?.filename ?? file.split(/[\\/]/).pop() ?? "律所模板");
      } else if (typeof p?.data_base64 === "string") {
        bytes = Buffer.from(p.data_base64, "base64");
        name = String(p?.filename ?? "律所模板");
      } else throw validation("请选择模板文件");
      if (!/\.(dotx|docx)$/i.test(name)) throw new DomainError("unsupported_file", "请上传 Word 模板（.dotx）或用作模板的 Word 文档（.docx）", 422);
      const r = setDocTemplate(db, id.tenantId, name, bytes);
      audit(db, id, "doc_style.template_set", "tenant", id.tenantId, r.sha256 ?? undefined, keyctx);
      return docStyleView(db, id.tenantId, config.activation?.firm_name ?? null);
    },
    "doc_style.clear_template": (_p, id) => {
      setDocTemplate(db, id.tenantId, null, null);
      audit(db, id, "doc_style.template_cleared", "tenant", id.tenantId, undefined, keyctx);
      return docStyleView(db, id.tenantId, config.activation?.firm_name ?? null);
    },
    // 样张：一页虚构内容按当前版式生成，律师打开看看函头、字体、页码对不对
    "doc_style.sample": (p, id) => {
      // 界面上还没保存的选项也能出样张（复核 R15B-22）
      const draft = p?.draft && typeof p.draft === "object" ? (p.draft as Record<string, unknown>) : undefined;
      const { style, template } = houseStyleFor(db, id.tenantId, config.activation?.firm_name ?? null, draft);
      const out = createStyledDocx(markdownToBlocks(DOC_STYLE_SAMPLE), style, template);
      const saved = p?.save_path ? writeExportFile(String(p.save_path), out, config.workspaceDir) : null;
      return { filename: saved?.name ?? "文书版式样张.docx", ...(saved ? { saved: true } : { data_base64: out.toString("base64") }) };
    },

    /** Office 成果的应用内预览（UIUX P0-3）：内核渲染为白名单 HTML（修订显示为插入/删除，批注列在文末）；代号由界面在隔离框架内还原。 */
    "artifacts.render_html": (p, id) => {
      const art = requireArtifact(db, String(p?.artifact_version_id ?? ""), id);
      const buf = blobs.read(String(art.storage_uri));
      if (sha256Hex(buf) !== art.sha256) throw new DomainError("hash_mismatch", "成果文件 hash 与登记不符（完整性校验失败）", 500);
      const name = String(art.filename).toLowerCase();
      try {
        if (name.endsWith(".docx")) {
          const r = renderDocxHtml(buf);
          return { filename: art.filename, kind: "docx", html: r.html, summary: { paragraphs: r.paragraphs, revisions: r.revisions, comments: r.comments, truncated: r.truncated } };
        }
        if (name.endsWith(".xlsx")) {
          const r = renderXlsxHtml(buf);
          return { filename: art.filename, kind: "xlsx", html: r.html, summary: { sheets: r.sheets, truncated: r.truncated } };
        }
      } catch (e) {
        throw new DomainError("unsupported_file", `文件无法预览（${(e as Error).message.slice(0, 80)}），请下载后用 Word 或 Excel 打开`, 422);
      }
      throw new DomainError("unsupported_file", "该格式不支持应用内预览", 422);
    },

    /** 材料全文（审查工作台左栏，按段落；DOCX 取段落文本，其他取最新解析文本）。原文只给可信界面。 */
    "materials.text": (p, id) => {
      const docId = String(p?.document_version_id ?? "");
      const doc = db.get<any>(`SELECT * FROM document_versions WHERE document_version_id = ? AND tenant_id = ?`, [docId, id.tenantId]);
      if (!doc) throw notFound("文档");
      requireMatterAccess(db, doc.matter_id, id);
      if (doc.quarantined_at) throw new DomainError("conflict", "该材料已隔离（带国家秘密标志），不能预览", 409);
      let paragraphs: string[] | null = null;
      if (String(doc.filename).toLowerCase().endsWith(".docx") && doc.storage_mode === "import") {
        try {
          paragraphs = extractParagraphs(blobs.read(String(doc.storage_uri))).map((x) => x.text);
        } catch {
          paragraphs = null;
        }
      }
      if (!paragraphs) {
        const t = db.get<{ content: string }>(
          `SELECT pt.content FROM parse_versions pv JOIN parse_texts pt ON pt.parse_version_id = pv.parse_version_id WHERE pv.document_version_id = ? ORDER BY pv.created_at DESC LIMIT 1`,
          [docId],
        );
        paragraphs = (t?.content ?? "").split(/\n/);
      }
      return { filename: doc.filename, paragraphs: paragraphs.slice(0, 20_000) };
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

    /**
     * 本次任务的材料有没有读全（Astra M-2）：任务登记的 materials.loaded 里有没读到的、或读到的少于要求的。
     * 有缺口时签发须勾选“缺口已告知客户”（checklist.gaps_disclosed），并写进签发留痕。
     */
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
      // “你来核对”（v9.2 §4.4；Y4 §5 D-3）：取本任务所用方法模板的质量自检清单；勾选只记录人工核对，不代表系统验证
      const { skillId, items: lawyerChecklist } = lawyerChecklistOf(art.run_id);
      const artCitations = artifactCitationsFor(db, blobs, lawdb, art as any);
      return {
        artifact_version_id: art.artifact_version_id,
        matter_id: art.matter_id,
        // 复核页“查看任务过程”入口（复核 B13-U10）
        run_id: art.run_id ?? null,
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
          // 成果文件自身的引用核验（第 13 批）：签发门禁同一判定
          artifact_citations: artCitations,
          // 本次运行在材料里核到的离线案号（第 14 批第二轮复核 R2B-27：与成果里的案号同一口径——逐个核对并勾选后可签发）
          run_case_offline: unverifiedOffline,
        },
        // sha256：签发时带回，清单在复核页打开后变了（方法包更新）就拒签（复核 Q3-06）
        lawyer_checklist: { skill: lawyerChecklist.length ? skillId : null, items: lawyerChecklist, sha256: sha256Hex(JSON.stringify(lawyerChecklist)) },
        // 材料缺口（Astra M-2）：有缺口时签发须勾选“缺口已告知客户”
        material_gaps: materialGapCount(db, art.run_id ?? null),
        material_gap_files: materialGaps(db, art.run_id ?? null).files,
        // 页级读不清（v9.3 主文 §9 第 9 项，按建议默认：只列出、不要求勾选）：本次任务用到的材料里识别不清或读不出的页
        partial_pages: partialPages(db, art.run_id ?? null),
        read_truncated: truncatedReads(db, art.run_id ?? null),
        // 复核人（Astra M-2）：签发区显示“复核人：{姓名}”——这台电脑的本人（本人没有签发权时不显示）；已签发、已退回的显示签发人、退回人。
        // 姓名不认识时为 null（界面写“本所其他成员”），不回落成成员编号（复核 RB16B-06/09）
        reviewer: (() => {
          try {
            requireIssuerRole(db, art.matter_id, id);
            return { name: displayNameOf(id.userId, null) };
          } catch {
            return null;
          }
        })(),
        approved_by: (() => {
          const a = db.get<{ approver_id: string; created_at: string }>(`SELECT approver_id, created_at FROM approvals WHERE artifact_version_id = ? AND decision = 'approved' ORDER BY created_at DESC LIMIT 1`, [art.artifact_version_id]);
          return a ? { name: displayNameOf(a.approver_id, null), at: a.created_at } : null;
        })(),
        rejected_by: (() => {
          if (art.status !== "rejected") return null;
          const a = db.get<{ approver_id: string; created_at: string }>(`SELECT approver_id, created_at FROM approvals WHERE artifact_version_id = ? AND decision = 'rejected' ORDER BY created_at DESC LIMIT 1`, [art.artifact_version_id]);
          return a ? { name: displayNameOf(a.approver_id, null), at: a.created_at } : null;
        })(),
        // “看最新版本”直达最新版的复核页（复核 RB16B-07）
        latest_artifact_version_id:
          art.version === latest.v
            ? art.artifact_version_id
            : (db.get<{ id: string }>(`SELECT artifact_version_id AS id FROM artifact_versions WHERE matter_id = ? AND kind = ? AND audience = ? ORDER BY version DESC LIMIT 1`, [art.matter_id, art.kind, art.audience])?.id ?? null),
        // 论点未经确认（10-23 拍板）：签发必过项——写一句不确认就签发的理由（进签发记录），或回任务页确认论点后重新生成
        outline_unconfirmed: hasOutlineUnconfirmed(openItems),
        blockers: [
          ...(fileOk ? [] : ["文件完整性校验失败"]),
          ...(openItems.length > 0 ? ["存在未决项，签发人须逐项确认"] : []),
          ...(hasOutlineUnconfirmed(openItems) ? ["论点与依据没经你确认就产出了这份成果：须写一句不确认就签发的理由（会写进签发记录），或回任务页确认论点后重新生成"] : []),
          ...(unverifiedOffline > 0 ? [`材料里有 ${unverifiedOffline} 个案号系统离线无法核实，须逐个在裁判文书网等官方来源核对并勾选后才能签发`] : []),
          ...(artCitations && artCitations.wrong > 0 ? [`成果里有 ${artCitations.wrong} 条引用核对不通过（条号不存在、已改号或当时没有有效版本），改正后再签发`] : []),
          ...(artCitations && artCitations.unverified_offline > 0 ? [`成果里有 ${artCitations.unverified_offline} 个案号系统离线无法核实，须逐个核对并勾选后才能签发`] : []),
          ...(artCitations && artCitations.outside_registry > 0 ? [`成果里有 ${artCitations.outside_registry} 条引用系统没法核对（不在本机法规库里，或款项、适用版本对不上），须逐条人工核对并勾选后才能签发`] : []),
          ...(artCitations && !artCitations.checked ? ["这份文件的引用系统没有核对（格式不认识或读取出错），须人工核对并勾选后才能签发"] : []),
          ...(artCitations && (artCitations.unsupported ?? 0) > 0 ? [`成果里有 ${artCitations.unsupported} 条引用你标为不支持，改正后再签发`] : []),
          ...(artCitations && (artCitations.support_pending ?? 0) > 0 ? [`成果里有 ${artCitations.support_pending} 条引用的支持性待你逐条确认（确认支持或我已知悉）`] : []),
          ...(artCitations && (artCitations.timing ?? 0) > 0 ? [`成果里有 ${artCitations.timing} 条引用要按事件时点或地域核对，须逐条核对并勾选后才能签发`] : []),
          ...(art.version === latest.v ? [] : ["已有更新版本，本版不得签发（批准不跨版本）"]),
        ],
      };
    },

    /**
     * 论断—依据对照（v9.4 第 20 批 C-03）：成果里每处引用的论断原句、条文原文、三层状态与律师的逐条决定。
     * 只读；执行页右栏“引用”与成果预览角标用。
     */
    "artifacts.citations": (p, id) => {
      const art = requireArtifact(db, String(p?.artifact_version_id ?? ""), id);
      return { citations: artifactCitationsFor(db, blobs, lawdb, art as any), facts: artifactFactsFor(db, blobs, art as any) };
    },
    /** 律师逐条决定一处引用的支持性（确认支持 / 标为不支持 / 我已知悉；decision 为 null 即撤回）。只对未签发的版本；审计不记引用原文。 */
    "citations.decide": (p, id) => {
      const art = requireArtifact(db, String(p?.artifact_version_id ?? ""), id);
      requireMatterWriter(db, art.matter_id, id);
      if (!["draft", "pending_review", "pending_verification"].includes(String(art.status))) throw new DomainError("conflict", "这份成果已签发或已退回，不能再改引用的决定", 409);
      const key = String(p?.cite_key ?? "");
      const decision = p?.decision ?? null;
      if (decision !== null && !["supported", "unsupported", "acknowledged"].includes(decision)) throw validation("decision 须为 supported / unsupported / acknowledged 或 null");
      const ac = artifactCitationsFor(db, blobs, lawdb, art as any);
      const item = ac?.items.find((i) => i.key === key);
      if (!item) throw new DomainError("not_found", "这份成果里没有这处引用（文件可能已更新）", 404);
      if (item.kind !== "ok") throw new DomainError("conflict", "这处引用系统没有核到来源与版本：先按上面的提示处理", 409);
      if (decision === null) db.run(`DELETE FROM citation_decisions WHERE artifact_version_id = ? AND cite_key = ?`, [art.artifact_version_id, key]);
      else
        db.run(
          `INSERT INTO citation_decisions (artifact_version_id, cite_key, decision, decided_by, decided_at) VALUES (?,?,?,?,?)
           ON CONFLICT (artifact_version_id, cite_key) DO UPDATE SET decision = excluded.decision, decided_by = excluded.decided_by, decided_at = excluded.decided_at`,
          [art.artifact_version_id, key, decision, id.userId, new Date().toISOString()],
        );
      audit(db, id, "citation.decided", "artifact_version", art.artifact_version_id, sha256Hex(JSON.stringify({ decision })), keyctx);
      return { citations: artifactCitationsFor(db, blobs, lawdb, art as any) };
    },

    "review.approve": (p, id) => {
      // 签发与审批用设备签名：退出模式（含本设备被吊销）下不可用；验签（approvals.verify）照常
      assertNotExitMode("签发与审批");
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
      // “你来核对”的勾选写进签发记录时用条目原文（v9.4 第 21 批；评审 S1 §4“律师勾选项写入签发记录未核实”）：
      // 界面只交序号，内核按本任务方法的自检清单换成原文；序号越界或重复的拒绝——记录里写的是律师当时看到、勾上的那几句话
      const lc = lawyerChecklistOf(art.run_id);
      const rawTicks = Array.isArray(checklistObj.lawyer_checked) ? checklistObj.lawyer_checked : [];
      if (rawTicks.some((n) => !Number.isInteger(n) || (n as number) < 0 || (n as number) >= lc.items.length) || new Set(rawTicks).size !== rawTicks.length)
        throw validation("“你来核对”的勾选与本任务方法的自检清单对不上：请刷新复核页后重新勾选");
      // 勾了的，清单须是律师看到的那一份（复核 Q3-06：复核页打开后方法包更新、条目顺序变了，序号会对上另一句话）
      if (rawTicks.length > 0 && checklistObj.lawyer_checklist_sha256 !== sha256Hex(JSON.stringify(lc.items)))
        throw validation("“你来核对”的清单在你打开复核页后变了（方法模板已更新）：请刷新复核页后重新勾选");
      const lawyerTicked = (rawTicks as number[]).slice().sort((a, b) => a - b).map((n) => lc.items[n]!);
      checklistObj.lawyer_checked_items = lawyerTicked;
      checklistObj.lawyer_items = lc.items.length;
      checklistObj.skill = lc.items.length ? lc.skillId : null;
      // 论点未经确认（10-23 拍板）：不是硬阻断，签发须写理由；理由按内核清洗后的原文进签发记录，没有这一未决项的不记
      const outlineOpen = hasOutlineUnconfirmed(parseJson<unknown[]>(art.open_items, []));
      const outlineReason = outlineOpen ? outlineUnconfirmedReason(checklistObj.outline_unconfirmed_reason) : null;
      if (outlineReason) checklistObj.outline_unconfirmed_reason = outlineReason;
      else delete checklistObj.outline_unconfirmed_reason;
      const checklist = JSON.stringify(checklistObj);

      if (decision === "approved") {
        // 未核实（离线）的引用不得进入签发版（§9/第 5 篇 §2.1：案号离线未核 → 阻断签发）
        // 运行里在材料中核到的离线案号（第 14 批第二轮复核 R2B-27）：与成果里的案号同一口径——律师逐个核对并勾选后可签发（D-98 扩展，待拍板）
        // 材料缺口（Astra M-2）：没读全的材料须律师确认“缺口已保留在报告中、已向客户说明”，写进签发留痕
        const gaps = materialGapCount(db, art.run_id);
        if (gaps > 0 && checklistObj.gaps_disclosed !== true) {
          throw new DomainError("material_gaps_undisclosed", `本次任务有 ${gaps} 份材料没有读到：请在复核页勾选“缺口已保留在报告中，已向客户说明”后再签发`, 409, { material_gaps: gaps });
        }
        if (outlineOpen && !outlineReason) throw new DomainError("outline_unconfirmed", "这份成果产出时论点与依据没经你确认：请写一句不确认就签发的理由（至少 4 个字），或回任务页确认论点后重新生成", 409);
        const unverified = unverifiedOfflineCount(db, art.run_id);
        if (unverified > 0 && checklistObj[CITATIONS_CASES_CHECK_KEY] !== true) {
          throw new DomainError("unverified_citations", `材料里有 ${unverified} 个案号系统离线无法核实：请逐个在裁判文书网等官方来源核对，在复核页勾选“已逐个核对案号”后再签发`, 409, {
            unverified_offline: unverified,
          });
        }
        // 成果文件自身的引用核验（第 13 批）：定性错误与离线案号不得签发；法规库未收录的须律师勾选“已逐条人工核对”
        const ac = artifactCitationsFor(db, blobs, lawdb, art as any);
        const acBlock = ac ? artifactCitationBlock(ac, checklistObj) : null;
        if (acBlock) {
          throw new DomainError("unverified_citations", acBlock.message, 409, { artifact_citations: { code: acBlock.code, wrong: ac!.wrong, unverified_offline: ac!.unverified_offline, outside_registry: ac!.outside_registry, timing: ac!.timing ?? 0, support_pending: ac!.support_pending ?? 0, unsupported: ac!.unsupported ?? 0 } });
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
          // 系统核验结果摘要（复核 A-12）：签进签发记录的是内核自己算的计数，不是界面提交的核对单；律师勾选了哪些人工核对见 completeness_hash
          citation_check: ac
            ? { checked: ac.checked, total: ac.total, verified: ac.verified, wrong: ac.wrong, case_offline: ac.unverified_offline, outside_registry: ac.outside_registry, event_time: ac.timing ?? 0, event_date: ac.event_date ?? null, support_confirmed: ac.items.filter((i) => i.decision === "supported").length, support_acknowledged: ac.items.filter((i) => i.decision === "acknowledged").length, registry_coverage: ac.registry_coverage }
            : null,
          // 律师人工核对的“你来核对”（v9.4 第 21 批）：方法、清单条数与勾上的条目原文；不代表系统验证
          lawyer_checklist: { skill: lc.items.length ? lc.skillId : null, items: lc.items.length, checked: lawyerTicked },
          // 论点未经确认就签发的理由（10-23 拍板）；没有这一未决项为 null
          outline_unconfirmed_reason: outlineReason,
          signed_at: new Date().toISOString(),
        });
        // 签发审批：对外可验证（TPM 直签的落点，W8 改异步，偏离 D-71）
        const signature = keyctx.device.signer.signSync(new TextEncoder().encode(signedPayload));
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
      // 当前证书验不过时再试同一设备编号的留档证书（换新密钥到恢复之间签出的审批，复核 B4-A11）；证明包给出实际验签通过的那张
      const signerCert = cert && verifyBytes(cert.signPublicKeyPem, new TextEncoder().encode(ap.signed_payload), ap.signature)
        ? cert
        : (certVerifying(
            db,
            ap.signer_device_id,
            null,
            firmRow?.root_public_key_pem ?? null,
            new TextEncoder().encode(ap.signed_payload),
            ap.signature,
            // 审批的见证行序号（复核 B4-R10：留档证书只对不晚于其上界的见证有效）
            db.get<{ seq: number }>(`SELECT seq FROM signed_events WHERE kind = 'approval' AND ref_id = ?`, [ap.approval_id])?.seq ?? null,
          ) ?? cert);
      const signatureValid = signerCert ? verifyBytes(signerCert.signPublicKeyPem, new TextEncoder().encode(ap.signed_payload), ap.signature) : false;
      const certChainValid = signerCert && firmRow ? verifyCertSignature(signerCert, firmRow.root_public_key_pem) : false;
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
          cert_json: signerCert ? JSON.stringify(signerCert) : (device?.cert_json ?? null),
          root_public_key_pem: firmRow?.root_public_key_pem ?? null,
        },
      };
    },

    "deliveries.create": (p, id) => {
      const art = requireArtifact(db, String(p?.artifact_version_id ?? ""), id);
      // 已删除的事项不再登记交付（复核 C-A05）；结案事项可以下载、归档与外发已签发的成果（只读动作）
      if (db.get<{ lifecycle: string }>(`SELECT lifecycle FROM matters WHERE matter_id = ?`, [art.matter_id])?.lifecycle === "purged") {
        throw new DomainError("conflict", "事项数据已删除", 409);
      }
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

    /**
     * 全局搜索（Z3 §8.2 #31；余项续复核 RC-A-05、RC-B-06/07）：在本人能看到的全部事项、任务与交付件里按标题找，
     * 只返回命中的几条（每类至多 6 条）。代号只在内核里还原用于匹配，命中且返回的才带原文；还原按“每人每分钟一条”另记
     * search.titles_restored（不混进按事项计的“取原文”审计）。不联网。labels：界面的场景名与交付件名（按 skill: / scenario: / kind: 键）。
     */
    "search.titles": (p, id) => {
      const q = String(p?.q ?? "").slice(0, 100);
      const empty = { matters: [], runs: [], deliverables: [], truncated: { runs: false, deliverables: false } };
      if (!q.trim()) return empty;
      const labels: Record<string, string> = p?.labels && typeof p.labels === "object" && !Array.isArray(p.labels) ? Object.fromEntries(Object.entries(p.labels as Record<string, unknown>).filter(([, v]) => typeof v === "string").slice(0, 500).map(([k, v]) => [k, String(v).slice(0, 40)])) : {};
      const restoreFor = (matterId: string, text: string) => (tokens && text.includes("〔") ? tokens.restore(matterId, text) : { text, restored: 0 });
      const matters = db.all<{ matter_id: string; title: string; client_name: string | null; counterparty: string | null; created_at: string; last_at: string | null }>(
        `SELECT m.matter_id, m.title, m.client_name, m.counterparty, m.created_at,
                (SELECT MAX(r.updated_at) FROM runs r WHERE r.matter_id = m.matter_id) AS last_at
           FROM matters m JOIN matter_members mm ON mm.matter_id = m.matter_id AND mm.user_id = ? AND mm.removed_at IS NULL
          WHERE m.tenant_id = ? AND m.status = 'active' AND m.lifecycle <> 'purged'`,
        [id.userId, id.tenantId],
      );
      const titleOf = new Map(matters.map((m) => [m.matter_id, m.title]));
      const RUN_CAP = 3000;
      const runs = db.all<{ run_id: string; matter_id: string; scenario: string; updated_at: string; input_snapshot: string | null }>(
        `SELECT r.run_id, r.matter_id, r.scenario, r.updated_at, r.input_snapshot
           FROM runs r JOIN matter_members mm ON mm.matter_id = r.matter_id AND mm.user_id = ? AND mm.removed_at IS NULL
           JOIN matters m ON m.matter_id = r.matter_id
          WHERE r.tenant_id = ? AND m.status = 'active' AND m.lifecycle <> 'purged' ORDER BY r.updated_at DESC LIMIT ?`,
        [id.userId, id.tenantId, RUN_CAP + 1],
      );
      const ART_CAP = 5000;
      const arts = db.all<{ artifact_version_id: string; matter_id: string; kind: string; version: number; filename: string; storage_uri: string; created_at: string }>(
        `SELECT a.artifact_version_id, a.matter_id, a.kind, a.version, a.filename, a.storage_uri, a.created_at
           FROM artifact_versions a JOIN matter_members mm ON mm.matter_id = a.matter_id AND mm.user_id = ? AND mm.removed_at IS NULL
           JOIN matters m ON m.matter_id = a.matter_id
          WHERE m.tenant_id = ? AND m.status = 'active' AND m.lifecycle <> 'purged' ORDER BY a.created_at DESC LIMIT ?`,
        [id.userId, id.tenantId, ART_CAP + 1],
      );
      const cands: TitleCandidate[] = [
        ...matters.map((m) => ({ kind: "matter" as const, title: m.title, sub: [m.client_name, m.counterparty].filter(Boolean).join(" / "), at: m.last_at ?? m.created_at, ref: { matter_id: m.matter_id } })),
        ...runs.slice(0, RUN_CAP).map((r) => {
          const snap = parseJson<any>(r.input_snapshot, {});
          const skill = typeof snap?.skill === "string" ? snap.skill : null;
          const label = (skill ? labels[`skill:${skill}`] : undefined) ?? labels[`scenario:${r.scenario}`] ?? "";
          const goal = String(snap?.goal ?? "").replace(/\s+/g, " ").trim();
          return { kind: "run" as const, title: goal || label || "任务", sub: titleOf.get(r.matter_id) ?? "", extra: label, at: r.updated_at, ref: { run_id: r.run_id, matter_id: r.matter_id, scenario: r.scenario, skill, goal } };
        }),
        ...arts.slice(0, ART_CAP).map((a) => {
          const title = artifactTitle(a.artifact_version_id, a.filename, a.storage_uri);
          const label = labels[`kind:${a.kind}`] ?? "";
          return { kind: "deliverable" as const, title: title ?? (label || a.filename), sub: titleOf.get(a.matter_id) ?? "", extra: `${label} ${a.filename}`, at: a.created_at, ref: { artifact_version_id: a.artifact_version_id, matter_id: a.matter_id, kind: a.kind, version: a.version, filename: a.filename, title } };
        }),
      ];
      // 代号形态的标题先在内核里还原再匹配（只在内存里；命中的才返回）
      for (const c of cands) {
        if (c.kind === "matter" || !c.title.includes("〔")) continue;
        c.title = restoreFor(String(c.ref.matter_id), c.title).text;
      }
      const hit = rankTitles(q, cands);
      let restored = 0;
      const touched = new Set<string>();
      const runsOut = hit.run.map((c) => {
        const g = restoreFor(String(c.ref.matter_id), String(c.ref.goal ?? ""));
        if (g.restored) (restored += g.restored), touched.add(String(c.ref.matter_id));
        return { run_id: c.ref.run_id, matter_id: c.ref.matter_id, matter_title: c.sub, scenario: c.ref.scenario, skill: c.ref.skill, goal: g.text.slice(0, 30), updated_at: c.at };
      });
      const delivOut = hit.deliverable.map((c) => {
        const t = c.ref.title ? restoreFor(String(c.ref.matter_id), String(c.ref.title)) : null;
        if (t?.restored) (restored += t.restored), touched.add(String(c.ref.matter_id));
        return { artifact_version_id: c.ref.artifact_version_id, matter_id: c.ref.matter_id, matter_title: c.sub, kind: c.ref.kind, version: c.ref.version, filename: c.ref.filename, title: t?.text ?? null, created_at: c.at };
      });
      if (restored > 0) {
        const w = searchRestoreWindow(id);
        w.calls += 1;
        w.restored += restored;
        for (const m of touched) w.matters.add(m);
      }
      return {
        matters: hit.matter.map((c) => ({ matter_id: c.ref.matter_id, title: c.title, sub: c.sub, last_at: c.at })),
        runs: runsOut,
        deliverables: delivOut,
        truncated: { runs: runs.length > RUN_CAP, deliverables: arts.length > ART_CAP },
      };
    },

    // 首页“等你处理 / 继续工作”（UIUX 增量评审 H-1）：本人能看到的事项里最近的任务（只给目标前 24 字与状态，不含正文）
    "runs.list_recent": (p, id) => {
      // 全局搜索（Z3 §8.2 #31）一次取至多 100 条
      const limit = Math.max(1, Math.min(100, Number(p?.limit ?? 5) || 5));
      const rows = db.all<{ run_id: string; matter_id: string; matter_title: string; scenario: string; status: string; updated_at: string; input_snapshot: string | null }>(
        `SELECT r.run_id, r.matter_id, m.title AS matter_title, r.scenario, r.status, r.updated_at, r.input_snapshot
           FROM runs r JOIN matters m ON m.matter_id = r.matter_id
           JOIN matter_members mm ON mm.matter_id = r.matter_id AND mm.user_id = ? AND mm.removed_at IS NULL
          WHERE r.tenant_id = ? AND m.lifecycle <> 'purged'
          ORDER BY r.updated_at DESC LIMIT ?`,
        [id.userId, id.tenantId, limit],
      );
      const waiting = db.all<{ run_id: string; matter_id: string }>(
        `SELECT r.run_id, r.matter_id FROM runs r JOIN matter_members mm ON mm.matter_id = r.matter_id AND mm.user_id = ? AND mm.removed_at IS NULL
          WHERE r.tenant_id = ? AND r.status IN ('waiting_approval','waiting_input') ORDER BY r.updated_at DESC LIMIT 50`,
        [id.userId, id.tenantId],
      );
      return {
        runs: rows.map((r) => ({
          run_id: r.run_id,
          matter_id: r.matter_id,
          matter_title: r.matter_title,
          scenario: r.scenario,
          status: r.status,
          updated_at: r.updated_at,
          goal: String(parseJson<any>(r.input_snapshot, {})?.goal ?? "").replace(/\s+/g, " ").slice(0, 24),
          // 方法模板（界面按它找场景卡名称）
          skill: typeof parseJson<any>(r.input_snapshot, {})?.skill === "string" ? parseJson<any>(r.input_snapshot, {}).skill : null,
        })),
        waiting: waiting.map((w) => ({ run_id: w.run_id, matter_id: w.matter_id })),
      };
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
    /** 结果不明的出站（复核 S4-21：预写后闸门或内核中断）：待人工对账的清单（本人可见的事项）。 */
    "egress.unresolved": (p, id) => {
      const rows = db.all<{ record_id: string; matter_id: string; run_id: string | null; destination_kind: string; destination_host: string; note: string | null; created_at: string }>(
        `SELECT e.record_id, e.matter_id, e.run_id, e.destination_kind, e.destination_host, e.note, e.created_at
           FROM egress_records e JOIN matters m ON m.matter_id = e.matter_id
          WHERE e.outcome = 'unknown' AND e.tenant_id = ? ${p?.matter_id ? "AND e.matter_id = ?" : ""}
          ORDER BY e.created_at DESC LIMIT 200`,
        p?.matter_id ? [id.tenantId, String(p.matter_id)] : [id.tenantId],
      );
      const visible = rows.filter((r) => {
        try {
          requireMatterAccess(db, r.matter_id, id);
          return true;
        } catch {
          return false;
        }
      });
      return {
        records: visible.map((r) => {
          const note = safeJson(r.note);
          return { ...r, note: undefined, purpose: note.purpose ?? null, reconcile: note.reconcile ?? "pending", resolution: note.resolution ?? null };
        }),
      };
    },
    /** 人工对账（复核 S4-21）：律师或管理员核实后登记结论（只追加结论与签名审计事件，不改写信封内的事实）。 */
    "egress.reconcile": (p, id) => {
      const recordId = String(p?.record_id ?? "");
      const resolution = p?.resolution === "confirmed_sent" || p?.resolution === "not_sent" || p?.resolution === "unknown" ? p.resolution : null;
      if (!resolution) throw validation("resolution 须为 confirmed_sent、not_sent 或 unknown");
      const row = db.get<{ matter_id: string; note: string | null; outcome: string }>(`SELECT matter_id, note, outcome FROM egress_records WHERE record_id = ? AND tenant_id = ?`, [recordId, id.tenantId]);
      if (!row) throw notFound("去向记录不存在");
      requireMatterAccess(db, row.matter_id, id);
      requireMatterWriter(db, row.matter_id, id, { allowClosed: true });
      if (row.outcome !== "unknown") throw validation("只有结果不明的记录需要对账");
      const prev = safeJson(row.note);
      // 已有结论时须显式改判（override），历次结论保留在备注与签名审计链中
      if (prev.reconcile === "done" && p?.override !== true) throw validation("该记录已登记对账结论；如需改判请明确 override");
      const history = Array.isArray(prev.reconcile_history) ? prev.reconcile_history : [];
      if (prev.reconcile === "done") history.push({ resolution: prev.resolution, resolved_by: prev.resolved_by, resolved_at: prev.resolved_at });
      const note = { ...prev, reconcile: "done", resolution, resolved_by: id.userId, resolved_at: nowIso(), ...(history.length ? { reconcile_history: history } : {}) };
      db.run(`UPDATE egress_records SET note = ? WHERE record_id = ?`, [JSON.stringify(note), recordId]);
      audit(db, id, "egress.reconciled", "egress_record", recordId, sha256Hex(JSON.stringify({ record_id: recordId, resolution })), keyctx);
      return { ok: true };
    },

    // ─── 内核状态（「连接」页与底栏：模型通道、存储位置、队列） ───
    /** 方法模板（Kimi Code Skills）：已验签、会在开放任务中提供给 Agent 的方法模板清单。 */
    "skills.list": () => {
      const sk = deps.skills;
      if (!sk) return { ok: false, reason: "未配置方法模板包", skills: [] };
      if (!sk.ok) return { ok: false, reason: sk.reason, skills: [] };
      return {
        ok: true,
        content_sha256: sk.contentSha256,
        skills: sk.skills.map((x) => ({ id: x.id, title: x.title, description: x.description, version: x.version, tier: x.tier, lines: x.lines })),
      };
    },

    "kernel.status": (_p, id) => {
      // 端点由出站闸门转发（v9 第 04 篇 §5.1）：标准 = 法律模型网关；自带密钥与私有端点直连；内核本身不持有上游地址与密钥
      const up = gate?.upstreams;
      const endpoints = { standard: !!up?.model, byok: !!up?.byok, private: !!up?.private };
      return {
        version: "v5.0.0-g0",
        // 安装包版本（主进程经 ZR_APP_VERSION 给出；开发形态为 null）与开通时的律所名称：律师层显示用（Z3 #20、#30）
        app_version: config.env.ZR_APP_VERSION ?? null,
        firm_name: config.activation?.firm_name ?? null,
        workspace_dir: config.workspaceDir,
        firm: config.firmSlug,
        user: config.userSlug,
        tenant_id: id.tenantId,
        user_id: id.userId,
        // 本机成员角色（设置页据此显示“管理”；内核仍按角色逐个方法核验，界面显示与否不是授权依据）
        // 共享文件夹同步是否配置（“数据去向说明”如实列出团队共享；复核 S6A-02）
        sync_configured: !!config.syncShareDir,
        member_role: db.get<{ role: string }>(`SELECT role FROM memberships WHERE tenant_id = ? AND user_id = ?`, [id.tenantId, id.userId])?.role ?? null,
        model_routes: broker.routeAliases(),
        model_provider: config.env.ZR_MODEL_PROVIDER ?? "mock",
        endpoints_configured: endpoints,
        queue: queue.stats(),
        log_level: slog.currentLevel(),
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
        // 控制面与律所治理（阶段 6）：模式、生效策略、许可与退出模式、告警（不含任何令牌）
        control_plane: { ...(deps.governance?.status() ?? { mode: "local_dev" }), last_sync: deps.controlPlane?.lastSync ?? null },
        egress_gate: gate
          ? {
              socket: gate.socketPath,
              // 闸门按需拉起：没有出站任务时可以未运行
              running: gate.running,
              routes: gate.routes(),
              search_configured: !!up?.search,
              // 第 9 批 S13：支持服务（诊断包上传）是否配置、律所是否允许
              support_configured: !!up?.support,
              // 期限提醒（第 10 批 S9）：通知服务地址已配置且接入了控制面（凭据由控制面签发）
              notify_configured: !!up?.notify && !!deps.controlPlane,
              support_upload_allowed: deps.governance?.supportUploadAllowed() ?? false,
              // 共享中继（第 11 批 S11）：中继地址已配置且接入了控制面；律所策略是否允许另列
              relay_configured: !!up?.relay && !!deps.controlPlane,
              share_relay_allowed: deps.governance?.shareRelayAllowed() ?? false,
              fetch: up?.fetch ?? "disabled",
              fetch_allowlist_size: gate.fetchAllowlist.length,
              stats: { ...gate.stats },
              // 各上游连接是否加密与钉住（审计 S5）：pinned 已核对内置公钥 / tls 只做证书校验 / insecure_loopback 开发形态本机 / invalid 拒绝发出
              transport: Object.fromEntries(Object.entries(upstreamTransport(gate.upstreams)).map(([k, v]) => [k, v.state === "invalid" ? `invalid:${v.reason}` : v.state])),
              // 第 04 篇 §5.1：唯一出口的强度如实分级——当前为应用层约束（OS 出站规则为律所 IT 可选加装）
              sole_exit: "应用层约束",
              // 结果不明的出站（复核 S4-21）：进入人工对账
              unresolved: db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM egress_records WHERE tenant_id = ? AND outcome = 'unknown' AND json_extract(note, '$.reconcile') = 'pending'`, [id.tenantId])?.n ?? 0,
            }
          : null,
        note: config.env.ZR_MODEL_PROVIDER === "mock" || !config.env.ZR_MODEL_PROVIDER ? "当前为离线 mock 提供方：模型推理在本机模拟，无网络外发" : "真实模型链路：出站一律经出站闸门进程（唯一出口）",
      };
    },

    // ─── 令牌化工作区（v9 第 02 篇 §8.3–§8.4）：当事人词典与还原（还原只给可信界面渲染与文书导出） ───
    "matters.parties.list": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      if (!tokens) throw new DomainError("provider_unavailable", "令牌化工作区未启用", 503);
      return { parties: tokens.listParties(matter.matter_id), full_pseudonym: tokens.fullPseudonym(matter.matter_id) };
    },
    "matters.parties.upsert": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterWriter(db, matter.matter_id, id);
      if (!tokens) throw new DomainError("provider_unavailable", "令牌化工作区未启用", 503);
      try {
        tokens.upsertParty(matter.matter_id, { name: String(p?.name ?? ""), kind: p?.kind, aliases: Array.isArray(p?.aliases) ? p.aliases : [], role: p?.role ?? null }, id.userId);
      } catch (e) {
        throw validation((e as Error).message);
      }
      // 词典变更影响出站令牌化：策略版本递增（审计入签名链，只记摘要）
      db.run(`UPDATE matters SET policy_version = policy_version + 1 WHERE matter_id = ?`, [matter.matter_id]);
      // 审计只记动作与条目数（审查 S4-14：姓名熵低，未加盐的哈希可字典还原）
      audit(db, id, "matter.parties.upsert", "matter", matter.matter_id, sha256Hex(JSON.stringify({ op: "upsert", kind: p?.kind === "person" ? "person" : "org", entries: tokens.listParties(matter.matter_id).length })), keyctx);
      return { parties: tokens.listParties(matter.matter_id) };
    },
    /** 别名处置（复核 S4-20）：确认学得的别名、驳回学得的别名或停用自动派生的字号、撤销停用。 */
    "matters.parties.alias": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterWriter(db, matter.matter_id, id);
      if (!tokens) throw new DomainError("provider_unavailable", "令牌化工作区未启用", 503);
      const action = p?.action === "confirm" || p?.action === "reject" || p?.action === "restore" ? p.action : null;
      if (!action) throw validation("action 须为 confirm、reject 或 restore");
      let changed: boolean;
      try {
        changed = tokens.aliasAction(matter.matter_id, String(p?.name ?? ""), String(p?.alias ?? ""), action, id.userId);
      } catch (e) {
        throw validation((e as Error).message);
      }
      if (changed) {
        db.run(`UPDATE matters SET policy_version = policy_version + 1 WHERE matter_id = ?`, [matter.matter_id]);
        audit(db, id, `matter.parties.alias_${action}`, "matter", matter.matter_id, sha256Hex(JSON.stringify({ op: action, entries: tokens.listParties(matter.matter_id).length })), keyctx);
      }
      return { changed, parties: tokens.listParties(matter.matter_id) };
    },
    "matters.parties.remove": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterWriter(db, matter.matter_id, id);
      if (!tokens) throw new DomainError("provider_unavailable", "令牌化工作区未启用", 503);
      const removed = tokens.removeParty(matter.matter_id, String(p?.name ?? ""));
      if (removed) {
        db.run(`UPDATE matters SET policy_version = policy_version + 1 WHERE matter_id = ?`, [matter.matter_id]);
        audit(db, id, "matter.parties.remove", "matter", matter.matter_id, sha256Hex(JSON.stringify({ op: "remove", entries: tokens.listParties(matter.matter_id).length })), keyctx);
      }
      return { removed, parties: tokens.listParties(matter.matter_id) };
    },
    /**
     * 结构化补丁（第 02 篇 §8.4）：{document_version_id, patches: [{anchor, expected_text_hash, proposed_text, occurrence?, paragraph_hint?, comment?}]}，
     * 锚点与新文本为事项令牌形态（Agent 产出原样）；内核核对版本与锚点、还原代号后在原件副本上生成原生修订（草稿成果）；任一冲突整体返回预览。
     */
    // ─── 审查工作台（2026-10-13 审计 D2 / UIUX P0-3）：风险卡逐张决定 → 只把接受的卡写成原生修订；事实时间线由律师确认 ───
    // 文字为令牌形态，界面按 matters.tokens.restore 还原显示；律师改写的条款为原文
    "riskcards.list": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      const cards = listRiskCards(db, matter.matter_id, { run_id: p?.run_id, document_version_id: p?.document_version_id, status: p?.status });
      // 按页解析的材料（PDF 等）给出页码，卡片显示“第 x 条 · 第 y 页”（余项续复核 RC-B-18）
      const pages = typeof p?.document_version_id === "string" && p.document_version_id ? cardPages({ db, blobs, ...(tokens ? { tokens } : {}) }, matter.matter_id, p.document_version_id, cards) : new Map<string, number>();
      // Word 表格里的条款（v9.4 第 21 批，C1 §2 第 8 项）：卡片显示“表 2 第 3 行第 2 列（单价）”
      const cells = typeof p?.document_version_id === "string" && p.document_version_id ? cardCells({ db, blobs, ...(tokens ? { tokens } : {}) }, matter.matter_id, p.document_version_id, cards) : new Map<string, string>();
      return {
        cards: pages.size || cells.size ? cards.map((c) => ({ ...c, ...(pages.has(c.card_id) ? { page: pages.get(c.card_id) } : {}), ...(cells.has(c.card_id) ? { cell: cells.get(c.card_id) } : {}) })) : cards,
        progress: riskCardProgress(cards),
      };
    },
    "riskcards.decide": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterWriter(db, matter.matter_id, id);
      const card = decideRiskCard(db, matter.matter_id, id.userId, { card_id: p?.card_id, decision: p?.decision, final_text: p?.final_text, level: p?.level });
      // 审计只记卡号与决定（不记条款文字）
      audit(db, id, "riskcard.decided", "risk_card", card.card_id, sha256Hex(JSON.stringify({ decision: card.status, level: card.status === "accepted" ? card.chosen_level : null })), keyctx);
      return { card };
    },
    // 批量接受与撤回本批（v9.4 第 20 批，C1 §2.2 第 5 条）：边界由内核把关（只收提示级与前后不一致类）；审计只记卡数
    "riskcards.decide_batch": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterWriter(db, matter.matter_id, id);
      const r = decideBatch(db, matter.matter_id, id.userId, { card_ids: p?.card_ids, action: p?.action, batch: p?.batch });
      audit(db, id, "riskcard.batch_decided", "matter", matter.matter_id, sha256Hex(JSON.stringify({ action: p?.action, accepted: r.accepted.length, undone: r.undone.length, refused: r.refused.length })), keyctx);
      return r;
    },
    // 对方改动模式（v9.4 第 20 批，C1 §2.2 第 7 条）：只读；文字为令牌形态
    "riskcards.counter_changes": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      if (!tokens) throw new DomainError("provider_unavailable", "令牌化工作区未启用", 503);
      return counterChanges({ db, blobs, tokens, lawdb }, { matter_id: matter.matter_id, document_version_id: String(p?.document_version_id ?? ""), run_id: typeof p?.run_id === "string" ? p.run_id : null, baseline_document_version_id: typeof p?.baseline_document_version_id === "string" && p.baseline_document_version_id ? p.baseline_document_version_id : null });
    },
    // 缺失卡误报：驳回并记住材料里实际的说法（C1 §2.2 第 2 条）；审计不记说法文字
    "riskcards.reject_missing": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterWriter(db, matter.matter_id, id);
      const r = rejectMissingCard({ db, blobs, ...(tokens ? { tokens } : {}), lawdb }, { tenantId: matter.tenant_id, matterId: matter.matter_id, userId: id.userId }, { card_id: p?.card_id, term: p?.term });
      audit(db, id, "riskcard.decided", "risk_card", r.card.card_id, sha256Hex(JSON.stringify({ decision: "rejected", remembered: !!r.remembered })), keyctx);
      return r;
    },
    // 律师改风险卡的性质（复核 RB16B-03）：审计只记卡号与新性质
    "riskcards.set_nature": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterWriter(db, matter.matter_id, id);
      const card = setRiskCardNature(db, matter.matter_id, { card_id: p?.card_id, nature: p?.nature });
      audit(db, id, "riskcard.nature_set", "risk_card", card.card_id, sha256Hex(JSON.stringify({ nature: card.nature })), keyctx);
      return { card };
    },
    // 工作台“接受后”预览（余项续复核 RC-B-01）：与生成修订稿同一套定位与重叠检查，只读、不登记成果、不写审计（每次决定后都会刷新）
    "riskcards.preview_redline": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      if (!tokens) throw new DomainError("provider_unavailable", "令牌化工作区未启用", 503);
      return previewRedlineFromCards({ db, blobs, tokens, lawdb }, { matter_id: matter.matter_id, document_version_id: String(p?.document_version_id ?? ""), run_id: typeof p?.run_id === "string" ? p.run_id : null });
    },
    "riskcards.redline": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterWriter(db, matter.matter_id, id);
      if (!tokens) throw new DomainError("provider_unavailable", "令牌化工作区未启用", 503);
      const r = buildRedlineFromCards(
        { db, blobs, tokens, lawdb },
        {
          matter_id: matter.matter_id,
          document_version_id: String(p?.document_version_id ?? ""),
          run_id: typeof p?.run_id === "string" ? p.run_id : null,
          skip_card_ids: Array.isArray(p?.skip_card_ids) ? p.skip_card_ids.map(String) : [],
          created_by: id.userId,
          audience: p?.audience === "external" ? "external" : "internal",
          author: redlineAuthorOf(db, id.tenantId, p?.audience === "external" ? "external" : "internal", config.activation?.firm_name ?? null),
        },
      );
      const byIndex = new Map(r.cards.map((c) => [c.index, c.card_id]));
      const conflicts = r.result.status === "preview" ? r.result.conflicts.map((c) => ({ ...c, card_id: byIndex.get(c.index) ?? null })) : [];
      audit(db, id, r.result.status === "applied" ? "riskcards.redline_applied" : "riskcards.redline_preview", "document_version", String(p?.document_version_id ?? ""), sha256Hex(JSON.stringify({ cards: r.cards.length, skipped: r.skipped.length, status: r.result.status })), keyctx);
      return r.result.status === "applied"
        ? { status: "applied", artifact_version_id: r.result.artifact_version_id, filename: r.result.filename, applied: r.result.applied, skipped: r.skipped, no_insert_point: r.no_insert_point }
        : { status: "preview", reason: r.result.reason, conflicts, skipped: r.skipped, no_insert_point: r.no_insert_point };
    },
    // 导出审查意见表（C1 §2.2 第 8 条）：草稿成果，下载时还原代号；审计只记卡数
    "riskcards.export_table": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterWriter(db, matter.matter_id, id);
      if (!tokens) throw new DomainError("provider_unavailable", "令牌化工作区未启用", 503);
      const r = exportReviewTable(
        { db, blobs, tokens, lawdb },
        {
          matter_id: matter.matter_id,
          ...(typeof p?.document_version_id === "string" && p.document_version_id ? { document_version_id: p.document_version_id } : p?.document_version_id === null ? { document_version_id: null } : {}),
          run_id: typeof p?.run_id === "string" ? p.run_id : null,
          created_by: id.userId,
          format: p?.format === "docx" ? "docx" : "xlsx",
        },
      );
      audit(db, id, "riskcards.table_exported", "artifact_version", r.artifact_version_id, sha256Hex(JSON.stringify({ rows: r.rows })), keyctx);
      return r;
    },
    // 表格审阅（v9.4 第 19 批 C-01）：律师建表、逐格核；Agent 经 table.get / table.fill 填；文字为令牌形态，界面还原显示
    "tables.templates": () => ({ templates: TABLE_TEMPLATES }),
    "tables.list": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      return { tables: listTables(db, matter.matter_id) };
    },
    "tables.create": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterWriter(db, matter.matter_id, id);
      const table = createTable(db, { tenant_id: matter.tenant_id, matter_id: matter.matter_id, template: p?.template, columns: p?.columns, document_version_ids: p?.document_version_ids, title: p?.title, created_by: id.userId });
      audit(db, id, "review_table.created", "review_table", table.table_id, sha256Hex(JSON.stringify({ template: table.template, docs: table.document_version_ids.length, columns: table.columns.length })), keyctx);
      return { table };
    },
    "tables.get": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      const t = getTable(db, matter.matter_id, String(p?.table_id ?? ""));
      // 格子引文的页码（v9.4 第 22 批）：PDF 等按页解析的材料
      const pages = quotePages({ db, blobs, ...(tokens ? { tokens } : {}) }, matter.matter_id, t.cells.filter((c) => c.quote).map((c) => ({ key: `${c.document_version_id}|${c.col_key}`, document_version_id: c.document_version_id, quote: c.quote })));
      return { ...t, cells: t.cells.map((c) => (pages.has(`${c.document_version_id}|${c.col_key}`) ? { ...c, page: pages.get(`${c.document_version_id}|${c.col_key}`) } : c)) };
    },
    "tables.decide_cell": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterWriter(db, matter.matter_id, id);
      const cell = decideCell(db, matter.matter_id, id.userId, { table_id: p?.table_id, cell_id: p?.cell_id, document_version_id: p?.document_version_id, column: p?.column, decision: p?.decision, value: p?.value, expected_updated_at: p?.expected_updated_at });
      // 审计只记格子号与决定（不记值）
      audit(db, id, "review_cell.decided", "review_cell", cell.cell_id, sha256Hex(JSON.stringify({ state: cell.state })), keyctx);
      return { cell };
    },
    "tables.export": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterWriter(db, matter.matter_id, id);
      if (!tokens) throw new DomainError("provider_unavailable", "令牌化工作区未启用", 503);
      const r = exportTable({ db, blobs, tokens }, matter.matter_id, String(p?.table_id ?? ""), id.userId);
      audit(db, id, "review_table.exported", "artifact_version", r.artifact_version_id, sha256Hex(JSON.stringify({ rows: r.rows })), keyctx);
      return r;
    },
    // 表格审阅残余（v9.4 第 20 批，C1 §3.3）：自建列、格子看原文、推为事实、据此起草、台账设提醒
    "tables.add_column": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterWriter(db, matter.matter_id, id);
      const table = addColumn(db, matter.matter_id, String(p?.table_id ?? ""), { label: p?.label, hint: p?.hint, format: p?.format, options: p?.options, when: p?.when });
      audit(db, id, "review_table.column_added", "review_table", table.table_id, sha256Hex(JSON.stringify({ columns: table.columns.length })), keyctx);
      return { table };
    },
    "tables.remove_column": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterWriter(db, matter.matter_id, id);
      const table = removeColumn(db, matter.matter_id, String(p?.table_id ?? ""), String(p?.column ?? ""), p?.confirm === true);
      audit(db, id, "review_table.column_removed", "review_table", table.table_id, sha256Hex(JSON.stringify({ columns: table.columns.length })), keyctx);
      return { table };
    },
    "tables.cell_context": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      return cellContext({ db, blobs, ...(tokens ? { tokens } : {}) }, matter.matter_id, String(p?.table_id ?? ""), String(p?.cell_id ?? ""));
    },
    "tables.push_facts": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterWriter(db, matter.matter_id, id);
      const r = pushCellsToFacts({ db, blobs, ...(tokens ? { tokens } : {}) }, { tenantId: matter.tenant_id, matterId: matter.matter_id, userId: id.userId }, String(p?.table_id ?? ""), p?.cell_ids);
      audit(db, id, "review_table.facts_pushed", "review_table", String(p?.table_id ?? ""), sha256Hex(JSON.stringify(r)), keyctx);
      return r;
    },
    "tables.draft": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterWriter(db, matter.matter_id, id);
      if (!tokens) throw new DomainError("provider_unavailable", "令牌化工作区未启用", 503);
      const r = draftFromTable({ db, blobs, tokens }, matter.matter_id, String(p?.table_id ?? ""), id.userId);
      audit(db, id, "review_table.drafted", "artifact_version", r.artifact_version_id, sha256Hex(JSON.stringify({ open: r.open })), keyctx);
      return r;
    },
    "tables.reminder_candidates": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      return { candidates: ledgerReminderCandidates(db, matter.matter_id, String(p?.table_id ?? ""), localToday()) };
    },
    // 起草前的论点与依据（v9.4 第 19 批 C-04）：任务页逐条确认；文字为令牌形态，界面还原显示
    "outlines.list": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      return { outlines: listOutlines(db, matter.matter_id, { run_id: p?.run_id }) };
    },
    "outlines.decide": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterWriter(db, matter.matter_id, id);
      const outline = decideOutline(db, matter.matter_id, id.userId, { outline_id: p?.outline_id, decisions: p?.decisions, note: p?.note });
      // 审计只记提纲号与留删计数（不记论点文字）
      const d = outline.decisions ?? [];
      audit(db, id, "outline.confirmed", "argument_outline", outline.outline_id, sha256Hex(JSON.stringify({ kept: d.filter((x) => x.keep).length, dropped: d.filter((x) => !x.keep).length, edited: d.filter((x) => x.claim).length })), keyctx);
      return { outline };
    },
    // 事项待办（v9.4 第 20 批，C1 §3.2）：手工待办 + 从任务与成果推出的待办；文字为律师原文，审计不记文字
    // 统一待核清单（v9.4 第 21 批，主文 §6.4）：事实、审阅表、审查意见、论点、成果未决项、引用逐条决定，一处列全
    "matters.pending_checks": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      const checks = pendingChecks(db, matter.matter_id);
      for (const a of unsignedLatestArtifacts(db, matter.matter_id)) {
        if (!/\.(docx|md|txt|markdown)$/i.test(a.filename)) continue;
        const c = artifactCitationsFor(db, blobs, lawdb, a);
        const n = (c?.support_pending ?? 0) + (c?.unsupported ?? 0);
        if (c?.checked && n > 0)
          checks.push({ kind: "citations", count: n, text: `《${a.filename}》有 ${n} 处引用要逐条决定${c.unsupported ? `（${c.unsupported} 处标为不支持，须改正）` : ""}`, target: { artifact_version_id: a.artifact_version_id } });
      }
      return { checks, total: checks.reduce((k, x) => k + x.count, 0) };
    },
    "todos.list": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      return { ...listTodos(db, matter.matter_id), derived: derivedTodos(db, matter.matter_id) };
    },
    "todos.create": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterWriter(db, matter.matter_id, id);
      assertNotSample(db, matter.matter_id, "加待办");
      const todo = createTodo(db, { tenant_id: matter.tenant_id, matter_id: matter.matter_id, created_by: id.userId, title: p?.title, assignee_kind: p?.assignee_kind, assignee_name: p?.assignee_name, reviewer_name: p?.reviewer_name, due_date: p?.due_date });
      audit(db, id, "todo.created", "todo", todo.todo_id, undefined, keyctx);
      return { todo };
    },
    "todos.update": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterWriter(db, matter.matter_id, id);
      assertNotSample(db, matter.matter_id, "改待办");
      const patch = (p?.patch ?? {}) as Record<string, unknown>;
      const todo = updateTodo(db, matter.matter_id, id.userId, String(p?.todo_id ?? ""), patch);
      audit(db, id, "todo.updated", "todo", todo.todo_id, sha256Hex(JSON.stringify({ fields: Object.keys(patch).sort(), status: todo.status })), keyctx);
      return { todo };
    },
    "todos.delete": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterWriter(db, matter.matter_id, id);
      assertNotSample(db, matter.matter_id, "删待办");
      deleteTodo(db, matter.matter_id, String(p?.todo_id ?? ""));
      audit(db, id, "todo.deleted", "todo", String(p?.todo_id ?? ""), undefined, keyctx);
      return { ok: true };
    },
    // 材料初判（v9.4 第 22 批，C1 #28）：本机按规则认文书类型、合同类型与篇幅，只做建议，不调用 AI、不改原件
    "materials.triage": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      return { items: triageMatter(db, matter.matter_id) };
    },
    // 本事项的审查要点（v9.4 第 22 批，C1 #21、#22）：律师写或审定启用；审合同的任务发起时快照在用的一版。文字不进审计，审计记版本与摘要
    "review_rules.get": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      return listRuleSets(db, matter.matter_id);
    },
    "review_rules.save": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterWriter(db, matter.matter_id, id);
      assertNotSample(db, matter.matter_id, "设审查要点");
      const v = db.tx(() => saveRules(db, { tenantId: matter.tenant_id, matterId: matter.matter_id, userId: id.userId }, { title: p?.title, rules: p?.rules, from_draft: p?.from_draft, base_version: p?.base_version }));
      audit(db, id, "review_rules.saved", "matter", matter.matter_id, sha256Hex(JSON.stringify({ version: v.version, sha256: v.sha256, rules: v.rules.length, from_draft: !!p?.from_draft })), keyctx);
      return { ...listRuleSets(db, matter.matter_id), saved: v };
    },
    "review_rules.retire": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterWriter(db, matter.matter_id, id);
      assertNotSample(db, matter.matter_id, "停用审查要点");
      const r = retireRules(db, matter.matter_id, p?.base_version);
      if (r.retired) audit(db, id, "review_rules.retired", "matter", matter.matter_id, undefined, keyctx);
      return listRuleSets(db, matter.matter_id);
    },
    "review_rules.discard_draft": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterWriter(db, matter.matter_id, id);
      discardDraft(db, matter.matter_id, String(p?.rule_set_id ?? ""));
      audit(db, id, "review_rules.draft_discarded", "matter", matter.matter_id, undefined, keyctx);
      return listRuleSets(db, matter.matter_id);
    },
    // 我的写作偏好（v9.4 第 22 批，C1 #29）：只存格式与文风，按律师本人存在本机
    "writing_prefs.get": (_p, id) => getWritingPrefs(db, id.tenantId, id.userId),
    "writing_prefs.set": (p, id) => {
      const prefs = setWritingPrefs(db, id.tenantId, id.userId, (p ?? {}) as Record<string, unknown>, tokens ? (mid, text) => tokens.partiesIn(mid, text) : undefined);
      audit(db, id, "writing_prefs.set", "user", id.userId, sha256Hex(JSON.stringify({ signature: !!prefs.signature, citation: prefs.citation, notes: !!prefs.notes })), keyctx);
      return prefs;
    },
    // 本所范本库（v9.4 第 24 批，C1 #23；10-23 拍板）：律师主动放入、去掉客户信息的范本；按律所存在这台电脑，不发给 AI。文字不进审计
    "firm_templates.list": (_p, id) => ({ templates: listTemplates(db, id.tenantId), contract_types: TEMPLATE_CONTRACT_TYPES }),
    "firm_templates.get": (p, id) => getTemplate(db, id.tenantId, String(p?.template_id ?? "")),
    /**
     * 放入范本：文件（Word / 纯文本）或粘贴的文字。逐条查像客户信息的写法（本人全部事项的当事人含简称别名、案号、证件号、手机号、账号、邮箱）：
     * 查到且没要求替换的不保存，返回 needs_cleanup 与命中清单；replace_hits = true 时换成【】占位符后保存。
     */
    "firm_templates.add": (p, id) => {
      let text: string;
      let sourceName: string | null = null;
      if (p?.file || typeof p?.data_base64 === "string") {
        const name = String(p?.filename ?? (p?.file ? String(p.file).split(/[\\/]/).pop() : "") ?? "");
        if (!/\.(docx|txt)$/i.test(name)) throw new DomainError("unsupported_file", "请放入 Word 文档（.docx）或纯文本（.txt）；PDF 和扫描件请先转成 Word", 422);
        let bytes: Buffer;
        if (p?.file) {
          if (statSync(String(p.file)).size > 5 * 1024 * 1024) throw new DomainError("validation", "范本文件过大（上限 5 MB）", 422);
          bytes = readFileSync(String(p.file));
        } else bytes = Buffer.from(String(p.data_base64), "base64");
        text = parseDocument(name, /\.txt$/i.test(name) ? "text/plain" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes).text;
        sourceName = name.slice(0, 120);
      } else if (typeof p?.text === "string") text = p.text;
      else throw validation("请选择范本文件或粘贴范本正文");
      const t = prepareTemplate({ title: p?.title, contract_type: p?.contract_type, stance: p?.stance, note: p?.note, text });
      const myMatters = tokens
        ? db.all<{ matter_id: string }>(`SELECT m.matter_id FROM matters m JOIN matter_members mm ON mm.matter_id = m.matter_id AND mm.user_id = ? AND mm.removed_at IS NULL WHERE m.tenant_id = ? AND m.lifecycle <> 'purged'`, [id.userId, id.tenantId])
        : [];
      const spans = (txt: string) => myMatters.flatMap((m) => tokens!.partySpansIn(m.matter_id, txt));
      // 名称、说明里也不能有客户信息（列表里会显示）
      const meta = findHits([{ seq: -1, heading: "", text: [t.title, t.stance ?? "", t.note ?? ""].join("\n") }], spans);
      if (meta.length > 0) throw validation(`范本名称、立场或说明里${HIT_KIND_TEXT[meta[0]!.kind]}（${meta[0]!.text}）：请改成不指向具体客户的写法`);
      const hits = findHits(t.clauses, spans);
      if (hits.length > 0 && p?.replace_hits !== true) {
        return { status: "needs_cleanup", hits: hits.slice(0, 200).map((h) => ({ ...h, heading: t.clauses.find((c) => c.seq === h.seq)?.heading ?? "", reason: HIT_KIND_TEXT[h.kind] })), clauses: t.clauses.length };
      }
      const saved = saveTemplate(db, { tenantId: id.tenantId, userId: id.userId }, hits.length > 0 ? { ...t, clauses: replaceHits(t.clauses, hits) } : t, sourceName);
      audit(db, id, "firm_template.added", "firm_template", saved.template_id, saved.sha256, keyctx);
      return { status: "saved", template: saved, replaced: hits.length };
    },
    "firm_templates.remove": (p, id) => {
      const tid = String(p?.template_id ?? "");
      removeTemplate(db, id.tenantId, tid);
      audit(db, id, "firm_template.removed", "firm_template", tid, undefined, keyctx);
      return { templates: listTemplates(db, id.tenantId) };
    },
    // 审查工作台卡片的“本所范本对此条的写法”：只在本机比对，不发给 AI；同类合同的范本优先，立场不同的标出来
    "firm_templates.for_card": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      const card = db.get<{ document_version_id: string | null; kind: string | null; anchor_text: string; issue: string; suggestion: string | null; clause_ref: string | null }>(
        `SELECT document_version_id, kind, anchor_text, issue, suggestion, clause_ref FROM risk_cards WHERE card_id = ? AND matter_id = ?`,
        [String(p?.card_id ?? ""), matter.matter_id],
      );
      if (!card) throw notFound("卡片");
      const contractType = card.document_version_id ? (triageMatter(db, matter.matter_id).find((x) => x.document_version_id === card.document_version_id)?.contract_type ?? null) : null;
      const text = [card.clause_ref ?? "", card.issue, card.suggestion ?? "", card.kind === "missing" ? "" : card.anchor_text].join("\n");
      return { items: matchClauses(db, id.tenantId, { text, contract_type: contractType, stance: matter.stance ?? null }), library_size: listTemplates(db, id.tenantId).length };
    },
    "facts.list": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      const facts = listFacts(db, matter.matter_id, { run_id: p?.run_id, status: p?.status });
      // 事实引文的页码（v9.4 第 22 批）：PDF 等按页解析的材料
      const pages = quotePages({ db, blobs, ...(tokens ? { tokens } : {}) }, matter.matter_id, facts.filter((f) => f.anchor_status === "located").map((f) => ({ key: f.fact_id, document_version_id: f.document_version_id ?? null, start: (f as { anchor_start?: number | null }).anchor_start ?? null, quote: f.quote ?? null })));
      return { facts: facts.map((f) => (pages.has(f.fact_id) ? { ...f, page: pages.get(f.fact_id) } : f)) };
    },
    "facts.decide": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterWriter(db, matter.matter_id, id);
      const fact = decideFact(db, matter.matter_id, id.userId, { fact_id: p?.fact_id, decision: p?.decision, statement: p?.statement });
      audit(db, id, "fact.decided", "fact", fact.fact_id, sha256Hex(JSON.stringify({ status: fact.status })), keyctx);
      return { fact };
    },

    "documents.patch": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterWriter(db, matter.matter_id, id);
      if (!tokens) throw new DomainError("provider_unavailable", "令牌化工作区未启用", 503);
      const r = applyStructuredPatches({ db, blobs, tokens }, {
        matter_id: matter.matter_id,
        document_version_id: String(p?.document_version_id ?? ""),
        patches: Array.isArray(p?.patches) ? p.patches : [],
        created_by: id.userId,
        run_id: typeof p?.run_id === "string" ? p.run_id : null,
      });
      // 审计只记摘要（补丁条数与结果），不记正文
      audit(db, id, r.status === "applied" ? "document.patch_applied" : "document.patch_preview", "document_version", String(p?.document_version_id ?? ""), sha256Hex(JSON.stringify({ n: Array.isArray(p?.patches) ? p.patches.length : 0, status: r.status })), keyctx);
      return r;
    },
    /**
     * 可信界面渲染用：代号 → 原文（本人对事项有访问权；内核 API 只对主进程与渲染层开放，Agent 与执行域无法调用）。
     * 隐私安全审查 P1-5：按（成员, 事项）计量——每分钟调用与还原条数有上限（界面渲染远低于此；超限说明有程序在批量取原文），
     * 还原记“事项内容审计”（只记条数，不记代号与原文），同一成员同一事项按分钟合并为一条。
     */
    /**
     * 发送视图（v9.2 §3.4；Y4 #15）：某份材料令牌化之后模型会看到的前若干字、代号位置与疑似未替换姓名的位置。
     * 与出站闸门同一套令牌化器预跑（不写回、不出站）；不返回代号真值——界面悬停时经受审计、限量的 matters.tokens.restore 逐个还原。
     */
    "materials.send_preview": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      if (!tokens) throw new DomainError("provider_unavailable", "令牌化工作区未启用", 503);
      const level = dataLevelOf(matter.confidentiality, matter.consent_status);
      const r = sendPreview(db, tokens, matter.matter_id, String(p?.document_version_id ?? ""), level === "L3a" || matter.full_pseudonym === 1);
      if (!r) throw notFound("材料");
      return r;
    },
    /** 发送前疑似未替换的姓名（Y5 §4.3 ②③）：对任务将用到的材料与任务说明预跑后二次检测，去掉律师已判“不是姓名”的。只在本机界面显示。 */
    "matters.suspects.list": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      if (!tokens) throw new DomainError("provider_unavailable", "令牌化工作区未启用", 503);
      const docIds = Array.isArray(p?.document_version_ids) ? (p.document_version_ids as unknown[]).map(String).slice(0, 50) : [];
      const level = dataLevelOf(matter.confidentiality, matter.consent_status);
      const r = summarizeSend(db, tokens, matter.matter_id, docIds, String(p?.goal ?? ""), level === "L3a" || matter.full_pseudonym === 1, { fullScan: level === "L3a", extraTexts: [String(matter.stance ?? ""), String(matter.jurisdiction ?? "")] });
      return { suspects: r.suspects.slice(0, 200) as SuspectView[], summary: r.summary };
    },
    /** 律师对疑似姓名的判定：是姓名 → 加入当事人名单（之后发送前替换）；不是 → 本事项不再提示。审计只记条数。 */
    "matters.suspects.review": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterWriter(db, matter.matter_id, id);
      if (!tokens) throw new DomainError("provider_unavailable", "令牌化工作区未启用", 503);
      const items = Array.isArray(p?.items) ? (p.items as { value?: unknown; decision?: unknown }[]) : [];
      if (items.length === 0 || items.length > 200) throw validation("须有 1–200 条判定");
      const clean = items.map((x) => ({ value: String(x?.value ?? "").trim(), decision: x?.decision }));
      for (const x of clean) {
        if (x.value.length < 2 || x.value.length > 64) throw validation("每条文字须为 2–64 字");
        if (x.decision !== "name" && x.decision !== "not_name") throw validation("判定须为 name 或 not_name");
      }
      const names = clean.filter((x) => x.decision === "name");
      const rejected: string[] = [];
      db.tx(() => {
        for (const x of names) {
          try {
            tokens.upsertParty(matter.matter_id, { name: x.value, kind: "person" }, id.userId);
          } catch (e) {
            rejected.push(`${x.value}：${(e as Error).message}`);
            continue;
          }
          recordSuspectReview(db, matter.matter_id, x.value, "name", id.userId);
        }
        for (const x of clean.filter((y) => y.decision === "not_name")) recordSuspectReview(db, matter.matter_id, x.value, "not_name", id.userId);
        // 词典变了：出站令牌化随之改变（同 matters.parties.upsert）
        if (names.length > rejected.length) db.run(`UPDATE matters SET policy_version = policy_version + 1 WHERE matter_id = ?`, [matter.matter_id]);
      });
      audit(db, id, "matter.suspects_reviewed", "matter", matter.matter_id, sha256Hex(JSON.stringify({ name: names.length - rejected.length, not_name: clean.length - names.length, rejected: rejected.length })), keyctx);
      return { added_to_parties: names.length - rejected.length, dismissed: clean.length - names.length, rejected };
    },
    "matters.tokens.restore": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      if (!tokens) throw new DomainError("provider_unavailable", "令牌化工作区未启用", 503);
      const text = String(p?.text ?? "");
      if (text.length > 2_000_000) throw validation("文本过长");
      const m = restoreWindow(id, matter.matter_id);
      // 单次调用同样受条数上限约束（复核 B3-A16）：先数文本里的代号，累计会超出即拒绝——不能一次取走整张令牌表
      const incoming = countTokens(text);
      if (m.calls >= RESTORE_MAX_CALLS_PER_MIN || m.restored + incoming > RESTORE_MAX_TOKENS_PER_MIN) {
        if (!m.throttled) {
          // 限流本身记审计（复核 B3-A15：最值得追查的正是这类批量取原文）
          m.throttled = true;
          safeAudit(id, "matter.tokens_restore_throttled", matter.matter_id, { calls: m.calls, restored: m.restored, incoming, window_start: new Date(m.windowStart).toISOString() });
        }
        throw new DomainError("rate_limited", "还原请求过于频繁，已暂停一分钟（界面正常浏览不会触发；如持续出现请联系所内 IT）", 429);
      }
      if (!m.started) {
        m.started = true;
        safeAudit(id, "matter.tokens_restore_started", matter.matter_id, { window_start: new Date(m.windowStart).toISOString() });
      }
      m.calls++;
      const r = tokens.restore(matter.matter_id, text);
      m.restored += r.restored;
      return r;
    },

    // ─── 控制面与律所治理（v9 阶段 6：控制面最小集；T17 控制面被攻破演练） ───
    // 状态不含任何令牌；告警是控制面下发内容未通过本机核验的记录（“拒绝或告警”）
    "control_plane.status": () => ({
      ...(deps.governance?.status() ?? { mode: "local_dev" }),
      last_sync: deps.controlPlane?.lastSync ?? null,
    }),
    "control_plane.sync": async () => {
      if (!deps.controlPlane || !deps.governance) return { mode: "local_dev", note: "未配置控制面（开发形态：律所策略取本机配置项，不检查许可）" };
      // 手动同步：连同控制面拒绝过的待同步吊销一起重发（自动同步不重发；复核 S6-A22）
      const report = await deps.controlPlane.sync({ retryFailed: true });
      return { report, status: deps.governance.status() };
    },
    "control_plane.alerts.ack": (p, id) => {
      requireFirmAdmin(id);
      if (!deps.governance) throw notFound("告警");
      const ok = deps.governance.ackAlert(Number(p?.alert_id), id.userId);
      if (!ok) throw notFound("告警");
      audit(db, id, "control_plane.alert_ack", "control_plane", String(p?.alert_id), undefined, keyctx);
      return { ok: true };
    },
    // 管理员：律所策略与连接器登记的起草、签名（本机设备签名；签名前在本机重算放宽项）、发布
    "firm_policy.drafts": async (_p, id) => {
      requireAdminDevice(id);
      return { drafts: await cpCall(() => deps.controlPlane!.drafts()) };
    },
    "firm_policy.create_draft": async (p, id) => {
      requireAdminDevice(id);
      const kind = p?.kind === "connector" ? "connector" : "policy";
      const draft = await cpCall(() =>
        kind === "policy"
          ? deps.controlPlane!.createDraft({ kind: "policy", body: p?.body, ...(p?.ttl_days !== undefined ? { ttl_days: Number(p.ttl_days) } : {}) })
          : deps.controlPlane!.createDraft({ kind: "connector", connector: p?.connector }),
      );
      audit(db, id, "firm_policy.draft", kind, draft.draft_id, sha256Hex(JSON.stringify(draft.relaxations)), keyctx);
      return { draft };
    },
    "firm_policy.sign": async (p, id) => {
      requireAdminDevice(id);
      // 签名绑定界面所见的确切内容（复核 S6-B02）：界面交回它展示的草稿摘要，内核比对后才签
      const draft = await cpCall(() => deps.controlPlane!.signDraft(String(p?.draft_id ?? ""), String(p?.expected_digest ?? "")));
      audit(db, id, "firm_policy.sign", draft.kind, draft.draft_id, sha256Hex(JSON.stringify({ relaxations: draft.relaxations, version: (draft.doc as { version?: number }).version ?? null })), keyctx);
      return { draft };
    },
    "firm_policy.publish": async (p, id) => {
      requireAdminDevice(id);
      await cpCall(() => deps.controlPlane!.publishDraft(String(p?.draft_id ?? "")));
      audit(db, id, "firm_policy.publish", "draft", String(p?.draft_id ?? ""), undefined, keyctx);
      // 发布后立即同步：本机按同一规则独立核验后才生效
      const report = await deps.controlPlane!.sync();
      return { report, status: deps.governance!.status() };
    },
    // ─── 用量与上限（第 9 批 S3）：本所本月用量、律所设的月度上限（硬停）；管理员与合伙人另看按成员明细 ───
    "quota.status": async (_p, id) => {
      if (!deps.controlPlane) return { mode: "local_dev", note: "未配置控制面（开发形态：额度只在开发网关内存里）" };
      const view = await cpCall(() => deps.controlPlane!.quota());
      // 成员编号换成本机成员名（控制面只有编号）
      const names = new Map(db.all<{ user_id: string; display_name: string }>(`SELECT user_id, display_name FROM users WHERE tenant_id = ?`, [id.tenantId]).map((r) => [r.user_id, r.display_name]));
      return {
        mode: "control_plane",
        ...view,
        ...(view.by_member ? { by_member: view.by_member.map((m) => ({ ...m, name: m.member_id ? (names.get(m.member_id) ?? null) : null })) } : {}),
      };
    },
    "quota.set_cap": async (p, id) => {
      requireAdminDevice(id);
      const raw = p?.monthly_cap;
      // 空串、布尔等不按 0 处理（复核 S9A-20：上限 0 = 立即停）
      const cap = raw === null ? null : typeof raw === "number" || (typeof raw === "string" && /^\d+$/.test(raw)) ? Number(raw) : NaN;
      if (cap !== null && !(Number.isSafeInteger(cap) && cap >= 0)) throw validation("月度上限须为非负整数点数，或不设上限");
      const r = await cpCall(() => deps.controlPlane!.setQuotaCap(cap));
      audit(db, id, "quota.cap_set", "tenant", id.tenantId, sha256Hex(JSON.stringify({ cap })), keyctx);
      return r;
    },
    // ─── 中软侧操作记录（第 9 批 S14）：取回、验控制面签名与哈希链、本机留存；律所管理员与合伙人可看、可导出 ───
    "control_plane.audit": async (p, id) => {
      requireFirmAdmin(id);
      let fetched: { added: number; head: number; withheld: boolean } | null = null;
      let fetch_error: string | null = null;
      if (deps.controlPlane) {
        try {
          fetched = await deps.controlPlane.fetchAudit();
        } catch (e) {
          fetch_error = (e as Error)?.message ?? "fetch_failed";
          // 本机成员角色与设备证书角色不一致（控制面按证书判断）：写明原因（复核 S9A-18）
          if (fetch_error === "revoker_required") fetch_error = "device_role_required";
        }
      }
      const limit = Math.max(1, Math.min(500, Number(p?.limit ?? 200) || 200));
      const before = p?.before_seq === undefined ? undefined : Number(p.before_seq);
      const records = deps.governance ? deps.governance.auditRecords(limit, Number.isSafeInteger(before) ? before : undefined) : [];
      const devMember = new Map(db.all<{ device_id: string; display_name: string | null }>(`SELECT d.device_id, u.display_name FROM devices d LEFT JOIN users u ON u.user_id = d.member_id WHERE d.tenant_id = ?`, [id.tenantId]).map((r) => [r.device_id, r.display_name]));
      // 目标是设备编号或席位编号（复核 S9A-11 后成员相关的对象改记席位编号）：本机自己的席位写“你的席位”；
      // 签发凭据与分配席位的席位属于执行者本人，按执行者的成员名写“××的席位”；收回别人的席位只显示席位编号（复核 S9A-24）
      const mySid = deps.governance?.seatInfo().sid ?? null;
      const SEAT_OF_ACTOR = new Set(["seat_token.issue", "support_token.issue", "seat.assign"]);
      return {
        mode: deps.controlPlane ? "control_plane" : "local_dev",
        fetched,
        fetch_error,
        records: records.map((r) => {
          const actor_name = r.actor.kind === "device" ? (devMember.get(r.actor.id) ?? null) : null;
          const target_name = !r.target ? null : r.target === mySid ? "你的席位" : SEAT_OF_ACTOR.has(r.action) && actor_name ? `${actor_name}的席位` : (devMember.get(r.target) ?? null);
          return { ...r, actor_name, target_name };
        }),
      };
    },
    "control_plane.audit_export": async (p, id) => {
      requireFirmAdmin(id);
      if (!deps.governance) throw notFound("中软侧操作记录");
      // 导出前先取一次最新（复核 S9A-12）；取不到照常导出本机留存的，并写明截至哪一次取回
      let fetchNote: string | null = null;
      if (deps.controlPlane) {
        try {
          const f = await deps.controlPlane.fetchAudit();
          if (f.withheld) fetchNote = "cloud_withheld";
        } catch (e) {
          fetchNote = String((e as Error)?.message ?? "fetch_failed").slice(0, 60);
        }
      }
      const records: CpAuditRecord[] = [];
      for (let before: number | undefined; ; ) {
        const page = deps.governance.auditRecords(1000, before);
        records.push(...page);
        if (page.length < 1000) break;
        before = page.at(-1)!.seq;
      }
      records.reverse();
      // 导出原记录（含 prev/hash，收件人可自行验链）；只有代码与编号
      const signed = deps.governance.signedAuditPage();
      const text = `${JSON.stringify(
        {
          format: "kwl-cp-audit-export/1",
          tenant_id: id.tenantId,
          exported_at: new Date().toISOString(),
          fetch_note: fetchNote,
          // 最后一次取到最新时那一页的控制面签名信封：用控制面公钥核对，其 head 与 records 末条一致即“截至云端序号 N”
          signed_page: signed ? { fetched_at: signed.fetched_at, envelope: signed.envelope } : null,
          records,
        },
        null,
        2,
      )}\n`;
      audit(db, id, "control_plane.audit_export", "tenant", id.tenantId, sha256Hex(text), keyctx);
      const filename = `zr-cloud-operations-${new Date().toISOString().slice(0, 10)}.json`;
      if (!p?.save_path) return { filename, saved: false, count: records.length, data_base64: Buffer.from(text, "utf8").toString("base64") };
      const saved = writeExportFile(String(p.save_path), Buffer.from(text, "utf8"), config.workspaceDir);
      return { filename: saved.name, saved: true, count: records.length };
    },
    // 公钥变更只影响本机今后向该设备包裹事项密钥：由本机当前成员核对（事项密钥由各成员设备各自包裹；复核 S6-A03）
    "devices.key_changes.confirm": (p, id) => {
      const member = db.get(`SELECT 1 AS x FROM memberships WHERE tenant_id = ? AND user_id = ?`, [id.tenantId, id.userId]);
      if (!member) throw forbidden("需要本所成员身份");
      if (!deps.governance) throw notFound("公钥变更");
      const r = deps.governance.confirmKeyChange(String(p?.device_id ?? ""), String(p?.safety_code ?? ""), id.userId);
      if (!r.ok) throw validation(r.reason);
      return { ok: true, note: "已核对安全码并替换公钥：此后本机的事项密钥包裹使用新公钥" };
    },

    // ─── 设备与密钥纪元（§5.3：吊销设备证书 → tenant 纪元递增；撤权校验不依赖时钟） ───
    "devices.list": (_p, id) => {
      const rows = db.all(
        `SELECT device_id, member_id, role, status, revoked_at, revoked_epoch, key_epoch_at_issue, created_at
           FROM devices WHERE tenant_id = ? ORDER BY created_at`,
        [id.tenantId],
      );
      // 本机安全码（同事核对本机公钥变更时由本人读出；复核 S6-A03）
      return { devices: rows, tenant_epoch: currentTenantEpoch(db, id.tenantId), my_device_id: keyctx.device.deviceId, my_safety_code: deps.governance?.mySafetyCode() ?? null };
    },

    "devices.revoke": async (p, id) => {
      const role = db.get<{ role: string }>(`SELECT role FROM memberships WHERE tenant_id = ? AND user_id = ?`, [id.tenantId, id.userId])?.role;
      if (role !== "firm_admin" && role !== "partner") throw forbidden("吊销设备需要管理员或合伙人角色");
      const deviceId = String(p?.device_id ?? "");
      const dev = db.get<any>(`SELECT device_id, status FROM devices WHERE device_id = ? AND tenant_id = ?`, [deviceId, id.tenantId]);
      if (!dev) throw notFound("设备");
      // 停用这台电脑自己须明确说明（复核 R15A-03：界面不提供；只给运维与用例）
      if (deviceId === keyctx.device.deviceId && dev.status !== "revoked" && p?.self !== true) throw validation("不能在这台电脑上停用它自己：请在另一台管理员或合伙人的电脑上操作");
      if (dev.status === "revoked") return { device_id: deviceId, status: "revoked", tenant_epoch: currentTenantEpoch(db, id.tenantId), note: "设备此前已吊销" };
      const reason = String(p?.reason ?? "管理员吊销");
      db.tx(() => {
        const next = currentTenantEpoch(db, id.tenantId) + 1;
        db.run(`UPDATE devices SET status = 'revoked', revoked_at = ?, revoked_epoch = ? WHERE device_id = ?`, [new Date().toISOString(), next, deviceId]);
        db.run(`INSERT INTO key_epochs (scope, scope_id, epoch, reason) VALUES ('tenant', ?, ?, ?)`, [id.tenantId, next, `device.revoke ${deviceId}：${reason}`]);
        // 同步到控制面（复核 S6-A12、S6-B04）：墓碑与待同步队列和本机吊销在同一事务里（复核 S6-B36：不会留下“本机已吊销、却永远不同步”）
        deps.governance?.recordLocalRevocation(deviceId);
      });
      audit(db, id, "device.revoke", "device", deviceId, undefined, keyctx);
      // 立即尝试一次；完成以控制面签名的设备目录把该设备列为吊销为准（复核 S6-B31），不成功留在队列里随每次同步重试
      const cp = deps.controlPlane ? await deps.controlPlane.syncRevocation(deviceId).catch(() => "pending" as const) : "not_configured";
      const cpNote: Record<string, string> = {
        synced: "。控制面已确认（设备目录已列为吊销）：网关与检索服务将拒绝该设备",
        submitted: "。控制面已接受，待控制面签名的设备目录确认（每次同步自动核对；在此之前网关可能仍接受该设备）",
        pending: "。控制面暂未确认：已排队，联网后自动重试（在此之前网关可能仍接受该设备）",
        failed: "。控制面拒绝了由本设备发起的吊销（见“律所策略”页的待同步项）：不会自动重试，需人工处理——请由管理员或合伙人设备再次吊销该设备；控制面目录列为吊销后此项自动消除",
        not_configured: "",
      };
      const lawyerNote: Record<string, string> = {
        synced: "已停用这台电脑：中软已确认，它不能再同步、用 AI、签发或导出。电脑上已有的内容无法远程删除，请按律所制度收回电脑。",
        submitted: "已停用这台电脑：中软已收到，正在生效（通常几分钟内）。电脑上已有的内容无法远程删除，请按律所制度收回电脑。",
        pending: "已在这台电脑上停用它；中软暂时连不上，联网后自动补发，在那之前它可能仍能用 AI。电脑上已有的内容无法远程删除。",
        failed: "已在这台电脑上停用它，但中软拒绝了这次停用（可能这台电脑没有停用别人的权限）：请在管理员或合伙人的电脑上再停用一次。",
        not_configured: "已在这台电脑上停用它。",
      };
      return {
        device_id: deviceId,
        status: "revoked",
        tenant_epoch: currentTenantEpoch(db, id.tenantId),
        control_plane: cp,
        lawyer_note: lawyerNote[cp] ?? lawyerNote.not_configured,
        note: `已吊销并推进密钥纪元：该设备写入共享文件夹的段此后一律拒收（含吊销前尚未导入的部分）；其历史签名仍可验签（状态如实单列）；已解密、已导出的明文无法远程收回${cpNote[cp] ?? ""}`,
      };
    },

    // ─── 事项成员与密钥分发（§5.3：加入补包裹、移出轮换密钥） ───
    "matters.members.add": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      // 成员链（第 12 批）：先补写到期的吊销标记、刷新投影（下面的负责人检查读投影）
      refreshChain(chainDeps(id), matter.matter_id);
      requireMatterOwner(db, matter.matter_id, id);
      requireRelayController(matter.matter_id, "加入成员");
      requireNoSyncAlert(matter.matter_id, "加入成员");
      // 结案或已删除的事项不再加入成员（复核 C-A05；须先重新打开）
      requireActiveMatter(db, matter.matter_id);
      const userId = String(p?.user_id ?? "");
      if (!userId) throw validation("需要 user_id");
      const matterRole = String(p?.matter_role ?? "editor");
      if (!["owner", "editor", "reviewer", "issuer", "viewer"].includes(matterRole)) throw validation("matter_role 非法");
      // 中继控制成员降为非负责人之前须先移交（第 12 批：否则此后谁都不能在中继上调整成员、轮换密钥）
      if (matterRole !== "owner" && deps.shareRelay?.controllerOf(matter.matter_id) === userId) throw forbidden("对方是这个事项在中软共享中继上的控制成员：请先把控制成员移交给另一位负责人，再调整其角色");
      // 成员链（第 12 批）：加人与改角色是成员事件，带对方在用设备在当前纪元的包裹摘要
      if (hasChain(db, matter.matter_id)) {
        const r = db.tx(() => {
          db.run(`INSERT OR IGNORE INTO users (user_id, tenant_id, display_name) VALUES (?,?,?)`, [userId, id.tenantId, userId]);
          db.run(`INSERT OR IGNORE INTO memberships (membership_id, tenant_id, user_id, role) VALUES (?,?,?,'lawyer')`, [newId("membership"), id.tenantId, userId]);
          return addOrUpdateMember(chainDeps(id), matter.matter_id, userId, matterRole);
        });
        audit(db, id, "matter.member_add", "matter", matter.matter_id, userId, keyctx);
        return {
          matter_id: matter.matter_id,
          user_id: userId,
          epoch: r.epoch,
          devices_wrapped: r.wrapped,
          note:
            r.wrapped > 0
              ? "已按当前密钥纪元为对方 active 设备补包裹（对方设备方可解事项密钥）；变更已记入成员链"
              : "变更已记入成员链；对方的设备（含之后登记的）由负责人的电脑在同步时自动补发密钥",
        };
      }
      const epoch = currentMatterEpoch(db, matter.matter_id);
      const devices = db.all<{ device_id: string; enc_pub_pem: string }>(
        `SELECT device_id, enc_pub_pem FROM devices WHERE tenant_id = ? AND member_id = ? AND status = 'active'`,
        [id.tenantId, userId],
      );
      const rowLamport = nextMemberLamport(db, matter.matter_id);
      db.tx(() => {
        db.run(`INSERT OR IGNORE INTO users (user_id, tenant_id, display_name) VALUES (?,?,?)`, [userId, id.tenantId, userId]);
        db.run(`INSERT OR IGNORE INTO memberships (membership_id, tenant_id, user_id, role) VALUES (?,?,?,'lawyer')`, [newId("membership"), id.tenantId, userId]);
        // 曾墓碑的行：复活须显式授权动作（清除墓碑并刷新作者权威/行 lamport），不是同步副作用
        db.run(
          `INSERT INTO matter_members (matter_id, user_id, matter_role, added_by, removed_at, removed_lamport, author_device, row_lamport)
           VALUES (?,?,?,?,NULL,NULL,?,?)
           ON CONFLICT(matter_id, user_id) DO UPDATE SET matter_role = excluded.matter_role, removed_at = NULL, removed_lamport = NULL,
             -- 移出后加回：加入时刻刷新，导出按水位才会再带上这一行（第 11 批复核 S11B 既有缺陷：否则对端一直停在“已移出”）
             added_at = excluded.added_at,
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
      // 成员链（第 12 批）：先补写到期的吊销标记、刷新投影（下面的负责人检查读投影）
      refreshChain(chainDeps(id), matter.matter_id);
      requireMatterOwner(db, matter.matter_id, id);
      requireRelayController(matter.matter_id, "移出成员");
      requireNoSyncAlert(matter.matter_id, "移出成员");
      const userId = String(p?.user_id ?? "");
      const target = db.get<{ matter_role: string }>(`SELECT matter_role FROM matter_members WHERE matter_id = ? AND user_id = ? AND removed_at IS NULL`, [matter.matter_id, userId]);
      if (!target) throw notFound("事项成员");
      // 已离所的负责人（他的电脑已全部停用，B-10）可以由其他负责人直接移出：他已不能再操作，留着只会让事项一直挂着一位找不到的负责人
      // 复核 R15A-01：只看“电脑都已停用”会把换电脑、丢电脑的人误判成离所——还须本机有移出记录，或调用方明确确认他已离所
      const targetDevices = db.all<{ status: string }>(`SELECT status FROM devices WHERE tenant_id = ? AND member_id = ? AND role <> 'node'`, [id.tenantId, userId]);
      const allStopped = targetDevices.length > 0 && targetDevices.every((d) => d.status !== "active");
      const removedRecord = !!db.get(`SELECT 1 AS x FROM member_removals WHERE tenant_id = ? AND member_id = ?`, [id.tenantId, userId]);
      const departed = allStopped && (removedRecord || p?.confirm_departed === true);
      if (target.matter_role === "owner" && !departed) {
        throw validation(allStopped ? "他的电脑都已停用，但这台电脑不知道他是否已离所（也可能正在换电脑）：确认他已离所后再移出" : "不能移出事项负责人（须先移交负责人）", allStopped ? { reason: "departed_unconfirmed" } : undefined);
      }
      const removeAction = target.matter_role === "owner" ? "matter.member_remove_departed" : "matter.member_remove";
      let newEpoch = 0;
      let wrapped = 0;
      // 成员链（第 12 批）：移出与轮换写在同一条成员事件里（新纪元只包给链上未移出成员的在用设备）
      if (hasChain(db, matter.matter_id)) {
        const r = db.tx(() => rotateChainKey(chainDeps(id), matter.matter_id, { reason: `member.remove ${userId}`, memberChange: { user: userId, role: null } }));
        audit(db, id, removeAction, "matter", matter.matter_id, userId, keyctx);
        return {
          matter_id: matter.matter_id,
          removed: userId,
          new_epoch: r.epoch,
          devices_wrapped: r.wrapped,
          note: "已轮换事项密钥（新纪元）：移出成员的设备拿不到新密钥；其历史签名与旧纪元包裹行保留；变更已记入成员链",
        };
      }
      const removeLamport = nextMemberLamport(db, matter.matter_id);
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
        // 负责人在本机轮换出新纪元（只包给本机认定的成员）：本机的纪元冲突随之解除（第七轮复核 S11B-55 并发轮换的出路）
        db.run(`DELETE FROM sync_alerts WHERE matter_id = ? AND kind = 'epoch_conflict'`, [matter.matter_id]);
        wrapped = remaining.length;
      });
      audit(db, id, removeAction, "matter", matter.matter_id, userId, keyctx);
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
        // 见证行自带 type 列（事件类型）：改名 event_type，行类型标记放最后，不被覆盖（与结案归档同口径）
        ...events.map((e) => JSON.stringify({ ...e, event_type: e.type, type: "signed_event" })),
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
      // 覆盖范围如实说（第 13 批，评审 Z1）：收录不足 50 部即“演示范围”——多数引用无法自动核对，复核页要求逐条人工核对
      const level = st.laws_count < 50 ? "sample" : st.laws_count < 300 ? "partial" : "standard";
      const scope = level === "sample" ? `目前只收录 ${st.laws_count} 部法律法规、${st.articles_count} 条正文（演示范围），多数引用无法自动核对` : `收录 ${st.laws_count} 部 / ${st.versions_count} 个版本`;
      // 期限计算用的节假日表：随法规库签名分发的，还是应用内置的（v9.4 第 22 批，偏离 D-128 回归计划）
      const hs = holidaySource();
      const hy = hs.years_covered;
      const holidays = { from: hs.from, years: hy, text: `节假日表 ${hy.length ? `${hy[0]}—${hy[hy.length - 1]} 年` : "未收录"}（${hs.from === "package" ? "随法规库更新" : "应用内置"}）` };
      return {
        ...st,
        coverage: { level, laws: st.laws_count, articles: st.articles_count },
        holidays,
        display: `${scope} · 法规库最后更新 ${st.built_at.slice(0, 10)} · 签名有效 · ${holidays.text}`,
      };
    },

    // ─── 在线内容更新（第 8 批；v9.2 §5.1 S6 法规增量包、S7 方法模板分发）：只取中软签名的公开内容，不带任何事项信息 ───
    "content.status": () => {
      if (!deps.content) return { configured: false };
      return deps.content.status();
    },
    "content.check": async (p) => {
      if (!deps.content) return { results: [] };
      const kinds = p?.kind === "lawdb" || p?.kind === "skills" ? [p.kind as "lawdb" | "skills"] : (["lawdb", "skills"] as const);
      const results = [];
      for (const k of kinds) results.push(await deps.content.check(k));
      return { results, status: deps.content.status() };
    },

    // ─── 共享文件夹同步（§7.1/§7.2：段式导出/摄取/状态；个人事项与无权限事项不出本机） ───
    "sync.export": (p, id) => {
      assertNotExitMode("同步");
      const shareDir = String(p?.share_dir ?? "");
      if (!shareDir) throw validation("需要 share_dir（律所自有共享目录，§7.2）");
      const r = syncExport(syncDepsOf(id), { shareDir, ...(p?.matter_id ? { matterId: String(p.matter_id) } : {}) });
      audit(db, id, "sync.export", "tenant", id.tenantId, `${r.segments.length} 段 / ${r.rowsExported} 行`, keyctx);
      return {
        ...r,
        note: "已封口写段（临时名→原子改名）；只同步团队事项，个人事项已跳过；共享目录只是介质，本机 SQLite 即权威",
      };
    },

    "sync.import": (p, id) => {
      assertNotExitMode("同步");
      const shareDir = String(p?.share_dir ?? "");
      if (!shareDir) throw validation("需要 share_dir");
      const r = syncImport(syncDepsOf(id), { shareDir });
      audit(db, id, "sync.import", "tenant", id.tenantId, `${r.segmentsApplied} 段应用 / ${r.rowsApplied} 行 / 冲突 ${r.conflicts.length}`, keyctx);
      return {
        ...r,
        note: "只认已封口段；忽略半成品与冲突副本命名（见 warnings）；无权限事项已跳过；被吊销设备写入的段一律拒收（含吊销前尚未导入的部分）",
      };
    },

    "sync.status": (p, id) => {
      const st = syncStatus({ db, blobs, keyctx, tenantId: id.tenantId }, { ...(p?.share_dir ? { shareDir: String(p.share_dir) } : {}) }) as { matters: { matter_id: string; collab_scope: string }[] };
      // 每个团队事项的成员链概况（复核 S12B-13：是否锚定、待定条数、链上纪元）
      for (const m of st.matters) if (m.collab_scope === "team") (m as Record<string, unknown>).member_log = chainSummary(chainDeps(id), m.matter_id);
      return { ...st, alerts: syncAlertsView(db, keyctx.device.deviceId) };
    },

    // ─── 成员链（第 12 批；member-log.ts） ───
    // 事项的成员链概况与事件列表（只有编号、种类、作者成员、逻辑时钟与状态；不含包裹）
    "matters.member_log": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      const summary = chainSummary(chainDeps(id), matter.matter_id);
      if (!summary.anchored) return { matter_id: matter.matter_id, ...summary, events: [] };
      const v = chainView(chainDeps(id), matter.matter_id);
      const events = [...v.events.values()]
        .sort((a, b) => a.p.lamport - b.p.lamport || (a.id < b.id ? -1 : 1))
        .map((e) => {
          const st = v.status.get(e.id);
          const b = e.p.body as Record<string, unknown>;
          const key = b.key as { epoch?: number } | undefined;
          return {
            event_id: e.id,
            kind: e.p.kind,
            lamport: e.p.lamport,
            at: e.p.at,
            author_member: e.member,
            author_device: e.p.author_device,
            user: typeof b.user === "string" ? b.user : null,
            role: b.role === undefined ? undefined : b.role,
            epoch: key?.epoch ?? null,
            status: st?.s ?? "pending",
            reason: st && st.s !== "valid" ? st.why : null,
            root: v.root?.id === e.id,
          };
        });
      return { matter_id: matter.matter_id, ...summary, events };
    },
    // 中继控制成员移交（D-94 在链上表达）：本人须是中继上的控制成员，对方须是链上在册的负责人；先调中继（控制权以中继为准），成功后写 control 事件
    "matters.relay_handoff": async (p, id) => {
      assertNotExitMode("中继控制成员移交");
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      refreshChain(chainDeps(id), matter.matter_id);
      requireMatterOwner(db, matter.matter_id, id, "中继控制成员移交需要事项负责人角色");
      // 有同步告警时不移交（复核 S12A-13：待定事件可能正改变谁是负责人）
      if (db.get(`SELECT 1 AS x FROM sync_alerts WHERE matter_id = ? AND kind <> 'revoked_change'`, [matter.matter_id])) throw forbidden("这个事项有团队同步告警，处理之前不能移交中继控制成员");
      if (!deps.shareRelay) throw new DomainError("provider_unavailable", "共享中继未启用", 503);
      if (!hasChain(db, matter.matter_id)) throw validation("该事项还没有成员链：本机同步一次（锚定）后再移交");
      const to = String(p?.to_user ?? "");
      if (deps.shareRelay.controllerOf(matter.matter_id) !== id.userId) throw forbidden("只有中继上的控制成员（最先经中继同步该事项的负责人）可以移交");
      if (to === id.userId) throw validation("不能移交给自己");
      // 对方按成员链（不是投影）须是在册负责人（复核 S12A-13）
      if (chainView(chainDeps(id), matter.matter_id).members.get(to)?.role !== "owner") throw validation("只能移交给本事项在册的负责人（须先把对方设为负责人）");
      // 先按链核一次本人仍是负责人（复核 S12B-24：先改中继、后写链，写链失败时中继上其实已移交）
      if (chainView(chainDeps(id), matter.matter_id).members.get(id.userId)?.role !== "owner") throw forbidden("这台电脑按成员链已不是负责人，不能移交（请先同步）");
      let controller: string;
      try {
        controller = (await deps.shareRelay.handoffControl(matter.matter_id, to)).controller;
      } catch (e) {
        const code = (e as { code?: string })?.code ?? "relay_push_failed";
        if (code === "to_not_reader") throw validation("对方还没有经中继同步过这个事项，或他的电脑已不在这个事项的读者里（含已停用）：请对方先打开并同步一次，再移交", { reason: "to_not_reader" });
        if (code === "not_controller") throw forbidden("中继上的控制成员已不是你（可能上一次移交已经生效）：这台电脑正在向中继重新确认，请稍后查看");
        throw new DomainError("provider_unavailable", `中继暂时不能办理移交（${code}），请稍后再试`, 503);
      }
      let chainNote = "移交已记入成员链";
      try {
        db.tx(() => writeEvent(chainDeps(id), matter.matter_id, "control", { to }));
      } catch {
        // 中继上已经移交（控制权以中继为准）；只是链上的记录没写成（等待中继答复期间本机被降级等）：如实说明，不报失败
        chainNote = "成员链上的移交记录没有写成（这台电脑在移交期间已不是负责人），其他成员的电脑会从中继得知新的控制成员";
      }
      audit(db, id, "matter.relay_handoff", "matter", matter.matter_id, to, keyctx);
      return { matter_id: matter.matter_id, controller, note: `已移交中继控制成员：此后这个事项的成员调整与密钥轮换须由对方操作；${chainNote}` };
    },
    // 本机重新引导该事项（起点冲突、成员事件长期待定时的人工出路）：清本机成员链与已摄取标记，下次收到时按首同步规则重新采用起点
    "matters.sync_rebootstrap": (p, id) => {
      const matterId = String(p?.matter_id ?? "");
      const m = db.get<{ collab_scope: string; lifecycle: string }>(`SELECT collab_scope, lifecycle FROM matters WHERE matter_id = ? AND tenant_id = ?`, [matterId, id.tenantId]);
      // 本机曾是该事项成员即可（被伪造的链移出的成员也要能重新引导）
      if (!m || !db.get(`SELECT 1 AS x FROM matter_members WHERE matter_id = ? AND user_id = ?`, [matterId, id.userId])) throw new DomainError("not_found", "事项不存在或无权查看", 404);
      if (m.collab_scope !== "team" || m.lifecycle === "purged") throw validation("只有团队事项可以重新引导");
      rebootstrapMatter(db, matterId);
      deps.shareRelay?.refetchHistory(matterId);
      audit(db, id, "matter.sync_rebootstrap", "matter", matterId, undefined, keyctx);
      return { matter_id: matterId, note: "已清除本机的成员链：重新确认之前暂停发出该事项；之后只采用本机记录里在册负责人发来的起点（经中继的事项只认中继上的控制成员）" };
    },

    // ─── 成员离所（v9.3 第 14 批续 B-10；评审 Z4 §五第 5 项、P1-8；D-94）───
    // 离所的人在自己电脑上做“离所交接”：只在这台电脑上的事项导出归档交给律所；团队事项把负责人与中继控制交给同事。
    // 管理员在成员页“移出律所”：停用对方全部电脑、释放席位。每台电脑只知道自己参与的事项，所以交接只能由离所的人本人做。
    "members.offboarding": (_p, id) => {
      const rows = db.all<OffboardingMatterRow>(
        `SELECT m.matter_id, m.title, m.collab_scope, m.created_at, m.lifecycle FROM matters m
           JOIN matter_members mm ON mm.matter_id = m.matter_id AND mm.user_id = ? AND mm.removed_at IS NULL AND mm.matter_role = 'owner'
          WHERE m.tenant_id = ? AND m.status = 'active' AND m.lifecycle <> 'purged'
            AND m.matter_id NOT IN (SELECT matter_id FROM sample_matters WHERE removed_at IS NULL)
          ORDER BY m.created_at`,
        [id.userId, id.tenantId],
      );
      const matters = rows.map((m) => offboardingItem(m, id));
      // 按人存在这台电脑上的个人设置（复核 Q4 建议 3）：交接清单最后一步，本人清除
      const personal = { writing_prefs: hasPrefs(getWritingPrefs(db, id.tenantId, id.userId)), qa_conversations: deps.qa?.count(id.tenantId, id.userId) ?? 0 };
      return { matters, pending: matters.filter((x) => x.status !== "ok").length, personal };
    },
    // 被停用的电脑启动时的提示（D-144，10-23 拍板：只提示、不自动清除）：这台电脑已被律所停用，且本人在这台电脑上还有写作偏好或问答记录
    "members.personal_status": (_p, id) => {
      const revoked = deps.governance?.exitMode()?.code === "device_revoked";
      const writingPrefs = hasPrefs(getWritingPrefs(db, id.tenantId, id.userId));
      const qaConversations = deps.qa?.count(id.tenantId, id.userId) ?? 0;
      return { device_revoked: revoked, writing_prefs: writingPrefs, qa_conversations: qaConversations, prompt_clear: revoked && (writingPrefs || qaConversations > 0) };
    },
    // 离所时清除本人在这台电脑上按人存的数据：写作偏好与问答记录（驻留面第 27 类“留存到律师删除”）。
    // 电脑已停用（退出模式）时也能清：这是删除个人数据，不是新的处理；事项里的材料、成果与已发起任务的输入快照按律所留存规则走，不在这里删
    "members.offboard_clear_personal": (_p, id) => {
      const writingPrefs = clearWritingPrefs(db, id.tenantId, id.userId);
      const qaConversations = deps.qa?.clearAll(id.tenantId, id.userId) ?? 0;
      audit(db, id, "member.offboard_clear_personal", "user", id.userId, sha256Hex(JSON.stringify({ writing_prefs: writingPrefs, qa_conversations: qaConversations })), keyctx);
      const done = [writingPrefs > 0 ? "写作偏好" : "", qaConversations > 0 ? `${qaConversations} 个问答` : ""].filter(Boolean);
      return { cleared: { writing_prefs: writingPrefs, qa_conversations: qaConversations }, note: done.length > 0 ? `已清除你在这台电脑上的${done.join("和")}` : "这台电脑上没有你的写作偏好和问答记录" };
    },
    // 团队事项交给一位同事：对方还不是负责人就先设为负责人（成员事件），本人是中继上的控制成员就再移交控制（先设负责人、后移交，中继拒绝时如实返回）
    "members.offboard_handoff": async (p, id) => {
      assertNotExitMode("离所交接");
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      requireMatterOwner(db, matter.matter_id, id, "只有事项负责人能把事项交给同事");
      if (matter.collab_scope !== "team") throw validation("这个事项只在你的电脑上：请导出归档，交给律所或接手的同事");
      const to = String(p?.to_user ?? "");
      if (!to || to === id.userId) throw validation("请选择接手的同事");
      const row = db.get<{ matter_role: string }>(`SELECT matter_role FROM matter_members WHERE matter_id = ? AND user_id = ? AND removed_at IS NULL`, [matter.matter_id, to]);
      if (!row) throw validation("对方不是这个事项的成员：只能交给事项里的同事");
      if (!hasActiveDevice(id.tenantId, to)) throw validation("对方的电脑都已停用，不能接手");
      if (matter.lifecycle !== "active") throw validation("这个事项已结案：请先在事项页“⋯”里重新打开再交给同事，或导出归档交给律所");
      let ownerSet = false;
      if (row.matter_role !== "owner") {
        try {
          await api["matters.members.add"]!({ matter_id: matter.matter_id, user_id: to, matter_role: "owner" }, id);
        } catch (e) {
          // 内核原话讲的是同步机制（复核 R15B-24）：律师只见一句话，原话放在 detail 里给管理员
          throw new DomainError((e as DomainError).code ?? "conflict", "没有交接成功：这个事项的同事之间同步暂时有异常。请稍后再试；仍不行请管理员在“设置 · 本机与安全 · 团队共享”查看", 409, { detail: (e as Error).message });
        }
        ownerSet = true;
      }
      let relay: "done" | "not_needed" | "pending" = "not_needed";
      let pendingNote: string | null = null;
      if (deps.shareRelay?.controllerOf(matter.matter_id) === id.userId) {
        try {
          await api["matters.relay_handoff"]!({ matter_id: matter.matter_id, to_user: to }, id);
          relay = "done";
        } catch (e) {
          relay = "pending";
          // 中继只把管理权交给在这个事项里发出过改动的电脑（证明对方真的在用、拿得到密钥）：被动成员要先同步一次自己的改动
          pendingNote =
            (e as DomainError).detail?.reason === "to_not_reader"
              ? `要等 ${displayNameOf(to, "这位同事")} 的电脑在这个事项里同步过一次自己的改动（例如导入一份材料或改一处内容）才能交出——请对方做完后，回到这里再点一次`
              : "暂时没有交出去（同事之间同步暂时有异常），请稍后再点一次；仍不行请管理员查看“团队共享”";
        }
      }
      audit(db, id, "member.offboard_handoff", "matter", matter.matter_id, to, keyctx);
      const who = displayNameOf(to, "这位同事");
      return {
        matter_id: matter.matter_id,
        to_user: to,
        owner_set: ownerSet,
        relay,
        item: offboardingItem(matter, id),
        note:
          relay === "pending"
            ? `${ownerSet ? `已把 ${who} 设为负责人；` : ""}同事之间同步的管理权还没有交出去：${pendingNote}`
            : `已交给 ${who}${relay === "done" ? "（含同事之间同步的管理权）" : ""}`,
      };
    },
    // 成员列表（管理员与合伙人）：按控制面签名的设备目录（本机设备表）汇总，姓名取本机记录（本机发出的邀请、事项成员）；所内节点不列
    "members.roster": (_p, id) => {
      requireFirmAdmin(id);
      const devs = db.all<{ device_id: string; member_id: string; role: string; status: string; revoked_at: string | null; created_at: string }>(
        `SELECT device_id, member_id, role, status, revoked_at, created_at FROM devices WHERE tenant_id = ? AND role <> 'node' ORDER BY created_at`,
        [id.tenantId],
      );
      const removals = new Map(
        db.all<{ member_id: string; removed_at: string; seat_released_at: string | null; seat_error: string | null }>(
          `SELECT member_id, removed_at, seat_released_at, seat_error FROM member_removals WHERE tenant_id = ?`,
          [id.tenantId],
        ).map((r) => [r.member_id, r]),
      );
      const byMember = new Map<string, typeof devs>();
      for (const d of devs) byMember.set(d.member_id, [...(byMember.get(d.member_id) ?? []), d]);
      const members = [...byMember].map(([memberId, list]) => {
        const active = list.filter((d) => d.status === "active");
        const latest = (active.length > 0 ? active : list).at(-1)!;
        const rm = removals.get(memberId);
        return {
          member_id: memberId,
          name: displayNameOf(memberId, null),
          role: latest.role,
          is_me: memberId === id.userId,
          // 复核 R15A-02 / R15B-12：只有走过“移出律所”才算已移出；电脑都停用了但没移出的，席位还占着、仍可移出
          status: rm ? "removed" : active.length > 0 ? "active" : "devices_stopped",
          joined_at: list[0]!.created_at,
          devices: list.map((d) => ({ device_id: d.device_id, status: d.status, created_at: d.created_at, revoked_at: d.revoked_at, this_device: d.device_id === keyctx.device.deviceId })),
          removal: rm ? { removed_at: rm.removed_at, seat_released: !!rm.seat_released_at, seat_error: rm.seat_error } : null,
        };
      });
      return { members, can_remove: canRemoveMembers(id) };
    },
    // 移出前要提醒的事（本机知道的部分）：他还负责、且没有别的在用负责人或他是中继控制成员的团队事项；他还有几台在用电脑
    "members.removal_preview": (p, id) => {
      requireFirmAdmin(id);
      const uid = String(p?.member_id ?? "");
      const devices = db.all<{ device_id: string }>(`SELECT device_id FROM devices WHERE tenant_id = ? AND member_id = ? AND status = 'active' AND role <> 'node'`, [id.tenantId, uid]);
      const matters = db
        .all<{ matter_id: string; title: string }>(
          `SELECT m.matter_id, m.title FROM matters m JOIN matter_members mm ON mm.matter_id = m.matter_id AND mm.user_id = ? AND mm.removed_at IS NULL AND mm.matter_role = 'owner'
            WHERE m.tenant_id = ? AND m.status = 'active' AND m.lifecycle <> 'purged' AND m.collab_scope = 'team'`,
          [uid, id.tenantId],
        )
        .filter((m) => {
          const otherOwner = db
            .all<{ user_id: string }>(`SELECT user_id FROM matter_members WHERE matter_id = ? AND matter_role = 'owner' AND removed_at IS NULL AND user_id <> ?`, [m.matter_id, uid])
            .some((o) => hasActiveDevice(id.tenantId, o.user_id));
          return !otherOwner || deps.shareRelay?.controllerOf(m.matter_id) === uid;
        })
        .map((m) => ({ matter_id: m.matter_id, title: m.title, relay_controller: deps.shareRelay?.controllerOf(m.matter_id) === uid }));
      return { member_id: uid, name: displayNameOf(uid, null), is_me: uid === id.userId, active_devices: devices.length, matters };
    },
    // 移出律所（管理员设备）：逐台停用（与“停用这台电脑”同一路径：本机吊销 + 控制面），再释放席位；席位当时释放不了就记下，可再点一次
    "members.remove": async (p, id) => {
      requireAdminDevice(id);
      assertNotExitMode("移出成员");
      // 复核 R15A-03：移出与批准新成员同在持有律所根的那台电脑（开通律所的电脑）上做——开通人自己不能被移出，律所不会失去批准新成员的能力
      if (!holdsFirmRoot()) throw forbidden("移出成员要在开通律所的那台电脑上操作（和批准新成员是同一台）");
      const uid = String(p?.member_id ?? "");
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(uid)) throw validation("成员编号不合法");
      // 不能移出自己（律所至少有 1 位管理员也由此保证：操作者本人就是管理员）
      if (uid === id.userId) throw validation("不能移出自己");
      const devs = db.all<{ device_id: string }>(`SELECT device_id FROM devices WHERE tenant_id = ? AND member_id = ? AND role <> 'node'`, [id.tenantId, uid]);
      if (devs.length === 0) throw notFound("成员");
      const cp: string[] = [];
      for (const d of db.all<{ device_id: string }>(`SELECT device_id FROM devices WHERE tenant_id = ? AND member_id = ? AND status = 'active' AND role <> 'node'`, [id.tenantId, uid])) {
        const r = (await api["devices.revoke"]!({ device_id: d.device_id, reason: "成员离所" }, id)) as { control_plane?: string };
        cp.push(r.control_plane ?? "not_configured");
      }
      let seatError: string | null = null;
      if (deps.controlPlane) {
        const r = await deps.controlPlane.request("POST", `/v1/seats/${uid}/revoke`, {}).catch(() => ({ ok: false as const, error: "cp_unreachable" }));
        // 对方从没拿到过席位：没有要释放的
        if (!r.ok && r.error !== "seat_unknown") seatError = r.error;
      } else seatError = "not_configured";
      const now = new Date().toISOString();
      const prior = db.get<{ seat_released_at: string | null }>(`SELECT seat_released_at FROM member_removals WHERE tenant_id = ? AND member_id = ?`, [id.tenantId, uid]);
      // 这次停用了在用的电脑（例如离所后又回来、再次离所），按新的一次移出记；否则只是重试释放席位（复核 R15A-11）
      const fresh = !prior || cp.length > 0;
      const seatReleasedAt = seatError ? (fresh ? null : prior?.seat_released_at ?? null) : now;
      db.run(
        `INSERT INTO member_removals (tenant_id, member_id, removed_at, removed_by, devices_revoked, seat_released_at, seat_error) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(tenant_id, member_id) DO UPDATE SET removed_at = CASE WHEN ? THEN excluded.removed_at ELSE member_removals.removed_at END,
           removed_by = CASE WHEN ? THEN excluded.removed_by ELSE member_removals.removed_by END,
           devices_revoked = member_removals.devices_revoked + excluded.devices_revoked, seat_released_at = ?, seat_error = excluded.seat_error`,
        [id.tenantId, uid, now, id.userId, cp.length, seatReleasedAt, seatError, fresh ? 1 : 0, fresh ? 1 : 0, seatReleasedAt],
      );
      // 他在这台电脑上按人存的数据一并清除（复核 Q4 建议 3）：写作偏好与问答记录。只有共用电脑时才会有——
      // 他自己电脑上的要由他本人在离所交接的最后一步清除（复核 Q5-11）
      const prefsCleared = clearWritingPrefs(db, id.tenantId, uid);
      const qaCleared = deps.qa?.clearAll(id.tenantId, uid) ?? 0;
      audit(db, id, "member.remove", "member", uid, sha256Hex(JSON.stringify({ devices: cp.length, control_plane: cp, seat_released: !seatError, retry: !fresh, writing_prefs_cleared: prefsCleared, qa_cleared: qaCleared })), keyctx);
      const failed = cp.filter((s) => s === "failed").length;
      const waiting = cp.filter((s) => s === "pending" || s === "submitted").length;
      return {
        member_id: uid,
        devices_revoked: cp.length,
        control_plane: cp,
        seat_released: !seatError,
        note: [
          cp.length > 0 ? `已停用 ${cp.length} 台电脑` : "他的电脑此前都已停用",
          waiting > 0 ? `其中 ${waiting} 台中软还没有确认，联网后自动生效` : "",
          failed > 0 ? `其中 ${failed} 台中软拒绝了停用，须在管理员电脑上再停用一次` : "",
          seatError ? "席位还没有释放（暂时连不上中软），之后每次同步会自动再试" : "已释放 1 个席位",
        ]
          .filter(Boolean)
          .join("；"),
      };
    },
    // 团队事项里电脑已全部停用、但还在事项里的成员（复核 R15A-05）：负责人电脑上提醒移出（移出会换新密钥，他拿不到此后的新内容）
    "members.departed_in_matters": (_p, id) => {
      const rows = db.all<{ matter_id: string; title: string; user_id: string }>(
        `SELECT m.matter_id, m.title, mm2.user_id FROM matters m
           JOIN matter_members mm ON mm.matter_id = m.matter_id AND mm.user_id = ? AND mm.removed_at IS NULL AND mm.matter_role = 'owner'
           JOIN matter_members mm2 ON mm2.matter_id = m.matter_id AND mm2.removed_at IS NULL AND mm2.user_id <> ?
          WHERE m.tenant_id = ? AND m.status = 'active' AND m.lifecycle = 'active' AND m.collab_scope = 'team'`,
        [id.userId, id.userId, id.tenantId],
      );
      const out = rows
        .filter((r) => {
          const devs = db.all<{ status: string }>(`SELECT status FROM devices WHERE tenant_id = ? AND member_id = ? AND role <> 'node'`, [id.tenantId, r.user_id]);
          return devs.length > 0 && devs.every((d) => d.status !== "active");
        })
        .map((r) => ({ ...r, name: displayNameOf(r.user_id, null), removed_from_firm: !!db.get(`SELECT 1 AS x FROM member_removals WHERE tenant_id = ? AND member_id = ?`, [id.tenantId, r.user_id]) }));
      return { items: out };
    },

    // ─── 团队事项经中软共享中继同步（第 11 批 S11；services/share-relay.ts） ───
    "relay.status": () => {
      if (!deps.shareRelay) return { blocked: "not_configured", configured: false, allowed: false, alerts: syncAlertsView(db, keyctx.device.deviceId) };
      return deps.shareRelay.status();
    },
    // 立即收发一次（界面“立即同步”与测试）：不能收发时如实返回原因
    "relay.sync": async (_p, id) => {
      if (!deps.shareRelay) throw new DomainError("provider_unavailable", "共享中继未启用", 503);
      assertNotExitMode("同步");
      const r = await deps.shareRelay.sync();
      if (r.push.uploaded > 0 || r.pull.applied > 0) {
        audit(db, id, "relay.sync", "tenant", id.tenantId, sha256Hex(JSON.stringify({ uploaded: r.push.uploaded, applied: r.pull.applied })), keyctx);
      }
      return { ...r, status: deps.shareRelay.status() };
    },

    // ─── 节点逐事项授权（§5.3 服务成员；v0 同机节点设备，跨机器加入流程 G1） ───
    "matters.node_authorize": (p, id) => {
      const matter = requireMatterAccess(db, String(p?.matter_id ?? ""), id);
      // 成员链（第 12 批）：先补写到期的吊销标记、刷新投影（下面的负责人检查读投影）
      refreshChain(chainDeps(id), matter.matter_id);
      requireMatterOwner(db, matter.matter_id, id);
      requireActiveMatter(db, matter.matter_id);
      // 当事人限制（L3b：strict 或当事人拒绝云端处理的记录）强制不授权节点（律所执行器不处理 L3b；复核 A 范围外观察）
      if (dataLevelOf(matter.confidentiality, matter.consent_status) === "L3b") {
        throw forbidden("当事人限制（L3b）的事项不允许授权节点（只在成员电脑上运行）");
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
      // 成员链（第 12 批）：节点是服务成员（viewer），授权是成员事件 + 节点设备在当前纪元的包裹摘要
      if (hasChain(db, matter.matter_id) && node.memberId) {
        const nodeMember = node.memberId;
        const r = db.tx(() => {
          db.run(`INSERT OR IGNORE INTO users (user_id, tenant_id, display_name) VALUES (?,?,?)`, [nodeMember, id.tenantId, nodeMember]);
          const out = addOrUpdateMember(chainDeps(id), matter.matter_id, nodeMember, "viewer", [{ device_id: node.deviceId, enc_pub_pem: nodeEncPub }]);
          db.run(`UPDATE matters SET node_allowed = 1 WHERE matter_id = ?`, [matter.matter_id]);
          return out;
        });
        audit(db, id, "matter.node_authorize", "matter", matter.matter_id, node.deviceId, keyctx);
        return {
          matter_id: matter.matter_id,
          node_device_id: node.deviceId,
          epoch: r.epoch,
          note: "已把当前纪元事项密钥包裹给节点设备（节点由此可解本事项新内容；伦理墙事项与 strict 事项不可授权）；授权已记入成员链",
        };
      }
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
            [matter.matter_id, node.memberId, id.userId, keyctx.device.deviceId, nextMemberLamport(db, matter.matter_id)],
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
      // 成员链（第 12 批）：先补写到期的吊销标记、刷新投影（下面的负责人检查读投影）
      refreshChain(chainDeps(id), matter.matter_id);
      requireMatterOwner(db, matter.matter_id, id);
      const node = db.get<{ device_id: string; member_id: string }>(`SELECT device_id, member_id FROM devices WHERE device_id = ?`, [`node_${config.firmSlug}`]);
      // 成员链（第 12 批）：包裹摘要已在链上、成员设备会互相转发，只删本机那一行收不回——改为移出节点成员并轮换
      if (hasChain(db, matter.matter_id)) {
        const nodeMember = node?.member_id;
        const isMember = !!nodeMember && !!db.get(`SELECT 1 AS x FROM matter_members WHERE matter_id = ? AND user_id = ? AND removed_at IS NULL`, [matter.matter_id, nodeMember]);
        if (isMember) {
          requireRelayController(matter.matter_id, "撤销节点授权");
          requireNoSyncAlert(matter.matter_id, "撤销节点授权");
        }
        const r = db.tx(() => {
          const out = isMember ? rotateChainKey(chainDeps(id), matter.matter_id, { reason: `node.revoke ${node!.device_id}`, memberChange: { user: nodeMember!, role: null } }) : null;
          db.run(`UPDATE matters SET node_allowed = 0 WHERE matter_id = ?`, [matter.matter_id]);
          return out;
        });
        audit(db, id, "matter.node_revoke", "matter", matter.matter_id, undefined, keyctx);
        return {
          matter_id: matter.matter_id,
          ...(r ? { new_epoch: r.epoch } : {}),
          note: r ? "已移出节点并轮换事项密钥（节点解不开新内容；其曾持有的旧纪元密钥无法远程收回，如实告知）；撤销已记入成员链" : "节点不是本事项成员，已关闭节点授权",
        };
      }
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
      // 恢复取托管包裹的最高纪元（第二轮复核 S11A-23：本机可能没有任何包裹，不能按“本机持有的最高纪元”起算）；
      // 有成员链的事项取链上已声明的最高纪元（第四轮复核 S12B-50：不取链上不成立的那一纪元）
      const epoch = hasChain(db, matter.matter_id)
        ? chainView(chainDeps(id), matter.matter_id).maxEpoch
        : (db.get<{ e: number | null }>(`SELECT MAX(epoch) AS e FROM matter_keys WHERE matter_id = ? AND wrapped_for = 'recovery'`, [matter.matter_id])?.e ?? 0);
      const recWrap = db.get<{ wrapped_key: string }>(`SELECT wrapped_key FROM matter_keys WHERE matter_id = ? AND epoch = ? AND wrapped_for = 'recovery'`, [matter.matter_id, epoch]);
      if (!recWrap) throw notFound("该事项的恢复托管包裹行");
      const matterKey = unwrapMatterKey(recWrap.wrapped_key, combined.privateKeyPem);
      // 托管包裹须是该纪元胜者那把（第五轮复核 S12B-57：本机的托管行可能仍是落选那把，覆盖后本机落到落选的密钥）
      if (hasChain(db, matter.matter_id)) {
        const fp = chainView(chainDeps(id), matter.matter_id).epochs.get(epoch)?.decl.fp;
        if (fp && keyFingerprint(matterKey) !== fp) {
          return { ok: false as const, reason: `本机的恢复托管包裹不是成员链上纪元 ${epoch} 声明的那把（多为并发轮换落选、胜者的段还没到）：请先同步再恢复` };
        }
      }
      const rotate = p?.rotate === true;
      if (rotate) refreshChain(chainDeps(id), matter.matter_id);
      // 团队事项的新纪元只认负责人签发的包裹（D-93）：非负责人轮换不会传播，还会与负责人下次轮换撞纪元号（第二轮复核 S11A-20）
      if (rotate) requireMatterOwner(db, matter.matter_id, id, "轮换事项密钥需要事项负责人角色（团队事项的新纪元只认负责人签发的包裹）");
      if (rotate) requireRelayController(matter.matter_id, "轮换事项密钥");
      if (rotate) requireNoSyncAlert(matter.matter_id, "轮换事项密钥");
      const revokeDeviceIds: string[] = Array.isArray(p?.revoke_device_ids) ? p.revoke_device_ids.map(String) : [];
      let rotatedEpoch = epoch;
      db.tx(() => {
        // 本机原有的那一行先留进密钥历史（第五轮复核 S12B-57：覆盖后用它封过的材料块解不开）
        db.run(
          `INSERT OR IGNORE INTO matter_key_history (matter_id, epoch, wrapped_for, wrapped_key, replaced_at)
           SELECT matter_id, epoch, wrapped_for, wrapped_key, ? FROM matter_keys WHERE matter_id = ? AND epoch = ? AND wrapped_for = ?`,
          [nowIso(), matter.matter_id, epoch, keyctx.device.deviceId],
        );
        db.run(`INSERT OR REPLACE INTO matter_keys (matter_id, epoch, wrapped_for, wrapped_key) VALUES (?,?,?,?)`, [
          matter.matter_id,
          epoch,
          keyctx.device.deviceId,
          wrapMatterKey(matterKey, keyctx.device.keys.encPublicKeyPem),
        ]);
        if (rotate && hasChain(db, matter.matter_id)) {
          // 成员链（第 12 批）：轮换是链上的 rekey 事件（新纪元只包给链上未移出成员的在用设备，减去 revoke_device_ids）
          rotatedEpoch = rotateChainKey(chainDeps(id), matter.matter_id, {
            reason: `recovery.restore rotate${revokeDeviceIds.length > 0 ? `（吊销候选 ${revokeDeviceIds.join("/")}）` : ""}`,
            exclude: new Set(revokeDeviceIds),
          }).epoch;
        } else if (rotate) {
          // 设备丢失场景的推荐路径：先吊销旧设备并 rotate——新纪元密钥只包裹给
          // 「有效成员（墓碑过滤）减去 revoke_device_ids」的 active 设备 + recovery（旧设备解不开新内容）
          // 新纪元号取库里已有的最高纪元之后（不与任何已有纪元撞号）
          const newEpoch = (db.get<{ e: number | null }>(`SELECT MAX(epoch) AS e FROM matter_keys WHERE matter_id = ?`, [matter.matter_id])?.e ?? epoch) + 1;
          rotatedEpoch = newEpoch;
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
          db.run(`DELETE FROM sync_alerts WHERE matter_id = ? AND kind = 'epoch_conflict'`, [matter.matter_id]);
        }
      });
      // 破窗事件（§5.3「动用即破窗」：须 M 名持有人签名、写审计链并通知成员——通知界面/IM 在 G1）
      const record = createBreakGlassRecord({
        matterId: matter.matter_id,
        keyEpoch: rotatedEpoch,
        shareHolderIds: shareFiles.map((f) => basename(f)),
        actorId: id.userId,
        at: nowIso(),
      });
      audit(db, id, "recovery.break_glass", "matter", matter.matter_id, hashBreakGlassRecord(record), keyctx);
      return {
        ok: true as const,
        matter_id: matter.matter_id,
        epoch: rotatedEpoch,
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
      if ([...password].length < 10) throw validation("恢复口令至少 10 个字（这份备份离线保存，口令是唯一保护）");
      // 设备密钥文件是封装形态（审计 S1）：经解封读取，不直接读文件（隐私安全增量评审 F2：直接读会导出不含私钥的“备份”）
      const deviceKeys = getDeviceKeys(keyctx.keysDir);
      if (!deviceKeys.signPrivateKeyPem?.includes("PRIVATE KEY") || !deviceKeys.encPrivateKeyPem?.includes("PRIVATE KEY")) throw new DomainError("internal", "读不到本机设备私钥，未导出", 500);
      // v2：设备编号与证书摘要放进口令包裹的明文里（复核 B4-A12：文件外层的明文字段可以随意改，不能当绑定）
      const blob = wrapPrivateKeyScrypt(
        JSON.stringify({
          v: 2,
          device_id: keyctx.device.deviceId,
          cert_sha256: sha256Hex(Buffer.from(canonicalJson(keyctx.device.cert), "utf8")),
          signPrivateKeyPem: deviceKeys.signPrivateKeyPem,
          encPrivateKeyPem: deviceKeys.encPrivateKeyPem,
        }),
        password,
      );
      mkdirSync(join(outPath, ".."), { recursive: true });
      writeFileSync(outPath, JSON.stringify({ v: 2, kind: "kwl-device-recovery", device_id: keyctx.device.deviceId, cert: keyctx.device.cert, wrapped: blob }, null, 2), { mode: 0o600 });
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
      const deviceId = keyctx.device.deviceId;
      let doc: { kind?: string; device_id?: string; cert?: DeviceCertificate; wrapped?: string };
      try {
        doc = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        throw validation("读不到恢复文件，或文件已损坏");
      }
      if (doc?.kind !== "kwl-device-recovery" || typeof doc.wrapped !== "string" || !doc.cert || typeof doc.cert !== "object") throw validation("不是有效的设备恢复文件");
      // 已吊销的设备不能靠恢复文件在本地复活（复核 B4-A12）：拒绝，且不改状态与吊销时间
      const devRow = db.get<{ status: string }>(`SELECT status FROM devices WHERE device_id = ?`, [deviceId]);
      const tomb = db.get<{ x: number }>(`SELECT 1 AS x FROM cp_revoked_devices WHERE device_id = ?`, [deviceId]);
      if (!devRow || devRow.status === "revoked" || tomb) {
        throw new DomainError("conflict", "这台设备已被律所吊销，不能用恢复文件恢复；请联系律所管理员重新签发设备", 409);
      }
      if (doc.device_id !== deviceId) throw validation("这份恢复文件属于另一台设备，不能导入到本机");
      // 口令错误时 unwrapPrivateKeyScrypt 抛 bad_password（接口约定，界面据此提示）
      const secrets = JSON.parse(unwrapPrivateKeyScrypt(doc.wrapped, password)) as { v?: number; device_id?: string; cert_sha256?: string; signPrivateKeyPem?: string; encPrivateKeyPem?: string };
      // v2 起编号与证书摘要在口令包裹里：外层明文被改即拒绝（v1 文件没有这层绑定，靠下面的证书与公钥核对）
      if (secrets.v === 2) {
        if (secrets.device_id !== deviceId) throw validation("这份恢复文件属于另一台设备，不能导入到本机");
        if (secrets.cert_sha256 !== sha256Hex(Buffer.from(canonicalJson(doc.cert), "utf8"))) throw validation("恢复文件被改动过，不能导入");
      }
      // 从备份私钥推导两把公钥（复核 B4-A11：不能沿用 device.json 里现有的公钥，那可能是丢失后新换的）
      let signPub: string;
      let encPub: string;
      try {
        const sk = createPrivateKey(String(secrets.signPrivateKeyPem ?? ""));
        const ek = createPrivateKey(String(secrets.encPrivateKeyPem ?? ""));
        if (sk.asymmetricKeyType !== "ed25519" || ek.asymmetricKeyType !== "x25519") throw new Error("type");
        // 由私钥 PEM 推导公钥（node:crypto 接受私钥输入）
        signPub = createPublicKey(String(secrets.signPrivateKeyPem)).export({ format: "pem", type: "spki" }).toString();
        encPub = createPublicKey(String(secrets.encPrivateKeyPem)).export({ format: "pem", type: "spki" }).toString();
      } catch {
        throw validation("恢复文件里的设备私钥不完整，不能导入");
      }
      // 证书：律所根签发、未过期、编号与成员是本机、其中的公钥与推导结果一致——否则不写入（复核 B4-A12）
      const cert = doc.cert;
      const vr = verifyDeviceCertificate(cert, keyctx.firm.rootPublicKeyPem);
      if (!vr.ok) throw validation(`恢复文件里的设备证书无效（${vr.reason}）；请联系律所管理员重新签发设备`);
      if (cert.deviceId !== deviceId || cert.memberId !== keyctx.device.memberId) throw validation("这份恢复文件属于另一台设备，不能导入到本机");
      if (cert.signPublicKeyPem.trim() !== signPub.trim() || cert.encPublicKeyPem.trim() !== encPub.trim()) throw validation("恢复文件里的私钥与证书不符，不能导入");

      // 与本机现有密钥相同（同机导出后立即导入）：无需任何改动
      const cur = getDeviceKeys(keyctx.keysDir);
      const sameKeys = cur.signPublicKeyPem.trim() === signPub.trim() && cur.encPublicKeyPem.trim() === encPub.trim();
      if (!sameKeys) {
        // 暂存、重启生效（复核 B4-R09）：本进程里内核、队列与 Agent 宿主都还持有临时密钥，此刻改包裹会与在途任务竞争；
        // 下次启动时、任何组件装载密钥之前完成改包裹与换钥（devices.ts applyStagedRecovery，届时再复核一次）
        stageDeviceRecovery(keyctx.keysDir, { device_id: deviceId, cert, signPrivateKeyPem: secrets.signPrivateKeyPem!, encPrivateKeyPem: secrets.encPrivateKeyPem!, staged_at: new Date().toISOString() });
      }
      audit(db, id, "recovery.import_device", "device", deviceId, undefined, keyctx);
      return {
        device_id: deviceId,
        restart_required: !sameKeys,
        staged: !sameKeys,
        note: sameKeys
          ? "恢复文件里的密钥与本机现有密钥相同，无需改动"
          : "恢复文件已核验，重启应用后生效：重启时会把本机在此期间新建的事项改由恢复的密钥保护。如设备实际丢失，请立即吊销旧设备证书",
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
        note: "开通时要试一次能否用找回资料打开案卷；这里如实显示已备份和试过的次数",
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
    // v9 第 02 篇 R5、§9.6（IM 行“能确认：无”）、§13 第 6 条、第 06 篇 T18：IM 不能确认签发——签发是本人在已登记设备上完成的业务操作。
    // v5 的 IM 确认签发路径（节点见证 im_witnessed）在 v9 关闭，失败关闭（阶段 7 复核 S7-A08）
    "approvals.request_im": (_p, _id) => {
      throw new DomainError("im_signoff_disabled", "IM 不能确认签发（v9 第 02 篇 §9.6、§13 第 6 条）：请在电脑上由本人以设备签名签发", 403);
    },

    // ─── 审计链（§6.4：全量重放校验；手动检查点。只记元数据与 hash，不存正文） ───
    // 分批让出事件循环（复核 B4-R12）：长链校验不挡住子进程心跳与界面请求
    "audit.verifyChain": (_p, _id) => keyctx.signer.verifyChainAsync(),

    "audit.checkpoint": (p, _id) => {
      const kind = p?.kind === "daily" ? ("daily" as const) : ("manual" as const);
      const cp = keyctx.signer.checkpoint(kind);
      return cp
        ? { checkpoint: cp, note: "已对当前链头签名写检查点（时间戳锚定在后续阶段；采用哈希校验技术，不宣称司法存证效力）" }
        : { checkpoint: null, note: "链为空或链头未变，未重复检查点" };
    },
  };

  /** 成果所属任务的方法与“你来核对”清单（v9.2 §4.4；Y4 §5 D-3）：复核页显示与签发记录同一份。 */
  function lawyerChecklistOf(runId: string | null): { skillId: string | null; items: string[] } {
    let skillId: string | null = null;
    if (runId) {
      const r = db.get<{ scenario: string; input_snapshot: string | null }>(`SELECT scenario, input_snapshot FROM runs WHERE run_id = ?`, [runId]);
      const snap = parseJson<any>(r?.input_snapshot ?? "{}", {});
      skillId = typeof snap.skill === "string" ? snap.skill : r?.scenario === "s1.contract_review" ? "contract-review" : r?.scenario === "s1b.draft_compare" ? "redraft-review" : null;
    }
    const sk = deps.skills;
    return { skillId, items: skillId && sk?.ok ? skillQualityChecklist(sk.dir, skillId) : [] };
  }

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

  /** 律所管理员（成员角色）：告警确认、公钥变更核对。 */
  function requireFirmAdmin(id: Identity): void {
    const role = db.get<{ role: string }>(`SELECT role FROM memberships WHERE tenant_id = ? AND user_id = ?`, [id.tenantId, id.userId])?.role;
    if (role !== "firm_admin" && role !== "partner") throw forbidden("需要律所管理员或合伙人角色");
  }

  /**
   * 管理员设备（阶段 6；第 02 篇 §9.11：放宽类策略与连接器登记须管理员设备签名）：成员角色为律所管理员，且本机设备证书角色为 admin
   * （证书由律所根签发；控制面不能自造）。未配置控制面时这些操作不可用。
   */
  function requireAdminDevice(id: Identity): void {
    const role = db.get<{ role: string }>(`SELECT role FROM memberships WHERE tenant_id = ? AND user_id = ?`, [id.tenantId, id.userId])?.role;
    if (role !== "firm_admin") throw forbidden("需要律所管理员角色");
    if (keyctx.device.cert.role !== "admin") throw forbidden("本设备不是管理员设备（设备证书角色须为 admin）");
    if (!deps.controlPlane) throw new DomainError("provider_unavailable", "未配置控制面：律所策略的起草、签名与发布不可用（开发形态取本机配置项）", 503);
  }

  /** 退出模式（第 02 篇 §10、§9.13）下不可用的动作：模型、同步、新任务与签发（复核 S6-A04、S6-B10）。 */
  /** 被律所停用的电脑不再把事项导出成明文（复核 R15A-04：与备份、恢复包同一口径；许可到期等其他退出原因不拦导出）。 */
  function assertNotRevokedForExport(what: string): void {
    const exit = deps.governance?.exitMode();
    if (exit?.code === "device_revoked") throw new DomainError("exit_mode", `这台电脑已被律所停用：${what}不可用。电脑上已有的内容请按律所制度处理`, 403);
  }

  function assertNotExitMode(what: string): void {
    const exit = deps.governance?.exitMode();
    if (exit) throw new DomainError("exit_mode", `${exit.message}（${what}不可用）`, 403);
  }

  /** 控制面调用的错误换成人话（控制面不可达或拒绝）。 */
  async function cpCall<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      throw new DomainError("provider_unavailable", `控制面：${msg}`, 502);
    }
  }

  function requireMatterOwner(db2: KernelDb, matterId: string, id: Identity, msg = "成员变更需要事项负责人角色"): void {
    const row = db2.get<{ matter_role: string }>(`SELECT matter_role FROM matter_members WHERE matter_id = ? AND user_id = ? AND removed_at IS NULL`, [matterId, id.userId]);
    if (row?.matter_role !== "owner") throw forbidden(msg);
  }

  function requireReminders(): ReminderService {
    if (!deps.reminders) throw new DomainError("provider_unavailable", "提醒功能未启用", 503);
    return deps.reminders;
  }

  /**
   * 提醒的事项门禁：须是事项成员、事项进行中（结案与删除的不能设新提醒）；通知事项成员须有编辑权限（只读成员只能提醒自己）。
   */
  function reminderMatterGate(matterId: string, audience: "me" | "team", id: Identity, op: "create" | "update" = "create"): void {
    const m = requireMatterAccess(db, matterId, id);
    if ((m.lifecycle ?? "active") !== "active") throw validation(op === "update" ? "已结案的事项的提醒不能修改，可以撤销" : "已结案的事项不能设新提醒");
    assertNotSample(db, matterId, op === "update" ? "改提醒" : "设提醒");
    if (audience === "team") {
      // 律师语言的报错（复核 S10B-12）：只读成员只能提醒自己
      const role = db.get<{ matter_role: string }>(`SELECT matter_role FROM matter_members WHERE matter_id = ? AND user_id = ? AND removed_at IS NULL`, [matterId, id.userId])?.matter_role;
      if (role === "viewer") throw forbidden("你在这个事项里是只读成员：只能设“只提醒我”");
      requireMatterWriter(db, matterId, id);
    }
  }

  /** 提醒对外的字段（不含缓存的密文与指纹）。 */
  function reminderOut(r: object): Record<string, unknown> {
    const { cloud_body: _b, cloud_devices: _d, ...rest } = r as Record<string, unknown>;
    return rest;
  }

  /** 成员写操作门禁（viewer 最小权限）：有效成员（墓碑过滤）且非 viewer；节点身份例外见下。 */
  function requireMatterWriter(db2: KernelDb, matterId: string, id: Identity, opts?: { allowClosed?: boolean }): void {
    // 数据生命周期（迁移 0021）：已结案事项只读（取消、对账等收尾操作除外）；已删除事项不可写
    const lc = db2.get<{ lifecycle: string }>(`SELECT lifecycle FROM matters WHERE matter_id = ?`, [matterId])?.lifecycle;
    if (lc === "purged" || (lc === "closed" && !opts?.allowClosed)) requireActiveMatter(db2, matterId);
    // 节点执行权限来自 node_allowed 授权而非成员角色（§5.3 服务成员：节点行是 viewer 但被授权执行）
    const dev = db2.get<{ role: string }>(`SELECT role FROM devices WHERE device_id = ?`, [keyctx.device.deviceId]);
    if (dev?.role === "node") {
      const m = db2.get<{ node_allowed: number; confidentiality: string; consent_status: string }>(`SELECT node_allowed, confidentiality, consent_status FROM matters WHERE matter_id = ?`, [matterId]);
      if (m?.node_allowed === 1 && dataLevelOf(m.confidentiality, m.consent_status) !== "L3b") return;
    }
    const row = db2.get<{ matter_role: string }>(`SELECT matter_role FROM matter_members WHERE matter_id = ? AND user_id = ? AND removed_at IS NULL`, [matterId, id.userId]);
    if (!row) throw forbidden("你不是该事项成员（或已被移出）");
    if (row.matter_role === "viewer") throw forbidden("viewer 角色只读：该操作需要编辑及以上角色（最小权限）");
  }

  /** 成员链与同步引擎的依赖（第 12 批：带中继上的控制成员，锚定者与自动轮换据此判断）。 */
  function chainDeps(id: Identity): { db: KernelDb; keyctx: KernelKeyContext; tenantId: string } {
    return { db, keyctx, tenantId: id.tenantId };
  }
  function syncDepsOf(id: Identity): SyncDeps {
    const sr = deps.shareRelay;
    return { db, blobs, keyctx, tenantId: id.tenantId, legacyMemberRows: config.legacyMemberRows, ...(sr ? { relayControl: { foreign: (mid: string) => sr.foreignController(mid), controller: (mid: string) => sr.controllerOf(mid) } } : {}) };
  }

  /** 本机 lamport 递增（墓碑/成员行的行级时钟，与签名链同源）。 */
  /**
   * 成员行的行序号：按事项合并的逻辑时钟（第六轮复核 S11A-49/S11B-48）——该事项已见过（本机写的与收到的）的最大成员行序号加一。
   * 原先取本机事件计数，各设备互不可比：写得少的共同负责人做的移出，在其他设备上被当作“不比本机新”丢掉。
   */
  function nextMemberLamport(db2: KernelDb, matterId: string): number {
    const seen = db2.get<{ l: number | null }>(`SELECT MAX(row_lamport) AS l FROM matter_members WHERE matter_id = ?`, [matterId])?.l ?? 0;
    return seen + 1;
  }

  function nextLocalLamport(db2: KernelDb): number {
    const r = db2.get<{ l: number | null }>(`SELECT MAX(lamport) AS l FROM signed_events`, []);
    return (r?.l ?? 0) + 1;
  }

  /**
   * 本次任务的材料缺口（Astra M-2）：最后一次 materials.loaded 里没读到的份数（失败的 + 要求了没读到的）。
   * 有缺口时签发须勾选“缺口已告知客户”（checklist.gaps_disclosed），写进签发留痕。
   */
  function materialGapCount(db2: KernelDb, runId: string | null): number {
    return materialGaps(db2, runId).count;
  }
  /**
   * 本次任务读的材料里 quality ≠ ok 的页（最多列 20 份、每份 30 页；余项续复核 RC-B-04/05）：
   * - 按任务当时读的那一版解析结果（materials.loaded 记下的 parse_version_id；老任务没有记录时退回最新一版），已隔离的材料不列；
   * - 分两类：pages 为识别不清或读不出的页；blank 为几乎没有文字的页（文本层不足 20 字、OCR 空文本：多为空白页、印章页、签署页）。
   * 只统计任务开始时提供的材料（Agent 用工具另读的材料不在内）。
   */
  function partialPages(db2: KernelDb, runId: string | null): { filename: string; pages: number[]; total: number; blank: number }[] {
    if (!runId) return [];
    const r = db2.get<{ input_snapshot: string | null }>(`SELECT input_snapshot FROM runs WHERE run_id = ?`, [runId]);
    const ids: string[] = parseJson<any>(r?.input_snapshot ?? "{}", {})?.document_version_ids ?? [];
    const ev = db2.get<{ payload: string }>(`SELECT payload FROM run_events WHERE run_id = ? AND type = 'materials.loaded' ORDER BY seq DESC LIMIT 1`, [runId]);
    const readVersion = new Map<string, string>(
      (parseJson<any>(ev?.payload ?? "{}", {})?.parse_versions ?? []).filter((x: any) => typeof x?.document_version_id === "string" && typeof x?.parse_version_id === "string").map((x: any) => [x.document_version_id, x.parse_version_id]),
    );
    const out: { filename: string; pages: number[]; total: number; blank: number }[] = [];
    for (const id of ids.slice(0, 200)) {
      const dv = db2.get<{ filename: string; quarantined_at: string | null }>(`SELECT filename, quarantined_at FROM document_versions WHERE document_version_id = ?`, [id]);
      if (!dv || dv.quarantined_at) continue;
      const pvId =
        readVersion.get(id) ??
        db2.get<{ parse_version_id: string }>(`SELECT parse_version_id FROM parse_versions WHERE document_version_id = ? ORDER BY created_at DESC LIMIT 1`, [id])?.parse_version_id;
      if (!pvId) continue;
      const rows = db2.all<{ page_no: number; note: string | null }>(`SELECT page_no, note FROM parse_pages WHERE parse_version_id = ? AND quality <> 'ok' ORDER BY page_no`, [pvId]);
      const isBlank = (note: string | null) => /^文本层仅 \d+ 字符|^OCR 空文本/.test(note ?? "");
      const unclear = rows.filter((x) => !isBlank(x.note)).map((x) => x.page_no);
      const blank = rows.length - unclear.length;
      if (unclear.length || blank) out.push({ filename: dv.filename, pages: unclear.slice(0, 30), total: unclear.length, blank });
      if (out.length >= 20) break;
    }
    return out;
  }
  /** 本次任务只读了前 5 万字的材料（余项续复核 RC-B-05 顺带项）。 */
  function truncatedReads(db2: KernelDb, runId: string | null): string[] {
    if (!runId) return [];
    const ev = db2.get<{ payload: string }>(`SELECT payload FROM run_events WHERE run_id = ? AND type = 'materials.loaded' ORDER BY seq DESC LIMIT 1`, [runId]);
    const t = parseJson<any>(ev?.payload ?? "{}", {})?.truncated;
    return Array.isArray(t) ? t.filter((x: unknown): x is string => typeof x === "string").slice(0, 20) : [];
  }

  /** 材料缺口的份数与文件名（文件名只在新版本记录的事件里有；复核 RB16B-07）。 */
  function materialGaps(db2: KernelDb, runId: string | null): { count: number; files: string[] } {
    if (!runId) return { count: 0, files: [] };
    const e = db2.get<{ payload: string }>(`SELECT payload FROM run_events WHERE run_id = ? AND type = 'materials.loaded' ORDER BY seq DESC LIMIT 1`, [runId]);
    if (!e) return { count: 0, files: [] };
    const m = parseJson<any>(e.payload, {});
    const requested = Number(m.requested ?? 0) || 0;
    const loaded = Number(m.loaded ?? 0) || 0;
    const failed = Number(m.failed ?? 0) || 0;
    const files = Array.isArray(m.missing) ? m.missing.map((x: any) => (typeof x?.filename === "string" ? x.filename : null)).filter((x: string | null): x is string => !!x) : [];
    return { count: Math.max(failed, requested - loaded, 0), files };
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

  /**
   * 经中软共享中继同步的事项：成员调整与密钥轮换须由中继上的控制成员（最先经中继同步该事项的负责人）操作（第二轮复核 S11B-19）——
   * 其他负责人的电脑做了，新纪元在中继上登记不上，控制成员不知道这次移出，被移出者会继续收到新内容。
   */
  /**
   * 本机无法确认该事项的负责人时不在本机调整成员（第七轮复核 S11B-52：这期间的调整只在本机生效、发不出去，被移出者仍收到其他成员的新内容）。
   * 纪元冲突不拦：负责人在本机重新轮换正是解除冲突的出路（轮换后本机的冲突告警即清除；非负责人设备的冲突只由冲突另一方的新纪元解除）。
   */
  function requireNoSyncAlert(matterId: string, what: string): void {
    if (!db.get(`SELECT 1 AS x FROM sync_alerts WHERE matter_id = ? AND kind = 'owner_unverifiable'`, [matterId])) return;
    throw forbidden(`这台电脑暂时无法确认这个事项的负责人：${what}暂不可用；在用的负责人同步一次后自动恢复，若负责人都已离所请联系中软客服`);
  }

  function hasActiveDevice(tenantId: string, userId: string): boolean {
    return !!db.get(`SELECT 1 AS x FROM devices WHERE tenant_id = ? AND member_id = ? AND status = 'active' AND role <> 'node'`, [tenantId, userId]);
  }

  /** 本机记下的姓名（本机发出的邀请、事项成员、本人激活记录）；不认识时退回成员编号（fallback 传 null 则返回 null）。 */
  function displayNameOf(userId: string, fallback: string | null = userId): string | null {
    if (userId === keyctx.device.cert.memberId && config.activation?.member_name) return config.activation.member_name;
    const n = db.get<{ display_name: string }>(`SELECT display_name FROM users WHERE user_id = ?`, [userId])?.display_name;
    return n && n !== userId ? n : fallback;
  }

  function holdsFirmRoot(): boolean {
    try {
      getFirmRootPrivateKey(keyctx.keysDir);
      return true;
    } catch {
      return false;
    }
  }

  function canRemoveMembers(id: Identity): boolean {
    const role = db.get<{ role: string }>(`SELECT role FROM memberships WHERE tenant_id = ? AND user_id = ?`, [id.tenantId, id.userId])?.role;
    return role === "firm_admin" && keyctx.device.cert.role === "admin" && !!deps.controlPlane && holdsFirmRoot();
  }

  /**
   * 离所交接的一件事项（B-10）：只在这台电脑上的事项（或团队里已没有在用同事的）看最近一次导出归档之后有没有新改动；
   * 团队事项看还有没有别的在用负责人、本人是不是中继上的控制成员。
   */
  function offboardingItem(m: OffboardingMatterRow, id: Identity): Record<string, unknown> & { status: "ok" | "needs_archive" | "needs_owner" | "needs_handoff" } {
    // 已结案的事项不能再加负责人（复核 R15A-18）：按导出归档交接
    const colleagues =
      m.collab_scope === "team" && (m.lifecycle ?? "active") === "active"
        ? db
            .all<{ user_id: string; matter_role: string }>(`SELECT user_id, matter_role FROM matter_members WHERE matter_id = ? AND removed_at IS NULL AND user_id <> ? ORDER BY added_at`, [m.matter_id, id.userId])
            .filter((x) => hasActiveDevice(id.tenantId, x.user_id))
            .map((x) => ({ user_id: x.user_id, name: displayNameOf(x.user_id, null), role: x.matter_role }))
        : [];
    const base = { matter_id: m.matter_id, title: m.title, scope: m.collab_scope === "team" ? "team" : "personal", closed: (m.lifecycle ?? "active") !== "active", colleagues };
    if (colleagues.length === 0) {
      const archivedAt = db.get<{ at: string | null }>(`SELECT MAX(created_at) AS at FROM audit_events WHERE action = 'matter.archive_exported' AND object_kind = 'matter' AND object_id = ?`, [m.matter_id])?.at ?? null;
      const changed = [
        m.created_at,
        db.get<{ at: string | null }>(`SELECT MAX(created_at) AS at FROM document_versions WHERE matter_id = ?`, [m.matter_id])?.at,
        db.get<{ at: string | null }>(`SELECT MAX(created_at) AS at FROM artifact_versions WHERE matter_id = ?`, [m.matter_id])?.at,
        db.get<{ at: string | null }>(`SELECT MAX(updated_at) AS at FROM runs WHERE matter_id = ?`, [m.matter_id])?.at,
        // 复核 R15A-06：风险卡决定、事实的提交与确认、签发记录也进归档——这些变了同样要重新导出
        db.get<{ at: string | null }>(`SELECT MAX(COALESCE(decided_at, created_at)) AS at FROM risk_cards WHERE matter_id = ?`, [m.matter_id])?.at,
        db.get<{ at: string | null }>(`SELECT MAX(COALESCE(decided_at, created_at)) AS at FROM matter_facts WHERE matter_id = ?`, [m.matter_id])?.at,
        db.get<{ at: string | null }>(`SELECT MAX(a.created_at) AS at FROM approvals a JOIN artifact_versions v ON v.artifact_version_id = a.artifact_version_id WHERE v.matter_id = ?`, [m.matter_id])?.at,
      ].reduce<string>((a, b) => (b && b > a ? b : a), "");
      // 严格早于导出才算导出过（同一毫秒里的改动按“导出后又有改动”处理——宁可多导一次，不漏）
      return { ...base, status: archivedAt && changed < archivedAt ? "ok" : "needs_archive", archived_at: archivedAt };
    }
    const relayController = deps.shareRelay?.controllerOf(m.matter_id) === id.userId;
    const otherOwner = colleagues.some((c) => c.role === "owner");
    return { ...base, status: !otherOwner ? "needs_owner" : relayController ? "needs_handoff" : "ok", relay_controller: relayController };
  }

  function requireRelayController(matterId: string, what: string): void {
    const ctl = deps.shareRelay?.foreignController(matterId);
    if (!ctl) return;
    if (ctl === "~") throw forbidden(`这个事项经中软共享中继同步，而本机的律所策略已过期或尚未收到：${what}请先联网更新律所策略后再试（策略回退期间改动成员，在中继上不会生效）`);
    if (ctl === "?") throw forbidden(`这个事项经中软共享中继同步，正在向中继确认最先同步它的负责人：${what}请稍后再试（可先点“立即同步”）`);
    const row = db.get<{ matter_role: string; removed_at: string | null }>(`SELECT matter_role, removed_at FROM matter_members WHERE matter_id = ? AND user_id = ?`, [matterId, ctl]);
    const name = db.get<{ display_name: string }>(`SELECT display_name FROM users WHERE user_id = ?`, [ctl])?.display_name ?? ctl;
    // 第三轮复核 S11A-31：控制成员已不是在册负责人（移交、被移出）或根本不是本事项成员（被抢先登记）时，如实说明须找中软客服
    if (!row) throw forbidden(`这个事项在中软共享中继上的状态异常（登记者不是本事项成员）：${what}暂时不能经中继同步，请联系中软客服重置该事项`);
    if (row.removed_at || row.matter_role !== "owner") throw forbidden(`这个事项经中软共享中继同步，中继上的控制成员（${name}）已不是负责人：${what}暂时不能经中继同步，请联系中软客服办理交接`);
    // B-10：控制成员没交接就离所了（他的电脑已全部停用）——别让负责人去找一个找不到的人
    const tenantId = db.get<{ tenant_id: string }>(`SELECT tenant_id FROM devices WHERE device_id = ?`, [keyctx.device.deviceId])?.tenant_id ?? "";
    const ctlDevices = db.all<{ status: string }>(`SELECT status FROM devices WHERE tenant_id = ? AND member_id = ? AND role <> 'node'`, [tenantId, ctl]);
    if (ctlDevices.length > 0 && ctlDevices.every((d) => d.status !== "active")) throw forbidden(`这个事项经中软共享中继同步，中继上的控制成员（${name}）的电脑已全部停用（多为离所时没有交接）：${what}暂时不能经中继同步，请联系中软客服办理交接`);
    throw forbidden(`这个事项经中软共享中继同步：${what}须由中继上的控制成员（${name}）在其电脑上操作，或请对方先把控制成员移交给你`);
  }

  /**
   * 当前事项密钥纪元：本机持有面向自己包裹的最高纪元（无记录为 1）。不取全部包裹的最大值——同步送来的、没有本机包裹的纪元
   * 不改变本机用哪把密钥加密（第 11 批复核 S11A-02）。
   */
  function currentMatterEpoch(db2: KernelDb, matterId: string): number {
    const r = db2.get<{ e: number | null }>(`SELECT MAX(epoch) AS e FROM matter_keys WHERE matter_id = ? AND wrapped_for = ?`, [matterId, keyctx.device.deviceId]);
    return r?.e ?? 1;
  }

  const w1 = createW1Api({
      db,
      tokens: tokens ?? null,
      approvals: deps.approvals ?? null,
      qa: deps.qa ?? null,
      kap: deps.kap ?? null,
      matterPolicy: (mid) => {
        if (!deps.matterPolicy) throw new DomainError("not_found", "当前引擎没有运行策略", 404);
        return deps.matterPolicy(mid);
      },
      requireRunAccess: (rid, id) => requireRunAccess(db, rid, id),
      requireMatterWriter: (mid, id) => requireMatterWriter(db, mid, id),
      audit: (id, action, kind, objectId, detailHash) => audit(db, id, action, kind, objectId, detailHash, keyctx),
      deviceFacts: async () => {
        const ledger = (await deps.kap?.capabilities()) ?? null;
        return ledger ? { ledger } : null;
      },
      gateFacts: () => (gate ? { running: gate.running, routes: gate.routes(), search_configured: !!gate.upstreams.search, fetch: gate.upstreams.fetch ?? "disabled" } : null),
  });
  let envProbeCache: { at: number; result: EnvProbeResult } | null = null;
  /** 脱敏诊断包（导出与上传预览共用同一生成）。 */
  const buildDiag = (id: Identity) =>
    buildDiagnostics({
      db,
      tokens: tokens ?? null,
      tenantId: id.tenantId,
      deviceId: keyctx.device.deviceId,
      signer: keyctx.device.signer,
      status: async () => api["kernel.status"]!({}, id),
      capabilities: async () => w1["kernel.capabilities"]!({}, id),
      logsDir: join(config.workspaceDir, "logs"),
      envProbe: async () => all["device.env_probe"]!({}, id),
    });
  /** 待确认上传的诊断包（内容摘要 → 生成者与内容；只在内存，10 分钟；每人只留最近一份）。 */
  const pendingUploads = new Map<string, { at: number; userId: string; data_base64: string }>();
  const UPLOAD_PREVIEW_TTL_MS = 10 * 60_000;
  const safeJsonText = (t: string): Record<string, unknown> => {
    try {
      const v = JSON.parse(t) as unknown;
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  // 发送途中内核退出留下的“进行中”记录：结果不明（复核 S9B-02）
  db.run(`UPDATE support_uploads SET status = 'unknown', error_code = 'interrupted', updated_at = ? WHERE status = 'pending'`, [new Date().toISOString()]);
  const all: Record<string, Handler> = {
    ...api,
    ...w1,
    // 脱敏诊断包（v9.2 §3.6；Y5 P1-2）：只含白名单结构化事实，导出前对照本机全部当事人与令牌原文自证，设备签名；记审计
    "diagnostics.export": async (_p, id) => {
      const r = await buildDiag(id);
      audit(db, id, "diagnostics.export", "device", keyctx.device.deviceId, r.content_sha256, keyctx);
      if (_p?.save_path) {
        const saved = writeExportFile(String(_p.save_path), Buffer.from(r.data_base64, "base64"), config.workspaceDir);
        return { filename: saved.name, saved: true, content_sha256: r.content_sha256, summary: r.summary };
      }
      return r;
    },
    // 诊断包上传给中软支持（第 9 批 S13；Y2 §3.13“预览将上传的内容 → 确认后上传”）：
    // 预览由内核生成同一份脱敏诊断包、留在内存 10 分钟；律师确认时交回预览的摘要，内核上传的正是那一份（不重新生成）
    "diagnostics.upload_preview": async (_p, id) => {
      const r = await buildDiag(id);
      const t = Date.now();
      // 按文件字节的摘要登记（上传时闸门与支持服务都按这一摘要核对；content_sha256 是包内签名覆盖的内容摘要）
      const bytes = Buffer.from(r.data_base64, "base64");
      const fileSha = sha256Hex(bytes);
      for (const [k, v] of pendingUploads) if (t - v.at > UPLOAD_PREVIEW_TTL_MS || v.userId === id.userId) pendingUploads.delete(k);
      pendingUploads.set(fileSha, { at: t, userId: id.userId, data_base64: r.data_base64 });
      const text = bytes.toString("utf8");
      let pretty = text;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // 原样显示
      }
      return {
        allowed: deps.governance?.supportUploadAllowed() ?? false,
        configured: !!gate?.supportConfigured && !!deps.controlPlane,
        // 超过上限的包预览时即说明，不去申请工单（复核 S9B-11）
        too_large: bytes.byteLength > SUPPORT_MAX_UPLOAD_BYTES,
        file_sha256: fileSha,
        content_sha256: r.content_sha256,
        summary: r.summary,
        preview: pretty,
      };
    },
    "diagnostics.upload": async (p, id) => {
      const sha = String(p?.file_sha256 ?? "");
      const pending = pendingUploads.get(sha);
      if (!pending || pending.userId !== id.userId || Date.now() - pending.at > UPLOAD_PREVIEW_TTL_MS) throw validation("预览已过期，请重新点“上传给中软支持”生成一份");
      if (!(deps.governance?.supportUploadAllowed() ?? false)) throw forbidden("律所没有开启“上传诊断包给中软支持”：可导出文件后按所内要求发送");
      if (!gate?.supportConfigured || !deps.controlPlane) throw new DomainError("provider_unavailable", "这台电脑没有配置中软支持服务：可导出文件后按所内要求发送", 503);
      const body = Buffer.from(pending.data_base64, "base64");
      if (body.byteLength > SUPPORT_MAX_UPLOAD_BYTES) throw validation("诊断包超过 2 MB，无法上传：请导出文件后按所内要求发送");
      // 先从待上传表取出（复核 S9B-05：并发的第二次提交拿不到同一份预览；失败时放回，可重试）
      pendingUploads.delete(sha);
      // 发送前写本机上传记录（复核 S9B-02）：结果在完成后更新；发送途中内核退出的，下次启动记“结果不明”
      const uploadId = `sup_${randomBytes(8).toString("hex")}`;
      const at = nowIso();
      db.run(`INSERT INTO support_uploads (upload_id, tenant_id, user_id, file_sha256, bytes, status, created_at, updated_at) VALUES (?,?,?,?,?,'pending',?,?)`, [uploadId, id.tenantId, id.userId, sha, body.byteLength, at, at]);
      audit(db, id, "diagnostics.upload_attempt", "support_upload", uploadId, sha, keyctx);
      let ticket: string | null = null;
      const finish = (status: "sent" | "failed" | "unknown", code: string | null) => {
        db.run(`UPDATE support_uploads SET status = ?, error_code = ?, ticket = ?, updated_at = ? WHERE upload_id = ?`, [status, code, ticket, nowIso(), uploadId]);
        audit(db, id, `diagnostics.upload_${status}`, "support_upload", uploadId, sha256Hex(JSON.stringify({ sha, ticket, code })), keyctx);
      };
      const fail = (status: "failed" | "unknown", code: string): never => {
        finish(status, code);
        // 确定没有送达的，预览放回（可直接重试）；结果不明的不放回，免得重复上传
        if (status === "failed") pendingUploads.set(sha, pending);
        throw new DomainError(status === "unknown" ? "provider_unavailable" : "provider_unavailable", supportErrorText(code, status), 502);
      };
      // 结果不明：闸门或支持服务在送出之后才失败（超时、连接中断、闸门退出）
      const UNCERTAIN = new Set(["support_timeout", "gate_exited", "support_unreachable"]);
      let credential: string;
      try {
        credential = await deps.controlPlane.supportToken();
      } catch (e) {
        return fail("failed", `credential:${String((e as Error)?.message ?? "error").slice(0, 40)}`);
      }
      const tk = await gate.support({ step: "ticket", credential });
      if (!tk.ok) return fail("failed", tk.reason);
      const tj = safeJsonText(tk.body);
      if (tk.status !== 200 || typeof tj.ticket !== "string" || typeof tj.upload_token !== "string") return fail("failed", String(tj.error ?? `http_${tk.status}`).slice(0, 60));
      ticket = String(tj.ticket).slice(0, 20);
      const up = await gate.support({ step: "upload", credential, ticket, upload_token: String(tj.upload_token), content_sha256: sha, body_b64: pending.data_base64 });
      if (!up.ok) return fail(UNCERTAIN.has(up.reason) ? "unknown" : "failed", up.reason);
      const uj = safeJsonText(up.body);
      if (up.status !== 200 || uj.ok !== true) return fail(up.status >= 500 ? "unknown" : "failed", String(uj.error ?? `http_${up.status}`).slice(0, 60));
      finish("sent", null);
      return { ticket, expires_at: typeof uj.expires_at === "string" ? uj.expires_at : null, retention_days: 7 };
    },
    // ─── 期限提醒（第 10 批 S9；services/reminders.ts） ───
    "reminders.list": (p, id) => {
      const rs = requireReminders();
      const mine = db.all<Record<string, unknown>>(
        `SELECT r.reminder_id, r.matter_id, r.kind, r.due_date, r.remind_at, r.days_before, r.remind_time, r.note, r.audience, r.version, r.status,
                r.cloud_state, r.cloud_error, r.cloud_targets, r.created_at, r.updated_at, m.title AS matter_title, m.collab_scope, m.lifecycle AS matter_lifecycle,
                (SELECT mm.matter_role FROM matter_members mm WHERE mm.matter_id = r.matter_id AND mm.user_id = r.created_by AND mm.removed_at IS NULL) AS my_role,
                EXISTS (SELECT 1 FROM reminder_inbox i WHERE i.reminder_id = r.reminder_id AND i.version = r.version) AS fired
           FROM reminders r JOIN matters m ON m.matter_id = r.matter_id
          WHERE r.tenant_id = ? AND r.created_by = ? AND r.status = 'active' AND m.lifecycle <> 'purged'
            ${p?.matter_id ? "AND r.matter_id = ?" : ""}
          ORDER BY r.due_date, r.remind_at LIMIT 500`,
        p?.matter_id ? [id.tenantId, id.userId, String(p.matter_id)] : [id.tenantId, id.userId],
      );
      // 收到的提醒：本人仍是成员的事项显示事项名与备注；本机没有该事项时只显示期限类型、日期与发出人（D-85；复核 S10A-06）
      const inbox = db.all<Record<string, unknown>>(
        `SELECT i.reminder_id, i.version, i.matter_id, i.kind, i.due_date, i.remind_at, i.note, i.source, i.received_at, i.read_at, i.from_member,
                u.display_name AS from_name,
                (SELECT m.title FROM matters m JOIN matter_members mm ON mm.matter_id = m.matter_id AND mm.user_id = ? AND mm.removed_at IS NULL
                  WHERE m.matter_id = i.matter_id AND m.lifecycle <> 'purged') AS matter_title
           FROM reminder_inbox i LEFT JOIN users u ON u.user_id = i.from_member
          WHERE i.tenant_id = ? ${p?.matter_id ? "AND i.matter_id = ?" : ""}
          ORDER BY i.received_at DESC LIMIT 100`,
        p?.matter_id ? [id.userId, id.tenantId, String(p.matter_id)] : [id.userId, id.tenantId],
      );
      const unread = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM reminder_inbox WHERE tenant_id = ? AND read_at IS NULL`, [id.tenantId])?.n ?? 0;
      return {
        cloud: { configured: rs.cloudConfigured, last: rs.lastCloud },
        reminders: mine.map((r) => ({ ...r, fired: r.fired === 1, mine: true })),
        inbox: inbox.map((r) => ({ ...r, note: r.matter_title === null ? "" : r.note, from_me: r.from_member === id.userId })),
        unread,
        // 云端送来、因核对不通过而没有显示的条数（复核 S10A-04：如实提示，不再只记在运行记录里）
        rejected: rs.rejectSummary(),
      };
    },
    /** 侧栏未读数（复核 S10B-16：不为一个数字拉整张列表）。 */
    "reminders.unread": (_p, id) => {
      requireReminders();
      return { unread: db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM reminder_inbox WHERE tenant_id = ? AND read_at IS NULL`, [id.tenantId])?.n ?? 0 };
    },
    // 期限推算（v9.4 第 20 批）：设提醒时按法定期间推算届满日，与 Agent 的 calc.deadline 同一计算（纯函数，不读写账本）
    "deadlines.compute": (p) => calcDeadline({ start: p?.start, period: p?.period, rule: p?.rule ?? "civil" } as any),
    "reminders.create": (p, id) => {
      const rs = requireReminders();
      const input = parseReminderInput(p, Date.now());
      reminderMatterGate(input.matter_id, input.audience, id);
      const r = rs.create(input);
      void rs.tick().catch(() => {});
      return reminderOut(r);
    },
    "reminders.update": (p, id) => {
      const rs = requireReminders();
      const rid = String(p?.reminder_id ?? "");
      const cur = rs.get(rid);
      if (!cur || cur.created_by !== id.userId) throw notFound("提醒");
      const input = parseReminderInput({ ...p, matter_id: cur.matter_id }, Date.now());
      reminderMatterGate(cur.matter_id, input.audience, id, "update");
      const r = rs.update(rid, input);
      void rs.tick().catch(() => {});
      return reminderOut(r);
    },
    "reminders.cancel": (p, id) => {
      const rs = requireReminders();
      const rid = String(p?.reminder_id ?? "");
      const cur = rs.get(rid);
      if (!cur || cur.created_by !== id.userId) throw notFound("提醒");
      const r = rs.cancel(rid);
      void rs.tick().catch(() => {});
      return reminderOut(r);
    },
    /** 云端判定请求不合格的提醒（不应出现）由律师点“重试”。 */
    "reminders.retry": (p, id) => {
      const rs = requireReminders();
      const rid = String(p?.reminder_id ?? "");
      const cur = rs.get(rid);
      if (!cur || cur.created_by !== id.userId) throw notFound("提醒");
      const r = rs.retry(rid);
      void rs.tick().catch(() => {});
      return reminderOut(r);
    },
    /** 标为已读：给 items（编号 + 版本）或 all:true。 */
    "reminders.mark_read": (p, id) => {
      requireReminders();
      const at = nowIso();
      if (p?.all === true) return { updated: db.run(`UPDATE reminder_inbox SET read_at = ? WHERE tenant_id = ? AND read_at IS NULL`, [at, id.tenantId]).changes };
      if (!Array.isArray(p?.items)) throw validation("items 须为数组");
      const items = (p.items as unknown[]).slice(0, 200);
      let n = 0;
      for (const it of items) {
        const x = it as { reminder_id?: unknown; version?: unknown };
        if (typeof x?.reminder_id !== "string" || typeof x.version !== "number") continue;
        n += db.run(`UPDATE reminder_inbox SET read_at = ? WHERE tenant_id = ? AND reminder_id = ? AND version = ? AND read_at IS NULL`, [at, id.tenantId, x.reminder_id, x.version]).changes;
      }
      return { updated: n };
    },
    /**
     * 立即巡检一次（界面“立即同步”与测试；平时每分钟自动）。至多等 wait_ms（缺省 10 秒）：网络不通时界面不长时间停住，
     * 巡检在后台继续（复核 S10B-09）。
     */
    "reminders.sync": async (p) => {
      const rs = requireReminders();
      const waitMs = Math.max(0, Math.min(Number(p?.wait_ms ?? 10_000) || 10_000, 60_000));
      let timer: NodeJS.Timeout | undefined;
      const r = await Promise.race([rs.tick(), new Promise<null>((res) => (timer = setTimeout(() => res(null), waitMs)))]);
      clearTimeout(timer);
      return r
        ? { local: r.local, cloud: r.cloud, finished: true, cloud_status: { configured: rs.cloudConfigured, last: rs.lastCloud } }
        : { local: 0, cloud: 0, finished: false, cloud_status: { configured: rs.cloudConfigured, last: rs.lastCloud } };
    },
    /** 本机的诊断包上传记录（最近 20 次；复核 S9B-02）。 */
    "diagnostics.uploads": (_p, id) => ({
      uploads: db.all(`SELECT upload_id, ticket, bytes, status, error_code, created_at, updated_at FROM support_uploads WHERE tenant_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 20`, [id.tenantId, id.userId]),
    }),
    // “数据去向说明”页的示例请求（UIUX 增量评审 §3.5）：用随包令牌化器对一段虚构的示例句子现场替换（随机密钥、不写令牌表），
    // 让律师看到发给 AI 的内容真实长什么样；示例句子与人物均为虚构（证件号地区码 99 不存在、手机号为示例号段；复核 S6A-13）
    "privacy.example_request": () => {
      const key = randomBytes(32);
      const original = "承租方：周晓梅，身份证号 990105198806152349，手机 13800000000；出租方：北京某某置业有限公司。请指出租赁合同中违约责任条款的风险。";
      const tz = new MatterTokenizer({ matterKey: key, parties: [{ name: "周晓梅", kind: "person" }, { name: "北京某某置业有限公司", kind: "org" }] });
      const r = tz.tokenize(original);
      key.fill(0);
      return { original, sent: r.text, replaced: r.replaced, fictional: true };
    },
    // 进所评测（S8 来源 B；services/recall-eval.ts）：打开、一致性、裁决、评测、保存都在本机；导出报告由内核重新计算、只含计数
    "eval.open": async (p, id) => {
      requireFirmAdmin(id);
      const deps = { parse: (b: Buffer, f: string, m: string) => parseAny(b, f, m) };
      // 桌面客户端经主进程句柄给路径；web 开发形态由界面传字节
      const r = p?.path ? await openEvalFile(String(p.path), deps) : p?.data_base64 ? await openEvalBytes(Buffer.from(String(p.data_base64), "base64"), String(p?.filename ?? ""), deps) : await openEvalFile("", deps);
      audit(db, id, "eval.open", "device", keyctx.device.deviceId, undefined, keyctx);
      return r;
    },
    // 召回评测只对律所管理员与合伙人开放（复核 S6A-09：与设置页“管理”一致，授权以内核为准）
    "eval.agreement": (p, id) => {
      requireFirmAdmin(id);
      return compareAnnotations(normalizeDocs(p?.a, "甲的标注"), normalizeDocs(p?.b, "乙的标注"));
    },
    "eval.adjudicate": (p, id) => {
      requireFirmAdmin(id);
      const [a] = normalizeDocs([p?.a], "甲的标注");
      const [b] = normalizeDocs([p?.b], "乙的标注");
      return adjudicate(a!, b!, parseDecisions(p?.decisions));
    },
    "eval.recall": (p, id) => {
      requireFirmAdmin(id);
      const r = runRecallEval(normalizeDocs(p?.docs), { fullPseudonym: p?.full_pseudonym === true, caseNumbers: p?.case_numbers === true });
      audit(db, id, "eval.recall", "device", keyctx.device.deviceId, undefined, keyctx);
      return r;
    },
    "eval.save_work": (p, id) => {
      requireFirmAdmin(id);
      const text = workFileText(normalizeDocs(p?.docs, "标注"));
      audit(db, id, "eval.save_work", "device", keyctx.device.deviceId, undefined, keyctx);
      if (!p?.save_path) return { text };
      const saved = writeExportFile(String(p.save_path), Buffer.from(text, "utf8"), config.workspaceDir);
      return { saved: true, filename: saved.name };
    },
    "eval.save_report": (p, id) => {
      requireFirmAdmin(id);
      const text = reportFileText(runRecallEval(normalizeDocs(p?.docs), { fullPseudonym: p?.full_pseudonym === true, caseNumbers: p?.case_numbers === true }));
      audit(db, id, "eval.save_report", "device", keyctx.device.deviceId, undefined, keyctx);
      if (!p?.save_path) return { text };
      const saved = writeExportFile(String(p.save_path), Buffer.from(text, "utf8"), config.workspaceDir);
      return { saved: true, filename: saved.name };
    },
    // Windows 环境自检（v9.2 §3.7；Y5 P1-6）：只读、结果缓存 1 小时（刷新时重新检查）；只含枚举与杀软产品名
    "device.env_probe": async (p) => {
      if (!envProbeCache || p?.refresh === true || Date.now() - envProbeCache.at > 3600_000) envProbeCache = { at: Date.now(), result: await probeEnvironment() };
      return envProbeCache.result;
    },
    // 日志级别（Y5 §5.2）：设备页可临时开启 debug，24 小时后自动回到 info；字段规则不变（debug 也只记登记的事件）
    "diagnostics.set_log_level": (p) => {
      const level = (p as { level?: unknown } | undefined)?.level;
      if (level !== "debug" && level !== "info") throw new DomainError("validation", "日志级别只能是 debug 或 info", 422);
      slog.setLevel(level);
      return { level: slog.currentLevel() };
    },
  };
  return all;
}
