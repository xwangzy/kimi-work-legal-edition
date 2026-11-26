/**
 * 任务页“结论 · 答复摘要”每行的截断（第 71 批，区域 8）：原先每行硬截 80 字，第 70 批验收那单截在“…测算，净...”——
 * 最要紧的“净回收多少”正好被省略号吃掉。现在：80 字以内原样；更长的截到第 80 字之后最近的句末（。！？；），句子不超过 180 字就整句保留；
 * 没有句末的在 180 字以内最后一个逗号、顿号处截断加“…”。不截断〔代号〕。纯函数。
 */
const SENTENCE_END = /[。！？；]/u;
const CLAUSE_END = /[，、：]/u;

function safeCut(cs: string[], end: number): string {
  let cut = cs.slice(0, end).join("");
  const open = cut.lastIndexOf("〔");
  if (open > cut.lastIndexOf("〕")) cut = cut.slice(0, open);
  return cut;
}

export function summaryClip(line: string, soft = 80, hard = 180): string {
  const cs = [...line];
  if (cs.length <= soft) return line;
  for (let i = soft - 1; i < Math.min(cs.length, hard); i++) {
    if (SENTENCE_END.test(cs[i]!)) {
      const kept = safeCut(cs, i + 1);
      return i + 1 >= cs.length ? kept : `${kept}…`;
    }
  }
  if (cs.length <= hard) return line;
  for (let i = hard - 1; i >= soft; i--) {
    if (CLAUSE_END.test(cs[i]!) || SENTENCE_END.test(cs[i]!)) return `${safeCut(cs, i).replace(/[，、：\s]+$/u, "")}…`;
  }
  return `${safeCut(cs, hard)}…`;
}
