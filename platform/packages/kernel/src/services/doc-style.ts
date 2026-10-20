/**
 * 文书版式（v9.3 第 15 批 B-4；评审 Z1 P1-1）：这台电脑导出 Word 时用的函头、正文字体字号、页码与律所模板。
 * 存在账本（firm_doc_style，迁移 0052；模板字节也在账本里，随 SQLCipher 加密）；不经任何网络。
 * 缺省：函头自动用激活记录里的律所名称、宋体小四、带页码、不用模板。G0 每台电脑各自设置（律所统一下发在 G1，随律所策略）。
 */
import { createHash } from "node:crypto";
import { DomainError } from "@zr-legal/domain";
import { readTemplate, templateLite, TEMPLATE_MAX_BYTES, type HouseStyle, type TemplateParts } from "@zr-legal/docx-engine";
import type { KernelDb } from "../db.ts";


export interface DocStyleView {
  /** 函头：auto = 用本所名称；custom = 自定义名称；none = 不加。 */
  letterhead: "auto" | "custom" | "none";
  letterhead_name: string | null;
  letterhead_lines: string[];
  /** 实际会印在函头上的名称（auto 时取律所名称）；不加函头为 null。 */
  effective_letterhead: string | null;
  body: HouseStyle["body"];
  page_numbers: boolean;
  /** 律所模板：页眉页脚里的文字给律师确认（复核 R15A-09）；looks_case_specific = 像是具体案件的信息（案号、“诉”、书名号标题等）。 */
  template: { name: string; sha256: string; updated_at: string; header_text: string; footer_text: string; looks_case_specific: boolean } | null;
}

interface Row {
  letterhead: "auto" | "custom" | "none";
  letterhead_name: string | null;
  letterhead_lines: string;
  body: HouseStyle["body"];
  page_numbers: number;
  template: Buffer | null;
  template_name: string | null;
  template_sha256: string | null;
  updated_at: string;
}

const LINE_MAX = 60;
/** 只缓存最近一份解析结果（复核 R15A-13）。 */
let parsedTemplate: { sha: string; parts: TemplateParts | null } | null = null;
const parseCached = (sha: string, bytes: Buffer): TemplateParts | null => {
  if (parsedTemplate?.sha !== sha) parsedTemplate = { sha, parts: readTemplate(bytes) };
  return parsedTemplate.parts;
};

/** 页眉页脚里像具体案件信息的写法：案号、“诉”、代理词 / 起诉状 / 判决、书名号里的文件名。 */
const CASE_LIKE = /[（(]\d{4}[)）][^\n]{1,15}号|诉|代理词|起诉状|答辩状|判决|《[^》]{2,40}》/;

function rowOf(db: KernelDb, tenantId: string): Row | undefined {
  return db.get<Row>(`SELECT letterhead, letterhead_name, letterhead_lines, body, page_numbers, template, template_name, template_sha256, updated_at FROM firm_doc_style WHERE tenant_id = ?`, [tenantId]);
}

export function docStyleView(db: KernelDb, tenantId: string, firmName: string | null): DocStyleView {
  const r = rowOf(db, tenantId);
  const letterhead = r?.letterhead ?? "auto";
  const lines = r ? (JSON.parse(r.letterhead_lines) as string[]) : [];
  const effective = letterhead === "none" ? null : letterhead === "custom" ? (r?.letterhead_name ?? null) : firmName;
  return {
    letterhead,
    letterhead_name: r?.letterhead_name ?? null,
    letterhead_lines: lines,
    effective_letterhead: effective,
    body: r?.body ?? "song-xiaosi",
    page_numbers: r ? r.page_numbers === 1 : true,
    template: (() => {
      if (!r?.template || !r.template_sha256) return null;
      const t = parseCached(r.template_sha256, r.template);
      const header = t?.headerText ?? "";
      const footer = t?.footerText ?? "";
      return { name: r.template_name ?? "律所模板", sha256: r.template_sha256, updated_at: r.updated_at, header_text: header.slice(0, 400), footer_text: footer.slice(0, 400), looks_case_specific: CASE_LIKE.test(`${header}\n${footer}`) };
    })(),
  };
}

/** 导出时用的版式与（解析过的）模板；override 为界面上还没保存的选项（样张按当前面板生成，复核 R15B-22）。 */
export function houseStyleFor(db: KernelDb, tenantId: string, firmName: string | null, override?: Record<string, unknown>): { style: HouseStyle; template: TemplateParts | null; digest: string } {
  const v = docStyleView(db, tenantId, firmName);
  const o = override ? normalize(override) : null;
  const letterheadMode = o?.letterhead ?? v.letterhead;
  const name = letterheadMode === "none" ? null : letterheadMode === "custom" ? (o ? o.name : v.letterhead_name) : firmName;
  const lines = o ? o.lines : v.letterhead_lines;
  const style: HouseStyle = { letterhead: name ? { name, lines } : null, body: o?.body ?? v.body, pageNumbers: o ? o.pageNumbers === 1 : v.page_numbers };
  const r = v.template ? rowOf(db, tenantId) : undefined;
  const template = r?.template && r.template_sha256 ? parseCached(r.template_sha256, r.template) : null;
  // 下载审计里记版式摘要（复核 R15A-12：同一份签发件在两台电脑下载得到不同版式时，事后查得到是哪一套）
  const digest = createHash("sha256").update(JSON.stringify({ style, template: r?.template_sha256 ?? null })).digest("hex");
  return { style, template, digest };
}

const clean = (s: unknown, max: number): string => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

function normalize(p: Record<string, unknown>): { letterhead: "auto" | "custom" | "none"; name: string; lines: string[]; body: HouseStyle["body"]; pageNumbers: number } {
  const letterhead = p.letterhead === "custom" || p.letterhead === "none" ? p.letterhead : "auto";
  const name = clean(p.letterhead_name, 40);
  if (letterhead === "custom" && !name) throw new DomainError("validation", "请填写函头上的律所名称", 422);
  const lines = (Array.isArray(p.letterhead_lines) ? p.letterhead_lines : []).map((l) => clean(l, LINE_MAX)).filter(Boolean).slice(0, 2);
  return { letterhead, name, lines, body: p.body === "fangsong-san" ? "fangsong-san" : "song-xiaosi", pageNumbers: p.page_numbers === false ? 0 : 1 };
}

export function setDocStyle(db: KernelDb, tenantId: string, p: Record<string, unknown>): void {
  const { letterhead, name, lines, body, pageNumbers } = normalize(p);
  db.run(
    `INSERT INTO firm_doc_style (tenant_id, letterhead, letterhead_name, letterhead_lines, body, page_numbers, updated_at) VALUES (?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(tenant_id) DO UPDATE SET letterhead = excluded.letterhead, letterhead_name = excluded.letterhead_name, letterhead_lines = excluded.letterhead_lines,
       body = excluded.body, page_numbers = excluded.page_numbers, updated_at = excluded.updated_at`,
    [tenantId, letterhead, name || null, JSON.stringify(lines), body, pageNumbers],
  );
}

/** 上传律所模板（.dotx / .docx）：读不出样式的拒收；null 为移除。 */
export function setDocTemplate(db: KernelDb, tenantId: string, name: string | null, bytes: Buffer | null): { sha256: string | null } {
  if (bytes) {
    if (bytes.length > TEMPLATE_MAX_BYTES) throw new DomainError("validation", "模板文件过大（上限 5 MB）：请去掉模板里的大图片后再上传", 422);
    // 只保存用得到的部件（样式、页眉页脚与图片、主题、编号、页面设置），不保存模板的正文、批注、作者（复核 R15A-09）
    const lite = templateLite(bytes);
    if (!lite) throw new DomainError("unsupported_file", "这个文件读不出 Word 样式（或页眉页脚引用了图片以外的内容）：请上传 Word 模板（.dotx）或用作模板的 Word 文档（.docx）", 422);
    bytes = lite;
  }
  const sha = bytes ? createHash("sha256").update(bytes).digest("hex") : null;
  if (!rowOf(db, tenantId)) setDocStyle(db, tenantId, {});
  db.run(`UPDATE firm_doc_style SET template = ?, template_name = ?, template_sha256 = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE tenant_id = ?`, [bytes, bytes ? clean(name, 80) || "律所模板" : null, sha, tenantId]);
  return { sha256: sha };
}
