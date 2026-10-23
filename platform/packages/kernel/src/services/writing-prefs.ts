/**
 * 我的写作偏好（v9.4 第 22 批；评审 C1 §1 #29，借鉴 Harvey User-Level Memory，按“个人偏好与案情分仓”重设计）。
 *
 * 律师每次都要交代的格式与文风（落款、法条引用写法、其他说明）存一次，之后每个 AI 任务都带上；
 * **只存格式与文风，不存案情**：保存时内核拦下像本人事项里的当事人名称、案号、金额的内容（防止把案情写进“偏好”而带进每个事项的任务）。
 * 存在本机账本（按律师本人；不同步、不上云），发起任务时快照进任务输入，发给 AI 时随整段提示词令牌化。
 */
import { DomainError } from "@zr-legal/domain";
import type { KernelDb } from "../db.ts";

export const PREFS_LIMITS = { signature: 60, notes: 200 } as const;

export interface WritingPrefs {
  /** 落款（如“××律师事务所 张三 律师”）。 */
  signature: string | null;
  /** 法条引用：full 每次写全称 / short 首次全称、之后简称；null 不指定。 */
  citation: "full" | "short" | null;
  /** 其他格式与文风说明。 */
  notes: string | null;
}

const EMPTY: WritingPrefs = { signature: null, citation: null, notes: null };

const clean = (v: unknown, max: number, field: string): string | null => {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw new DomainError("validation", `${field}须为文字`, 422);
  const s = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if ([...s].length > max) throw new DomainError("validation", `${field}至多 ${max} 字`, 422);
  return s || null;
};

/** 像案情的写法：案号（含劳动仲裁的方括号、六角括号写法）、金额（含中文数字与货币符号）、身份证号、手机号（复核 Q4-01）。 */
const CASE_NO = /[（(\[〔【]\s*\d{4}\s*[)）\]〕】][^\s，。；]{1,20}号/;
const AMOUNT = /\d[\d,，.]*\s*(元|万元|亿元)|[零〇一二两三四五六七八九十百千万亿壹贰叁肆伍陆柒捌玖拾佰仟]+\s*(元|万元|亿元)|人民币\s*[\d零〇一二两三四五六七八九十壹贰叁肆伍陆柒捌玖拾]|[￥¥]\s*\d/;
const ID_LIKE = /\b\d{17}[\dXx]\b|\b1[3-9]\d{9}\b/;

/** 本人事项里的当事人名称（委托人、相对方、当事人名单），用于拦下写进偏好的案情。名称至少 2 个字才比对。 */
function partyNames(db: KernelDb, tenantId: string, userId: string): string[] {
  const out = new Set<string>();
  const add = (s: string | null | undefined) => {
    for (const part of String(s ?? "").split(/[、,，;；\n]/)) {
      const t = part.replace(/（示例）$/, "").trim();
      if ([...t].length >= 2) out.add(t);
    }
  };
  for (const m of db.all<{ client_name: string | null; counterparty: string | null }>(
    `SELECT m.client_name, m.counterparty FROM matters m JOIN matter_members mm ON mm.matter_id = m.matter_id AND mm.user_id = ? AND mm.removed_at IS NULL WHERE m.tenant_id = ? AND m.lifecycle <> 'purged'`,
    [userId, tenantId],
  )) {
    add(m.client_name);
    add(m.counterparty);
  }
  for (const p of db.all<{ name: string }>(
    `SELECT p.name FROM matter_parties p JOIN matter_members mm ON mm.matter_id = p.matter_id AND mm.user_id = ? AND mm.removed_at IS NULL`,
    [userId],
  )) add(p.name);
  return [...out];
}

/** 偏好里像案情的地方（给律师看的一句话）；没有返回 null。 */
export function caseLikeProblem(text: string, parties: readonly string[]): string | null {
  if (CASE_NO.test(text)) return "像是案号";
  if (AMOUNT.test(text)) return "像是金额";
  if (ID_LIKE.test(text)) return "像是证件号或电话";
  const hit = parties.find((n) => text.includes(n));
  if (hit) return `出现了你事项里的当事人名称（${hit}）`;
  return null;
}

export function getWritingPrefs(db: KernelDb, tenantId: string, userId: string): WritingPrefs {
  const r = db.get<{ prefs: string }>(`SELECT prefs FROM user_writing_prefs WHERE tenant_id = ? AND user_id = ?`, [tenantId, userId]);
  if (!r) return { ...EMPTY };
  try {
    const p = JSON.parse(r.prefs) as Partial<WritingPrefs>;
    return { signature: p.signature ?? null, citation: p.citation === "full" || p.citation === "short" ? p.citation : null, notes: p.notes ?? null };
  } catch {
    return { ...EMPTY };
  }
}

/**
 * partiesIn：事项令牌词典的当事人检查（与无事项问答同一口径，容忍简称、别名等写法变体；复核 Q4-01——只比完整名称时，
 * “对丙科技要强硬”能存进偏好，再随别的事项的任务以原文发出，那个事项的令牌表不认识这个简称）。
 */
export function setWritingPrefs(db: KernelDb, tenantId: string, userId: string, input: Record<string, unknown>, partiesIn?: (matterId: string, text: string) => string[]): WritingPrefs {
  const prefs: WritingPrefs = {
    signature: clean(input.signature, PREFS_LIMITS.signature, "落款"),
    citation: input.citation === "full" || input.citation === "short" ? input.citation : input.citation === null || input.citation === undefined || input.citation === "" ? null : (() => {
      throw new DomainError("validation", "法条引用写法须为 full / short", 422);
    })(),
    notes: clean(input.notes, PREFS_LIMITS.notes, "其他说明"),
  };
  // 落款与其他说明都核（复核 Q4-01：落款里写“代理丙科技有限公司”也是案情）；本所名称与律师姓名不是当事人，不会被拦
  const parties = partyNames(db, tenantId, userId);
  const myMatters = partiesIn ? db.all<{ matter_id: string }>(`SELECT m.matter_id FROM matters m JOIN matter_members mm ON mm.matter_id = m.matter_id AND mm.user_id = ? AND mm.removed_at IS NULL WHERE m.tenant_id = ? AND m.lifecycle <> 'purged'`, [userId, tenantId]) : [];
  for (const [field, text] of [["落款", prefs.signature], ["其他说明", prefs.notes]] as const) {
    if (!text) continue;
    let p = caseLikeProblem(text, parties);
    if (!p && partiesIn) {
      for (const m of myMatters) {
        const hit = partiesIn(m.matter_id, text)[0];
        if (hit) {
          p = `出现了你事项里的当事人（${hit}）`;
          break;
        }
      }
    }
    if (p) throw new DomainError("validation", `写作偏好只存格式与文风，不存案情：${field}里${p}。请删掉后再保存`, 422);
  }
  if (!prefs.signature && !prefs.citation && !prefs.notes) {
    db.run(`DELETE FROM user_writing_prefs WHERE tenant_id = ? AND user_id = ?`, [tenantId, userId]);
    return prefs;
  }
  db.run(
    `INSERT INTO user_writing_prefs (tenant_id, user_id, prefs, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(tenant_id, user_id) DO UPDATE SET prefs = excluded.prefs, updated_at = excluded.updated_at`,
    [tenantId, userId, JSON.stringify(prefs), new Date().toISOString()],
  );
  return prefs;
}

export function hasPrefs(p: WritingPrefs): boolean {
  return !!(p.signature || p.citation || p.notes);
}

/** 发给 Agent 的一行（随整段提示词令牌化）；没设偏好返回空串。 */
export function prefsPromptLine(p: WritingPrefs | null | undefined): string {
  if (!p || !hasPrefs(p)) return "";
  const parts = [
    p.signature ? `文书落款写“${p.signature}”` : "",
    p.citation === "full" ? "法条每次写全称（如《中华人民共和国民法典》第五百七十七条）" : p.citation === "short" ? "法条首次写全称，之后可用简称（如《民法典》）" : "",
    p.notes ? `其他：${p.notes}` : "",
  ].filter(Boolean);
  return `【写作偏好（律师本人设定，只管格式与文风；与方法模板或任务说明冲突时以任务说明为准）】${parts.join("；")}。\n`;
}

/**
 * 离所、设备移交时清除这位律师在这台电脑上的写作偏好（复核 Q4 建议 3：原来全库没有按人删除个人数据的路径）。
 * 只删按人存的偏好；事项里的材料、成果与审计按律所留存规则走，不在这里删。返回删掉的条数。
 */
export function clearWritingPrefs(db: KernelDb, tenantId: string, userId: string): number {
  const n = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM user_writing_prefs WHERE tenant_id = ? AND user_id = ?`, [tenantId, userId])?.n ?? 0;
  if (n > 0) db.run(`DELETE FROM user_writing_prefs WHERE tenant_id = ? AND user_id = ?`, [tenantId, userId]);
  return n;
}
