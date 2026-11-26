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

/** 含金额的句子：数字（可带千分位、小数）后跟“元 / 万元”。 */
const AMOUNT = /\d[\d,]*(?:\.\d+)?\s*万?元/u;

/**
 * 结论摘要的头一句要有关键数字（第 71 批第二轮，区域 8）：摘要是模型最终答复的前几行（不是本机拼的），常以“已完整读取 3 份材料”开头，
 * 律师要的“净回收多少”在后面。展示时从答复正文里找第一个含金额的句子提到第一行，其余照原顺序；正文里没有金额的原样不动。
 * 不改模型输出、不改成果文件，只改这块摘要的显示顺序。lines 是去掉 Markdown 记号后的各行（全文）。纯函数。
 */
export function leadWithAmount(lines: readonly string[], keep = 3): string[] {
  const head = lines.slice(0, keep);
  if (head.length === 0 || AMOUNT.test(head[0]!)) return head;
  for (const l of lines) {
    const sentences = l.split(/(?<=[。；！？])/u);
    const hit = sentences.find((x) => AMOUNT.test(x));
    if (!hit) continue;
    const lead = hit.trim().replace(/[；，、]$/u, "。");
    const rest = lines.filter((x) => x !== l || sentences.length > 1).map((x) => (x === l ? x.replace(hit, "").trim() : x)).filter((x) => x.length > 0);
    return [lead, ...rest].slice(0, keep);
  }
  return head;
}

/** 数字与汉字之间加空格（“3份”→“3 份”、“514,335.00元”→“514,335.00 元”），与全库写法一致；只用于显示。纯函数。 */
export function spaceDigitsCjk(s: string): string {
  return s.replace(/(\d)([一-龥])/gu, "$1 $2").replace(/([一-龥])(\d)/gu, "$1 $2");
}
