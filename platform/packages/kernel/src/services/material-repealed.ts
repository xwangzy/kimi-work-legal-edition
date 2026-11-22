/**
 * 材料里引用的已废止规定（V32；第 57 批全量验收案件汇报一单）：我方此前提交的答辩意见以《合同法解释（二）》第二十四条“三个月异议期”抗辩，
 * 该解释已于 2021-01-01 废止；成果从未明引它，而已废止识别只查成果里的明引，起草与独立复核连续两轮都没报。
 * 做法：对事项材料文字跑与 citations.verify 同一套已废止识别（REPEALED_LAWS），命中时给起草方的提示与独立复核的输入各加一段简短说明。
 * 口径（主会话 11-22 补充）：历史合同、旧文书引用旧法本身正常，写“请核对现行效力”，不写“错误”；现行替代规定只写到能确定的编、章或司法解释。
 * 纯函数：只读传入的文字，不查库。
 */
import { extractCitations, joinCitationCells } from "../tools/tools/citations.ts";
import { intToCn } from "../tools/tools/cn-numerals.ts";
import { repealedInfo } from "../tools/tools/law-names.ts";

export interface RepealedInMaterial {
  /** 材料里的写法（书名号去掉）。 */
  law: string;
  /** 材料里引到的条号（只提到名称、没写条号的为空）。 */
  articles: number[];
  on: string;
  by: string;
  successor: string | null;
}

const MAX_ITEMS = 6;
const TITLE_RE = /《((?:[^《》〈〉\n]|〈[^〈〉\n]{1,40}〉){2,80}?)》/g;

/** 事项材料里引用的、分析截止日已废止的法律与司法解释（同一部合并条号；按首次出现先后）。 */
export function repealedInMaterials(texts: readonly string[], asOf: string): RepealedInMaterial[] {
  const out = new Map<string, RepealedInMaterial>();
  const add = (law: string, article: number | null) => {
    const rep = repealedInfo(law);
    if (!rep || !(asOf >= rep.on)) return;
    const key = `${rep.by}|${rep.successor ?? ""}|${law.replace(/^中华人民共和国/, "").replace(/[〈〉《》（）()]/g, "")}`;
    const cur = out.get(key) ?? { law: law.replace(/〈/g, "《").replace(/〉/g, "》"), articles: [], on: rep.on, by: rep.by, successor: rep.successor ?? null };
    if (article !== null && !cur.articles.includes(article)) cur.articles.push(article);
    out.set(key, cur);
  };
  for (const text of texts) {
    if (!text) continue;
    try {
      for (const c of extractCitations(joinCitationCells(text))) add(c.law, c.article);
    } catch {
      // 提取出错的材料跳过
    }
    // 只写了名称没写条号的（“依据《合同法》的规定”）：只认书名号标题，不认无书名号的“合同法”（“合同法律关系”不是引用）
    for (const m of text.matchAll(TITLE_RE)) add(m[1]!, null);
  }
  return [...out.values()];
}

const label = (r: RepealedInMaterial) => {
  const name = r.law.replace(/^中华人民共和国/, "");
  return `《${name}》${r.articles.length > 0 ? r.articles.map((n) => `第${intToCn(n)}条`).join("、") : ""}`;
};
const one = (r: RepealedInMaterial) => `${label(r)}已于 ${r.on} 废止（${r.by}）${r.successor ? `，现行对应规定见${r.successor}` : ""}`;

/** 给起草方的一段提示（含行尾换行；没有命中返回空串）。 */
export function materialRepealedPromptLine(texts: readonly string[], asOf: string): string {
  const hits = repealedInMaterials(texts, asOf);
  if (hits.length === 0) return "";
  const list = hits.slice(0, MAX_ITEMS).map(one).join("；");
  const more = hits.length > MAX_ITEMS ? `；另有 ${hits.length - MAX_ITEMS} 处未列` : "";
  return `【材料中的已废止规定】材料里引用的${list}${more}。历史合同、旧文书引用旧法本身正常；但凡据此提出或延续的主张、抗辩，请核对现行效力：行为发生在废止之前的，按《民法典时间效力规定》等核对能否适用旧法；不能适用的，改依现行规定论证，并在交付件里写明。这段是系统对照法规库的效力记录得出的提示，不是律师的说明：成果里写废止情况时以法规本身为据（如“该解释已随民法典施行于 2021 年 1 月 1 日废止”），不写“按你提供的说明”“依任务说明”。\n`;
}

/** 给独立复核人的说明（每处一行；没有命中返回空数组）。 */
export function materialRepealedReviewLines(texts: readonly string[], asOf: string): string[] {
  const hits = repealedInMaterials(texts, asOf);
  return hits.slice(0, MAX_ITEMS).map((r) => `【材料】${one(r)}：交付件据此提出或延续主张的，核对是否写明了适用旧法的依据（行为发生时间与时间效力规定）或已改依现行规定；没有的，列为问题。`);
}
