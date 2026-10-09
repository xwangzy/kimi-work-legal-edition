/**
 * S2 案卷整理（第 3 篇 S2）：入库 → 事实抽取（带锚点）→ 时间轴 → 目录/矩阵/补证/质量报告。
 *
 * 诚实边界（v0 确定性版）：
 * - 事实抽取只覆盖正则可判的日期/金额/主体，类型标签一律“材料记载”（不推断）；
 * - 争点矩阵为骨架（争点由律师填写/确认），不擅自认定证明力（专项零违例）；
 * - 同日同额不自动合并（专项零违例）；
 * - 原件永不修改；解析失败只交目录与缺口，停止实体结论（§2.6）。
 */
import { sha256Hex, newId } from "@zr-legal/domain";
import { createDocx, createXlsx } from "@zr-legal/docx-engine";
import type { KernelDb } from "../db.ts";

export interface FactRow {
  kind: "date" | "amount" | "party";
  text: string; // 原文
  normalized: string; // 归一化（ISO 日期 / 金额数值）
  document_version_id: string;
  parse_version_id: string;
  filename: string;
  char_start: number;
  char_end: number;
  /** 文件页码（parse_texts 以 \f 换页分隔时由字符区间换算；无 \f 的非 PDF 材料为 null）。 */
  file_page: number | null;
  assertion: "material_record"; // 只标材料记载
}

/** 字符区间 → 文件页码（\f 换页符计数；无 \f 即无页码映射，如实返回 null）。 */
export function filePageOf(text: string, charStart: number): number | null {
  if (!text.includes("\f")) return null;
  let page = 1;
  for (let i = 0; i < charStart && i < text.length; i++) if (text.charCodeAt(i) === 0x0c) page += 1;
  return page;
}

const DATE_RES = [
  /(\d{4})年(\d{1,2})月(\d{1,2})日/g,
  /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/g,
];
const AMOUNT_RE = /(人民币|￥|¥)?\s*([\d,]+(?:\.\d+)?)\s*(万元|元)/g;
const PARTY_RE = /(甲方|乙方|丙方|委托方|受托方|借款人|出借人|担保人)[:：]\s*([^\s，。；、（）()]{2,30})/g;

export function extractFacts(doc: { document_version_id: string; parse_version_id: string; filename: string; text: string }): FactRow[] {
  const out: FactRow[] = [];
  const { text } = doc;
  for (const re of DATE_RES) {
    for (const m of text.matchAll(re)) {
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
      const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      out.push({
        kind: "date",
        text: m[0],
        normalized: iso,
        document_version_id: doc.document_version_id,
        parse_version_id: doc.parse_version_id,
        filename: doc.filename,
        char_start: m.index!,
        file_page: filePageOf(text, m.index!),
        char_end: m.index! + m[0].length,
        assertion: "material_record",
      });
    }
  }
  for (const m of text.matchAll(AMOUNT_RE)) {
    const value = Number(m[2]!.replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    const yuan = m[3] === "万元" ? value * 10000 : value;
    out.push({
      kind: "amount",
      text: m[0],
      normalized: `${yuan} 元`,
      document_version_id: doc.document_version_id,
      parse_version_id: doc.parse_version_id,
      filename: doc.filename,
      char_start: m.index!,
      file_page: filePageOf(text, m.index!),
      char_end: m.index! + m[0].length,
      assertion: "material_record",
    });
  }
  for (const m of text.matchAll(PARTY_RE)) {
    out.push({
      kind: "party",
      text: m[0],
      normalized: `${m[1]}=${m[2]}`,
      document_version_id: doc.document_version_id,
      parse_version_id: doc.parse_version_id,
      filename: doc.filename,
      char_start: m.index!,
      file_page: filePageOf(text, m.index!),
      char_end: m.index! + m[0].length,
      assertion: "material_record",
    });
  }
  return out;
}

/** 锚点入库（§4.3 EvidenceAnchor：关键事实可定位——锚点错误为阻断项的验收基础；file_page 为文件页码）。 */
export function persistAnchors(db: KernelDb, facts: FactRow[]): number {
  let n = 0;
  for (const f of facts) {
    db.run(
      `INSERT INTO evidence_anchors (anchor_id, parse_version_id, page, paragraph, char_start, char_end, text_hash, file_page)
       VALUES (?,?,NULL,NULL,?,?,?,?)`,
      [newId("evidenceAnchor"), f.parse_version_id, f.char_start, f.char_end, sha256Hex(f.text), f.file_page],
    );
    n++;
  }
  return n;
}

export interface S2DeliverableInput {
  runId: string;
  matter: { title: string; client_name: string | null; counterparty: string | null; stance: string };
  materials: {
    document_version_id: string;
    parse_version_id: string;
    filename: string;
    sha256: string;
    chars: number;
    quality_flags: string[];
    text: string;
    created_at?: string;
    page_count?: number | null | undefined;
    pages?: { pageNo: number; quality: string; note?: string | undefined }[] | undefined;
  }[];
  issues: string[]; // 用户提供的争点（可空）
}

export interface BuiltS2 {
  files: { kind: string; filename: string; bytes: Buffer; manifest: Record<string, unknown> }[];
  factsCount: { dates: number; amounts: number; parties: number };
  qualityNotes: string[];
}

export function buildS2Deliverables(input: S2DeliverableInput): BuiltS2 {
  const facts = input.materials.flatMap((m) =>
    extractFacts({ document_version_id: m.document_version_id, parse_version_id: m.parse_version_id, filename: m.filename, text: m.text }),
  );
  const dates = facts.filter((f) => f.kind === "date");
  const amounts = facts.filter((f) => f.kind === "amount");
  const parties = facts.filter((f) => f.kind === "party");

  // 案卷总目录（文件 ID/原名/hash/页数/可读状态；页数未知显式写出，不编造）
  const catalogRows: (string | number | null)[][] = [
    ["文件ID", "原名", "sha256(前16)", "大小(字符)", "页数", "原件/复制件", "可读状态", "质量标记"],
    ...input.materials.map((m, i) => [
      `D${i + 1}`,
      m.filename,
      m.sha256.slice(0, 16),
      m.chars,
      m.page_count != null ? m.page_count : "未知（v0 解析未计页）",
      "电子复制件",
      "已解析",
      (m.quality_flags ?? []).join(";") || "无",
    ] as (string | number | null)[]),
  ];

  // 事实时间轴（按发生日排序；同一事实不合并；保留来源与锚点）
  const timelineRows: (string | number | null)[][] = [
    ["发生日期", "事件/金额", "类型", "来源文件", "原文", "锚点(字符区间)", "陈述性质"],
    ...dates
      .slice()
      .sort((a, b) => a.normalized.localeCompare(b.normalized))
      .map((f) => [f.normalized, f.text, "日期", f.filename, f.text, `${f.char_start}-${f.char_end}`, "材料记载"] as (string | number | null)[]),
    ...amounts.map((f) => ["（日期未明）", f.normalized, "金额", f.filename, f.text, `${f.char_start}-${f.char_end}`, "材料记载"] as (string | number | null)[]),
  ];

  // 证据目录（证明目的留空待律师填写——不擅自认定证明力）
  const evidenceRows: (string | number | null)[][] = [
    ["编号", "证据名称", "来源", "页码", "原件状态", "证明目的（律师填写）", "待证事实（律师填写）"],
    ...input.materials.map((m, i) => [`E${i + 1}`, m.filename, "委托人提供（待确认）", "未知", "电子复制件", "", ""] as (string | number | null)[]),
  ];

  // 争点—证据矩阵骨架
  const matrixRows: (string | number | null)[][] = [
    ["争点", "要件", "举证责任", "支持证据（锚点）", "反对证据", "缺口", "证明力意见（律师填写）"],
    ...(input.issues.length > 0
      ? input.issues.map((issue) => [issue, "（待律师拆解）", "（待确认）", "", "", "", ""] as (string | number | null)[])
      : [["（争点待律师填写）", "", "", "", "", "", ""]] as (string | number | null)[][]),
  ];

  // 补证清单（质量缺陷 → 补证动作；页级 OCR 质量如实列出——低质量页可见、可重扫、可人工纠正）
  const qualityNotes: string[] = [];
  const supplementRows: string[] = [];
  for (const m of input.materials) {
    const flags = m.quality_flags ?? [];
    if (flags.includes("no_page_anchors")) {
      qualityNotes.push(`《${m.filename}》：v0 解析无页锚点，引用定位以字符区间代替`);
    }
    if (flags.includes("v0_crude_docx_parser")) {
      supplementRows.push(`《${m.filename}》：建议以文档服务重解析生成页锚点（正式版）`);
    }
    for (const pg of m.pages ?? []) {
      if (pg.quality === "unreadable") {
        qualityNotes.push(`《${m.filename}》第 ${pg.pageNo} 页：不可读（${pg.note ?? "OCR 失败/未就绪"}）`);
        supplementRows.push(`《${m.filename}》第 ${pg.pageNo} 页：不可读——请重扫或人工誊录后重新导入（不伪造文本）`);
      } else if (pg.quality === "low") {
        qualityNotes.push(`《${m.filename}》第 ${pg.pageNo} 页：低质量（${pg.note ?? "OCR 置信度低"}）`);
        supplementRows.push(`《${m.filename}》第 ${pg.pageNo} 页：OCR 质量低——建议重扫或用 materials.reparse 重解析/人工纠正（生成新解析版本）`);
      }
    }
  }

  const factsCount = { dates: dates.length, amounts: amounts.length, parties: parties.length };

  const files: BuiltS2["files"] = [
    {
      kind: "s2_catalog",
      filename: `案卷总目录-${input.runId.slice(-6)}.xlsx`,
      bytes: createXlsx([{ name: "案卷总目录", rows: catalogRows }]),
      manifest: { files: input.materials.length },
    },
    {
      kind: "s2_timeline",
      filename: `事实时间轴-${input.runId.slice(-6)}.xlsx`,
      bytes: createXlsx([{ name: "事实时间轴", rows: timelineRows }]),
      manifest: { dates: dates.length, amounts: amounts.length, note: "同日同额不自动合并；每条独立行" },
    },
    {
      kind: "s2_evidence_catalog",
      filename: `证据目录-${input.runId.slice(-6)}.xlsx`,
      bytes: createXlsx([{ name: "证据目录", rows: evidenceRows }]),
      manifest: { note: "证明目的/待证事实由律师填写（不擅自认定证明力）" },
    },
    {
      kind: "s2_matrix",
      filename: `争点证据矩阵-${input.runId.slice(-6)}.xlsx`,
      bytes: createXlsx([{ name: "争点证据矩阵", rows: matrixRows }]),
      manifest: { issues: input.issues.length, note: "骨架：争点/要件/举证责任由律师确认" },
    },
    {
      kind: "s2_supplement",
      filename: `补证清单-${input.runId.slice(-6)}.docx`,
      bytes: createDocx("补证清单（草稿）", [
        {
          heading: "一、材料质量缺陷与建议",
          paragraphs: supplementRows.length > 0 ? supplementRows : ["本次材料未发现需补正的质量缺陷（按 v0 解析口径）。"],
        },
        { heading: "二、待补材料", paragraphs: ["（由律师按争点矩阵缺口补充）"] },
      ]),
      manifest: {},
    },
    {
      kind: "s2_quality_report",
      filename: `材料质量报告-${input.runId.slice(-6)}.docx`,
      bytes: createDocx("材料质量报告", [
        {
          heading: "一、入库概况",
          paragraphs: [
            `文件 ${input.materials.length} 份；抽取事实：日期 ${dates.length} 条、金额 ${amounts.length} 条、主体 ${parties.length} 条（全部带字符锚点入库）。`,
            `事项：${input.matter.title}；立场：${input.matter.stance}。`,
          ],
        },
        {
          heading: "二、质量与降级说明",
          paragraphs: [
            ...(qualityNotes.length > 0 ? qualityNotes : ["无"]),
            "事实抽取 v0 为确定性规则（日期/金额/主体），行为与法律关系抽取待真实模型与律师确认；解析失败的文件只进目录不进实体结论。",
            "原件永不修改；OCR 纠正将生成新解析版本。",
          ],
        },
      ]),
      manifest: { anchors: facts.length },
    },
  ];

  return { files, factsCount, qualityNotes };
}
