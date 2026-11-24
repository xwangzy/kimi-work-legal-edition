/**
 * 法律用语确定性检查（第 61 批，D-262；外部评估 R1 legal-terminology 一节的“低误报”规则，R4 legal-judgment-prediction 的反向吸收）。
 *
 * 只收判定条件明确、误报低的几条，接入交付前检查（kind: "term" / "prediction"），由助手在生成当下按 fix 改：
 * - T1 “法人代表” → 法定代表人（民法典第六十一条的用语）；
 * - T2 首部当事人称谓与文书类型不符（起诉状写“申请人：”、仲裁文书写“原告：”、上诉状写不带“原审”的“原告：”）；
 * - T3 仲裁文书的请求写“判令”，诉状、上诉状写“裁决被告”；
 * - T4 劳动仲裁文书写“诉讼时效”（劳动争议调解仲裁法第二十七条是“仲裁时效”）；
 * - T5 分公司、合伙企业、律师事务所的首部写“法定代表人”（应为负责人、执行事务合伙人）；
 * - T6 已废止的法律、司法解释只写法名不写条号、又没写明是行为时法（引用核验只认带条号的）；
 * - T7 会议纪要（九民纪要）在递交法院的文书里作为请求或裁判依据援引；
 * - P1 胜诉率、败诉概率、“大概率支持”、“N% 的可能”（工作准则第 7 条：不预测裁判结果）。
 * 引号、书名号里的原话不报（转引对方文书、证据标题时照原文）。需要语境判断的（甲方乙方、解除与终止、定金与订金单独出现）不做规则，交独立复核。纯函数。
 */
import { repealedInfo } from "../tools/tools/law-names.ts";

export interface TermPara {
  where: string;
  text: string;
}

export interface TermIssue {
  kind: "term" | "prediction";
  where: string;
  text: string;
  fix: string;
}

/** 去掉引号、书名号里的内容（等长替换为空格，位置不变）：转引原话与文件标题不报。 */
function stripQuoted(s: string): string {
  return s.replace(/“[^”]{0,400}”|「[^」]{0,400}」|‘[^’]{0,200}’|"[^"]{0,400}"/g, (m) => " ".repeat(m.length));
}
function stripTitles(s: string): string {
  return s.replace(/《[^》]{0,80}》/g, (m) => " ".repeat(m.length));
}

function snip(text: string, at: number, len: number): string {
  return text.slice(Math.max(0, at - 6), Math.min(text.length, at + len + 6));
}

type DocType = "complaint" | "appeal" | "arbitration" | "labor_arbitration" | "enforcement" | null;
export function docTypeOf(title: string): DocType {
  const t = title.replace(/\s+/g, "");
  if (/劳动(?:人事)?(?:争议)?仲裁/.test(t) && /(申请书|答辩书)/.test(t)) return "labor_arbitration";
  if (/仲裁/.test(t) && /(申请书|答辩书|反请求)/.test(t)) return "arbitration";
  if (/上诉状/.test(t)) return "appeal";
  if (/(起诉状|反诉状)/.test(t)) return "complaint";
  if (/(强制执行申请书|执行申请书)/.test(t)) return "enforcement";
  return null;
}

/** 首部当事人段：第一个请求或事实部分开始之前的段落（标题、当事人身份）。 */
function headerParas(paras: readonly TermPara[]): TermPara[] {
  const out: TermPara[] = [];
  for (const p of paras) {
    if (/^(?:诉讼请求|仲裁请求|上诉请求|申请事项|请求事项|执行请求|答辩意见|答辩请求|事实(?:与|和)理由|请求)\s*[:：]?\s*$/.test(p.text.trim()) || /^(?:诉讼请求|仲裁请求|上诉请求|申请事项|请求事项)[:：]/.test(p.text.trim())) break;
    out.push(p);
    if (out.length >= 24) break;
  }
  return out;
}

const LABEL_RE = /^\s*(原告|被告|第三人|申请人|被申请人|上诉人|被上诉人|申请执行人|被执行人)\s*(?:[（(][^）)]{0,12}[）)])?\s*[:：]/;

const PREDICTION_RE = /胜诉率|胜诉(?:的)?(?:概率|几率|可能性)\s*(?:约|为|在|达|有)?\s*\d|败诉(?:的)?(?:概率|几率)|大概率(?:支持|胜诉|败诉|获得支持|被支持|被驳回|改判)|(?:法院|仲裁庭)大概率|\d{1,3}(?:\.\d+)?\s*[%％](?:的)?(?:可能|概率|几率|把握)|(?:可能|概率|几率|把握)(?:约|为|在|达|有)?\s*\d{1,3}(?:\.\d+)?\s*[%％]|[七八九]成(?:以上)?(?:的)?(?:把握|胜算|可能)/;

const NON_LEGAL_PERSON_RE = /(分公司|分行|支行|分店|营业部|办事处|（普通合伙）|（有限合伙）|\(普通合伙\)|\(有限合伙\)|合伙企业|律师事务所|个体工商户)/;

export function termIssues(title: string, paras: readonly TermPara[], opts: { asOf?: string } = {}): TermIssue[] {
  const out: TermIssue[] = [];
  const type = docTypeOf(title);
  const body = paras.filter((p) => p.where !== "标题");

  for (const p of body) {
    const t = stripTitles(stripQuoted(p.text));
    // T1
    const lr = /法人代表(?!大会)/.exec(t);
    if (lr) out.push({ kind: "term", where: p.where, text: snip(p.text, lr.index, 4), fix: "“法人代表”不是法律用语：改为“法定代表人”（民法典第六十一条）；指受法人委托的代表人的，写“委托代理人”或“授权代表”" });
    // P1
    const pr = PREDICTION_RE.exec(t);
    // “不评估胜诉率”“不预测……概率”这类否定句是在声明边界，不是预测（第 58 批 48 卡回放：4 处全是这种）
    if (pr && !/(?:不|未|无|非|勿|避免|没有)[^，。；、\n]{0,8}$/.test(t.slice(Math.max(0, pr.index - 10), pr.index))) out.push({ kind: "prediction", where: p.where, text: snip(p.text, pr.index, pr[0].length), fix: "不预测裁判结果（工作准则第 7 条）：删去胜诉率、概率与百分比，改写为风险高低（较高 / 中等 / 较低）与支持、不利的依据" });
    // T3
    if ((type === "arbitration" || type === "labor_arbitration") && /判令/.test(t)) {
      const at = t.indexOf("判令");
      out.push({ kind: "term", where: p.where, text: snip(p.text, at, 2), fix: "仲裁请求写“请求裁决被申请人……”，仲裁庭作出的是裁决，不是判决：把“判令”改为“裁决”" });
    }
    if ((type === "complaint" || type === "appeal") && /裁决(?:被告|被上诉人|对方)/.test(t)) {
      const at = t.search(/裁决(?:被告|被上诉人|对方)/);
      out.push({ kind: "term", where: p.where, text: snip(p.text, at, 4), fix: "向法院提出的请求写“判令”，不写“裁决”" });
    }
    // T8（第 61 批，真实验收 m08 评分）：中文日期写了前导零（“2026年11月09日”）
    const lz = /(?<!\d)\d{4}年0[1-9]月|(?<![\d年])(?:1[0-2]|[1-9])月0[1-9]日|年(?:1[0-2]|[1-9])月0[1-9]日/.exec(t);
    if (lz) out.push({ kind: "term", where: p.where, text: snip(p.text, lz.index, lz[0].length), fix: "中文日期不写前导零：写“2026年11月9日”，不写“11月09日”“2026年03月”" });
    // T4
    if (type === "labor_arbitration" && /诉讼时效/.test(t) && !/仲裁时效/.test(t)) {
      const at = t.indexOf("诉讼时效");
      out.push({ kind: "term", where: p.where, text: snip(p.text, at, 4), fix: "劳动争议申请仲裁适用“仲裁时效”（劳动争议调解仲裁法第二十七条，一年）：改为“仲裁时效”；确指裁决后诉讼阶段的，不需要改，在最终答复里说明" });
    }
    // T7
    if (type && /(?:依据|根据|依照|按照)[^。；\n]{0,16}(?:全国法院民商事审判工作会议纪要|九民纪要)/.test(p.text) && /(?:请求|判令|裁决|应当|依法)/.test(p.text)) {
      const at = p.text.search(/全国法院民商事审判工作会议纪要|九民纪要/);
      out.push({ kind: "term", where: p.where, text: snip(p.text, at, 8), fix: "会议纪要不是司法解释，不能作为裁判依据援引：请求与法律依据写其所依据的法律、司法解释条文，纪要的观点放在说理部分作参考（“参照……的精神”）" });
    }
    // T6
    if (opts.asOf) {
      for (const m of p.text.matchAll(/《([^》]{2,60})》(?!\s*(?:第[一二三四五六七八九十百千零〇\d]+条|[（(]))/g)) {
        const rep = repealedInfo(m[1]!);
        if (!rep || opts.asOf < rep.on) continue;
        const near = p.text.slice(Math.max(0, (m.index ?? 0) - 12), (m.index ?? 0) + m[0].length + 30);
        if (/原《|行为(?:发生)?时|时间效力|当时有效|已废止|已经废止|废止前|施行前|不再适用|已被/.test(near)) continue;
        out.push({ kind: "term", where: p.where, text: m[0], fix: `《${m[1]}》已于 ${rep.on} 废止（${rep.by}）：作现行依据的改引替代规范；作行为时法的，写“原《${m[1]}》”并写明适用旧法的依据（行为发生时间与时间效力规定）` });
      }
    }
  }

  // T2、T5：只看首部当事人段
  if (type) {
    const head = headerParas(body);
    head.forEach((p, i) => {
      const m = LABEL_RE.exec(p.text);
      if (m) {
        const label = m[1]!;
        const wrong =
          (type === "complaint" && /^(?:申请人|被申请人|上诉人|被上诉人)$/.test(label)) ||
          ((type === "arbitration" || type === "labor_arbitration") && /^(?:原告|被告|上诉人|被上诉人)$/.test(label)) ||
          (type === "appeal" && /^(?:原告|被告)$/.test(label)) ||
          (type === "enforcement" && /^(?:原告|被告|上诉人|被上诉人)$/.test(label));
        if (wrong) {
          const want =
            type === "complaint" ? "原告、被告" : type === "appeal" ? "上诉人（原审原告 / 被告）、被上诉人（原审……）" : type === "enforcement" ? "申请执行人、被执行人" : "申请人、被申请人";
          out.push({ kind: "term", where: p.where, text: m[0].trim(), fix: `这份文书首部的当事人称谓应为${want}，不是“${label}”` });
        }
      }
      // T5：名称是分支机构、合伙企业、律所，同段或下一段写“法定代表人”
      if (NON_LEGAL_PERSON_RE.test(p.text.split(/[，,。；]/)[0] ?? "")) {
        const nxt = head[i + 1];
        const target = /法定代表人/.test(p.text) ? p : nxt && /^\s*法定代表人/.test(nxt.text) && !LABEL_RE.test(nxt.text) ? nxt : null;
        if (target) {
          const kind = /合伙/.test(p.text) ? "执行事务合伙人" : /个体工商户/.test(p.text) ? "经营者" : "负责人";
          out.push({ kind: "term", where: target.where, text: "法定代表人", fix: `分支机构、合伙企业、律师事务所、个体工商户不是法人，没有法定代表人：首部写“${kind}”` });
        }
      }
    });
  }
  return out;
}
