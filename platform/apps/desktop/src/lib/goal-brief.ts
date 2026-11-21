/**
 * 任务说明的排版（第 55 批）：场景卡拼出来的任务说明是一长段（“请起草民事起诉状。诉讼请求：1. …；2. …。拟受理法院：…。”），
 * 原先收在“任务说明”折叠里、点开是一只灰色气泡，折叠时什么都看不到。这里把它拆成行：
 *  - 第一句是“做什么”（作折叠时的预览）；
 *  - “标签：内容”形态的句子拆成两列（标签至多 14 字，避免把正文里带冒号的长句误拆）；
 *  - 其余原样成行。
 * 只做排版，不改一个字；纯函数。
 */
export interface GoalRow {
  /** 有标签的行（“拟受理法院：某某法院”）；没有标签的是整行文字。 */
  label?: string;
  text: string;
  /** 逐项内容（“1. …；2. …”拆开）；有它时 text 为空。 */
  items?: string[];
}

// 标签：2～14 个不含标点的字，后面可以带一个括注（“诉讼请求（按我列的顺序与取舍写）”——括注是写给助手的话，显示时去掉）
const LABELED = /^([^：:。；，,（(\s][^：:。；，,（(]{1,13}(?:（[^）]{1,24}）)?)[：:]\s*(.+)$/s;

/** “1. 甲；2. 乙；3. 丙”拆成三项；不是这种写法返回 null。 */
function splitNumbered(text: string): string[] | null {
  const parts = text.split(/(?:^|；)\s*(?=\d{1,2}\.\s)/).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2 || !parts.every((p) => /^\d{1,2}\.\s/.test(p))) return null;
  return parts.map((p) => p.replace(/^\d{1,2}\.\s*/, "").replace(/[。；]+$/, ""));
}

export function goalRows(goal: string): GoalRow[] {
  const rows: GoalRow[] = [];
  for (const line of goal.split(/\n+/)) {
    // 逐项请求里的“；”不能当句界：先按句号拆
    for (const seg of line.split(/(?<=。)/)) {
      const s = seg.trim();
      if (!s) continue;
      const m = LABELED.exec(s);
      if (m) {
        const body = m[2]!.trim();
        const items = splitNumbered(body);
        // 标签里的括注（“诉讼请求（按我列的顺序与取舍写）”）是写给助手的话，显示时只留标签本身
        const label = m[1]!.replace(/（[^）]*）$/, "").trim();
        rows.push(items ? { label, text: "", items } : { label, text: body.replace(/。$/, "") });
      } else rows.push({ text: s });
    }
  }
  return rows;
}

/** 折叠时的一行预览：第一句（去掉句末标点），太长截到 max 字。 */
export function goalPreview(goal: string, max = 46): string {
  const first = goal.replace(/\s+/g, " ").trim().split(/(?<=[。！？!?\n])/)[0] ?? "";
  const s = first.replace(/[。！？!?]$/, "");
  const chars = [...s];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : s;
}
