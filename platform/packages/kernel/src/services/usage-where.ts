/**
 * 第 70 批（V44）：“设置 · 套餐与用量”的最近记录——每一行用在哪件事项的哪个任务（只在本机显示，事项名不上云）。
 *
 * 云端账本只有元数据：时刻、问答或任务、模型、token、计入多少，不知道事项名（也不该知道）。出站闸门给每次模型请求生成的编号（kwlg_…）
 * 会随请求头交给法律网关、记进云端账本的 client_request_id，同一个编号也写在本机去向记录（egress_records.request_id）上，那里有事项与运行。
 *
 * 对回顺序：
 *   1. 按编号（云端 1.5.1 起明细带 client_request_id）：精确；
 *   2. 云端没有带编号（1.5.0 及更早）：按“同一类（任务 / 问答）+ 读入与写出 token 数都相同 + 本机记录在这一行之前 45 分钟内开始”找本机的去向记录，
 *      取时间最近的一条，每条本机记录只对一行。token 数来自同一份上游用量（闸门读响应尾部、网关读同一个流），两个数都相同时几乎不会认错；
 *      没有真实用量的行（估算、中途中断）不猜。
 *   3. 云端标明不是本机发出的（this_device = false）：不在本机找，界面写“在另一台电脑上”。
 *
 * 只给本人能看的：任务所在事项须本人是成员且没有删除；问答须是本人的会话。其余对不上的返回 null（界面照旧只写“任务 / 问答”）。
 */
import type { KernelDb } from "../db.ts";

export interface UsageWhereRow {
  at: string;
  kind: "qa" | "task";
  client_request_id?: string | null;
  this_device?: boolean;
  tokens_in?: number;
  tokens_out?: number;
  estimated?: boolean;
  partial?: boolean;
}

export interface UsageWhere {
  /** 任务名（卡片名，例如“起草起诉状”；自由描述的任务取说明开头）或“问答”。 */
  task: string;
  /** 事项名（任务）或会话标题（问答）；对不上事项时为 null。 */
  matter: string | null;
  /** 问答：会话的第一问全文（空白合并，至多 200 字）——会话标题只存了前 24 字，界面按显示宽度截断、悬停给这句全称（第 71 批 D11）。 */
  matter_full?: string | null;
  matter_id: string | null;
  run_id: string | null;
  conversation_id: string | null;
  /** id = 按编号精确对上；match = 旧云端按 token 数与时刻对上。 */
  how: "id" | "match";
}

export type UsageWhereResult = UsageWhere | { elsewhere: true } | null;

const ID_RE = /^kwlg_[A-Za-z0-9-]{8,64}$/;
const WINDOW_BEFORE_MS = 45 * 60_000;
const WINDOW_AFTER_MS = 2 * 60_000;

type EgressHit = { request_id: string | null; matter_id: string; run_id: string | null; created_at: string; note: string | null };

function noteOf(raw: string | null): { purpose?: string; usage?: { input?: number; output?: number } } {
  try {
    const v = JSON.parse(raw ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** 自由描述的任务没有卡片名：取说明开头 14 个字。 */
function goalShort(goal: unknown): string | null {
  const g = String(goal ?? "").replace(/\s+/g, " ").trim();
  if (!g) return null;
  const chars = [...g];
  return chars.length > 14 ? `${chars.slice(0, 14).join("")}…` : g;
}

export function usageWhereOf(db: KernelDb, me: { tenantId: string; userId: string }, rows: readonly UsageWhereRow[]): UsageWhereResult[] {
  const out: UsageWhereResult[] = rows.map(() => null);
  if (rows.length === 0) return out;
  const hitOf = new Map<number, EgressHit>();

  // 1. 按编号
  const ids = [...new Set(rows.map((r) => r.client_request_id).filter((x): x is string => typeof x === "string" && ID_RE.test(x)))];
  const byId = new Map<string, EgressHit>();
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200);
    for (const h of db.all<EgressHit>(
      `SELECT request_id, matter_id, run_id, created_at, note FROM egress_records WHERE tenant_id = ? AND destination_kind = 'legal_gateway' AND request_id IN (${part.map(() => "?").join(",")})`,
      [me.tenantId, ...part],
    ))
      if (h.request_id && !byId.has(h.request_id)) byId.set(h.request_id, h);
  }
  rows.forEach((r, i) => {
    const h = typeof r.client_request_id === "string" ? byId.get(r.client_request_id) : undefined;
    if (h) hitOf.set(i, h);
  });

  // 2. 云端没带编号：按 token 数与时刻对（只对有真实用量、没标明别处发出的行）
  const guess = rows
    .map((r, i) => ({ r, i, t: Date.parse(r.at) }))
    .filter(({ r, i, t }) => !hitOf.has(i) && (r.client_request_id === undefined || r.client_request_id === null) && r.this_device !== false && !r.estimated && !r.partial && Number.isFinite(t) && (r.tokens_in ?? 0) > 0);
  if (guess.length > 0) {
    const from = new Date(Math.min(...guess.map((g) => g.t)) - WINDOW_BEFORE_MS).toISOString();
    const to = new Date(Math.max(...guess.map((g) => g.t)) + WINDOW_AFTER_MS).toISOString();
    const pool = db
      .all<EgressHit>(
        `SELECT request_id, matter_id, run_id, created_at, note FROM egress_records
          WHERE tenant_id = ? AND destination_kind = 'legal_gateway' AND outcome = 'sent' AND created_at >= ? AND created_at <= ?
          ORDER BY created_at DESC LIMIT 5000`,
        [me.tenantId, from, to],
      )
      .map((h) => ({ h, n: noteOf(h.note), t: Date.parse(h.created_at) }))
      .filter((x) => typeof x.n.usage?.input === "number" && Number.isFinite(x.t));
    const used = new Set<EgressHit>();
    for (const g of guess) {
      const qa = g.r.kind === "qa";
      let best: { h: EgressHit; d: number } | null = null;
      for (const x of pool) {
        if (used.has(x.h) || (x.n.purpose === "qa") !== qa) continue;
        if (x.n.usage!.input !== g.r.tokens_in || (x.n.usage!.output ?? 0) !== (g.r.tokens_out ?? 0)) continue;
        const d = g.t - x.t;
        if (d < -WINDOW_AFTER_MS || d > WINDOW_BEFORE_MS) continue;
        if (!best || Math.abs(d) < Math.abs(best.d)) best = { h: x.h, d };
      }
      if (best) {
        used.add(best.h);
        hitOf.set(g.i, best.h);
      }
    }
  }

  // 3. 换成任务名与事项名（只给本人能看的）
  const runIds = [...new Set([...hitOf.values()].map((h) => h.run_id).filter((x): x is string => !!x))];
  const runs = new Map<string, { matter_id: string; matter_title: string; input_snapshot: string | null }>();
  for (let i = 0; i < runIds.length; i += 200) {
    const part = runIds.slice(i, i + 200);
    for (const r of db.all<{ run_id: string; matter_id: string; matter_title: string; input_snapshot: string | null }>(
      `SELECT r.run_id, r.matter_id, m.title AS matter_title, r.input_snapshot FROM runs r JOIN matters m ON m.matter_id = r.matter_id
         JOIN matter_members mm ON mm.matter_id = r.matter_id AND mm.user_id = ? AND mm.removed_at IS NULL
        WHERE r.tenant_id = ? AND m.lifecycle <> 'purged' AND r.run_id IN (${part.map(() => "?").join(",")})`,
      [me.userId, me.tenantId, ...part],
    ))
      runs.set(r.run_id, r);
  }
  const convs = new Map<string, string>();
  const firstAsk = new Map<string, string>();
  for (let i = 0; i < runIds.length; i += 200) {
    const part = runIds.slice(i, i + 200);
    for (const c of db.all<{ conversation_id: string; title: string; first_q: string | null }>(
      `SELECT c.conversation_id, c.title,
              (SELECT m.text FROM qa_messages m WHERE m.conversation_id = c.conversation_id AND m.role = 'user' ORDER BY m.seq LIMIT 1) AS first_q
         FROM qa_conversations c WHERE c.tenant_id = ? AND c.user_id = ? AND c.conversation_id IN (${part.map(() => "?").join(",")})`,
      [me.tenantId, me.userId, ...part],
    )) {
      convs.set(c.conversation_id, c.title);
      if (c.first_q) firstAsk.set(c.conversation_id, c.first_q);
    }
  }

  rows.forEach((r, i) => {
    if (r.this_device === false && !hitOf.has(i)) {
      out[i] = { elsewhere: true };
      return;
    }
    const h = hitOf.get(i);
    if (!h || !h.run_id) return;
    const how = typeof r.client_request_id === "string" && byId.get(r.client_request_id) === h ? "id" : "match";
    if (r.kind === "qa") {
      if (!convs.has(h.run_id)) return;
      const t = String(convs.get(h.run_id) ?? "").replace(/\s+/g, " ").trim();
      // 标题是第一问的前 24 字（同一份令牌形态）：第一问以标题开头时给全称，改过标题的不给
      const q = String(firstAsk.get(h.run_id) ?? "").replace(/\s+/g, " ").trim();
      const full = t && q.startsWith(t) ? q.slice(0, 200) : null;
      out[i] = { task: "问答", matter: t || null, ...(full && full !== t ? { matter_full: full } : {}), matter_id: null, run_id: null, conversation_id: h.run_id, how };
      return;
    }
    const run = runs.get(h.run_id);
    if (!run) return;
    let snap: { title?: unknown; goal?: unknown } = {};
    try {
      snap = JSON.parse(run.input_snapshot ?? "{}") ?? {};
    } catch {
      snap = {};
    }
    const task = typeof snap.title === "string" && snap.title.trim() ? snap.title.trim() : (goalShort(snap.goal) ?? "任务");
    out[i] = { task, matter: run.matter_title || null, matter_id: run.matter_id, run_id: h.run_id, conversation_id: null, how };
  });
  return out;
}

/** 给一组明细行加上 where（不改原数组；对不上的行不加这个字段）。 */
export function withUsageWhere<T extends UsageWhereRow>(db: KernelDb, me: { tenantId: string; userId: string }, rows: readonly T[] | undefined): (T & { where?: Exclude<UsageWhereResult, null> })[] | undefined {
  if (!Array.isArray(rows)) return rows as undefined;
  let where: UsageWhereResult[];
  try {
    where = usageWhereOf(db, me, rows);
  } catch {
    // 本机对不上不影响用量页：照旧只写“任务 / 问答”
    return rows.map((r) => ({ ...r }));
  }
  return rows.map((r, i) => (where[i] ? { ...r, where: where[i]! } : { ...r }));
}
