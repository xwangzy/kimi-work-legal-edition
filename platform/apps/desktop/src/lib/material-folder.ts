/**
 * 案卷文件夹与材料内搜索（第 48 批）的纯函数：同步结果的一句话、文件夹位置的目录部分、按文件名即时筛选、命中词高亮切分。
 */

/** 同步结果里界面要用的字段（与 api.ts FolderSyncResult 同形）。 */
export interface SyncResultLike {
  added: number;
  updated: number;
  unchanged: number;
  skipped_total: number;
  missing_on_disk: string[];
  capped: boolean;
  cap: number;
}

/** 一句话：“新增 3 份、更新 1 份；跳过 2 份”。没有新文件时说“没有新增或改动的文件”。 */
export function syncResultText(r: SyncResultLike): string {
  const head = [r.added > 0 ? `新增 ${r.added} 份` : "", r.updated > 0 ? `更新 ${r.updated} 份` : ""].filter(Boolean).join("、") || "没有新增或改动的文件";
  const tail = [
    r.skipped_total > 0 ? `跳过 ${r.skipped_total} 份` : "",
    r.missing_on_disk.length > 0 ? `${r.missing_on_disk.length} 份在文件夹里找不到了（事项里的材料还在）` : "",
    // 超量：按文件夹顺序固定处理前 N 份，之后的同步也接不上——如实说，请关联更小的文件夹
    r.capped ? `可导入的文件超过 ${r.cap} 份，只处理了前 ${r.cap} 份（请改为关联只放本事项材料的子文件夹）` : "",
  ].filter(Boolean);
  return tail.length > 0 ? `${head}；${tail.join("；")}` : head;
}

/** 文件夹位置的目录部分（“证据/合同/补充协议.docx” → “证据/合同”）；直接在文件夹根下或不是从文件夹导入的为 null。 */
export function relDir(relPath: string | null | undefined): string | null {
  if (!relPath) return null;
  const i = relPath.lastIndexOf("/");
  return i > 0 ? relPath.slice(0, i) : null;
}

/** 搜索词：按空白（含全角空格）切分、去重（不分大小写）。 */
export function queryTerms(q: string): string[] {
  const out: string[] = [];
  for (const t of q.split(/\s+/)) if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  return out;
}

/** 按文件名（含文件夹位置）即时筛选：每个词都要出现，不分大小写；没有词时原样返回。 */
export function filterDocsByName<T extends { filename: string; rel_path?: string | null }>(docs: T[], q: string): T[] {
  const terms = queryTerms(q).map((t) => t.toLowerCase());
  if (terms.length === 0) return docs;
  return docs.filter((d) => {
    const name = `${d.filename}\n${d.rel_path ?? ""}`.toLowerCase();
    return terms.every((t) => name.includes(t));
  });
}

/** 输入时自动搜索文字：至少 2 个字（按字符计，不按字节）。 */
export function shouldAutoSearch(q: string): boolean {
  return [...q.trim()].length >= 2;
}

/** 把片段按命中词切开（不分大小写），供界面用 <mark> 标出命中处。 */
export function highlightParts(text: string, terms: string[]): { text: string; hit: boolean }[] {
  const ts = terms.filter(Boolean).sort((a, b) => b.length - a.length);
  if (ts.length === 0 || !text) return text ? [{ text, hit: false }] : [];
  const re = new RegExp(ts.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "giu");
  const out: { text: string; hit: boolean }[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m[0].length === 0) continue;
    if (m.index! > last) out.push({ text: text.slice(last, m.index), hit: false });
    out.push({ text: m[0], hit: true });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false });
  return out;
}

/** 被同一位置的新版本取代了的材料（supersedes 指向的那些）。 */
export function supersededIds(docs: { supersedes?: string | null }[]): Set<string> {
  return new Set(docs.map((d) => d.supersedes).filter((x): x is string => typeof x === "string" && x.length > 0));
}
