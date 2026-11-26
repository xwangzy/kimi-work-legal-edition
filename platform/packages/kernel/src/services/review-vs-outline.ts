/**
 * 复核意见与律师已确认的论点冲突时交律师决定（第 65 批，V39，D-290）。
 *
 * 劳动仲裁答辩卡（m25）连续三批（第 61 批 r2、r4，第 65 批）同一个模式：律师在确认卡上确认了“以《员工手册（2021版）》为主依据、2023 版未经民主程序不作直接依据”，
 * 独立复核却把“以 2021 版为主依据”判为“必须改”、要求删掉改依 2023 版——这在法律上不成立（2023 版未经民主程序，劳动合同法第四条、劳动争议解释（一）第五十条），
 * 修改轮照改，把对的依据改坏，三份文件口径也被改乱。复核是另起的一次模型调用，看不到律师确认时的取舍；它推翻律师已确认的立场时，不该由系统自动执行。
 *
 * 确定性规则：复核的“必须改”意见里，**要求删除、不得以、改用**某份文件（书名号里的合同、制度、手册等，不含法律法规与司法解释）作依据，
 * 而这份文件正是律师已确认的论点所依据的——降为“建议改”，问题前写明“与律师已确认的论点冲突，交律师决定”，修改轮不自动执行；律师认可的，在任务页勾选后按意见修改（D-223）。
 * 意见先要求补足论证（“补足……；不能补强的，再改依据”）的仍为必须改，但修改轮只补足、不换依据（第 65 批 m25-r3 复核原文）。
 * 条号写错、引文不符、金额算错这类意见不受影响（不是在推翻依据的取舍）。纯函数。
 */
import type { ReviewFinding } from "./independent-review.ts";

export interface ConfirmedArgumentText {
  claim: string;
  /** 论点下各依据的法名、说明、要件与但书处理、所挂事实的陈述——拼成文字即可 */
  texts: readonly string[];
}

/** 书名号里的法律、法规、规章、司法解释（这些的条号与版本更正不在本规则范围内）。 */
const LAW_LIKE = /法》?$|法（|条例|规定|解释|办法|决定|纪要|通知|意见|规则$|细则/;
const REVERSAL = /删除[^。；]{0,40}依据|删去[^。；]{0,40}依据|不得以|不能以|不应以|不再以|不宜以|(?:不再|不得|不能|不应|不宜)?将[^。；]{0,24}作为[^。；]{0,12}依据|不得作为[^。；]{0,10}依据|不能作为[^。；]{0,10}依据|不应作为[^。；]{0,10}依据|改以|改用|改为以|改依/;
/** 先要求补足这份文件的论证、事实链或回应其问题（“补足……；不能补强的，再……”）：是在加强律师选的依据，不是推翻 */
const STRENGTHEN = /补足|补强|补充[^。；]{0,12}(?:依据|论证|事实|理由)|回应|说明其[^。；]{0,12}(?:关系|效力|适用)/;

const norm = (s: string) => s.replace(/\s+/g, "").replace(/[（(]/g, "(").replace(/[）)]/g, ")");

/** 文件名的几种写法：全称；带版本年的另认“2021版 + 名词尾两字”（“2021版手册”“该 2021 版员工手册”）。 */
function mentions(name: string, flat: string): boolean {
  const key = norm(name);
  if (flat.includes(key)) return true;
  const y = /(\d{4})\s*(?:年)?\s*(?:版|修订版|修订)/.exec(name);
  if (!y) return false;
  const noun = key.replace(/\(?\d{4}(?:年)?(?:版|修订版|修订)\)?/, "");
  const tail = noun.slice(-2);
  if (tail.length < 2) return false;
  const re = new RegExp(`${y[1]}年?(?:版|修订版)[^。；，,]{0,6}${tail}|${tail}[^。；，,]{0,6}[(（]?${y[1]}年?(?:版|修订版)`);
  return re.test(flat);
}

/** 已确认论点里出现过的非法规文件名（书名号内）。 */
export function confirmedDocuments(args: readonly ConfirmedArgumentText[]): string[] {
  const out = new Set<string>();
  for (const a of args) {
    for (const t of [a.claim, ...a.texts]) {
      const text = String(t ?? "");
      for (const m of text.matchAll(/《([^》]{2,40})》/g)) {
        const name = m[1]!.trim();
        if (LAW_LIKE.test(name)) continue;
        out.add(name);
      }
      // 第 65 批真实验收 v39-m25-r4：确认卡上写的是“2021版手册”“2021版员工手册”（没有书名号）——带版本年的单位文件不加书名号也认
      for (const m of text.matchAll(/(\d{4})\s*年?版\s*([一-龥]{0,6}(?:手册|制度|守则|规范|规程|章程|合同|协议))/g)) out.add(`${m[2]}（${m[1]}版）`);
      for (const m of text.matchAll(/([一-龥]{2,8}(?:手册|制度|守则|规范|规程))\s*[（(]\s*(\d{4})\s*年?版\s*[）)]/g)) out.add(`${m[1]}（${m[2]}版）`);
    }
  }
  return [...out];
}

export function downgradeAgainstConfirmed(findings: readonly ReviewFinding[], args: readonly ConfirmedArgumentText[]): { findings: ReviewFinding[]; downgraded: number[] } {
  const docs = confirmedDocuments(args).map((d) => ({ raw: d, key: norm(d) }));
  if (docs.length === 0) return { findings: [...findings], downgraded: [] };
  const downgraded: number[] = [];
  const extra: ReviewFinding[] = [];
  const out = findings.map((f) => {
    if (!f.must || f.machine_key) return f;
    const text = `${f.problem} ${f.fix}`;
    if (!REVERSAL.test(text)) return f;
    const flat = norm(text);
    const hit = docs.find((d) => mentions(d.raw, flat));
    if (!hit) return f;
    // 先要求补足论证的（有条件的推翻）：仍是必须改，但修改轮只补足、不换依据——换不换由律师定。
    // 看改法里先提的是哪一种（第 65 批：r3 先“补足……，不能补强的再改依据”；r4 先“删除以 2021 版作为依据……若仍主张须补足”）
    const rev = REVERSAL.exec(f.fix);
    const str = STRENGTHEN.exec(f.fix);
    if (str && (!rev || str.index < rev.index)) {
      return {
        ...f,
        fix: `${f.fix}（律师已确认以《${hit.raw}》为依据：修改轮只补足论证与事实链、回应其中指出的问题，不改变依据的取舍；补不起来的，在最终答复里写明，由律师决定是否改依据）`,
      };
    }
    downgraded.push(f.no);
    const down: ReviewFinding = {
      ...f,
      must: false,
      level: "should" as const,
      problem: `【与律师已确认的论点冲突，交律师决定】${f.problem}`,
      fix: `${f.fix}（律师在确认论点时已确认以《${hit.raw}》为依据；系统不自动按这条意见修改。律师认可的，在任务页勾选这条后按意见修改）`,
    };
    // 拆开而不是整条降级（第 65 批真实验收 v39-m25-r5 评分）：同一条意见里不推翻依据、只要求补强的部分（回应废止、说明与解除通知的关系、补衔接论证），
    // 与律师确认的论点不冲突，照常作为必须改进修改轮
    const keep = f.fix.split(/(?<=[；;。])/).filter((x) => STRENGTHEN.test(x) && !REVERSAL.test(x) && !/删去|删除|弃用|不再/.test(x)).join("").trim();
    if (keep) extra.push({ ...f, no: -1, problem: `（律师已确认以《${hit.raw}》为依据）${f.problem}`, fix: `围绕律师已确认的《${hit.raw}》补足论证，不改变依据：${keep}` });
    return down;
  });
  // 拆出来的补强意见编在最后
  let next = out.reduce((n, x) => Math.max(n, x.no), 0);
  for (const x of extra) out.push({ ...x, no: ++next });
  return { findings: out, downgraded };
}
