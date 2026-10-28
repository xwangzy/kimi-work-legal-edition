/**
 * 交付件里的待补占位（第 28 批，偏离 D-154 的回归项）：文书方法改为“信息不全照样出草稿”，缺项写【待填】、未经律师确认的事实标【待确认】、
 * 金额写【金额待测算确认】……这些占位不能随签发版发出——复核页列出个数，签发须律师勾选“已知悉，发出前补齐”（与材料缺口同一做法）。
 * 只认【】里带“待”字的短占位（≤ 24 字），不认正文里的普通方括号。纯函数。
 */
const PLACEHOLDER = /【[^】\n]{0,24}待[^】\n]{0,24}】/g;

export function placeholdersOf(text: string): { total: number; kinds: { text: string; n: number }[] } {
  const counts = new Map<string, number>();
  for (const m of text.matchAll(PLACEHOLDER)) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
  const kinds = [...counts].map(([t, n]) => ({ text: t, n })).sort((a, b) => b.n - a.n).slice(0, 8);
  return { total: [...counts.values()].reduce((a, b) => a + b, 0), kinds };
}
