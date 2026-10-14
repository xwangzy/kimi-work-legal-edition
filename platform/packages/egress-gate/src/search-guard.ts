/**
 * 检索查询的出站检查（第 02 篇 §8.2 联网检索列、§8.3 检索查询行、§11.2；第 04 篇 §5.1 `/search`）：
 *
 * - 证件/账户/联系方式类标识符：从查询中去除（检索引擎拿到代号没有意义）；
 * - 当事人实体（词典中的机构与自然人，含别名、机构字号别名，容忍全角、繁体、插入空白与零宽字符——审查 S4-02）、规则识别出的自然人姓名、
 *   以及查询里出现的事项代号（自然人与机构的代号视同实体，标识符类代号去除——审查 S4-07）：命中即“须确认或泛化”——
 *   - L0/L1：泛化后放行（不含客户信息的前提下）；
 *   - L2：任务开始时已预授权“本任务泛化后放行”（自动档）→ 泛化改写后放行（机构 → “某公司”等，自然人 → “某人”）；
 *     律师已确认（闸门核验过设备签名的批准凭据，W1）→ 按所选变体放行：**原文放行只保留明文书写的机构名称**，自然人一律“某人”、
 *     代号一律泛化、标识符去除（第 06 篇 T20：自然人姓名在检索请求中永不出现）；**改写后放行**同泛化；否则拒绝并提示改写；
 *   - L3a：逐条确认——须有本条查询的批准凭据，且只能以改写后的一般性查询发出（全部化名强制）；无凭据一律拒绝；
 *   - L3b、L4：禁止。
 * - 转发时**不携带事项编号**（只带席位凭据）；查询原文与实际发出的查询只记在本机事项账本（去向记录）。
 */
import type { MatterTokenizer } from "@zr-legal/tokenizer";
import { findIdentifiers, TOKEN_RE, tokenCategory } from "@zr-legal/tokenizer";

export type DataLevel = "L0" | "L1" | "L2" | "L3a" | "L3b" | "L4";

export interface SearchContext {
  dataLevel: DataLevel;
  basisComplete: boolean;
  /** 任务开始时的预授权“本任务泛化后放行”。 */
  preauthorizedGeneralize: boolean;
  tokenizer: MatterTokenizer;
  /** 律师的确认（闸门已核验批准凭据；内核预览卡片时按变体计算）：原文放行或改写后放行。 */
  confirmed?: "original" | "generalized";
}

export type SearchVerdict =
  | { decision: "pass"; sent: string; changes: string[] }
  | { decision: "generalized"; sent: string; changes: string[] }
  | { decision: "confirmed_original"; sent: string; changes: string[] }
  | { decision: "deny"; reason: string; message: string };

const MAX_QUERY_CHARS = 500;

/** 机构名称的泛化：按后缀给出类别词。 */
function generalizeOrg(name: string): string {
  if (/律师事务所$/.test(name)) return "某律师事务所";
  if (/银行|支行|分行/.test(name)) return "某银行";
  if (/(股份有限公司|有限责任公司|有限公司|公司)$/.test(name)) return "某公司";
  if (/集团$/.test(name)) return "某集团";
  if (/(医院|学校|大学|学院)$/.test(name)) return "某机构";
  return "某企业";
}

export function screenSearchQuery(query: string, ctx: SearchContext): SearchVerdict {
  if (typeof query !== "string" || query.trim().length === 0) return { decision: "deny", reason: "query_empty", message: "检索查询为空" };
  if (query.length > MAX_QUERY_CHARS) return { decision: "deny", reason: "query_too_long", message: `检索查询超过 ${MAX_QUERY_CHARS} 字` };
  if (ctx.dataLevel === "L4") return { decision: "deny", reason: "search_forbidden_l4", message: "涉密事项禁止联网检索" };
  if (ctx.dataLevel === "L3b") return { decision: "deny", reason: "search_forbidden_l3b", message: "当事人限制事项禁止联网检索" };
  if (ctx.dataLevel === "L3a" && !ctx.confirmed) {
    return { decision: "deny", reason: "search_l3a_each_query", message: "敏感事项的检索须逐条确认：请在确认卡上确认本条查询（只以改写后的一般性查询发出）" };
  }
  if (!ctx.basisComplete && ctx.dataLevel !== "L0" && ctx.dataLevel !== "L1") {
    return { decision: "deny", reason: "basis_pending_no_egress", message: "事项四项依据未齐备：只运行不出站的本机能力" };
  }
  const changes: string[] = [];
  let sent = query;
  // 1) 代号：标识符类去除；自然人与机构类视同实体（泛化或拒绝）
  let tokenEntities = 0;
  let tokenIds = 0;
  TOKEN_RE.lastIndex = 0;
  sent = sent.replace(TOKEN_RE, (tok) => {
    const c = tokenCategory(tok);
    if (c === "person") {
      tokenEntities += 1;
      return "某人";
    }
    if (c === "org") {
      tokenEntities += 1;
      return "某公司";
    }
    tokenIds += 1;
    return "";
  });
  if (tokenIds > 0) changes.push(`去除代号 ${tokenIds} 处`);
  // 2) 标识符：去除（不发代号）；敏感事项的检索式另去除案号（案号可反查当事人；L2 保留以便法律研究——令牌化覆盖扩展报告 §4）
  const ids = findIdentifiers(sent, [], { caseNumbers: ctx.dataLevel === "L3a" });
  if (ids.length > 0) {
    for (const h of [...ids].sort((a, b) => b.start - a.start)) sent = `${sent.slice(0, h.start)}${sent.slice(h.end)}`;
    changes.push(`去除标识符 ${ids.length} 处`);
  }
  // 3) 当事人实体（容忍写法变体）与规则识别的自然人姓名
  const partyHits = ctx.tokenizer.findParties(sent);
  const tokenized = ctx.tokenizer.tokenize(sent);
  const personHits = tokenized.entries.filter((e) => e.category === "person").map((e) => e.value);
  const entityHit = partyHits.length > 0 || personHits.length > 0 || tokenEntities > 0;
  // 原文放行（律师确认，L2）：只保留明文书写的机构名称；自然人一律“某人”（代号在第 1 步已泛化，标识符在第 2 步已去除）
  const originalOk = entityHit && ctx.confirmed === "original" && ctx.dataLevel === "L2";
  if (originalOk) {
    for (const h of [...partyHits].filter((x) => x.category === "person").sort((a, b) => b.start - a.start)) sent = `${sent.slice(0, h.start)}某人${sent.slice(h.end)}`;
    const again = ctx.tokenizer.tokenize(sent);
    for (const e of again.entries.filter((x) => x.category === "person")) sent = sent.split(e.value).join("某人");
    changes.push(`律师确认原文放行：机构名称保留，自然人 ${partyHits.filter((x) => x.category === "person").length + personHits.length} 处改为“某人”`);
    sent = sent.replace(/\s{2,}/g, " ").trim();
    if (sent.length === 0) return { decision: "deny", reason: "query_empty_after_generalization", message: "去除标识符与人名后查询为空" };
    return { decision: "confirmed_original", sent, changes };
  }
  if (entityHit) {
    if (ctx.dataLevel === "L2" && !ctx.preauthorizedGeneralize && ctx.confirmed !== "generalized") {
      return {
        decision: "deny",
        reason: "search_entity_requires_confirmation",
        message: "检索查询含当事人名称（含简称或其他写法）、自然人姓名或事项代号：请改写为不含当事人与人名的一般性查询（例如“某有限责任公司股东未实缴出资补足责任”）后重试，或由律师在确认卡上确认",
      };
    }
    // L0/L1 或 L2 已预授权：泛化改写（从后往前替换命中区间）
    for (const h of [...partyHits].sort((a, b) => b.start - a.start)) {
      sent = `${sent.slice(0, h.start)}${h.category === "person" ? "某人" : generalizeOrg(h.value)}${sent.slice(h.end)}`;
    }
    const again = ctx.tokenizer.tokenize(sent);
    for (const e of again.entries.filter((x) => x.category === "person")) sent = sent.split(e.value).join("某人");
    changes.push(`泛化当事人/人名/代号 ${partyHits.length + personHits.length + tokenEntities} 处`);
  }
  sent = sent.replace(/\s{2,}/g, " ").trim();
  if (sent.length === 0) return { decision: "deny", reason: "query_empty_after_generalization", message: "去除标识符与人名后查询为空" };
  return entityHit ? { decision: "generalized", sent, changes } : { decision: "pass", sent, changes };
}
