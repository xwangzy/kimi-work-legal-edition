/**
 * 本事项的审查要点（v9.4 第 22 批；评审 C1 §1 #21“事项绑定审查规则”、#22“从范本生成审查规则”，借鉴 Harvey 事项绑定 Playbook、LegalOn Playbook Agent）。
 *
 * - 律师逐条写（或改 AI 起草的草稿后启用）：条款、我方标准、可退让、不可谈。每次保存是新的一版，旧版留作历史；
 * - 审合同、回稿重审、起草合同的任务在发起时把在用的那一版快照进任务输入（runs.start），Agent 按它判“偏离规则”——
 *   卡片 rule_ref 写“要点 n”，内核核对 n 在这一版里（riskcards.submit），工作台按快照显示那条要点的原文；之后改要点不影响已发起的任务；
 * - AI 从范本起草（rules.propose）只存为草稿：草稿不能用于审查，律师审定启用后才编号（评审 C1 #22“未审定不得用于正式审查”）。
 *
 * 只在本机、只属于这个事项（不随团队共享同步，同 D-117）；本所统一下发的规则仍待覆盖层分发拍板（D-118）。
 * 文字按原样保存：律师写的为原文，AI 草稿为令牌形态；发给 AI 时随整段提示词令牌化。
 */
import { createHash } from "node:crypto";
import { DomainError, newId, notFound } from "@zr-legal/domain";
import type { KernelDb } from "../db.ts";

export const RULES_LIMITS = { rules: 40, title: 40, topic: 40, field: 300, drafts: 5 } as const;

/** 用审查要点的方法：审合同、回稿重审、起草合同。 */
export const RULES_SKILLS: readonly string[] = ["contract-review", "redraft-review", "contract-draft"];

export interface ReviewRule {
  /** 要点编号（从 1 起，按顺序）。 */
  no: number;
  /** 条款或问题（如“付款”“违约金”）。 */
  topic: string;
  /** 我方标准。 */
  standard: string;
  /** 可退让到哪里（可空）。 */
  fallback: string | null;
  /** 不可谈 / 底线（可空）。 */
  red_line: string | null;
}

export interface RuleSetView {
  rule_set_id: string;
  version: number | null;
  title: string;
  rules: ReviewRule[];
  status: "active" | "superseded" | "retired" | "draft";
  source: "lawyer" | "ai_draft";
  run_id: string | null;
  sha256: string;
  created_at: string;
}

/** 快照进任务输入的那一版。 */
export interface RulesSnapshot {
  rule_set_id: string;
  version: number;
  title: string;
  sha256: string;
  rules: ReviewRule[];
}

const clean = (v: unknown, max: number, field: string, required: boolean): string | null => {
  if (v === undefined || v === null) {
    if (required) throw new DomainError("validation", `${field}不能为空`, 422);
    return null;
  }
  if (typeof v !== "string") throw new DomainError("validation", `${field}须为文字`, 422);
  const s = v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").replace(/[ \t]+/g, " ").trim();
  if (required && !s) throw new DomainError("validation", `${field}不能为空`, 422);
  if ([...s].length > max) throw new DomainError("validation", `${field}至多 ${max} 字`, 422);
  return s || null;
};

/** 校验并重新编号（编号按顺序，不接受外部给的编号）。 */
export function normalizeRules(input: { title?: unknown; rules?: unknown }): { title: string; rules: ReviewRule[] } {
  const title = clean(input.title, RULES_LIMITS.title, "审查要点的名称", true)!;
  if (!Array.isArray(input.rules) || input.rules.length === 0) throw new DomainError("validation", "至少写一条审查要点", 422);
  if (input.rules.length > RULES_LIMITS.rules) throw new DomainError("validation", `审查要点至多 ${RULES_LIMITS.rules} 条`, 422);
  const rules = input.rules.map((r: any, i: number) => {
    if (!r || typeof r !== "object" || Array.isArray(r)) throw new DomainError("validation", `第 ${i + 1} 条格式不对`, 422);
    return {
      no: i + 1,
      topic: clean(r.topic, RULES_LIMITS.topic, `第 ${i + 1} 条的条款`, true)!,
      standard: clean(r.standard, RULES_LIMITS.field, `第 ${i + 1} 条的我方标准`, true)!,
      fallback: clean(r.fallback, RULES_LIMITS.field, `第 ${i + 1} 条的可退让`, false),
      red_line: clean(r.red_line, RULES_LIMITS.field, `第 ${i + 1} 条的不可谈`, false),
    };
  });
  return { title, rules };
}

const shaOf = (title: string, rules: ReviewRule[]) => createHash("sha256").update(JSON.stringify({ title, rules })).digest("hex");

function viewOf(r: any): RuleSetView {
  let rules: ReviewRule[] = [];
  try {
    rules = JSON.parse(r.rules) as ReviewRule[];
  } catch {
    rules = [];
  }
  return { rule_set_id: r.rule_set_id, version: r.version ?? null, title: r.title, rules, status: r.status, source: r.source, run_id: r.run_id ?? null, sha256: r.sha256, created_at: r.created_at };
}

export function activeRules(db: KernelDb, matterId: string): RuleSetView | null {
  const r = db.get(`SELECT * FROM matter_review_rules WHERE matter_id = ? AND status = 'active' LIMIT 1`, [matterId]);
  return r ? viewOf(r) : null;
}

/** 在用的一版、AI 草稿（新的在前）、历史版本（至多 10 版）。 */
export function listRuleSets(db: KernelDb, matterId: string): { active: RuleSetView | null; drafts: RuleSetView[]; history: RuleSetView[] } {
  return {
    active: activeRules(db, matterId),
    drafts: db.all(`SELECT * FROM matter_review_rules WHERE matter_id = ? AND status = 'draft' ORDER BY created_at DESC, rowid DESC`, [matterId]).map(viewOf),
    history: db.all(`SELECT * FROM matter_review_rules WHERE matter_id = ? AND status IN ('superseded','retired') ORDER BY version DESC LIMIT 10`, [matterId]).map(viewOf),
  };
}

/**
 * 律师保存（新写、修改在用的一版、或审定启用一份草稿）：编号为下一版并设为在用，原来在用的改为被取代；
 * from_draft 给出时那份草稿随之删除（内容已进新版）。须在调用方的事务里执行。
 */
export function saveRules(db: KernelDb, scope: { tenantId: string; matterId: string; userId: string }, input: { title?: unknown; rules?: unknown; from_draft?: unknown; base_version?: unknown }): RuleSetView {
  const { title, rules } = normalizeRules(input);
  const cur = activeRules(db, scope.matterId);
  // 并发保护：界面带着它看到的版本号来；别人（或另一个窗口）已经存了新版时拒绝，免得静默覆盖
  if (input.base_version !== undefined && (input.base_version ?? null) !== (cur?.version ?? null)) {
    throw new DomainError("conflict", `审查要点已经有了第 ${cur?.version ?? "?"} 版：请刷新后再改`, 409);
  }
  if (input.from_draft !== undefined && input.from_draft !== null) {
    const d = db.get<{ status: string }>(`SELECT status FROM matter_review_rules WHERE rule_set_id = ? AND matter_id = ?`, [String(input.from_draft), scope.matterId]);
    if (!d || d.status !== "draft") throw notFound("这份草稿已不在（可能已启用或删除）");
    db.run(`DELETE FROM matter_review_rules WHERE rule_set_id = ?`, [String(input.from_draft)]);
  }
  const sha = shaOf(title, rules);
  if (cur && cur.sha256 === sha) return cur;
  const next = (db.get<{ v: number | null }>(`SELECT MAX(version) AS v FROM matter_review_rules WHERE matter_id = ?`, [scope.matterId])?.v ?? 0) + 1;
  if (cur) db.run(`UPDATE matter_review_rules SET status = 'superseded' WHERE rule_set_id = ?`, [cur.rule_set_id]);
  const id = newId("reviewRules");
  db.run(
    `INSERT INTO matter_review_rules (rule_set_id, tenant_id, matter_id, version, title, rules, sha256, status, source, run_id, created_by, created_at)
     VALUES (?,?,?,?,?,?,?, 'active', 'lawyer', NULL, ?, ?)`,
    [id, scope.tenantId, scope.matterId, next, title, JSON.stringify(rules), sha, scope.userId, new Date().toISOString()],
  );
  return viewOf(db.get(`SELECT * FROM matter_review_rules WHERE rule_set_id = ?`, [id]));
}

/** 停用：之后发起的任务不再按要点审；历史版本保留。 */
export function retireRules(db: KernelDb, matterId: string): { retired: boolean } {
  const cur = activeRules(db, matterId);
  if (!cur) return { retired: false };
  db.run(`UPDATE matter_review_rules SET status = 'retired' WHERE rule_set_id = ?`, [cur.rule_set_id]);
  return { retired: true };
}

export function discardDraft(db: KernelDb, matterId: string, ruleSetId: string): { deleted: boolean } {
  const d = db.get<{ status: string }>(`SELECT status FROM matter_review_rules WHERE rule_set_id = ? AND matter_id = ?`, [ruleSetId, matterId]);
  if (!d || d.status !== "draft") throw notFound("草稿不存在");
  db.run(`DELETE FROM matter_review_rules WHERE rule_set_id = ?`, [ruleSetId]);
  return { deleted: true };
}

/**
 * AI 从范本起草（法律工具 rules.propose）：只存为草稿，同一任务再次提交取代本任务上一份草稿；事项里至多留 5 份草稿。
 * 文字为 Agent 提交时的令牌形态。
 */
export function proposeDraft(db: KernelDb, scope: { tenantId: string; matterId: string; runId: string | null }, input: { title?: unknown; rules?: unknown }): { rule_set_id: string; rules: number; note: string } {
  if (!scope.runId) throw new DomainError("forbidden", "只有任务内的调用可以起草审查要点", 403);
  const { title, rules } = normalizeRules(input);
  const id = newId("reviewRules");
  db.tx(() => {
    db.run(`DELETE FROM matter_review_rules WHERE matter_id = ? AND status = 'draft' AND run_id = ?`, [scope.matterId, scope.runId]);
    const n = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM matter_review_rules WHERE matter_id = ? AND status = 'draft'`, [scope.matterId])?.n ?? 0;
    if (n >= RULES_LIMITS.drafts) throw new DomainError("conflict", `这个事项已有 ${n} 份没处理的审查要点草稿：请律师先启用或删除`, 409);
    db.run(
      `INSERT INTO matter_review_rules (rule_set_id, tenant_id, matter_id, version, title, rules, sha256, status, source, run_id, created_by, created_at)
       VALUES (?,?,?, NULL, ?,?,?, 'draft', 'ai_draft', ?, 'agent', ?)`,
      [id, scope.tenantId, scope.matterId, title, JSON.stringify(rules), shaOf(title, rules), scope.runId, new Date().toISOString()],
    );
  });
  return { rule_set_id: id, rules: rules.length, note: "已存为草稿：律师在事项概览“审查要点”里审定、启用后才用于审查；在此之前不要按它审合同" };
}

export function snapshotOf(v: RuleSetView): RulesSnapshot {
  return { rule_set_id: v.rule_set_id, version: v.version!, title: v.title, sha256: v.sha256, rules: v.rules.map((r) => ({ ...r })) };
}

/** 发给 Agent 的一段（随整段提示词令牌化）。 */
export function rulesPromptBlock(s: RulesSnapshot): string {
  const lines = s.rules.map((r) => `${r.no}. ${r.topic}：我方标准：${r.standard}${r.fallback ? `；可退让：${r.fallback}` : ""}${r.red_line ? `；不可谈：${r.red_line}` : ""}`);
  return `【本事项审查要点 第 ${s.version} 版「${s.title}」（律师设定，共 ${s.rules.length} 条）】合同与某条要点不符的，提交“偏离规则”卡：rule_source=firm_rule，rule_ref 写“要点 n：条款”（n 为下面的编号）；要点没写到的问题照常按方法判断，不要写成偏离要点。\n${lines.join("\n")}\n`;
}

/** rule_ref 里写的要点编号（“要点 3”“要点3：付款”）；没写返回 null。 */
export function ruleNoOf(ref: string | null | undefined): number | null {
  const m = /要点\s*(\d{1,3})/.exec(ref ?? "");
  return m ? Number(m[1]) : null;
}

/** 任务快照里的审查要点（没有或格式不对返回 null）。 */
export function runRulesSnapshot(db: KernelDb, runId: string | null): RulesSnapshot | null {
  if (!runId) return null;
  const raw = db.get<{ input_snapshot: string | null }>(`SELECT input_snapshot FROM runs WHERE run_id = ?`, [runId])?.input_snapshot;
  try {
    const s = JSON.parse(raw ?? "{}")?.review_rules;
    return s && typeof s === "object" && Array.isArray(s.rules) && typeof s.version === "number" ? (s as RulesSnapshot) : null;
  } catch {
    return null;
  }
}
