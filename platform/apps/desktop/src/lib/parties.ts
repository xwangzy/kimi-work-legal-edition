/**
 * 当事人信息（D-224）：事项里“存一次、各文书自动带入”的一份材料《当事人信息（律师填写）.txt》。
 * 与第 55 批案情说明（D-219）同一机制：零迁移，同步、归档、令牌化都按普通材料覆盖；改了出新版本（supersedes 指向上一版），事项里只有一份当前有效。
 * 文本既给人看也给模型看；这里的序列化与解析是同一份纯函数，往返一致（用例 b56-parties）。解析不了（律师手改过文件）返回 null，
 * 对话框退化为直接编辑原文。
 *
 * 第 64 批：当事人分自然人 / 法人 / 其他组织（非法人组织）三类，自然人加民族等；每方可挂至多两名委托诉讼代理人（民诉法第六十一条），
 * 带身份、执业机构与授权范围（第六十二条特别授权事项）。各方之后附一段按上面各项自动生成的“文书首部写法”，模型照抄即可，
 * 首部映射不再靠模型自己拼；这一段每次保存重新生成，解析时核对它与上面各项一致（律师手改过就退化为原文编辑，不静默丢改动）。
 * 旧文件（（单位）、“身份证号”、没有首部写法）照常解析。
 */

export type PartySide = "ours" | "theirs" | "third" | "other";
/** 自然人 / 法人 / 其他组织（个人独资企业、合伙企业、分支机构等不具有法人资格的组织）。 */
export type PartyKind = "person" | "org" | "other_org";

export interface PartyEntry {
  side: PartySide;
  kind: PartyKind;
  /** 称谓（可空）：原告、被申请人、上诉人（原审被告）……写在“我方（原告）”的括号里。 */
  role: string;
  name: string;
  /** 法人与其他组织：统一社会信用代码、住所、法定代表人（主要负责人）、职务、联系电话；自然人：性别、民族、出生日期、公民身份号码、住址、联系电话等。 */
  fields: Partial<Record<PartyFieldKey, string>>;
  /** 委托诉讼代理人（至多两名）；没有时不写这个键。 */
  agents?: PartyAgent[];
}

export type PartyFieldKey = "uscc" | "address" | "legal_rep" | "legal_rep_title" | "phone" | "gender" | "ethnicity" | "birth" | "id_number" | "residence" | "occupation" | "employer";

/** 委托诉讼代理人的身份（民诉法第六十一条第二款）。 */
export type AgentIdentity = "lawyer" | "legal_worker" | "relative" | "staff" | "recommended";
export type AgentFieldKey = "org" | "license" | "relation" | "title" | "phone";
/** 授权范围：未写 / 一般授权 / 特别授权。 */
export type AgentScope = "" | "general" | "special";
/** 特别授权事项（民诉法第六十二条第二款）：代为承认、放弃、变更诉讼请求，进行和解，提起反诉或者上诉。 */
export type SpecialPower = "admit" | "waive" | "modify" | "settle" | "counterclaim" | "appeal";

export interface PartyAgent {
  /** 姓名：只有写了姓名的代理人才写出。 */
  name: string;
  identity: AgentIdentity;
  fields: Partial<Record<AgentFieldKey, string>>;
  scope: AgentScope;
  /** 特别授权的事项（固定顺序）；不是特别授权时为空。 */
  powers: SpecialPower[];
}

/** 代理人的称呼：诉讼文书写“委托诉讼代理人”，仲裁与非诉文书写“委托代理人”。 */
export type AgentLabel = "委托诉讼代理人" | "委托代理人";

export const PARTY_SIDE_LABELS: Record<PartySide, string> = { ours: "我方", theirs: "对方", third: "第三人", other: "其他当事人" };
export const PARTY_KIND_LABELS: Record<PartyKind, string> = { person: "自然人", org: "法人", other_org: "其他组织" };
/** 类型的说明（对话框里的提示）。 */
export const PARTY_KIND_HINTS: Record<PartyKind, string> = {
  person: "公民个人",
  org: "公司、事业单位、社会团体、机关等",
  other_org: "个人独资企业、合伙企业、分公司等分支机构（不具有法人资格）",
};
export const PARTY_KINDS: PartyKind[] = ["person", "org", "other_org"];

export interface PartyFieldDef {
  key: PartyFieldKey;
  label: string;
  placeholder?: string;
  /** 文书首部常用：没填时提示“待补”，首部写法里写【待填】。 */
  core?: boolean;
  /** 不常用：收在“更多”里（填了才写出）。 */
  more?: boolean;
}

/** 每类当事人的身份事项（顺序即文本里的顺序）。法定代表人（主要负责人）与职务在文本里写在同一行。 */
export const PARTY_FIELDS: Record<PartyKind, PartyFieldDef[]> = {
  org: [
    { key: "uscc", label: "统一社会信用代码", placeholder: "18 位", core: true },
    { key: "address", label: "住所", placeholder: "以营业执照登记为准", core: true },
    { key: "legal_rep", label: "法定代表人", core: true },
    { key: "legal_rep_title", label: "职务", placeholder: "如 执行董事", core: true },
    { key: "phone", label: "联系电话", core: true },
  ],
  other_org: [
    { key: "uscc", label: "统一社会信用代码", placeholder: "18 位", core: true },
    { key: "address", label: "主要营业场所", placeholder: "以营业执照登记为准（个人独资企业写住所）", core: true },
    { key: "legal_rep", label: "主要负责人", placeholder: "如 执行事务合伙人、负责人", core: true },
    { key: "legal_rep_title", label: "职务", placeholder: "如 执行事务合伙人", core: true },
    { key: "phone", label: "联系电话", core: true },
  ],
  person: [
    { key: "gender", label: "性别", core: true },
    { key: "ethnicity", label: "民族", placeholder: "如 汉族", core: true },
    { key: "birth", label: "出生日期", placeholder: "如 1985年3月2日", core: true },
    { key: "id_number", label: "公民身份号码", placeholder: "18 位", core: true },
    { key: "address", label: "住址", placeholder: "以户籍或身份证登记为准", core: true },
    { key: "phone", label: "联系电话", core: true },
    { key: "residence", label: "经常居住地", placeholder: "与住址不一致时填", more: true },
    { key: "occupation", label: "职业", more: true },
    { key: "employer", label: "工作单位", more: true },
  ],
};

/** 旧文件里的写法（第 56 批）：解析时照认，保存时写成新写法。 */
const FIELD_ALIASES: Record<PartyKind, Record<string, PartyFieldKey>> = {
  person: { 身份证号: "id_number" },
  org: { 住所地: "address" },
  other_org: { 住所: "address", 住所地: "address" },
};

export const AGENT_IDENTITY_LABELS: Record<AgentIdentity, string> = {
  lawyer: "律师",
  legal_worker: "基层法律服务工作者",
  relative: "当事人的近亲属",
  staff: "当事人的工作人员",
  recommended: "社区、单位或社会团体推荐的公民",
};
export const AGENT_IDENTITIES: AgentIdentity[] = ["lawyer", "legal_worker", "relative", "staff", "recommended"];

/** 每种身份要填的事项（顺序即文本里的顺序）。 */
export const AGENT_FIELDS: Record<AgentIdentity, { key: AgentFieldKey; label: string; placeholder?: string }[]> = {
  lawyer: [
    { key: "org", label: "执业机构", placeholder: "如 北京某某律师事务所" },
    { key: "license", label: "执业证号", placeholder: "可不填" },
    { key: "phone", label: "联系电话" },
  ],
  legal_worker: [
    { key: "org", label: "法律服务所", placeholder: "如 某某区某某法律服务所" },
    { key: "license", label: "执业证号", placeholder: "可不填" },
    { key: "phone", label: "联系电话" },
  ],
  relative: [
    { key: "relation", label: "与当事人关系", placeholder: "如 配偶、儿子" },
    { key: "phone", label: "联系电话" },
  ],
  staff: [
    { key: "title", label: "职务", placeholder: "如 法务经理" },
    { key: "phone", label: "联系电话" },
  ],
  recommended: [
    { key: "org", label: "推荐单位", placeholder: "如 某某社区居民委员会" },
    { key: "phone", label: "联系电话" },
  ],
};

export const SPECIAL_POWERS: { key: SpecialPower; label: string }[] = [
  { key: "admit", label: "代为承认诉讼请求" },
  { key: "waive", label: "代为放弃诉讼请求" },
  { key: "modify", label: "代为变更诉讼请求" },
  { key: "settle", label: "进行和解" },
  { key: "counterclaim", label: "提起反诉" },
  { key: "appeal", label: "提起上诉" },
];
/** 每方至多两名委托诉讼代理人（民诉法第六十一条第一款）。 */
export const MAX_AGENTS = 2;

/** 材料文件名（固定，不带日期：每次保存是同一份材料的新版本）。内核按前缀 PARTIES_PREFIX 认它。 */
export const PARTIES_FILENAME = "当事人信息（律师填写）.txt";
export const PARTIES_PREFIX = "当事人信息（律师填写）";
export const PARTIES_HEAD = "【当事人信息（律师填写）】本文件由承办律师填写，文书首部的当事人身份事项以此为准。";
/** 自动生成的“文书首部写法”一段的分隔行（其后各行每次保存按上面各项重新生成）。 */
export const PARTIES_HEADER_MARK = "——以下为文书首部写法（按上面各项自动生成，照抄即可）——";
const TBD = "【待填】";

const NUMS = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十"];
const SIDE_BY_LABEL = new Map(Object.entries(PARTY_SIDE_LABELS).map(([k, v]) => [v, k as PartySide]));
const KIND_BY_LABEL = new Map<string, PartyKind>([...Object.entries(PARTY_KIND_LABELS).map(([k, v]) => [v, k as PartyKind] as const), ["单位", "org"]]);
const IDENTITY_BY_LABEL = new Map(Object.entries(AGENT_IDENTITY_LABELS).map(([k, v]) => [v, k as AgentIdentity]));
const AGENT_NUMS = ["一", "二"];

/** 一行之内的值：去掉首尾空白，换行并成一个空格。 */
const clean = (s: string | undefined) => (s ?? "").replace(/\s*\r?\n\s*/g, " ").trim();

/**
 * 号码与地址去掉中间的空格（代码、证件号再转大写）。令牌化按模式认号码与地址：“张江路 1288 号 3 幢”、小写或分组写的信用代码、
 * “021 5888 1234”现有规则认不出、会原文发出（D-224 核对）；这里写成规则认得出的写法，不改令牌化规则。纯函数。
 */
export function normalizePartyValue(key: PartyFieldKey | AgentFieldKey, v: string): string {
  const s = clean(v);
  if (key === "uscc" || key === "id_number" || key === "license") return s.replace(/\s+/g, "").toUpperCase();
  if (key === "address" || key === "residence" || key === "phone") return s.replace(/\s+/g, "");
  return s;
}

const repLabel = (k: PartyKind) => (k === "other_org" ? "主要负责人" : "法定代表人");
const fieldLabel = (k: PartyKind, key: PartyFieldKey) => PARTY_FIELDS[k].find((f) => f.key === key)?.label ?? key;

/** 这一方填了的身份事项数（不含名称与代理人）。纯函数。 */
export function filledCount(p: PartyEntry): number {
  return PARTY_FIELDS[p.kind].filter((f) => clean(p.fields[f.key])).length;
}

/** 写了姓名的代理人（只有这些写出）。纯函数。 */
export function namedAgents(p: Pick<PartyEntry, "agents">): PartyAgent[] {
  return (p.agents ?? []).filter((a) => clean(a.name)).slice(0, MAX_AGENTS);
}

/** 这一方是否什么都没填（名称、身份事项、代理人都空）：保存时不写出。 */
export function isBlankParty(p: PartyEntry): boolean {
  return !clean(p.name) && filledCount(p) === 0 && namedAgents(p).length === 0;
}

/** 首部常用事项的完成度：填了几项、共几项、还缺哪几项（标签）。纯函数。 */
export function partyCompleteness(p: PartyEntry): { filled: number; expected: number; missing: string[] } {
  const core = PARTY_FIELDS[p.kind].filter((f) => f.core);
  const missing = core.filter((f) => !clean(p.fields[f.key])).map((f) => f.label);
  return { filled: core.length - missing.length, expected: core.length, missing };
}

/** 特别授权事项的写法：“代为承认、放弃、变更诉讼请求，进行和解，提起反诉、上诉”。纯函数。 */
export function powersText(powers: readonly SpecialPower[]): string {
  const has = new Set(powers);
  const out: string[] = [];
  const claim = (["admit", "waive", "modify"] as const).filter((k) => has.has(k)).map((k) => ({ admit: "承认", waive: "放弃", modify: "变更" })[k]);
  if (claim.length) out.push(`代为${claim.join("、")}诉讼请求`);
  if (has.has("settle")) out.push("进行和解");
  const file = (["counterclaim", "appeal"] as const).filter((k) => has.has(k)).map((k) => ({ counterclaim: "反诉", appeal: "上诉" })[k]);
  if (file.length) out.push(`提起${file.join("、")}`);
  return out.join("，");
}

/** powersText 的逆：认不出返回 null。纯函数。 */
function parsePowers(s: string): SpecialPower[] | null {
  const has = new Set<SpecialPower>();
  for (const seg of s.split("，")) {
    const m1 = /^代为(.+)诉讼请求$/.exec(seg);
    const m2 = /^提起(.+)$/.exec(seg);
    if (m1) {
      for (const w of m1[1]!.split("、")) {
        const k = ({ 承认: "admit", 放弃: "waive", 变更: "modify" } as Record<string, SpecialPower>)[w];
        if (!k) return null;
        has.add(k);
      }
    } else if (seg === "进行和解") has.add("settle");
    else if (m2) {
      for (const w of m2[1]!.split("、")) {
        const k = ({ 反诉: "counterclaim", 上诉: "appeal" } as Record<string, SpecialPower>)[w];
        if (!k) return null;
        has.add(k);
      }
    } else return null;
  }
  return SPECIAL_POWERS.map((x) => x.key).filter((k) => has.has(k));
}

/** 授权范围的一句：“一般授权”“特别授权（代为承认……）”；没写为空串。纯函数。 */
export function scopeText(a: Pick<PartyAgent, "scope" | "powers">): string {
  if (a.scope === "general") return "一般授权";
  if (a.scope === "special") {
    const t = powersText(a.powers);
    return t ? `特别授权（${t}）` : "特别授权";
  }
  return "";
}

/** 代理人在摘要里的一句说明：执业机构、关系或职务；都没写时写身份。纯函数。 */
export function agentNote(a: PartyAgent): string {
  const f = (k: AgentFieldKey) => clean(a.fields[k]);
  if (a.identity === "lawyer" || a.identity === "legal_worker") return f("org") || AGENT_IDENTITY_LABELS[a.identity];
  if (a.identity === "relative") return f("relation") ? `${f("relation").replace(/^之/, "")}` : "近亲属";
  if (a.identity === "staff") return f("title") || "工作人员";
  return f("org") ? `${f("org")}推荐` : "推荐的公民";
}

/** 表单 → 材料文本。没填的项不写出；整方都空的不写出；各方之后附自动生成的文书首部写法。纯函数。 */
export function serializeParties(list: readonly PartyEntry[], opts: { agentLabel?: AgentLabel } = {}): string {
  const label = opts.agentLabel ?? "委托诉讼代理人";
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
        const rl = repLabel(p.kind);
        if (rep && title) out.push(`${rl}：${rep}，职务：${title}`);
        else if (rep) out.push(`${rl}：${rep}`);
        else if (title) out.push(`${rl}职务：${title}`);
        continue;
      }
      if (v(f.key)) out.push(`${f.label}：${v(f.key)}`);
    }
    namedAgents(p).forEach((a, j) => {
      out.push(`${label}${AGENT_NUMS[j]}：${clean(a.name)}（${AGENT_IDENTITY_LABELS[a.identity]}）`);
      for (const f of AGENT_FIELDS[a.identity]) {
        const val = normalizePartyValue(f.key, a.fields[f.key] ?? "");
        if (val) out.push(`${f.label}：${val}`);
      }
      const sc = scopeText(a);
      if (sc) out.push(`授权范围：${sc}`);
    });
  });
  if (rows.length > 0) {
    out.push("");
    out.push(PARTIES_HEADER_MARK);
    out.push(...headerLines(rows, label));
  }
  return `${out.join("\n")}\n`;
}

/**
 * 文书首部写法：每方一行（法人、其他组织另起一行写法定代表人 / 主要负责人），其代理人紧随其后。
 * 首部常用事项没填的写【待填】，不常用的填了才写；代理人只写姓名与执业机构等（授权范围不进首部）。纯函数。
 */
export function headerLines(list: readonly PartyEntry[], label: AgentLabel = "委托诉讼代理人"): string[] {
  const out: string[] = [];
  for (const p of list.filter((x) => !isBlankParty(x))) {
    const v = (k: PartyFieldKey) => normalizePartyValue(k, p.fields[k] ?? "");
    const role = clean(p.role) || TBD;
    const name = clean(p.name) || TBD;
    if (p.kind === "person") {
      const eth = v("ethnicity");
      // 工作单位与职业连写（“某某医院医生”）；只有工作单位时写“工作单位某某”，只有职业时写职业（“退休”）
      const job = v("employer") ? (v("occupation") ? `${v("employer")}${v("occupation")}` : `工作单位${v("employer")}`) : v("occupation");
      const parts = [
        name,
        v("gender") || `性别${TBD}`,
        eth ? (eth.endsWith("族") ? eth : `${eth}族`) : `民族${TBD}`,
        v("birth") ? `${v("birth")}出生` : `出生日期${TBD}`,
        `公民身份号码${v("id_number") || TBD}`,
        ...(job ? [job] : []),
        v("address") ? `住${v("address")}` : `住址${TBD}`,
        ...(v("residence") ? [`经常居住地${v("residence")}`] : []),
        `联系电话${v("phone") || TBD}`,
      ];
      out.push(`${role}：${parts.join("，")}。`);
    } else {
      const addr = fieldLabel(p.kind, "address");
      out.push(`${role}：${[name, `统一社会信用代码${v("uscc") || TBD}`, `${addr}${v("address") || TBD}`, `联系电话${v("phone") || TBD}`].join("，")}。`);
      out.push(`${repLabel(p.kind)}：${v("legal_rep") || TBD}，${v("legal_rep_title") || `职务${TBD}`}。`);
    }
    for (const a of namedAgents(p)) out.push(`${label}：${agentHeader(a, p, role === TBD ? "" : role)}。`);
  }
  return out;
}

function agentHeader(a: PartyAgent, p: PartyEntry, role: string): string {
  const f = (k: AgentFieldKey) => normalizePartyValue(k, a.fields[k] ?? "");
  const name = clean(a.name);
  const party = `${role}${clean(p.name)}` || "当事人";
  let s: string;
  if (a.identity === "lawyer") s = f("org") ? `${name}，${f("org")}律师` : `${name}，律师，执业机构${TBD}`;
  else if (a.identity === "legal_worker") s = f("org") ? `${name}，${f("org")}基层法律服务工作者` : `${name}，基层法律服务工作者，法律服务所${TBD}`;
  else if (a.identity === "relative") {
    const rel = f("relation");
    s = rel ? `${name}，系${party}${rel.startsWith("之") ? rel : `的${rel}`}` : `${name}，系${party}的近亲属（关系${TBD}）`;
  } else if (a.identity === "staff") s = `${name}，${clean(p.name) || party}${f("title") || "工作人员"}`;
  else s = f("org") ? `${name}，系${f("org")}推荐的公民` : `${name}，推荐单位${TBD}`;
  if (f("license")) s += `，执业证号${f("license")}`;
  if (f("phone")) s += `，联系电话${f("phone")}`;
  return s;
}

// 称谓可带一层括号：“上诉人（原审被告）”
const HEADER_RE = /^(?:[一二三四五六七八九十]+|\d+)、(我方|对方|第三人|其他当事人)(?:（((?:[^（）]|（[^（）]*）)*)）)?：(.*)（(单位|法人|自然人|其他组织)）$/;
const AGENT_RE = new RegExp(`^(委托诉讼代理人|委托代理人)([一二])：(.*)（(${[...IDENTITY_BY_LABEL.keys()].join("|")})）$`);

/** 材料里用的代理人称呼（没有代理人时为 null）。纯函数。 */
export function agentLabelIn(text: string | null | undefined): AgentLabel | null {
  const m = /^(委托诉讼代理人|委托代理人)[一二]：/m.exec(text ?? "");
  return m ? (m[1] as AgentLabel) : null;
}

/** 材料文本 → 表单。认不出的行（律师手改过）返回 null；末尾的文书首部写法须与上面各项一致，否则也返回 null。纯函数。 */
export function parseParties(text: string): PartyEntry[] | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n").map((l) => l.trim());
  const body = lines.filter(Boolean);
  if (body[0] !== PARTIES_HEAD) return null;
  const mark = body.indexOf(PARTIES_HEADER_MARK);
  const sections = mark < 0 ? body.slice(1) : body.slice(1, mark);
  const out: PartyEntry[] = [];
  let cur: PartyEntry | null = null;
  let agent: PartyAgent | null = null;
  let label: AgentLabel | null = null;
  for (const line of sections) {
    const h = HEADER_RE.exec(line);
    if (h) {
      cur = { side: SIDE_BY_LABEL.get(h[1]!)!, role: (h[2] ?? "").trim(), name: h[3]!.trim(), kind: KIND_BY_LABEL.get(h[4]!)!, fields: {} };
      agent = null;
      out.push(cur);
      continue;
    }
    if (!cur) return null;
    const ag = AGENT_RE.exec(line);
    if (ag) {
      // 同一份材料只用一种称呼；序号按顺序（一、二），至多两名
      if ((label && label !== ag[1]) || AGENT_NUMS.indexOf(ag[2]!) !== (cur.agents?.length ?? 0)) return null;
      label = ag[1] as AgentLabel;
      agent = { name: ag[3]!.trim(), identity: IDENTITY_BY_LABEL.get(ag[4]!)!, fields: {}, scope: "", powers: [] };
      (cur.agents ??= []).push(agent);
      continue;
    }
    const m = /^([^：]+)：(.*)$/.exec(line);
    if (!m) return null;
    const lab = m[1]!.trim();
    const val = m[2]!.trim();
    if (agent) {
      if (lab === "授权范围") {
        if (agent.scope) return null;
        if (val === "一般授权") agent.scope = "general";
        else if (val === "特别授权") agent.scope = "special";
        else {
          const sp = /^特别授权（(.+)）$/.exec(val);
          const powers = sp ? parsePowers(sp[1]!) : null;
          if (!powers) return null;
          agent.scope = "special";
          agent.powers = powers;
        }
        continue;
      }
      const f = AGENT_FIELDS[agent.identity].find((x) => x.label === lab);
      if (!f || agent.fields[f.key] !== undefined) return null;
      agent.fields[f.key] = val;
      continue;
    }
    if (cur.kind !== "person" && lab === repLabel(cur.kind)) {
      if (cur.fields.legal_rep !== undefined) return null;
      const [rep, title] = val.split("，职务：");
      cur.fields.legal_rep = rep!.trim();
      if (title !== undefined) cur.fields.legal_rep_title = title.trim();
      continue;
    }
    if (cur.kind !== "person" && lab === `${repLabel(cur.kind)}职务`) {
      if (cur.fields.legal_rep_title !== undefined) return null;
      cur.fields.legal_rep_title = val;
      continue;
    }
    const f: PartyFieldDef | undefined = PARTY_FIELDS[cur.kind].find((x) => x.label === lab && x.key !== "legal_rep" && x.key !== "legal_rep_title");
    const key: PartyFieldKey | undefined = f?.key ?? FIELD_ALIASES[cur.kind][lab];
    if (!key || cur.fields[key] !== undefined) return null;
    cur.fields[key] = val;
  }
  if (mark >= 0) {
    // 首部写法是按上面各项生成的：对不上（律师改过这一段或上面各项），交给律师在原文上改，不静默丢掉改动
    const want = headerLines(out, label ?? "委托诉讼代理人");
    const got = body.slice(mark + 1);
    if (got.length !== want.length || got.some((l, i) => l !== want[i])) return null;
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

export function blankAgent(identity: AgentIdentity = "lawyer"): PartyAgent {
  return { name: "", identity, fields: {}, scope: "", powers: [] };
}

/**
 * 各张卡的称谓建议（第 64 批）：按文书的诉讼地位给下拉建议，律师也可以自己写。
 * prefill 只用于第一次填（还没有材料时）、且这张卡的地位确定（起诉状我方必是原告；上诉状原审地位不确定，不预填）。
 */
const ROLE_SETS: { cards: readonly string[]; all: string[]; by?: Partial<Record<PartySide, string[]>>; prefill?: { ours: string; theirs: string } }[] = [
  { cards: ["pleading"], all: ["原告", "被告", "第三人"], by: { ours: ["原告"], theirs: ["被告"], third: ["第三人"] }, prefill: { ours: "原告", theirs: "被告" } },
  { cards: ["defense"], all: ["被告", "原告", "第三人"], by: { ours: ["被告"], theirs: ["原告"], third: ["第三人"] }, prefill: { ours: "被告", theirs: "原告" } },
  {
    cards: ["appeal"],
    all: ["上诉人（原审原告）", "上诉人（原审被告）", "上诉人（原审第三人）", "被上诉人（原审原告）", "被上诉人（原审被告）", "原审原告", "原审被告", "原审第三人"],
    by: { ours: ["上诉人（原审原告）", "上诉人（原审被告）", "上诉人（原审第三人）"], theirs: ["被上诉人（原审原告）", "被上诉人（原审被告）"], third: ["原审第三人", "原审原告", "原审被告"], other: ["原审第三人", "原审原告", "原审被告"] },
  },
  { cards: ["agency"], all: ["原告", "被告", "第三人", "上诉人", "被上诉人", "原审第三人"] },
  { cards: ["arbitration-app", "labor-arb-application"], all: ["申请人", "被申请人", "第三人"], by: { ours: ["申请人"], theirs: ["被申请人"], third: ["第三人"] }, prefill: { ours: "申请人", theirs: "被申请人" } },
  { cards: ["labor-arb-defense-lit", "labor-arb-defense"], all: ["被申请人", "申请人", "第三人"], by: { ours: ["被申请人"], theirs: ["申请人"], third: ["第三人"] }, prefill: { ours: "被申请人", theirs: "申请人" } },
  { cards: ["preservation"], all: ["申请人", "被申请人", "第三人"], by: { ours: ["申请人"], theirs: ["被申请人"] }, prefill: { ours: "申请人", theirs: "被申请人" } },
  { cards: ["enforcement"], all: ["申请执行人", "被执行人", "第三人"], by: { ours: ["申请执行人"], theirs: ["被执行人"] }, prefill: { ours: "申请执行人", theirs: "被执行人" } },
  { cards: ["demand-lit", "demand-inhouse"], all: ["委托人", "发函方", "收函方", "相对方"], by: { ours: ["委托人", "发函方"], theirs: ["收函方", "相对方"] } },
  { cards: ["contract-draft"], all: ["甲方", "乙方", "丙方", "丁方"], by: { ours: ["甲方", "乙方"], theirs: ["乙方", "甲方"], third: ["丙方", "丁方"], other: ["丙方", "丁方"] } },
  { cards: ["corporate-resolutions"], all: ["公司", "股东", "董事", "监事"], by: { ours: ["公司"], theirs: ["股东"] } },
];
const ROLE_DEFAULT = ["原告", "被告", "第三人", "上诉人", "被上诉人", "申请人", "被申请人", "申请执行人", "被执行人", "甲方", "乙方"];

/** 称谓建议：这一方常用的排前面，其余是这张卡的其他称谓；没有卡（事项概览）时给通用的一组。纯函数。 */
export function roleSuggestions(cardId: string | null | undefined, side: PartySide): string[] {
  const set = ROLE_SETS.find((s) => cardId && s.cards.includes(cardId));
  if (!set) return [...ROLE_DEFAULT];
  return [...new Set([...(set.by?.[side] ?? []), ...set.all])];
}

/** 代理人的称呼：仲裁（含劳动仲裁）与非诉卡写“委托代理人”，诉讼卡写“委托诉讼代理人”；没有卡时沿用材料里的写法。纯函数。 */
export function agentLabelFor(cardId: string | null | undefined, text?: string | null): AgentLabel {
  if (cardId) return ["arbitration-app", "labor-arb-application", "labor-arb-defense-lit", "labor-arb-defense", "demand-lit", "demand-inhouse", "contract-draft", "corporate-resolutions"].includes(cardId) ? "委托代理人" : "委托诉讼代理人";
  return agentLabelIn(text) ?? "委托诉讼代理人";
}

/** 没有材料时的初始表单：我方 = 客户，对方 = 相对方（顿号分隔的逐个列出）；名称用事项已有的名称预填；称谓按这张卡确定的诉讼地位或立场预填。纯函数。 */
export function initialParties(m: { client_name?: string | null; counterparty?: string | null; stance?: string | null }, cardId?: string | null): PartyEntry[] {
  const card = ROLE_SETS.find((s) => cardId && s.cards.includes(cardId))?.prefill;
  const r = card ?? rolesFor(m.stance);
  const guess = (name: string): PartyKind => {
    if (/合伙|个人独资|分公司|分行|支行|分所|办事处|分厂|营业部/.test(name)) return "other_org";
    return name && !/公司|集团|企业|中心|合作社|事务所|银行|学校|医院|委员会|政府|局$|厂$|店$|部$/.test(name) && [...name].length <= 4 ? "person" : "org";
  };
  const ours = clean(m.client_name ?? "");
  const theirs = clean(m.counterparty ?? "").split(/[、，,；;]/).map((s) => s.trim()).filter(Boolean);
  return [blankParty("ours", guess(ours), ours, r.ours), ...(theirs.length > 0 ? theirs : [""]).map((n) => blankParty("theirs", guess(n), n, r.theirs))];
}

/** 摘要：每方一行（名称 · 已填几项）。纯函数。 */
export function partiesSummary(list: readonly PartyEntry[]): { side: string; name: string; filled: number }[] {
  return list.filter((p) => !isBlankParty(p)).map((p) => ({ side: PARTY_SIDE_LABELS[p.side], name: clean(p.name) || "（未写名称）", filled: filledCount(p) }));
}

export interface PartyDigest {
  /** 称谓；没写时用“我方 / 对方……”。 */
  role: string;
  side: string;
  name: string;
  kind: string;
  filled: number;
  expected: number;
  missing: string[];
  agents: { name: string; note: string }[];
}

/** 开始面板与事项概览的当事人清单：称谓 · 名称 · 类型、首部常用事项完成度、代理人。纯函数。 */
export function partiesDigest(list: readonly PartyEntry[]): PartyDigest[] {
  return list
    .filter((p) => !isBlankParty(p))
    .map((p) => ({
      role: clean(p.role) || PARTY_SIDE_LABELS[p.side],
      side: PARTY_SIDE_LABELS[p.side],
      name: clean(p.name) || "（未写名称）",
      kind: PARTY_KIND_LABELS[p.kind],
      ...partyCompleteness(p),
      agents: namedAgents(p).map((a) => ({ name: clean(a.name), note: agentNote(a) })),
    }));
}

/** 代理人一行：“委托诉讼代理人：张三（北京某某律师事务所）、李四（律师）”；没有为空串。纯函数。 */
export function agentsLine(agents: readonly { name: string; note: string }[], label: AgentLabel = "委托诉讼代理人"): string {
  return agents.length ? `${label}：${agents.map((a) => `${a.name}（${a.note}）`).join("、")}` : "";
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
