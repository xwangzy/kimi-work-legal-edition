/**
 * law.get_version / law.search（确定性，方案 §9：法条核验全部离线完成——
 * 名称归一、条号存在性、按适用时点取版本、效力状态、条号迁移表）。
 * 数据源为签名法规库包（@zr-legal/lawdb）；注册库没有就明说，故障不伪造法源（§4.1 W3）。
 */
import { DomainError } from "@zr-legal/domain";
import { versionAt, type Lawdb, type LawVersionRow } from "@zr-legal/lawdb";
import { cnToInt } from "./cn-numerals.ts";
import { lawNameCandidates } from "./law-names.ts";

export interface LawGetVersionParams {
  law: string; // 法名或简称（名称归一：书名号/空白/全半角不敏感）
  as_of: string; // 适用时点 YYYY-MM-DD
  topic?: string; // 主题（用于条号映射核验，如“保密义务”）
}

export interface LawVersionResult {
  found: boolean;
  law_name?: string;
  version?: {
    lsv_id: string;
    promulgated: string;
    effective: string;
    superseded: string | null;
    effectiveness: string;
    total_articles: number;
  };
  topic_article?: number | null;
  all_versions?: { lsv_id: string; effective: string; superseded: string | null; effectiveness: string }[];
  license_note?: string;
  checked_at: string;
}

export function lawGetVersion(lawdb: Lawdb, params: LawGetVersionParams): LawVersionResult {
  if (!params.law || !/^\d{4}-\d{2}-\d{2}$/.test(params.as_of ?? "")) {
    throw new DomainError("validation", "law.get_version 需要 law 与 as_of(YYYY-MM-DD)", 422);
  }
  const rows = lawdb.findLawVersions(params.law);
  const checkedAt = new Date().toISOString();
  if (rows.length === 0) {
    // 不伪造：注册库没有就明说
    return { found: false, checked_at: checkedAt };
  }
  // 展示动作校验（Source Registry §2.2 运行时强制：all_versions 逐版本核对各自来源，不足即停）
  for (const r of rows) lawdb.assertAction(r.source_license_id, "display");
  const v = versionAt(rows, params.as_of);
  const result: LawVersionResult = {
    found: true,
    law_name: rows[0]!.law_name,
    all_versions: rows.map((r) => ({
      lsv_id: r.lsv_id,
      effective: r.effective,
      superseded: r.superseded,
      effectiveness: r.effectiveness,
    })),
    license_note: lawdb.licenseNoteOf(rows[0]!.source_license_id),
    checked_at: checkedAt,
  };
  if (v) {
    result.version = {
      lsv_id: v.lsv_id,
      promulgated: v.promulgated,
      effective: v.effective,
      superseded: v.superseded,
      effectiveness: v.effectiveness,
      total_articles: v.total_articles,
    };
    if (params.topic) result.topic_article = lawdb.topicArticle(v.lsv_id, params.topic);
  }
  return result;
}

export function lawSearch(lawdb: Lawdb, params: { query: string }): { results: { law_name: string; lsv_id: string; effectiveness: string; effective: string }[] } {
  const q = (params.query ?? "").trim();
  if (!q) throw new DomainError("validation", "law.search 需要 query", 422);
  const hits = lawdb.searchLaws(q);
  // 检索动作逐命中校验（§2.2「运行时每次检索……校验」；不足即停，不让模型补全未获授权内容）
  for (const h of hits) {
    const src = lawdb.sourceOfVersion(h.lsv_id);
    if (src) lawdb.assertAction(src, "search");
  }
  return { results: hits };
}

// ─── law.get_article：取条文原文（v9.4 评审 S1 §6.2 第 4 项） ───

export interface LawGetArticleParams {
  law: string; // 法名或简称（与 law.get_version 同一归一；查不到再按简称表、加去“中华人民共和国”前缀查）
  article: number | string; // 585、"585"、"第585条"、"第五百八十五条"（带“第二款”等时按条返回全文）
  as_of?: string; // 适用时点 YYYY-MM-DD，缺省为今天
}

export interface LawArticleResult {
  found: boolean;
  /** found=false 时的原因：库外法源 / 该时点无适用版本 / 条号超出该版本条数 / 条号存在但正文未采集 / “之 N”条（按整数条号存储，取不到）。 */
  reason?: "law_not_in_lawdb" | "no_applicable_version" | "article_not_exist" | "text_not_collected" | "article_suffix_unsupported";
  law_name?: string;
  lsv_id?: string;
  effective?: string;
  superseded?: string | null;
  effectiveness?: string;
  article_no?: number;
  /** 条文原文（法规库采集文本，逐字；库内没有就不给，绝不补写）。 */
  text?: string;
  /** 来源可信度（Source Registry 原样返回；demo_seed 为演示数据，不得引用）。 */
  reliability?: string;
  source_license_id?: string;
  license_note?: string;
  as_of: string;
  note: string;
  checked_at: string;
}

const CN_NUM = "0-9零〇一二两三四五六七八九十百千";
const ARTICLE_RE = new RegExp(`^第?([${CN_NUM}]+)条?((?:第[${CN_NUM}]+[款项目])*)$`);

/** 条号写法 → 整数（数字、阿拉伯数字串、“第五百八十五条”“第585条”；“第二款”等下级单位只认不取）。 */
export function parseArticleNo(article: unknown): number | null {
  if (typeof article === "number") return Number.isInteger(article) && article >= 1 ? article : null;
  if (typeof article !== "string") return null;
  const t = article.replace(/\s+/g, "").replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  const m = ARTICLE_RE.exec(t);
  if (!m) return null;
  const n = cnToInt(m[1]!.replace(/〇/g, "零").replace(/两/g, "二"));
  return n !== null && n >= 1 && n <= 9999 ? n : null;
}

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function findRows(lawdb: Lawdb, law: string): LawVersionRow[] {
  let rows = lawdb.findLawVersions(law);
  for (const name of lawNameCandidates(law)) {
    if (rows.length > 0) break;
    rows = lawdb.findLawVersions(name);
  }
  return rows;
}

export function lawGetArticle(lawdb: Lawdb, params: LawGetArticleParams): LawArticleResult {
  const law = typeof params?.law === "string" ? params.law.trim() : "";
  if (!law) throw new DomainError("validation", "law.get_article 需要 law（法名或简称）", 422);
  // “第一百二十条之一”这类条号（v9.4 复核 Q1-05）：法规库按整数条号存储，不能取；如实说明，不报“写法不对”——否则模型会改传 120、拿到别的条文
  if (typeof params.article === "string" && /之[一二三四五六七八九十]+\s*$/.test(params.article.replace(/[款项目]$/, "").trim())) {
    return { found: false, reason: "article_suffix_unsupported", as_of: params.as_of ?? localToday(), note: "该条为“之 N”条，法规库按整数条号存储，不提供文本：须律师查官方文本核对；不要改用主条号代替", checked_at: new Date().toISOString() };
  }
  const articleNo = parseArticleNo(params.article);
  if (articleNo === null) throw new DomainError("validation", "law.get_article 的 article 须为条号整数或“第五百八十五条”这类写法", 422);
  const asOf = params.as_of ?? localToday();
  // 真实日期才收（v9.4 复核 Q1-06：原来 2026-13-45 也能过，按字符串比较选版本）
  const asOfDate = new Date(`${asOf}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || Number.isNaN(asOfDate.getTime()) || asOfDate.toISOString().slice(0, 10) !== asOf) throw new DomainError("validation", "law.get_article 的 as_of 须为真实日期 YYYY-MM-DD", 422);
  const checkedAt = new Date().toISOString();
  const rows = findRows(lawdb, law);
  if (rows.length === 0) {
    return { found: false, reason: "law_not_in_lawdb", article_no: articleNo, as_of: asOf, note: "法规库未收录该法源：不提供条文文本，须律师查官方文本核对", checked_at: checkedAt };
  }
  const v = versionAt(rows, asOf);
  if (!v) {
    return {
      found: false,
      reason: "no_applicable_version",
      law_name: rows[0]!.law_name,
      article_no: articleNo,
      as_of: asOf,
      note: `法规库内该法在 ${asOf} 没有适用版本（库内版本施行日：${rows.map((r) => r.effective).join("、")}）`,
      checked_at: checkedAt,
    };
  }
  const base = {
    law_name: v.law_name,
    lsv_id: v.lsv_id,
    effective: v.effective,
    superseded: v.superseded,
    effectiveness: v.effectiveness,
    article_no: articleNo,
    source_license_id: v.source_license_id,
    as_of: asOf,
    checked_at: checkedAt,
  };
  if (articleNo > v.total_articles) {
    return { found: false, reason: "article_not_exist", ...base, note: `该版本共 ${v.total_articles} 条，第 ${articleNo} 条不存在` };
  }
  const text = lawdb.getArticle(v.lsv_id, articleNo);
  if (text === null) {
    return { found: false, reason: "text_not_collected", ...base, note: "条号存在，但法规库尚未采集该条正文：不提供文本，须律师查官方文本核对" };
  }
  // 引用原文与送入模型上下文两个动作都要来源授权（Source Registry §2.2；Lawdb.getArticle 注释：送模型前须 assertAction model）
  lawdb.assertAction(v.source_license_id, "quote");
  lawdb.assertAction(v.source_license_id, "model");
  const reliability = lawdb.getSource(v.source_license_id)?.reliability ?? "";
  return {
    found: true,
    ...base,
    text,
    reliability,
    license_note: lawdb.licenseNoteOf(v.source_license_id),
    note:
      reliability === "demo_seed"
        ? "演示数据（reliability=demo_seed），不得作为正式引用；正式引用以官方公报文本为准"
        : "法规库采集原文；是否支持结论由律师比对判断（本工具不判支持）",
  };
}
