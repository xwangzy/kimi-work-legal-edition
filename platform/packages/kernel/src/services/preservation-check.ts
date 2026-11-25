/**
 * 保全数额的构成（第 65 批，V39，D-289）：财产保全申请书的请求保全数额要写明由哪几项拟主张（或已主张）的请求组成。
 *
 * 民事诉讼法第一百零五条：保全限于请求的范围，或者与本案有关的财物（法规库原文已核）。第 61 批 m11-sim 与第 65 批 m11 两次真实验收都是同一个问题：
 * 申请书只写“以 41 万元为限、未超过对账确认的未付款”，没写 41 万由本金、违约金、律师费各多少组成，而对账未付款里还含尚未到期的质保金——
 * 法院审查保全数额是否超出请求范围时，申请书本身就答不上来。确定性规则：请求事项里的保全数额，在文书里要有构成（几项金额相加等于它，
 * 或写明“由……组成 / 其中本金……”且列出了至少两项金额）。纯函数，只看文书本身。
 */

interface Para {
  where: string;
  text: string;
}

export interface PreservationIssue {
  kind: "claims";
  where: string;
  text: string;
  fix: string;
}

const TITLE_RE = /保全申请书/;
const NOT_DOC = /说明|清单|核对|对照|意见|分析|提纲|要点/;
const REQUEST_HEAD = /^\s*(?:[一二三四五六七八九十]+、\s*)?(?:请求事项|申请事项|保全请求|申请请求)\s*[:：]?/;
const NEXT_HEAD = /^\s*(?:[一二三四五六七八九十]+、\s*)?(?:事实与理由|事实和理由|理由|被保全财产|担保|此致)/;
const AMOUNT_RE = /(?:人民币|￥|¥)?\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*(万元|元)/g;

function amounts(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(AMOUNT_RE)) {
    const n = Number(m[1]!.replace(/,/g, ""));
    if (!Number.isFinite(n)) continue;
    out.push(m[2] === "万元" ? Math.round(n * 10000 * 100) / 100 : n);
  }
  return out;
}

/** 一段里有没有加起来等于 target 的两到六项金额（容差 1 元；不含 target 本身）。 */
function sumsTo(values: readonly number[], target: number): boolean {
  const xs = values.filter((v) => v > 0 && Math.abs(v - target) > 0.5 && v < target).slice(0, 14);
  const n = xs.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    let bits = 0;
    let s = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) {
      bits++;
      s += xs[i]!;
    }
    if (bits >= 2 && bits <= 6 && Math.abs(s - target) <= 1) return true;
  }
  return false;
}

export function preservationAmountIssues(title: string, paras: readonly Para[]): PreservationIssue[] {
  const t = String(title ?? "").replace(/\s+/g, "");
  if (!TITLE_RE.test(t) || NOT_DOC.test(t)) return [];
  const body = paras.filter((p) => p.where !== "标题");
  const start = body.findIndex((p) => REQUEST_HEAD.test(p.text));
  if (start < 0) return [];
  const req: Para[] = [];
  const firstLine = body[start]!.text.replace(REQUEST_HEAD, "").trim();
  if (firstLine) req.push({ where: body[start]!.where, text: firstLine });
  for (const p of body.slice(start + 1)) {
    if (NEXT_HEAD.test(p.text)) break;
    req.push(p);
    if (req.length > 8) break;
  }
  const reqAmounts = req.flatMap((p) => amounts(p.text));
  if (reqAmounts.length === 0) return [];
  const target = Math.max(...reqAmounts);
  if (target < 1000) return [];
  // 构成：同一段里几项金额相加等于保全数额，或写明“由……组成 / 包括 / 其中”且这段除保全数额外还列了至少两项金额
  const composed = body.some((p) => {
    const xs = amounts(p.text);
    if (sumsTo(xs, target)) return true;
    const others = xs.filter((v) => Math.abs(v - target) > 0.5);
    return /(?:由|系)[^。；]{0,30}(?:组成|构成)|构成为|包括|其中[^。；]{0,6}(?:本金|货款|价款|欠款)/.test(p.text) && others.length >= 2 && xs.some((v) => Math.abs(v - target) <= 0.5);
  });
  if (composed) return [];
  const where = req.find((p) => amounts(p.text).some((v) => v === target))?.where ?? body[start]!.where;
  const shown = target >= 10000 && target % 10000 === 0 ? `${target / 10000} 万元` : `${target.toLocaleString("en-US")} 元`;
  return [
    {
      kind: "claims",
      where,
      text: `请求保全数额 ${shown}`.slice(0, 60),
      fix: `保全限于请求的范围（民事诉讼法第一百零五条）：写明 ${shown} 由哪几项拟主张的请求组成（如“本金……元＋逾期付款违约金暂计……元＋律师费……元＝……元”），只计已届满、本次要起诉（或已起诉）的请求；不以含尚未到期款项的对账余额或合同总欠款作为限额理由`,
    },
  ];
}
