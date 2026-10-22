/**
 * 安全的 Markdown 渲染（只生成 React 元素，不注入 HTML）：标题、段落、列表、引用、代码块、表格、粗体、行内代码。
 * 链接只显示文字（不可点击，不导航、不打开外部浏览器——第 04 篇 §1.2 约束 3）。代号按 tokenMap 还原并淡色标记。
 */
import { Fragment, type ReactNode } from "react";
import { splitTokens } from "../lib/tokens.ts";
import type { PreviewCite } from "../lib/safe-preview.ts";

/** cites：成果里的引用角标（v9.4 第 20 批 C-03）——第 n 次出现的引用后加角标，颜色与悬停说明由调用方给。 */
export function Markdown({ text, tokenMap, cites }: { text: string; tokenMap?: Map<string, string | null>; cites?: PreviewCite[] }) {
  const blocks = parseBlocks(text);
  const cx: CiteCx | undefined = cites && cites.length > 0 ? { cites, seen: new Map(), raws: [...new Set(cites.map((c) => c.raw))].sort((a, b) => b.length - a.length) } : undefined;
  return <div className="md">{blocks.map((b, i) => renderBlock(b, i, tokenMap, cx))}</div>;
}

interface CiteCx {
  cites: PreviewCite[];
  seen: Map<string, number>;
  raws: string[];
}

type Block =
  | { t: "h"; level: number; text: string }
  | { t: "p"; text: string }
  | { t: "ul" | "ol"; items: string[] }
  | { t: "quote"; text: string }
  | { t: "code"; text: string }
  | { t: "table"; head: string[]; rows: string[][] }
  | { t: "hr" };

function parseBlocks(src: string): Block[] {
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
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*[-*+]\s+/, ""));
      out.push({ t: "ul", items });
      continue;
    }
    if (/^\s*\d+[.)、]\s*/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)、]\s*/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*\d+[.)、]\s*/, ""));
      out.push({ t: "ol", items });
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && !/^(#{1,4})\s+|^\s*```|^\s*[-*+]\s+|^\s*>\s?/.test(lines[i]!)) buf.push(lines[i++]!);
    out.push({ t: "p", text: buf.join("\n") });
  }
  return out;
}

function renderBlock(b: Block, key: number, map?: Map<string, string | null>, cx?: CiteCx): ReactNode {
  switch (b.t) {
    case "h": {
      const Tag = (["h3", "h3", "h4", "h5"] as const)[b.level - 1] ?? "h5";
      return <Tag key={key}>{inline(b.text, map, cx)}</Tag>;
    }
    case "p":
      return <p key={key}>{inline(b.text, map, cx)}</p>;
    case "ul":
      return <ul key={key}>{b.items.map((it, i) => <li key={i}>{inline(it, map, cx)}</li>)}</ul>;
    case "ol":
      return <ol key={key}>{b.items.map((it, i) => <li key={i}>{inline(it, map, cx)}</li>)}</ol>;
    case "quote":
      return <blockquote key={key}>{inline(b.text, map, cx)}</blockquote>;
    case "code":
      return <pre key={key}><code>{b.text}</code></pre>;
    case "hr":
      return <hr key={key} />;
    case "table":
      return (
        <div className="md-table" key={key}>
          <table className="data">
            <thead><tr>{b.head.map((h, i) => <th key={i}>{inline(h, map, cx)}</th>)}</tr></thead>
            <tbody>{b.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{inline(c, map, cx)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      );
  }
}

/** 行内：`代码`、**粗体**、[文字](链接 → 只显示文字)、代号还原。 */
function inline(text: string, map?: Map<string, string | null>, cx?: CiteCx): ReactNode {
  const parts: ReactNode[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) parts.push(<Fragment key={k++}>{withCites(text.slice(last, at), map, cx)}</Fragment>);
    if (m[1] !== undefined) parts.push(<code key={k++}>{tokens(m[1], map)}</code>);
    else if (m[2] !== undefined) parts.push(<strong key={k++}>{withCites(m[2], map, cx)}</strong>);
    else parts.push(<span key={k++} className="md-link" title={m[4]}>{tokens(m[3] ?? "", map)}</span>);
    last = at + m[0].length;
  }
  if (last < text.length) parts.push(<Fragment key={k++}>{withCites(text.slice(last), map, cx)}</Fragment>);
  return parts;
}

/** 文字段里的引用后加角标（按出现先后数第几次，与内核编号一致）；没有角标时同 tokens。 */
function withCites(text: string, map: Map<string, string | null> | undefined, cx: CiteCx | undefined): ReactNode {
  if (!cx || !cx.raws.some((r) => text.includes(r))) return tokens(text, map);
  const out: ReactNode[] = [];
  let rest = text;
  let k = 0;
  for (;;) {
    let at = -1;
    let hit = "";
    for (const r of cx.raws) {
      const i = rest.indexOf(r);
      if (i >= 0 && (at < 0 || i < at)) [at, hit] = [i, r];
    }
    if (at < 0) break;
    out.push(<Fragment key={k++}>{tokens(rest.slice(0, at + hit.length), map)}</Fragment>);
    const nth = (cx.seen.get(hit) ?? 0) + 1;
    cx.seen.set(hit, nth);
    const c = cx.cites.find((x) => x.raw === hit && x.nth === nth);
    if (c) out.push(<sup key={k++} className={`cite-mark cite-tone-${c.tone}`} title={c.title}>{c.mark}</sup>);
    rest = rest.slice(at + hit.length);
  }
  out.push(<Fragment key={k++}>{tokens(rest, map)}</Fragment>);
  return out;
}

export function tokens(text: string, map?: Map<string, string | null>): ReactNode {
  if (!map || map.size === 0) return text;
  return splitTokens(text, map).map((s, i) =>
    s.kind === "text" ? (
      <Fragment key={i}>{s.text}</Fragment>
    ) : s.value ? (
      <span key={i} className="tok-restored" title={`代号 ${s.token}：真名只在你的电脑上显示`}>{s.value}</span>
    ) : (
      <span key={i} className="tok-raw" title="未能还原的代号（未知或冲突代号不还原）">{s.token}</span>
    ),
  );
}
