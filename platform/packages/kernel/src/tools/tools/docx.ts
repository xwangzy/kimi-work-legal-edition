/**
 * docx.* 与 redact.apply 工具（文书引擎由内核调用；§4.1 docx.propose_revisions/compare/render、redact.*）。
 * 产出为内容寻址字节（BlobStore）；artifact_versions 登记由内核工作流完成。
 * 挂载原件只读引用（storage_mode=mount）：读取时复算 hash，变化即需生成新文档版本。
 */
import { restoreArtifactBytes, type Restore } from "../../services/export-restore.ts";
import { DomainError, notFound, sha256Hex } from "@zr-legal/domain";
import {
  applyRevisionsToDocx,
  compareDocx,
  createDocx,
  maskDocxText,
  docxAllPartsText,
  sanitizeDocx,
  scrubDocProps,
  extractParagraphs,
  type ReportSection,
  type RevisionOp,
} from "@zr-legal/docx-engine";
import { scanDirectIdentifiers } from "@zr-legal/pseudonym";
import type { KernelDb } from "../../db.ts";
import type { BlobStore } from "../../blobs.ts";

function loadDocument(db: KernelDb, blobs: BlobStore, claimsMatterId: string | undefined, documentVersionId: string): { buf: Buffer; filename: string; sha256: string; matter_id: string } {
  if (!claimsMatterId) throw new DomainError("forbidden", "令牌未绑定事项", 403);
  const row = db.get<{ document_version_id: string; matter_id: string; filename: string; sha256: string; storage_uri: string }>(
    `SELECT document_version_id, matter_id, filename, sha256, storage_uri FROM document_versions WHERE document_version_id = ? AND quarantined_at IS NULL`,
    [documentVersionId],
  );
  if (!row || row.matter_id !== claimsMatterId) throw notFound("文档");
  const buf = blobs.read(row.storage_uri);
  if (sha256Hex(buf) !== row.sha256) {
    throw new DomainError("hash_mismatch", "原件内容已变化（读取时复算 hash 不符）：原件只读不覆盖——请重新挂载/导入生成新文档版本", 412, { registered: row.sha256 });
  }
  return { buf, filename: row.filename, sha256: row.sha256, matter_id: row.matter_id };
}

export function docxApplyRevisions(
  db: KernelDb,
  blobs: BlobStore,
  mid: string | undefined,
  params: { document_version_id: string; baseline_hash: string; ops: RevisionOp[] },
) {
  const doc = loadDocument(db, blobs, mid, params.document_version_id);
  if (doc.sha256 !== params.baseline_hash) {
    throw new DomainError("stale_baseline", "基线 hash 不符：文档已有新版本", 412, { expected: params.baseline_hash, actual: doc.sha256 });
  }
  const result = applyRevisionsToDocx(doc.buf, { baselineHash: params.baseline_hash, ops: params.ops });
  const stored = blobs.put(result.docx, doc.matter_id);
  return { ...stored, applied: result.applied, source_document_version_id: params.document_version_id };
}

export function docxCompare(
  db: KernelDb,
  blobs: BlobStore,
  mid: string | undefined,
  params: { baseline_document_version_id: string; current_document_version_id: string },
  restore?: Restore,
) {
  const base = loadComparable(db, blobs, mid, params.baseline_document_version_id, restore);
  const cur = loadComparable(db, blobs, mid, params.current_document_version_id, restore);
  return { ...compareDocx(base.buf, cur.buf), baseline_sha256: base.sha256, current_sha256: cur.sha256 };
}

/**
 * 比对的一方可以是本事项的 Word 成果（V14 第 39 批真实走查 B：助手写完修订后想把原件与自己交出的清洁稿对一遍，
 * docx.compare 只认材料编号、报“对象不存在”，转而去磁盘上找文件被宿主拒绝——交付前没法核对实际写入的结果）。
 * 修订稿、清洁稿是还原后的原文形态；助手文书（代号形态）按事项令牌表还原后再比，免得名字差异被当成改动。比对结果照常经本机端点令牌化后交回。
 */
function loadComparable(db: KernelDb, blobs: BlobStore, mid: string | undefined, id: string, restore?: Restore): { buf: Buffer; sha256: string } {
  if (!id.startsWith("artv_")) return loadDocument(db, blobs, mid, id);
  if (!mid) throw new DomainError("forbidden", "令牌未绑定事项", 403);
  const art = db.get<{ matter_id: string; kind: string; filename: string; sha256: string; storage_uri: string }>(
    `SELECT matter_id, kind, filename, sha256, storage_uri FROM artifact_versions WHERE artifact_version_id = ?`,
    [id],
  );
  if (!art || art.matter_id !== mid || !/\.docx$/i.test(art.filename) || !["revision_draft", "revision_clean", "agent_report"].includes(art.kind)) throw notFound("文档");
  const buf = blobs.read(art.storage_uri);
  if (sha256Hex(buf) !== art.sha256) throw new DomainError("hash_mismatch", "成果文件 hash 与登记不符（完整性校验失败）", 500);
  if (art.kind !== "agent_report" || !restore) return { buf, sha256: art.sha256 };
  const r = restoreArtifactBytes(art.filename, buf, restore);
  return { buf: r.changed ? r.bytes : buf, sha256: art.sha256 };
}

export function docxSanitize(db: KernelDb, blobs: BlobStore, mid: string | undefined, params: { document_version_id: string }) {
  const doc = loadDocument(db, blobs, mid, params.document_version_id);
  const result = sanitizeDocx(doc.buf);
  const stored = blobs.put(result.docx, doc.matter_id);
  return { ...stored, removed: result.removed, source_document_version_id: params.document_version_id };
}

/** 文书里一张表的上限（第 32 批）：A4 纵向版心放 10 列已很挤；更大的表用 xlsx.render_table 作附件。 */
const TABLE_MAX_COLUMNS = 10;
const TABLE_MAX_ROWS = 300;

/**
 * 节内表格逐张核对：列数、行数在上限内，每行格数与表头列数相同——不符时整份不写，逐条说明哪一节哪一行，
 * 由模型改正后重交（不悄悄补空格或截掉多出的格：错位的价款表比没有表更危险）。
 * 单元格接受文字、整数（数量、序号，转成文字）与空值（写空格）；格内换行改成空格（Word 表格里一格一段）。
 * 带小数的数字与真假值不收（复核 A-04）：380000.50 经 JSON 成了 380000.5，金额要按文书写法写成文字。
 */
function normalizeTables(sections: ReportSection[]): ReportSection[] {
  const problems: string[] = [];
  const cell = (v: unknown) => (v === null || v === undefined ? "" : String(v).replace(/\s*[\r\n]+\s*/g, " ").trim());
  const out = sections.map((s, si) => {
    const t = s.table;
    if (t === undefined) return s;
    const where = `第 ${si + 1} 节${s.heading ? `（${s.heading}）` : ""}的表格`;
    if (!Array.isArray(t.columns) || t.columns.length === 0) problems.push(`${where}没有表头列`);
    else if (t.columns.length > TABLE_MAX_COLUMNS) problems.push(`${where}有 ${t.columns.length} 列，超过 ${TABLE_MAX_COLUMNS} 列；拆成两张表，或改用 xlsx.render_table 作附件`);
    if (!Array.isArray(t.rows) || t.rows.length === 0) problems.push(`${where}没有数据行`);
    else if (t.rows.length > TABLE_MAX_ROWS) problems.push(`${where}有 ${t.rows.length} 行，超过 ${TABLE_MAX_ROWS} 行；改用 xlsx.render_table 作附件`);
    const n = Array.isArray(t.columns) ? t.columns.length : 0;
    (Array.isArray(t.rows) ? t.rows : []).forEach((r, ri) => {
      if (!Array.isArray(r)) problems.push(`${where}第 ${ri + 1} 行不是数组`);
      else if (r.some((v) => v !== null && v !== undefined && typeof v !== "string" && typeof v !== "number")) problems.push(`${where}第 ${ri + 1} 行有格子不是文字或数字`);
      else if (r.some((v) => typeof v === "number" && !Number.isInteger(v))) problems.push(`${where}第 ${ri + 1} 行有带小数的数字：金额按文书写法写成文字（如“380,000.50”）`);
      // 没有表头时上面已报，不再逐行重复（复核 A-05）
      else if (n > 0 && r.length !== n) problems.push(`${where}第 ${ri + 1} 行有 ${r.length} 格，表头是 ${n} 列`);
    });
    return { ...s, table: { columns: (t.columns ?? []).map(cell), rows: (Array.isArray(t.rows) ? t.rows : []).map((r) => (Array.isArray(r) ? r.map(cell) : [])) } };
  });
  if (problems.length > 0) throw new DomainError("validation", `表格有误，整份文书未生成，请改正后重新提交：${problems.slice(0, 8).join("；")}${problems.length > 8 ? `；另有 ${problems.length - 8} 处` : ""}`, 422, { problems });
  return out;
}

export function docxRenderReport(blobs: BlobStore, params: { title: string; sections: ReportSection[] }, matterId?: string) {
  if (!params.title || !Array.isArray(params.sections)) throw new DomainError("validation", "需要 title 与 sections", 422);
  const buf = createDocx(params.title, normalizeTables(params.sections));
  return blobs.put(buf, matterId ?? null);
}

/** 从文档提取全文（docx 段落拼接 / 纯文本直读）。 */
function extractText(db: KernelDb, blobs: BlobStore, mid: string | undefined, documentVersionId: string): { text: string; isDocx: boolean; doc: ReturnType<typeof loadDocument> } {
  const doc = loadDocument(db, blobs, mid, documentVersionId);
  const isDocx = doc.filename.toLowerCase().endsWith(".docx");
  if (isDocx) {
    const text = extractParagraphs(doc.buf).map((p) => p.text).join("\n");
    return { text, isDocx: true, doc };
  }
  return { text: doc.buf.toString("utf8"), isDocx: false, doc };
}

/**
 * CSV 公式中和（复核 S5-B19）：以 = + - @ 制表或回车开头的单元格前加单引号——Excel 打开时按文本处理，不计算公式
 * （公式可能在打开时发出外部请求）；纯数字（如 -5、+3.2）不受影响。按 CSV 规则识别带引号的字段。
 */
export function neutralizeCsvFormulas(csv: string): string {
  const risky = (s: string) => /^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(?:\.\d+)?$/.test(s.trim());
  let out = "";
  let i = 0;
  const n = csv.length;
  while (i < n) {
    if (csv[i] === '"') {
      let j = i + 1;
      while (j < n) {
        if (csv[j] === '"') {
          if (csv[j + 1] === '"') {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      const raw = csv.slice(i + 1, j);
      out += `"${risky(raw.replace(/""/g, '"')) ? "'" : ""}${raw}"`;
      i = Math.min(j + 1, n);
      // 引号之后到分隔符之前的字符（不规范写法）原样保留
      while (i < n && csv[i] !== "," && csv[i] !== "\n" && csv[i] !== "\r") out += csv[i++];
    } else {
      let j = i;
      while (j < n && csv[j] !== "," && csv[j] !== "\n" && csv[j] !== "\r") j++;
      const field = csv.slice(i, j);
      out += `${risky(field) ? "'" : ""}${field}`;
      i = j;
    }
    if (i < n) out += csv[i++];
  }
  return out;
}

export function redactApply(db: KernelDb, blobs: BlobStore, mid: string | undefined, params: { document_version_id: string }) {
  // v0 只处理 DOCX 与纯文本：其他格式（PDF、扫描件、旧版 Word/RTF 等）不按文本误读、也不原样输出原件（复核 S5-B04 遗留）
  const name = loadDocument(db, blobs, mid, params.document_version_id).filename.toLowerCase();
  if (!/\.(docx|txt|md|markdown|csv)$/.test(name)) {
    throw new DomainError("validation", "S6 脱敏（v0）只处理 DOCX 与纯文本（.txt/.md/.csv）；其他格式请先转换为 DOCX 或文本——不会原样输出原件", 422);
  }
  const { text: plain, isDocx, doc } = extractText(db, blobs, mid, params.document_version_id);
  // V14 第 39 批（T2-D 对外脱敏独立评分，命中否决）：原先在原件上只遮正文——修订删除痕迹里的乙方旧账号、页脚的手机号与姓名原样留下，
  // 修订与修订作者、修订模式也都还在。DOCX 先接受全部修订、清空批注、去掉修订作者与修订模式（sanitizeDocx），再在正文、页眉页脚、脚注里扫描与遮盖
  const cleaned = isDocx ? sanitizeDocx(doc.buf) : null;
  const base = cleaned ? cleaned.docx : doc.buf;
  const text = cleaned ? docxAllPartsText(base) : plain;
  const isCsv = name.endsWith(".csv");
  const scan = scanDirectIdentifiers(text);
  const revisions = cleaned ? { revisions_accepted: cleaned.removed.deletionsAccepted + cleaned.removed.insertionsAccepted, comments_removed: cleaned.removed.comments } : {};
  if (scan.findings.length === 0) {
    // 零命中同样产出“写出的”脱敏件（复核 S5-B04）：DOCX 经文书引擎重写——净化文档属性并去除打开时会外取的引用；CSV 中和公式；不把原件字节原样当成果
    return {
      ...blobs.put(isDocx ? scrubDocProps(base) : isCsv ? Buffer.from(neutralizeCsvFormulas(text), "utf8") : doc.buf, doc.matter_id),
      report: { counts: {}, findings: 0, notFound: [], coverage_notes: scan.coverage_notes, note: "未发现需遮盖的直接标识符", ...revisions },
      source_document_version_id: params.document_version_id,
    };
  }
  // 相同原文去重（同一遮盖值）
  const maskMap = new Map<string, string>();
  for (const f of scan.findings) {
    const original = text.slice(f.start, f.end);
    if (!maskMap.has(original)) maskMap.set(original, f.masked);
  }
  let outBuf: Buffer;
  let notFound: string[] = [];
  if (isDocx) {
    const r = maskDocxText(base, [...maskMap.entries()].map(([find, replace]) => ({ find, replace })));
    notFound = r.notFound;
    // 脱敏件同时净化文档属性（作者/公司/最后修改人），不得携带元数据泄露
    outBuf = scrubDocProps(r.docx);
  } else {
    let t = text;
    for (const [find, replace] of [...maskMap.entries()].sort((a, b) => b[0].length - a[0].length)) {
      t = t.split(find).join(replace);
    }
    outBuf = Buffer.from(isCsv ? neutralizeCsvFormulas(t) : t, "utf8");
  }
  const stored = blobs.put(outBuf, doc.matter_id);
  return {
    ...stored,
    report: {
      counts: scan.counts,
      findings: scan.findings.length,
      masked_values: maskMap.size,
      notFound,
      coverage_notes: scan.coverage_notes,
      ...revisions,
      parts_scanned: isDocx ? "正文（含表格）、页眉、页脚、脚注、尾注；修订已全部接受、批注已清空、修订作者与文档属性已清除" : "全文",
      residual_risks: ["自然人姓名、详细地址、图片与文本框内文字不在本机脱敏覆盖范围（见 coverage_notes），发出前请律师核对"],
    },
    source_document_version_id: params.document_version_id,
  };
}
