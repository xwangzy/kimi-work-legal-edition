/**
 * 公开官方站点基线（第 04 篇 §5.1 `/fetch`：“域名白名单与公开官方站点基线”；第 02 篇 §11.2“白名单域名自动”）：
 * 国家与监管机关、法院与检察机关、法定信息披露平台。按可注册域名列出（含其子域名）；律所策略可在此之上追加。
 * 只列具体机关域名，不放开整个 gov.cn 后缀——清单可审计，变更随签名策略分发（G1）。
 */
export const OFFICIAL_SITE_BASELINE: readonly string[] = Object.freeze([
  // 立法、行政与法律法规数据库
  "npc.gov.cn",
  "www.gov.cn",
  "moj.gov.cn",
  // 法院与检察
  "court.gov.cn",
  "chinacourt.org",
  "spp.gov.cn",
  // 市场监管、金融与证券监管
  "samr.gov.cn",
  "gsxt.gov.cn",
  "csrc.gov.cn",
  "pbc.gov.cn",
  "nfra.gov.cn",
  "safe.gov.cn",
  // 其他部委与监管机关
  "cac.gov.cn",
  "mohrss.gov.cn",
  "chinatax.gov.cn",
  "mofcom.gov.cn",
  "cnipa.gov.cn",
  "miit.gov.cn",
  "ndrc.gov.cn",
  "sasac.gov.cn",
  "mee.gov.cn",
  "mnr.gov.cn",
  "mohurd.gov.cn",
  // 法定信息披露平台与交易所
  "sse.com.cn",
  "szse.cn",
  "bse.cn",
  "cninfo.com.cn",
  "hkexnews.hk",
  "elegislation.gov.hk",
]);
