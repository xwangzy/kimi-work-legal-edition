/**
 * 重复表述检查（第 61 批真实复测 m25-r4）：修改轮用 docx.edit_draft 改写一句后，原句没删干净，对外答辩书同一段里出现
 * “《劳动法》第二十五条第（二）项及《劳动合同法》第三十九条第（二）项规定，劳动者严重违反……可以解除劳动合同。《劳动法》第二十五条第（二）项规定，
 * 劳动者严重违反……可以解除劳动合同。”——交付前检查与回看都没有拦住。
 *
 * 判定：同一段内或相邻两段，两句话（去掉书名号内的法名、条款项编号、标点空白后）有 ≥ 20 字相同的连续文字，报回。
 * 书名号、条号、数字先去掉：同一段两次引用同一部法律、分段计息的几行请求只差数字，都不算重复。只看正文段落，不看表格。纯函数。
 */
export interface RepeatIssue {
  where: string;
  text: string;
}

export const REPEAT_MIN = 20;
export const REPEAT_FIX = "同一段（或相邻两段）里有一句话与前一句重复（改写后原句没删干净）：保留一句，删去重复的那句或合并成一句";

/** 去掉书名号内的名称、条款项编号与标点空白，留下比较用的文字。 */
export function repeatNorm(s: string): string {
  return s
    .replace(/《[^《》]{1,60}》/g, "")
    .replace(/第[一二三四五六七八九十百千零〇\d]+条(?:之[一二三四五六七八九十])?(?:第[一二三四五六七八九十\d]+款)?(?:第?[（(][一二三四五六七八九十\d]+[）)]项?)?/g, "")
    // 数字、金额、日期也去掉：分段计息的请求（“以510,000元为基数，自……计至……；”）与首部地址行只是数字或地址相同，不算重复（回放本批 42 份真实 Word 的误报）
    .replace(/[0-9０-９.,，%％]+/g, "")
    .replace(/[\s，。；：、“”‘’「」（）()《》,.;:!?！？—-]/g, "");
}

/** 两段文字最长的公共连续子串长度（动态规划，句子都不长）。 */
function longestCommon(a: string, b: string): number {
  if (!a || !b) return 0;
  let best = 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1]! + 1;
        if (cur[j]! > best) best = cur[j]!;
      }
    }
    prev = cur;
  }
  return best;
}

const sentencesOf = (t: string): string[] => t.split(/(?<=[。；！？])/).map((x) => x.trim()).filter(Boolean);

export function repeatIssues(paras: readonly { where: string; text: string }[]): RepeatIssue[] {
  const out: RepeatIssue[] = [];
  const sents = paras.map((p) => sentencesOf(p.text).map((s) => ({ raw: s, norm: repeatNorm(s) })).filter((s) => s.norm.length >= REPEAT_MIN));
  for (let pi = 0; pi < paras.length; pi++) {
    const here = sents[pi]!;
    const pool = [...here.map((s, k) => ({ s, k, same: true })), ...(sents[pi + 1] ?? []).map((s, k) => ({ s, k, same: false }))];
    let hit = false;
    for (let a = 0; a < here.length && !hit; a++) {
      for (const b of pool) {
        if (b.same && b.k <= a) continue;
        if (longestCommon(here[a]!.norm, b.s.norm) >= REPEAT_MIN) {
          out.push({ where: b.same ? paras[pi]!.where : `${paras[pi]!.where}与下一段`, text: b.s.raw.slice(0, 60) });
          hit = true;
          break;
        }
      }
    }
    if (out.length >= 6) break;
  }
  return out;
}
