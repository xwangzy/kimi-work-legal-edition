/**
 * 当事人信息（D-224）：事项里“存一次、各文书自动带入”的一份材料《当事人信息（律师填写）.txt》。
 * 与第 55 批案情说明（D-219）同一机制：零迁移，同步、归档、令牌化都按普通材料覆盖；改了出新版本（supersedes 指向上一版），事项里只有一份当前有效。
 * 文本既给人看也给模型看；这里的序列化与解析是同一份纯函数，往返一致（用例 b56-parties）。解析不了（律师手改过文件）返回 null，
 * 对话框退化为直接编辑原文。
 */

export type PartySide = "ours" | "theirs" | "third" | "other";
export type PartyKind = "org" | "person";

export interface PartyEntry {
  side: PartySide;
  kind: PartyKind;
  /** 称谓（可空）：原告、被申请人……写在“我方（原告）”的括号里。 */
  role: string;
  name: string;
  /** 单位：统一社会信用代码、住所、法定代表人、职务、联系电话；自然人：性别、出生日期、身份证号、住址、联系电话。 */
  fields: Partial<Record<PartyFieldKey, string>>;
}

export type PartyFieldKey = "uscc" | "address" | "legal_rep" | "legal_rep_title" | "phone" | "gender" | "birth" | "id_number";

export const PARTY_SIDE_LABELS: Record<PartySide, string> = { ours: "我方", theirs: "对方", third: "第三人", other: "其他当事人" };
export const PARTY_KIND_LABELS: Record<PartyKind, string> = { org: "单位", person: "自然人" };

/** 每类当事人的身份事项（顺序即文本里的顺序）。法定代表人与职务在文本里写在同一行。 */
export const PARTY_FIELDS: Record<PartyKind, { key: PartyFieldKey; label: string; placeholder?: string }[]> = {
  org: [
    { key: "uscc", label: "统一社会信用代码", placeholder: "18 位" },
    { key: "address", label: "住所", placeholder: "以营业执照登记为准" },
    { key: "legal_rep", label: "法定代表人" },
    { key: "legal_rep_title", label: "职务", placeholder: "如 执行董事" },
    { key: "phone", label: "联系电话" },
  ],
  person: [
    { key: "gender", label: "性别" },
    { key: "birth", label: "出生日期", placeholder: "如 1985 年 3 月 2 日" },
    { key: "id_number", label: "身份证号" },
    { key: "address", label: "住址" },
    { key: "phone", label: "联系电话" },
  ],
};

/** 材料文件名（固定，不带日期：每次保存是同一份材料的新版本）。内核按前缀 PARTIES_PREFIX 认它。 */
export const PARTIES_FILENAME = "当事人信息（律师填写）.txt";
export const PARTIES_PREFIX = "当事人信息（律师填写）";
export const PARTIES_HEAD = "【当事人信息（律师填写）】本文件由承办律师填写，文书首部的当事人身份事项以此为准。";

const NUMS = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十"];
const SIDE_BY_LABEL = new Map(Object.entries(PARTY_SIDE_LABELS).map(([k, v]) => [v, k as PartySide]));
const KIND_BY_LABEL = new Map(Object.entries(PARTY_KIND_LABELS).map(([k, v]) => [v, k as PartyKind]));

/** 一行之内的值：去掉首尾空白，换行并成一个空格。 */
const clean = (s: string | undefined) => (s ?? "").replace(/\s*\r?\n\s*/g, " ").trim();

/**
 * 号码与地址去掉中间的空格（代码、证件号再转大写）。令牌化按模式认号码与地址：“张江路 1288 号 3 幢”、小写或分组写的信用代码、
 * “021 5888 1234”现有规则认不出、会原文发出（D-224 核对）；这里写成规则认得出的写法，不改令牌化规则。纯函数。
 */
export function normalizePartyValue(key: PartyFieldKey, v: string): string {
  const s = clean(v);
  if (key === "uscc" || key === "id_number") return s.replace(/\s+/g, "").toUpperCase();
  if (key === "address" || key === "phone") return s.replace(/\s+/g, "");
  return s;
}

/** 这一方填了的身份事项数（不含名称）。纯函数。 */
export function filledCount(p: PartyEntry): number {
  return PARTY_FIELDS[p.kind].filter((f) => clean(p.fields[f.key])).length;
}

/** 这一方是否什么都没填（名称与身份事项都空）：保存时不写出。 */
export function isBlankParty(p: PartyEntry): boolean {
  return !clean(p.name) && filledCount(p) === 0;
}

/** 表单 → 材料文本。没填的项不写出；整方都空的不写出。纯函数。 */
export function serializeParties(list: readonly PartyEntry[]): string {
  const rows = list.filter((p) => !isBlankParty(p));
  const out: string[] = [PARTIES_HEAD];
  rows.forEach((p, i) => {
    const role = clean(p.role);
    out.push("");
    out.push(`${NUMS[i] ?? String(i + 1)}、${PARTY_SIDE_LABELS[p.side]}${role ? `（${role}）` : ""}：${clean(p.name)}（${PARTY_KIND_LABELS[p.kind]}）`);
    const v = (k: PartyFieldKey) => normalizePartyValue(k, p.fields[k] ?? "");
    for (const f of PARTY_FIELDS[p.kind]) {
      if (f.key === "legal_rep_title") continue;
      if (f.key === "legal_rep") {
        const rep = v("legal_rep");
        const title = v("legal_rep_title");
        if (rep && title) out.push(`法定代表人：${rep}，职务：${title}`);
        else if (rep) out.push(`法定代表人：${rep}`);
        else if (title) out.push(`法定代表人职务：${title}`);
        continue;
      }
      if (v(f.key)) out.push(`${f.label}：${v(f.key)}`);
    }
  });
  return `${out.join("\n")}\n`;
}

const HEADER_RE = /^(?:[一二三四五六七八九十]+|\d+)、(我方|对方|第三人|其他当事人)(?:（([^）]*)）)?：(.*)（(单位|自然人)）$/;

/** 材料文本 → 表单。认不出的行（律师手改过）返回 null。纯函数。 */
export function parseParties(text: string): PartyEntry[] | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n").map((l) => l.trim());
  const body = lines.filter(Boolean);
  if (body[0] !== PARTIES_HEAD) return null;
  const out: PartyEntry[] = [];
  let cur: PartyEntry | null = null;
  for (const line of body.slice(1)) {
    const h = HEADER_RE.exec(line);
    if (h) {
      cur = { side: SIDE_BY_LABEL.get(h[1]!)!, role: (h[2] ?? "").trim(), name: h[3]!.trim(), kind: KIND_BY_LABEL.get(h[4]!)!, fields: {} };
      out.push(cur);
      continue;
    }
    if (!cur) return null;
    const m = /^([^：]+)：(.*)$/.exec(line);
    if (!m) return null;
    const label = m[1]!.trim();
    const val = m[2]!.trim();
    if (cur.kind === "org" && label === "法定代表人") {
      const [rep, title] = val.split("，职务：");
      cur.fields.legal_rep = rep!.trim();
      if (title !== undefined) cur.fields.legal_rep_title = title.trim();
      continue;
    }
    if (cur.kind === "org" && label === "法定代表人职务") {
      cur.fields.legal_rep_title = val;
      continue;
    }
    const f = PARTY_FIELDS[cur.kind].find((x) => x.label === label && x.key !== "legal_rep" && x.key !== "legal_rep_title");
    if (!f || cur.fields[f.key] !== undefined) return null;
    cur.fields[f.key] = val;
  }
  return out;
}

/** 立场 → 我方 / 对方的称谓（只在立场写明原告、被告时预填；其他立场让律师自己写）。 */
function rolesFor(stance: string | null | undefined): { ours: string; theirs: string } {
  // 立场有代码（plaintiff）与中文（原告）两种存法
  if (stance === "plaintiff" || stance === "原告") return { ours: "原告", theirs: "被告" };
  if (stance === "defendant" || stance === "被告") return { ours: "被告", theirs: "原告" };
  return { ours: "", theirs: "" };
}

export function blankParty(side: PartySide, kind: PartyKind = "org", name = "", role = ""): PartyEntry {
  return { side, kind, role, name, fields: {} };
}

/** 没有材料时的初始表单：我方 = 客户，对方 = 相对方（顿号分隔的逐个列出）；名称用事项已有的名称预填。纯函数。 */
export function initialParties(m: { client_name?: string | null; counterparty?: string | null; stance?: string | null }): PartyEntry[] {
  const r = rolesFor(m.stance);
  const guess = (name: string): PartyKind => (name && !/公司|集团|企业|中心|合作社|事务所|银行|学校|医院|委员会|政府|局$|厂$|店$|部$/.test(name) && [...name].length <= 4 ? "person" : "org");
  const ours = clean(m.client_name ?? "");
  const theirs = clean(m.counterparty ?? "").split(/[、，,；;]/).map((s) => s.trim()).filter(Boolean);
  return [blankParty("ours", guess(ours), ours, r.ours), ...(theirs.length > 0 ? theirs : [""]).map((n) => blankParty("theirs", guess(n), n, r.theirs))];
}

/** 摘要：每方一行（名称 · 已填几项）。纯函数。 */
export function partiesSummary(list: readonly PartyEntry[]): { side: string; name: string; filled: number }[] {
  return list.filter((p) => !isBlankParty(p)).map((p) => ({ side: PARTY_SIDE_LABELS[p.side], name: clean(p.name) || "（未写名称）", filled: filledCount(p) }));
}

/** 开始面板的一句：“我方 5 项、对方 3 项”（同一类有几方时合计）。纯函数。 */
export function partiesShort(list: readonly PartyEntry[]): string {
  const sum = new Map<string, number>();
  for (const p of list) {
    if (isBlankParty(p)) continue;
    const k = PARTY_SIDE_LABELS[p.side];
    sum.set(k, (sum.get(k) ?? 0) + filledCount(p));
  }
  return [...sum].map(([k, n]) => `${k} ${n} 项`).join("、");
}

/** 本事项当前有效的那份当事人信息材料（最新、未被新版本取代、未隔离）；没有返回 null。纯函数。 */
export function currentPartiesDoc<T extends { document_version_id: string; filename: string; supersedes?: string | null; quarantined_at?: string | null; created_at?: string }>(docs: readonly T[]): T | null {
  const old = new Set(docs.map((d) => d.supersedes).filter((x): x is string => typeof x === "string" && x.length > 0));
  const cands = docs.filter((d) => d.filename.startsWith(PARTIES_PREFIX) && !d.quarantined_at && !old.has(d.document_version_id));
  return [...cands].sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))[0] ?? null;
}

/**
 * 发起时把当事人信息计入本次可读材料（与案情说明同一口径）：勾了别的材料时把它一并勾上；一份都没勾 = 可读全部材料，它已在其中，
 * 不单独勾（单独勾上反而把范围缩成只有这一份）。只对要写当事人身份首部的卡。纯函数。
 */
export function withPartiesDoc(docIds: readonly string[], partiesId: string | null, needsParties: boolean): string[] {
  if (!needsParties || !partiesId || docIds.length === 0 || docIds.includes(partiesId)) return [...docIds];
  return [...docIds, partiesId];
}
