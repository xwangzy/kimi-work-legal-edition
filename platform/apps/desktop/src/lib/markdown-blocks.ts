/**
 * 问答与答复摘要用的轻量 Markdown 分块（第 71 批第二轮从 components/Markdown.tsx 抽出补用例）。纯函数。
 *
 * 第 71 批第二轮（区域 2）：有序列表编号全是“1.”——模型常在列表项之间空一行（宽松列表），原先空行就把列表拆成几个，各自从 1 起编；
 * 现在空行后面紧跟的仍是有序列表项就接着算同一个列表，并保留原文的起始编号（`start`）：流式分块时半截文字里的列表、
 * 或正文被段落隔开后从“3.”接着写的列表，都按原文编号显示，不再重置成 1。
 */
export type Block =
  | { t: "h"; level: number; text: string }
  | { t: "p"; text: string }
  | { t: "ul"; items: string[] }
  | { t: "ol"; items: string[]; start: number }
  | { t: "quote"; text: string }
  | { t: "code"; text: string }
  | { t: "table"; head: string[]; rows: string[][] }
  | { t: "hr" };

/** 有序列表项：“1. ”“2) ”或中文“1、”（“3.5 万元”这种小数不算）。 */
const OL = /^\s*(\d+)(?:[.)](?!\d)|、)\s*/;
const UL = /^\s*[-*+]\s+/;

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) buf.push(lines[i++]!);
      i++;
      out.push({ t: "code", text: buf.join("\n") });
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      out.push({ t: "h", level: h[1]!.length, text: h[2]! });
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]!)) {
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) rows.push(cells(lines[i++]!));
      out.push({ t: "table", head, rows });
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) buf.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      out.push({ t: "quote", text: buf.join("\n") });
      continue;
    }
    if (UL.test(line)) {
      const items: string[] = [];
      while (i < lines.length && UL.test(lines[i]!)) items.push(lines[i++]!.replace(UL, ""));
      out.push({ t: "ul", items });
      continue;
    }
    const olm = OL.exec(line);
    if (olm) {
      const items: string[] = [];
      while (i < lines.length) {
        if (OL.test(lines[i]!)) {
          items.push(lines[i++]!.replace(OL, ""));
          continue;
        }
        // 宽松列表：中间隔着空行、下一行仍是有序列表项的，接着算同一个列表
        let j = i;
        while (j < lines.length && lines[j]!.trim() === "") j++;
        if (j > i && j < lines.length && OL.test(lines[j]!)) {
          i = j;
          continue;
        }
        break;
      }
      out.push({ t: "ol", items, start: Number(olm[1]) || 1 });
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    const buf: string[] = [];
    // 段落遇到列表项就断开（原先有序列表项会被并进上一段）
    while (i < lines.length && lines[i]!.trim() !== "" && !/^(#{1,4})\s+|^\s*```|^\s*>\s?/.test(lines[i]!) && !UL.test(lines[i]!) && !(buf.length > 0 && OL.test(lines[i]!))) buf.push(lines[i++]!);
    out.push({ t: "p", text: buf.join("\n") });
  }
  return out;
}

