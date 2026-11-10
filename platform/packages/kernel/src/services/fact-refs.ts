/**
 * 事实对照（V16 第 41 批，回归评分二 m03、m05、m16、m20、m25、m26）：表格与文书用“事实 12”作出处，对应的事实清单只在产品界面里，
 * 文件离开界面就对不上。生成表格或内部文书时，按正文里引用到的序号自动附一张“事实对照”（序号｜事实陈述｜发生日期｜来源材料｜律师是否已确认），
 * 只列被引用到的序号、按序号排。序号与事项“事实”页、facts.list 的 ref 同一口径（listFacts 的 no）。
 * 事实陈述按事项代号形态写入（与表格、文书其他内容一致，导出时还原）；来源材料的文件名同样换成代号形态。
 */
import { createDocx, readZipEntries, readZipText, writeZip } from "@zr-legal/docx-engine";
import type { KernelDb } from "../db.ts";
import type { MatterTokenStore } from "../egress/matter-tokens.ts";
import { listFacts } from "./review-cards.ts";

export const FACT_SHEET_NAME = "事实对照";
export const FACT_COLUMNS = ["序号", "事实陈述", "发生日期", "来源材料", "律师是否已确认"];
/** 一张对照表至多列多少条（Word 文书里的表格上限同为 300 行）。 */
export const FACT_ROWS_MAX = 300;
/** Word 文书里自动附的那一节的说明（以它识别“系统附的”那一节，改动后重新生成；助手自己写的同名节不动）。 */
export const FACT_NOTE_PREFIX = "（本节由系统按正文引用的事实序号自动附上";
export const FACT_NOTE = `${FACT_NOTE_PREFIX}，序号与事项“事实”页一致；正文改动后随之更新。“待确认”的事实尚未经律师确认。）`;

const STATUS: Record<string, string> = { confirmed: "已确认", proposed: "待确认", rejected: "律师已否定（不应引用）" };

/** 被引用到的序号对应的对照行（找不到的序号也列一行，提示核对引用）。 */
export function factTableRows(deps: { db: KernelDb; tokens?: MatterTokenStore | undefined }, matterId: string, nos: readonly number[]): { rows: string[][]; omitted: number } {
  const all = listFacts(deps.db, matterId);
  const byNo = new Map(all.map((f) => [Number(f.no), f] as const));
  const picked = nos.slice(0, FACT_ROWS_MAX);
  const docIds = [...new Set(picked.map((n) => byNo.get(n)?.document_version_id).filter((x): x is string => typeof x === "string" && x.length > 0))];
  const names = new Map<string, string>();
  for (const id of docIds) {
    const r = deps.db.get<{ filename: string }>(`SELECT filename FROM document_versions WHERE document_version_id = ? AND matter_id = ?`, [id, matterId]);
    if (r) names.set(id, r.filename);
  }
  // 材料文件名是律师上传时起的，可能含姓名：按材料口径完整识别、写回代号表（与文书正文同为代号形态，导出时还原）
  if (deps.tokens && names.size > 0) {
    const keys = [...names.keys()];
    const tok = deps.tokens.tokenizeAll(matterId, keys.map((k) => names.get(k)!));
    keys.forEach((k, i) => names.set(k, tok[i]!.text));
  }
  const rows = picked.map((n) => {
    const f = byNo.get(n);
    if (!f) return [`事实 ${n}`, "本事项事实页里没有这一序号，请核对引用", "", "", ""];
    return [`事实 ${n}`, String(f.statement ?? ""), String(f.occurred_on ?? ""), f.document_version_id ? (names.get(f.document_version_id) ?? "") : "", STATUS[String(f.status)] ?? String(f.status ?? "")];
  });
  return { rows, omitted: nos.length - picked.length };
}

const textOf = (xml: string) => [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((t) => t[1]).join("");
const PARA_RE = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;

/** 去掉文书里系统附的“事实对照”一节（一级标题“事实对照”＋系统说明段＋紧随的表格）；没有就原样返回。 */
export function stripFactSection(xml: string): string {
  for (const m of xml.matchAll(PARA_RE)) {
    if (!/KwlHeading1/.test(m[0]) || textOf(m[0]).trim() !== FACT_SHEET_NAME) continue;
    const start = m.index ?? 0;
    let rest = xml.slice(start + m[0].length);
    const note = /^<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/.exec(rest);
    if (!note || !textOf(note[0]).startsWith(FACT_NOTE_PREFIX)) continue;
    rest = rest.slice(note[0].length);
    const tbl = /^<w:tbl>[\s\S]*?<\/w:tbl>/.exec(rest);
    return xml.slice(0, start) + xml.slice(start + m[0].length + note[0].length + (tbl ? tbl[0].length : 0));
  }
  return xml;
}

/** 文书正文里有没有系统附的那一节。 */
export function hasFactSection(xml: string): boolean {
  return stripFactSection(xml) !== xml;
}

/** 系统附的那一节（交给 docx.render_report 的节结构）。 */
export function factSection(rows: string[][], omitted: number): { heading: string; paragraphs: string[]; table: { columns: string[]; rows: string[][] } } {
  return { heading: FACT_SHEET_NAME, paragraphs: [omitted > 0 ? `${FACT_NOTE.slice(0, -1)}；另有 ${omitted} 条超出本表上限未列。）` : FACT_NOTE], table: { columns: FACT_COLUMNS, rows } };
}

/**
 * docx.edit_draft 改动后同步这一节：去掉旧的，按改后正文引用的序号重新生成，接在正文末尾（不重复追加）；正文不再引用任何事实时整节去掉。
 * build 按去掉旧节后的正文给出对照行（没有引用返回 null）。文书读不到正文、或助手自己写了同名一节时原样返回。
 */
export function syncFactSection(docx: Buffer, build: (bodyText: string) => { rows: string[][]; omitted: number } | null): { docx: Buffer; changed: boolean } {
  const xml = readZipText(docx, "word/document.xml");
  if (!xml) return { docx, changed: false };
  const stripped = stripFactSection(xml);
  // 助手自己写了同名一节的不动（不另加）
  if ([...stripped.matchAll(PARA_RE)].some((m) => /KwlHeading1/.test(m[0]) && textOf(m[0]).trim() === FACT_SHEET_NAME)) return { docx, changed: false };
  const body = [...stripped.matchAll(PARA_RE)].map((m) => textOf(m[0])).join("\n");
  const t = build(body);
  let next = stripped;
  if (t && t.rows.length > 0) {
    const frag = fragmentOf(factSection(t.rows, t.omitted));
    const at = next.lastIndexOf("<w:sectPr");
    if (at < 0 || !frag) return { docx, changed: false };
    next = next.slice(0, at) + frag + next.slice(at);
  }
  if (next === xml) return { docx, changed: false };
  const entries = readZipEntries(docx);
  return { docx: writeZip([...entries.entries()].map(([name, data]) => ({ name, data: name === "word/document.xml" ? Buffer.from(next, "utf8") : data }))), changed: true };
}

/** 用文书引擎排出这一节的正文 XML（标题之后、分节符之前的部分），与 docx.render_report 同一版式。 */
function fragmentOf(section: ReturnType<typeof factSection>): string | null {
  const xml = readZipText(createDocx("x", [section]), "word/document.xml") ?? "";
  const title = /<w:p(?:\s[^>]*)?>(?:(?!<\/w:p>)[\s\S])*?KwlTitle[\s\S]*?<\/w:p>/.exec(xml);
  const end = xml.lastIndexOf("<w:sectPr");
  if (!title || end < 0) return null;
  return xml.slice((title.index ?? 0) + title[0].length, end).replace(/<w:p\/>$/, "");
}
