/**
 * citations.verify — 引用四态核验（方案第 2 篇 §5.3、第 4 篇 §9 全部离线完成）。
 *
 * 四态：来源已核 / 版本已核 / 支持待判 / 律师已确认；无法核实 → 拦截（不静默删除）。
 * 生成器无权标记“律师已确认”（§4.3），本工具永远不会返回该状态。
 * 支持性判断不在确定性工具内完成：内容支持一律“支持待判”，交后续模型与律师。
 * 数据源为签名法规库包（@zr-legal/lawdb）：名称归一、条号存在性、按适用时点取版本、
 * 效力状态、条号迁移表；每次核验对来源做 Source Registry 展示动作校验（§2.2）。
 * 案号类引用：存在性核验需授权数据商在线接口，离线一律「未核实（离线）」——不得进入签发版。
 */
import { CitationState, DomainError, type CitationState as CitationStateT } from "@zr-legal/domain";
import { versionAt, type Lawdb } from "@zr-legal/lawdb";
import { cnToInt, intToCn } from "./cn-numerals.ts";

export interface RawCitation {
  raw: string;
  law: string;
  articleText: string;
  article: number;
  offset: number;
}

const CITATION_RE = /《([^》]{2,40})》第([零一二三四五六七八九十百千\d]{1,12})条/g;

/**
 * 案号粗粒度提取（如实说明覆盖边界）：只覆盖「(20xx 或 （20xx 开头、以「号」收尾」的中文案号形态，
 * 如（2023）最高法民终123号、(2024）京01民终1234号；年份与主体间允许全半角括号与数字字母混排。
 * 不覆盖：无「号」收尾的引用、英美 citation、非诉讼编号变体、括号内非 20xx 年份——未覆盖形态按未提取处理（不伪造核验结论）。
 */
const CASE_NO_RE = /[（(]20\d{2}[）)][0-9A-Za-z一-龥]{1,15}?号/g;

export function extractCitations(text: string): RawCitation[] {
  const out: RawCitation[] = [];
  for (const m of text.matchAll(CITATION_RE)) {
    const article = cnToInt(m[2]!);
    if (article === null) continue;
    out.push({ raw: m[0], law: m[1]!, articleText: m[2]!, article, offset: m.index ?? 0 });
  }
  return out;
}

export function extractCaseNumbers(text: string): string[] {
  return [...text.matchAll(CASE_NO_RE)].map((m) => m[0]);
}

export interface CitationVerifyParams {
  text?: string;
  citations?: { law: string; article: number }[];
  as_of: string; // 适用时点（分析截止日）
  topic_hint?: string; // 该引用在上下文中的主题（如“保密义务”），用于改引核验
}

export interface CitationVerdict {
  raw: string;
  kind: "statute" | "case";
  law_input: string;
  article: number | null;
  matched_law_name: string | null;
  lsv_id: string | null;
  effectiveness: string | null;
  state: CitationStateT;
  reasons: string[];
  suggestion: string | null;
  historical_note: string | null;
  checked_at: string;
}

export interface CitationVerifyResult {
  verdicts: CitationVerdict[];
  summary: {
    total: number;
    source_verified: number;
    version_verified: number;
    support_pending: number;
    intercepted: number;
    /** 案号离线未核实数量（不得进入签发版）。 */
    unverified_offline: number;
  };
  intercepted: CitationVerdict[]; // 拦截可见：单独列出，不静默删除
  /** 签名法规库包版本（§9「法规库最后更新日」数据源）。 */
  registry_coverage: string;
}

export function citationsVerify(lawdb: Lawdb, params: CitationVerifyParams): CitationVerifyResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(params.as_of ?? "")) {
    throw new DomainError("validation", "citations.verify 需要 as_of(YYYY-MM-DD)", 422);
  }
  const raws: RawCitation[] = [];
  if (params.text) raws.push(...extractCitations(params.text));
  for (const c of params.citations ?? []) {
    if (!c.law || !Number.isInteger(c.article)) throw new DomainError("validation", "citations[] 需要 law 与整数 article", 422);
    raws.push({ raw: `《${c.law}》第${intToCn(c.article)}条`, law: c.law, articleText: String(c.article), article: c.article, offset: -1 });
  }
  const checkedAt = new Date().toISOString();
  const verdicts: CitationVerdict[] = raws.map((rc) => verifyOne(lawdb, rc, params.as_of, params.topic_hint, checkedAt));
  // 案号：离线一律「未核实（离线）」（§9：存在性核验需授权数据商在线接口）
  if (params.text) {
    for (const caseNo of extractCaseNumbers(params.text)) {
      verdicts.push({
        raw: caseNo,
        kind: "case",
        law_input: caseNo,
        article: null,
        matched_law_name: null,
        lsv_id: null,
        effectiveness: null,
        state: CitationState.unverifiedOffline,
        reasons: ["case_offline_unverified:案例存在性与摘录核验需授权数据商在线接口（§9），离线显示「未核实（离线）」；该引用不得进入签发版，联网后补核"],
        suggestion: "联网后经授权数据商补核（只发案号等去标识查询）；在此之前改用可离线核验的法条引用或人工核验链接",
        historical_note: null,
        checked_at: checkedAt,
      });
    }
  }
  const intercepted = verdicts.filter((v) => v.state === CitationState.intercepted);
  return {
    verdicts,
    summary: {
      total: verdicts.length,
      // 口径：「来源已核」只计非拦截且非离线未核实；案号离线未核实独立计数，不冒充已核
      source_verified: verdicts.filter((v) => v.state !== CitationState.intercepted && v.state !== CitationState.unverifiedOffline).length,
      version_verified: verdicts.filter((v) => v.state === CitationState.versionVerified || v.state === CitationState.supportPending).length,
      support_pending: verdicts.filter((v) => v.state === CitationState.supportPending).length,
      intercepted: intercepted.length,
      unverified_offline: verdicts.filter((v) => v.state === CitationState.unverifiedOffline).length,
    },
    intercepted,
    registry_coverage: lawdb.packageVersion,
  };
}

function verifyOne(lawdb: Lawdb, rc: RawCitation, asOf: string, topicHint: string | undefined, checkedAt: string): CitationVerdict {
  const base: CitationVerdict = {
    raw: rc.raw,
    kind: "statute",
    law_input: rc.law,
    article: rc.article,
    matched_law_name: null,
    lsv_id: null,
    effectiveness: null,
    state: CitationState.intercepted,
    reasons: [],
    suggestion: null,
    historical_note: null,
    checked_at: checkedAt,
  };
  const rows = lawdb.findLawVersions(rc.law);
  if (rows.length === 0) {
    base.reasons.push("unknown_source:注册库中不存在该法源，无法核实来源");
    return base;
  }
  base.matched_law_name = rows[0]!.law_name;
  const v = versionAt(rows, asOf);
  if (!v) {
    base.reasons.push(`no_applicable_version:适用时点 ${asOf} 无适用版本`);
    return base;
  }
  base.lsv_id = v.lsv_id;
  base.effectiveness = v.effectiveness;
  // Source Registry 运行时强制（§2.2）：展示动作未授权即停（不让模型补全未获授权的全文）
  lawdb.assertAction(v.source_license_id, "display");
  if (rc.article < 1 || rc.article > v.total_articles) {
    base.reasons.push(`article_out_of_range:第 ${rc.article} 条超出该版本总条数 ${v.total_articles}`);
    return base;
  }
  // 改引核验：上下文主题在迁移映射中有登记，且条号与所引不一致 → 拦截并提示改引
  if (topicHint) {
    const correct = lawdb.topicArticle(v.lsv_id, topicHint);
    if (correct !== null && correct !== rc.article) {
      base.reasons.push(`renumbered:${asOf} 起施行的版本（${v.lsv_id}）中，“${topicHint}”为第 ${correct} 条，所引第 ${rc.article} 条已不对应`);
      base.suggestion = `改引《${v.law_name}》第${intToCn(correct)}条（${v.effective} 施行版本）`;
      const older = lawdb.topicArticleInOtherVersion(v.law_id, v.lsv_id, topicHint, rc.article);
      if (older) {
        base.historical_note = `第 ${rc.article} 条系 ${older.effective} 施行版本（${older.lsv_id}，${older.effectiveness === "amended" ? "已修改" : "已废止"}）的条号`;
      }
      return base;
    }
  }
  // 来源与版本均已核；内容是否支持命题不由确定性工具判断
  base.state = CitationState.supportPending;
  base.reasons.push("source_and_version_verified:来源与适用版本已核，内容支持待判");
  return base;
}
