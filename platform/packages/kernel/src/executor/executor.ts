/**
 * 确定性工作流执行器（方案 v5.0 第 4 篇 §6.1：生产档场景由代码编排的工作流执行，
 * 直接调用本机工具与模型代理，不经过 Agent；由 v4.0 services/bff DBOS 编排平移）。
 *
 * 语义落点：
 * - 权威状态在事项账本（runs/attempts/run_events），本地持久任务队列只做执行持久化（§6.1）；
 * - 事件先落账本再推界面（§1.1 约束 3）；
 * - 取消：协作式——每步前检查权威状态；取消后不再批准新动作；
 * - 预算：入队预留、成功结算、失败/取消释放；
 * - 恢复：步骤检查点 + 幂等（事件 seq 唯一约束 INSERT OR IGNORE），崩溃后从最后检查点继续。
 */
import { DomainError, RunStatus, canTransitionRun, newId, sha256Hex } from "@zr-legal/domain";
import { replaceDirectIdentifiers } from "@zr-legal/pseudonym";
import type { ModelBroker } from "@zr-legal/model-broker";
import type { Lawdb } from "@zr-legal/lawdb";
import type { KernelDb } from "../db.ts";
import type { BlobStore } from "../blobs.ts";
import { WORKER_ID, type WorkflowContext } from "../queue.ts";
import { runEventPayloadHash, type LedgerSigner } from "../ledger-signer.ts";
import { invokeTool } from "../tools/registry.ts";
import { buildS1Deliverables, type ToolIdentity } from "./deliverables.ts";
import { buildS2Deliverables, extractFacts, persistAnchors } from "./casefile.ts";
import type { AgentClient } from "./agent-client.ts";

export interface ExecutorDeps {
  db: KernelDb;
  blobs: BlobStore;
  broker: ModelBroker;
  agentClient: AgentClient;
  lawdb: Lawdb;
  /** 签名事件链（§5.2）：存在时 run_events 插入与签名见证同事务追加（OR IGNORE 去重时不签）。 */
  signer?: LedgerSigner | undefined;
}

interface RunRow {
  run_id: string;
  tenant_id: string;
  matter_id: string;
  scenario: string;
  workflow_version: string;
  status: string;
  input_snapshot: string;
  budget_points: number;
  points_reserved: number;
  created_by: string;
}

class RunCancelled extends Error {
  constructor() {
    super("run cancelled");
    this.name = "RunCancelled";
  }
}

type Ctx = WorkflowContext & { deps: ExecutorDeps };

function inputSnapshot(run: RunRow): any {
  try {
    return JSON.parse(run.input_snapshot);
  } catch {
    return {};
  }
}

function getRun(db: KernelDb, runId: string): RunRow {
  const run = db.get<RunRow>(`SELECT * FROM runs WHERE run_id = ?`, [runId]);
  if (!run) throw new DomainError("not_found", `任务 ${runId} 不存在`, 404);
  return run;
}

function appendEvent(deps: ExecutorDeps, runId: string, attemptId: string | null, seq: number, type: string, payload: Record<string, unknown>): void {
  const { db, signer } = deps;
  if (!signer) {
    db.run(`INSERT OR IGNORE INTO run_events (run_id, attempt_id, seq, type, payload) VALUES (?,?,?,?,?)`, [
      runId,
      attemptId,
      seq,
      type,
      JSON.stringify(payload),
    ]);
    return;
  }
  db.tx(() => {
    const r = db.run(`INSERT OR IGNORE INTO run_events (run_id, attempt_id, seq, type, payload) VALUES (?,?,?,?,?)`, [
      runId,
      attemptId,
      seq,
      type,
      JSON.stringify(payload),
    ]);
    if (r.changes > 0) {
      const run = db.get<{ matter_id: string }>(`SELECT matter_id FROM runs WHERE run_id = ?`, [runId]);
      signer.append({ kind: "run_event", refId: String(r.lastInsertRowid), matterId: run?.matter_id ?? null, type, payloadHash: runEventPayloadHash(runId, attemptId, seq, type, payload) });
    }
  });
}

/** 工具操作账本（§6.1 幂等：以「任务 + 工具 + 操作 + 输入 hash」为键去重——重放不产生重复行）。 */
function recordToolOperation(
  db: KernelDb,
  runId: string,
  attemptId: string,
  tool: string,
  operation: string,
  params: unknown,
  status: "succeeded" | "failed",
  resultUri: string | null = null,
): void {
  const paramsHash = sha256Hex(JSON.stringify(params ?? {}));
  const dup = db.get(
    `SELECT tool_operation_id FROM tool_operations WHERE run_id = ? AND tool = ? AND operation = ? AND params_hash = ? AND status = ?`,
    [runId, tool, operation, paramsHash, status],
  );
  if (dup) return;
  db.run(
    `INSERT INTO tool_operations (tool_operation_id, run_id, attempt_id, tool, operation, params_hash, status, result_uri)
     VALUES (?,?,?,?,?,?,?,?)`,
    [newId("toolOperation"), runId, attemptId, tool, operation, paramsHash, status, resultUri],
  );
}

/** 有界退避（§10.1 故障：429/超时有界退避）：仅对供应商不可用重试，最多 3 次。 */
async function withBoundedRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const code = (err as DomainError)?.code;
      if (code !== "provider_unavailable") throw err;
      const delay = 500 * 2 ** attempt;
      console.warn(`[executor] ${label} provider_unavailable, retry ${attempt + 1}/3 in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

function setStatus(db: KernelDb, runId: string, from: string, to: string): void {
  if (!canTransitionRun(from as any, to as any)) throw new DomainError("conflict", `非法状态迁移 ${from}→${to}`, 409);
  const r = db.run(`UPDATE runs SET status = ?, status_version = status_version + 1, updated_at = ? WHERE run_id = ? AND status = ?`, [
    to,
    new Date().toISOString(),
    runId,
    from,
  ]);
  if (r.changes === 0) throw new DomainError("conflict", `状态已变化（${from}→${to} 未生效）`, 409);
}

function assertNotCancelled(db: KernelDb, runId: string): void {
  const run = getRun(db, runId);
  if (run.status === RunStatus.cancelled) throw new RunCancelled();
}

function toolCtx(run: RunRow, runId: string, attemptId: string): { claims: any & ToolIdentity } {
  const claims = { tid: run.tenant_id, uid: run.created_by, mid: run.matter_id, rid: runId, aid: attemptId, scope: ["tool:internal"], exp: 0 };
  return { claims };
}

// ─── 步骤（ctx.step：崩溃恢复时已完成的步骤不重放；每步幂等） ───

/**
 * 起始步骤（不检查点、可重入）：断电恢复后任务被重新拉起时本步骤会再次执行——
 * 插入新尝试行、把 queued（恢复重置）或 running 推进为 running；事件按 seq 唯一约束不重复。
 * 注意：不得放进 ctx.step 检查点（否则恢复时状态迁移被跳过，任务停在 queued 无法结算——探针 11 回归项）。
 *
 * 引用核验覆盖边界（如实声明）：citations.verify（含案号「未核实（离线）」→ 签发门禁）G0 只挂在
 * S1 默认路径（load_materials → verify_citations）；S1b/S2/S6/A1 成果的引用核验步骤在 W10
 * （法源与核验工作包）补齐，其案号引用暂不受 unverified_citations 门禁约束。
 */
async function stepStart(ctx: Ctx, runId: string): Promise<{ attemptId: string }> {
  const { db } = ctx.deps;
  const run = getRun(db, runId);
  if (run.status === RunStatus.cancelled) throw new RunCancelled();
  const attemptId = ctx.attemptId;
  const row = db.get<{ next: number }>(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM attempts WHERE run_id = ?`, [runId])!;
  const leaseUntil = new Date(Date.now() + 10 * 60_000).toISOString();
  db.run(
    `INSERT INTO attempts (attempt_id, run_id, seq, status, lease_owner, lease_until, fence_token)
     VALUES (?,?,?,'running',?,?,?)`,
    [attemptId, runId, row.next, WORKER_ID, leaseUntil, row.next],
  );
  // 可重入状态迁移：queued（含恢复重置）或残留 running → running；终态不受影响
  const r = db.run(
    `UPDATE runs SET status = 'running', status_version = status_version + 1, updated_at = ? WHERE run_id = ? AND status IN ('queued','running')`,
    [new Date().toISOString(), runId],
  );
  if (r.changes === 0) throw new DomainError("conflict", `任务 ${runId} 当前状态 ${run.status} 不可启动`, 409);
  appendEvent(ctx.deps, runId, attemptId, 10, "run.started", {
    scenario: run.scenario,
    workflow_version: run.workflow_version,
    worker: WORKER_ID,
    where: "本机", // 执行位置常显（第 2 篇 §4.4）：G0 工作流都在本机内核执行
  });
  const planSteps =
    run.scenario === "a1.agent_task"
      ? ["载入材料", "启动隔离 Agent worker", "执行并镜像事件", "产出草稿（仅草稿）", "结算"]
      : run.scenario === "s1b.draft_compare"
        ? ["整稿比对（含静默改动）", "生成比对报告与差异表", "结算"]
        : run.scenario === "s6.redaction"
          ? ["载入材料", "确定性脱敏", "生成脱敏件与报告", "结算"]
          : run.scenario === "s2.case_file"
            ? ["载入材料", "事实抽取（确定性，锚点入库）", "生成目录/时间轴/矩阵/补证/质量报告", "结算"]
            : ["载入材料", "引用核验", "模型审查", "生成交付件（修订稿/清洁稿/意见书/问题表）", "结算"];
  appendEvent(ctx.deps, runId, attemptId, 11, "plan.created", {
    steps: planSteps,
    note: "计划先行（第 2 篇 §4.4）；v0 为固定步骤",
  });
  return { attemptId };
}

export interface MaterialSlice {
  document_version_id: string;
  parse_version_id: string;
  filename: string;
  chars: number;
  sha256: string;
  text: string;
  quality_flags: string[];
  page_count?: number | null | undefined;
  pages?: { pageNo: number; quality: string; note?: string | undefined }[] | undefined;
}

async function stepLoadMaterials(ctx: Ctx, runId: string, attemptId: string): Promise<MaterialSlice[]> {
  const { db } = ctx.deps;
  assertNotCancelled(db, runId);
  const run = getRun(db, runId);
  const docIds: string[] = inputSnapshot(run)?.document_version_ids ?? [];
  const out: MaterialSlice[] = [];
  let failed = 0;
  for (const docId of docIds) {
    const r = db.get<any>(
      `SELECT dv.document_version_id, dv.filename, dv.sha256, pv.parse_version_id, pv.quality_flags, pv.page_count, pt.content
         FROM document_versions dv
         JOIN parse_versions pv ON pv.document_version_id = dv.document_version_id
         JOIN parse_texts pt ON pt.parse_version_id = pv.parse_version_id
        WHERE dv.document_version_id = ? AND dv.matter_id = ?
        ORDER BY pv.created_at DESC LIMIT 1`,
      [docId, run.matter_id],
    );
    if (!r) {
      failed += 1;
      continue;
    }
    const pages = db.all<{ page_no: number; quality: string; note: string | null }>(
      `SELECT page_no, quality, note FROM parse_pages WHERE parse_version_id = ? ORDER BY page_no`,
      [r.parse_version_id],
    );
    out.push({
      document_version_id: r.document_version_id,
      parse_version_id: r.parse_version_id,
      filename: r.filename,
      chars: (r.content as string).length,
      sha256: r.sha256,
      text: (r.content as string).slice(0, 50_000),
      quality_flags: typeof r.quality_flags === "string" ? JSON.parse(r.quality_flags) : (r.quality_flags ?? []),
      page_count: r.page_count ?? null,
      pages: pages.map((pg) => ({ pageNo: pg.page_no, quality: pg.quality, note: pg.note ?? undefined })),
    });
  }
  // 进度只说事实（第 2 篇 §4.4 交互 2）
  appendEvent(ctx.deps, runId, attemptId, 20, "materials.loaded", {
    requested: docIds.length,
    loaded: out.length,
    failed,
    files: out.map((m) => ({ name: m.filename, chars: m.chars, quality: m.quality_flags })),
  });
  return out;
}

interface CitationSummary {
  total: number;
  intercepted: number;
  verdicts: unknown[];
  intercepted_items: unknown[];
}

function loadMatter(db: KernelDb, matterId: string): any {
  const m = db.get(`SELECT * FROM matters WHERE matter_id = ?`, [matterId]);
  if (!m) throw new DomainError("not_found", "事项不存在", 404);
  return { ...m, key_dates: typeof (m as any).key_dates === "string" ? JSON.parse((m as any).key_dates) : ((m as any).key_dates ?? {}) };
}

function matterCtxOf(matter: any): { stance: string; jurisdiction: string; asOf: string } {
  return {
    stance: matter.stance ?? "未指定",
    jurisdiction: matter.jurisdiction ?? "内地民商事",
    asOf: matter.key_dates?.analysis_as_of ?? new Date().toISOString().slice(0, 10),
  };
}

async function stepVerifyCitations(ctx: Ctx, runId: string, attemptId: string, materials: MaterialSlice[]): Promise<CitationSummary> {
  const { db } = ctx.deps;
  assertNotCancelled(db, runId);
  const run = getRun(db, runId);
  const ctxM = matterCtxOf(loadMatter(db, run.matter_id));
  const asOf = ctxM.asOf;
  const topicHint = inputSnapshot(run)?.topic_hint as string | undefined;
  const combined = materials.map((m) => m.text).join("\n\n").slice(0, 80_000);
  const result = await withBoundedRetry(async () => {
    try {
      const params: Record<string, unknown> = { text: combined, as_of: asOf };
      if (topicHint) params.topic_hint = topicHint;
      const r = (await invokeTool("citations.verify", params, { ...toolCtx(run, runId, attemptId), db: ctx.deps.db, blobs: ctx.deps.blobs, lawdb: ctx.deps.lawdb })) as any;
      recordToolOperation(db, runId, attemptId, "citations.verify", "verify", { as_of: asOf, topic_hint: topicHint, chars: combined.length }, "succeeded");
      return r;
    } catch (err) {
      recordToolOperation(db, runId, attemptId, "citations.verify", "verify", { as_of: asOf }, "failed");
      throw err;
    }
  }, "citations.verify");
  const summary: CitationSummary = {
    total: result.summary?.total ?? 0,
    intercepted: result.summary?.intercepted ?? 0,
    verdicts: result.verdicts ?? [],
    intercepted_items: result.intercepted ?? [],
  };
  // 拦截可见（§5.3）：不静默删除；完整裁决随事件供工作台展示（含案号离线未核实数，签发门禁依此拦截）
  appendEvent(ctx.deps, runId, attemptId, 30, "citations.verified", {
    total: summary.total,
    intercepted: summary.intercepted,
    unverified_offline: result.summary?.unverified_offline ?? 0,
    verdicts: result.verdicts ?? [],
    intercepted_items: summary.intercepted_items,
    as_of: asOf,
    registry_coverage: result.registry_coverage ?? ctx.deps.lawdb.packageVersion,
    where: "本机（离线核验）",
  });
  return summary;
}

interface ReviewResult {
  content: string;
  request_id: string;
  route: string;
  cost_microcny: number | null;
  provider: string;
  usage: Record<string, unknown>;
  egress_record_id: string;
}

async function stepModelReview(ctx: Ctx, runId: string, attemptId: string, materials: MaterialSlice[], citations: CitationSummary): Promise<ReviewResult> {
  const { db, broker } = ctx.deps;
  assertNotCancelled(db, runId);
  const run = getRun(db, runId);
  const matter = loadMatter(db, run.matter_id);
  const ctxM = matterCtxOf(matter);
  // 提示组装（§10.1 缓存友好）：系统提示 → 基础方法包 → 盐值块（按律所派生）→ 本所覆盖层 → 材料片段 → 任务
  const playbook = [
    "你是 Kimi Work 法律发行版的合同审查助手。按本所 Playbook 审查合同：",
    "1) 逐条识别对我方不利的条款、缺失条款与歧义表述；",
    "2) 每条发现给出：原文锚点、问题、影响、建议文本、触发规则、依据；",
    "3) 依据须可核验；无法核实的引用必须列出，不得编造。",
    "4) 立场以事项口径为准；不替律师做是否签约的决定。",
  ].join("\n");
  // 盐值块（§10.1：跨律所共享只到「系统提示 + 基础方法包」为止；其后插入按律所派生的盐值块，材料片段不可能跨律所命中）
  const salt = sha256Hex(`${run.tenant_id}:kwl-prefix-salt-v0`).slice(0, 16);
  const saltBlock = `【律所盐值块 ${salt}：前缀缓存按律所隔离】`;
  const matterCtx = `事项口径：立场=${ctxM.stance}；法域=${ctxM.jurisdiction}；分析截止日=${ctxM.asOf}；场景=${run.scenario}`;
  // 全流程化名（第 3 篇 S6：发往模型前替换直接标识符；v0 规则第一遍，词典/NER 在 W7 接入；
  // 出站闸门仍会逐段复扫——双保险，不静默发送明文）
  const rawExcerpts = materials.map((m) => `【材料 ${m.filename}】\n${m.text.slice(0, 12_000)}`).join("\n\n");
  const pseudo = replaceDirectIdentifiers(rawExcerpts);
  const excerpts = pseudo.text;
  const egressNote =
    pseudo.replaced > 0
      ? `全流程化名：发送前已按规则替换 ${pseudo.replaced} 处直接标识符（${Object.entries(pseudo.counts).map(([k, v]) => `${k}×${v}`).join("、")}）；映射表入账本（第 3–4 周加密），模型返回在本机还原`
      : null;
  const citationNote =
    citations.intercepted > 0
      ? `注意：引用核验已拦截 ${citations.intercepted} 条无法核实/需改引的引用，须在分析中如实标注，不得引用为有效依据。`
      : "引用核验未发现问题。";

  const result = await withBoundedRetry(async () => {
    try {
      const r = await broker.chat({
        matter,
        task: { tid: run.tenant_id, uid: run.created_by, mid: run.matter_id, rid: runId, aid: attemptId },
        route: "legal/k3",
        messages: [
          { role: "system", content: `${playbook}\n\n${saltBlock}\n\n${matterCtx}` },
          { role: "user", content: `${citationNote}\n\n材料：\n${excerpts}\n\n任务：输出审查分析（JSON 或结构化文本）。` },
        ],
        clientIdempotencyId: `s1_review_${runId}`,
        note: egressNote ?? undefined,
      });
      recordToolOperation(db, runId, attemptId, "model", "chat", { route: "legal/k3" }, "succeeded");
      return r;
    } catch (err) {
      recordToolOperation(db, runId, attemptId, "model", "chat", { route: "legal/k3" }, "failed");
      throw err;
    }
  }, "model.review");

  appendEvent(ctx.deps, runId, attemptId, 40, "model.completed", {
    request_id: result.requestId,
    route: "legal/k3",
    provider: result.provider,
    endpoint: result.endpointKind,
    cost_microcny: result.costMicroCny,
    usage: { input: result.usage.uncached_input + result.usage.cached_input, output: result.usage.output, reasoning: result.usage.reasoning },
    egress_record_id: result.egressRecordId,
    where: result.endpointKind === "mock" ? "本机（mock）" : "模型推理中",
  });
  return {
    content: result.content ?? "",
    request_id: result.requestId,
    route: "legal/k3",
    cost_microcny: result.costMicroCny,
    provider: result.provider,
    usage: result.usage as unknown as Record<string, unknown>,
    egress_record_id: result.egressRecordId,
  };
}

async function stepStoreDraft(ctx: Ctx, runId: string, attemptId: string, materials: MaterialSlice[], citations: CitationSummary, review: ReviewResult): Promise<{ artifactId: string }> {
  const { db, blobs } = ctx.deps;
  assertNotCancelled(db, runId);
  const run = getRun(db, runId);
  const primary = materials[0];
  if (!primary) throw new DomainError("validation", "无材料可交付", 422);

  const built = buildS1Deliverables(db, blobs, { tid: run.tenant_id, uid: run.created_by, mid: run.matter_id, rid: runId, aid: attemptId }, {
    runId,
    matterId: run.matter_id,
    tenantId: run.tenant_id,
    createdBy: run.created_by,
    primaryDoc: { document_version_id: primary.document_version_id, filename: primary.filename, sha256: primary.sha256 },
    citations: {
      total: citations.total,
      intercepted: citations.intercepted,
      verdicts: citations.verdicts,
      intercepted_items: citations.intercepted_items as any,
    },
    reviewText: review.content,
    modelMeta: { request_id: review.request_id, route: review.route, cost_microcny: review.cost_microcny },
  });

  let firstArtifactId = "";
  let artSeq = 50;
  for (const art of built.artifacts) {
    const artifactId = registerArtifact(ctx, getRun(db, runId), runId, attemptId, art, artSeq++);
    if (!firstArtifactId) firstArtifactId = artifactId;
  }
  if (built.degraded.length > 0) {
    appendEvent(ctx.deps, runId, attemptId, 58, "run.degraded", { notes: built.degraded });
  }
  return { artifactId: firstArtifactId };
}

/** §2.2 manifest 公共段：材料清单及 hash、研究时点、模型端点与路由版本、规则包版本、来源及许可标识。 */
function manifestBase(db: KernelDb, run: RunRow, lawdbPackageVersion: string): Record<string, unknown> {
  const snap = inputSnapshot(run);
  const docIds: string[] = Array.isArray(snap?.document_version_ids) ? snap.document_version_ids : [];
  const materials = docIds
    .map((id) => db.get<{ document_version_id: string; filename: string; sha256: string }>(`SELECT document_version_id, filename, sha256 FROM document_versions WHERE document_version_id = ?`, [id]))
    .filter(Boolean);
  const matter = loadMatter(db, run.matter_id);
  const ctxM = matterCtxOf(matter);
  return {
    materials: materials.map((m) => ({ document_version_id: m!.document_version_id, filename: m!.filename, sha256: m!.sha256 })),
    as_of: ctxM.asOf,
    jurisdiction: ctxM.jurisdiction,
    stance: ctxM.stance,
    model_endpoint: matter.model_endpoint,
    workflow_version: run.workflow_version,
    rule_pack: "v0-CITE-RENUMBER",
    source_license: `lawdb:${lawdbPackageVersion}（签名法规库包；Source Registry 随包分发）`,
  };
}

/** 成果登记（版本按 事项+kind+audience 递增；草稿状态；manifest 完整含数据去向记录 ID，§2.2）。 */
function registerArtifact(
  ctx: Ctx,
  run: RunRow,
  runId: string,
  attemptId: string,
  art: { kind: string; filename: string; sha256: string; storage_uri: string; manifest: Record<string, unknown>; open_items?: unknown[] },
  seq: number,
): string {
  const { db } = ctx.deps;
  // §6.1 幂等：成果写入以内容 hash 去重（重放/同内容复跑不产生重复版本）
  const existing = db.get<{ artifact_version_id: string }>(
    `SELECT artifact_version_id FROM artifact_versions WHERE matter_id = ? AND kind = ? AND audience = 'internal' AND sha256 = ?`,
    [run.matter_id, art.kind, art.sha256],
  );
  if (existing) return existing.artifact_version_id;
  const artifactId = newId("artifactVersion");
  const v = db.get<{ next: number }>(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM artifact_versions WHERE matter_id = ? AND kind = ? AND audience = 'internal'`,
    [run.matter_id, art.kind],
  )!;
  // 交付记录（§2.2 manifest）：材料清单及 hash、研究时点、端点与路由版本、规则包版本、来源许可、数据去向记录 ID
  const egressIds = db.all<{ record_id: string }>(`SELECT record_id FROM egress_records WHERE run_id = ? ORDER BY created_at`, [runId]).map((r) => r.record_id);
  const manifest = { ...manifestBase(db, run, ctx.deps.lawdb.packageVersion), ...art.manifest, egress_record_ids: egressIds };
  db.run(
    `INSERT INTO artifact_versions
      (artifact_version_id, tenant_id, matter_id, run_id, kind, version, baseline_id, audience, status,
       filename, sha256, storage_uri, open_items, manifest, created_by)
     VALUES (?,?,?,?,?,?,NULL,'internal','draft',?,?,?,?,?,?)`,
    [artifactId, run.tenant_id, run.matter_id, runId, art.kind, v.next, art.filename, art.sha256, art.storage_uri, JSON.stringify(art.open_items ?? []), JSON.stringify(manifest), run.created_by],
  );
  appendEvent(ctx.deps, runId, attemptId, seq, "artifact.drafted", { artifact_version_id: artifactId, kind: art.kind, filename: art.filename, sha256: art.sha256 });
  return artifactId;
}

async function stepSettle(ctx: Ctx, runId: string, attemptId: string): Promise<void> {
  const { db } = ctx.deps;
  const run = getRun(db, runId);
  if (run.status === RunStatus.cancelled) throw new RunCancelled();
  db.run(`UPDATE runs SET points_charged = points_reserved WHERE run_id = ?`, [runId]);
  setStatus(db, runId, RunStatus.running, RunStatus.succeeded);
  db.run(`UPDATE attempts SET status = 'succeeded', ended_at = ? WHERE attempt_id = ?`, [new Date().toISOString(), attemptId]);
  appendEvent(ctx.deps, runId, attemptId, 60, "run.succeeded", { points_charged: run.points_reserved });
}

/** S1b 回稿比对与受影响条款重审（§S1b：含静默改动检出；无回稿不制造差异表；本机完成，不调用模型）。 */
async function runS1bScenario(ctx: Ctx, runId: string, attemptId: string): Promise<void> {
  const { db, blobs } = ctx.deps;
  const run = getRun(db, runId);
  const snap = inputSnapshot(run);
  const baselineId = String(snap?.baseline_document_version_id ?? "");
  const currentId = String(snap?.current_document_version_id ?? "");
  if (!baselineId || !currentId) throw new DomainError("validation", "S1b 需要 baseline_document_version_id 与 current_document_version_id（无回稿不制造差异表）", 422);

  const cmp = await ctx.step("compare", async () => {
    assertNotCancelled(db, runId);
    const r = (await invokeTool("docx.compare", { baseline_document_version_id: baselineId, current_document_version_id: currentId }, { ...toolCtx(run, runId, attemptId), db, blobs, lawdb: ctx.deps.lawdb })) as any;
    recordToolOperation(db, runId, attemptId, "docx.compare", "compare", { baselineId, currentId }, "succeeded");
    return r;
  });

  await ctx.step("s1b_report", async () => {
    appendEvent(ctx.deps, runId, attemptId, 30, "compare.completed", {
      added: cmp.stats.added,
      deleted: cmp.stats.deleted,
      modified: cmp.stats.modified,
      silent: cmp.stats.silent,
      curHasTrackedChanges: cmp.curHasTrackedChanges,
      where: "本机",
    });
    const changedLines = cmp.changes.slice(0, 200).map((c: any, i: number) => {
      const tag = c.type === "added" ? "新增" : c.type === "deleted" ? "删除" : "修改";
      const silent = c.silent ? "【静默改动】" : "";
      return `${i + 1}. [${tag}]${silent} 旧：${c.baseText || "（无）"} ／ 新：${c.curText || "（无）"}`;
    });
    const report = (await invokeTool(
      "docx.render_report",
      {
        title: "回稿比对报告",
        sections: [
          {
            heading: "一、比对概况",
            paragraphs: [
              `新增 ${cmp.stats.added} 段、删除 ${cmp.stats.deleted} 段、修改 ${cmp.stats.modified} 段；其中静默改动 ${cmp.stats.silent} 段。`,
              cmp.curHasTrackedChanges ? "回稿含修订标记。" : "回稿不含任何修订标记（对方未开修订），全部改动按静默改动对待。",
              "受影响条款的原复核结论不自动继承，需律师重新复核（§4.4）。",
            ],
          },
          { heading: "二、改动清单", paragraphs: changedLines.length > 0 ? changedLines : ["（无差异）"] },
        ],
      },
      { ...toolCtx(run, runId, attemptId), db, blobs, lawdb: ctx.deps.lawdb },
    )) as any;
    registerArtifact(ctx, run, runId, attemptId, {
      kind: "s1b_report",
      filename: `回稿比对报告-${runId.slice(-6)}.docx`,
      sha256: report.sha256,
      storage_uri: report.storage_uri,
      manifest: { baseline: cmp.baseline_sha256, current: cmp.current_sha256, stats: cmp.stats },
    }, 40);
    const { createXlsx } = await import("@zr-legal/docx-engine");
    const rows: (string | number | null)[][] = [
      ["序号", "类型", "静默改动", "基线段", "旧文", "新文", "原建议状态", "重新复核人"],
      ...cmp.changes.map((c: any, i: number) => [i + 1, c.type, c.silent ? "是" : "否", c.baseIndex !== null ? c.baseIndex + 1 : "", c.baseText, c.curText, "", ""] as (string | number | null)[]),
    ];
    const stored = blobs.put(createXlsx([{ name: "回稿差异表", rows }]), run.matter_id);
    registerArtifact(ctx, run, runId, attemptId, {
      kind: "s1b_diff_table",
      filename: `回稿差异表-${runId.slice(-6)}.xlsx`,
      sha256: stored.sha256,
      storage_uri: stored.storage_uri,
      manifest: { rows: rows.length - 1 },
    }, 41);
  });

  await ctx.step("settle", () => stepSettle(ctx, runId, attemptId));
}

/** S6 对外脱敏件与脱敏报告（§S6：脱敏不可还原、不留修订痕迹；本机完成，不调用模型）。 */
async function runS6Scenario(ctx: Ctx, runId: string, attemptId: string): Promise<void> {
  const { db, blobs } = ctx.deps;
  const run = getRun(db, runId);
  const materials = await ctx.step("load_materials", () => stepLoadMaterials(ctx, runId, attemptId));
  if (materials.length === 0) throw new DomainError("validation", "S6 需要至少一份材料", 422);

  await ctx.step("s6_apply", async () => {
    assertNotCancelled(db, runId);
    const reportParas: string[] = [];
    let seq = 40;
    for (const m of materials) {
      const r = (await invokeTool("redact.apply", { document_version_id: m.document_version_id }, { ...toolCtx(run, runId, attemptId), db, blobs, lawdb: ctx.deps.lawdb })) as any;
      recordToolOperation(db, runId, attemptId, "redact.apply", "apply", { doc: m.document_version_id }, "succeeded");
      registerArtifact(ctx, run, runId, attemptId, {
        kind: "s6_redacted",
        filename: `脱敏件-${m.filename}`,
        sha256: r.sha256,
        storage_uri: r.storage_uri,
        manifest: { source: m.sha256, report: r.report, note: "不可还原；对照表单独限权（v0 未产出对照表，见报告）" },
      }, seq++);
      reportParas.push(
        `《${m.filename}》：发现 ${r.report.findings} 处直接标识符（${Object.entries(r.report.counts ?? {}).map(([k, v]) => `${k}×${v}`).join("、") || "无"}），全部遮盖${r.report.notFound?.length ? `；${r.report.notFound.length} 处定位失败需人工处理` : ""}。`,
      );
      if (r.report.findings === 0) reportParas.push("  未发现需遮盖的直接标识符。");
    }
    const report = (await invokeTool(
      "docx.render_report",
      {
        title: "脱敏报告",
        sections: [
          { heading: "一、覆盖范围与替换统计", paragraphs: reportParas },
          {
            heading: "二、未能处理的对象与残余风险",
            paragraphs: [
              "自然人姓名、详细地址、批注/修订/文档属性、图片与扫描件内文字不在 v0 覆盖范围（需 NER/OCR，G1 评测验收）。",
              "脱敏不可还原；化名对照表（如需）应单独限权加密保存，不随对外文件打包。",
            ],
          },
          { heading: "三、复核", paragraphs: ["复核人：____（脱敏件签发前须经律师复核）"] },
        ],
      },
      { ...toolCtx(run, runId, attemptId), db, blobs, lawdb: ctx.deps.lawdb },
    )) as any;
    registerArtifact(ctx, run, runId, attemptId, {
      kind: "s6_report",
      filename: `脱敏报告-${runId.slice(-6)}.docx`,
      sha256: report.sha256,
      storage_uri: report.storage_uri,
      manifest: { note: "脱敏报告（内部稿）" },
    }, 68);
  });

  await ctx.step("settle", () => stepSettle(ctx, runId, attemptId));
}

/** S2 案卷整理（§S2：入库/事实抽取带锚点/时间轴/目录/矩阵骨架/补证/质量报告；本机完成）。 */
async function runS2Scenario(ctx: Ctx, runId: string, attemptId: string): Promise<void> {
  const { db, blobs } = ctx.deps;
  const run = getRun(db, runId);
  const materials = await ctx.step("load_materials", () => stepLoadMaterials(ctx, runId, attemptId));
  if (materials.length === 0) throw new DomainError("validation", "S2 需要至少一份材料", 422);

  await ctx.step("extract_facts", async () => {
    assertNotCancelled(db, runId);
    // 事实抽取（确定性）+ 锚点入库（关键事实定位正确率的验收基础）
    const facts = materials.flatMap((m) =>
      extractFacts({
        document_version_id: m.document_version_id,
        parse_version_id: m.parse_version_id,
        filename: m.filename,
        text: m.text,
      }),
    );
    const n = persistAnchors(db, facts);
    recordToolOperation(db, runId, attemptId, "facts.extract", "deterministic", { docs: materials.length, facts: facts.length }, "succeeded");
    appendEvent(ctx.deps, runId, attemptId, 30, "facts.extracted", {
      dates: facts.filter((f) => f.kind === "date").length,
      amounts: facts.filter((f) => f.kind === "amount").length,
      parties: facts.filter((f) => f.kind === "party").length,
      anchors_persisted: n,
      note: "类型标签均为材料记载；推断与证明力由律师完成",
      where: "本机",
    });
    return facts.length;
  });

  await ctx.step("build_s2_deliverables", async () => {
    assertNotCancelled(db, runId);
    const matter = db.get(`SELECT title, client_name, counterparty, stance FROM matters WHERE matter_id = ?`, [run.matter_id]);
    const built = buildS2Deliverables({
      runId,
      matter: matter as any,
      materials: materials.map((m) => ({
        document_version_id: m.document_version_id,
        parse_version_id: m.parse_version_id,
        filename: m.filename,
        sha256: m.sha256,
        chars: m.chars,
        quality_flags: m.quality_flags,
        text: m.text,
      })),
      issues: Array.isArray(inputSnapshot(run)?.issues) ? inputSnapshot(run).issues : [],
    });
    let seq = 40;
    for (const f of built.files) {
      const stored = blobs.put(f.bytes, run.matter_id);
      registerArtifact(
        ctx,
        run,
        runId,
        attemptId,
        { kind: f.kind, filename: f.filename, sha256: stored.sha256, storage_uri: stored.storage_uri, manifest: { ...f.manifest, facts: built.factsCount } },
        seq++,
      );
    }
  });

  await ctx.step("settle", () => stepSettle(ctx, runId, attemptId));
}

/**
 * A1 Agent 模式（第 3 篇 §5 A1）：开放任务 → 计划 → 执行 → 产物只能是草稿。
 * 阶段 1 经 agent-runtime 隔离 worker（Kimi Code 引擎，内置工具全禁、只连本机法律工具）；
 * 阶段 2 切换为 apps/agent-host（命名管道 + ZP-5/6），事件镜像语义不变。
 */
async function runAgentScenario(ctx: Ctx, runId: string, attemptId: string): Promise<void> {
  const { db, agentClient } = ctx.deps;
  const run = getRun(db, runId);
  const goal = String(inputSnapshot(run)?.goal ?? "").slice(0, 8000);
  if (!goal) throw new DomainError("validation", "A1 任务需要 goal", 422);
  const ctxM = matterCtxOf(loadMatter(db, run.matter_id));
  const fullGoal = `【事项口径】立场=${ctxM.stance}；法域=${ctxM.jurisdiction}；分析截止日=${ctxM.asOf}\n【任务】${goal}\n【边界】只能使用法律工具；不得编造依据；无法核实的引用如实列出。`;

  const materials = await ctx.step("load_materials", () => stepLoadMaterials(ctx, runId, attemptId));
  // 派生文本快照同样先做全流程化名（规则第一遍；出站闸门逐段复扫兜底，不静默发送明文）
  const snapshot = materials.map((m) => ({ filename: m.filename, text: replaceDirectIdentifiers(m.text.slice(0, 20_000)).text }));

  const identity = { tid: run.tenant_id, uid: run.created_by, mid: run.matter_id, rid: runId, aid: attemptId };
  // A1 恢复粒度为任务级（§6.1 步骤检查点对工作流；宿主任务不可恢复快照）：
  // agent_start/agent_wait 不落检查点——崩溃恢复后重新拉起新宿主整任务重跑
  // （load_materials/settle 检查点保留；事件与成果均幂等，重跑无重复）。
  const taskId = await (async () => {
    assertNotCancelled(db, runId);
    const id = await agentClient.start(identity, { goal: fullGoal, materials: snapshot, timeout_ms: 600_000 });
    appendEvent(ctx.deps, runId, attemptId, 40, "agent.task_started", { agent_task_id: id });
    return id;
  })();

  // 轮询镜像事件（取消传播：发现权威状态为取消 → 立刻取消 agent 任务）
  const outputText = await (async () => {
    let cursor = 0;
    let mirrorSeq = 41;
    for (;;) {
      await new Promise((r) => setTimeout(r, 800));
      const current = getRun(db, runId);
      if (current.status === RunStatus.cancelled) {
        await agentClient.cancel(identity, taskId, "run cancelled");
        throw new RunCancelled();
      }
      const poll = await agentClient.poll(identity, taskId, cursor);
      cursor = poll.next_cursor;
      for (const ev of poll.events) {
        // 只镜像关键事件（引擎细节事件留 agent 宿主，可按需拉取）
        if (["agent.ready", "agent.approval", "agent.done", "agent.error", "agent.timeout"].includes(ev.type) && mirrorSeq < 68) {
          appendEvent(ctx.deps, runId, attemptId, mirrorSeq++, `agent.${ev.type.replace(/^agent\./, "")}`, ev.payload);
        }
      }
      if (poll.status === "succeeded" || poll.status === "failed" || poll.status === "cancelled") {
        appendEvent(ctx.deps, runId, attemptId, 68, "agent.output", {
          status: poll.status,
          output_chars: poll.output_text.length,
          error: poll.error,
        });
        if (poll.status === "failed") throw new DomainError("internal", `Agent 任务失败: ${poll.error ?? "unknown"}`, 502);
        if (poll.status === "cancelled") throw new RunCancelled();
        return poll.output_text;
      }
    }
  })();

  await ctx.step("agent_store_draft", async () => {
    assertNotCancelled(db, runId);
    const output = outputText || "（无文本产出）";
    const stored = ctx.deps.blobs.put(Buffer.from(output, "utf8"), run.matter_id);
    registerArtifact(ctx, run, runId, attemptId, {
      kind: "a1_agent_draft",
      filename: `agent草稿-${runId.slice(-6)}.md`,
      sha256: sha256Hex(output),
      storage_uri: stored.storage_uri,
      manifest: {
        agent_task_id: taskId,
        note: "A1 产物状态只能是草稿（§5 A1）；进入复核流前不得交付",
        budget_cap: 60,
      },
    }, 69);
  });

  await ctx.step("settle", () => stepSettle(ctx, runId, attemptId));
}

async function markTerminal(deps: ExecutorDeps, runId: string, status: "failed" | "cancelled", err: unknown): Promise<void> {
  const db = deps.db;
  try {
    const run = getRun(db, runId);
    if (run.status === RunStatus.succeeded) return;
    // 权威状态可能已被 API 先置为 cancelled：仍须收尾 running 尝试并补终态事件（账本完整，§6.1）；
    // runs 未在目标态则迁移（OR IGNORE 幂等兜底并发），事件 seq 唯一约束保证不重复。
    if (run.status !== status) {
      db.run(`UPDATE runs SET status = ?, status_version = status_version + 1, updated_at = ?, points_reserved = 0 WHERE run_id = ? AND status != 'succeeded'`, [
        status,
        new Date().toISOString(),
        runId,
      ]);
    }
    db.run(`UPDATE attempts SET status = ?, ended_at = ?, error = ? WHERE run_id = ? AND status = 'running'`, [
      status,
      new Date().toISOString(),
      (err as Error)?.message?.slice(0, 500) ?? null,
      runId,
    ]);
    appendEvent(deps, runId, null, 90, status === "failed" ? "run.failed" : "run.cancelled", {
      error: (err as Error)?.message ?? String(err),
      note: "保留已完成且可验证的部分；失败不重复扣点（§2.6）",
    });
  } catch (e) {
    console.error(`[executor] markTerminal failed: ${(e as Error).message}`);
  }
}

/** 注册 legalRun 工作流（场景分发；步骤检查点由本地持久任务队列提供）。 */
export function createLegalWorkflow(deps: ExecutorDeps) {
  return async function legalRun(ctx: WorkflowContext): Promise<void> {
    const c: Ctx = { ...ctx, deps };
    const runId = ctx.runId;
    let attemptId: string | null = null;
    try {
      // start 不检查点（可重入：断电恢复后须重新插入尝试并推进状态）
      const started = await stepStart(c, runId);
      attemptId = started.attemptId;
      const run = getRun(deps.db, runId);
      if (run.scenario === "a1.agent_task") return await runAgentScenario(c, runId, attemptId);
      if (run.scenario === "s1b.draft_compare") return await runS1bScenario(c, runId, attemptId);
      if (run.scenario === "s6.redaction") return await runS6Scenario(c, runId, attemptId);
      if (run.scenario === "s2.case_file") return await runS2Scenario(c, runId, attemptId);
      const materials = await ctx.step("load_materials", () => stepLoadMaterials(c, runId, attemptId!));
      const citations = await ctx.step("verify_citations", () => stepVerifyCitations(c, runId, attemptId!, materials));
      const review = await ctx.step("model_review", () => stepModelReview(c, runId, attemptId!, materials, citations));
      await ctx.step("store_draft", () => stepStoreDraft(c, runId, attemptId!, materials, citations, review));
      await ctx.step("settle", () => stepSettle(c, runId, attemptId!));
    } catch (err) {
      if (err instanceof RunCancelled) {
        await markTerminal(deps, runId, "cancelled", err);
        return;
      }
      await markTerminal(deps, runId, "failed", err);
      throw err; // 让队列记录失败（恢复/对账）
    }
  };
}
