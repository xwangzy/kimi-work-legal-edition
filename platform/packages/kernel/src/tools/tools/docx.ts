/**
 * docx.* 与 redact.apply 工具（文书引擎由内核调用；§4.1 docx.propose_revisions/compare/render、redact.*）。
 * 产出为内容寻址字节（BlobStore）；artifact_versions 登记由内核工作流完成。
 * 挂载原件只读引用（storage_mode=mount）：读取时复算 hash，变化即需生成新文档版本。
 */
import { DomainError, notFound, sha256Hex } from "@zr-legal/domain";
import {
  applyRevisionsToDocx,
  compareDocx,
  createDocx,
  maskDocxText,
  sanitizeDocx,
  scrubDocProps,
  extractParagraphs,
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
) {
  const base = loadDocument(db, blobs, mid, params.baseline_document_version_id);
  const cur = loadDocument(db, blobs, mid, params.current_document_version_id);
  return { ...compareDocx(base.buf, cur.buf), baseline_sha256: base.sha256, current_sha256: cur.sha256 };
}

export function docxSanitize(db: KernelDb, blobs: BlobStore, mid: string | undefined, params: { document_version_id: string }) {
  const doc = loadDocument(db, blobs, mid, params.document_version_id);
  const result = sanitizeDocx(doc.buf);
  const stored = blobs.put(result.docx, doc.matter_id);
  return { ...stored, removed: result.removed, source_document_version_id: params.document_version_id };
}

export function docxRenderReport(blobs: BlobStore, params: { title: string; sections: { heading: string; paragraphs: string[] }[] }, matterId?: string) {
  if (!params.title || !Array.isArray(params.sections)) throw new DomainError("validation", "需要 title 与 sections", 422);
  const buf = createDocx(params.title, params.sections);
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
  const { text, isDocx, doc } = extractText(db, blobs, mid, params.document_version_id);
  const isCsv = name.endsWith(".csv");
  const scan = scanDirectIdentifiers(text);
  if (scan.findings.length === 0) {
    // 零命中同样产出“写出的”脱敏件（复核 S5-B04）：DOCX 经文书引擎重写——净化文档属性并去除打开时会外取的引用；CSV 中和公式；不把原件字节原样当成果
    return {
      ...blobs.put(isDocx ? scrubDocProps(doc.buf) : isCsv ? Buffer.from(neutralizeCsvFormulas(text), "utf8") : doc.buf, doc.matter_id),
      report: { counts: {}, findings: 0, notFound: [], coverage_notes: scan.coverage_notes, note: "未发现需遮盖的直接标识符" },
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
    const r = maskDocxText(doc.buf, [...maskMap.entries()].map(([find, replace]) => ({ find, replace })));
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
      residual_risks: ["姓名、详细地址、批注/属性、图片内文字不在 v0 覆盖范围（见 coverage_notes）"],
    },
    source_document_version_id: params.document_version_id,
  };
}
