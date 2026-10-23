/**
 * 本所范本库（v9.4 第 24 批；评审 C1 §1 #23“本所定稿库”，10-23 拍板改为“本所范本库”）。
 *
 * 只收律师主动放入、去掉客户信息的范本；不自动取别的事项的已签发件——不跨事项读案卷，不碰按事项密钥隔离的伦理墙。
 * 放入时按条拆开（“第 X 条”“一、”“1.”开头的段起一条），逐条查像客户信息的写法：本人事项里的当事人（含简称、别名，
 * 按令牌词典查）、案号、证件号、手机号、银行账号、邮箱；查到的要么律师改好再放，要么一键换成【】占位符。
 * 审合同时，工作台的卡片按条款相似度列出“本所范本对此条的写法”（明确标“本所范本”，不叫“市场惯例”），律师可照着改。
 * 存在本机账本（SQLCipher，按律所；这台电脑上的成员共用，不同步、不上云）；不发给 AI。
 */
import { createHash } from "node:crypto";
import { DomainError, newId } from "@zr-legal/domain";
import type { KernelDb } from "../db.ts";

export const TEMPLATE_LIMITS = { title: 40, stance: 20, note: 200, clauses: 300, clause_chars: 4_000, total_chars: 200_000, templates: 200 } as const;

/** 合同类型：与材料初判（material-triage）同一套叫法，审合同时按材料的合同类型优先列同类范本。 */
export const TEMPLATE_CONTRACT_TYPES = ["买卖", "服务 / 技术服务", "租赁", "借款与担保", "建设工程施工", "技术开发", "股权转让", "投资协议（增资 / 股权收购）", "劳动合同（用人单位）", "保密与竞业限制", "其他"] as const;

export interface TemplateClause {
  seq: number;
  /** 条款标题（如“第八条 付款”），至多 30 字；首部为“首部”。 */
  heading: string;
  text: string;
}

export interface TemplateHit {
  seq: number;
  kind: "party" | "case_no" | "id_no" | "phone" | "account" | "email";
  text: string;
}

export interface FirmTemplate {
  template_id: string;
  title: string;
  contract_type: string;
  stance: string | null;
  note: string | null;
  source_name: string | null;
  clauses: number;
  sha256: string;
  created_by: string;
  created_at: string;
}

const HIT_LABEL: Record<TemplateHit["kind"], string> = { party: "当事人", case_no: "案号", id_no: "证件号", phone: "电话", account: "账号", email: "邮箱" };
export const HIT_KIND_TEXT: Record<TemplateHit["kind"], string> = { party: "像你事项里的当事人", case_no: "像案号", id_no: "像证件号", phone: "像手机号", account: "像银行账号", email: "像邮箱" };

/** 像客户信息的写法（与写作偏好同一口径，范本里的金额、比例、期限是条款内容，不拦）。 */
const PATTERNS: [TemplateHit["kind"], RegExp][] = [
  ["case_no", /[（(\[〔【]\s*\d{4}\s*[)）\]〕】][^\s，。；、]{1,20}号/g],
  ["id_no", /(?<!\d)\d{17}[\dXx](?!\d)/g],
  ["phone", /(?<!\d)1[3-9]\d{9}(?!\d)/g],
  ["account", /(?<!\d)\d{16,19}(?!\d)/g],
  ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
];

const clean = (v: unknown, max: number, field: string, required = false): string | null => {
  if (v === undefined || v === null || v === "") {
    if (required) throw new DomainError("validation", `请填写${field}`, 422);
    return null;
  }
  if (typeof v !== "string") throw new DomainError("validation", `${field}须为文字`, 422);
  const s = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!s && required) throw new DomainError("validation", `请填写${field}`, 422);
  if ([...s].length > max) throw new DomainError("validation", `${field}至多 ${max} 字`, 422);
  return s || null;
};

/** 起一条的段：“第八条”“第 8 条”“八、”“8.”“8、”（“8.1”这类下一级不算）。 */
const HEADING = /^(第\s*[一二三四五六七八九十百零〇\d]+\s*条|[一二三四五六七八九十]+、|\d{1,3}\s*[、.．](?!\d))/;

/** 纯函数：范本全文 → 条款。没有一处像条款标题的，按段落各成一条。 */
export function splitClauses(text: string): TemplateClause[] {
  const paras = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim()).filter(Boolean);
  const label = (p: string) => [...p.replace(/\s+/g, " ")].slice(0, 30).join("").replace(/[：:，,。；;]$/, "");
  const out: TemplateClause[] = [];
  if (!paras.some((p) => HEADING.test(p))) {
    paras.forEach((p, i) => out.push({ seq: i + 1, heading: label(p), text: p }));
    return out;
  }
  let cur: { heading: string; lines: string[] } | null = null;
  const head: string[] = [];
  const flush = () => {
    if (cur) out.push({ seq: out.length + 1, heading: cur.heading, text: cur.lines.join("\n") });
  };
  for (const p of paras) {
    if (HEADING.test(p)) {
      flush();
      // 标题段较长（标题与正文写在一段里）时取到第一个标点为止
      const m = /^[^：:，,。；;]{1,30}/.exec(p.replace(/\s+/g, " "));
      cur = { heading: label(m?.[0] ?? p), lines: [p] };
    } else if (cur) cur.lines.push(p);
    else head.push(p);
  }
  flush();
  // 首部（合同名称、当事人占位、鉴于条款）单列一条，便于律师看到查出的信息；不参与审合同时的条款匹配
  if (head.length) out.unshift({ seq: 0, heading: "首部", text: head.join("\n") });
  return out;
}

/** 纯函数：逐条查像客户信息的写法。parties：本人事项里的当事人名称（含简称、别名）命中。 */
export function findHits(clauses: readonly TemplateClause[], partySpans: (text: string) => { start: number; end: number }[]): TemplateHit[] {
  const hits: TemplateHit[] = [];
  for (const c of clauses) {
    const seen = new Set<string>();
    const push = (kind: TemplateHit["kind"], t: string) => {
      const k = `${kind}:${t}`;
      if (seen.has(k)) return;
      seen.add(k);
      hits.push({ seq: c.seq, kind, text: t });
    };
    for (const s of partySpans(c.text)) push("party", c.text.slice(s.start, s.end));
    for (const [kind, re] of PATTERNS) for (const m of c.text.matchAll(re)) push(kind, m[0]);
  }
  // 证件号同时像账号时只报一次（18 位）
  return hits.filter((h) => !(h.kind === "account" && hits.some((x) => x.seq === h.seq && x.kind === "id_no" && x.text === h.text)));
}

/** 把查到的地方换成【当事人】【案号】等占位符（长的先换，免得短的先换掉一截）。 */
export function replaceHits(clauses: readonly TemplateClause[], hits: readonly TemplateHit[]): TemplateClause[] {
  return clauses.map((c) => {
    let text = c.text;
    let heading = c.heading;
    for (const h of hits.filter((x) => x.seq === c.seq).sort((a, b) => b.text.length - a.text.length)) {
      text = text.split(h.text).join(`【${HIT_LABEL[h.kind]}】`);
      heading = heading.split(h.text).join(`【${HIT_LABEL[h.kind]}】`);
    }
    return { ...c, heading, text };
  });
}

export interface TemplateInput {
  title: unknown;
  contract_type: unknown;
  stance?: unknown;
  note?: unknown;
  text: string;
  source_name?: string | null;
}

/** 校验并拆条（不写库）。 */
export function prepareTemplate(input: TemplateInput): { title: string; contract_type: string; stance: string | null; note: string | null; clauses: TemplateClause[] } {
  const title = clean(input.title, TEMPLATE_LIMITS.title, "范本名称", true)!;
  const contract_type = String(input.contract_type ?? "");
  if (!(TEMPLATE_CONTRACT_TYPES as readonly string[]).includes(contract_type)) throw new DomainError("validation", "请选择合同类型", 422);
  const stance = clean(input.stance, TEMPLATE_LIMITS.stance, "适用立场");
  const note = clean(input.note, TEMPLATE_LIMITS.note, "说明");
  const text = String(input.text ?? "");
  if ([...text].length > TEMPLATE_LIMITS.total_chars) throw new DomainError("validation", `范本太长（上限 ${TEMPLATE_LIMITS.total_chars / 10_000} 万字）：请只放合同正文`, 422);
  const clauses = splitClauses(text);
  if (clauses.filter((c) => c.seq > 0).length === 0) throw new DomainError("validation", "没有读到范本正文：请确认文件里有文字（扫描件请先转成 Word）", 422);
  if (clauses.length > TEMPLATE_LIMITS.clauses) throw new DomainError("validation", `范本条款太多（上限 ${TEMPLATE_LIMITS.clauses} 条）`, 422);
  const long = clauses.find((c) => [...c.text].length > TEMPLATE_LIMITS.clause_chars);
  if (long) throw new DomainError("validation", `“${long.heading}”这一条太长（上限 ${TEMPLATE_LIMITS.clause_chars} 字）：可能没认出条款标题，请检查范本格式`, 422);
  return { title, contract_type, stance, note, clauses };
}

const sha = (clauses: readonly TemplateClause[]) => createHash("sha256").update(JSON.stringify(clauses.map((c) => [c.seq, c.heading, c.text]))).digest("hex");

/** 放入范本：调用方先确认 findHits 为空（或已 replaceHits）。 */
export function saveTemplate(db: KernelDb, who: { tenantId: string; userId: string }, t: ReturnType<typeof prepareTemplate>, sourceName: string | null): FirmTemplate {
  const n = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM firm_templates WHERE tenant_id = ?`, [who.tenantId])?.n ?? 0;
  if (n >= TEMPLATE_LIMITS.templates) throw new DomainError("validation", `范本库已满（上限 ${TEMPLATE_LIMITS.templates} 份）：请先删掉不用的`, 422);
  const id = newId("firmTemplate");
  const now = new Date().toISOString();
  const digest = sha(t.clauses);
  db.tx(() => {
    db.run(
      `INSERT INTO firm_templates (template_id, tenant_id, title, contract_type, stance, note, source_name, sha256, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, who.tenantId, t.title, t.contract_type, t.stance, t.note, sourceName, digest, who.userId, now],
    );
    for (const c of t.clauses) db.run(`INSERT INTO firm_template_clauses (template_id, seq, heading, text) VALUES (?,?,?,?)`, [id, c.seq, c.heading, c.text]);
  });
  return getTemplate(db, who.tenantId, id).template;
}

type Row = Omit<FirmTemplate, "clauses"> & { clauses: number };

export function listTemplates(db: KernelDb, tenantId: string): FirmTemplate[] {
  return db.all<Row>(
    `SELECT t.template_id, t.title, t.contract_type, t.stance, t.note, t.source_name, t.sha256, t.created_by, t.created_at,
            (SELECT COUNT(*) FROM firm_template_clauses c WHERE c.template_id = t.template_id AND c.seq > 0) AS clauses
       FROM firm_templates t WHERE t.tenant_id = ? ORDER BY t.contract_type, t.created_at DESC`,
    [tenantId],
  );
}

export function getTemplate(db: KernelDb, tenantId: string, templateId: string): { template: FirmTemplate; clauses: TemplateClause[] } {
  const template = listTemplates(db, tenantId).find((t) => t.template_id === templateId);
  if (!template) throw new DomainError("not_found", "范本库里没有这份范本（可能已被删除）", 404);
  const clauses = db.all<TemplateClause>(`SELECT seq, heading, text FROM firm_template_clauses WHERE template_id = ? ORDER BY seq`, [templateId]);
  return { template, clauses };
}

export function removeTemplate(db: KernelDb, tenantId: string, templateId: string): void {
  getTemplate(db, tenantId, templateId);
  db.tx(() => {
    db.run(`DELETE FROM firm_template_clauses WHERE template_id = ?`, [templateId]);
    db.run(`DELETE FROM firm_templates WHERE template_id = ? AND tenant_id = ?`, [templateId, tenantId]);
  });
}

/** 比较用的字符二元组：去掉代号〔…〕、条号、空白与标点。 */
function grams(s: string): Set<string> {
  const t = s.replace(/〔[^〕]{0,24}〕/g, " ").replace(/第\s*[一二三四五六七八九十百零〇\d]+\s*条/g, " ").replace(/[^\p{Script=Han}A-Za-z0-9]+/gu, " ");
  const out = new Set<string>();
  for (const w of t.split(" ")) {
    const cs = [...w];
    for (let i = 0; i + 1 < cs.length; i++) out.add(cs[i]! + cs[i + 1]!);
  }
  return out;
}

/** 标题里的关键词（去掉“第 X 条”与序号）：如“付款”“违约责任”。 */
const headingWord = (h: string) => h.replace(HEADING, "").replace(/[\s：:、.．]/g, "").slice(0, 12);

export interface TemplateMatch {
  template_id: string;
  title: string;
  contract_type: string;
  stance: string | null;
  stance_differs: boolean;
  same_type: boolean;
  seq: number;
  heading: string;
  text: string;
  score: number;
}

/**
 * 审合同时卡片的“本所范本对此条的写法”：按字符二元组加权余弦（权重为库内逆文档频率，“甲方”“本合同”这类到处都有的词权重低），
 * 条款标题关键词出现在卡片里的加分；同类合同的范本优先。最多 3 条、每份范本至多 2 条；分数太低的不列。
 */
export function matchClauses(
  db: KernelDb,
  tenantId: string,
  query: { text: string; contract_type: string | null; stance: string | null },
  limit = 3,
): TemplateMatch[] {
  const rows = db.all<{ template_id: string; title: string; contract_type: string; stance: string | null; seq: number; heading: string; text: string }>(
    `SELECT t.template_id, t.title, t.contract_type, t.stance, c.seq, c.heading, c.text FROM firm_template_clauses c JOIN firm_templates t ON t.template_id = c.template_id
      WHERE t.tenant_id = ? AND c.seq > 0`,
    [tenantId],
  );
  if (rows.length === 0) return [];
  const q = grams(query.text);
  if (q.size === 0) return [];
  const docs = rows.map((r) => grams(`${r.heading}\n${r.text}`));
  const df = new Map<string, number>();
  for (const g of docs) for (const x of g) df.set(x, (df.get(x) ?? 0) + 1);
  const n = rows.length;
  const w = (x: string) => Math.log(1 + n / (df.get(x) ?? 0.5));
  const qNorm = Math.sqrt([...q].reduce((a, x) => a + w(x) ** 2, 0));
  const plainQuery = query.text.replace(/〔[^〕]{0,24}〕/g, "");
  const stance = (query.stance ?? "").trim();
  const scored = rows.map((r, i) => {
    const d = docs[i]!;
    let dot = 0;
    for (const x of q) if (d.has(x)) dot += w(x) ** 2;
    const dNorm = Math.sqrt([...d].reduce((a, x) => a + w(x) ** 2, 0));
    let score = dot / (qNorm * dNorm || 1);
    const hw = headingWord(r.heading);
    if ([...hw].length >= 2 && plainQuery.includes(hw)) score += 0.25;
    const sameType = !!query.contract_type && r.contract_type === query.contract_type;
    if (sameType) score += 0.05;
    const stanceDiffers = !!r.stance && r.stance !== "通用" && !!stance && !stance.includes(r.stance) && !r.stance.includes(stance);
    return { template_id: r.template_id, title: r.title, contract_type: r.contract_type, stance: r.stance, stance_differs: stanceDiffers, same_type: sameType, seq: r.seq, heading: r.heading, text: r.text, score: Math.round(score * 1000) / 1000 };
  });
  const perTemplate = new Map<string, number>();
  return scored
    .filter((s) => s.score >= 0.18)
    .sort((a, b) => b.score - a.score)
    .filter((s) => {
      const k = perTemplate.get(s.template_id) ?? 0;
      if (k >= 2) return false;
      perTemplate.set(s.template_id, k + 1);
      return true;
    })
    .slice(0, limit);
}
