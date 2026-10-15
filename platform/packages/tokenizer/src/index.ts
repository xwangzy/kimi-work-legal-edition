/**
 * @zr-legal/tokenizer —— 令牌化工作区的核心（v9 第 02 篇 §8.3–§8.4；第 04 篇 §5.1、§11 P6）。
 *
 * 一条统一规则：**令牌只在两个地方还原——界面渲染层与可信文书引擎的导出；Agent、工作区、代码与模型上下文一律只见令牌。**
 *
 * - 范围：证件、账户与联系方式类标识符（身份证/护照号、手机号与座机、银行卡与账号、统一社会信用代码、详细住址、车牌、邮箱）
 *   与**自然人姓名**默认替换；**机构名称默认保留**（L3a 或事项开启“全部化名”时也替换）；
 * - 覆盖扩展（审计 P1-3，2026-10-13）：出生日期（只认有上下文的写法）、带提示词的个人编号（社保/医保号、病历号、住院号、
 *   门诊号、工号、学号、档案号 → 证件号；微信号、QQ 号 → 账号）、无门牌的村组地址与“小区名 + 楼栋”、音译名（含“·”）、
 *   角色词后的拉丁字母姓名、昵称与职务称呼（只在姓氏属于已知自然人时）——默认开启，律师无感；
 * - 案号（〔案号·……〕）：**L3a 或全部化名时开启**（选项 `caseNumbers`，缺省 false）——审计 P1-3：案号可在裁判文书网反查当事人；
 *   L2 默认保留以免损害法律研究（检索类案、引用判例需要案号原文）。内核与闸门按“全部化名”同一条件传入；
 * - 确定性：代号 = 类别 + HMAC-SHA256(事项令牌密钥, 类别 ‖ 规范化值) 的短编号（Crockford base32 6 位），跨轮、跨子 Agent、
 *   跨会话稳定——保证 reasoning_content 原样回传与前缀缓存命中；同一值的不同写法（空格、+86、全角）得到同一代号；
 * - 冲突：不同值得到同一短编号时，后出现的值改用 10 位编号并记入事项令牌表（表随事项持久化后，冲突处理也稳定）；
 * - 幂等：已有的代号不再识别；对已令牌化的文本再做一次令牌化不改变内容；
 * - 自然人姓名靠当事人词典 + 规则识别（names.ts），**漏识别的姓名仍会出站**——漏识别率在合成测试集上如实报告；
 * - 令牌化降低风险，但不构成匿名化（第 02 篇 §8.3 末段）。
 */
import { createHmac, hkdfSync } from "node:crypto";
import { findNicknames, matchDictionary, matcherFor, nicknameSurname, recognizeNames, surnameOf } from "./names.ts";
import { deriveOrgAliases, isGenericAlias, softenBreaks } from "./variants.ts";
import { findIdentifiers, foldWidth, normalizeValue, type Hit, type IdentifierOptions } from "./patterns.ts";

export { idCardValid, luhnValid, findIdentifiers, foldWidth, normalizeValue, type IdentifierOptions } from "./patterns.ts";
export { findNicknames, nicknameSurname, recognizeNames } from "./names.ts";
export { suspectCounts, suspectedNames, type SuspectConfidence, type SuspectCue, type SuspectedName } from "./candidates.ts";
export { deriveOrgAliases, extractDefinedAliases, foldText, foldWithMap, FOLD_VERSION, isGenericAlias, shapeFold, VariantMatcher } from "./variants.ts";

export type TokenCategory = "person" | "org" | "id_number" | "phone" | "account" | "uscc" | "address" | "plate" | "email" | "case_no" | "birth_date";

export const CATEGORY_LABEL: Readonly<Record<TokenCategory, string>> = Object.freeze({
  person: "自然人",
  org: "机构",
  id_number: "证件号",
  phone: "电话",
  account: "账号",
  uscc: "信用代码",
  address: "地址",
  plate: "车牌",
  email: "邮箱",
  case_no: "案号",
  birth_date: "出生日期",
});

const LABEL_TO_CATEGORY = new Map(Object.entries(CATEGORY_LABEL).map(([k, v]) => [v, k as TokenCategory]));

/** 代号的形态：〔自然人·K7Q2MX〕（6 位）或冲突时的 10 位。 */
export const TOKEN_RE = /〔(自然人|机构|证件号|电话|账号|信用代码|地址|车牌|邮箱|案号|出生日期)·([0-9A-HJKMNP-TV-Z]{6}|[0-9A-HJKMNP-TV-Z]{10})〕/g;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function base32(bytes: Buffer, chars: number): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5 && out.length < chars) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length >= chars) break;
    value &= (1 << bits) - 1;
  }
  return out;
}

/** 当事人词典条目（事项头：当事人与关联方；自然人默认令牌化，机构只在全部化名时令牌化）。 */
export interface PartyEntry {
  name: string;
  kind: "person" | "org";
  aliases?: readonly string[];
  /** 律师停用的自动派生字号别名（复核 S4-20：常用词形态的字号由律师在词典中停用）。 */
  exclude?: readonly string[];
}

export interface TokenEntry {
  token: string;
  category: TokenCategory;
  /** 首次出现时的原文写法（还原用）。 */
  value: string;
  normalized: string;
  source: Hit["source"];
}

export interface TokenizeResult {
  text: string;
  /** 本次替换涉及的条目（去重）。 */
  entries: TokenEntry[];
  /** 按类别的替换次数。 */
  counts: Partial<Record<TokenCategory, number>>;
  replaced: number;
  /** 本次替换的原文区间（输入坐标；评测按区间判定已替换、部分替换与过度替换，复核 B4-R02）。 */
  spans: { start: number; end: number; category: TokenCategory; token: string }[];
}

export interface MatterTokenizerOptions {
  /** 事项密钥材料（≥ 16 字节）；经 HKDF 派生令牌密钥，原密钥不直接参与 HMAC。 */
  matterKey: Uint8Array;
  parties?: readonly PartyEntry[];
  /** 全部化名（L3a 强制；L2 可由律所或事项负责人开启）：机构名称也替换。 */
  fullPseudonym?: boolean;
  /** 规则识别自然人姓名（默认开）。 */
  recognizeNames?: boolean;
  /** 事项令牌表（持久化后传回：保证冲突处理与识别出的姓名跨文本稳定）。 */
  table?: readonly TokenEntry[];
  /**
   * 案号令牌化（缺省 false）。L3a 或全部化名时开启（审计 P1-3：案号可在裁判文书网反查当事人；L2 默认保留以免损害法律研究）。
   * 接线：内核 `MatterTokenStore.tokenizer()` 与闸门 `tokenizerFor()` 均按 `fullPseudonym` 传入。
   */
  caseNumbers?: boolean;
}

export class MatterTokenizer {
  private readonly key: Buffer;
  private readonly fullPseudonym: boolean;
  private readonly recognize: boolean;
  private readonly caseNumbers: boolean;
  private readonly parties: { value: string; category: "person" | "org" }[] = [];
  /** 类别 ‖ 规范化值 → 条目。 */
  private readonly byValue = new Map<string, TokenEntry>();
  /** 代号 → 条目（冲突检测与还原）。 */
  private readonly byToken = new Map<string, TokenEntry>();

  constructor(o: MatterTokenizerOptions) {
    if (!o.matterKey || o.matterKey.byteLength < 16) throw new Error("事项令牌密钥至少 16 字节");
    this.key = Buffer.from(hkdfSync("sha256", o.matterKey, Buffer.from("kwl-tokenizer"), Buffer.from("kwl-tokenizer-v1"), 32));
    this.fullPseudonym = o.fullPseudonym ?? false;
    this.recognize = o.recognizeNames ?? true;
    this.caseNumbers = o.caseNumbers ?? false;
    for (const p of o.parties ?? []) {
      // 机构名称自动派生字号别名（审查 S4-02：Agent 与律师常用简称写检索式与 URL）
      const excluded = new Set((p.exclude ?? []).map((x) => x.trim()));
      const derived = p.kind === "org" ? deriveOrgAliases(p.name).filter((d) => !excluded.has(d)) : [];
      // 常用词形态的别名（“本人”“张某”“明天”）一律不用（复核 S4-20；含此前学得、已存入词典的）
      const aliases = (p.aliases ?? []).filter((a) => !isGenericAlias(a));
      for (const n of [p.name, ...aliases, ...derived]) {
        const v = n.trim();
        if (v.length >= 2 && !this.parties.some((x) => x.value === v)) this.parties.push({ value: v, category: p.kind });
      }
    }
    for (const e of o.table ?? []) this.remember(e);
  }

  /**
   * 释放（闸门逐出空闲令牌化器时调用；Y5 P1-12）：派生的令牌密钥清零，当事人词典与令牌表清空。之后不得再用于令牌化。
   */
  dispose(): void {
    this.key.fill(0);
    this.parties.length = 0;
    this.byValue.clear();
    this.byToken.clear();
    this.disposed = true;
  }
  private disposed = false;

  private remember(e: TokenEntry): void {
    // 只按**现行规则**的规范值建索引（终核 S4-26）：旧规则（FOLD_VERSION 2，含繁转简）存下的条目不再以旧规范值命中——
    // 否则“于明”会拿到“於明”的旧代号、还原成另一个人。同一值的代号跨版本不变（按现行规范值仍指向既有条目）。
    const current = `${e.category}\u0000${normalizeValue(e.category, e.value)}`;
    if (!this.byValue.has(current)) this.byValue.set(current, e);
    this.byToken.set(e.token, e);
  }

  /** 某个值的代号（确定性；首次出现时登记）。 */
  tokenFor(category: TokenCategory, value: string, source: Hit["source"] = "pattern"): TokenEntry {
    const normalized = normalizeValue(category, value);
    const k = `${category}\u0000${normalized}`;
    const known = this.byValue.get(k);
    if (known) return known;
    const mac = createHmac("sha256", this.key).update(k).digest();
    let token = `〔${CATEGORY_LABEL[category]}·${base32(mac, 6)}〕`;
    // 冲突按现行规范值判定（终核 S4-26：旧规则条目的存储规范值可能与另一个字形的现行规范值相同）
    const clash = this.byToken.get(token);
    if (clash && normalizeValue(clash.category, clash.value) !== normalized) token = `〔${CATEGORY_LABEL[category]}·${base32(mac, 10)}〕`;
    const e: TokenEntry = { token, category, value, normalized, source };
    this.remember(e);
    return e;
  }

  /** 事项令牌表（持久化用；含值，只能存在律所侧并以事项密钥加密）。 */
  table(): TokenEntry[] {
    return [...this.byToken.values()];
  }

  /** 当事人词典中的全部名称与别名（自然人与机构，含机构字号别名；检索与 URL 的实体检查用）。 */
  partyNames(): string[] {
    return [...new Set(this.parties.map((p) => p.value))];
  }

  /**
   * 文本中的当事人（容忍写法变体：全角、繁体、插入空白与零宽字符、机构字号别名；审查 S4-02）。
   * 返回不重叠的命中（长者优先），value 为词典写法。检索与 URL 的实体检查用（与是否全部化名无关）。
   */
  findParties(text: string): { start: number; end: number; value: string; category: "person" | "org" }[] {
    const cat = new Map(this.parties.map((p) => [p.value, p.category] as const));
    // 筛查：换行与制表在这里也算插入字符（位置不变；终核 S4-23 只对材料令牌化设硬边界）
    return matcherFor(this.parties.map((p) => p.value))
      .find(softenBreaks(text))
      .map((m) => ({ ...m, category: cat.get(m.value) ?? "org" }));
  }

  /** 已知的自然人姓名（词典 + 历次识别）。 */
  knownPersons(): string[] {
    const s = new Set(this.parties.filter((p) => p.category === "person").map((p) => p.value));
    for (const e of this.byValue.values()) if (e.category === "person") s.add(e.value);
    return [...s];
  }

  tokenize(text: string): TokenizeResult {
    // 已释放的令牌化器密钥已清零：继续使用会产生错误的代号（失败关闭）
    if (this.disposed) throw new Error("令牌化器已释放");
    if (typeof text !== "string" || text.length === 0) return { text: text ?? "", entries: [], counts: {}, replaced: 0, spans: [] };
    // 已有代号的区间不再识别（幂等）
    const skip: { start: number; end: number }[] = [];
    TOKEN_RE.lastIndex = 0;
    for (const m of text.matchAll(TOKEN_RE)) skip.push({ start: m.index!, end: m.index! + m[0].length });

    const taken = [...skip];
    const hits: Hit[] = [];
    // 1) 标识符（结构化，优先）
    for (const h of findIdentifiers(text, skip, { caseNumbers: this.caseNumbers })) {
      hits.push(h);
      taken.push({ start: h.start, end: h.end });
    }
    // 2) 词典：当事人 + 令牌表中已知的自然人（与机构，全部化名时）
    const dict: { value: string; category: "person" | "org" }[] = [];
    // 令牌表里昵称形态的条目（“王总”“老王”）不做全文词典匹配——否则“王总”会命中“王总监”的前两字；它们由第 4 步按边界规则重新识别，
    // 代号按值确定，与表中既有条目一致。律师在词典里明确登记的别名（如“孙总”）仍按词典匹配。
    const surnames = new Set<string>();
    const nickAllowed = new Set<string>();
    for (const p of this.parties) if (p.category === "person" || this.fullPseudonym) dict.push(p);
    for (const e of this.byValue.values()) {
      if (e.category === "person" && nicknameSurname(e.value) !== null) continue;
      if (e.category === "person" || (e.category === "org" && this.fullPseudonym)) dict.push({ value: e.value, category: e.category });
    }
    for (const p of this.parties) if (p.category === "person") addSurname(surnames, nickAllowed, p.value);
    for (const e of this.byValue.values()) if (e.category === "person") addSurname(surnames, nickAllowed, e.value);
    hits.push(...matchDictionary(text, dict, taken, "dictionary"));
    // 3) 规则识别的自然人姓名（本段识别出的姓名全文再匹配；昵称形态的交给第 4 步）
    if (this.recognize) {
      const masked = maskRanges(foldWidth(text), taken);
      const found = [...recognizeNames(masked)].filter((n) => !dict.some((d) => d.value === n));
      for (const n of found) addSurname(surnames, nickAllowed, n);
      const names = found.filter((n) => nicknameSurname(n) === null);
      hits.push(...matchDictionary(text, names.map((value) => ({ value, category: "person" as const })), taken, "recognizer"));
      // 4) 昵称与职务称呼（老王、小李、王总、李工、陈经理……）：只在姓氏属于已知自然人（词典、令牌表、本段识别）时识别
      if (surnames.size > 0 || nickAllowed.size > 0) {
        const masked2 = maskRanges(foldWidth(text), taken);
        for (const n of findNicknames(masked2, surnames, nickAllowed)) {
          if (taken.some((t) => n.start < t.end && n.end > t.start)) continue;
          hits.push({ category: "person", start: n.start, end: n.end, value: text.slice(n.start, n.end), source: "recognizer" });
          taken.push({ start: n.start, end: n.end });
        }
      }
    }
    if (hits.length === 0) return { text, entries: [], counts: {}, replaced: 0, spans: [] };

    hits.sort((a, b) => a.start - b.start);
    const counts: Partial<Record<TokenCategory, number>> = {};
    const used = new Map<string, TokenEntry>();
    const spans: TokenizeResult["spans"] = [];
    let out = "";
    let at = 0;
    for (const h of hits) {
      if (h.start < at) continue; // 防御：不重叠由各步保证
      const e = this.tokenFor(h.category, h.value, h.source);
      out += text.slice(at, h.start) + e.token;
      spans.push({ start: h.start, end: h.end, category: h.category, token: e.token });
      at = h.end;
      counts[h.category] = (counts[h.category] ?? 0) + 1;
      used.set(e.token, e);
    }
    out += text.slice(at);
    const replaced = Object.values(counts).reduce((n, c) => n + (c ?? 0), 0);
    return { text: out, entries: [...used.values()], counts, replaced, spans };
  }
}

/**
 * 已知自然人的姓氏（昵称识别用）：中文全名取姓氏（须有名）；音译名与拉丁字母姓名不取。
 * 昵称形态的值（“王总”）不提供姓氏——只允许这个写法本身按边界规则再识别（避免“王总”一个昵称带出“老王/王总经理”）。
 */
function addSurname(out: Set<string>, nicknames: Set<string>, value: string): void {
  if (nicknameSurname(value) !== null) {
    nicknames.add(value.trim());
    return;
  }
  const s = surnameOf(value);
  if (s) out.add(s);
}

/** 把已占用的区间换成等长的全角空格（下标不变），供姓名识别在剩余文本上运行。 */
function maskRanges(text: string, ranges: readonly { start: number; end: number }[]): string {
  let out = text;
  for (const r of ranges) out = out.slice(0, r.start) + "　".repeat(r.end - r.start) + out.slice(r.end);
  return out;
}

/** 文本中的全部代号（去重，按出现顺序）。 */
export function findTokens(text: string): string[] {
  const seen = new Set<string>();
  TOKEN_RE.lastIndex = 0;
  for (const m of text.matchAll(TOKEN_RE)) seen.add(m[0]);
  return [...seen];
}

/** 文本中代号出现的次数（不去重；还原限量按它计，复核 B3-A16）。 */
export function countTokens(text: string): number {
  TOKEN_RE.lastIndex = 0;
  let n = 0;
  for (const _ of text.matchAll(TOKEN_RE)) n++;
  return n;
}

/** 代号的类别（不是代号返回 null）。 */
export function tokenCategory(token: string): TokenCategory | null {
  TOKEN_RE.lastIndex = 0;
  const m = TOKEN_RE.exec(token);
  TOKEN_RE.lastIndex = 0;
  return m && m[0] === token ? (LABEL_TO_CATEGORY.get(m[1]!) ?? null) : null;
}

/**
 * 还原（只给可信界面渲染与文书引擎导出）：代号 → 首次出现时的原文写法；未知代号保留原样并计数。
 */
export function restoreTokens(text: string, table: readonly TokenEntry[] | ReadonlyMap<string, string>): { text: string; restored: number; unknown: string[] } {
  const map: ReadonlyMap<string, string> = table instanceof Map ? table : new Map((table as readonly TokenEntry[]).map((e) => [e.token, e.value]));
  let restored = 0;
  const unknown = new Set<string>();
  TOKEN_RE.lastIndex = 0;
  const out = text.replace(TOKEN_RE, (tok) => {
    const v = map.get(tok);
    if (v === undefined) {
      unknown.add(tok);
      return tok;
    }
    restored += 1;
    return v;
  });
  return { text: out, restored, unknown: [...unknown] };
}

/** 出站前的残留检查（闸门第二道）：文本中仍未令牌化的标识符（不含姓名识别）。 */
export function residualIdentifiers(text: string, options: IdentifierOptions = {}): Hit[] {
  const skip: { start: number; end: number }[] = [];
  TOKEN_RE.lastIndex = 0;
  for (const m of text.matchAll(TOKEN_RE)) skip.push({ start: m.index!, end: m.index! + m[0].length });
  return findIdentifiers(text, skip, options);
}
