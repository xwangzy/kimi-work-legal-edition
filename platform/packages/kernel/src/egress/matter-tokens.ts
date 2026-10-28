/**
 * 事项令牌存储（v9 第 02 篇 §8.3–§8.4：令牌化工作区；第 04 篇 §5.1）：
 *
 * - 每事项一把令牌密钥（32 字节随机，账本页级加密保存）；代号 = 类别 + HMAC 短编号（@zr-legal/tokenizer），跨轮、跨子 Agent、跨会话稳定；
 * - 事项令牌表只增不改（代号 → 首次出现的原文写法）；表的行序号即“令牌表版本”，闸门据此刷新缓存；
 * - 当事人词典 = 事项头（委托人、相对方）+ matter_parties（关联方、证人、别名）；
 * - 还原（restore）只给可信界面渲染与文书引擎导出；Agent、工作区、代码与模型上下文一律只见代号。
 */
import { deriveOrgAliases, extractDefinedAliases, isGenericAlias, MatterTokenizer, restoreTokens, type PartyEntry, type TokenEntry, type TokenizeOptions } from "@zr-legal/tokenizer";
import type { MatterEgressContext } from "@zr-legal/egress-gate";
import type { KernelDb } from "../db.ts";
import { dataLevelOf, headerPartyKind, newMatterTokenKey, partiesFromMatter } from "./gate-host.ts";

interface MatterRow {
  tenant_id: string;
  client_name: string | null;
  counterparty: string | null;
  confidentiality: string;
  full_pseudonym: number;
}

interface TokenRow {
  seq: number;
  token: string;
  category: TokenEntry["category"];
  value: string;
  normalized: string;
  source: TokenEntry["source"];
}

export class MatterTokenStore {
  private readonly db: KernelDb;

  constructor(db: KernelDb) {
    this.db = db;
  }

  private matter(matterId: string): MatterRow {
    const m = this.db.get<MatterRow>(`SELECT tenant_id, client_name, counterparty, confidentiality, full_pseudonym FROM matters WHERE matter_id = ?`, [matterId]);
    if (!m) throw new Error(`事项不存在：${matterId}`);
    return m;
  }

  /** 事项令牌密钥（首次使用时生成；之后不变——代号稳定的前提）。 */
  keyFor(matterId: string): Buffer {
    const row = this.db.get<{ key_b64: string }>(`SELECT key_b64 FROM matter_token_keys WHERE matter_id = ?`, [matterId]);
    if (row) return Buffer.from(row.key_b64, "base64");
    const m = this.matter(matterId);
    const key = newMatterTokenKey();
    // 并发首用：只有第一条生效，随后重读
    this.db.run(`INSERT OR IGNORE INTO matter_token_keys (matter_id, tenant_id, key_b64) VALUES (?,?,?)`, [matterId, m.tenant_id, key.toString("base64")]);
    const again = this.db.get<{ key_b64: string }>(`SELECT key_b64 FROM matter_token_keys WHERE matter_id = ?`, [matterId])!;
    return Buffer.from(again.key_b64, "base64");
  }

  /**
   * 当事人词典：事项头 + 词典表。别名 = 律师确认的 + 学得待确认的（待确认的照常参与匹配，偏向召回；复核 S4-20）；
   * 律师停用的写法（自动派生的字号、驳回的学得别名）不参与。
   */
  parties(matterId: string): PartyEntry[] {
    const m = this.matter(matterId);
    const extra = this.dictRows(matterId).map((r) => {
      const excluded = new Set(safeList(r.excluded_aliases));
      const aliases = [...safeList(r.aliases), ...safeList(r.learned_aliases)].filter((a) => !excluded.has(a));
      return { name: r.name, kind: r.kind, aliases: [...new Set(aliases)], exclude: [...excluded] };
    });
    return partiesFromMatter(m, extra);
  }

  private dictRows(matterId: string): DictRow[] {
    return this.db.all<DictRow>(
      `SELECT name, kind, aliases, learned_aliases, excluded_aliases, role FROM matter_parties WHERE matter_id = ? ORDER BY created_at`,
      [matterId],
    );
  }

  /** 全部化名：L3a 强制；其余按事项开关。 */
  fullPseudonym(matterId: string): boolean {
    const m = this.matter(matterId);
    return dataLevelOf(m.confidentiality) === "L3a" || m.full_pseudonym === 1;
  }

  private rows(matterId: string): TokenRow[] {
    return this.db.all<TokenRow>(`SELECT seq, token, category, value, normalized, source FROM matter_tokens WHERE matter_id = ? ORDER BY seq`, [matterId]);
  }

  table(matterId: string): TokenEntry[] {
    return this.rows(matterId).map(({ token, category, value, normalized, source }) => ({ token, category, value, normalized, source }));
  }

  /** 令牌表版本（单调递增：最大行序号；空表为 0）。 */
  tableVersion(matterId: string): number {
    return this.db.get<{ v: number | null }>(`SELECT MAX(seq) AS v FROM matter_tokens WHERE matter_id = ?`, [matterId])?.v ?? 0;
  }

  /** 闸门的令牌化上下文（authorize 时下发；密钥材料只到闸门进程为止）。 */
  gateContext(matterId: string): MatterEgressContext["tokenizer"] {
    return {
      keyB64: this.keyFor(matterId).toString("base64"),
      parties: this.parties(matterId),
      table: this.table(matterId),
      fullPseudonym: this.fullPseudonym(matterId),
      tableVersion: this.tableVersion(matterId),
    };
  }

  /** 内核侧令牌化器（A1 材料快照与目标的令牌化视图）。用完调用 persist 把新条目写回。 */
  tokenizer(matterId: string): MatterTokenizer {
    // 案号与机构名称同一条件（L3a 或全部化名）令牌化：审计 P1-3，案号可在裁判文书网反查当事人
    const full = this.fullPseudonym(matterId);
    return new MatterTokenizer({ matterKey: this.keyFor(matterId), parties: this.parties(matterId), table: this.table(matterId), fullPseudonym: full, caseNumbers: full });
  }

  /**
   * 写回新条目（只增：同一代号或同一“类别+规范化值”已存在即跳过）。条目须属于本事项密钥：
   * 代号由 HMAC 派生，内核按同一密钥重算校验——外来条目（例如被篡改的闸门消息）不能把任意代号映射到任意原文。
   */
  persist(matterId: string, entries: readonly TokenEntry[]): number {
    if (entries.length === 0) return 0;
    const check = new MatterTokenizer({ matterKey: this.keyFor(matterId), table: this.table(matterId) });
    let added = 0;
    let conflicts = 0;
    this.db.tx(() => {
      for (const e of entries) {
        if (!e || typeof e.token !== "string" || typeof e.value !== "string" || typeof e.category !== "string") continue;
        const expect = check.tokenFor(e.category, e.value, e.source);
        if (expect.token !== e.token) {
          // 分叉（审查 S4-08）：闸门已用 e.token 指代 e.value 发出，而内核表里该代号（或该值）另有所指——登记为冲突代号，
          // 此后一律不还原（不会还原成另一个值）；递增策略版本让闸门重建令牌化器
          if (/^〔.+·[0-9A-Z]+〕$/.test(e.token)) {
            conflicts += this.db.run(`INSERT OR IGNORE INTO matter_token_conflicts (matter_id, token) VALUES (?,?)`, [matterId, e.token]).changes;
          }
          continue;
        }
        const r = this.db.run(
          `INSERT OR IGNORE INTO matter_tokens (matter_id, token, category, value, normalized, source) VALUES (?,?,?,?,?,?)`,
          [matterId, expect.token, expect.category, expect.value, expect.normalized, String(e.source ?? "pattern")],
        );
        added += r.changes;
      }
      if (conflicts > 0) this.db.run(`UPDATE matters SET policy_version = policy_version + 1 WHERE matter_id = ?`, [matterId]);
    });
    return added;
  }

  /** 冲突代号（审查 S4-08）：不得还原。 */
  conflicts(matterId: string): Set<string> {
    return new Set(this.db.all<{ token: string }>(`SELECT token FROM matter_token_conflicts WHERE matter_id = ?`, [matterId]).map((r) => r.token));
  }

  /** 令牌化一段文本并写回新条目（内核侧调用的便捷形式）。 */
  tokenize(matterId: string, text: string, o: TokenizeOptions = {}): { text: string; replaced: number; counts: Partial<Record<TokenEntry["category"], number>> } {
    const [r] = this.tokenizeAll(matterId, [text], o);
    return r!;
  }

  /** 预跑（发送前“将发送什么”与发送视图，v9.2 §3.3）：与出站同一套令牌化器，不写回令牌表、不出站。 */
  preview(matterId: string, texts: readonly string[]): { text: string; replaced: number; counts: Partial<Record<TokenEntry["category"], number>> }[] {
    const tz = this.tokenizer(matterId);
    return texts.map((t) => {
      const r = tz.tokenize(t);
      return { text: r.text, replaced: r.replaced, counts: r.counts };
    });
  }

  /** 批量令牌化（同一令牌化器，跨文本稳定）并一次写回新条目。`knownOnly`：模型写的文字只替换已知名单（D-157）。 */
  tokenizeAll(matterId: string, texts: readonly string[], o: TokenizeOptions = {}): { text: string; replaced: number; counts: Partial<Record<TokenEntry["category"], number>> }[] {
    const tz = this.tokenizer(matterId);
    const before = new Set(tz.table().map((e) => e.token));
    const out = texts.map((t) => {
      const r = tz.tokenize(t, o);
      return { text: r.text, replaced: r.replaced, counts: r.counts };
    });
    this.persist(matterId, tz.table().filter((e) => !before.has(e.token)));
    return out;
  }

  /** 还原（只给可信界面渲染与文书引擎导出）；冲突代号不还原，按“未知”报告（零错名：宁可不还原，不还原成另一个值）。 */
  restore(matterId: string, text: string): { text: string; restored: number; unknown: string[] } {
    const blocked = this.conflicts(matterId);
    return restoreTokens(text, blocked.size === 0 ? this.table(matterId) : this.table(matterId).filter((e) => !blocked.has(e.token)));
  }

  /** 当事人词典维护（事项负责人；L3a 事项须人工核对词典）。 */
  upsertParty(matterId: string, p: { name: string; kind: "person" | "org"; aliases?: readonly string[]; role?: string | null }, by: string): void {
    const name = String(p.name ?? "").trim();
    if (name.length < 2 || name.length > 64) throw new Error("当事人名称须为 2–64 字");
    if (p.kind !== "person" && p.kind !== "org") throw new Error("当事人类型须为 person 或 org");
    const aliases = [...new Set((p.aliases ?? []).map((a) => String(a).trim()).filter((a) => a.length >= 2 && a.length <= 64))].slice(0, 20);
    // 常用词与泛称不能作别名（复核 S4-20：“本人”“张某”“明天”会在全部材料中误替换、使一般性检索被误拒）
    const generic = aliases.filter((a) => isGenericAlias(a));
    if (generic.length > 0) throw new Error(`以下写法是常用词或泛称，不能作为别名：${generic.join("、")}`);
    this.matter(matterId);
    this.db.run(
      `INSERT INTO matter_parties (matter_id, name, kind, aliases, role, added_by) VALUES (?,?,?,?,?,?)
       ON CONFLICT (matter_id, name) DO UPDATE SET kind = excluded.kind, aliases = excluded.aliases, role = excluded.role`,
      [matterId, name, p.kind, JSON.stringify(aliases), p.role ?? null, by],
    );
    // 律师明确写入的别名不再是“待确认”
    const row = this.db.get<{ learned_aliases: string }>(`SELECT learned_aliases FROM matter_parties WHERE matter_id = ? AND name = ?`, [matterId, name]);
    if (row) {
      const learned = safeList(row.learned_aliases).filter((a) => !aliases.includes(a));
      this.db.run(`UPDATE matter_parties SET learned_aliases = ? WHERE matter_id = ? AND name = ?`, [JSON.stringify(learned), matterId, name]);
    }
  }

  /**
   * 别名的人工处置（复核 S4-20；界面 W1 的词典页）：
   * confirm = 学得的别名转为确认；reject = 驳回学得的别名或停用自动派生的字号（此后不再学回、不参与匹配）；restore = 撤销停用。
   * 事项头里的当事人在词典中没有行时自动建行（以词典为准）。返回是否有变化。
   */
  aliasAction(matterId: string, name: string, alias: string, action: "confirm" | "reject" | "restore", by: string): boolean {
    const n = String(name ?? "").trim();
    const a = String(alias ?? "").trim();
    if (!n || !a) throw new Error("缺少当事人或别名");
    const listed = this.listParties(matterId).find((p) => p.name === n);
    if (!listed) throw new Error(`当事人不存在：${n}`);
    let row = this.db.get<DictRow>(`SELECT name, kind, aliases, learned_aliases, excluded_aliases, role FROM matter_parties WHERE matter_id = ? AND name = ?`, [matterId, n]);
    if (!row) {
      this.db.run(`INSERT INTO matter_parties (matter_id, name, kind, aliases, role, added_by) VALUES (?,?,?,?,?,?)`, [matterId, n, listed.kind, "[]", "事项头", by]);
      row = this.db.get<DictRow>(`SELECT name, kind, aliases, learned_aliases, excluded_aliases, role FROM matter_parties WHERE matter_id = ? AND name = ?`, [matterId, n])!;
    }
    const aliases = new Set(safeList(row.aliases));
    const learned = new Set(safeList(row.learned_aliases));
    const excluded = new Set(safeList(row.excluded_aliases));
    const before = JSON.stringify([...aliases, "|", ...learned, "|", ...excluded]);
    if (action === "confirm") {
      if (!learned.has(a)) throw new Error("只能确认学得的别名");
      learned.delete(a);
      aliases.add(a);
    } else if (action === "reject") {
      aliases.delete(a);
      learned.delete(a);
      excluded.add(a);
    } else {
      excluded.delete(a);
    }
    if (JSON.stringify([...aliases, "|", ...learned, "|", ...excluded]) === before) return false;
    this.db.run(`UPDATE matter_parties SET aliases = ?, learned_aliases = ?, excluded_aliases = ? WHERE matter_id = ? AND name = ?`, [
      JSON.stringify([...aliases]),
      JSON.stringify([...learned]),
      JSON.stringify([...excluded].slice(0, 50)),
      matterId,
      n,
    ]);
    return true;
  }

  /**
   * 从材料中学习当事人简称（审查 S4-02）：“全称（以下简称“X”）”中的全称是已知当事人时，X 作为别名写入词典；
   * 有新增即递增事项策略版本（闸门据此重建令牌化器）。返回新增的别名数。
   */
  learnAliases(matterId: string, texts: readonly string[], by: string): number {
    const parties = this.parties(matterId);
    const names = [...new Set(parties.map((p) => p.name))];
    if (names.length === 0) return 0;
    const found = texts.flatMap((t) => extractDefinedAliases(t, names));
    if (found.length === 0) return 0;
    let added = 0;
    this.db.tx(() => {
      for (const { name, alias } of found) {
        const kind = parties.find((p) => p.name === name)?.kind ?? "org";
        const row = this.db.get<DictRow>(`SELECT name, kind, aliases, learned_aliases, excluded_aliases, role FROM matter_parties WHERE matter_id = ? AND name = ?`, [matterId, name]);
        const confirmed = row ? safeList(row.aliases) : [];
        const learned = row ? safeList(row.learned_aliases) : [];
        const excluded = row ? safeList(row.excluded_aliases) : [];
        // 已确认、已学得或被律师驳回的写法都不再写入（复核 S4-20：学得的别名标“待确认”，界面提示律师确认）
        if (confirmed.includes(alias) || learned.includes(alias) || excluded.includes(alias)) continue;
        const next = [...learned, alias].slice(0, 20);
        if (row) this.db.run(`UPDATE matter_parties SET learned_aliases = ? WHERE matter_id = ? AND name = ?`, [JSON.stringify(next), matterId, name]);
        else {
          this.db.run(`INSERT INTO matter_parties (matter_id, name, kind, aliases, learned_aliases, role, added_by) VALUES (?,?,?,?,?,?,?)`, [
            matterId,
            name,
            kind,
            "[]",
            JSON.stringify(next),
            "材料中的简称定义",
            by,
          ]);
        }
        added += 1;
      }
      if (added > 0) this.db.run(`UPDATE matters SET policy_version = policy_version + 1 WHERE matter_id = ?`, [matterId]);
    });
    return added;
  }

  removeParty(matterId: string, name: string): boolean {
    return this.db.run(`DELETE FROM matter_parties WHERE matter_id = ? AND name = ?`, [matterId, String(name)]).changes > 0;
  }

  /**
   * 词典视图（界面 W1）：确认的别名、学得待确认的别名、自动派生的字号（机构）与律师停用的写法分别列出。
   * 事项头里的当事人若在词典中另有行，只列一次（以词典为准）。
   */
  listParties(matterId: string): PartyView[] {
    const m = this.matter(matterId);
    const dict = this.dictRows(matterId).map((r): PartyView => {
      const excluded = safeList(r.excluded_aliases);
      return {
        name: r.name,
        kind: r.kind,
        aliases: safeList(r.aliases),
        learned: safeList(r.learned_aliases).filter((a) => !excluded.includes(a)),
        derived: r.kind === "org" ? deriveOrgAliases(r.name).filter((d) => !excluded.includes(d)) : [],
        excluded,
        role: r.role,
        source: "dictionary",
      };
    });
    const names = new Set(dict.map((p) => p.name));
    const header: PartyView[] = partiesFromMatter(m)
      .filter((p) => !names.has(p.name))
      .map((p) => ({
        name: p.name,
        kind: headerPartyKind(p.name),
        aliases: [],
        learned: [],
        derived: headerPartyKind(p.name) === "org" ? deriveOrgAliases(p.name) : [],
        excluded: [],
        role: null,
        source: "matter_header",
      }));
    return [...header, ...dict];
  }

  /** 文本中命中的本事项当事人（无事项问答的当事人词典检查用；容忍写法变体）。 */
  partiesIn(matterId: string, text: string): string[] {
    const t = new MatterTokenizer({ matterKey: this.keyFor(matterId), parties: this.parties(matterId) });
    return [...new Set(t.findParties(text).map((h) => h.value))];
  }

  /** 这个事项当事人（含简称、别名）的查找器：返回文本里命中的位置（本所范本库放入时查客户信息用；一个事项只建一次，复核 Q6-11）。 */
  partyFinder(matterId: string): (text: string) => { start: number; end: number }[] {
    const t = new MatterTokenizer({ matterKey: this.keyFor(matterId), parties: this.parties(matterId) });
    return (text) => t.findParties(text).map((h) => ({ start: h.start, end: h.end }));
  }
}

interface DictRow {
  name: string;
  kind: "person" | "org";
  aliases: string;
  learned_aliases: string;
  excluded_aliases: string;
  role: string | null;
}

export interface PartyView {
  name: string;
  kind: "person" | "org";
  /** 律师确认的别名。 */
  aliases: string[];
  /** 从材料“以下简称”学得、待律师确认的别名（照常参与匹配）。 */
  learned: string[];
  /** 机构名称自动派生的字号别名（未停用的）。 */
  derived: string[];
  /** 律师停用或驳回的写法。 */
  excluded: string[];
  role: string | null;
  source: "matter_header" | "dictionary";
}

function safeList(s: string): string[] {
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
