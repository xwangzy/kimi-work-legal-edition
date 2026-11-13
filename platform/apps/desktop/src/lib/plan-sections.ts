/**
 * 计划确认卡的折叠（V18 A6）：模型写的计划按节切开，卡片默认只露律师拍板要看的几节，其余“展开全文”。
 * 工作准则第 10 条要求提交审批的计划按四段写：怎么审、步骤、会交出什么、需要你决定的事。
 * 默认露：第一节（要做什么、怎么审）+ 标题里写“会交 / 交出 / 交付 / 成果”或“决定 / 需要你 / 先知道”的节；
 * 折起来的通常是“步骤”。认不出这类标题时退回“露前两节”。节的开头认：Markdown 标题（# …）、整行加粗（**…**）、中文序号（一、…）。
 * 不超过两节、或没有可折的节时不折叠。露出的节保持原文顺序。
 */

const HEADING = /^\s*(#{1,6}\s+\S|\*\*[^*\n]+\*\*\s*[:：]?\s*$|[一二三四五六七八九十]+、)/;
const KEEP_TITLE = /会交|交出|交付|成果|决定|需要你|先知道/;

export interface PlanSplit {
  /** 默认显示的部分（露出的各节，Markdown 原样，按原文顺序）。 */
  head: string;
  /** 折起来的各节标题（去掉 #、** 与冒号），用于“展开全文（还有 1 节：步骤）”；没有折叠时为空。 */
  restTitles: string[];
}

export function splitPlan(text: string, keep = 2): PlanSplit {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  // 每节的起始行号；开头若有不在任何标题下的文字，算作第一节
  const starts: number[] = [];
  let inFence = false;
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) inFence = !inFence;
    if (!inFence && HEADING.test(l)) starts.push(i);
  });
  if (starts.length === 0) return { head: text, restTitles: [] };
  if (lines.slice(0, starts[0]).some((l) => l.trim())) starts.unshift(0);
  if (starts.length <= keep) return { head: text, restTitles: [] };
  const sections = starts.map((s, k) => ({ title: titleOf(lines[s]!), body: lines.slice(s, starts[k + 1] ?? lines.length).join("\n").trimEnd() }));
  let shown = sections.map((s, k) => k === 0 || KEEP_TITLE.test(s.title));
  if (shown.filter(Boolean).length === 1) shown = sections.map((_, k) => k < keep);
  if (shown.every(Boolean)) return { head: text, restTitles: [] };
  return {
    head: sections.filter((_, k) => shown[k]).map((s) => s.body).join("\n\n"),
    restTitles: sections.filter((_, k) => !shown[k]).map((s) => s.title),
  };
}

function titleOf(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/\*\*/g, "")
    .replace(/[:：]\s*$/, "")
    .trim();
}
