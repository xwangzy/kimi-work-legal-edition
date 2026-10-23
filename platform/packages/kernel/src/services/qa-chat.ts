/**
 * 无事项问答（v9 第 03 篇 §4.1 问答、第 02 篇 §9.3 Chat 模式与 §12、第 04 篇 §5.3）：
 *
 * - 不读任何事项材料；问题先做**本人可见事项的当事人词典检查**——命中当事人限制（L3b）事项的当事人即拦截；
 *   命中其他事项的当事人：拦截并给出“到事项中处理”的链接（方案为“提示”；事项内才有该事项的当事人词典、依据与审计规则——偏离 D-22）；
 * - 每个会话一把令牌密钥：问题中的证件、账户、联系方式与规则识别的自然人姓名在出站前替换为会话代号（闸门对请求体再做一次）；
 * - 经出站闸门发往法律模型网关（中软不保存问答内容）；**历史只在本机**（qa_* 表；界面显示时按会话令牌表还原）；
 * - 模型调用经注入的 ask（闸门 /q/<会话> 路由），本模块不含任何网络代码；
 * - 回答流式返回：ask 逐段回调，本模块按会话令牌表还原后经 onPartial 推给界面（节流；未闭合的代号先不推）。
 *   只有完整结束的回答才保存；中途中断、内容安全拦截都按“未能取得回答”记，界面丢弃已显示的半截回答。
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
  /** 流式回答的增量（令牌形态）。 */
  onDelta?: (piece: string) => void;
}

export interface QaDeps {
  db: KernelDb;
  tokens: MatterTokenStore;
  ask(input: QaAskInput): Promise<string>;
  /** 本机法规库：回答里的引用与签发门禁同一口径离线核对（只在本机，不出站）。 */
  lawdb?: Lawdb;
  /** 回答生成中的部分内容（已还原，到目前为止的全文）推给发起问题的界面；streamId 由界面给出。 */
  onPartial?: (streamId: string, text: string) => void;
}

/**
 * 读完一个流式回答（SSE data 负载，OpenAI 兼容）：逐段回调正文增量，返回全文。
 * 错误事件（如网关内容安全拦截）与没有结束标志就断开的流一律抛错——半截回答不当成回答。
 */
export async function collectStreamText(chunks: AsyncIterable<string>, onDelta?: (piece: string) => void): Promise<string> {
  let text = "";
  let finished = false;
  for await (const payload of chunks) {
    if (payload === "[DONE]") {
      finished = true;
      continue;
    }
    let j: any;
    try {
      j = JSON.parse(payload);
    } catch {
      continue;
    }
    if (j?.error) throw new Error(String(j.error.message ?? j.error.code ?? "模型通道返回错误"));
    const choice = j?.choices?.[0];
    const piece = choice?.delta?.content;
    if (typeof piece === "string" && piece.length > 0) {
      text += piece;
      onDelta?.(piece);
    }
    if (typeof choice?.finish_reason === "string") finished = true;
  }
  if (!finished) throw new Error("回答中途中断，请重试");
  return text;
}

/** 推给界面的部分回答每隔多久最多一次。 */
const PARTIAL_INTERVAL_MS = 80;
/** 代号最长约 17 个字符：末尾未闭合的“〔”在这个长度内先不推，免得界面闪一下代号。 */
const OPEN_TOKEN_HOLD = 20;
/**
 * 回答末尾这么多字先不推（复核 Q5-02）：网关对流式输出逐块做内容安全检查，命中拦截类别时以错误事件结束；
 * 一个词被拆在两块里时，前半截已经发出——留一段尾巴，命中词的前半截就到不了界面。回答正常结束后再推全文。
 * 命中之前的文字仍会先显示、再换成“未能取得回答”（偏离 D-142，待拍板）。
 */
const TAIL_HOLD = 32;

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
  /** 正在回答的会话（复核 Q5-01）：同一会话一次只答一问——并发两问时两次回答抢同一个序号，先到的那条会丢。 */
  private readonly answering = new Set<string>();

  constructor(d: QaDeps) {
    this.d = d;
  }

  list(tenantId: string, userId: string): { conversation_id: string; title: string; updated_at: string }[] {
    return this.d.db.all(`SELECT conversation_id, title, updated_at FROM qa_conversations WHERE tenant_id = ? AND user_id = ? ORDER BY updated_at DESC LIMIT 100`, [tenantId, userId]);
  }

  /**
   * 删除本人的一个问答（问题、回答、令牌表一并删除）。驻留面写的是“问答历史在本机留存到律师删除”，原来没有删除的入口。
   * 正在回答的会话不能删（回答回来时会写进一个已删的会话）。
   */
  delete(conversationId: string, tenantId: string, userId: string): void {
    const c = this.conversation(conversationId, tenantId, userId);
    if (this.answering.has(c.conversation_id)) throw Object.assign(new Error("这个问答还在回答：等它答完再删"), { code: "conflict" });
    this.d.db.tx(() => {
      this.d.db.run(`DELETE FROM qa_tokens WHERE conversation_id = ?`, [c.conversation_id]);
      this.d.db.run(`DELETE FROM qa_messages WHERE conversation_id = ?`, [c.conversation_id]);
      this.d.db.run(`DELETE FROM qa_conversations WHERE conversation_id = ?`, [c.conversation_id]);
    });
  }

  /** 离所交接时清除本人在这台电脑上的全部问答（复核 Q4 建议 3）；正在回答的跳过。返回删掉的会话数。 */
  clearAll(tenantId: string, userId: string): number {
    let n = 0;
    for (const c of this.d.db.all<{ conversation_id: string }>(`SELECT conversation_id FROM qa_conversations WHERE tenant_id = ? AND user_id = ?`, [tenantId, userId])) {
      if (this.answering.has(c.conversation_id)) continue;
      this.delete(c.conversation_id, tenantId, userId);
      n++;
    }
    return n;
  }

  /** 本人在这台电脑上的问答会话数。 */
  count(tenantId: string, userId: string): number {
    return this.d.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM qa_conversations WHERE tenant_id = ? AND user_id = ?`, [tenantId, userId])?.n ?? 0;
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

  /** 部分回答的推送（节流、按会话令牌表还原）；没有 streamId 或没有推送通道时为 null。 */
  private partialPublisher(streamId: string | undefined, conversationId: string): { push: (piece: string) => void; stop: () => void; finish: () => void } | null {
    const publish = this.d.onPartial;
    if (!publish || !streamId) return null;
    const table = this.table(conversationId);
    let raw = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = 0;
    let stopped = false;
    const flush = () => {
      timer = null;
      if (stopped) return;
      last = Date.now();
      const base = raw.slice(0, Math.max(0, raw.length - TAIL_HOLD));
      const open = base.lastIndexOf("〔");
      const shown = open >= 0 && base.indexOf("〕", open) < 0 && base.length - open < OPEN_TOKEN_HOLD ? base.slice(0, open) : base;
      if (shown) publish(streamId, restoreTokens(shown, table).text);
    };
    return {
      push: (piece) => {
        raw += piece;
        if (timer || stopped) return;
        const wait = PARTIAL_INTERVAL_MS - (Date.now() - last);
        if (wait <= 0) flush();
        else timer = setTimeout(flush, wait);
      },
      stop: () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        timer = null;
      },
      // 回答正常结束（网关已检查完全文）：推一次全文，再停
      finish: () => {
        if (timer) clearTimeout(timer);
        timer = null;
        if (!stopped && raw) publish(streamId, restoreTokens(raw, table).text);
        stopped = true;
      },
    };
  }

  async send(input: { conversationId?: string; text: string; streamId?: string }, tenantId: string, userId: string): Promise<{ conversation_id: string; messages: QaMessageView[]; blocked?: QaBlocked }> {
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
    if (this.answering.has(c.conversation_id)) throw Object.assign(new Error("上一问还在回答：等它答完再问"), { code: "conflict" });
    this.answering.add(c.conversation_id);
    try {
      return await this.answer(c, text, input.streamId, tenantId, userId);
    } finally {
      this.answering.delete(c.conversation_id);
    }
  }

  /** 写入问题、取回答、写入回答或“未能取得回答”。序号写入时现取（复核 Q5-01）。 */
  private async answer(c: ReturnType<QaChatService["conversation"]>, text: string, streamId: string | undefined, tenantId: string, userId: string): Promise<{ conversation_id: string; messages: QaMessageView[] }> {
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
    const partial = this.partialPublisher(streamId, c.conversation_id);
    let answer: string;
    try {
      answer = await this.d.ask({
        conversationId: c.conversation_id,
        tenantId,
        userId,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history.map((m) => ({ role: m.role, content: m.text }))],
        ...(partial ? { onDelta: partial.push } : {}),
      });
    } catch (e) {
      partial?.stop();
      this.addMessage(c.conversation_id, "notice", `未能取得回答：${(e as Error).message}`);
      return { conversation_id: c.conversation_id, messages: this.get(c.conversation_id, tenantId, userId) };
    }
    // 模型回答原样保存（令牌形态；显示时还原）；写不进去的记“未能取得回答”，不让回答悄悄丢掉
    try {
      this.addMessage(c.conversation_id, "assistant", answer);
    } catch (e) {
      partial?.stop();
      this.addMessage(c.conversation_id, "notice", `未能取得回答：回答没有保存下来（${(e as Error).message}）`);
      return { conversation_id: c.conversation_id, messages: this.get(c.conversation_id, tenantId, userId) };
    }
    partial?.finish();
    return { conversation_id: c.conversation_id, messages: this.get(c.conversation_id, tenantId, userId) };
  }

  private addMessage(conversationId: string, role: "assistant" | "notice", text: string): void {
    this.d.db.tx(() => {
      const seq = (this.d.db.get<{ n: number }>(`SELECT COALESCE(MAX(seq), 0) AS n FROM qa_messages WHERE conversation_id = ?`, [conversationId])?.n ?? 0) + 1;
      this.d.db.run(`INSERT INTO qa_messages (message_id, conversation_id, seq, role, text) VALUES (?,?,?,?,?)`, [newId("qaMessage"), conversationId, seq, role, text]);
      this.d.db.run(`UPDATE qa_conversations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE conversation_id = ?`, [conversationId]);
    });
  }
}
