/**
 * 角标扫描（预览与 Markdown 共用；v9.4 第 21 批，复核 Q3-04）：在一段文字里按“最早出现、同位置最长写法优先、从左到右不重叠”找出每处，
 * 并按写法累计第几次出现（seen 跨段累计）。内核 artifact-facts 按同一规则编号，两边对得上。
 */
export function scanMarks(text: string, raws: readonly string[], seen: Map<string, number>): { start: number; end: number; raw: string; nth: number }[] {
  const sorted = [...raws].filter(Boolean).sort((a, b) => b.length - a.length);
  const out: { start: number; end: number; raw: string; nth: number }[] = [];
  let from = 0;
  for (;;) {
    let at = -1;
    let hit = "";
    for (const r of sorted) {
      const i = text.indexOf(r, from);
      if (i >= 0 && (at < 0 || i < at)) [at, hit] = [i, r];
    }
    if (at < 0) return out;
    const nth = (seen.get(hit) ?? 0) + 1;
    seen.set(hit, nth);
    out.push({ start: at, end: at + hit.length, raw: hit, nth });
    from = at + hit.length;
  }
}
