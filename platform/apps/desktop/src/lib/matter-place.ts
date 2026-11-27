/**
 * 发送时就地归属事项（第 72 批，D-301）：律师写好任务、按发送，还没选事项时在事项芯片处问“放进哪个事项？”，
 * 新建事项时按任务描述预填名称与我方立场——只用规则抽取，不调用模型（描述还没归属事项，不能出站）。
 *
 * 例：“审查这份股权转让协议，我方为受让方” → 名称“股权转让协议审查（受让方）”、立场“受让方”。
 */

const ACTIONS = ["审查", "审核", "起草", "修改", "修订", "分析", "整理", "梳理", "核查", "研究", "准备", "撰写", "回复", "答复", "评估"];
const OBJECT_END = /(协议|合同|起诉状|答辩状|上诉状|申请书|仲裁申请|章程|律师函|催告函|函件|意见书|法律意见|备忘录|案卷|证据|材料|条款|方案|报告|规章制度|制度)$/;

/** 我方立场：“我方为受让方”“我们是原告”“代理被告”……只认 stances 里有的写法。 */
export function suggestStance(goal: string, stances: readonly string[]): string | null {
  const text = goal.replace(/\s+/g, "");
  const m = /(?:我方|我们|本方|委托人|客户)(?:为|是|系|作为)?([^，,。；;：:、）)（(]{1,6})/.exec(text) ?? /代理([^，,。；;：:、）)（(]{1,6})/.exec(text);
  const cand = m?.[1] ?? "";
  // 最长匹配：“被上诉人”不被认成“上诉人”
  const hit = [...stances].sort((a, b) => b.length - a.length).find((s) => cand.startsWith(s));
  return hit ?? null;
}

/** 事项名称：动作 + 对象 → “对象动作”，再带上立场；抽不出时取描述第一句（不超过 18 字）。 */
export function suggestMatterTitle(goal: string, stances: readonly string[]): string {
  const text = goal.replace(/\s+/g, "").replace(/[/@]$/, "");
  if (!text) return "";
  const stance = suggestStance(text, stances);
  let core = "";
  for (const a of ACTIONS) {
    const i = text.indexOf(a);
    if (i < 0) continue;
    const rest = text.slice(i + a.length).replace(/^(这份|这个|这些|该|本|一份|一下|下)/, "");
    const clause = rest.split(/[，,。；;：:！!？?]/)[0] ?? "";
    // 对象取到“协议 / 合同 / 起诉状……”为止
    let obj = "";
    for (let k = Math.min(clause.length, 16); k >= 2; k--) {
      if (OBJECT_END.test(clause.slice(0, k))) {
        obj = clause.slice(0, k);
        break;
      }
    }
    if (obj) {
      core = `${obj}${a}`;
      break;
    }
  }
  if (!core) core = (text.split(/[，,。；;！!？?\n]/)[0] ?? text).slice(0, 18);
  return stance && !core.includes(stance) ? `${core}（${stance}）` : core;
}
