/**
 * 成果里的事实角标（v9.4 第 21 批 C-03 残余；评审 C1 §4.3“事实引用也要同样可回溯”）：
 * 文书里写到的事实（“2026 年 3 月 1 日买方签收”）按日期对到本事项的事实行——对上律师已确认的事实，角标显示“已确认事实”；
 * 只对上 AI 提交、律师还没确认的，显示“未经确认”。悬停看事实原句、出处文件与原文。把“只有确认过的事实进文书”这条规则显示出来。
 *
 * 只按完整日期（YYYY-MM-DD）对：日期是事实行里最稳定的锚，金额与主体写法太多、容易误配；对不上的不标（不是“没有依据”的结论）。
 * 已驳回的事实行不参与。纯读，不存结论（事实状态变了角标跟着变）。
 */
import type { KernelDb } from "../db.ts";

export interface FactMark {
  /** 成果里的日期原文（第 nth 次出现）。 */
  raw: string;
  nth: number;
  status: "confirmed" | "proposed";
  /** 同一日期对上的事实行（确认的在前，至多 3 条）。 */
  facts: { fact_id: string; statement: string; status: "confirmed" | "proposed"; filename: string | null; quote: string | null }[];
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 一个日期在中文文书里的常见写法（按长度从长到短，避免短写法先命中长写法的一部分）。 */
export function dateForms(day: string): string[] {
  const m = DAY.exec(day);
  if (!m) return [];
  const [, y, mo, d] = m as unknown as [string, string, string, string];
  const mi = String(Number(mo));
  const di = String(Number(d));
  return [...new Set([`${y} 年 ${mo} 月 ${d} 日`, `${y} 年 ${mi} 月 ${di} 日`, `${y}年${mo}月${d}日`, `${y}年${mi}月${di}日`, `${y}-${mo}-${d}`, `${y}.${mi}.${di}`])].sort((a, b) => b.length - a.length);
}

export function artifactFactMarks(db: KernelDb, matterId: string, text: string): FactMark[] {
  const rows = db.all<{ fact_id: string; statement: string; status: string; occurred_on: string | null; quote: string | null; filename: string | null }>(
    `SELECT f.fact_id, f.statement, f.status, f.occurred_on, f.quote, d.filename
       FROM matter_facts f LEFT JOIN document_versions d ON d.document_version_id = f.document_version_id
      WHERE f.matter_id = ? AND f.status IN ('confirmed','proposed') AND f.occurred_on IS NOT NULL
      ORDER BY CASE f.status WHEN 'confirmed' THEN 0 ELSE 1 END, f.seq`,
    [matterId],
  );
  const byDay = new Map<string, typeof rows>();
  for (const r of rows) if (r.occurred_on && DAY.test(r.occurred_on)) byDay.set(r.occurred_on, [...(byDay.get(r.occurred_on) ?? []), r]);
  if (byDay.size === 0 || !text) return [];
  // 编号与界面一致（复核 Q3-04）：界面（apps/desktop/src/lib/cite-scan.ts scanMarks）按“最早出现、同位置最长写法优先、从左到右不重叠”
  // 逐处数第几次出现——这里用同一规则扫全文；前后紧挨数字的（“2026.3.15”里的“2026.3.1”）照样计数，只是不加角标
  const raws = [...new Set([...byDay.keys()].flatMap((day) => dateForms(day)))].sort((a, b) => b.length - a.length);
  const dayOf = new Map([...byDay.keys()].flatMap((day) => dateForms(day).map((f) => [f, day] as const)));
  const seen = new Map<string, number>();
  const out: FactMark[] = [];
  let from = 0;
  for (;;) {
    let at = -1;
    let hit = "";
    for (const r of raws) {
      const i = text.indexOf(r, from);
      if (i >= 0 && (at < 0 || i < at)) [at, hit] = [i, r];
    }
    if (at < 0) break;
    const end = at + hit.length;
    const nth = (seen.get(hit) ?? 0) + 1;
    seen.set(hit, nth);
    from = end;
    if (/\d/.test(text[at - 1] ?? "") || /\d/.test(text[end] ?? "")) continue;
    const facts = byDay.get(dayOf.get(hit)!)!;
    out.push({
      raw: hit,
      nth,
      status: facts.some((f) => f.status === "confirmed") ? "confirmed" : "proposed",
      facts: facts.slice(0, 3).map((f) => ({ fact_id: f.fact_id, statement: f.statement, status: f.status as "confirmed" | "proposed", filename: f.filename, quote: f.quote })),
    });
  }
  return out.slice(0, 500);
}
