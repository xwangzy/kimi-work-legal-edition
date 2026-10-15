/**
 * 脱敏诊断包（v9.2 §3.6；调研 Y5 §5.3、P1-2；补上界面曾承诺却不存在的“导出诊断信息”）：律师主动导出、交给支持团队。
 *
 * 只含**白名单里的结构化事实**：版本与运行环境、内核状态（队列、闸门传输与计数、OCR 与法规库就绪、控制面模式）、能力账本状态、
 * 近 30 天任务按场景 × 状态的计数与最近 20 个任务的状态与错误代码、出站按去向 × 结果的计数、审计动作计数、表行数。
 * 绝不包含：事项名称、当事人、材料与成果的任何文字、文件名、任务目标、检索式、路径（用户目录换成 ~）。
 *
 * 导出前**自证**：把序列化结果与本机全部事项名称、客户与相对方、当事人词典（含别名）、令牌表原文逐一比对，并用标识符规则
 * （证件、电话、账号等）复扫——任何命中即拒绝导出并报告命中的字段路径（不报告命中的值）。
 * 完整性：内容摘要由本机设备签名密钥签名，支持团队可按设备证书核对未被改动。
 */
import { createHash } from "node:crypto";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { canonicalJson, type DeviceSigner } from "@zr-legal/keys";
import { residualIdentifiers } from "@zr-legal/tokenizer";
import { DomainError, RunStatus } from "@zr-legal/domain";
import type { KernelDb } from "../db.ts";
import type { MatterTokenStore } from "../egress/matter-tokens.ts";
import { readLogs } from "@zr-legal/safe-log";

export interface DiagnosticsDeps {
  db: KernelDb;
  tokens: MatterTokenStore | null;
  tenantId: string;
  deviceId: string;
  /** 设备签名者（对外可验证的低频签名：将来由 TPM 直签，TPM 设计 v1 §4.2）。 */
  signer: DeviceSigner;
  status: () => Promise<any>;
  capabilities: () => Promise<any>;
  /** 统一脱敏日志目录（v9.2 §3.6）：近 7 天事件按登记表重新核验后计入（记录编号已是本机加盐 hash）。 */
  logsDir?: string;
  /** Windows 环境自检（Y5 P1-6；只含枚举与杀软产品名）。 */
  envProbe?: () => Promise<unknown>;
  now?: () => Date;
}

const CODE = /^[a-z][a-z0-9_.:-]{0,59}$/;
const code = (v: unknown): string | null => (typeof v === "string" && CODE.test(v) ? v : null);
/** 版本号只认纯数字点分（复核 B4-R03：带字母的“版本形态”能夹带拼音或英文名称）。 */
const VERSION = /^v?\d+(\.\d+){0,3}$/;
const RUN_STATUSES = new Set<string>(Object.values(RunStatus));
const runStatus = (v: unknown): string | null => (typeof v === "string" && RUN_STATUSES.has(v) ? v : typeof v === "string" ? "other" : null);
const OUTCOMES = new Set(["sent", "blocked", "failed", "mock"]);
const outcome = (v: unknown): string | null => (typeof v === "string" && OUTCOMES.has(v) ? v : typeof v === "string" ? "other" : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const hashId = (id: string) => createHash("sha256").update(id).digest("base64url").slice(0, 12);

/** 只保留形如 状态码/枚举 的字符串值与数字、布尔（用于状态对象的逐层白名单）。 */
function enumsOnly(v: unknown, depth = 0): unknown {
  if (depth > 4) return null;
  if (typeof v === "number" || typeof v === "boolean" || v === null) return v;
  if (typeof v === "string") return CODE.test(v) || VERSION.test(v) ? v : null;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => enumsOnly(x, depth + 1));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (/^[a-z_][a-z0-9_]{0,40}$/.test(k)) out[k] = enumsOnly(x, depth + 1);
    return out;
  }
  return null;
}

function collect(d: DiagnosticsDeps): Record<string, unknown> {
  const since = new Date((d.now?.() ?? new Date()).getTime() - 30 * 24 * 3600_000).toISOString();
  const runsBy = d.db.all<{ scenario: string; status: string; n: number }>(
    `SELECT scenario, status, COUNT(*) AS n FROM runs WHERE tenant_id = ? AND created_at >= ? GROUP BY scenario, status ORDER BY scenario, status`,
    [d.tenantId, since],
  );
  const recent = d.db.all<{ run_id: string; scenario: string; status: string; created_at: string; updated_at: string }>(
    `SELECT run_id, scenario, status, created_at, updated_at FROM runs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 20`,
    [d.tenantId],
  );
  const lastErrors = new Map<string, string | null>();
  for (const r of recent) {
    const ev = d.db.get<{ payload: string }>(`SELECT payload FROM run_events WHERE run_id = ? AND type IN ('agent.error','run.failed') ORDER BY seq DESC LIMIT 1`, [r.run_id]);
    let c: string | null = null;
    try {
      c = code((JSON.parse(ev?.payload ?? "{}") as { code?: unknown }).code);
    } catch {
      c = null;
    }
    lastErrors.set(r.run_id, c);
  }
  const egress = d.db.all<{ destination_kind: string; outcome: string; n: number }>(
    `SELECT destination_kind, outcome, COUNT(*) AS n FROM egress_records WHERE tenant_id = ? AND created_at >= ? GROUP BY destination_kind, outcome`,
    [d.tenantId, since],
  );
  const audits = d.db.all<{ action: string; n: number }>(`SELECT action, COUNT(*) AS n FROM audit_events WHERE tenant_id = ? AND created_at >= ? GROUP BY action ORDER BY action`, [d.tenantId, since]);
  const tables = ["matters", "document_versions", "runs", "run_events", "artifact_versions", "egress_records", "audit_events", "risk_cards", "matter_facts"];
  const counts: Record<string, number | null> = {};
  for (const t of tables) {
    try {
      counts[t] = d.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`, [])?.n ?? null;
    } catch {
      counts[t] = null;
    }
  }
  const migrations = d.db.all<{ name: string }>(`SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1`, []);
  return {
    environment: {
      platform: platform(),
      os_release: release(),
      arch: arch(),
      cpus: cpus().length,
      memory_gb: Math.round(totalmem() / 1024 ** 3),
      node: process.versions.node,
      electron: process.versions.electron ?? null,
    },
    schema: { latest_migration: (migrations[0]?.name ?? "").replace(/\.sql$/, "") || null },
    runs_30d: runsBy.map((r) => ({ scenario: code(r.scenario), status: runStatus(r.status), n: r.n })),
    recent_runs: recent.map((r) => ({
      run: hashId(r.run_id),
      scenario: code(r.scenario),
      status: runStatus(r.status),
      created_at: r.created_at,
      duration_s: Math.max(0, Math.round((Date.parse(r.updated_at) - Date.parse(r.created_at)) / 1000)),
      last_error_code: lastErrors.get(r.run_id) ?? null,
    })),
    egress_30d: egress.map((e) => ({ destination: code(e.destination_kind), outcome: outcome(e.outcome), n: e.n })),
    audit_30d: audits.map((a) => ({ action: code(a.action), n: a.n })),
    table_rows: counts,
    logs_7d: d.logsDir ? logsSection(d.logsDir, (d.now?.() ?? new Date()).getTime()) : null,
  };
}

/** 近 7 天日志：按事件码 × 进程 × 级别计数 + 最近 200 条（日志器只写登记的事件码与封闭字段，读回时再核验一次）。 */
function logsSection(dir: string, nowMs: number): Record<string, unknown> {
  const { records, skipped } = readLogs(dir, nowMs - 7 * 24 * 3600_000);
  const counts = new Map<string, { code: string; proc: string; lvl: string; n: number }>();
  for (const r of records) {
    const k = `${r.code}|${r.proc}|${r.lvl}`;
    const c = counts.get(k) ?? { code: r.code, proc: r.proc, lvl: r.lvl, n: 0 };
    c.n++;
    counts.set(k, c);
  }
  return { counts: [...counts.values()].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)), recent: records.slice(-200), skipped_lines: skipped };
}

/** 自证用的统一折叠（复核 B4-R03）：两侧同一套——NFKC、去零宽与格式字符、小写。 */
export function foldForSelfCheck(s: string): string {
  return s.normalize("NFKC").replace(/[\p{Cf}\u034F\uFE00-\uFE0F]/gu, "").toLowerCase();
}

/**
 * 本机全部敏感字符串（事项名称、客户与相对方、当事人与别名、令牌表原文、任务目标、材料与成果文件名），折叠后入表：整串与去空白形态；
 * 人名与机构名（客户、相对方、当事人、令牌表原文）另按拉丁字母词（≥3 个字母，例如 “Zhang Wei v Li” 里的 zhang、wei）入表——
 * 事项名称、任务目标与文件名不拆词（其中的普通英文词会与场景、状态代码重合，误拒导出）。
 */
function sensitiveStrings(d: DiagnosticsDeps): string[] {
  const out = new Set<string>();
  const add = (v: unknown, words = false) => {
    if (typeof v !== "string") return;
    const f = foldForSelfCheck(v).trim();
    if (f.length >= 2) out.add(f);
    const compact = f.replace(/\s+/g, "");
    if (compact.length >= 2) out.add(compact);
    if (words) for (const w of f.match(/[a-z]{3,}/g) ?? []) out.add(w);
  };
  for (const m of d.db.all<{ matter_id: string; title: string; client_name: string | null; counterparty: string | null }>(`SELECT matter_id, title, client_name, counterparty FROM matters WHERE tenant_id = ?`, [d.tenantId])) {
    add(m.title);
    add(m.client_name, true);
    add(m.counterparty, true);
    if (d.tokens) {
      try {
        for (const p of d.tokens.parties(m.matter_id)) {
          add(p.name, true);
          for (const a of p.aliases ?? []) add(a, true);
        }
        for (const t of d.tokens.table(m.matter_id)) add(t.value, true);
      } catch {
        // 已删除的事项没有密钥：其内容行也已清除
      }
    }
  }
  // 任务目标与文件名（复核 B4-R03：此前只靠白名单）
  for (const r of d.db.all<{ input_snapshot: string | null }>(`SELECT input_snapshot FROM runs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 500`, [d.tenantId])) {
    try {
      add((JSON.parse(r.input_snapshot ?? "{}") as { goal?: unknown }).goal);
    } catch {
      // 不可解析的快照跳过
    }
  }
  for (const t of ["document_versions", "artifact_versions"]) {
    try {
      for (const f of d.db.all<{ filename: string }>(`SELECT filename FROM ${t} WHERE tenant_id = ?`, [d.tenantId])) {
        add(f.filename);
        add(f.filename.replace(/\.[A-Za-z0-9]{1,5}$/, ""));
      }
    } catch {
      // 表不存在（旧库）
    }
  }
  // 太泛的拉丁短词（文件扩展名、常见状态词）不作敏感词，避免把枚举误判为泄露
  for (const w of ["pdf", "docx", "doc", "txt", "xlsx", "png", "jpg", "the", "and", "ltd", "inc", "llc", "llp", "corp", "group", "holdings", "company", "law", "firm"]) out.delete(w);
  return [...out];
}

/** 在对象里找出含某个敏感字符串的字段路径（两侧同一套折叠；只报告路径，不报告值）。 */
function pathsContaining(obj: unknown, needles: readonly string[], prefix = "$"): string[] {
  const hit = (s: string) => {
    const f = foldForSelfCheck(s);
    return needles.some((n) => f.includes(n));
  };
  if (typeof obj === "string") return hit(obj) ? [prefix] : [];
  if (Array.isArray(obj)) return obj.flatMap((x, i) => pathsContaining(x, needles, `${prefix}[${i}]`));
  if (obj && typeof obj === "object") return Object.entries(obj).flatMap(([k, x]) => [...(hit(k) ? [`${prefix}.<键>`] : []), ...pathsContaining(x, needles, `${prefix}.${k}`)]);
  return [];
}

export async function buildDiagnostics(d: DiagnosticsDeps): Promise<{ filename: string; data_base64: string; content_sha256: string; summary: { sections: string[]; bytes: number } }> {
  const status = await d.status().catch(() => null);
  const caps = await d.capabilities().catch(() => null);
  const st = status as Record<string, any> | null;
  const content = {
    format: "kwl-diagnostics/1",
    created_at: (d.now?.() ?? new Date()).toISOString(),
    device_id: d.deviceId,
    kernel: st
      ? enumsOnly({
          version: st.version,
          model_provider: st.model_provider,
          endpoints_configured: st.endpoints_configured,
          queue: st.queue,
          local_server: { rejected_path_requests: st.local_server?.rejected_path_requests, rejected_tool_calls: st.local_server?.rejected_tool_calls },
          ocr_available: st.ocr?.available,
          lawdb_package: st.lawdb_package,
          control_plane_mode: st.control_plane?.mode,
          egress_gate: st.egress_gate ? { running: st.egress_gate.running, transport: st.egress_gate.transport, stats: st.egress_gate.stats, unresolved: st.egress_gate.unresolved } : null,
        })
      : null,
    execution_domain_available: caps?.execution_domain?.available ?? null,
    environment_check: d.envProbe ? await d.envProbe().catch(() => null) : null,
    ...collect(d),
  };
  // 路径不会出现：白名单只放行代码、数字点分版本号、数字与布尔（复核 B4-R03：原先对 JSON 文本替换用户目录的做法在 Windows 上不生效，已删除）
  let json = JSON.stringify(content);
  const parsed = JSON.parse(json) as unknown;
  const needles = sensitiveStrings(d);
  const leaks = pathsContaining(parsed, needles);
  const ids = residualIdentifiers(json);
  if (leaks.length > 0 || ids.length > 0) {
    throw new DomainError("conflict", `诊断信息自检未通过，已拒绝导出：${[...leaks.slice(0, 5), ...ids.slice(0, 5).map((h) => `标识符（${h.category}）`)].join("、")}`, 409);
  }
  json = canonicalJson(parsed);
  const contentSha = createHash("sha256").update(json).digest("hex");
  const signature = await d.signer.sign(new TextEncoder().encode(contentSha));
  const doc = { format: "kwl-diagnostics/1", content: parsed, content_sha256: contentSha, signer_device: d.deviceId, signature };
  const out = JSON.stringify(doc, null, 2);
  return {
    filename: `kimi-work-legal-diagnostics-${(d.now?.() ?? new Date()).toISOString().slice(0, 10)}.json`,
    data_base64: Buffer.from(out, "utf8").toString("base64"),
    content_sha256: contentSha,
    summary: { sections: Object.keys(parsed as object), bytes: Buffer.byteLength(out) },
  };
}
