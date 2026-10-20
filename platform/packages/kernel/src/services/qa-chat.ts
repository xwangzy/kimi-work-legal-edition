/**
 * 无事项问答（v9 第 03 篇 §4.1 问答、第 02 篇 §9.3 Chat 模式与 §12、第 04 篇 §5.3）：
 *
 * - 不读任何事项材料；问题先做**本人可见事项的当事人词典检查**——命中当事人限制（L3b）事项的当事人即拦截；
 *   命中其他事项的当事人：拦截并给出“到事项中处理”的链接（方案为“提示”；事项内才有该事项的当事人词典、依据与审计规则——偏离 D-22）；
 * - 每个会话一把令牌密钥：问题中的证件、账户、联系方式与规则识别的自然人姓名在出站前替换为会话代号（闸门对请求体再做一次）；
 * - 经出站闸门发往法律模型网关（中软不保存问答内容）；**历史只在本机**（qa_* 表；界面显示时按会话令牌表还原）；
 * - 模型调用经注入的 ask（闸门 /q/<会话> 路由），本模块不含任何网络代码。
 */
import { localToday } from "./local-date.ts";
import { createHash, randomBytes } from "node:crypto";
import { MatterTokenizer, restoreTokens, type TokenEntry } from "@zr-legal/tokenizer";
import { newId } from "@zr-legal/domain";
import type { KernelDb } from "../db.ts";
import type { MatterTokenStore } from "../egress/matter-tokens.ts";
import { dataLevelOf } from "../egress/gate-host.ts";
import type { Lawdb } from "@zr-legal/lawdb";
import { checkArtifactCitations } from "./artifact-citations.ts";

export interface QaMessageView {
  message_id: string;
  role: "user" | "assistant" | "notice";
  text: string;
  created_at: string;
  /** 回答里的引用按本机法规库离线核对的结果（v9.3 第 15 批 B-6；评审 Z1 P1-5）；没有引用时不带。 */
  citations?: QaCitations;
}

export interface QaCitations {
  total: number;
  verified: number;
  wrong: number;
  outside: number;
  cases: number;
  items: { raw: string; kind: "wrong" | "case" | "outside" | "ok"; reason: string | null; partial?: boolean }[];
  /** 核到了、但只核到条号的条数（复核 R15B-05）。 */
  partial?: number;
  /** 写了“第X条”却没认出是哪部法的处数（复核 R15B-02）。 */
  unrecognized?: number;
  registry: string;
  as_of: string;
  /** 核对本身出错：界面说“没有核对成功，请自行核对”，不当成没有引用。 */
  unchecked?: boolean;
}

export interface QaBlocked {
  reason: "l3b_party" | "matter_party";
  message: string;
  matters?: { matter_id: string; title: string }[];
}

export interface QaAskInput {
  conversationId: string;
  tenantId: string;
  userId: string;
  /** 已令牌化的对话（系统提示 + 历史 + 本次问题）。 */
  messages: { role: "system" | "user" | "assistant"; content: string }[];
}

export interface QaDeps {
  db: KernelDb;
  tokens: MatterTokenStore;
  ask(input: QaAskInput): Promise<string>;
  /** 本机法规库：回答里的引用与签发门禁同一口径离线核对（只在本机，不出站）。 */
  lawdb?: Lawdb;
}

const SYSTEM_PROMPT = [
  "你是律师使用的法律问答助手，回答中国法律问题。",
  "回答要准确、简洁，引用法律条文时写明法律名称与条号，并提示需核验现行有效性；不确定时明确说明。",
  "引用法条一律写成《法律或司法解释全称》第X条（需要时加第X款、第X项），便于逐条核对。",
  "问题中形如〔自然人·XXXXXX〕〔账号·XXXXXX〕的内容是代号，请原样使用，不要猜测其真实内容。",
  "这是无事项问答：不涉及具体案件材料；如需处理具体案件，请提示律师在事项内处理。",
].join("\n");

const HISTORY_LIMIT = 20;

export class QaChatService {
  private readonly d: QaDeps;

  constructor(d: QaDeps) {
    this.d = d;
  }

  list(tenantId: string, userId: string): { conversation_id: string; title: string; updated_at: string }[] {
    return this.d.db.all(`SELECT conversation_id, title, updated_at FROM qa_conversations WHERE tenant_id = ? AND user_id = ? ORDER BY updated_at DESC LIMIT 100`, [tenantId, userId]);
  }

  private conversation(conversationId: string, tenantId: string, userId: string): { conversation_id: string; token_key_b64: string } {
    const c = this.d.db.get<{ conversation_id: string; token_key_b64: string }>(
      `SELECT conversation_id, token_key_b64 FROM qa_conversations WHERE conversation_id = ? AND tenant_id = ? AND user_id = ?`,
      [conversationId, tenantId, userId],
    );
    if (!c) throw Object.assign(new Error("会话不存在"), { code: "not_found" });
    return c;
  }

  private table(conversationId: string): TokenEntry[] {
    return this.d.db.all<TokenEntry>(`SELECT token, category, value, normalized, source FROM qa_tokens WHERE conversation_id = ? ORDER BY seq`, [conversationId]);
  }

  private tokenizer(c: { conversation_id: string; token_key_b64: string }): MatterTokenizer {
    return new MatterTokenizer({ matterKey: Buffer.from(c.token_key_b64, "base64"), table: this.table(c.conversation_id) });
  }

  private persist(conversationId: string, entries: readonly TokenEntry[]): void {
    let seq = this.d.db.get<{ n: number }>(`SELECT COALESCE(MAX(seq), 0) AS n FROM qa_tokens WHERE conversation_id = ?`, [conversationId])?.n ?? 0;
    for (const e of entries) {
      seq += 1;
      this.d.db.run(`INSERT OR IGNORE INTO qa_tokens (conversation_id, seq, token, category, value, normalized, source) VALUES (?,?,?,?,?,?,?)`, [
        conversationId,
        seq,
        e.token,
        e.category,
        e.value,
        e.normalized,
        e.source,
      ]);
    }
  }

  /** 会话消息（按会话令牌表还原后显示；只给本人）。 */
  get(conversationId: string, tenantId: string, userId: string): QaMessageView[] {
    const c = this.conversation(conversationId, tenantId, userId);
    const table = this.table(c.conversation_id);
    return this.d.db
      .all<QaMessageView>(`SELECT message_id, role, text, created_at FROM qa_messages WHERE conversation_id = ? ORDER BY seq`, [conversationId])
      .map((m) => {
        const text = restoreTokens(m.text, table).text;
        const citations = m.role === "assistant" ? this.citations(text) : null;
        return citations ? { ...m, text, citations } : { ...m, text };
      });
  }

  /**
   * 回答里的引用（B-6）：与成果签发门禁同一口径离线核对——条号不对、法规库外、案号离线、已核到。每次显示时现算（法规库更新后结论跟着变），
   * 不存结论；出错按“没有核对”处理，不显示成“没问题”。
   */
  /** 显示时现算的结论按“回答原文 + 法规库版本 + 日期”缓存（复核 R15B-16：长会话每次打开不再全部重算）。 */
  private readonly citeCache = new Map<string, QaCitations | null>();

  private citations(text: string): QaCitations | null {
    if (!this.d.lawdb) return null;
    const asOf = localToday();
    const key = `${this.d.lawdb.packageVersion}\u0000${asOf}\u0000${createHash("sha256").update(text).digest("hex")}`;
    if (this.citeCache.has(key)) return this.citeCache.get(key)!;
    try {
      const c = checkArtifactCitations(this.d.lawdb, "answer.md", Buffer.from(text, "utf8"), asOf);
      const out: QaCitations | null =
        !c.checked || (c.total === 0 && !c.unrecognized)
          ? null
          : {
              total: c.total,
              verified: c.verified,
              wrong: c.wrong,
              outside: c.outside_registry,
              cases: c.unverified_offline,
              items: c.items.map((i) => ({ raw: i.raw, kind: i.kind, reason: i.reason, ...(i.partial ? { partial: true } : {}) })),
              partial: c.partial ?? 0,
              unrecognized: c.unrecognized ?? 0,
              registry: c.registry_coverage,
              as_of: asOf,
            };
      if (this.citeCache.size > 500) this.citeCache.clear();
      this.citeCache.set(key, out);
      return out;
    } catch {
      return { total: 0, verified: 0, wrong: 0, outside: 0, cases: 0, items: [], registry: "", as_of: asOf, unchecked: true };
    }
  }

  /**
   * 当事人词典检查：本人是成员的事项（未被移出）中，问题命中其当事人（容忍写法变体）即拦截。
   * L3b 事项单独给出“当事人限制”原因；不在问答里透露任何当事人名称（只给事项名称与链接，本人本就可见）。
   */
  check(text: string, tenantId: string, userId: string): QaBlocked | null {
    const matters = this.d.db.all<{ matter_id: string; title: string; confidentiality: string; consent_status: string }>(
      `SELECT m.matter_id, m.title, m.confidentiality, m.consent_status FROM matters m
         JOIN matter_members mm ON mm.matter_id = m.matter_id AND mm.user_id = ? AND mm.removed_at IS NULL
        WHERE m.tenant_id = ?`,
      [userId, tenantId],
    );
    const hits: { matter_id: string; title: string; l3b: boolean }[] = [];
    for (const m of matters) {
      if (this.d.tokens.partiesIn(m.matter_id, text).length > 0) hits.push({ matter_id: m.matter_id, title: m.title, l3b: dataLevelOf(m.confidentiality, m.consent_status) === "L3b" });
    }
    if (hits.length === 0) return null;
    if (hits.some((h) => h.l3b)) {
      return { reason: "l3b_party", message: "问题涉及当事人限制（L3b）事项的当事人：已拦截，不会发出。该事项不使用云端模型。", matters: hits.filter((h) => h.l3b).map(({ matter_id, title }) => ({ matter_id, title })) };
    }
    return {
      reason: "matter_party",
      message: "问题涉及你的事项中的当事人：请在事项内处理（事项内才适用该事项的令牌化、依据与审计规则）。本次未发出。",
      matters: hits.map(({ matter_id, title }) => ({ matter_id, title })),
    };
  }

  async send(input: { conversationId?: string; text: string }, tenantId: string, userId: string): Promise<{ conversation_id: string; messages: QaMessageView[]; blocked?: QaBlocked }> {
    const text = String(input.text ?? "").trim();
    if (!text) throw Object.assign(new Error("问题为空"), { code: "validation" });
    if (text.length > 8000) throw Object.assign(new Error("问题过长（无事项问答不处理案件材料；请在事项内处理）"), { code: "validation" });
    const blocked = this.check(text, tenantId, userId);
    if (blocked) {
      return { conversation_id: input.conversationId ?? "", messages: input.conversationId ? this.get(input.conversationId, tenantId, userId) : [], blocked };
    }
    let conversationId = input.conversationId;
    if (!conversationId) {
      conversationId = newId("qaConversation");
      this.d.db.run(`INSERT INTO qa_conversations (conversation_id, tenant_id, user_id, title, token_key_b64) VALUES (?,?,?,?,?)`, [
        conversationId,
        tenantId,
        userId,
        "新问答",
        randomBytes(32).toString("base64"),
      ]);
    }
    const c = this.conversation(conversationId, tenantId, userId);
    const tz = this.tokenizer(c);
    const q = tz.tokenize(text);
    this.persist(c.conversation_id, q.entries);
    const seq0 = this.d.db.get<{ n: number }>(`SELECT COALESCE(MAX(seq), 0) AS n FROM qa_messages WHERE conversation_id = ?`, [c.conversation_id])?.n ?? 0;
    this.d.db.run(`INSERT INTO qa_messages (message_id, conversation_id, seq, role, text) VALUES (?,?,?,?,?)`, [newId("qaMessage"), c.conversation_id, seq0 + 1, "user", q.text]);
    if (seq0 === 0) {
      // 标题只在本机：用还原前的令牌形态截取（标识符与人名已是代号）
      this.d.db.run(`UPDATE qa_conversations SET title = ? WHERE conversation_id = ?`, [q.text.replace(/\s+/g, " ").slice(0, 24), c.conversation_id]);
    }
    const history = this.d.db
      .all<{ role: "user" | "assistant"; text: string }>(
        `SELECT role, text FROM qa_messages WHERE conversation_id = ? AND role IN ('user','assistant') ORDER BY seq DESC LIMIT ?`,
        [c.conversation_id, HISTORY_LIMIT],
      )
      .reverse();
    let answer: string;
    try {
      answer = await this.d.ask({
        conversationId: c.conversation_id,
        tenantId,
        userId,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history.map((m) => ({ role: m.role, content: m.text }))],
      });
    } catch (e) {
      this.d.db.run(`INSERT INTO qa_messages (message_id, conversation_id, seq, role, text) VALUES (?,?,?,?,?)`, [
        newId("qaMessage"),
        c.conversation_id,
        seq0 + 2,
        "notice",
        `未能取得回答：${(e as Error).message}`,
      ]);
      this.d.db.run(`UPDATE qa_conversations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE conversation_id = ?`, [c.conversation_id]);
      return { conversation_id: c.conversation_id, messages: this.get(c.conversation_id, tenantId, userId) };
    }
    // 模型回答原样保存（令牌形态；显示时还原）
    this.d.db.run(`INSERT INTO qa_messages (message_id, conversation_id, seq, role, text) VALUES (?,?,?,?,?)`, [newId("qaMessage"), c.conversation_id, seq0 + 2, "assistant", answer]);
    this.d.db.run(`UPDATE qa_conversations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE conversation_id = ?`, [c.conversation_id]);
    return { conversation_id: c.conversation_id, messages: this.get(c.conversation_id, tenantId, userId) };
  }
}
