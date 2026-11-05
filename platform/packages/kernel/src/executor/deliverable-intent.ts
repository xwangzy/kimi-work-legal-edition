/**
 * 律师在任务说明里要的交付物是什么（V12 根因修复 R-2）：内核据此核对主交付物，不再只看“助手自己加载了哪个方法”。
 *
 * 真实复现（V12 第一阶段）：任务说明“起草一份起诉状及证据目录”“起草采购合同，附违约金计算方式”被首页建议成“整理案卷”“金额测算”
 * （主交付物都是 Excel），自由描述的任务里助手没加载方法或只加载了表格类方法时，内核不核对主交付物，只交 Excel 也记“已完成”。
 * 交付物的类型由律师的请求决定：请求句里有“起草 / 撰写 / 拟 / 写一份 / 出具 / 修改 / 修订”等动作且宾语是一份文书（合同、协议、
 * 起诉状、意见书、律师函……）时，主交付物是 Word；律师明确点名 Excel / 表格形式时按律师的。纯函数，只看文字，不调用模型。
 */

/** 律师提出请求的句子（与界面 askSentences 同一口径：带“帮 / 请 / 起草 / 写一份……”的句子）。 */
const ASK_RE = /帮|(?<![申诉提报])请(?!求)|麻烦|给我|我要|我想|想要|需要你|起草|草拟|拟定|拟一份|拟个|撰写|写一份|写个|出一份|出个|出具|做一份|做个|修改|修订/;

/** 产出一份文书的动作。 */
const DRAFT_VERB_RE = /起草|草拟|拟定|拟一份|拟个|撰写|写一份|写个|写一封|出具|出一份|形成一份|准备一份|做一份|修改|修订|改写|完善/;

/**
 * 正式文书的名词（宾语）。“清单 / 目录 / 明细 / 台账 / 时间轴 / 矩阵 / 计算”不在内：它们是表格类成果。
 * “报告”只认“尽调报告 / 法律意见报告”这类与文书连写的，单独的“报告”太宽（“进展报告”已有方法按 Word 出）。
 */
const DOC_NOUN_RE =
  /合同|协议|契约|章程|起诉状|诉状|答辩状|答辩书|上诉状|申请书|意见书|法律意见|律师函|催告函|催款函|告知函|函件|通知书|备忘录|决议|决定书|代理词|代理意见|质证意见|庭审提纲|承诺函|承诺书|声明书|授权委托书|补充协议|条款|报告书|尽调报告|审查意见|修订稿|清洁稿/;

/** 律师明确点名的格式。 */
const SHEET_ASK_RE = /Excel|excel|xlsx|电子表格|表格形式|做成表格|做成表|列成表|出一张表|一张表/;
const WORD_ASK_RE = /Word|word|docx|Word\s*文档|可编辑文书/;

export type DeliverableKind = "word" | "sheet" | null;

function askSentences(goal: string): string[] {
  return goal
    .split(/[。！？!?；;\n]/)
    .map((s) => s.replace(/\s+/g, ""))
    .filter((s) => s.length > 0 && ASK_RE.test(s));
}

/**
 * 律师本次要的主交付物类型：
 * - 请求句点名 Excel / 表格形式、且没有同时要文书 → "sheet"；
 * - 请求句有产出文书的动作、且宾语是正式文书 → "word"（附表格的照样是 Word 为主，表格作附件）；
 * - 只点名 Word → "word"；
 * - 认不出（问答、检索、整理、测算）→ null，交给方法自己的主交付物核对。
 */
export function goalDeliverable(goal: string): DeliverableKind {
  const asks = askSentences(String(goal ?? "").slice(0, 8000));
  if (asks.length === 0) return null;
  let word = false;
  let sheet = false;
  for (const s of asks) {
    if (DRAFT_VERB_RE.test(s) && DOC_NOUN_RE.test(s)) word = true;
    if (WORD_ASK_RE.test(s)) word = true;
    if (SHEET_ASK_RE.test(s)) sheet = true;
  }
  if (word) return "word";
  return sheet ? "sheet" : null;
}

/** 律师要文书、而方法或任务没有声明 Word 主交付物时，内核核对用的主交付物名（给律师看的说明里出现）。 */
export const GOAL_WORD_PRIMARY = "你要求的文书.docx";
