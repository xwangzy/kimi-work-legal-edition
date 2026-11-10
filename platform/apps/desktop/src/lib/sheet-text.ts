/**
 * 开始前确认的短说法（V16 A5：确认框信息过密）。内核给的口径不改，界面只把已知的长句缩成一行，全文放进“了解更多”。纯函数。
 */

/** 已知的用量说明（内核 estimate.assumptions）合成一行；认不出的原样返回、不丢。 */
export function usageNoteShort(assumptions: readonly string[]): { line: string; more: string[] } {
  const known = (a: string) => /单任务用量上限|出错没做完|不计入用量/.test(a);
  if (assumptions.length === 0) return { line: "", more: [] };
  if (!assumptions.some(known)) return { line: assumptions.join("；"), more: [] };
  const rest = assumptions.filter((a) => !known(a));
  return { line: ["到上限会先停下来问你；出错没做完的不计", ...rest].join("；"), more: [...assumptions] };
}

/** “发送什么、发给谁”的每一行缩到 26 字以内（只改说法，不改含义；认不出的原样显示）。 */
export function sendPointShort(b: string): string {
  return b
    .replace("（经中软转发）", "（经中软）")
    .replace("发给律所自己的 Kimi 账号", "发给本所 Kimi 账号")
    .replace("发给律所自己的 AI", "发给本所的 AI")
    .replace(/(\d+) 份材料里用到的内容/, "$1 份材料的相关内容")
    .replace("公司名、案情、金额、日期、条款按原文；没认出的姓名也按原文", "公司名、案情、金额按原文；没认出的姓名也按原文")
    .replace("案情、金额、日期、条款按原文；没认出的姓名也按原文", "案情、金额、日期按原文；没认出的姓名也按原文");
}

/** “做什么”：自由描述的任务写明助手会选方法；先看计划时再说一句。 */
export function freeTaskWhat(planFirst: boolean): string {
  return planFirst ? "按你的描述处理（助手会选用合适的方法，开始前先给你看计划）" : "按你的描述处理";
}
