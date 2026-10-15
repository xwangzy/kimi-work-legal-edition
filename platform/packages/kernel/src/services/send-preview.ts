/**
 * 发送前“将发送什么”与发送视图（v9.2 §3.3–3.4；调研 Y5 §3.3、§4.3 ②③；Y4 §3.3、#15；P1-10、P1-11 ③）。
 *
 * - 发起前计数：对任务将用到的材料与任务说明，用与出站闸门同一套事项令牌化器离线预跑（不出站、不写回令牌表），
 *   给出按类别的替换次数、机构名称是否保留、疑似未替换的姓名（规则候选器二次检测）。
 * - 发送视图：某份材料令牌化之后的前若干字（即模型会看到的样子），代号与疑似姓名的位置；**不返回代号的真值**——
 *   界面悬停时经受审计、限量的还原接口逐个还原。
 * - 疑似姓名核对（L3a 必须、L2 可选）：律师逐个判定“是姓名 → 加入当事人名单”或“不是姓名 → 本事项记住、不再提示”；
 *   L3a 事项在核对完之前不能发起（内核在估价与发起两处判定）。
 */
import { createHash } from "node:crypto";
import { suspectedNames, type SuspectedName, type TokenCategory } from "@zr-legal/tokenizer";
import type { KernelDb } from "../db.ts";
import type { MatterTokenStore } from "../egress/matter-tokens.ts";

export const PREVIEW_CHARS = 4000;
/** L2 计数时每份材料最多预跑的字数（超过的部分按“约”计）。 */
const SUMMARY_CHARS_PER_DOC = 400_000;
/**
 * L3a 核对必须覆盖实际发送的全部内容（复核 S5A-02）：A1 材料快照单份上限 200 万字（executor AGENT_SNAPSHOT_MAX_CHARS），
 * 超出部分不发送；核对按同一上限全文扫描。
 */
export const FULL_SCAN_CHARS_PER_DOC = 2_000_000;

export interface SendSummary {
  docs: number;
  chars: number;
  /** 按类别的替换次数（代号类别：person/id_number/phone/…）。 */
  replaced: Partial<Record<TokenCategory, number>>;
  replaced_total: number;
  orgs_kept: boolean;
  suspects: { high: number; medium: number; unreviewed: number };
  truncated: boolean;
}

export interface SuspectView {
  value: string;
  confidence: SuspectedName["confidence"];
  cue: SuspectedName["cue"];
  /** 出现处的前后文（发送稿形态：其他代号保持代号）。 */
  context: string;
  occurrences: number;
}

function docTexts(db: KernelDb, matterId: string, docIds: readonly string[]): { id: string; filename: string; text: string }[] {
  const out: { id: string; filename: string; text: string }[] = [];
  for (const id of docIds) {
    const r = db.get<{ filename: string; content: string }>(
      `SELECT dv.filename, pt.content FROM document_versions dv
         JOIN parse_versions pv ON pv.document_version_id = dv.document_version_id
         JOIN parse_texts pt ON pt.parse_version_id = pv.parse_version_id
        WHERE dv.document_version_id = ? AND dv.matter_id = ? AND dv.quarantined_at IS NULL
        ORDER BY pv.created_at DESC LIMIT 1`,
      [id, matterId],
    );
    if (r) out.push({ id, filename: r.filename, text: String(r.content ?? "") });
  }
  return out;
}

export function dismissedSuspects(db: KernelDb, matterId: string): Set<string> {
  return new Set(db.all<{ value: string }>(`SELECT value FROM matter_suspect_reviews WHERE matter_id = ? AND decision = 'not_name'`, [matterId]).map((r) => r.value));
}

/** 对令牌化后的文本做二次检测，去掉律师已判“不是姓名”的值，按值合并。 */
function collectSuspects(sentTexts: readonly string[], dismissed: ReadonlySet<string>): SuspectView[] {
  const byValue = new Map<string, SuspectView>();
  for (const t of sentTexts) {
    for (const s of suspectedNames(t)) {
      if (dismissed.has(s.value)) continue;
      const cur = byValue.get(s.value);
      if (cur) {
        cur.occurrences++;
        if (s.confidence === "high") cur.confidence = "high";
        continue;
      }
      const from = Math.max(0, s.index - 24);
      const to = Math.min(t.length, s.index + s.value.length + 24);
      byValue.set(s.value, { value: s.value, confidence: s.confidence, cue: s.cue, context: t.slice(from, to).replace(/\s+/g, " "), occurrences: 1 });
    }
  }
  return [...byValue.values()].sort((a, b) => (a.confidence === b.confidence ? b.occurrences - a.occurrences : a.confidence === "high" ? -1 : 1));
}

export function summarizeSend(
  db: KernelDb,
  tokens: MatterTokenStore,
  matterId: string,
  docIds: readonly string[],
  goal: string,
  fullPseudonym: boolean,
  o: { fullScan?: boolean; extraTexts?: readonly string[] } = {},
): { summary: SendSummary; suspects: SuspectView[] } {
  const docs = docTexts(db, matterId, docIds);
  const cap = o.fullScan ? FULL_SCAN_CHARS_PER_DOC : SUMMARY_CHARS_PER_DOC;
  let truncated = false;
  const inputs = docs.map((d) => {
    if (d.text.length > cap) truncated = true;
    return d.text.slice(0, cap);
  });
  // 文件名与任务说明同样随请求发出（复核 S5A-03）；事项口径（立场、法域等）由调用方给出
  for (const d of docs) inputs.push(d.filename);
  if (goal.trim()) inputs.push(goal.trim());
  for (const t of o.extraTexts ?? []) if (t.trim()) inputs.push(t.trim());
  const results = tokens.preview(matterId, inputs);
  const replaced: Partial<Record<TokenCategory, number>> = {};
  let total = 0;
  for (const r of results) {
    for (const [k, v] of Object.entries(r.counts) as [TokenCategory, number][]) {
      replaced[k] = (replaced[k] ?? 0) + v;
      total += v;
    }
  }
  const suspects = collectSuspects(
    results.map((r) => r.text),
    dismissedSuspects(db, matterId),
  );
  return {
    summary: {
      docs: docs.length,
      chars: docs.reduce((s, d) => s + d.text.length, 0) + goal.trim().length,
      replaced,
      replaced_total: total,
      orgs_kept: !fullPseudonym,
      suspects: { high: suspects.filter((s) => s.confidence === "high").length, medium: suspects.filter((s) => s.confidence === "medium").length, unreviewed: suspects.length },
      // 全文扫描时超出部分本来就不会发送（快照同一上限截断），不算“只统计了一部分”
      truncated: o.fullScan ? false : truncated,
    },
    suspects,
  };
}

export interface SendPreview {
  filename: string;
  sent_text: string;
  chars: number;
  truncated: boolean;
  replaced: Partial<Record<TokenCategory, number>>;
  /** 发送稿中代号的位置（不含真值）。 */
  tokens: { start: number; end: number; category: string }[];
  /** 发送稿中疑似未替换姓名的位置。 */
  suspects: { start: number; end: number; confidence: string }[];
  orgs_kept: boolean;
}

const TOKEN_RE = /〔([^〔〕·]{1,8})·[0-9A-HJKMNP-TV-Z]{6,10}〕/g;

export function sendPreview(db: KernelDb, tokens: MatterTokenStore, matterId: string, docId: string, fullPseudonym: boolean): SendPreview | null {
  const [doc] = docTexts(db, matterId, [docId]);
  if (!doc) return null;
  // 先按整段令牌化再截取（截断处不切开代号：取到完整代号为止）。发送视图把新条目写回令牌表（与真正发送时闸门写回的同一组确定性代号），
  // 界面悬停时才能经受审计的还原接口逐个还原；估价时的计数预跑不写回
  const head = doc.text.slice(0, PREVIEW_CHARS * 2);
  const [r] = tokens.tokenizeAll(matterId, [head]);
  let sent = r!.text;
  let truncated = doc.text.length > head.length;
  if (sent.length > PREVIEW_CHARS) {
    let cut = PREVIEW_CHARS;
    const open = sent.lastIndexOf("〔", cut);
    const close = sent.lastIndexOf("〕", cut);
    if (open > close) cut = open;
    sent = sent.slice(0, cut);
    truncated = true;
  }
  const tokenSpans = [...sent.matchAll(TOKEN_RE)].map((m) => ({ start: m.index!, end: m.index! + m[0].length, category: m[1]! }));
  const dismissed = dismissedSuspects(db, matterId);
  const suspectSpans: SendPreview["suspects"] = [];
  for (const s of suspectedNames(sent)) {
    if (dismissed.has(s.value)) continue;
    let from = 0;
    for (;;) {
      const i = sent.indexOf(s.value, from);
      if (i < 0) break;
      suspectSpans.push({ start: i, end: i + s.value.length, confidence: s.confidence });
      from = i + s.value.length;
    }
  }
  suspectSpans.sort((a, b) => a.start - b.start);
  return { filename: doc.filename, sent_text: sent, chars: doc.text.length, truncated, replaced: r!.counts, tokens: tokenSpans, suspects: suspectSpans, orgs_kept: !fullPseudonym };
}

/** 律师对疑似姓名的判定（只存本机账本；删除事项时一并清除）。 */
export function recordSuspectReview(db: KernelDb, matterId: string, value: string, decision: "not_name" | "name", by: string): void {
  db.run(
    `INSERT INTO matter_suspect_reviews (matter_id, value, decision, decided_by) VALUES (?,?,?,?)
     ON CONFLICT (matter_id, value) DO UPDATE SET decision = excluded.decision, decided_by = excluded.decided_by, decided_at = CURRENT_TIMESTAMP`,
    [matterId, value, decision, by],
  );
}

/** 估价与发起共用：L3a 事项还有未核对的疑似姓名时不能发起。返回摘要用于审计（不含值）。 */
export function suspectsDigest(s: readonly SuspectView[]): string {
  return createHash("sha256").update(JSON.stringify(s.map((x) => [x.confidence, x.occurrences]))).digest("hex");
}
