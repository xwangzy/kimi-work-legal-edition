/**
 * law.get_version / law.search（确定性，方案 §9：法条核验全部离线完成——
 * 名称归一、条号存在性、按适用时点取版本、效力状态、条号迁移表）。
 * 数据源为签名法规库包（@zr-legal/lawdb）；注册库没有就明说，故障不伪造法源（§4.1 W3）。
 */
import { DomainError } from "@zr-legal/domain";
import { versionAt, type Lawdb } from "@zr-legal/lawdb";

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
