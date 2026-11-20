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
import { CLOUD_BUILD_TEXT, CLOUD_CERT_TEXT, cloudFailureKind } from "./cloud-connection.ts";

export interface QaMessageView {
  message_id: string;
  role: "user" | "assistant" | "notice";
  text: string;
  created_at: string;
  /** 回答里的引用按本机法规库离线核对的结果（v9.3 第 15 批 B-6；评审 Z1 P1-5）；没有引用时不带。 */
  citations?: QaCitations;
  /**
   * 这条回答（或“未能取得回答”）实际用的模型别名（第 47 批：问答按次选模型），如 legal/k2.6；问题本身与第 47 批之前的旧记录为 null
   * （界面不显示）。route_label 是律师看的名字（“K3”“K2.6”）；不认识的别名为 null。
   */
  route: string | null;
  route_label: string | null;
}

/** 问答可选的模型（第 47 批）：label 是律师看的名字；note 一句话说适合什么；default = 不选时用它。 */
export interface QaModelChoice {
  alias: string;
  label: string;
  note: string;
  default: boolean;
  /**
   * 这个模型的“深度思考”开关实际控制什么（第 49 批，按官方参数表）：
   * effort = 始终思考，开关调推理强度（K3：深度 max / 快速 low）；toggle = 开关决定思考与否（K2.6）；none = 不可控（界面不显示开关）。
   */
  thinking: "effort" | "toggle" | "none";
}

/** 问答允许律师选的别名（只此两个；子任务另有规则，不经这里）与其律师名。顺序即界面显示顺序。 */
export const QA_MODEL_CATALOG: readonly { alias: string; label: string; note: string }[] = [
  { alias: "legal/k3", label: "K3", note: "适合复杂问题" },
  { alias: "legal/k2.6", label: "K2.6", note: "更快、更省额度，复杂问题效果略弱" },
];

/** 别名 → 律师名（“K3”“K2.6”）；不在目录里的别名为 null。 */
export function qaRouteLabel(alias: string | null | undefined): string | null {
  return QA_MODEL_CATALOG.find((m) => m.alias === alias)?.label ?? null;
}

/**
 * 可选模型列表（第 47 批）：目录里、且模型路由实际配置了的别名；缺省那一个的说明前加“缺省，”。纯函数。
 * configured = broker.routeAliases()；defaultRoute = ZR_QA_ROUTE ?? legal/k3。
 */
export function qaModelChoices(configured: readonly string[], defaultRoute: string, thinkingOf?: (alias: string) => QaModelChoice["thinking"]): QaModelChoice[] {
  return QA_MODEL_CATALOG.filter((m) => configured.includes(m.alias)).map((m) => ({
    alias: m.alias,
    label: m.label,
    note: m.alias === defaultRoute ? `缺省，${m.note}` : m.note,
    default: m.alias === defaultRoute,
    thinking: thinkingOf?.(m.alias) ?? "none",
  }));
}

/**
 * 取不到回答时的错误说明（第 47 批）：模型通道把网关错误代码放在错误的 detail.code 里（429/5xx 的说明里没有“[kwl:代码]”，
 * 如 503 price_unconfigured）；说明里还没有代码时补在末尾，qaFailureText 才认得出。纯函数。
 */
export function qaErrorMessage(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e ?? "");
  const code = (e as { detail?: { code?: unknown } } | null)?.detail?.code;
  return typeof code === "string" && /^[a-z0-9_]{1,60}$/.test(code) && !message.includes("[kwl:") ? `${message} [kwl:${code}]` : message;
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

/** 问答进度（chat.progress 广播的内容）。 */
export interface QaProgress {
  phase: "thinking" | "writing";
  /** 到目前为止收到的思考字数（只作“还在动”的信号）。 */
  thought_chars: number;
}

export interface QaAskInput {
  conversationId: string;
  tenantId: string;
  userId: string;
  /** 已令牌化的对话（系统提示 + 历史 + 本次问题）。 */
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  /** 流式回答的增量（令牌形态）。 */
  onDelta?: (piece: string) => void;
  /** 模型“思考”阶段收到的增量字数（只给字数，不给思考内容）：界面据此显示“正在思考”。 */
  onReasoning?: (chars: number) => void;
  /** 本次用的模型别名（第 47 批：律师选的，或缺省 ZR_QA_ROUTE ?? legal/k3）。 */
  route: string;
  /**
   * 深度思考（第 48 批；第 49 批按模型族映射）：K3 为推理强度 max / low（K3 始终思考），K2.6 为开 / 关思考。
   * 提供方用 model-broker thinkingParams 换成上游参数。
   */
  deep: boolean;
}

export interface QaDeps {
  db: KernelDb;
  tokens: MatterTokenStore;
  ask(input: QaAskInput): Promise<string>;
  /** 本机法规库：回答里的引用与签发门禁同一口径离线核对（只在本机，不出站）。 */
  lawdb?: Lawdb;
  /** 回答生成中的部分内容（已还原，到目前为止的全文）推给发起问题的界面；streamId 由界面给出。 */
  onPartial?: (streamId: string, text: string) => void;
  /**
   * 回答进度（第 48 批）：模型在“思考”（thinking，附已收到的思考字数）还是已经在“撰写”（writing）。推给发起问题的界面显示等待状态；
   * 只含阶段与字数，不含思考内容。
   */
  onProgress?: (streamId: string, p: QaProgress) => void;
  /** 律师没选时用不用深度思考（缺省 false：快速回答；ZR_QA_THINKING=on 改为深度思考）。 */
  defaultDeep?: boolean;
  /** 模型路由实际配置了的别名（broker.routeAliases()；第 47 批）：律师选的模型须在其中。不给时只认缺省别名。 */
  routes?: () => readonly string[];
  /** 别名 → 思考控制方式（第 49 批；model-broker thinkingControlOf）。不给时按“不可控”。 */
  thinkingOf?: (alias: string) => QaModelChoice["thinking"];
  /** 不选模型时用的别名（index.ts：ZR_QA_ROUTE ?? legal/k3）；不给时 legal/k3。 */
  defaultRoute?: string;
}

/**
 * 读完一个流式回答（SSE data 负载，OpenAI 兼容）：逐段回调正文增量，返回全文。
 * 错误事件（如网关内容安全拦截）与没有结束标志就断开的流一律抛错——半截回答不当成回答。
 */
/**
 * 问答取不到回答时的说明（第 46 批）：闸门把网关错误代码以“[kwl:代码]”附在说明末尾——额度、登录类按代码说人话，其余照原话、去掉代码。纯函数。
 */
export function qaFailureText(message: string, route?: string | null): string {
  const code = /\[kwl:([a-z0-9_]{1,60})\]/.exec(message)?.[1] ?? "";
  // 第 52 批（第 50 批 IP 部署演练发现）：证书被换时原来落到下面的通用说法（说明里带“模型通道 502”）——证书类、安装包配置类单独说，与“连不上”分开
  const cloud = cloudFailureKind(code);
  if (cloud === "cert") return CLOUD_CERT_TEXT;
  if (cloud === "build") return CLOUD_BUILD_TEXT;
  if (cloud === "unreachable") return "连不上云端 AI 服务，这次没有取得回答：请检查网络后再问；仍不行请联系律所 IT";
  if (cloud === "timeout") return "云端 AI 服务长时间没有响应，这次没有取得回答：请稍后再问";
  // 第 47 批：所选模型本身用不了（未定价 503、没有路由或已停用 400、套餐不含 403、这个别名没有可用上游 503）——说清是“这个模型”的事，
  // 不说成额度用完或连不上；选的不是 K3 时建议换 K3
  if (code === "price_unconfigured" || code === "model_not_routed" || code === "model_disabled" || code === "model_not_allowed" || code === "upstream_unavailable") {
    const label = qaRouteLabel(route);
    const isK3 = route == null || route === "legal/k3";
    const why = code === "model_not_allowed" ? `本所的套餐不含${label ? ` ${label}` : "这个模型"}` : `${label ? `${label} ` : ""}这个模型暂不可用`;
    return isK3 ? `${why}，这次没有取得回答：请稍后再问，或联系律所管理员` : `${why}，这次没有取得回答：请换 K3 再问，或联系律所管理员`;
  }
  if (code.startsWith("quota_")) return "本所 AI 额度暂时用到限制，这次没有取得回答：可在“设置 → 套餐与用量”查看，稍后再问或联系律所管理员";
  if (code.startsWith("seat_") || /AI 使用授权/.test(message)) return "登录已失效或这台电脑暂时没有取得 AI 使用授权，这次没有取得回答：请重新登录（或联网稍等）后再问";
  // 第 46 批真实验收（停用演练）：律师看到过“模型通道错误 402：账号已停用”
  if (code === "account_disabled" || /账号已停用/.test(message)) return "你的账号已被停用，这次没有取得回答：请联系律所管理员或中软客服";
  if (code.startsWith("session_") || /登录已失效|登录已过期/.test(message)) return "登录已失效，这次没有取得回答：请重新登录后再问";
  if (code === "client_outdated" || /客户端版本过旧/.test(message)) return "客户端版本过旧，这次没有取得回答：请升级到最新版本";
  // 其余：去掉错误码与“模型通道错误 4xx：”这类前缀；剩下的是中文说明就照写，否则给通用说法（原文在诊断日志里）
  const plain = message.replace(/\s*\[kwl:[a-z0-9_]{1,60}\]/g, "").replace(/^模型通道错误\s*\d{3}\s*[:：]\s*/, "").trim();
  if (plain && /[\u4e00-\u9fff]/.test(plain) && !/[A-Za-z]{4,}|\b\d{3}\b/.test(plain)) return plain;
  return "AI 服务暂时不可用，这次没有取得回答：请稍后再问";
}

export async function collectStreamText(chunks: AsyncIterable<string>, onDelta?: (piece: string) => void, onReasoning?: (chars: number) => void): Promise<string> {
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
    // 推理型模型先发“思考”增量（reasoning_content）再发正文：思考内容不收、不显示，只把字数交给界面当“还在动”的信号
    const thought = choice?.delta?.reasoning_content;
    if (typeof thought === "string" && thought.length > 0) onReasoning?.(thought.length);
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
/** 思考进度每隔多久最多推一次（界面只用它显示“还在动”与字数，不必很密）。 */
const PROGRESS_INTERVAL_MS = 1000;
/** 代号最长约 17 个字符：末尾未闭合的“〔”在这个长度内先不推，免得界面闪一下代号。 */
const OPEN_TOKEN_HOLD = 20;
/**
 * 回答末尾这么多字先不推（复核 Q5-02）：网关对流式输出逐块做内容安全检查，命中拦截类别时以错误事件结束；
 * 一个词被拆在两块里时，前半截已经发出——留一段尾巴，命中词的前半截就到不了界面。回答正常结束后再推全文。
 * 命中之前的文字仍会先显示、再换成“未能取得回答”（偏离 D-142；10-23 拍板接受，问答页写明）。
 */
const TAIL_HOLD = 32;

/** 无事项问答的系统提示（v9.4 第 25 批导出：随每次问答发出，用例 `prompt-text-names` 核对不会被姓名规则误认）。 */
export const QA_SYSTEM_PROMPT = [
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
      .all<Omit<QaMessageView, "route_label">>(`SELECT message_id, role, text, created_at, route FROM qa_messages WHERE conversation_id = ? ORDER BY seq`, [conversationId])
      .map((m) => {
        const text = restoreTokens(m.text, table).text;
        const citations = m.role === "assistant" ? this.citations(text) : null;
        const route = m.role === "user" ? null : (m.route ?? null);
        const base = { ...m, text, route, route_label: qaRouteLabel(route) };
        return citations ? { ...base, citations } : base;
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

  /**
   * 回答进度的推送（第 48 批）：思考阶段每秒至多一次（附已收到的思考字数），第一段正文到来时推一次“撰写中”；
   * 没有 streamId 或没有推送通道时为 null。只含阶段与字数。
   */
  private progressPublisher(streamId: string | undefined): { reasoning: (chars: number) => void; writing: () => void } | null {
    const publish = this.d.onProgress;
    if (!publish || !streamId) return null;
    let thoughtChars = 0;
    let last = 0;
    let writing = false;
    return {
      reasoning: (chars) => {
        thoughtChars += chars;
        if (writing) return;
        const now = Date.now();
        if (last !== 0 && now - last < PROGRESS_INTERVAL_MS) return;
        last = now;
        publish(streamId, { phase: "thinking", thought_chars: thoughtChars });
      },
      writing: () => {
        if (writing) return;
        writing = true;
        publish(streamId, { phase: "writing", thought_chars: thoughtChars });
      },
    };
  }

  /** 不选时用不用深度思考（chat.models 告诉界面开关的初始状态）。 */
  defaultDeep(): boolean {
    return this.d.defaultDeep === true;
  }

  /** 可选模型（第 47 批）：kernel.status 的 model_choices 与 chat.models 用。 */
  modelChoices(): QaModelChoice[] {
    return qaModelChoices(this.d.routes?.() ?? [this.defaultRoute()], this.defaultRoute(), this.d.thinkingOf);
  }

  private defaultRoute(): string {
    return this.d.defaultRoute ?? "legal/k3";
  }

  /**
   * 律师选的模型（第 47 批）：不选（undefined / null / 空串）用缺省；选了就只认可选列表里的别名（K3、K2.6，且本机模型路由配置了），
   * 不认识的拒绝并说明能选什么——不静默改用别的模型。
   */
  private pickRoute(route: unknown): string {
    if (route === undefined || route === null || route === "") return this.defaultRoute();
    const choices = this.modelChoices();
    if (typeof route === "string" && choices.some((c) => c.alias === route)) return route;
    const can = choices.map((c) => c.label).join("、");
    throw Object.assign(new Error(can ? `所选模型不可用：问答只能选 ${can}` : "所选模型不可用：这台电脑没有配置可选的问答模型，请联系律所管理员"), { code: "validation" });
  }

  async send(input: { conversationId?: string; text: string; streamId?: string; route?: string | null; deep?: boolean }, tenantId: string, userId: string): Promise<{ conversation_id: string; messages: QaMessageView[]; blocked?: QaBlocked }> {
    const text = String(input.text ?? "").trim();
    if (!text) throw Object.assign(new Error("问题为空"), { code: "validation" });
    if (text.length > 8000) throw Object.assign(new Error("问题过长（无事项问答不处理案件材料；请在事项内处理）"), { code: "validation" });
    const route = this.pickRoute(input.route);
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
      return await this.answer(c, text, input.streamId, tenantId, userId, route, input.deep ?? this.defaultDeep());
    } finally {
      this.answering.delete(c.conversation_id);
    }
  }

  /** 写入问题、取回答、写入回答或“未能取得回答”。序号写入时现取（复核 Q5-01）。 */
  private async answer(c: ReturnType<QaChatService["conversation"]>, text: string, streamId: string | undefined, tenantId: string, userId: string, route: string, deep: boolean): Promise<{ conversation_id: string; messages: QaMessageView[] }> {
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
    const progress = this.progressPublisher(streamId);
    let answer: string;
    try {
      answer = await this.d.ask({
        conversationId: c.conversation_id,
        tenantId,
        userId,
        messages: [{ role: "system", content: QA_SYSTEM_PROMPT }, ...history.map((m) => ({ role: m.role, content: m.text }))],
        ...(partial || progress
          ? {
              onDelta: (piece: string) => {
                progress?.writing();
                partial?.push(piece);
              },
            }
          : {}),
        ...(progress ? { onReasoning: progress.reasoning } : {}),
        route,
        deep,
      });
    } catch (e) {
      partial?.stop();
      this.addMessage(c.conversation_id, "notice", `未能取得回答：${qaFailureText(qaErrorMessage(e), route)}`, route);
      return { conversation_id: c.conversation_id, messages: this.get(c.conversation_id, tenantId, userId) };
    }
    // 模型回答原样保存（令牌形态；显示时还原）；写不进去的记“未能取得回答”，不让回答悄悄丢掉
    try {
      this.addMessage(c.conversation_id, "assistant", answer, route);
    } catch (e) {
      partial?.stop();
      this.addMessage(c.conversation_id, "notice", `未能取得回答：回答没有保存下来（${(e as Error).message}）`, route);
      return { conversation_id: c.conversation_id, messages: this.get(c.conversation_id, tenantId, userId) };
    }
    partial?.finish();
    return { conversation_id: c.conversation_id, messages: this.get(c.conversation_id, tenantId, userId) };
  }

  private addMessage(conversationId: string, role: "assistant" | "notice", text: string, route: string): void {
    this.d.db.tx(() => {
      const seq = (this.d.db.get<{ n: number }>(`SELECT COALESCE(MAX(seq), 0) AS n FROM qa_messages WHERE conversation_id = ?`, [conversationId])?.n ?? 0) + 1;
      this.d.db.run(`INSERT INTO qa_messages (message_id, conversation_id, seq, role, text, route) VALUES (?,?,?,?,?,?)`, [newId("qaMessage"), conversationId, seq, role, text, route]);
      this.d.db.run(`UPDATE qa_conversations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE conversation_id = ?`, [conversationId]);
    });
  }
}
