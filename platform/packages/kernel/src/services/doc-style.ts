/**
 * 文书版式（v9.3 第 15 批 B-4；评审 Z1 P1-1）：这台电脑导出 Word 时用的函头、正文字体字号、页码与律所模板。
 * 存在账本（firm_doc_style，迁移 0052；模板字节也在账本里，随 SQLCipher 加密）；不经任何网络。
 * 缺省：函头自动用激活记录里的律所名称、宋体小四、带页码、不用模板。G0 每台电脑各自设置（律所统一下发在 G1，随律所策略）。
 */
import { createHash } from "node:crypto";
import { DomainError } from "@zr-legal/domain";
import { readTemplate, TEMPLATE_MAX_BYTES, type HouseStyle } from "@zr-legal/docx-engine";
import type { KernelDb } from "../db.ts";

type TemplateParts = NonNullable<ReturnType<typeof readTemplate>>;

export interface DocStyleView {
  /** 函头：auto = 用本所名称；custom = 自定义名称；none = 不加。 */
  letterhead: "auto" | "custom" | "none";
  letterhead_name: string | null;
  letterhead_lines: string[];
  /** 实际会印在函头上的名称（auto 时取律所名称）；不加函头为 null。 */
  effective_letterhead: string | null;
  body: HouseStyle["body"];
  page_numbers: boolean;
  template: { name: string; sha256: string; updated_at: string } | null;
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
const parsedTemplates = new Map<string, TemplateParts | null>();

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
    template: r?.template && r.template_sha256 ? { name: r.template_name ?? "律所模板", sha256: r.template_sha256, updated_at: r.updated_at } : null,
  };
}

/** 导出时用的版式与（解析过的）模板。 */
export function houseStyleFor(db: KernelDb, tenantId: string, firmName: string | null): { style: HouseStyle; template: TemplateParts | null } {
  const v = docStyleView(db, tenantId, firmName);
  const style: HouseStyle = { letterhead: v.effective_letterhead ? { name: v.effective_letterhead, lines: v.letterhead_lines } : null, body: v.body, pageNumbers: v.page_numbers };
  const r = v.template ? rowOf(db, tenantId) : undefined;
  let template: TemplateParts | null = null;
  if (r?.template && r.template_sha256) {
    if (!parsedTemplates.has(r.template_sha256)) parsedTemplates.set(r.template_sha256, readTemplate(r.template));
    template = parsedTemplates.get(r.template_sha256) ?? null;
  }
  return { style, template };
}

const clean = (s: unknown, max: number): string => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

export function setDocStyle(db: KernelDb, tenantId: string, p: Record<string, unknown>): void {
  const letterhead = p.letterhead === "custom" || p.letterhead === "none" ? p.letterhead : "auto";
  const name = clean(p.letterhead_name, 40);
  if (letterhead === "custom" && !name) throw new DomainError("validation", "请填写函头上的律所名称", 422);
  const lines = (Array.isArray(p.letterhead_lines) ? p.letterhead_lines : []).map((l) => clean(l, LINE_MAX)).filter(Boolean).slice(0, 2);
  const body = p.body === "fangsong-san" ? "fangsong-san" : "song-xiaosi";
  const pageNumbers = p.page_numbers === false ? 0 : 1;
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
    if (!readTemplate(bytes)) throw new DomainError("unsupported_file", "这个文件读不出 Word 样式：请上传 Word 模板（.dotx）或用作模板的 Word 文档（.docx）", 422);
  }
  const sha = bytes ? createHash("sha256").update(bytes).digest("hex") : null;
  if (!rowOf(db, tenantId)) setDocStyle(db, tenantId, {});
  db.run(`UPDATE firm_doc_style SET template = ?, template_name = ?, template_sha256 = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE tenant_id = ?`, [bytes, bytes ? clean(name, 80) || "律所模板" : null, sha, tenantId]);
  return { sha256: sha };
}
