/**
 * 检索确认卡的“将发出 / 已去掉”（UIUX 增量评审 P0-B）：按字符比较原文与改写稿（最长公共子序列），
 * 得到改写稿里新出现的片段（高亮）与原文里被去掉的片段。查询都很短（≤ 500 字），O(n·m) 足够。纯函数，可单测。
 */
export interface DiffPart {
  text: string;
  /** same：两边相同；added：改写稿新增；removed：原文被去掉。 */
  kind: "same" | "added" | "removed";
}

export function charDiff(original: string, rewritten: string): DiffPart[] {
  const a = [...original];
  const b = [...rewritten];
  if (a.length * b.length > 400_000) return [{ text: original, kind: "removed" }, { text: rewritten, kind: "added" }];
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const parts: DiffPart[] = [];
  const push = (text: string, kind: DiffPart["kind"]) => {
    const last = parts[parts.length - 1];
    if (last && last.kind === kind) last.text += text;
    else parts.push({ text, kind });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push(a[i]!, "same");
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) push(a[i++]!, "removed");
    else push(b[j++]!, "added");
  }
  while (i < n) push(a[i++]!, "removed");
  while (j < m) push(b[j++]!, "added");
  return parts;
}

/**
 * 将发出的文字（同 + 新增，新增标出）与“去掉了几处”。
 * 按改写处计数（复核 B4-B15）：相邻的删除与新增合为一处；字符级对齐偶然对上的单个文字（例如“张某某”→“某人”里的“某”）不把一处拆成两处——
 * 只有标点、空白等分隔开的才算两处。
 */
export function sendView(original: string, rewritten: string): { shown: DiffPart[]; removedCount: number } {
  const parts = charDiff(original, rewritten);
  let removedCount = 0;
  let inRegion = false;
  let regionRemoved = false;
  const close = () => {
    if (inRegion && regionRemoved) removedCount += 1;
    inRegion = false;
    regionRemoved = false;
  };
  parts.forEach((p, i) => {
    if (p.kind === "same") {
      const glue = inRegion && [...p.text].length === 1 && /[\p{L}\p{N}]/u.test(p.text) && i + 1 < parts.length && parts[i + 1]!.kind !== "same";
      if (!glue) close();
      return;
    }
    inRegion = true;
    if (p.kind === "removed" && p.text.trim().length > 0) regionRemoved = true;
  });
  close();
  return { shown: parts.filter((p) => p.kind !== "removed"), removedCount };
}
