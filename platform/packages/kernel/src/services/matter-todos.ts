/**
 * 事项待办（v9.4 第 20 批；评审 C1 §3.2：事项是大本营，律师打开事项想知道“下一步做什么、卡在哪、谁在等我”）。
 *
 * 两类条目合在一张清单里：
 * - 律师手工添加的待办（matter_todos）：做什么、谁做（我 / 助理 / 同事 / AI）、谁复核、期限；
 * - 从任务与成果实时推出的待办（不落表，状态只有一份）：等你确认的任务、AI 已完成待你复核的草稿、待签发的成果。
 * 首期只在本机（团队事项也不同步待办，偏离 D-117）；文字是律师原文，存在本机加密库里，不发给 AI。
 */
import { DomainError, newId, notFound } from "@zr-legal/domain";
import type { KernelDb } from "../db.ts";

export type AssigneeKind = "me" | "assistant" | "colleague" | "ai";
const KINDS: readonly AssigneeKind[] = ["me", "assistant", "colleague", "ai"];

export interface TodoRow {
  todo_id: string;
  matter_id: string;
  title: string;
  assignee_kind: AssigneeKind;
  assignee_name: string | null;
  reviewer_name: string | null;
  due_date: string | null;
  status: "open" | "done";
  created_at: string;
  done_at: string | null;
  updated_at: string;
}

/** 推出的待办：kind 决定点开去哪里（任务页、复核页）。 */
export interface DerivedTodo {
  kind: "run_waiting" | "drafts_to_review" | "to_sign";
  /** 任务目标前 40 字（没有目标时界面用场景名）、场景、成果文件名：界面据此写一句话。 */
  goal: string;
  scenario: string | null;
  filename: string | null;
  /** 谁做：等你确认、复核、签发都是“我”；草稿由 AI 完成。 */
  done_by_ai: boolean;
  run_id: string | null;
  artifact_version_id: string | null;
  count: number;
  at: string;
}

const text = (v: unknown, max: number, field: string, required = false): string | null => {
  if (v === undefined || v === null || v === "") {
    if (required) throw new DomainError("validation", `需要 ${field}`, 422);
    return null;
  }
  const s = String(v).replace(/\s+/g, " ").trim();
  if (required && !s) throw new DomainError("validation", `需要 ${field}`, 422);
  if (s.length > max) throw new DomainError("validation", `${field} 至多 ${max} 字`, 422);
  return s || null;
};

const dateOf = (v: unknown): string | null => {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v);
  // Date.parse 会把 2 月 30 日滚成 3 月 2 日：按日历逐项核
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const ok = !!m && Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[3]) >= 1 && Number(m[3]) <= new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
  if (!ok) throw new DomainError("validation", "due_date 须为 YYYY-MM-DD", 422);
  return s;
};

const kindOf = (v: unknown): AssigneeKind => {
  const k = (v ?? "me") as AssigneeKind;
  if (!KINDS.includes(k)) throw new DomainError("validation", `assignee_kind 须为 ${KINDS.join("/")}`, 422);
  return k;
};

function out(r: any): TodoRow {
  return {
    todo_id: r.todo_id,
    matter_id: r.matter_id,
    title: r.title,
    assignee_kind: r.assignee_kind,
    assignee_name: r.assignee_name ?? null,
    reviewer_name: r.reviewer_name ?? null,
    due_date: r.due_date ?? null,
    status: r.status,
    created_at: r.created_at,
    done_at: r.done_at ?? null,
    updated_at: r.updated_at,
  };
}

export function createTodo(db: KernelDb, input: { tenant_id: string; matter_id: string; created_by: string; title?: unknown; assignee_kind?: unknown; assignee_name?: unknown; reviewer_name?: unknown; due_date?: unknown }): TodoRow {
  const n = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM matter_todos WHERE matter_id = ? AND status = 'open'`, [input.matter_id])?.n ?? 0;
  if (n >= 200) throw new DomainError("validation", "本事项未完成的待办已有 200 条：先完成或删除一些", 422);
  const now = new Date().toISOString();
  const row = {
    todo_id: newId("todo"),
    title: text(input.title, 120, "title", true)!,
    assignee_kind: kindOf(input.assignee_kind),
    assignee_name: text(input.assignee_name, 20, "assignee_name"),
    reviewer_name: text(input.reviewer_name, 20, "reviewer_name"),
    due_date: dateOf(input.due_date),
  };
  db.run(
    `INSERT INTO matter_todos (todo_id, tenant_id, matter_id, title, assignee_kind, assignee_name, reviewer_name, due_date, status, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?, 'open', ?,?,?)`,
    [row.todo_id, input.tenant_id, input.matter_id, row.title, row.assignee_kind, row.assignee_name, row.reviewer_name, row.due_date, input.created_by, now, now],
  );
  return out(db.get(`SELECT * FROM matter_todos WHERE todo_id = ?`, [row.todo_id]));
}

export function updateTodo(db: KernelDb, matterId: string, userId: string, todoId: string, patch: Record<string, unknown>): TodoRow {
  const cur = db.get<any>(`SELECT * FROM matter_todos WHERE todo_id = ? AND matter_id = ?`, [todoId, matterId]);
  if (!cur) throw notFound("待办不存在");
  const fields: string[] = [];
  const values: unknown[] = [];
  const set = (k: string, v: unknown) => {
    fields.push(`${k} = ?`);
    values.push(v);
  };
  if (patch.title !== undefined) set("title", text(patch.title, 120, "title", true));
  if (patch.assignee_kind !== undefined) set("assignee_kind", kindOf(patch.assignee_kind));
  if (patch.assignee_name !== undefined) set("assignee_name", text(patch.assignee_name, 20, "assignee_name"));
  if (patch.reviewer_name !== undefined) set("reviewer_name", text(patch.reviewer_name, 20, "reviewer_name"));
  if (patch.due_date !== undefined) set("due_date", dateOf(patch.due_date));
  const now = new Date().toISOString();
  if (patch.done !== undefined) {
    if (typeof patch.done !== "boolean") throw new DomainError("validation", "done 须为布尔值", 422);
    set("status", patch.done ? "done" : "open");
    set("done_by", patch.done ? userId : null);
    set("done_at", patch.done ? now : null);
  }
  if (fields.length === 0) return out(cur);
  set("updated_at", now);
  db.run(`UPDATE matter_todos SET ${fields.join(", ")} WHERE todo_id = ?`, [...values, todoId]);
  return out(db.get(`SELECT * FROM matter_todos WHERE todo_id = ?`, [todoId]));
}

export function deleteTodo(db: KernelDb, matterId: string, todoId: string): void {
  const r = db.run(`DELETE FROM matter_todos WHERE todo_id = ? AND matter_id = ?`, [todoId, matterId]);
  if (!r.changes) throw notFound("待办不存在");
}

/** 手工待办：未完成的按期限（没有期限的排后）再按添加先后；已完成的只给最近 20 条。 */
export function listTodos(db: KernelDb, matterId: string): { open: TodoRow[]; done: TodoRow[] } {
  const open = db.all(`SELECT * FROM matter_todos WHERE matter_id = ? AND status = 'open' ORDER BY due_date IS NULL, due_date, created_at`, [matterId]).map(out);
  const done = db.all(`SELECT * FROM matter_todos WHERE matter_id = ? AND status = 'done' ORDER BY done_at DESC LIMIT 20`, [matterId]).map(out);
  return { open, done };
}

const goalOf = (snapshot: string | null): string => {
  try {
    const g = JSON.parse(snapshot ?? "{}")?.goal;
    return typeof g === "string" ? g.replace(/\s+/g, " ").slice(0, 40) : "";
  } catch {
    return "";
  }
};

/**
 * 从任务与成果推出的待办：
 * - 等你确认（waiting_input / waiting_approval）；
 * - AI 已完成、还有草稿没提交复核的任务（每个任务一条，写份数）——“AI 完成的任务自动变成待你复核”；
 * - 已提交复核、等签发的成果（每份一条）。
 */
export function derivedTodos(db: KernelDb, matterId: string): DerivedTodo[] {
  const outList: DerivedTodo[] = [];
  for (const r of db.all<{ run_id: string; scenario: string; input_snapshot: string | null; updated_at: string | null; created_at: string }>(
    `SELECT run_id, scenario, input_snapshot, updated_at, created_at FROM runs WHERE matter_id = ? AND status IN ('waiting_input','waiting_approval') ORDER BY created_at DESC LIMIT 20`,
    [matterId],
  )) {
    outList.push({ kind: "run_waiting", goal: goalOf(r.input_snapshot), scenario: r.scenario, filename: null, done_by_ai: false, run_id: r.run_id, artifact_version_id: null, count: 1, at: r.updated_at ?? r.created_at });
  }
  // 只看每份文件的最新版本（旧版本被取代的不算；按同一份文件，复核 Q7-02）
  const latest = `NOT EXISTS (SELECT 1 FROM artifact_versions b WHERE b.matter_id = a.matter_id AND b.kind = a.kind AND b.audience = a.audience AND b.lineage IS a.lineage AND b.version > a.version)`;
  for (const r of db.all<{ run_id: string; scenario: string; input_snapshot: string | null; n: number; at: string }>(
    `SELECT r.run_id, r.scenario, r.input_snapshot, COUNT(*) AS n, MAX(a.created_at) AS at
       FROM artifact_versions a JOIN runs r ON r.run_id = a.run_id
      WHERE a.matter_id = ? AND a.status = 'draft' AND r.status IN ('succeeded','partial') AND ${latest}
      GROUP BY r.run_id ORDER BY at DESC LIMIT 20`,
    [matterId],
  )) {
    outList.push({ kind: "drafts_to_review", goal: goalOf(r.input_snapshot), scenario: r.scenario, filename: null, done_by_ai: true, run_id: r.run_id, artifact_version_id: null, count: r.n, at: r.at });
  }
  for (const a of db.all<{ artifact_version_id: string; filename: string; created_at: string }>(
    `SELECT a.artifact_version_id, a.filename, a.created_at FROM artifact_versions a WHERE a.matter_id = ? AND a.status = 'pending_review' AND ${latest} ORDER BY a.created_at DESC LIMIT 20`,
    [matterId],
  )) {
    outList.push({ kind: "to_sign", goal: "", scenario: null, filename: a.filename, done_by_ai: false, run_id: null, artifact_version_id: a.artifact_version_id, count: 1, at: a.created_at });
  }
  return outList;
}
